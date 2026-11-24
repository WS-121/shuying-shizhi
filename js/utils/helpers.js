/**
 * 疏影拾知 · 工具函数
 * --------------------
 * 通用工具：日期、ID生成、DOM辅助、Toast、主题切换、数据导出等
 */

const Helpers = {

  /** 生成唯一 ID */
  generateId(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  },

  /** 获取当前时间戳 */
  now() { return Date.now(); },

  /** 格式化为 YYYY-MM-DD */
  formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  /** 格式化为 YYYY-MM-DD HH:mm */
  formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  /** 计算目标日期的时间戳 */
  addDays(days, fromTs) {
    const base = fromTs || Date.now();
    return base + days * 24 * 60 * 60 * 1000;
  },

  /** 两个日期相差的天数（绝对值向下取整） */
  daysBetween(ts1, ts2) {
    return Math.floor(Math.abs(ts2 - ts1) / (24 * 60 * 60 * 1000));
  },

  /** 是否为今天 */
  isToday(ts) {
    const d = new Date(ts), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  },

  /** 是否已过期 */
  isOverdue(ts) { return ts < Date.now(); },

  /** 日期友好描述 */
  friendlyDate(ts) {
    if (!ts) return '—';
    const diff = ts - Date.now();
    const days = Math.round(diff / (24 * 60 * 60 * 1000));
    if (days === 0)  return '今天';
    if (days === 1)  return '明天';
    if (days > 1)    return `${days} 天后`;
    if (days === -1) return '昨天';
    return `${Math.abs(days)} 天前`;
  },

  /** 艾宾浩斯：间隔天数 */
  nextInterval(reviewCount) {
    const intervals = CONFIG.EBBINGHAUS_INTERVALS;
    return intervals[Math.min(reviewCount, intervals.length - 1)];
  },

  /** 艾宾浩斯：下次复习时间戳 */
  calcNextReview(reviewCount, fromTs) {
    return this.addDays(this.nextInterval(reviewCount), fromTs);
  },

  /** 从 URL 提取标题 */
  extractUrlTitle(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('bilibili')) return 'B 站视频';
      if (u.hostname.includes('youtube'))  return 'YouTube 视频';
      if (u.hostname.includes('douyin'))   return '抖音视频';
      if (u.hostname.includes('kuaishou')) return '快手视频';
      if (u.hostname.includes('xiaohongshu')) return '小红书';
      return `${u.hostname.replace('www.', '')} 视频`;
    } catch { return '网络视频'; }
  },

  /** HTML 转义 */
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  },

  // ========== Toast ==========
  toast(msg, duration = 2000) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    // duration <= 0 表示常驻提示，需手动调用 dismissToast() 关闭
    if (duration > 0) {
      this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
    }
  },

  /** 手动关闭常驻提示（配合 toast(msg, 0) 使用） */
  dismissToast() {
    const el = document.getElementById('toast');
    clearTimeout(this._toastTimer);
    if (el) el.classList.remove('show');
  },

  // ========== 主题（主题状态也走 DataService，成为唯一 localStorage 读写入口） ==========

  /** 应用主题到 DOM（CSS var + body class） */
  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.toggle('dark', theme === 'dark');
    // 同步写入 DataService（经 CONFIG.STORAGE_KEYS.SETTINGS 统一存储）
    // 注意：此处调用 DataService.setTheme 本身也调用 updateSettings（写入 localStorage）
    // 但浏览器 localStorage 写操作是同步的，这里仅做 UI 即时刷新 + 持久化同步
    const _ = typeof DataService !== 'undefined' && DataService.setTheme ? DataService.setTheme(theme) : null;
  },

  /** 读取当前主题（优先读 DataService，fallback 读默认值） */
  getTheme() {
    if (typeof DataService !== 'undefined' && DataService.getThemeSync) {
      return DataService.getThemeSync();
    }
    return CONFIG.DEFAULT_SETTINGS.theme;
  },

  /** 切换主题 */
  toggleTheme() {
    const cur = this.getTheme();
    const next = cur === CONFIG.THEMES.LIGHT ? CONFIG.THEMES.DARK : CONFIG.THEMES.LIGHT;
    this.applyTheme(next);
    return next;
  },

  // ========== DOM 辅助 ==========

  /** 安全查询 */
  $(sel, root = document) { return root.querySelector(sel); },
  $$(sel, root = document) { return [...root.querySelectorAll(sel)]; },

  // ========== 日期热力图：过去 90 天每日创建数 ==========

  getHeatmapData(items) {
    const counts = {}; // 'YYYY-MM-DD' => count
    items.forEach(k => {
      // 统一读取创建时间：标准字段 createTime，兼容内部字段 createdAt
      const ts = Number(k.createTime || k.createdAt || 0);
      if (!ts) return;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      counts[key] = (counts[key] || 0) + 1;
    });

    // 生成过去 90 天的数据
    const data = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      data.push([key, counts[key] || 0]);
    }
    return data;
  },
};
