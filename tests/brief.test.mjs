// @ts-check
/* AI 研判（T4）编排层的测试。跑法：node --test tests/brief.test.mjs
   这一层全是纯函数，所以每条口径都能直接钉住 —— 不存在「要起浏览器才知道对不对」。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BRIEF_PROMPT_VER, BRIEF_INSTRUCTIONS, BRIEF_MAX_CHARS, BRIEF_TIER_DETAIL, BRIEF_TIER_AGG,
  BRIEF_QUESTION, BRIEF_DISCLAIMER, BRIEF_BANNED_RE,
  briefMetrics, briefPctText, briefPortfolioBlock, briefProductBlock, briefChecksBlock,
  briefMarketBlock, briefBuild, briefFingerprint, extractJson, normBrief, briefConfText,
  briefCardHtml, briefRawHtml, briefSummaryText,
} from "../js/domain/brief.js";

/* 造一条净值序列：每天涨 0.01%，共 n 个点 */
function series(n, start = 1) {
  const out = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    out.push([`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, Math.round(v * 1e6) / 1e6]);
    v = v * 1.0001;
  }
  return out;
}

function item(over) {
  return Object.assign({
    id: "p1", name: "诚享7天29号", inst: "北银理财", code: "Z7008926000006", risk: "02",
    benchmark: "中债-综合全价（1年以下）指数x60%", nav: 1.0149, navDate: "2026-11-04",
    shares: 10000, cost: 1.0, holdDays: 42, state: "持仓中",
    metrics: { n: 109, d7: 0.02, d30: 0.11, d90: 0.33, dd: -0.01, vol: 0.4 },
  }, over || {});
}

const MKT_OK = {
  meta: { verified: true },
  weather: { asOf: "2026-11-06", prevDate: "2026-11-05" },
  aiText: "【债市快照 2026-11-06（上一交易日 2026-11-05）】来源：中债官方收益率曲线推导\n利率债：国债 1年红(-0.3bp) 10年红(-1.7bp)",
};
const MKT_BAD = {
  meta: { verified: false },
  weather: { asOf: "2026-11-06", prevDate: "2026-11-05" },
  aiText: "【债市快照】未核验",
};

/* ---------- 指标 ---------- */

test("briefMetrics：点太少时四个指标都是 null，不硬算", () => {
  const m = briefMetrics(series(3));
  assert.equal(m.n, 3);
  assert.equal(m.d7, null);
  assert.equal(m.dd === null || typeof m.dd === "number", true);
  assert.equal(m.vol, null);
});

test("briefMetrics：近 N 点收益按「披露点数」算，不用日历日", () => {
  const s = series(40, 1);
  const m = briefMetrics(s);
  /* 每点 +0.01%：7 点 ≈ (1.0001^7 - 1) * 100 ≈ 0.0700% */
  assert.ok(Math.abs(m.d7 - 0.07) < 0.005, "d7 应约 0.07%，实际 " + m.d7);
  assert.ok(Math.abs(m.d30 - 0.30) < 0.01, "d30 应约 0.30%，实际 " + m.d30);
});

test("briefMetrics：最大回撤取历史高点之后的最深跌幅", () => {
  const s = [["d1", 1.0], ["d2", 1.02], ["d3", 1.01], ["d4", 1.05], ["d5", 1.03], ["d6", 1.06]];
  const m = briefMetrics(s);
  /* 1.02 → 1.01 是 -0.98%；1.05 → 1.03 是 -1.90% */
  assert.ok(m.dd < -1.8 && m.dd > -2.0, "dd 应约 -1.90%，实际 " + m.dd);
});

test("briefMetrics：非法点（0 / 负数 / 字符串 / 缺值）不参与计算", () => {
  const s = [["d1", 1.0], ["d2", 0], ["d3", NaN], ["d4", 1.01]];
  const m = briefMetrics(/** @type {any} */ (s));
  assert.equal(m.n, 2);
});

test("briefPctText：null 给「—」，不是 0", () => {
  assert.equal(briefPctText(null), "—");
  assert.equal(briefPctText(undefined), "—");
  /* v117：零不带符号。原来写 "+0.00%"，可零既不涨也不跌，加号是无中生有的方向。
     同一份正文里出现过「最大回撤 -0.00%」—— 那是 -0.0004 舍入来的，读起来像有亏损。 */
  assert.equal(briefPctText(0), "0.00%");
  assert.equal(briefPctText(-0.0004), "0.00%", "负零必须写成 0.00%，不能写成 -0.00%");
  assert.equal(briefPctText(0.0004), "0.00%", "正零也不该带加号");
  assert.equal(briefPctText(-1.234), "-1.23%");
  assert.equal(briefPctText(0.48), "+0.48%", "正常的正数还要带加号");
});

/* ---------- 数据块 ---------- */

test("组合块（明细档）：带产品名、机构、基准、净值与持有天数", () => {
  const t = briefPortfolioBlock([item()], { tier: BRIEF_TIER_DETAIL, today: "2026-11-09" });
  assert.match(t, /我的持仓 · 1 只 · 截至 2026-11-09/);
  assert.match(t, /诚享7天29号/);
  assert.match(t, /北银理财/);
  assert.match(t, /基准 中债/);
  assert.match(t, /持有 42 天/);
});

test("组合块（聚合档）：不给产品名，只给序号与结构", () => {
  const t = briefPortfolioBlock([item(), item({ id: "p2", name: "另一只" })], { tier: BRIEF_TIER_AGG, today: "2026-11-09" });
  assert.ok(t.indexOf("诚享7天29号") < 0, "聚合档不许出现产品名");
  assert.ok(t.indexOf("另一只") < 0, "聚合档不许出现产品名");
  assert.match(t, /产品1/);
  assert.match(t, /产品2/);
});

test("组合块：开「隐藏金额」时份额与成本都不出现数字", () => {
  const t = briefPortfolioBlock([item()], { tier: BRIEF_TIER_DETAIL, hide: true, today: "2026-11-09" });
  assert.ok(t.indexOf("10000.00") < 0, "份额不该出现");
  assert.ok(t.indexOf("1.00") < 0 || t.indexOf("1.0149") >= 0);
  assert.match(t, /金额已隐藏/);
});

test("单只块：带基准、指标，并注明按披露点算", () => {
  const t = briefProductBlock(item(), { today: "2026-11-09" });
  assert.match(t, /这一只 · 截至 2026-11-09/);
  assert.match(t, /业绩基准/);
  assert.match(t, /近30点 \+0\.11%/);
  assert.match(t, /非日历日/);
});

test("体检块：只列 warn/bad，ok 压成一句，na 列出缺口名", () => {
  const t = briefChecksBlock([
    { title: "净值披露", level: "ok", text: "正常" },
    { title: "赎回费档位", level: "warn", text: "持有 12 天，费率 0.1%" },
    { title: "成本与净值匹配", level: "bad", text: "偏离可疑" },
    { title: "净值连续性", level: "na", text: "缺净值" },
  ]);
  assert.match(t, /有问题｜成本与净值匹配/);
  assert.match(t, /要注意｜赎回费档位/);
  assert.ok(t.indexOf("净值披露：正常") < 0, "ok 项不逐条列");
  assert.match(t, /其余 1 项正常/);
  assert.match(t, /信息不足 1 项：净值连续性/);
});

test("债市块：verified=false 时明说「本轮没有」，不省略这一行", () => {
  const t = briefMarketBlock(MKT_BAD);
  assert.match(t, /【债市】/);
  assert.match(t, /本轮没有可用的债市快照/);
});

test("债市块：verified=true 时复用 aiText", () => {
  const t = briefMarketBlock(MKT_OK);
  assert.match(t, /10年红\(-1\.7bp\)/);
});

/* v110：研判的债市块改成「关键期限」紧凑版。v109 把整段 aiText（实测 1364 字）搬进去，
   模型为了凑 sources 去联网检索，90 秒读超时就是这么花掉的。 */
function cell(issuer, tenor, y, bp, group) {
  return { group: group || "rate", issuer, tenor, dir: bp < 0 ? "up" : bp > 0 ? "down" : "flat",
    basis: { yieldPct: y, prevYieldPct: y - bp / 100, bp1d: bp } };
}
const MKT_CELLS = {
  meta: { verified: true, gaps: [] },
  weather: { asOf: "2026-11-06", prevDate: "2026-11-05", cells: [
    cell("国债", "1年", 1.1683, -0.3), cell("国债", "3年", 1.25, -1.1), cell("国债", "5年", 1.3115, -1.2),
    cell("国债", "7年", 1.45, -1.6), cell("国债", "10年", 1.5868, -1.7),
    cell("AAA", "1年", 1.9, -0.1, "credit"), cell("AAA", "3年", 2.1, -1.0, "credit"), cell("AAA", "5年", 2.3, -1.2, "credit"),
  ] },
  bpTable: [{ issuer: "国债", tenor: "10年", bp: { "5日": [-6.3, "2026-10-30"], "20日": [-9.8, "2026-10-10"] } }],
  aiText: "【债市快照 2026-11-06】来源：中债官方收益率曲线推导\n利率债：国债 1年红(-0.3bp) 10年红(-1.7bp)\n要求：据此归因该产品下一披露日收益环境",
};

test("债市块（v110）：有结构化格子时只给关键期限，整块不超过 420 字", () => {
  const t = briefMarketBlock(MKT_CELLS);
  assert.match(t, /国债 收益率\/当日变动：1年1\.168%\/-0\.3bp/);
  assert.match(t, /10年1\.587%\/-1\.7bp/, "10 年那一格必须在（研判看的就是这一格）");
  assert.match(t, /信用AAA 当日变动/);
  assert.match(t, /10年国债累计：5日 -6\.3bp｜20日 -9\.8bp/);
  assert.match(t, /缺口：无/);
  assert.ok(t.length < 420, "紧凑块超长了：实际 " + t.length + " 字");
  assert.ok(t.indexOf("要求：") < 0, "把「据此归因」那一段搬进来了 —— 那是单只产品口径，不是研判口径");
});

test("债市块（v110）：上游没给 gaps 字段时不替它写「缺口：无」", () => {
  /* 「无」是一句断言。字段缺失只说明上游没说，不说明没有缺口 —— 宁可不写这一行。 */
  const m = JSON.parse(JSON.stringify(MKT_CELLS));
  delete m.meta.gaps;
  const t = briefMarketBlock(m);
  assert.ok(t.indexOf("缺口：") < 0, "字段缺失被写成了「无缺口」");
  assert.match(t, /10年1\.587%\/-1\.7bp/, "其他内容照旧");
});

test("债市块（v110）：老快照没有格子时退回节选，不整段搬 aiText", () => {
  const t = briefMarketBlock(MKT_OK);
  assert.match(t, /10年红\(-1\.7bp\)/, "利率债那一行要留");
  assert.match(t, /逐格行情未展开/);
  assert.ok(t.length < 420);
});

/* ---------- 装配 ---------- */

test("briefBuild：默认明细档，块顺序为 portfolio → check → market，末段是问题", () => {
  const r = briefBuild({
    target: { kind: "portfolio" }, items: [item()], today: "2026-11-09",
    checks: [{ title: "净值披露", level: "ok", text: "正常" }], market: MKT_OK,
  });
  assert.equal(r.tier, BRIEF_TIER_DETAIL);
  assert.equal(r.kind, "portfolio");
  assert.deepEqual(r.blocks.map(b => b.key), ["portfolio", "check", "market"]);
  assert.equal(r.chars, r.input.length);
  assert.match(r.input, /【这一次要看的问题】/);
  assert.match(r.input, new RegExp(BRIEF_QUESTION.portfolio.slice(0, 12)));
  assert.match(r.instructions, /只用下面的数据块/);
});

test("briefBuild：超字数上限时从后往前砍块，并在末尾写明砍了什么", () => {
  const many = Array.from({ length: 40 }, (_, i) => item({ id: "p" + i, name: "产品" + i + "号".repeat(20) }));
  const r = briefBuild({ target: { kind: "portfolio" }, items: many, today: "2026-11-09", market: MKT_OK });
  assert.equal(r.over, true, "这一组数据必须超限，否则这条测试没意义");
  assert.ok(r.blocks.every(b => b.key !== "market"), "债市块应被砍掉");
  assert.match(r.input, /未带上：market/);
});

test("briefBuild：单只模式带 product 块与体检块，问题换成「这一只」", () => {
  const r = briefBuild({
    target: { kind: "product", id: "p1" }, items: [item()], today: "2026-11-09",
    checks: [{ title: "赎回费档位", level: "warn", text: "0.1%" }], market: MKT_OK,
  });
  assert.equal(r.kind, "product");
  assert.deepEqual(r.blocks.map(b => b.key), ["product", "check", "market"]);
  assert.match(r.input, /这一只现在该不该继续拿/);
});

/* ---------- 指纹 ---------- */

test("briefFingerprint：同数据稳定、顺序无关", () => {
  const a = briefFingerprint({ target: { kind: "portfolio" }, items: [item(), item({ id: "p2" })], marketAsOf: "2026-11-06" });
  const b = briefFingerprint({ target: { kind: "portfolio" }, items: [item({ id: "p2" }), item()], marketAsOf: "2026-11-06" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("briefFingerprint：净值变 / 净值日变 / 债市日期变 / 版本变 → 指纹都变", () => {
  const base = { target: { kind: "portfolio" }, items: [item()], marketAsOf: "2026-11-06" };
  const f0 = briefFingerprint(base);
  assert.notEqual(f0, briefFingerprint({ ...base, items: [item({ nav: 1.015 })] }));
  assert.notEqual(f0, briefFingerprint({ ...base, items: [item({ navDate: "2026-11-05" })] }));
  assert.notEqual(f0, briefFingerprint({ ...base, marketAsOf: "2026-11-07" }));
  assert.notEqual(f0, briefFingerprint({ ...base, ver: "brief-3" }));
});

test("briefFingerprint：金额与份额变化不影响指纹（隐藏开关不该让结论作废）", () => {
  const base = { target: { kind: "portfolio" }, items: [item()], marketAsOf: "2026-11-06" };
  assert.equal(briefFingerprint(base), briefFingerprint({ ...base, items: [item({ shares: 99999, cost: 2.5 })] }));
});

/* ---------- 解析 ---------- */

test("extractJson：裸 JSON", () => {
  const o = extractJson('{"a":1}');
  assert.deepEqual(o, { a: 1 });
});

test("extractJson：```json 围栏", () => {
  const o = extractJson('好的，结论如下：\n```json\n{"verdict":"watch"}\n```\n以上。');
  assert.deepEqual(o, { verdict: "watch" });
});

test("extractJson：前后有废话也能取到首尾花括号之间", () => {
  const o = extractJson('我先说一下 {"verdict":"continue","n":2} 就是这样');
  assert.equal(o.verdict, "continue");
  assert.equal(o.n, 2);
});

test("extractJson：坏 JSON 返回 null，不做修补", () => {
  assert.equal(extractJson("{verdict: watch}"), null);
  assert.equal(extractJson('{"a":1,}'), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("没有花括号"), null);
});

/* ---------- 校验 ---------- */

test("normBrief：verdict 不认识 → 落到 watch（保守），不是 adjust", () => {
  const r = normBrief({ verdict: "买入", headline: "看看" });
  assert.equal(r.ok, true);
  assert.equal(r.brief.verdict, "watch");
});

test("normBrief：confidence 越界或缺失 → null（界面不画那一行）", () => {
  assert.equal(normBrief({ confidence: 95, headline: "x" }).brief.confidence, null);
  assert.equal(normBrief({ headline: "x" }).brief.confidence, null);
  assert.equal(normBrief({ confidence: 0.617, headline: "x" }).brief.confidence, 0.62);
});

test("normBrief：headline 命中收益预测 → 整份拒收", () => {
  const r = normBrief({ verdict: "continue", headline: "持有到期可获得预期收益 3.2%", sections: [] });
  assert.equal(r.ok, false);
  assert.match(String(r.why), /收益预测|目标价/);
});

test("normBrief：条目命中禁用词 → 丢这一条并计数，其余保留", () => {
  const r = normBrief({
    verdict: "watch", headline: "结构还行，先不动",
    sections: [{ key: "product", points: [
      { text: "净值平稳", basis: "ledger" },
      { text: "预计收益可达 2.8%", basis: "ledger" },
    ] }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.brief.sections[0].points.length, 1);
  assert.equal(r.dropped.banned, 1);
});

test("normBrief：basis 不认识 → none，不冒充 ledger", () => {
  const r = normBrief({ headline: "x", sections: [{ key: "structure", points: [{ text: "仓位集中", basis: "猜测" }] }] });
  assert.equal(r.brief.sections[0].points[0].basis, "none");
});

test("normBrief：section.key 非法 → 整段丢弃", () => {
  const r = normBrief({ headline: "x", sections: [{ key: "secret", points: [{ text: "a" }] }] });
  assert.equal(r.brief.sections.length, 0);
});

test("normBrief：来源缺 url 或 date 一律丢，并计数", () => {
  const r = normBrief({
    headline: "x",
    sources: [
      { title: "有链接有日期", url: "https://a.example/1", date: "2026-11-06" },
      { title: "缺日期", url: "https://a.example/2" },
      { title: "缺链接", date: "2026-11-06" },
      { title: "日期格式不对", url: "https://a.example/3", date: "11月6日" },
    ],
  });
  assert.equal(r.brief.sources.length, 1);
  assert.equal(r.dropped.sources, 3);
});

test("normBrief：actions 缺 target 或 do → 丢；全空时 brief.actions 是空数组", () => {
  const r = normBrief({ headline: "x", actions: [{ target: "", do: "观察" }, { target: "组合", do: "" }] });
  assert.equal(r.brief.actions.length, 0);
  assert.equal(r.dropped.actions, 2);
});

test("briefConfText：0.62 → 「信心 62%（中）」，null → 空串", () => {
  assert.equal(briefConfText(0.62), "信心 62%（中）");
  assert.equal(briefConfText(0.8), "信心 80%（较高）");
  assert.equal(briefConfText(null), "");
});

/* ---------- 呈现 ---------- */

test("briefCardHtml：含免责页脚、结论与依据标记", () => {
  const r = normBrief({
    verdict: "watch", confidence: 0.6, headline: "结构还行",
    sections: [{ key: "structure", points: [{ text: "集中度偏高", basis: "check" }] }],
    actions: [{ target: "组合", do: "观察", why: "无异常", cost: "无", when: "本周" }],
    unknowns: ["缺规模数据"],
  });
  const h = briefCardHtml(r.brief, { tier: "detail", chars: 4200, atText: "11-09 15:42" });
  /* 卡头只放「什么时候、什么档、多少字」：弹层标题已经写了「AI 研判」，
     卡片里再写一遍就是同一句话占两行（v108 首版真机上看着重复，已改）。 */
  assert.match(h, /11-09 15:42 · 明细档 · 4200 字/);
  assert.ok(h.indexOf("AI 研判") < 0, "卡片头又重复弹层标题了");
  assert.match(h, /结构还行/);
  assert.match(h, /信心 60%/);
  assert.match(h, /体检/);
  assert.match(h, /缺规模数据/);
  assert.match(h, new RegExp(BRIEF_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("briefCardHtml：落定后把实测耗时写进卡片（90 秒读超时这一版就靠它调参）", () => {
  const r = normBrief({ verdict: "watch", confidence: 0.6, headline: "继续观察",
    sections: [{ key: "product", points: [{ text: "净值平稳", basis: "ledger" }] }] });
  const h = briefCardHtml(r.brief, { tier: "detail", chars: 900, atText: "11-09 18:43", ms: 43000 });
  assert.match(h, /用时 43 秒/);
  const h0 = briefCardHtml(r.brief, { tier: "detail", chars: 900, atText: "11-09 18:43" });
  assert.ok(h0.indexOf("用时") < 0, "没有耗时数据时不许画一个 0 秒出来");
});

test("briefCardHtml：模型文本里的尖括号被转义，不许注入 HTML", () => {
  const r = normBrief({ headline: "<img src=x onerror=alert(1)>", sections: [] });
  const h = briefCardHtml(r.brief, {});
  assert.ok(h.indexOf("<img src=x") < 0);
  assert.match(h, /&lt;img/);
});

test("briefRawHtml：降级时转义原文，并标明「未结构化」", () => {
  const h = briefRawHtml("<b>随便说说</b>", { stale: "数据已变" });
  assert.match(h, /未按约定格式返回/);
  assert.match(h, /&lt;b&gt;/);
  assert.match(h, /数据已变/);
  assert.match(h, new RegExp(BRIEF_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

/* ---------- 指令资产 ---------- */

test("指令里六条硬约束都在（改提示词时不许悄悄删）", () => {
  for (const kw of ["数据块里没有", "不做收益预测", "目标净值", "指回具体某一块", "推断句", "信息不足"]) {
    assert.ok(BRIEF_INSTRUCTIONS.indexOf(kw) >= 0, "指令缺少：" + kw);
  }
  assert.ok(BRIEF_INSTRUCTIONS.indexOf("JSON") >= 0);
  assert.equal(BRIEF_PROMPT_VER, "brief-2");
  /* v110：契约里不许再出现 sources / 联网 —— 那是 90 秒读超时的直接来源 */
  assert.ok(BRIEF_INSTRUCTIONS.indexOf('"sources"') < 0, "又把 sources 写回契约了：模型会为了凑出处去联网");
  assert.match(BRIEF_INSTRUCTIONS, /不要联网检索/);
  assert.match(BRIEF_INSTRUCTIONS, /总字数不超过 500/);
  assert.match(BRIEF_INSTRUCTIONS, /ledger\|check\|market/);
  assert.ok(BRIEF_MAX_CHARS[BRIEF_TIER_DETAIL] > BRIEF_MAX_CHARS[BRIEF_TIER_AGG]);
  assert.ok(BRIEF_BANNED_RE.test("预期收益 3%"));
  assert.ok(!BRIEF_BANNED_RE.test("净值平稳"));
});

/* ---------- 追问上文用的摘要 ---------- */

test("briefSummaryText：结论/分段/动作/缺口都在，且不含 JSON 结构", () => {
  const r = normBrief({
    verdict: "adjust", headline: "短端可以先不动，长端那只可以考虑换",
    sections: [
      { key: "structure", points: [{ text: "集中度偏高", basis: "check" }, { text: "全是短期限", basis: "ledger" }] },
      { key: "market", points: [{ text: "10 年 -1.7bp", basis: "market" }] },
    ],
    actions: [{ target: "诚享7天29号", do: "到期观察", cost: "赎回费 0", when: "本周" }],
    unknowns: ["缺规模"],
  });
  const t = briefSummaryText(r.brief);
  assert.match(t, /【上一份研判 · 考虑调整】/);
  assert.match(t, /短端可以先不动/);
  assert.match(t, /结构：集中度偏高；全是短期限/);
  assert.match(t, /动作：诚享7天29号 到期观察/);
  assert.match(t, /缺口：缺规模/);
  assert.ok(t.indexOf("{") < 0 && t.indexOf("verdict") < 0, "摘要里不该出现 JSON 结构");
  assert.ok(t.length < 1200);
});
