/* 产品收益表的口径与排序：
     node --test tests/board.test.mjs
   拆成纯函数模块（js/domain/board.js）的原因：app.js 里的渲染读 DOM、调 localStorage，
   node 进不去。而这张表最容易错的三处恰好都是「看了会拿错结论」的地方 ——
   月挂 0 数算错会让人以为某只产品在停息，排序把「—」顶到最前会让人以为它收益率最高。
   所以这三件事必须在 CI 里被执行一次，而不是靠肉眼看渲染结果。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_COLS, BOARD_LEAN, boardCols, NO_INST, instKey, instLabel, boardFilter, boardInstChips,
  isZeroWan, monthZeroDays, boardSort, boardNavAt, boardNavAtText } from "../js/domain/board.js";

const row = (o) => ({ name: "P", ikey: NO_INST, inst: "", code: "", prodCode: "",
  wan: null, a7: null, a14: null, a30: null, zero: 0, ...o });

/* ---- 列定义：顺序与文案就是产品页表头，改错了用户会读错口径 ---- */
test("表头顺序与列数不能漂", () => {
  assert.deepEqual(BOARD_COLS.map(c => c[0]),
    ["name", "wan", "a7", "a14", "a30", "zero", "navAt"]);
  assert.deepEqual(BOARD_COLS.map(c => c[1]),
    ["产品名称", "万收", "近7日年化", "近14日年化", "近30日年化", "月挂0数", "净值披露日"]);
  /* v54 按用户要求砍掉「持有天数」列：台账页那张卡还在算持有天数，产品表里它既占宽
     又不参与挑产品，删的是列不是口径（有测试盯着 BOARD_COLS 里不能再出现它）。 */
  assert.ok(!BOARD_COLS.some(c => c[0] === "holdDays"), "持有天数列已按用户要求移除");
  /* 每列都得有口径说明：万收/N 日年化这类折算口径不写清就会被当成官方数字 */
  for (const c of BOARD_COLS) assert.ok(c[2] && c[2].length > 8, `列 ${c[1]} 缺口径说明`);
  /* 口径拍板：数据里只有披露日、没有逐产品抓取时刻，列名不许写成「获取时间」 */
  assert.ok(BOARD_COLS[6][1].includes("披露日") && !BOARD_COLS[6][1].includes("获取时间"),
    "第 7 列必须叫「净值披露日」，不许把披露日冒充抓取时刻");
  assert.deepEqual([BOARD_COLS[6][3], BOARD_COLS[6][4]], ["披露", "日期"],
    "两行短表头要跟着口径改成「披露 / 日期」");
});

/* ---- v99 · 净值披露日列的取数口径（纯函数，不碰 DOM） ---- */
test("boardNavAt：抓取记录优先，回退账本最新净值日，脏值/空值都不编造", () => {
  assert.equal(boardNavAt({ latest: "2026-11-05" }, "2026-11-04"), "2026-11-05",
    "本轮抓取记录优先于账本最新净值日");
  assert.equal(boardNavAt(null, "2026-11-04"), "2026-11-04", "没有抓取记录时回退账本");
  assert.equal(boardNavAt({}, "2026-11-04"), "2026-11-04", "记录里没有 latest 也要回退");
  assert.equal(boardNavAt({ latest: "昨天" }, "2026-11-04"), "2026-11-04", "脏日期不许冒充");
  assert.equal(boardNavAt({ latest: "2026-13-45" }, ""), "", "格式不对就当不知道");
  assert.equal(boardNavAt(null, ""), "", "两处都没有就是空串，由渲染层显示「—」");
  assert.equal(boardNavAt(undefined, null), "", "空入参不炸");
});

test("boardNavAtText：表内只给 MM-DD，无值显示「—」", () => {
  assert.equal(boardNavAtText("2026-11-05"), "11-05");
  assert.equal(boardNavAtText(""), "—");
  assert.equal(boardNavAtText("昨天"), "—", "脏值不许漏进表格");
});

