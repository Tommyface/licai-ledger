// @ts-check
/* ---------- 公开日历（v114 · P1）----------
   资金面什么时候紧、什么时候松，大半由几个固定日子决定：缴准、税期截止、MLF、LPR、月末与季末。
   这一层把它们算出来，让研判能说「下周一缴准，距今 6 天」，而不是含糊地说「近期资金面可能有扰动」。

   ★ 三条纪律（改任何一条都要同步改 tests/pubcal.test.mjs）：

     1. **日期是算出来的，不是抄来的。** 每个规则只写「每月第几号」，真正的日期由
        calendar.js 的交易日历判断顺延 —— 2026-11-15 是周日，写死在表里就会提示一个
        不存在的缴准日。这是 v112 原型阶段踩过的坑。

     2. **口径有强弱之分，弱的必须标出来。** LPR（每月 20 日）与 MLF（每月 25 日，
        2024 年 7 月起由 15 日改到 25 日）是硬规则；税期截止（每月 15 日）是征管惯例；
        缴准按市场惯例记 15 日，但 2015 年改平均法考核后以央行口径为准 —— 这一条
        在 note 里写明「惯例」，不许与硬规则混成一句。

     3. **不预测，只报日子。** 这里不做「缴准会抽走多少流动性」这种估算：那需要
        超储率、准备金率、存款余额三样，本机一样都没有。宁可只说日期。
*/

import { isTradeDay, nextTradeDay, prevTradeDay } from "./calendar.js";

