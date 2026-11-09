// @ts-check
/* ---------- AI 研判（T4）：把「专家怎么想」变成可测的编排层 ----------
   从 app.js 抽出来的纯函数（同 analysis.js / board.js / llm.js 的做法）：拆出来才能被
   node --test 直接钉住。这一层只做四件事，不做第五件：

     1. briefBuild()      —— 把「组合/单只 + 体检 + 债市」装配成一次请求的 input；
     2. briefFingerprint() —— 算数据指纹，让「数据没变就别再花一次钱」可判定；
     3. extractJson()/normBrief() —— 容错解析 + 逐条校验（模型不会老实输出 JSON）；
     4. briefCardHtml()   —— 把校验后的结论画成卡片，措辞规则也在这里，才能被测试断言。

   ★ 五条口径（改任何一条都要同步改 tests/brief.test.mjs）：

     1. **数字一律本地算，模型只解释。** briefMetrics() 只做四则运算（区间收益、最大回撤、
        波动），不碰份额/成本/市值 —— 那些是 position.js 的事，这里再写一遍就是第二份实现。
        模型拿到的永远是「算好的结论」，不是原始序列：让模型自己算回撤，它会算得很像样，然后错。

     2. **明细档默认，但不许越过「隐藏金额」。** 明细档带产品名（这是分析的前提），
        份额与成本跟本机「隐藏金额」走 —— 屏幕上被藏掉的数，不许从这条路上漏出去。
        聚合档连产品名都不给（换成序号 + 品类），用于只想看结构的时候。

     3. **不做收益预测，不给目标净值/止损止盈。** 理财没有对应的市场机制，给了就是编的。
        禁用词命中 headline → 整份拒收；命中其余条目 → 该条丢弃并计数（不静默）。

     4. **每条判断必须能指回数据块。** basis 只认 ledger/check/market/web 四个值；
        认不出来的一律记 none（界面画「未标注依据」），不许默认成 ledger 冒充有出处。

     5. **不修补坏 JSON。** extractJson() 只做「围栏 → 首尾花括号」两种提取，失败返回 null。
        补引号、补逗号修出来的 JSON 会把错位的字段静默塞进错误的槽位 —— 那比降级更坏。

   ★ 与 llm.js 的分工：那一层管「怎么发、怎么收回传、来源怎么分级」，这一层管
     「发什么、回来的是什么、错了怎么退」。两层的常量各管各的，不许互相 import 常量。
*/

import { esc } from "../core/util.js";
import { marketAiBlock } from "../core/market.js";

/** 提示词版本：改 BRIEF_INSTRUCTIONS / 输出契约 / 四段框架，必须 +1。
    它进指纹 —— 不加版本号会出的事：提示词改了、指纹没变，用户看到旧结论却以为是新的。 */
export const BRIEF_PROMPT_VER = "brief-2";

/** 两档。detail 是默认（用户 2026-11-09 定：主要看自己持有的产品详情）。 */
export const BRIEF_TIER_DETAIL = "detail";
export const BRIEF_TIER_AGG = "aggregate";
export const BRIEF_TIER_LABEL = { detail: "明细档", aggregate: "聚合档" };
/** 每档的 input 字数上限。超了按 blocks 的优先级从后往前砍，砍了什么要写在末尾。
    v110 起从 5200/2400 收紧：研判要在原生 90 秒读超时之内回来，
    输入越大首字越晚 —— 实测债市块曾独占 1364 字，比全部台账还多。 */
export const BRIEF_MAX_CHARS = { detail: 3200, aggregate: 1800 };
/** 单只产品的净值序列最多带几个点（只用于算指标，不进 prompt）。 */
export const BRIEF_METRIC_MIN_POINTS = 6;

/** 结论枚举。collect 排最后：数据缺口大的时候它才是正确答案，不该被当成失败。 */
export const BRIEF_VERDICTS = ["continue", "watch", "adjust", "collect"];
export const BRIEF_VERDICT_TEXT = {
  continue: "维持现状",
  watch: "继续观察",
  adjust: "考虑调整",
  collect: "先补信息",
};
/** 依据标记。none = 模型没标或标了个不认识的 —— 界面要如实画「未标注」。 */
export const BRIEF_BASIS_LABEL = { ledger: "台账", check: "体检", market: "债市", web: "检索", none: "未标注" };
export const BRIEF_SECTION_TITLE = { structure: "结构", product: "产品", market: "市场" };
const SECTION_KEYS = ["structure", "product", "market"];

/** 禁用词：收益预测与「目标价」类表述。命中 headline → 整份拒收（结论不可信）。 */
export const BRIEF_BANNED_RE = /(预期收益|预计收益|收益率预测|预测收益|预测净值|必涨|稳赚|保本保收益|目标净值|止损位|止盈位|止损价|止盈价)/;
/** 固定页脚：不构成投资建议。所有呈现路径都要带上，包括降级原文。 */
export const BRIEF_DISCLAIMER = "以上为信息整理，不构成投资建议；模型可能出错，请自行核对。";

