// @ts-check
/* 研报事实层（v112 · report-1）的测试。跑法：node --test tests/report.test.mjs
   这一层是「研报里所有数字的来源」，错一个数字，模型就会把错的那个写进结论里，
   而屏幕上没有任何东西能看出来。所以每一条都要钉住。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPORT_SESSION_LABEL, reportSession, reportNavFacts, reportMarketFacts,
  reportPortfolioRows, reportWatch, reportFactsText, reportTableHtml,
  reportCoordsHtml, reportNumberAudit, navSummary,
  reportScenarios, scenarioHtml, reportCalHtml,
  /* v125：信息面三路纯函数 */
  reportNewsFacts, reportFundingFacts, reportSearchFacts,
} from "../js/domain/report.js";
import { pubCalNext } from "../js/domain/pubcal.js";
import { parseReport, reportCardHtml, reportNarrativeHtml, reportSummaryText,
  REPORT_INSTRUCTIONS, REPORT_PROMPT_VER } from "../js/domain/brief.js";

/* ---------- 夹具 ---------- */

const p2 = n => String(n).padStart(2, "0");
const fmt = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
function bus(from, n) {
  const out = [];
  const d = new Date(from + "T12:00:00");
  while (out.length < n) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) out.push(fmt(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * 23 个披露点：前 18 天每天 +1.2bp，然后 −4.86、−11.52、+7.90、+2.65。
 * 这条曲线的形状与真机样本（诚享7天29号 10-22 到 10-28）同构：
 * 一个前高、一次事件级下跌、两天修复。数字是算准的，断言才敢写死。
 */
function mkSeries() {
  const days = bus("2026-09-28", 23);
  const bps = [];
  for (let i = 0; i < 18; i++) bps.push(1.2);
  bps.push(-4.86, -11.52, 7.90, 2.65);
  let v = 1.010000;
  /** @type {Array<[string, number]>} */
  const s = [[days[0], v]];
  for (let i = 0; i < bps.length; i++) {
    v = v * (1 + bps[i] / 10000);
    s.push([days[i + 1], Math.round(v * 1e6) / 1e6]);
  }
  return s;
}
const SERIES = mkSeries();
const NAV = reportNavFacts(SERIES, { today: "2026-11-02" });

function cell(issuer, tenor, y, bp, group) {
  return { group: group || "rate", issuer, tenor, dir: bp < 0 ? "up" : bp > 0 ? "down" : "flat",
    basis: { yieldPct: y, prevYieldPct: y - bp / 100, bp1d: bp } };
}
const MKT = {
  meta: { verified: true, gaps: [], capturedAt: "2026-10-30T17:20:00+08:00" },
  weather: {
    asOf: "2026-10-30", prevDate: "2026-10-29",
    cells: [
      cell("国债", "1年", 1.1683, -0.3), cell("国债", "3年", 1.2291, -1.1),
      cell("国债", "5年", 1.3115, -1.2), cell("国债", "7年", 1.3996, -1.6),
      cell("国债", "10年", 1.5868, -1.7),
      cell("AAA", "3年", 1.5821, -1.0, "credit"), cell("AAA", "5年", 1.6428, -1.2, "credit"),
    ],
  },
  bpTable: [
    { issuer: "国债", tenor: "2年", yieldPct: 1.2155, bp: { "1日": [-0.6, "2026-10-29"], "5日": [-3.0, "2026-10-23"], "20日": [-5.2, "2026-10-02"] } },
    { issuer: "国债", tenor: "5年", yieldPct: 1.3115, bp: { "1日": [-1.2, "2026-10-29"], "5日": [-4.2, "2026-10-23"], "20日": [-9.5, "2026-10-02"] } },
    { issuer: "国债", tenor: "10年", yieldPct: 1.5868, bp: { "1日": [-1.7, "2026-10-29"], "5日": [-6.3, "2026-10-23"], "20日": [-9.8, "2026-10-02"] } },
    { issuer: "国债", tenor: "30年", yieldPct: 2.0275, bp: { "1日": [-1.5, "2026-10-29"], "5日": [-5.5, "2026-10-23"], "20日": [-6.0, "2026-10-02"] } },
  ],
};
const MK = reportMarketFacts(MKT, "2026-11-02");

/* ---------- 时点 ---------- */

test("时点：盘前 / 盘中 / 盘后 / 休市，按点按钮的那一刻分", () => {
  const at = (iso, td) => reportSession(new Date(iso).getTime(), td);
  assert.equal(at("2026-11-09T08:30:00", "2026-11-09").key, "preopen");
  assert.equal(at("2026-11-09T10:00:00", "2026-11-09").key, "intraday");
  assert.equal(at("2026-11-09T21:21:00", "2026-11-09").key, "afterclose");
  assert.equal(at("2026-11-14T10:00:00", "2026-11-14").key, "closed", "周六不是交易日");
});

test("时点边界：09:00 整算盘中，15:30 整算盘后", () => {
  const at = (iso) => reportSession(new Date(iso).getTime(), "2026-11-09").key;
  assert.equal(at("2026-11-09T08:59:00"), "preopen");
  assert.equal(at("2026-11-09T09:00:00"), "intraday");
  assert.equal(at("2026-11-09T15:29:00"), "intraday");
  assert.equal(at("2026-11-09T15:30:00"), "afterclose");
});

test("时点：盘中路线必须自带「没有实时行情」这句任务书", () => {
  /* 本机的中债曲线是日频收盘发布。盘中路线最危险的地方不是数据旧，
     是模型会把「上一交易日收盘」写成「今天上午」。所以这句必须写进 focus。 */
  const s = reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09");
  assert.match(s.focus, /本轮没取到盘中行情|还没有任何成交数据/);
  assert.equal(REPORT_SESSION_LABEL[s.key], "盘中");
});

test("时点：盘后但今天曲线还没发布时，不许说「讲今天收盘」", () => {
  /* 中债曲线一般 17:00 后才发布。21 点打开时最新一条往往是上一交易日的，
     这时候让模型「讲今天收盘」，它就只能编。 */
  const old = reportSession(new Date("2026-11-09T21:21:00").getTime(), "2026-11-09", "2026-11-06");
  assert.match(old.focus, /今天的收盘曲线还没发布/);
  assert.match(old.focus, /11-06/);
  assert.equal(old.fresh, false);
  const now = reportSession(new Date("2026-11-09T21:21:00").getTime(), "2026-11-09", "2026-11-09");
  assert.match(now.focus, /先讲今天收盘/);
  assert.equal(now.fresh, true);
});

test("时点：休市路线的重心是「最近一个交易日 + 下一个交易日」", () => {
  const s = reportSession(new Date("2026-11-14T10:00:00").getTime(), "2026-11-14");
  assert.match(s.focus, /最近一个交易日/);
  assert.match(s.focus, /下一个交易日/);
  assert.equal(s.tradeDay, false);
});

/* ---------- 净值事实 ---------- */

test("净值：样本点、最新值、前高与距前高", () => {
  assert.equal(NAV.ok, true);
  assert.equal(NAV.n, 23);
  assert.equal(NAV.last.date, "2026-10-28");
  assert.equal(NAV.peak.date, "2026-10-22");
  assert.ok(Math.abs(NAV.gapBp - 5.84) < 0.01, "距前高应是 5.84bp，实际 " + NAV.gapBp);
});

test("净值：最大回撤带区间，不是光一个百分数", () => {
  assert.ok(Math.abs(NAV.dd.pct - (-0.1638)) < 0.001);
  assert.equal(NAV.dd.from, "2026-10-22");
  assert.equal(NAV.dd.to, "2026-10-26");
});

test("净值：事件冲击与「收回几成」", () => {
  assert.equal(NAV.shock.date, "2026-10-26");
  assert.ok(Math.abs(NAV.shock.bp - (-11.52)) < 0.01);
  assert.equal(NAV.shock.days, 2);
  assert.ok(Math.abs(NAV.shock.ratio * 100 - 91.5) < 0.2, "收回比例应约 91.5%，实际 " + (NAV.shock.ratio * 100));
});

test("净值：样本不足 20 个点时不报 σ 倍数", () => {
  /* 12 个点里 4 个极端值，σ 会被那几个点主导，算出来的「2.4 倍」看着有、其实没意义。 */
  const short = reportNavFacts(SERIES.slice(-12), { today: "2026-11-02" });
  assert.equal(short.sigmaBp, 0);
  assert.equal(short.shock.sigma, 0);
  assert.ok(navSummary(short).indexOf("倍") < 0, "没有 σ 就不许写「X 倍」");
});

test("净值：常态日收益直接取中位数，不做剔除", () => {
  /* 23 个点里 18 个 +1.2、4 个极端，中位数应落在 1.2 附近。 */
  assert.ok(Math.abs(NAV.normalBp - 1.2) < 0.05, "实际 " + NAV.normalBp);
});

test("净值：两个口径的「还要几个披露点」都给，不合并", () => {
  assert.equal(NAV.etaNormal, 5);
  assert.equal(NAV.etaFast, 1);
  assert.ok(navSummary(NAV).indexOf("按常态日收益") > 0);
});

test("净值：日更产品缺的交易日要点名，今天不算", () => {
  assert.equal(NAV.cadence, "daily");
  assert.deepEqual(NAV.missing, ["2026-10-29", "2026-10-30"]);
});

test("净值：周更产品不许报「缺 4 个披露点」", () => {
  /* 误报比不报更糟：用户会以为产品出问题了。 */
  const weekly = SERIES.filter((_, i) => i % 5 === 0 || i === SERIES.length - 1);
  const f = reportNavFacts(weekly, { today: "2026-11-02" });
  assert.equal(f.cadence, "weekly");
  assert.deepEqual(f.missing, []);
});

test("净值：不足 2 个点返回 ok:false，不硬算", () => {
  assert.equal(reportNavFacts([["2026-10-01", 1.01]], {}).ok, false);
  assert.equal(reportNavFacts([], {}).ok, false);
  assert.equal(reportNavFacts(null, {}).ok, false);
});

test("净值：脏数据被丢掉，不参与计算", () => {
  const s = SERIES.slice(0, 5).concat([["bad", 1], ["2026-10-09", 0], ["2026-10-10", NaN]]);
  const f = reportNavFacts(s, {});
  assert.equal(f.n, 5, "三个脏点应当被过滤掉");
});

/* ---------- 债市事实 ---------- */

test("债市：四个关键期限带 5/20 日，方向能算出来", () => {
  assert.equal(MK.ok, true);
  assert.equal(MK.rows.length, 4);
  assert.equal(MK.allDown, true, "全期限下行要能算出来，而不是让模型看图说话");
  assert.ok(Math.abs(MK.rows[2].bp20 + 9.8) < 0.01);
});

test("债市：快照落后几个交易日是算出来的", () => {
  assert.equal(MK.asOf, "2026-10-30");
  assert.equal(MK.lagTradeDays, 1, "10-30 到 11-02 之间只有一个交易日");
});

test("债市：未核验 / 无格子一律 ok:false，不返回空表", () => {
  assert.equal(reportMarketFacts({ meta: { verified: false }, weather: { cells: [] } }, "").ok, false);
  assert.equal(reportMarketFacts({ meta: { verified: true }, weather: { cells: [] } }, "").ok, false);
  assert.equal(reportMarketFacts(null, "").ok, false);
});

/* ---------- 观察项 ---------- */

test("观察项：缺披露 + 快照滞后，各一条", () => {
  const w = reportWatch(NAV, MK, reportSession(0, "2026-11-02"));
  const text = w.map(x => x.text).join("｜");
  assert.match(text, /净值缺 2 个披露点/);
  assert.match(text, /落后 1 个交易日/);
});

test("观察项：组合层要挑出「净值掉队」的那几只", () => {
  /* 组合层没有单只序列，但「最新净值日是哪天」照样要看：一只掉队，整张表的结论就跟着旧。 */
  const rows = [
    { name: "A", navDate: "2026-10-30" },
    { name: "B", navDate: "2026-10-26" },
    { name: "C", navDate: "2026-10-26" },
  ];
  const w = reportWatch(null, MK, reportSession(0, "2026-11-02"), { rows, today: "2026-11-02" });
  const text = w.map(x => x.text).join("｜");
  /* v114 起从「有 2 只」改成点名：只说数量，用户还得自己一行行找是哪两只。 */
  assert.match(text, /有 2 只的净值落后 2 个交易日以上/);
  assert.match(text, /B（10-26）/);
  assert.match(text, /C（10-26）/);
});

test("坐标：组合层给「最新 + 最早」，只给最新会让人以为整套都到那天了", () => {
  const h = reportCoordsHtml({ session: reportSession(0, "2026-11-02"),
    nav: null, market: MK, rows: [{ navDate: "2026-10-30" }, { navDate: "2026-10-26" }] });
  assert.match(h, /净值 10-30（最早 10-26）/);
});

test("观察项：债市缺失时说「本轮没有」，不说「数据暂缺」", () => {
  const w = reportWatch(NAV, { ok: false }, reportSession(0, "2026-11-02"));
  assert.match(w.map(x => x.text).join("｜"), /本轮没有可用的债市快照/);
});

/* ---------- 请求装配 ---------- */

test("请求：含时点、测算、缺口，且不超过 1000 字", () => {
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T21:21:00").getTime(), "2026-11-09"),
    kind: "product", name: "诚享7天29号", inst: "北银理财", nav: NAV, market: MK,
    gaps: ["资金面：没有 DR001 / DR007", "国债期货"],
  });
  assert.match(txt, /【时点】11-09 21:21（周一 · 盘后）/);
  assert.match(txt, /【叙述重心】/);
  assert.match(txt, /距前高 5\.8bp/);
  assert.match(txt, /按常态需 5 个披露点/);
  assert.match(txt, /【拿不到的数据】资金面/);
  assert.ok(txt.length <= 1100, "研报输入超长了：" + txt.length);
});

