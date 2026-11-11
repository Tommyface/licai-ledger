/* 额度监控（阶段 1 探测包）· 纯函数层。
   本轮只做「连通性探测」：从台账产品派生候选渠道码 → App 内手机网络直抓
   → 回报每个源的 HTTP 状态 / ret_code / 命中数 / 原始片段 / 耗时。
   不做后台常驻、不推通知（阶段 3），不做额度展示与阈值（阶段 2）。

   纯函数、零 DOM 依赖，单测在 tests/quota.test.mjs。
   ============================================================
   为什么是「候选码」：台账双键（登记编码 Z700… + 产品短码 FBAE42005P）
   与银行渠道码（微众/建行 17 位，如 FBAE32117A0000000）没有确定性转换
   规则。阶段 1 只能并列试几种形态，让真机截图回来定映射，绝不臆造。 */

export const QUOTA_PROBE_MODE = "quota-probe";
export const QUOTA_CODE_MAX = 8;          /* 单次最多试 8 个码，别打扰上游 */
export const QUOTA_WEBANK_LEN = 17;       /* 微众/建行渠道码常见长度 */
const CODE_OK = /^[A-Za-z0-9._-]{1,48}$/;

/** 从一只台账产品派生候选渠道码（去重、限量、白名单字符）。
 *  p 里认四个字段：quotaCode（未来人工固化）、prodCode、regCode、code（登记编码）。
 *  候选形态：原码大写 + 短码补 0 到 17 位（与「F+3字母+5数字+字母」同型，
 *  网站样本 FBAE32117A0000000 正是 10 位前缀 + 7 个 0）。 */
export function quotaCandidateCodes(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return [];
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v == null ? "" : v).trim().toUpperCase();
    if (!s || !CODE_OK.test(s) || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  /* 补 0 只对「渠道码字段」生效：quotaCode（人工固化）/ prodCode（产品短码）。
     regCode / code 是登记编码（Z700…），语义完全不同 —— 给它补 0 会伪装成
     渠道码，把真机探测结论带偏。这两类只收原样一个候选。 */
  const padKeys = new Set(["quotaCode", "prodCode"]);
  for (const key of ["quotaCode", "prodCode", "regCode", "code"]) {
    const s = String(p[key] == null ? "" : p[key]).trim().toUpperCase();
    if (!s || !CODE_OK.test(s)) continue;
    push(s);
    if (padKeys.has(key) && s.length >= 6 && s.length < QUOTA_WEBANK_LEN && /^[A-Z0-9]+$/.test(s)) {
      push(s.padEnd(QUOTA_WEBANK_LEN, "0"));
    }
  }
  return out.slice(0, QUOTA_CODE_MAX);
}

/** 探测回包整包校验（v126 validateMarket 同款纪律：坏包绝不进页面）。
 *  契约：{ ok:true, probe:{ codes:[...], sources:[{src,label,http,retCode,hits,rawHead,ms}], note } }
 *  src 只认 webank / ccb —— 拦住「上游换了个域名就冒充探测结果」。 */
export function validateProbe(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, why: "回包不是对象" };
  if (r.ok !== true) return { ok: false, why: String(r.error || "探测未成功（ok≠true）") };
  const b = r.probe;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, why: "缺 probe 对象" };
  if (!Array.isArray(b.codes) || b.codes.length === 0) return { ok: false, why: "缺 codes 数组" };
  if (b.codes.length > QUOTA_CODE_MAX) return { ok: false, why: "codes 超过上限" };
  if (!Array.isArray(b.sources) || b.sources.length === 0) return { ok: false, why: "缺 sources 数组" };
  if (b.sources.length > 8) return { ok: false, why: "sources 条数异常（>8）" };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, why: `第 ${i + 1} 源不是对象` };
    if (s.src !== "webank" && s.src !== "ccb") return { ok: false, why: `第 ${i + 1} 源 src 不认识：${s.src}` };
    if (typeof s.ms !== "number" || !Number.isFinite(s.ms) || s.ms < 0) return { ok: false, why: `第 ${i + 1} 源 ms 非法` };
    if (typeof s.hits !== "number" || !Number.isFinite(s.hits) || s.hits < 0) return { ok: false, why: `第 ${i + 1} 源 hits 非法` };
    if (typeof s.rawHead !== "string" || s.rawHead.length > 400) return { ok: false, why: `第 ${i + 1} 源 rawHead 超长或非字符串` };
  }
  return { ok: true, why: "" };
}

/** 把校验过的回包压成页面可显示的行（纯函数，渲染层只管 esc 拼接）。 */
export function probeRows(r) {
  const b = r && r.probe;
  if (!b || !Array.isArray(b.sources)) return [];
  return b.sources.map(s => ({
    src: s.src,
    label: String(s.label || s.src),
    text: `${s.http ? "HTTP " + s.http : "无响应"}${s.retCode ? " · ret_code " + s.retCode : ""} · ${s.hits > 0 ? "命中 " + s.hits + " 条" : "未命中产品数据"} · ${s.ms}ms`,
    raw: String(s.rawHead || "").slice(0, 200),
  }));
}
