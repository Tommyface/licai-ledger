/* 信息面线索（S1 · v120）契约单测。跑法：node --test tests/news.test.mjs
   ★ 与私有仓 tests/test_news.py 是同一张判据的两半；这里额外盯网页端特有的三条：
     1. 不冒充实时 —— cloud 通道必须写「数据时点」与「非实时」；
     2. 不进事实层 —— 模块不导出任何 newsText / newsFacts / aiText 出口；
     3. 接口开关 —— 网页端只放行 off/cloud，apk/anysearch 置灰（仅 App 内），且不许绕过；
        P1 起 App 内另放行 anysearch（端点跑通、key 由桥注入）。
   另外把资金面陈旧闸门（实测 2023/2025 历史样本）在 JS 侧再钉一遍。 */
import test from "node:test";
import assert from "node:assert/strict";
import * as NW from "../js/core/news.js";

const goodClue = (over = {}) => ({
  title: "某主体公告：拟发行 3 年期中期票据",
  summary: "公告显示，本期发行规模不超过 10 亿元。",
  source: "财联社",
  url: "https://www.cls.cn/detail/2530546",
  publishedAt: "2026-11-10 18:50:15",
  fetchedAt: "2026-11-10 19:40:00",
  verified: false,
  ...over,
});

const goodNews = (over = {}) => ({
  schema: NW.NEWS_SCHEMA,
  asOf: "2026-11-10 19:40:00",
  promptVer: NW.NEWS_PROMPT_VER,
  funding: {
    label: "银银间回购定盘利率 FDR（基于 DR 取中位数，非 DR 本身）",
    asOf: "2026-11-10",
    source: "中国货币网（外汇交易中心）",
    sourceUrl: "https://www.chinamoney.com.cn/chinese/bkfrr/",
    rows: [{ tenor: "FDR001", value: 1.32, unit: "%" },
           { tenor: "FDR007", value: 1.34, unit: "%" },
           { tenor: "FDR014", value: 1.35, unit: "%" }],
    fr: { FR001: 1.39, FR007: 1.42, FR014: 1.42 },
    frAsOf: "2026-11-10",
    note: "日频定盘，11:30 后发布；不与【盘中参考】混算，也不是 DR 加权均价；数据陈旧时不展示数值",
  },
  clues: [goodClue()],
  gaps: [],
  meta: { sources: 5, sourcesOk: 5, clueCount: 1, dropped: 0,
    rawHash: "sha256:" + "a".repeat(64), verified: false },
  ...over,
});

test("常量：schema / promptVer / 禁用词 / 上限 与私有仓同源", () => {
  assert.equal(NW.NEWS_SCHEMA, "licai-ledger.news/0.1");
  assert.equal(NW.NEWS_PROMPT_VER, "news-1");
  assert.equal(NW.NEWS_MAX_CLUES, 40);
  assert.equal(NW.NEWS_STALE_DAYS, 10);
  assert.deepEqual(NW.NEWS_SOURCES, ["财联社", "东财7x24", "华尔街见闻", "AnySearch"]);
  assert.deepEqual(NW.NEWS_FORBIDDEN, ["超预期", "低于预期", "利好", "利空", "建议买入", "建议卖出",
    "预计明日", "收益率预测", "DR001 报", "DR007 报"]);
});

test("接口开关：网页端只放行 off / cloud，apk / anysearch 一律仅 App 内", () => {
  assert.equal(NW.NEWS_CHANNELS.length, 4);
  assert.equal(NW.newsChannelAllowed("off"), true);
  assert.equal(NW.newsChannelAllowed("cloud"), true);
  assert.equal(NW.newsChannelAllowed("apk"), false);
  assert.equal(NW.newsChannelAllowed("anysearch"), false);
  assert.equal(NW.newsChannelAllowed("nonsense"), false);
  assert.equal(NW.NEWS_CHANNELS.filter(c => c.web).length, 2);
});

test("校验：好包通过，返回 {ok:true}", () => {
  assert.deepEqual(NW.validateNews(goodNews()), { ok: true, why: "" });
});

