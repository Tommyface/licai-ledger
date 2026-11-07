#!/usr/bin/env node
/* ============================================================
   v97 · 微众稳健货架「静态索引」离线生成器（确定性、不联网）

   产物：js/core/webank-shelf.js（ES module，app.js 顶层 import，同步可用）
        同一份数据另写一份等价 JSON 到 --mirror，供逐字节 / MD5 复验。

   为什么是 ES module 而不是运行时 fetch 的 .json：
     录入 / OCR / 详情渲染都要「即时命中」，同步 import 无异步时序；
     且 check-version.sh 的 import 闭包会把它自动纳入 SHELL 校验，
     少一处手工维护的守卫（与 P1「收敛重复守卫」同向）。

   输入（默认指向本轮实测证据，均为只读）：
     --shelf   微众货架全量快照  query_std_fin_prod_list_no_auth 5 页合并
               复验：GET https://personal.webank.com/wm-htrserver/finance/product_shelf/query_std_fin_prod_list_no_auth?param={"page_num":1,"page_size":100}
     --agents  净值瞭望列表行代销标签批量采集（按销售代码 ?q=）
               复验：GET https://bank.leyuw.com/?q=<销售代码> → 精确同代码行 <span class=chip> 以「代销」结尾者
     --detail  净值瞭望详情页「亦在…代销」证据（规范全称，取并集）
     --captured-at  快照日期 YYYY-MM-DD（可省）
     --out     产物路径
     --mirror  等价 JSON 路径（可省）

   v98 · 快照日期不再硬编码：旧版 meta.captured_at 写死 "2026-11-07"，
   重跑永远显示「新鲜」，前端的新鲜度判据形同虚设（真漏洞）。现在：
     ① 显式 --captured-at 优先；
     ② 否则从 --agents / --detail 证据文件的 captured_at 推导日期部分；
     ③ 都没有才回退到运行当天（北京时间 UTC+8）。
   前两条都是「同一份输入 → 同一份产物」，确定性不变；重新采集证据后
   日期会跟着变，shelfFreshness() 才会真正报出过期。

   纪律：
     · 只收「慢变」字段：身份 / 分类 / 风险码 / 持有期 / 起购规则 /
       增强策略标签 / 代销渠道。净值、周期年化、额度余量、销售状态等
       天天变的一律不进静态索引 —— 那些沿用账本的动态抓取通道，
       免得随版本冻结后把陈旧数字当成现值展示。
     · 空值语义沿用 disc.js 铁律：「不知道≠0」。`--` / 空串 / `0.0000` /
       占位一律不写入记录，缺字段由 webank.js 判定为「未披露」，不生成占位行。
     · 枚举码（thi_class / fund_pattern / risk_level / stb_fin_zone 等）
       项目内无字典表，这里只保留原始码，绝不臆造中文语义。
     · 产品线判定与代销归并都只在此脚本做一次「物料整理」，
       真正的判断函数收口在 js/core/webank.js。

   用法：
     node scripts/gen-webank-shelf.mjs \
       --shelf  /workspace/第8步-交付文件/webank_shelf_full.json \
       --agents /workspace/第9步-交付文件/净值瞭望-代销chip-全量459.json \
       --detail /workspace/第9步-交付文件/实施前-数据可行性证据.json \
       --out    js/core/webank-shelf.js \
       --mirror /workspace/第10步-交付文件/webank-shelf.json
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const P = {
  shelf: arg("--shelf", "/workspace/第8步-交付文件/webank_shelf_full.json"),
  agents: arg("--agents", "/workspace/第9步-交付文件/净值瞭望-代销chip-全量459.json"),
  detail: arg("--detail", "/workspace/第9步-交付文件/实施前-数据可行性证据.json"),
  capturedAt: arg("--captured-at", ""),
  out: arg("--out", path.join(ROOT, "js/core/webank-shelf.js")),
  mirror: arg("--mirror", ""),
};

/* v98 · 快照日期：显式参数 > 证据文件 captured_at 的日期部分 > 运行当天(北京时间)。
   不臆造：从证据里读到的日期才代表「这批数据是什么时候采的」。 */
const readJsonSafe = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return {}; } };
const dateFromEvidence = f => {
  const s = String((readJsonSafe(f) || {}).captured_at || "");
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : "";
};
const todayCN = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
/* 日历合法性：正则只管形状，2026-13-99 也会过 —— 必须回读年月日，
   否则产出非法日期会让前端 shelfFreshness() 算出 NaN/误判。 */
const validDay = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const resolveCapturedAt = () => {
  const explicit = P.capturedAt.trim();
  if (explicit) {
    if (!validDay(explicit)) {
      console.error(`❌ --captured-at 应为合法日期 YYYY-MM-DD，收到：${explicit}`);
      process.exit(2);
    }
    return explicit;
  }
  const fromEv = dateFromEvidence(P.agents) || dateFromEvidence(P.detail) || dateFromEvidence(P.shelf);
  if (validDay(fromEv)) return fromEv;
  console.warn("⚠️ 输入证据没有合法 captured_at，快照日期回退到运行当天（建议显式传 --captured-at 保持确定性）");
  return todayCN();
};

