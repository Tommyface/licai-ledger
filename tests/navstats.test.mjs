/* v106 第 0 期：逐源耗时统计的纯函数单测（node --test tests/navstats.test.mjs）
   这一层的产出会被拿去定「单条源该等几秒」，算错了就会把快的源误砍、或把慢的源
   当成正常 —— 所以边界（空轮、脏值、滚动上限、分位数取整）必须钉住。
   v106 追加：失败源不得进 ms（超时的 55000 是常量占位、线程异常的 0 是假值），
   超时与其它失败分开计，seen 做超时率分母。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NAVSTATS_VERSION, NAVSTATS_MAX_ROUNDS, NAVSTATS_PER_SRC_CAP, NAVSTATS_TMO_RE,
  navStatsPush, navStatsPct, navStatsSummary
} from "../js/core/navstats.js";

const round = (t, ms, err, tmo, seen) => ({ t, n: 3, ms, err, tmo, seen });

test("一轮样本：版本号、轮次、逐源毫秒原样保留", () => {
  const s = navStatsPush(null, round(1000, { bob: [820, 910] }));
  assert.equal(s.v, NAVSTATS_VERSION);
  assert.equal(s.rounds.length, 1);
  assert.deepEqual(s.rounds[0].ms.bob, [820, 910]);
  assert.equal(s.rounds[0].t, 1000);
  assert.equal(s.rounds[0].n, 3);
});

test("滚动上限：推 25 轮只留最近 20 轮，且保留的是后 20 轮", () => {
  let s = null;
  for (let i = 1; i <= 25; i++) s = navStatsPush(s, round(i, { bob: [i] }));
  assert.equal(s.rounds.length, NAVSTATS_MAX_ROUNDS);
  assert.equal(s.rounds[0].t, 6);                    /* 第 1~5 轮被淘汰 */
  assert.equal(s.rounds[s.rounds.length - 1].t, 25);
});

test("每源每轮样本上限：塞 80 个只留前 50 个", () => {
  const many = Array.from({ length: 80 }, (_, i) => 100 + i);
  const s = navStatsPush(null, round(1, { bob: many }));
  assert.equal(s.rounds[0].ms.bob.length, NAVSTATS_PER_SRC_CAP);
  assert.equal(s.rounds[0].ms.bob[0], 100);
});

test("脏值一律丢：NaN / Infinity / 负数 / 字符串 / null 都不进样本", () => {
  const s = navStatsPush(null, round(1, { bob: [NaN, Infinity, -1, "abc", null, 0, 12.7] }));
  assert.deepEqual(s.rounds[0].ms.bob, [0, 13]);      /* 只留合法值，且四舍五入 */
});

test("整轮没有有效样本：不产生空轮，原对象原样返回（引用相等）", () => {
  const base = navStatsPush(null, round(1, { bob: [100] }));
  const same = navStatsPush(base, round(2, { bob: [NaN, -5] }, {}));
  assert.equal(same, base, "空轮不该推进历史，也不该换对象");
  const empty = navStatsPush(null, round(1, {}));
  assert.equal(empty.rounds.length, 0);
});

test("坏 prev（版本不符 / 结构不对）按空历史重建，不抛异常", () => {
  for (const bad of [null, undefined, {}, { v: 0, rounds: [] }, { v: NAVSTATS_VERSION, rounds: "x" }]) {
    const s = navStatsPush(bad, round(1, { bob: [10] }));
    assert.equal(s.rounds.length, 1);
    assert.equal(s.v, NAVSTATS_VERSION);
  }
});

test("不改入参：push 之后旧对象仍是旧的", () => {
  const base = navStatsPush(null, round(1, { bob: [10] }));
  const before = JSON.stringify(base);
  navStatsPush(base, round(2, { bob: [20] }));
  assert.equal(JSON.stringify(base), before);
});

test("分位数取最近秩：1..10 的 p50=5 / p95=10；空数组为 0", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(navStatsPct(a, 50), 5);
  assert.equal(navStatsPct(a, 95), 10);
  assert.equal(navStatsPct(a, 100), 10);
  assert.equal(navStatsPct(a, 0), 1);
  assert.equal(navStatsPct([], 50), 0);
  assert.equal(navStatsPct([7], 95), 7);
});

