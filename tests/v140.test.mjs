/* v140 · P1 + P2 入口设计详细方案专项回归
   P1-3 持仓分析选择页规则说明
   P1-4 首页 AI 研判一级入口（openBriefPortfolio，不内联 openBrief）
   P1-5 研判弹层研报/走势切换（briefSwitchMode，导出清单 + segmented）
   P2-A 债市弹层去对话框（只行情 + 复制问句）
   P2-C BRIEF 结果级按 key 分槽 + 运行级单例（代理层）
   P2-B LLM.askCtx 回投解耦（host 保留兼容测试，askCtx 为实际路由）
   版本比对动态，不写死 vNN。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const home = html.slice(html.indexOf('id="pg-home"'), html.indexOf('id="pg-trade"'));
function body(fn) {
  const i = app.indexOf(`function ${fn}(`);
  assert.ok(i > 0, `找不到 ${fn}`);
  return app.slice(i, app.indexOf("\nfunction ", i + 5));
}

/* ---------- P1 ---------- */
test("P1-3 持仓分析选择页：规则说明在最前", () => {
  const b = body("openAnaIndex");
  const note = b.indexOf("只有<b>一只</b>产品时直接进入分析");
  const old = b.indexOf("体检是<b>一只一只</b>判的");
  assert.ok(note > 0, "缺「一只直达、多只先选」规则说明");
  assert.ok(old > note, "规则说明应排在原有说明之前");
});

test("P1-4 首页第 4 行 AI 研判一级入口，调已导出函数", () => {
  assert.ok(home.includes("<b>AI 研判</b>"), "首页缺 AI 研判入口");
  assert.ok(/onclick="openBriefPortfolio\(\)"/.test(home), "AI 研判入口未调 openBriefPortfolio");
  assert.ok(!/onclick="openBrief\(/.test(home), "不能内联 openBrief（不在 window 导出清单）");
  const assign = app.slice(app.indexOf("Object.assign(window, {"));
  assert.ok(/openBriefPortfolio[,}]/.test(assign), "openBriefPortfolio 未导出");
});

test("P1-5 目标切换：briefSwitchMode + 导出 + segmented", () => {
  const b = body("briefSwitchMode");
  assert.ok(b.includes('mode === "trend" ? "trend" : ""'), "未归一化 mode");
  assert.ok(b.includes('BRIEF.phase === "running"'), "缺生成中拦截");
  assert.ok(b.includes("navSeries(p)"), "切走势缺序列≥2点准入");
  const assign = app.slice(app.indexOf("Object.assign(window, {"));
  assert.ok(/briefSwitchMode[,}]/.test(assign), "briefSwitchMode 未导出");
  const rb = body("renderBriefSheet");
  assert.ok(rb.includes("briefSwitchMode('')") && rb.includes("briefSwitchMode('trend')"), "研判弹层缺 segmented 两按钮");
  assert.ok(rb.includes('class="${tm ? "" : "on"}"'), "segmented 未反映当前模式");
});

/* ---------- P2-A（与 market-page.test.mjs 的 P2-A 断言互补） ---------- */
test("P2-A 债市弹层去对话框：只行情 + 复制问句，答案仍回 model 页", () => {
  const b = body("renderMarketSheet");
  assert.ok(b.includes("marketHeroHtml()"), "缺行情主体");
  assert.ok(!b.includes("llmPanelHtml("), "债市页仍内嵌对话框");
  assert.ok(!b.includes("llmStatusLine()"), "债市页仍有模型状态行");
  assert.ok(b.includes("marketCopyAi()"), "缺复制问句引导");
});

/* ---------- P2-C：BRIEF 分槽（源码结构 + 运行时行为） ---------- */
test("P2-C-1 BRIEF 定义：byKey + activeKey + 运行级单例，无结果级裸字段", () => {
  const i = app.indexOf("const BRIEF = {");
  const block = app.slice(i, app.indexOf("};", i));
  assert.ok(block.includes("byKey: Object.create(null)"), "缺 byKey");
  assert.ok(block.includes('activeKey: "all"'), "缺 activeKey");
  assert.ok(/id: "", buf: null, timer: 0, t0: 0, runs: 0/.test(block), "运行级字段应保持单例");
  assert.ok(!/res: null, raw:/.test(block), "结果级字段不应裸写在 BRIEF 上（应由描述符代理）");
  assert.ok(app.includes("Object.defineProperty(BRIEF, _k"), "缺代理描述符");
});

