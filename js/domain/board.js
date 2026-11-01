// @ts-check
/* 产品收益表（产品页那张可按机构筛选、可按列排序的表）的口径与排序。

   拆成纯函数的原因和 paste.js / sync.js 一样：app.js 里的渲染读 DOM、调 localStorage，
   node --test 进不去。表头的口径（万收、N 日年化、月挂 0 数）错了会让用户按错的方向
   挑产品，所以算法必须能被执行测试覆盖，app.js 只负责把结果拼成 HTML。

   口径与台账页共用同一套净值指标（app.js 的 navStats），这里只多做两件：
     · 月挂 0 数：本月「万份收益 = 0」的披露日天数（现金管理类不计息的日子）。
       只统计有披露的日子 —— 没披露不等于挂零，混在一起会把断更算成不计息。
     · 排序：无该指标的行永远排最后，且不随升/降序翻转（否则点一次排序就把
         一堆「—」顶到最前，看起来像排序坏了）。 */

/**
 * 列定义：key、完整表头文案、口径说明（表头 title 里给全，避免误读成年化还是涨幅）、
 * 两行短表头（v48：7 列在手机上放不宽，表头改成两行竖排才腾得出数字列的宽度）。
 * 短表头只负责「认得出是哪列」，完整口径一律留在 title 里。
 */
export const BOARD_COLS = [
  ["name", "产品名称", "点一次降序，再点翻转方向", "产品", "名称"],
  ["wan", "万收", "最新披露日的万份收益（元/万份）=（当日净值 − 前一日净值）× 10000 ÷ 间隔自然日数", "万份", "收益"],
  ["a7", "近7日年化", "(最新净值 ÷ 7 个自然日前最近一条披露净值 − 1) × 365 / 7", "7日", "年化"],
  ["a14", "近14日年化", "(最新净值 ÷ 14 个自然日前最近一条披露净值 − 1) × 365 / 14", "14日", "年化"],
  ["a30", "近30日年化", "(最新净值 ÷ 30 个自然日前最近一条披露净值 − 1) × 365 / 30", "30日", "年化"],
  ["zero", "月挂0数", "本月万份收益为 0 的披露日天数（只数有净值披露的日子）", "挂0", "天"],
];

/**
 * 「精简」模式保留的列（v48）。
 * 14 日 / 30 日年化与 7 日年化在挑产品时基本同向，砍掉它们换来的宽度正好让产品名
 * 不用截断到认不出来 —— 极窄屏（280 一档）与「就是想看大字」的用户都靠这一档。
 * 表里没有「全部」以外的列，所以这个清单必须是 BOARD_COLS key 的子集（有测试盯着）。
 */
export const BOARD_LEAN = ["name", "wan", "a7", "zero"];

/**
 * 某个列模式下的列集合。未知值一律按 lean —— 宁可少给两列，也不能让窄屏溢出。
 * @param {string} mode "full" | 其它
 */
export function boardCols(mode) {
  if (mode === "full") return BOARD_COLS.slice();
  return BOARD_COLS.filter(c => BOARD_LEAN.indexOf(c[0]) >= 0);
}

/** 机构为空的行在筛选里用的哨兵值：不能拿 "" 当 key，"" 已被「全部」占用 */
export const NO_INST = "__none__";

/**
 * 行的机构键（筛选 chips 与过滤都用它）。
 * @param {string} inst
 */
export function instKey(inst) {
  return String(inst || "").trim() || NO_INST;
}

/** 机构键的显示名 */
export function instLabel(key) {
  return key === NO_INST ? "未填机构" : key;
}

/**
 * 按机构 + 关键字过滤。q 匹配产品名 / 登记编码 / 产品代码 / 机构。
 * @param {any[]} rows @param {string} instKeyOrAll 空串 = 全部 @param {string} q
 */
export function boardFilter(rows, instKeyOrAll, q) {
  let out = rows;
  if (instKeyOrAll) out = out.filter(r => r.ikey === instKeyOrAll);
  const s = String(q || "").trim().toLowerCase();
  if (s) {
    out = out.filter(r => [r.name, r.code, r.prodCode, r.inst]
      .some(v => String(v == null ? "" : v).toLowerCase().indexOf(s) >= 0));
  }
  return out;
}

/**
 * 生成机构 chips（按行数降序，全部放第一个）。
 * @param {any[]} rows @returns {{key:string,label:string,n:number}[]}
 */
export function boardInstChips(rows) {
  /** @type {Record<string, number>} */
  const cnt = {};
  for (const r of rows) cnt[r.ikey] = (cnt[r.ikey] || 0) + 1;
  return Object.keys(cnt)
    .map(k => ({ key: k, label: instLabel(k), n: cnt[k] }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "zh-CN"));
}

/**
 * 万份收益「挂零」判定。浮点比较给容差：净值差乘 10000 之后不该指望它正好等于 0。
 * @param {number|null|undefined} v
 */
export function isZeroWan(v) {
  return v !== null && v !== undefined && isFinite(v) && Math.abs(v) < 1e-6;
}

/**
 * 本月万收挂零的披露日数。
 * @param {string[]} dates 与 wan 等长的披露日期（YYYY-MM-DD）
 * @param {(number|null)[]} wan 万份收益序列（首条无前值为 null）
 * @param {string} ym 目标月份，形如 "2026-10"
 */
export function monthZeroDays(dates, wan, ym) {
  if (!Array.isArray(dates) || !Array.isArray(wan) || !/^\d{4}-\d{2}$/.test(String(ym))) return 0;
  let n = 0;
  for (let i = 0; i < dates.length; i++) {
    if (String(dates[i]).slice(0, 7) !== ym) continue;
    if (isZeroWan(wan[i])) n++;
  }
  return n;
}

/**
 * 按列排序。无值（null / undefined / ""）永远排最后且不随方向翻转；
 * 同值时按产品名升序，保证多次点击与重复渲染的顺序稳定。
 * @param {any[]} rows @param {string} key @param {boolean} asc
 */
export function boardSort(rows, key, asc) {
  /** @param {any} v */
  const missing = (v) => v === null || v === undefined || v === "";
  return [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    const na = missing(va), nb = missing(vb);
    if (na && nb) return a.name.localeCompare(b.name, "zh-CN");
    if (na) return 1;
    if (nb) return -1;
    const d = (typeof va === "string" || typeof vb === "string")
      ? String(va).localeCompare(String(vb), "zh-CN")
      : (va - vb);
    return d === 0 ? a.name.localeCompare(b.name, "zh-CN") : (asc ? d : -d);
  });
}
