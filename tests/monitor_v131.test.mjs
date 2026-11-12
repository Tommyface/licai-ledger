/* v131 专项回归：监控池与产品页全量一致 + 机构分流（微众货架轨 / 银行披露页轨）。
   用户口径（2026-11-12）：可监控产品 = 产品页添加的全部产品；微众银行代销的走
   微众匿名货架，其他发行方的监控银行产品页面（中国理财网信披平台按登记编码）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  monitorChannelOf, monitorChannelCode, monitorRows, normMonitorCfg,
  validateBankRows, bankRowText, bankNotifyBody,
} from "../js/core/quota.js";
import { detectOrg } from "../js/core/orgs.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/* 台账产品形状取自真实字段：prodCode=货架码、regCode=Z 编码、inst=机构栏 */
const WEBANK_P = { id: "p1", name: "匠心灵动14天9G", prodCode: "NYJXLD1409G", inst: "南银理财", regCode: "Z7001126000218" };
const BANK_P = { id: "p2", name: "贵竹固收稳利日开5号P", prodCode: "FBAE42005P", inst: "民生理财" };
const BANK_P2 = { id: "p3", name: "幸福添利日开1号", inst: "广银理财", regCode: "Z7001425000885" };
const BARE_P = { id: "p4", name: "某产品" };
const SNAP = { ok: true, products: [{ code: "NYJXLD1409G", saleStatus: "12", availQuota: 600000 }] };

test("monitorChannelOf：四级判定（货架命中→微众→机构识别→兜底）", () => {
  assert.equal(monitorChannelOf(WEBANK_P, SNAP), "webank", "货架快照命中 = 最铁证据");
  assert.equal(monitorChannelOf(WEBANK_P, null), "bank",
    "南银发行、快照未命中时先归银行轨；Java 货架批量查询仍带它的 prodCode，命中即翻回");
  assert.equal(monitorChannelOf({ inst: "微众银行" }, null), "webank", "机构栏直接是微众");
  assert.equal(monitorChannelOf(BANK_P, null), "bank", "民生理财（detectOrg=cmbc）→ 银行轨");
  assert.equal(monitorChannelOf(BANK_P2, null), "bank", "广银理财 → 银行轨");
  assert.equal(monitorChannelOf({ prodCode: "5811225216" }, null), "webank",
    "机构识别不出但有货架码 → 微众尝试轨（查不到如实显示未命中）");
  assert.equal(monitorChannelOf(BARE_P, null), "none", "缺码缺机构 = 无法监控");
  assert.equal(monitorChannelOf(null, null), "none");
  assert.equal(detectOrg(BANK_P), "cmbc", "机构识别与云端同序别名表对齐");
});

test("monitorChannelCode：webank 轨取 prodCode，bank 轨登记编码优先", () => {
  assert.equal(monitorChannelCode(WEBANK_P, "webank"), "NYJXLD1409G");
  assert.equal(monitorChannelCode(WEBANK_P, "bank"), "Z7001126000218", "bank 轨 regCode 优先");
  assert.equal(monitorChannelCode(BANK_P, "bank"), "", "民生的码在 prodCode，bank 轨不拿它当登记编码");
  assert.equal(monitorChannelCode(BANK_P2, "bank"), "Z7001425000885");
});

test("monitorRows：全部产品逐只给行 + 分流状态 + 勾选双轨", () => {
  const pool = [WEBANK_P, BANK_P, BANK_P2, BARE_P];
  const rows = monitorRows(pool, SNAP, ["NYJXLD1409G"],
    [{ code: "Z7001425000885", org: "guangyin", name: "幸福添利日开1号" }], null);
  assert.equal(rows.length, 4, "全部产品都在池子里（与产品页一致）");
  assert.equal(rows[0].channel, "webank");
  assert.equal(rows[0].watched, true);
  assert.equal(rows[0].statusText, "在售 · 可购买", "货架命中的走两态语义");
  assert.equal(rows[0].quotaText, "600,000.00 元", "fmtYuan 带千分位");
  assert.equal(rows[1].channel, "bank");
  assert.equal(rows[1].statusText, "银行披露页 · 待抓取", "银行轨没回包时如实标待抓取");
  assert.equal(rows[2].channel, "bank");
  assert.equal(rows[2].watched, true, "bankWatch 勾选生效");
  assert.equal(rows[3].channel, "none");
  assert.equal(rows[3].hasCode, false);
  /* 银行轨回包进来后换披露文案 */
  const bankSnap = { ok: true, rows: [{ code: "Z7001425000885", name: "幸福添利日开1号", nav: 1.0234, navDate: "2026-11-12", changed: false, err: "" }] };
  const rows2 = monitorRows(pool, SNAP, [], [{ code: "Z7001425000885" }], bankSnap);
  assert.equal(rows2[2].statusText, "最新披露净值 1.0234（2026-11-12）");
  assert.equal(rows2[2].quotaText, "1.0234");
  assert.deepEqual(monitorRows(null, null, [], [], null), []);
});

test("normMonitorCfg：bankWatch 与 watch 同场去重，name 只做展示", () => {
  const c = normMonitorCfg({
    watch: ["NYJXLD1409G", "NYJXLD1409G"],
    bankWatch: [{ code: "Z7001126000218", org: "nanyin", name: "匠心灵动14天9G" },
                { code: "nyjxld1409g" },
                "Z7001425000885", { code: "BAD CODE!" }],
  });
  assert.deepEqual(c.watch, ["NYJXLD1409G"]);
  /* nyjxld1409g 与 watch 里的 NYJXLD1409G 同码 → 跨轨去重跳过；BAD CODE! 拒收 */
  assert.deepEqual(c.bankWatch.map(x => x.code),
    ["Z7001126000218", "Z7001425000885"]);
  assert.equal(c.bankWatch[0].org, "nanyin");
  assert.equal(c.bankWatch[0].name, "匠心灵动14天9G");
  assert.deepEqual(normMonitorCfg(null).bankWatch, []);
});

