// @ts-check
/* ---------- v137 · P1 信息面「自动 + 可核」专项回归 ----------
   覆盖方案 4.4 的四条：
   1. 新鲜度横幅：trendAgeHours / trendFreshness / trendFreshHtml（纯函数）；
   2. 一键刷新：trendInfoRefresh 接线（newsRefresh force + anysearchRun 有 key 才发）；
   3. 现场检索开关：searchOn 提示在走势专题下的专属文案（允许联网、线索·待核、
      数字不进白名单）；
   4. 数字闸不放松：检索正文标题里的数字绝不进 trendAuditValues 白名单。
   边界钉死：新鲜度只在渲染层（不进指纹）；只标注不代刷（不后台自动跑）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TREND_FRESH_LIMITS, trendAgeHours, trendFreshness, trendFreshHtml,
} from "../js/domain/trend.js";
import { reportSearchFacts, reportNumberAudit } from "../js/domain/report.js";

const NOW = Date.parse("2026-11-16T08:00:00+08:00");
const H = 3600000;

/* ---------- ① trendAgeHours ---------- */

test("P1-1 时点解析：北京字符串 / 纯日期 / 毫秒 / 非法", () => {
  assert.equal(trendAgeHours("2026-11-14 20:00", NOW).toFixed(2), "36.00");
  assert.equal(trendAgeHours("2026-11-16", NOW).toFixed(2), "8.00");   // 纯日期按当天 00:00 北京
  assert.equal(trendAgeHours(NOW - 2 * H, NOW).toFixed(2), "2.00");    // 毫秒（LIVE.at）
  assert.ok(Number.isNaN(trendAgeHours("不是时点", NOW)));
  assert.ok(Number.isNaN(trendAgeHours(null, NOW)));
  assert.ok(Number.isNaN(trendAgeHours("", NOW)));
});

/* ---------- ② trendFreshness ---------- */

test("P1-2 四路齐 + 全新鲜 → allOk，横幅不打扰", () => {
  const f = trendFreshness({
    news: { asOf: "2026-11-16 06:05" },
    ay: { asOf: "2026-11-16 06:30" },
    market: { weather: { asOf: "2026-11-16" } },
    live: { at: NOW - 30 * 60000 },
  }, NOW);
  assert.equal(f.allOk, true);
  assert.equal(f.stale.length, 0);
  assert.equal(f.missing.length, 0);
  assert.equal(f.note, "");
  assert.equal(trendFreshHtml(f).includes(" warn"), false);
});

test("P1-3 超龄判定：检索包 36h 阈值、债市 72h 跨周末、盘中 12h", () => {
  const f = trendFreshness({
    news: { asOf: "2026-11-16 06:05" },
    ay: { asOf: "2026-11-14 19:00" },            // 37h > 36 → stale
    market: { weather: { asOf: "2026-11-13" } }, // 周五日终，周一早上 80h > 72 → stale
    live: { at: NOW - 13 * H },                  // 13h > 12 → stale
  }, NOW);
  assert.deepEqual(f.stale.map(i => i.key).sort(), ["ay", "live", "market"]);
  assert.equal(f.allOk, false);
  assert.match(f.note, /信息面已过期，建议刷新/);
  const html = trendFreshHtml(f);
  assert.equal(html.includes(" warn"), true);
  assert.equal((html.match(/超龄/g) || []).length, 3);
});

test("P1-4 缺路显式写「没有数据」，不影响其余三路", () => {
  const f = trendFreshness({ news: { asOf: "2026-11-16 06:05" }, ay: null }, NOW);
  const ay = f.items.find(i => i.key === "ay");
  assert.equal(ay.missing, true);
  assert.equal(ay.stale, false);          // missing 与 stale 互斥
  assert.match(f.note, /缺 检索包/);
  assert.equal(f.items.length, 4);        // 四路全列出，绝不静默少一路
});

test("P1-5 全缺 → 提示先取一次，而不是装作新鲜", () => {
  const f = trendFreshness({}, NOW);
  assert.equal(f.missing.length, 4);
  assert.match(f.note, /信息面四路都没有数据/);
});

test("P1-6 时点读不懂按 missing 处理，绝不冒充新鲜", () => {
  const f = trendFreshness({ news: { asOf: "garbage" }, ay: { asOf: "" }, market: null, live: {} }, NOW);
  assert.equal(f.missing.length, 4);
  assert.equal(f.allOk, false);
});

test("P1-7 阈值常量钉住（改阈值必须知道在改什么）", () => {
  assert.deepEqual(TREND_FRESH_LIMITS, { news: 36, ay: 36, market: 72, live: 12 });
});

/* ---------- ③ 数字闸：检索正文不进白名单 ---------- */

