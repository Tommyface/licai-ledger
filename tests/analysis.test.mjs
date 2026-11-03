/* 持仓体检（T2）的纯逻辑测试：
     node --test tests/analysis.test.mjs
   覆盖三条口径（js/domain/analysis.js 头部）：
     1. 判定档位齐全、每一项都要有中文档位词；
     2. 结论文本里不许出现金额（会进本机缓存，而「隐藏金额」是显示态）；
     3. 缺输入只输出「信息不足（缺 X）」，不猜、不填默认值。
   指纹与缓存认账本也在这里测 —— 页面层（app.js）只按状态显，不另算一遍。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks, portfolioChecks, anaFingerprint, anaFpSource, normAnaCache, anaCacheState,
  ANA_LEVELS, ANA_LEVEL_TEXT, ANA_CHECK_TITLES, ANA_CACHE_V, ANA_CACHE_MAX } from "../js/domain/analysis.js";

/* 2026-11-03 是周二，10-30 是周五：中间只有 11-02(一) 11-03(二) 两个交易日。 */
const TD = "2026-11-03";

/* 一只「什么都齐」的产品：净值当天、已持有 33 天、六项披露全录且有官方出处。 */
function good(over = {}) {
  const p = {
    id: "p1", name: "稳富某期", inst: "平安理财",
    navHistory: { "2026-10-30": 1, "2026-11-02": 1.0002, "2026-11-03": 1.0005 },
    disc: {
      status: "manual", lockDays: 30, openRule: "每周二开放赎回，T+1 到账",
      investScope: "固定收益类资产不低于 80%",
      feeRedeem: [{ from: 0, to: 7, ratePct: 1.5 }, { from: 7, to: 30, ratePct: 0.5 }, { from: 30, to: null, ratePct: 0 }],
      assets: [{ name: "债券", pct: 80 }, { name: "非标", pct: 20 }],
      source: { url: "https://example.com/disclosure", title: "", publishedAt: "2026-09-30", tier: "official" }
    },
  };
  Object.assign(p, over.product || {});
  if (over.disc) p.disc = Object.assign({}, p.disc, over.disc);
  return p;
}
const BUY = { id: "t1", prodId: "p1", type: "buy", tradeDate: "2026-09-30", confirmDate: "2026-10-01", amount: 1000, confirmNav: 1 };
const ST = { dates: ["2026-10-30", "2026-11-02", "2026-11-03"], wan: [null, 20, 30] };

const byKey = cs => { const m = {}; cs.forEach(c => { m[c.key] = c; }); return m; };
const run = (p, trades, extra = {}) => runChecks({ p, trades, td: TD, st: ST, ...extra });

/* ---------- 1. 档位齐全 ---------- */

test("齐全的产品：九项全过，不该有任何警告", () => {
  const cs = run(good(), [BUY]);
  assert.equal(cs.length, Object.keys(ANA_CHECK_TITLES).length - 2, "单只产品应为 9 项（组合两项不在这里）");
  assert.deepEqual(cs.filter(c => c.level !== "ok").map(c => `${c.key}:${c.level}`), [],
    JSON.stringify(cs.filter(c => c.level !== "ok"), null, 1));
});

test("每一项都要有中文档位词，档位名不能是五种之外的值", () => {
  const cs = run(good({ disc: { lockDays: null } }), [BUY]);
  cs.forEach(c => {
    assert.ok(ANA_LEVELS.indexOf(c.level) >= 0, `非法档位 ${c.level}`);
    assert.ok(ANA_LEVEL_TEXT[c.level], `${c.level} 没有中文档位词`);
    assert.ok(c.title && c.title !== c.key, `${c.key} 缺中文标题`);
  });
  assert.equal(Object.keys(ANA_LEVEL_TEXT).length, ANA_LEVELS.length, "加了档位却没加中文词");
});

test("缺产品标识或日期：只输出一条「信息不足」，不抛异常也不硬判", () => {
  assert.equal(runChecks({ p: {}, trades: [], td: TD }).length, 1);
  assert.equal(runChecks({ p: good(), trades: [], td: "2026/11/03" })[0].level, "na");
  assert.equal(runChecks({}).length, 1);
  assert.equal(runChecks(null).length, 1);
});

/* ---------- 2. 净值 ---------- */

test("一条净值都没有：判「有问题」，而不是假装正常", () => {
  const cs = run(good({ product: { navHistory: {} } }), [BUY]);
  assert.equal(byKey(cs).nav.level, "bad");
  assert.equal(byKey(cs).navGap.level, "na");
});

test("净值停在周五、今天是周二：落后 2 个交易日要提示", () => {
  const cs = run(good({ product: { navHistory: { "2026-10-30": 1 } } }), [BUY]);
  const c = byKey(cs).nav;
  assert.equal(c.level, "warn");
  assert.match(c.text, /2026-10-30/);
  assert.match(c.text, /2 个交易日/);
});

