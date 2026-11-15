/* v136 · 走势专题（P0）专项回归
   跑法：node --test tests/trend_v136.test.mjs

   ★ 这一版的第一原则不是「让模型敢说」，而是「先体检、后分析」：
     用户 2026-11-15 的核对案例里，官方万份收益 0.23 与净值折算值差近 20 倍，
     口径错位的数据喂给模型会系统性地错。所以本文件最要紧的是第 2/6/7 组：
       ② 错位检测三重交叉验证（案例 fixture）
       ⑥ 变异反证（抹掉口径标签 / 模型自由发挥证伪线 / 编造数字 / 禁词，四条必红）
       ⑦ 隔离断言（专题不进问答快照、不给研报链路加字段、不新增云端任务）

   全部判据都是纯函数或源码静态断言 —— 不发请求、不碰密钥、不写台账。
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TREND_PROMPT_VER, TREND_INSTRUCTIONS, TREND_NOT_PREDICTION,
  TREND_CALIBER_LABEL, TREND_RATIO_LIMIT,
  trendCaliber, trendConsistency, trendScenarios, trendFactsText,
  trendAuditValues, trendWatcher, trendCaliberHtml, trendQuestionHint,
} from "../js/domain/trend.js";
import { reportNavFacts, reportScenarios, reportNumberAudit } from "../js/domain/report.js";
import {
  BRIEF_BANNED_RE, BRIEF_DISCLAIMER, parseReport, reportCardHtml,
} from "../js/domain/brief.js";

const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const SW = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const PKG = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const TREND = readFileSync(new URL("../js/domain/trend.js", import.meta.url), "utf8");

/* 只留代码，不留注释：隔离断言防的是「真的把趋势代码装配进别的链路」，
   而注释里出现「走势」是允许的（说明文字本来就要写）。 */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = stripComments(APP);
const body = (src, name) => {
  const i = src.indexOf("function " + name + "(");
  assert.ok(i >= 0, "app.js 里找不到 " + name);
  const j = src.indexOf("\nfunction ", i + 1);
  return src.slice(i, j < 0 ? undefined : j);
};

/* ---------------- fixture：用户案例 ---------------- */
/* 官方万份收益 0.23；台账净值最后一日跳 +0.0004 → 折算万收 +4.0（差 17.4 倍）。
   前 6 个点不动，避免被「净值恒定」判据抢先，聚焦口径错位这一条。 */
const CASE_NAV = {
  "2026-11-01": 1.000000, "2026-11-02": 1.000000, "2026-11-03": 1.000000,
  "2026-11-04": 1.000000, "2026-11-05": 1.000000, "2026-11-06": 1.000000,
  "2026-11-07": 1.000000, "2026-11-08": 1.000400,
};
const makeP = nav => ({ id: "p1", name: "案例产品", inst: "某行", navHistory: nav });
const ptsOf = nav => Object.keys(nav).sort().map(d => [d, nav[d]]);
const CASE_PTS = ptsOf(CASE_NAV);
const NV = reportNavFacts(CASE_PTS, { today: "2026-11-15" });
const SESSION = { atText: "11-15 周六 21:00", wdText: "周六", label: "收盘后", focus: "复盘", key: "closed" };
/* 三档情景夹具：22 个点、中段一次 −50bp 冲击，使 stress 档第一点（−9.04bp）
   成为下界，证伪线净值因此**独立于**两个观察阈值。变异反证 C 要靠它才拦得住：
   两档时证伪线恰好等于某个观察阈值，删掉它的白名单登记也看不出来。 */
const BIG_NAV = {};
{
  let v = 1.000000;
  for (let i = 1; i <= 22; i++) {
    v = v * (1 + (i === 12 ? -50 : 1.2) / 10000);
    BIG_NAV["2026-10-" + String(i).padStart(2, "0")] = Number(v.toFixed(8));
  }
}
const BIG_NV = reportNavFacts(ptsOf(BIG_NAV), { today: "2026-11-15" });
const BIG_SC = trendScenarios(BIG_NV, { k: 5 });

