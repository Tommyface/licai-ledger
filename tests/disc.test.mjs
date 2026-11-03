/* 底层配置与申赎规则（T1）的口径测试：node --test tests/disc.test.mjs
   这一层的价值全在「空值语义」上，所以每一条都在问同一类问题：
     · 没录 / 录了但没出处 / 录了但自相矛盾 —— 三种情况必须可区分；
     · 任何一处都不许把「不知道」变成 0 或空串，否则 T7 会拿假规则算出看不出错的建议。
   另外钉住 schema 与 js/core/disc.js 是同一条契约的两半：
   枚举值必须一致，schema 也不许使用校验器不认识的关键字（那种情况下
   scripts/validate_data.py 会直接报错而不是静默放过，见其 SUPPORTED 集合）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISC_TIERS, parseFeeLine, parseAssetLine, parseDiscForm, normDisc, discGaps, feeRateFor,
} from "../js/core/disc.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

/* ---- 一份「填全了」的表单，各条测试在它之上做单点改动 ---- */
const FULL = {
  lockDays: "180", openRule: "每周二开放赎回，T+1 到账",
  feeRedeem: "0-7 1.50\n7-30 0.50\n30-180 0.10\n180+ 0",
  assets: "非标准化债权类资产 42.5\n同业存单 30\n债券 27.5",
  investScope: "固定收益类资产不低于 80%",
  sourceUrl: "https://www.example.com/disclosure/abc.pdf", sourceTier: "official",
  sourcePublishedAt: "2026-09-30"
};
const okForm = (over) => parseDiscForm(Object.assign({}, FULL, over || {}));

/* ---------- 1. 空值语义 ---------- */

test("老数据没有 disc 对象：一律按全未披露，且六项都算缺口", () => {
  const d = normDisc(undefined);
  assert.equal(d.status, "none");
  assert.equal(d.lockDays, null, "lockDays 不能默认成 0");
  assert.deepEqual(d.feeRedeem, []);
  assert.deepEqual(d.assets, []);
  assert.equal(d.source, null);
  assert.deepEqual(discGaps(undefined),
    ["lockDays", "openRule", "feeRedeem", "assets", "investScope", "source"]);
});

test("填 0 与留空是两回事：0 天表示确知无持有期，不再是缺口", () => {
  const zero = okForm({ feeRedeem: "", assets: "", lockDays: "0", openRule: "每日开放", investScope: "",
    sourceTier: "disclosure" });
  assert.equal(zero.errors.length, 0, zero.errors.join("；"));
  assert.equal(zero.disc.lockDays, 0);
  const gaps = discGaps(zero.disc);
  assert.ok(!gaps.includes("lockDays"), "0 天是有效披露，不该报缺");
  assert.ok(gaps.includes("feeRedeem") && gaps.includes("investScope"));
});

test("脏字段降级成未知，不会造出假规则", () => {
  const d = normDisc({ lockDays: "七天", feeRedeem: [{ from: 0 }, null, { from: 0, to: 7, ratePct: "1.5" }],
    assets: [{ name: "" }, { name: "债券", pct: 30 }], source: { url: "javascript:alert(1)", tier: "official" } });
  assert.equal(d.lockDays, null);
  assert.deepEqual(d.feeRedeem, [], "缺 ratePct / 类型不对的分档整条丢弃");
  assert.deepEqual(d.assets, [{ name: "债券", pct: 30 }]);
  assert.equal(d.source, null, "非 http(s) 的出处一律不认");
  assert.equal(d.status, "none", "只剩脏数据时等同于没录");
});

/* ---------- 2. 分档解析与边界 ---------- */

test("分档的四种写法都能解析，且费率是百分数本身", () => {
  assert.deepEqual(parseFeeLine("0-7 1.50"), { from: 0, to: 7, ratePct: 1.5 });
  assert.deepEqual(parseFeeLine("7~30 0.5"), { from: 7, to: 30, ratePct: 0.5 });
  assert.deepEqual(parseFeeLine("30到180 0.1"), { from: 30, to: 180, ratePct: 0.1 });
  assert.deepEqual(parseFeeLine("180+ 0"), { from: 180, to: null, ratePct: 0 },
    "最后一档无上限，费率 0 表示确知免费");
  assert.equal(parseFeeLine("0-7"), null, "没有费率就是无效行，不能当成 0%");
  assert.equal(parseFeeLine("7-7 1"), null, "区间倒挂/等高是笔误");
  assert.equal(parseFeeLine("随便写的"), null);
});

test("取档按 [from, to)：满 7 天落到下一档，落进空洞按未知", () => {
  const d = okForm().disc;
  assert.equal(feeRateFor(d, 6.9), 1.5);
  assert.equal(feeRateFor(d, 7), 0.5, "边界归下一档，否则同一天出现两个答案");
  assert.equal(feeRateFor(d, 180), 0);
  assert.equal(feeRateFor(d, 9999), 0);
  const hole = normDisc({ feeRedeem: [{ from: 0, to: 7, ratePct: 1.5 }, { from: 10, to: null, ratePct: 0 }],
    source: { url: "https://a.com/x", tier: "official" } });
  assert.equal(feeRateFor(hole, 8), null, "8 天不在任何档里 → 未知，绝不是 0");
  assert.equal(feeRateFor(d, undefined), null);
  assert.equal(feeRateFor(normDisc(undefined), 30), null, "没录分档时不许返回 0 冒充免费");
});

