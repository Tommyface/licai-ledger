/* ---------- 产品底层配置与申赎规则（T1） ----------
   从 app.js 拆出来的纯函数：拆出来才能被 node --test 直接测到（同 paste.js 的做法）。

   这一层为什么值得单独建文件（而不是直接写在渲染里）：
     T7 的换仓建议要拿「最短持有期 / 赎回费分档 / 开放安排」做判定，
     而这些字段的**空值语义**是整个需求的命门 —— 铁律 7 要求「字段缺失只能输出
     『信息不足』，不许让模型补猜」。缺失判定必须只有一处实现，
     否则录入页说「有」、规则引擎说「没有」，出来的建议就没法追溯。

   ★ 三条口径（改任何一条都要同步改 tests/disc.test.mjs）：
     1. **null 就是不知道，0 就是知道且为零。** 老数据没有 disc 对象，读出来一律按
        全 null 处理；不允许用 0 或 "" 当「未填」的哨兵值，那是给 T7 埋雷。
     2. **ratePct 是百分数本身**（0.5 表示 0.5%），不是小数。算钱时是
        `金额 × ratePct / 100`。字段名带 Pct 后缀就是为了不让两处口径混起来
        （app.js 里 pct() 那张表的入参是小数，两者不是一回事）。
     3. **费率分档区间是 [from, to)** —— 含下界、不含上界，to 为 null 表示无上界。
        持有期正好等于边界时落在**下一档**（如持有满 7 天就不算 0–7 这档）。
*/

/* 来源分级（铁律 3）。只有这四档，schema 里也是这四档的 enum：
   official  = 发行机构官网 / 中国理财网信披平台的原始披露文件
   disclosure= 代销渠道（银行 App、微众/网商等）转发的产品说明页
   media     = 新闻、研报、公众号
   unknown   = 说不清出处 —— 界面必须把它显示成警示色，不能和普通字段一样呈现 */
export const DISC_TIERS = ["official", "disclosure", "media", "unknown"];

/** 全 null 骨架：老数据、新产品的初始态都从这里出发。 */
function emptyDisc() {
  return { status: "none", lockDays: null, openRule: "", feeRedeem: [], assets: [], investScope: "", source: null };
}

const isNum = v => typeof v === "number" && isFinite(v);

