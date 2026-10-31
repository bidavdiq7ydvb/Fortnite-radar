'use strict';

/*
 * Frame the host (the cheat) sends, one JSON text message per tick:
 *
 *   { "connected": true,
 *     "players": [ { "x": 0.45, "y": 0.62, "isLocal": true, "hp": 100, "shield": 50, "team": 0 } ] }
 *
 *   x / y   normalised 0..1, top-left origin
 *
 * Instead of x / y a player may carry raw game coordinates:
 *   wx / wy   Unreal world X / Y in cm, exactly as read from the actor. Needs the frame's
 *             "map" (an id or name from maps.json) to have "world" bounds; the server then does
 *             the conversion, so the cheat needs no map maths. If x / y are also sent they win.
 * Top level "level": the game's own world name. A map entry in maps.json that lists it in "levels": ["Name"]
 * is used for the frame (and viewers get its id as "map"); otherwise the frame's "map" is used.
 *   wyaw      the heading in the game's own degrees (0 = +X, 90 = +Y); the server turns it into the
 *             map's "yaw" on the same axes as the position.
 *
 * Optional per-player fields (the viewer uses them when they are there):
 *   id      stable number or string per player -> exact tracking between frames
 *   yaw     degrees, 0 = up / north, clockwise -> facing wedge
 *   name    string, up to 24 characters
 *   weapon  string, up to 32 characters (what they hold)
 *   down    true while knocked
 *   bot     true for AI bots        npc   true for NPCs
 * Optional top-level fields:
 *   map             map name / id; the "Automatic" map choice matches it
 *   scale           metres across the full map width -> distances
 *   renderDistance  metres -> the circle around the tracked player
 *
 * Maps: public/maps.json lists them. Detailed maps are tile pyramids in public/tiles/<id>/<level>/<x>_<y>.webp
 * ("tiles" entry, the viewer loads only what is on screen). A plain image in public/maps/ (png, jpg, webp)
 * also works and is listed automatically when there is no maps.json. An entry looks like:
 *   { "id": "main", "name": "Main Island", "image": "/maps/main.webp",
 *     "scale": 3000,                     (metres across the image)
 *     "world": { "x0": -141583, "x1": 158339, "y0": -149559, "y1": 150364 },   (world X / Y at the image edges)
 *     "pois": [ { "name": "Somewhere", "x": 0.4, "y": 0.3 } ] }
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
const PUBLIC_DIR = process.env.RADAR_PUBLIC || path.join(__dirname, 'public');

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

const MAP_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAPS_DIR = path.join(PUBLIC_DIR, 'maps');
const TILES_DIR = path.join(PUBLIC_DIR, 'tiles');
const TILE_PATH = /^\/tiles\/([a-z0-9-]{1,48})\/(\d{1,2})\/(\d{1,3})_(\d{1,3})\.webp$/;
const IMAGE_NAME = /^[A-Za-z0-9._ -]+\.(png|jpe?g|webp)$/i;
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
const r6 = v => Math.round(v * 1e6) / 1e6;
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n) : '');
const posNum = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0);

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const AXES = ['x', 'y', '-x', '-y'];
const pick = (src, a, b) => (src === 'x' ? a : src === 'y' ? b : src === '-x' ? -a : -b);   // a = the game's X, b = its Y
const inView = v => Math.min(2, Math.max(-1, v));

let mapsCache = { at: 0, mtime: -1, list: [], rotations: [] };
function getMaps() {
  const now = Date.now();
  if (now - mapsCache.at < 2000) return mapsCache.list;
  mapsCache.at = now;
  try {
    const m = fs.statSync(path.join(PUBLIC_DIR, 'maps.json')).mtimeMs;
    if (m !== mapsCache.mtime) { mapsCache.mtime = m; const l = listMaps(); mapsCache.list = l.maps; mapsCache.rotations = l.rotations || []; }
  } catch {
    mapsCache.mtime = -1;
    const l = listMaps();
    mapsCache.list = l.maps;
    mapsCache.rotations = l.rotations || [];
  }
  return mapsCache.list;
}

// A rotation: maps that take turns on a fixed clock (Reload: 20-minute slots, three maps). { "id", "order": [map ids], "periodMin", "anchor": ISO time at which order[0] starts, "maxPlayers": it applies to
// matches with at most that many players, "playlists": [ids] it applies to those playlists too }. The map of a match is the one of the slot its world appeared in (matchStart); a match that began
// in one slot keeps its map when the next slot starts.
function pickByRotation(matchPlayers, playlist, matchStartUnix) {
  getMaps();
  for (const r of mapsCache.rotations) {
    if (!r || !Array.isArray(r.order) || !r.order.length || !isNum(r.periodMin) || r.periodMin <= 0) continue;
    const anchor = Date.parse(r.anchor);
    if (!Number.isFinite(anchor)) continue;
    const byPlaylist = isNum(playlist) && Array.isArray(r.playlists) && r.playlists.includes(playlist);
    const bySize = isNum(r.maxPlayers) && matchPlayers > 0 && matchPlayers <= r.maxPlayers;
    if (!byPlaylist && !bySize) continue;
    const now = Date.now();
    let at = isNum(matchStartUnix) && matchStartUnix > 0 ? matchStartUnix * 1000 : now;
    if (Math.abs(at - now) > 12 * 3600 * 1000) at = now;                          // a clock that is hours off is not to be trusted
    const period = r.periodMin * 60000;
    const n = r.order.length;
    const slot = Math.floor((at - anchor) / period);
    const id = r.order[((slot % n) + n) % n];
    const map = getMaps().find(m => m && m.id === id);
    if (map) return { map, rotation: r.id || '' };
  }
  return null;
}
function findMap(name) {
  const w = String(name || '').toLowerCase();
  if (!w) return null;
  return getMaps().find(m => m && (String(m.id || '').toLowerCase() === w || String(m.name || '').toLowerCase() === w)) || null;
}

function findMapByLevel(level) {
  const w = String(level || '').toLowerCase();
  if (!w) return null;
  return getMaps().find(m => m && Array.isArray(m.levels) && m.levels.some(l => typeof l === 'string' && l.toLowerCase() === w)) || null;
}

const seenLevels = new Set();
function noteLevel(level, map) {
  if (!level || seenLevels.has(level) || seenLevels.size > 50) return;
  seenLevels.add(level);
  console.log('[radar] the game reports level "' + level + '" -> ' + (map ? 'map ' + map.id : 'no map lists it (the frame\'s own "map" is used)'));
}

const seenMatches = new Set();
function noteMatch(playlist, players, rot) {
  const key = playlist + '/' + (players >= 70 ? 'big' : players > 0 ? 'small' : '-') + '/' + (rot ? rot.map.id : '');
  if (seenMatches.has(key) || seenMatches.size > 50) return;
  seenMatches.add(key);
  console.log('[radar] playlist ' + playlist + ', ' + players + ' players in the match -> ' + (rot ? 'rotation "' + rot.rotation + '": map ' + rot.map.id : 'no rotation applies (the frame\'s own "map" is used)'));
}

let lastWarnAt = 0;
function warnUnmapped(mapName, why) {
  const now = Date.now();
  if (now - lastWarnAt < 10000) return;
  lastWarnAt = now;
  console.log('[radar] dropping players sent as world coordinates: ' + why + (mapName ? ' (map "' + mapName + '")' : ''));
}

function cleanFrame(text) {
  let f;
  try { f = JSON.parse(text); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  if (f.connected === false) return DISC;
  if (!Array.isArray(f.players)) return null;

  // The cheat names the game's level (its own world name); a map in maps.json that lists it under "levels" is THE map for this frame. "map" is only the fallback for a level nobody listed.
  const level = str(f.level, 64);
  const byLevel = level ? findMapByLevel(level) : null;
  noteLevel(level, byLevel);
  const playlist = isNum(f.playlist) ? Math.trunc(f.playlist) : -1;
  const matchPlayers = isNum(f.matchPlayers) ? Math.max(0, Math.min(1000, Math.trunc(f.matchPlayers))) : 0;
  const matchStart = isNum(f.matchStart) ? Math.trunc(f.matchStart) : 0;
  const rot = byLevel ? null : pickByRotation(matchPlayers, playlist, matchStart);
  noteMatch(playlist, matchPlayers, rot);
  const mapName = str(f.map, 40);
  const wm = byLevel || (rot && rot.map) || (mapName ? findMap(mapName) : null);
  const w = wm && wm.world;
  const world = w && isNum(w.x0) && isNum(w.x1) && isNum(w.y0) && isNum(w.y1) && w.x1 !== w.x0 && w.y1 !== w.y0 ? w : null;
  // which game axis runs along the image's horizontal (u) and vertical (v) direction: "x", "y", "-x" or "-y" (default u = x, v = y). x0 / x1 are the values of u's axis at the image's left / right edge,
  // y0 / y1 the values of v's axis at its top / bottom edge. A map that comes out rotated or mirrored is fixed here, in maps.json, with no change to the cheat.
  const uSrc = world && AXES.includes(world.u) ? world.u : 'x';
  const vSrc = world && AXES.includes(world.v) ? world.v : 'y';

  const players = [];
  for (const p of f.players) {
    if (players.length >= MAX_PLAYERS) break;
    if (!p || typeof p !== 'object') continue;

    let x, y, fromWorld = false;
    if (isNum(p.x) && isNum(p.y)) {
      x = p.x; y = p.y;
    } else if (isNum(p.wx) && isNum(p.wy)) {
      if (!world) { warnUnmapped(mapName, mapName ? 'that map has no "world" bounds' : 'the frame has no "map"'); continue; }
      x = (pick(uSrc, p.wx, p.wy) - world.x0) / (world.x1 - world.x0);
      y = (pick(vSrc, p.wx, p.wy) - world.y0) / (world.y1 - world.y0);
      fromWorld = true;
    } else {
      continue;
    }

    const o = {
      x: r6(inView(x)),
      y: r6(inView(y)),
      isLocal: p.isLocal === true,
      hp: Math.round(num(p.hp, 0, 100, 0)),
      shield: Math.round(num(p.shield, 0, 100, 0)),
      team: Math.trunc(num(p.team, -1e6, 1e6, -1)),
    };
    if ((typeof p.id === 'number' && Number.isFinite(p.id)) || typeof p.id === 'string') {
      o.id = String(p.id).slice(0, 32);
    }
    if (fromWorld && isNum(p.wyaw)) {
      const r = p.wyaw * Math.PI / 180, dx = Math.cos(r), dy = Math.sin(r);       // the game's heading (0 = +X, 90 = +Y) turned into "0 = up, clockwise" on this map's axes
      const deg = Math.atan2(pick(uSrc, dx, dy), -pick(vSrc, dx, dy)) * 180 / Math.PI;
      o.yaw = Math.round((((deg % 360) + 360) % 360) * 10) / 10;
    } else if (typeof p.yaw === 'number' && Number.isFinite(p.yaw)) {
      o.yaw = Math.round((((p.yaw % 360) + 360) % 360) * 10) / 10;
    }
    const name = str(p.name, 24);
    if (name) o.name = name;
    const weapon = str(p.weapon, 32);
    if (weapon) o.weapon = weapon;
    if (p.down === true) o.down = true;
    if (p.bot === true) o.bot = true;
    if (p.npc === true) o.npc = true;
    players.push(o);
  }

  const out = { connected: true, players };
  const map = wm && wm.id ? str(String(wm.id), 48) : mapName;           // the id the viewer's "Automatic" matches
  if (map) out.map = map;
  if (level) out.level = level;
  const scale = posNum(f.scale, 1e6);
  if (scale) out.scale = scale;
  const renderDistance = posNum(f.renderDistance, 1e6);
  if (renderDistance) out.renderDistance = renderDistance;
  return JSON.stringify(out);
}

// ── maps ────────────────────────────────────────────────────────────────────
function listMaps() {
  let custom = null, rotations = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'maps.json'), 'utf8'));
    if (j && Array.isArray(j.maps)) custom = j.maps;
    if (j && Array.isArray(j.rotations)) rotations = j.rotations;
  } catch { /* none, or not valid: fall back to the folder */ }
  if (custom) return rotations.length ? { maps: custom, rotations } : { maps: custom };

  let files = [];
  try { files = fs.readdirSync(MAPS_DIR).filter(n => IMAGE_NAME.test(n)).sort(); } catch { /* no folder */ }
  return {
    maps: files.map(n => {
      const id = n.replace(/\.[^.]+$/, '');
      return { id, name: id.replace(/[-_]+/g, ' '), image: '/maps/' + encodeURIComponent(n) };
    }),
  };
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

  if (pathname === '/maps.json') {
    return send(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, JSON.stringify(listMaps()));
  }

  if (pathname.startsWith('/maps/')) {
    let name;
    try { name = decodeURIComponent(pathname.slice(6)); } catch { return send(404); }
    if (!IMAGE_NAME.test(name) || path.basename(name) !== name) return send(404);
    return fs.readFile(path.join(MAPS_DIR, name), (err, data) => {
      if (err) return send(404);
      send(200, {
        'Content-Type': MAP_TYPES[path.extname(name).toLowerCase()],
        'Cache-Control': 'public, max-age=3600',
      }, data);
    });
  }

  const tm = TILE_PATH.exec(pathname);
  if (tm) {
    const file = path.join(TILES_DIR, tm[1], tm[2], tm[3] + '_' + tm[4] + '.webp');
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(404);
      const etag = 'W/"' + st.size + '-' + Math.round(st.mtimeMs) + '"';
      const cache = { ETag: etag, 'Cache-Control': 'public, max-age=3600' };
      if (req.headers['if-none-match'] === etag) return send(304, cache);
      fs.readFile(file, (err2, data) => {
        if (err2) return send(404);
        send(200, Object.assign({ 'Content-Type': 'image/webp' }, cache), data);
      });
    });
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