test("请求：没有盘中数据时，必须说清「本轮没取到」而不是「本机没有」", () => {
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09"),
    kind: "product", name: "X", nav: NAV, market: MK, gaps: [],
  });
  /* v117：原来这句是「本机没有实时行情」—— v116 之后不成立了。
     本机有此刻层，只是这一轮没取到；两句的差别不是措辞，是「能不能修」。 */
  assert.match(txt, /本轮没取到盘中行情/);
  assert.ok(!/本机没有实时行情/.test(txt), "过期的断言又回来了：本机是有实时行情的");
});

/* ---------- v117：盘中参考层 ---------- */

/* 一份与真机同形的盘中夹具：8 项（BRIEF_LIVE_KEYS 全量）。
   ★ 这里原来只有 2 项，于是「事实层不许超长」那条测试算出来的长度比真机短两百多字，
     阈值形同虚设 —— 夹具不反映真实场景，守护就是假的。 */
const LIVE_FIX = {
  atText: "13:31", phaseLabel: "盘中", srcText: "东方财富行情", missText: "",
  items: [
    /* v119 起指数还带 5日/20日 —— 夹具不补这两项，额度测试就还是比真机短一截 */
    { name: "国债指数", valText: "232.41", chgText: "-0.03%", histText: "5日 +0.12%、20日 +0.46%" },
    { name: "企债指数", valText: "311.24", chgText: "0.00%", histText: "5日 +0.05%、20日 +0.24%" },
    { name: "10年国债", valText: "1.5983%", chgText: "+0.4bp" },
    { name: "30年国债", valText: "2.0549%", chgText: "+0.8bp" },
    { name: "5年国债", valText: "1.3610%", chgText: "+5.0bp" },
    { name: "T 主力", valText: "110.155", chgText: "-0.07%" },
    { name: "TL 主力", valText: "118.410", chgText: "-0.24%" },
    { name: "GC007", valText: "1.340%", chgText: "-0.6bp" },
  ],
};

