/* ---------- 债市「此刻」层（v116） ----------
   与 v100 的「日终层」并列，不是一个东西，谁也不许替谁说话：

   · 日终层：中债官方收益率曲线，33 格矩阵，T-1 日终估值，云端每日生成（js/core/market.js）；
   · 此刻层：东方财富行情，12 项报价 + T 主力当日分时，盘中秒级，本机直连（本文件）。

   三条硬规矩（改动前先读）：
   1. 不做差。两层的 10Y 是两个口径（盘中参考价 / 中债估值），界面上不许互相加减，
      也不许拿一层的数去解释另一层的变化。
   2. 不互补。东财没有国开、口行、AAA/AA+/AA 的公开行情 —— 缺就是缺，绝不用国债顶。
   3. 不混合评分。这里不产出「温度分」：用户 2026-11-10 明确选了「只要信号灯」。
      任何加权、打分、预测都不要再加回来。

   数据通道：JSONP（`&cb=`）。走 <script> 标签，不受 CORS 限制，网页版与 App 内同一套。
   一个 ulist 请求拿全 12 项，另一个 trends2 请求拿分时 —— 一次点击两个请求，不批量扫。

   ★ 判据收口：解析、单位、方向、时点四条规则都在本文件，tests/livebond.test.mjs 是
     它们的对照表。改这里任何一条，先改测试。 */

/** 缓存 schema：结构变了就 +1，旧缓存自然作废（不做迁移，行情没有迁移的价值）。
    v118：清单从 10 项增到 12 项（加两个交易所指数），升到 2 —— 旧缓存只有 10 项，
    留着会让「12 项」这句话在屏幕上变成 10 个格子，不如直接作废重取。 */
export const LIVE_VER = 2;
/** 来源写死。将来换源时，旧缓存靠这个字段能被认出来并丢弃。 */
export const LIVE_SRC = "eastmoney";

/** 报价清单。顺序 = 界面顺序：指数（整体概览）→ 利率 → 期货 → 资金。
    kind 决定单位与方向规则（见 liveDirOf）：
      index 指数点位（%，涨算红） / yield 收益率（bp，下行算红） /
      price 期货价（%，上涨算红） / repo 回购利率（bp，上行算绿）

    ★ v118 新增的两个指数是**上证口径**（交易所竞价成交），与中债估值指数
      （银行间估值）不是一个东西：后者在 market.json 的 indexDir 里，仍是代理口径。
      这两个不许拿去替 indexDir，也不许与中债指数比涨跌。 */
export const LIVE_QUOTES = [
  { key: "IDX_GZ", secid: "1.000012", name: "国债指数", kind: "index", dec: 2 },
  { key: "IDX_QZ", secid: "1.000013", name: "企债指数", kind: "index", dec: 2 },
  { key: "CN10Y", secid: "171.CN10Y", name: "10年国债", kind: "yield", dec: 4 },
  { key: "CN30Y", secid: "171.CN30Y", name: "30年国债", kind: "yield", dec: 4 },
  { key: "CN5Y", secid: "171.CN5Y", name: "5年国债", kind: "yield", dec: 4 },
  { key: "CN2Y", secid: "171.CN2Y", name: "2年国债", kind: "yield", dec: 4 },
  { key: "TL", secid: "8.140130", name: "TL 主力", kind: "price", dec: 3 },
  { key: "T", secid: "8.110130", name: "T 主力", kind: "price", dec: 3 },
  { key: "TF", secid: "8.050130", name: "TF 主力", kind: "price", dec: 3 },
  { key: "TS", secid: "8.130130", name: "TS 主力", kind: "price", dec: 3 },
  { key: "GC007", secid: "1.204007", name: "GC007", kind: "repo", dec: 3 },
  { key: "GC001", secid: "1.204001", name: "GC001", kind: "repo", dec: 3 },
];

