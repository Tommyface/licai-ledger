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
