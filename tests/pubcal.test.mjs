/* 公开日历（v114）的测试。跑法：node --test tests/pubcal.test.mjs
   ★ 这一层的核心不是「算出日子」，是「顺延算对」——2026-11-15 是周日，
     写死在表里的方案会提示一个不存在的缴准日。 */
import test from "node:test";
import assert from "node:assert/strict";
import { pubCalNext, pubCalText, pubCalChips, daysBetween } from "../js/domain/pubcal.js";

const byKey = (list, k) => list.find(e => e.key === k) || null;

test("顺延：11-15 是周日，缴准与税期都应落到 11-16（周一）", () => {
  const l = pubCalNext("2026-11-10", { days: 21, limit: 6 });
  const rrr = byKey(l, "rrr");
  const tax = byKey(l, "tax");
  assert.ok(rrr && tax, "缴准与税期都应出现");
  assert.equal(rrr.date, "2026-11-16", "缴准没有顺延到周一");
  assert.equal(rrr.shifted, true);
  assert.equal(rrr.ruleDate, "2026-11-15", "规则日要留着，界面要说明「规则日 11-15 顺延」");
  assert.equal(rrr.daysAway, 6);
  assert.equal(tax.date, "2026-11-16");
  assert.equal(tax.tone, "warn", "税期是偏紧的一天");
});

test("当天：11-16 打开时，缴准是「今天」（0 天），不是「6 天后」", () => {
  const l = pubCalNext("2026-11-16", { days: 21, limit: 6 });
  const rrr = byKey(l, "rrr");
  assert.ok(rrr);
  assert.equal(rrr.daysAway, 0);
  assert.match(pubCalChips([rrr]), /今天/);
});

test("硬规则：LPR 每月 20 日、MLF 每月 25 日（2024-07 起由 15 日改到 25 日）", () => {
  const l = pubCalNext("2026-11-10", { days: 21, limit: 6 });
  assert.equal(byKey(l, "lpr").date, "2026-11-20");
  assert.equal(byKey(l, "mlf").date, "2026-11-25");
  assert.equal(byKey(l, "lpr").daysAway, 10);
  assert.equal(byKey(l, "mlf").daysAway, 15);
});

test("长假期：2026 春节 2/15—2/23 连休，缴准要顺延到 2/24", () => {
  const l = pubCalNext("2026-02-10", { days: 21, limit: 6 });
  const rrr = byKey(l, "rrr");
  assert.ok(rrr);
  assert.equal(rrr.date, "2026-02-24", "春节连休后应顺延到 2/24");
  assert.equal(rrr.shifted, true);
});

test("月末与季末：季末更值得提醒（tone=warn），月末只是 info", () => {
  const nov = pubCalNext("2026-11-10", { days: 30, limit: 6 });
  const me = byKey(nov, "monthend");
  assert.ok(me, "11 月末应出现");
  assert.equal(me.date, "2026-11-30");
  assert.equal(me.tone, "info");

  const dec = pubCalNext("2026-12-10", { days: 30, limit: 6 });
  const q = byKey(dec, "quarter");
  assert.ok(q, "12 月末应识别为季末");
  assert.equal(q.date, "2026-12-31");
  assert.equal(q.tone, "warn");
});

test("窗口与条数：days 收窄就只剩近的那几个，limit 封顶", () => {
  const near = pubCalNext("2026-11-10", { days: 10, limit: 9 });
  assert.deepEqual(near.map(e => e.key), ["rrr", "tax", "lpr"], "10 天内只有缴准、税期、LPR");
  const capped = pubCalNext("2026-11-10", { days: 30, limit: 2 });
  assert.equal(capped.length, 2);
});

test("排期稳定：同一天多件事按 key 排序，不随对象顺序漂移", () => {
  const l = pubCalNext("2026-11-10", { days: 21, limit: 6 });
  const dates = l.map(e => e.date);
  const sorted = dates.slice().sort();
  assert.deepEqual(dates, sorted, "输出必须按日期升序");
  /* 11-16 同一天有 rrr 与 tax 两件，rrr 在前（key 升序） */
  const same = l.filter(e => e.date === "2026-11-16").map(e => e.key);
  assert.deepEqual(same, ["rrr", "tax"]);
});

test("请求文本：顺延要写明「规则日 + 顺延」，且带距今几天", () => {
  const l = pubCalNext("2026-11-10", { days: 21, limit: 6 });
  const t = pubCalText(l, "2026-11-10");
  assert.match(t, /【日历】/);
  assert.match(t, /11-16（周一）缴准（11-15 顺延），距今 6 天/);
  assert.match(t, /11-20（周五）LPR 报价，距今 10 天/);
  assert.match(t, /通常偏紧/, "税期/季末要标出偏紧，否则模型会把它当普通日期");
});

test("空输入与坏输入：不抛异常，返回空", () => {
  assert.deepEqual(pubCalNext("", {}), []);
  assert.deepEqual(pubCalNext("2026/11/10", {}), []);
  assert.equal(pubCalText([], "2026-11-10"), "");
  assert.equal(pubCalChips([]), "");
});

test("daysBetween 只算自然日，跨月跨年都对", () => {
  assert.equal(daysBetween("2026-11-10", "2026-11-16"), 6);
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(daysBetween("2026-11-16", "2026-11-10"), -6);
});
