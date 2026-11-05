/* T7a「现在赎的话」的口径测试：node --test tests/advice.test.mjs
   这一层管的是钱，所以每一条都在问同一类问题：
     · 判不出来的时候，界面会不会替我编一个？（未披露的赎回费按 0% 算 = 骗人说赎回不要钱）
     · 判得出来的时候，数字是哪来的？（必须复用 position.js / disc.js，不许第二份实现）
     · 结论里能不能带钱？（钱进了文本就绕过了「隐藏金额」，也就会进缓存）
   外加页面接线 —— 判定对但没挂上屏，等于没做。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redeemAdvice, isOpenRuleDaily, ADV_VERDICTS, ADV_LINE_TITLES } from "../js/domain/advice.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");

/* 2026-11-04 是周三。持有 20 天、净值当天，是「一切齐且能赎」的基准样本。 */
const TD = "2026-11-04";
const SRC = { url: "https://www.example-official.cn/product/detail?id=9", publishedAt: "2026-10-30", tier: "official" };
const POS = { shares: 10000, cost: 10400, market: 10500.5, lastNav: 1.05005, lastDate: "2026-11-03",
              holdDays: 20, inTransit: false, hasPending: false };

/** 组一只产品：disc 给什么就是什么，缺失一律不补默认值。 */
function prod(disc) { return { id: "p1", name: "稳富某期", inst: "某理财", disc }; }
function adv(disc, pos = POS, td = TD) { return redeemAdvice({ p: prod(disc), pos, td }); }
const textOf = r => r.lines.map(l => l.text).join(" ｜ ");

test("六项齐、开放安排读得懂：判「赎得出来」，钱按市值 × 费率算得出", () => {
  const r = adv({ status: "manual", lockDays: 7, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: 30, ratePct: 0.5 }, { from: 30, to: null, ratePct: 0 }],
    assets: [], investScope: "", source: SRC });
  assert.equal(r.verdict, "yes", r.verdictText);
  assert.equal(r.holdDays, 20);
  assert.equal(r.ratePct, 0.5, "持有 20 天落在 0–30 这一档");
  assert.equal(r.market, 10500.5);
  assert.equal(r.fee, 52.5, "10500.5 × 0.5% = 52.5025 → 两位");
  assert.equal(r.net, 10448, "市值 − 赎回费");
  assert.ok(r.lines.some(l => l.key === "open" && l.level === "ok"));
});

test("赎回费未披露：fee / net 一律 null，绝不按 0% 算出「赎回来一分不亏」", () => {
  const r = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [], assets: [], investScope: "", source: SRC });
  assert.equal(r.ratePct, null, "费率没录就是不知道，不是 0");
  assert.equal(r.fee, null, "算不出扣多少就不能给数 —— 给 0 是最舒服的假话");
  assert.equal(r.net, null);
  assert.ok(/信息不足（缺赎回费分档）/.test(textOf(r)), textOf(r));
});

test("最短持有期没录：判不了，不许按 0 天放行", () => {
  const r = adv({ status: "manual", lockDays: null, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0 }], assets: [], investScope: "", source: SRC });
  assert.equal(r.verdict, "unclear");
  assert.equal(r.unlockInDays, null, "没有要求天数，谈不上还差几天");
  assert.ok(/这一关判不了/.test(textOf(r)), textOf(r));
  assert.ok(!/现在赎得出来/.test(r.verdictText + textOf(r)), "缺字段时不许出现这句");
});

test("lockDays 录成 0 是「知道且无限制」，与没录（null）是两回事", () => {
  const zero = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0 }], assets: [], investScope: "", source: SRC });
  assert.equal(zero.verdict, "yes");
  assert.ok(/无持有期限制/.test(textOf(zero)), textOf(zero));
  const none = adv({ status: "manual", lockDays: null, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0 }], assets: [], investScope: "", source: SRC });
  assert.equal(none.verdict, "unclear", "同一个位置 null 与 0 必须给出不同结论");
});

test("还在最短持有期内：判「赎不出来」、说清还差几天，且这一步不算钱", () => {
  const r = adv({ status: "manual", lockDays: 40, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: 30, ratePct: 1 }, { from: 30, to: null, ratePct: 0 }],
    assets: [], investScope: "", source: SRC });
  assert.equal(r.verdict, "no");
  assert.equal(r.unlockInDays, 20, "要求 40 天、已持有 20 天");
  assert.equal(r.ratePct, null, "还没到能赎的时候，报当前档位会让人以为现在赎就是这个价");
  assert.equal(r.fee, null);
  assert.ok(r.lines.some(l => l.key === "fee" && l.level === "skip"), textOf(r));
});

test("档位区间是 [from,to)：持有期正好等于边界时落下一档", () => {
  const r = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: 20, ratePct: 0.5 }, { from: 20, to: null, ratePct: 0 }],
    assets: [], investScope: "", source: SRC }, POS);
  assert.equal(r.ratePct, 0, "满 20 天已不算 0–20 这档");
  assert.equal(r.fee, 0, "0% 是「知道且为零」，与算不出（null）不同");
  assert.equal(r.net, 10500.5);
});

