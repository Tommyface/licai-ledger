/* P1 · AnySearch 检索线索契约单测（公开仓）。
   与私有仓 tests/test_anysearch.py 是同一张判据的两半（双保险），
   另外把「无发布时间」「独立包」「交叉互证」「检索只手动」这几条 UI 红线钉死。 */
import test from "node:test";
import assert from "node:assert/strict";
import * as AY from "../js/core/anysearch.js";
import * as NW from "../js/core/news.js";

const goodHit = (over = {}) => ({
  title: "国债收益率小幅波动",
  snippet: "今日银行间市场成交平稳…",
  url: "https://www.cls.cn/detail/123",
  source: "AnySearch",
  verified: false,
  timeUnknown: true,
  ...over,
});

const goodPack = (over = {}) => ({
  schema: AY.AY_SCHEMA,
  asOf: "2026-11-11 00:50:00",
  promptVer: AY.AY_PROMPT_VER,
  query: "银行理财 债市 资金面",
  hits: [goodHit()],
  gaps: [],
  meta: {
    totalResults: 1, searchTimeMs: 2591, requestId: "rid-ok", dropped: 0,
    rawHash: "sha256:" + "a".repeat(64), verified: false,
  },
  ...over,
});

test("独立包：schema / promptVer 与 news.json 的 clues 契约不同", () => {
  assert.notEqual(AY.AY_SCHEMA, NW.NEWS_SCHEMA);
  assert.notEqual(AY.AY_PROMPT_VER, NW.NEWS_PROMPT_VER);
  assert.equal(AY.AY_SCHEMA, "licai-ledger.anysearch/0.1");
});

test("校验：好包通过", () => {
  assert.deepEqual(AY.validateHits(goodPack()), { ok: true, why: "" });
});

test("校验：空 hits / 带 gaps 的失败包也合法（诚实降级，不臆造线索）", () => {
  const p = goodPack({ hits: [], gaps: ["AnySearch 请求失败（status=402；request_id=rid-x；响应体按官方警告未读取）"] });
  assert.deepEqual(AY.validateHits(p), { ok: true, why: "" });
  const h = AY.anysearchBodyHtml(p, { hasKey: true });
  assert.match(h, /status=402/);
  assert.match(h, /响应体按官方警告未读取/);
});

test("★ 无发布时间红线：hits 里出现任何时间字段整包拒收", () => {
  for (const k of ["publishedAt", "date", "publishTime", "ctime", "showTime"]) {
    const p = goodPack({ hits: [goodHit({ [k]: "2026-11-11 00:50:00" })] });
    const r = AY.validateHits(p);
    assert.equal(r.ok, false, `不许伪造 ${k}`);
    assert.match(r.why, /不许伪造|时间字段/);
  }
});

test("校验：坏包逐项拒收", () => {
  const cases = [
    [goodPack({ schema: "x" }), /schema/],
    [goodPack({ asOf: "nope" }), /asOf/],
    [goodPack({ promptVer: "x" }), /promptVer/],
    [goodPack({ query: "" }), /query/],
    [goodPack({ hits: [goodHit({ url: "not-a-url" })] }), /url/],
    [goodPack({ hits: [goodHit({ source: "财联社" })] }), /source/],
    [goodPack({ hits: [goodHit({ verified: true })] }), /verified/],
    [goodPack({ hits: [goodHit({ timeUnknown: false })] }), /timeUnknown/],
    [goodPack({ hits: [goodHit({ title: "利好 理财" })] }), /禁用词/],
    [goodPack({ meta: { ...goodPack().meta, rawHash: "x" } }), /rawHash/],
    [goodPack({ meta: { ...goodPack().meta, verified: true } }), /verified/],
  ];
  for (const [p, re] of cases) {
    const r = AY.validateHits(p);
    assert.equal(r.ok, false, `应拒收：${re}`);
    assert.match(r.why, re);
  }
});

test("校验：hits 超上限拒收", () => {
  const p = goodPack({ hits: Array.from({ length: 11 }, (_, i) => goodHit({ url: `https://x.com/${i}` })) });
  assert.match(AY.validateHits(p).why, /超上限/);
});

test("交叉互证：同 url / 同标题指纹命中，且不改写原包、不进事实层", () => {
  const hits = [goodHit(), goodHit({ title: "另一条", url: "https://x.com/other" })];
  const clues = [{ url: "https://www.cls.cn/detail/123", title: "国债收益率小幅波动" }];
  const { hits: out, crossCount } = AY.crossCheck(hits, clues);
  assert.equal(crossCount, 1);
  assert.equal(out[0].crossChecked, true);
  assert.equal(out[1].crossChecked, false);
  assert.equal(hits[0].crossChecked, undefined, "不许改写原包");
});

test("交叉互证：clues 为空时全部标单一来源", () => {
  const { crossCount } = AY.crossCheck([goodHit()], []);
  assert.equal(crossCount, 0);
});

test("渲染：检索块写明无发布时间 / 待核 / 非发布时间，且不冒充实时", () => {
  const h = AY.anysearchBodyHtml(goodPack(), { hasKey: true, inApp: true });
  assert.match(h, /无发布时间/);
  assert.match(h, /待核/);
  assert.match(h, /非发布时间/);
  assert.match(h, /检索时刻 2026-11-11 00:50:00/);
  assert.match(h, /不进研判事实层/);
});

test("渲染：互证标签写明「不等于事实已核实」，不误导", () => {
  const h = AY.anysearchBodyHtml(goodPack(), { hasKey: true, clues: [{ url: "https://www.cls.cn/detail/123" }] });
  assert.match(h, /有直抓源互证/);
  assert.match(h, /不等于事实已核实/);
});

test("渲染：key 区只问「有没有」，密码框 value 恒空，明文不进 DOM", () => {
  const h = AY.anysearchBodyHtml(goodPack(), { hasKey: true });
  assert.match(h, /key 已存本机加密区/);
  assert.match(h, /type="password"[^>]*value=""/);
});

test("HTML 转义：标题 / 检索词里的尖括号不会注入", () => {
  const h = AY.anysearchBodyHtml(
    goodPack({ hits: [goodHit({ title: "<script>alert(1)</script>" })], query: "<img src=x>" }),
    { hasKey: true, query: "<img src=x>" });
  assert.doesNotMatch(h, /<script>alert/);
  assert.doesNotMatch(h, /<img src=x>/);
  assert.match(h, /&lt;/);
});

test("渲染：bar 的检索按钮只调 anysearchRun，绝不挂自动刷新", () => {
  const h = NW.newsBlockHtml(null, { channel: "anysearch", inApp: true, ay: null });
  assert.match(h, /anysearchRun\(\)/);
  assert.doesNotMatch(h, /newsRefresh\(\{force:true\}\)/);
  assert.match(h, /一次检索一次配额|需 key/);
});

test("渲染：网页端 anysearch 绕过直传回退 off，检索块不出现", () => {
  const h = NW.newsBlockHtml(null, { channel: "anysearch", inApp: false });
  assert.match(h, /接口已关闭/);
  assert.doesNotMatch(h, /anysearchRun\(\)/);
});
