/* T7b「换到另一只的话」的口径测试：node --test tests/switchadv.test.mjs
   跨产品比的是两只，出错的方式也比单只多两类，所以每一条都在问：
     · 一边缺数据时，另一边会不会替它把结论撑起来？（B 的持有期没录 → 只能是判不了）
     · 台账里根本没有的成本（申购费、到账空档），会不会被当成 0 混进总账？
     · 结论会不会越界说「该换」？（这一版没有业绩比较基准 / 风险等级字段，
       说出方向就是拿着缺档的规则算建议 —— 测试把「没有该换这一档」钉死）
     · 钱与收益有没有只走一处、有没有绕开隐私遮罩？
   外加页面接线：判定对但没挂上屏、或者挂了屏但自己重算了一遍，都算没做。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { switchAdvice, SW_VERDICTS, SW_LINE_TITLES } from "../js/domain/switchadv.js";
import { redeemAdvice } from "../js/domain/advice.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

const TD = "2026-11-04";
const SRC = { url: "https://www.example-official.cn/product/detail?id=9", publishedAt: "2026-10-30", tier: "official" };
/* A：手里这只，持有 20 天、净值当天、年化按 20 天折算 */
const POS_A = { shares: 10000, cost: 10400, market: 10500.5, lastNav: 1.05005, lastDate: "2026-11-03",
                holdDays: 20, holdAnnual: 0.025, annualValid: true, inTransit: false, hasPending: false };
/* B：候选那只，持有 15 天（已建仓的另一只）*/
const POS_B = { shares: 5000, cost: 5200, market: 5250, lastNav: 1.05, lastDate: "2026-11-03",
                holdDays: 15, holdAnnual: 0.033, annualValid: true, inTransit: false, hasPending: false };

const A_FULL = { status: "manual", lockDays: 7, openRule: "每个交易日可赎回",
  feeRedeem: [{ from: 0, to: 30, ratePct: 0.5 }, { from: 30, to: null, ratePct: 0 }],
  assets: [{ name: "债券", pct: 100 }], investScope: "固收", source: SRC };
const B_FULL = { status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
  feeRedeem: [{ from: 0, to: null, ratePct: 0.3 }],
  assets: [{ name: "债券", pct: 100 }], investScope: "固收", source: SRC };

function prod(id, disc) { return { id, name: "产品" + id, inst: "某理财", disc }; }
function sw(aDisc, bDisc, posA = POS_A, posB = POS_B, td = TD) {
  return switchAdvice({ a: prod("pA", aDisc), b: prod("pB", bDisc), posA, posB, td });
}
const textOf = r => r.lines.map(l => l.text).join(" ｜ ");
const lineOf = (r, k) => r.lines.filter(l => l.key === k);

/* ---------- 结论档位 ---------- */
test("两只都齐且 A 赎得出来：判「现在换得动」", () => {
  const r = sw(A_FULL, B_FULL);
  assert.equal(r.verdict, "ready", r.verdictText);
  assert.equal(r.verdictText, "现在换得动");
  assert.equal(r.ratePct, 0.5, "A 侧的档位是 T7a 算出来的那一个");
  assert.equal(r.toRatePct, 0.3, "B 侧取「刚买进去」那一档：holdDays = 0 是确定事实，不是猜的");
});

test("词表里根本没有「该换」这一档，输出里也不许出现这个词", () => {
  /* 台账能录的披露项就是 disc.js 那五样：没有业绩比较基准、没有风险等级、
     没有申购费、没有申赎确认时效。说出「该换」就是拿缺档的规则算建议。 */
  assert.deepEqual(Object.keys(SW_VERDICTS), ["ready", "no", "unclear", "skip"]);
  assert.ok(!Object.values(SW_VERDICTS).some(v => v.includes("该换")), JSON.stringify(SW_VERDICTS));
  const r = sw(A_FULL, B_FULL);
  assert.ok(!textOf(r).includes("该换"), textOf(r));
  assert.ok(!r.verdictText.includes("该换"));
});

test("没选对比对象：整题不适用，且只说一句（不许拿一只去猜另一只）", () => {
  const r = switchAdvice({ a: prod("pA", A_FULL), b: null, posA: POS_A, posB: null, td: TD });
  assert.equal(r.verdict, "skip");
  assert.equal(r.lines.length, 1, textOf(r));
  assert.equal(r.lines[0].title, SW_LINE_TITLES.pick);
});

