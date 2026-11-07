/* v95 提醒工程的统一判断口径测试：node --test tests/nav.test.mjs
   app.js 的 notifyNewNav 只管投递，去重（B1）/阈值（B1）/免打扰窗口（B2）的
   判断全部收口在 js/domain/nav.js —— 这里钉住的就是这层口径：
     · 去重键 = 产品id@披露日，同一条净值只提醒一次；
     · 阈值开关默认关；开了以后 |日环比| < 阈值被压掉；日环比算不出来（null
       是不知道）照样提醒 —— 压掉一条通知等于断言「变动不大」，不知道就不能断言；
     · 免打扰默认开、窗口 00:00–07:00（B3 复核后的默认档，唯一出处
       NOTIFY_DEFAULTS），支持跨零点。
   另外钉住 app.js 的接线：notifyNewNav 吃的是 newNavItems 的产物、去重集随
   saveNotify 持久化、内联 handler 挂回 window。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTIFY_DEFAULTS, navNotifyKey, inQuietWindow, passesThreshold,
  newNavItems, filterNavNotify,
} from "../js/domain/nav.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

const P = (navHistory, id = "p1", name = "匠心") => ({ id, name, navHistory });
const at = (h, m = 0) => { const d = new Date(2026, 10, 7, h, m); return d; };

test("B1 去重键：产品id@披露日，同键只被 filterNavNotify 发一次", () => {
  assert.equal(navNotifyKey("p1", "2026-11-06"), "p1@2026-11-06");
  const items = [{ id: "p1", name: "A", date: "2026-11-06", pct: 0.01 }, { id: "p2", name: "B", date: "2026-11-06", pct: 0.02 }];
  const seen = { "p1@2026-11-06": true };
  const r = filterNavNotify(items, seen, { threshOn: false });
  assert.equal(r.send.length, 1);
  assert.equal(r.send[0].id, "p2");
  /* 两条都见过 → 一条都不发 */
  seen["p2@2026-11-06"] = true;
  assert.equal(filterNavNotify(items, seen, { threshOn: false }).send.length, 0);
});

test("B1 阈值：默认关全放行；开了按 |日环比| 压；null 环比（不知道）照样提醒", () => {
  assert.equal(passesThreshold(0.01, { threshOn: false, thresh: 0.5 }), true);
  assert.equal(passesThreshold(0.01, { threshOn: true, thresh: 0.5 }), false);
  assert.equal(passesThreshold(-0.5, { threshOn: true, thresh: 0.5 }), true);
  assert.equal(passesThreshold(null, { threshOn: true, thresh: 0.5 }), true);
  assert.equal(passesThreshold(3, { threshOn: true, thresh: Number.NaN }), true);
  const items = [{ id: "p1", name: "A", date: "2026-11-06", pct: 0.01 }, { id: "p2", name: "B", date: "2026-11-06", pct: null }];
  const r = filterNavNotify(items, {}, { threshOn: true, thresh: 0.5 });
  assert.equal(r.send.length, 1); assert.equal(r.send[0].id, "p2");
  assert.equal(r.below.length, 1); assert.equal(r.below[0].id, "p1");
});

test("B1 newNavItems：只取晚于基准日的净值，环比对着前一日算，首条/除零给 null", () => {
  const p = P({ "2026-11-04": 1.02, "2026-11-05": 1.0302, "2026-11-06": 1.0312 });
  const items = newNavItems([p], "2026-11-04");
  assert.deepEqual(items.map(i => i.date), ["2026-11-05", "2026-11-06"]);
  assert.ok(Math.abs(items[0].pct - 1) < 1e-9);
  assert.ok(Math.abs(items[1].pct - 0.0970685) < 1e-6);
  /* 基准日之前全跳过 */
  assert.equal(newNavItems([p], "2026-11-06").length, 0);
  /* 新产品回填的第一条历史没有前一日 → pct=null（不是 0） */
  const first = newNavItems([P({ "2026-11-06": 1.05 })], "2026-11-04");
  assert.equal(first[0].pct, null);
  /* 前一日净值为 0：除零 → null，不是 Infinity 冒充数据 */
  const zero = newNavItems([P({ "2026-11-05": 0, "2026-11-06": 1.05 })], "2026-11-04");
  assert.equal(zero[1].pct, null);
  /* 多产品按披露日排序 */
  const two = newNavItems([P({ "2026-11-06": 1.1 }, "p2"), P({ "2026-11-05": 1.2 }, "p1")], "2026-11-04");
  assert.deepEqual(two.map(i => i.date), ["2026-11-05", "2026-11-06"]);
});

