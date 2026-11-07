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
  applyRulesFeed, applyRulesFeeds, rulesFeedReg,
  regCodeDue, applyRegCode, REGCODE_COOLDOWN_DAYS,
  assetValueOf, applyAssetValue, assetValueText, setManualAssetValue, assetValueShort,
  assetHistoryOf, assetValueAt, assetHistoryViaLabel, assetHistoryRank, applyAssetHistory,
  benchViaLabel, applyBench,
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
  assert.ok(shell.includes('const CACHE = "licai-ledger-v94"'), "SHELL 变了 CACHE 就得跟着升");
  assert.ok(app.includes('const APP_VER = "v94"'), "APP_VER 要与 CACHE 同值");
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
  /* v81：注释里点名的第三条来路，代码里必须真有路径常量与落账调用，不许只写许愿
     （v83 队列 Q5 之后落账入口是复数形式 applyRulesFeeds：两份 feed 走同一个编排） */
  assert.ok(app.includes('const RULES_FEED_PATH = "product-rules.json"') &&
    app.includes("applyRulesFeeds(DATA,"),
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

/* ============================================================
   定期报告·持有资产实况（holdings）
   ------------------------------------------------------------
   holdings 是独立披露文件（定期投资报告），有它自己的 source，
   **不与销售文件的 source 连坐**。bob 这类发行方没有销售文件但有定期报告时，
   holdings 应当照常入账。守的规矩与五字段同源：
     · 出处合格且本地没有时才补（手工值优先）；
     · 出处不齐（holdings 自己的 source 不齐）一条都不写；
     · 两块都空（assetClasses + topHoldings 都空）不写；
     · 幂等：第二遍不再写账。
   ============================================================ */

const HOLDINGS_SRC = { url: "https://www.beijingbobwealth.com.cn/upload/pdf/dqgg.pdf",
  publishedAt: "2026-09-30", tier: "official" };
const HOLDINGS = () => ({
  asOf: "2026-09-30", leveragePct: 101.42, custodian: "北京银行股份有限公司",
  assetClasses: [{ category: "现金及银行存款", beforePct: 9.24, afterPct: 16.34 },
    { category: "债券", beforePct: 0.0, afterPct: 37.49 },
    { category: "资产管理产品", beforePct: 74.83, afterPct: 0.0 }],
  topHoldings: [{ name: "现金及活期存款", amount: 695646678.82, pct: 9.24 }],
  source: Object.assign({}, HOLDINGS_SRC),
});

test("applyRulesFeed：bob 场景——销售文件无出处但 holdings 有出处，holdings 照常落账", () => {
  const e = fEntry({ source: null,
    rules: { lockDays: null, openRule: "", feeRedeem: [], assets: [], investScope: "" },
    rawQuote: {}, gaps: ["lockDays", "openRule", "feeRedeem", "assets", "investScope", "source"],
    holdings: HOLDINGS() });
  const d = fData(fProd());
  const st = applyRulesFeed(d, fFeed({ [REG]: e }));
  assert.equal(st.badSource, 0, "holdings 有独立出处，不该被销售文件出处不齐连坐");
  assert.equal(st.holdings, 1, "holdings 落账计数");
  const x = normDisc(d.products[0].disc);
  assert.equal(x.holdings.asOf, "2026-09-30");
  assert.equal(x.holdings.assetClasses.length, 3);
  assert.equal(x.holdings.source.url, HOLDINGS_SRC.url);
});

test("applyRulesFeed：holdings 手工值优先——本地已有 holdings 时不覆盖", () => {
  const existing = { asOf: "2026-06-30", leveragePct: 100.0, custodian: null,
    assetClasses: [{ category: "现金及银行存款", beforePct: 50.0, afterPct: 50.0 }],
    topHoldings: null, source: Object.assign({}, HOLDINGS_SRC, { publishedAt: "2026-06-30" }) };
  const d = fData(fProd({ disc: { status: "manual", lockDays: null, openRule: "",
    feeRedeem: [], assets: [], investScope: "", source: null, holdings: existing } }));
  const st = applyRulesFeed(d, fFeed({ [REG]: fEntry({ holdings: HOLDINGS() }) }));
  assert.equal(st.holdings, 0, "holdings 已有值，不该再写");
  assert.equal(normDisc(d.products[0].disc).holdings.asOf, "2026-06-30", "手工 holdings 不被覆盖");
});

test("applyRulesFeed：holdings 自身出处不齐（source=null）时一条都不写", () => {
  const e = fEntry({ holdings: { asOf: null, assetClasses: null, topHoldings: null,
    leveragePct: null, custodian: null, source: null } });
  const d = fData(fProd());
  const st = applyRulesFeed(d, fFeed({ [REG]: e }));
  const x = normDisc(d.products[0].disc);
  assert.equal(x.holdings, null, "holdings 出处不齐不许落账");
});

test("applyRulesFeed：holdings 两块都空（assetClasses + topHoldings 都空）不写", () => {
  const e = fEntry({ holdings: { asOf: "2026-09-30", assetClasses: [], topHoldings: [],
    leveragePct: 101.42, custodian: null, source: Object.assign({}, HOLDINGS_SRC) } });
  const d = fData(fProd());
  applyRulesFeed(d, fFeed({ [REG]: e }));
  assert.equal(normDisc(d.products[0].disc).holdings, null, "两块都空的 holdings 不许落账");
});

test("applyRulesFeed：holdings 幂等——第二遍不再写账", () => {
  const d = fData(fProd());
  applyRulesFeed(d, fFeed({ [REG]: fEntry({ holdings: HOLDINGS() }) }));
  const snap = JSON.stringify(d);
  const st2 = applyRulesFeed(d, fFeed({ [REG]: fEntry({ holdings: HOLDINGS() }) }));
  assert.equal(st2.holdings, 0, "第二遍 holdings 已经写了，不该再写");
  assert.equal(JSON.stringify(d), snap, "账本不变（幂等）");
});

test("v81 接线：feed 落账排在唯一一次 saveLocal 之前、摘录不写 DATA、卡片有折叠入口", () => {
  const app = read("app.js");
  const iFeed = app.indexOf("fetchRulesFeed(RULES_FEED_PATH)");
  const iApply = app.indexOf("applyRulesFeeds(DATA,");
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

/* ============================================================
   队列 Q5（v83）：页面读第二份 feed（发行官网 tier=official）
   ------------------------------------------------------------
   云端现在写两份 feed：主源（中国理财网信披平台）产 product-rules.json，
   第二源（发行机构官网说明书下载口）产 official-rules.json。页面侧的规矩：
     · 优先级由「应用顺序」表达 —— 主源先落，第二源只补主源没补上的空白
       （判据仍是 applyAutoDisc 的「已有值不覆盖 / 手工值优先」，一行都不重写）；
     · 摘录按同一优先级取，同一个登记编码不许后面的源盖掉前面的；
     · 少一份 feed（404 / 坏 JSON / 没网）只让那一份不参与，绝不拖垮同步；
     · 只有一个 fetchRulesFeed 出口，路径是参数 —— 复制一份取数代码就是
       第二处实现，鉴权与降级口径一定会分叉。
   ============================================================ */

const SRC2 = { url: "https://www.boc.cn/xx.pdf", publishedAt: "2026-06-18", tier: "official" };

test("Q5：两份 feed 按优先级落账 —— 主源先写，第二源只补主源没补上的空白", () => {
  const primary = fFeed({ [REG]: fEntry({ rules: Object.assign(
    JSON.parse(JSON.stringify(RULES)), { openRule: "" }) }) });
  const second = fFeed({ [REG]: fEntry({
    source: Object.assign({}, SRC2),
    rules: JSON.parse(JSON.stringify(RULES)),
    rawQuote: { openRule: "每个开放日均办理" } }) });
  const d = fData(fProd());
  const st = applyRulesFeeds(d, [{ name: "主源", feed: primary },
                                 { name: "第二源", feed: second }]);
  const x = normDisc(d.products[0].disc);
  assert.equal(x.lockDays, 7, "主源有的项主源写");
  assert.equal(x.openRule, "每周二开放", "主源空着 → 由第二源补，第二源的值要真落进账");
  assert.equal(x.source.url, SRC.url, "出处记的是第一份把账填起来的源，不是后到的");
  assert.equal(x.status, "auto");
  assert.deepEqual(st.applied, ["主源", "第二源"]);
  assert.equal(st.filled, 5, "主源 4 项 + 第二源 1 项（openRule 主源是空的）");
  assert.equal(st.kept, 4, "第二源到场时主源写好的那 4 项全是 kept —— 已有值不覆盖，一条都不许重写");
  assert.deepEqual(Object.keys(st.quotes), [REG]);
  assert.equal(st.quotes[REG].lockDays, "需持有 7 个自然日",
    "同一只产品的摘录按优先级取主源那份，第二源不许盖掉");
});

test("Q5：主源出处不齐、第二源出处齐 → 由第二源补上且出处记第二源", () => {
  const primary = fFeed({ [REG]: fEntry({ source: Object.assign({}, SRC, { publishedAt: "" }) }) });
  const second = fFeed({ [REG]: fEntry({ source: Object.assign({}, SRC2) }) });
  const d = fData(fProd());
  const st = applyRulesFeeds(d, [{ name: "主源", feed: primary }, { name: "第二源", feed: second }]);
  assert.equal(st.badSource, 1, "主源出处不齐要如实计一次");
  const x = normDisc(d.products[0].disc);
  assert.equal(x.source.url, SRC2.url, "第二源的出处齐，账就该由它填、出处也该记它");
  assert.equal(x.lockDays, 7);
});

test("Q5：两份 feed 都读不到时不写账、不报错，applied 为空", () => {
  const d = fData(fProd());
  const st = applyRulesFeeds(d, [{ name: "主源", feed: null }, { name: "第二源", feed: undefined }]);
  assert.deepEqual(st.applied, []);
  assert.equal(st.filled, 0);
  assert.deepEqual(st.quotes, {});
  assert.deepEqual(normDisc(d.products[0].disc), normDisc(undefined),
    "两份都缺 → 账面一字不动，这轮就是没 feed 可读");
  assert.deepEqual(applyRulesFeeds(d, []).applied, [], "空数组也要当「没有 feed」");
  assert.equal(applyRulesFeeds(null, []).total, 0, "账本对象都不对时不许抛异常");
});

test("Q5 接线：两份 feed 各读各的路径、只有一个取数出口、主源排在第二源之前", () => {
  const app = read("app.js");
  assert.ok(app.includes('const RULES_FEED_PATH = "product-rules.json"'),
    "主源路径常量还在");
  assert.ok(app.includes('const OFFICIAL_FEED_PATH = "official-rules.json"'),
    "第二源路径常量必须与云端写盘那份同名（private/.github/workflows/update_nav.yml 里 --out \"$OFFICIAL_FILE\"）");
  const defs = app.match(/async function fetchRulesFeed\(/g) || [];
  assert.equal(defs.length, 1, "取 feed 的出口只能有一个：路径当参数，别复制第二份鉴权与降级");
  assert.ok(/async function fetchRulesFeed\(path\)/.test(app),
    "fetchRulesFeed 要收路径参数，函数体内不许再点具体的文件名");
  assert.ok(app.includes("contents/${path}"), "请求 URL 用参数拼，两份共用同一条降级路");
  const iPrimary = app.indexOf("fetchRulesFeed(RULES_FEED_PATH)");
  const iSecond = app.indexOf("fetchRulesFeed(OFFICIAL_FEED_PATH)");
  assert.ok(iPrimary > 0 && iSecond > iPrimary,
    "第二源必须在主源之后应用：优先级是靠应用顺序表达的，颠倒就等于让官网盖掉信披平台");
  const imp = /import \{([^}]*)\} from "\.\/js\/core\/disc\.js";/.exec(app);
  assert.ok(imp && imp[1].includes("applyRulesFeeds"),
    "app.js 要导入 applyRulesFeeds：多源编排若在页面里重写一遍就会分叉");
});


/* ============================================================
   v85 · 登记编码自动补齐（用户提的「后续添加产品时自动补齐登记编码」）

   三条判据一条都不能少：手工值优先（填过就绝不动）、唯一命中才写（多义就把
   候选交出去，宁可不填）、试过要盖章（否则每次同步都替理财网加负载）。
   写在 `code` 而不是新字段：App 的「登记编码」栏就是 `code`，另起一处等于
   造出第三个要同步改的地方。
   ============================================================ */
const REG_JX = "Z7001126000218";
const RC_NOW = 1_800_000_000_000;   /* 固定基准，避免测试跟着真实时钟漂 */


test("regCodeDue：已有编码就不问（手工值优先）", () => {
  assert.equal(regCodeDue({ code: REG_JX, name: "匠心灵动14天9G" }, RC_NOW), false);
  assert.equal(regCodeDue({ regCode: REG_JX, name: "匠心灵动14天9G" }, RC_NOW), false);
  assert.equal(regCodeDue({ name: "匠心灵动14天9G" }, RC_NOW), true);
});

test("regCodeDue：冷却期内不重复问，过期再问", () => {
  const p = { name: "匠心灵动14天9G", regCodeAt: new Date(RC_NOW - 86400000).toISOString() };
  assert.equal(regCodeDue(p, RC_NOW), false, "昨天刚问过");
  const old = { name: "匠心灵动14天9G", regCodeAt: new Date(RC_NOW - (REGCODE_COOLDOWN_DAYS + 1) * 86400000).toISOString() };
  assert.equal(regCodeDue(old, RC_NOW), true, "过了冷却就该再问一次");
});

test("regCodeDue：盖章时间认不出来或在未来 ⇒ 按没试过处理", () => {
  assert.equal(regCodeDue({ name: "x", regCodeAt: "昨天" }, RC_NOW), true);
  assert.equal(regCodeDue({ name: "x", regCodeAt: new Date(RC_NOW + 86400000).toISOString() }, RC_NOW), true);
});

test("applyRegCode：唯一命中写进 code，不新建第三处字段", () => {
  const p = { name: "匠心灵动14天9G", prodCode: "NYJXLD1409G" };
  const r = applyRegCode(p, { regCode: REG_JX, candidates: [REG_JX] });
  assert.equal(r.changed, true);
  assert.equal(p.code, REG_JX);
  assert.equal(p.regCode, undefined, "不许同时写两个字段，读的时候 regCode 优先会盖住 code");
  assert.match(r.why, /Z7001126000218/);
});

test("applyRegCode：已有编码时一个字都不改", () => {
  const p = { name: "x", code: "Z7008926000006" };
  const r = applyRegCode(p, { regCode: REG_JX, candidates: [REG_JX] });
  assert.equal(r.changed, false);
  assert.equal(p.code, "Z7008926000006", "手工值优先：这条是铁律，不是建议");
  assert.match(r.why, /手工值优先/);
});

/* 手工值优先的边界要说到「填错了」这一格：栏里是一串产品代码时，自动补齐
   同样不许盖掉它 —— 覆盖用户敲进去的东西之后，错了连找回的地方都没有。
   变异证明：把 regField() 改成「只在形态合法时才返回值」，下面两条一起红。 */
test("applyRegCode：栏里填的是产品代码（不是编码形态）也不覆盖，并说清要手工核对", () => {
  const p = { name: "匠心灵动14天9G", code: "NYJXLD1409G" };
  const r = applyRegCode(p, { regCode: REG_JX, candidates: [REG_JX] });
  assert.equal(r.changed, false, "有值就不动，不管值是什么");
  assert.equal(p.code, "NYJXLD1409G", "自动补齐没有改写用户输入的权利");
  assert.match(r.why, /NYJXLD1409G/, "要把屏幕上那个值原样念出来，不然用户不知道在说什么");
  assert.match(r.why, /手工核对/);
});

test("regCodeDue：栏里有值就不再问（填错的也归人管，不留第二套判据）", () => {
  assert.equal(regCodeDue({ name: "x", code: "NYJXLD1409G" }, RC_NOW), false);
  assert.equal(regCodeDue({ name: "x", regCode: "Z700892600000" }, RC_NOW), false,
    "Z+12 也是合法形态：这条按 isRegCode 判，比云端规则 feed 的 FEED_REG 宽");
});

test("applyRegCode：多个候选不写，并把候选说给用户", () => {
  const p = { name: "匠心灵动14天" };
  const r = applyRegCode(p, { regCode: "", candidates: [REG_JX, "Z7001126000999"], error: "对应多个登记编码" });
  assert.equal(r.changed, false);
  assert.equal(p.code, undefined, "认不出是哪一个就不写（null 是不知道）");
  assert.match(r.why, /Z7001126000218/);
  assert.match(r.why, /Z7001126000999/);
});

test("applyRegCode：形态不对的返回值不写", () => {
  const p = { name: "x" };
  const r = applyRegCode(p, { regCode: "NYJXLD1409G", candidates: ["NYJXLD1409G"] });
  assert.equal(r.changed, false);
  assert.equal(p.code, undefined);
  assert.match(r.why, /形态/);
});

test("applyRegCode：被拦/没查到时把原因原样交出去，不许编一个编码", () => {
  const p = { name: "x" };
  const blocked = applyRegCode(p, { regCode: "", candidates: [], error: "中国理财网本轮被风控拦下（验证失败）" });
  assert.equal(blocked.changed, false);
  assert.match(blocked.why, /被风控拦下/, "被拦 ≠ 没有数据（铁律 #10）");
  const empty = applyRegCode(p, {});
  assert.equal(empty.changed, false);
  assert.equal(p.code, undefined);
});

/* ============================================================================
   资产净值（产品规模）—— 2026-11-06 所有者提的「每只产品新增一个字段」。
   判据与私有仓 navsources/merge.py 的 apply_asset_value 同构（一份 JS、一份 Python，
   改一边必须改另一边）；这里管的是**本机写入与展示**那一半：
     · 手工值优先（用户填过就不再自动动，连「为什么没写」的记录都不许顶掉它）；
     · 披露日新者胜、同日不重刷（带时间戳或同日也写 ⇒ 每天 3 跑刷无意义提交）；
     · null 是不知道、0 是知道且为零（0/负数/NaN/非数都不算值，且不清空已知值）；
     · 展示串里必带出处与披露日（铁律 #3），并且**不进任何结论文本**。
   ========================================================================== */
const AV = (v, date, extra) => Object.assign({ v, date, sub: "YJ01251204A", via: "chinawealth" }, extra || {});

test("applyAssetValue：首次写入带回话，且形状里没有第三方的时间戳", () => {
  const p = {};
  const r = applyAssetValue(p, AV(2962513986.74, "2026-11-05"));
  assert.equal(r.changed, true);
  assert.equal(p.assetValue.v, 2962513986.74);
  assert.match(r.why, /2026-11-05/);
  assert.deepEqual(Object.keys(p.assetValue).sort(), ["date", "sub", "v", "via"]);
});

test("applyAssetValue：手工值优先，抓取不再覆盖（也不清空）", () => {
  const p = { assetValue: { v: 123, date: "2026-10-01", manual: true, via: "手工" } };
  const r = applyAssetValue(p, AV(999, "2026-11-05"));
  assert.equal(r.changed, false);
  assert.equal(p.assetValue.v, 123);
  assert.match(r.why, /手工/);
});

test("applyAssetValue：手工值也不被「为什么没写」的记录顶掉", () => {
  const p = { assetValue: { v: 123, date: "2026-10-01", manual: true, via: "手工" } };
  assert.equal(applyAssetValue(p, { v: null, why: "类别对不上" }).changed, false);
  assert.equal(p.assetValue.v, 123);
});

test("applyAssetValue：披露日新者胜，同日与更旧的一折都不重刷", () => {
  const p = { assetValue: AV(1, "2026-11-03") };
  assert.equal(applyAssetValue(p, AV(2, "2026-11-05")).changed, true);
  assert.equal(p.assetValue.v, 2);
  assert.equal(applyAssetValue(p, AV(3, "2026-11-05")).changed, false, "同日不许重刷");
  assert.equal(p.assetValue.v, 2);
  assert.equal(applyAssetValue(p, AV(4, "2026-11-01")).changed, false, "更旧的不许盖更新的");
  assert.equal(p.assetValue.v, 2);
});

test("applyAssetValue：某次没披露不清空已知值（null 是不知道）", () => {
  const p = { assetValue: AV(5, "2026-11-04") };
  assert.equal(applyAssetValue(p, { v: null, why: "这一行没披露资产净值" }).changed, false);
  assert.equal(p.assetValue.v, 5);
});

test("applyAssetValue：0 / 负数 / NaN / 非数都不算值，也不算理由", () => {
  for (const bad of [0, -1, NaN, Infinity, "abc", "", null, undefined]) {
    const p = {};
    const r = applyAssetValue(p, { v: bad, date: "2026-11-05", via: "chinawealth" });
    assert.equal(r.changed, false, `v=${bad} 不该被当成规模写进账本`);
    assert.equal(p.assetValue, undefined, "连记录都不该留下：没有 why 就是「没这回事」");
  }
});

test("applyAssetValue：没有值但有理由时把「为什么空着」记下来，同一条理由不反复改", () => {
  const p = {};
  const r = applyAssetValue(p, { v: null, date: "2026-11-05", sub: "NYJXLD1409G", via: "chinawealth", why: "类别对不上：披露的是 O" });
  assert.equal(r.changed, true);
  assert.equal(p.assetValue.v, null);
  assert.match(p.assetValue.why, /类别对不上/);
  assert.equal(applyAssetValue(p, { v: null, date: "2026-11-05", sub: "NYJXLD1409G", via: "chinawealth", why: "类别对不上：披露的是 O" }).changed, false);
});

test("applyAssetValue：rec 缺失或非对象时什么都不做", () => {
  const p = { assetValue: AV(1, "2026-11-01") };
  for (const got of [null, undefined, "x", 42, []]) {
    assert.equal(applyAssetValue(p, got).changed, false);
  }
  assert.equal(p.assetValue.v, 1);
});

/* ── v93：当前值判据与序列判据同构，官网档不许被聚合兜底档回退 ──────────
   2026-11-06 12:38 云端 `f0152f9eeda2` 只把诚享29 的 assetValue.via 从 bob
   改回 chinawealth（值/日期/sub 一个没变）——根因是当前值只比披露日、不比出处。
   App 桥与前端读判据必须与后端 merge.apply_asset_value 同一把尺子。 */
test("v93 applyAssetValue：聚合兜底源不许盖掉已有官网值，日期更新也不行", () => {
  const p = { assetValue: AV(3159486066.82, "2026-11-05", { via: "bob" }) };
  const r = applyAssetValue(p, AV(3159486066.82, "2026-11-06"));
  assert.equal(r.changed, false);
  assert.equal(p.assetValue.via, "bob");
  assert.equal(p.assetValue.date, "2026-11-05");
});

test("v93 回归：云端只改 via 的那笔提交现在落不进去", () => {
  const before = AV(3159486066.82, "2026-11-05", { via: "bob" });
  const p = { assetValue: Object.assign({}, before) };
  assert.equal(applyAssetValue(p, AV(3159486066.82, "2026-11-05")).changed, false);
  assert.deepEqual(p.assetValue, before);
});

test("v93 applyAssetValue：出处升级即使同日也允许整条换成官网值", () => {
  const p = { assetValue: AV(628488431.41, "2026-11-05") };
  const r = applyAssetValue(p, AV(841089969.95, "2026-11-05", { via: "bob" }));
  assert.equal(r.changed, true);
  assert.equal(p.assetValue.via, "bob");
  assert.equal(p.assetValue.v, 841089969.95);
});

test("v93 applyAssetValue：同档仍按披露日，官网档之间日期新者胜", () => {
  const p = { assetValue: AV(1, "2026-11-03", { via: "bob" }) };
  assert.equal(applyAssetValue(p, AV(2, "2026-11-05", { via: "bob" })).changed, true);
  assert.equal(p.assetValue.v, 2);
  assert.equal(applyAssetValue(p, AV(3, "2026-11-05", { via: "bob" })).changed, false);
});

test("v93 判据唯一性：当前值与逐日序列共用 assetHistoryRank，不许另写一套", () => {
  const s = read("js/core/disc.js");
  const start = s.indexOf("export function applyAssetValue");
  const end = s.indexOf("export function assetValueShort");
  assert.ok(start > 0 && end > start, "要能从源码里切出 applyAssetValue 这一段");
  const body = s.slice(start, end);
  assert.match(body, /const nRank = assetHistoryRank\(rec\.via\)/);
  assert.match(body, /const cRank = assetHistoryRank\(cur\.via\)/);
  assert.match(body, /if \(nRank < cRank\) return \{ changed: false, why: "" \}/);
  assert.match(body, /nRank === cRank && str\(cur\.date\) >= nd/);
});

test("assetValueOf：只认带 v 的对象形状，别的形状一律「不知道」", () => {
  assert.equal(assetValueOf(null), null);
  assert.equal(assetValueOf({}), null);
  assert.equal(assetValueOf({ assetValue: 123 }), null);
  assert.equal(assetValueOf({ assetValue: "123" }), null);
  assert.equal(assetValueOf({ assetValue: { date: "2026-11-05" } }).date, "2026-11-05",
    "没有 v 也算一折记录（那是「为什么空着」那一支）");
});

test("assetValueText：亿 / 万两档换算，并带上披露日与出处（铁律 #3）", () => {
  const yi = { assetValue: AV(2962513986.74, "2026-11-04") };
  assert.match(assetValueText(yi), /^29\.63 亿元（披露日 2026-11-04，来源：中国理财网信披平台·逐日净值表 astNetVal）$/);
  const wan = { assetValue: AV(6284884.31, "2026-11-04") };
  assert.match(assetValueText(wan), /^628\.49 万元（披露日 2026-11-04，来源：中国理财网信披平台·逐日净值表 astNetVal）$/);
  const hand = { assetValue: { v: 100000000, date: "", via: "手工", manual: true } };
  assert.match(assetValueText(hand), /1\.00 亿元/);
  assert.match(assetValueText(hand), /手工/);
});

/* v91：出处写全，防止「中国理财网」被读成发行机构官网的季度投资报告原文。
   三样缺一不可：渠道（信披平台）、粒度（逐日净值表）、可回查的字段名（astNetVal）。
   这条也是防「改回简写」的验收断言：把标签退回裸「中国理财网」这里必须红。 */
test("v91 出处写全：信披平台 + 逐日净值表 + astNetVal，且不带季报字眼", () => {
  const t = assetValueText({ assetValue: AV(2962513986.74, "2026-11-04") });
  assert.match(t, /中国理财网信披平台/, "要写全渠道，不能退回裸「中国理财网」");
  assert.match(t, /逐日净值表/, "要说清披露粒度是逐日净值表，不是报告期末时点");
  assert.match(t, /astNetVal/, "要带可逐字回查的接口字段名");
  assert.doesNotMatch(t, /季度|定期报告|投资报告|官网/,
    "不许出现会被读成发行机构官网季报的字眼");
  /* 手工值是用户自己填的，没有「信披平台」这一折，别把平台标签挂上去 */
  const hand = { assetValue: { v: 100000000, date: "", via: "手工", manual: true } };
  assert.match(assetValueText(hand), /来源：手工/);
  assert.doesNotMatch(assetValueText(hand), /信披平台|astNetVal/);
});

/* v92：官网直连源也回带当前值，出处标签同样写全，且与逐日序列同源同文案 */
test("v92 assetValueText：官网来源写全为渠道+粒度+字段名，手工值不受影响", () => {
  const bob = { assetValue: { v: 3159486066.82, date: "2026-11-05",
    sub: "YJ01251204A", via: "bob" } };
  assert.match(assetValueText(bob),
    /^31\.59 亿元（披露日 2026-11-05，来源：北银理财官网·逐日净值表 ASSET_VAL）$/);
  /* 与逐日序列的出处文案同源：同一份 assetHistoryViaLabel，不许两处各写一套 */
  assert.ok(assetValueText(bob).includes(assetHistoryViaLabel("bob")));
  const cw = { assetValue: AV(2962513986.74, "2026-11-04") };
  assert.match(assetValueText(cw), /中国理财网信披平台·逐日净值表 astNetVal/,
    "v91 写全的聚合源出处不许被这次改动带偏");
  const hand = { assetValue: { v: 1e8, date: "", via: "手工", manual: true } };
  assert.match(assetValueText(hand), /来源：手工/);
  assert.doesNotMatch(assetValueText(hand), /ASSET_VAL|astNetVal|信披平台/);
});

test("assetValueText：空着就说清为什么空着，绝不显示 0 元", () => {
  const why = { assetValue: { v: null, date: "", via: "chinawealth", why: "类别对不上：O≠G" } };
  assert.equal(assetValueText(why), "类别对不上：O≠G");
  assert.equal(assetValueText({}), "", "没有这一折 ⇒ 空串，不许编一句「0 元」");
  assert.doesNotMatch(assetValueText(why), /0 ?(元|亿|万)/);
});

/* v90：历史净值表最右列用的紧凑金额。与 assetValueText 共用同一份 assetAmount 换算，
   只是不带披露日/出处、单位字去掉空格 —— 窄格塞得下，数字一分不差。 */
test("assetValueShort：紧凑金额与完整串同源换算，空值返回空串", () => {
  const yi = { assetValue: AV(2962513986.74, "2026-11-04") };
  assert.equal(assetValueShort(yi), "29.63亿");
  const wan = { assetValue: AV(6284884.31, "2026-11-04") };
  assert.equal(assetValueShort(wan), "628.49万");
  /* 完整串里的数字必须与紧凑串一致（同一份换算，不许两处各算一遍） */
  assert.ok(assetValueText(yi).startsWith("29.63 亿元"), "完整串与紧凑串的亿档换算漂了");
  assert.ok(assetValueText(wan).startsWith("628.49 万元"), "完整串与紧凑串的万档换算漂了");
  /* null 是不知道 / 0 是知道且为零：都不该变成一个金额 */
  assert.equal(assetValueShort({ assetValue: { v: null, why: "对不上" } }), "");
  assert.equal(assetValueShort({}), "", "没有这一折 ⇒ 空串（表格画「—」）");
  assert.equal(assetValueShort({ assetValue: { v: 0 } }), "", "0 不当成有效规模");
  assert.equal(assetValueShort({ assetValue: { v: "2962513986" } }), "", "字符串不当成有效规模");
});

/* ── v92：逐日资产净值序列（读判据 + 前端同构落账）—— 与后端 merge.py 同口径 ── */
const AH = () => ({
  assetHistory: {
    "2026-05-27": 2000278.89,
    "2026-11-03": 4774840538.91,
    "2026-11-04": 2962513986.74,
    "2026-11-05": 3159486066.82,
  },
  assetHistoryVia: "bob",
});

test("assetHistoryOf / assetValueAt：按日期逐格取，没有就是空串，绝不显示 0 元", () => {
  const p = AH();
  assert.equal(Object.keys(assetHistoryOf(p)).length, 4);
  assert.equal(assetValueAt(p, "2026-11-04"), "29.63亿", "≥1 亿说亿档");
  assert.equal(assetValueAt(p, "2026-05-27"), "200.03万", "不足 1 亿说万档（同源换算：200.03 万元）");
  assert.equal(assetValueAt(p, "2026-11-02"), "", "没披露那天 ⇒ 空串（表格画「—」）");
  assert.equal(assetValueAt(p, "bad"), "", "脏日期 ⇒ 空串");
  assert.equal(assetValueAt({}, "2026-11-04"), "", "旧账本没有序列 ⇒ 空串，优雅降级");
  /* 0/null/字符串/负数/inf 都不是有效规模 */
  for (const bad of [0, null, "2962513986", -1, Infinity, NaN, true]) {
    const q = { assetHistory: { "2026-11-04": bad } };
    assert.equal(assetValueAt(q, "2026-11-04"), "", `${String(bad)} 不许当成规模`);
  }
  assert.deepEqual(assetHistoryOf({ assetHistory: [1, 2] }), {}, "数组形状不当序列");
});

test("assetHistoryViaLabel / assetHistoryRank：出处写全，官网优先于聚合兜底", () => {
  assert.match(assetHistoryViaLabel("bob"), /北银理财官网.*ASSET_VAL/, "官网逐日表要带可回查字段名");
  assert.match(assetHistoryViaLabel("chinawealth"), /中国理财网信披平台.*astNetVal/);
  assert.equal(assetHistoryViaLabel(""), "未知");
  assert.ok(assetHistoryRank("bob") > assetHistoryRank("chinawealth"), "官网档位更高");
  assert.equal(assetHistoryRank(""), assetHistoryRank("unknown"), "未知来源按兜底档");
});

test("applyAssetHistory：首次写入标出处，同档补新日期不覆盖已有", () => {
  const p = {};
  assert.deepEqual(applyAssetHistory(p, AH().assetHistory, "bob"), { changed: true, added: 4 });
  assert.equal(p.assetHistoryVia, "bob");
  const again = applyAssetHistory(p, { "2026-11-04": 999, "2026-11-06": 7 }, "bob");
  assert.equal(again.added, 1);
  assert.equal(p.assetHistory["2026-11-04"], 2962513986.74, "已有日期不覆盖");
  assert.equal(p.assetHistory["2026-11-06"], 7, "新日期补进来");
});

test("applyAssetHistory：官网整条替换聚合源，聚合源不许盖官网", () => {
  const p = { assetHistory: { "2026-11-04": 1 }, assetHistoryVia: "chinawealth" };
  applyAssetHistory(p, AH().assetHistory, "bob");
  assert.equal(p.assetHistoryVia, "bob");
  assert.equal(Object.keys(p.assetHistory).length, 4);
  const before = JSON.stringify(p);
  assert.deepEqual(applyAssetHistory(p, { "2026-11-09": 1 }, "chinawealth"),
    { changed: false, added: 0 }, "兜底源不许覆盖已有官网序列");
  assert.equal(JSON.stringify(p), before);
});

test("applyAssetHistory：内容不变不落盘；空序列/官网升级带空序列都不清空", () => {
  const p = AH();
  const before = JSON.stringify(p);
  assert.deepEqual(applyAssetHistory(p, AH().assetHistory, "bob"),
    { changed: false, added: 0 }, "内容逐字节不变 ⇒ 不落盘（每天 3 跑不刷提交）");
  assert.equal(JSON.stringify(p), before);
  for (const bad of [{}, { "2026-11-04": 0 }, { bad: 1 }, null]) {
    assert.deepEqual(applyAssetHistory(p, bad, "bob"), { changed: false, added: 0 });
  }
  assert.equal(JSON.stringify(p), before, "空/脏序列不许抹掉已有值");
  /* 官网升级但序列为空：merged=clean={} 会清空 —— 必须被 not clean 短路挡住 */
  const q = { assetHistory: { "2026-11-04": 1 }, assetHistoryVia: "chinawealth" };
  assert.deepEqual(applyAssetHistory(q, {}, "bob"), { changed: false, added: 0 });
  assert.equal(q.assetHistory["2026-11-04"], 1);
  assert.equal(q.assetHistoryVia, "chinawealth", "连出处也不许跟着空序列漂移");
});

test("逐日序列与单一当前值互不干扰：assetValue 仍是详情页那一栏", () => {
  const p = Object.assign({ assetValue: { v: 2962513986.74, date: "2026-11-04",
    sub: "YJ01251204A", via: "chinawealth" } }, AH());
  assert.equal(assetValueShort(p), "29.63亿", "详情页当前值读 assetValue");
  assert.equal(assetValueAt(p, "2026-11-05"), "31.59亿", "历史表读 assetHistory（最新可到 11-05）");
  assert.equal(assetValueAt(p, "2026-11-06"), "", "序列里没有的日子就是空");
});

test("setManualAssetValue：只收「元」为单位的正数，带亿/万的一律拒收并说清单位", () => {
  const p = {};
  assert.equal(setManualAssetValue(p, "29.63亿").changed, false);
  assert.match(setManualAssetValue(p, "29.63亿").why, /带亿\/万的不猜单位/,
    "必须走「单位」那句拒收；掉进通用那句正数报错，说明守卫被拆了、单位正在被猜");
  assert.equal(p.assetValue, undefined);
  for (const bad of ["0", "-5", "abc", "", "   ", "NaN"]) setManualAssetValue(p, bad);
  assert.equal(p.assetValue, undefined, "无效输入一个都不许写字段");
  const r = setManualAssetValue(p, " 2,962,513,986.74 ");
  assert.equal(r.changed, true);
  assert.equal(p.assetValue.v, 2962513986.74);
  assert.equal(p.assetValue.manual, true);
  assert.match(p.assetValue.via, /手工/);
});

/* 单位靠猜就是四个数量级，比空着更糟。上一版只断言了 changed=false，
   把守卫改成「放过亿、照样交给 Number()」时 NaN 也会给出 changed=false —— 全绿是假绿。
   这里钉两点：一是拒收文案必须来自单位那一句，二是任何情况下都不许落账。 */
test("手工规模里带亿/万的：一律走单位那句拒收，绝不落账、绝不换算", () => {
  for (const s of ["29.63亿", "2963万", "1.5万", "2亿", "29.63 亿元", "3E8"]) {
    const p = { assetValue: AV(1, "2026-11-04") };
    const r = setManualAssetValue(p, s);
    assert.equal(r.changed, false, `${s} 不许落账`);
    assert.equal(p.assetValue.v, 1, `${s} 不许连带改动已有的抓取值`);
    assert.match(r.why, /带亿\/万的不猜单位|只收以「元」为单位/, `${s} 该由单位那句拦下`);
  }
});

test("setManualAssetValue：清空输入框只撤手工那一折，不许顺手抹掉云端写的那一折", () => {
  const hand = { assetValue: { v: 1, date: "", via: "手工", manual: true } };
  assert.equal(setManualAssetValue(hand, "").changed, true);
  assert.equal(hand.assetValue, undefined, "手工值撤掉后回到「不知道」，下一轮抓取会重新补");
  const auto = { assetValue: AV(5, "2026-11-04") };
  assert.equal(setManualAssetValue(auto, "").changed, false);
  assert.equal(auto.assetValue.v, 5);
});

/* v3.4 实测缺口：闸门①在**列表**阶段就把净值拦下（理财网给 NYJXLD1409N，账本记 G），
   detail 那一步根本没走到 —— 原生侧只能由闸门自己带回这一折理由。
   页面这一侧必须照样把它显示出来，并且第二轮不许判定「有变化」（形状里没有时间点）。 */
test("闸门理由（列表阶段就拦下）在页面这一侧同样只留理由、不重刷、不说成 0 元", () => {
  const gate = (cls) => ({
    v: null, date: "", sub: "NYJXLD1409G", via: "chinawealth",
    why: `份额类别对不上：账本记的是 NYJXLD1409G，理财网该编码下的份额行是 ['${cls}'] `
       + "—— 宁可不填，也不拿别类份额的净值入账（请在 App 内核对后把产品代码改成实际持有那一类）",
  });
  const p = {};
  const first = applyAssetValue(p, gate("NYJXLD1409N"));
  assert.equal(first.changed, true, "首轮要把理由落下来，页面才有话可说");
  assert.equal(p.assetValue.v, null, "null 是不知道，不是知道且为零");
  const text = assetValueText(p);
  assert.match(text, /NYJXLD1409N/, "看到的类别要原样说出来，否则用户无从核对");
  assert.doesNotMatch(text, /^\s*0|0\.00 (元|万|亿)/, "空着就是空着，绝不显示成 0 元");
  assert.equal(applyAssetValue(p, gate("NYJXLD1409N")).changed, false,
    "同一句话第二轮不许再判成变化 —— 否则每天三次跑就是三次无关提交");
  /* 类别变了（用户核对后改成 N 类、理财网又给出别的类别）⇒ 这句旧话必须被换掉 */
  assert.equal(applyAssetValue(p, gate("NYJXLD1409O")).changed, true,
    "理由里的证据变了就要重写，旧的那句已经与账面不符");
  assert.match(p.assetValue.why, /NYJXLD1409O/);
  /* 手工值优先：用户自己填了规模，闸门的理由就不该再来顶 */
  const hand = { assetValue: { v: 123456789, date: "", sub: "NYJXLD1409G", via: "手工", manual: true } };
  assert.equal(applyAssetValue(hand, gate("NYJXLD1409N")).changed, false);
  assert.equal(hand.assetValue.v, 123456789);
});

/* ─────────────── v94 · 业绩比较基准 / 确认规则 ───────────────
   与云端 merge.apply_benchmark / bench_via_label 同构的那一半。
   四条口径：只填空白（手工值优先）、内容不变不落盘、出处必带、
   档位标签不许把未知来源标成官方。 */

test("applyBench：空白产品写入基准与规则，出处必带", () => {
  const p = {};
  const r = applyBench(p, { benchmark: "中证1000指数收益率×45%", benchRule: "最短持有期",
    benchSrc: { via: "chinawealth", at: "2026-11-06 16:37" } });
  assert.equal(r.changed, true);
  assert.equal(p.benchmark, "中证1000指数收益率×45%");
  assert.equal(p.benchRule, "最短持有期");
  assert.deepEqual(p.benchSrc, { via: "chinawealth", at: "2026-11-06 16:37" });
});

test("applyBench：已有值（手工值优先）一律不覆盖", () => {
  const p = { benchmark: "手工填的基准", benchRule: "手工规则" };
  const r = applyBench(p, { benchmark: "官方基准", benchRule: "官方规则" });
  assert.equal(r.changed, false);
  assert.equal(p.benchmark, "手工填的基准");
  assert.equal(p.benchSrc, undefined);
});

test("applyBench：只补空着的那一格", () => {
  const p = { benchmark: "已有基准" };
  const r = applyBench(p, { benchmark: "抓来的基准", benchRule: "最短持有期" });
  assert.equal(r.changed, true);
  assert.equal(p.benchmark, "已有基准");
  assert.equal(p.benchRule, "最短持有期");
});

test("applyBench：两格都已非空 ⇒ 连 benchSrc 都不碰（内容不变不落盘）", () => {
  const p = { benchmark: "基准", benchRule: "规则", benchSrc: { via: "chinawealth", at: "a" } };
  const r = applyBench(p, { benchmark: "基准", benchRule: "规则", benchSrc: { via: "leyuw", at: "b" } });
  assert.equal(r.changed, false);
  assert.deepEqual(p.benchSrc, { via: "chinawealth", at: "a" });
});

test("applyBench：空折 / 非法入参一律不动", () => {
  const p = {};
  assert.equal(applyBench(p, null).changed, false);
  assert.equal(applyBench(p, {}).changed, false);
  assert.equal(applyBench(p, { benchmark: "  ", benchRule: "" }).changed, false);
  assert.equal(applyBench(null, { benchmark: "x" }).changed, false);
});

test("applyBench：没有出处时允许写值但不出 benchSrc（出处由后续轮补）", () => {
  const p = {};
  const r = applyBench(p, { benchmark: "只有文本" });
  assert.equal(r.changed, true);
  assert.equal(p.benchmark, "只有文本");
  assert.equal(p.benchSrc, undefined);
});

test("benchViaLabel：档位标签与所有者定的顺序一致", () => {
  assert.equal(benchViaLabel("chinawealth"), "中国理财网");
  assert.equal(benchViaLabel("leyuw"), "净值瞭望（第三方转述）");
  assert.equal(benchViaLabel("webank"), "微众银行接口");
  assert.equal(benchViaLabel("手工"), "手工");
  assert.equal(benchViaLabel("bob"), "发行方官网");
  assert.equal(benchViaLabel(""), "");
});
