/**
 * 疏影拾知 · 文本预处理模块 (Preprocessor)
 * ------------------------------------------
 * 1) 文本清洗：剔除口语冗余、语气词、重复标点
 * 2) 关键词提取：停用词过滤 + 词频统计 + 名词优先
 * 3) 短视频真实解析：parseVideoLink() — 调用 B站公开 API + 备用接口 + 兜底
 * 4) 语音真实转写：transcribeAudio() — 基于浏览器原生 Web Speech API
 * 5) 模拟短视频解析 / 模拟语音转写 —— 作为 API 失败时的兜底 fallback
 * 6) 摘要生成：从长文本中提取核心句
 */

const Preprocessor = {

  // ============================================================
  // 0. 视频链接解析（API 地址配置 —— 方便后续更换接口）
  // ============================================================

  /**
   * 视频解析配置（5 层通道依次尝试，任一成功即返回）
   *   ① B站专属 API          —— 仅 B站链接，公开 JSON，最准确
   *   ② 本地 yt-dlp           —— 全平台最稳（本地代理: python video_proxy.py）
   *   ③ 免费第三方聚合 API    —— 抖音/小红书/B站/YouTube/Instagram 等 20+ 平台
   *   ④ 公共 CORS 代理链       —— 未开本地代理时的 HTML 宽松抓取
   *   ⑤ 手动兜底输入框         —— 全部网络方案失败时自动弹出
   */
  VIDEO_API_CONFIG: {
    // 本地代理（先启动：python video_proxy.py）
    localProxy: {
      enabled: true,
      root: 'http://127.0.0.1:5600',
      fetch:   (target) => `http://127.0.0.1:5600/fetch?url=${encodeURIComponent(target)}`,
      ytdlp:   (target) => `http://127.0.0.1:5600/yt-dlp?url=${encodeURIComponent(target)}`,
      backend: 'http://127.0.0.1:5600/backend-parse',
    },

    // 公共 CORS 代理链（未开本地代理时的自动兜底，按顺序尝试）
    corsProxies: [
      (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      (target) => `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
      (target) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
      (target) => `https://cors.is-a.dev/?url=${encodeURIComponent(target)}`,
    ],

    // B站专属公开 JSON API（拿标题 + 简介描述）
    bilibiliView: (bvid) => `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,

    // 请求超时毫秒数
    timeout: 8000,
  },

  /** 从 URL 中提取视频 ID（支持 B站 BV/AV 号、YouTube、抖音等） */
  extractVideoId(url) {
    try {
      const u = new URL(url);
      const host = u.hostname;
      // B站
      if (host.includes('bilibili.com')) {
        // BV 号
        const bvMatch = url.match(/(BV[\w]+)/i);
        if (bvMatch) return { platform: 'bilibili', id: bvMatch[1], type: 'bvid' };
        // AV 号
        const avMatch = url.match(/av(\d+)/i);
        if (avMatch) return { platform: 'bilibili', id: avMatch[1], type: 'aid' };
      }
      // YouTube
      if (host.includes('youtube.com') || host.includes('youtu.be')) {
        const ytMatch = url.match(/[?&]v=([\w-]+)/) || url.match(/youtu\.be\/([\w-]+)/);
        if (ytMatch) return { platform: 'youtube', id: ytMatch[1], type: 'v' };
      }
      // 抖音
      if (host.includes('douyin.com')) {
        const dyMatch = url.match(/video\/(\d+)/);
        if (dyMatch) return { platform: 'douyin', id: dyMatch[1], type: 'video' };
      }
      return { platform: host.replace('www.', ''), id: null, type: 'unknown' };
    } catch {
      return { platform: 'unknown', id: null, type: 'unknown' };
    }
  },

  /** 带超时的 fetch 封装 */
  _fetchWithTimeout(url, opts = {}) {
    return Promise.race([
      fetch(url, { ...opts, mode: 'cors' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), this.VIDEO_API_CONFIG.timeout)),
    ]);
  },

  /**
   * 经代理链 fetch 目标 URL：本地代理优先 → 公共代理依次尝试，任一成功即返回
   * 全部失败则抛出最后一个错误，由上层决定是否展示兜底输入框
   */
  async _fetchWithProxy(target) {
    const cfg = this.VIDEO_API_CONFIG;
    const attempts = [];

    if (cfg.localProxy && cfg.localProxy.enabled) {
      attempts.push({ name: '本地代理', url: cfg.localProxy.fetch(target) });
    }
    cfg.corsProxies.forEach((build, i) => {
      attempts.push({ name: `公共代理#${i + 1}`, url: build(target) });
    });

    let lastErr = null;
    for (const a of attempts) {
      try {
        const resp = await this._fetchWithTimeout(a.url);
        if (resp.ok) {
          console.log(`[parseVideoLink] ${a.name} 成功`);
          return resp;
        }
        lastErr = new Error(`HTTP ${resp.status}`);
      } catch (e) {
        lastErr = e;
      }
      console.warn(`[parseVideoLink] ${a.name} 不可用 (${lastErr?.message || '未知'})`);
    }
    throw lastErr || new Error('所有代理均不可用');
  },

  /**
   * 真实短视频链接解析（主入口，5 层通道依次尝试）
   *   ① B站专属 API        —— 仅 B站链接
   *   ② 本地 yt-dlp         —— 全平台（抖音/小红书/YouTube 等）
   *   ③ 第三方聚合 API      —— jiejing.fun 免费接口，全平台
   *   ④ HTML 宽松抓取       —— SSR 平台兜底
   *   ⑤ 抛错 → 手动输入框
   */
  async parseVideoLink(url) {
    const videoId = this.extractVideoId(url);
    let rawData = null;
    let title = Helpers.extractUrlTitle(url);
    let description = '';
    let tags = [];
    let succeeded = false;

    // ========== 通道 ①：B 站专属 JSON API（最准确） ==========
    if (videoId.platform === 'bilibili' && videoId.id) {
      try {
        const apiUrl = this.VIDEO_API_CONFIG.bilibiliView(videoId.id);
        const resp = await this._fetchWithProxy(apiUrl);
        if (resp.ok) {
          const json = await resp.json();
          if (json.code === 0 && json.data) {
            rawData = json.data;
            title = json.data.title || title;
            description = json.data.desc || '';
            succeeded = true;
            console.log('[parseVideoLink] 通道① B站API 成功');
          }
        }
      } catch (e) {
        console.warn('[parseVideoLink] 通道① B站API 失败:', e.message);
      }
    }

    // ========== 通道 ②：本地 yt-dlp（全平台最稳，需本地代理） ==========
    if (!succeeded) {
      try {
        const cfg = this.VIDEO_API_CONFIG;
        if (cfg.localProxy && cfg.localProxy.enabled) {
          const resp = await this._fetchWithTimeout(cfg.localProxy.ytdlp(url));
          if (resp.ok) {
            const json = await resp.json();
            if (json.ok && json.data) {
              rawData = json.data;
              title = json.data.title || title;
              description = json.data.description || description;
              tags = json.data.tags || tags;
              succeeded = true;
              console.log('[parseVideoLink] 通道② 本地yt-dlp 成功');
            } else {
              console.warn('[parseVideoLink] 通道② yt-dlp 返回非 ok:', json.error || '未知');
            }
          }
        }
      } catch (e) {
        console.warn('[parseVideoLink] 通道② 本地yt-dlp 失败:', e.message);
      }
    }

    // ========== 通道 ③：免费第三方聚合 API（抖音/小红书/YouTube/Instagram 等） ==========
    if (!succeeded) {
      try {
        const cfg = this.VIDEO_API_CONFIG;
        const endpoint = cfg.localProxy && cfg.localProxy.enabled
          ? cfg.localProxy.backend
          : 'https://a.jiejing.fun/parse';

        const resp = await this._fetchWithTimeout(
          endpoint,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }
        );
        if (resp.ok) {
          const json = await resp.json();
          // jiejing.fun 格式：code=0 成功，body.title/desc 有值
          // 本地代理格式：ok=true, data.title/description 有值
          let data = null;
          if (json.ok && json.data) data = json.data;            // 本地代理转发格式
          else if (json.code === 0 && json.body) data = json.body; // 直接调 jiejing.fun
          else if (json.title) data = json;                       // 扁平格式

          if (data) {
            rawData = data;
            const t = (data.title || '').replace(/\n作者[:：].*$/s, '').trim();
            if (t) title = t;
            if (data.desc) description = data.desc;
            else if (data.description) description = data.description;
            // 从 title + desc 里抽 #hashtag 当 tags
            const hashtagMatches = (data.title + ' ' + (data.desc || '')).match(/#(\S+)/g);
            if (hashtagMatches) tags = [...new Set(hashtagMatches.map(s => s.slice(1)))];
            if (!description && data.author) description = `作者：${data.author}`;
            if (title || description) {
              succeeded = true;
              console.log('[parseVideoLink] 通道③ 第三方聚合API 成功');
            }
          }
        }
      } catch (e) {
        console.warn('[parseVideoLink] 通道③ 第三方聚合API 失败:', e.message);
      }
    }

    // ========== 通道 ④：HTML 宽松抓取（SSR 平台兜底） ==========
    if (!succeeded) {
      try {
        const resp = await this._fetchWithProxy(url);
        if (resp.ok) {
          const html = await resp.text();
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (titleMatch && titleMatch[1].trim().length > 3) {
            title = titleMatch[1].trim().slice(0, 80);
          }
          const descMatch = html.match(/<meta[^>]+(?:name|property)=["']description["'][^>]+content=["']([^"']+)["']/i)
                         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']description["']/i);
          if (descMatch && descMatch[1].trim().length > 5) {
            description = descMatch[1].trim().slice(0, 300);
          }
          rawData = { raw: html.slice(0, 1500) };
          if ((title && title !== Helpers.extractUrlTitle(url)) || description) {
            succeeded = true;
            console.log('[parseVideoLink] 通道④ HTML宽松抽取 成功');
          }
        }
      } catch (e) {
        console.warn('[parseVideoLink] 通道④ HTML抓取 失败:', e.message);
      }
    }

    // ========== 通道 ⑤：全部失败，抛错触发手动输入框 ==========
    if (!succeeded) {
      throw new Error(
        '视频解析全部通道不可用。\n' +
        '请先启动本地代理（打开新终端执行：python video_proxy.py）后重试；\n' +
        '或使用下方手动兜底输入框直接填写要点。'
      );
    }

    // ========== 后处理：清洗 + 摘要 + 关键词 ==========
    const combinedText = `${title} ${description}`;
    const cleaned = this.clean(combinedText);
    const summary = this.summarize(cleaned, 2);
    const autoTags = this.extractKeywords(cleaned, 6);

    return {
      title:   title || `${Helpers.extractUrlTitle(url)} · 要点`,
      // 已移除：直接把简介填充为知识点正文的逻辑（简介多为创作者引流文案）
      // 正文/概要改由字幕文稿萃取分支提供（见 MainPanel.saveVideo 双分支）
      summary: '',
      content: '',
      description: description,   // 原始简介仅留作溯源参考，不作为正文
      tags:    tags.length ? tags.slice(0, 6) : (autoTags.length ? autoTags : [videoId.platform, '视频']),
      suggestCategoryId: 'cat_video',
      sourceMeta: { url, videoId: videoId.id, platform: videoId.platform, rawData },
    };
  },

  // ============================================================
  // 0.5 语音转写（Web Speech API 能力检测）
  // ============================================================

  /** 检测浏览器是否支持 Web Speech API */
  speechSupported() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !!SR;
  },

  /** 获取 SpeechRecognition 构造器（兼容 webkit 前缀） */
  _getSR() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  },

  /**
   * 实时语音转写（返回一个控制器对象）
   * 返回对象提供 start/stop/isRunning 方法和 onResult/onEnd 回调
   * @param {object} callbacks  { onResult(text), onEnd(finalText), onError(err), onStateChange(state) }
   */
  createSpeechRecognizer(callbacks = {}) {
    const SR = this._getSR();
    if (!SR) return null;

    const recognition = new SR();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;   // 实时中间结果
    recognition.continuous = true;        // 持续识别
    recognition.maxAlternatives = 1;

    let running = false;
    let finalText = '';
    let lastInterim = '';

    recognition.onstart = () => {
      running = true;
      callbacks.onStateChange?.('recording');
    };
    recognition.onend = () => {
      running = false;
      callbacks.onStateChange?.('idle');
      callbacks.onEnd?.(finalText.trim());
    };
    recognition.onerror = (e) => {
      running = false;
      callbacks.onError?.(e.error);
    };
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          finalText += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      lastInterim = interim;
      callbacks.onResult?.({ final: finalText, interim, full: finalText + interim });
    };

    return {
      start() { if (!running) recognition.start(); },
      stop()  { if (running) recognition.stop(); },
      get isRunning() { return running; },
      get fullText() { return finalText + lastInterim; },
      _recognition: recognition,
    };
  },

  /**
   * 上传音频文件到本地代理做 Whisper 真实转写
   * @param {File} file  浏览器 File 对象
   * @returns {Promise<{text, segments, source, model}>}
   */
  async transcribeAudio(file) {
    const cfg = this.VIDEO_API_CONFIG;
    const endpoint = cfg.localProxy && cfg.localProxy.enabled
      ? cfg.localProxy.backend.replace('backend-parse', 'transcribe')
      : 'http://127.0.0.1:5600/transcribe';

    // File → ArrayBuffer → base64
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.subarray(i, i + CHUNK);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64 = btoa(binary);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        data: base64,
      }),
    });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || '转写失败');
    return json;
  },

  /**
   * @param {string} transcript 完整转写文本
   * @param {string} [fallbackTitle] 备用标题
   */
  processTranscript(transcript, fallbackTitle = '课堂录音整理') {
    if (!transcript || transcript.trim().length < 3) {
      throw new Error('转写文本过短，请确认录音后再保存');
    }
    const cleaned = this.clean(transcript);
    // 口语流水句 → 结构化知识点纲要
    const outline = this.generateOutline(cleaned, 5);
    const summary = outline;
    const tags = this.extractKeywords(cleaned, 6);
    const sentences = cleaned.split(/[。！？.!?；;]/).filter(s => s.trim());
    const firstSentence = sentences[0]?.trim() || fallbackTitle;
    const autoTitle = firstSentence.length > 20 ? firstSentence.slice(0, 20) + '…' : firstSentence;

    return {
      title:   autoTitle || fallbackTitle,
      summary: summary || cleaned.slice(0, 80),
      content: outline || transcript,     // 优先结构化纲要
      cleaned: cleaned,
      outline: outline,                   // 结构化知识点纲要
      tags:    tags,
      suggestCategoryId: 'cat_class',
    };
  },

  /**
   * 抽取式纲要生成：从口语转写中挑出最有信息量的句子，组成编号知识点
   * @param {string} text 清洗后的文本
   * @param {number} [maxPoints=5] 最多提取的知识点条数
   * @returns {string} 形如 "1. xxx\n2. xxx" 的纲要文本
   */
  generateOutline(text, maxPoints = 5) {
    const cleaned = this.clean(text || '');
    if (!cleaned) return '';
    const sentences = cleaned
      .split(/[。！？.!?；;\n]+/)
      .map(s => s.trim())
      .filter(s => s.length >= 6);
    if (!sentences.length) return cleaned;

    const keywords = this.extractKeywords(cleaned, 10) || [];
    const DEFINE_HINTS = /是|指|称|即|包括|包含|分为|主要有|例如|比如|首先|其次|最后|总之|关键|重要|核心|注意|重点|第一|第二|第三|第[一二三四五六七八九十]/;
    const scored = sentences.map((s, i) => {
      let score = 0;
      keywords.forEach(k => { if (s.includes(k)) score += 3; });
      if (DEFINE_HINTS.test(s)) score += 2;
      if (s.length >= 8 && s.length <= 40) score += 1;
      else if (s.length > 60) score -= 1;
      if (i === 0 || i === sentences.length - 1) score += 1;
      if (/^[一二三四五六七八九十1-9][、.．]/.test(s)) score += 1;
      return { s, i, score };
    });
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPoints)
      .sort((a, b) => a.i - b.i);
    return top.map((t, idx) => `${idx + 1}. ${t.s}`).join('\n');
  },

  // ============================================================
  // 6.5 AI 智能提炼（本地大模型：Qwen 优先 / DeepSeek 回退 / 规则兜底）
  // ============================================================

  /** 本地代理 AI 提炼端点配置 */
  AI_CONFIG: {
    summarize: 'http://127.0.0.1:5600/summarize',
    videoTranscribe: 'http://127.0.0.1:5600/video-transcribe',
    timeout: 300000,   // 本地大模型首次加载较慢，允许 5 分钟
  },

  /**
   * 视频链接全自动转写：本地代理下载音轨 → Whisper 转写
   * @param {string} url 视频链接
   * @returns {Promise<{ok:boolean, text?:string, model?:string, title?:string, error?:string}>}
   */
  async transcribeVideoUrl(url) {
    try {
      const resp = await fetch(this.AI_CONFIG.videoTranscribe, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) return { ok: false, error: json.error || `HTTP ${resp.status}` };
      return json;
    } catch (e) {
      console.warn('[transcribeVideoUrl] 失败:', e.message);
      return { ok: false, error: '本地代理未启动或网络异常，请运行 python video_proxy.py 后重试' };
    }
  },

  /**
   * 调用本地大模型把原始文本提炼为知识点纲要（纠错别字 + 去口语 + 概要）
   * 永不抛异常：失败返回 {ok:false}，由调用方降级到规则纲要
   * @param {string} text 原始文本（转写 / 视频文案）
   * @returns {Promise<{ok:boolean, text?:string, model?:string, error?:string}>}
   */
  async aiRefine(text) {
    if (!text || text.trim().length < 20) return { ok: false, error: '文本过短' };
    try {
      const resp = await Promise.race([
        fetch(this.AI_CONFIG.summarize, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 6000) }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('AI 提炼超时')), this.AI_CONFIG.timeout)),
      ]);
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const json = await resp.json();
      if (json.ok && json.text && json.text.trim().length >= 10) {
        console.log(`[aiRefine] 大模型 ${json.model} 提炼成功`);
        return { ok: true, text: json.text.trim(), model: json.model };
      }
      return { ok: false, error: json.error || '提炼结果为空' };
    } catch (e) {
      console.warn('[aiRefine] 不可用，降级规则纲要:', e.message);
      return { ok: false, error: e.message };
    }
  },

  // ============================================================
  // 1. 文本清洗
  // ============================================================

  /** 口语/语气词/冗余词表 */
  FILLER_WORDS: new Set([
    // 语气词
    '啊','呀','呢','吧','哦','呃','嗯','哇','哈','嗨','喂','哎','唉','额','喔','咯','哒','咩','嘞',
    // 口语口头禅
    '然后','然后然后','那个那个','就是说','就是那个','对吧','你懂吧','你知道吧','你知道吗','你明白吧',
    '其实呢','其实啊','其实吧','我觉得吧','我认为吧','可能吧','大概吧','好像吧','应该吧',
    '对不对','是不是','有没有','对吧','是吧','嗯对','对对对','好好好','行行行',
    '接下来','然后呢','好的好的','OK','ok','okay','好','好的','没错','对的','是的',
    '那个','这个','这里','那里','这边','那边','前面','后面','上面','下面',
    // 重复/拖沓
    '非常非常','特别特别','真的真的','很很','好多好多','超级超级',
    // 直播/视频常见冗余
    '大家好','大家好啊','欢迎大家','欢迎回来','欢迎来到','今天给大家','今天我们','这期视频',
    '这个视频','这期','这一期','这节','这节课','这堂课','这段时间','之前','刚才','刚刚',
  ]),

  /** 清洗文本：剔除口语冗余 + 合并重复标点 + 修剪空白 */
  clean(raw) {
    if (!raw) return '';
    let s = String(raw);

    // 1. 移除 URL 中的 query 参数干扰（保留纯 URL）—— 仅对非 URL 场景
    // 2. 移除 HTML 标签残留
    s = s.replace(/<[^>]+>/g, ' ');

    // 3. 移除常见语气词/冗余词（整词替换，前后空格保护）
    this.FILLER_WORDS.forEach(word => {
      const re = new RegExp('\\b' + this._escapeReg(word) + '\\b', 'g');
      s = s.replace(re, ' ');
    });

    // 4. 中文语境下的短语替换（无空格分隔的口语词）
    s = s.replace(/然后/g, ' ');
    s = s.replace(/就是/g, ' ');
    s = s.replace(/那个/g, ' ');
    s = s.replace(/这个/g, ' ');
    s = s.replace(/其实/g, ' ');
    s = s.replace(/可能/g, ' ');
    s = s.replace(/大家好[啊呀]?/g, ' ');
    s = s.replace(/欢迎(大家|回来|来到)?/g, ' ');

    // 5. 合并重复标点
    s = s.replace(/([。！？,.!?:：；;])\1+/g, '$1');
    s = s.replace(/[.]{3,}/g, '…');

    // 6. 合并连续空白
    s = s.replace(/\s+/g, ' ').trim();

    // 7. 句号后自动加空格（英文标点）
    s = s.replace(/([.!?])\s*/g, '$1 ').trim();

    return s;
  },

  /** 简易正则转义 */
  _escapeReg(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  // ============================================================
  // 2. 关键词提取（中文简易版）
  // ============================================================

  /** 中文停用词表（常用虚词/代词/连词） */
  STOP_WORDS: new Set([
    '的','了','和','是','在','我','你','他','她','它','我们','你们','他们','它们',
    '这','那','些','什么','怎么','为什么','因为','所以','但是','而且','或者',
    '如果','虽然','尽管','不过','然而','因此','于是','还','又','也','都','就',
    '要','会','能','可以','应该','需要','已经','正在','将要','可以','不行','可以',
    '一下','一些','一点','一样','这样','那样','怎么样','哪','哪一个','哪里',
    '把','被','给','让','使','从','到','向','对','关于','对于','根据','通过',
    '上面','下面','里面','外面','中间','旁边','之前','之后','之间',
    'a','an','the','and','or','but','if','then','so','to','of','in','on','at','by','for','with','is','are','was','were','be','been','being',
  ]),

  /**
   * 从文本中提取关键词标签
   * @param {string} text     源文本
   * @param {number} maxCount 最多返回多少个标签
   * @returns {string[]}      关键词数组
   */
  extractKeywords(text, maxCount = 5) {
    if (!text) return [];

    // 1. 先清洗
    const cleaned = this.clean(text);
    if (cleaned.length < 3) return [];

    // 2. 分句 → 拆词（简易中文分词：2-4字滑窗 + 英文数字保留）
    const sentences = cleaned.split(/[。！？.!?；;\n]+/).filter(s => s.trim().length > 2);
    const wordFreq = new Map();

    sentences.forEach(sent => {
      // 提取英文/数字 token
      const engTokens = sent.match(/[a-zA-Z][a-zA-Z0-9+\-#/.]{1,}/g) || [];
      engTokens.forEach(t => {
        const w = t.toLowerCase();
        if (!this.STOP_WORDS.has(w) && w.length >= 2) {
          wordFreq.set(w, (wordFreq.get(w) || 0) + 2); // 英文词权重更高
        }
      });

      // 中文滑窗：2字、3字、4字
      const ngramCounts = new Map();
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i <= sent.length - n; i++) {
          const gram = sent.slice(i, i + n);
          if (/^[\u4e00-\u9fff]+$/.test(gram)) {
            ngramCounts.set(gram, (ngramCounts.get(gram) || 0) + 1);
          }
        }
      }
      // 过滤：去掉包含停用词开头/结尾的 gram，去掉单字停用词
      ngramCounts.forEach((freq, gram) => {
        if (this.STOP_WORDS.has(gram[0]) || this.STOP_WORDS.has(gram[gram.length - 1])) return;
        if (freq >= 2 || gram.length >= 3) {
          wordFreq.set(gram, (wordFreq.get(gram) || 0) + freq);
        }
      });
    });

    // 3. 排序取 Top N
    const sorted = [...wordFreq.entries()]
      .filter(([w]) => !this.STOP_WORDS.has(w.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCount * 2); // 多取一些后面去重

    // 4. 去重（短词被长词包含时保留长词）
    const selected = [];
    for (const [word] of sorted) {
      if (selected.some(s => s.includes(word) || word.includes(s))) continue;
      selected.push(word);
      if (selected.length >= maxCount) break;
    }

    return selected;
  },

  // ============================================================
  // 3. 摘要生成（抽取式）
  // ============================================================

  /** 从长文本中提取核心摘要（取前 1-2 个有实质内容的句子） */
  summarize(text, maxSentences = 2) {
    if (!text) return '';
    const cleaned = this.clean(text);
    const sentences = cleaned.split(/[。！？.!?]+/).map(s => s.trim()).filter(s => s.length > 6);
    if (sentences.length === 0) return cleaned.slice(0, 80) + (cleaned.length > 80 ? '…' : '');
    return sentences.slice(0, maxSentences).join('。') + '。';
  },

  // ============================================================
  // 4. 模拟短视频解析
  // ============================================================

  /**
   * 根据视频 URL 模拟解析，返回模拟的知识点
   * 不做真实爬虫，纯本地模拟
   */
  mockParseVideo(url) {
    const title = Helpers.extractUrlTitle(url);
    const domain = (() => {
      try { return new URL(url).hostname.replace('www.', ''); } catch { return 'unknown'; }
    })();

    // 视频平台 → 模拟分类关键词
    const platformHints = {
      'bilibili.com': { cat: '短视频通识知识', tags: ['B站', 'UP主', '科普'] },
      'youtube.com':  { cat: '短视频通识知识', tags: ['YouTube', '海外'] },
      'douyin.com':   { cat: '短视频通识知识', tags: ['抖音', '短视频'] },
      'kuaishou.com': { cat: '短视频通识知识', tags: ['快手'] },
      'xiaohongshu.com': { cat: '读书随笔摘录', tags: ['小红书', '笔记'] },
    };
    const hint = Object.entries(platformHints).find(([d]) => domain.includes(d))?.[1]
              || { cat: '短视频通识知识', tags: ['网络视频'] };

    // 模拟抽取的"精简知识点"（基于 URL 哈希生成伪随机但稳定的内容）
    const simulatedContents = [
      `视频来自 ${domain}，内容涉及热门话题讨论与观点分享。核心要点：创作者围绕主题展开多角度分析，引用了相关数据与案例作为佐证。`,
      `该视频为${hint.cat}类内容，时长约 8-12 分钟。主要讲解了基础概念、常见误区与实践技巧三个模块。`,
      `UP主/创作者以通俗易懂的方式讲解了${hint.tags.join('、')}等相关内容，适合入门级观众快速建立整体认知。`,
      `视频包含演示实操环节，展示了从问题发现到解决的完整流程，关键步骤有明确标注。`,
    ];
    const stableIdx = Math.abs(this._hashString(url)) % simulatedContents.length;

    return {
      title:   `${title} · 核心要点`,
      summary: simulatedContents[stableIdx],
      content: `${simulatedContents[stableIdx]}\n\n来源链接：${url}`,
      tags:    [...new Set([...hint.tags, ...this.extractKeywords(url + ' ' + simulatedContents[stableIdx], 3)])].slice(0, 6),
      suggestCategoryId: 'cat_video',
    };
  },

  /** 简易字符串哈希 */
  _hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h;
  },

  // ============================================================
  // 5. 模拟语音转写（课堂音频）
  // ============================================================

  /**
   * 根据音频文件名模拟语音转写 + 归纳重点
   * 不调用真实 ASR，纯本地模拟
   */
  mockTranscribeAudio(fileName) {
    // 从文件名中提取可能的关键词
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const nameTokens = baseName.split(/[\s_\-·.]+/).filter(Boolean);

    // 模拟转写的课堂记录（根据文件名生成伪随机但稳定的内容）
    const transcripts = [
      `本节课主要讲授了${baseName}的基本概念与核心原理。老师首先介绍了理论背景，然后通过例题演示了应用方法。课上强调了几个容易混淆的概念，并布置了课后习题。重点：理解定义、掌握推导过程、能独立完成相关习题。`,
      `${baseName}章节课堂笔记。教学内容包括：1）定义与历史背景；2）核心公式推导；3）典型应用案例；4）常见错误分析。老师在课堂上多次强调要理解而非死记硬背，并预留了答疑时间。`,
      `课堂录音整理：${baseName}。本节课覆盖面较广，老师从基础概念讲起，逐步深入到高级应用。中途有同学提问，老师做了详细解答。最后总结了三个核心要点，并预告了下节课内容。`,
    ];
    const stableIdx = Math.abs(this._hashString(fileName)) % transcripts.length;
    const transcript = transcripts[stableIdx];

    // 模拟重点归纳（从转写中提取关键词）
    const keyPoints = this.extractKeywords(transcript + ' ' + nameTokens.join(' '), 4);
    const summary = this.summarize(transcript, 2);

    return {
      title:   baseName || '课堂录音整理',
      summary,
      content: `【课堂录音转写整理】\n${transcript}\n\n【文件信息】${fileName}`,
      tags:    [...new Set([...keyPoints, ...nameTokens.filter(t => t.length > 1)])].slice(0, 6),
      suggestCategoryId: 'cat_class',
    };
  },

  // ============================================================
  // 6. 手动录入时的自动预处理
  // ============================================================

  /** 对手动录入的文本做预处理（清洗 + 自动打标签 + 生成摘要） */
  preprocessManual(text, title) {
    const cleaned = this.clean(text);
    const summary = this.summarize(cleaned, 2);
    const tags = this.extractKeywords(title + ' ' + cleaned, 5);

    return {
      cleaned,
      summary,
      tags,
    };
  },

  // ============================================================
  // 7. 拓展检索：构造搜索引擎 URL
  // ============================================================

  buildSearchUrl(keyword, engine = 'baidu') {
    const base = CONFIG.SEARCH_ENGINES[engine] || CONFIG.SEARCH_ENGINES.baidu;
    return base + encodeURIComponent(keyword);
  },
};
