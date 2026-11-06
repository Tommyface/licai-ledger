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

/* 登记编码形态与 Python 侧 navsources/base.is_reg_code 同一条（Z + 12~14 位数字），
   判据只在 js/core/orgs.js 写一处，这里复用。注意别跟本文件的 FEED_REG 混起来：
   FEED_REG 是「云端规则 feed 里认的那一种（Z + 13 位）」，窄一档，改它要另做判断。 */
import { isRegCode } from "./orgs.js";

/* 来源分级（铁律 3）。只有这四档，schema 里也是这四档的 enum：
   official  = 发行机构官网 / 中国理财网信披平台的原始披露文件
   disclosure= 代销渠道（银行 App、微众/网商等）转发的产品说明页
   media     = 新闻、研报、公众号
   unknown   = 说不清出处 —— 界面必须把它显示成警示色，不能和普通字段一样呈现 */
export const DISC_TIERS = ["official", "disclosure", "media", "unknown"];

/* 分级的中文名。出处分级要出现在录入表单、披露卡片和体检页三处，
   写在这里而不是各渲染文件里：同一档在三个地方叫不同名字，用户就没法对照了。 */
export const DISC_TIER_LABEL = {
  official: "发行机构官网 / 理财网信披原文",
  disclosure: "代销渠道转发页",
  media: "媒体报道",
  unknown: "出处不明"
};
/* discGaps() 返回的字段名 → 给用户看的缺项名。同一条理由只留一份。 */
export const DISC_GAP_LABEL = {
  lockDays: "最短持有 / 封闭天数", openRule: "开放赎回安排", feeRedeem: "赎回费分档",
  assets: "底层资产配置", investScope: "投资范围", source: "出处链接"
};

/** 全 null 骨架：老数据、新产品的初始态都从这里出发。 */
function emptyDisc() {
  return { status: "none", lockDays: null, openRule: "", feeRedeem: [], assets: [], investScope: "", source: null };
}

/* 除出处外至少录了一项。录入页的「未录入 / 缺出处 / 手工录入」与体检页的
   「信息不足」都判这一条，两处必须同进同退：一处算有内容、另一处算没内容，
   同一条数据在两个页面上就会一个显示成绿的一个显示成灰的。 */
