/* 资产月报的口径（零依赖）：node --test tests/monthly.test.mjs
   月报里的数字用户会拿去和银行 App 对，所以每一个折算口径都必须被执行一次：
     · 月收益 = 逐日「已确认份额 × 净值差」之和，在途不计息；
     · 月末市值 = 已确认份额 × 当日（或之前最近一条）净值；
     · 月年化分母是当月市值，不是今天的市值；
     · 当月报告截断到「今天」，不能报出未来的数。
   另外钉一条恒等式：月末资产 − 月初资产 = 净投入 + 月收益。
   （严格成立的条件是「申购份额 = 金额 ÷ 确认日净值」，构造数据时刻意让它们对齐；
     手工填了份额、与实际成交净值不一致时，这条式子本来就该有差额。） */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthBounds, prevMonth, marketOn, productMonthDays, monthList, monthReport, profitShares,
} from "../js/domain/monthly.js";

/* ---- 基准数据：两只产品，2027-10 一个月 ----
   P1 招银：10-06 确认 10000 份（1.0000 → 1.0100 → 1.0200），10-10 +100、10-20 +100
   P2 农银：10-12 确认 50000 份（1.0000 → 0.9990），10-20 −50
   月收益 = 200 − 50 = 150，月末市值 = 10000×1.02 + 50000×0.999 = 60150 */
const P1 = { id: "p1", name: "招益180天", inst: "招银理财",
  navHistory: { "2027-09-30": 1.0, "2027-10-10": 1.01, "2027-10-20": 1.02 } };
const P2 = { id: "p2", name: "农银现金管理", inst: "农银理财",
  navHistory: { "2027-10-10": 1.0, "2027-10-20": 0.999 } };
const BUY1 = { prodId: "p1", type: "buy", tradeDate: "2027-10-05", confirmDate: "2027-10-06",
  amount: 10000, shares: 10000 };
const BUY2 = { prodId: "p2", type: "buy", tradeDate: "2027-10-11", confirmDate: "2027-10-12",
  amount: 50000, shares: 50000 };
const mk = () => ({ products: [JSON.parse(JSON.stringify(P1)), JSON.parse(JSON.stringify(P2))],
  trades: [{ ...BUY1 }, { ...BUY2 }] });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
/* 净值相减是浮点数（1.01 − 1.0 = 0.010000000000000009），逐日收益只能用近似比较 */
const nearRows = (actual, expected, msg = "") => {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  expected.forEach((e, i) => {
    assert.equal(actual[i][0], e[0], msg);
    near(actual[i][1], e[1], 1e-6);
  });
};

/* ---- 日历工具 ---- */
test("monthBounds：末日与天数跟着闰月走", () => {
  assert.deepEqual(monthBounds(2028, 2), { first: "2028-02-01", last: "2028-02-29", days: 29 });
  assert.deepEqual(monthBounds(2027, 2), { first: "2027-02-01", last: "2027-02-28", days: 28 });
  assert.equal(monthBounds(2027, 12).last, "2027-12-31");
  assert.equal(monthBounds(2027, 10).days, 31);
});

test("prevMonth：1 月退到上年 12 月", () => {
  assert.deepEqual(prevMonth(2027, 1), [2026, 12]);
  assert.deepEqual(prevMonth(2027, 12), [2027, 11]);
});

test("monthList：从最早有净值的月份开始倒排，不凭空造空月", () => {
  const { products } = mk();
  assert.deepEqual(monthList(products, 2027, 10), ["2027-10", "2027-09"]);
  assert.deepEqual(monthList(products, 2027, 12), ["2027-12", "2027-11", "2027-10", "2027-09"]);
  assert.deepEqual(monthList([], 2027, 10), ["2027-10"], "没数据也要能打开当月");
  const long = monthList([P1], 2029, 12);
  assert.equal(long.length, 24, "最多 24 个月，芯片排一屏放得下");
  assert.equal(long[0], "2029-12");
});

/* ---- marketOn ---- */
test("marketOn：只算确认日到账的份额，净值向前取最近一条", () => {
  const { products, trades } = mk();
  assert.equal(marketOn(products, trades, "2027-09-30"), 0, "月初还没建仓");
  assert.equal(marketOn(products, trades, "2027-10-09"), 10000 * 1.0, "10-09 无披露，取 09-30 的净值");
  near(marketOn(products, trades, "2027-10-11"), 10000 * 1.01, 1e-9);
  near(marketOn(products, trades, "2027-10-31"), 60150, 1e-6);
});

