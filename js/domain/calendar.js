// @ts-check
/* 交易日历：判断「是不是交易日」、按 T+N 推算确认日、衡量净值滞后。
   纯函数 + 一份可被数据文件覆盖的节假日表，不读全局 DATA。

   为什么需要它：
     理财产品的申购/赎回是「T 日申请、T+1 确认」，而 T 不是「明天」——
     要跳过周末、法定节假日和调休。以前确认日期默认填「今天」，遇到
     周五买入 / 国庆前买入，份额会早到 1~8 天，持仓收益跟着算错。
     净值滞后提示同理：只按自然日算「两天没更新」会在长假里误报。

   数据来源：国务院办公厅关于 2025 / 2026 年部分节假日安排的通知。
     · holidays：放假（含周末连休里被调休覆盖的工作日）
     · workdays：调休上班的周末（银行按「工作日」受理，算交易日）
   2027 年的安排通常在 2026 年底公布，未配置的年份按「周一至周五」估算，
   并在结果里带 unknownYears，由界面提示「按估算推算，可手动改」。
   云端也可以把新一年写进 licai-data.json 的 settings.tradeCal，App 启动时
   用 configureCalendar() 合并 —— 不用发新版 APK 就能更新日历。 */

/** @typedef {{ holidays: readonly string[], workdays: readonly string[] }} YearCal */
/** @typedef {{ years?: Record<string, YearCal>, cutoffs?: Record<string, string> }} CalendarConfig */
/** @typedef {{ applyDate: string, confirmDate: string, navDate: string,
 *             deferred: boolean, rolled: boolean, unknownYears: string[] }} TradeDates */

/* ============================================================
   节假日数据
   ============================================================ */
export const TRADE_CAL = {
  "2025": {
    holidays: [
      "2025-01-01",
      "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
      "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
      "2025-04-04", "2025-04-05", "2025-04-06",
      "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
      "2025-05-31", "2025-06-01", "2025-06-02",
      "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04",
      "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",
    ],
    workdays: ["2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"],
  },
  "2026": {
    holidays: [
      "2026-01-01", "2026-01-02", "2026-01-03",
      "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
      "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
      "2026-04-04", "2026-04-05", "2026-04-06",
      "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
      "2026-06-19", "2026-06-20", "2026-06-21",
      "2026-09-25", "2026-09-26", "2026-09-27",
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
      "2026-10-05", "2026-10-06", "2026-10-07",
    ],
    workdays: ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"],
  },
};

export const CAL_META = {
  updated: "2026-10-29",
  source: "国务院办公厅 2025 / 2026 年部分节假日安排通知",
};

/* 默认截止时间：15:00 前提交按当日受理，之后顺延到下一个交易日。
   各家银行可能不同，可被 configureCalendar({ cutoffs }) 或数据文件覆盖；
   取不到具体机构时用 _default。 */
export const DEFAULT_CUTOFF = "15:00";

/* ============================================================
   内部状态
   ============================================================ */
/** @type {Record<string, YearCal>} */
let CAL = {};
/** @type {Record<string, string>} */
let CUTOFFS = {};
/** @type {Map<string, { hol: Set<string>, work: Set<string> }>} */
const SETS = new Map();
/** @type {Set<string>} */
const WARNED = new Set();

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

/** @param {string} date */
function isDateStr(date) {
  const m = DATE_RE.exec(String(date || ""));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** @param {number} n */
function fromNum(n) {
  const dt = new Date(n * DAY_MS);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
  return `${y}-${m < 10 ? "0" + m : m}-${d < 10 ? "0" + d : d}`;
}

/** 日期转「1970-01-01 起的天数」；非法返回 NaN。用 UTC 避免时区把日期挪一天 */
/** @param {string} date */
function dayNum(date) {
  const m = DATE_RE.exec(String(date || ""));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS;
}

/** 1970-01-01 是星期四（4） */
/** @param {number} n */
function weekdayOf(n) { return ((n + 4) % 7 + 7) % 7; }

/**
 * @param {any} raw
 * @returns {YearCal | null}
 */
function normalizeYear(raw) {
  if (!raw || typeof raw !== "object") return null;
  const holidays = Array.isArray(raw.holidays) ? raw.holidays.filter(isDateStr) : [];
  const workdays = Array.isArray(raw.workdays) ? raw.workdays.filter(isDateStr) : [];
  if (!holidays.length && !workdays.length) return null;
  return { holidays, workdays };
}

function loadBase() {
  CAL = {};
  for (const y of Object.keys(TRADE_CAL)) {
    const n = normalizeYear(TRADE_CAL[y]);
    if (n) CAL[y] = n;
  }
  SETS.clear(); WARNED.clear();
  CUTOFFS = {};
}
loadBase();

/**
 * 合并外部日历配置（云端 settings.tradeCal 或测试）。只增改，不清空已有年份。
 * @param {CalendarConfig | null | undefined} cfg
 * @returns {boolean} 是否有任何一项被采纳
 */
export function configureCalendar(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  let changed = false;
  const years = cfg.years;
  if (years && typeof years === "object") {
    for (const y of Object.keys(years)) {
      if (!/^\d{4}$/.test(y)) continue;
      const n = normalizeYear(years[y]);
      if (!n) continue;
      CAL[y] = n; SETS.delete(y); WARNED.delete(y); changed = true;
    }
  }
  const cut = cfg.cutoffs;
  if (cut && typeof cut === "object") {
    for (const k of Object.keys(cut)) {
      const v = cut[k];
      if (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v)) { CUTOFFS[k] = v; changed = true; }
    }
  }
  return changed;
}

