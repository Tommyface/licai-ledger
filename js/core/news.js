/* ---------- 信息面 · 待核线索（S1 · v120）----------
   四源（财联社电报 / 东财 7×24 / 华尔街见闻 / 中国货币网 FR-FDR）
   由私有仓 Update NAV 每日 3 档 cron 抓成 news.json，网页端只读这一份快照。

   ★ 这一层与债市那三层的根本区别：**它不是数据，是线索。**
     日终层 / 此刻层 / 宏观层都能进「事实层」，数字能被研判引用（进白名单）；
     新闻不能。一条快讯里写「1.32%」我们无法逐条回源核实，写进事实层就等于
     让模型拿一句没核过的话当依据。所以：
       · verified 恒 false，界面逐条标「待核」；
       · 本模块**不导出**任何 newsText / newsFacts / aiText —— 没有给研判的出口；
       · 每条线索必须带可点开的原文 url + 源自带时点 publishedAt，缺一即整包拒收；
       · FR/FDR ≠ DR：funding.label 必含「非 DR 本身」，禁用词表与私有仓同源。

   ★ 云端不是实时：3 档 cron + GitHub 排队 + Pages CDN 缓存，点「刷新」读到的
     仍是上一轮抓的快照。非 apk 通道一律显式写「数据时点」与「非实时」，
     绝不让「3 点点的更新」看起来像 3 点的行情。接口选择开关因此是架构必需品：
       S1 网页端只有 off / cloud；S2 把 apk 接到 APK 内置 Python（mode:"news"）；
       P1 把 anysearch 接到 APK 内置 Python（mode:"anysearch"，key 由桥注入），
       两者都按环境判定：网页端置灰，APK 内有 NativeNav 桥才放行。
       anysearch 只在 App 内可用（网页端无 CORS、key 不能进前端）。

   ★ 资金面陈旧闸门：货币网 CSV 实测会返回 2023/2025 的历史样本。带数值就必须
     有新鲜 asOf（≤ NEWS_STALE_DAYS），否则整包拒收 —— 宁可显示「资金面暂缺」，
     也不把一年前的定盘利率当当日资金面。

   判据收口：校验在 validateNews()，与私有仓 navsources/news.py::validate_news()
   是同一张判据的两半；tests/news.test.mjs 是对照表。 */

import { esc } from "./util.js";
import * as AY from "./anysearch.js";

export const NEWS_SCHEMA = "licai-ledger.news/0.1";
export const NEWS_PROMPT_VER = "news-1";
/** 本机缓存 schema：结构变了 +1。 */
export const NEWS_VER = 1;
/** 来源写死：换仓换路径旧缓存能被认出来。 */
export const NEWS_SRC = "licai-data/news.json";
/** 线索源白名单（AnySearch 是 S2 通道预留，S1 云端包里不会出现）。 */
export const NEWS_SOURCES = ["财联社", "东财7x24", "华尔街见闻", "AnySearch"];
/** 禁用词：与私有仓 FORBIDDEN 同一张表（顺序也一致，便于对照）。 */
export const NEWS_FORBIDDEN = ["超预期", "低于预期", "利好", "利空", "建议买入", "建议卖出",
  "预计明日", "收益率预测", "DR001 报", "DR007 报"];
export const NEWS_MAX_CLUES = 40;
/** 定盘利率日频；距今超过该天数即判陈旧（私有仓 STALE_DAYS 同值）。 */
export const NEWS_STALE_DAYS = 10;
/** 界面上每条线索最多显示多少字摘要（正文可能很长，不撑爆弹层）。 */
const SUMMARY_SHOW = 90;

/** 接口选择开关的四个档位。
 *  web=true：网页端（GitHub Pages）可用；app=true：APK 内（有 NativeNav 桥）可用。
 *  anysearch（P1）：端点跑通、key 由 NavBridge 从 Keystore 注入，仅在 App 内放行 ——
 *  网页端无 CORS（POST 无 ACAO）且 key 不能进前端，所以那边仍置灰，不摆点了没反应的档位。 */
