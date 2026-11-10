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
   这几函数依赖 MARKET / MARKET_ST / marketStat / marketPanelHtml / marketAiTextSafe /
   marketCutoffText / marketStateBar，由调用方以参数注入，故提取后能真跑。 */
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
const F = grabFns(["marketHintText", "marketStateBar", "marketHeroHtml", "marketRefresh"]);
const stat = m => {
  const st = { up: 0, down: 0, flat: 0, none: 0 };
  for (const c of (m?.weather?.cells || [])) if (st[c.dir] !== undefined) st[c.dir] += 1;
  return st;
};
const panelOk = m => `<PANEL ${m.weather.asOf}>`;                 /* 替身：只判有没有调 */
const aiOk = m => (m.meta && m.meta.verified === true) ? "aiText" : "";
const barOk = () => "<BAR>";
/* 与源码同口径的截止时间替身（asOf 一律已过 17:00，测试不依赖跑测的系统时间） */
const cutOk = m => (m && m.weather && m.weather.asOf) ? `截至 ${m.weather.asOf} 17:00` : "";
const ST_IDLE = { phase: "idle", at: 0, err: "", cached: false };
/* 把被切出的函数与它的自由变量放进同一 new Function 作用域，再执行一次。 */
const runHint = (m, st = ST_IDLE) => new Function("MARKET", "MARKET_ST", "marketStat", "marketCutoffText",
  `${F.marketHintText.toString()}; return marketHintText();`)(m, st, stat, cutOk);
/* 把 marketRefresh 整段切出来放进一个独立作用域跑：MARKET / _mktBusy 在作用域里声明，
   其余依赖全部注入 —— 这样成功 / 失败 / 在途去重三条路径都是真跑，不是读源码猜。 */
function mkRefresh({ cfg = () => true, fetchIt = async () => ref, sync = { owner: "o", repo: "r" } } = {}) {
  const calls = { paint: 0, save: 0, toast: [] };
  const st = ST();
  const factory = new Function(
    "syncCfgOk", "fetchMarket", "MARKET_ST", "SYNC", "marketPaint", "marketCacheSave", "toast",
    `let MARKET = null; let _mktBusy = null;
     ${F.marketRefresh.toString()}
     return { r: marketRefresh, getM: () => MARKET, setM: v => { MARKET = v; } };`);
  const inst = factory(cfg, fetchIt, st, sync,
    () => calls.paint++, () => calls.save++, m => calls.toast.push(m));
  return { ...inst, calls, st };
}

const ageOk = at => (at ? "5 分钟前" : "");
/* v116：此刻层的两个入口用替身注入 —— 本文件验的是「接线」，此刻层自己的
   解析/单位/方向/时点在 tests/livebond.test.mjs 里真跑。 */
const LV_OK = {
  livePhaseOf: () => ({ id: "intraday", label: "盘中" }),
  liveBlockHtml: (_live, opts) => `<LIVE${opts && opts.err ? " ERR=" + opts.err : ""}>`,
};
const LIVE_ST_IDLE = { phase: "idle", at: 0, err: "", miss: [], lastTry: 0 };
const runBar = (m, st, lst = LIVE_ST_IDLE) => new Function(
  "MARKET", "MARKET_ST", "esc", "marketCutoffText", "marketAgeText", "marketStaleText", "LIVE_ST",
  `${F.marketStateBar.toString()}; return marketStateBar();`)(
  m, st, s => String(s), cutOk, ageOk, () => "", lst);
/* v118：宏观块的三个自由变量（MACRO / MACRO_ST / MC）也要注入 ——
   marketHeroHtml 里加了一段宏观渲染。MC 用替身，宏观自己的解析在 macro.test.mjs 真跑。 */