test("B2 免打扰窗口：默认 00:00–07:00 含头不含尾，支持跨零点，开关关了不拦", () => {
  const on = { quietOn: true, quietStart: 0, quietEnd: 7 };
  /* 窗口 00:00–07:00：夜里在窗口内，23 点不在（默认窗口不跨零点） */
  assert.equal(inQuietWindow(on, at(23)), false);
  assert.equal(inQuietWindow(on, at(0)), true);
  assert.equal(inQuietWindow(on, at(6, 59)), true);
  assert.equal(inQuietWindow(on, at(7)), false);
  assert.equal(inQuietWindow(on, at(12)), false);
  /* 跨零点：22–7 */
  const wrap = { quietOn: true, quietStart: 22, quietEnd: 7 };
  assert.equal(inQuietWindow(wrap, at(23)), true);
  assert.equal(inQuietWindow(wrap, at(6)), true);
  assert.equal(inQuietWindow(wrap, at(12)), false);
  assert.equal(inQuietWindow({ ...on, quietOn: false }, at(3)), false);
  /* start == end 视为没配窗口，不拦（宁可多提醒也不静默一整天） */
  assert.equal(inQuietWindow({ quietOn: true, quietStart: 7, quietEnd: 7 }, at(7)), false);
});

test("B3 默认档唯一出处：NOTIFY_DEFAULTS = 免打扰开 00:00–07:00、阈值关；app.js 初值从这里拷贝", () => {
  assert.deepEqual(NOTIFY_DEFAULTS, { quietOn: true, quietStart: 0, quietEnd: 7, threshOn: false, thresh: 0.5 });
  const app = read("app.js");
  assert.ok(app.includes("Object.assign({ on: false, lastCheck: 0, seen: {}, muted: 0 }, NOTIFY_DEFAULTS)"),
    "NOTIFY 初值必须以 NOTIFY_DEFAULTS 为底，不能另抄一份默认档");
});

test("app.js 接线：notifyNewNav 吃 newNavItems、seen 随 saveNotify 持久化、四个新 handler 挂回 window", () => {
  const app = read("app.js");
  assert.ok(app.includes("notifyNewNav(newNavItems(DATA.products, before.latest))"),
    "syncPull 必须把 newNavItems 的产物交给 notifyNewNav（条数差会丢产品维度）");
  assert.ok(!app.includes("function navDeltaSince"), "旧的总条数差算法已收口进 nav.js，不允许留第二份判断");
  assert.ok(app.includes("thresh: Number(NOTIFY.thresh),\n      seen: NOTIFY.seen || {}"), "seen/阈值必须持久化，否则重启后同一净值会再提醒一次");
  assert.ok(app.includes("NOTIFY.muted = (Number(NOTIFY.muted) || 0) + r.send.length"), "免打扰静默必须留下诚实计数");
  for (const h of ["setNotifyQuiet", "setNotifyThresh", "setNotifyThreshVal", "clearNotifyMuted"]) {
    assert.ok(app.includes(h + ",") || app.includes(h + "\n") || new RegExp("\\b" + h + "\\b").test(app), h + " 必须定义");
  }
  assert.ok(/setNotifyQuiet, setNotifyThresh, setNotifyThreshVal, clearNotifyMuted/.test(app),
    "四个新 handler 必须全部挂回 window（内联 onchange 靠全局查找）");
});