test("productMonthDays：首条披露无前值不产生收益，没披露的日子不均摊", () => {
  const { products, trades } = mk();
  nearRows(productMonthDays(products[0], trades, "2027-10-01", "2027-10-31"),
    [["2027-10-10", 100], ["2027-10-20", 100]]);
  /* 10-12 才确认份额，10-10 那天还没钱进来 → 即便有净值差也不该算 */
  const early = { p: { ...P2, navHistory: { "2027-10-05": 1.0, "2027-10-10": 1.01 } },
    t: [{ ...BUY2, confirmDate: "2027-10-12" }] };
  assert.deepEqual(productMonthDays(early.p, early.t, "2027-10-01", "2027-10-31"), []);
});

/* ---- 整份月报 ---- */
test("月报：月收益 = 逐日收益之和，恒等式 change = profit + netInflow", () => {
  const { products, trades } = mk();
  const r = monthReport(products, trades, 2027, 10, "2027-11-05");
  assert.equal(r.isCurrent, false);
  assert.equal(r.end, "2027-10-31");
  assert.equal(r.days, 31);
  nearRows(r.daily, [["2027-10-10", 100], ["2027-10-20", 50]], "同日多产品要合并（+100 −50）、按日期升序");
  near(r.profit, 150, 1e-6);
  near(r.daily.reduce((s, x) => s + x[1], 0), r.profit);
  near(r.cum[r.cum.length - 1][1], r.profit, 1e-6);
  nearRows(r.cum, [["2027-10-10", 100], ["2027-10-20", 150]]);   /* 累计曲线是前缀和 */
  near(r.assetStart, 0);
  near(r.assetEnd, 60150, 1e-6);
  near(r.change, 60150, 1e-6);
  near(r.netInflow, 60000);
  near(r.change, r.profit + r.netInflow, 1e-6);
  assert.equal(r.buyN, 2);
  near(r.buyAmt, 60000);
  assert.equal(r.sellN, 0);
  assert.equal(r.holdN, 2);
  assert.equal(r.best.name, "招益180天");
  near(r.best.profit, 200, 1e-6);
});

test("月报：月年化用当月市值折算，不拿今天的市值摊历史", () => {
  const d = mk();
  const oct = monthReport(d.products, d.trades, 2027, 10, "2027-11-05");
  /* 分母是「报告期末」的市值，不是今天的：10 月赚 150、月末市值 60150、31 天 */
  near(oct.annual, (150 / 60150) * 365 / 31, 1e-9);
  near(oct.annual * 100, 2.936, 0.01, "约 2.94%，是个讲得出口的数");
  /* 11 月再投 4 万（净值也补到 11 月）。若分母误用「今天的市值」，10 月的年化会被新钱压扁 */
  d.trades.push({ prodId: "p1", type: "buy", tradeDate: "2027-11-01", confirmDate: "2027-11-02",
    amount: 40000, shares: 40000 });
  d.products[0].navHistory["2027-11-10"] = 1.03;
  const oct2 = monthReport(d.products, d.trades, 2027, 10, "2027-11-20");
  near(oct2.annual, oct.annual, 1e-12);
  /* 11 月只跑了 20 天：天数取的是 min(今天, 月末) → 20，不是 30 */
  const nov = monthReport(d.products, d.trades, 2027, 11, "2027-11-20");
  assert.equal(nov.days, 20);
  near(nov.profit, 10000 * 0.01 + 40000 * 0.01, 1e-6);
});

test("月报：当月截断到今天，未来日子不出现数", () => {
  const { products, trades } = mk();
  const r = monthReport(products, trades, 2027, 10, "2027-10-15");
  assert.equal(r.isCurrent, true);
  assert.equal(r.end, "2027-10-15");
  assert.equal(r.days, 15);
  nearRows(r.daily, [["2027-10-10", 100]]);   /* 10-20 还没发生 */
  near(r.profit, 100);
  near(r.assetEnd, 10000 * 1.01 + 50000 * 1.0, 1e-6);
  near(r.change, r.profit + r.netInflow, 1e-6);
});

test("月报：在途（确认日晚于报告期末）不计息、不计入净投入", () => {
  const d = mk();
  d.trades.push({ prodId: "p1", type: "buy", tradeDate: "2027-10-28", confirmDate: "2027-11-20",
    amount: 99999, shares: 99999 });
  const r = monthReport(d.products, d.trades, 2027, 10, "2027-11-05");
  near(r.buyAmt, 60000, 1e-9);
  assert.equal(r.buyN, 2);
  near(r.netInflow, 60000, 1e-9);
  near(r.assetEnd, 60150, 1e-6);
  assert.equal(r.holdN, 2);
});