/** 单次结论的条数上限：防模型把一段话拆成二十条要点把屏幕撑爆。 */
const MAX_POINTS_PER_SECTION = 4;
const MAX_ACTIONS = 4;
const MAX_UNKNOWNS = 5;
const MAX_SOURCES = 6;
const MAX_TEXT_CHARS = 240;

/**
 * 专家指令。写成常量而不是散在调用点：它是「资产」，要能被版本号管住、被测试断言。
 * ★ 这里刻意不出现具体厂商名与模型名 —— 换端点时这段一个字都不用改。
 *
 * ★ v110 的两点收紧，都是冲着「90 秒读超时」去的（真机 v109 报 timeout）：
 *   1) **不再要 sources / 不再要联网**。v109 的输出契约里要 url + 发布日期，
 *      而端点默认带着联网检索工具 —— 模型为了凑出处会去搜，几次搜索就把 90 秒吃完了；
 *      同一时刻的追问不要出处，所以它一直能回。研判本来就只用本机数据，出处是编的温床。
 *   2) **字数封顶 500**。v109 的四段 + 每段 3 条 + 动作 4 条，实际产出常常 1200 字以上，
 *      深度推理模型还要先想一遍；输入 2100 字 + 输出 1200 字 + 思考，落不进一个读超时。
 */
export const BRIEF_INSTRUCTIONS = [
  "你是个人理财台账的分析助手。读者就是这台手机的主人，他看得见自己的账，不需要科普，也不需要寒暄。",
  "",
  "【只用下面的数据块】",
  "- 数据块里没有的，写「数据块里没有」，不许估算、不许补默认值。",
  "- 任何数字都要能指回具体某一块；指不回去的判断直接删掉。",
  "- 不做收益预测；不写「预期收益 / 预计收益 / 会涨 / 稳赚」这类话。",
  "- 不给目标净值、止损价、止盈价 —— 理财没有对应的市场机制，给了就是编的。",
  "- 推断句必须以「可能 / 倾向于 / 若…则…」开头，与事实句分开写。",
  "- 信息不足时先说要补什么、缺哪一项，再谈能得出什么；不许拿一个看着合理的数把缺口填上。",
  "- 不要联网检索，也不要引用数据块以外的资料；不要给链接、不要给 sources。",
  "",
  "【输出】只输出一个 JSON 对象：不要解释文字，不要 Markdown 围栏，不要逐条复述输入。",
  "中文，句子短，不用感叹号，不用「建议您」。总字数不超过 500。字段：",
  '{"verdict":"continue|watch|adjust|collect","confidence":0到1之间的小数,',
  ' "headline":"30字以内的一句话结论",',
  ' "sections":[{"key":"structure|product|market","points":[{"text":"50字以内","basis":"ledger|check|market"}]}],',
  ' "actions":[{"target":"产品名或组合","do":"继续持有|观察|到期换仓|补录信息","why":"30字以内","cost":"20字以内"}],',
  ' "unknowns":["数据缺口，20字以内"]}',
  "sections 2 到 3 段、每段 1 到 2 条；actions 1 到 2 条，没有就空数组；unknowns 至多 3 条。",
  "已经知道的事实直接下结论；免责声明不用写，页面自带。",
].join("\n");

/** 两个入口的固定问题。不让用户手打，才能保证每次问的是同一件事（可比、可缓存）。 */
export const BRIEF_QUESTION = {
  portfolio: "看我现在的持仓：结构上有没有需要处理的地方？哪只该动、哪只不用管、动之前要付什么代价？",
  product: "这一只现在该不该继续拿？依据是什么、有哪些代价、还需要补什么信息？",
};

/* ---------------- 指标（纯四则运算，不碰钱的口径） ---------------- */

/**
 * 从净值序列算四个结论性指标。**取的是「最近 N 个数据点」，不是日历日** ——
 * 理财产品有周末与节假日缺值，按日历日算会把「7 天」算成 5 个点，再乘 7/5 去"修正"
 * 就是自造口径。这里宁可标注「近 N 个披露点」，让它诚实。
 *
 * @param {Array<[string, number]>} series 升序 [[date, nav], ...]
 * @returns {{ n: number, d7: number|null, d30: number|null, d90: number|null, dd: number|null, vol: number|null }}
 */
export function briefMetrics(series) {
  const pts = (Array.isArray(series) ? series : [])
    .filter(p => Array.isArray(p) && typeof p[1] === "number" && isFinite(p[1]) && p[1] > 0);
  const n = pts.length;
  const out = { n, d7: null, d30: null, d90: null, dd: null, vol: null };
  if (n < 2) return out;
  const last = pts[n - 1][1];
  /** 近 k 个点的区间收益：基点是倒数第 k+1 个点（没有就退到第 1 个点，并在文案里说明是"全部"）。 */
  const back = k => {
    const i = Math.max(0, n - 1 - k);
    const base = pts[i][1];
    return base > 0 ? (last / base - 1) * 100 : null;
  };
  if (n >= BRIEF_METRIC_MIN_POINTS) {
    out.d7 = back(7);
    out.d30 = back(30);
    out.d90 = back(90);
  }
  /* 最大回撤：任一历史高点之后的最深跌幅（用收盘净值，不含分红再投 —— 台账里没有那个字段）。 */
  let peak = pts[0][1], worst = 0;
  for (const p of pts) {
    if (p[1] > peak) peak = p[1];
    if (peak > 0) {
      const d = (p[1] / peak - 1) * 100;
      if (d < worst) worst = d;
    }
  }
  out.dd = worst;
  /* 年化波动：日收益率的样本标准差 × sqrt(252)。少于 6 个点不给 —— 3 个点算出来的"波动"是噪声。 */
  if (n >= BRIEF_METRIC_MIN_POINTS) {
    const rs = [];
    for (let i = 1; i < n; i++) {
      const a = pts[i - 1][1], b = pts[i][1];
      if (a > 0) rs.push(b / a - 1);
    }
    if (rs.length >= 3) {
      const m = rs.reduce((s, v) => s + v, 0) / rs.length;
      const varr = rs.reduce((s, v) => s + (v - m) * (v - m), 0) / (rs.length - 1);
      out.vol = Math.sqrt(Math.max(0, varr)) * Math.sqrt(252) * 100;
    }
  }
  return out;
}

