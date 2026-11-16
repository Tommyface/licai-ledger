// @ts-check
/* ---------- v136 · 走势专题（P0）：先体检口径，再做走势叙述 ----------
   从「模型 + 持仓 + 最新金融信息 → 未来走势」这个诉求里切出来的**纯函数层**。
   它不碰网络、不碰密钥、不碰台账写入，也不另建一条云端链路：事实块沿用
   reportFactsText()，模型调用沿用 App 里的 BRIEF 状态机与 NativeLlm 原生桥。

   ★ 为什么这一层存在（2026-11-15 用户给的「万份收益 0.23」核对案例）：
     银行 App 披露的官方万份收益、台账折算出来的万份收益、单位净值序列，
     是三套口径。口径错位的数据一旦直接喂给模型，越强的模型错得越系统 ——
     案例里 0.23 与净值跳变差近 20 倍，连外部专家都因此修正了两个推断。
     所以四件事按顺序做：口径体检 → 一致性检测 → 观察点/证伪线（代码算）
     → 专题事实块（数字全部登记审计白名单）。**先体检、后分析**。

   ★ 五条边界（改任何一条都要同步改 tests/trend_v136.test.mjs）：
     1. 只报「疑似错位 / 建议以单位净值为主口径」，不替管理人判定会计估值方法；
     2. 台账没有官方万份收益 / 7 日年化独立录入字段 —— 没有就说没有，
        绝不拿折算值冒充官方值，也绝不谎称「已交叉核对」；
     3. 观察阈值与证伪线一律由本机按披露点算，模型不许自己再算一个数；
     4. 不给概率、不给收益中枢、不给目标净值 / 止损止盈（沿用 BRIEF 的合规红线）；
     5. 全部留在 App 内：不新增云端任务、不新增 Actions 配额、不写第二份台账。
*/

import { esc } from "../core/util.js";
import { navSeries } from "./nav.js";
import { reportFactsText, reportScenarios } from "./report.js";

/** 提示词版本：改 TREND_INSTRUCTIONS / 输出契约 / 分段数，必须 +1（进指纹）。 */
export const TREND_PROMPT_VER = "trend-1";

/** 三档情景与观察阈值的定性声明。卡片、事实块、指令三处同源，不许各写一句。 */
export const TREND_NOT_PREDICTION =
  "并列情景、观察阈值与证伪线是按披露点由本机算出的观察口径，不是预测，也不构成收益承诺。";

/** 口径标签。key 也进事实块，模型照抄时能被数字审计回指。 */
export const TREND_CALIBER_LABEL = {
  nav: "净值型（台账单位净值）",
  wanfen: "疑似万份收益型（单位净值长期恒定）",
  "mixed-suspect": "疑似口径错位（需人工核对）",
  unknown: "数据不足，无法判定口径",
};

/** 错位检测的默认阈值：差额倍数 ≥ 5 判「疑似」。案例里 4.0/0.23≈17 倍，远超。 */
export const TREND_RATIO_LIMIT = 5;

/* ---------------- ① 口径体检 ---------------- */

/**
 * 把台账净值序列规范成 [[日期, 净值]]，与 reportNavFacts 同一套过滤口径
 * （日期合法、净值有限且 > 0、按日期升序）。不另写一份，避免两处口径分叉。
 * @param {any} p
 * @returns {Array<[string, number]>}
 */
