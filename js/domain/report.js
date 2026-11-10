// @ts-check
/* ---------- 研报事实层（v112 · report-1）----------
   把「一期研报里能算的部分」全部在本地算完，出一个**只含结论、不含原始序列**的结构。
   模型拿到的就是这个结构拼出来的七百来字，它一个数字都加不进来。

   ★ 六条口径（改任何一条都要同步改 tests/report.test.mjs）：

     1. **时点决定路线，不是数据决定。** reportSession() 只看「用户点按钮的那一刻」——
        盘前 / 盘中 / 盘后 / 休市。同一份数据在三个时点要说三种话：盘前讲昨天、盘中讲今天、
        盘后讲今天收盘和明天。数据是死的，问题是活的。
        ★ 但「盘中」这条路在数据上是降级：中债收益率曲线是日频收盘发布，本机没有实时源。
          所以盘中路线必须由 reportFactsText() 显式写进「本轮没有实时行情」，
          不许让模型把它写成「今天上午债市走强」—— 那是编的。

     2. **表格的数据源只有一处。** 净值轨迹取 navHistory，债市取 weather.cells 与 bpTable。
        不在这里算第二遍 position/收益 —— 那是 position.js 的事。

     3. **指标宁可标注口径，不许四舍五入成好看的数。** 回撤按「峰值到之后最低」算；
        常态日收益按「剔除 |bp| > max(3, 2.5σ) 后的中位数」算；两个口径差 5 倍是常态，
        因为一个是票息、一个是修复速度。报告里两个都给，不合并。

     4. **缺失披露点只在「日更」产品上算。** 先用最近 21 个点估披露节奏，
        非日更产品报「缺 2 个披露点」是误报，那种误报比不报更糟。

     5. **数字白名单是守护层的核心。** reportNumberAudit() 把模型文本里的每个数字
        与事实集比对（容忍 0~4 位舍入），命中不了的列出来。禁用词拦不住「它算错了」，
        这一条能。

     6. **没有数据就说没有。** 债市缺失时返回 { ok:false }，由调用方整块不画；
        不返回一张空表，也不返回一句「数据暂缺」让模型自由发挥。
*/

import { esc } from "../core/util.js";
import { isTradeDay, nextTradeDay, tradeDaysBetween, addTradeDays } from "./calendar.js";
import { pubCalChips, pubCalText, pubCalNext } from "./pubcal.js";
/* v118：中票利差是 market.js 从同一份 33 格里派生的，这里直接用，不重算一遍 ——
   两处各写一遍公式，迟早在某个边角上算出两个数。 */
import { marketSpreads } from "../core/market.js";

/* ---------------- 时点 ---------------- */

/** 四个时点。key 进指纹 —— 换时点就该重新生成，因为叙述重心换了。 */
/**
 * 定点格式化，但把「舍入之后就是零」的负零写成正零。
 * toFixed 不看意图：-0.0001 保留两位是 "-0.00"，一个数字上的零被印成了负数。
 * 回撤这类指标特别容易踩 —— 真实值常常是 -0.0004，界面就显示「最大回撤 -0.00%」。
 * @param {number} n
 * @param {number} dec
 * @returns {string}
 */
function zeroFixed(n, dec) {
  const s = Number(n).toFixed(dec);
  return Number(s) === 0 ? (0).toFixed(dec) : s;
}

export const REPORT_SESSION_LABEL = {
  preopen: "盘前", intraday: "盘中", afterclose: "盘后", closed: "休市",
};
const WD_TEXT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 盘前 / 盘中的分界：银行间现券 9:00 开始，交易所 9:30。取 9:00 更保守。 */
const OPEN_MIN = 9 * 60;
/** 盘后分界：交易所 15:00 收盘、银行间现券到 16:30，取 15:30 —— 此时当日成交已基本定型，
    而中债曲线还没发布（一般 17:00 之后），所以盘后路线同样要标注「今日曲线可能还没出」。 */
const CLOSE_MIN = 15 * 60 + 30;

function pad2(n) { return String(n).padStart(2, "0"); }
/** @param {Date} d */
function dateOf(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

/**
 * 用户点按钮的那一刻属于哪个时点。
 * @param {number} nowTs 毫秒时间戳；0 表示「就现在」
 * @param {string} today YYYY-MM-DD（按本机时区算好的今天）
 * @param {string} [marketAsOf] 债市快照的那一天。盘后路线要靠它判断「今天到底有没有收盘数据」——
 *   中债曲线一般 17:00 之后才发布，21 点打开时很可能今天这一条还没出。
 *   不看这个，就会出现「先讲今天收盘」而手上根本没有今天的数。
 * @param {string} [liveAt] 盘中参考价的时点（HH:MM）。有它，叙述重心才能说「可以直接引用」；
 *   没有就得写「数据块里没有」。v117 之前这里是写死的「本机没有实时行情」。
 * @returns {{ key: string, label: string, tradeDay: boolean, atText: string, dateText: string,
 *   wdText: string, focus: string, heading: string, fresh: boolean }}
 */
export function reportSession(nowTs, today, marketAsOf, liveAt) {
  const t = Number(nowTs) > 0 ? new Date(Number(nowTs)) : new Date();
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(today || "")) ? String(today) : dateOf(t);
  const mins = t.getHours() * 60 + t.getMinutes();
  const trade = isTradeDay(td);
  let key = "closed";
  if (trade) key = mins < OPEN_MIN ? "preopen" : (mins < CLOSE_MIN ? "intraday" : "afterclose");
  const label = REPORT_SESSION_LABEL[key];
  const dateText = td.slice(5);
  /* 三句 focus 是写给模型的任务书，不是给用户看的文案 —— 所以用「讲」而不是「综述」。 */
  const has = /^\d{4}-\d{2}-\d{2}$/.test(String(marketAsOf || ""));
  const fresh = has && String(marketAsOf) === td;
  const asOfText = has ? String(marketAsOf).slice(5) : "";
  /* v117：盘中这句话从「一律没有」改成两档。原来那句是 v112 的事实（当时确实没有），
     v116 之后已经不成立 —— 留着它，模型开篇就被告知「没有实时行情」，
     后面就算把盘中价摆给它，它也会照着任务书写「数据块里没有」。 */
  const liveAtText = String(liveAt || "").trim();
  const focus = key === "preopen"
    ? "先讲上一交易日发生了什么，再讲今天开盘要盯什么。今天还没有任何成交数据。"
    : key === "intraday"
      ? (liveAtText
        ? "先讲今天到现在能看出什么。有盘中参考价（截至 " + liveAtText
          + "，仅国债/期货/交易所回购），可直接引用并带时点；其余品种仍为上一交易日收盘，不许编。"
        : "先讲今天到现在能看出什么。本轮没取到盘中行情，凡是需要盘中价格才能说的话，一律写「数据块里没有」。")
      : key === "afterclose"
        /* 盘后最容易出的一句假话：让模型「讲今天收盘」，而今天这条曲线根本还没发布。 */
        ? (fresh || !has
          ? "先讲今天收盘，再讲下一交易日要盯什么。"
          : "今天的收盘曲线还没发布（最新一条是 " + asOfText + "）：先讲那份收盘，再讲下一交易日要盯什么。")
        : "今天休市：先讲最近一个交易日，再讲下一个交易日。";
  return {
    key, label, tradeDay: trade,
    atText: dateText + " " + pad2(t.getHours()) + ":" + pad2(t.getMinutes()),
    dateText, wdText: WD_TEXT[t.getDay()], focus, fresh,
    heading: dateText + " " + label,
  };
}

