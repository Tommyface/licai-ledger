/* 核心逻辑回归测试（零依赖，Node 18+）：
     node --test tests/app_core.test.mjs
   被测对象是 js/ 下的纯函数模块 —— 拆模块之后不再需要 vm 造沙箱，
   直接用 ESM import 就能测，跨 realm 的 deepEqual 坑也一起没了。
   测的都是「算错了会让人看到假收益 / 写坏数据」的地方：
     · T+1 确认口径（份额什么时候算进持仓）
     · 净值序列取值（最新 / 指定日之前）
     · 机构识别（前端说能抓、云端才抓得到）
     · 粘贴添加的解析（扫微众海报得到的裸码必须收，噪声必须挡）
     · 截图 OCR 的「日期 + 净值」配对（错一行就是错一笔账） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fmtDate } from "../js/core/util.js";
import { ORG_ALIAS, ORG_NAME, detectOrg, detectOrgByProdCode } from "../js/core/orgs.js";
import { parseProductInput } from "../js/core/paste.js";
import { navSeries, latestNav, navOnOrBefore, navHit } from "../js/domain/nav.js";
import { sharesOn, hasAnyTrade, computePosition } from "../js/domain/position.js";
import { ocrNavLines } from "../js/domain/ocr.js";
import { BOARD_COLS, BOARD_LEAN } from "../js/domain/board.js";

const today = fmtDate(new Date());
const plusDays = n => fmtDate(new Date(Date.now() + n * 86400000));

/* ---- T+1 确认口径 ---- */
test("T+1：确认日在明天，今天不计份额、不计市值", () => {
  const p = { id: "p1", navHistory: { [today]: 1.01 } };
  const trades = [{ id: "t1", prodId: "p1", type: "buy", tradeDate: today,
    confirmDate: plusDays(1), amount: 10100, confirmNav: 1.01 }];
  assert.equal(sharesOn(p, trades, today), 0, "未确认的买入不应出现在今日份额");
  const pos = computePosition(p, trades, today);
  assert.equal(pos.shares, 0);
  assert.equal(Math.round(pos.pendingShares), 10000, "应进入在途份额");
  assert.ok(pos.inTransit, "一份都没确认时应标记为在途");
  assert.equal(sharesOn(p, trades, plusDays(1)), 10000, "确认日当天才有份额");
});

test("T+1：确认日是今天，份额 = 金额 / 确认净值", () => {
  const p = { id: "p2", navHistory: { [today]: 1.01 } };
  const trades = [{ id: "t2", prodId: "p2", type: "buy", tradeDate: today,
    confirmDate: today, amount: 1010, confirmNav: 1.01 }];
  const pos = computePosition(p, trades, today);
  assert.equal(Math.round(pos.shares * 100) / 100, 1000);
  assert.equal(Math.round(pos.cost * 100) / 100, 1010);
  assert.ok(!pos.inTransit, "已确认就不该显示在途");
  assert.ok(hasAnyTrade(p, trades));
});

test("历史份额按日期结算：不能用今天的份额算过去", () => {
  const p = { id: "p3", navHistory: {} };
  const trades = [
    { id: "a", prodId: "p3", type: "buy", tradeDate: plusDays(-10), confirmDate: plusDays(-9), amount: 1000, confirmNav: 1 },
    { id: "b", prodId: "p3", type: "buy", tradeDate: today, confirmDate: today, amount: 500, confirmNav: 1 },
  ];
  assert.equal(sharesOn(p, trades, plusDays(-5)), 1000);
  assert.equal(sharesOn(p, trades, today), 1500);
});

test("赎回：按均价扣减成本，差额计入已实现", () => {
  const p = { id: "p4", navHistory: { "2026-01-01": 1 } };
  const trades = [
    { id: "b1", prodId: "p4", type: "buy", tradeDate: "2026-01-01", confirmDate: "2026-01-01", amount: 1000, confirmNav: 1 },
    { id: "s1", prodId: "p4", type: "sell", tradeDate: "2026-01-02", confirmDate: "2026-01-02", shares: 400, confirmNav: 1.2 },
  ];
  const pos = computePosition(p, trades, "2026-01-03");
  assert.equal(Math.round(pos.shares), 600);
  assert.equal(Math.round(pos.cost), 600);
  assert.equal(Math.round(pos.realized), 80, "400 份 × (1.2-1.0)");
  assert.equal(Math.round(pos.market), 600, "按最新净值 1.0 计市值");
});

/* ---- 净值序列 ---- */
test("净值序列按日期升序，latestNav 取最后一条", () => {
  const p = { navHistory: { "2026-10-27": 1.01, "2026-10-28": 1.015553, "2026-10-26": 1.0 } };
  assert.deepEqual(navSeries(p).map(x => x[0]), ["2026-10-26", "2026-10-27", "2026-10-28"]);
  assert.deepEqual(latestNav(p), ["2026-10-28", 1.015553]);
  assert.deepEqual(navOnOrBefore(p, "2026-10-27"), ["2026-10-27", 1.01]);
  assert.deepEqual(navHit(p, "2026-10-28"), ["2026-10-28", 1.015553], "命中当天应返回数组");
  assert.equal(latestNav({ navHistory: {} }), null);
});

/* ---- 机构识别（与云端 detect_org 的契约） ---- */
test("机构识别：常见机构与易混对", () => {
  assert.equal(detectOrg({ inst: "北京银行" }), "bob");
  assert.equal(detectOrg({ inst: "华夏银行" }), "hx");
  assert.equal(detectOrg({ name: "宁银理财 某产品" }), "wmbnb", "宁银不能被南银抢走");
  assert.equal(detectOrg({ name: "南银理财 某产品" }), "nanyin");
  assert.equal(detectOrg({ name: "中信银行代销" }), "citic");
});

test("机构识别：建信理财（jxwm，走建行在售清单渠道）", () => {
  assert.equal(detectOrg({ inst: "建信理财" }), "jxwm");
  assert.equal(detectOrg({ inst: "建信理财有限责任公司" }), "jxwm");
  assert.equal(detectOrg({ name: "惠众日申季赎第8期", manager: "建信理财" }), "jxwm");
  // 别名表按声明顺序匹配，已有发行方必须优先于「建行」这条渠道别名
  assert.equal(detectOrg({ inst: "中国建设银行", name: "中银理财-稳富" }), "bocwm");
});

test("机构识别：浙银 / 青银 / 招银（2026-10-30 三家新直连源）", () => {
  assert.equal(detectOrg({ inst: "浙银理财" }), "czbwm");
  assert.equal(detectOrg({ name: "浙银理财琮融九曜添利90天" }), "czbwm");
  assert.equal(detectOrg({ inst: "青银理财" }), "qdccb");
  assert.equal(detectOrg({ inst: "招银理财" }), "cmbwm");
  // 新别名追加在表尾：先声明的发行方不能被抢走
  assert.equal(detectOrg({ inst: "宁银理财" }), "wmbnb", "宁银 ≠ 青银 / 浙银");
  assert.equal(detectOrg({ inst: "杭银理财" }), "hangyin");
  assert.equal(detectOrg({ inst: "中银理财" }), "bocwm");
  assert.equal(detectOrg({ inst: "信银理财" }), "citic");
  // 代销渠道名（微众/网商）仍然认不出发行方 —— 那类产品由云端货架反查负责
  assert.equal(detectOrg({ inst: "微众银行", name: "阳光橙安盈季开9号D" }), "");
  // 代码形态提示：浙银份额码可判；母代码要明确提醒补份额字母
  assert.equal(detectOrgByProdCode("ZYJYG0044A").org, "czbwm");
  assert.equal(detectOrgByProdCode("ZYFCG0044B").org, "czbwm", "浙银不止 ZYJYG 一个家族");
  assert.equal(detectOrgByProdCode("ZYJYG00440").org, "czbwm");
  assert.match(detectOrgByProdCode("ZYJYG00440").tip, /母代码/);
  // 宁银的 Z+2 字母+7 位数字代码不能被浙银的 ZY… 规则抢走
  assert.equal(detectOrgByProdCode("ZGN2360006C").org, "wmbnb");
  // 招银 cfweb 用的是纯数字码，别家也可能是纯数字 → 故意不写规则，免误判
  assert.equal(detectOrgByProdCode("132031D").org, "");
});

