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
/** 债市现券收盘时点：银行间债券市场现券买卖 9:00-12:00 / 13:30-17:00。
    快照 weather.asOf 是「该交易日的日终估值」，所以截止时间就是这个收盘时点。
    ⚠️ 它是**市场收盘时刻**，不是中债发布时刻（发布在此之后）—— 文案里不许写成
    「17:00 发布」，那是在替数据源编一个我们并不知道的时间。 */
export const MARKET_CLOSE_HHMM = "17:00";
/** 行情来源只认这两档：media/unknown 的「行情」不是行情。 */
const MARKET_TIERS = ["official", "disclosure"];
/** aiText 长度上限：防异常大文本撑爆 LLM 快照与弹窗。 */
const AI_TEXT_MAX = 2000;

import { esc, pad } from "./util.js";

/** 严格 YYYY-MM-DD 且是真日期（EM 的「2026-11-06 00:00:00」后缀不许漏进来）。 */
export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 快照截止时间：「截至 2026-11-06 17:00」。
 * asOf 当天的收盘时点还没到（数据异常 / 系统时间被改）→ 只给日期，
 * 绝不显示一个尚未发生的时点。无快照、asOf 不合法 → 空串（调用方据此不出那一行）。
 */
export function marketCutoffText(m, now = Date.now()) {
  const asOf = m && m.weather && m.weather.asOf;
  if (!isIsoDate(asOf)) return "";
  const close = new Date(`${asOf}T${MARKET_CLOSE_HHMM}:00+08:00`).getTime();
  if (!isFinite(close)) return `截至 ${asOf}`;
  return close > now ? `截至 ${asOf}` : `截至 ${asOf} ${MARKET_CLOSE_HHMM}`;
}

/**
 * 本机取数时刻的相对时间：「刚刚 / 12 分钟前 / 3 小时前 / 11-08 17:15」。
 * 跨天就直接给具体时刻 —— 「21 小时前」读起来比「11-08 17:15」费劲得多。
 * at 为空 → 空串 —— 不许写成「0 秒前」这种假话，调用方拿空串就当没这行。
 */
export function marketAgeText(at, now = Date.now()) {
  const t = Number(at);
  if (!t || !isFinite(t) || t <= 0) return "";
  const n = Number(now) || Date.now();
  const d = Math.max(0, n - t);
  if (d < 60e3) return "刚刚";
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  const a = new Date(t), b = new Date(n);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate())
    return `${Math.floor(d / 3600e3)} 小时前`;
  return `${pad(a.getMonth() + 1)}-${pad(a.getDate())} ${pad(a.getHours())}:${pad(a.getMinutes())}`;
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

/* ============================================================
   中票利差（v118）—— 从已有的 33 格派生，不新增任何数据源
   ============================================================ */

/** 能算利差的期限：信用曲线有 1月/3月/6月/1年/3年/5年，国债只有 1/3/5/7/10 年，
    交集只有这三档。没有交集就不算 —— 绝不拿 6 个月中票减 1 年国债凑一个数，
    那算出来的东西在任何口径下都不叫利差。AA+/AA 曲线只发布至 1 年，所以它们只有 1年一档。 */
export const MARKET_SPREAD_TENORS = ["1年", "3年", "5年"];

/**
 * 中票利差 = 中短期票据收益率 − 同期限国债收益率。
 *
 * ★ 必须写「中票」：数据源是**中短期票据**曲线，我们手上没有城投曲线。
 *   写成「城投利差」就是拿一个没有的数据去回答一个有这个名词的问题。
 *
 * 利差的 1 日变化 = Δy_credit − Δy_govt。因为两格都是「同期限收益率的变化（bp）」，
 * 相减就是利差变化，不需要再除以任何东西，也不需要额外取历史。
 *
 * @param {any} m market.json
 * @returns {Array<{issuer:string,tenor:string,spread:number,chg:number|null,
 *   creditYield:number,govtYield:number,dir:string,source:any}>}
 */
export function marketSpreads(m) {
  const cells = (m && m.weather && Array.isArray(m.weather.cells)) ? m.weather.cells : [];
  if (!cells.length) return [];
  /** @type {Record<string, any>} */
  const govt = {};
  for (const c of cells) {
    if (!c || c.group !== "rate" || c.issuer !== "国债" || c.dir === "none") continue;
    if (!c.basis || !isFiniteNum(c.basis.yieldPct)) continue;
    govt[c.tenor] = c;
  }
  const out = [];
  for (const issuer of MARKET_CREDIT_ISSUERS) {
    for (const tenor of MARKET_SPREAD_TENORS) {
      const cre = cells.find(c => c && c.group === "credit" && c.issuer === issuer && c.tenor === tenor);
      const g = govt[tenor];
      if (!cre || cre.dir === "none" || !g) continue;
      const cb = cre.basis || {}, gb = g.basis || {};
      if (!isFiniteNum(cb.yieldPct) || !isFiniteNum(gb.yieldPct)) continue;
      /* 两个百分数相减 ×100 得 bp；先 ×1000 再 round 再 /10 = 保留一位小数，
         不带浮点尾巴（0.28169999… 直接 toFixed 也能得到 28.2，但中间值要能复用）。 */
      const spread = Math.round((cb.yieldPct - gb.yieldPct) * 1000) / 10;
      const chg = (isFiniteNum(cb.bp1d) && isFiniteNum(gb.bp1d))
        ? Math.round((cb.bp1d - gb.bp1d) * 10) / 10 : null;
      out.push({
        issuer, tenor, spread, chg,
        creditYield: cb.yieldPct, govtYield: gb.yieldPct,
        /* 方向沿用矩阵语义，不另立一套：利差走阔(chg>0) = 信用债跑输国债 = 绿(down)；
           收窄 = 红(up)；持平 = 白。 */
        dir: chg == null ? "none" : chg > 0 ? "down" : chg < 0 ? "up" : "flat",
        source: cre.source,
      });
    }
  }
  return out;
}