test("分档里有空洞：按未知处理并催补齐，不许挑最近的一档凑数", () => {
  const r = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: 10, ratePct: 0.2 }, { from: 30, to: null, ratePct: 0 }],
    assets: [], investScope: "", source: SRC });
  assert.equal(r.ratePct, null);
  assert.equal(r.fee, null);
  assert.ok(/不落任何已录档位/.test(textOf(r)), textOf(r));
});

test("再等几天能降档：只有未来确实有更低的档才提示，持平或更高不提示", () => {
  const lower = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: 30, ratePct: 0.5 }, { from: 30, to: null, ratePct: 0.1 }],
    assets: [], investScope: "", source: SRC });
  assert.deepEqual(lower.nextDrop, { days: 10, fromPct: 0.5, toPct: 0.1 });
  const higher = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: 30, ratePct: 0.1 }, { from: 30, to: null, ratePct: 0.5 }],
    assets: [], investScope: "", source: SRC });
  assert.equal(higher.nextDrop, null, "等下去更贵，不该劝人等");
});

test("开放安排读不懂：判不了，并把原文回显 —— 认不出是我们的事，不是产品没写", () => {
  const r = adv({ status: "manual", lockDays: 0, openRule: "每月 15 日开放赎回，遇非工作日顺延",
    feeRedeem: [{ from: 0, to: null, ratePct: 0 }], assets: [], investScope: "", source: SRC });
  assert.equal(r.verdict, "unclear");
  assert.ok(r.lines.some(l => l.key === "open" && /每月 15 日开放/.test(l.text)), textOf(r));
  assert.ok(!/赎得出来/.test(r.verdictText));
});

test("持仓为空 / 买入在途：整题不适用，不拿 0 份去算钱", () => {
  const none = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0.5 }], assets: [], investScope: "", source: SRC },
    { shares: 0, market: 0, holdDays: 0, inTransit: false });
  assert.equal(none.verdict, "skip");
  assert.equal(none.fee, null);
  assert.equal(none.lines.length, 1, "不适用就只说一句，别把判不了的清单再铺一遍");
  const transit = adv({ status: "manual", lockDays: 0 },
    { shares: 0, market: 0, holdDays: 0, inTransit: true });
  assert.ok(/在途/.test(transit.lines[0].text), transit.lines[0].text);
});

test("市值不成立（净值缺失）：钱算不出就明说，不悄悄显示成 0", () => {
  const r = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0.5 }], assets: [], investScope: "", source: SRC },
    { shares: 1000, market: 0, lastDate: "", holdDays: 20 });
  assert.equal(r.market, null);
  assert.equal(r.fee, null);
  assert.ok(/市值不成立/.test(textOf(r)), textOf(r));
});

test("净值落后两个交易日以上：说清这数字按哪天算的，不猜今天的净值", () => {
  const r = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0.3 }], assets: [], investScope: "", source: SRC },
    Object.assign({}, POS, { lastDate: "2026-10-20" }));
  const nav = r.lines.filter(l => l.key === "nav");
  assert.equal(nav.length, 1);
  assert.ok(/2026-10-20/.test(nav[0].text) && /落后/.test(nav[0].text), nav[0].text);
});

test("出处这行：有站内披露日期就报日期与分级，没有就明说是按手工值判的", () => {
  const withSrc = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [], assets: [], investScope: "", source: SRC });
  const s1 = withSrc.lines.filter(l => l.key === "source");
  assert.equal(s1.length, 1);
  assert.ok(/2026-10-30/.test(s1[0].text) && /官网|信披/.test(s1[0].text), s1[0].text);
  const noSrc = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [], assets: [], investScope: "", source: null });
  assert.ok(/没有合格出处/.test(textOf(noSrc)), textOf(noSrc));
});

test("缺项一次列全并指回补录的地方，不逐行重复", () => {
  const r = adv({ status: "none", lockDays: null, openRule: "", feeRedeem: [],
    assets: [], investScope: "", source: null });
  const gap = r.lines.filter(l => l.key === "gap");
  assert.equal(gap.length, 1, textOf(r));
  assert.ok(/最短持有/.test(gap[0].text) && /赎回费分档/.test(gap[0].text), gap[0].text);
  assert.ok(/底层配置与申赎规则/.test(gap[0].text), "得说清去哪补");
  assert.deepEqual(r.gaps, ["lockDays", "openRule", "feeRedeem", "assets", "investScope"],
    "出处单独走 source 那一行，不混进缺项清单");
});

test("结论文本里不许出现金额：钱只在数字字段里，由渲染层走 shown()", () => {
  /* 体检页那条口径在这里同样成立：结论文本会随渲染反复出现，
     一旦含钱，「隐藏金额」打开时要么漏字，要么整个得重算。 */
  const r = adv({ status: "manual", lockDays: 0, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0.5 }], assets: [], investScope: "", source: SRC },
    Object.assign({}, POS, { market: 12345678.9 }));
  const t = r.lines.map(l => l.text).join(" ｜ ");
  assert.ok(!/12,345,678|12345678/.test(t), t);
  assert.ok(!/[¥￥]|元\b/.test(t), t);
  assert.equal(r.fee, 61728.39, "钱在字段里，不在文本里");
});

