// @ts-check
/* 持仓计算：份额、成本（加权平均）、市值、浮盈、已实现、持有天数/年化。
   全部纯函数 —— 交易列表与「今天」由调用方传入，方便单测和跨天复用。

   v129 · 赎回结算口径（2026-11-12 诚享7天29号复盘）：
     · 净值型产品 T 日申请赎回 → 按 T 日净值确认份额与金额 → T+1 资金到账；
       T 日收益已含在结算净值里，赎回日不再单列当日盈亏。
     · 结算净值必须取「T 日当天已披露」的值；T+1 披露后自动回冲。绝不能用
       navHit（向前取最近）落到 T-1 的旧净值 —— 那正是 12.01 元差额的来源。
     · 赎回份额在 T 日冻结（按申请日扣减），申购才按 T+1 确认日到账，两者口径不同。
     · 不足 0.1 份的尾差视为「全部赎回」，否则 0.04 份残留会让产品永远留在
       「持仓中」并按净值继续计盈亏。 */

import { dayDiff } from "../core/util.js";
import { latestNav, navAt, navHit, navSeries as navSeriesOf } from "./nav.js";

/**
 * @typedef {{ id?: string, navHistory?: Record<string, number | string> }} PositionProduct
 * @typedef {{ id?: string, prodId?: string, type?: string, tradeDate?: string, confirmDate?: string,
 *             confirmNavDate?: string, confirmNav?: number | string, settleDate?: string,
 *             arrivalDate?: string, fullRedeem?: boolean, navPending?: boolean,
 *             amount?: number | string, shares?: number | string, realized?: number | string }} Trade
 * @typedef {{
 *   shares: number, cost: number, market: number, profit: number, realized: number,
 *   lastNav: number, lastDate: string, startDate: string,
 *   holdDays: number, holdAnnual: number, annualValid: boolean,
 *   pendingShares: number, pendingAmount: number, hasPending: boolean, inTransit: boolean,
 *   navPendingCount: number,
 *   navSeries: [string, number][],
 *   settles: Record<string, { nav: number, shares: number, proceeds: number,
 *                            costOut: number, realized: number, full: boolean }>
 * }} Position
 */

/**
 * 某交易发生的确认净值：优先用户填的，否则取确认日（或买入日）当天净值。
 * 只用于「申购份额 = 金额 / 净值」；赎回结算走 settleNav()，口径不同。
 * @param {Trade} t
 * @param {PositionProduct} p
 * @returns {number}
 */
export function resolveTradeNav(t, p) {
  /* v133：按产品购买规则买入、份额等「确认净值日」的净值披露后才确定。
     必须精确命中当日（navAt），绝不能 navHit 向前取最近 —— 那正是
     「11.13 净值未出、却拿 11.06 的旧净值把份额算死、凭空冒出 -28.91 浮亏」
     的根因。未披露时返回 0（份额待定），披露后自动用真实净值重算（回冲）。 */
  if (t.navPending && t.type === "buy") {
    const d = t.confirmNavDate || t.confirmDate || t.tradeDate;
    const v = d ? navAt(p, d) : undefined;
    return (v !== undefined && v !== null && v !== "" && Number(v) > 0) ? Number(v) : 0;
  }
  if (t.confirmNav) return Number(t.confirmNav);
  const d = t.confirmNavDate || t.confirmDate || t.tradeDate;
  const hit = navHit(p, d);
  return hit ? Number(hit[1]) : 0;
}

/**
 * v133：这笔买入是否「净值待确认」（确认净值日的净值尚未披露）。
 * 只有标记了 navPending 的买入才可能是；老交易一律 false，行为零回归。
 * @param {Trade} t
 * @param {PositionProduct} p
 * @returns {boolean}
 */
export function buyNavPending(t, p) {
  if (!t || t.type !== "buy" || !t.navPending) return false;
  const d = t.confirmNavDate || t.confirmDate || t.tradeDate;
  if (!d) return false;
  const v = navAt(p, d);
  return !(v !== undefined && v !== null && v !== "" && Number(v) > 0);
}

/**
 * 计算份额 & 成本
 * @param {Trade} t
 * @param {PositionProduct} p
 * @returns {number}
 */
