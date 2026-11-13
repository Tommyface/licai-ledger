/* v135 专项回归：中行手机银行 BMPS 游客网关接入（bocmob 轨）。
   链接（用户 2026-11-13）：ebsnew.boc.cn/bocphone/.../productDetail?productId=WFZDJQRKA
   实测（游客、无 Cookie、明文 cipherType=0）：
     · PsnxWmpProductDetailQueryOutlay + {productId, subChannelId:"31"} → 211 字段
     · indiAmtRem=个人剩余额度（元）；App 前端实证 0 → 「已售罄」、>0 → 「剩余额度 ¥xxx」
     · registryCode 实名登记编码，与台账 regCode 强核对防错配
   网页层职责：粘贴链接解析出 bocPid（不污染 prodCode）、bank 轨回包放行
   quotaSource:"boc"、状态/额度文案统一在 quota.js 判定。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProductInput, rowAddable, BOC_H5_RE } from "../js/core/paste.js";
import { monitorRows, validateBankRows, bocStatusText } from "../js/core/quota.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const BOC_LINK = "https://ebsnew.boc.cn/bocphone/VueLocalCli4/bocFinanceDetail/index.html"
  + "#/productDetail?functionCode=bocFinanceProductDetail&productId=WFZDJQRKA&lastShortUrl=dCEO2otAzz";

test("v135 版本钉：APP_VER / CACHE 同步 v135，专项进两份测试清单", () => {
  const ver = /const APP_VER = "([^"]+)"/.exec(app)[1];
  const cache = /const CACHE = "licai-ledger-([^"]+)"/.exec(sw)[1];
  assert.equal(ver, "v135");
  assert.equal(cache, "v135");
  assert.match(pkg, /bocmob_v135\.test\.mjs/, "npm test 登记");
  assert.match(ci, /bocmob_v135\.test\.mjs/, "CI 登记");
});

test("BOC 链接识别：ebsnew.boc.cn/bocphone/ 命中", () => {
  assert.ok(BOC_H5_RE.test(BOC_LINK));
  assert.ok(!BOC_H5_RE.test("https://personal.webank.com/x?productId=WFZDJQRKA"));
});

test("parseProductInput：中行链接 → bocPid，绝不污染 prodCode", () => {
  const r = parseProductInput(BOC_LINK);
  assert.equal(r.ok, true);
  assert.equal(r.bocPid, "WFZDJQRKA");
  assert.equal(r.prodCode, "", "中行内部代码不许混进产品代码（官网源不认它）");
  assert.equal(r.code, "");
  assert.ok(r.msg.includes("中行手机银行代码 WFZDJQRKA"));
  assert.ok(rowAddable(r, ""), "bocPid 行应可落库");
});

test("parseProductInput：中行链接缺 productId → 明确提示而不是静默失败", () => {
  const r = parseProductInput("https://ebsnew.boc.cn/bocphone/VueLocalCli4/"
    + "bocFinanceDetail/index.html#/productDetail?functionCode=bocFinanceProductDetail");
  assert.equal(r.ok, false);
  assert.ok(r.msg.includes("productId"));
});

test("parseProductInput：带数字的中行 productId 同样进 bocPid 不进 prodCode", () => {
  const r = parseProductInput("https://ebsnew.boc.cn/bocphone/VueLocalCli4/x/index.html"
    + "#/productDetail?productId=ZF2026A123");
  assert.equal(r.bocPid, "ZF2026A123");
  assert.equal(r.prodCode, "");
});

test("回归：非中行链接行为不变（北银 prodCode / 微众短链 / 裸码）", () => {
  const a = parseProductInput("https://x.bank.com/p?PROD_CODE=YJ01251204A");
  assert.equal(a.prodCode, "YJ01251204A");
  assert.equal(a.bocPid, "");
  const b = parseProductInput("https://gzhjdata.webank.com/hj/su/3Fk9Qm");
  assert.equal(b.ok, false);          // 微众短链仍走原提示路径
  const c = parseProductInput("25112035B");
  assert.equal(c.prodCode, "25112035B");
  assert.equal(c.bocPid, "");
  assert.ok(rowAddable(c, ""));
});

test("validateBankRows：quotaSource 白名单 ccb+boc，第三种拒绝", () => {
  const good = { ok: true, rows: [{ code: "Z7001026000510", name: "稳富中短久期日开A",
    nav: 1.01156800, navDate: "2026-11-12", changed: true, err: "",
    quota: 0, quotaSource: "boc", saleState: "0" }] };
  assert.equal(validateBankRows(good).ok, true);
  const bad = { ok: true, rows: [{ code: "Z1", quota: 1, quotaSource: "xxx" }] };
  assert.equal(validateBankRows(bad).ok, false);
  const ccb = { ok: true, rows: [{ code: "Z2", quota: 9.9, quotaSource: "ccb" }] };
  assert.equal(validateBankRows(ccb).ok, true);
});

test("bocStatusText：与 App 同判据（0→已售罄，>0→在售，缺失→saleState 原值）", () => {
  assert.equal(bocStatusText({ quota: 0, saleState: "0" }), "已售罄");
  assert.equal(bocStatusText({ quota: 1234567.89, saleState: "0" }), "在售");
  assert.equal(bocStatusText({ quota: null, saleState: "2" }), "状态 2");
  assert.equal(bocStatusText({ quota: null, saleState: "" }), "中行详情 · 暂无数据");
  assert.equal(bocStatusText({ err: "超时" }), "中行详情抓取未成：超时");
  assert.equal(bocStatusText(null), "中行详情 · 待抓取");
});

test("monitorRows：boc 行的标签/额度/状态三件套", () => {
  const pool = [{ name: "稳富中短久期日开A", regCode: "Z7001026000510",
    prodCode: "", inst: "中银理财" }];
  const bankSnap = { ok: true, rows: [{ code: "Z7001026000510",
    name: "稳富中短久期日开A", nav: 1.01156800, navDate: "2026-11-12",
    changed: false, err: "", quota: 0, quotaSource: "boc", saleState: "0" }] };
  const rows = monitorRows(pool, null, [], [], bankSnap);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.channel, "bank");
  assert.equal(r.quotaLabel, "剩余额度·中行详情");
  assert.equal(r.quotaText, "已售罄");
  assert.equal(r.statusText, "已售罄");
  assert.equal(r.quotaSource, "boc");
  /* 额度 >0 的形态 */
  const snap2 = { ok: true, rows: [{ ...bankSnap.rows[0], quota: 12345678.9 }] };
  const r2 = monitorRows(pool, null, [], [], snap2)[0];
  assert.equal(r2.quotaText, "12,345,678.90 元");
  assert.equal(r2.statusText, "在售");
  assert.equal(r2.quotaLabel, "剩余额度·中行详情");
});

test("app.js：bocPid 落库/表单/查重三处接线", () => {
  assert.ok(app.includes("bocPid: x.r.bocPid ||"), "粘贴落库要带 bocPid");
  assert.ok(app.includes('id="pBocPid"'), "产品表单要有 bocPid 输入框");
  assert.ok(app.includes("String(p.bocPid || \"\").toUpperCase() === bp"),
    "findDupProduct 要按 bocPid 查重");
  assert.ok(app.includes('patch.bocPid'), "saveProduct 要收集 bocPid");
});

test("app.js：bocPid 进 MERGE_FIELDS（双记录合并时渠道码参与人工确认）", () => {
  const m = app.match(/const MERGE_FIELDS = \[([^\]]+)\]/);
  assert.ok(m, "MERGE_FIELDS 定义存在");
  assert.ok(m[1].includes('"bocPid"'), "bocPid 应在合并字段集里");
});
