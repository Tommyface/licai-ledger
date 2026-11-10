/* ---------- 债市「此刻」层（v116） ----------
   与 v100 的「日终层」并列，不是一个东西，谁也不许替谁说话：

   · 日终层：中债官方收益率曲线，33 格矩阵，T-1 日终估值，云端每日生成（js/core/market.js）；
   · 此刻层：东方财富行情，10 项报价 + T 主力当日分时，盘中秒级，本机直连（本文件）。

   三条硬规矩（改动前先读）：
   1. 不做差。两层的 10Y 是两个口径（盘中参考价 / 中债估值），界面上不许互相加减，
      也不许拿一层的数去解释另一层的变化。
   2. 不互补。东财没有国开、口行、AAA/AA+/AA 的公开行情 —— 缺就是缺，绝不用国债顶。
   3. 不混合评分。这里不产出「温度分」：用户 2026-11-10 明确选了「只要信号灯」。
      任何加权、打分、预测都不要再加回来。

   数据通道：JSONP（`&cb=`）。走 <script> 标签，不受 CORS 限制，网页版与 App 内同一套。
   一个 ulist 请求拿全 10 项，另一个 trends2 请求拿分时 —— 一次点击两个请求，不批量扫。

   ★ 判据收口：解析、单位、方向、时点四条规则都在本文件，tests/livebond.test.mjs 是
     它们的对照表。改这里任何一条，先改测试。 */

/** 缓存 schema：结构变了就 +1，旧缓存自然作废（不做迁移，行情没有迁移的价值）。 */
export const LIVE_VER = 1;
/** 来源写死。将来换源时，旧缓存靠这个字段能被认出来并丢弃。 */
export const LIVE_SRC = "eastmoney";

/** 报价清单。顺序 = 界面顺序：利率 → 期货 → 资金。
    kind 决定单位与方向规则（见 liveDirOf）：
      yield 收益率（bp，下行算红） / price 期货价（%，上涨算红） / repo 回购利率（bp，上行算绿） */
export const LIVE_QUOTES = [
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
  { id: "rate", title: "国债收益率", keys: ["CN10Y", "CN30Y", "CN5Y", "CN2Y"] },
  { id: "fut", title: "国债期货", keys: ["TL", "T", "TF", "TS"] },
  { id: "cash", title: "交易所回购", keys: ["GC007", "GC001"] },
];

export const LIVE_API = {
  quote: "https://push2.eastmoney.com/api/qt/ulist.np/get",
  trend: "https://push2his.eastmoney.com/api/qt/stock/trends2/get",
};

/** 报价请求 URL：一个请求拿全 10 项（实测 total=10）。 */
export function liveQuoteUrl(cb) {
  const secids = LIVE_QUOTES.map(q => q.secid).join(",");
  return `${LIVE_API.quote}?fltt=2&invt=2&fields=f2,f3,f4,f12,f14&secids=${secids}&cb=${encodeURIComponent(cb)}`;
}

/** 分时请求 URL：T 主力当日逐分钟（实测 80 点）。 */
export function liveTrendUrl(cb) {
  return `${LIVE_API.trend}?secid=8.110130&fields1=f1,f2,f3&fields2=f51,f53&iscr=0&ndays=1&cb=${encodeURIComponent(cb)}`;
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
       price    ：f2 是价格（110.19），f4 是价格差（-0.04 点），f3 是相对涨跌（-0.04%） */
    const bp = spec.kind === "price" ? null : round(raw * 100, 2);
    const pct = spec.kind === "price" ? (isNum(x.f3) ? Number(x.f3) : 0) : null;
    out.quotes[spec.key] = {
      key: spec.key,
      name: spec.name,
      kind: spec.kind,
      dec: spec.dec,
      val: round(val, spec.dec),
      bp,
      pct,
      /* 方向在解析时就定下来，界面只照着画 —— 免得两处各算一遍算反 */
      dir: liveDirOf(spec.kind, spec.kind === "price" ? pct : bp),
    };
  }
  out.ok = Object.keys(out.quotes).length > 0;
  if (!out.ok) out.why = "10 项一项都没解析出来";
  return out;
}

/**
 * 方向：红=利多债市（价格涨），绿=利空，白=持平，none=没数据。
 * 沿用 market.js 的 MARKET_DIR_LABEL 语义，不另立一套。
 *   yield 收益率下行（bp<0）→ 红；repo 回购利率上行（bp>0）→ 绿；price 涨（pct>0）→ 红。
 */
export function liveDirOf(kind, v) {
  if (!isNum(v)) return "none";
  if (kind === "price") return v > 0 ? "up" : v < 0 ? "down" : "flat";
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

/** 变动文案：yield/repo 用 bp，price 用 %。正数带 + 号（与矩阵里的写法一致）。 */
export function liveChgText(q) {
  if (!q) return "";
  if (q.kind === "price") {
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
  return `<div class="lv-i lv-${d}">
    <div class="lv-n">${esc(q.name)}</div>
    <div class="lv-v">${esc(liveValText(q))}${q.kind === "price" ? "" : "<i>%</i>"}</div>
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
 * 整块 HTML。live 为 null（没取过）→ 只给一句「还没取过」+ 入口提示，不画空格子。
 * @param {object|null} live
 * @param {{now?:number, phase?:{id:string,label:string}, ageText?:string, busy?:boolean, err?:string}} opts
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
  const groups = LIVE_GROUPS.map(g => {
    const cells = g.keys.map(k => live.quotes[k]).filter(Boolean).map(cellHtml).join("");
    return cells ? `<div class="lv-g"><div class="lv-gt">${esc(g.title)}</div>
      <div class="lv-grid">${cells}</div></div>` : "";
  }).join("");

  const age = opts.ageText ? `<span class="lv-age">${esc(opts.ageText)}</span>` : "";
  return `<div class="lv-wrap">
    ${head}${err}
    <div class="lv-sum">${st.up} 红 / ${st.down} 绿 / ${st.flat} 白<span class="lv-dot">·</span>${st.up + st.down + st.flat + st.none} 项${miss ? `<span class="lv-miss">${esc(miss)}</span>` : ""}${age}</div>
    ${groups}
    ${liveSparkHtml(live.trend || [], { dir: (live.quotes.T || {}).dir })}
    <div class="cap" style="padding-top:6px">此刻层来自东方财富行情，是盘中参考价，与下面「日终层」的中债估值口径不同，
      两者不做差、不互补。回购为交易所口径（GC 系列），不是银行间 DR007。</div>
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
