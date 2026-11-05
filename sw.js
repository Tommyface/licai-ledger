/* 个人理财台账 Service Worker
   外壳缓存优先；数据由 GitHub 同步，不走缓存
   注意：改 app.js / index.html 后必须把下面的 CACHE 版本号 +1，
        并与 app.js 里的 APP_VER 保持一致（scripts/check-version.sh 会校验）。 */
const CACHE = "licai-ledger-v83";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.json", "./icon-192.png", "./icon-512.png",
  /* 拆出去的 ES module：漏一个就会「index 新、模块旧」或装完离线打不开
     （check-version.sh 会从 app.js 的 import 逐层走一遍，比对这张表） */
  "./js/core/util.js", "./js/core/orgs.js", "./js/core/paste.js", "./js/core/disc.js",
  "./js/domain/nav.js", "./js/domain/position.js", "./js/domain/ocr.js",
  "./js/domain/calendar.js", "./js/domain/tomb.js", "./js/domain/sync.js",
  "./js/domain/syncstatus.js", "./js/domain/update.js",
  "./js/domain/board.js",
  "./js/domain/monthly.js", "./js/domain/analysis.js", "./js/domain/advice.js",
  "./js/domain/switchadv.js",
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
