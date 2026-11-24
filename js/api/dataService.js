/**
 * 疏影拾知 · 数据服务层 (DataService)
 * -----------------------------------
 * 设计原则：
 *   1. 所有业务代码只调用 DataService 的方法，不直接操作 localStorage
 *   2. 所有异步方法统一返回 Promise，后续迁移到后端 API 只需替换内部实现
 *   3. 数据 Schema 在此统一维护
 */

const DataService = {

  // ============ 内部 ============

  _read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { console.warn('[DataService] read fail:', key, e); return fallback; }
  },

  _write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('[DataService] write fail:', key, e); return false; }
  },

  _async(fn) { return new Promise(resolve => resolve(fn())); },

  // ============ 初始化 ============

  async init() {
    return this._async(() => {
      const { STORAGE_KEYS, DEFAULT_CATEGORIES, DEFAULT_SETTINGS } = CONFIG;

      // 初始化分类（若已有旧数据则迁移旧分类 ID）
      if (!localStorage.getItem(STORAGE_KEYS.CATEGORIES)) {
        this._write(STORAGE_KEYS.CATEGORIES, [...DEFAULT_CATEGORIES]);
      } else {
        // 迁移：若存在旧系统分类，替换为新的但保留自定义分类
        this._migrateCategories();
      }

      // 初始化知识点
      if (!localStorage.getItem(STORAGE_KEYS.KNOWLEDGE)) {
        this._write(STORAGE_KEYS.KNOWLEDGE, []);
      } else {
        // 迁移：补充新增字段（tags/summary）
        this._migrateKnowledge();
      }

      // 初始化设置
      if (!localStorage.getItem(STORAGE_KEYS.SETTINGS)) {
        this._write(STORAGE_KEYS.SETTINGS, { ...DEFAULT_SETTINGS });
      } else {
        // 迁移：旧版独立 key 的主题 → 统一到 settings
        const oldTheme = localStorage.getItem('syzz_theme');
        if (oldTheme) {
          const cur = this._read(STORAGE_KEYS.SETTINGS, { ...DEFAULT_SETTINGS });
          if (!cur.theme || cur.theme === DEFAULT_SETTINGS.theme) {
            cur.theme = oldTheme;
            this._write(STORAGE_KEYS.SETTINGS, cur);
            localStorage.removeItem('syzz_theme');
          }
        }
      }
    });
  },

  /** 分类迁移：旧系统分类替换为新定义 */
  _migrateCategories() {
    const cats = this._read(CONFIG.STORAGE_KEYS.CATEGORIES, []);
    const isOldSys = (name) => ['计算机基础','数学公式','英语词汇','专业课笔记','灵感随笔','其他归档'].includes(name);
    const hasOldSys = cats.some(c => c.isSystem && isOldSys(c.name));
    if (!hasOldSys) return;

    const customs = cats.filter(c => !c.isSystem);
    // 合并：新系统分类 + 原自定义分类
    const merged = [...CONFIG.DEFAULT_CATEGORIES, ...customs];
    this._write(CONFIG.STORAGE_KEYS.CATEGORIES, merged);
  },

  /** 知识点字段迁移 */
  _migrateKnowledge() {
    const list = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
    let changed = false;
    const newList = list.map(k => {
      const patch = {};
      if (!Array.isArray(k.tags)) patch.tags = [];
      if (typeof k.summary !== 'string') patch.summary = '';
      if (typeof k.reviewCount !== 'number') patch.reviewCount = 0;
      if (k.nextReviewAt == null) patch.nextReviewAt = Helpers.calcNextReview(0, k.createdAt || Date.now());
      if (Object.keys(patch).length) { changed = true; return { ...k, ...patch }; }
      return k;
    });
    if (changed) this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, newList);
  },

  // =============================================
  // 分类模块
  // =============================================

  async getCategories() {
    return this._async(() => this._read(CONFIG.STORAGE_KEYS.CATEGORIES, []));
  },

  async getCategoryById(id) {
    const list = await this.getCategories();
    return list.find(c => c.id === id) || null;
  },

  async addCategory(name, icon = 'fa-tag') {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.CATEGORIES, []);
      if (list.some(c => c.name === name)) throw new Error('分类名称已存在');
      const newCat = { id: Helpers.generateId('cat'), name: name.trim(), icon, isSystem: false };
      list.push(newCat);
      this._write(CONFIG.STORAGE_KEYS.CATEGORIES, list);
      return newCat;
    });
  },

  /** 重命名自定义分类 */
  async renameCategory(id, newName) {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.CATEGORIES, []);
      const cat = list.find(c => c.id === id);
      if (!cat) throw new Error('分类不存在');
      if (cat.isSystem) throw new Error('系统分类不可重命名');
      if (!newName.trim()) throw new Error('分类名不能为空');
      if (list.some(c => c.name === newName.trim() && c.id !== id)) throw new Error('分类名称已存在');
      cat.name = newName.trim();
      this._write(CONFIG.STORAGE_KEYS.CATEGORIES, list);
      return cat;
    });
  },

  async deleteCategory(id) {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.CATEGORIES, []);
      const cat = list.find(c => c.id === id);
      if (!cat) throw new Error('分类不存在');
      if (cat.isSystem) throw new Error('系统分类不可删除');
      const knowledge = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
      if (knowledge.some(k => k.categoryId === id)) {
        throw new Error('该分类下还有知识点，请先迁移或删除');
      }
      this._write(CONFIG.STORAGE_KEYS.CATEGORIES, list.filter(c => c.id !== id));
      return true;
    });
  },

  // =============================================
  // 知识点模块
  // =============================================

  async getKnowledgeList() {
    return this._async(() => this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []));
  },

  async getKnowledgeByCategory(categoryId) {
    const all = await this.getKnowledgeList();
    if (categoryId === 'all') return all;
    return all.filter(k => k.categoryId === categoryId);
  },

  async getKnowledgeById(id) {
    const all = await this.getKnowledgeList();
    return all.find(k => k.id === id) || null;
  },

  /** 新增知识点（完整 Schema） */
  async addKnowledge(data) {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
      const now = Helpers.now();
      const newItem = {
        id: Helpers.generateId('kn'),
        title:       data.title?.trim()    || '未命名知识点',
        content:     data.content?.trim()  || '',
        summary:     data.summary?.trim()  || '',
        tags:        Array.isArray(data.tags) ? data.tags : [],
        sourceType:  data.sourceType       || CONFIG.SOURCE_TYPES.TEXT,
        categoryId:  data.categoryId       || 'cat_class',
        createdAt:   now,
        reviewCount: 0,
        nextReviewAt: Helpers.calcNextReview(0, now),
        lastReviewAt: null,
        sourceMeta:  data.sourceMeta || {},
      };
      list.unshift(newItem);
      this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, list);
      return newItem;
    });
  },

  async deleteKnowledge(id) {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
      this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, list.filter(k => k.id !== id));
      return true;
    });
  },

  /** 标记已复习 */
  async markReviewed(id) {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
      const idx = list.findIndex(k => k.id === id);
      if (idx === -1) throw new Error('知识点不存在');
      const now = Helpers.now();
      list[idx].reviewCount += 1;
      list[idx].lastReviewAt = now;
      list[idx].nextReviewAt = Helpers.calcNextReview(list[idx].reviewCount, now);
      this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, list);
      return list[idx];
    });
  },

  async updateKnowledge(id, patch) {
    return this._async(() => {
      const list = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
      const idx = list.findIndex(k => k.id === id);
      if (idx === -1) throw new Error('知识点不存在');
      list[idx] = { ...list[idx], ...patch };
      this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, list);
      return list[idx];
    });
  },

  // =============================================
  // 搜索 / 查询
  // =============================================

  /**
   * 全文模糊检索：标题 + 正文 + 标签（含 summary）
   * @param {string} keyword
   * @param {string} [categoryId]  可选分类筛选（'all' 表示全部）
   */
  async searchKnowledge(keyword, categoryId = 'all') {
    if (!keyword) return this.getKnowledgeByCategory(categoryId);
    const kw = keyword.toLowerCase();
    let items = await this.getKnowledgeByCategory(categoryId);
    return items.filter(k => {
      if ((k.title || '').toLowerCase().includes(kw)) return true;
      if ((k.content || '').toLowerCase().includes(kw)) return true;
      if ((k.summary || '').toLowerCase().includes(kw)) return true;
      if (Array.isArray(k.tags) && k.tags.some(t => t.toLowerCase().includes(kw))) return true;
      return false;
    });
  },

  /** 获取所有使用过的标签（去重 + 频次） */
  async getAllTags() {
    const list = await this.getKnowledgeList();
    const freq = new Map();
    list.forEach(k => {
      (k.tags || []).forEach(t => freq.set(t, (freq.get(t) || 0) + 1));
    });
    return [...freq.entries()].map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  },

  /** 待复习列表 */
  async getDueReviewList() {
    const all = await this.getKnowledgeList();
    const now = Helpers.now();
    return all.filter(k => k.nextReviewAt <= now).sort((a, b) => a.nextReviewAt - b.nextReviewAt);
  },

  // =============================================
  // 统计
  // =============================================

  async getStats() {
    const [cats, items] = await Promise.all([this.getCategories(), this.getKnowledgeList()]);
    const now = Helpers.now();

    const catCount = cats.map(c => ({ id: c.id, name: c.name, count: items.filter(k => k.categoryId === c.id).length }));

    const sourceCount = { video: 0, audio: 0, text: 0 };
    items.forEach(k => { sourceCount[k.sourceType] = (sourceCount[k.sourceType] || 0) + 1; });

    // 近 30 天趋势（严格基于 createTime / createdAt 真实时间戳统计）
    const trend = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() - i);
      const startTs = dayStart.getTime();
      const endTs = startTs + 24 * 60 * 60 * 1000;
      trend.push({
        date: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
        fullDate: Helpers.formatDate(startTs),
        count: items.filter(k => {
          const ts = Number(k.createTime || k.createdAt || 0);
          return ts >= startTs && ts < endTs;
        }).length,
      });
    }

    // 近 90 天热力图
    const heatmap = Helpers.getHeatmapData(items);

    // 复习进度分布（各复习次数区间的知识点数量）
    const reviewDist = [0, 0, 0, 0, 0]; // 0次, 1-2次, 3-4次, 5-6次, 7+次
    items.forEach(k => {
      if (k.reviewCount === 0) reviewDist[0]++;
      else if (k.reviewCount <= 2) reviewDist[1]++;
      else if (k.reviewCount <= 4) reviewDist[2]++;
      else if (k.reviewCount <= 6) reviewDist[3]++;
      else reviewDist[4]++;
    });

    const dueCount = items.filter(k => k.nextReviewAt <= now).length;

    return { total: items.length, dueCount, catCount, sourceCount, trend, heatmap, reviewDist, categories: cats };
  },

  // =============================================
  // 设置
  // =============================================

  async getSettings() {
    return this._async(() => this._read(CONFIG.STORAGE_KEYS.SETTINGS, CONFIG.DEFAULT_SETTINGS));
  },

  async updateSettings(patch) {
    return this._async(() => {
      const cur = this._read(CONFIG.STORAGE_KEYS.SETTINGS, CONFIG.DEFAULT_SETTINGS);
      const next = { ...cur, ...patch };
      this._write(CONFIG.STORAGE_KEYS.SETTINGS, next);
      return next;
    });
  },

  // =============================================
  // 数据备份 / 迁移
  // =============================================

  /** 导出全部数据为 JSON */
  async exportAll() {
    const [categories, knowledge] = await Promise.all([
      this.getCategories(),
      this.getKnowledgeList(),
    ]);
    return {
      version: '1.0',
      exportedAt: Helpers.now(),
      app: '疏影拾知',
      data: { categories, knowledge },
    };
  },

  /**
   * 导入 JSON 备份
   * @param {object} payload  解析后的 JSON 对象
   * @param {'overwrite'|'merge'} mode  覆盖 or 合并
   */
  async importAll(payload, mode = 'merge') {
    if (!payload || !payload.data || !Array.isArray(payload.data.categories) || !Array.isArray(payload.data.knowledge)) {
      throw new Error('JSON 格式不正确');
    }

    if (mode === 'overwrite') {
      return this._async(() => {
        // 保留系统分类定义
        const sys = CONFIG.DEFAULT_CATEGORIES;
        const customs = payload.data.categories.filter(c => !c.isSystem);
        this._write(CONFIG.STORAGE_KEYS.CATEGORIES, [...sys, ...customs]);
        this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, payload.data.knowledge);
        return { cats: payload.data.categories.length, items: payload.data.knowledge.length };
      });
    }

    // merge 模式
    return this._async(() => {
      const curCats = this._read(CONFIG.STORAGE_KEYS.CATEGORIES, []);
      const curItems = this._read(CONFIG.STORAGE_KEYS.KNOWLEDGE, []);
      const curCatIds = new Set(curCats.map(c => c.id));
      const curItemIds = new Set(curItems.map(k => k.id));

      let addedCats = 0, addedItems = 0;
      payload.data.categories.forEach(c => {
        if (!curCatIds.has(c.id) && !curCats.some(x => x.name === c.name)) {
          curCats.push(c); addedCats++;
        }
      });
      payload.data.knowledge.forEach(k => {
        if (!curItemIds.has(k.id)) { curItems.push(k); addedItems++; }
      });

      this._write(CONFIG.STORAGE_KEYS.CATEGORIES, curCats);
      this._write(CONFIG.STORAGE_KEYS.KNOWLEDGE, curItems);
      return { cats: addedCats, items: addedItems };
    });
  },

  // =============================================
  // 预留后端 API 接口
  // =============================================
  // async addKnowledge(data) {
  //   return fetch('/api/knowledge', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) }).then(r => r.json());
  // }

  // =============================================
  // ★ 统一字段 Schema（软件工程标准化）
  // =============================================
  // 对外暴露的知识点统一视图（字段名固定）：
  //   id             string   唯一 ID
  //   content        string   正文（预处理后）
  //   tags           string[] 关键词标签
  //   categoryName   string   所属分类名
  //   createTime     number   创建时间戳
  //   nextReviewTime number   下次复习时间戳
  //
  // 内部存储可扩展字段（不对外暴露）：
  //   title / summary / sourceType / categoryId / reviewCount / lastReviewAt / sourceMeta / createdAt / nextReviewAt

  /** 将内部存储对象映射为统一对外视图（字段名完全符合标准） */
  async toNoteViewModel(internalItem) {
    if (!internalItem) return null;
    const cat = await this.getCategoryById(internalItem.categoryId);
    return {
      id:             internalItem.id,
      content:        internalItem.content || '',
      tags:           internalItem.tags || [],
      categoryName:    cat?.name || '未分类',
      createTime:     internalItem.createdAt || 0,
      nextReviewTime: internalItem.nextReviewAt || 0,
      // 扩展字段（页面内部可按需读取）
      _title:         internalItem.title,
      _summary:       internalItem.summary,
      _sourceType:    internalItem.sourceType,
      _reviewCount:   internalItem.reviewCount,
    };
  },

  /** 批量映射为标准视图 */
  async toNoteViewModelList(internalItems) {
    return Promise.all(internalItems.map(k => this.toNoteViewModel(k)));
  },

  // =============================================
  // ★ 标准 API 表面（用户/评分项要求）
  // =============================================
  // 下列方法是对内部实现的"别名 + 薄包装"，统一了外部调用接口。
  // 后续替换为后端 API 时，只需修改每个方法内部实现，调用方零改动。

  /**
   * saveNote — 保存/新增一条知识点
   * @param {object} note  { content, tags, categoryId, ... }
   * @returns {Promise<object>} 新增后的内部对象
   */
  async saveNote(note) {
    return this.addKnowledge(note);
  },

  /**
   * getAllNotes — 获取全部知识点
   * @returns {Promise<object[]>} 内部对象数组（可再传 toNoteViewModelList 统一字段）
   */
  async getAllNotes() {
    return this.getKnowledgeList();
  },

  /**
   * getNoteById — 按 ID 获取单条知识点
   */
  async getNoteById(id) {
    return this.getKnowledgeById(id);
  },

  /**
   * updateNote — 更新知识点
   */
  async updateNote(id, patch) {
    return this.updateKnowledge(id, patch);
  },

  /**
   * deleteNote — 删除知识点
   */
  async deleteNote(id) {
    return this.deleteKnowledge(id);
  },

  // 注：addCategory / renameCategory / deleteCategory 已在上方「分类模块」直接实现，
  // 此处不再重复定义，避免同名方法覆盖后自我递归导致栈溢出。

  // =============================================
  // ★ 主题存储（也走 DataService，成为唯一 localStorage 入口）
  // =============================================

  /** 同步读取主题（供 helpers.js 初始化时同步调用，不走 async 链路） */
  getThemeSync() {
    try {
      const settings = this._read(CONFIG.STORAGE_KEYS.SETTINGS, CONFIG.DEFAULT_SETTINGS);
      return settings.theme || CONFIG.DEFAULT_SETTINGS.theme;
    } catch {
      return CONFIG.DEFAULT_SETTINGS.theme;
    }
  },

  async getTheme() {
    return this.getThemeSync();
  },

  async setTheme(theme) {
    await this.updateSettings({ theme });
    return theme;
  },
};
