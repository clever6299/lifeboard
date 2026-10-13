/* LifeBoard · 夯 → 拉 榜（图片分级 + 五星评分） */
(function (global) {
  'use strict';

  const DEFAULT_TIERS = [
    { name: '夯', color: '#ff7a59' },
    { name: '顶级', color: '#ffa94d' },
    { name: '人上人', color: '#ffd43b' },
    { name: 'NPC', color: '#a5d8ff' },
    { name: '拉', color: '#8b98a5' }
  ];
  const PALETTE = ['#ff7a59', '#ffa94d', '#ffd43b', '#b2f2bb', '#a5d8ff', '#d0bfff', '#ffc9de', '#8b98a5', '#63e6be', '#ff8787'];

  const state = {
    tiers: [],
    items: [],
    urls: {},               // imageId -> objectURL
    view: 'board',
    dragId: null,
    currentItemId: null,
    ready: false
  };

  const el = {};

  function cacheEls() {
    el.board = UI.$('#tierBoard');
    el.table = UI.$('#tierTable');
    el.stats = UI.$('#tierStats');
    el.fileInput = UI.$('#fileInput');
    el.modalBody = UI.$('#itemModalBody');
  }

  /* ---------------- 数据 ---------------- */

  function sortTiers(a, b) { return a.order - b.order || String(a.name).localeCompare(String(b.name)); }
  function sortItems(a, b) { return a.order - b.order || a.createdAt - b.createdAt; }
  function tierById(id) { return state.tiers.find(function (t) { return t.id === id; }) || null; }
  function itemById(id) { return state.items.find(function (t) { return t.id === id; }) || null; }
  function nextOrder(tierId) {
    const list = state.items.filter(function (i) { return i.tierId === (tierId || null); });
    return list.length ? Math.max.apply(null, list.map(function (i) { return i.order; })) + 1 : 1;
  }
  function itemsOf(tierId) {
    return state.items.filter(function (i) { return i.tierId === (tierId || null); }).sort(sortItems);
  }

  function ensureTiers() {
    return LB.store.all('tiers').then(function (rows) {
      if (rows && rows.length) { state.tiers = rows.sort(sortTiers); return null; }
      const seeded = DEFAULT_TIERS.map(function (t, i) {
        return { id: UI.uid('tier'), name: t.name, color: t.color, order: i };
      });
      state.tiers = seeded;
      return LB.store.putMany('tiers', seeded);
    });
  }

  function resolveUrls() {
    const ids = [];
    state.items.forEach(function (it) { if (ids.indexOf(it.imageId) < 0) ids.push(it.imageId); });
    return Promise.all(ids.map(function (id) {
      return LB.image.url(id).then(function (url) { if (url) state.urls[id] = url; });
    }));
  }

  function reload() {
    return ensureTiers()
      .then(function () { return LB.store.all('items'); })
      .then(function (rows) { state.items = (rows || []).sort(sortItems); return resolveUrls(); })
      .then(function () { render(); });
  }

  function saveItem(item) {
    item.updatedAt = Date.now();
    return LB.store.put('items', item);
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!el.board) return;
    renderBoard();
    renderTable();
    renderStats();
  }

  function cardHTML(item) {
    const url = state.urls[item.imageId];
    const media = url
      ? '<img src="' + url + '" alt="" loading="lazy" draggable="false" />'
      : '<div class="c-media-missing">图片缺失</div>';
    return '<div class="card" draggable="true" data-item="' + item.id + '" title="' + UI.esc(item.name) + '">' +
      media +
      '<div class="c-body">' +
        '<div class="c-name">' + UI.esc(item.name || '未命名') + '</div>' +
        '<div class="c-stars">' + UI.starsHTML(item.stars) + '</div>' +
        (item.comment ? '<div class="c-comment">' + UI.esc(item.comment) + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function rowHTML(tier) {
    // tier 为 null 时表示「未分档」
    const isPool = !tier;
    const list = itemsOf(isPool ? null : tier.id);
    const label = isPool
      ? '<div class="tier-label" style="background:#2b333f;color:#c6d0dc">' +
          '<span class="tl-name">未分档</span>' +
          '<span class="tl-count">' + list.length + ' 张</span>' +
        '</div>'
      : '<div class="tier-label" style="background:' + UI.esc(tier.color) + '">' +
          '<span class="tl-name" data-tier-name="' + tier.id + '" title="点击改名">' + UI.esc(tier.name) + '</span>' +
          '<span class="tl-count">' + list.length + ' 张</span>' +
          '<span class="tl-tools">' +
            '<button type="button" data-tier-act="color" data-tier="' + tier.id + '" title="改颜色">色</button>' +
            '<button type="button" data-tier-act="up" data-tier="' + tier.id + '" title="上移">↑</button>' +
            '<button type="button" data-tier-act="down" data-tier="' + tier.id + '" title="下移">↓</button>' +
            '<button type="button" data-tier-act="del" data-tier="' + tier.id + '" title="删除档位">删</button>' +
          '</span>' +
        '</div>';

    return '<section class="tier-row' + (isPool ? ' pool' : '') + '" data-tier-row="' + (isPool ? '' : tier.id) + '">' +
      label +
      '<div class="tier-items" data-tier-items="' + (isPool ? '' : tier.id) + '">' +
        (list.length ? list.map(cardHTML).join('') : '<span class="tier-empty">把图片拖到这里</span>') +
      '</div>' +
    '</section>';
  }

  function renderBoard() {
    const tiers = state.tiers.slice().sort(sortTiers);
    el.board.innerHTML = rowHTML(null) + tiers.map(rowHTML).join('');
  }

  function renderTable() {
    if (state.view !== 'table') return;
    const order = new Map();
    state.tiers.slice().sort(sortTiers).forEach(function (t, i) { order.set(t.id, i); });

    const rows = state.items.slice().sort(function (a, b) {
      if (b.stars !== a.stars) return b.stars - a.stars;
      const oa = a.tierId ? order.get(a.tierId) : 999;
      const ob = b.tierId ? order.get(b.tierId) : 999;
      if (oa !== ob) return oa - ob;
      return a.createdAt - b.createdAt;
    });

    if (!rows.length) {
      el.table.innerHTML = '<p class="empty muted">还没有图片，点上方的「上传图片」开始吧。</p>';
      return;
    }

    el.table.innerHTML = '<table class="tier-table"><thead><tr>' +
      '<th>图片</th><th>名称</th><th>评分</th><th>档位</th><th>评语</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map(function (item) {
        const url = state.urls[item.imageId];
        const tier = item.tierId ? tierById(item.tierId) : null;
        return '<tr data-item="' + item.id + '">' +
          '<td>' + (url ? '<img src="' + url + '" alt="" loading="lazy" />' : '<span class="muted small">缺失</span>') + '</td>' +
          '<td>' + UI.esc(item.name || '未命名') + '</td>' +
          '<td class="tt-stars">' + UI.starsHTML(item.stars) + '<span class="muted small"> ' + item.stars + '/5</span></td>' +
          '<td>' + (tier
            ? '<span class="tt-tier" style="background:' + UI.esc(tier.color) + '">' + UI.esc(tier.name) + '</span>'
            : '<span class="muted small">未分档</span>') + '</td>' +
          '<td class="tt-comment">' + UI.esc(item.comment || '—') + '</td>' +
          '<td><button class="btn small" type="button" data-open="' + item.id + '">编辑</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function renderStats() {
    if (!el.stats) return;
    const total = state.items.length;
    if (!total) { el.stats.textContent = '还没有图片'; return; }
    const rated = state.items.filter(function (i) { return i.stars > 0; });
    const avg = rated.length
      ? (rated.reduce(function (s, i) { return s + i.stars; }, 0) / rated.length).toFixed(1)
      : '—';
    el.stats.textContent = '共 ' + total + ' 张 · 已评分 ' + rated.length + ' 张 · 平均 ' + avg + ' 星';
  }

  /* ---------------- 图片详情弹窗 ---------------- */

  function openItem(id) {
    const item = itemById(id);
    if (!item) return;
    state.currentItemId = id;
    const url = state.urls[item.imageId];
    const tierOptions = ['<option value="">未分档</option>'].concat(
      state.tiers.slice().sort(sortTiers).map(function (t) {
        return '<option value="' + t.id + '"' + (item.tierId === t.id ? ' selected' : '') + '>' + UI.esc(t.name) + '</option>';
      })
    ).join('');

    el.modalBody.innerHTML =
      '<div class="item-detail">' +
        '<div class="preview">' + (url ? '<img src="' + url + '" alt="" />' : '<span class="muted">图片缺失</span>') + '</div>' +
        '<div class="fields">' +
          '<div class="field"><label>名称</label>' +
            '<input type="text" id="itName" maxlength="200" value="' + UI.esc(item.name) + '" /></div>' +
          '<div class="field"><label>评分</label>' +
            '<div class="stars" id="itStars">' +
              [1, 2, 3, 4, 5].map(function (n) {
                return '<button type="button" data-star="' + n + '" class="' + (n <= item.stars ? 'on' : '') + '" aria-label="' + n + ' 星">★</button>';
              }).join('') +
              '<button type="button" class="btn ghost small" data-star="0" style="margin-left:6px">清零</button>' +
              '<span class="val" id="itStarsVal">' + item.stars + ' / 5</span>' +
            '</div></div>' +
          '<div class="field"><label>档位</label>' +
            '<select id="itTier">' + tierOptions + '</select></div>' +
          '<div class="field"><label>评语</label>' +
            '<textarea id="itComment" rows="4" maxlength="5000" placeholder="想吐槽点什么…">' + UI.esc(item.comment) + '</textarea></div>' +
          '<div class="row">' +
            '<button class="btn" type="button" id="itPrev">← 前一张</button>' +
            '<button class="btn" type="button" id="itNext">后一张 →</button>' +
            '<div class="spacer"></div>' +
            '<button class="btn danger" type="button" id="itDel">删除</button>' +
          '</div>' +
          '<p class="muted small">改动会自动保存。' +
            (item.w ? ' 图片尺寸 ' + item.w + '×' + item.h : '') +
          '</p>' +
        '</div>' +
      '</div>';

    bindItemModal(item);
    UI.openModal('itemModal');
  }

  function bindItemModal(item) {
    const nameInput = UI.$('#itName');
    const commentInput = UI.$('#itComment');
    const tierSelect = UI.$('#itTier');
    const starsVal = UI.$('#itStarsVal');

    nameInput.addEventListener('change', function () {
      item.name = nameInput.value.trim() || '未命名';
      nameInput.value = item.name;
      saveItem(item).then(render);
    });
    commentInput.addEventListener('change', function () {
      item.comment = commentInput.value.trim();
      saveItem(item).then(render);
    });
    tierSelect.addEventListener('change', function () {
      const next = tierSelect.value || null;
      item.tierId = next;
      item.order = nextOrder(next);
      saveItem(item).then(render);
    });

    UI.$('#itStars').addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-star]');
      if (!btn) return;
      item.stars = parseInt(btn.dataset.star, 10) || 0;
      UI.$$('#itStars [data-star]').forEach(function (b) {
        const v = parseInt(b.dataset.star, 10);
        if (v > 0) b.classList.toggle('on', v <= item.stars);
      });
      starsVal.textContent = item.stars + ' / 5';
      saveItem(item).then(render);
    });

    UI.$('#itDel').addEventListener('click', function () {
      if (!confirm('删除「' + item.name + '」？图片也会从本机删除。')) return;
      UI.closeModal('itemModal');
      LB.image.drop(item.imageId).catch(function () {});
      delete state.urls[item.imageId];
      state.items = state.items.filter(function (i) { return i.id !== item.id; });
      LB.store.del('items', item.id).then(render).catch(function (err) { UI.toast('删除失败：' + err.message, 'err'); });
    });

    function step(delta) {
      const list = state.items.slice().sort(sortItems);
      const idx = list.findIndex(function (i) { return i.id === item.id; });
      const next = list[(idx + delta + list.length) % list.length];
      if (next) openItem(next.id);
    }
    UI.$('#itPrev').addEventListener('click', function () { step(-1); });
    UI.$('#itNext').addEventListener('click', function () { step(1); });
  }

  /* ---------------- 拖拽 ---------------- */

  function moveItem(itemId, tierId, beforeId) {
    const item = itemById(itemId);
    if (!item) return Promise.resolve();
    const target = tierId || null;
    const siblings = state.items
      .filter(function (i) { return i.tierId === target && i.id !== itemId; })
      .sort(sortItems);

    let order;
    if (beforeId) {
      const idx = siblings.findIndex(function (s) { return s.id === beforeId; });
      if (idx < 0) order = nextOrder(target);
      else if (idx === 0) order = (siblings[0].order || 1) - 1;
      else order = (siblings[idx - 1].order + siblings[idx].order) / 2;
    } else {
      order = nextOrder(target);
    }

    item.tierId = target;
    item.order = order;
    return saveItem(item).then(render);
  }

  function clearDropMarks() {
    UI.$$('.tier-row.dragover', el.board).forEach(function (r) { r.classList.remove('dragover'); });
    UI.$$('.card.drop-before', el.board).forEach(function (c) { c.classList.remove('drop-before'); });
  }

  function bindBoard() {
    el.board.addEventListener('dragstart', function (ev) {
      const card = ev.target.closest('.card');
      if (!card) return;
      state.dragId = card.dataset.item;
      card.classList.add('dragging');
      try {
        ev.dataTransfer.setData('text/plain', state.dragId);
        ev.dataTransfer.effectAllowed = 'move';
      } catch (err) { /* 忽略 */ }
    });

    el.board.addEventListener('dragend', function () {
      state.dragId = null;
      UI.$$('.card.dragging', el.board).forEach(function (c) { c.classList.remove('dragging'); });
      clearDropMarks();
    });

    el.board.addEventListener('dragover', function (ev) {
      const row = ev.target.closest('.tier-row');
      if (!row || !state.dragId) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      row.classList.add('dragover');
      const card = ev.target.closest('.card');
      if (card && card.dataset.item !== state.dragId) card.classList.add('drop-before');
    });

    el.board.addEventListener('drop', function (ev) {
      const row = ev.target.closest('.tier-row');
      if (!row || !state.dragId) return;
      ev.preventDefault();
      const card = ev.target.closest('.card');
      const tierId = row.dataset.tierRow || null;
      const beforeId = card && card.dataset.item !== state.dragId ? card.dataset.item : null;
      const moving = state.dragId;
      state.dragId = null;
      clearDropMarks();
      moveItem(moving, tierId, beforeId);
    });

    // 点击卡片 → 详情（表格视图里的按钮也走这里）
    el.board.addEventListener('click', function (ev) {
      const card = ev.target.closest('.card');
      if (card) { openItem(card.dataset.item); return; }
      const act = ev.target.closest('[data-tier-act]');
      if (act) { tierAction(act.dataset.tierAct, act.dataset.tier); return; }
      const nameEl = ev.target.closest('[data-tier-name]');
      if (nameEl) { inlineRenameTier(nameEl); }
    });

    el.table.addEventListener('click', function (ev) {
      const row = ev.target.closest('[data-item]');
      if (row) openItem(row.dataset.item);
    });
  }

  /* ---------------- 档位操作 ---------------- */

  function inlineRenameTier(nameEl) {
    const tier = tierById(nameEl.dataset.tierName);
    if (!tier) return;
    nameEl.contentEditable = 'true';
    nameEl.style.outline = '2px solid rgba(0,0,0,.35)';
    nameEl.style.borderRadius = '5px';
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = global.getSelection();
    sel.removeAllRanges(); sel.addRange(range);

    const finish = function (commit) {
      nameEl.contentEditable = 'false';
      const value = nameEl.textContent.trim().slice(0, 40);
      if (commit && value && value !== tier.name) {
        tier.name = value;
        LB.store.put('tiers', tier).then(render);
      } else {
        render();
      }
    };
    nameEl.addEventListener('blur', function () { finish(true); }, { once: true });
    nameEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); nameEl.textContent = tier.name; nameEl.blur(); }
    });
  }

  let colorPicker = null;
  function pickColor(current) {
    return new Promise(function (resolve) {
      if (!colorPicker) {
        colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.style.position = 'fixed';
        colorPicker.style.left = '-9999px';
        document.body.appendChild(colorPicker);
      }
      colorPicker.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : '#8b98a5';
      let settled = false;
      const done = function (value) { if (settled) return; settled = true; colorPicker.removeEventListener('change', onChange); resolve(value); };
      const onChange = function () { done(colorPicker.value); };
      colorPicker.addEventListener('change', onChange);
      colorPicker.click();
      setTimeout(function () { done(colorPicker.value); }, 20000);
    });
  }

  function tierAction(action, tierId) {
    const tier = tierById(tierId);
    if (!tier) return;
    const sorted = state.tiers.slice().sort(sortTiers);
    const idx = sorted.findIndex(function (t) { return t.id === tierId; });

    if (action === 'color') {
      pickColor(tier.color).then(function (color) {
        tier.color = color;
        return LB.store.put('tiers', tier).then(render);
      });
    } else if (action === 'up' && idx > 0) {
      const other = sorted[idx - 1];
      const tmp = tier.order; tier.order = other.order; other.order = tmp;
      return LB.store.putMany('tiers', [tier, other]).then(function () {
        state.tiers.sort(sortTiers); render();
      });
    } else if (action === 'down' && idx < sorted.length - 1) {
      const other = sorted[idx + 1];
      const tmp = tier.order; tier.order = other.order; other.order = tmp;
      return LB.store.putMany('tiers', [tier, other]).then(function () {
        state.tiers.sort(sortTiers); render();
      });
    } else if (action === 'del') {
      if (!confirm('删除档位「' + tier.name + '」？里面的图片会回到「未分档」。')) return;
      state.items.forEach(function (it) {
        if (it.tierId === tierId) { it.tierId = null; it.order = nextOrder(null); saveItem(it); }
      });
      state.tiers = state.tiers.filter(function (t) { return t.id !== tierId; });
      return LB.store.del('tiers', tierId).then(function () {
        state.items.sort(sortItems); render();
      });
    }
  }

  function addTier() {
    const name = prompt('新档位名称', '新档位');
    if (name === null) return;
    const clean = name.trim().slice(0, 40) || '新档位';
    const order = state.tiers.length ? Math.max.apply(null, state.tiers.map(function (t) { return t.order; })) + 1 : 0;
    const tier = {
      id: UI.uid('tier'),
      name: clean,
      color: PALETTE[state.tiers.length % PALETTE.length],
      order: order
    };
    state.tiers.push(tier);
    state.tiers.sort(sortTiers);
    LB.store.put('tiers', tier).then(render);
  }

  /* ---------------- 上传 ---------------- */

  function addFiles(fileList, targetTierId) {
    const files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /^image\//.test(f.type || '');
    });
    if (!files.length) { UI.toast('没有找到可用的图片文件', 'err'); return Promise.resolve(); }

    let done = 0;
    let failed = 0;
    const tier = targetTierId || null;
    UI.busy(true, '正在处理图片 0/' + files.length + '…');

    let chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return LB.image.add(file);
      }).then(function (rec) {
        return LB.image.url(rec.id).then(function (url) {
          state.urls[rec.id] = url;
          const item = {
            id: UI.uid('item'),
            imageId: rec.id,
            tierId: tier,
            name: String(file.name || '未命名').replace(/\.[^.]+$/, '').slice(0, 200) || '未命名',
            stars: 0,
            comment: '',
            order: nextOrder(tier),
            w: rec.width,
            h: rec.height,
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          state.items.push(item);
          return LB.store.put('items', item);
        });
      }).catch(function (err) {
        failed++;
        console.warn('图片处理失败', file && file.name, err);
      }).then(function () {
        done++;
        const t = UI.$('#busyText');
        if (t) t.textContent = '正在处理图片 ' + done + '/' + files.length + '…';
      });
    });

    return chain.then(function () {
      UI.busy(false);
      state.items.sort(sortItems);
      render();
      if (failed) UI.toast('有 ' + failed + ' 张图片处理失败，其余已添加', 'err');
      else UI.toast('已添加 ' + files.length + ' 张图片', 'ok');
    }).catch(function (err) {
      UI.busy(false);
      render();
      UI.toast('图片处理失败：' + err.message, 'err');
    });
  }

  function bindPasteAndDrop() {
    document.addEventListener('paste', function (ev) {
      if (!document.getElementById('view-tier').classList.contains('active')) return;
      if (UI.$('#settingsModal') && !UI.$('#settingsModal').classList.contains('hidden')) return;
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        ev.preventDefault();
        addFiles(files, null);
      }
    });

    let depth = 0;
    document.addEventListener('dragenter', function (ev) {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
      if (!document.getElementById('view-tier').classList.contains('active')) return;
      depth++;
      el.board.classList.add('file-drop');
    });
    document.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.board.classList.remove('file-drop');
    });
    document.addEventListener('dragover', function (ev) {
      if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') >= 0) ev.preventDefault();
    });
    document.addEventListener('drop', function (ev) {
      depth = 0;
      el.board.classList.remove('file-drop');
      if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
      if (state.dragId) return; // 正在拖动卡片
      ev.preventDefault();
      const row = ev.target.closest ? ev.target.closest('.tier-row') : null;
      addFiles(ev.dataTransfer.files, row && row.dataset.tierRow ? row.dataset.tierRow : null);
    });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    cacheEls();
    bindBoard();
    bindPasteAndDrop();

    UI.$('#btnUpload').addEventListener('click', function () { el.fileInput.click(); });
    UI.$('#btnAddTier').addEventListener('click', addTier);
    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files.length) addFiles(el.fileInput.files, null);
      el.fileInput.value = '';
    });

    UI.$$('[data-tierview]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.view = btn.dataset.tierview;
        UI.$$('[data-tierview]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        el.board.classList.toggle('hidden', state.view !== 'board');
        el.table.classList.toggle('hidden', state.view !== 'table');
        if (state.view === 'table') renderTable();
      });
    });

    state.ready = true;
    return reload();
  }

  global.LB = global.LB || {};
  global.LB.tier = {
    init: init,
    reload: reload,
    render: render,
    addFiles: addFiles,
    state: state
  };
})(window);