/** 分组只影响界面标题，不影响判据。 */
export const LIVE_GROUPS = [
  { id: "index", title: "交易所债券指数（上证口径）", keys: ["IDX_GZ", "IDX_QZ"] },
  { id: "rate", title: "国债收益率", keys: ["CN10Y", "CN30Y", "CN5Y", "CN2Y"] },
  { id: "fut", title: "国债期货", keys: ["TL", "T", "TF", "TS"] },
  { id: "cash", title: "交易所回购", keys: ["GC007", "GC001"] },
];

export const LIVE_API = {
  quote: "https://push2.eastmoney.com/api/qt/ulist.np/get",
  trend: "https://push2his.eastmoney.com/api/qt/stock/trends2/get",
  kline: "https://push2his.eastmoney.com/api/qt/stock/kline/get",
};

/** v119：要算「近期变化」的两项。只有指数做这件事 ——
    收益率与回购的「5 日变化」是 bp 差，与矩阵里的 bp5d 重复，不必再拉一遍。 */
export const IDX_HIST_KEYS = ["IDX_GZ", "IDX_QZ"];

/** 取多少根日 K。20 日变化需要 21 根（最新 + 20 根之前），留到 30 根
    是为了万一接口少给几根（长假 / 停牌）也还有富余。 */
export const HIST_BARS = 30;

/** 5 日 / 20 日：都是「交易日根数」，不是自然日 —— 用 K 线下标数，
    自然日会把周末算进去，长假前后偏差能到 3 天以上。 */
export const HIST_SPANS = [5, 20];

/** 报价请求 URL：一个请求拿全 12 项（实测 total=12，缺的 secid 会被接口直接忽略）。 */
export function liveQuoteUrl(cb) {
  const secids = LIVE_QUOTES.map(q => q.secid).join(",");
  return `${LIVE_API.quote}?fltt=2&invt=2&fields=f2,f3,f4,f12,f14&secids=${secids}&cb=${encodeURIComponent(cb)}`;
}

/** 分时请求 URL：T 主力当日逐分钟（实测 80 点）。 */
export function liveTrendUrl(cb) {
  return `${LIVE_API.trend}?secid=8.110130&fields1=f1,f2,f3&fields2=f51,f53&iscr=0&ndays=1&cb=${encodeURIComponent(cb)}`;
}

/** 日 K 请求 URL：一个 secid 一个请求（该接口不支持多 secid 合并，
    所以两个指数就是两个请求，各约 2.3 KB / 40 ms）。 */
