/* v133 · 产品级「购买规则 / 净值确认逻辑」+ 净值待确认在途 专项回归
     node --test tests/buyrule_v133.test.mjs

   背景（用户 2026-11-13 反馈）：11.12 下午 5 点前买入「安盈稳健日开7号」，
   按产品规则应以 11.13 净值计算份额；但当时 11.13 净值尚未披露，旧版用
   navHit 向前取到 11.06 的滞后净值 1.004402，提前把份额算死，凭空冒出
   -28.91 的假浮亏。用户要求「持仓收益不应该变动」，并要求选产品时自动
   带入该产品的购买规则，只需填购买时间 + 金额，确认时间仍可手动改。

   本组用例钉住六件事：
     · 购买规则三字段容错归一，非法值回落默认；
     · 默认规则与旧 suggestTradeDates 完全等价（没配规则的产品零回归）；
     · 安盈规则 17:00 截止 / T+1 净值 / 净值日+1 确认，含周末与截止后顺延；
     · 净值待确认买入整笔在途，持仓收益一笔都不动（核心诉求）；
     · 绝不 navHit 向前取滞后净值，净值披露后自动回冲份额、无需改单；
     · 产品表单 / 交易表单 / 保存 / 交易记录 / 合并 / 版本钉的接线齐全。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  DEFAULT_BUY_RULE, normBuyRule, hasBuyRule, suggestBuyDates, suggestTradeDates,
  isTradeDay,
} from "../js/domain/calendar.js";
import {
  computePosition, buyNavPending, resolveTradeNav, tradeShares, sharesOn,
} from "../js/domain/position.js";
import { mergeForPush } from "../js/domain/sync.js";

const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const CAL = readFileSync(new URL("../js/domain/calendar.js", import.meta.url), "utf8");
const POS = readFileSync(new URL("../js/domain/position.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const SW = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const PKG = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

/* ─────────── 夹具 ───────────
   真源（licai-data.json）里安盈的净值只到 11-06 = 1.004402；这里再补一条
   11-12 = 1.0044 作为「申请日已披露」的净值，制造最危险的滞后净值陷阱：
   旧版会拿它（或 11-06 的值）给 11-13 才确认的买入算份额。 */
const NAV = { "2026-11-06": 1.004402, "2026-11-12": 1.0044 };
const prod = (extra = {}) => ({
  id: "ay7", name: "安盈稳健日开7号A", inst: "徽银理财",
  prodCode: "PNHY260395A", navHistory: { ...NAV, ...extra },
});
/* 老买入：11-05 已确认，份额写死（存量数据形状） */
const OLD_BUY = {
  id: "b1", prodId: "ay7", type: "buy",
  tradeDate: "2026-11-05", confirmDate: "2026-11-05",
  amount: 70000, confirmNav: 1.0048, shares: 69665.61,
};
/* v133 新增买入：11-12 17:00 前提交 → 按 11-13 净值 → 11-16 确认份额。
   saveTrade 在净值未披露时不写 shares、confirmNav=0，只打 navPending 标记。 */
const PENDING_BUY = {
  id: "b2", prodId: "ay7", type: "buy",
  tradeDate: "2026-11-12", confirmDate: "2026-11-16",
  confirmNavDate: "2026-11-13", confirmNav: 0,
  amount: 70000, navPending: true,
};
const ANYING_RULE = { cutoff: "17:00", navOffset: 1, confirmOffset: 1 };

/* ═══════════ 1. 规则归一化 ═══════════ */
test("normBuyRule：缺失/非法字段一律回落默认，绝不抛错", () => {
  const d = { ...DEFAULT_BUY_RULE };
  for (const raw of [null, undefined, 0, "x", [], {}, { cutoff: 123 }]) {
    assert.deepEqual({ ...normBuyRule(raw) }, d, "非法入参：" + String(raw));
  }
  assert.deepEqual({ ...normBuyRule(ANYING_RULE) }, ANYING_RULE);
  /* 截止时点既验格式也验范围，还补齐前导零 */
  assert.equal(normBuyRule({ cutoff: "9:05" }).cutoff, "09:05");
  assert.equal(normBuyRule({ cutoff: "17:00" }).cutoff, "17:00");
  for (const bad of ["25:99", "12:60", "1:5", "abc", "17:0", "  "]) {
    assert.equal(normBuyRule({ cutoff: bad }).cutoff, "", "非法截止：" + bad);
  }
  /* offset 越界 / 非整数 / 负数 → 回落默认 */
  assert.deepEqual(
    { ...normBuyRule({ navOffset: -1, confirmOffset: 99 }) }, d);
  assert.deepEqual(
    { ...normBuyRule({ navOffset: 1.5, confirmOffset: NaN }) }, d);
  assert.equal(normBuyRule({ navOffset: 2, confirmOffset: 3 }).navOffset, 2);
  assert.equal(normBuyRule({ confirmOffset: 0 }).confirmOffset, 0, "0 是合法值（净值日当日确认）");
});