test("v117 盘中：独立成段，且写明「不与中债估值混算」", () => {
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "", "13:31"),
    kind: "product", name: "X", nav: NAV, market: MK, gaps: [], live: LIVE_FIX,
  });
  assert.match(txt, /【盘中参考】东方财富行情 13:31（盘中）/);
  assert.match(txt, /10年国债 1\.5983%（\+0\.4bp）/);
  assert.match(txt, /不与上段加减比/);
  assert.match(txt, /引用须带「截至13:31」/);
});

test("v117 盘中：叙述重心跟着改口 —— 有数据就不许再说「数据块里没有」", () => {
  const withLive = reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "", "13:31");
  const noLive = reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "");
  assert.match(withLive.focus, /有盘中参考价（截至 13:31/);
  assert.ok(!/数据块里没有/.test(withLive.focus), "有数据还叫模型写「没有」，它就会照做");
  assert.match(noLive.focus, /本轮没取到盘中行情/);
  assert.match(noLive.focus, /数据块里没有/);
});

test("v117 盘中：盘中说明只覆盖三类，不冒充全市场", () => {
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "", "13:31"),
    kind: "product", name: "X", nav: NAV, market: MK, gaps: [], live: LIVE_FIX,
  });
  assert.match(txt, /盘口仅三类/);
  assert.match(txt, /国开、信用债等仍为上一交易日收盘/);
});

test("v118 事实层总额度：单只 + 盘中 8 项 + 利差 + 宏观，不许超 1600", () => {
  /* 额度是怎么算出来的（改之前先看这两个数）：
       真机实测（2026-11-10，market.json 33 格全量 + 8 项盘中 + 宏观）  1535
       本文件夹具（信用曲线只有 AAA 3/5 两年，利差只算得出 2 条）        ~1490
     取 1600 = 真机 1535 + 65 字余量。
     原额度 1100 是 v117 的口径（那时还没有利差与宏观）。加了两个真实信息段，
     额度必须跟着涨；但涨要涨得有名目 —— 所以另有三条段落级额度
     （利差 ≤165 / 宏观 ≤130），下一次往这两段里加东西，要么在额度内加，
     要么显式改这三条。单纯把总额度调大而不动段落额度的改动，一律视为逃逸。 */
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "", "13:31"),
    kind: "product", name: "诚享7天29号", inst: "北银理财", nav: NAV, market: MK,
    gaps: ["资金面：没有 DR001 / DR007", "国债期货"], live: LIVE_FIX,
  });
  assert.ok(txt.length <= 1600, "事实层超长了：" + txt.length);
});

test("v118 段落额度：利差段不超 165 字（它是一张 5 行的表，不该长过正文）", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: MK,
    gaps: [], today: "2026-11-09",
  });
  const seg = txt.split("\n").filter(l => l.includes("中票利差") || /^\s+(AAA|AA)/.test(l) || l.includes("括号内为较前一日"));
  assert.ok(seg.length >= 3, "利差段应有标题 + 数据行 + 读法三行");
  const len = seg.join("\n").length;
  assert.ok(len <= 165, "利差段超长：" + len);
  assert.ok(seg[0].includes("非城投"), "标题必须写明不是城投曲线");
});

test("v118 段落额度：宏观段不超 130 字，且三项同月时月份只写一次", () => {
  const MACRO = { items: [
    { name: "CPI 同比", valText: "0.7%", periodText: "2026年10月", deltaText: "-0.2个百分点" },
    { name: "PPI 同比", valText: "5.7%", periodText: "2026年10月", deltaText: "+0.7个百分点" },
    { name: "制造业 PMI", valText: "49.3", periodText: "2026年10月", deltaText: "-0.8点" },
  ] };
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [],
    market: { ok: false }, gaps: [], today: "2026-11-09", macro: MACRO,
  });
  const seg = txt.split("\n").filter(l => l.includes("【宏观】") || l.includes("月度实际值"));
  const len = seg.join("\n").length;
  assert.ok(len <= 130, "宏观段超长：" + len);
  assert.match(seg[0], /【宏观】2026年10月：/, "三项同月时月份要提到句首");
  assert.equal((seg[0].match(/2026年10月/g) || []).length, 1, "月份重复写了");
  assert.match(seg[1], /不许写「超预期 \/ 低于预期」/);
});

test("v118 段落额度：三个月的月份不同时，各自标月份，不许张冠李戴", () => {
  const MACRO = { items: [
    { name: "CPI 同比", valText: "0.7%", periodText: "2026年10月", deltaText: "-0.2个百分点" },
    { name: "制造业 PMI", valText: "49.3", periodText: "2026年11月", deltaText: "-0.8点" },
  ] };
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [],
    market: { ok: false }, gaps: [], today: "2026-11-09", macro: MACRO,
  });
  const line = txt.split("\n").find(l => l.includes("【宏观】"));
  assert.match(line, /CPI 同比 0\.7%（2026年10月，-0\.2个百分点）/);
  assert.match(line, /制造业 PMI 49\.3（2026年11月，-0\.8点）/);
});

/* ---------- v125：信息面三路进数据块 ---------- */

/** 晴雨摘要夹具：真机同形（marketAiBlock 产出的尾部元信息行）。 */
const MK_AI = "【债市快照 11-10】今日债市整体平稳，红 2 / 绿 25 / 白 2 / 蓝 4。"
  + "（快照日期 2026-11-10，上一交易日 2026-11-09；官方收益率曲线推导，已核验）";

/** 信息面夹具：8 条满额，标题带数字（测数字白名单的场景）。 */
const NEWS_FIX = {
  ok: true, asOf: "2026-11-10 20:26:06",
  items: [
    { d: "11-10 20:24", src: "财联社", title: "央行开展 80 亿元逆回购操作" },
    { d: "11-10 19:58", src: "新华财经", title: "10Y 国债上行 1.7bp 至 1.5965%" },
    { d: "11-10 18:30", src: "财联社", title: "机构观点：信用利差走阔，短久期防御占优" },
    { d: "11-10 17:12", src: "中国证券报", title: "税期临近，资金面收敛，DR001 上行" },
    { d: "11-10 15:40", src: "证券时报", title: "保险资金 11 月中旬起配置超长债" },
    { d: "11-10 14:02", src: "财联社", title: "30 年国债上行 1.4bp" },
    { d: "11-10 11:20", src: "上海证券报", title: "跨年配置行情启动信号增强" },
    { d: "11-10 09:31", src: "财联社", title: "公开市场净投放 80 亿元" },
  ],
};

/** 资金面夹具：FDR 4 行 + FR 2 行，真机同形。 */
const FUND_FIX = {
  ok: true, label: "银银间回购定盘利率 FDR", asOf: "2026-11-10",
  rows: [{ tenor: "FDR001", value: 1.32 }, { tenor: "FDR007", value: 1.35 },
    { tenor: "FDR014", value: 1.4 }, { tenor: "FDR1M", value: 1.5 }],
  frText: "FR001 1.39%｜FR007 1.42%",
};

/** 检索夹具：5 条满额（无时间字段 —— 恒 timeUnknown 是包级红线）。 */
const SRCH_FIX = {
  ok: true, at: "11-11 09:52", query: "银行理财 债市 资金面",
  items: [
    { src: "news.example.com", title: "债市蓄势消化期：长端偏震荡" },
    { src: "bond.example.cn", title: "DR001 连续两日上行 资金面收敛" },
    { src: "fin.example.net", title: "信用修复第一波结束 结构性挖掘" },
    { src: "www.example.org", title: "11 月税期高峰临近 央行投放克制" },
    { src: "m.example.com", title: "跨年配置行情 保险买盘启动" },
  ],
};

test("v125 晴雨摘要：进数据块且原文透传（已核验叙述与数字表互补）", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [],
    market: Object.assign({}, MK, { ai: MK_AI }), gaps: [], today: "2026-11-09",
  });
  assert.match(txt, /红 2 \/ 绿 25 \/ 白 2 \/ 蓝 4/);
  assert.match(txt, /官方收益率曲线推导，已核验/);
  /* 没带 ai（未核验时 marketAiBlock 返回空串）就整段静默 —— 不画空段 */
  const txt2 = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: MK, gaps: [], today: "2026-11-09",
  });
  assert.ok(!/已核验）/.test(txt2.replace(/【债市】[^【]*$/, "")), "没有 ai 时不得凭空出现晴雨摘要");
});

