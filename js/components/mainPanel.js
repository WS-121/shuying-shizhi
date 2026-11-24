/**
 * 疏影拾知 · 主面板组件 (MainPanel)
 * --------------------------------
 * 录入面板（短视频/音频/手动）+ 知识卡片网格 + 搜索/排序/拓展检索
 */

const MainPanel = {

  _currentTab: 'video',
  _currentCategoryId: 'all',
  _currentSort: 'createdAt',
  _currentKeyword: '',
  _selectedItemForEdit: null,
  _recognizer: null,   // Web Speech API 控制器
  _detailKeyHandler: null,

  async init() {
    this.bindTabEvents();
    this.bindInputEvents();
    this.bindFilterEvents();
    await this.refreshTextCategorySelect();
    // 页面加载时检测 speech 支持能力，更新 UI
    this.updateSpeechUI();
  },

  // ============ Tab ============
  bindTabEvents() {
    document.querySelectorAll('.input-tab').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
  },
  switchTab(tab) {
    this._currentTab = tab;
    document.querySelectorAll('.input-tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.classList.toggle('border-sage', on);
      b.classList.toggle('bg-sage/10', on);
      b.classList.toggle('text-sageDark', on);
      b.classList.toggle('border-border', !on);
      b.classList.toggle('text-mist', !on);
    });
    ['video', 'audio', 'text'].forEach(n => {
      document.getElementById(`input-${n}`).classList.toggle('hidden', n !== tab);
    });
    // 切换到 audio tab 时刷新 speech UI
    if (tab === 'audio') this.updateSpeechUI();
  },

  // ============ 录入事件 ============
  bindInputEvents() {
    document.getElementById('saveVideoBtn').addEventListener('click', () => this.saveVideo());

    // 视频兜底折叠区开关
    const manualToggle = document.getElementById('videoManualToggle');
    if (manualToggle) manualToggle.addEventListener('click', () => {
      document.getElementById('videoManualFallback').classList.toggle('hidden');
    });
    // 视频兜底保存（用手动输入的文本作为内容）
    const saveVideoManual = document.getElementById('saveVideoManualBtn');
    if (saveVideoManual) saveVideoManual.addEventListener('click', () => this.saveVideoManualFallback());

    const audioFile = document.getElementById('audioFile');
    const audioLabel = document.getElementById('audioLabel');
    audioFile.addEventListener('change', () => {
      if (audioFile.files.length) {
        audioLabel.innerHTML = `<i class="fa-solid fa-file-audio text-lg"></i>已选择：${audioFile.files[0].name}（${(audioFile.files[0].size/1024/1024).toFixed(1)} MB）`;
        // 上传即自动转写：选中文件后立刻开始 Whisper 转写，无需再点保存
        this.saveAudio();
      }
    });
    document.getElementById('saveAudioBtn').addEventListener('click', () => this.saveAudio());

    // ===== Web Speech API 录音按钮 =====
    const micBtn = document.getElementById('micRecordBtn');
    if (micBtn) {
      micBtn.addEventListener('click', () => this.toggleSpeechRecording());
    }

    document.getElementById('saveTextBtn').addEventListener('click', () => this.saveText());
  },

  /** 检查 speech 能力并更新 UI 提示 */
  updateSpeechUI() {
    const badge = document.getElementById('speechSupportBadge');
    if (!badge) return;
    const supported = Preprocessor.speechSupported();
    if (supported) {
      badge.innerHTML = '<i class="fa-solid fa-microphone text-sage"></i><span>浏览器支持实时语音转文字 ✨</span>';
      badge.className = 'text-xs text-sage flex items-center gap-2';
    } else {
      badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-ochre"></i><span>当前浏览器不支持 Web Speech API，请使用 Chrome / Edge</span>';
      badge.className = 'text-xs text-ochre flex items-center gap-2';
    }
  },

  // ============ 视频：真实 API 解析 + 兜底 ============

  /** 真实 API 解析主流程 */
  async saveVideo() {
    const urlEl = document.getElementById('videoUrl');
    const url = urlEl.value.trim();

    // 校验：空白 / 纯空格禁止提交
    if (!url) { urlEl.focus(); Helpers.toast('请填写视频链接（不能为空）'); return; }
    if (!/^https?:\/\//i.test(url)) { Helpers.toast('链接格式不正确，需以 http:// 或 https:// 开头'); return; }

    const btn = document.getElementById('saveVideoBtn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('opacity-60', 'cursor-not-allowed');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>解析视频要点中…';

    try {
      const parsed = await Preprocessor.parseVideoLink(url);
      const subtitle = (document.getElementById('videoSubtitle')?.value || '').trim();
      const hint = document.getElementById('videoSubtitleHint');
      const box = document.getElementById('videoSubtitleBox');

      if (subtitle.length >= 20) {
        // ===== 分支 A：有字幕文稿 → 大模型知识点萃取（剔除广告引流话术） =====
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles fa-spin mr-1"></i>大模型萃取知识点中…';
        const refined = await Preprocessor.aiRefine(`${parsed.title}\n${subtitle}`);
        if (refined.ok) {
          parsed.content = refined.text;
          parsed.summary = refined.text.split('\n').slice(0, 2).join(' ').slice(0, 100);
          parsed.sourceMeta = Object.assign({}, parsed.sourceMeta || {},
            { aiModel: refined.model, subtitle: subtitle.slice(0, 500) });
        } else {
          // 大模型不可用 → 规则纲要兜底（仍不填充引流文案）
          const outline = Preprocessor.generateOutline(subtitle, 5);
          parsed.content = outline || subtitle;
          parsed.summary = (outline || subtitle).slice(0, 100);
        }
        await this._doSaveVideoFromParsed(parsed, url);
        document.getElementById('videoSubtitle').value = '';
        if (box) box.classList.remove('ring-2', 'ring-crimson/40', 'rounded-md');
      } else {
        // ===== 分支 B：无字幕 → 自动下载音轨 + Whisper 转写（全自动解析） =====
        if (hint) {
          hint.innerHTML = '未检测到字幕，正在自动提取视频音轨并转写…（长视频需要等待几分钟）';
          hint.className = 'text-sage';
        }
        btn.innerHTML = '<i class="fa-solid fa-headphones fa-beat mr-1"></i>提取音轨并转写中…';

        const vt = await Preprocessor.transcribeVideoUrl(url);
        if (!vt.ok) {
          // 自动转写失败 → 友好提示引导粘贴字幕，禁止填充无效废话
          if (hint) {
            hint.innerHTML = `${vt.error}`;
            hint.className = 'text-crimson';
          }
          if (box) box.classList.add('ring-2', 'ring-crimson/40', 'rounded-md');
          document.getElementById('videoSubtitle').focus();
          Helpers.toast(vt.error, 5000);
          return; // 不落库：避免把引流废话当正文
        }

        // 标题兜底：解析失败时用音轨元数据的标题
        if ((!parsed.title || parsed.title.length < 4) && vt.title) parsed.title = vt.title;
        if (hint) {
          hint.innerHTML = '音轨转写完成，正在调用大模型萃取知识点…';
          hint.className = 'text-sage';
        }
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles fa-spin mr-1"></i>大模型萃取知识点中…';

        const refined = await Preprocessor.aiRefine(`${parsed.title}\n${vt.text}`);
        if (refined.ok) {
          parsed.content = refined.text;
          parsed.summary = refined.text.split('\n').slice(0, 2).join(' ').slice(0, 100);
        } else {
          const outline = Preprocessor.generateOutline(vt.text, 5);
          parsed.content = outline || vt.text;
          parsed.summary = (parsed.content || '').slice(0, 100);
        }
        parsed.sourceMeta = Object.assign({}, parsed.sourceMeta || {}, {
          url,
          autoTranscribed: true,
          whisperModel: vt.model,
          aiModel: refined.ok ? refined.model : null,
          rawTranscript: vt.text.slice(0, 3000),   // 原始转写留档，便于追溯
        });
        await this._doSaveVideoFromParsed(parsed, url);
        if (hint) {
          hint.innerHTML = '粘贴视频字幕文稿（推荐）：系统将调用大模型萃取知识点、剔除广告引流话术';
          hint.className = '';
        }
        if (box) box.classList.remove('ring-2', 'ring-crimson/40', 'rounded-md');
      }
    } catch (e) {
      Helpers.toast(e.message || '解析失败，请手动填写');
      document.getElementById('videoManualFallback').classList.remove('hidden');
      const mt = document.getElementById('videoManualToggle');
      if (mt) mt.checked = true;
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'cursor-not-allowed');
      btn.innerHTML = originalHTML;
    }
  },

  /** 内部：用解析结果落库（被主流程和兜底共用） */
  async _doSaveVideoFromParsed(parsed, url) {
    await DataService.addKnowledge({
      title:      parsed.title,
      content:    parsed.content,
      summary:    parsed.summary || '',
      tags:       parsed.tags || [],
      sourceType: CONFIG.SOURCE_TYPES.VIDEO,
      categoryId: parsed.suggestCategoryId || 'cat_video',
      sourceMeta: parsed.sourceMeta || { url, manualFallback: true },
    });

    Helpers.toast('✓ 已归档到「短视频通识知识」');
    document.getElementById('videoUrl').value = '';
    // 清空兜底
    const vmt = document.getElementById('videoManualTitle');
    const vmc = document.getElementById('videoManualContent');
    const vmtg = document.getElementById('videoManualTags');
    if (vmt) vmt.value = '';
    if (vmc) vmc.value = '';
    if (vmtg) vmtg.value = '';
    await App.refreshAll();
  },

  /** 兜底：手动填写视频要点 */
  async saveVideoManualFallback() {
    const url = document.getElementById('videoUrl').value.trim() || '(无链接)';
    const titleEl = document.getElementById('videoManualTitle');
    const contentEl = document.getElementById('videoManualContent');
    const tagsRaw = document.getElementById('videoManualTags').value.trim();

    const title = titleEl.value.trim();
    const content = contentEl.value.trim();

    // 兜底表单校验：title 和 content 不能同时为空或纯空格
    if (!title && !content) {
      contentEl.focus();
      Helpers.toast('请至少填写「标题」或「视频要点内容」');
      return;
    }

    const btn = document.getElementById('saveVideoManualBtn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>保存中…';

    try {
      const pre = Preprocessor.preprocessManual(content, title);
      const manualTags = tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      const tags = [...new Set([...manualTags, ...pre.tags])].slice(0, 6);

      await this._doSaveVideoFromParsed({
        title:   title || (pre.summary || content).slice(0, 30) + '…',
        summary: pre.summary,
        content: content || pre.cleaned || title,
        tags,
        suggestCategoryId: 'cat_video',
        sourceMeta: { url, manualFallback: true },
      }, url);
      document.getElementById('videoManualFallback').classList.add('hidden');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  },

  // ============ 音频：Web Speech API 录音 + 文件上传兜底 ============

  /** 切换录音状态（开始 / 停止） */
  toggleSpeechRecording() {
    const supported = Preprocessor.speechSupported();
    const micBtn = document.getElementById('micRecordBtn');
    const textarea = document.getElementById('speechTranscript');
    const stateBadge = document.getElementById('speechState');
    const indicator = document.getElementById('recordingIndicator');

    if (!supported) {
      Helpers.toast('当前浏览器不支持实时语音识别（推荐 Chrome / Edge）');
      return;
    }

    // 如果已经在录音 —— 停止
    if (this._recognizer?.isRunning) {
      this._recognizer.stop();
      return;
    }

    // 开始录音
    if (!this._recognizer) {
      this._recognizer = Preprocessor.createSpeechRecognizer({
        onResult: ({ full }) => {
          if (textarea) textarea.value = full;
        },
        onEnd: (finalText) => {
          micBtn.classList.remove('recording');
          micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> 开始录音';
          stateBadge?.classList.add('hidden');
          indicator?.classList.remove('active');
          indicator?.classList.remove('pulse');
          if (finalText && textarea) textarea.value = finalText;
        },
        onError: (err) => {
          console.warn('[Speech] error:', err);
          Helpers.toast('语音识别出错：' + err);
          micBtn.classList.remove('recording');
        },
        onStateChange: (state) => {
          if (state === 'recording') {
            micBtn.classList.add('recording');
            micBtn.innerHTML = '<i class="fa-solid fa-stop"></i> 停止录音';
            stateBadge?.classList.remove('hidden');
            indicator?.classList.add('active');
            indicator?.classList.add('pulse');
          }
        },
      });
    }

    try {
      textarea.value = '';
      this._recognizer.start();
      Helpers.toast('🎤 正在录音说话…（再次点击停止）');
    } catch (e) {
      Helpers.toast('启动录音失败：' + e.message);
    }
  },

  /** 保存音频（优先保存 speech 转写结果；没有则用文件上传） */
  async saveAudio() {
    const speechText = document.getElementById('speechTranscript')?.value?.trim();
    const file = document.getElementById('audioFile').files[0];
    const btn = document.getElementById('saveAudioBtn');

    // 前置校验：既没录音也没上传
    if ((!speechText || speechText.length < 2) && !file) {
      Helpers.toast('请先「录音」或「上传音频文件」，内容不能为空');
      return;
    }

    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>处理中…';

    try {
      // 优先用手动上传的文件（选中即自动转写）；没选文件时才用录音文本
      if (!file && speechText && speechText.length >= 3) {
        Helpers.toast('正在处理语音转写文本（清洗 + 关键词提取）…', 1500);
        const result = Preprocessor.processTranscript(speechText, '课堂录音整理');
        // AI 提炼：口语转写 → 知识点纲要（失败降级规则纲要）
        const refined = await Preprocessor.aiRefine(speechText);
        if (refined.ok) {
          result.content = refined.text;
          result.summary = refined.text.split('\n').slice(0, 2).join(' ').slice(0, 100);
        }
        await DataService.addKnowledge({
          title:      result.title,
          content:    result.content,
          summary:    result.summary,
          tags:       result.tags,
          sourceType: CONFIG.SOURCE_TYPES.AUDIO,
          categoryId: result.suggestCategoryId,
          sourceMeta: { source: 'web-speech', createdAt: Date.now() },
        });
        Helpers.toast('✓ 已归档语音转写 → 课堂课程知识点');
        document.getElementById('speechTranscript').value = '';
        await App.refreshAll();
        return;
      }

      // 没有 speech 结果 → 文件上传，调用 Whisper 真实转写
      if (file) {
        const loadingToast = Helpers.toast('Whisper 本地转写中…（首次会加载模型，请耐心等待）', 0);
        let transcript = '';

        try {
          const whisperResult = await Preprocessor.transcribeAudio(file);
          transcript = whisperResult.text;
          console.log('[saveAudio] Whisper 转写成功:', whisperResult.source, whisperResult.model,
                      '长度:', transcript.length);
        } catch (e) {
          // Whisper 不可用（未装）→ 降级：给用户明确提示 + 保留文件记录
          console.warn('[saveAudio] Whisper 不可用，降级为文件名归档:', e.message);
          Helpers.dismissToast();
          const parsed = Preprocessor.mockTranscribeAudio(file.name);
          await DataService.addKnowledge({
            title:      parsed.title,
            content:    parsed.content,
            summary:    parsed.summary,
            tags:       parsed.tags,
            sourceType: CONFIG.SOURCE_TYPES.AUDIO,
            categoryId: parsed.suggestCategoryId,
            sourceMeta: { fileName: file.name, fileSize: file.size, fileType: file.type,
                          note: 'Whisper 未安装，已用文件名归档。执行 pip install openai-whisper + winget install ffmpeg 后重启本地代理即可真实转写' },
          });
          Helpers.toast('✓ 已归档文件（Whisper 未装，提示已写入备注）');
          document.getElementById('audioFile').value = '';
          await App.refreshAll();
          return;
        }

        // Whisper 成功 → 真实转写 → 清洗 + 关键词提取
        if (!transcript || transcript.trim().length < 5) {
          Helpers.dismissToast();
          Helpers.toast('音频内容过短或识别为空，请检查文件质量后重试');
          return;
        }

        Helpers.toast('转写完成，正在生成知识点纲要…', 0);
        const parsed = Preprocessor.processTranscript(transcript, file.name);
        // AI 提炼：Whisper 原始转写 → 知识点纲要（失败降级规则纲要，原始转写仍存 sourceMeta）
        const refined = await Preprocessor.aiRefine(transcript);
        if (refined.ok) {
          parsed.content = refined.text;
          parsed.summary = refined.text.split('\n').slice(0, 2).join(' ').slice(0, 100);
        }
        await DataService.addKnowledge({
          title:      parsed.title,
          content:    parsed.content,      // AI 知识点纲要（失败时为规则纲要）
          summary:    parsed.summary,
          tags:       parsed.tags,
          sourceType: CONFIG.SOURCE_TYPES.AUDIO,
          categoryId: parsed.suggestCategoryId,
          sourceMeta: { source: 'whisper', filename: file.name, fileSize: file.size,
                        fileType: file.type, rawTranscript: transcript,
                        aiModel: refined.ok ? refined.model : null },
        });
        Helpers.dismissToast();
        Helpers.toast('✓ Whisper 转写完成，已归档到「课堂课程知识点」');
        document.getElementById('audioFile').value = '';
        document.getElementById('audioLabel').innerHTML =
          '<i class="fa-solid fa-cloud-arrow-up text-lg"></i>点击上传课堂音频（.mp3 / .wav / .m4a），选中后自动转写';
        await App.refreshAll();
      }
    } catch (e) { Helpers.toast(e.message || '保存失败'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  },

  /** 手动录入：预处理 + 自动打标签 + 用户选分类 */
  async saveText() {
    const titleEl = document.getElementById('textTitle');
    const contentEl = document.getElementById('textContent');
    const title = titleEl.value.trim();
    const content = contentEl.value.trim();

    // 校验：标题和正文不能同时为空或纯空格
    if (!title && !content) {
      contentEl.focus();
      Helpers.toast('请至少填写「标题」或「正文内容」');
      return;
    }

    const btn = document.getElementById('saveTextBtn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>清洗文本 + 提取关键词中…';

    try {
      const catId = document.getElementById('textCategory').value;
      Helpers.toast('正在清洗文本 + 提取关键词…', 1200);
      const pre = Preprocessor.preprocessManual(content, title);

      await DataService.addKnowledge({
        title:      title || (pre.summary || content).slice(0, 30) + '…',
        content:    pre.cleaned || content,
        summary:    pre.summary,
        tags:       pre.tags,
        sourceType: CONFIG.SOURCE_TYPES.TEXT,
        categoryId: catId,
      });

      Helpers.toast('✓ 已归档');
      titleEl.value = '';
      contentEl.value = '';
      await App.refreshAll();
    } catch (e) { Helpers.toast(e.message || '保存失败'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  },

  /** 手动录入面板分类下拉动态填充 */
  async refreshTextCategorySelect() {
    const sel = document.getElementById('textCategory');
    const cats = await DataService.getCategories();
    sel.innerHTML = cats.map(c => `<option value="${c.id}">${Helpers.escapeHtml(c.name)}</option>`).join('');
  },

  // ============ 筛选 ============
  bindFilterEvents() {
    document.getElementById('sortSelect').addEventListener('change', e => {
      this._currentSort = e.target.value;
      this.renderCards();
    });
    document.getElementById('searchInput').addEventListener('input', e => {
      this._currentKeyword = e.target.value.trim();
      this.renderCards();
    });
  },

  onCategoryChange(catId) {
    this._currentCategoryId = catId;
    this.renderCards();
  },

  // ============ 卡片渲染 ============

  async renderCards() {
    const gridEl = document.getElementById('cardGrid');
    const emptyEl = document.getElementById('emptyHint');
    const countEl = document.getElementById('cardCount');
    const catNameEl = document.getElementById('currentCatName');

    // 获取数据（支持跨分类搜索）
    let items = this._currentKeyword
      ? await DataService.searchKnowledge(this._currentKeyword, this._currentCategoryId)
      : await DataService.getKnowledgeByCategory(this._currentCategoryId);

    // 排序
    items.sort((a, b) => {
      switch (this._currentSort) {
        case 'reviewDate': return a.nextReviewAt - b.nextReviewAt;
        case 'title':      return (a.title || '').localeCompare(b.title || '', 'zh');
        default:           return b.createdAt - a.createdAt;
      }
    });

    // 标题
    if (this._currentKeyword) {
      catNameEl.innerHTML = `搜索: "${Helpers.escapeHtml(this._currentKeyword)}"`;
    } else if (this._currentCategoryId === 'all') {
      catNameEl.textContent = '全部知识点';
    } else {
      const cat = await DataService.getCategoryById(this._currentCategoryId);
      catNameEl.textContent = cat ? cat.name : '—';
    }
    countEl.textContent = items.length;

    if (items.length === 0) {
      gridEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      emptyEl.querySelector('p').textContent = this._currentKeyword ? '没有匹配的知识点' : '此分类下暂无知识点';
      return;
    }
    emptyEl.classList.add('hidden');

    // 渲染卡片
    const now = Date.now();
    const sourceLabel = (t) => CONFIG.SOURCE_LABELS[t] || '文本';

    const cardsHtml = items.map(item => {
      const dueSoon = item.nextReviewAt <= now;
      const actionLabel = dueSoon ? '立即复习' : '标记已复习';
      const actionIcon = dueSoon ? 'fa-bolt' : 'fa-check';
      const tagsHtml = (item.tags || []).slice(0, 4).map(t => `<span>${Helpers.escapeHtml(t)}</span>`).join('');
      const summaryHtml = item.summary ? `<div class="card-summary"><i class="fa-solid fa-quote-left text-sage mr-1 text-xs"></i>${Helpers.escapeHtml(item.summary)}</div>` : '';
      const contentClass = item.sourceType === 'video' ? 'video-link' : item.sourceType === 'audio' ? 'audio-info' : '';
      const contentText = item.sourceType === 'video'
        ? (item.sourceMeta?.url ? item.sourceMeta.url : item.content)
        : item.content;

      return `
        <div class="card ${dueSoon ? 'due-soon' : ''}" data-id="${item.id}">
          <div class="card-header">
            <span class="card-tag source-${item.sourceType}">${sourceLabel(item.sourceType)}</span>
            <h3 class="card-title" title="${Helpers.escapeHtml(item.title)}">${Helpers.escapeHtml(item.title)}</h3>
          </div>
          ${summaryHtml}
          ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
          <div class="card-content ${contentClass}">${Helpers.escapeHtml(contentText)}</div>
          <div class="card-footer">
            <div>
              <i class="fa-regular fa-clock mr-1"></i>${Helpers.friendlyDate(item.createdAt)}
              <span class="mx-1">·</span>
              <i class="fa-solid fa-arrows-rotate mr-1"></i>已复习 ${item.reviewCount} 次
              ${dueSoon ? `<span class="mx-1">·</span><span class="text-crimson"><i class="fa-solid fa-exclamation-circle"></i> 待复习</span>` : ''}
            </div>
            <div class="card-actions">
              <button class="btn-review" title="${actionLabel}"><i class="fa-solid ${actionIcon}"></i></button>
              <button class="btn-edit" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
              <button class="btn-search search" title="拓展检索"><i class="fa-solid fa-globe"></i></button>
              <button class="btn-del danger" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    gridEl.innerHTML = cardsHtml;

    // 事件绑定
    gridEl.querySelectorAll('.card').forEach(card => {
      const id = card.dataset.id;

      // 点击卡片任意位置（按钮区域除外）打开详情弹窗
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.openDetailModal(id);
      });

      card.querySelector('.btn-review').addEventListener('click', () => this._markReviewed(id));
      card.querySelector('.btn-edit').addEventListener('click', () => this.openEditModal(id));
      card.querySelector('.btn-search').addEventListener('click', () => this._extendSearch(id));
      card.querySelector('.btn-del').addEventListener('click', () => this._deleteItem(id));
    });
  },

  // ============ 卡片操作（卡片与详情弹窗共用，行为完全一致） ============

  async _markReviewed(id) {
    try {
      const u = await DataService.markReviewed(id);
      Helpers.toast(`已复习 ✓ 下次 ${Helpers.friendlyDate(u.nextReviewAt)}`);
      await App.refreshAll();
      return u;
    } catch (e) { Helpers.toast(e.message); return null; }
  },

  async _extendSearch(id) {
    const item = await DataService.getKnowledgeById(id);
    if (!item) return;
    const kw = [...(item.tags || []), item.title].filter(Boolean).slice(0, 3).join(' ');
    const url = Preprocessor.buildSearchUrl(kw || item.title, 'baidu');
    window.open(url, '_blank');
  },

  _deleteItem(id) {
    App.confirm('删除知识点？', '删除后无法恢复，确认操作？', async () => {
      try {
        await DataService.deleteKnowledge(id);
        Helpers.toast('已删除');
        await App.refreshAll();
      } catch (e) { Helpers.toast(e.message); }
    });
  },

  // ============ 知识点详情弹窗 ============

  async openDetailModal(id) {
    const item = await DataService.getKnowledgeById(id);
    if (!item) { Helpers.toast('知识点不存在或已删除'); await App.refreshAll(); return; }

    const modal = document.getElementById('detailModal');
    if (!modal) return;

    await this._fillDetail(item);
    modal.classList.add('active');

    // 关闭：右上角按钮 / 点击遮罩 / Esc
    document.getElementById('detailClose').onclick = () => this.closeDetailModal();
    modal.onclick = (e) => { if (e.target === modal) this.closeDetailModal(); };
    if (this._detailKeyHandler) document.removeEventListener('keydown', this._detailKeyHandler);
    this._detailKeyHandler = (ev) => { if (ev.key === 'Escape') this.closeDetailModal(); };
    document.addEventListener('keydown', this._detailKeyHandler);

    // 底部操作：与卡片按钮完全一致
    document.getElementById('detailReviewBtn').onclick = async () => {
      const updated = await this._markReviewed(id);
      if (updated) await this._fillDetail(updated);
    };
    document.getElementById('detailEditBtn').onclick = () => {
      this.closeDetailModal();
      this.openEditModal(id);
    };
    document.getElementById('detailSearchBtn').onclick = () => this._extendSearch(id);
    document.getElementById('detailDelBtn').onclick = () => {
      this.closeDetailModal();
      this._deleteItem(id);
    };
  },

  closeDetailModal() {
    const modal = document.getElementById('detailModal');
    if (modal) modal.classList.remove('active');
    if (this._detailKeyHandler) {
      document.removeEventListener('keydown', this._detailKeyHandler);
      this._detailKeyHandler = null;
    }
  },

  /** 填充详情弹窗内容 */
  async _fillDetail(item) {
    const cat = await DataService.getCategoryById(item.categoryId);

    const srcTag = document.getElementById('detailSourceTag');
    srcTag.className = `card-tag source-${item.sourceType}`;
    srcTag.textContent = CONFIG.SOURCE_LABELS[item.sourceType] || '文本';

    document.getElementById('detailTitle').textContent = item.title || '未命名知识点';
    document.getElementById('detailCategory').textContent = cat ? cat.name : '未分类';
    document.getElementById('detailCreated').textContent = Helpers.formatDateTime(item.createdAt);
    document.getElementById('detailReviewCount').textContent = item.reviewCount || 0;
    document.getElementById('detailNextReview').textContent =
      `${Helpers.formatDate(item.nextReviewAt)}（${Helpers.friendlyDate(item.nextReviewAt)}）`;

    const tags = item.tags || [];
    const tagsWrap = document.getElementById('detailTagsWrap');
    tagsWrap.innerHTML = tags.map(t => `<span>${Helpers.escapeHtml(t)}</span>`).join('');
    tagsWrap.style.display = tags.length ? '' : 'none';

    const url = item.sourceMeta?.url || '';
    const linkWrap = document.getElementById('detailLinkWrap');
    if (/^https?:\/\//i.test(url)) {
      const a = document.getElementById('detailLink');
      a.href = url;
      a.textContent = url;
      linkWrap.style.display = '';
    } else {
      linkWrap.style.display = 'none';
    }

    document.getElementById('detailContent').textContent = item.content || '（暂无正文）';

    const due = item.nextReviewAt <= Date.now();
    document.getElementById('detailReviewBtn').innerHTML =
      due ? '<i class="fa-solid fa-bolt mr-1"></i>立即复习' : '<i class="fa-solid fa-check mr-1"></i>标记已复习';
  },

  // ============ 编辑 ============

  async openEditModal(id) {
    const item = await DataService.getKnowledgeById(id);
    if (!item) return;
    this._selectedItemForEdit = item;

    // 填充分类 & 来源下拉
    const catSel = document.getElementById('editCategory');
    const srcSel = document.getElementById('editSource');
    const cats = await DataService.getCategories();
    catSel.innerHTML = cats.map(c => `<option value="${c.id}" ${c.id === item.categoryId ? 'selected' : ''}>${Helpers.escapeHtml(c.name)}</option>`).join('');
    srcSel.innerHTML = Object.entries(CONFIG.SOURCE_LABELS)
      .map(([k, v]) => `<option value="${k}" ${k === item.sourceType ? 'selected' : ''}>${v}</option>`).join('');

    document.getElementById('editId').value = item.id;
    document.getElementById('editTitle').value = item.title;
    document.getElementById('editContent').value = item.content;
    document.getElementById('editTags').value = (item.tags || []).join(', ');

    const modal = document.getElementById('editModal');
    modal.classList.add('active');

    const close = () => { modal.classList.remove('active'); cleanup(); };
    const cleanup = () => {
      document.getElementById('editCancel').removeEventListener('click', close);
      document.getElementById('editConfirm').removeEventListener('click', doSave);
    };
    const doSave = async () => {
      const patch = {
        title: document.getElementById('editTitle').value.trim() || item.title,
        content: document.getElementById('editContent').value.trim(),
        categoryId: document.getElementById('editCategory').value,
        sourceType: document.getElementById('editSource').value,
        tags: document.getElementById('editTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      };
      try {
        await DataService.updateKnowledge(item.id, patch);
        Helpers.toast('已保存修改');
        close();
        await App.refreshAll();
      } catch (e) { Helpers.toast(e.message); }
    };
    document.getElementById('editCancel').addEventListener('click', close);
    document.getElementById('editConfirm').addEventListener('click', doSave);
  },
};
