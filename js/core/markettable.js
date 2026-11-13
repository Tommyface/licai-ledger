/* ---------- 债市「实时行情表」+ 收蛋估算（v134） ----------
   调研报告《GitHub「债市行情汇总表」类开源项目调研报告》落地层。

   ★ 这个模块只做两件事，别让它长成第三个数据源：
     1. 把已有的「此刻层」12 项实时报价 + 「日终层」33 格矩阵，聚合成一张
        行列结构化的实时行情表（HTML + 可贴 Excel 的 TSV 文本）。零新请求、
        零新数据源 —— 数字全部来自调用方传入的 LIVE / MARKET。
     2. 报告 §2.3 的「债基收蛋」估算：1 蛋 = 0.01%，按久期分档给出推算区间。

   ★★ 收蛋的隔离铁律（用户 2026-11-13 拍板「纳入但严格隔离」）：
     · 它是推算值，不是行情真值。项目 livebond.js 文件头那条「只要信号灯、
       不加加权/打分/预测」的规矩不改动 —— 收蛋不进信号灯统计、不改任何 dir。
     · 只做展示：realtimeTableHtml() 现算现渲染，不落 LIVE/MARKET、不写
       localStorage、不写 aiText、不进 llmSnapText / liveFactsForBrief /
       briefFacts / marketAiBlock 任何自动装配链路。
     · EGGS_MODEL_POLICY 是给测试用的机械护栏；assert 不住就别上线。
     · tests/markettable_v134.test.mjs 有源码级反向断言：app.js 里本模块的
       调用点必须唯一且只在渲染函数里，模型装配函数体不许出现收蛋字样。

   ★ 口径诚实（报告 §6 风险表）：项目没有「活跃券成交价」，用的是中债官方
     收益率曲线的 bp1d（日终层，带 source/dataDate/tier 可溯源），或盘中
     参考收益率（此刻层，降级）。两者都不是活跃券成交价，也不做差、不互补。
     报告里「收益率下行=价格上涨=红」这条方向判据，本项目 market.js 早已
     收口并加了单测，这里直接沿用 liveDirOf，不再另立一套。
   ------------------------------------------------------------------ */

import { LIVE_QUOTES, LIVE_GROUPS, liveDirOf, liveValText, liveChgText, liveStat,
  LIVE_SRC } from "./livebond.js";
import { marketStat, marketCutoffText, MARKET_CELL_COUNT,
  MARKET_DIR_LABEL } from "./market.js";

/** 机械护栏常量：改这个值就等于承认收蛋要进模型，测试会红。 */
export const EGGS_MODEL_POLICY = "display-only";
/** 1 个蛋 = 0.01%（报告 §2.3）。改单位前先看 tests/markettable_v134.test.mjs。 */
export const EGG_UNIT_PCT = 0.01;

/** 免责声明：每次输出整段携带，一个字都不许省（报告 §6「推算值误导」应对）。 */
export const EGGS_DISCLAIMER = "推算值 · 有误差 · 与真实净值脱钩。按「收益率变动 × 假设久期」一阶近似估算，" +
  "不是任何产品的真实涨跌幅；未计票息、凸性、信用利差、申赎费用与杠杆；久期是假设区间，非持仓实测；" +
  "数据源为中债官方收益率曲线（或盘中参考收益率），不是活跃券成交价。仅作页面展示，不进入模型快照与研判事实层，" +
  "不构成投资建议。";

const isNum = v => typeof v === "number" && isFinite(v);
const round = (v, n) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);
const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** 方向短标签：与 market.js 的 MARKET_DIR_LABEL 同义，给窄表格用。 */
export const RT_DIR_SHORT = { up: "红·涨", down: "绿·跌", flat: "白·平", none: "蓝·无" };

/* ============================================================
   一、聚合实时行情表（纯展示，零推算）
   ============================================================ */

/**
 * 把此刻层 12 项压成结构化行。缺项照样占一行（显示「—」），
 * 不许悄悄少一行 —— 行列完整性是报告 §5.2「产物审计」的第一条。
 * @param {any} live LIVE（livebond.liveUnpack 出来的形状）
 * @returns {{groups:Array<{id:string,title:string,rows:Array}>, allRows:Array,
 *            total:number, got:number, miss:string[], orphans:string[], stat:Object}}
 */
