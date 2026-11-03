// @ts-check
/* ---------- 持仓体检（T2）----------
   从 app.js 拆出来的纯函数：拆出来才能被 node --test 直接测到（同 disc.js / board.js 的做法）。

   这一层只有四件事：
     1. runChecks()  —— 把「这只产品现在的状态对不对」拆成一组**可判定**的检查项；
     2. anaFingerprint() —— 算结果指纹，让页面能说清「这条结论还是不是新的」；
     3. normAnaCache() —— 本机缓存的认账本，脏了就不认；
     4. anaRowParts() / anaEntryTarget() / anaEntryStatus() —— 页面要印的字，
        措辞规则也放这一层，才能在 node --test 里逐条钉住。

   ★ 三条口径（改任何一条都要同步改 tests/analysis.test.mjs）：
     1. **不重算任何算钱的口径。** 份额、成本、市值、净值、持有天数、费率档位、
        交易日滞后、月内挂零 —— 全部来自 position.js / nav.js / calendar.js /
        disc.js / board.js 的既有函数。这里再写一遍就是第二份实现，
        两处不一致时用户看到的体检结论无从追溯。
     2. **检查文本里不出现金额。** 体检结果会进本机缓存，而「隐藏金额」随时可能被
        打开：把数字写进文本再缓存，等于绕过了遮罩。金额一律留在页面上用 shown()
        现算现显，体检文本只写日期 / 天数 / 档位 / 百分比。
     3. **缺输入只说「信息不足（缺 X）」，不猜、不填默认值。** 与 disc.js 第一条
        口径同义：null 是不知道，0 是知道且为零。
*/

import { dayDiff } from "../core/util.js";
import { navSeries } from "./nav.js";
import { computePosition } from "./position.js";
import { navLagTradingDays } from "./calendar.js";
import { monthZeroDays } from "./board.js";
import { normDisc, discGaps, discHasContent, feeRateFor, DISC_TIER_LABEL, DISC_GAP_LABEL } from "../core/disc.js";

/* 判定档位。na = 信息不足（缺字段），skip = 这一项对该产品不适用 —— 两者都不能算「通过」，
   也不能算「有问题」：把「没录」显示成绿色对勾是撒谎，显示成红色又是在骗用户去查没坏的东西。 */
export const ANA_LEVELS = ["ok", "warn", "bad", "na", "skip"];
export const ANA_LEVEL_TEXT = { ok: "正常", warn: "要注意", bad: "有问题", na: "信息不足", skip: "不适用" };
/* 检查项标题。前 9 项是单只产品的，conc/cover 是组合层的（页尾那一行）。
   测试按这张表数条数：漏一项或多加一项都会跑红。 */
