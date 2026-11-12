/* 额度监控 · 纯函数与接线回归（零依赖，Node 18+）。
   v127 阶段 1：候选渠道码派生 / 探测回包整包校验 / 结果行格式化 / 独立页接线。
   v128 正式监控：微众匿名货架 URL 构造 / 回包整包校验 / 状态码映射 / 我的产品池
   展示行 / 图三通知文案 / 双轨边沿判定（状态跃迁 + 额度跨阈值）/ 免打扰 /
   轮询间隔 / 额度格式化，以及正式监控页的接线与职责边界。
   测的都是「坏包放行 / 首次把历史全推一遍 / 免打扰结束后重复推 / 拿恒定限额
   当实时额度 / 网页层用 setInterval 或直连微众做假监控 / 版本号漏同步」这些坑。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUOTA_PROBE_MODE, QUOTA_CODE_MAX, QUOTA_WEBANK_LEN,
  quotaCandidateCodes, validateProbe, probeRows,
  WEBANK_QUOTA_URL, WEBANK_OK_CODE, SALE_ON, SALE_OFF, WEBANK_CODE_MAX,
  MONITOR_TRADE_SEC, MONITOR_IDLE_SEC, MONITOR_WATCH_MAX,
  MONITOR_MIN_THRESHOLD, MONITOR_DEF_THRESHOLD, MONITOR_CFG_KEY,
  normMonitorCfg, inQuiet, inTrade, pollIntervalSec, fmtQuota, fmtYuan,
  buildWebankUrl, parseWebank, saleText, webankRows, notifyBody,
  webankAlerts, validateMonitorStatus,
} from "../js/core/quota.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
/* ★ 只测本仓文件：公开仓 CI 只 checkout licai-ledger，没有私有仓 data24/。
   私有仓 MonitorCtl / MonitorService 接线由那边 test_android_s2.py 守。 */

/* ---- v127 阶段 1：候选渠道码派生 ---- */
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

/* ---- v127 阶段 1：探测回包整包校验 ---- */
const goodProbe = () => ({
  ok: true,
  probe: {
    asOf: "2026-11-11T19:00:00", codes: ["FBAE42005P"], ms: 812, note: "阶段 1 探测",
    sources: [
      { src: "webank", label: "微众匿名货架 · product_codes 数组", http: 200,
        retCode: "21400000", hits: 3, rawHead: '{"ret_code":"21400000"}', ms: 380 },
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
  assert.match(rows[0].text, /HTTP 200 · ret_code 21400000 · 命中 3 条 · 380ms/);
  assert.match(rows[1].text, /HTTP 200 · ret_code SPA骨架 · 未命中产品数据 · 210ms/);
  assert.equal(rows[0].src, "webank");
  assert.equal(rows[1].src, "ccb");
  assert.deepEqual(probeRows({ ok: false }), []);
});

/* ---- v127 / v128 接线与版本钉子 ---- */
test("接线：APP_VER 动态格式、import quota.js、go 分派、全局导出（v129 自检已下线）", () => {
  assert.match(app, /const APP_VER = "v\d+";/);
  assert.match(app, /from "\.\/js\/core\/quota\.js"/);
  assert.match(app, /if \(pid === "pg-monitor"\) renderMonitor\(\);/);
  assert.ok(!app.slice(app.indexOf("Object.assign(window, {")).includes("renderMonitor,"),
    "renderMonitor 只由 go() 内部调用，不该进 window 导出清单（会被判多余）");
  assert.match(app, /tradeFullRedeem,/, "「全部赎回」内联入口要挂到 window");
  assert.ok(!/QUOTA_PROBE_MODE|quotaProbeRun|quotaPickSet|const QUOTA_ST/.test(app),
    "阶段 1 自检入口（POST 裸数组探测）已从网页层移除");
});

test("独立页：pg-monitor 容器 + tabbar 第 5 tab + 首页入口已移除（v130）", () => {
  assert.match(html, /<div class="page" id="pg-monitor">/, "独立页容器要在");
  assert.match(html, /data-p="pg-monitor" onclick="go\('pg-monitor'\)"/,
    "tabbar 必须有对应 tab，否则 go() 联动高亮会让导航全灭");
  assert.match(html, /onclick="go\('pg-monitor'\)"/);
  assert.ok(!/id="quotaPick"|id="quotaResult"|id="quotaCodes"|quotaProbeRun\(\)/.test(html),
    "阶段 1 自检挂点与入口已移除");
  /* v130：首页不再放「额度实时监控」入口（用户反馈首页臃肿；底部第 5 tab 是常驻入口）。
     首页段里既不许有入口卡片，pg-monitor 的独立页标题行照旧存在。 */
  const home = html.slice(html.indexOf('id="pg-home"'), html.indexOf('id="pg-trade"'));
  assert.ok(!home.includes('go(\'pg-monitor\')') && !home.includes("额度实时监控"),
    "首页还留着监控入口（v130 应移除，走底部 tab）");
  assert.match(html, /<h2>额度实时监控<\/h2>/, "独立页自身的标题行不能丢");
});

test("版本钉子：APP_VER 与 CACHE 动态同版本 + SHELL 收 quota.js；清单已登记", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache, "APP_VER 与 CACHE 必须同版本");
  assert.match(sw, /"\.\/js\/core\/quota\.js"/, "import 闭包漏进 SHELL 会整页 404");
  assert.ok(pkg.scripts.test.includes("tests/quota.test.mjs"), "新测试要登记进 npm test 硬编码清单");
});

