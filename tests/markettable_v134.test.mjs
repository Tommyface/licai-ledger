/* v134 · 债市「实时行情表」+ 收蛋估算（严格隔离）专项回归
   跑法：node --test tests/markettable_v134.test.mjs

   ★ 本文件最要紧的是最后一组的**反向断言**：收蛋是推算值，用户拍板
     「纳入但严格隔离」—— 绝不进 llmSnapText / liveFactsForBrief / briefFacts /
     marketAiBlock / marketCopyAi 任何自动装配链路。这里用函数体切片逐一验，
     不是只 grep 全文（全文出现「蛋」是允许的：展示层本来就要写）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EGGS_MODEL_POLICY, EGG_UNIT_PCT, EGGS_DISCLAIMER, EGG_BANDS, RT_DIR_SHORT,
  buildRealtimeRows, buildDailySummary, eggsOf, estimateEggs, eggsRangeText,
  eggsPctText, realtimeTableHtml, realtimeTableText,
} from "../js/core/markettable.js";
import { liveParse, liveDirOf, LIVE_QUOTES } from "../js/core/livebond.js";
import { MARKET_CELL_COUNT, validateMarket, marketAiBlock, marketAiTextSafe,
  marketStat } from "../js/core/market.js";

const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const SW = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const MT = readFileSync(new URL("../js/core/markettable.js", import.meta.url), "utf8");
const PKG = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const MARKET = JSON.parse(readFileSync(new URL("../data/market.reference.json", import.meta.url), "utf8"));

/* 实测东财返回（与 livebond.test.mjs 同一份，2026-11-10 11:26） */
const RAW = { data: { total: 12, diff: [
  { f2: 1.5964, f3: 0.12, f4: 0.0019, f12: "CN10Y", f14: "中国10年期国债" },
  { f2: 2.0546, f3: 0.31, f4: 0.0063, f12: "CN30Y", f14: "中国30年期国债" },
  { f2: 1.3621, f3: 3.89, f4: 0.051, f12: "CN5Y", f14: "中国5年期国债" },
  { f2: 1.2347, f3: 0.23, f4: 0.0028, f12: "CN2Y", f14: "中国2年期国债" },
  { f2: 118.49, f3: -0.17, f4: -0.2, f12: "140130", f14: "TL主力合约" },
  { f2: 110.19, f3: -0.04, f4: -0.04, f12: "110130", f14: "T主力合约" },
  { f2: 106.865, f3: -0.03, f4: -0.035, f12: "050130", f14: "TF主力合约" },
  { f2: 102.668, f3: -0.01, f4: -0.012, f12: "130130", f14: "TS主力合约" },
  { f2: 1.365, f3: 1.11, f4: 0.015, f12: "204007", f14: "GC007" },
  { f2: 1.26, f3: 7.69, f4: 0.09, f12: "204001", f14: "GC001" },
  { f2: 232.41, f3: -0.02, f4: -0.05, f12: "000012", f14: "国债指数" },
  { f2: 311.24, f3: 0.0, f4: 0.0, f12: "000013", f14: "企债指数" },
] } };
const LIVE = (() => { const p = liveParse(RAW); return { quotes: p.quotes, miss: p.miss, at: Date.parse("2026-11-13T10:30:00+08:00") }; })();

/* 剥掉注释，只留下代码 —— 隔离断言要防的是「真的把收蛋代码装配进模型」，
   不是防注释里出现「收蛋」两个字（说明文字本来就该写清楚）。
   只删块注释与行首 // 注释，不碰字符串里的 https://（它不在行首）。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* 抠出顶层函数体（到下一个顶层 function 之前），并剥注释。
   app.js 的函数都是顶格 `function name(`，够用，不需要上 parser。
   ★ 必须剥注释：marketCopyTable 的说明注释紧贴 marketCopyAi 之后，
     不剥就会把那段「收蛋」说明误算进 marketCopyAi 的函数体（v130/v133 同类坑）。 */