test("P1-8 检索标题里的数字不进 trendAuditValues 白名单，照抄必红", () => {
  const pack = {
    asOf: "2026-11-16 06:30", query: "银行理财 债市",
    hits: [{ url: "https://example.com/a", title: "11月资金面平稳 净值1.009999 附近波动" }],
  };
  const sf = reportSearchFacts(pack);
  assert.equal(sf.ok, true);
  // 白名单来自本机 facts（此处给空 facts 的典型形状）：检索标题不参与登记
  const vals = trendFreshness({ ay: pack }, NOW); // 新鲜度盘点只取 asOf，不碰 hits
  assert.equal(JSON.stringify(vals.items.map(i => i.asOfText)).includes("1.009999"), false);
  // 数字审计对检索标题原文维持必红 —— 这是「最新消息带假数字进结论」的闸
  const audit = reportNumberAudit("检索说净值 1.009999", []);
  assert.ok(audit.unknown.includes("1.009999"));
});

/* ---------- ④ 接线断言（源码级，handlers 扫描的同款口径） ---------- */

const APP = readFileSync(new URL("../app.js", import.meta.url), "utf-8");

test("P1-9 app.js 接线：import / 横幅拼接 / 一键刷新 / 导出", () => {
  assert.match(APP, /trendFreshness, trendFreshHtml/);
  // 横幅只挂在 trend 分支，研报不画
  assert.match(APP, /const banner = trendMode\(\)\s*\n\s*\? trendCaliberHtml\(facts\.caliber\)\s*\n\s*\+ trendFreshHtml\(trendFreshness\(\{ news: NEWS, ay: AY_PACK, market: MARKET, live: LIVE \}\)\)/);
  assert.match(APP, /async function trendInfoRefresh\(\)/);
  assert.match(APP, /await newsRefresh\(\{ force: true \}\)/);
  // 「一次检索一次配额」铁律：有 key 且在本机 App 内才发
  assert.match(APP, /if \(nativeFetchAvailable\(\) && ayHasKey\(\)\) await anysearchRun\(\);/);
  // window 导出（内联 onclick 依赖）
  assert.match(APP, /briefSearchOff, briefSearchOffRetry, trendInfoRefresh,/);
});

test("P1-10 「更新信息面」按钮只在走势专题出现，生成中禁用", () => {
  const m = APP.match(/\$\{tm \? `<div class="row-btn"[^]*?trendInfoRefresh\(\)[^]*?<\/div>` : ""\}/);
  assert.ok(m, "按钮模板缺失");
  assert.match(m[0], /\$\{running \? "disabled" : ""\}/);
  // 研报（非 tm）不得出现这颗按钮 —— 上面的三目空分支钉住
  assert.match(m[0], /: ""\}/);
});

test("P1-11 现场检索提示：专题专属文案钉住三条闸", () => {
  const i0 = APP.indexOf("${searchOn ? (tm ?");
  assert.ok(i0 > 0, "searchOn 双分支缺失");
  const seg = APP.slice(i0, i0 + 1400);
  assert.match(seg, /走势专题允许联网找「最新金融信息」，但三条闸不变/);
  assert.match(seg, /线索 · 待核/);
  assert.match(seg, /检索正文里的数字不进审计白名单/);
  assert.match(seg, /briefSearchOff\(\)/);
  // 研报旧文案仍在（非 tm 分支），没有被误删
  assert.match(seg, /研判用不上它/);
});

test("P1-12 版本钉：APP_VER 与 CACHE 同步为 v137，旧测试不再持有上一版字面量", () => {
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf-8");
  const swSrc = readFileSync(new URL("../sw.js", import.meta.url), "utf-8");
  const ver = appSrc.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = swSrc.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, "v140");
  assert.equal(cache, ver, "APP_VER 与 CACHE 必须同版本（handlers 总测同款判据）");
  const prev = "v" + (Number(ver.slice(1)) - 1);
  for (const f of ["bocmob_v135", "monitor_v131", "ccb_quota_v132", "buyrule_v133", "markettable_v134", "trend_v136"]) {
    const s = readFileSync(new URL(`../tests/${f}.test.mjs`, import.meta.url), "utf-8");
    assert.equal(s.includes(`"${prev}"`), false, `${f}.test.mjs 仍有 ${prev} 字面量`);
  }
});

test("P1-13 新鲜度不进指纹（渲染层专属）—— trend.js 不 export 任何进 pack 的时点值", () => {
  // briefPack 的指纹 ver 沿用 TREND_PROMPT_VER，不含 fresh/时点字段
  assert.equal(APP.includes('ver: (tm ? TREND_PROMPT_VER : REPORT_PROMPT_VER)'), true);
  assert.equal(/\bfresh\w*\s*[,}]/.test(APP.match(/ver: \(tm \? TREND_PROMPT_VER[\s\S]{0,80}/)[0]), false);
});
