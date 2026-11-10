/* ---------- 信息面 · AnySearch 检索线索（P1 · v122）----------
   与「待核线索」区（js/core/news.js）并列，但**是独立的一份包**：
     · 四源快讯有源自带发布时间（publishedAt），能进 clues 主表；
     · AnySearch /v1/search 实测 + 官方文档都确认 results[] 没有 date / publishedAt，
       也没有时间过滤参数。把「检索时刻」硬塞成 publishedAt 就是伪造发布时间 ——
       所以这里单独一个 schema（licai-ledger.anysearch/0.1），hits 里 timeUnknown 恒 true，
       **不许出现任何时间字段**，validateHits() 会整包拒收任何伪造。
     · 它同样不是数据，是线索：verified 恒 false，不进研判事实层、不进数字白名单，
       界面每条都标「待核」。引用不等于核实（第三方 grounding 引用错配率 3~10%）。

   ★ 只在 APK 内可用：网页端没有 CORS（AnySearch 是 POST 且无 ACAO），且 key 只能
     存本机 Keystore（SecretStore.Slot.ANYSEARCH），由 NavBridge 在 mode:"anysearch"
     那一轮注入，页面既读不到明文也没法伪造。网页端这个通道一律置灰。
   ★ 一次检索 = 一次配额 / 计费（铁律 #5）：只能用户点「检索」按钮才发，
     绝不随自动刷新 / 研判预取自动发起。
   ★ 402/429 响应体可能含明文凭证：私有仓 navsources/anysearch.py 对非 2xx
     完全不读 body，只记 status + request_id；这边只负责把 gaps 如实显示。

   判据收口：validateHits() 与私有仓 validate_hits() 是同一张判据的两半；
   tests/anysearch.test.mjs 是对照表。 */
import { esc } from "./util.js";

export const AY_SCHEMA = "licai-ledger.anysearch/0.1";
export const AY_PROMPT_VER = "anysearch-1";
export const AY_MAX_HITS = 10;
/** 默认检索词：给一个债市相关的中性 query，用户可在输入框改。 */
export const AY_DEFAULT_QUERY = "银行理财 债市 国债收益率 资金面";
/** 禁用词：与 news.js::NEWS_FORBIDDEN / 私有仓 FORBIDDEN 同一张表。 */
export const AY_FORBIDDEN = ["超预期", "低于预期", "利好", "利空", "建议买入", "建议卖出",
  "预计明日", "收益率预测", "DR001 报", "DR007 报"];
/** 包里一旦出现这些字段就是伪造发布时间，整包拒收。 */
const TIME_FIELDS = ["publishedAt", "date", "publishTime", "ctime", "showTime"];

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const isDt = v => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(v || ""));
const isUrl = v => /^https?:\/\/[^\s]+$/i.test(String(v || ""));

/**
 * 整包校验 → {ok, why}。与私有仓 validate_hits() 同一张判据。
 * 校验不过一律按「没有这份数据」处理，绝不半包渲染。
 * @param {any} p
 * @returns {{ok: boolean, why: string}}
 */
