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

/* v99：常驻提醒类 UI 全部下线（用户反馈影响整体美观度）。
   判据函数留在 syncstatus.js / disc.js 由各自模块测试覆盖，页面侧不再渲染。
   这几条是反向回归钉子 —— 谁把这些框加回来，这里立刻红。 */
test("v99：抓取异常告警条已下线，页面不再渲染 renderAlert", () => {
  assert.ok(!html.includes('id="alertBar"'), "index.html 里又出现 alertBar 挂点");
  assert.ok(!/function\s+renderAlert\s*\(/.test(app), "app.js 里又定义了 renderAlert");
  assert.ok(!/function\s+dismissAlert\s*\(/.test(app), "app.js 里又定义了 dismissAlert");
  assert.ok(!/renderAlert\(\)/.test(app), "app.js 里还有 renderAlert() 调用");
  assert.ok(!/dismissAlert\(/.test(app), "app.js 里还有 dismissAlert 内联/桥接引用");
  assert.ok(!/fetchFailSig|ALERT_DISMISSED|LS_ALERT|saveAlertDismiss/.test(app),
    "告警条下线后，忽略状态那套常量/存储函数也该一并清掉");
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

test("登记编码这一栏的读法全站只有一种：屏幕上有「登记编码」的地方都走 regCodeOf", () => {
  assert.match(app, /import \{[^}]*\bregCodeOf\b[^}]*\} from "\.\/js\/core\/orgs\.js"/,
    "app.js 没 import regCodeOf，浏览器里就是静默 ReferenceError");
  const lines = app.split("\n").filter(l => l.includes("登记编码 ${"));
  assert.ok(lines.length >= 2, `展示点少了（${lines.length} 处），接线要一起核`);
  for (const l of lines) {
    assert.match(l, /regCodeOf\(/, "有一处只读 p.code，云端已知的编码会显示成「-」：" + l.trim().slice(0, 64));
  }
  /* 另外两处不是「登记编码」这句话，但同一格的读法必须一致，所以逐个点名：
     表单① 是用户改这一栏的入口（显示成空 → 用户会再手工抄一遍，那正是要消掉的活）；
     看板行是「按编码搜产品」的那一项。变异证明：把任一处换回 p.code，本条红。 */
  const form = app.split("\n").filter(l => l.includes('id="pCode"'));
  assert.equal(form.length, 1, "表单① 的结构变了，接线要一起核");
  assert.match(form[0], /regCodeOf\(/, "编辑产品时登记编码显示成空 = 用户还得手工抄一次");
  const br = body(app, "boardRows");
  assert.match(br, /code: regCodeOf\(p\)/, "看板按 Z 编码搜不到只填了别名的产品");
});

test("SHELL 不漏关键模块（版本一致性见下方唯一总测）", () => {
  const sw = read("sw.js");
  /* v97 · P1 收敛：这里只守 SHELL 结构；APP_VER/CACHE 的版本号一致性
     由本文件下方「版本钉子总测」+ scripts/check-version.sh 两处权威守卫负责，
     不再在每个测试文件里各钉一份硬编码版本号（发版时漏改一处就假红）。 */
  for (const m of ["./js/core/orgs.js", "./js/core/disc.js",
                   "./js/core/webank.js", "./js/core/webank-shelf.js"]) {
    assert.ok(sw.includes(m), `SHELL 里必须有 ${m}`);
  }
});

/* ── 资产净值（规模）v87：接线测试 ─────────────────────────────────────────
   判据在 js/core/disc.js 里已经有口径测试了；这里只盯「页面真的用了它」——
   上一轮（v3.3）就是靠这类逐点断言才把「测试全绿但页面没接线」那种假绿抓出来。 */
test("规模这一栏：抓取回写、表单初值、详情展示三处都真的走 disc.js 的判据", () => {
  /* v99：字段覆盖率框下线，app.js 不再导入 fieldCoverage（判据函数仍留在 disc.js，
     由 disc.test.mjs 单独覆盖，页面只是不再渲染它）。 */
  const imp = app.match(/assetValueOf, applyAssetValue, assetValueText, setManualAssetValue, assetValueShort,\s*\n\s*assetHistoryOf, assetValueAt, assetHistoryViaLabel, applyAssetHistory,\s*\n\s*benchViaLabel, applyBench\s*\} from "\.\/js\/core\/disc\.js"/);
  assert.ok(imp, "资产与基准的判据函数必须从 disc.js 导入，不许在 app.js 里另写一套");
  assert.ok(!/fieldCoverage/.test(app), "字段覆盖率框已下线，app.js 不该再引用 fieldCoverage");
  assert.ok(!/fetchAlertHeading/.test(app), "告警条已下线，app.js 不该再引用 fetchAlertHeading");

  /* ① 抓取回写：判据跑在 disc.js，这里只盯接线与它所在的位置 */
  const all = body(app, "nativeFetchAll");
  assert.ok(all.includes("applyAssetValue(p2, r.assetValue)"), "本机抓取要真的把规模落账");
  /* 上面那句只盯字符串 —— 把守卫改成 if (false && r.assetValue) 照样全绿，
     而那一折就永远不会落账。所以这里钉的是「结构」：调用必须直接挂在
     r.assetValue 这个条件下面，中间不许插任何常量假守卫。 */
  assert.match(all, /if \(r && r\.assetValue\) \{\s*\n\s*const av = applyAssetValue\(p2, r\.assetValue\);/,
    "回写必须挂在 if (r && r.assetValue) 里，条件一旦被改成恒假（或整段注释掉）就是没接线");
  assert.doesNotMatch(all, /if \(false\b/, "函数里不该有恒假分支，那是「代码在、事没做」的典型形状");
  /* v3.4 实测缺口：原生侧闸门①拦下净值时回包 ok=false、但仍带着「规模这格为什么空着」。
     落账若写在 ok 那一支里面，这类产品就永远是一格无声的空 —— 所以钉位置：
     applyAssetValue 必须出现在 `if (r && r.ok)` 之前（两支之外）。
     ⚠️ 取的是**那句代码**的位置，不是注释里第一次出现这个名字的地方：
     上一版用 indexOf("applyAssetValue(") 命中了上面那段注释，窗口跟着跑偏，
     「else fails.push」那个变异就是从这条缝里漏掉的。 */
  const at = all.search(/const av = applyAssetValue\(p2, r\.assetValue\);/);
  assert.ok(at >= 0, "落账那句调用本身不在了");
  assert.ok(at < all.indexOf("if (r && r.ok)"),
    "规模落账必须在 ok/失败两支之外：被闸门拦下的那一趟也要能把理由落下来");
  assert.match(all, /if \(av\.changed\) \{ assetChanged = true; saveLocal\(\); \}/,
    "改了本地账就得存盘 —— 净值那一支的 saveLocal 这条路根本不会走");
  assert.doesNotMatch(all.slice(at, at + 400), /fails\.push/,
    "规模没补齐不许被说成抓取失败（v84 三类口径同源）");
  assert.ok(/assetNotes/.test(all) && /MANUAL\.asset/.test(all), "补齐结果要有单独一行归口，别混进净值那句");
  assert.doesNotMatch(all.slice(all.indexOf("applyAssetValue"), all.indexOf("applyAssetValue") + 400),
    /fails\.push/, "规模没补齐不许被说成抓取失败（v84 三类口径同源）");

  /* ② 表单初值：只能回填手工那一折，抓取写的那一折留在提示里 */
  const form = body(app, "assetFormValue");
  assert.ok(/assetValueOf\(p\)/.test(form) && /av\.manual/.test(form),
    "输入框初值必须只认 manual 那一折，否则用户清空输入框会连带抹掉云端值");

  /* ③ 详情展示：走唯一那份 assetValueText，不许在页面里自己除 1e8 */
  const det = body(app, "renderProdDetail");
  assert.ok(/assetValueText\(p\)/.test(det), "详情页那一栏要用统一展示函数");
  assert.doesNotMatch(app, /assetValue[\s\S]{0,40}\/\s*1e8/, "换算只许写在 disc.js 的 assetValueText 里");
});

test("v92 逐日序列：App 桥真的把回包落账，且写在 ok/失败两支之外", () => {
  const all = body(app, "nativeFetchAll");
  assert.match(all, /if \(r && r\.assetHistory\) \{\s*\n\s*const ah = applyAssetHistory\(p2, r\.assetHistory, r\.assetHistoryVia\);/,
    "逐日序列必须用 disc.js 的同构判据落账，且直接挂在 r.assetHistory 条件下");
  assert.ok(all.indexOf("const ah = applyAssetHistory(") < all.indexOf("if (r && r.ok)"),
    "序列落账同样要在两支之外：被闸门拦下净值的那一趟也可能带回序列");
  assert.match(all, /if \(ah\.changed\) \{ assetChanged = true; saveLocal\(\); \}/,
    "序列变了要存盘，否则这一轮抓到的逐日规模白抓");
  /* 表格真的逐行读了序列，不是只把函数 import 进来摆着 */
  const det = body(app, "renderProdDetail");
  assert.ok(/assetValueAt\(p, st\.dates\[i\]\)/.test(det), "历史净值表要按行日期读逐日序列");
  assert.ok(/assetHistoryOf\(p\)/.test(det), "序列读取统一走 assetHistoryOf");
});

test("规模是钱：结论文本（体检卡 / 换仓建议）里一个都不许引用它", () => {
  for (const fn of ["adviceCard", "switchCard", "manStatusHtml"]) {
    const b = body(app, fn);
    assert.doesNotMatch(b, /assetValueText|assetValueOf/, `${fn} 里不许出现规模：结论文本里不写钱`);
  }
  /* 抓取状态那一行只许出现「披露日」，金额数字不进结论 */
  const tip = app.match(/const assetLine = [\s\S]{0,120}/);
  assert.ok(tip && /m\.asset/.test(tip[0]), "抓取框要有独立一行");
});

/* ── 版本钉子总测（v97 · P1 收敛后全仓唯一一处版本守卫）──────────────────
   历史：v87 那次「改了没推」催生了「每个测试文件各钉一份 CACHE/APP_VER」的
   重复守卫 —— 结果每发一版要人肉同步 12+ 处，v94 / v96 两次实测踩雷（审查报告 P1）。
   v97 收敛：4 个测试文件里的硬编码版本断言全部删除，只留这一条总测 +
   scripts/check-version.sh（后者已做 APP_VER↔CACHE + SHELL + 引用清单 + import 闭包四重门禁）。
   本总测不再硬编码文件名清单（名单会漂），改为按目录扫 tests/*.mjs，
   只要任何测试里再出现「硬编码版本号」就红 —— 既防「改了没推」，也防「钉子又长回来」。 */
test("版本钉子总测：APP_VER 与 CACHE 同版本，且测试里不许再钉硬编码版本号", () => {
  const sw = read("sw.js");
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  assert.equal(ver, cache, "APP_VER 与 CACHE 必须同版本（scripts/check-version.sh 也会查）");
  /* 扫全部测试文件：收敛后它们只许出现「动态读版本」的正则，不许出现写死的版本号。
     只查两种曾经散落的形态：licai-ledger-vNN / const APP_VER = "vNN"（断言里）. */
  const offenders = [];
  for (const f of fs.readdirSync(path.join(root, "tests")).filter(x => x.endsWith(".mjs"))) {
    const s = read("tests/" + f);
    if (/licai-ledger-v\d+/.test(s)) offenders.push(`${f}: 硬编码 licai-ledger-vNN`);
    if (/includes\(['"]const APP_VER = "v\d+"|includes\(['"]const CACHE = "licai-ledger-v\d+/.test(s))
      offenders.push(`${f}: 硬编码版本断言`);
  }
  assert.deepEqual(offenders, [], "版本钉子已收敛到一处，别再把版本号写回测试：\n  " + offenders.join("\n  "));
});

/* ─────────────── v94 · 业绩比较基准的页面接线 ───────────────
   少挂一个 id / 少接一条回包字段，就是「抓到了却看不见」。 */

test("v94：基准表单两栏 id 与保存路径对上，手工值带 benchSrc=手工", () => {
  assert.ok(app.includes('id="pBench"') && app.includes('id="pBenchRule"'),
    "产品表单里没有基准/确认规则两栏");
  assert.ok(app.includes('patch.benchmark = (benchEl.value || "").trim()'),
    "保存路径没读基准栏");
  assert.ok(app.includes('target.benchSrc = { via: "手工"'),
    "手工填基准必须标 benchSrc=手工（抓取端只填空白，标了才不会被覆盖）");
  assert.ok(app.includes("function benchFormTip(p)"),
    "基准栏的提示函数没接上（抓取补齐与手工值在提示里必须分清）");
});

test("v94：抓取回包的基准三件在 ok/失败两支之外落账", () => {
  /* 净值瞭望这类源恒不带净值 —— 落账写在 ok 分支里，净值失败的产品基准就永远进不来 */
  const i = app.indexOf("if (r && r.assetHistory) {");
  const bench = app.indexOf("if (r && (r.benchmark || r.benchRule)) {");
  const okBranch = app.indexOf("if (r && r.ok) {", i);
  assert.ok(i > 0 && bench > i, "app.js 没接基准落账");
  assert.ok(bench < okBranch, "基准落账必须写在净值 ok/失败两支之外（与 applyAssetValue 同一纪律）");
  assert.ok(app.includes("applyBench(p2, { benchmark: r.benchmark, benchRule: r.benchRule, benchSrc: r.benchSrc })"),
    "落账必须走 disc.js 的 applyBench，不许在 app.js 里另立一套判据");
});

test("v94：产品详情有基准一节，没抓到也显示「未披露」", () => {
  assert.ok(app.includes("业绩比较基准</b>：${p.benchmark ? esc(p.benchmark)"), "详情页基准行没接上");
  assert.ok(app.includes("未披露（官方源与第三方都还没给，可在「编辑」里手工补）"),
    "空值必须如实写「未披露」，不许装没有");
  assert.ok(app.includes('benchViaLabel((p.benchSrc && p.benchSrc.via) || "")'),
    "出处档位标签必须走 benchViaLabel 一份口径");
});

test("v94：AI 快照带上基准三件（白名单在 llm.js，app.js 只供字段）", () => {
  assert.ok(app.includes("benchmark: p.benchmark || \"\", benchRule: p.benchRule || \"\","),
    "llmSnapItems 没供基准字段 —— 模型分析产品就没有对标依据");
  assert.ok(app.includes("benchVia: benchViaLabel((p.benchSrc && p.benchSrc.via) || \"\")"),
    "快照出处档位必须走 benchViaLabel");
  const llm = read("js/domain/llm.js");
  assert.ok(llm.includes('"基准 " + (oneLine(it.benchmark, 90) || "未披露")'),
    "快照白名单没有基准行（或没写「未披露」降级）");
  assert.ok(llm.includes('if (it.benchRule) bits.push("确认规则 " + oneLine(it.benchRule, 40));'),
    "快照白名单没有确认规则行");
});

test("v94：benchRule 进了同步字段表，benchSrc 随规则5整键同步", () => {
  assert.ok(app.includes('"benchmark", "benchRule", "lastNavSync"]'),
    "MERGE_FIELDS 少了 benchRule —— 云端补的确认规则到不了另一台设备");
});

/* ---- v99 · 常驻说明/提醒框下线（用户反馈影响整体 UI 美观度） ----
   简报框（briefBox）、字段覆盖率框（covBox）、设置页 3 个静态口径说明框、
   抓取异常告警条全部移除。判据函数本身留在模块里，这里只钉住「页面不再渲染」。 */
test("v99：简报框/覆盖率框/静态口径说明框已下线，数据骑行不受影响", () => {
  const app = read("app.js");
  const html = read("index.html");
  assert.ok(!html.includes('id="briefBox"'), "台账页又出现 briefBox 挂点");
  assert.ok(!html.includes('id="covBox"'), "产品页又出现 covBox 挂点");
  assert.ok(!/function\s+renderBrief\s*\(/.test(app), "app.js 里又定义了 renderBrief");
  assert.ok(!/function\s+renderCoverage\s*\(/.test(app), "app.js 里又定义了 renderCoverage");
  assert.ok(!/renderBrief\(\)|renderCoverage\(\)/.test(app), "app.js 里还有简报/覆盖率渲染调用");
  /* 覆盖率框那段黄底文案不该再出现（截图里那一整块） */
  assert.ok(!/字段覆盖率/.test(app) && !/字段覆盖率/.test(html), "字段覆盖率框文案又回来了");
  /* 页面不许自带覆盖率谓词（判据只在 disc.js，disc.test.mjs 覆盖） */
  assert.ok(!/function\s+fieldCoverage/.test(app), "fieldCoverage 不许在 app.js 里再抄一份");
  /* 静态口径说明框：3 个 .note 连同那张空壳卡片一起删，但 .foot 动态反馈不动 */
  assert.ok(!/确认与归属口径/.test(html) && !/净值抓取说明/.test(html),
    "设置页静态口径说明框又回来了");
  /* 数据层不变：云端写的 dailyBrief 仍要随 settings 骑行，否则本地一推把云端冲掉 */
  assert.ok(read("js/domain/sync.js").includes('"dailyBrief"'),
    "settings 骑行清单必须含 dailyBrief：删的是渲染框，不是数据同步语义");
  /* 交互反馈仍用 .note：查询/下载/同步等动态提示不许被一起删掉 */
  assert.ok((app.match(/class="note/g) || []).length >= 20,
    "动态操作反馈的 .note 被误删了：按钮点了会没反应");
});
