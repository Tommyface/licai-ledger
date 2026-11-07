/* ============================================================
   v97 · 微众稳健货架「动态字段显示」判据（纯函数，无 DOM / 无网络）

   与 v95 nav.js / v96 disc.js:fieldCoverage 同一纪律：
     · 判断只留这一处 —— app.js 只渲染，不另写一套「有没有值」的逻辑；
     · 空值语义「不知道 ≠ 0」：缺字段 / 占位值一律不生成展示行，
       也不冒充「未披露」以外的任何结论；
     · 只认代码命中（规范化 prodCode ∈ 静态索引），不用产品名、
       不用 manager 字符串去猜 —— 与 detectOrg（发行方识别）解耦，
       代销渠道不影响机构识别，反之亦然；
     · 枚举码（thi_class / fund_pattern / risk_level / stb_fin_zone …）
       服务端未提供字典表，一律保留原始码并标注「源字段」，绝不臆造中文语义。

   数据从 js/core/webank-shelf.js 顶层 import（同步、离线可用）。
   ============================================================ */

/** @typedef {{name:string, via:string}} AgentBank */

/* ---------- 字段字典：静态索引扁平 key → 展示定义 ----------
   grp 分组；label 中文名；kind 决定渲染方式（text/code/list/tags/date）；
   src 出处标注（每个展示项都带，链接式核对清单里可逐项复验）；
   money 金额类：渲染层必须走 shown()（app_core.test.mjs 源码级门禁盯着）。 */
export const WEBANK_FIELDS = [
  // 身份
  { k: "product_name", label: "货架产品名", grp: "身份", src: "微众货架" },
  { k: "bank_name", label: "发行方（工商全称）", grp: "身份", src: "微众货架·extra_info" },
  { k: "bank_short_name", label: "发行方简称", grp: "身份", src: "微众货架·extra_info" },
  { k: "ta_code", label: "TA 代码", grp: "身份", src: "微众货架", kind: "code" },
  { k: "establish_date", label: "成立日", grp: "身份", src: "微众货架", kind: "date" },
  { k: "risk_level", label: "风险等级码", grp: "风险", src: "微众货架·risk_level（枚举字典未提供）", kind: "code" },
  // 分类
  { k: "thi_class", label: "稳健形态码", grp: "分类", src: "微众货架·thi_class（枚举字典未提供）", kind: "code" },
  { k: "fund_pattern", label: "运作形态码", grp: "分类", src: "微众货架·fund_pattern（枚举字典未提供）", kind: "code" },
  { k: "fund_type", label: "产品类型码", grp: "分类", src: "微众货架·fund_type（枚举字典未提供）", kind: "code" },
  { k: "stb_fin_zone", label: "稳健专区域", grp: "分类", src: "微众货架·stb_fin_zone（枚举字典未提供）", kind: "code" },
  { k: "steady_finance", label: "稳健货架", grp: "分类", src: "微众货架·steadyFinance", kind: "bool" },
  // 持有期
  { k: "product_period", label: "产品期限", grp: "持有期", src: "微众货架" },
  { k: "trd_product_period", label: "交易周期说明", grp: "持有期", src: "微众货架" },
  { k: "days_of_product_period", label: "期限天数", grp: "持有期", src: "微众货架", kind: "num" },
  { k: "redeem_days_desc", label: "赎回到账", grp: "持有期", src: "微众货架" },
  // 交易规则
  { k: "start_buy_min", label: "起购金额", grp: "交易规则", src: "微众货架·start_buy_amount", kind: "num", money: true },
  { k: "min_amount_desc", label: "起购说明", grp: "交易规则", src: "微众货架·extra_info", money: true },
  { k: "quota_flag", label: "额度标志", grp: "交易规则", src: "微众货架·buy_status_factor", kind: "code" },
  { k: "hold_rate_desc", label: "业绩展示口径", grp: "业绩口径", src: "微众货架·extra_info" },
  { k: "rate_desc", label: "收益率口径", grp: "业绩口径", src: "微众货架·extra_info" },
  { k: "marketing_tag", label: "营销标签", grp: "分类", src: "微众货架·extra_info", kind: "tags" },
  // 固收+ 增强策略（仅 108 只有，缺字段自然不渲染）
  { k: "fix_plus_prod_flag", label: "固收+ 标识", grp: "增强策略", src: "微众货架·fix_plus_prod_flag", kind: "code" },
  { k: "fix_plus_ivt_tag", label: "增强策略", grp: "增强策略", src: "微众货架·fix_plus_ivt_tag" },
  { k: "fix_plus_ivt_pri_class", label: "策略一级类", grp: "增强策略", src: "微众货架（枚举字典未提供）", kind: "code" },
  { k: "fix_plus_ivt_sec_class", label: "策略二级类", grp: "增强策略", src: "微众货架（枚举字典未提供）", kind: "code" },
  { k: "fix_plus_equity_ratio", label: "权益比例", grp: "增强策略", src: "微众货架·fix_plus_equity_ratio", kind: "num" },
  { k: "fix_plus_equity_ratio_tag", label: "权益上限", grp: "增强策略", src: "微众货架·fix_plus_equity_ratio_tag" },
  { k: "fix_plus_core_ratio", label: "增强资产占比", grp: "增强策略", src: "微众货架·fix_plus_core_ratio", kind: "num" },
  { k: "fix_plus_core_ratio_tag", label: "增强资产占比说明", grp: "增强策略", src: "微众货架·fix_plus_core_ratio_tag" },
  { k: "fix_plus_asset_class_tag_list", label: "增强资产类别", grp: "增强策略", src: "微众货架·fix_plus_asset_class_tag_list", kind: "tags" },
  { k: "maximum_drawdown", label: "最大回撤", grp: "风险", src: "微众货架·maximum_drawdown", kind: "num" },
  { k: "maximum_drawdown_desc", label: "最大回撤说明", grp: "风险", src: "微众货架" },
  { k: "maximum_drawdown_type", label: "回撤区间", grp: "风险", src: "微众货架（枚举字典未提供）", kind: "code" },
  { k: "fix_plus_volatility_zone", label: "波动分区", grp: "风险", src: "微众货架（枚举字典未提供）", kind: "code" },
  // 活期+Plus 内层（26 只）
  { k: "plus_period", label: "Plus 持有说明", grp: "分类", src: "微众货架·plus_copy" },
  { k: "plus_days", label: "Plus 期限天数", grp: "分类", src: "微众货架·plus_copy", kind: "num" },
];