test("机构识别：交银理财（bocom，补前端漏掉的别名）", () => {
  // 云端早就有 bocom 官网源，前端这张表 2026-10-30 之前漏了 → 同一个产品两边结论不同
  assert.equal(detectOrg({ inst: "交银理财" }), "bocom");
  assert.equal(detectOrg({ name: "交银理财纯固收" }), "bocom");
  assert.equal(ORG_NAME.bocom, "交银理财", "fetchStatus 要认它是直连源（官网+中国理财网双线）");
  // 「交通银行」不含「交银」，不会被这条别名带走
  assert.equal(detectOrg({ inst: "交通银行", name: "稳健理财" }), "chinawealth");
});

test("机构识别：光大理财（cebwm，走母公司光大银行的披露页）", () => {
  assert.equal(detectOrg({ inst: "光大理财" }), "cebwm");
  assert.equal(detectOrg({ inst: "光大理财有限责任公司" }), "cebwm");
  assert.equal(detectOrg({ name: "阳光金日添利1号", manager: "光大理财" }), "cebwm");
  // 在光大银行买的，机构栏常只写「光大银行」
  assert.equal(detectOrg({ inst: "光大银行" }), "cebwm");
  // 别名表按声明顺序匹配：光大银行代销的别家产品仍归发行方，不能被「光大」带走
  assert.equal(detectOrg({ inst: "光大银行", name: "宁银理财晶瑞固定5号" }), "wmbnb");
  assert.equal(detectOrg({ inst: "光大银行", name: "徽银理财徽享稳利" }), "huiyin");
  // EW… 形态故意不写规则：中国银行代销码同为 EW + 4 位数字 + 份额字母（EW4455D），
  // 按形态判机构会把中行代销的产品错认成光大理财
  assert.equal(detectOrgByProdCode("EW2999A").org, "");
  assert.equal(detectOrgByProdCode("EW4455D").org, "");
});

/* ---- 粘贴添加：链接 / 代码 / 文本 → 产品键 ----
   2026-10-30 的线上事故：扫微众海报得到华夏销售码 25112035B，
   形态表只写了「华夏 = 12 位数字」，于是解析判「不认识」、行 status=bad，
   而按钮仍写「确认添加 1 只」——点下去才 toast「没有可添加的产品」。
   裸码现在直接收（paste.js ②b），认不出的形态必须一路挡住。 */
test("粘贴：整行是微众/别家销售码时直接收下（不等形态表认识）", () => {
  const r = parseProductInput("25112035B");
  assert.equal(r.ok, true, "扫码得到的裸码必须算识别成功");
  assert.equal(r.prodCode, "25112035B");
  assert.equal(r.bare, true);
  assert.equal(r.org, "", "8 位数字+份额字母不是华夏的已知形态，机构靠云端货架反查或用户手填");
  assert.match(r.msg, /发行机构/);
  /* 大小写、首尾空格、中文标签、句末标点都不该影响 */
  for (const s of [" 25112035b ", "产品代码：25112035B", "微众 稳健理财 25112035B", "25112035B。"]) {
    assert.equal(parseProductInput(s).prodCode, "25112035B", `${s} 应解析出同一个代码`);
  }
});

test("粘贴：不像代码的文本不能被当成产品代码", () => {
  /* 纯字母词、结尾不是代码的产品名、公众号链接里的随机串、净值行 */
  const bad = ["HELPHELP", "华夏理财 固收纯债日开35号B",
    "https://mp.weixin.qq.com/s/AbCdEf123456", "净值1.0356 2026年10月28日", ""];
  for (const s of bad) {
    const r = parseProductInput(s);
    assert.equal(r.ok, false, `${s || "(空)"} 不该被认成产品`);
    assert.equal(r.prodCode, "");
    assert.equal(r.code, "");
  }
});

test("粘贴：微众分享短链要说清「代码在跳转里」", () => {
  const r = parseProductInput("https://gzhjdata.webank.com/hj/su/3Fk9Qm");
  assert.equal(r.ok, false, "浏览器跨域跟不了 302，不能假装认出来了");
  assert.match(r.msg, /二维码/);
});

test("粘贴：链接参数与登记编码照旧", () => {
  let r = parseProductInput("https://x.com/a?prodRegCode=Z7008926000006");
  assert.equal(r.code, "Z7008926000006");
  assert.equal(r.org, "chinawealth");
  assert.equal(r.ok, true);
  r = parseProductInput("https://m.example.cn/p?PROD_CODE=YJ01251204A");
  assert.equal(r.prodCode, "YJ01251204A");
  assert.equal(r.org, "bob", "北银的形态表认识，机构自动填好");
  assert.equal(r.bare, false);
  r = parseProductInput("ZGN2360006C");
  assert.deepEqual([r.prodCode, r.org, r.ok], ["ZGN2360006C", "wmbnb", true]);
  r = parseProductInput("Z7008926000006");
  assert.equal(r.code, "Z7008926000006", "整行是登记编码时归到 code，不能被裸码规则抢走");
  assert.equal(r.bare, false);
});

/* ---- 截图 OCR 的日期/净值配对 ---- */
test("OCR：日期与净值分处上下两行", () => {
  const rows = ocrNavLines(["净值日期", "2026-10-28", "单位净值", "1.015553", "日涨幅 0.01%"].join("\n"));
  assert.deepEqual(rows, ["2026-10-28 1.015553"]);
});

test("OCR：多行记录、中文日期、同行写法", () => {
  assert.deepEqual(ocrNavLines("2026-10-28  1.015553\n2026-10-27  1.015441"),
    ["2026-10-28 1.015553", "2026-10-27 1.015441"]);
  assert.deepEqual(ocrNavLines("2026年10月28日\n单位净值 1.0210"),
    ["2026-10-28 1.0210"]);
  assert.deepEqual(ocrNavLines("2026-10-28 单位净值 1.015553"),
    ["2026-10-28 1.015553"]);
});

test("OCR：两日期小数位不足的数字不误判为净值", () => {
  /* 0.01% 这种两位小数不该被当成净值；没有净值的那一行直接丢弃 */
  assert.deepEqual(ocrNavLines("2026-10-28\n日涨幅 0.01%"), []);
});
/* ---- 「按钮说能加」与「点下去真能加」必须同源 ----
   这次的事故就是 previewLink 算出「确认添加 1 只」、saveFromLink 又拒绝。
   判据已经抽成 paste.js 的 rowAddable，所以能**真跑**；上一版这里是文本匹配，
   测绿只证明字符串存在，不证明两处同源（审计指出后改掉）。 */
test("粘贴添加：rowAddable 真执行 —— 放行与拦住的边界", async () => {
  const { rowAddable } = await import("../js/core/paste.js");
  const P = s => parseProductInput(s);
  /* 放行：识别出机构 / 机构栏填了 / 有登记编码 / 整行裸码 */
  assert.equal(rowAddable(P("https://m.example.cn/p?PROD_CODE=YJ01251204A"), ""), true, "北银形态认出发行方");
  assert.equal(rowAddable(P("Z7008926000006"), ""), true, "只有登记编码也能抓（中国理财网）");
  assert.equal(rowAddable(P("25112035B"), ""), true, "裸码：云端按代码去货架反查");
  assert.equal(rowAddable(P("https://x.cn/a?prodCode=QQQQQQ1"), "华夏理财"), true, "认不出发行方但机构栏填了");
  /* 拦住：解析失败、或只有个认不出的产品代码且机构栏空着 */
  assert.equal(rowAddable(P("HELPHELP"), ""), false, "没认出来的一律不可加");
  assert.equal(rowAddable(P(""), ""), false);
  assert.equal(rowAddable(P("https://x.cn/a?prodCode=QQQQQQ1"), ""), false, "既没机构也没登记编码");
  assert.equal(rowAddable(null, "华夏理财"), false);
  /* app.js 两处必须真的都在调这个函数（抽出去了还各写一遍 = 又要不同源） */
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const seg = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to, i);
    assert.ok(i > 0 && j > i, `app.js 里找不到 ${from} → ${to}`);
    return src.slice(i, j);
  };
  assert.match(seg("function previewLink", "function saveFromLink"), /rowAddable/, "预览没走同一个判据函数");
  assert.match(seg("function saveFromLink", "\nfunction openNav"), /rowAddable/, "落库没走同一个判据函数");
});