export const ANA_CHECK_TITLES = {
  nav: "净值披露", navGap: "净值连续性", value: "成本与净值匹配", lock: "最短持有 / 封闭期",
  fee: "赎回费档位", source: "披露出处", pending: "在途与确认", annual: "年化可比性",
  zero: "万份收益挂零",
  conc: "组合集中度", cover: "组合覆盖",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAV_STALE_LAG = 2;   /* 与 navIsStale 的默认档一致：该披露却没披露 */
const NAV_GAP_DAYS = 40;   /* 披露空档超过这个天数才提示（按月披露的产品 31 天属正常） */
const COST_RATIO = 3;      /* 最新净值 / 单位成本 偏离 3 倍以上视为录入可疑 */

/** @param {string} level */
function isLevel(level) { return ANA_LEVELS.indexOf(level) >= 0; }

/**
 * 一条检查结论。level 只认 ANA_LEVELS 里的五个值，档位外的输入一律降级成 na ——
 * 缓存里读回来的脏条目也走同一条路，界面永远不会拿到一个不认识的状态。
 * @param {string} key @param {string} level @param {string} text
 * @returns {{ key: string, title: string, level: string, text: string }}
 */
function ck(key, level, text) {
  const known = !!ANA_CHECK_TITLES[key];
  return { key, title: known ? ANA_CHECK_TITLES[key] : key, level: isLevel(level) ? level : "na", text: String(text || "") };
}

/** 万份收益序列是否真的有值：现算（与 app.js 的 lastNum 同语义，不跨层去调它）。 */
function hasWan(wan) {
  return Array.isArray(wan) && wan.some(v => v !== null && v !== undefined && isFinite(v));
}

/**
 * 单只产品的体检。
 * @param {{ p: any, trades: readonly any[], td: string, pos?: any, st?: { dates?: string[], wan?: (number|null)[] } }} a
 * @returns {{ key: string, title: string, level: string, text: string }[]}
 */
export function runChecks(a) {
  const args = a && typeof a === "object" ? a : {};
  const p = args.p && typeof args.p === "object" ? args.p : {};
  const trades = Array.isArray(args.trades) ? args.trades : [];
  const td = DATE_RE.test(String(args.td || "")) ? String(args.td) : "";
  if (!p.id || !td) return [ck("nav", "na", "信息不足（缺产品标识或日期）：体检需要「哪只产品」和「今天哪天」才能判定")];

  const pos = args.pos && typeof args.pos === "object" ? args.pos : computePosition(p, trades, td);
  const s = navSeries(p);
  const last = s.length ? s[s.length - 1] : null;
  const holdDays = Number(pos.holdDays) || 0;
  const disc = normDisc(p.disc);
  const gaps = discGaps(p.disc);
  const out = [];

  /* 1 净值披露：口径复用 nav.js + calendar.js 的交易日滞后 */
  if (!s.length) {
    out.push(ck("nav", "bad", "还没有任何净值记录，收益与回撤类判定全部做不了"));
  } else {
    const lag = navLagTradingDays(String(last[0]), td);
    if (lag >= NAV_STALE_LAG) out.push(ck("nav", "warn", `最新净值停在 ${last[0]}，已落后 ${lag} 个交易日（要么披露没出，要么抓取没跟上）`));
    else out.push(ck("nav", "ok", `最新净值日期 ${last[0]}，落后 ${lag} 个交易日`));
  }

  /* 2 净值连续性：最长一段披露空档 */
  if (s.length < 2) {
    out.push(ck("navGap", "na", "信息不足（净值点不足 2 个）：连续性没法判"));
  } else {
    let mx = 0, from = "", to = "";
    for (let i = 1; i < s.length; i++) {
      const d = dayDiff(String(s[i - 1][0]), String(s[i][0]));
      if (d > mx) { mx = d; from = String(s[i - 1][0]); to = String(s[i][0]); }
    }
    if (mx > NAV_GAP_DAYS) out.push(ck("navGap", "warn", `最长一段披露空档 ${mx} 天（${from} → ${to}）。按月披露的产品这是正常节奏，否则就是漏抓`));
    else out.push(ck("navGap", "ok", `最长一段披露空档 ${mx} 天`));
  }

  /* 3 成本与净值是否匹配：比值由 position 给的 cost/shares 与 lastNav 现算 */
  const badNav = s.filter(x => !(Number(x[1]) > 0)).length;
  if (badNav) {
    out.push(ck("value", "bad", `有 ${badNav} 条净值 ≤ 0 或不是数字，这类记录会让比值全部失真`));
  } else if (pos.inTransit) {
    out.push(ck("value", "skip", "这只产品的买入还没确认，市值与成本都不成立，比值不适用"));
  } else if (!(pos.shares > 0)) {
    out.push(ck("value", "skip", "没有已确认份额，成本与净值的匹配关系不适用"));
  } else {
    const unit = pos.cost / pos.shares;
    const r = unit > 0 ? Number(pos.lastNav) / unit : 0;
    if (!(r > 0)) out.push(ck("value", "na", "信息不足（单位成本或最新净值为 0）：比值算不出来，先核对买入与净值记录"));
    else if (r >= COST_RATIO || r <= 1 / COST_RATIO) out.push(ck("value", "warn", `最新净值与单位成本相差 ${COST_RATIO} 倍以上，请复核买入份额 / 确认净值有没有录错`));
    else out.push(ck("value", "ok", `最新净值相对单位成本 ${r >= 1 ? "+" : ""}${((r - 1) * 100).toFixed(1)}%`));
  }

  /* 4 最短持有 / 封闭期：字段没录就是 na，绝不按 0 天放行 */
  if (disc.lockDays === null) out.push(ck("lock", "na", `信息不足（缺${DISC_GAP_LABEL.lockDays}）：判不了现在能不能赎`));
  else if (disc.lockDays === 0) out.push(ck("lock", "ok", "披露为无持有期限制"));
  else if (!(pos.shares > 0)) out.push(ck("lock", "skip", "没有已确认持仓，持有期还剩多少不适用"));
  else if (holdDays < disc.lockDays) out.push(ck("lock", "warn", `仍在最短持有期内：已持有 ${holdDays} 天，要求 ${disc.lockDays} 天，还差 ${disc.lockDays - holdDays} 天`));
  else out.push(ck("lock", "ok", `已持有 ${holdDays} 天，满 ${disc.lockDays} 天要求`));

  /* 5 赎回费档位：feeRateFor 返回 null 是「不知道」，与 0% 是两回事 */
  if (!disc.feeRedeem.length) out.push(ck("fee", "na", `信息不足（缺${DISC_GAP_LABEL.feeRedeem}）：赎回要扣多少算不了`));
  else if (!(pos.shares > 0)) out.push(ck("fee", "skip", "没有已确认持仓，赎回费落在哪一档不适用"));
  else {
    const rate = feeRateFor(disc, holdDays);
    if (rate === null) out.push(ck("fee", "warn", `持有 ${holdDays} 天不落任何已录档位 —— 分档区间里有空洞，请照披露原文补齐`));
    else if (rate > 0) out.push(ck("fee", "ok", `持有 ${holdDays} 天落在 ${rate}% 这一档，赎回会扣这个费率`));
    else out.push(ck("fee", "ok", `持有 ${holdDays} 天落在 0% 档`));
  }

  /* 6 披露出处（铁律 3）：有内容没出处是脏数据指示器，说成「未录入」是撒谎 */
  const hasContent = discHasContent(disc);
  const miss = gaps.filter(g => g !== "source").map(g => DISC_GAP_LABEL[g] || g);
  if (!hasContent) {
    out.push(ck("source", "na", "信息不足（底层配置与出处一条都没录）：上面几项的「未披露」都源于此"));
  } else if (!disc.source) {
    out.push(ck("source", "warn", "有录入内容却查不到出处链接" + (miss.length ? `，另外还缺 ${miss.join("、")}` : "")));
  } else if (miss.length) {
    out.push(ck("source", "na", `信息不足（缺 ${miss.join("、")}）：出处已录（${DISC_TIER_LABEL[disc.source.tier] || disc.source.tier}）`));
  } else {
    out.push(ck("source", "ok", `六项披露内容齐全，出处为 ${DISC_TIER_LABEL[disc.source.tier] || disc.source.tier}${disc.source.publishedAt ? " · 披露 " + disc.source.publishedAt : ""}`));
  }

  /* 7 在途与确认日 */
  const buys = trades.filter(t => t && t.prodId === p.id && t.type === "buy");
  const noCd = buys.filter(t => !t.confirmDate).length;
  if (pos.pendingShares > 0) out.push(ck("pending", "warn", `有确认日晚于 ${td} 的买入还在途：市值、收益、份额都不含它`));
  else if (noCd) out.push(ck("pending", "warn", `有 ${noCd} 笔买入没填确认日，按买入日就当已确认，份额可能提前计入`));
  else if (!buys.length) out.push(ck("pending", "na", "信息不足（还没有买入记录）"));
  else out.push(ck("pending", "ok", `已录 ${buys.length} 笔买入，确认日齐全且都已确认`));

  /* 8 年化可比性：口径来自 position（不足 7 天 annualValid=false，那里已把年化置 0） */
  if (pos.inTransit) out.push(ck("annual", "skip", "在途未确认，没有持仓年化可判"));
  else if (!(pos.shares > 0)) out.push(ck("annual", "skip", "没有已确认持仓，年化不适用"));
  else if (!pos.annualValid) out.push(ck("annual", "na", `信息不足（持有 ${holdDays} 天不足 7 天）：样本太短，折算年化只会放大短期波动`));
  else out.push(ck("annual", "ok", `按 ${holdDays} 天持有折算年化，样本长度够`));

  /* 9 万份收益挂零：序列由调用方（app.js 的 navStats）传进来，这里只调 monthZeroDays */
  const st = args.st && typeof args.st === "object" ? args.st : null;
  if (!st || !Array.isArray(st.dates) || !Array.isArray(st.wan)) {
    out.push(ck("zero", "na", "信息不足（没有万份收益序列）：需要调用方把净值统计结果传进来"));
  } else if (!hasWan(st.wan)) {
    out.push(ck("zero", "skip", "没有万份收益序列（净值的折算口径不适用），挂零检查跳过"));
  } else {
    const z = monthZeroDays(st.dates, st.wan, td.slice(0, 7));
    out.push(ck("zero", z ? "warn" : "ok", z ? `本月已披露的万份收益里有 ${z} 天为 0，先核对披露与抓取` : "本月已披露的万份收益没有挂零"));
  }

  return out;
}

/**
 * 组合层体检。市值由调用方传进来（app.js 已用 position() 算好并缓存过），
 * 这里不再算钱，只做占比与覆盖度 —— 占比是比值，按第 2 条口径可以进文本。
 * @param {{ id?: string, name?: string, market?: number }[]} rows 已确认持仓的产品行
 * @param {number} allCount 在册产品总数（含在途与已清仓）
 */
export function portfolioChecks(rows, allCount) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === "object");
  const total = list.reduce((s, r) => s + (Number(r.market) || 0), 0);
  const out = [];
  if (!list.length || !(total > 0)) {
    out.push(ck("conc", "na", "信息不足（没有已确认持仓，或市值合计为 0）：集中度没法算"));
  } else {
    let top = list[0];
    for (const r of list) if ((Number(r.market) || 0) > (Number(top.market) || 0)) top = r;
    const share = (Number(top.market) || 0) / total;
    const name = String(top.name || top.id || "");
    out.push(share > 0.5
      ? ck("conc", "warn", `最重的一只占组合 ${(share * 100).toFixed(1)}%（${name}），其余持仓分不到一半`)
      : ck("conc", "ok", `最重的一只占组合 ${(share * 100).toFixed(1)}%，没有单只过半`));
  }
  const all = Number(allCount) || 0;
  if (!all) out.push(ck("cover", "na", "信息不足（还没有录入产品）"));
  else if (list.length === all) out.push(ck("cover", "ok", `${all} 只在册产品全部有已确认持仓`));
  else out.push(ck("cover", "skip", `${all} 只在册产品里有 ${all - list.length} 只没有已确认持仓（在途或已清仓），组合口径不含它们`));
  return out;
}