test("v125 资金面：数值行 + 「非 DR 本身」口径恒注", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09", funding: FUND_FIX,
  });
  assert.match(txt, /【资金面】银银间回购定盘利率 FDR · asOf 11-10/);
  assert.match(txt, /FDR001 1\.32%/);
  assert.match(txt, /FDR001 1\.32%｜FDR007 1\.35%/);
  assert.match(txt, /FR001 1\.39%/);
  assert.match(txt, /非 DR 本身/);
  assert.match(txt, /不与【盘中参考】混算/);
});

test("v125 资金面缺失：带 gap 文本显式说没有，并堵死「从曲线反推」", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09",
    funding: { ok: false, gapText: "货币网 FDR 抓取失败：HTTPError" },
  });
  assert.match(txt, /【资金面】本轮没有资金面数据（货币网 FDR 抓取失败：HTTPError）/);
  assert.match(txt, /不许从收益率曲线反推资金面/);
  assert.ok(!/FDR\d+ \d/.test(txt), "失败时不许带任何定盘数值");
});

test("v125 信息面纯函数：3 天之外的线索被剔除、倒序、8 条上限、发布时间缺失的线索剔除", () => {
  const now = new Date("2026-11-11T09:00:00").getTime();
  const mk = (d, i) => ({ title: "线索" + i, source: "财联社", publishedAt: d, url: "https://x/" + i });
  const clues = [
    mk("2026-11-10 20:24:36", 1),                          // 昨天：进
    mk("2026-11-07 20:24:36", 2),                          // 4 天前：剔除（now-3d = 11-08 09:00 之前）
    mk("2026-11-08 09:00:00", 3),                          // 恰在 3 天边界：进
    mk("2026-10-20 09:00:00", 4),                          // 一个月前：剔除
    mk("2026-11-10 21:00:00", 5),                          // 最新：倒序后第一
    { title: "没有发布时间的线索", source: "财联社", url: "https://x/n" },  // 无时间：剔除
  ];
  for (let i = 6; i < 16; i++) clues.push(mk("2026-11-10 1" + (i % 10) + ":00:00", i));  // 凑超 8 条
  const f = reportNewsFacts(clues, "2026-11-10 20:26:06", now);
  assert.ok(f && f.ok);
  assert.equal(f.asOf, "2026-11-10 20:26:06");
  assert.ok(f.items.length <= 8, "超 8 条必须截断");
  assert.ok(!f.items.some(it => it.title === "线索4"), "一个月前的线索不进块");
  assert.ok(!f.items.some(it => it.title === "没有发布时间的线索"), "无发布时间的不进块");
  assert.equal(f.items[0].title, "线索5", "最新的一条排最前");
  /* 旧包（全部过期）→ ok:false，渲染端会写「近 3 天没有线索」。
     取线索4（一个月前）单条：被 3 天闸门剔除后整包为空。 */
  const empty = reportNewsFacts(clues.slice(3, 4), "2026-10-20 09:00:00", now);
  assert.ok(empty && empty.ok === false);
});

test("v125 信息面渲染：带时间线与待核标注，渲染行数与 items 数一致", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09", news: NEWS_FIX,
  });
  assert.match(txt, /【信息面】近 3 天线索 8 条（来源直抓 · verified=false 待核，不当事实引用）/);
  assert.match(txt, /11-10 20:24 财联社｜央行开展 80 亿元逆回购操作/);
  const lines = txt.split("\n").filter(l => /^  \d{2}-\d{2} \d{2}:\d{2} /.test(l));
  assert.equal(lines.length, 8, "渲染行数应与 items 数一致");
});

test("v125 信息面空窗：写「近 3 天没有线索」并带上次更新时间，不留空", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09",
    news: { ok: false, asOf: "2026-11-10 20:26:06", items: [] },
  });
  assert.match(txt, /【信息面】近 3 天没有线索（信息面上次更新 11-10 20:26）/);
  assert.match(txt, /数据块里没有/);
});

test("v125 检索纯函数：host 从 url 提取、query 截断 40、5 条上限、空包返回 null", () => {
  const pack = { asOf: "2026-11-11 09:52:00", query: "x".repeat(80),
    hits: Array.from({ length: 7 }, (_, i) => ({
      title: "检索结果" + i, url: "https://host" + i + ".example.com/a?b=" + i,
      source: "AnySearch", verified: false, timeUnknown: true })) };
  const f = reportSearchFacts(pack);
  assert.ok(f && f.ok);
  assert.equal(f.items.length, 5, "检索包超 5 条必须截断");
  assert.equal(f.items[0].src, "host0.example.com", "来源取域名");
  assert.ok(f.query.length <= 40, "检索词必须截断");
  assert.equal(f.at, "11-11 09:52", "检索时点取包级 asOf");
  assert.equal(reportSearchFacts(null), null);
  assert.equal(reportSearchFacts({ hits: [] }), null);
});

test("v125 资金面纯函数：FDR 行取 4 条、FR 取 2 条、失败时 gap 原样带出", () => {
  const ok = reportFundingFacts({
    label: "银银间回购定盘利率 FDR", asOf: "2026-11-10",
    rows: [{ tenor: "FDR001", value: 1.32 }, { tenor: "FDR007", value: 1.35 },
      { tenor: "FDR014", value: 1.4 }, { tenor: "FDR1M", value: 1.5 }, { tenor: "FDR3M", value: 1.6 }],
    fr: { FR001: 1.39, FR007: 1.42, FR014: 1.5 },
  }, []);
  assert.ok(ok && ok.ok);
  assert.equal(ok.rows.length, 4, "FDR 行最多带 4 条");
  assert.match(ok.frText, /^FR001 1\.39%｜FR007 1\.42%$/, "FR 只带前两条");
  const bad = reportFundingFacts({ rows: [], fr: {} },
    ["货币网 FDR 抓取失败：HTTPError", "货币网 FR 抓取失败：HTTPError", "别的 gap"]);
  assert.ok(bad && bad.ok === false);
  assert.match(bad.gapText, /货币网 FDR 抓取失败：HTTPError；货币网 FR 抓取失败：HTTPError/, "只带资金面相关 gap");
  assert.equal(reportFundingFacts(null, []), null);
});

test("v125 检索线索：块首恒注「无发布时间 / 互证后才可引用」，带检索时点与词", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09", search: SRCH_FIX,
  });
  assert.match(txt, /【检索线索】AnySearch 11-11 09:52 检索「银行理财 债市 资金面」，5 条/);
  assert.match(txt, /无发布时间，仅作线索；与【信息面】互证后才可引用/);
  assert.match(txt, /news\.example\.com｜债市蓄势消化期/);
});

test("v125 检索线索：没检索过就整段静默，不写「没有」（检索是手动动作，不该当缺口喊）", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09", search: null,
  });
  assert.ok(!txt.includes("【检索线索】"), "没检索过不许出现检索块");
});

test("v125 段落额度：资金面段不超 190 字 / 信息面段不超 560 字 / 检索段不超 400 字", () => {
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-09"), kind: "portfolio", rows: [], market: { ok: false },
    gaps: [], today: "2026-11-09", news: NEWS_FIX, funding: FUND_FIX, search: SRCH_FIX,
  });
  const segOf = (re) => {
    const ls = txt.split("\n");
    const i0 = ls.findIndex(l => re.test(l));
    if (i0 < 0) return { ls: [], len: 0, i0: -1 };
    const kept = [ls[i0]];
    for (let i = i0 + 1; i < ls.length && ls[i].startsWith("  "); i++) kept.push(ls[i]);
    return { ls: kept, len: kept.join("\n").length, i0 };
  };
  const fund = segOf(/【资金面】/);
  assert.ok(fund.len <= 190 && fund.len > 0, "资金面段超长：" + fund.len);
  const news = segOf(/【信息面】/);
  assert.ok(news.len <= 560 && news.len > 0, "信息面段超长：" + news.len);
  const srch = segOf(/【检索线索】/);
  assert.ok(srch.len <= 400 && srch.len > 0, "检索段超长：" + srch.len);
});

