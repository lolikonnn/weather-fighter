/* ═══════════════════════════════════════════════════════════════
   weather.js — 真正的天气功能层

   这一层把原来那些"炒股指标"(MACD/KDJ/RSI/BOLL/WR)换成气象上真用得着的东西：
     · 逐小时降水 + 降水概率        Open-Meteo
     · 风向风速 + 阵风              Open-Meteo
     · 云量（总/低/中/高）           Open-Meteo
     · 空气质量 AQI / PM2.5 / PM10  Open-Meteo air-quality
     · 雷达回波动画                 中国气象局 image.nmc.cn
     · 卫星云图                     中国气象局 image.nmc.cn
     · 台风路径                     中国气象局 typhoon.nmc.cn/weatherservice
     · 预警信号                     中国气象局 typhoon.nmc.cn/weatherservice

   全部来源都带 Access-Control-Allow-Origin: *，所以浏览器可以直连，
   GitHub Pages 与本地代理都不需要额外配置；APK 里则走 Java 拦截器。
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const TZ = 'auto';            // 按坐标取当地时区，理由见 api.js 的 TZ

  // 同一份前端要跑三种环境：
  //   · GitHub Pages —— 直连官方源（Open-Meteo 与气象局都带 ACAO:*，已验证）
  //   · 本地服务     —— 走 server/app.py 的 /api/om、/api/nmc 代理，少一次跨域
  //   · Android APK  —— 走 MainActivity 的拦截器，同源且能离线兜底
  // ?local=0 / ?local=1 可强制切换，方便在本地一条命令里复现线上取数路径。
  const LOCAL = !!global.__TJS_LOCAL__;
  const pick = (local, remote) => (LOCAL ? local : remote);

  const OM_F = pick('/api/om/v1/forecast', 'https://api.open-meteo.com/v1/forecast');
  /* Open-Meteo 的免费额度是**按主机名分桶**的：api.open-meteo.com 被限流（429
     "Daily API request limit exceeded"）时，historical-forecast-api.open-meteo.com
     往往还是好的 —— 实测两者互不影响，而且后者参数与返回结构完全一致，
     连 past_days + forecast_days 的未来段都照给（实测 past_days=92&forecast_days=16
     返回 2026-07-06..2026-10-21）。主站挂了就换它，否则"分时/7日"的主线整条断掉，
     页面上只剩一条 429 横幅。 */
  const OM_F_ALT = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
  const OM_F_LIST = [OM_F, OM_F_ALT];
  let omHost = 0;
  const OM_Q = pick('/api/om/v1/air-quality', 'https://air-quality-api.open-meteo.com/v1/air-quality');
  const NMC = pick('/api/nmc', 'https://typhoon.nmc.cn/weatherservice');
  const IMG = 'https://image.nmc.cn';

  const pad2 = n => (n < 10 ? '0' : '') + n;
  const num = v => (v === '' || v == null || isNaN(v)) ? null : +v;
  const fx = (v, n) => (v == null || isNaN(v)) ? '--' : (+v).toFixed(n == null ? 1 : n);

  /* ───────── 缓存 ───────── */
  const mem = {};
  function hit(k, ttl) { const e = mem[k]; return (e && Date.now() - e.t < ttl) ? e.v : null; }
  function put(k, v) { mem[k] = { t: Date.now(), v: v }; }

  /* 中国气象局的接口一律用 JSONP 包一层，而且层次不统一：
       · typhoon/jsons/list_default  →  fname(({...}))     ← 两层括号
       · typhoon/jsons/view_3346033  →  fname({...})       ← 一层括号
       · fetch_json/warning/json     →  fname([[...]])     ← 一层括号，内容是数组
     所以逐个剥壳试，谁能 JSON.parse 成功就用谁。 */
  function parseLoose(txt) {
    const s = String(txt).trim();
    const cands = [s];
    const m = s.match(/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (m) cands.push(m[1].trim());
    for (let i = 0; i < 3; i++) {
      const prev = cands[cands.length - 1];
      if (prev.charAt(0) === '(' && prev.charAt(prev.length - 1) === ')') {
        cands.push(prev.slice(1, -1).trim());
      } else break;
    }
    for (let i = 0; i < cands.length; i++) {
      try { return JSON.parse(cands[i]); } catch (e) { /* 试下一个 */ }
    }
    throw new Error('不是合法 JSON');
  }

  async function jget(url, ttl, key) {
    ttl = ttl == null ? 900000 : ttl;
    key = key || url;
    const h = hit(key, ttl);
    if (h) return h;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, { signal: ctl.signal, mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = parseLoose(await res.text());
      put(key, d);
      return d;
    } finally { clearTimeout(timer); }
  }

  /** 带主机回退的 Open-Meteo 取数。q 是 '?latitude=…' 那段查询串。 */
  async function jgetOm(q, ttl, key) {
    let lastErr = null;
    for (let i = 0; i < OM_F_LIST.length; i++) {
      const idx = (omHost + i) % OM_F_LIST.length;
      try {
        // 缓存 key 带 `#h<idx>` —— 两台主机各存各的，否则一台的失败会把另一台也堵住
        const d = await jget(OM_F_LIST[idx] + q, ttl, (key || 'om' + q) + '#h' + idx);
        omHost = idx;              // 记住这台能用，下次先走它
        return d;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Open-Meteo 不可用');
  }

  /* ═══════════════ 1. 逐小时天气（一个请求拿全） ═══════════════ */
  const HOURLY = [
    'temperature_2m', 'precipitation', 'precipitation_probability', 'rain', 'showers',
    'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'relative_humidity_2m', 'uv_index', 'visibility', 'dew_point_2m', 'weather_code'
  ].join(',');

  const Weather = {
    /** 当前城市的逐小时气象要素。解析失败抛异常，调用方自己兜。
        pastDays 决定往回拉多久 —— 副图要能画"日K/周K/月K"，就得有几个月的历史。 */
    async hourly(lat, lon, days, pastDays) {
      days = days || 3;
      pastDays = pastDays == null ? 1 : pastDays;
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=' + HOURLY +
        '&wind_speed_unit=ms' +
        '&past_days=' + pastDays + '&forecast_days=' + days +
        '&timezone=' + encodeURIComponent(TZ);
      const d = await jgetOm(q, 900000, 'wx2|' + lat + ',' + lon + '|' + days + '|' + pastDays);
      const h = (d && d.hourly) || {};
      const t = h.time || [];
      if (!t.length) throw new Error('逐小时数据为空');
      // "现在"在数组里的下标。past_days 拉长以后它不再固定是 24，所以显式算出来
      // 交给 series() 用。
      // 注意这里**不再截断** —— 返回完整数组，series() 按周期自己切，
      // window() 也会重新定位"现在"，向后兼容。
      // 墙钟串按响应自带的 UTC 偏移读成真实时刻（海外城市不再是 +08:00）
      const off = d.utc_offset_seconds == null ? 28800 : d.utc_offset_seconds;
      const now = Date.now() - 3 * 3600000;
      let i0 = 0;
      for (let i = 0; i < t.length; i++) {
        if (Date.parse(t[i].replace(' ', 'T') + ':00Z') - off * 1000 >= now) { i0 = Math.max(0, i - 1); break; }
      }
      return {
        src: 'Open-Meteo',
        time: t, i0: i0, off: off,
        temp: h.temperature_2m || [],
        precip: (h.precipitation || []).map(v => v || 0),
        prob: (h.precipitation_probability || []).map(v => (v == null ? 0 : v)),
        wind: h.wind_speed_10m || [],
        windDir: h.wind_direction_10m || [],
        gust: h.wind_gusts_10m || [],
        cloud: h.cloud_cover || [],
        cloudLow: h.cloud_cover_low || [],
        cloudMid: h.cloud_cover_mid || [],
        cloudHigh: h.cloud_cover_high || [],
        rh: h.relative_humidity_2m || [],
        uv: h.uv_index || [],
        vis: h.visibility || [],
        dew: h.dew_point_2m || [],
        wcode: h.weather_code || []
      };
    },

    /** 空气质量逐小时（同样支持往回拉，副图的"空气"也要能看日K）
        坑：air-quality 接口**不接受 past_days 与 forecast_days 同时出现** ——
        两个都给会 400 Bad Request（实测 past_days=92&forecast_days=16 → 400，
        而只给 past_days=92 → 200，自带 92 天历史 + 5 天预报）。所以这里只给 past_days。 */
    async air(lat, lon, pastDays) {
      pastDays = pastDays == null ? 1 : pastDays;
      const url = OM_Q + '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=pm10,pm2_5,us_aqi,ozone,nitrogen_dioxide' +
        '&past_days=' + pastDays +
        '&timezone=' + encodeURIComponent(TZ);
      const d = await jget(url, 1800000, 'air3|' + lat + ',' + lon + '|' + pastDays);
      const h = (d && d.hourly) || {};
      return {
        src: 'Open-Meteo CAMS',
        time: h.time || [],
        pm25: h.pm2_5 || [], pm10: h.pm10 || [],
        aqi: h.us_aqi || [], o3: h.ozone || [], no2: h.nitrogen_dioxide || []
      };
    },

    _wx: {},
    /** 把逐小时 + 空气质量都备好，缓存在内存里 */
    async ensure(city, cmaH) {
      if (!city) return null;
      const cur = this._wx[city.id];
      if (cur && Date.now() - cur.t < 900000) return cur;
      const out = { t: Date.now(), city: city, hourly: null, air: null, err: null };
      // 92 天历史 + 16 天预报：副图要画月K就得有 24 个月……
      // 实际取 92 天（够画日K/周K，月K会只剩 3 个点，所以月K在副图上隐藏），
      // 再长会让这次请求的 JSON 大到手机上难接受。
      try { out.hourly = await this.hourly(city.lat, city.lon, 16, 92); }
      catch (e) { out.err = String(e.message || e); }
      /* ── 气象局优先、Open-Meteo 补缺 ──
       * 副图这条线一直是纯 Open-Meteo。按全站原则，气象局逐 3 小时里**有**的字段
       * （气温 / 降水 / 风速 / 风向 / 总云量 / 低云量 / 湿度 / 能见度 / 天气码）
       * 一律换成气象局的；Open-Meteo 只保留气象局确实没有的那几项：
       * **紫外线、降水概率、阵风、中/高云、露点**。
       * 这样副图和主图报的是同一套天气，不会再出现"上面说 26℃、下面曲线说 30℃"。
       * 气象局那条线挂了就照旧全用 Open-Meteo，不阻塞副图。 */
      if (out.hourly) {
        try {
          const cma = cmaH || await API.Cma.hourlySeries(city);
          if (cma && cma.time && cma.time.length) {
            out.hourlySrc = API.overlayCma(out.hourly, 'time', {
              temp: 'temp', precip: 'precip', wind: 'wind', windDir: 'wdirDeg',
              cloud: 'cloud', cloudLow: 'cloudLow', rh: 'humidity', vis: 'vis', wcode: 'wcode'
            }, cma,
            // 降水与天气码不插值（分类码 / 多为 0，插出来是假的），只覆盖锚点
            ['precip', 'wcode']);
          }
        } catch (e) {
          // ⚠ 这个 catch 曾经把 `cmaH is not defined` 这种**引用错误**一起吞掉，
          // 于是"副图没换成气象局的"看起来像"气象局没给数据" —— 排查时白绕一圈。
          // 现在留一条 warn：静默降级可以，静默掩盖错误不行。
          if (global.console) {
            console.warn('[Weather.ensure] 气象局逐时合并失败，副图继续用 Open-Meteo：', e && e.message);
          }
        }
      }
      try { out.air = await this.air(city.lat, city.lon, 92); } catch (e) { /* 空气是加分项，失败不影响主图 */ }
      this._wx[city.id] = out;
      return out;
    },

    /* ═══════════════ 2. 雷达回波 / 卫星云图 ═══════════════

       两个实测出来的坑，改地址拼接前务必先看这里：

       ① 文件名的时次戳是 **UTC**，不是北京时间。
          实测 2026-10-05 20:15 CST 时，最新一帧是 ..._PI_20261005115400000.PNG，
          换成北京时间正好是 19:54，只滞后 21 分钟；而同一时刻 12:48（＝北京 20:48）
          是 404。所以下面前缀一律用 getUTC* 取值，Date 对象本身仍是真实时刻，
          显示的时候用本地 getter 就自动是北京时间。

       ② **只有全国 ACHN 有 small/ 档**（约 200 KB），其余七个大区
          （东北/华北/华东/华南/华中/西北/西南）**只有原图**，每帧 479–960 KB。
          所以 small 只对 ACHN 用；别的区域一律走原图，靠少取几帧控制流量。 */

    /** 雷达八大区。城市级雷达官方没有发布，能拿到的最细粒度就是这八个大区。 */
    RADAR_REGIONS: [
      { k: 'ACHN', n: '全国' }, { k: 'ANEC', n: '东北' }, { k: 'ANCN', n: '华北' },
      { k: 'AECN', n: '华东' }, { k: 'ACCN', n: '华中' }, { k: 'ASCN', n: '华南' },
      { k: 'ANWC', n: '西北' }, { k: 'ASWC', n: '西南' }
    ],

    /** 省 -> 雷达大区。打开雷达时按当前城市所在省自动选中对应大区。 */
    PROV_REGION: {
      '黑龙江': 'ANEC', '吉林': 'ANEC', '辽宁': 'ANEC',
      '北京': 'ANCN', '天津': 'ANCN', '河北': 'ANCN', '山西': 'ANCN', '内蒙古': 'ANCN',
      '上海': 'AECN', '江苏': 'AECN', '浙江': 'AECN', '安徽': 'AECN', '福建': 'AECN',
      '江西': 'AECN', '山东': 'AECN', '台湾': 'AECN',
      '河南': 'ACCN', '湖北': 'ACCN', '湖南': 'ACCN',
      '广东': 'ASCN', '广西': 'ASCN', '海南': 'ASCN', '香港': 'ASCN', '澳门': 'ASCN',
      '陕西': 'ANWC', '甘肃': 'ANWC', '青海': 'ANWC', '宁夏': 'ANWC', '新疆': 'ANWC',
      '重庆': 'ASWC', '四川': 'ASWC', '贵州': 'ASWC', '云南': 'ASWC', '西藏': 'ASWC'
    },

    /** 城市 -> 该城市对应的雷达大区代号（查不到就回落到全国） */
    regionFor(city) {
      if (!city) return 'ACHN';
      const p = String(city.prov || city.province || '').replace(/省|市|自治区|回族|维吾尔|壮族|特别行政区/g, '');
      return this.PROV_REGION[p] || this.PROV_REGION[String(city.prov || '').slice(0, 2)] || 'ACHN';
    },

    /** 某个 6 分钟整点的雷达拼图地址。region 取 RADAR_REGIONS 里的代号 */
    radarUrl(region, dt, size) {
      const y = dt.getUTCFullYear(), mo = pad2(dt.getUTCMonth() + 1), da = pad2(dt.getUTCDate());
      const ts = '' + y + mo + da + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      // 见上面 ②：只有 ACHN 有 small/ 档，别的区域请求 small/ 会 404
      const small = (size !== 'full') && region === 'ACHN';
      return IMG + '/product/' + y + '/' + mo + '/' + da + '/RDCP/' + (small ? 'small/' : '') +
        'SEVP_AOC_RDCP_SLDAS3_ECREF_' + region + '_L88_PI_' + ts + '.PNG';
    },

    /* ---- 单站雷达：比大区再细一层，能精确到城市 ----------------------------
       中国气象局的雷达产品分三层：全国拼图(ACHN) / 八个大区拼图 / 单站雷达(AZ####)。
       第三层没有任何入口页 —— chinaall.html 里只链了全国、八个大区，外加北京大兴
       一个样例；其它城市的页面只能靠拼 slug 猜（/publish/radar/{省拼音}/{市拼音}.htm）。
       映射表由 tools/radar_slugs.py 离线探测生成（45 城命中 30），前端只读结果。

       代价：单站和大区一样**没有 small/ 档**，每帧 500–900 KB，所以只取 8 帧。 */

    RADAR_CITIES: null,
    async radarCities() {
      if (this.RADAR_CITIES) return this.RADAR_CITIES;
      try {
        const d = await jget('data/radar-cities.json', 86400000, 'radarcity');
        this.RADAR_CITIES = (d && d.stations) || {};
      } catch (e) {
        this.RADAR_CITIES = {};                       // 拿不到就当作"没有单站"，UI 只剩大区
      }
      return this.RADAR_CITIES;
    },

    /** 某个 6 分钟整点的单站雷达图。az 形如 AZ9200 */
    stationUrl(az, dt) {
      const y = dt.getUTCFullYear(), mo = pad2(dt.getUTCMonth() + 1), da = pad2(dt.getUTCDate());
      const ts = '' + y + mo + da + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + mo + '/' + da + '/RDCP/' +
        'SEVP_AOC_RDCP_SLDAS3_ECREF_' + az + '_L88_PI_' + ts + '.PNG';
    },

    /** 单站雷达的逐帧探测，规则与 probeRadar 相同（UTC 网格、每 6 分钟、容忍断档） */
    async probeStation(az, n, onStep) {
      n = n || 8;
      const base = new Date();
      base.setUTCMinutes(Math.floor(base.getUTCMinutes() / 6) * 6, 0, 0);
      const out = [];
      let miss = 0;
      for (let k = 0; k < n * 8 && out.length < n && miss < 30; k++) {
        const dt = new Date(base.getTime() - (k + 1) * 360000);
        const url = this.stationUrl(az, dt);
        /* eslint-disable no-await-in-loop */
        const ok = await this._tryImg(url);
        if (ok) { out.push({ url: url, t: dt, f: true }); miss = 0; }
        else miss++;
        if (onStep) onStep(out.length, n);
      }
      out.reverse();
      return out;
    },

    /** FY-4B 真彩云图（比红外 WXCL 好看，用于"卫星云图"页的第二个产品）。 */
    satColorUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/WXBL/medium/' +
        'SEVP_NSMC_WXBL_FY4B_ETCC_ACHN_LNO_PY_' + ts + '.JPG';
    },

    /** 1 小时降水实况（"降水预报"页的第二个产品：预报 + 实况对照）。
        注意这是 PB_ 前缀、小写 .jpg、15 位时次戳；24 小时预报图是 P9_ + 17 位。 */
    precipNowUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/STFC/medium/' +
        'SEVP_NMC_STFC_SFER_ER1_ACHN_L88_PB_' + ts + '.jpg';
    },

    /** 卫星云图（国家卫星气象中心 FY 系列，产品代号 WXCL）。
        时次戳同样是 UTC，网格是每 30 分钟的 :15 与 :45，偶有缺帧；
        medium/ 约 130 KB（small/ 54 KB、原图 506 KB）。 */
    satUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/WXCL/medium/' +
        'SEVP_NSMC_WXCL_ASC_E99_ACHN_LNO_PY_' + ts + '.JPG';
    },

    /** 中央气象台全国降水量预报图。**产品代号恒为 `ER24`，预报时效藏在时次戳末尾的 5 位里**：
        后缀 = `String(时效小时).padStart(3,'0') + '00'` ——
        24→`02400`、48→`04800`、72→`07200`、96→`09600`、120→`12000`、144→`14400`、168→`16800`。
        （实况那张 ER1 的后缀 `00000` 正是 win=0 的同一规则。）
        ⚠ **扩展名按档不同**：24/48/72 是大写 `.JPG`，而 **96/120/144/168 只有小写 `.jpg` 命中**
        （2026-10-07 逐个 HEAD 实测）。所以 probePrecip 里两个扩展名都要试。
        发布时次走 6 小时网格（00/06/12/18 UTC），但各档不是每次都有 —— 帧探测靠 404 跳过。 */
    PRECIP_WINS: [24, 48, 72, 96, 120, 144, 168],
    precipUrl(dt, win) {
      win = win == null ? 24 : win;
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) +
        String(win).padStart(3, '0') + '00';
      const ext = win <= 72 ? 'JPG' : 'jpg';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/STFC/medium/' +
        'SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_' + ts + '.' + ext;
    },

    /** 同一张预报图的另一种扩展名写法（大写 JPG ↔ 小写 jpg），帧探测时用它兜底 */
    precipUrlAlt(url) {
      return /\.JPG$/.test(url) ? url.replace(/\.JPG$/, '.jpg')
                                : url.replace(/\.jpg$/, '.JPG');
    },

    /* ═══════════ 海陆温（陆地气温实况 + 海表温度）═══════════
       使用者 m00882 要的「陆地温度图 / 海洋温度图」，形态照卫星云图与降水预报。

       ① 陆地温度：**中央气象台「全国气温实况图」**，产品代号 `ET0`、目录 `STFC`，
          文件名与降水实况同构（`..._PB_<yyyyMMddHHMM>00000.jpg`），但时次是**逐小时**。
          页面出处 `https://www.nmc.cn/publish/observations/hourly-temperature.html`
          （标题「天气实况_气温_全国逐时气温」）。实测拉下来那张图上印着
          「全国气温实况图 · 2026年10月8日12时 · 中央气象台」，带色标图例（-12 ℃ ~ >40 ℃）。
          ⚠ 文件名里的时次是 **UTC**、图上印的是**北京时**（差 8 小时）。实测
          （tmp/tstamp_semantics.py，本机 12:45 / UTC 04:45）：今天存在的时次 0..4、
          昨天 2..23 —— 即**最新一帧就是当前 UTC 小时**。别把 UTC 时次当成"图是旧的"。
          扩展名只有小写 `.jpg` 命中。

       ② 海洋温度：**气象局/中央气象台没有这个产品**。逐条查过：
          - `nmc.cn/publish/sitemap.html` 里跟温度有关的只有「气温」「气温预报」两项；
          - `publish/marine/*`（北太平洋形势分析 OSRA、海洋天气公报 OCBU、海洋浮标能见度
            APWF/SOB）都不是海温；`marine/forecast.htm`、`h000.html` 的图另有用途；
          - `publish/marine/index.html`、`sst.html`、`publish/sea/index.html` 都是同一张
            13,482 B 的空壳页；猜过的 `OSTA`/`SSTA` 图床路径全 404；
          - 国家海洋环境预报中心 `www.nmefc.cn` 是 Vue SPA（首页只有 2.5 KB、资源在
            oceanguide.org.cn），拿不到稳定图片地址。
          所以改用 **NASA GIBS 的 WMS**：一次 GetMap 直接返回一张画好的图，不必拼瓦片。
          实测 `GHRSST_L4_MUR_Sea_Surface_Temperature` → 200 / PNG（多光谱 1 km 日合成）。

          ⚠ GIBS 的 TIME 语义**必须先量再用**（tmp/gibs_time.py）：传一个它没有的日期
          **不会报错**，而是返回一张 **2,173 B 的空白 PNG**（sha `75faada3`，未来日期、
          今天、昨天都是它）；真实海温图是 156~166 KB 且每天 sha 不同。也就是说
          `probeSeaTemp` **不能用 `_tryImg` 判存在**（永远 onload 成功），必须读字节大小。
          实测最新可用是**前天**（MUR NRT 滞后约 2 天），不传 TIME 时 GIBS 给的就是它。

       ③ 三个图源都**不认 Referer**（实测：无 / 外站 lolikonnn.github.io / 站内，
          三种都是 200），所以网页端不会重演 `weather.cma.cn` 那个外站 Referer 403。 */

    /** 中央气象台「全国气温实况图」（逐时，UTC 时次，小写 .jpg） */
    landTempUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/STFC/medium/' +
        'SEVP_NMC_STFC_SFER_ET0_ACHN_L88_PB_' + ts + '.jpg';
    },

    /** GIBS 取图范围：东亚 + 西太（东海、南海、日本以南都在里面）。顺序是 W,S,E,N */
    SEA_BBOX: '100,0,150,45',

    /** 海温两种产品。`note` 是要显示在播放器页脚的来源说明 ——
        这不是装饰：数据来自 NASA/NOAA，必须跟"中国气象局"那张陆地图标清楚，
        否则就是把别人家的数据挂在中国气象局名下。 */
    SEA_LAYERS: [
      { k: 'sst', n: '海表温度', layer: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
        note: '数据来源：NASA GIBS · GHRSST MUR 海表温度（日合成）' },
      // ⚠ 图层名是 **Anomalies（复数）**，不是 Anomaly。写成单数时 GIBS 会回一张
      //   错误说明图（不是 404），`<img>` 照样 onload、但解码不出图像 ⇒ 画面空着、
      //   探针只报"超时"。这是查 `GetCapabilities`（1,615 个图层）才定位到的。
      { k: 'anom', n: '温度距平', layer: 'GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies',
        note: '数据来源：NASA GIBS · GHRSST MUR 海表温度距平' }
    ],

    /** 一张 GIBS 海温图。`dt` 为 null 时不传 TIME，GIBS 给最近可用那一天。
        `TRANSPARENT=FALSE&BGCOLOR=0x12141a`：不铺底色的话，没有数据的陆地区域是
        全黑（PNG 带 alpha，压在深色面板上就是纯黑块），跟周围界面差一截；
        铺成应用的主题底色 `#12141a` 就融为一体了。 */
    seaTempUrl(dt, layer, w, h) {
      let u = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi' +
        '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=' +
        '&LAYERS=' + encodeURIComponent(layer) +
        '&SRS=EPSG:4326&BBOX=' + this.SEA_BBOX +
        '&WIDTH=' + (w || 1200) + '&HEIGHT=' + (h || 780) +
        '&FORMAT=image/png&TRANSPARENT=FALSE&BGCOLOR=0x12141a';
      if (dt) {
        u += '&TIME=' + dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) +
          '-' + pad2(dt.getUTCDate());
      }
      return u;
    },

    /* ── 帧列表缓存 ──
       每个图源"多久出一张新图"是**已知的**，所以"每次打开都从头探一遍"纯属白干。
       实测代价：陆地气温 12 张 × 105 KB、雷达 9 张 ≈ 4.9 MB、海温 11 次 fetch ≈ 2.5 MB，
       而且**五个探针全是串行 `for` + `await`** ⇒ 12 帧就是 12 个 RTT。
       这里按各自的节拍缓存**探测结果**（不是图片本身），再打开时直接用：

         雷达 6 分钟一帧      → 缓存 3 分钟
         卫星 30 分钟一帧     → 缓存 15 分钟
         降水实况 1 小时/预报 6 小时 → 缓存 30 分钟
         陆地气温 1 小时一帧  → 缓存 10 分钟
         海温 **1 天**一帧    → 缓存 6 小时

       ⚠ 存的是 **HTTP URL**，绝不能把 `blob:` URL 写进去 —— blob URL 只在这个页面活着，
         下次读出来是死的。用 sessionStorage：同标签页刷新还在，关掉浏览器就清。 */
    _framesKey(k) { return 'tjs.frames.' + k; },
    _cacheGet(key) {
      try {
        const raw = sessionStorage.getItem(this._framesKey(key));
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || !o.exp || o.exp < Date.now() || !(o.frames || []).length) return null;
        return o.frames.map(f => ({ url: f.u, t: new Date(f.t), f: true }));
      } catch (e) { return null; }
    },
    _cachePut(key, frames, ttlMs) {
      // 缓存不是必需品：配额满了 / 隐私模式禁了 sessionStorage，都只是"下次再探一遍"。
      try {
        sessionStorage.setItem(this._framesKey(key), JSON.stringify({
          exp: Date.now() + ttlMs,
          frames: frames.map(f => ({ u: f.url, t: +f.t }))     // 只存 HTTP URL
        }));
      } catch (e) { /* 算了 */ }
    },

    /* ── 海温专用的两件套 ──
       ① 用 **32×32 的小图**探"这一天有没有数据"：实测 32×32 时有数据 ≈1.2 KB、空白 =104 B，
          分得非常干净；而 1200×780 一张就是 232 KB。探针只为拿一个是非答案，
          没必要把整张大图拖下来。9 次探针从 ~2.1 MB 降到 ~11 KB。
       ② 把**要显示**的那几张 `fetch` 成 `blob:` URL 缓存起来。
          这一步是必须的 —— GIBS 明确发 `Cache-Control: max-age=0, no-store`，
          浏览器不许缓存，不自己留一份的话：换个帧要重下、重开面板还要重下。 */
    _blobs: Object.create(null),
    _blobOrder: [],
    async _blob(url) {
      const c = this._blobs[url];
      if (c) return c;
      const r = await fetch(url, { mode: 'cors' });
      const b = await r.blob();
      const o = URL.createObjectURL(b);
      this._blobs[url] = o;
      this._blobOrder.push(url);
      while (this._blobOrder.length > 24) {          // 上限 24 张 ≈ 6 MB
        const k = this._blobOrder[0];
        if (k === url) break;                        // 别把刚存的这条挤掉
        this._blobOrder.shift();
        try { URL.revokeObjectURL(this._blobs[k]); } catch (e) { }
        delete this._blobs[k];
      }
      return o;
    },
    async _probeSmall(url) {
      try {
        const r = await fetch(url, { mode: 'cors' });
        const b = await r.blob();
        return b.size >= 600;      // 32×32：有数据 ≈1.2 KB、空白 104 B，600 是安全的分界
      } catch (e) { return false; }
    },

    /** 陆地气温实况：从当前 UTC 小时往回凑 n 帧（整点网格，404 = 这一小时没有）。
        ⚠ 原来是**一小时一小时串行等**的：12 帧就是 12 个 RTT，光回环就一秒多。
        现在先把整段窗口**并发**探一遍，再按结果挑帧。 */
    async probeLandTemp(n, onStep) {
      n = n || 10;
      const key = 'land';
      const hit = this._cacheGet(key);
      if (hit) { if (onStep) onStep(hit.length, n); return hit; }
      const now = new Date();
      const base = new Date(now.getTime());
      base.setUTCMinutes(0, 0, 0);
      // 整段窗口一次并发探完（比串行快一个数量级），再按结果挑帧。
      const cand = [];
      for (let k = 0; k < n + 4; k++) cand.push(new Date(base.getTime() - k * 3600000));
      const flags = await Promise.all(cand.map(dt => this._tryImg(this.landTempUrl(dt))));
      const out = [];
      let miss = 0;
      // 容忍连续 miss：官方偶尔断档（实测昨天就缺 00、01 两个时次），
      // 但也不能无限往前翻 —— 连续 10 个空就认为到头了。
      for (let k = 0; k < cand.length && out.length < n && miss < 10; k++) {
        if (flags[k]) { out.push({ url: this.landTempUrl(cand[k]), t: cand[k], f: true }); miss = 0; }
        else miss++;
      }
      out.sort((a, b) => a.t - b.t);
      if (out.length) this._cachePut(key, out, 10 * 60000);     // 逐小时发布 ⇒ 缓存 10 分钟
      if (onStep) onStep(out.length, n);
      return out;
    },

    /** 海温：逐日往回凑 n 帧。
        ⚠ **不能用 `_tryImg` 判存在** —— 见上面 ② 里量到的：GIBS 对没有数据的日期
        照样回 200，只是那张 PNG 只有 2,173 B。所以这里直接 `fetch` 读 `blob().size`，
        小于 20 KB 的当空白丢掉。（GIBS 带 `Access-Control-Allow-Origin: *`，能读。）
        `dt` 为 null 时退化成"只要最新那一张"，探测失败时的兜底。 */
    async probeSeaTemp(n, onStep, layer) {
      n = n || 8;
      layer = layer || this.SEA_LAYERS[0].layer;
      const key = 'sea|' + layer;
      const now = new Date();
      // ① 先看缓存。海温是**逐日**产品、MUR NRT 还滞后两天 ⇒ 一天最多多出一帧，
      //    缓存 6 小时完全够，而"每次打开都重探一遍"是纯浪费。
      let hitUrls = null;
      const hit = this._cacheGet(key);
      if (hit) hitUrls = hit;
      const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      let days;
      if (hitUrls) {
        days = hitUrls.map(f => f.t);
      } else {
        // ② 用 **32×32 的小图**并发问"哪几天有数据"（有 ≈1.2 KB / 无 =104 B）。
        const cand = [];
        for (let k = 1; k <= n + 4; k++) cand.push(new Date(base.getTime() - k * 86400000));
        const flags = await Promise.all(cand.map(dt =>
          this._probeSmall(this.seaTempUrl(dt, layer, 32, 32))));
        days = cand.filter((dt, i) => flags[i]).slice(0, n);
      }
      if (onStep) onStep(days.length, n);
      if (!days.length) {
        // 全都没数据（极端情况）→ 退回"不传 TIME"，让 GIBS 给最近可用那张
        let u = this.seaTempUrl(null, layer);
        try { u = await this._blob(u); } catch (e) { }
        const one = [{ url: u, t: now, f: true }];
        return one;
      }
      // ③ 要显示的那几张。
      //    ⚠ 这里原来是把 **n 张全尺寸图一起** `_blob()` 出来再返回 —— 海温来自 NASA GIBS，
      //    单张 1200×780 的 GetMap 要好几秒，8 张并发还会被浏览器 6 条连接卡住，
      //    于是"打开面板"要等十几秒（用户 2026-10-19 报的就是这个）。
      //    现在**只等最新那一张**（它就是要显示的那张），其余先给原始 URL 立刻返回；
      //    剩下的在后台慢慢换成 blob（换过的帧改回 blob URL，之后切帧就不用再下）。
      const urls = days.map(dt => this.seaTempUrl(dt, layer));
      const out = days.map((dt, i) => ({ url: urls[i], t: dt, f: true }));
      const newest = out[0];                      // days 是新→旧，out[0] 就是最新一帧
      try { newest.url = await this._blob(newest.url); } catch (e) { }
      out.sort((a, b) => a.t - b.t);
      if (!hitUrls) this._cachePut(key, days.map(dt => ({ url: this.seaTempUrl(dt, layer), t: dt })), 6 * 3600000);
      // 后台把其余几帧也换成 blob；换完直接改 frame.url —— renderPlayer 每次 show() 都读 f.url，
      // 所以之后切帧、重开面板都不会再走网络（GIBS 是 no-store，不自己留一份就得重下）。
      setTimeout(() => {
        out.forEach(f => {
          if (!f || f.url.indexOf('blob:') === 0) return;
          const plain = f.url;
          this._blob(plain).then(b => { f.url = b; }).catch(() => { });
        });
      }, 600);
      return out;
    },

    /** 逐帧试探：能把 404 变成"跳过这一帧"，因为图床对不存在的时次返回 404 */
    _tryImg(url) {
      return new Promise(res => {
        const im = new Image();
        im.onload = () => res(true);
        im.onerror = () => res(false);
        im.src = url;
      });
    },

    /** 只要"这张图在不在"，不要图本身。
        图床 `image.nmc.cn` 回 `Access-Control-Allow-Origin: *`（实测 HEAD 200 + 287 KB 那张），
        所以可以直接 HEAD —— 一次开页几十个几百字节的请求，比把每张 200~300 KB 的图都
        拉下来试便宜两个数量级。万一哪天 HEAD 被挡（CORS 失效 / 405），退回 `_tryImg`。 */
    async _headOk(url) {
      try {
        const r = await fetch(url, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
        if (r.ok) return true;
        if (r.status === 405 || r.status === 403) return this._tryImg(url);
        return false;
      } catch (e) {
        return this._tryImg(url);
      }
    },

    /** 探测最近有货的雷达帧：从"现在"的 6 分钟整点往回试，凑够 n 帧。
        官方约滞后 20 分钟发布，中间偶尔断档，所以容忍一段连续 miss 再放弃。 */
    async probeRadar(region, n, onStep) {
      n = n || 16;
      const key = 'radar|' + region;
      const hit = this._cacheGet(key);
      if (hit) { if (onStep) onStep(hit.length, n); return hit; }
      const base = new Date();
      base.setUTCMinutes(Math.floor(base.getUTCMinutes() / 6) * 6, 0, 0);
      // 并发探完整段窗口（原来是一帧一帧串行等，16 帧 = 16 个 RTT）
      const cand = [];
      for (let k = 1; k <= n + 4; k++) cand.push(new Date(base.getTime() - k * 360000));
      const urls = cand.map(dt => this.radarUrl(region, dt, 'small'));
      const flags = await Promise.all(urls.map(u => this._tryImg(u)));
      const out = [];
      let miss = 0;
      for (let k = 0; k < cand.length && out.length < n && miss < 30; k++) {
        if (flags[k]) { out.push({ url: urls[k], t: cand[k], f: true }); miss = 0; }
        else miss++;
      }
      out.reverse();                       // 时间正序：最早的在前
      if (out.length) this._cachePut(key, out, 3 * 60000);      // 6 分钟一帧 ⇒ 缓存 3 分钟
      if (onStep) onStep(out.length, n);
      return out;
    },

    /** 卫星云图：从最近的一个 :15 / :45 世界时时次往回凑 n 帧。
        kind='ir' 红外云图 WXCL ｜ 'rgb' FY-4B 真彩云图 WXBL */
    async probeSat(n, onStep, kind) {
      n = n || 12;
      const rgb = kind === 'rgb';
      const key = 'sat|' + (rgb ? 'rgb' : 'ir');
      const hit = this._cacheGet(key);
      if (hit) { if (onStep) onStep(hit.length, n); return hit; }
      const now = new Date();
      const base = new Date(now.getTime());
      base.setUTCMinutes(base.getUTCMinutes() < 45 ? 15 : 45, 0, 0);
      const cand = [];
      for (let k = 0; k < n + 4; k++) {
        const dt = new Date(base.getTime() - k * 1800000);
        if (dt.getTime() > now.getTime()) continue;
        cand.push(dt);
      }
      const urls = cand.map(dt => (rgb ? this.satColorUrl(dt) : this.satUrl(dt)));
      const flags = await Promise.all(urls.map(u => this._tryImg(u)));
      const out = [];
      for (let k = 0; k < cand.length && out.length < n; k++) {
        if (flags[k]) out.push({ url: urls[k], t: cand[k], f: true });
      }
      out.sort((a, b) => a.t - b.t);
      if (out.length) this._cachePut(key, out, 15 * 60000);     // 30 分钟一帧 ⇒ 缓存 15 分钟
      if (onStep) onStep(out.length, n);
      return out;
    },

    /** 降水图两种：
        kind='fcst' 全国降水量**预报**图，win = 预报时效小时（24/48/72/96/120/144/168，见 PRECIP_WINS）
        kind='now'  最近 1 小时**实况**（每小时一张，整点）

        ⚠ **发布时次不在 6 小时网格上**（2026-10-19 逐个 HEAD 实测，见 tmp/precip_cadence.txt）：
          24 小时档发在 UTC **01 / 07 / 13 / 19**，48 / 72 档发在 **01 / 13**，
          96 / 120 / 144 / 168 档发在 **00 / 12**。
          旧实现只试 00 / 06 / 12 / 18，于是每一档都差一小时、全部 404 —— 页面直接
          显示「暂时取不到降水图」（用户 2026-10-19 报的就是这个）。
          现在改成**按小时往回扫**（最多 48 小时，凑够 n 帧就停），不再假设网格。

        探测用 HEAD（图床带 `Access-Control-Allow-Origin: *`，实测 200 + 287 KB 的那张也一样），
        这样一次开页只花几十个几百字节的请求，不用把每张 200~300 KB 的图都拉下来试。 */
    async probePrecip(n, onStep, kind, win) {
      n = n || 6;
      const nowKind = kind === 'now';
      const key = 'precip|' + (nowKind ? 'now' : 'fcst|' + win);
      const hit = this._cacheGet(key);
      if (hit) { if (onStep) onStep(hit.length, n); return hit; }
      const now = new Date();
      const base = new Date(now.getTime());
      base.setUTCMinutes(0, 0, 0);
      const CAP = nowKind ? 12 : 48;            // 最多往回扫多少小时
      const cand = [];
      for (let k = 0; k < CAP; k++) {
        const dt = new Date(base.getTime() - k * 3600000);
        if (dt.getTime() > now.getTime()) continue;
        cand.push(dt);
      }
      const uMain = cand.map(dt => (nowKind ? this.precipNowUrl(dt) : this.precipUrl(dt, win)));
      const okMain = await Promise.all(uMain.map(u => this._headOk(u)));
      const out = [];
      for (let k = 0; k < cand.length && out.length < n; k++) {
        if (okMain[k]) out.push({ url: uMain[k], t: cand[k], f: true });
      }
      // 主扩展名没凑够，再用另一种扩展名把漏掉的时次补一遍
      //（同一档的扩展名不统一：24/48/72 是大写 .JPG，96 以上只认小写 .jpg）
      if (out.length < n && !nowKind) {
        const miss = [];
        for (let k = 0; k < cand.length; k++) if (!okMain[k]) miss.push(k);
        const uAlt = miss.map(k => this.precipUrlAlt(uMain[k]));
        const okAlt = await Promise.all(uAlt.map(u => this._headOk(u)));
        for (let j = 0; j < miss.length && out.length < n; j++) {
          if (okAlt[j]) out.push({ url: uAlt[j], t: cand[miss[j]], f: true });
        }
      }
      out.sort((a, b) => a.t - b.t);
      if (out.length) this._cachePut(key, out, 30 * 60000);     // 实况 1 小时 / 预报 6 小时 ⇒ 缓存 30 分钟
      if (onStep) onStep(out.length, n);
      return out;
    },

    /* ═══════════════ 3. 台风 ═══════════════ */
    async typhoonList() {
      const d = await jget(NMC + '/typhoon/jsons/list_default', 900000, 'ty|list');
      const arr = (d && d.typhoonList) || [];
      return arr.map(r => ({
        id: r[0], en: r[1], cn: (r[2] || '').replace(/[\s\\n]+/g, ''), no: r[3],
        num: r[4], meaning: r[6], live: r[7] === 'start'
      }));
    },

    async typhoonView(id) {
      const d = await jget(NMC + '/typhoon/jsons/view_' + id, 600000, 'ty|v|' + id);
      const ty = d && d.typhoon;
      if (!ty) throw new Error('没有这个台风');
      const pts = (ty[8] || []).map(p => ({
        id: p[0], t: p[1], epoch: p[2], cat: p[3],
        lon: num(p[4]), lat: num(p[5]), pres: num(p[6]), wind: num(p[7]),
        moveDir: p[8], moveSpd: num(p[9]),
        radii: p[10] || [],
        fcst: this._fcst(p[11]),
        issue: (p[12] || [])[1] || ''
      })).filter(p => p.lat != null && p.lon != null);
      return {
        id: ty[0], en: ty[1], cn: (ty[2] || '').replace(/[\s\\n]+/g, ''), no: ty[3],
        meaning: ty[6], live: ty[7] === 'start', pts: pts
      };
    },

    /** 各家预报：{"BABJ":[[12,"202610050000",lon,lat,pres,wind,"BABJ","TS"],...]} */
    _fcst(o) {
      if (!o) return [];
      const out = [];
      for (const org in o) {
        (o[org] || []).forEach(r => {
          out.push({ org: org, h: num(r[0]), t: r[1], lon: num(r[2]), lat: num(r[3]),
                     pres: num(r[4]), wind: num(r[5]), cat: r[7] });
        });
      }
      out.sort((a, b) => a.h - b.h);
      return out;
    },

    /* ═══════════════ 4. 预警信号 ═══════════════ */
    async warnings() {
      const d = await jget(NMC + '/fetch_json/warning/json', 300000, 'warn');
      const arr = Array.isArray(d) ? d : [];
      return arr.map(r => ({
        title: r[0] || '', time: r[5] || '',
        icon: r[6] ? (IMG + r[6]) : '',
        lat: num(r[7]), lon: num(r[8]), text: r[9] || ''
      }));
    },

    /* ═══════════════ 5. 底图 ═══════════════ */
    _map: null,
    async chinaMap() {
      if (this._map) return this._map;
      const d = await jget('data/china.json', 86400000, 'chinamap');
      this._map = d;
      if (global.echarts) {
        try { echarts.registerMap('wxChina', d); } catch (e) { /* 重复注册无所谓 */ }
      }
      return d;
    },

    /* 台风专用的"亚洲-太平洋"底图。中国底图只画中国，台风跑到 168°E
       那种地方就是一片空白，所以这里换成裁过的世界图（151 KB，
       由 tools/slim_world.py 从 echarts 的 world.json 生成）。
       只在第一次打开台风页时才加载，主页不为它付流量。 */
    _wmap: null,
    async worldMap() {
      if (this._wmap) return this._wmap;
      const d = await jget('data/world.json', 86400000, 'worldmap');
      this._wmap = d;
      if (global.echarts) {
        try { echarts.registerMap('wxWorld', d); } catch (e) { /* 重复注册无所谓 */ }
      }
      return d;
    },

    /* ═══════════════ 6. 等级字典 ═══════════════ */
    CAT: {
      TD: { n: '热带低压', c: '#7fd4ff' }, TS: { n: '热带风暴', c: '#5ce08a' },
      STS: { n: '强热带风暴', c: '#f0c419' }, TY: { n: '台风', c: '#ff9f43' },
      STY: { n: '强台风', c: '#ff5c5c' }, SuperTY: { n: '超强台风', c: '#d24bff' },
      TDd: { n: '热带低压', c: '#7fd4ff' }
    },
    catName(k) { return (this.CAT[k] || {}).n || k || '--'; },
    catColor(k) { return (this.CAT[k] || {}).c || '#8fa4bd'; },

    /** AQI 分级（美标 EPA） */
    aqiLevel(a) {
      if (a == null) return { n: '--', c: '#8fa4bd' };
      if (a <= 50) return { n: '优', c: '#5ce08a' };
      if (a <= 100) return { n: '良', c: '#f0c419' };
      if (a <= 150) return { n: '轻度污染', c: '#ff9f43' };
      if (a <= 200) return { n: '中度污染', c: '#ff5c5c' };
      if (a <= 300) return { n: '重度污染', c: '#c0392b' };
      return { n: '严重污染', c: '#8e44ad' };
    },

    /* 风向：角度 -> 16 方位中文。
       用的是气象上通行的 16 方位名（北 / 北东北 / 东北 / 东东北 …），
       不要写成「北北东」那种 —— 虽然意思对得上，但中文预报里没人这么说，
       拼出来是「北北东风」，用户会以为显示错了（报过一次）。 */
    DIR16: ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南',
            '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'],
    dirName(deg) {
      if (deg == null) return '--';
      return this.DIR16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] + '风';
    },

    /* ═══════════════ 7. 逐小时副图（替换炒股指标） ═══════════════ */
    /** 把时间轴裁到看得清的窗口：默认从"现在"起 48 小时 */
    window(wx, hours) {
      if (!wx || !wx.time || !wx.time.length) return null;
      hours = hours || 48;
      let i0 = 0;
      const now = Date.now() - 3600000, off = wx.off == null ? 28800 : wx.off;
      for (let i = 0; i < wx.time.length; i++) {
        const t = Date.parse(wx.time[i].replace(' ', 'T') + ':00Z') - off * 1000;
        if (t >= now) { i0 = Math.max(0, i - 2); break; }
      }
      const e = i0 + hours;
      const cut = a => (a || []).slice(i0, e);
      return {
        // key 是原始时间戳（series() 里同名数组也一样），主图叠加时靠它精确对齐，
        // 不要用 label —— label 是给人看的，已经截断过。
        key: cut(wx.time),
        label: cut(wx.time).map(s => s.slice(5, 16).replace('T', ' ')),
        temp: cut(wx.temp), precip: cut(wx.precip), prob: cut(wx.prob),
        wind: cut(wx.wind), windDir: cut(wx.windDir), gust: cut(wx.gust),
        cloud: cut(wx.cloud), cloudLow: cut(wx.cloudLow),
        cloudMid: cut(wx.cloudMid), cloudHigh: cut(wx.cloudHigh),
        rh: cut(wx.rh), uv: cut(wx.uv), vis: cut(wx.vis), dew: cut(wx.dew)
      };
    },

    /* ═══════════ 7.5 副图按周期出数（分时 / 7日 / 日K / 周K / 月K / 预报K） ═══════════

       原来 drawSub 里写死 `window(wx.hourly, 48)` —— 不管选哪个周期都只画
       "从现在起 48 小时"（48 根柱子、每根 1 小时），所以用户会觉得
       "降水/风/云量/空气的数据太少、间隔太长"。实际上逐小时数组本身横跨
       past_days+forecast_days 天，只要按周期重新分桶聚合就行，不用再发请求。

       聚合口径按物理量该有的口径选，不是一律取平均：
         降水量      窗口内 **求和**（一天的雨量 = 各小时之和）
         降水概率    窗口内 **最大**（这一天下雨的可能性）
         风速/阵风   窗口内 **最大**（这一天风最大的时候）
         云量        窗口内 **平均**
         PM2.5/AQI   窗口内 **平均**
         气温        窗口内 **平均**
       桶的边界用**当地时间**（Open-Meteo 已按时区返回本地时间字符串）。 */
    series(hourly, air, name, period) {
      period = period || 'trend';
      if (!hourly || !hourly.time || !hourly.time.length) return null;

      const T = hourly.time;
      const dayStr = t => String(t).slice(0, 10);
      const fmt = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      const dayAdd = (ds, n) => {
        const p = ds.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
        d.setDate(d.getDate() + n); return fmt(d);
      };
      const weekStart = ds => {
        const p = ds.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return fmt(d);
      };
      // ★ 必须用**墙上时钟的当地日期**，绝不能用 hourly.i0。
      // i0 是为"现在该高亮哪个小时"算的，里面为了容忍 Open-Meteo 的发布延迟，
      // 故意把 now 往前退了 3 小时、再向前取一格（见本文件 hourly()）。
      // 于是北京时间 00:00~04:00 之间 i0 会落在**前一天**，整个取数窗口跟着整体前移一天：
      // 主图的"7 日"（Store.loadCity 用 todayStr() 算窗口）起点是昨天，
      // 副图的"7 日"起点却变成前天 —— 上下两块图整整差一天，正是用户报的"日期没对齐"。
      // 这个 bug 只在凌晨那几个小时复现，白天怎么试都是对的，所以拖了很久才被看见。
      const today = new Date(Date.now() + (hourly.off == null ? 28800 : hourly.off) * 1000).toISOString().slice(0, 10);

      // 分时 = "今天 00:00~23:00"，跟主图 d.intraday 完全一致。
      // 原来这里交给 window(hourly, 24)，那是"从现在往前 2 小时起 24 小时"，
      // 跟主图的窗口根本不是一回事，副图会整体错开几格。
      if (period === 'trend') {
        const out0 = {
          mode: 'hour', span: '今天 · 逐小时', key: [], label: [], temp: [], precip: [], prob: [],
          wind: [], gust: [], windDir: [], cloud: [], cloudLow: [], cloudMid: [], cloudHigh: [],
          uv: [], pm25: [], aqi: []
        };
        for (let i = 0; i < T.length; i++) {
          if (dayStr(T[i]) !== today) continue;
          out0.key.push(T[i]);
          out0.label.push(T[i].slice(5, 16).replace('T', ' ').replace('-', '/'));
          out0.temp.push(hourly.temp[i]); out0.precip.push(hourly.precip[i]);
          out0.prob.push(hourly.prob[i]); out0.wind.push(hourly.wind[i]);
          out0.gust.push(hourly.gust[i]); out0.windDir.push(hourly.windDir[i]);
          out0.cloud.push(hourly.cloud[i]); out0.cloudLow.push(hourly.cloudLow[i]);
          out0.cloudMid.push(hourly.cloudMid[i]); out0.cloudHigh.push(hourly.cloudHigh[i]);
          out0.uv.push(hourly.uv[i]);
          const ai = air && air.time ? air.time.indexOf(T[i]) : -1;
          out0.pm25.push(ai >= 0 ? (air.pm25 || [])[ai] : null);
          out0.aqi.push(ai >= 0 ? (air.aqi || [])[ai] : null);
        }
        return out0.key.length ? out0 : null;
      }

      // 空气质量是另一个请求，起止时刻不一定对齐 —— 按时间字符串查表对齐
      const aIdx = {};
      if (air && air.time) for (let i = 0; i < air.time.length; i++) aIdx[air.time[i]] = i;
      const airP = (k, t) => {
        const i = aIdx[t];
        if (i == null) return null;
        const v = (air[k] || [])[i];
        return v == null ? null : v;
      };

      // 每个周期：取数窗口 + 分桶键（keyOf=null 表示不聚合，保持逐小时）
      // 窗口尽量**盖住主图默认可见的那一段**：主图日K 默认只显示最近 90 根，
      // 副图要是只取"最近 60 天到今天"，可见区右端那十几根预报就是空的 ——
      // 所以 K 线周期一律把 to 放到预报末尾（hourly 里本来就有 16 天预报）。
      // 注意逐小时数据本身只能回溯 92 天，周K/月K 主图跨度远大于此，
      // 副图只能在有数据的那一段里画 —— 见 drawSub 里按主图类别对齐的处理。
      let from, to, keyOf, mode, span;
      if (period === '7day') {
        // 需求：天气预报最重要的是"预报"，所以 7 日 = 昨天 → 未来第五天。
        // 2026-10-07：从"昨天→未来第三天"扩到"未来第五天"，跟右侧盘口的「未来 5 日」对齐。
        from = dayAdd(today, -1); to = dayAdd(today, 5);
        keyOf = null; mode = 'hour'; span = '昨天 → 未来五天 · 逐小时';
      } else if (period === 'day') {
        from = dayAdd(today, -79); to = dayAdd(today, 15);
        keyOf = dayStr; mode = 'day'; span = '最近 80 天 + 16 天预报 · 逐日';
      } else if (period === 'week') {
        from = dayAdd(today, -91); to = dayAdd(today, 15);
        keyOf = t => weekStart(dayStr(t)); mode = 'week'; span = '逐小时能覆盖的最近十几周 · 逐周';
      } else if (period === 'month') {
        const p = today.split('-'), d = new Date(+p[0], +p[1] - 1, 1);
        d.setMonth(d.getMonth() - 23); from = fmt(d); to = dayAdd(today, 15);
        keyOf = t => dayStr(t).slice(0, 7); mode = 'month'; span = '逐小时能覆盖的最近几个月 · 逐月';
      } else {                                   // fcst 预报K
        // 主图预报K = 最近 10 天 + 未来 16 天，这里取同一段，两边根数正好一致
        from = dayAdd(today, -10); to = dayAdd(today, 15);
        keyOf = dayStr; mode = 'day'; span = '最近 10 天 + 未来 16 天 · 逐日';
      }

      // 逐小时 -> 分桶
      const buckets = [], byKey = {};
      for (let i = 0; i < T.length; i++) {
        const ds = dayStr(T[i]);
        if (ds < from || ds > to) continue;
        const k = keyOf ? keyOf(T[i]) : null;
        let b;
        if (k == null) {
          b = { key: T[i], label: T[i].slice(5, 16).replace('T', ' ').replace('-', '/'), rows: [] };
          buckets.push(b);
        } else {
          b = byKey[k];
          if (!b) {
            b = byKey[k] = {
              key: k,
              label: (mode === 'month' ? k.replace('-', '/') : k.slice(5).replace('-', '/')),
              rows: []
            };
            buckets.push(b);
          }
        }
        b.rows.push({
          temp: hourly.temp[i], precip: hourly.precip[i], prob: hourly.prob[i],
          wind: hourly.wind[i], gust: hourly.gust[i], windDir: hourly.windDir[i],
          cloud: hourly.cloud[i], cloudLow: hourly.cloudLow[i],
          cloudMid: hourly.cloudMid[i], cloudHigh: hourly.cloudHigh[i],
          // 紫外线也跟着一起分桶：它和云量强相关，放在「空气」那一组的第二条线上看最顺
          uv: hourly.uv[i],
          pm25: airP('pm25', T[i]), aqi: airP('aqi', T[i])
        });
      }
      if (!buckets.length) return null;

      const agg = (rows, k, how) => {
        const a = rows.map(r => r[k]);
        if (how === 'sum') { let s = 0; a.forEach(v => { s += (v || 0); }); return +s.toFixed(1); }
        if (how === 'max') { let m = null; a.forEach(v => { if (v != null && (m == null || v > m)) m = v; }); return m; }
        let s = 0, n = 0; a.forEach(v => { if (v != null) { s += v; n++; } });
        return n ? +(s / n).toFixed(1) : null;
      };
      // 主导风向：取风最大那一刻的风向（角度直接取平均是错的）
      const dirAt = rows => {
        let bd = null, bw = -1;
        rows.forEach(r => { if (r.wind != null && r.wind > bw) { bw = r.wind; bd = r.windDir; } });
        return bd;
      };

      const out = {
        mode: mode, span: span, key: [], label: [], temp: [], precip: [], prob: [],
        wind: [], gust: [], windDir: [], cloud: [], cloudLow: [], cloudMid: [],
        cloudHigh: [], uv: [], pm25: [], aqi: []
      };
      buckets.forEach(b => {
        out.key.push(b.key);
        out.label.push(b.label);
        out.temp.push(agg(b.rows, 'temp', 'mean'));
        out.precip.push(agg(b.rows, 'precip', 'sum'));
        out.prob.push(agg(b.rows, 'prob', 'max'));
        out.wind.push(agg(b.rows, 'wind', 'max'));
        out.gust.push(agg(b.rows, 'gust', 'max'));
        out.windDir.push(dirAt(b.rows));
        out.cloud.push(agg(b.rows, 'cloud', 'mean'));
        out.cloudLow.push(agg(b.rows, 'cloudLow', 'mean'));
        out.cloudMid.push(agg(b.rows, 'cloudMid', 'mean'));
        out.cloudHigh.push(agg(b.rows, 'cloudHigh', 'mean'));
        // 紫外线按窗口取**最大**值：平均值会把正午的强紫外摊薄成一个温和的数字，
        // 而"今天要不要防晒"问的就是峰值。
        out.uv.push(agg(b.rows, 'uv', 'max'));
        out.pm25.push(agg(b.rows, 'pm25', 'mean'));
        out.aqi.push(agg(b.rows, 'aqi', 'mean'));
      });
      return out;
    },

    /** 副图定义表：名字 -> {标题, 单位, 数据源} */
    SUBS: [
      { k: 'range',  n: '温差',   tip: '每天一根柱子，柱子越高说明那天忽冷忽热（最高温与最低温的差）' },
      { k: 'precip', n: '降水',   tip: '降水量（柱子）和下雨概率（黄线）。跟着上面的周期走：分时看小时、日K看天、周K看周' },
      { k: 'wind',   n: '风',     tip: '风速（柱子）、阵风（虚线）和风向（箭头）。跟着周期走：日K取当天最大风，周K取当周最大风' },
      { k: 'cloud',  n: '云量',   tip: '总云量（白线）以及低云/中云/高云各占多少。跟着周期走，按窗口取平均' },
      { k: 'air',    n: '空气',   tip: '空气质量指数 AQI 与 PM2.5 浓度，外加紫外线强度。跟着周期走，AQI/PM2.5 按窗口取平均，紫外线取窗口内最大值' }
    ],

    isWeatherSub(k) { return this.SUBS.some(s => s.k === k); }
  };

  global.Weather = Weather;
})(window);