export function liveKlineUrl(secid, cb) {
  return `${LIVE_API.kline}?secid=${encodeURIComponent(secid)}`
    + `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
    + `&klt=101&fqt=0&end=20500101&lmt=${HIST_BARS}&cb=${encodeURIComponent(cb)}`;
}

/**
 * 解析日 K。只留「日期 + 收盘」两个字段 —— 开高低量额振幅都用不上，
 * 多留一个字段就多一个将来会被误用的东西。
 *
 * 原始行：`2026-11-10,232.48,232.41,232.48,232.40,124480288,125094265800.00,0.03`
 *         日期,开,收,高,低,量,额,振幅
 * ★ 收盘是第 3 列（下标 2）。第 8 列是**振幅**不是涨跌幅，别拿它当当日涨跌。
 *
 * @returns {{ok:boolean, rows:{date:string,close:number}[], why:string}}
 */
export function liveKlineParse(json) {
  const d = json && json.data;
  const arr = d && Array.isArray(d.klines) ? d.klines : null;
  if (!arr) return { ok: false, rows: [], why: "返回里没有 data.klines（接口结构变了）" };
  const rows = [];
  for (const s of arr) {
    if (typeof s !== "string") continue;
    const p = s.split(",");
    if (p.length < 3) continue;
    const date = String(p[0]).trim();
    const raw = String(p[2]).trim();
    const close = Number(raw);
    /* raw === "" 要单独挡：Number("") 是 0，0 点位的指数不存在，
       但 0 会一路算进分母，届时 5 日变化变成 Infinity 而不是「没数据」。 */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === "" || !isNum(close)) continue;
    rows.push({ date, close });
  }
  return { ok: rows.length > 0, rows, why: rows.length ? "" : "K 线里没有可用的行" };
}

/**
 * 算 N 个交易日的累计涨跌。
 *
 * ★ 两件容易错的事，都在这里一次做对：
 *   ① 排序：不依赖接口返回顺序（实测是升序，但降序的接口也存在），一律按日期升序后再取下标。
 *   ② 补今天：日 K 在盘中常常还没有当天那根（要等收盘才落库）。若直接拿最后一根当「最新」，
 *      而「当日涨跌」来自实时报价，两者基准日差一天 —— 5 日变化会少算今天的涨跌。
 *      所以：最后一根 < 今天 且 今天是交易日 且 手上有实时点位时，用实时点位补一根。
 *      补的那根标 synth=true，页面上据此把「截至」写成今天。
 *
 * @param {{date:string,close:number}[]} rows
 * @param {{today?:string, liveVal?:number|null, isTrade?:(d:string)=>boolean}} opts
 * @returns {{ok:boolean, n:number, latest:number, latestDate:string, synth:boolean,
 *   d1:number|null, d5:number|null, d20:number|null,
 *   from5:string, from20:string, why:string}}
 */
export function liveHistCalc(rows, opts = {}) {
  const src = Array.isArray(rows)
    ? rows.filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) && isNum(r.close))
    : [];
  if (src.length < 2) {
    return { ok: false, n: src.length, latest: null, latestDate: "", synth: false,
      d1: null, d5: null, d20: null, from5: "", from20: "", why: "K 线不足 2 根，算不出变化" };
  }
  const sorted = src.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  /* 同一天出现两条（接口偶尔会重复给）→ 后者覆盖前者，不让 n 虚增 */
  const uniq = [];
  for (const r of sorted) {
    const last = uniq[uniq.length - 1];
    if (last && last.date === r.date) uniq[uniq.length - 1] = { date: r.date, close: r.close };
    else uniq.push({ date: r.date, close: r.close });
  }

  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.today || "")) ? String(opts.today) : "";
  const liveVal = isNum(opts.liveVal) ? Number(opts.liveVal) : null;
  const isTrade = typeof opts.isTrade === "function" ? opts.isTrade : null;
  let synth = false;
  const tail = uniq[uniq.length - 1];
  if (today && tail && tail.date < today && liveVal != null && (!isTrade || isTrade(today))) {
    uniq.push({ date: today, close: liveVal });
    synth = true;
  }

  const n = uniq.length;
  const at = i => uniq[n - 1 - i];        /* at(0) 是最新，at(5) 是 5 个交易日之前 */
  const latest = uniq[n - 1].close;
  /* 基准价必须 > 0：0 做分母会得 Infinity，「涨了无穷多」比「没数据」更糟 */
  const pct = prev => (isNum(prev) && prev > 0 ? (latest / prev - 1) * 100 : null);
  return {
    ok: true, n, latest, latestDate: uniq[n - 1].date, synth,
    d1: n >= 2 ? pct(at(1).close) : null,
    d5: n >= 6 ? pct(at(5).close) : null,
    d20: n >= 21 ? pct(at(20).close) : null,
    from5: n >= 6 ? at(5).date : "",
    from20: n >= 21 ? at(20).date : "",
    why: "",
  };
}

/** 百分比文案：先舍入再判号（-0.0004 不是「跌」，是 0）。
    与 report.js 的 zeroFixed 同一套规矩：宁可少一位符号，不许出现 -0.00%。 */
export function histPctText(v) {
  if (!isNum(v)) return "";
  const r = round(v, 2);
  if (r === 0) return "0.00%";
  return (r > 0 ? "+" : "") + r.toFixed(2) + "%";
}

const isNum = v => typeof v === "number" && isFinite(v);
const round = (v, n) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);

/**
 * 解析 ulist 返回。任何一项不合格 → 那一项进 miss，其余照收（不整包拒收）。
 * 这与日终层「整包拒收」不同，理由：此刻层是 10 个独立报价，挂两项不该把八项也扔掉；
 * 日终层是一个矩阵，缺一格就没法读方向，所以那边必须整包拒。
 *
 * @param {any} json ulist 的 data 段
 * @returns {{ok:boolean, quotes:Object, miss:string[], why:string}}
 */
export function liveParse(json) {
  const out = { ok: false, quotes: {}, miss: [], why: "" };
  const diff = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : null;
  if (!diff) return { ...out, why: "返回里没有 data.diff（接口结构变了）" };
  const byCode = {};
  for (const x of diff) if (x && x.f12 != null) byCode[String(x.f12)] = x;
  for (const spec of LIVE_QUOTES) {
    const code = spec.secid.split(".")[1];
    const x = byCode[code];
    /* f2 为 "-"（停牌/未开盘）或缺失 → 这一项就是没取到。不许填 0：
       0% 的收益率和「没取到」在屏幕上长得一样，但意思完全相反。 */
    if (!x || !isNum(x.f2)) { out.miss.push(spec.key); continue; }
    const val = Number(x.f2);
    const raw = isNum(x.f4) ? Number(x.f4) : 0;
    /* 单位（实测对照，2026-11-10）：
       yield/repo：f2 是百分数（1.5964 = 1.5964%），f4 是百分点差（0.0019）→ bp = f4×100
       price    ：f2 是价格（110.19），f4 是价格差（-0.04 点），f3 是相对涨跌（-0.04%）
       index    ：f2 是点位（232.43），f4 是涨跌点（-0.03），f3 是涨跌幅（-0.01%）
                  —— 与 price 同构，f4 是「点」不是 bp，绝不能乘 100 当 bp 用 */
    const isPx = spec.kind === "price" || spec.kind === "index";
    const bp = isPx ? null : round(raw * 100, 2);
    const pct = isPx ? (isNum(x.f3) ? Number(x.f3) : 0) : null;
    out.quotes[spec.key] = {
      key: spec.key,
      name: spec.name,
      kind: spec.kind,
      dec: spec.dec,
      val: round(val, spec.dec),
      bp,
      pct,
      /* 方向在解析时就定下来，界面只照着画 —— 免得两处各算一遍算反 */
      dir: liveDirOf(spec.kind, isPx ? pct : bp),
    };
  }
  out.ok = Object.keys(out.quotes).length > 0;
  if (!out.ok) out.why = `${LIVE_QUOTES.length} 项一项都没解析出来`;
  return out;
}

/**
 * 方向：红=利多债市（价格涨），绿=利空，白=持平，none=没数据。
 * 沿用 market.js 的 MARKET_DIR_LABEL 语义，不另立一套。
 *   index/price 涨（pct>0）→ 红；yield 收益率下行（bp<0）→ 红；
 *   repo 回购利率上行（bp>0）→ 绿（钱贵了，对债不利）。
 */
export function liveDirOf(kind, v) {
  if (!isNum(v)) return "none";
  if (kind === "price" || kind === "index") return v > 0 ? "up" : v < 0 ? "down" : "flat";
  if (kind === "repo") return v > 0 ? "down" : v < 0 ? "up" : "flat";
  return v < 0 ? "up" : v > 0 ? "down" : "flat";   /* yield */
}

/** 解析分时：返回 [[hhmm, price], ...]。坏点跳过，不整条丢。 */
export function liveTrendParse(json) {
  const arr = json && json.data && Array.isArray(json.data.trends) ? json.data.trends : null;
  if (!arr) return { ok: false, pts: [], why: "返回里没有 data.trends" };
  const pts = [];
  for (const row of arr) {
    if (typeof row !== "string") continue;
    /* "2026-11-10 09:30,110.200,254" —— 时间、价、量（量未必有） */
    const p = row.split(",");
    if (p.length < 2) continue;
    const t = String(p[0]).slice(-5);
    const v = Number(p[1]);
    if (!/^\d{2}:\d{2}$/.test(t) || !isNum(v)) continue;
    pts.push([t, v]);
  }
  return { ok: pts.length > 0, pts, why: pts.length ? "" : "分时里没有可用的点" };
}

/** 信号灯统计（与日终层 marketStat 同形状，界面上两处数字读法一致）。 */
export function liveStat(live) {
  const st = { up: 0, down: 0, flat: 0, none: 0 };
  const q = (live && live.quotes) || {};
  for (const k of Object.keys(q)) {
    const d = q[k] && q[k].dir;
    if (st[d] !== undefined) st[d] += 1;
  }
  /* 清单里列了但这次没取到的，算 none —— 不计入「白」，白是「真的持平」 */
  if (live && Array.isArray(live.miss)) st.none += live.miss.length;
  return st;
}

/**
 * 市场阶段。期货与现券收盘时点不同，标签必须分开说，不然 15:20 会写成「盘中」。
 * @param {Date} now 本机时间
 * @param {(iso:string)=>boolean} isTradeDay 交易日判定（由调用方注入，本模块不读日历）
 */
export function livePhaseOf(now, isTradeDay) {
  const d = now instanceof Date ? now : new Date(now);
  if (!isFinite(d.getTime())) return { id: "unknown", label: "" };
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let trade = true;
  try { trade = typeof isTradeDay === "function" ? !!isTradeDay(iso) : true; } catch (e) { trade = true; }
  if (!trade) return { id: "holiday", label: "今日休市" };
  const m = d.getHours() * 60 + d.getMinutes();
  const H = (h, mi) => h * 60 + mi;
  if (m < H(9, 30)) return { id: "preopen", label: "未开盘" };
  if (m < H(11, 30)) return { id: "intraday", label: "盘中" };
  if (m < H(13, 0)) return { id: "lunch", label: "午间休市" };
  if (m < H(15, 15)) return { id: "intraday", label: "盘中" };
  if (m < H(17, 0)) return { id: "futures_closed", label: "期货已收盘 · 现券交易中" };
  return { id: "closed", label: "今日已收盘" };
}

/** 数字格式化：收益率 4 位、期货 3 位、回购 3 位；bp 一律 1 位。 */
export function liveValText(q) {
  if (!q || !isNum(q.val)) return "—";
  return q.val.toFixed(q.dec || 2);
}

/** 变动文案：yield/repo 用 bp，index/price 用 %。正数带 + 号（与矩阵里的写法一致）。 */
export function liveChgText(q) {
  if (!q) return "";
  if (q.kind === "price" || q.kind === "index") {
    if (!isNum(q.pct)) return "";
    return `${q.pct > 0 ? "+" : ""}${q.pct.toFixed(2)}%`;
  }
  if (!isNum(q.bp)) return "";
  return `${q.bp > 0 ? "+" : ""}${q.bp.toFixed(1)}bp`;
}

/** 一句时点：「11:26:03 · 盘中」。日期与日终层重复时不再重复写年份。 */
export function liveTimeText(live, now) {
  const at = live && live.at ? new Date(live.at) : null;
  const d = at && isFinite(at.getTime()) ? at : (now ? new Date(now) : null);
  if (!d || !isFinite(d.getTime())) return "";
  const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${ss}`;
}