export function validateHits(p) {
  if (!isObj(p)) return { ok: false, why: "根不是对象" };
  if (p.schema !== AY_SCHEMA) return { ok: false, why: `schema 不认识：${p.schema}` };
  if (!isDt(p.asOf)) return { ok: false, why: `asOf 非时点：${p.asOf}` };
  if (p.promptVer !== AY_PROMPT_VER) return { ok: false, why: `promptVer 不认识：${p.promptVer}` };
  if (!String(p.query || "").trim()) return { ok: false, why: "query 为空" };

  const hits = p.hits;
  if (!Array.isArray(hits)) return { ok: false, why: "hits 不是数组" };
  if (hits.length > AY_MAX_HITS) return { ok: false, why: `hits 超上限 ${AY_MAX_HITS}` };
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!isObj(h)) return { ok: false, why: `hits[${i}] 不是对象` };
    /* ★ 无发布时间红线：任何时间字段都是伪造，整包拒收。 */
    for (const k of TIME_FIELDS)
      if (Object.prototype.hasOwnProperty.call(h, k))
        return { ok: false, why: `hits[${i}] 出现时间字段「${k}」：无发布时间不许伪造` };
    if (!String(h.title || "").trim()) return { ok: false, why: `hits[${i}] 无 title` };
    if (!isUrl(h.url)) return { ok: false, why: `hits[${i}] 无可点开的 url` };
    if (h.source !== "AnySearch") return { ok: false, why: `hits[${i}] source 不是 AnySearch` };
    if (h.verified !== false) return { ok: false, why: `hits[${i}] verified 必须为 false（线索恒待核）` };
    if (h.timeUnknown !== true) return { ok: false, why: `hits[${i}] timeUnknown 必须为 true（无发布时间）` };
    const blob = String(h.title || "") + String(h.snippet || "");
    for (const w of AY_FORBIDDEN)
      if (blob.includes(w)) return { ok: false, why: `hits[${i}] 命中禁用词「${w}」` };
  }

  if (!Array.isArray(p.gaps)) return { ok: false, why: "gaps 不是数组" };
  const meta = p.meta;
  if (!isObj(meta)) return { ok: false, why: "缺 meta" };
  if (!/^sha256:[0-9a-f]{64}$/.test(String(meta.rawHash || "")))
    return { ok: false, why: "meta.rawHash 缺失或不是 sha256" };
  if (meta.verified !== false) return { ok: false, why: "meta.verified 必须为 false" };
  return { ok: true, why: "" };
}

/** 归一化的 URL / 标题指纹，用于与四源直抓线索交叉互证。 */
function normUrl(u) { return String(u || "").trim().replace(/[.,;，。；)]+$/, ""); }
function normTitle(t) { return String(t || "").replace(/\s+/g, "").slice(0, 40); }

/**
 * 交叉互证（纯函数）：AnySearch 命中与四源 clues 同 url 或同标题指纹 → 标「有直抓源互证」。
 * 不改写原包、不联网、不进事实层 —— 只给渲染层加一个展示用的标记。
 * 这是《蓝图》§3.3 说的「准确度靠链接回源 + 与直抓源交叉提」，不靠 key。
 * @param {any[]} hits
 * @param {any[]} clues 四源直抓线索（news.json 的 clues，可为空）
 * @returns {{hits:any[], crossCount:number}}
 */
export function crossCheck(hits, clues) {
  const urls = new Set(), titles = new Set();
  for (const c of (Array.isArray(clues) ? clues : [])) {
    if (isObj(c) && c.url) urls.add(normUrl(c.url));
    if (isObj(c) && c.title) titles.add(normTitle(c.title));
  }
  let crossCount = 0;
  const out = (Array.isArray(hits) ? hits : []).map(h => {
    const ok = urls.has(normUrl(h.url)) || (normTitle(h.title) && titles.has(normTitle(h.title)));
    if (ok) crossCount++;
    return { ...h, crossChecked: ok };
  });
  return { hits: out, crossCount };
}

/** asOf 是北京时点字符串；按 +08:00 解析，避免浏览器本地时区把它算偏。 */
export function ayAsOfText(p, now = Date.now()) {
  const s = String((p && p.asOf) || "");
  if (!isDt(s)) return "";
  const t = Date.parse(s.replace(" ", "T") + "+08:00");
  if (!isFinite(t)) return s;
  const d = Math.max(0, Number(now) - t);
  let ago = "刚刚";
  if (d >= 86400000) ago = `${Math.floor(d / 86400000)} 天前`;
  else if (d >= 3600000) ago = `${Math.floor(d / 3600000)} 小时前`;
  else if (d >= 60000) ago = `${Math.floor(d / 60000)} 分钟前`;
  return `检索时刻 ${s}（北京）· ${ago} · <b>非发布时间</b>`;
}