test("hasBuyRule：只有显式偏离默认才算「已配置」", () => {
  assert.equal(hasBuyRule(prod()), false);
  assert.equal(hasBuyRule({ buyRule: { ...DEFAULT_BUY_RULE } }), false);
  assert.equal(hasBuyRule({ buyRule: { cutoff: "17:00" } }), true);
  assert.equal(hasBuyRule({ buyRule: { navOffset: 1 } }), true);
  assert.equal(hasBuyRule({ buyRule: { confirmOffset: 2 } }), true);
  assert.equal(hasBuyRule({ buyRule: "乱填" }), false);
});

/* ═══════════ 2. 默认规则零回归 ═══════════ */
test("默认购买规则与旧 suggestTradeDates 完全等价（未配规则的产品零回归）", () => {
  const now = new Date(2026, 10, 12, 9, 0, 0);   // 11-12 09:00，未过 15:00 截止
  for (const d of ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-14", "2026-10-01", "2026-12-31"]) {
    const oldSug = suggestTradeDates(d, now, "");
    const newSug = suggestBuyDates(d, undefined, { now, orgKey: "", afterCutoff: false });
    assert.equal(newSug.applyDate, oldSug.applyDate, d + " 受理日");
    assert.equal(newSug.navDate, oldSug.navDate, d + " 确认净值日（默认=受理日）");
    assert.equal(newSug.confirmDate, oldSug.confirmDate, d + " 份额确认日（默认=T+1）");
  }
  /* 默认规则下 navOffset=0 / confirmOffset=1 / cutoff 回落机构默认 */
  const s = suggestBuyDates("2026-11-12", undefined, { now, afterCutoff: false });
  assert.equal(s.navOffset, 0);
  assert.equal(s.confirmOffset, 1);
  assert.equal(s.cutoff, "15:00");
});

/* ═══════════ 3. 安盈真实场景 ═══════════ */
test("安盈规则：11-12 17:00 前买入 → 按 11-13 净值计算 → 11-16 确认份额", () => {
  assert.equal(isTradeDay("2026-11-12"), true);
  assert.equal(isTradeDay("2026-11-13"), true);
  assert.equal(isTradeDay("2026-11-14"), false, "周六休市");
  const now = new Date(2026, 10, 12, 16, 30, 0);   // 16:30，未过 17:00
  const s = suggestBuyDates("2026-11-12", ANYING_RULE, { now, afterCutoff: false });
  assert.equal(s.applyDate, "2026-11-12");
  assert.equal(s.navDate, "2026-11-13", "★ 用户说的「按 11.13 日净值计算」");
  assert.equal(s.confirmDate, "2026-11-16", "11-14/15 周末顺延到下周一");
  assert.equal(s.cutoff, "17:00");
  assert.equal(s.deferred, false);
  /* 规则用产品自己的截止，不受机构默认 15:00 影响：16:30 仍算当日受理 */
  assert.equal(s.deferred, false, "17:00 截止，16:30 不算超时");
});

test("17:00 后提交按下一交易日受理，净值日与确认日整体顺延", () => {
  const now = new Date(2026, 10, 12, 17, 30, 0);
  const s = suggestBuyDates("2026-11-12", ANYING_RULE, { now, afterCutoff: true });
  assert.equal(s.applyDate, "2026-11-13");
  assert.equal(s.navDate, "2026-11-16");
  assert.equal(s.confirmDate, "2026-11-17");
  assert.equal(s.deferred, true);
});

test("周末/节假日买入先顺延到交易日，再按规则推净值日", () => {
  const now = new Date(2026, 10, 12, 9, 0, 0);
  const s = suggestBuyDates("2026-11-14", ANYING_RULE, { now, afterCutoff: false });
  assert.equal(s.applyDate, "2026-11-16");
  assert.equal(s.navDate, "2026-11-17");
  assert.equal(s.confirmDate, "2026-11-18");
  assert.equal(s.rolled, true);
});

