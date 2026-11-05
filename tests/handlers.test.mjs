/* 内联事件桥的双向契约测试：
     node --test tests/handlers.test.mjs
   app.js 是 ES module，顶层函数不再是 window 属性，而 index.html 和渲染出来的
   HTML 里仍有大量 onclick="fn(...)" 靠全局查找。少挂一个 entry 就是「点了没反应」，
   而且这种错浏览器控制台只在点击时才报。这里在 CI 里静态比对两边名单。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

const app = read("app.js");
const html = read("index.html");

/* inline handler 里出现的「函数名(」——忽略 event/document 这类内建 */
function inlineNames(src) {
  const out = new Set();
  const re = /(?:^|[^\w$])on[a-z]+="([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === "if" || m[1] === "document") continue;
    out.add(m[1]);
  }
  return out;
}

/* app.js 末尾 Object.assign(window, { ... }) 的键 */
function bridgedNames(src) {
  const i = src.indexOf("Object.assign(window, {");
  assert.ok(i > 0, "app.js 里找不到 Object.assign(window, {...}) 桥接块");
  const j = src.indexOf("});", i);
  assert.ok(j > i, "桥接块没有正确闭合");
  return new Set(src.slice(i, j).split("{", 2)[1].split(",").map(s => s.trim()).filter(Boolean));
}

test("每个内联 onclick/oninput 入口都挂到了 window", () => {
  const need = new Set([...inlineNames(app), ...inlineNames(html)]);
  const have = bridgedNames(app);
  const missing = [...need].filter(n => !have.has(n));
  assert.deepEqual(missing, [], `这些内联入口没有 window 桥接，点击会 ReferenceError:\n  ${missing.join("\n  ")}`);
});

test("桥接清单里没有多余/拼错的名字", () => {
  const need = new Set([...inlineNames(app), ...inlineNames(html)]);
  const have = bridgedNames(app);
  const extra = [...have].filter(n => !need.has(n));
  assert.deepEqual(extra, [], `桥接清单里有多余项（内联已不再引用，注意别是拼错了名字）:\n  ${extra.join("\n  ")}`);
});
/* ---- v84：告警标题的口径必须真的接上（写在模块里没人调用 = 没修） ---- */
function body(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `app.js 里找不到 ${name}`);
  const j = src.indexOf("\nfunction ", i + 1);
  return src.slice(i, j < 0 ? undefined : j);
}

test("renderAlert 的标题走 fetchAlertHeading，不许把三种病因写成一句「没拿到净值」", () => {
  const b = body(app, "renderAlert");
  assert.match(b, /fetchAlertHeading\(/, "标题又硬编回去了");
  assert.doesNotMatch(b, /只产品没拿到净值/, "这句话盖住了「被拦下」和「闸门拒取」两种原因");
  assert.match(app, /import \{[^}]*fetchAlertHeading[^}]*\} from "\.\/js\/domain\/syncstatus\.js"/,
    "app.js 没 import 这个函数，浏览器里会静默 ReferenceError");
});


/* ---- v85：登记编码自动补齐的接线（口径写在模块里，调用点少了就等于没做） ---- */
test("添加产品后真的会去反查登记编码，且后台循环也带着它", () => {
  const b = body(app, "saveProduct");
  assert.match(b, /autoFillRegCode\(/, "保存新产品时没接反查 = 用户要的「自动补齐」没生效");
  const loop = app.slice(app.indexOf("const runOne = "), app.indexOf("const workers = Array.from"));
  assert.match(loop, /regCodeDue\(/, "后台核对循环里没有这一路 = 存量产品永远不会被补");
  assert.match(loop, /autoFillRegCode\(/, "只判冷却不真跑，等于没接");
});

test("反查走现成的净值桥，只多一个 mode，不另开桥方法", () => {
  const b = body(app, "nativeIdentifyFetch");
  assert.match(b, /window\.NativeNav\.fetch\(/, "另开桥方法要动 Java 侧，口径会漂");
  assert.match(b, /mode: "identify"/);
  assert.doesNotMatch(app, /NativeNav\.identify\(/, "桥上没有这个方法，写了就是静默失败");
});

test("网页版没有本机抓取时如实说，不假装查过、也不盖「试过」的章", () => {
  const b = body(app, "autoFillRegCode");
  assert.match(b, /nativeFetchAvailable\(\)/);
  assert.match(b, /bridgeMissingMsg/);
  /* 「不许盖章」要用两条能各挡一种改动的断言，而不是一句「顺序在前」：
     ① 网页版那个提前 return 的整块里都不能出现 regCodeAt —— 挡「顺手给没跑的一趟盖章」；
     ② 盖章必须写在真的把请求发出去之后 —— 挡「先盖章再发请求」（发了就等于试过，
        可万一本机桥挂了，盖了章的存量产品就再也不会被补查）。 */
  const i = b.indexOf("if (!nativeFetchAvailable())");
  assert.ok(i >= 0, "网页版分支不在了");
  const j = b.indexOf("\n  }", i);
  assert.ok(j > i, "网页版分支没按预期闭合，断言范围不可信");
  assert.doesNotMatch(b.slice(i, j), /regCodeAt\s*=/,
    "regCodeAt 的意思是「真的试过一趟」，请求没发出去不许盖章");
  const stamp = b.search(/regCodeAt\s*=/);
  assert.ok(stamp > b.indexOf("await nativeIdentifyFetch"),
    "章要盖在请求真的交出去之后，否则超时/异常这一路会被永久跳过");
});

test("云端候选只展示不改账本（regHints）", () => {
  assert.match(app, /regHints/, "云端给的候选没接到页面上 = 用户看不见");
  const b = body(app, "renderNavSheetRegHints");
  assert.match(b, /登记编码/);
  assert.doesNotMatch(b, /\.code\s*=|regCode\s*=/, "展示函数不许写账本");
});

test("APP_VER 升到 v85 且 SHELL 不漏文件", () => {
  const sw = read("sw.js");
  assert.ok(sw.includes('const CACHE = "licai-ledger-v85"'), "外壳字节变了 CACHE 必须跟着升");
  assert.ok(app.includes('const APP_VER = "v85"'), "APP_VER 要与 CACHE 同值");
  for (const m of ["./js/core/orgs.js", "./js/core/disc.js"]) {
    assert.ok(sw.includes(m), `SHELL 里必须有 ${m}`);
  }
});
