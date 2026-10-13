/* LifeBoard · 数据层
 * IndexedDB 封装 + 图片压缩 + 导入导出。无外部依赖。
 * 挂在 window.LB.store / window.LB.image 上。
 *
 * 数据模型（schema 3）
 *   boards     { id, name, order, createdAt, updatedAt }
 *   tasks      { id, date:'YYYY-MM-DD', title, note, done, priority:0|1|2, createdAt, updatedAt }
 *   templates  { id, title, note, priority, useCount, createdAt, updatedAt }   常用任务
 *   tiers      { id, boardId, name, color, order, updatedAt }
 *   items      { id, boardId, imageId, tierId, name, stars, comment, order, w, h, createdAt, updatedAt }
 *   images     { id, name, type, width, height, size, blob, createdAt, updatedAt }
 *   tombstones { id:'<store>|<recordId>', store, recordId, deletedAt }        删除记录
 *
 * 关于墓碑：局域网同步靠 updatedAt 判断谁新，但"删除"没有记录可比，
 * 所以每次删除都留一条墓碑。没有它，在手机删掉的东西会被电脑上的旧记录复活。
 *
 * 版本历史
 *   v1 → v2  新增 boards / templates
 *   v2 → v3  新增 tombstones；put/putMany 统一盖 updatedAt
 */
