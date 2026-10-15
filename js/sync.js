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

  /* ---------------- 两条通道 ----------------
   * 合并规则两边完全一样（updatedAt 比新旧 + 墓碑记录删除），
   * 区别只在数据怎么运：局域网走本机服务器，云端走 Supabase。
   * 接口统一成 { sync, getImages, putImages }，run() 不用关心是哪条。
   */

  const LAN = {
    id: 'lan',
    label: '同一 WiFi',
    sync: function (local) {
      return fetch(api('sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: local.records,
          tombstones: local.tombstones,
          imageIds: local.imageIds
        })
      }).then(function (res) {
        if (!res.ok) throw new Error('同步服务返回 HTTP ' + res.status);
        return res.json();
      }).then(function (remote) {
        if (!remote || !remote.ok) throw new Error((remote && remote.error) || '同步服务返回了意外的内容');
        return remote;
      });
    },
    getImages: function (ids) {
      return fetch(api('images?ids=' + encodeURIComponent(ids.join(','))), { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('取图片失败 HTTP ' + r.status);
          return r.json();
        })
        .then(function (body) { return body.images || {}; });
    },
    putImages: function (map) {
      return fetch(api('images'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: map })
      }).then(function (r) { return r.json(); });
    }
  };

  const CLOUD = {
    id: 'cloud',
    label: '云端',
    sync: function (local) { return LB.cloud.sync(local); },
    getImages: function (ids) { return LB.cloud.getImages(ids); },
    putImages: function (map) { return LB.cloud.putImages(map); }
  };

  /** 已登录云端就用云端，否则用局域网 */
  function useCloud() {
    return !!(global.LB.cloud && LB.cloud.isConfigured() && LB.cloud.isSignedIn());
  }
  function activeTransport() { return useCloud() ? CLOUD : LAN; }

  /* ---------------- 同步主流程 ---------------- */

  function run(transport) {
    if (state.busy) return Promise.resolve(null);
    state.busy = true;
    const started = Date.now();
    const t = transport || activeTransport();
    let pushedImages = 0;
    let pulledImages = 0;

    return collect().then(function (local) {
      return t.sync(local);
    }).then(function (remote) {
      const pull = remote.missingOnClient || [];
      const push = remote.missingOnServer || [];

      // 先把另一边多的图片拉下来（后面写元数据时才有本体可用）
      const pullStep = pull.length
        ? t.getImages(pull)
          .then(function (images) {
            const metaById = new Map((remote.records.images || []).map(function (r) { return [r.id, r]; }));
            const list = [];
            Object.keys(images || {}).forEach(function (id) {
              const meta = metaById.get(id) || { id: id, name: '未命名图片', type: 'image/webp' };
              try {
                list.push(Object.assign({}, meta, {
                  blob: LB.image.dataURLToBlob(images[id]),
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
          return t.putImages(payload);
        });
      }).then(function () {
        return applyRemote(remote);
      }).then(function () {
        LB.image.clearCache();
        const info = {
          at: Date.now(),
          ms: Date.now() - started,
          via: t.id,
          viaLabel: t.label,
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

  /** 云端连不上时自动回退
   *
   * 典型场景：登录了云端，但在家忘了开代理。这时局域网明明就在眼前，
   * 不该因为云端不通就整个失败。云端失败后探一下局域网，通就走局域网，
   * 并告诉用户发生了什么（不静默改变同步方向）。
   */
  function runWithFallback() {
    const first = activeTransport();
    if (first.id !== 'cloud') return run(first);

    return run(first).catch(function (err) {
      return health().then(function (h) { return h; }, function () { return null; }).then(function (h) {
        if (!h) throw err;                       // 局域网也不通，把云端那个错抛回去
        state.fellBackToLan = true;
        return run(LAN).then(function (info) {
          info.fellBack = true;
          info.firstError = err.message;
          return info;
        });
      });
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
    el.cloudBox = UI.$('#syncCloudBox');
    el.cloudForm = UI.$('#syncCloudForm');
    el.cloudInfo = UI.$('#syncCloudInfo');
    el.cloudUrl = UI.$('#cloudUrl');
    el.cloudKey = UI.$('#cloudKey');
    el.cloudEmail = UI.$('#cloudEmail');
    el.cloudPass = UI.$('#cloudPass');
    el.cloudWho = UI.$('#cloudWho');
    el.cloudMsg = UI.$('#cloudMsg');
    el.cloudServerStats = UI.$('#cloudServerStats');
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

  /* ---------------- 云同步那一块 ---------------- */

  function cloudMsg(text, kind) {
    if (!el.cloudMsg) return;
    el.cloudMsg.textContent = text || '';
    el.cloudMsg.style.color = kind === 'err' ? 'var(--red)' : (kind === 'ok' ? 'var(--ink)' : '');
  }

  function renderCloud() {
    if (!el.cloudBox) return;
    const info = LB.cloud.load();
    const signed = info.signedIn;
    el.cloudForm.classList.toggle('hidden', signed);
    el.cloudInfo.classList.toggle('hidden', !signed);

    if (signed) {
      el.cloudWho.textContent = info.email || '（已登录）';
    } else if (info.configured) {
      const cfg = LB.cloud.config();
      if (!el.cloudUrl.value) el.cloudUrl.value = cfg.url || '';
      if (!el.cloudKey.value) el.cloudKey.value = cfg.key || '';
    }
    // 没配好就把这一块展开，省得用户找不到
    if (!signed) el.cloudBox.open = true;
  }

  function cloudSignIn() {
    const url = el.cloudUrl.value.trim();
    const key = el.cloudKey.value.trim();
    const email = el.cloudEmail.value.trim();
    const pass = el.cloudPass.value;
    if (!url || !key) { cloudMsg('先把 Project URL 和 Publishable key 填上', 'err'); return; }
    if (!email || !pass) { cloudMsg('填一下邮箱和密码', 'err'); return; }

    LB.cloud.saveConfig(url, key);
    cloudMsg('正在登录…');
    LB.cloud.signIn(email, pass).then(function () {
      cloudMsg('登录成功', 'ok');
      el.cloudPass.value = '';
      renderCloud();
      renderStatus();
      renderStats();
      UI.toast('已登录云同步：' + LB.cloud.userEmail(), 'ok');
    }).catch(function (err) {
      cloudMsg('登录失败：' + err.message, 'err');
    });
  }

  function cloudSignUp() {
    const url = el.cloudUrl.value.trim();
    const key = el.cloudKey.value.trim();
    const email = el.cloudEmail.value.trim();
    const pass = el.cloudPass.value;
    if (!url || !key) { cloudMsg('先把 Project URL 和 Publishable key 填上', 'err'); return; }
    if (!email || !pass) { cloudMsg('填一下邮箱和密码（至少 6 位）', 'err'); return; }
    if (pass.length < 6) { cloudMsg('Supabase 默认要求密码至少 6 位', 'err'); return; }

    LB.cloud.saveConfig(url, key);
    cloudMsg('正在注册…');
    LB.cloud.signUp(email, pass).then(function (res) {
      if (res && res.needsConfirm) {
        cloudMsg('注册成功，但项目开着"邮件确认"——去邮箱点一下确认链接，或者到 Supabase 的 Authentication 里关掉 Confirm email', 'err');
        return;
      }
      cloudMsg('注册并登录成功', 'ok');
      el.cloudPass.value = '';
      renderCloud();
      renderStatus();
      renderStats();
      UI.toast('云同步账号已建好', 'ok');
    }).catch(function (err) {
      cloudMsg('注册失败：' + err.message, 'err');
    });
  }

  function cloudSignOut() {
    LB.cloud.signOut().then(function () {
      renderCloud();
      cloudMsg('');
      renderStatus();
      renderStats();
      UI.toast('已退出云同步，回到局域网方式', 'ok');
    });
  }

  function cloudForget() {
    UI.confirm({
      title: '清除云同步配置',
      html: '<p>只会清掉本机保存的项目地址、密钥和登录状态。</p>' +
            '<p class="muted small">云端已有的数据不会被删除；本机数据也不动。</p>',
      okLabel: '清除'
    }).then(function (ok) {
      if (!ok) return;
      LB.cloud.signOut().then(function () {
        LB.cloud.clearConfig();
        el.cloudUrl.value = '';
        el.cloudKey.value = '';
        renderCloud();
        cloudMsg('已清除', 'ok');
        renderStatus();
        renderStats();
      });
    });
  }

  /* ---------------- 状态 ---------------- */

  function renderStatus() {
    if (!el.status) return;

    // 云端优先：登录了就用云端，局域网那条自动退居备用
    if (useCloud()) {
      el.status.innerHTML = '<p class="sync-good"><strong>云端同步已就绪</strong></p>' +
        '<p class="muted small">当前走云端：随时随地都能同步，不用开电脑，也不用装证书。' +
        '退出登录就会自动切回局域网方式。</p>';
      el.address.classList.add('hidden');
      el.doBtn.disabled = state.busy;
      return;
    }

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
        '<p class="muted small">' + UI.esc(why) + ' 想随时随地同步的话，把下面的「云同步」配上就行。</p>';
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
    const parts = [];

    if (useCloud()) {
      const s = (state.last && state.last.via === 'cloud' && state.last.serverStats) || null;
      parts.push('<p class="muted small">云端账号：' + UI.esc(LB.cloud.userEmail() || '已登录') + '</p>');
      if (s) {
        parts.push('<p class="muted small">云端上：任务 ' + (s.tasks || 0) + '，常用 ' + (s.templates || 0) +
          '，榜单 ' + (s.boards || 0) + '，卡片 ' + (s.items || 0) + '，图片 ' + (s.images || 0) + '</p>');
      } else {
        parts.push('<p class="muted small">云端上的数据量，点一次同步就会显示。</p>');
      }
    } else {
      const serverCounts = (state.health && state.health.stats) || {};
      parts.push('<p class="muted small">电脑上：' + localCountsText(serverCounts) + '</p>');
    }

    if (state.last) {
      parts.push('<p class="muted small">上次同步：' + UI.esc(whenText(state.last.at)) +
        (state.last.viaLabel ? '（' + UI.esc(state.last.viaLabel) + '）' : '') +
        '，上传图片 ' + (state.last.pushedImages || 0) + ' 张，下载图片 ' + (state.last.pulledImages || 0) + ' 张</p>');
    } else {
      parts.push('<p class="muted small">这台设备还没有同步过。</p>');
    }
    el.stats.innerHTML = parts.join('');
  }

  function fillLocalHint() {
    return LB.store.counts().then(function (counts) {
      if (el.hint) el.hint.textContent = '这台设备上：' + localCountsText(counts);
    });
  }

  function openDialog() {
    UI.openModal('syncModal');
    renderCloud();
    if (el.status) el.status.innerHTML = '<p class="muted small">正在检测…</p>';
    if (el.address) el.address.classList.add('hidden');
    if (el.doBtn) el.doBtn.disabled = true;

    if (useCloud()) {
      renderStatus();
      renderStats();
      fillLocalHint();
      return;
    }

    health().then(function () {
      renderStatus();
      renderStats();
      fillLocalHint();
    }).catch(function (err) {
      state.health = null;
      renderStatus();
      renderStats();
      fillLocalHint();
      if (el.hint) {
        el.hint.textContent = (isSecure() && !isLanHost() && !isLocalHost())
          ? '想同步的话，用电脑的局域网地址打开本页，或者在上面配好「云同步」。'
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

    runWithFallback().then(function (info) {
      return LB.calendar.refresh().then(function () { return LB.tier.reload(); }).then(function () {
        UI.busy(false);
        el.doBtn.textContent = original;
        el.doBtn.disabled = false;
        renderStatus();
        renderStats();
        if (!useCloud() || info.fellBack) health().then(function () { renderStatus(); renderStats(); }).catch(function () {});
        const secs = Math.round((info.ms || 0) / 100) / 10;
        const imgs = (info.pushedImages ? '，上传 ' + info.pushedImages + ' 张图' : '') +
                     (info.pulledImages ? '，下载 ' + info.pulledImages + ' 张图' : '');
        UI.toast((info.fellBack
          ? '云端连不上（多半是没开代理），已改用局域网同步'
          : '同步完成（' + (info.viaLabel || '同一 WiFi') + '）') + '，用时 ' + secs + ' 秒' + imgs, 'ok');
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
    LB.cloud.load();
    state.ready = true;
    UI.$('#btnSync').addEventListener('click', openDialog);
    el.doBtn.addEventListener('click', doSync);
    UI.$('#btnCopyAddr').addEventListener('click', copyAddress);
    UI.$('#btnCloudSignIn').addEventListener('click', cloudSignIn);
    UI.$('#btnCloudSignUp').addEventListener('click', cloudSignUp);
    UI.$('#btnCloudSignOut').addEventListener('click', cloudSignOut);
    UI.$('#btnCloudForget').addEventListener('click', cloudForget);
    UI.$('#btnCloudForget2').addEventListener('click', cloudForget);
    if (el.cloudPass) {
      el.cloudPass.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); cloudSignIn(); }
      });
    }
  }

  global.LB = global.LB || {};
  global.LB.sync = {
    init: init,
    run: run,
    runWithFallback: runWithFallback,
    health: health,
    state: state,
    useCloud: useCloud,
    activeTransport: activeTransport,
    lastSync: function () { return state.last; }
  };
})(window);
