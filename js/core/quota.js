/* 额度监控 · 纯函数层（零 DOM 依赖，单测在 tests/quota.test.mjs）。
   ============================================================
   v127 阶段 1：连通性探测包（候选渠道码派生 / 探测回包整包校验 / 结果行）。
   注意它当年用 POST 探出 21400044 是「方法用错」，不是端点判死 ——
   正确形状见下方 WEBANK 段。v129 起网页层不再 import 这几个探测符号、
   独立页折叠区也已移除（结果恒「未命中」只会误导）；纯函数与 App 内
   native 探测能力留在这里由单测覆盖，未来要做真机诊断可直接复用。

   v128 正式监控（本轮重构）：数据源 = 微众银行「匿名货架」公开接口 3
     GET https://personal.webank.com/wm-htrserver/finance/product_shelf/
         query_product_by_codes_no_auth?param=<URL 编码的 JSON>
     param = {"product_codes":["CODE1","CODE2",...]}，成功码 ret_code=21400000。
   监控对象 = 「我的产品池」(台账 DATA.products 里用户自己添加的产品)，取
   prodCode 作微众货架代码；勾选子集 = cfg.watch。绝不臆造台账→渠道码映射。

   两态语义（由用户提供的两张真机截图 + 接口实测交叉钉死，2026-11-12）：
     sale_status=12 → 在售/可购买（亮橙「立即购买」可点，图二 25112035B）
     sale_status=13 → 已售罄（浅米置灰「已售罄」+「本产品当前已售罄」，图一 PNHY260395A）
     sale_status=14 / 02 等其余原值无从字典 → 一律保留原值、标「状态 X」，绝不臆造。
   参考额度 = buy_status_factor.avail_quota（元，动态；实测 PNHY260395A 几分钟内
     100000→600000）。注意 total_quota（恒定 30 亿）与 remain_quota_limit（恒定
     100 万）都是产品级限额，不是实时余额，不能拿来做告警（上一轮原型踩过这个坑）。
     avail_quota 缺失 = 「不限额度」（多数常态在售产品如此），记 null，不当 0。

   ★ 网页层不能直连微众：该接口无 CORS 头（ACAO=None，OPTIONS 也不放行），
     直读必被浏览器拦。所以抓数/判定/通知全部归 Java 前台服务（手机网络直抓），
     网页层只做：我的产品清单、勾选配置、启停、以及服务回传的最新快照展示。
   ★ 免责：额度是匿名货架参考值，≠ 登录微众 App 后个人实际可买额度。
   ============================================================ */

/* ---------- v127 阶段 1：探测包（原样保留，独立页折叠区仍用）---------- */
export const QUOTA_PROBE_MODE = "quota-probe";
export const QUOTA_CODE_MAX = 8;
export const QUOTA_WEBANK_LEN = 17;
const CODE_OK = /^[A-Za-z0-9._-]{1,48}$/;

export function quotaCandidateCodes(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return [];
  const out = [], seen = new Set();
  const push = (v) => {
    const s = String(v == null ? "" : v).trim().toUpperCase();
    if (!s || !CODE_OK.test(s) || seen.has(s)) return;
    seen.add(s); out.push(s);
  };
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

/* ============================================================
   v128 正式监控：微众匿名货架 + 我的产品池
   ============================================================ */

export const WEBANK_QUOTA_URL =
  "https://personal.webank.com/wm-htrserver/finance/product_shelf/query_product_by_codes_no_auth";
export const WEBANK_OK_CODE = "21400000";
/* 只钉两张真机截图实证的两个码，其余原值一律不做语义映射 */
export const SALE_ON = "12";   /* 在售 / 可购买 */
export const SALE_OFF = "13";  /* 已售罄 */

export const WEBANK_CODE_MAX = 100;      /* 单次 GET 携带代码上限（与 Java 侧一致） */
export const MONITOR_TRADE_SEC = 15;     /* 交易时段 09:00-17:00 轮询间隔 */
export const MONITOR_IDLE_SEC = 300;     /* 非交易时段降频（省电，不暂停） */
export const MONITOR_WATCH_MAX = 100;    /* 我的产品池关注上限 */
export const MONITOR_MIN_THRESHOLD = 1000;  /* 参考额度阈值下限（元） */
export const MONITOR_DEF_THRESHOLD = 10000; /* 默认阈值（元） */
export const MONITOR_CFG_KEY = "licai_monitor_cfg_v1";

function toMin(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm == null ? "" : hhmm));
  if (!m) return -1;
  const v = (+m[1]) * 60 + (+m[2]);
  return (+m[1] <= 23 && +m[2] <= 59) ? v : -1;
}

