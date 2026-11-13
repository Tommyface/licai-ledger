/* v132 专项回归：建行/建信系「参考剩余额度」接入银行轨。
   线索（用户 2026-11-12）：lsjr.ccb.com 产品页能看剩余额度。实测该页是
   Vue SPA + 加密网关（A0321DQ11 的 reqData 是 AES 密文），不适合程序化抓；
   但私有仓 banks/ccb.py 一直在抓的免登录明文在售清单 NLCQ11 回包
   PROD_INFO_GRP 本来就带 SplLmt（元，<0 不限额度）与 PD_Cnd，与页面同源同字段。
   v132 把这份额度挂进 monitor-bank 回包，网页层单一判据格式化后展示。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ccbQuotaText, monitorRows, validateBankRows, bankQuotaNotifyBody } from "../js/core/quota.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const quota = readFileSync(new URL("../js/core/quota.js", import.meta.url), "utf8");
const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const CCB_ROW = {
  code: "Z7001126000218", name: "嘉鑫稳利固收最低持有7天第39期", nav: 1.0156,
  navDate: "2026-11-12", changed: true, err: "",
  quota: 92776168588.08, quotaSource: "ccb", quotaFrom: "JXJXZDCY7D0227039",
  saleCond: "0010010",
};
const PLAIN_ROW = {
  code: "Z7001425000885", name: "贵竹固收稳利日开5号P", nav: 1.0154,
  navDate: "2026-11-12", changed: false, err: "",
};

test("ccbQuotaText：与建行页面 setSplLmtDQ11 同判据（元）", () => {
  assert.equal(ccbQuotaText(92776168588.08), "大于1000万", "真源实测值");
  assert.equal(ccbQuotaText(1e7 + 1), "大于1000万", "严格大于 1000 万");
  assert.equal(ccbQuotaText(50000), "5万元", "万元档取整");
  assert.equal(ccbQuotaText(12345), "1万元");
  assert.equal(ccbQuotaText(10000), "10000元", "等于 1 万仍走元档");
  assert.equal(ccbQuotaText(1234), "1234元");
  assert.equal(ccbQuotaText(0), "0元");
  assert.equal(ccbQuotaText(-1), "不限额度", "SplLmt 负值口径");
  assert.equal(ccbQuotaText(null), "—", "缺失不伪装成 0");
  assert.equal(ccbQuotaText(""), "—");
  assert.equal(ccbQuotaText("abc"), "—");
});

test("monitorRows：建行额度行换额度口径，普通披露行维持净值口径", () => {
  const pool = [
    { name: "嘉鑫稳利固收最低持有7天第39期", inst: "建信理财", regCode: "Z7001126000218" },
    { name: "贵竹固收稳利日开5号P", inst: "民生理财", regCode: "Z7001425000885" },
  ];
  const snap = { ok: true, rows: [CCB_ROW, PLAIN_ROW] };
  const rows = monitorRows(pool, null, [], [{ code: "Z7001126000218", org: "jxwm" },
                                            { code: "Z7001425000885", org: "cmbc" }], snap);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].channel, "bank");
  assert.equal(rows[0].quotaText, "大于1000万", "右侧主值换成额度文案");
  assert.match(rows[0].quotaLabel, /参考剩余额度/);
  assert.equal(rows[0].quotaSource, "ccb");
  assert.equal(rows[0].quotaFrom, "JXJXZDCY7D0227039", "额度来源可追溯");
  assert.match(rows[0].statusText, /最新披露净值/, "披露文案不被额度覆盖");
  assert.equal(rows[1].quotaText, "1.0154", "无额度维持披露净值");
  assert.equal(rows[1].quotaLabel, "最新披露净值");
  assert.equal(rows[1].quotaSource, "");
  assert.equal(rows[1].quotaFrom, "");
});

test("validateBankRows：quota 只许有限数值/null，溯源字段只许字符串，旧包照收", () => {
  const pack = r => ({ ok: true, rows: [r] });
  assert.equal(validateBankRows(pack(CCB_ROW)).ok, true);
  assert.equal(validateBankRows(pack(PLAIN_ROW)).ok, true, "其他银行无 quota 字段合法");
  assert.equal(validateBankRows(pack({ ...CCB_ROW, quota: null })).ok, true, "null 表示暂无额度数据");
  assert.equal(validateBankRows(pack({ ...CCB_ROW, quota: -1 })).ok, true, "不限额度是负数");
  assert.equal(validateBankRows(pack({ ...CCB_ROW, quota: "abc" })).ok, false, "非数值额度拒收");
  assert.equal(validateBankRows(pack({ ...CCB_ROW, quotaSource: "webank" })).ok, false, "伪来源拒收");
  assert.equal(validateBankRows(pack({ ...CCB_ROW, quotaFrom: 123 })).ok, false, "溯源字段非字符串拒收");
  assert.equal(validateBankRows(pack({ ...CCB_ROW, quotaErr: {} })).ok, false);
});

test("版本钉：APP_VER / CACHE 同步 v133", () => {
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, "v133");
  assert.equal(cache, "v133");
  assert.equal(ver, cache);
});

test("v132 接线：渲染层用 quotaLabel + 建行清单角标，两处测试清单都登记", () => {
  assert.match(quota, /export function ccbQuotaText\(/, "格式化纯函数单点");
  assert.match(app, /quotaLabel/, "右侧标签取自行数据");
  assert.match(app, /建行清单/, "绿色角标");
  assert.match(app, /额度清单/, "额度来源可追溯展示");
  assert.match(html, /参考剩余额度/, "③ 段口径说明");
  assert.match(html, /建行清单/);
  assert.match(html, /额度数值有变化也会推一条系统通知/, "③ 段写明额度变化会通知");
  assert.match(pkg, /ccb_quota_v132\.test\.mjs/, "npm test 登记");
  assert.match(ci, /ccb_quota_v132\.test\.mjs/, "CI 登记（漏一个等于该链路只在本地跑过）");
});

/* 私有仓契约：公开仓 CI 只 checkout licai-ledger，双仓同检出时才全量断言
   （守卫先例见 app_core.test.mjs / monitor_v131.test.mjs）。 */