/** 表单里的数字 → number；空、非数、负数一律 null（负天数没有业务含义）。 */
function numOrNull(s) {
  if (s === null || s === undefined || s === "") return null;
  if (typeof s === "number") return isNum(s) && s >= 0 ? s : null;
  const t = String(s).trim().replace(/[%％,，\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return isNum(n) && n >= 0 ? n : null;
}

function str(s) { return s === null || s === undefined ? "" : String(s).trim(); }

/**
 * 解析「0-7 1.50」/「7-30 0.30」/「30 0」这类分档行。
 * 支持的分隔形态：`A-B 费率`、`A~B 费率`、`A到B 费率`、`A+ 费率`（A 起无上限）。
 * 认不出来返回 null，由调用方收集成 errors —— 静默丢行是最坏的结果，
 * 用户会以为录入了。
 */
export function parseFeeLine(line) {
  const s = str(line).replace(/\s+/g, " ");
  if (!s) return null;
  // 形如 <区间> <费率>：先切出最后一段当费率
  const sp = s.lastIndexOf(" ");
  let rangePart = s, ratePart = "";
  if (sp > 0) {
    const tail = s.slice(sp + 1);
    const t = numOrNull(tail);
    if (t !== null) { ratePart = tail; rangePart = s.slice(0, sp).trim(); }
  }
  if (!rangePart) return null;
  const rate = numOrNull(ratePart);
  if (rate === null) return null;                       // 费率缺失/非数 → 整行无效
  let from = null, to = null;
  const plus = rangePart.match(/^(\d+)\s*[+＋]$/);       // 「30+」= 30 天以上，无上限
  if (plus) { from = Number(plus[1]); to = null; }
  else {
    const m = rangePart.match(/^(\d+)\s*[-~～到至]\s*(\d+|\*|∞|以上|不受限)$/);
    if (!m) return null;
    from = Number(m[1]);
    to = /^\d+$/.test(m[2]) ? Number(m[2]) : null;
  }
  if (from === null) return null;
  if (to !== null && to <= from) return null;           // 区间倒挂是录入笔误的主要形态
  return { from, to, ratePct: rate };
}

/** 解析「名称 占比%」；名称里含空格时以最后一段数字为占比。 */
export function parseAssetLine(line) {
  const s = str(line).replace(/\s+/g, " ");
  if (!s) return null;
  const sp = s.lastIndexOf(" ");
  const tail = sp > 0 ? s.slice(sp + 1) : "";
  const p = numOrNull(tail);
  if (p === null) return { name: s, pct: null };
  const name = s.slice(0, sp).trim();
  if (!name) return null;
  if (p > 100) return null;                              // 占比超 100% 必是漏了百分号或填错
  return { name, pct: p };
}

/** 逐行解析多行文本；返回 {list, bad} —— bad 是认不出的原行，必须回显给用户。 */
function parseLines(text, one) {
  const list = [], bad = [];
  str(text).split(/\n+/).forEach(l => {
    const t = l.trim();
    if (!t) return;
    const r = one(t);
    if (r === null) bad.push(t); else list.push(r);
  });
  return { list, bad };
}

/**
 * 录入表单 → 规范化字段。vals 是 {lockDays, openRule, feeRedeem, assets, investScope}
 * 的**原始字符串**（DOM 取值），返回 {disc, errors}。
 * errors 非空时调用方不得落库：半截保存会让「有配置」的假象进 T7。
 */
export function parseDiscForm(vals) {
  const v = vals || {};
  const errors = [];
  const d = emptyDisc();

  const lock = numOrNull(v.lockDays);
  if (str(v.lockDays) && lock === null) errors.push("最短持有天数要填非负整数");
  d.lockDays = lock;
  d.openRule = str(v.openRule);
  d.investScope = str(v.investScope);

  const fees = parseLines(v.feeRedeem, parseFeeLine);
  fees.bad.forEach(b => errors.push("赎回费这一行没看懂：「" + b + "」，请用「0-7 1.50」或「30+ 0」"));
  // 分档必须首尾相接且递增，否则 T7 按持有天数取档时会撞进空洞或两档
  fees.list.sort((a, b) => a.from - b.from);
  for (let i = 1; i < fees.list.length; i++) {
    const prev = fees.list[i - 1], cur = fees.list[i];
    if (prev.to === null) { errors.push("「" + prev.from + "」这档没有上限，后面不能再有别的档"); break; }
    if (cur.from < prev.to) { errors.push("分档区间重叠：" + prev.from + "-" + prev.to + " 与 " + cur.from + "…"); break; }
    if (cur.from > prev.to) { errors.push("分档之间有空洞：" + prev.to + " 到 " + cur.from + " 天没有费率"); break; }
  }
  d.feeRedeem = fees.list;

  const as = parseLines(v.assets, parseAssetLine);
  as.bad.forEach(b => errors.push("底层配置这一行没看懂：「" + b + "」，请用「名称 占比%」"));
  d.assets = as.list;
  const sum = d.assets.reduce((s, a) => s + (a.pct === null ? 0 : a.pct), 0);
  if (d.assets.length && sum > 100.5) errors.push("底层配置占比合计 " + sum.toFixed(2) + "% 超过 100%，请核对");

  // 出处：铁律 3 —— 有内容就得说清从哪来
  const url = str(v.sourceUrl);
  if (url && !/^https?:\/\//i.test(url)) errors.push("出处链接要 http/https 完整地址");
  const tier = str(v.sourceTier) || "unknown";
  if (DISC_TIERS.indexOf(tier) < 0) errors.push("来源分级只能是 " + DISC_TIERS.join(" / "));
  const hasContent = d.lockDays !== null || d.openRule || d.investScope || d.feeRedeem.length || d.assets.length;
  if (hasContent && !url) errors.push("填了内容就要填出处链接（披露页原文地址）；找不到就别填，留成「未披露」");
  if (hasContent && (tier === "unknown" || tier === "media")) {
    errors.push("来源分级为「" + tier + "」时不许存入：底层配置与申赎规则只认官方披露或代销转发页");
  }

  const hasSrc = !!url;
  // T1 只有手工录入这一条路，所以填得出内容就是 "manual"；"auto" 留给 T1b 的自动回填，
  // 到那时这一行的判定要变成「表单来源=手工 → manual / 回填来源=检索 → auto」。
  d.status = (hasContent && hasSrc) ? "manual" : "none";
  /* 没有内容就没有出处可言：出处存在的意义是「说明这些内容从哪来」。
     留着一条空配置的出处，界面会把「只填了个链接」显示成有披露。 */
  d.source = (hasContent && hasSrc)
    ? { url, title: str(v.sourceTitle), publishedAt: str(v.sourcePublishedAt), tier } : null;
  return { disc: d, errors };
}

/**
 * 任意来源（老数据 / 云端回填 / 本地缓存）→ 规范对象。
 * 只认字段类型，不补默认值：认不出来就是 null（未知），
 * 这一条让「脏数据」在展示层自然降级成「未披露」，而不是算出一个假规则。
 */
export function normDisc(raw) {
  const d = emptyDisc();
  if (!raw || typeof raw !== "object") return d;
  d.lockDays = isNum(raw.lockDays) && raw.lockDays >= 0 ? raw.lockDays : null;
  d.openRule = str(raw.openRule);
  d.investScope = str(raw.investScope);
  d.feeRedeem = Array.isArray(raw.feeRedeem)
    ? raw.feeRedeem.filter(f => f && typeof f === "object" && isNum(f.from) && isNum(f.ratePct))
      .map(f => ({ from: f.from, to: isNum(f.to) ? f.to : null, ratePct: f.ratePct }))
    : [];
  d.assets = Array.isArray(raw.assets)
    ? raw.assets.filter(a => a && typeof a === "object" && str(a.name))
      .map(a => ({ name: str(a.name), pct: isNum(a.pct) ? a.pct : null }))
    : [];
  const s = raw.source;
  d.source = s && typeof s === "object" && /^https?:\/\//i.test(str(s.url))
    ? { url: str(s.url), title: str(s.title), publishedAt: str(s.publishedAt),
        tier: DISC_TIERS.indexOf(str(s.tier)) >= 0 ? str(s.tier) : "unknown" }
    : null;
  const hasContent = d.lockDays !== null || d.openRule || d.investScope || d.feeRedeem.length || d.assets.length;
  if (!hasContent) d.source = null;          // 与 parseDiscForm 同一条规则：无内容即无出处
  d.status = !hasContent ? "none" : (d.source ? (raw.status === "auto" ? "auto" : "manual") : "none");
  return d;
}

/** 缺失字段清单：T2/T7 用它决定「信息不足」的措辞，界面用它提示还差什么。 */
export function discGaps(d) {
  const x = normDisc(d);
  const gaps = [];
  if (x.lockDays === null) gaps.push("lockDays");
  if (!x.openRule) gaps.push("openRule");
  if (!x.feeRedeem.length) gaps.push("feeRedeem");
  if (!x.assets.length) gaps.push("assets");
  if (!x.investScope) gaps.push("investScope");
  if (!x.source) gaps.push("source");
  return gaps;
}

/**
 * 按持有天数取赎回费档（[from, to) 口径）。
 * 没录分档时返回 null —— 注意是「不知道」，绝不是 0。
 * 调用方（T7）拿到 null 只能输出「赎回费率未披露，无法算换仓成本」。
 */
export function feeRateFor(d, holdDays) {
  const x = normDisc(d);
  if (!x.feeRedeem.length || !(typeof holdDays === "number" && isFinite(holdDays) && holdDays >= 0)) return null;
  for (const f of x.feeRedeem) {
    if (holdDays >= f.from && (f.to === null || holdDays < f.to)) return f.ratePct;
  }
  return null;                                            // 落进空洞：同样按未知处理
}
