'use strict';

// Fake host for testing the radar without the cheat.
//   node sim.js [ws://localhost:3000] [secret] [mapId]      (secret defaults to $RADAR_SECRET, mapId to br-override)
// On a map with "world" bounds it sends raw world coordinates (wx / wy, like the cheat would);
// on other maps it sends normalised x / y. The local player walks between the map's named locations.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const base = (process.argv[2] || 'ws://localhost:3000').replace(/\/+$/, '');
const secret = process.argv[3] || process.env.RADAR_SECRET || 'dev';
const mapId = process.argv[4] || 'br-override';
const url = base + '/?role=host&secret=' + encodeURIComponent(secret);

const maps = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'maps.json'), 'utf8')).maps;
const M = maps.find(m => m.id === mapId) || maps[0];
const world = M.world || null;
const SCALE_M = M.scale || 3000;
const toNorm = (wx, wy) => [(wx - world.x0) / (world.x1 - world.x0), (wy - world.y0) / (world.y1 - world.y0)];

const rnd = (a, b) => a + Math.random() * (b - a);
const yawOf = (vx, vy) => (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;
const perSec = metres => metres / SCALE_M;

// big, unmistakable things in the map art (world X / Y in cm), useful for eyeballing accuracy
const LANDMARKS = {
  'br-override': [
    ['Pac-Man Island', -20254, -73500],
    ['Blinky Island', -62990, 97256],
    ['Pinky Island', 42886, 88045],
    ["Freddy Fazbear's Pizzeria", -7168, -62007],
  ],
}[M.id] || [];

const stops = M.pois.map(p => [p.name, p.x, p.y]);
if (world) for (const [n, wx, wy] of LANDMARKS) { const [u, v] = toNorm(wx, wy); stops.push([n, u, v]); }
// nearest-neighbour order so the walk is not a zig-zag
const route = [stops.shift()];
while (stops.length) {
  const last = route[route.length - 1];
  stops.sort((a, b) => Math.hypot(a[1] - last[1], a[2] - last[2]) - Math.hypot(b[1] - last[1], b[2] - last[2]));
  route.push(stops.shift());
}

const me = { u: route[0][1], v: route[0][2], vx: 0, vy: -1, target: 1 % route.length, dwell: 2 };

const WEAPONS = ['Assault Rifle', 'Pump Shotgun', 'SMG', 'Sniper Rifle', 'Pistol', 'Pickaxe'];
const enemies = [];
for (let i = 0; i < 12; i++) {
  const a = rnd(0, Math.PI * 2), sp = perSec(rnd(10, 35));
  enemies.push({
    id: 100 + i, u: rnd(0.15, 0.85), v: rnd(0.15, 0.85), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
    team: 1 + (i % 6), hp: rnd(40, 100), shield: rnd(0, 100), name: 'enemy' + (i + 1),
    weapon: WEAPONS[i % WEAPONS.length], bot: i >= 10, npc: false,
  });
}
enemies.push({ id: 200, u: 0.4, v: 0.6, vx: perSec(6), vy: -perSec(4), team: 50, hp: 100, shield: 0, name: 'npc', weapon: '', bot: false, npc: true });
const mates = [
  { id: 10, name: 'mate1', du: perSec(25), dv: perSec(15), hp: 100, shield: 100 },
  { id: 11, name: 'mate2', du: -perSec(30), dv: perSec(40), hp: 80, shield: 25 },
  { id: 12, name: 'mate3', du: perSec(10), dv: -perSec(45), hp: 55, shield: 0 },
];

let t = 0;
let stopName = route[0][0];
function pos(id, u, v, extra) {
  const p = Object.assign({ id }, extra);
  if (world) { p.wx = world.x0 + u * (world.x1 - world.x0); p.wy = world.y0 + v * (world.y1 - world.y0); }
  else { p.x = u; p.y = v; }
  return p;
}

function frame(dt) {
  t += dt;
  // local player: walk to the next stop at ~90 m/s, stand there 3 s
  const [name, tu, tv] = route[me.target];
  const du = tu - me.u, dv = tv - me.v, dist = Math.hypot(du, dv);
  if (me.dwell > 0) {
    me.dwell -= dt;
    if (me.dwell <= 0) me.target = (me.target + 1) % route.length;
  } else if (dist < perSec(60) * dt + 1e-6) {
    me.u = tu; me.v = tv; me.dwell = 3; stopName = name;
  } else {
    const step = perSec(90) * dt;
    me.vx = du / dist; me.vy = dv / dist;
    me.u += me.vx * step; me.v += me.vy * step;
  }
  const meYaw = yawOf(me.vx, me.vy);

  const players = [pos(1, me.u, me.v, { isLocal: true, hp: 100, shield: 50, team: 0, yaw: meYaw, name: 'me', weapon: 'Assault Rifle' })];
  for (const m of mates) {
    players.push(pos(m.id, me.u + m.du, me.v + m.dv, { isLocal: false, hp: m.hp, shield: m.shield, team: 0, yaw: meYaw, name: m.name, weapon: 'SMG' }));
  }
  for (const e of enemies) {
    e.u += e.vx * dt; e.v += e.vy * dt;
    if (e.u < 0.05 || e.u > 0.95) e.vx = -e.vx;
    if (e.v < 0.05 || e.v > 0.95) e.vy = -e.vy;
    e.hp = Math.max(5, Math.min(100, e.hp + rnd(-8, 8) * dt));
    const p = pos(e.id, e.u, e.v, {
      isLocal: false, hp: Math.round(e.hp), shield: Math.round(e.shield), team: e.team, yaw: yawOf(e.vx, e.vy), name: e.name, weapon: e.weapon,
    });
    if (e.id === 103 && Math.floor(t / 6) % 2 === 1) p.down = true;
    if (e.bot) p.bot = true;
    if (e.npc) p.npc = true;
    players.push(p);
  }
  return { connected: true, map: M.id, renderDistance: 700, players };
}

function run() {
  const ws = new WebSocket(url);
  let timer = null;
  ws.on('open', () => {
    console.log('[sim] connected to', base, 'map', M.id, world ? '(world coordinates)' : '(normalised coordinates)');
    console.log('[sim] route:', route.map(r => r[0]).join(' -> '));
    let last = Date.now();
    let said = '';
    timer = setInterval(() => {
      const now = Date.now();
      ws.send(JSON.stringify(frame((now - last) / 1000)));
      last = now;
      if (me.dwell > 0 && said !== stopName) { said = stopName; console.log('[sim] standing at', stopName); }
      if (me.dwell <= 0) said = '';
    }, 50);
  });
  ws.on('close', code => {
    clearInterval(timer);
    console.log('[sim] closed', code, '- retrying in 2s');
    setTimeout(run, 2000);
  });
  ws.on('unexpected-response', (req, res) => console.log('[sim] refused:', res.statusCode));
  ws.on('error', err => console.log('[sim] error:', err.message));
}
run();