/* ---------------- 工具 ---------------- */

/** @param {number[]} a */
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** @param {any} v */
function num(v) { const n = Number(v); return isFinite(n) ? n : NaN; }
/** 固定小数位；NaN → 「—」。**先判 NaN 再 toFixed**，否则 NaN.toFixed 会抛。 */
function fx(v, dp) { const n = Number(v); return isFinite(n) ? n.toFixed(dp) : "—"; }
/** BP 文案：带正负号。 */
function bpText(v, dp) {
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const d = dp == null ? 1 : dp;
  return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(d) + "bp";
}

/* ---------------- 净值事实 ---------------- */

/**
 * 从净值序列算出一期研报要用的全部结论。
 * **只做四则运算**，不碰份额/成本/市值。
 *
 * @param {Array<[string, number]>} series 升序 [[date, nav], ...]
 * @param {{ today?: string }} [opts]
 * @returns {any}
 */
export function reportNavFacts(series, opts) {
  const o = opts || {};
  /** @type {Array<[string, number]>} */
  const pts = (Array.isArray(series) ? series : [])
    .filter(p => Array.isArray(p) && /^\d{4}-\d{2}-\d{2}$/.test(String(p[0]))
      && isFinite(Number(p[1])) && Number(p[1]) > 0)
    .map(p => /** @type {[string, number]} */ ([String(p[0]), Number(p[1])]))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const n = pts.length;
  if (n < 2) return { ok: false, n };
  const last = pts[n - 1], prev = pts[n - 2];
  /** bps[i] = 第 i 个点相对前一个点的日变动（bp）；bps[0] 恒为 null。 */
  const bps = [null];
  for (let i = 1; i < n; i++) bps.push((pts[i][1] / pts[i - 1][1] - 1) * 10000);
  const arr = bps.slice(1).filter(v => v !== null);

  /* σ：样本标准差。它只用来判「这一跌是不是异常」，不拿来预测。 */
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const varr = arr.length > 1 ? arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (arr.length - 1) : 0;
  /* σ 只在小样本之外才报：12 个点里有 4 个极端值时，σ 会被那几个点主导（算出 4.8bp），
     再拿它去除 −11.5bp 得到「2.4 倍」—— 这个数看着有，其实没意义。
     样本不足 20 个点时返回 0，文案里就不写倍数，只写绝对值。 */
  const sigma = arr.length >= 20 ? Math.sqrt(Math.max(0, varr)) : 0;

  /* 常态日收益：**直接取中位数**，不做「剔除极端值」。
     中位数本身就抗极端值：真实样本 108 个点里，剔除后中位 1.126bp、不剔除 1.140bp，
     差 1%；而多加一个「|bp| > 3 才算极端」的魔数，会在高波动产品上把半数样本剔掉。
     少一个参数，就少一处会跟事实分叉的地方。 */
  const normalBp = median(arr);

  /* 最近 30 个点里最深的一天：这就是「事件冲击」的定义，不是最显眼的那个标题。 */
  const from = Math.max(1, n - 30);
  let si = -1;
  for (let i = from; i < n; i++) if (si < 0 || bps[i] < bps[si]) si = i;
  let shock = null;
  if (si > 0 && bps[si] < 0) {
    const low = pts[si][1], before = pts[si - 1][1];
    const drop = before - low;
    const back = last[1] - low;
    shock = {
      date: pts[si][0], bp: bps[si],
      sigma: sigma > 0 ? Math.abs(bps[si]) / sigma : 0,
      low, before,
      days: n - 1 - si,
      backBp: low > 0 ? back / low * 10000 : 0,
      ratio: drop > 0 ? back / drop : 0,
    };
  }

  /* 前高与距前高：全序列最大值。若最后一个点就是最高，gap = 0。 */
  let pk = 0;
  for (let i = 1; i < n; i++) if (pts[i][1] > pts[pk][1]) pk = i;
  const gapBp = pts[pk][1] > 0 ? (pts[pk][1] / last[1] - 1) * 10000 : 0;

  /* 最大回撤：任一历史峰值之后的最深跌幅。区间要一并给出 —— 只说「−0.16%」
     不说是哪两天，读者无法判断它是不是刚刚发生的那一次。 */
  let peakV = pts[0][1], peakD = pts[0][0], worst = 0, ddFrom = pts[0][0], ddTo = pts[0][0];
  for (const [d, v] of pts) {
    if (v > peakV) { peakV = v; peakD = d; }
    const x = peakV > 0 ? (v / peakV - 1) * 100 : 0;
    if (x < worst) { worst = x; ddFrom = peakD; ddTo = d; }
  }

  /* 近 2 日修复速度：只用于「另一个口径要几个点」，不当作可持续速度。 */
  const two = arr.slice(-2);
  const fastBp = two.length ? two.reduce((s, v) => s + v, 0) / two.length : 0;

  /* 披露节奏：最近 21 个点跨了多少个交易日。日更 ≈ 1.0；周更 ≈ 5。 */
  const win = pts.slice(-21);
  const span = win.length >= 6 ? tradeDaysBetween(win[0][0], win[win.length - 1][0]) : 0;
  const step = span > 0 ? span / (win.length - 1) : 0;
  const cadence = step <= 1.6 ? "daily" : step <= 6 ? "weekly" : "sparse";

  /* 序列断点（v114）：相邻两点之间隔了远超常态的交易天数。
     日更产品里出现 6 个交易日的空档，多半是漏抓或产品暂停披露 —— 两种都得看见。 */
  const breaks = [];
  for (let i = 1; i < n; i++) {
    const gap = tradeDaysBetween(pts[i - 1][0], pts[i][0]);
    if (gap > Math.max(3, step * 2.5)) breaks.push({ from: pts[i - 1][0], to: pts[i][0], gap });
  }
  /* 极端日（v114）：最近 20 个点里 |bp| >= 4σ 的日子。
     shock 只记「最深的那一天」，但一周里出现两次 4σ 与只出现一次，是两种产品。 */
  const extreme = [];
  if (sigma > 0) {
    for (let i = Math.max(1, n - 20); i < n; i++) {
      if (Math.abs(bps[i]) >= 4 * sigma) {
        extreme.push({ date: pts[i][0], bp: bps[i], sigma: Math.abs(bps[i]) / sigma });
      }
    }
  }
  /* 距最后一次披露过了几个交易日：与 missing 不同 —— missing 只在日更产品上算，
     这个是「不管什么节奏，都多少天没动静了」。 */
  const staleDays = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || ""))
    ? tradeDaysBetween(last[0], o.today) : 0;

  /* 缺失披露点：只在日更产品上算。 */
  const missing = [];
  if (cadence === "daily" && /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) && o.today > last[0]) {
    const seen = new Set(pts.map(p => p[0]));
    let d = nextTradeDay(last[0]);
    let guard = 0;
    /* 当天不算缺失：净值的披露时点在晚上，「今天还没披露」不是异常。 */
    while (d && d < o.today && guard++ < 40) {
      if (!seen.has(d)) missing.push(d);
      const nx = nextTradeDay(d);
      if (!nx || nx === d) break;
      d = nx;
    }
  }

  const tail = pts.slice(-6).map(([d, v], k) => {
    const idx = n - 6 + k;
    return {
      date: d, value: v, bp: bps[idx],
      flag: idx === pk ? "peak" : (si > 0 && idx === si ? "shock" : ""),
    };
  });

  return {
    ok: true, n,
    last: { date: last[0], value: last[1] },
    prev: { date: prev[0], value: prev[1] },
    lastBp: bps[n - 1],
    tail,
    peak: { date: pts[pk][0], value: pts[pk][1] },
    gapBp: gapBp > 0 ? gapBp : 0,
    dd: { pct: worst, from: ddFrom, to: ddTo },
    sigmaBp: sigma,
    normalBp,
    fastBp,
    shock,
    /* 两个口径的「还要几个披露点」。0 表示不用等（已经在前高上方）。 */
    etaNormal: gapBp > 0 && normalBp > 0 ? Math.max(1, Math.round(gapBp / normalBp)) : 0,
    etaFast: gapBp > 0 && fastBp > 0 ? Math.max(1, Math.round(gapBp / fastBp)) : 0,
    cadence, step, missing,
    breaks, extreme, staleDays,
  };
}

