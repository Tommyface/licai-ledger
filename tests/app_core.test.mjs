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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fmtDate } from "../js/core/util.js";
import { ORG_ALIAS, ORG_NAME, detectOrg, detectOrgByProdCode, prodCodeOf, fetchStatus,
       isRegCode, regCodeOf, regCodeFromCloud } from "../js/core/orgs.js";
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
const MASK_FN = [...TONE_FN, "renderProdDetail", "adviceCard", "switchCard"];   /* renderMonthly / monthlyHintText 已随 TONE_FN 进入；adviceCard（v74 现在赎的话）露三个金额，switchCard（v75 换到另一只的话）再露两笔钱加三个年化 */

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
   360 视口下 boardWrap 的 clientWidth = 330px（Playwright 实测），7 列必须排得进去
   （v54 起删掉持有天数，v99 又按用户要求加回一列「净值披露日」）。
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
  /* v99：c-nm / c-wan / c-a / c-zero / c-nd 共 5 个类名（三列年化共用 .c-a，「7 列」只有 5 个类名）。
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

test("产品收益表：「全部」7 列的宽度预算必须塞得进 360 屏", () => {
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

/* ---------- v99 · 列间距（用户拍板：走精简档，几列之间的间距调一下） ---------- */
test("v99 列间距：padding 与列宽同步放大，内容区宽度不许被挤小", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const th = html.match(/\.boardtbl th\{[^}]*padding:5px (\d+)px/);
  const td = html.match(/\.boardtbl td\{[^}]*padding:6px (\d+)px/);
  assert.ok(th && td, "找不到 th / td 的左右内边距规则：列间距没有唯一落点");
  const pad = +th[1];
  assert.equal(+td[1], pad, "th 与 td 左右内边距必须一致，否则表头和单元格对不齐");
  assert.ok(pad >= 3, `列间距仍是基线的 4px（padding ${pad}px × 2），间距没调整`);
  /* 全局 box-sizing:border-box —— 加 padding 会吃掉内容区。列宽必须同步补 2×(pad−2)px，
     否则最坏串「-123.4%」会被 white-space:nowrap 挤到隔壁列（v47 实测现象）。
     下面按 padding=2 基线的内容区逐项钉死，不许靠肉眼判断「看起来还行」。 */
  const expectFull = { "c-nm": 44, "c-wan": 29, "c-a": 46, "c-zero": 17, "c-nd": 32 };
  const expectLean = { "c-nm": 126, "c-wan": 30, "c-a": 46, "c-zero": 24 };
  const wFull = cssWidths(html, "full");
  const wLean = cssWidths(html, "lean");
  for (const [cls, content] of Object.entries(expectFull)) {
    assert.equal(wFull[cls] - 2 * pad, content,
      `全部档 .${cls} 内容区被挤成 ${wFull[cls] - 2 * pad}px（基线 ${content}px）：列宽要跟着 padding 一起加`);
  }
  for (const [cls, content] of Object.entries(expectLean)) {
    assert.equal(wLean[cls] - 2 * pad, content,
      `精简档 .${cls} 内容区被挤成 ${wLean[cls] - 2 * pad}px（基线 ${content}px）`);
  }
  assert.equal(cssMinWidth(html, "full"), 302, "全部档 min-width 要跟着列宽改成 302px");
  assert.equal(cssMinWidth(html, "lean"), 250, "精简档 min-width 要跟着列宽改成 250px");
});