export function tradeShares(t, p) {
  const nav = resolveTradeNav(t, p);
  if (t.type === "buy") {
    if (t.shares) return Number(t.shares);
    return nav > 0 ? Number(t.amount) / nav : 0;
  } else {
    return Number(t.shares || 0);
  }
}

/** 赎回结算净值所属日（T 日 = 申请日）。老数据没有 settleDate 时回落到申请日。 */
export function settleDateOf(t) {
  return t.settleDate || t.tradeDate || t.confirmNavDate || t.confirmDate || "";
}

/**
 * 赎回结算净值：T 日**当天已披露**的净值优先（披露后自动回冲），
 * 否则用录入时暂存的 confirmNav（T 日净值未披露时的兜底）。
 * ⚠️ 必须精确命中当天：navHit 会向前取最近，T 日未披露时会静默落到 T-1，
 *    结算金额就会虚高一段 T 日收益 —— 这是本次修复的根因。
 * @param {Trade} t
 * @param {PositionProduct} p
 * @returns {number}
 */
export function settleNav(t, p) {
  const d = settleDateOf(t);
  const v = d ? navAt(p, d) : undefined;
  if (v !== undefined && v !== null && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number(t.confirmNav) || 0;
}

/** 交易生效日：赎回按 T 日（申请日）冻结份额，申购按 T+1 确认日入账。 */
export function effTradeDate(t) {
  return t.type === "sell"
    ? (t.settleDate || t.tradeDate || t.confirmDate || "")
    : (t.confirmDate || t.tradeDate || "");
}

/**
 * 截至 date 已确认的持仓份额（只累加生效日 <= date 的交易）
 * @param {PositionProduct} p
 * @param {ReadonlyArray<Trade>} trades
 * @param {string} date
 * @returns {number}
 */
export function sharesOn(p, trades, date) {
  let sh = 0;
  for (const t of trades) {
    if (t.prodId !== p.id) continue;
    /* 申购：T+1 确认才有份额；赎回：T 日申请即冻结份额（按 T 日净值结算）。 */
    const cd = effTradeDate(t);
    if (!cd || cd > date) continue;              /* 未生效：份额还没到账/还没冻结 */
    if (t.type === "buy") sh += tradeShares(t, p);
    else {
      const before = sh;
      sh = Math.max(0, sh - (Number(t.shares) || 0));
      /* 与 computePosition 同一尾差规则：不足 0.1 份的残留按 0 处理，
         否则历史日历会拿 0.04 份继续乘净值差显示微量收益。 */
      if (sh > 0 && sh <= Math.max(0.1, before * 1e-6)) sh = 0;
    }
  }
  return sh;
}

/**
 * 该产品是否有过交易（用于区分「已清仓」与「从未建仓」）
 * @param {PositionProduct} p
 * @param {ReadonlyArray<Trade>} trades
 * @returns {boolean}
 */
export function hasAnyTrade(p, trades) { return trades.some(t => t.prodId === p.id); }

/**
 * 某产品当前持仓：份额、成本（成本法：加权平均）
 * 确认口径：只有生效日 <= 今天的买入才计入 shares/cost；
 * 生效日 > 今天的买入进 pendingShares/pendingAmount（在途），不计息、不显示市值。
 * @param {PositionProduct} p
 * @param {ReadonlyArray<Trade>} trades
 * @param {string} td 「今天」YYYY-MM-DD
 * @returns {Position}
 */
export function computePosition(p, trades, td) {
  const ts = trades.filter(t => t.prodId === p.id)
    .sort((a, b) => effTradeDate(a).localeCompare(effTradeDate(b)));
  let shares = 0, cost = 0, realized = 0;
  let pendingShares = 0, pendingAmount = 0, startDate = "";
  let navPendingCount = 0;
  /** @type {Record<string, { nav: number, shares: number, proceeds: number,
   *                          costOut: number, realized: number, full: boolean }>} */
  const settles = {};
  for (const t of ts) {
    const cd = effTradeDate(t);
    const confirmed = !cd || cd <= td;
    /* v133：确认净值日的净值还没披露 → 份额未定，即使确认日已到也整笔在途，
       绝不计入 shares/cost（否则会用滞后的最新净值凭空算出浮亏）。净值披露后
       tradeShares() 精确命中该日净值自动回冲，无需改单。 */
    const navWait = buyNavPending(t, p);
    if (t.type === "buy") {
      const sh = tradeShares(t, p); const amt = Number(t.amount) || 0;
      if (!confirmed || navWait) {
        pendingShares += sh; pendingAmount += amt;
        if (navWait) navPendingCount++;
        continue;
      }
      if (!startDate) startDate = cd;
      shares += sh; cost += amt;
    } else {
      if (!confirmed) continue;                /* 赎回申请日在未来：持仓不动 */
      /* 赎回：按 T 日结算净值 × 份额，减当期均价成本，差额计入已实现。
         settles 是唯一真源：交易记录 / 首页累计已实现 / 月报都从这里取，
         不再读交易对象上写死的 amount / realized（净值披露后无法回冲）。 */
      const nav = settleNav(t, p);
      let sh = Math.min(Number(t.shares) || 0, shares);
      /* 尾差按全额赎回处理：份额差 ≤ 0.1 份（或相对 1e-6）时把剩余份额一并结算，
         避免 0.04 份残留导致「持仓中 1 / 持有金额 0.04 / 继续计当日盈亏」。 */
      const eps = Math.max(0.1, shares * 1e-6);
      if (sh > 0 && shares - sh <= eps) sh = shares;
      const avg = shares > 0 ? cost / shares : 0;
      const proceeds = sh * nav;
      const costOut = avg * sh;
      const gain = proceeds - costOut;
      realized += gain;
      if (t.id) settles[String(t.id)] = { nav, shares: sh, proceeds, costOut, realized: gain, full: sh >= shares - 1e-9 };
      shares -= sh; cost -= costOut;
      if (shares < 1e-9) { shares = 0; cost = 0; }
    }
  }
  const last = latestNav(p);
  const lastNav = last ? last[1] : 0;
  const lastDate = last ? last[0] : "";
  /* 在途：有买入但一份都没确认 → 不显示市值/收益（由 UI 显示 "-"）。
     v133：净值待确认（navPendingCount>0）份额为 0 也算在途 —— 否则
     pendingShares=0 会让 hasPending=false，market 虽为 0 但 UI 不显示"-"。
     只加这一支，老交易（无 navPending 标记）行为零回归。 */
  const hasPending = pendingShares > 0 || navPendingCount > 0;
  const inTransit = shares <= 0 && hasPending;
  const market = inTransit ? 0 : shares * lastNav;
  const profit = market - cost;               /* 持仓浮盈 */
  /* 持有天数与年化 */
  const holdDays = startDate ? Math.max(dayDiff(startDate, lastDate || td), 1) : 0;
  let holdAnnual = (cost > 0 && holdDays > 0) ? (profit / cost) * 365 / holdDays : 0;
  /* 持有不足 7 天时，年化会把短期波动放大成极端值（如 2 天 3% → 571%），
     横截面上会误导用户。低于 7 天不给年化，改由页面展示"持有不足"提示。 */
  const annualValid = holdDays >= 7;
  if (!annualValid) holdAnnual = 0;
  return { shares, cost, market, profit, realized, lastNav, lastDate, startDate, holdDays, holdAnnual, annualValid,
           pendingShares, pendingAmount, hasPending, inTransit, navPendingCount,
           navSeries: navSeriesOf(p), settles };
}

/**
 * 全账本赎回结算表：按 trade.id 索引，供交易记录 / 月报 / 累计已实现共用。
 * 净值披露变化后重算即可回冲，无需改写交易对象。
 * @param {ReadonlyArray<PositionProduct>} products
 * @param {ReadonlyArray<Trade>} trades
 * @param {string} td
 * @returns {Record<string, { nav: number, shares: number, proceeds: number,
 *                            costOut: number, realized: number, full: boolean }>}
 */
export function settleLedger(products, trades, td) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const p of products || []) {
    const s = computePosition(p, trades, td).settles;
    for (const k of Object.keys(s)) out[k] = s[k];
  }
  return out;
}
