/**
 * 疏影拾知 · 侧边栏组件 (Sidebar)
 * ---------------------------------
 * 分类导航：6 内置系统分类 + 自定义分类（可增删改）
 */

const Sidebar = {

  _currentCatId: 'all',

  async init() {
    this.bindEvents();
    await this.render();
  },

  bindEvents() {
    document.getElementById('addCategoryBtn').addEventListener('click', () => {
      App.openModal('新增自定义分类', '', async (name) => {
        try {
          await DataService.addCategory(name);
          Helpers.toast('分类已添加');
          await App.refreshAll();
        } catch (e) { Helpers.toast(e.message); }
      });
    });
  },

  async render() {
    const listEl = document.getElementById('categoryList');
    const [cats, allItems] = await Promise.all([
      DataService.getCategories(),
      DataService.getKnowledgeList(),
    ]);

    // 系统分类 + 自定义分类分区
    const sysCats = cats.filter(c => c.isSystem);
    const customCats = cats.filter(c => !c.isSystem);

    const buildItem = (cat, showActions) => {
      const count = allItems.filter(k => k.categoryId === cat.id).length;
      const active = this._currentCatId === cat.id ? 'active' : '';
      const actions = showActions ? `
        <span class="cat-actions" data-cat-actions="${cat.id}">
          <button class="btn-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-del-cat danger" title="删除"><i class="fa-solid fa-trash"></i></button>
        </span>
      ` : '';
      return `
        <li class="cat-item ${active}" data-cat="${cat.id}">
          <i class="fa-solid ${cat.icon || 'fa-tag'} ${cat.isSystem ? 'text-sage' : 'text-ochre'}"></i>
          <span class="cat-name" title="${Helpers.escapeHtml(cat.name)}">${Helpers.escapeHtml(cat.name)}</span>
          ${actions}
          <span class="cat-count">${count}</span>
        </li>
      `;
    };

    let html = `
      <li class="cat-item ${this._currentCatId === 'all' ? 'active' : ''}" data-cat="all">
        <i class="fa-solid fa-layer-group text-sage"></i>
        <span class="cat-name">全部知识点</span>
        <span class="cat-count">${allItems.length}</span>
      </li>
      <li class="text-[10px] text-mist uppercase tracking-wider px-3 py-1 mt-2">系统分类</li>
      ${sysCats.map(c => buildItem(c, false)).join('')}
    `;

    if (customCats.length) {
      html += `<li class="text-[10px] text-mist uppercase tracking-wider px-3 py-1 mt-2">自定义分类</li>`;
      html += customCats.map(c => buildItem(c, true)).join('');
    }

    listEl.innerHTML = html;

    // 事件委托
    listEl.querySelectorAll('.cat-item').forEach(li => {
      li.addEventListener('click', (e) => {
        const renameBtn = e.target.closest('.btn-rename');
        const delBtn = e.target.closest('.btn-del-cat');

        if (renameBtn) { e.stopPropagation(); this.handleRename(li.dataset.cat); return; }
        if (delBtn)    { e.stopPropagation(); this.handleDelete(li.dataset.cat); return; }

        this.selectCategory(li.dataset.cat);
      });
    });

    // 概览
    document.getElementById('statTotal').textContent = allItems.length;
    const dueCount = allItems.filter(k => k.nextReviewAt <= Date.now()).length;
    document.getElementById('statDue').textContent = dueCount;
    const reviewedCount = allItems.filter(k => k.reviewCount > 0).length;
    document.getElementById('statReviewed').textContent = reviewedCount;
  },

  selectCategory(catId) {
    this._currentCatId = catId;
    this.render();
    MainPanel.onCategoryChange(catId);
    const label = catId === 'all'
      ? '全部'
      : (document.querySelector(`[data-cat="${catId}"] .cat-name`)?.textContent || '—');
    document.getElementById('statCat').textContent = label;
  },

  async handleRename(catId) {
    const cat = await DataService.getCategoryById(catId);
    if (!cat) return;
    App.openModal('重命名分类', cat.name, async (name) => {
      try {
        await DataService.renameCategory(catId, name);
        Helpers.toast('分类已重命名');
        await App.refreshAll();
      } catch (e) { Helpers.toast(e.message); }
    });
  },

  async handleDelete(catId) {
    const cat = await DataService.getCategoryById(catId);
    if (!cat) return;
    App.confirm(`删除自定义分类？`, `确定要删除分类"${cat.name}"吗？`, async () => {
      try {
        await DataService.deleteCategory(catId);
        Helpers.toast('分类已删除');
        if (this._currentCatId === catId) this._currentCatId = 'all';
        await App.refreshAll();
      } catch (e) { Helpers.toast(e.message); }
    });
  },

  getCurrentCatId() { return this._currentCatId; },
};