test("v125 事实层总额度：单只 + 盘中 8 项 + 利差 + 宏观 + 信息面三路满额，不许超 2500", () => {
  /* 额度名目（v125）：基线 1600（v118 口径）+ 四新块实测
       晴雨摘要 ~90 / 资金面 ~170 / 信息面 8 条 ~460 / 检索 5 条 ~330 ≈ +1050
     取 2500 留 ~250 余量。新块全部走段落级额度（上一条测试），总额度只是兜底；
     往新块加东西要么在段落额度内加，要么显式改段落条款 —— 与 v118 同一条纪律。 */
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "", "13:31"),
    kind: "product", name: "诚享7天29号", inst: "北银理财", nav: NAV,
    market: Object.assign({}, MK, { ai: MK_AI }),
    gaps: ["资金面：没有 DR001 / DR007", "国债期货"], live: LIVE_FIX,
    news: NEWS_FIX, funding: FUND_FIX, search: SRCH_FIX,
  });
  assert.ok(txt.length <= 2500, "事实层超长了：" + txt.length);
});

test("v117 盘中：卡片坐标多一颗胶囊，且带时分", () => {
  const h = reportCoordsHtml({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "", "13:31"),
    market: MK, rows: [], live: LIVE_FIX,
  });
  assert.match(h, /rp-co-live/);
  assert.match(h, /盘中 13:31/);
  /* 没有盘中数据就不许画这颗胶囊 —— 空胶囊比不画更糟：读者会以为「有但没显示」 */
  const h2 = reportCoordsHtml({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09"), market: MK, rows: [],
  });
  assert.ok(!/rp-co-live/.test(h2));
});

test("请求：债市缺失时不许留空，要写明只能写「数据块里没有」", () => {
  const txt = reportFactsText({ session: reportSession(0, "2026-11-02"), kind: "product", name: "X", nav: NAV, market: { ok: false }, gaps: [] });
  assert.match(txt, /本轮没有可用的债市快照/);
  assert.match(txt, /数据块里没有/);
});

/* ---------- 数字审计 ---------- */

test("审计：编出来的数字必须被点名", () => {
  const r = reportNumberAudit("净值 1.014962，距前高 5.8bp，另有 99.9% 与 7.77 两个假数。", [1.014962, 5.84]);
  assert.ok(r.unknown.indexOf("99.9") >= 0);
  assert.ok(r.unknown.indexOf("7.77") >= 0);
  assert.ok(r.unknown.indexOf("1.014962") < 0);
});

test("审计：日期与舍入不算编数", () => {
  /* 11-02 会被正则切成 11 与 -02；1.014962 抄成 1.0150 或 1.0149 都是抄，不是编。 */
  const r = reportNumberAudit("11-02 单日 −11.5bp，净值 1.0150，另一处写 1.0149，10-29 前高。", [1.014962, 11.52]);
  assert.deepEqual(r.unknown, []);
  assert.ok(r.total > 0);
});

test("审计：全对时 unknown 为空，比例 0", () => {
  const r = reportNumberAudit("5.8bp", [5.84]);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.ratio, 0);
});

/* ---------- 渲染 ---------- */

test("表格：净值表把前高与冲击标出来，涨红跌绿", () => {
  const h = reportTableHtml({ kind: "product", nav: NAV, market: MK });
  assert.match(h, /rp-hi/);
  assert.match(h, /rp-lo/);
  assert.match(h, /前高/);
  assert.match(h, /冲击/);
  assert.match(h, /rp-up/, "−11.5bp 是收益率下行 / 净值下跌，走绿");
  assert.ok(h.indexOf("<script") < 0);
});

test("表格：债市缺失时整块不画，不留一张空表", () => {
  const h = reportTableHtml({ kind: "product", nav: NAV, market: { ok: false } });
  assert.ok(h.indexOf("债市关键期限") < 0);
});

test("表格：产品名里的尖括号被转义", () => {
  const rows = [{ name: "<img src=x onerror=alert(1)>", nav: 1.01, navDate: "2026-10-01", d30: 0.1, dd: -0.2, gapBp: 3 }];
  const h = reportTableHtml({ kind: "portfolio", rows, market: { ok: false } });
  assert.ok(h.indexOf("<img") < 0, "模型与台账里的名字都可能带尖括号");
  assert.match(h, /&lt;img/);
});

