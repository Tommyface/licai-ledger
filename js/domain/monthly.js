// @ts-check
/* 资产月报：把「这个月赚了多少、钱从哪来到哪去、分别是谁贡献的」按自然月算成一份报告。

   为什么单独成一个模块（而不是写在 app.js 的渲染里）：
     · 这里的每一个数字都有口径之争（月收益该不该算在途、月年化用月初还是月末市值、
       净投入按申请日还是确认日）。口径错了用户会拿它当银行对账单，必须能被执行测试覆盖。
     · 首页那几行「本月收益 / 本月年化」已经是全 App 最容易对不上的一组数字，
       月报再各算一套，两处不一致就成了 bug 报告里的「你这两个数对不上」。
       所以月收益与月末市值只有一份实现：app.js 的 monthProfit / marketOn 现在
       就是转发到这里，首页与月报读的是同一段循环。

   底层口径（与日历逐日加总一致）：
     · 日收益 = 当日已确认份额 × (当日净值 − 前一条披露净值)；首条披露无前值 → 不产生收益；
       没披露的日子不做均摊。
     · 份额一律走 position.sharesOn（确认日 <= 该日才算到账，在途不计息）。
   tests/monthly.test.mjs 钉住三件事：月收益 = 逐日之和 = 累计曲线末点；
   当月报告截断到「今天」；以及恒等式「资产变动 = 净投入 + 月收益」在份额与金额
   严格对齐时成立（对不齐时的差额正是报告末尾那段说明写的原因）。 */

import { navSeries, navOnOrBefore } from "./nav.js";
import { sharesOn } from "./position.js";
import { instKey, instLabel } from "./board.js";

/* 月报要比 position.js 用到的字段更多一点：产品要按机构聚合（inst / name），
   赎回交易要读用户结算的已实现收益（realized）。这两个字段本来就在数据模型里，
   只是 position.js 的 typedef 没声明，这里补成月报自己的视图类型。 */
/** @typedef {import("./position.js").PositionProduct & { name?: string, inst?: string }} Product */
/** @typedef {import("./position.js").Trade & { realized?: number | string }} Trade */

/** 两位补零（日期串到处要用，不依赖 core/util 是为了让这个模块能单独读懂） */
const pad2 = (n) => (n < 10 ? "0" + n : String(n));

/**
 * 某个自然月的首日 / 末日 / 天数
 * @param {number} y @param {number} m 1~12
 */
export function monthBounds(y, m) {
  const last = `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}`;
  return { first: `${y}-${pad2(m)}-01`, last, days: Number(last.slice(8)) };
}

/**
 * 上一个月（跨年自动退到 12 月）
 * @param {number} y @param {number} m
 * @returns {[number, number]}
 */
export function prevMonth(y, m) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }

/**
 * 某日的全仓市值：截至该日已确认份额 × 该日（或之前最近一条）净值。
 * 年化分母必须用它 —— 拿今天的市值去折算历史月份，当月一加仓就把上月年化压扁了。
 * @param {ReadonlyArray<Product>} products
 * @param {ReadonlyArray<Trade>} trades
 * @param {string} date
 */
export function marketOn(products, trades, date) {
  let s = 0;
  for (const p of products) {
    const sh = sharesOn(p, trades, date);
    if (sh <= 0) continue;
    const b = navOnOrBefore(p, date);
    if (!b) continue;
    s += sh * Number(b[1]);
  }
  return s;
}

/**
 * 该产品在 [first, last] 区间内的收益明细（只含有披露且当天有份额的日子）。
 * app.js 的 monthProfit 就是把这里按产品求和 —— 首页与月报共用这一条循环。
 * @param {Product} p @param {ReadonlyArray<Trade>} trades
 * @param {string} first @param {string} last
 * @returns {[string, number][]} [[日期, 当日收益]]
 */
export function productMonthDays(p, trades, first, last) {
  /** @type {[string, number][]} */
  const out = [];
  const s = navSeries(p);
  for (let i = 1; i < s.length; i++) {
    const d = s[i][0];
    if (d < first || d > last) continue;
    const sh = sharesOn(p, trades, d);
    if (sh <= 0) continue;
    const diff = Number(s[i][1]) - Number(s[i - 1][1]);
    if (diff !== 0) out.push([d, sh * diff]);
  }
  return out;
}