const MC_OK = { macroBlockHtml: () => "<MACRO>" };
const MACRO_ST_IDLE = { phase: "idle", at: 0, err: "", lastTry: 0 };
const liveToday = () => "2026-11-09";
const runHero = (m, st = ST_IDLE, lst = LIVE_ST_IDLE, macro = null, mst = MACRO_ST_IDLE, mc = MC_OK) => new Function(
  "MARKET", "MARKET_ST", "marketPanelHtml", "marketAiTextSafe", "esc", "marketStateBar",
  "LV", "LIVE", "LIVE_ST", "isTradeDay", "marketAgeText",
  "MACRO", "MACRO_ST", "MC", "today",
  `${F.marketHeroHtml.toString()}; return marketHeroHtml();`)(
  m, st, panelOk, aiOk, s => String(s), barOk, LV_OK, null, lst, () => true, ageOk,
  macro, mst, mc, liveToday);
const ST = (over = {}) => ({ phase: "idle", at: 0, err: "", cached: false, ...over });

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
  /* v107：openMarket 多了「打开即刷」，不再是单行 —— 按函数体断言，不锁形状 */
  const i = app.indexOf("function openMarket()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes('LLM.host = "market"'), "openMarket 没设 host=market");
  assert.ok(src.includes("renderMarketSheet()"), "openMarket 没渲染债市页");
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
test("marketHintText：有数据显示截止时点/核验/红绿白蓝；无数据不编数字", () => {
  const good = runHint(ref);
  /* 首页一行宽度有限：日期省年份，时点必须留着（用户要的就是「到几点为止」） */
  assert.ok(good.includes(ref.weather.asOf.slice(5)), `副标题没带数据日期：${good}`);
  assert.ok(good.includes("17:00"), `副标题没带截止时点：${good}`);
  assert.ok(!good.includes("截至"), "首页这行不该再带「截至」二字（宽度不够）");
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
  assert.ok(none.includes("日终层暂无数据") && none.includes("market.json"), "没给降级原因与数据源");
  assert.ok(none.includes("不编造任何数字"), "没写明不编数字");
  assert.ok(!/bp|红 \d|绿 \d/.test(none), "降级文案里却出现了行情数字");
});

/* ---------- 4b. v116：此刻层接线 ---------- */
test("v116 接线：此刻层排在状态条之后、日终面板之前；失败原因要传进块里", () => {
  const good = runHero(ref);
  const b = good.indexOf("<BAR>"), l = good.indexOf("<LIVE>"), p = good.indexOf("<PANEL");
  assert.ok(b >= 0, "状态条没渲染");
  assert.ok(l > b, "此刻层必须排在状态条之后");
  assert.ok(p > l, "日终面板必须排在此时刻层之后");
  /* 失败态：原因不能只丢给 toast，要落进块里 */
  const bad = runHero(ref, ST_IDLE, { phase: "err", at: 0, err: "超时（8 秒）", miss: [], lastTry: 0 });
  assert.ok(bad.includes("ERR=超时（8 秒）"), `此刻层的失败原因没传进去：${bad.slice(0, 200)}`);
});

/* ---------- 5. v107：截止时间 / 更新按钮 / 自动刷新 ---------- */
test("状态条：截止时点 + 本机取数时刻 + 「↻ 更新」，更新中禁用按钮", () => {
  const i = app.indexOf("function marketStateBar()");
  assert.ok(i > 0, "找不到 marketStateBar");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("marketCutoffText(MARKET)"), "状态条没取截止时间");
  assert.ok(src.includes("marketAgeText(s.at)"), "状态条没显示本机取数时刻");
  assert.ok(src.includes('onclick="marketRefreshAll()"'), "更新按钮没接 marketRefreshAll");
  assert.ok(src.includes("↻ 更新此刻"), "按钮文案不是「↻ 更新此刻」");
  assert.ok(src.includes('run ? "disabled" : ""'), "更新中没禁用按钮（连点会重复发请求）");
  /* 两块时间必须分开：数据截止 ≠ 本机取数时刻 */
  assert.ok(src.includes("mkt-bar-l") && src.includes("mkt-live"), "两块时间没分开展示");
});

