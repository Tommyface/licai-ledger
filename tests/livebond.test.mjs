/* 债市「此刻」层（v116）的测试。跑法：node --test tests/livebond.test.mjs
   ★ 这一层最容易错的是单位：东财 f4 是「百分点」，不是 bp。
     1.5964% 的 10Y 昨天 1.5945%，差 0.0019 个百分点 = 0.19bp，不是 1.9bp。
     方案初稿就在这里写错过一次（写成 +1.9bp），所以下面专门钉一条。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_QUOTES, LIVE_GROUPS, liveQuoteUrl, liveTrendUrl, liveParse, liveDirOf,
  liveTrendParse, liveStat, livePhaseOf, liveValText, liveChgText, liveTimeText,
  liveMissText, liveSparkHtml, liveBlockHtml, livePack, liveUnpack, liveFresh,
  liveKlineUrl, liveKlineParse, liveHistCalc, histPctText, liveHistHtml,
  IDX_HIST_KEYS, HIST_BARS } from "../js/core/livebond.js";

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

/* ---------- v119：指数日 K 与 5 日 / 20 日变化 ---------- */

/** 造一份 kline 返回。行格式与真接口一致：日期,开,收,高,低,量,额,振幅。 */
const KL = rows => ({
  data: {
    code: "000012", name: "国债指数", decimal: 2, dktotal: 5759,
    klines: rows.map(r => `${r.date},${r.open},${r.close},${r.high},${r.low},124480288,125094265800.00,${r.amp}`),
  },
});

/** 连续交易日序列（跳过周末），从 2026-10-01 起。 */
const mkRows = (n, start = 232.0, step = 0.01) => {
  const out = [];
  const d = new Date(2026, 9, 1);
  while (out.length < n) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const close = +(start + out.length * step).toFixed(4);
      out.push({ date: iso, open: close, close, high: close, low: close, amp: 0.01 });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
};
const weekday = d => { const w = new Date(d + "T00:00:00").getDay(); return w > 0 && w < 6; };

test("日K URL：secid 原样、lmt 取 HIST_BARS、带回调名", () => {
  const u = liveKlineUrl("1.000012", "cbX");
  assert.match(u, /secid=1\.000012/);
  assert.match(u, new RegExp("lmt=" + HIST_BARS));
  assert.match(u, /klt=101/, "日 K 必须是 klt=101");
  assert.match(u, /fqt=0/, "指数不复权");
  assert.match(u, /cb=cbX/);
  /* 点号没被编码掉：secid 里的「1.」是市场号，编码成 %2E 接口会认不出 */
  assert.ok(!u.includes("1%2E000012"));
});

test("日K 解析：收盘取第 3 列，不是开盘也不是最低", () => {
  const p = liveKlineParse(KL([
    { date: "2026-11-09", open: 232.44, close: 232.46, high: 232.48, low: 232.38, amp: 0.04 },
    { date: "2026-11-10", open: 232.48, close: 232.41, high: 232.48, low: 232.40, amp: 0.03 },
  ]));
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].date, "2026-11-10");
  assert.equal(p.rows[1].close, 232.41, "开盘是 232.48、最低是 232.40，取错了这两个都会露馅");
});

test("日K 解析：结构不对 / 空收盘 / 坏日期 一律跳过，不整包拒收", () => {
  assert.equal(liveKlineParse(null).ok, false);
  assert.equal(liveKlineParse({ data: {} }).ok, false, "没有 klines 要如实说结构变了");
  const p = liveKlineParse({ data: { klines: [
    "2026-11-09,1,2,3,4,5,6,7",
    "2026-11-10,1,,4,5,6,7,8",      /* 第 3 列（收盘）空 → 跳 */
    "not-a-date,1,2,3,4,5,6,7",     /* 日期坏 → 跳 */
    "2026-11-11,1,2.5,3,4,5,6,7",
    "只有两段,1",
  ] } });
  assert.deepEqual(p.rows.map(r => r.date), ["2026-11-09", "2026-11-11"]);
  assert.equal(p.rows[1].close, 2.5);
});

test("日K 解析：空收盘不许被 Number('') = 0 蒙混过去", () => {
  /* 0 一旦进了分母，5 日变化就变成 Infinity，界面上会显示「涨了无穷多」——
     比「没数据」糟得多。所以空字符串必须在这一步就被挡住。 */
  /* 开=1、收="  "（两个空格）、其余有效 —— Number("  ") 是 0，必须挡住 */
  const p = liveKlineParse({ data: { klines: ["2026-11-10,1,  ,1,1,1,1,1"] } });
  assert.deepEqual(p.rows, []);
  assert.equal(p.ok, false);
});