test("粘贴：代码 + 金额 / 手机号 / 日期串 / 身份证 不能被粘成一个产品代码", () => {
  /* 审计实测出的误收面：norm 会吃掉空格，老写法把整行当一个串取尾，
     "25112035B 10000" 被合成 "25112035B10000"。现在按空白切词取末词。 */
  const bad = ["25112035B 10000", "25112035B 2026", "2500 25112035B", "2026 25112035B",
    "13800138000", "20261028", "110101199001011234", "https://x.cn/AB123456"];
  for (const s of bad) {
    const r = parseProductInput(s);
    assert.equal(r.ok, false, `${s} 不该被当成产品代码`);
  }
  /* 占位参数：?code=weixin → WEIXIN 是 6 位纯字母，正好蒙过长度关（注释一直
     声称排除了它，其实没有）。参数值现在必须含数字。 */
  const w = parseProductInput("https://mp.weixin.qq.com/s?code=weixin&id=123");
  assert.equal(w.prodCode, "", "?code=weixin 不能当产品代码");
  /* 带标签 / 句末标点 / 大小写仍然要收（这才是 ②b 存在的理由） */
  assert.equal(parseProductInput("产品代码：25112035B").prodCode, "25112035B");
  assert.equal(parseProductInput("25112035B。").prodCode, "25112035B");
  assert.equal(parseProductInput("微众 稳健理财 25112035B").prodCode, "25112035B");
});

/* ---- 前后端机构识别一致性（把两边逐字比对，以前只靠人肉核对）----
   navsources/base.py 在 licai-data 仓库里，Web CI 的检出没有这一份 →
   文件不在就跳过（本地两边同树，跑得到）。 */
test("ORG_ALIAS：前端这张表必须与云端逐字同序", async () => {
  const fs = await import("node:fs");
  /* 同上：用 import.meta.url 解析，从仓根跑 npm test 时 "../navsources/base.py"
     会被算到仓外，于是这条门禁一路「文件不在 → 跳过」，白过。 */
  const path = new URL("../navsources/base.py", import.meta.url);
  if (!fs.existsSync(path)) return;              // licai-ledger 单独检出时无此文件
  const src = fs.readFileSync(path, "utf8");
  const block = src.split("ORG_ALIAS = {")[1].split("\n}")[0];
  const py = [...block.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",/gm)].map(m => [m[1], m[2]]);
  assert.equal(ORG_ALIAS.length, py.length,
    `云端 ${py.length} 条 / 前端 ${ORG_ALIAS.length} 条，哪家漏了`);
  for (let i = 0; i < py.length; i++) {
    assert.deepEqual([...ORG_ALIAS[i]], py[i],
      `第 ${i + 1} 条不一致（云端 ${py[i]} / 前端 ${ORG_ALIAS[i]}）：别名表按声明顺序命中，顺序也要一致`);
  }
});

/* ---- 「隐藏」开关的源码级门禁（v45）----
   这一组不测算法，测的是「有没有绕过唯一出口」。
   隐藏金额是给用户当别人面打开 App 用的，漏遮一处就不是不好看而是事故；
   而漏遮只在 hideAmount=true 时看得见，人肉回归基本抓不住。
   口径：金额文本一律 shown()，涨跌色一律 tone()，两个 helper 是唯一出口。 */
const APP_SRC = await (async () => {
  const fs = await import("node:fs");
  return fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
})();
/* 从函数名切出函数体（到下一个顶层 \nfunction 为止；本仓的渲染函数都是顶层声明） */
function fnBody(name) {
  const i = APP_SRC.indexOf(`function ${name}(`);
  assert.ok(i > 0, `app.js 里找不到 ${name}()`);
  const j = APP_SRC.indexOf("\nfunction ", i + 1);
  return APP_SRC.slice(i, j < 0 ? APP_SRC.length : j);
}
/* shown( 的覆盖区间：括号配对算出来的，比"前一个 token 是 shown"可靠 ——
   shown(isMoney ? signMoney(v) : ...) 这种三元参数、shown((Number(x)||0).toFixed(2))
   这种嵌套括号，用正则前窥都会看漏。 */
function shownSpans(src) {
  const spans = [];
  for (let i = src.indexOf("shown("); i >= 0; i = src.indexOf("shown(", i + 1)) {
    let depth = 0;
    for (let j = i + 5; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) { spans.push([i, j]); break; } }
    }
  }
  return spans;
}
const SPANS = shownSpans(APP_SRC);
const inSpan = (idx, offset = 0) => SPANS.some(([a, b]) => idx + offset > a && idx + offset < b);
/* v55 资产月报：报告是全新的一整屏个人数字（月收益、构成、期初期末），
   以前「隐藏」管不到的地方现在全都露在一张弹层里，所以两个函数都要进门禁。 */
const TONE_FN = ["renderHome", "setStat", "renderCal", "pendingHtml", "closedHtml",
  "renderDetailBody", "renderTrade", "renderProd", "renderMonthly", "monthlyHintText"];
/* 个人数字的遮蔽面：金额 + 份额。份额两位小数，6.9 万份就是 6.9 万元，
   遮了金额不遮份额等于没遮；净值 / 成本净值是四位小数的公开或衍生口径，不在此列。 */
const MASK_FN = [...TONE_FN, "renderProdDetail"];   /* renderMonthly / monthlyHintText 已随 TONE_FN 进入 */

