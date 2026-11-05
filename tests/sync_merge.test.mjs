/* 整文件同步合并语义回归测试：node --test tests/sync_merge.test.mjs
   守的是「推送把另一台设备的数据删了」——GitHub Contents PUT 是整文件替换，
   payload 少一块，云端就少一块，而且不报错。逐条对应 js/domain/sync.js 的规则：
     · 云端独有的产品 / 交易必须保留（v43 之前会被整只删掉）
     · 净值只补本地没有的日期，同日冲突保留本地
     · 档案字段本地为空才用远端（抓取回填的 orgName 不被旧快照抹掉）
     · 墓碑并集有效期间不复活，过期后不再屏蔽
     · 不修改传入的本地数据（静默推送不能动本地账面） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeForPush, PUSH_TOMB_DAYS } from "../js/domain/sync.js";

const now = 1_800_000_000_000;          // 固定时钟，墓碑有效期才可复现
const DAY = 86_400_000;

/** @param {any[]} prods @param {any[]} trades */
const local = (prods, trades = [], settings = {}) =>
  ({ products: prods, trades, settings });
const prod = (id, extra = {}) => ({ id, name: "产品" + id, navHistory: {}, ...extra });

test("云端独有的产品与交易不会被这次推送删掉", () => {
  const l = local([prod("p1")], [{ id: "t1", prodId: "p1" }]);
  const r = local([prod("p1"), prod("p2", { prodCode: "25112035B" })],
    [{ id: "t1", prodId: "p1" }, { id: "t2", prodId: "p2", side: "buy" }]);
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.deepEqual(payload.products.map(p => p.id), ["p1", "p2"]);
  assert.deepEqual(payload.trades.map(t => t.id), ["t1", "t2"]);
  assert.equal(stats.products, 1);
  assert.equal(stats.trades, 1);
  assert.equal(payload.products[1].prodCode, "25112035B", "独有产品整只带上，含它的档案字段");
});

test("同 id 产品：只补本地没有的净值日期，同日冲突保留本地", () => {
  const l = local([prod("p1", { navHistory: { "2026-10-28": 1.01, "2026-10-29": 9.99 } })]);
  const r = local([prod("p1", { navHistory: { "2026-10-29": 1.02, "2026-10-30": 1.03 } })]);
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.deepEqual(payload.products[0].navHistory, {
    "2026-10-28": 1.01, "2026-10-29": 9.99, "2026-10-30": 1.03,
  }, "9.99 是用户手工补录的值，必须留住");
  assert.equal(stats.navs, 1, "只算真正补进来的那一天");
});

test("档案字段：本地为空才用远端，已有值不覆盖", () => {
  const l = local([prod("p1", { orgName: "", tags: [], nav: 1 })]);
  const r = local([prod("p1", { orgName: "招银理财", tags: ["稳健"], nav: 2, maturity: "2027-01-01" })]);
  const { payload, stats } = mergeForPush(l, r, { now });
  const p = payload.products[0];
  assert.equal(p.orgName, "招银理财");
  assert.deepEqual(p.tags, ["稳健"]);
  assert.equal(p.maturity, "2027-01-01", "本地没有的键直接带上");
  assert.equal(p.nav, 1, "本地有值（哪怕是数字 1）不被远端改写");
  assert.equal(stats.fields, 3);
});

test("墓碑：本机删过的云端条目不复活，远端墓碑并集一起上传", () => {
  const l = local([prod("p1")], [], {});
  l.tomb = { products: { p2: now }, trades: { t9: now }, navs: {} };
  const r = local([prod("p1"), prod("p2")], [{ id: "t9", prodId: "p2" }]);
  r.tomb = { products: {}, trades: {}, navs: { "p1|2026-10-30": now - DAY } };
  const { payload } = mergeForPush(l, r, { now });
  assert.deepEqual(payload.products.map(p => p.id), ["p1"], "p2 被别的设备删过");
  assert.deepEqual(payload.trades, [], "t9 同样不复活");
  assert.ok(payload.tomb.navs["p1|2026-10-30"], "远端墓碑要随本次 PUT 带回去，否则下次拉取会复活");
});

