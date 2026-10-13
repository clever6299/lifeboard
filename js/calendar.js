/* LifeBoard · 日历任务页 */
(function (global) {
  'use strict';

  const state = {
    cursor: new Date(),          // 当前显示的月份（该月 1 号）
    selected: UI.todayKey(),     // 选中的日期
    tasks: [],
    onlyUndone: false,
    editingId: null,
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

  function reload() {
    return LB.store.all('tasks').then(function (rows) {
      state.tasks = rows || [];
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

    let html = '';
    let monthTotal = 0, monthDone = 0;

    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = UI.dayKey(d);
      const inMonth = d.getMonth() === month;
      const list = map.get(key) || [];
      const done = list.filter(function (t) { return t.done; }).length;
      if (inMonth) { monthTotal += list.length; monthDone += done; }

      const classes = ['cell'];
      if (!inMonth) classes.push('out');
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

    el.addTitle.placeholder = isUndoneMode
      ? '添加到 ' + UI.friendly(state.selected, false) + ' …'
      : '添加任务…';

    if (!total) {
      el.list.innerHTML = '';
      el.empty.textContent = isUndoneMode ? '太棒了，没有未完成的任务。' : '这一天还没有任务。';
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
        '<button class="mini" data-act="edit" title="编辑" type="button">✎</button>' +
        '<button class="mini" data-act="delete" title="删除" type="button">🗑</button>' +
      '</div>' +
    '</li>';
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

    el.list.addEventListener('click', function (ev) {
      const li = ev.target.closest('.task');
      if (!li) return;
      const id = li.dataset.id;
      const task = state.tasks.find(function (t) { return t.id === id; });
      if (!task) return;
      const act = ev.target.dataset.act ||
        (ev.target.closest('[data-act]') ? ev.target.closest('[data-act]').dataset.act : '');

      if (act === 'toggle') {
        task.done = ev.target.checked;
        save(task).catch(function (err) { UI.toast('保存失败：' + err.message, 'err'); });
      } else if (act === 'edit') {
        state.editingId = state.editingId === id ? null : id;
        renderDay();
        const input = el.list.querySelector('.task.editing .e-title');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      } else if (act === 'cancel') {
        state.editingId = null;
        renderDay();
      } else if (act === 'delete') {
        if (!confirm('删除任务「' + task.title + '」？')) return;
        LB.store.del('tasks', id).then(reload).catch(function (err) { UI.toast('删除失败：' + err.message, 'err'); });
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