/** 配置归一化：watch 去重限量、阈值下限、时段/免打扰格式兜底。 */
export function normMonitorCfg(cfg) {
  const c = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  const seen = new Set(), watch = [];
  if (Array.isArray(c.watch)) {
    for (const v of c.watch) {
      const s = String(v == null ? "" : v).trim().toUpperCase();
      if (!s || !CODE_OK.test(s) || seen.has(s)) continue;
      seen.add(s); watch.push(s);
      if (watch.length >= MONITOR_WATCH_MAX) break;
    }
  }
  let threshold = Math.round(Number(c.threshold));
  if (!Number.isFinite(threshold) || threshold < MONITOR_MIN_THRESHOLD) threshold = MONITOR_DEF_THRESHOLD;
  let quietHours = String(c.quietHours == null ? "" : c.quietHours).trim();
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(quietHours) || toMin(quietHours.slice(0, 5)) < 0 || toMin(quietHours.slice(6)) < 0) {
    quietHours = "00:00-01:00";
  }
  let tradeFrom = String(c.tradeFrom == null ? "" : c.tradeFrom).trim();
  let tradeTo = String(c.tradeTo == null ? "" : c.tradeTo).trim();
  if (toMin(tradeFrom) < 0) tradeFrom = "09:00";
  if (toMin(tradeTo) < 0) tradeTo = "17:00";
  return { watch, threshold, quietHours, tradeFrom, tradeTo };
}

/** 免打扰判定，支持跨午夜（如 23:00-07:00）。 */
export function inQuiet(hhmm, quietHours) {
  const n = toMin(hhmm);
  const q = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(String(quietHours == null ? "" : quietHours));
  if (n < 0 || !q) return false;
  const a = toMin(q[1]), b = toMin(q[2]);
  if (a < 0 || b < 0) return false;
  return a <= b ? (n >= a && n < b) : (n >= a || n < b);
}

export function inTrade(hhmm, cfg) {
  const n = toMin(hhmm), c = normMonitorCfg(cfg);
  const a = toMin(c.tradeFrom), b = toMin(c.tradeTo);
  return n >= 0 && a >= 0 && b >= 0 && n >= a && n < b;
}

export function pollIntervalSec(hhmm, cfg) {
  return inTrade(hhmm, cfg) ? MONITOR_TRADE_SEC : MONITOR_IDLE_SEC;
}

/** 元 → 「元 / 万元 / 亿元」中文分档（状态行粗读用）。 */
export function fmtQuota(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n > 1e8) return (n / 1e8).toFixed(2) + "亿元";
  if (n > 1e4) return (n / 1e4).toFixed(2) + "万元";
  if (n < 100) return String(Math.round(n * 100) / 100) + "元";
  return Math.round(n) + "元";
}

/** 元 → 图三通知同款「1,100,000.00」千分位两位小数（手写，不依赖 toLocaleString 的 locale）。 */
export function fmtYuan(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0, a = Math.abs(n).toFixed(2);
  const [ip, fp] = a.split(".");
  let out = "";
  for (let i = 0; i < ip.length; i++) {
    if (i > 0 && (ip.length - i) % 3 === 0) out += ",";
    out += ip[i];
  }
  return (neg ? "-" : "") + out + "." + fp;
}

/** 我的产品池 → 微众查询 URL（GET ?param=<URL 编码 JSON>）。
 *  Java 侧用 URLEncoder.encode(json,"UTF-8").replace("+","%20")，与这里
 *  encodeURIComponent 对紧凑 JSON（无空格）完全等价 —— 实测 2026-11-12 一致。 */