test("状态条三态真跑：空闲给截止+本机时刻、更新中禁用按钮、失败给原因且不丢旧数据", () => {
  /* ① 空闲且有数据 */
  const idle = runBar(ref, ST({ at: Date.now() - 5 * 60e3 }));
  assert.ok(idle.includes("截至 2026-11-06 17:00"), `空闲态没显示截止时间：${idle}`);
  assert.ok(idle.includes("本机更新 5 分钟前"), "空闲态没显示本机取数时刻");
  assert.ok(idle.includes("↻ 更新") && !idle.includes("disabled"), "空闲态按钮不可用");
  /* ② 更新中：按钮变「更新中…」并禁用（连点会重复发请求） */
  const run = runBar(ref, ST({ phase: "loading", at: 1 }));
  assert.ok(run.includes("正在摸排"), "更新中没给进度文案");
  assert.ok(run.includes("摸排中…") && run.includes("disabled"), "更新中按钮没禁用");
  /* ③ 失败：给原因，且明说下面仍是旧数据 */
  const err = runBar(ref, ST({ phase: "err", at: 1, err: "HTTP 401 bad credentials" }));
  assert.ok(err.includes("更新失败") && err.includes("HTTP 401"), "失败态没给原因");
  assert.ok(err.includes("仍是上次取到的数据"), "失败态没交代旧数据仍在");
  /* ④ 缓存：标明来源，别把缓存说成刚更新的 */
  const cache = runBar(ref, ST({ at: Date.now() - 3 * 3600e3, cached: true }));
  assert.ok(cache.includes("本机缓存"), "缓存没标来源");
  assert.ok(!cache.includes("本机更新"), "缓存被说成了本机更新");
  /* ⑤ 从没取过：不许编时间 */
  const none = runBar(null, ST());
  assert.ok(none.includes("还没取过数据"), "空状态没说实话");
  assert.ok(!/分钟前|小时前/.test(none), "空状态却编了个时间");
});

