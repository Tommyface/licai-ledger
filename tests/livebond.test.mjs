/* 债市「此刻」层（v116）的测试。跑法：node --test tests/livebond.test.mjs
   ★ 这一层最容易错的是单位：东财 f4 是「百分点」，不是 bp。
     1.5964% 的 10Y 昨天 1.5945%，差 0.0019 个百分点 = 0.19bp，不是 1.9bp。
     方案初稿就在这里写错过一次（写成 +1.9bp），所以下面专门钉一条。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_QUOTES, LIVE_GROUPS, liveQuoteUrl, liveTrendUrl, liveParse, liveDirOf,
  liveTrendParse, liveStat, livePhaseOf, liveValText, liveChgText, liveTimeText,
  liveMissText, liveSparkHtml, liveBlockHtml, livePack, liveUnpack, liveFresh } from "../js/core/livebond.js";

/** 实测返回（2026-11-10 11:26，fltt=2 口径）。 */
const RAW = {
  data: {
    total: 12,
    diff: [
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
      /* v118 新增两项交易所指数：f2 是点位、f3 是涨跌幅、f4 是涨跌「点」——
         与期货同构，绝不能把 f4 乘 100 当 bp（232.41 点的指数不存在 bp 这回事）。 */
      { f2: 232.41, f3: -0.02, f4: -0.05, f12: "000012", f14: "国债指数" },
      { f2: 311.24, f3: 0.0, f4: 0.0, f12: "000013", f14: "企债指数" },
    ],
  },
};
/** 「晴天」夹具：长端下行、期货上涨。 */
const RAW_UP = JSON.parse(JSON.stringify(RAW));
RAW_UP.data.diff[0].f4 = -0.0019;   /* CN10Y -0.19bp */
RAW_UP.data.diff[5].f3 = 0.12;      /* T 涨 0.12% */

const at = (h, mi, s = 0) => new Date(2026, 10, 10, h, mi, s);   /* 本地时间，跨 TZ 一致 */
const always = () => true;
const never = () => false;

test("清单：12 项、四组，secid 不重复", () => {
  assert.equal(LIVE_QUOTES.length, 12);
  assert.equal(new Set(LIVE_QUOTES.map(q => q.secid)).size, 12);
  const keys = LIVE_GROUPS.flatMap(g => g.keys);
  assert.deepEqual(keys.slice().sort(), LIVE_QUOTES.map(q => q.key).sort());
  for (const g of LIVE_GROUPS) assert.ok(g.keys.length >= 2, `${g.id} 组太短`);
});

test("URL：报价一个请求带全 12 个 secid，且带回调名", () => {
  const u = liveQuoteUrl("__cb1");
  assert.match(u, /^https:\/\/push2\.eastmoney\.com\/api\/qt\/ulist\.np\/get\?/);
  assert.match(u, /cb=__cb1/);
  for (const q of LIVE_QUOTES) assert.ok(u.includes(q.secid), `URL 缺 ${q.secid}`);
  assert.equal(u.split("secids=")[1].split("&")[0].split(",").length, 12);
});

test("URL：分时走 push2his，取 T 主力", () => {
  const u = liveTrendUrl("__cb2");
  assert.match(u, /push2his\.eastmoney\.com/);
  assert.match(u, /secid=8\.110130/);
  assert.match(u, /cb=__cb2/);
});

test("解析：12 项全拿到，ok=true、miss 为空", () => {
  const p = liveParse(RAW);
  assert.equal(p.ok, true, p.why);
  assert.equal(Object.keys(p.quotes).length, 12);
  assert.deepEqual(p.miss, []);
});

test("★ 单位：f4 是百分点，bp = f4×100（10Y 是 +0.19bp，不是 +1.9bp）", () => {
  const q = liveParse(RAW).quotes.CN10Y;
  assert.equal(q.val, 1.5964);
  assert.equal(q.bp, 0.19, "0.0019 个百分点 = 0.19bp");
  assert.equal(q.dir, "down", "收益率上行 = 绿");
});

test("单位：5 年 +5.1bp、30 年 +0.63bp、GC007 +1.5bp", () => {
  const q = liveParse(RAW).quotes;
  assert.equal(q.CN5Y.bp, 5.1);
  assert.equal(q.CN30Y.bp, 0.63);
  assert.equal(q.GC007.bp, 1.5);
});