function cleanSeries(p) {
  /** @type {Array<[string, number]>} */
  const out = [];
  for (const [d, v] of navSeries(p || {})) {
    const date = String(d), val = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isFinite(val) && val > 0) out.push([date, val]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * 口径体检：判定产品口径，产出「分析主口径」声明与降级标记。
 *
 * 依据**只有台账已有的 navHistory**。本期不新增「官方万份收益 / 7 日年化」录入字段
 * （第九节决策 3），所以没有官方值时 `checked=false`，绝不谎称做过交叉核对；
 * 若调用方显式传入 officialWan（单测夹具 / 未来扩展），才跑 trendConsistency。
 *
 * @param {any} p 台账产品对象
 * @param {{ officialWan?: number | Array<{date: string, wan: number}> | null,
 *   today?: string, ratioLimit?: number }} [opts]
 * @returns {any}
 */
export function trendCaliber(p, opts) {
  const o = opts || {};
  const pts = cleanSeries(p);
  const n = pts.length;
  /** @type {string[]} */
  const warnings = [];
  const base = {
    n, points: pts, checked: false, degrade: false,
    primary: "单位净值（台账 navHistory）",
    consistency: null,
  };
  if (n < 2) {
    return Object.assign({}, base, {
      key: "unknown", label: TREND_CALIBER_LABEL.unknown, degrade: true,
      flatRatio: 0, maxAbsBp: 0, jumpDate: "",
      warnings: ["净值序列不足 2 个披露点：不做口径判定，也不做走势推断；只陈述已录事实。"],
      note: "本机只有 " + n + " 个净值点，口径无法判定；分析一律以已录单位净值为准，不换算、不外推。",
    });
  }
  /** @type {number[]} */
  const bps = [];
  for (let i = 1; i < n; i++) bps.push((pts[i][1] / pts[i - 1][1] - 1) * 10000);
  const flat = bps.filter(v => Math.abs(v) < 0.01).length;
  const flatRatio = flat / bps.length;
  let maxAbsBp = 0, jumpDate = "";
  for (let i = 1; i < n; i++) {
    if (Math.abs(bps[i - 1]) > maxAbsBp) { maxAbsBp = Math.abs(bps[i - 1]); jumpDate = pts[i][0]; }
  }
  const absSorted = bps.map(Math.abs).sort((a, b) => a - b);
  const medAbs = absSorted.length ? absSorted[Math.floor(absSorted.length / 2)] : 0;

  /* 官方值只有显式传入才做交叉核对 —— 这是「不臆造数据」的执行点。 */
  let cons = null;
  if (o.officialWan != null) {
    cons = trendConsistency(pts, o.officialWan, { ratioLimit: o.ratioLimit });
    if (cons.level === "suspect") {
      warnings.push("官方万份收益与台账折算值疑似错位（" + cons.note + "）；本次以单位净值为唯一分析主口径，折算值不作弹性/年化依据。");
      return Object.assign({}, base, {
        key: "mixed-suspect", label: TREND_CALIBER_LABEL["mixed-suspect"],
        degrade: true, checked: true, consistency: cons,
        flatRatio, maxAbsBp, jumpDate, warnings,
        note: "疑似口径错位：分析主口径为台账单位净值；官方万份收益与折算值只作对照，不参与任何推算。最终以管理人披露为准。",
      });
    }
  }

  /* 净值长期恒定：典型的万份收益/份额分红型产品，单位净值不累计收益。
     拿这条序列算年化与弹性会得到一串漂亮的 0，那是口径错，不是产品稳。 */
  if (n >= 5 && flatRatio >= 0.95) {
    warnings.push("单位净值在 " + n + " 个披露点里基本不变（" + (flatRatio * 100).toFixed(0) + "% 的点无变动）：疑似收益以万份收益或份额形式发放。");
    warnings.push("这类产品的净值序列不适合做弹性与年化测算，本次已降级：只陈述已录事实，不做走势外推。");
    return Object.assign({}, base, {
      key: "wanfen", label: TREND_CALIBER_LABEL.wanfen,
      degrade: true, checked: cons != null, consistency: cons,
      flatRatio, maxAbsBp, jumpDate, warnings,
      note: "本机只有单位净值序列，没有官方万份收益/7 日年化录入；疑似万份收益型，本次降级为事实陈述，不做弹性与年化推算。",
    });
  }

  /* 异常跳变：可能是估值口径切换、补录或抓取错位。标注该点并降级，不删原始数据。 */
  const jumpBad = n >= 6 && maxAbsBp >= 200 && medAbs > 0 && maxAbsBp >= 5 * medAbs;
  if (jumpBad) {
    warnings.push(jumpDate + " 出现 " + maxAbsBp.toFixed(1) + "bp 的单日跳变（常态中位 " + medAbs.toFixed(1)
      + "bp）：疑似估值口径切换或补录，该点不作为弹性/年化依据。");
    return Object.assign({}, base, {
      key: "mixed-suspect", label: TREND_CALIBER_LABEL["mixed-suspect"],
      degrade: true, checked: cons != null, consistency: cons,
      flatRatio, maxAbsBp, jumpDate, warnings,
      note: "序列存在异常跳变，疑似口径错位；分析主口径仍为台账单位净值，跳变点只标注、不删除、不参与推算。最终以管理人披露为准。",
    });
  }

  return Object.assign({}, base, {
    key: "nav", label: TREND_CALIBER_LABEL.nav,
    checked: cons != null, consistency: cons,
    flatRatio, maxAbsBp, jumpDate,
    warnings: cons && cons.level === "ok"
      ? ["官方万份收益与台账折算值同量级，未发现明显错位；仍以单位净值为分析主口径。"]
      : ["本机没有官方万份收益 / 7 日年化独立录入，只做了净值序列自身的启发式体检，未与官方值交叉核对。"],
    note: "判定为净值型；分析主口径为台账单位净值。万份收益在本工具里是折算值，不是官方披露值，不单独作依据。",
  });
}

/* ---------------- ② 一致性检测（三重交叉验证） ---------------- */

/**
 * 净值折算万收 vs 官方万收的一致性检测。
 *
 * 三条判据对应用户案例的三重交叉验证：
 *   ① 单日差额倍数（0.23 与 +4.0 差近 20 倍）；
 *   ② 区间累计差额（累计 +1 vs +7）；
 *   ③ 7 日年化自洽性（由官方万收推的年化 vs 由净值序列推的区间涨幅）。
 *
 * 只报「疑似错位」，倍数一律**算出来**，不替管理人下结论；主口径永远回到单位净值。
 *
 * @param {Array<[string, number]>} series
 * @param {number | Array<{date: string, wan: number}> | null} officialWan
 * @param {{ ratioLimit?: number }} [opts]
 * @returns {any}
 */
export function trendConsistency(series, officialWan, opts) {
  const o = opts || {};
  const lim = Number(o.ratioLimit) > 0 ? Number(o.ratioLimit) : TREND_RATIO_LIMIT;
  /** @type {Array<[string, number]>} */
  const pts = (Array.isArray(series) ? series : [])
    .filter(p => Array.isArray(p) && /^\d{4}-\d{2}-\d{2}$/.test(String(p[0]))
      && isFinite(Number(p[1])) && Number(p[1]) > 0)
    .map(p => /** @type {[string, number]} */ ([String(p[0]), Number(p[1])]))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const empty = {
    ok: false, level: "unknown", primary: "单位净值（台账 navHistory）",
    dayRatio: null, cumRatio: null, annualRatio: null, ratios: [],
    note: "本机没有官方万份收益录入，无法交叉核对；不据此判定错位。", warnings: [],
  };
  if (officialWan == null || pts.length < 2) return empty;

  /* 台账折算口径：万份收益 = (今 − 上一披露日) × 10000，整段累计、不按自然日摊平
     （与 app.js 的展示口径一致；这里只做对照，不作为分析依据）。 */
  /** @type {Array<{date: string, folded: number}>} */
  const folded = [];
  for (let i = 1; i < pts.length; i++) {
    folded.push({ date: pts[i][0], folded: (pts[i][1] - pts[i - 1][1]) * 10000 });
  }

  /** @type {Array<{date: string, wan: number}>} */
  let offs = [];
  if (typeof officialWan === "number" && isFinite(officialWan)) {
    offs = [{ date: folded[folded.length - 1].date, wan: officialWan }];
  } else if (Array.isArray(officialWan)) {
    offs = officialWan
      .filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && isFinite(Number(x.wan)))
      .map(x => ({ date: String(x.date), wan: Number(x.wan) }));
  }
  if (!offs.length) return empty;

  const byDate = new Map(folded.map(x => [x.date, x.folded]));
  const pairs = offs.filter(x => byDate.has(x.date)).map(x => ({ date: x.date, folded: byDate.get(x.date), wan: x.wan }));
  if (!pairs.length) {
    return Object.assign({}, empty, { note: "官方万份收益的日期与台账披露点对不上，无法交叉核对；不据此判定错位。" });
  }

  /**
   * 倍数统一取 max(r, 1/r)：0.23 对 4.0 与 4.0 对 0.23 是同一个「差多少倍」。
   * eps 是分母下限：万收数值（0.23 / 4.0）用 0.01 合适；收益率小数（0.00036）
   * 若也钳到 0.01，会把 2.6 倍硬扭成 27.8 倍 —— 那是假告警，年化自洽判据必须另给 eps。
   * 钳到 999 倍：一端为 0 时 1/r 会冲到 1e9，写进事实块既不好读也没意义。
   */
  const foldRatio = (a, b, eps) => {
    const floor = eps == null ? 0.01 : Number(eps);
    const x = Math.abs(Number(a)), y = Math.max(Math.abs(Number(b)), floor);
    const r = x / y;
    return Math.min(999, Math.max(r, 1 / Math.max(r, 1e-9)));
  };
  /* ① 单日：取对齐点里最大的差额倍数（有一处错位就够可疑）。 */
  let dayRatio = 0;
  for (const p of pairs) dayRatio = Math.max(dayRatio, foldRatio(p.folded, p.wan));
  /* ② 区间累计：同一批对齐点上的折算累计 vs 官方累计。 */
  const sumFolded = pairs.reduce((s, p) => s + Number(p.folded), 0);
  const sumOfficial = pairs.reduce((s, p) => s + p.wan, 0);
  const cumRatio = foldRatio(sumFolded, sumOfficial);
  /* ③ 7 日年化自洽：只有当官方序列覆盖 ≥7 个对齐点时才判。
     单值官方万收是「某一天」的数：拿它去年化、再与 7 日净值涨幅比，量纲不一致，
     会算出几百上千倍的假告警（早期版本踩过，见 tests/trend_v136.test.mjs ②）。
     样本不足就明确写「未判」，不编一个数 —— 与本项目「缺数据就说没有」同一口径。 */
  let annualRatio = null;
  const annualSkipped = pairs.length < 7;
  if (!annualSkipped) {
    const w = pairs.slice(-7);
    const sumOff = w.reduce((s, p) => s + p.wan, 0);
    const navAt = d => { const x = pts.find(p => p[0] === d); return x ? x[1] : 0; };
    const a = navAt(w[0].date), b = navAt(w[w.length - 1].date);
    const navRet7 = a > 0 && b > 0 ? b / a - 1 : 0;
    const offRet7 = sumOff / 10000;
    annualRatio = offRet7 < 1e-8
      ? (Math.abs(navRet7) < 1e-8 ? 1 : 999)
      : foldRatio(navRet7, offRet7, 1e-8);
  }

  const ratios = [
    { name: "单日折算/官方倍数", value: dayRatio, limit: lim, skipped: false },
    { name: "区间累计倍数", value: cumRatio, limit: lim, skipped: false },
    { name: "7日年化自洽倍数", value: annualRatio, limit: lim, skipped: annualSkipped },
  ];
  const bad = ratios.filter(r => !r.skipped && r.value != null && isFinite(r.value) && r.value >= r.limit);
  const level = bad.length ? "suspect" : "ok";
  const note = bad.length
    ? bad.map(r => r.name + " " + r.value.toFixed(1) + " 倍（阈值 " + r.limit + " 倍）").join("、")
    : "各判据均在 " + lim + " 倍以内，未发现明显错位"
      + (annualSkipped ? "（官方序列不足 7 点，7 日年化自洽未判）" : "");
  return {
    ok: true, level, primary: "单位净值（台账 navHistory）",
    dayRatio, cumRatio, annualRatio, ratios,
    note,
    warnings: bad.length
      ? ["疑似口径错位：" + note + "。只标注、不删除原始数据；本次以单位净值为唯一分析主口径。"]
      : [],
  };
}

/* ---------------- ③ 三档情景 + 观察点 / 证伪线 ---------------- */

/**
 * 复用 reportScenarios 的三档情景，补「观察阈值 / 证伪线」。
 *
 * ★ 这些数字**全部由本机算**：模型只负责叙述「看什么、什么会使结论失效」。
 *   一律以「披露点」为单位，不换算自然日；也不给概率、不给目标净值。
 *
 * @param {any} nv reportNavFacts 的产出
 * @param {{ k?: number }} [opts]
 * @returns {any}
 */
export function trendScenarios(nv, opts) {
  const o = opts || {};
  const k = Number(o.k) > 0 ? Math.round(Number(o.k)) : 5;
  const sc = reportScenarios(nv, { k });
  if (!nv || !nv.ok || !sc || !sc.ok) return { ok: false, k, rows: [], verify: [], falsify: null };
  const last = nv.last.value;
  /** @type {Array<{key: string, name: string, bp: number, nav: number}>} */
  const verify = [
    { key: "normal", name: "按常态的下一披露点", bp: nv.normalBp, nav: last * (1 + nv.normalBp / 10000) },
    { key: "fast", name: "按最近两点的下一披露点", bp: nv.fastBp, nav: last * (1 + nv.fastBp / 10000) },
  ];
  /* 证伪线取三档情景「第一个披露点」的下界：低于它，说明连最保守的那一档都没走住，
     这一份专题的前提要重估。stress 的 perBp 可能为 null，用 cumBp/k 兜底。 */
  const firstBps = sc.rows.map(r => r.perBp == null ? r.cumBp / k : r.perBp);
  const lowBp = Math.min.apply(null, firstBps);
  const falsify = {
    bp: lowBp, nav: last * (1 + lowBp / 10000),
    note: "并列情景中下一披露点的下界；跌破即重估，不是止损价",
  };
  return {
    ok: true, k, byDate: sc.byDate, rows: sc.rows, low: sc.low, high: sc.high,
    verify, falsify, disclaimer: TREND_NOT_PREDICTION,
  };
}

/* ---------------- ④ 事实块 / 审计白名单 ---------------- */

/**
 * 专题事实块：口径段 +（复用的）确定性事实块 + 观察点/证伪线段。
 *
 * 复用 reportFactsText 是刻意的：净值/测算/情景/债市/宏观/盘中/信息面/日历
 * 那些分段的口径文案只维护一处。这里只**前后加两段**，并把末尾【写什么】
 * 换成专题的五段契约 —— 不复制、不另写一份口径说明。
 *
 * @param {any} q reportFactsText 的参数 + { caliber, consistency, scenarios(trend) }
 * @returns {string}
 */
export function trendFactsText(q) {
  const o = /** @type {any} */ (q || {});
  const cal = o.caliber || trendCaliber(null, {});
  const cons = o.consistency || null;
  const sc = o.scenarios || null;
  /** @type {string[]} */
  const head = [];
  head.push("【口径与数据可信度】本地启发式体检，非管理人披露，不许据此替产品下结论");
  head.push("- 口径判定：" + cal.label + "；分析主口径：" + cal.primary);
  head.push("- " + String(cal.note || ""));
  head.push("- 净值披露点 " + cal.n + " 个"
    + (cal.flatRatio != null ? "；无变动点占比 " + (cal.flatRatio * 100).toFixed(0) + "%" : "")
    + (cal.maxAbsBp != null ? "；最大单日变动 " + cal.maxAbsBp.toFixed(1) + "bp" : ""));
  for (const w of (Array.isArray(cal.warnings) ? cal.warnings : [])) head.push("- " + w);
  if (cons && cons.ok) {
    head.push("- 官方万收交叉核对：" + cons.level + "（" + cons.note + "）");
    for (const r of cons.ratios) {
      if (r.skipped) head.push("  " + r.name + "：官方序列不足 7 个对齐点，未判");
      else if (r.value != null && isFinite(r.value)) {
        head.push("  " + r.name + " " + r.value.toFixed(1) + " 倍（阈值 " + r.limit + " 倍）");
      }
    }
  } else {
    head.push("- 官方万收交叉核对：本机没有官方万份收益 / 7 日年化独立录入，未做交叉核对；涉及官方口径的判断写「数据块里没有」。");
  }
  head.push("- 主口径声明：本次一律以台账单位净值与本地测算为准；折算万份收益不单独作依据。");

  const base = reportFactsText(Object.assign({}, o, { kind: "product" }))
    .replace(/【写什么】[^\n]*/, "【写什么】五段：口径与数据可信度、近期驱动、并列情景与观察点、什么会使结论失效、数据缺口。");

  /** @type {string[]} */
  const tail = [];
  tail.push("【观察点与证伪线】全部按披露点由本机算出，不是预测；数字只许原样引用，不许自己再算一个");
  if (sc && sc.ok) {
    tail.push("- 并列情景（" + sc.rows.length + " 档，按可用口径，不是预测）：往前推 " + sc.k + " 个披露点"
      + (sc.byDate ? "，约到 " + sc.byDate.slice(5) : ""));
    for (const r of sc.rows) {
      tail.push("  " + r.name + "：累计 " + r.cumBp.toFixed(1) + "bp，净值 " + r.nav.toFixed(6));
    }
    for (const v of sc.verify) {
      tail.push("- 观察阈值 " + v.name + "：" + v.bp.toFixed(1) + "bp，净值 " + v.nav.toFixed(6));
    }
    tail.push("- 证伪线：" + sc.falsify.bp.toFixed(1) + "bp，净值 " + sc.falsify.nav.toFixed(6)
      + "（" + sc.falsify.note + "）");
    tail.push("- " + TREND_NOT_PREDICTION);
  } else {
    tail.push("- 本轮净值序列不足，观察阈值与证伪线算不出来：写「数据块里没有」，不许外推。");
  }
  tail.push("【拿不到的数据】口径体检不判定会计估值方法；本机没有官方万份收益 / 7 日年化序列，也没有实时资讯流。");
  return head.join("\n") + "\n" + base + "\n" + tail.join("\n");
}

/**
 * 专题新增数字的审计白名单。凡是写进事实块的数，都要能在这里回指，
 * 否则模型「照抄证伪线净值」会被 reportNumberAudit 判成编造 —— 那是最伤信任的误报。
 * @param {any} f briefFacts() 在 trend 模式下的产出
 * @returns {number[]}
 */
export function trendAuditValues(f) {
  /** @type {number[]} */
  const v = [];
  const push = x => { const n = Number(x); if (isFinite(n)) v.push(n); };
  const cal = f && f.caliber;
  if (cal) {
    push(cal.n); push(cal.flatRatio * 100); push(cal.maxAbsBp);
    const cons = cal.consistency || (f && f.consistency);
    if (cons && Array.isArray(cons.ratios)) for (const r of cons.ratios) {
      if (r.value != null) { push(r.value); push(r.limit); }
    }
  }
  const cons = f && f.consistency;
  if (cons && Array.isArray(cons.ratios)) {
    for (const r of cons.ratios) if (r.value != null) { push(r.value); push(r.limit); }
    push(cons.dayRatio); push(cons.cumRatio);
    if (cons.annualRatio != null) push(cons.annualRatio);
  }
  const sc = f && f.scenarios;
  if (sc && sc.ok) {
    push(sc.k);
    for (const r of sc.rows) { push(r.perBp); push(r.cumBp); push(r.nav); push(r.pct); }
    for (const x of sc.verify) { push(x.bp); push(x.nav); }
    if (sc.falsify) { push(sc.falsify.bp); push(sc.falsify.nav); }
  }
  return v;
}

/** 观察项：口径告警 + 观察阈值 + 证伪线，接在 reportWatch 的前面画出来。 */
export function trendWatcher(cal, cons, sc) {
  /** @type {Array<{level: string, text: string, sub: string}>} */
  const out = [];
  if (cal && cal.key !== "nav") {
    out.push({
      level: cal.key === "mixed-suspect" ? "bad" : "warn",
      text: "口径体检：" + cal.label,
      sub: String(cal.note || ""),
    });
  } else if (cal) {
    out.push({ level: "info", text: "口径体检：净值型，分析主口径为台账单位净值", sub: String(cal.note || "") });
  }
  if (cons && cons.level === "suspect") {
    out.push({ level: "bad", text: "疑似口径错位：" + cons.note, sub: "只标注、不删原始数据；折算万份收益不作弹性/年化依据" });
  }
  if (sc && sc.ok) {
    for (const x of sc.verify) {
      out.push({ level: "info", text: "观察阈值 " + x.name + "：净值 " + x.nav.toFixed(6),
        sub: "按披露点算，不是预测；下一次披露拿它对照" });
    }
    out.push({ level: "warn", text: "证伪线：净值 " + sc.falsify.nav.toFixed(6),
      sub: sc.falsify.note + "；跌破要重估这一份专题的前提，不是止损价" });
  }
  return out;
}

/** 卡片顶部的口径横幅。模型挂了也照画 —— 它是本地算的，不依赖回传。 */
export function trendCaliberHtml(cal) {
  if (!cal) return "";
  const cls = cal.key === "mixed-suspect" ? " warn" : "";
  const warns = (Array.isArray(cal.warnings) ? cal.warnings : [])
    .map(w => `<div>· ${esc(w)}</div>`).join("");
  return `<div class="rp-audit${cls}" data-trend-caliber="${esc(cal.key)}">`
    + `<b>口径体检 · ${esc(cal.label)}</b>`
    + `<div>分析主口径：${esc(cal.primary)}</div>${warns}`
    + `<div>${esc(TREND_NOT_PREDICTION)}</div></div>`;
}

/* ---------------- ⑤ 专题提示词 ---------------- */

/** 输出契约：头部三行沿用 parseReport，正文五段（`##` 分段，REPORT_MAX_PARAS=5 正好）。 */
export const TREND_INSTRUCTIONS = [
  "你是个人理财的持仓走势专题助手。读者是这台手机的主人，看得见自己的账，不需要科普，也不需要寒暄。",
  "",
  "【只用下面的数据块】",
  "- 数据块里没有的，写「数据块里没有」；不许估算、不许补默认值。",
  "- **不许新增任何数字**：你写的每个数字都必须原样出现在数据块里。指不回去的整句删掉。",
  "- 【观察点与证伪线】里的净值与 bp 是本机按披露点算好的，只许原样引用，不许自己再算下一个数。",
  "- 不做收益预测；不给概率；不给收益中枢或中枢下修；不给目标净值、止损价、止盈价；不给买卖指令。",
  "- 口径判定只照抄【口径与数据可信度】，不许替管理人判定估值方法，不许把「疑似」写成「就是」。",
  "- 推断句以「可能 / 倾向于 / 若…则…」开头，与事实句分开写。",
  "- 【信息面】【检索线索】全部待核：引用必须带来源与时间，且只能与已核验事实互证后引用，不得单独作依据。",
  "- 不要联网检索，不要给链接，不要写免责声明（页面自带）。",
  "",
  "【并列情景怎么读】数据块给几档就写几档，不许自己补一档；情景是把口径并排放，不是预测，也不是概率；写明「不是预测」。",
  "本机没有实时行情时，不许把上一交易日说成「今天」。",
  "",
  "【输出格式】严格照抄下面三行，然后五段，不要围栏、不要 JSON、不要编号列表：",
  "结论：continue 或 watch 或 adjust 或 collect（四选一，只写英文）",
  "信心：0 到 1 之间的小数",
  "标题：30 字以内的一句话结论",
  "",
  "## 口径与数据可信度",
  "照抄判定与主口径声明；有错位告警就写出来；60 到 160 字。",
  "## 近期驱动",
  "事实句 + 推断句分开；信息面须标待核；60 到 160 字。",
  "## 并列情景与观察点",
  "数字全部来自数据块；写明「不是预测」；60 到 160 字。",
  "## 什么会使结论失效",
  "只写证伪线与事件观察，不给概率、不给止损价；60 到 160 字。",
  "## 数据缺口",
  "显式列出没有的东西，没有就写「无」；60 到 160 字。",
  "",
  "共五段。不要复述表格的每一行 —— 表格读者自己看得见，你只写怎么读、看什么。",
  "中文，句子短，不用感叹号，不用「建议您」。",
].join("\n");

/* ---------------- ⑥ 问答分派（缺口④） ---------------- */

/** 「问走势」类提问：问答链路只有单点净值，问这些会逼模型编，改走专题入口。 */
const TREND_Q_RE =
  /(未来|后市|走势|展望|预测|下周|下月|还能|会不会|可以涨|继续涨)[^。？！]{0,14}(涨|跌|收益|净值|行情|怎么样|如何|空间|走)|(涨|跌)[^。？！]{0,8}(概率|预测|空间|目标|到多少)|(未来|后市)[^。？！]{0,8}(怎么|如何|会怎样)/;

/**
 * 命中返回提示文案（调用方据此**不发请求、不计费**），否则返回空串。
 * 纯函数，便于单测钉住「不误伤正常提问」。
 * @param {string} q
 * @returns {string}
 */
export function trendQuestionHint(q) {
  const s = String(q == null ? "" : q);
  if (!s.trim() || !TREND_Q_RE.test(s)) return "";
  return "问走势请走「走势分析」：产品详情 → 走势分析，那里带净值序列、口径体检、并列情景与观察点/证伪线。"
    + "这里的问答只有单点净值，直接问会让模型凭空推断 —— 这一问没有发出，也没有计费。";
}

/* ================= v137 · P1：信息面新鲜度（自动 + 可核） =================
   方案 4.4 第 1 条：专题卡片顶部显示信息面四路的时点，超期明说「建议刷新」，
   不静默用旧数据冒充最新。四路 = 新闻快照（NEWS.asOf）/ 检索包（AY_PACK.asOf）/
   债市快照（MARKET.weather.asOf，交易日日终）/ 盘中参考（LIVE.at，毫秒）。

   ★ 两条边界（改任何一条都要同步改 tests/trend_p1_v137.test.mjs）：
     1. 新鲜度只在**渲染层**现算：不进 briefPack、不进指纹 fp —— 时点每分钟都在变，
        进指纹会把「数据没变，直接用上一份」的省费闸打碎；
     2. 只标注、不代替刷新：横幅给出「建议刷新」，真正的刷新永远是用户点按钮
        （newsRefresh(force) / anysearchRun()），不后台自动跑（铁律 #5）。 */

/** 超龄阈值（小时）。news/ay=36h（每日 3 档 cron + 手动检索的合理跨度）；
    market=72h（交易日日终估值，跨周末顺延属正常）；live=12h（盘中数据隔日必旧）。 */
export const TREND_FRESH_LIMITS = { news: 36, ay: 36, market: 72, live: 12 };

/** 时点 → 距 now 的小时数。支持「YYYY-MM-DD HH:MM」「YYYY-MM-DD」（按 +08:00，
    北京时点）与毫秒数；解析不了返回 NaN —— NaN 一律按「missing」处理，
    绝不把读不懂的时点当成「新鲜」。 */
export function trendAgeHours(dt, now = Date.now()) {
  if (dt == null || dt === "") return NaN;
  if (typeof dt === "number") return isFinite(dt) ? (now - dt) / 3600000 : NaN;
  const s = String(dt).trim();
  if (!s) return NaN;
  const t = Date.parse(s.includes(":")
    ? s.replace(" ", "T") + "+08:00"
    : s + "T00:00:00+08:00");
  return isFinite(t) ? (now - t) / 3600000 : NaN;
}

/** 四路时点盘点 → { items, stale, missing, allOk, note }。
    每项：{ key, label, missing, stale, ageH, asOfText, ageText, lim, hint }。
    missing = 没有数据或时点读不懂；stale = 有数据但超过阈值。两者互斥。 */
export function trendFreshness(src, now = Date.now()) {
  const item = (key, label, dt, lim, hint) => {
    const h = trendAgeHours(dt, now);
    const missing = !isFinite(h);
    return {
      key, label, missing, stale: !missing && h > lim, ageH: missing ? NaN : h,
      asOfText: missing ? "" : String(typeof dt === "number" ? "" : dt).slice(0, 16),
      ageText: missing ? "" : h >= 24 ? (h / 24).toFixed(1) + " 天前" : Math.round(h) + " 小时前",
      lim, hint,
    };
  };
  const news = src && src.news, ay = src && src.ay;
  const market = src && src.market, live = src && src.live;
  const items = [
    item("news", "新闻快照", news ? news.asOf : null, TREND_FRESH_LIMITS.news, "每日 3 档 cron"),
    item("ay", "检索包", ay ? ay.asOf : null, TREND_FRESH_LIMITS.ay, "手动检索 · 非发布时间"),
    item("market", "债市快照", market && market.weather ? market.weather.asOf : null, TREND_FRESH_LIMITS.market, "交易日日终 · 周末顺延"),
    item("live", "盘中参考", live ? live.at : null, TREND_FRESH_LIMITS.live, "实时行情 · 盘中有效"),
  ];
  const stale = items.filter(i => i.stale);
  const missing = items.filter(i => i.missing);
  const note = missing.length === items.length
    ? "信息面四路都没有数据 —— 点「更新信息面」先取一次"
    : stale.length
      ? "信息面已过期，建议刷新：" + stale.map(i => i.label).join("、")
      : missing.length
        ? "缺 " + missing.map(i => i.label).join("、") + "（不影响其余三路照常使用）"
        : "";
  return { items, stale, missing, allOk: stale.length === 0 && missing.length === 0, note };
}

/** 横幅渲染。复用 rp-audit 卡样式（与口径横幅同族，零新增 CSS）：
    warn 色只在有过期项时出现，全新鲜时不打扰。 */
export function trendFreshHtml(fresh) {
  if (!fresh || !Array.isArray(fresh.items)) return "";
  const row = i => {
    const mark = i.missing ? "·" : i.stale ? "✗" : "✓";
    const val = i.missing
      ? "没有数据"
      : esc(i.asOfText) + "（北京）· " + i.ageText + (i.stale ? " · 超龄" : "");
    return `<div><span class="${i.stale ? "rp-bad" : ""}">${mark}</span> ${esc(i.label)}：${val}`
      + ` <span style="opacity:.62">（${esc(i.hint)}）</span></div>`;
  };
  const cls = fresh.stale && fresh.stale.length ? " warn" : "";
  const head = fresh.allOk ? "信息面时点 · 四路都在有效期内" : "信息面时点 · 有过期或缺项，看下面";
  return `<div class="rp-audit${cls}" data-trend-fresh="1"><b>${esc(head)}</b>`
    + fresh.items.map(row).join("")
    + (fresh.note ? `<div>${esc(fresh.note)}</div>` : "") + "</div>";
}
