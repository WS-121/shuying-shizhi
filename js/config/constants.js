/**
 * 疏影拾知 · 常量配置
 * --------------------
 * 集中管理：Storage Key / 系统内置分类 / 艾宾浩斯间隔 / 来源类型 / 默认设置
 */

const CONFIG = {

  // ========== LocalStorage Keys ==========
  STORAGE_KEYS: {
    CATEGORIES: 'syzz_categories',
    KNOWLEDGE:  'syzz_knowledge',
    SETTINGS:   'syzz_settings',
  },

  // ========== 内置 6 个固定分类（不可删除不可重命名） ==========
  DEFAULT_CATEGORIES: [
    { id: 'cat_video',  name: '短视频通识知识', icon: 'fa-play-circle',   isSystem: true },
    { id: 'cat_class',  name: '课堂课程知识点', icon: 'fa-chalkboard-user', isSystem: true },
    { id: 'cat_read',   name: '读书随笔摘录',   icon: 'fa-book-open',     isSystem: true },
    { id: 'cat_code',   name: '技术编程积累',   icon: 'fa-code',          isSystem: true },
    { id: 'cat_exam',   name: '考试备考重点',   icon: 'fa-graduation-cap',isSystem: true },
    { id: 'cat_life',   name: '生活经验备忘',   icon: 'fa-lightbulb',     isSystem: true },
  ],

  // ========== 艾宾浩斯复习间隔（天） ==========
  EBBINGHAUS_INTERVALS: [
    1,    // 复习 0 次 → 1 天后
    2,    // 复习 1 次 → 2 天后
    4,    // 复习 2 次 → 4 天后
    7,    // 复习 3 次 → 7 天后
    15,   // 复习 4 次 → 15 天后
    30,   // 复习 5 次 → 30 天后
    60,   // 复习 6 次 → 60 天后
    120,  // 复习 7+ 次 → 120 天后
  ],

  // ========== 知识点来源类型 ==========
  SOURCE_TYPES: {
    VIDEO: 'video',
    AUDIO: 'audio',
    TEXT:  'text',
  },

  // ========== 来源类型显示名 ==========
  SOURCE_LABELS: {
    video: '短视频通识',
    audio: '课堂录音',
    text:  '手动录入',
  },

  // ========== 主题模式 ==========
  THEMES: {
    LIGHT: 'light',
    DARK:  'dark',
  },

  // ========== 默认设置 ==========
  DEFAULT_SETTINGS: {
    enableEbbinghaus: true,
    dailyReviewLimit: 20,
    theme: 'light',   // light | dark
  },

  // ========== 搜索目标 ==========
  SEARCH_ENGINES: {
    baidu:   'https://www.baidu.com/s?wd=',
    google:  'https://www.google.com/search?q=',
    bing:    'https://www.bing.com/search?q=',
  },
};

// 防止被意外修改
Object.freeze(CONFIG.STORAGE_KEYS);
Object.freeze(CONFIG.DEFAULT_CATEGORIES);
Object.freeze(CONFIG.EBBINGHAUS_INTERVALS);
Object.freeze(CONFIG.SOURCE_TYPES);
Object.freeze(CONFIG.SOURCE_LABELS);
Object.freeze(CONFIG.THEMES);
Object.freeze(CONFIG.SEARCH_ENGINES);

/**
 * 知识点数据 Schema（完整版）：
 * {
 *   id:            string,   // 唯一 ID
 *   title:         string,   // 标题（预处理后）
 *   content:       string,   // 原始/处理后正文
 *   summary:       string,   // 预处理后的精简摘要（可选）
 *   tags:          string[], // 自动/手动提取的关键词标签
 *   sourceType:    string,   // 'video' | 'audio' | 'text'
 *   categoryId:    string,   // 所属分类 id
 *   createdAt:     number,   // 创建时间戳
 *   reviewCount:   number,   // 已复习次数
 *   nextReviewAt:  number,   // 下次复习时间戳
 *   lastReviewAt:  number|null,
 *   sourceMeta:    object,   // 来源附加信息（URL、文件名等）
 * }
 */
