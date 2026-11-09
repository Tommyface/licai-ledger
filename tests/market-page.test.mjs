/* v104 债市晴雨表二级页测试：node --test tests/market-page.test.mjs
   两层断言（沿用 backup.test.mjs / handlers.test.mjs 的口径）：
   1. 源码结构断言 —— 首页入口接线、host 分派、10 处内部重绘不跳页、
      行情只渲染一次、降级与未核验口径、版本一致；
   2. 纯函数真跑 —— marketHintText / marketHeroHtml 从源码切出后用 new Function
      实例化，注入参考快照，验证「有数据显示日期与统计、无数据不编数字」。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const ref = JSON.parse(fs.readFileSync(path.join(root, "data/market.reference.json"), "utf8"));

/* 切出一组顶层函数（含 async），拼进同一 new Function 作用域。
   这两函数依赖 MARKET / marketStat / marketPanelHtml / marketAiTextSafe，
   由调用方以参数注入，故提取后能真跑。 */
function grabFns(names) {
  const parts = [];
  for (const n of names) {
    let i = app.indexOf(`function ${n}(`);
    assert.ok(i > 0, `app.js 里找不到 function ${n}`);
    if (app.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
    let j = app.indexOf("\nfunction ", i + 5);
    const j2 = app.indexOf("\nasync function ", i + 5);
    if (j2 > 0 && (j < 0 || j2 < j)) j = j2;
    parts.push(app.slice(i, j > 0 ? j : undefined));
  }
  parts.push(`return {${names.join(",")}};`);
  return new Function(parts.join("\n"))();
}
const F = grabFns(["marketHintText", "marketHeroHtml"]);
const stat = m => {
  const st = { up: 0, down: 0, flat: 0, none: 0 };
  for (const c of (m?.weather?.cells || [])) if (st[c.dir] !== undefined) st[c.dir] += 1;
  return st;
};
const panelOk = m => `<PANEL ${m.weather.asOf}>`;                 /* 替身：只判有没有调 */
const aiOk = m => (m.meta && m.meta.verified === true) ? "aiText" : "";
/* 把被切出的函数与它的自由变量放进同一 new Function 作用域，再执行一次。 */
const runHint = m => new Function("MARKET", "marketStat",
  `${F.marketHintText.toString()}; return marketHintText();`)(m, stat);
const runHero = m => new Function("MARKET", "marketPanelHtml", "marketAiTextSafe", "esc",
  `${F.marketHeroHtml.toString()}; return marketHeroHtml();`)(m, panelOk, aiOk, s => String(s));

/* ---------- 1. 首页入口接线 ---------- */
test("首页原交易中心快捷入口已换成债市晴雨表，底部交易 tab 保留", () => {
  const home = html.slice(html.indexOf('id="pg-home"'), html.indexOf('id="pg-trade"'));
  assert.ok(home.includes("<b>债市晴雨表</b>"), "首页找不到债市晴雨表入口");
  assert.ok(/onclick="openMarket\(\)"/.test(home), "整行没接 openMarket()");
  assert.ok(home.includes('id="marketHint"'), "缺动态副标题挂点 marketHint");
  assert.ok(!home.includes("<b>交易中心</b>"), "首页还留着交易中心快捷入口");
  assert.ok(!home.includes('onclick="go(\'pg-trade\')"'), "首页还留着旧跳转");
  /* 右侧「查看」按钮也走 openMarket，不残留 openTrade */
  assert.ok(/onclick="event\.stopPropagation\(\);openMarket\(\)"/.test(home), "右侧查看按钮没接 openMarket");
  assert.ok(!/onclick="event\.stopPropagation\(\);openTrade\(\)"/.test(home), "右侧还挂着 openTrade");
  /* 底部 tabbar 的「交易」入口必须还在（P0①：只换首页卡片） */
  assert.ok(html.includes('data-p="pg-trade"'), "底部交易 tab 被删了");
  assert.ok(html.includes('id="pg-trade"'), "交易页被删了");
});

test("renderHome 不再引用已删除的 tradeHint（防 null 白屏），改用 marketHintText", () => {
  assert.ok(!app.includes("$(\"tradeHint\")"), "renderHome 还在写 tradeHint，页面会抛错");
  assert.ok(app.includes('if ($("marketHint")) $("marketHint").textContent = marketHintText();'),
    "首页副标题没接 marketHintText()");
});

test("openMarket 已挂 window（handlers 双向清单由 handlers.test.mjs 统一把守）", () => {
  const i = app.indexOf("Object.assign(window, {");
  const j = app.indexOf("});", i);
  assert.ok(app.slice(i, j).includes("openMarket"), "window 桥接清单漏了 openMarket");
});

/* ---------- 2. host 分派：核心，防止答案回来跳页 ---------- */
test("LLM.host 默认 llm；两个入口各设各的宿主", () => {
  assert.ok(/host: "llm"/.test(app), "LLM 初始 host 不是 llm");
  assert.ok(/function openLlm\(\) \{ LLM\.host = "llm"; renderLlmSheet\(\); \}/.test(app),
    "openLlm 入口没设 host=llm / 没渲染模型接入页");
  assert.ok(/function openMarket\(\) \{ LLM\.host = "market"; renderMarketSheet\(\); \}/.test(app),
    "openMarket 入口没设 host=market / 没渲染债市页");
});

test("llmRepaint 按 host 分派到两个宿主渲染", () => {
  const i = app.indexOf("function llmRepaint()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes('LLM.host === "market"'), "没判 market 宿主");
  assert.ok(src.includes("renderMarketSheet()") && src.includes("renderLlmSheet()"), "分派缺一个宿主");
});

test("10 处内部重绘全部走 llmRepaint，没有一处漏回 openLlm（回归钉子）", () => {
  /* 全文件里 openLlm(); 形式的独立调用必须清零；
     允许保留：入口定义、renderLlm 里的 onclick="openLlm()"、window 清单、注释文字。 */
  const calls = [...app.matchAll(/\bopenLlm\(\);/g)];
  assert.equal(calls.length, 0, `还有 ${calls.length} 处内部重绘直接调 openLlm(); —— 在债市页发问会跳页`);
  const repaints = [...app.matchAll(/\bllmRepaint\(\);/g)];
  assert.ok(repaints.length >= 10, `llmRepaint 调用点只有 ${repaints.length} 处，应至少 10 处`);
  /* 逐个点名：发问/回传/分块/超时/取消/清上文/勾台账/存配置/__llmCfg */
  for (const fn of ["llmSend", "__llmChunk", "__llmDone", "llmTimeout", "llmCancel", "llmClearChat", "llmDataToggle", "llmSaveCfg", "__llmCfg"]) {
    const k = app.indexOf(`function ${fn}(`) >= 0 ? `function ${fn}(` : `window.${fn} =`;
    const i = app.indexOf(k);
    assert.ok(i > 0, `找不到 ${fn}`);
    const j = app.indexOf("\nfunction ", i + 5);
    const j2 = app.indexOf("\nwindow.", i + 5);
    const end = Math.min(...[j, j2].filter(x => x > 0).concat([app.length]));
    const body = app.slice(i, end);
    assert.ok(body.includes("llmRepaint()"), `${fn} 没走 llmRepaint（答案回来会跳页）`);
  }
});

/* ---------- 3. 两个宿主的渲染顺序与「行情只渲染一次」 ---------- */
test("债市页：上部行情（marketHeroHtml）、下部对话（llmPanelHtml(false)），顺序固定", () => {
  const i = app.indexOf("function renderMarketSheet()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("<h3>债市晴雨表</h3>"), "标题不对");
  const h = src.indexOf("marketHeroHtml()");
  const p = src.indexOf("llmPanelHtml(false");
  assert.ok(h > 0 && p > h, "行情必须排在对话框前面");
  assert.ok(src.includes('llmPanelHtml(false, "代入台账接着问模型")'), "对话框标题不是「代入台账接着问模型」");
  assert.ok(!src.includes("marketPanelHtml(MARKET)"), "债市页不该直接再渲染一遍行情（应在 hero 内）");
  assert.ok(src.includes("llmStatusLine()"), "缺模型状态/降级提示行");
});

test("模型接入页保持原样：端点配置 + llmPanelHtml(true, 接着问)，行情仍内嵌", () => {
  const i = app.indexOf("function renderLlmSheet()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("<h3>模型接入</h3>"), "标题不对");
  assert.ok(src.includes("端点与模型") && src.includes("llmSaveCfg()"), "端点配置区丢了");
  assert.ok(src.includes('llmPanelHtml(true, "接着问")'), "设置页宿主没沿用「接着问」对话区");
});

test("llmPanelHtml 共用一份：withMarket 控制行情是否内嵌，heading 由宿主给", () => {
  const i = app.indexOf("function llmPanelHtml(");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("withMarket ? marketPanelHtml(MARKET) : \"\""), "withMarket 没控制行情内嵌");
  assert.ok(src.includes("esc(heading)"), "heading 没被宿主参数化");
  assert.ok(src.includes('id="llmData"') && src.includes('id="llmQ"') && src.includes('id="llmOut"'),
    "对话区三要素（带上台账 / 输入框 / 结果区）缺了");
  assert.ok(src.includes("llmSnapLine()") && src.includes("llmHistoryHtml()") && src.includes("llmResultHtml()"),
    "快照行 / 上文 / 结果区没接上");
  /* 债市页传 false 时，llmPanelHtml 内不得再调 marketPanelHtml 第二遍（由 withMarket 拦截） */
  assert.equal((src.match(/marketPanelHtml\(MARKET\)/g) || []).length, 1, "llmPanelHtml 内行情调用不是一处");
});

/* ---------- 4. 降级口径真跑 ---------- */
test("marketHintText：有数据显示日期/核验/红绿白蓝；无数据不编数字", () => {
  const good = runHint(ref);
  assert.ok(good.includes(ref.weather.asOf), "副标题没带数据日期");
  assert.ok(good.includes("已核验"), "已核验快照没标已核验");
  assert.ok(good.includes("红 26") && good.includes("绿 3") && good.includes("蓝 4"),
    `统计不对：${good}`);
  const none = runHint(null);
  assert.ok(none.includes("未读取到快照"), "无数据时没说实话");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(none), "无数据时却编了个日期");
  assert.ok(!/红 \d/.test(none), "无数据时却编了统计数字");
  const unver = runHint({ ...ref, meta: { ...ref.meta, verified: false } });
  assert.ok(unver.includes("未核验"), "verified=false 没标未核验");
});

test("marketHeroHtml：有数据渲染面板 + 复制按钮；无数据给降级说明且不编数字", () => {
  const good = runHero(ref);
  assert.ok(good.includes(`<PANEL ${ref.weather.asOf}>`), "没渲染行情面板");
  assert.ok(good.includes("marketCopyAi()"), "缺复制快照按钮");
  const none = runHero(null);
  assert.ok(none.includes("暂无行情数据") && none.includes("market.json"), "没给降级原因与数据源");
  assert.ok(none.includes("不编造任何数字"), "没写明不编数字");
  assert.ok(!/bp|红 \d|绿 \d/.test(none), "降级文案里却出现了行情数字");
});

/* ---------- 5. 版本与清单一致（动态读版本，不硬编码 —— 版本钉子已收敛到
   handlers.test.mjs 一处，这里有写死的版本号会被它拦下） ---------- */
test("APP_VER / SW CACHE 同步，market.js 仍在离线清单", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)?.[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)?.[1];
  assert.ok(ver && cache, "读不到版本号");
  assert.equal(ver, cache, "APP_VER 与 SW CACHE 版本不一致");
  assert.ok(sw.includes("./js/core/market.js"), "market.js 掉出 SW 预缓存清单");
});