test("补录历史单显式 before 时，不用「现在几点」去改写历史受理日", () => {
  const now = new Date(2026, 10, 12, 23, 30, 0);   // 现在早已过任何截止
  const s = suggestBuyDates("2026-11-10", ANYING_RULE, { now, afterCutoff: false });
  assert.equal(s.applyDate, "2026-11-10");
  assert.equal(s.navDate, "2026-11-11");
  assert.equal(s.deferred, false);
});

/* ═══════════ 4. 净值待确认在途（核心诉求） ═══════════ */
test("★ 新增净值待确认买入，持仓收益一笔都不动", () => {
  const p = prod();
  const before = computePosition(p, [OLD_BUY], "2026-11-12");
  const after = computePosition(p, [OLD_BUY, PENDING_BUY], "2026-11-12");
  assert.equal(after.shares, before.shares);
  assert.equal(after.cost, before.cost);
  assert.equal(after.market, before.market);
  assert.equal(after.profit, before.profit, "新增买入不得让持仓收益变动");
  assert.equal(after.navPendingCount, 1);
  assert.equal(after.hasPending, true);
  assert.equal(after.pendingAmount, 70000);
  assert.equal(after.inTransit, false, "已有持仓，不是纯在途状态");
});

test("★ 绝不拿滞后的最近净值把待确认份额算死（11-06 / 11-12 旧净值陷阱）", () => {
  const p = prod();
  /* 净值表里明明有 11-06 和 11-12 的值，但 11-13 没披露 —— 精确命中必须返回 0 */
  assert.equal(resolveTradeNav(PENDING_BUY, p), 0);
  assert.equal(tradeShares(PENDING_BUY, p), 0);
  const pos = computePosition(p, [PENDING_BUY], "2026-11-12");
  assert.equal(pos.shares, 0);
  assert.equal(pos.cost, 0);
  assert.equal(pos.market, 0);
  assert.equal(pos.profit, 0, "旧版在这里会冒出约 -28.91 的假浮亏");
  assert.equal(pos.inTransit, true);
  assert.equal(pos.navPendingCount, 1);
});

test("历史日历 sharesOn 同样不把待确认买入提前算进份额", () => {
  const p = prod();
  assert.equal(sharesOn(p, [OLD_BUY, PENDING_BUY], "2026-11-12"), 69665.61);
  assert.equal(sharesOn(p, [OLD_BUY, PENDING_BUY], "2026-11-16"), 69665.61,
    "份额确认日到了但 11-13 净值未披露 → 这笔份额仍是 0");
});

test("11-13 净值披露后自动确认份额，无需改单", () => {
  const p = prod({ "2026-11-13": 1.0050 });
  assert.equal(buyNavPending(PENDING_BUY, p), false);
  assert.equal(resolveTradeNav(PENDING_BUY, p), 1.0050);
  assert.equal(tradeShares(PENDING_BUY, p), 70000 / 1.0050);
  /* 净值已披露但份额确认日 11-16 未到 → 仍在途（只是原因变了） */
  const early = computePosition(p, [OLD_BUY, PENDING_BUY], "2026-11-13");
  assert.equal(early.navPendingCount, 0);
  assert.equal(early.hasPending, true);
  assert.equal(early.shares, 69665.61);
  /* 到确认日自动回冲：份额、成本、市值全部按官方净值重算 */
  const pos = computePosition(p, [OLD_BUY, PENDING_BUY], "2026-11-16");
  assert.equal(pos.navPendingCount, 0);
  assert.equal(pos.cost, 140000);
  assert.ok(pos.shares > 139000, "两笔份额都入账");
  assert.ok(pos.market > 0);
  assert.ok(sharesOn(p, [OLD_BUY, PENDING_BUY], "2026-11-16") > 139000);
});

test("老买入（无 navPending 标记）行为完全不变", () => {
  const p = prod();
  assert.equal(buyNavPending(OLD_BUY, p), false);
  assert.equal(resolveTradeNav(OLD_BUY, p), 1.0048);
  const pos = computePosition(p, [OLD_BUY], "2026-11-12");
  assert.equal(pos.shares, 69665.61);
  assert.equal(pos.cost, 70000);
  assert.equal(pos.navPendingCount, 0);
  assert.equal(pos.hasPending, false);
  assert.equal(pos.profit, 69665.61 * 1.0044 - 70000);
});

