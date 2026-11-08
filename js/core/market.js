/* ---------- 债市晴雨表（v100）：公开仓侧只读校验与展示 ----------
   数据由私有仓 Update NAV 每日生成（navsources/market_weather.py），落 licai-data
   仓根的 market.json；公开仓只读不写。本模块是那条契约在浏览器这一侧的另一半：

   · 结构坏（schema / 格子数 / 枚举 / 出处）→ 整包拒收，页面退回「无行情数据」，
     绝不半信半疑地渲染一半；
   · 逻辑坏（方向与 BP 符号打架）→ 整包拒收 —— 红绿符号是这个功能的全部语义，
     符号错了的行情比没有行情更害人；
   · verified=false → 界面可看但标注「未核验」，绝不进大模型快照；
   · aiText 禁用词 → 拒收。禁用词表与私有仓引擎是同一张（双保险：云端引擎拦过
     一道，公开仓复扫一道 —— 两边任一失守都拦得住）。

   ★ 判据收口：改动这里任何一条，都要同步改 tests/market.test.mjs 与私有仓
     navsources/market_weather.py 的 validate_snapshot（及它的 22 条测试）。 */

export const MARKET_SCHEMA = "licai-ledger.bondWeather/0.2";
/** 禁用词（与私有仓 FORBIDDEN 同一张表）：模型侧不给「预测」口实。 */
export const MARKET_FORBIDDEN = ["预期收益率", "预期收益", "预计收益", "预计明日", "收益率预测", "预测收益", "收益预测"];
/** 格子体系：利率债 3×5 + 信用债 3×6 = 33 格（AA+/AA 曲线只发布至 1 年，
    3年/5年两格恒为 none，理由由数据里的 basis.reason 给出）。 */
export const MARKET_RATE_ISSUERS = ["国债", "国开", "口行"];
export const MARKET_RATE_TENORS = ["1年", "3年", "5年", "7年", "10年"];
export const MARKET_CREDIT_ISSUERS = ["AAA", "AA+", "AA"];
export const MARKET_CREDIT_TENORS = ["1月", "3月", "6月", "1年", "3年", "5年"];
export const MARKET_CELL_COUNT = MARKET_RATE_ISSUERS.length * MARKET_RATE_TENORS.length
  + MARKET_CREDIT_ISSUERS.length * MARKET_CREDIT_TENORS.length;
/** 方向文案：红=收益率下行（债券价格上涨），中国红涨绿跌惯例。 */
export const MARKET_DIR_LABEL = {
  up: "红 · 收益率下行（债券价格上涨）",
  down: "绿 · 收益率上行（债券价格下跌）",
  flat: "白 · 与上一交易日持平",
  none: "蓝 · 暂无数据",
};
/** BP 窗口（bpTable 里的键顺序）：与私有仓 WINDOWS 同一张表。 */
export const MARKET_BP_WINDOW_LABEL = ["1日", "5日", "20日", "60日"];
/** 行情来源只认这两档：media/unknown 的「行情」不是行情。 */
const MARKET_TIERS = ["official", "disclosure"];
/** aiText 长度上限：防异常大文本撑爆 LLM 快照与弹窗。 */
const AI_TEXT_MAX = 2000;

import { esc } from "./util.js";

/** 严格 YYYY-MM-DD 且是真日期（EM 的「2026-11-06 00:00:00」后缀不许漏进来）。 */
export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isFiniteNum = (v) => typeof v === "number" && isFinite(v);
const knownTenor = (issuer, tenor) => {
  if (MARKET_RATE_ISSUERS.includes(issuer)) return MARKET_RATE_TENORS.includes(tenor);
  if (MARKET_CREDIT_ISSUERS.includes(issuer)) return MARKET_CREDIT_TENORS.includes(tenor);
  return false;
};