/* ═══════════ 1. 口径体检四档 ═══════════ */
test("① 口径体检：净值型 / 万份收益型 / 疑似错位 / 数据不足，四档各自落地", () => {
  const nav = trendCaliber(makeP(CASE_NAV));
  assert.equal(nav.key, "nav");
  assert.equal(nav.label, TREND_CALIBER_LABEL.nav);
  assert.equal(nav.checked, false, "没传官方值时不许谎称做过交叉核对");
  assert.match(nav.warnings.join(""), /没有官方万份收益/, "要显式说出没有官方录入");
  assert.match(nav.note, /折算值|不是官方/);

  const flatNav = {};
  for (let i = 1; i <= 8; i++) flatNav["2026-11-0" + i] = 1.000000;
  const wan = trendCaliber(makeP(flatNav));
  assert.equal(wan.key, "wanfen");
  assert.equal(wan.degrade, true, "疑似万份收益型必须降级：净值序列不适合算弹性/年化");
  assert.match(wan.warnings.join(""), /降级|不适合/);

  const miss = trendCaliber(makeP({ "2026-11-01": 1.000000 }));
  assert.equal(miss.key, "unknown");
  assert.equal(miss.degrade, true);
  assert.match(miss.warnings.join(""), /不足 2 个|不做走势推断/);

  const suspect = trendCaliber(makeP(CASE_NAV), { officialWan: 0.23 });
  assert.equal(suspect.key, "mixed-suspect");
  assert.equal(suspect.checked, true);
  assert.equal(suspect.degrade, true);
  assert.match(suspect.note, /以管理人披露为准/, "只报疑似，不替管理人下结论");
  assert.match(suspect.primary, /单位净值/);
});

test("① 附：净值自身异常跳变也能独立报疑似（不依赖官方录入）", () => {
  const jump = {
    "2026-11-01": 1.000000, "2026-11-02": 1.0000001, "2026-11-03": 1.0000002,
    "2026-11-04": 1.0210002, "2026-11-05": 1.0210003, "2026-11-06": 1.0210004,
    "2026-11-07": 1.0210005, "2026-11-08": 1.0210006,
  };
  const c = trendCaliber(makeP(jump));
  assert.equal(c.key, "mixed-suspect");
  assert.match(c.warnings.join(""), /口径切换|补录|跳变/);
  assert.equal(c.jumpDate, "2026-11-04");
  assert.equal(c.checked, false, "这条是净值序列自身的体检，不是官方交叉核对");
});

/* ═══════════ 2. 错位检测：三重交叉验证（用户案例） ═══════════ */
test("② 案例 0.23 vs +4.0：单日与区间累计都判疑似，主口径回到单位净值", () => {
  const c = trendConsistency(CASE_PTS, 0.23);
  assert.equal(c.ok, true);
  assert.equal(c.level, "suspect");
  assert.ok(c.dayRatio >= TREND_RATIO_LIMIT, "单日差额倍数必须过阈值");
  assert.ok(c.cumRatio >= TREND_RATIO_LIMIT, "区间累计倍数必须过阈值");
  assert.ok(Math.abs(c.dayRatio - 17.4) < 0.2, "4.0/0.23 ≈ 17.4 倍，要算出来而不是写死");
  assert.equal(c.ratios.length, 3, "三条判据一条都不能少");
  assert.equal(c.primary, "单位净值（台账 navHistory）");
  assert.match(c.note, /倍/);
  assert.match(c.warnings.join(""), /只标注|不删除/);
});

test("② 案例「累计 +1 vs +7」：官方序列按日期对齐，累计倍数 7 倍判疑似", () => {
  const pts = [["2026-11-01", 1.000000], ["2026-11-02", 1.000050], ["2026-11-03", 1.000100]];
  const offs = [{ date: "2026-11-02", wan: 3.5 }, { date: "2026-11-03", wan: 3.5 }];
  const c = trendConsistency(pts, offs);
  assert.equal(c.level, "suspect");
  assert.ok(Math.abs(c.cumRatio - 7) < 0.01, "折算累计 1.0 vs 官方累计 7.0 = 7 倍");
  assert.ok(Math.abs(c.dayRatio - 7) < 0.01);
});