/* 「不知道」判定：占位值不算值。与 disc.js:isAssetNum / fieldCoverage 同纪律。 */
const PLACEHOLDER = new Set(["", "--", "-", "0.0000", "0.00", "0", "null", "undefined"]);
function has(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "" && !PLACEHOLDER.has(v.trim());
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  if (typeof v === "boolean") return v;                 // steadyFinance 恒真才收
  return true;                                         // 数字（含 0）：0 也是有效天数
}
function pick(src, getters) {
  const o = {};
  for (const [k, fn] of Object.entries(getters)) {
    let v;
    try { v = fn(src); } catch (e) { v = undefined; }
    if (has(v)) o[k] = v;                              // 缺字段不落盘 = 不知道
  }
  return o;
}
const ei = (r, k) => (r && typeof r.extra_info === "object" ? r.extra_info[k] : undefined);
const bs = (r, k) => (r && typeof r.buy_status_factor === "object" ? r.buy_status_factor[k] : undefined);
const sb = (r, k) => (r && typeof r.start_buy_amount === "object" ? r.start_buy_amount[k] : undefined);
const normDate = (s) => {
  const m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(String(s || "").trim());
  return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : (has(s) ? String(s).trim() : undefined);
};

/* 列表行 chip「XX代销」→ 规范名。只覆盖净值瞭望 agent 枚举里出现过的短名，
   有据可依；不在表内的保留原 chip 文本 + 标注，绝不臆造。 */
const CHIP_NORM = {
  "微众": "微众银行", "网商": "网商银行", "宁波": "宁波银行", "平安": "平安银行",
  "民生": "民生银行", "招商": "招商银行", "工商": "工商银行", "农业": "农业银行",
  "中国银行": "中国银行", "建设": "建设银行", "交通": "交通银行", "邮储": "邮储银行",
  "兴业": "兴业银行", "浦发": "浦发银行", "中信": "中信银行", "光大": "光大银行",
  "华夏": "华夏银行", "广发": "广发银行", "北京": "北京银行", "江苏": "江苏银行",
  "上海": "上海银行", "杭州": "杭州银行", "南京": "南京银行", "苏州": "苏州银行",
};
function normChip(chip) {
  const short = String(chip).replace(/代销\s*$/, "").trim();
  return CHIP_NORM[short] || short;                    // 未收录 → 保留短名，不臆造全称
}

const shelf = JSON.parse(fs.readFileSync(P.shelf, "utf8"));
let agentsEv = { rows: {} };
try { agentsEv = JSON.parse(fs.readFileSync(P.agents, "utf8")); } catch (e) { /* 缺代销证据 → 诚实降级 */ }
let detailEv = { leyuw: { product_detail_tags: [], list_row_agents_note: {} } };
try { detailEv = JSON.parse(fs.readFileSync(P.detail, "utf8")); } catch (e) { /* 同上 */ }

/* 代销并集：详情页规范名优先，列表行 chip 补充，各自带 via。
   详情页 .tags 是主渠道/直销说明，列表行才是全部代销 —— 两者取并集，不混用口径。

   v98 · 同名银行不再丢第二个口径：旧版 `some(name) → 跳过` 会悄悄丢掉
   「同一家同时被两种口径证实」的证据。现在单口径保持旧结构 {name, via}
   （产物逐字节不变），只有真出现多口径才升级为 {name, via, vias[]}；
   判据层 agentBanks() 两种结构都认。 */
const agentMap = {};
const addAgent = (code, name, via) => {
  if (!code || !name) return;
  const key = String(code).toUpperCase();
  agentMap[key] = agentMap[key] || [];
  const hit = agentMap[key].find(x => x.name === name);
  if (!hit) { agentMap[key].push({ name, via }); return; }
  if (hit.vias) {
    if (!hit.vias.includes(via)) hit.vias.push(via);
  } else if (hit.via !== via) {
    hit.vias = [hit.via, via];
  }
};
for (const x of (detailEv.leyuw && detailEv.leyuw.product_detail_tags) || []) {
  for (const b of x.agent_banks || []) addAgent(x.code, b, "净值瞭望详情页");
}
for (const [code, note] of Object.entries((detailEv.leyuw && detailEv.leyuw.list_row_agents_note) || {})) {
  for (const c of note.list_row_agents || []) addAgent(code, normChip(c), "净值瞭望列表行");
}
for (const [code, row] of Object.entries(agentsEv.rows || {})) {
  for (const c of row.agent_chips || []) addAgent(code, normChip(c), "净值瞭望列表行");
}

/* 慢变字段白名单。key 即静态索引里的扁平字段名，中文 label / 分组 / 出处
   统一由 js/core/webank.js 的字典维护，这里只做物料抽取。 */