test("产品收益表：320 屏默认精简档一屏看完；全部档加列后横滑，渐影必须在", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  /* 320 视口下 boardWrap 的 clientWidth 实测 290px，实得 278px（扣 plate 左右 12）。
     v99 加第 7 列「净值披露日」、列间距调整后，「全部」档 302px 已超过这 278px，
     物理上塞不进 —— 不虚改实测常量、也不删测试，而是把约束如实收窄：
       ① 320 屏 w<350 默认走精简（bdMode），精简档必须仍一屏看完；
       ② 「全部」档在 320 屏允许横滑，但右边渐影必须还在（提示用户还能往右滑）；
       ③ 新列只许出现在「全部」档，不许混进精简档（否则默认档直接横滑）。
     360 主流屏（实得 318px）两档都要一屏看完，由上面那条 360 测试钉住。 */
  const cls = clsKeyMap();
  const room = AVAIL_320 - 2 * platePadX(html);
  const wLean = cssWidths(html, "lean");
  const leanTotal = BOARD_LEAN.reduce((s, k) => s + wLean[cls[k]], 0);
  assert.ok(leanTotal <= room,
    `精简档合计 ${leanTotal}px > 320 屏表格实得 ${room}px：320 屏默认档横滑了`);
  assert.ok(BOARD_LEAN.indexOf("navAt") < 0,
    "新列混进了精简档：320 屏默认视图会直接横滑，应只在「全部」档出现");
  assert.ok(BOARD_COLS.some(c => c[0] === "navAt"), "「全部」档丢了净值披露日列");
  const wFull = cssWidths(html, "full");
  const fullTotal = BOARD_COLS.reduce((s, c) => s + wFull[cls[c[0]]], 0);
  assert.ok(fullTotal > room,
    `全部档合计 ${fullTotal}px 已能塞进 320 屏 ${room}px：说明列宽被压缩过头，回去核对 360 屏预算`);
  assert.ok(/\.board-fade\{/.test(html) && /addEventListener\("scroll",\s*bdEdge/.test(APP_SRC),
    "全部档在 320 屏会横滑，渐影与 scroll 监听就不许少：否则用户不知道右边还有列");
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
  /* v130：首页入口不显示小字 —— monthlyHint 挂点移除，renderHome 的写入保留容错。 */
  assert.ok(!/id="monthlyHint"/.test(HTML55), "首页还留着 monthlyHint 小字（v130 应移除）");
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
  const cards = HTML55.match(/<details class="card app-only[^"]*">[\s\S]{0,120}?id="(aixhubBox|ledgermeBox)"/g) || [];
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
  /* v90 加第 6 列「资产净值」；v92 由「口径 A 单值」升级为逐日序列。 */
  assert.deepEqual(heads, ["日期", "单位净值", "日涨跌", "万份收益", "7日年化", "资产净值"],
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

/* ---------- v92：历史净值表最右「资产净值」列（逐日序列） ---------- */
test("v92 资产净值列：每行读 assetHistory[该日]，没披露就「—」，换算不落在页面", () => {
  const body = fnBody("renderProdDetail");
  /* ① 唯一的命中判据：按行日期到逐日序列里取值。绝不允许把单一当前值铺满 20 行
        （v90 口径 A 的旧写法），也不许拿相邻日期的值补窟窿。 */
  assert.ok(/const dayVal = assetValueAt\(p, st\.dates\[i\]\)/.test(body),
    "每一格必须按 st.dates[i] 去 assetHistory 取当天的规模");
  assert.ok(/if \(dayVal\) avShown\+\+/.test(body), "命中计数要留给说明文案判断");
  assert.doesNotMatch(body, /st\.dates\[i\] === avDate/,
    "口径 A 的「只在披露日那行」判据不许回来：现在要逐日");
  /* ② 没值的那一格只能是「—」，绝不能显示 0 元或把规模重复贴上去 */
  assert.ok(/const assetCell = dayVal\s*\?[^:]+:\s*`<span class="muted">—<\/span>`/.test(body),
    "没披露那天必须是「—」：null 是不知道，0 是知道且为零，两回事");
  /* ②b 钉住实际输出位置 —— 只留定义、<td> 却写别的会绕过上面断言（假绿）。 */
  assert.ok(/<td class="assetcol">\$\{assetCell\}<\/td>/.test(body),
    "资产净值那一格必须输出 assetCell");
  /* ③ 金额换算走 disc.js 的 assetValueAt（内部复用唯一一份 assetAmount），页面不除 1e8 */
  assert.ok(/assetValueAt\(/.test(body), "金额要用 disc.js 的逐日紧凑串函数");
  assert.doesNotMatch(body, /\/\s*1e8|\/\s*1e4/, "页面里不许自己除 1e8 / 1e4 换算规模");
  /* ④ 出处标签来自 assetHistoryViaLabel，逐日序列要有一句口径说明 */
  assert.ok(/assetHistoryViaLabel\(ahVia\)/.test(body), "出处标签要走 disc.js 的唯一一份");
  assert.ok(/资产净值为当日披露规模（逐日序列/.test(body) && /assetCap/.test(body),
    "要写明这一列是逐日序列、来源是哪个披露方");
  /* ⑤ 旧账本/没抓到序列的产品优雅降级为整列「—」，并把 why 原样说出来 */
  assert.ok(/尚未抓到逐日资产净值序列/.test(body) && /资产净值这一格暂时空着/.test(body),
    "没序列时要降级说明，被闸门拦下的产品原样显示 why");
});

/* ---------- v68：万份收益口径统一（用户定：整段累计，不按自然日摊平） ---------- */

test("v68 口径：万份收益 = (今 − 上一披露日) × 10000，整段累计；间隔天数由 st.gap 一起交出去", () => {
  const body = fnBody("navStats");
  assert.ok(/const wan = vals\.map\(\(v, i\) => \(i === 0 \? null : \(v - Number\(vals\[i - 1\]\)\) \* 10000\)\);/.test(body),
    "万收公式漂了：只能是 (今 − 上一披露日) × 10000，一分都不能摊");
  assert.ok(/const gap = dates\.map\(\(d, i\) => \(i === 0 \? null : Math\.max\(dayDiff\(dates\[i - 1\]\, d\), 1\)\)\);/.test(body),
    "st.gap 没按自然日量出来（Math.max(…, 1) 也不能少：同一天两条披露不能写成 0 日）");
  assert.ok(/return \{[^}]*\bwan\b[^}]*\bgap\b/.test(body), "wan 与 gap 都得从 navStats 交出去，屏上才有的可写");
  /* 摊平那种写法不许回来 —— 它正是「详情页 −3.8967 / 明细 −11.53 / 盈亏 −80.92 三处对不上」的成因 */
  assert.ok(!/wan[\w.\[\]]*\s*\/\s*(?:gap|days|d\b|dayDiff)/.test(body),
    "万收又被除以天数了：乘回份额就不再等于当日盈亏");
  assert.ok(!/\/\s*dayDiff\(/.test(body), "同上：口径里出现 ÷ 自然日数");
});

test("v68 产品详情：跨几日的万收要在屏上写明，不许让人以为是一天的数", () => {
  const body = fnBody("renderProdDetail");
  assert.ok(/上一披露日/.test(body), "卡片 caption 没写比较对象：「今 − ? × 10000」");
  assert.ok(/未摊平/.test(body), "本段跨多日时没说明这一格是几天合计");
  assert.ok(/const gap = lastNum\(st\.gap\)/.test(body), "卡片没取最新那一格的间隔天数");
  assert.ok(/st\.gap\[i\] > 1/.test(body), "历史净值表行里的 ·N日 标记丢了：不写就是让人猜");
  /* 口径只允许存在一处：屏上任何「万收」都不许自己再乘一次 10000 */
  assert.ok((APP_SRC.match(/navStats\(/g) || []).length >= 2,
    "navStats 的调用点变少了 —— 各屏自己算一遍就是回到三把尺子");
});

test("v68 收益明细：分组行万收的分母是已确认份额，不是市值 —— 与详情同一把尺子", () => {
  const body = fnBody("renderDetailBody");
  assert.ok(/const shSum = arr\.reduce\(\(s, x\) => s \+ x\.shares, 0\);/.test(body),
    "分组行的分母不是份额了");
  assert.ok(/const wanG = shSum > 0 \? sum \/ shSum \* 10000 : 0;/.test(body),
    "万收 = 当日盈亏 ÷ 已确认份额 × 10000 这一句漂了");
  assert.ok(!/sum \/ \(?mkt|\/ pos\.value|\/ x\.pos\.value/.test(body),
    "分母又回到市值（钱）：那与净值差 × 10000（万份）永远差一个净值系数");
  /* 份额必须按「截至该日已确认」取，不能用今天的份额算过去 */
  assert.ok(/const sh = idx > 0 \? sharesOn\(r\.p, date\) : 0;/.test(body),
    "明细行的份额不是 sharesOn(p, date)");
  assert.ok(/万收 = 当日盈亏 ÷ 已确认份额 × 10000/.test(body),
    "title 里的口径说明没了：这一屏的数字必须带着自己的算法");
});

test("v68 措辞对账：看板列名与设置里的「口径说明」不许再提摊平", () => {
  /* 「摊平」这三个字现在只许出现在「不按自然日摊平」这一句里 ——
     单独禁掉整个词会把否定句也判死，那等于没在测口径。 */
  const flatOnlyNegated = (txt, where) => {
    assert.equal((txt.match(/摊平/g) || []).length, (txt.match(/不按自然日摊平/g) || []).length,
      `${where} 里出现了把摊平当算法说的句子：${txt}`);
  };
  /* BOARD_COLS 一行是 [key, 完整表头, 口径说明(title), 短表头1, 短表头2] */
  const row = BOARD_COLS.find(c => c[0] === "wan");
  assert.ok(row, "看板里没有 wan 这一列了 —— 这条对账要跟着改");
  const txt = row.slice(1).join(" ");
  assert.ok(!/间隔自然日数/.test(txt), `看板那一列还在提「间隔自然日数」：${txt}`);
  assert.ok(!/(?:÷|\/)\s*(?:间隔|天数|自然日)/.test(txt), "看板列的公式里出现了 ÷ 天数");
  assert.ok(/整段累计/.test(txt), "看板列名要与新口径一致（乘回份额 = 当日盈亏）");
  flatOnlyNegated(txt, "board.js 的 wan 列");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const at = html.indexOf("口径说明");
  assert.ok(at >= 0, "设置页的「口径说明」那一节没了");
  const sec = html.slice(at, at + 6000);
  assert.ok(!/÷\s*间隔自然日数|除以间隔/.test(sec), "设置页的口径说明还在教旧算法");
  assert.ok(/整段累计/.test(sec), "设置页要写「今 − 上一披露日 × 10000 · 整段累计」");
  flatOnlyNegated(sec, "index.html 的口径说明");
});

test("秒讯：会员到期不再本地跳过，抓不到才提示；也不再每次打开弹状态 toast", () => {
  const body = fnBody("nativeFetchAll");
  /* v78：这里只问原生侧「加密区里有没有」，页面手里再也没有那个值 */
  assert.ok(/const aixOn = aixhubLoggedIn\(\);/.test(body),
    "本机抓取又按本机缓存的到期状态决定要不要问秒讯，或者把登录态的值收回页面了");
  assert.ok(!/aixhubToken\(\)/.test(body), "抓取路径里又出现了「页面读 token」的写法");
  assert.ok(!/aixLi\.expired/.test(body), "到期判断又回到抓取路径里了");
  assert.ok(!/toast\(\s*["'`][^"'`]*跳过秒讯/.test(APP_SRC),
    "「这次跳过秒讯」那句提示又回来了：本机抓取是自动跑的，这等于每次打开都弹一次");
  /* 失败仍然要报，而且要分得清是会员问题还是登录失效 */
  assert.ok(/if \(aixErr && withAixhub\)/.test(body), "抓取失败不再提示了");
  assert.ok(/\/403\|会员\|权限\//.test(body), "会员/权限那条判断丢了");
  /* v78：401 时清的那一份在原生加密区里，页面只能请原生侧清 */
  assert.ok(/window\.NativeNav\.aixhubClear\(\)/.test(body),
    "401（真·登录失效）没请原生侧清掉加密区里的登录态");
  assert.ok(/aixhubPurgeLegacy\(\)/.test(body), "401 时忘了顺手删掉历史明文键");
  assert.ok(!/lsDel\(AIX_LS\.token\)/.test(APP_SRC),
    "页面又把 AIX_LS.token 当字段用了：v78 起这个键位不存在");
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

/* ---------- v78：秒讯登录态从 localStorage 搬进本机加密区（铁律 #6） ---------- */

test("v78：页面不再持有任何秒讯 token 的键位，历史明文键装载即删", () => {
  const s = APP_SRC.indexOf("const AIX_LS = {");
  const e = APP_SRC.indexOf("};", s);
  assert.ok(s > 0 && e > s, "AIX_LS 键位表的位置变了，切片失败");
  assert.ok(!/token/i.test(APP_SRC.slice(s, e)),
    "AIX_LS 里又有 token 键位了：值只能待在原生加密区");
  /* 整份 app.js 里带 token 字样的 localStorage 键名，只许那一个「见到就删」的历史键 */
  const named = [...new Set([...APP_SRC.matchAll(/["'`]licai\.[A-Za-z]*[Tt]oken["'`]/g)].map(m => m[0]))];
  assert.deepEqual(named, ['"licai.aixhubToken"'],
    "出现了新的 token 键名，或历史键名被改名（老用户磁盘上那份就删不掉了）：" + named.join(", "));
  const purge = fnBody("aixhubPurgeLegacy");
  assert.ok(/lsDel\(AIX_LEGACY_TOKEN\)/.test(purge), "历史明文键不是删掉");
  assert.ok(!/lsGet|lsSet/.test(purge), "purge 里居然还读/写历史键：删就是删，不读不传");
  /* 装载即删：定义完紧跟一次顶层调用，不等某次操作才清 */
  const at = APP_SRC.indexOf("function aixhubPurgeLegacy()");
  assert.ok(at > 0, "aixhubPurgeLegacy() 没了");
  assert.ok(/^function aixhubPurgeLegacy\(\) \{[^}]*\}\naixhubPurgeLegacy\(\);/.test(APP_SRC.slice(at, at + 120)),
    "历史明文键不是「脚本一装载就删」：升级上来的人在磁盘上又多躺了一天");
});

test("v78：登录态现问原生侧，桥不认识新方法时不许假装已登录", () => {
  const b = fnBody("aixhubLoggedIn");
  assert.ok(/typeof n\.aixhubHas !== "function"/.test(b), "没先确认原生侧认识这个方法就调用了");
  assert.ok(/return !!n\.aixhubHas\(\)/.test(b), "登录态不是原生侧现答的");
  assert.ok(!/lsGet|lsSet/.test(b), "aixhubLoggedIn 又开始缓存登录态了");
  /* 旧壳（桥在、但没有 aixhubHas）不能画成「没登录」—— 那是在骗人白重登一遍 */
  const o = fnBody("aixhubShellOld");
  assert.ok(/nativeFetchAvailable\(\)/.test(o), "旧壳判定不看桥在不在，网页版会被误判");
  assert.ok(/typeof window\.NativeNav\.aixhubHas !== "function"/.test(o), "旧壳判定的信号变了");
  for (const fn of ["aixhubLoginFlow", "renderAixhub"]) {
    assert.ok(/aixhubShellOld\(\)/.test(fnBody(fn)), `${fn}() 里没有旧壳这一支：v77 的壳会把 token 落回明文键`);
  }
  const flow = fnBody("aixhubLoginFlow");
  assert.ok(/v77 及以前的壳/.test(flow), "旧壳登录被拦下时没说是怎么回事");
  /* 登录回话里不许再有值，只有一个布尔 */
  assert.ok(/!r\.hasToken/.test(flow), "页面又开始拿登录回话里的 token 了");
  assert.ok(!/r\.token/.test(flow), "登录回话里还带着 token 字段");
});

test("v78：抓出去的那一轮由页面交布尔、原生侧注入值；aixhubMe 不带实参", () => {
  const body = fnBody("nativeFetchAll");
  const nf = fnBody("nativeNavFetch");
  assert.ok(/aixhub: !!withAixhub,/.test(nf), "抓取载荷又交的是值而不是布尔开关");
  assert.ok(!/aixhubToken/.test(nf), "抓取载荷里页面又自己填了 aixhubToken");
  assert.ok(!/aixhubToken/.test(body), "抓取路径里又出现了 aixhubToken");
  assert.ok(!/aixhubToken/.test(fnBody("aixhubBridge")), "桥调用包装层里出现了 token");
  /* aixhubMe 的形状：只认 reqId，页面手里没有可传的东西 */
  const me = [...APP_SRC.matchAll(/aixhubBridge\("aixhubMe",\s*([^\)]*)\)/g)].map(m => m[1]);
  assert.ok(me.length >= 2, "aixhubMe 的调用点比预期少，锚点变了要同步改这条");
  for (const arg of me) assert.equal(arg, "[]", "aixhubMe 又带实参了：登录态不该经过页面");
  /* 401 与退出都请原生侧清，并顺手删历史明文键 */
  for (const fn of ["aixhubCheck", "aixhubLogout"]) {
    const f = fnBody(fn);
    assert.ok(/NativeNav\.aixhubClear\(\)/.test(f), `${fn}() 没清掉加密区里那一份`);
    if (fn === "aixhubLogout") assert.ok(/aixhubPurgeLegacy\(\)/.test(f), "退出没顺手删历史明文键");
  }
});

test("v78：卡片文案说实话 —— 值在本机加密区，且不许出现「应该能用」", () => {
  const r = fnBody("renderAixhub");
  assert.ok(/Android Keystore/.test(r), "卡片没告诉用户登录态到底存在哪");
  assert.ok(/页面与浏览器都读不到它/.test(r), "卡片没把「页面读不到」这层说清楚");
  assert.ok(!/应该能用|应该可以|应该会/.test(r), "v78 的文案里出现猜测式表述");
});


/* ---------- v79：净值账本的会话 Cookie 从 localStorage 搬进本机加密区（铁律 #6） ----------
   这一半与 v78 是同一条铁律的第二次落地，测的也是那四类「构建全绿、只在用户手里漏」的写法。
   量的是公开仓这份 app.js 的字节：页面手里有没有那个值、旧壳说什么话、载荷交的是布尔还是值，
   都在这里钉住 —— Java 那侧由私有仓的 check_bridge_guard.py 钉。 */

test("v79：页面不再持有任何账本 Cookie 的键位，历史明文键装载即删", () => {
  const s = APP_SRC.indexOf("const LGM_LS = {");
  const e = APP_SRC.indexOf("};", s);
  assert.ok(s > 0 && e > s, "LGM_LS 键位表的位置变了，切片失败");
  assert.ok(!/cookie/i.test(APP_SRC.slice(s, e)),
    "LGM_LS 里又有 cookie 键位了：值只能待在原生加密区（铁律 #6）");
  /* 整份 app.js 里带 cookie 字样的 localStorage 键名，只许那一个「见到就删」的历史键 */
  const named = [...new Set([...APP_SRC.matchAll(/["'`]licai\.[A-Za-z]*[Cc]ookie["'`]/g)].map(m => m[0]))];
  assert.deepEqual(named, ['"licai.ledgermeCookie"'],
    "出现了新的 cookie 键名，或历史键名被改名（老用户磁盘上那份就删不掉了）：" + named.join(", "));
  const purge = fnBody("ledgermePurgeLegacy");
  assert.ok(/lsDel\(LGM_LEGACY_COOKIE\)/.test(purge), "历史明文键不是删掉");
  assert.ok(!/lsGet|lsSet/.test(purge), "purge 里居然还读/写历史键：删就是删，不读不传");
  /* 装载即删：定义完紧跟一次顶层调用，不等某次连接/断开才清 */
  const at = APP_SRC.indexOf("function ledgermePurgeLegacy()");
  assert.ok(at > 0, "ledgermePurgeLegacy() 没了");
  assert.ok(/^function ledgermePurgeLegacy\(\) \{[^}]*\}\nledgermePurgeLegacy\(\);/.test(APP_SRC.slice(at, at + 120)),
    "历史明文键不是「脚本一装载就删」：升级上来的人在磁盘上又多躺了一天");
});

test("v79：连接状态现问原生侧，旧壳不许画成「再粘一遍就好」", () => {
  const b = fnBody("ledgermeLoggedIn");
  assert.ok(/typeof n\.ledgermeHas !== "function"/.test(b), "没先确认原生侧认识这个方法就调用了");
  assert.ok(/return !!n\.ledgermeHas\(\)/.test(b), "连接状态不是原生侧现答的");
  assert.ok(!/lsGet|lsSet/.test(b), "ledgermeLoggedIn 又开始缓存 Cookie 了");
  /* 桥在、但没有 ledgermeHas = v78 及以前的壳：那种机器上这一路根本连不了 */
  const o = fnBody("ledgermeShellOld");
  assert.ok(/nativeFetchAvailable\(\)/.test(o), "旧壳判定不看桥在不在，网页版会被误判");
  assert.ok(/typeof window\.NativeNav\.ledgermeHas !== "function"/.test(o), "旧壳判定的信号变了");
  for (const fn of ["ledgermeLoginFlow", "renderLedgerme"]) {
    assert.ok(/ledgermeShellOld\(\)/.test(fnBody(fn)), `${fn}() 里没有旧壳这一支：那种机器上屏上会画成「可以再粘一遍」`);
  }
  const flow = fnBody("ledgermeLoginFlow");
  assert.ok(/v78 及以前的壳/.test(flow), "旧壳连接被拦下时没说是怎么回事");
  /* 粘进来的那一步：prompt 不许回填旧值（页面手里没有），回话只认 hasCookie 这个布尔 */
  assert.ok(/prompt\(tip, ""\)/.test(flow), "prompt 又开始回填旧 Cookie 了：页面手里从来不再有它");
  assert.ok(/!r\.hasCookie/.test(flow), "页面不再按原生回话里的 hasCookie 落定「连上没有」");
  assert.ok(!/r\.cookie/.test(flow), "连接回话里还带着 cookie 字段");
});

test("v79：抓出去的那一轮由页面交布尔、原生侧注入值；ledgermeCheck 不带实参", () => {
  const nf = fnBody("nativeNavFetch");
  assert.ok(/ledgerme: !!withLedgerme/.test(nf), "抓取载荷又交的是值而不是布尔开关");
  assert.ok(!/ledgermeCookie/.test(nf), "抓取载荷里页面又自己填了 Cookie");
  const body = fnBody("nativeFetchAll");
  assert.ok(/const lgmOn = ledgermeLoggedIn\(\);/.test(body),
    "抓取路径又按本机缓存的值决定要不要查账本：那个值已经不在页面手里了");
  assert.ok(!/ledgermeCookie/.test(body), "抓取路径里又出现了 ledgermeCookie");
  /* ledgermeCheck 的形状：只认 reqId，页面手里没有可传的东西 */
  const calls = [...APP_SRC.matchAll(/aixhubBridge\("ledgermeCheck",\s*\[([^\]]*)\]/g)].map(m => m[1]);
  assert.ok(calls.length >= 1, "找不到 ledgermeCheck 的桥调用，锚点变了要同步改这条");
  for (const arg of calls) assert.equal(arg, "", "ledgermeCheck 又带实参了：Cookie 不该经过页面");
  /* 401 与断开都请原生侧清，并顺手删历史明文键 */
  for (const fn of ["ledgermeCheck", "ledgermeLogout"]) {
    assert.ok(/ledgermeClearNative\(\)/.test(fnBody(fn)), `${fn}() 没请原生侧清掉加密区里那一份`);
    assert.ok(/ledgermePurgeLegacy\(\)/.test(fnBody(fn)), `${fn}() 没顺手删历史明文键`);
  }
  const clr = fnBody("ledgermeClearNative");
  assert.ok(/typeof window\.NativeNav\.ledgermeClear === "function"/.test(clr),
    "清这一份之前没判方法在不在：新页面配旧壳会抛");
});

test("v79：账本卡片说实话 —— 值在本机加密区，且不许出现「应该能用」", () => {
  const r = fnBody("renderLedgerme");
  assert.ok(/Android Keystore/.test(r), "卡片没告诉用户 Cookie 到底存在哪");
  assert.ok(/页面与浏览器都读不到它/.test(r), "卡片没把「页面读不到」这层说清楚");
  assert.ok(!/应该能用|应该可以|应该会/.test(r), "v79 的文案里出现猜测式表述");
  /* 那句「不更新不影响官网那条线」是本机降级的那句实话，不许被顺手删掉 */
  const old = r.slice(r.indexOf("ledgermeShellOld()"));
  assert.ok(/先更新 App 再连接/.test(old), "旧壳那一句没说清该怎么办");
});

test("v79：铁律 #6 的账本这一格 —— 整份页面里没有任何「取 Cookie」的去处", () => {
  /* 这一条守的是最省事的那种回退：给页面留一个 ledgermeCookie() 读函数，
     于是抓取路径、卡片、localStorage 又串成一条明文的线。门禁在页面这一侧只认「没有这个函数」。 */
  assert.ok(!/function ledgermeCookie\s*\(/.test(APP_SRC), "页面又有了取 Cookie 的函数：值只能从原生侧注入");
  assert.ok(!/LGM_LS\.cookie/.test(APP_SRC), "LGM_LS 又出现了 cookie 键位");
  /* v79 之后，页面里出现 ledgermeCookie 这七个字符的地方只有历史键名那一行与注释 */
  const hits = [...APP_SRC.matchAll(/ledgermeCookie/g)].length;
  assert.ok(hits <= 2, `ledgermeCookie 在页面里出现了 ${hits} 次，迁移做一半等于没做`);
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

test("放宽只用于显示与文案，不许用于真调用：登录 / 抓取 / 内容渲染 / 问答仍然只信桥", () => {
  /* inShellHost 是个「看得见这两节、也知道自己是不是在壳里」的宽松信号。
     v68 起它多一个用途：桥没挂上时该说「在壳里、但这一页的桥没挂上」，而不是
     「只在本机 App 内可用」—— 用户已经在 App 里了。这句取舍同样只许挑一句要显示的话：
     它一旦去 gate 真实调用，网页版就会走进一条必然被 CORS 拦死的路（v59 那条教训）。
     所以两头都钉死：允许出现的函数名单 + 每一处都必须待在「文案」那个位置上。 */
  const topFnAt3 = i => {
    const a = APP_SRC.lastIndexOf("\nfunction ", i), b2 = APP_SRC.lastIndexOf("\nasync function ", i);
    const s = Math.max(a, b2);
    assert.ok(s >= 0, `偏移 ${i} 落在某个函数外面`);
    return APP_SRC.slice(s, s + 120).split("(")[0].replace(/^\n(?:async )?function /, "").trim();
  };
  const lineAt = i => {
    const s = APP_SRC.lastIndexOf("\n", i) + 1;
    const e = APP_SRC.indexOf("\n", i);
    return APP_SRC.slice(s, e < 0 ? APP_SRC.length : e);
  };
  const DISPLAY = ["syncAppOnly", "armAppOnlyRetry", "inShellHost"];
  const MSG = ["bridgeMissingMsg", "ocrPick", "ocrBridge", "qrBridge", "qrPick",
               "llmStatusLine", "llmSetKey", "openLlm", "llmSend",
               /* v104：openLlm 的渲染体拆到 renderLlmSheet，inShellHost 仍在
                  llmDegrade 那句文案里，位置没变 —— 只是登记新函数宿主。 */
               "renderLlmSheet",
               /* v108：AI 研判的入口同样以 llmDegrade 说那句话，位置与 llmSend 一模一样。 */
               "briefRun"];
  const hits = [...APP_SRC.matchAll(/inShellHost\(\)/g)];
  assert.ok(hits.length >= 8, `只读到 ${hits.length} 处 inShellHost()，锚点变了要同步改这条`);
  for (const m of hits) {
    const fn = topFnAt3(m.index);
    if (DISPLAY.includes(fn)) continue;
    assert.ok(MSG.includes(fn),
      `inShellHost() 跑到 ${fn}() 里参与决策了：显示可以宽松，调用必须判桥`);
    const line = lineAt(m.index);
    assert.ok(/llmDegrade\(|bridgeMissingMsg\(|\? SHELL_NO_BRIDGE :/.test(line),
      `${fn}() 里的 inShellHost() 不在「挑一句文案」的位置上：${line.trim()}`);
  }
  /* 宽松信号不许出现在真调用的条件上 */
  assert.ok(!/if \(inShellHost\(\)\)/.test(APP_SRC),
    "出现了 if (inShellHost()) 直接决定走不走真调用 —— 网页版会撞 CORS");
  assert.ok(!/inShellHost\(\) &&/.test(APP_SRC),
    "inShellHost() 被 && 接到别的条件上：那就不只是显示判定了");
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
  /* v68 那四处「桥没挂上」的文案点：先判桥，再说话 —— 顺序反了就是「以为能调、结果调不到」。
     v104：openLlm 拆成「设 host 的入口」，判桥与文案随之落到 renderLlmSheet ——
     守卫强度不变，只把登记的宿主函数换成真正说那句话的那个。 */
  for (const name of ["llmStatusLine", "renderLlmSheet"]) {
    assert.ok(/if \(!llmBridge\(\)\)/.test(fnBody(name)),
      `${name} 少了那句 if (!llmBridge())：文案再怎么宽松，说话的人得先确认桥真不在`);
  }
  for (const name of ["llmSetKey", "llmSend"]) {
    assert.ok(/const b = llmBridge\(\);\s*\n\s*if \(!b\)/.test(fnBody(name)),
      `${name} 里桥的取用与判空分开了 —— 真调用前必须先 !b 返回`);
  }
  for (const name of ["ocrPick", "ocrBridge", "qrPick", "qrBridge"]) {
    assert.ok(/if \(!window\.NativeNav \|\| !window\.NativeNav\.\w+\)/.test(fnBody(name)),
      `${name} 少了那句判桥：宽松文案只是补一句人话，不许替掉守卫`);
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

/* ---- 持仓体检的入口位置（v63 定稿）----
   拍的是「台账页 + 交易中心各一行整行入口」，不是产品名后面挂个小链接。
   入口被误删不会报错，只是少一行 —— 这种只能靠对账钉住。 */
test("体检入口：台账页一行、交易中心一行，行内小链接已撤", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const home = html.slice(html.indexOf('id="pg-home"'), html.indexOf('id="pg-trade"'));
  const trade = html.slice(html.indexOf('id="pg-trade"'), html.indexOf('id="pg-prod"'));
  assert.ok(home.includes('onclick="openAnaIndex()"'), "台账页的体检入口行不见了");
  assert.ok(trade.includes('onclick="openAnaIndex()"'), "交易中心的体检入口行不见了");
  assert.ok(!src.includes("ana-go"), "明细列表那颗行内「体检」小链接应已撤掉（入口改成整行）");
  assert.ok(src.includes("function openAnaIndex()"), "openAnaIndex 没实现");
});

/* ---- 模型接入（T3）的页面侧接线 ----
   桥面清单是跨仓约定：页面调的方法名必须在私有仓 LlmBridge.java 里存在，
   而那一侧的比对在 scripts/verify-web.sh。这里先把「页面不许超出清单」钉住，
   否则清单会从 JS 这边悄悄长大。 */
test("T3 桥面：页面只调清单里的方法，三个回传全局函数都在", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const mod = readFileSync(new URL("../js/domain/llm.js", import.meta.url), "utf8");
  const mm = mod.match(/LLM_BRIDGE_METHODS = \[([^\]]*)\]/);
  assert.ok(mm, "llm.js 里找不到桥面清单");
  const manifest = mm[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const i = src.indexOf("T3 · 模型接入"), j = src.indexOf("/* 粘贴内容 → 产品键");
  assert.ok(i > 0 && j > i, "T3 代码块的位置变了，切片失败");
  const block = src.slice(i, j);
  const used = new Set();
  for (const m of block.matchAll(/\bb\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g)) used.add(m[1]);
  assert.ok(used.size >= 5, "只抓到 " + used.size + " 个桥方法调用，切片可能切错了");
  const extra = [...used].filter(n => manifest.indexOf(n) < 0);
  assert.deepEqual(extra, [], "页面调了清单外的桥方法：" + extra.join(", "));
  for (const fn of ["__llmChunk", "__llmDone", "__llmCfg"])
    assert.ok(src.includes("window." + fn + " ="), "原生要回调 " + fn + "，页面里没定义");
});

test("T3 铁律 #6：密钥与端点不落 localStorage，那一节只在 App 里出现", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  /* 扫整份 app.js 会被既有功能误伤：秒讯那几个 licai.aixhub* 存的是邮箱和到期快照，
     v78 起值本身在原生加密区，跟模型接入无关。
     所以按 T3 那一节的切片来扫——那一节不许有真的存储调用（注释里写「不进 localStorage」
     是说明文字，不算，因此正则必须带调用括号）。 */
  const i = src.indexOf("T3 · 模型接入"), j = src.indexOf("/* 粘贴内容 → 产品键");
  assert.ok(i > 0 && j > i, "T3 代码块的位置变了，切片失败");
  const block = src.slice(i, j);
  const bad = block.match(/\b(?:lsSet|lsGet|lsDel)\s*\(|localStorage\s*\.\s*(?:setItem|getItem|removeItem|clear)\s*\(/g) || [];
  assert.deepEqual(bad, [], "模型接入这一节有存储调用：" + bad.join(" | "));
  /* 再看整份文件：任何带 llm / apiKey 字样的 localStorage 键名都不许存在。 */
  const named = src.match(/(lsSet|lsGet|lsDel)\s*\(\s*["'`][^"'`]*(llm|apiKey|api_key)/gi) || [];
  assert.deepEqual(named, [], "有以 llm / apiKey 命名的 localStorage 键：" + named.join(" | "));
  assert.ok(/<details class="card app-only[^"]*">\s*<summary><h2>模型接入/.test(html),
    "模型接入那张卡没标 app-only：网页版会看见一个用不了的小节");
});

/* 铁律 #6 的另外两个具体落点：写回原生的那份 JSON 只有三样，
   而「等多久」这件事页面与原生必须是同一个数。两条都是从用户能看见的文案倒推的：
   提示写着「等满 120 秒」，代码却是 +15000 秒的缓冲，那句话就是假话。 */
test("T3 配置交出去的是那份清单；超时用的是常量；原生回的话有地方显示", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const i = src.indexOf("T3 · 模型接入"), j = src.indexOf("/* 粘贴内容 → 产品键");
  const block = src.slice(i, j);
  /* v67 起清单是「三样起步 + 新壳再加一个 apiStyle」。这里钉的是**能写哪些键**这份清单本身：
     清单变了而测试没跟着变，verify-web.sh 与原生 setConfig 的白名单就会各说各话。 */
  assert.match(block, /const cfgOut = \{ *baseUrl, *model, *search *\};/,
    "写回原生的配置清单不再是那三样（baseUrl / model / search），这里得跟着改");
  assert.match(block, /b\.setConfig\(JSON\.stringify\(cfgOut\)\)/,
    "setConfig 写的不是那份组装好的对象：清单变成隐式的了");
  const writes = [block.match(/const cfgOut = \{[^}]*\};/)[0]]
    .concat(block.match(/cfgOut\.[A-Za-z]+ *=/g) || []);
  assert.ok(writes.length >= 2, "apiStyle 没有写进 cfgOut：那这一项存到哪儿去了");
  for (const w of writes) {
    assert.ok(!/key|token|secret|authorization/i.test(w), "有把凭据写进原生配置的路径：" + w);
  }
  /* v124：超时跟着配置走（llmEffTimeoutMs）—— App 内把读超时调大时页面等得更久。
     不变量的新形态：文案与 setTimeout 用的是**同一个函数**，说出的秒数和实际等的数
     永远一致；页面比原生读超时晚 15 秒的设计缓冲收在 llmEffTimeoutMs 内部，不在调用点。 */
  assert.ok(/setTimeout\(\(\) *=> *llmTimeout\(LLM\.id\), *llmEffTimeoutMs\(\)\)/.test(block),
    "计时器没有走 llmEffTimeoutMs()：文案里的「等满 N 秒」和实际等的数会不一样");
  assert.ok(/LLM\.turn\.err = "等满 " \+ Math\.round\(llmEffTimeoutMs\(\) \/ 1000\)/.test(block)
    || /等满 " \+ Math\.round\(llmEffTimeoutMs\(\) \/ 1000\)/.test(block),
    "超时文案不是用 llmEffTimeoutMs() 算的秒数：说的和等的是两个数");
  assert.ok(!/LLM_TIMEOUT_MS *[+-] *[0-9]/.test(block), "调用点上不许现拼缓冲：同一形状两处各写一遍迟早对不上");
  assert.ok(/window\.__llmCfg = function \(msg\)/.test(block),
    "原生回的那句「这次没保存」没有入口显示，用户只会觉得点了没反应");
  assert.ok(/if \(m\) *toast\(m/.test(block), "__llmCfg 收到 msg 却没显示出来");
});

/* 铁律 #5 在 UI 上的落点：这一句的文案必须一直挂着（等待中也挂），
   否则用户看到的是「重试」这颗按钮而没有「这次也要钱」的提示。 */
test("T3 铁律 #5：重发消息挂在发起之后的每一屏，代码里没有自动重发", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const i = src.indexOf("T3 · 模型接入"), j = src.indexOf("/* 粘贴内容 → 产品键");
  const block = src.slice(i, j);
  assert.ok(/LLM\.costWarn = llmCanRetry\(LLM\)/.test(block), "发起时没记下「这是第 N 次发」");
  const note = block.match(/LLM\.costWarn \? `([^`]*)`/);
  assert.ok(note, "计费提示这一行不在");
  assert.ok(/计费/.test(note[1]) && /不会自己重发/.test(note[1]), note && note[1]);
  assert.ok(!/costWarn[^\n]*&&[^\n]*llmCanRetry/.test(block),
    "提示被 llmCanRetry 二次门住：请求在飞的这一屏正好不显示");
  /* 代码路径里除了用户点发起，没有任何地方再调 ask */
  assert.equal((block.match(/\bb\.ask\(/g) || []).length, 1, "ask 的调用点不止一处");
});

/* ---- v65 多轮问答的页面侧接线 ----
   上面那组 T3 测试钉的是「一轮」的形状，这一组钉的是「接着问」的形状：
   上文真的进了请求、闸门排在动手之前、重试与清空都只由人点。
   全是静态扫描 —— app.js 里没有 DOM 跑不起来（真机/浏览器实况在本地场景脚本里，不在 CI）。 */
function t3Slice() {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const i = src.indexOf("T3 · 模型接入"), j = src.indexOf("/* 粘贴内容 → 产品键");
  assert.ok(i > 0 && j > i, "T3 代码块的位置变了，切片失败");
  return { src, block: src.slice(i, j) };
}

test("v65 多轮：上文真的进了这一轮的 input，而发送点仍然只有一处", () => {
  const { block } = t3Slice();
  assert.ok(/input: *llmRoundInput\(LLM\.turns, *q/.test(block),
    "input 不带上文了：多轮变成每轮都失忆，用户看到的历史只是给自己看的");
  assert.ok(/LLM\.turns\.push\(LLM\.turn\)/.test(block), "落定的轮次没有进上文");
  assert.equal((block.match(/\bb\.ask\(/g) || []).length, 1, "ask 的调用点不止一处");
});

test("v65 轮次闸门排在动手之前，失败与超时那轮也记进上文", () => {
  const { block } = t3Slice();
  const gate = block.indexOf("llmBudget(llmUsed())");
  const push = block.indexOf("LLM.turns.push(LLM.turn)");
  const ask = block.indexOf("b.ask(");
  assert.ok(gate > 0 && push > gate && ask > push,
    `顺序应是「先拦额度 → 再落上文 → 最后发」，现在是 gate=${gate} push=${push} ask=${ask}`);
  assert.ok(/if \(!bg\.ok\) return toast\(bg\.why/.test(block), "拦到了却没告诉用户为什么");
  /* 这条是从浏览器场景里抓出来的：额度检查排在空文本检查后面时，到额的这一屏
     点下去回的是「先写一句要问的话」——框里写什么都发不出去，那句话是假话。 */
  assert.ok(block.indexOf("llmBudget(llmUsed())") < block.indexOf('if (!q) return toast("先写一句要问的话"'),
    "额度拦在空文本之后：到数时用户听到的是「先写一句」而不是「为什么不能再发」");
  assert.ok(/LLM\.turn\.err = "等满/.test(block), "超时那轮进上文时得写明「没回」，不许留个空答案");
  assert.ok(/if \(LLM\.turn\) LLM\.turn\.err = LLM\.err;/.test(block), "失败那轮没记进上文：下一轮不知道上一轮没答上");
});

test("v65 重试只挂在失败的那一轮，清空上文是手点的", () => {
  const { src, block } = t3Slice();
  assert.ok(/const retryable = !run && !!LLM\.turn && \["error", "timeout", "cancelled"\]\.includes\(LLM\.phase\)/.test(block),
    "重试按钮的门变了：拿到答案那一轮也给重试，就是白给用户一个再花一次钱的入口"
    + "（v76 起「人取消」的那一轮也在门里：要再发得人自己点，那一发是新的一次计费）");
  assert.match(block, /function llmRetry\(\)[\s\S]{0,300}llmSend\(LLM\.turn\.q\)/);
  assert.ok(/onclick="llmClearChat\(\)"/.test(block) && /onclick="llmRetry\(\)"/.test(block), "两颗新按钮没画进弹层");
  assert.ok(/if \(LLM\.phase === "running"\) return toast\("这一轮还在等/.test(block),
    "请求在飞时清空会把正在等的那轮抹掉，回传回来找不到 id 就当没发生");
  const k = src.indexOf("Object.assign(window, {");
  const bridge = src.slice(k, src.indexOf("});", k));
  for (const fn of ["llmAsk", "llmCancel", "llmRetry", "llmClearChat", "openLlm"])
    assert.ok(bridge.includes(fn), "内联入口没挂回 window：" + fn);
});


/* ---- v76 · 取消这一轮（llmCancel）----
   这一节钉的四件事都是「看着对、其实会伤人」的形态：
     1) 取消只是不再等，不是撤回 —— 屏上必须说「可能已经计费」，不许说成没花钱；
     2) 摘掉 id 必须发生在调桥之前 —— 否则刚好读完的那一班会把「已取消」翻成答案；
     3) 按钮只在真在等的时候出现 —— 落定了还给点，就是一个骗手指的空动作；
     4) 代码路径里没有任何地方自己再 ask() 一遍（铁律 #5）。 */
test("v76 取消：先摘 id 再调桥，落定的轮次不给点", () => {
  const { src, block } = t3Slice();
  const head = src.split("function llmCancel()")[1].slice(0, 1200);
  assert.ok(/if \(LLM\.phase !== "running"\) return/.test(head), "没挡重复点：连点两下把已落定的一轮改写成取消");
  assert.ok(head.indexOf('LLM.id = ""') >= 0 && head.indexOf("b.cancel(") >= 0,
    "要么没摘 id、要么没叫桥：前者会收迟到回传，后者请求还在跑还在计费");
  assert.ok(head.indexOf('LLM.id = ""') < head.indexOf("b.cancel("),
    "顺序反了：先叫桥再摘 id，中间那一瞬回来的 __llmDone 会认账");
  assert.ok(/clearTimeout\(LLM\.timer\)/.test(head), "自家的 120 秒计时器没停：取消后还会再跳一次「超时」");
  assert.ok(!/\bask\(/.test(head.replace("b.cancel(", "")), "llmCancel() 里不许出现第二次 ask（铁律 #5：重发只由人点）");
});

test("v76 取消：按钮只在等待中出现，取消那句走 esc 且与模块常量同源", () => {
  const { src, block } = t3Slice();
  assert.ok(/\$\{run ? [^\n]*onclick="llmCancel\(\)"/.test(block),
    "取消按钮不是只在等的时候画出来，或者压根没画");
  assert.ok(/LLM\.phase === "cancelled"[\s\S]{0,120}esc\(LLM_CANCEL_TEXT\)/.test(src),
    "取消那一档没有分支，或那句文案没经 esc 进屏");
  const llmjs = readFileSync(new URL("../js/domain/llm.js", import.meta.url), "utf8");
  assert.ok(/export const LLM_CANCEL_TEXT = [^;]*可能已经计费[^;]*;/.test(llmjs),
    "取消的话没写在纯模块里，或漏了「可能已经计费」");
  assert.ok(/export const LLM_CANCEL_TEXT = [^;]*不会自己重发[^;]*;/.test(llmjs),
    "漏了「代码不会自己重发」：取消之后最容易被当成会自动再来一次");
  assert.doesNotMatch(llmjs.split("export const LLM_CANCEL_TEXT")[1].split(";")[0],
    /未计费|一定没|不收费|退款|免费|<b>|<span/, "钱话说死了，或者文案里夹了 HTML");
});

test("v76 桥面清单里那一格 cancel 与页面调用点同名（点了没反应那种错）", () => {
  const { src } = t3Slice();
  const llmjs = readFileSync(new URL("../js/domain/llm.js", import.meta.url), "utf8");
  const tbl = llmjs.match(/LLM_BRIDGE_METHODS = \[([^\]]*)\]/)[1];
  assert.ok(tbl.includes('"cancel"'), "清单里没有 cancel");
  const call = src.match(/b\.cancel\(([^)]*)\)/);
  assert.ok(call, "页面没有调用桥上的 cancel");
  assert.equal(call[1].trim(), "id", "取消传的不是这一轮的 id：原生侧摘不到那条在飞记录");
});

/* ---- v77 · 语法门禁 ----
   v76 的那一个引号让 app.js 在浏览器里压根没跑起来，而 npm run check 全绿 ——
   因为解析这一步只存在于 CI，本地没有对应命令。下面两条就是把这一步钉回本地。 */
test("v77 页面每一个 JS 都要能被 node 解析（解析不了的发出去就是白屏）", () => {
  const files = ["app.js", "sw.js"]
    .concat(readdirSync(new URL("../js/core/", import.meta.url)).sort().map(f => "js/core/" + f))
    .concat(readdirSync(new URL("../js/domain/", import.meta.url)).sort().map(f => "js/domain/" + f))
    .filter(f => f.endsWith(".js"));
  assert.ok(files.includes("app.js") && files.length >= 20, "清单本身就是空的：" + files.length);
  const bad = [];
  for (const f of files) {
    const p = fileURLToPath(new URL("../" + f, import.meta.url));
    try { execFileSync("node", ["--check", p], { stdio: "pipe" }); }
    catch (e) { bad.push(f + "：" + String(e.stderr || e.message).split("\n")[1]); }
  }
  assert.deepEqual(bad, [], "这些文件解析不了：\n" + bad.join("\n"));
});

test("v77 npm run check 里必须有语法这一步（漏一次就白屏一次）", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(/bash scripts\/check-syntax\.sh/.test(pkg.scripts.check),
    "check 脚本没跑 scripts/check-syntax.sh：CI 的 node --check 又没有本地对应物");
  const sh = readFileSync(new URL("../scripts/check-syntax.sh", import.meta.url), "utf8");
  assert.ok(sh.includes("app.js") && sh.includes("js/core/*.js") && sh.includes("js/domain/*.js"),
    "语法脚本少了要查的那几类文件");
});

test("v65 会话只留内存：新字段挂在 LLM 上，屏幕上也是这么写的", () => {
  const { block } = t3Slice();
  assert.ok(/turns: \[\], turn: null/.test(block),
    "会话字段没挂在 LLM 上（散成全局变量就没人管它的生命周期了）");
  assert.match(block, /上文只在<[^>]*>这台机器的内存<\/b>里/);
  assert.ok(!/LLM\.turns *= *JSON\.parse/.test(block), "会话从存储里读回来了：那就不叫只留内存");
});

test("v65 屏上写的轮次上限就是模块里那个常量，没有第二处硬编码", () => {
  const { block } = t3Slice();
  const hard = (block.match(/(\d+)\s*轮/g) || []).map(s => s.trim());
  assert.deepEqual(hard, [], "文案里出现写死的「N 轮」，改上限时这里不会跟着变：" + hard.join("、"));
  assert.ok(block.includes("LLM_MAX_ROUNDS"), "轮次上限没用模块里那个常量");
  assert.ok(block.includes("llmBudget"), "闸门没用 llmBudget，而是页面自己数了一遍轮数");
});

/* ---- v66：带上我的台账（勾了才给）----
   钉的是「数据要出机器」这条路上的四件事：默认关、只有勾了才拼、拼出来只有白名单、
   金额跟随本机「隐藏金额」。快照文本本身的规矩在 tests/llm.test.mjs 里。 */
function snapItemsFn(block) {
  const k = block.indexOf("function llmSnapItems()");
  assert.ok(k > 0, "llmSnapItems 不在了：快照的入参来源变成隐式的了");
  const end = block.indexOf("\n}\n", k);
  assert.ok(end > k, "llmSnapItems 的函数体切不出来");
  return block.slice(k, end);
}

test("v66 默认不带台账：开关挂在内存里的 LLM 上，没写进任何本机存储", () => {
  const { block } = t3Slice();
  assert.match(block, /withData: *false/, "默认值不是关：一进弹层就把台账往外发");
  assert.ok(!/localStorage\.[gs]etItem/.test(block),
    "「这一轮带不带台账」被写进本机存储了：它是会话级的选择，刷新就该回到关");
  assert.ok(!/llmSnap(Text|Items)\s*=|let +snap|var +snap/.test(block), "快照状态没挂在 LLM 上");
});

test("v66 只有勾了才拼快照，没勾时发出去的是光的一句问题", () => {
  const { block } = t3Slice();
  assert.match(block, /const snap = LLM\.withData \? llmSnapText\(\) : "";/,
    "快照不再跟着开关走：那就是每次都把台账发出去");
  assert.match(block, /input: *llmRoundInput\(LLM\.turns, *q, *snap\)/,
    "拼好的 snap 没进 input：勾了等于没勾");
  const toggle = block.indexOf("const snap = LLM.withData");
  const ask = block.indexOf("b.ask(");
  assert.ok(toggle < ask, "快照在发送之后才拼，那这一屏发出去的东西和用户看见的不是一回事");
});

test("v66 快照的入参只从持仓算出来，不碰同步与凭据那几样", () => {
  const { block } = t3Slice();
  const items = snapItemsFn(block);
  assert.match(items, /position\(p\)/, "持仓数不从 position() 来：快照会和屏幕上看到的对不上");
  for (const w of ["SYNC", "localStorage", "token", "Key", "cfg"]) {
    assert.ok(!items.includes(w), "入参里碰了 " + w + "：白名单之外的东西一旦进参数就有漏出去的机会");
  }
});

test("v66 金额位跟随本机「隐藏金额」，屏幕上藏掉的数不许从这条路上漏", () => {
  const { block } = t3Slice();
  assert.match(block, /hide: *!!DATA\.settings\.hideAmount/,
    "快照不再读 hideAmount：用户藏了金额，模型照样拿到份额与成本");
  assert.match(block, /DATA\.settings\.hideAmount \? " · 金额按本机「隐藏金额」隐去"/,
    "藏了金额却没在屏上说明，用户会以为模型拿到了真数");
});

test("v66 发之前先把「本轮要带什么」写在屏幕上，勾与不勾都是实话", () => {
  const { block } = t3Slice();
  assert.match(block, /<input type="checkbox" id="llmData"[\s\S]{0,80}onchange="llmDataToggle\(\)"/,
    "勾选框的入口变了：改了状态不重画，屏幕上那句「本轮会带上」就是上一轮的");
  assert.match(block, /\$\{llmSnapLine\(\)\}/, "没把本轮要带的只数与字数写出来");
  assert.match(block, /现在没带台账数据：模型只听得到你敲进框里那一句/, "没勾时说得含糊：模型到底看见什么得写明");
  /* v104：内部重绘统一走 llmRepaint()（按 host 分派，债市页不会被换回模型接入页）。
     断言语义不变：开关拨了必须重画当前弹层；只是调用名随分派层同步。 */
  assert.match(block, /function llmDataToggle\(\)[\s\S]{0,200}\bllmRepaint\(\);/,
    "开关拨了不重画弹层");
  const k = block.indexOf("Object.assign(window, {");
  assert.ok(k === -1 || block.slice(k).includes("llmDataToggle"), "内联入口没挂上 llmDataToggle");
});

test("v66 给模型的指令是实话：没给到的就说没给到", () => {
  const { block } = t3Slice();
  assert.match(block, /instructions: *"回答只依据这条消息里给出的台账快照与上文/,
    "指令退回 v64 那句「只根据台账数据回答」：可快照是可选的，那句话在没勾时是假话");
  assert.match(block, /没给到的信息就说没给到/, "指令没拦住编：模型拿不到数据时最擅长补一个像样的数");
  assert.ok(!/instructions: *"只根据/.test(block), "又写回无条件的那句了");
});

test("v66 屏上的只数与字数上限用模块常量，没有第二处硬编码", () => {
  const { block } = t3Slice();
  const hard = (block.match(/(\d+)\s*(只|字)/g) || []).map(s => s.trim());
  assert.deepEqual(hard, [], "文案里写死了「N 只 / N 字」：" + hard.join("、"));
  assert.ok(block.includes("LLM_SNAPSHOT_MAX_ITEMS"), "只数没用模块里那个常量");
});

/* ---- v67（R1）：协议形制 —— 页面只交一个选择，形状只在原生拼 ----
   星火这类 OpenAI 兼容网关要的是 Chat Completions（messages[] + /chat/completions），
   而壳里那份是 Responses 形制。这一节钉的四件事：
     · 「协议」这一行只在认这个键的壳上画 —— 设了不生效比不给这一项更坏；
     · 判定看的是 getConfig 的 JSON 里键在不在，不是版本号、也不是值对不对；
     · apiStyle 只在能画出来的时候才发出去，旧壳连这个键都不发；
     · 页面不许自己拼 messages —— 同一个形状两处各写一遍迟早对不上，错了那一份在花钱。 */
function t3Fn(block, name) {
  const k = block.indexOf("function " + name + "(");
  assert.ok(k > 0, name + " 不在了：这一版的入口变了");
  const end = block.indexOf("\n}\n", k);
  assert.ok(end > k, name + " 的函数体切不出来");
  return block.slice(k, end);
}

test("v67 「协议」这一行只在认这个键的壳上画，旧壳换成一句实话", () => {
  const { block } = t3Slice();
  assert.match(block, /const canStyle = llmCanStyle\(\);/, "没先问这台壳认不认就画选择器");
  assert.match(block, /\$\{canStyle \? `<div class="field"><label>协议形制/, "选择器不再跟着能力走");
  assert.match(block, /还不支持换协议（更新 App 之后这一项才会出现）/, "旧壳上没说明白：这一项怎么不见了");
  const gate = block.indexOf("${canStyle ?");
  const sel = block.indexOf('<select id="llmStyle">');
  const other = block.indexOf("还不支持换协议");
  assert.ok(gate > 0 && sel > gate && other > sel,
    `「无这一项」那段文案不该出现在 canStyle 为真的分支里：gate=${gate} sel=${sel} cap=${other}`);
});

test("v67 能力判的是键在不在 —— 不比版本号，也不按值猜", () => {
  const { block } = t3Slice();
  const fn = t3Fn(block, "llmCanStyle");
  assert.match(fn, /hasOwnProperty\.call\(c, *"apiStyle"\)/,
    "不按键判：旧壳会被读成一个「看起来支持」的默认值");
  assert.match(fn, /const c = LLM\.cfg;/, "判定的数据源不是桥回来的配置");
  for (const bad of ["APP_VER", "MIN_APP_VER", "localStorage", "navigator.userAgent"]) {
    assert.ok(!fn.includes(bad), "llmCanStyle 里出现了 " + bad + "：能力应当从 getConfig 读，不是猜");
  }
});

test("v67 保存时只有这台壳认才交 apiStyle，旧壳连这个键都不发", () => {
  const { block } = t3Slice();
  const fn = t3Fn(block, "llmSaveCfg");
  assert.match(fn, /if \(canStyle\) \{[\s\S]{0,240}cfgOut\.apiStyle *=/,
    "apiStyle 无条件发出去了：旧壳把它当多余键丢掉，用户选了个不生效的东西");
  assert.match(fn, /b\.setConfig\(JSON\.stringify\(cfgOut\)\)/, "setConfig 写的不是组装好的那份");
  assert.ok(!/setConfig\(JSON\.stringify\(\{ *baseUrl/.test(fn),
    "又发回写死的那三个键了：新壳上加键得走那个组装好的对象");
  assert.ok(!/apiKey|secret|token/i.test(JSON.stringify(fn.match(/cfgOut\.[A-Za-z]+/g) || [])),
    "往配置里塞了凭据形状的键");
});

test("v67 协议值只认那两个，认不出的回 responses 而不是原样转发", () => {
  const { block } = t3Slice();
  const fn = t3Fn(block, "llmSaveCfg");
  assert.match(fn, /\$\(\s*"llmStyle"\s*\)/, "读的不是那个选择框");
  assert.match(fn, /=== *"chat" \? "chat" : "responses"/,
    "自由文本原样转发了：值应当收敛到两个，别把「未知」发给端点");
});

test("v67 选择器不新增 window 上的入口，保存还是走那一个按钮", () => {
  const { block } = t3Slice();
  assert.match(block, /<select id="llmStyle">/, "选择框上挂了新属性：多一个入口就多一处能走歪的路");
  assert.ok(!/onchange="llmSave/.test(block), "选择框自己就保存：改一个键发一次，保存不再是那一个动作");
  assert.match(block, /onclick="llmSaveCfg\(\)"/, "保存那颗按钮不在了");
  const k = block.indexOf("Object.assign(window, {");
  assert.ok(k === -1 || block.slice(k).includes("llmSaveCfg"), "内联入口没挂上 llmSaveCfg");
});

test("v67 发给桥的还是 input 与 instructions 两样，形状没往页面挪", () => {
  const { block } = t3Slice();
  assert.ok(!block.includes('"messages"'), "页面开始拼 messages[] 了：形状在两侧各写一遍迟早对不上");
  assert.ok(!/"tools"|"stream"|role *: *"system"/.test(block), "请求体构造挪进页面了 —— 那一份是花钱的请求");
  assert.match(block, /input: *llmRoundInput\(LLM\.turns, *q, *snap\)/,
    "v65/v66 那条 input 的组装变了：多轮或快照其中一路断了");
  assert.equal((block.match(/\bb\.ask\(/g) || []).length, 1, "ask 的调用点不止一处");
});

test("v67 保存成功的提示说的是真的存了什么", () => {
  const { block } = t3Slice();
  const fn = t3Fn(block, "llmSaveCfg");
  /* v124：新增了「收进边界」与「请求时长」两档，但不变量不变 ——
     旧壳（canStyle/canTimeout 都 false）只能报「已保存端点与模型」，
     多报「协议」「时长」就是假话；收进边界必须明说，不能装作存的就是用户填的数。 */
  assert.match(fn, /canStyle \? "已保存端点、模型与协议" : "已保存端点与模型"/,
    "旧壳上报「已保存协议」：那一句是假话");
  assert.match(fn, /canTimeout \? "已保存端点、模型与请求时长"/,
    "存了请求时长却不报告：用户不知道这次保存多带了两个键");
  assert.match(fn, /clamped \? "已保存（有超出一边界的数值已收进允许范围）"/,
    "数值被悄悄收进边界却不说：用户会以为存的就是他填的那个数");
});

/* ---- v124 · P0：grounding 判据的消费与横幅 ---- */
test("v124 横幅只认 llmParse 的 grounding；检索关着不显示，判据函数不许自己造", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function groundBannerHtml"), src.indexOf("function llmStatusLine()"));
  assert.ok(fn.includes("function groundBannerHtml"), "groundBannerHtml 不在了：横幅判据散落或被删");
  assert.match(fn, /search === false.{0,6}return ""/, "检索关着还挂横幅是噪音：研判按契约不联网");
  assert.match(fn, /xfBannerHtml\(/, "横幅没有走 websearch.js 的统一渲染：同一形状两处各写一遍");
  assert.match(fn, /XF_UNGROUNDED/, "未联网那句定语不在了：假成功必须写明不可作事实依据");
  /* llmSetSearch 整份覆盖时必须带上请求时长，否则改检索开关会把 readMs/budgetMs 清回默认 */
  const setSearch = src.slice(src.indexOf("function llmSetSearch"), src.indexOf("function briefSearchOff"));
  assert.match(setSearch, /out\.readMs = Number\(c\.readMs\)/,
    "llmSetSearch 不带 readMs：调过 180 秒之后点一下「关掉检索」，超时又变回默认 —— 像设置自己会变");
  assert.match(setSearch, /out\.budgetMs = Number\(c\.budgetMs\)/, "budgetMs 同理");
  /* 研判落地：briefDone 的两条成功路径都要把 grounding 写进缓存，openBrief 恢复要读回 */
  const bd = src.slice(src.indexOf("function briefDone"), src.indexOf("function reportPlainText"));
  const putCount = (bd.match(/grounding: BRIEF\.grounding/g) || []).length;
  assert.ok(putCount >= 2, "briefDone 两条成功路径（研报体 / brief-2 JSON）都要带 grounding 进缓存，现在只有 " + putCount + " 处");
  assert.match(bd, /BRIEF\.grounding = \(res && res\.ok\)/, "grounding 没在两条分支之前统一落地：缓存与界面会拿到不同口径");
  const ob = src.slice(src.indexOf("function openBrief"), src.indexOf("function openBriefPortfolio"));
  assert.match(ob, /BRIEF\.grounding = e\.grounding \|\| null/, "缓存恢复没读回 grounding：重开弹层横幅就丢了");
});

test("v67 屏上仍然写着真实端点没实测（铁律 #10 —— 拿到真凭据前这句不许撤）", () => {
  const { block } = t3Slice();
  assert.match(block, /真实端点仍未实测/, "把「没实测」这句撤了：页面上看着像已经验过线上");
  assert.ok(!/已实测|实测过了|验证过的端点/.test(block), "文案说成了实测过");
  assert.match(block, /认不得就明说认不得/, "降级那句不在了");
});

test("v69 __llmDone 只经由 llmMetaOf 读元信息，那句兜底话不许当文案发出去", () => {
  const { src } = t3Slice();
  const sig = "window.__llmDone = function (id, metaJson) {";
  const i = src.indexOf(sig);
  assert.ok(i > 0, "__llmDone 的签名变了：两侧回调的契约门禁（verify-web 第 2f 项）要跟着改");
  const body = src.slice(i + sig.length, src.indexOf("\n};", i));
  const uses = (body.match(/metaJson/g) || []).length;
  /* v108：__llmDone 成了分发器（研判 / 追问各一条支路），研判那一支把原文**原样转交**
     给 briefDone —— 那里同样只经由 llmMetaOf 读。所以这里允许 2 处，但除「转交」与
     「交给 llmMetaOf」之外不许出现第三种用法；「读法只许一处」这条不变量一个字没松。 */
  assert.ok(uses <= 2, "handler 里又出现一次 metaJson（共 " + uses + " 次）：元信息的读法只许 llmMetaOf 一处，"
    + "1.0.220 那次「名字对得上、类型对不上」就是两处各读各的读法");
  assert.match(body, /llmMetaOf\(metaJson\)/, "handler 没把元信息交给 llmMetaOf");
  const rest = body.replace(/llmMetaOf\(metaJson\)/g, "").replace(/briefDone\(metaJson\)/g, "");
  assert.ok(!/metaJson/.test(rest),
    "handler 里出现了第三种读法：" + (rest.match(/.{0,60}metaJson.{0,60}/) || [""])[0]);
  assert.match(body, /llmMetaErr\(meta, rd\.why, body\.length\)/, "失败那一行的话不是由 llmMetaErr 说的");
  assert.ok(!/["`]原生侧没回元信息["`]/.test(src),
    "「原生侧没回元信息」又被当成文案：真没回是 120 秒超时那条路径说的，"
    + "这句盖住了「壳回的是对象」那一档（v69 拆开的正是它）");
});


/* ---------- 队列 1（v80 预备）：GitHub 同步 token 不许留在 localStorage（铁律 #6） ----------
   交接文档 §4.5 末尾的已知漏洞：SYNC = { owner, repo, path, token, sha, auto }，
   saveSync() 把整份 JSON 写进 LS_SYNC = "licai_ledger_sync_v1"，设置页还把
   SYNC.token 回显进 <input id="sToken" value="...">。
   现有两条门禁都抓不到：T3 只禁「键名里带 llm / apiKey 的 localStorage 键」，
   AixhubGuard / LedgermeGuard 只禁「键名匹配 licai.*Token / licai.*Cookie」——
   这个 token 是 JSON 值里的字段，键名不带 licai. 前缀，两条正则都漏。
   按队列第一步「先补一条会红的」：现在源码就是坏的，这条必须红；等第四槽落地、
   SYNC 去掉 token、DOM 不回显之后它才转绿。不许为了让门禁变绿删掉它。 */

test("队列1（v80 预备）：同步配置里不许有 token 字段，GitHub 细粒度 token 只能待在本机加密区", () => {
  /* 1) SYNC 的形状：非敏感字段随便留，token 这一格不许再有 */
  const m = APP_SRC.match(/let SYNC = \{[^}]*\};/);
  assert.ok(m, "SYNC 的初始化字面量找不到了：切片失败必须显式报错，不许静默放行");
  assert.ok(!/\btoken\s*:/.test(m[0]),
    "SYNC 里还有 token 字段：saveSync() 会把整份 JSON 写进 localStorage 的 licai_ledger_sync_v1");
  /* 2) 落盘那一句不许再整份序列化（一份 JSON 里夹带 token 就是泄漏） */
  const save = fnBody("saveSync");
  assert.ok(!/JSON\.stringify\(\s*SYNC\s*\)/.test(save),
    "saveSync() 还在把整份 SYNC 写进 localStorage：非敏感字段要挑着写");
  /* 3) 设置页不许把值回显进 DOM */
  assert.ok(!/value="\$\{esc\(SYNC\.token\)\}"/.test(APP_SRC),
    "设置页仍把 SYNC.token 回显进 input 的 value");
  /* 4) 键名不许改：迁移要靠原名把老键里那份明文 token 清掉（只删不读） */
  assert.ok(/const LS_SYNC = "licai_ledger_sync_v1"/.test(APP_SRC),
    "LS_SYNC 改名了：老用户磁盘上那份明文 token 就再也删不掉了");
});

/* ---------- 队列 1（v80 · A1）：GitHub 请求的双通道 ----------
   文档 §4.5 + 分叉 A1：token 只待在本机加密区第四槽。App 内的 GitHub 请求
   全部走原生桥代理（Java 拼 header，页面一次都不碰值）；网页版没有原生侧，
   只能「每次填」——那份值只在内存态，绝不落 localStorage、绝不回显 DOM。
   这条先于 v80 代码补下时是红的；代码落地后转绿，不许为了让门禁变绿删掉它。 */
test("队列1（v80 · A1）：GitHub 请求 App 内走原生桥、网页版走内存态，token 不经页面拼 header", () => {
  const gh = fnBody("ghReq");
  /* 1) App 内分叉：有桥就走 ghBridge，页面不再拼 Authorization: SYNC.token */
  assert.ok(/ghAvailable\(\)/.test(gh), "ghReq 没有「本机桥在不在」这个分叉");
  assert.ok(/ghBridge\(/.test(gh), "App 内那一路没走原生代理 gh()");
  /* 2) 网页版：header 用内存态，绝不从 localStorage 读回来 */
  assert.ok(/"Authorization":\s*"Bearer "\s*\+\s*SYNC_MEM_TOKEN/.test(gh),
    "网页版没用内存态 token 拼 header（或又写成从存储里读）");
  /* 3) 旧壳（B1 窗口期）要有独立的一句实话，不许静默发空 token 请求 */
  assert.ok(/syncShellOld\(\)/.test(gh), "ghReq 没处理「桥在但不认识第四槽」的旧壳");
  /* 4) 整份 app.js 里 SYNC.token 一个都不许剩：值一次都不经过页面 */
  assert.ok(!/SYNC\.token/.test(APP_SRC), "app.js 里还残留 SYNC.token 引用");
  /* 5) 内存态变量在、但 saveSync 绝不写它（刷新即失 = 网页版每次填） */
  assert.ok(/let SYNC_MEM_TOKEN = ""/.test(APP_SRC), "网页版内存态变量没了");
  const sv = fnBody("saveSync");
  assert.ok(!/SYNC_MEM_TOKEN/.test(sv), "saveSync 把内存态 token 写进 localStorage 了");
  assert.ok(!/JSON\.stringify\(\s*SYNC\s*\)/.test(sv), "saveSync 又整份序列化 SYNC 了");
  /* 6) 布尔探针 / 降级件套齐 */
  for (const fn of ["syncCfgOk", "syncCfgHas", "syncShellOld", "syncPurgeLegacy", "syncCardText", "ghBridge", "ghAvailable"])
    assert.ok(new RegExp("(?:async )?function " + fn + "\\(").test(APP_SRC), `缺 ${fn}()：v80 件套没落地`);
  /* 7) 卡片正面写清「App 内免输入 / 网页版每次填」这个取舍（文档 §4.5 要求） */
  const card = fnBody("syncCardText");
  assert.ok(/免输入/.test(card) && /每次/.test(card), "卡片没把 A1 的取舍写清楚");
});


/* ============================================================
   v85 · 登记编码与产品代码不是同一个东西

   台账 App 的「登记编码」栏写在 `code` 字段里（产品列表与详情页都显示
   `登记编码 ${p.code}`），而 `prodCodeOf()` 从前会回退读 `code`。于是
   「只填了登记编码、没填产品代码」的产品会把 `Z7001…` 当份额代码交出去
   ——喂给中国理财网的份额类别闸门就永远对不上，聚合源静默永久拒取。
   这一组锁的是形态判据只有一份、且两边不许互相冒充。
   ============================================================ */
test("isRegCode：Z + 12~14 位数字才算登记编码", () => {
  assert.equal(isRegCode("Z7001126000218"), true);
  assert.equal(isRegCode(" z7001126000218 "), true, "大小写与首尾空格不影响判定");
  assert.equal(isRegCode("NYJXLD1409G"), false);
  assert.equal(isRegCode("Z7001"), false, "短得不像编码的别硬认");
  assert.equal(isRegCode(""), false);
  assert.equal(isRegCode(null), false);
});

test("prodCodeOf：登记编码形态不当产品代码", () => {
  assert.equal(prodCodeOf({ prodCode: "NYJXLD1409G", code: "Z7001126000218" }), "NYJXLD1409G",
    "有产品代码时照常优先");
  assert.equal(prodCodeOf({ code: "Z7001126000218" }), "",
    "只有登记编码时必须是空 —— 把 Z 码当份额代码 = 聚合源永久拒取");
  assert.equal(prodCodeOf({ code: "NYJXLD1409G" }), "NYJXLD1409G",
    "历史账本里 code 存份额代码的写法不能一起改掉");
  assert.equal(prodCodeOf({ shareCode: "Z7001126000218" }), "");
});

/* 实测数据（私有仓 main @ b2258e3b）里就有这一格：安盈稳健日开7号A 的
   `code` 是空串、`regCode` 是 Z7002426000328 —— 云端早就认得它的登记编码，
   屏幕上却写「登记编码 -」。用户看到「-」就以为缺，于是手工去补，
   这正是要消掉的那一步。读侧只有一种读法才算「先看见」：本机栏优先，空了才念云端别名。 */
test("regCodeOf：本机栏优先，空了念云端别名", () => {
  assert.equal(regCodeOf({ code: "Z7001126000218", regCode: "Z7002426000328" }), "Z7001126000218",
    "用户自己填的那一栏优先，不能被别名盖住");
  assert.equal(regCodeOf({ code: "", regCode: "Z7002426000328" }), "Z7002426000328",
    "实测里安盈就是这一格：栏里空、云端有值");
  assert.equal(regCodeOf({ code: "  ", regCode: "Z7002426000328" }), "Z7002426000328", "空白串也算没填");
  assert.equal(regCodeOf({ code: "NYJXLD1409G" }), "NYJXLD1409G",
    "历史账本里这一栏存过产品代码：照原样念，不替用户判对错");
  assert.equal(regCodeOf({}), "");
  assert.equal(regCodeOf(null), "");
});

test("regCodeFromCloud：只有别名有值时标出出处（铁律 #3）", () => {
  assert.equal(regCodeFromCloud({ code: "", regCode: "Z7002426000328" }), true);
  assert.equal(regCodeFromCloud({ code: "Z7001126000218", regCode: "Z7002426000328" }), false,
    "本机栏有值就不是「云端来的」");
  assert.equal(regCodeFromCloud({ code: "Z7001126000218" }), false);
  assert.equal(regCodeFromCloud({}), false);
  assert.equal(regCodeFromCloud(null), false);
});

test("fetchStatus：只填登记编码的产品仍然算「云端可抓」", () => {
  /* 修 prodCodeOf 最容易顺手把这类产品判成不能抓 —— 那才是真事故：
     它会直接从抓取名单里消失（nativeFetchAll 按 fetchStatus(p).ok 过滤）。 */
  const st = fetchStatus({ name: "农银匠心灵动14天9G", code: "Z7001126000218", inst: "农银理财" });
  assert.equal(st.ok, true, st.txt);
  assert.match(st.txt, /中国理财网/);
  assert.match(st.txt, /登记编码/);
});

test("fetchStatus：产品代码与登记编码各归各的判据", () => {
  const a = fetchStatus({ name: "徽银安盈稳健日开7号A", code: "Z7002426000328", prodCode: "PNHY260395A", inst: "徽银理财" });
  assert.equal(a.ok, true);
  assert.match(a.txt, /双线/, "官网 + 中国理财网两条线都能跑时必须说双线");
});

/* ---------- v109：研判的响应必须先从壳里取正文 ---------- */

test("briefDone 必须先拆壳再解析：llmParse 在场，extractJson 吃的是拆过的正文", () => {
  /* v108 首版把整个 HTTP 响应体直接喂给 extractJson。壳回的是
     {choices:[{message:{content:"..."}}],usage:{...}}，找到的第一个 JSON 对象
     就是外壳自己，verdict 永远不存在 —— 真机上的表现是「点了生成研判什么都不出」，
     而同一时刻追问是正常的，因为追问那条路一直先 JSON.parse 再 llmParse。
     这条断言钉住顺序，不是钉住实现细节：正文只在 content / output[] 里。 */
  const i = APP_SRC.indexOf("function briefDone(");
  assert.ok(i > 0, "找不到 briefDone");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /llmParse\(env\)/, "briefDone 没有先拆壳（正文藏在 choices[0].message.content 或 output[]）");
  assert.match(body, /extractJson\(text\)/, "extractJson 必须吃拆过壳的正文，不是整个响应体");
  assert.ok(!/extractJson\(\s*raw\s*\)/.test(body), "又拿原始响应体去 extractJson 了");
});

test("深度思考模型只回 reasoning_content 时有兜底，且标明那是思考不是结论", () => {
  const i = APP_SRC.indexOf("function briefDone(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /briefReasoningText\(env\)/, "没有读 reasoning_content 的兜底：星火 X2.6 这类模型正文可能还没落到 content");
  assert.match(body, /只回了思考过程/, "把思考过程当结论卖出去了：必须明写这一句");
});

test("研判装配失败不许静默：briefRun 里 briefPack 有 try/catch", () => {
  /* v108 首版这里裸调 briefPack()：数据里只要有一条读不出来就抛异常，
     点按钮的结果是「什么都不发生」—— 一发请求都没出去，屏上也没有一句话。
     这类静默中断比报错难查得多，所以必须在场。 */
  const i = APP_SRC.indexOf("function briefRun(");
  assert.ok(i > 0, "找不到 briefRun");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /try\s*\{\s*pack\s*=\s*briefPack\(\)\s*;?\s*\}/, "briefPack 没有兜底，异常时会静默中断");
  assert.match(body, /装配数据失败/, "兜底了但没把原因说到屏上");
});

/* ---------- v112：研报体，事实优先 ---------- */

test("研报：卡片区必须先算事实层，再判有没有结论", () => {
  /* 这一条是 v112 的结构性保证：模型挂了、超时了、没点按钮，两张表都得在。
     v109 的「等 90 秒什么都没有」不是模型慢，是页面把「有没有结论」
     当成了「要不要画东西」。顺序一反，这个 bug 就会原样回来。 */
  const i = APP_SRC.indexOf("function briefCardArea(");
  assert.ok(i > 0, "找不到 briefCardArea");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  const kFacts = body.indexOf("briefPack().facts");
  const kRes = body.indexOf("BRIEF.res");
  assert.ok(kFacts > 0, "卡片区没算事实层");
  assert.ok(kRes > 0, "卡片区没有结论分支");
  assert.ok(kFacts < kRes, "先判结论后算事实 —— 没结论时就会什么都不画");
  assert.match(body, /reportCardHtml/, "没走研报卡");
});

test("研报：落定先按 report-1 解析，旧 JSON 兜底，最后才降级原文", () => {
  const i = APP_SRC.indexOf("function briefDone(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  const kParse = body.indexOf("parseReport(text)");
  const kJson = body.indexOf("extractJson(text)");
  const kRaw = body.indexOf("BRIEF.raw = text");
  assert.ok(kParse > 0, "没有 report-1 解析");
  assert.ok(kJson > kParse, "旧 JSON 兜底应排在 report-1 之后");
  assert.ok(kRaw > kJson, "原文降级应排在最后");
});

test("研报：缓存版本号跟着解析口径换代", () => {
  assert.match(APP_SRC, /const BRIEF_CACHE_VER = 3;/, "解析口径变了却没升缓存版本：旧条目会挡在新代码前面");
});

test("研报：弹层不能再出现「已砍块」—— 研报不分块，砍了就说不清少了什么", () => {
  const i = APP_SRC.indexOf("function renderBriefSheet(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.ok(body.indexOf("已砍块") < 0);
  assert.match(body, /研报数据块/);
});

test("研报：数字审计要跑在模型正文上，不是跑在表头上", () => {
  const i = APP_SRC.indexOf("function briefAuditValues(");
  assert.ok(i > 0, "没有事实集收集函数");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /tail/, "净值轨迹的数没进事实集");
  assert.match(body, /shock/, "冲击的数没进事实集");
  assert.match(body, /market/, "债市的数没进事实集");
});

/* ---------- v110：研判要在原生 90 秒读超时之内落定 ---------- */

test("研判超时不许只显示原生那句 timeout：必须指到「关掉联网检索」", () => {
  /* v109 真机报障的原文就是 timeout —— 屏上照登等于什么都没说，用户只能再点一次然后同样超时。
     研判只用本机数据；端点默认带着联网检索工具，模型为凑 sources 去搜，90 秒就是这么花掉的。 */
  const i = APP_SRC.indexOf("function briefErrText(");
  assert.ok(i > 0, "找不到 briefErrText");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /要求端点做联网检索/, "超时文案没把「关掉联网检索」说出来");
  assert.match(body, /timeout/, "没有识别原生那个词");
});

test("研判落定要记耗时：发出时打点，卡片把用时画出来", () => {
  const i = APP_SRC.indexOf("function briefRun(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /BRIEF\.t0 = Date\.now\(\)/, "发出时没打点，算不出用时");
  assert.match(APP_SRC, /ms: BRIEF\.ms/, "卡片没拿到耗时");
});

test("研判缓存换代：解析口径变了，旧条目必须判不认", () => {
  /* v108 首版把整个响应壳当正文存进 licai.briefCache。若不按版本作废，
     v109 打开研判层会先命中这些坏条目；指纹又没变，于是连请求都不再发——
     修好的代码永远跑不到。 */
  assert.match(APP_SRC, /const BRIEF_CACHE_VER = \d+;/, "没有缓存版本常量");
  assert.match(APP_SRC, /ver:\s*BRIEF_CACHE_VER/, "写入时没盖版本戳");
  const i = APP_SRC.indexOf("function briefCacheGet(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /Number\(e\.ver\)\s*!==\s*BRIEF_CACHE_VER/, "读取时不校验版本：旧坏条目还会被认");
});

/* ---------- v113：检索开关要能在研判这一屏关掉 ---------- */

test("v113：改检索开关必须整份带上端点与模型（setConfig 是整份覆盖）", () => {
  /* 原生 LlmBridge.setConfig 认四个键，缺哪个就把哪个清成默认值。
     只写 {search:false} 会把 baseUrl / model 一起清掉 —— 用户点完「关掉检索」，
     下一发得到的是「还没配端点」。这条守的就是这个。 */
  const i = APP_SRC.indexOf("function llmSetSearch(");
  assert.ok(i > 0, "没有 llmSetSearch");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /baseUrl:\s*c\.baseUrl/, "没带上端点：会被清空");
  assert.match(body, /model:\s*c\.model/, "没带上模型：会被清空");
  assert.match(body, /search:\s*!!on/, "没写检索开关本身");
  assert.match(body, /apiStyle/, "新壳的协议选择会被一起清掉");
});

test("v113：研判卡要能一键关检索，超时卡要能关掉再发", () => {
  const i = APP_SRC.indexOf("function renderBriefSheet(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /briefSearchOff\(\)/, "研判页没有「先关掉检索」入口");
  const j = APP_SRC.indexOf("function briefCardArea(");
  const area = APP_SRC.slice(j, APP_SRC.indexOf("\nfunction ", j + 10));
  assert.match(area, /briefSearchOffRetry\(\)/, "超时卡没有一键自救的按钮");
  /* 只有超时才给这个按钮：别的错误（401 / 400 / 没配端点）关检索没用，给了就是误导。 */
  assert.match(area, /timeout\|timed\\s\*out\|超时/, "没有先判「是不是超时」");
});

test("v113：关检索再发，必须先挡住「正在生成」这一态", () => {
  /* 生成中再点一次就是第二发计费；这一条与 briefRun 的闸门同一口径。 */
  const i = APP_SRC.indexOf("function briefSearchOffRetry(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /BRIEF\.phase === "running"/, "没有挡住生成中重发");
  assert.match(body, /briefRun\(true\)/, "没有真的重发");
});

test("v113：设置页不能再单说「关掉就没出处」—— 要讲清研判用不上它", () => {
  /* 旧文案「出处就从检索里来；关掉它多半一条来源都拿不到」会把人吓住：
     他以为关了就废了，于是宁可每次超时。事实是研判根本不需要检索。 */
  assert.ok(APP_SRC.indexOf("关掉它多半一条来源都拿不到") < 0, "旧文案还在，会劝退用户");
  assert.match(APP_SRC, /「AI 研判」用不上/, "设置页没说明研判不需要检索");
});

/* ---------- v114（P1）：情景 / 日历 / 横向表 ---------- */

test("v114：日历一次算好，请求与观察项共用同一份", () => {
  const i = APP_SRC.indexOf("function briefFacts(");
  assert.ok(i > 0);
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /pubCalNext\(/, "没有算公开日历");
  assert.match(body, /cal,/, "日历没进事实层");
  /* 请求与观察项必须是同一份 cal：分开算两次，两处就可能对不上（跨午夜、跨时区）。 */
  const k1 = body.indexOf("watch: reportWatch(");
  assert.ok(k1 > 0);
  assert.match(body.slice(k1, k1 + 120), /cal/, "观察项没拿到日历");
});

test("v114：三档情景只在单只产品上算，组合层不硬凑", () => {
  const i = APP_SRC.indexOf("function briefFacts(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  const kProd = body.indexOf("kind: \"product\"");
  const kSc = body.indexOf("reportScenarios(");
  assert.ok(kSc > kProd, "情景应挂在单只产品那一支");
  const kPort = body.indexOf("reportPortfolioRows(");
  assert.ok(kPort > kSc, "组合层不该有情景表（没有单条净值序列）");
});

test("v114：情景的数必须进数字白名单，否则模型一引用就被判编造", () => {
  const i = APP_SRC.indexOf("function briefAuditValues(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /f\.scenarios/, "情景没进事实集");
  assert.match(body, /r\.cumBp/, "累计 bp 没进事实集");
  assert.match(body, /r\.nav/, "情景净值没进事实集");
});

test("v114：占比在本机回填，隐藏金额时留空而不是 0%", () => {
  const i = APP_SRC.indexOf("function briefItems(");
  const body = APP_SRC.slice(i, APP_SRC.indexOf("\nfunction ", i + 10));
  assert.match(body, /held\.length > 1 && total > 0 && r\.value > 0 \? r\.value \/ total : null/,
    "占比要么是真实比例，要么是 null，不许变成 0；只有一只持有时也不该给 100%");
});

/* ---------- v115：切页面不打断生成的请求 ---------- */

test("v115：弹层重绘不许再用 closeSheet —— 那是退一格历史，真机上会重载文档", () => {
  /* 这是本次 bug 的根因：render*Sheet 每重绘一次就 history.back() 一次。
     浏览器里同文档退栈看不出问题，WebView 上 goBack 落到初始条目会重新加载文档，
     JS 上下文重建 —— 正在跑的那一发回来时没人接得住，用户看到的就是「切页面就打断」。
     openSheet 本身已经做了「换内容 + 显示 + 该压哨兵时压一条」，够用。 */
  for (const fn of ["renderBriefSheet", "renderLlmSheet", "renderMarketSheet"]) {
    /* 只认「独立成行的调用」：注释里解释这件事时当然会写到这个名字 */
    assert.ok(!/^\s*closeSheet\(\);\s*$/m.test(fnBody(fn)), fn + " 里又在重绘时退栈了");
  }
});

test("v115：只有两颗取消按钮能打断请求，别处一律不许调 cancel", () => {
  /* cancel 是「不再等」，不是「撤回」，可能已经计费 —— 这种决定只能由人做。
     切页面、关弹层、换宿主、重绘，任何一条自动路径都不许碰它。 */
  const hits = [];
  const re = /\.cancel\s*\(/g;
  let m;
  while ((m = re.exec(APP_SRC))) hits.push(m.index);
  assert.equal(hits.length, 2, "cancel 调用点应恰好 2 处（研判 / 追问各一），实际 " + hits.length);
  const inFn = (idx, name) => {
    const i = APP_SRC.indexOf("function " + name + "(");
    const j = APP_SRC.indexOf("\nfunction ", i + 10);
    return idx > i && idx < (j < 0 ? APP_SRC.length : j);
  };
  for (const h of hits) {
    assert.ok(inFn(h, "briefCancel") || inFn(h, "llmCancel"),
      "有 cancel 调用落在了取消按钮之外的位置");
  }
});

test("v115：发请求前先记账 —— 反过来的话，文档在 ask 返回前被回收就认不回了", () => {
  const b = fnBody("briefRun");
  const w = b.indexOf('inflightWrite("brief"');
  const a = b.indexOf("b.ask(");
  assert.ok(w > 0, "briefRun 没有记「在路上」");
  assert.ok(a > 0, "briefRun 没找到 b.ask");
  assert.ok(w < a, "记账必须早于 b.ask");
  const l = fnBody("llmSend");
  assert.ok(l.indexOf('inflightWrite("llm"') < l.indexOf("b.ask("), "追问也必须是先记账再发");
});

test("v115：落定 / 取消 / 超时都要把「在路上」这条记录清掉", () => {
  /* 不清的话，下次启动会认领一条早就不存在的请求，用户白等 90 秒。 */
  assert.match(fnBody("briefDone"), /inflightClear\("brief"\)/);
  assert.match(fnBody("briefCancel"), /inflightClear\("brief"\)/);
  assert.match(fnBody("llmCancel"), /inflightClear\("llm"\)/);
  assert.match(fnBody("llmTimeout"), /inflightClear\("llm"\)/);
  const kDone = APP_SRC.indexOf("window.__llmDone = function");
  assert.ok(kDone > 0);
  assert.match(APP_SRC.slice(kDone, kDone + 2600), /inflightClear\("llm"\)/);
});

test("v115：页面起来时要接回还在路上的那一发", () => {
  assert.match(APP_SRC, /function briefInflightAdopt\(/);
  assert.match(APP_SRC, /function llmInflightAdopt\(/);
  const i = APP_SRC.indexOf("(function init()");
  const head = APP_SRC.slice(i, i + 800);
  assert.match(head, /briefInflightAdopt\(\)/, "init 没有接回研判");
  assert.match(head, /llmInflightAdopt\(\)/, "init 没有接回追问");
});

test("v115：弹层关了就不许再画 —— 画一次就是替用户把窗口弹回来", () => {
  assert.match(fnBody("briefRepaint"), /sheetOpen\(\)/, "briefRepaint 没守门");
  assert.match(fnBody("llmRepaint"), /sheetOpen\(\)/, "llmRepaint 没守门");
});

test("v115：生成中打开研判要能看见进度，不能只弹一句 toast", () => {
  const b = fnBody("openBrief");
  const i = b.indexOf('BRIEF.phase === "running"');
  assert.ok(i > 0, "没有生成中分支");
  const seg = b.slice(i, i + 420);
  assert.match(seg, /renderBriefSheet\(\)/, "生成中打开没有画界面（用户点了会以为没反应）");
  assert.match(seg, /briefSameTarget\(/, "没有区分「同一个目标」和「换目标」");
});

/* ---------- v117：缺口清单必须跟盘中数据同源 ---------- */

const gapsOf = (live) => new Function(`${fnBody("briefGaps")}; return briefGaps;`)()(live);

test("v117 缺口：拿到期货就不许再说「无法区分现券还是期货领先」", () => {
  /* 这条不是措辞洁癖：缺口清单和事实层同在一份 payload 里。一边写「T 主力 110.210」，
     一边写「没有今日国债期货」，模型只能二选一信，而它通常信缺口清单 ——
     因为缺口清单的语气更像「这是已知事实」。实际正文就写成过「本机没有今日国债期货」。 */
  const g = gapsOf({ items: [{ key: "CN10Y" }, { key: "T" }, { key: "TL" }, { key: "GC007" }] });
  assert.ok(!g.some(x => /国债期货/.test(x)), "盘中有 T/TL，缺口里还写着没有期货");
  assert.ok(g.some(x => /信用二永/.test(x)), "信用二永确实拿不到，不该被顺手删掉");
});

test("v117 缺口：有 GC007 时不能写成「资金面一项都没有」", () => {
  const g = gapsOf({ items: [{ key: "GC007" }] });
  const money = g.find(x => /资金面/.test(x));
  assert.ok(money, "资金面那条不见了");
  assert.match(money, /只有交易所回购 GC007/);
  assert.match(money, /不能互替/, "没说清 GC007 ≠ DR007，模型会把两个当同一个用");
  assert.ok(!/^资金面：没有 DR001/.test(money),
    "有 GC007 还写「没有 DR001 / DR007」，读起来就是资金面全空");
});

test("v117 缺口：一条盘中数据都没有时，退回原样三条", () => {
  for (const live of [null, { items: [] }]) {
    const g = gapsOf(live);
    assert.equal(g.length, 3, "缺项数变了");
    assert.ok(g.some(x => /无法区分现券领先还是期货领先/.test(x)), "没数据时必须照实说没有期货");
    assert.ok(g.some(x => /^资金面：没有 DR001 \/ DR007/.test(x)));
  }
});

/* ---- v125 · 数据块四源合流（晴雨摘要 / 资金面 / 信息面 / 检索线索） ---- */
test("v125 研判数据块接线：三路 facts 进 reportFactsText，指纹带三路时点", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  /* briefPack 装配请求体必须带上三路 —— 漏一路就是「研判看不见信息面」的原样复发 */
  const pack = src.slice(src.indexOf("function briefPack()"), src.indexOf("function briefFpNow()"));
  assert.match(pack, /news: facts\.news/, "briefPack 没带信息面：模型拿不到直抓线索");
  assert.match(pack, /funding: facts\.funding/, "briefPack 没带资金面：模型拿不到 FDR 定盘");
  assert.match(pack, /search: facts\.search/, "briefPack 没带检索包：手动检索白点了");
  const fp = src.slice(src.indexOf("const fp = briefFingerprint"), src.indexOf("return { built, fp, facts }"));
  assert.match(fp, /newsAsOf:/, "指纹没带信息面 asOf：线索更新后会拿旧信息面写新研判");
  assert.match(fp, /fundingAsOf:/, "指纹没带资金面 asOf");
  assert.match(fp, /ayAt:/, "指纹没带检索包时点");
  /* briefFacts 两个分支（product / portfolio）都要挂三路 */
  const bf = src.slice(src.indexOf("function briefFacts()"), src.indexOf("function briefPack()"));
  const hits = (bf.match(/news: newsFactsForBrief\(\), funding: fundingFactsForBrief\(\), search: searchFactsForBrief\(\)/g) || []).length;
  assert.equal(hits, 2, "briefFacts 的 product / portfolio 两个分支都要带三路，现在 " + hits + " 处");
});

test("v125 数字审计扩容：资金面定盘值与线索标题数字进白名单", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const av = src.slice(src.indexOf("function briefAuditValues()"), src.indexOf("function briefHistoryText"));
  assert.match(av, /f\.funding && f\.funding\.ok/, "FDR 定盘值不在白名单：模型照抄「FDR001 1.32%」会被判编造");
  assert.match(av, /titleNums\(f\.news\.items\)/, "线索标题数字不在白名单：照抄标题里的「1.7bp」会被判编造");
  assert.match(av, /titleNums\(f\.search\.items\)/, "检索标题数字同理");
});
/* 版本闭包不在这里钉：scripts/check-version.sh + handlers 的版本钉子总测是唯一权威（v97 纪律）。 */

/* ---- v126 · 债市行情实时直抓 + 更新时间标注 ---- */
test("v126 债市直抓接线：native 优先 / 云端降级 / src 随缓存", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  /* 桥入口：mode:"market" 载荷 + 120 秒兜底（market_weather 各端点自带超时重试） */
  assert.match(src, /function nativeMarketFetch\(\)/, "缺 nativeMarketFetch：App 内没法实时抓债市");
  assert.match(src, /window\.NativeNav\.fetch\(id, JSON\.stringify\(\{ mode: "market" \}\)\)/,
    "nativeMarketFetch 没发 mode:\"market\"");
  assert.match(src, /债市实时抓取超时（120 秒）/, "120 秒兜底定时器缺失");
  /* marketRefresh：App 内先 native（不依赖数据同步配置），校验不过降级云端 */
  const mr = src.slice(src.indexOf("function marketRefresh(opts = {})"),
                       src.indexOf("/** 启动时：先装缓存"));
  assert.match(mr, /const inApp = nativeFetchAvailable\(\)/, "marketRefresh 没判 App 内");
  assert.match(mr, /if \(!inApp && !syncCfgOk\(\)\)/, "网页端仍必须守 syncCfgOk 闸");
  assert.match(mr, /nativeMarketFetch\(\)/, "App 内分支没调 nativeMarketFetch");
  assert.match(mr, /validateMarket\(r\.market\)/, "native 回包必须过整包校验（坏包不进页面）");
  assert.match(mr, /src = "cloud"/, "云端降级要标 src=cloud");
  assert.match(mr, /MARKET_ST\.src = src/, "来源没写状态：状态条分不清直抓与云端");
  /* 直抓失败且云端也不可用 → 报真实原因，不吞成通用文案 */
  assert.match(mr, /if \(!m && !syncCfgOk\(\)\) throw new Error/, "双通道皆缺时不报真实原因");
  /* 缓存恢复：src 落盘（旧缓存按 cloud 算） */
  assert.match(src, /MARKET_ST\.src = String\(o\.src \|\| "cloud"\)/, "缓存恢复没带 src");
  assert.match(src, /src: MARKET_ST\.src \|\| "cloud"/, "缓存保存没带 src");
  /* 状态条：直抓与更新文案分开（两层时点纪律） */
  assert.match(src, /s\.src === "native" \? "本机直抓" : "本机更新"/, "状态条没按 src 区分来源");
});

test("v126 播报合并：更新此刻的 toast 带债市直抓口径；网页端闸门不放水", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const mra = src.slice(src.indexOf("async function marketRefreshAll(opts = {})"),
                        src.indexOf("/** 拉一次最新快照。"));
  assert.match(mra, /nativeFetchAvailable\(\) \|\| syncCfgOk\(\)/,
    "「更新此刻」没放行 native：没配同步的 App 点按钮拿不到实时曲线");
  assert.match(mra, /dayLive = dayOk && MARKET && MARKET_ST\.src === "native"/,
    "播报没按 native 来源给债市口径");
  assert.match(mra, /债市已实时抓取（/, "播报缺「债市已实时抓取」文案");
  /* marketRefresh 本体不再播报（死代码 reason:"manual" 已删） */
  const mr = src.slice(src.indexOf("function marketRefresh(opts = {})"),
                       src.indexOf("/** 启动时：先装缓存"));
  assert.ok(!mr.includes('reason === "manual"'), "marketRefresh 里的播报死代码没删干净");
});

/* ---- v128 · 额度监控（微众货架 + 我的产品池）：网页层只做配置/展示，抓数/常驻/通知归 Java 前台服务 ---- */
test("v128 监控职责边界：网页层不设 JS 定时轮询、不直连微众，后台常驻/通知归 Java 前台服务", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  /* v129：阶段 1 探测（QUOTA_ST）已下线，切片终点改用 renderMonitor() 这个稳定锚点 */
  const seg = src.slice(src.indexOf("const MONITOR_ST ="), src.indexOf("function renderMonitor() {"));
  assert.ok(seg.length > 3000, "监控主干段落定位失败（MONITOR_ST / renderMonitor 被改动）");
  assert.ok(!/const QUOTA_ST|quotaProbeRun\b|QUOTA_PROBE_MODE/.test(src),
    "阶段 1 连通性自检入口已下线，不该再出现在网页层");
  /* 最容易改回去的坑：有人给网页层加 setInterval 做「实时监控」。WebView
     切后台会被系统冻结，那是假监控；真正的常驻必须是 Java 前台服务。 */
  assert.ok(!/setInterval\s*\(/.test(seg),
    "网页层不许用 setInterval 假监控（后台常驻归 Java 前台服务）");
  assert.match(seg, /const MONITOR_ST = \{/, "缺监控状态收敛对象");
  assert.match(seg, /if \(!_monBooted\) \{ _monBooted = true; monitorRefresh\(\); \}/,
    "只在首次进入页面时刷一次，不循环");
  /* ★ 微众接口无 CORS，网页层直连必被拦：快照只能来自 native status 回包 */
  assert.ok(!/fetch\(WEBANK_QUOTA_URL|fetch\(\s*WEBANK/.test(seg),
    "网页层绝不直连微众（无 CORS），抓数归 Java 前台服务");
  assert.match(seg, /const raw = r\.snapshot;/, "快照来自服务 status 回包");
  assert.match(seg, /const snap = parseWebank\(raw\)/, "快照必须过整包校验");
  /* 控制面走通用 NativeNav.fetch 的 mode:monitor-*，零新增桥出口 */
  assert.match(seg, /function nativeMonitor\(mode, cfg\)/);
  assert.match(seg, /window\.NativeNav\.fetch\(id, JSON\.stringify\(cfg \? \{ mode, cfg \} : \{ mode \}\)\)/);
  assert.match(seg, /validateMonitorStatus\(r\)/);
  /* 配置归一化 / 关注限量 / 展示格式化都收口在 quota.js 纯函数，不在 app.js 重算第二套判据 */
  assert.match(seg, /monitorCfgPersist\(cfg\)/);
  assert.match(seg, /MONITOR_WATCH_MAX/);
  assert.match(seg, /webankRows\(pool, MONITOR_ST\.snapshot, cfg\.watch\)/,
    "展示行用纯函数且以可监控产品池为主，别在渲染层重算格式化");
  assert.match(seg, /function monitorPoolProducts\(\)/,
    "可监控产品池要过滤已清仓产品（全部赎回后不再进监控候选）");
});

test("v128 网页版降级：无 native 时如实报不可后台常驻，且有超时兜底", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const nm = src.slice(src.indexOf("function nativeMonitor(mode, cfg)"),
                       src.indexOf("async function monitorStatusFetch"));
  assert.match(nm, /if \(!nativeFetchAvailable\(\)\)/);
  assert.match(nm, /网页版没有后台服务，实时监控与通知只在 App 内可用/, "不假装能后台常驻");
  assert.match(nm, /服务响应超时（20 秒）/, "前台服务没回包时不能让按钮永远转圈");
  assert.match(nm, /delete _navDone\[id\]/, "回调表要清理，避免累积");
});