/**
 * 百分比文案。保留两位；null → 「—」。
 * ★ 必须先判 null/undefined/空串再 Number()：Number(null) 是 0，会让「没有这个数」
 *   在屏幕上变成「+0.00%」—— 一个看得见的假数字，比一个破折号坏得多。
 */
export function briefPctText(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

/* ---------------- 数据块装配 ---------------- */

function oneLine(v, max) {
  const s = String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim();
  const lim = max || 60;
  return s.length > lim ? s.slice(0, lim) + "…" : s;
}
function numOr(v, dp, suffix) {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(dp) + (suffix || "") : "—";
}

/**
 * 组合块。
 * @param {Array<object>} items 每只的事实（见 app.js 的 briefItems()）
 * @param {{ tier?: string, hide?: boolean, today?: string, totals?: object }} opts
 */
export function briefPortfolioBlock(items, opts) {
  const o = opts || {};
  const detail = o.tier !== BRIEF_TIER_AGG;
  const hide = !!o.hide;
  const list = Array.isArray(items) ? items : [];
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) ? String(o.today) : "日期不明";
  const t = o.totals || {};
  const head = "【我的持仓 · " + list.length + " 只 · 截至 " + td + "】";
  const lines = [];
  const stat = [];
  if (isFinite(Number(t.value)) && Number(t.value) > 0) {
    stat.push(hide ? "合计市值（金额已隐藏）" : "合计市值 " + numOr(t.value, 2, " 元"));
  }
  if (isFinite(Number(t.weightedDays)) && Number(t.weightedDays) > 0) stat.push("加权持有 " + Math.round(Number(t.weightedDays)) + " 天");
  if (isFinite(Number(t.kinds)) && Number(t.kinds) > 0) stat.push("品类 " + Number(t.kinds) + " 类");
  if (isFinite(Number(t.inTransit)) && Number(t.inTransit) > 0) stat.push("在途 " + Number(t.inTransit) + " 笔");
  if (stat.length) lines.push(stat.join(" ｜ "));
  list.forEach((it, i) => {
    const m = it.metrics || {};
    const bits = [];
    /* 聚合档：连产品名都不给。序号 + 品类 + 风险 + 期限 —— 够判断结构，不足以定位到人。 */
    const name = detail ? (oneLine(it.name, 40) || "（无名产品）") : "产品" + (i + 1);
    bits.push((i + 1) + ". " + name);
    if (detail) {
      if (it.inst) bits.push(oneLine(it.inst, 24));
      if (it.risk) bits.push("风险 " + oneLine(it.risk, 8));
      if (it.benchmark) bits.push("基准 " + oneLine(it.benchmark, 70));
    } else if (it.kind) bits.push(oneLine(it.kind, 20));
    bits.push("净值 " + (isFinite(Number(it.nav)) && Number(it.nav) > 0 ? numOr(it.nav, 4) : "无净值")
      + "（" + (/^\d{4}-\d{2}-\d{2}$/.test(String(it.navDate || "")) ? it.navDate : "日期不明") + "）");
    bits.push(hide ? "份额 金额已隐藏" : "份额 " + numOr(it.shares, 2));
    bits.push(hide ? "成本 金额已隐藏" : "成本 " + numOr(it.cost, 2));
    bits.push("持有 " + (isFinite(Number(it.holdDays)) && Number(it.holdDays) > 0 ? Math.round(Number(it.holdDays)) + " 天" : "不足 1 天"));
    if (it.state) bits.push("状态 " + oneLine(it.state, 16));
    const mets = [];
    if (m.d30 != null) mets.push("近30点 " + briefPctText(m.d30));
    if (m.dd != null) mets.push("最大回撤 " + briefPctText(m.dd));
    if (m.vol != null) mets.push("年化波动 " + briefPctText(m.vol));
    if (mets.length) bits.push(mets.join(" · "));
    lines.push(bits.join(" · "));
  });
  if (!list.length) lines.push("（台账里没有产品：这一块没带任何持仓）");
  return head + "\n" + lines.join("\n");
}

/**
 * 单只块。用于「体检页点这一只做研判」—— 比组合块多了体检结论与净值指标。
 * @param {object} it
 * @param {{ hide?: boolean, today?: string, checks?: Array<object> }} opts
 */
