/* v97 · 微众稳健货架「动态字段显示」判据测试：node --test tests/webank.test.mjs
   判断收口在 js/core/webank.js，这里逐项钉死纪律：
     · 命中只认规范化产品代码（与 detectOrg 解耦，不用名字猜）；
     · 空值语义「不知道≠0」：占位值不生成行，缺字段不生成占位行；
     · 代销多值解析与去重，无证据诚实降级；
     · 三类产品线（Plus / 固收+ / 普通稳健）字段装配差异；
     · 金额字段必须标 money（渲染层据此走 shown()，源码级门禁盯着）；
     · 枚举码保留原值，不臆造中文语义。
   另有一组「接线」测试（仿 handlers.test.mjs 风格）确认 app.js 真的调用了判据，
   防止「判据全绿但页面没接」的假绿。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SHELF from "../js/core/webank-shelf.js";
import {
  WEBANK_FIELDS, WEBANK_GROUPS, hasValue, normCode, matchShelf, shelfClass,
  shelfTags, agentBanks, hasAgents, renderableFields, groupedFields, shelfMeta,
  agentViaTag, shelfFreshness, SHELF_FRESH_DAYS, SHELF_STALE_DAYS,
} from "../js/core/webank.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

/* ---------- 1. 静态索引本体 ---------- */
test("静态索引：459 只、meta 带快照日期与出处、代销证据非空", () => {
  const m = shelfMeta(SHELF);
  assert.equal(m.shelf_rows, 459, "货架快照应为实测 459 只（非旧注释的 454）");
  assert.match(m.captured_at, /^2026-11-07/, "快照日期要带，UI 会标");
  assert.ok(m.source_we.includes("微众"), "微众源出处");
  assert.ok(m.agents_rows > 0, "代销证据要有");
  assert.equal(Object.keys(SHELF.byCode).length, 459);
});

/* ---------- 2. 命中判定：只认代码，与机构识别解耦 ---------- */
test("命中：规范化代码命中；大小写/空白无关", () => {
  assert.equal(matchShelf(SHELF, "YJ01251204A").hit, true);
  assert.equal(matchShelf(SHELF, "  yj01251204a  ").hit, true, "大小写与首尾空白要归一");
  assert.equal(matchShelf(SHELF, "YJ01251204A").code, "YJ01251204A");
});
test("未命中：空码 / 不存在码 / 登记编码 / 产品名 一律不认", () => {
  for (const bad of ["", null, undefined, "ZZZZZZZZZZ", "Z7008926000006", "北银理财诚享7天29号", 12345]) {
    assert.equal(matchShelf(SHELF, bad).hit, false, `不该命中：${String(bad)}`);
  }
  assert.equal(normCode("  abc  "), "ABC");
});
test("判据不用 manager / 产品名去猜（与 detectOrg 解耦的纪律）", () => {
  /* 账本里 manager 常写「微众银行（代销货架）」，但命中与否只看 prodCode */
  const fakeByName = { name: "微众稳健理财", manager: "深圳前海微众银行", prodCode: "NOT_IN_SHELF" };
  assert.equal(matchShelf(SHELF, fakeByName.prodCode).hit, false);
  const fakeByCode = { name: "随便写的名字", manager: "某理财", prodCode: "YJ01251204A" };
  assert.equal(matchShelf(SHELF, fakeByCode.prodCode).hit, true, "代码命中就该认，不看名字");
});

/* ---------- 3. 空值语义 ---------- */
test("空值语义：占位值算「不知道」，0 / false 是有效值", () => {
  for (const v of [null, undefined, "", "  ", "--", "-", "0.0000", "0.00", [], {}]) {
    assert.equal(hasValue(v), false, `占位应算不知道：${JSON.stringify(v)}`);
  }
  for (const v of [0, 1, false, true, "0", "1元", [1], { a: 1 }]) {
    assert.equal(hasValue(v), true, `有效值不该被吞：${JSON.stringify(v)}`);
  }
});
test("缺字段不生成占位行：只对真正有值的字段出展示项", () => {
  const rec = matchShelf(SHELF, "YJ01251204A").rec;
  const fields = renderableFields(rec);
  assert.ok(fields.length > 0);
  for (const f of fields) assert.equal(hasValue(f.value), true, `字段 ${f.k} 不该出空值行`);
  /* 普通稳健不该出现增强策略字段（源里就没有这些键） */
  for (const k of ["fix_plus_ivt_tag", "maximum_drawdown", "plus_period"]) {
    assert.equal(fields.some(f => f.k === k), false, `普通稳健不该有 ${k}`);
  }
});