export function buildWebankUrl(codes) {
  const clean = [];
  const seen = new Set();
  for (const v of (Array.isArray(codes) ? codes : [])) {
    const s = String(v == null ? "" : v).trim().toUpperCase();
    if (!s || !CODE_OK.test(s) || seen.has(s)) continue;
    seen.add(s); clean.push(s);
    if (clean.length >= WEBANK_CODE_MAX) break;
  }
  const param = JSON.stringify({ product_codes: clean });
  return WEBANK_QUOTA_URL + "?param=" + encodeURIComponent(param);
}

/** 微众接口 3 回包整包校验（v126 validateMarket 同款纪律：坏包绝不进页面）。
 *  接受 JSON 字符串或已解析对象。产出统一 snapshot，供展示与判定共用。 */
export function parseWebank(raw) {
  const bad = why => ({ ok: false, why, retCode: "", products: [] });
  let j = raw;
  if (typeof raw === "string") {
    try { j = JSON.parse(raw); } catch (e) { return bad("回包不是合法 JSON"); }
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return bad("回包不是对象");
  const rc = String(j.ret_code == null ? "" : j.ret_code);
  if (rc !== WEBANK_OK_CODE) return bad("ret_code 非成功：" + (rc || "空"));
  const rd = j.ret_data;
  if (!rd || typeof rd !== "object" || Array.isArray(rd)) return bad("缺 ret_data 对象");
  if (!Array.isArray(rd.list)) return bad("ret_data.list 不是数组");
  if (rd.list.length > WEBANK_CODE_MAX + 50) return bad("list 条数异常（>上限+50）");
  const products = [];
  for (let i = 0; i < rd.list.length; i++) {
    const d = rd.list[i];
    if (!d || typeof d !== "object" || Array.isArray(d)) return bad(`第 ${i + 1} 行不是对象`);
    const code = String(d.product_code == null ? "" : d.product_code).trim().toUpperCase();
    if (!code || !CODE_OK.test(code)) return bad(`第 ${i + 1} 行 product_code 非法`);
    const bsf = (d.buy_status_factor && typeof d.buy_status_factor === "object"
      && !Array.isArray(d.buy_status_factor)) ? d.buy_status_factor : {};
    let availQuota = null;   /* 缺失 = 不限额度 */
    if (bsf.avail_quota != null) {
      const q = Number(bsf.avail_quota);
      if (!Number.isFinite(q) || q < 0) return bad(`第 ${i + 1} 行 avail_quota 非法`);
      availQuota = q;
    }
    products.push({
      code,
      name: String(d.product_name == null ? "" : d.product_name).slice(0, 60),
      saleStatus: String(d.sale_status == null ? "" : d.sale_status),
      quotaFlag: bsf.purchase_quota_flag == null ? "" : String(bsf.purchase_quota_flag),
      availQuota,
    });
  }
  return { ok: true, why: "", retCode: rc, products };
}

/** 状态码 → 展示文本。只映射两张截图实证的 12/13，其余保留原值。 */
export function saleText(s) {
  const k = String(s == null ? "" : s);
  if (k === SALE_ON) return "在售 · 可购买";
  if (k === SALE_OFF) return "已售罄";
  return k ? "状态 " + k : "状态未知";
}

/** 「我的产品池」展示行：以台账产品为主，叠加微众快照。
 *  ledger: DATA.products（取 prodCode/name）；snapshot: parseWebank 结果或 null。 */
export function webankRows(ledger, snapshot, watch) {
  const list = Array.isArray(ledger) ? ledger : [];
  const w = new Set((Array.isArray(watch) ? watch : []).map(x => String(x).toUpperCase()));
  const byCode = {};
  if (snapshot && snapshot.ok && Array.isArray(snapshot.products)) {
    for (const p of snapshot.products) byCode[p.code] = p;
  }
  return list.map(p => {
    const code = String((p && p.prodCode) || "").trim().toUpperCase();
    const hit = byCode[code];
    const q = hit ? hit.availQuota : undefined;
    return {
      code,
      name: String((p && p.name) || code || "未命名产品"),
      hasCode: !!code,
      watched: !!code && w.has(code),
      hit: !!hit,
      saleStatus: hit ? hit.saleStatus : "",
      statusText: hit ? saleText(hit.saleStatus) : "App 内可查",
      quotaText: !hit ? "—" : (q == null ? "不限额度" : fmtYuan(q) + " 元"),
    };
  });
}

/** 图三通知文案模板（网页日志与 Java 系统通知共用同一口径）。
 *  kind: "额度" | "开售"；quota: 元或 null；iso: 东八区 ISO 时间串。 */
export function notifyBody(name, code, kind, quota, iso) {
  const head = kind === "开售" ? "已开售；" : "有参考额度；";
  const amount = quota == null ? "参考额度 不限额度" : "参考额度 " + fmtYuan(quota) + " 元";
  return `${name}（${code}）\n${head}${amount}\n检查时间：${iso}\n` +
    "匿名货架参考值，不代表个人可购买；请在微众 App核对。";
}

/** 双轨告警判定（微众口径，网页自检 / Java 前台服务同套逻辑）。
 *  snapshot: parseWebank 结果；cfg: 归一化配置；prev: {code:{saleStatus,availQuota}}
 *  （上一轮快照，首次传 null/空对象只记基线）；hhmm / iso 用于免打扰与文案。
 *  A 轨（开售跃迁）：sale_status 原值由非 12 变为 12；
 *  B 轨（额度到量边沿）：avail_quota 从 <阈值（或 0/缺失）跨到 ≥阈值；
 *  同 code 每轮最多一条；首次只记基线不推历史；免打扰只压制推送不压制状态。 */
export function webankAlerts(snapshot, cfg, prev, hhmm, iso) {
  const c = normMonitorCfg(cfg);
  const w = new Set(c.watch);
  const hasPrev = prev && typeof prev === "object" && !Array.isArray(prev)
    && Object.keys(prev).length > 0;
  const state = {};
  const out = [];
  const pushed = new Set();
  const src = (snapshot && snapshot.ok && Array.isArray(snapshot.products)) ? snapshot.products : [];
  for (const p of src) {
    if (!w.has(p.code)) continue;
    state[p.code] = { saleStatus: p.saleStatus, availQuota: p.availQuota };
    if (!hasPrev) continue;
    const old = prev[p.code] || {};
    /* A 轨：状态跃迁到在售可购买（12） */
    const becameOn = p.saleStatus === SALE_ON && old.saleStatus !== SALE_ON
      && old.saleStatus != null && old.saleStatus !== "";
    /* B 轨：参考额度跨阈值（上一轮低于阈值的数值/缺失/0 → 本轮 ≥ 阈值） */
    const wasBelow = !(Number(old.availQuota) >= c.threshold);
    const nowAbove = Number(p.availQuota) >= c.threshold;
    let kind = "", text = "", quota = p.availQuota;
    if (becameOn) {
      kind = "开售";
      text = `已开售（状态 ${old.saleStatus}→${SALE_ON}），参考额度 ${quota == null ? "不限额度" : fmtQuota(quota)}`;
    } else if (wasBelow && nowAbove) {
      kind = "额度";
      text = `有参考额度 ${fmtQuota(quota)}，已达阈值 ${fmtQuota(c.threshold)}`;
    }
    if (!kind || pushed.has(p.code)) continue;
    pushed.add(p.code);
    out.push({
      kind, code: p.code, name: p.name, text,
      time: String(iso || ""),
      body: notifyBody(p.name, p.code, kind, quota, iso),
    });
  }
  const quiet = inQuiet(hhmm == null ? "12:00" : hhmm, c.quietHours);
  return { alerts: quiet ? [] : out, suppressed: quiet ? out.length : 0, state };
}

/** Java 前台服务 status 回包整包校验（snapshot 可选）。 */
export function validateMonitorStatus(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, why: "回包不是对象" };
  if (r.ok !== true) return { ok: false, why: String(r.error || "status 未成功（ok≠true）") };
  const s = r.status;
  if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, why: "缺 status 对象" };
  if (typeof s.running !== "boolean") return { ok: false, why: "running 非布尔" };
  if (typeof s.watchCount !== "number" || !Number.isFinite(s.watchCount) || s.watchCount < 0) return { ok: false, why: "watchCount 非法" };
  return { ok: true, why: "" };
}