function bodyOf(src, name) {
  const re = new RegExp(`^function ${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  const nxt = src.indexOf("\nfunction ", start + 1);
  return stripComments(nxt < 0 ? src.slice(start) : src.slice(start, nxt));
}
const MT_CODE = stripComments(MT);

/* ============================================================
   一、契约与真源快照
   ============================================================ */
test("v134 真源 market.reference.json 通过既有 validateMarket（本轮不改判据）", () => {
  const r = validateMarket(MARKET);
  assert.equal(r.ok, true, r.why);
  assert.equal(MARKET.weather.cells.length, MARKET_CELL_COUNT);
});

test("v134 版本钉：APP_VER / CACHE 同步 v135，新模块进 SHELL", () => {
  const ver = APP.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = SW.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, "v135");
  assert.equal(cache, "v135");
  assert.equal(ver, cache);
  assert.match(SW, /"\.\/js\/core\/markettable\.js"/, "离线预缓存不能漏新模块");
  assert.match(APP, /from "\.\/js\/core\/markettable\.js"/, "app.js 必须 import");
});

test("v134 两处测试清单都登记专项（漏一个等于只在本地跑过）", () => {
  assert.match(PKG, /markettable_v134\.test\.mjs/, "npm test 登记");
  assert.match(CI, /markettable_v134\.test\.mjs/, "CI 登记");
});

/* ============================================================
   二、聚合实时表：行列完整性 / 方向 / 缺项
   ============================================================ */
test("v134 12 项全在、分组顺序不变、缺项照样占一行", () => {
  const rt = buildRealtimeRows(LIVE);
  assert.equal(rt.total, LIVE_QUOTES.length);
  assert.equal(rt.allRows.length, LIVE_QUOTES.length);
  assert.equal(rt.got, 12);
  assert.equal(rt.miss.length, 0);
  assert.deepEqual(rt.groups.map(g => g.id), ["index", "rate", "fut", "cash"]);
  assert.equal(rt.stat.up + rt.stat.down + rt.stat.flat + rt.stat.none, 12);
});

test("v134 缺项不静默少行，且标 none / 缺字", () => {
  const partial = { quotes: { CN10Y: LIVE.quotes.CN10Y }, miss: ["CN5Y", "GC007"], at: LIVE.at };
  const rt = buildRealtimeRows(partial);
  assert.equal(rt.allRows.length, 12, "清单 12 项一行都不能少");
  assert.equal(rt.got, 1);
  const missRows = rt.allRows.filter(r => r.missing);
  assert.equal(missRows.length, 11);
  assert.ok(missRows.every(r => r.dir === "none" && r.valText === "—"));
  /* 清单外孤儿（不该出现在 groups 里）单独留痕，不混进 12 行 */
  assert.ok(Array.isArray(rt.orphans));
});

test("v134 方向沿用 liveDirOf，不另立一套（收益率下行=红）", () => {
  const rt = buildRealtimeRows(LIVE);
  for (const r of rt.allRows) {
    const q = LIVE.quotes[r.key];
    if (!q) continue;
    const isPx = q.kind === "price" || q.kind === "index";
    assert.equal(r.dir, liveDirOf(q.kind, isPx ? q.pct : q.bp), r.key);
  }
  /* CN10Y f4=+0.0019 → bp=+0.19（收益率上行）→ 绿 */
  const c10 = rt.allRows.find(r => r.key === "CN10Y");
  assert.equal(c10.dir, "down");
  assert.equal(c10.unit, "%");
  /* 指数不带 % 单位 */
  assert.equal(rt.allRows.find(r => r.key === "IDX_GZ").unit, "");
  assert.equal(RT_DIR_SHORT.down, "绿·跌");
});

test("v134 日终摘要与 marketStat 同源、时点如实", () => {
  const ds = buildDailySummary(MARKET);
  assert.equal(ds.count, 33);
  assert.equal(ds.total, MARKET_CELL_COUNT);
  assert.deepEqual(ds.stat, marketStat(MARKET));
  assert.equal(ds.asOf, MARKET.weather.asOf);
  assert.equal(ds.prevDate, MARKET.weather.prevDate);
  assert.equal(ds.verified, true);
  assert.match(ds.source, /中债/);
  assert.equal(buildDailySummary(null), null);
});

/* ============================================================
   三、收蛋估算：公式 / 分档 / 区间 / 降级 / 免责
   ============================================================ */
test("v134 蛋数公式：蛋数 = −久期 × bp（1蛋 = 0.01%）", () => {
  assert.equal(EGG_UNIT_PCT, 0.01);
  assert.equal(eggsOf(2, -0.3), 0.6, "收益率下行 0.3bp、久期 2 → 赚 0.6 蛋");
  assert.equal(eggsOf(7, -1.2), 8.4, "下行 1.2bp、久期 7 → 赚 8.4 蛋");
  assert.equal(eggsOf(3, 1.0), -3, "收益率上行 → 亏");
  assert.equal(eggsOf(2, 0), 0);
  assert.equal(eggsOf(2, NaN), null);
  assert.equal(eggsOf(null, 1), null);
});

test("v134 分档按报告口径：3 年以下中短债、3 年以上中长债，且是假设区间", () => {
  assert.equal(EGG_BANDS.length, 2);
  assert.equal(EGG_BANDS[0].key, "short");
  assert.equal(EGG_BANDS[0].durHi, 3);
  assert.equal(EGG_BANDS[1].key, "long");
  assert.equal(EGG_BANDS[1].durLo, 3);
  for (const b of EGG_BANDS) assert.match(b.durNote, /假设久期/);
});

test("v134 真源 33 格 → 官方曲线口径，区间与方向正确", () => {
  const eg = estimateEggs(MARKET, LIVE);
  assert.equal(eg.ok, true, eg.why);
  assert.equal(eg.estimateOnly, true);
  assert.equal(eg.basis, "official-curve");
  assert.match(eg.basisLabel, /中债官方/);
  assert.equal(eg.asOf, MARKET.weather.asOf);
  assert.equal(eg.bands.length, 2);
  for (const b of eg.bands) {
    assert.equal(b.ok, true, b.label);
    assert.ok(b.used.length > 0, `${b.label} 应列出采用的关键期限`);
    assert.ok(b.lo <= b.hi, "区间下端不得大于上端");
    assert.equal(b.pctLo, Math.round(b.lo * 0.01 * 10000) / 10000);
    /* 方向：用 bp 沿 liveDirOf 的 yield 语义 */
    assert.equal(b.dir, liveDirOf("yield", b.bp));
  }
  /* 真源国债 1年 -0.3 / 3年 -1.1 → 均值 -0.7bp，中短债区间应为正（红/赚钱） */
  const short = eg.bands[0];
  assert.equal(short.bp, -0.7);
  assert.equal(short.lo, 0.7);
  assert.equal(short.hi, 2.1);
  assert.equal(short.dir, "up");
  assert.equal(eggsRangeText(short), "+0.7 ~ +2.1 蛋");
  assert.equal(eggsPctText(short), "+0.007% ~ +0.021%");
});

test("v134 日终层缺失 → 降级到此刻层盘中参考收益率，并如实标注", () => {
  const eg = estimateEggs(null, LIVE);
  assert.equal(eg.ok, true);
  assert.equal(eg.basis, "live-yield");
  assert.match(eg.basisLabel, /盘中参考/);
  assert.match(eg.basisLabel, /降级/);
  assert.equal(eg.asOf, "");
  for (const b of eg.bands) assert.equal(b.basis, "live-yield");
});

test("v134 两层都没有 → 不做估算，绝不编数", () => {
  const eg = estimateEggs(null, null);
  assert.equal(eg.ok, false);
  assert.match(eg.why, /不做估算/);
  assert.equal(eg.bands.length, 0);
  assert.equal(eggsRangeText(null), "—");
  const h = realtimeTableHtml(null, null, {});
  assert.match(h, /data-eggs-ok="0"/);
  assert.match(h, /没有可用的收益率/);
});

test("v134 免责声明每次输出整段携带，且写明不进模型 / 与净值脱钩", () => {
  for (const kw of ["推算值", "有误差", "与真实净值脱钩", "假设久期", "不是活跃券成交价",
    "不进入模型快照与研判事实层", "不构成投资建议"]) {
    assert.ok(EGGS_DISCLAIMER.includes(kw), `免责缺「${kw}」`);
  }
  const h = realtimeTableHtml(LIVE, MARKET, {});
  assert.ok(h.includes(EGGS_DISCLAIMER), "HTML 必须整段带免责");
  assert.match(h, /data-eggs="display-only"/);
  assert.match(h, /rt-egg-tag[^>]*>推算值/);
  const t = realtimeTableText(LIVE, MARKET, {});
  assert.ok(t.includes(EGGS_DISCLAIMER), "复制文本也必须整段带免责");
  assert.match(t, /免责：/);
});

/* ============================================================
   四、渲染：HTML 表结构 / 文本快照
   ============================================================ */
test("v134 实时表是 table 形态，含 4 分组 + 日终摘要 + 信号灯合计", () => {
  const h = realtimeTableHtml(LIVE, MARKET, { phase: { id: "intraday", label: "盘中" } });
  assert.match(h, /<table class="mkt-tbl rt-tbl">/);
  assert.match(h, /现抓 10:30:00/);
  assert.match(h, /盘中/);
  assert.match(h, /交易所债券指数/);
  assert.match(h, /国债收益率/);
  assert.match(h, /国债期货/);
  assert.match(h, /交易所回购/);
  assert.match(h, /日终层 · 33 格方向矩阵/);
  assert.match(h, /信号灯合计/);
  assert.match(h, /两套口径，不做差、不互补/);
  /* 12 项 + 分组行 + 表头 + 日终 3 行 + 合计行，不能只有空壳 */
  assert.ok((h.match(/<tr/g) || []).length >= 20);
});

test("v134 复制文本是 TSV（可贴 Excel），行列与表一致且带收蛋段", () => {
  const t = realtimeTableText(LIVE, MARKET, {});
  const lines = t.split("\n");
  assert.match(lines[0], /^债市实时行情表\t/);
  assert.match(lines[1], /^分组\t名称\t最新\t涨跌\t方向\t来源\/口径$/);
  assert.ok(lines.some(l => l.startsWith("日终层 33 格\t")));
  assert.ok(lines.some(l => l.includes("【债基收蛋估算")));
  assert.ok(lines.some(l => l.startsWith("分档\t假设久期\t推算蛋数")));
  /* 12 行明细，每行 6 列。第一组标题带「（上证口径）」后缀，用分组 id 前缀匹配更稳。 */
  const detail = lines.filter(l => /^(交易所债券指数|国债收益率|国债期货|交易所回购)[^\t]*\t/.test(l));
  assert.equal(detail.length, 12);
  for (const l of detail) assert.equal(l.split("\t").length, 6);
});

test("v134 无此刻数据时表不编数字，实时表仍可生成（日终层照常）", () => {
  const h = realtimeTableHtml(null, MARKET, {});
  assert.match(h, /尚未取过此刻行情/);
  assert.match(h, /此刻层 0\/12 项/);
  const rows = (h.match(/本次没取到/g) || []).length;
  assert.equal(rows, 12, "12 项都标「本次没取到」，不许拿日终数据顶");
});

/* ============================================================
   五、★★ 严格隔离反向断言（用户拍板「纳入但严格隔离」） ★★
   ============================================================ */
test("v134 机械护栏常量为 display-only", () => {
  assert.equal(EGGS_MODEL_POLICY, "display-only");
  assert.match(MT, /export const EGGS_MODEL_POLICY = "display-only"/);
});

test("v134 收蛋绝不进 llmSnapText / llmSnapItems / marketCopyAi 函数体", () => {
  for (const fn of ["llmSnapText", "llmSnapItems", "llmSnapLine", "marketCopyAi"]) {
    const b = bodyOf(APP, fn);
    assert.ok(b, `找不到 ${fn}`);
    assert.doesNotMatch(b, /estimateEggs|realtimeTableText|realtimeTableHtml|收蛋|推算蛋数|蛋数/i,
      `${fn} 里混进了收蛋相关内容`);
  }
});

test("v134 收蛋绝不进研判事实层 briefFacts / liveFactsForBrief / briefGaps / briefPack", () => {
  for (const fn of ["briefFacts", "liveFactsForBrief", "briefGaps", "briefPack"]) {
    const b = bodyOf(APP, fn);
    assert.ok(b, `找不到 ${fn}`);
    assert.doesNotMatch(b, /estimateEggs|realtimeTableText|realtimeTableHtml|收蛋|推算蛋数/i,
      `${fn} 里混进了收蛋相关内容`);
  }
});

test("v134 收蛋不进 marketAiBlock / marketAiTextSafe（aiText 是私有仓产物）", () => {
  const blk = marketAiBlock(MARKET);
  assert.ok(blk.length > 0, "真源 verified 应产出债市块");
  assert.doesNotMatch(blk, /收蛋|蛋数|推算值|estimateEggs/);
  const safe = marketAiTextSafe(MARKET);
  assert.equal(safe, MARKET.aiText);
  assert.doesNotMatch(safe, /收蛋|蛋数/);
});

test("v134 模型装配函数不 import / 不调用收蛋模块", () => {
  /* app.js 里 markettable 的 import 只允许 realtimeTableHtml / realtimeTableText */
  const imp = APP.match(/import \{([^}]*)\} from "\.\/js\/core\/markettable\.js"/);
  assert.ok(imp, "找不到 markettable import");
  assert.doesNotMatch(imp[1], /estimateEggs|EGGS_/);
  /* 调用点：realtimeTableHtml 只在 marketHeroHtml，realtimeTableText 只在 marketCopyTable */
  const hero = bodyOf(APP, "marketHeroHtml");
  const copy = bodyOf(APP, "marketCopyTable");
  assert.match(hero, /realtimeTableHtml\(/);
  assert.doesNotMatch(hero, /estimateEggs\(/, "收蛋估算不直接在 app.js 出现");
  assert.match(copy, /realtimeTableText\(/);
  assert.equal((APP.match(/realtimeTableHtml\(/g) || []).length, 1, "HTML 渲染调用点唯一");
  assert.equal((APP.match(/realtimeTableText\(/g) || []).length, 1, "文本快照调用点唯一");
});

test("v134 收蛋落点只在展示：不写 localStorage / 不写 aiText / 不写 LIVE", () => {
  assert.doesNotMatch(MT_CODE, /localStorage|aiText\s*=|sessionStorage/);
  /* 只禁止真实发请求的 API；HTML 文案里写「JSONP 本机直连」是口径说明，不是请求。 */
  assert.doesNotMatch(MT_CODE, /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|\.open\s*\(/, "本模块零网络请求");
  /* 模块返回的对象只供渲染，不含可进 llmSnapItems 的台账字段 */
  const eg = estimateEggs(MARKET, LIVE);
  for (const k of ["name", "nav", "shares", "cost", "prodCode"]) assert.ok(!(k in eg));
  assert.equal(eg.estimateOnly, true);
});

test("v134 收蛋不改信号灯判据：livebond 的 dir / stat 未被本模块引用改值", () => {
  /* 禁止真实赋值（\.dir = / \.bp =），但允许 `c.dir === "none"` 这类比较 ——
     正则里加 [^=] 排除 ===，且只针对剥过注释的代码。 */
  assert.doesNotMatch(MT_CODE, /\.dir\s*=[^=]|\.bp\s*=[^=]/);
  const before = JSON.stringify(LIVE.quotes);
  buildRealtimeRows(LIVE); estimateEggs(MARKET, LIVE); realtimeTableHtml(LIVE, MARKET, {});
  assert.equal(JSON.stringify(LIVE.quotes), before, "渲染不得就地改 LIVE");
  assert.equal(MARKET.weather.cells.length, 33, "渲染不得就地改 MARKET");
});

/* ============================================================
   六、样式与接线
   ============================================================ */
test("v134 index.html 有实时表与收蛋样式，折叠卡片沿用 v130 的 details.card", () => {
  for (const cls of [".rt-wrap", ".rt-tbl", ".rt-egg", ".rt-egg-cap", ".rt-up", ".rt-down", ".rt-none"])
    assert.ok(HTML.includes(cls), `缺样式 ${cls}`);
  assert.match(APP, /<details class="card rt-fold" open/);
  assert.match(APP, /onclick="marketCopyTable\(\)"/);
  assert.match(APP, /marketCopyTable, marketRefreshAll/, "内联入口必须挂 window");
});

test("v134 零回归：既有债市判据与页面锚点未被动过", () => {
  assert.match(APP, /const APP_VER = "v135"/);
  assert.match(APP, /marketPanelHtml\(MARKET/);
  assert.match(APP, /LV\.liveBlockHtml\(LIVE/);
  assert.match(APP, /function marketRefreshAll\(/);
  assert.match(HTML, /债市晴雨表/);
});