test("披露空档过大才提示：按月披露（31 天）不算异常", () => {
  const monthly = good({ product: { navHistory: { "2026-08-31": 1, "2026-09-30": 1.002, "2026-10-30": 1.004, "2026-11-02": 1.005 } } });
  assert.equal(byKey(run(monthly, [BUY])).navGap.level, "ok");
  const hole = good({ product: { navHistory: { "2026-06-01": 1, "2026-11-02": 1.01, "2026-11-03": 1.011 } } });
  assert.equal(byKey(run(hole, [BUY])).navGap.level, "warn");
});

test("净值 ≤ 0：判「有问题」，因为比值全被它带歪", () => {
  const cs = run(good({ product: { navHistory: { "2026-11-02": 0, "2026-11-03": 1.0005 } } }), [BUY]);
  assert.equal(byKey(cs).value.level, "bad");
  assert.match(byKey(cs).value.text, /1 条/);
});

/* ---------- 3. 成本与净值 ---------- */

test("最新净值偏离单位成本 3 倍以上：提示复核录入", () => {
  const p = good({ product: { navHistory: { "2026-11-03": 5.0005 } } });
  assert.equal(byKey(run(p, [BUY])).value.level, "warn");
  const ok = good({ product: { navHistory: { "2026-11-03": 1.4 } } });
  assert.equal(byKey(run(ok, [BUY])).value.level, "ok");
});

/* ---------- 4/5. 持有期与赎回费 ---------- */

test("持有期没录：「信息不足（缺…）」，绝不按 0 天放行", () => {
  const c = byKey(run(good({ disc: { lockDays: null } }), [BUY])).lock;
  assert.equal(c.level, "na");
  assert.match(c.text, /^信息不足（缺/);
  assert.match(c.text, /最短持有/);
});

test("还在最短持有期内：算出还差几天", () => {
  const c = byKey(run(good({ disc: { lockDays: 90 } }), [BUY])).lock;
  assert.equal(c.level, "warn");
  assert.match(c.text, /还差 57 天/);   /* 已持有 33 天（10-01 → 11-03 净值日） */
});

test("披露写明无持有期：这是「知道且为零」，不是缺失", () => {
  assert.equal(byKey(run(good({ disc: { lockDays: 0 } }), [BUY])).lock.level, "ok");
});

test("赎回费没录：信息不足，并说清算不了什么", () => {
  const c = byKey(run(good({ disc: { feeRedeem: [] } }), [BUY])).fee;
  assert.equal(c.level, "na");
  assert.match(c.text, /赎回费分档/);
});

test("持有天数落进分档空洞：提示补齐，而不是当成 0%", () => {
  const p = good({ disc: { feeRedeem: [{ from: 0, to: 7, ratePct: 1.5 }, { from: 40, to: null, ratePct: 0 }] } });
  const c = byKey(run(p, [BUY])).fee;
  assert.equal(c.level, "warn");
  assert.match(c.text, /空洞/);
});

test("落在收费档也是「正常」：这是披露内容，不是本账本的错误", () => {
  const p = good({ disc: { feeRedeem: [{ from: 30, to: null, ratePct: 0.3 }] } });
  const c = byKey(run(p, [BUY])).fee;
  assert.equal(c.level, "ok");
  assert.match(c.text, /0\.3%/);
});

/* ---------- 6. 出处（铁律 3）---------- */

test("有内容却没出处：判「要注意」，不能显示成未录入", () => {
  const p = good({ disc: { source: null } });
  const c = byKey(run(p, [BUY])).source;
  assert.equal(c.level, "warn");
  assert.match(c.text, /查不到出处/);
});

test("一条都没录：判「信息不足」，并说明上面几项的未披露源于此", () => {
  const p = good({ product: { disc: undefined } });
  const m = byKey(run(p, [BUY]));
  assert.equal(m.source.level, "na");
  assert.match(m.source.text, /一条都没录/);
  assert.equal(m.lock.level, "na");
  assert.equal(m.fee.level, "na");
});

test("六项齐全且有官方出处：出处项为正常，带上分级与披露日期", () => {
  const c = byKey(run(good(), [BUY])).source;
  assert.equal(c.level, "ok");
  assert.match(c.text, /发行机构官网/);
  assert.match(c.text, /2026-09-30/);
});

/* ---------- 7/8. 在途与年化 ---------- */

test("在途未确认：提示市值不含它，且成本/年化两项改为不适用", () => {
  const t = { id: "t2", prodId: "p1", type: "buy", tradeDate: TD, confirmDate: "2026-11-04", amount: 1000 };
  const m = byKey(run(good(), [t]));
  assert.equal(m.pending.level, "warn");
  assert.equal(m.value.level, "skip");
  assert.equal(m.annual.level, "skip");
});