const GETTERS = {
  product_name: r => r.product_name,
  ta_code: r => r.ta_code,
  establish_date: r => normDate(r.establish_date),
  risk_level: r => r.risk_level,
  bank_name: r => ei(r, "bank_name"),
  bank_short_name: r => ei(r, "bank_short_name"),
  min_amount_desc: r => ei(r, "min_amount_desc_recommend"),
  hold_rate_desc: r => ei(r, "hold_rate_desc"),
  rate_desc: r => ei(r, "rate_desc"),
  marketing_tag: r => ei(r, "tag"),
  thi_class: r => r.thi_class,
  fund_pattern: r => r.fund_pattern,
  fund_type: r => r.fund_type,
  stb_fin_zone: r => r.stb_fin_zone,
  steady_finance: r => (r.steadyFinance === true ? true : undefined),
  product_period: r => r.product_period,
  trd_product_period: r => r.trd_product_period,
  days_of_product_period: r => r.days_of_product_period,
  redeem_days_desc: r => r.redeem_early_pay_days_desc,
  start_buy_min: r => sb(r, "first_buy") ?? bs(r, "min_amount"),
  quota_flag: r => bs(r, "purchase_quota_flag"),
  fix_plus_prod_flag: r => (String(r.fix_plus_prod_flag) === "1" ? "1" : undefined),
  /* 固收+ 13 项（仅 108 只有，缺字段自然不写入） */
  fix_plus_ivt_tag: r => r.fix_plus_ivt_tag,
  fix_plus_ivt_pri_class: r => r.fix_plus_ivt_pri_class,
  fix_plus_ivt_sec_class: r => r.fix_plus_ivt_sec_class,
  fix_plus_equity_ratio: r => r.fix_plus_equity_ratio,
  fix_plus_equity_ratio_tag: r => r.fix_plus_equity_ratio_tag,
  fix_plus_core_ratio: r => r.fix_plus_core_ratio,
  fix_plus_core_ratio_tag: r => r.fix_plus_core_ratio_tag,
  fix_plus_asset_class_tag_list: r => r.fix_plus_asset_class_tag_list,
  maximum_drawdown: r => r.maximum_drawdown,
  maximum_drawdown_desc: r => r.maximum_drawdown_desc,
  maximum_drawdown_type: r => r.maximum_drawdown_type,
  fix_plus_volatility_zone: r => r.fix_plus_volatility_zone,
};

const byCode = {};
for (const r of shelf) {
  const code = String(r.product_code || "").toUpperCase().trim();
  if (!code) continue;
  const rec = pick(r, GETTERS);
  /* Plus 内层副本：只取「满7天随用随转」这类形态信息，不整行复制 */
  const pc = r.plus_copy;
  if (pc && typeof pc === "object") {
    rec.plus_flag = 1;
    if (has(pc.product_period)) rec.plus_period = pc.product_period;
    if (has(pc.days_of_product_period)) rec.plus_days = pc.days_of_product_period;
  }
  if (agentMap[code] && agentMap[code].length) rec.agents = agentMap[code];
  byCode[code] = rec;
}

const captured_at = resolveCapturedAt();
const meta = {
  captured_at,
  shelf_rows: Object.keys(byCode).length,
  agents_rows: Object.keys(agentMap).length,
  source_we: "微众稳健理财货架 query_std_fin_prod_list_no_auth（匿名 GET，5 页）",
  source_agents: "净值瞭望 bank.leyuw.com 列表行代销标签 + 详情页「亦在…代销」",
  note: "仅慢变字段；净值与周期年化沿用账本动态通道。枚举码无字典表，保留原值不臆造语义。",
};
const data = { meta, byCode };
const json = JSON.stringify(data);
const js = `/* 微众稳健货架静态索引 —— 由 scripts/gen-webank-shelf.mjs 确定性生成，请勿手改。
   快照 ${meta.captured_at} · ${meta.shelf_rows} 只 · 仅慢变字段。
   判断（命中 / 字段字典 / 标签 / 代销归并 / 空值语义 / 新鲜度）收口在 js/core/webank.js。
   头部不写版本号：它只是数据快照，版本由 app.js APP_VER / sw.js CACHE 管，
   免得每发一版都要回来同步一处假钉子（P1 收敛同向）。 */
export default ${json};
`;

fs.writeFileSync(P.out, js, "utf8");
if (P.mirror) fs.writeFileSync(P.mirror, JSON.stringify(data, null, 1) + "\n", "utf8");
const md5 = b => crypto.createHash("md5").update(b).digest("hex");
console.log(`产物 ${P.out}  bytes=${Buffer.byteLength(js)}  md5=${md5(js)}`);
if (P.mirror) {
  const m = fs.readFileSync(P.mirror);
  console.log(`镜像 ${P.mirror}  bytes=${m.length}  md5=${md5(m)}`);
}
console.log(`索引 ${meta.shelf_rows} 只 / 代销证据 ${meta.agents_rows} 只 / 字段键 ${new Set(Object.values(byCode).flatMap(r => Object.keys(r))).size} 种`);