test("汇总：跨轮合并样本、失败次数单独累加、按样本数降序", () => {
  let s = navStatsPush(null, round(1, { bob: [100, 300], chinawealth: [50] }, { chinawealth: 1 }));
  s = navStatsPush(s, round(2, { bob: [200, 400], chinawealth: [70] }, { chinawealth: 2 }));
  const sum = navStatsSummary(s);
  assert.deepEqual(sum.map(x => x.src), ["bob", "chinawealth"]);

  const bob = sum[0];
  assert.equal(bob.n, 4);
  assert.equal(bob.p50, 200);
  assert.equal(bob.p95, 400);
  assert.equal(bob.max, 400);
  assert.equal(bob.err, 0);

  const cw = sum[1];
  assert.equal(cw.n, 2);
  assert.equal(cw.p50, 50);
  assert.equal(cw.max, 70);
  assert.equal(cw.err, 3);
});

test("汇总：空统计返回空数组（状态文案据此不出那一行）", () => {
  assert.deepEqual(navStatsSummary(null), []);
  assert.deepEqual(navStatsSummary({ v: NAVSTATS_VERSION, rounds: [] }), []);
});

/* ---------- v106 追加：失败源净化 / 超时率 / 旧版本作废 ---------- */

test("超时文案正则：认 navservice 的原句，不认普通失败", () => {
  assert.equal(NAVSTATS_TMO_RE.test("超过 55 秒未返回，已放弃这条源"), true);
  assert.equal(NAVSTATS_TMO_RE.test("超过55秒未返回"), true);
  assert.equal(NAVSTATS_TMO_RE.test("HTTP 404 Not Found"), false);
  assert.equal(NAVSTATS_TMO_RE.test("未取到净值"), false);
  assert.equal(NAVSTATS_TMO_RE.test(""), false);
});

test("v1 历史整体作废：读到旧版本号从空开始（旧数据混了 55000 占位，无法事后分辨）", () => {
  const v1 = { v: 1, rounds: [{ t: 1, n: 3, ms: { bob: [2300, 55000] }, err: {} }] };
  const s = navStatsPush(v1, round(2, { bob: [2400] }));
  assert.equal(s.v, NAVSTATS_VERSION);
  assert.equal(s.rounds.length, 1, "旧轮次必须清零，只留新入的这一轮");
  assert.deepEqual(s.rounds[0].ms.bob, [2400]);
  assert.deepEqual(navStatsSummary(v1), [], "汇总也不认旧版本");
});

test("tmo / seen 原样累加，tmoRate = tmo/seen 且千分位取整", () => {
  let s = navStatsPush(null, round(1, { bob: [900] }, {}, { chinawealth: 1 }, { bob: 2, chinawealth: 2 }));
  s = navStatsPush(s, round(2, { bob: [950] }, {}, { chinawealth: 1 }, { bob: 2, chinawealth: 2 }));
  const sum = navStatsSummary(s);
  const bob = sum.find(x => x.src === "bob");
  const cw = sum.find(x => x.src === "chinawealth");
  assert.equal(bob.seen, 4); assert.equal(bob.tmo, 0); assert.equal(bob.tmoRate, 0);
  assert.equal(cw.seen, 4); assert.equal(cw.tmo, 2);
  assert.equal(cw.tmoRate, 0.5, "2/4 = 0.5");
  assert.equal(cw.n, 0, "没有成功样本时 n 为 0，P50/P95 不得凭空出现");
  assert.equal(cw.p50, 0); assert.equal(cw.p95, 0);
});

test("超时率不会因除零变 NaN：seen 为 0 时记 0", () => {
  const s = navStatsPush(null, round(1, { bob: [100] }, { aixhub: 1 }));
  const aix = navStatsSummary(s).find(x => x.src === "aixhub");
  assert.equal(aix.seen, 0);
  assert.equal(aix.tmoRate, 0);
  assert.equal(Number.isNaN(aix.tmoRate), false);
});

test("只有 seen 没有样本也没有失败：不算有效轮次，不推进历史", () => {
  const base = navStatsPush(null, round(1, { bob: [100] }));
  const same = navStatsPush(base, round(2, {}, {}, {}, { bob: 3 }));
  assert.equal(same, base, "纯 seen 轮次没有分布信息，不该占一格");
});

test("失败源即使带着 55000 / 0 的假 ms，只要标了 error 就不该出现（调用方契约）", () => {
  /* 这条钉的是口径本身：ms 只由「无 error 的源」提供。
     模拟前端产出的 round，确认 55000 这种常量不会污染 P95。 */
  const clean = { bob: [2300, 2600, 2850] };              /* 只有成功源 */
  const s = navStatsPush(null, round(1, clean, {}, { chinawealth: 1 }, { bob: 3, chinawealth: 3 }));
  const bob = navStatsSummary(s).find(x => x.src === "bob");
  assert.equal(bob.p95, 2850, "P95 必须是 2.85s，不是 55s");
  assert.equal(bob.max, 2850);
});