/* ---- 两行短表头（v48）：宽度是这张表的稀缺资源，短表头必须比完整文案更短 ---- */
test("每列的两行短表头都存在且不超过 4 字", () => {
  for (const c of BOARD_COLS) {
    for (const i of [3, 4]) {
      const s = c[i];
      assert.ok(typeof s === "string" && s.length >= 1, `列 ${c[1]} 缺第 ${i - 2} 行短表头`);
      assert.ok(s.length <= 4, `列 ${c[1]} 的短表头「${s}」${s.length} 字，会撑破列宽`);
    }
  }
});

/* ---- 精简 / 全部两种列模式 ---- */
test("精简列必须是全部列的子集，且保留首列与挂零列", () => {
  const all = BOARD_COLS.map(c => c[0]);
  for (const k of BOARD_LEAN) assert.ok(all.indexOf(k) >= 0, `精简列 ${k} 不在 BOARD_COLS 里`);
  assert.equal(BOARD_LEAN[0], "name", "精简模式首列必须是产品名，否则整行认不出是谁");
  assert.ok(BOARD_LEAN.indexOf("zero") >= 0, "精简模式要留住挂 0 天数：停息是必须看见的风险");
  assert.ok(BOARD_LEAN.length < BOARD_COLS.length, "精简模式没有真的少列");
});

test("boardCols()：full 给全 7 列，其它一律按精简", () => {
  assert.equal(boardCols("full").length, BOARD_COLS.length);
  assert.deepEqual(boardCols("lean").map(c => c[0]), BOARD_LEAN);
  assert.deepEqual(boardCols("").map(c => c[0]), BOARD_LEAN);
  assert.deepEqual(boardCols(undefined).map(c => c[0]), BOARD_LEAN);
  /* full 返回副本：调用方排序不能改到模块级的 BOARD_COLS */
  const f = boardCols("full");
  f.pop();
  assert.equal(BOARD_COLS.length, 7, "boardCols('full') 返回的不是副本");
});

/* ---- 机构键 ---- */
test("机构为空时落到哨兵键，显示为「未填机构」", () => {
  assert.equal(instKey(""), NO_INST);
  assert.equal(instKey("   "), NO_INST);
  assert.equal(instKey(undefined), NO_INST);
  assert.equal(instKey("  招银理财  "), "招银理财");
  assert.equal(instLabel(NO_INST), "未填机构");
  assert.equal(instLabel("招银理财"), "招银理财");
});

/* ---- 筛选 ---- */
test("按机构筛选：哨兵键能筛出未填机构的行", () => {
  const rows = [row({ name: "A", ikey: "招银理财", inst: "招银理财" }),
    row({ name: "B", ikey: NO_INST }),
    row({ name: "C", ikey: "兴银理财", inst: "兴银理财" })];
  assert.deepEqual(boardFilter(rows, "", "").map(r => r.name), ["A", "B", "C"]);
  assert.deepEqual(boardFilter(rows, NO_INST, "").map(r => r.name), ["B"]);
  assert.deepEqual(boardFilter(rows, "兴银理财", "").map(r => r.name), ["C"]);
});
test("关键字命中名称 / 登记编码 / 产品代码 / 机构，且不区分大小写", () => {
  const rows = [row({ name: "理财通1号", code: "Z00024S24ABC", prodCode: "25112035B", inst: "招银理财", ikey: "招银理财" }),
    row({ name: "现金管家", code: "", prodCode: "", inst: "兴银理财", ikey: "兴银理财" })];
  assert.deepEqual(boardFilter(rows, "", "现金").map(r => r.name), ["现金管家"]);
  assert.deepEqual(boardFilter(rows, "", "abc").map(r => r.name), ["理财通1号"]);
  assert.deepEqual(boardFilter(rows, "", "25112035b").map(r => r.name), ["理财通1号"]);
  assert.deepEqual(boardFilter(rows, "", "兴银").map(r => r.name), ["现金管家"]);
  assert.deepEqual(boardFilter(rows, "", "   ").map(r => r.name), ["理财通1号", "现金管家"], "空白搜索等于不过滤");
});
test("机构 chips 按行数降序，未填机构也在表里", () => {
  const rows = [row({ ikey: "招银理财" }), row({ ikey: "招银理财" }),
    row({ ikey: NO_INST }), row({ ikey: "兴银理财" }), row({ ikey: "兴银理财" }), row({ ikey: "兴银理财" })];
  const chips = boardInstChips(rows);
  assert.deepEqual(chips.map(c => c.n), [3, 2, 1]);
  assert.equal(chips[2].label, "未填机构");
});