test("选的就是这一只自己：不适用 —— 换给自己不叫换仓", () => {
  const r = switchAdvice({ a: prod("pA", A_FULL), b: prod("pA", A_FULL), posA: POS_A, posB: POS_A, td: TD });
  assert.equal(r.verdict, "skip");
  assert.ok(/换给自己不叫换仓/.test(textOf(r)), textOf(r));
});

test("A 还在最短持有期内：判「换不动」，还差几天由 T7a 转发", () => {
  const r = sw(Object.assign({}, A_FULL, { lockDays: 90 }), B_FULL);
  assert.equal(r.verdict, "no");
  assert.equal(r.unlockInDays, 70, "已持有 20 天、要求 90 天");
  assert.ok(/还差 70 天/.test(textOf(r)), textOf(r));
  assert.ok(!textOf(r).includes("现在换得动"), "换不动的时候不许混进另一句结论");
});

test("A 自己能不能赎都判不了：换仓判不了，不许借 B 的齐数据把结论撑起来", () => {
  const r = sw(Object.assign({}, A_FULL, { lockDays: null }), B_FULL);
  assert.equal(r.verdict, "unclear");
  assert.ok(/这一只能不能赎都判不了/.test(textOf(r)), textOf(r));
});

test("A 没建仓：不适用，B 那边一个字都不提", () => {
  const r = switchAdvice({ a: prod("pA", A_FULL), b: prod("pB", B_FULL),
    posA: { shares: 0, market: 0, holdDays: 0 }, posB: POS_B, td: TD });
  assert.equal(r.verdict, "skip");
  assert.equal(r.lines.length, 1, textOf(r));
  assert.equal(r.lines[0].title, SW_LINE_TITLES.from);
  assert.ok(/没有已确认持仓/.test(r.lines[0].text), r.lines[0].text);
});

/* ---------- B 侧：null 是不知道 ---------- */
test("B 的持有期没录：判不了，并明说不许按「没有锁定」放行", () => {
  const r = sw(A_FULL, Object.assign({}, B_FULL, { lockDays: null }));
  assert.equal(r.verdict, "unclear");
  assert.equal(r.toLockDays, null, "没录就是不知道，不是零天锁定");
  assert.ok(/不许按「没有锁定」放行/.test(textOf(r)), textOf(r));
});

test("B 录 0 天与没录是两回事；要锁 30 天时说清从零起算", () => {
  const zero = sw(A_FULL, Object.assign({}, B_FULL, { lockDays: 0 }));
  assert.equal(zero.toLockDays, 0, "录了 0 就是「知道且无限制」，字段不许退回 null");
  assert.equal(lineOf(zero, "lock")[0].level, "ok");
  assert.equal(zero.verdict, "ready");
  const lock30 = sw(A_FULL, Object.assign({}, B_FULL, { lockDays: 30 }));
  assert.equal(lock30.toLockDays, 30);
  assert.equal(lineOf(lock30, "lock")[0].level, "warn", "换过去重新锁是一种代价，不给绿色");
  assert.ok(/从零起算/.test(lineOf(lock30, "lock")[0].text), textOf(lock30));
  assert.equal(lock30.verdict, "ready", "锁得住是确定的代价，不影响「换得动」这一判");
});

test("B 的开放安排认不出来：判不了，并把原文照回显", () => {
  const r = sw(A_FULL, Object.assign({}, B_FULL, { openRule: "每月 15 日开放" }));
  assert.equal(r.verdict, "unclear");
  assert.ok(/原文「每月 15 日开放」/.test(textOf(r)), textOf(r));
  const empty = sw(A_FULL, Object.assign({}, B_FULL, { openRule: "" }));
  assert.equal(empty.verdict, "unclear");
  assert.ok(/信息不足（缺开放赎回安排）/.test(textOf(empty)), textOf(empty));
});

test("B 没录赎回费分档：判不了 —— 将来赎回来的成本算不出", () => {
  const r = sw(A_FULL, Object.assign({}, B_FULL, { feeRedeem: [] }));
  assert.equal(r.verdict, "unclear");
  assert.equal(r.toRatePct, null);
  assert.ok(/那一只将来赎要付多少也算不出/.test(textOf(r)), textOf(r));
});

