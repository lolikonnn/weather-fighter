# 数据接口汇总

**这份文档回答一个问题：页面上每一个数字、每一张图，是从哪个接口拿的。**

站点本身没有自建后端。所有数据都来自下面这些**公开、免费、免 key** 的接口，只有一个可选的本地代理（EXE / APK 里为了绕开 `Referer` 和 CORS 限制才需要）。所有接口都实测过，试过但不通的都记在最后一节。

---

## 一、总览

| # | 数据源 | 提供什么 | 基址 | 鉴权 | CORS |
|---|---|---|---|---|---|
| 1 | 中国气象局 | 实况、7 日预报、逐小时、城市检索 | `https://weather.cma.cn` | 无 | `*` 开放 |
| 2 | 中国天气网 d1 | 实况、今日预报、月度逐日历史/预报 | `http://d1.weather.com.cn` | **要 `Referer`** | 无 |
| 3 | Open-Meteo 预报 | 历史逐小时 + 16 日预报（K 线引擎） | `https://api.open-meteo.com` | 无 | `*` 开放 |
| 4 | Open-Meteo 存档 | 更久的历史逐小时 | `https://archive-api.open-meteo.com` | 无 | `*` 开放 |
| 5 | Open-Meteo 历史预报 | 同 3，**额度独立分桶** | `https://historical-forecast-api.open-meteo.com` | 无 | `*` 开放 |
| 6 | Open-Meteo 空气质量 | PM2.5 逐小时 | `https://air-quality-api.open-meteo.com` | 无 | `*` 开放 |
| 7 | Open-Meteo 上轮预报 | 一天前 / 三天前的预报值 | `https://previous-runs-api.open-meteo.com` | 无 | `*` 开放 |
| 8 | Open-Meteo 地理编码 | 拼音 / 英文 → 经纬度 | `https://geocoding-api.open-meteo.com` | 无 | `*` 开放 |
| 9 | 中央气象台台风网 | 台风列表、路径点、预警信号 | `https://typhoon.nmc.cn/weatherservice` | 无 | `*` 开放 |
| 10 | 中央气象台图库 | 雷达回波、卫星云图、降水实况/预报 | `https://image.nmc.cn/product/…` | 无 | 图片无所谓 |
| 11 | 美国地质调查局 | 全球地震目录 | `https://earthquake.usgs.gov/fdsnws/event/1/query` | 无 | `*` 开放 |
| 12 | 中国天气网搜索 | 城市名 → 城市 ID | `http://toy1.weather.com.cn/search` | 建议带 `Referer` | 无 |
| 13 | 阿里 DataV | 行政区划边界 / 三级地名 | `https://geo.datav.aliyun.com/areas_v3/bound/` | 无 | `*` |
| 14 | jsDelivr CDN | 中国行政区划名单、ECharts 世界地图 | `https://cdn.jsdelivr.net/…` | 无 | `*` |
| 15 | GitHub API | 推送、查提交 | `https://api.github.com` | **PAT** | — |
| 16 | Google | Android SDK 包索引 | `https://dl.google.com/android/repository/` | 无 | — |

> 「CORS `*` 开放」的意思是**浏览器可以直连**。没有这一条的数据源，网页端就必须走本地代理或读提前抓好的静态文件 —— 见下一节。

---

## 二、三种运行形态，与取数优先级

同一份代码跑在三个地方，能用的通道不一样：

| 形态 | 跑在哪 | 有什么 | 没有什么 |
|---|---|---|---|
| **网页版** | GitHub Pages | 直连 CORS 开放的那些；Actions 提前抓好的静态文件 | **没有本地代理**（没有服务器） |
| **桌面版 EXE** | Python + pywebview | 本地 `server/app.py` 代理 + 直连 | —— |
| **安卓版 APK** | WebView + `.so` 型的 Java 代理 | 同上 | —— |

外壳会注入 `window.__TJS_LOCAL__` 告诉前端"有代理"；探针页 / 本地调试没有这个变量时，按 hostname 是不是 `127.0.0.1` / `localhost` / `[::1]` 或 `file:` 自行判定（`web/js/api.js:17-19`）。

**气象局接口是三级取数**（`cmaRaw()`，`web/js/api.js:210`）：

```
① 本地代理  /api/cma/{now|view|hourly}?st=<站点号>&ttl=<秒>
② 直连      https://weather.cma.cn/api/…        ← CORS 开放
③ 静态预抓  data/official/cma/<站点号>.<子接口>.json
```