/**
 * 这份「此刻」还能不能叫「此刻」。
 * 跨日、或超过 maxAgeMs（默认 90 分钟）就不算 —— 缓存里的旧价冒充实时，
 * 比没有数据更糟：模型会把它当成「今天现在」写进结论，而屏幕上没有任何东西能看出来。
 * 90 分钟这个界不是随手取的：午休 11:30→13:00 正好 90 分钟，跨过它口径就换了一场。
 * @param {{at?:number}} live
 * @param {number} [nowMs]
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
export function liveFresh(live, nowMs, maxAgeMs) {
  const at = Number(live && live.at) || 0;
  if (!at) return false;
  const now = Number(nowMs) || Date.now();
  if (!isFinite(now) || now < at) return false;
  const d = new Date(at), n = new Date(now);
  if (d.getFullYear() !== n.getFullYear() || d.getMonth() !== n.getMonth() || d.getDate() !== n.getDate()) return false;
  return now - at <= (Number(maxAgeMs) || 90 * 60 * 1000);
}

/** 缺项文案：「缺 GC007、GC001」。空数组 → 空串（调用方据此不画那一行）。 */
export function liveMissText(live) {
  const miss = (live && Array.isArray(live.miss)) ? live.miss : [];
  if (!miss.length) return "";
  const nameOf = k => (LIVE_QUOTES.find(q => q.key === k) || {}).name || k;
  return `缺 ${miss.map(nameOf).join("、")}`;
}

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** 一格。dir 决定数字颜色（红涨绿跌），背景一律浅色 —— 此刻层不该抢日终矩阵的视觉重量。 */
function cellHtml(q) {
  const d = q.dir || "none";
  /* 指数是点位、期货是价格，都不该挂「%」；收益率与回购利率才带 */
  const unit = (q.kind === "price" || q.kind === "index") ? "" : "<i>%</i>";
  return `<div class="lv-i lv-${d}">
    <div class="lv-n">${esc(q.name)}</div>
    <div class="lv-v">${esc(liveValText(q))}${unit}</div>
    <div class="lv-d">${esc(liveChgText(q) || "—")}</div>
  </div>`;
}