/** 分组顺序（渲染层按此排布，判断只此一处） */
export const WEBANK_GROUPS = ["身份", "分类", "风险", "持有期", "业绩口径", "交易规则", "增强策略"];

/* ---------- 占位值：与生成脚本 has() 同口径 ---------- */
const PLACEHOLDER = new Set(["", "--", "-", "0.0000", "0.00", "null", "undefined"]);
/** 是否算「有值」——不知道≠0。0 / false 是有效值，占位串不是。 */
export function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "" && !PLACEHOLDER.has(v.trim());
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;                                     // number / boolean（含 0、false）
}

/** 代码规范化：与 P0 第二路证「仅按销售代码唯一定位」同纪律 */
export function normCode(code) {
  return String(code == null ? "" : code).trim().toUpperCase();
}

/**
 * 命中判定：规范化代码 ∈ 静态索引才认。绝不用产品名 / manager 去猜。
 * @param {any} shelf 静态索引（{meta, byCode}）
 * @param {any} code  产品代码
 * @returns {{hit:boolean, code:string, rec:any|null}}
 */
export function matchShelf(shelf, code) {
  const c = normCode(code);
  const by = shelf && shelf.byCode;
  const rec = c && by && Object.prototype.hasOwnProperty.call(by, c) ? by[c] : null;
  return { hit: !!rec, code: c, rec };
}

/**
 * 产品线判定（三选一，互斥，交集为 0 —— 前几轮实测 26 / 108 / 325）。
 * 只用服务端字段是否存在作判据，标注字段名，不冒充 App 官方产品名。
 * @returns {{key:string, label:string, src:string}|null}
 */