test("B 的分档有洞（0 天不落任何档）：warn + 档位为 null，不拿邻档凑", () => {
  const r = sw(A_FULL, Object.assign({}, B_FULL, { feeRedeem: [{ from: 30, to: null, ratePct: 0 }] }));
  assert.equal(r.toRatePct, null, "空洞里没有档，返回 null 是「不知道」");
  assert.equal(lineOf(r, "tierTo")[0].level, "warn");
  assert.ok(/分档里有空洞/.test(textOf(r)), textOf(r));
  assert.equal(r.verdict, "unclear");
});

/* ---------- 台账里根本没有的成本 ---------- */
test("申购费与到账空档：永远写「算不出」，绝不按 0 计入总账", () => {
  /* 这两个是真实存在的成本，只是这个台账没这两个字段。
     一旦把它们当 0，「换一次不要钱」就成了屏上最好看也最错的一句话。 */
  const r = sw(A_FULL, B_FULL);
  assert.equal(lineOf(r, "feeTo")[0].level, "na");
  assert.equal(lineOf(r, "gap")[0].level, "na");
  assert.ok(/不是零/.test(lineOf(r, "feeTo")[0].text), lineOf(r, "feeTo")[0].text);
  assert.ok(/不是零/.test(lineOf(r, "gap")[0].text), lineOf(r, "gap")[0].text);
  assert.ok(r.lines.filter(l => l.key === "feeTo").length === 1 &&
            r.lines.filter(l => l.key === "gap").length === 1, "齐数据时也不许把这两行省掉");
});

/* ---------- 钱只折一处 ---------- */
test("A 侧的钱逐字段等于 T7a 的结果（不许出现第二处折钱）", () => {
  const a = prod("pA", A_FULL);
  const direct = redeemAdvice({ p: a, pos: POS_A, td: TD });
  const r = sw(A_FULL, B_FULL);
  ["market", "ratePct", "fee", "net"].forEach(k =>
    assert.equal(r[k], direct[k], `${k} 必须由 redeemAdvice 转发，不是这里再算一遍`));
  assert.equal(r.fee, 52.5);
  assert.equal(r.net, 10448);
});

test("结论文本里不许出现金额：市值一千万也不露字", () => {
  const r = sw(A_FULL, B_FULL);
  const rich = switchAdvice({ a: prod("pA", A_FULL), b: prod("pB", B_FULL),
    posA: Object.assign({}, POS_A, { market: 12345678.9 }), posB: POS_B, td: TD });
  const t = textOf(rich);
  assert.ok(!/12,345,678|12345678/.test(t), t);
  assert.ok(!/[¥￥]|元\b/.test(t), t);
  assert.equal(rich.fee, 61728.39, "钱在字段里，不在文本里");
  assert.ok(textOf(r).length > 0);
});

/* ---------- 收益：只当参考 ---------- */
test("两边都建仓且都满 7 天：差值只在字段上，行文本里不出现百分号", () => {
  const r = sw(A_FULL, B_FULL);
  assert.equal(r.perf.a, 0.025);
  assert.equal(r.perf.b, 0.033);
  assert.ok(Math.abs(r.perf.diff - 0.008) < 1e-9, String(r.perf.diff));
  const t = lineOf(r, "perf")[0].text;
  assert.ok(!/%/.test(t), `年化是钱折算出来的，写进文本就绕过遮罩：${t}`);
  assert.ok(/不是同一把尺/.test(t) && /不构成换过去的依据/.test(t), t);
  assert.equal(lineOf(r, "perf")[0].level, "warn", "收益比较永远不给绿色：它不是结论的依据");
});

test("那一只没建仓：不给收益，并说不拿走势假装预测", () => {
  const r = switchAdvice({ a: prod("pA", A_FULL), b: prod("pB", B_FULL), posA: POS_A, posB: null, td: TD });
  assert.equal(r.perf.diff, null);
  assert.equal(lineOf(r, "perf")[0].level, "na");
  assert.ok(/不拿净值走势假装预测收益/.test(textOf(r)), textOf(r));
});

test("任一边持有不足 7 天：同样不给数（短窗年化会把波动放大成极端值）", () => {
  const r = switchAdvice({ a: prod("pA", A_FULL), b: prod("pB", B_FULL),
    posA: POS_A, posB: Object.assign({}, POS_B, { annualValid: false, holdDays: 3 }), td: TD });
  assert.equal(r.perf.diff, null);
  assert.ok(/凑不齐/.test(textOf(r)), textOf(r));
});

