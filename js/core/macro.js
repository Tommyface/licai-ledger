/* ---------- 宏观层（v118 · 第一批）----------
   CPI / PPI / 制造业 PMI 的最新实际值，本机直连东方财富数据中心。

   为什么单独一层，不塞进「此刻」也不塞进「日终」：
   · 此刻层是盘中价格，秒级变；日终层是 T-1 的债券估值曲线，每天一次；
   · 宏观是**月度统计**，一个月才变一次，且口径是「同比%」或「指数值」，
     与前两层任何一个数字都不能相加减。
   三层各自带时点，谁也不许替谁说话。

   ★ 三条纪律：

     1. **只报实际值，不报「超预期 / 低于预期」。** 预期值在付费终端（Wind 一致预期），
        免费源只给实际值。写「低于预期」就是替一个我们没查到的数下结论 ——
        模型说得再顺，也是编的。这条与 brief 的白名单是同一件事。

     2. **不染色。** CPI 上行通常被读作「利空债市」，但 PPI 上行可能是需求回暖、
        也可能只是基数；PMI 49.3 的「上行」与 50.2 的「上行」含义还不一样
        （一个在荣枯线下抬头，一个已在线上的扩张）。染色等于替用户下判断，
        而这里只有三行数，撑不起那个判断。给箭头与差值，不给红绿。

     3. **数据滞后的要说出来。** 月度数据本来就要滞后一个月（11 月看到 10 月），
        这算正常；滞后两个月以上就是源出问题了，界面上得标出来，
        不能让「0.7%」看起来像是这个月的。

   通道：datacenter-web 支持 `callback=` 的 JSONP，也带 `Access-Control-Allow-Origin: *`。
   走 JSONP 与此刻层同一套 <script> 机制，不依赖 CORS 预检，App 内同样可用。

   ★ 判据收口：解析与口径都在本文件，tests/macro.test.mjs 是对照表。 */

/** 缓存 schema：结构变了 +1。 */
export const MACRO_VER = 1;
/** 来源写死，换源时旧缓存能被认出来。 */
export const MACRO_SRC = "eastmoney_datacenter";

/** 正常滞后：11 月看到 10 月数据是常态（统计局每月 9 日左右公布上月数）。 */
export const MACRO_LAG_OK = 1;
/** 超过这个月数就标「数据滞后」。 */
export const MACRO_LAG_MAX = 2;

/**
 * 三个指标。字段名来自接口实测（2026-11-10）：
 *   RPT_ECONOMY_CPI  NATIONAL_SAME  同比（0.7 = 0.7%）
 *   RPT_ECONOMY_PPI  BASE_SAME      同比（5.7 = 5.7%）
 *   RPT_ECONOMY_PMI  MAKE_INDEX     制造业 PMI 指数值（49.3，不是百分比）
 */
export const MACRO_ITEMS = [
  { key: "CPI", name: "CPI 同比", report: "RPT_ECONOMY_CPI", field: "NATIONAL_SAME",
    dec: 1, unit: "%", kind: "yoy" },
  { key: "PPI", name: "PPI 同比", report: "RPT_ECONOMY_PPI", field: "BASE_SAME",
    dec: 1, unit: "%", kind: "yoy" },
  { key: "PMI", name: "制造业 PMI", report: "RPT_ECONOMY_PMI", field: "MAKE_INDEX",
    dec: 1, unit: "", kind: "index" },
];

export const MACRO_API = "https://datacenter-web.eastmoney.com/api/data/v1/get";

/** 取多少期：13 期够看一整年的同比轨迹。体量实测约 1.5 KB/项。 */
export const MACRO_PAGES = 13;

/**
 * 单项请求 URL。
 * @param {{report:string, field:string, key:string}} item
 * @param {string} cb JSONP 回调名
 */
export function macroUrl(item, cb) {
  const cols = `REPORT_DATE,TIME,${item.field}`;
  return `${MACRO_API}?reportName=${item.report}`
    + `&columns=${encodeURIComponent(cols)}`
    + `&pageNumber=1&pageSize=${MACRO_PAGES}`
    + `&sortColumns=REPORT_DATE&sortTypes=-1`
    + `&source=WEB&client=WEB&callback=${encodeURIComponent(cb)}`;
}

const isNum = v => typeof v === "number" && isFinite(v);
const round = (v, n) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);

/**
 * 解析单项。
 * 倒序返回 → 按 period 正序排；坏行跳过，不整包拒收（与此刻层同一取舍：
 * 三个指标互相独立，一项坏了不该把另两项也扔掉）。
 *
 * @param {any} json 接口原文
 * @param {{key:string, field:string, dec:number, unit:string, kind:string, name:string}} item
 * @returns {{key:string, ok:boolean, why:string, series:Array<{period:string,val:number}>,
 *   latest:null|{period:string,val:number}, prev:null|{period:string,val:number}}}
 */
