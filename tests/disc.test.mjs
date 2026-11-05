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
  discSourceOk, applyAutoDisc, rulesDue, RULES_COOLDOWN_DAYS, DISC_GAP_LABEL,
  applyRulesFeed, rulesFeedReg,
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
  assert.ok(shell.includes('const CACHE = "licai-ledger-v81"'), "SHELL 变了 CACHE 就得跟着升");
  assert.ok(app.includes('const APP_VER = "v81"'), "APP_VER 要与 CACHE 同值");
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

/* ---------- 8. T1b：官网档案自动回填（v70 起，v71 修了两处口径，v73 清了一段与线上相反的注释） ----------
   这一节的每一条都在问同一类问题：机器写账的时候有没有越权。
   fixture 的形状照抄 navsources/rules.py 的 _seal 输出（2026-11-03 实测三家真实回包），
   不是我自己想象的样子。 */

/* 北银真实档案封出来的样子（PROD_TERM_DAYS=7 / NAV_DATE=20261102） */
const BOB_GOT = () => ({
  org: "bob",
  rules: { lockDays: 7, openRule: "最短持有 / 最低持有7天", feeRedeem: [], assets: [], investScope: "" },
  meta: { regCode: "Z7008926000006" },
  source: { url: "https://beijingbobwealth.com.cn/bylc-api/product/info?PROD_CODE=YJ01251204A",
    title: "春系列诚享7天持有期29号A类份额", publishedAt: "2026-11-02",
    fetchedAt: "2026-11-04T01:00:00.000Z", tier: "official" },
  gaps: ["feeRedeem", "assets", "investScope"], why: ""
});

test("出处合格判据：URL 与发布时间两样齐 —— 缺一样就不算出处", () => {
  assert.equal(discSourceOk(null), false);
  assert.equal(discSourceOk({}), false);
  assert.equal(discSourceOk({ url: "https://a.com/x" }), false, "有链接没日期说不出哪天披露的");
  assert.equal(discSourceOk({ publishedAt: "2026-11-02" }), false, "有日期没链接追不到原文");
  assert.equal(discSourceOk({ url: "a.com/x", publishedAt: "2026-11-02" }), false, "不是完整地址");
  assert.equal(discSourceOk({ url: "https://a.com/x", publishedAt: "2026-11-02" }), true);
});

test("空账本 + 合格出处：补上的项进账、状态记成检索回填、出处一起落", () => {
  const p = { name: "北银诚享7天持有期29号" };
  const r = applyAutoDisc(p, BOB_GOT());
  assert.equal(r.ok, true);
  assert.deepEqual(r.filled, ["lockDays", "openRule"]);
  assert.deepEqual(r.kept, [], "本来没东西，谈不上覆盖");
  assert.equal(p.disc.lockDays, 7);
  assert.equal(p.disc.status, "auto", "全新一条来自检索，不能记成手工录入");
  assert.equal(p.disc.source.publishedAt, "2026-11-02", "披露日期是站内的，不是 fetchedAt");
  assert.notEqual(p.disc.source.fetchedAt, undefined);
  assert.equal(p.disc.source.tier, "official");
  assert.deepEqual(discGaps(p.disc), ["feeRedeem", "assets", "investScope"]);
  assert.deepEqual(r.gaps, discGaps(p.disc), "回给界面的缺口必须与 discGaps 同口径");
  assert.equal(p.regCode, "Z7008926000006", "登记编码是去别处查的钥匙，空着就该补上");
});

test("手工值优先：官网给的数不覆盖已录项，只补空着的", () => {
  const p = { disc: { status: "manual", lockDays: 30, openRule: "", feeRedeem: [], assets: [],
    investScope: "固定收益类不低于 80%",
    source: { url: "https://manual.example/a.pdf", title: "说明书", publishedAt: "2026-09-30", tier: "official" } } };
  const r = applyAutoDisc(p, BOB_GOT());
  assert.equal(r.ok, true);
  assert.equal(p.disc.lockDays, 30, "官网说 7 天也不许盖掉手工录的 30 天");
  assert.deepEqual(r.kept, ["lockDays", "investScope"]);
  assert.deepEqual(r.filled, ["openRule"], "只有空着的那项被补");
  assert.equal(p.disc.status, "manual", "原本有内容 → 状态仍是手工，别把人工录的说成机器填的");
  assert.equal(p.disc.source.url, "https://manual.example/a.pdf", "已有出处不动");
  assert.equal(p.regCode, "Z7008926000006", "登记编码空着就补上（它是去别处查的钥匙，不是手工录的规则值）");
});