test("隐藏：app.js 里不许再手写「隐藏时输出星号」的三元式", () => {
  const hits = APP_SRC.match(/hideAmount\s*\?\s*["'`]\*{2,}["'`]/g) || [];
  assert.deepEqual(hits, [],
    `手写遮蔽绕过了 shown()：${hits.join(", ")}\n请改成 shown(文本) / tone(数值)`);
});

test("隐藏：所有 money() / signMoney() 调用都在 shown() 括号内", () => {
  /* 例外只有一条：录入交易时的实时试算。用户正在填份额/金额，遮了就没法录。
     要扩大例外必须改这条测试，逼人来想一次「这里该不该遮」。 */
  const ALLOW = ["tAmountShow"];
  const lines = APP_SRC.split("\n");
  const bad = [];
  const re = /\b(money|signMoney)\s*\(/g;
  let m;
  while ((m = re.exec(APP_SRC))) {
    const ln = APP_SRC.slice(0, m.index).split("\n").length - 1;
    if (ALLOW.some(k => lines[ln].includes(k))) continue;
    if (!inSpan(m.index)) bad.push(`${ln + 1}: ${lines[ln].trim().slice(0, 80)}`);
  }
  assert.deepEqual(bad, [],
    `这些金额格式化没走 shown()，隐藏开关打开时会明文显示：\n  ${bad.join("\n  ")}`);
});

test("隐藏：渲染函数不许用裸 cls()，份额不许裸 toFixed(2)", () => {
  for (const n of TONE_FN) {
    const b = fnBody(n);
    const bare = b.match(/[^.\w]cls\(/g) || [];
    assert.equal(bare.length, 0,
      `${n}() 有 ${bare.length} 处裸 cls()：隐藏时颜色泄露正负，请改 tone()`);
    assert.ok(b.includes("shown("), `${n}() 里没有任何 shown()：金额遮蔽疑似被删`);
  }
  for (const n of MASK_FN) {
    const b = fnBody(n);
    const off = APP_SRC.indexOf(b);
    const leak = [];
    const re = /\.toFixed\(2\)/g;
    let m;
    while ((m = re.exec(b))) if (!inSpan(off + m.index)) leak.push(b.slice(Math.max(0, m.index - 40), m.index + 14).trim());
    assert.deepEqual(leak, [],
      `${n}() 有 ${leak.length} 处裸 .toFixed(2)：份额是钱的另一种写法，隐藏时必须走 shown()`);
  }
});

test("隐藏：产品收益表只放公开披露口径（不该出现金额列）", () => {
  const b = fnBody("renderBoard");
  assert.ok(b.includes("boardCols("), "renderBoard() 不再走 boardCols()：精简/全部两种列模式失效");
  assert.ok(!/\bmoney\(/.test(b), "renderBoard() 出现金额格式化：公开口径表不该有金额");
});

/* v48 起这张表的列宽（CSS 类名）与单元格（渲染函数）都按 key 查表：
   少一个 key 就是 renderBoard() 抛异常（整个产品页空白），
   类名写了但 index.html 里没有对应的宽度规则，则等于该列不限宽、又变回撑破屏幕。
   两种都是「改了列定义忘了改另一处」，肉眼看不出来，只能在这里拦。 */
test("产品收益表：每个列 key 都有类名、单元格渲染与 CSS 宽度", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const clsBody = mapBody("BD_CLS"), cellBody = mapBody("BD_CELL");
  for (const c of BOARD_COLS) {
    const k = c[0];
    assert.ok(new RegExp(`(^|[\\s,{])${k}\\s*:`).test(clsBody), `BD_CLS 缺列 ${k}：表头没有类名`);
    assert.ok(new RegExp(`(^|[\\s,{])${k}\\s*:`).test(cellBody), `BD_CELL 缺列 ${k}：渲染时会抛 TypeError`);
    const m = clsBody.match(new RegExp(`${k}\\s*:\\s*"([^"]+)"`));
    assert.ok(m, `BD_CLS 里 ${k} 的值不是字符串`);
    for (const one of m[1].split(/\s+/)) {
      assert.ok(new RegExp("\\.boardtbl[^{]*\\." + one + "\\s*\\{[^}]*width:").test(html),
        `index.html 里没有 .${one} 的列宽规则：这一列会按内容乱宽`);
    }
  }
});
/* ---------- v49：玻璃皮肤之下的宽度预算 ---------- */
/* index.html 里「全部 / 精简」两套列宽 + min-width 是量出来的预算表，不是估的：
   360 视口下 boardWrap 的 clientWidth = 330px（Playwright 实测），6 列必须排得进去
   （v54 起「全部」是 6 列：持有天数按用户要求删掉了）。
   超出哪怕 2px 就变成横滑，而 v49 要解决的正是「一屏看完」。
   v52 把 .board-edge 往外顶到卡片内边距（margin:0 -16px），带子从 298 涨到 330 ——
   这里必须跟着实测值改，不然预算表悄悄松了 32px，谁都不会发现。
   带子里侧还有 .board-plate 左右各 6px（字不能真贴着带子边），表格实得 318px。
   改任何一条宽度都得同时改 min-width，否则这里立刻红。 */
const AVAIL_360 = 330;
const AVAIL_320 = 290;

/* plate 的左右内边距：带子铺到卡片边缘，字往里缩这一点，预算得跟着扣 */
function platePadX(html) {
  const m = html.match(/\.board-plate\{[^}]*?padding:0 (\d+)px/);
  assert.ok(m, "找不到 .board-plate 的左右内边距：预算跟它绑在一起，改了 CSS 这里要一起改");
  return +m[1];
}

/* 把 .boardtbl .c-xxx{width:NNpx} 这类规则读成 {类名: 宽度}；mode 决定读哪一档 */
function cssWidths(html, mode) {
  const re = new RegExp("\\.boardtbl" + (mode === "lean" ? "\\.lean" : "")
    + " \\.(c-[a-z-]+)\\s*\\{[^}]*?width:(\\d+)px", "g");
  const out = {};
  let m;
  while ((m = re.exec(html))) out[m[1]] = +m[2];
  /* 4 条规则 = c-nm / c-wan / c-a / c-zero：三列年化共用 .c-a，所以「6 列」在这里只有 4 个类名。
     少于 4 条就是解析脱靶（比如类名改了、或者规则被并进了简写），预算会变成静默的空检查。 */
  assert.ok(Object.keys(out).length >= 4, `index.html 里只读到 ${Object.keys(out).length} 条列宽规则，解析方式该跟着 CSS 改了`);
  return out;
}
function cssMinWidth(html, mode) {
  const m = html.match(mode === "lean"
    ? /\.boardtbl\.lean\s*\{[^}]*?min-width:(\d+)px/
    : /\.boardtbl\s*\{[^}]*?min-width:(\d+)px/);
  assert.ok(m, `index.html 里找不到${mode === "lean" ? "精简" : "全部"}那一档 .boardtbl 的 min-width`);
  return +m[1];
}
/* key → 类名（BD_CLS 是 app.js 里那张平铺表） */
function clsKeyMap() {
  const body = mapBody("BD_CLS");
  const out = {};
  for (const c of BOARD_COLS) {
    const m = body.match(new RegExp(`${c[0]}\\s*:\\s*"([^"]+)"`));
    assert.ok(m, `BD_CLS 缺列 ${c[0]}`);
    out[c[0]] = m[1].split(/\s+/)[0];
  }
  return out;
}

test("产品收益表：「全部」6 列的宽度预算必须塞得进 360 屏", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const cls = clsKeyMap();
  for (const mode of ["full", "lean"]) {
    const w = cssWidths(html, mode);
    const keys = mode === "full" ? BOARD_COLS.map(c => c[0]) : BOARD_LEAN;
    const total = keys.reduce((s, k) => {
      const c = cls[k];
      assert.ok(w[c] > 0, `index.html 没给${mode === "lean" ? "精简" : "全部"}模式的 .${c} 定宽：这一列会按内容乱宽`);
      return s + w[c];
    }, 0);
    const min = cssMinWidth(html, mode);
    assert.equal(total, min, `${mode} 列宽合计 ${total} ≠ min-width ${min}：改了宽度要一起改 min-width`);
    const room = AVAIL_360 - 2 * platePadX(html);
    assert.ok(total <= room, `${mode} 合计 ${total}px > 360 屏表格实得 ${room}px（带子 ${AVAIL_360} − plate 左右 ${2 * platePadX(html)}），这张表又要横滑了`);
  }
});

test("产品收益表：年化列不带正号、|≥10%| 退一位小数（上面那份预算的前提）", () => {
  const cellBody = mapBody("BD_CELL");
  for (const k of ["a7", "a14", "a30"]) {
    const line = cellBody.split("\n").find(l => new RegExp(`^\\s*${k}:`).test(l)) || "";
    assert.ok(line, `BD_CELL 里找不到 ${k}`);
    assert.ok(/pctBd\(/.test(line), `${k} 没用 pctBd()：一个「+」就是 7px × 3 列，全部模式装不进 360 屏`);
    assert.ok(!/\bpct4\b|\bpctFmt\b|\bpct\(r\./.test(line), `${k} 用了带正号的格式化函数`);
  }
  const i = APP_SRC.indexOf("const pctBd =");
  assert.ok(i > 0, "app.js 里找不到 const pctBd =");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\n};", i) + 3);
  assert.ok(body.includes("\n};"), "pctBd() 没收尾，提取方式需要跟着改");
  assert.ok(!body.includes('"+"'), `pctBd() 里出现正号：${body}`);
  assert.ok(/Math\.abs\(p\)\s*>=\s*10\s*\?\s*p\.toFixed\(1\)/.test(body),
    "pctBd() 没在 |年化|≥10% 时退到一位小数：不退的话最坏串从「-12.3%」(43px) 变「-12.34%」(46px)，"
    + "再加三列就吃掉 9px，nowrap 会把「%」挤到隔壁那列的数字上");
});

test("产品收益表：粘在左边的首列必须是不透明底", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  /* 玻璃皮肤之后卡片是半透明的，横滑时后面那列的数字会从首列底下透出来（v47 实测现象）。
     首列必须垫一块实色 --plate，右侧渐影也要渐变到同一块颜色，不然会在表上留一道白边。 */
  const m = html.match(/\.boardtbl th:first-child,\.boardtbl td:first-child\s*\{([^}]*)\}/);
  assert.ok(m, "找不到首列规则：sticky 首列一旦没底，横滑就漏字");
  assert.ok(/background:\s*var\(--plate\)/.test(m[1]), "首列底色必须走 var(--plate)");
  for (const p of html.match(/--plate\s*:\s*[^;]+;/g) || []) {
    assert.ok(!/rgba\(/.test(p), `--plate 不能带 alpha：${p.trim()}`);
  }
  assert.ok(/\.board-fade\{[^}]*background:linear-gradient\(90deg,var\(--fade0\),var\(--fade1\)/.test(html.replace(/\s+/g, " ")),
    "渐影没渐变到 --fade1（= 板底色）：玻璃皮肤下会在表右缘留一块发白的边");
});

test("产品收益表：渐影跟着「滑到底」消失，默认门槛不高于 360", () => {
  const b = fnBody("bdEdge");
  assert.ok(/scrollLeft/.test(b) && /atEnd/.test(b),
    "bdEdge() 没算 scrollLeft：滑到最右边渐影还挂着，等于一直提示「还有列没露出来」的假信号");
  assert.ok(/addEventListener\("scroll",\s*bdEdge/.test(APP_SRC),
    "没接 scroll 事件：渐影只在重渲染时更新，用户手动滑的时候它不动");
  const m = fnBody("bdMode").match(/w >= (\d+)/);
  assert.ok(m, "bdMode() 里找不到视口门槛");
  assert.ok(+m[1] <= 360, `默认门槛 ${m[1]} > 360：主流屏又退回精简档，上面那份宽度预算白做`);
});

/* ---------- v54：底部 inset 也归页面管（原生 padding 挪不动 position:fixed） ---------- */
test("底部三处固定元素必须读 --safe-b：壳的 WebView padding 顶不动 fixed 底栏", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  /* v52 的修法是在原生侧给 WebView 加底部 padding，实测没用：fixed + bottom:0 贴的是
     可视视口的底，view padding 只压内容绘制区。现在和顶部同一套 —— 原生量完写成
     --safe-b，页面自己垫。这条测试和上面 --sb 那条是一对，两边都要有壳喂的值。 */
  const tb = html.match(/\.tabbar\{[^}]*padding:([^;]*);/);
  assert.ok(tb, "找不到 .tabbar 的 padding 规则：底部标签栏没垫 inset，就会被手势小白条压掉半截");
  assert.ok(/var\(--safe-b,\s*env\(safe-area-inset-bottom,\s*0px\)\)/.test(tb[1]),
    ".tabbar 下内边距必须优先读壳注入的 --safe-b、再落回 env()（WebView 里 env() 恒为 0）：" + tb[1]);
  const sh = html.match(/\.sheet\{[^}]*padding:([^;]*);/);
  assert.ok(sh && /var\(--safe-b/.test(sh[1]), "底部弹层 .sheet 没垫 --safe-b：最后一行按钮落在小白条底下");
  /* 正文的下边距也要跟着长：tabbar 高了，最后那张卡就得往下让同样的量 */
  const wrap = html.match(/\.wrap\{[^}]*padding:([^;]*);/);
  assert.ok(wrap && /var\(--safe-b/.test(wrap[1]), ".wrap 底部留白没跟着 --safe-b 长：最后那张卡会被垫高后的 tabbar 盖住");
  /* 原生侧的对应物在壳里（MainActivity.pushSafeInsets），这边只盯页面确实把值用上了 */
});

test("顶栏必须给状态栏留那一格：--sb 优先、env() 兜底", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const m = html.match(/\.topbar\{[^}]*padding:([^;]*);/);
  assert.ok(m, "找不到 .topbar 的 padding 规则");
  assert.ok(/var\(--sb,\s*env\(safe-area-inset-top,\s*0px\)\)/.test(m[1]),
    "顶栏上内边距必须优先读壳注入的 --sb、再落回 env()：Android WebView 里 env() 常常恒为 0，"
    + "只靠它标题会直接印在状态栏上（壳开 edge-to-edge 之后那一格是页面的）");
});

/* ---------- v52：表格铺满到卡片内边距 ---------- */
test("产品收益表：往外顶满靠负 margin，而且必须正好等于卡片内边距", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const card = html.match(/\.card\{([^}]*)\}/);
  assert.ok(card, "找不到 .card 规则");
  const pad = card[1].match(/padding:\s*(\d+)px/);
  assert.ok(pad, ".card 的 padding 不是单个像素值，下面那条负 margin 的读法要跟着改");
  const edge = html.match(/\.board-edge\{([^}]*)\}/);
  assert.ok(edge, "找不到 .board-edge 规则：这层是渐影的定位父级，删掉它渐影就没了");
  const mg = edge[1].match(/margin:\s*0\s+-(\d+)px/);
  assert.ok(mg, ".board-edge 必须是 margin:0 -NNpx：表格铺满到卡片内边距，多出来的 32px 全给数字列");
  assert.equal(+mg[1], +pad[1],
    `负 margin ${mg[1]}px ≠ 卡片 padding ${pad[1]}px：差几个像素就露几条白边，卡片改内边距时这里要一起改`);
});

test("产品收益表：首列基准宽不能再涨回去（用户要的就是名字窄、数字宽）", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const w = cssWidths(html, "full");
  assert.ok(w["c-nm"] <= 56, `全部模式首列基准 ${w["c-nm"]}px > 56px：v52 把表铺满之后名字列已经白拿 9~18px 松弛，`
    + "基准再涨就是在抢数字列的地盘，用户这两轮反馈说的就是这个");
  assert.ok(w["c-nm"] >= 40, `全部模式首列基准 ${w["c-nm"]}px < 40px：再窄一行放不下两个汉字，`
    + "名字就成省略号串了 —— 用户要的是「名字窄一点」，不是「名字没了」");
});

test("产品收益表：320 屏也得一屏看完 6 列（v52 铺满之后新拿下的预算）", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  /* 320 视口下 boardWrap 的 clientWidth 实测 290px：320 − .wrap 左右内边距 28 − 卡片
     左右内边距 32 − 卡片描边 2 + .board-edge 顶回去的 32。这一档以前要横滑 38px，
     铺满之后不用了，所以把它跟 360 那条一起钉住。
     v53 那版 278 + plate 左右 12 = 290，余量为 0；v54 删掉持有天数、万收收到两位之后
     六列合计 252 + 12 = 264，极窄屏终于有了 26px 余量。 */
  const cls = clsKeyMap();
  for (const mode of ["full", "lean"]) {
    const w = cssWidths(html, mode);
    const keys = mode === "full" ? BOARD_COLS.map(c => c[0]) : BOARD_LEAN;
    const total = keys.reduce((s, k) => s + w[cls[k]], 0);
    const room = AVAIL_320 - 2 * platePadX(html);
    assert.ok(total <= room,
      `${mode} 合计 ${total}px > 320 屏表格实得 ${room}px：极窄屏又退回横滑，上面那条预算的前提就没了`);
  }
});

