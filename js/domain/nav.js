// @ts-check
/* 净值序列的读取与「取某日净值」的统一口径。
   纯函数：不读全局 DATA，产品对象由调用方传入。 */

/**
 * @typedef {{ navHistory?: Record<string, number | string> } & Record<string, any>} NavProduct
 * @typedef {[string, number]} NavPoint
 */

/**
 * 产品按日期升序的净值序列。
 * @param {NavProduct} p
 * @returns {NavPoint[]}
 */
export function navSeries(p) {
  return Object.keys(p.navHistory || {}).sort().map(d => [d, Number(p.navHistory[d])]);
}

/**
 * 某日净值（原始值，可能 undefined）。
 * @param {NavProduct} p
 * @param {string} date
 */
export function navAt(p, date) { return p.navHistory ? p.navHistory[date] : undefined; }

/**
 * 取 <= date 的最近一个净值。
 * @param {NavProduct} p
 * @param {string} date
 * @returns {NavPoint | null}
 */
export function navOnOrBefore(p, date) {
  const s = navSeries(p);
  /** @type {NavPoint | null} */
  let r = null;
  for (const [d, v] of s) { if (d <= date) r = [d, v]; else break; }
  return r;
}

/**
 * 最新净值。
 * @param {NavProduct} p
 * @returns {NavPoint | null}
 */
export function latestNav(p) { const s = navSeries(p); return s.length ? s[s.length - 1] : null; }

/* 统一「当天命中 → 否则向前取最近」的取值：始终返回 [日期, 净值] 或 null。
   ⚠️ 不要写成 `navAt(p,d) || navOnOrBefore(p,d)`：navAt 命中时返回的是「数字」，
   navOnOrBefore 返回的是「数组」，|| 短路会让调用方拿到两种类型 ——
   命中路径下 hit[1] 取到 undefined，Number(undefined) = NaN，
   再被下游 `nav > 0` 之类的守卫静默退化成 0，表现为「净值栏被清空 / 份额算成 0」。 */
/**
 * @param {NavProduct} p
 * @param {string} date
 * @returns {NavPoint | null}
 */
export function navHit(p, date) {
  const v = navAt(p, date);
  if (v !== undefined && v !== null && v !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return [date, n];
  }
  return navOnOrBefore(p, date);
}

/* ============================================================
   v95 · 提醒工程的统一判断口径（app.js 的 notifyNewNav 只管投递，判断全在这里）
   ============================================================ */

/** 通知默认档（B3 复核后的唯一出处）：免打扰默认开、窗口 00:00–07:00；
    阈值开关默认关（开了才按日变动幅度过滤）。app.js 的 NOTIFY 初值从这里拷贝。 */
export const NOTIFY_DEFAULTS = { quietOn: true, quietStart: 0, quietEnd: 7, threshOn: false, thresh: 0.5 };

/** 去重键（B1）：产品id + 净值披露日。同一条净值只提醒一次，判重与拼键只在这里。 */
export function navNotifyKey(pid, date) { return String(pid || "") + "@" + date; }

/** 是否处于夜间免打扰窗口。支持跨零点（start > end，如 22–7）。
    @param {{quietOn?:boolean,quietStart?:number,quietEnd?:number}} n
    @param {Date} now
    */
export function inQuietWindow(n, now) {
  if (!n || !n.quietOn) return false;
  const h = now.getHours();
  const s = Number(n.quietStart), e = Number(n.quietEnd);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

/** 是否通过阈值过滤（B1）。阈值开关默认关 → 全放行；
    日变动算不出来（null 是不知道）→ 放行：压掉一条通知等于断言「变动不大」，不知道就不能断言。
    @param {number | null} pct 最新披露日环比（%），算不出为 null
    @param {{threshOn?:boolean,thresh?:number}} n
    */
export function passesThreshold(pct, n) {
  if (!n || !n.threshOn) return true;
  if (!Number.isFinite(pct)) return true;
  const t = Number(n.thresh);
  if (!Number.isFinite(t)) return true;
  return Math.abs(pct) >= t;
}

/** 比 latestDate 新的净值清单，逐条带环比（%）。
    @param {NavProduct[]} products
    @param {string} latestDate
    @returns {Array<{id:string,name:string,date:string,value:number,pct:number|null}>}
    */
export function newNavItems(products, latestDate) {
  const out = [];
  for (const p of (products || [])) {
    const s = navSeries(p);
    for (let i = 0; i < s.length; i++) {
      const [d, v] = s[i];
      if (d <= latestDate) continue;
      const pv = i > 0 ? s[i - 1][1] : Number.NaN;
      out.push({
        id: String(p.id || ""), name: String(p.name || p.code || p.id || ""),
        date: d, value: v,
        pct: Number.isFinite(pv) && pv !== 0 ? (v / pv - 1) * 100 : null,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** 单次提醒的总过滤（B1）：去重 + 阈值。返回要发的、要静默记 seen 的条数。
    @param {Array<{id:string,name:string,date:string,pct:number|null}>} items
    @param {Record<string, boolean>} seen 已提醒过的键集合
    @param {{threshOn?:boolean,thresh?:number}} notify
    */
export function filterNavNotify(items, seen, notify) {
  const send = [], below = [];
  for (const it of (items || [])) {
    const k = navNotifyKey(it.id, it.date);
    if (seen && seen[k]) continue;
    if (passesThreshold(it.pct, notify)) send.push(it); else below.push(it);
  }
  return { send, below };
}