test("② 7 日年化自洽：官方序列不足 7 点时明确「未判」，不编一个数", () => {
  const c = trendConsistency(CASE_PTS, 0.23);
  assert.equal(c.annualRatio, null, "单日官方万收不能去年化再跟 7 日净值涨幅比（量纲不一致）");
  assert.equal(c.ratios[2].skipped, true);
  const ok = trendConsistency(CASE_PTS, 4.0);
  assert.equal(ok.level, "ok", "同量级不能误报");
  assert.match(ok.note, /不足 7 点|未判/);
  /* 早期版本把「单日万收」年化后与 7 日涨幅比，算出 5193 倍假告警 —— 这条钉住它 */
  assert.ok(ok.dayRatio < 2 && ok.cumRatio < 2);
});

test("② 没有官方录入 / 日期对不上：一律 unknown，绝不谎称已核对或已判错位", () => {
  const noVal = trendConsistency(CASE_PTS, null);
  assert.equal(noVal.ok, false);
  assert.equal(noVal.level, "unknown");
  assert.match(noVal.note, /没有官方|无法交叉核对/);
  const mismatch = trendConsistency(CASE_PTS, [{ date: "2026-10-01", wan: 0.23 }]);
  assert.equal(mismatch.level, "unknown");
  assert.match(mismatch.note, /对不上/);
  assert.equal(trendConsistency([], 0.23).level, "unknown");
});

test("② 同量级不误报：官方值与折算值一致时判 ok", () => {
  const c = trendConsistency(CASE_PTS, 4.0);
  assert.equal(c.level, "ok");
  assert.equal(c.warnings.length, 0);
});

/* ═══════════ 3. 并列情景 + 观察点 / 证伪线 ═══════════ */
test("③ 观察阈值与证伪线由本机按披露点算，且沿用 reportScenarios 的口径", () => {
  const base = reportScenarios(NV, { k: 5 });
  const sc = trendScenarios(NV, { k: 5 });
  assert.equal(sc.ok, true);
  assert.equal(sc.k, 5);
  assert.deepEqual(sc.rows, base.rows, "情景行必须直接复用，不许另算一份");
  assert.equal(sc.byDate, base.byDate);
  assert.equal(sc.verify.length, 2);
  for (const v of sc.verify) {
    assert.ok(isFinite(v.nav) && v.nav > 0);
    assert.ok(Math.abs(v.nav - NV.last.value * (1 + v.bp / 10000)) < 1e-9, "数字必须是算出来的");
  }
  const firstBps = sc.rows.map(r => r.perBp == null ? r.cumBp / sc.k : r.perBp);
  assert.equal(sc.falsify.bp, Math.min.apply(null, firstBps));
  assert.ok(Math.abs(sc.falsify.nav - NV.last.value * (1 + sc.falsify.bp / 10000)) < 1e-9);
  assert.match(sc.falsify.note, /不是止损价/);
  assert.equal(sc.disclaimer, TREND_NOT_PREDICTION);
  assert.equal(trendScenarios({ ok: false }, { k: 5 }).ok, false, "净值不足时诚实降级");
});

/* ═══════════ 4. 事实块 ═══════════ */
test("④ 专题事实块：口径段在前、观察点段在后，复用研报事实层且换掉【写什么】", () => {
  const cal = trendCaliber(makeP(CASE_NAV), { officialWan: 0.23 });
  const cons = trendConsistency(CASE_PTS, 0.23);
  const sc = trendScenarios(NV, { k: 5 });
  const txt = trendFactsText({
    session: SESSION, kind: "product", name: "案例产品", inst: "某行",
    nav: NV, market: null, cal: [], gaps: [], today: "2026-11-15",
    caliber: cal, consistency: cons, scenarios: sc,
  });
  assert.ok(txt.indexOf("【口径与数据可信度】") < txt.indexOf("【净值】"), "口径段必须排在净值段之前");
  assert.match(txt, /分析主口径/);
  assert.match(txt, /疑似口径错位/);
  assert.match(txt, /17\.4 倍/, "错位倍数是算出来的数");
  assert.match(txt, /【观察点与证伪线】/);
  assert.match(txt, /证伪线：/);
  assert.match(txt, /不是预测/);
  assert.match(txt, /【写什么】五段/);
  assert.ok(!txt.includes("三段：这一段走势"), "【写什么】必须换成专题五段契约");
  assert.match(txt, /【债市】本轮没有可用的债市快照/, "研报事实层确实被复用了");
  assert.match(txt, /数据块里没有/, "缺失口径要照实说");
});