/* ---------- 4. 三类产品线分支 ---------- */
test("三类产品线判定互斥、各自带源字段名（不冒充官方名）", () => {
  const steady = matchShelf(SHELF, "YJ01251204A").rec;   // 普通稳健
  const fixp = matchShelf(SHELF, "NYJXLD1409G").rec;     // 固收+
  assert.equal(shelfClass(steady).key, "steady");
  assert.equal(shelfClass(fixp).key, "fixplus");
  assert.ok(shelfClass(steady).label.includes("稳健"));
  assert.ok(shelfClass(fixp).src.includes("fix_plus_prod_flag"));
});
test("固收+ 才渲染增强策略/回撤；普通稳健不渲染", () => {
  const fSteady = renderableFields(matchShelf(SHELF, "YJ01251204A").rec).map(x => x.k);
  const fFixp = renderableFields(matchShelf(SHELF, "NYJXLD1409G").rec).map(x => x.k);
  assert.ok(fFixp.includes("fix_plus_ivt_tag"), "固收+ 要有增强策略标签");
  assert.ok(fFixp.includes("maximum_drawdown"), "固收+ 要有最大回撤");
  assert.equal(fSteady.includes("fix_plus_ivt_tag"), false);
  assert.equal(fSteady.includes("maximum_drawdown"), false);
});
test("Plus 内层字段只有 plus_copy 产品才有", () => {
  const plus = Object.entries(SHELF.byCode).find(([, r]) => r.plus_flag);
  assert.ok(plus, "索引里应有 Plus 产品");
  const keys = renderableFields(plus[1]).map(x => x.k);
  assert.ok(keys.includes("plus_period") || keys.includes("plus_days"), "Plus 要有内层形态字段");
  assert.equal(renderableFields(matchShelf(SHELF, "YJ01251204A").rec).some(x => x.k === "plus_period"), false);
});

/* ---------- 5. 分类标签与分组 ---------- */
test("分类标签带出处、产品期限/成立日/风险码在列", () => {
  const tags = shelfTags(matchShelf(SHELF, "YJ01251204A").rec);
  assert.ok(tags.length >= 3);
  for (const t of tags) assert.ok(t.src && t.src.length > 0, "每个标签要带出处");
  assert.ok(tags.some(t => t.text.includes("稳健")), "产品线标签");
  assert.ok(tags.some(t => t.text.includes("成立")), "成立日标签");
});
test("分组归拢只含有内容的组，顺序按 WEBANK_GROUPS", () => {
  const groups = groupedFields(matchShelf(SHELF, "NYJXLD1409G").rec);
  assert.ok(groups.length > 0);
  const order = groups.map(g => WEBANK_GROUPS.indexOf(g.grp));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "分组顺序要稳定");
  assert.ok(groups.some(g => g.grp === "增强策略"), "固收+ 要有增强策略组");
});

/* ---------- 6. 代销多值 ---------- */
test("代销：去重、保序、各自带 via；无证据诚实降级", () => {
  const rec = matchShelf(SHELF, "NYJXLD1409G").rec;
  const banks = agentBanks(rec);
  assert.ok(banks.length >= 1, "账本固收+ 产品应有代销证据");
  assert.ok(banks.some(b => b.name.includes("微众")), "详情页证据：微众银行");
  assert.ok(banks.some(b => b.name.includes("网商")), "详情页证据：网商银行（多值）");
  for (const b of banks) assert.ok(b.via && b.via.length > 0);
  assert.equal(hasAgents(rec), true);
  /* 造一个无 agents 的记录 */
  assert.deepEqual(agentBanks({}), []);
  assert.equal(hasAgents({}), false);
  /* 重复名要去掉 */
  assert.deepEqual(agentBanks({ agents: [
    { name: "微众银行", via: "A" }, { name: "微众银行", via: "B" }, { name: "网商银行", via: "A" },
  ] }).map(b => b.name), ["微众银行", "网商银行"]);
});
test("代销多值在索引里是普遍现象（79 只级别），不是硬编码特例", () => {
  const multi = Object.values(SHELF.byCode).filter(r => agentBanks(r).length > 1).length;
  assert.ok(multi >= 20, `多值代销应成规模，实测 ${multi}`);
});

