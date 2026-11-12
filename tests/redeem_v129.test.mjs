/* v129 · 赎回结算专项回归（诚享7天29号 2026-11-11 全部赎回复盘）
     node --test tests/redeem_v129.test.mjs

   背景：旧版赎回让用户手填「确认净值日期」，被填成前一披露日 11-10（1.0156），
   而银行按申请日 11-11 的净值 1.0154 结算：69,217.84 × 1.0154 = 70,283.79。
   App 记成 70,295.80 / 已实现 +295.84，虚高 12.01 / 12.05；同时只赎回
   69,217.80 份留下 0.04 份尾差，产品永远停在「持仓中」继续计当日盈亏 −12.67。

   这组用例钉住四件事：
     · 结算净值精确命中 T 日（绝不能向前取 T-1），T 日净值披露后自动回冲；
     · 全额赎回份额严格清零，结算金额 = 全额份额 × T 日净值；
     · 赎回 T 日冻结份额，T 日收益不再在日收益里重复计一遍；
     · 页面/月报一律读 settleLedger 动态结算值，不读交易对象上写死的静态字段。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computePosition, sharesOn, settleNav, settleLedger, settleDateOf, hasAnyTrade,
} from "../js/domain/position.js";
import { monthReport } from "../js/domain/monthly.js";

const near = (a, b, tol = 0.01, msg = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} 期望 ${b}，实得 ${a}`);

/* 买入：70,000 / 1.0113 = 69,217.84 份 */
const BUY = {
  id: "b1", prodId: "cx29", type: "buy",
  tradeDate: "2026-09-07", confirmDate: "2026-09-07",
  amount: 70000, confirmNav: 1.0113, shares: 69217.84,
};
/* 新版赎回：申请日 11-11 → 按 T 日净值结算 → 11-12 到账 */
const SELL = {
  id: "s1", prodId: "cx29", type: "sell",
  tradeDate: "2026-11-11", confirmDate: "2026-11-12",
  settleDate: "2026-11-11", arrivalDate: "2026-11-12",
  shares: 69217.84, confirmNav: 1.0156, fullRedeem: true,
  amount: 70283.79, realized: 283.79,
};
/* 存量坏数据：净值日期被填成 11-10、份额少 0.04 份、金额与已实现都是旧错值。
   settleDate 缺省，靠 settleDateOf 回落到申请日 11-11 自动修正。 */
const OLD_SELL = {
  id: "s1", prodId: "cx29", type: "sell",
  tradeDate: "2026-11-11", confirmDate: "2026-11-11",
  confirmNavDate: "2026-11-10", confirmNav: 1.0155740286458107,
  shares: 69217.80, amount: 70295.80, realized: 295.84,
};
const NAV = { "2026-11-10": 1.015583, "2026-11-11": 1.0154 };
const prod = () => ({ id: "cx29", navHistory: { ...NAV } });

test("settleNav：精确命中 T 日已披露净值，绝不向前取到 T-1 的旧净值", () => {
  const p = prod();
  assert.equal(settleDateOf(SELL), "2026-11-11");
  assert.equal(settleDateOf(OLD_SELL), "2026-11-11", "老数据没有 settleDate 时回落到申请日");
  assert.equal(settleNav(SELL, p), 1.0154);
  assert.equal(settleNav(OLD_SELL, p), 1.0154, "老数据填错的净值日期不再生效");
  /* 这是 12.01 元差额的根因：navHit 会落到 11-10 的 1.015583 */
  assert.ok(Math.abs(1.015583 - 1.0154) * 69217.84 > 12);
});

test("settleNav：T 日净值未披露时回落 confirmNav，披露后自动回冲", () => {
  const p = { id: "cx29", navHistory: { "2026-11-10": 1.0155740286458107 } };
  near(settleNav(SELL, p), 1.0156, 1e-9, "未披露时先用录入时暂存的 confirmNav");
  const before = computePosition(p, [BUY, SELL], "2026-11-12").realized;
  near(before, 297.64, 0.02, "暂存期间按暂存净值结算");
  /* 官方补出 T 日净值 → 同一批交易重算即回冲，无需改任何交易记录 */
  p.navHistory["2026-11-11"] = 1.0154;
  near(settleNav(SELL, p), 1.0154, 1e-9, "披露后取真值");
  const pos = computePosition(p, [BUY, SELL], "2026-11-12");
  near(pos.realized, 283.79, 0.01, "披露后已实现自动回冲");
  assert.ok(Math.abs(before - pos.realized) > 12, "回冲掉的正是 T 日那段收益");
});

test("全额赎回：结算金额 = 69,217.84 × 1.0154 = 70,283.79，已实现 +283.79，份额清零", () => {
  const p = prod();
  const pos = computePosition(p, [BUY, SELL], "2026-11-12");
  assert.equal(pos.shares, 0, "全额赎回后份额必须严格归零");
  assert.equal(pos.cost, 0);
  assert.equal(pos.market, 0);
  near(pos.realized, 283.79, 0.01, "银行口径已实现");
  const s = pos.settles.s1;
  assert.ok(s, "settles 要按 trade.id 记录单笔结算");
  near(s.proceeds, 70283.79, 0.01, "结算金额与银行到账一致");
  near(s.realized, 283.79, 0.01);
  assert.equal(s.nav, 1.0154);
  assert.ok(s.full, "应标记为全额赎回");
  assert.ok(hasAnyTrade(p, [BUY, SELL]), "有交易记录 → 应归入「已清仓」而非从未建仓");
});