/* ---------------- 三档情景 ---------------- */

/**
 * 把「按什么速度走」摊开成三行（v114）。
 *
 * ★ 这不是预测，是**把三个口径并排放**：常态（全样本中位数）、近期（最近两点）、
 *   压力（再来一次同等级的冲击，或每个点都少 1 个 σ）。三行都写出来，读者自己看
 *   分歧有多大 —— 这比让模型说一句「概率约 65%」诚实得多：那个数字没有任何依据。
 *
 * ★ 一律用「披露点」做时间单位，不换算成自然日：周更产品一周一个点，
 *   按日推会算出「7 天后到 1.016」这种根本不会发生的数。
 *
 * @param {any} nv reportNavFacts 的产出
 * @param {{ k?: number }} [opts] k = 往前推几个披露点，默认 5
 * @returns {any}
 */
export function reportScenarios(nv, opts) {
  if (!nv || !nv.ok) return { ok: false };
  const o = opts || {};
  const k = Number(o.k) > 0 ? Math.round(Number(o.k)) : 5;
  const last = nv.last.value;
  /** note 给表格用（短），why 给请求用（长）—— 表里塞不下长句，模型又需要知道口径。
   * @param {string} key @param {string} name @param {number} cumBp @param {number|null} perBp
   * @param {string} note @param {string} why */
  const mk = (key, name, cumBp, perBp, note, why) => ({
    key, name, perBp, cumBp,
    nav: last * (1 + cumBp / 10000),
    pct: cumBp / 100,
    note, why,
  });
  /** @type {any[]} */
  const rows = [];
  rows.push(mk("normal", "按常态", k * nv.normalBp, nv.normalBp, "全部点中位数",
    "全部披露点的日变动中位数"));
  rows.push(mk("fast", "按最近两日", k * nv.fastBp, nv.fastBp, "最近 2 点均值",
    "最近 2 个披露点的均值，只代表眼下"));
  if (nv.shock && nv.shock.bp < 0) {
    rows.push(mk("stress", "再来一次冲击", nv.shock.bp + (k - 1) * nv.normalBp, null,
      "复制 " + nv.shock.date.slice(5) + " 的 " + bpText(nv.shock.bp, 1),
      "第 1 个点复制 " + nv.shock.date.slice(5) + " 的 " + bpText(nv.shock.bp, 1) + "，其余按常态"));
  } else if (nv.sigmaBp > 0) {
    rows.push(mk("stress", "按 −1σ 走", k * (nv.normalBp - nv.sigmaBp), nv.normalBp - nv.sigmaBp,
      "每点少 1σ",
      "每个点都比常态少 1 个 σ（" + nv.sigmaBp.toFixed(1) + "bp）"));
  }
  const cum = rows.map(r => r.cumBp);
  /* 推到第 k 个披露点大约是哪天：按最近 21 个点估出来的节奏换算，只做参考。 */
  const step = nv.step > 0 ? nv.step : 1;
  const byDate = addTradeDays(nv.last.date, Math.max(1, Math.round(k * step))) || "";
  return { ok: true, k, byDate, rows, low: Math.min.apply(null, cum), high: Math.max.apply(null, cum) };
}

/* ---------------- 债市事实 ---------------- */

/**
 * 债市表：4 个关键期限（有 5/20 日累计）+ 3 个小期限（只有当日）+ 信用 AAA。
 * @param {any} m
 * @param {string} today
 * @returns {any}
 */
export function reportMarketFacts(m, today) {
  const bad = { ok: false };
  if (!m || !m.meta || m.meta.verified !== true) return bad;
  const w = m.weather || {};
  const cells = Array.isArray(w.cells) ? w.cells : [];
  if (!cells.length) return bad;
  const bt = Array.isArray(m.bpTable) ? m.bpTable : [];
  const cellOf = (issuer, tenor) => cells.find(c => c && c.issuer === issuer && c.tenor === tenor) || null;
  const bpOf = (x, k) => (x && x.bp && Array.isArray(x.bp[k]) && isFinite(Number(x.bp[k][0])) ? Number(x.bp[k][0]) : NaN);

  /** @type {any[]} */
  const rows = [];
  for (const tenor of ["2年", "5年", "10年", "30年"]) {
    const b = bt.find(x => x && x.issuer === "国债" && x.tenor === tenor) || null;
    const c = cellOf("国债", tenor);
    const y = b ? num(b.yieldPct) : (c ? num(c.basis && c.basis.yieldPct) : NaN);
    const bp1 = b ? bpOf(b, "1日") : (c ? num(c.basis && c.basis.bp1d) : NaN);
    if (!isFinite(y) && !isFinite(bp1)) continue;
    rows.push({ tenor, y, bp1, bp5: b ? bpOf(b, "5日") : NaN, bp20: b ? bpOf(b, "20日") : NaN });
  }
  /** @type {any[]} */
  const small = [];
  for (const tenor of ["1年", "3年", "7年"]) {
    const c = cellOf("国债", tenor);
    if (!c || c.dir === "none") continue;
    const v = num(c.basis && c.basis.bp1d);
    if (isFinite(v)) small.push({ tenor, bp1: v });
  }
  /** @type {any[]} */
  const aaa = [];
  for (const tenor of ["3年", "5年"]) {
    const c = cellOf("AAA", tenor);
    if (!c || c.dir === "none") continue;
    aaa.push({ tenor, y: num(c.basis && c.basis.yieldPct), bp1: num(c.basis && c.basis.bp1d) });
  }
  if (!rows.length) return bad;
  const asOf = String(w.asOf || "");
  /* 全期限是否同向下行：只统计有当日 BP 的行。用来生成「无一处反转」这种句子 ——
     这句话是**算出来的**，不是模型看图说话。 */
  const dirs = rows.concat(small).map(r => (r.bp1 > 0 ? 1 : r.bp1 < 0 ? -1 : 0)).filter(x => x !== 0);
  const allDown = dirs.length >= 3 && dirs.every(x => x < 0);
  const allUp = dirs.length >= 3 && dirs.every(x => x > 0);
  return {
    ok: true, asOf, prevDate: String(w.prevDate || ""),
    lagTradeDays: /^\d{4}-\d{2}-\d{2}$/.test(asOf) && /^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))
      ? tradeDaysBetween(asOf, today) : 0,
    rows, small, aaa, allDown, allUp,
    /* v118：中票利差（对同期限国债）。只有 1年/3年/5年 三档算得出来，
       AA+/AA 因曲线只发布至 1 年而只有一档 —— 缺的档不会出现在这里。 */
    spreads: marketSpreads(m),
    gaps: (m.meta && Array.isArray(m.meta.gaps)) ? m.meta.gaps.filter((g) => typeof g === "string" && g) : [],
    capturedAt: String((m.meta && m.meta.capturedAt) || ""),
  };
}