test("墓碑：净值日期被屏蔽的那天不从云端补回", () => {
  const l = local([prod("p1", { navHistory: {} })]);
  l.tomb = { products: {}, trades: {}, navs: { "p1|2026-10-29": now } };
  const r = local([prod("p1", { navHistory: { "2026-10-29": 1.02, "2026-10-30": 1.03 } })]);
  const { payload } = mergeForPush(l, r, { now });
  assert.deepEqual(payload.products[0].navHistory, { "2026-10-30": 1.03 });
});

test("墓碑：过期后不再屏蔽（同一天的真值以后还能收进来）", () => {
  const stale = now - (PUSH_TOMB_DAYS + 1) * DAY;
  const l = local([prod("p1")]);
  l.tomb = { products: { p2: stale }, trades: {}, navs: {} };
  const r = local([prod("p1"), prod("p2")]);
  const { payload } = mergeForPush(l, r, { now });
  assert.deepEqual(payload.products.map(p => p.id), ["p1", "p2"]);
});

test("settings：抓取脚本字段取更新的一份，其余保留本地", () => {
  const l = local([prod("p1")], [], {
    lastNavSync: { time: "2026-10-29 16:00 UTC" }, syncPath: "licai-data.json",
  });
  const r = local([prod("p1")], [], {
    lastNavSync: { time: "2026-10-30 01:00 UTC" },
    lastFetch: { time: "2026-10-30 01:00 UTC", products: { p1: "ok" } },
    syncPath: "elsewhere.json",
  });
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.equal(payload.settings.lastNavSync.time, "2026-10-30 01:00 UTC");
  assert.equal(payload.settings.lastFetch.products.p1, "ok", "云端抓取摘要不能丢");
  assert.equal(payload.settings.syncPath, "licai-data.json", "非抓取字段以本地为准");
  assert.equal(stats.settings, 2);
});

test("settings：本地更新时保留本地（云端时间旧不能被带回）", () => {
  const l = local([prod("p1")], [], { lastNavSync: { time: "2026-10-30 08:00 UTC" } });
  const r = local([prod("p1")], [], { lastNavSync: { time: "2026-10-29 16:00 UTC" } });
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.equal(payload.settings.lastNavSync.time, "2026-10-30 08:00 UTC");
  assert.equal(stats.settings, 0);
});

test("远端读不到（{} / null）时按纯本地推送，内容等价于本地副本", () => {
  const l = local([prod("p1", { navHistory: { "2026-10-29": 1.02 } })], [{ id: "t1" }]);
  for (const r of [{}, null, undefined]) {
    const { payload, stats } = mergeForPush(l, r, { now });
    assert.deepEqual(payload.products, l.products);
    assert.deepEqual(payload.trades, l.trades);
    assert.deepEqual(stats, { products: 0, trades: 0, navs: 0, fields: 0, settings: 0 });
  }
});

test("不修改传入的本地数据，也不共用引用", () => {
  const l = local([prod("p1", { navHistory: { "2026-10-28": 1.01 } })]);
  const snapshot = JSON.parse(JSON.stringify(l));
  const r = local([prod("p1", { navHistory: { "2026-10-29": 1.02 } }), prod("p2")],
    [{ id: "t2" }]);
  const { payload } = mergeForPush(l, r, { now });
  assert.deepEqual(l, snapshot, "静默推送不能改动本地账面（DIRTY 语义依赖这一点）");
  payload.products[0].navHistory["2026-10-28"] = 5.5;
  payload.products[1].name = "改过了";
  assert.deepEqual(l, snapshot, "payload 与 local 必须是深拷贝，不共用对象");
});

test("云端产品的 id 类型与本地不同（字符串 / 数字）也能对上同一个产品", () => {
  const l = local([{ id: 7, name: "A", navHistory: { "2026-10-28": 1.01 } }]);
  const r = local([{ id: "7", name: "A", navHistory: { "2026-10-29": 1.02 } }]);
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.equal(payload.products.length, 1, "不能因为 id 类型不同就复制成两只");
  assert.deepEqual(payload.products[0].navHistory, { "2026-10-28": 1.01, "2026-10-29": 1.02 });
  assert.equal(stats.products, 0);
});