export function briefProductBlock(it, opts) {
  const o = opts || {};
  const hide = !!o.hide;
  const p = it || {};
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) ? String(o.today) : "日期不明";
  const lines = [];
  lines.push("【这一只 · 截至 " + td + "】");
  lines.push([
    oneLine(p.name, 40) || "（无名产品）",
    p.inst ? oneLine(p.inst, 24) : "机构未填",
    p.code ? "代码 " + oneLine(p.code, 32) : "",
    p.risk ? "风险 " + oneLine(p.risk, 8) : "",
  ].filter(Boolean).join(" · "));
  if (p.benchmark) lines.push("业绩基准：" + oneLine(p.benchmark, 100));
  const m = p.metrics || {};
  const navLine = [
    "净值 " + (isFinite(Number(p.nav)) && Number(p.nav) > 0 ? numOr(p.nav, 4) : "无净值")
      + "（" + (/^\d{4}-\d{2}-\d{2}$/.test(String(p.navDate || "")) ? p.navDate : "日期不明") + "）",
    hide ? "份额（金额已隐藏）" : "份额 " + numOr(p.shares, 2),
    hide ? "成本（金额已隐藏）" : "成本 " + numOr(p.cost, 2),
    "持有 " + (isFinite(Number(p.holdDays)) && Number(p.holdDays) > 0 ? Math.round(Number(p.holdDays)) + " 天" : "不足 1 天"),
    p.state ? "状态 " + oneLine(p.state, 16) : "",
  ].filter(Boolean);
  lines.push(navLine.join(" · "));
  const mets = [];
  if (m.n) mets.push("披露点 " + Number(m.n) + " 个");
  if (m.d7 != null) mets.push("近7点 " + briefPctText(m.d7));
  if (m.d30 != null) mets.push("近30点 " + briefPctText(m.d30));
  if (m.d90 != null) mets.push("近90点 " + briefPctText(m.d90));
  if (m.dd != null) mets.push("区间最大回撤 " + briefPctText(m.dd));
  if (m.vol != null) mets.push("年化波动 " + briefPctText(m.vol));
  if (mets.length) lines.push("走势：" + mets.join(" · ") + "（按披露点数算，非日历日）");
  return lines.join("\n");
}

/**
 * 体检块：**只列 warn / bad**，ok 压成一句，na 单列成"缺口"。
 * 理由：11 项全列会让模型把注意力平均分配到 8 个"正常"上，而用户真正要看的是那 1 个"有问题"。
 * @param {Array<{key?:string,title?:string,level?:string,text?:string}>} checks
 */
export function briefChecksBlock(checks) {
  const list = Array.isArray(checks) ? checks : [];
  if (!list.length) return "";
  const bad = list.filter(c => c && (c.level === "bad" || c.level === "warn"));
  const ok = list.filter(c => c && c.level === "ok");
  const na = list.filter(c => c && c.level === "na");
  const lines = ["【机械体检结论（本地判据算出，非模型推断）】"];
  if (bad.length) {
    for (const c of bad) {
      lines.push("- " + (c.level === "bad" ? "有问题" : "要注意") + "｜" + oneLine(c.title, 12) + "：" + oneLine(c.text, 110));
    }
  } else {
    lines.push("- 无异常项");
  }
  if (ok.length) lines.push("（其余 " + ok.length + " 项正常）");
  if (na.length) lines.push("（信息不足 " + na.length + " 项：" + na.map(c => oneLine(c.title, 10)).join("、") + "）");
  return lines.join("\n");
}

/**
 * 债市块（研判专用）：只要「关键期限的收益率与当日 BP」，不要逐格行情。
 *
 * ★ v110 换掉 v108 的整段 aiText（实测 1364 字，比全部台账 608 字还多一倍）。
 *   那一份是给「单只产品下一披露日环境」写的，自带「要求：据此归因…」的口吻，
 *   搬进研判既跑题又拖慢首字。这里改从 weather.cells 直接取数：
 *   国债 5 个期限 + 信用 AAA 3 个期限 + 10 年累计 BP，约 180 字。
 *   老快照没有 cells 的，退回 aiText 节选（标题 + 利率债 + 缺口），不整段搬。
 * @param {any} m
 */
export function briefMarketBlock(m) {
  const empty = "【债市】\n本轮没有可用的债市快照（未核验或未取到）—— 涉及市场环境的判断只能写「数据块里没有」。";
  if (!m || !m.meta || m.meta.verified !== true) return empty;
  const c = briefMarketCompact(m);
  if (c) return "【债市】\n" + c;
  const full = marketAiBlock(m);
  if (!full) return empty;
  const lines = String(full).split("\n").map(s => s.trim()).filter(Boolean);
  const keep = [];
  if (lines[0]) keep.push(lines[0]);
  const rate = lines.find(s => s.indexOf("利率债：") === 0);
  if (rate) keep.push(rate);
  const gap = lines.find(s => s.indexOf("缺口：") === 0);
  if (gap) keep.push(gap);
  keep.push("（逐格行情未展开：研判只看方向与关键期限）");
  const out = keep.join("\n");
  return "【债市】\n" + (out.length > 420 ? out.slice(0, 420) + "…" : out);
}

