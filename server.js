#!/usr/bin/env node
/* LifeBoard · 本地静态服务器（零依赖）
 *
 * 用途：在电脑上双击 start.cmd 后，浏览器打开 http://localhost:5173 使用；
 *      同一个 WiFi 下的 iPhone 用打印出来的局域网地址访问。
 *
 * 注意：http://局域网地址 不是"安全上下文"，所以手机通过局域网访问时
 *      浏览器不会启用离线缓存（PWA），但数据保存（IndexedDB）完全正常。
 *      想要手机上全屏离线体验，请使用 GitHub Pages 的 https 地址。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT) || 5173;
const MAX_TRIES = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function handle(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (err) {
    send(res, 400, 'Bad request');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // 阻止目录穿越
  const filePath = path.join(ROOT, path.normalize(pathname).replace(/^([/\\])+/, ''));
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, '404 Not Found: ' + pathname);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res).on('error', () => res.destroy());
  });
}

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    });
  });
  return out;
}

function listen(port, triesLeft) {
  const server = http.createServer(handle);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log('端口 ' + port + ' 已被占用，换 ' + (port + 1) + ' 试试…');
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const lines = [
      '',
      '  LifeBoard 已启动',
      '  ---------------------------------------------',
      '  这台电脑：  http://localhost:' + port,
    ];
    const lan = localAddresses();
    if (lan.length) {
      lines.push('  手机上打开：' + lan.map((ip) => 'http://' + ip + ':' + port).join('   '));
      lines.push('             （iPhone 需要和电脑连同一个 WiFi）');
    } else {
      lines.push('  未检测到局域网地址，手机暂时无法访问。');
    }
    lines.push('  ---------------------------------------------');
    lines.push('  按 Ctrl+C 停止服务');
    lines.push('');
    console.log(lines.join('\n'));
  });
}

listen(START_PORT, MAX_TRIES);