test("坐标：净值 / 债市 / 生成，三个日期各一个胶囊", () => {
  const h = reportCoordsHtml({ session: reportSession(new Date("2026-11-09T21:21:00").getTime(), "2026-11-09"), nav: NAV, market: MK });
  assert.match(h, /净值 10-28/);
  assert.match(h, /债市 10-30/);
  assert.match(h, /生成 11-09 21:21/);
  assert.equal((h.match(/<span class="rp-co/g) || []).length, 3);
});

/* ---------- 契约解析 ---------- */

const OK_TEXT = [
  "结论：watch",
  "信心：0.62",
  "标题：单日冲击已收回九成，但还差前高 5.8bp",
  "",
  "## 这一跌是什么性质",
  "11-02 单日 −11.5bp，是常态波动的 6.6 倍，属于事件冲击，不是收益能力变化。",
  "",
  "## 债市给的是顺风还是逆风",
  "10-30 全期限下行，对净值是顺风；但快照比净值新一个交易日，还没被净值验证。",
  "",
  "## 还差多少、要多久",
  "距前高 5.8bp。按常态需 5 个披露点，按最近两日需 1 个。",
].join("\n");

test("解析：三段 + 三个头字段", () => {
  const r = parseReport(OK_TEXT);
  assert.equal(r.ok, true);
  assert.equal(r.report.verdict, "watch");
  assert.equal(r.report.confidence, 0.62);
  assert.match(r.report.headline, /还差前高/);
  assert.equal(r.report.paras.length, 3);
  assert.equal(r.report.paras[0].h, "这一跌是什么性质");
});

test("解析：没有 ## 但有正文，也要收 —— 坏一段只丢一段，不是整份作废", () => {
  const r = parseReport("结论：continue\n标题：平稳\n今天没有新情况，净值按票息走。");
  assert.equal(r.ok, true);
  assert.equal(r.report.verdict, "continue");
  assert.equal(r.report.paras.length, 1);
  assert.equal(r.report.paras[0].h, "");
});

test("解析：只有表头没有正文 → 判失败，并说清是「没有正文」", () => {
  const r = parseReport("结论：watch\n信心：0.5\n标题：空");
  assert.equal(r.ok, false);
  assert.match(String(r.why), /没有可用的正文段/);
});

test("解析：中文枚举、百分数信心都能收", () => {
  const r = parseReport("结论：继续观察\n信心：62\n## 一\n净值平稳。");
  assert.equal(r.report.verdict, "watch");
  assert.equal(r.report.confidence, 0.62);
});

test("解析：标题里出现收益预测，整份拒收", () => {
  const r = parseReport("结论：watch\n标题：预计收益可达 3%\n## 一\n净值平稳。");
  assert.equal(r.ok, false);
  assert.match(String(r.why), /收益预测/);
});

test("解析：某一段里出现收益预测，只丢那一段并计数", () => {
  const r = parseReport("结论：watch\n标题：观察\n## 一\n净值平稳。\n## 二\n目标净值 1.05，稳赚。");
  assert.equal(r.ok, true);
  assert.equal(r.report.paras.length, 1);
  assert.equal(r.dropped.banned, 1);
});

test("解析：超过 5 段只留前 5 段，其余计数", () => {
  const t = "结论：watch\n标题：x\n" + [1, 2, 3, 4, 5, 6].map(i => `## 段${i}\n内容${i}。`).join("\n");
  const r = parseReport(t);
  assert.equal(r.report.paras.length, 5);
  assert.equal(r.dropped.paras, 1);
});

test("解析：旧 JSON 格式让路，不会被当成「一段正文」", () => {
  /* 不让路的话，屏幕上会出现一段裸 JSON 冒充研报 —— 而它本来是旧格式，能被旧解析器正确渲染。 */
  const old = JSON.stringify({ verdict: "watch", headline: "x", sections: [] });
  const r = parseReport(old);
  assert.equal(r.ok, false);
  assert.match(String(r.why), /旧格式/);
});

test("解析：既无档位也无标题时标 partial，不许挂一个默认档位冒充结论", () => {
  const r = parseReport("我觉得还行，但要看后面几天的走势。");
  assert.equal(r.ok, true);
  assert.equal(r.report.partial, true);
  const h = reportCardHtml({
    facts: { session: reportSession(0, "2026-11-09"), kind: "product", name: "X", nav: NAV, market: MK, watch: [], gaps: [] },
    rep: r.report,
  });
  assert.match(h, /未结构化/);
  assert.ok(h.indexOf("继续观察") < 0, "没给档位就不许画一个默认档位");
});

test("解析：给了档位就不标 partial", () => {
  const r = parseReport(OK_TEXT);
  assert.equal(r.report.partial, false);
});

test("指令：不许出现 sources / 联网，且要求不许新增数字", () => {
  assert.equal(REPORT_PROMPT_VER, "report-2");
  assert.ok(REPORT_INSTRUCTIONS.indexOf('"sources"') < 0);
  assert.match(REPORT_INSTRUCTIONS, /不许新增任何数字/);
  assert.match(REPORT_INSTRUCTIONS, /不要联网检索/);
});

/* v125：四种新块的读法必须写进指令 —— 口径不在指令里，模型要么把线索当事实，
   要么把资金面当 DR 本身。这一组断言钉住的是「读法跟着块走」。 */
test("指令：四种新块（晴雨/资金面/信息面/检索线索）的口径齐全", () => {
  for (const name of ["晴雨快照", "资金面", "信息面", "检索线索"])
    assert.ok(REPORT_INSTRUCTIONS.includes(name), "指令缺新块名：" + name);
  assert.match(REPORT_INSTRUCTIONS, /非 DR 本身/);          // 资金面口径红线
  assert.match(REPORT_INSTRUCTIONS, /待核/);                 // 信息面线索定性
  assert.match(REPORT_INSTRUCTIONS, /互证后才可引用/);       // 检索线索无时间的补偿判据
  assert.match(REPORT_INSTRUCTIONS, /不许从收益率曲线反推资金松紧/); // 缺资金面时的红线
});

/* ---------- 卡片 ---------- */

test("卡片：没有解读时只画事实区 —— 这是 P0 的核心", () => {
  /* 模型挂了、超时了、没点按钮，屏幕上都得有东西。v109 的「等 90 秒什么都没有」
     不是模型慢，是页面把「有没有结论」当成了「要不要画东西」。 */
  const h = reportCardHtml({
    facts: { session: reportSession(new Date("2026-11-09T21:21:00").getTime(), "2026-11-09"), kind: "product", name: "诚享7天29号", inst: "北银理财", nav: NAV, market: MK, watch: [], gaps: ["资金面"] },
    rep: null,
    placeholderHtml: `<div class="rp-sec"><div class="rp-none">点按钮生成</div></div>`,
  });
  assert.match(h, /诚享7天29号/);
  assert.match(h, /这只产品的净值/);
  assert.match(h, /债市关键期限/);
  assert.match(h, /点按钮生成/);
  assert.ok(h.indexOf("怎么读这几张表") < 0, "没有结论就不许画结论区");
});

test("卡片：有解读时三段都画出来，并带上数字核对", () => {
  const r = parseReport(OK_TEXT);
  const h = reportCardHtml({
    facts: { session: reportSession(new Date("2026-11-09T21:21:00").getTime(), "2026-11-09"), kind: "product", name: "X", nav: NAV, market: MK, watch: [], gaps: [] },
    rep: r.report,
    audit: { total: 9, unknown: ["99.9", "7.77", "5.5"], ratio: 0.3 },
    ms: 34000,
  });
  assert.match(h, /这一跌是什么性质/);
  assert.match(h, /数字核对/);
  assert.match(h, /99\.9/);
  assert.match(h, /rp-audit warn/, "3 个以上对不上要标黄");
  assert.match(h, /用时 34 秒/);
});

test("卡片：只有 1 个数字对不上时不标黄，只列出来", () => {
  const r = parseReport(OK_TEXT);
  const h = reportCardHtml({
    facts: { session: reportSession(0, "2026-11-09"), kind: "product", name: "X", nav: NAV, market: MK, watch: [], gaps: [] },
    rep: r.report, audit: { total: 9, unknown: ["7.77"], ratio: 0.11 },
  });
  assert.ok(h.indexOf("rp-audit warn") < 0);
  assert.match(h, /7\.77/);
});

test("卡片：模型写的尖括号一律转义", () => {
  const r = parseReport("结论：watch\n标题：<b>粗</b>\n## 一\n<svg onload=alert(1)>");
  const h = reportNarrativeHtml(r.report);
  assert.ok(h.indexOf("<svg") < 0);
  assert.ok(h.indexOf("<b>粗") < 0);
});

test("摘要：喂给追问的上文是段落，不是 JSON", () => {
  const r = parseReport(OK_TEXT);
  const s = reportSummaryText(r.report);
  assert.match(s, /【上一份研报 · 继续观察】/);
  assert.match(s, /这一跌是什么性质：/);
  assert.ok(s.indexOf("{") < 0);
  assert.ok(s.length <= 1200);
});

/* ---------- 组合层 ---------- */

test("组合：每只一行，距前高按各自序列算", () => {
  const rows = reportPortfolioRows([
    { name: "A", nav: 1.01, navDate: "2026-10-28", metrics: { d30: 0.12, dd: -0.2 }, series: SERIES },
    { name: "B", nav: 1.02, navDate: "2026-10-28", metrics: { d30: -0.05, dd: -0.4 }, series: SERIES.slice(0, 10) },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].gapBp - 5.84) < 0.01);
  assert.ok(rows[1].gapBp !== null);
});

/* ---------- v114（P1）：三档情景 / 断点 / 极端日 / 横向表增强 ---------- */

const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= (eps == null ? 1e-9 : eps);

test("情景：三档并排，累计算得对，压力档复制的是那一次冲击", () => {
  const sc = reportScenarios(NAV, { k: 5 });
  assert.equal(sc.ok, true);
  assert.equal(sc.k, 5);
  assert.equal(sc.rows.length, 3, "有冲击的产品应给三档");
  assert.deepEqual(sc.rows.map(r => r.key), ["normal", "fast", "stress"]);

  const normal = sc.rows[0];
  assert.ok(near(normal.cumBp, 5 * NAV.normalBp, 1e-9), "常态档应是 5 × 中位数");
  assert.ok(near(normal.nav, NAV.last.value * (1 + normal.cumBp / 10000), 1e-12));

  const stress = sc.rows[2];
  assert.ok(NAV.shock && NAV.shock.bp < 0);
  assert.ok(near(stress.cumBp, NAV.shock.bp + 4 * NAV.normalBp, 1e-9), "压力档 = 一次冲击 + 其余按常态");
  assert.equal(stress.perBp, null, "压力档没有「每点」—— 它是单次事件，不是每天的速度");
  /* 三档必须真的分得开：并排看不出差别，这个表就没有意义 */
  assert.ok(sc.high - sc.low > 5, "三档差得太小，等于没给");
});

test("情景：没有冲击、样本又不足 20 点时，只给两档，不硬凑第三档", () => {
  const short = reportNavFacts(bus("2026-10-01", 6).map((d, i) => [d, 1.01 + i * 0.0001]), {});
  assert.equal(short.ok, true);
  assert.equal(short.sigmaBp, 0, "样本不足时 σ 必须是 0");
  const sc = reportScenarios(short, { k: 3 });
  assert.equal(sc.ok, true);
  assert.equal(sc.rows.length, 2, "没有冲击也没有 σ，就不该编一个压力档");
});

test("情景：时间单位是「披露点」，不是自然日", () => {
  const sc = reportScenarios(NAV, { k: 5 });
  /* 日更产品：第 5 个披露点就是 5 个交易日之后 */
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sc.byDate));
  assert.ok(sc.byDate > NAV.last.date, "目标日期必须在最后一个披露点之后");
});