/** 结构化紧凑块：没有可读的 cells 就返回空串（由 briefMarketBlock 退回节选）。 */
export function briefMarketCompact(m) {
  const w = (m && m.weather) || {};
  const cells = Array.isArray(w.cells) ? w.cells : [];
  if (!cells.length) return "";
  const pick = (issuer, tenor) => cells.find(c => c && c.issuer === issuer && c.tenor === tenor);
  const bpOf = c => {
    if (!c || !c.basis || c.dir === "none") return null;
    const bp = Number(c.basis.bp1d);
    return isFinite(bp) ? bp : null;
  };
  const fmt = bp => (bp > 0 ? "+" : "") + bp.toFixed(1) + "bp";
  const gov = [];
  for (const t of ["1年", "3年", "5年", "7年", "10年"]) {
    const c = pick("国债", t);
    const bp = bpOf(c);
    if (bp === null) continue;
    const y = Number(c.basis.yieldPct);
    gov.push(t + (isFinite(y) ? y.toFixed(3) + "%" : "") + "/" + fmt(bp));
  }
  const aaa = [];
  for (const t of ["1年", "3年", "5年"]) {
    const bp = bpOf(pick("AAA", t));
    if (bp === null) continue;
    aaa.push(t + fmt(bp));
  }
  if (!gov.length) return "";
  const out = ["快照 " + w.asOf + "（上一交易日 " + w.prevDate + "），中债官方收益率曲线，已核验。"];
  out.push("国债 收益率/当日变动：" + gov.join("｜"));
  if (aaa.length) out.push("信用AAA 当日变动：" + aaa.join("｜"));
  const trend = briefMarketTrend(m);
  if (trend) out.push(trend);
  out.push("口径：BP 为负 = 收益率下行 = 债券价格上涨。");
  const gaps = (m.meta && Array.isArray(m.meta.gaps)) ? m.meta.gaps.filter(g => typeof g === "string" && g) : [];
  out.push("缺口：" + (gaps.length ? gaps.slice(0, 3).join("、") : "无"));
  const text = out.join("\n");
  return text.length > 420 ? text.slice(0, 420) + "…" : text;
}

/** 10 年国债的 5 日 / 20 日累计 BP —— 只给方向，不给区间。没有 bpTable 就返回空串。 */
export function briefMarketTrend(m) {
  const t = Array.isArray(m && m.bpTable) ? m.bpTable.find(x => x && x.issuer === "国债" && x.tenor === "10年") : null;
  if (!t || !t.bp) return "";
  const one = v => (Array.isArray(v) && isFinite(Number(v[0])) ? Number(v[0]) : null);
  const d5 = one(t.bp["5日"]);
  const d20 = one(t.bp["20日"]);
  if (d5 === null && d20 === null) return "";
  const parts = [];
  if (d5 !== null) parts.push("5日 " + (d5 > 0 ? "+" : "") + d5.toFixed(1) + "bp");
  if (d20 !== null) parts.push("20日 " + (d20 > 0 ? "+" : "") + d20.toFixed(1) + "bp");
  return "10年国债累计：" + parts.join("｜");
}

/**
 * 装配一次请求。返回 input / instructions / 字数 / 分块明细 —— 字数要在发之前给用户看。
 * 超限时按 blocks 顺序从**后**往前砍（债务背景先砍，产品事实最后砍），并把砍掉的写进 input 末尾，
 * 不许静默截断：用户以为模型看了全部，其实没看，那种错没法从结论里看出来。
 *
 * @param {{ target?: {kind?:string,id?:string}, items?: Array<object>, checks?: Array<object>,
 *   market?: any, tier?: string, hide?: boolean, today?: string, question?: string,
 *   totals?: {value?: number, weightedDays?: number, kinds?: number, inTransit?: number} }} q
 */
export function briefBuild(q) {
  const o = q || {};
  const tier = o.tier === BRIEF_TIER_AGG ? BRIEF_TIER_AGG : BRIEF_TIER_DETAIL;
  const cap = BRIEF_MAX_CHARS[tier];
  const kind = (o.target && o.target.kind) || "portfolio";
  const items = Array.isArray(o.items) ? o.items : [];
  const blocks = [];
  if (kind === "product") {
    blocks.push({ key: "product", text: briefProductBlock(items[0] || {}, { hide: o.hide, today: o.today }) });
    const ck = briefChecksBlock(o.checks);
    if (ck) blocks.push({ key: "check", text: ck });
  } else {
    blocks.push({ key: "portfolio", text: briefPortfolioBlock(items, { tier, hide: o.hide, today: o.today, totals: o.totals }) });
    const ck = briefChecksBlock(o.checks);
    if (ck) blocks.push({ key: "check", text: ck });
  }
  blocks.push({ key: "market", text: briefMarketBlock(o.market) });

  const qText = String(o.question || BRIEF_QUESTION[kind === "product" ? "product" : "portfolio"]);
  const head = "【这一次要看的问题】\n" + qText;
  /* 先按顺序整块放，放不下就砍最后一块（债市），再放不下才砍体检。 */
  const kept = blocks.slice();
  const droppedKeys = [];
  const used = () => head.length + kept.reduce((s, b) => s + b.text.length + 2, 0);
  while (kept.length > 1 && used() > cap) {
    const cut = kept.pop();
    droppedKeys.unshift(cut.key);
  }
  let input = kept.map(b => b.text).join("\n\n") + "\n\n" + head;
  if (droppedKeys.length) {
    input += "\n\n（本次因字数上限未带上：" + droppedKeys.join("、") + " —— 涉及这些的判断请写「数据块里没有」）";
  }
  return {
    v: 1,
    input,
    instructions: BRIEF_INSTRUCTIONS,
    chars: input.length,
    tier,
    kind,
    blocks: kept.map(b => ({ key: b.key, chars: b.text.length })),
    dropped: droppedKeys,
    over: input.length > cap,
  };
}