/** 单格校验：返回问题文案（无问题返回 ""）。方向-BP 符号互洽在这里收口。 */
function cellProblem(c) {
  if (!c || typeof c !== "object") return "格子不是对象";
  if (c.group !== "rate" && c.group !== "credit") return `group 非法：${c.group}`;
  if (!knownTenor(c.issuer, c.tenor)) return `发行人/期限非法：${c.issuer}/${c.tenor}`;
  if (!["up", "down", "flat", "none"].includes(c.dir)) return `方向非法：${c.dir}`;
  const src = c.source;
  if (!src || typeof src !== "object") return "格子缺 source";
  for (const k of ["url", "tier", "dataDate"]) {
    if (!src[k]) return `source 缺 ${k}`;
  }
  if (!MARKET_TIERS.includes(src.tier)) return `来源级别非法：${src.tier}`;
  if (!isIsoDate(src.dataDate)) return `source.dataDate 非 ISO 日期：${src.dataDate}`;
  const b = c.basis;
  if (!b || typeof b !== "object") return "格子缺 basis";
  if (c.dir === "none") {
    /* none = 官方曲线没给出这一格：不造数，必须写明理由。 */
    if (!b.reason) return "none 格必须带 basis.reason";
    if ("bp1d" in b && b.bp1d !== undefined && b.bp1d !== null) return "none 格不应带 bp1d";
    return "";
  }
  for (const k of ["yieldPct", "prevYieldPct", "bp1d"]) {
    if (!isFiniteNum(b[k])) return `${c.dir} 格缺数值 ${k}`;
  }
  /* 方向判据（私有仓 build_cells 同一条）：bp>0=收益率上行=绿，bp<0=下行=红，bp=0=白。
     JS 里 -0 === 0 为真，所以 flat 的判断自然涵盖 -0，不需要再分支。 */
  const bp = b.bp1d;
  if (c.dir === "up" && !(bp < 0)) return `up 格 bp1d=${bp} 不是负数（红=下行）`;
  if (c.dir === "down" && !(bp > 0)) return `down 格 bp1d=${bp} 不是正数（绿=上行）`;
  if (c.dir === "flat" && bp !== 0) return `flat 格 bp1d=${bp} 不是 0`;
  return "";
}

/**
 * 整包校验：返回 {ok, why}。任何一条不过就整包拒收 —— 半渲染的行情等于错的行情。
 * @param {any} m 私有仓 market.json 的解析结果
 */
export function validateMarket(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, why: "根不是对象" };
  if (m.schema !== MARKET_SCHEMA) return { ok: false, why: `schema 不认识：${m.schema}` };
  const w = m.weather;
  if (!w || typeof w !== "object") return { ok: false, why: "缺 weather" };
  if (!isIsoDate(w.asOf)) return { ok: false, why: `asOf 非 ISO 日期：${w.asOf}` };
  if (!isIsoDate(w.prevDate)) return { ok: false, why: `prevDate 非 ISO 日期：${w.prevDate}` };
  if (String(w.prevDate) >= String(w.asOf)) return { ok: false, why: "prevDate 不应晚于或等于 asOf" };
  if (!Array.isArray(w.cells) || w.cells.length !== MARKET_CELL_COUNT) {
    return { ok: false, why: `格子数应为 ${MARKET_CELL_COUNT}，实际 ${Array.isArray(w.cells) ? w.cells.length : "非数组"}` };
  }
  for (let i = 0; i < w.cells.length; i++) {
    const p = cellProblem(w.cells[i]);
    if (p) return { ok: false, why: `第 ${i + 1} 格：${p}` };
  }
  const meta = m.meta;
  if (!meta || typeof meta !== "object") return { ok: false, why: "缺 meta" };
  if (typeof meta.verified !== "boolean") return { ok: false, why: "meta.verified 必须是布尔" };
  if (!meta.capturedAt) return { ok: false, why: "meta 缺 capturedAt" };
  if (!meta.disclaimer) return { ok: false, why: "meta 缺 disclaimer" };
  if (meta.verified === true && Array.isArray(meta.consistencyFlags) && meta.consistencyFlags.length > 0) {
    return { ok: false, why: "verified=true 时 consistencyFlags 必须为空（互斥）" };
  }
  if (typeof m.aiText !== "string" || !m.aiText) return { ok: false, why: "缺 aiText" };
  if (m.aiText.length > AI_TEXT_MAX) return { ok: false, why: `aiText 超长（>${AI_TEXT_MAX}）` };
  for (const word of MARKET_FORBIDDEN) {
    if (m.aiText.includes(word)) return { ok: false, why: `aiText 命中禁用词「${word}」` };
  }
  return { ok: true, why: "" };
}

/** 按利率债/信用债分组（保持表内行列顺序），供矩阵渲染。 */
export function marketGroups(m) {
  const cells = (m && m.weather && Array.isArray(m.weather.cells)) ? m.weather.cells : [];
  return {
    rate: cells.filter(c => c.group === "rate"),
    credit: cells.filter(c => c.group === "credit"),
  };
}