/* ============================================================
   结果指纹
   ============================================================ */
/** 决定体检结论的输入 → 规范串。只取会影响判定的字段，
    「隐藏金额」这类显示态一律不进指纹（否则每次切遮罩都会让缓存作废）。 */
export function anaFpSource(a) {
  const args = a && typeof a === "object" ? a : {};
  const p = args.p && typeof args.p === "object" ? args.p : {};
  const trades = Array.isArray(args.trades) ? args.trades : [];
  const td = DATE_RE.test(String(args.td || "")) ? String(args.td) : "";
  const s = navSeries(p);
  const nav = "n" + s.length + "|" + (s.length ? String(s[0][0]) : "") + "|" +
    s.slice(-8).map(x => `${x[0]}:${Number(x[1]).toFixed(4)}`).join(",");
  const d = normDisc(p.disc);
  const disc = ["lock=" + (d.lockDays === null ? "" : d.lockDays),
    "open=" + d.openRule, "scope=" + d.investScope,
    "fee=" + d.feeRedeem.map(f => `${f.from}-${f.to === null ? "" : f.to}@${f.ratePct}`).join(","),
    "assets=" + d.assets.map(x => `${x.name}@${x.pct === null ? "" : x.pct}`).join(","),
    "src=" + (d.source ? `${d.source.tier}|${d.source.url}|${d.source.publishedAt}` : ""),
    "status=" + d.status].join(";");
  const tr = trades.filter(t => t && String(t.prodId) === String(p.id))
    .slice()
    .sort((x, y) => String(x.id || "").localeCompare(String(y.id || "")))
    .map(t => [t.type, t.tradeDate || "", t.confirmDate || "", t.confirmNavDate || "",
      t.amount === undefined ? "" : t.amount, t.shares === undefined ? "" : t.shares,
      t.confirmNav === undefined ? "" : t.confirmNav].join("|"))
    .join(";");
  return `id=${p.id || ""}|td=${td}|nav=${nav}|disc=${disc}|trades=${tr}`;
}