test("校验：坏包逐项拒收（schema/时点/口径/url/verified/源/禁用词/rawHash）", () => {
  const bad = [
    ["schema", n => { n.schema = "other/9"; }],
    ["asOf", n => { n.asOf = "刚刚"; }],
    ["promptVer", n => { n.promptVer = "news-0"; }],
    ["funding.label 冒充 DR", n => { n.funding.label = "DR001 1.32%"; }],
    ["funding.sourceUrl", n => { n.funding.sourceUrl = "javascript:alert(1)"; }],
    ["裸写 DR001 的 tenor", n => { n.funding.rows = [{ tenor: "DR001", value: 1.32 }]; }],
    ["value 是字符串", n => { n.funding.rows[0].value = "1.32"; }],
    ["fr 非法键", n => { n.funding.fr = { DR001: 1.3 }; }],
    ["clues 超上限", n => { n.clues = Array.from({ length: 41 }, () => goodClue()); }],
    ["缺 url", n => { n.clues[0].url = ""; }],
    ["url 非 http", n => { n.clues[0].url = "javascript:alert(1)"; }],
    ["缺 publishedAt", n => { n.clues[0].publishedAt = "刚刚"; }],
    ["verified=true", n => { n.clues[0].verified = true; }],
    ["source 不在白名单", n => { n.clues[0].source = "某自媒体"; }],
    ["命中禁用词", n => { n.clues[0].title = "数据超预期，债市走强"; }],
    ["rawHash 不是 sha256", n => { n.meta.rawHash = "abc"; }],
    ["meta.verified=true", n => { n.meta.verified = true; }],
    ["gaps 不是数组", n => { n.gaps = "无"; }],
  ];
  for (const [name, mut] of bad) {
    const n = goodNews(); mut(n);
    assert.equal(NW.validateNews(n).ok, false, `${name} 竟被放过`);
  }
});

test("陈旧闸门：带数值就必须是新鲜 asOf（2023/2025 历史样本一律拒）", () => {
  assert.equal(NW.newsDaysBetween("2026-11-10", "2026-11-10 20:14:57"), 0);
  assert.equal(NW.newsDaysBetween("2026-11-01", "2026-11-10 20:14:57"), 9);
  assert.equal(NW.newsDaysBetween("2025-11-10", "2026-11-10 20:14:57"), 365);
  assert.ok(Number.isNaN(NW.newsDaysBetween("", "2026-11-10 20:14:57")));
  assert.equal(NW.newsFundingStale("2026-11-10", "2026-11-10 20:14:57"), false);
  assert.equal(NW.newsFundingStale("2026-10-31", "2026-11-10 20:14:57"), false, "恰好 10 天是阈值内");
  assert.equal(NW.newsFundingStale("2026-10-30", "2026-11-10 20:14:57"), true, "11 天应判陈旧");
  assert.equal(NW.newsFundingStale("", "2026-11-10 20:14:57"), true);
  assert.equal(NW.newsFundingStale("2026-11-11", "2026-11-10 20:14:57"), true, "未来日期");

  const n = goodNews(); n.funding.asOf = "2025-11-10";
  assert.match(NW.validateNews(n).why, /陈旧/);
  const n2 = goodNews(); n2.funding.frAsOf = "2023-11-10";
  assert.match(NW.validateNews(n2).why, /陈旧/);
  /* 已清空的诚实空包照过（空值不触发陈旧判据） */
  const n3 = goodNews();
  n3.funding.asOf = "2025-11-10"; n3.funding.frAsOf = "2023-11-10";
  n3.funding.rows = []; n3.funding.fr = {};
  assert.equal(NW.validateNews(n3).ok, true);
});

test("缓存：版本 / 来源不对或坏包一律 null", () => {
  const n = goodNews();
  const p = NW.newsPack(n, 1000);
  assert.ok(p);
  assert.equal(p.v, NW.NEWS_VER);
  assert.equal(p.at, 1000);
  assert.deepEqual(NW.newsUnpack(p), n);
  assert.equal(NW.newsUnpack({ ...p, v: 999 }), null);
  assert.equal(NW.newsUnpack({ ...p, src: "other" }), null);
  const broken = goodNews(); broken.clues[0].verified = true;
  assert.equal(NW.newsPack(broken, 1000), null);
  assert.equal(NW.newsUnpack({ ...p, news: broken }), null);
});

test("数据时点：按北京 +08:00 解析，不冒充实时", () => {
  const n = goodNews();
  const now = Date.parse("2026-11-10T12:00:00Z");   /* 北京 20:00 */
  const s = NW.newsAsOfText(n, now);
  assert.match(s, /数据时点 2026-11-10 19:40:00（北京）/);
  assert.match(s, /20 分钟前/);
  assert.equal(NW.newsAsOfText({ asOf: "坏" }), "");
});

test("渲染：cloud 通道必须显式写数据时点、非实时、待核与原文链接", () => {
  const h = NW.newsBlockHtml(goodNews(), { channel: "cloud" });
  assert.match(h, /数据时点 2026-11-10/);
  assert.match(h, /非实时/);
  assert.match(h, /云端快照/);
  assert.match(h, /待核/);
  assert.match(h, /https:\/\/www\.cls\.cn\/detail\/2530546/);
  assert.match(h, /非 DR 本身/);
  assert.match(h, /FDR001/);
});

test("渲染：off 通道不渲染任何线索", () => {
  const h = NW.newsBlockHtml(goodNews(), { channel: "off" });
  assert.doesNotMatch(h, /cls\.cn\/detail/);
  assert.match(h, /接口已关闭/);
  assert.match(h, /<button class="nw-upd" disabled/);
});

