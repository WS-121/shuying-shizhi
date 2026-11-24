/**
 * 疏影拾知 · 右侧面板组件 (RightPanel)
 * -------------------------------------
 * 艾宾浩斯待复习 + 三图表（饼图 / 热力图 / 趋势图）
 */

const RightPanel = {

  _charts: { pie: null, heat: null, trend: null },

  init() {
    window.addEventListener('resize', () => this.resizeCharts());

    // 小窗（<900px）下数据看板折叠为右侧抽屉
    this._bindDrawer();

    // 容器尺寸变化（侧栏折叠、窗口缩放、内容增减）时自动重绘，避免 canvas 尺寸滞后
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        clearTimeout(this._roTimer);
        this._roTimer = setTimeout(() => {
          this.resizeCharts();
          // 宽屏下右侧面板由隐藏变为可见时，补一次渲染
          if (!this._hasRender) this.refreshCharts();
        }, 80);
      });
      ['chartPie', 'chartHeat', 'chartTrend'].forEach(id => {
        const el = document.getElementById(id);
        if (el) this._ro.observe(el);
      });
    }
  },

  /** 小窗抽屉：悬浮按钮打开，遮罩 / 关闭按钮 / Esc 关闭 */
  _bindDrawer() {
    const aside = document.getElementById('rightPanel');
    const toggle = document.getElementById('rightPanelToggle');
    const backdrop = document.getElementById('rightPanelBackdrop');
    const closeBtn = document.getElementById('rightPanelClose');
    if (!aside) return;

    const closeDrawer = () => {
      aside.classList.remove('drawer-open');
      if (backdrop) backdrop.classList.remove('show');
    };
    const openDrawer = () => {
      aside.classList.add('drawer-open');
      if (backdrop) backdrop.classList.add('show');
      // 抽屉滑入后按可见尺寸重绘图表
      setTimeout(() => this.resizeCharts(), 260);
    };

    if (toggle) toggle.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
    // 回到桌面宽度时复位抽屉状态
    window.addEventListener('resize', () => { if (window.innerWidth >= 900) closeDrawer(); });
  },

  _initCharts() {
    if (typeof echarts === 'undefined') {
      console.warn('[RightPanel] ECharts 未加载');
      return false;
    }
    const pieDom = document.getElementById('chartPie');
    const heatDom = document.getElementById('chartHeat');
    const trendDom = document.getElementById('chartTrend');
    if (!pieDom || !heatDom || !trendDom) return false;
    if (this._charts.pie) return true;

    this._charts.pie   = echarts.init(pieDom);
    this._charts.heat  = echarts.init(heatDom);
    this._charts.trend = echarts.init(trendDom);
    return true;
  },

  resizeCharts() {
    Object.values(this._charts).forEach(c => c && c.resize());
  },

  // ==================== 复习提醒 ====================

  async renderReviewList() {
    const listEl = document.getElementById('reviewList');
    const countEl = document.getElementById('dueCount');
    const dueList = await DataService.getDueReviewList();
    countEl.textContent = dueList.length;

    if (dueList.length === 0) {
      listEl.innerHTML = `
        <li class="text-center py-6 text-mist text-xs">
          <i class="fa-solid fa-circle-check text-sage text-2xl mb-2 block"></i>
          太棒了！当前没有待复习知识点<br/>继续保持～
        </li>`;
      return;
    }

    const now = Date.now();
    const html = dueList.slice(0, 10).map(item => {
      const overdue = item.nextReviewAt < now;
      return `
        <li class="review-item ${overdue ? 'due-today' : ''}" data-id="${item.id}">
          <div class="review-title" title="${Helpers.escapeHtml(item.title)}">${Helpers.escapeHtml(item.title)}</div>
          <div class="review-meta">
            <span><i class="fa-solid fa-arrows-rotate"></i> 已复习 ${item.reviewCount} 次</span>
            <span class="${overdue ? 'text-crimson' : 'text-sage'}">
              <i class="fa-solid ${overdue ? 'fa-exclamation-circle' : 'fa-clock'}"></i>
              ${Helpers.friendlyDate(item.nextReviewAt)}
            </span>
          </div>
        </li>`;
    }).join('');

    listEl.innerHTML = html;

    listEl.querySelectorAll('.review-item').forEach(li => {
      li.addEventListener('click', async () => {
        try {
          const u = await DataService.markReviewed(li.dataset.id);
          Helpers.toast(`已完成复习，下次 ${Helpers.friendlyDate(u.nextReviewAt)}`);
          await App.refreshAll();
        } catch (e) { Helpers.toast(e.message); }
      });
    });
  },

  // ==================== 图表 ====================

  /** 读取当前主题下的图表颜色 */
  _chartColors() {
    const dark = document.body.classList.contains('dark');
    return {
      text:     dark ? '#e8e4df' : '#3d3835',
      subText:  dark ? '#9a938d' : '#6b6460',
      grid:     dark ? '#3a3734' : '#e8e2d8',
      gridArea: dark ? '#2d2a27' : '#f0ece3',
      bg:       dark ? '#282623' : '#fbf9f5',
      palette: ['#8fa68e', '#c08a5a', '#6b7fa0', '#a85c5c', '#b5a3c9', '#d4a574', '#7fa89c'],
    };
  },

  async _renderCharts(retry = 0) {
    if (!this._initCharts()) { setTimeout(() => this.refreshCharts(), 200); return; }

    // 窄屏时右侧面板可能为抽屉（有尺寸但移出视野），仅真正无尺寸时才跳过
    const panel = document.getElementById('rightPanel');
    if (!panel || panel.clientWidth === 0 || panel.clientHeight === 0) return;

    // 布局尚未稳定时容器可能是 0 尺寸，稍后重试（限制次数，避免死循环）
    const heatDom = document.getElementById('chartHeat');
    if ((!heatDom || heatDom.clientHeight === 0) && retry < 5) {
      setTimeout(() => this.refreshCharts(retry + 1), 200);
      return;
    }

    const stats = await DataService.getStats();
    const C = this._chartColors();

    // ============ 1. 分类占比饼图 ============
    const pieData = stats.catCount.filter(c => c.count > 0).map(c => ({ name: c.name, value: c.count }));

    this._charts.pie.setOption({
      title: {
        text: '分类占比', left: 'center', top: 2,
        textStyle: { fontSize: 12, color: C.text, fontWeight: 'normal' },
      },
      tooltip: {
        trigger: 'item', confine: true,
        textStyle: { color: C.text, fontSize: 12 },
        backgroundColor: C.bg, borderColor: C.grid,
        formatter: '{b}: {c} 条 ({d}%)',
      },
      legend: { orient: 'vertical', right: 2, top: 20, itemWidth: 8, itemHeight: 8,
        textStyle: { color: C.subText, fontSize: 10 }, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['40%', '66%'], center: ['38%', '56%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: C.bg, borderWidth: 2, borderRadius: 3 },
        label: { show: false }, labelLine: { show: false },
        data: pieData.length > 0 ? pieData : [{ name: '暂无数据', value: 1, itemStyle: { color: C.grid } }],
        color: C.palette,
      }],
    }, true);

    // ============ 2. 近 90 天录入热力图（自然周 × 星期） ============
    const heat = this._buildHeatData(stats.heatmap);

    this._charts.heat.setOption({
      title: {
        text: '近 90 天录入热力图', left: 'center', top: 2,
        textStyle: { fontSize: 12, color: C.text, fontWeight: 'normal' },
      },
      tooltip: {
        confine: true,
        textStyle: { color: C.text, fontSize: 12 }, backgroundColor: C.bg, borderColor: C.grid,
        formatter: p => {
          const it = p.data || {};
          const dayCount = (it.value && it.value[2]) || 0;
          const md = it.date ? `${Number(it.date.slice(5, 7))}/${Number(it.date.slice(8, 10))}` : '';
          return `第${it.week}周：录入 ${it.weekTotal || 0} 条<br/>${md} 当天 ${dayCount} 条`;
        },
      },
      grid: { top: 26, bottom: 20, left: 26, right: 8 },
      xAxis: {
        type: 'category', data: heat.weeks,
        splitArea: { show: true, areaStyle: { color: [C.gridArea, C.bg] } },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: {
          color: C.subText, fontSize: 9,
          interval: Math.max(0, Math.ceil(heat.weeks.length / 5) - 1), // 只显示约 5 个日期刻度
        },
      },
      yAxis: {
        type: 'category', data: ['一', '二', '三', '四', '五', '六', '日'],
        inverse: true,
        splitArea: { show: true, areaStyle: { color: [C.gridArea, C.bg] } },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.subText, fontSize: 9 }, // 高度不足时由 ECharts 自动抽稀，避免刻度重叠
      },
      visualMap: {
        min: 0, max: Math.max(2, heat.maxDayCount), show: false,
        inRange: { color: ['#f0ece3', '#c5d4c2', '#8fa68e', '#5f755e'] },
      },
      series: [{
        type: 'heatmap', data: heat.data,
        itemStyle: { borderColor: C.bg, borderWidth: 1, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: C.text, borderWidth: 1 } },
      }],
    }, true);

    // ============ 3. 学习趋势（近 30 天真实数据） ============
    const trendData = stats.trend.map(t => t.count);
    const trendDates = stats.trend.map(t => t.date);
    const maxCount = Math.max(1, ...trendData);

    this._charts.trend.setOption({
      title: {
        text: '近 30 日学习趋势', left: 'center', top: 2,
        textStyle: { fontSize: 12, color: C.text, fontWeight: 'normal' },
      },
      tooltip: {
        trigger: 'axis', confine: true,
        textStyle: { color: C.text, fontSize: 12 }, backgroundColor: C.bg, borderColor: C.grid,
        formatter: params => {
          const p = params[0] || {};
          return `${p.axisValue}：录入 ${p.value} 条`;
        },
      },
      grid: { top: 26, bottom: 20, left: 30, right: 10 },
      xAxis: { type: 'category', data: trendDates, boundaryGap: false,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.subText, fontSize: 9, interval: 5 }, axisTick: { show: false } },
      yAxis: { type: 'value', minInterval: 1, max: Math.max(5, maxCount + 2),
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: C.gridArea, type: 'dashed' } },
        axisLabel: { color: C.subText, fontSize: 10 } },
      series: [{
        name: '新增', type: 'line', smooth: true, symbol: 'circle', symbolSize: 4,
        data: trendData,
        lineStyle: { color: '#8fa68e', width: 2 },
        itemStyle: { color: '#8fa68e' },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(143,166,142,0.35)' },
          { offset: 1, color: 'rgba(143,166,142,0.02)' },
        ])},
      }],
    }, true);

    // 图表尺寸跟随容器自适应（setOption 后容器尺寸可能已变化）
    requestAnimationFrame(() => this.resizeCharts());
    this._hasRender = true;
  },

  /**
   * 构建近 90 天热力图数据：按真实自然周（周一至周日）排列
   * @param {Array<[string, number]>} dailyList [['YYYY-MM-DD', 当日条数], ...]
   * @returns {{ data: Array, weeks: string[], maxDayCount: number }}
   */
  _buildHeatData(dailyList) {
    const DAY = 24 * 60 * 60 * 1000;
    const countMap = new Map(dailyList || []);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 89);
    // 起点回退到所在周的周一，保证每一列恰好是一个自然周
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    const weekCount = Math.floor((today - start) / (7 * DAY)) + 1;
    const weeks = [];
    for (let w = 0; w < weekCount; w++) {
      const d = new Date(start);
      d.setDate(d.getDate() + w * 7);
      weeks.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }

    const data = [];
    const weekTotals = new Array(weekCount).fill(0);
    const days = Math.floor((today - start) / DAY) + 1;
    let maxDayCount = 0;

    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const count = countMap.get(key) || 0;
      const weekIdx = Math.floor(i / 7);
      const dow = (d.getDay() + 6) % 7; // 周一=0 ... 周日=6
      if (weekIdx < 0 || weekIdx >= weekCount) continue;
      weekTotals[weekIdx] += count;
      maxDayCount = Math.max(maxDayCount, count);
      data.push({ value: [weekIdx, dow, count], date: key, week: weekIdx + 1, weekTotal: 0 });
    }

    // 回填每周合计（tooltip 使用）
    data.forEach(item => { item.weekTotal = weekTotals[item.value[0]]; });

    return { data, weeks, maxDayCount };
  },

  async refreshCharts(retry = 0) {
    await this._renderCharts(retry);
  },
};
