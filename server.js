'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT   = process.env.PORT         || 3000;
const SECRET = process.env.RADAR_SECRET || '';

if (!SECRET) console.warn('[radar] WARNING: RADAR_SECRET not set — any host can connect');

// ── Viewer HTML ───────────────────────────────────────────────────────────────
const VIEWER = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Radar</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#060a0f;display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:monospace}
canvas{display:block}
#hud{position:fixed;top:10px;left:12px;color:#556;font-size:11px;line-height:1.8;pointer-events:none;user-select:none}
#hud-status{font-weight:bold}
#disc{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none}
#disc p{color:#ff3344;font-size:clamp(14px,3.5vw,28px);letter-spacing:.15em;font-weight:bold}
#disc small{color:#444;font-size:11px;letter-spacing:.05em}
.hidden{display:none!important}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud">
  <span id="hud-status" style="color:#445">CONNECTING...</span><br>
  players: <span id="hud-count" style="color:#667">-</span>
</div>
<div id="disc">
  <p>DMA DISCONNECTED</p>
  <small>waiting for host...</small>
</div>
<script>
var cvs = document.getElementById('c');
var ctx = cvs.getContext('2d');
var disc = document.getElementById('disc');
var hudStatus = document.getElementById('hud-status');
var hudCount = document.getElementById('hud-count');

var state = { connected: false, players: [] };
var wsAlive = false;

function resize() {
  var s = Math.min(window.innerWidth, window.innerHeight);
  cvs.width = s;
  cvs.height = s;
  draw();
}
window.addEventListener('resize', resize);
resize();

function draw() {
  var S = cvs.width;
  ctx.clearRect(0, 0, S, S);

  // background
  ctx.fillStyle = '#060a0f';
  ctx.fillRect(0, 0, S, S);

  // grid
  ctx.strokeStyle = '#0d1520';
  ctx.lineWidth = 1;
  var step = S / 10;
  for (var i = 0; i <= 10; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(S, i * step); ctx.stroke();
  }

  // border
  ctx.strokeStyle = '#1a2a3a';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, S - 2, S - 2);

  if (!wsAlive || !state.connected) {
    disc.classList.remove('hidden');
    hudStatus.textContent = 'DISCONNECTED';
    hudStatus.style.color = '#443';
    hudCount.textContent = '-';
    return;
  }

  disc.classList.add('hidden');
  hudStatus.textContent = 'LIVE';
  hudStatus.style.color = '#00ff88';

  var players = state.players || [];
  hudCount.textContent = players.length;

  var local = null;
  for (var i = 0; i < players.length; i++) {
    if (players[i].isLocal) { local = players[i]; break; }
  }
  var myTeam = local ? local.team : -999;

  var R = Math.max(5, S * 0.013);

  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    var px = p.x * S;
    var py = p.y * S;
    var hp = Math.max(0, Math.min(100, p.hp || 0));
    var sh = Math.max(0, Math.min(100, p.shield || 0));

    var col;
    if (p.isLocal)               col = '#00ff88';
    else if (p.team === myTeam)  col = '#3399ff';
    else                         col = '#ff3344';

    // glow + dot
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = R * 1.8;
    ctx.beginPath();
    ctx.arc(px, py, R, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.restore();

    // ring for local player
    if (p.isLocal) {
      ctx.strokeStyle = 'rgba(0,255,136,.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, R + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // hp / shield bars
    var bw = R * 3.6;
    var bh = Math.max(2, Math.ceil(R * 0.5));
    var bx = px - bw / 2;
    var by = py + R + 3;

    // hp bar
    ctx.fillStyle = '#0d1520';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = hp > 50 ? '#22cc44' : (hp > 25 ? '#ddaa00' : '#ff4422');
    ctx.fillRect(bx, by, bw * hp / 100, bh);

    // shield bar
    if (sh > 0) {
      ctx.fillStyle = '#0d1520';
      ctx.fillRect(bx, by + bh + 1, bw, bh);
      ctx.fillStyle = '#4499ff';
      ctx.fillRect(bx, by + bh + 1, bw * sh / 100, bh);
    }
  }
}

// keep canvas alive even when no messages come
setInterval(draw, 300);

// ── WebSocket ─────────────────────────────────────────────────────────────────
var reconnTimer = null;

function connect() {
  clearTimeout(reconnTimer);
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '?role=viewer');

  ws.onopen = function () {
    wsAlive = true;
    draw();
  };

  ws.onmessage = function (e) {
    try { state = JSON.parse(e.data); } catch (err) {}
    draw();
  };

  ws.onclose = function () {
    wsAlive = false;
    state = { connected: false, players: [] };
    draw();
    reconnTimer = setTimeout(connect, 5000);
  };

  ws.onerror = function () {};
}

connect();
</script>
</body>
</html>`;
// ─────────────────────────────────────────────────────────────────────────────

const DISC = JSON.stringify({ connected: false, players: [] });

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(VIEWER);
  } else {
    res.writeHead(405);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

let host    = null;
const viewers = new Set();

wss.on('connection', (ws, req) => {
  let params;
  try { params = new URL(req.url, 'http://x').searchParams; }
  catch { ws.close(4000, 'bad url'); return; }

  const role   = params.get('role')   || '';
  const secret = params.get('secret') || '';

  // ── host ──────────────────────────────────────────────────────────────────
  if (role === 'host') {
    if (SECRET && secret !== SECRET) {
      ws.close(4001, 'forbidden');
      console.log('[radar] host rejected: bad secret');
      return;
    }

    if (host) {
      host.close(4000, 'replaced by new host');
      console.log('[radar] previous host replaced');
    }
    host = ws;
    console.log('[radar] host connected  viewers:', viewers.size);

    ws.on('message', data => {
      const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      for (const v of viewers) {
        if (v.readyState === 1) v.send(raw);
      }
    });

    ws.on('close', () => {
      if (host !== ws) return;
      host = null;
      console.log('[radar] host disconnected — broadcasting disc');
      for (const v of viewers) {
        if (v.readyState === 1) v.send(DISC);
      }
    });

    ws.on('error', err => console.error('[radar] host error:', err.message));

  // ── viewer ────────────────────────────────────────────────────────────────
  } else if (role === 'viewer') {
    viewers.add(ws);
    console.log('[radar] viewer connected  total:', viewers.size);

    // send current disconnected state immediately if host is absent
    if (!host) ws.send(DISC);

    ws.on('close', () => {
      viewers.delete(ws);
      console.log('[radar] viewer left  total:', viewers.size);
    });
    ws.on('error', () => {});

  } else {
    ws.close(4002, 'role param required: ?role=host or ?role=viewer');
  }
});

server.listen(PORT, () => console.log('[radar] listening on port', PORT));