test("P2-C-2 运行时：切 activeKey 后各槽结论互不覆盖", () => {
  // 抽取代理层相关定义，造一个最小可运行环境验证分槽语义
  const seg = app.slice(app.indexOf("const BRIEF_SLOT_DEFAULTS"), app.indexOf("function briefCacheRead"));
  const harness = seg + "\n; return { BRIEF, briefSlot, briefKey, BRIEF_TIER_DETAIL };";
  const ctx = new Function("BRIEF_TIER_DETAIL", harness)("detail");
  const { BRIEF, briefSlot, briefKey } = ctx;
  // 槽 A（组合研报）
  BRIEF.activeKey = briefKey({ kind: "portfolio" });
  BRIEF.res = { mark: "A" }; BRIEF.phase = "done";
  // 槽 B（单只产品研报）
  BRIEF.activeKey = briefKey({ kind: "product", id: "p1" });
  BRIEF.res = { mark: "B" }; BRIEF.phase = "done";
  // 槽 C（单只产品走势）
  BRIEF.activeKey = briefKey({ kind: "product", id: "p1", mode: "trend" });
  BRIEF.res = { mark: "C" }; BRIEF.phase = "done";
  // 切回 A / B / C，各自结论应独立保留
  BRIEF.activeKey = briefKey({ kind: "portfolio" });
  assert.equal(BRIEF.res.mark, "A", "组合研报槽被覆盖");
  BRIEF.activeKey = briefKey({ kind: "product", id: "p1" });
  assert.equal(BRIEF.res.mark, "B", "单只研报槽被覆盖");
  BRIEF.activeKey = briefKey({ kind: "product", id: "p1", mode: "trend" });
  assert.equal(BRIEF.res.mark, "C", "走势槽被覆盖");
  assert.equal(Object.keys(BRIEF.byKey).length, 3, "应有 3 个独立槽");
});

test("P2-C-3 运行时：运行级字段（id）单例，不随切槽复制", () => {
  const seg = app.slice(app.indexOf("const BRIEF_SLOT_DEFAULTS"), app.indexOf("function briefCacheRead"));
  const ctx = new Function("BRIEF_TIER_DETAIL", seg + "\n; return { BRIEF, briefKey };")("detail");
  const { BRIEF, briefKey } = ctx;
  const ctx2 = new Function("BRIEF_TIER_DETAIL", seg + "\n; return { BRIEF, briefKey, briefSlot };")("detail");
  const B = ctx2.BRIEF;
  B.activeKey = ctx2.briefKey({ kind: "portfolio" });
  B.id = "b1";
  const pk = ctx2.briefKey({ kind: "product", id: "p1" });
  ctx2.briefSlot(pk);                       // 先建产品槽
  B.activeKey = pk;
  assert.equal(B.id, "b1", "运行级 id 应单例（跨槽可见）");
  assert.ok(!("id" in B.byKey[pk]), "id 不应写进结果槽");
});

test("P2-C-4 openBrief / inflightAdopt 切槽到位", () => {
  const ob = body("openBrief");
  assert.ok(ob.includes("BRIEF.activeKey = briefKey(next)"), "openBrief 未切槽");
  const ia = body("briefInflightAdopt");
  assert.ok(ia.includes("BRIEF.activeKey = briefKey(recTarget)"), "inflight 恢复未切槽");
});

/* ---------- P2-B：askCtx 回投解耦 ---------- */
test("P2-B-1 LLM 有 askCtx，llmRepaint 按 ctx 回投，host 三态字面保留兼容旧测试", () => {
  assert.ok(/askCtx: null/.test(app), "LLM 缺 askCtx 字段");
  assert.ok(app.includes("function llmAskFrom("), "缺 llmAskFrom 登记入口");
  const rp = body("llmRepaint");
  assert.ok(rp.includes("LLM.askCtx"), "llmRepaint 未按 askCtx 回投");
  assert.ok(rp.includes("LLM.askCtx.repaint()"), "llmRepaint 未调用登记的回投函数");
  // 兼容：market-page.test.mjs 仍钉 host 三态字面，必须保留
  assert.ok(rp.includes('LLM.host === "market"'), "host 字面被删会破坏旧测试");
});

test("P2-B-2 三处提问入口各自登记 askCtx（llm / brief）", () => {
  const bs = body("briefRun");
  assert.ok(bs.includes("llmAskFrom("), "研判生成未登记 askCtx");
  const la = body("llmSend");
  assert.ok(la.includes("llmAskFrom("), "追问发送未登记 askCtx");
  const ia = body("llmInflightAdopt");
  assert.ok(ia.includes("llmAskFrom("), "追问恢复未登记 askCtx");
});

/* ---------- 版本钉（动态） ---------- */
test("V-1 版本钉 APP_VER 与 CACHE 同版本，专项进双清单", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache);
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/, "npm test 走通配，磁盘目录即唯一清单");
  assert.match(ci, /run: npm test/, "CI 直接调 npm test（单一来源）");
});
