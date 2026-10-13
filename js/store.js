/* LifeBoard · 数据层
 * IndexedDB 封装 + 图片压缩 + 导入导出。无外部依赖。
 * 挂在 window.LB.store / window.LB.image 上。
 *
 * 数据模型
 *   tasks  { id, date:'YYYY-MM-DD', title, note, done, priority:0|1|2, createdAt, updatedAt }
 *   tiers  { id, name, color, order }
 *   items  { id, imageId, tierId:null|string, name, stars:0..5, comment, order, w, h, createdAt, updatedAt }
 *   images { id, name, type, width, height, size, blob, createdAt }
 */
(function (global) {
  'use strict';

  const DB_NAME = 'lifeboard';
  const DB_VERSION = 1;
  const STORES = ['tasks', 'tiers', 'items', 'images'];
  const APP_TAG = 'lifeboard';
  const SCHEMA = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('这个浏览器不支持本地数据库（IndexedDB）')); return; }
      let req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (err) { reject(err); return; }
      req.onupgradeneeded = function () {
        const db = req.result;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('无法打开本地数据库')); };
      req.onblocked = function () { reject(new Error('本地数据库被其它标签页占用，请关闭本页的其它标签页后重试')); };
    });
    // 打开失败时允许下次重试
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function run(storeName, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        let t;
        try { t = db.transaction(storeName, mode); }
        catch (err) { reject(err); return; }
        let req;
        try { req = fn(t.objectStore(storeName)); }
        catch (err) { reject(err); return; }
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = function () { reject(t.error || new Error('数据库操作失败')); };
        t.onabort = function () { reject(t.error || new Error('数据库事务被中止')); };
      });
    });
  }

  const store = {
    all: function (name) { return run(name, 'readonly', function (s) { return s.getAll(); }); },
    get: function (name, id) { return run(name, 'readonly', function (s) { return s.get(id); }); },
    put: function (name, obj) { return run(name, 'readwrite', function (s) { return s.put(obj); }).then(function () { return obj; }); },
    del: function (name, id) { return run(name, 'readwrite', function (s) { return s.delete(id); }); },
    clear: function (name) { return run(name, 'readwrite', function (s) { return s.clear(); }); },
    putMany: function (name, list) {
      if (!list || !list.length) return Promise.resolve(0);
      return run(name, 'readwrite', function (s) {
        list.forEach(function (o) { s.put(o); });
        return s.count();
      });
    },
    clearAll: function () { return Promise.all(STORES.map(function (n) { return store.clear(n); })); },
    /** 各类数据条数，用于设置页统计 */
    counts: function () {
      const out = {};
      return STORES.reduce(function (chain, name) {
        return chain.then(function () {
          return run(name, 'readonly', function (s) { return s.count(); }).then(function (n) { out[name] = n; });
        });
      }, Promise.resolve()).then(function () { return out; });
    }
  };

  /* ------------------------------------------------------------------ *
   * 图片：解码 → 等比缩放 → 重新编码（默认最长边 1600px）
   * ------------------------------------------------------------------ */

  let preferredType = null;
  function pickEncodeType() {
    if (preferredType) return Promise.resolve(preferredType);
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (t) { if (!done) { done = true; preferredType = t; resolve(t); } };
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        c.toBlob(function (b) {
          finish(b && b.type === 'image/webp' ? 'image/webp' : 'image/jpeg');
        }, 'image/webp', 0.8);
      } catch (err) { finish('image/jpeg'); }
      setTimeout(function () { finish('image/jpeg'); }, 800); // 兜底
    });
  }

  function decode(file) {
    if (global.createImageBitmap) {
      return createImageBitmap(file).then(function (bmp) {
        return { source: bmp, width: bmp.width, height: bmp.height, release: function () { if (bmp.close) bmp.close(); } };
      }).catch(function () { return decodeViaTag(file); });
    }
    return decodeViaTag(file);
  }

  function decodeViaTag(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        resolve({
          source: img, width: img.naturalWidth, height: img.naturalHeight,
          release: function () { URL.revokeObjectURL(url); }
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取图片：' + (file.name || ''))); };
      img.src = url;
    });
  }

  /** 压缩图片，返回 { blob, width, height } */
  function compress(file, maxDim, quality) {
    const limit = maxDim || 1600;
    const q = quality || 0.85;
    return decode(file).then(function (decoded) {
      const scale = Math.min(1, limit / Math.max(decoded.width, decoded.height));
      const w = Math.max(1, Math.round(decoded.width * scale));
      const h = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      return pickEncodeType().then(function (type) {
        if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(decoded.source, 0, 0, w, h);
        decoded.release();
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('图片编码失败')); return; }
            resolve({ blob: blob, width: w, height: h });
          }, type, q);
        });
      });
    });
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataUrl) {
    const text = String(dataUrl || '');
    const comma = text.indexOf(',');
    if (comma < 0) throw new Error('备份里的图片数据已损坏');
    const head = text.slice(0, comma);
    const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const binary = atob(text.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /* objectURL 缓存，避免重复创建 */
  const urlCache = new Map();

  const image = {
    compress: compress,
    /** 压缩并写入数据库，返回图片记录 */
    add: function (file) {
      return compress(file).then(function (out) {
        const rec = {
          id: UI.uid('img'),
          name: file.name || '未命名图片',
          type: out.blob.type || 'image/jpeg',
          width: out.width,
          height: out.height,
          size: out.blob.size,
          blob: out.blob,
          createdAt: Date.now()
        };
        return store.put('images', rec).then(function () { return rec; });
      });
    },
    url: function (id) {
      if (urlCache.has(id)) return Promise.resolve(urlCache.get(id));
      return store.get('images', id).then(function (rec) {
        if (!rec || !rec.blob) return '';
        const url = URL.createObjectURL(rec.blob);
        urlCache.set(id, url);
        return url;
      });
    },
    drop: function (id) {
      const url = urlCache.get(id);
      if (url) { URL.revokeObjectURL(url); urlCache.delete(id); }
      return store.del('images', id);
    },
    clearCache: function () {
      urlCache.forEach(function (url) { URL.revokeObjectURL(url); });
      urlCache.clear();
    }
  };

  /* ------------------------------------------------------------------ *
   * 导入导出
   * ------------------------------------------------------------------ */

  function exportAll(options) {
    const withImages = !options || options.includeImages !== false;
    const payload = {
      app: APP_TAG,
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      tasks: [], tiers: [], items: [], images: []
    };
    return store.all('tasks').then(function (rows) { payload.tasks = rows; })
      .then(function () { return store.all('tiers'); }).then(function (rows) { payload.tiers = rows; })
      .then(function () { return store.all('items'); }).then(function (rows) { payload.items = rows; })
      .then(function () {
        if (!withImages) return null;
        return store.all('images').then(function (rows) {
          return Promise.all(rows.map(function (r) {
            return blobToDataURL(r.blob).then(function (dataUrl) {
              return {
                id: r.id, name: r.name, type: r.type, width: r.width, height: r.height,
                size: r.size, createdAt: r.createdAt, dataUrl: dataUrl
              };
            });
          }));
        }).then(function (rows) { payload.images = rows; });
      })
      .then(function () { return payload; });
  }

  /** 校验并规范化备份内容 */
  function normalize(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('备份文件内容无法解析');
    if (payload.app !== APP_TAG) throw new Error('这不是 LifeBoard 的备份文件');
    const str = function (v, fallback) { return typeof v === 'string' && v ? v : (fallback || ''); };
    const num = function (v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; };

    const tasks = (Array.isArray(payload.tasks) ? payload.tasks : []).map(function (t) {
      return {
        id: str(t && t.id) || UI.uid('task'),
        date: /^\d{4}-\d{2}-\d{2}$/.test(t && t.date) ? t.date : UI.todayKey(),
        title: str(t && t.title, '（无标题）').slice(0, 500),
        note: str(t && t.note).slice(0, 5000),
        done: !!(t && t.done),
        priority: Math.min(2, Math.max(0, Math.round(num(t && t.priority, 0)))),
        createdAt: num(t && t.createdAt, Date.now()),
        updatedAt: num(t && t.updatedAt, Date.now())
      };
    });

    const tiers = (Array.isArray(payload.tiers) ? payload.tiers : []).map(function (g, i) {
      return {
        id: str(g && g.id) || UI.uid('tier'),
        name: str(g && g.name, '未命名档位').slice(0, 40),
        color: /^#[0-9a-fA-F]{3,8}$/.test(g && g.color) ? g.color : '#9aa4b2',
        order: num(g && g.order, i)
      };
    });

    const tierIds = new Set(tiers.map(function (g) { return g.id; }));
    const items = (Array.isArray(payload.items) ? payload.items : []).map(function (it, i) {
      const tierId = it && typeof it.tierId === 'string' && tierIds.has(it.tierId) ? it.tierId : null;
      return {
        id: str(it && it.id) || UI.uid('item'),
        imageId: str(it && it.imageId),
        tierId: tierId,
        name: str(it && it.name, '未命名').slice(0, 200),
        stars: Math.min(5, Math.max(0, Math.round(num(it && it.stars, 0)))),
        comment: str(it && it.comment).slice(0, 5000),
        order: num(it && it.order, i),
        w: num(it && it.w, 0),
        h: num(it && it.h, 0),
        createdAt: num(it && it.createdAt, Date.now()),
        updatedAt: num(it && it.updatedAt, Date.now())
      };
    }).filter(function (it) { return it.imageId; });

    const images = (Array.isArray(payload.images) ? payload.images : []).map(function (im) {
      if (!im || typeof im.dataUrl !== 'string') return null;
      try {
        const blob = dataURLToBlob(im.dataUrl);
        return {
          id: str(im.id) || UI.uid('img'),
          name: str(im.name, '未命名图片'),
          type: str(im.type, blob.type || 'image/jpeg'),
          width: num(im.width, 0),
          height: num(im.height, 0),
          size: blob.size,
          blob: blob,
          createdAt: num(im.createdAt, Date.now())
        };
      } catch (err) { return null; }
    }).filter(Boolean);

    // 丢掉指向缺失图片的卡片，避免出现空白卡片
    const imageIds = new Set(images.map(function (im) { return im.id; }));
    const keepAllRefs = images.length === 0; // 不含图片的备份：保留卡片，图片可能已在库里
    const usable = keepAllRefs ? items : items.filter(function (it) { return imageIds.has(it.imageId); });

    return { tasks: tasks, tiers: tiers, items: usable, images: images, dropped: items.length - usable.length };
  }

  /**
   * 导入备份
   * @param {object} payload 导出的 JSON
   * @param {'merge'|'replace'} mode
   */
  function importAll(payload, mode) {
    let data;
    try { data = normalize(payload); }
    catch (err) { return Promise.reject(err); }

    const prep = mode === 'replace' ? store.clearAll() : Promise.resolve();
    return prep.then(function () {
      return store.putMany('images', data.images);
    }).then(function () {
      return store.putMany('tasks', data.tasks);
    }).then(function () {
      return store.putMany('tiers', data.tiers);
    }).then(function () {
      return store.putMany('items', data.items);
    }).then(function () {
      image.clearCache();
      return {
        tasks: data.tasks.length,
        tiers: data.tiers.length,
        items: data.items.length,
        images: data.images.length,
        dropped: data.dropped
      };
    });
  }

  global.LB = global.LB || {};
  global.LB.store = store;
  global.LB.image = image;
  global.LB.exportAll = exportAll;
  global.LB.importAll = importAll;
  global.LB.normalize = normalize;
  global.LB.APP_TAG = APP_TAG;
})(window);
