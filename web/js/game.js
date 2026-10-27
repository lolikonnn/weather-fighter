/* ═══════════════════════════════════════════════════════════════
   game.js — 「点击做空天气」：拿真实天气当行情，15 分钟一根 K 线
   ═══════════════════════════════════════════════════════════════

   设计要点（改之前先读）：

   ① **标的是「天气指数 WXI」，不是气温本身**。
      这里踩过一次坑：第一版直接拿气温当价格，结果被吐槽「太稳定了，没有
      什么感觉，只要稳住总会升 / 降的」—— 因为气温有昼夜循环和季节趋势，
      抱着不动就能赢，盘感无从谈起。
      气温一小时才挪一两度，做成 K 线就是一条几乎水平的线。
      真正有波动的是**对流**：CAPE（对流有效位能）能从 0 冲到 5000、
      阵风能从 2 m/s 冲到 60 m/s、降水绝大多数时刻是 0、打雷时才爆。
      所以指数由这几项加权而成，**打雷下雨 = 拉升，天气转好 = 回落**。

   ② **价格是「趋势 + 噪声 + 突发行情」的组合**，不是原始指数：
          trend = EMA(sev, 0.05)                       // 慢分量，给方向
          shock = (|Δsev| − 0.9) × 34,  仅当 |Δsev| > 0.9 // 单根剧烈变化 → 一记冲击
          carry = carry × 0.78 + shock                 // 冲击的余波，顺着惯性再走几根
          price = 1000 + (trend − median(trend)) × 50  // 趋势放大，走得出行情
                       + (sev − trend) × 16            // 快分量，给盘中抖动
                       + carry                         // 突发行情
      系数是拿真数据调出来的（广州 / 哈尔滨 92 天实测）：
      单根 15 分钟中位涨跌 0.17%、p99 约 5~6%、单日振幅中位 9~11%、
      连续 3 根的最大跌幅中位 7.8%（哈尔滨能到 15%）。既走得动，又不会变成纯随机数。

      **`shock` 不是随机数** —— 触发条件是真实观测到的剧烈变化（CAPE 炸了、
      阵风猛增、开始下暴雨）。没有真实天气过程的时候，盘面就是平静的；
      久留美里那种「蜡烛图突然拉到底」，背后是真有一次对流爆发。

   ③ **行情是真的，但只有「K 线实体」是真采样出来的**。
      数据是 Open-Meteo 的 minutely_15（15 分钟一个点，92 天历史）。
      开盘价 = 上一根收盘价，收盘价 = 本根指数，这两个都是真值；
      上下影线按 |本根涨跌| × 0.3 建模 —— 15 分钟粒度拿不到根内的真实最高最低，
      只能这样近似。README 里写明了，别对外说影线也是实测。

   ④ **只用「现在」之前的段**。`i0` 是当前时刻在数组里的下标，取样只在其前，
      绝不碰预报段。界面上只显示「第 3 天 14:15」，不给真实日期 —— 否则
      一查历史就知道后面怎么走。

   ⑤ **爆仓是真爆**。权益跌破「占用保证金 × MAINTAIN」就强平，不是"亏光本金"
      那种假爆仓。满仓 + N 倍杠杆时反向走 (1−10%)/N 就没了：5 倍约 18%、
      10 倍约 9%、20 倍约 4.5%、50 倍约 1.8%、100 倍约 0.9%。
      按指数 1000 点算，100 倍只要反向 9 个点。

   ⑥ **只画最近一屏**。一局 672 根（15 分钟档、7 天），全塞进 1300px 的话一根才 1.9px，
      蜡烛会糊成一条线。所以按容器宽度算可视根数并跟着行情自动滑动 ——
      真实的操盘软件也是这么做的。

   ⑦ **天文变量：月光 + 流星雨**（2026-10-09 加）。
      使用者问「现在新添加了天文等模块，那么模拟游戏是否可以加入更多的变量使曲线变化
      更加夸张具有戏剧性？」——可以，而且正好补在这个模型记录在案的那条缺口上：
      我们的分布是"厚腰薄尾"，而真行情是"薄腰厚尾"（长时间极静 + 偶发暴动）。
      天文事件天然就是**偶发暴动**：
        · 月光   是慢变量（朔望月 29.5 天）→ 给一局一个"这个月的性格"；
        · 流星雨 极大一年只有**九次**、每次只旺一两夜 → 真正的突发事件。
      真值全部来自 `astro.js`（观星页用的是同一套），**不引入任何新数据源**：
      月相与月亮高度是解析式；流星雨用那张 IMO 九场表 + 三个真实可见度因子
      （天文夜 / 晴空 / 无月）。**辐射点高度不建模** —— 表里只有星座名、没有赤经赤纬，
      凭空补一组坐标就是编数据（真实流量还要乘 sin(辐射点高度)，这里拿天文夜近似，
      是保守而不是造假）。效果量化见 `tools/probe_astro.js`。
*/
(function (global) {
  'use strict';
  const { $, el, storeGet, storeSet, toast } = U;

  /* ═══════════════ 可标定系数表 ═══════════════
     把"手感系数"全部收进一个对象，只为了能**成批扫参**（tools/calibrate_game.js）。
     以前它们是一堆散落的 const，标定时只能一个一个手工改、还要改回来。

     真实基准（欧易 9 个对 × 365 天 × 15 分钟，tools/analyze_crypto.py）：
       BTC 单根 |涨跌| 中位 0.0822% / WIF 0.2541% → 梯度 3.09×
       15 分钟自相关 ≈ 0.02（几乎无记忆）
     这些数就是"该调到多少"的靶子，不再是拍脑袋。 */
  const P = {
    /* ═══════ 以下系数是用真实交易所数据标定的，不是拍的 ═══════
       方法：tools/fetch_crypto.py 下欧易 9 个对 × 365 天 × 15 分钟
             → tools/shape_check.js 量真实分布形状 → tools/tune_shape.js 搜参。
       靶子（真实 BTC 0.0994% → WIF 0.2541%）：中位 0.1848%、p90/中位 3.35、
             p99/中位 8.30、城市梯度 2.56×。

       ✅ 已对上：**水平**（中位 0.1840% vs 0.1848%）与**城市梯度**（2.02× vs 2.56×）。
       ❌ 对不上、而且**结构性做不到**：中等波动偏多、极端波动偏少
             （p90 6.62 vs 3.35，p99 19.35 vs 8.30）。
             原因是本模型 = 大量独立随机项叠加 → 中心极限定理把分布推向"厚腰薄尾"；
             真实行情是反过来的"薄腰厚尾"（长时间极静 + 偶发暴动）。
             要真正对上得换成"平时几乎不动、偶发跳变"的生成机制 ——
             那是重写价格模型，不是调参。详见 docs/NOTES.md。 */
    JUMP_AT: 1.8,      // |Δsev| 超过它才算"剧烈变化"。实测调到 1.8 以上**完全无影响**
                       // （真实天气 15 分钟内的 |Δsev| 极少超过 1.8）→ 这一项基本空转
    TREND_K: 8,       // 趋势分量放大倍数。反推自真实梯度：要拿到 2.56× 的城市梯度，
                       // 趋势的方差占比不能超过约 14% —— 趋势是所有城市共用的慢分量，
                       // 它占比一高，大小城市的差别就被抹平（原值 50 时梯度只有 1.5×）
    EMA_A: 0.05,       // 趋势 EMA 系数（半衰期约 14 根 = 3.5 小时）
    NOISE_K: 13.308,   // 快分量放大倍数
    NOISE_A: 0.45,     // 快分量 EMA 系数（越小越"成段"）
    NOISE_BOOST: 1.42, // 补回 EMA 削掉的方差
    MICRO_K: 1.247,    // 微观毛刺振幅
    MICRO_DECAY: 0.68,
    JUMP_K: 28.279,     // 超出部分折算成冲击点数
    JUMP_DECAY: 0.78,  // 余波衰减
    REG_K: 4.99,      // 区域大盘带动
    DEW_K: 4.159,      // 露点（湿热）项
    DISH_K: 2.495,     // 盘子扰动基准振幅（再乘 cityAmp）
    DISH_DECAY: 0.96,
    AIR_K: 4.99,      // 空气质量慢变量偏置
    QUAKE_K: 9.981,   // 地震：每高出 M0 一级、按距离衰减后的冲击点数
    TYPHOON_K: 33.269, // 台风：风速/30 × 距离衰减后的冲击点数
    FCST_K: 1.663,     // 预报偏离系数
    /* ── 天文：天文模块的**全部变数**都进来了（2026-10-09）──
       使用者原话：**「我想明白了模拟游戏要的不是真实而是戏剧性，要刺激」**。
       所以这一组系数**不再按交易所分布标定，按"好不好看"标定**：
       天象好的夜要能看见大阳线、流星雨极大要能砸出长针、超级月亮叠大潮要能走出
       一段像样的趋势。真值仍然是真值（全部来自 astro.js 的解析式，零编造），
       被放大的只是"这些真事件对盘面的影响"。

       ⚠ 唯一不能破的纪律：任何**累加器**都必须带 `(1-decay)` 权重（见流星雨那段），
         否则稳态是 `1/(1-decay)`、系数会变成你以为的 66 倍 —— 那是 bug，不是戏剧性。
       ⚠ 新加进来的通道**一律 0~1 归一**再乘系数，这样"戏剧性"只由系数大小决定，
         不会出现某个通道因为量纲不同偷偷主导整条曲线。 */
    MOON_K: 8,          // 月光（满月当空 → 夜空被照亮）
    METEOR_K: 80,       // 流星雨极大夜（一年九次、每次一两夜）
    METEOR_FLOW: 2.5,   // 极大夜成交放大（事件到达率 ×3.5）
    METEOR_DECAY: 0.985, // 极大过去后的余波衰减（半衰期约 46 根 ≈ 11.5 小时）
    SUPER_K: 70,        // 超级月亮（近地点 + 盈凸/满月）：一次**事件型**大冲击
    GALAXY_K: 22,       // 银心高度（银河能否拍到，夏夜高、冬夜落）
    STAR_K: 8,          // 头顶亮星/行星数量（此刻星空那页的东西）
    NIGHT_K: 20,        // 天文夜占比（冬夜长）：**绝对口径**，0.5 = 春秋分
    SPRING_K: 26,       // 大潮（朔望）—— 潮汐在这一组里只取"大潮/小潮"这个戏剧性最强的量
    LP_K: 12,           // 城市光污染（1~9 级）：越暗的地方，天象对盘面越"通"
    Kp_K: 45,           // 地磁暴（NOAA 实测 Kp，只有最近约 7 天有数据，更早的时段为 0）
    /* ── 戏剧性总闸门 ──
       `heat` 是上面这些通道的**加权合成（0~2）**，它不去动价格本身，而是去拧三个
       "放大镜"：成交活跃度、混沌跳跃的**概率**与**幅度**。为什么要这么绕：
       直接加一个"天象点数量"只会抬高水平；而拧这三个旋钮，能在天象好的夜里
       做出**成片的、带长针的、连贯的**行情 —— 也就是"刺激"该有的样子。
       HEAT_FLOW/HEAT_CHAOS 给得比真实大得多，是这一轮有意为之。 */
    HEAT_FLOW: 3.0,     // 天象热度 → 事件到达率 ×(1+3×heat)（最高 ×7）
    HEAT_CHAOS_P: 9.0,  // 天象热度 → 混沌跳跃概率 ×(1+9×heat)
    HEAT_CHAOS_K: 1.5,  // 天象热度 → 混沌跳跃幅度 ×(1+1.5×heat)
    HEAT_SPIKE: 6.0,    // 天象热度 → 插针概率 ×(1+6×heat)
    CITY_AMP_A: 0.19,  // 城市 → 波动放大倍数的幂次（见 cityAmp）
    CITY_K: 0.8389,     // 归一常数：让 dishScale = 1.0（地级市）那档的 cityAmp = 1.0
    /* ── 天气 → 指数（这两项决定"指数在说什么"）──
       COMFORT_K：舒适度每高出中位 1 分，指数高多少点。
                  基本面 anchor = BASE + (慢速 comfort − 中位) × COMFORT_K。
                  靶子是最常见那批波动的幅度（真实中位绝对涨跌 0.1848%），
                  见 tools/calibrate_comfort.js。
       REVERT   ：每根 K 线把价格往 anchor 拉回的比例（均值回归）。
                  没有它就是随机游走：方差随时间无限增长，一局跑到后面会飘离 1000，
                  "指数 1000 = 天气一般"这个语义就没了。
                  ⚠ 它和 COMFORT_K 是一对：REVERT 越小价格越"黏"在基本面上、
                    天气对指数的主导权越大；越大则越像纯噪声。
                      0.02 → 半衰期约 34 根（8.6 小时）
                      0.05 → 半衰期约 14 根（3.5 小时） */
    COMFORT_K: 8,
    /* NOISE_AMP：所有随机项的**总幅度**旋钮。单独拎出来是为了让标定脚本
       能一次调平波动水平，而不用去改 NOISE_K/DISH_K/... 十来个系数
       （那些系数的**相对比例**才是各自的分工，总音量应该只有一个旋钮）。 */
    NOISE_AMP: 0.35,
    /* NOISE_REVERT：噪声通道（快通道）的回归强度。越大噪声衰减越快、盘面越"毛"。
       它和 REVERT 分工不同：REVERT 管长期钉住基本面，它管短周期的抖动。
       ⚠ 这一对是标定出来的**关键**：单通道时 lag-1 自相关锁死在 0.84
         （怎么调另外两个旋钮都没用），加上快通道后降到 0.40。详见 docs/NOTES.md。 */
    /* ── 事件驱动架构的三个旋钮 ──
       INERTIA      ：冲击的衰减速率（每根衰减这个比例）。半衰期 ≈ ln2/INERTIA。
                      这是**自相关的直接控制**：衰减快 → 冲击互不重叠 → 自相关 ≈ 0。
       FLOW_RATE    ：每根 K 线的基准事件到达数。真实 15 分钟大概就是 1~2 笔。
       EVENT_K      ：单笔事件的平均冲击幅度（价格的千分比）。
       FLOW_DECAY   ：自激强度的记忆（波动聚集的来源）。 */
    INERTIA: 0.92,
    FLOW_RATE: 1.2,
    EVENT_K: 0.0003,
    FLOW_DECAY: 0.9,
    /* ── 插针（流动性被吃穿）──
       真实币圈最显眼的形态之一：一根长针打出去、立刻缩回，实体很小。
       原来影线写死成 `|涨跌| × WICK_K`，是**确定性**关系 —— 大实体必然大影线，
       根本做不出"小实体长针"。

         SPIKE_P     ：每根 K 线的基础触发概率（还会乘天气活跃度）
         SPIKE_DEPTH ：插针深度 = 价格 × 这个比例；实际再除以 dishScale(城市)
                       —— 小城市盘子薄、同样的扫单打得更深

       ⚠ 幅度**必须按价格绝对水平算，不能跟 body 挂钩**。我第一版用 `max(body, ·)`
         当基准，结果 body 一大针就爆（body 的 p99 有 32 点、max 90 点），
         实测出现 2223 点的影线，整根 K 线糊成一条竖线。
         真实插针是"价格被打下去几个百分点"，与当根实体多大无关。

       ⚠ 插针**只在 pickSeries 里生成一次**（立靶子），动画只许读不许自己算 ——
         让 liveAt() 现算的话每次读都重掷骰子，同一根蜡烛前后看到的针不一样。

       ⚠ 只改影线、不改收盘，所以不动已经标定好的收益分布。 */
    SPIKE_P: 0.00012,
    SPIKE_DEPTH: 0.045,
    /* BRIDGE_K：分钟级"布朗桥"的步长（相对父根振幅）。
       控制 1 分钟 / 5 分钟档**内部来回的幅度**。
       太小 → 又是直线（真实盘面里 1 分钟不可能是直线）；
       太大 → 分钟级的振幅超过它所属的 15 分钟，聚合回去就不像话了。
       桥的方差是 t(1−t) 形状，两头小中间大，所以这个值可以给得比"均匀摆动"更大些。 */
    BRIDGE_K: 1.6,
    /* BRIDGE_RHO：分钟级路径的**动量**（AR(1) 系数）。
       0 = 每步独立（画出来是锯齿，不像行情）；越大越"成段"。
       0.55 大约连走 2~3 根同向，接近真实分钟线的样子。 */
    BRIDGE_RHO: 0.55,
    /* ── 混沌跳跃（肥尾的来源）──
       真实 15 分钟单根最大 BTC 4.2% / WIF 38%、峰度 16~833；
       本模型原来只有 max 5.8%、峰度 5~13。这条通道补的就是这个尾巴。
         CHAOS_P  ：基础触发概率（还会乘平静度与热度）
         CHAOS_K  ：跳跃幅度（价格的千分比）
       它**不进快通道**（不被 NOISE_REVERT 回拉），否则尾巴又会被压平。 */
    CHAOS_P: 0.0004,
    CHAOS_K: 0.0035
  };

  /* ═══════════════ 合约与规则 ═══════════════ */
  // 本金可以在开场卡片里改，而且**真的会改变难度**（见 cashTip 的注释）：
  // 手续费有 5 元保底、滑点随名义金额上涨、小城市盘子更小。
  // 本金翻 10 倍，手数也翻 10 倍，**仓位盈亏比例**那条仍然成立 ——
  // 但成本占本金的比例会随本金一起涨，所以"钱多"是把双刃剑。
  const DEF_CASH   = 300000;   // 默认本金（群里说"久留美都有三十万"，那就三十万）
  const CASH_MIN   = 1000;
  const CASH_MAX   = 100000000;
  const CASH_PRESETS = [100000, 300000, 1000000, 3000000, 10000000];
  const LOT_MULT   = 10;       // 1 手 × 指数每动 1 点 = 10 元
  const FEE_RATE   = 0.0005;   // 单边手续费，万分之五
  const FEE_MIN    = 5;        // 单笔最低手续费（对齐参考软件那句"单笔不足 5 元按 5 元收"）
  // 滑点：名义金额越大越难在你要的价位成交。
  // `slipOf()` 里 滑点(点) = SLIP_K × 名义金额 ÷ (CAP_BASE ÷ dishScale(城市))。
  // CAP_BASE = 300 万是「广州这类城市的盘子容量」的基准；小城市 capacity 更小、滑点更大。
  // 典型值：30 万本金 / 30% 仓 / 10 倍 → 名义 90 万 → 约 0.09%；300 万本金 → 约 0.9%。
  //
  // **SLIP_MAX 这个上限是必须有的。** 滑点按名义金额算，而 名义金额 = 本金 × 仓位% × 杠杆，
  // 所以滑点随杠杆**平方**增长：30 万本金、满仓、100 倍时名义 3 亿，滑点会算到 300 点 ——
  // 比 100 倍那条 0.9% 的爆仓线还远，等于"一开仓必爆"。截图真的逮到过
  // 「本金 30 万 · 滑点 ¥896,939」这种荒唐数字。
  //
  // 上限取 **10 点（指数的 1%）** 是折中：300 万本金 / 30% 仓 / 10 倍算出来是 9.54 点，
  // 刚好没被削到，所以**设计工作区间内「本金 ×10 → 成本占本金 ×10」这条线性还在**；
  // 再往上（1000 万，或任何 100 倍满仓）就被封在 10 点，
  // 表现为"一开仓就归零"而不是"欠下比本金还多的滑点"。
  const SLIP_K     = 3;
  const SLIP_MAX   = 10;
  const CAP_BASE   = 3000000;
  const MAINTAIN   = 0.10;     // 维持保证金率：权益 ≤ 占用保证金 × 10% 就强平
  const BASE       = 1000;     // 指数基准
  /* 手感系数全部走 P.xxx 现取（不设 const 别名）。
     ⚠ 这里踩过两次坑，都是"标定脚本改了 P 但结果一动不动"：
       ① `const NOISE_K = P.NOISE_K` —— 加载时快照；
       ② 改用 `Object.defineProperty` 包一层再 `return o[k]` —— 读一次仍然是快照。
       浏览器里没有构建步骤，想在运行时改系数就只能**每次引用 P 本身**。
       所以下面代码里凡是原来的 NOISE_K / JUMP_K / … 一律写成 P.NOISE_K / P.JUMP_K。 */
  /* ── 让走势像真的股票，而不是一串独立的随机点 ──
     真实的分钟级行情有个很显眼的特征：**相邻两根是相关的**（lag-1 自相关 0.2~0.5），
     所以看起来是"一段一段地推"，而不是每根各走各的。原来的快分量是
     (sev − tr) × P.NOISE_K，sev 本身已经比较连续，但两根之间还是偏独立，
     盘面上就显得"生硬"。这里加两层：
       ① P.NOISE_A：把快分量本身过一道轻 EMA（越小越平滑、越有趋势感），
          再用 P.NOISE_BOOST 补回被 EMA 削掉的方差，保证整体波动幅度不变；
       ② 微观游走 micro：一个衰减的 AR(1)，给出真实盘口那种细细的毛刺。
     这些系数是拿真实 minutely_15 跑探针量出来的（见 docs/NOTES.md）。 */
  const WICK_K     = 0.30;     // 影线 = |本根涨跌| × 这个系数
  // 突发行情：单根 15 分钟里 severity 变化超过 P.JUMP_AT 个稳健标准差才算"剧烈变化"，
  // 超出的部分乘 P.JUMP_K 变成冲击，再按 P.JUMP_DECAY 衰减出余波（见 pickSeries）。
  /* 一局的结构 = **预热 + 交易**。
     群里那位说得对：真实的行情软件打开就是一条已经走了很久的连续 K 线，不会从空白开始长。
     所以进来先白送 1 周（7 天）历史（画在图上、已经走完，你只能看不能交易），
     光标停在历史末尾，「开始玩」是从这一天往后接着走，再走 1 个月（30 天）结算。 */
  const WARM_DAYS  = 7;        // 开局先铺满的历史天数（只看不交易）—— 一周
  const TRADE_DAYS = 30;       // 实际要交易的天数 —— 一个月
  const ROUND_DAYS = TRADE_DAYS;  // 兼容旧名字：一局 = 交易天数
  /* K 线周期档位（分钟），照参考软件的排布：分钟K / 时K / 日K 三层。
     **15 分钟是数据源的真实粒度**：Open-Meteo 的 minutely_15 已经是最细的免费粒度了
     （minutely_1 / minutely 参数照收、HTTP 200，但 time 数组长度是 0，只看状态码发现不了）。所以：
       · ≥15 分钟（15/30/60/240/1440）→ 把真数据**聚合**起来（2 / 4 / 16 / 96 根并 1 根）
       · <15 分钟（1/5）→ 把每根 15 分钟**插值展开**（1 分钟 = 展开成 15 根）
     也就是说 1 分钟和 5 分钟档上那些细碎波动是**建模的、不是采到的**，README 写明了。 */
  const BAR_MIN    = [1, 5, 15, 30, 60, 240, 1440];
  const BAR_N      = ['1 分', '5 分', '15 分', '30 分', '1 时', '4 时', '1 日'];
  const SRC_MIN    = 15;       // 数据源粒度（Open-Meteo minutely_15）
  /* 速度档位的单位是**每真实秒推进多少分钟的天气时间**（一局 = 30 天 = 43200 分钟）。
     所以一局的墙钟时长 = 43200 ÷ 这个数，**与 K 线周期无关**：1 分钟档和 1 日档
     看的是同一段天气、同样时长，只是一个看得细、一个看得粗。
     四档对应一局约 48 / 32.7 / 16 / 8 分钟（可以随时暂停，也可以直接平仓结算）。
     每根 K 线多长时间由 BAR_MIN 决定，所以「每秒几根 K 线」= 这个数 ÷ 周期分钟数，
     1 分钟档 + 狂暴档能到 90 根/秒 —— 那是画不过来的，所以主循环按 TICK_HZ 批处理。 */
  /* 速度档：每真实秒推进多少**分钟天气**。
     TICK_HZ=4 时，每次更新的推进量 = SPEEDS/4 分钟，所以:
       SPEEDS=15  → 每次推 3.75 分钟 = 0.25 格（最细）
       SPEEDS=60  → 每次推 15  分钟 = 1.00 格（**刚好一格一次**，默认）
       SPEEDS=120 → 每次推 30  分钟 = 2.00 格（开始跳格）
       SPEEDS=240 → 每次推 60  分钟 = 4.00 格（明显跳格） */
  const SPEEDS     = [15, 30, 60, 120, 240];
  const SPEED_N    = ['实时', '慢', '悠闲', '正常', '狂暴'];

  /* ── 时间流速：整个游戏只有这一个时间轴，**与 K 线档位无关** ──
     这是核心不变量，写在这里免得以后再搞错：

         G.acc += (SPEEDS[speed] / barMin()) / TICK_HZ

     G.acc 是"当前这根 K 线的进度"，乘上 barMin() 就是**推进的天气时间**
     = SPEEDS[speed] 分钟/秒 —— **式子里没有档位**。所以切换 1 分/1 时/1 日
     只是换了一把尺子去看**同一条时间轴**，时间流速一点不变。
     档位改变的是"一根 K 线代表多少天气时间"，不是"天气走多快"。

     由此推出各档位一根 K 线的墙钟时长 = **barMin / SPEEDS**（用哪个 SPEEDS 档看下表）：

     | 档 | SPEEDS | 一格 15 分钟 | 1 日一根 | 一局 30 天 |
     |---|---|---|---|---|
     | 实时 | 15 | 1.00 s | 96.0 s | 48.0 min |
     | 慢 | 30 | 0.50 s | 48.0 s | 24.0 min |
     | **悠闲（默认）** | **60** | **0.25 s** | **24.0 s** | **12.0 min** |
     | 正常 | 120 | 0.13 s | 12.0 s | 6.0 min |
     | 狂暴 | 240 | 0.06 s | 6.0 s | 3.0 min |

     ⚠ 单位是「每真实秒推进多少**分钟**天气」，不是「每秒几根 K 线」。
       写成后者就会变成"档位越粗越快"，那是错的（时间流速会跟着档位变）。
     ⚠ 一局 30 天是固定的（预热 7 天 + 交易 30 天），所以一局长度 = 一局分钟数 ÷ SPEEDS。
       想看清粗档位就得接受一局长；想一局短，粗档位就会闪过去。这是同一个旋钮。
     ⚠ 默认选 60（不是最快也不是最慢），因为它让 **TICK_HZ=4 时每次更新正好推进一格**
       —— "一秒变 4 次"和"一格一变"在这档上重合，看着最像真实行情推送。 */
  /* ── 重绘频率：一秒变几次 ──
     **这是独立于时间流速的一条规则。** 它和 SPEEDS 各管一件事：

         SPEEDS  → 天气时间走多快（一格 15 分钟花几秒）
         TICK_HZ → 一秒重建几次画面（candle 一秒变几次）

     两者通过推进量解耦：
         G.acc += (SPEEDS[G.speedIdx] / barMin()) / TICK_HZ
     `u` 的推进速率 = SPEEDS×60/barMin（次/秒，与 TICK_HZ 无关），
     所以**改 TICK_HZ 只改"多久采一次样"，不改"天气走多快"**，一局时长不变。

     ⚠ 这个解耦是被用户点出来的，前面几轮一直没意识到：
       用户要的是"无论怎么调时间流速，都是 1 秒变 4 次"。
       原来的 30 Hz 并不是"一秒变 30 次" —— 价格每 tick 都在动，
       所以它其实是"看得太连续"，反而不像行情推送。4 Hz 才像一个真的报价流。 */
  const TICK_HZ    = 4;
  function perDay()    { return 1440 / BAR_MIN[G.barIdx]; }           // 一天几根
  function warmBars()  { return WARM_DAYS * perDay(); }               // 预热段几根
  function tradeBars() { return TRADE_DAYS * perDay(); }              // 交易段几根
  function totalBars() { return warmBars() + tradeBars(); }           // 整条序列几根
  function roundBars() { return tradeBars(); }                        // 一局（交易段）几根
  function srcBars()   { return (WARM_DAYS + TRADE_DAYS) * 1440 / SRC_MIN; } // 要几根 15 分钟源数据
  function barMin()    { return BAR_MIN[G.barIdx]; }                  // 当前周期（分钟）
  function roundSecs() { return TRADE_DAYS * 1440 / SPEEDS[G.speedIdx]; } // 一局墙钟秒数

  /* ── 复合标的：标的不是一个城市的天气，而是「大盘 + 本地 + 湿度 + 盘子扰动」 ──
     群里那位说得对：只炒一个城市的对流，盯久了就那点花样。真实市场里你炒的东西
     是被大盘推着走的，所以这里把 15 分钟粒度的**同省区域平均气温**也当成一股力。
     要注意哪几项是真的、哪几项是建模的（README 里也写了）：
       区域项  reg  真数据：Open-Meteo 一次请求同省 8 城 15 分钟气温，等权平均
       湿度项  dew  真数据：minutely_15 的 dew_point_2m（PM2.5 没有 15 分钟产品，不拿它充数）
       盘子项  dish **建模**：带衰减的随机游走，小地方振幅更大（见 cityWeight）
     每一项都是"那一项的异常值 × 一个系数"，异常值用中位数对齐，所以叠加后
     基准仍然是 BASE = 1000。 */


  /* ── 五路「真数据」压力源：空气质量 / 地震 / 台风 / 预报偏离 / **天文家族** ──
     前四个都是群里点名要的，第五路是 2026-10-09 那一轮加的
     （使用者原话：「模拟游戏要的不是真实而是戏剧性，要刺激」）。
     但**每一路都接真实数据**，没有一个是编的：
       空气  air   真数据：air-quality-api 的逐小时 PM2.5（小时级，按小时对齐回放窗口）
       地震  quake 真数据：USGS 按城市半径筛出的真实事件（时刻 / 震级 / 震源深度）
       台风  typh  真数据：中央气象台台风网的真实路径点（时刻 / 经纬度 / 风速 / 气压）
       预报  fcst  真数据：previous-runs 的「事后实测」减去「提前 24 小时发出的预报」
                     —— 也就是**当时那份预报错了多少**，报得越离谱行情越抖。
       天文  astro 真数据：astro.js 的解析式（月相 / 月亮距离 / 银心高度 / 亮星与行星
                     / 天文夜 / 大潮）+ 本站城市光污染表 + NOAA 实测 Kp，**九个通道**。
                     真值全是真值，被放大的只是"它们对盘面的影响"（见 P 表那一段）。
     但要说清楚**哪部分是真、哪部分是建模**：
       · 事件的**时刻、强度、位置**全部来自上面的真数据源；
       · 「指数往上还是往下」是**建模决策** —— 游戏设定是"指数越高＝当地越糟"
         （开场卡片原话：「打雷下雨 = 拉升，天气转好 = 回落」），
         所以台风和地震都做成**向上**的衰减冲击：出事冲高、随后回落，
         正好是"利好出尽"，玩家追高就要吃余波的亏。
       · 任何一项取不到数据就整项退化成 0，**绝不编数据补位**。
     每一个新项都先做稳健标准化再乘系数，所以叠加后基准仍然是 BASE = 1000。 */
  const QUAKE_M0   = 3.0;      // ② 低于这个震级不算压力（USGS 的查询下限也是 3.0）
  const QUAKE_R    = 700;      //    震中到这个公里数之外就不计入了（与 api.js 的查询半径一致）
  const QUAKE_DECAY = 0.90;    //    余波衰减（半衰期约 6.6 根 ≈ 1.7 小时）
  const TYPHOON_R  = 900;      // ③ 台风中心影响到这个公里数以内才计入

  /* 上面这几个系数是量出来的，不是拍的。标尺来自探针实测：
     单根中位涨跌约 2.7 点（0.266%）、整局（672 根）振幅约 250 点（25%）。
     据此定"一次压力事件该有多大"：
       · 地震：M6 @ 400km → 峰值约 15 点；M7 @ 300km → 约 27 点；M4.6 @ 650km
         （北京窗口里真实出现过的那次）→ 约 1.3 点。梯度合理：小震就该几乎看不出来。
       · 台风：45m/s 从 300km 外压过来 → 峰值约 40 点，随距离自然涨落（不额外加余波）。
         北京窗口里真实台风全在 900km 外，所以台风项是 0 —— 这是对的，台风不去北京。
       · 空气：PM2.5 抬到 p90（123）→ +10 点左右；爆表（200+）→ +20 点。
       · 预报：实测−预报落到 2σ → 约 ±16 点（first-cut 取 7 时到过 ±60，太猛，砍到 2）。 */

  const LEVS = [
    { v: 1,   n: '1×',   t: '稳健',   cls: '' },
    { v: 5,   n: '5×',   t: '激进',   cls: '' },
    { v: 10,  n: '10×',  t: '疯狂',   cls: 'lev-danger' },
    { v: 20,  n: '20×',  t: '天台',   cls: 'lev-danger' },
    { v: 50,  n: '50×',  t: '天台没护栏', cls: 'lev-danger' },
    { v: 100, n: '100×', t: '久留美', cls: 'lev-danger' }
  ];

  /* ═══════════════ 运行状态 ═══════════════ */
  const G = {
    open: false,
    running: false,
    ended: false,
    city: null,
    series: [],       // [{ t, o, h, l, c }]，长度 roundBars()
    seeds: [],        // 每根的真实天气读数（CAPE / 阵风 / 降水 / 天气码 / 露点 / 盘子扰动）
    sev: null,        // 本局窗口的本地恶劣度序列（天气日历用）
    regLine: null,    // 区域大盘线（本局窗口那一截）；拿不到大盘时为 null
    regFrom: 0,       // 上面那条线在原始 92 天序列里的起点下标
    regCities: null,  // 组成大盘的城市名
    base: null,       // 15 分钟原样序列（局中换 K 线周期时重采样用）
    baseSeeds: null,
    baseReg: null,
    i: 0,
    price: 0,
    cash0: DEF_CASH,  // 本局本金（开场卡片里可改，局中不可改）
    cash: DEF_CASH,
    pos: 0,           // 净持仓手数，正 = 多
    avg: 0,           // 持仓均价（指数点）
    lev: 10,
    pct: 30,
    speedIdx: 2,
    barIdx: 2,        // K 线周期档位下标（BAR_MIN / BAR_N），默认 15 分钟
    timer: null,
    acc: 0,           // 帧间小数累加器：每帧推进不足一根时的余量（见 tick）
    peak: DEF_CASH,
    maxDD: 0,
    trades: 0,
    slipPaid: 0,      // 本局累计滑点成本（元）—— 本金越大、城市越小，这个数越肉疼
    feePaid: 0,       // 本局累计手续费（元）
    fills: [],        // 最近 5 笔成交，新的在前
    orders: [],       // 挂单：限价 { kind:'limit', dir, price, lots } / 止损止盈 { kind:'sl'|'tp', price }
    orderSeq: 0,
    sev: null,        // 本局的 severity 切片（天气日历要提前看"什么时候变天"）
    hist: [],
    liveOn: false,    // live bar 当前是否会显示（图表已按它画过）—— 控制 10Hz 局部重绘
    hoverIdx: null,   // 鼠标停在图表第几根上；非 null 时盘中重绘不抢左上角读数
    liqPrice: null,
    liqAt: 0,
    sound: true,
    main: null,
    eqc: null,
    seeds: null,      // 这一局的原始天气分量（做闪报用）
    lastNews: ''
  };

  /* 标定开关：打开后 pickSeries 会把每一项分量记进 dbgComp（见 tools/analyze_crypto.py）。
     平时为 false，行为与以前完全一致。 */
  let DBG_COMP = false;

  /* 插针倍率：只在调试时放大，用来**验收**插针。
     正常每局才 1.4 次，刷新页面几十秒里很可能一次都碰不上 —— 那就没法验。
     带上 `?spike=800` 之后每根 K 线都在打针，一眼能看到"影线远大于实体"的形态。 */
  function spikeMul() {
    try {
      return /[?&]spike=(\d+)/.test(global.location.search)
        ? Math.max(1, Math.min(5000, +RegExp.$1)) : 1;
    } catch (e) { return 1; }
  }

  // flat 跟着主站的 `--flat` 走（readTheme 会覆盖这个兜底值）——
  // 使用者要求"持平的灰色改为绿色"，游戏里的平盘蜡烛也跟着变。
  // ⚠ dim 仍然是灰的，那是**次要文字颜色**，跟"平盘色"是两件事，别一起改。
  const THEME = { up: '#ff4d4f', down: '#00b578', flat: '#00b578', ac: '#ffb74d', line: '#262b36', dim: '#8b919e', fg: '#e6e9ef' };
  function readTheme() {
    try {
      const s = getComputedStyle(document.body);
      const g = k => (s.getPropertyValue(k) || '').trim();
      if (g('--up')) THEME.up = g('--up');
      if (g('--down')) THEME.down = g('--down');
      if (g('--flat')) THEME.flat = g('--flat');
      if (g('--accent')) THEME.ac = g('--accent');
    } catch (e) { }
  }

  /* ═══════════════ 数字格式化 ═══════════════ */
  const n0 = v => (isFinite(v) ? Math.round(v) : 0).toLocaleString('en-US');
  const n1 = v => (isFinite(v) ? v : 0).toFixed(1);
  const n2 = v => (isFinite(v) ? v : 0).toFixed(2);
  function money(v) {
    const neg = v < 0;
    return (neg ? '-' : '') + '¥' + n0(Math.abs(v));
  }
  function sgnMoney(v) { return (v >= 0 ? '+' : '-') + '¥' + n0(Math.abs(v)); }
  function colorOf(v) { return v > 0 ? THEME.up : v < 0 ? THEME.down : THEME.flat; }

  /* ═══════════════ 账户数学 ═══════════════
     注意这里价格是「指数点」，不是摄氏度。合约规格：
     1 手 × 指数每动 1 点 = LOT_MULT 元。 */
  function marginUsed() { return G.pos ? Math.abs(G.pos) * G.avg * LOT_MULT / G.lev : 0; }
  function unreal() { return G.pos ? G.pos * (G.price - G.avg) * LOT_MULT : 0; }
  function equity() { return G.cash + unreal(); }
  /** 挂着的限价单锁掉的那部分保证金 —— 真券商就是这么算的，不然可以无限挂单把仓位吹到天上去 */
  function reservedMargin() {
    return G.orders.reduce((s, o) => s + (o.kind === 'limit' ? o.lots * o.price * LOT_MULT / G.lev : 0), 0);
  }
  function freeEq() { return equity() - marginUsed() - reservedMargin(); }
  function maxLots() { const m = G.price * LOT_MULT / G.lev; return m > 0 ? Math.floor(Math.max(0, freeEq()) / m) : 0; }
  /** 强平价：解 equity = marginUsed × MAINTAIN */
  function liqPriceOf() {
    if (!G.pos) return null;
    return G.avg + (Math.abs(G.pos) * G.avg * LOT_MULT / G.lev * MAINTAIN - G.cash) / (G.pos * LOT_MULT);
  }

  /**
   * 照现在的仓位比例下单的话，价格反向走多少就爆仓（百分数）。
   *
   * 这把「杠杆」和「仓位」两件事合成了一个数字 —— 这才是新手真正需要看的东西：
   * 满仓 20 倍是 4.5%，30% 仓位 20 倍是 16.2%，满仓 100 倍只有 0.9%。
   * 推导：开仓后现金 C、保证金 M = 手数·价·LOT/N，
   * 爆仓时 C + 手数·Δp·LOT = M·MAINTAIN  →  Δp = (M·MAINTAIN − C)/(手数·LOT)
   * 这个做法照 bilibili「FX 简单!」的下单卡搬的（它写「约可承受反向波动 4.00%」）。
   * 返回 null 表示连 1 手都开不出来。
   */
  function tolerablePct(pct) {
    if (!G.price) return null;
    const lots = Math.floor(maxLots() * pct / 100);
    if (lots < 1) return null;
    const M = lots * G.price * LOT_MULT / G.lev;
    const dp = (M * MAINTAIN - G.cash) / (lots * LOT_MULT);
    if (dp >= 0) return 0;                       // 开出来就已经在爆仓线下面了
    return Math.min(999, Math.abs(dp) / G.price * 100);
  }

  /* ═══════════════ 成交 ═══════════════ */
  /**
   * 这一单要吃掉多少滑点（指数点）。
   *
   * 这是我给"本金"加的第一根真杠杆 —— 在那之前，本金翻 10 倍只是手数翻 10 倍，
   * 盈亏**比例**一模一样，换句话说改本金等于没改。加上滑点之后就变了：
   * 单子的名义金额越大，越难在你要的价位全部成交。
   *
   *   名义金额 = 手数 × 价格 × LOT_MULT
   *   盘子容量 = CAP_BASE × (1 / dishScale(城市))      ← 小地方盘子小
   *   滑点(点) = SLIP_K × 名义金额 / 盘子容量
   *
   * 因为名义金额 ∝ 本金，所以**滑点占本金的比例随本金线性上升** ——
   * 30 万本金在广州市价约 0.09%，300 万就是约 0.9%，而且换到惠州还要再乘 2.6。
   * 钱多不等于好做，这一点是真券商天天在教的。
   *
   * `dishScale` 复用"盘子扰动"那套行政层级分档（见 cityWeight），不再单独造一个。
   */
  function slipOf(lots, px) {
    // 开场卡片上算这笔账时一局还没开始、G.price 还是 0，这时按基准点数估 ——
    // 不兜住的话 tip 会算出「滑点 ¥0」，把成本说小一大截（真踩过）。
    const p = (px > 0) ? px : (G.price > 0 ? G.price : BASE);
    // 没有城市时盘子按"中等"算。**不能直接 dishScale(null)** ——
    // cityWeight(null) 返回 1，dishScale 于是给出 1.6，开场卡片上的预估就凭空胖 60%。
    const ds = G.city ? (dishScale(G.city) || 1) : 1;
    const cap = CAP_BASE / ds;
    const raw = SLIP_K * Math.abs(lots) * p * LOT_MULT / cap;
    return Math.min(SLIP_MAX, raw);
  }

  /**
   * 按指定价成交。`p` 默认是最新价，但挂单必须按"挂的那个价"成交 —— 那正是挂单的意义。
   *
   * `useSlip` 决定这一单吃不吃滑点：
   *   - **市价单**（做多 / 做空 / 一键平仓）吃 —— 你是在向市场要流动性；
   *   - **止损止盈也吃** —— 止损触发时本质就是市价单，"插针时滑点最狠"正是真券商的日常抱怨；
   *   - **限价单不吃** —— 限价单的意义是"要么按我的价成交，要么别成交"，
   *     真实世界里的代价是**可能根本不成交**，这里如实照搬。
   *
   * 手续费有两档（对齐参考软件里那句"单笔不足 5 元按 5 元收取"）：
   * 名义金额 × 万分之五，但**不足 FEE_MIN 就按 FEE_MIN 收**。
   * 大资金感觉不到，小资金会明显更贵 —— 这是本金第二根真杠杆。
   */
  function applyFillAt(q, p, useSlip) {
    if (!q) return;
    const raw = (p > 0) ? p : G.price;
    const slip = (useSlip === false) ? 0 : slipOf(q);
    // 买入吃在更高的价、卖出砸在更低的价 —— 方向永远对自己不利
    p = raw + (q > 0 ? slip : -slip);
    const old = G.pos;
    const notional = Math.abs(q) * p * LOT_MULT;
    const fee = Math.max(FEE_MIN, notional * FEE_RATE);
    if (old === 0) {
      G.avg = p;
    } else if ((old > 0) === (q > 0)) {
      G.avg = (Math.abs(old) * G.avg + Math.abs(q) * p) / (Math.abs(old) + Math.abs(q));
    } else if (Math.abs(q) <= Math.abs(old)) {
      G.cash += -q * (p - G.avg) * LOT_MULT;
    } else {
      G.cash += old * (p - G.avg) * LOT_MULT;
      G.avg = p;
    }
    G.cash -= fee;
    G.pos = old + q;
    if (!G.pos) G.avg = 0;
    G.trades++;
    G.slipPaid = (G.slipPaid || 0) + Math.abs(q) * slip * LOT_MULT;
    G.feePaid = (G.feePaid || 0) + fee;
    // 仓位平掉之后，挂在它上面的止损止盈就没意义了
    if (!G.pos) G.orders = G.orders.filter(o => o.kind === 'limit');
    // 成交记录（最近 5 笔，新的在上）
    const kind = old === 0 ? (q > 0 ? '开多' : '开空')
      : (G.pos === 0 ? '平仓'
        : ((old > 0) === (q > 0) ? (q > 0 ? '加多' : '加空') : (q > 0 ? '减空' : '减多')));
    G.fills.unshift({ at: G.i, kind: kind, lots: Math.abs(q), px: p, fee: fee });
    if (G.fills.length > 5) G.fills.length = 5;
  }
  function applyFill(q) { applyFillAt(q, G.price); }

  /* ═══════════════ 挂单 ═══════════════ */
  /**
   * 限价开仓单：价格碰到 `price` 就按**这个价**开仓（不是按最新价 —— 那才是挂单的意思）。
   * 下单时就把它要占的保证金锁掉，所以不能靠挂单把仓位吹到天上去。
   */
  function placeLimit(dir, price, lots) {
    price = +price; lots = Math.floor(+lots);
    if (!(price > 0)) return '价格没填';
    if (!(lots >= 1)) return '手数至少 1';
    const need = lots * price * LOT_MULT / G.lev;
    if (need > freeEq() + 1e-6) return '可用保证金不够（要 ' + money(need) + '）';
    G.orders.push({ id: ++G.orderSeq, kind: 'limit', dir: dir > 0 ? 1 : -1, price: price, lots: lots });
    return null;
  }

  /** 止损 / 止盈挂在当前持仓上，碰到就把整个仓位平掉（跟真券商一样，不记手数） */
  function setStop(kind, price) {
    price = +price;
    if (!(price > 0)) return '价格没填';
    if (!G.pos) return '现在没有持仓';
    G.orders = G.orders.filter(o => o.kind !== kind);
    G.orders.push({ id: ++G.orderSeq, kind: kind, price: price });
    return null;
  }

  function cancelOrder(id) { G.orders = G.orders.filter(o => o.id !== id); }

  /**
   * 这一根 K 线里哪些挂单被碰到了。
   *
   * 判定用「上一根收盘 → 本根收盘」这条线段，再加本根的上下影线 ——
   * 光看收盘价的话，插针把你止损扫掉的情形就永远模拟不出来。
   * 同一根里有好几个价位被碰到时，按「离上一根收盘的距离」排序逐个成交：
   * 价格是从上一根收盘一路走过来的，先碰到的先成交，这才符合直觉。
   *
   * `silent` 是给离线追赶用的（见 stepBars）：补推几十根的时候不能每笔都飘字、都响一声。
   */
  function processOrders(prevPx, silent) {
    if (!G.orders.length || !G.series[G.i]) return;
    const bar = G.series[G.i];
    const lo = Math.min(prevPx, G.price, bar.l);
    const hi = Math.max(prevPx, G.price, bar.h);
    const hits = G.orders.filter(o => o.price >= lo && o.price <= hi);
    if (!hits.length) return;
    hits.sort((a, b) => Math.abs(a.price - prevPx) - Math.abs(b.price - prevPx));
    for (const o of hits) {
      if (G.orders.indexOf(o) < 0) continue;   // 前面的成交可能已经把它带走了
      if (o.kind === 'limit') {
        // 限价单不吃滑点：要么按我的价成交，要么别成交
        applyFillAt(o.dir * o.lots, o.price, false);
        if (!silent) {
          floatText('限价成交 ' + (o.dir > 0 ? '多' : '空') + ' ' + o.lots + ' 手 @ ' + n1(o.price), o.dir > 0 ? THEME.up : THEME.down, 12);
          beep(o.dir > 0 ? 660 : 440, .08, 'triangle', .04);
        }
      } else if (G.pos) {
        const q = -G.pos;
        // 止损止盈本质是市价单，滑点照吃 —— 插针时被扫得最惨的就是它们
        applyFillAt(q, o.price);
        if (!silent) {
          floatText((o.kind === 'sl' ? '止损触发 @ ' : '止盈触发 @ ') + n1(o.price), o.kind === 'sl' ? THEME.down : THEME.up, 13);
          beep(o.kind === 'sl' ? 300 : 900, .16, 'sine', .05);
        }
      }
      G.orders = G.orders.filter(x => x.id !== o.id);
    }
  }

  function liquidate() {
    const p = G.price;
    G.liqPrice = p;
    G.liqAt = G.i;
    G.cash += G.pos * (p - G.avg) * LOT_MULT;
    G.cash = Math.max(0, G.cash);
    G.pos = 0; G.avg = 0;
    G.hist[G.hist.length - 1] = G.cash;
  }

  /* ═══════════════ 指数构造 ═══════════════ */
  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const h = b.length >> 1;
    return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
  }
  /** 中位绝对偏差 → 稳健标准差。用 min/max 归一化的话，一次台风就把后面全压扁了。 */
  function robustScale(a, m) {
    const d = a.map(v => Math.abs(v - m));
    return (1.4826 * median(d)) || 1;
  }

  /** 城市当地"现在"的 'YYYY-MM-DDTHH:MM'，用来切出预报段 */
  function nowLocalStr(city) {
    const d = API.cityNow(city);
    const u = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return u.toISOString().slice(0, 16);
  }

  /* 省会名单（含自治区首府）。**写死是故意的** —— 靠"市名以省名开头"去猜是猜不准的：
     实测那条规则只命中 3 座（名字正好等于省名的），广州/杭州/成都/武汉 全漏，
     于是 352 城里 305 座权重完全一样，"大城市稳、小城市野"这个梯度形同不存在。 */
  const CAPITALS = {
    '石家庄': 1, '太原': 1, '呼和浩特': 1, '沈阳': 1, '长春': 1, '哈尔滨': 1,
    '南京': 1, '杭州': 1, '合肥': 1, '福州': 1, '南昌': 1, '济南': 1, '郑州': 1,
    '武汉': 1, '长沙': 1, '广州': 1, '南宁': 1, '海口': 1, '成都': 1, '贵阳': 1,
    '昆明': 1, '拉萨': 1, '西安': 1, '兰州': 1, '西宁': 1, '银川': 1, '乌鲁木齐': 1
  };

  /**
   * 这个城市有多"大"。决定**盘子深浅**和**波动放大倍数**。
   *
   * 档位照着真实数据集的构成定（352 城实测 4 / 27 / 305 / 40 城）：
   *   3.0 直辖市(4) ｜ 2.2 省会·首府(27) ｜ 1.6 有国家站的地级市(305) ｜ 0.6 其余(40)
   *
   * ⚠ 两个历史坑，都是量出来才发现的：
   *   ① 老版本用「市名以省名开头」认省会 → 只命中 3 城，305 座城权重全等；
   *   ② 还挂着一条 `if (c.path) return 1.2`，而 cities.json 里**每座城都有 path**，
   *      所以那一档是死代码、一次都走不到（README 里"有 path 的 1.2"就是它）。
   */
  function cityWeight(c) {
    if (!c) return 1;
    const p = String(c.prov || ''), nm = String(c.name || '');
    if (/^(北京市|上海市|天津市|重庆市)$/.test(p)) return 3.0;   // 直辖市
    if (CAPITALS[nm]) return 2.2;                               // 省会 / 自治区首府
    if (c.cma) return 1.6;                                      // 有国家站的地级市
    return 0.6;                                                 // 区县 / 没站的地方
  }
  /** 盘子深浅：小地方容量小，同样的单子冲击更大（用于滑点、盘子扰动振幅） */
  function dishScale(c) {
    const w = cityWeight(c);
    return Math.max(0.35, Math.min(2.6, 1.6 / w));
  }

  /* ── 城市 → 波动放大倍数 ──
     这才是"大城市像主流币、小城市像山寨币"的**载体**。

     真实基准（欧易 9 个对 × 365 天 × 15 分钟，tools/analyze_crypto.py 量的）：
       最稳的 BTC  单根 |涨跌| 中位 0.0822%
       最野的 WIF              中位 0.2541%
       → 放大 **3.09×**：这是可以量的，不用拍。

     而旧模型里**只有 dish 一项**受城市影响（它只占波动方差的 ~4%），
     noise / carry / micro / 四个压力源全与城市无关 —— 实测梯度因此被稀释成 1.78×。
     所以把 cityAmp 乘到**所有随机项**上，梯度才立得住。

     两个系数是反推的，不是凑的：
       ① 梯度目标 2.52×（BTC→WIF 的 3.09× 打八二折：游戏最小只到区县，
          真实还有比 WIF 更小的币，留余量）
       ② 中位那档（地级市，dishScale = 1.0）的 cityAmp 归一到 1.0
     解得 P.CITY_AMP_A = ln(2.52)/ln(2.6/0.533) ≈ 0.577，P.CITY_K 再把水平拉回 1.0。 */
  function cityAmp(c) {
    return P.CITY_K * Math.pow(dishScale(c), P.CITY_AMP_A);
  }

  /* ── 舒适度的六个维度 ──
     每个维度给出：**当前值**（人看得懂的物理量）、**得分**（0~100，这一段的好坏）、
     **贡献**（它把指数推了多少点）。三者都留着，是为了多维压力表要显示
     "现在多少 → 什么状态 → 推了指数多少"。

     `contrib = 权重 × 得分`，而 comfort = Σ contrib —— **这一条是硬约束**，
     面板上六行加起来必须**恰好等于**指数那边的舒适度，否则它就是装饰性数字。
     所以 comfort() 只做求和，不再单独算一遍（两条路径共用一份计算，
     不会出现"面板说的"和"指数走的"对不上）。 */
  const DIMS = [
    { key: 'temp',  nm: '气温',  unit: '℃',   w: 0.34, fmt: v => v.toFixed(1) },
    { key: 'dew',   nm: '湿度',  unit: '℃',   w: 0.15, fmt: v => v.toFixed(1) },
    { key: 'prec',  nm: '降水',  unit: 'mm',  w: 0.21, fmt: v => v.toFixed(2) },
    { key: 'wcode', nm: '天气',  unit: '',    w: 0.20, fmt: v => WCODE_N[v | 0] || ('码 ' + (v | 0)) },
    { key: 'gust',  nm: '阵风',  unit: 'km/h', w: 0.05, fmt: v => v.toFixed(0) },
    { key: 'air',   nm: '空气',  unit: 'µg',  w: 0.05, fmt: v => v.toFixed(0) }
  ];
  const WCODE_N = {
    0: '晴', 1: '基本晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛雨', 57: '冻毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
    95: '雷暴', 96: '雷暴夹雹', 99: '强雷暴'
  };

  /** 分段线性折线：points = [[x, y], ...]，x 必须递增；两端按端点值外推。
   *  用连续折线而不是硬阈值 —— 硬阈值会让指数在阈值附近来回抖。 */
  function ramp(x, pts) {
    if (x == null || !isFinite(x)) return 0;
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  }

  /**
   * 逐维度的舒适度分解。返回长度 = 时间点数的数组，每项是：
   *   { temp:{v,score,contrib}, dew:{...}, prec:{...}, wcode:{...}, gust:{...}, air:{...},
   *     total }
   * 其中 `total === Σ contrib`，就是 comfort 的值。
   *
   * @param mn  minutely_15 分量（temp/gust/precip/wcode/dew 数组）
   * @param pm25 可选的 PM2.5 数组（按小时对齐后传入），缺了空气项就不参与
   */
  function comfortParts(mn, pm25) {
    const n = mn.time.length;
    const T = mn.temp, Gs = mn.gust, Pr = mn.precip, W = mn.wcode, Dw = mn.dew || [];
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = T[i] == null ? 24 : +T[i];
      const g = Gs[i] == null ? 0 : +Gs[i];
      const p = Pr[i] == null ? 0 : +Pr[i];
      const wc = W[i] | 0;
      const d = Dw[i] == null ? t - 8 : +Dw[i];          // 露点缺了就按"干爽"估

      // 体感温度：22~27℃ 满分，往两边掉
      const sT = ramp(t, [[-5, 0], [0, 10], [8, 40], [16, 80], [22, 100], [27, 100],
                          [31, 70], [35, 35], [40, 0], [45, 0]]);
      // 湿度：露点 <16 干爽，>24 闷得难受
      const sD = ramp(d, [[0, 100], [10, 100], [16, 95], [20, 75], [24, 40], [27, 15], [30, 0]]);
      // 降水：15 分钟累计。0.2mm 已是小雨，2mm 是暴雨级
      const sP = ramp(p, [[0, 100], [0.05, 90], [0.3, 65], [0.8, 40], [2, 15], [5, 0], [20, 0]]);
      // 天气码：0/1 晴、2/3 多云、45+ 雾、5x 毛毛雨、6x 雨、7x 雪、8x 阵雨、9x 雷暴
      const sW = wc === 0 ? 100 : wc === 1 ? 95 : wc === 2 ? 85 : wc === 3 ? 78
        : (wc === 45 || wc === 48) ? 55
        : (wc === 51 || wc === 53 || wc === 55) ? 65
        : (wc === 56 || wc === 57) ? 45
        : (wc === 61 || wc === 63) ? 35 : (wc === 65) ? 10
        : (wc === 66 || wc === 67) ? 8
        : (wc === 71 || wc === 73 || wc === 75 || wc === 77) ? 25
        : (wc === 80 || wc === 81) ? 40 : (wc === 82) ? 12
        : (wc === 85 || wc === 86) ? 20
        : (wc === 95) ? 6 : (wc === 96 || wc === 99) ? 0 : 60;
      // 阵风：和风无感，超过 40km/h 开始碍事，80+ 有危险
      const sG = ramp(g, [[0, 100], [15, 98], [25, 88], [40, 62], [60, 28], [80, 10], [110, 0]]);
      // 空气：PM2.5 <35 优、75 以上差、150+ 重霾
      const hasAir = !!(pm25 && pm25[i] != null);
      const sA = hasAir
        ? ramp(+pm25[i], [[0, 100], [15, 98], [35, 85], [55, 65], [75, 45], [110, 25], [150, 10], [250, 0]])
        : 85;

      const cT = 0.34 * sT, cD = 0.15 * sD, cP = 0.21 * sP;
      const cW = 0.20 * sW, cG = 0.05 * sG, cA = 0.05 * sA;
      out[i] = {
        temp:  { v: t,  score: sT, contrib: cT },
        dew:   { v: d,  score: sD, contrib: cD },
        prec:  { v: p,  score: sP, contrib: cP },
        wcode: { v: wc, score: sW, contrib: cW },
        gust:  { v: g,  score: sG, contrib: cG },
        air:   { v: hasAir ? +pm25[i] : null, score: sA, contrib: cA, missing: !hasAir },
        total: cT + cD + cP + cW + cG + cA
      };
    }
    return out;
  }

  /** ── 天气舒适度：这个标的的"基本面"──
   *  指数在语义上就是**当地天气的好坏程度**，所以需要一个有绝对含义的标尺：
   *
   *      100 = 最舒服（温和、干爽、无雨、无雷暴、风小、空气干净）
   *        0 = 最难受（极端气温、暴雨、雷暴、狂风、重霾）
   *
   *  ⚠ 这和原来的 severity() 是**两种东西**，别混：
   *    · severity 是「对中位数的稳健标准差」→ **零中心的异常度**，只表达"偏离常态多少"，
   *      晴天雨天都可能 +2 或 −2，**没有好坏方向**。原来的指数就是靠它驱动的。
   *    · comfort 是**绝对好坏**（有方向的、非负的），好天气一定比坏天气高。
   *    改成 comfort 之后指数才有语义：**指数高 = 天气好，指数低 = 天气差**。
   *
   *  ⚠ 这里**只做求和**，每个维度怎么算全在 comfortParts() 里 ——
   *    多维压力表要和指数对得上，就不能存在第二套算法。
   */
  function comfort(mn, pm25) {
    return comfortParts(mn, pm25).map(p => p.total);
  }

  /** 把 minutely_15 的原始分量压成一条「天气恶劣度」序列。
   *  ⚠ 现在它是 **comfort 的负增量**：天气变差 → severity 上升 → 指数下跌。
   *    这样"天气好坏"就有了方向，而下面价格模型里那些以 severity 为输入的项
   *    （噪声、跳变触发）语义不变，不用全部重写。
   *    保留原始定义（零中心异常度）的那部分仍然有用：它衡量"变化得有多剧烈"，
   *    正适合拿来触发突发行情。 */
  function severity(mn, pm25) {
    const n = mn.time.length;
    const cf = comfort(mn, pm25);
    /* 用**滑动中位数**而不是整段中位数：整段中位数会把"这一段整体偏热"吃掉，
       而滑动窗口保留慢变 —— 指数要能体现"这几天一直很闷"这种持续状态。 */
    const W = 96;                       // 96 根 = 1 天
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - W), b = Math.min(n, i + W + 1);
      const seg = cf.slice(a, b).sort((x, y) => x - y);
      const med = seg[seg.length >> 1];
      out[i] = -(cf[i] - med) / 10;     // 除以 10：让量级和原来的异常度接近
    }
    return out;
  }

  function ema(x, a) {
    const o = new Array(x.length);
    let v = x.length ? x[0] : 0;
    for (let i = 0; i < x.length; i++) { v = a * x[i] + (1 - a) * v; o[i] = v; }
    return o;
  }

  /** 两点间大圆距离（公里）。台风/地震都按"离城市多远"折算影响。 */
  function distKm(la1, lo1, la2, lo2) {
    const R = 6371, rad = Math.PI / 180;
    const dla = (la2 - la1) * rad, dlo = (lo2 - lo1) * rad;
    const a = Math.sin(dla / 2) * Math.sin(dla / 2) +
      Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 确定性伪随机（[-1,1]）。用它而不是 Math.random()，是为了同一段行情
   *  在同一个周期下每次都长得一样 —— 否则探针跑两次结果对不上，没法验收。 */
  function zag(a, b) {
    const x = Math.sin((a * 131 + b * 17) * 12.9898) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }
  function fmtMin(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) +
      'T' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /** 把几根 15 分钟的天气读数并成一根粗 K 线的读数。
   *  取 max 的是"极值型"（阵风、CAPE、天气码），取平均的是"状态型"（PM2.5、露点、盘子），
   *  降水求和。地震/台风取这一段里最强的那次，并把它的名字/距离/震级带上。 */
  function aggSeed(g) {
    if (g.length === 1) return g[0];
    const o = {
      cape: 0, gust: 0, precip: 0, wcode: 0, dew: null, dish: 0,
      pm25: null, air: 0, quake: 0, qmag: 0, qplace: '', typh: 0, tname: '', tdist: 0, fcst: 0
    };
    let dp = 0, dn = 0, pm = 0, pn = 0, n = 0;
    for (let i = 0; i < g.length; i++) {
      const s = g[i]; n++;
      o.cape = Math.max(o.cape, s.cape || 0);
      o.gust = Math.max(o.gust, s.gust || 0);
      o.precip = +(o.precip + (s.precip || 0)).toFixed(1);
      o.wcode = Math.max(o.wcode, s.wcode || 0);
      if (s.dew != null) { dp += s.dew; dn++; }
      o.dish += s.dish || 0;
      if (s.pm25 != null) { pm += s.pm25; pn++; }
      o.air += s.air || 0;
      o.fcst += s.fcst || 0;
      if ((s.quake || 0) > o.quake) { o.quake = s.quake; o.qmag = s.qmag; o.qplace = s.qplace; }
      if ((s.typh || 0) > o.typh) { o.typh = s.typh; o.tname = s.tname; o.tdist = s.tdist; }
    }
    o.dew = dn ? +(dp / dn).toFixed(1) : null;
    o.dish = +(o.dish / n).toFixed(1);
    o.pm25 = pn ? Math.round(pm / pn) : null;
    o.air = +(o.air / n).toFixed(1);
    o.fcst = +(o.fcst / n).toFixed(2);
    o.quake = +(+o.quake).toFixed(2);
    o.typh = +(+o.typh).toFixed(2);
    o.qmag = +(+o.qmag || 0).toFixed(1);
    /* 多维压力表那四样：**取这一组里最后一根**，不是平均。
       面板显示的是"现在什么状态"，聚合档位下这一格代表的是这一段天气的**末端** ——
       取平均会把"刚转雷暴"和"雷暴要结束了"糊成同一个中间态，反而看不出方向。 */
    const last = g[g.length - 1];
    o.cparts = last.cparts; o.ctotal = last.ctotal;
    o.cpct = last.cpct; o.cdir = last.cdir;
    return o;
  }

  /** 把 15 分钟的基准序列重采样成玩家选的 K 线周期。
   *  **数据源只有 15 分钟**（Open-Meteo 的 minutely_15 就是最细的免费粒度了），所以：
   *    · 周期 ≥ 15 分钟 → **聚合**真数据（15 原样、30 并 2 根、45 并 3 根、60 并 4 根）
   *    · 周期 <  15 分钟 → **布朗桥展开**（1 分钟 = 摊成 15 根、5 分钟 = 摊成 3 根）
   *
   *  ### 展开为什么用布朗桥
   *  两根 15 分钟之间到底怎么走的，数据里没有 —— 这一段是**建模**的。
   *  早先用的是"开→收线性走 + 每根叠一个确定性小锯齿"，两个毛病：
   *    ① 锯齿幅度按父根振幅的固定比例分（`amp × 0.06`），所以**每根长得一样**，
   *       看着像心电图而不像行情；
   *    ② 最要命的：一条 15 分钟里直上直下时，15 根 1 分钟就是**一条直线** ——
   *       而真实盘面里 1 分钟级别**不可能**是直线，它在宏观方向上一定带来回试探。
   *
   *  布朗桥正好是这个问题的标准解法：**起点固定在父根开盘、终点固定在父根收盘**，
   *  中间按随机游走走。性质刚好对上：
   *    · 端点硬约束 → 聚合回 15 分钟**逐点不变**（这是最早那条不变量）
   *    · 中间自由 → 每一根都带真实的来回，且**每根形状都不同**
   *    · 桥的方差是 t(1−t) 形状（两头小、中间大）→ 天然像行情：
   *      刚开盘贴着上一根收、盘中来回最凶、快收盘又收敛
   *
   *  ### 幅度怎么定
   *  桥的步长按**父根振幅**缩放，再乘 `BRIDGE_K`。这样：
   *    · 平静的 15 分钟 → 内部也安静（振幅小）
   *    · 暴动的那根 → 内部剧烈来回
   *  也就是"内部波动跟着宏观波动走"，而不是所有档位一个固定幅度。 */
  function resample(series, seeds, regLine) {
    const barMin = BAR_MIN[G.barIdx];
    const out = [], sd = [], rg = [];
    if (barMin >= SRC_MIN) {
      const k = Math.round(barMin / SRC_MIN);
      for (let i = 0; i < series.length; i += k) {
        const g = series.slice(i, i + k);
        const o = g[0].o, c = g[g.length - 1].c;
        let hi = -Infinity, lo = Infinity, sp = 0, spd = 0;
        for (let q = 0; q < g.length; q++) {
          if (g[q].h > hi) hi = g[q].h;
          if (g[q].l < lo) lo = g[q].l;
          /* 插针**靶子**要跟着一起聚合：一组里最深的那根针决定这根的影线。
             取 max 而不是求和 —— 影线是"打到哪里"，不是把几根针叠起来。 */
          if ((g[q].spike || 0) > sp) { sp = g[q].spike || 0; spd = g[q].spikeDir || 0; }
        }
        out.push({ t: g[0].t, o: o, h: Math.max(hi, o, c), l: Math.min(lo, o, c), c: c,
                   spike: sp, spikeDir: spd });
        sd.push(aggSeed(seeds.slice(i, i + k)));
        if (regLine) rg.push(regLine[Math.min(regLine.length - 1, i + k - 1)]);
      }
      return { series: out, seeds: sd, regLine: regLine ? rg : null };
    }
    // ── 展开：每根 15 分钟摊成 m 根 ──
    const m = Math.round(SRC_MIN / barMin);
    const t0 = series.length ? Date.parse(series[0].t) : 0;
    for (let i = 0; i < series.length; i++) {
      const p = series[i], amp = Math.max(1e-6, p.h - p.l);
      const base = t0 + i * SRC_MIN * 60000;
      const r0 = regLine ? regLine[i] : 0;
      const r1 = regLine ? regLine[Math.min(regLine.length - 1, i + 1)] : 0;
      let prev = p.o;
      /* 父根那一针落在**哪一个子根**上：确定性地摊到展开段的前 1/3 里（用 zag 定），
         并且**只落一次** —— 否则 m 个子根各带一次针，聚合回 15 分钟就变成 m 倍。
         保证「展开 → 聚合」回到父根时插针总量对得上。 */
      const spSlot = p.spike > 0 ? Math.floor((zag(i, 313) * 0.5 + 0.5) * Math.max(1, Math.ceil(m / 3))) : -1;
      /* ── 布朗桥 ──
         先造一条 m 步的随机游走 w[0..m]，再把两端"钉"到 0（起点）和 0（终点偏移之和），
         于是 b[j] = w[j] − (j/m)·w[m] 满足 b[0] = 0 且 b[m] = 0。
         桥值乘上步长就是价格偏移，加到"开→收的直线"上：
           c_j = p.o + (p.c − p.o)·f + step · b[j]
         第 j = m−1 根时 b[m−1] ≠ 0，所以最后一根**仍然强制写成 p.c**，
         保证聚合回父根逐点相等（那条不变量不能破）。
         方差形状 t(1−t) 是桥自带的：两头小、中间大 —— 天然像行情。 */
      /* 随机游走用 **AR(1)** 而不是逐点独立的 zag：
         ⚠ 第一版写成 `w[j] = w[j-1] + zag(...)`，zag 前后独立 → 桥在原地高频抖，
           画出来是"锯齿"而不是"走一段再回头"。真实日内路径是有**动量**的：
           连着涨几根、再连着跌几根。AR(1) 的 rho 就是那个动量，
           0.55 大约连走 2~3 根同向。 */
      const w = new Array(m + 1);
      w[0] = 0;
      let drift = 0;
      for (let j = 1; j <= m; j++) {
        drift = drift * P.BRIDGE_RHO + zag(i * 131 + 7, j * 17 + 3) * (1 - P.BRIDGE_RHO);
        w[j] = w[j - 1] + drift;
      }
      const step = amp * P.BRIDGE_K / Math.sqrt(Math.max(1, m));
      for (let j = 0; j < m; j++) {
        const f = (j + 1) / m;
        const bridge = w[j + 1] - f * w[m];        // b[0]=0，b[m]=0
        let c = p.o + (p.c - p.o) * f + step * bridge;
        if (j === m - 1) c = p.c;                 // 收在父根收盘，聚合回去才对得上
        const o = prev;
        /* 影线：基础部分按"这根自己的涨跌"+ 桥的局部摆动，
           不再用父根振幅的固定比例 —— 那会让每根长得一模一样。 */
        let wk = Math.abs(c - o) * WICK_K + step * 0.35 * Math.abs(zag(i, j + 977));
        const isSpike = (j === spSlot);
        if (isSpike) wk += p.spike;
        out.push({
          t: fmtMin(base + j * barMin * 60000),
          o: o, h: Math.max(o, c) + wk, l: Math.min(o, c) - wk, c: c,
          spike: isSpike ? p.spike : 0, spikeDir: isSpike ? (p.spikeDir || 0) : 0
        });
        sd.push(seeds[i]);                        // 子根共用父根那份天气读数
        if (regLine) rg.push(+(r0 + (r1 - r0) * f).toFixed(2));
        prev = c;
      }
    }
    return { series: out, seeds: sd, regLine: regLine ? rg : null };
  }

  /** 从 minutely_15 里随机截一段真实历史，做成带 OHLC 的 K 线。
   *  extra = { air, quake, typh, fcst } 四个压力源的数据（缺了就传 null，对应项退化成 0） */
  function pickSeries(mn, reg, city, extra) {
    if (!mn || !mn.time || !mn.time.length) return null;
    const dbgComp = [];                       // 只在 DBG_COMP 为真时被填（标定用）
    const n = mn.time.length;
    let i0 = mn.time.findIndex(t => t >= nowLocalStr(city));
    if (i0 < 0) i0 = n;
    // 只用"现在"之前的：预报段不能拿来当已发生的行情
    const end = Math.max(2, Math.min(n, i0));
    // 一局 7 天 = 672 根 15 分钟**源**数据。基准序列永远按数据源粒度（15 分钟）算，
    // 算完再按玩家选的周期重采样（见 resample）—— 这样价格模型只有一套，
    // 不会出现"1 分钟档和 60 分钟档走势不一样"的怪事。
    const need = srcBars();
    if (end < need + 1) return null;

    /* ── 空气质量先对齐到 15 分钟时间轴 ──
       ⚠ 必须排在 comfort()/severity() **之前**：comfort 里的空气项要吃它。
       原来这段在对齐大盘之后，那时 severity 已经算完了 —— 顺序错了空气项就永远是缺省值。 */
    let airRaw = null;
    if (extra && extra.air && extra.air.time && extra.air.time.length) {
      const A = extra.air, am = {};
      for (let k = 0; k < A.time.length; k++) if (A.pm25[k] != null) am[A.time[k]] = +A.pm25[k];
      const hourOf = t => t.slice(0, 13) + ':00';      // "2026-10-05T13:45" → "2026-10-05T13:00"
      const vals = [];
      const raw = new Array(n).fill(null);
      for (let k = 0; k < n; k++) {
        const v = am[hourOf(mn.time[k])];
        if (v != null) { raw[k] = v; vals.push(v); }
      }
      // 覆盖不到一半就不认 —— 否则拿零星半小时的 PM2.5 去推整局，等于编数据
      if (vals.length > n * 0.5) airRaw = raw;
    }

    // 天气舒适度（有绝对好坏方向的"基本面"）+ 恶劣度（有方向的增量）
    const cf = comfort(mn, airRaw);
    const sev = severity(mn, airRaw);
    const tr = ema(sev, P.EMA_A);
    const now = nowLocalStr(city);

    // ── 区域大盘：同一个时间轴（两边都是 past_days=92 & 同一时区），按时间串对齐 ──
    let regSev = null, regTr = null, regMap = null;
    if (reg && reg.time && reg.time.length) {
      regMap = {};
      for (let k = 0; k < reg.time.length; k++) regMap[reg.time[k]] = k;
      // 拿本地这一局的时间轴去取大盘值，拼成等长的"虚拟城市"再套同一套 comfort()/severity()
      const rv = { time: [], temp: [], gust: [], precip: [], wcode: [], cape: [], dew: [] };
      for (let k = 0; k < n; k++) {
        const j = regMap[mn.time[k]];
        rv.time.push(mn.time[k]);
        rv.temp.push(j == null ? null : reg.temp[j]);
        rv.gust.push(j == null ? null : reg.gust[j]);
        rv.precip.push(j == null ? (0) : (reg.precip[j] == null ? 0 : reg.precip[j]));
        rv.wcode.push(j == null ? 0 : (reg.wcode[j] || 0));
        rv.cape.push(j == null ? null : reg.cape[j]);
      }
      // severity() 里对 null 是当 0 处理的，所以只有大盘真的对齐上了才算数
      let hit = 0;
      for (let k = 0; k < Math.min(200, n); k++) if (rv.cape[k] != null && rv.gust[k] != null) hit++;
      if (hit > 100) { regSev = severity(rv, null); regTr = ema(regSev, P.EMA_A); }
    }

    // ── 露点（湿热）项：真数据，15 分钟粒度 ──
    const D = (mn.dew && mn.dew.length ? mn.dew : []).map(v => (v == null ? null : +v));
    const dOk = D.filter(v => v != null);
    const mDew = dOk.length ? median(dOk) : 0, sDew = dOk.length ? robustScale(dOk, mDew) : 1;

    // ── 盘子扰动：带衰减的随机游走。小地方振幅更大（庄家操盘）──
    const dScale = dishScale(city) * P.DISH_K;

    // ══ 四个压力源：时刻 / 强度 / 位置全部来自真数据，只做"怎么折成点数"的建模 ══
    // 定位根号一律用**时间差**（barT0 与事件时刻都用同一个 Date.parse 口径），
    // 所以浏览器把 mn.time 当本地时间还是 UTC 解释都不影响结果。
    const BAR_MS = 900000;
    const barT0 = mn.time.length ? Date.parse(mn.time[0]) : 0;
    const idxOf = t => (barT0 && t) ? Math.round((t - barT0) / BAR_MS) : -1;

    /* ① 空气质量：已经在上面 comfort() 之前对齐好了（airRaw）。
       这里只把原始 PM2.5 归一化成零中心的 airN，给价格模型当**慢变量偏置**用 ——
       comfort 里的空气项是"绝对好坏"，这里的 airN 是"相对这段的中位"，两者用途不同。 */
    let airN = null;
    if (airRaw) {
      const vals = airRaw.filter(v => v != null);
      const mA = median(vals), sA = robustScale(vals, mA) || 1;
      airN = new Array(n).fill(0);
      for (let k = 0; k < n; k++) airN[k] = airRaw[k] == null ? 0 : (airRaw[k] - mA) / sA;
    }

    // ② 地震：事件型。每来一次就在对应根号上砸一记冲击，再按 QUAKE_DECAY 拖一段余波。
    //    按震中到城市的真实大圆距离衰减；超过 QUAKE_R 不计（与 api.js 的查询半径一致）。
    const qArr = new Array(n).fill(0);
    const qMag = new Array(n).fill(0), qPlace = new Array(n).fill('');
    if (extra && extra.quake && extra.quake.length && barT0 && city.lat != null) {
      for (const e of extra.quake) {
        const d = (e.mag || 0) - QUAKE_M0;
        if (d <= 0) continue;
        const i = idxOf(e.t);
        if (i < -160 || i >= n) continue;
        const dist = (e.lat != null) ? distKm(city.lat, city.lon, e.lat, e.lon) : 0;
        const near = Math.max(0, 1 - dist / QUAKE_R);
        if (near <= 0) continue;
        const amp = P.QUAKE_K * d * near;
        for (let j = Math.max(0, i); j < Math.min(n, i + 160); j++) {
          qArr[j] += amp * Math.pow(QUAKE_DECAY, j - i);
          // 播报要报"震级 + 震中"，所以顺手记下这一根上最强的那个事件
          if (+e.mag > qMag[j]) { qMag[j] = +e.mag; qPlace[j] = e.place || ''; }
        }
      }
    }

    // ③ 台风：持续过程，所以不像地震那样"砸一记再衰减"，而是**逐根算台风中心有多近**。
    //    路径点每 3~6 小时一个，按时间线性插值出中心位置，距离越近、风速越大，推得越高；
    //    台风压过来自然涨、走过去自然落，不需要额外加余波。
    const tArr = new Array(n).fill(0);
    const tName = new Array(n).fill(''), tWind = new Array(n).fill(0), tDist = new Array(n).fill(0);
    if (extra && extra.typh && extra.typh.length && barT0 && city.lat != null) {
      const byNum = {};
      for (const p of extra.typh) (byNum[p.num || '_'] = byNum[p.num || '_'] || []).push(p);
      for (const key in byNum) {
        const path = byNum[key].slice().sort((a, b) => a.t - b.t);
        if (!path.length) continue;
        const tA = +path[0].t, tB = +path[path.length - 1].t;
        for (let k = 0; k < n; k++) {
          const t = barT0 + k * BAR_MS;
          if (t < tA - 6 * 3600000 || t > tB + 6 * 3600000) continue;
          let lo = 0, hi = path.length - 1;
          while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (path[mid].t <= t) lo = mid; else hi = mid; }
          const a = path[lo], b = path[hi] || path[lo];
          const span = (b.t - a.t) || 1;
          const u = Math.max(0, Math.min(1, (t - a.t) / span));
          const la = a.lat + (b.lat - a.lat) * u, lo2 = a.lon + (b.lon - a.lon) * u;
          const w = (a.wind || 0) + ((b.wind || 0) - (a.wind || 0)) * u;
          const near = 1 - distKm(city.lat, city.lon, la, lo2) / TYPHOON_R;
          if (near > 0) {
            const add = P.TYPHOON_K * (w / 30) * near * near;   // 平方衰减，边缘影响小
            tArr[k] += add;
            if (add > tWind[k]) {                            // 播报取影响最大的那个台风
              tWind[k] = add;
              tName[k] = (path[lo].name || '') + (path[lo].num ? '' : '');
              tDist[k] = Math.round(distKm(city.lat, city.lon, la, lo2));
            }
          }
        }
      }
    }

    /* ⑤ 天文：月光与流星雨 —— 真值，全部本地推算、不联网（观星页那同一套 astro.js）
       ⚠ 口径必须说清楚，别让人以为这是编出来的剧情：
         · 月光 = 月相照明比 × 月亮是否在地平线上（`ASTRO.moonPhase` / `ASTRO.moonAlt`）。
         · 流星雨 = `ASTRO.showers` 那张 IMO 九场主要流星雨表（活动期 from/peak/to + ZHR），
           按峰值附近的高斯包络折成"相对强度"，再乘三个**真实可见度因子**：
             天文夜（太阳高度 < −18°）、晴空（无降水且不是阴/雾/雨雪）、无月（月亮落下或很细）。
         · **明确不建模辐射点高度** —— 那张表只有星座名、没有赤经赤纬，
           凭空补一组坐标就是编数据。真实每小时流量还要乘 sin(辐射点高度)，
           这里拿"天文夜"当近似：代价是后半夜权重偏低（多数流星雨辐射点后半夜最高），
           是保守，不是造假。 */
    const moonArr = new Array(n).fill(0);      // 月光强度 0~1（满月当空 = 1，月亮在地平线下 = 0）
    const metArr = new Array(n).fill(0);       // 流星雨强度（相对 ZHR 150 归一，已含余波衰减）
    const metRaw = new Array(n).fill(0);       // 衰减前的原始强度（给 biasedStart 挑窗口用）
    const metName = new Array(n).fill('');
    /* ── 天文家族第二批（2026-10-09「戏剧性优先」那一轮）──
       使用者原话：「模拟游戏要的不是真实而是戏剧性，要刺激」。
       所以天文模块里**每一页的每一个变数**在这里都有一个通道，全部 0~1 归一。
       先归一再乘系数（P 表那一段）是关键：这样"戏剧性"只由系数大小决定，
       不会出现某个通道因为量纲不同偷偷主导整条曲线。 */
    const supArr   = new Array(n).fill(0);   // 超级月亮（近地点 + 近满月）
    const galArr   = new Array(n).fill(0);   // 银心高度（银河能拍多好）
    const starArr  = new Array(n).fill(0);   // 头顶亮星 + 行星数量
    const nightArr = new Array(n).fill(0);   // 天文夜占比（太阳低于 −18° 的比例）
    const sprArr   = new Array(n).fill(0);   // 大潮（朔望）↔ 小潮（两弦）
    const lpArr    = new Array(n).fill(0);   // 城市光污染 1~9 级 → 0~1
    const kpArr    = new Array(n).fill(0);   // 地磁暴（NOAA 实测 Kp / 9）
    if (global.ASTRO && city && city.lat != null && city.lon != null && barT0) {
      const A = global.ASTRO;
      const localMs = (y, md) => new Date(y, md[0] - 1, md[1], 12, 0, 0).getTime();
      const baseYear = new Date(barT0).getFullYear();
      const spans = [];
      for (const sh of (A.showers || [])) {
        for (const base of [baseYear - 1, baseYear, baseYear + 1]) {
          /* 活动期可能**跨年**（象限仪座 from 12/28 → peak 1/3 → to 1/12）。
             所以三端要各自校正：峰值早于起点说明起点在上一年，结束早于峰值说明结束在下一年。 */
          let from = localMs(base, sh.from), peak = localMs(base, sh.peak), to = localMs(base, sh.to);
          if (peak < from) peak = localMs(base + 1, sh.peak);
          if (to < peak) to = localMs(base + 1, sh.to);
          if (from > peak) from = localMs(base - 1, sh.from);
          spans.push({ nm: sh.name, zhr: sh.zhr || 10, from: from, peak: peak, to: to });
        }
      }
      for (let k = 0; k < n; k++) {
        const t = barT0 + k * BAR_MS;
        const mAlt = A.moonAlt(t, city.lat, city.lon);
        const illum = A.moonPhase(t).illum || 0;
        const moonUp = mAlt > 0;
        moonArr[k] = moonUp ? illum : 0;
        if (A.sunAlt(t, city.lat, city.lon) >= -18) continue;   // 不是天文夜
        const wcv = mn.wcode[k] | 0, pv = +(mn.precip[k] || 0);
        const sky = pv > 0 ? 0 : (wcv <= 1 ? 1 : wcv === 2 ? 0.75 : wcv === 3 ? 0.35 : 0);
        if (sky <= 0) continue;                                  // 阴/雾/雨雪 → 看不见流星
        const moonGate = moonUp ? Math.max(0, 1 - illum) : 1;    // 满月当空基本看不到暗流星
        let best = 0, bestNm = '';
        for (const sp of spans) {
          if (t < sp.from || t > sp.to) continue;
          /* 包络用**固定 σ = 1.2 天**的正态：真实主要流星雨的核心就是一两夜，
             用"活动期一半 × 0.45"当 σ 会宽到两周（英仙座活动期 7/17~8/24），
             那样峰值夜和平淡夜差不多高，就没有"突发事件"可言了。
             只在活动期内非零（`sp.from ~ sp.to`），零点不连续但那是包的边界，无所谓。 */
          const env = Math.exp(-Math.pow(((t - sp.peak) / 86400000) / 1.2, 2));
          const v = (sp.zhr / 150) * env;
          if (v > best) { best = v; bestNm = sp.nm; }
        }
        if (best > 0) {
          metRaw[k] = best * sky * moonGate;
          metArr[k] = metRaw[k];
          metName[k] = bestNm;
        }
      }
      /* 余波：极大夜过去后行情还会回味一阵（跟地震那条 "砸一记再衰减" 同一个思路）。
         ⚠ 乘 `(1 - METEOR_DECAY)` —— 这是把"累加器"变成"加权平均"的关键一步。
           写成 `acc = acc*decay + metRaw[k]` 的话，输入持续为 1 时稳态是 1/(1-decay) = 66，
           于是 METEOR_K 16 会变成 361 点的项，直接把台风（33）和整条模型压过去。
           乘上之后 metArr 恒在 [0, 1]，`METEOR_K` 就是"最强那一夜的冲击点数"的字面意思。
           （这个是探针量出来的：第一版 meteor 峰值 361.34。） */
      let acc = 0;
      for (let k = 0; k < n; k++) {
        acc = acc * P.METEOR_DECAY + metArr[k] * (1 - P.METEOR_DECAY);
        metArr[k] = acc;
      }

      /* ── 第二批天文通道：还是同一把 ASTRO 解析式，**零新数据源** ──
         归一口径都写在这儿，以后改系数不用回头猜量纲：
         · 超级月亮 — moonDistance 近地点 356 400 / 远地点 406 700 km。
           (406700−d)/50300 取 **3 次方**：只有真贴近近地点才算"超级"，
           否则一年里四五个月都在 0.5 以上，稀缺性就没了。
           不是满月的近地点只是"大弦月"，肉眼没戏 → illum<0.9 打 0.25 折。
         · 银心高度 — 银心 RA 17h45m ≈ 266.4°、Dec −29.01°（asSky 里也是这么内联的），
           高度 / 60° 裁到 [0,1]。
         · 星空热闹度 — brightStars(…,8°) 个数 / 12 + 可见行星（高度>8°）数 / 5。
         · 天文夜占比 — 一根 K 线（15 分钟）切 5 段采样 sunAlt < −18° 的比例。
         · 大潮 — |cos(π·age/14.765)|：age=0（朔）与 14.77（望）得 1、7.38（弦）得 0，
           正好是"朔望大潮、两弦小潮"。
         · 光污染 — extra.lp 是 1~9 级（async，取数阶段就取好塞进来），(v−1)/8。
         · 地磁暴 — extra.kp 是 [{t, kp}]（NOAA 只有最近约 7 天），时间最近邻、kp/9。 */
      const GC_RA = 266.4, GC_DEC = -29.01;
      const kpAt = (function () {
        const arr = (extra && extra.kp && extra.kp.length) ? extra.kp.slice() : null;
        if (!arr) return function () { return 0; };
        arr.sort(function (a, b) { return a.t - b.t; });
        return function (t) {
          /* ⚠ 数据窗口之外必须返回 **0**，不能"夹到首/末值"。
             第一版写成 `t <= arr[0].t → arr[0].kp`，而 NOAA 只有最近约 7 天的 Kp，
             一局有 37 天 —— 于是**前面 30 天全被安上了第一格那个 Kp**，
             探针一眼看穿：地磁暴项 p50 与 max 都是 5.00（= Kp 1.0 × 5），
             整条通道变成了一个编出来的常数。没有观测就是没有。 */
          if (t < arr[0].t || t > arr[arr.length - 1].t) return 0;
          const last = arr[arr.length - 1];
          let lo = 0, hi = arr.length - 1;
          while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid; }
          /* ⚠ 最近邻而不是线性插值：Kp 是**三小时一格**的等级量，
             插值会造出 5.5 这种并不存在的等级，也会把一场 7 级暴抹成缓坡。 */
          const pick = (t - arr[lo].t) <= (arr[hi].t - t) ? arr[lo] : arr[hi];
          return Math.max(0, Math.min(1, pick.kp / 9));
        };
      })();
      /* 光污染是"这座城市"的属性（整局不变），所以只铺一个常数。
         ⚠ `LP.of()` 返回的是**记录**不是数字：{z:'7a', zMin, zMax, …}，
           `z` 的**首位数字**才是 1~9 级。直接 `+(extra.lp)` 会得 NaN，
           而 NaN 一旦进了 bias，整条曲线会全变 NaN —— 所以这里只认得出 1~9 才铺。 */
      if (extra && extra.lp) {
        const g = parseInt(String(extra.lp.z || ''), 10);
        if (g >= 1 && g <= 9) for (let k = 0; k < n; k++) lpArr[k] = (g - 1) / 8;
      }
      for (let k = 0; k < n; k++) {
        const t = barT0 + k * BAR_MS;
        const ph2 = A.moonPhase(t);
        const il2 = ph2.illum || 0;
        const md = A.moonDistance ? A.moonDistance(t) : null;
        if (md) {
          const near = Math.max(0, Math.min(1, (406700 - md) / (406700 - 356400)));
          /* 4 次方而不是 3 次方：月亮每 27.5 天就走一趟近地点，3 次方会让
             "近地点"占掉大半个月，只有 4 次方才把它压成"真的贴上去那几天"。 */
          supArr[k] = Math.pow(near, 4) * (il2 >= 0.9 ? 1 : 0.2);
        }
        const gc = A.azOf ? A.azOf(GC_RA, GC_DEC, t, city.lat, city.lon) : null;
        galArr[k] = gc ? Math.max(0, Math.min(1, (gc.alt || 0) / 60)) : 0;
        const bs = A.brightStars ? A.brightStars(t, city.lat, city.lon, 8) : [];
        const pl = A.planets ? A.planets(t, city.lat, city.lon) : [];
        let nPl = 0;
        for (const p of pl) if (p && ((p.up != null && p.up) || (p.alt != null && p.alt > 8))) nPl++;
        /* ⚠ 分母别给太小：第一版用 /12 与 /5，厦门这种纬度**每一根都撞到上限 1.0**，
           于是"星空点数" 8 局里 min = p50 = max = 3.00 —— 一个常数通道。
           探针里最该抓的就是这种"看着有、其实不动"的项。
           现在改成**加权和**（亮星 0.6 + 行星 0.4）而不是简单相加，
           这样两项各自留出余量，通道才会真的随夜变化。 */
        starArr[k] = Math.max(0, Math.min(1,
          (bs.length / 20) * 0.6 + (nPl / 6) * 0.4));
        let darkN = 0;
        for (let s5 = 0; s5 < 5; s5++) if (A.sunAlt(t + s5 * (BAR_MS / 5), city.lat, city.lon) < -18) darkN++;
        nightArr[k] = darkN / 5;
        sprArr[k] = Math.abs(Math.cos(Math.PI * (ph2.age || 0) / 14.765));
        kpArr[k] = kpAt(t);
      }
      /* 「天文夜占比」必须**平滑成季节量**再进模型：逐根的 0/1 是昼夜交替，
         不是"夜变长了"。不滑的话 nightTerm 每天穿两次阈值，播报会变成
         "长夜将至 ×37 次一局"（第一版实测就是 37 次）。
         24 小时（96 根）滑动平均之后它才是"这段日子夜里有多长"。 */
      {
        const W24 = 96, half = W24 >> 1;
        const raw = nightArr.slice();
        for (let k = 0; k < n; k++) {
          let s = 0, c = 0;
          for (let j = k - half; j <= k + half; j++) {
            const jj = (j < 0) ? 0 : (j >= n ? n - 1 : j);
            s += raw[jj]; c++;
          }
          nightArr[k] = s / c;
        }
      }
    }

    // ④ 预报偏离：实测气温 − 提前 24 小时发出的预报。报得越离谱，这根 K 线越"意外"。
    let fN = null;
    if (extra && extra.fcst && extra.fcst.time && extra.fcst.time.length) {
      const F = extra.fcst, fm = {};
      for (let k = 0; k < F.time.length; k++) {
        const a = F.act[k], f = F.fc1[k];
        if (a != null && f != null) fm[F.time[k]] = +a - +f;
      }
      const vals = [];
      const raw = new Array(n).fill(null);
      for (let k = 0; k < n; k++) {
        const v = fm[mn.time[k]];
        if (v != null) { raw[k] = v; vals.push(v); }
      }
      if (vals.length > n * 0.5) {
        const mF = median(vals), sF = robustScale(vals, mF) || 1;
        fN = new Array(n).fill(0);
        for (let k = 0; k < n; k++) fN[k] = raw[k] == null ? 0 : (raw[k] - mF) / sF;
      }
    }

    /* 回放窗口的事件偏置。
       纯随机会有个尴尬 —— 92 天里真来过台风、真震过，可随机截的那 7 天常常一个都没覆盖到，
       于是这几个压力源常年看不见（实测北京/广州十局里台风项 0 覆盖）。
       这里**不改成"每局必有事件"**（那就成安排好的剧情了，也就没有"你不知道这段是哪年月"），
       而是：一半的局挑"事件分最高"的那十天，另一半纯随机。
       事件分 = 这一窗里地震项 + 台风项 + **流星雨项**贡献的总量。 */
    function biasedStart(s, limit) {
      if (Math.random() >= 0.5) return s;
      let best = -1, bestSc = -1;
      for (let t = 0; t < 40; t++) {
        const c = Math.floor(Math.random() * (limit - need));
        let ok = true;
        for (let j = 0; j < need; j += 7) {           // 每 7 根抽一次就够判断有没有洞
          if (mn.time[c + j] >= now || mn.gust[c + j] == null || mn.cape[c + j] == null) { ok = false; break; }
        }
        if (!ok) continue;
        let sc = 0;
        /* 事件分：地震 + 台风 + **流星雨**（2026-10-09 加）。
           流星雨按 8 倍计入 —— 一场英仙座/双子座极大（metRaw ≈ 1）折成 8 分，
           与一记小震（|qArr| ≈ 10）同量级，"挑事件最多那十天"因此也会挑到流星雨夜。 */
        for (let j = 0; j < need; j += 4) {
          sc += Math.abs(qArr[c + j]) + Math.abs(tArr[c + j]) + metRaw[c + j] * 20 +
            Math.abs(kpArr[c + j]) * 2;
        }
        if (sc > bestSc) { bestSc = sc; best = c; }
      }
      // 没找到更好的（或者全都是 0）就退回原来那个
      return (best >= 0 && bestSc > 0.5) ? best : s;
    }

    for (let k = 0; k < 24; k++) {
      const s = Math.floor(Math.random() * (end - need));
      let ok = true;
      for (let j = 0; j < need; j++) {
        // 只认"现在"之前、而且确实有数的点
        if (mn.time[s + j] >= now || mn.gust[s + j] == null || mn.cape[s + j] == null) { ok = false; break; }
      }
      if (!ok) continue;
      const s2 = biasedStart(s, end - need);

      const win = tr.slice(s2, s2 + need);
      const m = median(win);
      /* 基本面用的两条：
         cfSlow —— 舒适度的**慢速 EMA**（半衰期约 12 小时 = 48 根）。
                   用慢速是因为即时 comfort 会被单根雷暴砸出大坑
                   （实测 |Δcomfort| 的 p99 是中位的 61 倍），直接当价格就是尖刺序列。
         cfMed  —— 本局窗口内 cfSlow 的中位，用来把指数**居中到 BASE**。
                   不居中的话，一段整体舒服的天气会让指数常年停在 1150 以上，
                   "1000 代表天气一般"这个语义就没了。 */
      const cfSlow = ema(cf, 1 - Math.pow(0.5, 1 / 48));
      const cfMed = median(cfSlow.slice(s2, s2 + need));
      /* 月光也按**本局窗口中位**居中（跟 cfMed 一个道理）：
         不居中的话，一局刚好落在满月那几天，指数就被整体压低，语义就飘了。 */
      const moMed = median(moonArr.slice(s2, s2 + need));
      /* 银河高度与天文夜占比也居中，理由同 moMed：它俩有**季节性**
         （银心夏夜高、冬夜沉；冬夜长、夏夜短）。不居中就会出现
         "冬天整局偏高 / 夏天整局偏低"的漂移，而我们要的是
         "这一局里它相对自己算高还是低"。 */
      const galMed = median(galArr.slice(s2, s2 + need));
      /* ⚠ 天文夜占比**故意不居中**（不跟 moMed/galMed 一路）：平滑之后它在一局里
         几乎不变（37 天的夜里长度只差十几分钟），居中等于把它减成一个 0。
         它天生长得像"这座城市这个季节的性格"，所以按**绝对口径**（0.5 = 春秋分）
         用 —— 冬夜长就是加分、夏夜短就是减分，跟光污染那项一个待遇。 */
      const series = [];
      const seeds = [];
      const regLine = [];          // 画在副图上的"大盘"（跟主图同一根数）
      // 城市 → 波动放大倍数。整局只算一次（它只跟城市有关），下面所有随机项都乘它。
      const amp = cityAmp(city);
      let carry = 0, dish = 0, noiseEma = 0, micro = 0;
      let calm = 0;                                             // 平静度：连续多少根波动很小
      let pxPrev = BASE + (cfSlow[s2] - cfMed) * P.COMFORT_K;   // 慢通道状态：起点 = 当前基本面
      let impactState = 0;                                      // 冲击状态：未衰减完的价格冲击（事件驱动）
      let flow = 0;                                             // 事件到达率的自激强度
      let heatEma = 0;                                          // 波动率聚集
      let prevPx = pxPrev;                                      // 上一根的价（算 heat 用）
      /* ⚠ prevPx 必须写在 pxPrev **之后** —— 写成 `let heatEma = 0, prevPx = pxPrev;`
         放在 pxPrev 前面会踩 TDZ（`Cannot access 'pxPrev' before initialization`），
         而 pickSeries 是被 try 包着的，于是表现成"取不到序列"、五个城市全跳过，
         排查时完全看不出是这里。教训：**初始化顺序也是逻辑**，别图省事写到一行。 */

      /* ── 空转预热：让价格先进入稳态 ──
         ⚠ 少了这一步会有一个**很显眼**的 bug：起点被放在 anchor 上，但噪声通道是 0，
           而 anchor 每根还在动 —— 于是开局几十根全在"追"锚点，实体大得离谱
           （实测第 2 根 body = 50 点，是稳态中位的 27 倍；最大 body 101 点）。
           更糟的是它会**污染插针**：插针幅度以 body 为基准，body 一大针就打穿
           （实测出现 420 点、903 点的影线，整根 K 线糊成一条线）。
         做法：从窗口开始处往前空转 200 根（≈2 天），把这 200 根的迭代结果丢掉，
           只保留稳态后的状态。因为 anchor 本身在慢变，预热要用**真实的前置数据**，
           不能随便填常数。 */
      for (let w = 200; w >= 1; w--) {
        const kw = Math.max(0, s2 - w);
        const an = BASE + (cfSlow[kw] - cfMed) * P.COMFORT_K;
        const sh = (Math.random() - 0.5) * 2 * BASE * 0.002 * amp * P.NOISE_AMP;
        impactState = impactState * (1 - P.INERTIA) + sh;
        pxPrev = an + impactState;
      }
      for (let j = 0; j < need; j++) {
        const k2 = s2 + j;
        /* 「突发行情」：某根 15 分钟里天气本身剧烈变化（雷暴压境、阵风猛增、开始下暴雨）
           → severity 跳变 → 除了常规项再砸一记冲击。这就是"蜡烛图突然拉到底"。
           `shock` 是「这一刻打多狠」，`carry` 是「余波还走多远」：只有 shock 的话出一根长阴、
           下一根立刻回弹，不像崩盘；加上 carry（按 JUMP_DECAY 衰减的动量）才有连续几根
           顺势砸下去的样子。**它不是随机数** —— 触发条件是真实观测到的剧烈变化。

           ⚠ 门槛 `JUMP_AT` 是拿**新的** severity（= −Δcomfort/10）标定的。
             实测它的 p99 是 2.03，所以 JUMP_AT=1.8 大约只覆盖最猛的 1% —— 
             改 comfort 的权重时要回头重新看这个门槛，否则这一项会退化成空转
             （旧版就踩过：门槛比 p99 还高，一次都触发不了）。 */
        const dsev = k2 > 0 ? (sev[k2] - sev[k2 - 1]) : 0;
        const shock = Math.abs(dsev) > P.JUMP_AT
          ? (Math.abs(dsev) - P.JUMP_AT) * P.JUMP_K * (dsev > 0 ? 1 : -1)
          : 0;
        carry = carry * P.JUMP_DECAY + shock;

        // 大盘的快分量：本地天气是一城一地，大盘是整省的天气过程。
        // 只取"快分量"（减去自己的 EMA）是有意的 —— 趋势项已经由本地负责，
        // 大盘再贡献一遍慢趋势就成了同一个信号算两次。
        let regFast = 0;
        if (regSev) regFast = (regSev[k2] - regTr[k2]) * P.REG_K;

        const dnorm = D[k2] == null ? 0 : (D[k2] - mDew) / sDew;

        // 盘子扰动：AR(1)。用噪声当驱动、按 P.DISH_DECAY 衰减，
        // 所以它是一条"能看出有人在推"的平滑曲线，而不是每根乱跳的雪花点。
        dish = dish * P.DISH_DECAY + (Math.random() - 0.5) * 2 * dScale;

        // 微观游走：比盘子扰动快、比单根噪声慢的一层毛刺，让盘口看着"有人在成交"。
        micro = micro * P.MICRO_DECAY + (Math.random() - 0.5) * 2 * P.MICRO_K;

        // 快分量过一道轻 EMA —— 相邻两根因此变得相关，走势才会"成段"。
        // P.NOISE_BOOST 补回 EMA 削掉的方差，整体波动幅度保持不变。
        noiseEma = noiseEma * P.NOISE_A + (sev[k2] - tr[k2]) * (1 - P.NOISE_A);
        const noiseTerm = noiseEma * P.NOISE_K * P.NOISE_BOOST;

        // 四个压力源（缺数据的项 airN/fN 为 null、qArr/tArr 天然为 0）
        const airTerm  = airN ? airN[k2] * P.AIR_K : 0;
        const quakeTerm = qArr[k2];
        const typhTerm = tArr[k2];
        const fcstTerm = fN ? fN[k2] * P.FCST_K : 0;

        /* ⑤ 天文家族：天文模块里的**每一个变数**都进来了
           （真值来自 astro.js 的解析式 + NOAA 实测，零编造；放大的只是"影响"）。
           符号统一约定成「**看点多 → 涨**」：月光把夜空照亮是减分，
           流星雨 / 超级月亮 / 银河 / 星空热闹 / 长夜 / 大潮 / 暗天空 / 地磁暴都是加分。
           把地磁暴也定成正号是这一轮**有意**的：使用者要的是刺激不是真实，
           一场 Kp 7 的暴就是"天上的大新闻"，该砸出方向明确的行情。

           ⚠ 慢变量（银河高度、天文夜占比）按**本局窗口中位**居中，事件型的
             （流星雨、超级月亮）不居中 —— 居中的目的是让"1000 = 天气一般"这个
             语义稳住；事件本来就该整体抬起来，不该被中位减掉。 */
        const moonTerm   = -(moonArr[k2] - moMed) * P.MOON_K;
        const meteorTerm = metArr[k2] * P.METEOR_K;
        const superTerm  = supArr[k2] * P.SUPER_K;
        const galaxyTerm = (galArr[k2] - galMed) * P.GALAXY_K;
        const starTerm   = (starArr[k2] - 0.5) * P.STAR_K;
        const nightTerm  = (nightArr[k2] - 0.5) * P.NIGHT_K;
        const springTerm = (sprArr[k2] - 0.5) * P.SPRING_K;
        const lpTerm     = (0.5 - lpArr[k2]) * P.LP_K;
        const kpTerm     = kpArr[k2] * P.Kp_K;
        /* 天象热度 skyHeat（0~2）：这一根 K 线"天上的东西有多少"的合成指标。
           它**不是价格项** —— 它是三个放大镜的旋钮（成交活跃度、混沌跳跃概率、
           插针概率），所以它不进 bias，只进下面的 HEAT_*。除以 100 是让
           "所有通道同时拉满"≈2（各项系数绝对值的上限之和 ≈ 206）。 */
        const skyHeat = (Math.abs(moonTerm) + meteorTerm + superTerm +
                         Math.abs(galaxyTerm) + Math.abs(starTerm) + Math.abs(nightTerm) +
                         Math.abs(springTerm) + Math.abs(lpTerm) + kpTerm) / 100;

        /* ══ 天气 → 指数 ══
           指数在语义上就是**当地天气的好坏程度**，所以先有一条"基本面"：

               anchor = BASE + (cfSlow − 中位) × COMFORT_K

           cfSlow 是舒适度的慢速 EMA（半衰期约 12 小时）。为什么要慢速而不是用即时值：
           即时 comfort 会被单根雷暴砸出一个大坑（实测 |Δcomfort| 的 p99 是中位的 61 倍），
           价格要是直接等于它，就成了"平时一动不动、偶尔跳一下"的尖刺序列。
           真实标的是**围绕价值波动**，价值本身随基本面缓慢移动 —— 所以：
             · 基本面（anchor）走慢速 comfort，管"这段天气好不好"；
             · 盘面（下面的噪声项）管"市场此刻怎么定价"，均值回归把它拉回 anchor。
           这也正是原来那版缺的东西：原模型里天气只以"零中心异常度"进噪声，
           指数高低和天气好坏**完全无关**，你说要"描绘成天气好坏"就是这个意思。 */
        const anchor = BASE + (cfSlow[k2] - cfMed) * P.COMFORT_K;

        /* 所有**随机项**乘 cityAmp —— 这一行就是"大城市像主流币、小城市像山寨币"的落点。
           为什么必须一次乘完而不是各写各的：旧模型只有 dish 受城市影响，
           而 dish 只占波动方差的 ~4%，noise/carry/micro 全与城市无关，
           于是实测梯度被稀释成 1.78×，而真实交易所是 3.09×。
           ⚠ 基本面 anchor **不乘 cityAmp** —— 天气过程本身对大小城市是一样的，
             差别该体现在"盘面反应"（噪声、冲击）而不是"天气不同"。
             这也正是"小地方更容易被推着走"的物理含义：同样的消息，薄盘子动得更狠。 */
        /* ══════════════ 事件驱动的价格冲击 ══════════════
           这一段是**架构级**的改动，解决的是对账里差最多的那一项：
           真实 15 分钟 lag-1 自相关 **−0.01 ~ +0.02**（几乎无记忆），
           而旧架构（连续噪声 + 慢速均值回归）实测锁在 **0.38**，扫 27 组参数都下不来。

           原因是数学上的：`每根回归 REVERT 比例` 会把「噪声」变成 AR(1)，
           它的滞后一阶相关 ≈ 1−REVERT —— 只要回归慢（为了钉住基本面），
           自相关就必然高。**慢回归和低自相关不可兼得。**

           真市场不是"连续信号"，是**事件驱动**的：
             一笔成交到达 → 造成一次价格冲击 → 冲击按**韧性**(resilience)快速衰减
             下一笔成交再来。所以价格是「跳跃的累加 + 快速衰减」，
             而不是"平滑随机游走在慢慢回归"。

           关键差别在于**衰减速率与到达速率的关系**：
             · 衰减慢于到达 → 冲击首尾相接 → 又是 AR(1)（自相关高）
             · 衰减快于到达 → 每笔冲击基本独立 → 自相关 ≈ 0  ✅
           韧性半衰期取 ~2 根（INERTIA），到达率每根 1~2 笔，正好落在第二档。

           另外两个真市场特征也在这里落地：
             · **波动聚集**：到达率**自激** —— 来的事件越多，下一根的到达率越高
               （`flow` 累积 → `arrival` 上升）。这就是"大波动成群出现"。
             · **肥尾**：单笔冲击的幅度用幂律尾巴，多数小、偶尔一次清算瀑布。 */
        const flowRet = impactState / BASE;                   // 当前未衰减完的冲击（→ 自激强度）
        flow = flow * P.FLOW_DECAY + Math.abs(flowRet) * 60;
        /* 流星雨极大夜还会**带热成交**：一年就九次的天象，盘面本身就该比平时活跃。
           它对应的正是"热点消息 → 成交放大"，也是本模型里唯一能**只在这一夜**
           抬高波动率的旋钮（全局 NOISE_AMP 不能动 —— 那会一次性改掉所有分位，
           就不是"偶发暴动"而是"整体更吵"了）。 */
        /* 天象热度 skyHeat 还拧**成交活跃度**这一档：天文模块热闹的夜里，
           盘面本身就该比平时活跃（这就是"热点消息 → 成交放大"的落点）。 */
        const arrival = P.FLOW_RATE * (1 + Math.min(6, flow)) * (1 + calm / 30) *
          (1 + metArr[k2] * P.METEOR_FLOW) * (1 + skyHeat * P.HEAT_FLOW);
        const nEvents = arrival > 3
          ? Math.floor(arrival) + (Math.random() < (arrival % 1) ? 1 : 0)
          : (Math.random() < arrival ? 1 : 0);               // 泊松近似
        let evSum = 0;
        for (let e = 0; e < nEvents; e++) {
          /* 单笔冲击的**方向**与**幅度**：
             方向由天气与盘面的快分量决定（这就是"天气好 → 买盘多"的落点）；
             幅度用幂律尾巴 —— `pow(rand,3)*4.5` 让它绝大多数很小、偶尔极大。 */
          const bias = (noiseTerm + carry + regFast + dnorm * P.DEW_K + dish + micro
                        + airTerm + quakeTerm + typhTerm + fcstTerm
                        + moonTerm + meteorTerm + superTerm + galaxyTerm + starTerm
                        + nightTerm + springTerm + lpTerm + kpTerm) * amp * P.NOISE_AMP;
          const mag = BASE * P.EVENT_K * (Math.pow(Math.random(), 3) * 4.5 + 0.05) * amp;
          evSum += (bias >= 0 ? 1 : -1) * mag + bias * 0.35;
        }
        /* 混沌跳跃 = **特别大的一笔**（清算瀑布）。它不是另一套机制，
           只是同一个事件过程里尾巴拉满的那一次 —— 所以直接并进 evSum。
           触发条件仍带 `calm`（平静越久越容易爆发），见 docs/CHAOS_DESIGN.md。 */
        const heat = Math.abs(pxPrev - prevPx) / BASE;
        heatEma = heatEma * 0.94 + heat * 0.06;
        calm = (heat < 0.0008) ? Math.min(60, calm + 1) : 0;
        if (Math.random() < P.CHAOS_P * (1 + calm / 25) * (1 + heatEma * 400) *
                            (1 + skyHeat * P.HEAT_CHAOS_P)) {
          const tailv = Math.pow(Math.random(), 3) * 5.5 + 0.08;
          evSum += (Math.random() < 0.5 ? -1 : 1) * BASE * P.CHAOS_K * tailv * amp *
                   (1 + skyHeat * P.HEAT_CHAOS_K);
          calm = 0;
        }
        prevPx = pxPrev;

        /* 冲击状态按韧性衰减，再把本根的新事件累加进去。
           ⚠ 事件**不进 `noisePrev`**（那是旧的快通道，已废弃）——
             它们只由 `INERTIA` 衰减，这是"短记忆"的来源。 */
        impactState = impactState * (1 - P.INERTIA) + evSum;

        /* ── 价格 = 基本面 + 未衰减完的冲击 ──
           ⚠ 这里就是架构改动最核心的一行。旧版是：
               px = pxPrev + (anchor − pxPrev)·REVERT − noisePrev·NOISE_REVERT + shock
             那个式子里**前景价格依赖自身**，所以必然产生 AR(1) 记忆（实测自相关 0.38）。
           新版把价格**定义**成两个不互相依赖的状态之和：
               · anchor       —— 天气决定的慢变量（管长期方向）
               · impactState  —— 事件冲击的累加，按 INERTIA 快速衰减（管短周期抖动）
           前景价格不再出现在等式右边，所以没有"自我回归"，
           自相关只由冲击的衰减速率决定 —— 调快到 2 根半衰期就能压到 0 附近。 */
        const px = anchor + impactState;
        const pxRet = pxPrev > 0 ? (px - pxPrev) / pxPrev : 0;
        void pxRet;
        pxPrev = px;
        series.push({ t: mn.time[k2], c: px });
        // 标定用：把每一项单独记下来。开关关着时只是往一个数组 push 一次，
        // 没有性能影响；开着就能量出"是哪一项在主导波动"（见 tools/probe_components.js）。
        if (DBG_COMP) dbgComp.push({ noise: noiseTerm * amp, carry: carry * amp, reg: regFast * amp, dew: dnorm * P.DEW_K * amp, dish: dish * amp, micro: micro * amp, air: airTerm * amp, quake: quakeTerm * amp, typh: typhTerm * amp, fcst: fcstTerm * amp, moon: moonTerm * amp, meteor: meteorTerm * amp, anchor: anchor - BASE, revertPx: pxPrev - anchor });
        regLine.push(BASE + regFast * 3 + dish * 0.2);
        seeds.push({
          cape: mn.cape[k2] | 0,
          gust: +(+mn.gust[k2]).toFixed(1),
          precip: +(+(mn.precip[k2] || 0)).toFixed(1),
          wcode: mn.wcode[k2] | 0,
          dew: D[k2] == null ? null : +(+D[k2]).toFixed(1),
          dish: +dish.toFixed(1),
          pm25: (airRaw && airRaw[k2] != null) ? +airRaw[k2].toFixed(0) : null,
          air: +airTerm.toFixed(1),
          quake: +quakeTerm.toFixed(2),
          qmag: qMag[k2] || 0,
          qplace: qPlace[k2] || '',
          typh: +typhTerm.toFixed(2),
          tname: tName[k2] || '',
          tdist: tDist[k2] || 0,
          fcst: +fcstTerm.toFixed(2),
          /* 天文两项也进 seeds：一个是给播报用（流星雨要报雨名与月光），
             一个是给探针用（量化"这一局天文有没有戏"）。 */
          moon: +moonArr[k2].toFixed(3),
          meteor: +meteorTerm.toFixed(2),
          mname: metName[k2] || '',
          /* 天文第二批也进 seeds：一是给播报用（超级月亮/银心/长夜/地磁暴都要报），
             二是给探针用（探针要能量出"这一局天文到底有没有戏"）。
             `sky` 就是天象热度 skyHeat —— 插针那一段是**另一个循环**，
             拿不到主循环里的 skyHeat 局部变量，只能从 seeds 里取（见 HEAT_SPIKE）。 */
          super: +superTerm.toFixed(2),
          galaxy: +galaxyTerm.toFixed(2),
          stars: +starTerm.toFixed(2),
          night: +nightTerm.toFixed(2),
          spring: +springTerm.toFixed(2),
          lpm: +lpTerm.toFixed(2),
          kpraw: kpArr[k2],
          kp: +kpTerm.toFixed(2),
          sky: +skyHeat.toFixed(3)
        });
      }
      /* ── 立靶子：把多维压力表要用的数据一并算好存进 seeds ──
         面板**只读这里**，不自己算 —— 这就是"先画靶子再射箭"。
         存四样东西，够面板显示"当前值 / 近7天分位 / 方向 / 对指数贡献"：
           cparts  六个维度各自的 {v, score, contrib}（贡献之和 === comfort）
           ctotal  = Σ contrib，也就是这一根的舒适度
           pct     各维度在**本局窗口内**的百分位（[0,1]）
           dir     各维度的方向：和上一根比是升是降
         为什么分位要在**生成时**算：它依赖本局窗口的整段分布，
         放到面板里每帧重算就得每次扫 3552 个点 × 6 个维度，白烧 CPU。 */
      {
        const cpWin = comfortParts(mn, airRaw).slice(s2, s2 + need);
        const byDim = {};
        for (const d of DIMS) byDim[d.key] = cpWin.map(p => p[d.key].v).filter(v => v != null).sort((a, b) => a - b);
        for (let j = 0; j < seeds.length; j++) {
          const cp = cpWin[j];
          if (!cp) continue;
          const pct = {};
          for (const d of DIMS) {
            const arr = byDim[d.key];
            const v = cp[d.key].v;
            if (v == null || !arr.length) { pct[d.key] = null; continue; }
            // 二分找插入位置 → 百分位
            let lo = 0, hi = arr.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
            pct[d.key] = lo / arr.length;
          }
          const cpPrev = j > 0 ? cpWin[j - 1] : null;
          const dir = {};
          for (const d of DIMS) {
            const a = cp[d.key].v, b = cpPrev ? cpPrev[d.key].v : null;
            dir[d.key] = (a == null || b == null) ? 0 : Math.sign(a - b);
          }
          seeds[j].cparts = cp;
          seeds[j].ctotal = cp.total;
          seeds[j].cpct = pct;
          seeds[j].cdir = dir;
        }
      }
      /* ── 补 OHLC + **插针** ──
         开 = 上一根收、收 = 本根指数（都是真采样）。影线不能用 `|涨跌| × 常数` 了 ——
         那是个**确定性**关系（大实体必然大影线），而真实币圈的插针完全不是这样：

           插针 = **流动性被吃穿**那一刻。一笔大单扫掉几档挂单，价格瞬间打到一个
           几乎没人成交的价位，然后立刻缩回来（清算瀑布 / 止损猎杀）。
           特征是「**影线远大于实体，且收盘回到原处**」——
           K 线上就是一根长针，实体却很小。

         拆成两部分：
           ① 基础影线  |涨跌| × WICK_K        正常的盘中波动，仍与实体相关
           ② 插针      SPIKE 事件 × 幅度      罕见、很大、**与实体无关**

         插针幅度按**流动性**定：小城市盘子薄，同样的扫单打得更深
         （除以 dishScale —— 和 cityAmp 是同一个物理含义，但走独立通道）。

         ⚠ 插针**只改影线，不改收盘**，所以不会动已经标定好的收益分布
           （中位涨跌、自相关都不受影响），只在盘面上多出几根长针。
         ⚠ 触发概率挂**真实天气活跃度**（volOf）：暴雨/雷暴天成交更活跃、流动性更薄，
           插针更容易发生。这样针不是纯随机撒的，而是"天气越疯、盘面越疯"。 */
      for (let j = series.length - 1; j >= 0; j--) {
        const c = series[j].c;
        const o = j > 0 ? series[j - 1].c : c;
        const body = Math.abs(c - o);
        let w = body * WICK_K;
        const act = Math.min(3, volOf(seeds[j]) / 4);          // 活跃度 → 约 [0,3]
        if (Math.random() < P.SPIKE_P * (0.5 + act) * spikeMul() *
                            (1 + (seeds[j].sky || 0) * P.HEAT_SPIKE)) {
          /* 插针幅度：基准 = 价格 × SPIKE_DEPTH ÷ 盘子厚度，再乘一个**幂律尾巴**。
             ⚠ 第一版用 `(0.25 + rand*0.85)` 均匀分布 → 每根针差不多深，
               看着像规律锯齿而不是"突然的针"。
             真实插针是**罕见且深浅悬殊**的：多数是普通扫单（百分之几），
             偶尔一次清算瀑布（十几）。所以用 `pow(rand, 2.5)` ——
             rand 均匀时它偏小（大多数针浅），但偶尔接近 1（深针）。
             再除以 dishScale(城市)：小城市盘子薄，同样的扫单打得更深。 */
          const tail = Math.min(2.0, Math.pow(Math.random(), 2.5) * 2.6 + 0.06);
          const size = c * P.SPIKE_DEPTH * tail / dishScale(city);
          w += size;
          series[j].spike = size;
          series[j].spikeDir = Math.random() < 0.5 ? -1 : 1;   // 向上针还是向下针
        } else {
          series[j].spike = 0;
          series[j].spikeDir = 0;
        }
        series[j].o = o;
        series[j].h = Math.max(o, c) + w;
        series[j].l = Math.min(o, c) - w;
      }
      /* ⚠ 插针**必须先在这里定死**（这一步就是"靶子"），动画只许读、不许自己算。
         我第一版是让 `liveAt()` 现算的 —— 结果每次读都重新掷骰子，
         同一根未收盘的蜡烛前后看到的针不一样（有时有、有时没有）。
         `pickSeries` 是这套数据唯一的生成点，所以靶子只能在这里立。
         `resample` 的两条路径（聚合 / 展开）都负责把 spike 字段**原样带下去**，
         于是从 1 分钟到 1 日、从已收盘到未收盘，看到的都是同一根针。 */
      if (!series.every(b => isFinite(b.o) && isFinite(b.c))) continue;
      // 按玩家选的 K 线周期重采样（15 分钟源 → 目标周期），价格模型本身不动。
      const rs = resample(series, seeds, regSev ? regLine : null);
      const raw = regSev ? regLine : null;
      return {
        series: rs.series, seeds: rs.seeds, sevWin: sev.slice(s2, s2 + need),
        regLine: rs.regLine,
        regFrom: s2,
        regCities: (reg && reg.cities) || null,
        // 15 分钟原样那一份也带出来 —— 局中换 K 线周期时不用重新取数据，
        // 直接拿它重采样再把已推进的天气时间映射过去就行。
        base: series, baseSeeds: seeds, baseReg: raw,
        comp: DBG_COMP ? dbgComp : null
      };
    }
    return null;
  }

  function labelAt(i) {
    const day = Math.floor(i / perDay()) + 1, m = (i % perDay()) * barMin();
    const hh = U.pad2(Math.floor(m / 60)), mm = U.pad2(m % 60);
    return (m === 0) ? ('第 ' + day + ' 天') : ('D' + day + ' ' + hh + ':' + mm);
  }

  /* ═══════════════ 未收盘的那根 K 线（live bar） ═══════════════
     真实行情软件里最后那根蜡烛是**一直在变的**：收盘价跟着最新价走、上下影线被不断刷新、
     甚至中途由阳翻阴。原来这里不是这样 —— `tick()` 只在"攒够一整根"时才把 G.price 设成
     新一根的收盘价，没攒够就直接 return（连 render 都不调），于是：
        · 1 日档 + 正常速度 = 每 1440/45 = 32 秒才推进一根，这 32 秒画面是完全静止的；
        · 4 时档 = 每 5.3 秒一跳。
     现在补上那根 live bar：它挂在 G.i+1 的位置，逐帧跟着真实数据往前走。

     ★ **这里没有任何凭空发明的参数。** 价格怎么走，是让光标沿着**真实的 15 分钟源序列**
       （`G.base`，长度 srcBars() = 3552 根，`pickSeries` 存下来的那一份原样数据）往前走：

           dpb  = barMin / 15                       // 一根 K 线 = 几根 15 分钟源
           srcF = G.i * dpb + dpb - 1               // 光标起点 = 上一根的**收盘**那根源数据
                  + u * ((G.i + 2) * dpb - 1        // 终点 = 本根的收盘那根源数据
                         - (G.i * dpb + dpb - 1))   //       两者之差 = (G.i+1)*dpb
           c    = base[s0].c + (base[s1].c - base[s0].c) * kf

       写"起点 + u × (终点 − 起点)"而不是"起点 + u × 某个偏移"，是被探针逼出来的：
       偏移写成 `(u*dpb + dpb - 1)/dpb` 时，整根走完光标只前进 **1 根源数据** ——
       4 时档一根跨 16 根样本，结果盘中也只穿过 2 根（`seen={320,321}`），
       1 日档同样只有 2 根。差就差在没乘上 dpb。现在这个写法对 dpb > 1 和 dpb < 1
       都自动成立（1 分档 dpb=0.067，起终点是相邻两根源数据的收盘，跨度天然是对的）。

       一根 K 线里能穿过多少根真样本，完全由周期算出来，不是我给的系数：
         1 分 / 5 分 → 0.07 / 0.33 根（这两档本身就是插值展开的，文档里写明了）
         15 分       → 1 根
         30 分 / 1 时 / 4 时 / 1 日 → 2 / 4 / 16 / 96 根
       1 日档那根蜡烛，一天里会被 96 个真实的 15 分钟观测逐格推着走。

     ★ **收盘瞬间零跳变**：u 走到 1 时光标正好落在 `(G.i+2)*dpb - 1` 这个整数上 →
       kf = 0 → `c` 精确等于 base[(G.i+2)*dpb-1].c，也就是那根真 K 线的收盘价。
       高/低在那一刻也等于它。所以"live bar 变成真 K 线"这一下不需要任何补正。

     ★ **dpb < 1（1 分 / 5 分）走的是上面公式的独立分支**，见函数中段那段注释：
       这两档的源样本窗口会塌成空区间（start === end），不能套同一个公式。
       分支里同样满足 u=0 是一个点、u=1 精确等于 series[G.i] 的 c/h/l。 */
  function liveAt() {
    if (!G.running || G.ended) return null;
    if (G.i < 0 || !G.base || !G.base.length) return null;
    if (G.i + 1 >= G.series.length) return null;      // 已经是最后一根，没有"下一根"可走
    const tgt = G.series[G.i + 1];
    if (!tgt) return null;

    const u = Math.max(0, Math.min(1, G.acc));        // 这一根的完成度
    const N = G.base.length;
    const dpb = barMin() / SRC_MIN;                   // 一根 K 线 = 几根 15 分钟源
    /* ⚠ 源窗口必须对齐 **series[G.i]**（live bar 占的那一格），而且
       `dpb > 1`（聚合）与 `dpb < 1`（插值展开）要用**同一个公式**：

           last(j) = ceil((j+1)·dpb) - 1        第 j 根 K 线覆盖的**最后一根**源样本

       验算（三种情形都成立）：
         dpb=1  → last(30)=30            两根 K 线各占 1 根源样本
         dpb=2  → last(30)=61，last(29)=59   一跳一根，不重不漏
         dpb=96 → last(30)=2975
         dpb=1/15（1 分档）→ 同一根源样本被 15 根 K 线共用 → last 会对相邻几根相同，
                              这是对的：那几根本来就是同一根 15 分钟的展开

       ⚠ 这里错了三次，全是"只在一个档位验过"：
         ① 按 series[G.i+1] 的窗口写 → 占位改到 G.i 后整段偏一根；
         ② 改成往回挪一个**周期**→ 又多挪了（u=1 差 -0.2457/3.66/4.74）；
         ③ 用 `(G.i+1)*dpb-1` → dpb=1 时退化错，15 分档差 3.43。
         自检：`series[G.i].c` 必须等于 `base[last(G.i)].c`，**全档位**都要成立。 */
    const spb = Math.max(1, Math.round(dpb));
    const lastOf = j => Math.ceil((j + 1) * dpb) - 1;
    const start = lastOf(G.i - 1);                    // 本根开盘那一刻的源数据下标
    const end = lastOf(G.i);                          // 本根收盘那一刻的源数据下标
    const srcF = start + u * (end - start);
    const endI = Math.round(end);

    /* 开盘价 = **左邻那根的收盘价**，也就是 series[G.i-1].c。
       ⚠ 这里错了一个下标，正是用户报的"最新那根跟左边接不上"：
         · 图表里 live bar 占的是**第 G.i 格**（liveNote 用 n-1 = G.i 替换掉 series[G.i]），
           所以它的左邻是 series[G.i-1]，不是 series[G.i]；
         · 我原来写的是 series[G.i].c —— 那是**它自己**的收盘价（=下一根真 K 线的开盘），
           结果 live bar 的开盘比左邻的收盘高出整整一根的涨幅（实测恒差 0.25），
           看上去就是一块独立出去的蜡烛。
       换对之后接缝恒为 0（tools/dbg_chartdata.js 可直接看到）。 */
    const prevIdx = Math.max(0, G.i - 1);
    const o = G.series[prevIdx].c;

    /* ── dpb < 1（1 分 / 5 分）单独一条路：这两档的 series 是**插值展开**出来的，
       一根 15 分钟源样本被摊成 3 ~ 15 根子 K 线，子 K 线**内部没有任何源样本可走**，
       所以不能套下面那套"按源样本窗口推光标"的公式。

       ⚠ 以前就是硬套的，窗口会塌成空区间：
         lastOf(j) = ceil((j+1)·dpb) - 1 在 dpb<1 时，同一根父 K 线的相邻子根**取值相同**
         → start === end → bLo = start+1 > bHi = endI
         → `cur >= bLo && cur <= bHi` 恒假 → 成交价 cFill 永远退化成 o（上一根子根的收盘）
         → 而且 srcF 停在整数上，kf = srcF - floor(srcF) 恒为 0，画图价一整根纹丝不动。
       实测（北京，base 3552 根）：1 分档 cFill 恰好 == series[j-1].c 占 3733/3999、
       画出来的收盘与 series[j] 不符 3720/3999（中位差 0.04%、最大 3.74%）；
       5 分档 2666/3999、2665/3999。**15 分及以上完全不受影响**（那时 start < end，窗口是实的）。

       这里改成直接拿**本根自己**的 o/h/l/c 当目标（G.series[G.i] 就是那根子 K 线），
       从开盘价 o 按完成度 u 线性走过去：
         · u=0 → h=l=c=o，仍是一个点（"新 K 线刚开盘"该有的样子）
         · u=1 → 精确等于 series[G.i] 的 c/h/l，**收盘瞬间零跳变**
         · 因为展开时恒有 series[G.i].o === o、h ≥ max(o,c)、l ≤ min(o,c)，
           线性插值途中 h ≥ max(o,c)、l ≤ min(o,c) 也恒成立 —— "极值包住实体"
           这条渲染硬要求不会被破坏，h/l 也仍旧单调（h 只增、l 只减）。
       成交价 cFill 仍守老规矩：**只认已经走完的那一根**的收盘（= o），走满了才认本根。 */
    if (dpb < 1) {
      const nb = G.series[G.i] || {};
      const cT = (nb.c == null) ? o : nb.c;
      const hT = (nb.h == null) ? cT : nb.h;
      const lT = (nb.l == null) ? cT : nb.l;
      const cD = o + (cT - o) * u;
      const hD = o + (hT - o) * u;
      const lD = o + (lT - o) * u;
      return {
        t: tgt.t, o: o,
        h: Math.max(hD, o, cD), l: Math.min(lD, o, cD),
        c: cD, cFill: (u >= 1) ? cT : o,
        i: G.i + 1, u: u, s0: G.i
      };
    }

    /* 本根在系列里的身份是 series[G.i]（live bar 占的就是这一格）。
       u=1 时要精确等于它，所以收盘价与极值的窗口都以 G.i 这根为基准。
       源样本区间：[base0, base1]，其中 base0 = start+1、base1 = endI。
       自检：series[G.i].c 必须等于 base[G.i*SRC_MIN … ] 那一段的最后一根收盘，
       而 series[G.i-1].c 是它的上一根 —— 两者都在 base 里，所以下面的窗口是自洽的。 */
    /* 源窗口：series[G.i] 覆盖 base[G.i*spb .. (G.i+1)*spb-1]（已用对账脚本核过四种档位）。
       start 取的是**上一根的收盘样本**（= G.i*spb-1），也就是本根开盘那一刻。 */
    const bLo = start + 1, bHi = endI;
    /* cur 用 floor(srcF)，**不钳到 bLo** —— 这样 u=0 时 cur=start、本根一格都没开始，
       极值为空、h=l=c=o，正好是一个点（"新 K 线刚开盘"该有的样子）。
       上一版我把下限钳成 bLo，结果 u=0 就把第一格的整根高低算了进来，
       h/l 直接是一个宽区间（实测 h=1032.482 l=1029.075 而 o=1029.714）。
       ⚠ 但插值那边必须补一个"光标还在上一根样本里"的分支，否则开头十几帧
         cDraw 会卡在 o 不动（实测 30 Hz 下连续 10 帧纹丝不动）——见下面。 */
    const cur = Math.min(bHi, Math.floor(srcF + 1e-9));
    const fb = formBar(o, bLo, cur);
    const c = (cur >= bLo && cur <= bHi) ? G.base[cur].c : o;

    /* 画图用的价：**在整根范围内跟着光标连续走**，而不是在每个源样本内部插值。
       为什么要分成"画图价"和"成交价"（这是"长档位变化不够快"的解法）：

         · 极值（h/l）必须**按整格跳**：只有整根样本走完，它的真实高低才算数 ——
           这是"不丢上下限"的前提（上一轮的核心修复）。
         · 画出来那一端如果也跟着整格跳，粗档位就会**碎步卡顿**：
           光标（srcF）每 tick 只推进 `SPEED/barMin/TICK_HZ` 格，
             · 15 分档 = 0.3 格/tick → 每 tick 都在跨格，看着在动
             · 1 日档 = 0.003 格/tick → **要 3.3 个 tick 才跨一格**，
               于是连续 3 帧价格完全不动、第 4 帧跳一下 —— 实测就是这样（见下）
           样本内插值救不了：kf 只在跨格时才从 0 走到 1，跨格前那个价是死的。

       所以这里把插值提到**整根层面**，但**沿着真实样本收盘价那条折线走**，
       而不是从开盘直连收盘：

           cDraw = 折线( base[bLo..cur].c ) 在相位 kf 处取值

         · 每帧都在动 —— 因为光标每帧都在推进，不跨格也在折线上走（手感快）
         · 走到每个样本的收盘点时会**真的换向** —— 那些拐点来自真实数据，
           不是编出来的（实测 15 分档换向 0% 的原因就是它只有 1 格、走不出折线；
           粗档位有几十上百个拐点，自然有来回）
         · 端点自洽：u=0 → cur=start 且 kf=0 → 取到 o（一个点）；
                    u=1 → cur=end 且 kf=1 → 精确等于 series[G.i].c

       ⚠ 我上一版写成 `o + (cTrue - o) * u`（开盘直连收盘）—— 结果换向率 **0%**，
         整根变成一条直线，比改之前更假。教训：**插值要沿着数据的形状走，
         不能自己造一条更"顺"的线。**
       ⚠ **只用于画图**：成交价（G.price / cFill）走的仍是离散的真收盘，
         不能让玩家在"并不存在的插值价"上成交。
       ⚠ cDraw 也要并进 h/l 的包络，否则"极值包住实体"这条渲染硬要求会被破坏。 */
    const kf = (u >= 1) ? 1 : Math.max(0, Math.min(1, srcF - Math.floor(srcF)));
    let cDraw;
    if (cur >= bLo && cur <= bHi) {
      /* 折线段的两端：起点是"上一格收盘"（第一格时就是本根开盘 o），
         终点是光标所在这一格的收盘。kf=1 时正好落到 G.base[cur].c。 */
      const a = (cur > start) ? G.base[cur - 1].c : o;
      cDraw = a + (G.base[cur].c - a) * kf;
    } else {
      /* 光标还在上一根的那个收盘样本里（u 刚起步）。这时本根还没数据 ——
         但**不能就此卡住不动**：上一版这里直接给 o，于是开头十几帧价格纹丝不动，
         然后猛地跳一下（实测 30 Hz 下连续 10 帧不变）。
         做法：折线的起点仍是 o，终点用本根第一格的收盘，按 kf 走 ——
         kf 到 1 时正好接上 G.base[bLo].c，与下面的分支无缝衔接。 */
      const a = o, b2 = G.base[Math.min(bHi, bLo)].c;
      cDraw = a + (b2 - a) * kf;
    }

    const h = Math.max(fb.h, o, c, cDraw);
    const l = Math.min(fb.l, o, c, cDraw);

    return { t: tgt.t, o: o, h: h, l: l, c: cDraw, cFill: c, i: G.i + 1, u: u, s0: cur };
  }

  /** 清空"正在形成的那根"（换根 / 换周期 / 探针重置时调用） */
  function fbReset() {
    G.fbKey = null; G.fbLast = -1; G.fbH = -Infinity; G.fbL = Infinity;
  }

  /**
   * 把"正在形成的那根 K 线"推进到第 lastStarted 根源样本，返回累积极值。
   *
   * 幂等且只进不退：
   *   · 本根身份（key = G.i + 周期）没变时，只把**新出现**的样本并进累加器；
   *   · lastStarted 比上次小（回退）→ 整体重建，结果与顺序推进完全一致；
   *   · 换根 → key 变了 → 清空重来。
   * 于是 h 只增、l 只减是**构造性**的，不依赖任何边界特判。
   *
   * @param {number} o           本根开盘价（上一根的收盘）
   * @param {number} lastStarted 已经开始的最后一根源样本下标
   * @param {number} endI        本根最后一根源样本下标
   */
  function formBar(o, lo, hi) {
    const key = G.i + '@' + barMin();
    /* 需要重建的两种情况：
       ① 换根（key 变了）；
       ② hi 比上次小 —— 说明光标**回退**了。这不只是探针会做的事：局中切换 K 线周期
          （setBar）就会把 G.i / G.acc 一起回退，累加器若跟着沿用，就会把**上一个周期**
          的极值带进当前这根，表现就是用户看到的"最新那根像独立出去的一样"。
       重建结果与顺序推进一致，所以这是幂等的（tools/test_live_wick.js ④ 验这条）。 */
    if (G.fbKey !== key || hi < G.fbLast) fbReset();
    if (G.fbKey !== key) { G.fbKey = key; G.fbLast = lo - 1; }
    const N = G.base.length;
    /* ⚠ 这里 k 必须是**绝对下标**。第一版我写成 `for (k = G.fbLast+1; k <= lastStarted; k++)`
       而 fbLast 起手是 -1 —— 于是把 base[0]、base[1] 当成了本根的样本
       （实测 u=1 时 h=1056 而真值只有 1019）。起手必须落在本根第一个样本上。 */
    const from = Math.max(lo, G.fbLast + 1);
    for (let k = from; k <= hi; k++) {
      if (k < 0 || k >= N) continue;
      const b = G.base[k];
      if (b.h > G.fbH) G.fbH = b.h;
      if (b.l < G.fbL) G.fbL = b.l;
    }
    if (hi > G.fbLast) G.fbLast = hi;
    return { h: isFinite(G.fbH) ? G.fbH : o, l: isFinite(G.fbL) ? G.fbL : o };
  }

  /** 当前这一刻"可成交"的价格。有 live bar 就用它（所见即所得），否则退回已完成那根的收盘。 */
  function livePrice() {
    const L = liveAt();
    /* ⚠ 必须返回 cFill（离散的**真实**收盘），不是 c（画图用的平滑插值价）。
       画出来那一端为了"每帧都在动"做了插值，但 **成交必须落在真实发生过的价格上** ——
       否则玩家会在一个并不存在的价上成交，回测和结算都对不上。
       liveAt().c 只给图表用，这里永远拿 cFill。 */
    return L ? L.cFill : G.price;
  }

  /** 第 k 格该显示的量柱（活跃度是真值，颜色跟着蜡烛判，免得"上面绿 K、下面红柱"） */
  function volNote(k, bd) {
    return {
      value: +volOf(G.seeds[k]).toFixed(2),
      itemStyle: { color: bd.c >= bd.o ? 'rgba(255,77,79,.55)' : 'rgba(0,181,120,.55)' }
    };
  }

  /**
   * 把 [from, n) 这一段整理成画图要用的各类数组，**最后一格换成 live bar**。
   *
   * ★ 为什么抽成一个函数、而且必须返回**完整**数组：
   *   `liveTick()` 走的是 `setOption` 的**合并**模式（不能传 notMerge，否则横轴、
   *   均线、大盘线、dataZoom 全被清掉）。而 ECharts 的 merge 是
   *     `!n && i in t || (t[i] = T(e[i]))`
   *   —— `data` 是数组，命中 `Y(o)`（isArray）那条分支 → **整个数组被替换**，
   *   不是逐元素合并。所以局部重绘也只能整段重传，传一根等于把 90 根蜡烛全删了。
   *   两个调用点共用这一份，就不会出现"重绘时口径和全量渲染时不一样"。
   */
  function liveNote(from, n) {
    const L = liveAt();
    const liveIdx = L ? n - 1 : -1;
    const xs = [], bars = [], vols = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i < n; i++) {
      const isLive = (i === liveIdx);
      const bd = isLive ? L : G.series[i];
      if (!bd) continue;
      xs.push(labelAt(i));
      bars.push([+bd.o.toFixed(2), +bd.c.toFixed(2), +bd.l.toFixed(2), +bd.h.toFixed(2)]);
      if (bd.l < lo) lo = bd.l;
      if (bd.h > hi) hi = bd.h;
      vols.push(volNote(i, bd));
    }
    return { L: L, xs: xs, bars: bars, vols: vols, lo: lo, hi: hi };
  }

  /* ═══════════════ 天气日历 ═══════════════
     财经日历告诉你「20:30 有非农」，但不会告诉你数据是好是坏 —— 这个日历一样：
     它只标出**未来一天里天气什么时候会剧变**，一个字都不提往哪边。

     判定用的是 |Δseverity|，也就是"变化得多猛"。CAPE 炸上去和塌下来
     算出来是同一个数，所以强度条本身不泄露方向。
     触发门槛跟价格冲击用的同一个 P.JUMP_AT —— 日历上标了的，盘面上就真会动。 */
  function calendarAt(i, horizon) {
    if (!G.sev || !G.series.length) return [];
    const end = Math.min(G.series.length - 1, i + (horizon || perDay()));
    const raw = [];
    for (let k = Math.max(1, i + 1); k <= end; k++) {
      const d = Math.abs(G.sev[k] - G.sev[k - 1]);
      if (d > P.JUMP_AT) raw.push({ at: k, d: d });
    }
    // 同一场天气过程会连着好几根都在变，合并成一段
    const out = [];
    for (const e of raw) {
      const last = out[out.length - 1];
      if (last && e.at - last.to <= 3) { last.to = e.at; last.d = Math.max(last.d, e.d); }
      else out.push({ from: e.at, to: e.at, d: e.d });
    }
    return out;
  }

  /* ═══════════════ 新闻闪报（都用真实数值） ═══════════════ */
  /** 返回这一根 K 线上值得播报的天气事件，没有就返回 null */
  function newsAt(i) {
    const s = G.seeds && G.seeds[i];
    if (!s) return null;
    const prev = G.seeds && G.seeds[i - 1];
    const wc = s.wcode;
    // 「状态类」消息只在**刚跨过门槛的那一下**播（上升沿），不然台风挨着 500 公里飘两天，
    // 每根 K 线都要弹一次"🌀 台风" —— 那不是新闻，那是刷屏。
    // （实测不加这个判断时：一局 672 根里播了 540 次台风。）
    const rise = (f, th) => s[f] >= th && !(prev && prev[f] >= th);
    const fall = (f, th) => s[f] <= th && !(prev && prev[f] <= th);

    // 四个真数据压力源排在最前面 —— 它们是"外部消息"，比一根 K 线本身更能解释行情。
    // 顺序 = 罕见到常见：地震 > 台风 > 预报失准 > 空气。
    if (rise('quake', 1)) {
      const pl = String(s.qplace || '').replace(/^\s*(near|about)\s+/i, '').split(',')[0];
      return { k: 'quake', t: '🌋 地震', v: 'M' + n1(s.qmag) + (pl ? ' · ' + pl : '') + ' · 冲击 +' + n1(s.quake) };
    }
    if (rise('typh', 6)) {
      return { k: 'typhoon', t: '🌀 台风' + (s.tname ? ' ' + s.tname : ''),
               v: (s.tdist ? s.tdist + ' 公里外' : '影响中') + ' · 冲击 +' + n1(s.typh) };
    }
    /* 流星雨：一年只有九次、每次只旺一两夜，所以排在地震/台风之后、其余之前。
       播报要报**雨名与月光** —— 这两样决定了它到底看不看得见（无月的极大夜才是真的）。 */
    if (rise('meteor', 4)) {
      return { k: 'meteor', t: '🌠 流星雨' + (s.mname ? ' · ' + s.mname : ''),
               v: (s.moon > 0 ? '月光 ' + Math.round(s.moon * 100) + '%' : '无月') +
                  ' · 冲击 +' + n1(s.meteor) };
    }
    /* ── 天文家族其余通道的播报（2026-10-09「戏剧性」那一轮）──
       阈值都取"这一项真的突出"的档位（不是随便 >0），并且一律走 rise()/fall()：
       同一件事**只播一次**，否则满月那一夜会连播几十根，消息面板就没法看了。 */
    if (rise('super', 10)) {
      return { k: 'super', t: '🌕 超级月亮', v: '近地点满月 · 冲击 +' + n1(s.super) };
    }
    if (rise('galaxy', 6)) {
      return { k: 'galaxy', t: '🌌 银心当空', v: '银河最好拍的时段 · 冲击 +' + n1(s.galaxy) };
    }
    if (rise('night', 0.3)) {
      return { k: 'night', t: '🌃 长夜将至', v: '天文夜变长 · 冲击 +' + n1(s.night) };
    }
    if (rise('spring', 7)) {
      return { k: 'spring', t: '🌊 大潮', v: '朔望引得 · 冲击 +' + n1(s.spring) };
    }
    /* 地磁暴：Kp 是全世界的同一场暴，所以它是"天上的大新闻"，值得单独报。
       门槛 0.556 = Kp 5（G1 级小暴）。⚠ 只有最近约 7 天有 NOAA 实测值，
       更早的时段 kpraw 恒为 0，它永远不会触发 —— 这是不编数据的代价，如实。 */
    if (rise('kpraw', 0.556)) {
      return { k: 'kp', t: '🧲 地磁暴', v: 'Kp ' + Math.round(s.kpraw * 9) + ' · 冲击 +' + n1(s.kp) };
    }
    if (Math.abs(s.fcst) >= 6 && Math.abs(prev ? prev.fcst : 0) < 6) {
      return s.fcst > 0
        ? { k: 'fcstH', t: '🔥 比预报更热', v: '预报失准 +' + n1(s.fcst) }
        : { k: 'fcstL', t: '❄️ 比预报更冷', v: '预报失准 ' + n1(s.fcst) };
    }
    // 空气是慢变量，只在真的"爆表"或真的干净时才播，且同样只播一次
    if (rise('pm25', 200)) return { k: 'airBad', t: '😷 空气爆表', v: 'PM2.5 ' + s.pm25 };
    if (s.pm25 != null && fall('pm25', 10)) return { k: 'airGood', t: '🍃 空气通透', v: 'PM2.5 ' + s.pm25 };
    // 盘子扰动其次 —— 它是"资金面"消息，比天气更能解释一根莫名的长阳/长阴。
    // 门槛 P.DISH_K × 2.5（约 p98）：实测 dish 的 p90 才 4.6，
    // 按 1.5 倍设会让 17% 的 K 线都弹一次"大单扫货"，那就成了噪音而不是消息。
    if (s.dish != null) {
      if (rise('dish', P.DISH_K * 2.5)) return { k: 'pump', t: '🏦 大单扫货', v: '盘子异动 +' + n1(s.dish) };
      if (fall('dish', -P.DISH_K * 2.5)) return { k: 'dump', t: '📉 有人出货', v: '盘子异动 ' + n1(s.dish) };
    }
    // 天气本身也是「状态」，同样只播上升沿 —— 一场雷暴持续两小时不该弹 8 次
    const pwc = prev ? prev.wcode : 0;
    const stormy = v => v === 95 || v === 96 || v === 99;
    if (stormy(wc) && !stormy(pwc)) return { k: 'storm', t: '⚡ 雷暴', v: 'CAPE ' + s.cape };
    if (rise('gust', 32)) return { k: 'gale', t: '🌀 阵风', v: '阵风 ' + n1(s.gust) + ' m/s' };
    if (rise('cape', 3000)) return { k: 'cape', t: '🌩 对流爆发', v: 'CAPE ' + s.cape };
    if (rise('gust', 25)) return { k: 'gust', t: '🌪 大风', v: '阵风 ' + n1(s.gust) + ' m/s' };
    if (rise('precip', 3)) return { k: 'rain', t: '🌧 短时强降水', v: s.precip + ' mm' };
    if (fall('cape', 50) && s.gust <= 6) return { k: 'calm', t: '🌤 天气转好', v: 'CAPE ' + s.cape };
    return null;
  }

  function flashNews(ev) {
    if (!ev || ev.k === G.lastNews) return;
    G.lastNews = ev.k;
    const p = $('.game-panel');
    if (!p) return;
    const old = p.querySelector('.gg-news');
    if (old) old.remove();
    const d = document.createElement('div');
    d.className = 'gg-news';
    d.innerHTML = '<b>' + ev.t + '</b><span>' + ev.v + '</span>';
    p.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }

  /* ═══════════════ 音效 ═══════════════ */
  let AC = null;
  function beep(freq, dur, type, vol) {
    if (!G.sound) return;
    try {
      AC = AC || new (global.AudioContext || global.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol == null ? .05 : vol, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(.0001, AC.currentTime + dur);
      o.connect(g); g.connect(AC.destination);
      o.start(); o.stop(AC.currentTime + dur);
    } catch (e) { }
  }

  /* ═══════════════ 图表 ═══════════════ */
  function ensureCharts() {
    if (!G.main) {
      G.main = echarts.init($('#ggChart'), null, { renderer: 'canvas' });
      // 绑定一次就够 —— setOption(..., true) 不会把 on() 挂的监听清掉。
      // params.axesInfo[0].value 是 x 轴的**类别名**，用 indexOf 反查下标。
      G.main.on('updateAxisPointer', ev => {
        try {
          const ai = ev && ev.axesInfo && ev.axesInfo[0];
          if (!ai) return;
          const cats = (G.main.getOption().xAxis[0] || {}).data || [];
          const k = cats.indexOf(ai.value);
          // 记住鼠标停在第几根：liveTick 的 10Hz 重绘要不抢悬停读数，
          // 否则鼠标按住某一根看的时候，左上角那行会被"最新一根"顶掉。
          if (k >= 0) { G.hoverIdx = (G._from || 0) + k; updateOhlc(G.hoverIdx); renderPress(); }
        } catch (e) { }
      });
      // 鼠标离开图表就回到最新一根
      G.main.getZr().on('globalout', () => { G.hoverIdx = null; updateOhlc(G.i); renderPress(); });
    }
    if (!G.eqc) G.eqc = echarts.init($('#ggEqChart'), null, { renderer: 'canvas' });
  }
  function disposeCharts() {
    try { if (G.main) G.main.dispose(); } catch (e) { }
    try { if (G.eqc) G.eqc.dispose(); } catch (e) { }
    G.main = G.eqc = null;
  }

  /** 一屏能看清多少根：容器宽度 ÷ 每根 9px，两端都夹一下 */
  function visBars() {
    const cw = (G.main && G.main.getWidth && G.main.getWidth()) || 900;
    return Math.max(36, Math.min(totalBars(), Math.floor(cw / 9)));
  }

  /** 简单移动平均。返回与 series 等长的数组，前 w−1 根是 null（线自然断开） */
  function movingAvg(src, w) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i].c;
      if (i >= w) sum -= src[i - w].c;
      out.push(i >= w - 1 ? +(sum / w).toFixed(2) : null);
    }
    return out;
  }
  const MA_DEF = [{ w: 5, color: '#f0b90b' }, { w: 20, color: '#7aa2f7' }];
  const REG_C = '#c792ea';   // 区域大盘线的颜色（紫），和 MA5 的黄 / MA20 的蓝分得开
  /* 成交量：真实看盘软件的图底都有一排量柱。天气指数没有成交笔数，所以量柱 = **天气活跃度**，
     拿四个真数据算：降水（求和，最像"放量"）、阵风超过 6 m/s 的部分、CAPE、盘子扰动的绝对值。
     它是个建模出来的量（系数是我们定的），但驱动它的四个量全是真的 —— 图例上写清了叫"活跃度"。 */
  function volOf(s) {
    if (!s) return 0;
    const p = +s.precip || 0, g = +s.gust || 0, c = +s.cape || 0, d = Math.abs(+s.dish || 0);
    return Math.max(0.4, 1 + p * 10 + Math.max(0, g - 6) * 2 + c / 60 + d * 0.5);
  }

  /** 取第 k 格该显示的那根 K 线。最后一格且开盘时段中 → 未收盘那根（live bar）。 */
  function barAt(k) {
    const L = liveAt();
    if (L && k === L.i) return L;
    return G.series[k] || null;
  }

  /**
   * 图表左上角那行读数 —— TradingView / MT4 的图例。
   * 不悬停时跟着最新一根走，鼠标在图上来回划就显示划到的那根。
   */
  function updateOhlc(gi) {
    const box = $('#ggOhlc'); if (!box || !G.series.length) return;
    const k = Math.max(0, Math.min(gi, G.series.length - 1));
    const b = barAt(k); if (!b) return;
    const d = b.c - b.o, col = colorOf(d);
    let ma = '';
    if (G._ma) {
      ma = G._ma.map((a, j) => {
        const v = a[k];
        const m = MA_DEF[j];
        return '<span class="gg-ma' + m.w + '"><i style="background:' + m.color + '"></i>MA' + m.w +
          ' <b>' + (v == null ? '—' : n1(v)) + '</b></span>';
      }).join('&nbsp;&nbsp;');
    }
    box.innerHTML =
      '<em>' + labelAt(k) + '</em>' +
      '开<b style="color:' + col + '">' + n1(b.o) + '</b>' +
      '高<b style="color:' + col + '">' + n1(b.h) + '</b>' +
      '低<b style="color:' + col + '">' + n1(b.l) + '</b>' +
      '收<b style="color:' + col + '">' + n1(b.c) + '</b>' +
      (ma ? '&nbsp;&nbsp;' + ma : '');
  }

  function drawCharts() {
    if (!G.main || !G.eqc || !G.series.length) return;
    const n = Math.min(G.i + 1, G.series.length);
    const cw = (G.main.getWidth && G.main.getWidth()) || 800;
    const want = Math.max(3, Math.floor(cw / 76));
    const vis = visBars();
    const from = Math.max(0, n - vis);
    G._from = from;

    // 「未收盘的那根」：把 n-1 这一格换成 live bar，它逐帧在动。
    // 注意**不是往后加一根** —— 真实行情软件里那根未收盘的蜡烛本来就占着最后一个格子，
    // 加一根会让横轴在收盘时整体左移一格、看着像画面抖了一下。
    // 数组的构造在 liveNote() 里，liveTick() 的 10Hz 局部重绘吃的是同一份，口径不会漂。
    const d = liveNote(from, n);
    const live = d.L, xs = d.xs, bars = d.bars, vols = d.vols;
    let lo = d.lo, hi = d.hi;
    // 均线：真实看盘软件都有，而且它让「现在处在什么位置」一眼可见。
    // 注意要拿**整段** series 算再切片 —— 只拿可视段算的话，每次窗口滑动
    // 均线都会整体跳一下，看着像在抽搐。
    const maAll = MA_DEF.map(d => movingAvg(G.series, d.w));
    G._ma = maAll;
    const maVis = maAll.map(a => a.slice(from, n));
    maVis.forEach(a => a.forEach(v => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
    // 大盘线：不进 Y 轴范围计算 —— 它是参考指标，把它算进去会把蜡烛压扁。
    // 注意 regLine 已经是**本局窗口**那一截了（长度 = roundBars()），不用再加 regFrom。
    const regVis = G.regLine ? G.regLine.slice(from, n) : null;
    // 把 Y 轴拉开到能容纳「持仓均价」—— 否则入场线落在可视范围外时，
    // ECharts 会把它贴到坐标轴边缘，看起来像"价格就在最底下"，是骗人的。
    // 强平价只在**离得够近**时才纳入：1 倍杠杆下它在 90% 以外、10 倍下也在 10% 以外，
    // 硬拉进来会把蜡烛压成上面一小撮（试过 0.9 倍跨度的阈值，10 倍杠杆就把图压掉一半）。
    if (G.pos && isFinite(lo) && isFinite(hi)) {
      lo = Math.min(lo, G.avg); hi = Math.max(hi, G.avg);
      const lp0 = liqPriceOf();
      if (lp0 != null && isFinite(lp0)) {
        const span = (hi - lo) || 1;
        if (lp0 > lo - span * 0.25 && lp0 < hi + span * 0.25) { lo = Math.min(lo, lp0); hi = Math.max(hi, lp0); }
      }
    }
    // 挂着的单子也拉进可视范围 —— 挂单挂在天边看不见的话，跟没挂一样没感觉。
    // 但也别把轴拉爆：离得太远的（超过可视跨度 1.5 倍）就不管它，右侧列表里还有。
    if (G.orders.length && isFinite(lo) && isFinite(hi)) {
      const span0 = (hi - lo) || 1;
      G.orders.forEach(o => {
        if (o.price > lo - span0 * 1.5 && o.price < hi + span0 * 1.5) {
          lo = Math.min(lo, o.price); hi = Math.max(hi, o.price);
        }
      });
    }
    const yPad = ((hi - lo) || 1) * 0.08;
    const yMin = isFinite(lo) ? +(lo - yPad).toFixed(2) : undefined;
    const yMax = isFinite(hi) ? +(hi + yPad).toFixed(2) : undefined;

    const marks = [];
    // 现价水平线：横贯整张图，眼睛不用去找最后一根 K 线在哪
    if (G.i) marks.push({ yAxis: G.price, lineStyle: { color: 'rgba(255,255,255,.20)', type: 'solid', width: 1 } });
    if (G.pos) {
      marks.push({
        yAxis: G.avg, lineStyle: { color: THEME.ac, type: 'dashed', width: 1 },
        label: { formatter: '持仓均价 ' + n1(G.avg), color: THEME.ac, fontSize: 10, position: 'insideEndTop' }
      });
      const lp = liqPriceOf();
      if (lp != null && isFinite(lp)) {
        marks.push({
          yAxis: lp, lineStyle: { color: THEME.down, type: 'dotted', width: 1.2 },
          label: { formatter: '强平价 ' + n1(lp), color: THEME.down, fontSize: 10, position: 'insideEndBottom' }
        });
      }
    }
    // 挂单：限价用青色点线、止损用绿、止盈用红
    const ORD_C = { limit: '#4fc3f7', sl: THEME.down, tp: THEME.up };
    G.orders.forEach(o => {
      const tag = o.kind === 'limit' ? (o.dir > 0 ? '挂多 ' : '挂空 ') : (o.kind === 'sl' ? '止损 ' : '止盈 ');
      marks.push({
        yAxis: o.price, lineStyle: { color: ORD_C[o.kind], type: 'dotted', width: 1, opacity: .9 },
        label: {
          formatter: tag + n1(o.price) + (o.kind === 'limit' ? ' ×' + o.lots : ''),
          color: ORD_C[o.kind], fontSize: 9, position: 'insideStartTop'
        }
      });
    });

    G.main.setOption({
      animation: false,
      backgroundColor: 'transparent',
      // 两个 grid：上面蜡烛、下面量柱。真实看盘软件的标配。
      grid: [
        { left: 56, right: 58, top: 24, bottom: '32%' },
        { left: 56, right: 58, bottom: 30, height: '20%' }
      ],
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)',
        borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 },
        axisPointer: { type: 'cross', label: { backgroundColor: '#2a3140' } },
        formatter: p => {
          // 两个 grid 都在 trigger:'axis' 的范围内，所以不能直接拿 p[0] —— 认名字
          const it = (p && (p.find(x => x.seriesName === 'WXI') || p[0]));
          if (!it) return '';
          const gi = from + it.dataIndex;
          // 顺手把左上角读数也切到这一根。ECharts 的 updateAxisPointer 事件
          // 只在鼠标真实移动时触发，程序化 showTip 不会 —— 两边都挂才稳。
          updateOhlc(gi);
          const b = G.series[gi], s = G.seeds[gi] || {};
          const d = b.c - b.o, dp = b.o ? d / b.o * 100 : 0;
          return labelAt(gi) +
            '<br/>开 <b>' + n1(b.o) + '</b>　高 <b>' + n1(b.h) + '</b>' +
            '<br/>低 <b>' + n1(b.l) + '</b>　收 <b>' + n1(b.c) + '</b>' +
            '<br/>涨跌 <b style="color:' + colorOf(d) + '">' + (d >= 0 ? '+' : '') + n1(d) +
            '　' + (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%</b>' +
            '<br/><span style="opacity:.7">活跃度 ' + volOf(s).toFixed(1) + '</span>' +
            '<br/><span style="opacity:.7">CAPE ' + (s.cape == null ? '—' : s.cape) +
            '　阵风 ' + (s.gust == null ? '—' : n1(s.gust)) + ' m/s　降水 ' +
            (s.precip == null ? '—' : s.precip) + ' mm</span>';
        }
      },
      xAxis: [
        {
          gridIndex: 0,
          type: 'category', data: xs, boundaryGap: true,
          axisLine: { lineStyle: { color: THEME.line } },
          axisLabel: { color: THEME.dim, fontSize: 10, hideOverlap: true, interval: Math.max(0, Math.ceil(xs.length / want) - 1) },
          axisTick: { show: false }
        },
        {
          gridIndex: 1,
          type: 'category', data: xs, boundaryGap: true,
          axisLine: { lineStyle: { color: THEME.line } },
          axisLabel: { show: false }, axisTick: { show: false }
        }
      ],
      yAxis: [
        {
          gridIndex: 0,
          type: 'value', scale: true, min: yMin, max: yMax,
          axisLabel: { color: THEME.dim, fontSize: 10, formatter: v => v.toFixed(0) },
          // 十字光标的纵向读数：默认会给成 1,103.96 这种带千分位两位小数，太啰嗦
          axisPointer: { label: { formatter: p => (+p.value).toFixed(1), backgroundColor: '#2a3140' } },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } }
        },
        {
          gridIndex: 1,
          type: 'value', scale: true, splitNumber: 2,
          name: '活跃度', nameTextStyle: { color: THEME.dim, fontSize: 9, align: 'right' },
          axisLabel: { color: THEME.dim, fontSize: 9, formatter: v => (v >= 100 ? Math.round(v) : v.toFixed(0)) },
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.035)' } }
        }
      ],
      series: [{
        name: 'WXI', type: 'candlestick', data: bars, z: 3,
        xAxisIndex: 0, yAxisIndex: 0,
        barMaxWidth: 14,
        itemStyle: {
          color: THEME.up, color0: THEME.down,
          borderColor: THEME.up, borderColor0: THEME.down
        },
        markLine: marks.length ? { silent: true, symbol: 'none', data: marks } : undefined
      }, {
        name: '活跃度', type: 'bar', data: vols, z: 2,
        xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 14, silent: true
      }].concat(MA_DEF.map((d, k) => ({
        name: 'MA' + d.w, type: 'line', data: maVis[k], z: 4,
        xAxisIndex: 0, yAxisIndex: 0,
        showSymbol: false, smooth: false, connectNulls: false, silent: true,
        lineStyle: { width: 1.1, color: d.color, opacity: .85 }
      }))).concat(G.regLine ? [{
        // 区域大盘：把同省 8 城的天气压成一条线，和本地标的画在一起看背离。
        // 它**不是可交易的合约**，只当参考指标（所以 silent + 不参与 tooltip 之外的计算）。
        name: '大盘', type: 'line', data: regVis, z: 2,
        xAxisIndex: 0, yAxisIndex: 0,
        showSymbol: false, smooth: true, connectNulls: false, silent: true,
        lineStyle: { width: 1.2, color: REG_C, opacity: .8, type: 'dashed' }
      }] : [])
    }, true);
    G.liveOn = !!live;              // live bar 会不会显示（没有就跳过 10Hz 的局部重绘）
    updateOhlc(G.i < 0 ? 0 : G.i);   // 没有悬停时，读数跟着最新一根走

    // 权益图的基准标签：本金可改，这个数字必须跟着走（原来写死在 HTML 里，改成 30 万后就不对了）
    const eqb = $('#ggEqBase');
    if (eqb) eqb.textContent = '¥' + G.cash0.toLocaleString('en-US');

    // ── 现价标签：贴在右侧价格轴上，就是 MT4 那条「当前价」──
    // 开盘时段中贴的是 live bar 的收盘（屏幕上那根蜡烛的收），不是"上一根的真收盘"。
    const tag = $('#ggLastTag');
    if (tag) {
      const last = barAt(Math.min(G.i, G.series.length - 1));
      const c = (last && last.c >= last.o) ? THEME.up : THEME.down;
      tag.textContent = n1(G.price);
      tag.style.background = c;
      try {
        const py = G.main.convertToPixel({ yAxisIndex: 0 }, G.price);
        if (py != null && isFinite(py)) tag.style.top = Math.round(py) + 'px';
      } catch (e) { }
    }

    // 大单爆点：最后一根波动特别大就闪一下
    if (n > from + 1) {
      const b = barAt(n - 1), d = b ? (b.c - b.o) : 0;
      if (Math.abs(d) / Math.max(1, b ? b.o : 1) > 0.025) floatText((d > 0 ? '▲ +' : '▼ ') + n1(d), colorOf(d), 30);
    }

    const e = G.hist.length ? G.hist : [G.cash];
    const base = G.cash0;
    const col = colorOf(e[e.length - 1] - base);
    const eqFrom = Math.max(0, e.length - vis);
    G.eqc.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 56, right: 58, top: 8, bottom: 16 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)',
        borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 },
        formatter: p => { const it = p[0]; return it ? labelAt(eqFrom + it.dataIndex) + '<br/>权益 <b>' + money(it.value) + '</b>' : ''; }
      },
      xAxis: {
        type: 'category', data: xs.slice(0, Math.max(1, e.length - eqFrom)), boundaryGap: true,
        axisLine: { lineStyle: { color: THEME.line } }, axisLabel: { show: false }, axisTick: { show: false }
      },
      yAxis: { type: 'value', scale: true, axisLabel: { color: THEME.dim, fontSize: 9, formatter: v => Math.round(v / 1000) + 'k' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } } },
      series: [{
        name: '权益', type: 'line', data: e.slice(eqFrom), showSymbol: false,
        lineStyle: { width: 1.4, color: col },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: col + '40' }, { offset: 1, color: col + '00' }]) },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: base, lineStyle: { color: 'rgba(255,255,255,.22)', type: 'dashed', width: 1 }, label: { formatter: '本金', color: THEME.dim, fontSize: 9, position: 'insideEndTop' } }] }
      }]
    }, true);
  }

  /* ═══════════════ 盘中局部重绘（TICK_HZ Hz） ═══════════════
     半根那一步不能调 render()：那个函数会把右栏全部 innerHTML 重建一遍（成交记录、
     挂单列表、天气日历、下单预估卡…），1 日档下每秒来几十次纯属浪费。
     这里只做两件事：① 把最后一格蜡烛/量柱 patch 成 live bar；② 更新跟着价格走的几个数字。

     ⚠ setOption 这里**不能传 true**（notMerge）：传了就只认这一小份 option，
       横轴类别、均线、大盘线、dataZoom 全会被清掉。默认合并模式下，
       只给 series[0].data 的最后一项，其余字段原样保留。 */
  function liveTick() {
    if (!G.main || !G.series.length || !G.liveOn) return;
    const L = liveAt(); if (!L) return;
    const n = Math.min(G.i + 1, G.series.length);
    const from = Math.max(0, n - visBars());
    const d = liveNote(from, n);
    if (!d.bars.length) return;

    const marks = [{ yAxis: +G.price.toFixed(2), lineStyle: { color: 'rgba(255,255,255,.20)', type: 'solid', width: 1 } }];
    if (G.pos) {
      marks.push({
        yAxis: G.avg, lineStyle: { color: THEME.ac, type: 'dashed', width: 1 },
        label: { formatter: '持仓均价 ' + n1(G.avg), color: THEME.ac, fontSize: 10, position: 'insideEndTop' }
      });
      const lp = liqPriceOf();
      if (lp != null && isFinite(lp)) {
        marks.push({
          yAxis: lp, lineStyle: { color: THEME.down, type: 'dotted', width: 1.2 },
          label: { formatter: '强平价 ' + n1(lp), color: THEME.down, fontSize: 10, position: 'insideEndBottom' }
        });
      }
    }
    try {
      // ⚠ 均线和大盘线也要跟着**实时窗口**一起滚。
      //   它们是在整份 option 里按当时的 from..n 切好的，而 liveTick 每帧只换
      //   series[0]（蜡烛）和 series[1]（活跃度）—— 窗口一往前走，这两条线还停在
      //   旧位置上，几根之后就被甩出可视区。用户看到的就是"某条线过一会儿不见了"
      //   （竖屏可视根数少，窗口滑得更快，所以手机上更容易撞见）。
      const extra = [];
      if (G._ma) G._ma.forEach(a => extra.push({ data: a.slice(from, n) }));
      if (G.regLine) extra.push({ data: G.regLine.slice(from, n) });
      G.main.setOption({
        series: [
          { data: d.bars, markLine: { silent: true, symbol: 'none', data: marks } },
          { data: d.vols }
        ].concat(extra)
      }, false, true);   // notMerge=false 保留其余字段；lazyUpdate=true 交给 ECharts 合并到下一帧画
    } catch (e) { /* 合并失败就算了，下一根收盘时 render() 会整个重画 */ }

    // 左上角读数：没有悬停时应该跟着这根在动的蜡烛走
    const hov = G.hoverIdx;
    updateOhlc(hov == null ? L.i : hov);
    syncPriceUI();
    renderLiveNums();
  }

  /* ═══════════════ 跟着价格走的那些数字 ═══════════════
     拆出来是为了 liveTick()：盘中（半根那一步）只有价格在变，别的一律不动。
     凡是"随价格实时变"的读数都收在这里，render() 和 liveTick() 共用一份，
     免得两处各写一遍、迟早对不上。 */

  /** 终端行情条：买卖价 / 点差 / 品种 / 大号下单键上的价格。
   *  行情时间与连接状态是**整根**概念（"第 3 天 14:15" 对的是那根蜡烛的标签），
   *  盘中不动，所以留在 render() 里。 */
  function syncPriceUI() {
    const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    const px = (G.pos || G.i) ? G.price : 0;
    if (!px) {
      ['#ggTbSell', '#ggTbBuy', '#ggTbSpread', '#ggTbTime', '#ggLongPx', '#ggShortPx'].forEach(s => setT(s, '—'));
      setT('#ggTbConn', '未开局');
      return;
    }
    // 「点差」显示的是**真实成本**：一手开 + 平两次手续费，既折成指数点也给出金额
    const costYuan = px * LOT_MULT * FEE_RATE * 2;
    setT('#ggTbSell', n1(px));
    setT('#ggTbBuy', n1(px));
    setT('#ggTbSpread', (px * FEE_RATE * 2).toFixed(1) + ' 点');
    const cost = $('#ggTbSpread');
    if (cost) cost.title = '一手开+平的手续费，合计 ¥' + costYuan.toFixed(2);
    const lp2 = $('#ggLongPx'), sp2 = $('#ggShortPx');
    if (lp2) lp2.textContent = n1(px);
    if (sp2) sp2.textContent = n1(px);
    setT('#ggTbConn', G.ended ? '已收盘' : (G.running ? '行情推送中' : '已暂停'));
  }

  /** 账户明细里**随价格实时变**的那几行 + 权益大数字 + 挂单距离。
   *  市值口径全部走 equity()/unreal()，而它俩读的是 G.price —— 盘中就是 live 价，
   *  所以浮盈浮亏、可用保证金、爆仓距离都是逐帧在动的。 */
  function renderLiveNums() {
    const e = equity(), diff = e - G.cash0, pct = diff / G.cash0 * 100;
    const col = colorOf(diff);
    const eqEl = $('#ggEquity');
    if (eqEl) {
      const txt = n0(e);
      if (eqEl.textContent !== txt) {
        /* ⚠ `void offsetWidth` 会**强制同步回流**。原来 10 Hz 下每次权益数字变化都触发，
           提到 30 Hz 后刷新更频繁 —— 必须限流，否则主线程被浏览器布局吃掉。
           120 ms 一次足够看清"跳一下"的动效（人眼也分不出更快的）。 */
        const now = Date.now();
        if (!G._popAt || now - G._popAt > 120) {
          G._popAt = now;
          eqEl.classList.remove('gg-pop');
          void eqEl.offsetWidth;
          eqEl.classList.add('gg-pop');
        }
        eqEl.textContent = txt;
      }
      eqEl.style.color = col;
    }
    const chgEl = $('#ggEqChg');
    if (chgEl) {
      chgEl.textContent = sgnMoney(diff) + '　(' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
      chgEl.style.color = col;
    }

    const mu = marginUsed(), lp = liqPriceOf();
    const rows = [
      ['WXI 现价', (G.pos || G.i) ? n1(G.price) : '—', 0],
      ['可用保证金', money(freeEq()), freeEq() < 0 ? -1 : 0],
      ['占用保证金', G.pos ? money(mu) : '—', 0],
      ['持仓', G.pos ? (G.pos > 0 ? '多 ' : '空 ') + Math.abs(G.pos) + ' 手' : '空仓', G.pos > 0 ? 1 : G.pos < 0 ? -1 : 0],
      ['持仓均价', G.pos ? n1(G.avg) : '—', 0],
      ['浮动盈亏', G.pos ? sgnMoney(unreal()) : '—', G.pos ? Math.sign(unreal()) : 0],
      ['强平价', (G.pos && lp != null && isFinite(lp)) ? n1(lp) : '—', 0],
      ['爆仓距离', (G.pos && lp != null && isFinite(lp) && G.price) ? (Math.abs(G.price - lp) / G.price * 100).toFixed(2) + '%' : '—', 0]
    ];
    const box = $('#ggStats');
    if (box) {
      /* ⚠ 必须"没变就不写 DOM"。这里是整块 innerHTML 重建，而 renderLiveNums() 每个
         tick 都跑 —— 原来 10 Hz 时每秒 10 次已经偏重，提到 30 Hz 就是每秒 30 次整树重建，
         会把主线程吃掉、蜡烛反而更卡。
         加了这个值比较之后：读数没变（价格只动了零点几个点时 n1() 出来是一样的）
         就一次 DOM 都不碰。这也是能把 TICK_HZ 提到 30 的前提。 */
      const html = rows.map(r =>
        '<div class="gg-row' + (r[2] < 0 ? ' gg-warn-row' : '') + '"><span>' + r[0] + '</span><span style="color:' +
        (r[2] ? colorOf(r[2]) : '') + '">' + r[1] + '</span></div>'
      ).join('');
      if (html !== G._statsHtml) { G._statsHtml = html; box.innerHTML = html; }
    }

    // 挂单列表里那个"离现价还有几个点"也要跟着动，否则盘中看到的距离是过期的
    const ordBox = $('#ggOrders');
    if (ordBox && G.orders.length) {
      const oHtml = G.orders.map(o => {
        const isL = o.kind === 'limit';
        const c2 = isL ? '#4fc3f7' : (o.kind === 'sl' ? THEME.down : THEME.up);
        const name = isL ? (o.dir > 0 ? '限价多' : '限价空') : (o.kind === 'sl' ? '止损' : '止盈');
        const dist = G.price ? ((o.price - G.price) / G.price * 100) : 0;
        return '<div class="gg-o"><span style="color:' + c2 + '">' + name + '</span>' +
          '<span>' + (isL ? o.lots + ' 手' : '全平') + '</span>' +
          '<span>' + n1(o.price) + '</span>' +
          '<span class="dim">' + (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%</span>' +
          '<button class="gg-x" data-cancel="' + o.id + '" title="撤单">×</button></div>';
      }).join('');
      if (oHtml !== G._ordHtml) { G._ordHtml = oHtml; ordBox.innerHTML = oHtml; }
    }

    // 保证金告急的边框脉冲
    const panel = $('.game-panel');
    if (panel) {
      const ratio = mu > 0 ? e / mu : 9;
      panel.classList.toggle('danger2', mu > 0 && ratio < 1 + MAINTAIN * 3);
      panel.classList.toggle('danger', mu > 0 && ratio < 1 + MAINTAIN * 9 && ratio >= 1 + MAINTAIN * 3);
    }
    const live = $('#ggLive');
    if (live) {
      const hot = mu > 0 && e < mu * 2;
      live.textContent = G.ended ? '已收盘' : (G.running ? (hot ? '⚠ 保证金告急' : '做盘中') : '已暂停');
      live.className = 'gg-live' + (G.ended || !G.running ? ' off' : hot ? ' hot' : '');
    }
  }

  /* ═══════════════ 面板渲染 ═══════════════ */
  /* ═══════════════ 多维压力表 ═══════════════
     把"天气好坏"拆回六个维度，各自显示：当前值 / 近 7 天分位 / 方向 / **对指数贡献多少点**。

     ★ 它是"先画靶子再射箭"的：六个维度的数值全部**在 pickSeries 里算好、存进 seeds**
       （`cparts` / `ctotal` / `cpct` / `cdir`），这里**只做读取和排版**。
       分位是拿本局窗口的整段分布算的 —— 放在渲染里每帧扫 3552 点 × 6 维会白烧 CPU。

     ★ 最后一行"合计"就是这一格的舒适度，和指数那边**共用同一份计算**
       （comfort() = Σ contrib）。所以面板不是在讲故事，而是指数的另一种读法。

     为什么用**分位**而不是绝对值：玩家看到"31.4℃"没有直觉，
     但"近 7 天 88% 分位"立刻能懂 —— 和行情里的 RSI 88 是一回事。 */
  function renderPress() {
    const box = $('#ggPress');
    if (!box || !G.seeds || !G.seeds.length) return;
    // 没悬停时跟着最新一根走（和左上角读数同一个口径）
    const hov = G.hoverIdx;
    const k = (hov == null) ? Math.min(G.i, G.seeds.length - 1) : Math.max(0, Math.min(G.seeds.length - 1, hov));
    const s = G.seeds[k];
    if (!s || !s.cparts) {
      if (box.innerHTML !== '<div class="gg-empty">等待天气数据…</div>') {
        box.innerHTML = '<div class="gg-empty">等待天气数据…</div>';
      }
      return;
    }
    const cp = s.cparts;
    // 分位 → 颜色：越靠两端越显眼。低分位 = 这一维很差（对指数是拖累），用红；高分位用绿
    const colOf = p => p >= 0.8 ? THEME.up : p <= 0.2 ? THEME.down : 'rgba(255,255,255,.45)';
    const rows = DIMS.map(d => {
      const x = cp[d.key];
      const p = (s.cpct && s.cpct[d.key] != null) ? s.cpct[d.key] : null;
      const dir = (s.cdir && s.cdir[d.key]) || 0;
      const arrow = dir > 0 ? '↑' : dir < 0 ? '↓' : '→';
      const valTxt = x.v == null ? '—' : d.fmt(x.v);
      const pctTxt = p == null ? '—' : (p * 100).toFixed(0) + '%';
      const barW = p == null ? 0 : Math.max(2, Math.min(100, p * 100));
      return '<div class="gg-pr" title="' + d.nm + ' 得分 ' + x.score.toFixed(0) + '/100，' +
          '对舒适度贡献 ' + x.contrib.toFixed(1) + ' 分（满分 ' + (d.w * 100).toFixed(0) + '）">' +
        '<span class="n">' + d.nm + '</span>' +
        '<span class="v">' + valTxt + (d.unit ? '<i>' + d.unit + '</i>' : '') + '</span>' +
        '<span class="gg-bar"><i style="width:' + barW.toFixed(0) + '%;background:' + colOf(p == null ? 0.5 : p) + '"></i></span>' +
        '<span class="d" style="color:' + (dir > 0 ? THEME.up : dir < 0 ? THEME.down : THEME.dim) + '">' + arrow + '</span>' +
        '<span class="c">' + pctTxt + '</span>' +
      '</div>';
    }).join('');
    const total = s.ctotal;
    const html = rows +
      '<div class="gg-pr sum"><span class="n">舒适度合计</span>' +
      '<span class="c" style="color:' + (total >= 70 ? THEME.up : total <= 50 ? THEME.down : THEME.fg) + '">' +
      total.toFixed(1) + ' / 100</span></div>';
    /* ⚠ 必须"没变就不写"：renderLiveNums() 每 tick 都跑，这里是整块 innerHTML 重建。
       面板只在**换格或悬停位置变了**才需要重画，所以用 k + 内容一起做缓存键。 */
    const key = k + '|' + html;
    if (key !== G._pressKey) { G._pressKey = key; box.innerHTML = html; }
  }

  function render() {
    // 权益大数字、账户明细、保证金告急、挂单距离这些都**随价格实时变**，
    // 所以统一由 renderLiveNums() 画 —— 盘中那一刻也复用它。
    renderLiveNums();
    renderPress();

    const sub = $('#ggSub');
    if (sub) {
      const mm = (G.i % perDay()) * barMin();
      // 进度按**交易段**算：预热那一周是白送的，不该让分母变成 37 天。
      const done = Math.max(0, Math.min(tradeBars(), G.i + 1 - warmBars()));
      const when = G.series.length
        ? ('第 ' + (Math.floor(G.i / perDay()) + 1) + ' 天 ' + U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60) +
          '　·　已交易 ' + done + ' / ' + roundBars() + ' 根　·　' + G.lev + ' 倍杠杆')
        : '—';
      sub.textContent = G.city ? (G.city.name + ' WXI 天气指数　·　' + when) : when;
    }

    const lots = Math.floor(maxLots() * G.pct / 100);
    const lab = $('#ggLots');
    if (lab) lab.textContent = G.pct + '% ≈ ' + lots + ' 手' + (lots < 1 ? '（不够 1 手）' : '');

    // ── 下单预估：名义仓位 / 开仓手续费 / 可承受反向波动 ──
    const tPct = tolerablePct(G.pct);
    const calc = $('#ggCalc');
    if (calc) {
      const notional = lots * G.price * LOT_MULT;
      const openFee = Math.max(FEE_MIN, notional * FEE_RATE);
      // 预估滑点：这一单开进去要吃掉多少点、折成钱是多少、占本金几个百分点。
      // 把它明明白白摆出来，玩家才能感觉到「钱多不等于好做」——
      // 这个数与本金成正比，而且小城市还要再乘 dishScale。
      const slip = lots ? slipOf(lots) : 0;
      const slipYuan = lots ? Math.abs(lots) * slip * LOT_MULT : 0;
      const slipOnCap = (lots && G.cash0) ? (slipYuan / G.cash0 * 100) : 0;
      const slipCls = slipOnCap >= 1 ? ' gg-danger' : (slipOnCap >= 0.3 ? '' : ' gg-safe');
      const keyCls = tPct == null ? '' : (tPct < 3 ? ' gg-danger' : (tPct > 12 ? ' gg-safe' : ''));
      calc.innerHTML =
        '<div class="gg-crow"><span>名义仓位</span><b>' + (lots ? money(notional) : '—') + '</b></div>' +
        '<div class="gg-crow"><span>开仓手续费</span><b>' +
        (lots ? '¥' + openFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—') +
        '</b></div>' +
        '<div class="gg-crow gg-key' + slipCls + '"><span>预估滑点</span><b>' +
        (lots ? (slip.toFixed(2) + ' 点 · ¥' + slipYuan.toFixed(0) + ' · 本金 ' + slipOnCap.toFixed(2) + '%') : '—') +
        '</b></div>' +
        '<div class="gg-crow gg-key' + keyCls + '"><span>约可承受反向波动</span><b>' +
        (tPct == null ? '—' : tPct.toFixed(2) + '%') + '</b></div>';
    }

    // ── 成交记录 ──
    const fills = $('#ggFills'), tcount = $('#ggTrades');
    if (tcount) tcount.textContent = G.trades + ' 笔';
    if (fills) {
      if (!G.fills || !G.fills.length) fills.innerHTML = '<div class="gg-empty">还没下过单</div>';
      else fills.innerHTML = G.fills.map(f => {
        const col = f.kind.indexOf('多') >= 0 ? THEME.up : THEME.down;
        return '<div class="gg-f"><span>' + labelAt(f.at) + '</span>' +
          '<span style="color:' + col + '">' + f.kind + ' ' + f.lots + ' 手</span>' +
          '<span>' + n1(f.px) + '</span></div>';
      }).join('');
    }

    // ── 挂单列表 ──
    // 逐条内容（含"离现价几个点"）由 renderLiveNums() 画，盘中那一刻会重画它；
    // 这里只需要把"没有挂单"这个空状态和右上角计数补上。
    const ordBox = $('#ggOrders'), ordTip = $('#ggOrdTip');
    if (ordBox && !G.orders.length) ordBox.innerHTML = '<div class="gg-empty">没有挂单</div>';
    if (ordTip) {
      const nL = G.orders.filter(o => o.kind === 'limit').length;
      const nS = G.orders.length - nL;
      ordTip.textContent = G.orders.length ? (nL + ' 个限价 · ' + nS + ' 个止损止盈') : '碰到价才成交';
    }

    // ── 天气日历 ──
    // 注意别用 setT：它是在这个函数下面才 const 出来的，从这里调会踩 TDZ
    const calBox = $('#ggCal'), calTip = $('#ggCalTip');
    if (calBox) {
      const evs = calendarAt(G.i, perDay());
      if (calTip) calTip.textContent = '未来 24 小时 · ' + (evs.length ? evs.length + ' 次变天' : '风平浪静');
      if (!evs.length) {
        calBox.innerHTML = '<div class="gg-empty">接下来一天没什么动静</div>';
      } else {
        calBox.innerHTML = evs.slice(0, 6).map(e => {
          // 强度档是按实测 |Δsev| 分布定的：整局中位 0.06、p99 约 1.7、max 约 2.5，
          // 门槛 P.JUMP_AT=0.9 之上才进日历。所以「剧烈」是真的少见。
          const bars = Math.min(4, Math.max(1, Math.ceil(e.d / 0.7)));
          const when = labelAt(e.from) + (e.to > e.from ? '–' + labelAt(e.to).replace(/^D\d+ /, '') : '');
          return '<div class="gg-c"><span>' + when + '</span>' +
            '<i class="t' + bars + '">' + '▮'.repeat(bars) + '</i>' +
            '<b>' + (e.d >= 2.0 ? '剧烈' : e.d >= 1.3 ? '明显' : '一般') + '</b></div>';
        }).join('');
      }
    }

    const bl = $('#ggLong'), bs = $('#ggShort');
    if (bl && bs) bl.disabled = bs.disabled = (G.ended || !G.running || lots < 1);
    const bc = $('#ggClosePos');
    if (bc) bc.disabled = !G.pos;

    // ── 终端行情条 + 大号下单键上的价格 ──
    // 学 MT4/MT5：买卖价直接印在按钮上，不用先去看报价再回来点。
    // 「点差」这里显示的是**真实成本**：一手开+平的两次手续费，
    // 既折算成指数点数也给出金额 —— 不是装样子的假数字。
    syncPriceUI();
    // 行情时间 / 连接状态 / 速度提示是**整根**概念，盘中不动，所以留在这里
    {
      const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
      setT('#ggSym', (G.city ? G.city.name : 'WXI') + ' WXI');
      // 把大盘是由哪几个城市平均出来的写进 title，鼠标停一下就能看到
      const symEl = $('#ggSym');
      if (symEl) symEl.title = G.regCities && G.regCities.length
        ? ('区域大盘 = ' + G.regCities.join(' / ') + ' 的等权平均（15 分钟，同省最多 8 城）')
        : '这台设备的区域大盘取不到，本局是纯本地行情';
      if (G.series.length) {
        const mm = (G.i % perDay()) * barMin();
        setT('#ggTbTime', '第 ' + (Math.floor(G.i / perDay()) + 1) + ' 天 ' +
          U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60));
      }
      // 「行情速度」那一行右边实时报一局大概要跑多久 —— 光看数字没有体感
      const secs = roundSecs();
      setT('#ggSpeedTip', '一局约 ' + (secs >= 90 ? (secs / 60).toFixed(1) + ' 分钟' : Math.round(secs) + ' 秒'));
    }

    drawCharts();
  }

  function floatText(txt, color, size) {
    const panel = $('.game-panel');
    if (!panel) return;
    const d = document.createElement('div');
    d.className = 'gg-float'; d.textContent = txt; d.style.color = color;
    if (size) d.style.fontSize = size + 'px';
    d.style.left = (16 + Math.random() * 44) + '%';
    d.style.top = '34%';
    panel.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  /* ═══════════════ 主循环 ═══════════════ */
  /** 一帧推进多少根 K 线。
   *  速度的单位是「每真实秒推进多少分钟天气」，换成根就是 SPEEDS/barMin()，
   *  再除以帧率。**必须用小数累加器**：1 分钟档在「慢」速下只有
   *  15/1/10 = 1.5 根/秒，每帧 0.15 根，取整就永远是 0 了。
   *  一帧可能推进好几根（60 分钟档 + 狂暴 = 90/60/10 = 0.15 根/帧，不会；
   *  但 1 分钟档 + 狂暴 = 90/1/10 = 9 根/帧），所以循环里逐根走、
   *  只在整批结束后 render 一次。挂单/爆仓仍然**逐根**判定 —— 影线扫到
   *  止损价就该在那一根成交，不能等这一批走完才看。
   *
   *  ⚠ **没攒够一根时不能再直接 return 了**：那样 1 日档会静止 32 秒。
   *  现在走"半根"分支 —— 保留 G.acc 那个小数，用 live bar 把盘中价体现出来
   *  （见 liveAt()），只做一次局部重绘。 */
  function tick() {
    if (!G.running || G.ended) return;
    G.acc += (SPEEDS[G.speedIdx] / barMin()) / TICK_HZ;
    let step = Math.floor(G.acc);
    G.acc -= step;

    // ── 半根：这一步还没走满一根 K 线，但行情得动 ──
    if (step < 1) {
      const lp = livePrice();
      if (lp !== G.price) { G.price = lp; liveTick(); }
      return;
    }

    const r = stepBars(step, false);
    if (r.why) return;                       // 已经 endRound 了，画面交给它
    if (r.news) flashNews(r.news);

    const mu = marginUsed(), e = equity();
    // 保证金告急的滴答声
    if (mu > 0 && e < mu * 1.6) beep(1180, .05, 'square', .022);
    // 里程碑音效
    if (Math.floor(r.eqBefore / 10000) !== Math.floor(e / 10000)) beep(e > r.eqBefore ? 880 : 320, .09, 'triangle', .035);
    render();
    autoSave();
  }

  /** 把行情往前推 `step` 根 K 线。逐根判定挂单与爆仓 —— 影线扫到止损价就该在那一根成交，
   *  不能等这一批走完才看。返回 `{ why, eqBefore, news }`：`why` 非空表示这一局已经结束。
   *
   *  `silent` 给**离线追赶**用（见 catchUp）：补推几十上百根的时候不能每笔都飘字、都响一声，
   *  也不能逐根重绘。行情本身的推进和判定完全一样 —— 只是不出声、不画面。 */
  function stepBars(step, silent) {
    const eqBefore = equity();
    let news = null;

    for (let k = 0; k < step; k++) {
      if (G.i >= G.series.length - 1) { endRound('timeup'); return { why: 'timeup', eqBefore: eqBefore, news: news }; }

      const prevPx = G.price;
      G.i++;
      // 收盘价是**真采样**：这一根 15 分钟数据最后的那个值。
      const closePx = G.series[G.i].c;
      // 挂单判定要的是「这一根里价格走过的那段区间」，所以用开盘→收盘 + 本根影线，
      // 而不是那个只走到一半的盘中价 —— 否则止损永远只在收盘后才可能被扫到。
      G.price = closePx;

      // 挂单 / 止损止盈先跑，再判爆仓 —— 顺序反了的话，止损单会因为
      // "这一根已经先爆仓了"而永远来不及救你。
      processOrders(prevPx, silent);

      const mu = marginUsed();
      if (mu > 0 && equity() <= mu * MAINTAIN) {
        liquidate();
        G.hist.push(G.cash);
        G.peak = Math.max(G.peak, G.cash);
        trackDD();
        if (!silent) {
          if (global.navigator && navigator.vibrate) { try { navigator.vibrate([80, 60, 220]); } catch (e) { } }
          beep(110, .5, 'sawtooth', .09);
          render();
        }
        endRound('liquidated');
        return { why: 'liquidated', eqBefore: eqBefore, news: news };
      }

      // 权益曲线的采样点仍然**逐根**落（保持和蜡烛一一对应、数组长度不变），
      // 用的是这一根的真收盘；盘中那条曲线由 liveTick 画的浮动值来体现。
      const e = equity();
      G.hist.push(e);
      G.peak = Math.max(G.peak, e);
      trackDD();

      // 天气事件闪报（数值全是真的）；一帧走多根时只留最后一条，
      // 否则狂暴速下飘字会糊满屏幕
      const nw = newsAt(G.i);
      if (nw) news = nw;
    }

    return { why: null, eqBefore: eqBefore, news: news };
  }
  function trackDD() { const e = equity(); if (G.peak > 0) G.maxDD = Math.max(G.maxDD, (G.peak - e) / G.peak); }

  function startTimer() {
    stopTimer();
    G.acc = 0;
    G.timer = setInterval(tick, 1000 / TICK_HZ);
  }
  function stopTimer() { if (G.timer) { clearInterval(G.timer); G.timer = null; } }

  /* ═══════════════ 一局的生命周期 ═══════════════ */
  function resetState() {
    // 开局光标停在**预热段的最后一根**上：前面一周（7 天）的 K 线已经画好、已经走完了，
    // 你从下一根开始交易。所以第一根能下单的 K 线是 series[warmBars()]。
    G.i = Math.max(0, Math.min(G.series.length - 1, warmBars() - 1));
    fbReset();   // 新一局：形成中那根从头开始
    G.price = G.series.length ? G.series[G.i].c : 0;
    G.cash = G.cash0;
    G.pos = 0; G.avg = 0;
    G.peak = G.cash0; G.maxDD = 0; G.trades = 0;
    G.fills = [];
    G.slipPaid = 0; G.feePaid = 0;
    G.orders = []; G.orderSeq = 0;
    G.hist = [G.cash0];
    G.liqPrice = null; G.liqAt = 0; G.lastNews = '';
    G.ended = false;
  }

  async function beginRound() {
    const cover = $('#ggCover');
    const app = global.__APP;
    const city = (app && app.S && app.S.cur) || null;
    if (!city) { toast('先选一个城市'); return; }

    if (cover) cover.innerHTML = '<div class="gg-card"><h2>取行情中…</h2><p>正在取 <b>' + city.name + '</b> 的 15 分钟天气行情</p><p class="dim">本地 92 天的对流能量 / 阵风 / 降水，外加同省城市的大盘，第一次要几秒。</p></div>';

    // 六个源并发取（本地 15 分钟行情 / 同省大盘 / 空气 / 地震 / 台风 / 预报偏离）。
    // 除了本地行情，其余**任何一个拿不到都只是那一项退化成 0**，不影响开局。
    let mn = null, reg = null;
    const extra = { air: null, quake: null, typh: null, fcst: null, lp: null, kp: null };
    try {
      const all = await Promise.all([
        API.OpenMeteo.minutely(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.regionIndex(city).catch(() => null),
        API.OpenMeteo.airHistory(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.quakes(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.typhoons().catch(() => null),
        API.OpenMeteo.previousRuns(city.lat, city.lon).catch(() => null),
        /* 光污染（本地 JSON + PNG，几乎零成本）与 NOAA 的地磁暴 Kp。
           ⚠ 两个都必须在这里就 await 好塞进 extra —— `LP.of()` 是 async，
             而 `pickSeries()` 是**同步**的（它被 try 包着、还要给渲染让路），
             同步函数里 await 不了，只能提前取。 */
        (API.LP && API.LP.of) ? API.LP.of(city.id != null ? city.id : '').catch(() => null) : null,
        (API.SWPC && API.SWPC.kpSeries) ? API.SWPC.kpSeries().catch(() => null) : null
      ]);
      mn = all[0]; reg = all[1];
      extra.air = all[2]; extra.quake = all[3]; extra.typh = all[4]; extra.fcst = all[5];
      extra.lp = all[6]; extra.kp = all[7];
    } catch (e) { mn = null; reg = null; }

    const picked = mn && pickSeries(mn, reg, city, extra);
    if (!picked) {
      if (cover) cover.innerHTML = '<div class="gg-card"><h2 class="lose">取不到行情</h2>' +
        '<p>15 分钟级天气数据没取回来（多半是 Open-Meteo 那边不通或额度用完了）。</p>' +
        '<p class="dim">过一会儿再试，或者换一个城市。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggRetry">再试一次</button>' +
        '<button class="gg-short" id="ggQuit">退出</button></div></div>';
      bindCoverOnce();
      return;
    }

    G.city = city;
    G.series = picked.series;
    G.seeds = picked.seeds;
    G.sev = picked.sevWin;
    G.regLine = picked.regLine;      // 大盘线（没有就是 null，图上也就不画）
    G.regFrom = picked.regFrom || 0;
    G.regCities = picked.regCities;  // 组成大盘的城市名，显示在副图标题上
    G.base = picked.base;            // 15 分钟原样那一份，局中换周期时重采样用
    G.baseSeeds = picked.baseSeeds;
    G.baseReg = picked.baseReg;
    resetState();
    readTheme();
    ensureCharts();
    hideCover();

    G.running = true;
    startTimer();
    render();
  }

  /* ═══ 结算语：欠揍雌小鬼 ═══
     使用者 2026-10-10：「把模拟游戏的结算语改成欠揍雌小鬼的语气（空中飞人那句不改），
     没有结算语也加上结算语。不同评级的结算语做区分，评级越低越嚣张越欠揍。」

     · 分档：**F（爆仓）最嚣张 → E 亏本 → D 白忙 → C 小赚 → B / A「诶？居然」→
       S / SSS 嘴上不认输、心里已经服了**（但绝不正经表扬，那不是这个角色）。
     · 两栏：`v` 是结算卡上那行「这一局发生了什么」的小字，`f` 是最后那句收场白。
       **八档两栏都不空** —— 以前只有爆仓和 S/A/B 有收场白，D/C/E 是一片空白。
     · ⚠ F 档的收场白「最后请欣赏绚丽多彩的空中飞人表演！」**一字不许改**（使用者点名保留）。
     · ⚠ F 档的 `v` 按杠杆分四句，所以不进表、在 settleOf() 里取。
     · ⚠ **结算语里只要提到杠杆，那个数字必须是这一局真实用的那个**（使用者 2026-10-10 追加要求）。
       所以这些句子写成 `lev => '…'` 的函数、按 `G.lev` 现算，**绝不写死「20 倍」这种常量** ——
       杠杆可选 1 / 5 / 10 / 20 / 50 / 100（见 LEVS），写死了迟早对不上。
       `反向约 X%` 的 X 用的是**和「满分规则」那张表同一个模型**：满仓反向 (1−MAINTAIN)/N 就强平，
       于是 10× 约 9%、20× 约 4.5%、50× 约 1.8%、100× 约 0.9% —— 和新手入门里写给玩家看的
       那几个数字必须一模一样（两处对不上，玩家会以为其中一处是错的）。手续费和滑点会让它更早一点。 */
  function blowPct(lev) { return lev > 0 ? Math.round((1 - MAINTAIN) * 1000 / lev) / 10 : 100; }
  const MG_F_V = [
    [50, lev => '杂鱼♡ ' + lev + ' 倍杠杆…那不叫操作，那叫献祭。反向约 ' + blowPct(lev) + '% 就没了，啊哈哈～'],
    [20, lev => lev + ' 倍满仓还敢看天气预报？天台今天风很大吧～要伞吗？不给♡'],
    [10, lev => lev + ' 倍呀…反向约 ' + blowPct(lev) + '% 就直接清零。你赌的是天气，天气又不认识你♡'],
    [0, () => '方向倒是没看错，就是仓位重得像在赌气 —— 一根插针就够啦，杂鱼♡']
  ];
  const MG = {
    F: { v: '', f: '最后请欣赏绚丽多彩的空中飞人表演！' },
    E: { v: '亏了诶～本金都没守住，大叔的「盘感」就这？',
      f: lev => '杂鱼♡ 下次先看天气，再谈' + (lev > 0 ? ' ' + lev + ' 倍杠杆' : '杠杆') + '啦～' },
    D: { v: '忙了一个月，勉强没亏…这也值得高兴吗？好可爱♡',
      f: lev => '诶～就这点水平也敢开' + (lev > 0 ? ' ' + lev + ' 倍？' : '杠杆，') + '我劝你先把天气预报看完再回来♡' },
    C: { v: '哦——赚了一点点呀，好厉害哦（棒读）。手续费交完还剩下多少呢？',
      f: '这水平离「会玩」还差十万八千里呢，杂鱼♡' },
    B: { v: '嗯？居然有五成收益…运气这东西，用完就没啦～',
      f: '别得意哦，这一局是天气帮你的，跟你没关系♡' },
    A: { v: '两倍…唔，勉强算你有两下子。不过我只是没认真而已♡',
      f: '哼，别以为赢了几次就是高手，下次我让你连本都留不住～' },
    S: { v: '三倍以上？！…好啦好啦，这次算你厉害。就这一次哦♡',
      f: '我才没有夸你呢！只是…只是天气偏心而已，笨蛋♡' },
    SSS: { v: '五倍…怎么可能啦！你、你是不是作弊了！',
      f: '…唔，好吧，我承认这次是你赢了。但你要是敢得意，下一局我让你哭着出去♡' }
  };
  /** 取某档的结算语（纯函数，探针可直接调）：返回 { v, f, cls }。
   *  `cls` 只决定收场白的颜色：F/E 红、D/C 中性、B 以上金。 */
  function settleOf(gr, ctx) {
    const lev = Math.max(0, Math.round(+(ctx && ctx.lev) || 0));
    const t = MG[gr] || MG.E;
    // 字符串与 `lev => '…'` 两种写法都收：**提到杠杆的那几句必须是函数**（数字要现算）
    const pick = x => (typeof x === 'function' ? x(lev) : x);
    let v = t.v;
    if (gr === 'F') {
      v = MG_F_V[MG_F_V.length - 1][1];
      for (let i = 0; i < MG_F_V.length; i++) {
        if (lev >= MG_F_V[i][0]) { v = MG_F_V[i][1]; break; }
      }
    }
    const cls = (gr === 'F' || gr === 'E') ? 'bad'
      : (gr === 'SSS' || gr === 'S' || gr === 'A' || gr === 'B') ? 'good' : 'mid';
    return { v: pick(v), f: pick(t.f), cls: cls };
  }

  function endRound(why) {
    G.running = false;
    // 这一局到头了，存档就没意义了 —— 存档记的是"打到一半的那一局"，留着它下次进来会弹
    // 「有一局尚未结束」。结算卡上有「退出」可以清，但**用户完全可能直接关掉页面/标签**，
    // 那条路走不到 exitFlow，所以在这里就清掉（覆盖所有结局）。
    clearSave();
    G.ended = true;
    stopTimer();

    const finalEq = (why === 'liquidated') ? G.cash : equity();
    const ret = finalEq / G.cash0;
    const profit = finalEq - G.cash0;
    const liq = why === 'liquidated';

    let gr = 'E';
    if (liq) gr = 'F';
    else if (ret >= 5) gr = 'SSS';
    else if (ret >= 3) gr = 'S';
    else if (ret >= 2) gr = 'A';
    else if (ret >= 1.5) gr = 'B';
    else if (ret >= 1.15) gr = 'C';
    else if (ret >= 1.0) gr = 'D';

    // 结算评语与收场白都走 settleOf()（**欠揍雌小鬼**那味，评级越低越嚣张）。
    // 流程性提示（退出 / 继续上局）仍然一本正经 —— 这两件事别一起管，
    // 管过头就把游戏写成说明书了。
    const st = settleOf(gr, { liq: liq, lev: G.lev });
    const verdict = st.v;
    const finale = st.f;

    // 最佳记录存**收益率**而不是金额 —— 本金能改了，拿「赚了多少万」比大小没意义
    // （本金 1000 万赚 5 万和本金 1 万赚 5 万完全不是一回事）。
    // 用新键，老的绝对金额记录自然失效，不用做迁移。
    const rPct = (ret - 1) * 100;
    const bestP = storeGet('wxgame_bestp', null);
    const isNewBest = bestP == null || rPct > +bestP;
    if (isNewBest) { storeSet('wxgame_bestp', rPct.toFixed(2)); storeSet('wxgame_bestc', G.cash0); }
    const bestShow = isNewBest ? rPct : +bestP;
    const bestCash = isNewBest ? G.cash0 : +(storeGet('wxgame_bestc', 0) || 0);

    const btns = '<div class="gg-btns"><button class="gg-long" id="ggAgain">再来一局</button>' +
      '<button class="gg-short" id="ggQuit">退出</button></div>';

    const cover = $('#ggCover');
    if (cover) {
      showCover(
        '<div class="gg-card">' +
        (liq ? '<div class="gg-flash"></div>' : '') +
        '<h2 class="' + (profit >= 0 ? 'win' : 'lose') + '">' + (liq ? '爆 仓' : profit >= 0 ? '收 盘 盈 利' : '收 盘 亏 损') + '</h2>' +
        '<div class="gg-grade">' + gr + '</div>' +
        '<div class="gg-final" style="color:' + colorOf(profit) + '">' + money(finalEq) + '</div>' +
        '<p>' + (liq ? '权益跌破维持保证金，被强制平仓。' : TRADE_DAYS + ' 天交易走完，自动结算。') + '</p>' +
        '<p style="color:' + colorOf(profit) + '">' + sgnMoney(profit) + '　（' + (profit >= 0 ? '+' : '') + ((ret - 1) * 100).toFixed(2) + '%）</p>' +
        '<div class="gg-tbl">' +
        '<div class="gg-row"><span>标的</span><span>' + (G.city ? G.city.name : '—') + ' WXI 天气指数</span></div>' +
        '<div class="gg-row"><span>本金</span><span>' + money(G.cash0) + '</span></div>' +
        '<div class="gg-row"><span>杠杆</span><span>' + G.lev + ' 倍</span></div>' +
        '<div class="gg-row"><span>爆仓时点</span><span>' + (liq ? (labelAt(G.liqAt) + '　@ ' + n1(G.liqPrice)) : '—') + '</span></div>' +
        '<div class="gg-row"><span>最大回撤</span><span>' + (G.maxDD * 100).toFixed(1) + '%</span></div>' +
        '<div class="gg-row"><span>下单次数</span><span>' + G.trades + '</span></div>' +
        '<div class="gg-row"><span>累计成本</span><span>手续费 ¥' + (G.feePaid || 0).toFixed(0) +
        ' · 滑点 ¥' + (G.slipPaid || 0).toFixed(0) + '</span></div>' +
        '<div class="gg-row"><span>本机最佳</span><span>' + (bestShow >= 0 ? '+' : '') + (+bestShow).toFixed(2) + '%' +
        '<span class="dim" style="font-weight:400">　（本金 ' + money(bestCash) + '）</span></span></div>' +
        '</div>' +
        '<p class="dim" style="font-size:12px">' + verdict + '</p>' +
        (finale ? '<p class="gg-finale ' + st.cls + '">' + finale + '</p>' : '') +
        btns +
        '</div>');
    }
    if (liq) { floatText('爆 仓', '#ff4d4f', 34); beep(90, .7, 'sawtooth', .1); }
    bindCoverOnce();
    render();
  }

  function bindCoverOnce() {
    const a = $('#ggAgain'), r = $('#ggRetry'), q = $('#ggQuit');
    if (a) a.onclick = () => beginRound();
    if (r) r.onclick = () => beginRound();
    if (q) q.onclick = () => close();
    // 本金选择器（只出现在开场卡片里）
    U.$$('.gg-cbtn').forEach(b => { b.onclick = () => setCash(+b.dataset.cash); });
    const inp = $('#ggCash');
    if (inp) {
      // 边打边改会一次次 clamp，光标乱跳，所以只在失焦/回车时落地
      inp.onchange = () => setCash(inp.value);
      inp.onkeydown = e => { if (e.key === 'Enter') { setCash(inp.value); inp.blur(); } };
    }
    cashTip();
  }

  /* ═══════════════ 交互 ═══════════════ */
  function trade(dir) {
    if (!G.running || G.ended) return;
    const lots = Math.floor(maxLots() * G.pct / 100);
    if (lots < 1) { toast('可用保证金不够开 1 手'); return; }
    applyFill(dir * lots);
    beep(dir > 0 ? 660 : 440, .07, 'square', .03);
    const r = $('.gg-right');
    if (r) { r.classList.remove('gg-pop'); void r.offsetWidth; r.classList.add('gg-pop'); }
    render();
  }

  function closeAll() {
    if (!G.running || G.ended || !G.pos) return;
    applyFill(-G.pos);
    beep(520, .08, 'square', .03);
    render();
  }

  function setSeg(sel, attr, val) {
    U.$$(sel).forEach(b => b.classList.toggle('on', b.dataset[attr] === String(val)));
  }

  /* 本金选择器（只在开场卡片里，局中不给改 —— 亏了再充值就不叫操盘了）。
     顺手算出「按基准 1000 点，这个本金在当前杠杆下满仓能开多少手」，
     好让人直观感到本金大小到底影响什么。 */
  function cashRowHTML() {
    const chips = CASH_PRESETS.map(v =>
      '<button type="button" class="gg-cbtn' + (v === G.cash0 ? ' on' : '') + '" data-cash="' + v + '">' +
      cashShort(v) + '</button>').join('');
    return '<div class="gg-cash">' +
      '<div class="gg-cash-head"><span>本金</span><b id="ggCashShow">' + money(G.cash0) + '</b></div>' +
      '<div class="gg-cash-row">' + chips +
      '<input class="gg-inp" id="ggCash" type="number" inputmode="numeric" step="1000" ' +
      'min="' + CASH_MIN + '" max="' + CASH_MAX + '" value="' + G.cash0 + '" title="自定义本金（' +
      n0(CASH_MIN) + ' ~ ' + n0(CASH_MAX) + '）"></div>' +
      '<p class="gg-cash-tip" id="ggCashTip"></p>' +
      '</div>';
  }
  function cashShort(v) {
    if (v >= 10000) { const w = v / 10000; return (w % 1 ? w.toFixed(1) : w) + ' 万'; }
    return n0(v);
  }
  // 本金能改，而且**真的会改变难度** —— 这一点以前写错了，现在靠三样东西成立：
  //   ① 最低手续费 5 元：本金越小，手续费占本金的比例越高，小资金被磨得更狠；
  //   ② 滑点与名义金额成正比：钱越多、单子越大，越难在你要的价位全部成交；
  //   ③ 小地方的盘子更小：同样的单子下到县城，滑点要乘上 dishScale（最大 2.6 倍）。
  // 当然仓位百分比那条仍然成立（本金翻 10 倍手数也翻 10 倍），
  // 所以文案里要把①②讲清楚，而不是笼统地说"更难"。
  function cashTip() {
    const T = $('#ggCashTip');
    if (!T) return;
    const lots = Math.floor(G.cash0 / (BASE * LOT_MULT / G.lev));
    const notional = lots * BASE * LOT_MULT;
    const fee = Math.max(FEE_MIN, notional * FEE_RATE);
    const slipYuan = lots * slipOf(lots) * LOT_MULT;
    const pct = G.cash0 ? ((fee + slipYuan) / G.cash0 * 100) : 0;
    const capped = slipOf(lots) >= SLIP_MAX - 1e-9;
    T.innerHTML = '按基准 <b>' + BASE + '</b> 点、当前 <b>' + G.lev + '×</b> 杠杆，满仓约 <b>' + n0(lots) +
      '</b> 手。<br>满仓<b>开一次 + 平一次</b>的手续费 + 滑点约 <b>¥' + n0((fee + slipYuan) * 2) +
      '（本金的 ' + (pct * 2).toFixed(2) + '%）</b>。本金越大、城市越小，这个数越肉疼：' +
      '手续费有 <b>¥' + FEE_MIN + ' 保底</b>，滑点随名义金额上涨' +
      (capped ? '（已触到 <b>' + SLIP_MAX + ' 点</b>上限）' : '') + ' —— 钱多不等于好做。';
  }
  function setCash(v) {
    v = Math.round(+v);
    if (!isFinite(v) || v <= 0) v = DEF_CASH;
    v = Math.max(CASH_MIN, Math.min(CASH_MAX, v));
    G.cash0 = v;
    storeSet('wxgame_cash', v);
    saveCfg();
    const s = $('#ggCashShow'); if (s) s.textContent = money(v);
    const inp = $('#ggCash'); if (inp && +inp.value !== v) inp.value = v;
    U.$$('.gg-cbtn').forEach(b => b.classList.toggle('on', +b.dataset.cash === v));
    cashTip();
  }

  /* K 线周期选择器。**局中也能换** —— 换的时候不重新取数据，而是拿开局留着的
     那份 15 分钟原样序列重采样一遍，再把"已经推进到第几分钟天气"映射到新周期的
     下标上。所以 1 分钟图看到第 3 天 12:00 切到 60 分钟图，还是第 3 天 12:00 附近，
     行情不会跳。持仓、挂单、权益都原样保留（价格口径没变，只是画粗画细）。 */
  function barRowHTML() {
    const chips = BAR_MIN.map((m, i) =>
      '<button type="button" class="gg-bbtn' + (i === G.barIdx ? ' on' : '') + '" data-bar="' + i + '">' +
      BAR_N[i] + '</button>').join('');
    return '<div class="gg-bar"><div class="gg-bar-head"><span>K 线周期</span>' +
      '<b id="ggBarShow">' + BAR_N[G.barIdx] + '</b></div>' +
      '<div class="gg-bar-row">' + chips + '</div>' +
      '<p class="gg-bar-tip" id="ggBarTip"></p></div>';
  }
  /** 真实粒度只有 15 分钟，所以得跟玩家说清楚哪几档是采到的、哪几档是画出来的。 */
  function barTip() {
    const T = $('#ggBarTip');
    if (!T) return;
    const m = barMin();
    const n = perDay();
    const base = '进来先白送 <b>' + WARM_DAYS + '</b> 天历史（已走完，只能看），' +
      '从第 <b>' + (WARM_DAYS + 1) + '</b> 天开始交易 <b>' + TRADE_DAYS + '</b> 天 = <b>' + n0(roundBars()) + '</b> 根，' +
      '每根 <b>' + (m < 60 ? m + ' 分钟' : (m / 60) + ' 小时') + '</b>（一天 ' + n0(n) + ' 根）。';
    const src = m > SRC_MIN
      ? 'Open-Meteo 的免费数据最细就是 <b>15 分钟</b>，这一档是把它 ' + (m / SRC_MIN) + ' 根并成 1 根，<b>全是真数据</b>。'
      : (m === SRC_MIN
        ? '这一档就是数据源<b>原样</b> —— Open-Meteo 最细只给到 15 分钟，<b>全是真数据</b>。'
        : '数据源最细只有 <b>15 分钟</b>，所以这一档是<u>插值展开</u>的 —— 收盘价沿 15 分钟的开→收走、影线按比例分，' +
          '细碎波动是<b>画出来的</b>，不是采到的。走势和 15 分钟档一致。');
    T.innerHTML = base + src;
  }
  function setBar(idx) {
    idx = Math.max(0, Math.min(BAR_MIN.length - 1, Math.round(+idx) || 0));
    storeSet('wxgame_bar', idx);
    if (idx === G.barIdx || !G.base) { G.barIdx = idx; saveCfg(); syncBar(); return; }
    // 已经推进到第几分钟天气：G.i 是**最后一根已经走完的** K 线，所以"现在"在
    // 它的收盘时刻，也就是 (G.i + 1) × 旧周期。
    const nowMin = (G.i + 1) * barMin();
    const hist = G.hist.slice();
    G.barIdx = idx;
    saveCfg();
    const rs = resample(G.base, G.baseSeeds, G.baseReg);
    G.series = rs.series; G.seeds = rs.seeds; G.regLine = rs.regLine;
    // 只认"已经走完"的那些根 —— 下标 i 的 K 线**收于** (i+1)×周期，所以要
    // G.i = floor(nowMin / 周期) - 1。用 ceil/round 会往前跳到一段**未来**天气的
    // 收盘价上，白白扫掉止损；宁向往回退，退后不会超过一个周期。
    G.i = Math.max(0, Math.min(G.series.length - 1, Math.floor(nowMin / barMin()) - 1));
    fbReset();   // 换周期 = 换了一整套时间轴，形成中那根必须清掉，否则会带上一个周期的极值
    G.price = G.series[G.i] ? G.series[G.i].c : G.price;
    G.hist = hist;                            // 权益曲线照旧攒着，不因为换周期断掉
    syncBar();
    render();
  }
  function syncBar() {
    const s = $('#ggBarShow'); if (s) s.textContent = BAR_N[G.barIdx];
    // 注意选的是 #ggBar button 而不是某个类名 —— index.html 里那几个按钮没写类
    U.$$('#ggBar button').forEach(b => b.classList.toggle('on', +b.dataset.bar === G.barIdx));
    barTip();
  }

  /* ═══════════════ 存档：退了也能接着玩 ═══════════════ */
  /** 这一块要解决的是「我关掉页面，行情还得自己走」。
   *
   *  存的是 `base` 而不是 `series`：`series` 是 `base` 按当前周期重采样出来的，
   *  1 分钟档一局有 5 万多根，JSON 一下直接顶爆 localStorage 那 5MB。
   *  `base` 永远只有 3552 根 15 分钟原样数据，恢复时重采样一次就全回来了 ——
   *  这也正是 setBar() 换周期时干的事。 */
  const SAVE_KEY = 'wxgame_save';
  const SAVE_V = 1;

  function saveRound() {
    if (!G.running || G.ended || !G.base || !G.city) return;
    try {
      storeSet(SAVE_KEY, {
        v: SAVE_V, at: Date.now(),
        city: G.city, barIdx: G.barIdx, speedIdx: G.speedIdx,
        lev: G.lev, pct: G.pct, cash0: G.cash0, sound: G.sound,
        base: G.base, baseSeeds: G.baseSeeds, baseReg: G.baseReg,
        sev: G.sev, regFrom: G.regFrom, regCities: G.regCities,
        i: G.i, acc: G.acc, price: G.price,
        cash: G.cash, pos: G.pos, avg: G.avg,
        peak: G.peak, maxDD: G.maxDD, trades: G.trades,
        slipPaid: G.slipPaid, feePaid: G.feePaid,
        fills: G.fills, orders: G.orders, orderSeq: G.orderSeq,
        hist: G.hist, lastNews: G.lastNews
      });
    } catch (e) { /* 存不下就算了，别把游戏搞崩 */ }
  }
  function loadSaved() {
    let s = null;
    try { s = storeGet(SAVE_KEY, null); } catch (e) { s = null; }
    if (!s || s.v !== SAVE_V || !s.base || !s.city || !s.sev || !s.base.length) return null;
    return s;
  }
  function clearSave() { try { storeSet(SAVE_KEY, null); } catch (e) { } }
  /** 自动存盘：3 秒最多落一次 —— 每一帧都 JSON.stringify 那 3552 根太贵了。 */
  let saveAt = 0;
  function autoSave() {
    const now = Date.now();
    if (now - saveAt < 3000) return;
    saveAt = now;
    saveRound();
  }

  /** 离线追赶。速度的定义本来就是「每真实秒推进多少分钟天气」（见 SPEEDS），
   *  所以补多少根是算得出来的：
   *      离开多少秒 × SPEEDS[speedIdx] = 这段时间天气走了多少分钟 → 再除以当前周期。
   *  这就是「股票不会因为你没打开同花顺就不动」那句要求的落点。 */
  function catchUp(s) {
    const gapSec = Math.max(0, (Date.now() - (+s.at || Date.now())) / 1000);
    const weatherMin = gapSec * SPEEDS[G.speedIdx];
    const want = Math.floor(weatherMin / barMin());
    if (want < 1) return { bars: 0, min: weatherMin, why: null };
    fbReset();
    const i0 = G.i;
    const r = stepBars(want, true);          // silent：补推不飘字、不响、不逐根重绘
    return { bars: G.i - i0, min: weatherMin, why: r.why, at: i0 };
  }

  function gapText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时' + (m % 60 ? (m % 60) + ' 分钟' : '');
    return Math.floor(h / 24) + ' 天' + (h % 24 ? (h % 24) + ' 小时' : '');
  }
  /** 已经推进到第几天（1 起算），用来在存档提示里说"你停在哪"。 */
  function dayAt(i) { return Math.floor(((i + 1) * barMin()) / 1440) + 1; }

  /** 从存档恢复一局。`base` 重采样回当前周期，再把离线那段时间的 K 线补上。 */
  function resumeRound(s) {
    readTheme();
    G.city = s.city;
    G.sev = s.sev; G.regFrom = s.regFrom; G.regCities = s.regCities || [];
    G.base = s.base; G.baseSeeds = s.baseSeeds; G.baseReg = s.baseReg;
    G.lev = (+s.lev) || 10;
    G.pct = (+s.pct) || 30;
    G.cash0 = (+s.cash0) || DEF_CASH;
    G.sound = s.sound !== false;
    const bi = Math.round(+(s.barIdx)); const si = Math.round(+(s.speedIdx));
    G.barIdx = (isFinite(bi) && bi >= 0 && bi < BAR_MIN.length) ? bi : 2;
    G.speedIdx = (isFinite(si) && si >= 0 && si < SPEEDS.length) ? si : 2;
    // 重建这一档的 series（和 setBar 走的是同一条路）
    const rs = resample(G.base, G.baseSeeds, G.baseReg);
    G.series = rs.series; G.seeds = rs.seeds; G.regLine = rs.regLine;
    G.i = Math.max(0, Math.min(G.series.length - 1, Math.round(+(s.i)) || 0));
    G.acc = Math.max(0, Math.min(1, +s.acc || 0));
    G.price = (+s.price) || (G.series[G.i] ? G.series[G.i].c : BASE);
    G.cash = (+s.cash) || 0;
    G.pos = (+s.pos) || 0;
    G.avg = (+s.avg) || 0;
    G.peak = (+s.peak) || G.cash;
    G.maxDD = (+s.maxDD) || 0;
    G.trades = (+s.trades) || 0;
    G.slipPaid = (+s.slipPaid) || 0;
    G.feePaid = (+s.feePaid) || 0;
    G.fills = s.fills || [];
    G.orders = s.orders || [];
    G.orderSeq = (+s.orderSeq) || 0;
    G.hist = s.hist || [];
    G.lastNews = s.lastNews || null;
    G.liqAt = 0; G.liqPrice = 0; G.hoverIdx = -1;
    G.ended = false; G.running = true; G.open = true;
    fbReset();

    const cover = $('#ggCover');
    hideCover();

    ensureCharts();
    readTheme();
    setSeg('#ggLev button', 'lev', G.lev);
    setSeg('#ggPct button', 'pct', G.pct);
    setSeg('#ggSpeed button', 'sp', G.speedIdx);
    syncBar();
    // 存档里带着的那套设置就是"目前正在用的"，顺手记成默认 —— 这样这局结束之后
    // 再开局，面板还是这一套，不会退回初始值。
    saveCfg();

    // 先把离线那段行情补上，再开计时器 —— 顺序反了会先把新的一根走掉
    const cu = catchUp(s);
    render();
    if (cu.why) return;      // 补的过程中爆仓/到期了，endRound 已经把结算卡显示出来

    startTimer();
    G.acc = (+s.acc) || 0;   // startTimer 会把 acc 清零，这里把"半根"的进度还回来
    if (cu.bars > 0) {
      U.toast('离开期间行情推进了 ' + gapText(Date.now() - (+s.at || Date.now())) +
        '，已补齐 ' + n0(cu.bars) + ' 根 K 线。', 4200);
    }
  }

  /** 显示封面 / 选择卡片。
   *  窄屏上"做多 / 做空"那两个键是 `position: fixed` 钉在屏幕底部的（不然看图时下不了单），
   *  而封面卡自己的「开始操盘 / 算了」也在底部 —— 不处理的话 fixed 的那两个会盖在封面上。
   *  所以这里同时给 `#game` 挂一个 `cover-on`，窄屏 CSS 靠它把固定的下单键藏起来。 */
  function showCover(html) {
    const cover = $('#ggCover'), mask = $('#game');
    if (cover) {
      if (html != null) cover.innerHTML = html;
      cover.hidden = false;
    }
    if (mask) mask.classList.add('cover-on');
  }
  function hideCover() {
    const cover = $('#ggCover'), mask = $('#game');
    if (cover) { cover.hidden = true; cover.innerHTML = ''; }
    if (mask) mask.classList.remove('cover-on');
  }

  /** 复用封面卡片做一个选择框（不引原生 confirm —— 它会阻塞、也没法定制文案）。 */
  function askChoice(o) {
    return new Promise(resolve => {
      const cover = $('#ggCover');
      if (!cover) { resolve(null); return; }
      const btns = o.buttons.map((b, k) =>
        '<button class="' + (b.cls || 'gg-short') + '" data-k="' + k + '">' + b.label + '</button>').join('');
      showCover('<div class="gg-card">' +
        '<h2 style="font-size:19px;letter-spacing:1px">' + o.title + '</h2>' +
        '<p>' + o.body + '</p>' +
        '<div class="gg-btns">' + btns + '</div></div>');
      U.$$('#ggCover .gg-btns button').forEach(b => {
        b.onclick = () => {
          const v = o.buttons[+b.dataset.k].value;
          hideCover();
          resolve(v);
        };
      });
    });
  }

  /** 点 ✕ / 点遮罩 / 按返回键都走这里。 */
  async function exitFlow() {
    // 这一局**已经打完了**（爆仓 / 到期结算）却点了退出：存档里记的是"打到一半的那一局"，
    // 留着它下次进来就会弹「有一局尚未结束」—— 可那一局早就结束了。
    // 所以这里要清掉。（真正的兜底在 endRound 里也清了一次，那条路覆盖"直接关掉页面"。）
    // ⚠ 只在 G.ended 时清：如果只是"没在跑"（刚打开、还没点继续 / 还没点开始），
    //   那份存档是用户还没决定要不要继续的那一局，清掉就等于替他扔了。
    if (G.ended) { G.running = false; G.ended = false; clearSave(); close(); return; }
    if (!G.running) { close(); return; }
    const v = await askChoice({
      title: '退出游戏',
      body: '行情不会因为退出而暂停。<br>选择「保留进度」，下次进入时会按真实经过的时间' +
        '把这段时间的 K 线补齐；选择「结束本局」，这一局的进度会被清除。',
      buttons: [
        { label: '保留进度', value: 'keep', cls: 'gg-long' },
        { label: '结束本局', value: 'end', cls: 'gg-short' },
        { label: '取消', value: null, cls: 'gg-short' }
      ]
    });
    if (v === 'keep') { saveRound(); close(); U.toast('进度已保存在本机，下次打开可以直接继续。', 2600); }
    else if (v === 'end') {
      // 先让 G.running 落下来，再清存档 —— 否则 close() 开头那句"兜底存盘"会把刚清掉的存档又写回去，
      // 于是下一次进来仍然弹「上次那局还在」。这是个真出现过的 bug。
      G.running = false;
      clearSave();
      close();
      U.toast('本局已结束，存档已清除。', 2600);
    }
    // v === null（取消）：卡片已经被 askChoice 收掉了，局还在跑，什么都不用做
  }

  /* ═══════════════ 设置：记住上次调好的那一套 ═══════════════ */
  /** 面板上这几项（本金 / K 线周期 / 行情速度 / 杠杆 / 仓位 / 音效）跟「进行中的那一局」
   *  是两回事，所以要分开存：
   *    - `wxgame_save` 存的是**局**。点「结束本局」会把它清掉，这是对的 —— 局确实没了。
   *    - `wxgame_cfg` 存的是**设置**。局在不在跟它没关系：结束一局、玩完一局、
   *      换台设备重新打开，面板还是上次调好的样子。
   *  两者的先后关系：**开局时用设置当默认值；存档里带着的那套优先**
   *  （因为那是"当时正在用的"），恢复存档时顺手把设置也刷成存档里那套。 */
  const CFG_KEY = 'wxgame_cfg';
  const CFG_V = 1;
  const CFG_DEF = { barIdx: 2, speedIdx: 2, lev: 10, pct: 30, sound: true, cash0: DEF_CASH };
  /** 只接受落在合法档位里的值。档位表按 DOM 里实际有的按钮来验，不写死常量 ——
   *  以后加减档位不会让这里悄悄记住一个点不亮的按钮。 */
  function pickSeg(sel, attr, val, d) {
    const vals = U.$$(sel).map(b => +b.dataset[attr]);
    return vals.indexOf(+val) >= 0 ? +val : (vals.indexOf(d) >= 0 ? d : (vals.length ? vals[0] : d));
  }
  function clampIdx(v, n, d) {
    v = Math.round(+(v));
    return (isFinite(v) && v >= 0 && v < n) ? v : d;
  }
  function loadCfg() {
    let c = null;
    try { c = storeGet(CFG_KEY, null); } catch (e) { c = null; }
    if (!c || c.v !== CFG_V) c = null;
    // 老版本把 K 线周期和本金分开存在 wxgame_bar / wxgame_cash 里，没有 cfg 时从那儿搬
    const rawBar = c ? c.barIdx : storeGet('wxgame_bar', null);
    const rawCash = c ? c.cash0 : storeGet('wxgame_cash', null);
    const num = (v, d) => (v != null && v !== '' && isFinite(+v)) ? +v : d;
    const cash0 = Math.round(num(rawCash, CFG_DEF.cash0));
    return {
      barIdx: clampIdx(rawBar != null ? rawBar : CFG_DEF.barIdx, BAR_MIN.length, CFG_DEF.barIdx),
      speedIdx: clampIdx(c ? c.speedIdx : CFG_DEF.speedIdx, SPEEDS.length, CFG_DEF.speedIdx),
      lev: pickSeg('#ggLev button', 'lev', c ? c.lev : NaN, CFG_DEF.lev),
      pct: pickSeg('#ggPct button', 'pct', c ? c.pct : NaN, CFG_DEF.pct),
      sound: c && typeof c.sound === 'boolean' ? c.sound : CFG_DEF.sound,
      cash0: (cash0 >= CASH_MIN && cash0 <= CASH_MAX) ? cash0 : CFG_DEF.cash0
    };
  }
  /** 换档、改本金、切音效都要落一次盘。这几处都是人手动点的，频率低，不用节流。 */
  function saveCfg() {
    try {
      storeSet(CFG_KEY, {
        v: CFG_V, barIdx: G.barIdx, speedIdx: G.speedIdx,
        lev: G.lev, pct: G.pct, sound: !!G.sound, cash0: G.cash0
      });
    } catch (e) { /* 存不下就只影响"下次记不记得住"，别把面板搞崩 */ }
  }

  /* ═══════════════ 开关面板 ═══════════════ */
  function open() {
    readTheme();
    const mask = $('#game');
    if (!mask) return;
    mask.hidden = false;
    G.open = true;
    // 设置：上次调好的那一套 —— 本金 / K 线周期 / 行情速度 / 杠杆 / 仓位 / 音效
    const cfg = loadCfg();
    G.cash0 = cfg.cash0;
    G.barIdx = cfg.barIdx;
    G.speedIdx = cfg.speedIdx;
    G.lev = cfg.lev;
    G.pct = cfg.pct;
    G.sound = cfg.sound;

    const sv = loadSaved();
    if (sv) resumeCard(sv); else startCard();

    setTimeout(() => {
      ensureCharts();
      readTheme();
      setSeg('#ggLev button', 'lev', G.lev);
      setSeg('#ggPct button', 'pct', G.pct);
      setSeg('#ggSpeed button', 'sp', G.speedIdx);
      const snd0 = $('#ggSound');
      if (snd0) {
        snd0.textContent = G.sound ? '🔊' : '🔇';
        snd0.title = G.sound ? '音效：开' : '音效：关';
      }
      syncBar();
      render();
    }, 30);
  }

  /** 上次那局还在 —— 问一句是接着玩还是重开。注意"从该城市重新开始"用的是
   *  **当前页面的城市**，所以换个城市点进来就能开新局，这正是需求里要的那条。 */
  async function resumeCard(s) {
    const app = global.__APP;
    const curName = (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
    const oldName = (s.city && s.city.name) || '上次的城市';
    const eq = equityOfSave(s);
    const v = await askChoice({
      title: '有一局尚未结束',
      body: '<b>' + oldName + '</b> WXI · 停在第 <b>' + dayAt(s.i) + '</b> 天 · 权益 <b>' + money(eq) +
        '</b>（' + ((eq / (s.cash0 || DEF_CASH) - 1) * 100 >= 0 ? '+' : '') +
        ((eq / (s.cash0 || DEF_CASH) - 1) * 100).toFixed(2) + '%）<br>' +
        '<span class="dim">已离开 ' + gapText(Date.now() - (+s.at || Date.now())) +
        '。这段时间行情照常推进，选择继续会补齐缺少的 K 线。</span>',
      buttons: [
        { label: '继续 ' + oldName, value: 'resume', cls: 'gg-long' },
        { label: '从 ' + curName + ' 重新开始', value: 'new', cls: 'gg-short' },
        { label: '取消', value: null, cls: 'gg-short' }
      ]
    });
    if (v === 'resume') { resumeRound(s); return; }
    if (v === 'new') { clearSave(); startCard(); return; }
    close();
  }
  /** 存档里的权益（现金 + 浮动盈亏），不依赖 G 已经填好。 */
  function equityOfSave(s) {
    const px = (+s.price) || 0, pos = (+s.pos) || 0, avg = (+s.avg) || 0;
    return ((+s.cash) || 0) + (pos ? pos * (px - avg) * LOT_MULT : 0);
  }

  /** 开场封面。 */
  function startCard() {
    const cover = $('#ggCover');
    if (!cover) return;
    const app = global.__APP;
    const cityName = (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
    showCover(
      '<div class="gg-card">' +
      '<h2 style="font-size:22px;letter-spacing:2px">🎮 Climate Create Bet</h2>' +
      '<p>标的：<b>WXI 复合天气指数</b> —— <b>' + cityName + '</b> 本地的对流能量 / 阵风 / 降水 / 露点，' +
      '<b>外加同省城市平均出来的「大盘」</b>，再叠一层盘子扰动。<br>' +
      '打雷下雨 = 拉升，天气转好 = 回落。你不知道这段是哪年哪月 —— 只能靠盘感。</p>' +
      cashRowHTML() +
      '<ul class="gg-rules">' +
      '<li>进来先白送 <b>' + WARM_DAYS + ' 天</b>历史 K 线（已经走完，只能看不能交易），' +
      '你从第 <b>' + (WARM_DAYS + 1) + '</b> 天开始交易，再走 <b>' + TRADE_DAYS + ' 天</b>结算。</li>' +
      '<li>K 线周期有 <b>1 分 / 5 分 / 15 分 / 30 分 / 1 时 / 4 时 / 1 日</b>七档，右下角随时换' +
      '（1/5 分是插值展开的，其余是真数据聚合）。</li>' +
      '<li>图上那条<b style="color:#c792ea">紫色虚线就是大盘</b>（同省 8 城等权平均）。' +
      '本地跑赢大盘 = 自己这块地在出事；本地跟着大盘走 = 一场天气过程路过。</li>' +
      '<li>合约：指数每动 <code>1 点</code>，每手盈亏 <code>¥10</code>。</li>' +
      '<li>杠杆决定保证金：满仓时反向走 <code>(1−10%)÷杠杆</code> 就<u>爆仓</u>。' +
      '10 倍约 9%、20 倍约 4.5%、<b>100 倍只要 0.9%</b>。</li>' +
      '<li>手续费万分之五、开平都收，另有<b>滑点</b>（单子越大越贵）—— 本金越大、城市越小，成本越肉疼。</li>' +
      '<li>右侧随时看得到<b>强平价</b>和<b>爆仓距离</b> —— 碰到就结束。</li>' +
      '<li>行情速度 <b>15 / 30 / 60 / 120 / 240 分钟天气每秒</b>，30 天交易约 <b>3 ~ 48 分钟</b>，随时能暂停。' +
      '速度是"每秒推进多少天气时间"，所以跟 K 线周期无关 —— 挑 1 分钟只是看得更细，不会玩得更久。</li>' +
      '<li><b>中途退出不会作废</b>：选「保留进度」下次回来接着玩，而且你不在的时候<b>行情照走</b>。</li>' +
      '</ul>' +
      '<p class="dim" style="font-size:12px">纯娱乐：价格波动是模拟的，和真实气象服务无关。</p>' +
      '<div class="gg-btns"><button class="gg-long" id="ggAgain">开始操盘</button>' +
      '<button class="gg-short" id="ggQuit">算了</button></div>' +
      '</div>');
    bindCoverOnce();
  }

  /** 新手入门：玩这个游戏的人不一定懂炒股，所以"怎么看图、怎么下单"要在游戏里就地讲一遍。
   *  这里只讲读图和操作；天数、成本那些参数在开场封面已经写了，不重复。 */
  function guideHTML() {
    const app = global.__APP;
    // 局里就以本局的标的为准；没开局时退回主站当前选中的城市。
    const cn = (G.city && G.city.name) || (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
    return '<div class="gg-card guide">' +
      '<h2>新手入门</h2>' +
      '<div class="gg-guide">' +

      '<h5>一、这是什么</h5>' +
      '<dl>' +
      '<dt>你在赌一段天气的好坏</dt>' +
      '<dd>系统把 <b>' + cn + '</b> 的天气数据（对流能量、阵风、降水、露点、空气质量）压成一个数字，' +
      '叫 <b>WXI 天气指数</b>，再用它画出一张像股票一样的图。天气变差 → 指数往上走；天气转好 → 指数往下走。' +
      '盘面还会被几路<b>真实事件</b>推动：地震、台风、预报失准，以及<b>一整套天文</b>——' +
      '月光、流星雨极大、超级月亮、银河中心高度、头顶亮星与行星、天文夜长短、大潮小潮、' +
      '本城光污染、地磁暴，跟观星页用的是同一份真值（天象越热闹，行情越猛）。</dd>' +
      '<dt>你不是在跟别人对赌</dt>' +
      '<dd>盘面只有你一个人，对手是天气本身。没有庄家，只有你猜得准不准、仓位管得好不好。</dd>' +
      '</dl>' +

      '<h5>二、怎么看图</h5>' +
      '<dl>' +
      '<dt>先看最上面那根蜡烛</dt>' +
      '<dd>左上角那行 <code>开 … 高 … 低 … 收 …</code> 就是当前这根蜡烛的四个价。' +
      '<b>收</b> 是最新的价，也是你下单的成交基准。</dd>' +
      '<dt>红绿代表方向</dt>' +
      '<dd>红＝这根比上一根收得高，绿＝低，灰＝一模一样。如果跟你看惯的国外行情相反，主站顶栏可以切换。</dd>' +
      '<dt>图上那两条彩色的线</dt>' +
      '<dd>黄线是 <b>均价</b>（最近若干根收盘的平均值），紫色虚线是 <b>大盘</b>（同省 8 个城市的平均指数）。' +
      '本地线在大盘线上面 = 你这边在出事；两条贴在一起 = 一场大范围天气过程，都在动。</dd>' +
      '<dt>下面那排柱子</dt>' +
      '<dd>是 <b>活跃度</b>，越高说明那段时间天气越闹（雨大、风大）。它不代表涨跌，只代表动静大小。</dd>' +
      '<dt>右边那串数字</dt>' +
      '<dd>从上往下是账户权益、可用保证金、占用保证金、持仓、持仓均价、浮动盈亏、强平价、爆仓距离。' +
      '<b>新手先只看两个</b>：账户权益（赚了还是亏了）和爆仓距离（离出局还有多远）。</dd>' +
      '</dl>' +

      '<h5>三、怎么下单</h5>' +
      '<ol>' +
      '<li>选 <b>杠杆</b>。它只决定占用多少保证金，不改变你的方向判断。倍率越高，能承受的反向波动越小。</li>' +
      '<li>选 <b>仓位</b>（动用本金的比例）。满仓就是全押。</li>' +
      '<li>点 <b>做多 ↑</b>（看涨，赌天气变差）或 <b>做空 ↓</b>（看跌，赌天气转好）。点一下即市价成交。</li>' +
      '<li>想先挂条件再成交，用中间的 <b>挂多单 / 挂空单</b>：填价格和手数，价格碰到了才成交。</li>' +
      '<li>有持仓之后，用 <b>设止损 / 设止盈</b> 挂好退路 —— 新手最容易犯的错就是不加止损。</li>' +
      '<li>想平掉全部持仓，点 <b>一键平仓</b>。</li>' +
      '<li>嫌行情太快或太慢，右下角 <b>行情速度</b> 随时调。</li>' +
      '<li>想换时间颗粒度看图，右下角 <b>K 线周期</b> 随时换，不影响已经在跑的行情。</li>' +
      '</ol>' +

      '<h5>四、什么时候结束</h5>' +
      '<dl>' +
      '<dt>正常结算</dt>' +
      '<dd>交易天数走完，自动结算，给出等级和最终权益。</dd>' +
      '<dt>结算评语</dt>' +
      '<dd>故意写得欠揍 —— <b>雌小鬼那味，等级越低越嚣张</b>。它是嘴替，不是天气预报，' +
      '别当真，也别学它说话。</dd>' +
      '<dt>爆仓</dt>' +
      '<dd>亏损把权益打到维持保证金以下，强制平仓，本局结束。杠杆越高越容易碰到。</dd>' +
      '<dt>中途退出</dt>' +
      '<dd>点 ✕ 会问你「保留进度」还是「结束本局」。保留的话行情照走，下次进来自动补齐；' +
      '结束的话这一局的进度就清掉了。</dd>' +
      '</dl>' +

      '<p class="gg-guide-warn">这里用的是真实气象数据，但价格波动是模拟出来的，' +
      '和真实气象服务没有任何关系 —— 它是个看图下注的小游戏，不是投资工具。</p>' +

      '</div>' +
      '<div class="gg-btns"><button class="gg-long" id="ggGuideOk">看完了</button></div>' +
      '</div>';
  }
  function showGuide() {
    const wasIdle = !G.running && !G.ended;
    showCover(guideHTML());
    const ok = $('#ggGuideOk');
    if (ok) ok.onclick = () => { hideCover(); if (wasIdle) startCard(); };
  }

  function close() {
    // 走之前先落一次盘 —— close() 有好几个入口（✕、遮罩、封面上的"算了"、结算卡的"退出"），
    // 统一在这里兜住，免得漏掉某条路径把一局丢了。
    if (G.running && !G.ended) saveRound();
    stopTimer();
    G.running = false; G.open = false;
    const mask = $('#game');
    if (mask) mask.hidden = true;
    disposeCharts();
  }

  /* ═══════════════ 接线 ═══════════════ */
  function bind() {
    const btn = $('#btnGame');
    if (btn) btn.addEventListener('click', open);
    const x = $('#ggExit');
    if (x) x.addEventListener('click', exitFlow);
    const gd = $('#ggGuide');
    if (gd) gd.addEventListener('click', showGuide);
    const mask = $('#game');
    if (mask) mask.addEventListener('click', e => { if (e.target === mask) exitFlow(); });
    // 网页版直接关标签页 / 手机端切后台被杀，都要把这一局留住
    global.addEventListener('beforeunload', () => { if (G.running && !G.ended) saveRound(); });
    global.addEventListener('pagehide', () => { if (G.running && !G.ended) saveRound(); });
    // 手机上还有一条"返回"路径：系统后退。开着面板时先拦下来走同一个提示。
    global.addEventListener('popstate', () => {
      if (!G.open) return;
      if (G.running && !G.ended) exitFlow(); else close();
    });

    const L = $('#ggLong'), S = $('#ggShort'), C = $('#ggClosePos');
    if (L) L.addEventListener('click', () => trade(1));
    if (S) S.addEventListener('click', () => trade(-1));
    if (C) C.addEventListener('click', closeAll);

    // ── 挂单 ──
    // 价格框空着就按现价预填：绝大多数时候你想挂的就是"现价上下一点点"，
    // 每次手打五位数字太反人类。
    const ordPx = $('#ggOrdPx'), ordLots = $('#ggOrdLots');
    function readPx() {
      const v = parseFloat(ordPx && ordPx.value);
      return (isFinite(v) && v > 0) ? v : G.price;
    }
    function readLots() {
      const v = Math.floor(parseFloat(ordLots && ordLots.value));
      if (isFinite(v) && v >= 1) return v;
      return Math.floor(maxLots() * G.pct / 100);
    }
    function ordFeedback(err) {
      if (err) { toast(err); beep(200, .12, 'square', .04); }
      else render();
    }
    const ob = $('#ggOrdBuy'), os = $('#ggOrdSell'), sl = $('#ggSetSl'), tp = $('#ggSetTp');
    if (ob) ob.addEventListener('click', () => ordFeedback(placeLimit(1, readPx(), readLots())));
    if (os) os.addEventListener('click', () => ordFeedback(placeLimit(-1, readPx(), readLots())));
    if (sl) sl.addEventListener('click', () => ordFeedback(setStop('sl', readPx())));
    if (tp) tp.addEventListener('click', () => ordFeedback(setStop('tp', readPx())));
    // 撤单用事件委托 —— 列表每次 render 都是重建的，逐个绑会漏
    const ordBox = $('#ggOrders');
    if (ordBox) ordBox.addEventListener('click', e => {
      const b = e.target.closest('[data-cancel]');
      if (!b) return;
      cancelOrder(+b.dataset.cancel);
      render();
    });

    U.$$('#ggLev button').forEach(b => b.addEventListener('click', () => {
      G.lev = +b.dataset.lev; saveCfg(); setSeg('#ggLev button', 'lev', G.lev); render();
    }));
    U.$$('#ggPct button').forEach(b => b.addEventListener('click', () => {
      G.pct = +b.dataset.pct; saveCfg(); setSeg('#ggPct button', 'pct', G.pct); render();
    }));
    U.$$('#ggSpeed button').forEach(b => b.addEventListener('click', () => {
      G.speedIdx = +b.dataset.sp; saveCfg(); setSeg('#ggSpeed button', 'sp', G.speedIdx);
      if (G.running) startTimer();
    }));
    // K 线周期：局中也能换（setBar 会把已推进的天气时间映射到新周期上）
    U.$$('#ggBar button').forEach(b => b.addEventListener('click', () => setBar(b.dataset.bar)));
    const snd = $('#ggSound');
    if (snd) snd.addEventListener('click', () => {
      G.sound = !G.sound; saveCfg(); snd.textContent = G.sound ? '🔊' : '🔇';
      snd.title = G.sound ? '音效：开' : '音效：关';
    });

    // 键盘：↑/W 做多，↓/S 做空，空格平仓 —— 手速快才跟得上 24 根/秒
    global.addEventListener('keydown', e => {
      if (!G.open) return;
      if (e.key === 'Escape') { close(); return; }
      if (!G.running || G.ended) return;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { trade(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { trade(-1); e.preventDefault(); }
      else if (e.key === ' ') { closeAll(); e.preventDefault(); }
    });
    global.addEventListener('resize', U.debounce(() => { if (G.open) { if (G.main) G.main.resize(); if (G.eqc) G.eqc.resize(); } }, 120));
  }

  global.Game = {
    open, close, G, bind,
    /* 标定/探针用的出口。
       ⚠ 系数**只从 _t.P 取**，不要再往这里加 NOISE_K / JUMP_K 之类的别名 ——
         那些是加载时的快照，标定脚本改了不生效（已经踩过两次，见 P 表上面的注释）。 */
    _t: {
      pickSeries, severity, comfort, comfortParts, DIMS, WCODE_N, ema, median, robustScale, applyFill, applyFillAt, equity, marginUsed,
      liqPriceOf, maxLots, beginRound, endRound, tick, beep, labelAt, newsAt, visBars,
      tolerablePct, placeLimit, setStop, cancelOrder, processOrders, calendarAt, freeEq,
      reservedMargin, setCash, cashTip,
      slipOf, render, SLIP_K, SLIP_MAX, CAP_BASE, FEE_MIN,
      LEVS, LOT_MULT, MAINTAIN, FEE_RATE, SPEEDS,
      BASE, DEF_CASH, CASH_MIN, CASH_MAX, CASH_PRESETS,
      QUAKE_M0, QUAKE_R, QUAKE_DECAY, TYPHOON_R,
      ROUND_DAYS, WARM_DAYS, TRADE_DAYS, BAR_MIN, BAR_N, SRC_MIN, SPEED_N, TICK_HZ,
      perDay, warmBars, tradeBars, totalBars, roundBars, srcBars, barMin, roundSecs,
      resample, aggSeed, zag, fmtMin, setBar,
      liveAt, livePrice, liveNote, volNote, barAt,
      setDbgComp: v => { DBG_COMP = !!v; },
      fbReset,
      stepBars, saveRound, loadSaved, clearSave, resumeRound, catchUp, autoSave,
      equityOfSave, gapText, dayAt, exitFlow, SAVE_KEY, showGuide,
      showCover, hideCover,
      settleOf, MG, MG_F_V,          // 结算语（欠揍雌小鬼）—— 探针要逐档核对，所以从 _t 出口走
      loadCfg, saveCfg, CFG_KEY, CFG_DEF,
      P, cityAmp, cityWeight, dishScale
    }
  };

  bind();

  // ?game=1 直接开局（和 ?help=1 / ?welcome=1 一个路子）
  try { if (/[?&]game=1\b/.test(global.location.search)) setTimeout(open, 500); } catch (e) { }
})(window);
