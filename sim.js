'use strict';

// Fake host for testing the radar without the cheat.
//   node sim.js [ws://localhost:3000] [secret]      (secret defaults to $RADAR_SECRET)

const WebSocket = require('ws');

const base = (process.argv[2] || 'ws://localhost:3000').replace(/\/+$/, '');
const secret = process.argv[3] || process.env.RADAR_SECRET || 'dev';
const url = base + '/?role=host&secret=' + encodeURIComponent(secret);

const rnd = (a, b) => a + Math.random() * (b - a);
const yawOf = (vx, vy) => (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;

const enemies = [];
for (let i = 0; i < 12; i++) {
  const a = rnd(0, Math.PI * 2);
  enemies.push({
    id: 100 + i, x: rnd(0.1, 0.9), y: rnd(0.1, 0.9),
    vx: Math.cos(a) * rnd(0.01, 0.03), vy: Math.sin(a) * rnd(0.01, 0.03),
    team: 1 + (i % 6), hp: rnd(40, 100), shield: rnd(0, 100), name: 'enemy' + (i + 1),
  });
}
const mates = [
  { id: 10, name: 'mate1', ox: 0.03, oy: 0.02, hp: 100, shield: 100 },
  { id: 11, name: 'mate2', ox: -0.03, oy: 0.035, hp: 80, shield: 25 },
  { id: 12, name: 'mate3', ox: 0.01, oy: -0.04, hp: 55, shield: 0 },
];

let t = 0;
function frame(dt) {
  t += dt;
  const ang = t * 0.12;
  const me = { x: 0.5 + Math.cos(ang) * 0.28, y: 0.5 + Math.sin(ang) * 0.28 };
  const meYaw = yawOf(-Math.sin(ang), Math.cos(ang));

  const players = [{
    id: 1, x: me.x, y: me.y, isLocal: true, hp: 100, shield: 50, team: 0, yaw: meYaw, name: 'me',
  }];
  for (const m of mates) {
    players.push({
      id: m.id, x: me.x + m.ox, y: me.y + m.oy, isLocal: false, hp: m.hp, shield: m.shield,
      team: 0, yaw: meYaw, name: m.name,
    });
  }
  for (const e of enemies) {
    e.x += e.vx * dt; e.y += e.vy * dt;
    if (e.x < 0.04 || e.x > 0.96) e.vx = -e.vx;
    if (e.y < 0.04 || e.y > 0.96) e.vy = -e.vy;
    e.hp = Math.max(5, Math.min(100, e.hp + rnd(-8, 8) * dt));
    const down = e.id === 103 && Math.floor(t / 6) % 2 === 1;
    const p = {
      id: e.id, x: e.x, y: e.y, isLocal: false, hp: Math.round(e.hp), shield: Math.round(e.shield),
      team: e.team, yaw: yawOf(e.vx, e.vy), name: e.name,
    };
    if (down) p.down = true;
    players.push(p);
  }
  return { connected: true, players };
}

function run() {
  const ws = new WebSocket(url);
  let timer = null;
  ws.on('open', () => {
    console.log('[sim] connected to', base);
    let last = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      ws.send(JSON.stringify(frame((now - last) / 1000)));
      last = now;
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