/* ---- 万收挂零判定 ---- */
test("挂零判定：容差与无效值", () => {
  assert.equal(isZeroWan(0), true);
  assert.equal(isZeroWan(1e-9), true, "浮点残差应视为 0");
  assert.equal(isZeroWan(0.01), false);
  assert.equal(isZeroWan(-0.01), false);
  assert.equal(isZeroWan(null), false, "没披露不是挂零");
  assert.equal(isZeroWan(undefined), false);
  assert.equal(isZeroWan(NaN), false);
});

/* ---- 月挂 0 数：只数本月有披露的日子 ---- */
test("月挂 0 数只统计本月披露日", () => {
  const dates = ["2026-09-30", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
  const wan = [null, 0, 0.45, 0, 0.52];
  assert.equal(monthZeroDays(dates, wan, "2026-10"), 2);
  assert.equal(monthZeroDays(dates, wan, "2026-09"), 0, "9/30 的 wan 是 null，不能算挂零");
});
test("月挂 0 数：跨年 12 月 / 1 月不串月", () => {
  const dates = ["2025-12-31", "2026-01-01", "2026-01-02"];
  const wan = [0, 0, 0.3];
  assert.equal(monthZeroDays(dates, wan, "2025-12"), 1);
  assert.equal(monthZeroDays(dates, wan, "2026-01"), 1);
});
test("月挂 0 数：脏入参不炸表", () => {
  assert.equal(monthZeroDays(null, null, "2026-10"), 0);
  assert.equal(monthZeroDays([], [], "2026-1"), 0, "月份格式不对返回 0");
  assert.equal(monthZeroDays(["2026-10-01"], [], "2026-10"), 0, "wan 比 dates 短也不越界");
});

/* ---- 排序：缺值永远垫底 ---- */
test("数值列降序：null 排最后，且不随升/降序翻转", () => {
  const rows = [row({ name: "有值", a7: 0.02 }), row({ name: "缺值", a7: null }), row({ name: "更高", a7: 0.05 })];
  assert.deepEqual(boardSort(rows, "a7", false).map(r => r.name), ["更高", "有值", "缺值"]);
  assert.deepEqual(boardSort(rows, "a7", true).map(r => r.name), ["有值", "更高", "缺值"],
    "升序时缺值仍然垫底，否则点一次排序就把一堆「—」顶到最前");
});
test("名称列用中文排序，产品名不会因大小写乱序", () => {
  const rows = [row({ name: "招银理财招睿" }), row({ name: "兴银理财稳添" }), row({ name: "现金管家" })];
  const out = boardSort(rows, "name", true).map(r => r.name);
  assert.equal(out.length, 3);
  assert.deepEqual(boardSort(rows, "name", false).map(r => r.name), [...out].reverse());
});
test("挂零列升序时 0 在前，同值按名称稳定", () => {
  const rows = [row({ name: "B", zero: 2 }), row({ name: "A", zero: 2 }), row({ name: "C", zero: 0 })];
  assert.deepEqual(boardSort(rows, "zero", true).map(r => r.name), ["C", "A", "B"]);
});
test("排序不改动入参数组（渲染会反复调，原地排会打乱上一轮结果）", () => {
  const rows = [row({ name: "A", a7: 1 }), row({ name: "B", a7: 9 })];
  boardSort(rows, "a7", false);
  assert.deepEqual(rows.map(r => r.name), ["A", "B"]);
});
test("缺列值按字符串比也不抛（数字列混进字符串时）", () => {
  const rows = [row({ name: "A", a7: 3 }), row({ name: "B", a7: "10" })];
  const out = boardSort(rows, "a7", false);
  assert.equal(out.length, 2);
});
