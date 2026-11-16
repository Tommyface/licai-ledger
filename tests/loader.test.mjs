/* js/core/loader.js 专项回归（v141 · P1-1）
   测的是「八组数据源共用的那套骨架」——busy 去重 / TTL / 失败保留旧值 / 状态推进。
   这四条任何一条写错，八组数据都会一起坏，且都是「看起来没事、其实错了」的静默坏。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLoader, makeState } from "../js/core/loader.js";

const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const swSrc = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

const tick = () => new Promise(r => setTimeout(r, 0));

function make(cfg = {}) {
  let data = null;
  const state = makeState();
  return {
    state,
    data: () => data,
    setData: v => { data = v; },
    loader: createLoader(Object.assign({
      state, get: () => data, set: v => { data = v; }, ttl: 1000,
      run: async () => ({ v: 1 }),
    }, cfg)),
  };
}

test("makeState：四个字段齐备，可被覆盖", () => {
  const s = makeState({ extra: 7 });
  assert.deepEqual(s, { phase: "idle", at: 0, err: "", lastTry: 0, extra: 7 });
});

test("L-1 状态推进：idle → loading → ok，记录 at / lastTry", () => {
  const m = make();
  assert.equal(m.state.phase, "idle");
  const p = m.loader.refresh();
  assert.equal(m.state.phase, "loading", "发出后立刻是 loading");
  assert.ok(m.state.lastTry > 0, "lastTry 在发出时就记");
  return p.then(ok => {
    assert.equal(ok, true);
    assert.equal(m.state.phase, "ok");
    assert.ok(m.state.at >= m.state.lastTry, "at 不早于 lastTry");
    assert.deepEqual(m.data(), { v: 1 }, "成功写入数据");
  });
});

test("L-2 busy 去重：并发两次 refresh 只跑一次 run，复用同一 promise", () => {
  let calls = 0;
  let resolveRun;
  const m = make({ run: () => { calls++; return new Promise(r => { resolveRun = r; }); } });
  const p1 = m.loader.refresh();
  const p2 = m.loader.refresh();
  assert.equal(calls, 1, "在途期间第二次不另发");
  assert.equal(p1, p2, "两次拿到同一个 promise");
  assert.equal(m.loader.isBusy(), true);
  resolveRun({ v: 9 });
  return Promise.all([p1, p2]).then(() => {
    assert.equal(m.loader.isBusy(), false, "落定后 busy 复位");
    assert.deepEqual(m.data(), { v: 9 });
  });
});

test("L-3 失败保留旧值：run 抛错只推 err，data 不动", () => {
  let data = { old: true };
  const state = makeState();
  const loader = createLoader({
    state, get: () => data, set: v => { data = v; }, ttl: 1000,
    run: async () => { throw new Error("断网了，这是很长很长的错误信息应该被截断"); },
    errSlice: 6,
  });
  return loader.refresh({ silent: true }).then(ok => {
    assert.equal(ok, false);
    assert.equal(state.phase, "err");
    assert.equal(state.err.length, 6, "错误按 errSlice 截断");
    assert.deepEqual(data, { old: true }, "失败绝不清旧数据");
  });
});

test("L-4 run 返回 false 也当失败（与抛错同路径）", () => {
  const m = make({ run: async () => false });
  return m.loader.refresh({ silent: true }).then(ok => {
    assert.equal(ok, false);
    assert.equal(m.state.phase, "err");
    assert.match(m.state.err, /取数返回失败/);
    assert.equal(m.data(), null, "本来就没数据，失败后仍是 null");
  });
});

test("L-5 needRefresh：无数据要刷；有数据未过期不刷；过期要刷", () => {
  const m = make();
  const now = 100000;
  assert.equal(m.loader.needRefresh(now), true, "没数据必刷");
  m.setData({ v: 1 });
  m.state.lastTry = now - 999;
  assert.equal(m.loader.needRefresh(now), false, "999 秒前试过，未过 1000ms TTL");
  m.state.lastTry = now - 1001;
  assert.equal(m.loader.needRefresh(now), true, "过了 TTL 要刷");
});

test("L-6 onOk / onErr 副作用在正确路径各调一次", () => {
  let okN = 0, errN = 0;
  const state = makeState();
  const loader = createLoader({
    state, get: () => null, set: () => {}, ttl: 1000,
    run: async () => ({ v: 1 }),
    onOk: () => okN++, onErr: () => errN++,
  });
  return loader.refresh().then(() => {
    assert.equal(okN, 1); assert.equal(errN, 0);
    const s2 = makeState();
    const l2 = createLoader({
      state: s2, get: () => null, set: () => {}, ttl: 1000,
      run: async () => { throw new Error("x"); },
      onOk: () => okN++, onErr: () => errN++,
    });
    return l2.refresh({ silent: true }).then(() => {
      assert.equal(okN, 1); assert.equal(errN, 1);
    });
  });
});

test("L-7 视图引用稳定：state 对象身份在刷新前后不变", () => {
  const m = make();
  const ref = m.state;
  return m.loader.refresh().then(() => {
    assert.equal(m.state, ref, "state 引用不能被替换（消费点持有它）");
    assert.equal(ref.phase, "ok");
  });
});

/* ---------- 接线守卫：样板（MACRO）确实迁到了 loader ----------
   骨架本身测对了还不够 —— 得钉住 app.js 真的用它，否则下次改回手写八件套
   测试照样全绿。这条就是 P1-1 的「活证据」。 */
test("L-8 MACRO 样板接线：app.js 走 loader、MACRO_ST 用 makeState、SHELL 收 loader.js", () => {
  assert.match(appSrc, /from "\.\/js\/core\/loader\.js"/, "app.js 要 import loader");
  assert.match(appSrc, /const MACRO_ST = makeState\(\)/, "MACRO_ST 由 makeState 建（引用稳定）");
  assert.match(appSrc, /const macroLoader = createLoader\(/, "macro 装载器实例存在");
  assert.match(appSrc, /function macroRefresh\(opts = \{\}\) \{ return macroLoader\.refresh\(opts\); \}/,
    "macroRefresh 是薄适配，必须转发给 loader（不许改回手写 busy）");
  assert.ok(!/\blet _macroBusy\b/.test(appSrc), "手写 busy 变量已废弃，不该还在");
  assert.match(swSrc, /"\.\/js\/core\/loader\.js"/, "SHELL 漏 loader.js 会离线整页空白");
});
