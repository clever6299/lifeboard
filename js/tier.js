/* LifeBoard · 夯 → 拉 榜（多榜单分类 + 图片分级 + 五星评分） */
(function (global) {
  'use strict';

  const DEFAULT_TIERS = [
    { name: '夯', color: '#ff7a59' },
    { name: '顶级', color: '#ffa94d' },
    { name: '人上人', color: '#ffd43b' },
    { name: 'NPC', color: '#a5d8ff' },
    { name: '拉', color: '#8b98a5' }
  ];
  const PALETTE = ['#ff7a59', '#ffa94d', '#ffd43b', '#b2f2bb', '#63e6be', '#a5d8ff',
    '#d0bfff', '#ffc9de', '#ff8787', '#8b98a5'];

  const state = {
    boards: [],
    currentBoardId: null,
    tiers: [],              // 全部榜单的档位
    items: [],              // 全部榜单的卡片
    urls: {},               // imageId -> objectURL
    view: 'board',
    dragId: null,
    currentItemId: null,
    ready: false
  };

  const el = {};

  function cacheEls() {
    el.boardTabs = UI.$('#boardTabs');
    el.board = UI.$('#tierBoard');
    el.table = UI.$('#tierTable');
    el.stats = UI.$('#tierStats');
    el.fileInput = UI.$('#fileInput');
    el.modalBody = UI.$('#itemModalBody');
  }

  /* ---------------- 基础查询 ---------------- */

  function bySort(a, b) { return a.order - b.order; }
  function sortItems(a, b) { return a.order - b.order || a.createdAt - b.createdAt; }
  function boardsSorted() { return state.boards.slice().sort(bySort); }
  function currentBoard() {
    return state.boards.find(function (b) { return b.id === state.currentBoardId; }) || null;
  }
  function tiersOf(boardId) {
    return state.tiers.filter(function (t) { return t.boardId === boardId; }).sort(bySort);
  }
  function itemsOf(boardId, tierId) {
    return state.items.filter(function (i) {
      return i.boardId === boardId && i.tierId === (tierId || null);
    }).sort(sortItems);
  }
  function tierById(id) { return state.tiers.find(function (t) { return t.id === id; }) || null; }
  function itemById(id) { return state.items.find(function (t) { return t.id === id; }) || null; }
  function nextOrder(boardId, tierId) {
    const list = state.items.filter(function (i) {
      return i.boardId === boardId && i.tierId === (tierId || null);
    });
    return list.length ? Math.max.apply(null, list.map(function (i) { return i.order; })) + 1 : 1;
  }

  /* ---------------- 榜单与档位的初始化 / 迁移 ---------------- */

  /** 保证至少有一个榜单；把 schema 1 里没有 boardId 的老数据归入第一个榜单 */
  function ensureBoards() {
    return LB.store.all('boards').then(function (rows) {
      const boards = (rows || []).sort(bySort);
      if (boards.length) return { boards: boards, fresh: false };
      const def = { id: UI.uid('board'), name: '我的榜单', order: 0, createdAt: Date.now() };
      return LB.store.put('boards', def).then(function () {
        return { boards: [def], fresh: true };
      });
    }).then(function (out) {
      const boards = out.boards;
      const ids = new Set(boards.map(function (b) { return b.id; }));
      const fallback = boards[0].id;

      return LB.store.all('tiers').then(function (tiers) {
        const broken = [];
        (tiers || []).forEach(function (t) {
          if (!t.boardId || !ids.has(t.boardId)) { t.boardId = fallback; broken.push(t); }
        });
        // 全新安装（既没有榜单也没有档位）才补默认五档；
        // 从 schema 1 升级上来的老数据已经有自己的档位，不能重复添加。
        if (out.fresh && (!tiers || !tiers.length)) {
          const seeded = DEFAULT_TIERS.map(function (t, i) {
            return { id: UI.uid('tier'), boardId: fallback, name: t.name, color: t.color, order: i };
          });
          return LB.store.putMany('tiers', seeded);
        }
        return broken.length ? LB.store.putMany('tiers', broken) : null;
      }).then(function () {
        return LB.store.all('items');
      }).then(function (items) {
        const broken = [];
        (items || []).forEach(function (it) {
          if (!it.boardId || !ids.has(it.boardId)) { it.boardId = fallback; broken.push(it); }
        });
        return broken.length ? LB.store.putMany('items', broken) : null;
      }).then(function () {
        state.boards = boards;
        if (!state.currentBoardId || !ids.has(state.currentBoardId)) state.currentBoardId = boards[0].id;
        return boards;
      });
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
    return ensureBoards()
      .then(function () { return LB.store.all('tiers'); })
      .then(function (rows) { state.tiers = (rows || []).sort(bySort); return LB.store.all('items'); })
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
    renderBoardTabs();
    renderBoard();
    renderTable();
    renderStats();
  }

  function renderBoardTabs() {
    const boards = boardsSorted();
    el.boardTabs.innerHTML = boards.map(function (b) {
      const active = b.id === state.currentBoardId ? ' active' : '';
      const count = state.items.filter(function (i) { return i.boardId === b.id; }).length;
      return '<button class="board-tab' + active + '" type="button" data-board="' + b.id + '" ' +
        'title="' + UI.esc(b.name) + '">' + UI.esc(b.name) +
        '<span class="bt-count">' + count + '</span></button>';
    }).join('');
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
    const boardId = state.currentBoardId;
    const list = itemsOf(boardId, isPool ? null : tier.id);
    const label = isPool
      ? '<div class="tier-label pool-label">' +
          '<span class="tl-name">未分档</span>' +
          '<span class="tl-count">' + list.length + ' 张</span>' +
          '<span class="tl-hint">新上传的图片先放这里</span>' +
        '</div>'
      : '<div class="tier-label" style="background:' + UI.esc(tier.color) + '">' +
          '<span class="tl-name" data-tier-name="' + tier.id + '" title="点击改名">' + UI.esc(tier.name) + '</span>' +
          '<span class="tl-count">' + list.length + ' 张</span>' +
          '<span class="tl-tools">' +
            '<button type="button" data-tier-act="edit" data-tier="' + tier.id + '" title="改名字和颜色">改</button>' +
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
    const tiers = tiersOf(state.currentBoardId);
    // 「未分档」固定放在最下面
    el.board.innerHTML = tiers.map(rowHTML).join('') + rowHTML(null);
  }

  function renderTable() {
    if (state.view !== 'table') return;
    const tiers = tiersOf(state.currentBoardId);
    const order = new Map();
    tiers.forEach(function (t, i) { order.set(t.id, i); });

    const rows = state.items.filter(function (i) {
      return i.boardId === state.currentBoardId;
    }).sort(function (a, b) {
      if (b.stars !== a.stars) return b.stars - a.stars;
      const oa = a.tierId ? order.get(a.tierId) : 999;
      const ob = b.tierId ? order.get(b.tierId) : 999;
      if (oa !== ob) return oa - ob;
      return a.createdAt - b.createdAt;
    });

    if (!rows.length) {
      el.table.innerHTML = '<p class="empty muted">这个榜单还没有图片，点上方的「上传图片」开始吧。</p>';
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
    const list = state.items.filter(function (i) { return i.boardId === state.currentBoardId; });
    const total = list.length;
    if (!total) { el.stats.textContent = '这个榜单还没有图片'; return; }
    const rated = list.filter(function (i) { return i.stars > 0; });
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
      tiersOf(item.boardId).map(function (t) {
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
      item.order = nextOrder(item.boardId, next);
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
      UI.confirm({
        title: '删除图片卡片',
        html: '<p>确定删除「<strong>' + UI.esc(item.name) + '</strong>」吗？</p>' +
              '<p class="muted small">这张图片会从本机一起删除，无法恢复。</p>',
        okLabel: '删除'
      }).then(function (ok) {
        if (!ok) return;
        UI.closeModal('itemModal');
        LB.image.drop(item.imageId).catch(function () {});
        delete state.urls[item.imageId];
        state.items = state.items.filter(function (i) { return i.id !== item.id; });
        LB.store.del('items', item.id).then(render).catch(function (err) { UI.toast('删除失败：' + err.message, 'err'); });
      });
    });

    function step(delta) {
      const list = state.items.filter(function (i) { return i.boardId === item.boardId; }).sort(sortItems);
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
    const siblings = state.items.filter(function (i) {
      return i.boardId === item.boardId && i.tierId === target && i.id !== itemId;
    }).sort(sortItems);

    let order;
    if (beforeId) {
      const idx = siblings.findIndex(function (s) { return s.id === beforeId; });
      if (idx < 0) order = nextOrder(item.boardId, target);
      else if (idx === 0) order = (siblings[0].order || 1) - 1;
      else order = (siblings[idx - 1].order + siblings[idx].order) / 2;
    } else {
      order = nextOrder(item.boardId, target);
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
    el.boardTabs.addEventListener('click', function (ev) {
      const tab = ev.target.closest('[data-board]');
      if (!tab) return;
      state.currentBoardId = tab.dataset.board;
      render();
    });

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

  function tierAction(action, tierId) {
    const tier = tierById(tierId);
    if (!tier) return;
    const sorted = tiersOf(tier.boardId);
    const idx = sorted.findIndex(function (t) { return t.id === tierId; });

    if (action === 'edit') {
      UI.prompt({
        title: '编辑档位',
        label: '档位名称',
        value: tier.name,
        color: tier.color,
        colors: PALETTE,
        hint: '点下面的色块换颜色。',
        okLabel: '保存'
      }).then(function (res) {
        if (!res) return;
        tier.name = res.value.slice(0, 40);
        if (res.color) tier.color = res.color;
        LB.store.put('tiers', tier).then(render);
      });
    } else if (action === 'up' && idx > 0) {
      const other = sorted[idx - 1];
      const tmp = tier.order; tier.order = other.order; other.order = tmp;
      return LB.store.putMany('tiers', [tier, other]).then(function () {
        state.tiers.sort(bySort); render();
      });
    } else if (action === 'down' && idx < sorted.length - 1) {
      const other = sorted[idx + 1];
      const tmp = tier.order; tier.order = other.order; other.order = tmp;
      return LB.store.putMany('tiers', [tier, other]).then(function () {
        state.tiers.sort(bySort); render();
      });
    } else if (action === 'del') {
      const count = itemsOf(tier.boardId, tier.id).length;
      UI.confirm({
        title: '删除档位',
        html: '<p>确定删除档位「<strong>' + UI.esc(tier.name) + '</strong>」吗？</p>' +
              '<p class="muted small">' + (count
                ? '里面的 ' + count + ' 张图片会回到「未分档」，图片本身不会丢。'
                : '这个档位里没有图片。') + '</p>',
        okLabel: '删除档位'
      }).then(function (ok) {
        if (!ok) return;
        state.items.forEach(function (it) {
          if (it.tierId === tierId) {
            it.tierId = null;
            it.order = nextOrder(it.boardId, null);
            saveItem(it);
          }
        });
        state.tiers = state.tiers.filter(function (t) { return t.id !== tierId; });
        LB.store.del('tiers', tierId).then(function () {
          state.items.sort(sortItems);
          render();
          UI.toast('已删除档位「' + tier.name + '」', 'ok');
        });
      });
    }
  }

  function addTier() {
    UI.prompt({
      title: '新增档位',
      label: '档位名称',
      value: '',
      placeholder: '例如：神中神',
      color: PALETTE[tiersOf(state.currentBoardId).length % PALETTE.length],
      colors: PALETTE,
      hint: '点色块挑一个颜色。',
      okLabel: '创建'
    }).then(function (res) {
      if (!res) return;
      const list = tiersOf(state.currentBoardId);
      const order = list.length ? Math.max.apply(null, list.map(function (t) { return t.order; })) + 1 : 0;
      const tier = {
        id: UI.uid('tier'),
        boardId: state.currentBoardId,
        name: res.value.slice(0, 40),
        color: res.color || PALETTE[0],
        order: order
      };
      state.tiers.push(tier);
      state.tiers.sort(bySort);
      LB.store.put('tiers', tier).then(render);
    });
  }

  /** 把默认五档里缺的补回来（用于误删恢复），并放回它在默认顺序里的位置 */
  function restoreDefaultTiers() {
    const boardId = state.currentBoardId;
    const list = tiersOf(boardId);            // 已按 order 排好；下面是副本，改它不影响 state
    const missing = DEFAULT_TIERS.filter(function (d) {
      return !list.some(function (t) { return t.name === d.name; });
    });
    if (!missing.length) return Promise.resolve(0);

    const created = [];
    missing.forEach(function (d) {
      const defaultIndex = DEFAULT_TIERS.findIndex(function (x) { return x.name === d.name; });

      // 在默认顺序里，找它后面第一个还存在的档位，插到那个档位前面
      let nextTier = null;
      for (let j = defaultIndex + 1; j < DEFAULT_TIERS.length; j++) {
        const found = list.find(function (t) { return t.name === DEFAULT_TIERS[j].name; });
        if (found) { nextTier = found; break; }
      }

      let order;
      if (nextTier) {
        const before = list.filter(function (t) { return t.order < nextTier.order; }).sort(bySort).pop() || null;
        order = before ? (before.order + nextTier.order) / 2 : nextTier.order - 1;
      } else {
        order = list.length ? Math.max.apply(null, list.map(function (t) { return t.order; })) + 1 : 0;
      }

      const tier = { id: UI.uid('tier'), boardId: boardId, name: d.name, color: d.color, order: order };
      list.push(tier);
      list.sort(bySort);
      created.push(tier);
    });

    state.tiers = state.tiers.concat(created);
    return LB.store.putMany('tiers', created).then(function () {
      state.tiers.sort(bySort);
      render();
      return created.length;
    });
  }

  /* ---------------- 榜单操作 ---------------- */

  function addBoard() {
    UI.prompt({
      title: '新建榜单',
      label: '榜单名称',
      value: '',
      placeholder: '例如：国内山的综合评价',
      hint: '每个榜单有自己独立的档位和图片，互不干扰。新建时会自动带上默认五档。',
      okLabel: '创建'
    }).then(function (res) {
      if (!res) return;
      const list = boardsSorted();
      const order = list.length ? Math.max.apply(null, list.map(function (b) { return b.order; })) + 1 : 0;
      const board = { id: UI.uid('board'), name: res.value.slice(0, 60), order: order, createdAt: Date.now() };
      const tiers = DEFAULT_TIERS.map(function (t, i) {
        return { id: UI.uid('tier'), boardId: board.id, name: t.name, color: t.color, order: i };
      });
      state.boards.push(board);
      state.tiers = state.tiers.concat(tiers);
      state.currentBoardId = board.id;
      LB.store.put('boards', board).then(function () {
        return LB.store.putMany('tiers', tiers);
      }).then(function () {
        render();
        UI.toast('已创建榜单「' + board.name + '」', 'ok');
      });
    });
  }

  function renameBoard() {
    const board = currentBoard();
    if (!board) return;
    UI.prompt({
      title: '重命名榜单',
      label: '榜单名称',
      value: board.name,
      okLabel: '保存'
    }).then(function (res) {
      if (!res) return;
      board.name = res.value.slice(0, 60);
      LB.store.put('boards', board).then(render);
    });
  }

  function deleteBoard() {
    const board = currentBoard();
    if (!board) return;
    if (state.boards.length <= 1) {
      UI.toast('至少要保留一个榜单，不能删除最后一个', 'err');
      return;
    }
    const count = state.items.filter(function (i) { return i.boardId === board.id; }).length;
    const tierCount = tiersOf(board.id).length;

    UI.confirm({
      title: '删除榜单',
      html: '<p>确定删除榜单「<strong>' + UI.esc(board.name) + '</strong>」吗？</p>' +
            '<p class="muted small">它的 ' + tierCount + ' 个档位、' + count + ' 张图片卡片以及对应的图片文件都会被删除，' +
            '无法恢复。其他榜单不受影响。</p>',
      okLabel: '删除榜单'
    }).then(function (ok) {
      if (!ok) return;

      // 先把要删的 ID 收集起来，一会儿 state 里就查不到了
      const doomedTiers = tiersOf(board.id);
      const doomedItems = state.items.filter(function (i) { return i.boardId === board.id; });
      const imageIds = doomedItems.map(function (i) { return i.imageId; });
      const stillUsed = new Set(state.items
        .filter(function (i) { return i.boardId !== board.id; })
        .map(function (i) { return i.imageId; }));

      state.boards = state.boards.filter(function (b) { return b.id !== board.id; });
      state.tiers = state.tiers.filter(function (t) { return t.boardId !== board.id; });
      state.items = state.items.filter(function (i) { return i.boardId !== board.id; });
      state.currentBoardId = boardsSorted()[0].id;

      const jobs = [LB.store.del('boards', board.id)];
      doomedTiers.forEach(function (t) { jobs.push(LB.store.del('tiers', t.id)); });
      doomedItems.forEach(function (i) { jobs.push(LB.store.del('items', i.id)); });
      imageIds.forEach(function (id) {
        if (stillUsed.has(id)) return;
        delete state.urls[id];
        jobs.push(LB.image.drop(id).catch(function () {}));
      });

      Promise.all(jobs).then(function () {
        render();
        UI.toast('已删除榜单「' + board.name + '」', 'ok');
      }).catch(function (err) {
        UI.toast('删除时出错：' + err.message, 'err');
        reload();
      });
    });
  }

  /* ---------------- 上传 ---------------- */

  function addFiles(fileList, targetTierId) {
    const files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /^image\//.test(f.type || '');
    });
    if (!files.length) { UI.toast('没有找到可用的图片文件', 'err'); return Promise.resolve(); }

    const boardId = state.currentBoardId;
    const tier = targetTierId || null;
    let done = 0;
    let failed = 0;
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
            boardId: boardId,
            imageId: rec.id,
            tierId: tier,
            name: String(file.name || '未命名').replace(/\.[^.]+$/, '').slice(0, 200) || '未命名',
            stars: 0,
            comment: '',
            order: nextOrder(boardId, tier),
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
      const board = currentBoard();
      render();
      if (failed) UI.toast('有 ' + failed + ' 张图片处理失败，其余已添加', 'err');
      else UI.toast('已添加 ' + files.length + ' 张图片到「' + ((board && board.name) || '榜单') + '」的未分档', 'ok');
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
    UI.$('#btnAddBoard').addEventListener('click', addBoard);
    UI.$('#btnRenameBoard').addEventListener('click', renameBoard);
    UI.$('#btnDeleteBoard').addEventListener('click', deleteBoard);
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
    restoreDefaultTiers: restoreDefaultTiers,
    currentBoardName: function () { const b = currentBoard(); return b ? b.name : '—'; },
    state: state
  };
})(window);