/* ---------------- 组合事实 ---------------- */

/**
 * 组合层横向表：每只一行。比单只的净值轨迹更适合看「结构」。
 *
 * v114 加三样，都是「一眼能看出谁不对劲」用的：
 *   · w      持仓占比（调用方算好传进来；隐藏金额时传 null）
 *   · lag    最新净值距今天几个交易日
 *   · stale  lag >= 2 就算掉队（与 watch 里那条汇总口径一致）
 *
 * @param {Array<any>} items briefItems() 的产出
 * @param {{ today?: string }} [opts]
 * @returns {Array<any>}
 */
export function reportPortfolioRows(items, opts) {
  const o = opts || {};
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) ? String(o.today) : "";
  const list = Array.isArray(items) ? items : [];
  return list.map(it => {
    const m = (it && it.metrics) || {};
    const series = Array.isArray(it && it.series) ? it.series : null;
    let gapBp = null;
    if (series && series.length >= 2) {
      const f = reportNavFacts(series, {});
      if (f.ok) gapBp = f.gapBp;
    }
    const navDate = String((it && it.navDate) || "");
    const lag = today && /^\d{4}-\d{2}-\d{2}$/.test(navDate) ? tradeDaysBetween(navDate, today) : null;
    return {
      name: String((it && it.name) || "（无名）"),
      nav: num(it && it.nav), navDate,
      d30: m.d30 == null ? null : num(m.d30),
      dd: m.dd == null ? null : num(m.dd),
      gapBp,
      w: it && it.w != null && isFinite(Number(it.w)) ? Number(it.w) : null,
      lag, stale: lag != null && lag >= 2,
    };
  });
}

/* ---------------- 观察项 ---------------- */

/**
 * 「接下来看什么」：全部由本地判据生成，不含模型推断。
 * 每条都带 level，界面按 level 上色；没东西可看时返回空数组，不硬凑三条。
 * @param {any} nv reportNavFacts 的产出
 * @param {any} mk reportMarketFacts 的产出
 * @param {any} ses reportSession 的产出
 * @returns {Array<{level:string,text:string,sub:string}>}
 */
export function reportWatch(nv, mk, ses, extra) {
  const out = [];
  /* 组合层没有单只的净值序列，但「最新净值日是哪天、落后今天几个交易日」照样要看 ——
     一只产品掉队，整张表的结论就跟着旧。 */
  const x = extra || {};
  if (!nv && Array.isArray(x.rows) && x.rows.length && /^\d{4}-\d{2}-\d{2}$/.test(String(x.today || ""))) {
    /* v114：从「有 3 只掉队」改成点名 —— 只说数量，用户还得自己一行行找是哪三只。
       lag 允许调用方没算（老调用点 / 手工构造的行），这里按 navDate 兜底算一次。 */
    const lagOf = r => {
      if (r && r.lag != null && isFinite(Number(r.lag))) return Number(r.lag);
      const d = String((r && r.navDate) || "");
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? tradeDaysBetween(d, x.today) : null;
    };
    const stale = x.rows.filter(r => { const l = lagOf(r); return l != null && l >= 2; });
    if (stale.length) {
      const names = stale.slice(0, 3).map(r => r.name + "（" + String(r.navDate || "").slice(5) + "）").join("、");
      out.push({
        level: "warn",
        text: "有 " + stale.length + " 只的净值落后 2 个交易日以上：" + names + (stale.length > 3 ? " 等" : ""),
        sub: "净值没跟上时，下面所有结论都只对到那一天为止",
      });
    }
  }
  if (nv && nv.ok && Array.isArray(nv.missing) && nv.missing.length) {
    const list = nv.missing.slice(0, 3).map(d => d.slice(5)).join("、");
    out.push({
      level: "bad",
      text: "净值缺 " + nv.missing.length + " 个披露点：" + list + (nv.missing.length > 3 ? " 等" : ""),
      sub: "这只产品是日更的，缺日要留意 —— 可能是披露延迟，也可能是抓取没跟上，下次同步后看是否补上",
    });
  }
  if (mk && mk.ok && mk.lagTradeDays > 0) {
    out.push({
      level: mk.lagTradeDays >= 2 ? "warn" : "info",
      text: "债市快照停在 " + mk.asOf.slice(5) + "，落后 " + mk.lagTradeDays + " 个交易日",
      sub: "下次抓取若还是这一天，说明上游没更新，不是本机没抓",
    });
  }
  if (mk && !mk.ok) {
    out.push({ level: "warn", text: "本轮没有可用的债市快照", sub: "涉及市场环境的判断一律只能写「数据块里没有」" });
  }
  if (nv && nv.ok && nv.shock && Math.abs(nv.shock.sigma) >= 4 && nv.shock.days <= 3) {
    out.push({
      level: "warn",
      text: "最近 " + nv.shock.days + " 个披露点里出现过 " + bpText(nv.shock.bp) + " 的单日波动",
      sub: "是常态波动的 " + nv.shock.sigma.toFixed(1) + " 倍，属事件级；下一次披露是验证它有没有延续的关键",
    });
  }
  if (nv && nv.ok && nv.gapBp > 0 && nv.gapBp <= 1) {
    out.push({ level: "info", text: "距前高只剩 " + nv.gapBp.toFixed(1) + "bp", sub: "再有一个常态日就能回到 " + nv.peak.date.slice(5) + " 的高点" });
  }
  /* ---- v114 新增三条判据 ---- */
  /* ① 长期没动静：missing 只在日更产品上算，周更与不定期产品从来没被这条覆盖过。 */
  if (nv && nv.ok && nv.cadence !== "daily") {
    const lim = nv.cadence === "weekly" ? 10 : 21;
    if (nv.staleDays >= lim) {
      out.push({
        level: "warn",
        text: "距最后一次披露已 " + nv.staleDays + " 个交易日（" + nv.last.date.slice(5) + " 之后没有新点）",
        sub: nv.cadence === "weekly" ? "这只约每周一个点，超过两周没动静就不正常" : "这只披露不定期，但一个月的空档要核对一下是不是停售或漏抓",
      });
    }
  }
  /* ② 反复极端：shock 只记最深的那一天，但一周里出现两次 4σ 与只出现一次，是两种产品。 */
  if (nv && nv.ok && Array.isArray(nv.extreme) && nv.extreme.length >= 2) {
    out.push({
      level: "warn",
      text: "最近 20 个点里有 " + nv.extreme.length + " 天超过 4σ（最深 " + bpText(nv.extreme[0].bp) + "）",
      sub: "单次极端可以是事件，反复出现说明这只产品的波动结构变了",
    });
  }
  /* ③ 序列断点：凭空少掉几个交易日，多半是漏抓。 */
  if (nv && nv.ok && Array.isArray(nv.breaks) && nv.breaks.length) {
    const b = nv.breaks[nv.breaks.length - 1];
    out.push({
      level: "warn",
      text: "序列有 " + nv.breaks.length + " 处断点，最近一处 " + b.from.slice(5) + " → " + b.to.slice(5) + "（隔 " + b.gap + " 个交易日）",
      sub: "断点处的日变动算不出来，那一段的回撤与修复比例都会失真",
    });
  }
  /* ④ 日历：三天内撞上偏紧的日子，提醒一句（只报日子，不猜影响）。 */
  if (Array.isArray(x.cal) && x.cal.length) {
    const soon = x.cal.find(e => e && e.tone === "warn" && e.daysAway <= 3);
    if (soon) {
      out.push({
        level: "info",
        text: soon.date.slice(5) + "（" + soon.wd + "）" + soon.name + "，还有 " + soon.daysAway + " 天",
        sub: soon.note,
      });
    }
  }
  if (ses && ses.key === "closed") {
    out.push({ level: "info", text: "今天休市（" + ses.wdText + "）", sub: "净值与曲线都不会更新，下一个交易日的口径见下" });
  }
  return out;
}