(function (global) {
  'use strict';

  const DB_NAME = 'lifeboard';
  const DB_VERSION = 3;
  const STORES = ['boards', 'tasks', 'templates', 'tiers', 'items', 'images', 'tombstones'];
  const DATA_STORES = ['boards', 'tasks', 'templates', 'tiers', 'items', 'images'];
  const APP_TAG = 'lifeboard';
  const SCHEMA = 3;

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

  function tombstoneId(name, id) { return name + '|' + id; }

  /**
   * 墓碑的时间戳。
   * 必须比它删掉的那条记录新，否则合并时会被判成"墓碑比记录旧"而失效。
   * 两台设备的时钟不一定一致，所以取 max(现在, 记录时间 + 1) 而不是直接用现在。
   */
  function tombstoneWhen(rec, floor) {
    const base = Number(rec && (rec.updatedAt || rec.createdAt)) || 0;
    return Math.max(Number(floor) || Date.now(), base + 1);
  }

  const store = {
    all: function (name) { return run(name, 'readonly', function (s) { return s.getAll(); }); },
    get: function (name, id) { return run(name, 'readonly', function (s) { return s.get(id); }); },

    /** 写入并盖上 updatedAt（同步靠它判断新旧）。opts.keepUpdatedAt 用于导入/同步回写。 */
    put: function (name, obj, opts) {
      if (!(opts && opts.keepUpdatedAt)) obj.updatedAt = Date.now();
      return run(name, 'readwrite', function (s) { return s.put(obj); }).then(function () { return obj; });
    },

    /** 删除并留墓碑。opts.silent 用于"应用远端删除"，不重复记一笔。 */
    del: function (name, id, opts) {
      const doDelete = function () { return run(name, 'readwrite', function (s) { return s.delete(id); }); };
      if ((opts && opts.silent) || name === 'tombstones') return doDelete();
      // 先读一下被删的记录，墓碑时间要压过它
      return run(name, 'readonly', function (s) { return s.get(id); }).then(function (rec) {
        return run('tombstones', 'readwrite', function (s) {
          return s.put({
            id: tombstoneId(name, id), store: name, recordId: id,
            deletedAt: tombstoneWhen(rec)
          });
        });
      }).then(doDelete);
    },

    delMany: function (name, ids) {
      if (!ids || !ids.length) return Promise.resolve(0);
      return run(name, 'readwrite', function (s) {
        ids.forEach(function (id) { s.delete(id); });
        return s.count();
      });
    },

    clear: function (name) { return run(name, 'readwrite', function (s) { return s.clear(); }); },

    putMany: function (name, list, opts) {
      if (!list || !list.length) return Promise.resolve(0);
      if (!(opts && opts.keepUpdatedAt)) {
        const now = Date.now();
        list.forEach(function (o) { if (o) o.updatedAt = now; });
      }
      return run(name, 'readwrite', function (s) {
        list.forEach(function (o) { s.put(o); });
        return s.count();
      });
    },

    /** 只清空数据，保留墓碑（同步时才能把删除传到另一边） */
    clearData: function () {
      return Promise.all(DATA_STORES.map(function (n) { return store.clear(n); }));
    },

    /** 清空全部（含墓碑），用于"彻底重来" */
    clearAll: function () { return Promise.all(STORES.map(function (n) { return store.clear(n); })); },

    /**
     * 清空用户数据：先给每条记录写墓碑，再清空。
     * 这样下次同步会把删除动作传到另一台设备，而不是被它的旧数据复活。
     */
    wipeAll: function () {
      return Promise.all(DATA_STORES.map(function (name) {
        return store.all(name).then(function (rows) {
          if (!rows.length) return 0;
          return store.putMany('tombstones', rows.map(function (r) {
            return {
              id: tombstoneId(name, r.id), store: name, recordId: r.id,
              deletedAt: tombstoneWhen(r)
            };
          }), { keepUpdatedAt: true });
        });
      })).then(function () {
        return store.clearData();
      });
    },

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
      setTimeout(function () { finish('image/jpeg'); }, 800);
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
    if (comma < 0) throw new Error('图片数据已损坏');
    const head = text.slice(0, comma);
    const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const binary = atob(text.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  const urlCache = new Map();

  const image = {
    compress: compress,
    blobToDataURL: blobToDataURL,
    dataURLToBlob: dataURLToBlob,

    add: function (file) {
      return compress(file).then(function (out) {
        const now = Date.now();
        const rec = {
          id: UI.uid('img'),
          name: file.name || '未命名图片',
          type: out.blob.type || 'image/jpeg',
          width: out.width,
          height: out.height,
          size: out.blob.size,
          blob: out.blob,
          createdAt: now,
          updatedAt: now
        };
        return run('images', 'readwrite', function (s) { return s.put(rec); }).then(function () { return rec; });
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

    /** 取图片本体，转成 dataURL（同步上传用） */
    dataURL: function (id) {
      return store.get('images', id).then(function (rec) {
        if (!rec || !rec.blob) return null;
        return blobToDataURL(rec.blob);
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
      boards: [], tasks: [], templates: [], tiers: [], items: [], images: [], tombstones: []
    };
    return store.all('boards').then(function (rows) { payload.boards = rows; })
      .then(function () { return store.all('tasks'); }).then(function (rows) { payload.tasks = rows; })
      .then(function () { return store.all('templates'); }).then(function (rows) { payload.templates = rows; })
      .then(function () { return store.all('tiers'); }).then(function (rows) { payload.tiers = rows; })
      .then(function () { return store.all('items'); }).then(function (rows) { payload.items = rows; })
      .then(function () { return store.all('tombstones'); }).then(function (rows) { payload.tombstones = rows; })
      .then(function () {
        if (!withImages) return null;
        return store.all('images').then(function (rows) {
          return Promise.all(rows.filter(function (r) { return r.blob; }).map(function (r) {
            return blobToDataURL(r.blob).then(function (dataUrl) {
              return {
                id: r.id, name: r.name, type: r.type, width: r.width, height: r.height,
                size: r.size, createdAt: r.createdAt, updatedAt: r.updatedAt, dataUrl: dataUrl
              };
            });
          }));
        }).then(function (rows) { payload.images = rows; });
      })
      .then(function () { return payload; });
  }

  /** 校验并规范化备份内容（schema 1 / 2 的老备份同样接受） */
  function normalize(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('备份文件内容无法解析');
    if (payload.app !== APP_TAG) throw new Error('这不是 LifeBoard 的备份文件');
    const str = function (v, fallback) { return typeof v === 'string' && v ? v : (fallback || ''); };
    const num = function (v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; };

    const boards = (Array.isArray(payload.boards) ? payload.boards : []).map(function (b, i) {
      const created = num(b && b.createdAt, Date.now());
      return {
        id: str(b && b.id) || UI.uid('board'),
        name: str(b && b.name, '未命名榜单').slice(0, 60),
        order: num(b && b.order, i),
        createdAt: created,
        updatedAt: num(b && b.updatedAt, created)
      };
    });
    const boardIds = new Set(boards.map(function (b) { return b.id; }));
    const boardOf = function (v) {
      const id = str(v);
      return id && boardIds.has(id) ? id : null;
    };

    const tasks = (Array.isArray(payload.tasks) ? payload.tasks : []).map(function (t) {
      const created = num(t && t.createdAt, Date.now());
      return {
        id: str(t && t.id) || UI.uid('task'),
        date: /^\d{4}-\d{2}-\d{2}$/.test(t && t.date) ? t.date : UI.todayKey(),
        title: str(t && t.title, '（无标题）').slice(0, 500),
        note: str(t && t.note).slice(0, 5000),
        done: !!(t && t.done),
        priority: Math.min(2, Math.max(0, Math.round(num(t && t.priority, 0)))),
        createdAt: created,
        updatedAt: num(t && t.updatedAt, created)
      };
    });

    const templates = (Array.isArray(payload.templates) ? payload.templates : []).map(function (t) {
      const created = num(t && t.createdAt, Date.now());
      return {
        id: str(t && t.id) || UI.uid('tpl'),
        title: str(t && t.title).slice(0, 200),
        note: str(t && t.note).slice(0, 5000),
        priority: Math.min(2, Math.max(0, Math.round(num(t && t.priority, 0)))),
        useCount: Math.max(0, Math.round(num(t && t.useCount, 0))),
        createdAt: created,
        updatedAt: num(t && t.updatedAt, created)
      };
    }).filter(function (t) { return t.title; });

    const tiers = (Array.isArray(payload.tiers) ? payload.tiers : []).map(function (g, i) {
      const created = num(g && g.createdAt, Date.now());
      return {
        id: str(g && g.id) || UI.uid('tier'),
        boardId: boardOf(g && g.boardId),
        name: str(g && g.name, '未命名档位').slice(0, 40),
        color: /^#[0-9a-fA-F]{3,8}$/.test(g && g.color) ? g.color : '#9aa4b2',
        order: num(g && g.order, i),
        updatedAt: num(g && g.updatedAt, created)
      };
    });

    const tierIds = new Set(tiers.map(function (g) { return g.id; }));
    const items = (Array.isArray(payload.items) ? payload.items : []).map(function (it, i) {
      const created = num(it && it.createdAt, Date.now());
      const tierId = it && typeof it.tierId === 'string' && tierIds.has(it.tierId) ? it.tierId : null;
      return {
        id: str(it && it.id) || UI.uid('item'),
        boardId: boardOf(it && it.boardId),
        imageId: str(it && it.imageId),
        tierId: tierId,
        name: str(it && it.name, '未命名').slice(0, 200),
        stars: Math.min(5, Math.max(0, Math.round(num(it && it.stars, 0)))),
        comment: str(it && it.comment).slice(0, 5000),
        order: num(it && it.order, i),
        w: num(it && it.w, 0),
        h: num(it && it.h, 0),
        createdAt: created,
        updatedAt: num(it && it.updatedAt, created)
      };
    }).filter(function (it) { return it.imageId; });

    const images = (Array.isArray(payload.images) ? payload.images : []).map(function (im) {
      if (!im || typeof im.dataUrl !== 'string') return null;
      try {
        const blob = dataURLToBlob(im.dataUrl);
        const created = num(im.createdAt, Date.now());
        return {
          id: str(im.id) || UI.uid('img'),
          name: str(im.name, '未命名图片'),
          type: str(im.type, blob.type || 'image/jpeg'),
          width: num(im.width, 0),
          height: num(im.height, 0),
          size: blob.size,
          blob: blob,
          createdAt: created,
          updatedAt: num(im.updatedAt, created)
        };
      } catch (err) { return null; }
    }).filter(Boolean);

    const imageIds = new Set(images.map(function (im) { return im.id; }));
    const keepAllRefs = images.length === 0;   // 不含图片的备份：保留卡片，图片可能已在库里
    const usable = keepAllRefs ? items : items.filter(function (it) { return imageIds.has(it.imageId); });

    const tombstones = (Array.isArray(payload.tombstones) ? payload.tombstones : []).map(function (t) {
      const name = str(t && t.store);
      const rid = str(t && t.recordId);
      if (!name || !rid || DATA_STORES.indexOf(name) < 0) return null;
      return {
        id: tombstoneId(name, rid),
        store: name,
        recordId: rid,
        deletedAt: num(t && t.deletedAt, Date.now())
      };
    }).filter(Boolean);

    return {
      boards: boards, tasks: tasks, templates: templates, tiers: tiers,
      items: usable, images: images, tombstones: tombstones,
      dropped: items.length - usable.length
    };
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

    const prep = mode === 'replace'
      ? Promise.all(DATA_STORES.map(function (name) {
        return store.all(name).then(function (rows) {
          const incomingIds = new Set((data[name] || []).map(function (r) { return r.id; }));
          const gone = rows.filter(function (r) { return !incomingIds.has(r.id); });
          if (!gone.length) return 0;
          return store.putMany('tombstones', gone.map(function (r) {
            return {
              id: tombstoneId(name, r.id), store: name, recordId: r.id,
              deletedAt: tombstoneWhen(r)
            };
          }), { keepUpdatedAt: true });
        });
      })).then(function () { return store.clearData(); })
      : Promise.resolve();

    return prep.then(function () {
      // 明确写回来的记录，要把对应的墓碑撤掉，否则会被当成已删除
      const tombIds = [];
      DATA_STORES.forEach(function (name) {
        (data[name] || []).forEach(function (r) { tombIds.push(tombstoneId(name, r.id)); });
      });
      return store.delMany('tombstones', tombIds);
    }).then(function () {
      return store.putMany('images', data.images, { keepUpdatedAt: true });
    }).then(function () {
      return store.putMany('boards', data.boards, { keepUpdatedAt: true });
    }).then(function () {
      return store.putMany('tasks', data.tasks, { keepUpdatedAt: true });
    }).then(function () {
      return store.putMany('templates', data.templates, { keepUpdatedAt: true });
    }).then(function () {
      return store.putMany('tiers', data.tiers, { keepUpdatedAt: true });
    }).then(function () {
      return store.putMany('items', data.items, { keepUpdatedAt: true });
    }).then(function () {
      return store.putMany('tombstones', data.tombstones, { keepUpdatedAt: true });
    }).then(function () {
      image.clearCache();
      return {
        boards: data.boards.length,
        tasks: data.tasks.length,
        templates: data.templates.length,
        tiers: data.tiers.length,
        items: data.items.length,
        images: data.images.length,
        tombstones: data.tombstones.length,
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
  global.LB.SCHEMA = SCHEMA;
  global.LB.DATA_STORES = DATA_STORES;
})(window);