export function buildRealtimeRows(live) {
  const q = (live && live.quotes) || {};
  const miss = Array.isArray(live && live.miss) ? live.miss.slice() : [];
  const groups = [];
  const allRows = [];
  for (const g of LIVE_GROUPS) {
    const rows = [];
    for (const key of g.keys) {
      const spec = LIVE_QUOTES.find(x => x.key === key);
      const x = q[key];
      if (!x || !isNum(x.val)) {
        rows.push({
          group: g.id, key, name: (spec && spec.name) || key,
          valText: "—", chgText: "—", dir: "none",
          unit: "", missing: true,
        });
        continue;
      }
      const isPx = x.kind === "price" || x.kind === "index";
      rows.push({
        group: g.id, key, name: x.name,
        valText: liveValText(x), chgText: liveChgText(x) || "—",
        dir: liveDirOf(x.kind, isPx ? x.pct : x.bp),
        unit: isPx ? "" : "%",
        missing: false,
      });
    }
    groups.push({ id: g.id, title: g.title, rows });
    allRows.push(...rows);
  }
  /* 清单里列了却没解析到的，也要在表里留痕：否则「12 项」这句话会变成 10 个格子。 */
  const knownKeys = LIVE_GROUPS.flatMap(g => g.keys);
  const orphans = miss.filter(k => !knownKeys.includes(k));
  return {
    groups, allRows, total: knownKeys.length,
    got: allRows.filter(r => !r.missing).length,
    miss: miss.slice(), orphans, stat: liveStat(live),
  };
}

/** 日终层摘要：33 格方向分布 + 时点。与 market.js 的 marketStat 同源，不另算。 */
export function buildDailySummary(m) {
  if (!m || !m.weather) return null;
  const st = marketStat(m);
  return {
    asOf: String(m.weather.asOf || ""),
    prevDate: String(m.weather.prevDate || ""),
    cutoff: marketCutoffText(m),
    stat: st,
    count: Array.isArray(m.weather.cells) ? m.weather.cells.length : 0,
    total: MARKET_CELL_COUNT,
    verified: !!(m.meta && m.meta.verified === true),
    source: "中债官方收益率曲线（日终估值）",
  };
}

/* ============================================================
   二、收蛋估算（推算值 · 严格隔离）
   ============================================================ */

/** 久期分档（报告 §2.3：3 年以下中短债、3 年以上中长债）。
    这里是**假设区间**，不是持仓实测久期；列出用哪些关键期限，便于回溯。 */
export const EGG_BANDS = [
  { key: "short", label: "中短债", durNote: "假设久期 1～3 年", durLo: 1, durHi: 3,
    officialTenors: ["1年", "3年"], liveKeys: ["CN2Y"] },
  { key: "long", label: "中长债", durNote: "假设久期 3～10 年", durLo: 3, durHi: 10,
    officialTenors: ["5年", "7年", "10年"], liveKeys: ["CN10Y", "CN5Y", "CN30Y"] },
];

/**
 * 蛋数公式（一阶久期近似）：
 *   Δy(小数) = bp × 0.0001
 *   ΔP/P     ≈ −D × Δy
 *   ΔP(%)    = −D × bp × 0.01
 *   蛋数      = ΔP(%) / 0.01 = −D × bp      ← 1 蛋 = 0.01%
 * bp<0（收益率下行）→ 蛋数为正（赚钱），与「红涨」一致。
 */
export function eggsOf(duration, bp) {
  if (!isNum(duration) || !isNum(bp)) return null;
  const e = round(-duration * bp, 2);
  /* -2*0 在 JS 里是 -0，strictEqual(-0, 0) 会红，且文案里会出现「-0.0 蛋」。
     归零成正 0，不改任何数值语义。 */
  return e === 0 ? 0 : e;
}

/** 从日终层 33 格里取某档关键期限的 bp1d 均值（跳过 none / 非法值）。 */
function officialBandBp(m, tenors) {
  const cells = (m && m.weather && Array.isArray(m.weather.cells)) ? m.weather.cells : [];
  const used = [];
  for (const t of tenors) {
    const c = cells.find(x => x && x.group === "rate" && x.issuer === "国债" && x.tenor === t);
    if (!c || c.dir === "none") continue;
    const bp = c && c.basis ? c.basis.bp1d : undefined;
    if (!isNum(bp)) continue;
    used.push({ tenor: t, bp: Number(bp) });
  }
  if (!used.length) return { bp: null, used: [] };
  return { bp: round(used.reduce((s, x) => s + x.bp, 0) / used.length, 3), used };
}