/**
 * FNV-1a 32 位。指纹只用来判「输入有没有变」，不当标识符用，
 * 串与串之间撞一次就是多算一次体检，没有资损风险。
 * @param {string} str
 */
export function fnv1a(str) {
  let h = 0x811c9dc5 >>> 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** @param {{ p?: any, trades?: readonly any[], td?: string }} a @returns {string} 8 位小写十六进制 */
export function anaFingerprint(a) {
  return fnv1a(anaFpSource(a)).toString(16).padStart(8, "0");
}

/* ============================================================
   本机缓存的认账本
   ============================================================ */
export const ANA_CACHE_V = 1;
export const ANA_CACHE_MAX = 40;

/** 一条检查结论的认账本：形状不对、档位不认识、文本超长 —— 整条丢掉，绝不修补后放行。 */
function normCheck(c) {
  if (!c || typeof c !== "object") return null;
  const key = String(c.key || "");
  if (!key || key.length > 24) return null;
  if (!isLevel(c.level)) return null;
  const text = String(c.text || "");
  if (!text || text.length > 400) return null;
  const title = String(c.title || "");
  if (!title || title.length > 24) return null;
  return { key, title, level: c.level, text };
}

/**
 * 任意来源（老版本写的 / 别的设备推的 / 手改过的 localStorage）→ 规范对象。
 * 版本不符或整体不是对象 → 空账本；单条坏 → 只丢那一条。
 * 超过上限按 at 从新到旧截断，排序显式做，不依赖引擎的键序。
 * @param {any} raw @param {number} [max]
 */
export function normAnaCache(raw, max = ANA_CACHE_MAX) {
  const src = raw && typeof raw === "object" && raw.v === ANA_CACHE_V && raw.byId && typeof raw.byId === "object"
    ? raw.byId : null;
  const keep = {};
  if (src) {
    for (const k of Object.keys(src)) {
      const id = String(k);
      if (!id || id.length > 64) continue;
      const e = src[k];
      if (!e || typeof e !== "object") continue;
      if (!/^[0-9a-f]{8}$/.test(String(e.fp))) continue;
      const at = Number(e.at);
      if (!isFinite(at) || at < 0) continue;
      if (!Array.isArray(e.checks)) continue;
      const checks = e.checks.map(normCheck);
      if (checks.some(x => !x)) continue;
      if (!checks.length) continue;
      keep[id] = { fp: String(e.fp), at, checks };
    }
  }
  const cap = isFinite(max) && max > 0 ? Math.floor(max) : ANA_CACHE_MAX;
  const ids = Object.keys(keep).sort((a, b) => keep[b].at - keep[a].at || a.localeCompare(b));
  const byId = {};
  for (const id of ids.slice(0, cap)) byId[id] = keep[id];
  return { v: ANA_CACHE_V, byId };
}

/**
 * 渲染拆分：档位词 + 正文。
 * na 的正文按第 3 条口径必须自带「信息不足」四个字（缓存里单独取出那一条也得是完整的话），
 * 页面再印一遍档位词就成了「信息不足 信息不足（缺…）」的结巴 —— 重复在这里消掉，
 * 而不是把文本改成不完整的话。
 * @param {{ level?: string, text?: string }} c
 * @returns {{ level: string, body: string }}
 */
export function anaRowParts(c) {
  const lv = ANA_LEVEL_TEXT[(c && c.level) || ""] || String((c && c.level) || "");
  const text = String((c && c.text) || "");
  return { level: lv, body: text.indexOf(lv) === 0 ? text.slice(lv.length) : text };
}

/**
 * 缓存项 → 页面状态。三态在这里判，app.js 只负责显。
 * @param {{ fp: string, at: number, checks: object[] } | undefined | null} entry
 * @param {string} fp 当前输入算出来的指纹
 * @returns {{ state: "none" | "fresh" | "stale", checks: object[], at: number }}
 */
export function anaCacheState(entry, fp) {
  if (!entry || typeof entry !== "object") return { state: "none", checks: [], at: 0 };
  if (entry.fp === fp) return { state: "fresh", checks: entry.checks, at: entry.at };
  return { state: "stale", checks: entry.checks, at: entry.at };
}

/**
 * 组合级入口（台账页 / 交易中心那两行）该去哪儿。
 * 体检是「一只一只」判的，所以入口必须先确定「哪只」：
 *   none  —— 一只产品都没有：明说，不弹一个空壳让用户以为坏了；
 *   direct —— 只有一只：直接进它的体检页，不逼用户多点一下；
 *   pick  —— 多只：进选择页。
 * 判据只看产品数，不看持仓：没有已确认持仓照样能体检（结论会是「不适用」那一类），
 * 用持仓决定让不让进就是把「还没录」说成「不能查」。
 * @param {Array<{ id?: string | number }>|null|undefined} products
 * @returns {{ kind: "none" | "direct" | "pick", list: object[], id?: string|number }}
 */
export function anaEntryTarget(products) {
  const list = (Array.isArray(products) ? products : []).filter(p => p && (p.id || p.id === 0));
  if (!list.length) return { kind: "none", list };
  if (list.length === 1) return { kind: "direct", list, id: list[0].id };
  return { kind: "pick", list };
}

/**
 * 选择页每只产品后面那行小字：持仓状态 + 上次体检状态。
 * 两个入参都是别的模块算好的结果，这里只做措辞 —— 不重算持仓（第 1 条口径），
 * 也不写金额（第 2 条口径）：这行字会跟着缓存走，而「隐藏金额」是显示态。
 * @param {{ shares?: number, hasPending?: boolean, inTransit?: boolean }} pos computePosition 的结果
 * @param {{ state: string }} st anaCacheState 的结果
 * @returns {string}
 */
export function anaEntryStatus(pos, st) {
  const p = pos || {};
  const hold = (p.shares || 0) > 0 ? "已确认持仓"
    : p.inTransit ? "在途未确认"
      : p.hasPending ? "有在途买入"
        : "无已确认持仓";
  /* fresh 一定是「今天」：指纹里含 td，跨了天指纹就变，只能判成 stale。 */
  const seen = st && st.state === "fresh" ? "今天查过"
    : st && st.state === "stale" ? "结论已过期"
      : "还没查过";
  return `${hold} · ${seen}`;
}