三级都是必需的：Pages 上没有 ①，而 ② 在部分网络/网关环境下会被 CORS 拦掉，所以还得有 ③ 兜底。**注意 ① 必须用绝对路径 `/api/…`，写成相对路径在 APK 里会解析成 `/web/api/cma/…`，被 Java 拦截器当成静态资源而 404。**

---

## 三、逐个数据源

### 1. 中国气象局 `weather.cma.cn`

| 用途 | 端点 | 说明 |
|---|---|---|
| 实况 | `/api/now/{stationid}` | 温度、气压、湿度、风向风速、体感、预警、节气 |
| 7 日预报 | `/api/weather/view?stationid={id}` | `data.daily[7]`，含白天/夜间天气、风向风力 |
| 逐小时 | `/api/hourly/{stationid}` | 含云量 |
| 城市检索 | `/api/autocomplete?q={关键词}` | 建库时用 |

站点号是国家站号，不是中国天气网的城市 ID：北京 = `54511`，上海 = `58367`，广州 = `59287`。城市库里每座城市都带一个 `cma` 字段存这个号。

**`no`（实况）真实响应结构**（注意字段名是 `feelst`，不是 `feelstemperature`）：

```json
{"msg":"success","code":0,"data":{
  "location":{"id":"54511","name":"北京","path":"中国, 北京, 北京"},
  "now":{"precipitation":0.0,"temperature":19.8,"pressure":1012.0,"humidity":26.0,
         "windDirection":"西南风","windDirectionDegree":220.0,"windSpeed":2.9,
         "windScale":"微风","feelst":17.8},
  "alarm":[],"jieQi":"","lastUpdate":"2026/10/05 18:15"}}
```

> ⚠️ **9999 哨兵值**：站点没有实时观测时，气象局**不返回 `null`**，而是把每个字段填成 `9999`（字符串字段填 `"9999"`），`lastUpdate` 停在最后一次正常上报的时刻。实测澳门 `45011B` 停在 `2025/08/08 10:25`、台北 `58968` 停在 `2025/04/23 21:17`；但上海 `58367`、郑州 `57083`、株洲 `57780`、成都 `S1003` 也在预抓文件里偶发出现过 —— **所以过滤要放在取值处，不能按城市白名单**。不过滤的后果：报价头显示 `9999.0℃`，涨幅算成 `(9999-23.9)/(23.9+273.15) ≈ +3358%`，湿度、风速、体感一起炸，还会在自选按涨幅排序时顶到最上面。（`web/js/api.js:231-244`）

### 2. 中国天气网 `d1.weather.com.cn`

**必须带 `Referer: http://www.weather.com.cn/`，GBK 编码**，所以浏览器直连不行，只在本地代理和 Actions 预抓里用。

| 用途 | 路径 | 解析函数 |
|---|---|---|
| 实况 | `/sk_2d/{code}.html` | `server/app.py:149` |
| 今日预报 + 预警 | `/dingzhi/{code}.html` | `server/app.py:155` |
| 月度逐日历史/预报 | `/calendar_new/{year}/{code}_{ym}.html` | `server/app.py:164` |

`{code}` 是 9 位城市码（北京 `101010100`）。这三个页面都是 `var dataSK = {…};` 这类 JS 赋值，服务端用正则抠出 JSON 再补上 `Referer` 转发。

城市搜索走 `http://toy1.weather.com.cn/search?cityname={名字}`，同样要 `Referer`。

### 3. Open-Meteo 系列（6 个主机）

**K 线引擎的全部原料来自这里。** 免费、免 key，但**额度按主机名分桶** —— `api.open-meteo.com` 被限流（429 `Daily API request limit exceeded`）时 `historical-forecast-api.open-meteo.com` 往往还好，两者参数与返回结构完全一致。所以同一份数据挂两个主机，谁行用谁（`web/js/api.js:49-59`）。

| 主机 | 端点 | 本项目用它拿什么 |
|---|---|---|
| `api.open-meteo.com` | `/v1/forecast` | `minutely_15`：温度 / 阵风 / 降水 / 天气码 / CAPE / 露点 / 湿度 / 云量 / 能见度 / 气压 / 紫外线 |
| `historical-forecast-api.open-meteo.com` | `/v1/forecast` | 同上（备用桶） |
| `archive-api.open-meteo.com` | `/v1/archive` | 更久的历史逐小时 |
| `air-quality-api.open-meteo.com` | `/v1/air-quality` | `hourly=pm2_5`（**只有逐小时，没有 15 分钟**） |
| `previous-runs-api.open-meteo.com` | `/v1/forecast` | 「一天的预报错在哪」—— 见下 |
| `geocoding-api.open-meteo.com` | `/v1/search` | 拼音 / 英文 → 经纬度（建库时用） |

