/* LifeBoard · 云同步通道（Supabase）
 *
 * 为什么不引 @supabase/supabase-js：
 *   这个项目刻意保持零构建、零依赖、无 CDN——引一个一百多 KB 的库，
 *   要么走 CDN（离线就废了），要么把它塞进仓库（体积 + 以后还得跟着升级）。
 *   Supabase 底下就是三个普通 HTTP 接口（Auth / PostgREST / Storage），
 *   直接调反而更小更可控，也让整站继续离线可用（云同步本身当然要联网）。
 *
 * 数据放哪：
 *   sync_records     user_id + store + id + updated_at + data(jsonb)
 *   sync_tombstones  user_id + store + record_id + deleted_at
 *   Storage 桶       lifeboard-images/{user_id}/{imageId}
 *   建表语句见仓库里的 supabase/schema.sql
 *
 * 安全：网页里放的是 Publishable key（设计上就是公开的），
 *       数据隔离靠 RLS，每个登录用户只能读写自己的行。
 *       千万不要把 Service Role Key 放进来。
 *
 * 合并规则和局域网那条通道完全一致：同一条记录比 updatedAt，谁新用谁；
 * 墓碑比记录新就说明被删了，两边都删。
 */
(function (global) {
  'use strict';

  const CFG_KEY = 'lifeboard.cloud.config';
  const SESSION_KEY = 'lifeboard.cloud.session';
  const BUCKET = 'lifeboard-images';
  const STORES = ['boards', 'tasks', 'templates', 'tiers', 'items', 'images'];

  const state = {
    config: null,        // { url, key }
    session: null,       // { access_token, refresh_token, expires_at, user }
    busy: false
  };

  /* ------------------------------------------------------------------ *
   * 配置与会话（都只存本机）
   * ------------------------------------------------------------------ */

  function loadConfig() {
    try { state.config = JSON.parse(global.localStorage.getItem(CFG_KEY) || 'null'); }
    catch (err) { state.config = null; }
    if (state.config && state.config.url) state.config.url = String(state.config.url).replace(/\/+$/, '');
    return state.config;
  }

  function saveConfig(url, key) {
    state.config = { url: String(url).trim().replace(/\/+$/, ''), key: String(key).trim() };
    try { global.localStorage.setItem(CFG_KEY, JSON.stringify(state.config)); } catch (err) { /* 忽略 */ }
    return state.config;
  }

  function clearConfig() {
    state.config = null;
    try { global.localStorage.removeItem(CFG_KEY); } catch (err) { /* 忽略 */ }
  }

  function loadSession() {
    try { state.session = JSON.parse(global.localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (err) { state.session = null; }
    return state.session;
  }

  function saveSession(session) {
    state.session = session;
    try {
      if (session) global.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else global.localStorage.removeItem(SESSION_KEY);
    } catch (err) { /* 忽略 */ }
  }

  function isConfigured() { return !!(state.config && state.config.url && state.config.key); }
  function isSignedIn() { return !!(state.session && state.session.access_token && state.session.user); }
  function userEmail() { return (state.session && state.session.user && state.session.user.email) || ''; }

  /* ------------------------------------------------------------------ *
   * 底层请求
   * ------------------------------------------------------------------ */

  function endpoint(path) {
    if (!isConfigured()) throw new Error('还没有填写 Supabase 项目地址');
    return state.config.url + path;
  }

  async function readError(res) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j.error_description || j.msg || j.message || j.error || text;
      } catch (err) { detail = text; }
    } catch (err) { /* 忽略 */ }
    return detail ? detail.slice(0, 200) : ('HTTP ' + res.status);
  }

  /** Auth / PostgREST / Storage 通用的请求封装 */
  async function request(path, options) {
    const opt = options || {};
    const headers = Object.assign({
      apikey: state.config.key,
      'Content-Type': 'application/json'
    }, opt.headers || {});
    if (opt.auth !== false && state.session && state.session.access_token) {
      headers.Authorization = 'Bearer ' + state.session.access_token;
    }
    let res;
    try {
      res = await fetch(endpoint(path), {
        method: opt.method || 'GET',
        headers: headers,
        body: opt.body
      });
    } catch (netErr) {
      // fetch 抛异常 = 请求根本没发出去（DNS 被重置 / 连不上）。
      // 国内访问 supabase.co 需要代理，必须说清楚，否则用户只看到一句
      // "Failed to fetch"，完全不知道要去开 VPN。
      const err = new Error('连不上 Supabase。国内访问 supabase.co 需要开代理（VPN），打开后重试即可；本机数据不受影响。');
      err.network = true;
      err.cause = netErr;
      throw err;
    }
    if (!res.ok) {
      const detail = await readError(res);
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    if (opt.raw) return res;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (err) { return text; }
  }

  /* ------------------------------------------------------------------ *
   * 登录
   * ------------------------------------------------------------------ */

  function normaliseSession(payload) {
    if (!payload || !payload.access_token) throw new Error('登录返回的内容不完整');
    const expiresIn = Number(payload.expires_in) || 3600;
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || null,
      expires_at: Date.now() + expiresIn * 1000,
      user: payload.user || null
    };
  }

  async function signUp(email, password) {
    const body = JSON.stringify({ email: email, password: password });
    const data = await request('/auth/v1/signup', { method: 'POST', body: body, auth: false });
    // 项目如果开着"邮件确认"，这里只有 user、没有 access_token
    if (data && data.access_token) { saveSession(normaliseSession(data)); return { needsConfirm: false }; }
    return { needsConfirm: true };
  }

  async function signIn(email, password) {
    const body = JSON.stringify({ email: email, password: password });
    const data = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: body, auth: false });
    saveSession(normaliseSession(data));
    return state.session;
  }

  async function signOut() {
    try {
      if (isSignedIn()) await request('/auth/v1/logout', { method: 'POST', auth: true });
    } catch (err) { /* 本地登出就够了 */ }
    saveSession(null);
  }

  /** 令牌过期就刷新；返回可用的 access_token */
  async function ensureSession() {
    if (!isConfigured()) throw new Error('还没有填写 Supabase 项目地址');
    if (!isSignedIn()) throw new Error('还没有登录云同步账号');
    const fresh = state.session.expires_at - Date.now() > 60000;
    if (fresh) return state.session;
    if (!state.session.refresh_token) { saveSession(null); throw new Error('登录已过期，请重新登录'); }
    try {
      const body = JSON.stringify({ refresh_token: state.session.refresh_token });
      const data = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: body, auth: false });
      const next = normaliseSession(data);
      next.user = next.user || state.session.user;
      saveSession(next);
      return next;
    } catch (err) {
      saveSession(null);
      throw new Error('登录已过期，请重新登录（' + err.message + '）');
    }
  }

  /* ------------------------------------------------------------------ *
   * 读写：把两边合并，然后把本地更新的推上去
   * ------------------------------------------------------------------ */

  function stamp(rec) {
    const n = Number(rec && (rec.updatedAt || rec.createdAt));
    return isFinite(n) && n > 0 ? n : 0;
  }

  async function pullAll(table, select) {
    const rows = await request('/rest/v1/' + table + '?select=' + select + '&limit=10000');
    return Array.isArray(rows) ? rows : [];
  }

  async function upsert(table, rows) {
    if (!rows.length) return 0;
    // merge-duplicates = 主键冲突时覆盖；return=minimal 少传回一堆数据
    await request('/rest/v1/' + table, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    return rows.length;
  }

  /** 合并云端与本机：返回合并结果，以及需要推上去的记录 */
  function mergeBoth(localRecords, cloudRecords, localTombs, cloudTombs) {
    // 墓碑：两边取 deletedAt 大的。
    // 必须统一补上 id——云端拉回来的是 {store, recordId, deletedAt}，
    // 而本地 tombstones store 用 id 当主键，少了它写回时会报
    // DataError: key path did not yield a value
    const tombs = new Map();
    const putTomb = function (t) {
      if (!t || !t.store || !t.recordId) return;
      const key = t.store + '|' + t.recordId;
      const rec = {
        id: key,
        store: t.store,
        recordId: t.recordId,
        deletedAt: Number(t.deletedAt) || 0
      };
      const prev = tombs.get(key);
      if (!prev || rec.deletedAt > prev.deletedAt) tombs.set(key, rec);
    };
    cloudTombs.forEach(putTomb);
    localTombs.forEach(putTomb);

    const merged = {};
    const toPushRecords = [];
    STORES.forEach(function (store) {
      const cloud = new Map();
      (cloudRecords[store] || []).forEach(function (r) { cloud.set(r.id, r); });
      const local = new Map();
      (localRecords[store] || []).forEach(function (r) { local.set(r.id, r); });

      const ids = new Set([].concat(Array.from(cloud.keys()), Array.from(local.keys())));
      const out = [];
      ids.forEach(function (id) {
        const c = cloud.get(id);
        const l = local.get(id);
        // 被删了就别要了
        const tomb = tombs.get(store + '|' + id);
        const newer = !c ? l : (!l ? c : (stamp(l) >= stamp(c) ? l : c));
        if (!newer) return;
        if (tomb && (Number(tomb.deletedAt) || 0) >= stamp(newer)) return;
        out.push(newer);
        // 本地这版更新（或云端没有）→ 要推上去
        if (newer === l && (!c || stamp(l) > stamp(c))) {
          toPushRecords.push(Object.assign({ store: store, id: id, updated_at: stamp(l) }, { data: stripBlob(l) }));
        }
      });
      merged[store] = out;
    });

    const toPushTombs = [];
    Array.from(tombs.values()).forEach(function (t) {
      const inCloud = cloudTombs.some(function (x) { return x.store === t.store && x.recordId === t.recordId && (Number(x.deletedAt) || 0) >= (Number(t.deletedAt) || 0); });
      if (!inCloud) toPushTombs.push({ store: t.store, record_id: t.recordId, deleted_at: Number(t.deletedAt) || 0 });
    });

    return { records: merged, tombstones: Array.from(tombs.values()), toPushRecords: toPushRecords, toPushTombs: toPushTombs };
  }

  /** 记录里可能挂着 Blob（图片本体），不能塞进 jsonb */
  function stripBlob(rec) {
    const out = {};
    Object.keys(rec).forEach(function (k) {
      if (k === 'blob') return;
      out[k] = rec[k];
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 图片本体（走 Storage）
   * ------------------------------------------------------------------ */

  async function listCloudImages(userId) {
    const list = await request('/storage/v1/object/list/' + BUCKET, {
      method: 'POST',
      body: JSON.stringify({ prefix: userId + '/', limit: 10000 })
    });
    return (Array.isArray(list) ? list : [])
      .map(function (o) { return String(o.name || ''); })
      .filter(function (n) { return n && n.indexOf('/') < 0; });
  }

  async function uploadImage(userId, id, blob) {
    await request('/storage/v1/object/' + BUCKET + '/' + userId + '/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' },
      body: blob
    });
  }

  async function downloadImage(userId, id) {
    const res = await request('/storage/v1/object/' + BUCKET + '/' + userId + '/' + encodeURIComponent(id), { raw: true });
    return res.blob();
  }

  /* ------------------------------------------------------------------ *
   * 对外：和局域网通道一样的接口
   * ------------------------------------------------------------------ */

  /**
   * @param {{records:object, tombstones:Array, imageIds:Array}} local
   * @returns {Promise<{records:object, tombstones:Array, missingOnClient:Array, missingOnServer:Array, stats:object}>}
   */
  async function sync(local) {
    const session = await ensureSession();
    const userId = session.user.id;

    const [recordRows, tombRows, cloudImageIds] = await Promise.all([
      pullAll('sync_records', 'store,id,updated_at,data'),
      pullAll('sync_tombstones', 'store,record_id,deleted_at'),
      listCloudImages(userId)
    ]);

    const cloudRecords = {};
    STORES.forEach(function (s) { cloudRecords[s] = []; });
    recordRows.forEach(function (r) {
      if (!cloudRecords[r.store]) return;
      cloudRecords[r.store].push(Object.assign({}, r.data, { id: r.id, updatedAt: Number(r.updated_at) || stamp(r.data) }));
    });
    const cloudTombs = tombRows.map(function (t) {
      return { store: t.store, recordId: t.record_id, deletedAt: Number(t.deleted_at) || 0 };
    });

    const merged = mergeBoth(local.records, cloudRecords, local.tombstones || [], cloudTombs);

    // 推：本地更新的记录 + 本地新产生、云端还没有的墓碑
    const pushed = await upsert('sync_records', merged.toPushRecords.map(function (r) {
      return { user_id: userId, store: r.store, id: r.id, updated_at: r.updated_at, data: r.data };
    }));
    await upsert('sync_tombstones', merged.toPushTombs.map(function (t) {
      return { user_id: userId, store: t.store, record_id: t.record_id, deleted_at: t.deleted_at };
    }));

    const localImageIds = (local.imageIds || []);
    const cloudSet = new Set(cloudImageIds);
    const localSet = new Set(localImageIds);

    const stats = {};
    STORES.forEach(function (s) { stats[s] = (merged.records[s] || []).length; });

    return {
      records: merged.records,
      tombstones: merged.tombstones,
      missingOnClient: cloudImageIds.filter(function (id) { return !localSet.has(id); }),
      missingOnServer: localImageIds.filter(function (id) { return !cloudSet.has(id); }),
      stats: stats,
      pushedRecords: pushed,
      storage: { userId: userId, bucket: BUCKET }
    };
  }

  async function getImages(ids) {
    const userId = state.session.user.id;
    const out = {};
    for (const id of ids) {
      try {
        const blob = await downloadImage(userId, id);
        out[id] = await LB.image.blobToDataURL(blob);
      } catch (err) { /* 单张失败不影响其他 */ }
    }
    return out;
  }

  async function putImages(map) {
    const userId = state.session.user.id;
    for (const id of Object.keys(map)) {
      try {
        await uploadImage(userId, id, LB.image.dataURLToBlob(map[id]));
      } catch (err) { /* 单张失败不影响其他 */ }
    }
  }

  function load() {
    loadConfig();
    loadSession();
    return { configured: isConfigured(), signedIn: isSignedIn(), email: userEmail() };
  }

  global.LB = global.LB || {};
  global.LB.cloud = {
    load: load,
    saveConfig: saveConfig,
    clearConfig: clearConfig,
    isConfigured: isConfigured,
    isSignedIn: isSignedIn,
    userEmail: userEmail,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    sync: sync,
    getImages: getImages,
    putImages: putImages,
    config: function () { return state.config; },
    BUCKET: BUCKET
  };
})(window);