test("v129：阶段 1 探测透传已从网页层下线（quota.js 纯函数仍由单测覆盖）", () => {
  assert.ok(!/mode: QUOTA_PROBE_MODE|JSON\.stringify\(\{ mode: QUOTA_PROBE_MODE/.test(app),
    "网页层不再发 POST 裸数组探测请求");
  assert.ok(!/探测完成 ·|开始连通性自检/.test(app), "探测结果区文案已移除");
  /* 正式监控仍走通用桥，零新增桥出口 */
  assert.match(app, /window\.NativeNav\.fetch\(id, JSON\.stringify\(cfg \? \{ mode, cfg \} : \{ mode \}\)\)/);
  assert.match(app, /上次回包成功（ret_code 21400000/, "出口可达性改由服务状态行反映");
});

/* ============================================================
   v128 正式监控：微众匿名货架 + 我的产品池（纯函数 + 接线）
   ============================================================ */

test("v128 常量：微众接口 URL / 成功码 / 两态状态码 / 轮询 / 阈值 / 配置键", () => {
  assert.equal(WEBANK_QUOTA_URL,
    "https://personal.webank.com/wm-htrserver/finance/product_shelf/query_product_by_codes_no_auth");
  assert.equal(WEBANK_OK_CODE, "21400000");
  assert.equal(SALE_ON, "12", "图二「立即购买」实证：12=在售可购买");
  assert.equal(SALE_OFF, "13", "图一「已售罄」实证：13=已售罄");
  assert.equal(WEBANK_CODE_MAX, 100);
  assert.equal(MONITOR_TRADE_SEC, 15);
  assert.equal(MONITOR_IDLE_SEC, 300);
  assert.equal(MONITOR_WATCH_MAX, 100);
  assert.equal(MONITOR_MIN_THRESHOLD, 1000);
  assert.equal(MONITOR_DEF_THRESHOLD, 10000);
  assert.equal(MONITOR_CFG_KEY, "licai_monitor_cfg_v1");
});

test("normMonitorCfg：watch 去重/限量/白名单，阈值下限，时段格式兜底", () => {
  const c = normMonitorCfg({
    watch: ["fbae1", "FBAE1", "  ", "有空格", "A".repeat(49)],
    threshold: 999, quietHours: "25:99-xx:yy", tradeFrom: "bad", tradeTo: "",
  });
  assert.deepEqual(c.watch, ["FBAE1"], "大小写归一去重、空值/非法字符/超长全部剔除");
  assert.equal(c.threshold, MONITOR_DEF_THRESHOLD, "阈值低于下限一律回落默认");
  assert.equal(c.quietHours, "00:00-01:00");
  assert.equal(c.tradeFrom, "09:00");
  assert.equal(c.tradeTo, "17:00");
  const ok = normMonitorCfg({ watch: ["A", "B", "A"], threshold: 5000,
    quietHours: "23:00-07:00", tradeFrom: "08:30", tradeTo: "18:00" });
  assert.deepEqual(ok.watch, ["A", "B"]);
  assert.equal(ok.threshold, 5000);
  assert.equal(ok.quietHours, "23:00-07:00");
  assert.equal(ok.tradeFrom, "08:30");
  assert.equal(ok.tradeTo, "18:00");
  assert.deepEqual(normMonitorCfg(null).watch, []);
  assert.equal(normMonitorCfg("x").threshold, MONITOR_DEF_THRESHOLD);
  assert.equal(normMonitorCfg({ watch: Array.from({ length: 150 }, (_, i) => "C" + i) }).watch.length,
    MONITOR_WATCH_MAX, "关注不许超过上限 100");
});

test("inQuiet：同日区间 / 跨午夜 / 右开边界 / 非法输入都不误判", () => {
  assert.equal(inQuiet("00:30", "00:00-01:00"), true);
  assert.equal(inQuiet("01:00", "00:00-01:00"), false, "右端开区间");
  assert.equal(inQuiet("23:30", "23:00-07:00"), true, "跨午夜：午夜后");
  assert.equal(inQuiet("03:00", "23:00-07:00"), true, "跨午夜：凌晨");
  assert.equal(inQuiet("12:00", "23:00-07:00"), false, "跨午夜：白天不压制");
  assert.equal(inQuiet("bad", "00:00-01:00"), false);
  assert.equal(inQuiet("12:00", "bad"), false);
});

test("inTrade / pollIntervalSec：交易时段 15 秒、其余 300 秒", () => {
  const cfg = { tradeFrom: "09:00", tradeTo: "17:00" };
  assert.equal(inTrade("09:00", cfg), true);
  assert.equal(inTrade("16:59", cfg), true);
  assert.equal(inTrade("17:00", cfg), false, "右端开区间");
  assert.equal(inTrade("08:59", cfg), false);
  assert.equal(inTrade("bad", cfg), false);
  assert.equal(pollIntervalSec("10:00", cfg), MONITOR_TRADE_SEC);
  assert.equal(pollIntervalSec("22:00", cfg), MONITOR_IDLE_SEC);
});

test("fmtQuota：元 / 万元 / 亿元分档与非法值兜底", () => {
  assert.equal(fmtQuota(0), "0元");
  assert.equal(fmtQuota(100), "100元");
  assert.equal(fmtQuota(3000), "3000元");
  assert.equal(fmtQuota(120000), "12.00万元");
  assert.equal(fmtQuota(2.5e8), "2.50亿元");
  assert.equal(fmtQuota("x"), "—");
  assert.equal(fmtQuota(undefined), "—");
  assert.equal(fmtQuota(Infinity), "—");
});

test("fmtYuan：图三通知同款千分位两位小数（1,100,000.00）", () => {
  assert.equal(fmtYuan(1100000), "1,100,000.00", "图三「参考额度 1,100,000.00 元」");
  assert.equal(fmtYuan(600000), "600,000.00");
  assert.equal(fmtYuan(0), "0.00");
  assert.equal(fmtYuan(1234.5), "1,234.50");
  assert.equal(fmtYuan(12.345), "12.35", "四舍五入到分");
  assert.equal(fmtYuan(-2500), "-2,500.00");
  assert.equal(fmtYuan("x"), "—");
  assert.equal(fmtYuan(NaN), "—");
});

test("buildWebankUrl：GET ?param=<URL 编码 JSON>、去重限量、代码归一", () => {
  const u = buildWebankUrl(["pnhy260395a", "PNHY260395A", "YJ01251204A"]);
  assert.ok(u.startsWith(WEBANK_QUOTA_URL + "?param="));
  const param = JSON.parse(decodeURIComponent(u.split("?param=")[1]));
  assert.deepEqual(param.product_codes, ["PNHY260395A", "YJ01251204A"], "去重 + 大写归一");
  const many = buildWebankUrl(Array.from({ length: 150 }, (_, i) => "C" + i));
  assert.equal(JSON.parse(decodeURIComponent(many.split("?param=")[1])).product_codes.length,
    WEBANK_CODE_MAX, "代码数不超过上限");
  assert.deepEqual(JSON.parse(decodeURIComponent(buildWebankUrl([]).split("?param=")[1])).product_codes, []);
  assert.deepEqual(JSON.parse(decodeURIComponent(buildWebankUrl(null).split("?param=")[1])).product_codes, []);
  /* 非法字符不许拼进 URL */
  assert.ok(!buildWebankUrl(["有空格 <script>"]).includes("script"));
});

/* 微众接口3 回包夹具：三种形态 —— 有额度已售罄 / 不限额度在售 / 有额度在售 */
const goodWebank = () => ({
  ret_code: "21400000", ret_msg: "请求成功",
  ret_data: { list: [
    { product_code: "pnhy260395a", product_name: "安盈稳健日开7号A", sale_status: "13",
      buy_status_factor: { avail_quota: 600000, remain_quota_limit: 1000000,
        total_quota: 3000000000, purchase_quota_flag: "1" } },
    { product_code: "YJ01251204A", product_name: "诚享7天持有期29号A", sale_status: "12",
      buy_status_factor: { total_quota: 10000000000, remain_quota_limit: 1000000,
        purchase_quota_flag: "1" } },
    { product_code: "NYJXLD1409G", product_name: "匠心灵动14天9期G", sale_status: "14",
      buy_status_factor: { avail_quota: 0, purchase_quota_flag: "0" } },
  ] },
});

test("parseWebank：合法包放行，code 归一、状态码原值、avail_quota 缺失=不限额度", () => {
  const r = parseWebank(goodWebank());
  assert.equal(r.ok, true);
  assert.equal(r.retCode, "21400000");
  assert.equal(r.products.length, 3);
  assert.equal(r.products[0].code, "PNHY260395A", "code 统一大写");
  assert.equal(r.products[0].saleStatus, "13");
  assert.equal(r.products[0].availQuota, 600000, "参考额度取 avail_quota（动态），不是恒定的 remain_quota_limit");
  assert.equal(r.products[0].quotaFlag, "1");
  assert.equal(r.products[1].availQuota, null, "缺 avail_quota = 不限额度，记 null 不当 0");
  assert.equal(r.products[2].saleStatus, "14", "未知状态码原值保留，不臆造语义");
  assert.equal(r.products[2].availQuota, 0);
  /* JSON 字符串输入也放行 */
  assert.equal(parseWebank(JSON.stringify(goodWebank())).ok, true);
});

test("parseWebank：坏包整包拒收（非对象 / ret_code 非成功 / 缺 list / code 非法 / quota 非法）", () => {
  for (const bad of [null, [], "x", "{bad", {}, { ret_code: "21400055" },
                     { ret_code: "21400000" }, { ret_code: "21400000", ret_data: {} },
                     { ret_code: "21400000", ret_data: { list: {} } },
                     { ret_code: "21400000", ret_data: { list: [null] } }]) {
    const r = parseWebank(bad);
    assert.equal(r.ok, false, `应拒收：${JSON.stringify(bad)}`);
    assert.deepEqual(r.products, [], "拒收时不许留半包数据");
  }
  const q = (list) => parseWebank({ ret_code: "21400000", ret_data: { list } });
  assert.equal(q(Array.from({ length: 160 }, () => ({ product_code: "A" }))).ok, false, "list 超限拒收");
  assert.equal(q([{ product_code: "有空格" }]).ok, false);
  assert.equal(q([{ product_code: "" }]).ok, false);
  assert.equal(q([{ product_code: "A", buy_status_factor: { avail_quota: -1 } }]).ok, false);
  assert.equal(q([{ product_code: "A", buy_status_factor: { avail_quota: "x" } }]).ok, false);
});

test("saleText：只映射 12/13 两张截图实证码，其余保留原值", () => {
  assert.equal(saleText("12"), "在售 · 可购买");
  assert.equal(saleText("13"), "已售罄");
  assert.equal(saleText("14"), "状态 14", "无字典表的码标原值，不臆造");
  assert.equal(saleText("02"), "状态 02");
  assert.equal(saleText(""), "状态未知");
});

test("webankRows：我的台账产品为主，叠加快照状态；缺码产品不可勾选", () => {
  const ledger = [
    { prodCode: "PNHY260395A", name: "安盈稳健日开7号A" },
    { prodCode: "YJ01251204A", name: "诚享7天29号" },
    { prodCode: "", name: "手工录入无代码" },
  ];
  const snap = parseWebank(goodWebank());
  const rows = webankRows(ledger, snap, ["PNHY260395A"]);
  assert.equal(rows.length, 3, "以台账产品为主，不因快照少一只就少一行");
  assert.equal(rows[0].watched, true);
  assert.equal(rows[0].hit, true);
  assert.equal(rows[0].statusText, "已售罄");
  assert.equal(rows[0].quotaText, "600,000.00 元", "图三同款金额格式");
  assert.equal(rows[1].watched, false);
  assert.equal(rows[1].statusText, "在售 · 可购买");
  assert.equal(rows[1].quotaText, "不限额度", "缺 avail_quota 显示不限额度，不显示 0");
  assert.equal(rows[2].hasCode, false, "无 prodCode 标不可监控");
  assert.equal(rows[2].statusText, "App 内可查");
  assert.equal(rows[2].quotaText, "—");
  /* 无快照（网页版/未抓取）：清单仍在，状态如实降级 */
  const noSnap = webankRows(ledger, null, []);
  assert.equal(noSnap.length, 3);
  assert.equal(noSnap[0].statusText, "App 内可查");
  assert.equal(noSnap[0].quotaText, "—");
  assert.deepEqual(webankRows(null, snap, []), []);
});

test("notifyBody：复刻图三通知文案（标题外正文四行 + 免责）", () => {
  const b = notifyBody("安盈稳健日开7号A", "PNHY260395A", "额度", 1100000,
    "2026-11-11T11:20:03+08:00");
  assert.ok(b.includes("安盈稳健日开7号A（PNHY260395A）"));
  assert.ok(b.includes("有参考额度；参考额度 1,100,000.00 元"));
  assert.ok(b.includes("检查时间：2026-11-11T11:20:03+08:00"));
  assert.ok(b.includes("匿名货架参考值，不代表个人可购买；请在微众 App核对。"));
  const k = notifyBody("诚享7天29号", "YJ01251204A", "开售", null, "2026-11-12T09:00:00+08:00");
  assert.ok(k.includes("已开售；参考额度 不限额度"));
});

test("webankAlerts：首次只记基线，绝不把历史全推一遍", () => {
  const snap = parseWebank(goodWebank());
  const r = webankAlerts(snap, { watch: ["PNHY260395A", "YJ01251204A"], threshold: 10000 },
    {}, "12:00", "2026-11-12T12:00:00+08:00");
  assert.equal(r.alerts.length, 0, "prev 为空是首轮，只记基线不推历史");
  assert.equal(r.state.PNHY260395A.saleStatus, "13", "基线要记住各关注产品的状态与额度");
  assert.equal(r.state.PNHY260395A.availQuota, 600000);
  assert.equal(r.state.YJ01251204A.availQuota, null);
});

test("webankAlerts：A 轨开售跃迁 + B 轨额度跨阈值边沿 + 同 code 去重 + 不重复推", () => {
  const snap = parseWebank(goodWebank());
  const cfg = { watch: ["PNHY260395A", "YJ01251204A", "NYJXLD1409G"], threshold: 10000 };
  /* 上一轮：A 售罄无额度、B 在售不限额度、G 状态14 额度0 */
  const prev = {
    PNHY260395A: { saleStatus: "13", availQuota: 0 },
    YJ01251204A: { saleStatus: "12", availQuota: null },
    NYJXLD1409G: { saleStatus: "13", availQuota: 0 },
  };
  /* 本轮：A 售罄但回补 60万（B 轨）、G 跃迁到 12（A 轨）、B 不变 */
  const cur = parseWebank({
    ret_code: "21400000", ret_data: { list: [
      { product_code: "PNHY260395A", product_name: "安盈稳健日开7号A", sale_status: "13",
        buy_status_factor: { avail_quota: 600000 } },
      { product_code: "YJ01251204A", product_name: "诚享7天29号", sale_status: "12",
        buy_status_factor: {} },
      { product_code: "NYJXLD1409G", product_name: "匠心灵动14天9期G", sale_status: "12",
        buy_status_factor: { avail_quota: 0 } },
    ] },
  });
  const r = webankAlerts(cur, cfg, prev, "12:00", "2026-11-12T12:00:00+08:00");
  assert.equal(r.alerts.length, 2, "A 轨 1 条 + B 轨 1 条 = 2 条");
  const kinds = r.alerts.map(x => x.kind).sort();
  assert.deepEqual(kinds, ["开售", "额度"]);
  const quotaAlert = r.alerts.find(x => x.kind === "额度");
  assert.equal(quotaAlert.code, "PNHY260395A");
  assert.ok(quotaAlert.body.includes("1,100,000.00") === false, "body 用本轮真实额度 600000，不写死图三历史值");
  assert.ok(quotaAlert.body.includes("600,000.00 元"));
  const openAlert = r.alerts.find(x => x.kind === "开售");
  assert.equal(openAlert.code, "NYJXLD1409G");
  assert.ok(openAlert.text.includes("13→12"));
  /* 同一份状态再判一次：状态已消费，不该再推 */
  const r2 = webankAlerts(cur, cfg, r.state, "12:00", "2026-11-12T12:00:15+08:00");
  assert.equal(r2.alerts.length, 0, "边沿触发不许每轮重复推");
});

test("webankAlerts：免打扰只压制推送，state 照常推进（含跨午夜）", () => {
  const snap = parseWebank(goodWebank());
  const prev = { PNHY260395A: { saleStatus: "13", availQuota: 0 } };
  const cur = parseWebank({ ret_code: "21400000", ret_data: { list: [
    { product_code: "PNHY260395A", product_name: "安盈稳健日开7号A", sale_status: "12",
      buy_status_factor: { avail_quota: 600000 } },
  ] } });
  const mk = (hhmm, quiet) => webankAlerts(cur,
    { watch: ["PNHY260395A"], threshold: 10000, quietHours: quiet }, prev, hhmm,
    "2026-11-12T00:30:00+08:00");
  const r = mk("00:30", "00:00-01:00");
  assert.equal(r.alerts.length, 0, "免打扰不推通知");
  assert.equal(r.suppressed, 1, "被压制的条数要如实回报");
  assert.equal(r.state.PNHY260395A.saleStatus, "12", "状态照常记，避免结束后重复推");
  const q = mk("23:30", "23:00-07:00");
  assert.equal(q.alerts.length, 0, "跨午夜免打扰同样压制");
  assert.equal(q.suppressed, 1);
});

test("validateMonitorStatus：合法包放行，坏包整包拒收", () => {
  assert.deepEqual(validateMonitorStatus({ ok: true, status: { running: true, watchCount: 3 } }),
    { ok: true, why: "" });
  for (const bad of [null, [], "x", { ok: false, error: "超时" }, { ok: true },
                     { ok: true, status: null }, { ok: true, status: [] },
                     { ok: true, status: { running: "yes", watchCount: 3 } },
                     { ok: true, status: { running: true, watchCount: -1 } },
                     { ok: true, status: { running: true, watchCount: "3" } }]) {
    assert.equal(validateMonitorStatus(bad).ok, false, `应拒收：${JSON.stringify(bad)}`);
  }
});

test("v128 接线：app.js 正式监控主干（快照校验 / status 校验 / 启停透传 / v129 自检下线）", () => {
  assert.match(app, /MONITOR_WATCH_MAX, MONITOR_CFG_KEY,/);
  assert.match(app, /normMonitorCfg, parseWebank, webankRows, validateMonitorStatus,/);
  assert.match(app, /const raw = r\.snapshot;/, "快照只能来自服务 status 回包，绝不直连微众");
  assert.match(app, /const snap = parseWebank\(raw\)/, "快照必须过整包校验才进页面");
  assert.match(app, /if \(snap\.ok\) \{ MONITOR_ST\.snapshot = snap/, "坏快照不进页面");
  assert.ok(!/fetch\(WEBANK_QUOTA_URL|fetch\(.*webank.*no_auth/.test(app),
    "网页层绝不直连微众（无 CORS），抓数归 Java 前台服务");
  assert.match(app, /nativeMonitor\("monitor-status"\)/);
  assert.match(app, /validateMonitorStatus\(r\)/, "服务状态回包必须过整包校验");
  assert.match(app, /nativeMonitor\("monitor-start", cfg\)/);
  assert.match(app, /nativeMonitor\("monitor-stop"\)/);
  assert.match(app, /window\.NativeNav\.fetch\(id, JSON\.stringify\(cfg \? \{ mode, cfg \} : \{ mode \}\)\)/,
    "控制面必须走通用 NativeNav.fetch 透传（零新增桥出口）");
  assert.match(app, /网页版没有后台服务，实时监控与通知只在 App 内可用/, "网页端不假装能后台常驻");
  assert.match(app, /if \(!cfg\.watch\.length\) \{ toast\("先在「关注的产品」里勾选至少一只/,
    "没关注产品不许启动空跑的服务");
  assert.match(app, /webankRows\(pool, MONITOR_ST\.snapshot, cfg\.watch\)/,
    "关注清单来自我的可监控产品池，不是第三方池");
  assert.match(app, /function monitorPoolProducts\(\)/, "已清仓产品不进监控池");
  assert.match(app, /monitorStart, monitorStop, monitorRefresh, monitorCfgSave,/);
  assert.match(app, /monitorWatchOne, monitorWatchAll, monitorWatchNone,/);
  assert.match(app, /if \(MONITOR_ST\.status && MONITOR_ST\.status\.running\) nativeMonitor\("monitor-start", cfg\)/,
    "服务在跑时改配置要静默下发，不重启服务");
  /* v129：阶段 1 连通性自检（POST 裸数组）整块下线，页面只渲染正式监控 */
  const rm = app.match(/function renderMonitor\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(rm, /renderMonitorMain\(\);/);
  assert.ok(!/renderMonitorProbe|quotaProbe/.test(rm), "自检渲染不该再挂在主干上");
});

test("v128 独立页：四段式正式监控 UI + 微众/免责口径 + 第 5 tab（v129 自检下线）", () => {
  assert.match(html, /<div class="page" id="pg-monitor">/);
  assert.match(html, /微众 · 我的产品池/);
  assert.match(html, /台账里自己添加的产品/, "关注对象是我的台账产品");
  assert.match(html, /GET \?param=&lt;URL 编码 JSON&gt;/, "服务卡片纠正 21400044 是方法用错");
  assert.match(html, /不是端点判死/);
  assert.match(html, /上次回包成功/, "手机出口可达性移到服务状态行的说明里");
  assert.match(html, /已全部赎回（清仓）的产品不计入/, "监控池要排除已清仓产品");
  for (const id of ["monStateHint", "monStatus", "monThreshold", "monQuiet",
                    "monWatchCount", "monPool", "monLog"]) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id} 容器`);
  }
  for (const fn of ["monitorStart()", "monitorStop()", "monitorRefresh()",
                    "monitorWatchAll()", "monitorWatchNone()"]) {
    assert.ok(html.includes(`onclick="${fn}"`), `缺 ${fn} 入口`);
  }
  const cfgSaveHits = (html.match(/onchange="monitorCfgSave\(\)"/g) || []).length;
  assert.equal(cfgSaveHits, 2, "阈值与免打扰两个 input 都要绑 monitorCfgSave");
  assert.match(html, /不等于<\/b>登录微众 App 后个人实际可买额度/, "免责：匿名货架参考值≠个人可买额度");
  assert.match(html, /数据源为微众银行公开匿名接口/, "数据源口径");
  assert.match(html, /每 15 秒查一次/, "后台常驻归 Java 前台服务");
  assert.ok(!/<details>|id="quotaPick"|id="quotaResult"|quotaProbeRun\(\)/.test(html),
    "阶段 1 自检折叠区已移除，不再暴露误导性的 21400044 探测结果");
  assert.match(html, /data-p="pg-monitor" onclick="go\('pg-monitor'\)"/, "第 5 tab 联动高亮不落空");
});

test("v128 版本钉子：APP_VER 与 CACHE 动态同版本、SHELL 收 quota.js、清单已登记", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache, "v128 版本钉子必须同步");
  assert.match(sw, /"\.\/js\/core\/quota\.js"/, "复用同一模块，import 闭包不能漏进 SHELL");
  assert.ok(pkg.scripts.test.includes("tests/quota.test.mjs"), "测试要登记进 npm test 硬编码清单");
});
