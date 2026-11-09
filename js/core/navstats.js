/* 逐源抓取耗时统计（v106 · 第 0 期「先量后调」）
   目的只有一个：给「单条源该等多长时间」提供本机实测分布，而不是拍脑袋定阈值。
   为什么单拆一个模块：这里全是纯函数，`node --test` 能直接跑；塞回 app.js 就只能
   靠源码断言，算错了也看不出来。

   形状（存 DATA.settings.fetchStats，随账本一起同步到私有仓，便于事后取数）：
     { v: 2, rounds: [ { t: 1712…, n: 3,
                         ms:   { bob: [820, 910] },      // 只收成功源的真实耗时
                         err:  { chinawealth: 1 },       // 失败（非超时）次数
                         tmo:  { chinawealth: 2 },       // 超时次数
                         seen: { bob: 3, chinawealth: 3 } // 参与次数（算率的分母）
                       } ] }

   三条收敛规则：
     1. rounds 只留最近 maxRounds 轮（默认 20）—— 统计是诊断用的，不该把账本撑大；
     2. 每源每轮最多留 PER_SRC_CAP 个样本 —— 正常一轮一只产品一个样本，超过就是数据脏了；
     3. 只收「非负有限整数毫秒」，别的值一律丢 —— 一个 NaN 就能把分位数整列算成 NaN。

   ⚠️ v105 → v106 为什么升版本、并且故意不认旧数据：
   失败源的 ms 不是真实耗时 —— 超时那条被 navservice 写成 SOURCE_BUDGET*1000（常量
   55000 占位），线程异常那条写成 0。v105 把这些值一起收进了 ms，实测一个超时样本
   就能把 P95 从 2.85s 拉到 55s（20 倍失真），而 P95 正是定预算要看的那个数。
   v106 起：ms 只收成功源；失败只计次数，并把「超时」与「其它失败」分开，另记
   seen（参与次数）以便算超时率。v1 历史里已经混了假样本，无法事后分辨，故整体
   作废重建 —— baseOf() 只认 NAVSTATS_VERSION，读到 v1 自动从空开始。 */

export const NAVSTATS_VERSION = 2;
export const NAVSTATS_MAX_ROUNDS = 20;
export const NAVSTATS_PER_SRC_CAP = 50;

/* 与 navservice.py 的超时文案对齐：「超过 %d 秒未返回，已放弃这条源」。
   认不出文案时按「其它失败」计，宁可少算超时率，也不把普通失败算成超时。 */
export const NAVSTATS_TMO_RE = /超过\s*\d+\s*秒未返回/;

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

/* 计数类字段（err / tmo / seen）：只留正整数，0 与脏值一并丢弃 */
function cleanCnt(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const src of Object.keys(obj)) {
    const n = num(obj[src]);
    if (n) out[String(src)] = n;
  }
  return out;
}

function cleanRound(round) {
  if (!round || typeof round !== "object") return null;
  const ms = cleanMs(round.ms);
  const err = cleanCnt(round.err);
  const tmo = cleanCnt(round.tmo);
  const seen = cleanCnt(round.seen);
  /* 空轮不进历史：只有「有耗时样本」或「有失败/超时计数」才算这一轮有信息。
     光有 seen 不算 —— 那说明这一轮一条源都没回来，没有可用的分布。 */
  if (!Object.keys(ms).length && !Object.keys(err).length && !Object.keys(tmo).length) return null;
  const t = num(round.t) || Date.now();
  const n = num(round.n);
  return { t, n: n === null ? 0 : n, ms, err, tmo, seen };
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

/** 汇总：逐源 { n, p50, p95, max, err, tmo, seen, tmoRate }，按样本数从多到少。
    p50/p95/max 只由成功源的 ms 算出；tmoRate = tmo / seen（seen 为 0 时记 0）。 */
export function navStatsSummary(stats) {
  const rounds = baseOf(stats);
  const acc = {};
  const get = src => acc[src] || (acc[src] = { src, all: [], err: 0, tmo: 0, seen: 0 });
  for (const r of rounds) {
    for (const src of Object.keys(r.ms || {})) {
      const a = get(src);
      for (const v of r.ms[src]) a.all.push(v);
    }
    for (const src of Object.keys(r.err || {})) get(src).err += r.err[src];
    for (const src of Object.keys(r.tmo || {})) get(src).tmo += r.tmo[src];
    for (const src of Object.keys(r.seen || {})) get(src).seen += r.seen[src];
  }
  return Object.values(acc).map(a => {
    const all = a.all.slice().sort((x, y) => x - y);
    return { src: a.src, n: all.length, err: a.err, tmo: a.tmo, seen: a.seen,
      /* 千分位取整，避免 0.30000000000000004 这种值进 JSON */
      tmoRate: a.seen ? Math.round((a.tmo / a.seen) * 1000) / 1000 : 0,
      p50: navStatsPct(all, 50), p95: navStatsPct(all, 95), max: all.length ? all[all.length - 1] : 0 };
  }).sort((x, y) => y.n - x.n || x.src.localeCompare(y.src));
}