/**
 * 有数据的月份清单（倒序，最新在前）。起点取「最早一条净值所在的月」，
 * 上限 24 个月：再早的月份既没数据也没人看，芯片排一屏放不下。
 * @param {ReadonlyArray<Product>} products
 * @param {number} nowY @param {number} nowM
 */
export function monthList(products, nowY, nowM) {
  let earliest = "";
  for (const p of products) {
    const s = navSeries(p);
    if (s.length && (!earliest || s[0][0] < earliest)) earliest = s[0][0];
  }
  /* 一条净值都没有：没有历史可看，只给当月一格（否则芯片排 24 个空月，界面像坏了） */
  if (!earliest) return [`${nowY}-${pad2(nowM)}`];
  /** @type {string[]} */
  const out = [];
  let y = nowY, m = nowM;
  for (let i = 0; i < 24; i++) {
    out.push(`${y}-${pad2(m)}`);
    const [py, pm] = prevMonth(y, m);
    y = py; m = pm;
    /* YYYY-MM 是定宽串，字典序就是时间序 */
    if (`${y}-${pad2(m)}` < earliest.slice(0, 7)) break;
  }
  return out;
}

/**
 * 一份月报。
 * @param {ReadonlyArray<Product>} products
 * @param {ReadonlyArray<Trade>} trades
 * @param {number} y @param {number} m
 * @param {string} td 「今天」YYYY-MM-DD（当月报告要按今天截断，不能报出未来的数）
 * @param {Record<string, {nav:number,shares:number,proceeds:number,costOut:number,realized:number,full:boolean}>} [settleMap]
 *   赎回结算表（position.settleLedger）。传入时到账金额/已实现一律以它为准，
 *   净值披露后自动回冲；不传则回落交易对象上的静态字段（供单测与旧数据兼容）。
 * @returns {{
 *   y: number, m: number, first: string, last: string, end: string, days: number, isCurrent: boolean,
 *   profit: number, daily: [string, number][], cum: [string, number][],
 *   assetStart: number, assetEnd: number, change: number,
 *   buyN: number, buyAmt: number, sellN: number, sellShares: number, sellAmt: number,
 *   netInflow: number, realized: number, annual: number,
 *   byInst: {key: string, label: string, profit: number, asset: number, share: number}[],
 *   byProd: {id: string, label: string, inst: string, profit: number, asset: number, share: number}[],
 *   holdN: number, best: {name: string, profit: number} | null
 * }}
 */