test("v132 私有仓契约：额度字段入索引 + 银行轨挂载 + Java 原样透传", () => {
  const ccbPath = new URL("../../data24/navsources/banks/ccb.py", import.meta.url);
  if (!existsSync(ccbPath)) return;              // licai-ledger 单独检出时无私有仓
  const ccb = readFileSync(ccbPath, "utf8");
  for (const s of ["SplLmt", "PD_Cnd", "def ccb_quota_lookup(", '"quota": spl']) {
    assert.ok(ccb.includes(s), "ccb.py 缺锚点: " + s);
  }
  const mb = readFileSync(new URL("../../data24/navsources/monitor_bank.py", import.meta.url), "utf8");
  for (const s of ["_is_ccb_product", "_attach_ccb_quota", "ccb_quota_lookup",
                   'row["quotaSource"] = "ccb"', "quotaErr"]) {
    assert.ok(mb.includes(s), "monitor_bank.py 缺锚点: " + s);
  }
  assert.doesNotMatch(mb, /大于1000万|万元/, "Python 不写第二份格式化口径");
  const ctl = readFileSync(new URL(
    "../../data24/android/app/src/main/java/me/glorywork/licailedger/MonitorCtl.java",
    import.meta.url), "utf8");
  assert.match(ctl, /String kept = out/, "Java 原样落 Python 回包，新字段自动透传");
});

/* ═══════ v132 补充（用户 2026-11-13）：参考剩余额度「只要有变化就触发通知」═══════
   判定单点在 Python，Java 只消费标记 + 存基线 + 发通知；网页层只负责回包整包
   校验与同口径通知正文（系统通知由 Java 发，这里保留纯函数供口径对照）。 */

