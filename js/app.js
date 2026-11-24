/**
 * 疏影拾知 · 主应用入口 (App)
 * ---------------------------
 * 初始化流程、全局联动、模态框、主题、导出导入
 */

const App = {

  async init() {
    await DataService.init();
    Helpers.applyTheme(Helpers.getTheme());

    this.renderTopBar();
    this.bindGlobalEvents();

    Sidebar.init();
    MainPanel.init();
    RightPanel.init();

    await this.refreshAll();
    console.log('[疏影拾知] 系统就绪 ✨');
  },

  renderTopBar() {
    const d = new Date();
    const w = ['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('todayDate').textContent =
      `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${w[d.getDay()]}`;

    // 主题图标初始化
    const themeIcon = document.querySelector('#themeToggleBtn i');
    if (themeIcon) {
      themeIcon.className = document.body.classList.contains('dark')
        ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }
  },

  bindGlobalEvents() {
    // 主题切换
    document.getElementById('themeToggleBtn').addEventListener('click', () => {
      const next = Helpers.toggleTheme();
      const icon = document.querySelector('#themeToggleBtn i');
      if (icon) icon.className = next === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      this.refreshAll(); // 主题切换后图表颜色需要刷新
    });

    // 导出
    document.getElementById('exportBtn').addEventListener('click', async () => {
      try {
        const payload = await DataService.exportAll();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = Helpers.formatDate(Date.now());
        a.href = url;
        a.download = `shuying-knowledge-backup-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        Helpers.toast('✓ 数据导出成功');
      } catch (e) {
        Helpers.toast(e.message || '导出失败');
      }
    });

    // 导入
    const importFile = document.getElementById('importFile');
    document.getElementById('importBtn').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        if (!payload.data || !Array.isArray(payload.data.knowledge)) throw new Error('JSON 格式不正确');

        App.confirm(
          '导入备份文件',
          `检测到 ${payload.data.knowledge.length} 条知识点、${payload.data.categories?.length || 0} 个分类。选择"合并"保留当前数据并追加导入；选择"覆盖"将清空当前数据并完全使用备份。`,
          async () => {
            try {
              const result = await DataService.importAll(payload, 'merge');
              Helpers.toast(`✓ 合并导入成功：新增 ${result.items} 条知识点${result.cats ? `，${result.cats} 个分类` : ''}`);
              await this.refreshAll();
            } catch (err) { Helpers.toast(err.message || '导入失败'); }
          },
          {
            danger: true,
            dangerText: '覆盖原数据',
            onDanger: async () => {
              try {
                const result = await DataService.importAll(payload, 'overwrite');
                Helpers.toast(`✓ 覆盖导入成功：共 ${result.items} 条知识点`);
                await this.refreshAll();
              } catch (err) { Helpers.toast(err.message || '导入失败'); }
            },
          }
        );
      } catch (err) {
        Helpers.toast('文件解析失败：' + err.message);
      } finally {
        importFile.value = '';
      }
    });
  },

  async refreshAll() {
    await MainPanel.refreshTextCategorySelect?.();
    await Promise.all([
      Sidebar.render(),
      MainPanel.renderCards(),
      RightPanel.renderReviewList(),
      RightPanel.refreshCharts(),
    ]);
  },

  // ==================== 通用模态框 ====================

  /** 输入框模态框（用于新增/重命名分类） */
  openModal(title, defaultVal = '', onConfirm) {
    const modal = document.getElementById('modal');
    document.getElementById('modalTitle').textContent = title;
    const input = document.getElementById('modalInput');
    input.value = defaultVal;
    modal.classList.add('active');
    setTimeout(() => { input.focus(); input.select(); }, 50);

    const close = () => modal.classList.remove('active');
    const cleanup = () => {
      document.getElementById('modalCancel').removeEventListener('click', close);
      document.getElementById('modalConfirm').removeEventListener('click', doOk);
      input.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
    };
    const doOk = () => {
      const v = input.value.trim();
      if (!v) { Helpers.toast('请输入内容'); return; }
      cleanup(); close();
      if (typeof onConfirm === 'function') onConfirm(v);
    };
    const onKey = (e) => { if (e.key === 'Enter') doOk(); if (e.key === 'Escape') { cleanup(); close(); } };
    const onBackdrop = (e) => { if (e.target === modal) { cleanup(); close(); } };

    document.getElementById('modalCancel').addEventListener('click', close);
    document.getElementById('modalConfirm').addEventListener('click', doOk);
    input.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);
  },

  /**
   * 确认模态框（用于删除/导入覆盖等危险操作）
   * @param {string} title
   * @param {string} body
   * @param {Function} onOk       点击"确定"回调
   * @param {object} [opts]
   * @param {boolean} [opts.danger]       是否显示"覆盖"按钮
   * @param {string}  [opts.dangerText]   危险按钮文案
   * @param {Function}[opts.onDanger]     危险按钮回调
   */
  confirm(title, body, onOk, opts = {}) {
    const modal = document.getElementById('confirmModal');
    document.querySelector('#confirmTitle span').textContent = title;
    document.getElementById('confirmBody').textContent = body;

    const dangerBtn = document.getElementById('confirmDanger');
    if (opts.danger) {
      dangerBtn.classList.remove('hidden');
      dangerBtn.textContent = opts.dangerText || '覆盖原数据';
    } else {
      dangerBtn.classList.add('hidden');
    }

    modal.classList.add('active');
    setTimeout(() => { modal.querySelector('#confirmOk').focus(); }, 50);

    const close = () => modal.classList.remove('active');
    const cleanup = () => {
      document.getElementById('confirmCancel').removeEventListener('click', close);
      document.getElementById('confirmOk').removeEventListener('click', doOk);
      if (opts.danger) document.getElementById('confirmDanger').removeEventListener('click', doDanger);
      modal.removeEventListener('click', onBackdrop);
    };
    const doOk = () => { cleanup(); close(); if (typeof onOk === 'function') onOk(); };
    const doDanger = () => { cleanup(); close(); if (typeof opts.onDanger === 'function') opts.onDanger(); };
    const onBackdrop = (e) => { if (e.target === modal) { cleanup(); close(); } };

    document.getElementById('confirmCancel').addEventListener('click', close);
    document.getElementById('confirmOk').addEventListener('click', doOk);
    if (opts.danger) document.getElementById('confirmDanger').addEventListener('click', doDanger);
    modal.addEventListener('click', onBackdrop);
  },
};

// DOM Ready 启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