test("buyNavPending 只认标记的买入，且精确命中确认净值日", () => {
  const p = prod();
  assert.equal(buyNavPending(PENDING_BUY, p), true);
  assert.equal(buyNavPending({ ...PENDING_BUY, type: "sell" }, p), false);
  assert.equal(buyNavPending({ ...PENDING_BUY, navPending: false }, p), false);
  assert.equal(buyNavPending({ ...PENDING_BUY, confirmNavDate: "2026-11-12" }, p), false,
    "改到已披露的净值日 → 不再待确认");
  assert.equal(buyNavPending(OLD_BUY, p), false);
});

/* ═══════════ 5. 真源复现（跨仓守卫） ═══════════ */
test("真源复现：安盈稳健日开7号A 11-12 买入 → 11-13 净值未披露 → 零浮亏", () => {
  const f = new URL("../../data24/licai-data.json", import.meta.url);
  if (!existsSync(f)) return;      // 公开仓 CI 单独检出时无私有仓
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw.products || []);
  const p = list.find(x => String(x.name || "").includes("安盈稳健日开7号"));
  if (!p) return;
  assert.equal(p.prodCode, "PNHY260395A");
  assert.ok(p.navHistory["2026-11-13"] === undefined, "真源此刻确实没有 11-13 净值");
  const s = suggestBuyDates("2026-11-12", ANYING_RULE,
    { now: new Date(2026, 10, 12, 16, 0, 0), afterCutoff: false });
  assert.equal(s.navDate, "2026-11-13");
  const t = {
    id: "probe", prodId: p.id, type: "buy", tradeDate: "2026-11-12",
    confirmDate: s.confirmDate, confirmNavDate: s.navDate, confirmNav: 0,
    amount: 70000, navPending: true,
  };
  const pos = computePosition(p, [t], "2026-11-12");
  assert.equal(pos.shares, 0);
  assert.equal(pos.profit, 0, "用真源滞后净值也不会凭空产生浮亏");
  assert.equal(pos.navPendingCount, 1);
});

