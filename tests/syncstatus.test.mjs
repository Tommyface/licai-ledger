/* 同步状态显示口径（v46）：
     node --test tests/syncstatus.test.mjs
   界面文案本身不重要，重要的是「什么时候必须说没推上去」。这几条测试锁的是
   会骗人的那几种组合，而不是字数。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { relAge, ago, syncBadge, syncLine,
       fetchFailKind, fetchAlertHeading } from "../js/domain/syncstatus.js";

const NOW = 1_800_000_000_000;   /* 固定基准，避免测试跟着真实时钟漂 */

test("relAge 的量级边界", () => {
  assert.equal(relAge(0), "刚刚");
  assert.equal(relAge(3000), "刚刚");
  assert.equal(relAge(4000), "4 秒");
  assert.equal(relAge(59_999), "59 秒");
  assert.equal(relAge(60_000), "1 分");
  assert.equal(relAge(3_600_000), "1 小时");
  assert.equal(relAge(86_400_000), "1 天");
  assert.equal(relAge(-5000), "刚刚");   /* 时钟回拨不该显示「-5 秒」 */
});

test("ago：刚刚不加「前」，其余加", () => {
  assert.equal(ago(1000), "刚刚");
  assert.equal(ago(30_000), "30 秒前");
  assert.equal(ago(120_000), "2 分前");
});

test("顶栏：未配置就只说未连接", () => {
  assert.deepEqual(syncBadge({ cfgOk: false, now: NOW }), { text: "未连接", cls: "" });
  /* 没配置时哪怕有 dirtyAt 也不该报「待推送」——推不上去的原因是没连接，
     报待推送会让人去点一个必然失败的按钮 */
  assert.equal(syncBadge({ cfgOk: false, dirtyAt: NOW - 1000, now: NOW }).text, "未连接");
});

test("顶栏：有改动待推送时报 warn，并带上多久没推", () => {
  const b = syncBadge({ cfgOk: true, dirtyAt: NOW - 40_000, pushAt: NOW - 3_600_000, now: NOW });
  assert.deepEqual(b, { text: "待推送 · 40 秒前", cls: "warn" });
});

test("顶栏：dirtyAt 与 pushAt 同时存在时一律报未推送（安全口径）", () => {
  /* 正常时序是推成功后又改了一笔（dirtyAt 更新）；
     反常时序（pushAt 反而更新）也必须报未推送：把「已同步」显示错等于
     放用户去卸载，把「待推送」显示错只是多点一次按钮。 */
  assert.equal(syncBadge({ cfgOk: true, dirtyAt: NOW - 5000, pushAt: NOW - 1000, now: NOW }).cls, "warn");
  assert.match(syncBadge({ cfgOk: true, dirtyAt: NOW - 5000, pushAt: NOW - 1000, now: NOW }).text, /^待推送/);
});

test("顶栏：失败过就不报中性的待推送", () => {
  const b = syncBadge({ cfgOk: true, dirtyAt: NOW - 60_000, err: "HTTP 409", now: NOW });
  assert.deepEqual(b, { text: "推送失败", cls: "bad" });
});

test("顶栏：干净时报最近一次成功推送", () => {
  assert.deepEqual(syncBadge({ cfgOk: true, pushAt: NOW - 7_200_000, now: NOW }),
    { text: "已同步 · 2 小时前", cls: "ok" });
  /* 刚配好、一次都没推过：不要谎报「已同步」 */
  assert.deepEqual(syncBadge({ cfgOk: true, now: NOW }), { text: "已连接", cls: "" });
});

test("设置页：待推送且没失败 → 明确告诉用户不用管", () => {
  const s = syncLine({ cfgOk: true, dirtyAt: NOW - 30_000, now: NOW });
  assert.match(s, /还没推上去/);
  assert.match(s, /不用管/);
  assert.doesNotMatch(s, /失败/);
});

test("设置页：重试排期中要给出时间与第几次", () => {
  const s = syncLine({ cfgOk: true, dirtyAt: NOW - 20_000, err: "HTTP 502", nextAt: NOW + 15_000, retryN: 1, maxRetry: 3, now: NOW });
  assert.match(s, /HTTP 502/);
  assert.match(s, /15 秒后自动重试/);
  /* retryN 已经是「排期中这一发的序号」（scheduleRetry 先自增再排期），不许再 +1 */
  assert.match(s, /第 1\/3 次/);
});

test("设置页：自动重试用完必须交出主动权，不许继续演「马上就好」", () => {
  const s = syncLine({ cfgOk: true, dirtyAt: NOW - 600_000, err: "HTTP 401", retryN: 3, maxRetry: 3, now: NOW });
  assert.match(s, /自动重试已用完/);
  assert.match(s, /推送到云端/);
  assert.doesNotMatch(s, /后自动重试/);
});

test("设置页：本机已干净时说清最后一次成功推送", () => {
  assert.match(syncLine({ cfgOk: true, pushAt: NOW - 120_000, now: NOW }), /都已推上去了（最后一次推送：2 分前）/);
  assert.match(syncLine({ cfgOk: true, now: NOW }), /这次运行还没推过/);
});