/** 从此刻层取某档实时收益率的 bp 均值（降级口径，更弱）。 */
function liveBandBp(live, keys) {
  const q = (live && live.quotes) || {};
  const used = [];
  for (const k of keys) {
    const x = q[k];
    if (!x || !isNum(x.bp)) continue;
    used.push({ tenor: k, bp: Number(x.bp) });
  }
  if (!used.length) return { bp: null, used: [] };
  return { bp: round(used.reduce((s, x) => s + x.bp, 0) / used.length, 3), used };
}

/**
 * 收蛋估算主入口。优先日终层官方曲线（可溯源、verified），不可用时降级
 * 此刻层盘中参考收益率并如实标注；两层都没有就 ok=false，绝不编数。
 *
 * @returns {{ok:boolean, estimateOnly:boolean, basis:string, basisLabel:string,
 *            asOf:string, bands:Array, disclaimer:string, why:string}}
 */
export function estimateEggs(m, live) {
  const base = { ok: false, estimateOnly: true, basis: "", basisLabel: "",
    asOf: "", bands: [], disclaimer: EGGS_DISCLAIMER, why: "" };
  const daily = buildDailySummary(m);
  const useOfficial = !!(daily && daily.count === MARKET_CELL_COUNT);
  const bands = [];
  for (const b of EGG_BANDS) {
    const r = useOfficial ? officialBandBp(m, b.officialTenors) : { bp: null, used: [] };
    let bp = r.bp, used = r.used, basis = useOfficial ? "official-curve" : "";
    if (bp === null) {
      const l = liveBandBp(live, b.liveKeys);
      bp = l.bp; used = l.used; basis = bp === null ? "" : "live-yield";
    }
    if (bp === null) {
      bands.push({ ...b, ok: false, bp: null, used: [], lo: null, hi: null,
        pctLo: null, pctHi: null, dir: "none", basis: "" });
      continue;
    }
    const e1 = eggsOf(b.durLo, bp), e2 = eggsOf(b.durHi, bp);
    const lo = Math.min(e1, e2), hi = Math.max(e1, e2);
    bands.push({
      ...b, ok: true, bp, used, lo, hi,
      /* 蛋 → % ：1 蛋 = 0.01% */
      pctLo: round(lo * EGG_UNIT_PCT, 4), pctHi: round(hi * EGG_UNIT_PCT, 4),
      dir: liveDirOf("yield", bp), basis,
    });
  }
  const okBands = bands.filter(x => x.ok);
  if (!okBands.length) {
    return { ...base, why: "没有可用的收益率变动数据（日终层与此刻层都没有），不做估算" };
  }
  const basisSet = Array.from(new Set(okBands.map(x => x.basis)));
  const basis = basisSet.length === 1 ? basisSet[0] : "mixed";
  return {
    ok: true, estimateOnly: true, basis,
    basisLabel: basis === "official-curve" ? "中债官方收益率曲线 · 日终估值"
      : basis === "live-yield" ? "东方财富盘中参考收益率 · 降级口径"
        : "日终层与此刻层混合（各档分别标注）",
    asOf: daily ? daily.asOf : "",
    bands, disclaimer: EGGS_DISCLAIMER, why: "",
  };
}

/** 区间文案：「+0.6 ~ +1.8 蛋」。两端相等只给一个数。 */
export function eggsRangeText(b) {
  if (!b || !b.ok || !isNum(b.lo) || !isNum(b.hi)) return "—";
  const f = v => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
  return b.lo === b.hi ? `${f(b.lo)} 蛋` : `${f(b.lo)} ~ ${f(b.hi)} 蛋`;
}
/** 对应涨跌幅区间文案：「+0.006% ~ +0.018%」。 */
export function eggsPctText(b) {
  if (!b || !b.ok || !isNum(b.pctLo) || !isNum(b.pctHi)) return "—";
  const f = v => `${v > 0 ? "+" : ""}${v.toFixed(3)}%`;
  return b.pctLo === b.pctHi ? f(b.pctLo) : `${f(b.pctLo)} ~ ${f(b.pctHi)}`;
}

/* ============================================================
   三、渲染：HTML 表 + 可复制文本
   ============================================================ */

/** 一格方向色：沿用 mkt-tbl 的语义，不另立配色。 */
function dirCls(dir) { return `rt-${esc(dir || "none")}`; }

