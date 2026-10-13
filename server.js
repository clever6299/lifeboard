#!/usr/bin/env node
/* LifeBoard · 本地服务器：静态文件 + 局域网同步
 *
 * 用法：node server.js         （或双击 start.cmd）
 *
 * 静态部分和以前一样，把项目目录发给浏览器。
 * 同步部分是本机的一个小数据仓库，供同一 WiFi 下的手机和电脑互相推拉：
 *
 *   GET  /api/health          服务信息（版本、这台电脑的局域网地址）
 *   POST /api/sync            提交本地数据，拿回合并后的全量数据
 *   GET  /api/images?ids=a,b  按 id 取图片（返回 dataURL）
 *   POST /api/images          上传图片（dataURL）
 *
 * 数据落在 server.js 旁边的 sync-data/：state.json 存元数据，images/ 存图片本体。
 * 合并规则：同一条记录比 updatedAt，谁新用谁；墓碑（删除记录）比 deletedAt，
 * 墓碑比记录新就说明这条被删了，两边都删掉。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
/* 测试时可以用 LIFEBOARD_DATA 指到别处，避免动到真实数据 */
const DATA_DIR = process.env.LIFEBOARD_DATA
  ? path.resolve(process.env.LIFEBOARD_DATA)
  : path.join(ROOT, 'sync-data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const START_PORT = Number(process.env.PORT) || 5173;
const MAX_TRIES = 10;

/* 同步的元数据仓库。images 只存元数据，图片本体单独放文件。 */
const COLLECTIONS = ['boards', 'tasks', 'templates', 'tiers', 'items', 'images'];
const MAX_JSON_BYTES = 32 * 1024 * 1024;      // /api/sync
const MAX_IMAGE_BYTES = 96 * 1024 * 1024;     // /api/images
const TOMBSTONE_KEEP_DAYS = 365;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/* ------------------------------------------------------------------ *
 * 仓库状态
 * ------------------------------------------------------------------ */

function emptyState() {
  const s = { version: 1, updatedAt: 0, records: {}, tombstones: [] };
  // 必须先把每个集合建好：第一次运行时还没有 state.json，
  // 少了这一步 /api/health 里的 stats() 会直接抛错
  COLLECTIONS.forEach(function (name) { s.records[name] = []; });
  return s;
}

let state = emptyState();

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = emptyState();
    state.version = raw.version || 1;
    state.updatedAt = raw.updatedAt || 0;
    COLLECTIONS.forEach(function (name) {
      state.records[name] = Array.isArray(raw.records && raw.records[name]) ? raw.records[name] : [];
    });
    state.tombstones = Array.isArray(raw.tombstones) ? raw.tombstones : [];
    const counts = COLLECTIONS.map(function (n) { return n + ' ' + state.records[n].length; }).join('，');
    console.log('已读取同步数据：' + counts + '，删除记录 ' + state.tombstones.length + ' 条');
  } catch (err) {
    console.error('同步数据读取失败（将从空数据开始，原文件保留）：' + err.message);
    state = emptyState();
    COLLECTIONS.forEach(function (name) { state.records[name] = []; });
  }
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('同步数据写入失败：' + err.message);
    }
  }, 120);
}

function stamp(rec) {
  const n = Number(rec && rec.updatedAt);
  return isFinite(n) && n > 0 ? n : Number(rec && rec.createdAt) || 0;
}

/** 合并两个列表：同 id 取 updatedAt 大的 */
function mergeList(current, incoming) {
  const map = new Map();
  current.forEach(function (r) { if (r && r.id) map.set(r.id, r); });
  incoming.forEach(function (r) {
    if (!r || !r.id) return;
    const old = map.get(r.id);
    if (!old || stamp(r) >= stamp(old)) map.set(r.id, r);
  });
  return Array.from(map.values());
}

function mergeTombstones(current, incoming) {
  const map = new Map();
  current.forEach(function (t) { if (t && t.id) map.set(t.id, t); });
  incoming.forEach(function (t) {
    if (!t || !t.id) return;
    const old = map.get(t.id);
    if (!old || (Number(t.deletedAt) || 0) >= (Number(old.deletedAt) || 0)) map.set(t.id, t);
  });
  return Array.from(map.values());
}

