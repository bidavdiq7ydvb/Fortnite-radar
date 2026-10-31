'use strict';

/*
 * Frame the host (the cheat) sends, one JSON text message per tick:
 *
 *   { "connected": true,
 *     "players": [ { "x": 0.45, "y": 0.62, "isLocal": true, "hp": 100, "shield": 50, "team": 0 } ] }
 *
 *   x / y   normalised 0..1, top-left origin
 *
 * Optional per-player fields (the viewer uses them when they are there):
 *   id      stable number or string per player -> exact tracking between frames
 *   yaw     degrees, 0 = up / north, clockwise -> facing wedge
 *   name    string, up to 24 characters
 *   down    true while knocked
 *
 * Every frame is validated and rebuilt before it is forwarded, so viewers only
 * ever receive the fields above.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.RADAR_SECRET || '';
const MAX_VIEWERS = Number(process.env.MAX_VIEWERS) || 200;

const MAX_PLAYERS = 200;
const MAX_PAYLOAD = 64 * 1024;
const MIN_GAP_MS = 25;            // at most ~40 frames a second reach the viewers
const MAX_BUFFERED = 256 * 1024;  // a viewer this far behind skips frames instead of piling up
const PING_EVERY_MS = 15000;
const HOST_SILENT_MS = 60000;
const VIEWER_SILENT_MS = 45000;
const BAD_SECRET_LIMIT = 10;      // wrong secrets per minute per address
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!SECRET) {
  console.error('[radar] RADAR_SECRET is not set: host connections will be REFUSED until it is.');
}

let INDEX;
try {
  INDEX = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
} catch (err) {
  console.error('[radar] cannot read public/index.html:', err.message);
  process.exit(1);
}

const MAP_TYPES = { 'map.png': 'image/png', 'map.jpg': 'image/jpeg', 'map.webp': 'image/webp' };
const DISC = JSON.stringify({ connected: false, players: [] });

// ── secret check ────────────────────────────────────────────────────────────
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const SECRET_DIGEST = digest(SECRET);
const secretOk = given => SECRET !== '' && crypto.timingSafeEqual(digest(given), SECRET_DIGEST);

const badSecrets = new Map(); // address -> { n, since }
function clientAddress(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',');
  return fwd[fwd.length - 1].trim() || req.socket.remoteAddress || '?';
}
function noteBadSecret(addr) {
  const now = Date.now();
  let e = badSecrets.get(addr);
  if (!e || now - e.since > 60000) e = { n: 0, since: now };
  e.n++;
  badSecrets.set(addr, e);
  return e.n > BAD_SECRET_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [a, e] of badSecrets) if (now - e.since > 60000) badSecrets.delete(a);
}, 60000).unref();

// ── frame validation ────────────────────────────────────────────────────────
const num = (v, lo, hi, d) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const r5 = v => Math.round(v * 1e5) / 1e5;

function cleanFrame(text) {
  let f;
  try { f = JSON.parse(text); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  if (f.connected === false) return DISC;
  if (!Array.isArray(f.players)) return null;

  const players = [];
  for (const p of f.players) {
    if (players.length >= MAX_PLAYERS) break;
    if (!p || typeof p !== 'object') continue;
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

    const o = {
      x: r5(p.x),
      y: r5(p.y),
      isLocal: p.isLocal === true,
      hp: Math.round(num(p.hp, 0, 100, 0)),
      shield: Math.round(num(p.shield, 0, 100, 0)),
      team: Math.trunc(num(p.team, -1e6, 1e6, -1)),
    };
    if ((typeof p.id === 'number' && Number.isFinite(p.id)) || typeof p.id === 'string') {
      o.id = String(p.id).slice(0, 32);
    }
    if (typeof p.yaw === 'number' && Number.isFinite(p.yaw)) {
      o.yaw = Math.round((((p.yaw % 360) + 360) % 360) * 10) / 10;
    }
    if (typeof p.name === 'string') {
      const name = p.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24);
      if (name) o.name = name;
    }
    if (p.down === true) o.down = true;
    players.push(o);
  }
  return JSON.stringify({ connected: true, players });
}

// ── HTTP ────────────────────────────────────────────────────────────────────
let host = null;
const viewers = new Set();

const server = http.createServer((req, res) => {
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const send = (code, headers, body) => { res.writeHead(code, Object.assign({}, base, headers)); res.end(body); };

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { Allow: 'GET, HEAD' });

  const pathname = String(req.url || '/').split('?')[0];

  if (pathname === '/' || pathname === '/index.html') {
    return send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self' ws: wss:",
    }, INDEX);
  }

  if (pathname === '/health') {
    return send(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, host: !!host, viewers: viewers.size }));
  }

  if (pathname === '/map') {
    const names = Object.keys(MAP_TYPES);
    const tryNext = i => {
      if (i >= names.length) return send(204, { 'Cache-Control': 'no-cache' });
      fs.readFile(path.join(PUBLIC_DIR, names[i]), (err, data) => {
        if (err) return tryNext(i + 1);
        send(200, { 'Content-Type': MAP_TYPES[names[i]], 'Cache-Control': 'no-cache' }, data);
      });
    };
    return tryNext(0);
  }

  send(404);
});

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  const reject = (code, text) => {
    socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  };

  let params;
  try { params = new URL(req.url, 'http://x').searchParams; } catch { return reject(400, 'Bad Request'); }
  const role = params.get('role');

  if (role === 'host') {
    if (!secretOk(params.get('secret') || '')) {
      const limited = noteBadSecret(clientAddress(req));
      console.log('[radar] host rejected: bad secret');
      return limited ? reject(429, 'Too Many Requests') : reject(401, 'Unauthorized');
    }
  } else if (role === 'viewer') {
    if (viewers.size >= MAX_VIEWERS) return reject(503, 'Service Unavailable');
  } else {
    return reject(400, 'Bad Request');
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.role = role;
    wss.emit('connection', ws, req);
  });
});

// ── broadcast (leading edge + trailing flush, max ~40 Hz) ───────────────────
let lastFrame = DISC;
let lastSentAt = 0;
let pending = null;
let flushTimer = null;

function broadcast(msg) {
  for (const v of viewers) {
    if (v.readyState === 1 && v.bufferedAmount < MAX_BUFFERED) v.send(msg);
  }
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (pending === null) return;
  const msg = pending;
  pending = null;
  lastSentAt = Date.now();
  broadcast(msg);
}

function onHostFrame(msg) {
  lastFrame = msg;
  pending = msg;
  const wait = MIN_GAP_MS - (Date.now() - lastSentAt);
  if (wait <= 0) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, wait);
}

function attachHost(ws) {
  if (host) host.close(4000, 'replaced by new host');
  host = ws;
  lastFrame = DISC;
  console.log('[radar] host connected  viewers:', viewers.size);

  ws.on('message', data => {
    ws.lastSeen = Date.now();
    const msg = cleanFrame(data.toString('utf8'));
    if (msg !== null) onHostFrame(msg);
  });

  ws.on('close', () => {
    if (host !== ws) return;
    host = null;
    clearTimeout(flushTimer);
    flushTimer = null;
    pending = null;
    lastFrame = DISC;
    lastSentAt = 0;
    console.log('[radar] host disconnected');
    broadcast(DISC);
  });
}

function attachViewer(ws) {
  viewers.add(ws);
  console.log('[radar] viewer connected  total:', viewers.size);
  ws.send(host ? lastFrame : DISC);
  ws.on('close', () => {
    viewers.delete(ws);
    console.log('[radar] viewer left  total:', viewers.size);
  });
}

wss.on('connection', ws => {
  ws.lastSeen = Date.now();
  ws.on('pong', () => { ws.lastSeen = Date.now(); });
  ws.on('error', () => {});
  if (ws.role === 'host') attachHost(ws);
  else attachViewer(ws);
});

// ping everyone so idle proxies keep the sockets, and drop the ones that went quiet
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const limit = ws.role === 'host' ? HOST_SILENT_MS : VIEWER_SILENT_MS;
    if (now - ws.lastSeen > limit) { ws.terminate(); continue; }
    if (ws.readyState === 1) ws.ping();
  }
}, PING_EVERY_MS).unref();

function shutdown() {
  console.log('[radar] shutting down');
  server.close();
  for (const ws of wss.clients) ws.close(1001, 'server restarting');
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log('[radar] listening on port', PORT));
