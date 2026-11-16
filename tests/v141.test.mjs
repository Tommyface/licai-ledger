/* v141 专项回归：三项优化（P0-1 版本钉收敛 / P0-2 测试单一来源 / P1-1 装载器样板）
   ─────────────────────────────────────────────────────────────────────────────
   本文件本身即 P0-2 的活证据：它**不需要**登记进任何清单——package.json 的
   npm test 用 tests/*.test.mjs 通配，磁盘上有这个文件就自动进 CI。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createLoader, makeState } from "../js/core/loader.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

/* ── P0-1：版本钉收敛到一处 ── */
test("A-1 版本钉：APP_VER 与 CACHE 同为 v141，测试里无硬编码版本断言", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache);
  assert.match(ver, /^v\d+$/, "版本号格式合法（本版 v141，但不写死——版本钉已收敛）");
  /* 扫所有测试文件：不许再出现 assert.equal(ver|cache,"vNN") 形态。
     backup.test.mjs 的 meta.app:"v103" 是夹具数据，排除。 */
  const offenders = [];
  for (const f of readdirSync(new URL("./", import.meta.url)).filter(x => x.endsWith(".mjs"))) {
    if (f === "backup.test.mjs") continue;
    const s = readFileSync(new URL(f, import.meta.url), "utf8");
    if (/assert\.(equal|notEqual|strictEqual)\(\s*(ver|cache|APP_VER|CACHE)\s*,\s*["']v\d+["']/.test(s))
      offenders.push(f);
  }
  assert.deepEqual(offenders, [], "版本钉又长回来了：" + offenders.join(","));
});

/* ── P0-2：测试清单单一来源 ── */
test("A-2 单一来源：npm test 走通配、CI 直接 npm test、磁盘文件自动覆盖", () => {
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/);
  assert.ok(!/node --test tests\/[A-Za-z]/.test(pkg.scripts.test), "不许改回硬编码清单");
  assert.match(ci, /run: npm test/);
  /* 本文件在磁盘上、且被通配覆盖（不需要登记——这就是单一来源的意义）。 */
  const files = readdirSync(new URL("./", import.meta.url)).filter(x => x.endsWith(".test.mjs"));
  assert.ok(files.includes("v141.test.mjs"), "v141 专项必须在磁盘上");
  assert.ok(files.includes("loader.test.mjs"), "loader 专项必须在磁盘上");
  assert.ok(files.includes("backup.test.mjs"), "backup 加密测试必须被纳入（它从未进过旧清单）");
});

/* ── P1-1：装载器样板 ── */
test("A-3 loader 骨架：createLoader 四项行为 + makeState 视图", async () => {
  /* busy 去重 */
  let calls = 0; let resolveRun;
  const st = makeState();
  const loader = createLoader({
    state: st, get: () => null, set: () => {}, ttl: 500,
    run: () => { calls++; return new Promise(r => { resolveRun = r; }); },
  });
  const p1 = loader.refresh();
  const p2 = loader.refresh();
  assert.equal(calls, 1, "并发只发一发");
  assert.equal(p1, p2);
  resolveRun({ ok: true });
  await Promise.all([p1, p2]);
  assert.equal(st.phase, "ok");
  assert.equal(loader.isBusy(), false);

  /* 失败保留旧值 */
  let data = { keep: 1 };
  const st2 = makeState();
  const l2 = createLoader({
    state: st2, get: () => data, set: v => { data = v; }, ttl: 500,
    run: async () => { throw new Error("boom"); },
  });
  await l2.refresh({ silent: true });
  assert.equal(st2.phase, "err");
  assert.deepEqual(data, { keep: 1 }, "失败不清旧值");
});

test("A-4 MACRO 接线：macroRefresh 走 loader、SHELL 收 loader.js", () => {
  assert.match(app, /from "\.\/js\/core\/loader\.js"/);
  assert.match(app, /const MACRO_ST = makeState\(\)/);
  assert.match(app, /const macroLoader = createLoader\(/);
  assert.match(app, /function macroRefresh\(opts = \{\}\) \{ return macroLoader\.refresh\(opts\); \}/);
  assert.ok(!/\blet _macroBusy\b/.test(app));
  assert.match(sw, /"\.\/js\/core\/loader\.js"/);
});