test("分档必须首尾相接：空洞、重叠、无上限后又来一档都要拦下", () => {
  assert.ok(okForm({ feeRedeem: "0-7 1.50\n10-30 0.50\n30+ 0" }).errors.length, "有空洞");
  assert.ok(okForm({ feeRedeem: "0-10 1.50\n7-30 0.50\n30+ 0" }).errors.length, "有重叠");
  assert.ok(okForm({ feeRedeem: "0-7 1.50\n7+ 0\n30+ 0" }).errors.length, "无上限档之后不能再有档");
  const clean = okForm({ feeRedeem: "0-7 1.50\n7+ 0" });
  assert.equal(clean.errors.length, 0, clean.errors.join("；"));
  assert.deepEqual(clean.disc.feeRedeem, [{ from: 0, to: 7, ratePct: 1.5 }, { from: 7, to: null, ratePct: 0 }]);
});

/* ---------- 3. 出处（铁律 3） ---------- */

test("填了内容就得带出处，来源只能是官方披露或代销转发页", () => {
  assert.ok(okForm({ sourceUrl: "" }).errors.some(e => e.includes("出处")));
  assert.ok(okForm({ sourceUrl: "example.com/x" }).errors.some(e => e.includes("http")), "非完整 URL");
  assert.ok(okForm({ sourceTier: "media" }).errors.some(e => e.includes("不许存入")), "媒体报道不能当规则来源");
  assert.ok(okForm({ sourceTier: "unknown" }).errors.some(e => e.includes("不许存入")));
  assert.ok(okForm({ sourceTier: "disclosure" }).errors.length === 0, "代销转发页是可以的");
  /* 什么都不填时不该要求出处 —— 否则「未披露」这种正确状态反而存不下去 */
  const none = parseDiscForm({});
  assert.equal(none.errors.length, 0, none.errors.join("；"));
  assert.equal(none.disc.status, "none");
  assert.equal(none.disc.source, null);
});

/* ---------- 4. 底层资产 ---------- */

test("资产行：占比可缺、超 100% 拦下、名称里的空格不误判", () => {
  assert.deepEqual(parseAssetLine("同业存单 30"), { name: "同业存单", pct: 30 });
  assert.deepEqual(parseAssetLine("现金及银行存款"), { name: "现金及银行存款", pct: null });
  assert.deepEqual(parseAssetLine("非标准化债权类资产 42.5%"), { name: "非标准化债权类资产", pct: 42.5 });
  assert.equal(parseAssetLine("债券 120"), null, "占比超 100% 多半是漏了百分号或填了金额");
  const over = okForm({ assets: "债券 60\n同业存单 60" });
  assert.ok(over.errors.some(e => e.includes("超过 100%")));
  const noPct = okForm({ assets: "债券\n同业存单" });
  assert.equal(noPct.errors.length, 0, "只给类别不给比例是常见披露形态，不算错");
  assert.deepEqual(noPct.disc.assets, [{ name: "债券", pct: null }, { name: "同业存单", pct: null }]);
});

test("认不出的行必须回显给用户，不能静默丢掉", () => {
  const r = okForm({ feeRedeem: "0-7 1.50\n七天内 1.5" });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("七天内 1.5"), "错误消息里要带着原行");
});

/* ---------- 5. 存回去再读出来必须一致 ---------- */

test("录入结果再过一遍 normDisc 不变（回显与 T7 读到的是同一份）", () => {
  const once = okForm().disc;
  const twice = normDisc(once);
  assert.deepEqual(twice, once);
  assert.equal(once.status, "manual");
  assert.equal(once.source.tier, "official");
  assert.equal(once.source.publishedAt, "2026-09-30");
});

/* ---------- 6. 与数据仓 schema 的同一条契约（两仓各钉一半） ---------- */
/* schema/licai-data.schema.json 与 scripts/validate_data.py 在**数据仓**，网页仓里没有
   这两个文件，所以这里不能去读它们（读了就是本地过、CI 崩）。
   做法是两边各钉同一组字面值：代码侧钉这里，schema 侧由数据仓
   tests/test_validate_data.py 用真校验器执行（test_disc_bad_tier_rejected 等），
   谁把档位改漏、把 enum 删掉，对应那半边立刻红。 */

test("来源分级只有四档，顺序与字面值都不许改", () => {
  assert.deepEqual(DISC_TIERS, ["official", "disclosure", "media", "unknown"],
    "数据仓 schema 的 discSource.tier.enum 写的是同一组值，改这边必须同时改那边");
  assert.equal(new Set(DISC_TIERS).size, 4, "重复档位会让 normDisc 的判定出现两种解释");
  /* 规则类内容只认前两档，后两档一律拒绝 —— 这条是铁律 3 的落点 */
  assert.ok(okForm({ sourceTier: "media" }).errors.length, "媒体来源不该被拒");
  assert.ok(okForm({ sourceTier: "unknown" }).errors.length, "出处不明不该被拒");
  assert.equal(okForm({ sourceTier: "official" }).errors.length, 0);
  assert.equal(okForm({ sourceTier: "disclosure" }).errors.length, 0);
});

