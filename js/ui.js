/* LifeBoard · 通用工具
 * 挂在 window.UI 上，供其它脚本使用。无依赖。
 */
(function (global) {
  'use strict';

  const UI = {};

  UI.$ = function (sel, root) { return (root || document).querySelector(sel); };
  UI.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /** HTML 转义，所有插入 innerHTML 的用户内容都必须经过它 */
  UI.esc = function (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  UI.uid = function (prefix) {
    const rand = Math.random().toString(36).slice(2, 8);
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + rand;
  };

  /* ---------- 日期 ---------- */
  UI.dayKey = function (date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  UI.parseDayKey = function (key) {
    const p = String(key || '').split('-').map(Number);
    if (p.length !== 3 || p.some(isNaN)) return new Date();
    return new Date(p[0], p[1] - 1, p[2]);
  };
  UI.todayKey = function () { return UI.dayKey(new Date()); };
  UI.WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  UI.weekdayName = function (date) { return UI.WEEKDAYS[(date instanceof Date ? date : UI.parseDayKey(date)).getDay()]; };
  /** 2025-06-01 → 6月1日 周日 */
  UI.friendly = function (key, withWeek) {
    const d = UI.parseDayKey(key);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日' + (withWeek === false ? '' : ' ' + UI.weekdayName(d));
  };
  UI.dayDiff = function (aKey, bKey) {
    const a = UI.parseDayKey(aKey), b = UI.parseDayKey(bKey);
    a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 86400000);
  };

  /* ---------- 文件大小 ---------- */
  UI.size = function (bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };

  /* ---------- 星级 ---------- */
  UI.starsHTML = function (n) {
    let out = '';
    for (let i = 1; i <= 5; i++) out += i <= n ? '★' : '<span class="off">★</span>';
    return out;
  };

  /* ---------- 提示条 ---------- */
  let toastTimer = null;
  UI.toast = function (message, kind) {
    const el = UI.$('#toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, kind === 'err' ? 5200 : 2800);
  };

  /* ---------- 忙碌遮罩 ---------- */
  let busyDepth = 0;
  UI.busy = function (on, text) {
    const el = UI.$('#busy');
    if (!el) return;
    busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
    if (text) UI.$('#busyText').textContent = text;
    el.classList.toggle('hidden', busyDepth === 0);
  };

  /* ---------- 弹窗 ---------- */
  UI.openModal = function (id) { const m = document.getElementById(id); if (m) m.classList.remove('hidden'); };
  UI.closeModal = function (id) { const m = document.getElementById(id); if (m) m.classList.add('hidden'); };

  /* 带 data-static 的弹窗自己处理关闭（确认框、输入框需要把关闭结果回传给调用方） */
  let dismissHandler = null;

  function bindStaticModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const dismiss = function () {
      if (!dismissHandler) return;
      const handler = dismissHandler;
      dismissHandler = null;
      handler();
    };
    modal.addEventListener('click', function (ev) { if (ev.target === modal) dismiss(); });
    const closeBtn = modal.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', dismiss);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !modal.classList.contains('hidden')) dismiss();
    });
  }
  bindStaticModal('confirmModal');
  bindStaticModal('promptModal');

  /**
   * 自定义确认框，替代浏览器原生 confirm。
   * UI.confirm('要删掉吗？')
   * UI.confirm({ title, message, html, okLabel, okClass, cancelLabel }) → Promise<boolean>
   */
  UI.confirm = function (opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    const modal = document.getElementById('confirmModal');
    if (!modal) return Promise.resolve(global.confirm(o.message || '确定吗？'));

    UI.$('#confirmTitle').textContent = o.title || '确认操作';
    UI.$('#confirmMessage').innerHTML = o.html
      ? o.html
      : '<p>' + UI.esc(o.message || '确定要执行这个操作吗？') + '</p>';

    const ok = UI.$('#confirmOk');
    const cancel = UI.$('#confirmCancel');
    ok.textContent = o.okLabel || '删除';
    ok.className = 'btn ' + (o.okClass || 'danger');
    cancel.textContent = o.cancelLabel || '取消';

    UI.openModal('confirmModal');
    setTimeout(function () { ok.focus(); }, 30);

    return new Promise(function (resolve) {
      const finish = function (value) {
        dismissHandler = null;
        ok.onclick = null;
        cancel.onclick = null;
        UI.closeModal('confirmModal');
        resolve(value);
      };
      dismissHandler = function () { finish(false); };
      ok.onclick = function () { finish(true); };
      cancel.onclick = function () { finish(false); };
    });
  };

  /**
   * 自定义输入框，替代浏览器原生 prompt，可选一条颜色供挑选。
   * UI.prompt({ title, label, value, placeholder, colors, color }) → Promise<{value,color}|null>
   */
  UI.prompt = function (opts) {
    const o = opts || {};
    const modal = document.getElementById('promptModal');
    if (!modal) {
      const v = global.prompt(o.label || '输入', o.value || '');
      return Promise.resolve(v === null ? null : { value: v, color: o.color || null });
    }

    UI.$('#promptTitle').textContent = o.title || '输入';
    UI.$('#promptLabel').textContent = o.label || '名称';
    UI.$('#promptHint').textContent = o.hint || '';
    UI.$('#promptOk').textContent = o.okLabel || '确定';

    const input = UI.$('#promptInput');
    input.value = o.value || '';
    input.placeholder = o.placeholder || '';
    input.maxLength = o.maxLength || 60;

    const swatches = UI.$('#promptSwatches');
    let picked = o.color || (o.colors && o.colors[0]) || null;
    if (o.colors && o.colors.length) {
      swatches.classList.remove('hidden');
      swatches.innerHTML = o.colors.map(function (c) {
        return '<button type="button" class="swatch' + (c === picked ? ' on' : '') + '" data-color="' + c +
          '" style="background:' + c + '" aria-label="颜色 ' + c + '"></button>';
      }).join('');
      swatches.onclick = function (ev) {
        const btn = ev.target.closest('[data-color]');
        if (!btn) return;
        picked = btn.dataset.color;
        UI.$$('.swatch', swatches).forEach(function (s) { s.classList.toggle('on', s === btn); });
      };
    } else {
      swatches.classList.add('hidden');
      swatches.innerHTML = '';
      swatches.onclick = null;
    }

    UI.openModal('promptModal');
    setTimeout(function () { input.focus(); input.select(); }, 30);

    return new Promise(function (resolve) {
      const finish = function (value) {
        dismissHandler = null;
        UI.$('#promptOk').onclick = null;
        UI.$('#promptCancel').onclick = null;
        input.onkeydown = null;
        UI.closeModal('promptModal');
        resolve(value);
      };
      dismissHandler = function () { finish(null); };
      UI.$('#promptOk').onclick = function () {
        const value = input.value.trim();
        if (!value) { input.focus(); return; }
        finish({ value: value, color: picked });
      };
      UI.$('#promptCancel').onclick = function () { finish(null); };
      input.onkeydown = function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); UI.$('#promptOk').click(); }
      };
    });
  };

  /* ---------- 下载 ---------- */
  UI.download = function (filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };

  /** 读取 <input type="file"> 得到的文件为文本 */
  UI.readText = function (file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('读取文件失败')); };
      fr.readAsText(file);
    });
  };

  UI.stamp = function (date) {
    const d = date || new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  };

  /* ---------------- 界面偏好 ----------------
   * 只存在本机，不参与同步：这类偏好是"这台设备看起来什么样"，
   * 没必要跟着业务数据跑到别的设备上去。
   */
  const PREFS_KEY = 'lifeboard.prefs';
  let prefsCache = null;

  function loadPrefs() {
    if (prefsCache) return prefsCache;
    try { prefsCache = JSON.parse(global.localStorage.getItem(PREFS_KEY) || '{}') || {}; }
    catch (err) { prefsCache = {}; }
    return prefsCache;
  }

  UI.pref = function (name, fallback) {
    const p = loadPrefs();
    return Object.prototype.hasOwnProperty.call(p, name) ? p[name] : fallback;
  };

  UI.setPref = function (name, value) {
    const p = loadPrefs();
    p[name] = value;
    try { global.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (err) { /* 忽略 */ }
    return value;
  };

  global.UI = UI;
})(window);
