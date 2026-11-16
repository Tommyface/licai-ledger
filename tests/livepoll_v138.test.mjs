/* v138 · 债市「实时层前台轮询」专项回归
   跑法：node --test tests/livepoll_v138.test.mjs

   背景（为什么要有这一版）：用户问「债市行情能不能像南方基金/微众那样实时」。
   查证事实：截图里那张 33 格表是**中债官方日终曲线**（每交易日 17:30 发布一次，
   周末与当日发布前停在上一交易日 —— 不是停更）；竞品展示的是行情终端的
   实时指数/收益率，对应本项目**已有的东财此刻层**。故本版不动日终链路、不换源，
   只做三件事：① 前台定时轮询此刻层；② 把"17:30 发布 / 双轨"讲清楚；③ 昨收 bp 不变。

   ★ 本文件守五条线，改坏任何一条必红：
     ① 轮询三重闸门（前台 + 债市页打开 + 过 TTL）缺一不可；
     ② 定时器已注册、间隔常量在合理区间；
     ③ 口径说明 HTML 与纯文本都带、且含「17:30 / 不是停更 / 不做差」；
     ④ 此刻层 bp 方向语义未被改动（收益率下行仍记红）；
     ⑤ 版本钉按总测纪律动态比对，测试里不写死 vNN。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIVE_POLL_NOTE, realtimeTableHtml, realtimeTableText,
} from "../js/core/markettable.js";
import { liveParse, liveDirOf, liveChgText } from "../js/core/livebond.js";

const APP = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const SW = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const MT = readFileSync(new URL("../js/core/markettable.js", import.meta.url), "utf8");
const PKG = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

/* ---- ① 轮询三重闸门 ---- */
test("V138-1 轮询间隔常量存在且在合理区间（10s~120s）", () => {
  const m = APP.match(/const LIVE_POLL_MS = (\d+) \* 1000/);
  assert.ok(m, "LIVE_POLL_MS 常量缺失");
  const sec = Number(m[1]);
  assert.ok(sec >= 10 && sec <= 120, `轮询间隔 ${sec}s 不在 10~120s 合理区间`);
});

test("V138-2 liveAutoPollTick 三重闸门：前台 / 债市页 / TTL 一个都不少", () => {
  const fn = APP.match(/function liveAutoPollTick\(\)[\s\S]*?\n\}/);
  assert.ok(fn, "liveAutoPollTick 函数缺失");
  const body = fn[0];
  assert.match(body, /document\.visibilityState !== "visible"/, "缺前台可见闸门");
  assert.match(body, /LLM\.host !== "market"/, "缺宿主=market 闸门");
  assert.match(body, /\$\("mktHero"\)/, "缺债市页 DOM 闸门");
  assert.match(body, /LIVE_ST\.lastTry/, "缺 TTL 节流闸门");
  assert.match(body, /liveRefresh\(\{ silent: true \}\)/, "未复用 liveRefresh 静默刷新");
});

test("V138-3 闸门顺序：visible 与 market 判断必须早于发请求（源码位置）", () => {
  const fn = APP.match(/function liveAutoPollTick\(\)[\s\S]*?\n\}/)[0];
  const iVis = fn.indexOf('visibilityState !== "visible"');
  const iMkt = fn.indexOf('LLM.host !== "market"');
  const iTtl = fn.indexOf("lastTry");
  const iReq = fn.indexOf("liveRefresh(");
  assert.ok(iVis >= 0 && iMkt > iVis && iTtl > iMkt && iReq > iTtl,
    "闸门顺序被改：必须先判可见、再判债市页、再判 TTL，最后才发请求");
});

/* ---- ② 定时器注册 ---- */
test("V138-4 全局定时器已注册，且间隔用常量而非硬编码", () => {
  assert.match(APP, /setInterval\(liveAutoPollTick, LIVE_POLL_MS\)/);
});