**粒度**（踩过坑，记牢）：

- `minutely_15` 是**最细的免费粒度**，96 点/天。可用变量实测 15 个全非空：`temperature_2m, wind_gusts_10m, precipitation, weather_code, cape, relative_humidity_2m, wind_speed_10m, cloud_cover, visibility, apparent_temperature, dew_point_2m, pressure_msl, surface_pressure, uv_index, shortwave_radiation`。
- **`minutely_1` 和 `minutely` 不存在**。参数照收、HTTP **200**，但 `time` 数组长度是 **0** —— 只看状态码发现不了。
- **空气质量 API 没有 15 分钟产品**（`minutely_15` 返回 0 点）→ 所以游戏里那条"空气"线用的是 **`dew_point_2m` 露点**，PM2.5 只做逐小时的慢变量偏置。
- 历史深度：`historical-forecast-api` 给 **8928 点全非空**（92 天）；`api.open-meteo.com` 同样 8928 点但**只有 6692 非空**。所以补历史优先用前者。

**「预报偏离」的正确写法是变量名后缀，不是 `models` 参数。** 官方文档原文：

> Requesting `temperature_2m_previous_day1` returns the value predicted 24 hours before valid time; `_previous_day2` returns 48 hours before, and so on up to day 7.

所以 `previous-runs-api` 上写 `minutely_15=temperature_2m,temperature_2m_previous_day1`，两份**时间轴逐点相同**，可以直接做差。实测偏差：day1 平均 −0.57 °C、中位 −0.40、p10 −1.90、p90 +0.80。所有 `models=xxx_previous_dayN` 的写法都 **HTTP 400 `Cannot initialize MultiDomains from invalid String value`**。

> 走过的弯路：`previous-runs-api` **不加后缀**时返回的数据与 `historical-forecast-api` **一模一样**（864/864 时刻一字不差），一度以为它只是个别名。

**时区一律 `timezone=auto`**：按坐标取当地时区，返回当地墙钟串，海外城市的日 K 因此按当地零点切。实测全部 352 座城市都还是 UTC+8（乌鲁木齐、喀什给的也是 `Asia/Shanghai`），六台主机都认这个值。⚠ 它把**当前**的 `utc_offset_seconds` 套在整段序列上 —— 夏令时切换日既没有重复也没有缺的小时，代价是另一季的历史偏 1 小时（见 NOTES.md「海外城市按当地时区切日」）。

**一次请求多个坐标**：`latitude=23.13,23.02,…&longitude=113.26,113.12,…` 直接返回**数组**，每个元素带自己的 `minutely_15`。同省"大盘指数"就是靠这个用一个请求拿 8 个城市的。返回的经纬度会被规整到网格（`23.13` → `23.093145`）。

### 4. 中央气象台台风网 `typhoon.nmc.cn/weatherservice`

JSONP，`getJSON` 里已有解包兜底（`txt.replace(/^[^(]*\(|\)[;\s]*$/g, '')`）。**`/weatherservice` 这一段不能省** —— 官方前端 `typhoon-datas-inner.js` 里是写死的，少了它所有 `/typhoon/jsons/*` 都 404。

| 用途 | 路径 | 括号层数 |
|---|---|---|
| 台风列表 | `/typhoon/jsons/list_default`、`/typhoon/jsons/list_{年份}` | **两层** `fname(({…}))` |
| 单条台风路径 | `/typhoon/jsons/view_{id}` | 一层 `fname({…})` |
| 预警信号 | `/fetch_json/warning/json` | 一层，内容是**数组** `fname([[…]])` |

- `list_2026` **按新→旧排序**，`typhoonList` 每条是 8 元数组 `[id, 英文名, 中文名, 年份编号'2629', 编号, 20260001, 命名含义, 'start'|'stop']`。**列表本身不带日期** —— 想知道有没有落在回放窗口里，只能把 `view_` 拉下来看。默认取最近 **30** 个（取 12 个会把 92 天窗口里真正逼近华南的台风全切掉，实测广州半径 900 公里内有货的是沙德尔 211 km / 紫檀 350 km / 美莎克 477 km，都在 7~8 月）。并发限流 4，TTL 6 小时，跨年自动回落到上一年。
- `view_{id}` 的 `typhoon` 是 **10 元数组**，**第 8 项（index 8）是路径点列表**，每个点 `[id, '202601140000', <epoch_ms>, 'TD', 经度, 纬度, 气压, 风速, …]`。
- 预警每条 `r` 的第 6 项是图标相对路径，拼 `https://image.nmc.cn + r[6]`。**每条都带经纬度**，所以"按离当前城市的距离排序"不用额外请求。

