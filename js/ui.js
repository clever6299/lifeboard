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
    toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, kind === 'err' ? 5200 : 2600);
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

  global.UI = UI;
})(window);
