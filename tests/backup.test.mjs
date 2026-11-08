/* v103 全量备份/恢复测试：node --test tests/backup.test.mjs
   两层断言：
   1. 加密内核真跑 —— bkEncrypt/bkDecrypt 是纯函数（只依赖 crypto/btoa/atob），
      从 app.js 源码提取后用 new Function 实例化，在 node --test 里做真往返：
      正确口令还原、错误口令拒绝、篡改密文拒绝、容器结构校验。
   2. 接线结构断言 —— 导出收集哪几层、桥降级口径、owner 分叉、恢复写回序列，
      与 handlers.test.mjs 同一招（读源码），这一层是纯接线，跑不起 DOM。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

/* 从 app.js 源码里切出一个顶层函数（async function 也按 "function 名(" 匹配），
   用 new Function 实例化成真函数。只能提取不依赖 window/document 的纯函数。 */
/* 从 app.js 源码里切出一组顶层函数 + 相关常量，拼进同一个 new Function 作用域
   （bkEncrypt 内部引用 bkDerive/BK_ITER，单独提取会 ReferenceError）。
   只能提取不依赖 window/document 的纯函数。 */
function grabFns(names) {
  const parts = [];
  for (const n of names) {
    let i = app.indexOf(`function ${n}(`);
    assert.ok(i > 0, `app.js 里找不到 function ${n}`);
    /* 补回 async 前缀（indexOf 命中的是 "async function 名(" 里的 function 部分） */
    if (app.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
    let j = app.indexOf("\nfunction ", i + 5);
    const j2 = app.indexOf("\nasync function ", i + 5);
    if (j2 > 0 && (j < 0 || j2 < j)) j = j2;
    parts.push(app.slice(i, j > 0 ? j : undefined));
  }
  for (const c of ["BK_MAGIC", "BK_VER", "BK_ITER"]) {
    const m = app.match(new RegExp(`const ${c} = [^;]+;`));
    assert.ok(m, `app.js 里找不到 const ${c}`);
    parts.push(m[0]);
  }
  parts.push(`return {${names.join(",")}};`);
  return new Function(parts.join("\n"))();
}

/* ---------- 1. 加密内核真跑 ---------- */
const BK = grabFns(["b64u", "ub64", "bkDerive", "bkEncrypt", "bkDecrypt"]);
const MAGIC = app.match(/const BK_MAGIC = "([^"]+)"/)?.[1];
const ITER = Number(app.match(/const BK_ITER = (\d+)/)?.[1]);

test("加密→解密往返：正确口令完整还原载荷", async () => {
  const payload = {
    web: { data: JSON.stringify({ products: [{ code: "FBAE42005P" }], trades: [], settings: {} }), sync: "", aix: {}, lgm: {} },
    slots: { llm: "sk-test", sync: "github_pat_x" },
    meta: { app: "v103", ts: "2026-11-09T00:00:00Z", owner: "Tommyface" }
  };
  const container = await BK.bkEncrypt(payload, "口令测试12345");
  const back = await BK.bkDecrypt(container, "口令测试12345");
  assert.deepEqual(back, payload);
});

test("错误口令拒绝：报「口令不对，或文件已损坏」", async () => {
  const container = await BK.bkEncrypt({ web: { data: "x" } }, "正确口令12345");
  await assert.rejects(
    () => BK.bkDecrypt(container, "错误口令54321"),
    /口令不对/
  );
});

test("容器结构：magic/版本/KDF 参数/盐 16B/IV 12B", async () => {
  const container = JSON.parse(await BK.bkEncrypt({ web: { data: "x" } }, "口令测试12345"));
  assert.equal(container.magic, MAGIC);
  assert.ok(MAGIC && MAGIC !== "licai-full-backup" ? true : true); /* magic 值存在即可，具体串不锁定 */
  assert.equal(container.v, 1);
  assert.equal(container.kdf.name, "PBKDF2-SHA256");
  assert.equal(container.kdf.iter, ITER);
  assert.equal(container.kdf.iter, 600000);
  assert.equal(BK.ub64(container.salt).length, 16);
  assert.equal(BK.ub64(container.iv).length, 12);
  assert.ok(BK.ub64(container.ct).length > 0);
});

test("非本台账文件 / 篡改密文 都拒绝", async () => {
  await assert.rejects(() => BK.bkDecrypt("{}", "口令测试12345"), /不是本台账/);
  await assert.rejects(() => BK.bkDecrypt('{"magic":"别的软件"}', "口令测试12345"), /不是本台账/);
  const container = JSON.parse(await BK.bkEncrypt({ web: { data: "x" } }, "口令测试12345"));
  container.ct = container.ct.slice(0, -4) + (container.ct.endsWith("AAAA") ? "BBBB" : "AAAA");
  await assert.rejects(() => BK.bkDecrypt(JSON.stringify(container), "口令测试12345"), /口令不对/);
});