export function shelfClass(rec) {
  if (!rec) return null;
  if (rec.plus_flag) return { key: "plus", label: "活期+Plus（plus_copy 特征）", src: "微众货架·plus_copy" };
  if (String(rec.fix_plus_prod_flag) === "1") return { key: "fixplus", label: "固收+（fix_plus_prod_flag）", src: "微众货架·fix_plus_prod_flag" };
  return { key: "steady", label: "普通稳健", src: "微众货架·steadyFinance=true" };
}

/**
 * 分类标签行（参考净值瞭望详情页 .tags 的形态，但各自带出处、不臆造映射）。
 * @returns {Array<{text:string, src:string}>}
 */
export function shelfTags(rec) {
  if (!rec) return [];
  const out = [];
  const cls = shelfClass(rec);
  if (cls) out.push({ text: cls.label, src: cls.src });
  if (hasValue(rec.bank_short_name)) out.push({ text: String(rec.bank_short_name), src: "微众货架·extra_info" });
  if (hasValue(rec.product_period)) out.push({ text: String(rec.product_period), src: "微众货架·product_period" });
  else if (hasValue(rec.trd_product_period)) out.push({ text: String(rec.trd_product_period), src: "微众货架·trd_product_period" });
  if (hasValue(rec.risk_level)) out.push({ text: `风险码 ${rec.risk_level}`, src: "微众货架·risk_level（枚举字典未提供）" });
  if (hasValue(rec.establish_date)) out.push({ text: `${rec.establish_date} 成立`, src: "微众货架·establish_date" });
  return out;
}

/**
 * 代销银行归并：静态索引里已带出处的 {name, via}[]，按银行名去重、保序。
 *
 * v98 · 口径不丢：同一家银行若同时被「列表行」与「详情页」两种口径证实，
 * 旧版只留第一个 via（seen.has(name) 直接 continue），等于悄悄丢掉一份证据。
 * 现在把该银行的全部出处收进 vias[]，并把短标签 tags[] 一并算好，
 * 渲染层据此分别标注两种口径、不混用（详情页是主渠道/直销说明，
 * 列表行才是全部代销 —— 这是两个不同语义，不能拼成一句话）。
 *
 * 兼容：静态索引老结构 {name, via} 仍正常工作（vias 由单值派生）。
 * 没有代销证据 → 返回空数组（调用方据此显示「未披露代销渠道」，绝不臆造）。
 * @returns {Array<{name:string, via:string, vias:string[], tags:string[]}>}
 */
export function agentBanks(rec) {
  const list = rec && Array.isArray(rec.agents) ? rec.agents : [];
  const byName = new Map();
  for (const a of list) {
    const name = a && typeof a.name === "string" ? a.name.trim() : "";
    if (!name) continue;
    // 新结构可能带 vias[]（同名多口径），老结构只有单个 via
    const rawVias = a && Array.isArray(a.vias) ? a.vias : [a && typeof a.via === "string" ? a.via : "净值瞭望"];
    if (!byName.has(name)) byName.set(name, { name, vias: [] });
    const vias = byName.get(name).vias;
    for (const v of rawVias) {
      const s = typeof v === "string" && v.trim() ? v.trim() : "净值瞭望";
      if (!vias.includes(s)) vias.push(s);               // 同名合并，不丢口径
    }
  }
  return [...byName.values()].map(b => ({
    name: b.name,
    via: b.vias[0],                                       // 兼容旧消费方
    vias: b.vias.slice(),
    tags: b.vias.map(agentViaTag),
  }));
}

/** 出处短标签：仅去公共前缀，不改语义；判断收口在此，渲染层只 esc 输出 */
export function agentViaTag(via) {
  const s = String(via == null ? "" : via);
  return s.startsWith("净值瞭望") ? s.slice("净值瞭望".length) || s : s;
}

/** 是否有代销证据（「若有代销银行」的那道闸） */
export function hasAgents(rec) {
  return agentBanks(rec).length > 0;
}