/* ---------------- 指纹 ---------------- */

/** FNV-1a 32 位（与 analysis.js 的 anaFingerprint 同一种算法，这里不 import 是为了
    让 brief.js 不依赖 analysis.js 的整条链 —— 那个模块会拉进 nav/calendar/board）。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

/**
 * 数据指纹：什么变了才需要重算。
 * 组成 = 目标 + 每只的「id + 最新净值 + 净值日」+ 债市 asOf + 档位 + 提示词版本。
 * ★ 刻意不含金额与份额：开关「隐藏金额」不该让结论作废（与 anaFingerprint 同一条理由）。
 * @param {{ target?: {kind?:string,id?:string}, items?: Array<object>, marketAsOf?: string,
 *   tier?: string, ver?: string }} q
 */
export function briefFingerprint(q) {
  const o = q || {};
  const kind = (o.target && o.target.kind) || "portfolio";
  const id = (o.target && o.target.id) || "";
  const items = (Array.isArray(o.items) ? o.items : [])
    .map(it => [String(it.id || ""), String(it.nav == null ? "" : it.nav), String(it.navDate || "")].join(":"))
    .sort()
    .join("|");
  const parts = [
    "k=" + kind, "id=" + id, "d=" + items,
    "m=" + String(o.marketAsOf || ""),
    "t=" + String(o.tier || ""),
    "v=" + String(o.ver || BRIEF_PROMPT_VER),
  ];
  return fnv1a(parts.join("\n"));
}

/* ---------------- 解析与校验 ---------------- */

/**
 * 从模型回复里抠出 JSON。两个候选：```json 围栏内的内容、整段文本的首尾花括号之间。
 * 失败返回 null（调用方据此降级成原文渲染），**不做修补**。
 * @param {string} text
 * @returns {any|null}
 */
export function extractJson(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim()) return null;
  const cands = [];
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) cands.push(fence[1]);
  cands.push(s);
  for (const c of cands) {
    const t = String(c).trim();
    if (!t) continue;
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i < 0 || j <= i) continue;
    const sub = t.slice(i, j + 1);
    try {
      const obj = JSON.parse(sub);
      if (obj && typeof obj === "object") return obj;
    } catch (e) { /* 换下一个候选 */ }
  }
  return null;
}

function cleanText(v, max) {
  const s = String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim();
  return s.length > (max || MAX_TEXT_CHARS) ? s.slice(0, max || MAX_TEXT_CHARS) + "…" : s;
}

/**
 * 逐条校验模型给的结论。**宁缺勿假**：认不出的字段一律丢，不猜、不补。
 *
 * @param {any} obj
 * @returns {{ ok: boolean, why?: string, brief?: object, dropped?: { sources: number, points: number, actions: number, banned: number } }}
 */
