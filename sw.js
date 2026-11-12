/* 个人理财台账 Service Worker
   外壳缓存优先；数据由 GitHub 同步，不走缓存
   注意：改 app.js / index.html 后必须把下面的 CACHE 版本号 +1，
        并与 app.js 里的 APP_VER 保持一致（scripts/check-version.sh 会校验）。 */
const CACHE = "licai-ledger-v128";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.json", "./icon-192.png", "./icon-512.png",
  /* 拆出去的 ES module：漏一个就会「index 新、模块旧」或装完离线打不开
     （check-version.sh 会从 app.js 的 import 逐层走一遍，比对这张表） */
  "./js/core/util.js", "./js/core/orgs.js", "./js/core/paste.js", "./js/core/disc.js",
  /* v105：逐源耗时统计（纯函数；第 0 期「先量后调」用） */
  "./js/core/navstats.js",
  /* v127：额度监控探测包（quota.js 由 app.js 顶层 import，漏了整页 module 解析 404） */
  "./js/core/quota.js",
  /* v97：微众稳健货架静态索引 + 全部判断收口的纯函数模块（同步 import、离线可用） */
  "./js/core/webank.js", "./js/core/webank-shelf.js",
  /* v100：债市晴雨表（私有仓每日官方曲线推导，公开仓只读） */
  "./js/core/market.js",
  /* v116：债市「此刻」层（东财行情 JSONP 直连，与日终层并列、不混算） */
  "./js/core/livebond.js",
  /* v118：宏观层（CPI/PPI/PMI 月度实际值，同为 JSONP 直连，第三个时点） */
  "./js/core/macro.js",
  /* v120：信息面待核线索（私有仓 news.json 云端快照，接口开关在模块内） */
  "./js/core/news.js",
  /* v122/P1：AnySearch 独立检索线索包（news.js 会 import，漏了整页 module 解析 404） */
  "./js/core/anysearch.js",
  /* v121：讯飞 MaaS 联网检索判据（llm.js 会 import，漏了整页 module 解析 404） */
  "./js/core/websearch.js",
  "./js/domain/nav.js", "./js/domain/position.js", "./js/domain/ocr.js",
  "./js/domain/calendar.js", "./js/domain/tomb.js", "./js/domain/sync.js",
  "./js/domain/syncstatus.js", "./js/domain/update.js",
  "./js/domain/board.js",
  "./js/domain/monthly.js", "./js/domain/analysis.js", "./js/domain/advice.js",
  "./js/domain/switchadv.js",
  /* v108：AI 研判（编排层：装配/指纹/解析/卡片，纯函数，有 tests/brief.test.mjs） */
  "./js/domain/brief.js",
  "./js/domain/pubcal.js", "./js/domain/report.js",
  "./js/domain/llm.js"];

self.addEventListener("install", e => {
  /* 预缓存外壳。这里不能用 cache.addAll(SHELL)：
     addAll 走浏览器 HTTP 缓存，而 GitHub Pages 对静态资源设了 max-age，
     会直接复用旧版 app.js 灌进新版本缓存 —— 结果是推送了代码但用户端永远看不到。
     故显式用 cache:"reload" 强制回源，保证每次 install 拿到的都是线上最新文件。 */
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(SHELL.map(u => {
      const req = new Request(u, { cache: "reload" });
      return fetch(req).then(res => { if (res && res.ok) return c.put(req, res); });
    }))).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  /* 只接管同源静态资源；GitHub API 与净值接口一律走网络 */
  if (url.origin !== location.origin) return;
  if (e.request.method !== "GET") return;
  /* 页面导航（HTML）走「网络优先 + 离线回落」：
     GitHub Pages 给 index.html 设了 max-age=600，若走缓存优先，
     用户会被旧外壳卡住最长 10 分钟，刷新也看不到新版本。
     静态资源（app.js 等）仍走缓存优先 —— 它们的版本随 CACHE 名一起换。 */
  const isNav = e.request.mode === "navigate"
    || String(e.request.headers.get("accept") || "").indexOf("text/html") >= 0;
  if (isNav) {
    e.respondWith(
      fetch(new Request(e.request.url, { cache: "reload" }))
        .catch(() => caches.match("./index.html").then(hit => hit || caches.match("./")))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => { });
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});

/* 点系统通知 → 聚焦已打开的窗口，没有就新开一个。
   没有这段的话点通知毫无反应（桌面端）或落到空白页（部分 Android）。
   必须用 clients.matchAll：SW 里没有 window，拿不到 window.focus()。 */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (String(c.url).indexOf(location.origin) === 0 && "focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow("./");
    })
  );
});