test("脏记录（有内容没出处）回填后：状态不许还写着「未录入」，但手工那项仍不动", () => {
  /* normDisc 把「有内容 + 出处无效」判成 status:none（界面另有「缺出处」那一格）。
     v70 的 applyAutoDisc 只在原本全空时改状态，于是这种记录补完字段、挂上官网出处之后
     仍是 none —— 卡片顶上写「未录入」，底下三行却明明有值，同一屏说了两句相反的话。 */
  const p = { disc: { status: "manual", lockDays: 14, openRule: "", feeRedeem: [], assets: [],
    investScope: "", source: null } };
  const r = applyAutoDisc(p, BOB_GOT());
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, ["lockDays"], "手工录的 14 天仍然挡住官网的 7 天");
  assert.equal(p.disc.lockDays, 14, "值一个都不许被盖掉");
  assert.equal(p.disc.status, "auto", "字段与出处都来自这一次检索 → 记检索回填，不能留「未录入」");
  assert.equal(p.disc.source.tier, "official");
});

test("出处不合格：一条都不写，只把缺口如实报出去", () => {
  /* rules.py 的 _seal 在这种情况下已经把 rules 倒空了；JS 这侧再判一次是防御，
     万一以后有条路绕过 _seal（手工导入了半截 JSON），账面也不能被写脏。 */
  const got = BOB_GOT();
  delete got.source.publishedAt;
  got.why = "官网产品档案里没有可读到的披露日期，按未入账处理（只记缺口）";
  const p = { name: "某产品" };
  const r = applyAutoDisc(p, got);
  assert.equal(r.ok, false);
  assert.equal(p.disc, undefined, "没出处就连一个字段都不许落地");
  assert.deepEqual(r.filled, []);
  assert.equal(r.why, got.why, "Python 说的那句原因要原样带到前台，别换一句话");
  assert.equal(r.gaps.length, 6, "六项全缺（五项规则 + 出处）");
});

test("官网回包里混进脏值：走 normDisc 那套类型口径，不许写出半截规则", () => {
  const got = BOB_GOT();
  got.rules.lockDays = "七天";                     // 非数 → 未知，不是 0
  got.rules.assets = "固定收益类";                  // 不是数组 → 丢弃
  got.rules.feeRedeem = [{ from: 0, to: null, ratePct: "1.5" }];
  const p = {};
  const r = applyAutoDisc(p, got);
  assert.equal(r.ok, true);
  assert.equal(p.disc.lockDays, null);
  assert.deepEqual(p.disc.assets, []);
  assert.deepEqual(p.disc.feeRedeem, [], "费率是字符串的那一档认不出来就别写，写了 T7 会当数算");
  assert.deepEqual(r.filled, ["openRule"]);
});

test("一项都没补上时连出处也不写：账面保持原样", () => {
  const p = { disc: { status: "manual", lockDays: 7, openRule: "最短持有", feeRedeem: [],
    assets: [], investScope: "", source: null } };
  const got = BOB_GOT();
  got.rules.investScope = ""; got.rules.assets = [];   // 官网这几项本来就没有
  const before = JSON.stringify(p);
  const r = applyAutoDisc(p, got);
  assert.equal(r.ok, true);
  assert.deepEqual(r.filled, []);
  assert.equal(JSON.stringify(p), before, "没补任何东西就不许改动账面（出处也不能单独挂上去）");
  assert.ok(r.gaps.includes("source"), "有内容没出处 → 缺口里必须还有 source");
});

test("冷却：五项都齐不跑；30 天内试过不跑；过期/没试过/时间在 futuro 都跑", () => {
  const D = 86400000, now = Date.parse("2026-11-04T00:00:00.000Z");
  const iso = ms => new Date(ms).toISOString();
  assert.equal(rulesDue({ }, now), true, "新添加的产品没有 rulesAt = 没试过");
  assert.equal(rulesDue({ rulesAt: "不是时间" }, now), true, "认不出来就重跑，别当永久冷却");
  assert.equal(rulesDue({ rulesAt: iso(now - 10 * D) }, now), false, "10 天前刚翻过页");
  assert.equal(rulesDue({ rulesAt: iso(now - (RULES_COOLDOWN_DAYS - 1) * D) }, now), false);
  assert.equal(rulesDue({ rulesAt: iso(now - RULES_COOLDOWN_DAYS * D) }, now), true, "满 30 天该再跑");
  assert.equal(rulesDue({ rulesAt: iso(now + 5 * D) }, now), true, "时钟倒挂按没试过处理");
  const full = { lockDays: 7, openRule: "最短持有", feeRedeem: [{ from: 0, to: null, ratePct: 1.5 }],
    assets: [{ name: "债券", pct: 80 }], investScope: "固定收益类",
    source: { url: "https://a.com/x", publishedAt: "2026-10-01", tier: "official" } };
  assert.equal(rulesDue({ disc: full }, now), false, "齐了就不该再去打扰官网");
  assert.equal(rulesDue({ disc: { ...full, source: null } }, now), false,
    "只差出处不值得再跑一趟：出处是手工的活，自动那条给不出来就别白翻");
});