/* ---------- 净值新旧 / 出处 / 缺项 ---------- */
test("净值落后：两边的数各按哪天算的都要说清，先补净值再谈换", () => {
  const r = switchAdvice({ a: prod("pA", A_FULL), b: prod("pB", B_FULL),
    posA: Object.assign({}, POS_A, { lastDate: "2026-10-20" }),
    posB: Object.assign({}, POS_B, { lastDate: "2026-10-22" }), td: TD });
  const n = lineOf(r, "nav");
  assert.equal(n.length, 1, textOf(r));
  assert.ok(/2026-10-20/.test(n[0].text) && /2026-10-22/.test(n[0].text), n[0].text);
  assert.ok(/先补净值再谈换/.test(n[0].text), n[0].text);
});

test("出处行：两边都有站内披露日期才算齐，缺一个就明说是按手工值判的", () => {
  const both = lineOf(sw(A_FULL, B_FULL), "source");
  assert.equal(both.length, 1);
  assert.equal(both[0].level, "ok");
  assert.ok(/2026-10-30/.test(both[0].text), both[0].text);
  const noSrc = lineOf(sw(A_FULL, Object.assign({}, B_FULL, { source: null })), "source");
  assert.equal(noSrc[0].level, "na");
  assert.ok(/没有合格出处/.test(noSrc[0].text), noSrc[0].text);
});

test("缺项一次列全，并说清是「那一只」缺、去哪补", () => {
  const r = sw(A_FULL, { status: "none", lockDays: null, openRule: "", feeRedeem: [],
    assets: [], investScope: "", source: null });
  const m = lineOf(r, "miss");
  assert.equal(m.length, 1, textOf(r));
  assert.ok(/还缺 5 项/.test(m[0].text), m[0].text);
  assert.ok(/最短持有/.test(m[0].text) && /投资范围/.test(m[0].text), m[0].text);
  assert.ok(/录入 \/ 修改配置/.test(m[0].text), m[0].text);
  assert.deepEqual(r.gaps, ["lockDays", "openRule", "feeRedeem", "assets", "investScope"],
    "出处单独走 source 那一行，不混进缺项清单");
  assert.equal(r.verdict, "unclear");
});

/* ---------- 杂项健壮性 ---------- */
test("档位词表与行标题表：漏一项界面就会印出英文键名", () => {
  [sw(A_FULL, B_FULL), sw(A_FULL, Object.assign({}, B_FULL, { lockDays: null }))].forEach(r => {
    r.lines.forEach(l => {
      assert.ok(SW_LINE_TITLES[l.key], `行 ${l.key} 没有中文抬头`);
      assert.equal(l.title, SW_LINE_TITLES[l.key]);
      assert.ok(["ok", "warn", "bad", "na", "skip"].indexOf(l.level) >= 0, `档位 ${l.level} 不在词表里`);
    });
  });
});

test("脏输入不炸：缺成什么样都要给出一条能显示的话", () => {
  assert.equal(switchAdvice({}).verdict, "skip");
  assert.equal(switchAdvice({ a: prod("pA", null), b: prod("pB", null), posA: null, posB: null }).verdict, "skip");
  const r = sw(A_FULL, B_FULL, POS_A, POS_B, "不是日期");
  assert.equal(r.verdict, "ready", "td 不合法只是少一行净值滞后提示，不该把整题判死");
  assert.ok(!r.lines.some(l => l.key === "nav"));
});