test("期货：用相对涨跌幅，不产 bp；价格按 3 位小数归一", () => {
  const q = liveParse(RAW).quotes;
  assert.equal(q.T.bp, null, "期货不该有 bp");
  assert.equal(q.T.pct, -0.04);
  assert.equal(q.TL.val, 118.49);
  assert.equal(liveValText(q.T), "110.190", "国债期货报价习惯 3 位");
  assert.equal(liveChgText(q.T), "-0.04%");
});

test("收益率格式化：4 位小数 + bp 1 位", () => {
  const q = liveParse(RAW).quotes.CN10Y;
  assert.equal(liveValText(q), "1.5964");
  assert.equal(liveChgText(q), "+0.2bp");
});

test("方向：收益率下行算红（up），上行算绿（down），持平算白", () => {
  assert.equal(liveDirOf("yield", -1), "up");
  assert.equal(liveDirOf("yield", 1), "down");
  assert.equal(liveDirOf("yield", 0), "flat");
  assert.equal(liveDirOf("price", 0.5), "up");
  assert.equal(liveDirOf("price", -0.5), "down");
  assert.equal(liveDirOf("repo", 2), "down", "回购利率上行 = 资金收紧 = 绿");
  assert.equal(liveDirOf("repo", -2), "up");
  assert.equal(liveDirOf("yield", null), "none");
});

test("晴天夹具：长端红、期货红，统计里出现 up", () => {
  const p = liveParse(RAW_UP);
  assert.equal(p.quotes.CN10Y.dir, "up");
  assert.equal(p.quotes.T.dir, "up");
  const st = liveStat({ quotes: p.quotes, miss: p.miss });
  assert.ok(st.up >= 2, `应有至少 2 项红，实际 ${st.up}`);
});

test("缺项：少一项只让那一项进 miss，其余照收（不整包拒收）", () => {
  const cut = JSON.parse(JSON.stringify(RAW));
  cut.data.diff = cut.data.diff.filter(x => x.f12 !== "204007");
  const p = liveParse(cut);
  assert.equal(p.ok, true);
  assert.equal(Object.keys(p.quotes).length, 11);
  assert.deepEqual(p.miss, ["GC007"]);
  assert.equal(liveMissText({ miss: p.miss }), "缺 GC007");
});

test("停牌/未开盘：f2 是字符串「-」→ 进 miss，绝不填 0", () => {
  const cut = JSON.parse(JSON.stringify(RAW));
  cut.data.diff[0].f2 = "-";
  const p = liveParse(cut);
  assert.equal(p.quotes.CN10Y, undefined);
  assert.ok(p.miss.includes("CN10Y"));
  assert.equal(p.ok, true, "其余 9 项还在，不该整包失败");
});

test("结构坏了：data 缺失 / diff 非数组 → ok=false，且给出原因", () => {
  assert.equal(liveParse(null).ok, false);
  assert.match(liveParse(null).why, /data\.diff/);
  assert.equal(liveParse({ data: { diff: {} } }).ok, false);
  assert.equal(liveParse({ data: { diff: [] } }).ok, false);
  assert.match(liveParse({ data: { diff: [] } }).why, /一项都没解析出来/);
});

test("统计：miss 计入 none，不计入 flat（白是「真的持平」）", () => {
  const p = liveParse(RAW);
  const st = liveStat({ quotes: p.quotes, miss: ["GC007", "GC001"] });
  assert.equal(st.none, 2);
  assert.equal(st.up + st.down + st.flat, 12);
});

test("分时：逐分钟解析成 [hh:mm, price]，坏点跳过", () => {
  const j = { data: { trends: [
    "2026-11-10 09:30,110.200,254",
    "2026-11-10 09:31,110.185,3691",
    "坏行",
    "2026-11-10 09:32,abc,1",
    "2026-11-10 09:33,110.195,1273",
  ] } };
  const t = liveTrendParse(j);
  assert.equal(t.ok, true);
  assert.equal(t.pts.length, 3);
  assert.deepEqual(t.pts[0], ["09:30", 110.2]);
  assert.deepEqual(t.pts[2], ["09:33", 110.195]);
});

test("分时：缺 data.trends → ok=false，不抛", () => {
  assert.equal(liveTrendParse(null).ok, false);
  assert.equal(liveTrendParse({}).ok, false);
});