export function normBrief(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, why: "模型回的不是一个 JSON 对象" };
  }
  const dropped = { sources: 0, points: 0, actions: 0, banned: 0 };
  const verdict = BRIEF_VERDICTS.indexOf(String(obj.verdict || "")) >= 0 ? String(obj.verdict) : "watch";
  const headline = cleanText(obj.headline, 80);
  /* headline 命中禁用词 = 整份结论的方向已经偏了（它开始预测收益/给目标价），
     这种情况下留着它的分析段落只会误导 —— 整份拒收，让用户重来。 */
  if (headline && BRIEF_BANNED_RE.test(headline)) {
    return { ok: false, why: "模型给出了收益预测或目标价类表述，这份结论不予采用" };
  }
  let conf = Number(obj.confidence);
  conf = (isFinite(conf) && conf >= 0 && conf <= 1) ? Math.round(conf * 100) / 100 : null;

  const sections = [];
  const rawSecs = Array.isArray(obj.sections) ? obj.sections : [];
  for (const s of rawSecs) {
    const key = String((s && s.key) || "");
    if (SECTION_KEYS.indexOf(key) < 0) continue;
    const pts = [];
    const rawPts = Array.isArray(s && s.points) ? s.points : [];
    for (const p of rawPts) {
      const text = cleanText(p && p.text);
      if (!text) { dropped.points++; continue; }
      if (BRIEF_BANNED_RE.test(text)) { dropped.banned++; dropped.points++; continue; }
      const b = String((p && p.basis) || "");
      const basis = BRIEF_BASIS_LABEL[b] && b !== "none" ? b : "none";
      if (basis === "none") dropped.points += 0;   /* 没标依据不算「丢」，界面上要画出来 */
      if (pts.length >= MAX_POINTS_PER_SECTION) continue;
      pts.push({ text, basis, ref: cleanText(p && p.ref, 40) });
    }
    if (pts.length) sections.push({ key, points: pts });
  }

  const actions = [];
  const rawActs = Array.isArray(obj.actions) ? obj.actions : [];
  for (const a of rawActs) {
    const target = cleanText(a && a.target, 40);
    const act = cleanText(a && a.do, 30);
    if (!target || !act) { dropped.actions++; continue; }
    const why = cleanText(a && a.why);
    const cost = cleanText(a && a.cost, 80);
    if (BRIEF_BANNED_RE.test(act + why + cost)) { dropped.banned++; dropped.actions++; continue; }
    if (actions.length >= MAX_ACTIONS) continue;
    actions.push({ target, do: act, why, cost, when: cleanText(a && a.when, 24) });
  }

  const unknowns = [];
  for (const u of (Array.isArray(obj.unknowns) ? obj.unknowns : [])) {
    const t = cleanText(u, 60);
    if (t && unknowns.length < MAX_UNKNOWNS) unknowns.push(t);
  }

  /* 来源：URL + 发布日期两样齐才入账 —— 与 llm.js 第 3 条口径同义。
     缺一样就丢并计数：一条没有出处的「模型说的」不能当来源。 */
  const sources = [];
  for (const s of (Array.isArray(obj.sources) ? obj.sources : [])) {
    const url = String((s && s.url) || "").trim();
    const date = String((s && s.date) || "").trim();
    const title = cleanText(s && s.title, 60);
    const okUrl = /^https?:\/\/\S+$/i.test(url);
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
    if (!title || !okUrl || !okDate) { dropped.sources++; continue; }
    if (sources.length >= MAX_SOURCES) continue;
    sources.push({ title, url, date });
  }

  return {
    ok: true,
    brief: { verdict, confidence: conf, headline, sections, actions, unknowns, sources, promptVer: BRIEF_PROMPT_VER },
    dropped,
  };
}

/** 信心分档文案。null 返回空串 —— 界面不画那一行，而不是画「信心 —」。
    同样先判空：Number(null) === 0 会把它画成「信心 0%（低）」，那是把"没说"
    当成了"非常没把握"，两件事。 */
export function briefConfText(conf) {
  if (conf === null || conf === undefined || conf === "") return "";
  const c = Number(conf);
  if (!isFinite(c)) return "";
  const lv = c >= 0.7 ? "较高" : c >= 0.45 ? "中" : "低";
  return "信心 " + Math.round(c * 100) + "%（" + lv + "）";
}

/* ---------------- 呈现 ---------------- */

const BASK_CLASS = { ledger: "bf-b-ledger", check: "bf-b-check", market: "bf-b-market", web: "bf-b-web", none: "bf-b-none" };

/**
 * 研判卡。**所有进入 HTML 的文本都过 esc** —— 模型输出是不可信输入，
 * 它完全可能回一段带尖括号的"结论"。
 * @param {object} b normBrief 出来的 brief
 * @param {{ at?: number, atText?: string, chars?: number, tier?: string, dropped?: any, stale?: string, ms?: number }} [opts]
 */