export const NEWS_CHANNELS = [
  { key: "off", label: "关闭", web: true, app: true, hint: "不读取信息面数据" },
  { key: "cloud", label: "云端快照", web: true, app: true, hint: "读私有仓 news.json · 3 档 cron · 非实时" },
  { key: "apk", label: "本机直抓", web: false, app: true, hint: "S2 · APK 内置 Python 直抓四源（mode:news）" },
  { key: "anysearch", label: "AnySearch", web: false, app: true, hint: "P1 · APK 内置 Python 检索（mode:anysearch）· 需 App 内粘贴 key · 一次检索一次配额" },
];

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const isNum = v => typeof v === "number" && isFinite(v);
const isDt = v => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(v || ""));
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const isUrl = v => /^https?:\/\/[^\s]+$/i.test(String(v || ""));

/** 这个通道在当前环境能不能用。
 *  inApp=false（缺省）＝网页端，只认 web:true；inApp=true＝APK 内，有桥才认 app:true。
 *  取值层兜底是硬要求：绕过下拉置灰直接调 newsChannelSet 也拦得住。 */
export function newsChannelAllowed(key, opts = {}) {
  const c = NEWS_CHANNELS.find(x => x.key === key);
  return !!(c && (opts.inApp ? c.app : c.web));
}