export function macroParse(json, item) {
  const out = { key: item.key, ok: false, why: "", series: [], latest: null, prev: null };
  const arr = json && json.result && Array.isArray(json.result.data) ? json.result.data : null;
  if (!arr) {
    /* 接口失败时给的是 {success:false, message:"报表配置不存在,..."} —— 把原话带出来，
       比「解析失败」有用得多：改 reportName 的时候一眼知道是名字错了。 */
    const msg = json && json.message ? String(json.message).slice(0, 80) : "";
    out.why = msg ? `接口报错：${msg}` : "返回里没有 result.data（接口结构变了）";
    return out;
  }
  const seen = {};
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const d = String(row.REPORT_DATE || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const v = row[item.field];
    if (!isNum(v)) continue;
    const period = d.slice(0, 7);
    if (seen[period]) continue;
    seen[period] = 1;
    out.series.push({ period, val: round(v, item.dec) });
  }
  out.series.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  if (!out.series.length) { out.why = "一条可用的期数都没有"; return out; }
  out.latest = out.series[out.series.length - 1];
  out.prev = out.series.length > 1 ? out.series[out.series.length - 2] : null;
  out.ok = true;
  return out;
}

/**
 * 数据滞后几个月（以 2026-11 看 2026-10 的数据为 1）。
 * 用于把「正常滞后」与「源停了」分开：两者在屏幕上都只是一行数字。
 * @param {string} period YYYY-MM
 * @param {string} today YYYY-MM-DD 或 YYYY-MM
 */
export function macroLagMonths(period, today) {
  const p = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  const t = /^(\d{4})-(\d{2})/.exec(String(today || ""));
  if (!p || !t) return NaN;
  return (Number(t[1]) * 12 + Number(t[2])) - (Number(p[1]) * 12 + Number(p[2]));
}

/** 「2026-10」→「2026年10月」。不合法就原样返回。 */
export function macroPeriodText(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  return m ? `${m[1]}年${Number(m[2])}月` : String(period || "");
}

/** 差值文案：PMI 用「点」，同选用「个百分点」。 */
export function macroDeltaText(cur, prev, item) {
  if (!isNum(cur) || !isNum(prev)) return "";
  const d = round(cur - prev, 1);
  if (d === 0) return "持平";
  const unit = item && item.kind === "index" ? "点" : "个百分点";
  return `${d > 0 ? "+" : ""}${d.toFixed(1)}${unit}`;
}

/** 值文案：CPI/PPI 带 %，PMI 不带（它是指数值）。 */
export function macroValText(v, item) {
  if (!isNum(v)) return "—";
  const s = v.toFixed((item && item.dec) || 1);
  return (item && item.unit) ? s + item.unit : s;
}

