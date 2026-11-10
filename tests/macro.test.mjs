/* 宏观层（v118）的测试。跑法：node --test tests/macro.test.mjs
   ★ 这一层最容易错的两处：
     1. 单位 —— CPI/PPI 是同比百分数（0.7 = 0.7%），PMI 是指数值（49.3，不是 %）。
        两者混了，屏幕上就会出现「PMI 49.3%」这种莫名其妙的东西。
     2. 滞后 —— 11 月看到 10 月数据是常态，滞后 3 个月才是源出问题。
        不判滞后，「0.7%」看起来就像这个月的。
   下面是这两条的对照表。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MACRO_ITEMS, MACRO_PAGES, macroUrl, macroParse, macroLagMonths, macroPeriodText,
  macroDeltaText, macroValText, macroSpark, macroBlockHtml, macroPack, macroUnpack,
  macroText } from "../js/core/macro.js";

const item = k => MACRO_ITEMS.find(x => x.key === k);

/** 实测返回（2026-11-10，13 期）。 */
const CPI_RAW = {
  version: "x",
  result: {
    pages: 226,
    data: Array.from({ length: 13 }, (_, i) => {
      /* 倒序：2026-10 往前数 13 个月 */
      const d = new Date(2026, 9 - i, 1);
      return {
        REPORT_DATE: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01 00:00:00`,
        TIME: `${d.getFullYear()}年${d.getMonth() + 1}月份`,
        NATIONAL_SAME: [0.7, 0.9, 0.8, 0.5, 1.0, 1.2, 1.2, 1.0, 0.2, 1.3, 1.2, 0.8, 0.2][i],
      };
    }),
  },
  success: true,
};

test("清单：三项，字段名与接口实测一致，reportName 不重复", () => {
  assert.equal(MACRO_ITEMS.length, 3);
  assert.deepEqual(MACRO_ITEMS.map(x => x.key), ["CPI", "PPI", "PMI"]);
  assert.equal(MACRO_ITEMS[0].report, "RPT_ECONOMY_CPI");
  assert.equal(MACRO_ITEMS[0].field, "NATIONAL_SAME", "CPI 同比字段是 NATIONAL_SAME");
  assert.equal(MACRO_ITEMS[1].field, "BASE_SAME", "PPI 同比字段是 BASE_SAME");
  assert.equal(MACRO_ITEMS[2].field, "MAKE_INDEX", "PMI 字段是 MAKE_INDEX");
  assert.equal(new Set(MACRO_ITEMS.map(x => x.report)).size, 3, "reportName 重复了");
});

test("URL：走 datacenter 的 JSONP，带回调名、页码与倒序排序", () => {
  const u = macroUrl(item("CPI"), "__mcb1");
  assert.match(u, /^https:\/\/datacenter-web\.eastmoney\.com\/api\/data\/v1\/get\?/);
  assert.match(u, /callback=__mcb1/);
  assert.match(u, /reportName=RPT_ECONOMY_CPI/);
  assert.match(u, /pageSize=13/);
  assert.match(u, /sortColumns=REPORT_DATE&sortTypes=-1/);
  assert.match(u, /columns=REPORT_DATE%2CTIME%2CNATIONAL_SAME/, "只取需要的三列，别拉整行");
  assert.equal(MACRO_PAGES, 13);
});

test("解析：13 期按月份正序，latest / prev 取最后两期", () => {
  const p = macroParse(CPI_RAW, item("CPI"));
  assert.equal(p.ok, true, p.why);
  assert.equal(p.series.length, 13);
  assert.equal(p.latest.period, "2026-10");
  assert.equal(p.latest.val, 0.7);
  assert.equal(p.prev.period, "2026-09");
  assert.equal(p.prev.val, 0.9);
  /* 正序：第一个必须早于最后一个 */
  assert.ok(p.series[0].period < p.series[p.series.length - 1].period, "序列没有按正序排");
});

test("解析：坏行跳过，不整包拒收（与此刻层同一取舍）", () => {
  const j = JSON.parse(JSON.stringify(CPI_RAW));
  j.result.data[0].NATIONAL_SAME = null;      /* 值缺失 */
  j.result.data[1].REPORT_DATE = "2026/09";   /* 日期格式坏 */
  j.result.data[2].NATIONAL_SAME = "-";       /* 占位符 */
  const p = macroParse(j, item("CPI"));
  assert.equal(p.ok, true);
  assert.equal(p.series.length, 10);
  assert.equal(p.latest.period, "2026-07", "坏的三期去掉后，最新应为 7 月");
});

test("解析：接口报错要把原话带出来（改 reportName 时一眼知道是名字错了）", () => {
  const p = macroParse({ success: false, message: "报表配置不存在,RPT_X" }, item("CPI"));
  assert.equal(p.ok, false);
  assert.match(p.why, /报表配置不存在/);
  assert.deepEqual(p.series, []);
  assert.equal(p.latest, null);
});

test("解析：结构变了 / 空数组 → ok=false，不抛异常", () => {
  assert.equal(macroParse(null, item("CPI")).ok, false);
  assert.match(macroParse(null, item("CPI")).why, /result\.data/);
  assert.equal(macroParse({ result: { data: [] } }, item("CPI")).ok, false);
  assert.equal(macroParse({ result: { data: {} } }, item("CPI")).ok, false);
});

test("★ 单位：CPI 是百分数，PMI 是指数值 —— 只有前者带 %", () => {
  assert.equal(macroValText(0.7, item("CPI")), "0.7%");
  assert.equal(macroValText(5.7, item("PPI")), "5.7%");
  assert.equal(macroValText(49.3, item("PMI")), "49.3", "PMI 是指数，不带 %");
  assert.equal(macroValText(null, item("CPI")), "—");
});

test("差值：CPI/PPI 用「个百分点」，PMI 用「点」；零值写持平不带符号", () => {
  assert.equal(macroDeltaText(0.7, 0.9, item("CPI")), "-0.2个百分点");
  assert.equal(macroDeltaText(5.7, 5.0, item("PPI")), "+0.7个百分点");
  assert.equal(macroDeltaText(49.3, 50.1, item("PMI")), "-0.8点");
  assert.equal(macroDeltaText(49.3, 49.3, item("PMI")), "持平");
  assert.equal(macroDeltaText(null, 1, item("CPI")), "");
});

test("滞后：11 月看 10 月是 1 个月（常态），看 7 月是 4 个月（源出问题）", () => {
  assert.equal(macroLagMonths("2026-10", "2026-11-10"), 1);
  assert.equal(macroLagMonths("2026-10", "2026-11"), 1);
  assert.equal(macroLagMonths("2026-07", "2026-11-10"), 4);
  assert.equal(macroLagMonths("2025-12", "2026-01-05"), 1, "跨年要算对");
  assert.equal(macroLagMonths("2025-01", "2026-01"), 12);
  assert.ok(Number.isNaN(macroLagMonths("2026/10", "2026-11")));
  assert.ok(Number.isNaN(macroLagMonths("2026-10", "")));
});

test("月份文案：2026-10 → 2026年10月（不写 2026年10月份这种接口原话）", () => {
  assert.equal(macroPeriodText("2026-10"), "2026年10月");
  assert.equal(macroPeriodText("坏数据"), "坏数据");
});

test("走势：点数 < 2 不画，正常时给 svg", () => {
  assert.equal(macroSpark([]), "");
  assert.equal(macroSpark([{ period: "2026-10", val: 0.7 }]), "");
  const h = macroSpark([{ period: "2026-09", val: 0.9 }, { period: "2026-10", val: 0.7 }]);
  assert.match(h, /<svg/);
  assert.match(h, /polyline/);
});

test("渲染：三行都在，且不染色 —— 三行月度数撑不起方向判断", () => {
  const macro = { CPI: macroParse(CPI_RAW, item("CPI")) };
  const h = macroBlockHtml(macro, { today: "2026-11-10" });
  assert.match(h, /CPI 同比/);
  assert.match(h, /0\.7%/);
  assert.match(h, /2026年10月/);
  /* 不许出现红涨绿跌的语义类名：宏观方向非单调，染色等于替用户下判断 */
  assert.ok(!/mkt-up|mkt-down|mc-up|mc-down|rp-up|rp-down/.test(h), "宏观表被染色了");
});

test("渲染：必须写明「只报实际值」，且没有预期值可比", () => {
  const macro = { CPI: macroParse(CPI_RAW, item("CPI")) };
  const h = macroBlockHtml(macro, { today: "2026-11-10" });
  assert.match(h, /只报实际值/);
  assert.match(h, /预期值在付费终端/);
  assert.match(h, /不写「超预期 \/ 低于预期」/);
  assert.match(h, /PMI 是指数值，50 为荣枯线/);
});

test("渲染：数据滞后超过 2 个月要标出来（不标的话 0.7% 看起来像这个月的）", () => {
  const stale = { CPI: macroParse(CPI_RAW, item("CPI")) };
  const h = macroBlockHtml(stale, { today: "2027-02-10" });
  assert.match(h, /滞后 4 个月/);
  /* 正常滞后一个月不标 */
  const ok = macroBlockHtml(stale, { today: "2026-11-10" });
  assert.ok(!/滞后/.test(ok), "正常滞后不该标");
});

test("渲染：三项全没取到 → 空态，且把原因说出来", () => {
  const h = macroBlockHtml({}, { today: "2026-11-10", err: "超时（8 秒）" });
  assert.match(h, /没取到/);
  assert.match(h, /超时/);
  assert.ok(!/<table/.test(h), "没数据不该画一张空表");
  assert.equal(macroBlockHtml(null, {}).includes("<table"), false);
});

test("缓存：pack → unpack 往返一致", () => {
  const macro = { CPI: macroParse(CPI_RAW, item("CPI")) };
  const packed = macroPack(macro, 1794279605000);
  assert.equal(packed.v, 1);
  assert.equal(packed.src, "eastmoney_datacenter");
  const back = macroUnpack(JSON.parse(JSON.stringify(packed)));
  assert.ok(back);
  assert.equal(back.CPI.latest.val, 0.7);
  assert.equal(back.CPI.series.length, 13);
});

test("缓存：版本/来源不符 → null（旧缓存直接作废，不迁移）", () => {
  const macro = { CPI: macroParse(CPI_RAW, item("CPI")) };
  const packed = macroPack(macro, 1);
  assert.equal(macroUnpack({ ...packed, v: 0 }), null);
  assert.equal(macroUnpack({ ...packed, src: "sina" }), null);
  assert.equal(macroUnpack(null), null);
  assert.equal(macroUnpack({ v: 1, src: "eastmoney_datacenter", items: {} }), null);
});

test("缓存：localStorage 被改过也不许改单位（数值可来自缓存，名称与单位取本地清单）", () => {
  const macro = { CPI: macroParse(CPI_RAW, item("CPI")) };
  const packed = macroPack(macro, 1);
  /* 把 CPI 的数值改掉、塞进乱七八糟的字段：值可以变，但单位规则不跟着变 */
  packed.items.CPI.series[packed.items.CPI.series.length - 1].val = 99.9;
  packed.items.CPI.unit = "%";        /* 缓存里多塞一个 unit，不该被采信 */
  packed.items.CPI.kind = "index";
  const back = macroUnpack(packed);
  assert.equal(back.CPI.latest.val, 99.9, "数值本身来自缓存（这是缓存的本分）");
  assert.equal(macroValText(back.CPI.latest.val, item("CPI")), "99.9%", "单位仍按本地清单走");
});

test("研判段：三项齐全时一段写完，且写明不许写「超预期」", () => {
  const j = JSON.parse(JSON.stringify(CPI_RAW));
  const macro = { CPI: macroParse(j, item("CPI")) };
  const t = macroText(macro);
  assert.match(t, /^【宏观】/);
  assert.match(t, /CPI 同比 0\.7%（2026年10月，较上期 -0\.2个百分点）/);
  assert.match(t, /不许写「超预期 \/ 低于预期」/);
  assert.match(t, /不许据此推断下次数据/);
});

test("研判段：一项都没有 → 空串（调用方据此整段不写）", () => {
  assert.equal(macroText({}), "");
  assert.equal(macroText(null), "");
  assert.equal(macroText({ CPI: { ok: false } }), "");
});
