/* 本机抓取提速 v101（公开仓侧）的接线测试：node --test tests/nativefetch.test.mjs
   守三条时序/裁剪契约（与私有仓 navservice.py 的同一条契约的两半）：
     1. 秒讯/净值账本之外，净值抓取载荷还要带上基准三字段（benchmark/benchRule/benchSrc）
        —— 私有仓 navservice 据此裁掉 leyiw（净值瞭望）这条「恒不带净值」的源；
        基准已齐再查它就是纯等待（实测 2~4 秒/只）。
     2. 规则/登记编码回填不再串在每只产品的 runOne 尾部 —— 一只慢的回填（徽银
        逐页翻列表）会占住并发 worker，把排在后面的产品净值一起拖住；
        现在净值先全部出完，回填统一垫后，仍按并发 2 跑。
     3. 「列表索引热」的收益不丢：回填段紧跟净值阶段，官网源的进程内缓存仍热。
   断言方式与 handlers.test.mjs 同一招：读 app.js 源码做结构断言 ——
   这一层是纯接线（调谁、什么时候调），跑不起 DOM，源码断言就是最直接的证据。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

/* nativeFetchAll 函数体（从签名到下一个顶层 async function / const 声明） */
function nativeFetchAllBody() {
  const i = app.indexOf("async function nativeFetchAll(");
  assert.ok(i > 0, "app.js 里找不到 nativeFetchAll");
  const j = app.indexOf("\nasync function ", i + 10);
  return app.slice(i, j > 0 ? j : undefined);
}

/* runOne 内嵌函数体（runOne 声明到收尾 try 块之前） */
function runOneBody() {
  const body = nativeFetchAllBody();
  const i = body.indexOf("const runOne = async p => {");
  assert.ok(i > 0, "nativeFetchAll 里找不到 runOne");
  const j = body.indexOf("  try {\n    let i = 0;", i);
  assert.ok(j > i, "runOne 与 worker 循环的边界找不到（结构变了要同步改测试）");
  return body.slice(i, j);
}

function tailBody() {
  const body = nativeFetchAllBody();
  const i = body.indexOf("  try {\n    let i = 0;");
  assert.ok(i > 0, "找不到 worker 循环");
  return body.slice(i);
}

test("载荷带基准三字段（leyiw 裁剪的依据，私有仓 navservice 同一条契约）", () => {
  const i = app.indexOf("function nativeNavFetch(");
  assert.ok(i > 0, "找不到 nativeNavFetch");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 10));
  for (const k of ["benchmark", "benchRule", "benchSrc"]) {
    assert.ok(src.includes(`benchmark` ) || src.includes(k), `nativeNavFetch 载荷缺 ${k}`);
    assert.ok(new RegExp(`${k}:`).test(src), `nativeNavFetch 载荷缺 ${k}: 字段`);
  }
});

test("runOne 内不再做规则/登记编码回填（回填挪出净值 worker）", () => {
  const body = runOneBody();
  assert.ok(!body.includes("autoFillRules("), "runOne 里还在调 autoFillRules —— 慢回填会占住 worker 拖住后面的产品");
  assert.ok(!body.includes("autoFillRegCode("), "runOne 里还在调 autoFillRegCode");
  assert.ok(!body.includes("rulesDue("), "runOne 里还在判 rulesDue（回填决策应整体挪到净值阶段后）");
  assert.ok(!body.includes("regCodeDue("), "runOne 里还在判 regCodeDue");
});

test("净值阶段结束后统一回填，仍按并发 2 跑，ruleNotes/regNotes 照常落字据", () => {
  const tail = tailBody();
  for (const fn of ["autoFillRules(", "autoFillRegCode("]) {
    assert.ok(tail.includes(fn), `收尾段缺 ${fn}（回填逻辑不能凭空消失）`);
  }
  assert.ok(tail.includes("rulesDue(") && tail.includes("regCodeDue("),
    "收尾段要按 rulesDue/regCodeDue 重新筛一遍需回填的产品");
  assert.ok(/Array\.from\(\{\s*length:\s*Math\.min\(2,/.test(tail),
    "回填段应与净值阶段同口径按并发 2 跑");
  /* 回填必须在 Promise.all(workers) 之后 */
  const iWorkers = tail.indexOf("await Promise.all(workers)");
  const iRules = tail.indexOf("autoFillRules(");
  assert.ok(iWorkers > 0 && iRules > iWorkers, "回填段必须排在净值 workers 全部完成之后");
});

test("manual 状态条仍统计回填产出（回填挪位不能把字据弄丢）", () => {
  const body = nativeFetchAllBody();
  assert.ok(body.includes("ruleNotes") && body.includes("regNotes"),
    "nativeFetchAll 里丢了 ruleNotes/regNotes");
});
