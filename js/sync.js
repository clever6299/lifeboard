/* LifeBoard · 局域网同步
 *
 * 同步服务跑在电脑上的 server.js 里，和网页同源，所以不需要配置任何地址——
 * 只要这个页面是从电脑的地址打开的（http://localhost:5173 或 http://192.168.x.x:5173）。
 *
 * 为什么不支持从 GitHub Pages 同步：
 * 浏览器禁止 https 页面请求 http 局域网地址（混合内容拦截），
 * 而局域网服务器只能是 http（给它配证书要自己在手机上装信任文件，代价更大）。
 * 所以手机要同步时，用电脑的局域网地址打开即可。
 *
 * 同步是手动的：点一次 = 把本地的推上去 + 把服务器上新的拉下来 + 应用合并结果。
 * 没点同步的时候，一切都在本机，跟以前一样。
 */
(function (global) {
  'use strict';

  const DATA_STORES = (global.LB && LB.DATA_STORES) || ['boards', 'tasks', 'templates', 'tiers', 'items', 'images'];
  const LAST_KEY = 'lifeboard.lastSync';

  const state = {
    health: null,
    last: null,
    busy: false,
    ready: false
  };

  const el = {};

  function api(path) { return new URL('api/' + path, location.href).href; }

  /* ---------------- 上次同步时间 ---------------- */

  function loadLast() {
    try { state.last = JSON.parse(global.localStorage.getItem(LAST_KEY) || 'null'); }
    catch (err) { state.last = null; }
  }
  function saveLast(info) {
    state.last = info;
    try { global.localStorage.setItem(LAST_KEY, JSON.stringify(info)); } catch (err) { /* 忽略 */ }
  }
  function whenText(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return new Date(ts).toLocaleString();
  }

  /* ---------------- 健康检查 ---------------- */

  function health() {
    return fetch(api('health'), { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (info) {
      if (!info || info.app !== 'lifeboard') throw new Error('这个地址不是 LifeBoard 的同步服务');
      state.health = info;
      return info;
    });
  }

  /* ---------------- 收集 / 应用 ---------------- */

  function collect() {
    const records = {};
    return DATA_STORES.reduce(function (chain, name) {
      return chain.then(function () {
        return LB.store.all(name).then(function (rows) {
          if (name === 'images') {
            // 只送元数据，图片本体单独走 /api/images
            records.images = rows.map(function (r) {
              return {
                id: r.id, name: r.name, type: r.type, width: r.width, height: r.height,
                size: r.size, createdAt: r.createdAt, updatedAt: r.updatedAt
              };
            });
          } else {
            records[name] = rows;
          }
        });
      });
    }, Promise.resolve()).then(function () {
      return LB.store.all('tombstones');
    }).then(function (tombs) {
      return {
        records: records,
        tombstones: tombs,
        imageIds: (records.images || []).map(function (r) { return r.id; })
      };
    });
  }

  function applyRemote(remote) {
    const tombMap = new Map();
    (remote.tombstones || []).forEach(function (t) {
      tombMap.set(t.store + '|' + t.recordId, Number(t.deletedAt) || 0);
    });

    // 1) 远端墓碑比本地记录新 → 本地也删掉（silent：不再补一笔墓碑）
    const deletions = DATA_STORES.map(function (name) {
      return LB.store.all(name).then(function (rows) {
        const dead = rows.filter(function (r) {
          const t = tombMap.get(name + '|' + r.id);
          return t && t >= (r.updatedAt || r.createdAt || 0);
        });
        return Promise.all(dead.map(function (r) { return LB.store.del(name, r.id, { silent: true }); }));
      });
    });

    return Promise.all(deletions).then(function () {
      // 2) 写入远端记录，保留原始时间戳
      return Promise.all(DATA_STORES.map(function (name) {
        const incoming = (remote.records && remote.records[name]) || [];
        if (name !== 'images') return LB.store.putMany(name, incoming, { keepUpdatedAt: true });
        return LB.store.all('images').then(function (localRows) {
          const byId = new Map(localRows.map(function (r) { return [r.id, r]; }));
          const merged = incoming.map(function (r) {
            const local = byId.get(r.id);
            if (!local || !local.blob) return null;      // 本体还没到，等下一步补
            return Object.assign({}, r, { blob: local.blob });
          }).filter(Boolean);
          return LB.store.putMany('images', merged, { keepUpdatedAt: true });
        });
      }));
    }).then(function () {
      return LB.store.putMany('tombstones', remote.tombstones || [], { keepUpdatedAt: true });
    });
  }

  /* ---------------- 同步主流程 ---------------- */

  function run() {
    if (state.busy) return Promise.resolve(null);
    state.busy = true;
    const started = Date.now();
    let pushedImages = 0;
    let pulledImages = 0;

    return collect().then(function (local) {
      return fetch(api('sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: local.records,
          tombstones: local.tombstones,
          imageIds: local.imageIds
        })
      });
    }).then(function (res) {
      if (!res.ok) throw new Error('同步服务返回 HTTP ' + res.status);
      return res.json();
    }).then(function (remote) {
      if (!remote || !remote.ok) throw new Error((remote && remote.error) || '同步服务返回了意外的内容');

      const pull = remote.missingOnClient || [];
      const push = remote.missingOnServer || [];

      // 先把服务器上多的图片拉下来（后面写元数据时才有本体可用）
      const pullStep = pull.length
        ? fetch(api('images?ids=' + encodeURIComponent(pull.join(','))), { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('取图片失败 HTTP ' + r.status);
            return r.json();
          })
          .then(function (body) {
            const metaById = new Map((remote.records.images || []).map(function (r) { return [r.id, r]; }));
            const list = [];
            Object.keys(body.images || {}).forEach(function (id) {
              const meta = metaById.get(id) || { id: id, name: '未命名图片', type: 'image/webp' };
              try {
                list.push(Object.assign({}, meta, {
                  blob: LB.image.dataURLToBlob(body.images[id]),
                  updatedAt: meta.updatedAt || Date.now()
                }));
              } catch (err) { /* 跳过坏数据 */ }
            });
            pulledImages = list.length;
            return LB.store.putMany('images', list, { keepUpdatedAt: true });
          })
        : Promise.resolve();

      return pullStep.then(function () {
        if (!push.length) return null;
        const payload = {};
        return push.reduce(function (chain, id) {
          return chain.then(function () {
            return LB.image.dataURL(id).then(function (dataUrl) {
              if (dataUrl) payload[id] = dataUrl;
            });
          });
        }, Promise.resolve()).then(function () {
          const ids = Object.keys(payload);
          if (!ids.length) return null;
          pushedImages = ids.length;
          return fetch(api('images'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: payload })
          }).then(function (r) { return r.json(); });
        });
      }).then(function () {
        return applyRemote(remote);
      }).then(function () {
        LB.image.clearCache();
        const info = {
          at: Date.now(),
          ms: Date.now() - started,
          pushedImages: pushedImages,
          pulledImages: pulledImages,
          serverStats: remote.stats || {},
          purgedTombstones: remote.purgedTombstones || 0
        };
        saveLast(info);
        state.busy = false;
        return info;
      });
    }).catch(function (err) {
      state.busy = false;
      throw err;
    });
  }

  /* ---------------- 界面 ---------------- */

  function cacheEls() {
    el.status = UI.$('#syncStatus');
    el.address = UI.$('#syncAddress');
    el.lanUrl = UI.$('#syncLanUrl');
    el.stats = UI.$('#syncStats');
    el.hint = UI.$('#syncHint');
    el.doBtn = UI.$('#btnDoSync');
  }

  function localCountsText(counts) {
    return [
      '任务 ' + (counts.tasks || 0),
      '常用 ' + (counts.templates || 0),
      '榜单 ' + (counts.boards || 0),
      '卡片 ' + (counts.items || 0),
      '图片 ' + (counts.images || 0)
    ].join('，');
  }

  function isLanHost() { return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname); }
  function isLocalHost() { return location.hostname === 'localhost' || location.hostname === '127.0.0.1'; }
  function isSecure() { return location.protocol === 'https:'; }

  function renderStatus() {
    if (!el.status) return;

    if (!state.health) {
      // 连不上：分情况说清楚，别让人猜
      let why;
      if (isSecure() && !isLanHost() && !isLocalHost()) {
        why = '当前是从 GitHub Pages 那个 https 网址打开的。浏览器不允许 https 页面访问局域网的 http 服务，' +
              '所以在那个网址上同步不了。';
      } else if (isSecure()) {
        why = '常见原因：手机不在同一个 WiFi，或者电脑上的服务没开。' +
              '这不影响本机数据，回到家里再点一次同步就行。';
      } else {
        why = '请确认电脑上的服务正在运行，并且本页是从电脑的地址打开的。';
      }
      el.status.innerHTML = '<p class="sync-bad"><strong>现在连不上电脑上的同步服务。</strong></p>' +
        '<p class="muted small">' + UI.esc(why) + '</p>';
      el.address.classList.add('hidden');
      el.doBtn.disabled = true;
      return;
    }

    const httpsPort = state.health.httpsPort;
    const httpPort = state.health.port;
    const lan = state.health.addresses || [];

    let mode;
    if (isLocalHost()) {
      mode = '这是电脑本身，直接同步就行。';
    } else if (isSecure() && isLanHost()) {
      mode = '这台设备用的是安全地址：在家能同步，出门也能靠离线缓存照常打开，数据只有一份。';
    } else if (isSecure()) {
      mode = '当前是 https，但同步服务在电脑上——请改用下面那个地址打开，之后就一直用它。';
    } else {
      mode = '当前是 http：能同步，但手机装不了离线缓存，出门会打不开。建议按下面换成 https 地址。';
    }

    el.status.innerHTML = '<p class="sync-good"><strong>同步服务在线</strong></p>' +
      '<p class="muted small">' + UI.esc(mode) + '</p>';

    // 需要给手机一个该用的地址时，把它显示出来
    const phoneUrls = lan.map(function (ip) {
      return httpsPort ? 'https://' + ip + ':' + httpsPort + '/' : 'http://' + ip + ':' + httpPort + '/';
    });
    const alreadyRight = isSecure() && isLanHost() && httpsPort && location.port === String(httpsPort);
    if (phoneUrls.length && !alreadyRight) {
      el.lanUrl.textContent = phoneUrls[0];
      el.address.classList.remove('hidden');
    } else {
      el.address.classList.add('hidden');
    }

    el.doBtn.disabled = state.busy;
  }

  function renderStats() {
    if (!el.stats) return;
    const serverCounts = (state.health && state.health.stats) || {};
    const parts = [];
    parts.push('<p class="muted small">电脑上：' + localCountsText(serverCounts) + '</p>');
    if (state.last) {
      parts.push('<p class="muted small">上次同步：' + UI.esc(whenText(state.last.at)) +
        '（上传图片 ' + (state.last.pushedImages || 0) + ' 张，下载图片 ' + (state.last.pulledImages || 0) + ' 张）</p>');
    } else {
      parts.push('<p class="muted small">这台设备还没有同步过。</p>');
    }
    el.stats.innerHTML = parts.join('');
  }

  function openDialog() {
    UI.openModal('syncModal');
    if (el.status) el.status.innerHTML = '<p class="muted small">正在检测同步服务…</p>';
    if (el.address) el.address.classList.add('hidden');
    if (el.doBtn) el.doBtn.disabled = true;

    health().then(function () {
      renderStatus();
      renderStats();
      LB.store.counts().then(function (counts) {
        if (el.hint) el.hint.textContent = '这台设备上：' + localCountsText(counts);
      });
    }).catch(function (err) {
      state.health = null;
      renderStatus();
      if (el.hint) {
        el.hint.textContent = (isSecure() && !isLanHost() && !isLocalHost())
          ? '想同步的话，用电脑的局域网地址打开本页即可。'
          : '检测失败：' + err.message;
      }
    });
  }

  function doSync() {
    // 不要在这里动 state.busy：run() 自己会判断"忙就别进来"，
    // 先置忙会让 run() 直接返回 null，按钮就再也回不来了
    if (state.busy) return;
    el.doBtn.disabled = true;
    const original = el.doBtn.textContent;
    el.doBtn.textContent = '同步中…';
    UI.busy(true, '正在同步…');

    run().then(function (info) {
      return LB.calendar.refresh().then(function () { return LB.tier.reload(); }).then(function () {
        UI.busy(false);
        el.doBtn.textContent = original;
        el.doBtn.disabled = false;
        health().then(function () { renderStatus(); renderStats(); }).catch(function () {});
        UI.toast('同步完成，用时 ' + Math.round((info.ms || 0) / 100) / 10 + ' 秒' +
          (info.pushedImages ? '，上传 ' + info.pushedImages + ' 张图' : '') +
          (info.pulledImages ? '，下载 ' + info.pulledImages + ' 张图' : ''), 'ok');
      });
    }).catch(function (err) {
      UI.busy(false);
      el.doBtn.textContent = original;
      el.doBtn.disabled = false;
      UI.toast('同步失败：' + err.message, 'err');
    });
  }

  function copyAddress() {
    const text = el.lanUrl ? el.lanUrl.textContent : '';
    if (!text) return;
    const done = function () { UI.toast('地址已复制', 'ok'); };
    if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(done).catch(function () { UI.toast('复制失败，请手动输入 ' + text, 'err'); });
    } else {
      UI.toast('请手动输入 ' + text, 'err');
    }
  }

  function init() {
    cacheEls();
    loadLast();
    state.ready = true;
    UI.$('#btnSync').addEventListener('click', openDialog);
    el.doBtn.addEventListener('click', doSync);
    UI.$('#btnCopyAddr').addEventListener('click', copyAddress);
  }

  global.LB = global.LB || {};
  global.LB.sync = {
    init: init,
    run: run,
    health: health,
    state: state,
    lastSync: function () { return state.last; }
  };
})(window);