test("④ 事实块在没有官方录入时明说「未做交叉核对」，不冒充官方值", () => {
  const cal = trendCaliber(makeP(CASE_NAV));
  const txt = trendFactsText({
    session: SESSION, kind: "product", name: "案例产品", nav: NV,
    market: null, cal: [], gaps: [], today: "2026-11-15",
    caliber: cal, consistency: trendConsistency(CASE_PTS, null),
    scenarios: trendScenarios(NV, { k: 5 }),
  });
  assert.match(txt, /未做交叉核对/);
  assert.match(txt, /没有官方万份收益 \/ 7 日年化独立录入/);
  assert.ok(!txt.includes("官方万收交叉核对：suspect"));
});

/* ═══════════ 5. 指令契约 ═══════════ */
test("⑤ TREND_INSTRUCTIONS：五段 + 四条铁律，免责正文不进指令", () => {
  assert.equal(TREND_PROMPT_VER, "trend-1");
  assert.equal((TREND_INSTRUCTIONS.match(/^## /gm) || []).length, 5);
  for (const s of ["不许新增任何数字", "不给概率", "收益中枢", "不给目标净值", "不要联网检索", "待核"]) {
    assert.ok(TREND_INSTRUCTIONS.includes(s), "指令缺了：" + s);
  }
  assert.ok(!TREND_INSTRUCTIONS.includes(BRIEF_DISCLAIMER), "免责由页面固定给，不让模型写");
  assert.match(TREND_INSTRUCTIONS, /不许自己再算下一个数/);
  assert.match(TREND_INSTRUCTIONS, /不许把「疑似」写成「就是」/);
});

test("⑤ 专题输出能被现有 parseReport 吃下：五段全收，不丢段", () => {
  const out = [
    "结论：watch", "信心：0.62", "标题：口径先核再看", "",
    "## 口径与数据可信度", "净值型，主口径为台账单位净值，没有官方万份收益录入。",
    "## 近期驱动", "近期披露点平稳，倾向于按常态观察，暂无信息面可引用。",
    "## 并列情景与观察点", "两档并列，不是预测，观察阈值与证伪线按披露点算。",
    "## 什么会使结论失效", "若下一次披露跌破证伪线，则这一份前提要重估。",
    "## 数据缺口", "无",
  ].join("\n");
  const pr = parseReport(out);
  assert.equal(pr.ok, true);
  assert.equal(pr.report.paras.length, 5);
  assert.equal(pr.report.verdict, "watch");
});

/* ═══════════ 6. 变异反证（四条必红 → 恢复必绿） ═══════════ */
test("⑥ 反证 A：抹掉口径标签，一致性检测仍必须独立报疑似", () => {
  const cons = trendConsistency(CASE_PTS, 0.23);
  const forged = Object.assign({}, trendCaliber(makeP(CASE_NAV), { officialWan: 0.23 }),
    { key: "nav", label: "净值型", warnings: [] });
  assert.equal(forged.key, "nav", "这一步故意把标签伪装成正常");
  assert.equal(cons.level, "suspect", "标签能被抹掉，但三条统计判据必须照样报");
  assert.equal(cons.ratios.filter(r => r.value >= r.limit).length >= 2, true);
});

test("⑥ 反证 B：证伪线若由模型自由发挥，数字审计必须判红", () => {
  const f = {
    caliber: trendCaliber(makeP(CASE_NAV)), consistency: trendConsistency(CASE_PTS, null),
    scenarios: BIG_SC,
  };
  const vals = trendAuditValues(f);
  /* 三档夹具保证证伪线数值唯一：删掉它的白名单登记，下面那条「必绿」立刻变红 */
  assert.equal(BIG_SC.rows.length, 3);
  assert.ok(!BIG_SC.verify.some(x => Math.abs(x.nav - BIG_SC.falsify.nav) < 1e-9),
    "证伪线净值必须独立于观察阈值，否则变异测不出来");
  assert.ok(vals.includes(BIG_SC.falsify.nav), "证伪线净值必须显式登记进审计白名单");
  const fabricated = "模型自己编的证伪线 1.009999（数据块里没有）";
  assert.ok(reportNumberAudit(fabricated, vals).unknown.includes("1.009999"));
  /* 恢复：照抄本机算出的证伪线净值，必须一个都不红 */
  const good = "证伪线净值 " + f.scenarios.falsify.nav.toFixed(6);
  assert.deepEqual(reportNumberAudit(good, vals).unknown, []);
});

test("⑥ 反证 C：编造数字 99.9 必红，照抄观察阈值不误报", () => {
  const vals = trendAuditValues({
    caliber: trendCaliber(makeP(CASE_NAV)), consistency: trendConsistency(CASE_PTS, null),
    scenarios: trendScenarios(NV, { k: 5 }),
  });
  assert.ok(reportNumberAudit("净值会到 99.9", vals).unknown.includes("99.9"));
  const sc = trendScenarios(NV, { k: 5 });
  assert.deepEqual(reportNumberAudit("观察阈值 " + sc.verify[0].nav.toFixed(6), vals).unknown, []);
});

test("⑥ 反证 D：外部专家式概率/中枢表述被禁词拦下，命中标题整份拒收", () => {
  for (const s of ["概率 <10%", "收益中枢下修半档 1.5%~2.0%", "前瞻收益", "上涨空间", "目标净值"]) {
    assert.ok(BRIEF_BANNED_RE.test(s), "禁词漏了：" + s);
  }
  const bad = parseReport("结论：watch\n信心：0.6\n标题：上涨概率约 65%\n\n## 段\n正文一句。");
  assert.equal(bad.ok, false, "命中标题必须整份拒收，不是丢一段");
  assert.match(bad.why, /收益预测|目标价|表述/);
  const good = parseReport("结论：watch\n信心：0.6\n标题：口径先核再看\n\n## 段\n正文一句。");
  assert.equal(good.ok, true, "恢复后必绿");
});

/* ═══════════ 7. 卡片与问答分派 ═══════════ */
test("⑦ 口径横幅是本地算的，卡片页脚固定免责", () => {
  const cal = trendCaliber(makeP(CASE_NAV), { officialWan: 0.23 });
  const html = trendCaliberHtml(cal);
  assert.match(html, /data-trend-caliber="mixed-suspect"/);
  assert.match(html, /口径体检/);
  assert.match(html, /分析主口径/);
  assert.match(html, /不是预测/);
  assert.equal(trendCaliberHtml(null), "");
  const card = reportCardHtml({ facts: { kind: "product", nav: null, rows: [], market: null, watch: [], gaps: [] }, rep: null });
  assert.ok(card.includes(BRIEF_DISCLAIMER), "模型没回来时页脚免责也必须在");
});

test("⑦ 观察项把口径告警、观察阈值、证伪线排在 reportWatch 之前", () => {
  const cal = trendCaliber(makeP(CASE_NAV), { officialWan: 0.23 });
  const cons = trendConsistency(CASE_PTS, 0.23);
  const sc = trendScenarios(NV, { k: 5 });
  const w = trendWatcher(cal, cons, sc);
  assert.ok(w.length >= 5);
  assert.equal(w[0].level, "bad");
  assert.match(w[0].text, /口径体检/);
  assert.match(w.map(x => x.text).join(""), /证伪线/);
  assert.ok(w.every(x => x.sub && x.sub.length > 0));
});

test("⑦ 问答分派：走势类问句给指引、普通问句不误伤", () => {
  for (const q of ["这个产品未来走势会涨吗", "下周会不会跌", "后市怎么看", "预测一下净值"]) {
    assert.ok(trendQuestionHint(q), "该拦没拦：" + q);
    assert.match(trendQuestionHint(q), /没有发出|不计费/);
  }
  for (const q of ["帮我看下这只产品的持有天数", "净值是多少", "份额怎么算", ""]) {
    assert.equal(trendQuestionHint(q), "", "误伤了正常提问：" + q);
  }
});

/* ═══════════ 8. 接线与版本钉 ═══════════ */
test("⑧ 接线：模块、入口、mode 分派、横幅、审计白名单、桥接全部真的接上", () => {
  assert.match(APP, /from "\.\/js\/domain\/trend\.js"/);
  assert.match(APP_CODE, /function trendMode\(\)/);
  assert.match(APP_CODE, /openBriefTrend\(/);
  assert.match(APP_CODE, /mode: "trend"/);
  assert.match(APP_CODE, /const trendHint = trendQuestionHint\(q\);/);
  assert.match(APP_CODE, /if \(trendHint\) return toast\(trendHint, 6000\);/);
  assert.match(APP_CODE, /const input = tm\s*\n\s*\? trendFactsText\(/);
  assert.match(APP_CODE, /instructions: tm \? TREND_INSTRUCTIONS : REPORT_INSTRUCTIONS/);
  assert.match(APP_CODE, /ver: \(tm \? TREND_PROMPT_VER : REPORT_PROMPT_VER\)/);
  assert.match(APP_CODE, /trendCaliberHtml\(facts\.caliber\)/);
  assert.match(APP_CODE, /trendAuditValues\(f\)/);
  assert.match(APP_CODE, /BRIEF\.shape = tm \? "trend" : "report"/);
  assert.match(APP_CODE, /openBriefPortfolio, openBriefProduct, openBriefTrend,/);
  /* 同一只产品的研报与专题缓存键必须分开 */
  assert.match(body(APP_CODE, "briefKey"), /\|trend/);
  assert.match(body(APP_CODE, "briefSameTarget"), /mode/);
  /* 序列不足时挡在门口，不发出去让模型编 */
  assert.match(body(APP_CODE, "openBriefTrend"), /不足 2 个披露点/);
});

test("⑧ 版本钉 v136：APP_VER / CACHE 同步、新模块进 SHELL、两份测试清单双登记", () => {
  const ver = /const APP_VER = "(v\d+)"/.exec(APP)[1];
  const cache = /const CACHE = "licai-ledger-(v\d+)"/.exec(SW)[1];
  assert.equal(ver, "v136");
  assert.equal(cache, "v136");
  assert.equal(ver, cache);
  assert.match(SW, /"\.\/js\/domain\/trend\.js"/, "漏进 SHELL 会离线整页空白");
  assert.ok(PKG.includes("tests/trend_v136.test.mjs"), "npm test 要登记");
  assert.ok(CI.includes("tests/trend_v136.test.mjs"), "CI 的 node --test 清单要登记");
});

/* ═══════════ 9. 隔离 / 零后端反向断言 ═══════════ */
test("⑨ 隔离：专题不进问答快照，不给研报链路加字段，不新增云端任务", () => {
  /* 问答链路只有单点净值 —— 走势问题改走专题入口，绝不把序列塞进 llmSnapText */
  assert.ok(!/trend|caliber|证伪线/.test(body(APP_CODE, "llmSnapText")), "问答快照被塞进了趋势数据");
  assert.ok(!/trend|caliber/.test(body(APP_CODE, "llmSnapItems")));
  /* 研报模式（tm=false）一个趋势字段都不加 */
  const bf = body(APP_CODE, "briefFacts");
  assert.match(bf, /const caliber = tm \? trendCaliber/);
  assert.match(bf, /scenarios: tm \? trendScenarios\(nav, \{ k: 5 \}\) : reportScenarios\(nav, \{ k: 5 \}\)/);
  assert.match(bf, /if \(tm\) out\.watch = trendWatcher\(caliber, consistency, out\.scenarios\)/);
  /* 纯函数层零副作用：不联网、不写存储、不定时跑 */
  assert.ok(!/\bfetch\s*\(/.test(stripComments(TREND)), "trend.js 不许发网络请求");
  assert.ok(!/localStorage|setInterval|setTimeout/.test(stripComments(TREND)), "不落存储、不后台定时");
  assert.ok(!/schedule\s*:/.test(CI), "不新增云端定时任务（Actions 配额）");
  /* 私钥/端点不经这一层 */
  assert.ok(!/apiKey|baseUrl|Keystore/.test(stripComments(TREND)));
  /* 免责与合规红线不在专题里被绕开 */
  assert.match(TREND, /不给概率|收益中枢/);
});