test("时点：09:30 前未开盘、上午盘中、午休、下午盘中、期货收盘、收盘后", () => {
  assert.equal(livePhaseOf(at(9, 0), always).id, "preopen");
  assert.equal(livePhaseOf(at(10, 0), always).id, "intraday");
  assert.equal(livePhaseOf(at(12, 0), always).id, "lunch");
  assert.equal(livePhaseOf(at(14, 0), always).id, "intraday");
  assert.equal(livePhaseOf(at(15, 30), always).id, "futures_closed");
  assert.match(livePhaseOf(at(15, 30), always).label, /期货已收盘/);
  assert.equal(livePhaseOf(at(18, 0), always).id, "closed");
});

test("时点：非交易日一律 holiday，不按钟点判", () => {
  assert.equal(livePhaseOf(at(10, 0), never).id, "holiday");
  assert.equal(livePhaseOf(at(10, 0), never).label, "今日休市");
});

test("时点：日历函数抛错时按交易日处理（不因日历坏了就不显示）", () => {
  const boom = () => { throw new Error("calendar"); };
  assert.equal(livePhaseOf(at(10, 0), boom).id, "intraday");
});

test("时点文案：HH:MM:SS，补零", () => {
  assert.equal(liveTimeText({ at: at(9, 5, 7).getTime() }), "09:05:07");
  assert.equal(liveTimeText({ at: 0 }, at(15, 2, 3)), "15:02:03", "没取过就用传进来的 now");
});

test("折线：少于 2 个点不画（一个点连不成线）", () => {
  assert.equal(liveSparkHtml([]), "");
  assert.equal(liveSparkHtml([["09:30", 110.2]]), "");
  const h = liveSparkHtml([["09:30", 110.2], ["09:31", 110.3]]);
  assert.match(h, /<svg/);
  assert.match(h, /polyline/);
  assert.match(h, /lv-sp-up/, "收涨用红");
});

test("缓存：pack → unpack 往返一致", () => {
  const p = liveParse(RAW);
  const packed = livePack({ quotes: p.quotes, miss: p.miss, trend: [["09:30", 110.2], ["09:31", 110.3]] }, 1794279605000);
  assert.equal(packed.v, 2);
  assert.equal(packed.src, "eastmoney");
  const back = liveUnpack(JSON.parse(JSON.stringify(packed)));
  assert.ok(back);
  assert.equal(back.quotes.CN10Y.bp, 0.19);
  assert.equal(back.quotes.CN10Y.dir, "down");
  assert.equal(back.trend.length, 2);
});

test("缓存：版本/来源不符 → null（旧缓存直接作废，不迁移）", () => {
  const p = liveParse(RAW);
  const packed = livePack({ quotes: p.quotes, miss: [], trend: [] }, 1);
  assert.equal(liveUnpack({ ...packed, v: 0 }), null);
  assert.equal(liveUnpack({ ...packed, src: "sina" }), null);
  assert.equal(liveUnpack(null), null);
  assert.equal(liveUnpack({ v: 1, src: "eastmoney", quotes: {} }), null);
});

test("缓存：localStorage 被改过也不许改方向（dir 重算，不照抄）", () => {
  const p = liveParse(RAW);
  const packed = livePack({ quotes: p.quotes, miss: [], trend: [] }, 1);
  /* 把绿改成红，同时把名称改成乱码 */
  packed.quotes.CN10Y.dir = "up";
  packed.quotes.CN10Y.name = "被改过的名字";
  packed.quotes.CN10Y.kind = "price";
  const back = liveUnpack(packed);
  assert.equal(back.quotes.CN10Y.dir, "down", "方向必须按 bp 重算");
  assert.equal(back.quotes.CN10Y.name, "10年国债", "名称取本地清单，不认缓存");
  assert.equal(back.quotes.CN10Y.kind, "yield");
  assert.equal(back.quotes.CN10Y.bp, 0.19);
});

test("整块：没取过时给「还没取过」，不画空格子", () => {
  const h = liveBlockHtml(null, { phase: { id: "intraday", label: "盘中" } });
  assert.match(h, /还没取过此刻行情/);
  assert.doesNotMatch(h, /lv-grid/, "没有数据就不该有格子");
});

