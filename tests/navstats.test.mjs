/* v105 第 0 期：逐源耗时统计的纯函数单测（node --test tests/navstats.test.mjs）
   这一层的产出会被拿去定「单条源该等几秒」，算错了就会把快的源误砍、或把慢的源
   当成正常 —— 所以边界（空轮、脏值、滚动上限、分位数取整）必须钉住。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NAVSTATS_VERSION, NAVSTATS_MAX_ROUNDS, NAVSTATS_PER_SRC_CAP,
  navStatsPush, navStatsPct, navStatsSummary
} from "../js/core/navstats.js";

const round = (t, ms, err) => ({ t, n: 3, ms, err });

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