test("marketHeroHtml：状态条排在最前；降级分支也带状态条（没数据时按钮是唯一出路）", () => {
  const i = app.indexOf("function marketHeroHtml()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  const b = src.indexOf("marketStateBar()");
  const p = src.indexOf("marketPanelHtml(MARKET");
  assert.ok(b > 0 && p > b, "状态条必须排在行情面板之前");
  /* 截止时间只在状态条出现一次；面板里那行在债市页要关掉（同一屏两遍会让人以为看错了） */
  assert.ok(src.includes("{ cut: false }"), "债市页面板没关掉重复的截止时间行");
  assert.ok(/const bar = marketStateBar\(\);/.test(src), "状态条没被两个分支共用");
  const none = runHero(null);
  assert.ok(none.includes("<BAR>"), "没数据时状态条被吞了，用户点不到「更新」");
});

test("债市页把行情区包进 #mktHero；刷新只重画这一块，不整页重绘", () => {
  const i = app.indexOf("function renderMarketSheet()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes('<div id="mktHero">'), "行情区没有 #mktHero 挂点，局部重绘无处落笔");
  const p = app.indexOf("function marketPaint()");
  const ps = app.slice(p, app.indexOf("\nfunction ", p + 5));
  assert.ok(ps.includes('$("mktHero")'), "marketPaint 没重画 #mktHero");
  assert.ok(!ps.includes("renderMarketSheet()"), "marketPaint 整页重绘会冲掉用户正在输、还没发的对话框内容");
});

test("自动刷新：启动先装缓存再静默拉；打开债市页按 TTL 触发", () => {
  const i = app.indexOf("function marketBoot()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("marketCacheLoad()"), "启动没先装本机缓存");
  assert.ok(src.includes("marketRefresh({ silent: true })"), "启动没静默拉一次最新");
  assert.ok(/\n  marketBoot\(\);/.test(app), "init 里没调 marketBoot");
  const j = app.indexOf("function openMarket()");
  const os = app.slice(j, app.indexOf("\nfunction ", j + 5));
  assert.ok(os.includes("MARKET_TTL"), "openMarket 没按 TTL 判要不要刷");
  assert.ok(os.includes("marketRefresh({ silent: true })"), "openMarket 没触发静默刷新");
});

test("marketRefresh 挂 window（更新按钮走内联 onclick）", () => {
  const i = app.indexOf("Object.assign(window, {");
  const j = app.indexOf("});", i);
  assert.ok(app.slice(i, j).includes("marketRefresh"), "window 桥接清单漏了 marketRefresh");
});

test("本机缓存按 owner/repo 隔离，读回来还要过 validateMarket；写缓存不走 saveLocal", () => {
  const i = app.indexOf("function marketCacheLoad()");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("o.owner !== SYNC.owner"), "缓存没按 owner 隔离（换库会串台）");
  assert.ok(src.includes("o.repo !== SYNC.repo"), "缓存没按 repo 隔离");
  assert.ok(src.includes("validateMarket(o.m)"), "缓存没复验 —— 磁盘上的东西同样不可信");
  const j = app.indexOf("function marketCacheSave()");
  const ss = app.slice(j, app.indexOf("\nfunction ", j + 5));
  assert.ok(!ss.includes("saveLocal()"), "写缓存不该走 saveLocal（会把 DIRTY 置脏、白推 GitHub）");
});

test("刷新失败不清空旧快照（网络抖动不该让人丢掉本来能看的行情）", () => {
  const i = app.indexOf("function marketRefresh(");
  const src = app.slice(i, app.indexOf("\nfunction marketBoot()"));
  /* 成功分支才赋值；失败分支只写状态，不许把 MARKET 清成 null */
  assert.ok(src.includes("MARKET = m;"), "成功分支没把新快照装进内存");
  assert.ok(!/catch[\s\S]*?MARKET = null/.test(src), "失败分支把旧快照清空了");
  /* 整包同步那条路同样不许无条件覆盖：赋值必须被 if (mkt) 包着 */
  const k = app.indexOf("MARKET = mkt;");
  assert.ok(k > 0, "syncPull 没把顺带取到的快照装进内存");
  assert.ok(app.slice(Math.max(0, k - 80), k).includes("if (mkt) {"),
    "syncPull 还是无条件 MARKET = mkt（拿不到就清空）");
});

test("marketRefresh 真跑：成功置 ok / 写缓存 / 重绘；失败留旧数据；在途去重只发一次", async () => {
  /* ① 成功 */
  const a = mkRefresh();
  a.setM({ marker: "old" });
  const ok = await a.r({ silent: true });
  assert.equal(ok, true, "拿到快照却报失败");
  assert.equal(a.st.phase, "ok", "成功没把状态置 ok");
  assert.ok(a.st.at > 0, "成功没记本机取数时刻");
  assert.equal(a.st.cached, false, "成功刷新后还标着缓存");
  assert.equal(a.calls.save, 1, "成功没写缓存（下次冷启动又空白）");
  assert.equal(a.getM(), ref, "快照没装进内存");
  assert.ok(a.calls.paint >= 2, "成功前后都该重绘（先转圈、后落数据）");
  assert.equal(a.calls.toast.length, 0, "静默刷新不该弹 toast");

  /* ② 失败：旧数据必须还在，且给出原因 */
  const b = mkRefresh({ fetchIt: async () => null });
  const old = { marker: "keep-me" };
  b.setM(old);
  const bad = await b.r({ silent: true });
  assert.equal(bad, false, "拿不到快照却报成功");
  assert.equal(b.st.phase, "err", "失败没置 err");
  assert.ok(b.st.err.includes("没读到快照"), `失败原因不对：${b.st.err}`);
  assert.equal(b.getM(), old, "失败把旧快照清空了 —— 网络抖动不该让人丢掉能看的行情");
  assert.equal(b.calls.save, 0, "失败还写了缓存");

  /* ③ 在途去重：连点「更新」只发一次请求 */
  let n = 0;
  const c = mkRefresh({ fetchIt: async () => { n++; await new Promise(r => setTimeout(r, 20)); return ref; } });
  const [r1, r2] = await Promise.all([c.r({ silent: true }), c.r({ silent: true })]);
  assert.equal(n, 1, `连点发了 ${n} 次请求，应只发 1 次`);
  assert.equal(r1, true);
  assert.equal(r2, true);

  /* ④ 没配同步：不发请求，直接给可执行的下一步 */
  let n2 = 0;
  const d = mkRefresh({ cfg: () => false, sync: { owner: "", repo: "" }, fetchIt: async () => { n2++; return ref; } });
  const noCfg = await d.r({ silent: true });
  assert.equal(noCfg, false);
  assert.equal(n2, 0, "没配同步还发了请求");
  assert.ok(d.st.err.includes("未配置数据同步"), `文案没指路：${d.st.err}`);
});

/* ---------- 7. 版本与清单一致（动态读版本，不硬编码 —— 版本钉子已收敛到
   handlers.test.mjs 一处，这里有写死的版本号会被它拦下） ---------- */
test("APP_VER / SW CACHE 同步，market.js 仍在离线清单", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)?.[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)?.[1];
  assert.ok(ver && cache, "读不到版本号");
  assert.equal(ver, cache, "APP_VER 与 SW CACHE 版本不一致");
  assert.ok(sw.includes("./js/core/market.js"), "market.js 掉出 SW 预缓存清单");
});