/** 利差文案：「AAA 1年 28.2bp」「+0.2bp」。没有 chg 就只给利差本身，不给变化。 */
export function spreadChgText(s) {
  if (!s || !isFiniteNum(s.chg)) return "";
  if (s.chg === 0) return "持平";
  return `${s.chg > 0 ? "+" : ""}${s.chg.toFixed(1)}bp`;
}

/** 利差表：一行一个评级×期限。标题与 caption 都写「中票」，不许写「城投」。
 *
 * ★ 「利差」那一格**不染涨跌色**：它是个**水平值**（28.2bp 是这条曲线的位置），
 *   不是变化。染成实心绿等于说「跌了 28bp」—— 语义完全错了。
 *   颜色只给「较前一日」那一列，那里才是方向。 */
export function spreadHtml(spreads, opts = {}) {
  const arr = Array.isArray(spreads) ? spreads : [];
  if (!arr.length) return "";
  const rows = arr.map(s => `<tr>
      <th>${esc(s.issuer)}</th><td>${esc(s.tenor)}</td>
      <td class="sp-val" title="${esc(`${s.creditYield}% − ${s.govtYield}%`)}">${esc(s.spread.toFixed(1))}bp</td>
      <td class="sp-chg sp-${esc(s.dir)}">${esc(spreadChgText(s) || "—")}</td>
    </tr>`).join("");
  const head = opts.head === false ? "" : `<div class="sp-t">中票利差<span class="sp-x">中短期票据 − 同期限国债</span></div>`;
  return `<div class="sp-wrap">${head}
    <table class="mkt-tbl sp-tbl">
      <tr><th>评级</th><th>期限</th><th>利差</th><th>较前一日</th></tr>
      ${rows}
    </table>
    <div class="cap" style="padding-top:3px">来源同一份中债曲线（T-1 日终）。这是<b>中短期票据</b>利差，
      不是城投利差 —— 本项目没有城投曲线，不做替代。</div>
  </div>`;
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
 * opts.cut=false → 不渲染截止时间那行：债市页的状态条已经把它写在最上面了，
 *   同一个时点在同一屏出现两遍只会让人以为自己看错了。模型接入页没有状态条，
 *   所以那边默认照常显示。
 */
export function marketPanelHtml(m, opts = {}) {
  if (!m || typeof m !== "object") return "";
  const st = marketStat(m);
  const groups = marketGroups(m);
  const verified = !!(m.meta && m.meta.verified === true);
  const badge = verified
    ? `<span class="mkt-ok">已核验</span>`
    : `<span class="mkt-bad">未核验</span>`;
  /* v107：截止时间。原来标题里只挂 asOf，用户看不出「这份行情到几点为止」；
     现在按「该交易日现券收盘」补上时点，口径写在小字里。 */
  const cut = opts && opts.cut === false ? "" : marketCutoffText(m);
  /* v126：标题行自带数据日期（MM-DD 收盘）。此前债市页走 cut=false 时这一屏
     没有任何时间标注（时间在更上方的状态条里），截图一截就是「没有时点的行情」。
     数据日期是行情本身的属性，与状态条「本机更新 X 前」（取数行为）是两回事，
     不冲突。 */
  const asOf = String((m.weather && m.weather.asOf) || "");
  const asOfShort = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf.slice(5)} 收盘` : "";
  /* v126：抓取时刻（ISO 带时区 → MM-DD HH:MM）。cut=false 的债市页「取数行为」
     由状态条讲；模型接入页没有状态条，就在 cut 行一并给出。 */
  const cap = String((m.meta && m.meta.capturedAt) || "");
  const capShort = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(cap)
    ? `${cap.slice(5, 10)} ${cap.slice(11, 16)}` : "";
  return `<div class="mkt-wrap" style="margin-top:12px">
    <div class="card-t" style="margin-bottom:6px"><h2 style="font-size:14px">债市行情</h2>
      <span class="hint">${badge}${asOfShort ? ` · ${esc(asOfShort)}` : ""} · 红 ${st.up} / 绿 ${st.down} / 白 ${st.flat} / 蓝 ${st.none}（33 格）</span></div>
    ${cut ? `<div class="mkt-cut"><b>${esc(cut)}</b><span class="mkt-cut-x">日终估值 · 现券 ${esc(MARKET_CLOSE_HHMM)} 收盘${capShort ? ` · 取于 ${esc(capShort)}` : ""}</span></div>` : ""}
    ${matrixHtml(groups.rate, MARKET_RATE_ISSUERS, MARKET_RATE_TENORS, "利率债（收益率曲线每日方向）")}
    ${matrixHtml(groups.credit, MARKET_CREDIT_ISSUERS, MARKET_CREDIT_TENORS, "信用债（中短票据曲线，AA+/AA 只发布至 1 年）")}
    ${spreadHtml(marketSpreads(m))}
    <div class="cap" style="padding-top:4px">${esc((m.meta && m.meta.disclaimer) || "")}</div>
  </div>`;
}