test("整块：有数据时渲染 12 格、统计行、口径说明", () => {
  const p = liveParse(RAW);
  const h = liveBlockHtml({ quotes: p.quotes, miss: [], trend: [["09:30", 110.2], ["09:31", 110.3]], at: Date.now() },
    { phase: { id: "intraday", label: "盘中" } });
  assert.equal((h.match(/class="lv-i /g) || []).length, 12);
  assert.match(h, /10年国债/);
  assert.match(h, /盘中/);
  assert.match(h, /东方财富行情/, "来源要写在块里");
  assert.match(h, /不是银行间 DR007/, "必须写明回购口径");
  assert.match(h, /不做差、不互补/);
});

test("整块：失败原因写进块里（不只靠 toast）", () => {
  const h = liveBlockHtml(null, { err: "超时（8 秒）" });
  assert.match(h, /这一次没取到/);
  assert.match(h, /超时/);
});

/* ---------- v117：新鲜度闸门 ---------- */

test("liveFresh：跨日就不算「此刻」—— 昨天的收盘价不能当今天盘中", () => {
  const at = new Date("2026-11-09T14:00:00").getTime();
  const same = new Date("2026-11-09T14:30:00").getTime();
  const nextDay = new Date("2026-11-10T09:40:00").getTime();
  assert.equal(liveFresh({ at }, same), true);
  assert.equal(liveFresh({ at }, nextDay), false);
});

test("liveFresh：超过 90 分钟不算 —— 午休跨过去口径就换了一场", () => {
  const at = new Date("2026-11-09T11:20:00").getTime();
  const ok89 = at + 89 * 60 * 1000;
  const bad91 = at + 91 * 60 * 1000;
  assert.equal(liveFresh({ at }, ok89), true);
  assert.equal(liveFresh({ at }, bad91), false);
  /* 边界要写成 <=，不是 <：正好 90 分钟还在界内，不然每次都要猜「刚刚那次算不算」 */
  assert.equal(liveFresh({ at }, at + 90 * 60 * 1000), true, "90 分钟整应算新鲜");
});

test("liveFresh：没有时点、时点在未来、时点非法，一律当不新鲜", () => {
  const now = new Date("2026-11-09T14:00:00").getTime();
  assert.equal(liveFresh(null, now), false);
  assert.equal(liveFresh({}, now), false);
  assert.equal(liveFresh({ at: 0 }, now), false);
  assert.equal(liveFresh({ at: "abc" }, now), false);
  assert.equal(liveFresh({ at: now + 60 * 1000 }, now), false, "未来时刻说明时钟不对，不能信");
});

/* ---------- v118：交易所债券指数 ---------- */

test("指数：点位 2 位小数、不产 bp、方向跟当日涨跌幅走", () => {
  const q = liveParse(RAW).quotes;
  assert.equal(q.IDX_GZ.val, 232.41, "点位保留 2 位");
  assert.equal(q.IDX_GZ.bp, null, "指数没有 bp —— f4 是「点」，不是百分点");
  assert.equal(q.IDX_GZ.pct, -0.02);
  assert.equal(q.IDX_GZ.dir, "down", "指数跌 = 绿，与期货同一套颜色语义");
  assert.equal(liveValText(q.IDX_GZ), "232.41");
  assert.equal(liveChgText(q.IDX_GZ), "-0.02%");
});

test("指数：单位不带 %（点位不是百分比），期货也不带", () => {
  const h = liveBlockHtml({ quotes: liveParse(RAW).quotes, miss: [], trend: [], at: Date.now() }, {});
  /* 指数格子里不该出现「232.41%」这种写法 */
  assert.match(h, /232\.41<\/div>/);
  assert.ok(!/232\.41<[^>]*>%/.test(h), "指数点位后面不许跟 %");
  /* 收益率那几格仍然要带 %（<i>%</i> 是那个小号单位标记） */
  assert.match(h, /1\.5964<i>%<\/i><\/div>/);
});

test("指数：涨跌为 0 是「白·持平」，不是「蓝·暂无」——两者含义完全相反", () => {
  const q = liveParse(RAW).quotes.IDX_QZ;
  assert.equal(q.val, 311.24);
  assert.equal(q.dir, "flat");
  assert.equal(liveDirOf("index", 0), "flat");
  assert.equal(liveDirOf("index", null), "none");
});

test("指数：分组排在最前（先看整体涨跌，再看期限结构）", () => {
  assert.equal(LIVE_GROUPS[0].id, "index");
  assert.deepEqual(LIVE_GROUPS[0].keys, ["IDX_GZ", "IDX_QZ"]);
  assert.match(LIVE_GROUPS[0].title, /上证口径/, "标题必须写出交易所口径");
});

test("指数：块底说明要讲清「不是中债估值指数」", () => {
  const h = liveBlockHtml({ quotes: liveParse(RAW).quotes, miss: [], trend: [], at: Date.now() }, {});
  assert.match(h, /上证口径/);
  assert.match(h, /不是中债估值指数/);
});