/* ---------------- 拼成请求 ---------------- */

/**
 * 装配模型输入。v112 时约 980 字；v114 加了【情景】与【日历】两段，实测约 1300 字
 * （单只、带债市）。多出来的 300 多字换的是「不再让模型预测」与「日期不靠它记」。
 * 这里只写算好的结论，不写原始序列：模型拿到序列就会自己再算一遍，然后算错。
 *
 * @param {{ session:any, kind?:string, name?:string, inst?:string, nav?:any, rows?:any[],
 *   market?:any, gaps?:string[] }} q
 * @returns {string}
 */
export function reportFactsText(q) {
  const o = /** @type {any} */ (q || {});
  const ses = o.session || reportSession(0, "");
  const mk = o.market;
  const L = [];
  L.push("【时点】" + ses.atText + "（" + ses.wdText + " · " + ses.label + "）");
  L.push("【叙述重心】" + ses.focus);

  if (o.kind === "product") {
    L.push("【这一只】" + (o.name || "（无名）") + (o.inst ? " · " + o.inst : ""));
    const nv = o.nav;
    if (nv && nv.ok) {
      L.push("【净值】截至 " + nv.last.date.slice(5) + "，最新 " + nv.last.value.toFixed(6)
        + "（当日 " + bpText(nv.lastBp) + "），共 " + nv.n + " 个披露点");
      L.push("  近 6 个披露点（日期 净值 日变动）：" + nv.tail.map(t =>
        t.date.slice(5) + " " + t.value.toFixed(6) + " " + bpText(t.bp)).join("｜"));
      L.push("【测算】");
      L.push("- 前高 " + nv.peak.value.toFixed(6) + "（" + nv.peak.date.slice(5) + "），距前高 "
        + (nv.gapBp > 0 ? nv.gapBp.toFixed(1) + "bp" : "0（正在前高上）"));
      L.push("- 区间最大回撤 " + zeroFixed(nv.dd.pct, 3) + "%（" + nv.dd.from.slice(5) + " → " + nv.dd.to.slice(5) + "）");
      if (nv.shock) {
        L.push("- " + nv.shock.date.slice(5) + " 单日 " + bpText(nv.shock.bp)
          + (nv.sigmaBp > 0 ? "，是常态波动（σ=" + nv.sigmaBp.toFixed(1) + "bp）的 " + nv.shock.sigma.toFixed(1) + " 倍"
            : "（样本不足 20 个点，不给 σ 倍数）"));
        L.push("- 此后 " + nv.shock.days + " 个披露点累计 " + bpText(nv.shock.backBp) + "，收回该次冲击 "
          + (nv.shock.ratio * 100).toFixed(1) + "%");
      }
      L.push("- 常态日收益（剔除极端日后中位）" + bpText(nv.normalBp) + "；最近 2 个点均值 " + bpText(nv.fastBp));
      L.push("- 填平缺口 " + (nv.gapBp > 0
        ? "：按常态需 " + nv.etaNormal + " 个披露点；按最近 2 日速度需 " + nv.etaFast + " 个"
        : "：已在前高，无需填平"));
      L.push("- 披露节奏：" + (nv.cadence === "daily" ? "日更（每个交易日一个点）" : nv.cadence === "weekly" ? "约每周一个点" : "不定期")
        + (nv.missing.length ? "；缺 " + nv.missing.length + " 个交易日未披露（" + nv.missing.slice(0, 3).map(d => d.slice(5)).join("、") + "）" : "；无缺失"));
      const sc = o.scenarios;
      if (sc && sc.ok) {
        L.push("【情景】往前推 " + sc.k + " 个披露点（约到 " + (sc.byDate ? sc.byDate.slice(5) : "日期不明") + "），三档并列，不是预测：");
        for (const r of sc.rows) {
          L.push("  " + r.name + "：每点 " + (r.perBp == null ? "—" : bpText(r.perBp)) + "，累计 "
            + bpText(r.cumBp) + "，净值 " + r.nav.toFixed(6)
            + "（" + (r.pct >= 0 ? "+" : "") + r.pct.toFixed(2) + "%）"
            + (r.key === "stress" ? " —— " + r.why : ""));
        }
      }
    } else {
      L.push("【净值】数据块里没有可用的净值序列（不足 2 个点）");
    }
  } else {
    const rows = Array.isArray(o.rows) ? o.rows : [];
    L.push("【持仓】" + rows.length + " 只");
    for (const r of rows) {
      L.push("- " + r.name + "：净值 " + fx(r.nav, 4) + "（" + (r.navDate ? r.navDate.slice(5) : "日期不明") + "）"
        + (r.d30 != null ? " · 近30点 " + (r.d30 >= 0 ? "+" : "") + r.d30.toFixed(2) + "%" : "")
        + (r.dd != null ? " · 最大回撤 " + zeroFixed(r.dd, 2) + "%" : "")
        + (r.gapBp != null && r.gapBp > 0 ? " · 距前高 " + r.gapBp.toFixed(1) + "bp" : ""));
    }
  }

  if (mk && mk.ok) {
    L.push("【债市】中债官方曲线 " + mk.asOf.slice(5) + " 收盘（上一交易日 " + mk.prevDate.slice(5)
      + "）；比今天落后 " + mk.lagTradeDays + " 个交易日");    L.push("  期限 收益率 当日 5日 20日（单位 bp，负=收益率下行=债券价格上涨）");
    for (const r of mk.rows) {
      L.push("  " + r.tenor + " " + fx(r.y, 4) + "% " + (isFinite(r.bp1) ? r.bp1.toFixed(1) : "—")
        + " " + (isFinite(r.bp5) ? r.bp5.toFixed(1) : "—")
        + " " + (isFinite(r.bp20) ? r.bp20.toFixed(1) : "—"));
    }
    if (mk.small.length) L.push("  另有：" + mk.small.map(s => s.tenor + " " + s.bp1.toFixed(1)).join("、") + "（仅当日）");
    if (mk.aaa.length) L.push("  信用AAA：" + mk.aaa.map(s => s.tenor + " " + fx(s.y, 4) + "%/" + s.bp1.toFixed(1)).join("、"));
    if (mk.allDown) L.push("  当日方向：全期限下行，无一处反转");
    else if (mk.allUp) L.push("  当日方向：全期限上行，无一处反转");
    /* v118：中票利差。用词必须是「中票」—— 数据源是中短期票据曲线，
       本项目没有城投曲线。模型若把这里读成「城投」，整段结论就架空了。 */
    if (Array.isArray(mk.spreads) && mk.spreads.length) {
      L.push("【中票利差】对同期限国债（bp，中短期票据曲线，非城投）");
      L.push("  " + mk.spreads.map(s => s.issuer + s.tenor + " " + s.spread.toFixed(1)
        + (isFinite(s.chg) && s.chg !== 0 ? "(" + (s.chg > 0 ? "+" : "") + s.chg.toFixed(1) + ")" : ""))
        .join("｜"));
      L.push("  括号内为较前一日；走阔=信用债跑输国债（不利），收窄=跑赢。仅 1/3/5 年可算。");
    }
  } else {
    L.push("【债市】本轮没有可用的债市快照。凡涉及市场环境的判断只能写「数据块里没有」。");
  }

  /* v118：宏观。三项月度实际值，放在债市之后、盘中之前 —— 从「债市本身」
     扩到「更宽的经济背景」，再落到「此刻」。不写「超预期」：没有预期值可比。
     ★ 月份相同就提到句首只写一次：三项通常同月，逐个标「（2026年10月…）」
       要多花一倍字，而这一段的价值在数不在日期。 */
  const mc = o.macro;
  if (mc && Array.isArray(mc.items) && mc.items.length) {
    const periods = [];
    for (const it of mc.items) if (periods.indexOf(it.periodText) < 0) periods.push(it.periodText);
    const same = periods.length === 1;
    L.push("【宏观】" + (same ? periods[0] + "：" : "")
      + mc.items.map(it => it.name + " " + it.valText
        + (it.deltaText ? "（" + (same ? "" : it.periodText + "，") + it.deltaText + "）" : ""))
        .join("｜"));
    L.push("  月度实际值，没有预期值：不许写「超预期 / 低于预期」，不许推断下次数据。");
  } else if (mc === null || (mc && mc.none)) {
    L.push("【宏观】本轮没取到 CPI / PPI / PMI。凡需要宏观数据的话只能写「数据块里没有」。");
  }

  /* v117：盘中参考价。与上面【债市】不是同一口径 —— 一个是中债估值（收盘后才有），
     一个是东财行情（盘中就有）。分开写、明确声明不混算，是这一段存在的全部理由：
     不写这句，模型一定会把 1.5983% 与 1.6120% 说成「上行 1.37bp」。 */
  const lv = o.live;
  if (lv && Array.isArray(lv.items) && lv.items.length) {
    L.push("【盘中参考】" + lv.srcText + " " + lv.atText + "（" + lv.phaseLabel + "）");
    L.push("  " + lv.items.map(it => {
      const bk = [it.chgText, it.histText].filter(Boolean).join("；");
      return it.name + " " + it.valText + (bk ? "（" + bk + "）" : "");
    }).join("｜"));
    /* v119：有 5日/20日 时补一句基准说明。不补的话模型很容易把
       「当日 -0.03%」和「5日 -0.12%」当成同一条序列上的两个数去相加。 */
    const hasHist = lv.items.some(it => it.histText);
    L.push("  口径：盘中价，非中债估值；不与上段加减比。"
      + (hasHist ? "5日/20日 为对上 N 个交易日收盘，与当日涨跌基准不同，不许相加。" : "")
      + "引用须带「截至" + lv.atText + "」，勿写「收盘」。");
    if (lv.missText) L.push("  本轮缺：" + lv.missText);
  }

  const gaps = Array.isArray(o.gaps) ? o.gaps.filter(Boolean) : [];
  /* 日历（v114）：只给日子与「距今几天」，不给「会抽走多少流动性」——
     那需要超储率与准备金率，本机没有。模型不许在这上面加戏。 */
  if (Array.isArray(o.cal) && o.cal.length) {
    const line = pubCalText(o.cal, /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) ? String(o.today) : "");
    if (line) L.push(line);
  }
  L.push("【拿不到的数据】" + (gaps.length ? gaps.join("、") : "无"));
  if (ses.key === "intraday") {
    /* v117：这句原来写死「本机没有实时行情」。v116 之后已经不成立 —— 有此刻层
       （国债收益率、国债期货、交易所回购）。但只覆盖这三类，其余品种仍是上一交易日收盘，
       所以两句话都得说，不能只说一半。 */
    L.push(o.live && o.live.items && o.live.items.length
      ? "【盘中说明】盘口仅三类；国开、信用债等仍为上一交易日收盘。"
      : "【盘中说明】本轮没取到盘中行情：上面所有价格都是上一交易日收盘，今天还没有任何成交数据。");
  }
  L.push("【写什么】" + (o.kind === "product"
    ? "三段：这一段走势是什么性质、市场环境是顺风还是逆风、还差多少与要多久。"
    : "三段：结构上有没有需要处理的地方、哪只在什么位置、下一步盯什么。"));
  return L.join("\n");
}

