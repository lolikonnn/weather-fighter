/* ═══════════════════════════════════════════════════════════════
   app.js — 终端主逻辑
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const { $, el, fx, sgn, cls, storeGet, storeSet, toast, debounce, marketPhase } = U;
  /* 首次使用的默认收藏：北上广深 + 长沙 + 武汉。
     ⚠ id **别凭记忆写**：武汉是 **101200101**，而 101270101 是**成都**
     （旧默认值里那个位置本来放的就是成都）。这几个 id 都是对着
     `web/data/cities.json` 核过的，不要再"觉得应该是"。
     ⚠ 只在**没有存过 `watch` 这个键**时才塞（见下面的恢复逻辑）——
     不能写成"列表为空就塞"：把收藏全删光是一种明确的操作，
     刷新一下又全冒出来会让人以为删不掉。 */
  const DEFAULT_WATCH = ['101010100', '101020100', '101280101', '101280601', '101250101', '101200101'];

  /* 指数条 = 左栏「当前所在地 + 自选城市」的镜像。
     这里以前写死沪/深/京/穗/湘五个城市，外加一个 computed 的「自选均温」——
     用户既不知道"自选均温"是什么，也点不动它（computed 那条 onclick 直接返回 null），
     而且它跟左栏的自选列表毫无关系。现在整条跟着自选走，点一下就能切城市。 */
  const IDX_MAX = 8;
  function idxIds() {
    const ids = (S.geo ? [LOC_ID] : []).concat(S.watch);
    const seen = {}, out = [];
    ids.forEach(id => {
      if (id && !seen[id] && API.Cities.get(id)) { seen[id] = 1; out.push(id); }
    });
    return out.slice(0, IDX_MAX);
  }
  /** 指数条位置窄，去掉行政后缀省地方 */
  function idxShort(c) {
    const n = String((c && c.name) || '');
    return n.replace(/(特别行政区|自治州|地区|市|县)$/, '') || n;
  }

  const S = {
    period: 'trend', ind: 'vol', metric: 'range',
    refreshMs: 900000, sortMode: 0,
    watch: [], cur: null, data: null, wx: null,
    quotes: {}, briefs: {}, briefAt: 0,
    overlay: false,
    geo: null, geoBusy: false, geoErr: '',
    loading: false, timer: null, lastQuoteAt: 0, lastFullAt: 0, tick: 0,
    /* ── 切城市改成"抢占式"之后要用的三个 ──
       loadSeq  ：每次 selectCity 领一个号；一次加载里**所有 await 之后**写状态/重绘
                  之前，都要先问一句"我还是当前这次吗"，不是就静默退出（见 selectCity）。
       loadingId：当前正在加载的那座城 —— 被抢占时把它扔进 orphans。
       orphans  ：被抢占、数据还没取完的城市。等当前这座显示完，再在**后台**补完。 */
    loadSeq: 0, loadingId: null, orphans: [],
    /* 实况自己的节拍（obsAt）与行情轮询的到期时刻（refreshDue）——
       两者解耦，理由见 scheduleRefresh() 上面那段注释 */
    obsAt: 0, refreshDue: 0, polls: 0, beating: false
  };

  /* 每座城此刻"在飞"的那次 loadCity。抢占时靠它判断要不要后台补完 ——
     已经在飞的就别再发一遍（一次 loadCity 是**七路请求**，额度按 IP 计，重复发会打爆）。 */
  const inflight = {};

  /** 副图口径的中文名（给提示语和叠加按钮的 tooltip 用） */
  const IND_CN = { vol: '温差', precip: '降水', wind: '风', cloud: '云量', air: '空气' };

  /* ═══════════ 行情计算 ═══════════ */
  function quoteOf(id) {
    const q = S.quotes[id], b = S.briefs[id];
    /* 第三个来源：当前城市详情里那份实况（`S.data.now`）。
       它不是冗余。`S.briefs` 的两个来源里，Open-Meteo brief 会带 now，而 **`Cn.brief`
       （气象局日历兜底）是故意把 now 留成 null 的**（api.js 里那行 `now: null`）；轮询
       （`S.quotes`）以前又只覆盖自选，于是"不在自选里的城市 + Open-Meteo 当天不可用"
       这一格就成了灰 `--` —— 而同一屏统计格里的 体感/湿度/气压 却是有值的（使用者报的成都）。
       同源的 `d.now` 就在手上，没理由不兜这一层。 */
    const dn = (S.cur && S.cur.id === id && S.data) ? S.data.now : null;
    const temp = (q && q.temp != null) ? q.temp
      : (b && b.now != null) ? b.now
        : (dn && dn.temp != null) ? dn.temp : null;
    const prev = b ? b.prevClose : null;
    const chg = (temp != null && prev != null) ? temp - prev : null;
    // 涨幅的分母必须走绝对温标 —— 摄氏 0℃ 以下整个符号会翻转，见 U.pctOf 的注释
    const pct = U.pctOf(temp, prev);
    return { temp, prev, chg, pct, q, b };
  }

  /* ═══════════ 指数条 ═══════════ */
  function renderIndexes() {
    const box = $('#indexList');
    if (!box) return;
    const ids = idxIds();
    box.innerHTML = '';
    if (!ids.length) {
      box.appendChild(el('span', { class: 'idx-empty', text: '还没有收藏的城市 —— 用上面的搜索框，或点名字旁边那颗 ☆' }));
      return;
    }
    ids.forEach(id => {
      const c = API.Cities.get(id); if (!c) return;
      const q = quoteOf(id);
      const col = U.trendColor(q.chg);
      const b = S.briefs[id];
      const cv = el('canvas', { width: 56, height: 18 });
      const item = el('div', {
        class: 'strip-item' + (S.cur && S.cur.id === id ? ' on' : ''),
        title: (c.loc ? '当前所在地 · ' : '收藏城市 · ') + c.name +
               (c.prov ? '（' + c.prov + '）' : '') + ' —— 点击查看',
        onclick: () => selectCity(id)
      }, [
        el('span', { class: 'si-name', text: (c.loc ? '📍' : '') + idxShort(c) }),
        el('span', { class: 'si-val', text: q.temp == null ? '--' : fx(q.temp, 1) }),
        el('span', { class: 'si-chg', style: { color: col }, text: q.chg == null ? '--' : sgn(q.chg, 2) + ' ' + sgn(q.pct, 2) + '%' }),
        cv
      ]);
      box.appendChild(item);
      drawSpark(cv, b ? b.sparkPts : null, col);
    });
  }

  function drawSpark(cv, vals, col) {
    if (!vals || vals.length < 2) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
    const d = U.sparkPath(vals, cv.width, cv.height, 2);
    const dm = new Path2D(d);
    ctx.stroke(dm);
    // 面积
    ctx.lineTo(cv.width - 2, cv.height - 1); ctx.lineTo(2, cv.height - 1); ctx.closePath();
    ctx.fillStyle = col + '22'; ctx.fill();
  }

  /* ═══════════ 自选列表 ═══════════ */

  /** 量一下这一行的名字比格子宽出多少，记在元素上 —— **只有选中那一行**会据此滚动
   *  （CSS 只认 `.stock-row.on`，所以一屏最多一行在动）。
   *
   *  为什么需要它：桌面端名字格是**固定 90px**（≈7 个汉字，星才钉得住），
   *  而收藏列表里是可能出现超长名字的 —— 定位到某个区县后可以给它加星，
   *  区县全名最长 15 个字（`双江拉祜族佤族布朗族傣族自治县`），90px 装不下。
   *
   *  ⚠ 必须在元素**进文档之后**调用：没进文档量不出 scrollWidth。
   *  ⚠ 内层 `.sw-name-in` 必须是 inline-block —— 行内元素的 clientWidth/scrollWidth 恒为 0。 */
  function markNameOverflow(row, id) {
    const nm = row.querySelector('.sw-name');
    const inn = row.querySelector('.sw-name-in');
    if (!nm || !inn) return;
    const over = inn.scrollWidth - nm.clientWidth;
    if (over > 1) {
      nm.style.setProperty('--sw-over', over + 'px');
      nm.classList.add('ovf');
    }
    // 悬停看全名（手机上滚不了，这是兜底；桌面端也能鼠标一放就看全）
    const c = API.Cities.get(id);
    nm.title = (c && c.name) || inn.textContent || '';
  }

  function renderWatchlist() {
    const box = $('#watchlist');
    box.innerHTML = '';
    // 放在最前面：自选清空时下面会提前 return，指数条也得跟着清干净
    renderIndexes();
    if (!S.watch.length) { box.appendChild(el('div', { class: 'sr-empty', text: '还没有收藏的城市 —— 用搜索框加，或点名字旁边那颗 ☆' })); return; }
    let ids = S.watch.slice();
    if (S.sortMode === 1) ids.sort((a, b) => {
      // 分母改成绝对温标后，平盘就是货真价实的 0%。这里必须显式判 null：
      // 写成 `pct || -1e9` 会把 0 和"没数据"一起压到最底下。
      const pa = quoteOf(a).pct, pb = quoteOf(b).pct;
      return (pb == null ? -1e9 : pb) - (pa == null ? -1e9 : pa);
    });
    else if (S.sortMode === 2) {
      ids.sort((a, b) => {
        const ca = API.Cities.get(a), cb = API.Cities.get(b);
        return (ca ? ca.name : '').localeCompare(cb ? cb.name : '', 'zh');
      });
    }
    ids.forEach(id => {
      const c = API.Cities.get(id); if (!c) return;
      const q = quoteOf(id);
      const col = U.trendColor(q.chg);
      const row = el('div', {
        class: 'stock-row' + (S.cur && S.cur.id === id ? ' on' : ''),
        // data-id 是给"长按拖动排序"用的：松手后直接读 DOM 里行的顺序就是新顺序，
        // 比自己去算"插到第几个下标"稳得多（自选行没有 id 时也不至于写坏）。
        'data-id': id,
        onclick: (e) => {
          if (e.target.classList.contains('sw-star')) return;
          if (wlSuppressClick) return;        // 刚拖完的那一下别顺手切城市
          selectCity(id);
        }
      }, [
        el('div', {}, [
          // ⚠ 星**跟着城市名同一行**，而不是单独占一列。
          // 单独占列会把名字那列挤窄 —— 「香港特别行政区」这种长小字就放不下了（使用者提的）。
          // 竖屏另有安排：靠 CSS 把这两层包装 display:contents 散开，
          // 星就变成行的网格项，挪到「名字与价格之间的空档」、跨两行垂直居中（好点，像苹果天气）。
          el('div', { class: 'sw-name-row' }, [
            // 名字里面再包一层 `.sw-name-in`：超长名字滚动时**动内层**，
            // 外层那 90px 的格子纹丝不动 —— 右边的星因此一点都不会跟着晃。
            // （区县全名可以长到 15 个字，比如「双江拉祜族佤族布朗族傣族自治县」；
            //   而收藏列表里是可能有区县的：定位到某个区县后可以给它加星。）
            el('div', { class: 'sw-name' }, [el('span', { class: 'sw-name-in', text: c.name })]),
            el('span', {
              // 实心星 = 已收藏，点它 = 取消收藏 —— 跟搜索结果行/全部城市抽屉里的空心星是同一套语义，
              // 也跟搜索结果行 / 行情头 / 全部城市抽屉里的星一致（全站就这一个符号）。
              // 以前这里是 ✕，而且桌面端只在 hover 才显形，等于看不见。
              class: 'sw-star on', text: '★', title: '取消收藏',
              onclick: (e) => { e.stopPropagation(); removeWatch(id); }
            })
          ]),
          el('div', { class: 'sw-sub', text: c.id + ' · ' + (c.prov || '') })
        ]),
        el('div', { class: 'sw-price', style: { color: col }, text: q.temp == null ? '--' : fx(q.temp, 1) }),
        el('div', { class: 'sw-pct ' + (q.chg == null ? 'p-flat' : (q.chg > 0 ? 'p-up' : q.chg < 0 ? 'p-down' : 'p-flat')), text: q.pct == null ? '--' : sgn(q.pct, 2) + '%' })
      ]);
      box.appendChild(row);
      // 名字比格子宽就记下超出多少 —— 只有**选中那一行**会据此滚动（CSS 只看 .on）。
      // 必须在 append 之后量：没进文档的元素量不出 scrollWidth。
      markNameOverflow(row, id);
    });
  }

  /* ───────── 自选列表：长按拖动排序 ─────────
   * 为什么用 pointer 事件：鼠标和触摸同一条路，不用写两套。
   * 为什么**必须长按**才拖：
   *   · 自选行的单击是"切到这座城"，按下就拖会跟点击直接打架；
   *   · 这个列表本身要能上下滚 —— 一碰就拖的话手指根本滚不动。
   * 所以：按住 350ms（期间没怎么动）才进入拖拽；这 350ms 内移动超过 8px 就当成滚动、取消长按。
   * 拖拽期间用**非 passive** 的 touchmove 拦下默认行为，否则手机上会一边拖一边滚页面 ——
   * 注意只在真的进入拖拽之后才拦，否则整个列表就滚不动了。
   * 落点判定交给 **DOM 顺序**：把拖着的行插到该去的位置，松手直接读 DOM 顺序写回 S.watch ——
   * 比自己去算"插到第几个下标"稳得多。 */
  const WL_HOLD = 350, WL_SLOP = 8;
  let wlDrag = null, wlSuppressClick = false;

  function wlOrder() {
    return Array.prototype.slice.call(document.querySelectorAll('#watchlist .stock-row'))
      .map(r => r.dataset.id).filter(Boolean);
  }

  /** 拖拽期间挡住页面滚动。**只在真的拖起来之后**才挡 —— 提前挡会让列表滚不动。 */
  function wlBlockScroll(e) {
    if (wlDrag && wlDrag.on && e.cancelable) e.preventDefault();
  }

  function wlDetach() {
    document.removeEventListener('pointermove', wlMove, true);
    document.removeEventListener('pointerup', wlUp, true);
    document.removeEventListener('pointercancel', wlUp, true);
    document.removeEventListener('touchmove', wlBlockScroll, { passive: false });
  }

  function wlCancel() {
    if (!wlDrag) return;
    clearTimeout(wlDrag.timer);
    wlDetach();
    if (wlDrag.row) wlDrag.row.classList.remove('dragging');
    wlDrag = null;
  }

  function wlMove(e) {
    if (!wlDrag) return;
    if (!wlDrag.on) {
      // 还没到长按时间就动了这么多 → 用户其实是在滚列表，取消
      if (Math.abs(e.clientY - wlDrag.y) > WL_SLOP || Math.abs(e.clientX - wlDrag.x) > WL_SLOP) wlCancel();
      return;
    }
    if (e.cancelable) e.preventDefault();
    const box = $('#watchlist');
    if (!box) return;
    const y = e.clientY;
    const rows = Array.prototype.slice.call(box.querySelectorAll('.stock-row'))
      .filter(r => r !== wlDrag.row);
    let before = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = rows[i]; break; }
    }
    if (before) box.insertBefore(wlDrag.row, before);
    else box.appendChild(wlDrag.row);
    // 拖到列表上下边缘时自动滚 —— 自选长了以后不这么做根本拖不到头
    const br = box.getBoundingClientRect();
    if (y < br.top + 26) box.scrollTop -= 9;
    else if (y > br.bottom - 26) box.scrollTop += 9;
  }

  function wlUp() {
    if (wlDrag && wlDrag.on) wlCommit(); else wlCancel();
  }

  function wlCommit() {
    const row = wlDrag.row;
    const box = $('#watchlist');
    clearTimeout(wlDrag.timer);
    wlDetach();
    row.classList.remove('dragging');
    wlDrag = null;
    // 刚拖完的那一下 click 要吃掉，否则会顺手切到某个城市。
    // 用超时而不是"下一次 pointerdown 清"：click 是 pointerup 之后另起一个任务，
    // 清早了就白设了。
    wlSuppressClick = true;
    setTimeout(() => { wlSuppressClick = false; }, 400);

    const ids = wlOrder();
    // 数量对不上说明 DOM 跟 S.watch 不同步（比如这期间列表被重画过）→ 只重画，不写坏数据
    if (ids.length !== S.watch.length) { renderWatchlist(); return; }
    if (ids.every((x, i) => x === S.watch[i])) { renderWatchlist(); return; }   // 没动，白拖
    S.watch = ids;
    storeSet('watch', S.watch);
    // 手动排过序之后"默认排序"才有意义 —— 顺手切回默认档。
    // 否则用户拖完看到的还是按涨幅/名称排的，会以为拖了没用。
    if (S.sortMode !== 0) S.sortMode = 0;
    renderWatchlist();
    toast('收藏顺序已保存');
  }

  function bindWatchDrag() {
    const box = $('#watchlist');
    if (!box) return;
    box.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;              // 只认左键 / 触摸
      const t = e.target;
      if (!t || !t.closest) return;
      const row = t.closest('.stock-row');
      if (!row || !row.dataset.id) return;
      if (t.closest('.sw-star')) return;    // 删除 / 加星不算拖拽
      wlCancel();
      wlDrag = { row: row, y: e.clientY, x: e.clientX, on: false, timer: 0 };
      wlDrag.timer = setTimeout(() => {
        if (!wlDrag) return;
        wlDrag.on = true;
        row.classList.add('dragging');
        // 手机上来一下短触感，知道"已经拿起来了"
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { } }
      }, WL_HOLD);
      document.addEventListener('pointermove', wlMove, true);
      document.addEventListener('pointerup', wlUp, true);
      document.addEventListener('pointercancel', wlUp, true);
      document.addEventListener('touchmove', wlBlockScroll, { passive: false });
    });
  }

  /* 自选变了之后要跟着刷的所有视图，收在一处 —— 以前是每个调用点自己挑着刷，
   * 于是总有漏的（行情头那颗星加进来时，左边的自选列表和「全部城市」抽屉
   * 都不会更新）。以后再加显示自选的地方，只改这一个函数。 */
  function refreshWatchViews() {
    renderWatchlist(); renderIndexes(); buildDrawer(); renderQStar();
  }
  function addWatch(id) {
    if (S.watch.indexOf(id) >= 0) { toast('已经收藏过了'); return; }
    S.watch.push(id); storeSet('watch', S.watch);
    refreshWatchViews();
    warmQuotes();
    // 刚收藏的这座，趁现在就把整份数据补上 —— 下次点过去就不会先空等六路请求
    warmCities();
    toast('已收藏：' + (API.Cities.get(id) || {}).name);
  }
  function removeWatch(id) {
    S.watch = S.watch.filter(x => x !== id); storeSet('watch', S.watch);
    refreshWatchViews(); toast('已取消收藏');
  }
  /* 行情头里城市名旁边那颗星。
   * 为什么要有它：以前只有「搜索结果行」「全部城市抽屉」「定位行」三处能加星，
   * 所以**点开一座城之后就没地方加它了**，只能回搜索框再搜一遍（使用者反馈）。
   * 现在不管这座城是怎么进来的（搜索 / 指数条 / 抽屉 / 定位 / 自选本身），
   * 正在看的是哪座，就在它名字旁边加。
   * ⚠ 星号必须**永远**画出来（只在已自选时才画的话，没自选的城市就没有星可点，
   *   也就永远加不进去 —— buildDrawer 那边踩过同一个坑，见那里的注释）。 */
  function renderQStar() {
    const b = $('#qStar');
    if (!b) return;
    const c = S.cur;
    if (!c) { b.hidden = true; return; }
    const on = S.watch.indexOf(c.id) >= 0;
    b.hidden = false;
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', on);
    b.title = on ? '取消收藏' : '收藏';
  }

  /* ═══════════ 当前所在地 ═══════════ */
  /*
   * 定位拿到的坐标本身就是一个「合成城市」：天气数据直接按经纬度取 Open-Meteo，
   * 所以列表里显示的是你**所在位置**的天气，而不是最近那个城市的天气 —— 这就是
   * 「越精确越好」的落点。地址反查只是为了让名字好看，失败也照样出天气。
   *
   * 反查走 BigDataCloud 的 reverse-geocode-client（免 key、`Access-Control-Allow-Origin: *`，
   * 实测返回中文 city/locality/principalSubdivision）。Nominatim 反查不可用（本机连不上）。
   */
  const LOC_ID = '__loc__';

  function haversine(a1, o1, a2, o2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (a2 - a1) * rad, dLon = (o2 - o1) * rad;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** 在城市目录里找离坐标最近的一个：气象局站号与单站雷达都只能靠它回落 */
  function nearestCity(lat, lon) {
    let best = null, bk = Infinity;
    API.Cities.all.forEach(c => {
      if (c.lat == null || c.lon == null) return;
      const k = haversine(lat, lon, c.lat, c.lon);
      if (k < bk) { bk = k; best = c; }
    });
    return best ? { c: best, km: bk } : null;
  }

  function geoLabel(g) {
    if (!g) return '';
    const t = g.district || g.city || g.prov;
    return t || (g.lat.toFixed(2) + ', ' + g.lon.toFixed(2));
  }

  /** 把定位结果做成 city 对象塞进目录，selectCity / 自选 / 行情轮询就都能直接用 */
  function registerGeo(g) {
    if (!g || g.lat == null) return null;
    const c = {
      id: LOC_ID,
      name: g.district || g.city || g.nearName || '当前所在地',
      prov: g.prov || '',
      py: 'dingwei',
      lat: g.lat, lon: g.lon,
      cma: '',                 // 没有气象局站号 → 自动全走 Open-Meteo
      path: '',
      // 区/市要跟着走：行情头那行编号要显示「天河区 · 广东省」，
      // 预警滚动条也要拿它去筛"本区市的预警"。丢了它就只能显示到省。
      district: g.district || '', city: g.city || '',
      loc: true
    };
    c.search = (c.name + c.prov + 'dingwei' + LOC_ID).toLowerCase();
    API.Cities.byId[LOC_ID] = c;
    return c;
  }

  /** 反查地名（失败返回 {}，绝不阻塞出天气）。localityLanguage 要用 zh-Hans：zh / zh-CN 返回的是繁体「越秀區」 */
  async function reverseGeo(lat, lon) {
    try {
      const u = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat +
        '&longitude=' + lon + '&localityLanguage=zh-Hans';
      const d = await API.getJSON(u, { ttl: 86400000, key: 'geo:' + lat + ',' + lon });
      return {
        district: d.locality || d.city || '',
        city: d.city || '',
        prov: d.principalSubdivision || ''
      };
    } catch (e) { return {}; }
  }

  /** 记下定位结果并刷新界面（坐标 → 最近城市 → 地名 → 渲染）。多处调用，统一入口 */
  async function applyGeo(lat, lon, acc, useName) {
    const g = { lat: lat, lon: lon, acc: acc || 0, at: Date.now() };
    if (useName !== false) Object.assign(g, await reverseGeo(g.lat, g.lon));
    const n = nearestCity(g.lat, g.lon);
    if (n) { g.nearId = n.c.id; g.nearName = n.c.name; g.nearKm = Math.round(n.km); }
    // 反查失败也要有个像样的名字：退到最近的城市名
    if (!g.district && !g.city && g.nearName) g.district = '近' + g.nearName;
    S.geo = g; S.geoBusy = false; S.geoErr = '';
    storeSet('geo', g);
    registerGeo(g);
    renderGeo(); renderWatchlist();
    // ★ 定位结果必须**立刻**有价，所以这里别写成一个条件。
    //   原来只有 `if (S.cur && S.cur.id !== LOC_ID) warmQuotes()`：开机时定位和首次加载
    //   是并行的，`S.cur` 很可能还没准备好 —— 这条就会被静默跳过，
    //   而默认刷新间隔是 **15 分钟**。结果就是「当前所在地」那一格挂着灰 `--` 等一刻钟。
    //   报价按 id 缓存（`API.Store.quotes` 有 ttl），重复调只是命中缓存，代价可以忽略。
    if (S.cur && S.cur.id !== LOC_ID) warmQuotes();
    else if (S.geo) warmQuotes();
    return g;
  }

  /** 切城市。
      原来是"排队等前一次加载结束再切"（`if (S.loading) { S.pendingCity = id; ... }`），
      现在 selectCity 自己会**作废**前一次加载（见那里的 loadSeq），所以直接切就行，
      不用再等。函数名留着是因为开机时定位那条路（`geoP.then`）还在用它。 */
  function selectWhenIdle(id) {
    if (S.cur && S.cur.id === id) return;
    selectCity(id);
  }

  /** 查询浏览器定位权限：granted / prompt / denied / unknown
   *  这一步很重要 —— getCurrentPosition 的权限提示只会弹一次，
   *  如果在页面加载时静默调用、用户当时点掉了，之后就再也弹不出来，
   *  表现为「点了也没反应」。所以加载时先看权限，只有已授权才静默定位。 */
  function geoPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('unknown');
    return navigator.permissions.query({ name: 'geolocation' })
      .then(p => p.state || 'unknown')
      .catch(() => 'unknown');
  }

  /** 返回 Promise：定位结束（成功或失败）后 resolve 成 geo 对象或 null */
  function locate(silent) {
    if (!navigator.geolocation) {
      S.geoErr = 'unsupported'; renderGeo();
      if (!silent) toast('此环境不支持定位');
      return Promise.resolve(null);
    }
    if (S.geoBusy) return Promise.resolve(null);
    S.geoBusy = true; S.geoErr = ''; renderGeo();
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(pos => {
        applyGeo(+pos.coords.latitude.toFixed(5), +pos.coords.longitude.toFixed(5),
          Math.round(pos.coords.accuracy || 0)).then(g => {
            if (!silent) toast('已定位：' + geoLabel(g) + (g.acc ? '（精度 ' + g.acc + ' m）' : ''));
            resolve(g);
          });
      }, err => {
        S.geoBusy = false;
        S.geoErr = err && err.code === 1 ? 'denied' : (err && err.code === 3 ? 'timeout' : 'failed');
        renderGeo();
        if (!silent) toast(S.geoErr === 'denied'
          ? '浏览器已禁止本站定位 —— 点地址栏左侧的锁图标，把「位置」改成「允许」'
          : S.geoErr === 'timeout' ? '定位超时，可点这里重试' : '定位失败，可点这里重试');
        resolve(null);
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    });
  }

  function renderGeo() {
    const box = $('#geolist'); if (!box) return;
    box.innerHTML = '';
    if (S.geoBusy) { box.appendChild(el('div', { class: 'sr-empty', text: '正在定位…' })); return; }

    if (!S.geo) {
      const msg = S.geoErr === 'denied' ? '已被浏览器禁止 · 点地址栏 🔒 把「位置」改成「允许」后点这里'
        : S.geoErr === 'unsupported' ? '此环境不支持定位（可在搜索框选城市）'
          : S.geoErr === 'timeout' ? '定位超时，点这里重试'
            : S.geoErr ? '定位失败，点这里重试' : '点这里获取定位权限并显示当地气温';
      box.appendChild(el('div', {
        class: 'stock-row' + (S.cur && S.cur.id === LOC_ID ? ' on' : ''),
        onclick: () => locate(false)
      }, [
        el('div', {}, [
          el('div', { class: 'sw-name', text: '📍 定位当前位置' }),
          el('div', { class: 'sw-sub', text: msg })
        ]),
        el('div', { class: 'sw-price', text: '--' }),
        el('div', { class: 'sw-pct p-flat', text: '--' })
      ]));
      return;
    }

    const g = S.geo, q = quoteOf(LOC_ID);
    const col = U.trendColor(q.chg);
    // ⚠ starred 必须在 row **之前**算：星现在是在 row 的字面量里造的，
    // 放到后面去会撞 const 的 TDZ（Cannot access 'starred' before initialization）。
    const starred = S.watch.indexOf(LOC_ID) >= 0;
    const sub = [
      (g.city && g.city !== g.district) ? g.city : '',
      g.prov || '',
      g.acc ? '精度 ' + g.acc + ' m' : '',
      g.nearName ? '近 ' + g.nearName + ' ' + g.nearKm + ' km' : ''
    ].filter(Boolean).join(' · ') || (g.lat.toFixed(3) + ', ' + g.lon.toFixed(3));

    const row = el('div', {
      class: 'stock-row' + (S.cur && S.cur.id === LOC_ID ? ' on' : ''),
      'data-id': LOC_ID,
      onclick: (e) => {
        if (e.target.classList.contains('sw-star')) return;
        selectCity(LOC_ID);
      }
    }, [
      el('div', {}, [
        el('div', { class: 'sw-name-row' }, [
          // 定位到的可能是**区县**，全名最长 15 个字（`双江拉祜族佤族布朗族傣族自治县`）——
          // 比名字格宽得多。同样包一层内层，选中这一行时横向滚动看全（见 markNameOverflow）。
          el('div', { class: 'sw-name' }, [
            el('span', { class: 'sw-name-in', text: '📍 ' + (g.district || g.city || '当前所在地') })
          ]),
          el('span', {
            class: 'sw-star' + (starred ? ' on' : ''),
            text: starred ? '★' : '☆',
            title: starred ? '取消收藏' : '收藏当前所在地',
            onclick: (e) => {
              e.stopPropagation();
              if (starred) removeWatch(LOC_ID); else addWatch(LOC_ID);
              renderGeo();
            }
          })
        ]),
        el('div', { class: 'sw-sub', text: sub })
      ]),
      el('div', { class: 'sw-price', style: { color: col }, text: q.temp == null ? '--' : fx(q.temp, 1) }),
      el('div', { class: 'sw-pct ' + (q.chg == null ? 'p-flat' : (q.chg > 0 ? 'p-up' : q.chg < 0 ? 'p-down' : 'p-flat')), text: q.pct == null ? '--' : sgn(q.pct, 2) + '%' })
    ]);
    box.appendChild(row);
    markNameOverflow(row, LOC_ID);
  }

  /** 启动时恢复上次定位；**不会**在加载时弹权限框（只在已授权时静默刷新）。
   *  返回 Promise<geo|null> */
  function initGeo(q) {
    const g = storeGet('geo', null);
    if (g && g.lat != null) { S.geo = g; registerGeo(g); }
    renderGeo();
    if (q && q.lat && q.lon) {          // ?lat=&lon= 手动指定坐标（可分享，也方便无头截图自查）
      S.geoBusy = true; renderGeo();
      return applyGeo(+q.lat, +q.lon, 0);
    }
    if (!g) {
      // 关键：不要在加载时静默调 getCurrentPosition。
      // 权限提示一辈子只弹一次，用户没预期时点掉就再也弹不出来（表现为「点了没反应」）。
      // 所以只有浏览器已经授权过才静默取，否则等用户点那一行再触发提示。
      return geoPermission().then(p => (p === 'granted' ? locate(true) : S.geo));
    }
    if (Date.now() - (g.at || 0) > 1800000) return locate(true);   // 超过 30 分钟静默刷新
    return Promise.resolve(S.geo);
  }

  /* ═══════════ 行情头 ═══════════ */
  /** 逐小时数组里"当前这个小时"的下标。找不到就取最后一个不晚于现在的，
   *  一个都没有返回 -1（调用方显示 `--`，绝不拿数组第 0 项冒充当前）。 */
  function hourIndexAt(times) {
    if (!times || !times.length) return -1;
    const now = API.cityNow(S.cur), p = x => (x < 10 ? '0' + x : '' + x);
    const key = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) +
      'T' + p(now.getHours());
    let i = times.findIndex(t => String(t).slice(0, 13) === key);
    if (i >= 0) return i;
    i = -1;
    for (let k = 0; k < times.length; k++) if (String(times[k]).slice(0, 13) <= key) i = k;
    return i;
  }
  /** 云量百分数 → 天气话。抬头看一眼天，和这个数对得上才有用。 */
  function cloudWord(v) {
    if (v == null) return '';
    if (v < 10) return '晴';
    if (v < 30) return '少云';
    if (v < 70) return '多云';
    if (v < 90) return '阴';
    return '阴沉';
  }
  /** 紫外线指数分级（WHO 标准：0-2 弱 / 3-5 中等 / 6-7 强 / 8-10 很强 / 11+ 极强） */
  function uvWord(v) {
    if (v == null) return '';
    if (v < 3) return '弱';
    if (v < 6) return '中等';
    if (v < 8) return '强';
    if (v < 11) return '很强';
    return '极强';
  }
  /** 月相。算法统一放在 astro.js（那里还有月出月落、太阳高度、黄金蓝调、流星雨日历），
   *  这里只做转发 —— 同一套朔望月公式不要在两个文件里各写一遍。
   *  astro.js 在 index.html 里排在本文件之前，正常不会缺；真缺了也只是这一格显示 --。 */
  function moonPhaseTxt(dt) {
    return (window.ASTRO && ASTRO.moonPhaseTxt) ? ASTRO.moonPhaseTxt(dt) : '--';
  }

  /** 城市当地「今天 0 点」的真实时刻 t0，以及当地墙钟比本机快多少 off（显示事件时刻时加回去）。
   *  天文事件是真实时刻，不按城市时区挪的话，海外城市的日出会按北京的一天去找、按北京时间显示。 */
  function cityMidnight(c, now) {
    const at = now == null ? Date.now() : +new Date(now);
    const d = API.cityNow(c, at);
    const off = Math.round((d.getTime() - at) / 60000) * 60000;   // toLocaleString 丢了毫秒，取整到分钟
    d.setHours(0, 0, 0, 0);
    return { t0: d.getTime() - off, off: off };
  }

  /** 今天的日出日落（本地 0 点起 24 小时内）—— 只在 Open-Meteo 那份拿不到时用。
   *
   *  为什么要有这个兜底：Open-Meteo 额度用尽时，行情头的「日出/日落」会变成 `--/--`，
   *  可这一格**根本不需要联网** —— astro.js 按经纬度和日期就能推（天文页一直用的是它）。
   *  使用者的原话："有些不是可以在天文功能页里看到吗，为什么不补上呢"。
   *  返回 null = 算不出来（缺经纬度或 astro.js 不在），调用方就退回 Open-Meteo 那份。 */
  function sunRiseSet(now) {
    const c = S.cur;
    if (!window.ASTRO || !c || c.lat == null || c.lon == null) return null;
    try {
      const { t0, off } = cityMidnight(c, now);
      const evs = ASTRO.sunEvents(t0, t0 + 86400000, c.lat, c.lon);
      const pick = k => {
        const e = evs.filter(x => x.kind === k)[0];
        return e ? U.fmtHM(new Date(e.t + off)) : '--';
      };
      const rise = pick('sunrise'), set = pick('sunset');
      return (rise === '--' && set === '--') ? null : (rise + '/' + set);
    } catch (e) { return null; }
  }

  /** 今天的月出月落（本地 0 点起 24 小时内）。
   *  月亮每天要晚出来约 50 分钟，一个月里总有一两天"今天不升"或者"今天不落"——
   *  那种日子返回 --，不编一个不存在的时间出来充数。 */
  function moonRiseSet(now) {
    const c = S.cur;
    if (!window.ASTRO || !c || c.lat == null || c.lon == null) return null;
    const { t0, off } = cityMidnight(c, now);
    const evs = ASTRO.moonEvents(t0, t0 + 86400000, c.lat, c.lon);
    const pick = k => {
      const e = evs.filter(x => x.kind === k)[0];
      return e ? U.fmtHM(new Date(e.t + off)) : '--';
    };
    return { rise: pick('moonrise'), set: pick('moonset') };
  }
  const moonTxt = moonPhaseTxt(new Date());

  function renderQuoteHead() {
    const c = S.cur, d = S.data;
    if (!c || !d) return;
    const q = quoteOf(c.id);
    const ti = d.todayIndex;
    const curBar = ti >= 0 ? d.daily[ti] : null;
    /* 日K 拿不到时（Open-Meteo 额度用尽 → daily 是空数组）退回**官方预报里的今天**。
       这两个数字气象局本来就在给（`d.officialToday`，来自站点预报 → 中国天气网 d1），
       以前只挂在 Open-Meteo 聚合出来的日K 上，于是整块统计变成一片 `--` ——
       使用者报的"额度不够又变成啥都没有"就是这一处。 */
    const offToday = (!curBar && d.officialToday) ? d.officialToday : null;
    /* ⚠ 这里原来读的是 `curBar.h` / `curBar.l` —— 那是 **Open-Meteo 逐小时聚合**，
       而 `curBar.high` / `curBar.low` 才是 `api.js` 里定过稿的「**官方优先、meteo 补缺**」
       值（见 `api.js:1478` `b.high = o.high`，`hlSrc` 就标在它上面）。
       同一个文件里 5 日预报那条路（`app.js:839-840`）早就写着"不许再优先 Open-Meteo"，
       这里却正是它警告的那种写法。先把它改成同一口径，作为**下面的兜底**。 */
    const offHi = curBar ? (curBar.high != null ? curBar.high : curBar.h)
      : (offToday ? offToday.high : null);
    const offLo = curBar ? (curBar.low != null ? curBar.low : curBar.l)
      : (offToday ? offToday.low : null);

    /* ── 「今日最高/最低」＝**分时图整条（今天 00–23）的极点** ──────────────
       口径由使用者（m01295）定：跟着分时图的极点走，**同时把分时图未发生的那半画成虚线**
       （见 `chart.js` 的 `optTrend`）—— 数字与图口径一致，而且一眼能看出这个极值里
       "有多少是预报"。行情栏里**不加任何新说明**，靠图上的虚线区分。
       为什么直接读 `curBar.h`/`curBar.l`：分时图就是 `d.intraday`（今天 24 个整点），
       而两者是**同一份逐小时数据**，实测三城逐个精确相等
       （娄底 26.5/13.9、北京 24.8/13、广州 30.3/19.4）。
       ⚠ 保底必须留着：**最新价并进区间**。只取极点、不并最新价的话「价 > 今日最高」
         当场就会出现 —— 实测北京：已过小时最高 16.9，而最新价 17.2。
       没有日K（Open-Meteo 全断）时退回官方预报 `offHi`/`offLo`。
       ⚠ 只动这两个数：行情栏其它格子**不加不减不改**。
         （`全天波动` 是从这两个数算出来的，会跟着走 —— 同一件事的两面，不是新格子。） */
    let hiToday = offHi, loToday = offLo;
    if (curBar && curBar.h != null && curBar.l != null) { hiToday = curBar.h; loToday = curBar.l; }
    {
      const nv = (q.temp != null) ? q.temp : ((d.now && d.now.temp != null) ? d.now.temp : null);
      if (nv != null) {
        hiToday = (hiToday == null) ? nv : Math.max(hiToday, nv);
        loToday = (loToday == null) ? nv : Math.min(loToday, nv);
      }
    }
    const prevBar = ti > 0 ? d.daily[ti - 1] : null;
    const base = d.base;
    const chg = q.chg, pct = q.pct;
    const col = U.trendColor(chg);

    $('#qName').textContent = c.name;
    renderQStar();
    // 定位城市是合成出来的记录（id 是 '__loc__' 这个内部占位），
    // 把它当城市编号打出来就是「__loc__ · 广东省」—— 用户截图里就是这么显示错的。
    $('#qCode').textContent = (c.id === LOC_ID)
      ? (c.district ? c.district + ' · ' + (c.prov || '') : (c.prov || '定位'))
      : (c.cma ? c.cma + ' · ' : '') + c.id + (c.prov ? ' · ' + c.prov : '');
    $('#qPrice').textContent = q.temp == null ? '--' : fx(q.temp, 1);
    $('#qPrice').style.color = col;
    $('#qChange').textContent = chg == null ? '--' : sgn(chg, 1);
    $('#qChange').style.color = col;
    $('#qPct').textContent = pct == null ? '--' : sgn(pct, 2) + '%';
    $('#qPct').style.color = col;

    // 标签
    const tags = $('#qTags'); tags.innerHTML = '';
    // 天气文案优先用中国天气网日预报的措辞（"多云转晴"），没有就用 Open-Meteo 的天气码。
    // 以前这里以"气象局实况存在"为前提挑措辞，可实况缺失时会连着文案一起空掉。
    const dayTxt = (d.fcst && d.fcst.daily && d.fcst.daily[0]) ? d.fcst.daily[0].dayText : '';
    const wtxt = dayTxt || (curBar && curBar.wcode != null ? API.wmoText(curBar.wcode) : '');
    if (wtxt) tags.appendChild(el('span', { class: 'tag tag-info', text: U.wxIcon(wtxt) + ' ' + wtxt }));
    // 标签必须按 src 选：港澳台这种没有实时观测的站会退回 Open-Meteo，
    // 再写"中国气象局实况"就是撒谎（而且会把一年前的 lastUpdate 当成观测时刻显示）。
    if (d.now && d.now.src === 'cma')
      tags.appendChild(el('span', { class: 'tag tag-src', text: '中国气象局实况 ' + String(d.now.time || '').slice(11, 16) }));
    else if (d.now)
      tags.appendChild(el('span', { class: 'tag tag-src', text: 'Open-Meteo 实况 ' + String(d.now.time || '').slice(11, 16) }));
    else tags.appendChild(el('span', { class: 'tag tag-mute', text: '实况不可用' }));
    if (!c.cma) tags.appendChild(el('span', { class: 'tag tag-mute', text: '无官方站号' }));
    if (API.LOCAL) tags.appendChild(el('span', { class: 'tag tag-src', text: '中国天气网代理已连接' }));
    const phase = marketPhase();
    tags.appendChild(el('span', {
      class: 'tag ' + (phase === 'open' ? 'tag-warn' : 'tag-mute'),
      text: phase === 'open' ? '盘中' : phase === 'break' ? '午间休市' : '休市'
    }));

    // 统计格
    const n = d.now || {};
    const om = d.omDaily[curBar ? curBar.d : ''] || {};

    // ── 天文与日照那四格的数据 ──
    // 云量 / 紫外线取"当前这个小时"的值：抬头看一眼天，和这个数对得上才有用，
    // 拿今天的平均值反而对不上。
    const hi = hourIndexAt(d.hourly && d.hourly.time);
    const cloudNow = (hi >= 0 && d.hourly.cloud) ? d.hourly.cloud[hi] : null;
    const uvNow = (hi >= 0 && d.hourly.uv) ? d.hourly.uv[hi] : null;
    // 昼长优先用 Open-Meteo 的 daylight_duration（秒）；它没给就自己拿日出日落相减。
    let daySec = (om.daylight != null && isFinite(om.daylight)) ? om.daylight : null;
    if (daySec == null && om.sunrise && om.sunset) {
      const a = Date.parse(String(om.sunrise).replace(' ', 'T'));
      const b = Date.parse(String(om.sunset).replace(' ', 'T'));
      if (isFinite(a) && isFinite(b) && b > a) daySec = (b - a) / 1000;
    }
    const daylightTxt = daySec == null ? '--'
      : Math.floor(daySec / 3600) + ' 时 ' + Math.round((daySec % 3600) / 60) + ' 分';
    const cloudTxt = cloudNow == null ? '--' : Math.round(cloudNow) + '% ' + cloudWord(cloudNow);
    const uvTxt = uvNow == null ? '--' : fx(uvNow, 1) + ' ' + uvWord(uvNow);

    // 日出日落并成一格，空出来的那一格放今天的月出月落（用户要求）。
    // ⚠ 这两格**都不能只挂在 Open-Meteo 上**：astro.js 本地就能推（天文页用的就是它）。
    //   以前日出日落只读 `om.sunrise/om.sunset`，Open-Meteo 一断就成了 `--/--` ——
    //   而屏上明明算得出来。使用者原话："有些不是可以在天文功能页里看到吗，为什么不补上呢"。
    const hm = s => (s ? String(s).slice(11, 16) : '--');
    // ⚠ 这里**不能**写 `sunRiseSet(om)` —— 参数是"基准时间"，om 是个对象，
    //   `new Date(对象)` 是 Invalid Date，一路 NaN 到 sunEvents 算不出任何事件（第一版就栽在这）。
    const sunRS = sunRiseSet() || (hm(om.sunrise) + '/' + hm(om.sunset));
    const mrs = moonRiseSet();
    const moonRS = mrs ? (mrs.rise + '/' + mrs.set) : '--/--';

    // 降水合并成一格：雨量和降水时数是同一件事的两面，拆成两格反而把
    // "同类放一起"的行分组撑到 21 格（4 列排不满，最后一行会落单）。
    // Open-Meteo 那路没有日K时，退回**气象局实况的降水量**（`now.precipitation`）——
    // 那格本来就有值，不该因为曲线断了就跟着变 `--`。
    const rainTxt = curBar ? fx(curBar.v, 1) + ' mm / ' + (curBar.rainHours || 0) + ' h'
      : (n.precip != null ? fx(n.precip, 1) + ' mm' : '--');
    const rainTip = curBar ? ('降水 ' + rainTxt + '（雨量 / 降水时数）')
      : (n.precip != null ? '降水 ' + rainTxt + '（中国气象局实况，只有瞬时降水量、没有降水时数）'
        : '降水 --');

    // 统计格按"同类"分组 —— 用户反馈："行情头里同类型的数据是不是放一起更好啊"。
    // 每组尽量凑满 4 格：4 列栅格下每组正好占一行，从左往右扫过去就是一类；组间用一条横线隔开。
    const groups = [
      // ① 今天有多热
      [
        ['今日最高', hiToday == null ? '--' : fx(hiToday, 1), U.upColor()],
        ['今日最低', loToday == null ? '--' : fx(loToday, 1), U.downColor()],
        ['体感', n.feels == null ? '--' : fx(n.feels, 1) + ' ℃', null],
        ['全天波动', (hiToday == null || loToday == null) ? '--' : fx(hiToday - loToday, 1) + ' ℃', null]
      ],
      // ② 风（气压跟着风走：都是"大气"这一类的动力/压力读数）
      [
        ['风速', n.windSpeed == null ? (curBar && curBar.windAvg != null ? fx(curBar.windAvg, 1) + ' m/s' : '--') : fx(n.windSpeed, 1) + ' m/s ' + U.windLevel(n.windSpeed), null],
        ['风向', n.windDir || '--', null],
        ['平均风速', curBar && curBar.windAvg != null ? fx(curBar.windAvg, 1) + ' m/s' : '--', null],
        ['气压', n.pressure == null ? '--' : fx(n.pressure, 0) + ' hPa', null]
      ],
      // ③ 天上有什么、空气有多潮 —— 云量/紫外线（天上）和湿度/降水（水汽）挨着
      [
        ['云量', cloudTxt, null],
        ['紫外线', uvTxt, null],
        ['湿度', n.humidity == null ? (curBar && curBar.humAvg != null ? curBar.humAvg + '%' : '--') : n.humidity + '%', null],
        ['降水', rainTxt, null, rainTip]
      ],
      // ④ 日月与日照。日出/日落挤进一格（用户要求），省下的那格给月出/月落 ——
      //    这两对本来就是"成对出现"的东西，各占两格会把这一组撑成 6 格、排不满一行。
      [
        ['日出/日落', sunRS, null],
        ['月出/月落', moonRS, null],
        ['昼长', daylightTxt, null],
        ['月相', moonTxt, null]
      ],
      // ⑤ 这几个数是从哪来的：今天 0 点 / 昨天收在多少 / 去年同期 / 几个观测点
      [
        // 标签刻意用天气话写，不用"今开/昨收"这类炒股词 —— 保留炒股软件的"长相"就够了，
        // 不该要求用户会炒股才能看懂（用户反馈："那些炒股软件术语我不炒股看不懂"）。
        ['今日 0 点', curBar ? fx(curBar.o, 1) : '--', curBar && base != null ? U.trendColor(curBar.o - base) : null],
        ['昨日 23 点', base == null ? '--' : fx(base, 1), null],
        // 标签写短一点：统计格只有 ~107px 宽，"历史今日" + "32.7 / 22.9" 会被省略号截掉
        ['同期', prevBar ? fx(prevBar.h, 1) + '/' + fx(prevBar.l, 1) : '--', null],
        ['观测点', curBar ? curBar.n + ' 个' : '--', null]
      ]
    ];
    const box = $('#qStats'); box.innerHTML = '';
    groups.forEach(cells => {
      const g = el('div', { class: 'qg' });
      cells.forEach(([k, v, c2, tip]) => g.appendChild(el('div', { class: 'qs', title: tip || (k + ' ' + v) }, [
        el('b', { text: k }), el('span', { style: c2 ? { color: c2 } : null, text: String(v) })
      ])));
      box.appendChild(g);
    });
  }

  /* ═══════════ 五档盘口（未来 5 日预报） ═══════════ */
  /** 统一成 [{date, high, low, dayText, nightText, dayWind, precip, src}]，官方预报优先，缺失时回退 Open-Meteo 16 日预报 */
  function obList() {
    // ⚠ 这里**只要求 S.data 存在，不能要求 d.daily 非空**。
    // 气象局那 5 日预报（d.fcst.daily）跟 Open-Meteo 的日K 是**两条独立的路**：
    // 2026-10-07 Open-Meteo 额度用尽、d.daily 是空数组，于是一进函数就 bail 了 ——
    // 盘口明明有官方预报，界面上却写着"暂无预报数据"。使用者的原话：
    // "至少行情栏那些数据得有吧" —— 盘口就是行情栏的一部分。
    const d = S.data; if (!d) return null;
    const out = [];
    const fd = d.fcst && d.fcst.daily;
    if (fd && fd.length > 1) {
      fd.slice(0, 6).forEach(x => {
        const iso = String(x.date).replace(/\//g, '-');
        const om = (d.omDaily && d.omDaily[iso]) || {};
        out.push({
          date: iso, high: x.high, low: x.low,
          dayText: x.dayText, nightText: x.nightText, dayWind: x.dayWind,
          precip: om.precip, src: 'cma'
        });
      });
      return out;
    }
    const ti = d.todayIndex;
    if (ti == null || ti < 0) return null;
    for (let i = ti; i < d.daily.length && out.length < 6; i++) {
      const b = d.daily[i], om = (d.omDaily && d.omDaily[b.d]) || {};
      out.push({
        date: b.d,
        // b.high/b.low 在 api.js 里已经按「官方优先、Open-Meteo 补缺」定稿过，
        // 这里**不再优先 omHigh** —— 以前那么写等于把 Open-Meteo 摆在气象局前面。
        high: b.high != null ? b.high : b.h,
        low: b.low != null ? b.low : b.l,
        dayText: om.code != null ? API.wmoText(om.code) : '', nightText: '',
        dayWind: '',
        precip: om.precip != null ? om.precip : b.v,
        src: 'om'
      });
    }
    return out.length > 1 ? out : null;
  }

  function renderOrderbook() {
    const box = $('#orderbook');
    box.innerHTML = '';
    const list = obList();
    if (!list || list.length < 2) {
      box.appendChild(el('div', { class: 'sr-empty', text: '暂无预报数据' }));
      return;
    }
    const q = quoteOf(S.cur.id);
    const cur = q.temp;
    const src = list[0].src;
    /* 盘口这块同样是**传播**气象局的预报（未来 5 日），所以一样要注明台站与发布时间 ——
       《气象预报发布与传播管理办法》第九条要求"注明气象预报发布的气象台名称和发布时间"，
       第十四条第三项就是这条的罚则。发布时间取气象局逐小时那份带的 `publishTime`
       （同一次发布的预报）。 */
    const pubTxt = (S.data && S.data.cmaHourly && S.data.cmaHourly.publishTime)
      ? ' · 台站 ' + (S.cur.cma || '—') + ' · 发布 ' +
        String(S.data.cmaHourly.publishTime).replace(/\//g, '-').slice(5, 16)
      : '';
    box.appendChild(el('div', { class: 'ob-src', text: (src === 'cma' ? '中国气象局预报 · 未来 5 日' : 'Open-Meteo 预报 · 未来 5 日（官方源不可用）') + (src === 'cma' ? pubTxt : '') }));
    // 排布仍照股票盘口的习惯（上高下低、单调排列），但标签换成天气话：
    // 原来的"卖五/买一"对不炒股的人等于天书。
    const md = s => String(s || '').slice(5);   // 'YYYY-MM-DD' → 'MM-DD'
    const fut = list.slice(1, 6);
    const asks = fut.slice().sort((a, b) => a.high - b.high);
    const bids = fut.slice().sort((a, b) => a.low - b.low);
    for (let i = asks.length; i >= 1; i--) {
      const f = asks[i - 1];
      box.appendChild(makeObRow(md(f.date) + ' 最高', f.high, f, cur, 'ask'));
    }
    box.appendChild(el('div', { class: 'ob-mid' }, [
      el('span', { text: '现在 ' + (cur == null ? '--' : fx(cur, 1)) + '℃' }),
      el('b', { style: { color: U.trendColor(q.chg) }, text: q.pct == null ? '--' : '比昨天 ' + sgn(q.pct, 2) + '%' }),
      el('span', { text: '5 天落差 ' + spread(list) })
    ]));
    for (let i = 1; i <= bids.length; i++) {
      const f = bids[i - 1];
      box.appendChild(makeObRow(md(f.date) + ' 最低', f.low, f, cur, 'bid'));
    }
  }

  function spread(list) {
    const fut = list.slice(1, 6);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < fut.length; i++) { if (fut[i].high > mx) mx = fut[i].high; if (fut[i].low < mn) mn = fut[i].low; }
    return (mx === -Infinity || mn === Infinity) ? '--' : fx(mx - mn, 1) + '℃';
  }

  function makeObRow(label, val, f, cur, side) {
    const om = (S.data.omDaily && S.data.omDaily[f.date]) || {};
    const amount = f.precip != null ? f.precip : (om.precip == null ? 0 : om.precip);
    const maxA = 20;
    const w = U.clamp(amount / maxA * 100, 3, 100);
    const col = side === 'ask' ? U.upColor() : U.downColor();
    const tip = f.date + ' ' + (f.dayText || '') + (f.nightText ? '/' + f.nightText : '') + (f.dayWind ? ' 风 ' + f.dayWind : '');
    return el('div', { class: 'ob-row', title: tip }, [
      el('span', { class: 'ob-label', text: label }),
      el('span', { class: 'ob-price', style: { color: col }, text: fx(val, 1) }),
      el('span', { class: 'ob-val', text: fx(amount, 1) + 'mm' }),
      (() => { const b = el('div', { class: 'ob-bar' }); b.appendChild(el('i', { style: { width: w + '%', background: col } })); return b; })()
    ]);
  }

  /* ═══════════ 逐时成交（最近观测） ═══════════ */
  function renderTape() {
    const box = $('#tape'); box.innerHTML = '';
    const d = S.data; if (!d) return;
    const { time, temp, precip, wcode } = d.hourly;
    const out = [];
    for (let i = time.length - 1; i >= 1 && out.length < 60; i--) {
      if (String(time[i]).slice(0, 10) > d.today) continue;
      if (temp[i] == null) continue;
      out.push(i);
    }
    out.forEach(i => {
      const prev = temp[i - 1];
      const chg = prev == null ? 0 : temp[i] - prev;
      const t = String(time[i]);
      const amt = precip[i] || 0;
      box.appendChild(el('div', { class: 'tape-row', title: (wcode[i] != null ? API.wmoText(wcode[i]) : '') }, [
        el('span', { class: 't-time', text: t.slice(5, 10) + ' ' + t.slice(11, 16) }),
        el('span', { class: 't-temp', style: { color: U.trendColor(chg) }, text: fx(temp[i], 1) }),
        el('span', { class: 't-amt', text: amt > 0 ? fx(amt, 1) : '—' })
      ]));
    });
    /* Open-Meteo 那一路没有时（额度用尽），退回**气象局的逐 3 小时**。
       这条路本来就是气象局给的、一直在手上（`d.cmaHourly`），以前却让整块显示"暂无观测"——
       明明有官方数据却空着，使用者说"又变成啥都没有了"。

       ⚠ 两个坑，都踩过：
       ① `cmaHourly` 是**预报**（从发布时刻往后 7 天），不是观测 —— 所以口径小字必须改写成
          "逐 3 小时预报"，**不能**留在"最近观测"下面冒充实况；顺序也换成**正序**（先看最近的）。
       ② 它的下标 0 就是"今天 23:00"，而上面逐小时那段循环是 `i >= 1`（那里下标 0 用来算温差）
          —— 照抄过来会把唯一一条今天的数据排除掉，结果一格都渲染不出来（探针里量到"筛过后 = 0"）。 */
    if (!out.length && d.cmaHourly && d.cmaHourly.time && d.cmaHourly.time.length) {
      const ct = d.cmaHourly.time, ctemp = d.cmaHourly.temp, cprec = d.cmaHourly.precip, cwc = d.cmaHourly.wcode;
      const rows = [];
      for (let i = 0; i < ct.length && rows.length < 60; i++) {
        if (String(ct[i]).slice(0, 10) < d.today) continue;   // 往前翻到的旧时次不要
        if (ctemp[i] == null) continue;
        rows.push(i);
      }
      rows.forEach(i => {
        const prev = i > 0 ? ctemp[i - 1] : null;
        const chg = prev == null ? 0 : ctemp[i] - prev;
        const t = String(ct[i]).replace('T', ' ');
        const amt = cprec[i] || 0;
        box.appendChild(el('div', { class: 'tape-row', title: (cwc[i] != null ? API.wmoText(cwc[i]) : '') }, [
          el('span', { class: 't-time', text: t.slice(5, 10) + ' ' + t.slice(11, 16) }),
          el('span', { class: 't-temp', style: { color: U.trendColor(chg) }, text: fx(ctemp[i], 1) }),
          el('span', { class: 't-amt', text: amt > 0 ? fx(amt, 1) : '—' })
        ]));
      });
      if (rows.length) {
        const em = $('#tapeHint');
        if (em) em.textContent = '气象局逐 3 小时预报，正序（逐时观测暂时取不到）';
        return;
      }
    }
    const hint = $('#tapeHint');
    if (hint) hint.textContent = '最近观测，倒序';
    if (!out.length) box.appendChild(el('div', { class: 'sr-empty', text: '暂无观测' }));
  }

  /* ═══════════ 图表 ═══════════ */
  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
  function barKeyOf(mode, dateStr) {
    if (mode === 'month') return dateStr.slice(0, 7);
    if (mode === 'week') {
      const dt = U.parseDate(dateStr);
      const wd = (dt.getDay() + 6) % 7;
      return U.fmtDate(new Date(dt.getTime() - wd * 86400000));
    }
    return dateStr;
  }

  /** 主图每个周期默认显示多少根。K 线主图和天气副图都要拿它算 dataZoom，
      两处必须同源 —— 各写一份迟早会漂移，然后上下两块图显示的就是不同区间。 */
  function viewOf(period) {
    return (period === 'day' || period === 'fcst') ? 90 : period === 'week' ? 80 : period === 'month' ? 60 : 0;
  }

  /** 分时 / 7日 下的「温差」副图。
      温差（当日最高 − 当日最低）是**每天**的量：一天一个数，摊到 24 个小时上就是一条平线 ——
      分时档下整幅图只有一根柱子，等于没信息。所以逐小时这两档换成
      **「较当日均温」**：这一小时的气温比今天平均冷暖多少。
      数据用的是**主图自己那份逐时气温**（pts），所以上下两块图天然同一条时间轴、同一条日界。
      日K / 周K / 月K 那几档仍然是"当天的日内温差" —— 那里一天本来就是一根柱子，口径是对的。 */
  function renderVolSub(pts) {
    // 每天一个平均（只对有气温的小时求平均，"今天的平均"就是今天的口径）
    const byDay = {};
    pts.forEach(pt => {
      const ds = String(pt.t).slice(0, 10);
      (byDay[ds] = byDay[ds] || []).push(pt.p);
    });
    const avg = {};
    Object.keys(byDay).forEach(ds => {
      const a = byDay[ds].filter(v => v != null);
      avg[ds] = a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    });
    let prev = null;
    const bars = pts.map(pt => {
      const ds = String(pt.t).slice(0, 10);
      const v = (pt.p == null || avg[ds] == null) ? null : +(pt.p - avg[ds]).toFixed(2);
      // o 用**上一小时**的偏离值：柱子颜色于是表示"比上一小时更暖（红）/ 更冷（绿）"，
      // 跟主图蜡烛"红=升温"的习惯一致。
      const b = { d: String(pt.t).slice(5, 16).replace('T', ' '), o: prev == null ? v : prev, c: v, dev: v };
      prev = v;
      return b;
    });
    Chart.renderSub({
      indName: 'vol', bars: bars, ind: {}, cats: pts.map(x => x.t),
      metric: 'dev', period: S.period
    });
  }

  function seriesFor(period) {
    const d = S.data; if (!d) return null;
    const today = d.today;
    let bars, mode = 'day';
    if (period === 'week') { bars = d.week; mode = 'week'; }
    else if (period === 'month') { bars = d.month; mode = 'month'; }
    // 预报K：过去的日子只留最近 10 天当参照，剩下全给未来 16 天预报。
    // 原来往回留 45 天，图上四分之三都是历史，用户反馈"过去日子的占比太多了"。
    else if (period === 'fcst') { bars = d.daily.filter(b => b.d >= API.shiftDate(today, -10)); mode = 'day'; }
    else bars = d.daily;
    if (!bars || !bars.length) return null;
    const ind = IND.computeAll(bars);
    const tk = barKeyOf(mode, today);
    let ti = -1;
    for (let i = 0; i < bars.length; i++) if (bars[i].d <= tk) ti = i;
    const base = ti > 0 ? bars[ti - 1].c : null;
    const view = viewOf(period);
    return {
      bars, ind, mode, base, today: tk, view,
      monthMode: mode === 'month',
      title: ({ trend: '分时', '7day': '7日分时', day: '日K', week: '周K', month: '月K', fcst: '预报K' })[period] + ' · ' + bars.length + ' 根'
    };
  }

  /* ═══════════ 天气副图（降水 / 风 / 云量 / 空气） ═══════════ */
  /** S.ind 是不是天气副图口径 */
  function isWxInd() {
    return !!(window.WXUI && window.Weather && Weather.isWeatherSub(S.ind) && S.ind !== 'range');
  }
  /** 画天气副图；不是天气口径就返回 false，交回 chart.js 画温差柱 */
  function renderWxSub() {
    if (!isWxInd()) return false;
    const wx = S.wx;
    // 把主图周期和"默认显示多少根"一起传下去 —— 副图要跟主图用同一套横轴契约
    // （左右留白 / boundaryGap / 刻度函数 / dataZoom），否则上下两块图的日期对不上。
    // 连横轴类别数组也直接用主图的（Chart.mainCats()）：副图自己的聚合桶数可能只有
    // 主图 K 线根数的十分之一（实测日K 副图 60 桶 vs 主图 553 根），不共用必然错位。
    // 注意字段名是 S.period（写成 S.p 会静默回落到"分时"，副图看起来毫无变化）。
    return WXUI.drawSub(S.ind, wx, wx && wx.air, S.period, viewOf(S.period), Chart.mainCats());
  }
  /** 拉当前城市的逐小时预报 + 空气质量，成功后重绘副图 */
  async function loadWx(cityId) {
    if (!window.Weather) return;
    const c = API.Cities.get(cityId); if (!c) return;
    S.wx = null;
    if (isWxInd()) renderChart();
    const hint = $('#wxHint');
    try {
      const wx = await Weather.ensure(c);
      if (!S.cur || S.cur.id !== cityId) return;   // 这期间用户已经切到别的城市
      S.wx = wx;
      if (isWxInd()) renderChart();
      if (hint) hint.textContent = (wx && wx.err) ? ('逐小时数据暂不可用：' + wx.err) : '';
    } catch (e) {
      if (isWxInd()) renderChart();
      if (hint) hint.textContent = '逐小时数据暂不可用';
    }
  }

  function renderChart() {
    const d = S.data; if (!d) return;
    // 降级、而且**一条曲线都没有**时，把**原因**直接写在图上。
    // chart.js 默认那句"暂无K线数据"只说了现象，用户会以为是 bug ——
    // 实际情况是：行情栏（报价头/盘口/流水）是气象局的实时数据，只有逐小时与 K 线这一路没拿到。
    // ⚠ 但**保底曲线**（气象局逐 3 小时插值，见 api.js 的 cmaHourlyCurve）算"有曲线"：
    //   以前这里只看 daily，于是线都插好了还能被这一句"暂时取不到"顶掉 —— 白插。
    const hasCurve = !!((d.intraday && d.intraday.length) || (d.seven && d.seven.length));
    if (d.degraded && !(d.daily && d.daily.length) && !hasCurve) {
      Chart.renderEmpty('Open-Meteo 额度用尽，K 线与逐小时暂时取不到。' +
        '左边行情栏与右侧盘口是气象局的实时数据，额度恢复后曲线会自动补上。');
      return;
    }
    const p = S.period;
    // 叠加线：只有当前副图是天气口径、并且用户按下了「叠到主图」时才给主图塞数据。
    // 副图切回温差（vol）就自动取消 —— 温差本来就是主图自己的东西，再叠一条没意义。
    const ov = (S.overlay && isWxInd() && window.WXUI)
      ? WXUI.overlayOf(S.ind, S.wx, S.wx && S.wx.air, p) : null;
    if (p === 'trend' || p === '7day') {
      const pts = p === 'trend' ? d.intraday : d.seven;
      const qp = quoteOf(S.cur.id);
      Chart.renderMain({
        mode: p, points: pts, base: d.base, ov: ov, now: API.cityNow(S.cur),
        // seven 必须显式传：chart.js 的轴标签靠它决定"到点写日期、其余写时刻"。
        // 以前从来没传过，S.seven 恒为 undefined，所以多日分时图的横轴只有 00:00 而没有日期。
        seven: p === '7day',
        precips: pts.map(x => x.v),
        hours: pts.map(x => U.sessionLabel(Number(String(x.t).slice(11, 13)))),
        title: (p === 'trend' ? (d.cmaCurveOnly ? '分时 · 未来 24 小时（气象局插值）' : '分时') : '7日分时') +
          ' · ' + (p === 'trend' ? d.today : '近 7 日')
      });
      if (!renderWxSub()) {
        if (p === 'trend' || p === '7day') renderVolSub(pts);
        else Chart.renderSub({ indName: 'vol', bars: d.daily, ind: d.indicators, metric: S.metric, view: 90, period: p });
      }
      /* 图旁边这行小字是**合规位置**：
         《气象预报发布与传播管理办法》第九条要求传播气象预报时"注明气象预报发布的**气象台名称和发布时间**"，
         第十四条第三项就是这事的罚则。保底曲线又是把官方逐 3 小时插值放大的，
         更要说清"这条线是官方发布值的平滑连线示意、不是官方逐时预报"（同条"不得自行更改内容和结论"）。 */
      const pub = (d.cmaHourly && d.cmaHourly.publishTime)
        ? ' · 气象局发布 ' + String(d.cmaHourly.publishTime).replace(/\//g, '-').slice(5, 16) : '';
      const stn = S.cur && S.cur.cma ? ' · 台站 ' + S.cur.cma : '';
      $('#chartHint').textContent = '昨收 ' + (d.base == null ? '--' : fx(d.base, 1)) + ' ℃　最新 ' +
        (qp.temp == null ? '--' : fx(qp.temp, 1)) + ' ℃　逐时点 ' + pts.length +
        (d.cmaCurveOnly
          ? '　⚠ 曲线＝中国气象局逐 3 小时发布值的平滑连线示意，非官方逐时预报' + stn + pub
          : '');
      /* 手机专用那一行（#srcLine）：桌面端 #chartHint 已经说了同一件事，
         而它在窄屏是 display:none —— 所以窄屏另起一行，**安卓上也看得见**这些字。
         两边各显示一次、不重复；没有保底曲线时这行不占高度。 */
      const sl = $('#srcLine');
      if (sl) {
        if (d.cmaCurveOnly) {
          sl.textContent = '⚠ 曲线＝中国气象局逐 3 小时发布值的平滑连线示意（非官方逐时预报）' + stn + pub;
          sl.hidden = false;
        } else {
          sl.hidden = true; sl.textContent = '';
        }
      }
    } else {
      // 切到 K 线视图就把手机那行归属说明收起来：那几张图上没有插值曲线，
      // 挂着这句话等于说"这条线是插值的"，而屏上根本没有线（甚至可能是空的）。
      const slK = $('#srcLine');
      if (slK) { slK.hidden = true; slK.textContent = ''; }
      const s = seriesFor(p);
      if (!s) {
        // K 线视图（日/周/月/预报K）**必须**有历史，而气象局只给未来 ——
        // 这几张图在降级时确实画不出来，所以如实说清"是哪一路没有"，
        // 而不是让用户对着一句"暂无K线数据"猜。分时/7日 那两张图有保底曲线，不受影响。
        Chart.renderEmpty(d.degraded
          ? 'Open-Meteo 额度用尽，K 线暂时取不到（这几张图要历史数据，气象局只给未来）。' +
            '点上面的「分时」或「7日」——那两张图用的是气象局逐 3 小时插出来的保底曲线。'
          : '暂无K线数据');
        return;
      }
      Chart.renderMain({
        mode: 'kline', bars: s.bars, ind: s.ind, base: s.base, today: s.today, ov: ov,
        metric: S.metric, view: s.view, monthMode: s.monthMode, title: s.title,
        period: p,
        showBoll: S.ind === 'boll'
      });
      if (!renderWxSub()) {
        Chart.renderSub({ indName: S.ind, bars: s.bars, ind: s.ind, metric: S.metric, view: s.view, period: p });
      }
      const i = s.bars.length - 1;
      const g = k => (s.ind[k] && s.ind[k][i] != null) ? fx(s.ind[k][i], 1) : '--';
      $('#chartHint').textContent = S.ind === 'boll'
        ? 'BOLL ' + g('lower') + ' / ' + g('mid') + ' / ' + g('upper')
        : 'MA5 ' + g('ma5') + '　MA10 ' + g('ma10') + '　MA20 ' + g('ma20') + '　MA60 ' + g('ma60');
    }
    syncOverlayBtn();
    // 预警滚动条跟着当前城市走。这里调是安全的：tickerRefresh 内部按
    // "城市 + 条数 + 标题"算了个签名，没变就直接返回，不会把滚动动画打回开头。
    if (window.WXUI && WXUI.tickerRefresh) WXUI.tickerRefresh();
  }

  /** 「叠到主图」按钮的状态：副图切回温差（vol）时没有任何可叠的天气量，按钮置灰 */
  function syncOverlayBtn() {
    const b = $('#btnOverlay'); if (!b) return;
    const ok = isWxInd();
    b.disabled = !ok;
    b.classList.toggle('disabled', !ok);
    b.classList.toggle('active', !!(ok && S.overlay));
    b.title = ok
      ? '把「' + (IND_CN[S.ind] || S.ind) + '」这条线同时画到上面的气温图上，用右边最外侧那根刻度'
      : '先把副图切到降水 / 风 / 云量 / 空气，才能叠到主图';
  }

  /** 竖屏统计格的「展开/收起」按钮的字面。
   *  默认值按屏幕定：窄屏折起来（主图才有地方），宽屏全放出来。
   *  用户手动点过就按他点的来（存 'qmore'）。 */
  function syncQMore() {
    const qh = $('#quoteHead'), t = $('#qMoreTxt'), i = $('#qMoreIco');
    if (!qh || !t) return;
    const off = qh.classList.contains('more-off');
    t.textContent = off ? '全部数据' : '收起';
    if (i) i.textContent = off ? '▾' : '▴';
  }

  /* ═══════════ 状态栏 ═══════════ */
  function renderStatus(msg) {
    if (msg) $('#statusLeft').textContent = msg;
    const srcs = [];
    if (S.data && S.data.now && S.data.now.src === 'cma') srcs.push('中国气象局 weather.cma.cn');
    if (S.data) srcs.push('Open-Meteo 逐小时');
    if (S.data && S.data.official) srcs.push('中国天气网 d1');
    if (API.LOCAL) srcs.push('本地代理');
    $('#statusSrc').textContent = srcs.join(' + ') || '—';
  }

  /** 时间戳 → "刚刚 / 12 分钟前 / 3 小时前 / 2 天前"。给"当前显示的是什么时候的数据"用。 */
  function agoTxt(t) {
    const s = Math.max(0, Math.round((Date.now() - (t || 0)) / 1000));
    if (s < 90) return '刚刚';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }

  /* ═══════════ 选中城市 ═══════════ */
  async function selectCity(id) {
    const c = API.Cities.get(id);
    if (!c) { toast('未找到城市 ' + id); return; }
    /* ── 抢占 ──────────────────────────────────────────────────────────
       使用者报的：「快速切换收藏城市时，会显示正在加载上一座城市，加载完毕后自动切到
       xxx。能不能改成我点哪座城市的时候，就先切断之前城市的加载，优先加载我现在点击
       的这座城市？等到我切到这座城市之后再继续完成被中断的加载」。
       所以不再排队等（原来 `if (S.loading) { S.pendingCity = id; ... toast(...); return; }`），
       而是**领一个新号**：上一座城那次加载在它自己的 `await` 之后会发现
       `seq !== S.loadSeq`，于是只是安静收尾 —— 数据照样进 Store 的城市缓存（下次点它
       立刻就能出图），但**一个像素的界面都不许写**；它同时被记进 orphans，
       等当前这座显示完再补完。 */
    const seq = ++S.loadSeq;
    const prev = S.loadingId;
    if (prev && prev !== id) S.orphans.push(prev);
    S.loadingId = id;
    S.loading = true;
    S.cur = c;
    S.data = null;
    /* 已经开着的那几个天气抽屉是按"上一座城市"算的（天文整页都是按经纬度推的），
       换了城市必须重画 —— 不重画的话画面上还是上一座城市的星图/震中距，
       而使用者完全看不出来。目前只处理天文，见 wxui.js 的 onCityChanged。 */
    if (window.WXUI && WXUI.onCityChanged) WXUI.onCityChanged();
    S.wx = null;
    storeSet('last', id);
    renderWatchlist(); renderIndexes();
    $('#qName').textContent = c.name;
    // 城市名旁边那颗星要立刻对上（数据还没到也得对）—— 这正是本来的诉求：
    // 点开一座城之后就能直接加自选，不用回搜索框重搜一遍。
    renderQStar();
    Chart.showLoading('正在拉取 ' + c.name + ' 行情…');
    $('#statusLeft').textContent = '加载 ' + c.name + ' …';

    /* ── 先把上次打开这座城市时的那份**原样显示出来** ──
     * 手机天气软件就是这个体感：进去先看到上次的情报，停一会儿自己更新成最新的。
     * 冷启动要并发拉六份数据（历史 560 天、近 92 天 + 未来 16 天、实况、预报、
     * 官方快照、官方月度日历），手机上一次就是好几秒；而这里面**绝大部分根本不会变** ——
     * 昨天的日K、上个月的历史、上周的逐小时，跟刚才打开时一模一样。
     * 这一步**不 await**：先把画面填上，网络照常在后面跑。 */
    const snap = API.Store.peekCity ? API.Store.peekCity(c) : null;
    if (snap && snap.out) {
      // ⚠ 这一段必须在 try 里：它在 `S.loading = true` 之后、下面那个 try 之前运行，
      // 一旦某份坏快照让渲染抛错，异常会直接冒出去，`S.loading` 永远回不到 false ——
      // 整个应用就此卡死（切城市全被 `if (S.loading) return` 挡掉）。坏缓存绝不能有这个权力。
      try {
        snap.out.city = c;                   // 用刚查出来的城市对象，别拿快照里那份旧的
        S.data = snap.out;
        S.lastFullAt = snap.at || 0;         // 如实记成"手上这份是那个时刻的"
        Chart.hideLoading();
        renderQuoteHead(); renderOrderbook(); renderTape(); renderChart();
        renderStatus();
        $('#statusLeft').textContent = '正在更新 ' + c.name + ' …（当前显示 ' + agoTxt(snap.at) + '的数据）';
      } catch (err) {
        S.data = null;                       // 丢掉坏快照，清干净，继续走正常加载
        if (API.Store.dropCity) API.Store.dropCity(c);
        Chart.showLoading('正在拉取 ' + c.name + ' 行情…');
      }
    }

    try {
      const loadP = API.Store.loadCity(c, (m) => {
        // ⚠ 一旦被抢占（使用者又点了一座城），这次加载就没资格动界面了 —— 进度回调也要先问一句。
        if (seq !== S.loadSeq) return;
        // 已经显示旧数据时，状态栏要**一直**说清楚"你看的是什么时候的数据"。
        // 直接写 m 的话，那句提示只活一个 tick —— loadCity 第一步就把它覆盖成"正在拉取…"了，
        // 用户根本来不及看见自己看的是旧数据。
        $('#statusLeft').textContent = snap
          ? '正在更新 ' + c.name + ' …（当前显示 ' + agoTxt(snap.at) + '的数据）'
          : m;
        // 已经在显示旧数据了，就别再拿加载遮罩把它盖住 —— 那正是要避免的"进去先看一片空"
        if (!snap) Chart.showLoading(m);
      });
      inflight[id] = loadP;
      let d;
      try {
        d = await loadP;
      } finally {
        if (inflight[id] === loadP) delete inflight[id];
      }
      /* 这一份是不是**我这次**要的？被抢占的那次到这儿就结束 ——
         数据已经进了 Store 的城市缓存（下次点它立刻就能显示），但界面归当前那次管。 */
      if (seq !== S.loadSeq) return;

      /* 降级合并：新拿回来的这份**只有气象局那几路是好的**，逐小时/K 线是空的（Open-Meteo 429）。
       * 屏上如果还留着上次那份好曲线，就把**实时的行情栏字段**贴上去、曲线继续用旧的 ——
       * 这正是使用者要的："至少行情栏那些数据得有吧，其他那些曲线没有最新的记录
       * 就拿历史记录糊弄一下差不多得了"。绝不能用空曲线把好曲线顶掉。 */
      const oldOut = (snap && snap.out && snap.out.daily && snap.out.daily.length) ? snap.out : null;
      if (d.degraded && oldOut) {
        d = Object.assign({}, oldOut, {
          city: c,
          now: d.now, fcst: d.fcst, official: d.official, cnFcst: d.cnFcst, calDaily: d.calDaily,
          today: d.today,                  // renderTape 按它筛"最近观测"
          // 这份新的气象局逐 3 小时**始终带上**：曲线走的是快照那条路，
          // 但逐时流水在快照里没观测时还要靠它顶上（见 renderTape）。
          cmaHourly: d.cmaHourly || oldOut.cmaHourly || null,
          degraded: true,
          staleCharts: true,               // 曲线是历史，界面照这个说
          // 曲线本身来自快照（不是保底插值），所以这两项必须显式清掉 ——
          // 否则会从旧 out 里继承过来，状态栏就会说"曲线是气象局插值的"，而屏上画的是历史K线。
          cmaCurveOnly: false,
          cmaCurve: null
        });
      }
      S.data = d;
      S.lastFullAt = Date.now();
      /* 实况的节拍从"这一份是真从网上下来的"那一刻起算。
         上面快照那条路（S.data = snap.out）故意**不**碰 obsAt：快照是旧的，
         obsAt 留在 0 才能让下一个心跳立刻去取一份真的。 */
      S.obsAt = Date.now();
      if (!S.briefs[id] || !S.briefs[id].prevClose) {
        const b = await briefOf(c, 600000);
        if (b) S.briefs[id] = b;
      }
      if (seq !== S.loadSeq) return;      // 这一步也可能等很久，同样要重新确认一次
      Chart.hideLoading();
      renderQuoteHead(); renderOrderbook(); renderTape(); renderChart();
      renderStatus();
      renderWatchlist(); renderIndexes();
      loadWx(c.id);   // 逐小时/空气是副图才要，异步补上，不挡主流程
      if (d.degraded) {
        // **降级但可用**：报价头 / 五档盘口 / 逐时流水来自中国气象局，是实时的。
        // 必须说清哪部分是新的、哪部分是旧的 —— 不能让用户以为整页都是实时的。
        // 第三种情况：连保底曲线都用上了（气象局逐 3 小时插值）—— 那是**预报**、且只有未来，
        // 今天已经过去的小时没有，所以文案要跟"历史记录"分开说。
        $('#statusLeft').textContent = '已加载 ' + c.name + ' —— 行情来自中国气象局（实时）；' +
          (d.cmaCurveOnly
            ? 'Open-Meteo 额度用尽，气温曲线改用气象局逐 3 小时预报插值（' +
              (d.cmaCurve ? d.cmaCurve.anchors + ' 个锚点 → ' + d.cmaCurve.hours + ' 小时' : '') + '）'
            : d.staleCharts
              ? 'Open-Meteo 额度用尽，曲线显示的是' + agoTxt(snap && snap.at) + '的历史记录'
              : 'Open-Meteo 额度用尽，逐小时与 K 线暂时没有数据') +
          '，恢复后会自动补上';
        toast(d.cmaCurveOnly ? '曲线用的是气象局逐 3 小时预报（插值，Open-Meteo 额度用尽）'
          : d.staleCharts ? '曲线用的是历史记录（Open-Meteo 额度用尽）'
            : 'Open-Meteo 额度用尽，曲线暂时为空');
      } else {
        $('#statusLeft').textContent = '已加载 ' + c.name + '（' + d.daily.length + ' 根日K / ' + d.hourly.time.length + ' 个时次）';
        toast('已切换到 ' + c.name + ' ' + c.id);
      }
    } catch (e) {
      if (seq !== S.loadSeq) return;      // 被抢占的那次连一句报错都不许画
      Chart.hideLoading();
      // 有上次的快照就**留着它** —— 与其把已经画好的行情换成一句报错，不如让用户继续看
      // 上次那份（状态栏说清是什么时候的数据）。2026-10-07 网页端就是栽在这里：
      // Open-Meteo 额度用尽 → 抛错 → 明明屏上有数据，却被一句 "加载失败" 顶掉了。
      if (S.data && S.data.daily && S.data.daily.length) {
        renderStatus();
        $('#statusLeft').textContent = '更新失败：' + e.message +
          '（仍显示 ' + agoTxt(snap && snap.at) + '的数据）';
        toast('更新失败，仍显示上次的数据');
      } else {
        Chart.renderEmpty('加载失败：' + e.message);
        $('#statusLeft').textContent = '加载失败：' + e.message;
      }
    } finally {
      // 只有**当前这一次**有资格收尾。被抢占的那次直接走人 ——
      // 它要是把 S.loading 清成 false，正在加载的这座城就会被心跳/预热当成"闲着了"。
      if (seq !== S.loadSeq) return;
      S.loading = false;
      S.loadingId = null;
      drainOrphans();
    }
  }

  /** 把被抢占的城市在**后台**把数据取完 —— 只暖缓存，不抢视图、不碰状态栏。
      使用者原话：「等到我切到这座城市之后再继续完成被中断的加载」。
      ⚠ 已经在飞的那次（inflight）绝不能再发一遍：一次 loadCity 是**七路请求**，
        额度按 IP 计，同一座城同时发两轮基本就是自己把自己打到 429。
        所以只有"没人拉了、又没有快照"才补，并且错开 400ms 一座，别一口气全放出去。 */
  function drainOrphans() {
    if (!S.orphans.length) return;
    const ids = S.orphans.slice();
    S.orphans.length = 0;
    ids.forEach((oid, i) => {
      if (!oid || oid === (S.cur && S.cur.id)) return;
      const c2 = API.Cities.get(oid);
      if (!c2 || !API.Store.loadCity) return;
      if (API.Store.peekCity && API.Store.peekCity(c2)) return;   // 已经有快照，显示不缺东西
      setTimeout(() => {
        // 这 400ms 里可能又切过去了、或者已经在拉了 —— 那就交给正常路径去拉
        if (S.loading || (S.cur && S.cur.id === oid) || inflight[oid]) return;
        if (API.Store.peekCity && API.Store.peekCity(c2)) return;
        try { API.Store.loadCity(c2, function () { }).catch(function () { }); } catch (e) { }
      }, 400 * (i + 1));
    });
  }

  /* ═══════════ 行情轮询 ═══════════ */
  /** 带并发上限的小工具：把一批任务分片跑完 */
  async function runLimited(items, limit, fn) {
    const arr = items.slice();
    const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
      while (arr.length) { const it = arr.shift(); try { await fn(it); } catch (e) { } }
    });
    await Promise.all(workers);
  }

  function watchHotIds() {
    // 以前这里还要并上「热门前 16 城」。热门城市那块删掉之后，
    // 就不再为没人看的城市去预热行情了 —— 省下的正是每次刷新的那十几个请求。
    const ids = S.watch.slice();
    if (S.cur) ids.push(S.cur.id);        // ★ 正在看的这个城市必须有报价
    if (S.geo) ids.push(LOC_ID);          // 当前所在地也要有报价
    return Array.from(new Set(ids));
  }

  /* Open-Meteo 免费额度：10000 次/天、5000 次/小时、600 次/分钟
     （https://open-meteo.com/en/terms，非商业用途）。
     逐时 / 归档 / 空气 / 当前值都是"按城市+坐标缓存 15~30 分钟"，一个城市一天几十次，
     量级跟城市数无关；**只有 brief（昨收 + 迷你走势）是按城市数放大的** ——
     它是"每个城市一次调用"。所以它的节流周期和城市数上限单独拎出来，
     让最坏情况的调用量一眼可见：48 轮/天 × 40 城 = 1920 次/天，约日额度的两成。
     TTL 必须跟节流周期同值：TTL 比节流短的话缓存先过期，等于白节流。 */
  const BRIEF_MS = 1800000;   // 30 分钟一轮
  const BRIEF_MAX = 40;       // 一轮最多补多少个城市（收藏 + 当前所在地）

  /**
   * 取一个城市的「昨收 + 迷你走势」，带兜底：
   *   ① Open-Meteo brief（首选：逐小时的"收盘价"，还有开高低/天气码/降水量）
   *   ② 气象局日历的昨日实测日均温（API.Cn.brief，见那边的注释）
   * 两个源的 prevClose 定义不同（逐小时收盘 vs 逐日日均），所以
   *   同一城市在①和②下算出来的涨跌幅会有出入 —— 但总好过整列 "--"。
   * 只有①真的拿不到东西时才走②，正常情况下一次多余的请求都不会发。
   */
  async function briefOf(city, ttl) {
    const t = ttl || BRIEF_MS;
    let b = null;
    try { b = await API.OpenMeteo.brief(city.lat, city.lon, t); } catch (e) { }
    if (b && b.prevClose != null) return b;
    try {
      const c = await API.Cn.brief(city);
      if (c && c.prevClose != null) return c;
    } catch (e) { }
    return b;
  }

  /* ── 实况（`d.now`）的写回 + 它自己的节拍 ───────────────────────────────
     详情页的实况标签（「中国气象局实况 23:45」）和统计格里的 体感·湿度·气压·风向风速
     读的都是 `S.data.now`，而它**只在 loadCity 那一刻取过一次**。列表轮询其实每轮都把
     同一份更新的实况取回来了，却没人写回去 —— 于是「行情在动、实况时间戳原地不动」：
     手机刚打开是 23:30，电脑开了两小时还写着 22:00（使用者正是拿这两个数对出来的）。
     光在 `warmQuotes()` 里补写回还不够：那只在「行情刷新频率」到点时才跑，而频率能调成
     **手动刷新**（value 0，老 `scheduleRefresh` 一个定时器都不挂）—— 实况就再也跟不上。
     所以实况另有 `warmObs()` 与固定心跳，见 `scheduleRefresh()`。 */
  /** 只认**更新**的那一份，免得把刚 loadCity 到的新数据覆盖成旧的。
      （time 有两种格式：气象局 "2026/10/07 23:45"、Open-Meteo "2026-10-07T23:45"，
       所以两种分隔符都得认。） */
  const obsStamp = t => {
    const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})/.exec(String(t || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
  };
  function applyObs(fresh) {
    if (!S.cur || !S.data || !fresh || fresh.temp == null) return false;
    const tNew = obsStamp(fresh.time), tOld = obsStamp(S.data.now && S.data.now.time);
    if (isFinite(tNew) ? (tNew > tOld || !isFinite(tOld)) : !isFinite(tOld)) {
      S.data.now = fresh;
      return true;
    }
    return false;
  }

  /** 只刷「当前城市」的实况：一个请求，跟行情刷新频率完全无关。
   *  `force=true`（点 ⟳ 刷新时）绕过 `Cma.now` 那 180 秒缓存 —— 实测过：
   *  加载完 15 秒后点刷新，**一条 `/api/cma/now` 请求都不会发**，屏幕上还是旧的那份。
   *  TTL 用 10 秒而不是 0（`server/app.py` 把 0 当 falsy 吃成 120 秒）。 */
  async function warmObs(force) {
    try {
      const city = S.cur && API.Cities.get(S.cur.id);
      if (!city) return;
      const fresh = await API.Store.quote(city, !!force);
      S.obsAt = Date.now();          // 失败也算「试过了」：3 分钟后再来，别每秒捶它
      if (applyObs(fresh)) { renderQuoteHead(); renderOrderbook(); renderTape(); }
    } catch (e) { S.obsAt = Date.now(); }
  }

  async function warmQuotes() {
    const ids = watchHotIds();
    const ttl = Math.max(S.refreshMs, 30000);
    const cities = ids.map(i => API.Cities.get(i)).filter(Boolean);
    const qs = await API.Store.quotes(cities, 6);
    Object.assign(S.quotes, qs);

    /* ★ 把轮询拿到的实况写回详情页那一份（判据见 applyObs）。 */
    if (S.cur && qs[S.cur.id]) { applyObs(qs[S.cur.id]); S.obsAt = Date.now(); }

    // 昨收 / 迷你走势（Open-Meteo brief）：只有收藏 + 当前所在地。
    //
    // ★ briefAt 是"下次允许拉的时刻"，不是"上次拉的时刻"：成功推 30 分钟，失败只推 2 分钟。
    //   老写法不管成败都写 `S.briefAt = Date.now()`，于是一次失败（典型是 Open-Meteo
    //   当天额度用光）就把整列涨跌幅锁死半小时 —— 全列表一片 "--"，期间一次重试都没有，
    //   额度恢复了也不会自己好。
    const need = ids.filter(i => API.Cities.get(i)).slice(0, BRIEF_MAX);
    const due = Date.now() >= (S.briefAt || 0);
    // ★ 节流没到点的时候，也得允许补「一次都没成功过」的那些。
    //   刚加自选 / 刚定位过来的城市本来就没有昨收，如果只能等满一个 30 分钟周期，
    //   这一格会出现「有价格、涨跌幅空着」的怪样子 —— 用户看到的就是那个灰 `--`。
    //   失败过的给 1 分钟退避，免得一个永远取不到坐标的城市每轮都重试。
    //   （轮询间隔本身最快也有 30 秒、默认 15 分钟，所以这个退避不会挡住真正的下一轮。）
    const FRESH_BACKOFF = 60000;    // 1 分钟
    S.briefTry = S.briefTry || {};
    const fresh = need.filter(i => !S.briefs[i] &&
      Date.now() - (S.briefTry[i] || 0) > FRESH_BACKOFF);
    const todo = due ? need : fresh;
    if (todo.length) {
      let got = 0;
      await runLimited(todo, 4, async i => {
        const c = API.Cities.get(i);
        S.briefTry[i] = Date.now();       // 先记，失败也算试过了
        try { const b = await briefOf(c, BRIEF_MS); if (b) { S.briefs[i] = b; got++; } } catch (e) { }
      });
      if (due) S.briefAt = Date.now() + (got ? BRIEF_MS : 120000);
    }
    // ★ renderGeo() 必须在这里重画一次。
    //   「当前所在地」那一行的价格来自 quoteOf(LOC_ID)，而这一行原来的**唯一**重画入口
    //   都在定位那套流程里（initGeo / applyGeo / locate 的回调）。页面刚打开时它先渲染成
    //   `--`，行情是**轮询**补上来的，而这条路原来只重画自选 / 热门 / 指数条 ——
    //   于是定位那一格永远停在打开那一刻：价格和涨跌幅都是灰的 `--`，
    //   旁边自选城市却已经有数字了（用户看到的正是这个）。
    renderGeo();
    renderWatchlist(); renderIndexes();
    if (S.cur) { renderQuoteHead(); renderOrderbook(); renderTape(); }
  }

  /** 指数条现在就是自选列表的镜像，行情/走势由 warmQuotes() 一并预热，这里只要重画 */
  async function warmIndexes() {
    renderIndexes();
  }

  /* ── 静默预热「收藏城市」的整份数据 ───────────────────────────────
     使用者的原话：「收藏城市列表可以在不查看的时候静默获取数据吗？每次切换收藏城市的时候
     都会稍微卡一下等它读取数据，而收藏了城市说明查看会相对没收藏的城市更加频繁。
     现在的体验感有点割裂。」

     说得对，而且原因很具体：`loadCity` 只在「打开页面 / 切城市 / 30 分钟全量重载」时跑，
     所以**除当前这一座以外，其它收藏城市永远没有快照**（再加上 CX_KEEP 原来只留 2 份，
     就算看过也会被挤掉）—— 点过去只能挂起加载遮罩，等六路请求。
     这里趁当前城市画完之后，一座一座把它们补进缓存。**只喂缓存，一个 DOM 都不碰。**

     ⚠ 三条自我约束（这类"后台顺手做点事"的功能最容易做过头）：
       ① **串行**，一次一座，并且每次都让开前台：`S.loading` 为真就等，绝不跟切城市抢带宽 ——
          预热的意义是"切过去不卡"，要是它把切城市本身拖慢了就本末倒置了。
       ② **只在真的过期时才跑**：快照 20 分钟内的直接跳过。
       ③ **省流模式 / 2G 不跑**（`navigator.connection`）：这是锦上添花，
          不该为它花用户的钱。 */
  /* 一轮最多预热几座：**跟缓存能留下几座对齐**（`API.Store.snapshotKeep`）。
     不对齐会怎样：预热 12 座、缓存只留 10 座的话，最先预热的那两座下一轮必定已被挤掉，
     于是每一轮都在重拉同样的两座 —— 白烧额度，一点体验都没换到。
     为什么这个数是 12 而不是"收藏多少就预热多少"：一份快照约 293 KB、
     localStorage 配额实测 5086 KB ⇒ **硬上限 17 座**，12 是留了余量的那个数。
     详见 api.js 里 CX_BUDGET 的注释。 */
  const WARM_MAX = API.Store.snapshotKeep;
  const WARM_AGE = 20 * 60000;      // 快照比这新就不碰它
  /* 每座之间歇一下。800 → 1200 ms 是跟着 WARM_MAX 一起抬的：
     `loadCity` 一座要发六路请求，800 ms 一座 × 12 座 ≈ 7.5 请求/秒 = 450 次/分钟，
     已经贴到 Open-Meteo 的 600 次/分钟上限（还得跟行情轮询分着用）；
     1200 ms 降到 300 次/分钟。12 座一轮 ≈ 15 秒 —— 反正是后台的事。 */
  const WARM_GAP = 1200;
  let warmBusy = false;

  function netCheap() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return true;                       // 浏览器不报，就当它便宜
    if (c.saveData) return false;
    return !/^(slow-2g|2g)$/.test(c.effectiveType || '');
  }

  async function warmCities() {
    if (warmBusy || !netCheap()) return;
    const curId = S.cur && S.cur.id;
    const ids = S.watch.filter(i => i !== curId && i !== LOC_ID && API.Cities.get(i))
      .slice(0, WARM_MAX);
    if (!ids.length) return;
    // 整轮节流：心跳每几十秒就会走一次 warmQuotes，别让它每轮都把这一串重扫一遍
    if (S.warmAt && Date.now() - S.warmAt < 10 * 60000) return;
    warmBusy = true;
    let done = 0;
    try {
      for (let k = 0; k < ids.length; k++) {
        const c = API.Cities.get(ids[k]);
        const snap = API.Store.peekCity(c);
        if (snap && snap.out && Date.now() - (snap.at || 0) < WARM_AGE) continue;
        // 让开前台：正在切城市/加载就等它，最多等 30 秒，等不到就整轮放弃
        const t0 = Date.now();
        while (S.loading && Date.now() - t0 < 30000) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (S.loading || !netCheap()) break;
        try { await API.Store.loadCity(c, function () { }); done++; }
        catch (e) { /* 单座失败不连累其它 —— 多半是 Open-Meteo 额度或网络抖动 */ }
        await new Promise(r => setTimeout(r, WARM_GAP));
      }
    } finally {
      warmBusy = false;
      S.warmAt = Date.now();
      if (done && S.cur) renderQuoteHead();   // 当前这座不受影响，重画只是让状态栏别停在旧文案
    }
  }

  /* ── 刷新调度：**心跳** + 墙上时钟比对 ──────────────────────────────────
     老写法 `setInterval(…, S.refreshMs)` 一把梭，有三个洞：
       ① 频率调成「手动刷新」时**一个定时器都不挂**，实况永远停在最后一次 loadCity；
       ② 定时器只数"又过了一个周期" —— 标签页被浏览器冻住/节流后恢复，还得再等满一整个
          周期（默认 15 分钟）才动一下；
       ③ 实况本该跟气象局走（它 5~10 分钟就更新一次），却被绑在行情刷新频率上。
     现在：心跳 **min(60 秒, S.refreshMs)**，每次醒来**比墙上时钟**，该补的立刻补。
     取 min 是因为 60 秒只是"后台节流也漏不掉"的上界，不是速率本身：1/3/5/10/30 秒那几档
     比 60 秒小，必须按档位走（写死 60 秒会把它们降级成 1 分钟）。
     （3m20s 是故意的：`Cma.now` 的缓存 TTL 是 180s，60 秒网格上最近的那一次必然越过它，
       不会白拿一份缓存里的旧实况。）
     注意这条节拍只是「后台自己补」的下限：**使用者动手**的那两个入口（点 ⟳ 刷新、
     打开/切城市）走的是 `CMA_FRESH_MS`＝10 秒的强制取数，不必等这个节拍。

     ⚠ 心跳周期取 `min(60 秒, S.refreshMs)`，**不能写死 60 秒**。
     界面上的刷新档位有 1 / 3 / 5 / 10 / 30 秒这几档，全都比 60 秒小：写死等于
     把它们**悄悄降级成 1 分钟**（老版本是 `setInterval(warmQuotes, S.refreshMs)`，
     那几档是真按秒走的 —— 换心跳时这条被漏掉了，属于回归）。
     `beat()` 判断到期用的是 `Date.now() >= S.refreshDue`，周期变小只会更准时、
     不会重复刷；`S.beating` 那道闸挡住"上一轮还没跑完又进来一轮"的堆积。 */
  const HEARTBEAT_MS = 60000;
  const OBS_MS = 200000;

  async function beat() {
    if (S.loading || S.beating) return;
    S.beating = true;
    try {
      // ① 实况：自己的节拍，永远跑（「手动刷新」模式下也跑）
      if (!S.obsAt || Date.now() - S.obsAt >= OBS_MS) await warmObs();
      // ② 列表报价 / 走势 / 30 分钟全量重载：到点才动；「手动刷新」时永不到点
      if (S.refreshMs && Date.now() >= (S.refreshDue || 0)) {
        S.refreshDue = Date.now() + S.refreshMs;
        S.polls++; S.tick++;
        await warmQuotes();
        if (S.polls % 20 === 1) warmIndexes();
        if (S.cur && Date.now() - S.lastFullAt > 1800000 && !S.loading) {
          const id = S.cur.id; S.loading = false; selectCity(id);
        }
      }
      $('#statusNext').textContent = S.refreshMs
        ? ('下次刷新 ' + fmtGap(Math.max(0, S.refreshDue - Date.now())))
        : '手动刷新 · 实况自动';
    } catch (e) { /* 静默 */ } finally { S.beating = false; }
  }

  function scheduleRefresh() {
    clearInterval(S.timer);
    S.refreshDue = S.refreshMs ? Date.now() + S.refreshMs : 0;
    $('#statusNext').textContent = S.refreshMs
      ? ('下次刷新 ' + fmtGap(S.refreshMs)) : '手动刷新 · 实况自动';
    S.timer = setInterval(beat, Math.min(HEARTBEAT_MS, S.refreshMs || HEARTBEAT_MS));
    beat();
  }

  /* 切回前台 / 回到这个标签页时若已过期就立刻补一次。
     浏览器会把后台标签的定时器冻住或压到 1 分钟一次，而使用者此刻正盯着屏幕 ——
     不能让他再等一个心跳。（「电脑上开着两小时还写着 22:00」就是这个现场。） */
  function catchUp() {
    if (document.hidden) return;
    if (!S.obsAt || Date.now() - S.obsAt >= OBS_MS) warmObs();
    if (S.refreshMs && Date.now() >= (S.refreshDue || 0)) beat();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) catchUp(); });
  window.addEventListener('focus', catchUp);

  /** 刷新间隔的人话。默认已经是 15 分钟，不该显示成 "900s"。 */
  function fmtGap(ms) {
    if (!ms) return '手动';
    const s = ms / 1000;
    if (s < 60) return s + 's';
    return (s % 60 === 0 ? s / 60 : Math.round(s / 60)) + 'm';
  }

  /* ═══════════ 搜索 ═══════════ */
  let srList = [], srSel = -1;
  const doSearch = debounce(function () {
    const q = $('#search').value.trim();
    const box = $('#searchResults');
    if (!q) { box.hidden = true; box.innerHTML = ''; srList = []; return; }
    srList = API.Cities.search(q, 40);
    srSel = srList.length ? 0 : -1;
    box.innerHTML = '';
    if (!srList.length) { box.appendChild(el('div', { class: 'sr-empty', text: '未找到匹配城市' })); box.hidden = false; return; }
    srList.forEach((c, i) => {
      const starred = S.watch.indexOf(c.id) >= 0;
      const row = el('div', {
        class: 'sr-item' + (i === srSel ? ' sel' : ''),
        onclick: (e) => {
          if (e.target.classList.contains('sr-star')) return;
          $('#search').value = ''; box.hidden = true; selectCity(c.id);
        }
      }, [
        el('span', { class: 'sr-name', text: c.name }),
        el('span', {
          class: 'sr-prov',
          text: c.place ? (c.prov || '') + (c.city ? ' · ' + c.city : '')
            : c.world ? (c.prov || '') + ' · ' + c.en
            : (c.prov || '') + (c.cma ? ' · ' + c.cma : '')
        }),
        el('span', {
          class: 'sr-code',
          text: c.place ? (c.lev === 3 ? '区县' : c.lev === 2 ? '市' : '省') : c.world ? '海外' : c.id
        })
      ]);
      row.appendChild(el('span', {
        class: 'sr-star' + (starred ? ' on' : ''),
        text: starred ? '★' : '☆',
        title: starred ? '取消收藏' : '收藏（也可按 Ctrl+Enter）',
        onclick: (e) => {
          e.stopPropagation();
          if (S.watch.indexOf(c.id) >= 0) removeWatch(c.id); else addWatch(c.id);
          doSearch(); buildDrawer();
        }
      }));
      box.appendChild(row);
    });
    box.hidden = false;
  }, 130);

  function searchKey(e) {
    const box = $('#searchResults');
    if (e.key === 'Escape') { box.hidden = true; $('#search').blur(); return; }
    if (!srList.length || box.hidden) {
      if (e.key === 'Enter') { const c = API.Cities.search($('#search').value.trim(), 1)[0]; if (c) { $('#search').value = ''; box.hidden = true; selectCity(c.id); } }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      srSel = (srSel + (e.key === 'ArrowDown' ? 1 : -1) + srList.length) % srList.length;
      Array.from(box.children).forEach((n, i) => n.classList.toggle('sel', i === srSel));
      const n = box.children[srSel]; if (n) n.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = srList[srSel];
      if (c) {
        if (e.ctrlKey || e.metaKey) addWatch(c.id);
        else selectCity(c.id);
        $('#search').value = ''; box.hidden = true;
      }
    }
  }

  /* ═══════════ 全城市抽屉 ═══════════ */
  function buildDrawer() {
    const body = $('#drawerBody');
    const groups = {};
    API.Cities.all.forEach(c => { (groups[c.prov || '其他'] = groups[c.prov || '其他'] || []).push(c); });
    body.innerHTML = '';
    Object.keys(groups).forEach(p => {
      body.appendChild(el('div', { class: 'dw-prov', text: p + '（' + groups[p].length + '）' }));
      const g = el('div', { class: 'dw-grid' });
      groups[p].forEach(c => {
        const star = S.watch.indexOf(c.id) >= 0;
        g.appendChild(el('div', {
          class: 'dw-city' + (star ? ' on' : ''),
          dataset: { id: c.id },
          // 把两个编号都写清楚是什么，别让人猜：
          //   `c.id`  = 中国天气网城市代码（9 位，**唯一**，搜索框也认它）
          //   `c.cma` = 中国气象局站号（5 位，只有 156 座城市有）
          title: '中国天气网城市代码 ' + c.id + (c.cma ? ' · 气象局站号 ' + c.cma : ' · 无独立气象站'),
          onclick: (e) => {
            // ★/☆ 只负责自选增删；点别处才是切换城市。
            // 注意：星号必须【永远】渲染出来 —— 以前只在已自选时才画，
            // 于是没自选的城市根本没有星可点，也就永远加不进自选。
            if (e.target.classList.contains('star')) {
              e.stopPropagation();
              if (S.watch.indexOf(c.id) >= 0) removeWatch(c.id); else addWatch(c.id);
              buildDrawer();
              return;
            }
            selectCity(c.id); $('#cityDrawer').hidden = true;
          }
        }, [
          el('span', { text: c.name }),
          el('span', {
            class: 'star' + (star ? ' on' : ''),
            text: star ? '★' : '☆',
            title: star ? '取消收藏' : '收藏'
          }),
          /* ⚠ 这里原来写的是 `c.id.slice(-3)` —— 截后三位。
             那**不是代码**，只是个"看起来像代码"的装饰：
             352 座城市里后三位只有 16 种取值，平均一个值被 22 座城市共用
             （`101` 被 52 座共用），而且它其实是**省内序号**
             （石家庄 101090**101**、保定 101090**201**、张家口 101090**301**）。
             既不能拿去查，也不唯一。现在显示**完整的 9 位中国天气网城市代码** ——
             唯一、可查，搜索框也认它（实测输入 101280701 能搜到珠海）。
             这也更配"炒股软件"那个调子：股票列表本来就是一串真代码。 */
          el('i', { text: c.id })
        ]));
      });
      body.appendChild(g);
    });
  }

  /* ═══════════ 交互绑定 ═══════════ */
  function bind() {
    // 行情头城市名旁边那颗星：点一下就把**正在看的这座城**加/取自选。
    // 这是「点开某城后没法加星」的直接解法 —— 以前只能在搜索行、城市抽屉、
    // 定位行三处加，点进来之后就只剩"回搜索框再搜一遍"这一条路。
    const qs = $('#qStar');
    if (qs) qs.addEventListener('click', () => {
      const c = S.cur;
      if (!c) return;
      // 先改数据再刷星，别依赖 addWatch 里的 renderQStar（那条路也可能被别处调用）
      if (S.watch.indexOf(c.id) >= 0) removeWatch(c.id); else addWatch(c.id);
      renderQStar();
    });
    $('#periodTabs').addEventListener('click', e => {
      const t = e.target.closest('.tab[data-period]'); if (!t) return;
      U.$$('#periodTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      S.period = t.dataset.period;
      renderChart();
    });
    // 注意 [data-ind]：这一行里还有一个 #btnOverlay（叠加开关），它没有 data-ind，
    // 不加限定就会把 S.ind 设成 undefined 并把所有页签的 active 清掉。
    U.$$('.tabbar.sub .tab[data-ind]').forEach(t => t.addEventListener('click', () => {
      U.$$('.tabbar.sub .tab[data-ind]').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      S.ind = t.dataset.ind;
      // 副图现在跟着主图周期走（分时/7日/日K/周K/月K/预报K 各有对应粒度），
      // 所以不用再把用户从"分时/7日"里踢出去。
      U.$$('#periodTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.period === S.period));
      renderChart();
      if (isWxInd() && !S.wx && S.cur) loadWx(S.cur.id);
    }));
    // 叠加开关：不参与页签互斥，只切 S.overlay 再重画主图
    if ($('#btnOverlay')) $('#btnOverlay').addEventListener('click', () => {
      if (!isWxInd()) { toast('先把副图切到 降水 / 风 / 云量 / 空气，才能叠到主图'); return; }
      S.overlay = !S.overlay;
      storeSet('overlay', S.overlay ? 1 : 0);
      renderChart();
      toast(S.overlay ? '已把「' + IND_CN[S.ind] + '」叠到主图' : '已取消主图叠加');
    });
    $('#refreshRate').addEventListener('change', e => {
      S.refreshMs = Number(e.target.value); storeSet('refresh', S.refreshMs);
      scheduleRefresh(); toast('行情刷新频率：' + fmtGap(S.refreshMs));
    });
    $('#colorMode').addEventListener('change', e => {
      document.body.classList.toggle('us', e.target.value === 'us');
      storeSet('color', e.target.value);
      Chart.setTheme(); renderWatchlist(); renderQuoteHead(); renderIndexes(); renderChart(); renderOrderbook();
    });
    $('#volumeMetric').addEventListener('change', e => {
      S.metric = e.target.value; storeSet('metric', S.metric); renderChart();
      toast('量能指标：' + Chart.METRICS[S.metric].label);
    });
    /* 「⟳ 刷新」＝**先强制取一次当前城市的实况**，再刷列表。
       顺序要紧：`warmQuotes()` 里也会写一次当前城市的报价，但它走默认的 180 秒缓存；
       先强制取一次，新数据落进同一个缓存 key，后面的列表轮询直接复用，不会多打一枪。
       （改之前实测：加载完 15 秒后点这个按钮，`/api/cma/now` 新增请求 = 0 条。） */
    $('#btnManual').addEventListener('click', async () => {
      toast('正在取最新实况…');
      await warmObs(true);
      await warmQuotes();
      await warmIndexes();
      if (S.cur) { S.lastFullAt = 0; }
      const nw = S.data && S.data.now;
      toast(nw ? ('已刷新 · ' + (nw.src === 'cma' ? '中国气象局实况 ' : '备援源 ') +
        String(nw.time || '').slice(-5)) : '已刷新');
    });
    // 自选列表长按拖动排序（事件委托挂一次就够，列表反复重画也不用重挂）
    bindWatchDrag();
    $('#btnSortWatch').addEventListener('click', () => {
      S.sortMode = (S.sortMode + 1) % 3; renderWatchlist();
      toast(['默认排序', '按涨幅排序', '按名称排序'][S.sortMode]);
    });
    $('#btnZoomReset').addEventListener('click', () => { renderChart(); toast('视图已重置'); });
    if ($('#btnFull')) $('#btnFull').addEventListener('click', toggleFullChart);
    // 手机底部页签：以前只画了按钮、根本没绑事件，所以点了没反应。
    // 用事件委托绑在 #mtabs 上，免得四个按钮各绑一次。
    const mnav = $('#mtabs');
    if (mnav) mnav.addEventListener('click', e => {
      const b = e.target.closest('.mtab[data-mtab]');
      if (!b) return;
      setMTab(b.dataset.mtab);
    });
    // 免责声明：底端那一条点了重看完整版；弹窗里「我知道啦」关掉它。
    // 点遮罩空白处也关（位置得正好落在遮罩本身，点卡片内部不关）。
    if ($('#disclaimer')) $('#disclaimer').addEventListener('click', showDisclaimer);
    if ($('#welcomeOk')) $('#welcomeOk').addEventListener('click', hideDisclaimer);
    if ($('#welcome')) $('#welcome').addEventListener('click', e => {
      if (e.target === $('#welcome')) hideDisclaimer();
    });
    $('#btnGeo').addEventListener('click', () => locate(false));
    $('#search').addEventListener('input', doSearch);
    $('#search').addEventListener('keydown', searchKey);
    $('#search').addEventListener('focus', () => { if ($('#search').value.trim()) doSearch(); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-wrap')) $('#searchResults').hidden = true;
    });
    $('#btnAllCities').addEventListener('click', () => { buildDrawer(); $('#cityDrawer').hidden = false; });
    $('#drawerClose').addEventListener('click', () => { $('#cityDrawer').hidden = true; });
    $('#cityDrawer').addEventListener('click', e => { if (e.target.id === 'cityDrawer') $('#cityDrawer').hidden = true; });
    // 术语对照表：炒股词全都用天气话讲了一遍，不炒股也看得懂
    $('#btnHelp').addEventListener('click', () => { $('#helpDrawer').hidden = false; });
    $('#helpClose').addEventListener('click', () => { $('#helpDrawer').hidden = true; });
    $('#helpDrawer').addEventListener('click', e => { if (e.target.id === 'helpDrawer') $('#helpDrawer').hidden = true; });
    // 竖屏里统计格的「展开/收起」（桌面那颗按钮是 display:none，点了也没用）
    $('#qMore').addEventListener('click', () => {
      const off = $('#quoteHead').classList.toggle('more-off');
      storeSet('qmore', off ? 1 : 0);
      syncQMore();
    });
    syncQMore();
    $('#drawerFilter').addEventListener('input', debounce(e => {
      const q = e.target.value.trim().toLowerCase();
      U.$$('#drawerBody .dw-city').forEach(n => {
        const c = API.Cities.get(n.dataset.id || '');
        n.style.display = (!q || n.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      });
    }, 120));
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'Escape' && document.body.classList.contains('fullchart')) {
        toggleFullChart();
        return;
      }
      const map = { 1: 'trend', 2: '7day', 3: 'day', 4: 'week', 5: 'month', 6: 'fcst' };
      if (map[e.key]) {
        S.period = map[e.key];
        U.$$('#periodTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.period === S.period));
        renderChart();
      }
      if (e.key === 'r' || e.key === 'R') $('#btnManual').click();
    });
  }

  function tickClock() {
    const d = new Date();
    $('#clock').textContent = U.fmtTime(d);
    $('#clockDate').textContent = U.fmtDate(d) + ' ' + U.weekday(d);
  }

  /* ═══════════ 启动 ═══════════ */
  /**
   * 手机竖屏的页签：宽屏下三栏并排，竖屏一次只放得下一栏，所以拆成
   * 自选(0) / 行情(1) / 盘口(2) / 明细(3) 四页，由 body[data-mtab] 决定显示哪栏。
   * 切到行情页时要 resize 图表 —— 隐藏期间 ECharts 量到的是 0 宽。
   */
  /**
   * 主图全屏：给 body 挂一个 fullchart 类，CSS 把 .layout 钉到整个视口
   * （顶栏/天气条/指数条/左右栏/状态栏/底部页签都让位），然后必须 resize ——
   * ECharts 只在自己被 resize 时才会重新量容器。
   * 没用 Fullscreen API：iOS Safari 的 Element.requestFullscreen 至今不支持，
   * 用 CSS 反而在哪都能用，退出也只要再点一次。
   */
  function toggleFullChart() {
    const on = !document.body.classList.contains('fullchart');
    document.body.classList.toggle('fullchart', on);
    const b = $('#btnFull');
    // 图标跟着状态换：进全屏后按钮是**触摸端唯一**的退出方式（Esc 在手机上没有），
    // 而 title 提示在触摸端也看不到，所以必须靠图标本身表态。
    if (b) {
      b.classList.toggle('active', on);
      b.textContent = on ? '🔙' : '🖥️';
      b.title = on ? '退出全屏（Esc）' : '全屏看主图';
    }
    setTimeout(() => { try { Chart.resize(); } catch (e) {} }, 60);
    toast(on ? '已全屏，再点一次或按 Esc 退出' : '已退出全屏');
  }

  /* ═══════════ 免责声明 ═══════════
     私自开展天气预报业务是违法的，本站只是搬运 + 展示，所以这条声明要
     ① 常驻网页底端（不能只藏在弹窗里，弹窗一关就再也找不到）
     ② 第一次打开时主动弹一次说清楚
     点底端那一条可以随时把完整版再弹出来。 */
  function showDisclaimer() {
    const m = $('#welcome');
    if (!m) return;
    m.hidden = false;
    storeSet('welcomed', 1);          // 弹过就记住，不再自动弹
  }

  function hideDisclaimer() {
    const m = $('#welcome');
    if (m) m.hidden = true;
  }

  function setMTab(i) {
    document.body.dataset.mtab = String(i);
    U.$$('#mtabs .mtab').forEach(b => b.classList.toggle('active', b.dataset.mtab === String(i)));
    if (String(i) === '1') setTimeout(() => { try { Chart.resize(); } catch (e) {} }, 60);
  }
  function isNarrow() { return window.matchMedia('(max-width:860px)').matches; }
  function syncMTabs() {
    const nav = U.$('#mtabs');
    if (!nav) return;
    const narrow = isNarrow();
    nav.hidden = !narrow;
    if (narrow) {
      if (!document.body.dataset.mtab) setMTab(1);   // 手机上默认直接看行情
    } else {
      delete document.body.dataset.mtab;             // 宽屏恢复三栏并排
      setTimeout(() => { try { Chart.resize(); } catch (e) {} }, 60);
    }
  }

  async function boot() {
    tickClock(); setInterval(tickClock, 1000);
    try {
      await API.Cities.load();
    } catch (e) {
      Chart.renderEmpty('城市数据集加载失败：' + e.message + '（请通过 http 服务访问，不要直接双击打开）');
      $('#statusLeft').textContent = '城市数据集加载失败：' + e.message;
      return;
    }
    $('#statusLeft').textContent = '已载入 ' + API.Cities.all.length + ' 个城市／地区';

    // 先把上次的定位结果注册进城市目录，否则下面 S.watch 的过滤会把 '__loc__' 当未知城市剔掉
    const savedGeo = storeGet('geo', null);
    if (savedGeo && savedGeo.lat != null) { S.geo = savedGeo; registerGeo(savedGeo); }

    /* 收藏列表的恢复：**没存过**就塞默认的北上广深+长沙+武汉（真正的"第一次使用"）。
       ⚠ 旧写法是 `storeGet('watch', null) || DEFAULT_WATCH` 再加一句
       "空了就塞默认"，于是**把收藏全删光的用户刷新一下又全回来了** ——
       那看起来像删不掉。现在空数组就是空数组，照实显示"还没有收藏的城市"。 */
    const savedWatch = storeGet('watch', null);
    S.watch = (Array.isArray(savedWatch) ? savedWatch : DEFAULT_WATCH).filter(i => API.Cities.get(i));
    S.refreshMs = storeGet('refresh', 900000);
    S.metric = storeGet('metric', 'range');
    S.overlay = !!storeGet('overlay', 0);
    const cm = storeGet('color', 'cn');
    document.body.classList.toggle('us', cm === 'us');
    // 竖屏默认把统计格折到两组：真机 400px 宽时五组要占 180px，主图只剩不到 100px。
    // 用户点过「收起/全部数据」就按他点的来；宽屏一律全放（CSS 里那条规则也只在窄屏生效）。
    const qmore = storeGet('qmore', null);
    const narrow = window.matchMedia('(max-width:860px)').matches;
    if (qmore === null ? narrow : (!!qmore && narrow)) $('#quoteHead').classList.add('more-off');
    syncQMore();
    $('#refreshRate').value = String(S.refreshMs);
    $('#volumeMetric').value = S.metric;
    $('#colorMode').value = cm;

    Chart.init($('#mainChart'), $('#subChart'));
    bind();
    if (window.WXUI) WXUI.init();
    renderWatchlist(); renderIndexes();
    scheduleRefresh();

    const lastId = storeGet('last', null);
    const q = urlParams();
    syncTabs();
    // ?help=1 直接展开术语对照表（可分享的链接，也方便截图自查）
    if (q.help) $('#helpDrawer').hidden = false;
    // ?wx=wxRadar|wxSat|wxTy|wxWarn 直接打开某个天气功能页（同样方便截图自查）
    if (q.wx && window.WXUI) setTimeout(() => WXUI.open(q.wx), 500);
    // ?mtab=0..3 可深链到手机页签；宽屏下忽略
    syncMTabs();
    if (q.mtab != null && isNarrow()) setMTab(q.mtab);
    let rt;
    const onViewport = () => { clearTimeout(rt); rt = setTimeout(syncMTabs, 120); };
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    const geoP = initGeo(q);
    const first = (q.city && API.Cities.get(q.city)) ? q.city
      : (lastId && API.Cities.get(lastId)) ? lastId : S.watch[0];
    selectCity(first);
    // 首次访问（没有深链城市、也没有上次浏览记录）时，等定位回来自动切到「当前位置」，
    // 和普通天气软件一致。有明确指定的城市就尊重它，不做劫持。
    if (!q.city && !lastId && !savedGeo) {
      geoP.then(g => { if (g) selectWhenIdle(LOC_ID); });
    }

    warmIndexes();
    warmQuotes();
    /* 收藏城市的**整份数据**趁空闲静默预热（见 warmCities 的注释）。
       用 requestIdleCallback 是为了不跟首屏抢主线程；setTimeout 那条是给 Safari 兜底的
       （它到 2026 年还没有 requestIdleCallback）。 */
    if (window.requestIdleCallback) requestIdleCallback(function () { warmCities(); }, { timeout: 4000 });
    else setTimeout(warmCities, 1500);
    checkDownloads();
    // 第一次打开（本机没记过 welcomed）弹一次免责声明；?welcome=1 可以强制弹出来
    // （方便截图自查，也方便把这个链接发给别人看声明）。
    if (q.welcome || !storeGet('welcomed', 0)) showDisclaimer();
    const h = await API.Cn.health();
    if (h && h.local) $('#statusSrc').textContent = '中国天气网本地代理 ' + (h.version || '');
  }

  /**
   * 状态栏的「下载客户端」只在真的能下到时才出现 —— 本地 http.server / 打包版都没有
   * dist/ 目录，HEAD 探测失败就把链接摘掉，避免摆一个点了 404 的按钮。
   */
  function checkDownloads() {
    const box = U.$('#dlBox');
    if (!box) return;
    const links = U.$$('#dlBox .dl');
    if (!links.length) return;
    Promise.all(links.map(a => fetch(a.getAttribute('href'), { method: 'HEAD' })
      .then(r => { if (r.ok) return null; throw new Error('' + r.status); })
      .catch(() => a)))
      .then(dead => {
        dead.filter(Boolean).forEach(a => a.remove());
        if (U.$$('#dlBox .dl').length) box.hidden = false;
      })
      .catch(() => {});
  }

  /** 支持 ?city=101010100&p=day&ind=wind&color=us&m=precip&wx=wxRadar&help=1 深链与分享（也方便无头截图） */
  const PERIODS = ['trend', '7day', 'day', 'week', 'month', 'fcst'];
  const INDS = ['vol', 'precip', 'wind', 'cloud', 'air'];

  function urlParams() {
    const o = {};
    const qs = String(location.search || '').replace(/^\?/, '');
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      o[k] = v;
    });
    if (o.p && PERIODS.indexOf(o.p) >= 0) S.period = o.p;
    if (o.ind && INDS.indexOf(o.ind) >= 0) S.ind = o.ind;
    if (o.ov != null && o.ov !== '') S.overlay = (o.ov !== '0' && o.ov !== 'false');
    if (o.m && Chart.METRICS[o.m]) S.metric = o.m;
    if (o.color === 'us' || o.color === 'cn') {
      document.body.classList.toggle('us', o.color === 'us');
      const sel = $('#colorMode'); if (sel) sel.value = o.color;
    }
    return o;
  }

  /** 让 tab 高亮与 S.period / S.ind 保持一致（深链与快捷键都要用） */
  function syncTabs() {
    U.$$('#periodTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.period === S.period));
    U.$$('.tabbar.sub .tab[data-ind]').forEach(x => x.classList.toggle('active', x.dataset.ind === S.ind));
    const vm = $('#volumeMetric'); if (vm) vm.value = S.metric;
  }

  document.addEventListener('DOMContentLoaded', boot);
  window.__APP = { S, selectCity, addWatch, removeWatch, renderChart, locate, renderGeo, applyGeo, LOC_ID, haversine, nearestCity, warmQuotes, briefOf };
})();