/* ---------- 纯函数钉 ---------- */
test("纯函数：不读时钟、不碰网络、不写账本、不进 localStorage、不自己折钱", () => {
  const src = read("js/domain/switchadv.js");
  assert.ok(!/Date\.now\(\)|new Date\(/.test(src), "「今天」只能由调用方传进来（td）");
  assert.ok(!/localStorage|sessionStorage/.test(src), "铁律 6：判定不落在浏览器存储里");
  assert.ok(!/fetch\(|XMLHttpRequest/.test(src), "这一层不发请求");
  assert.ok(!/DATA\.|\.disc\s*=|saveLocal|autoPush|trades\.push/.test(src), "只读：不写账本、不生成那两笔交易");
  assert.ok(!/\b(money|signMoney)\s*\(/.test(src), "这一层不认识钱的格式，更不许算钱");
  assert.equal((src.match(/ratePct\s*\/\s*100/g) || []).length, 0, "折钱只有一处：advice.js");
  assert.equal((src.match(/shares\s*\)?\s*\*/g) || []).length, 0, "份额 × 净值 是 position.js 的事");
  assert.ok(/import \{ redeemAdvice/.test(src), "A 侧结论必须复用 T7a，不是这里重写");
  assert.ok(/feeRateFor\(/.test(src), "取档必须走 disc.js 那一个函数");
});

/* ---------- 页面接线 ---------- */
test("换仓卡挂在赎卡之后；对象由用户选，切换走同一屏重渲", () => {
  const app = read("app.js");
  assert.ok(/import \{ switchAdvice \} from "\.\/js\/domain\/switchadv\.js";/.test(app),
    "判定搬家到独立模块后 app.js 必须这么引；名字对不上就是引了个不存在的导出");
  assert.ok(app.includes("${adviceCard(p, pos)}\n    ${switchCard(p, pos)}"),
    "这张卡要紧跟「现在赎的话」：先判这一只赎不赎得出来，再谈换到另一只");
  assert.ok(app.includes("switchAdvice({ a: p, b, posA: pos, posB: b ? position(b) : null, td: today() })"),
    "B 的持仓必须走 position()（同一个 computePosition），不许这里再算一遍");
  assert.ok(app.includes('onchange="setSwitchTarget(this)"'), "没挂上选择框就是选不动对象");
  assert.ok(/UI\.switchTo = "";/.test(app), "重开详情要从「没选对象」开始：选谁不是用户的事实数据");
});

test("卡片上的钱与年化都走 shown()，费率不喂给 pct()，措辞不越界", () => {
  const app = read("app.js");
  ["money(sw.net)", "money(sw.market)"].forEach(x =>
    assert.ok(app.includes("shown(" + x + ")"), `这张卡的 ${x} 没走 shown()：隐藏金额打开时会明文`));
  ["pct(sw.perf.a)", "pct(sw.perf.b)", "pct(Math.abs(sw.perf.diff))"].forEach(x =>
    assert.ok(app.includes("shown(" + x + ")"), `年化是钱折算出来的，${x} 没走 shown()`));
  ["tone(sw.perf.a)", "tone(sw.perf.b)", "tone(sw.perf.diff)"].forEach(x =>
    assert.ok(app.includes(x), `${x} 缺失：隐藏时颜色会泄露收益方向`));
  const body = app.slice(app.indexOf("function switchCard("),
    app.indexOf("/* ============================================================\n   T2 · 持仓体检"));
  assert.ok(!/pct\(sw\.ratePct\)/.test(body), "ratePct 是百分数本身，喂给 pct()（入参小数）会大一百倍");
  assert.ok(body.includes('sw.toLockDays === 0 ? "不限"'),
    "录了 0 天要显「不限」：与「没录」共用一个破折号就是把「知道且无限制」说成不知道");
  assert.ok(body.includes("只判换得动 · 不说该不该"), "卡片要写明不判该不该 —— 这一版没有那几个字段");
  assert.ok(!/该换/.test(body), "卡片里出现「该换」就是越界");
  assert.ok(body.includes("ANA_LEVEL_TEXT"), "档位词必须是字，色带只是辅助");
});

test("陈旧措辞必须跟着上线的行为改掉（v73 那把刀延伸到这里）", () => {
  const app = read("app.js");
  assert.ok(!app.includes("换仓判断还没做"), "v75 起换仓判断已经上线，这句话与线上相反");
  assert.ok(!app.includes("比较口径还没定"), "同上：口径定了才有这张卡");
  assert.ok(app.includes("判断在下面的卡里"), "取档那行的说明要指向真的结论卡");
  assert.ok(app.includes("v75 起另有一张卡"), "T7a 的块注释要交代跨产品比较落在哪");
});

test("离线清单里有 switchadv.js，版本跟着升（漏一个模块就是离线整页空白）", () => {
  const sw_js = read("sw.js");
  assert.ok(sw_js.includes('"./js/domain/switchadv.js"'), "switchadv.js 没进 sw.js 的 SHELL");
  assert.ok(sw_js.includes('const CACHE = "licai-ledger-v83"'), "新增模块 = 外壳变了，CACHE 必须跟着升");
  assert.ok(read("app.js").includes('const APP_VER = "v83"'), "APP_VER 要与 CACHE 同值");
});