/* ---------------- 渲染 ---------------- */

const UP = "rp-up", DOWN = "rp-down", FLAT = "rp-flat";

/**
 * 两张表。**所有数字来自本地**，模型碰不到。
 * 涨跌配色按 A 股习惯：红 = 涨 / 收益率下行（债券价格涨），绿 = 跌。
 * @param {{ nav?:any, rows?:any[], market?:any, kind?:string, scenarios?:any }} f
 */
export function reportTableHtml(f) {
  const o = f || {};
  let out = "";
  if (o.kind === "product" && o.nav && o.nav.ok) {
    const nv = o.nav;
    const rows = nv.tail.map(t => {
      const cls = t.flag === "shock" ? " class=\"rp-lo\"" : t.flag === "peak" ? " class=\"rp-hi\"" : "";
      const mark = t.flag === "shock" ? "<i class=\"rp-mk b\">冲击</i>"
        : t.flag === "peak" ? "<i class=\"rp-mk\">前高</i>" : "";
      const c = t.bp > 0 ? UP : t.bp < 0 ? DOWN : FLAT;
      return `<tr${cls}><td>${esc(t.date.slice(5))}${mark}</td><td>${esc(t.value.toFixed(6))}</td>`
        + `<td class="${c}">${esc(bpText(t.bp, 2))}</td></tr>`;
    }).join("");
    out += `<div class="rp-sec"><div class="rp-sh"><h4>这只产品的净值</h4>`
      + `<span class="rp-tag calc">本地算 · 近 ${nv.tail.length} 个披露点</span></div>`
      + `<table class="rp-tb"><tr><th>日期</th><th>净值</th><th>日变动</th></tr>${rows}</table>`
      + `<div class="rp-sum">${esc(navSummary(nv))}</div></div>`;
    if (o.scenarios && o.scenarios.ok) out += scenarioHtml(o.scenarios);
  } else if (o.kind !== "product" && Array.isArray(o.rows) && o.rows.length) {
    /* 占比整列都没值（只有一只持仓 / 金额被隐藏）时干脆不画这一列：
       一列全是「—」既占地方又让人以为算坏了。 */
    const showW = o.rows.some(r => r && r.w != null);
    const rows = o.rows.map(r => {
      /* 先舍入再判号：-0.0004 直接拼出来是「-0.00%」，红色，可它数值上就是零。
         文字与颜色必须同源，否则同一格里写着 0.00% 却染成亏损色。 */
      const d30v = r.d30 == null ? null : Number(r.d30.toFixed(2));
      const ddv = r.dd == null ? null : Number(r.dd.toFixed(2));
      const d30 = d30v == null ? "—" : (d30v > 0 ? "+" : "") + d30v.toFixed(2) + "%";
      const dd = ddv == null ? "—" : ddv.toFixed(2) + "%";
      const gap = r.gapBp == null ? "—" : (r.gapBp > 0 ? r.gapBp.toFixed(1) : "前高上");
      const c = d30v == null ? FLAT : d30v > 0 ? UP : d30v < 0 ? DOWN : FLAT;
      /* v114：占比与「落后」进表 —— 掉队的那只如果只占 3%，和占 40%，处理方式是两回事；
         落后贴在名字下面，不单开一列（六列在 420px 上已经挤）。 */
      const w = r.w == null ? "—" : (r.w * 100).toFixed(0) + "%";
      const late = r.lag != null && r.lag >= 2
        ? `<i class="rp-mk b">落后 ${r.lag} 日</i>` : "";
      return `<tr><td>${esc(r.name)}${late}</td>${showW ? `<td>${esc(w)}</td>` : ""}<td>${esc(fx(r.nav, 4))}</td>`
        + `<td class="${c}">${esc(d30)}</td><td class="${ddv != null && ddv < 0 ? DOWN : FLAT}">${esc(dd)}</td>`
        + `<td>${esc(gap)}</td></tr>`;
    }).join("");
    out += `<div class="rp-sec"><div class="rp-sh"><h4>持仓一览</h4>`
      + `<span class="rp-tag calc">本地算 · ${o.rows.length} 只</span></div>`
      + `<table class="rp-tb"><tr><th>产品</th>${showW ? "<th>占比</th>" : ""}<th>净值</th><th>近30点</th><th>回撤</th><th>距前高</th></tr>${rows}</table></div>`;
  }
  const mk = o.market;
  if (mk && mk.ok) {
    const rows = mk.rows.map(r => `<tr><td>国债 ${esc(r.tenor)}</td><td>${esc(fx(r.y, 4))}%</td>`
      + `<td class="${r.bp1 > 0 ? DOWN : r.bp1 < 0 ? UP : FLAT}">${esc(fx(r.bp1, 1))}</td>`
      + `<td class="${r.bp5 > 0 ? DOWN : r.bp5 < 0 ? UP : FLAT}">${esc(fx(r.bp5, 1))}</td>`
      + `<td class="${r.bp20 > 0 ? DOWN : r.bp20 < 0 ? UP : FLAT}">${esc(fx(r.bp20, 1))}</td></tr>`).join("");
    const extra = mk.small.map(s => `${s.tenor} ${s.bp1.toFixed(1)}`).join("、");
    const aaa = mk.aaa.map(s => `${s.tenor} ${s.bp1.toFixed(1)}`).join("、");
    out += `<div class="rp-sec"><div class="rp-sh"><h4>债市关键期限</h4>`
      + `<span class="rp-tag local">本地 · ${esc(mk.asOf.slice(5))} 收盘 · 单位 bp</span></div>`
      + `<table class="rp-tb"><tr><th>期限</th><th>收益率</th><th>当日</th><th>5日</th><th>20日</th></tr>${rows}</table>`
      + `<div class="rp-sum alt">单位 BP，<b>负 = 收益率下行 = 债券价格上涨</b>。`
      + (extra ? "另有 " + esc(extra) + "（仅当日）" + (aaa ? "，" : "。") : "")
      + (aaa ? "信用 AAA " + esc(aaa) + "。" : "")
      + (mk.allDown ? "全期限同日下行，无一处反转。" : mk.allUp ? "全期限同日上行，无一处反转。" : "")
      + `</div></div>`;
  }
  return out;
}