/** 此刻层明细表：4 个分组 + 逐项行 + 汇总脚注。 */
function liveRowsHtml(rt) {
  let h = "";
  for (const g of rt.groups) {
    h += `<tr class="rt-g"><th colspan="5">${esc(g.title)}</th></tr>`;
    for (const r of g.rows) {
      const unit = r.unit ? `<i class="rt-u">${esc(r.unit)}</i>` : "";
      h += `<tr>
        <th class="rt-n">${esc(r.name)}${r.missing ? `<span class="rt-miss">缺</span>` : ""}</th>
        <td class="rt-v">${esc(r.valText)}${unit}</td>
        <td class="rt-c ${dirCls(r.dir)}">${esc(r.chgText)}</td>
        <td class="rt-d ${dirCls(r.dir)}">${esc(RT_DIR_SHORT[r.dir] || RT_DIR_SHORT.none)}</td>
        <td class="rt-s">${r.missing ? "本次没取到" : "东财 · 盘中参考价"}</td>
      </tr>`;
    }
  }
  return h;
}

/** 日终层摘要行（作为表格的一个分区，不另开一张表）。 */
function dailyRowsHtml(ds) {
  if (!ds) return `<tr class="rt-g"><th colspan="5">日终层 · 暂无快照</th></tr>
    <tr><th class="rt-n">33 格矩阵</th><td colspan="4" class="rt-s">私有仓 market.json 未取到，按没有处理，不编造数字</td></tr>`;
  const s = ds.stat;
  return `<tr class="rt-g"><th colspan="5">日终层 · 33 格方向矩阵（${esc(ds.cutoff || ds.asOf)}）</th></tr>
    <tr>
      <th class="rt-n">方向分布</th>
      <td class="rt-v rt-up">红 ${s.up}</td><td class="rt-c rt-down">绿 ${s.down}</td>
      <td class="rt-d rt-flat">白 ${s.flat}</td><td class="rt-s rt-none">蓝 ${s.none}</td>
    </tr>
    <tr>
      <th class="rt-n">口径</th>
      <td colspan="4" class="rt-s">${esc(ds.source)} · ${esc(ds.asOf)} / 上一交易日 ${esc(ds.prevDate)}
        · ${ds.count}/${ds.total} 格 · ${ds.verified ? "已核验" : "未核验"}</td>
    </tr>`;
}

/** 收蛋区块：独立一张小表 + 整段免责。带 data 属性方便测试定位隔离区。 */
function eggsBlockHtml(eg) {
  const head = `<div class="rt-egg-t">债基收蛋估算<span class="rt-egg-tag">推算值</span></div>`;
  if (!eg || !eg.ok) {
    return `<div class="rt-egg" data-eggs="display-only" data-eggs-ok="0">
      ${head}<div class="rt-egg-no">${esc((eg && eg.why) || "没有可用的收益率数据，本次不做估算")}</div>
      <div class="cap rt-egg-cap">${esc(EGGS_DISCLAIMER)}</div></div>`;
  }
  let rows = "";
  for (const b of eg.bands) {
    const used = b.ok ? b.used.map(x => `${x.tenor} ${x.bp > 0 ? "+" : ""}${x.bp.toFixed(2)}bp`).join("、") : "无可用期限";
    rows += `<tr>
      <th class="rt-n">${esc(b.label)}<span class="rt-egg-dn">${esc(b.durNote)}</span></th>
      <td class="rt-v ${dirCls(b.dir)}">${esc(eggsRangeText(b))}</td>
      <td class="rt-c ${dirCls(b.dir)}">${esc(eggsPctText(b))}</td>
      <td class="rt-s">${esc(used)}<span class="rt-egg-b">${b.basis === "official-curve" ? "日终官方" : b.basis === "live-yield" ? "盘中参考（降级）" : "—"}</span></td>
    </tr>`;
  }
  return `<div class="rt-egg" data-eggs="display-only" data-eggs-ok="1">
    ${head}
    <div class="rt-egg-src">口径：${esc(eg.basisLabel)}${eg.asOf ? ` · 数据日期 ${esc(eg.asOf)}` : ""}
      · 公式 蛋数 = −久期 × 收益率变动(bp) · 1 蛋 = 0.01%</div>
    <table class="mkt-tbl rt-egg-tbl">
      <tr><th>分档</th><th>推算蛋数</th><th>对应涨跌幅</th><th>采用的关键期限</th></tr>
      ${rows}
    </table>
    <div class="cap rt-egg-cap">${esc(EGGS_DISCLAIMER)}</div>
  </div>`;
}

/* 北京时间（Asia/Shanghai）格式化：live.at 是带 +08:00 偏移的时间戳，语义即北京时间。
   必须显式指定时区，绝不依赖运行环境时区——否则 UTC 环境（如 CI runner）会少 8 小时，
   导致「现抓」时间显示错误（v134 上线时 Web CI 在 UTC 下报 02:30:00）。 */
function bjHMS(d) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
}
function bjDateTime(d) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
}