test("存量坏数据自动修正：净值取 T 日、0.04 份尾差按全额清零，无需改单", () => {
  const p = prod();
  const pos = computePosition(p, [BUY, OLD_SELL], "2026-11-12");
  assert.equal(pos.shares, 0, "0.04 份尾差不能再让产品留在「持仓中」");
  near(pos.settles.s1.proceeds, 70283.79, 0.01, "结算金额自动回冲到 70,283.79");
  near(pos.realized, 283.79, 0.01, "已实现自动回冲到 283.79");
  /* 静态字段仍是旧错值，页面必须读 settles 而不是 t.amount / t.realized */
  assert.equal(OLD_SELL.realized, 295.84);
  assert.equal(OLD_SELL.amount, 70295.80);
  assert.notEqual(pos.settles.s1.realized, OLD_SELL.realized);
});

test("赎回 T 日冻结份额：11-10 仍持有、11-11 起为 0，不再重复计当日盈亏", () => {
  const p = prod();
  near(sharesOn(p, [BUY, SELL], "2026-11-10"), 69217.84, 1e-9);
  assert.equal(sharesOn(p, [BUY, SELL], "2026-11-11"), 0);
  assert.equal(sharesOn(p, [BUY, OLD_SELL], "2026-11-11"), 0, "老数据的 0.04 份尾差同样归零");
  /* 11-11 的净值差收益已含在 T 日结算净值里，日收益不应再算一次 */
  const dayP = sharesOn(p, [BUY, SELL], "2026-11-11") * (1.0154 - 1.015583);
  assert.equal(Math.abs(dayP), 0, "T 日收益只在 realized 里结一次");
});

test("settleLedger：与 computePosition 同源，累计已实现不再累加静态 t.realized", () => {
  const p = prod();
  const map = settleLedger([p], [BUY, OLD_SELL], "2026-11-12");
  near(map.s1.proceeds, 70283.79, 0.01);
  near(map.s1.realized, 283.79, 0.01);
  const pos = computePosition(p, [BUY, OLD_SELL], "2026-11-12");
  assert.equal(map.s1.realized, pos.realized, "页面与持仓计算必须同一个数");
});

test("月报：传入 settleMap 时到账金额/已实现取动态结算值（按到账日归月）", () => {
  const p = prod();
  const td = "2026-11-12";
  const map = settleLedger([p], [BUY, OLD_SELL], td);
  const r = monthReport([p], [BUY, OLD_SELL], 2026, 11, td, map);
  assert.equal(r.sellN, 1);
  near(r.sellAmt, 70283.79, 0.01, "月报到账金额与银行一致");
  near(r.realized, 283.79, 0.01, "月报已实现与首页同源");
});

/* ---- 接线钉子：改回旧写法就红 ---- */
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("接线：赎回表单锁 T 日、有全部赎回按钮、渲染走 settleLedger 动态值", () => {
  assert.match(app, /function syncSettleNav\(\)/);
  assert.match(app, /navAt\(p, td\)/, "结算净值必须精确命中 T 日，不能用 navHit 向前取");
  assert.match(app, /function tradeFullRedeem\(\)/);
  assert.match(app, /onclick="tradeFullRedeem\(\)"/, "全部赎回按钮由交易表单模板输出");
  assert.match(app, /t\.settleDate = tradeDate;/);
  assert.match(app, /t\.arrivalDate = confirmDate;/);
  assert.match(app, /const settles = settleLedger\(DATA\.products, DATA\.trades, today\(\)\)/,
    "交易记录与已实现清单必须读动态结算表");
  assert.match(app, /const totalRealized = all\.reduce\(\(s, r\) => s \+ r\.pos\.realized, 0\)/,
    "累计已实现必须与持仓计算同源");
  assert.match(app, /settleLedger\(DATA\.products, DATA\.trades, td\)/,
    "月报也要吃动态结算表");
  assert.ok(pkg.scripts.test.includes("tests/redeem_v129.test.mjs"),
    "专项回归要登记进 npm test 硬编码清单");
});

test("接线：阶段 1 自检已下线、监控池排除已清仓产品", () => {
  assert.ok(!/QUOTA_PROBE_MODE|quotaProbeRun|quotaPickSet|const QUOTA_ST/.test(app));
  assert.ok(!/id="quotaPick"|id="quotaResult"|id="quotaCodes"/.test(html));
  assert.match(app, /function monitorPoolProducts\(\)/);
  assert.match(app, /hasAnyTrade\(p\) && position\(p\)\.shares <= 0/,
    "已清仓判定：有过交易且份额归零；从未建仓的产品仍可监控");
});