### 5. 中央气象台图库 `image.nmc.cn`

图片全部按日期分目录拼路径：`https://image.nmc.cn/product/{Y}/{m}/{d}/{产品}/{尺寸}/{文件名}`

| 产品 | 目录 | 说明 |
|---|---|---|
| 雷达回波 | `RDCP/`（`RDCP/small/` 是小图） | 全国拼图，逐 6~12 分钟 |
| 真彩云图 | `WXBL/medium/` | 默认档 |
| 红外云图 | `WXCL/medium/` | 备用档 |
| 1 小时降水实况 | `STFC/medium/` | 默认档 |
| 未来 24 小时降水预报 | `STFC/medium/` | 备用档 |

雷达的**分城市**页面没有接口，只能拼 slug 猜（`http://www.nmc.cn/publish/radar/{省拼音}/{市拼音}.htm`，Referer 要 `…/radar/chinaall.html`）。映射表由 `tools/radar_slugs.py` **离线探测**生成（45 城命中 30），前端只读结果 `web/data/radar-cities.json`。

### 6. 美国地质调查局（USGS）

```
https://earthquake.usgs.gov/fdsnws/event/1/query
  ?format=geojson&starttime=&endtime=&minmagnitude=3.0&limit=400
  &latitude=&longitude=&maxradiuskm=700
```

免 key、CORS `*`、HTTP 200。`features[].properties.{time(epoch ms), mag, place}`，`geometry.coordinates=[lon, lat, depth]`。按城市半径筛有效：半年内 M4+ / 800 km 内，广州 14 次、成都 91 次、哈尔滨 5 次。

> 为什么不用中国地震台网？`www.ceic.ac.cn` 虽然 HTTP 200 但**不带 CORS 头**，浏览器直连不可用。

### 7. 阿里 DataV 行政区划

`https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json` —— 建库时用它生成 3237 条三级地名（`tools/build_places.py`）。

海外城市目录 `web/data/world-cities.json`（189 座）由 `tools/build_world.py` 生成：中文名手写，坐标 / IANA 时区 / 人口取 Open-Meteo geocoding `/v1/search`，国家中文名取 `/v1/get?id=…&language=zh`（金沙萨会给出旧称「扎伊尔」，脚本里有更正表）。

### 8. 构建 / 运维期用到的

| 用途 | 地址 |
|---|---|
| 省市名单 | `https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/{provinces,cities}.json` |
| ECharts 世界地图 | `https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json` |
| 中国天气网城市索引 | `http://www.weather.com.cn/data/city3jdata/china.html`、`/provshi/101{pp}.html`（GBK） |
| 推送 / 查提交 | `https://api.github.com`（要 PAT） |
| Android SDK 包索引 | `https://dl.google.com/android/repository/repository2-3.xml`、`repository2-1.xml` |

---

## 四、本地代理的路由表

`server/app.py`（441 行）。所有响应统一带 `Access-Control-Allow-Origin: *` 和 `Cache-Control: no-store`。

| 前缀 | 作用 | 白名单 |
|---|---|---|
| `/api/health` | 健康检查 | — |
| `/api/cn/snapshot` | 中国天气网实况（`sk_2d`） | `?code=101010100` |
| `/api/cn/forecast` | 今日预报 + 预警（`dingzhi`） | `?code=` |
| `/api/cn/calendar` | 月度逐日历史/预报（`calendar_new`） | `?code=&ym=YYYYMM` |
| `/api/cn/full` | 上面三个合并，前端一次拿全 | `?code=` |
| `/api/cn/search` | 中国天气网城市搜索（`toy1`） | `?q=杭州` |
| `/api/cma/{now,view,hourly}` | 转发气象局 | 固定三个 |
| `/api/om/…` | 转发 Open-Meteo | `OM_ALLOW = ("/v1/forecast", "/v1/archive", "/v1/air-quality")` |
| `/api/nmc/…` | 转发中央气象台 | 正则 `NMC_RE = r"^(typhoon/jsons/[A-Za-z0-9_]+|fetch_json/[A-Za-z0-9_/]+|jsons/[A-Za-z0-9_]+|diamond\d+/[A-Za-z0-9_/.-]+)$"` |
| 其余 | 静态文件，**限制在 `web/` 目录内** | — |