test("情景表：写明「不是预测」，且三档都带口径标签", () => {
  const html = scenarioHtml(reportScenarios(NAV, { k: 5 }));
  assert.match(html, /三档并列/);
  assert.match(html, /不是预测/);
  assert.match(html, /按常态/);
  assert.match(html, /按最近两日/);
  assert.match(html, /再来一次冲击/);
  assert.match(html, /往前推 5 个披露点/);
  assert.equal(scenarioHtml({ ok: false }), "");
});

test("断点：中间少掉一截交易日，要能被指出来", () => {
  const days = bus("2026-08-03", 30);
  const cut = days.slice(0, 12).concat(days.slice(20));   // 挖掉 8 个交易日
  const s = cut.map((d, i) => [d, 1.01 * Math.pow(1.00012, i)]);
  const f = reportNavFacts(s, { today: "2026-09-30" });
  assert.equal(f.ok, true);
  assert.ok(f.breaks.length >= 1, "挖掉 8 个交易日却没报断点");
  const b = f.breaks[0];
  assert.ok(b.gap >= 8);
});

test("极端日：20 个点里出现两次 4σ，要单独计数（不只是记最深的那一次）", () => {
  const days = bus("2026-06-01", 62);
  const bps = [];
  for (let i = 0; i < 61; i++) bps.push(1.0);
  bps[50] = -15; bps[55] = -15;
  let v = 1.01;
  const s = [[days[0], v]];
  for (let i = 0; i < bps.length; i++) { v *= (1 + bps[i] / 10000); s.push([days[i + 1], v]); }
  const f = reportNavFacts(s, { today: "2026-09-30" });
  assert.ok(f.sigmaBp > 0);
  assert.equal(f.extreme.length, 2, "两次 4σ 应计两次");
  assert.ok(f.extreme.every(x => Math.abs(x.sigma) >= 4));
});

test("距最后披露几个交易日：周更产品也能量出来（missing 只管日更）", () => {
  const f = reportNavFacts(SERIES, { today: "2026-11-05" });
  assert.ok(f.staleDays > 0);
  assert.equal(f.cadence, "daily");
  const weekly = bus("2026-08-03", 40).filter((d, i) => i % 5 === 0)
    .map((d, i) => [d, 1.01 * Math.pow(1.0008, i)]);
  const fw = reportNavFacts(weekly, { today: "2026-10-20" });
  assert.equal(fw.cadence, "weekly");
  assert.ok(fw.staleDays >= 0);
});

test("横向表：占比与「落后几日」都要有，隐藏金额时占比是 null 而不是 0%", () => {
  const items = [
    { name: "甲", nav: 1.01, navDate: "2026-11-06", w: 0.6, metrics: { d30: 0.3, dd: -0.1 }, series: SERIES },
    { name: "乙", nav: 1.02, navDate: "2026-11-02", w: null, metrics: { d30: 0.1, dd: 0 }, series: SERIES },
  ];
  const rows = reportPortfolioRows(items, { today: "2026-11-09" });
  assert.equal(rows[0].w, 0.6);
  assert.equal(rows[1].w, null, "没给占比就是 null，不能填 0");
  assert.equal(rows[1].lag, 5, "11-02 到 11-09 是 5 个交易日");
  assert.equal(rows[1].stale, true);
  assert.equal(rows[0].stale, false);
});

test("横向表渲染：多一列占比，掉队的在名字下标红", () => {
  const rows = reportPortfolioRows([
    { name: "甲", nav: 1.01, navDate: "2026-11-06", w: 0.6, metrics: { d30: 0.3, dd: -0.1 }, series: SERIES },
    { name: "乙", nav: 1.02, navDate: "2026-11-02", w: 0.4, metrics: { d30: 0.1, dd: 0 }, series: SERIES },
  ], { today: "2026-11-09" });
  const html = reportTableHtml({ kind: "portfolio", rows });
  assert.match(html, /占比/);
  assert.match(html, /60%/);
  assert.match(html, /落后 5 日/, "掉队的那只没有标记");
  assert.match(html, /距前高/);
});

test("观察项：组合层掉队要点名，不是只说「有 N 只」", () => {
  const rows = [
    { name: "甲", navDate: "2026-11-06", stale: false },
    { name: "乙", navDate: "2026-11-02", stale: true },
    { name: "丙", navDate: "2026-11-03", stale: true },
  ];
  const w = reportWatch(null, MKT ? reportMarketFacts(MKT, "2026-11-09") : null,
    { key: "afterclose" }, { rows, today: "2026-11-09" });
  const hit = w.find(x => /落后 2 个交易日以上/.test(x.text));
  assert.ok(hit, "没有掉队那条");
  assert.match(hit.text, /乙（11-02）/);
  assert.match(hit.text, /丙（11-03）/);
});

test("观察项：日历里三天内撞上偏紧的日子，要提醒一句", () => {
  const cal = pubCalNext("2026-11-14", { days: 21, limit: 6 });
  const w = reportWatch(NAV, null, { key: "afterclose" }, { cal });
  const hit = w.find(x => /税期截止|缴准/.test(x.text));
  assert.ok(hit, "日历项没进观察项");
  assert.match(hit.text, /还有 \d+ 天/);
});

test("日历胶囊：与时间坐标同一层级，顺延的要带规则日", () => {
  const cal = pubCalNext("2026-11-10", { days: 21, limit: 6 });
  const html = reportCalHtml(cal);
  assert.match(html, /日历/);
  assert.match(html, /11-16/);
  assert.match(html, /缴准/);
  assert.match(html, /rp-pc/);
  assert.equal(reportCalHtml([]), "");
});

test("请求装配：情景与日历都要进请求，且都标明「不是预测」", () => {
  const sc = reportScenarios(NAV, { k: 5 });
  const cal = pubCalNext("2026-11-10", { days: 21, limit: 6 });
  const txt = reportFactsText({
    session: reportSession(0, "2026-11-10"), kind: "product",
    name: "测试产品", nav: NAV, market: null, gaps: [], scenarios: sc, cal, today: "2026-11-10",
  });
  assert.match(txt, /【情景】/);
  assert.match(txt, /不是预测/);
  assert.match(txt, /【日历】/);
  assert.match(txt, /缴准/);
  assert.match(txt, /11-15 顺延/);
});

/* ---------- v115：信心那一行不许把「没说清」画成「很低」 ---------- */

const mkReport = conf => parseReport(
  "结论：继续观察\n信心：" + conf + "\n标题：给个标题\n\n## 这一跌什么性质\n正文一。" +
  "\n\n## 顺风还是逆风\n正文二。\n\n## 要多久\n正文三。");

test("信心：中文档位要认出档位，且不许换算成百分比", () => {
  /* 原来 `replace(/[^\d.]/g,"")` 把「中」抹成空串、Number("") === 0，
     卡片于是画出「信心 0%（低）」—— 模型说的是「中」，屏幕说的是「很低」。 */
  for (const [word, want] of [["中", "中"], ["较高", "较高"], ["高", "较高"], ["中等", "中"], ["较低", "低"], ["低", "低"]]) {
    const r = mkReport(word);
    assert.equal(r.ok, true, word);
    assert.equal(r.report.confidence, null, word + " 不该被换算成数字");
    assert.equal(r.report.confLevel, want, word);
  }
});

