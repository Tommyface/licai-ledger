/* v128 DOM 验收：额度监控（微众匿名货架 + 我的台账产品池）。
   ★ 断网 + 本机 seed，不依赖真机 / 云端 / 上游在线；不含任何真实凭据。
     网页层绝不直连微众（无 CORS），所以这里不 mock 跨域池 fetch；快照由 native
     的 monitor-status 回包带回，网页层用 parseWebank 独立整包校验后展示。
   M 组：
     M1 独立页 + 我的产品池渲染：第 5 tab 高亮、阈值/免打扰回填、默认未启动、切页自动查 status
     M2 关注与配置：全选（台账 prodCode）/ 清空 / 单选、落 localStorage、改阈值与跨午夜免打扰
     M3 启停主干：monitor-start 带 cfg、状态区运行中、运行中改配置静默下发、refresh、monitor-stop
     M4 坏 status 回包：validateMonitorStatus 拒收，不渲染成「运行中」
     M5 网页端降级（无 native）：如实报不可后台常驻、我的产品清单仍在、点开启给 toast、零 native 请求
     M6 坏快照整包拒收：parseWebank 拒收，状态列如实降级、不渲染半包
     M7 v129 阶段 1 探测已下线 + 快照状态/额度展示：图三金额格式、两态语义、自检入口不回归
*/
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.cwd();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png" };
const server = createServer((q, s) => {
  const p = decodeURIComponent(String(q.url || "/").split("?")[0]);
  if (p === "/favicon.ico") { s.writeHead(204); s.end(); return; }
  const f = join(ROOT, p === "/" ? "index.html" : p);
  if (!existsSync(f)) { s.writeHead(404); s.end("nf"); return; }
  s.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  s.end(readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const base = "http://127.0.0.1:" + server.address().port + "/";

const LEDGER_PATH = existsSync("/data/licai/licai-data.json")
  ? "/data/licai/licai-data.json" : "/tmp/data24/licai-data.json";
const LEDGER = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
const CODES = (LEDGER.products || []).map(p => String(p.prodCode || "").trim().toUpperCase()).filter(Boolean);

/* 微众接口3 合法夹具：三只台账产品，含 已售罄有额度 / 在售不限额度 / 未知状态码 */
const WEBANK = {
  ret_code: "21400000", ret_msg: "请求成功",
  ret_data: { list: [
    { product_code: CODES[0] || "PNHY260395A", product_name: "安盈稳健日开7号A",
      sale_status: "13", buy_status_factor: { avail_quota: 600000,
        remain_quota_limit: 1000000, total_quota: 3000000000, purchase_quota_flag: "1" } },
    { product_code: CODES[1] || "YJ01251204A", product_name: "诚享7天持有期29号A",
      sale_status: "12", buy_status_factor: { total_quota: 10000000000,
        remain_quota_limit: 1000000, purchase_quota_flag: "1" } },
    { product_code: CODES[2] || "NYJXLD1409G", product_name: "匠心灵动14天9期G",
      sale_status: "14", buy_status_factor: { avail_quota: 0, purchase_quota_flag: "0" } },
  ] },
};
/* 坏快照：ret_code 非成功 → parseWebank 整包拒收 */
const BAD_WEBANK = { ret_code: "21400055", ret_data: { list: [] } };
/* v127 阶段 1 探测合法回包（折叠区保留能力用） */
const PROBE_REPLY = {
  ok: true,
  probe: {
    asOf: "2026-11-11T19:50:00", ms: 812,
    codes: ["FBAE42005P", "FBAE42005P0000000"], note: "阶段 1 探测",
    sources: [
      { src: "webank", label: "微众匿名货架 · product_codes 数组", http: 200,
        retCode: "21400000", hits: 3, rawHead: '{"ret_code":"21400000"}', ms: 380 },
      { src: "ccb", label: "建行产品页 · 页面可达性", http: 200,
        retCode: "SPA骨架", hits: 0, rawHead: "<html>...", ms: 210 },
    ],
  },
};

let ok = 0, bad = 0;
const A = (c, m) => { if (c) { ok++; console.log("  ok   " + m); } else { bad++; console.log("  FAIL " + m); } };

const b = await chromium.launch();

async function mkPage(opts = {}) {
  const { snapBody = WEBANK, statusMode = "good", probeReply = PROBE_REPLY } = opts;
  const p = await b.newPage({ viewport: { width: 420, height: 1600 } });
  /* ★ 只拦「远端域名」：不能写裸 webank/ccb —— 本地 ES module
     js/core/webank.js / webank-shelf.js 会被一起 abort，app.js import 失败 → 整页不执行。 */
  await p.route(/eastmoney\.com|api\.github\.com|raw\.githubusercontent\.com|yield\.chinabond\.com\.cn|personal\.webank\.com|lsjr\.ccb\.com|quota-monitor\.robotai\.cc\.cd/, r => r.abort());
  await p.addInitScript(({ led, snapBody, statusMode, probeReply }) => {
    window.__navCalls = [];
    window.__monRunning = false;
    window.__statusMode = statusMode;
    window.__probeReply = probeReply;
    window.__snapBody = snapBody;
    /* 模拟 Java 前台服务的 status 回包：running 随启停变、watchCount 从落盘配置读，
       并把最近一次微众原始回包作为 snapshot 字符串带回（网页层 parseWebank 独立校验）。 */
    window.__mockStatus = () => {
      if (window.__statusMode === "bad") {
        return { ok: true, status: { running: "yes", watchCount: 0 } };
      }
      let watchCount = 0;
      try {
        const c = JSON.parse(localStorage.getItem("licai_monitor_cfg_v1") || "{}");
        watchCount = Array.isArray(c.watch) ? c.watch.length : 0;
      } catch (e) { /* 忽略坏 localStorage */ }
      return { ok: true, status: {
        running: !!window.__monRunning, watchCount,
        intervalSec: 15, lastAt: Date.now(), lastOk: true, recent: [],
      }, snapshot: JSON.stringify(window.__snapBody) };
    };
    window.NativeNav = {
      ready: () => true,
      fetch: (id, payload) => {
        window.__navCalls.push(String(payload));
        let req = {};
        try { req = JSON.parse(payload); } catch (e) { /* 忽略 */ }
        const mode = String(req.mode || "");
        if (mode === "quota-probe") {
          setTimeout(() => window.__navDone && window.__navDone(id, window.__probeReply), 0);
        } else if (mode.startsWith("monitor-")) {
          if (mode === "monitor-start") window.__monRunning = true;
          if (mode === "monitor-stop") window.__monRunning = false;
          setTimeout(() => window.__navDone && window.__navDone(id, window.__mockStatus()), 0);
        }
      },
    };
    localStorage.setItem("licai_ledger_v1", JSON.stringify(led));
  }, { led: LEDGER, snapBody, statusMode, probeReply });
  await p.goto(base, { waitUntil: "domcontentloaded" });
  /* app.js 是 380KB 的 ES module + 一堆 import，domcontentloaded 时还没执行完 */
  await p.waitForFunction(() => typeof window.go === "function", null, { timeout: 15000 });
  await p.waitForTimeout(200);
  return p;
}

/* 等我的产品清单渲染完成（含勾选框） */
const waitMon = p => p.waitForFunction(() => {
  const el = document.querySelector("#monPool");
  if (!el) return false;
  return el.querySelectorAll("input[type=checkbox]").length > 0;
}, null, { timeout: 15000 });

/* ---- M1 独立页 + 我的产品池渲染 + 默认值 ---- */
{
  const p = await mkPage();
  const tabCount = await p.evaluate(() => document.querySelectorAll(".tabbar .tb").length);
  A(tabCount === 5, "★ tabbar 仍是 5 个 tab（第 5 个「监控」）");
  await p.evaluate(() => window.go("pg-monitor"));
  await waitMon(p);
  await p.waitForTimeout(200);
  const st = await p.evaluate(() => ({
    on: document.querySelector("#pg-monitor").classList.contains("on"),
    monTab: document.querySelector('.tabbar .tb[data-p="pg-monitor"]').classList.contains("on"),
    others: [...document.querySelectorAll('.tabbar .tb:not([data-p="pg-monitor"])')]
      .filter(x => x.classList.contains("on")).length,
    pool: document.querySelector("#monPool").textContent,
    boxes: document.querySelectorAll("#monPool input[type=checkbox]").length,
    th: document.querySelector("#monThreshold").value,
    quiet: document.querySelector("#monQuiet").value,
    wc: document.querySelector("#monWatchCount").textContent,
    status: document.querySelector("#monStatus").textContent,
    hint: document.querySelector("#monStateHint").textContent,
    log: document.querySelector("#monLog").textContent,
  }));
  A(st.on && st.monTab && st.others === 0, "★ 切到 pg-monitor，只有「监控」tab 高亮");
  A(/我的产品 3 只/.test(st.pool), "★ 我的产品池来自台账（3 只），不是第三方固定池");
  A(st.boxes === 3, "★ 3 只台账产品各有一个关注勾选框");
  A(/已售罄/.test(st.pool) && /在售 · 可购买/.test(st.pool) && /状态 14/.test(st.pool),
    "★ 两态语义与未知状态码原值都如实展示");
  A(/600,000\.00 元/.test(st.pool), "★ 参考额度用图三同款千分位金额（avail_quota）");
  A(/不限额度/.test(st.pool), "★ 缺 avail_quota 显示「不限额度」不显示 0");
  A(st.th === "10000" && st.quiet === "00:00-01:00", "★ 默认阈值 10000 元 / 免打扰 00:00-01:00 回填");
  A(st.wc.trim() === "0 只", "★ 初始关注 0 只");
  A(/未启动/.test(st.status) && /关注 0 只/.test(st.status), "★ 状态区显示未启动（native status 过整包校验）");
  A(st.hint === "未启动", "★ 页头状态 hint 与状态区同步");
  A(/还没有告警/.test(st.log), "★ 最近告警区空态提示");
  const calls = await p.evaluate(() => window.__navCalls);
  A(calls.some(x => /"mode":"monitor-(status|refresh)"/.test(x)),
    "★ 切页自动拉监控状态（v131 首次走 monitor-refresh 带配置）");
  A(!calls.some(x => /webank\.com|no_auth/.test(x)), "★ 网页层没有直连微众（无 CORS，抓数归 Java）");

  /* ---- M2 关注与配置（同一页面续跑，验证状态累积）---- */
  await p.evaluate(() => window.monitorWatchAll());
  await p.waitForTimeout(150);
  const a1 = await p.evaluate(() => ({
    wc: document.querySelector("#monWatchCount").textContent,
    checked: [...document.querySelectorAll("#monPool input[type=checkbox]")].filter(x => x.checked).length,
    cfg: JSON.parse(localStorage.getItem("licai_monitor_cfg_v1") || "{}"),
  }));
  A(a1.wc.trim() === "3 只" && a1.checked === 3, "★ 全选：3 只关注、3 个勾选框全勾上");
  A(Array.isArray(a1.cfg.watch) && a1.cfg.watch.length === 3, "★ 关注列表落 localStorage（重进页面不丢）");
  A(a1.cfg.watch.every(c => /^[A-Z0-9._-]+$/.test(c)), "★ 关注代码是台账 prodCode 归一后的大写码");
  const c2 = await p.evaluate(() => window.__navCalls);
  A(!c2.some(x => /"mode":"monitor-start"/.test(x)), "★ 未启动时改关注不下发启停（不偷偷起服务）");

  await p.evaluate(() => window.monitorWatchNone());
  await p.waitForTimeout(120);
  const a2 = await p.evaluate(() => ({
    wc: document.querySelector("#monWatchCount").textContent,
    checked: [...document.querySelectorAll("#monPool input[type=checkbox]")].filter(x => x.checked).length,
  }));
  A(a2.wc.trim() === "0 只" && a2.checked === 0, "★ 清空：关注归零、勾选框全灭");

  const firstCode = await p.evaluate(() =>
    JSON.parse(localStorage.getItem("licai_ledger_v1")).products[0].prodCode);
  await p.evaluate((c) => window.monitorWatchOne(c), firstCode);
  await p.waitForTimeout(120);
  const a3 = await p.evaluate(() => document.querySelector("#monWatchCount").textContent);
  A(a3.trim() === "1 只", "★ 单选一只：关注数 1（边沿判定的输入）");

  await p.evaluate(() => {
    const th = document.querySelector("#monThreshold");
    th.value = "5000"; th.dispatchEvent(new Event("change", { bubbles: true }));
    const q = document.querySelector("#monQuiet");
    q.value = "23:00-07:00"; q.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(150);
  const cfg = await p.evaluate(() => JSON.parse(localStorage.getItem("licai_monitor_cfg_v1") || "{}"));
  A(cfg.threshold === 5000, "★ 阈值改 5000 落盘（onchange 生效）");
  A(cfg.quietHours === "23:00-07:00", "★ 跨午夜免打扰落盘");
  A(Array.isArray(cfg.watch) && cfg.watch.length === 1, "★ 改配置不误清已勾选的关注");
  await p.close();
}

/* ---- M3 启停主干 ---- */
{
  const p = await mkPage();
  await p.evaluate(() => window.go("pg-monitor"));
  await waitMon(p);
  await p.evaluate(() => window.monitorWatchAll());
  await p.waitForTimeout(100);
  await p.evaluate(() => window.monitorStart());
  await p.waitForTimeout(350);
  const st = await p.evaluate(() => document.querySelector("#monStatus").textContent);
  A(/● 监控运行中/.test(st), "★ 开启后状态区显示「监控运行中」");
  A(/关注 3 只/.test(st), "★ 状态区带关注数（来自服务 status 回包）");
  A(/轮询 15 秒/.test(st), "★ 状态区带交易时段轮询间隔");
  const hint = await p.evaluate(() => document.querySelector("#monStateHint").textContent);
  A(hint === "运行中", "★ 页头 hint 切到运行中");
  const calls = await p.evaluate(() => window.__navCalls);
  const starts = calls.filter(x => /"mode":"monitor-start"/.test(x));
  A(starts.length >= 1, "★ 开启真的发了 mode:monitor-start");
  A(starts[0] && /"cfg"/.test(starts[0]) && /"watch"/.test(starts[0]),
    "★ 开启请求带归一化后的 cfg（关注/阈值/时段）");
  A(starts[0] && /"threshold":10000/.test(starts[0]), "★ cfg 带阈值，服务不用自己猜");
  await p.evaluate(() => {
    const th = document.querySelector("#monThreshold");
    th.value = "8000"; th.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await p.waitForTimeout(200);
  const c2 = await p.evaluate(() => window.__navCalls);
  A(c2.filter(x => /"mode":"monitor-start"/.test(x)).length >= 2,
    "★ 运行中改配置静默下发一次（不重启服务）");
  await p.evaluate(() => window.monitorRefresh());
  await p.waitForTimeout(300);
  const c3 = await p.evaluate(() => window.__navCalls);
  A(c3.some(x => /"mode":"monitor-refresh"/.test(x)),
    "★ 刷新按钮发 monitor-refresh（v131：带配置现场抓一轮，含银行披露轨）");
  await p.evaluate(() => window.monitorStop());
  await p.waitForTimeout(300);
  const st2 = await p.evaluate(() => document.querySelector("#monStatus").textContent);
  A(/○ 未启动/.test(st2), "★ 停止后状态回到「未启动」");
  const c4 = await p.evaluate(() => window.__navCalls);
  A(c4.some(x => /"mode":"monitor-stop"/.test(x)), "★ 停止真的发了 mode:monitor-stop");
  await p.close();
}

/* ---- M4 坏 status 回包 ---- */
{
  const p = await mkPage({ statusMode: "bad" });
  await p.evaluate(() => window.go("pg-monitor"));
  await waitMon(p);
  await p.waitForTimeout(200);
  const st = await p.evaluate(() => document.querySelector("#monStatus").textContent);
  A(/running 非布尔/.test(st), "★ 坏 status 回包被 validateMonitorStatus 拒收并带真实原因");
  A(!/● 监控运行中/.test(st), "★ 坏包不渲染成「运行中」（不假装成功）");
  A(/网页版可查看我的产品清单/.test(st), "★ 状态区给出降级说明");
  const pool = await p.evaluate(() => document.querySelector("#monPool").textContent);
  A(/我的产品 3 只/.test(pool), "★ status 坏不影响我的产品清单展示（两条链路各自校验）");
  await p.close();
}

/* ---- M5 网页端降级（无 native）---- */
{
  const p = await mkPage();
  await p.evaluate(() => {
    try { delete window.NativeNav; } catch (e) { window.NativeNav = undefined; }
    window.__navCalls = [];
  });
  await p.evaluate(() => window.go("pg-monitor"));
  await waitMon(p);
  await p.waitForTimeout(200);
  const st = await p.evaluate(() => document.querySelector("#monStatus").textContent);
  A(/网页版没有后台服务，实时监控与通知只在 App 内可用/.test(st), "★ 无 native 时如实报不可后台常驻");
  const pool = await p.evaluate(() => document.querySelector("#monPool").textContent);
  A(/我的产品 3 只/.test(pool), "★ 网页版仍能看到我的产品清单并勾选");
  A(/App 内可查/.test(pool), "★ 无快照时状态列如实标「App 内可查」，不编造额度");
  await p.evaluate(() => window.monitorWatchAll());
  await p.waitForTimeout(100);
  await p.evaluate(() => window.monitorStart());
  await p.waitForTimeout(350);
  const toast = await p.evaluate(() => document.querySelector("#toast").textContent);
  A(/网页版没有后台服务|只在 App 内可用/.test(toast), "★ 网页端点开启给 toast，不假装成功");
  const st2 = await p.evaluate(() => document.querySelector("#monStatus").textContent);
  A(!/● 监控运行中/.test(st2), "★ 网页端不显示「运行中」");
  const calls = await p.evaluate(() => window.__navCalls || []);
  A(calls.length === 0, "★ 网页端没有发任何 native 请求");
  await p.close();
}

/* ---- M6 坏快照整包拒收 ---- */
{
  const p = await mkPage({ snapBody: BAD_WEBANK });
  await p.evaluate(() => window.go("pg-monitor"));
  await waitMon(p);
  await p.waitForTimeout(200);
  const pool = await p.evaluate(() => document.querySelector("#monPool").textContent);
  A(/快照校验未过/.test(pool), "★ 坏快照 parseWebank 整包拒收，如实报未过");
  A(/ret_code 非成功/.test(pool), "★ 报错带真实原因（ret_code 非成功 21400055）");
  A(/App 内可查/.test(pool), "★ 坏快照下状态列降级，不渲染半包额度");
  A(!/600,000\.00/.test(pool), "★ 坏快照绝不漏出上一份夹具的额度数字");
  const boxes = await p.evaluate(() => document.querySelectorAll("#monPool input[type=checkbox]").length);
  A(boxes === 3, "★ 坏快照不影响台账产品清单（仍可勾选配置）");
  await p.close();
}

/* ---- M7 v129：阶段 1 探测区已下线（不回归）----
   旧自检探的是 POST + 裸数组，恒返 21400044，与正式接口 3 的
   GET ?param=<JSON> / 21400000 不是一回事，留在正式页只会误导。
   出口可达性改由①服务状态行的「上次回包成功」反映。 */
{
  const p = await mkPage();
  await p.evaluate(() => window.go("pg-monitor"));
  await waitMon(p);
  const has = await p.evaluate(() => ({
    details: !!document.querySelector("#pg-monitor details"),
    pick: !!document.querySelector("#quotaPick"),
    codes: !!document.querySelector("#quotaCodes"),
    result: !!document.querySelector("#quotaResult"),
    txt: document.querySelector("#pg-monitor").textContent,
    probeFn: typeof window.quotaProbeRun,
  }));
  A(!has.details && !has.pick && !has.codes && !has.result,
    "★ 阶段 1 探测折叠区已移除（v129）");
  A(has.probeFn === "undefined", "★ 网页层不再暴露 quotaProbeRun 入口");
  A(/不是端点判死/.test(has.txt), "★ 21400044 是方法用错的结论改挂到服务卡片说明");
  A(/上次回包成功/.test(has.txt), "★ 手机出口可达性改由服务状态说明反映");
  await p.close();
}

await b.close();
server.close();
console.log("\n结果: %d ok / %d FAIL", ok, bad);
process.exit(bad ? 1 : 0);
