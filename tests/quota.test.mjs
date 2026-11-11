/* v127 额度监控阶段 1 探测包 · 纯函数与接线回归（零依赖，Node 18+）。
   被测：js/core/quota.js 的候选渠道码派生 / 探测回包整包校验 / 结果行格式化，
   以及 app.js 与 index.html 的接线（独立页 / tab / 入口 / 通用透传 / 版本）。
   测的都是「探测包放行坏数据 / 独立页切过去导航全灭 / 版本号漏同步」这类真会坑人的地方。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUOTA_PROBE_MODE, QUOTA_CODE_MAX, QUOTA_WEBANK_LEN,
  quotaCandidateCodes, validateProbe, probeRows,
} from "../js/core/quota.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const nav = readFileSync(new URL("../../data24/android/app/src/main/python/navservice.py", import.meta.url), "utf8");

/* ---- 候选渠道码派生 ---- */
test("quotaCandidateCodes：短码原样 + 补 0 到 17 位，登记编码不参与补 0", () => {
  const out = quotaCandidateCodes({ prodCode: "FBAE42005P", code: "Z7001425000885" });
  assert.ok(out.includes("FBAE42005P"), "原样短码要在");
  assert.ok(out.includes("FBAE42005P".padEnd(17, "0")), "17 位补 0 候选要在");
  assert.ok(out.includes("Z7001425000885"), "登记编码原样要在");
  assert.ok(!out.some(s => s.startsWith("Z700") && s.length === 17),
    "登记编码不许被补 0 伪装成渠道码");
});

test("quotaCandidateCodes：去重、限量、白名单、空值安全", () => {
  const out = quotaCandidateCodes({
    quotaCode: "FBAE42005P", prodCode: "fbae42005p", regCode: "FBAE42005P", code: "",
  });
  assert.equal(out.filter(s => s === "FBAE42005P").length, 1, "大小写归一后应去重");
  assert.ok(out.length <= QUOTA_CODE_MAX);
  assert.ok(out.every(s => /^[A-Z0-9._-]{1,48}$/.test(s)));
  assert.deepEqual(quotaCandidateCodes(null), []);
  assert.deepEqual(quotaCandidateCodes({ prodCode: "有空格 和<script>" }), []);
});

test("quotaCandidateCodes：quotaCode（人工固化）优先排第一", () => {
  const out = quotaCandidateCodes({ quotaCode: "ZY133074A00000000", prodCode: "FBAE42005P" });
  assert.equal(out[0], "ZY133074A00000000");
});

test("常量：探测 mode / 上限 / 17 位", () => {
  assert.equal(QUOTA_PROBE_MODE, "quota-probe");
  assert.equal(QUOTA_CODE_MAX, 8);
  assert.equal(QUOTA_WEBANK_LEN, 17);
});

/* ---- 探测回包整包校验 ---- */
const goodProbe = () => ({
  ok: true,
  probe: {
    asOf: "2026-11-11T19:00:00", codes: ["FBAE42005P"],
    ms: 812,
    note: "阶段 1 探测",
    sources: [
      { src: "webank", label: "微众匿名货架 · product_codes 数组", http: 200,
        retCode: "21400044", hits: 0, rawHead: '{"ret_code":"21400044"}', ms: 380 },
      { src: "ccb", label: "建行产品页 · 页面可达性", http: 200,
        retCode: "SPA骨架", hits: 0, rawHead: "<html>...", ms: 210 },
    ],
  },
});

test("validateProbe：合法包放行", () => {
  assert.deepEqual(validateProbe(goodProbe()), { ok: true, why: "" });
});

test("validateProbe：坏包整包拒收（根非对象 / ok≠true / 缺 probe）", () => {
  for (const bad of [null, [], "x", { ok: false, error: "超时" }, { ok: true },
                     { ok: true, probe: null }]) {
    assert.equal(validateProbe(bad).ok, false, `应拒收：${JSON.stringify(bad)}`);
  }
});

test("validateProbe：src 不认识 / 条数越界 / 字段类型不对都拒收", () => {
  const badSrc = goodProbe(); badSrc.probe.sources[1].src = "evil";
  assert.equal(validateProbe(badSrc).ok, false, "上游换个域名冒充探测结果要拦住");
  const many = goodProbe(); many.probe.sources = Array.from({ length: 9 }, () => many.probe.sources[0]);
  assert.equal(validateProbe(many).ok, false, "sources > 8 拒收");
  const noCodes = goodProbe(); noCodes.probe.codes = [];
  assert.equal(validateProbe(noCodes).ok, false);
  const badMs = goodProbe(); badMs.probe.sources[0].ms = -1;
  assert.equal(validateProbe(badMs).ok, false);
  const badHits = goodProbe(); badHits.probe.sources[0].hits = "3";
  assert.equal(validateProbe(badHits).ok, false);
  const longHead = goodProbe(); longHead.probe.sources[0].rawHead = "x".repeat(500);
  assert.equal(validateProbe(longHead).ok, false, "rawHead 超长拒收");
});

