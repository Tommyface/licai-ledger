/* v139 · 入口设计简化 P0 专项回归
   1. 命名统一：用户可见文案债市行情/持仓分析，注释与历史措辞不误伤
   2. 按钮收敛：产品详情 2 主操作 + 2 个原生 <details> 折叠，零新 JS handler
   3. 产物名边界：弹层内「走势专题」保留（与研报区分，P1-11 钉住）
   4. 版本钉：APP_VER/CACHE 动态同版本，不写死 vNN
   版本比对全部动态，避免总测「版本钉收敛一处」误伤。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const home = html.slice(html.indexOf('id="pg-home"'), html.indexOf('id="pg-trade"'));
const trade = html.slice(html.indexOf('id="pg-trade"'), html.indexOf('id="pg-prod"'));
function body(fn) {
  const i = app.indexOf(`function ${fn}(`);
  assert.ok(i > 0, `找不到 ${fn}`);
  return app.slice(i, app.indexOf("\nfunction ", i + 5));
}

/* ---------- 1. 命名统一（用户可见文案） ---------- */
test("E-1 首页两处入口文案：债市行情 / 持仓分析", () => {
  assert.ok(home.includes("<b>债市行情</b>"), "首页债市入口未改名为「债市行情」");
  assert.ok(home.includes("<b>持仓分析</b>"), "首页持仓入口未改名为「持仓分析」");
  assert.ok(trade.includes("<b>持仓分析</b>"), "产品tab持仓入口未改名为「持仓分析」");
  assert.ok(!home.includes("<b>债市晴雨表</b>") && !home.includes("<b>持仓体检</b>"), "首页仍残留旧入口名");
});

test("E-2 债市/持仓弹层标题改名，副标题 marketHintText 口径一致", () => {
  assert.ok(app.includes("<h3>债市行情</h3>"), "债市弹层标题未改名");
  assert.ok((app.match(/<h3>持仓分析<\/h3>/g) || []).length >= 2, "两处持仓弹层标题未都改名");
  const hint = body("marketHintText");
  assert.ok(hint.includes("债市行情"), "marketHintText 副标题应为债市行情");
});

test("E-3 toast 路径提示指向新入口名，无旧路径残留", () => {
  assert.ok(app.includes("持仓分析 → AI 研判"), "研判 toast 路径未同步");
  assert.ok(app.includes("产品详情 → 走势分析"), "走势 toast 路径未同步");
  assert.ok(!app.includes("持仓体检 → AI 研判"), "残留旧 toast 路径");
  assert.ok(!app.includes("产品详情 → 走势专题"), "残留旧 toast 路径");
});

test("E-4 trendQuestionHint 改指「走势分析」入口", () => {
  const t = readFileSync(new URL("../js/domain/trend.js", import.meta.url), "utf8");
  assert.ok(t.includes("问走势请走「走势分析」"), "走势问答提示未改指新入口");
});

/* ---------- 2. 按钮收敛 ---------- */
test("E-5 产品详情：2 主操作 + 2 个原生折叠，旧 5 颗平铺不再", () => {
  const prod = body("renderProdDetail");
  const seg = prod.slice(prod.indexOf("底层配置与申赎规则"));
  assert.ok(seg.includes('onclick="closeSheet();openNav('), "主操作「录入净值」缺失");
  assert.ok(seg.includes('onclick="openAna(') && seg.includes(">持仓分析</button>"), "主操作「持仓分析」缺失");
  const folds = seg.match(/<details class="card"/g) || [];
  assert.equal(folds.length, 2, "应有 2 个原生 details 折叠（AI 研判 / 更多操作）");
  assert.ok(seg.includes("AI 研判") && seg.includes("更多操作"), "两个折叠标题缺失");
  assert.ok(seg.includes('onclick="openBriefProduct('), "折叠内研报入口缺失");
  assert.ok(seg.includes('onclick="openBriefTrend(') && seg.includes(">走势分析</button>"), "折叠内走势分析入口缺失");
  assert.ok(!seg.includes("口径体检 + 并列情景 + 观察点"), "旧 20 字长按钮文案应已移除");
});

test("E-6 折叠零新增 JS handler：按钮函数都已在全局桥接清单", () => {
  const need = ["openNav", "openAna", "openBriefProduct", "openBriefTrend", "openDisc", "editProd"];
  for (const fn of need) {
    assert.ok(new RegExp(`${fn}[,}]`).test(app.slice(app.indexOf("Object.assign(window, {"))), `${fn} 未挂 window`);
  }
});

/* ---------- 3. 产物名边界 ---------- */
test("E-7 弹层内「走势专题」作为产物名保留（与研报区分）", () => {
  // P1-11 钉住的检索文案仍在；入口改名不影响弹层产物名
  assert.match(app, /走势专题允许联网找「最新金融信息」，但三条闸不变/);
  assert.ok(app.includes('tm ? "走势专题" : "AI 研判"'), "弹层标题的产物名区分不应被改名");
});

/* ---------- 4. 版本钉（动态） ---------- */
test("E-8 版本钉：APP_VER 与 CACHE 动态同版本", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache, "APP_VER 与 CACHE 必须同版本");
  assert.match(app, /const APP_VER = "v\d+";/);
});

test("E-9 新专项进 package.json 与 ci.yml 双清单", () => {
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/, "npm test 走通配，磁盘目录即唯一清单");
  assert.match(ci, /run: npm test/, "CI 直接调 npm test（单一来源）");
});