/** 按墓碑删掉已被删除的记录 */
function applyTombstones() {
  const dead = new Map();
  state.tombstones.forEach(function (t) {
    const prev = dead.get(t.id);
    if (!prev || (Number(t.deletedAt) || 0) > (Number(prev.deletedAt) || 0)) dead.set(t.id, t);
  });
  COLLECTIONS.forEach(function (name) {
    state.records[name] = state.records[name].filter(function (r) {
      const t = dead.get(name + '|' + r.id);
      return !(t && (Number(t.deletedAt) || 0) >= stamp(r));
    });
  });
  // 图片记录没了，本体也删掉
  const alive = new Set(state.records.images.map(function (r) { return r.id; }));
  try {
    if (fs.existsSync(IMAGE_DIR)) {
      fs.readdirSync(IMAGE_DIR).forEach(function (file) {
        if (!alive.has(file)) fs.unlinkSync(path.join(IMAGE_DIR, file));
      });
    }
  } catch (err) { /* 清理失败不影响同步 */ }
}

function pruneTombstones() {
  const cutoff = Date.now() - TOMBSTONE_KEEP_DAYS * 86400000;
  const before = state.tombstones.length;
  state.tombstones = state.tombstones.filter(function (t) { return (Number(t.deletedAt) || 0) >= cutoff; });
  return before - state.tombstones.length;
}

/* ------------------------------------------------------------------ *
 * HTTP 辅助
 * ------------------------------------------------------------------ */

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * 同步接口
 * ------------------------------------------------------------------ */

function stats() {
  const out = {};
  COLLECTIONS.forEach(function (n) { out[n] = state.records[n].length; });
  out.tombstones = state.tombstones.length;
  return out;
}

/** 磁盘上真实存在的图片文件。判断"我有没有这张图"必须看文件，不能看元数据，
 *  因为元数据是随 /api/sync 一起过来的，那时图片本体还没传。 */
function imageFilesOnDisk() {
  const set = new Set();
  try {
    if (fs.existsSync(IMAGE_DIR)) {
      fs.readdirSync(IMAGE_DIR).forEach(function (f) { if (!f.startsWith('.')) set.add(f); });
    }
  } catch (err) { /* 读不到就当没有 */ }
  return set;
}

async function handleSync(req, res) {
  const text = await readBody(req, MAX_JSON_BYTES);
  let body;
  try { body = JSON.parse(text || '{}'); }
  catch (err) { return sendJSON(res, 400, { ok: false, error: '请求不是合法 JSON' }); }

  const incoming = body.records || {};
  let changed = 0;

  COLLECTIONS.forEach(function (name) {
    const list = Array.isArray(incoming[name]) ? incoming[name] : [];
    const before = state.records[name].length;
    state.records[name] = mergeList(state.records[name], list);
    changed += state.records[name].length - before;
  });

  const incomingTombs = Array.isArray(body.tombstones) ? body.tombstones : [];
  const beforeTombs = state.tombstones.length;
  state.tombstones = mergeTombstones(state.tombstones, incomingTombs);
  if (state.tombstones.length !== beforeTombs) changed++;

  const purged = pruneTombstones();
  applyTombstones();
  if (changed) { state.updatedAt = Date.now(); saveStateSoon(); }

  const files = imageFilesOnDisk();
  const clientHas = new Set(Array.isArray(body.imageIds) ? body.imageIds : []);

  // 客户端要拉的：服务器磁盘上有文件、客户端没有的
  const missingOnClient = Array.from(files).filter(function (id) { return !clientHas.has(id); });
  // 客户端要推的：客户端有、服务器磁盘上没有文件的
  const missingOnServer = Array.from(clientHas).filter(function (id) { return !files.has(id); });

  sendJSON(res, 200, {
    ok: true,
    serverTime: Date.now(),
    records: state.records,
    tombstones: state.tombstones,
    imageIds: Array.from(files),
    missingOnClient: missingOnClient,
    missingOnServer: missingOnServer,
    stats: stats(),
    changed: changed,
    purgedTombstones: purged
  });
}