/**
 * 完整实时行情表 HTML。
 * @param {any} live LIVE
 * @param {any} market MARKET
 * @param {{now?:number, phase?:{id:string,label:string}, checkedAtText?:string}} opts
 */
export function realtimeTableHtml(live, market, opts = {}) {
  const rt = buildRealtimeRows(live);
  const ds = buildDailySummary(market);
  const eg = estimateEggs(market, live);
  const at = live && live.at ? new Date(live.at) : null;
  const time = at && isFinite(at.getTime()) ? bjHMS(at) : "";
  const phase = opts.phase && opts.phase.label ? ` · ${opts.phase.label}` : "";
  const checked = opts.checkedAtText ? ` · 查于 ${opts.checkedAtText}` : "";
  const cap = time ? `现抓 ${time}${phase}${checked}` : "尚未取过此刻行情";
  return `<div class="rt-wrap">
    <div class="rt-t">实时行情表<span class="rt-t-x">${esc(cap)} · 此刻层 ${rt.got}/${rt.total} 项${rt.miss.length ? `（缺 ${esc(rt.miss.join("、"))}）` : ""}</span></div>
    <table class="mkt-tbl rt-tbl">
      <tr class="rt-h"><th>名称</th><th>最新</th><th>涨跌</th><th>方向</th><th>来源 / 口径</th></tr>
      ${liveRowsHtml(rt)}
      ${dailyRowsHtml(ds)}
      <tr class="rt-f"><th class="rt-n">信号灯合计</th>
        <td colspan="4" class="rt-s">此刻层 ${rt.stat.up} 红 / ${rt.stat.down} 绿 / ${rt.stat.flat} 白 / ${rt.stat.none} 蓝（${rt.total} 项）
          · 与日终 33 格矩阵是两套口径，不做差、不互补</td></tr>
    </table>
    <div class="cap">此刻层为东方财富 ${esc(LIVE_SRC)} 盘中参考价（JSONP 本机直连），方向按
      ${esc(MARKET_DIR_LABEL.up)} 的同一语义判定：收益率下行记红、上行记绿。
      指数为上证口径、回购为交易所 GC 系列，不是银行间 DR007。复制按钮导出的是这张表的纯文本快照（制表符分隔，可直接贴 Excel）。</div>
    ${eggsBlockHtml(eg)}
  </div>`;
}

/**
 * 可复制的纯文本快照（TSV，呼应报告 §5.2「优先输出 Excel 多工作表」的轻量版）。
 * 收蛋段落带着整段免责一起走，避免脱离页面后被当成真值。
 */
export function realtimeTableText(live, market, opts = {}) {
  const rt = buildRealtimeRows(live);
  const ds = buildDailySummary(market);
  const eg = estimateEggs(market, live);
  const at = live && live.at ? new Date(live.at) : null;
  const time = at && isFinite(at.getTime()) ? bjDateTime(at) : "未取数";
  const L = [];
  L.push(`债市实时行情表\t现抓 ${time}${opts.phase && opts.phase.label ? ` · ${opts.phase.label}` : ""}`);
  L.push("分组\t名称\t最新\t涨跌\t方向\t来源/口径");
  for (const g of rt.groups) {
    for (const r of g.rows) {
      L.push([g.title, r.name, r.missing ? "—" : r.valText + r.unit,
        r.chgText, RT_DIR_SHORT[r.dir], r.missing ? "本次没取到" : "东财·盘中参考价"].join("\t"));
    }
  }
  if (ds) {
    const s = ds.stat;
    L.push(`日终层 33 格\t${ds.cutoff || ds.asOf}\t红 ${s.up}/绿 ${s.down}/白 ${s.flat}/蓝 ${s.none}\t${ds.count}/${ds.total}\t${ds.verified ? "已核验" : "未核验"}\t${ds.source}`);
  } else L.push("日终层 33 格\t暂无快照");
  L.push("");
  L.push(`【债基收蛋估算 · ${eg.ok ? eg.basisLabel : "本次不做估算"}】`);
  if (eg.ok) {
    L.push("分档\t假设久期\t推算蛋数\t对应涨跌幅\t采用的关键期限");
    for (const b of eg.bands) {
      L.push([b.label, b.durNote, eggsRangeText(b), eggsPctText(b),
        b.ok ? b.used.map(x => `${x.tenor} ${x.bp}bp`).join("、") : "无可用期限"].join("\t"));
    }
  } else L.push(eg.why);
  L.push(`免责：${EGGS_DISCLAIMER}`);
  return L.join("\n");
}