/** 恢复内置日历（测试用；运行时不需要） */
export function resetCalendar() { loadBase(); }

/** @param {string} y */
function setsFor(y) {
  let s = SETS.get(y);
  if (!s) {
    const c = CAL[y];
    s = { hol: new Set(c ? c.holidays : []), work: new Set(c ? c.workdays : []) };
    SETS.set(y, s);
  }
  return s;
}

/** 已配置的年份（升序） */
export function calendarYears() {
  return Object.keys(CAL).map(Number).sort((a, b) => a - b);
}

/** @param {number | string} y */
export function isYearConfigured(y) { return !!CAL[String(y)]; }

/** @param {string} date */
export function yearOf(date) {
  const m = DATE_RE.exec(String(date || ""));
  return m ? m[1] : "";
}

/* ============================================================
   交易日判定
   ============================================================ */
/**
 * 是否交易日：调休上班日 → 是；法定假日 → 否；其余看周一到周五。
 * 未配置年份按周一至周五估算，并在控制台提示一次。
 * @param {string} date
 */
export function isTradeDay(date) {
  const n = dayNum(date);
  if (!Number.isFinite(n)) return false;
  const y = yearOf(date);
  const s = setsFor(y);
  if (s.work.has(date)) return true;
  if (s.hol.has(date)) return false;
  if (!CAL[y] && !WARNED.has(y)) {
    WARNED.add(y);
    try {
      console.warn(`[calendar] ${y} 年节假日未配置，按周一至周五估算；可在 licai-data.json 的 settings.tradeCal 里补充`);
    } catch (e) { }
  }
  const wd = weekdayOf(n);
  return wd >= 1 && wd <= 5;
}

/**
 * 下一个交易日（严格晚于 date；includeSelf=true 时当天是交易日则返回当天）
 * @param {string} date
 * @param {boolean} [includeSelf]
 */
export function nextTradeDay(date, includeSelf = false) {
  let n = dayNum(date);
  if (!Number.isFinite(n)) return "";
  if (includeSelf && isTradeDay(date)) return date;
  for (let i = 0; i < 800; i++) {
    n += 1;
    const d = fromNum(n);
    if (isTradeDay(d)) return d;
  }
  return "";
}

/**
 * 上一个交易日（严格早于 date）
 * @param {string} date
 */
export function prevTradeDay(date) {
  let n = dayNum(date);
  if (!Number.isFinite(n)) return "";
  for (let i = 0; i < 800; i++) {
    n -= 1;
    const d = fromNum(n);
    if (isTradeDay(d)) return d;
  }
  return "";
}

/**
 * 非交易日顺延到下一个交易日；本身是交易日则原样返回。
 * @param {string} date
 */
export function rollForward(date) { return isTradeDay(date) ? date : nextTradeDay(date); }

/**
 * 从 date 往后数 n 个交易日（n=1 → 下一个交易日）。
 * @param {string} date
 * @param {number} n
 */
export function addTradeDays(date, n) {
  let d = date;
  const step = n >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(n); i++) {
    d = step > 0 ? nextTradeDay(d) : prevTradeDay(d);
    if (!d) break;
  }
  return d;
}

/**
 * (from, to] 之间的交易日数 —— 「净值落后几个交易日」就用它。
 * @param {string} from
 * @param {string} to
 */
export function tradeDaysBetween(from, to) {
  let n = dayNum(from), m = dayNum(to);
  if (!Number.isFinite(n) || !Number.isFinite(m) || m <= n) return 0;
  let c = 0;
  while (n < m && c < 4000) { n += 1; if (isTradeDay(fromNum(n))) c++; }
  return c;
}