/** 分时折线：viewBox 归一化，宽度自适应。点数 < 2 就不画（一个点连不成线）。
    ★ 颜色跟「当日涨跌」走（opts.dir），不跟「首点→末点」走：盘中价格可能高于开盘、
      却仍低于昨收，两种比较会给出相反的颜色 —— 同屏一红一绿，看的人只会以为哪里错了。 */
export function liveSparkHtml(pts, opts = {}) {
  if (!Array.isArray(pts) || pts.length < 2) return "";
  const w = 100, h = 30;
  const vs = pts.map(p => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const xy = pts.map((p, i) => {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((p[1] - lo) / span) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const first = pts[0][1], last = pts[pts.length - 1][1];
  const dir = opts.dir || (last > first ? "up" : last < first ? "down" : "flat");
  const cls = dir === "up" ? "lv-sp-up" : dir === "down" ? "lv-sp-down" : "lv-sp-flat";
  const label = opts.label || "T 主力当日分时";
  return `<div class="lv-sp">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="${cls}" aria-label="${esc(label)}">
      <polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="1.2"
        vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
    <div class="lv-sp-x"><span>${esc(pts[0][0])}</span><span>${esc(pts[pts.length - 1][0])}</span></div>
  </div>`;
}

/**
 * 「近期」一行：两个指数的 5 日 / 20 日累计涨跌。
 *
 * 为什么单独一行、不塞进格子里：格子是「今天」这一场的快照（3 行高），
 * 塞进第 4 行会把那两个格子顶高，整排网格错位；而且「5 日」和「当日」
 * 是两个时间尺度，摆在同一行里最容易被读成「今天 5 日都跌了 0.12%」。
 *
 * @param {Object|null} hist  {IDX_GZ: liveHistCalc(...), IDX_QZ: ...}
 * @param {{err?:string}} opts  err 非空且没有数据时，画一行灰字说明为什么没有
 */
export function liveHistHtml(hist, opts = {}) {
  const keys = IDX_HIST_KEYS;
  const parts = [];
  for (const k of keys) {
    const h = hist && hist[k];
    if (!h || !h.ok) continue;
    const spec = LIVE_QUOTES.find(q => q.key === k);
    const nm = (spec && spec.name) || k;
    const seg = [];
    if (isNum(h.d5)) seg.push(`<span class="lv-hs">5日 <i class="lv-${liveDirOf("index", h.d5)}">${esc(histPctText(h.d5))}</i></span>`);
    if (isNum(h.d20)) seg.push(`<span class="lv-hs">20日 <i class="lv-${liveDirOf("index", h.d20)}">${esc(histPctText(h.d20))}</i></span>`);
    if (!seg.length) continue;
    parts.push(`<span class="lv-hi"><b>${esc(nm)}</b>${seg.join("")}</span>`);
  }
  if (!parts.length) {
    if (!opts.err) return "";
    return `<div class="lv-hist lv-hist-err">5日 / 20日 变化这一次没取到：${esc(opts.err)}</div>`;
  }
  /* 补过今天就在标题上标出来 —— 否则读的人会以为「最新」是昨收，
     而旁边的当日涨跌是实时，两个基准日不同却不说明，是最难查的那种错。 */
  const synth = keys.some(k => hist && hist[k] && hist[k].ok && hist[k].synth);
  /* 一个成功一个失败时，不能把失败的悄悄藏起来 —— 只显示一行数字，
     读的人会以为两个指数都在里面。 */
  const miss = opts.err ? `<span class="lv-hist-miss">${esc(opts.err)}</span>` : "";
  /* 「含今日实时」放行尾而不是塞进标签：「近期（含今日实时）」比「近期」宽一倍，
     标签一长，悬挂缩进的宽度就得跟着变，换行后那两行就对不齐了。 */
  const syn = synth ? `<span class="lv-hist-syn">含今日实时</span>` : "";
  return `<div class="lv-hist"><span class="lv-hk">近期</span>${parts.join("")}${syn}${miss}</div>`;
}

/**
 * 整块 HTML。live 为 null（没取过）→ 只给一句「还没取过」+ 入口提示，不画空格子。
 * @param {object|null} live
 * @param {{now?:number, phase?:{id:string,label:string}, ageText?:string, busy?:boolean, err?:string, hist?:Object, histErr?:string}} opts
 */
export function liveBlockHtml(live, opts = {}) {
  const head = `<div class="lv-head">
      <b>此刻</b>
      <span class="lv-t">${live && live.at ? esc(liveTimeText(live)) : ""}${opts.phase && opts.phase.label ? ` · ${esc(opts.phase.label)}` : ""}</span>
    </div>`;
  /* 失败如实写在块里，不只靠 toast —— toast 三秒就没了，块里的字一直在。 */
  const err = opts.err
    ? `<div class="lv-err">这一次没取到：${esc(opts.err)}${live && live.at ? `（下面仍是 ${esc(liveTimeText(live))} 那次的数据）` : ""}</div>`
    : "";

  if (!live || !live.quotes || !Object.keys(live.quotes).length) {
    return `<div class="lv-wrap">${head}${err}
      <div class="lv-empty">还没取过此刻行情。点上面的「↻ 更新此刻」当场拉一次（约 1 秒），
        拿不到就照实说，不拿日终的数顶。</div>
    </div>`;
  }

  const st = liveStat(live);
  const miss = liveMissText(live);
  /* v119：「近期」紧贴指数格子下面 —— 它解释的就是上面那两个指数，
     放到整块末尾会离得太远，中间隔了利率、期货、回购三排。 */
  const histHtml = liveHistHtml(opts.hist, { err: opts.histErr });
  const groups = LIVE_GROUPS.map(g => {
    const cells = g.keys.map(k => live.quotes[k]).filter(Boolean).map(cellHtml).join("");
    if (!cells) return "";
    const extra = g.id === "index" ? histHtml : "";
    return `<div class="lv-g"><div class="lv-gt">${esc(g.title)}</div>
      <div class="lv-grid">${cells}</div>${extra}</div>`;
  }).join("");

  const age = opts.ageText ? `<span class="lv-age">${esc(opts.ageText)}</span>` : "";
  return `<div class="lv-wrap">
    ${head}${err}
    <div class="lv-sum">${st.up} 红 / ${st.down} 绿 / ${st.flat} 白<span class="lv-dot">·</span>${st.up + st.down + st.flat + st.none} 项${miss ? `<span class="lv-miss">${esc(miss)}</span>` : ""}${age}</div>
    ${groups}
    ${liveSparkHtml(live.trend || [], { dir: (live.quotes.T || {}).dir })}
    <div class="cap" style="padding-top:6px">此刻层来自东方财富行情，是盘中参考价，与下面「日终层」的中债估值口径不同，
      两者不做差、不互补。指数为<b>上证口径</b>（交易所竞价成交），不是中债估值指数；「近期」按交易日数对比，
      与当日涨跌基准不同，两者不能相加。企债指数成分成交清淡，全日不动是常态，看到 0.00% 不等于没取到。
      回购为交易所口径（GC 系列），不是银行间 DR007。</div>
  </div>`;
}

/** 缓存读写用的归一化：只留白名单字段，防止脏数据/超大对象写进 localStorage。 */
export function livePack(live, at) {
  if (!live || !live.quotes) return null;
  const quotes = {};
  for (const spec of LIVE_QUOTES) {
    const q = live.quotes[spec.key];
    if (!q) continue;
    quotes[spec.key] = {
      key: spec.key, name: spec.name, kind: spec.kind, dec: spec.dec,
      val: q.val, bp: q.bp, pct: q.pct, dir: q.dir,
    };
  }
  const trend = Array.isArray(live.trend)
    ? live.trend.filter(p => Array.isArray(p) && typeof p[0] === "string" && isNum(p[1])).slice(0, 300)
    : [];
  return {
    v: LIVE_VER, src: LIVE_SRC, at: Number(at) || Date.now(),
    quotes, trend, miss: Array.isArray(live.miss) ? live.miss.slice(0, 20) : [],
  };
}

/** 读回缓存：版本/来源不对，或结构不对 → null（当没缓存，不猜）。 */
export function liveUnpack(o) {
  if (!o || typeof o !== "object") return null;
  if (o.v !== LIVE_VER || o.src !== LIVE_SRC) return null;
  if (!o.quotes || typeof o.quotes !== "object") return null;
  const quotes = {};
  for (const spec of LIVE_QUOTES) {
    const q = o.quotes[spec.key];
    if (!q || !isNum(q.val)) continue;
    /* ★ 名称/种类/精度一律取本地清单，不认缓存里那份 —— localStorage 是可以被改的，
       方向和单位规则若跟着缓存走，改一个字段就能把绿刷成红。缓存只允许提供数值。 */
    const bp = isNum(q.bp) ? Number(q.bp) : null;
    const pct = isNum(q.pct) ? Number(q.pct) : null;
    quotes[spec.key] = {
      key: spec.key, name: spec.name, kind: spec.kind, dec: spec.dec,
      val: Number(q.val), bp, pct,
      /* 方向重算，不照抄缓存 —— 同上，符号是这功能的全部语义 */
      dir: liveDirOf(spec.kind, spec.kind === "price" ? pct : bp),
    };
  }
  if (!Object.keys(quotes).length) return null;
  return {
    v: LIVE_VER, src: LIVE_SRC, at: Number(o.at) || 0,
    quotes,
    trend: Array.isArray(o.trend) ? o.trend.filter(p => Array.isArray(p) && p.length === 2) : [],
    miss: Array.isArray(o.miss) ? o.miss.slice(0, 20) : [],
  };
}