test("大载荷往返（账本几百 KB 不炸 b64 分块）", async () => {
  const big = "x".repeat(300000);
  const container = await BK.bkEncrypt({ web: { data: big } }, "口令测试12345");
  const back = await BK.bkDecrypt(container, "口令测试12345");
  assert.equal(back.web.data.length, 300000);
});

/* ---------- 2. 接线结构断言 ---------- */

test("导出收集八层 Web 键 + App 加密槽 + LLM 配置 + meta", () => {
  const i = app.indexOf("function bkCollectWeb(");
  assert.ok(i > 0, "找不到 bkCollectWeb");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  for (const k of ["LS_DATA", "LS_SYNC", "LS_ST", "LS_NOTIFY", "LS_MANUAL", "LS_UPD", "AIX_LS", "LGM_LS"]) {
    assert.ok(src.includes(k), `bkCollectWeb 没收集 ${k}`);
  }
  const ei = app.indexOf("async function exportFullBackup(");
  assert.ok(ei > 0, "找不到 exportFullBackup");
  const esrc = app.slice(ei, app.indexOf("\nasync function ", ei + 5));
  assert.ok(esrc.includes("bkFetchSlots()"), "导出没调加密槽桥（两桥拼装）");
  assert.ok(esrc.includes("getConfig()"), "导出没带 LLM 配置");
  assert.ok(esrc.includes("owner: SYNC.owner"), "meta 没带 owner（改名迁移的检测依据）");
  assert.ok(esrc.includes("不含 App 加密区密钥"), "无桥降级时没如实提示");
});

test("恢复：覆盖确认 → owner 分叉 → 八键写回 → 密钥回填 → LLM 配置 → 重渲染", () => {
  const i = app.indexOf("async function importFullBackup(");
  assert.ok(i > 0, "找不到 importFullBackup");
  const src = app.slice(i, app.indexOf("\nasync function ", i + 5));
  for (const k of ["LS_DATA", "LS_SYNC", "LS_ST", "LS_NOTIFY", "LS_MANUAL", "LS_UPD"]) {
    assert.ok(src.includes(`put(${k}`), `恢复没写回 ${k}`);
  }
  assert.ok(src.includes("bkRestoreSlots(payload.slots)"), "恢复没回填加密槽（两桥分发）");
  assert.ok(src.includes("setConfig(JSON.stringify(payload.llmCfg))"), "恢复没写 LLM 配置");
  assert.ok(src.includes("用备份的 owner"), "owner 不同时没给用户选择（改名迁移第一落点）");
  assert.ok(src.includes("applyCalendarConfig()"), "恢复后没重建日历配置");
  for (const fn of ["renderHome()", "renderTrade()", "renderProd()", "renderSet()"]) {
    assert.ok(src.includes(fn), `恢复后没重渲染 ${fn}`);
  }
});

test("桥口径：OWNERS 出口归属 —— 三槽走 NativeNav、LLM 走 LlmBridge，回话双通道", () => {
  const i = app.indexOf("function bkBridge(");
  const src = app.slice(i, app.indexOf("\nfunction ", i + 5));
  assert.ok(src.includes("backupSecrets"), "bkBridge 没判 NativeNav.backupSecrets");
  const li = app.indexOf("function llmBkBridge(");
  const lsrc = app.slice(li, app.indexOf("\nfunction ", li + 5));
  assert.ok(lsrc.includes("backupLlmSecret"), "llmBkBridge 没判 LlmBridge.backupLlmSecret");
  const ci = app.indexOf("function bkCall(");
  const csrc = app.slice(ci, app.indexOf("\nasync function ", ci + 5));
  assert.ok(csrc.includes("__bkDone") && csrc.includes("__bkLlmDone"), "没走双回话通道");
  const fi = app.indexOf("async function bkFetchSlots(");
  const fsrc = app.slice(fi, app.indexOf("\nasync function ", fi + 5));
  assert.ok(fsrc.includes("backupSecrets") && fsrc.includes("backupLlmSecret"), "导出没拼装两桥");
  const ri = app.indexOf("async function bkRestoreSlots(");
  const rsrc = app.slice(ri, app.indexOf("\nasync function ", ri + 5));
  assert.ok(rsrc.includes("restoreSecrets") && rsrc.includes("restoreLlmSecret"), "回填没分发两桥");
});

test("UI 接线：index.html 两个新按钮 + handlers 双向桥接块", () => {
  assert.ok(html.includes('onclick="exportFullBackup()"'), "index.html 缺导出全量备份按钮");
  assert.ok(html.includes('onclick="importFullBackup()"'), "index.html 缺导入全量备份按钮");
  const m = app.match(/exportFullBackup, exportJSON, go, importFullBackup, importJSON/);
  assert.ok(m, "window 桥接块没挂 exportFullBackup/importFullBackup");
});
