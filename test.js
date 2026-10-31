'use strict';

// Starts the server on a spare port and checks the protocol end to end:  npm test

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3100 + Math.floor(Math.random() * 800);
const SECRET = 'test-secret';
const DISC = '{"connected":false,"players":[]}';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok    ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
}

const get = (p, method) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || 'GET' }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

function open(qs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/?' + qs);
    ws.q = [];
    ws.waiters = [];
    ws.on('message', d => {
      const m = d.toString();
      const w = ws.waiters.shift();
      if (w) w(m); else ws.q.push(m);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function next(ws, ms) {
  if (ws.q.length) return Promise.resolve(ws.q.shift());
  return new Promise((resolve, reject) => {
    const w = m => { clearTimeout(t); resolve(m); };
    const t = setTimeout(() => { ws.waiters = ws.waiters.filter(x => x !== w); reject(new Error('timeout')); }, ms || 1000);
    ws.waiters.push(w);
  });
}
const quiet = async (ws, ms) => { try { await next(ws, ms || 250); return false; } catch { return true; } };
const drain = ws => { ws.q.length = 0; };
const closeCode = ws => new Promise(res => { if (ws.readyState === 3) res(-1); else ws.once('close', c => res(c)); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function status(qs) {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/?' + qs);
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); res.resume(); });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', () => {});
  });
}

const frame = players => JSON.stringify({ connected: true, players });
const me = (x, extra) => Object.assign({ x, y: 0.5, isLocal: true, hp: 100, shield: 0, team: 0 }, extra);

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), RADAR_SECRET: SECRET }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    child.once('exit', c => reject(new Error('server exited ' + c)));
  });
  child.stdout.on('data', () => {});

  try {
    console.log('http');
    let r = await get('/');
    check('GET / serves the viewer', r.status === 200 && r.body.includes('DMA DISCONNECTED') && /text\/html/.test(r.headers['content-type']));
    r = await get('/health');
    check('GET /health', r.status === 200 && JSON.parse(r.body).ok === true && JSON.parse(r.body).host === false);
    r = await get('/', 'HEAD');
    check('HEAD / is fine', r.status === 200 && r.body === '');
    check('unknown path is 404', (await get('/nope')).status === 404);
    check('server.js is not served', (await get('/server.js')).status === 404);
    check('path traversal is 404', (await get('/..%2fserver.js')).status === 404);
    check('/map is 204 when there is no map image', (await get('/map')).status === 204);
    check('map files are not served by name', (await get('/map.png')).status === 404);
    const mapFile = path.join(__dirname, 'public', 'map.png');
    const hadMap = fs.existsSync(mapFile);
    if (!hadMap) {
      fs.writeFileSync(mapFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
      try {
        r = await get('/map');
        check('/map serves public/map.png when present', r.status === 200 && r.headers['content-type'] === 'image/png');
      } finally { fs.unlinkSync(mapFile); }
    }
    check('POST is 405', (await get('/', 'POST')).status === 405);

    console.log('websocket access');
    check('host without secret -> 401', (await status('role=host')) === 401);
    check('host with wrong secret -> 401', (await status('role=host&secret=nope')) === 401);
    check('no role -> 400', (await status('')) === 400);

    console.log('viewer + host');
    const v1 = await open('role=viewer');
    check('viewer gets disconnected state first', (await next(v1)) === DISC);

    const h1 = await open('role=host&secret=' + SECRET);
    h1.send(frame([
      me(0.123456789, { hp: 150, shield: -5, id: 7, yaw: 450.123, name: '<b>me</b>\n', evil: 'x' }),
      { x: 'no', y: 1 },
      null,
      { x: 0.2, y: 0.3, hp: 75, shield: 0, team: 1 },
    ]).replace('}', ',"extra":1}'));
    const got = JSON.parse(await next(v1));
    check('viewer gets the frame', got.connected === true && got.players.length === 2, JSON.stringify(got));
    const p0 = got.players[0], p1 = got.players[1];
    check('x rounded, hp/shield clamped', p0.x === 0.12346 && p0.hp === 100 && p0.shield === 0, JSON.stringify(p0));
    check('id, yaw (wrapped) and name (stripped) kept', p0.id === '7' && p0.yaw === 90.1 && p0.name === '<b>me</b>', JSON.stringify(p0));
    check('unknown fields dropped', p0.evil === undefined && got.extra === undefined);
    check('second player intact', p1.x === 0.2 && p1.team === 1 && p1.isLocal === false && p1.id === undefined, JSON.stringify(p1));

    const v2 = await open('role=viewer');
    const cached = await next(v2);
    check('late viewer gets the last frame at once', JSON.parse(cached).players.length === 2);

    h1.send('not json');
    h1.send('{"foo":1}');
    check('garbage is not forwarded', await quiet(v1));
    h1.send(frame([me(0.4)]));
    check('host still works after garbage', JSON.parse(await next(v1)).players[0].x === 0.4);

    drain(v1);
    for (let i = 0; i < 60; i++) h1.send(frame([me(i / 100)]));
    await sleep(400);
    const burst = v1.q.map(m => JSON.parse(m).players[0].x);
    check('burst is throttled', burst.length >= 1 && burst.length < 60, burst.length);
    check('burst ends on the newest frame', burst[burst.length - 1] === 0.59, burst.join(','));

    drain(v1);
    h1.send(frame(Array.from({ length: 250 }, (_, i) => ({ x: 0.5, y: 0.5, hp: 1, shield: 0, team: 1, id: i }))));
    check('more than 200 players is capped', JSON.parse(await next(v1)).players.length === 200);

    console.log('host changes');
    drain(v1);
    const h1closed = closeCode(h1);
    const h2 = await open('role=host&secret=' + SECRET);
    check('new host replaces the old (4000)', (await h1closed) === 4000);
    check('viewers are not told "disconnected" on a swap', await quiet(v1));

    const h2closed = closeCode(h2);
    h2.send('x'.repeat(100 * 1024));
    check('oversized message closes the host (1009)', (await h2closed) === 1009);
    check('viewer told disconnected when host drops', (await next(v1)) === DISC);

    const h3 = await open('role=host&secret=' + SECRET);
    h3.send(frame([me(0.9)]));
    drain(v2);
    check('viewer receives from a new host', JSON.parse(await next(v1)).players[0].x === 0.9);
    h3.send('{"connected":false}');
    check('host can say connected:false itself', (await next(v1)) === DISC);
    h3.close();
    await sleep(100);

    console.log('abuse');
    let last = 0;
    for (let i = 0; i < 14; i++) last = await status('role=host&secret=bad' + i);
    check('repeated wrong secrets -> 429', last === 429, last);
    const h4 = await open('role=host&secret=' + SECRET);
    check('right secret still gets in while limited', h4.readyState === 1);
    h4.close();
    v1.close();
    v2.close();
  } finally {
    child.kill();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