/* ---------- 8. v118：宏观块接线 ---------- */
test("v118 宏观块：排在日终层之后（时间尺度从上到下一次变慢）", () => {
  const cached = { CPI: { ok: true, latest: { period: "2026-10", val: 0.7 }, series: [] } };
  const h = runHero(ref, ST_IDLE, LIVE_ST_IDLE, cached);
  const iLive = h.indexOf("<LIVE");
  const iPanel = h.indexOf("<PANEL");
  const iMacro = h.indexOf("<MACRO");
  assert.ok(iLive >= 0 && iPanel >= 0 && iMacro >= 0, "三块都该出现");
  assert.ok(iLive < iPanel && iPanel < iMacro, `顺序不对：live=${iLive} panel=${iPanel} macro=${iMacro}`);
});

test("v118 宏观块：还没取过且没出错时不画（首次点开正在取，不先摆一个空表）", () => {
  const h = runHero(ref, ST_IDLE, LIVE_ST_IDLE, null, MACRO_ST_IDLE);
  assert.ok(!h.includes("<MACRO"), "没数据也没错，不该画宏观块");
  /* 出错时要画 —— 否则用户永远不知道为什么看不到宏观 */
  const e = runHero(ref, ST_IDLE, LIVE_ST_IDLE, null, { phase: "err", at: 0, err: "超时", lastTry: 1 });
  assert.ok(e.includes("<MACRO"), "出错时反而该画出来说明原因");
});

test("v118 宏观块：有缓存数据时照画，且把本机取数时刻传进去", () => {
  let seen = null;
  const mc = { macroBlockHtml: (_m, o) => { seen = o; return "<MACRO>"; } };
  const cached = { CPI: { ok: true, latest: { period: "2026-10", val: 0.7 }, series: [] } };
  const h = runHero(ref, ST_IDLE, LIVE_ST_IDLE, cached, { phase: "idle", at: 1794279605000, err: "", lastTry: 1 }, mc);
  assert.ok(h.includes("<MACRO"));
  assert.equal(seen.today, "2026-11-09", "要把今天传进去，否则判不出数据滞后几个月");
  assert.ok(seen.atText, "有取数时刻就要写出来");
});