export function monthReport(products, trades, y, m, td, settleMap) {
  const b = monthBounds(y, m);
  const cur = td.slice(0, 7) === `${y}-${pad2(m)}`;
  /* 当月只算到今天：否则「月资产变动」会拿月末（未来）市值去比，数字凭空多一截 */
  const end = cur ? td : b.last;
  const days = Math.max(1, cur ? Number(td.slice(8)) : b.days);
  const prev = prevMonth(y, m);
  const assetStart = marketOn(products, trades, monthBounds(prev[0], prev[1]).last);
  const assetEnd = marketOn(products, trades, end);

  /** @type {Map<string, {profit: number, asset: number}>} */
  const inst = new Map();
  /* 收益构成的明细行，按产品（用户要的是「具体哪只在赚/在亏」，机构名当副标题）。
     只收当月有变动的：持平的那只占一条 0 宽的条子，等于噪声。 */
  /** @type {Map<string, {id: string, label: string, inst: string, profit: number, asset: number}>} */
  const prod = new Map();
  /** @type {[string, number][]} */
  const daily = [];
  /* best = 当月「表现最好」的一只：全亏的月份它就是亏得最少的那只，
     所以界面文案用「表现最好」而不是「贡献最大」，避免反话。 */
  let profit = 0, best = null;

  for (const p of products) {
    const rows = productMonthDays(p, trades, b.first, end);
    let pp = 0;
    for (const [d, v] of rows) {
      pp += v;
      const cur2 = daily.find(x => x[0] === d);
      if (cur2) cur2[1] += v; else daily.push([d, v]);
    }
    if (!pp && !rows.length) continue;
    profit += pp;
    const k = instKey(p.inst);
    if (!inst.has(k)) inst.set(k, { profit: 0, asset: 0 });
    const slot = inst.get(k);
    slot.profit += pp;
    prod.set(String(p.id), {
      id: String(p.id), label: String(p.name || ""), inst: instLabel(k), profit: pp, asset: 0,
    });
    if (best === null || pp > best.profit) best = { name: String(p.name || ""), profit: pp };
  }
  for (const p of products) {
    const sh = sharesOn(p, trades, end);
    if (sh <= 0) continue;
    const nb = navOnOrBefore(p, end);
    const asset = nb ? sh * Number(nb[1]) : 0;
    const k = instKey(p.inst);
    if (!inst.has(k)) inst.set(k, { profit: 0, asset: 0 });
    inst.get(k).asset += asset;
    const pr = prod.get(String(p.id));
    if (pr) pr.asset = asset;
  }
  daily.sort((a, c) => a[0].localeCompare(c[0]));
  let run = 0;
  /** @type {[string, number][]} */
  const cum = daily.map(([d, v]) => { run += v; return [d, run]; });

  /* 现金流：买入按确认日、赎回按到账日归月（钱哪天进出算哪天），
     在途（日期 > end）不计 —— 与 sharesOn 的口径一致。
     v129：赎回到账金额/已实现优先取 settleLedger 的动态结算值，
     这样 T 日净值 T+1 披露后月报会跟着回冲，不会留着录入瞬间的静态错值。 */
  let buyN = 0, buyAmt = 0, sellN = 0, sellShares = 0, sellAmt = 0, realized = 0;
  for (const t of trades) {
    const cd = t.type === "sell"
      ? (t.arrivalDate || t.confirmDate || t.tradeDate || "")
      : (t.confirmDate || t.tradeDate || "");
    if (!cd || cd < b.first || cd > end) continue;
    if (t.type === "buy") { buyN++; buyAmt += Number(t.amount) || 0; }
    else {
      const sh = Number(t.shares) || 0;
      const nav = Number(t.confirmNav) || 0;
      const s = settleMap && t.id ? settleMap[String(t.id)] : null;
      sellN++; sellShares += sh;
      sellAmt += s ? s.proceeds : (Number(t.amount) || sh * nav);
      realized += s ? s.realized : (Number(t.realized) || 0);
    }
  }
  const netInflow = buyAmt - sellAmt;

  /* 月年化：本金天数加权，分母是月末市值（与首页「本月年化」同一条公式的月报版）。
     市值为 0（清仓 / 还没建仓）时不给数 —— 除出来的百分比没有意义。 */
  const annual = assetEnd > 0 ? (profit / assetEnd) * 365 / days : 0;

  const byInst = [...inst.entries()].map(([key, v]) => ({
    key, label: instLabel(key), profit: v.profit, asset: v.asset,
    share: assetEnd > 0 ? v.asset / assetEnd : 0,
  })).sort((a, c) => c.asset - a.asset || c.profit - a.profit);

  /* 收益构成：当月有变动的产品，赚得最多/亏得最多的排前面（按 |收益| 而不是代数和，
     否则一个月里 +0.5 与 -80 会排成 +0.5 在前，用户真正要看的那条掉到最后）。
     名字没填的产品标成「未命名产品」，副标题仍给机构（没填就是「未填机构」）——
     空标题会让这一行看不出是谁，落回机构名又等于把「没填名字」这件事藏起来。 */
  const byProd = [...prod.values()].filter(x => x.profit)
    .map(x => ({
      ...x,
      label: x.label || "未命名产品",
      share: assetEnd > 0 ? x.asset / assetEnd : 0,
    }))
    .sort((a, c) => Math.abs(c.profit) - Math.abs(a.profit) || a.label.localeCompare(c.label));

  return {
    y, m, first: b.first, last: b.last, end, days, isCurrent: cur,
    profit, daily, cum, assetStart, assetEnd, change: assetEnd - assetStart,
    buyN, buyAmt, sellN, sellShares, sellAmt, netInflow, realized, annual,
    byInst, byProd,
    holdN: products.filter(p => sharesOn(p, trades, end) > 0).length,
    best: best && best.profit !== 0 ? best : null,
  };
}

/**
 * 月报里那句「机构贡献」的占比：按 |收益| 归一（当月有亏有赚时百分比之和仍为 100%）。
 * 单独拿出来是因为界面要显示「+146.12（99.9%）」这种串，归一规则必须只有一处定义。
 * @param {{profit: number}[]} rows
 */
export function profitShares(rows) {
  const tot = rows.reduce((s, r) => s + Math.abs(r.profit), 0);
  return rows.map(r => (tot > 0 ? Math.abs(r.profit) / tot : 0));
}