test("probeRows：命中/未命中口径、ret_code、耗时都进文本；raw 截 200", () => {
  const rows = probeRows(goodProbe());
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /HTTP 200 · ret_code 21400044 · 未命中产品数据 · 380ms/);
  assert.match(rows[1].text, /HTTP 200 · ret_code SPA骨架 · 未命中产品数据 · 210ms/);
  const hit = goodProbe(); hit.probe.sources[0].hits = 3;
  assert.match(probeRows(hit)[0].text, /命中 3 条/);
  assert.equal(rows[0].src, "webank");
  assert.equal(rows[1].src, "ccb");
  assert.deepEqual(probeRows({ ok: false }), []);
});

/* ---- app.js / index.html 接线 ---- */
test("v127 接线：APP_VER 动态格式、import quota.js、go 分派、全局导出", () => {
  /* 具体版本值由 handlers 总测 + check-version.sh 守，这里只验格式，不钉死 */
  assert.match(app, /const APP_VER = "v\d+";/);
  assert.match(app, /from "\.\/js\/core\/quota\.js"/);
  assert.match(app, /if \(pid === "pg-monitor"\) renderMonitor\(\);/);
  assert.match(app, /quotaProbeRun, quotaPickSet,/, "两个内联 onclick 入口要挂到 window");
  assert.ok(!app.slice(app.indexOf("Object.assign(window, {")).includes("renderMonitor,"),
    "renderMonitor 只由 go() 内部调用，不该进 window 导出清单（会被判多余）");
  assert.match(app, /JSON\.stringify\(\{ mode: QUOTA_PROBE_MODE, codes \}\)/,
    "探测必须走通用 NativeNav.fetch 透传");
  assert.match(app, /const chk = validateProbe\(r\);/, "native 回包必须过整包校验");
  assert.match(app, /if \(!nativeFetchAvailable\(\)\) \{ toast\("额度连通性自检只在 App 内可用/,
    "网页端要给 toast，不假装成功");
  assert.match(app, /QUOTA_ST\.phase = "busy"/);
});

test("v127 独立页：pg-monitor 容器 + tabbar 第 5 tab + 首页下方入口", () => {
  assert.match(html, /<div class="page" id="pg-monitor">/, "独立页容器要在");
  assert.match(html, /data-p="pg-monitor" onclick="go\('pg-monitor'\)"/,
    "tabbar 必须有对应 tab，否则 go() 联动高亮会让导航全灭");
  assert.match(html, /onclick="go\('pg-monitor'\)"/);
  assert.match(html, /id="quotaPick"/);
  assert.match(html, /id="quotaResult"/);
  assert.match(html, /id="quotaCodes"/);
  /* 入口是 go() 不是 openSheet()，别做成弹层 */
  const entrySeg = html.slice(html.indexOf("额度实时监控"), html.indexOf("额度实时监控") + 400);
  assert.match(entrySeg, /go\('pg-monitor'\)/);
  assert.ok(!entrySeg.includes("openSheet("));
});

test("v127 版本钉子：APP_VER 与 CACHE 动态同版本 + SHELL 收 quota.js；清单已登记", () => {
  /* v97 纪律：测试里不许再钉硬编码版本号，只做动态比对（总测在 handlers.test.mjs 守） */
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache, "APP_VER 与 CACHE 必须同版本");
  assert.match(sw, /"\.\/js\/core\/quota\.js"/, "import 闭包漏进 SHELL 会整页 404");
  assert.ok(pkg.scripts.test.includes("tests/quota.test.mjs"), "新测试要登记进 npm test 硬编码清单");
});

test("v127 私有仓：mode 分派 + 函数体在 fetch_one 之后 + 零新增桥", () => {
  assert.match(nav, /== "quota-probe"/);
  assert.match(nav, /return _fetch_quota_probe\(req\)/);
  assert.match(nav, /def _fetch_quota_probe\(req\):/);
  assert.match(nav, /from navsources import quota_probe as qp/);
  assert.match(nav, /qp\.validate\(probe\)/, "坏包绝不回页面");
  assert.match(nav, /"ok": True, "probe": probe/);
  /* 新函数体必须在 fetch_one 之后，否则污染 test_android_s2 切段 */
  assert.ok(nav.indexOf("def _fetch_quota_probe(req):") > nav.indexOf("def fetch_one(payload):"));
  const mk = nav.split("def _fetch_market(req):")[1].split("def fetch_one(payload):")[0];
  assert.ok(!mk.includes("_fetch_quota_probe"), "market 切段不许混入探测函数");
  /* 异常只报类型名，不展开 str(e)；不写盘 */
  const seg = nav.split("def _fetch_quota_probe(req):")[1].split("秒讯登录")[0];
  /* urlopen( 是联网不是写盘，用「前面不是字母」边界排除它 */
  assert.ok(!/(?<![A-Za-z])open\(/.test(seg), "手机端只回包，写盘是云端的事");
  assert.ok(!seg.includes("str(e)"), "异常对象可能带 URL/头，绝不展开异常对象回页面");
  assert.match(seg, /type\(e\)\.__name__/);
});