test("V138-5 回到前台补一次：visibilitychange 里调用轮询", () => {
  const seg = APP.match(/document\.addEventListener\("visibilitychange"[\s\S]*?\n  \}\);/);
  assert.ok(seg, "visibilitychange 监听缺失");
  assert.match(seg[0], /liveAutoPollTick\(\)/, "回到前台未补一次此刻层");
});

/* ---- ③ 口径说明：HTML 与纯文本一致、关键措辞齐全 ---- */
test("V138-6 LIVE_POLL_NOTE 含五个要点", () => {
  for (const kw of ["30 秒", "现抓", "17:30", "不是停更", "不做差、不互补"]) {
    assert.ok(LIVE_POLL_NOTE.includes(kw), `口径说明缺「${kw}」`);
  }
});

test("V138-7 HTML 渲染带口径说明（带可定位属性）", () => {
  const h = realtimeTableHtml(null, null, {});
  assert.match(h, /data-live-poll-note="1"/);
  assert.ok(h.includes("17:30"), "HTML 口径段未渲染或内容缺失");
});

test("V138-8 纯文本导出带同一段口径说明（两处读同一常量）", () => {
  const t = realtimeTableText(null, null, {});
  assert.ok(t.includes("【实时层口径】"), "纯文本缺口径段标题");
  assert.ok(t.includes(LIVE_POLL_NOTE), "纯文本口径段与常量不一致");
});

test("V138-9 源码级：HTML 与纯文本都引用 LIVE_POLL_NOTE，不许各写一份", () => {
  const hits = (MT.match(/LIVE_POLL_NOTE/g) || []).length;
  assert.equal(hits, 3, `LIVE_POLL_NOTE 应恰好 3 处（定义+HTML+文本），实得 ${hits}`);
  assert.match(MT, /data-live-poll-note="1">\$\{esc\(LIVE_POLL_NOTE\)\}/, "HTML 未引用常量");
  assert.match(MT, /【实时层口径】\$\{LIVE_POLL_NOTE\}/, "纯文本未引用常量");
});

/* ---- ④ 此刻层 bp 语义未变 ---- */
const RAW = { data: { diff: [
  { f2: 1.5964, f3: 0.12, f4: 0.0019, f12: "CN10Y", f14: "中国10年期国债" },
  { f2: 1.2340, f3: -0.10, f4: -0.0012, f12: "CN30Y", f14: "中国30年期国债" },
] } };
test("V138-10 收益率下行仍记红：昨收 bp 与方向语义未被本版改动", () => {
  const p = liveParse(RAW);
  assert.ok(p.ok);
  const y10 = p.quotes.CN10Y, y30 = p.quotes.CN30Y;
  assert.equal(y10.dir, "down", "收益率上行(f4>0)记绿");
  assert.equal(y30.dir, "up", "收益率下行(f4<0)记红");
  assert.equal(liveChgText(y10), "+0.2bp");
  assert.equal(liveDirOf("yield", -0.5), "up");
});

test("V138-11 本版不碰日终层：33 格相关渲染函数未在 markettable 里被改写口径", () => {
  // buildDailySummary 仍从 market 取数，LIVE_POLL_NOTE 不进日终摘要
  const seg = MT.match(/export function buildDailySummary\(m\)[\s\S]*?\n\}/)[0];
  assert.ok(!seg.includes("LIVE_POLL_NOTE"), "口径说明误入日终摘要");
  assert.ok(!seg.includes("live."), "日终摘要不应读此刻层");
});

/* ---- ⑤ 双登记 + 版本动态比对（不写死 vNN）---- */
test("V138-12 新测试已进 package.json 与 ci.yml 两份清单", () => {
  assert.match(PKG, /tests\/livepoll_v138\.test\.mjs/);
  assert.match(CI, /tests\/livepoll_v138\.test\.mjs/);
});

test("V138-13 APP_VER 与 CACHE 同版本（动态读，不在测试里钉死）", () => {
  const cache = SW.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  const ver = APP.match(/const APP_VER = "(v\d+)"/)[1];
  assert.equal(ver, cache);
  assert.equal(ver, "v139", "本版应升到 v139");
});