/**
 * 可渲染字段：遍历字典，只返回「该产品真正有值」的字段。
 * 缺字段 / 占位值不生成占位行 —— 这正是「按能匹配到的字段动态显示」：
 * 普通稳健不出现增强策略，固收+ 才出现 13 项，Plus 才出现内层两项。
 * @returns {Array<{k:string,label:string,grp:string,src:string,kind:string,money:boolean,value:any}>}
 */
export function renderableFields(rec) {
  if (!rec) return [];
  const out = [];
  for (const f of WEBANK_FIELDS) {
    const v = rec[f.k];
    if (!hasValue(v)) continue;
    out.push({
      k: f.k, label: f.label, grp: f.grp, src: f.src,
      kind: f.kind || "text", money: !!f.money, value: v,
    });
  }
  return out;
}

/** 按分组归拢（渲染层直接遍历，顺序由 WEBANK_GROUPS 定） */
export function groupedFields(rec) {
  const items = renderableFields(rec);
  const groups = [];
  for (const g of WEBANK_GROUPS) {
    const rows = items.filter(x => x.grp === g);
    if (rows.length) groups.push({ grp: g, rows });
  }
  return groups;
}

/** 快照元信息（UI 页脚标注日期，避免把冻结数据当实时） */
export function shelfMeta(shelf) {
  const m = (shelf && shelf.meta) || {};
  return {
    captured_at: m.captured_at || "未知",
    shelf_rows: Number(m.shelf_rows) || 0,
    agents_rows: Number(m.agents_rows) || 0,
    source_we: m.source_we || "",
    source_agents: m.source_agents || "",
    note: m.note || "",
  };
}

/* ---------- v98 · 快照新鲜度（判断收口在此，UI 与 CI 软哨兵共用） ----------
   静态索引是「慢变字段快照」，会漂移。旧版只在页脚写死一个日期，
   既不判断过期、也没有重跑后日期会更新的机制（生成脚本里 captured_at
   是硬编码字符串，重跑永远显示 2026-11-07 → 永远"新鲜"，这是真漏洞）。
   这里给出唯一判据：按自然日算天数，分三档；UI 显示徽标 + 过期引导，
   CI 软哨兵只提示不阻断（退出码恒 0，不制造假红）。 */
export const SHELF_FRESH_DAYS = 30;    // ≤30 天：新鲜
export const SHELF_STALE_DAYS = 90;    // >90 天：过期（阈值是估算值，见实施报告）

/**
 * @param {any} shelf 静态索引
 * @param {Date|string|number} [now] 注入当前时间，便于测试确定性；缺省 new Date()
 * @returns {{level:"fresh"|"aging"|"stale"|"unknown", days:number|null,
 *            captured_at:string, label:string, hint:string, stale:boolean}}
 */
export function shelfFreshness(shelf, now) {
  const captured = shelfMeta(shelf).captured_at;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(captured));
  if (!m) {
    return { level: "unknown", days: null, captured_at: captured,
      label: "快照日期缺失", hint: "无法确定快照日期，请重跑生成脚本补齐 captured_at。", stale: true };
  }
  const capDay = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = now instanceof Date ? now : (now == null ? new Date() : new Date(now));
  if (isNaN(d.getTime())) {
    return { level: "unknown", days: null, captured_at: captured,
      label: "快照日期无法校验", hint: "时间参数无效，不臆测新鲜度。", stale: true };
  }
  const curDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.max(0, Math.floor((curDay - capDay) / 86400000));  // 未来日期钳到 0，不误报
  if (days <= SHELF_FRESH_DAYS) {
    return { level: "fresh", days, captured_at: captured,
      label: `快照新鲜（${days} 天前）`, hint: "", stale: false };
  }
  if (days <= SHELF_STALE_DAYS) {
    return { level: "aging", days, captured_at: captured,
      label: `快照 ${days} 天前`, hint: "慢变字段可能已漂移，建议重跑生成脚本更新。", stale: false };
  }
  return { level: "stale", days, captured_at: captured,
    label: `快照已过期（${days} 天前）`,
    hint: "该快照超过 90 天，分类/代销等慢变字段可能已变化，请重跑 scripts/gen-webank-shelf.mjs 并随版本推送。",
    stale: true };
}