/** 三档情景表（v114）。三行并列，**没有一档叫「预测」**。 */
export function scenarioHtml(sc) {
  if (!sc || !sc.ok) return "";
  const rows = sc.rows.map(r => {
    const c = r.cumBp > 0 ? UP : r.cumBp < 0 ? DOWN : FLAT;
    return `<tr><td>${esc(r.name)}<i class="rp-mk">${esc(r.note)}</i></td>`
      + `<td>${esc(r.perBp == null ? "—" : bpText(r.perBp, 1))}</td>`
      + `<td class="${c}">${esc(bpText(r.cumBp, 1))}</td>`
      + `<td>${esc(r.nav.toFixed(6))}</td></tr>`;
  }).join("");
  return `<div class="rp-sec"><div class="rp-sh"><h4>往前推 ${sc.k} 个披露点</h4>`
    + `<span class="rp-tag calc">本地算 · 三档并列 · 不是预测</span></div>`
    + `<table class="rp-tb"><tr><th>口径</th><th>每点</th><th>累计</th><th>净值</th></tr>${rows}</table>`
    + `<div class="rp-sum alt">三档是三种<b>速度</b>，不是三个判断。`
    + (sc.byDate ? "按最近 21 个点的节奏，第 " + sc.k + " 个点约在 " + esc(sc.byDate.slice(5)) + "。" : "")
    + `</div></div>`;
}

/** 日历胶囊（v114）：与时间坐标同一层级，都是日期，都不参与结论。 */
export function reportCalHtml(cal) {
  const chips = pubCalChips(cal);
  if (!chips) return "";
  return `<div class="rp-cal"><span class="rp-cal-h">日历</span>${chips}</div>`;
}