const WD_TEXT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** @param {number} n */
function pad2(n) { return String(n).padStart(2, "0"); }
/** @param {Date} d */
function fmt(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
/** @param {string} s */
function parse(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
/** @param {string} s */
function wdOf(s) { const d = parse(s); return d ? WD_TEXT[d.getDay()] : ""; }
/** 两个日期相差多少个自然日（正数表示 to 在 from 之后）。 */
/** @param {string} from @param {string} to */
export function daysBetween(from, to) {
  const a = parse(from), b = parse(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * 规则表。day 是「每月第几号」，不是算好的日期 —— 顺延由 rollForwardToTradeDay 做。
 * tone：warn 表示这一天通常让资金面更紧，info 表示只是一个信息点。
 *
 * v118 加了两条宏观公布窗口。它们的性质与上面四条**不同**：上面四条是资金面事件，
 * 下面两条是统计局的发布日程，所以：
 *   · tone 一律 info —— 数据公布本身不抽流动性，把 CPI 标成「偏紧」是误导；
 *   · soft: true —— 日期是我们按惯例推的，不是官方日程原文，pubCalText 不写「顺延」二字，
 *     免得读起来像是「统计局顺延了」；
 *   · pmi 用 noRoll —— 统计局每月最后一日公布 PMI，遇周末照发，不该按交易日推。
 */
export const PUB_CAL_RULES = [
  { key: "rrr", name: "缴准", day: 15, tone: "info",
    note: "市场惯例按每月 15 日；平均法考核下具体以央行口径为准" },
  { key: "tax", name: "税期截止", day: 15, tone: "warn",
    note: "每月 15 日申报截止（遇节假日顺延），走款高峰就在截止前后" },
  { key: "lpr", name: "LPR 报价", day: 20, tone: "info",
    note: "每月 20 日 09:15 公布，遇非工作日顺延" },
  { key: "mlf", name: "MLF 操作", day: 25, tone: "info",
    note: "每月 25 日操作（2024 年 7 月起由 15 日改到 25 日），遇非工作日顺延" },
  { key: "cpi", name: "CPI/PPI 公布", day: 9, tone: "info", soft: true,
    note: "统计局惯例每月 9 日前后 09:30 公布上月数，遇周末常提前或推后一天，以官方发布日程为准" },
  { key: "pmi", name: "PMI 公布", day: 31, tone: "info", soft: true, noRoll: true,
    note: "统计局每月最后一日 09:30 公布当月 PMI，遇周末照发不顺延" },
];

/** 顺延到下一个交易日；本来就在交易日就原样返回。
    noRoll=true 时原样返回（PMI 那类「遇周末照发」的日子）。 */
/** @param {string} date @param {boolean} [noRoll] @returns {{ date: string, shifted: boolean, from: string }} */
function rollForward(date, noRoll) {
  if (noRoll) return { date, shifted: false, from: date };
  if (isTradeDay(date)) return { date, shifted: false, from: date };
  const nx = nextTradeDay(date);
  return { date: nx || date, shifted: true, from: date };
}

/**
 * 某个月的第 day 号（顺延后）。monthOffset = 0 本月 / 1 下月。
 * @param {string} today
 * @param {number} day
 * @param {number} monthOffset
 */
function monthDay(today, day, monthOffset) {
  const d = parse(today);
  if (!d) return "";
  const y = d.getFullYear(), m = d.getMonth() + monthOffset;
  /* Date 会自动跨年进位；用 0 号取上月末天数来夹住 31 号这种越界 */
  const lastDay = new Date(y, m + 1, 0).getDate();
  const dd = Math.min(day, lastDay);
  return fmt(new Date(y, m, dd));
}

/** 某个月的月末交易日：季末看的是「跨季那一天」，所以取当月末最后一个交易日。 */
/** @param {string} today @param {number} monthOffset */
function monthEnd(today, monthOffset) {
  const d = parse(today);
  if (!d) return "";
  const y = d.getFullYear(), m = d.getMonth() + monthOffset;
  const lastDay = new Date(y, m + 1, 0);
  const s = fmt(lastDay);
  if (isTradeDay(s)) return s;
  return prevTradeDay(s) || s;
}

/**
 * 未来一段时间的公开日历。
 * @param {string} today YYYY-MM-DD
 * @param {{ days?: number, limit?: number }} [opts] days 默认 30 天，limit 默认 4 条
 * @returns {Array<{key:string,name:string,date:string,wd:string,daysAway:number,tone:string,
 *   note:string,shifted:boolean,ruleDate:string}>}
 */
export function pubCalNext(today, opts) {
  const o = opts || {};
  const days = Number(o.days) > 0 ? Number(o.days) : 30;
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 4;
  /* @type {any[]} */
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))) return out;
  for (const r of PUB_CAL_RULES) {
    /* 本月这个日子若已过（按顺延后的日期判），就取下月 —— 用「今天」比，
       不用「今天是不是交易日」比：周日打开时，周一的缴准仍然是「还有 1 天」。 */
    let base = monthDay(today, r.day, 0);
    let rolled = rollForward(base, !!r.noRoll);
    if (rolled.date < today) {
      base = monthDay(today, r.day, 1);
      rolled = rollForward(base, !!r.noRoll);
    }
    const away = daysBetween(today, rolled.date);
    if (away < 0 || away > days) continue;
    out.push({
      key: r.key, name: r.name, date: rolled.date, wd: wdOf(rolled.date),
      daysAway: away, tone: r.tone, note: r.note,
      shifted: rolled.shifted, ruleDate: base, soft: !!r.soft,
    });
  }
  /* 月末 / 季末：单独算，因为它的「日子」不是固定几号。季末比月末更值得提醒。 */
  for (const off of [0, 1]) {
    const me = monthEnd(today, off);
    if (!me) continue;
    const away = daysBetween(today, me);
    if (away < 0 || away > days) continue;
    const mo = Number(me.slice(5, 7));
    const quarter = mo === 3 || mo === 6 || mo === 9 || mo === 12;
    out.push({
      key: quarter ? "quarter" : "monthend",
      name: quarter ? "季末" : "月末",
      date: me, wd: wdOf(me), daysAway: away,
      tone: quarter ? "warn" : "info",
      note: quarter ? "跨季时点，资金面通常偏紧" : "跨月时点，隔夜与 7 天通常有波动",
      shifted: false, ruleDate: me,
    });
  }
  /* 同一天有多件事时按 key 排序，保证输出稳定（测试要断言顺序）。 */
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
  return out.slice(0, limit);
}

/**
 * 拼成请求里的那一段。约 120 字 —— 只给日子，不给「流动性会紧多少」这种没有依据的判断。
 * @param {Array<any>} list pubCalNext 的产出
 * @param {string} today
 */
export function pubCalText(list, today) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return "";
  const lines = arr.map(e => {
    /* soft 的几条（CPI/PPI、PMI）日期是我们按惯例推的，不是官方顺延 ——
       写「（11-09 顺延）」会被读成「统计局顺延了」，所以这两条不写。 */
    const shift = !e.soft && e.shifted && e.ruleDate !== e.date
      ? "（" + e.ruleDate.slice(5) + " 顺延）" : "";
    return "- " + e.date.slice(5) + "（" + e.wd + "）" + e.name + shift
      + "，距今 " + e.daysAway + " 天" + (e.tone === "warn" ? "，通常偏紧" : "");
  });
  return "【日历】" + today.slice(5) + " 起 " + arr.length + " 个日子（资金面按交易日顺延；宏观公布为惯例日，非官方日程原文）：\n" + lines.join("\n");
}

/**
 * 卡片上的胶囊行。与「时间坐标」同一视觉层级：都是日期，都不参与结论。
 * @param {Array<any>} list
 */
export function pubCalChips(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return "";
  return arr.map(e => `<span class="rp-pc${e.tone === "warn" ? " warn" : ""}">`
    + `<b>${e.date.slice(5)}</b>${e.name}`
    + `<i>${e.daysAway === 0 ? "今天" : e.daysAway + " 天"}</i></span>`).join("");
}