test("买入没填确认日：份额可能提前计入", () => {
  const t = { id: "t3", prodId: "p1", type: "buy", tradeDate: "2026-10-01", amount: 1000 };
  const c = byKey(run(good(), [t])).pending;
  assert.equal(c.level, "warn");
  assert.match(c.text, /没填确认日/);
});

test("持有不足 7 天：年化判「信息不足」，不给一个放大的百分比", () => {
  const t = { id: "t4", prodId: "p1", type: "buy", tradeDate: "2026-11-01", confirmDate: "2026-11-02", amount: 1000, confirmNav: 1 };
  const c = byKey(run(good(), [t])).annual;
  assert.equal(c.level, "na");
  assert.match(c.text, /不足 7 天/);
});

/* ---------- 9. 万份收益挂零 ---------- */

test("本月挂零要提示；没有万收序列的产品改为不适用，不硬判", () => {
  const zero = { dates: ["2026-11-02", "2026-11-03"], wan: [null, 0] };
  assert.equal(byKey(run(good(), [BUY], { st: zero })).zero.level, "warn");
  const navOnly = { dates: ["2026-11-02", "2026-11-03"], wan: [null, null] };
  assert.equal(byKey(run(good(), [BUY], { st: navOnly })).zero.level, "skip");
  assert.equal(byKey(run(good(), [BUY], { st: null })).zero.level, "na");
});

/* ---------- 口径 2：文本里不许有钱 ---------- */

test("结论文本里不出现金额：会进本机缓存，遮罩是显示态", () => {
  const cases = [
    run(good(), [BUY]),
    run(good({ disc: { lockDays: null } }), [BUY]),
    run(good({ product: { navHistory: { "2026-10-30": 1 } } }), [BUY]),
    portfolioChecks([{ id: "p1", name: "稳富", market: 1234567.89 }], 1),
    portfolioChecks([{ id: "p1", name: "稳富", market: 1000 }, { id: "p2", name: "另", market: 1000 }], 2),
  ];
  cases.flat().forEach(c => {
    assert.ok(!/元|￥|¥/.test(c.text), `结论里出现了金额单位：${c.text}`);
    assert.ok(!/\d{1,3}(,\d{3})+(\.\d+)?/.test(c.text), `结论里出现了千分位金额：${c.text}`);
  });
});

/* ---------- 组合层 ---------- */

test("单只占一半以上：组合集中度提示；分散则正常", () => {
  const one = portfolioChecks([{ id: "p1", name: "稳富", market: 9000 }, { id: "p2", name: "另", market: 1000 }], 2);
  assert.equal(byKey(one).conc.level, "warn");
  assert.match(byKey(one).conc.text, /90\.0%/);
  const two = portfolioChecks([{ id: "p1", name: "稳富", market: 5000 }, { id: "p2", name: "另", market: 5000 }], 2);
  assert.equal(byKey(two).conc.level, "ok");
});

test("组合覆盖度：在册但没确认持仓的产品要说出来，不能当成零持仓", () => {
  const m = byKey(portfolioChecks([{ id: "p1", name: "稳富", market: 5000 }], 3));
  assert.equal(m.cover.level, "skip");
  assert.match(m.cover.text, /2 只没有已确认持仓/);
  assert.equal(byKey(portfolioChecks([{ id: "p1", name: "稳富", market: 5000 }], 1)).cover.level, "ok");
  assert.equal(byKey(portfolioChecks([], 0)).conc.level, "na");
});

/* ---------- 指纹 ---------- */

