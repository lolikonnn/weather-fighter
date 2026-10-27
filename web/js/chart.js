/* ═══════════════════════════════════════════════════════════════
   chart.js — ECharts 行情图（分时 / 7日 / 日K / 周K / 月K / 预报K + 副图）
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { fx, sgn, parseDate, weekday } = U;

  /** 聚合柱（周K / 月K）上缺的字段从 `raw` 里补算平均。
      `indicators.js` 的 aggregate() 造出来的柱子只有 `{d,o,h,l,c,v,n,raw}` ——
      **没有 range / windAvg / humAvg**。所以这几个口径在周K / 月K 下不能直接读字段，
      否则拿到一堆 undefined：柱子画不出来，而且**不报错**（ECharts 收到 undefined 就是空柱）。 */
  function aggMean(b, field) {
    if (b[field] != null) return b[field];
    const r = b.raw || [];
    let s = 0, c = 0;
    for (let i = 0; i < r.length; i++) {
      const v = r[i] && r[i][field];
      if (v != null && isFinite(v)) { s += v; c++; }
    }
    return c ? +(s / c).toFixed(2) : null;
  }

  const METRICS = {
    /* ⚠ 温差在周K / 月K 下要**现算 h − l**：聚合柱上没有 range 字段。
       定义跟日K 完全一致（这段时间的最高 − 最低），只是因为柱子变粗了，
       区间从"一天"变成"一周 / 一个月"。 */
    range: {
      label: '日内温差', unit: '℃',
      get: b => (b.range != null ? b.range : ((b.h != null && b.l != null) ? +(b.h - b.l).toFixed(1) : null))
    },
    precip: { label: '降水量', unit: 'mm', get: b => b.v },
    wind: { label: '平均风速', unit: 'm/s', get: b => aggMean(b, 'windAvg') },
    humid: { label: '平均湿度', unit: '%', get: b => aggMean(b, 'humAvg') },
    /* 逐小时那两档（分时 / 7日）的「温差」用的口径：这一小时的气温比**当天平均**冷暖多少。
       为什么不用 range：日内温差是"每天"的量，一天一个数，摊到 24 个小时上就是一条平线
       （分时档下整幅图只有一根柱子，等于没信息）。见 app.js 的 renderVolSub。 */
    dev: { label: '较当日均温', unit: '℃', get: b => b.dev }
  };

  /** 简单均线：窗口内**非空值**的平均。
      ⚠ 窗口不满时（前 n−1 格）**用现有的几根平均，不返回 null**。
      为什么不能留 null：`echarts.connect('tjs')` 的悬停联动是**按 seriesIndex 映射**的 ——
      主图第 1 系列是「气温」、副图第 1 系列是「MA5」。MA5 如果在前几格是 null，
      主图悬停到那几格时映射过来落不到数据上，**副图的信息窗格就弹不出来**
      （用户报的"7日+温差，MA5 从 04:00 才开始有，之前悬停副图不弹窗"）。
      K 线那几档之所以一直没事：主图第 0 系列是蜡烛、副图第 0 系列是柱子，两边都有数。 */
  function MA(arr, n) {
    return arr.map((_, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - n + 1); k <= i; k++) {
        const v = arr[k];
        if (v != null && isFinite(v)) { s += v; c++; }
      }
      return c ? +(s / c).toFixed(2) : null;
    });
  }

  /** K 线 tooltip 的标题。
      日K / 周K 的键是完整日期（周K 是那一周的周一），所以能带上星期几；
      月K 的键只有 'YYYY-MM'，拼不出星期几 —— 别硬拼，改成 "2025 年 11 月"。 */
  function tipTitle(d) {
    const w = weekday(d);
    if (w) return d + ' ' + w;
    const m = /^(\d{4})-(\d{2})$/.exec(String(d));
    return m ? m[1] + ' 年 ' + (+m[2]) + ' 月' : String(d);
  }

  const C = {
    bg: 'transparent',
    axis: '#39404e',
    split: '#1e232d',
    label: '#7b8291',
    labelHi: '#c9cdd6',
    ma: ['#e9edf4', '#ffd666', '#d16dff', '#2bd6a0', '#4d9bff'],
    maName: ['MA5', 'MA10', 'MA20', 'MA30', 'MA60'],
    up: '#ff4d4f', down: '#00b578',
    // 平盘（开盘 == 收盘，气温没升没降）。**现在是绿色** ——
    // 使用者明确要求"持平的灰色改为绿色"，所以它不再是中性灰。
    // 这里只是兜底默认值，真实颜色由 readTheme() 从 CSS 的 `--flat` 读。
    flat: '#00b578',
    boll: ['#ffb74d', '#7f8fa6', '#4fc3f7'],
    dif: '#e9edf4', dea: '#ffd666',
    k: '#e9edf4', d: '#ffd666', j: '#d16dff',
    wr: ['#e9edf4', '#ffd666'],
    avg: '#ffd666',
    base: '#6b7280',
    // 多日分时图的"日界"明暗带：第 1/3/5 天亮、第 2/4 天暗。
    // 原来的 .022 白几乎看不见，等于没画；这里拉到肉眼可辨的程度。
    bandLight: 'rgba(148,178,232,.075)',
    bandDark: 'rgba(0,0,0,.28)'
  };

  function readTheme() {
    const s = getComputedStyle(document.body);
    const up = s.getPropertyValue('--up').trim(), dn = s.getPropertyValue('--down').trim();
    const fl = s.getPropertyValue('--flat').trim();
    const accent = s.getPropertyValue('--accent').trim();
    if (up) C.up = up;
    if (dn) C.down = dn;
    if (fl) C.flat = fl;
    if (accent) C.avg = C.dea = C.d = accent;
    // 窄屏（手机竖屏）上 K 线 tooltip 有十几行、能到 215px 高，比主图容器本身
    // （窄屏 min-height 只有 170px）还高。confine 只能把它按在容器左上角，
    // 仍然会冒出去一截。所以跟着屏幕宽度把字号和内边距收紧，让它尽量塞得下。
    const narrow = global.innerWidth <= 660;
    tooltipBase.padding = narrow ? [4, 7] : [7, 10];
    tooltipBase.textStyle.fontSize = narrow ? 11 : 12;
    tooltipBase.extraCssText = narrow ? 'line-height:1.35;' : '';
  }

  /** 给主题色套一个透明度，用于面积渐变。
      必须由 C.up 推导，不能写死字面量 —— 否则切到 body.us 时色板翻转，
      C.up 变成绿的而渐变色还是红的，线绿、底红。 */
  function withAlpha(col, a) {
    const c = String(col || '').trim();
    const h = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
    if (/^#[0-9a-f]{6}$/i.test(c)) return c + h;
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] + h;
    return c;
  }

  const axisCommon = {
    axisLine: { lineStyle: { color: C.axis } },
    axisTick: { show: false },
    axisLabel: { color: C.label, fontSize: 10.5, fontFamily: 'Consolas,monospace' },
    splitLine: { show: true, lineStyle: { color: C.split, type: 'dashed' } }
  };
  const splitNone = { show: false };

  const tooltipBase = {
    trigger: 'axis',
    // 必须 confine —— ECharts 默认允许 tooltip 画到容器外面。手机竖屏时主图很窄，
    // 触发点靠左就会算出负的 left，整个信息框被屏幕边缘切掉一截（用户报的
    // "信息窗格在某些位置会被遮挡无法看到全貌"）。confine 把它按在容器内。
    confine: true,
    backgroundColor: 'rgba(24,28,36,.96)',
    borderColor: '#3a4252',
    borderWidth: 1,
    padding: [7, 10],
    textStyle: { color: '#c9cdd6', fontSize: 12 },
    axisPointer: {
      type: 'cross',
      lineStyle: { color: '#5a6478', type: 'dashed', width: 1 },
      crossStyle: { color: '#5a6478' },
      label: { backgroundColor: '#39404e', color: '#e9edf4', fontSize: 11 }
    }
  };

  function mkChart(el) {
    const c = echarts.init(el, null, { renderer: 'canvas' });
    c.group = 'tjs';
    return c;
  }

  /** 让 ECharts 跟着容器尺寸走。
      只挂 window.resize 不够 —— 安卓 APP 启动时系统栏的 inset 是在 WebView
      建好之后才补到根布局上的，容器会"先高后矮"，而页面不一定收到 window.resize。
      于是 ECharts 一直按旧高度画，画布就溢出到下面副图的页签行上（用户报的
      "主图曲线溢出到副图选单"）。
      这里三管齐下：ResizeObserver + 启动后头几秒轮询对账 + init 里的 window.resize。
      为什么不能只靠 ResizeObserver：headless Chrome 里实测它压根不派发 —— 自己建
      一个 observer 盯着一个尺寸确实变了的容器，触发 0 次。手机端应该没问题，但
      既然验证不了，就不能把正确性押在它身上。
      容器被隐藏时 rect 是 0，这时候绝不能 resize —— 会把 ECharts 设成 0×0，
      再显示回来就是一片空白（app.js 里那几处 setTimeout resize 就是为这个加的）。 */
  function follow(el, get) {
    let last = '';
    const apply = () => {
      const c = get();
      if (!c) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const key = Math.round(r.width) + 'x' + Math.round(r.height);
      if (key === last) return;
      last = key;
      c.resize();
    };
    if (global.ResizeObserver) {
      const ro = new ResizeObserver(U.debounce(apply, 60));
      ro.observe(el);
    }
    // 启动后头 4 秒每 250ms 对一次账，之后交给上面那些事件
    const t0 = Date.now();
    const tm = setInterval(() => {
      if (Date.now() - t0 > 4000) { clearInterval(tm); return; }
      apply();
    }, 250);
  }

  let main = null, sub = null;

  /* ───────── 通用 grid ───────── */
  function grid(l, r, t, b) {
    return { left: l, right: r, top: t, bottom: b, containLabel: false };
  }

  /* ───────── 主图 / 副图共用的横轴契约 ─────────
     同一个时刻要在上下两块图里落在**同一个 x 像素**上，取决于三件事：
       ① 左右留白一样（否则绘图区宽度和起点都不同）
       ② boundaryGap 一样（false 是"点落在轴上"，true 是"点落在格子中间"，两者逐点渐偏）
       ③ 刻度函数一样（否则同一根刻度线上下写的是不同的字）
     再加一条：K 线主图有 dataZoom、副图没有的话，可见区间根本不是同一段。
     所以这四样收成一份，主图和副图都从这里取，谁也别自己定。 */
  /* 左边距：要给 `-4.0` 这种四字符刻度留够地方。
     52 的时候刻度右边界离绘图区只有几像素，柱状副图看着就像刻度压在柱子上。
     ⚠ 这是**主副共用**的一份，两边一起改才不会破坏对齐。 */
  const PAD_L = 72, PAD_R = 64;

  /** 某一周期的横轴刻度参数（interval + formatter）。n = 类别数。
      hourly（趋势/7日）的类别是原始时间键 `YYYY-MM-DDTHH:MM`，K 线是日期（月K 是 `YYYY-MM`）。 */
  function axisOf(period, n) {
    const nKey = Number(n) || 0;
    if (period === '7day') {
      return {
        interval: 0,
        formatter: v => {
          const d = String(v).slice(0, 10), h = String(v).slice(11, 16);
          return h === '00:00' ? d.slice(5) : (h === '12:00' ? h : '');
        }
      };
    }
    if (period === 'trend') {
      return { interval: Math.max(1, Math.round(nKey / 14)), formatter: v => String(v).slice(11, 16) };
    }
    if (period === 'month') return { interval: 'auto', formatter: v => String(v) };
    return { interval: 'auto', formatter: v => String(v).slice(5) };
  }

  /** 主图 dataZoom 的起点百分比。副图必须用同一个值，否则两块图显示的区间不同。 */
  function zoomStart(n, view) { return n > view ? (1 - view / n) * 100 : 0; }

  /* ═══════════════ 主图 ═══════════════ */

  /** 分时 / 7日 */
  function optTrend(S) {
    const pts = S.points || [];
    if (!pts.length) return emptyOpt('暂无分时数据');
    const base = S.base;
    // 右侧百分数轴：气温的比值必须走绝对温标，见 U.pctOf 的注释。
    // base 为空时返回 undefined，让 ECharts 自己定轴范围（原来的写法会算出 NaN）。
    const basePct = v => (base == null ? undefined : +U.pctOf(v, base).toFixed(2));
    const xs = pts.map(p => p.t);
    const ys = pts.map(p => p.p);

    /* ── 「未发生」的那半画虚线（使用者 m01295 定）─────────────────────────
       分界 = 最后一个「不晚于现在」的时次。已发生的实线、未发生的虚线，两边在分界点
       **共用一个点**，所以接得上、不是两段拼起来的断层。
       为什么要有这个：行情栏的「今日最高/最低」现在跟着**这条线整条**的极点走，而这条线里
       混着今天还没到的小时（`d.intraday` 是 00→23 共 24 个整点，`recent` 那份含未来 16 天预报）。
       画面必须能一眼看出哪半是预报，否则「今日最高 26.5」会被读成"今天到过 26.5"。
       全都在未来时（例如只剩气象局那条保底曲线，它只有未来）：实线为空、整条虚线 —— 这是**对的**，
       那本来就全是预报。 */
    const nowKey = (() => { const n = S.now || new Date(); return U.fmtDate(n) + 'T' + U.pad2(n.getHours()); })();
    let cutIdx = -1;
    for (let i = 0; i < xs.length; i++) {
      if (String(xs[i]).replace(' ', 'T').slice(0, 13) <= nowKey) cutIdx = i;
    }
    const solidYs = xs.map((_, i) => (i <= cutIdx ? ys[i] : null));
    const dashYs = (cutIdx < 0) ? ys.slice() : xs.map((_, i) => (i >= cutIdx ? ys[i] : null));

    const vals = ys.filter(v => v != null);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = Math.max(hi - lo, 1);
    lo -= span * 0.18; hi += span * 0.18;
    if (base != null) { lo = Math.min(lo, base - span * 0.05); hi = Math.max(hi, base + span * 0.05); }

    // 均温线（累计均价，同花顺那条黄色均线 —— 只是这里画的是气温，所以叫「均温」）
    const avg = []; let acc = 0;
    for (let i = 0; i < ys.length; i++) { acc += ys[i]; avg.push(+(acc / (i + 1)).toFixed(2)); }

    // 自然日分界：算出每天第一根柱子的小标，用来给多日分时图铺"明暗相间"的底色带。
    const dayBoundary = [];
    let prevDay = null;
    xs.forEach((t, i) => {
      const d = String(t).slice(0, 10);
      if (prevDay && d !== prevDay) dayBoundary.push({ xAxis: i });
      prevDay = d;
    });

    // 明暗带：从第 1 天开始交替（第 1/3/5/7 天亮、第 2/4/6 天暗 —— 7 日就是"四明三暗"）。
    // 第一天也要参与，所以起始边界是 0；单日分时没有分界，就不铺带子。
    const bands = [];
    if (dayBoundary.length) {
      const bounds = [0].concat(dayBoundary.map(b => b.xAxis)).concat([xs.length]);
      for (let i = 0; i + 1 < bounds.length; i++) {
        bands.push([
          { xAxis: bounds[i] - 0.5, itemStyle: { color: i % 2 ? C.bandDark : C.bandLight } },
          { xAxis: bounds[i + 1] - 0.5 }
        ]);
      }
    }

    // 主图叠加：把当前副图的口径画成一条线贴在主图上（"单独给降水空气这些拉一条线"）。
    // ov.byKey 是「时间键 -> 数值」，这里按横轴的时间戳逐个查表，查不到留 null，线自然断开。
    const ov = S.ov;
    const od = ov && ov.byKey ? xs.map(k => (ov.byKey[k] == null ? null : ov.byKey[k])) : null;
    const ovOk = !!(od && od.some(v => v != null));
    const ovAxis = ovOk ? {
      type: 'value', position: 'right', scale: true,
      axisLine: { show: false }, axisTick: { show: false },
      // ⚠ 刻度画在**图内**（inside），不往图外伸 —— 原来用 offset:44 把这一列推到百分比轴外面，
      //   56px 的留白装不下，最右边几个数会被容器切掉。加宽留白是错的解法：那份留白主副共用，
      //   一加宽副图就跟着缩，副图自己那两根右轴反而叠在一起。
      axisLabel: Object.assign({}, axisCommon.axisLabel, { inside: true, color: ov.color, fontSize: 10, margin: 2 }),
      splitLine: splitNone
    } : null;

    const ax = axisOf(S.mode, xs.length);
    const axisLbl = ax.formatter;

    return {
      animation: false,
      backgroundColor: C.bg,
      grid: grid(PAD_L, PAD_R, 14, 22),
      tooltip: Object.assign({}, tooltipBase, {
        formatter: (ps) => {
          const i = ps[0].dataIndex, t = xs[i], p = ys[i];
          const chg = base != null ? p - base : null;
          const pct = U.pctOf(p, base);
          const w = S.hours ? S.hours[i] : null;
          let html = '<div style="font-weight:700;color:#e9edf4">' + String(t).replace('T', ' ').slice(0, 16) + ' ' + (w ? w : '') + '</div>';
          html += row('气温', fx(p, 1) + ' ℃', U.trendColor(chg));
          /* ⚠ 「官方发布值」与「插值示意」必须在光标里分清。
           * 保底曲线（Open-Meteo 额度用尽时拿气象局逐 3 小时插出来的那条）里只有锚点那几格
           * 是气象台发布的原值，其余是我们插出来的数 —— 《气象预报发布与传播管理办法》第九条
           * 要求传播时"不得自行更改气象预报的内容和结论"，所以插值点**必须自报家门**，
           * 不能让屏幕上这个数字看起来跟官方发布的一样权威。`p.off` 由 api.js 打（1=官方锚点，0=插值）。 */
          const of = pts[i] && pts[i].off;
          if (of === 0) html += row('来源', '插值示意（非官方逐时值）', '#ffb74d');
          else if (of === 1) html += row('来源', '气象局逐 3 小时发布值', C.avg);
          if (base != null) html += row('较昨收', sgn(chg, 1) + ' ℃  ' + sgn(pct, 2) + '%', U.trendColor(chg));
          html += row('均温', fx(avg[i], 1) + ' ℃', C.avg);
          if (S.precips) html += row('降水', fx(S.precips[i], 1) + ' mm', '#4fc3f7');
          if (ovOk) html += row(ov.name, (od[i] == null ? '—' : fx(od[i], ov.unit === '%' ? 0 : 1) + ' ' + ov.unit), ov.color);
          return html;
        }
      }),
      xAxis: [{
        // ⚠ 这里**必须是 true**（曾经是 false）。分时 / 7日 的主图是折线，而它下面的副图
        //   常常是柱子；柱子是「骑」在刻度点上的，boundaryGap:false 会让最左 / 最右那根
        //   各探出半根、压到左边的刻度栏上，两块图的点看着也错开半格。
        //   改成 true 之后**七个周期口径统一**（K 线本来就是 true）：一格一个点、居中，
        //   副图柱子落在自己的格里，既不探出去也和主图一格对一格。
        //   代价：折线两端各内缩半格，不再贴着左右边框（这是使用者确认过的取舍）。
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        // 刻度规则来自共用的 axisOf()：副图用同一份，上下两块图的刻度才会对齐。
        // interval:0 让每个时刻都参与排版；7日图靠 formatter 只在 00:00 写日期、12:00 写"12:00"，
        // 其余返回空串。这样每天都能落下一个日期标签，不会像按固定步长抽稀时那样正好跳过日界。
        axisLabel: Object.assign({}, axisCommon.axisLabel, { interval: ax.interval, formatter: axisLbl, hideOverlap: true }),
        splitLine: splitNone
      }],
      yAxis: [
        {
          type: 'value', min: +lo.toFixed(1), max: +hi.toFixed(1), scale: true,
          axisLine: { show: false }, axisTick: { show: false },
          // 左轴＝气温，**带上 ℃**（使用者要求：带单位才准确）。
          // 右轴（涨跌幅）本来就是每个刻度都带 %，左轴不带单位是不一致的。
          // 左边距 PAD_L=72 放得下 `18.7℃`（≈30px）。
          axisLabel: Object.assign({}, axisCommon.axisLabel, { formatter: v => v.toFixed(1) + '℃', color: C.labelHi }),
          splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
        },
        {
          type: 'value', min: basePct(lo), max: basePct(hi),
          position: 'right', axisLine: { show: false }, axisTick: { show: false },
          axisLabel: Object.assign({}, axisCommon.axisLabel, {
            formatter: v => sgn(v, 2) + '%',
            color: (v) => v > 0 ? C.up : v < 0 ? C.down : C.label
          }),
          splitLine: splitNone
        }
      ].concat(ovOk ? [ovAxis] : []),
      // ⚠ dataZoom 必须**和 K 线档一样建一份**（哪怕它就是全展的 0~100）。
      //   副图（optSub）一直在建 dataZoom，主图这里以前**没有** —— 对比 K 线那几档：
      //     K 线：主图有 dataZoom、副图也有 → `echarts.connect('tjs')` 的十字光标 /
      //           信息窗格联动正常工作（那几档一直是好的，使用者也是这么说的）；
      //     分时 / 7日：主图**没有** dataZoom → 联动少了一环，竖线对不齐、副图窗格不出。
      //   这里补上和 optKline 同一套（全展 0~100），两条路径的结构就一致了。
      dataZoom: [
        { type: 'inside', xAxisIndex: [0], start: 0, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
        { type: 'slider', xAxisIndex: [0], start: 0, end: 100, show: false }
      ],
      series: [
        // ⚠ 系列的**数组下标**决定 `echarts.connect('tjs')` 的悬停联动方向 ——
        //   它是按 seriesIndex 一一对应的，不是按名字。所以要跟副图对齐：
        //     主图[0] = 气温   ↔  副图[0] = 柱子（温差/降水/风/空气）
        //   K 线那几档一直好使，正是因为主图[0] 是蜡烛、副图[0] 是柱子，两边都有数。
        //
        //   **日界带 `_days` 必须排在最后**：它的 `data: []` 是空的，
        //   排在 0 号位时会出两个毛病（都是使用者报过的）：
        //     · 主图悬停 → 映射到副图，落不到数据上，副图窗格不弹；
        //     · **副图悬停 → 映射到主图第 0 系列（空）→ 主图窗格不弹**（反方向失效）。
        //   它靠 `z: 1` 压在气温/均温下面，所以挪到数组末尾不影响画面层级。
        {
          // smooth: 0.25 —— 温和圆角，**不是** `true`（那等于 0.5，会过冲、
          // 让曲线跑到轴刻度之外，看着比真实数据还夸张）。
          // 为什么现在要开：7 日分时是**逐小时**的真数据（约 168 个点挤在 1100px 里），
          // 昼夜循环本身就长得像锯齿；不开平滑的话每个小时都是一个硬折角，
          // 看上去比实际天气"尖锐"得多。0.25 只把折角磨圆，不改变数据。
          name: '气温', type: 'line', data: solidYs, showSymbol: false, symbol: 'circle', symbolSize: 5,
          smooth: 0.25,
          lineStyle: { width: 1.5, color: C.up }, z: 5,
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: withAlpha(C.up, .30) }, { offset: 1, color: withAlpha(C.up, .02) }
            ])
          },
          markLine: base != null ? {
            silent: true, symbol: 'none', label: { show: false },
            lineStyle: { color: C.base, type: 'dashed', width: 1 },
            data: [{ yAxis: +base.toFixed(1) }]
          } : undefined
        },
        {
          // 均温跟气温用同一档平滑，否则两根线一圆一尖、看着像两条不同来源的数据
          name: '均温', type: 'line', data: avg, showSymbol: false, smooth: 0.25,
          lineStyle: { width: 1, color: C.avg }, z: 4
        },
        // 叠加线：挂在第 3 根 Y 轴上（右轴再往外 offset 44px），不跟百分比轴抢刻度
        ovOk ? {
          name: ov.name, type: 'line', yAxisIndex: 2, data: od, showSymbol: false,
          connectNulls: false, z: 6,
          lineStyle: { width: 1.3, color: ov.color }, itemStyle: { color: ov.color }
        } : null,
        // 日界背景带（不画线）：z 最低，保证明暗带在气温/均价下面，
        // 顺便在每条分界线上画一根竖虚线，即使被面积渐变盖住也还能看出"一天到这儿结束"。
        // ⚠ 它要排在**有数据的系列之后**（`data: []` 是空的；空系列占住低下标会吃掉悬停映射，
        //   两个方向都试过、都是使用者报过的）。末尾那条"未发生的虚线"自带数据，排在它后面没问题。
        bands.length ? {
          name: '_days', type: 'line', data: [], silent: true, z: 1, showSymbol: false,
          markArea: { silent: true, data: bands },
          markLine: {
            silent: true, symbol: 'none', label: { show: false }, animation: false,
            lineStyle: { color: 'rgba(255,255,255,.16)', type: 'dashed', width: 1 },
            data: dayBoundary.map(b => ({ xAxis: b.xAxis - 0.5 }))
          }
        } : null,
        /* 未发生的那半：**虚线**（分界与理由见上面 nowKey / cutIdx）。
           放在数组**最末** —— 前面所有系列的**下标一个都没变**，
           `echarts.connect('tjs')` 对"已发生"那半的悬停映射完全不受影响。 */
        {
          name: '气温（未发生）', type: 'line', data: dashYs, showSymbol: false, symbol: 'circle', symbolSize: 5,
          smooth: 0.25, connectNulls: false,
          lineStyle: { width: 1.5, color: C.up, type: 'dashed', opacity: 0.85 }, z: 5
        }
      ].filter(Boolean)
    };
  }

  /** K 线（含 MA / BOLL 叠加） */
  function optKline(S) {
    const bars = S.bars || [];
    if (!bars.length) return emptyOpt('暂无K线数据');
    const ind = S.ind, showBoll = S.showBoll;
    const xs = bars.map(b => b.d);
    // 平盘日（开盘 == 收盘，气温一天下来没升没降）既不算涨也不算跌，涂中性灰。
    // ECharts 内部对"收 == 开"走的是严格 close > open 的 else 分支，会套用
    // 跌的 color0/borderColor0（实测确认），所以只能给这几根单独挂 itemStyle。
    // 数组式和 {value, itemStyle} 对象式可以混用；markPoint 的
    // valueDim('highest'/'lowest') 在对象式数据下实测仍然生效。
    const candle = bars.map(b => (b.c === b.o
      ? { value: [b.o, b.c, b.l, b.h], itemStyle: { color: C.flat, color0: C.flat, borderColor: C.flat, borderColor0: C.flat } }
      : [b.o, b.c, b.l, b.h]));
    const metric = METRICS[S.metric] || METRICS.range;

    const view = S.view == null ? 90 : S.view;
    const start = zoomStart(bars.length, view);

    const series = [{
      name: 'K线', type: 'candlestick', data: candle, z: 3,
      // 涨空心、跌实心（A 股习惯）：color 是"实心填充"色，color0 是跌的填充色。
      // 涨的填充给 transparent 就只剩描边，即空心；影线走 borderColor，所以仍是涨色。
      // 空心的好处是数目多、K 线密集时不再糊成一片色块，实体边界一眼可辨。
      itemStyle: {
        color: 'transparent', color0: C.down,
        borderColor: C.up, borderColor0: C.down, borderWidth: 1.2
      },
      markLine: S.base != null ? {
        silent: true, symbol: 'none', label: { show: false },
        lineStyle: { color: C.base, type: 'dotted', width: 1 },
        data: [{ yAxis: +S.base.toFixed(1) }]
      } : undefined,
      markPoint: {
        symbolSize: 0, silent: true,
        label: { fontSize: 10, color: '#fff', backgroundColor: 'rgba(0,0,0,.45)', padding: [1, 3], borderRadius: 2 },
        data: [
          { type: 'max', name: '最高', valueDim: 'highest', label: { formatter: p => '高 ' + fx(p.value, 1) }, itemStyle: { color: C.up } },
          { type: 'min', name: '最低', valueDim: 'lowest', label: { formatter: p => '低 ' + fx(p.value, 1) }, itemStyle: { color: C.down } }
        ]
      }
    }];

    if (showBoll) {
      [['upper', 'BOLL上轨', C.boll[0]], ['mid', 'BOLL中轨', C.boll[1]], ['lower', 'BOLL下轨', C.boll[2]]].forEach(([k, nm, col]) => {
        series.push({
          name: nm, type: 'line', data: ind[k], showSymbol: false, smooth: true,
          lineStyle: { width: 1.1, color: col }, itemStyle: { color: col }, z: 2
        });
      });
    } else {
      [['ma5', 'MA5'], ['ma10', 'MA10'], ['ma20', 'MA20'], ['ma30', 'MA30'], ['ma60', 'MA60']].forEach(([k, nm], i) => {
        series.push({
          name: nm, type: 'line', data: ind[k], showSymbol: false, smooth: true, connectNulls: false,
          lineStyle: { width: 1.1, color: C.ma[i] }, itemStyle: { color: C.ma[i] }, z: 2
        });
      });
    }

    // 预报部分高亮分隔
    const futureIdx = bars.findIndex(b => b.d > S.today);
    const markArea = futureIdx > 0 ? {
      silent: true,
      itemStyle: { color: 'rgba(79,195,247,.055)' },
      label: { show: true, position: 'insideTop', color: '#4fc3f7', fontSize: 10, formatter: '预报区 →' },
      data: [[{ xAxis: futureIdx - 0.5 }, { xAxis: xs.length - 0.5 }]]
    } : undefined;

    // 主图叠加：K 线的横轴就是分桶键（日 'YYYY-MM-DD' / 周 周一 / 月 'YYYY-MM'），
    // 和 Weather.series() 的分桶键完全一致，所以按键查表一定对得上。
    const ov = S.ov;
    const od = ov && ov.byKey ? xs.map(k => (ov.byKey[k] == null ? null : ov.byKey[k])) : null;
    const ovOk = !!(od && od.some(v => v != null));
    const ovAxis = ovOk ? {
      type: 'value', scale: true, position: 'right',
      axisLine: { show: false }, axisTick: { show: false },
      // 同理：刻度画在图内，不占额外留白
      axisLabel: Object.assign({}, axisCommon.axisLabel, { inside: true, color: ov.color, fontSize: 10, margin: 2 }),
      splitLine: splitNone
    } : null;
    if (ovOk) {
      series.push({
        name: ov.name, type: 'line', yAxisIndex: 2, data: od, showSymbol: false,
        connectNulls: false, z: 6,
        lineStyle: { width: 1.3, color: ov.color }, itemStyle: { color: ov.color }
      });
    }

    return {
      animation: false,
      backgroundColor: C.bg,
      // bottom 从 34 放到 46：下面还有一条 height:15/bottom:5 的 dataZoom 滑块，
      // 原来的 34 让 x 轴日期正好压在滑块上（用户截图里"日期被遮挡显示不完全"）。
      // 轴标签从 grid 底边再往下约 8~20px，滑块顶边在 H-19，留出 6px 余量。
      grid: grid(PAD_L, PAD_R, 16, 46),
      tooltip: Object.assign({}, tooltipBase, { formatter: klineTip(bars, xs, S, metric) }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [{
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: Object.assign({}, axisCommon.axisLabel,
          { hideOverlap: true, interval: axisOf(S.period, xs.length).interval, formatter: axisOf(S.period, xs.length).formatter }),
        splitLine: splitNone
      }],
      yAxis: [
        {
          type: 'value', scale: true, position: 'left',
          axisLine: { show: false }, axisTick: { show: false },
          // 同上：K 线的左轴也是气温，带 ℃。
          axisLabel: Object.assign({}, axisCommon.axisLabel, { formatter: v => v.toFixed(1) + '℃', color: C.labelHi }),
          splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
        },
        {
          type: 'value', scale: true, position: 'right',
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: Object.assign({}, axisCommon.axisLabel, {
            formatter: v => S.base != null ? sgn(U.pctOf(v, S.base), 1) + '%' : v.toFixed(0)
          }),
          splitLine: splitNone
        }
      ].concat(ovOk ? [ovAxis] : []),
      dataZoom: [
        { type: 'inside', xAxisIndex: [0], start: start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
        {
          type: 'slider', xAxisIndex: [0], start: start, end: 100, height: 15, bottom: 5,
          borderColor: '#2a303c', backgroundColor: '#161a22', fillerColor: 'rgba(240,185,11,.10)',
          handleStyle: { color: '#5a6478', borderColor: '#5a6478' },
          moveHandleStyle: { color: '#5a6478' },
          textStyle: { color: C.label, fontSize: 10 },
          dataBackground: { lineStyle: { color: '#3a4252' }, areaStyle: { color: 'rgba(90,100,120,.22)' } },
          brushSelect: false
        }
      ],
      series: series,
      // 「日K · 26 根」这个角标。
      // ⚠ left 必须**避开左侧刻度那一栏**：左轴刻度是右对齐、右边界落在 `PAD_L - 8` 上
      //   （加 ℃ 之后 `36.0℃` 更宽，左边界能到 x≈30），而原来这里写死 `left: 58`——
      //   正好压在最上面那个刻度（轴最大值）上，看着就是"角标和带单位的天气文字叠在一起"。
      //   放到 `PAD_L + 8` 之后，角标在刻度栏右侧 16px，且 y 仍在绘图区上方（grid.top = 16）。
      graphic: S.title ? [{
        type: 'text', left: PAD_L + 8, top: 3,
        style: { text: S.title, fill: '#8b919e', fontSize: 11, fontFamily: 'Consolas,monospace' }
      }] : undefined
    };
  }

  function klineTip(bars, xs, S, metric) {
    return (ps) => {
      const i = ps[0].dataIndex, b = bars[i];
      if (!b) return '';
      const prev = bars[i - 1];
      const base = prev ? prev.c : b.o;
      const chg = b.c - base, pct = U.pctOf(b.c, base);
      let h = '<div style="font-weight:700;color:#e9edf4;margin-bottom:3px">' + tipTitle(b.d) +
        (b.wcode != null ? ' <span style="color:#4fc3f7">' + API.wmoText(b.wcode) + '</span>' : '') + '</div>';
      h += row('开', fx(b.o, 1) + ' ℃', U.trendColor(b.o - base));
      h += row('高', fx(b.h, 1) + ' ℃', C.up);
      h += row('低', fx(b.l, 1) + ' ℃', C.down);
      h += row('收', fx(b.c, 1) + ' ℃', U.trendColor(chg));
      h += row('涨跌', sgn(chg, 1) + ' ℃ ' + sgn(pct, 2) + '%', U.trendColor(chg));
      // 副图口径选的是「日内温差」时，振幅跟它算出来是同一个数（都是 最高-最低），
      // 显示两遍没意义。窄屏上少一行，tooltip 也更容易整个塞进主图。
      if (metric.label !== '日内温差') h += row('振幅', fx(b.h - b.l, 1) + ' ℃', C.labelHi);
      // 周K / 月K 是聚合出来的，bar 上只有 {d,o,h,l,c,v,n,raw}，没有 range / windAvg / humAvg
      // （副图在月K 下本来就是隐藏的）。取不到就别显示一个 "-- ℃" 占位行。
      const mv = metric.get(b);
      if (mv != null) h += row(metric.label, fx(mv, metric.unit === '%' ? 0 : 1) + metric.unit, '#4fc3f7');
      if (S.ov && S.ov.byKey) {
        const v = S.ov.byKey[b.d];
        h += row(S.ov.name, (v == null ? '—' : fx(v, S.ov.unit === '%' ? 0 : 1) + ' ' + S.ov.unit), S.ov.color);
      }
      if (S.showBoll) {
        const g = k => (S.ind[k] && S.ind[k][i] != null) ? fx(S.ind[k][i], 1) : '--';
        h += row('BOLL', g('lower') + ' / ' + g('mid') + ' / ' + g('upper'), C.boll[0]);
      } else {
        const g = k => (S.ind[k] && S.ind[k][i] != null) ? fx(S.ind[k][i], 1) : '--';
        h += row('MA5/10/20', g('ma5') + ' / ' + g('ma10') + ' / ' + g('ma20'), C.ma[1]);
        h += row('MA30/60', g('ma30') + ' / ' + g('ma60'), C.ma[3]);
      }
      return h;
    };
  }

  function row(k, v, color) {
    return '<div style="display:flex;gap:14px;justify-content:space-between;line-height:1.65">' +
      '<span style="color:#7b8291">' + k + '</span>' +
      '<span style="color:' + (color || '#e9edf4') + ';font-family:Consolas,monospace">' + v + '</span></div>';
  }

  function emptyOpt(msg) {
    return {
      backgroundColor: C.bg,
      graphic: [{ type: 'text', left: 'center', top: 'middle', style: { text: msg, fill: '#575e6d', fontSize: 13 } }],
      xAxis: { show: false }, yAxis: { show: false }, series: []
    };
  }

  /* ═══════════════ 副图 ═══════════════ */
  function optSub(S) {
    const bars = S.bars || [];
    if (!bars.length) return emptyOpt('');
    // ind 走一层浅拷贝：vol 那两条均线要**现算**，不能写回调用方的 d.indicators
    // （写回去的话，切一次口径就把主线上的指标数组污染了）。
    const ind = Object.assign({}, S.ind);
    const S2 = Object.assign({}, S, { ind: ind });
    // 横轴类别默认取柱子自己的日期。但**分时 / 7日 的主图是逐小时的、温差是"每天"的量** ——
    // 这时 app.js 会把主图的类别数组传进来（S.cats），两块图才会一格对一格。
    // 不这么干的话副图会按 553 根日K 排横轴，跟主图（24 / 168 个时次）说的不是同一段时间。
    const xs = S.cats || bars.map(b => b.d);
    const view = S.view == null ? 90 : S.view;
    // ⚠ 传了 S.cats 就说明副图吃的是**主图那一整条横轴**，缩放必须完全跟着主图：
    //   主图没开 dataZoom 就是全展，副图也必须全展（start = 0）。
    //   这里踩过坑：第一版写成"主图有 _mainStart 就跟、没有就退回 zoomStart(xs.length, view)"，
    //   而分时 / 7日 的主图恰好**没有** dataZoom，于是副图按"最近 90 根"算出 start = 46.4%，
    //   自己偷偷缩到后 54%（7 天只剩后 3 天多），跟主图整整错开一截 ——
    //   两块图还挂在同一个 echarts group 上，连主图都会跟着被拽歪。
    const start = S.cats ? ((Chart && Chart._mainStart != null) ? Chart._mainStart : 0)
      : zoomStart(xs.length, view);
    const zoom = [
      { type: 'inside', xAxisIndex: [0], start: start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
      { type: 'slider', xAxisIndex: [0], start: start, end: 100, show: false }
    ];
    const baseOpt = {
      animation: false, backgroundColor: C.bg,
      // ⚠ grid.top 要给轴的 name 留地方（跟 wxui.js 那几档副图同一个理由）：
      //   ECharts 把 yAxis.name 画在绘图区顶部、网格外面，top 太小就会被画布上边界裁掉。
      grid: grid(PAD_L, PAD_R, 26, 26),
      tooltip: Object.assign({}, tooltipBase, {
        formatter: (ps) => subTip(ps, S2, xs)
      }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [{
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        // 和主图同一套刻度规则，否则上下两排日期长得不一样
        axisLabel: Object.assign({}, axisCommon.axisLabel,
          { hideOverlap: true, interval: axisOf(S.period, xs.length).interval, formatter: axisOf(S.period, xs.length).formatter }),
        splitLine: splitNone
      }],
      yAxis: [{
        type: 'value', scale: true, position: 'left',
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: Object.assign({}, axisCommon.axisLabel, { color: C.label }),
        splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
      }],
      dataZoom: zoom
    };

    let metric = METRICS[S.metric] || METRICS.range;
    // 左轴带上单位（℃ / mm / m/s / %），跟 wxui.js 那几档副图一致 —— 带单位才准确。
    baseOpt.yAxis[0].name = metric.unit;
    baseOpt.yAxis[0].nameTextStyle = { color: C.label, fontSize: 10.5 };
    // 周K / 月K 的温差是"这一周 / 这一月"的最高最低之差，写「日内温差」是骗人的
    if (S.metric === 'range' && (S.period === 'week' || S.period === 'month')) {
      metric = Object.assign({}, metric, { label: S.period === 'week' ? '本周温差' : '本月温差' });
    }
    if (S.indName === 'vol') {
      const d = bars.map(b => metric.get(b));
      // ⚠ MA5/MA10 必须**跟着画出来的那个口径现算**，不能再用 ind.volMa5 / ind.volMa10。
      //   那两个是 indicators.js 里的 `MA(bars.map(b => b.v || 0), 5)` —— 也就是
      //   **降水量**的均线，跟"波动柱口径"下拉框选什么完全无关。
      //   默认口径是日内温差（北京这几天 11℃ 上下），而降水量基本是 0，
      //   于是两条线永远贴在 0 上：图上根本看不见（tooltip 里显示 `MA5 0.000`），
      //   看着就像"曲线跟柱状图对不上"。口径能切（温差/降水/风速/湿度），所以只能现算。
      ind.volMa5 = MA(d, 5);
      ind.volMa10 = MA(d, 10);
      baseOpt.yAxis[0].axisLabel.formatter = v => metric.unit === '%' ? v.toFixed(0) : v.toFixed(1);
      baseOpt.series = [
        {
          name: metric.label, type: 'bar', data: d.map((v, i) => ({
            // 判涨跌必须跟上面蜡烛图用同一个算子。ECharts 的 candlestick 是严格
            // 的 close > open 才算阳线（平盘归阴线，用 color0/borderColor0），
            // 这里原先写的是 >=，于是"收盘==开盘"的那天会出现
            // 「上面一根绿 K 线、下面一根红量柱」——实测 576 天里有 19 天（3.3%）
            // 是这种平盘日。现在平盘统一走中性灰，跟蜡烛的 itemStyle 保持一致。
            value: v,
            itemStyle: {
              color: (bars[i].c === bars[i].o ? C.flat : (bars[i].c > bars[i].o ? C.up : C.down)),
              opacity: .78
            }
          })), barWidth: '62%'
        },
        { name: 'MA5', type: 'line', data: ind.volMa5, showSymbol: false, lineStyle: { width: 1, color: C.ma[1] }, itemStyle: { color: C.ma[1] } },
        { name: 'MA10', type: 'line', data: ind.volMa10, showSymbol: false, lineStyle: { width: 1, color: C.ma[2] }, itemStyle: { color: C.ma[2] } }
      ];
      // 「较当日均温」是围绕 0 上下摆的，没有一条 0 基线就看不出"偏暖还是偏冷"。
      // ⚠ 用**有数据的**零线，不要用 refLine（它的 data 是空数组）：
      //   connect 按 seriesIndex 映射，主图第 3 系列（叠加线）会落到副图第 3 系列 ——
      //   如果那是个空系列，悬停又落不到数据上，副图窗格同样弹不出来。
      if (S.metric === 'dev') baseOpt.series.push({
        name: '零线', type: 'line', data: bars.map(() => 0), showSymbol: false, silent: true, z: 1,
        lineStyle: { width: 1, color: '#3f4756', type: 'dashed' }, itemStyle: { color: '#3f4756' }
      });
    } else if (S.indName === 'macd') {
      baseOpt.series = [
        {
          name: 'MACD', type: 'bar', barWidth: '55%',
          data: (ind.macd || []).map(v => ({ value: v, itemStyle: { color: v >= 0 ? C.up : C.down, opacity: .8 } }))
        },
        { name: 'DIF', type: 'line', data: ind.dif, showSymbol: false, lineStyle: { width: 1.2, color: C.dif }, itemStyle: { color: C.dif } },
        { name: 'DEA', type: 'line', data: ind.dea, showSymbol: false, lineStyle: { width: 1.2, color: C.dea }, itemStyle: { color: C.dea } }
      ];
    } else if (S.indName === 'kdj') {
      baseOpt.yAxis[0].min = 0; baseOpt.yAxis[0].max = 100;
      baseOpt.series = [
        lineS('K', ind.k, C.k), lineS('D', ind.d, C.d), lineS('J', ind.j, C.j),
        refLine([20, 80])
      ];
    } else if (S.indName === 'rsi') {
      baseOpt.series = [
        lineS('RSI6', ind.rsi6, C.k), lineS('RSI12', ind.rsi12, C.d), lineS('RSI24', ind.rsi24, C.j),
        refLine([30, 70])
      ];
    } else if (S.indName === 'wr') {
      baseOpt.yAxis[0].min = 0; baseOpt.yAxis[0].max = 100; baseOpt.yAxis[0].inverse = true;
      baseOpt.series = [lineS('WR6', ind.wr6, C.wr[0]), lineS('WR14', ind.wr14, C.wr[1]), refLine([20, 80])];
    } else if (S.indName === 'boll') {
      baseOpt.yAxis[0].axisLabel.formatter = v => v.toFixed(0) + '%';
      baseOpt.series = [
        { name: '带宽', type: 'line', data: ind.width, showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: C.boll[0] }, itemStyle: { color: C.boll[0] },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,183,77,.22)' }, { offset: 1, color: 'rgba(255,183,77,0)' }]) } }
      ];
    }
    return baseOpt;
  }

  function lineS(name, data, color) {
    return { name, type: 'line', data, showSymbol: false, smooth: false, lineStyle: { width: 1.1, color }, itemStyle: { color } };
  }
  function refLine(ys) {
    return {
      name: '参考', type: 'line', data: [], silent: true, showSymbol: false,
      markLine: {
        silent: true, symbol: 'none', label: { show: false },
        lineStyle: { color: '#3f4756', type: 'dashed', width: 1 },
        data: ys.map(y => ({ yAxis: y }))
      }
    };
  }

  function subTip(ps, S, xs) {
    const i = ps[0].dataIndex, b = S.bars[i];
    if (!b) return '';
    let h = '<div style="font-weight:700;color:#e9edf4;margin-bottom:3px">' + tipTitle(b.d) + '</div>';
    const n = S.indName, ind = S.ind;
    const g = (k) => (ind[k] && ind[k][i] != null) ? fx(ind[k][i], 3) : '--';
    if (n === 'vol') {
      const metric = METRICS[S.metric] || METRICS.range;
      const mv = metric.get(b);
      if (mv != null) h += row(metric.label, fx(mv, 1) + metric.unit, '#4fc3f7');
      h += row('MA5', g('volMa5'), C.ma[1]); h += row('MA10', g('volMa10'), C.ma[2]);
    } else if (n === 'macd') {
      h += row('DIF', g('dif'), C.dif); h += row('DEA', g('dea'), C.dea);
      h += row('MACD', g('macd'), (ind.macd && ind.macd[i] >= 0) ? C.up : C.down);
    } else if (n === 'kdj') { h += row('K', g('k'), C.k); h += row('D', g('d'), C.d); h += row('J', g('j'), C.j); }
    else if (n === 'rsi') { h += row('RSI6', g('rsi6'), C.k); h += row('RSI12', g('rsi12'), C.d); h += row('RSI24', g('rsi24'), C.j); }
    else if (n === 'wr') { h += row('WR6', g('wr6'), C.wr[0]); h += row('WR14', g('wr14'), C.wr[1]); }
    else if (n === 'boll') { h += row('带宽', g('width'), C.boll[0]); }
    return h;
  }

  /* ═══════════════ 对外 ═══════════════ */
  const Chart = {
    METRICS,
    init(mainEl, subEl) {
      readTheme();
      main = mkChart(mainEl);
      sub = mkChart(subEl);
      echarts.connect('tjs');
      window.addEventListener('resize', U.debounce(() => { main.resize(); sub.resize(); }, 120));
      follow(mainEl, () => main);
      follow(subEl, () => sub);
      // 点在图表**外面**（顶栏按钮、页签、抽屉、游戏…）就把 tooltip 收掉。
      // 理由见 hideTips()：触屏上这类事件根本到不了 canvas，ECharts 自己不会收。
      // 用捕获阶段 —— 抽屉里有些按钮会在自己的 handler 里把 body 整个重画，
      // 等冒泡到 document 时 e.target 已经脱离文档，closest() 就判断不出来了。
      const EV = global.PointerEvent ? 'pointerdown' : 'touchstart';
      document.addEventListener(EV, e => {
        const t = e.target;
        if (t && t.closest && t.closest('#mainChart,#subChart')) return;
        this.hideTips();
      }, true);
      return this;
    },
    setTheme() { readTheme(); },
    // 副图（wxui.js 画的天气副图）必须复用同一套横轴契约，
    // 否则同一个时刻会落在不同的 x 像素上 —— 用户报的"上下日期没对齐"。
    axisOf, zoomStart, PAD_L, PAD_R,
    hasMain() { return !!main; },
    /** 主图当前用的横轴类别数组。副图必须吃同一份（见 wxui.js 的 alignSeries）——
        副图自己的聚合桶数跟主图 K 线根数能差一个数量级（实测 60 vs 553 根），
        不共用类别数组，留白和刻度怎么调都对不上。 */
    mainCats() {
      if (!main) return null;
      const o = main.getOption();
      return (o && o.xAxis && o.xAxis[0] && o.xAxis[0].data) || null;
    },
    renderMain(S) {
      if (!main) return;
      readTheme();
      let opt;
      if (S.mode === 'trend' || S.mode === '7day') opt = optTrend(S);
      else opt = optKline(S);
      main.setOption(opt, true);
      this._mainStart = opt.dataZoom ? opt.dataZoom[0].start : null;
    },
    renderSub(S) {
      if (!sub) return;
      readTheme();
      sub.setOption(optSub(S), true);
    },
    renderEmpty(msg) {
      if (main) main.setOption(emptyOpt(msg), true);
      if (sub) sub.setOption(emptyOpt(''), true);
    },
    resize() { if (main) main.resize(); if (sub) sub.resize(); },
    showLoading(txt) {
      if (main) main.showLoading('default', { text: txt || '加载中', color: C.avg, textColor: '#8b919e', maskColor: 'rgba(14,16,21,.6)', fontSize: 13, spinnerRadius: 9, lineWidth: 2 });
    },
    hideLoading() { if (main) main.hideLoading(); },
    /* 把两图的 tooltip 收起来。
       为什么要专门收：ECharts 的 tooltip 是个 `position:absolute;z-index:9999999` 的
       div（echarts.min.js 里 dV 那段就是它），而抽屉 .drawer 只有 z-index:200，两者又
       都直接挂在根层叠上下文里比大小 —— 于是"点图表弹出信息框、再去点顶栏功能按钮"时，
       抽屉根本盖不住那个信息框，它会一直浮在抽屉上面（用户报的"有概率不会隐藏"）。
       触屏上点图表外面的事件到不了 canvas，ECharts 不会自己收，只能我们主动收。
       dispatchAction 在已经隐藏的情况下是空操作，可以放心随便调。 */
    hideTips() {
      if (main) main.dispatchAction({ type: 'hideTip' });
      if (sub) sub.dispatchAction({ type: 'hideTip' });
    }
  };

  global.Chart = Chart;
})(window);