test("5日/20日：按交易日根数取下标，不是按自然日", () => {
  const rows = mkRows(30, 232.0, 0.02);          /* 每天 +0.02 */
  const h = liveHistCalc(rows, { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.equal(h.n, 30);
  /* 最新 = 232.0 + 29*0.02 = 232.58；5 个交易日前 = 232.0 + 24*0.02 = 232.48 */
  assert.equal(h.latest, 232.58);
  assert.ok(Math.abs(h.d5 - (232.58 / 232.48 - 1) * 100) < 1e-9, "5 日应取第 n-6 根");
  assert.equal(h.from5, rows[24].date, "基准日必须是 5 个交易日之前那一天");
  assert.equal(h.from20, rows[9].date);
});

test("5日/20日：根数不够就给 null，不拿更短的窗口顶替", () => {
  const h5 = liveHistCalc(mkRows(5), { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.equal(h5.d5, null, "只有 5 根时算不出 5 日（需要 6 根）");
  assert.equal(h5.d20, null);
  const h6 = liveHistCalc(mkRows(6), { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.ok(h6.d5 != null, "6 根刚好够算 5 日");
  assert.equal(h6.d20, null);
  const h20 = liveHistCalc(mkRows(20), { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.equal(h20.d20, null, "20 根不够算 20 日（需要 21 根）");
  const h21 = liveHistCalc(mkRows(21), { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.ok(h21.d20 != null, "21 根刚好够算 20 日");
});

test("5日/20日：接口降序返回也能算对（不依赖返回顺序）", () => {
  const asc = mkRows(25, 232.0, 0.02);
  const desc = asc.slice().reverse();
  const a = liveHistCalc(asc, { today: "2026-11-30", liveVal: null, isTrade: weekday });
  const b = liveHistCalc(desc, { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.equal(b.latestDate, a.latestDate);
  assert.ok(Math.abs(b.d5 - a.d5) < 1e-9);
  assert.ok(Math.abs(b.d20 - a.d20) < 1e-9);
});

test("5日/20日：同一天重复给两条不虚增 n", () => {
  const rows = mkRows(10, 232.0, 0.01);
  const dup = rows.concat([{ date: rows[9].date, close: 999 }]);   /* 同日覆盖 */
  const h = liveHistCalc(dup, { today: "2026-11-30", liveVal: null, isTrade: weekday });
  assert.equal(h.n, 10, "10 个交易日 + 1 条重复，n 仍是 10");
  assert.equal(h.latest, 999, "同日两条时后者覆盖前者");
});

test("★ 补今天：日K 还没有当天那根时，用实时点位补上，否则 5 日会少算今天", () => {
  /* 造一个「今天是 11-10 但 K 线只到 11-09」的场景 —— 盘中常态。 */
  const rows = mkRows(26, 232.0, 0.02);
  const lastDate = rows[rows.length - 1].date;
  const today = "2026-12-31";                    /* 远期，确保 > lastDate */
  const noLive = liveHistCalc(rows, { today, liveVal: null, isTrade: () => true });
  assert.equal(noLive.synth, false, "没有实时点位就不补");
  assert.equal(noLive.latestDate, lastDate);

  const liveVal = rows[rows.length - 1].close + 1;   /* 今天涨 1 点 */
  const withLive = liveHistCalc(rows, { today, liveVal, isTrade: () => true });
  assert.equal(withLive.synth, true);
  assert.equal(withLive.latestDate, today, "补的那根日期是今天");
  assert.equal(withLive.latest, liveVal);
  assert.equal(withLive.n, noLive.n + 1);
  /* 5 日必须因为补了今天而变化 —— 这正是「少算一天」那个 bug 的判据 */
  assert.notEqual(withLive.d5, noLive.d5, "补今天之后 5 日变化必须不一样");
});

test("补今天：非交易日不补（此时实时点位就等于上一交易日收盘，补了会重复计数）", () => {
  const rows = mkRows(26, 232.0, 0.02);
  const h = liveHistCalc(rows, { today: "2026-12-31", liveVal: 999, isTrade: () => false });
  assert.equal(h.synth, false);
  assert.ok(h.latest !== 999);
});

test("补今天：K 线已经含今天时不补（否则今天被算两次）", () => {
  const rows = mkRows(26, 232.0, 0.02);
  const today = rows[rows.length - 1].date;
  const h = liveHistCalc(rows, { today, liveVal: rows[rows.length - 1].close + 5, isTrade: () => true });
  assert.equal(h.synth, false, "最后一条已经是今天，不该再追加");
  assert.equal(h.n, 26);
});

test("分母为 0 不给 Infinity（0 点位的指数不存在，但坏数据能造出来）", () => {
  const rows = [{ date: "2026-11-02", close: 0 }, { date: "2026-11-03", close: 0 },
    { date: "2026-11-04", close: 0 }, { date: "2026-11-05", close: 0 },
    { date: "2026-11-06", close: 0 }, { date: "2026-11-09", close: 0 },
    { date: "2026-11-10", close: 232 }];
  const h = liveHistCalc(rows, { today: "2026-11-10", liveVal: null, isTrade: weekday });
  assert.equal(h.d5, null, "基准是 0 时给 null，不是 Infinity");
  assert.equal(h.d1, null);
});

test("histPctText：先舍入再判号，不许出现 -0.00%", () => {
  assert.equal(histPctText(0.116), "+0.12%");
  assert.equal(histPctText(-0.116), "-0.12%");
  assert.equal(histPctText(0), "0.00%");
  /* -0.0004 舍入后是 0：它是「持平」，不是「跌了 0.00%」 */
  assert.equal(histPctText(-0.0004), "0.00%");
  assert.equal(histPctText(0.0004), "0.00%");
  assert.equal(histPctText(null), "");
  assert.equal(histPctText(NaN), "");
});

test("近期一行：颜色跟变化方向走，正数红、负数绿（与指数格子同一套语义）", () => {
  const h = liveHistHtml({ IDX_GZ: { ok: true, d5: 0.12, d20: -0.34, synth: false } }, {});
  assert.match(h, /5日 <i class="lv-up">\+0\.12%<\/i>/);
  assert.match(h, /20日 <i class="lv-down">-0\.34%<\/i>/);
  assert.match(h, /国债指数/);
});

test("近期一行：没有数据就整行不画；有错才画灰字说明", () => {
  assert.equal(liveHistHtml(null, {}), "", "从没取过 → 不画空行");
  assert.equal(liveHistHtml({ IDX_GZ: { ok: false } }, {}), "");
  const e = liveHistHtml(null, { err: "超时" });
  assert.match(e, /这一次没取到：超时/);
});

test("近期一行：补过今天要标出来（两个基准日不同，不标最容易读错）", () => {
  const withSynth = liveHistHtml({ IDX_GZ: { ok: true, d5: 0.12, d20: 0.46, synth: true } }, {});
  assert.match(withSynth, /含今日实时/);
  const noSynth = liveHistHtml({ IDX_GZ: { ok: true, d5: 0.12, d20: 0.46, synth: false } }, {});
  assert.ok(!noSynth.includes("含今日实时"));
});

test("近期一行：一个成功一个失败时，失败的那个要留名，不许悄悄藏掉", () => {
  const h = liveHistHtml({ IDX_GZ: { ok: true, d5: 0.12, d20: 0.46, synth: false },
    IDX_QZ: { ok: false } }, { err: "企债指数未取到" });
  assert.match(h, /国债指数/);
  assert.match(h, /企债指数未取到/);
});

test("近期一行：接进整块后紧跟在指数格子下面，不在块末", () => {
  const h = liveBlockHtml({ quotes: liveParse(RAW).quotes, miss: [], trend: [], at: Date.now() },
    { hist: { IDX_GZ: { ok: true, d5: 0.12, d20: 0.46, synth: false } } });
  const iHist = h.indexOf("lv-hist");
  const iRate = h.indexOf("国债收益率");
  assert.ok(iHist > 0 && iRate > 0);
  assert.ok(iHist < iRate, "「近期」应贴在指数分组下，排在利率分组之前");
});

test("近期一行：只在指数分组里画一次（别四个分组各画一遍）", () => {
  const h = liveBlockHtml({ quotes: liveParse(RAW).quotes, miss: [], trend: [], at: Date.now() },
    { hist: { IDX_GZ: { ok: true, d5: 0.12, d20: 0.46, synth: false } } });
  assert.equal((h.match(/class="lv-hist"/g) || []).length, 1);
});

test("清单：只有两个指数做近期变化，收益率不重复算（矩阵里已有 bp5d）", () => {
  assert.deepEqual(IDX_HIST_KEYS, ["IDX_GZ", "IDX_QZ"]);
  for (const k of IDX_HIST_KEYS) {
    const q = LIVE_QUOTES.find(x => x.key === k);
    assert.equal(q.kind, "index", k + " 必须是 index 类");
  }
});
