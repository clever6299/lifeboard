/* LifeBoard · 日历任务页（含"常用任务"） */
(function (global) {
  'use strict';

  const state = {
    cursor: new Date(),          // 当前显示的月份（该月 1 号）
    selected: UI.todayKey(),     // 选中的日期
    tasks: [],
    templates: [],
    onlyUndone: false,
    editingId: null,
    tplOpen: false,
    ready: false
  };

  const el = {};

  function cacheEls() {
    el.grid = UI.$('#calGrid');
    el.title = UI.$('#calTitle');
    el.stats = UI.$('#calStats');
    el.jump = UI.$('#calJump');
    el.dayTitle = UI.$('#dayTitle');
    el.daySub = UI.$('#daySub');
    el.list = UI.$('#taskList');
    el.empty = UI.$('#taskEmpty');
    el.addForm = UI.$('#addForm');
    el.addTitle = UI.$('#addTitle');
    el.addPriority = UI.$('#addPriority');
    el.showUndone = UI.$('#showUndone');
    el.undoneHint = UI.$('#undoneHint');
    el.tplToggle = UI.$('#btnTplToggle');
    el.tplCount = UI.$('#tplCount');
    el.tplList = UI.$('#tplList');
    el.saveTpl = UI.$('#btnSaveTpl');
  }

  /* ---------------- 数据 ---------------- */

  function byDateMap() {
    const map = new Map();
    state.tasks.forEach(function (t) {
      if (!map.has(t.date)) map.set(t.date, []);
      map.get(t.date).push(t);
    });
    map.forEach(function (list) {
      list.sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      });
    });
    return map;
  }

  function sortedTemplates() {
    return state.templates.slice().sort(function (a, b) {
      if (b.useCount !== a.useCount) return b.useCount - a.useCount;
      return b.createdAt - a.createdAt;
    });
  }

  function reload() {
    return Promise.all([LB.store.all('tasks'), LB.store.all('templates')]).then(function (rows) {
      state.tasks = rows[0] || [];
      state.templates = rows[1] || [];
      render();
    });
  }

  function save(task) {
    task.updatedAt = Date.now();
    return LB.store.put('tasks', task).then(reload);
  }

  /* ---------------- 渲染：月历 ---------------- */

  function render() {
    if (!el.grid) return;
    renderGrid();
    renderDay();
    renderTemplates();
  }

  function renderGrid() {
    const cursor = state.cursor;
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    el.title.textContent = year + '年' + (month + 1) + '月';
    if (el.jump && el.jump.value !== state.selected) el.jump.value = state.selected;

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;              // 周一为第一列
    const start = new Date(year, month, 1 - offset);
    const todayKey = UI.todayKey();
    const map = byDateMap();

    // 只画需要的那几周：有些月份 5 行就够，不必留一整行空白
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const weeks = Math.ceil((offset + daysInMonth) / 7);
    const cellCount = weeks * 7;

    let html = '';
    let monthTotal = 0, monthDone = 0;

    for (let i = 0; i < cellCount; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = UI.dayKey(d);
      const inMonth = d.getMonth() === month;
      const list = map.get(key) || [];
      const done = list.filter(function (t) { return t.done; }).length;
      if (inMonth) { monthTotal += list.length; monthDone += done; }

      const classes = ['cell'];
      if (!inMonth) classes.push('out');
      if (d.getDay() === 0 || d.getDay() === 6) classes.push('wkend');
      if (key === todayKey) classes.push('today');
      if (key === state.selected) classes.push('sel');
      if (list.length && done === list.length) classes.push('done-all');

      const dots = list.slice(0, 5).map(function (t) {
        return '<i class="p' + t.priority + (t.done ? ' done' : '') + '"></i>';
      }).join('');

      const count = list.length
        ? '<span class="count">' + (list.length > 5 ? list.length + ' 项 · ' : '') +
          '<span class="' + (done === list.length ? '' : 'over') + '">' + done + '/' + list.length + '</span></span>'
        : '';

      html += '<button class="' + classes.join(' ') + '" data-date="' + key + '" role="gridcell" ' +
        'aria-label="' + UI.esc(UI.friendly(key)) + '">' +
        '<span class="num">' + d.getDate() + '</span>' +
        '<span class="dots">' + dots + '</span>' + count +
        '</button>';
    }

    el.grid.innerHTML = html;
    el.stats.textContent = monthTotal
      ? '本月 ' + monthTotal + ' 项任务，已完成 ' + monthDone + ' 项（' + Math.round(monthDone / monthTotal * 100) + '%）'
      : '本月还没有任务，点日期开始添加。';
  }

  /* ---------------- 渲染：某天任务 ---------------- */

  function renderDay() {
    const isUndoneMode = state.onlyUndone;
    let list;
    if (isUndoneMode) {
      list = state.tasks.filter(function (t) { return !t.done; }).sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      });
      el.dayTitle.textContent = '全部未完成';
    } else {
      const map = byDateMap();
      list = map.get(state.selected) || [];
      el.dayTitle.textContent = UI.friendly(state.selected);
    }

    const todayKey = UI.todayKey();
    const total = list.length;
    const done = list.filter(function (t) { return t.done; }).length;

    if (isUndoneMode) {
      const overdue = list.filter(function (t) { return t.date < todayKey; }).length;
      el.daySub.textContent = total + ' 项未完成' + (overdue ? '，其中 ' + overdue + ' 项已逾期' : '');
    } else {
      el.daySub.textContent = total ? '共 ' + total + ' 项，已完成 ' + done + ' 项' : '还没有任务';
    }

    el.addTitle.placeholder = state.selected === todayKey
      ? '今天要做什么？'
      : '添加到 ' + UI.friendly(state.selected, false) + '…';

    if (!total) {
      el.list.innerHTML = '';
      el.empty.textContent = isUndoneMode
        ? '没有未完成的事，今天可以收工了。'
        : '这一天还是空的。在上面写一条。';
      el.empty.classList.remove('hidden');
    } else {
      el.empty.classList.add('hidden');
      el.list.innerHTML = list.map(function (t) { return taskHTML(t, isUndoneMode); }).join('');
    }

    // 逾期提示（仅普通模式）
    if (!isUndoneMode) {
      const overdue = state.tasks.filter(function (t) { return !t.done && t.date < todayKey; }).length;
      el.undoneHint.textContent = overdue ? '还有 ' + overdue + ' 项逾期未完成，勾选右上角「只看未完成」查看。' : '';
    } else {
      el.undoneHint.textContent = '';
    }
  }

  function taskHTML(task, showDate) {
    const p = 'p' + task.priority;
    if (state.editingId === task.id) {
      return '<li class="task ' + p + ' editing" data-id="' + task.id + '">' +
        '<div class="task-edit">' +
          '<input type="text" class="e-title" maxlength="200" value="' + UI.esc(task.title) + '" placeholder="任务内容" />' +
          '<textarea class="e-note" rows="2" maxlength="5000" placeholder="备注（可留空）">' + UI.esc(task.note) + '</textarea>' +
          '<div class="row">' +
            '<input type="date" class="e-date" value="' + task.date + '" />' +
            '<select class="e-priority">' +
              '<option value="0"' + (task.priority === 0 ? ' selected' : '') + '>普通</option>' +
              '<option value="1"' + (task.priority === 1 ? ' selected' : '') + '>重要</option>' +
              '<option value="2"' + (task.priority === 2 ? ' selected' : '') + '>紧急</option>' +
            '</select>' +
          '</div>' +
          '<div class="row">' +
            '<button class="btn primary small" data-act="save" type="button">保存</button>' +
            '<button class="btn ghost small" data-act="cancel" type="button">取消</button>' +
            '<button class="btn danger small" data-act="delete" type="button">删除</button>' +
          '</div>' +
        '</div>' +
      '</li>';
    }

    const todayKey = UI.todayKey();
    let meta = '';
    if (showDate || task.date !== todayKey) {
      const diff = UI.dayDiff(task.date, todayKey);
      let label = UI.friendly(task.date, false);
      if (!task.done) {
        if (diff === 0) label += '（今天）';
        else if (diff === 1) label += '（明天）';
        else if (diff === -1) label += '（昨天·逾期）';
        else if (diff < -1) label += '（逾期 ' + (-diff) + ' 天）';
      }
      meta = '<div class="t-meta">' + UI.esc(label) + ' · ' +
        ['普通', '重要', '紧急'][task.priority] + '</div>';
    }

    return '<li class="task ' + p + (task.done ? ' done' : '') + '" data-id="' + task.id + '">' +
      '<input type="checkbox" data-act="toggle"' + (task.done ? ' checked' : '') + ' aria-label="完成" />' +
      '<div class="t-main">' +
        '<span class="t-title" data-act="edit" title="点击编辑">' + UI.esc(task.title) + '</span>' +
        (task.note ? '<p class="t-note">' + UI.esc(task.note) + '</p>' : '') +
        meta +
      '</div>' +
      '<div class="t-actions">' +
        '<button class="mini" data-act="tpl" title="保存为常用任务" type="button">常用</button>' +
        '<button class="mini" data-act="edit" title="编辑这条任务" type="button">编辑</button>' +
        '<button class="mini" data-act="delete" title="删除这条任务" type="button">删除</button>' +
      '</div>' +
    '</li>';
  }

  /* ---------------- 渲染：常用任务 ---------------- */

  function renderTemplates() {
    const list = sortedTemplates();
    el.tplCount.textContent = String(list.length);
    el.tplToggle.setAttribute('aria-expanded', state.tplOpen ? 'true' : 'false');
    el.tplList.classList.toggle('hidden', !state.tplOpen);

    if (!state.tplOpen) return;

    if (!list.length) {
      el.tplList.innerHTML = '<p class="muted small tpl-empty">还没有常用任务。' +
        '在输入框里写好内容后点「保存为常用」，或者点任务右边的「常用」把整条任务存下来。</p>';
      return;
    }

    el.tplList.innerHTML = list.map(function (t) {
      return '<span class="tpl-chip" data-tpl="' + t.id + '">' +
        '<button class="tpl-use" type="button" data-tpl-use="' + t.id + '" title="' +
          UI.esc(t.note ? t.title + ' · ' + t.note : t.title) + '">' +
          '<i class="dot p' + t.priority + '"></i>' + UI.esc(t.title) +
          (t.useCount ? '<span class="tpl-count">×' + t.useCount + '</span>' : '') +
        '</button>' +
        '<button class="tpl-del" type="button" data-tpl-del="' + t.id + '" title="删除这个常用任务">✕</button>' +
      '</span>';
    }).join('');
  }

  /* ---------------- 常用任务操作 ---------------- */

  function templateExists(title) {
    const key = String(title).trim().toLowerCase();
    return state.templates.some(function (t) { return t.title.trim().toLowerCase() === key; });
  }

  function addTemplate(title, note, priority) {
    const clean = String(title || '').trim().slice(0, 200);
    if (!clean) { UI.toast('先在输入框里写上任务内容', 'err'); return Promise.resolve(false); }
    if (templateExists(clean)) { UI.toast('「' + clean + '」已经在常用任务里了', 'err'); return Promise.resolve(false); }

    const tpl = {
      id: UI.uid('tpl'),
      title: clean,
      note: String(note || '').trim().slice(0, 5000),
      priority: Math.min(2, Math.max(0, parseInt(priority, 10) || 0)),
      useCount: 0,
      createdAt: Date.now()
    };
    return LB.store.put('templates', tpl).then(function () {
      return LB.store.all('templates');
    }).then(function (rows) {
      state.templates = rows || [];
      state.tplOpen = true;
      renderTemplates();
      UI.toast('已保存为常用：' + clean, 'ok');
      return true;
    });
  }

  function useTemplate(id) {
    const tpl = state.templates.find(function (t) { return t.id === id; });
    if (!tpl) return;
    const task = {
      id: UI.uid('task'),
      date: state.selected,
      title: tpl.title,
      note: tpl.note || '',
      done: false,
      priority: tpl.priority || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    tpl.useCount = (tpl.useCount || 0) + 1;
    LB.store.put('templates', tpl);
    save(task).then(function () {
      UI.toast('已添加到 ' + UI.friendly(state.selected, false) + '：' + tpl.title, 'ok');
    }).catch(function (err) { UI.toast('添加失败：' + err.message, 'err'); });
  }

  function deleteTemplate(id) {
    const tpl = state.templates.find(function (t) { return t.id === id; });
    if (!tpl) return;
    UI.confirm({
      title: '删除常用任务',
      html: '<p>确定要从常用任务里删掉「<strong>' + UI.esc(tpl.title) + '</strong>」吗？</p>' +
            '<p class="muted small">已经用它添加过的任务不受影响，只是以后不能一键添加了。</p>',
      okLabel: '删除'
    }).then(function (ok) {
      if (!ok) return;
      LB.store.del('templates', id).then(function () {
        state.templates = state.templates.filter(function (t) { return t.id !== id; });
        renderTemplates();
        UI.toast('已删除常用任务', 'ok');
      }).catch(function (err) { UI.toast('删除失败：' + err.message, 'err'); });
    });
  }

  /* ---------------- 交互 ---------------- */

  function selectDate(key) {
    state.selected = key;
    state.editingId = null;
    render();
  }

  function shiftMonth(delta) {
    state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + delta, 1);
    renderGrid();
  }

  function bind() {
    el.grid.addEventListener('click', function (ev) {
      const cell = ev.target.closest('.cell');
      if (!cell) return;
      const key = cell.dataset.date;
      const d = UI.parseDayKey(key);
      if (d.getMonth() !== state.cursor.getMonth() || d.getFullYear() !== state.cursor.getFullYear()) {
        state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      }
      selectDate(key);
    });

    UI.$('#calPrev').addEventListener('click', function () { shiftMonth(-1); });
    UI.$('#calNext').addEventListener('click', function () { shiftMonth(1); });
    UI.$('#calToday').addEventListener('click', function () {
      const now = new Date();
      state.cursor = new Date(now.getFullYear(), now.getMonth(), 1);
      selectDate(UI.todayKey());
    });
    el.jump.addEventListener('change', function () {
      if (!el.jump.value) return;
      const d = UI.parseDayKey(el.jump.value);
      state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      selectDate(el.jump.value);
    });

    el.showUndone.addEventListener('change', function () {
      state.onlyUndone = el.showUndone.checked;
      state.editingId = null;
      renderDay();
    });

    /* 常用任务面板 */
    el.tplToggle.addEventListener('click', function () {
      state.tplOpen = !state.tplOpen;
      renderTemplates();
    });
    el.saveTpl.addEventListener('click', function () {
      addTemplate(el.addTitle.value, '', el.addPriority.value);
    });
    el.tplList.addEventListener('click', function (ev) {
      const use = ev.target.closest('[data-tpl-use]');
      if (use) { useTemplate(use.dataset.tplUse); return; }
      const del = ev.target.closest('[data-tpl-del]');
      if (del) { deleteTemplate(del.dataset.tplDel); }
    });

    /* 添加任务 */
    el.addForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const title = el.addTitle.value.trim();
      if (!title) { el.addTitle.focus(); return; }
      const task = {
        id: UI.uid('task'),
        date: state.selected,
        title: title,
        note: '',
        done: false,
        priority: parseInt(el.addPriority.value, 10) || 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      save(task).then(function () {
        el.addTitle.value = '';
        el.addTitle.focus();
      }).catch(function (err) { UI.toast('保存失败：' + err.message, 'err'); });
    });

    /* 任务列表操作 */
    el.list.addEventListener('click', function (ev) {
      const li = ev.target.closest('.task');
      if (!li) return;
      const id = li.dataset.id;
      const task = state.tasks.find(function (t) { return t.id === id; });
      if (!task) return;
      const hit = ev.target.closest('[data-act]');
      const act = hit ? hit.dataset.act : '';

      if (act === 'toggle') {
        task.done = ev.target.checked;
        save(task).catch(function (err) { UI.toast('保存失败：' + err.message, 'err'); });
      } else if (act === 'edit') {
        state.editingId = state.editingId === id ? null : id;
        renderDay();
        const input = el.list.querySelector('.task.editing .e-title');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      } else if (act === 'tpl') {
        addTemplate(task.title, task.note, task.priority);
      } else if (act === 'cancel') {
        state.editingId = null;
        renderDay();
      } else if (act === 'delete') {
        UI.confirm({
          title: '删除任务',
          html: '<p>确定删除任务「<strong>' + UI.esc(task.title) + '</strong>」吗？</p>' +
                '<p class="muted small">' + UI.esc(UI.friendly(task.date)) + ' · 删除后无法恢复。</p>',
          okLabel: '删除'
        }).then(function (ok) {
          if (!ok) return;
          LB.store.del('tasks', id).then(reload).catch(function (err) { UI.toast('删除失败：' + err.message, 'err'); });
        });
      } else if (act === 'save') {
        const title = li.querySelector('.e-title').value.trim();
        if (!title) { UI.toast('任务内容不能为空', 'err'); return; }
        task.title = title;
        task.note = li.querySelector('.e-note').value.trim();
        task.date = li.querySelector('.e-date').value || task.date;
        task.priority = parseInt(li.querySelector('.e-priority').value, 10) || 0;
        state.editingId = null;
        save(task).then(function () { UI.toast('已保存', 'ok'); })
          .catch(function (err) { UI.toast('保存失败：' + err.message, 'err'); });
      }
    });

    // 编辑态下 Ctrl/⌘+Enter 保存
    el.list.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        const li = ev.target.closest('.task.editing');
        if (!li) return;
        const btn = li.querySelector('[data-act="save"]');
        if (btn) btn.click();
      }
    });
  }

  function init() {
    cacheEls();
    bind();
    state.ready = true;
    return reload();
  }

  global.LB = global.LB || {};
  global.LB.calendar = {
    init: init,
    reload: reload,
    render: render,
    state: state,
    /** 供外部（导入备份后）刷新 */
    refresh: function () { return reload(); }
  };
})(window);
