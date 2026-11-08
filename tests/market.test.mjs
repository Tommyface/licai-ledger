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