/** 方向统计 {up,down,flat,none}：状态行的数源。 */
export function marketStat(m) {
  const st = { up: 0, down: 0, flat: 0, none: 0 };
  const cells = (m && m.weather && Array.isArray(m.weather.cells)) ? m.weather.cells : [];
  for (const c of cells) if (st[c.dir] !== undefined) st[c.dir] += 1;
  return st;
}

/**
 * aiText 的安全读法：类型不对 / 超长 / 命中禁用词 一律返回 ""。
 * 这是公开仓复扫那一道 —— 云端引擎已拦过，这里再拦一次，两边任一失守都拦得住。
 */
export function marketAiTextSafe(m) {
  const t = m && typeof m === "object" ? m.aiText : null;
  if (typeof t !== "string" || !t || t.length > AI_TEXT_MAX) return "";
  for (const word of MARKET_FORBIDDEN) if (t.includes(word)) return "";
  return t;
}

/**
 * LLM 快照附加块：verified 才给（未核验的行情不给模型当依据）。
 * @returns {string} 空串 = 本轮不带债市块
 */
export function marketAiBlock(m) {
  if (!m || !m.meta || m.meta.verified !== true) return "";
  const text = marketAiTextSafe(m);
  if (!text) return "";
  /* aiText 自带「【债市快照 …】来源：…」标题，外层不再包一层同款 ——
     元信息放尾部一行，避免模型看到两遍标题。 */
  return `${text}\n（快照日期 ${m.weather.asOf}，上一交易日 ${m.weather.prevDate}；官方收益率曲线推导，已核验）`;
}

/** 矩阵一块表：行=发行人、列=期限。cells 为已分组好的该组格子。 */
function matrixHtml(cells, rows, cols, caption) {
  const byKey = {};
  for (const c of cells) byKey[`${c.issuer}|${c.tenor}`] = c;
  let h = `<table class="mkt-tbl"><caption class="cap">${esc(caption)}</caption><tr><th></th>`;
  for (const t of cols) h += `<th>${esc(t)}</th>`;
  h += "</tr>";
  for (const issuer of rows) {
    h += `<tr><th>${esc(issuer)}</th>`;
    for (const tenor of cols) {
      const c = byKey[`${issuer}|${tenor}`];
      if (!c) { h += `<td class="mkt-cell mkt-none" title="缺数据">—</td>`; continue; }
      const b = c.basis || {};
      const label = c.dir === "none" ? "—"
        : c.dir === "flat" ? "持平"
          : `${(Math.round(b.bp1d * 10) / 10).toFixed(1)}bp`;
      const tip = c.dir === "none" ? String(b.reason || "暂无数据") : `${MARKET_DIR_LABEL[c.dir]}｜当日 ${b.yieldPct}% ← 上一日 ${b.prevYieldPct}%`;
      h += `<td class="mkt-cell mkt-${esc(c.dir)}" title="${esc(tip)}">${esc(label)}</td>`;
    }
    h += "</tr>";
  }
  return h + "</table>";
}

/**
 * 弹窗面板 HTML（「模型接入」弹层里的债市行情区块）。
 * m 为 null（云端还没写过 / 读取失败 / 校验没过）→ 空串，区块整个不出现；
 * verified=false → 照常展示但标「未核验」，不给核验章。
 */
export function marketPanelHtml(m) {
  if (!m || typeof m !== "object") return "";
  const w = m.weather;
  const st = marketStat(m);
  const groups = marketGroups(m);
  const verified = !!(m.meta && m.meta.verified === true);
  const badge = verified
    ? `<span class="mkt-ok">已核验</span>`
    : `<span class="mkt-bad">未核验</span>`;
  return `<div class="mkt-wrap" style="margin-top:12px">
    <div class="card-t"><h2 style="font-size:14px">债市行情 ${esc(w.asOf)}</h2>
      <span class="hint">${badge} · 红 ${st.up} / 绿 ${st.down} / 白 ${st.flat} / 蓝 ${st.none}（33 格）</span></div>
    ${matrixHtml(groups.rate, MARKET_RATE_ISSUERS, MARKET_RATE_TENORS, "利率债（收益率曲线每日方向）")}
    ${matrixHtml(groups.credit, MARKET_CREDIT_ISSUERS, MARKET_CREDIT_TENORS, "信用债（中短票据曲线，AA+/AA 只发布至 1 年）")}
    <div class="cap" style="padding-top:4px">${esc((m.meta && m.meta.disclaimer) || "")}</div>
  </div>`;
}
