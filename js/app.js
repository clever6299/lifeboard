/* LifeBoard · 应用外壳：视图切换、设置、备份、离线缓存 */
(function (global) {
  'use strict';

  const VIEWS = ['calendar', 'tier'];
  let pendingImport = null;

  /* ---------------- 视图切换 ---------------- */

  function switchView(name, skipHash) {
    if (VIEWS.indexOf(name) < 0) name = 'calendar';
    VIEWS.forEach(function (v) {
      const section = document.getElementById('view-' + v);
      if (section) section.classList.toggle('active', v === name);
    });
    UI.$$('#tabs .tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
    if (!skipHash && location.hash !== '#/' + name) {
      history.replaceState(null, '', '#/' + name);
    }
    global.scrollTo(0, 0);
  }

  function viewFromHash() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    return VIEWS.indexOf(raw) >= 0 ? raw : 'calendar';
  }

  /* ---------------- 设置 ---------------- */

  function bindModals() {
    // data-static 的弹窗（确认框、输入框）由 UI 自己处理关闭，好把结果回传给调用方
    UI.$$('[data-close]').forEach(function (btn) {
      const target = document.getElementById(btn.dataset.close);
      if (target && target.hasAttribute('data-static')) return;
      btn.addEventListener('click', function () { UI.closeModal(btn.dataset.close); });
    });
    UI.$$('.modal').forEach(function (modal) {
      if (modal.hasAttribute('data-static')) return;
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) modal.classList.add('hidden');
      });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      UI.$$('.modal').forEach(function (m) {
        if (m.hasAttribute('data-static')) return;
        m.classList.add('hidden');
      });
    });
  }

  function refreshStorageInfo() {
    const box = UI.$('#storageInfo');
    if (!box) return Promise.resolve();
    return LB.store.counts().then(function (counts) {
      const usage = (global.navigator.storage && global.navigator.storage.estimate)
        ? global.navigator.storage.estimate().catch(function () { return null; })
        : Promise.resolve(null);
      return usage.then(function (est) {
        const parts = [
          '任务 ' + (counts.tasks || 0) + ' 条',
          '常用任务 ' + (counts.templates || 0) + ' 条',
          '榜单 ' + (counts.boards || 0) + ' 个',
          '档位 ' + (counts.tiers || 0) + ' 个',
          '图片卡片 ' + (counts.items || 0) + ' 张',
          '图片文件 ' + (counts.images || 0) + ' 个'
        ];
        let text = parts.join(' · ');
        if (est && est.usage != null) {
          text += '；本机已用 ' + UI.size(est.usage);
          if (est.quota) text += '，浏览器可用上限约 ' + UI.size(est.quota);
        }
        box.textContent = text;
      });
    }).catch(function (err) {
      box.textContent = '统计失败：' + err.message;
    });
  }

  function refreshBoardName() {
    const box = UI.$('#setBoardName');
    if (box) box.textContent = LB.tier.currentBoardName();
  }

  function bindSettings() {
    UI.$('#btnSettings').addEventListener('click', function () {
      UI.openModal('settingsModal');
      refreshStorageInfo();
      refreshBoardName();
    });
    UI.$('#btnRefreshStorage').addEventListener('click', refreshStorageInfo);

    /* 恢复默认档位 */
    UI.$('#btnRestoreTiers').addEventListener('click', function () {
      const boardName = LB.tier.currentBoardName();
      LB.tier.restoreDefaultTiers().then(function (added) {
        if (!added) {
          UI.toast('「' + boardName + '」的默认五档都在，没有需要补的', 'ok');
        } else {
          UI.toast('已补回 ' + added + ' 个档位（' + boardName + '）', 'ok');
        }
        refreshStorageInfo();
      }).catch(function (err) {
        UI.toast('恢复失败：' + err.message, 'err');
      });
    });

    /* 导出 */
    UI.$('#btnExport').addEventListener('click', function () {
      const includeImages = UI.$('#exportWithImages').checked;
      UI.busy(true, '正在打包备份…');
      LB.exportAll({ includeImages: includeImages }).then(function (payload) {
        let text;
        try { text = JSON.stringify(payload); }
        catch (err) { throw new Error('数据太大，无法一次性序列化：' + err.message); }
        const bytes = new Blob([text]).size;
        UI.busy(false);
        UI.download('lifeboard-backup-' + UI.stamp() + '.json', text);
        UI.toast('已导出备份 ' + UI.size(bytes) + (includeImages ? '' : '（不含图片）'), 'ok');
      }).catch(function (err) {
        UI.busy(false);
        UI.toast('导出失败：' + err.message, 'err');
      });
    });

    /* 导入 */
    const importInput = UI.$('#importInput');
    const options = UI.$('#importOptions');
    importInput.addEventListener('change', function () {
      const file = importInput.files && importInput.files[0];
      importInput.value = '';
      if (!file) return;
      UI.readText(file).then(function (text) {
        let payload;
        try { payload = JSON.parse(text); }
        catch (err) { throw new Error('JSON 解析失败，文件可能不完整'); }
        if (!payload || payload.app !== 'lifeboard') throw new Error('这不是 LifeBoard 的备份文件');
        pendingImport = payload;
        UI.$('#importPreview').textContent =
          '备份时间：' + (payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : '未知') +
          ' · 榜单 ' + (payload.boards || []).length + ' 个' +
          ' · 任务 ' + (payload.tasks || []).length + ' 条' +
          ' · 常用 ' + (payload.templates || []).length + ' 条' +
          ' · 档位 ' + (payload.tiers || []).length + ' 个' +
          ' · 卡片 ' + (payload.items || []).length + ' 张' +
          ' · 图片 ' + (payload.images || []).length + ' 个';
        options.classList.remove('hidden');
      }).catch(function (err) {
        pendingImport = null;
        options.classList.add('hidden');
        UI.toast('读取失败：' + err.message, 'err');
      });
    });

    UI.$('#btnCancelImport').addEventListener('click', function () {
      pendingImport = null;
      options.classList.add('hidden');
    });

    UI.$('#btnDoImport').addEventListener('click', function () {
      if (!pendingImport) return;
      const mode = (UI.$('input[name="importMode"]:checked') || {}).value || 'merge';
      const runImport = function () {
        UI.busy(true, '正在导入…');
        LB.importAll(pendingImport, mode).then(function (result) {
          return LB.calendar.refresh().then(function () { return LB.tier.reload(); }).then(function () {
            UI.busy(false);
            pendingImport = null;
            options.classList.add('hidden');
            UI.closeModal('settingsModal');
            UI.toast('导入完成：榜单 ' + result.boards + ' 个，任务 ' + result.tasks + ' 条，常用 ' + result.templates +
              ' 条，卡片 ' + result.items + ' 张，图片 ' + result.images + ' 个' +
              (result.dropped ? '（跳过 ' + result.dropped + ' 张缺少图片的卡片）' : ''), 'ok');
            refreshStorageInfo();
          });
        }).catch(function (err) {
          UI.busy(false);
          UI.toast('导入失败：' + err.message, 'err');
        });
      };

      if (mode === 'replace') {
        UI.confirm({
          title: '覆盖导入',
          html: '<p>覆盖导入会<strong>先清空本机现有的全部数据</strong>，再写入备份里的内容。</p>' +
                '<p class="muted small">如果没有导出过备份，这一步会造成数据丢失。确定继续吗？</p>',
          okLabel: '清空并导入'
        }).then(function (ok) { if (ok) runImport(); });
      } else {
        runImport();
      }
    });

    /* 清空 */
    UI.$('#btnWipe').addEventListener('click', function () {
      LB.store.counts().then(function (c) {
        return UI.confirm({
          title: '清空全部数据',
          html: '<p>这会删除本机的：</p>' +
                '<ul class="confirm-list">' +
                '<li>任务 ' + (c.tasks || 0) + ' 条、常用任务 ' + (c.templates || 0) + ' 条</li>' +
                '<li>榜单 ' + (c.boards || 0) + ' 个、档位 ' + (c.tiers || 0) + ' 个</li>' +
                '<li>图片卡片 ' + (c.items || 0) + ' 张、图片文件 ' + (c.images || 0) + ' 个</li>' +
                '</ul>' +
                '<p class="muted small">删除后无法恢复，建议先导出一份备份。确定继续吗？</p>',
          okLabel: '全部删除'
        });
      }).then(function (ok) {
        if (!ok) return;
        UI.busy(true, '正在清空…');
        LB.image.clearCache();
        LB.store.clearAll().then(function () {
          return LB.calendar.refresh().then(function () { return LB.tier.reload(); });
        }).then(function () {
          UI.busy(false);
          refreshStorageInfo();
          UI.toast('已清空全部数据', 'ok');
        }).catch(function (err) {
          UI.busy(false);
          UI.toast('清空失败：' + err.message, 'err');
        });
      });
    });
  }

  /* ---------------- 环境准备 ---------------- */

  function requestPersistence() {
    if (global.navigator.storage && global.navigator.storage.persist) {
      global.navigator.storage.persisted().then(function (already) {
        if (already) return null;
        return global.navigator.storage.persist();
      }).catch(function () { /* 忽略：浏览器可能不支持 */ });
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in global.navigator)) return;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
    if (!secure) return;
    global.navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('离线缓存注册失败（不影响使用）', err);
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    if (location.protocol === 'file:') {
      UI.$('#fileWarn').classList.remove('hidden');
    }

    bindModals();
    bindSettings();

    UI.$$('#tabs .tab').forEach(function (btn) {
      btn.addEventListener('click', function () { switchView(btn.dataset.view); });
    });
    global.addEventListener('hashchange', function () { switchView(viewFromHash(), true); });

    switchView(viewFromHash(), true);

    LB.calendar.init().catch(function (err) {
      UI.toast('日历加载失败：' + err.message, 'err');
      console.error(err);
    });
    LB.tier.init().catch(function (err) {
      UI.toast('榜单加载失败：' + err.message, 'err');
      console.error(err);
    });

    requestPersistence();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