/* ---------- 7. 金额字段遮掩标记 ---------- */
test("金额类字段标了 money=true（渲染层据此走 shown()）", () => {
  const moneyKeys = WEBANK_FIELDS.filter(f => f.money).map(f => f.k);
  assert.ok(moneyKeys.includes("start_buy_min"), "起购金额要标 money");
  assert.ok(moneyKeys.includes("min_amount_desc"), "起购说明要标 money");
  for (const f of WEBANK_FIELDS) {
    assert.ok(["text", "code", "num", "date", "bool", "tags"].includes(f.kind || "text") || !f.kind,
      `字段 ${f.k} 的 kind 要在允许集合内`);
  }
});
test("字段字典 key 不重复、分组都在 WEBANK_GROUPS 里", () => {
  const keys = WEBANK_FIELDS.map(f => f.k);
  assert.equal(new Set(keys).size, keys.length, "字典 key 不能重复");
  for (const f of WEBANK_FIELDS) assert.ok(WEBANK_GROUPS.includes(f.grp), `分组 ${f.grp} 未登记`);
});

/* ---------- 8. 枚举码不臆造 ---------- */
test("枚举码保留原值：字典里明确标注「枚举字典未提供」", () => {
  for (const k of ["thi_class", "fund_pattern", "fund_type", "risk_level", "stb_fin_zone"]) {
    const f = WEBANK_FIELDS.find(x => x.k === k);
    assert.ok(f && f.src.includes("枚举字典未提供"), `${k} 要标注无字典表`);
  }
  const rec = matchShelf(SHELF, "YJ01251204A").rec;
  assert.equal(typeof rec.thi_class, "string", "形态码保留原值，不翻译");
});