/* ============================================================
   截止时间与 T+N 推算
   ============================================================ */
/**
 * 某机构的受理截止时间（HH:MM）。未配置时回落 _default，再回落 15:00。
 * @param {string} [orgKey]
 */
export function cutoffOf(orgKey) {
  return (orgKey && CUTOFFS[orgKey]) || CUTOFFS._default || DEFAULT_CUTOFF;
}

/** @param {Date} now @param {string} cutoff */
function pastCutoff(now, cutoff) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cutoff);
  if (!m) return false;
  return now.getHours() * 60 + now.getMinutes() >= (+m[1]) * 60 + (+m[2]);
}

/** @param {Date} d */
function localDate(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  return `${y}-${m < 10 ? "0" + m : m}-${day < 10 ? "0" + day : day}`;
}

/**
 * 由「交易日期」推算受理日 / 确认日 / 确认净值日。
 * 规则：
 *   · 申请日不是交易日 → 顺延到下一个交易日；
 *   · 申请日就是今天且已过截止时间 → 顺延到下一个交易日（deferred=true）；
 *   · 确认日 = 受理日之后的第 1 个交易日（T+1）；
 *   · 确认净值日 = 受理日（份额按受理日净值计算）。
 * @param {string} tradeDate
 * @param {Date} [now]
 * @param {string} [orgKey]
 * @returns {TradeDates}
 */
export function suggestTradeDates(tradeDate, now = new Date(), orgKey = "") {
  const todayStr = localDate(now);
  const base = isDateStr(tradeDate) ? tradeDate : todayStr;
  let apply, deferred = false;
  if (base === todayStr && isTradeDay(base) && pastCutoff(now, cutoffOf(orgKey))) {
    apply = nextTradeDay(base); deferred = true;
  } else {
    apply = rollForward(base);
  }
  if (!apply) apply = base;
  const confirmDate = addTradeDays(apply, 1) || apply;
  const years = Array.from(new Set([yearOf(base), yearOf(apply), yearOf(confirmDate)]))
    .filter(y => y && !isYearConfigured(y));
  return { applyDate: apply, confirmDate, navDate: apply, deferred, rolled: apply !== base, unknownYears: years };
}

/* ============================================================
   v133 · 产品级「购买规则 / 净值确认逻辑」
   ============================================================
   背景：不同理财产品的申购确认规则不一样，写死「按申请日净值、T+1 确认」
   会算错。例如「安盈稳健日开7号」是「交易日 17:00 前买入 → 按 T+1 净值
   计算份额、T+2 确认」；11.12（T）买入按 11.13（T+1）净值，而 11.13 净值
   尚未披露，这笔必须整笔在途、不能提前确认份额，否则会用滞后的旧净值
   （如停在 11.06 的 1.004402）凭空算出浮亏。

   规则对象（存在产品 p.buyRule，可留空 = 用默认）：
     · cutoff        "17:00"  申购截止时点（HH:MM）。空串 = 用机构/全局截止。
     · navOffset     integer  确认净值日 = 受理日 + N 个交易日（默认 0 = 当日）。
     · confirmOffset integer  份额确认日 = 确认净值日 + N 个交易日（默认 1）。
       相对「确认净值日」而非受理日：净值披露后才确认份额，时序才对。
   三个字段都容错归一，非法值回落默认 —— 用户手填错也不会让推算崩掉。

   DEFAULT_BUY_RULE 刻意等于旧的 suggestTradeDates 行为（navOffset=0 →
   navDate=受理日；confirmOffset=1 → confirmDate=受理日+1；用机构截止），
   保证没配规则的产品零回归。 */

/** 默认购买规则：按受理日净值、净值日次日确认、沿用机构截止时点。 */
export const DEFAULT_BUY_RULE = Object.freeze({
  cutoff: "", navOffset: 0, confirmOffset: 1,
});

/**
 * 归一化产品购买规则。任何非法/缺失字段都回落默认，绝不抛错。
 * @param {any} raw
 * @returns {{cutoff: string, navOffset: number, confirmOffset: number}}
 */