/** YYYY-MM-DD 与包内 asOf 相差天数；解析失败返回 NaN。按 UTC 纯日期算，不涉时区。 */
export function newsDaysBetween(dateStr, refDt) {
  const d = String(dateStr || "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(refDt || "").trim());
  if (!isDay(d) || !m) return NaN;
  const a = Date.parse(d + "T00:00:00Z");
  const b = Date.parse(m[1] + "T00:00:00Z");
  if (!isFinite(a) || !isFinite(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

/** 定盘利率日频：缺日期、未来日期、距今 > NEWS_STALE_DAYS 一律判陈旧。 */
export function newsFundingStale(dateStr, refDt) {
  const d = newsDaysBetween(dateStr, refDt);
  return !isFinite(d) || d < 0 || d > NEWS_STALE_DAYS;
}

/**
 * 整包校验 → {ok, why}。与私有仓 validate_news() 同一张判据。
 * 校验不过一律按「没有这份数据」处理，绝不半包渲染。
 * @param {any} news
 * @returns {{ok: boolean, why: string}}
 */
export function validateNews(news) {
  if (!isObj(news)) return { ok: false, why: "根不是对象" };
  if (news.schema !== NEWS_SCHEMA) return { ok: false, why: `schema 不认识：${news.schema}` };
  if (!isDt(news.asOf)) return { ok: false, why: `asOf 非时点：${news.asOf}` };
  if (news.promptVer !== NEWS_PROMPT_VER) return { ok: false, why: `promptVer 不认识：${news.promptVer}` };

  const f = news.funding;
  if (!isObj(f)) return { ok: false, why: "缺 funding" };
  /* 口径冒充红线：label 没有「非 DR 本身」整包拒收。 */
  if (!String(f.label || "").includes("非 DR 本身")) return { ok: false, why: "funding.label 缺「非 DR 本身」，口径冒充风险" };
  if (!isUrl(f.sourceUrl)) return { ok: false, why: "funding.sourceUrl 缺失或非法" };
  if (!Array.isArray(f.rows)) return { ok: false, why: "funding.rows 不是数组" };
  for (const r of f.rows) {
    if (!isObj(r) || !/^FDR(001|007|014)$/.test(String(r.tenor || "")) || !isNum(r.value))
      return { ok: false, why: "funding.rows 有非法 tenor/value（裸写 DR001 也在这里拦）" };
  }
  /* 陈旧闸门：带数值就必须有新鲜 asOf，防历史 CSV 样本回灌成当日资金面。 */
  if (f.rows.length && newsFundingStale(f.asOf, news.asOf))
    return { ok: false, why: "funding.rows 有数值但 asOf 陈旧/缺失，疑似回灌旧定盘" };
  if (!isObj(f.fr)) return { ok: false, why: "funding.fr 不是对象" };
  for (const k of Object.keys(f.fr)) {
    if (!/^FR(001|007|014)$/.test(k) || !isNum(f.fr[k]))
      return { ok: false, why: `funding.fr 有非法键/值：${k}` };
  }
  if (Object.keys(f.fr).length && newsFundingStale(f.frAsOf, news.asOf))
    return { ok: false, why: "funding.fr 有数值但 frAsOf 陈旧/缺失，疑似回灌旧定盘" };

  if (!Array.isArray(news.clues)) return { ok: false, why: "clues 不是数组" };
  if (news.clues.length > NEWS_MAX_CLUES) return { ok: false, why: `clues 超上限 ${NEWS_MAX_CLUES}` };
  for (let i = 0; i < news.clues.length; i++) {
    const c = news.clues[i];
    if (!isObj(c)) return { ok: false, why: `clues[${i}] 不是对象` };
    if (!String(c.title || "").trim()) return { ok: false, why: `clues[${i}] 无 title` };
    if (!isUrl(c.url)) return { ok: false, why: `clues[${i}] 无可点开的 url` };
    if (!isDt(c.publishedAt)) return { ok: false, why: `clues[${i}] 无源自带时点 publishedAt` };
    if (c.verified !== false) return { ok: false, why: `clues[${i}] verified 必须为 false（线索恒待核）` };
    if (!NEWS_SOURCES.includes(c.source)) return { ok: false, why: `clues[${i}] source 不在白名单：${c.source}` };
    const blob = String(c.title || "") + String(c.summary || "");
    for (const w of NEWS_FORBIDDEN)
      if (blob.includes(w)) return { ok: false, why: `clues[${i}] 命中禁用词「${w}」` };
  }

  const meta = news.meta;
  if (!isObj(meta)) return { ok: false, why: "缺 meta" };
  if (!/^sha256:[0-9a-f]{64}$/.test(String(meta.rawHash || ""))) return { ok: false, why: "meta.rawHash 缺失或不是 sha256" };
  if (meta.verified !== false) return { ok: false, why: "meta.verified 必须为 false" };
  if (!Array.isArray(news.gaps)) return { ok: false, why: "gaps 不是数组" };
  return { ok: true, why: "" };
}

/** 缓存归一化：只留整包 + 版本/来源/本机取数时刻。读回时仍要过 validateNews。 */
export function newsPack(news, at) {
  if (!validateNews(news).ok) return null;
  return { v: NEWS_VER, src: NEWS_SRC, at: Number(at) || Date.now(), news };
}
export function newsUnpack(o) {
  if (!isObj(o) || o.v !== NEWS_VER || o.src !== NEWS_SRC) return null;
  return validateNews(o.news).ok ? o.news : null;
}

/** asOf 是北京时点字符串；按 +08:00 解析，避免浏览器本地时区把它算偏。 */
export function newsAsOfText(news, now = Date.now()) {
  const s = String((news && news.asOf) || "");
  if (!isDt(s)) return "";
  const t = Date.parse(s.replace(" ", "T") + "+08:00");
  if (!isFinite(t)) return s;
  const d = Math.max(0, Number(now) - t);
  let ago = "刚刚";
  if (d >= 86400000) ago = `${Math.floor(d / 86400000)} 天前`;
  else if (d >= 3600000) ago = `${Math.floor(d / 3600000)} 小时前`;
  else if (d >= 60000) ago = `${Math.floor(d / 60000)} 分钟前`;
  return `数据时点 ${s}（北京）· ${ago}`;
}

/** 接口开关：<select>。按环境置灰：网页端只放行 web:true，APK 内放行 app:true。 */
function channelSelectHtml(cur, env = {}) {
  const inApp = !!env.inApp;
  const opts = NEWS_CHANNELS.map(c => {
    const allowed = inApp ? c.app : c.web;
    const dis = allowed ? "" : " disabled";
    /* 网页端不可用的都是「仅 App 内」（apk 本机直抓 / anysearch 检索），
       不再写「S2 / 待补」—— 那些档位已经实现了，只是跑在 APK 内 Python 里。 */
    const label = allowed ? c.label : `${c.label}（仅 App 内）`;
    const sel = c.key === cur ? " selected" : "";
    return `<option value="${esc(c.key)}"${sel}${dis} title="${esc(c.hint)}">${esc(label)}</option>`;
  }).join("");
  return `<select id="newsCh" onchange="newsChannelSet(this.value)" aria-label="信息面接口">${opts}</select>`;
}

/** 资金面段。rows/fr 为空（陈旧或抓取失败）时只显示原因，绝不显示旧数值。 */
function fundingHtml(f) {
  const rows = Array.isArray(f.rows) ? f.rows : [];
  const fr = isObj(f.fr) ? f.fr : {};
  if (!rows.length && !Object.keys(fr).length) {
    return `<div class="nw-fund nw-fund-empty">资金面暂缺：本轮没取到新鲜的 FR/FDR 定盘
      （见下方缺口）。<b>不以历史样本补位。</b></div>`;
  }
  const cells = rows.map(r => `<span class="nw-fc"><b>${esc(r.tenor)}</b> ${esc(Number(r.value).toFixed(2))}%</span>`).join("");
  const frs = Object.keys(fr).sort().map(k => `<span class="nw-fc"><b>${esc(k)}</b> ${esc(Number(fr[k]).toFixed(2))}%</span>`).join("");
  return `<div class="nw-fund">
    <div class="nw-fh">${esc(f.label)}<span class="nw-fd">定盘日 ${esc(f.asOf || "—")}${f.frAsOf ? ` · FR ${esc(f.frAsOf)}` : ""}</span></div>
    <div class="nw-fr">${cells}${frs}</div>
    <div class="cap">${esc(f.note || "")} · 来源：<a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(f.source || "中国货币网")}</a></div>
  </div>`;
}

/**
 * 线索区主渲染。新闻永不进事实层，本函数也只产出 HTML，不产出任何给模型读的文本。
 * 接口下拉是**单一出口**（四个档位都在这里）；anysearch 通道时把主体区换成
 * 独立检索线索块（js/core/anysearch.js），不重复第二套接口开关、不进 clues 主表。
 * @param {any} news 通过 validateNews 的整包；null 表示还没读到
 * @param {{channel?:string, phase?:string, err?:string, ageText?:string, inApp?:boolean,
 *          ay?:any, ayPhase?:string, ayErr?:string, ayQuery?:string, ayHasKey?:boolean,
 *          ayBusy?:boolean, clues?:any[]}} [opts]
 */
export function newsBlockHtml(news, opts = {}) {
  const inApp = !!opts.inApp;
  const ch = newsChannelAllowed(opts.channel, { inApp }) ? opts.channel : "off";
  const modeText = ch === "cloud" ? "云端快照 · 3 档 cron · <b>非实时</b>"
    : ch === "apk" ? "本机直抓 · 四源 HTTP · <b>非实时</b>"
    : ch === "anysearch" ? "AnySearch 检索线索 · 需 key · <b>无发布时间 · 非实时</b>"
    : "已关闭";
  /* anysearch 是「一次检索一次配额」，按钮改为「检索」，绝不挂自动刷新口径。
     ★ 两个 onclick 都写成完整字面量（函数名不抽成变量）：tests/handlers.test.mjs
       静态对账内联入口，函数名若是变量拼出来的它抓不到，会被误判成「多余项」。 */
  const updBtn = ch === "anysearch"
    ? `<button class="nw-upd" onclick="anysearchRun()">🔍 检索</button>`
    : `<button class="nw-upd" ${ch === "off" ? "disabled" : ""} onclick="newsRefresh({force:true})">↻ 刷新线索</button>`;
  const bar = `<div class="nw-bar">
      <label class="nw-ch">接口 ${channelSelectHtml(ch, { inApp })}</label>
      <span class="nw-mode">${modeText}</span>
      ${updBtn}
    </div>`;
  const head = `<div class="nw-t">信息面<span class="nw-x">待核线索 · 不进事实层</span></div>`;
  const foot = `<div class="cap" style="padding-top:4px">新闻只作待核线索：
    <b>verified 恒 false</b>，不进研判事实层、不进数字白名单，界面每条都标「待核」。
    FR/FDR 是定盘利率（FDR 基于 DR 取中位数），<b>不是 DR 本身</b>，也不与【盘中参考】混算。
    四源：财联社电报 / 东财 7×24 / 华尔街见闻 / 中国货币网。</div>`;
  if (ch === "off") {
    return `<div class="nw-wrap">${head}${bar}
      <div class="nw-empty">接口已关闭。网页端选「云端快照」读私有仓 news.json；App 内可选「本机直抓」「AnySearch 检索」（均为非实时）。</div>${foot}</div>`;
  }
  /* P1：AnySearch 是独立包（无发布时间），主体换成检索线索块，不碰 clues / funding。 */
  if (ch === "anysearch") {
    const body = AY.anysearchBodyHtml(opts.ay || null, {
      phase: opts.ayPhase, err: opts.ayErr, query: opts.ayQuery,
      hasKey: opts.ayHasKey, busy: opts.ayBusy,
      clues: opts.clues || [], inApp,
    });
    return `<div class="nw-wrap">${head}${bar}${body}</div>`;
  }
  const srcName = ch === "apk" ? "本机直抓结果" : "云端快照";
  if (opts.phase === "loading" && !news) {
    return `<div class="nw-wrap">${head}${bar}<div class="nw-empty">正在读取${srcName}…</div>${foot}</div>`;
  }
  if (!news) {
    const why = opts.err ? `这一次没读到：${esc(opts.err)}` : `还没读到${srcName}`;
    return `<div class="nw-wrap">${head}${bar}<div class="nw-empty">${why}</div>${foot}</div>`;
  }
  /* 所有通道（含本机直抓）都显式写数据时点：这是「不冒充实时」的硬要求。 */
  const asof = `<div class="nw-asof">${esc(newsAsOfText(news))}${opts.ageText ? ` · 本机 ${esc(opts.ageText)} 取到` : ""}</div>`;
  const clues = (Array.isArray(news.clues) ? news.clues : []).map(c => {
    const sm = String(c.summary || "").slice(0, SUMMARY_SHOW);
    return `<li class="nw-c">
      <a class="nw-ct" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a>
      <div class="nw-cm"><span class="nw-src">${esc(c.source)}</span>
        <span class="nw-pt">${esc(c.publishedAt)}</span><span class="nw-tag">待核</span></div>
      ${sm ? `<div class="nw-cs">${esc(sm)}</div>` : ""}
    </li>`;
  }).join("");
  const list = clues ? `<ul class="nw-list">${clues}</ul>`
    : `<div class="nw-empty">这一轮没有线索（各源可能都没取到，见下方缺口）。</div>`;
  const gaps = (Array.isArray(news.gaps) ? news.gaps : []).map(g => `<li>${esc(g)}</li>`).join("");
  const gapHtml = gaps ? `<div class="nw-gaps"><b>本轮缺口</b><ul>${gaps}</ul></div>` : "";
  return `<div class="nw-wrap">${head}${bar}${asof}
    ${fundingHtml(news.funding)}${list}${gapHtml}${foot}</div>`;
}