test("页面接线：规则回填复用净值那条桥，两处挂钩 + 前台话术都在", () => {
  const app = read("app.js");
  assert.ok(/mode: "rules"/.test(app), "没往桥里写 mode，Python 会当成净值请求跑");
  assert.ok(/fetchedAt: new Date\(\)\.toISOString\(\)/.test(app),
    "fetchedAt 由页面盖：Python 的解析侧不读时钟，谁的表谁写");
  assert.ok(!/NativeNav\.(rules|disc)/.test(app),
    "不许另开桥方法：复用 NativeNav.fetch，Java 侧少一处可漏的守卫");
  assert.ok(app.includes('autoFillRules(target, "add")'), "添加产品后没跑回填");
  assert.ok(app.includes('await autoFillRules(cur, "sync")'), "净值抓完后没按冷却跑回填");
  assert.ok(app.includes("p.rulesAt = new Date().toISOString()"),
    "试过就得留凭据（进账本、跟着数据同步，不是 localStorage —— 铁律 6）");
  assert.ok(/徽银[^"]{0,20}翻页/.test(app), "徽银要翻页找产品，慢的事得提前在前台说");
  assert.ok(app.includes("网页版没有本机抓取，规则自动回填用不了"),
    "没有桥就要如实说用不了（铁律 10），不许留个按钮点了没反应");
  /* v71：抓取框只放得下三条，「不入账 / 没读到」这类话必须排在前面，
     被截掉的还要说清还有几只 —— 界面少说一句，用户就以为账本是齐的。 */
  assert.ok(/ruleNotes\.filter\(hardLine\)[\s\S]{0,120}slice\(0, 3\)/.test(app),
    "回填的话没按「严重的先说」排，最该看见的那句会被顺叙挤掉");
  assert.ok(/const hardLine = l => \/[^\n]*不入账[^\n]*\/\.test\(l\)/.test(app),
    "hardLine 的判据里必须认「不入账」");
  assert.ok(app.includes("录成什么样、还缺什么在各产品页的规则卡片上"),
    "被截掉的那几只要明说去哪看，而且措辞只能是卡片上真有的那两样"),
  assert.ok(!app.includes("回填说明在各产品页"),
    "卡片不复述「手工录入的不覆盖（…）」，措辞不能写得像那里也有整句回填说明")
  const imp = /import \{([^}]*)\} from "\.\/js\/core\/disc\.js";/.exec(app);
  ["applyAutoDisc", "rulesDue", "RULES_COOLDOWN_DAYS", "applyRulesFeed", "rulesFeedReg"].forEach(n =>
    assert.ok(imp[1].includes(n), `app.js 没导入 ${n}：口径第二处实现就会分叉`));
});

test("注释不许和已经上线的行为相反：T1 那句旧口径必须改掉，改完的话要有代码撑着", () => {
  /* 这段注释是这张卡的「说明书」：它说「只接受手工录入」的时候，回填早就在跑了。
     读代码的人信的是注释 —— 注释撒谎，比没注释更糟，因为它会把人往错的方向改。
     所以这一条既钉「旧句子不许回来」，也钉「新写的每一句都能在代码里落到实处」。 */
  const app = read("app.js");
  assert.ok(!/检索回填要等模型桥/.test(app),
    "回填 v70 就上线了，注释还写着「要等模型桥（T3）之后」：这是与线上行为相反的说明");
  assert.ok(!app.includes("T1 阶段只接受手工录入"),
    "「只接受手工录入」这句限定已经不成立，不许以任何形式留在 app.js 里");
  assert.ok(app.includes("这张卡有三条来路：手工录入"),
    "注释要说清这张卡有三条来路（手工 / T1b 本机桥 / v81 云端 feed），别只写两条");
  assert.ok(/两条自动来路都只经 applyAutoDisc\s+写这同一份 DATA/.test(app),
    "注释承诺两条自动来路都不另开写账通路 —— 这句话是 applyAutoDisc 唯一入口那条门禁的说明书");
  /* v81：注释里点名的第三条来路，代码里必须真有路径常量与落账调用，不许只写许愿 */
  assert.ok(app.includes('const RULES_FEED_PATH = "product-rules.json"') &&
    app.includes("applyRulesFeed(DATA, feed)"),
    "注释说有云端 feed 这条来路，代码里就得真有路径常量与落账调用");
  /* 注释里的每一句「前台会怎么说」都要真有对应的代码，不然就是许愿 */
  assert.ok(/请求带 mode:"rules"/.test(app) && /mode: "rules"/.test(app),
    "注释说请求带 mode:\"rules\"，代码里就得真带");
  assert.ok(app.includes("手工录入的不覆盖"),
    "注释说手工值优先、挡下来的项当场念，抓取框里就要真有那句");
});

/* ============================================================
   第 4 步（v81）：云端规则 feed → 账本
   ------------------------------------------------------------
   applyRulesFeed 只做「按登记编码配对 + 把 feed 条目翻成 applyAutoDisc 的 got」，
   判据一行都不重写。所以这里的测试专盯三件最容易走偏的事：
     · 出处不齐一条都不写（铁律 3 不能被新路径绕过去）；
     · 手工值仍然优先、状态仍由 applyAutoDisc 判（不另立第二套语义）；
     · rawQuote 只随返回值交给展示层，绝不进账本。
   ============================================================ */

const REG = "Z7008926000006";
const SRC = { url: "https://xinxipilu.chinawealth.com.cn/a.pdf",
  publishedAt: "2026-07-02", tier: "official" };
const RULES = { lockDays: 7, openRule: "每周二开放", feeRedeem: [{ from: 0, to: null, ratePct: 0 }],
  assets: [{ name: "固收", pct: 80 }], investScope: "固定收益类" };
const fEntry = (over = {}) => ({ regCode: REG, rules: JSON.parse(JSON.stringify(RULES)),
  source: Object.assign({}, SRC), rawQuote: { lockDays: "需持有 7 个自然日" }, ...over });
const fFeed = (products) => ({ version: 1, generatedAt: "2026-11-05T12:07:58Z", products });
const fData = (...ps) => ({ products: ps, trades: [], settings: {} });
const fProd = (over = {}) => ({ id: "p1", regCode: REG, ...over });

test("rulesFeedReg：regCode 优先，老数据放 code 里也认，形态不对一律空", () => {
  assert.equal(rulesFeedReg({ regCode: REG, code: "Z7002426000328" }), REG, "regCode 优先");
  assert.equal(rulesFeedReg({ code: REG }), REG, "老数据把登记编码放在 code 里也要认");
  ["z7008926000006", "Z700892600000", "Z70089260000066", "7008926000006", "", "EW4455D"]
    .forEach(v => assert.equal(rulesFeedReg({ regCode: v, code: v }), "",
      `不合规形态 ${v || "(空)"} 不能当登记编码`));
  assert.equal(rulesFeedReg(null), "");
  assert.equal(rulesFeedReg({}), "");
  assert.equal(rulesFeedReg({ regCode: 12345 }), "");
});

test("applyRulesFeed：出处齐的五字段按登记编码落账，状态与出处由 applyAutoDisc 判", () => {
  const d = fData(fProd());
  const st = applyRulesFeed(d, fFeed({ [REG]: fEntry() }));
  assert.equal(st.total, 1);
  assert.equal(st.matched, 1);
  assert.equal(st.filled, 5, "五项原本全空，全补上");
  assert.equal(st.kept, 0);
  const x = normDisc(d.products[0].disc);
  assert.equal(x.lockDays, 7);
  assert.equal(x.openRule, "每周二开放");
  assert.equal(x.status, "auto");
  assert.equal(x.source.url, SRC.url);
  assert.equal(x.source.publishedAt, SRC.publishedAt);
  assert.deepEqual(discGaps(x), [], "五项齐 + 有出处，一处缺口都不该剩");
});

test("applyRulesFeed：出处缺 publishedAt / url 不是 http / 整个为 null，一条都不写", () => {
  for (const bad of [Object.assign({}, SRC, { publishedAt: "" }),
                     Object.assign({}, SRC, { url: "ftp://x/y.pdf" }), null, {}]) {
    const d = fData(fProd());
    const st = applyRulesFeed(d, fFeed({ [REG]: fEntry({ source: bad }) }));
    assert.equal(st.matched, 1);
    assert.equal(st.badSource, 1);
    assert.equal(st.filled, 0);
    assert.deepEqual(normDisc(d.products[0].disc), normDisc(undefined),
      "账面保持全空，不许留「有出处没内容」的半截账");
    assert.deepEqual(st.quotes, {}, "出处不齐连摘录也不给展示层：没出处却摆一段原文更误导");
  }
});

test("applyRulesFeed：手工录入的项不覆盖，状态仍是 manual", () => {
  const manual = { status: "manual", lockDays: 180, openRule: "", feeRedeem: [],
    assets: [], investScope: "", source: { url: "https://x/y.pdf", publishedAt: "2026-01-01", tier: "official" } };
  const d = fData(fProd({ disc: manual }));
  const st = applyRulesFeed(d, fFeed({ [REG]: fEntry() }));
  assert.equal(st.kept, 1, "lockDays 被手工值挡下来");
  assert.equal(st.filled, 4, "其余四项补上");
  const x = normDisc(d.products[0].disc);
  assert.equal(x.lockDays, 180);
  assert.equal(x.status, "manual", "状态归 applyAutoDisc 判，页面不许自己改成 auto");
});

test("applyRulesFeed：跑第二遍不再写账（幂等）", () => {
  const d = fData(fProd());
  applyRulesFeed(d, fFeed({ [REG]: fEntry() }));
  const snap = JSON.stringify(d);
  const st2 = applyRulesFeed(d, fFeed({ [REG]: fEntry() }));
  assert.equal(st2.filled, 0);
  assert.equal(st2.kept, 5);
  assert.equal(JSON.stringify(d), snap, "第二遍一个字节都不许改");
});

test("applyRulesFeed：原文摘录只进返回值，绝不写进 DATA", () => {
  const d = fData(fProd());
  const st = applyRulesFeed(d, fFeed({ [REG]: fEntry() }));
  assert.equal(st.quotes[REG].lockDays, "需持有 7 个自然日");
  assert.ok(!JSON.stringify(d).includes("需持有 7 个自然日"), "账本里不许出现摘录原文");
  assert.ok(!JSON.stringify(d).includes("rawQuote"), "账本里不许出现 feed 的摘录字段");
});

test("applyRulesFeed：null 是未披露，不许被写成「0 天持有期」", () => {
  const d = fData(fProd());
  const e = fEntry(); e.rules.lockDays = null;
  const st = applyRulesFeed(d, fFeed({ [REG]: e }));
  assert.equal(st.filled, 4);
  assert.equal(normDisc(d.products[0].disc).lockDays, null);
});

test("applyRulesFeed：无编码 / feed 无条目 / 坏形状都不炸且统计准确", () => {
  const d = fData(
    { id: "a", code: "EW4455D" },                          // 无标准登记编码
    fProd({ id: "b", regCode: "Z7002426000328" }),         // 合规但 feed 里没这只
    fProd({ id: "c" }),                                    // 匹配且有合格出处
    null,                                                  // 坏产品
  );
  const st = applyRulesFeed(d, fFeed({ [REG]: fEntry() }));
  assert.equal(st.total, 4);
  assert.equal(st.skippedNoCode, 2, "一只没编码、一只 null");
  assert.equal(st.skippedNoEntry, 1);
  assert.equal(st.matched, 1);
  assert.equal(st.filled, 5);
  const empty = applyRulesFeed(fData(fProd()), null);
  assert.equal(empty.matched, 0);
  const arr = applyRulesFeed(fData(fProd()), { products: [] });
  assert.equal(arr.matched, 0, "products 写成数组也不能当字典用");
});

test("v81 接线：feed 落账排在唯一一次 saveLocal 之前、摘录不写 DATA、卡片有折叠入口", () => {
  const app = read("app.js");
  const iFeed = app.indexOf("const feed = await fetchRulesFeed()");
  const iApply = app.indexOf("applyRulesFeed(DATA, feed)");
  const iSave = app.indexOf("saveLocal();", iApply);
  assert.ok(iFeed > 0 && iApply > iFeed && iSave > iApply,
    "feed 落账必须在 saveLocal() 之前，否则 DIRTY 复位会漏掉这批就地修改");
  assert.ok(app.includes("RULES_QUOTES = rulesStat.quotes"), "摘录只进内存态");
  assert.ok(!/RULES_QUOTES\s*=\s*DATA/.test(app), "摘录不许挂到账本上");
  assert.ok(app.includes("<details") && app.includes("披露原文摘录"),
    "卡片要有折叠的原文摘录入口，且不许新增内联 handler");
  assert.ok(!/on\w+\s*=\s*"[^"]*quoteHtml|on\w+\s*=\s*"[^"]*RULES_QUOTES/.test(app),
    "原文摘录不该挂内联事件，handlers.test.mjs 的桥接扫描会多出无人认领的入口名");
  const imp = /import \{([^}]*)\} from "\.\/js\/core\/disc\.js";/.exec(app);
  assert.ok(imp && imp[1].includes("applyRulesFeed") && imp[1].includes("rulesFeedReg"));
});