function handleImagesGet(req, res, query) {
  const ids = String(query.get('ids') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return sendJSON(res, 400, { ok: false, error: '没有指定 ids' });
  if (ids.length > 500) return sendJSON(res, 400, { ok: false, error: '一次最多取 500 张' });

  const metaById = new Map(state.records.images.map(function (r) { return [r.id, r]; }));
  const images = {};
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;      // 挡住路径穿越
    const meta = metaById.get(id);
    if (!meta) continue;
    const file = path.join(IMAGE_DIR, id);
    if (!fs.existsSync(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      images[id] = 'data:' + (meta.type || 'image/webp') + ';base64,' + buf.toString('base64');
    } catch (err) { /* 跳过读不到的文件 */ }
  }
  sendJSON(res, 200, { ok: true, images: images });
}

async function handleImagesPost(req, res) {
  const text = await readBody(req, MAX_IMAGE_BYTES);
  let body;
  try { body = JSON.parse(text || '{}'); }
  catch (err) { return sendJSON(res, 400, { ok: false, error: '请求不是合法 JSON' }); }

  const images = body.images || {};
  const ids = Object.keys(images);
  if (!ids.length) return sendJSON(res, 200, { ok: true, saved: 0 });

  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const metaById = new Map(state.records.images.map(function (r) { return [r.id, r]; }));
  let saved = 0;
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const dataUrl = String(images[id] || '');
    const comma = dataUrl.indexOf(',');
    if (comma < 0) continue;
    try {
      const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
      if (!buf.length) continue;
      fs.writeFileSync(path.join(IMAGE_DIR, id), buf);
      saved++;
      // 图有本体但元数据还没同步过来时，先补一条最小记录，下次 /api/sync 会被真实元数据覆盖
      if (!metaById.has(id)) {
        const mime = (dataUrl.slice(0, comma).match(/:(.*?);/) || [])[1] || 'image/webp';
        const rec = { id: id, name: '未命名图片', type: mime, size: buf.length, createdAt: Date.now(), updatedAt: Date.now() };
        state.records.images = mergeList(state.records.images, [rec]);
      }
    } catch (err) { /* 跳过写失败的 */ }
  }
  if (saved) { state.updatedAt = Date.now(); saveStateSoon(); }
  sendJSON(res, 200, { ok: true, saved: saved, stats: stats() });
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.join(ROOT, path.normalize(pathname).replace(/^([/\\])+/, ''));
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end('Forbidden'); return; }
  // 同步数据不通过静态服务暴露
  if (rel === 'sync-data' || rel.startsWith('sync-data' + path.sep)) { res.writeHead(404); res.end('Not Found'); return; }

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res).on('error', function () { res.destroy(); });
  });
}

function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (err) { res.writeHead(400); res.end('Bad request'); return; }

  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const route = function (fn) {
      Promise.resolve()
        .then(fn)
        .catch(function (err) {
          if (!res.headersSent) sendJSON(res, 500, { ok: false, error: err.message });
          else res.destroy();
        });
    };
    if (pathname === '/api/health' && req.method === 'GET') {
      return route(function () {
        sendJSON(res, 200, {
          ok: true,
          app: 'lifeboard',
          version: 1,
          serverTime: Date.now(),
          addresses: localAddresses(),
          port: server.port || START_PORT,
          stats: stats()
        });
      });
    }
    if (pathname === '/api/sync' && req.method === 'POST') return route(function () { return handleSync(req, res); });
    if (pathname === '/api/images' && req.method === 'GET') return route(function () { return handleImagesGet(req, res, url.searchParams); });
    if (pathname === '/api/images' && req.method === 'POST') return route(function () { return handleImagesPost(req, res); });
    return sendJSON(res, 404, { ok: false, error: '没有这个接口：' + pathname });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed');
    return;
  }
  serveStatic(req, res, pathname);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

const server = http.createServer(handle);

function listen(port, triesLeft) {
  server.once('error', function (err) {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log('端口 ' + port + ' 已被占用，换 ' + (port + 1) + ' 试试…');
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', function () {
    server.port = port;
    loadState();
    const lan = localAddresses();
    const lines = ['', '  LifeBoard 已启动', '  ─────────────────────────────────────────────'];
    lines.push('  这台电脑：      http://localhost:' + port);
    if (lan.length) {
      lines.push('  iPhone 打开：   ' + lan.map(function (ip) { return 'http://' + ip + ':' + port; }).join('   '));
      lines.push('                  （手机要和电脑连同一个 WiFi）');
    } else {
      lines.push('  没有检测到局域网地址，手机暂时连不上。');
    }
    lines.push('  同步数据放在：  ' + path.relative(ROOT, DATA_DIR));
    lines.push('  ─────────────────────────────────────────────');
    lines.push('  同步只在局域网里跑，数据不经过任何服务器。');
    lines.push('  按 Ctrl+C 停止服务');
    lines.push('');
    console.log(lines.join('\n'));
  });
}

listen(START_PORT, MAX_TRIES);
