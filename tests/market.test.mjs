/* 债市晴雨表（v100）的口径测试：node --test tests/market.test.mjs
   数据由私有仓 Update NAV 每日生成（licai-ledger.bondWeather/0.2），公开仓只读。
   这一层的价值在「坏数据不许进界面、更不许进大模型的输入」：
     · 结构坏（schema/格子数/枚举）→ 整包拒收，页面退回「无行情数据」；
     · 逻辑坏（方向与 BP 符号打架）→ 整包拒收 —— 红绿符号是整个功能的语义；
     · verified 不成立 → 不进 LLM 快照（界面上仍可看，但标注「未核验」）；
     · aiText 出现禁用词 → 拒收（公开仓复扫，与私有仓引擎同一张表，双保险）。
   判据与私有仓 navsources/market_weather.py 是同一条契约的两半：
   改任何一条都要同步改两边的实现与测试。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MARKET_SCHEMA, MARKET_FORBIDDEN, MARKET_CELL_COUNT,
  MARKET_RATE_ISSUERS, MARKET_RATE_TENORS, MARKET_CREDIT_ISSUERS, MARKET_CREDIT_TENORS,
  MARKET_DIR_LABEL, MARKET_BP_WINDOW_LABEL,
  isIsoDate, validateMarket, marketGroups, marketStat,
  marketAiTextSafe, marketAiBlock, marketPanelHtml,
  MARKET_CLOSE_HHMM, marketCutoffText, marketAgeText,
} from "../js/core/market.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

/* ---- 真实快照（私有仓引擎产出的首份经过互证的真数据）---- */
const REF = JSON.parse(read("data/market.reference.json"));
const okRef = validateMarket(REF);
const REF_OK = okRef.ok ? REF : null;   // 结构测试若因参考数据本身变坏而红，别在下面炸 TypeError

/* ---- 一份最小合法快照（合成，各测试在它之上做单点破坏）---- */
function mkCell(over) {
  return Object.assign({
    group: "rate", issuer: "国债", tenor: "1年", dir: "up", dirConfidence: "high",
    basis: { curve: "中债国债收益率曲线（到期）", tenorKey: 1.0, yieldPct: 1.1683, prevYieldPct: 1.171, bp1d: -0.3 },
    source: { url: "https://yield.chinabond.com.cn/cbweb-mn/yc/ycDetail", dataDate: "2026-11-06", tier: "official",
      prevUrl: "https://yield.chinabond.com.cn/cbweb-mn/yc/ycDetail", prevDate: "2026-11-05" },
  }, over || {});
}
function mkCells(dirBp) {
  /* dirBp: [issuer, tenor, dir, bp] 三元组列表 → 全 33 格；缺的格子用 none 填 */
  const map = new Map(dirBp.map(([i, t, d, b]) => [`${i}|${t}`, [d, b]]));
  const cells = [];
  for (const issuer of MARKET_RATE_ISSUERS) for (const tenor of MARKET_RATE_TENORS) {
    const [d, b] = map.get(`${issuer}|${tenor}`) || ["none", undefined];
    cells.push(mkCell({ issuer, tenor, dir: d, basis: d === "none"
      ? { curve: "曲线", tenorKey: 1.0, reason: "官方曲线未发布该期限" }
      : { curve: "曲线", tenorKey: 1.0, yieldPct: 1.2, prevYieldPct: 1.2 - b / 100, bp1d: b } }));
  }
  for (const issuer of MARKET_CREDIT_ISSUERS) for (const tenor of MARKET_CREDIT_TENORS) {
    const [d, b] = map.get(`${issuer}|${tenor}`) || ["none", undefined];
    cells.push(mkCell({ group: "credit", issuer, tenor, dir: d, basis: d === "none"
      ? { curve: "曲线", tenorKey: 1.0, reason: "官方曲线未发布该期限" }
      : { curve: "曲线", tenorKey: 1.0, yieldPct: 1.5, prevYieldPct: 1.5 - b / 100, bp1d: b } }));
  }
  return cells;
}
function mkSnapshot(over) {
  const s = {
    schema: MARKET_SCHEMA,
    weather: { asOf: "2026-11-06", prevDate: "2026-11-05", cells: mkCells([
      ["国债", "1年", "up", -0.3], ["国开", "3年", "down", 1.1], ["AAA", "6月", "flat", 0],
    ]) },
    aiText: "【债市快照 2026-11-06】利率债：国债 1年红(-0.3bp)。缺口：无。",
    meta: { schema: MARKET_SCHEMA, sourceType: "official_curve", verified: true,
      verifiedBy: "自动引擎", capturedAt: "2026-11-08T17:15:50+08:00",
      gaps: [], consistencyFlags: [], disclaimer: "情景参考，非预测。" },
  };
  return Object.assign(s, over || {});
}