/* ---------- 9. 接线测试：app.js 真的用了这些判据（防假绿）---------- */
test("接线：app.js 导入静态索引与判据，并在详情/录入/扫码三处调用", () => {
  const app = read("app.js");
  assert.match(app, /import WEBANK_SHELF from "\.\/js\/core\/webank-shelf\.js"/, "没导入静态索引");
  assert.match(app, /from "\.\/js\/core\/webank\.js"/, "没导入判据模块");
  /* ★ 锚定「调用点」而不是函数定义签名 —— 否则删掉挂点后正则仍被
     `function webankBlock(p) {` 满足，接线测试会假绿（变异反证抓到过）。 */
  assert.match(app, /\$\{webankBlock\(p\)\}/, "产品详情没挂动态字段区（要匹配模板插值，不是函数定义）");
  assert.match(app, /const hint = webankHintHtml\(code\)/, "产品表单实时提示没接");
  assert.match(app, /webankHintHtml\(r\.prodCode/, "链接/粘贴预览没接");
  assert.match(app, /matchShelf\(WEBANK_SHELF, line\)/, "扫码回填没接");
  assert.match(app, /matchShelf\(WEBANK_SHELF, x\.key/, "多行预览没接");
});
test("接线：详情动态区金额走 shown()，缺字段不占位，未命中不显示", () => {
  const app = read("app.js");
  const blk = app.slice(app.indexOf("function webankBlock("), app.indexOf("function webankHintHtml("));
  assert.match(blk, /r\.money \? shown\(/, "金额字段没走 shown()");
  assert.match(blk, /if \(!m\.hit\) return ""/, "未命中要返回空串（诚实降级）");
  assert.match(blk, /groupedFields\(rec\)/, "动态字段要走分组判据");
  assert.match(blk, /agentBanks\(rec\)/, "代销要走归并判据");
  assert.match(blk, /未披露代销信息/, "无代销证据要诚实标注");
});
test("接线：sw.js 的 SHELL 收了两个新模块（版本号不在本文件重复钉）", () => {
  const sw = read("sw.js");
  assert.ok(sw.includes('"./js/core/webank.js"'), "SHELL 漏 webank.js（离线整页空白）");
  assert.ok(sw.includes('"./js/core/webank-shelf.js"'), "SHELL 漏静态索引");
  /* v97 · P1 收敛：APP_VER/CACHE 的版本号一致性只在 handlers.test.mjs 唯一总测 +
     scripts/check-version.sh 守。这里刻意不写 const APP_VER = "vNN" 之类的硬编码断言，
     免得发版时又多一处要同步的钉子（审查报告 P1 的核心教训）。 */
});

/* ================= v98 · 残留风险修复的回归测试 ================= */

/* ---------- 10. 快照新鲜度判据（UI 与 CI 软哨兵共用同一处） ---------- */
test("新鲜度：三档分界 + 注入 now 可测 + 边界当天", () => {
  const cap = shelfMeta(SHELF).captured_at;                 // 2026-11-07
  const at = iso => shelfFreshness(SHELF, iso);
  assert.equal(withCap(cap, 0).level, "fresh", "当天=0 天，新鲜");
  assert.equal(withCap(cap, SHELF_FRESH_DAYS).level, "fresh", "恰好 30 天仍是新鲜（闭区间）");
  assert.equal(withCap(cap, SHELF_FRESH_DAYS + 1).level, "aging", "31 天进入提醒档");
  assert.equal(withCap(cap, SHELF_STALE_DAYS).level, "aging", "恰好 90 天仍是提醒档");
  assert.equal(withCap(cap, SHELF_STALE_DAYS + 1).level, "stale", "91 天判过期");
  assert.equal(withCap(cap, 200).stale, true, "过期档 stale=true，UI 才显示引导");
  assert.equal(withCap(cap, 0).hint, "", "新鲜档不打扰用户");
  assert.match(withCap(cap, 200).hint, /gen-webank-shelf\.mjs/, "过期引导要给出重跑入口");
  // 真实索引按真实时间也应落在新鲜档（本轮刚采集），防止快照日期被写死成未来
  assert.equal(at(new Date().toISOString()).level === "unknown", false, "真实索引日期必须可解析");
});
/** 以快照日为基准，构造 N 天后的 ISO 时间 */
function withCap(cap, days) {
  const d = new Date(cap + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return shelfFreshness(SHELF, d.toISOString());
}
test("新鲜度：未来日期钳到 0、缺失/非法日期诚实降级为 unknown", () => {
  assert.equal(withCap(shelfMeta(SHELF).captured_at, -5).days, 0, "时钟回拨不产生负天数");
  assert.equal(withCap(shelfMeta(SHELF).captured_at, -5).level, "fresh");
  const bad = shelfFreshness({ meta: { captured_at: "未知" } }, "2026-11-07T00:00:00Z");
  assert.equal(bad.level, "unknown");
  assert.equal(bad.stale, true, "日期缺失也要按「不新鲜」处理，不冒充新鲜");
  const badTime = shelfFreshness(SHELF, "not-a-date");
  assert.equal(badTime.level, "unknown", "无效时间参数不臆测");
  assert.equal(badTime.days, null);
});

/* ---------- 11. 代销口径不丢、不混用（v98 真修复） ---------- */
test("代销口径：同名银行多来源收进 vias[]，不再只留第一个 via", () => {
  const rec = { agents: [
    { name: "微众银行", via: "净值瞭望详情页" },
    { name: "微众银行", via: "净值瞭望列表行" },
    { name: "网商银行", via: "净值瞭望列表行" },
  ] };
  const banks = agentBanks(rec);
  assert.deepEqual(banks.map(b => b.name), ["微众银行", "网商银行"], "仍按名去重保序");
  assert.deepEqual(banks[0].vias, ["净值瞭望详情页", "净值瞭望列表行"], "两条口径都要留");
  assert.deepEqual(banks[0].tags, ["详情页", "列表行"], "短标签供 UI 可见标注");
  assert.equal(banks[0].via, "净值瞭望详情页", "兼容旧消费方：via 仍是主口径");
});
test("代销口径：新版静态索引真恢复了被旧脚本吞掉的多口径证据", () => {
  // 旧生成脚本按名去重 → 同名第二个 via 被丢；v98 恢复。至少 6 条实证。
  let multi = 0;
  for (const r of Object.values(SHELF.byCode)) {
    for (const b of agentBanks(r)) if (b.vias.length > 1) multi++;
  }
  assert.ok(multi >= 6, `静态索引里应有恢复的多口径银行，实测 ${multi}`);
  const g = agentBanks(matchShelf(SHELF, "NYJXLD1409G").rec);
  assert.ok(g.some(b => b.vias.includes("净值瞭望详情页") && b.vias.includes("净值瞭望列表行")),
    "固收+ 样例应同时带两种口径证据");
});
test("口径短标签：只去公共前缀，不改语义", () => {
  assert.equal(agentViaTag("净值瞭望列表行"), "列表行");
  assert.equal(agentViaTag("净值瞭望详情页"), "详情页");
  assert.equal(agentViaTag("其他来源"), "其他来源");
  assert.equal(agentViaTag(""), "");
});

/* ---------- 12. 生成脚本：快照日期参数化（不再硬编码） ---------- */
test("生成脚本：captured_at 不再写死字符串，改为可覆盖 + 证据推导", () => {
  const g = read("scripts/gen-webank-shelf.mjs");
  assert.doesNotMatch(g, /captured_at:\s*"20\d\d-\d\d-\d\d"/, "meta 里不许再硬编码日期");
  assert.match(g, /--captured-at/, "要有显式覆盖参数");
  assert.match(g, /resolveCapturedAt/, "要有日期推导函数");
  assert.match(g, /validDay/, "要校验日历合法性（2026-02-30 不能过）");
  assert.match(g, /dateFromEvidence/, "快照日期要来自证据文件 captured_at，不臆造");
  const head = read("js/core/webank-shelf.js").split("\n").slice(0, 6).join("\n");
  assert.doesNotMatch(head, /v\d+ ·/, "产物头注释不写版本号（避免每发一版同步假钉子）");
});

/* ---------- 13. 软哨兵接线：CI 与本地 check 都跑，且退出码恒 0 ---------- */
test("软哨兵：脚本存在、接进 package.json 与 CI、且不阻断发布", () => {
  const s = read("scripts/check-shelf-freshness.mjs");
  assert.match(s, /process\.exit\(0\)/, "退出码必须恒 0（不制造假红）");
  assert.doesNotMatch(s, /process\.exit\(1\)/, "不许把过期/膨胀做成硬失败");
  assert.match(s, /shelfFreshness/, "必须复用同一判据，不另写一套日期逻辑");
  assert.match(s, /gzipSync/, "要有体积护栏");
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.check, /shelf-health/, "本地 npm run check 要跑软哨兵");
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /check-shelf-freshness\.mjs/, "CI 要有软哨兵 step");
});

/* ---------- 14. app.js 接线：新鲜度徽标 + 代销口径可见标注 ---------- */
test("接线：app.js 用 shelfFreshness 渲染徽标，代销口径从 title 升级为可见", () => {
  const app = read("app.js");
  assert.match(app, /shelfFreshness/, "要导入/使用新鲜度判据");
  const blk = app.slice(app.indexOf("function webankBlock("), app.indexOf("function webankHintHtml("));
  /* ★ 锚定模板插值而非函数体里的变量引用：只删 ${freshHtml} 挂点时，
     函数体内 fresh.label 仍在 → 宽松正则会假绿（v97 接线测试踩过同款坑）。 */
  assert.match(blk, /\$\{freshHtml\}/, "详情模板没挂新鲜度徽标区（要匹配插值，不是变量定义）");
  assert.match(blk, /fresh\.label/, "详情区要渲染新鲜度标签");
  assert.match(blk, /fresh\.hint/, "过期要显示重跑引导");
  assert.match(blk, /b\.tags/, "代销银行要按口径可见标注（不再只藏 title）");
  assert.match(blk, /两口径分别标注|不混用/, "要写明两口径不混用");
  const hint = app.slice(app.indexOf("function webankHintHtml("), app.indexOf("function renderProdDetail("));
  assert.match(hint, /fresh\.stale/, "录入提示在过期时也要提醒");
});