`/api/om/` 的分流：`archive` → `archive-api`，`air-quality` → `air-quality-api`，其余按 `[api, historical-forecast-api]` 依次重试。

---

## 五、Actions 预抓的静态文件

`tools/prefetch_official.py` 每 30 分钟跑一次（`.github/workflows/deploy.yml`，cron `7,37 * * * *`），把中国天气网和气象局的数据落成静态 JSON 供 Pages 读：

```
web/data/official/meta.json              {updated, count, failed, okCodes, ym, source}
web/data/official/snapshot.json          {updated, count, cities: {code: dataSK}}
web/data/official/fcst/{code}.json       今日预报
web/data/official/cal/{code}_{ym}.json   月度逐日
web/data/official/cma/{id}.{sub}.json    气象局三级取数的兜底
```

> 这些文件**只有内容变了才会重写**，免得 git 里全是噪声。

---

## 六、踩过的坑（按数据源）

**通用**

- **CORS 响应头只在请求带 `Origin` 时才返回。** 第一轮探测没带 `Origin`，把所有源（包括当时已经在用的 `api.open-meteo.com`）都测成没有 CORS，差点得出错误结论。带 `Origin: https://lolikonnn.github.io` 重测后五个源全是 `*`。
- 另外 `dict(r.headers)` 保留服务端原始大小写，取 CORS 要大小写不敏感地遍历。

**中国气象局**

- 字段是 `feelst`，不是 `feelstemperature`。
- 9999 哨兵值（见上）。

**中国天气网**

- 必须带 `Referer`，而且**服务端会校验它必须是 `weather.com.cn` 域**；GBK 编码。
- 预抓脚本和实时代理**共用同一套解析函数**（`sys.path.insert(0, ROOT/server)`），避免两处逻辑漂移。

**Open-Meteo**

- `minutely_1` / `minutely` 参数照收、HTTP 200、`time` 长度 0。
- `past_days=92` 这类超范围参数同样返回一串 `null`，**只看状态码发现不了**。
- 额度按主机名分桶，主站 429 时备用站往往还好。
- 免费额度被打了 804 次那次事故：缓存只在请求**成功返回之后**才写入，只要一次请求没落地（网络慢、或上游超时 20 秒 > 轮询间隔 10 秒），下一个 tick 就再发一次，永远存不上。修法是加 `inflight`（同一个 key 正在飞的请求只留一个）和 `fail`（失败也记一笔短 TTL）。**TTL 必须和调用方的节流周期对齐，否则缓存先过期等于没节流。**

**台风网**

- `/weatherservice` 不能省。
- 列表**按新→旧排序且不带日期**，所以要按"覆盖窗口"而不是"最新 N 条"来取。
- 三种 JSONP 括号层数不一样。

**USGS / 地震**

- 中国大陆的地震在 USGS 目录里本来就是稀客：北京半径 700 km 内 130 天只有 2 条。所以游戏里地震项的覆盖率只有 0.5%，**这是对的，不是 bug** —— 也因此它一响就是大事。

---

## 七、试过但没用上的

| 试过的 | 结果 |
|---|---|
| `http://www.nmc.cn/rest/*`、`http://typhoon.nmc.cn/rest/*` | 各种路径都 404，最后确定用 `/weatherservice/typhoon/jsons/*` |
| `https://weather.cma.cn/api/{typhoon,satellite,radar,life,index,live,aqi,indices}/…` | 路径不存在或响应不对 |
| `http://d1.weather.com.cn/{li,index,aqi,air,weather_index}/…` | 路径不存在 |
| 日本气象厅 `https://www.jma.go.jp/bosai/typhoon/data/targetTc.json` | 能取到，但字段结构与国内口径对不齐，放弃 |
| 中国地震台网 `www.ceic.ac.cn` | HTTP 200 但**无 CORS**，浏览器直连不可用 |
| `nominatim.openstreetmap.org` | 建库时试过，最终用 Open-Meteo geocoding 替代 |

---

*相关文档：[README.md](../README.md)（这是什么、怎么用）、[NOTES.md](NOTES.md)（实现上的坑与取舍）。*