/**
 * 检索线索主体（不含接口下拉 —— 那是 news.js::newsBlockHtml 的单一出口）。
 * 由 newsBlockHtml 在 channel==="anysearch" 时替换掉 clues 主体区。
 * @param {any} p 通过 validateHits 的整包；null 表示还没检索
 * @param {{phase?:string, err?:string, query?:string, hasKey?:boolean,
 *          clues?:any[], inApp?:boolean, busy?:boolean}} [opts]
 */
export function anysearchBodyHtml(p, opts = {}) {
  const query = String(opts.query || AY_DEFAULT_QUERY);
  const hasKey = !!opts.hasKey;
  const busy = !!opts.busy;
  const qbar = `<div class="ay-q">
      <input id="ayQuery" type="text" value="${esc(query)}" maxlength="120"
        placeholder="检索词（如 银行理财 债市 资金面）" aria-label="检索词">
      <button class="ay-go" ${busy ? "disabled" : ""} onclick="anysearchRun()">${busy ? "检索中…" : "🔍 检索"}</button>
    </div>`;
  const keybar = `<div class="ay-key">
      <span class="ay-ks ${hasKey ? "ay-ks-ok" : ""}">${hasKey ? "✓ key 已存本机加密区（页面读不到明文）" : "⚠ 未配置 key"}</span>
      <input id="ayKey" type="password" value="" maxlength="256" autocomplete="off"
        placeholder="粘贴 AnySearch key（App 内）" aria-label="AnySearch key">
      <button class="ay-kb" onclick="anysearchSetKey()">保存 key</button>
      <button class="ay-kb" onclick="anysearchClearKey()">清除</button>
    </div>`;
  const note = `<div class="ay-note">检索线索只作待核参考：<b>verified 恒 false</b>，
    <b>无发布时间</b>（官方 /v1/search 不返回 date），不进研判事实层、不进数字白名单。
    带 key 只提升配额稳定性，<b>不提升事实准确度</b>；准确度靠链接回源 + 与直抓源交叉。
    402/429 响应体可能含明文凭证，按官方警告只记状态码与 request_id。</div>`;

  if (busy && !p) return qbar + keybar + `<div class="nw-empty">正在检索（一次请求 = 一次配额）…</div>` + note;
  if (!p) {
    const why = opts.err ? `这一次没检索到：${esc(opts.err)}` : "还没检索。填好检索词、配好 key，点「检索」。";
    return qbar + keybar + `<div class="nw-empty">${why}</div>` + note;
  }

  const asof = `<div class="nw-asof">${ayAsOfText(p)}</div>`;
  const clueList = Array.isArray(opts.clues) ? opts.clues : [];
  const { hits, crossCount } = crossCheck(p.hits, clueList);
  const items = hits.map(h => {
    const sm = String(h.snippet || "").slice(0, 90);
    const x = h.crossChecked
      ? `<span class="ay-tag ay-tag-x">有直抓源互证</span>`
      : `<span class="ay-tag">检索线索 · 单一来源</span>`;
    return `<li class="nw-c">
      <a class="nw-ct" href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>
      <div class="nw-cm"><span class="nw-src">AnySearch</span>
        <span class="ay-nt">无发布时间</span><span class="nw-tag">待核</span>${x}</div>
      ${sm ? `<div class="nw-cs">${esc(sm)}</div>` : ""}
    </li>`;
  }).join("");
  const list = items
    ? `<ul class="nw-list">${items}</ul>`
    : `<div class="nw-empty">这一轮没有带有效链接的检索线索（见下方缺口）。</div>`;
  const gaps = (Array.isArray(p.gaps) ? p.gaps : []).map(g => `<li>${esc(g)}</li>`).join("");
  const gapHtml = gaps ? `<div class="nw-gaps"><b>本轮缺口</b><ul>${gaps}</ul></div>` : "";
  const cross = hits.length
    ? `<div class="ay-cross">${crossCount} 条与四源直抓线索对得上（仅表示链接/标题命中，<b>不等于事实已核实</b>）</div>`
    : "";
  return qbar + keybar + asof + list + cross + gapHtml + note;
}