test("bankQuotaNotifyBody：额度变化通知正文（旧→新精确值，增减都如实）", () => {
  const body = bankQuotaNotifyBody("嘉鑫稳利固收最低持有7天第39期", "Z7001126000218",
    92776168588.08, 92776207109.38, "2026-11-13 07:30:00");
  assert.match(body, /参考剩余额度变化：92,776,168,588\.08 元 → 92,776,207,109\.38 元/);
  assert.match(body, /检查时间：2026-11-13 07:30:00/);
  assert.match(body, /NLCQ11/, "注明数据源");
  assert.match(body, /非实时可购额度/, "如实口径不省略");
  /* 不限额度（SplLmt 负值）与缺失都不伪装成 0 */
  assert.match(bankQuotaNotifyBody("x", "Z1", -1, 50000, "t"), /不限额度 → 50,000\.00 元/);
  assert.match(bankQuotaNotifyBody("x", "Z1", null, 50000, "t"), /— → 50,000\.00 元/);
  /* 减少也照实写（不设方向） */
  assert.match(bankQuotaNotifyBody("x", "Z1", 50000, 1234, "t"), /50,000\.00 元 → 1,234\.00 元/);
});

test("validateBankRows：额度变化标记整包校验（坏包不许发空通知）", () => {
  const pack = r => ({ ok: true, rows: [r] });
  const base = { ...CCB_ROW };
  assert.equal(validateBankRows(pack({ ...base, quotaChanged: false })).ok, true, "显式 false 合法");
  assert.equal(validateBankRows(pack({ ...base, quotaChanged: true,
    quotaPrev: 92776207109.38 })).ok, true, "变化包合法（旧值 ≠ 现值）");
  assert.equal(validateBankRows(pack(PLAIN_ROW)).ok, true, "旧包无该字段合法");
  assert.equal(validateBankRows(pack({ ...base, quotaChanged: "true" })).ok, false, "非布尔拒收");
  assert.equal(validateBankRows(pack({ ...base, quotaChanged: true })).ok, false, "缺 quotaPrev 拒收");
  assert.equal(validateBankRows(pack({ ...base, quotaChanged: true, quotaPrev: "abc" })).ok, false);
  assert.equal(validateBankRows(pack({ ...base, quotaChanged: true,
    quotaPrev: base.quota })).ok, false, "旧新相同却标变化，拒收");
  assert.equal(validateBankRows(pack({ ...base, quotaPrev: null })).ok, true, "null 合法");
  assert.equal(validateBankRows(pack({ ...base, quotaPrev: {} })).ok, false, "非数值拒收");
});

test("v132 额度变化通知接线：Python 判定 / Java 告警 / 服务标题（跨仓守卫）", () => {
  const mbPath = new URL("../../data24/navsources/monitor_bank.py", import.meta.url);
  if (!existsSync(mbPath)) return;              // licai-ledger 单独检出时无私有仓
  const mb = readFileSync(mbPath, "utf8");
  for (const s of ["def _quota_changed(", "round(now, 2) != round(old, 2)",
                   'row["quotaChanged"] = True', 'row["quotaPrev"] =',
                   "额度轨独立于披露 err"]) {
    assert.ok(mb.includes(s), "monitor_bank.py 缺锚点: " + s);
  }
  assert.doesNotMatch(mb, /额度变化暂不触发通知/, "旧局限说明已删");
  const ctl = readFileSync(new URL(
    "../../data24/android/app/src/main/java/me/glorywork/licailedger/MonitorCtl.java",
    import.meta.url), "utf8");
  for (const s of ["BANK_QUOTA_NOTIFY_TITLE", "bankQuotaNotifyBody(",
                   'a.put("kind", "额度变化")', 'row.optBoolean("quotaChanged", false)',
                   'e.put("quota", qNow)', 'e.put("quota", old.opt("quota"))']) {
    assert.ok(ctl.includes(s), "MonitorCtl 缺锚点: " + s);
  }
  assert.doesNotMatch(ctl, /!row\.optString\("err", ""\)\.isEmpty\(\)\) continue/,
    "err 行整行跳过会吞掉额度变化");
  const svc = readFileSync(new URL(
    "../../data24/android/app/src/main/java/me/glorywork/licailedger/MonitorService.java",
    import.meta.url), "utf8");
  assert.match(svc, /a\.optString\("title", ""\)/, "服务支持独立标题");
  assert.match(svc, /MonitorCtl\.BANK_NOTIFY_TITLE/, "旧告警回落统一标题");
});