/* ---------- schema 与枚举 ---------- */
test("真实参考快照通过校验（参考数据本身也是契约的一部分）", () => {
  assert.equal(okRef.ok, true, okRef.why || "");
  assert.ok(REF_OK);
});
test("schema 号不认识 → 拒收（引擎升版后旧页面必须显式拒，不许猜形状）", () => {
  assert.equal(validateMarket(mkSnapshot({ schema: "licai-ledger.bondWeather/0.1" })).ok, false);
});
test("天气块缺 asOf / prevDate / cells → 拒收", () => {
  for (const drop of ["asOf", "prevDate", "cells"]) {
    const s = mkSnapshot();
    delete s.weather[drop];
    assert.equal(validateMarket(s).ok, false, drop);
  }
});
test("格子数不足 33 → 拒收（少一格就是少一条曲线的行情）", () => {
  const s = mkSnapshot();
  s.weather.cells.pop();
  assert.equal(validateMarket(s).ok, false);
});
test("发行人 / 期限 / 方向 枚举外的值 → 拒收", () => {
  const s = mkSnapshot();
  s.weather.cells[0].issuer = "城商行";
  assert.equal(validateMarket(s).ok, false);
  const s2 = mkSnapshot();
  s2.weather.cells[0].tenor = "2年";   // 2年只在 curveCards/bpTable，不在格子体系
  assert.equal(validateMarket(s2).ok, false);
  const s3 = mkSnapshot();
  s3.weather.cells[0].dir = "upside";
  assert.equal(validateMarket(s3).ok, false);
});
test("格子缺 source（url/tier/dataDate 任一）→ 拒收（出处双全是门禁）", () => {
  for (const drop of ["url", "tier", "dataDate"]) {
    const s = mkSnapshot();
    delete s.weather.cells[0].source[drop];
    assert.equal(validateMarket(s).ok, false, drop);
  }
});

/* ---------- 方向判据（功能语义的命门） ---------- */
test("方向与 BP 符号互洽：up⇔bp<0、down⇔bp>0、flat⇔bp=0，打架 → 拒收", () => {
  const bad = [
    ["up", 0.5], ["down", -0.5], ["flat", 1.0],
  ];
  for (const [dir, bp] of bad) {
    const s = mkSnapshot();
    s.weather.cells[0].dir = dir;
    s.weather.cells[0].basis.bp1d = bp;
    s.weather.cells[0].basis.prevYieldPct = s.weather.cells[0].basis.yieldPct - bp / 100;
    assert.equal(validateMarket(s).ok, false, `${dir} 配 bp=${bp}`);
  }
});
test("up/down/flat 格缺 bp1d / yieldPct → 拒收；none 格必须带 reason", () => {
  const s = mkSnapshot();
  delete s.weather.cells[0].basis.bp1d;
  assert.equal(validateMarket(s).ok, false);
  const s2 = mkSnapshot();
  s2.weather.cells[0].basis.yieldPct = undefined;
  assert.equal(validateMarket(s2).ok, false);
  const s3 = mkSnapshot();
  const nc = s3.weather.cells.find(c => c.dir === "none");
  delete nc.basis.reason;
  assert.equal(validateMarket(s3).ok, false);
});
test("-0 的 BP 算 flat，不算 up（JS 的 -0 === 0 为真，判据不许在这里分叉）", () => {
  const s = mkSnapshot();
  s.weather.cells[0].basis.bp1d = -0;
  s.weather.cells[0].dir = "flat";
  assert.equal(validateMarket(s).ok, true);
  const s2 = mkSnapshot();
  s2.weather.cells[0].basis.bp1d = -0;
  s2.weather.cells[0].dir = "up";    // 合成快照带 -0 却标 up → 拒
  assert.equal(validateMarket(s2).ok, false);
});