test("信心：0 到 1 的小数与百分数都照旧认", () => {
  assert.equal(mkReport("0.72").report.confidence, 0.72);
  assert.equal(mkReport("0.72").report.confLevel, "");
  assert.equal(mkReport("72%").report.confidence, 0.72, "百分数要除以 100");
  assert.equal(mkReport("0").report.confidence, 0, "真的写了 0 就是 0，不能被当成「没说」");
  assert.equal(mkReport("1").report.confidence, 1);
});

test("信心：既没数字也没档位时，两样都是空 —— 界面不画这一行", () => {
  const r = mkReport("拿不准");
  assert.equal(r.report.confidence, null);
  assert.equal(r.report.confLevel, "");
  const html = reportCardHtml({ facts: { kind: "portfolio", rows: [] }, rep: r.report });
  assert.ok(html.indexOf("rp-bar") < 0, "没有数就不许画进度条");
  assert.ok(html.indexOf("信心") < 0, "没有档位就不许画信心那一行");
});

test("信心：有档位就只写档位，不画进度条", () => {
  const r = mkReport("中");
  const html = reportCardHtml({ facts: { kind: "portfolio", rows: [] }, rep: r.report });
  assert.match(html, /信心：中/);
  assert.ok(html.indexOf("rp-bar") < 0, "「中」没有对应数值，画条就是编");
});

test("信心：有数值时进度条长度跟着数值走", () => {
  const html = reportCardHtml({ facts: { kind: "portfolio", rows: [] }, rep: mkReport("0.72").report });
  assert.match(html, /信心 72%（较高）/);
  assert.match(html, /width:72%/);
});

/* ---------- v117：负零 ---------- */

test("v117 回撤不做负零：-0.0004 写成 0.00%，不是 -0.00%", () => {
  /* 真实出现过的正文：「最大回撤 -0.00%」。数值上是零，写法上却是个负数，
     读者只能理解成「有亏损，只是小到显示不出来」—— 而它其实是完全没回撤。 */
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-10T13:53:00").getTime(), "2026-11-10"),
    kind: "portfolio", market: MK, gaps: [],
    rows: [{ name: "安盈稳健日开7号A", nav: 1.0248, navDate: "2026-11-09", d30: 0.48, dd: -0.0004 }],
  });
  assert.match(txt, /最大回撤 0\.00%/);
  assert.ok(!/最大回撤 -0\.00%/.test(txt), "负零又被印成负数了");
  /* 真有回撤时照旧带负号，别把归零写成「一律不加负号」 */
  const t2 = reportFactsText({
    session: reportSession(new Date("2026-11-10T13:53:00").getTime(), "2026-11-10"),
    kind: "portfolio", market: MK, gaps: [],
    rows: [{ name: "匠心灵动14天9G", nav: 1.0120, navDate: "2026-11-09", d30: 0.21, dd: -0.19 }],
  });
  assert.match(t2, /最大回撤 -0\.19%/);
});

test("v117 表格：回撤 -0.0004 既不能写 -0.00%，也不能染成亏损色", () => {
  /* 文字与颜色必须同源。截图里出现过「回撤 -0.00%」且染红：数值是零，
     颜色却是"亏"，同一格里自相矛盾，读者只会以为显示坏了。 */
  const h = reportTableHtml({
    kind: "portfolio",
    rows: [{ name: "安盈稳健日开7号A", nav: 1.0248, d30: 0.48, dd: -0.0004, gapBp: 0 }],
  });
  assert.ok(!/-0\.00%/.test(h), "表格里还有负零");
  const cell = (h.match(/<td class="(rp-[a-z]+)">0\.00%<\/td>/) || [])[1];
  assert.equal(cell, "rp-flat", "回撤是零，却染成了涨跌色");
  /* 真回撤照旧 */
  const h2 = reportTableHtml({
    kind: "portfolio",
    rows: [{ name: "匠心灵动14天9G", nav: 1.0120, d30: 0.21, dd: -0.19, gapBp: 9.4 }],
  });
  assert.match(h2, /<td class="rp-down">-0\.19%<\/td>/);
});

test("v118/v119 审计：时刻与期限标签都不算「找不到的数」", () => {
  /* v119 改了口径：原来这条断言 total===2，其中一个是「10年」里切出来的 10 ——
     也就是说它当时是「靠一条误报凑够 2」的。现在 10年、5日、20日 全部按标签整体放行，
     真正被引用的数只剩 1.5981 一个。 */
  const r = reportNumberAudit("截至 15:10，10年国债 1.5981%。", [1.5981]);
  assert.equal(r.total, 1, "时刻与「10年」都该整体抠掉，只剩 1.5981 这一个数");
  assert.deepEqual(r.unknown, [], "时刻/期限碎片不许进 unknown");
  /* 带秒的也一起放行 */
  const r2 = reportNumberAudit("15:14:29 更新，指数 232.40。", [232.4]);
  assert.deepEqual(r2.unknown, []);
  /* 但编造的数照抓 —— 别让这条改动把审计变松 */
  const r3 = reportNumberAudit("截至 15:10，10年国债 9.9999%。", [1.5981]);
  assert.deepEqual(r3.unknown, ["9.9999"]);
});

/* v118：宏观夹具（三项同月，与真机形状一致） */
const MACRO_FIX = { items: [
  { name: "CPI 同比", valText: "0.7%", periodText: "2026年10月", deltaText: "-0.2个百分点" },
  { name: "PPI 同比", valText: "5.7%", periodText: "2026年10月", deltaText: "+0.7个百分点" },
  { name: "制造业 PMI", valText: "49.3", periodText: "2026年10月", deltaText: "-0.8点" },
] };

test("v118 事实层额度（组合）：3 只 + 8 项盘中 + 利差 + 宏观，不许超 1550", () => {
  /* 组合层比单只长：没有净值明细，但每只一行 + 观察项。实测真机（2026-11-10）
     组合形态 1487 字，这里留 63 字余量。
     单只那条额度是 1450，两者分开写 —— 混成一个数会让其中一个失去意义。 */
  const rows = [1, 2, 3].map(i => ({
    name: "产品" + i, nav: 1.01 + i * 0.001, navDate: "2026-10-30",
    d30: 0.3, dd: -0.1, gapBp: 5 + i, w: 30, lag: 1, stale: true,
  }));
  const txt = reportFactsText({
    session: reportSession(new Date("2026-11-09T10:00:00").getTime(), "2026-11-09", "2026-11-06", "13:31"),
    kind: "portfolio", rows, market: MK, gaps: ["资金面：没有 DR001 / DR007"],
    live: LIVE_FIX, macro: MACRO_FIX, today: "2026-11-09",
  });
  assert.ok(txt.length <= 1550, "组合事实层超长了：" + txt.length);
  /* 三个新段一个都不能少 —— 额度是给内容的，不是把内容挤掉 */
  assert.match(txt, /【中票利差】/);
  assert.match(txt, /【宏观】/);
  assert.match(txt, /【盘中参考】/);
});

test("v119 审计：5日 / 20日 的 5 与 20 不进账，但后面的百分比照查", () => {
  const r = reportNumberAudit("国债指数 232.41（-0.03%；5日 +0.12%、20日 +0.46%）。", [232.41, -0.03, 0.12, 0.46]);
  assert.deepEqual(r.unknown, [], "五个数都在白名单，不该有告警");
  /* 期限标签放行不等于放水：编一个不在白名单的百分比照样要被抓出来 */
  const bad = reportNumberAudit("国债指数 232.41（5日 +0.88%、20日 +0.46%）。", [232.41, 0.12, 0.46]);
  assert.deepEqual(bad.unknown, ["+0.88"], "编造的数必须仍被抓住");
});

test("v119 审计：「2026年10月」整段抠掉，不会留下 10 这个碎片", () => {
  const r = reportNumberAudit("CPI 同比 0.7%（2026年10月，较上期 -0.2个百分点）。", [0.7, -0.2]);
  assert.deepEqual(r.unknown, [], "年月是标签，0.7 与 -0.2 在白名单");
  assert.equal(r.total, 2, "只剩两个真实数据");
});