/* ============================================================
   v84 · 抓取失败的原因分类（铁律 #10：被拦下 ≠ 没有数据）

   背景（交接文档 §10 #14）：v3.1 上了两道闸门之后，「这轮没入账」出现了三种
   完全不同的原因——披露源风控拦下、自家份额类别闸门拒取、真的还没披露。
   告警条原来只有一句「有 N 只产品没拿到净值」，把前两种也说成「没拿到」，
   看的人就会去做错的动作：反复点立即抓取，或者去改本来填对了的字段。
   这里锁的是**口径不许混**，不是字数。
   ============================================================ */
test("分类：风控拦下算 blocked，不许和「没数据」混", () => {
  assert.equal(fetchFailKind("农银匠心 — 中国理财网：中国理财网本轮被风控拦下（验证失败）——是访问被限制，不是这个产品没有数据"), "blocked");
  assert.equal(fetchFailKind("某只 — 请求过于频繁，已被受限拦截"), "blocked");
  assert.equal(fetchFailKind("某只 — 安全校验未通过"), "blocked");
});

test("分类：份额类别闸门拒取算 refused，文案与风控不互串", () => {
  const line = "某只 — 中国理财网：份额类别对不上：账本记的是 A，理财网该编码下的份额行是 ['B'] —— 宁可不填";
  assert.equal(fetchFailKind(line), "refused");
  assert.notEqual(fetchFailKind(line), "blocked");
});

test("分类：认不出来的原因一律退回 missing，不许凭好意升级", () => {
  assert.equal(fetchFailKind("某只 — 未取到净值"), "missing");
  assert.equal(fetchFailKind(""), "missing");
  assert.equal(fetchFailKind(undefined), "missing");
  assert.equal(fetchFailKind(null), "missing");
});

test("分类：一行里两种原因都有时先判闸门拒取（那是我们自己拦的，说了才可行动）", () => {
  const line = "某只 — 中国理财网：份额类别对不上：账本记的是 A，理财网该编码下的份额行是 ['B'] —— 宁可不填；徽银官网：请求过于频繁已被拦截";
  assert.equal(fetchFailKind(line), "refused");
  assert.doesNotMatch(fetchAlertHeading({ fail: 1, items: [line] }), /被披露源拦下/,
    "把自家闸门说成源端风控，用户就会去等解封而不是去核对代码");
});

test("标题：全是被拦下时，必须说「不是没有净值」，不许说「没拿到」", () => {
  const lf = { fail: 2, items: ["a — 中国理财网本轮被风控拦下（验证失败）", "b — 触发受限拦截"] };
  const h = fetchAlertHeading(lf);
  assert.match(h, /被.{0,4}拦下/);
  assert.match(h, /不是.*没有净值/);
  assert.doesNotMatch(h, /没拿到净值/, "被拦下不等于没披露，标题不许这么说");
});

test("标题：全是闸门拒取时，要说清「宁可不填」并指向核对", () => {
  const lf = { fail: 1, items: ["a — 份额类别对不上：账本记的是 A，理财网该编码下的份额行是 ['B'] —— 宁可不填"] };
  const h = fetchAlertHeading(lf);
  assert.match(h, /类别对不上/);
  assert.doesNotMatch(h, /拦下/, "自家闸门不是披露源风控，别让用户去等解封");
});

test("标题：混合时分开报数，剩下的照实说没拿到", () => {
  const lf = { fail: 3, items: ["a — 风控拦下（验证失败）", "b — 份额类别对不上：宁可不填", "c — 未取到净值"] };
  const h = fetchAlertHeading(lf);
  assert.match(h, /1 只.*(被.*拦下|拦下)/);
  assert.match(h, /类别对不上/);
  assert.match(h, /1 只.*(没拿到|没披露)/);
});

test("标题：fail 比 items 多（items 只留前 20 条）时，未分类的那部分不许算进被拦", () => {
  const lf = { fail: 5, items: ["a — 风控拦下（验证失败）"] };
  const h = fetchAlertHeading(lf);
  assert.match(h, /1 只.*拦下/);
  assert.match(h, /4 只.*(没拿到|没披露|原因不详)/);
  assert.doesNotMatch(h, /5 只是请求被披露源拦下/);
});

test("标题：items 空或缺失时退回旧文案，不凭空分类", () => {
  assert.match(fetchAlertHeading({ fail: 2, items: [] }), /有 2 只产品没拿到净值/);
  assert.match(fetchAlertHeading({ fail: 2 }), /有 2 只产品没拿到净值/);
  assert.match(fetchAlertHeading({ fail: 0, items: ["a — 风控拦下"] }), /$/);
});

test("标题：本机 / 云端两个写入方要分清（lastFetch.source）", () => {
  assert.match(fetchAlertHeading({ fail: 1, source: "app", items: ["a — 未取到净值"] }), /^本机抓取/);
  assert.match(fetchAlertHeading({ fail: 1, items: ["a — 未取到净值"] }), /^云端抓取/);
});