test("纯函数：不读时钟、不碰网络、不写账本、不进 localStorage", () => {
  const src = read("js/domain/advice.js");
  assert.ok(!/Date\.now\(\)|new Date\(/.test(src), "「今天」只能由调用方传进来（td），否则结论钉死在算的那一刻");
  assert.ok(!/localStorage|sessionStorage/.test(src), "铁律 6：判定不落在浏览器存储里");
  assert.ok(!/fetch\(|XMLHttpRequest/.test(src), "这一层不发请求");
  assert.ok(!/DATA\.|p\.disc\s*=|saveLocal|autoPush/.test(src), "只读：不写账本、不推云端");
});

test("档位词表与行标题表：漏一项界面就会印出英文键名", () => {
  assert.deepEqual(Object.keys(ADV_VERDICTS), ["yes", "no", "unclear", "skip"]);
  const r = adv({ status: "manual", lockDays: null, openRule: "", feeRedeem: [],
    assets: [], investScope: "", source: null });
  r.lines.forEach(l => {
    assert.ok(ADV_LINE_TITLES[l.key], `行 ${l.key} 没有中文抬头`);
    assert.equal(l.title, ADV_LINE_TITLES[l.key]);
    assert.ok(["ok", "warn", "bad", "na", "skip"].indexOf(l.level) >= 0, `档位 ${l.level} 不在词表里`);
  });
});

test("开放安排的识别只认明确表述，认不出一律算未知", () => {
  assert.equal(isOpenRuleDaily("每个交易日可赎回"), true);
  assert.equal(isOpenRuleDaily("每日开放"), true);
  assert.equal(isOpenRuleDaily(""), false, "空串不是「随时可赎」");
  assert.equal(isOpenRuleDaily("每月 15 日开放"), false, "要靠日历判的写法不猜");
  assert.equal(isOpenRuleDaily("持有满 30 天后可赎"), false, "这句与持有期重复判定，认成开放会掩盖锁定期判定");
});

test("脏输入不炸：产品 / 持仓 / 日期缺成什么样都要给出一条能显示的话", () => {
  assert.equal(redeemAdvice({}).verdict, "skip");
  assert.equal(redeemAdvice({ p: prod(null), pos: null }).verdict, "skip");
  const r = redeemAdvice({ p: prod({ status: "manual", lockDays: 7, openRule: "每个交易日可赎回",
    feeRedeem: [{ from: 0, to: null, ratePct: 0.5 }] }), pos: POS, td: "不是日期" });
  assert.equal(r.verdict, "yes", "td 不合法只是少一行净值滞后提示，不该把整题判死");
  assert.ok(!r.lines.some(l => l.key === "nav"));
});

/* ---------- 页面接线（判定对了没上屏 = 没做） ---------- */
test("产品详情把这张卡挂在底层配置卡之后，钱走 shown()，费率不喂给 pct()", () => {
  const app = read("app.js");
  assert.ok(/import \{ redeemAdvice \} from "\.\/js\/domain\/advice\.js";/.test(app),
    "判定搬家到独立模块后 app.js 必须这么引；名字对不上就是引了个不存在的导出");
  assert.ok(app.includes("${discCard(p, pos)}\n    ${adviceCard(p, pos)}"),
    "这张卡要紧跟「底层配置与申赎规则」—— 判定的原料就在上面那张卡里");
  assert.ok(app.includes("redeemAdvice({ p, pos, td: today() })"),
    "「今天」由页面传进来，与 position()/体检同一个口径");
  /* 钱：三个数字都得包在 shown() 里 */
  ["money(adv.market)", "money(adv.net)", "money(adv.fee)"].forEach(x =>
    assert.ok(app.includes("shown(" + x + ")"), `这张卡的 ${x} 没走 shown()：隐藏金额打开时会明文`));
  /* 费率是百分数本身，喂给 pct()（入参小数）会大一百倍 */
  const body = app.slice(app.indexOf("function adviceCard("), app.indexOf("/* ============================================================\n   T2 · 持仓体检"));
  assert.ok(!/pct\(adv\.ratePct\)/.test(body), "pct() 的入参是小数，ratePct 是百分数，两者不是一回事");
  assert.ok(body.includes("只判这一只 · 不给换仓建议"),
    "卡片要写明这版不跨产品比较 —— 越界一步用户就以为换仓结论出来了");
  assert.ok(body.includes("ANA_LEVEL_TEXT"), "档位词必须是字，色带只是辅助");
});

test("离线清单里有 advice.js，版本跟着升（漏一个模块就是离线整页空白）", () => {
  const sw = read("sw.js");
  assert.ok(sw.includes('"./js/domain/advice.js"'), "advice.js 没进 sw.js 的 SHELL");
  assert.ok(sw.includes('const CACHE = "licai-ledger-v81"'), "新增模块 = 外壳变了，CACHE 必须跟着升");
  assert.ok(read("app.js").includes('const APP_VER = "v81"'), "APP_VER 要与 CACHE 同值");
});