test("云端或本地字段形状被改坏（对象当数组用）也不炸、不脏写", () => {
  const l = { products: "不是数组", trades: null, settings: [],
             tomb: { products: { p2: now } } };
  const r = { products: { p9: prod("p9") }, trades: "no", settings: "no",
              tomb: "no" };
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.deepEqual(payload.products, [], "本地坏了就按空产品推，不抛出 undefined.map");
  assert.deepEqual(payload.trades, []);
  assert.deepEqual(payload.settings, {});
  assert.deepEqual(stats, { products: 0, trades: 0, navs: 0, fields: 0, settings: 0 });
  const l2 = local([prod("p1", { navHistory: "坏" })]);
  const r2 = local([prod("p1", { navHistory: { "2026-10-29": 1.02 } })]);
  const out = mergeForPush(l2, r2, { now });
  assert.deepEqual(out.payload.products[0].navHistory, { "2026-10-29": 1.02 },
    "本地 navHistory 被写坏时换成真对象再补，别把字符串留在文件里");
});

/* ---------- 第 4 步（v81）：disc 单独判，不套「规则 5：只填空白」 ----------
   disc 是对象类型，用「只填空值」会两头误判：本地 normDisc 生成的全空骨架
   也是非空对象，会把云端回填的真值挡在门外；反过来本地 auto 值又会盖掉
   别台设备手工录的 manual 值。口径全复用 disc.js 的 normDisc/discHasContent。 */
const D_SRC = { url: "https://x.example.com/disc.pdf", publishedAt: "2026-01-01", tier: "official" };
const dOf = (status, body = {}) => Object.assign({
  status, lockDays: null, openRule: "", feeRedeem: [], assets: [], investScope: "", source: D_SRC,
}, body);
const dp = (id, d) => prod(id, { disc: d });

test("disc 合并：本地手工录入绝对优先，远端无论什么形状都不盖", () => {
  const l = local([dp("p1", dOf("manual", { lockDays: 180 }))]);
  const r = local([dp("p1", dOf("auto", { lockDays: 7 }))]);
  const { payload } = mergeForPush(l, r, { now });
  assert.equal(payload.products[0].disc.lockDays, 180);
  assert.equal(payload.products[0].disc.status, "manual");
});

test("disc 合并：远端是别台设备手工录的，盖过本地 auto / none", () => {
  const l = local([dp("p1", dOf("auto", { lockDays: 7 }))]);
  const r = local([dp("p1", dOf("manual", { lockDays: 180 }))]);
  const { payload } = mergeForPush(l, r, { now });
  assert.equal(payload.products[0].disc.status, "manual");
  assert.equal(payload.products[0].disc.lockDays, 180);
});

test("disc 合并：本地只是全空骨架且远端有内容才取远端", () => {
  const l = local([dp("p1", dOf("none"))]);
  const r = local([dp("p1", dOf("auto", { lockDays: 7, openRule: "每周二" }))]);
  const { payload, stats } = mergeForPush(l, r, { now });
  assert.equal(payload.products[0].disc.lockDays, 7, "全空骨架不该把云端回填的真值挡在门外");
  assert.equal(payload.products[0].disc.openRule, "每周二");
  assert.ok(stats.fields >= 1);
});

test("disc 合并：本地已有 auto 内容、远端也是 auto 时不互相覆盖", () => {
  const l = local([dp("p1", dOf("auto", { lockDays: 30 }))]);
  const r = local([dp("p1", dOf("auto", { lockDays: 7 }))]);
  const { payload } = mergeForPush(l, r, { now });
  assert.equal(payload.products[0].disc.lockDays, 30, "同档按本地为准，不做「谁新谁赢」的猜判");
});

test("disc 合并：远端只有全空骨架，不许把本地已有内容顶掉", () => {
  const l = local([dp("p1", dOf("auto", { lockDays: 7 }))]);
  const r = local([dp("p1", dOf("none"))]);
  const { payload } = mergeForPush(l, r, { now });
  assert.equal(payload.products[0].disc.lockDays, 7);
});

test("disc 合并：普通档案字段仍按规则 5 只填空白，不受 disc 特判影响", () => {
  const l = local([prod("p1", { orgName: "", disc: dOf("none") })]);
  const r = local([prod("p1", { orgName: "招银理财", disc: dOf("none") })]);
  const { payload } = mergeForPush(l, r, { now });
  assert.equal(payload.products[0].orgName, "招银理财");
});

test("disc 合并：不修改传入的本地数据对象", () => {
  const l = local([dp("p1", dOf("none"))]);
  const snap = JSON.stringify(l);
  mergeForPush(l, local([dp("p1", dOf("auto", { lockDays: 7 }))]), { now });
  assert.equal(JSON.stringify(l), snap);
});