test("渲染：apk / anysearch 选项 disabled 且标「仅 App 内」；绕过置灰一律回落 off", () => {
  const h = NW.newsBlockHtml(goodNews(), { channel: "cloud" });
  assert.match(h, /<option value="apk"[^>]*disabled/);
  assert.match(h, /<option value="anysearch"[^>]*disabled/);
  assert.match(h, /仅 App 内/);
  for (const ch of ["apk", "anysearch", "nonsense"]) {
    const forced = NW.newsBlockHtml(goodNews(), { channel: ch });
    assert.match(forced, /接口已关闭/, `${ch} 不许在网页端渲染线索`);
    assert.doesNotMatch(forced, /cls\.cn\/detail/);
  }
});

test("渲染：陈旧 / 缺失的资金面不显示任何数值，明说不以历史样本补位", () => {
  const n = goodNews();
  n.funding.asOf = "2025-11-10"; n.funding.rows = []; n.funding.fr = {};
  const h = NW.newsBlockHtml(n, { channel: "cloud" });
  assert.match(h, /资金面暂缺/);
  assert.match(h, /不以历史样本补位/);
  assert.doesNotMatch(h, /1\.32/);
  assert.doesNotMatch(h, /1\.39/);
});

test("渲染：线索文本转义，缺口清单照实列出", () => {
  const n = goodNews({
    clues: [goodClue({ title: "<script>alert(1)</script>", summary: "<img src=x>" })],
    gaps: ["货币网 FDR 抓取失败：HTTPError", "货币网 FR 抓取失败：HTTPError"],
  });
  const h = NW.newsBlockHtml(n, { channel: "cloud" });
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;/);
  assert.doesNotMatch(h, /<img src=x>/);
  assert.match(h, /本轮缺口/);
  assert.match(h, /HTTPError/);
});

test("渲染：正在读取 / 读失败两种降级都写清原因，不编数据", () => {
  const loading = NW.newsBlockHtml(null, { channel: "cloud", phase: "loading" });
  assert.match(loading, /正在读取云端快照/);
  const err = NW.newsBlockHtml(null, { channel: "cloud", phase: "err", err: "同步未就绪" });
  assert.match(err, /同步未就绪/);
  assert.doesNotMatch(err, /<li class="nw-c">/);
});

test("红线：模块不导出任何给研判的文本出口（不进事实层）", () => {
  const keys = Object.keys(NW);
  for (const k of keys) {
    assert.doesNotMatch(k, /^(newsText|newsFacts|newsAiText|aiText)$/i, `不该导出 ${k}`);
    assert.doesNotMatch(k, /Facts$/i, `不该导出事实层出口 ${k}`);
  }
  assert.ok(keys.includes("validateNews"));
  assert.ok(keys.includes("newsBlockHtml"));
});

/* ---- v121 · S2 + v122 · P1：接口开关按环境判定 ---- */
test("通道判定：网页端只放行 web，APK 内另放行 apk / anysearch", () => {
  assert.equal(NW.newsChannelAllowed("apk"), false);
  assert.equal(NW.newsChannelAllowed("apk", { inApp: true }), true);
  assert.equal(NW.newsChannelAllowed("anysearch"), false);
  assert.equal(NW.newsChannelAllowed("anysearch", { inApp: true }), true);  /* P1：端点跑通了 */
  assert.equal(NW.newsChannelAllowed("cloud", { inApp: true }), true);
  assert.equal(NW.newsChannelAllowed("nonsense", { inApp: true }), false);
  assert.equal(NW.NEWS_CHANNELS.filter(c => c.app).length, 4);
});

test("newsBlockHtml：APK 内 apk 通道可选且写明非实时；网页端绕过直传也回退 off", () => {
  const app = NW.newsBlockHtml(goodNews(), { channel: "apk", inApp: true });
  assert.ok(app.includes("本机直抓"));
  assert.ok(app.includes("非实时"));
  assert.ok(!/value="apk"[^>]*disabled/.test(app), "APK 内 apk 档不该置灰");
  const web = NW.newsBlockHtml(goodNews(), { channel: "apk" });
  assert.ok(web.includes("接口已关闭"), "网页端绕过直传 apk 也必须回退 off");
  assert.ok(/value="apk"[^>]*disabled/.test(web));
});

test("newsBlockHtml：P1 anysearch 在 App 内可选并渲染检索块；网页端绕过直传回退 off", () => {
  const app = NW.newsBlockHtml(goodNews(), { channel: "anysearch", inApp: true });
  assert.ok(app.includes("AnySearch 检索线索"));
  assert.ok(app.includes("🔍 检索"));
  assert.ok(app.includes("anysearchRun()"), "检索按钮只调手动检索，绝不挂自动刷新");
  assert.ok(!/value="anysearch"[^>]*disabled/.test(app), "APK 内 anysearch 档不该置灰");
  assert.ok(!app.includes("cls.cn/detail"), "检索块不渲染四源 clues");
  const web = NW.newsBlockHtml(goodNews(), { channel: "anysearch" });
  assert.ok(web.includes("接口已关闭"), "网页端绕过直传 anysearch 也必须回退 off");
  assert.ok(/value="anysearch"[^>]*disabled/.test(web));
});
