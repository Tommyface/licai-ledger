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
import { isTradeDay, nextTradeDay, tradeDaysBetween } from "./calendar.js";

/* ---------------- 时点 ---------------- */

/** 四个时点。key 进指纹 —— 换时点就该重新生成，因为叙述重心换了。 */
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
 * @returns {{ key: string, label: string, tradeDay: boolean, atText: string, dateText: string,
 *   wdText: string, focus: string, heading: string, fresh: boolean }}
 */
export function reportSession(nowTs, today, marketAsOf) {
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
  const focus = key === "preopen"
    ? "先讲上一交易日发生了什么，再讲今天开盘要盯什么。今天还没有任何成交数据。"
    : key === "intraday"
      ? "先讲今天到现在能看出什么。本机没有实时行情，凡是需要盘中价格才能说的话，一律写「数据块里没有」。"
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
  };
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
    gaps: (m.meta && Array.isArray(m.meta.gaps)) ? m.meta.gaps.filter((g) => typeof g === "string" && g) : [],
    capturedAt: String((m.meta && m.meta.capturedAt) || ""),
  };
}

/* ---------------- 组合事实 ---------------- */

/**
 * 组合层横向表：每只一行。比单只的净值轨迹更适合看「结构」。
 * @param {Array<any>} items briefItems() 的产出
 * @returns {Array<{name:string,nav:number,navDate:string,d30:number|null,dd:number|null,gapBp:number|null}>}
 */
export function reportPortfolioRows(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map(it => {
    const m = (it && it.metrics) || {};
    const series = Array.isArray(it && it.series) ? it.series : null;
    let gapBp = null;
    if (series && series.length >= 2) {
      const f = reportNavFacts(series, {});
      if (f.ok) gapBp = f.gapBp;
    }
    return {
      name: String((it && it.name) || "（无名）"),
      nav: num(it && it.nav), navDate: String((it && it.navDate) || ""),
      d30: m.d30 == null ? null : num(m.d30),
      dd: m.dd == null ? null : num(m.dd),
      gapBp,
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
    const dates = x.rows.map(r => String(r.navDate || "")).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const stale = dates.filter(d => tradeDaysBetween(d, x.today) >= 2);
    if (stale.length) {
      out.push({
        level: "warn",
        text: "有 " + stale.length + " 只的净值停在 " + stale[0].slice(5) + " 或更早，落后 2 个交易日以上",
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
  if (ses && ses.key === "closed") {
    out.push({ level: "info", text: "今天休市（" + ses.wdText + "）", sub: "净值与曲线都不会更新，下一个交易日的口径见下" });
  }
  return out;
}

/* ---------------- 拼成请求 ---------------- */

/**
 * 装配模型输入。**约 700 到 800 字** —— 与 v111 同量级，不因为「改成研报」而变长。
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
      L.push("- 区间最大回撤 " + nv.dd.pct.toFixed(3) + "%（" + nv.dd.from.slice(5) + " → " + nv.dd.to.slice(5) + "）");
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
    } else {
      L.push("【净值】数据块里没有可用的净值序列（不足 2 个点）");
    }
  } else {
    const rows = Array.isArray(o.rows) ? o.rows : [];
    L.push("【持仓】" + rows.length + " 只");
    for (const r of rows) {
      L.push("- " + r.name + "：净值 " + fx(r.nav, 4) + "（" + (r.navDate ? r.navDate.slice(5) : "日期不明") + "）"
        + (r.d30 != null ? " · 近30点 " + (r.d30 >= 0 ? "+" : "") + r.d30.toFixed(2) + "%" : "")
        + (r.dd != null ? " · 最大回撤 " + r.dd.toFixed(2) + "%" : "")
        + (r.gapBp != null && r.gapBp > 0 ? " · 距前高 " + r.gapBp.toFixed(1) + "bp" : ""));
    }
  }

  if (mk && mk.ok) {
    L.push("【债市】中债官方曲线 " + mk.asOf.slice(5) + " 收盘（上一交易日 " + mk.prevDate.slice(5)
      + "）；比今天落后 " + mk.lagTradeDays + " 个交易日");
    L.push("  期限 收益率 当日 5日 20日（单位 bp，负=收益率下行=债券价格上涨）");
    for (const r of mk.rows) {
      L.push("  " + r.tenor + " " + fx(r.y, 4) + "% " + (isFinite(r.bp1) ? r.bp1.toFixed(1) : "—")
        + " " + (isFinite(r.bp5) ? r.bp5.toFixed(1) : "—")
        + " " + (isFinite(r.bp20) ? r.bp20.toFixed(1) : "—"));
    }
    if (mk.small.length) L.push("  另有：" + mk.small.map(s => s.tenor + " " + s.bp1.toFixed(1)).join("、") + "（仅当日）");
    if (mk.aaa.length) L.push("  信用AAA：" + mk.aaa.map(s => s.tenor + " " + fx(s.y, 4) + "%/" + s.bp1.toFixed(1)).join("、"));
    if (mk.allDown) L.push("  当日方向：全期限下行，无一处反转");
    else if (mk.allUp) L.push("  当日方向：全期限上行，无一处反转");
  } else {
    L.push("【债市】本轮没有可用的债市快照。凡涉及市场环境的判断只能写「数据块里没有」。");
  }

  const gaps = Array.isArray(o.gaps) ? o.gaps.filter(Boolean) : [];
  L.push("【拿不到的数据】" + (gaps.length ? gaps.join("、") : "无"));
  if (ses.key === "intraday") {
    L.push("【盘中说明】本机没有实时行情：上面所有价格都是上一交易日收盘，今天还没有任何成交数据。");
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
 * @param {{ nav?:any, rows?:any[], market?:any, kind?:string }} f
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
  } else if (o.kind !== "product" && Array.isArray(o.rows) && o.rows.length) {
    const rows = o.rows.map(r => {
      const d30 = r.d30 == null ? "—" : (r.d30 >= 0 ? "+" : "") + r.d30.toFixed(2) + "%";
      const dd = r.dd == null ? "—" : r.dd.toFixed(2) + "%";
      const gap = r.gapBp == null ? "—" : (r.gapBp > 0 ? r.gapBp.toFixed(1) : "前高上");
      const c = r.d30 == null ? FLAT : r.d30 >= 0 ? UP : DOWN;
      return `<tr><td>${esc(r.name)}</td><td>${esc(fx(r.nav, 4))}</td>`
        + `<td class="${c}">${esc(d30)}</td><td class="${r.dd != null && r.dd < 0 ? DOWN : FLAT}">${esc(dd)}</td>`
        + `<td>${esc(gap)}</td></tr>`;
    }).join("");
    out += `<div class="rp-sec"><div class="rp-sh"><h4>持仓一览</h4>`
      + `<span class="rp-tag calc">本地算 · ${o.rows.length} 只</span></div>`
      + `<table class="rp-tb"><tr><th>产品</th><th>净值</th><th>近30点</th><th>回撤</th><th>距前高 bp</th></tr>${rows}</table></div>`;
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
 * @param {{ session:any, nav?:any, market?:any, rows?:any[] }} f
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
     两个碎片都不在事实集里，一次就误报两条。日期不是「数据」，不该进这个账。 */
  const s = String(text == null ? "" : text).replace(/\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}/g, " ");
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