test("validateBankRows：整包校验（ok/rows/合法 code/nav 数值一致性）", () => {
  assert.equal(validateBankRows({ ok: true, rows: [{ code: "Z1", nav: 1.02, navDate: "2026-11-12" }] }).ok, true);
  assert.equal(validateBankRows({ ok: true, rows: [{ code: "Z1", err: "风控熔断" }] }).ok, true, "err 行放行");
  assert.equal(validateBankRows({ ok: false, error: "x" }).ok, false);
  assert.equal(validateBankRows({ ok: true, rows: [] }).ok, true, "空 rows 合法");
  assert.equal(validateBankRows({ ok: true }).ok, false, "缺 rows 拒收");
  assert.equal(validateBankRows({ ok: true, rows: [{ nav: 1 }] }).ok, false, "缺 code 拒收");
  assert.equal(validateBankRows({ ok: true, rows: [{ code: "Z1", nav: "abc" }] }).ok, false,
    "nav 非数值且无 err 说明拒收");
  assert.equal(validateBankRows(null).ok, false);
});

test("bankRowText / bankNotifyBody：披露文案与通知正文", () => {
  assert.equal(bankRowText(null), "银行披露页 · 待抓取");
  assert.equal(bankRowText({ err: "中国理财网风控熔断期内，本轮放弃" }).includes("风控"), true);
  assert.equal(bankRowText({ nav: 1.0156, navDate: "2026-11-12" }), "最新披露净值 1.0156（2026-11-12）");
  const body = bankNotifyBody("幸福添利日开1号", "Z7001425000885", 1.0234, "2026-11-12", "2026-11-12 18:00:00");
  assert.match(body, /银行披露页已更新净值：1\.0234（2026-11-12）/);
  assert.match(body, /中国理财网信披平台/, "免责口径：披露页来源 + 请在发行银行 App 核对");
});

test("v131 接线：双轨 watch、refresh 带配置、池子渲染走 monitorRows", () => {
  assert.match(app, /function monitorWatchOne\(code, ch\)/, "勾选分轨（ch=webank|bank）");
  assert.match(app, /function monitorWatchSet\(list, bankList\)/, "双轨写配置");
  assert.match(app, /monitorWatchOne\('\$\{esc\(r\.code\)\}','\$\{isBank \? "bank" : "webank"\}'\)/,
    "行内 onclick 带轨参数");
  assert.match(app, /if \(ch === "bank"\) cfgB\.push\(\{ code, org: detectOrg\(p\) \}\)/,
    "全选按轨入列，bank 元素带机构提示");
  assert.match(app, /monitorWatchSet\(\[\], \[\]\)/, "清空清两轨");
  assert.match(app, /const rows = monitorRows\(pool, MONITOR_ST\.snapshot, cfg\.watch, cfg\.bankWatch, MONITOR_ST\.bankRows\)/);
  assert.match(app, /微众货架 \$\{nWeb\} · 银行披露页 \$\{nBank\}/, "头部计数分轨显示");
  assert.match(html, /橙色「微众货架」标/, "分流图例说明");
  assert.match(html, /蓝色「披露页」标/, "分流图例说明");
});

test("版本钉：APP_VER / CACHE 同步 v132", () => {
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const ver = app.match(/const APP_VER = "(v\d+)"/)[1];
  const cache = sw.match(/const CACHE = "licai-ledger-(v\d+)"/)[1];
  assert.equal(ver, cache);
  assert.equal(ver, "v132");
});

/* 私有仓契约（文件在 ../data24 不在网页仓，这里用源码级断言钉住网页层可见的行为）：
   Python 抓取入口 monitor_bank 与 Java runBankOnce 的契约由私有仓
   tests/test_android_s2.py 的 v131 断言覆盖（跨仓 verify-web.sh 在 CI 跑）。
   ★ 双仓同检出时才跑：公开仓 CI 只 checkout licai-ledger，没有私有仓
     data24/ ——守卫先例见 app_core.test.mjs「licai-ledger 单独检出时无此文件」。 */
test("v131 私有仓三件套本地存在且契约锚点齐", () => {
  if (!existsSync(new URL("../../data24/navsources/monitor_bank.py", import.meta.url))) {
    return;                                      // licai-ledger 单独检出时无私有仓
  }
  const mb = readFileSync(new URL("../../data24/navsources/monitor_bank.py", import.meta.url), "utf8");
  assert.match(mb, /def monitor_bank\(payload\)/);
  assert.match(mb, /fetch_chinawealth/, "抓取复用 chinawealth 会话签名，不写第二套");
  assert.match(mb, /changed.*=.*bool\(pre_d and d > pre_d\)/, "navDate 前进才算更新（首次只记基线）");
  const ctl = readFileSync(new URL(
    "../../data24/android/app/src/main/java/me/glorywork/licailedger/MonitorCtl.java",
    import.meta.url), "utf8");
  assert.match(ctl, /"monitor-bank"/);
  assert.match(ctl, /K_BANK_PREV|K_BANK_SNAPSHOT|BANK_EVERY_SEC/);
  assert.match(ctl, /runBankOnce/, "Java 只编排与通知，抓取在 Python");
  const svc = readFileSync(new URL(
    "../../data24/android/app/src/main/java/me/glorywork/licailedger/MonitorService.java",
    import.meta.url), "utf8");
  assert.match(svc, /bankTick\(\)/, "轮询双轨：微众每轮 + 银行轨 ≥10 分钟");
});
