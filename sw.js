/* LifeBoard · 离线缓存
 *
 * 策略：**网络优先，断网时才回退到缓存**。
 * 这个应用的目的是"断网也能打开"，不是"加载更快"，所以优先保证拿到最新代码——
 * 用缓存优先的话，改完代码已经打开过网站的设备会一直跑旧版本（旧的 HTML 配上新的 JS 还会直接出错）。
 *
 * 数据全部在 IndexedDB 里，这里只缓存页面本身。
 */
const CACHE = 'lifeboard-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/ui.js',
  './js/store.js',
  './js/calendar.js',
  './js/tier.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { /* 单个文件失败不影响安装 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE) return caches.delete(key);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      // 断网了：先用精确缓存，再退回页面外壳
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') {
          return caches.match('./index.html').then(function (page) {
            return page || caches.match('./');
          });
        }
        return Response.error();
      });
    })
  );
});