/** @param {any} d normDisc() 的输出 @returns {boolean} */
export function discHasContent(d) {
  if (!d || typeof d !== "object") return false;
  return d.lockDays !== null || !!d.openRule || !!d.investScope
    || (d.feeRedeem || []).length > 0 || (d.assets || []).length > 0;
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
  const hasContent = discHasContent(d);
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
  if (s && typeof s === "object" && /^https?:\/\//i.test(str(s.url))) {
    d.source = { url: str(s.url), title: str(s.title), publishedAt: str(s.publishedAt),
      tier: DISC_TIERS.indexOf(str(s.tier)) >= 0 ? str(s.tier) : "unknown" };
    /* fetchedAt 有才带：它是自动回填那条线的凭据（我们自己的表），手工录入根本没有这一项。
       空字符串也算一个键，会让「表单录进去再过一遍 normDisc」的往返对不上（tests 盯着）。 */
    if (str(s.fetchedAt)) d.source.fetchedAt = str(s.fetchedAt);
  } else {
    d.source = null;
  }
  const hasContent = discHasContent(d);
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

/* ---------- T1b：官网产品档案 → 自动回填（v70 新增） ----------
   分工：Python 侧（navsources/rules.py）负责「读官网并封成一条有出处的记录」，
   出处不齐它就已经把内容倒空了；这一层只管「落账时不越权」——
   手工录过的字段一律不动，只补空着的，补完如实说还缺什么。

   为什么 JS 这一侧还要再判一次出处（discSourceOk）：铁律 3 的判据若只活在 Python，
   改 Python 的人不会想到页面也靠「有出处才有内容」这条不变式；
   schema 的 description 里点名的也是这个名字 —— 两侧各留一份，缺哪侧都看得见。 */

/** 合格出处：URL 与发布时间两样齐（缺一样就是说不出这条规则哪天披露的）。 */
/** @param {any} src normDisc 意义上的 source 对象 @returns {boolean} */
export function discSourceOk(src) {
  if (!src || typeof src !== "object") return false;
  return /^https?:\/\//i.test(str(src.url)) && !!str(src.publishedAt);
}

/* 自动回填能写的五项 —— 名字与 rules.py 的 GAP_FIELDS 一一对上，
   对账在 scripts/check_bridge_guard.py 第 7 项里做（对不上就报错，不许静默放行）。 */
const AUTO_FIELDS = ["lockDays", "openRule", "feeRedeem", "assets", "investScope"];

/** 某一项算不算「已经有值」：判据与 discGaps 完全一致，两处不许分叉。 */
function hasField(d, k) {
  if (k === "lockDays") return d.lockDays !== null;
  if (k === "feeRedeem") return d.feeRedeem.length > 0;
  if (k === "assets") return d.assets.length > 0;
  return !!d[k];
}

/**
 * got 是壳回包里的规则部分：{rules, source, meta, gaps, why}。
 * 只在出处合格时把**空着**的字段补上；返回 {ok, filled, kept, gaps, why} 供调用方组织文案。
 * 三条不许越界的规矩：
 *   1. 出处不合格（discSourceOk=false）→ 一条都不写，ok=false，只把缺口报出去；
 *   2. 手工已有的值一律不动（kept），哪怕官网给的数跟它不一样 ——
 *      用户手上的说明书才是准的，回填不能反过来盖掉它；
 *   3. 一项都没补上时连出处也不写：账面保持原样，别留一条「有出处没内容」的记录。
 * p.rulesAt 由调用方写（那是「试过一次」的凭据，不是披露日期，别混进 disc）。
 * @param {any} p 产品对象（就地改 p.disc / p.regCode）
 * @param {any} got 壳的规则回包
 * @returns {{ok:boolean, filled:string[], kept:string[], gaps:string[], why:string}}
 */
export function applyAutoDisc(p, got) {
  const d = normDisc(p && p.disc);
  const res = { ok: false, filled: [], kept: [], gaps: discGaps(d), why: "" };
  const src = got && got.source;
  if (!discSourceOk(src)) {
    res.why = str(got && got.why) || "官网档案里没读到披露日期：没有出处就不入账，只记缺口";
    return res;
  }
  const g = normDisc(got.rules);                 // 类型口径与手工录入共用同一套
  AUTO_FIELDS.forEach(k => {
    if (hasField(d, k)) { res.kept.push(k); return; }
    if (hasField(g, k)) { d[k] = g[k]; res.filled.push(k); }
  });
  res.ok = true;
  if (!res.filled.length) return res;            // 规矩 3：没补东西就不动账面
  if (!d.source) {
    d.source = { url: str(src.url), title: str(src.title), publishedAt: str(src.publishedAt),
      /* fetchedAt 是我们自己的表（schema 里与 publishedAt 分开的就是这两个） */
      fetchedAt: str(src.fetchedAt),
      tier: DISC_TIERS.indexOf(str(src.tier)) >= 0 ? str(src.tier) : "unknown" };
  }
  /* 状态只有三档：未录入 / 手工录入 / 检索回填。这一步必须动它，但不能乱动：
     - 原本空账 → 这一条就是机器填的，记 auto；
     - 手工录过且有出处（manual）→ 保持 manual，别把人工录的说成机器填的；
     - 有内容却没出处（normDisc 把这种脏记录判成 none）→ 这一次补上了字段、
       也挂上了官网出处，若还留着 none，卡片顶上的标签会写「未录入」，
       而下面三行明明有值 —— 同一屏同时说真话和假话。
     所以：只要不是 manual，回填成功就记 auto；哪几项是手工挡下来的，
     抓取框那句「手工录入的不覆盖（…）」会当场念出来。 */
  if (d.status !== "manual") d.status = "auto";
  p.disc = d;
  const reg = str(got.meta && got.meta.regCode);
  if (reg && !str(p.regCode) && !str(p.code)) p.regCode = reg;   // 登记编码是「拿什么去别处查」的钥匙，只在空着时补
  res.gaps = discGaps(d);
  return res;
}

/* 冷却天数：徽银要先翻页找产品（2026-11-04 实测单只 90~96 秒），
   天天跑既慢又是在替官网加负载；30 天与「说明书改版」的节奏对得上。 */
export const RULES_COOLDOWN_DAYS = 30;

/**
 * 该不该为这只产品跑一次规则回填。
 * 五种情况：五项都齐 → 不跑；30 天内试过 → 不跑；没 rulesAt / rulesAt 认不出来 /
 * rulesAt 在未来（时钟或数据倒挂）→ 都按「没试过」跑。
 * @param {any} p 产品对象 @param {number} [now] 毫秒时刻（测试传固定值）
 * @returns {boolean}
 */
export function rulesDue(p, now) {
  const need = discGaps(p && p.disc).filter(g => g !== "source");
  if (!need.length) return false;                // 只差出处不值得再跑一趟：那是手工的活
  const at = Date.parse(str(p && p.rulesAt));
  if (!isFinite(at)) return true;
  const t = isFinite(now) ? Number(now) : Date.now();
  if (at > t) return true;
  return (t - at) / 86400000 >= RULES_COOLDOWN_DAYS;
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

/* ---------- 第 4 步（v81）：云端规则 feed → 账本 ----------
   第 1~3 步把「按登记编码抓销售文件 → 抽五字段」放到了云端 CI，产物是独立的
   product-rules.json（只抓取器写、手机端从不碰）。这一层负责把它落进账本：
   **判据一行都不重写** —— 逐只产品交给已有的 applyAutoDisc()，出处合格才写、
   只补空白、手工值优先全在那一个函数里；这里只做「按登记编码配对 + 把 feed
   条目翻译成 applyAutoDisc 认得的 got 形状」，并回报统计供前台说一句话。

   纯编排：不碰网络 / 时钟 / DOM / 存储，data 与 feed 都是传进来的对象。
   rawQuote（披露原文摘录）只随返回值交给展示层，**不写进账本** ——
   账本里的 disc 一旦带上摘录，双向整文件同步就会把这段低频大文本来回搬，
   还会撑大 schema；展示层用内存态按登记编码查即可。 */

/** feed 的产品键形态，与第 1 步 schema 的 propertyNames 同一条。 */
const FEED_REG = /^Z\d{13}$/;

/** 取产品的标准登记编码：regCode 优先，老数据放在 code 里也认。两边共用这一份口径。 */
export function rulesFeedReg(p) {
  const a = str(p && p.regCode), b = str(p && p.code);
  return FEED_REG.test(a) ? a : (FEED_REG.test(b) ? b : "");
}

/**
 * 把独立 feed 落进账本（就地改 data.products[].disc）。
 * @param {any} data 账本对象
 * @param {any} feed product-rules.json 解析后的对象
 * @returns {{total:number, matched:number, filled:number, kept:number,
 *            skippedNoCode:number, skippedNoEntry:number, badSource:number,
 *            quotes:Record<string, any>}}
 */
export function applyRulesFeed(data, feed) {
  const stat = { total: 0, matched: 0, filled: 0, kept: 0,
    skippedNoCode: 0, skippedNoEntry: 0, badSource: 0,
    /** @type {Record<string, any>} */ quotes: {} };
  const products = (data && Array.isArray(data.products)) ? data.products : [];
  const entries = (feed && feed.products && typeof feed.products === "object"
    && !Array.isArray(feed.products)) ? feed.products : {};
  stat.total = products.length;
  for (const p of products) {
    if (!p || typeof p !== "object") { stat.skippedNoCode++; continue; }
    const reg = rulesFeedReg(p);
    if (!reg) { stat.skippedNoCode++; continue; }        // 无标准登记编码：抓不到销售文件
    const e = entries[reg];
    if (!e || typeof e !== "object") { stat.skippedNoEntry++; continue; }
    stat.matched++;
    /* feed 条目已是 {rules, source, rawQuote, gaps, why}；applyAutoDisc 只认
       got.rules / got.source / got.meta.regCode / got.why。原样透传，不在这里
       另立空值语义、不自己拼 disc 对象、不判 status。 */
    const got = { rules: e.rules, source: e.source,
      meta: { regCode: e.regCode || reg }, why: e.why };
    const res = applyAutoDisc(p, got);
    if (!res.ok) { stat.badSource++; continue; }        // 出处不齐：一条都不写
    stat.filled += res.filled.length;
    stat.kept += res.kept.length;
    if (e.rawQuote && typeof e.rawQuote === "object" && Object.keys(e.rawQuote).length)
      stat.quotes[reg] = e.rawQuote;                     // 只给展示层，不进 DATA
  }
  return stat;
}

/* ---------- 队列 Q5（v83）：多份 feed 按优先级落账 ----------
   云端现在写两份同形状的 feed：主源（中国理财网信披平台）产
   product-rules.json，第二源（发行机构官网说明书下载口）产
   official-rules.json。这里的「优先级」不是新判据，而是应用顺序：
   前面的源先落，后面的源只能补前面没补上的空白 —— 因为 applyAutoDisc
   本来就写着「已有值不覆盖、手工值优先」，两份 feed 走的是同一条入口，
   一行判据都不重写（重写就会分叉，这是本项目反复犯过的错）。
   摘录（rawQuote）按同一优先级：同一个登记编码，先到的那份说了算。
   某一份读不到（404 / 坏 JSON / 没网 / 旧壳）只是那一份不参与，
   绝不许把整次同步说成失败。

   @param {any} data 账本对象 @param {Array<{name?:string, feed:any}>} feeds 按优先级从高到低
   @returns {{applied:string[], total:number, matched:number, filled:number, kept:number,
             skippedNoCode:number, skippedNoEntry:number, badSource:number,
             quotes:Record<string, any>, per:Array<{name:string, stat:any}>}} */
export function applyRulesFeeds(data, feeds) {
  const out = { applied: [], total: 0, matched: 0, filled: 0, kept: 0,
    skippedNoCode: 0, skippedNoEntry: 0, badSource: 0, quotes: {}, per: [] };
  const products = (data && Array.isArray(data.products)) ? data.products : [];
  out.total = products.length;
  for (const item of Array.isArray(feeds) ? feeds : []) {
    if (!item || !item.feed) continue;                  // 这份没读到：不参与，不报错
    const stat = applyRulesFeed(data, item.feed);
    const name = String(item.name || "");
    out.applied.push(name);
    out.per.push({ name, stat });
    out.matched += stat.matched;
    out.filled += stat.filled;
    out.kept += stat.kept;
    out.skippedNoCode += stat.skippedNoCode;
    out.skippedNoEntry += stat.skippedNoEntry;
    out.badSource += stat.badSource;
    for (const reg of Object.keys(stat.quotes)) {
      if (!out.quotes[reg]) out.quotes[reg] = stat.quotes[reg];   // 先来的源优先
    }
  }
  return out;
}


/* ---------- v85：登记编码自动补齐 ----------
   用户提的需求是「后续添加产品时自动补齐登记编码」。这一层的判据只有三条，
   全部与既有铁律同源：手工值优先（填过就一个字都不改）、唯一命中才写
   （多义 ⇒ 保持空并把候选交出去，「null 是不知道，0 是知道且为零」）、
   试过要盖章（`regCodeAt`，否则每次同步都替披露源加负载）。
   写进 `code` 而不是新字段：App 的「登记编码」栏就是 `code` 字段
   （产品列表与详情页都显示 `登记编码 ${p.code}`），另起一处等于造出
   第二个要同步改的地方，读的时候 `regCode` 还会盖住它。 */

/** 冷却天数：编码不像净值那样天天变，但用户改了名称/代码以后值得再问一次。 */
export const REGCODE_COOLDOWN_DAYS = 7;

/** 登记编码那一栏此刻的值（`regCode` 是读侧别名，`code` 是 App 写的那一栏）。
    形态对不对都算「有值」：自动补齐只看栏里空不空，判错纠正该由人来。 */
function regField(p) { return str(p && p.regCode) || str(p && p.code); }

/**
 * 该不该为这只产品反查一次登记编码。
 * @param {any} p 产品对象
 * @param {number} [now] 毫秒时刻（测试传固定值）
 * @returns {boolean}
 */
export function regCodeDue(p, now) {
  if (regField(p)) return false;                   // 手工值优先：栏里有值就不问（含填错的）
  const at = Date.parse(str(p && p.regCodeAt));
  if (!isFinite(at)) return true;                  // 没盖过章 ⇒ 没试过
  const t = isFinite(now) ? Number(now) : Date.now();
  if (at > t) return true;                         // 时钟或数据倒挂 ⇒ 按没试过
  return (t - at) / 86400000 >= REGCODE_COOLDOWN_DAYS;
}

/**
 * 把反查结果落进账本（就地改 `p.code`），并如实回答改没改、为什么没改。
 *
 * @param {any} p 产品对象
 * @param {{regCode?:string, candidates?:string[], error?:string}|null} got 桥的回包
 * @returns {{changed:boolean, wrote?:string, why:string}}
 */
export function applyRegCode(p, got) {
  if (!p) return { changed: false, why: "没有这款产品" };
  /* 这一栏有没有值（形态对不对都算有值）：有值就不再自动补。
     「手工值优先」在这里比形态校验更硬 —— 哪怕用户填的是一串产品代码，
     自动补齐也不许悄悄改写他敲进去的东西：那一栏是登记编码的唯一入口，
     盖掉之后错了连找回的地方都没有；该说的是「这里要人看一眼」。 */
  const had = regField(p);
  if (had) {
    if (isRegCode(had)) return { changed: false, why: "登记编码已有值（手工值优先，不覆盖）" };
    return { changed: false, why: `登记编码栏里已有值「${had}」，不是登记编码的形态（应为 Z + 12~14 位数字）：我没有改它，请手工核对后填写` };
  }
  const cands = (got && Array.isArray(got.candidates))
    ? got.candidates.map(c => str(c).toUpperCase()).filter(Boolean) : [];
  const one = str(got && got.regCode).toUpperCase();
  if (cands.length > 1) {
    return { changed: false, why: `理财网里这个名字对应多个登记编码（${cands.join("、")}），认不准就不写` };
  }
  if (!one) return { changed: false, why: str(got && got.error) || "反查没有拿到登记编码" };
  if (!isRegCode(one)) {
    return { changed: false, why: `拿到的编码形态不对（应为 Z + 12~14 位数字）：${one}` };
  }
  p.code = one;
  return { changed: true, wrote: one, why: `已补齐登记编码 ${one}（下一次抓取就能按编码查披露）` };
}

/* ============================================================================
   资产净值（产品规模）—— 2026-11-06 所有者提的「每只产品新增一个字段，抓取内容补充」。

   判据与私有仓 navsources/merge.py 的 apply_asset_value **同构**（JS 一份、Python 一份，
   改一边必须改另一边；两边规则一致才不会「手机写的和云端写的互相顶」）。四条：
     ① 手工值优先：用户填过（manual）就再也不动，连「为什么没写」的记录都不许顶掉它；
     ② 披露日新者胜、同日不重刷：写入的形状里**没有抓取时刻**，否则每天 3 跑
        都会「内容变了」⇒ 刷一堆无意义的数据提交（与 regHints 同一策略）；
     ③ null 是不知道、0 是知道且为零：0/负数/NaN/非数都不算值，
        某次没披露也**绝不清空**已经写过的值；
     ④ 没写入时把「为什么空着」记进同一格（why），别让人对着空格猜功能跑没跑。

   ⚠️ 这个字段是钱，所以它只许出现在**数据展示**的位置，不许进任何结论文本
   （持仓体检/换仓建议的 verdictText 里没有钱，v74/v75 立的口径）。
   ========================================================================== */

/** 这一折记录里的 v 是不是一个可用的规模数（>0 的有限数）。 */
function isAssetNum(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** 统一读法：全站只从这里读规模，别处不许再摸 p.assetValue.v（口径与 regCodeOf 同一条）。 */
export function assetValueOf(p) {
  const av = p && p.assetValue;
  return av && typeof av === "object" && !Array.isArray(av) ? av : null;
}

/**
 * 把抓取到的一折规模落进产品对象（就地改），并如实回答改没改、为什么没改。
 *
 * @param {any} p 产品对象
 * @param {{v?:number, date?:string, sub?:string, via?:string, why?:string}|null} rec 桥/云端的一折记录
 * @returns {{changed:boolean, why:string}}
 */
export function applyAssetValue(p, rec) {
  if (!p || typeof p !== "object") return { changed: false, why: "没有这款产品" };
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { changed: false, why: "" };
  const cur = (p.assetValue && typeof p.assetValue === "object") ? p.assetValue : {};

  if (cur.manual) return { changed: false, why: "规模已有手工值（手工值优先，不覆盖）" };

  if (isAssetNum(rec.v)) {
    const nd = str(rec.date);
    if (isAssetNum(cur.v) && str(cur.date) >= nd) return { changed: false, why: "" };
    p.assetValue = { v: Number(rec.v), date: nd, sub: str(rec.sub), via: str(rec.via) };
    return { changed: true, why: `已补齐资产净值（披露日 ${nd || "-"}）` };
  }

  /* 这一折没有值：已有值 ⇒ 保持（null 是不知道，不是「规模没了」）；
     没有值 ⇒ 只有带着理由才记，连理由都没有就当没这回事。 */
  if (isAssetNum(cur.v)) return { changed: false, why: "" };
  const why = str(rec.why).trim();
  if (!why) return { changed: false, why: "" };
  if (cur.why === why && str(cur.date) === str(rec.date)
      && str(cur.sub) === str(rec.sub) && "v" in cur && cur.v === null) {
    return { changed: false, why: "" };          // 同一条理由已经在册 ⇒ 不重刷
  }
  p.assetValue = { v: null, date: str(rec.date), sub: str(rec.sub), via: str(rec.via), why };
  return { changed: true, why };
}

/** 出处标签：铁律 #3 —— 值后面必须跟着它从哪来。 */
function assetViaLabel(av) {
  if (av.manual) return "手工";
  const via = str(av.via);
  if (!via) return "未知";
  return via === "chinawealth" ? "中国理财网" : via;
}

/**
 * 展示串（唯一一份）：≥1 亿说亿、不足 1 亿说万元，一律带披露日与出处。
 * 没有这一折 ⇒ 空串（调用处自己决定「不显示这一行」），**绝不显示 0 元**。
 */
export function assetValueText(p) {
  const av = assetValueOf(p);
  if (!av) return "";
  if (!isAssetNum(av.v)) return str(av.why) || "还不知道（这一格没写入）";
  const x = Number(av.v);
  const amount = x >= 1e8 ? (x / 1e8).toFixed(2) + " 亿元" : (x / 1e4).toFixed(2) + " 万元";
  const bits = [];
  if (av.date) bits.push("披露日 " + str(av.date));
  bits.push("来源：" + assetViaLabel(av));
  return `${amount}（${bits.join("，")}）`;
}

/**
 * 表单里那一栏「资产净值（元）」的落账判据（手工值优先的另一半）。
 *
 * 只收**元**为单位的正数，带「亿」「万」的一律拒收 —— 单位靠猜就会差四个数量级，
 * 而这一格是给人看规模的，错比空着更糟。清空输入框**只撤手工那一折**：
 * 云端/本机抓取写进来的那折不是用户手工填的，不能因为表单里没字就抹掉。
 */
export function setManualAssetValue(p, text) {
  if (!p || typeof p !== "object") return { changed: false, why: "没有这款产品" };
  const raw = str(text).replace(/[,\s]/g, "");
  const cur = (p.assetValue && typeof p.assetValue === "object") ? p.assetValue : {};
  if (!raw) {
    if (!cur.manual) return { changed: false, why: "" };   // 不是手工的 ⇒ 不动它
    delete p.assetValue;
    return { changed: true, why: "已清空手工填写的规模，下一轮抓取会按披露重新补" };
  }
  if (/亿|万|[a-zA-Z]/.test(raw)) {
    return { changed: false, why: "这一栏只收以「元」为单位的数字（例如 2962513986.74），带亿/万的不猜单位" };
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    return { changed: false, why: "规模要填正的元数额（例如 2962513986.74）；0 与负数都不算" };
  }
  p.assetValue = { v, date: str(cur.date), sub: str(cur.sub), via: "手工", manual: true };
  return { changed: true, why: "已记录手工填写的规模（抓取不再覆盖它）" };
}