/* ═══════════ 6. 源码接线 / 版本钉 ═══════════ */
test("v133 纯函数层：规则推算与待确认在途单点落地", () => {
  assert.match(CAL, /export const DEFAULT_BUY_RULE/);
  assert.match(CAL, /export function normBuyRule\(/);
  assert.match(CAL, /export function hasBuyRule\(/);
  assert.match(CAL, /export function suggestBuyDates\(/);
  assert.match(CAL, /const navDate = addTradeDays\(apply, rule\.navOffset\) \|\| apply/);
  assert.match(CAL, /const confirmDate = addTradeDays\(navDate, rule\.confirmOffset\) \|\| navDate/,
    "确认日必须相对确认净值日，不是相对受理日");
  assert.match(POS, /export function buyNavPending\(/);
  assert.match(POS, /if \(t\.navPending && t\.type === "buy"\)/);
  assert.match(POS, /navAt\(p, d\)/, "待确认买入精确命中当日净值");
  assert.match(POS, /if \(navWait\) navPendingCount\+\+/);
  assert.match(POS, /const hasPending = pendingShares > 0 \|\| navPendingCount > 0/);
});

test("v133 产品表单：三字段 + 预览 + 落库；表单确认日偏移可选 0", () => {
  for (const id of ["pBuyCutoff", "pBuyNavOffset", "pBuyConfirmOffset", "pBuyRulePreview"]) {
    assert.ok(APP.includes(`id="${id}"`), "产品表单缺字段 " + id);
  }
  assert.match(APP, /function readBuyRuleForm\(/);
  assert.match(APP, /function previewBuyRule\(/);
  assert.match(APP, /if \(buyRule\) target\.buyRule = buyRule/);
  assert.match(APP, /else target\.buyRule = \{\}/,
    "回退默认写空对象，才能盖掉云端旧规则");
  assert.match(APP, /\[0, 1, 2, 3\]\.map\(n =>/, "确认日偏移可选 0（净值日当日确认）");
  assert.match(APP, /if \(!hasBuyRule\(keep\) && hasBuyRule\(drop\)\) keep\.buyRule = drop\.buyRule/,
    "重复产品合并时按「是否真配了规则」判定，别让 {} 挡住真规则");
});

test("v133 产品规则同步：回退默认能盖掉云端旧规则，未配置设备不抹掉云端规则", () => {
  const RULE = { cutoff: "17:00", navOffset: 1, confirmOffset: 1 };
  const cloud = { products: [{ id: "ay7", name: "安盈", buyRule: { ...RULE } }], trades: [], settings: {} };
  /* ① 用户把规则改回默认（saveProduct 落 {}）→ push 的 payload 必须保持 {}，
        否则 mergeForPush「只填空白」会把云端旧规则补回来，连单设备都删不掉。 */
  const back = { products: [{ id: "ay7", name: "安盈", buyRule: {} }], trades: [], settings: {} };
  assert.deepEqual(mergeForPush(back, cloud).payload.products[0].buyRule, {});
  /* ② 另一台设备从没配过规则（无此字段）→ 云端规则要原样保留，不能被抹掉。 */
  const never = { products: [{ id: "ay7", name: "安盈" }], trades: [], settings: {} };
  assert.deepEqual(mergeForPush(never, cloud).payload.products[0].buyRule, RULE);
  /* ③ 本地配置了新规则 → 以本地为准，不被云端覆盖。 */
  const mine = { products: [{ id: "ay7", name: "安盈", buyRule: { cutoff: "15:30", navOffset: 2, confirmOffset: 1 } }], trades: [], settings: {} };
  assert.equal(mergeForPush(mine, cloud).payload.products[0].buyRule.navOffset, 2);
  /* 空对象在 UI 层仍等价「未配置」，不会出现「有字段却按自定义规则跑」的错乱 */
  assert.equal(hasBuyRule({ buyRule: {} }), false);
  assert.deepEqual({ ...normBuyRule({}) }, { ...DEFAULT_BUY_RULE });
});

test("v133 交易表单：自动带入 + 截止前后 + 手动改净值日不改口径", () => {
  assert.match(APP, /function applyBuyAuto\(/);
  assert.match(APP, /id="tTimingBox"/);
  assert.match(APP, /suggestBuyDates\(d, p\.buyRule, \{ now: new Date\(\), orgKey: detectOrg\(p\), afterCutoff: after \}\)/);
  assert.match(APP, /navAt\(p, sug\.navDate\)/, "自动带入精确命中，未披露留空");
  const auto = APP.match(/function autoFillNav\(\)[\s\S]*?\n}/);
  assert.ok(auto, "autoFillNav 存在");
  assert.match(auto[0], /navAt\(p, d\)/);
  /* 只禁真实调用 navHit(...)，别被注释里的「绝不 navHit 向前取最近」误伤
     （v130 踩过：改措辞会让反向断言假绿，收紧到调用形态才既稳又严）。 */
  assert.doesNotMatch(auto[0], /navHit\(/, "手动改净值日也绝不向前取最近净值");
  assert.match(APP, /份额待披露（净值披露后自动确认）/);
  assert.match(APP, /tTimingBox"\)\.style\.display = type === "buy"/, "赎回隐藏申购时点");
});

test("v133 保存与展示：待披露可保存、不打死份额、列表自动回冲", () => {
  assert.match(APP, /const navPending = type === "buy" && !\(nav > 0\)/);
  assert.match(APP, /if \(navPending\) t\.navPending = true/);
  assert.match(APP, /if \(!navPending\) t\.shares = Number\(\(amt \/ nav\)\.toFixed\(4\)\)/);
  assert.match(APP, /净值待披露 · 份额待确认/);
  assert.match(APP, /const navPending = isBuy && !!p && buyNavPending\(t, p\)/);
  assert.match(APP, /const nav = isBuy \? \(Number\(t\.confirmNav\) \|\| exactNav\)/,
    "交易记录在净值披露后按 navAt 真值回冲，不显示 0.0000");
  assert.match(APP, /const shares = isBuy/, "份额同步按 金额/净值 动态回冲");
});

test("v133 版本钉：APP_VER / CACHE 同步 v133", () => {
  const ver = APP.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = SW.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, "v133");
  assert.equal(cache, "v133");
  assert.equal(ver, cache);
});

test("v133 两处测试清单都登记 buyrule_v133.test.mjs（漏一个等于只在本地跑过）", () => {
  assert.match(PKG, /buyrule_v133\.test\.mjs/, "npm test 登记");
  assert.match(CI, /buyrule_v133\.test\.mjs/, "CI 登记");
  assert.match(HTML, /交易记录/, "静态卡片结构未被动过");
});