export function normBuyRule(raw) {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  /* 截止时点不光要格式对，时分还得在合法范围：只验 /^\d{1,2}:\d{2}$/ 会放过
     "25:99"，pastCutoff 拿 1599 分钟去比，永远不会触发顺延。 */
  const cm = /^(\d{1,2}):(\d{2})$/.exec(String(r.cutoff == null ? "" : r.cutoff).trim());
  const cutoff = (cm && +cm[1] <= 23 && +cm[2] <= 59)
    ? `${String(+cm[1]).padStart(2, "0")}:${cm[2]}` : "";
  const off = (v, fallback, max) => {
    const n = Number(v);
    return (Number.isInteger(n) && n >= 0 && n <= max) ? n : fallback;
  };
  return {
    cutoff,
    navOffset: off(r.navOffset, DEFAULT_BUY_RULE.navOffset, 10),
    confirmOffset: off(r.confirmOffset, DEFAULT_BUY_RULE.confirmOffset, 10),
  };
}

/** 产品是否显式配置了购买规则（用于表单提示「按产品规则自动带入」）。 */
export function hasBuyRule(p) {
  if (!p || !p.buyRule || typeof p.buyRule !== "object") return false;
  const r = normBuyRule(p.buyRule);
  return r.cutoff !== "" || r.navOffset !== DEFAULT_BUY_RULE.navOffset
    || r.confirmOffset !== DEFAULT_BUY_RULE.confirmOffset;
}

/** @typedef {{ applyDate: string, confirmDate: string, navDate: string,
 *             deferred: boolean, rolled: boolean, unknownYears: string[],
 *             cutoff: string, navOffset: number, confirmOffset: number }} BuyDates */

/**
 * 按产品购买规则，由「交易日期 + 是否在截止后」推算受理日/确认净值日/确认日。
 * 与 suggestTradeDates 的差异：
 *   · 截止时点用规则里的 cutoff（没有才回落机构/全局）；
 *   · 确认净值日 = 受理日 + navOffset 个交易日（不再恒等于受理日）；
 *   · 份额确认日 = 确认净值日 + confirmOffset 个交易日（净值披露后才确认）；
 *   · pastCutoff 由调用方传 afterCutoff 显式决定（补录历史交易时不能拿
 *     「现在几点」去判断那笔是不是过了截止，那会用今天的时间改写历史）。
 * 不传 afterCutoff 时沿用 suggestTradeDates 的实时判定，保持零回归。
 * @param {string} tradeDate
 * @param {any} buyRule 产品 p.buyRule（内部归一化）
 * @param {{ now?: Date, orgKey?: string, afterCutoff?: boolean }} [opts]
 * @returns {BuyDates}
 */
export function suggestBuyDates(tradeDate, buyRule, opts = {}) {
  const rule = normBuyRule(buyRule);
  const now = opts.now || new Date();
  const orgKey = opts.orgKey || "";
  const cutoff = rule.cutoff || cutoffOf(orgKey);
  const todayStr = localDate(now);
  const base = isDateStr(tradeDate) ? tradeDate : todayStr;
  const past = (opts.afterCutoff === true)
    || (opts.afterCutoff === undefined && base === todayStr && isTradeDay(base) && pastCutoff(now, cutoff));
  let apply, deferred = false;
  if (past && base === todayStr && isTradeDay(base)) {
    apply = nextTradeDay(base); deferred = true;
  } else if (past) {
    /* 补录的「截止后」历史单：受理日顺延到下一交易日 */
    apply = nextTradeDay(rollForward(base)); deferred = true;
  } else {
    apply = rollForward(base);
  }
  if (!apply) apply = base;
  const navDate = addTradeDays(apply, rule.navOffset) || apply;
  const confirmDate = addTradeDays(navDate, rule.confirmOffset) || navDate;
  const years = Array.from(new Set([yearOf(base), yearOf(apply), yearOf(navDate), yearOf(confirmDate)]))
    .filter(y => y && !isYearConfigured(y));
  return {
    applyDate: apply, confirmDate, navDate, deferred, rolled: apply !== base,
    unknownYears: years, cutoff, navOffset: rule.navOffset, confirmOffset: rule.confirmOffset,
  };
}

/* ============================================================
   净值滞后
   ============================================================ */
/**
 * 最新净值日期落后今天几个交易日（0 = 今天或未来，1 = 正常等待披露）。
 * @param {string} navDate
 * @param {string} [todayStr]
 */
export function navLagTradingDays(navDate, todayStr = localDate(new Date())) {
  return tradeDaysBetween(navDate, todayStr);
}

/**
 * 是否已经「该披露却没披露」：滞后 ≥ minLag 个交易日。
 * @param {string} navDate
 * @param {string} [todayStr]
 * @param {number} [minLag]
 */
export function navIsStale(navDate, todayStr = localDate(new Date()), minLag = 2) {
  return navLagTradingDays(navDate, todayStr) >= minLag;
}