/* ---------- v54：持有天数下线、万收两位小数 ---------- */
test("产品收益表：没有持有天数列，万收在表里只给两位", () => {
  /* 用户两条要求都是「看着烦」：持有天数不参与挑产品、万收第四位小数是噪声。
     显示位数变了，宽度预算跟着变（上面那两条预算测试读的就是新 CSS），
     所以这两件事得有独立的断言，不能只靠预算测试间接盯住。 */
  const cls = mapBody("BD_CLS");
  const cell = mapBody("BD_CELL");
  assert.ok(!/holdDays/.test(cls), "BD_CLS 里还有 holdDays：那一列已经按用户要求下线了");
  assert.ok(!/holdDays/.test(cell), "BD_CELL 里还有 holdDays：表里没有这一列，渲染函数不该再拼它");
  const wan = cell.split("\n").find(l => /^\s*wan:/.test(l)) || "";
  assert.ok(/wan2\(/.test(wan) && !/wan4\(/.test(wan), `表里的万收必须用 wan2()：${wan}`);
  /* 详情页维持四位：那是单只产品看精度的地方，没有宽度压力，两个口径各留一处 */
  assert.ok(/wan4\(wan\)/.test(APP_SRC), "详情页的万份收益不再用 wan4()：表里收到两位之后，四位只能在这里看");
  /* 两个 helper 是箭头函数常量，fnBody()（按顶层 function 切）取不到，直接认声明行 */
  const w2 = (APP_SRC.match(/^const wan2 = .*$/m) || [""])[0];
  const w4 = (APP_SRC.match(/^const wan4 = .*$/m) || [""])[0];
  assert.ok(/toFixed\(2\)/.test(w2), "wan2() 不是两位小数：" + w2);
  assert.ok(/toFixed\(4\)/.test(w4), "wan4() 不再是四位：" + w4);
});

test("产品收益表：数字列宽度不得低于 v54 实测最坏串（离屏 nowrap 量出来的）", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const w = cssWidths(html, "full");
  /* 这些数字来自 Playwright 实测：把最坏串放到表外的离屏探针上、white-space:nowrap、
     字体逐项取真单元格的 computed 值来量（探针脚本不在仓里，方法写在这里）。
     不能用子元素的 scrollWidth —— 被拉伸的格子里它恒等于格子宽，量出来永远是「刚好够」。 */
  const need = {
    "c-wan": 33,   /* wan2 最坏「-1.40」+ td 左右 4px */
    "c-a": 50,     /* pctBd 最坏「-123.4%」+ 4px（退一位小数后 ≥100% 仍是三位整数） */
    "c-zero": 21,  /* 表头「挂0 / 天」，内容最宽不过 2 位数 */
  };
  for (const [c, n] of Object.entries(need)) {
    assert.ok(w[c] >= n, `全部模式 .${c} 基准 ${w[c]}px < 实测下限 ${n}px：nowrap 之下多出来的像素会盖到邻列`);
  }
  /* 排序默认键：持有天数没了，默认落在 7 日年化上（用户最常看的一列） */
  assert.ok(/bdSort:\s*"a7"/.test(APP_SRC), "默认排序键不是 a7：持有天数下线后这是表里第一列数字，默认得落在它身上");
});

/* ---------- v53：更新判断的出口在界面上真的存在 ---------- */
test("设置页：判断不了版本时也要有「下载并安装」的出口", () => {
  /* updateVerdict 把 canInstall 交出来了，可按钮是 renderUpdBox 拼的 ——
     只改判断层不改这里，用户看到的还是一句「不替你决定」加一个点不动的界面。
     v52 那次就是这个组合：App 里没按钮，私有仓的 release 页在浏览器里又要登录。 */
  const box = fnBody("renderUpdBox");
  assert.ok(/UPD\.canInstall/.test(box),
    "renderUpdBox 没读 UPD.canInstall：判断层说的「可以给按钮」到不了界面");
  assert.ok(/st === "new"\s*\|\|\s*UPD\.canInstall/.test(box),
    "下载按钮还是只在 state 为 new 时出现：unknown 且云端有包时必须留一条路");
  const chk = fnBody("checkApkUpdate");
  assert.ok(/canInstall:\s*!!verdict\.canInstall/.test(chk),
    "checkApkUpdate 没把 canInstall 存进 UPD：重开设置页按钮就没了");
  const lv = fnBody("localApkVersion");
  assert.ok(/catch\s*\(\s*e\s*\)\s*\{?\s*return\s+"err:/.test(lv.replace(/\n\s*/g, " ")),
    "localApkVersion 不能把异常吞成空串：v52 那次查不下去，就是因为只剩「本机 空」这一条线索");
});

/* 从 `const NAME = {` 切到配对的 `\n};`：只用于本仓这两个平铺的查表常量 */
function mapBody(name) {
  const i = APP_SRC.indexOf(`const ${name} = {`);
  assert.ok(i > 0, `app.js 里找不到 const ${name} = {`);
  const j = APP_SRC.indexOf("\n};", i);
  assert.ok(j > i, `const ${name} = { 没有收尾`);
  return APP_SRC.slice(i, j + 3);
}

/* ---------- v55：资产月报与「我的持仓 · 持仓年化」 ----------
   这一组守的是接线，不是算法（算法在 tests/monthly.test.mjs）：
   弹层里的 class 有没有对应样式、内联 onclick 的函数有没有挂到 window、
   以及首页与月报是不是还在用同一份月收益公式。 */
const HTML55 = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("月报：弹层用到的每个 class 都得有样式，不然就是一堆裸文字", () => {
  const body = fnBody("renderMonthly");
  const used = new Set();
  for (const m of body.matchAll(/class="([^"$]+)"/g)) {
    for (const t of m[1].trim().split(/\s+/)) if (t) used.add(t);
  }
  /* chip 的选中态由模板拼出来的 `${k === ym ? " on" : ""}`，单独补进来 */
  used.add("on");
  assert.ok(used.size >= 12, `只读到 ${used.size} 个 class 名：月报模板是不是被删了`);
  const miss = [...used].filter(c => !new RegExp("\\." + c + "[\\s{,:>.]").test(HTML55));
  assert.deepEqual(miss, [], `这些 class 在 index.html 里没有样式规则：${miss.join(", ")}`);
});

test("月报：入口在内联 onclick 里调用，函数就必须挂到 window", () => {
  /* ES module 的顶层声明不再自动进 window —— 漏一个导出就是点一下报一次
     ReferenceError，而且只在真机上、页面已经渲染完之后才看得见。 */
  const bridge = APP_SRC.slice(APP_SRC.indexOf("Object.assign(window, {"));
  assert.ok(bridge.slice(0, 2000).includes("openMonthly"), "openMonthly 没进 window 桥：首页入口点不动");
  assert.ok(bridge.slice(0, 2000).includes("setRepMonth"), "setRepMonth 没进 window 桥：月份芯片点不动");
  assert.ok(/onclick="openMonthly\(\)"/.test(HTML55), "首页没有资产月报入口");
  assert.ok(/id="monthlyHint"/.test(HTML55), "入口没有提示行元素：renderHome 无处写月份与收益");
  assert.ok(/\$\("monthlyHint"\)/.test(fnBody("renderHome")),
    "renderHome 不刷新入口提示：改完数据那行字还停在旧月份");
});

test("我的持仓：持仓年化紧跟在持仓收益后面，不足 7 天不给数", () => {
  const b = fnBody("renderProdDetail");
  const i = (t) => b.indexOf(t);
  assert.ok(i("持仓收益") > 0 && i("持仓年化") > i("持仓收益") && i("持仓份额") > i("持仓年化"),
    "持仓年化没排在持仓收益之后（用户要求的位置）");
  assert.ok(/annualValid \? shown\(pct\(pos\.holdAnnual\)\)/.test(b),
    "持仓年化没走 annualValid / shown：不足 7 天会给出夸张年化，隐藏时还会明文");
  assert.ok(/持有不足 7 天/.test(b), "不足 7 天时要有替代文案，不能显示 0.00%");
});

test("月收益只有一份实现：首页与月报共用 monthly.js", () => {
  /* v55 把 monthProfit / marketOn 的循环本体搬进 js/domain/monthly.js。
     谁要是再在 app.js 里手写一遍「份额 × 净值差」，首页与月报就会算出两个数 ——
     而这两个数就摆在同一屏上。 */
  assert.ok(/productMonthDays\(p, DATA\.trades/.test(fnBody("monthProfit")),
    "monthProfit 不再复用 productMonthDays：月收益出现了第二份实现");
  assert.ok(/marketOnAt\(DATA\.products, DATA\.trades/.test(fnBody("marketOn")),
    "marketOn 不再复用 monthly.js：年化分母出现了第二份实现");
  assert.ok(!/navSeries\(p\)[\s\S]{0,200}?i === 0/.test(fnBody("monthProfit")),
    "monthProfit 里又出现了逐日循环");
});

test("月报：收益构成按产品列，资产构成仍按机构", () => {
  /* 用户的要求是「显示具体哪个产品名称」。byProd 的口径（只列当月有变动的、
     清仓的也在、按 |收益| 排序）由 tests/monthly.test.mjs 盯着，
     这里只钉界面确实接的是那份数据 —— 接错回 byInst 就等于把要求改回去了。 */
  const b = fnBody("renderMonthly");
  assert.ok(/profitShares\(r\.byProd\)/.test(b), "占比用的不是 byProd");
  assert.ok(/r\.byProd\.map/.test(b), "条形行不是按产品生成的");
  assert.ok(!/r\.byInst\.map/.test(b), "收益构成又接回机构聚合了");
  assert.ok(/r\.byInst\.filter\(x => x\.asset > 0\)/.test(b),
    "资产构成环应该还是按机构聚合（对照用）");
  assert.ok(/期末已清仓/.test(b), "期末没市值的产品要在条上标出来，否则看不出它为什么不在环里");
  /* 副标题只补名字里没说出来的部分：机构名（产品名通常自带，再跟一遍是噪声）
     与「期末已清仓」（必须标）。这两条写在模板里，钉住别改回无脑追机构名。 */
  assert.ok(/x\.label\.indexOf\(x\.inst\) < 0/.test(b), "副标题没判重：名字带机构的产品会被再念一遍机构名");
  assert.ok(/if \(!x\.asset\) bits\.push\("期末已清仓"\)/.test(b), "清仓标记丢了");
  assert.ok(/<div class="nm" title="\$\{esc\(x\.label\)\}"/.test(b),
    "两行放不下的长名字没有 title 可看全文");
});

test("弹层：返回手势能关掉二级页面（压一条历史哨兵）", () => {
  /* 手机返回手势 / 返回键在壳里走 MainActivity.onBackPressed：canGoBack 就 goBack。
     所以网页要让「弹层开着」这件事在历史里占一条，返回才有关的东西可退；
     没有这条哨兵，一次返回就是直接退出 App（用户反馈过的手感问题）。 */
  const open = fnBody("openSheet");
  const close = fnBody("closeSheet");
  const push = fnBody("sheetPush");
  assert.ok(/sheetPush\(\)/.test(open) && /history\.pushState\(/.test(push),
    "openSheet 没往历史压哨兵：返回手势会直接退出 App");
  assert.ok(/classList\.add\("show"\)/.test(open), "openSheet 不显示遮罩了？");
  assert.ok(/if \(sheetSentinel\) return/.test(open),
    "重复压哨兵会让一次手势只关掉一半（弹层是互相替换的，只该有一条）");
  assert.ok(/try \{/.test(push) && /catch \(/.test(push),
    "pushState 在隐私模式 / file:// 会抛，不兜住就是整个弹层打不开");
  assert.ok(/sheetSentinel = seq/.test(push), "pushState 成功才算压上（失败时绝不能去 history.back）");
  assert.ok(/if \(!sheetSentinel\) return/.test(close), "没压上哨兵就不许退历史，否则整页被退走");
  assert.ok(/sheetSentinel = 0; sheetPopPending = true;\s*\n\s*history\.back\(\)/.test(close),
    "closeSheet 要把那条哨兵退掉，否则历史里留一条空记录，返回键会「按一下没反应」");
  assert.ok(/addEventListener\("popstate"/.test(APP_SRC), "没有 popstate：返回手势关不掉弹层");
  const pop = APP_SRC.slice(APP_SRC.indexOf('addEventListener("popstate"'));
  assert.ok(/sheetPopPending = false/.test(pop),
    "popstate 要认出「是 closeSheet 自己退的」，否则点 ✕ 会被当成用户按了返回二次处理");
  assert.ok(!/history\.back\(\)/.test(pop.slice(0, 700)),
    "popstate 里再 back 就是二次退栈：用户按一次返回会多退一层，页面直接走掉");
  /* 同一拍里「先关再开」：back 是异步的，立刻 push 会被那条迟到的 back 打掉新弹层
     （手机上就是「点开就闪回去」）。补压必须等 popstate 落地、且弹层确实还开着。 */
  assert.ok(/if \(sheetPopPending\) \{ sheetWantPush = true; return; \}/.test(open),
    "退栈还没落地就 push：新开的弹层会被上一次 closeSheet 的 back 关掉");
  assert.ok(/if \(sheetWantPush\)[\s\S]{0,200}classList\.contains\("show"\)[\s\S]{0,60}sheetPush\(\)/.test(pop),
    "popstate 里没做补压（或补压前没确认弹层还开着）");
});

test("弹层：同一拍里先关再开，新弹层不许被上一次退栈关掉", () => {
  /* 这条是 v56 真正的坑：history.back() 是异步的。closeSheet() 之后紧跟着再开一个弹层
     （保存完重开表单、翻月份）时，如果 openSheet 立刻 pushState，那条迟到的 back
     会落在新哨兵身上 —— 弹层自己把自己关掉，手机上就是「点开就闪回去」。
     所以补压要等 popstate 落地。这里同时钉住两种终态：
       正常路径：back 落地后新弹层仍开着、并且重新占了一条哨兵；
       降级路径（压不上 history）：不崩、也不会去 back 把整页退走。 */
  const open = fnBody("openSheet");
  assert.ok(/sheetPopPending/.test(open) && /sheetWantPush = true/.test(open),
    "openSheet 没等上一次退栈落地就压哨兵");
  const push = fnBody("sheetPush");
  assert.ok(/catch \(e\) \{ sheetSentinel = 0; \}/.test(push),
    "pushState 抛异常时要把标记清零：留着就会去 back 一个根本没压上的条目");
  assert.ok(!/history\.back\(\)/.test(push), "压哨兵的地方不该退历史");
});

/* ---------- v57：秒讯 / 净值账本只在 App 内出现 ----------
   这两个站都不给跨域许可，网页版发出去必被浏览器拦死（实测：aixhub 的
   /api/auth/send-code 预检 OPTIONS 回 501，带 Origin 的 GET/POST 响应里没有
   Access-Control-Allow-Origin；ledgerme 一样）。产品决定是「网页端不做这个功能」，
   那网页版就不该摆着两个点了只会回一句「仅 App 可用」的按钮。 */

test("秒讯/净值账本：网页版整节收掉，靠 <html>.inApp + CSS，不靠逐个 display:none", () => {
  const sync = fnBody("syncAppOnly");
  /* v59 起「在不在 App 里」是三层判定（本机壳 origin / 桥 / 认出来过就记住），
     这条只钉住「类是由它决定的」这件事，具体三层见下面的 v59 测试 */
  assert.ok(/classList\.add\("inApp"\)/.test(sync) && /classList\.remove\("inApp"\)/.test(sync),
    "syncAppOnly 不再按 App / 网页来加减这个类了");
  assert.ok(/nativeFetchAvailable\(\)/.test(sync), "这个类不再参考本机桥");
  /* 类要在渲染设置页时刷新：桥是 onPageStarted 注入的，脚本第一行时不一定已经在了，
     所以不能只在 init 里判一次 */
  assert.ok(/syncAppOnly\(\)/.test(fnBody("renderSet")), "renderSet 没同步这个类");
  assert.ok(/syncAppOnly\(\)/.test(fnBody("renderAixhub")), "renderAixhub 没同步");
  assert.ok(/syncAppOnly\(\)/.test(fnBody("renderLedgerme")), "renderLedgerme 没同步");
  /* 卡片标题是 index.html 里的静态 HTML：藏必须发生在 CSS，等 JS 填内容再藏会闪 */
  assert.ok(/html:not\(\.inApp\) \.app-only\{display:none\}/.test(HTML55),
    "index.html 里没有 html:not(.inApp) .app-only 这条规则");
  const cards = HTML55.match(/<div class="card app-only">[\s\S]{0,120}?id="(aixhubBox|ledgermeBox)"/g) || [];
  assert.equal(cards.length, 2, "两个 App 专属卡片没都带上 app-only 类");
});

test("秒讯/净值账本：网页版不渲染内容，也不起那个 6 小时一次的自动检查", () => {
  for (const [name, chk] of [["renderAixhub", "aixhubCheck(true)"], ["renderLedgerme", "ledgermeCheck(true)"]]) {
    const b = fnBody(name);
    const guard = b.indexOf('if (!nativeFetchAvailable()) { box.innerHTML = ""; return; }');
    assert.ok(guard > 0, `${name} 没有「无桥就清空并返回」的守卫`);
    const timer = b.indexOf(chk);
    assert.ok(timer > guard,
      `${name} 的自动检查定时器排在了守卫前面：网页版会一直空转并弹「仅 App 可用」`);
  }
  /* 兜底提示留着是对的：老缓存 / 别人把页面搬进别的容器时仍可能点到，但要说清原因 */
  const guards = APP_SRC.match(/只在 Android App 内可用（[^）]*）/g) || [];
  assert.ok(guards.length >= 2,
    `兜底提示只剩 ${guards.length} 条：两个登录入口各该留一条（老缓存里仍可能点到）`);
  for (const g of guards) {
    assert.ok(/本机桥|跨域/.test(g), `兜底文案没解释为什么只能在 App 里用：${g}`);
  }
});

test("网页版可见的文案里不许出现「去设置 → 秒讯登录」这种指路", () => {
  /* 入口收掉之后，文案不能再把它指给用户（网页版点了只会得到一句「仅 App 可用」）。
     标准：这句话所在的顶层函数必须自己就带本机桥守卫 —— 要么文案出在
     nativeFetchAvailable() 为真的分支里（渲染函数），要么整条路径只在 App 内可达
     （nativeFetchAll，判桥在调用方：triggerFetch 与 __nativeAutoFetch）。 */
  const APP_ONLY = ["nativeFetchAll"];
  const topFnAt = i => {
    const a = APP_SRC.lastIndexOf("\nfunction ", i), b = APP_SRC.lastIndexOf("\nasync function ", i);
    const s = Math.max(a, b);
    assert.ok(s >= 0, `偏移 ${i} 落在某个函数外面，没法判断它什么时候会被执行`);
    return APP_SRC.slice(s, s + 120).split("(")[0].replace(/^\n(?:async )?function /, "").trim();
  };
  const hits = [...APP_SRC.matchAll(/「设置 → 秒讯」/g)];
  assert.ok(hits.length >= 3, `只读到 ${hits.length} 处「设置 → 秒讯」：锚点文案被删了要同步改这条`);
  for (const h of hits) {
    const name = topFnAt(h.index);
    if (APP_ONLY.includes(name)) continue;
    assert.ok(/nativeFetchAvailable\(\)/.test(fnBody(name)),
      `「设置 → 秒讯」在 ${name}() 里没被本机桥判断挡住（偏移 ${h.index}）：网页版会看得见`);
  }
  /* App-only 那条路径的前提要一直成立：判桥的是调用方，不是它自己 */
  assert.ok(/if \(nativeFetchAvailable\(\)\) return nativeFetchAll\(true\)/.test(fnBody("triggerFetch")),
    "triggerFetch 不再先判桥就直接本机抓取了：网页版会走进 nativeFetchAll");
  const auto = APP_SRC.slice(APP_SRC.indexOf("window.__nativeAutoFetch = function"));
  assert.ok(/if \(!nativeFetchAvailable\(\)\) return;/.test(auto.slice(0, 400)),
    "__nativeAutoFetch 少了那句「没桥直接返回」");
});

/* ---------- v58：历史净值表的万份收益列 + 秒讯到期不再本地跳过 ---------- */

test("产品详情：历史净值表加一列万份收益，取的是 st.wan，不在表里另算一遍", () => {
  const body = fnBody("renderProdDetail");
  const heads = [...body.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(heads, ["日期", "单位净值", "日涨跌", "万份收益", "7日年化"],
    `表头漂了：${heads.join(" / ")}`);
  const tds = (body.match(/<tr>\s*\n\s*<td>/g) || []).length;
  assert.equal(tds, 1, "历史净值表的行模板被改散了（应是一段 <tr> 起头）");
  const cells = (body.slice(body.indexOf("const rows = []"), body.indexOf("const chartHtml"))
    .match(/<td/g) || []).length;
  assert.equal(cells, heads.length, `行里有 ${cells} 个 td，表头 ${heads.length} 个 th，对不上`);
  /* 口径只许存在一处：卡片上的「万份收益（最新）」就是 st.wan 的末位 */
  assert.ok(/const w = st\.wan\[i\]/.test(body), "万份收益列不是取 st.wan[i]");
  assert.ok(/wan2\(w\)/.test(body), "列里没走 wan2（和产品收益表那个两位小数口径漂开）");
  assert.ok(!/\*\s*10000/.test(body), "详情里又算了一遍万份收益：口径要在 navStats 一处");
  assert.ok(/万份收益为折算口径/.test(body), "表头 hint 要说明这是折算口径，官方并不披露这一项");
});

test("秒讯：会员到期不再本地跳过，抓不到才提示；也不再每次打开弹状态 toast", () => {
  const body = fnBody("nativeFetchAll");
  assert.ok(/const aixOn = !!aixhubToken\(\);/.test(body),
    "本机抓取还在按本机缓存的到期状态决定要不要问秒讯");
  assert.ok(!/aixLi\.expired/.test(body), "到期判断又回到抓取路径里了");
  assert.ok(!/toast\(\s*["'`][^"'`]*跳过秒讯/.test(APP_SRC),
    "「这次跳过秒讯」那句提示又回来了：本机抓取是自动跑的，这等于每次打开都弹一次");
  /* 失败仍然要报，而且要分得清是会员问题还是登录失效 */
  assert.ok(/if \(aixErr && withAixhub\)/.test(body), "抓取失败不再提示了");
  assert.ok(/\/403\|会员\|权限\//.test(body), "会员/权限那条判断丢了");
  assert.ok(/lsDel\(AIX_LS\.token\)/.test(body), "401（真·登录失效）仍要清掉本地 token");
  /* 到期状态只在界面上说（提示文案、卡片配色），不再替用户决定抓不抓 */
  const topFnAt2 = i => {
    const s = Math.max(APP_SRC.lastIndexOf("\nfunction ", i), APP_SRC.lastIndexOf("\nasync function ", i));
    assert.ok(s >= 0, `偏移 ${i} 落在函数外面`);
    return APP_SRC.slice(s, s + 120).split("(")[0].replace(/^\n(?:async )?function /, "").trim();
  };
  const strays = [...APP_SRC.matchAll(/li\.expired/g)].map(m => topFnAt2(m.index));
  assert.ok(strays.length >= 4, `只读到 ${strays.length} 处到期判断，锚点变了要同步改这条`);
  for (const fn of strays) {
    assert.ok(["aixhubCheck", "aixhubLoginFlow", "renderAixhub"].includes(fn),
      `到期状态又跑到 ${fn}() 里参与决策了：抓取路径只看有没有 token`);
  }
});

/* ---------- v59：设置里那两节「有时候消失」 ---------- */

test("App-only 判定不再只看「按下这一刻桥在不在」：本机壳 origin + 认出来不反悔 + 排队重试", () => {
  const b = fnBody("syncAppOnly");
  /* 1) 结构性信号：壳只给自己的 origin 挂桥，Pages 那个 origin 永远不可能有桥 */
  assert.ok(/inShellHost\(\) \|\| nativeFetchAvailable\(\)/.test(b),
    "判定还是只信桥：桥晚到一步这两节就整会话不见了");
  assert.ok(/const SHELL_HOST = "appassets\.androidplatform\.net";/.test(APP_SRC),
    "SHELL_HOST 要和私有仓 MainActivity.HOST 同一个值，改那边要跟这里");
  assert.ok(/function inShellHost\(\)/.test(APP_SRC), "inShellHost() 没了");
  /* 2) 认出来过一次就不反悔：中途一次抖动不许把两节收掉 */
  assert.ok(/appOnlySeen = true;/.test(b) && /if \(appOnlySeen\) return;/.test(b),
    "「已经认出在 App 里」这件事没被记住");
  /* 3) 没认出来时排队重试，桥一到就补上 */
  assert.ok(/if \(!appOnlyTimer\) armAppOnlyRetry\(\);/.test(b), "少了排队重试");
  const r = fnBody("armAppOnlyRetry");
  assert.ok(/setInterval\(/.test(r), "重试不是定时的");
  assert.ok(/>= 12/.test(r) && /clearInterval\(appOnlyTimer\)/.test(r),
    "重试没有上限或不会自停：网页版会一直空转");
  assert.ok(/renderSet\(\)/.test(r), "桥补上后只补了类、没重画 —— 那两节的内容是被守卫清空过的");
  /* 旧写法（单时刻 toggle）不许回来 */
  assert.ok(!/classList\.toggle\("inApp", nativeFetchAvailable\(\)\)/.test(APP_SRC),
    "又回到一次性 toggle 了：这正是一次判空就整会话看不见的成因");
});

test("放宽只用于显示，不许用于真调用：登录 / 抓取 / 内容渲染仍然只信桥", () => {
  /* inShellHost 是个「看得见这两节」的宽松信号，只许待在显示判定那条链上。
     一旦它去 gate 真实调用，网页版就会走进一条必然被 CORS 拦死的路。 */
  const topFnAt3 = i => {
    const a = APP_SRC.lastIndexOf("\nfunction ", i), b2 = APP_SRC.lastIndexOf("\nasync function ", i);
    const s = Math.max(a, b2);
    assert.ok(s >= 0, `偏移 ${i} 落在某个函数外面`);
    return APP_SRC.slice(s, s + 120).split("(")[0].replace(/^\n(?:async )?function /, "").trim();
  };
  const hits = [...APP_SRC.matchAll(/inShellHost\(\)/g)].map(m => topFnAt3(m.index));
  assert.ok(hits.length >= 3, `只读到 ${hits.length} 处 inShellHost()，锚点变了要同步改这条`);
  for (const fn of hits) {
    assert.ok(["syncAppOnly", "armAppOnlyRetry", "inShellHost"].includes(fn),
      `inShellHost() 跑到 ${fn}() 里参与决策了：显示可以宽松，调用必须判桥`);
  }
  /* 真调用那几处仍然判桥 */
  assert.ok(/if \(nativeFetchAvailable\(\)\) return nativeFetchAll\(true\)/.test(fnBody("triggerFetch")),
    "triggerFetch 改成了宽松判定");
  assert.ok(/if \(!nativeFetchAvailable\(\)\) return;/.test(
    APP_SRC.slice(APP_SRC.indexOf("window.__nativeAutoFetch = function"),
      APP_SRC.indexOf("window.__nativeAutoFetch = function") + 400)),
    "__nativeAutoFetch 少了那句「没桥直接返回」");
  for (const name of ["renderAixhub", "renderLedgerme"]) {
    assert.ok(/if \(!nativeFetchAvailable\(\)\) \{ box\.innerHTML = ""; return; \}/.test(fnBody(name)),
      `${name} 的内容守卫改信宽松判定了`);
  }
});

/* ---- 测试清单本身也要有门禁（v61）----
   曾经出过「测试文件只加进了 package.json，CI 的显式 node --test 清单没同步」，
   结果是本地绿、线上那个文件从没跑过 —— 这种错不会让任何测试变红，只能靠对账。 */
test("npm test 与 CI 的 node --test 清单是同一批文件", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const listed = s => (s.match(/tests\/[A-Za-z0-9_.-]+\.mjs/g) || []);
  const a = listed(pkg.scripts.test), b = listed(ci);
  assert.ok(a.length >= 11, `测试文件只有 ${a.length} 个，短到不对劲`);
  assert.deepEqual(b, a, "CI 与 npm test 跑的不是同一批（顺序也要对齐，方便对账）");
});
