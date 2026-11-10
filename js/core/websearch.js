/**
 * js/core/websearch.js · S2 讯飞 MaaS 联网检索判据（纯函数，不发起请求）
 *
 * ★ 本模块不联网。网页端受 CORS 限制不能直连 MaaS（POST 且无 Access-Control-Allow-Origin），
 *   请求只由 APK 内 LlmBridge 发出；网页端拿到的只是桥回传的响应原文，用本模块判据解析。
 *
 * 实测依据（2026-11-10，https://maas-api.cn-huabei-1.xf-yun.com/v1/responses，
 *           model=spark-x2.6-4b，7 组打靶）：
 *  · Responses 形制成立：{model,input,instructions,stream:false} →
 *    output[] 含 reasoning / message，另有 output_text、usage（含 reasoning_tokens）。
 *  · 唯一有效的联网开关：tools:[{"type":"web_search"}]。
 *    命中的那一发 output[] 里出现 {type:"web_search_call",status:"completed",
 *    action:{queries:[…],query:"…",type:"search"}}，usage.input_tokens 涨到 8604。
 *  · {"type":"web_search_preview"}（OpenAI 官方写法）→ 400 invalid_prompt，网关不认。
 *  · 顶层 web_search / enable_search:true → 200 但被静默忽略，模型自述「无法联网」。
 *  · 私有嵌套 {"type":"web_search","web_search":{...}} → 200、顶层带 tools，
 *    却没有任何 web_search_call，还给出与真实检索冲突的数值（1.35% vs 1.60%）——幻觉。
 *  · 所有响应都没有结构化 annotations / citations；来源只可能出现在正文文本里。
 *
 * 结论收口成一条判据：只有 output[] 里存在 web_search_call 且 status==="completed"，
 * 才算「本轮真联网」。200、tools 字段、正文里写了「据财政部」都不算。
 * 判为未联网时，正文只作待核线索、不进事实层、不进数字白名单（与 news.json 同一纪律）。
 */

export const XF_DEFAULT_BASE = "https://maas-api.cn-huabei-1.xf-yun.com/v1";
export const XF_MODEL = "spark-x2.6-4b";
export const SEARCH_TOOL = Object.freeze({ type: "web_search" });
export const XF_NO_CITATIONS = "网关不返回结构化引用；正文里的来源声明需逐条链接回源核对";
export const XF_UNGROUNDED = "未检测到检索动作，本轮按「未联网」处理，正文不可作事实依据";
export const XF_CLUE_SOURCE = "讯飞联网检索（待核）";
export const XF_MAX_URLS = 20;

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 端点归一：只认 https；填到 /v1 就补 /responses，切形制时把残留段换掉。 */
export function xfEndpoint(baseUrl) {
  let b = String(baseUrl == null || baseUrl === "" ? XF_DEFAULT_BASE : baseUrl).trim();
  if (!/^https:\/\//i.test(b)) return "";
  b = b.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(b)) return b.replace(/\/chat\/completions$/i, "/responses");
  if (/\/responses$/i.test(b)) return b;
  return b + "/responses";
}

/**
 * 构造请求体。工具名只有 web_search 一种 —— 实测 web_search_preview 是 400，
 * 私有嵌套是「200 但没检索」的幻觉，两者都不许从这里发出去。
 */
export function xfBody({ input = "", instructions = "", model = XF_MODEL, search = true } = {}) {
  const body = { model: String(model || XF_MODEL), input: String(input || ""), stream: false };
  if (instructions) body.instructions = String(instructions);
  if (search) body.tools = [Object.assign({}, SEARCH_TOOL)];
  return body;
}

/** 从 output[] 抽 message 正文（output_text 缺省时的兜底）。 */
export function xfTextOf(obj) {
  const arr = obj && Array.isArray(obj.output) ? obj.output : [];
  const parts = [];
  for (const it of arr) {
    if (!it || typeof it !== "object" || it.type !== "message") continue;
    const c = it.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const x of c) if (x && typeof x.text === "string") parts.push(x.text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * 核心判据：本轮是否「真联网」。
 * 严格口径 —— 至少一次 web_search_call，且每一次都 completed；
 * 有一次失败就按未联网处理，不赌「部分成功」。
 */
export function xfGrounding(obj) {
  const out = {
    grounded: false, calls: [], queries: [], note: XF_UNGROUNDED, noCitations: true,
  };
  const arr = obj && Array.isArray(obj.output) ? obj.output : [];
  for (const it of arr) {
    if (!it || typeof it !== "object" || it.type !== "web_search_call") continue;
    const a = (it.action && typeof it.action === "object") ? it.action : {};
    const qs = Array.isArray(a.queries)
      ? a.queries.filter(q => typeof q === "string" && q.trim())
      : (typeof a.query === "string" && a.query.trim() ? [a.query] : []);
    out.calls.push({ id: String(it.id || ""), status: String(it.status || ""), queries: qs });
    for (const q of qs) if (!out.queries.includes(q)) out.queries.push(q);
  }
  out.grounded = out.calls.length > 0 && out.calls.every(c => c.status === "completed");
  if (out.grounded) {
    out.note = "已确认 " + out.calls.length + " 次检索动作；" + XF_NO_CITATIONS;
  }
  return out;
}

/** 网关不给结构化引用，只能从正文抽 URL 供人工链接回源；抽到的也仍是待核。 */
export function xfUrlsFromText(text) {
  const s = String(text || "");
  const re = /https?:\/\/[^\s<>"'）)】\]]+/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null && out.length < XF_MAX_URLS) {
    const u = m[0].replace(/[，。；、,.;]+$/, "");
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/**
 * 把一轮联网回答包成「待核线索」。
 * 红线：verified 恒 false、publishedAt 恒 null（网关不给检索结果发布时间，
 * 绝不拿当前时间冒充）、timeUnknown 恒 true、正文不进事实层 / 数字白名单。
 */
export function xfClue(obj, opts = {}) {
  const g = xfGrounding(obj);
  const text = String((obj && obj.output_text) || "").trim() || xfTextOf(obj);
  return {
    source: XF_CLUE_SOURCE,
    title: String(opts.title || "联网检索结果（待核）"),
    text,
    urls: xfUrlsFromText(text),
    grounded: g.grounded,
    queries: g.queries,
    note: g.note,
    noCitations: true,
    publishedAt: null,
    timeUnknown: true,
    verified: false,
    asOf: String(opts.asOf || ""),
  };
}

/** 线索区状态条：联网状态、数据时点、检索词、引用缺口一次说清，不冒充实时。 */
export function xfBannerHtml(g, opts = {}) {
  const asOf = esc(opts.asOf || "");
  const q = g.queries.length ? esc(g.queries.slice(0, 3).join("；")) : "—";
  const cls = g.grounded ? "ws-ok" : "ws-warn";
  const head = g.grounded ? "已确认联网检索" : "未联网 · 仅作待核线索";
  return '<div class="ws-banner ' + cls + '">' +
    '<span class="ws-tag">' + head + '</span>' +
    (asOf ? '<span class="ws-asof">数据时点 ' + asOf + '</span>' : "") +
    '<span class="ws-q">检索词：' + q + '</span>' +
    '<span class="ws-note">' + esc(g.note) + '</span>' +
    '</div>';
}