test("指纹稳定：同样的输入永远同一个值，格式为 8 位小写十六进制", () => {
  const a = anaFingerprint({ p: good(), trades: [BUY], td: TD });
  assert.equal(a, anaFingerprint({ p: good(), trades: [BUY], td: TD }));
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("指纹敏感：净值日期、披露规则、交易、日期任一变化都要变", () => {
  const base = anaFingerprint({ p: good(), trades: [BUY], td: TD });
  const navMoved = anaFingerprint({ p: good({ product: { navHistory: { "2026-11-03": 1.0005 } } }), trades: [BUY], td: TD });
  const discEdited = anaFingerprint({ p: good({ disc: { lockDays: 7 } }), trades: [BUY], td: TD });
  const tradeEdited = anaFingerprint({ p: good(), trades: [{ ...BUY, amount: 2000 }], td: TD });
  const nextDay = anaFingerprint({ p: good(), trades: [BUY], td: "2026-11-04" });
  [navMoved, discEdited, tradeEdited, nextDay].forEach(x => assert.notEqual(x, base));
});

test("指纹不受无关字段影响：改产品名、改交易顺序都不该让缓存作废", () => {
  const base = anaFingerprint({ p: good(), trades: [BUY], td: TD });
  const renamed = anaFingerprint({ p: good({ product: { name: "改了个名字" } }), trades: [BUY], td: TD });
  const twoSame = anaFingerprint({ p: good(), trades: [BUY, { ...BUY, id: "t9" }], td: TD });
  assert.equal(renamed, base);
  /* 交易按 id 排序后拼接：换个顺序不该变 */
  const reordered = anaFingerprint({ p: good(), trades: [{ ...BUY, id: "t9" }, BUY], td: TD });
  assert.equal(reordered, twoSame);
});

test("指纹规范串里不含「隐藏金额」这类显示态", () => {
  const src = anaFpSource({ p: good(), trades: [BUY], td: TD });
  ["hideAmount", "mask", "****"].forEach(k => assert.ok(!src.includes(k), `规范串里混进了显示态：${k}`));
  assert.match(src, /id=p1\|td=2026-11-03\|nav=/);
});

/* ---------- 缓存认账本 ---------- */

test("认账本：合法条目原样留下", () => {
  const checks = run(good(), [BUY]);
  const fp = anaFingerprint({ p: good(), trades: [BUY], td: TD });
  const out = normAnaCache({ v: ANA_CACHE_V, byId: { p1: { fp, at: 123, checks } } });
  assert.equal(out.byId.p1.checks.length, checks.length);
  assert.equal(out.byId.p1.at, 123);
  assert.equal(out.v, ANA_CACHE_V);
});

test("认账本：脏数据一律当空账本，绝不修补后放行", () => {
  const checks = run(good(), [BUY]);
  const fp = "a1b2c3d4";
  const good1 = { fp, at: 1, checks };
  assert.deepEqual(normAnaCache(null).byId, {});
  assert.deepEqual(normAnaCache("oops").byId, {});
  assert.deepEqual(normAnaCache({ v: 999, byId: { p1: good1 } }).byId, {}, "版本不符必须整体作废");
  assert.deepEqual(normAnaCache({ v: ANA_CACHE_V, byId: { p1: { fp: "ZZZZ", at: 1, checks } } }).byId, {}, "指纹形状不对");
  assert.deepEqual(normAnaCache({ v: ANA_CACHE_V, byId: { p1: { fp, at: -3, checks } } }).byId, {}, "时间戳非法");
  assert.deepEqual(normAnaCache({ v: ANA_CACHE_V, byId: { p1: { fp, at: 1, checks: [] } } }).byId, {}, "空结论不算结论");
  assert.deepEqual(normAnaCache({ v: ANA_CACHE_V, byId: { p1: { fp, at: 1, checks: [{ key: "nav", level: "great", text: "x" }] } } }).byId, {},
    "档位不认识就不能放行");
  assert.deepEqual(normAnaCache({ v: ANA_CACHE_V, byId: { p1: { fp, at: 1, checks: [{ key: "nav", title: "净值披露", level: "ok", text: "" }] } } }).byId, {},
    "空文本不能显示成一个光点");
});

test("认账本：一条坏不连累别条", () => {
  const checks = run(good(), [BUY]);
  const out = normAnaCache({ v: ANA_CACHE_V, byId: {
    p1: { fp: "a1b2c3d4", at: 1, checks },
    p2: { fp: "bad", at: 1, checks },
    p3: { fp: "ffffffff", at: 2, checks } } });
  assert.deepEqual(Object.keys(out.byId).sort(), ["p1", "p3"]);
});

test("认账本：超上限按时间淘汰最旧的，保留最新的", () => {
  const checks = run(good(), [BUY]);
  const byId = {};
  for (let i = 0; i < ANA_CACHE_MAX + 5; i++) byId["p" + i] = { fp: "a1b2c3d4", at: 1000 + i, checks };
  const out = normAnaCache({ v: ANA_CACHE_V, byId });
  assert.equal(Object.keys(out.byId).length, ANA_CACHE_MAX);
  assert.equal(out.byId["p" + (ANA_CACHE_MAX + 4)].at, 1000 + ANA_CACHE_MAX + 4, "最新一条必须活着");
  assert.equal(out.byId.p0, undefined, "最旧一条应被淘汰");
});

test("三态：没记录 = none，指纹一致 = fresh，不一致 = stale", () => {
  const checks = run(good(), [BUY]);
  assert.equal(anaCacheState(undefined, "a1b2c3d4").state, "none");
  assert.equal(anaCacheState(null, "a1b2c3d4").state, "none");
  assert.equal(anaCacheState({ fp: "a1b2c3d4", at: 1, checks }, "a1b2c3d4").state, "fresh");
  const stale = anaCacheState({ fp: "00000000", at: 1, checks }, "a1b2c3d4");
  assert.equal(stale.state, "stale");
  assert.equal(stale.checks.length, checks.length, "stale 也要把旧结论交回页面，由页面说它过期了");
});