/* ---------- verified / flags / gaps / 禁用词 ---------- */
test("verified=true 时 consistencyFlags 必须为空，互斥被破坏 → 拒收", () => {
  const s = mkSnapshot();
  s.meta.consistencyFlags = ["GRID_SIGN_DIVERGENCE"];
  assert.equal(validateMarket(s).ok, false);
});
test("verified=false 的快照：结构可过校验，但 aiBlock 不进 LLM", () => {
  const s = mkSnapshot();
  s.meta.verified = false;
  assert.equal(validateMarket(s).ok, true);           // 界面可展示（标注未核验）
  assert.equal(marketAiBlock(s), "");                  // 不进大模型输入
});
test("aiText 出现禁用词（私有仓同一张表）→ 整包拒收", () => {
  for (const w of MARKET_FORBIDDEN) {
    const s = mkSnapshot();
    s.aiText = "明天" + w + "看多。缺口：无。";
    assert.equal(validateMarket(s).ok, false, w);
  }
});
test("aiText 缺失或非字符串 → 拒收（快照文本是本功能的交付物之一）", () => {
  const s = mkSnapshot();
  delete s.aiText;
  assert.equal(validateMarket(s).ok, false);
});
test("meta 缺 verified / capturedAt / disclaimer → 拒收", () => {
  for (const drop of ["verified", "capturedAt", "disclaimer"]) {
    const s = mkSnapshot();
    delete s.meta[drop];
    assert.equal(validateMarket(s).ok, false, drop);
  }
});

/* ---------- 日期形制 ---------- */
test("isIsoDate：严格 YYYY-MM-DD 且是真日期", () => {
  assert.equal(isIsoDate("2026-11-06"), true);
  assert.equal(isIsoDate("2026-13-01"), false);   // 月越界
  assert.equal(isIsoDate("2026-02-30"), false);   // 假日期
  assert.equal(isIsoDate("2026-11-06 00:00:00"), false);  // EM 的时间后缀不许漏进来
  assert.equal(isIsoDate("20261106"), false);
  assert.equal(isIsoDate(""), false);
  assert.equal(isIsoDate(null), false);
});
test("asOf / prevDate 格式坏 → 拒收；prevDate ≥ asOf → 拒收（上一交易日不会是今天之后）", () => {
  const s = mkSnapshot();
  s.weather.asOf = "2026-11-06 00:00:00";
  assert.equal(validateMarket(s).ok, false);
  const s2 = mkSnapshot();
  s2.weather.prevDate = "2026-11-07";
  assert.equal(validateMarket(s2).ok, false);
});

/* ---------- 分组与统计 ---------- */
test("marketGroups：利率债 15 格（3×5）在前、信用债 18 格（3×6）在后，格子逐个落位", () => {
  const g = marketGroups(REF_OK || mkSnapshot());
  assert.equal(g.rate.length, 15);
  assert.equal(g.credit.length, 18);
  assert.deepEqual(g.rate.map(c => c.issuer), Array(5).fill("国债").concat(Array(5).fill("国开")).concat(Array(5).fill("口行")));
  assert.deepEqual(g.credit.map(c => c.tenor), Array(3).fill(MARKET_CREDIT_TENORS).flat());
});
test("marketStat：真实快照 红26/绿3/白0/蓝4（2026-11-06），统计是界面状态行的数源", () => {
  const st = marketStat(REF_OK);
  assert.deepEqual(st, { up: 26, down: 3, flat: 0, none: 4 });
});

