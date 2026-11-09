/* 逐源抓取耗时统计（v105 · 第 0 期「先量后调」）
   目的只有一个：给「单条源该等多长时间」提供本机实测分布，而不是拍脑袋定阈值。
   为什么单拆一个模块：这里全是纯函数，`node --test` 能直接跑；塞回 app.js 就只能
   靠源码断言，算错了也看不出来。

   形状（存 DATA.settings.fetchStats，随账本一起同步到私有仓，便于事后取数）：
     { v: 1, rounds: [ { t: 1712…, n: 3,
                         ms:  { bob: [820, 910], chinawealth: [2310] },
                         err: { chinawealth: 1 } } ] }

   三条收敛规则：
     1. rounds 只留最近 maxRounds 轮（默认 20）—— 统计是诊断用的，不该把账本撑大；
     2. 每源每轮最多留 PER_SRC_CAP 个样本 —— 正常一轮一只产品一个样本，超过就是数据脏了；
     3. 只收「非负有限整数毫秒」，别的值一律丢 —— 一个 NaN 就能把分位数整列算成 NaN。
   ⚠️ 失败源只有「同一只产品里另一条源取到了净值」时才会带 ms 回来（navservice
   的 ok=false 整只失败分支不回 sources）。所以这份分布偏乐观，超时样本要等 APP 侧
   navservice 补 sources 之后才齐 —— 这是本期刻意不动的部分。 */

export const NAVSTATS_VERSION = 1;
export const NAVSTATS_MAX_ROUNDS = 20;
export const NAVSTATS_PER_SRC_CAP = 50;

function num(v) {
  /* null / "" / 布尔都要先挡掉：Number(null)===0、Number("")===0，
     放进来就会凭空多出一条「0 毫秒」的样本，把 P50 直接拉到地上。 */
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function cleanMs(ms) {
  const out = {};
  if (!ms || typeof ms !== "object") return out;
  for (const src of Object.keys(ms)) {
    const arr = ms[src];
    if (!Array.isArray(arr)) continue;
    const keep = [];
    for (const v of arr) {
      const n = num(v);
      if (n !== null) keep.push(n);
      if (keep.length >= NAVSTATS_PER_SRC_CAP) break;
    }
    if (keep.length) out[String(src)] = keep;
  }
  return out;
}

function cleanErr(err) {
  const out = {};
  if (!err || typeof err !== "object") return out;
  for (const src of Object.keys(err)) {
    const n = num(err[src]);
    if (n) out[String(src)] = n;
  }
  return out;
}

function cleanRound(round) {
  if (!round || typeof round !== "object") return null;
  const ms = cleanMs(round.ms);
  const err = cleanErr(round.err);
  if (!Object.keys(ms).length && !Object.keys(err).length) return null;   /* 空轮不进历史 */
  const t = num(round.t) || Date.now();
  const n = num(round.n);
  return { t, n: n === null ? 0 : n, ms, err };
}

function baseOf(prev) {
  if (prev && prev.v === NAVSTATS_VERSION && Array.isArray(prev.rounds)) return prev.rounds;
  return [];
}

/** 追加一轮，返回新对象（不改入参）。空轮或非法输入原样返回 prev。 */
export function navStatsPush(prev, round, maxRounds = NAVSTATS_MAX_ROUNDS) {
  const r = cleanRound(round);
  const rounds = baseOf(prev);
  if (!r) return prev && prev.v === NAVSTATS_VERSION ? prev : { v: NAVSTATS_VERSION, rounds: [] };
  const cap = Math.max(1, num(maxRounds) || NAVSTATS_MAX_ROUNDS);
  return { v: NAVSTATS_VERSION, rounds: rounds.concat([r]).slice(-cap) };
}

/** 升序数组的最近秩分位数（p 取 0~100）。空数组返回 0。 */
export function navStatsPct(sortedAsc, p) {
  const arr = Array.isArray(sortedAsc) ? sortedAsc : [];
  if (!arr.length) return 0;
  const q = Math.min(100, Math.max(0, Number(p) || 0));
  const idx = Math.ceil((q / 100) * arr.length) - 1;
  return arr[Math.min(arr.length - 1, Math.max(0, idx))];
}

/** 汇总：逐源 { n, p50, p95, max, err }，按样本数从多到少。给状态文案与取数用。 */
export function navStatsSummary(stats) {
  const rounds = baseOf(stats);
  const acc = {};
  for (const r of rounds) {
    for (const src of Object.keys(r.ms || {})) {
      const a = acc[src] || (acc[src] = { src, all: [], err: 0 });
      for (const v of r.ms[src]) a.all.push(v);
    }
    for (const src of Object.keys(r.err || {})) {
      const a = acc[src] || (acc[src] = { src, all: [], err: 0 });
      a.err += r.err[src];
    }
  }
  return Object.values(acc).map(a => {
    const all = a.all.slice().sort((x, y) => x - y);
    return { src: a.src, n: all.length, err: a.err,
      p50: navStatsPct(all, 50), p95: navStatsPct(all, 95), max: all.length ? all[all.length - 1] : 0 };
  }).sort((x, y) => y.n - x.n || x.src.localeCompare(y.src));
}