/** 表下那句「本地算出来的结论」。措辞固定，才能被测试断言。 */
export function navSummary(nv) {
  if (!nv || !nv.ok) return "";
  const s = [];
  if (nv.shock) {
    /* σ 为 0 表示样本不足：这时候写「0.0 倍」是把「算不出来」画成了「没有波动」。 */
    s.push(nv.shock.date.slice(5) + " 单日 " + bpText(nv.shock.bp)
      + (nv.sigmaBp > 0 ? "，是常态波动（σ≈" + nv.sigmaBp.toFixed(1) + "bp）的 " + nv.shock.sigma.toFixed(1) + " 倍" : "")
      + "；随后 " + nv.shock.days + " 个披露点累计 "
      + bpText(nv.shock.backBp) + "，把这次冲击收回了 " + (nv.shock.ratio * 100).toFixed(1) + "%。");
  }
  if (nv.gapBp > 0) {
    s.push("离 " + nv.peak.date.slice(5) + " 的前高仍差 " + nv.gapBp.toFixed(1) + "bp —— 按常态日收益 "
      + bpText(nv.normalBp) + " 算要 " + nv.etaNormal + " 个披露点，按最近两日速度算 "
      + (nv.etaFast > 0 ? nv.etaFast + " 个" : "已经够") + "。");
  } else {
    s.push("已在 " + nv.peak.date.slice(5) + " 的高点之上。");
  }
  return s.join("");
}

/**
 * 时间坐标：三个日期不一样，本身就是一条信息。
 * @param {{ session:any, nav?:any, market?:any, rows?:any[], live?:any }} f
 */
export function reportCoordsHtml(f) {
  const o = /** @type {any} */ (f || {});
  const ses = o.session || {};
  const out = [];
  if (o.nav && o.nav.ok) {
    out.push(`<span class="rp-co${o.nav.missing && o.nav.missing.length ? " warn" : ""}">净值 ${esc(o.nav.last.date.slice(5))}</span>`);
  } else if (Array.isArray(o.rows) && o.rows.length) {
    /* 组合层：显示「最新那一只的净值日」与「最旧的那只」—— 两者不同时给区间，
       只给最新会让人以为整套都到那天了。 */
    const ds = o.rows.map(r => String(r.navDate || "")).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (ds.length) {
      const newest = ds[ds.length - 1], oldest = ds[0];
      out.push(`<span class="rp-co${newest !== oldest ? " warn" : ""}">净值 ${esc(newest.slice(5))}`
        + (newest !== oldest ? `（最早 ${esc(oldest.slice(5))}）` : "") + `</span>`);
    }
  }
  /* 债市胶囊只写日期，不写「落后几个交易日」：那个数是相对**今天**算的，
     而读者看到这一行时的疑问是「净值为什么比债市旧」—— 两个数不同源，写在一行里必被误读。
     落后几天由 reportWatch() 单独说一句。 */
  const mk = o.market;
  if (mk && mk.ok) {
    out.push(`<span class="rp-co${mk.lagTradeDays >= 2 ? " warn" : ""}">债市 ${esc(mk.asOf.slice(5))}</span>`);
  }
  /* v117：盘中参考价单独一颗胶囊，且一定带时点。只写「盘中」不给时刻，
     两小时后看这份就像刚生成的 —— 时点这一行存在的意义就是防止这种误读。 */
  if (o.live && o.live.atText) {
    out.push(`<span class="rp-co rp-co-live">盘中 ${esc(o.live.atText)}</span>`);
  }
  out.push(`<span class="rp-co">生成 ${esc(ses.atText || "")}</span>`);
  return `<div class="rp-cos">${out.join("")}</div>`;
}

/* ---------------- 数字白名单 ---------------- */

/** 量词、序数、月份这些不是「数据」，放行。**范围刻意收窄** —— 宽了就失去意义。 */
const SAFE_NUM = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
  "20", "30", "60", "90", "100", "120", "150", "180", "240", "360", "365"]);

/**
 * 把模型文本里的数字逐个与事实集比对。
 * 容忍 0~4 位舍入：事实 1.014962 允许出现 1、1.0、1.01、1.015、1.0150。
 *
 * @param {string} text 模型写的正文
 * @param {number[]} values 事实集里的全部数值
 * @returns {{ total: number, unknown: string[], ratio: number }}
 */
export function reportNumberAudit(text, values) {
  const set = new Set(SAFE_NUM);
  for (const v of (Array.isArray(values) ? values : [])) {
    const n = Number(v);
    if (!isFinite(n)) continue;
    /* 0~6 位：净值是 6 位小数（1.014962），只到 4 位会把「原样引用」也判成错。
       同时收「四舍五入」与「就地截断」两种写法：1.014962 抄成 1.0150 与 1.0149
       都是抄，不是编。截断变体不会让编出来的数蒙混过关 —— 99.9 依然不在集合里。 */
    for (let dp = 0; dp <= 6; dp++) {
      const p = Math.pow(10, dp);
      set.add((Math.round(n * p) / p).toFixed(dp));
      set.add((Math.trunc(n * p) / p).toFixed(dp));
      const a = Math.abs(n);
      set.add((Math.round(a * p) / p).toFixed(dp));
      set.add((Math.trunc(a * p) / p).toFixed(dp));
    }
  }
  /* 日期先整体抠掉：11-02 会被切成 11 与 -02、10-29 会被切成 10 与 -29，
     两个碎片都不在事实集里，一次就误报两条。日期不是「数据」，不该进这个账。
     v118：时刻同理 —— 「截至 15:10」会被切成 15 与 10，两个碎片照样不在集合里。
     时点是时点，不是数；不放行的话，只要正文带「截至 HH:MM」就必留一条假告警。
     v119：期限/日期单位同理。「5日 +0.12%」会切出 5 与 20（「20日」）两个碎片，
     「10年国债 1.5983%」会切出 10 —— 它们都是标签，不是被引用的数。
     注意只抠「数字+年/月/日」这一种形态：数据后面跟的是 %、bp、点、倍，
     不会被这条规则碰到，所以不会把编造的数放过去。 */
  const s = String(text == null ? "" : text)
    .replace(/\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}/g, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:年|月|日)/g, " ");
  /* 负号要吃掉：模型写 −11.5bp 与 -11.5bp 是同一个数。 */
  const re = /[−\-+]?\d+(?:\.\d+)?/g;
  const total = [];
  const unknown = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    const key = raw.replace(/^[−\-+]/, "");
    total.push(raw);
    /* 前导零要归一：日期「11-02」会被正则切成 11 与 -02，02 与 2 是同一个数。 */
    const k2 = key.replace(/^0+(?=\d)/, "");
    if (set.has(key) || set.has(k2)) continue;
    if (/^(19|20)\d{2}$/.test(key)) continue;
    if (!unknown.includes(raw)) unknown.push(raw);
  }
  return {
    total: total.length,
    unknown,
    ratio: total.length ? unknown.length / total.length : 0,
  };
}