test("录入状态只有三档，任何来源都产生不出第四种值", () => {
  /* 行为层面钉死：status 只可能是 none / manual / auto，
     脏数据（别的设备写的 status:"xx"）降级成 manual，而不是原样带过去，
     否则界面字典查不到就会显示成 undefined。 */
  const full = okForm().disc;
  assert.equal(full.status, "manual", "T1 的写入路径只产生 manual");
  assert.equal(normDisc(Object.assign({}, full, { status: "auto" })).status, "auto");
  assert.equal(normDisc(Object.assign({}, full, { status: "随手写的" })).status, "manual");
  assert.equal(normDisc(Object.assign({}, full, { source: null })).status, "none");
  /* 文案层面：三档都得有中文，缺一档界面就会显示 undefined */
  const app = read("app.js");
  assert.ok(app.includes('DISC_STATUS_TEXT = { none: "未录入", manual: "手工录入", auto: "检索回填" }'),
    "状态中文映射少了档位或改了措辞，缺出处那条分支也要跟着复核");
  assert.ok(app.includes('if (!d.source) return "缺出处";'),
    "有内容追不到出处时必须显示缺出处，不能显示未录入");
});

/* ---------- 7. 页面接线（漏一处就是点了没反应 / 看不见） ---------- */

test("详情页有这张卡，且两个入口都挂回了 window", () => {
  const app = read("app.js");
  /* 导入行允许换行，但必须从 disc.js 拿到这一层的全部口径出口 */
  const imp = /import \{([^}]*)\} from "\.\/js\/core\/disc\.js";/.exec(app);
  assert.ok(imp, "app.js 没接上 disc.js");
  ["DISC_TIERS", "normDisc", "parseDiscForm", "discGaps", "discHasContent", "feeRateFor",
    "DISC_TIER_LABEL", "DISC_GAP_LABEL"].forEach(n =>
    assert.ok(imp[1].split(",").map(x => x.trim()).filter(Boolean).indexOf(n) >= 0, `disc.js 的 ${n} 没被 app.js 导入`));
  assert.ok(app.includes("${discCard(p, pos)}"), "产品详情里没渲染底层配置卡");
  assert.ok(app.includes('if (!d.source) return "缺出处";'),
    "有内容却追不到出处时，状态必须显示「缺出处」——说成未录入是撒谎，说成已录入等于盖了可信的章");
  assert.ok(app.includes("const warn = gaps.length && discHasContent(d)"),
    "缺项提示要在有内容时才出现，未录入的干净产品不该被一堆警告刷屏");
  const bridge = app.slice(app.indexOf("Object.assign(window, {"));
  assert.ok(bridge.includes("openDisc") && bridge.includes("saveDisc"),
    "ES module 顶层函数不自动上 window，内联 onclick 会 ReferenceError");
  assert.ok(/onclick="openDisc\('\$\{p\.id\}'\)"/.test(app),
    "桥接扫描只认 on*=\"fn(...)\" 的第一个函数名，别写成 closeSheet();openDisc(...)");
  /* 离线清单必须有新模块，漏一个就是装完 App 离线打开整页空白 */
  const shell = read("sw.js");
  assert.ok(shell.includes('"./js/core/disc.js"'), "disc.js 没进 sw.js 的 SHELL");
  assert.ok(shell.includes('const CACHE = "licai-ledger-v63"'), "SHELL 变了 CACHE 就得跟着升");
  assert.ok(app.includes('const APP_VER = "v63"'), "APP_VER 要与 CACHE 同值");
});

test("有内容但出处无效：内容照留，状态与缺口要如实反映缺出处", () => {
  /* 这种组合前端写不进去（parseDiscForm 会拦），只可能来自手改数据或别的设备的快照。
     丢弃内容会让用户以为录入丢了；当成正常录入等于给追不到处的规则盖章。 */
  const d = normDisc({ lockDays: 7, openRule: "每月开放",
    feeRedeem: [{ from: 0, to: null, ratePct: 0 }] });
  assert.equal(d.lockDays, 7, "脏出处不该顺手清掉有效内容");
  assert.equal(d.status, "none");
  assert.deepEqual(discGaps(d).filter(g => g === "source"), ["source"]);
});

test("清空全部字段等于回到未披露，而不是留下半截配置", () => {
  const r = parseDiscForm({ sourceUrl: "https://a.com/x", sourceTier: "official" });
  assert.equal(r.errors.length, 0, r.errors.join("；"));
  assert.equal(r.disc.status, "none", "只有出处没有内容，仍算未录入");
  assert.ok(discGaps(r.disc).includes("source"), "内容清空后出处不该继续算作有效披露");
});
