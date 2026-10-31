'use strict';

// Starts the server on a spare port and checks the protocol end to end:  npm test

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
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

const get = (p, method, port, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: port || PORT, path: p, method: method || 'GET', headers: headers || {} }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

function open(qs, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + (port || PORT) + '/?' + qs);
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

async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), RADAR_SECRET: SECRET }, env),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    child.once('exit', c => reject(new Error('server exited ' + c)));
  });
  child.stdout.on('data', () => {});
  return child;
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const child = await startServer(PORT);

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
    r = await get('/maps.json');
    check('/maps.json is valid JSON with a maps list', r.status === 200 && Array.isArray(JSON.parse(r.body).maps));
    check('/maps/ rejects other file types', (await get('/maps/server.js')).status === 404);
    check('/maps/ rejects traversal', (await get('/maps/..%2fserver.js')).status === 404 && (await get('/maps/%2e%2e%2fserver.js')).status === 404);
    check('/maps/ 404 for a missing image', (await get('/maps/nothing.png')).status === 404);

    const realList = path.join(__dirname, 'public', 'maps.json');
    if (fs.existsSync(realList)) {
      const served = JSON.parse((await get('/maps.json')).body).maps;
      const want = JSON.parse(fs.readFileSync(realList, 'utf8')).maps;
      check('/maps.json serves public/maps.json', served.length > 0 && served.length === want.length, served.length + ' vs ' + want.length);
      const bad = [];
      for (const m of served) {
        const urls = [];
        if (m.tiles) {
          for (const k of [0, m.tiles.sizes.length - 1]) {
            const rows = m.tiles.mask[k];
            for (let y = 0; y < rows.length && urls.length < 4; y++) {
              const x = rows[y].indexOf('1');
              if (x >= 0) { urls.push(m.tiles.base + '/' + k + '/' + x + '_' + y + '.webp'); break; }
            }
          }
          if (urls.length < 2) bad.push(m.id + ' (no tiles)');
        } else {
          urls.push(m.image);
        }
        for (const u of urls) {
          const x = await get(u);
          if (x.status !== 200 || !/^image\//.test(x.headers['content-type'])) bad.push(m.id + ' ' + u);
        }
      }
      check('every map in maps.json has its images / tiles served', bad.length === 0, bad.join(', '));

      const tiled = served.find(m => m.tiles);
      if (tiled) {
        const rows = tiled.tiles.mask[0];
        const ty = rows.findIndex(r => r.indexOf('1') >= 0);
        const url = tiled.tiles.base + '/0/' + rows[ty].indexOf('1') + '_' + ty + '.webp';
        const first = await get(url);
        check('tiles carry an ETag and a cache lifetime', !!first.headers.etag && /max-age=\d+/.test(first.headers['cache-control'] || ''));
        const again = await get(url, 'GET', PORT, { 'If-None-Match': first.headers.etag });
        check('a matching If-None-Match gets a 304', again.status === 304 && again.body === '');
        check('tile paths cannot escape the tiles folder', (await get('/tiles/../server.js')).status === 404 &&
          (await get('/tiles/..%2f..%2fserver.js')).status === 404 && (await get('/tiles/br-override/9/999_999.webp')).status === 404);
      }
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-pub-'));
    const PORT2 = PORT + 1;
    let child2 = null;
    try {
      fs.copyFileSync(path.join(__dirname, 'public', 'index.html'), path.join(tmp, 'index.html'));
      fs.mkdirSync(path.join(tmp, 'maps'));
      fs.writeFileSync(path.join(tmp, 'maps', 'zz-test-map.png'), PNG_1PX);
      fs.writeFileSync(path.join(tmp, 'maps', 'notes.txt'), 'x');
      child2 = await startServer(PORT2, { RADAR_PUBLIC: tmp });
      const listed = JSON.parse((await get('/maps.json', 'GET', PORT2)).body).maps;
      check('with no maps.json the maps folder is listed', listed.length === 1 && listed[0].id === 'zz-test-map' &&
        listed[0].image === '/maps/zz-test-map.png' && listed[0].name === 'zz test map', JSON.stringify(listed));
      r = await get('/maps/zz-test-map.png', 'GET', PORT2);
      check('and the image is served as image/png', r.status === 200 && r.headers['content-type'] === 'image/png');
      check('non-image files in maps/ are not served', (await get('/maps/notes.txt', 'GET', PORT2)).status === 404);

      // world coordinates: a made-up map whose edges are X 0..1000 and Y -500..500
      fs.writeFileSync(path.join(tmp, 'maps.json'), JSON.stringify({ maps: [
        { id: 'tmap', name: 'Test Map', image: '/maps/zz-test-map.png', scale: 1000, world: { x0: 0, x1: 1000, y0: -500, y1: 500 }, pois: [] },
        { id: 'noworld', name: 'No World', image: '/maps/zz-test-map.png', pois: [] },
      ] }));
      await sleep(2300); // the server re-reads maps.json every couple of seconds
      const hv = await open('role=viewer', PORT2);
      await next(hv);
      const hh = await open('role=host&secret=' + SECRET, PORT2);
      const mk = extra => Object.assign({ isLocal: false, hp: 50, shield: 0, team: 1 }, extra);
      hh.send(JSON.stringify({ connected: true, map: 'tmap', players: [
        mk({ wx: 250, wy: 0 }),
        mk({ wx: 0, wy: -500 }),
        mk({ x: 0.9, y: 0.8, wx: 250, wy: 0 }),
        mk({ wx: 5000, wy: 0 }),
        mk({ wx: 1000, wy: 500 }),
      ] }));
      const wf = JSON.parse(await next(hv));
      const near = (a, b) => Math.abs(a - b) < 1e-9;
      check('world coordinates become map positions', wf.players.length === 5 && near(wf.players[0].x, 0.25) && near(wf.players[0].y, 0.5) &&
        near(wf.players[1].x, 0) && near(wf.players[1].y, 0) && near(wf.players[4].x, 1) && near(wf.players[4].y, 1), JSON.stringify(wf.players));
      check('x / y win when both are sent', near(wf.players[2].x, 0.9) && near(wf.players[2].y, 0.8));
      check('far outside the map is clamped, not dropped', wf.players[3].x === 2);
      check('wx / wy are not forwarded', wf.players.every(p => p.wx === undefined && p.wy === undefined));
      hh.send(JSON.stringify({ connected: true, map: 'noworld', players: [mk({ wx: 1, wy: 1 }), mk({ x: 0.5, y: 0.5 })] }));
      check('world coordinates on a map without bounds are dropped, x / y kept', JSON.parse(await next(hv)).players.length === 1);
      hh.send(JSON.stringify({ connected: true, players: [mk({ wx: 1, wy: 1 })] }));
      check('world coordinates with no map are dropped', JSON.parse(await next(hv)).players.length === 0);
      hh.send(JSON.stringify({ connected: true, map: 'Test Map', players: [mk({ wx: 500, wy: 0 })] }));
      check('the map can be named by its display name', near(JSON.parse(await next(hv)).players[0].x, 0.5));
      hh.close();
      hv.close();
    } finally {
      if (child2) child2.kill();
      fs.rmSync(tmp, { recursive: true, force: true });
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
    h1.send(JSON.stringify({
      connected: true, map: 'Main\tIsland', scale: 12000, renderDistance: -5, junk: 1,
      players: [
        me(0.5, { weapon: 'Assault Rifle\n', bot: true, npc: 'yes' }),
        { x: 0.1, y: 0.1, team: 2, npc: true, down: true },
      ],
    }));
    const extra = JSON.parse(await next(v1));
    check('top-level map / scale kept, bad renderDistance dropped',
      extra.map === 'MainIsland' && extra.scale === 12000 && extra.renderDistance === undefined && extra.junk === undefined, JSON.stringify(extra));
    check('weapon, bot, npc, down handled',
      extra.players[0].weapon === 'Assault Rifle' && extra.players[0].bot === true && extra.players[0].npc === undefined &&
      extra.players[1].npc === true && extra.players[1].down === true, JSON.stringify(extra.players));
    drain(v1);

    h1.send(JSON.stringify({
      connected: true,
      extra: 1,
      players: [
        me(0.123456789, { hp: 150, shield: -5, id: 7, yaw: 450.123, name: '<b>me</b>\n', evil: 'x' }),
        { x: 'no', y: 1 },
        null,
        { x: 0.2, y: 0.3, hp: 75, shield: 0, team: 1 },
      ],
    }));
    const got = JSON.parse(await next(v1));
    check('viewer gets the frame', got.connected === true && got.players.length === 2, JSON.stringify(got));
    const p0 = got.players[0], p1 = got.players[1];
    check('x rounded, hp/shield clamped', p0.x === 0.123457 && p0.hp === 100 && p0.shield === 0, JSON.stringify(p0));
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