export function briefCardHtml(b, opts) {
  const o = opts || {};
  const x = b || {};
  /* 头部刻意不再写「AI 研判」四个字：弹层标题已经写了，卡片里再写一遍就是同一句话占两行。
     这里只放「什么时候、什么档、多少字」与结论档位 —— 读者要判断的是「这份还新不新」。 */
  const meta = [o.atText || "", BRIEF_TIER_LABEL[o.tier] || BRIEF_TIER_LABEL.detail,
    o.chars ? Number(o.chars) + " 字" : "",
    /* 用时不是装饰：这一版就是被 90 秒读超时卡住的，屏幕上没有耗时，
       就只能靠猜「是慢还是没发」。落定后把实测耗时写进卡片，下一轮照它调。 */
    o.ms ? "用时 " + Math.max(1, Math.round(Number(o.ms) / 1000)) + " 秒" : ""].filter(Boolean).join(" · ");
  const head = `<div class="bf-hd"><div class="bf-hd-l"><span>${esc(meta)}</span></div>`
    + `<span class="bf-verdict bf-v-${esc(x.verdict || "watch")}">${esc(BRIEF_VERDICT_TEXT[x.verdict] || BRIEF_VERDICT_TEXT.watch)}</span></div>`;
  const line = x.headline ? `<div class="bf-line">${esc(x.headline)}</div>` : "";
  const conf = briefConfText(x.confidence);
  const confHtml = conf ? `<div class="bf-conf">${esc(conf)}</div>` : "";
  let secs = "";
  for (const s of (x.sections || [])) {
    const pts = (s.points || []).map(p => {
      const lab = BRIEF_BASIS_LABEL[p.basis] || BRIEF_BASIS_LABEL.none;
      const ref = p.ref ? `（${esc(p.ref)}）` : "";
      return `<li>${esc(p.text)}${ref}<i class="bf-b ${BASK_CLASS[p.basis] || BASK_CLASS.none}">${esc(lab)}</i></li>`;
    }).join("");
    if (!pts) continue;
    secs += `<div class="bf-sec"><h4>${esc(BRIEF_SECTION_TITLE[s.key] || s.key)}</h4><ul>${pts}</ul></div>`;
  }
  let acts = "";
  if ((x.actions || []).length) {
    acts = `<div class="bf-sec"><h4>动作</h4>` + x.actions.map(a => {
      const meta = [a.when ? "时机 " + a.when : "", a.cost ? "代价 " + a.cost : ""].filter(Boolean).join(" ｜ ");
      return `<div class="bf-act"><div class="bf-act-h"><b>${esc(a.target)}</b><span>${esc(a.do)}</span></div>`
        + (a.why ? `<p>${esc(a.why)}</p>` : "")
        + (meta ? `<div class="bf-act-m">${esc(meta)}</div>` : "") + `</div>`;
    }).join("") + `</div>`;
  } else {
    acts = `<div class="bf-sec"><h4>动作</h4><div class="bf-none">这一轮没有可执行动作 —— 不动也是一种结论。</div></div>`;
  }
  const unk = (x.unknowns || []).length
    ? `<div class="bf-unk"><b>数据缺口</b>${x.unknowns.map(u => `<span>${esc(u)}</span>`).join("")}</div>` : "";
  const src = (x.sources || []).length
    ? `<div class="bf-src"><b>来源</b>` + x.sources.map(s =>
      `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><em>${esc(s.date)}</em>`).join("") + `</div>` : "";
  const stale = o.stale ? `<div class="bf-stale">${esc(o.stale)}</div>` : "";
  const drop = o.dropped && (o.dropped.sources || o.dropped.points || o.dropped.actions)
    ? `<div class="bf-drop">校验时丢弃：${[
      o.dropped.points ? `要点 ${o.dropped.points} 条` : "",
      o.dropped.actions ? `动作 ${o.dropped.actions} 条` : "",
      o.dropped.sources ? `来源 ${o.dropped.sources} 条（缺链接或日期）` : "",
    ].filter(Boolean).join("、")}</div>` : "";
  return `<div class="bf">${head}${stale}${line}${conf}${secs}${acts}${unk}${src}${drop}
    <div class="bf-foot">${esc(BRIEF_DISCLAIMER)}</div></div>`;
}

/** 降级卡：模型没按格式回，就把原文摊开 —— 但要标明这不是结构化结论。 */
export function briefRawHtml(text, opts) {
  const o = opts || {};
  const t = String(text == null ? "" : text).trim();
  const meta = [o.atText || "", "原文 · 未按约定格式返回"].filter(Boolean).join(" · ");
  return `<div class="bf"><div class="bf-hd"><div class="bf-hd-l"><span>${esc(meta)}</span></div><span class="bf-verdict bf-v-watch">未结构化</span></div>
    <div class="bf-warn">模型没有输出约定的 JSON，下面是它的原话 —— 没有经过逐条校验，依据标记也不可用。</div>
    <pre class="bf-raw">${esc(t)}</pre>
    ${o.stale ? `<div class="bf-stale">${esc(o.stale)}</div>` : ""}
    <div class="bf-foot">${esc(BRIEF_DISCLAIMER)}</div></div>`;
}

/** 空态：还没跑过。 */
export function briefEmptyHtml(reason) {
  return `<div class="bf bf-empty"><div class="bf-hd"><div class="bf-hd-l"><span>还没生成</span></div></div>
    <div class="bf-none">${esc(reason || "点下面的按钮，把台账、体检和债市数据装配成一次请求。")}</div>
    <div class="bf-foot">${esc(BRIEF_DISCLAIMER)}</div></div>`;
}

/**
 * 研判结论 → 一段人可读的摘要，喂给「追问」的上文。
 * 为什么不直接把原始 JSON 塞进上文：追问区会把上文原样画出来（llmHistoryHtml），
 * 一段 {"verdict":"watch",...} 铺在屏幕上既难读又占半屏，而读者要的信息其实只有四五句。
 * 摘要长度上限 1200 字：够模型接得上话，又不至于把上文预算（8000 字）一口吃光。
 * @param {object} b normBrief 出来的 brief
 */
export function briefSummaryText(b) {
  const x = b || {};
  const lines = [];
  const head = BRIEF_VERDICT_TEXT[x.verdict] || "观察";
  lines.push("【上一份研判 · " + head + "】" + String(x.headline || "").trim());
  for (const s of (x.sections || [])) {
    const pts = (s.points || []).map(p => String(p.text || "").trim()).filter(Boolean).join("；");
    if (pts) lines.push((BRIEF_SECTION_TITLE[s.key] || s.key) + "：" + pts);
  }
  if ((x.actions || []).length) {
    lines.push("动作：" + x.actions.map(a =>
      a.target + " " + a.do + (a.cost ? "（" + a.cost + "）" : "")).join("；"));
  }
  if ((x.unknowns || []).length) lines.push("缺口：" + x.unknowns.join("；"));
  const out = lines.join("\n");
  return out.length > 1200 ? out.slice(0, 1200) + "…（摘要超长已截断）" : out;
}