test("月报：赎回按确认日归月，到账金额优先用用户填的 amount", () => {
  const d = mk();
  d.trades.push({ prodId: "p2", type: "sell", tradeDate: "2027-10-24", confirmDate: "2027-10-25",
    shares: 10000, confirmNav: 0.999, amount: 9990, realized: 3 });
  const r = monthReport(d.products, d.trades, 2027, 10, "2027-11-05");
  assert.equal(r.sellN, 1);
  near(r.sellShares, 10000);
  near(r.sellAmt, 9990);
  near(r.realized, 3);
  near(r.netInflow, 60000 - 9990);
  /* 份额 10-25 减掉 → 月末市值只剩 40000 份 */
  near(r.assetEnd, 10000 * 1.02 + 40000 * 0.999, 1e-6);
  /* 没填 amount 时按份额 × 确认净值折算 */
  const d2 = mk();
  d2.trades.push({ prodId: "p2", type: "sell", confirmDate: "2027-10-25",
    shares: 10000, confirmNav: 0.999 });
  const r2 = monthReport(d2.products, d2.trades, 2027, 10, "2027-11-05");
  near(r2.sellAmt, 10000 * 0.999, 1e-9);
});

test("月报：收益构成按机构聚合，资产占比之和为 1", () => {
  const { products, trades } = mk();
  const r = monthReport(products, trades, 2027, 10, "2027-11-05");
  assert.deepEqual(r.byInst.map(x => x.label), ["农银理财", "招银理财"], "按资产从大到小");
  near(r.byInst[0].asset, 49950, 1e-6);
  near(r.byInst[0].profit, -50);
  near(r.byInst[1].asset, 10200, 1e-6);
  near(r.byInst[1].profit, 200);
  near(r.byInst.reduce((s, x) => s + x.share, 0), 1, 1e-9);
  near(r.byInst.reduce((s, x) => s + x.profit, 0), r.profit, 1e-6);
});

test("月报：机构为空的产品归到「未填机构」，不会丢行", () => {
  const p = { id: "p3", name: "无名产品", inst: "  ",
    navHistory: { "2027-10-10": 1.0, "2027-10-20": 1.001 } };
  const t = [{ prodId: "p3", type: "buy", confirmDate: "2027-10-06", amount: 1000, shares: 1000 }];
  const r = monthReport([p], t, 2027, 10, "2027-11-05");
  assert.equal(r.byInst.length, 1);
  assert.equal(r.byInst[0].label, "未填机构");
  near(r.profit, 1, 1e-6);
});

test("月报：空月与清仓月全为 0，年化不除以 0", () => {
  const { products, trades } = mk();
  const empty = monthReport(products, trades, 2027, 6, "2027-11-05");
  assert.equal(empty.profit, 0);
  assert.deepEqual(empty.daily, []);
  assert.deepEqual(empty.cum, []);
  assert.deepEqual(empty.byInst, []);
  assert.equal(empty.annual, 0, "市值为 0 不给年化");
  assert.equal(empty.assetEnd, 0);
  assert.equal(empty.holdN, 0);
  assert.equal(empty.best, null);
  near(empty.change, 0, 1e-9);
});

test("月报：全亏的月份 best 仍指向亏得最少的那只，profit 为负不返回 null", () => {
  const p = { id: "p4", name: "亏本货", inst: "测试", navHistory: { "2027-10-10": 1.0, "2027-10-20": 0.99 } };
  const t = [{ prodId: "p4", type: "buy", confirmDate: "2027-10-05", amount: 10000, shares: 10000 }];
  const r = monthReport([p], t, 2027, 10, "2027-11-05");
  near(r.profit, -100, 1e-6);
  assert.ok(r.annual < 0);
  assert.equal(r.best.name, "亏本货");
  near(r.best.profit, -100, 1e-6);
});

test("profitShares：按绝对值归一，有亏有赚时总和仍为 100%", () => {
  const s = profitShares([{ profit: 200 }, { profit: -50 }]);
  near(s[0], 0.8);
  near(s[1], 0.2);
  assert.deepEqual(profitShares([]), []);
  assert.deepEqual(profitShares([{ profit: 0 }]), [0], "全 0 不除出 NaN");
  const all = profitShares([{ profit: -1 }, { profit: -3 }]);
  near(all.reduce((x, y) => x + y, 0), 1, 1e-12);
});
