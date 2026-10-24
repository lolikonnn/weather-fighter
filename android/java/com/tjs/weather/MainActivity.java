package com.tjs.weather;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 天气战士 · 天气行情终端 (Android)
 *
 * 设计要点：
 *  1) 前端整包放在 assets/web 下，通过 https://tjs.local/web/... 由
 *     shouldInterceptRequest 直接吐出来 —— 这样页面有一个真正的 https 源，
 *     fetch/XHR 不会被 file:// 的同源策略打死，而且完全离线可用。
 *  2) 中国天气网 d1.weather.com.cn 强制校验 Referer，WebView 里没法给
 *     fetch 加 Referer，所以由 Java 侧代理：/api/cn/* 走 d1 并补 Referer。
 *  3) 中国气象局 weather.cma.cn 会按 UA 过滤（非浏览器 UA 得 406），
 *     由 /api/cma/* 代理并补桌面 Chrome UA。
 *  4) 所有被拦截的响应都补 Access-Control-Allow-Origin: *，让页面里的
 *     fetch('https://tjs.local/api/...') 能通过 CORS 检查。
 *  5) /api/om/* 与 /api/nmc/* 是给 ?local=1 强制本地取数留的后门 ——
 *     正常情况页面直连上游（上游都带 ACAO: *），只有想统一走 Java 的
 *     UA / 缓存时才需要它们。nmc 用白名单正则挡住任意路径。
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://tjs.local";
    private static final String REFERER = "http://www.weather.com.cn/";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private static final int REQ_LOCATION = 0x10c;

    private WebView web;

    /** 「当前所在地」定位：把 WebView 的 geolocation 请求挂起，等 Android 运行时权限的结果 */
    private GeolocationPermissions.Callback geoCb;
    private String geoOrigin;

    boolean hasLocationPermission() {
        return checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
    }

    /** 放行 WebView 的定位请求；还没授权就先弹 Android 权限对话框，结果回调到 onRequestPermissionsResult */
    void onGeoPrompt(GeolocationPermissions.Callback cb, String origin) {
        if (Build.VERSION.SDK_INT < 23 || hasLocationPermission()) {
            cb.invoke(origin, true, false);
            return;
        }
        geoCb = cb;
        geoOrigin = origin;
        requestPermissions(new String[]{
                android.Manifest.permission.ACCESS_FINE_LOCATION,
                android.Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] granted) {
        if (code != REQ_LOCATION) {
            super.onRequestPermissionsResult(code, perms, granted);
            return;
        }
        boolean ok = false;
        for (int g : granted) if (g == PackageManager.PERMISSION_GRANTED) ok = true;
        if (geoCb != null) {
            // 第三个参数 retain=true 会记住这次授权，之后同源请求不再询问
            geoCb.invoke(geoOrigin, ok, true);
            geoCb = null;
            geoOrigin = null;
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, 0);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0e1015"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 见 InsetPadder 的说明：不这么做的话，Android 15 上顶栏会被状态栏压掉一截。
        root.setOnApplyWindowInsetsListener(new InsetPadder(root));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // WebView 的 geolocation 默认是【关】的：不开这个开关，页面的
        // navigator.geolocation 永远不会触发 onGeolocationPermissionsShowPrompt。
        s.setGeolocationEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 让 WebView 的 UA 与桌面 Chrome 一致，减少被上游按 UA 拦截的概率
        s.setUserAgentString(UA);
        web.setBackgroundColor(Color.parseColor("#0e1015"));
        // 默认的 WebChromeClient 会【静默拒绝】WebView 的定位请求，页面只会拿到
        // PERMISSION_DENIED 且没有任何提示。这里改成：先申请 Android 运行时权限，
        // 用户允许后再放行 WebView 的 geolocation 请求。
        // 注意必须用【具名内部类】而不是匿名类：d8(R8 8.2.2) 在编译 javac --release 8
        // 产出的匿名类 (MainActivity$1.class) 时会抛
        //   NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null
        // 直接让整包构建失败。具名内部类（如 LocalClient）没有这个问题。
        web.setWebChromeClient(new GeoChromeClient(this));
        web.setWebViewClient(new LocalClient(this));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        web.loadUrl(ORIGIN + "/web/index.html");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /* ───────────────────────── 系统栏避让 ───────────────────────── */

    /**
     * 把系统栏占的高度变成根布局的 padding。
     *
     * 为什么需要它：APK 的 targetSdkVersion 是 35，而 **Android 15 起对 targetSdk 35 的应用
     * 强制 edge-to-edge** —— 窗口铺满整屏，状态栏 / 手势条浮在页面之上。此时传统的
     * `FLAG_FULLSCREEN` 已经失效（状态栏不再被隐藏），WebView 就从屏幕最顶端开始布局，
     * 于是页面第一行（品牌栏 + 搜索框）被状态栏压掉一截。用户反馈的
     * 「安卓 app 顶端被吞掉一些内容」就是这个。
     *
     * 为什么不用 CSS 的 `env(safe-area-inset-top)`：`web/index.html` 已经有
     * `viewport-fit=cover`，但 **Android WebView 里这些 env 变量恒为 0**（只有 Chrome 浏览器
     * 自己会填），所以页面侧根本没拿到状态栏高度。`app.css` 里 `.mtabs` 那句
     * `padding-bottom:env(safe-area-inset-bottom,0)` 同理是空转 —— 底部之所以看起来没问题，
     * 是因为页面底部本来就是一片纯色背景，手势条压上去也看不出来。
     *
     * 为什么这么写是安全的：用的是**实际收到的 inset**，不是写死的高度。
     * 不处于 edge-to-edge 时（低版本 Android，或 `FLAG_FULLSCREEN` 生效时状态栏被隐藏）
     * inset 本来就是 0，等于不加 padding，观感与以前完全一致。
     *
     * 必须是 static 嵌套类（d8 的硬性要求，见 LocalClient 上的说明）。
     */
    private static class InsetPadder implements View.OnApplyWindowInsetsListener {
        private final View target;
        private int lastTop = -1;
        private int lastBottom = -1;

        InsetPadder(View v) { target = v; }

        @Override
        public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
            int top, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = in.getInsets(WindowInsets.Type.systemBars());
                android.graphics.Insets ime = in.getInsets(WindowInsets.Type.ime());
                top = bars.top;
                // 键盘弹出时用键盘高度（adjustResize 在 edge-to-edge 下不再改变窗口大小，
                // 只能靠 padding 把输入框顶上来）；不然就退回到导航栏高度。
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                top = in.getSystemWindowInsetTop();
                bottom = in.getSystemWindowInsetBottom();
            }
            if (top != lastTop || bottom != lastBottom) {
                lastTop = top;
                lastBottom = bottom;
                target.setPadding(0, top, 0, bottom);
            }
            // 已经换算成 padding 了，不要再往子 View 传 —— 否则 WebView 有可能自己
            // 再按 safe-area 处理一遍，那就变成双倍留白。
            return WindowInsets.CONSUMED;
        }
    }

    /* ───────────────────────── 请求拦截 ───────────────────────── */

    /**
     * 必须是 static 嵌套类 —— 这不是风格偏好，是 d8 的硬性要求：
     * R8 8.2.2（build-tools 34）在遇到「非 static 嵌套类 + 继承 android.jar 里的类」时会崩，
     * 报 `NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null`。
     * 原因是这类内部类带合成的 this$0 字段，R8 写 dex 时拿不到内部类名 -> NPE。
     * 实测（build/t2）：static 嵌套类 OK；非 static 成员内部类 / 匿名内部类 一律崩。
     * 所以这里显式持有一个 MainActivity 引用，只用它调 route()。
     */
    /**
     * 同上：必须是 static 嵌套类（非 static / 匿名内部类会让 R8 写 dex 时 NPE）。
     * 所以显式持有 MainActivity 引用，权限申请与回调都退回宿主去处理。
     */
    private static class GeoChromeClient extends WebChromeClient {
        private final MainActivity a;

        GeoChromeClient(MainActivity a) { this.a = a; }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                                                       GeolocationPermissions.Callback cb) {
            a.onGeoPrompt(cb, origin);
        }
    }

    private static class LocalClient extends WebViewClient {        private final MainActivity a;

        LocalClient(MainActivity a) { this.a = a; }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            try {
                return a.route(req.getUrl().toString());
            } catch (Exception e) {
                return json(500, "{\"ok\":false,\"error\":\"" + esc(String.valueOf(e)) + "\"}");
            }
        }

        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(WebView v, String url) {
            try {
                return a.route(url);
            } catch (Exception e) {
                return null;
            }
        }
    }

    private WebResourceResponse route(String url) throws IOException {
        if (url == null) return null;
        if (!url.startsWith(ORIGIN)) {
            // 上游域名的 fetch 也可能走到这里（WebView 未必都拦），统一补 CORS
            return null;
        }
        String rest = url.substring(ORIGIN.length());
        String path = rest, query = "";
        int q = rest.indexOf('?');
        if (q >= 0) { path = rest.substring(0, q); query = rest.substring(q + 1); }
        path = URLDecoder.decode(path, "UTF-8");

        Map<String, String> qs = parseQuery(query);

        if (path.startsWith("/web/")) return asset(path.substring(5));

        if (path.equals("/api/health")) {
            return json(200, "{\"ok\":true,\"local\":true,\"platform\":\"android\","
                    + "\"forward\":\"" + REFERER + "\"}");
        }
        if (path.startsWith("/api/cn/")) return cn(path.substring(8), qs);
        if (path.startsWith("/api/cma/")) return cma(path.substring(9), qs);
        if (path.startsWith("/api/om/")) return om(path.substring(8), query);
        if (path.startsWith("/api/nmc/")) return nmc(path.substring(9));
        return json(404, "{\"ok\":false,\"error\":\"not found\"}");
    }

    /* ───────── 静态资源（assets/web） ───────── */

    private WebResourceResponse asset(String rel) throws IOException {
        if (rel.indexOf("..") >= 0) return json(403, "{\"ok\":false}");
        InputStream in;
        try {
            in = getAssets().open("web/" + rel);
        } catch (IOException e) {
            return json(404, "{\"ok\":false,\"error\":\"no asset\"}");
        }
        Map<String, String> h = cors(new HashMap<String, String>());
        h.put("Cache-Control", "no-cache");
        return new WebResourceResponse(mime(rel), "utf-8", 200, "OK", h, in);
    }

    private static String mime(String p) {
        String s = p.toLowerCase(Locale.US);
        if (s.endsWith(".html")) return "text/html";
        if (s.endsWith(".css")) return "text/css";
        if (s.endsWith(".js")) return "application/javascript";
        if (s.endsWith(".json")) return "application/json";
        if (s.endsWith(".png")) return "image/png";
        if (s.endsWith(".svg")) return "image/svg+xml";
        if (s.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /* ───────── 中国天气网 d1（需要 Referer） ───────── */

    private WebResourceResponse cn(String sub, Map<String, String> qs) {
        String code = qs.get("code");
        String up;
        String var;
        if ("snapshot".equals(sub)) {
            if (!isCode(code)) return bad();
            up = "http://d1.weather.com.cn/sk_2d/" + code + ".html";
            var = "dataSK";
        } else if ("forecast".equals(sub)) {
            if (!isCode(code)) return bad();
            up = "http://d1.weather.com.cn/dingzhi/" + code + ".html";
            var = "cityDZ" + code;
        } else if ("calendar".equals(sub)) {
            String ym = qs.get("ym");
            if (!isCode(code) || ym == null || !ym.matches("\\d{6}")) return bad();
            up = "http://d1.weather.com.cn/calendar_new/" + ym.substring(0, 4) + "/"
                    + code + "_" + ym + ".html";
            var = "fc40";
        } else if ("search".equals(sub)) {
            String kw = qs.get("q");
            if (kw == null || kw.length() == 0) return bad();
            String enc;
            try { enc = URLEncoder.encode(kw, "UTF-8"); } catch (Exception e) { enc = kw; }
            up = "http://toy1.weather.com.cn/search?cityname=" + enc;
            var = null;   // 直接返回原文（是 JSON 数组）
        } else {
            return json(404, "{\"ok\":false,\"error\":\"unknown cn sub\"}");
        }
        try {
            String txt = gbk(fetch(up, REFERER, 15000));
            if ("search".equals(sub)) {
                // 上游是 [{"ref":"..."}] 形式，原样回传
                return json(200, txt.trim().isEmpty() ? "[]" : txt.trim());
            }
            String obj = jsObj(txt, var);
            if (obj == null) return json(200, "{\"ok\":false,\"error\":\"parse\"}");
            return json(200, obj);
        } catch (Exception e) {
            return json(502, "{\"ok\":false,\"error\":\"" + esc(e.toString()) + "\"}");
        }
    }

    /* ───────── 中国气象局 weather.cma.cn（需要浏览器 UA） ───────── */

    private WebResourceResponse cma(String sub, Map<String, String> qs) {
        String st = qs.get("st");
        /* 站号里除了字母数字，还可能是 `54517_tj` / `53698-sjz` 这种**带后缀**的
           （天津、石家庄）。这里原来只收 `[0-9A-Za-z_]`，少一个 `-` ——
           于是石家庄 `53698-sjz` 在 APK 上必挂（天津带 `_` 反而没事），
           表现就是那一座城市行情栏拿不到气象局实况。
           跟 server/app.py 的 CMA_ST_RE 保持一致：字母数字加 `_` 和 `-`。
           （`-` 放在字符类末尾，Java 正则里就是字面量，不是区间。） */
        if (st == null || !st.matches("^[0-9A-Za-z_-]{3,12}$")) return bad();
        String up;
        if ("now".equals(sub)) up = "https://weather.cma.cn/api/now/" + st;
        else if ("view".equals(sub)) up = "https://weather.cma.cn/api/weather/view?stationid=" + st;
        else if ("hourly".equals(sub)) up = "https://weather.cma.cn/api/hourly/" + st;
        else if ("climate".equals(sub)) up = "https://weather.cma.cn/api/climate?stationid=" + st;
        else return json(404, "{\"ok\":false,\"error\":\"unknown cma sub\"}");
        try {
            return json(200, utf8(fetch(up, null, 15000)));
        } catch (Exception e) {
            return json(502, "{\"ok\":false,\"error\":\"" + esc(e.toString()) + "\"}");
        }
    }

    /* ───────── Open-Meteo 透传 ───────── */

    private WebResourceResponse om(String rest, String query) {
        // 页面传的是 /api/om/v1/forecast 这种带版本前缀的形式，也兼容去掉 v1 的写法
        if (rest.startsWith("v1/")) rest = rest.substring(3);
        String host;
        if (rest.startsWith("forecast")) host = "https://api.open-meteo.com/v1/forecast";
        else if (rest.startsWith("archive")) host = "https://archive-api.open-meteo.com/v1/archive";
        else if (rest.startsWith("air-quality")) host = "https://air-quality-api.open-meteo.com/v1/air-quality";
        else if (rest.startsWith("geocode")) host = "https://geocoding-api.open-meteo.com/v1/search";
        else return json(404, "{\"ok\":false,\"error\":\"unknown om sub\"}");
        // query 是原样拼进出站 URL 的，必须先限制字符集，挡住 CRLF/`@`/`#` 等
        // 注入手法，避免被用来篡改实际请求的目标或走私请求头（参考 cma() 的站号校验）。
        if (query == null || !query.matches("^[A-Za-z0-9&=._,:%+-]*$")) return bad();
        try {
            return json(200, utf8(fetch(host + "?" + query, null, 20000)));
        } catch (Exception e) {
            return json(502, "{\"ok\":false,\"error\":\"" + esc(e.toString()) + "\"}");
        }
    }

    /* ───────── 中国气象局台风/预警（typhoon.nmc.cn） ───────── */

    /** 只放行已知的几个数据接口，挡住任意路径穿透。
     *  注意 /weatherservice 前缀不能省，否则 /typhoon/jsons/* 全 404。 */
    private static final Pattern NMC_RE = Pattern.compile(
            "^(typhoon/jsons/[A-Za-z0-9_]+"
            + "|fetch_json/[A-Za-z0-9_/]+"
            + "|jsons/[A-Za-z0-9_]+"
            + "|diamond\\d+/[A-Za-z0-9_/.-]+)$");

    private WebResourceResponse nmc(String sub) {
        if (!NMC_RE.matcher(sub).matches()) {
            return json(403, "{\"ok\":false,\"error\":\"blocked\"}");
        }
        try {
            // 上游返回的是 JSONP 包裹（fname({...})），这里原样透传，
            // 剥壳交给 web/js/weather.js 的 parseLoose()。
            byte[] raw = fetch("https://typhoon.nmc.cn/weatherservice/" + sub, null, 20000);
            Map<String, String> h = cors(new HashMap<String, String>());
            h.put("Cache-Control", "no-cache");
            return new WebResourceResponse("application/javascript", "utf-8", 200, "OK", h,
                    new ByteArrayInputStream(raw));
        } catch (Exception e) {
            return json(502, "{\"ok\":false,\"error\":\"" + esc(e.toString()) + "\"}");
        }
    }

    /* ───────── 工具 ───────── */

    private static boolean isCode(String c) {
        return c != null && c.matches("^\\d{9}$");
    }

    private WebResourceResponse bad() {
        return json(400, "{\"ok\":false,\"error\":\"bad code\"}");
    }

    private byte[] fetch(String url, String referer, int timeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept", "*/*");
        if (referer != null) c.setRequestProperty("Referer", referer);
        int code = c.getResponseCode();
        InputStream in = (code >= 400) ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
        }
        c.disconnect();
        return bo.toByteArray();
    }

    private static String gbk(byte[] b) {
        try { return new String(b, Charset.forName("GBK")); }
        catch (Exception e) { return new String(b); }
    }

    private static String utf8(byte[] b) {
        return new String(b, Charset.forName("UTF-8"));
    }

    /** 从 `var name= {...} ;` 或 `([{...}])` 里抠出括号平衡的对象/数组文本 */
    private static String jsObj(String txt, String var) {
        if (txt == null) return null;
        int i;
        if (var != null) {
            String key = "var " + var;
            i = txt.indexOf(key);
            if (i < 0) return null;
            i = txt.indexOf('=', i + key.length());
            if (i < 0) return null;
            i++;
        } else {
            i = 0;
        }
        while (i < txt.length() && Character.isWhitespace(txt.charAt(i))) i++;
        if (i >= txt.length()) return null;
        char open = txt.charAt(i);
        if (open != '{' && open != '[') return null;
        char close = (open == '{') ? '}' : ']';
        int depth = 0;
        boolean inStr = false, esc = false;
        for (int j = i; j < txt.length(); j++) {
            char ch = txt.charAt(j);
            if (inStr) {
                if (esc) esc = false;
                else if (ch == '\\') esc = true;
                else if (ch == '"') inStr = false;
                continue;
            }
            if (ch == '"') { inStr = true; continue; }
            if (ch == open) depth++;
            else if (ch == close) {
                depth--;
                if (depth == 0) return txt.substring(i, j + 1);
            }
        }
        return null;
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> m = new HashMap<String, String>();
        if (q == null || q.length() == 0) return m;
        for (String kv : q.split("&")) {
            if (kv.length() == 0) continue;
            int i = kv.indexOf('=');
            try {
                if (i < 0) m.put(URLDecoder.decode(kv, "UTF-8"), "1");
                else m.put(URLDecoder.decode(kv.substring(0, i), "UTF-8"),
                           URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
            } catch (UnsupportedEncodingException ignored) {
            }
        }
        return m;
    }

    private static Map<String, String> cors(Map<String, String> h) {
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Allow-Headers", "*");
        h.put("Access-Control-Allow-Methods", "GET,OPTIONS");
        return h;
    }

    private static WebResourceResponse json(int status, String body) {
        byte[] raw;
        try { raw = body.getBytes("UTF-8"); } catch (Exception e) { raw = body.getBytes(); }
        String reason = (status == 200) ? "OK" : (status == 404 ? "Not Found" : "Error");
        return new WebResourceResponse("application/json;charset=UTF-8", "utf-8",
                status, reason, cors(new HashMap<String, String>()),
                new ByteArrayInputStream(raw));
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ");
    }
}
