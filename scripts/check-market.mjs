#!/usr/bin/env node
/* ============================================================
   v100 · 债市晴雨表参考数据门禁（Web CI 第 9 项）

   守的是三件事：
     1. data/market.reference.json 必须通过 js/core/market.js 的 validateMarket
        —— 校验器与页面/测试用的是同一个函数，这里不存在第二套判据；
        这条是硬门禁：数据结构坏、方向符号打架、禁用词命中 → exit 1。
        （私有仓引擎侧还有同一契约的另一道 validate_snapshot，两边任一失守都拦得住。）
     2. 参考数据要与 LICENSE 里公开仓「只读」的定位一致：文件必须真实存在
        —— 页面降级为 null 没关系，但仓里那份必须永远合法，它是 js/core/market.js
        和 tests/market.test.mjs 的公共测试夹具，坏了会把两处测试一起带歪。
     3. 新鲜度软提示：行情快照过期是「云端该重跑了」，不是「代码坏了」——
        只打印天数，不设硬阈值，避免把 PR 染成假红（同 check-shelf-freshness.mjs
        的先例）。真正的过期能在页面上看到（marketPanelHtml 的 asOf 直接可见）。

   用法：node scripts/check-market.mjs
   复验：把 data/market.reference.json 的 cells 砍掉一格 / 把方向和 BP 改打架，
        本脚本必须 exit 1。
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMarket, marketStat, MARKET_FORBIDDEN, MARKET_CELL_COUNT } from "../js/core/market.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF = path.join(ROOT, "data", "market.reference.json");
const fail = (why) => { console.error(`❌ 债市参考数据门禁：${why}`); process.exit(1); };

let raw;
try { raw = fs.readFileSync(REF, "utf8"); }
catch (e) { fail(`读不到 ${path.relative(ROOT, REF)}：${e.message}`); }

let m;
try { m = JSON.parse(raw); }
catch (e) { fail(`JSON 解析失败：${e.message}`); }

const chk = validateMarket(m);
if (!chk.ok) fail(`校验未过：${chk.why}`);

/* 双保险复扫（validateMarket 内已含同表，这里独立再扫一遍是为了让失败信息
   直接指到禁用词本身，不用读 why 拼句）。 */
const ai = String(m.aiText || "");
for (const w of MARKET_FORBIDDEN) {
  if (ai.includes(w)) fail(`aiText 命中禁用词「${w}」`);
}

const w = m.weather;
const st = marketStat(m);
const days = Math.floor((Date.now() - new Date(w.asOf + "T00:00:00+08:00").getTime()) / 86400000);
console.log(`✅ 债市参考数据合格：asOf=${w.asOf} prev=${w.prevDate} verified=${m.meta.verified} 格子 ${w.cells.length}/${MARKET_CELL_COUNT}`);
console.log(`   红 ${st.up} / 绿 ${st.down} / 白 ${st.flat} / 蓝 ${st.none} · aiText ${ai.length} 字 · 禁用词 ${MARKET_FORBIDDEN.length} 条 0 命中`);
if (days > 7) {
  console.log(`⚠️  快照已过 ${days} 天（asOf=${w.asOf}）：云端 Update NAV 该重跑了；本门禁只提醒，不阻断。`);
}
process.exit(0);