/** 单行迷你走势（13 期）。点数 < 2 不画。颜色固定中性灰 —— 见文件头第 2 条。 */
export function macroSpark(series) {
  const arr = Array.isArray(series) ? series.filter(p => p && isNum(p.val)) : [];
  if (arr.length < 2) return "";
  const w = 84, h = 18;
  const vs = arr.map(p => p.val);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const pts = arr.map((p, i) => {
    const x = (i / (arr.length - 1)) * w;
    const y = h - ((p.val - lo) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="mc-sp" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.2"
      vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/**
 * 三行表。macro 形如 { CPI:{...}, PPI:{...}, PMI:{...} }（各项是 macroParse 的产出）。
 * 全都没取到 → 空串（不画一张空表）。
 * @param {Record<string, any>} macro
 * @param {{today?:string, atText?:string, err?:string}} [opts]
 */
export function macroBlockHtml(macro, opts = {}) {
  const m = macro && typeof macro === "object" ? macro : {};
  const rows = [];
  let okCount = 0;
  let oldest = "";
  for (const item of MACRO_ITEMS) {
    const x = m[item.key];
    if (!x || !x.ok || !x.latest) {
      rows.push(`<tr class="mc-miss"><th>${esc(item.name)}</th>
        <td colspan="3">${esc((x && x.why) || "没取到")}</td><td></td></tr>`);
      continue;
    }
    okCount += 1;
    if (!oldest || x.latest.period < oldest) oldest = x.latest.period;
    const lag = macroLagMonths(x.latest.period, opts.today || "");
    const lagBad = isFinite(lag) && lag > MACRO_LAG_MAX;
    rows.push(`<tr>
      <th>${esc(item.name)}</th>
      <td class="mc-v">${esc(macroValText(x.latest.val, item))}</td>
      <td class="mc-p">${esc(macroPeriodText(x.latest.period))}${lagBad ? `<i class="mc-lag">滞后 ${lag} 个月</i>` : ""}</td>
      <td class="mc-d">${esc(macroDeltaText(x.latest.val, x.prev && x.prev.val, item) || "—")}</td>
      <td class="mc-s">${macroSpark(x.series)}</td>
    </tr>`);
  }
  if (!okCount) {
    const why = opts.err ? `这一次没取到：${opts.err}` : "三项都没取到";
    return `<div class="mc-wrap"><div class="mc-t">宏观<span class="mc-x">CPI / PPI / PMI</span></div>
      <div class="mc-empty">${esc(why)}</div></div>`;
  }
  return `<div class="mc-wrap">
    <div class="mc-t">宏观<span class="mc-x">CPI / PPI / PMI · 月度实际值${opts.atText ? ` · 本机 ${esc(opts.atText)}` : ""}</span></div>
    <table class="mkt-tbl mc-tbl">
      <tr><th>指标</th><th>最新</th><th>数据月份</th><th>较上期</th><th></th></tr>
      ${rows.join("")}
    </table>
    <div class="cap" style="padding-top:3px">来源：东方财富数据中心（转引国家统计局）。<b>只报实际值</b> ——
      预期值在付费终端，本项目没有，所以不写「超预期 / 低于预期」。
      PMI 是指数值，50 为荣枯线；CPI / PPI 是同比。</div>
  </div>`;
}

/** 缓存归一化：只留白名单字段。 */
export function macroPack(macro, at) {
  if (!macro || typeof macro !== "object") return null;
  /** @type {Record<string, any>} */
  const out = {};
  let any = false;
  for (const item of MACRO_ITEMS) {
    const x = macro[item.key];
    if (!x || !x.ok || !x.latest) continue;
    const series = Array.isArray(x.series)
      ? x.series.filter(p => p && /^\d{4}-\d{2}$/.test(String(p.period)) && isNum(p.val)).slice(-MACRO_PAGES)
      : [];
    if (!series.length) continue;
    out[item.key] = {
      key: item.key, ok: true, why: "",
      series,
      latest: series[series.length - 1],
      prev: series.length > 1 ? series[series.length - 2] : null,
    };
    any = true;
  }
  if (!any) return null;
  return { v: MACRO_VER, src: MACRO_SRC, at: Number(at) || Date.now(), items: out };
}

/** 读回缓存：版本/来源不对或结构不对 → null（当没缓存，不猜）。 */
export function macroUnpack(o) {
  if (!o || typeof o !== "object") return null;
  if (o.v !== MACRO_VER || o.src !== MACRO_SRC) return null;
  if (!o.items || typeof o.items !== "object") return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const item of MACRO_ITEMS) {
    const x = o.items[item.key];
    if (!x || !Array.isArray(x.series) || !x.series.length) continue;
    const series = x.series
      .filter(p => p && /^\d{4}-\d{2}$/.test(String(p.period)) && isNum(p.val))
      .map(p => ({ period: String(p.period), val: Number(p.val) }));
    if (!series.length) continue;
    series.sort((a, b) => (a.period < b.period ? -1 : 1));
    /* 与此刻层同一个理由：周期与数值可以来自缓存，但「哪一项叫什么、单位是什么」
       一律取本地清单 —— 缓存改一个字段就能让 PMI 显示成百分比。 */
    out[item.key] = {
      key: item.key, ok: true, why: "", series,
      latest: series[series.length - 1],
      prev: series.length > 1 ? series[series.length - 2] : null,
    };
  }
  if (!Object.keys(out).length) return null;
  return out;
}

/**
 * 研判里那一段。约 150 字，只给三个数与它们的月份。
 * 不给「超预期」、不给方向判断、不给「通胀压力」这类结论词 —— 那是模型该在
 * 看到数之后自己组织的话，不是我们预先替它写好的。
 */
export function macroText(macro) {
  const m = macro && typeof macro === "object" ? macro : {};
  const parts = [];
  for (const item of MACRO_ITEMS) {
    const x = m[item.key];
    if (!x || !x.ok || !x.latest) continue;
    const d = macroDeltaText(x.latest.val, x.prev && x.prev.val, item);
    parts.push(`${item.name} ${macroValText(x.latest.val, item)}（${macroPeriodText(x.latest.period)}`
      + (d ? `，较上期 ${d}` : "") + "）");
  }
  if (!parts.length) return "";
  return "【宏观】" + parts.join("；")
    + "。这是月度实际值，没有预期值可比，不许写「超预期 / 低于预期」，也不许据此推断下次数据。";
}