/* ---------- LLM 快照附加块 ---------- */
test("marketAiBlock：verified 时带 asOf 与 aiText 原文；复扫拦下禁用词", () => {
  const blk = marketAiBlock(REF_OK);
  assert.ok(blk.includes("2026-11-06"));
  assert.ok(blk.includes(REF_OK.aiText));
  const s = mkSnapshot();
  s.aiText = "预计明日上涨。缺口：无。";
  assert.equal(marketAiTextSafe(s), "");      // 复扫拦下，绝不出去
  assert.equal(validateMarket(s).ok, false);  // 整包也过不了校验
});
test("marketAiTextSafe：干净文本原样返回，长度不超 2000（防异常大文本撑爆快照）", () => {
  assert.equal(marketAiTextSafe(REF_OK), REF_OK.aiText);
  const s = mkSnapshot();
  s.aiText = "x".repeat(2001);
  assert.equal(marketAiTextSafe(s), "");
});

/* ---------- 弹窗 HTML ---------- */
test("marketPanelHtml：verified 快照渲染出状态行 + 两组矩阵 + 免责声明；未带数据时给空串", () => {
  const html = marketPanelHtml(REF_OK);
  assert.ok(html.includes("2026-11-06"));
  assert.ok(html.includes("红 26"));
  assert.ok(html.includes("免责") || html.includes("情景参考"));
  assert.equal((html.match(/mkt-cell/g) || []).length >= 33, true);
  assert.equal(marketPanelHtml(null), "");
});
test("marketPanelHtml：verified=false 时显示「未核验」标注，不给绿色核验章", () => {
  const s = JSON.parse(JSON.stringify(mkSnapshot()));
  s.meta.verified = false;
  const html = marketPanelHtml(s);
  assert.ok(html.includes("未核验"));
  assert.ok(!html.includes("已核验"));
});
test("v126：标题行自带「MM-DD 收盘」；cut 行带「取于」抓取时刻", () => {
  const s = mkSnapshot();
  const html = marketPanelHtml(s);
  /* 标题行：数据日期是行情本身的属性，cut=false 的债市页也要看得见
     （badge 是嵌套 span，「已核验」与日期之间隔着 </span>，正则按后者锚定） */
  assert.match(html, /<span class="mkt-ok">已核验<\/span> · \d{2}-\d{2} 收盘 · 红 \d+ \//);
  /* cut 行（模型接入页）：抓取时刻一并给出，与「日终估值 · 现券收盘」同排 */
  assert.match(html, /取于 11-08 17:15/);
  /* cut=false（债市页）：标题行时点仍在，cut 行不出现（不与状态条重复） */
  const html2 = marketPanelHtml(s, { cut: false });
  assert.match(html2, /· \d{2}-\d{2} 收盘 · 红 \d+ \//);
  assert.ok(!html2.includes("取于"), "cut=false 时不渲染 cut 行");
  /* asOf / capturedAt 形态异常时降级为空，不渲染半截文本 */
  const s3 = mkSnapshot();
  s3.weather.asOf = "not-a-date";
  s3.meta.capturedAt = "junk";
  const html3 = marketPanelHtml(s3);
  assert.ok(!html3.includes("收盘 · 红"), "非法 asOf 不渲染「收盘」");
  assert.ok(!html3.includes("取于"), "非法 capturedAt 不渲染「取于」");
});
test("marketPanelHtml：格子内容全部过 esc（数据里混入 HTML 不许进 DOM）", () => {
  const s = mkSnapshot();
  s.weather.cells[0].basis.reason = "<script>alert(1)</script>";
  const html = marketPanelHtml(s);
  assert.ok(!html.includes("<script>"));
});
test("常量契约：格数 33、BP 窗口 4 档标签、目录标签全中文", () => {
  assert.equal(MARKET_CELL_COUNT, 33);
  assert.deepEqual(MARKET_RATE_ISSUERS, ["国债", "国开", "口行"]);
  assert.deepEqual(MARKET_CREDIT_ISSUERS, ["AAA", "AA+", "AA"]);
  assert.deepEqual(MARKET_BP_WINDOW_LABEL, ["1日", "5日", "20日", "60日"]);
  assert.equal(MARKET_DIR_LABEL.up.includes("收益率下行"), true);
  assert.equal(MARKET_DIR_LABEL.down.includes("收益率上行"), true);
});

/* ---------- v107：截止时间与相对时间（纯函数，直接真跑） ----------
   这一组的语义要点：
   · 「截至 17:00」是**市场收盘**时点，不是数据发布时刻 —— 常量与文案不许写成「发布」；
   · 未来时点绝不显示（asOf 当天的 17:00 还没到就只给日期）；
   · 取数时刻为空就返回空串，不许写「0 秒前」这种假话。 */
test("marketCutoffText：asOf + 17:00；无快照/坏日期给空串", () => {
  const at = Date.parse("2026-11-10T09:00:00+08:00");     /* asOf 已过：正常显示时点 */
  assert.equal(marketCutoffText(REF, at), `截至 2026-11-06 ${MARKET_CLOSE_HHMM}`);
  assert.equal(marketCutoffText(null, at), "");
  assert.equal(marketCutoffText({ weather: { asOf: "2026-11-31" } }, at), "");
  assert.equal(marketCutoffText({ weather: {} }, at), "");
});

test("marketCutoffText：当日收盘时点还没到 → 只给日期，不显示没发生的时点", () => {
  const before = Date.parse("2026-11-06T16:59:00+08:00");
  assert.equal(marketCutoffText(REF, before), "截至 2026-11-06");
  const after = Date.parse("2026-11-06T17:00:01+08:00");
  assert.equal(marketCutoffText(REF, after), `截至 2026-11-06 ${MARKET_CLOSE_HHMM}`);
});

test("marketAgeText：刚刚 / 分钟 / 小时 / 跨天给月日时分；空值给空串", () => {
  /* 这两个时刻必须用**本地时区**构造（new Date(y,m,d,...)），不能用 "…+08:00" 字面量。
     函数是给本机用户看的：跨天那条走 getHours()，按运行时的本机时区格式化。
     用 +08:00 字面量构造，UTC 的 CI 上就会读出「09:15」——那是测试写错了，不是函数错了。
     构造与格式化同处一个时区，这条断言在任何 runner 时区下都成立。 */
  const now = new Date(2026, 10, 9, 15, 0, 0).getTime();
  assert.equal(marketAgeText(now - 30e3, now), "刚刚");
  assert.equal(marketAgeText(now - 12 * 60e3, now), "12 分钟前");
  assert.equal(marketAgeText(now - 3 * 3600e3, now), "3 小时前");
  assert.equal(marketAgeText(new Date(2026, 10, 8, 17, 15, 0).getTime(), now), "11-08 17:15");
  assert.equal(marketAgeText(0, now), "");
  assert.equal(marketAgeText(null, now), "");
  assert.equal(marketAgeText("abc", now), "");
  /* 时钟回拨（at 在未来）不许出现负数 */
  assert.equal(marketAgeText(now + 60e3, now), "刚刚");
});

test("marketPanelHtml：截止时间进面板，「17:00」配的是收盘口径，不是发布口径", () => {
  const html = marketPanelHtml(REF);
  assert.ok(html.includes(`截至 ${REF.weather.asOf} ${MARKET_CLOSE_HHMM}`), "面板里没有截止时间");
  assert.ok(html.includes("现券") && html.includes("收盘"), "截止时点没写口径");
  assert.ok(!html.includes("17:00 发布") && !html.includes("发布时刻"), "把收盘时点说成了发布时刻");
});

/* ---------- v118：中票利差（从同一份 33 格派生） ---------- */
import { marketSpreads, spreadChgText, spreadHtml, MARKET_SPREAD_TENORS } from "../js/core/market.js";

const CELL = (group, issuer, tenor, y, bp1, dir) => ({
  group, issuer, tenor, dir,
  source: { url: "u", tier: "official", dataDate: "2026-11-06" },
  basis: { yieldPct: y, prevYieldPct: y - bp1 / 100, bp1d: bp1 },
});

test("利差：只算能对上的期限（信用 1月/3月/6月 不对国债 1年 凑数）", () => {
  assert.deepEqual(MARKET_SPREAD_TENORS, ["1年", "3年", "5年"]);
  const m = { weather: { cells: [
    CELL("rate", "国债", "1年", 1.1683, -0.3, "up"),
    CELL("rate", "国债", "3年", 1.2291, -1.1, "up"),
    CELL("credit", "AAA", "1月", 1.4000, 0.1, "down"),
    CELL("credit", "AAA", "1年", 1.4500, -0.1, "up"),
    CELL("credit", "AAA", "3年", 1.5821, -1.0, "up"),
  ] } };
  const sp = marketSpreads(m);
  assert.deepEqual(sp.map(s => s.issuer + s.tenor), ["AAA1年", "AAA3年"], "6 个月中票没有对应国债，不该出现");
});

test("利差：数值 = 信用 − 国债，一位小数；变化 = 两个 bp1d 相减", () => {
  const m = { weather: { cells: [
    CELL("rate", "国债", "1年", 1.1683, -0.3, "up"),
    CELL("credit", "AAA", "1年", 1.4500, -0.1, "up"),
  ] } };
  const s = marketSpreads(m)[0];
  assert.equal(s.spread, 28.2, "1.45 − 1.1683 = 0.2817 → 28.2bp");
  assert.equal(s.chg, 0.2, "−0.1 − (−0.3) = +0.2");
  assert.equal(s.dir, "down", "利差走阔 = 信用债跑输 = 绿");
});

test("利差方向：走阔绿、收窄红、持平白 —— 与矩阵同一套语义", () => {
  const mk = (crBp, gvBp) => ({ weather: { cells: [
    CELL("rate", "国债", "1年", 1.1683, gvBp, "up"),
    CELL("credit", "AAA", "1年", 1.4500, crBp, "up"),
  ] } });
  assert.equal(marketSpreads(mk(-1.0, -0.3))[0].dir, "up", "信用下行更多 = 利差收窄 → 红");
  assert.equal(marketSpreads(mk(0.2, -0.3))[0].dir, "down", "利差走阔 → 绿");
  assert.equal(marketSpreads(mk(-0.8, -0.3))[0].dir, "up", "利差收窄 → 红");
  assert.equal(marketSpreads(mk(-0.3, -0.3))[0].dir, "flat", "同步变动 → 白");
});

test("利差：缺国债那一档就不算，绝不拿别的期限顶", () => {
  const m = { weather: { cells: [
    CELL("rate", "国债", "1年", 1.1683, -0.3, "up"),
    CELL("credit", "AAA", "5年", 1.6428, -1.2, "up"),
  ] } };
  assert.deepEqual(marketSpreads(m), [], "5 年国债不在表里，5 年利差算不出来");
});

test("利差：none 格与缺 basis 一律跳过", () => {
  const m = { weather: { cells: [
    CELL("rate", "国债", "1年", 1.1683, -0.3, "up"),
    { group: "credit", issuer: "AAA", tenor: "1年", dir: "none",
      source: { url: "u", tier: "official", dataDate: "2026-11-06" }, basis: { reason: "未发布" } },
  ] } };
  assert.deepEqual(marketSpreads(m), []);
});

test("利差文案：带符号、零值写持平、缺值给空串", () => {
  assert.equal(spreadChgText({ chg: 0.2 }), "+0.2bp");
  assert.equal(spreadChgText({ chg: -0.2 }), "-0.2bp");
  assert.equal(spreadChgText({ chg: 0 }), "持平");
  assert.equal(spreadChgText({ chg: null }), "");
  assert.equal(spreadChgText(null), "");
});

test("利差表：标题与说明都必须写「中票」，且明说不是城投", () => {
  const sp = [{ issuer: "AAA", tenor: "1年", spread: 28.2, chg: 0.2, creditYield: 1.45, govtYield: 1.1683, dir: "down" }];
  const h = spreadHtml(sp);
  assert.match(h, /中票利差/);
  assert.match(h, /中短期票据 − 同期限国债/);
  assert.match(h, /不是城投利差/);
  assert.match(h, /本项目没有城投曲线，不做替代/);
  assert.ok(!/城投利差：/.test(h), "不许出现「城投利差：xx」这种写法");
});

test("利差表：空数组 → 空串（不画一张空表）", () => {
  assert.equal(spreadHtml([]), "");
  assert.equal(spreadHtml(null), "");
});
