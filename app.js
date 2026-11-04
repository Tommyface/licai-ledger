/* ============================================================
   个人理财台账 · 核心逻辑
   数据模型 / 收益计算 / 日历 / 交易录入 / GitHub 同步
   ============================================================ */
"use strict";

/* ---------- 模块导入 ----------
   纯逻辑拆到 js/ 下按领域分文件：core 放无状态工具与机构识别，
   domain 放净值/持仓/OCR 这些算钱的地方。import 在模块顶层会被提升，
   所以下面的代码可以照旧按任意顺序引用它们。
   注意：ES module 的顶层声明**不再**自动挂到 window 上 ——
   内联 onclick 需要的那批入口在文件末尾统一 Object.assign 回 window。 */
import { $, pad, fmtDate, parseDate, today, money, signMoney, pct, cls, uid, esc, toast, dayDiff,
  maskMoney, maskTone }
  from "./js/core/util.js";
import { ORG_NAME, detectOrg, detectOrgByProdCode, prodCodeOf, fetchStatus }
  from "./js/core/orgs.js";
import { parseProductInput, rowAddable } from "./js/core/paste.js";
import { navSeries, navAt, latestNav, navHit } from "./js/domain/nav.js";
import { sharesOn as sharesOnWith, hasAnyTrade as hasAnyTradeIn,
  computePosition } from "./js/domain/position.js";
import { ocrNavLines } from "./js/domain/ocr.js";
import { configureCalendar, suggestTradeDates, tradeDaysBetween } from "./js/domain/calendar.js";
import { normTomb, mergeTombs, purgeTombs, applyTombs as applyTombsIn } from "./js/domain/tomb.js";
import { mergeForPush } from "./js/domain/sync.js";
import { syncBadge, syncLine } from "./js/domain/syncstatus.js";
import { readRelease, updateVerdict } from "./js/domain/update.js";
import { NO_INST, instKey, instLabel, boardFilter, boardInstChips,
  boardCols, monthZeroDays, boardSort } from "./js/domain/board.js";
import { marketOn as marketOnAt, monthBounds, monthList, monthReport,
  productMonthDays, profitShares } from "./js/domain/monthly.js";
import { DISC_TIERS, normDisc, parseDiscForm, discGaps, discHasContent, feeRateFor,
  DISC_TIER_LABEL, DISC_GAP_LABEL, applyAutoDisc, rulesDue, RULES_COOLDOWN_DAYS } from "./js/core/disc.js";
import { runChecks, portfolioChecks, anaFingerprint, normAnaCache, anaCacheState,
  anaRowParts, anaEntryTarget, anaEntryStatus,
  ANA_LEVELS, ANA_LEVEL_TEXT, ANA_CACHE_V } from "./js/domain/analysis.js";
import { redeemAdvice } from "./js/domain/advice.js";
import { switchAdvice } from "./js/domain/switchadv.js";
import { llmReq, llmParse, llmChunkFeed, llmChunkJoin, llmCanRetry,
  llmDegrade, LLM_BRIDGE, LLM_TIMEOUT_MS, llmTranscript, llmRoundInput, llmBudget, LLM_MAX_ROUNDS,
  llmSnapshot, LLM_SNAPSHOT_MAX_ITEMS, llmMetaOf, llmMetaErr, LLM_CANCEL_TEXT } from "./js/domain/llm.js";

/* ---------- 常量 ---------- */
const LS_DATA = "licai_ledger_v1";
const LS_SYNC = "licai_ledger_sync_v1";
/* 通知开关与「已忽略的告警」存本机，不进 licai-data.json：
   通知权限是「每台设备授权一次」的东西，同步过去没有意义；
   告警的「已读」同理只对当前设备成立 —— 放进 DATA 会被 autoPush 推给别的设备，
   反而让另一台设备漏掉该看到的提醒。 */
const LS_NOTIFY = "licai_ledger_notify_v1";
const LS_ALERT = "licai_ledger_alert_v1";
/* 产品收益表的列模式（"full" / "lean"）只存本机：一台手机一块屏，
   列数合不合得下是各设备自己的事，同步过去反而会把窄屏设备顶成横滑。 */
const LS_BD = "licai.bdCols";
/* 持仓体检（T2）的结论缓存也只存本机：它记的是「这台设备上一次看的时候数据是什么样」。
   进 licai-data.json 的话，另一台设备一同步就拿到别人机器上的「结论生成时间」，
   那句话当场就是假的。 */
const LS_ANA = "licai.anaCache";
/* 前端版本号：与 sw.js 的 CACHE 后缀必须一致（scripts/check-version.sh 会校验）。
   升版时两处一起改：这里 + sw.js 的 CACHE。
   页面上会显示出来 —— 之前「推了代码但页面没变」排查起来全靠猜，有了它一眼可判。 */
const APP_VER = "v79";
const NAV_API = "https://xinxipilu.chinawealth.com.cn/lcxp-platService";
const DETAIL_PAGE = "https://xinxipilu.chinawealth.com.cn/queryMenu/prodType/prodTypeDetail?prodRegCode=";

/* 本轮抓取「这条净值是从哪条线来的」——云端每次抓取都会对同一产品同时查
   【官网抓取器】与【中国理财网聚合源】，自动择优，结果写在
   settings.lastFetch.products[产品id]。这里读出来给用户看（来源 / 最新日期 /
   为什么选它 / 两源是否一致）。没有记录（如从未抓过）时返回 null。 */
function navSrcInfo(p) {
  const lf = lastFetchInfo();
  const all = (lf && lf.products) || {};
  let info = all[String((p && p.id) || "")];
  if (!info) {
    /* 兜底：产品 id 迁移过时，用登记编码 / 产品代码再找一次 */
    const keys = [p && p.code, p && p.prodCode, p && p.regCode]
      .map(x => String(x || "").trim().toUpperCase()).filter(Boolean);
    for (const k of Object.keys(all)) {
      if (keys.includes(String(k).toUpperCase())) { info = all[k]; break; }
    }
  }
  return info && info.latest ? info : null;
}
/* 来源摘要的一行文字（含择优理由），供详情页 / 说明页复用 */
function navSrcText(info) {
  if (!info) return "";
  const n = (info.sources || []).length;
  const base = `${info.via}·${info.label} ${info.latest}`;
  const why = info.why ? `（${info.why}）` : "";
  const both = n > 1 ? "｜双线已比对" : "｜另一条线本次未取到";
  const cf = info.conflicts && info.conflicts.length
    ? `｜⚠️ 与另一源有 ${info.conflicts.length} 处同日数值差异` : "";
  return base + why + both + cf;
}

/* ---------- 数据 ---------- */
/*
 data = {
   products: [{
      id,
      code(产品登记编码，Z/C 开头，用于中国理财网信披平台查询),
      prodCode(产品代码，云端 fetch_nav.py 抓净值的依据),
      name, inst(发行机构),
      manager / riskLevel / orgName / estDate / benchmark(云端抓取后回填),
      navHistory: { "YYYY-MM-DD": navNumber },
      createdAt
   }],
   trades: [{
      id, prodId, type: "buy"|"sell",
      tradeDate, confirmDate, amount, confirmNavDate, confirmNav,
      shares,               // 买入=金额/确认净值；赎回=填份额
      realized,             // 赎回时结算的已实现收益
      note, createdAt
   }],
   settings:{ hideAmount:false }
 }
*/
let DATA = { products: [], trades: [], settings: { hideAmount: false } };
/* owner / repo 预填本台账的默认仓库（v46）：这是个人台账，不是给别人装的产品，
   首次配置真正缺的只有 Token 一格。换仓库 / 换文件路径的口子留在同步面板的
   「高级」里，没有删。 */
let SYNC = { owner: "glorywork", repo: "licai-data", path: "licai-data.json", token: "", sha: "", auto: true };
/* 提醒状态（本机）：on = 用户是否开启了系统通知；lastCheck = 上次比对云端的时间戳 */
let NOTIFY = { on: false, lastCheck: 0 };
/* 用户已忽略的抓取告警签名（按「失败集合」生成，集合一变就重新提示） */
let ALERT_DISMISSED = "";
let UI = { range: "day", groupBy: "inst", calY: 0, calM: 0, selDate: "", activePick: "", viewProd: "", detTab: "active", prodRange: "3m", prodOv: "a7", detQ: "", detInst: "", detSort: "dayP", detAsc: false, switchTo: "",
  /* 产品页收益表：机构筛选 / 搜索 / 排序列与方向（默认按 7 日年化降序 ——
     v54 起持有天数那一列已下线，默认键跟着落到表里第一列数字上）
     bdCols = "" 表示这台设备还没选过列模式，此时按屏宽给默认（见 bdMode()） */
  bdQ: "", bdInst: "", bdSort: "a7", bdAsc: false, bdCols: "",
  /* 资产月报（v55）：当前查看的月份。0 = 还没打开过，首次打开落到最近一个有收益变动的月份 */
  repY: 0, repM: 0 };

/* ---------- 「隐藏」开关的两个唯一出口 ----------
   以前各处手写「隐藏时输出四个星」的三元式，写漏一处就等于没遮：
   台账页的日收益大字、日历格子里的当日收益、明细里的当日盈亏都漏过。
   现在渲染里凡是金额 / 收益类数值一律走 shown()，涨跌色一律走 tone()
   （颜色会泄露正负，只遮数字不遮颜色等于没遮）。app_core.test.mjs 有一条
   源码级门禁盯着这几个渲染函数，新增字段忘了遮会直接把 CI 跑红。 */
/** @param {string} text 已格式化的显示文本 */
function shown(text) { return maskMoney(DATA.settings.hideAmount, text); }
/** @param {number} v 决定涨跌色的数值 */
function tone(v) { return maskTone(DATA.settings.hideAmount, v); }

/* ---------- 持久化 ---------- */
/* （workdaysBetween 已删除：定义后从未被调用，且容易让人误以为 T+1 用工作日口径 —— 2026-09-15 审查清理） */
let STORAGE_BAD = false;   /* 只提示一次，成功后自动复位 */
/* 数据版本号：每次 saveLocal（即任何对 DATA 的持久化改动）+1，
   position() 的结果缓存据此失效（v32 P1-3）。 */
let _POS_VER = 0;
/* 本地有改动尚未成功推送到云端时为 true（v32 P0-2）：
   静默拉取（启动 / 回前台 / online / 后台轮询）看到 dirty 会先推后拉，
   避免云端旧数据把本地还没推上去的编辑覆盖丢掉。 */
let DIRTY = false;
/* v46：DIRTY 从「一个没人看的布尔」升级成「能说话的状态」。
   dirtyAt（最后编辑）、pushAt（最后一次成功推送）、err（上次失败原因）、
   nextAt / retryN（退避重试排到哪一步）一起存本机，顶栏胶囊与设置页那句说明
   全由它们算出来 —— 显示口径是纯函数，在 js/domain/syncstatus.js 里有测试。
   布尔 DIRTY 保留：既有五处判断读它比 `dirtyAt > 0` 直白，而且旧版本写的
   ".dirty" 值（"1"/"0"）要接着认得住。 */
let SYNC_ST = { dirtyAt: 0, pushAt: 0, err: "", nextAt: 0, retryN: 0 };
const LS_ST = LS_SYNC + ".st";
function stPersist() {
  try { localStorage.setItem(LS_ST, JSON.stringify(SYNC_ST)); } catch (e) { }
}
function dirtyPersist() {
  try { localStorage.setItem(LS_DATA + ".dirty", DIRTY ? "1" : "0"); } catch (e) { }
  if (DIRTY) SYNC_ST.dirtyAt = Date.now();     /* 「最后编辑 X 前」按最近一次改动算 */
  else { SYNC_ST.dirtyAt = 0; SYNC_ST.err = ""; SYNC_ST.nextAt = 0; SYNC_ST.retryN = 0; }
  stPersist();
  /* 状态一变就重画顶栏胶囊：dirty 正是「用户刚敲完一笔」的那一刻，让他立刻看见
     「待推送」比 1.5 秒后自动推完才看见「已同步」更诚实，也更像一个活的东西。 */
  syncStateView();
}
function saveLocal() {
  _POS_VER++; DIRTY = true; dirtyPersist();
  try {
    localStorage.setItem(LS_DATA, JSON.stringify(DATA));
    if (STORAGE_BAD) { STORAGE_BAD = false; toast("本地存储已恢复", 2400); }
  } catch (e) {
    console.warn(e);
    if (!STORAGE_BAD) {
      STORAGE_BAD = true;
      toast("⚠️ 本地存储不可用（隐私模式或空间已满），本次修改未保存到本机", 4600);
    }
  }
}
function loadLocal() {
  try {
    const s = localStorage.getItem(LS_DATA);
    if (s) { const o = JSON.parse(s); DATA = Object.assign({ products: [], trades: [], settings: {} }, o); }
    const y = localStorage.getItem(LS_SYNC);
    if (y) {
      const o = JSON.parse(y);
      /* v46：owner/repo/path 现在有预填默认值，存过的空串不能把它抹掉
         （早期只要点过一次「保存配置」而仓库留空，localStorage 里就是三个空串） */
      for (const k of Object.keys(o)) {
        if (!o[k] && (k === "owner" || k === "repo" || k === "path")) continue;
        SYNC[k] = o[k];
      }
    }
    DIRTY = localStorage.getItem(LS_DATA + ".dirty") === "1";   /* v32 P0-2 */
    try { SYNC_ST = Object.assign(SYNC_ST, JSON.parse(localStorage.getItem(LS_ST) || "{}")); } catch (e) { }
    /* 列模式只认这两个值：别的（包括旧版本写坏的值）一律当「没选过」，让屏宽来决定 */
    try { const m = localStorage.getItem(LS_BD); if (m === "full" || m === "lean") UI.bdCols = m; } catch (e) { }
    /* 老数据只有布尔、没有时间点：只能从「看见它还没推」的这一刻算起，
       否则界面会显示「最后编辑 5900 天前」这种荒唐话。 */
    if (DIRTY && !SYNC_ST.dirtyAt) SYNC_ST.dirtyAt = Date.now();
    if (!DIRTY) { SYNC_ST.dirtyAt = 0; SYNC_ST.err = ""; SYNC_ST.nextAt = 0; SYNC_ST.retryN = 0; }
  } catch (e) { console.warn(e); }
}
function saveSync() {
  try { localStorage.setItem(LS_SYNC, JSON.stringify(SYNC)); }
  catch (e) { console.warn(e); /* 同步配置存不进去只影响下次免输入，不弹窗打扰 */ }
}

/* ============================================================
   删除墓碑（防止「删掉的东西被另一台设备推回来」）
   ------------------------------------------------------------
   同步是整文件 PUT。另一台设备如果还拿着删除前的快照，它的一次推送就会把
   已删产品/交易原样写回；syncPush 的「云端独有净值并入」也会把刚删的那天
   净值补回来。墓碑记 { kind: { key: 删除时间戳 } }，随 payload 上传；
   每次推送前先并合云端墓碑并执行删除，30 天后自动过期 ——
   过期是为了让官网以后真正补发的同日期净值仍能被正常接收。
   纯逻辑在 js/domain/tomb.js，这里只保留与 DATA 打交道的薄壳。 */
const TOMB_DAYS = 30;

function tombstones() {
  DATA.tomb = normTomb(DATA.tomb);
  return DATA.tomb;
}
/** @param {"products"|"trades"|"navs"} kind @param {string} key */
function tombAdd(kind, key) { tombstones()[kind][key] = Date.now(); }

/** 清理过期墓碑，返回清理条数 */
function tombPurge() { return purgeTombs(tombstones(), Date.now(), TOMB_DAYS); }

/**
 * 按墓碑删除数据（产品 / 交易 / 净值日期），返回删除条数。
 * @param {any} d
 */
function applyTombs(d) {
  if (!d) return 0;
  d.tomb = normTomb(d.tomb);
  return applyTombsIn(d, d.tomb);
}

/* ============================================================
   数据迁移与去重
   ------------------------------------------------------------
   背景（来自项目交接文档）：早期版本只有「销售代码」一栏，用户把云端抓
   净值要用的「产品代码」错填在了那里；同时同一只产品被拆成了两条记录
   （一条有交易记录、一条有云端净值），云端 fetch_nav.py 读到的是登记编码
   而非产品代码，于是报「未取到净值」。

   本函数做两件事：
     1) shareCode → prodCode 搬迁
     2) 同一产品的重复记录合并：净值取并集 / 交易改指 / 字段补全
   返回是否发生了变更。
   ============================================================ */
/* 净值并集遇到同一日期不同取值时的策略：
   true  = 取小数位更多的一方（更接近官方披露的精确值，如 1.011291 优于 1.0113）
   false = 保留「保留方」的原有值（与云端「已有净值不覆盖」同口径） */
const MIGRATE_PREFER_PRECISE_NAV = true;

const MERGE_FIELDS = ["name", "inst", "code", "prodCode", "riskLevel", "manager", "orgName", "estDate", "benchmark", "lastNavSync"];

function navCount(p) { return Object.keys((p && p.navHistory) || {}).length; }
function hasTrade(p) { return DATA.trades.some(t => t.prodId === p.id); }
/* 保留优先级：有交易 > 有净值 > 字段更全 > 创建更早（返回负值者胜出并被保留） */
function mergeRank(a, b) {
  const ta = hasTrade(a) ? 1 : 0, tb = hasTrade(b) ? 1 : 0;
  if (ta !== tb) return tb - ta;
  const na = navCount(a) > 0 ? 1 : 0, nb = navCount(b) > 0 ? 1 : 0;
  if (na !== nb) return nb - na;
  const fa = MERGE_FIELDS.filter(k => String(a[k] || "").trim()).length;
  const fb = MERGE_FIELDS.filter(k => String(b[k] || "").trim()).length;
  if (fa !== fb) return fb - fa;
  return (a.createdAt || 0) - (b.createdAt || 0);
}
/* 判定两条记录是否同一产品：机构一致，且（登记编码相同 / 产品代码相同 / 名称互相包含） */
function isSameProduct(a, b) {
  const oa = detectOrg(a), ob = detectOrg(b);
  if (!oa || oa !== ob) return false;
  const ca = String(a.code || "").trim(), cb = String(b.code || "").trim();
  if (ca && cb && ca.toUpperCase() === cb.toUpperCase()) return true;
  const pa = String(a.prodCode || "").trim(), pb = String(b.prodCode || "").trim();
  if (pa && pb && pa.toUpperCase() === pb.toUpperCase()) return true;
  /* 产品代码都填了但不一致：不同份额/不同产品，同样禁止名称误合并（v32 P1-5） */
  if (pa && pb && pa.toUpperCase() !== pb.toUpperCase()) return false;
  const na = String(a.name || "").trim(), nb = String(b.name || "").trim();
  if (!na || !nb) return false;
  const s = na.length <= nb.length ? na : nb;
  const l = na.length <= nb.length ? nb : na;
  /* 短名至少 8 字符且被长名完整包含，避免「7天」这类短名误合并 */
  return s.length >= 8 && l.indexOf(s) >= 0;
}
/* 把 drop 并入 keep */
function absorbProduct(keep, drop) {
  keep.navHistory = keep.navHistory || {};
  const dn = drop.navHistory || {};
  for (const d of Object.keys(dn)) {
    const cur = keep.navHistory[d];
    if (cur === undefined || cur === null || cur === "") { keep.navHistory[d] = dn[d]; continue; }
    if (MIGRATE_PREFER_PRECISE_NAV) {
      const p1 = (String(cur).split(".")[1] || "").length;
      const p2 = (String(dn[d]).split(".")[1] || "").length;
      if (p2 > p1) keep.navHistory[d] = dn[d];
    }
  }
  for (const t of DATA.trades) { if (t.prodId === drop.id) t.prodId = keep.id; }
  for (const k of MERGE_FIELDS) {
    if (!String(keep[k] || "").trim() && String(drop[k] || "").trim()) keep[k] = drop[k];
  }
  if (!keep.createdAt || (drop.createdAt && drop.createdAt < keep.createdAt)) keep.createdAt = drop.createdAt;
}
function migrateData() {
  let changed = false; const logs = [];
  /* 0) 墓碑：清理过期的；执行仍有效的（别的设备删过的数据不在本机复活）。
     放在最前面 —— 后面的「重复产品合并」不该把已删除的记录再算进来。 */
  const purged = tombPurge();
  const removed = applyTombs(DATA);
  if (purged || removed) {
    changed = true;
    if (removed) logs.push(`按删除墓碑清理 ${removed} 条已被删除的数据`);
  }
  /* 1) 销售代码 → 产品代码；旧字段一律清掉（含历史遗留的空串） */
  for (const p of DATA.products) {
    if (p.shareCode === undefined) continue;
    const sc = String(p.shareCode || "").trim();
    if (!String(p.prodCode || "").trim() && sc) {
      p.prodCode = sc; changed = true;
      logs.push(`「${p.name || p.code || p.id}」：销售代码 ${sc} 已搬迁为产品代码`);
    }
    const pc = String(p.prodCode || "").trim().toUpperCase();
    if (!sc || pc === sc.toUpperCase()) { delete p.shareCode; changed = true; }
  }
  /* 2) 重复产品合并（列表在变，故命中后从头重扫，保证多对重复都能合并） */
  outer: for (let i = 0; i < DATA.products.length; i++) {
    for (let j = i + 1; j < DATA.products.length; j++) {
      const a = DATA.products[i], b = DATA.products[j];
      if (!a || !b || !isSameProduct(a, b)) continue;
      const keep = mergeRank(a, b) <= 0 ? a : b;
      const drop = keep === a ? b : a;
      absorbProduct(keep, drop);
      DATA.products = DATA.products.filter(x => x !== drop);
      changed = true;
      logs.push(`合并重复产品：「${drop.name || drop.id}」→「${keep.name || keep.id}」`);
      i = -1; continue outer;
    }
  }
  if (changed) { saveLocal(); UI.migrateLog = logs; }
  return changed;
}
/* 迁移结果提示（不打断操作，细节打到控制台） */
function notifyMigrate() {
  const logs = UI.migrateLog || [];
  if (!logs.length) return;
  try { console.log("[migrate]\n" + logs.join("\n")); } catch (e) { }
  const merged = logs.filter(s => s.indexOf("合并重复产品") === 0).length;
  const moved = logs.length - merged;
  const parts = [];
  if (merged) parts.push(`合并重复产品 ${merged} 组`);
  if (moved) parts.push(`搬迁产品代码 ${moved} 项`);
  if (parts.length) toast("数据已自动整理：" + parts.join("、"), 4200);
}

/* ============================================================
   收益计算核心
   ============================================================ */
/* ---------- 确认口径（T+1）----------
   理财产品申购/赎回都是「T 日申请、T+1 日确认」，确认日之前份额未到账：
     · 不计入持仓份额与市值
     · 不产生收益
   所以凡是要「结算到某一天为止」的地方，都不能直接用 position().shares（那是今天的），
   要用 sharesOn(p, date) —— 否则历史日历/区间收益会拿今天的份额去乘过去的净值差。 */

/* 兼容旧调用签名：交易列表统一取 DATA.trades（纯函数实现在 js/domain/position.js）。
   保留这层薄壳，日历/区间收益/明细等 40+ 处调用点不用逐个改参数。 */
function sharesOn(p, date) { return sharesOnWith(p, DATA.trades, date); }
function hasAnyTrade(p) { return hasAnyTradeIn(p, DATA.trades); }

/* 日历以代码内置数据为准，云端 settings.tradeCal 可以补年 / 改截止时间：
   国务院一般 11 月才发下一年的安排，把新一年写进数据文件就不用重发 APK。
   拉取、导入、启动后都重新合并一次（只增改，不会清掉内置年份）。 */
function applyCalendarConfig() {
  configureCalendar(DATA.settings && DATA.settings.tradeCal);
}

/* 净值滞后（按交易日）：最新净值日期之后又过了几个交易日。
   ≥2 个交易日还没新净值才算「滞后」——披露当天与前一个交易日之间属于正常等待，
   长假期间也不算（自然日口径会在国庆/春节误报一堆）。 */
function navStaleInfo(p) {
  const l = latestNav(p);
  if (!l) return null;
  const lag = tradeDaysBetween(l[0], today());
  return lag >= 2 ? { lag, date: l[0] } : null;
}

/* 该日是否有任一产品披露了净值。
   用来区分「未披露」（无数据，不该显示成 0）与「收益为 0」（有净值但持平）。 */
function dayDisclosed(date) {
  return DATA.products.some(p => {
    const v = navAt(p, date);
    return v !== undefined && v !== null && v !== "";
  });
}

/* 某产品当前持仓：份额、成本（成本法：加权平均）
   确认口径：只有确认日 <= 今天的买入才计入 shares/cost；
   确认日 > 今天的买入进 pendingShares/pendingAmount（在途），不计息、不显示市值。
   算法本体在 js/domain/position.js（纯函数 computePosition）；这里只保留缓存。 */
/* position 结果缓存（v32 P1-3）：渲染热路径每轮反复调 position/portfolio，
   全量重算 O(产品×交易)。以「数据版本号 + 当天日期」为键 ——
   任何 saveLocal 都会 bump _POS_VER；跨天由 day 比对自动失效。 */
const _posCache = new Map();
function position(p) {
  const td = today();
  const _ck = _posCache.get(p.id);
  if (_ck && _ck.ver === _POS_VER && _ck.day === td) return _ck.pos;
  const pos = computePosition(p, DATA.trades, td);
  _posCache.set(p.id, { ver: _POS_VER, day: td, pos: pos });
  return pos;
}

/* 全仓汇总（三态）
   持仓中：已有确认份额（或已产生已实现收益）
   在途：  有买入但一份都未确认（T+1），不计入总额
   已清仓：份额归零但留下过交易 —— 单独归档，别让它从账本里消失 */
function portfolio() {
  const all = DATA.products.map(p => ({ p, pos: position(p) }));
  const rows = all.filter(r => r.pos.shares > 0);
  const pendingRows = all.filter(r => r.pos.inTransit);
  const closedRows = all.filter(r => r.pos.shares <= 0 && !r.pos.inTransit && hasAnyTrade(r.p));
  const totalAsset = rows.reduce((s, r) => s + r.pos.market, 0);
  const totalCost = rows.reduce((s, r) => s + r.pos.cost, 0);
  const totalPending = pendingRows.reduce((s, r) => s + r.pos.pendingAmount, 0);
  const totalRealized = DATA.trades.filter(t => t.type === "sell").reduce((s, t) => s + (Number(t.realized) || 0), 0);
  return { rows, pendingRows, closedRows, totalAsset, totalCost, totalPending, totalRealized };
}

/* 区间收益（#19 口径，2026-09-15）：逐披露日加权 ——
   每个披露日用「截至当日已确认份额」× 当日净值差，与日历 dayProfit 完全同口径。
   旧实现用「区间末份额 × 整段净值差」：月中买入会把建仓前涨幅算给它（虚高）、
   月中卖出漏计已卖份额段（虚低），且与日历逐日加总不一致。
   区间边界：算 (fromDate, toDate] 内的披露日（fromDate 当日净值作基准不计入）。 */
function periodProfit(fromDate, toDate) {
  let s = 0;
  for (const p of DATA.products) {
    const s0 = navSeries(p);
    for (let i = 1; i < s0.length; i++) {
      const d = s0[i][0];
      if (d <= fromDate || d > toDate) continue;
      const sh = sharesOn(p, d);
      if (sh > 0) s += sh * (Number(s0[i][1]) - Number(s0[i - 1][1]));
    }
  }
  return s;
}
/* 某一天的收益：仅当该日「有净值更新」时才计入（以净值日期为准）。
   避免周末/节假日把上一个交易日的收益重复显示。
   份额取「截至该日已确认的份额」—— 申购确认前不该凭空生息。 */
function dayProfit(date) {
  let s = 0;
  for (const p of DATA.products) {
    const sh = sharesOn(p, date);
    if (sh <= 0) continue;
    const s0 = navSeries(p);
    /* 找到净值日期恰好等于 date 的那条；没有则该日无收益 */
    const idx = s0.findIndex(x => x[0] === date);
    if (idx <= 0) continue;
    s += sh * (Number(s0[idx][1]) - Number(s0[idx - 1][1]));
  }
  return s;
}
/* 某自然月收益（#19 口径，2026-09-15）：该月每个披露日的日收益加总
   （当日已确认份额 × 净值差），与日历逐日加总完全一致。
   v55 起这条循环本体搬到 js/domain/monthly.js 的 productMonthDays ——
   首页那两格「本月 / 上月收益」与资产月报的月收益必须是同一个数，
   两处各写一遍迟早会算出两个版本（用户拿它对银行 App 的账）。 */
function monthProfit(y, m) {
  const b = monthBounds(y, m);
  let s = 0;
  for (const p of DATA.products) {
    for (const [, v] of productMonthDays(p, DATA.trades, b.first, b.last)) s += v;
  }
  return s;
}

/* 某日的组合市值（截至该日已确认份额 × 该日最近净值）—— 年化分母用，
   不能拿今天的市值去折算历史月份（当月加仓会把上月年化压低）。
   本体同样搬进 monthly.js，首页年化与月报年化的分母从此是同一句话。 */
function marketOn(endDate) { return marketOnAt(DATA.products, DATA.trades, endDate); }

/* 组合年化（本月/上月）：区间收益 / 该月末市值 × 365 / 在册天数 */
function annualize(profit, y, m) {
  const cur = new Date();
  const isCur = cur.getMonth() + 1 === m && cur.getFullYear() === y;
  const end = isCur ? today()
    : `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
  const denom = marketOn(end);
  const days = isCur ? Math.max(cur.getDate(), 1) : new Date(y, m, 0).getDate();
  if (denom <= 0 || days <= 0) return 0;
  return (profit / denom) * 365 / days;
}

/* ============================================================
   渲染：首页
   ============================================================ */
function renderHome() {
  const pf = portfolio();
  $("totalAsset").textContent = shown(money(pf.totalAsset));
  $("tradeHint").textContent = `共 ${DATA.trades.length} 笔交易 · ${pf.rows.length} 只持仓`
    + (pf.pendingRows.length ? ` · ${pf.pendingRows.length} 只在途` : "");
  /* 资产月报入口那行提示（v55）：让用户不点开也知道这个月赚了多少、值不值得看 */
  if ($("monthlyHint")) $("monthlyHint").textContent = monthlyHintText();
  /* 今日/区间收益 */
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth() + 1;
  let val = 0, lab = "";
  if (UI.range === "day") {
    /* v35（对齐 oldox 口径）：显示「最近一个已披露日」的全仓收益并标注日期与更新状态。
       旧实现 dayProfit(today()) 配 sumDate 的 latestDateAll()，数字与日期错位——
       今天没披露时显示「今日收益 0.00 · 2026-09-17」，看着像披露日收益为 0，误导。
       净值多为 T+1 披露，绝大多数时间打开都该看最近披露日的收益。 */
    const ld = latestDateAll() || today();
    val = dayProfit(ld);
    lab = ld === today() ? "今日收益" : "最新披露日收益";
  }
  else if (UI.range === "week") {
    const d = new Date(now); const w = d.getDay(); const off = (w === 0 ? 6 : w - 1);
    const mon = new Date(d); mon.setDate(d.getDate() - off);
    val = periodProfit(fmtDate(mon), today()); lab = "本周收益";
  } else { val = monthProfit(y, m); lab = "本月收益"; }
  const rate = pf.totalAsset > 0 ? val / pf.totalAsset : 0;
  const big = $("sumBig");
  /* v45：隐藏开关必须盖住这里。以前只遮「持有资产」，日收益大字与百分比、
     月度年化、日历格子数字全是明晃晃的 —— 「隐藏」按下去只藏了一只角。
     颜色也一起收（tone），否则一片绿照样暴露今天赚没赚。 */
  big.textContent = shown(signMoney(val)); big.className = "big " + tone(val);
  $("sumRate").textContent = shown(`(${val >= 0 ? "+" : ""}${pct(rate)})`);
  $("sumRate").className = "rate " + tone(val);
  const ldAll = latestDateAll();
  $("sumDate").textContent = `${lab} · ${ldAll || today()}`
    + (UI.range === "day" ? (ldAll === today() ? " · 已全部更新" : " · 今日暂未披露") : "");
  /* 月度统计 */
  const mNow = monthProfit(y, m), mPrevMonth = (m === 1 ? 12 : m - 1), mPrevYear = (m === 1 ? y - 1 : y), mPrev = monthProfit(mPrevYear, mPrevMonth);
  setStat("statM1", mNow, true); setStat("statM0", mPrev, true);
  setStat("statM1r", annualize(mNow, y, m), false, true);
  setStat("statM0r", annualize(mPrev, mPrevYear, mPrevMonth), false, true);
  setStat("statReal", pf.totalRealized, true);
  /* 口径透明化：把「这笔钱是怎么算出来的」写在数字旁边，避免误读成官方数字 */
  const sellsN = DATA.trades.filter(t => t.type === "sell").length;
  if ($("statRealCap")) $("statRealCap").textContent = `赎回结算 · 均价法扣减成本 · 已核算 ${sellsN} 笔赎回`;
  $("statCnt").textContent = pf.rows.length; $("statCnt").className = "v";
  if ($("appVer")) $("appVer").textContent = `版本 ${APP_VER}`;
  renderCal(); renderDetail();
}
function setStat(id, v, isMoney, isPct) {
  const e = $(id);
  /* 金额与百分比（年化）都算收益类数值：隐藏时一起遮，颜色一起收 */
  e.textContent = shown(isMoney ? signMoney(v) : (v >= 0 ? "+" : "") + pct(v));
  e.className = "v " + tone(v);
}
function latestDateAll() {
  let d = "";
  for (const p of DATA.products) { const l = latestNav(p); if (l && l[0] > d) d = l[0]; }
  return d;
}

/* ---------- 日历 ---------- */
function renderCal() {
  const now = new Date();
  if (!UI.calY) { UI.calY = now.getFullYear(); UI.calM = now.getMonth() + 1; }
  const y = UI.calY, m = UI.calM;
  $("calTitle").textContent = `${y}年${m}月`;
  /* 每日收益映射。
     关键：区分「未披露」与「收益为 0」——
     没有净值的那天不是「没赚钱」，而是「还没披露」，显示成空白会误导。 */
  const dm = {};                 /* 已披露：日期 -> 当日收益（含 0） */
  const undis = {};              /* 已过去但没有净值披露 */
  const days = new Date(y, m, 0).getDate();
  for (let dd = 1; dd <= days; dd++) {
    const ds = `${y}-${pad(m)}-${pad(dd)}`;
    if (ds > today()) continue;
    if (!dayDisclosed(ds)) { undis[dd] = true; continue; }
    dm[dd] = dayProfit(ds);
  }
  const first = new Date(y, m - 1, 1).getDay();
  let h = "";
  ["日", "一", "二", "三", "四", "五", "六"].forEach(w => h += `<div class="wd">${w}</div>`);
  for (let i = 0; i < first; i++) h += `<div></div>`;
  const tds = today();
  for (let dd = 1; dd <= days; dd++) {
    const ds = `${y}-${pad(m)}-${pad(dd)}`;
    const has = dm[dd] !== undefined;
    const v = dm[dd];
    const isUnd = !!undis[dd];
    const selc = (UI.selDate === ds) ? " sel" : "";
    const todayc = (ds === tds) ? " today" : "";
    /* v45：隐藏时不给负收益上红色 —— 颜色本身就是「今天亏了」的信息 */
    const negc = (has && !DATA.settings.hideAmount && v < 0) ? " neg" : "";
    const undiscls = isUnd ? " undis" : "";
    h += `<div class="d${has ? " has" : ""}${negc}${undiscls}${selc}${todayc}" ${has ? `onclick="pickDay('${ds}')"` : ""}>
            <span class="dd">${dd}</span>
            ${has ? `<span class="val">${shown(signMoney(v))}</span>` : (isUnd ? `<span class="und">未披露</span>` : "")}
          </div>`;
  }
  $("calGrid").innerHTML = h;
  $("calTip").innerHTML =
    `<div class="legend">
       <span><i style="background:var(--up)"></i>正收益</span>
       <span><i style="background:var(--down)"></i>负收益</span>
       <span><i style="background:#d9dbe6"></i>未披露</span>
     </div>
     收益归「净值披露日」归属，未披露日不做均摊；点选有数值的方格可看当日明细。`;
}
function calMove(d) {
  let m = UI.calM + d, y = UI.calY;
  if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
  UI.calY = y; UI.calM = m; renderCal();
}
function pickDay(ds) { UI.selDate = (UI.selDate === ds ? "" : ds); renderCal(); renderDetail(); }

/* ---------- 明细（三态：持仓中 / 在途 / 已清仓）---------- */
/* 排序维度（默认「当日盈亏」，与改造前行为一致，避免默认视图突变） */
const DET_SORTS = [
  ["dayP", "当日盈亏"], ["mkt", "市值"], ["profit", "持仓收益"], ["annual", "年化"],
  ["a7", "近7日"], ["a30", "近1月"], ["wan", "万收"], ["upd", "更新"], ["days", "天数"],
];
/* 机构简称：把「XX理财有限责任公司」压成「XX理财」，筛选 chip 才放得下 */
function instShort(inst) {
  const s = String(inst || "").trim().replace(/(有限责任公司|股份有限公司|有限公司|公司)$/, "");
  return s || "未填机构";
}
/* 产品级净值指标（只在按 近7日/近14日/近1月/万收 排序时才需要，避免每次渲染都算） */
function prodMetrics(p) {
  const st = navStats(p);
  return { a7: lastNum(st.a7), a14: lastNum(st.a14), a30: lastNum(st.a30), wan: lastNum(st.wan), count: st.vals.length };
}
/* 取某行的排序值；无该指标时返回 null（null 永远排最后，不参与方向翻转） */
function detSortVal(x, key, m) {
  switch (key) {
    case "mkt": return x.pos.market;
    case "profit": return x.pos.profit;
    case "annual": return x.pos.annualValid ? x.pos.holdAnnual : null;
    case "a7": return m ? m.a7 : null;
    case "a30": return m ? m.a30 : null;
    case "wan": return m ? m.wan : null;
    case "upd": return x.pos.lastDate || null;
    case "days": return x.pos.holdDays;
    default: return x.dayP;
  }
}
function setDetSort(key) {
  if (UI.detSort === key) UI.detAsc = !UI.detAsc;      /* 再点一次翻转方向 */
  else { UI.detSort = key; UI.detAsc = false; }        /* 默认降序：大的在前 */
  renderDetail();
}
function setDetInst(v) { UI.detInst = v; renderDetail(); }
function onDetSearch() {
  const el = $("detSearch");
  UI.detQ = el ? el.value : "";
  renderDetailBody();                                   /* 只重画列表，输入框不被重建 → 不丢焦点 */
}
function clearDetSearch() {
  if ($("detSearch")) $("detSearch").value = "";
  UI.detQ = ""; renderDetail();
}

function setDetTab(btn, tab) {
  btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  UI.detTab = tab; renderDetail();
}
/* 在途卡片：确认前不显示市值与收益，只显示在途金额与预估份额 */
function pendingHtml(list) {
  return list.map(({ p, pos }) => `<div class="grp">
    <div class="grp-h">
      <div class="av">${esc(String(p.inst || p.name || "?").slice(0, 1))}</div>
      <div class="nm">${esc(prodLabel(p))}<span class="state-chip">交易在途</span></div>
      <div class="amt muted">待确认</div>
    </div>
    <div class="prow transit">
      <div class="pn">${esc(p.inst || "")}</div>
      <div class="pv muted">-</div>
      <div class="pk">
        <i>在途金额 <b>${shown(money(pos.pendingAmount))}</b></i>
        <i>预估份额 <b>${shown(pos.pendingShares.toFixed(2))}</b></i>
        <i>市值 <b class="muted">-</b></i>
        <i>持仓收益 <b class="muted">-</b></i>
        <i>确认后自动计入持仓</i>
      </div>
    </div>
  </div>`).join("");
}
/* 已清仓卡片：份额归零但保留历史已实现收益，避免产品凭空消失 */
function closedHtml(list) {
  return list.map(({ p, pos }) => {
    const n = DATA.trades.filter(t => t.prodId === p.id && t.type === "sell").length;
    return `<div class="grp">
    <div class="grp-h">
      <div class="av">${esc(String(p.inst || p.name || "?").slice(0, 1))}</div>
      <div class="nm">${esc(prodLabel(p))}<span class="state-chip closed">已清仓</span></div>
      <div class="amt ${tone(pos.realized)}">${shown(signMoney(pos.realized))}</div>
    </div>
    <div class="prow">
      <div class="pn">已实现收益</div>
      <div class="pv ${tone(pos.realized)}">${shown(signMoney(pos.realized))}</div>
      <div class="pk">
        <i>已核算赎回 <b>${n} 笔</b></i>
        <i>持仓份额 <b>0.00</b></i>
        <i>最新净值 <b>${pos.lastNav.toFixed(4)}</b></i>
      </div>
    </div>
  </div>`;
  }).join("");
}

/* 当前 tab 的行集合 */
function detTabList(pf) {
  return UI.detTab === "pending" ? pf.pendingRows
    : UI.detTab === "closed" ? pf.closedRows : pf.rows;
}
/* 机构筛选 + 关键字搜索（三者都要过） */
function detFilter(list) {
  let out = list;
  if (UI.detInst) out = out.filter(r => (r.p.inst || "") === UI.detInst);
  const q = String(UI.detQ || "").trim().toLowerCase();
  if (q) {
    out = out.filter(r => [r.p.name, r.p.code, r.p.prodCode, r.p.inst, prodLabel(r.p)]
      .some(v => String(v == null ? "" : v).toLowerCase().indexOf(q) >= 0));
  }
  return out;
}
/* 排序（仅持仓中 tab 有意义；在途/已清仓不显示排序 chip） */
function detSort(list) {
  const key = UI.detSort, asc = !!UI.detAsc;
  const needM = ["a7", "a30", "wan"].indexOf(key) >= 0;
  const M = {};
  if (needM) for (const x of list) M[x.r.p.id] = prodMetrics(x.r.p);
  return [...list].sort((a, b) => {
    const va = detSortVal(a, key, M[a.r.p.id]);
    const vb = detSortVal(b, key, M[b.r.p.id]);
    const na = va === null || va === undefined || va === "", nb = vb === null || vb === undefined || vb === "";
    if (na && nb) return 0;
    if (na) return 1;                     /* 无数据的排最后，不随方向翻转 */
    if (nb) return -1;
    const d = typeof va === "string" ? String(va).localeCompare(String(vb)) : (va - vb);
    return asc ? d : -d;
  });
}

function renderDetail() {
  const date = UI.selDate || latestDateAll() || today();
  $("detTitle").innerHTML = `收益明细 <span class="date">· ${date}</span>`;
  const pf = portfolio();
  /* 三态 tab（带计数；在途非零时用金色提示，避免漏看未确认的交易） */
  const tabs = [["active", "持仓中", pf.rows.length, false],
                ["pending", "在途", pf.pendingRows.length, true],
                ["closed", "已清仓", pf.closedRows.length, false]];
  if ($("detTabs")) {
    $("detTabs").innerHTML = tabs.map(([k, lab, n, warn]) =>
      `<button class="${UI.detTab === k ? "on" : ""}" onclick="setDetTab(this,'${k}')">${lab}<span class="n${(warn && n) ? " warn" : ""}"> ${n}</span></button>`
    ).join("");
  }
  const tabList = detTabList(pf);

  /* 机构筛选 chips（按该 tab 的实际机构生成，只有一家时不必占位） */
  if ($("detInstChips")) {
    const cnt = {};
    for (const r of tabList) { const k = r.p.inst || ""; cnt[k] = (cnt[k] || 0) + 1; }
    const keys = Object.keys(cnt);
    const multi = keys.length > 1;
    $("detInstChips").innerHTML = !multi ? "" : `<button class="chip${UI.detInst === "" ? " on" : ""}" onclick="setDetInst('')">全部 ${tabList.length}</button>`
      + keys.map(k => `<button class="chip${UI.detInst === k ? " on" : ""}" onclick="setDetInst(${JSON.stringify(k).replace(/"/g, "&quot;")})">${esc(instShort(k))} ${cnt[k]}</button>`).join("");
    /* 选中的机构已不在当前 tab 里（切 tab 后）→ 自动回到全部，避免空白页 */
    if (UI.detInst && keys.indexOf(UI.detInst) < 0) UI.detInst = "";
  }
  /* 排序 chips（仅持仓中；在途/已清仓排序无意义） */
  if ($("detSortChips")) {
    $("detSortChips").innerHTML = UI.detTab !== "active" ? "" :
      DET_SORTS.map(([k, lab]) =>
        `<button class="chip${UI.detSort === k ? " on" : ""}" onclick="setDetSort('${k}')">${lab}${UI.detSort === k ? (UI.detAsc ? " ↑" : " ↓") : ""}</button>`
      ).join("");
  }
  renderDetailBody();
}

function renderDetailBody() {
  const pf = portfolio();
  const date = UI.selDate || latestDateAll() || today();
  const tabList = detTabList(pf);
  const total = tabList.length;
  let list = detFilter(tabList);
  const filtered = UI.detInst || String(UI.detQ || "").trim();
  if (filtered) {
    $("detTitle").innerHTML = `收益明细 <span class="date">· ${date}</span> <span class="muted" style="font-size:11px">筛出 ${list.length}/${total}</span>`;
  }
  if (!list.length) {
    const tip = filtered ? "没有匹配的产品，点「清除」重置筛选"
      : UI.detTab === "pending" ? "没有在途交易。申购/赎回确认后会转入「持仓中」。"
        : UI.detTab === "closed" ? "还没有已清仓的产品。"
          : "还没有持仓，点「进入」交易中心添加第一笔买入";
    $("detBody").innerHTML = `<div class="empty">${tip}</div>`; return;
  }
  if (UI.detTab === "pending") { $("detBody").innerHTML = pendingHtml(list); return; }
  if (UI.detTab === "closed") { $("detBody").innerHTML = closedHtml(list); return; }

  /* 当日盈亏：仅当该日有净值更新时计入（见 dayProfit 的说明）。
     份额必须用「截至该日已确认」的 sharesOn(p, date) —— r.pos.shares 是今天的
     份额，选历史日期时会放大、清仓产品会错误显示 0（与 dayProfit 同口径）。 */
  const rows = list.map(r => {
    const s0 = navSeries(r.p);
    const idx = s0.findIndex(x => x[0] === date);
    const sh = idx > 0 ? sharesOn(r.p, date) : 0;
    return {
      r, pos: r.pos, shares: sh,
      dayP: idx > 0 ? sh * (Number(s0[idx][1]) - Number(s0[idx - 1][1])) : 0,
      dayNavChange: idx > 0 ? (Number(s0[idx][1]) - Number(s0[idx - 1][1])) : 0,
    };
  });
  const sorted = detSort(rows);

  const groups = {};
  const sortLab = (DET_SORTS.find(x => x[0] === UI.detSort) || DET_SORTS[0])[1];
  for (const x of sorted) {
    const key = UI.groupBy === "inst" ? (x.r.p.inst || "未分组") : `按${sortLab}排序`;
    (groups[key] = groups[key] || []).push(x);
  }
  let html = "";
  for (const k of Object.keys(groups)) {
    const arr = groups[k];
    const sum = arr.reduce((s, x) => s + x.dayP, 0);
    /* v68：分组行那个「万收」原来是 盈亏 ÷ 市值 × 10000 —— 分母是钱（万元市值），
       与详情页的 净值差 × 10000（分母是万份）永远差一个净值系数（诚享7天29号 2026-11-02：
       这里 −11.53、那里 −3.8967，谁都对不上谁）。统一成 盈亏 ÷ 已确认份额 × 10000：
       单只时它就等于 Δ×10000（−11.69），多只时是份额加权，乘回份额就是左边那个金额。 */
    const shSum = arr.reduce((s, x) => s + x.shares, 0);
    const wanG = shSum > 0 ? sum / shSum * 10000 : 0;
    /* v45：这一屏原来是隐藏开关的死角 —— 分组行、每只产品的当日盈亏 / 持仓盈亏 /
       持有金额全部明文。改成一律走 shown() + tone()，颜色口径与首页一致。 */
    html += `<div class="grp">
      <div class="grp-h">
        <div class="av">${esc(k.slice(0, 1))}</div>
        <div class="nm">${esc(k)}<span class="wr"> ${arr.length} 只</span></div>
        <div class="amt ${tone(sum)}" title="万收 = 当日盈亏 ÷ 已确认份额 × 10000（元/万份）· 与产品详情同一口径：整段累计、不按自然日摊平；跨周末或长假就是那几天合计">
          ${shown(signMoney(sum))} <span class="wr">万收(${shown(wanG.toFixed(2))})</span></div>
      </div>`;
    for (const x of arr) {
      const annualTxt = x.pos.annualValid
        ? `<b class="${tone(x.pos.holdAnnual)}">${shown(pct(x.pos.holdAnnual))}</b>`
        : `<b class="muted">持有不足7天</b>`;
      html += `<div class="prow">
        <div class="pn"><button class="link" onclick="openProdDetail('${x.r.p.id}')">${esc(prodLabel(x.r.p))}</button></div>
        <div class="pv ${tone(x.dayP)}">${shown(signMoney(x.dayP))}</div>
        <div class="pk">
          <i>持有金额 <b>${shown(money(x.pos.market))}</b></i>
          <i>当日盈亏 <b class="${tone(x.dayP)}">${shown(signMoney(x.dayP))}</b></i>
          <i>持仓盈亏 <b class="${tone(x.pos.profit)}">${shown(signMoney(x.pos.profit))}</b>（市值−成本）</i>
          <i>持有年化 ${annualTxt}（本金天数加权）</i>
          <i>持有 <b>${x.pos.holdDays}天</b></i>
          <i>净值 <b>${x.pos.lastNav.toFixed(4)}</b>${x.pos.lastDate ? "（" + esc(x.pos.lastDate.slice(5)) + "）" : ""}</i>
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  $("detBody").innerHTML = html;
}

/* ============================================================
   渲染：交易 / 产品 / 设置
   ============================================================ */
function renderTrade() {
  const ts = [...DATA.trades].sort((a, b) => (b.tradeDate || "").localeCompare(a.tradeDate || ""));
  if (!ts.length) { $("tradeList").innerHTML = `<div class="empty">暂无交易记录</div>`; }
  else {
    $("tradeList").innerHTML = ts.map(t => {
      const p = DATA.products.find(x => x.id === t.prodId);
      const isBuy = t.type === "buy";
      return `<div class="sumline" style="align-items:flex-start">
        <div style="flex:1">
          <div style="font-weight:650;font-size:12.5px">${esc(p ? prodLabel(p) : "已删除产品")}
            <span class="wr" style="font-size:10.5px;padding:2px 6px;border-radius:5px;background:${isBuy ? '#e9f7f1' : '#fdeff0'};color:${isBuy ? '#0d7a52' : '#c02a34'};margin-left:4px">${isBuy ? "买入" : "赎回"}</span>
          </div>
          <div style="font-size:11px;color:var(--ink2);margin-top:3px">
            ${t.tradeDate} · 确认 ${t.confirmNavDate || "-"} · 净值 ${Number(t.confirmNav || 0).toFixed(4)} · ${shown((Number(t.shares) || 0).toFixed(2))}份
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:700;font-size:13px">${isBuy ? "-" : "+"}${shown(money(t.amount))}</div>
          ${t.realized ? `<div style="font-size:11px" class="${tone(t.realized)}">实现 ${shown(signMoney(t.realized))}</div>` : ""}
          <button class="mini" style="margin-top:4px;padding:2px 8px;font-size:10.5px" onclick="delTrade('${t.id}')">删除</button>
        </div>
      </div>`;
    }).join("");
  }
  /* 已实现 */
  const sells = DATA.trades.filter(t => t.type === "sell");
  if (!sells.length) $("realList").innerHTML = `<div class="empty">暂无赎回结算</div>`;
  else {
    const tot = sells.reduce((s, t) => s + (Number(t.realized) || 0), 0);
    $("realList").innerHTML = sells.map(t => {
      const p = DATA.products.find(x => x.id === t.prodId);
      return `<div class="sumline"><span class="k">${esc(p ? prodLabel(p) : "-")} <span class="muted" style="font-size:11px">${t.tradeDate}</span></span>
        <b class="${tone(t.realized)}">${shown(signMoney(t.realized))}</b></div>`;
    }).join("") + `<div class="sumline"><span class="k">合计已实现 <span class="muted" style="font-size:10.5px">均价法扣减成本 · 已核算 ${sells.length} 笔赎回</span></span><b class="${tone(tot)}">${shown(signMoney(tot))}</b></div>`;
  }
}

function renderProd() {
  if (!DATA.products.length) $("prodList").innerHTML = `<div class="empty">还没有产品，点「添加产品」按登记编码查询或手动录入</div>`;
  else {
    $("prodList").innerHTML = DATA.products.map(p => {
      const pos = position(p);
      const l = latestNav(p);
      const st = fetchStatus(p);
      const stale = navStaleInfo(p);
      return `<div class="pick" style="cursor:default">
        <div class="p1"><button class="link" onclick="openProdDetail('${p.id}')">${esc(prodLabel(p))}</button> <span class="wr" style="font-size:10.5px;color:var(--ink3)">${esc(p.inst || "")}</span></div>
        <div class="p2">登记编码 ${esc(p.code || "-")} · 产品代码 <b>${esc(p.prodCode || "-")}</b></div>
        <div class="p2" style="color:${st.ok ? "#0d7a52" : "#8a6300"}">${st.txt}</div>
        ${stale ? `<div class="p2" style="color:#8a6300">⏳ 净值停在 ${esc(stale.date)}，此后已过 ${stale.lag} 个交易日未更新</div>` : ""}
        <div class="p3">份额 ${shown(pos.shares.toFixed(2))} · 成本 ${shown(money(pos.cost))} · 市值 ${shown(money(pos.market))} · 浮盈 <b class="${tone(pos.profit)}">${shown(signMoney(pos.profit))}</b> · 净值 ${l ? l[1].toFixed(4) + " (" + l[0] + ")" : "无数据"}</div>
        <div class="row-btn" style="margin-top:8px">
          <button class="mini" onclick="openProdDetail('${p.id}')">详情</button>
          <button class="mini" onclick="editProd('${p.id}')">编辑</button>
          <button class="mini" onclick="openNav('${p.id}')">录入/查看净值</button>
          <button class="mini" onclick="delProd('${p.id}')">删除</button>
        </div>
      </div>`;
    }).join("");
  }
  $("navList").innerHTML = DATA.products.map(p => {
    const s = navSeries(p);
    const recent = s.slice(-5).reverse();
    return `<div style="margin-bottom:12px">
      <div style="font-size:12.5px;font-weight:650;margin-bottom:5px">${esc(prodLabel(p))} <span class="muted" style="font-size:11px">共 ${s.length} 条</span></div>
      ${recent.length ? recent.map(([d, v]) => `<span style="display:inline-block;font-size:11px;background:var(--bg);border-radius:6px;padding:3px 8px;margin:0 5px 5px 0">${d.slice(5)} <b>${Number(v).toFixed(4)}</b></span>`).join("") : `<span class="muted" style="font-size:11px">暂无净值</span>`}
    </div>`;
  }).join("") || `<div class="empty">暂无产品</div>`;
  /* 产品收益表（pg-prod）与产品列表共用同一批数据。任何改动产品的入口
     （添加 / 编辑 / 删除 / 补录净值 / 抓取）都会调 renderProd()，
     顺带刷一次表 —— 否则在详情弹层里抓完净值、关掉后表还是旧数字。 */
  renderBoard();
}

/* ---------- 产品页：收益对比表（v45 新增） ---------- */
/* 一行一个产品。指标全部来自公用的 navStats()/position()，
   算法（筛选 / 排序 / 月挂 0）在 js/domain/board.js 里，可单测。 */
function boardRows() {
  const ym = today().slice(0, 7);
  return DATA.products.map(p => {
    const st = navStats(p);
    return {
      id: String(p.id),
      name: prodLabel(p),
      inst: p.inst || "",
      ikey: instKey(p.inst),
      code: p.code || "",
      prodCode: p.prodCode || "",
      lastDate: st.dates.length ? st.dates[st.dates.length - 1] : "",
      /* null = 没有可比的前值 / 样本不足，渲染成「—」，排序永远垫底 */
      wan: lastNum(st.wan),
      a7: lastNum(st.a7),
      a14: lastNum(st.a14),
      a30: lastNum(st.a30),
      zero: monthZeroDays(st.dates, st.wan, ym),
    };
  });
}
/** 万收：详情页给 4 位（单个产品看精度，那里没有宽度压力，0.4512 与 0.4548 得分得开） */
const wan4 = (v) => (v === null ? "—" : v.toFixed(4));
/* 表里给 2 位（v54，用户要求）：这一列是用来横向比哪只高的，第四位小数是噪声，
   而它要 4 个字宽 —— 2 位省下 12px，整张表的宽度预算跟着松一档。
   排序仍按原始数值走，不受显示位数影响（boardSort 读的是 r.wan，不是这个字符串）。 */
const wan2 = (v) => (v === null ? "—" : v.toFixed(2));
/* 年化：数值口径与详情页一致（同一套 navStats），null 显示「—」；
   但表里的写法故意与详情页不同 —— 不带正号、|≥10%| 只给一位小数：
   三列年化各要 7 个字宽，「+」一个符号就吃掉 7px × 3 = 21px，而这一列本来就用颜色
   标了涨跌（红涨绿跌），负数仍会带「-」。省下来的 21px 全部还给产品名，
   这是「全部」六列能塞进 360 屏的关键。
   退一位小数是同一条理由：列宽 50px 是按最坏串「-123.4%」量的，不退的话同样三位整数
   要多写一位小数（「-123.4%」→「-123.45%」≈ 56px），nowrap 就把「%」挤到隔壁那一列的数字上。
   两位小数的精度在这里本来就是噪声。 */
const pctBd = (v) => {
  if (v === null) return "—";
  const p = v * 100;
  return (Math.abs(p) >= 10 ? p.toFixed(1) : p.toFixed(2)) + "%";
};

/* ---------- 产品收益表的列宽与渲染（v48） ----------
   列宽从 nth-child 改成挂在类名上：精简模式少了两列，按位置定的宽度会整排错位
   （v47 只能把表写死成 600px 就是这个原因）。表头和表体共用下面这两张表，
   少列时两边不可能对不上。每个 key 都必须有类名和渲染函数，
   漏了会被 tests/app_core.test.mjs 的门禁直接跑红。 */
const BD_CLS = {
  name: "c-nm", wan: "c-wan",
  a7: "c-a", a14: "c-a", a30: "c-a", zero: "c-zero",
};
const BD_CELL = {
  /* 名字两行截断，所以补一个 title：手机上没有 hover，长按能看到全名 */
  name: (r) => `<td class="nm c-nm"><button class="link" title="${esc(r.name)}" onclick="openProdDetail('${r.id}')">${esc(r.name)}</button></td>`,
  wan: (r) => `<td class="c-wan ${cls(r.wan === null ? 0 : r.wan)}">${wan2(r.wan)}</td>`,
  a7: (r) => `<td class="c-a ${cls(r.a7 === null ? 0 : r.a7)}">${pctBd(r.a7)}</td>`,
  a14: (r) => `<td class="c-a ${cls(r.a14 === null ? 0 : r.a14)}">${pctBd(r.a14)}</td>`,
  a30: (r) => `<td class="c-a ${cls(r.a30 === null ? 0 : r.a30)}">${pctBd(r.a30)}</td>`,
  zero: (r) => `<td class="c-zero ${r.zero ? "warn-n" : "muted"}">${r.zero}</td>`,
};

/** 这台设备的列模式。没手动选过时按视口宽给默认：v54 起「全部」六列只要 252px，
    连 320 屏（表格实得 278px）都放得下，所以默认直接「全部」；再窄才退回精简。 */
function bdMode() {
  if (UI.bdCols === "full" || UI.bdCols === "lean") return UI.bdCols;
  const w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 360;
  return w >= 350 ? "full" : "lean";
}
function toggleBdCols() {
  UI.bdCols = bdMode() === "full" ? "lean" : "full";
  try { localStorage.setItem(LS_BD, UI.bdCols); } catch (e) { }
  renderBoard();
}
/** 右侧渐影 = 「这边还有列没露出来」。只在真的还能滑时显示，切到精简后自己消失。
    v49 补一条：滑到最右也要收掉 —— 之前只在渲染时判定一次，人已经滑到底了
    那道「还能往右」的影子还挂着，提示反过来说了假话。 */
function bdEdge() {
  const edge = $("boardEdge"), wrap = $("boardWrap");
  if (!edge || !wrap) return;
  const more = wrap.scrollWidth - wrap.clientWidth > 2;
  const atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
  edge.classList.toggle("more", more && !atEnd);
}

function renderBoard() {
  const tbl = $("boardTbl");
  if (!tbl) return;
  const full = bdMode() === "full";
  const cols = boardCols(full ? "full" : "lean");
  tbl.className = full ? "boardtbl" : "boardtbl lean";
  if ($("bdColsBtn")) $("bdColsBtn").textContent = full ? "精简" : "全部";
  const all = boardRows();
  const total = all.length;
  const list = boardSort(boardFilter(all, UI.bdInst, UI.bdQ), UI.bdSort, UI.bdAsc);

  /* 机构 chips：只有一个机构时不占地方（与明细页同一取舍） */
  if ($("bdInstChips")) {
    const chips = boardInstChips(all);
    $("bdInstChips").innerHTML = chips.length < 2 ? ""
      : `<button class="chip${UI.bdInst === "" ? " on" : ""}" onclick="setBdInst('')">全部 ${total}</button>`
        + chips.map(c => `<button class="chip${UI.bdInst === c.key ? " on" : ""}" onclick="setBdInst(${JSON.stringify(c.key).replace(/"/g, "&quot;")})">${esc(instShort(instLabel(c.key)))} ${c.n}</button>`).join("");
    /* 选中的机构这一轮没了（例如产品被删）→ 回到「全部」，避免整页空白 */
    if (UI.bdInst && !chips.some(c => c.key === UI.bdInst)) { UI.bdInst = ""; renderBoard(); return; }
  }
  if ($("bdCount")) $("bdCount").textContent = total ? `共 ${total} 只 · 显示 ${list.length}` : "共 0 只";

  /* 表头两行竖排：第一行认列、第二行放补语与排序角标，完整口径（lab + tip）留在 title */
  const sortMark = (k) => (UI.bdSort === k ? `<span class="mk ${UI.bdAsc ? "u" : "d"}"></span>` : "");
  const head = cols.map(([k, lab, tip, l1, l2]) =>
    `<th class="srt ${BD_CLS[k]}" title="${esc(lab)}：${esc(tip)}" onclick="setBdSort('${k}')">`
    + `<span class="l1">${esc(l1)}</span><span class="l2">${esc(l2)}${sortMark(k)}</span></th>`).join("");

  if (!total) {
    tbl.innerHTML = "";
    if ($("bdNote")) $("bdNote").innerHTML = `<div class="empty">还没有产品。到「交易」页点「+ 添加产品」按登记编码查询。</div>`;
    bdEdge();
    return;
  }
  if (!list.length) {
    tbl.innerHTML = "";
    if ($("bdNote")) $("bdNote").innerHTML = `<div class="empty">没有匹配的产品，点「清除」重置筛选</div>`;
    bdEdge();
    return;
  }
  /* 金额类一列都没有，所以这张表不需要走 shown() 遮蔽：
     万收与年化是产品公开披露口径，挂零天数不含金额信息。 */
  tbl.innerHTML = `<thead><tr>${head}</tr></thead><tbody>`
    + list.map(r => `<tr>` + cols.map(c => BD_CELL[c[0]](r)).join("") + `</tr>`).join("")
    + `</tbody>`;
  if ($("bdNote")) {
    const ld = list.reduce((m, r) => (r.lastDate > m ? r.lastDate : m), "");
    $("bdNote").innerHTML = `<span class="muted">数据截至 ${esc(ld || "—")}</span>`;
  }
  bdEdge();
}
function setBdInst(k) { UI.bdInst = (UI.bdInst === k && k !== "") ? "" : k; renderBoard(); }
function setBdSort(k) {
  if (UI.bdSort === k) UI.bdAsc = !UI.bdAsc;
  else { UI.bdSort = k; UI.bdAsc = k === "name" || k === "zero"; }
  renderBoard();
}
function onBdSearch() { UI.bdQ = $("bdSearch") ? $("bdSearch").value : ""; renderBoard(); }
function clearBdSearch() {
  UI.bdQ = ""; UI.bdInst = "";
  if ($("bdSearch")) $("bdSearch").value = "";
  renderBoard();
}

/* ---------- 设置页同步状态 ---------- */
/* 顶栏胶囊：文案口径在 js/domain/syncstatus.js（纯函数、有测试），这里只负责写字。
   每次推送成功 / 失败 / 重试排期变化都要调一次，别再学 v45 那样在成功那一刻
   硬写「已同步」三个字 —— 那句话曾经既不反映 DIRTY 也不反映时间。 */
function syncStateView() {
  const b = syncBadge(Object.assign({ cfgOk: !!(SYNC.owner && SYNC.repo && SYNC.token) }, SYNC_ST));
  const e = $("syncState");
  if (e) { e.textContent = b.text; e.className = "sync-state" + (b.cls ? " " + b.cls : ""); }
  return b;
}
function renderSet() {
  const ok = !!(SYNC.owner && SYNC.repo && SYNC.token);
  const st = Object.assign({ cfgOk: ok }, SYNC_ST);
  const b = syncBadge(st);
  const cls = b.cls === "ok" ? "note g" : b.cls === "bad" ? "note r" : b.cls === "warn" ? "note" : "note b";
  $("setSyncBox").innerHTML = ok
    ? `<div class="${cls}">${esc(syncLine(st))}<br>仓库：<b>${esc(SYNC.owner)}/${esc(SYNC.repo)}</b> · 数据文件：${esc(SYNC.path)}${SYNC.sha ? " · 远端版本 " + esc(SYNC.sha.slice(0, 7)) : ""}</div>
       <div class="row-btn" style="margin-top:10px">
         <button class="btn gh" style="flex:1" onclick="syncPull(true)">↓ 从云端拉取</button>
         <button class="btn pri" style="flex:1" onclick="syncPush(true)">↑ 推送到云端</button>
       </div>`
    : `<div class="note b">尚未连接云端：填好 Token 就能多设备共享同一份台账。仓库与数据文件已预填，改它们请在弹层「高级」里。</div>`;
  syncStateView();
  syncAppOnly();
  renderAixhub();
  renderLedgerme();
  renderLlm();
  renderNotify();
}

/* ============================================================
   弹层基础
   ------------------------------------------------------------
   v56：弹层（二级页面）要能被手机返回手势 / 返回键关掉。
   做法是「打开时往历史里压一条哨兵条目」：
     · 手势返回 → 壳走 goBack()（MainActivity.onBackPressed 一直是
       「canGoBack 就 goBack，否则退出 App」）→ 触发这里的 popstate → 把弹层收掉；
     · 点 ✕ / 点遮罩 → closeSheet() 自己把那条哨兵退掉（sheetPopPending 记着这次退栈）。
   为什么只压一条、不做成栈：本 App 的弹层是互相替换的（在弹层里再开弹层
   其实是把 innerHTML 换掉），本来就没有两层可退；压两条会让一次手势只关掉一半。
   为什么要 sheetWantPush 这一层：history.back() 是异步的。同一拍里
   「先关再开」（保存完重开表单、翻月份）如果立刻 pushState，那条迟到的 back
   会落在新哨兵身上，把刚打开的弹层又自己关掉 —— 手机上表现成「点开就闪回首页」。
   所以补压必须等 back 落地（popstate）之后做，而且只在弹层确实还开着时做。
   pushState 在少数环境（隐私模式、file:// 直开）会抛，抛了就退回旧行为：
   标记不置位，closeSheet 也绝不 history.back() —— 否则等于把整个页面退走。
   ============================================================ */
let sheetSentinel = 0;      /* 当前压在历史里的那条哨兵序号；0 = 没压 */
let sheetSeq = 0;
let sheetPopPending = false; /* closeSheet 喊了 back，还没落地 */
let sheetWantPush = false;   /* 退栈落地后要补压一条（这一拍里又开了弹层） */
function sheetPush() {
  const seq = ++sheetSeq;
  try { history.pushState({ licaiSheet: seq }, ""); sheetSentinel = seq; }
  catch (e) { sheetSentinel = 0; }        /* 压不上就彻底走旧行为，别留半套 */
}
function openSheet(html) {
  $("sheet").innerHTML = html; $("mask").classList.add("show");
  if (sheetSentinel) return;              /* 已经有一条了：弹层是替换式的，不叠加 */
  if (sheetPopPending) { sheetWantPush = true; return; }
  sheetPush();
}
function closeSheet() {
  $("mask").classList.remove("show");
  if (!sheetSentinel) return;
  sheetSentinel = 0; sheetPopPending = true;
  history.back();
}
window.addEventListener("popstate", () => {
  sheetPopPending = false;
  if (sheetSentinel) {                    /* 用户真按了返回：收下这一层弹层 */
    sheetSentinel = 0;
    $("mask").classList.remove("show");
  }
  /* 上面那次 back 是我们自己要的，且这一拍里又开了新弹层 → 现在才补压哨兵 */
  if (sheetWantPush) {
    sheetWantPush = false;
    if ($("mask").classList.contains("show")) sheetPush();
  }
});
function go(pid) {
  document.querySelectorAll(".page").forEach(e => e.classList.remove("on"));
  $(pid).classList.add("on");
  document.querySelectorAll(".tabbar .tb").forEach(b => b.classList.toggle("on", b.dataset.p === pid));
  window.scrollTo(0, 0);
  /* v45：原「产品」页的两张卡片整体搬到「交易」页，所以进交易页要把产品列表
     一起渲染（renderProd 内部会顺带刷产品收益表）；「产品」页只剩收益对比表。 */
  if (pid === "pg-trade") { renderTrade(); renderProd(); }
  if (pid === "pg-prod") renderBoard();
  if (pid === "pg-set") renderSet();
}
function setRange(btn) {
  document.querySelectorAll("#pg-home .tabs button").forEach(b => b.classList.remove("on"));
  btn.classList.add("on"); UI.range = btn.dataset.range; renderHome();
}
function setGroup(btn, mode) {
  btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("on"));
  btn.classList.add("on"); UI.groupBy = mode; renderDetail();
}
function toggleHide() {
  DATA.settings.hideAmount = !DATA.settings.hideAmount;
  $("btnHide").textContent = DATA.settings.hideAmount ? "显示" : "隐藏";
  saveLocal(); renderHome();
}

/* ============================================================
   交易录入
   ============================================================ */
function openTrade(pickId) {
  UI.activePick = pickId || "";
  let html = `<div class="sheet-t"><h3>新增交易</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">选择产品或手动录入 → 填写交易 → 保存后收益中心自动按净值历史计算。</div>
    <div class="field"><label>选择产品</label>
      <div class="actin">
        <input id="tSearch" placeholder="搜索产品名称或代码" oninput="renderPick()">
      </div>
      <div id="pickBox" style="margin-top:8px;max-height:220px;overflow:auto"></div>
      <button class="btn gh full" style="margin-top:8px" onclick="openProd()">+ 查不到？手动新增产品</button>
    </div>
    <div id="tFormBox"></div>`;
  openSheet(html);
  renderPick();
}
function renderPick() {
  const kw = ($("tSearch") ? $("tSearch").value : "").trim().toLowerCase();
  const list = DATA.products.filter(p => !kw || (p.name + p.code + (p.prodCode || "")).toLowerCase().includes(kw));
  const box = $("pickBox");
  if (!list.length) { box.innerHTML = `<div class="empty" style="padding:14px">没有匹配的产品</div>`; $("tFormBox").innerHTML = ""; return; }
  box.innerHTML = list.map(p => {
    const l = latestNav(p);
    return `<div class="pick ${UI.activePick === p.id ? "on" : ""}" onclick="pickProduct('${p.id}')">
      <div class="p1">${esc(prodLabel(p))}</div>
      <div class="p2">${esc(p.inst || "")}${p.prodCode ? " · 产品代码 " + esc(p.prodCode) : ""}</div>
      <div class="p3">登记编码 ${esc(p.code || "-")} · 最新净值 ${l ? l[1].toFixed(4) + "（" + l[0] + "）" : "无"}</div>
    </div>`;
  }).join("");
  if (!UI.activePick && list.length) UI.activePick = list[0].id;
  renderTradeForm();
}
function pickProduct(id) { UI.activePick = id; renderPick(); }
function renderTradeForm() {
  const p = DATA.products.find(x => x.id === UI.activePick);
  if (!p) { $("tFormBox").innerHTML = ""; return; }
  const t = today();
  /* 确认日不再默认「今天」：按交易日历（周末 / 法定假日 / 调休）推算 T+1。
     15:00 截止之后提交、或交易日本身休市，受理日会顺延 —— 这些都由纯函数
     js/domain/calendar.js 计算，界面上把推算结果写出来，允许用户手动改。 */
  const sug = suggestTradeDates(t, new Date(), detectOrg(p));
  const hitNav = navHit(p, sug.navDate);
  const defNavDate = hitNav ? hitNav[0] : sug.navDate;
  const defNav = hitNav ? Number(hitNav[1]).toFixed(4) : "";
  $("tFormBox").innerHTML = `
    <div class="note b">当前操作产品：<b>${esc(prodLabel(p))}</b><br>${esc(p.inst || "")}${p.prodCode ? " · 产品代码 " + esc(p.prodCode) : ""}</div>
    <div class="field" style="margin-top:12px"><label>交易类型</label>
      <select id="tType" onchange="renderTradeForm2()">
        <option value="buy">买入</option><option value="sell">赎回</option>
      </select>
    </div>
    <div class="field"><label>交易日期</label>
      <div class="actin"><input type="date" id="tDate" value="${t}" onchange="onTradeDateChange()"><button class="mini" onclick="document.getElementById('tDate').value=''">清空</button></div>
    </div>
    <div class="field"><label>交易确认日期</label><div class="actin"><input type="date" id="tConfirm" value="${sug.confirmDate}"></div><div id="tCalTip" class="tip"></div></div>
    <div id="tTypeBox"></div>
    <div class="field"><label>确认净值日期</label><input type="date" id="tNavDate" value="${defNavDate}" onchange="autoFillNav()"></div>
    <div class="field"><label>确认净值</label><input type="number" step="0.0001" id="tNav" value="${defNav}" placeholder="留空则自动取该日净值" oninput="calcShares()"></div>
    <div id="tShareBox"></div>
    <div class="row-btn" style="margin-top:14px">
      <button class="btn gh" style="flex:1" onclick="closeSheet()">取消</button>
      <button class="btn pri" style="flex:1" onclick="saveTrade()">保存交易</button>
    </div>`;
  renderCalTip(sug);
  renderTradeForm2();
}
/* 交易日期改动 → 重算确认日与确认净值日期（都可再手动改） */
function onTradeDateChange() {
  const p = DATA.products.find(x => x.id === UI.activePick);
  const d = $("tDate") ? $("tDate").value : "";
  if (!p || !d) return;
  const sug = suggestTradeDates(d, new Date(), detectOrg(p));
  if ($("tConfirm")) $("tConfirm").value = sug.confirmDate;
  /* 净值取「受理日当天，没有就向前取最近」：补录历史交易时不会错拿最新的净值 */
  const hit = navHit(p, sug.navDate);
  if ($("tNavDate")) $("tNavDate").value = hit ? hit[0] : sug.navDate;
  if ($("tNav")) $("tNav").value = hit ? Number(hit[1]).toFixed(4) : "";
  renderCalTip(sug);
  calcShares();
}
/* 推算说明：把「为什么是这个确认日」讲清楚，避免用户误以为系统乱改 */
function renderCalTip(sug) {
  const el = $("tCalTip");
  if (!el || !sug) return;
  const why = [];
  if (sug.deferred) why.push("已过当日截止时间，按下一交易日受理");
  else if (sug.rolled) why.push("原日期休市，已顺延");
  if (sug.unknownYears.length) why.push(`${sug.unknownYears.join("/")} 年节假日未配置，按周一至周五估算`);
  el.textContent = `按交易日历推算：${sug.applyDate} 受理 → 确认日 ${sug.confirmDate}`
    + (why.length ? `（${why.join("；")}）` : "") + "，可手动修改。";
}
function renderTradeForm2() {
  const type = $("tType").value;
  const p = DATA.products.find(x => x.id === UI.activePick);
  const pos = p ? position(p) : { shares: 0 };
  if (type === "buy") {
    $("tTypeBox").innerHTML = `<div class="field"><label>买入金额（元）</label><input type="number" step="0.01" id="tAmount" placeholder="请输入交易金额" oninput="calcShares()"></div>`;
    $("tShareBox").innerHTML = `<div class="field"><label>份额（自动计算）</label><input id="tShare" value="自动计算" readonly style="background:#fafbfe;color:var(--ink2)"></div>`;
  } else {
    $("tTypeBox").innerHTML = `<div class="field"><label>赎回份额</label><input type="number" step="0.01" id="tShares" placeholder="当前可赎回 ${pos.shares.toFixed(2)} 份" oninput="calcShares()"><div class="tip">可赎回 ${pos.shares.toFixed(2)} 份</div></div>`;
    $("tShareBox").innerHTML = `<div class="field"><label>预计到账（元）</label><input id="tAmountShow" value="自动计算" readonly style="background:#fafbfe;color:var(--ink2)"></div>`;
  }
  calcShares();
}
function autoFillNav() {
  const p = DATA.products.find(x => x.id === UI.activePick); if (!p) return;
  const d = $("tNavDate").value;
  const hit = navHit(p, d);
  if (hit) $("tNav").value = Number(hit[1]).toFixed(4);
}
function calcShares() {
  const p = DATA.products.find(x => x.id === UI.activePick); if (!p) return;
  const type = $("tType").value;
  const nav = Number($("tNav").value) || 0;
  if (type === "buy") {
    const amt = Number($("tAmount").value) || 0;
    $("tShare").value = (nav > 0 && amt > 0) ? (amt / nav).toFixed(4) + " 份" : "自动计算";
  } else {
    const sh = Number($("tShares").value) || 0;
    $("tAmountShow").value = nav > 0 ? money(sh * nav) + " 元" : "自动计算";
  }
}
function saveTrade() {
  /* 防快速双击：第一次保存已 closeSheet，第二次点击进不来 */
  if (!$("mask").classList.contains("show")) return;
  const p = DATA.products.find(x => x.id === UI.activePick);
  if (!p) return toast("请先选择产品");
  const type = $("tType").value;
  const tradeDate = $("tDate").value || today();
  const confirmDate = $("tConfirm").value || tradeDate;
  const navDate = $("tNavDate").value || tradeDate;
  let nav = Number($("tNav").value) || 0;
  if (nav <= 0) return toast("请填写有效的确认净值");
  /* 净值历史只存「官方披露」的值：
     ① 该日期已有净值 → 以已披露值为准（防止交易录入覆盖真实净值）；
     ② 该日期还没有净值 → 不写入。交易自己的确认净值已存在 confirmNav 里，
        份额/成本计算只读它，不需要污染净值曲线。
     曾经的写法是「没有就补进去」，后果很隐蔽：买入当天会在披露日之前凭空多出
     一条「当日净值」，万份收益/近 7 日年化据此算出假信号，而且官网后来补出
     真值也会被「已有净值不覆盖」挡住，永远改不回来。 */
  if (!p.navHistory) p.navHistory = {};
  const existing = p.navHistory[navDate];
  let warned = false, navDisclosed = false;
  if (existing !== undefined && existing !== null && existing !== "") {
    navDisclosed = true;
    if (Math.abs(Number(existing) - nav) > 1e-9) { nav = Number(existing); warned = true; }
  }
  let t = { id: uid(), prodId: p.id, type, tradeDate, confirmDate, confirmNavDate: navDate, confirmNav: nav, createdAt: Date.now() };
  if (type === "buy") {
    const amt = Number($("tAmount").value) || 0;
    if (amt <= 0) return toast("请输入买入金额");
    t.amount = amt; t.shares = Number((amt / nav).toFixed(4));
  } else {
    const sh = Number($("tShares").value) || 0;
    const pos = position(p);
    if (sh <= 0) return toast("请输入赎回份额");
    if (sh > pos.shares + 1e-6) return toast("赎回份额超过持仓 " + pos.shares.toFixed(2));
    t.shares = sh; t.amount = Number((sh * nav).toFixed(2));
    const avg = pos.shares > 0 ? pos.cost / pos.shares : 0;
    t.realized = Number((sh * nav - avg * sh).toFixed(2));
  }
  DATA.trades.push(t);
  saveLocal(); closeSheet();
  toast(warned ? `已保存。${navDate} 按已披露净值 ${nav.toFixed(4)} 计算`
    : navDisclosed ? "交易已保存"
      : `交易已保存。${navDate} 官网还没披露净值，按你填的 ${nav.toFixed(4)} 记入交易（不进净值曲线）`,
  navDisclosed ? (warned ? 3200 : 2000) : 4200);
  renderHome(); renderTrade(); renderProd(); autoPush();
}

/* ============================================================
   产品新增 / 净值录入
   ============================================================ */
/* 产品表单：新增与编辑共用（pid 为空 = 新增） */
function prodForm(pid) {
  const p = pid ? DATA.products.find(x => x.id === pid) : null;
  UI.editProdId = pid || "";
  UI.queriedNav = null;
  const meta = p && (p.manager || p.riskLevel)
    ? `<div class="note" style="margin-bottom:12px">云端回填：${p.manager ? "管理人 " + esc(p.manager) : ""}${p.riskLevel ? " · 风险等级 " + esc(p.riskLevel) : ""}</div>` : "";
  openSheet(`<div class="sheet-t"><h3>${p ? "编辑产品" : "添加产品"}</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      净值由云端自动抓取，需要两个代码配合：<br>
      ① <b>产品登记编码</b>（Z / C 开头）— 中国理财网信披平台查询用；<br>
      ② <b>产品代码</b> — 云端抓净值的依据（北银如 <code>YJ01251204A</code>，华夏如 <code>208212400701</code>，信银如 <code>AF251387C</code>，南银如 <code>NYYW000016</code>，民生如 <code>FBAG65601C</code>，徽银如 <code>PNHY260395A</code>）。信银要填<b>完整的份额代码</b>（含末位份额字母），去掉末位字母查不到；徽银同理，漏了字母只能按前缀猜，多个份额时会要求补全。
    </div>
    <div class="field"><label>① 产品登记编码</label>
      <div class="actin"><input id="pCode" placeholder="如 Z7008926000006" value="${esc(p && p.code || "")}"><button class="btn pri" onclick="queryProduct()">查询</button></div>
      <div class="tip">中国理财网信披平台的登记编码，形如 Z / C 开头</div>
    </div>
    <div id="qResult"></div>
    <div class="field"><label>② 产品代码 <span class="muted">（云端抓净值依据，必填才能自动抓）</span></label>
      <input id="pProd" placeholder="如 YJ01251204A" value="${esc(p && p.prodCode || "")}" oninput="onProdCodeInput()">
      <div id="pProdTip" class="tip"></div>
    </div>
    <div class="field"><label>③ 产品名称 *（建议带机构简称）</label>
      <input id="pName" placeholder="如 北银理财京华远见春系列诚享7天持有期29号理财产品" value="${esc(p && p.name || "")}" oninput="onProdCodeInput()">
    </div>
    <div class="field"><label>④ 发行机构</label>
      <input id="pInst" placeholder="如 北银理财有限责任公司" value="${esc(p && p.inst || "")}" oninput="onProdCodeInput()">
      <div class="tip">发行方（如「广银理财」「北银理财」）或完整产品名含「理财」即可自动识别；代销银行（微众/招行等）不影响，识别依据是发行方与产品名</div>
    </div>
    ${meta}
    <div class="note" style="margin-bottom:12px">历史净值可不填，保存后由云端抓取自动补全；也可在「交易」页用「录入/查看净值」手工补录。</div>
    <div class="row-btn">
      <button class="btn gh" style="flex:1" onclick="closeSheet()">取消</button>
      <button class="btn pri" style="flex:1" onclick="saveProduct('${pid || ""}')">${p ? "保存修改" : "保存产品"}</button>
    </div>`);
  onProdCodeInput();
}
function openProd() { prodForm(""); }
function editProd(pid) { prodForm(pid); }
/* 产品代码输入时的实时机构识别提示 */
function onProdCodeInput() {
  const el = $("pProd"), tip = $("pProdTip");
  if (!el || !tip) return;
  const code = (el.value || "").trim();
  const explicit = detectOrg({ inst: $("pInst") ? $("pInst").value : "", name: $("pName") ? $("pName").value : "" });
  if (!code) {
    tip.className = "tip";
    tip.textContent = explicit ? `已按「${ORG_NAME[explicit]}」抓取，请补填产品代码` : "填产品代码后自动识别机构";
    return;
  }
  const d = detectOrgByProdCode(code);
  tip.className = "tip";
  if (d.org) {
    const clash = explicit && explicit !== d.org
      ? ` <span style="color:var(--up)">⚠️ 但名称/机构指向 ${ORG_NAME[explicit]}，请核对</span>` : "";
    tip.innerHTML = `识别为 <b>${ORG_NAME[d.org]}</b> ✓ · ${esc(d.tip)}${clash}`;
  } else if (d.tip) {
    tip.textContent = d.tip;
  } else {
    tip.textContent = explicit
      ? `代码形态未识别，将按名称/机构判定的「${ORG_NAME[explicit]}」抓取`
      : "代码形态未识别，请填完整产品名（含发行方，如「广银理财…」）或 Z 开头登记编码";
  }
}
async function queryProduct() {
  const code = ($("pCode").value || "").trim();
  if (!code) return toast("请输入登记编码");
  $("qResult").innerHTML = `<div class="note b">查询中，请稍候…（平台有概率验证码，可能需要重试）</div>`;
  try {
    const r = await fetch(DETAIL_PAGE + encodeURIComponent(code));
    const txt = await r.text();
    const dom = new DOMParser().parseFromString(txt, "text/html");
    /* 尝试从页面提取产品名 / 机构 / 净值表 */
    let name = "", inst = "";
    const descs = dom.querySelectorAll(".el-descriptions__item");
    descs.forEach(it => {
      const l = it.querySelector(".el-descriptions__label"), c = it.querySelector(".el-descriptions__content");
      if (l && c) { const k = l.textContent.trim(); if (k.includes("产品名称")) name = c.textContent.trim(); if (k.includes("发行机构")) inst = c.textContent.trim(); }
    });
    /* 净值表 */
    let navs = {};
    dom.querySelectorAll("table").forEach(tb => {
      const ths = [...tb.querySelectorAll("th")].map(x => x.textContent.trim());
      const di = ths.findIndex(x => x.includes("日期")), ni = ths.findIndex(x => x.includes("净值"));
      if (di >= 0 && ni >= 0) {
        tb.querySelectorAll("tbody tr").forEach(tr => {
          const tds = tr.querySelectorAll("td");
          if (tds.length > Math.max(di, ni)) {
            const d = tds[di].textContent.trim().replace(/\//g, "-");
            const v = Number(tds[ni].textContent.trim().replace(/,/g, ""));
            if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v > 0) navs[d] = v;
          }
        });
      }
    });
    if (!name) {
      $("qResult").innerHTML = `<div class="note">未解析到产品信息（可能命中验证码或该页为动态加载）。请手动填写下方字段。</div>`;
      return;
    }
    $("pName").value = name; $("pInst").value = inst || "";
    UI.queriedNav = navs;
    const n = Object.keys(navs).length;
    $("qResult").innerHTML = `<div class="note g">已识别：<b>${esc(name)}</b><br>净值 ${n} 条${n ? "（" + Object.keys(navs).sort()[0] + " ~ " + Object.keys(navs).sort().pop() + "）" : ""}
      <br><span style="font-size:11px">注意：信披平台只提供登记编码，云端自动抓净值还需另填 <b>产品代码</b>。</span></div>`;
    onProdCodeInput();
  } catch (e) {
    $("qResult").innerHTML = `<div class="note">查询失败：${esc(String(e).slice(0, 80))}<br>可能是跨域限制或验证码。请手动填写。</div>`;
  }
}
function saveProduct(pid) {
  const name = ($("pName").value || "").trim();
  if (!name) return toast("产品名称必填");
  const patch = {
    code: ($("pCode").value || "").trim(),
    prodCode: ($("pProd").value || "").trim(),
    name,
    inst: ($("pInst").value || "").trim()
  };
  let target;
  if (pid) {
    target = DATA.products.find(x => x.id === pid);
    if (!target) return toast("产品不存在，请刷新后重试");
    Object.assign(target, patch);
    if (UI.queriedNav) target.navHistory = Object.assign(target.navHistory || {}, UI.queriedNav);
  } else {
    target = Object.assign({ id: uid(), navHistory: UI.queriedNav || {}, createdAt: Date.now() }, patch);
    DATA.products.push(target);
    if (UI.activePick !== undefined) UI.activePick = target.id;
  }
  const st = fetchStatus(target);
  UI.queriedNav = null; UI.editProdId = "";
  saveLocal(); closeSheet();
  toast((pid ? "产品已更新。" : "产品已保存。") + st.txt, st.ok ? 2200 : 3600);
  renderProd(); renderHome();
  autoPush();
  /* T1b：新添加的产品当场去官网档案取一次底层/申赎规则（不挡这条同步返回的路）。
     手工值优先、出处不齐不入账，这些判定都在 applyAutoDisc 里，这里只负责起一趟。 */
  if (!pid && rulesOrgOk(target)) autoFillRules(target, "add").catch(e => toast("规则回填异常：" + String(e).slice(0, 60), 5000));
}

/* ============================================================
   底层配置与申赎规则（T1）
   ------------------------------------------------------------
   口径全部在 js/core/disc.js（null 是不知道 / ratePct 是百分数 / 分档是 [from,to)），
   这里只做三件事：把字段拼成一张卡、把表单收进 DATA、把缺失如实显示出来。
   这张卡有两条来路：手工录入，和 v70 起的官网档案自动回填（本机 Python 桥，
   请求带 mode:"rules"）。当年说好的「回填复用这套字段和这个表单、不另开通路」
   已经兑现 —— 回填只经 applyAutoDisc 写这同一份 DATA，没有第二套空值语义，
   T7 的规则引擎仍然只认一处。
   两条来路撞上时手工值优先：手工录过的项回填跳过，哪几项被挡下来在抓取框当场念；
   官网那一页凑不齐「链接 + 站内披露日期」就只记缺口、不写值。
   ============================================================ */
const DISC_STATUS_TEXT = { none: "未录入", manual: "手工录入", auto: "检索回填" };
/* 有内容却没出处 = 脏数据指示器，不是「未录入」：
   前端写入路径（parseDiscForm）本来就不允许这种组合存进去，会出现只可能是
   手工改过的数据或别的设备推上来的快照。说成「未录入」是撒谎（屏幕上明明有值），
   说成「手工录入」更糟 —— 那等于给一条追不到处的规则盖了可信的章。
   「有没有内容」的判据本身在 js/core/disc.js 的 discHasContent()，体检页共用它。 */
function discStatusText(p) {
  const d = normDisc(p && p.disc);
  if (!discHasContent(d)) return DISC_STATUS_TEXT.none;
  if (!d.source) return "缺出处";
  return DISC_STATUS_TEXT[d.status] || DISC_STATUS_TEXT.none;
}

/* 一张卡：有值就照录展示，没值就写「未披露」并说清它挡住后面哪一步。
   不猜、不填默认值 —— 未披露的赎回费在换仓建议里只能是「信息不足」，
   这里若显示成 0%，用户会以为赎回不要钱。 */
function discCard(p, pos) {
  const d = normDisc(p.disc);
  const gaps = discGaps(p.disc);
  const rows = [];
  rows.push(`<tr><td>最短持有 / 封闭</td><td>${d.lockDays === null
    ? `<span class="muted">未披露</span>` : d.lockDays === 0
      ? "无持有期限制" : d.lockDays + " 天"}</td></tr>`);
  rows.push(`<tr><td>开放与赎回安排</td><td>${d.openRule ? esc(d.openRule) : `<span class="muted">未披露</span>`}</td></tr>`);
  rows.push(`<tr><td>赎回费分档</td><td>${d.feeRedeem.length
    ? d.feeRedeem.map(f => `${f.from}–${f.to === null ? "不限" : f.to} 天 <b>${f.ratePct}%</b>`).join("<br>")
    : `<span class="muted">未披露 · 换仓成本算不了</span>`}</td></tr>`);
  rows.push(`<tr><td>底层资产配置</td><td>${d.assets.length
    ? d.assets.map(a => `${esc(a.name)}${a.pct === null ? "" : " <b>" + a.pct + "%</b>"}`).join("<br>")
    : `<span class="muted">未披露</span>`}</td></tr>`);
  rows.push(`<tr><td>投资范围（短引）</td><td>${d.investScope ? esc(d.investScope) : `<span class="muted">未披露</span>`}</td></tr>`);
  /* 已持仓时把「当前落在哪一档」直接说出来了，用户才看得见录进去的东西有没有被用上。
     这里只取档、不给建议 —— 建议是下面 T7a「现在赎的话」与 T7b「换到另一只的话」两张卡的事。 */
  const holdRate = pos && pos.shares > 0 && typeof pos.holdDays === "number"
    ? feeRateFor(p.disc, pos.holdDays) : null;
  /* 把「录进去的档位真的被取到了」显示出来：只显示落在哪一档，不显示任何建议。
     越界一步就会让用户以为换仓结论已经出来了 —— 结论有它自己的两张卡（v74 / v75）。 */
  const holdLine = typeof holdRate === "number"
    ? `<div class="tip" style="margin-top:8px">按当前持有 ${Math.floor(pos.holdDays)} 天，赎回费落在 <b>${holdRate}%</b> 这一档（仅取档展示，判断在下面的卡里）。</div>`
    : "";
  const src = d.source
    ? `<div class="tip" style="margin-top:8px">出处：${esc(DISC_TIER_LABEL[d.source.tier] || d.source.tier)}`
      + `${d.source.publishedAt ? " · 披露 " + esc(d.source.publishedAt) : ""}`
      + `｜<a href="${esc(d.source.url)}" target="_blank" rel="noopener">${esc(d.source.url.slice(0, 60))}${d.source.url.length > 60 ? "…" : ""}</a></div>`
    : "";
  const warn = gaps.length && discHasContent(d)
    ? `<div class="tip" style="margin-top:8px">⚠️ 还缺 ${gaps.length} 项（${gaps.map(g => esc(DISC_GAP_LABEL[g] || g)).join("、")}），缺失项在持仓分析里只会得到「信息不足」，不会由模型补猜。</div>`
    : "";
  /* 还缺东西时得说清「这几项会不会自己补上、什么时候补」：
     只报缺口不报下一步，用户会以为得天天手工催；反过来在网页版上说「等下次同步」
     就是撒谎 —— 这一版根本没有本机抓取。 */
  let autoTip = "";
  if (gaps.length && rulesOrgOk(p)) {
    if (!nativeFetchAvailable()) {
      autoTip = `<div class="tip" style="margin-top:8px">${esc(bridgeMissingMsg("网页版没有本机抓取，规则自动回填用不了：这几项请照说明书手工录入。"))}</div>`;
    } else if (rulesDue(p)) {
      autoTip = `<div class="tip" style="margin-top:8px">下一次本机抓取会顺带去官网档案补这几项（北银 / 农银几秒，徽银要在产品列表里翻页找，可能要一两分钟）。</div>`;
    } else if (p.rulesAt) {
      autoTip = `<div class="tip" style="margin-top:8px">上一次官网检索是 ${esc(String(p.rulesAt).slice(0, 10))}，${RULES_COOLDOWN_DAYS} 天内不重复翻页；这几项要是官网档案里本来就没有（赎回费分档在说明书 PDF 里），只能手工补。</div>`;
    } else {
      autoTip = `<div class="tip" style="margin-top:8px">这几项已经录齐到不用再去官网检索；要继续手工核对就照披露原文改。</div>`;
    }
  }
  return `<table class="navtbl"><thead><tr><th>披露项</th><th>录入内容</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    ${src}${holdLine}${warn}${autoTip}
    <div class="cap" style="padding:6px 0 0">口径为照录披露原文：null 表示未披露，与「0」不同义；占比与费率均为百分数本身。</div>`;
}

/* 录入 / 编辑表单（独立一张 sheet，不塞进「添加产品」：
   添加时手上通常只有代码，披露文件是之后另找时间读的。） */
/* 从产品详情进来时先关掉那一层：closeSheet + openSheet 必须在同一个同步拍里，
   弹层才是「替换」而不是叠加（openSheet 里靠 sheetPopPending 补压哨兵）。
   入口名写成 onclick 的第一个调用，是因为 handlers.test.mjs 的桥接扫描只认
   on*="fn(...)" 里的第一个函数名 —— 用「closeSheet();openDisc(...)」这种多语句，
   openDisc 会被判成挂了 window 却没人调的多余名字。 */
function openDisc(pid) {
  closeSheet();
  const p = DATA.products.find(x => x.id === pid);
  if (!p) return toast("产品不存在，请刷新后重试");
  const d = normDisc(p.disc);
  const feeText = d.feeRedeem.map(f => `${f.from}${f.to === null ? "+" : "-" + f.to} ${f.ratePct}`).join("\n");
  const asText = d.assets.map(a => `${a.name}${a.pct === null ? "" : " " + a.pct}`).join("\n");
  const tierOpt = DISC_TIERS.map(t => `<option value="${t}"${d.source && d.source.tier === t ? " selected" : ""}>${esc(DISC_TIER_LABEL[t] || t)}</option>`).join("");
  openSheet(`<div class="sheet-t"><h3>底层配置与申赎规则</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      给 <b>${esc(prodLabel(p))}</b> 录入披露原文里的规则。<br>
      只照录，不概括：<b>留空就是「未披露」</b>，后面的持仓分析遇到空项只会输出「信息不足」，
      不会替它猜一个数 —— 所以宁可不填，也别填一个看着像的。
    </div>
    <div class="field"><label>最短持有 / 封闭天数</label>
      <input id="dLock" inputmode="numeric" placeholder="如 7；开放式无持有期填 0" value="${d.lockDays === null ? "" : d.lockDays}">
      <div class="tip">「XX 天持有期」就填 XX；确需表达「没有持有期」请填 0，留空是未披露</div>
    </div>
    <div class="field"><label>开放与赎回安排</label>
      <input id="dOpen" placeholder="如 每周二开放赎回，T+1 到账" value="${esc(d.openRule)}">
    </div>
    <div class="field"><label>赎回费分档（每行一档）</label>
      <textarea id="dFee" rows="4" placeholder="0-7 1.50&#10;7-30 0.50&#10;30+ 0">${esc(feeText)}</textarea>
      <div class="tip">写成「起始-结束 费率%」，最后一档没有上限就写「30+ 0」；区间必须首尾相接，有空洞会被拦下</div>
    </div>
    <div class="field"><label>底层资产配置（每行一项）</label>
      <textarea id="dAssets" rows="4" placeholder="非标准化债权类资产 42.5&#10;同业存单 30&#10;债券 27.5">${esc(asText)}</textarea>
      <div class="tip">写成「名称 占比%」；名称照披露原文（如「现金及银行存款」「非标准化债权类资产」「信托」）</div>
    </div>
    <div class="field"><label>投资范围（只摘关键句）</label>
      <textarea id="dScope" rows="3" placeholder="如 固定收益类资产不低于 80%…">${esc(d.investScope)}</textarea>
    </div>
    <div class="note" style="margin:6px 0 10px">出处是必填项：填了内容就得说清从哪来，否则保存会被拦下。</div>
    <div class="field"><label>披露页链接</label>
      <input id="dUrl" placeholder="https://…" value="${esc(d.source ? d.source.url : "")}">
    </div>
    <div class="field"><label>来源类型</label>
      <select id="dTier">${tierOpt}</select>
    </div>
    <div class="field"><label>披露日期（页面上写的那个日期）</label>
      <input id="dPub" placeholder="如 2026-09-30" value="${esc(d.source ? d.source.publishedAt : "")}">
    </div>
    <div class="row-btn">
      <button class="btn gh" style="flex:1" onclick="closeSheet()">取消</button>
      <button class="btn pri" style="flex:1" onclick="saveDisc('${p.id}')">保存</button>
    </div>`);
}

function saveDisc(pid) {
  const p = DATA.products.find(x => x.id === pid);
  if (!p) return toast("产品不存在，请刷新后重试");
  const { disc, errors } = parseDiscForm({
    lockDays: $("dLock").value,
    openRule: $("dOpen").value,
    feeRedeem: $("dFee").value,
    assets: $("dAssets").value,
    investScope: $("dScope").value,
    sourceUrl: $("dUrl").value,
    sourceTier: $("dTier").value,
    sourceTitle: "",
    sourcePublishedAt: $("dPub").value
  });
  /* 有错就一条都不存：半截保存会让产品看起来「有配置」，
     而 T7 会拿着缺档的规则算出看不出错的建议。 */
  if (errors.length) return toast(errors[0], 4200);
  p.disc = disc;
  saveLocal(); closeSheet();
  toast(disc.status === "none" ? "已清空该项配置（按未披露处理）" : "底层配置已保存", 2000);
  renderProdDetail();
  autoPush();
}

/* ============================================================
   T7a · 现在赎的话（v74）
   ------------------------------------------------------------
   判定全在 js/domain/advice.js（纯函数、可单测），这一层只做三件事：
     · 把 advice.js 交回来的数字一律走 shown() 现算现显 —— 结论文本里没有钱，
       钱也就进不了任何缓存（隐私遮罩是显示态，写进文本等于绕过它）；
     · 把档位词写成字，色带只是辅助：灰度截图、色觉障碍、对比度不足时还得读得出；
     · 不建缓存：结论每次从当前持仓与当前规则现推。
       「改完配置卡片还停在旧结论」比多算一次贵得多。
   这一版只回答「这一只现在赎得出来吗、赎要付多少」。
   「该不该换到另一只」是跨产品的比较，v75 起另有一张卡（T7b 换到另一只的话）——
   两张卡各判各的：这张卡仍然不出现任何跨产品的结论。
   ============================================================ */
function adviceCard(p, pos) {
  const adv = redeemAdvice({ p, pos, td: today() });
  /* 结论词的颜色只按档位给，判定本身在 advice.js */
  const vLevel = adv.verdict === "yes" ? "ok" : adv.verdict === "no" ? "bad"
    : adv.verdict === "skip" ? "skip" : "na";
  const row = (title, level, text) =>
    `<tr class="ana ${level}"><td>${esc(title)}</td><td><b>${esc(ANA_LEVEL_TEXT[level] || level)}</b>${esc(text)}</td></tr>`;
  /* 费率是百分数本身（disc.js 第 2 条口径），不能喂给 pct()（那个入参是小数） */
  const rateTxt = v => v === null ? "—" : (Math.round(v * 100) / 100) + "%";
  const moneyBlock = adv.market !== null
    ? `<div class="grid2" style="margin:10px 0 6px">
        <div class="stat"><div class="l">按最新净值</div><div class="v">${shown(money(adv.market))}</div><div class="cap">已确认份额 × ${esc(pos.lastDate || "—")} 的净值</div></div>
        <div class="stat"><div class="l">扣费后到手</div><div class="v">${adv.net === null ? "—" : shown(money(adv.net))}</div><div class="cap">${adv.ratePct === null ? "赎回费未披露 → 扣多少算不出" : "赎回费 " + rateTxt(adv.ratePct) + "，约扣 " + (adv.fee === null ? "—" : shown(money(adv.fee)))}</div></div>
      </div>`
    : "";
  return `<div class="card-t" style="margin:16px 0 8px"><h2 style="font-size:14px">现在赎的话</h2><span class="hint">只判这一只 · 不给换仓建议</span></div>
    ${moneyBlock}
    <table class="navtbl ana"><tbody>
      ${row("结论", vLevel, adv.verdictText + (adv.unlockInDays !== null ? `（还差 ${adv.unlockInDays} 天）` : ""))}
      ${adv.lines.map(l => row(l.title, l.level, l.text)).join("")}
    </tbody></table>`;
}

/* ============================================================
   T7b · 换到另一只的话（v75）
   ------------------------------------------------------------
   判定全在 js/domain/switchadv.js（纯函数、可单测），这一层只做四件事：
     · 「要换进的那一只」由用户选：没有对比对象时引擎只回「不适用」，
       页面绝不拿一只去猜另一只；
     · 钱与收益一律走 shown() 现算现显 —— 赎回来的到手是钱，两边的年化是钱折算
       出来的，隐藏开关打开时两类一起藏（把「差 0.83 个百分点」写成文字就等于
       绕过遮罩把收益摆在大屏上）；
     · 引擎没有「该换」这一档，卡片也不许造：措辞只说换得动、要背什么代价；
     · 不缓存：结论每次从两边当前持仓与当前规则现推，
       改完任一张配置卡片，下一屏就得变，不然用户对照的是旧账。
   ============================================================ */
function switchCard(p, pos) {
  const others = DATA.products.filter(x => x.id !== p.id);
  const b = UI.switchTo ? DATA.products.find(x => x.id === UI.switchTo) : null;
  const sw = switchAdvice({ a: p, b, posA: pos, posB: b ? position(b) : null, td: today() });
  const row = (title, level, text) =>
    `<tr class="ana ${level}"><td>${esc(title)}</td><td><b>${esc(ANA_LEVEL_TEXT[level] || level)}</b>${esc(text)}</td></tr>`;
  const vLevel = sw.verdict === "ready" ? "ok" : sw.verdict === "no" ? "bad"
    : sw.verdict === "skip" ? "skip" : "na";
  const rateTxt = v => v === null ? "—" : (Math.round(v * 100) / 100) + "%";
  const pick = others.length
    ? `<div class="field" style="margin-top:10px"><label>要换进的那一只</label>
        <select id="switchPick" onchange="setSwitchTarget(this)">
          <option value="">— 选一只做对比对象 —</option>
          ${others.map(x => `<option value="${esc(x.id)}"${UI.switchTo === x.id ? " selected" : ""}>${esc(prodLabel(x))}</option>`).join("")}
        </select></div>`
    : `<div class="tip" style="margin-top:8px">台账里只有这一只产品：跨产品的比较要两只都在才判得了，先另建一只。</div>`;
  const nums = sw.market !== null
    ? `<div class="grid2" style="margin:10px 0 6px">
        <div class="stat"><div class="l">赎出来到手</div><div class="v">${sw.net === null ? "—" : shown(money(sw.net))}</div><div class="cap">${sw.ratePct === null ? "赎回费未披露 → 扣多少算不出" : "市值 " + shown(money(sw.market)) + "，赎回费 " + rateTxt(sw.ratePct)}</div></div>
        <div class="stat"><div class="l">换进去后新锁定</div><div class="v">${sw.toLockDays === null ? "—" : sw.toLockDays === 0 ? "不限" : sw.toLockDays + " 天"}</div><div class="cap">${sw.toLockDays === null ? "那一只的持有期没录 → 锁多久不知道" : sw.toLockDays === 0 ? "披露为无持有期限制" : "从零起算，在手的天数带不过去"}</div></div>
      </div>`
    : "";
  /* 两边的年化是钱折算出来的：数值只在 shown(pct(...)) 的括号里出现，
     颜色也走 tone()，否则隐藏时「绿的还是红的」就把收益方向漏了 */
  const perf = sw.perf.diff === null ? ""
    : `<div class="tip" style="margin-top:8px">持仓年化：这一只 <b class="${tone(sw.perf.a)}">${shown(pct(sw.perf.a))}</b>、那一只 <b class="${tone(sw.perf.b)}">${shown(pct(sw.perf.b))}</b>，差 <b class="${tone(sw.perf.diff)}">${shown(pct(Math.abs(sw.perf.diff)))}</b>。<span class="muted">两边各按自己的持有天数折算，窗口不同；历史不代表未来，这两个数不是换的依据。</span></div>`;
  return `<div class="card-t" style="margin:16px 0 8px"><h2 style="font-size:14px">换到另一只的话</h2><span class="hint">只判换得动 · 不说该不该</span></div>
    ${pick}
    ${nums}
    <table class="navtbl ana"><tbody>
      ${row("结论", vLevel, sw.verdictText + (sw.unlockInDays !== null ? `（还差 ${sw.unlockInDays} 天）` : ""))}
      ${sw.lines.map(l => row(l.title, l.level, l.text)).join("")}
    </tbody></table>${perf}`;
}

/* ============================================================
   T2 · 持仓体检
   ------------------------------------------------------------
   判定与缓存的认账本全在 js/domain/analysis.js（纯函数、可单测），
   app.js 这一层只做四件事：取当前输入、算指纹、按三态决定重算还是复用、把结论排成 HTML。

   为什么要有缓存、又为什么缓存里不能有金额：
     体检每次都把份额/净值/档位重走一遍（算法在别的模块里），成本不算高，
     但结论必须能回答「这条是什么时候的、数据变了没有」—— 所以配了结果指纹与本机缓存。
     而「隐藏金额」是显示态：一旦把带金额的结论文本缓存下来，
     下次开着遮罩进来要么读到上一次的明文（遮罩漏了），要么整个缓存作废
     （每切一次开关都重算）。analysis.js 的第 2 条口径因此是「文本里不写钱」，
     钱留在页面上用 shown()/tone() 现算现显。
   ============================================================ */
/* 缓存读写：JSON 坏了 / 版本不符 / 形状不对一律当空账本重开（判定在 normAnaCache 里）。 */
function anaCache() {
  const raw = lsGet(LS_ANA);
  if (!raw) return { v: ANA_CACHE_V, byId: {} };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  return normAnaCache(parsed);
}
function anaCachePut(pid, fp, checks) {
  const c = anaCache();
  c.byId[String(pid)] = { fp, at: Date.now(), checks };
  /* 写回的是认过账的那一份：超上限时 normAnaCache 按 at 淘汰最旧的几条 */
  lsSet(LS_ANA, JSON.stringify(normAnaCache(c)));
}
function anaCacheDel(pid) {
  const c = anaCache();
  if (c.byId[String(pid)] === undefined) return;
  delete c.byId[String(pid)];
  lsSet(LS_ANA, JSON.stringify(normAnaCache(c)));
}
function clearAnaCache() {
  lsDel(LS_ANA);
  renderAna(false);
  toast("体检缓存已清空，结论全部重算", 2400);
}

/* 体检的表格复用 .navtbl（底层配置卡用的那一张），只加一条「左边色带 + 档位词」的样式。
   档位词必须写成文字：只靠颜色传达判定，在灰度截图 / 色觉障碍 / 对比度不足时等于没传达。 */
function anaRow(c) {
  const rp = anaRowParts(c);
  return `<tr class="ana ${c.level}"><td>${esc(c.title)}</td><td><b>${esc(rp.level)}</b>${esc(rp.body)}</td></tr>`;
}
function anaTable(checks) {
  return `<table class="navtbl ana"><tbody>${checks.map(anaRow).join("")}</tbody></table>`;
}
function anaSumLine(checks) {
  const counts = {};
  checks.forEach(c => { counts[c.level] = (counts[c.level] || 0) + 1; });
  return ANA_LEVELS.map(l => (counts[l] ? `${ANA_LEVEL_TEXT[l]} ${counts[l]}` : "")).filter(Boolean).join(" · ");
}
/* 页尾那一行组合摘要：只算比值与覆盖度，同样不写钱 */
function anaPortfolioLine() {
  const pf = portfolio();
  const cs = portfolioChecks(pf.rows.map(r => ({ id: r.p.id, name: prodLabel(r.p), market: r.pos.market })),
    DATA.products.length);
  return `<div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">组合这一层</h2><span class="hint">占比是比值，不含金额</span></div>
    ${anaTable(cs)}`;
}
/* 顶部金额块：与详情页共用 position()，遮罩走 shown()/tone() */
function anaMoney(p) {
  const pos = position(p);
  if (!(pos.shares > 0)) return "";
  return `<div class="grid2" style="margin-bottom:12px">
    <div class="stat"><div class="l">持有金额</div><div class="v">${shown(money(pos.market))}</div><div class="cap">已确认份额 × 最新净值</div></div>
    <div class="stat"><div class="l">持仓收益</div><div class="v ${tone(pos.profit)}">${shown(signMoney(pos.profit))}</div><div class="cap">市值 − 持仓成本</div></div>
  </div>`;
}
function anaTimeText(ms) {
  const d = new Date(Number(ms));
  if (!isFinite(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 渲染体检页。force = true 时忽略缓存重算（「强制重算」按钮走这条）。
 * 金额一律现算现显，不进缓存。
 */
function renderAna(force) {
  const p = DATA.products.find(x => x.id === UI.viewProd);
  if (!p) return;
  const td = today();
  const fp = anaFingerprint({ p, trades: DATA.trades, td });
  const entry = anaCache().byId[String(p.id)];
  const st = anaCacheState(force ? null : entry, fp);
  let checks, note;
  if (st.state === "fresh") {
    checks = st.checks;                          /* 数据没变：结论直接复用，不重算 */
    note = `结论生成于 ${anaTimeText(st.at)} · 数据未变，结论复用`;
  } else {
    checks = runChecks({ p, trades: DATA.trades, td, pos: position(p), st: navStats(p) });
    anaCachePut(p.id, fp, checks);
    note = st.state === "stale"
      ? `上次体检在 ${anaTimeText(st.at)}，数据已变，${anaTimeText(Date.now())} 重算`
      : force ? `按「强制重算」于 ${anaTimeText(Date.now())} 重算`
        : `本次体检在 ${anaTimeText(Date.now())} 现算（这只产品还没有体检记录）`;
  }
  openSheet(`<div class="sheet-t"><h3>持仓体检</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      给 <b>${esc(prodLabel(p))}</b> 做一遍体检。<br>
      判据全部来自本账本已有的数据与已录的披露规则（净值 / 份额 / 持有天数 / 赎回费档），
      <b>没有一项是模型猜的</b>；缺字段那几项只会写「信息不足（缺 X）」，不会替它补一个看着合理的数。
    </div>
    ${anaMoney(p)}
    <div class="chips" style="margin-bottom:8px"><span class="muted" style="font-size:11.5px">${esc(anaSumLine(checks))}</span></div>
    ${anaTable(checks)}
    ${anaPortfolioLine()}
    <div class="cap" style="padding:10px 0 0">
      ${esc(note)}（输入指纹 ${esc(fp)}）。指纹只由「产品、今天、净值日期与数值、已录披露、相关交易」算出 ——
      切换「隐藏金额」不会让它作废。结论缓存在本机，不进 licai-data.json，也不推云端。
    </div>
    <div class="row-btn" style="margin-top:12px">
      <button class="btn gh" style="flex:1" onclick="refreshAna('${p.id}')">强制重算</button>
      <button class="btn gh" style="flex:1" onclick="clearAnaCache()">清空缓存</button>
    </div>`);
}
/* 入口写成 openAna(...) 的第一个调用、函数体第一句 closeSheet()：
   handlers.test.mjs 的桥接扫描只认 on*="fn(...)" 里的第一个函数名（同 openDisc 的 precedent）。 */
function openAna(pid) {
  closeSheet();
  const p = DATA.products.find(x => x.id === pid);
  if (!p) return toast("产品不存在，请刷新后重试");
  UI.viewProd = pid;
  renderAna(false);
}
function refreshAna(pid) {
  closeSheet();
  const p = DATA.products.find(x => x.id === pid);
  if (!p) return toast("产品不存在，请刷新后重试");
  anaCacheDel(p.id);
  UI.viewProd = pid;
  renderAna(true);
}
/**
 * 台账页与交易中心那两行入口的落点。去向由 analysis.js 的 anaEntryTarget 判（有测试）。
 * 选择页里点某一只 → openAna 在同一拍里 closeSheet + openSheet，等于替换当前层，
 * 返回键因此还是「先回选择页」而不是「直接关掉整张弹层」。
 */
function openAnaIndex() {
  const t = anaEntryTarget(DATA.products);
  if (t.kind === "none") return toast("还没有录入产品，先去交易中心添加产品", 3200);
  if (t.kind === "direct") return openAna(t.id);
  const td = today();
  const cache = anaCache();
  const rows = t.list.map(p => {
    const pos = position(p);
    const st = anaCacheState(cache.byId[String(p.id)], anaFingerprint({ p, trades: DATA.trades, td }));
    return `<div class="prow">
      <div class="pn"><button class="link" onclick="openAna('${p.id}')">${esc(prodLabel(p))}</button></div>
      <div class="pv muted">${esc(anaEntryStatus(pos, st))}</div>
      ${st.state === "fresh" ? `<div class="pk"><i>${esc(anaSumLine(st.checks))} · ${esc(anaTimeText(st.at))}</i></div>` : ""}
    </div>`;
  }).join("");
  openSheet(`<div class="sheet-t"><h3>持仓体检</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      体检是<b>一只一只</b>判的，选一只看它自己的 9 项。
      判据全部来自本账本已有的数据与已录的披露规则（净值 / 份额 / 持有天数 / 赎回费档），
      <b>没有一项是模型猜的</b>；缺字段那几项只会写「信息不足（缺 X）」。
    </div>
    ${rows}
    ${anaPortfolioLine()}
    <div class="cap" style="padding:10px 0 0">结论缓存在本机，不进 licai-data.json，也不推云端。</div>`);
}

/* ============================================================
   T3 · 模型接入（只在 App 内）
   ------------------------------------------------------------
   分工是照「JS 不经手密钥」这条切的：
     原生侧（LlmBridge.java）—— 存密钥（Android Keystore）、存端点与模型、发 HTTPS、
                                 把响应**原样**分块回传；它不解析内容。
     页面侧（js/domain/llm.js）—— 认形状、分来源、管超时与重试；它拿不到密钥。
   两边只交换两样东西：出去一个不含凭据的请求体，回来一串分块的原文 + 一轮元信息。

   为什么不自动重试：一次请求一次计费（铁律 #5）。超时 / 断网 / 5xx 一律把状态摊开，
   重试这颗按钮只由用户点，点之前提示「上一次可能已经计费」。
   为什么来源要 URL + 发布时间两样齐（铁律 #3）：缺任何一条，用户事后都回不去原文，
   那就等于没有出处 —— 宁可显示「这次没能拿到可核实的出处」。

   v65 在这一节里加的是「接着问」：会话历史（turns / turn）只在内存，
   每轮把上文压成一段文本随 input 上送（原生那条路只认字符串），发满 LLM_MAX_ROUNDS 轮停手。
   v66 加的是「带上我的台账」：勾了才把本机台账压成一段文本一起发（白名单十个字段，
   金额位跟随本机「隐藏金额」）。v64 那句 instructions 写着「只根据给出的台账数据回答」，
   可当时什么都没给 —— 那是一句假话，这一版把它改成实话。
   ★ 桥面七个方法一个字没动，但 v67 改了原生侧的**行为**（setConfig 多认一个 apiStyle、
     ask 能按 Chat 形制拼、路径跟着换），所以这一版要出包（1.0.219）才有效果。
     壳读的是 APK 里那份 assets/www（MainActivity.START_URL），不是 GitHub Pages ——
     v65/v66 那份页面也是到这一版才第一次上手机；旧壳上「协议」这一行不画，行为与 v66 一致。
   ============================================================ */
/* 一轮问答的全部状态。不落 localStorage：换设备 / 刷新就该重问，不留半成品。
   v65 起多了两个字段（turns / turn）—— 会话内容里多半夹着产品名与持仓，
   把它写进浏览器存储等于把台账多一份没人管的副本，所以只留在内存。 */
const LLM = { phase: "idle", id: "", buf: null, meta: null, res: null, q: "", err: "",
  timer: 0, cfg: null, hasKey: false, costWarn: false, turns: [], turn: null, withData: false };
/** 这个会话已经发出去几个请求（含失败与超时的那些 —— 它们多半已经计费了，占额度）。 */
function llmUsed() { return LLM.turns.length + (LLM.turn ? 1 : 0); }
/** 台账快照的入参数组：只挑 llmSnapshot 认的那十个字段。
    这里刻意不碰 SYNC、不碰任何凭据与仓库信息 —— 少一个入口少一处能漏的地方。 */
function llmSnapItems() {
  return DATA.products.map(p => {
    const pos = position(p);
    return {
      name: p.name, inst: p.inst, code: p.prodCode || p.code || p.regCode || "",
      risk: p.riskLevel, nav: pos.lastNav, navDate: pos.lastDate,
      shares: pos.shares, cost: pos.cost, holdDays: pos.holdDays,
      state: pos.inTransit ? "在途（份额未确认）"
        : (pos.shares > 0 ? "持仓中" : (hasAnyTradeIn(p, DATA.trades) ? "已清仓" : "从未建仓")),
    };
  });
}
/** 按本机设置把快照压成文本；金额位跟「隐藏金额」走。 */
function llmSnapText() {
  return llmSnapshot(llmSnapItems(), { hide: !!DATA.settings.hideAmount, today: today() });
}
/** 发之前就能看见要发什么 —— 这一行的存在就是为了「勾上了不是稀里糊涂出去的」。 */
function llmSnapLine() {
  const n = DATA.products.length;
  if (!LLM.withData) return `<div class="cap" style="padding-top:2px">现在没带台账数据：模型只听得到你敲进框里那一句。</div>`;
  const s = llmSnapText();
  return `<div class="cap" style="padding-top:2px">本轮会带上：${Math.min(n, LLM_SNAPSHOT_MAX_ITEMS)} / ${n} 只 · ${s.length} 字`
    + (n > LLM_SNAPSHOT_MAX_ITEMS ? `（超过 ${LLM_SNAPSHOT_MAX_ITEMS} 只的写在末尾，不静默截）` : "")
    + (DATA.settings.hideAmount ? " · 金额按本机「隐藏金额」隐去" : "") + "</div>";
}
function llmDataToggle() {
  const el = $("llmData");
  LLM.withData = !!(el && el.checked);
  openLlm();
}

function llmBridge() {
  try {
    return (window[LLM_BRIDGE] && window[LLM_BRIDGE].ready && window[LLM_BRIDGE].ready())
      ? window[LLM_BRIDGE] : null;
  } catch (e) { return null; }
}
/** 原生侧的非敏感配置（baseUrl / model）。读不到就当没配 —— 不猜默认端点。 */
function llmReadCfg() {
  const b = llmBridge();
  if (!b) { LLM.cfg = null; LLM.hasKey = false; return; }
  let cfg = null, hk = false;
  try { cfg = JSON.parse(b.getConfig() || "null"); } catch (e) { cfg = null; }
  try { hk = !!b.hasKey(); } catch (e) { hk = false; }
  LLM.cfg = (cfg && typeof cfg === "object") ? cfg : {};
  LLM.hasKey = hk;
}
/**
 * 这台壳认不认「协议形制」这个设置（v67 · R1）。
 * ★ 判的是**键在不在**，不是值对不对：旧壳（1.0.218 及以前）的 getConfig 里根本没有 apiStyle，
 *   新壳哪怕没配过也会回一个默认值。按值判的话，旧壳会被读成「responses」，
 *   于是选择器画出来了、用户选了 Chat、发出去还是 Responses —— 设了不生效比没有更坏。
 * @returns {boolean}
 */
function llmCanStyle() {
  const c = LLM.cfg;
  return !!(c && Object.prototype.hasOwnProperty.call(c, "apiStyle"));
}
function llmStatusLine() {
  if (!llmBridge()) return `<div class="note b">${esc(llmDegrade({ inApp: false, hasKey: false, shell: inShellHost() }))}</div>`;
  const c = LLM.cfg || {};
  const key = LLM.hasKey
    ? `<b>密钥已配置</b>（存在本机加密区，页面读不到明文）`
    : `<b>未配置密钥</b>`;
  const ep = c.baseUrl ? `端点 ${esc(String(c.baseUrl).replace(/^https:\/\//, ""))} · 模型 ${esc(c.model || "未填")}` : "端点未配置";
  return `<div class="note ${LLM.hasKey && c.baseUrl ? "g" : ""}">${key}<br>${ep}</div>`;
}
function renderLlm() {
  const box = $("llmBox");
  if (!box) return;
  llmReadCfg();
  const b = llmBridge();
  box.innerHTML = llmStatusLine() + `<div class="row-btn" style="margin-top:10px">
      <button class="btn gh" style="flex:1" onclick="llmSetKey()">${LLM.hasKey ? "更换密钥" : "配置密钥"}</button>
      <button class="btn gh" style="flex:1" onclick="openLlm()">${llmUsed() ? "接着问（已发 " + llmUsed() + " 轮）" : "问一句"}</button>
    </div>
    ${b ? `<div class="foot" style="text-align:left;padding-top:9px">
      密钥走原生输入框，页面全程不经手；它不进 localStorage、不进 licai-data.json、也不随台账推云端。
      模型说的内容<b>不会自动写进台账</b> —— 这里只用来问一句、看看出处。
    </div>` : ""}`;
}
function llmSetKey() {
  const b = llmBridge();
  if (!b) return toast(llmDegrade({ inApp: false, hasKey: false, shell: inShellHost() }), 4200);
  /* 输入框是原生的：键入的字符从 IME 直接进 Keystore，不经过 JS 上下文 */
  try { b.promptKey(); } catch (e) { toast("原生输入框没弹出来：" + e, 4200); }
}
function llmClearKey() {
  const b = llmBridge();
  if (!b) return toast("只在本机 App 内可清除", 3200);
  try { b.clearKey(); } catch (e) { return toast("清除失败：" + e, 3600); }
  llmReadCfg(); renderLlm();
  toast("已清除本机密钥", 2600);
}
function llmSaveCfg() {
  const b = llmBridge();
  if (!b) return toast("只在本机 App 内可配置", 3200);
  const baseUrl = (($("llmBase") || {}).value || "").trim();
  const model = (($("llmModel") || {}).value || "").trim();
  const search = !!($("llmSearch") || {}).checked;
  const canStyle = llmCanStyle();
  const cfgOut = { baseUrl, model, search };
  /* 密钥不在这个 JSON 里 —— 它能写的只有端点、模型名、检索开关，外加下面这一个协议选择；
     原生侧（LlmBridge.setConfig）同样只认这四个键，多出来的字段它会丢掉。
     ★ apiStyle 只在这台壳认它的时候才交：旧壳会把不认识的键丢掉，
       于是变成「页面上选了 Chat、发出去还是 Responses」—— 设了不生效，比不给这一项更坏。 */
  if (canStyle) {
    const s = String(($("llmStyle") || {}).value || "");
    cfgOut.apiStyle = s === "chat" ? "chat" : "responses";
  }
  try { b.setConfig(JSON.stringify(cfgOut)); }
  catch (e) { return toast("保存失败：" + e, 3600); }
  llmReadCfg();
  /* 设置页那一行的状态文案是上一次渲染的，端点变了不重画就会停在「端点未配置」 */
  renderLlm();
  toast(canStyle ? "已保存端点、模型与协议" : "已保存端点与模型", 2400);
  openLlm();
}
/** 一轮问答的结果区。phase 只有 idle / running / done / error / timeout / cancelled 六种。
    标题那行「第 N 轮 · 问」是为了发出去之后还看得见发的是哪一句 —— 输入框发完就清了。 */
function llmResultHtml() {
  const t = LLM.turn;
  const head = t ? `<div class="cap" style="padding-bottom:6px">第 ${LLM.turns.length + 1} 轮 · 问：${esc(t.q)}</div>` : "";
  if (LLM.phase === "running")
    return head + `<div class="note b">已发出，等回答…（一次请求一次计费，超时不会自动重发；`
      + `等不及可以点下面「取消这一轮」，取消也撤回不了已经发出去的那一发）</div>`;
  if (LLM.phase === "cancelled")
    return head + `<div class="note r">${esc(LLM_CANCEL_TEXT)}</div>`;
  if (LLM.phase === "timeout")
    return head + `<div class="note r">等满 ${Math.round(LLM_TIMEOUT_MS / 1000)} 秒没回。<b>这一次可能已经计费</b>，
      确认端点状态再重试。</div>`;
  if (LLM.phase === "error")
    return head + `<div class="note r">${esc(LLM.err || "端点没返回可用内容")}</div>`;
  const r = LLM.res;
  if (!r) return "";
  const src = r.sources.length
    ? `<div class="card-t" style="margin:14px 0 6px"><h2 style="font-size:14px">出处</h2>
         <span class="hint">URL 与发布时间两样齐才列进来</span></div>
        <table class="navtbl"><tbody>${r.sources.map(s =>
          `<tr><td style="text-align:left"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.host)}</a>
           <div class="cap">${esc(s.host)} · 发布于 ${esc(s.publishedAt)}</div></td></tr>`).join("")}</tbody></table>`
    : `<div class="note b" style="margin-top:12px">这次<b>没有拿到可核实的出处</b>（缺链接或缺发布时间）。
        按口径它不能进台账，只能当参考。</div>`;
  const drop = r.dropped.length
    ? `<div class="cap" style="padding-top:8px">另有 ${r.dropped.length} 条被丢弃：${esc(r.dropped.map(d => (d.title || d.url || "无名") + "（" + d.why + "）").join("；"))}</div>`
    : "";
  const usage = (r.usage.input || r.usage.output)
    ? `<div class="cap" style="padding-top:8px">形状 ${esc(r.shape)} · 输入 ${r.usage.input} / 输出 ${r.usage.output} token</div>` : "";
  return head + `<div class="note" style="margin-top:12px;white-space:pre-wrap">${esc(r.text)}</div>${src}${drop}${usage}`;
}
/** 上文那一叠。已经落定的轮次才进来，当前这一轮走 #llmOut（它在上面）。
    答案在这里是给人看的全文；发给模型的是压平后的文本，两者同一份内容。 */
function llmHistoryHtml() {
  if (!LLM.turns.length) return "";
  const rows = LLM.turns.map((t, i) => {
    const src = (t.sources && t.sources.length)
      ? `<div class="cap" style="padding-top:4px">出处 ${t.sources.length} 条 · 形状 ${esc(t.shape || "—")}</div>`
      : `<div class="cap" style="padding-top:4px">这一轮没有可核实的出处</div>`;
    return `<div class="note" style="margin-top:8px">第 ${i + 1} 轮 · 问：${esc(t.q)}
      <div style="white-space:pre-wrap;margin-top:5px">${esc(t.a || t.err || "（没拿到内容）")}</div>${src}</div>`;
  }).join("");
  return `<div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">上文（${LLM.turns.length} 轮）</h2>
    <span class="hint">只在本机内存里 · 发下一轮时压成文本带上</span></div>${rows}`;
}
function openLlm() {
  closeSheet();
  if (!llmBridge()) { renderLlm(); return toast(llmDegrade({ inApp: false, hasKey: false, shell: inShellHost() }), 4200); }
  llmReadCfg();
  const c = LLM.cfg || {};
  /* 额度在打开时算一次就够：这一屏里每发一轮都会重开一次 openLlm()。 */
  const used = llmUsed();
  const bg = llmBudget(used);
  const run = LLM.phase === "running";
  /* 协议形制（v67 · R1）：Responses 走 /responses（input + instructions），
     Chat Completions 走 /chat/completions（messages[]）—— OpenAI 兼容网关多半是后者。
     两种请求体都由原生侧拼（LlmBridge.ask），页面只交这一个选择：
     同一个形状两处各写一遍迟早对不上，而对不上的那一份是花钱的请求。 */
  const canStyle = llmCanStyle();
  const style = c.apiStyle === "chat" ? "chat" : "responses";
  /* 重试只在「这一轮失败了」时出现。拿到答案的那轮不给重试 —— 再发一次同样的话
     只是再花一次钱，要接着问就走输入框，那一发是新的一个问题。 */
  const retryable = !run && !!LLM.turn && ["error", "timeout", "cancelled"].includes(LLM.phase);
  const btn = run ? "等待中…"
    : (!bg.ok ? "已到 " + LLM_MAX_ROUNDS + " 轮上限"
      : (used ? "问下一句（已用 " + used + "/" + LLM_MAX_ROUNDS + " 轮）" : "发起（本会话最多 " + LLM_MAX_ROUNDS + " 轮）"));
  openSheet(`<div class="sheet-t"><h3>模型接入</h3><button class="x" onclick="closeSheet()">✕</button></div>
    ${llmStatusLine()}
    <div class="card-t" style="margin:14px 0 6px"><h2 style="font-size:14px">端点与模型</h2>
      <span class="hint">存原生侧，不进 localStorage</span></div>
    <div class="field"><label>端点（填 https 的 /v1 根地址）</label>
      <input id="llmBase" placeholder="https://api.example.com/v1" value="${esc(c.baseUrl || "")}"></div>
    <div class="field"><label>模型名</label>
      <input id="llmModel" placeholder="例如 gpt-4o-mini" value="${esc(c.model || "")}"></div>
    ${canStyle ? `<div class="field"><label>协议形制（决定请求体与路径）</label>
      <select id="llmStyle">
        <option value="responses" ${style === "responses" ? "selected" : ""}>Responses · /responses</option>
        <option value="chat" ${style === "chat" ? "selected" : ""}>Chat Completions · /chat/completions（OpenAI 兼容网关）</option>
      </select></div>`
      : `<div class="cap" style="padding-top:2px">这台机器的 App 还不支持换协议（更新 App 之后这一项才会出现），现在只能按 Responses 形制发。</div>`}
    <div class="chk-row"><label><input type="checkbox" id="llmSearch" ${c.search === false ? "" : "checked"}>
      要求端点做联网检索</label></div>
    <div class="cap" style="padding-top:2px">出处就从检索里来；关掉它多半一条来源都拿不到。</div>
    <div class="row-btn" style="margin-top:2px">
      <button class="btn gh" style="flex:1" onclick="llmSaveCfg()">保存端点</button>
      <button class="btn gh" style="flex:1" onclick="llmClearKey()">清除密钥</button>
    </div>
    <div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">接着问</h2>
      <span class="hint">答案不自动入账 · 已发 ${used}/${LLM_MAX_ROUNDS} 轮</span></div>
    <div class="chk-row"><label><input type="checkbox" id="llmData" ${LLM.withData ? "checked" : ""}
      onchange="llmDataToggle()"> 这一轮带上我的台账</label></div>
    ${llmSnapLine()}
    ${llmHistoryHtml()}
    <div class="field" style="margin-top:10px"><textarea id="llmQ" rows="3" placeholder="接着上一轮问，或换个新问题">${esc(LLM.q)}</textarea></div>
    <div class="row-btn" style="margin-top:8px">
      <button class="btn pri" style="flex:1" onclick="llmAsk()">${btn}</button>
    </div>
    ${run ? `<div class="row-btn" style="margin-top:6px"><button class="btn gh" style="flex:1" onclick="llmCancel()">取消这一轮（不再等 · 已发出的那一发撤回不了）</button></div>` : ""}
    ${retryable ? `<div class="row-btn" style="margin-top:6px"><button class="btn gh" style="flex:1" onclick="llmRetry()">重试这一轮（原句再发一次，另占一轮额度）</button></div>` : ""}
    ${LLM.costWarn ? `<div class="note r" style="margin-top:8px">这一句发出去就是<b>一次新的计费</b>；
      上一轮如果已经到端点，那一次也算 —— 代码不会自己重发，重发只由你点。</div>` : ""}
    <div id="llmOut" style="margin-top:10px">${llmResultHtml()}</div>
    ${used ? `<div class="row-btn" style="margin-top:10px"><button class="btn gh" style="flex:1" onclick="llmClearChat()">清空上文（重新计数）</button></div>` : ""}
    <div class="cap" style="padding:12px 0 0">
      原生侧只负责发请求与回原文，解析与来源分级全在页面里（js/domain/llm.js，有测试）。
      上文只在<b>这台机器的内存</b>里：不写本机存储、不推云端，刷新就没了。
      勾上「带上我的台账」才把数据发出机器：只带那十个字段（名称 / 机构 / 代码 / 风险级 / 净值与它的日期 /
      份额 / 成本 / 持有天数 / 状态），本机开着「隐藏金额」时份额与成本也跟着藏；不勾就是一句光的问题。
      发满 ${LLM_MAX_ROUNDS} 轮就停手（失败与超时的那几轮也算），要接着问得先清空 —— 闸门拦的是连着点、连着计费。
      请求体按上面选的协议形制拼（Responses 带 web_search_preview，Chat Completions 带 web_search），
      路径也跟着换 —— <b>沙箱里没有凭据，真实端点仍未实测</b>：
      认不得就明说认不得，不补字段、不自动重发。
    </div>`);
}
/** 发一轮。要发的话由调用方给：新问从输入框取，重试把上一轮那句原样再给一次。
    顺序是「先闸门后动手」：额度到数就连一个字符都不该发出去，不是等请求做完才提示。 */
function llmSend(text) {
  const b = llmBridge();
  if (!b) return toast(llmDegrade({ inApp: false, hasKey: false, shell: inShellHost() }), 4200);
  if (LLM.phase === "running") return toast("上一句还在等，不重复发（重复发就是重复计费）", 3600);
  /* 额度先于空文本：到数的时候，用户点下去要听见的是「为什么不能再发」，
     而不是「先写一句要问的话」——那句在这屏上是假话，框里写什么都一样。 */
  const bg = llmBudget(llmUsed());
  if (!bg.ok) return toast(bg.why, 6000);
  const q = String(text == null ? "" : text).trim();
  if (!q) return toast("先写一句要问的话", 2600);
  if (!LLM.hasKey || !(LLM.cfg && LLM.cfg.baseUrl)) return toast(llmDegrade({ inApp: true, hasKey: LLM.hasKey }) || "先配端点", 4200);
  /* 上一轮落进上文 —— 成 / 败 / 超时都算一轮，失败那轮多半已经到过端点。 */
  if (LLM.turn) { LLM.turns.push(LLM.turn); LLM.turn = null; }
  LLM.costWarn = llmCanRetry(LLM);
  LLM.phase = "running"; LLM.res = null; LLM.err = ""; LLM.meta = null; LLM.buf = null;
  LLM.turn = { q, a: "", err: "", sources: [], dropped: [], shape: "", usage: { input: 0, output: 0 } };
  LLM.q = "";                 /* 输入框清空：发出去的那句已经在「第 N 轮 · 问」那一行上 */
  LLM.id = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  /* 计时器和提示说的是同一个数：到 LLM_TIMEOUT_MS 就落「超时」，不加缓冲。
     原生侧的整体预算（110 秒）比它小，所以真超时是那边先断、这边兜住没收到回调的情况。 */
  const dead = setTimeout(() => llmTimeout(LLM.id), LLM_TIMEOUT_MS);
  LLM.timer = dead;
  try {
    /* 快照在勾了的时候才拼 —— 没勾，发出去的就是光的一句问题。 */
    const snap = LLM.withData ? llmSnapText() : "";
    b.ask(LLM.id, JSON.stringify(llmReq({
      input: llmRoundInput(LLM.turns, q, snap),
      instructions: "回答只依据这条消息里给出的台账快照与上文；没给到的信息就说没给到，不要编；"
        + "没有可核实出处的结论要直说是推测。",
    })));
  } catch (e) {
    clearTimeout(dead); LLM.timer = 0; LLM.phase = "error"; LLM.err = "桥调用失败：" + e;
    LLM.turn.err = "桥调用失败：" + e;
  }
  openLlm();
}
function llmAsk() { const el = $("llmQ"); llmSend(el ? String(el.value || "") : LLM.q); }
/** v76 · 取消这一轮。口径三条，一条都不能少：
 *   1) 这是「不再等」，不是「撤回」—— 请求早就发出去了，这一发该不该计费由端点说了算，
 *      屏上只说「可能已经计费」（铁律 #10：不替用户编一个确定的数）。
 *   2) 取消之后 LLM.id 立刻清空：壳那边如果已经读完响应，回传的 __llmDone/__llmChunk
 *      会因为 id 对不上被丢掉，不会把「已取消」的一轮又翻成答案（也不翻成失败）。
 *   3) 代码路径里没有任何地方自己再 ask() 一遍（铁律 #5）；要重试得人点那颗按钮。
 *   桥不在（网页版）时压根没有这颗按钮 —— 网页版本来就发不出去，也就没什么可取消的。 */
function llmCancel() {
  if (LLM.phase !== "running") return toast("这一轮已经落定了，没有要取消的东西", 3000);
  const id = LLM.id, b = llmBridge();
  if (LLM.timer) { clearTimeout(LLM.timer); LLM.timer = 0; }
  LLM.id = "";                     /* 先把自己那把锁摘了：迟到的回传一律不认 */
  LLM.phase = "cancelled"; LLM.res = null; LLM.err = ""; LLM.buf = null; LLM.meta = null;
  if (LLM.turn) LLM.turn.err = LLM_CANCEL_TEXT;   /* 上文里下一轮看得见：这一轮是人停的，不是模型答的 */
  if (b && b.cancel) { try { b.cancel(id); } catch (e) { /* 原生没接上也只是继续断开连接，屏上的话不变 */ } }
  openLlm();
  toast("已取消这一轮（不再等它，但那一发可能已经计费）", 4200);
}
/** 重试 = 把上一轮（连同它那次失败）记进上文，再原样发一次同一个问题。
    它占一轮额度：这一发又是一次真实计费，不该当成「免费再来一次」。 */
function llmRetry() {
  if (!LLM.turn || !LLM.turn.q) return toast("这一会话里没有可重试的一轮", 3200);
  llmSend(LLM.turn.q);
}
/** 清空上文 = 轮次额度一起归零。这是唯一能越过 LLM_MAX_ROUNDS 的路，所以只能由人点。 */
function llmClearChat() {
  if (LLM.phase === "running") return toast("这一轮还在等，先等它落定再清", 3200);
  const n = llmUsed();
  if (!n) return toast("上文本来就是空的", 2200);
  LLM.turns = []; LLM.turn = null; LLM.res = null; LLM.err = "";
  LLM.phase = "idle"; LLM.costWarn = false; LLM.buf = null; LLM.meta = null;
  openLlm();
  toast("已清空上文（" + n + " 轮的额度也重新计数了）", 3400);
}
function llmTimeout(id) {
  if (LLM.phase !== "running" || LLM.id !== id) return;
  LLM.phase = "timeout"; LLM.err = ""; LLM.buf = null;
  /* 超时这一轮写进上文时带的是「没回」，不是空字符串 —— 下一轮的模型看得见上一轮没答上。 */
  if (LLM.turn) LLM.turn.err = "等满 " + Math.round(LLM_TIMEOUT_MS / 1000) + " 秒没回（这一次可能已经计费）";
  openLlm();
}
/* 原生回传的两个全局函数：名字与 LlmBridge.java 里拼的 JS 必须逐字一致，
   scripts/verify-web.sh 第 3 项就是比对这个（对不上是「点了没反应」，构建不会红）。 */
window.__llmChunk = function (id, seq, total, text) {
  if (!id || String(id) !== LLM.id || LLM.phase !== "running") return;   /* 迟到的一律丢，别串到下一轮 */
  const r = llmChunkFeed(LLM.buf, Number(seq), Number(total), String(text == null ? "" : text));
  LLM.buf = r.st;
  if (r.error) {
    LLM.phase = "error"; LLM.err = "分块组装失败：" + r.error;
    if (LLM.turn) LLM.turn.err = LLM.err;
    openLlm();
  }
};
window.__llmDone = function (id, metaJson) {
  if (!id || String(id) !== LLM.id) return;
  if (LLM.timer) { clearTimeout(LLM.timer); LLM.timer = 0; }
  if (LLM.phase !== "running") return;                 /* 已经按超时落定：迟到的答案不再翻案 */
  /* 「元信息用不了」有四样，v69 起分开说（读法与文案都挪到 js/domain/llm.js，有单测）。
     上一版一句话兜底：壳回的是对象而不是 JSON 字符串（1.0.220 及之前每轮都这样），
     屏上却写「原生侧没回元信息」—— 把「参数类型不一致」说成「没回」，排查方向直接被带歪，
     还会让人以为是自己端点或密钥配错了。两侧回调名字对得上（verify-web 第 2f 项一直绿），
     对不上的是类型，所以这一次连类型也钉进 check_bridge_guard.py 第 6 项。 */
  const rd = llmMetaOf(metaJson);
  const meta = rd.meta;
  const body = LLM.buf ? llmChunkJoin(LLM.buf) : "";
  LLM.meta = meta;
  if (!meta || !meta.ok) {
    LLM.phase = "error";
    LLM.err = llmMetaErr(meta, rd.why, body.length);
    if (meta && meta.status) LLM.err += "（HTTP " + meta.status + "）";
    LLM.buf = null;
    if (LLM.turn) LLM.turn.err = LLM.err;              /* 失败也进上文：下一轮得知道上一轮没答上 */
    openLlm(); return;
  }
  let obj = null;
  try { obj = JSON.parse(body); } catch (e) { obj = null; }
  const res = llmParse(obj);
  LLM.phase = res.ok ? "done" : "error";
  LLM.res = res;
  LLM.err = res.ok ? "" : (res.error || "响应里没有正文");
  LLM.buf = null;
  if (LLM.turn) {
    /* 落进上文的是「问 + 答的正文」，来源与 token 数只给人看，不进模型的那段文本。 */
    LLM.turn.a = res.text;
    LLM.turn.err = res.ok ? "" : LLM.err;
    LLM.turn.sources = res.sources;
    LLM.turn.dropped = res.dropped;
    LLM.turn.shape = res.shape;
    LLM.turn.usage = res.usage;
  }
  openLlm();
};
/* 原生侧改完配置 / 密钥后叫这一下，页面重读一次再重画。
   msg 非空是原生在回一句话（多半是「这次没保存」），不显示出来用户只会觉得点了没反应。 */
window.__llmCfg = function (msg) {
  const m = String(msg == null ? "" : msg);
  llmReadCfg();
  renderLlm();
  const s = $("mask");
  if (s && s.classList.contains("show")) openLlm();
  if (m) toast(m, 4200);
};

/* 粘贴内容 → 产品键：纯函数已拆到 js/core/paste.js（可被 node --test 直接测）。
   这里只保留依赖 DATA / DOM 的去重、预览与落库。 */

/* 产品显示名：链接添加的骨架产品名称是空的（留给云端回填），列表要有兜底 */
function prodLabel(p) {
  if (!p) return "未命名产品";
  return p.name || p.code || p.prodCode || "未命名产品";
}
/* 同代码去重 */
function findDupProduct(r) {
  const c = String(r.code || "").toUpperCase(), pc = String(r.prodCode || "").toUpperCase();
  return DATA.products.find(p =>
    (c && String(p.code || "").toUpperCase() === c) ||
    (pc && String(p.prodCode || "").toUpperCase() === pc)) || null;
}

function openLinkAdd() {
  openSheet(`<div class="sheet-t"><h3>粘贴添加产品</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      把<b>产品页面链接</b>（银行 App / 微信里复制的那条）粘进来即可。<b>一行一只，可以一次贴很多行。</b><br>
      链接里带产品代码或登记编码时自动识别；若贴的是公众号文章之类的链接，
      请把<b>登记编码</b>或<b>产品代码</b>一并贴上。只有代码时<b>让它单独占一行</b>
      （如 <b>25112035B</b>），和别的文字混在一行时可能认不出来。
    </div>
    <div class="field"><label>粘贴链接 / 代码 / 含代码的文本（可多行）</label>
      <textarea id="lkInput" rows="5" oninput="previewLink()" placeholder="每行一只产品，例如：&#10;https://…?PROD_CODE=YJ01251204A&#10;https://…?prodRegCode=Z7008926000006&#10;25112035B（二维码里的产品代码，单独一行）"
        style="width:100%;padding:11px 12px;border:1.5px solid var(--line);border-radius:11px;font-size:13px;font-family:inherit;color:var(--ink);outline:none;resize:vertical"></textarea>
    </div>
    <button class="btn gh full" onclick="qrPick()">📱 扫二维码添加（微众分享海报）</button>
    <input type="file" id="qrFile" accept="image/*" style="display:none" onchange="qrShot(this)">
    <div class="tip">在微众 App 产品页点「分享」生成海报，截图后在这里选图：二维码里带着该产品的销售代码，本机解开后自动反查发行方并填好机构，图片不上传。</div>
    <div id="lkPreview"></div>
    <div class="field"><label>产品名称 <span class="muted">（可留空，云端抓到后自动补全；多行粘贴时不套用）</span></label>
      <input id="lkName" placeholder="留空即可">
    </div>
    <div class="field"><label>发行机构 <span class="muted">（识别不出机构的行靠它兜底）</span></label>
      <input id="lkInst" placeholder="如 北银理财有限责任公司" oninput="previewLink()">
      <div class="tip">云端靠这个字段选数据源：填理财公司全名（含「理财」即可），识别出代码时会自动补上</div>
    </div>
    <div class="row-btn">
      <button class="btn gh" style="flex:1" onclick="closeSheet()">取消</button>
      <button class="btn pri" style="flex:1" id="lkSave" onclick="saveFromLink()">确认添加</button>
    </div>`);
  UI.linkParsed = null; UI.linkRows = null;
  previewLink();
}

/* 多行粘贴：每行当一个产品解析，**每行都有结果**（不认识的不会被静默丢掉）。
   单行仍走原来那套更详细的说明，老用户看到的东西不变。
   ★ 批内同码也要标成 dup：预览算「可添加几只」时如果只看 DATA、不看本批，
     两行相同的代码会被数成 2 只，而保存循环里的 findDupProduct 只会落 1 只
     （2026-10-30 审计抓到的不同源）。 */
function parseProductLines(text) {
  const rows = [];
  const seen = new Map();           /* 本批已出现的产品键 -> 首次出现的行号 */
  String(text == null ? "" : text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const r = parseProductInput(line);
    if (!r.ok) { rows.push({ ln: i + 1, raw: line, r, status: "bad", key: "", note: r.msg }); return; }
    const key = (r.prodCode || r.code || "").toUpperCase();
    const dup = findDupProduct(r);
    const twin = key && seen.get(key);
    if (key && !seen.has(key)) seen.set(key, i + 1);
    rows.push({
      ln: i + 1, raw: line, r,
      status: (dup || twin) ? "dup" : "add",
      key: r.prodCode || r.code,
      inst: ORG_NAME[r.org] || "",
      note: dup ? `已存在「${prodLabel(dup)}」`
        : twin ? `与本批第 ${twin} 行同码，只加一次`
        : (ORG_NAME[r.org] || (r.code ? "有登记编码，机构可留空（中国理财网按编码取）"
          : "机构未识别：云端会先拿代码去微众/网商货架反查，查到就能取净值；"
            + "查不到则要手填发行机构，并补登记编码（Z 开头）")),
    });
  });
  return rows;
}

/* 按钮文案跟着预览走：写「确认添加 N 只」就只会加这 N 只。
   why：一只都加不了时说明原因（缺机构、已存在），别让用户点下去才知道。 */
function setLinkSave(n, why) {
  const b = $("lkSave"); if (!b) return;
  b.textContent = n ? `确认添加 ${n} 只` : (why || "没有可添加的产品");
  b.disabled = !n;
}

function previewLink() {
  const box = $("lkPreview"); if (!box) return;
  const text = $("lkInput") ? $("lkInput").value : "";
  const rows = parseProductLines(text);
  UI.linkRows = rows;
  const single = rows.length === 1 ? rows[0] : null;
  UI.linkParsed = single ? single.r : parseProductInput(text);
  const instEl = $("lkInst");
  /* 单行时把识别出的机构自动补上；多行不自动填 —— 各家机构不同，填一个是误导。
     ★ 机构必须落进 inst：云端 detect_org 靠它判机构（见本段顶部契约说明） */
  if (single && single.inst && instEl && !instEl.value.trim()) instEl.value = single.inst;

  if (!rows.length) {
    setLinkSave(0);
    box.innerHTML = `<div class="note" style="margin-bottom:12px">${esc(UI.linkParsed.msg || "请粘贴产品链接、产品代码或登记编码")}</div>`;
    return;
  }
  if (single) {
    const r = single.r;
    /* 认不出的一行不能被算成「可添加 1 只」：以前按钮写「确认添加 1 只」、点下去才
       toast「没有可添加的产品」—— 扫微众海报（华夏销售码 25112035B，形态表不认）
       踩到的就是这条。现在解析层已收裸码，这里再兜一道，两者不一致时以「不可加」为准。 */
    if (single.status === "bad") {
      box.innerHTML = `<div class="note" style="margin-bottom:12px">${esc(r.msg || "这一行没认出产品代码或登记编码")}</div>`;
      setLinkSave(0);
      return;
    }
    const dup = single.status === "dup" ? findDupProduct(r) : null;
    /* 机构：形态识别出来的优先，其次取用户在下方「发行机构」栏填的（扫码那条会先填好） */
    const manual = (instEl || {}).value ? String(instEl.value).trim() : "";
    const inst = (r.org && (ORG_NAME[r.org] || r.org)) || manual;
    /* 能不能真加，判据要和 saveFromLink **同一个函数**（js/core/paste.js rowAddable）：
       有机构 / 有登记编码 / 整行裸码 三者之一才放行 —— 按钮不能承诺了再拒绝。 */
    const canAdd = !dup && rowAddable(r, manual);
    const parts = [];
    if (r.code) parts.push(`登记编码 <b>${esc(r.code)}</b>`);
    if (r.prodCode) parts.push(`产品代码 <b>${esc(r.prodCode)}</b>`);
    if (inst) parts.push(`发行机构 <b>${esc(inst)}</b>`);
    box.innerHTML = `<div class="note${dup ? "" : " g"}" style="margin-bottom:12px">
      ${parts.join(" · ")}<br>
      ${dup ? `⚠️ 已存在同代码产品「${esc(prodLabel(dup))}」，无需重复添加`
        : (r.code ? "保存后同步到云端，下一次抓取自动补全产品名称与历史净值。"
          : (inst
            ? "没有登记编码也能抓：云端按「产品代码 + 发行机构」选源，"
              + "在微众/网商货架上的产品还会直接按代码取现值。抓不到时再补登记编码（Z 开头）。"
            : (r.bare
              ? "机构栏留空也能试：云端先拿这个代码去微众/网商货架目录（454 只）反查发行方，"
                + "查到就直接取净值；反查不到再来补「发行机构」或登记编码（Z 开头）。"
              : "⚠️ 机构栏还空着：请在下方「发行机构」填理财公司全名（如「华夏理财」），"
                + "或补登记编码（Z 开头）—— 两个都没有，云端会以「无法识别机构」跳过这只。")))}
    </div>`;
    setLinkSave(canAdd ? 1 : 0, dup ? "已在台账里" : "先填发行机构");
    return;
  }
  const c = { add: 0, dup: 0, bad: 0 };
  rows.forEach(x => { c[x.status] = (c[x.status] || 0) + 1; });
  /* 多行：机构栏是「兜底」用的，填了就对所有缺机构的行生效；
     判据与保存端同一个函数，且批内同码只算一只（见 parseProductLines） */
  const manualM = (instEl || {}).value ? String(instEl.value).trim() : "";
  const nAdd = rows.filter(x => x.status === "add" && rowAddable(x.r, manualM)).length;
  const nBlocked = rows.filter(x => x.status === "add").length - nAdd;
  box.innerHTML = `<div class="note${nAdd ? " g" : ""}" style="margin-bottom:12px">
      <b style="color:var(--brand)">${nAdd}</b> 只可添加&nbsp;&nbsp;
      <b style="color:var(--ink3)">${c.dup}</b> 只已存在&nbsp;&nbsp;
      <b style="color:var(--gold)">${c.bad}</b> 行无法识别
      ${nBlocked ? `&nbsp;&nbsp;<b style="color:var(--gold)">${nBlocked}</b> 只缺机构/编码` : ""}
    </div>
    <div style="max-height:200px;overflow:auto"><table class="navtbl">
      <thead><tr><th>产品键</th><th style="text-align:left">机构 / 说明</th></tr></thead>
      <tbody>${rows.slice(0, 40).map(x => `<tr>
        <td>${esc(x.key || "—")}</td>
        <td style="text-align:left;font-size:11px;color:var(${x.status !== "add" || !rowAddable(x.r, manualM) ? "--gold" : "--ink3"})">${esc(x.note)}</td>
      </tr>`).join("")}</tbody></table></div>
    ${rows.length > 40 ? `<div class="muted" style="font-size:11px;padding:6px 0">只显示前 40 行（共 ${rows.length} 行）</div>` : ""}`;
  setLinkSave(nAdd, nBlocked ? "先填发行机构" : "");
}

function saveFromLink() {
  if (!$("mask").classList.contains("show")) return;   /* 防快速双击重复添加 */
  /* 用预览时那份解析结果 —— 按钮上写多少只，就只加多少只 */
  const rows = UI.linkRows || parseProductLines($("lkInput") ? $("lkInput").value : "");
  const manualInst = ($("lkInst").value || "").trim();
  /* 能落库的行 = 预览里算「可添加」的那些：两边调的是同一个 rowAddable
     （js/core/paste.js），批内同码也已在 parseProductLines 标成 dup。
     剩下只有链接里一个 prodCode 参数、又认不出发行方的仍然挡住 —— 货架反查
     不到的就是一条永远抓不到净值的空记录，不如让用户先补一项。 */
  const adds = rows.filter(x => x.status === "add" && rowAddable(x.r, manualInst));
  if (!adds.length) {
    const dupN = rows.filter(x => x.status === "dup").length;
    const needInst = rows.filter(x => x.status === "add").length;
    return toast(dupN ? `已存在的 ${dupN} 只无需重复添加`
      : (needInst ? `还有 ${needInst} 只认不出发行机构：在「发行机构」栏填理财公司全名（如 招银理财），或补登记编码（Z 开头）`
        : "没有可添加的产品"), 4600);
  }
  const name = ($("lkName").value || "").trim();     /* 允许留空：留给云端 merge_nav 回填 */
  let ok = 0;
  for (const x of adds) {
    const inst = x.inst || manualInst;
    if (findDupProduct(x.r)) continue;               /* 同一批里重复的代码，第二条在这里被挡下 */
    DATA.products.push({
      id: uid(), navHistory: {}, createdAt: Date.now(),
      code: x.r.code || "", prodCode: x.r.prodCode || "",
      name: rows.length === 1 ? name : "",           /* 多行粘贴不套用同一个名称 */
      inst, fromLink: true,
    });
    ok++;
  }
  if (!ok) return toast("这些代码已经在台账里了", 3600);
  saveLocal(); closeSheet();
  if (rows.length === 1 && ok === 1) {
    const st = fetchStatus(DATA.products[DATA.products.length - 1]);
    toast(`已添加${st.ok ? "，" + st.txt : "。" + st.txt}。云端抓取后会自动补全名称与净值`, st.ok ? 3200 : 4400);
  } else {
    const skipped = adds.length - ok;
    toast(`已添加 ${ok} 只` + (skipped ? `，跳过 ${skipped} 只（缺机构或已存在）` : "")
      + "。云端抓取后会自动补全名称与净值", 4400);
  }
  renderProd(); renderHome();
  autoPush();
}

/* ============================================================
   产品详情：单位净值曲线 + 叠加指标（7日年化 / 万份收益）
   ------------------------------------------------------------
   口径（与设置页「口径说明」一致，勿私下改）：
     · 万份收益(元) = (今日净值 − 上一披露日净值) × 10000
       （v68 起整段累计、不按自然日摊平：这样万收 × 份额 ÷ 10000 就等于当日盈亏。
         跨周末/长假那一格含整段涨跌，间隔天数由 st.gap 带出去，屏上要写明）
     · N 日年化     = (nav[t] ÷ N 个自然日前最近净值 − 1) ÷ N × 365
     · 成立以来年化 = (末值 / 首值 − 1) / 持有天数 × 365
   全部即时计算、不落盘。图表为内联 SVG 自绘，不引任何库/CDN。
   ============================================================ */
const PROD_RANGES = [["1m", "近1月", 30], ["3m", "近3月", 90], ["6m", "近6月", 180], ["1y", "近1年", 365], ["all", "成立来", 0]];

/* YYYY-MM-DD ± days（自然日），返回同格式 */
function dateShift(ymd, days) {
  const d = parseDate(ymd);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/* N 日年化序列（与净值序列等长对齐；基准 = N 个自然日前最近的一条披露净值。
   旧实现按「前 N 条披露」回退，工作日披露下 7 条 ≈ 9-10 天再 ÷7，年化系统性高估
   约 30% —— 2026-09-15 审查修正为自然日锚定。样本不足处 null，绝不伪造。） */
function annualNArr(dates, vals, n) {
  return vals.map((v, i) => {
    if (i < n) return null;
    const bd = dateShift(dates[i], -n);
    let base = null;
    for (let j = i; j >= 0; j--) {
      if (dates[j] <= bd) { base = Number(vals[j]); break; }
    }
    return base > 0 ? (v / base - 1) / n * 365 : null;
  });
}
/* 一组净值指标（全部与 vals 等长对齐） */
function navStats(p) {
  const s = navSeries(p);
  const dates = s.map(x => x[0]);
  const vals = s.map(x => Number(x[1]));
  /* v68 口径变更（用户定）：万份收益 = (今 − 上一披露日) × 10000，整段累计，不按自然日摊平。
     理由是可对账：万收 × 份额 ÷ 10000 恒等于当日盈亏，详情页、收益明细、盈亏三处一把尺子；
     旧口径摊平之后谁都对不上谁（诚享7天29号 2026-11-02：摊平 −3.8967 / 明细 −11.53 / 盈亏 −80.92）。
     ★ 代价照实写：跨周末或长假的那一格含整段涨跌，周一的万收是几天累计 —— 这是选择，不是遗漏。
     gap 把间隔自然日数一起带出去，屏上必须写明本段几天，不许让人以为是一天的数。 */
  const wan = vals.map((v, i) => (i === 0 ? null : (v - Number(vals[i - 1])) * 10000));
  const gap = dates.map((d, i) => (i === 0 ? null : Math.max(dayDiff(dates[i - 1], d), 1)));
  return { dates, vals, wan, gap, a7: annualNArr(dates, vals, 7), a14: annualNArr(dates, vals, 14), a30: annualNArr(dates, vals, 30) };
}
/* 成立以来年化（单一数值） */
function sinceAnnual(stats) {
  const { dates, vals } = stats;
  if (vals.length < 2) return null;
  const a = Number(vals[0]), b = Number(vals[vals.length - 1]);
  const days = dayDiff(dates[0], dates[dates.length - 1]);
  if (!(a > 0) || days <= 0) return null;
  return (b / a - 1) / days * 365;
}
/* 末位有效值（叠加指标可能末端为 null） */
function lastNum(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && isFinite(arr[i])) return arr[i];
  return null;
}

/* 内联 SVG 双轴折线图：vals 走左轴（净值），ov 走右轴（叠加指标） */
/* 纵轴标签格式化：净值图用四位小数（默认），月报的累计收益用元。
   fmt 由调用方传入，且必须是「已经遮过」的文本 —— 画图这一层不认识钱。 */
function svgChart(dates, vals, ov, fmt) {
  const W = 640, H = 230, L = 50, R = 58, T = 16, B = 26;
  const lab = fmt || (v => v.toFixed(4));
  const iw = W - L - R, ih = H - T - B;
  const n = vals.length;
  if (!n) return `<div class="empty">该区间内没有净值数据</div>`;
  let nMin = vals[0], nMax = vals[0];
  for (const v of vals) { if (v < nMin) nMin = v; if (v > nMax) nMax = v; }
  const span = (nMax - nMin) || Math.max(nMax * 0.004, 0.0008);
  const lo = nMin - span * 0.18, hi = nMax + span * 0.18;
  const Yn = v => T + (1 - (v - lo) / (hi - lo)) * ih;
  const X = i => (n === 1 ? L + iw / 2 : L + i / (n - 1) * iw);

  /* 叠加序列的右轴域（必须含 0，否则看不出正负） */
  let oLo = 0, oHi = 0, hasOv = false, Yo = () => T;
  if (ov) {
    let mn = Infinity, mx = -Infinity, cnt = 0;
    for (const v of ov) if (v !== null && isFinite(v)) { cnt++; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (cnt >= 2) {
      hasOv = true;
      oLo = Math.min(0, mn); oHi = Math.max(0, mx);
      if (oHi - oLo < 1e-9) oHi = oLo + 1;
      Yo = v => T + (1 - (v - oLo) / (oHi - oLo)) * ih;
    }
  }
  const navPts = [];
  for (let i = 0; i < n; i++) navPts.push(X(i).toFixed(1) + "," + Yn(vals[i]).toFixed(1));
  const area = `${L},${(T + ih).toFixed(1)} ` + navPts.join(" ") + ` ${(L + iw).toFixed(1)},${(T + ih).toFixed(1)}`;

  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" style="display:block">`;
  g += `<polygon points="${area}" fill="rgba(91,91,214,.10)" stroke="none"/>`;
  if (hasOv) {
    const op = [];
    for (let i = 0; i < n; i++) {
      const v = ov[i];
      if (v === null || !isFinite(v)) continue;
      op.push(X(i).toFixed(1) + "," + Yo(v).toFixed(1));
    }
    if (oLo < 0 && oHi > 0) {
      const y0 = Yo(0).toFixed(1);
      g += `<line x1="${L}" y1="${y0}" x2="${L + iw}" y2="${y0}" stroke="#d9dbe6" stroke-width="0.8" stroke-dasharray="3 3"/>`;
    }
    g += `<polyline points="${op.join(" ")}" fill="none" stroke="#f0a020" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  g += `<polyline points="${navPts.join(" ")}" fill="none" stroke="#5b5bd6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += `<circle cx="${X(n - 1).toFixed(1)}" cy="${Yn(vals[n - 1]).toFixed(1)}" r="3" fill="#5b5bd6"/>`;
  /* 左轴：净值 */
  g += `<text x="${L - 8}" y="${T + 4}" text-anchor="end" font-size="10" fill="#9aa0bb">${lab(nMax)}</text>`;
  g += `<text x="${L - 8}" y="${T + ih}" text-anchor="end" font-size="10" fill="#9aa0bb">${lab(nMin)}</text>`;
  /* 右轴：叠加指标 */
  if (hasOv) {
    g += `<text x="${L + iw + 8}" y="${T + 4}" font-size="10" fill="#e08b00">${oHi.toFixed(2)}</text>`;
    g += `<text x="${L + iw + 8}" y="${T + ih}" font-size="10" fill="#e08b00">${oLo.toFixed(2)}</text>`;
  }
  /* 横轴日期 */
  g += `<text x="${L}" y="${H - 8}" font-size="10" fill="#9aa0bb">${esc(dates[0].slice(5))}</text>`;
  g += `<text x="${L + iw}" y="${H - 8}" text-anchor="end" font-size="10" fill="#9aa0bb">${esc(dates[n - 1].slice(5))}</text>`;
  g += `</svg>`;
  return g;
}

/* ---------- 详情页 ---------- */
const PROD_OVS = [["a7", "7日年化"], ["a14", "14日年化"], ["wan", "万份收益"], ["none", "不叠加"]];

function openProdDetail(pid) {
  const p = DATA.products.find(x => x.id === pid);
  if (!p) return toast("产品不存在");
  UI.viewProd = pid;
  UI.switchTo = "";
  if (!UI.prodRange) UI.prodRange = "3m";
  if (!UI.prodOv) UI.prodOv = "a7";
  renderProdDetail();
}
function setProdRange(btn, r) {
  if (btn) { btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("on")); btn.classList.add("on"); }
  UI.prodRange = r; renderProdDetail();
}
function setProdOv(btn, o) {
  if (btn) { btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("on")); btn.classList.add("on"); }
  UI.prodOv = o; renderProdDetail();
}
/* 换仓比较的对象：只改这一屏的状态，不写账本 —— 选了哪一只不是用户的事实数据，
   下一次进详情应当从「没选」开始（见 openProdDetail 里跟着 viewProd 一起复位）。 */
function setSwitchTarget(sel) {
  UI.switchTo = sel && sel.value ? String(sel.value) : "";
  renderProdDetail();
}
function renderProdDetail() {
  const p = DATA.products.find(x => x.id === UI.viewProd);
  if (!p) return;
  const st = navStats(p);
  const pos = position(p);
  const n = st.dates.length;

  /* 区间裁剪：先算完整序列（7日年化需要前 7 个点），再切区间 */
  const rng = PROD_RANGES.find(x => x[0] === UI.prodRange) || PROD_RANGES[1];
  const cut = rng[2] ? rangeStartDate(rng[2]) : "";
  let i0 = 0, inRange = true;
  if (cut) {
    const k = st.dates.findIndex(d => d >= cut);
    if (k < 0) { inRange = false; i0 = n - 1; } else i0 = k;
  }
  const ovKey = UI.prodOv;
  const ovArr = ovKey === "a7" ? st.a7 : ovKey === "a14" ? st.a14 : ovKey === "wan" ? st.wan : null;
  const ovName = (PROD_OVS.find(x => x[0] === ovKey) || [])[1] || "";
  const ovUnit = ovKey === "wan" ? "元/万份" : "%";

  const latest = n ? st.vals[n - 1] : null;
  const latestDate = n ? st.dates[n - 1] : "";
  const wan = lastNum(st.wan), a7 = lastNum(st.a7), a14 = lastNum(st.a14), a30 = lastNum(st.a30);
  const gap = lastNum(st.gap);               /* 最新这一格跨了几个自然日（v68：万收整段累计，屏上要写明） */
  const since = sinceAnnual(st);
  const src = navSrcInfo(p);                 /* 上次抓取的双源比对结果（官网 vs 中国理财网） */
  const stale = navStaleInfo(p);             /* 按交易日算的滞后（≥2 个交易日才提示） */
  const navFmt = v => (v === null ? "—" : Number(v).toFixed(4));
  const pctFmt = v => (v === null ? "—" : `${v >= 0 ? "+" : ""}${pct(v)}`);

  /* 历史净值表：末 20 行。万份收益直接取 st.wan[i] —— 和上面那张卡片的「万份收益（最新）」
     是同一个数组的末位，不在这儿另算一遍（v68 那条「整段累计、不摊平」的口径只允许存在一处：navStats）。
     间隔 >1 个自然日的那一行在后面标出跨几天，免得被读成当日收益。 */
  const rows = [];
  for (let i = n - 1; i >= 0 && rows.length < 20; i--) {
    const chg = i > 0 ? (st.vals[i] - st.vals[i - 1]) / st.vals[i - 1] : null;
    const w = st.wan[i];
    rows.push(`<tr>
      <td>${esc(st.dates[i].slice(5))}</td>
      <td><b>${navFmt(st.vals[i])}</b></td>
      <td class="${cls(chg === null ? 0 : chg)}">${chg === null ? "—" : pct(chg)}</td>
      <td class="${cls(w === null ? 0 : w)}">${wan2(w)}${st.gap[i] > 1 ? `<span class="cap">·${st.gap[i]}日</span>` : ""}</td>
      <td class="${cls(st.a7[i] === null ? 0 : st.a7[i])}">${st.a7[i] === null ? "—" : pct(st.a7[i])}</td>
    </tr>`);
  }

  const chartHtml = !n
    ? `<div class="empty">还没有净值数据。云端抓取后会自动补全，也可在「录入/查看净值」手工补录。</div>`
    : (!inRange
      ? `<div class="empty">所选的「${esc(rng[1])}」区间内没有净值</div>`
      : chartBlock(st, i0, ovArr, i0));

  openSheet(`<div class="sheet-t"><h3 style="font-size:15px">${esc(prodLabel(p))}</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="prow" style="border-top:0;padding-top:0">
      <div class="pn" style="font-size:12.5px">${esc(p.inst || "未填发行机构")}</div>
      <div class="pv"></div>
      <div class="pk">
        ${p.code ? `<i>登记编码 <b>${esc(p.code)}</b></i>` : ""}
        ${p.prodCode ? `<i>产品代码 <b>${esc(p.prodCode)}</b></i>` : ""}
        ${p.riskLevel ? `<i>风险等级 <b>${esc(p.riskLevel)}</b></i>` : ""}
        ${p.estDate ? `<i>成立日 <b>${esc(p.estDate)}</b></i>` : ""}
      </div>
    </div>
    ${src ? `<div class="tip" style="margin-top:8px">
      🔀 最新净值取自 <b>${esc(src.via)}·${esc(src.label)}</b>（${esc(src.latest)}）${esc(src.why ? "—— " + src.why : "")}
      ${(src.sources || []).length > 1
        ? `｜两条线已比对：${(src.sources || []).map(s => esc(`${s.label} ${s.latest || "—"}`)).join(" vs ")}`
        : "｜另一条线本次未取到，已用单源"}
      ${src.conflicts && src.conflicts.length
        ? `<br>⚠️ 与另一条线有 <b>${src.conflicts.length}</b> 处同日数值差异（已按上述来源取值），`
          + `如 ${esc(src.conflicts[0].d)}：采用 ${esc(String(src.conflicts[0].used))}`
        : ""}
    </div>` : ""}

    <div class="grid2" style="margin-top:12px">
      <div class="stat"><div class="l">最新净值${latestDate ? "（" + esc(latestDate.slice(5)) + "）" : ""}</div><div class="v" style="color:var(--brand)">${navFmt(latest)}</div><div class="cap">官方披露的份额净值</div></div>
      <div class="stat"><div class="l">万份收益（最新）</div><div class="v ${cls(wan === null ? 0 : wan)}">${wan4(wan)}</div><div class="cap">(今 − 上一披露日) × 10000 · 元/万份${gap > 1 ? ` · 本段 ${gap} 个自然日累计，未摊平` : ""}</div></div>
      <div class="stat"><div class="l">近7日年化</div><div class="v ${cls(a7 === null ? 0 : a7)}">${pctFmt(a7)}</div><div class="cap">7 日净值变动折算年化</div></div>
      <div class="stat"><div class="l">近14日年化</div><div class="v ${cls(a14 === null ? 0 : a14)}">${pctFmt(a14)}</div><div class="cap">14 日折算</div></div>
      <div class="stat"><div class="l">近1月年化</div><div class="v ${cls(a30 === null ? 0 : a30)}">${pctFmt(a30)}</div><div class="cap">30 日折算</div></div>
      <div class="stat"><div class="l">成立以来年化</div><div class="v ${cls(since === null ? 0 : since)}">${pctFmt(since)}</div><div class="cap">首末净值折算 · 全周期</div></div>
    </div>
    <div class="cap" style="padding:6px 0 0">样本不足时显示「—」，不估算、不补齐；净值型产品官方不披露万份收益与年化，以上均为本工具折算口径。</div>
    ${stale && nativeFetchAvailable()
      ? `<div class="tip" style="margin-top:6px">⏳ 公开渠道最新到 <b>${esc(stale.date)}</b>，此后已过 <b>${stale.lag}</b> 个交易日。${aixhubLoggedIn()
          ? `已登录<b>秒讯</b>：点「⚡ 立即抓取」会用它的数据（通常早上就有）；北银官网在开放日次日 11:00–15:00 才上传。`
          : `北银官网在开放日次日 11:00–15:00 上传净值（汇总表与公告表两张表都会查），App 在前台时每 3 分钟自动核对，上传后几分钟内就会补上。想在早上就看到，可到「设置 → 秒讯」登录（可选）。`}</div>`
      : stale
        ? `<div class="tip" style="margin-top:6px">⏳ 最新净值停在 <b>${esc(stale.date)}</b>，此后已过 <b>${stale.lag}</b> 个交易日。云端每个交易日都会抓；若持续不更新，先核对产品代码与发行机构是否正确。</div>`
        : ""}

    ${pos.shares > 0 ? `<div class="card-t" style="margin:14px 0 8px"><h2 style="font-size:14px">我的持仓</h2></div>
    <div class="grid2">
      <div class="stat"><div class="l">持有金额</div><div class="v">${shown(money(pos.market))}</div><div class="cap">已确认份额 × 最新净值</div></div>
      <div class="stat"><div class="l">持仓收益</div><div class="v ${tone(pos.profit)}">${shown(signMoney(pos.profit))}</div><div class="cap">市值 − 持仓成本</div></div>
      <div class="stat"><div class="l">持仓年化</div><div class="v ${pos.annualValid ? tone(pos.holdAnnual) : "muted"}" style="font-size:16px">${pos.annualValid ? shown(pct(pos.holdAnnual)) : "持有不足 7 天"}</div><div class="cap">${pos.annualValid ? `收益 ÷ 成本 × 365 ÷ ${pos.holdDays} 天` : "天数太短，折算没有意义"}</div></div>
      <div class="stat"><div class="l">持仓份额</div><div class="v" style="font-size:15px">${shown(pos.shares.toFixed(2))}</div><div class="cap">已确认份额，不含在途</div></div>
      <div class="stat"><div class="l">成本净值</div><div class="v" style="font-size:15px">${pos.shares > 0 ? shown((pos.cost / pos.shares).toFixed(4)) : "—"}</div><div class="cap">买入金额合计 ÷ 份额</div></div>
    </div>` : ""}

    <div class="card-t" style="margin:16px 0 8px"><h2 style="font-size:14px">净值走势</h2></div>
    <div class="chips">
      ${PROD_RANGES.map(([k, lab]) => `<button class="chip${UI.prodRange === k ? " on" : ""}" onclick="setProdRange(this,'${k}')">${lab}</button>`).join("")}
    </div>
    <div class="chips">
      <span class="muted" style="font-size:11px;align-self:center;margin-right:2px">叠加</span>
      ${PROD_OVS.map(([k, lab]) => `<button class="chip${UI.prodOv === k ? " on" : ""}" onclick="setProdOv(this,'${k}')">${lab}</button>`).join("")}
    </div>
    <div class="chart-wrap">
      <div class="chart-legend">
        <span><i style="background:#5b5bd6"></i>单位净值（左轴）</span>
        ${ovArr && ovKey !== "none" ? `<span><i style="background:#f0a020"></i>${esc(ovName)}（右轴·${esc(ovUnit)}）</span>` : ""}
      </div>
      ${chartHtml}
    </div>

    <div class="card-t" style="margin:14px 0 8px"><h2 style="font-size:14px">历史净值</h2><span class="hint">最近 ${Math.min(20, n)} 条 / 共 ${n} 条 · 万份收益为折算口径</span></div>
    ${rows.length ? `<table class="navtbl">
      <thead><tr><th>日期</th><th>单位净值</th><th>日涨跌</th><th>万份收益</th><th>7日年化</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>` : `<div class="empty">暂无净值</div>`}

    <div class="card-t" style="margin:16px 0 8px"><h2 style="font-size:14px">底层配置与申赎规则</h2><span class="hint">${esc(discStatusText(p))} · 照录披露原文</span></div>
    ${discCard(p, pos)}
    ${adviceCard(p, pos)}
    ${switchCard(p, pos)}
    <div class="row-btn" style="margin-top:14px">
      <button class="btn gh" style="flex:1" onclick="openDisc('${p.id}')">录入 / 修改配置</button>
      <button class="btn pri" style="flex:1" onclick="closeSheet();editProd('${p.id}')">编辑产品</button>
    </div>
    <div class="row-btn" style="margin-top:8px">
      <button class="btn pri" style="flex:1" onclick="closeSheet();openNav('${p.id}')">录入净值</button>
      <button class="btn gh" style="flex:1" onclick="openAna('${p.id}')">持仓体检</button>
    </div>`);
}
/* 区间起点日期 */
function rangeStartDate(days) {
  const t = new Date();
  t.setDate(t.getDate() - days);
  return fmtDate(t);
}
/* 图表块（含区间标题） */
function chartBlock(st, i0, ovArr, _i) {
  const dates = st.dates.slice(i0), vals = st.vals.slice(i0);
  const ov = ovArr ? ovArr.slice(i0) : null;
  return svgChart(dates, vals, ov);
}

/* ============================================================
   资产月报（v55）
   ------------------------------------------------------------
   算钱的部分全部在 js/domain/monthly.js（每一条口径都有 tests/monthly.test.mjs 盯着），
   这里只负责把结果拼成一张报告弹层。三件事写在前面：
     · 数字一律走 shown() / tone()。「隐藏」是按给旁边的人看时按的，
       报告里任何一处明文，等于把整月盈亏摆在大屏上。
     · 图上的坐标文字也是数字：格式化函数由这里传进 svgChart / svgDonut，
       画图的两个函数自己不认识钱，遮蔽与否只由渲染层决定。
     · 翻月份就重算整月，不做缓存。monthReport 只扫净值序列，一次几十毫秒；
       缓存换来的是「编辑完交易，报告还停在旧数」这种更难解释的现象。
   ============================================================ */
/* 环形配色：品牌紫打头，其余按「能分开、不刺眼」排。
   机构数量超过 8 家时循环复用（此时每一环旁边都有文字图例，不会认错）。 */
const REP_COLORS = ["#5b5bd6", "#f0a020", "#1a9e6a", "#e8474f", "#8b6fd6", "#5aa8e0", "#c9a227", "#9aa0bb"];

/* 打开报告时默认落在哪个月、入口提示报哪个月：倒着找最近一个「有收益变动」的月份。
   当月刚开头、净值还没披露时，落回当月只会显示一份全 0 的表 —— 那正是该看上月的时候。
   一个月都没变动（新设备、整年挂零）才落回当月，界面总得有个起点。 */
function repLatest() {
  const now = new Date();
  const td = today();
  const list = monthList(DATA.products, now.getFullYear(), now.getMonth() + 1);
  let cur = null;
  for (const ym of list) {
    const r = monthReport(DATA.products, DATA.trades, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), td);
    if (!cur) cur = r;
    if (r.profit) return r;
  }
  return cur;
}

/* 入口下面那行提示：月份 + 月收益 + 月年化，一眼看出这个月有没有必要点开。
   逐字段走 shown()：整串一起遮会把月份也变星号，看不出是「没数据」还是「已隐藏」。 */
function monthlyHintText() {
  const r = repLatest();
  if (!r || (!r.profit && !r.assetEnd)) return "还没有可报告的月份";
  const lab = `${r.y}年${r.m}月${r.isCurrent ? "（本月）" : ""}`;
  return `${lab} ${shown(signMoney(r.profit))} · 月年化 ${shown(pct(r.annual))}`;
}

function openMonthly() {
  if (!UI.repY) {
    const r = repLatest();
    const now = new Date();
    UI.repY = r ? r.y : now.getFullYear();
    UI.repM = r ? r.m : now.getMonth() + 1;
  }
  renderMonthly();
}
function setRepMonth(btn, ym) {
  if (btn) { btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("on")); btn.classList.add("on"); }
  UI.repY = Number(ym.slice(0, 4)); UI.repM = Number(ym.slice(5, 7));
  renderMonthly();
}

/* 环形图。中心两行文字由调用方传进来（已经 shown() 处理过），这个函数只做排版。
   每段是一条 stroke-dasharray 圆弧：圆周长 × 占比 = 段长，offset 累加负位移 = 起点。 */
function svgDonut(parts, top, val) {
  const S = 116, C = S / 2, R = 44, SW = 16;
  const circ = 2 * Math.PI * R;
  let g = `<svg viewBox="0 0 ${S} ${S}" role="img" style="display:block">`;
  g += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--track)" stroke-width="${SW}"/>`;
  let off = 0;
  for (const p of parts) {
    const len = Math.max(0, Math.min(1, p.share)) * circ;
    if (len < 0.2) continue;                    /* 小于 0.2 单位的弧画出来只是一条缝，不画 */
    g += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${p.color}" stroke-width="${SW}"`
      + ` stroke-dasharray="${len.toFixed(1)} ${(circ - len).toFixed(1)}"`
      + ` stroke-dashoffset="${(-off).toFixed(1)}" transform="rotate(-90 ${C} ${C})"/>`;
    off += len;
  }
  g += `<text x="${C}" y="${C - 4}" text-anchor="middle" font-size="10" fill="#9aa0bb">${esc(top)}</text>`;
  g += `<text x="${C}" y="${C + 12}" text-anchor="middle" font-size="14" font-weight="700" fill="#1c2033">${esc(val)}</text>`;
  return g + `</svg>`;
}

function renderMonthly() {
  const now = new Date();
  const nowY = now.getFullYear(), nowM = now.getMonth() + 1;
  const td = today();
  const y = UI.repY || nowY, m = UI.repM || nowM;
  const r = monthReport(DATA.products, DATA.trades, y, m, td);
  const list = monthList(DATA.products, nowY, nowM);
  const ym = `${y}-${m < 10 ? "0" + m : m}`;

  /* 收益构成条：v56 起按产品列（用户要看的是「具体哪只在赚/在亏」，机构名降成副标题）。
     长度按 |profit| 归一，正负用颜色区分（红涨绿跌与本 App 一致）。
     名字与条子分两行：产品名长短没有边界，单行截断会把「招睿日开三个月」和
     「招睿日开三个月滚动持有1号固收类理财计划」截成同一个样子，反而认不出是谁。 */
  const pShares = profitShares(r.byProd);
  const maxAbs = r.byProd.reduce((mx, x) => Math.max(mx, Math.abs(x.profit)), 0);   /* 最长的那根当 100% */
  const bars = r.byProd.map((x, i) => {
    /* 副标题只补「名字里没说出来的部分」：产品名通常已经带机构名（招银理财招睿…），
       再跟一遍就是噪声；期末没市值则必须标出来，否则看不出它为什么不在资产构成里。 */
    const bits = [];
    if (x.inst && x.label.indexOf(x.inst) < 0) bits.push(x.inst);
    if (!x.asset) bits.push("期末已清仓");
    const sub = bits.length ? `<i>${esc(bits.join(" · "))}</i>` : "";
    return `
    <div class="mbar">
      <div class="top">
        <div class="nm" title="${esc(x.label)}">${esc(x.label)}${sub}</div>
        <div class="vv"><span class="${tone(x.profit)}">${shown(signMoney(x.profit))}</span><i>${shown(pct(pShares[i]))}</i></div>
      </div>
      <div class="tr"><div class="fl ${tone(x.profit)}" style="width:${maxAbs > 0 ? (Math.abs(x.profit) / maxAbs * 100).toFixed(1) : 0}%"></div></div>
    </div>`;
  }).join("");

  /* 资产构成环：只画有市值的机构，合计写在圆心 */
  const parts = r.byInst.filter(x => x.asset > 0)
    .map((x, i) => ({ label: x.label, share: x.share, color: REP_COLORS[i % REP_COLORS.length] }));
  const legend = parts.map(p => `
    <div class="r"><i style="background:${p.color}"></i><span class="n" title="${esc(p.label)}">${esc(p.label)}</span>
      <span class="p">${shown((p.share * 100).toFixed(1) + "%")}</span></div>`).join("");

  /* 累计收益曲线：把 1 号 0 元作为起点，月份看起来是「从 0 涨到多少」而不是凭空一段线 */
  const cDates = [r.first], cVals = [0];
  for (const [d, v] of r.cum) { cDates.push(d); cVals.push(v); }
  if (!r.cum.length) { cDates.push(r.end); cVals.push(0); }

  openSheet(`<div class="sheet-t"><h3>资产月报</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="chips" style="margin:0 0 12px">
      ${list.map(k => `<button class="chip${k === ym ? " on" : ""}" onclick="setRepMonth(this,'${k}')">${k.slice(0, 4)}年${Number(k.slice(5, 7))}月</button>`).join("")}
    </div>
    <div class="sum-head">
      <div class="big ${tone(r.profit)}">${shown(signMoney(r.profit))}</div>
      <div class="sub"><span class="rate ${tone(r.annual)}">${shown(pct(r.annual))}</span> 月年化 · ${r.m}月${r.isCurrent ? "进行中" : "整月"}</div>
      <div class="cap" style="text-align:center;margin-top:5px">${r.first} ~ ${r.end} · 共 ${r.days} 天</div>
    </div>
    <div class="grid2">
      <div class="stat"><div class="l">月资产变动</div><div class="v ${tone(r.change)}">${shown(signMoney(r.change))}</div><div class="cap">期末市值 − 期初市值</div></div>
      <div class="stat"><div class="l">期末资产</div><div class="v">${shown(money(r.assetEnd))}</div><div class="cap">${r.isCurrent ? "按最新披露净值" : `${r.m}月末市值`}</div></div>
      <div class="stat"><div class="l">净投入</div><div class="v ${tone(r.netInflow)}">${shown(signMoney(r.netInflow))}</div><div class="cap">买入 − 赎回到账 · 按确认日归月</div></div>
      <div class="stat"><div class="l">持有明细</div><div class="v">${r.holdN}</div><div class="cap">${r.best ? "本月表现最好：" + esc(r.best.name) : "本月无收益变动"}</div></div>
    </div>

    <div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">累计收益走势</h2><span class="hint">单位：元</span></div>
    <div class="chart-wrap">${svgChart(cDates, cVals, null, v => shown(Math.round(v).toLocaleString("zh-CN")))}</div>

    <div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">收益构成</h2><span class="hint">按产品 · 当月有变动的 ${r.byProd.length} 只</span></div>
    ${r.byProd.length ? bars : `<div class="cap">这个月没有任何收益变动。</div>`}

    <div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">资产构成</h2><span class="hint">${r.holdN} 只持仓 / ${parts.length} 家机构</span></div>
    ${parts.length ? `<div class="donut">${svgDonut(parts, "期末资产", shown(money(r.assetEnd)))}<div class="dlegend">${legend}</div></div>`
      : `<div class="cap">期末没有持仓市值，画不出构成。</div>`}

    <div class="card-t" style="margin:16px 0 6px"><h2 style="font-size:14px">交易小结</h2></div>
    <div class="mline"><span>买入</span><b>${r.buyN} 笔 · ${shown(money(r.buyAmt))} 元</b></div>
    <div class="mline"><span>赎回</span><b>${r.sellN} 笔 · 到账 ${shown(money(r.sellAmt))} 元</b></div>
    <div class="mline"><span>赎回结算收益</span><b class="${tone(r.realized)}">${shown(signMoney(r.realized))}</b></div>
    <div class="mline"><span>期初 → 期末</span><b>${shown(money(r.assetStart))} → ${shown(money(r.assetEnd))}</b></div>

    <div class="cap" style="margin-top:14px">
      月收益 = 逐日「当日已确认份额 × 净值差」之和，未披露日不做均摊，在途份额不计息；
      月年化 = 月收益 ÷ 期末市值 × 365 ÷ 当月天数，本金天数加权，为本工具折算口径、非机构披露；
      资产变动 = 期末市值 − 期初市值，它与「净投入 + 月收益」往往有小额出入：净投入按成交金额登记、
      份额只保留两位小数，市值按期末披露净值折算，申购与赎回各自还会带进确认日当天的净值差。
      收益构成按产品列示（名字里没带机构时副标题补上机构，标「期末已清仓」的当月仍产生过收益），资产构成按机构汇总；
      持仓与收益均来自个人记账，以官方披露为准，不构成投资建议。
    </div>`);
}
/* ============================================================
   批量粘贴文本解析（净值 / 产品）
   ------------------------------------------------------------
   为什么要有这套：参考项目用「截图 OCR 记账」，但那需要服务端、且要把
   截图交给第三方，与本项目「数据不出设备 + 零后端」的前提冲突。
   替代方案：让用户把官网 / 银行 App / 表格里的**文字**复制进来，本地解析。

   四条铁律（都是被旧 bulkNav 的毛病逼出来的，改的时候别退回去）：
     1. **不静默丢行**。旧实现只报「已导入 N 条」，用户根本不知道还有
        M 行没进去。现在无法识别的行必须逐条列出原因。
     2. **不猜**。缺年份、含千分位逗号、百分数一律拒绝并说明 —— 净值写错
        比少写严重得多（错值会一直参与收益计算，且很难被发现）。
     3. **与云端「已有净值不覆盖」同口径**。旧实现直接覆盖同日已有值，
        与云端 merge_nav 的策略是矛盾的。现在默认跳过，覆盖需显式勾选。
     4. **预览里的数字就是将要写入的数字**，核对之后才落库。
   ============================================================ */

/* 一行里的日期：支持 2026-09-14 / 2026/9/14 / 2026.09.14 / 2026年9月14日 / 20260914 */
const NAV_DATE_RES = [
  /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/,
  /(?:^|\D)(\d{4})(\d{2})(\d{2})(?!\d)/,
];
function navDateAt(line) {
  for (const re of NAV_DATE_RES) {
    const m = String(line).match(re);
    if (!m) continue;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    /* 反向校验：挡掉「格式对但日期不存在」的假日期（如 2026-02-30） */
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) continue;
    return { end: m.index + m[0].length, date: `${y}-${pad(mo)}-${pad(d)}` };
  }
  return null;
}

/* 日期之后的第一个「干净数字」= 单位净值。
   含逗号 / 百分号 / 多个小数点的一律报错而不是凑一个数出来（旧实现的
   `[\d.]+` 会把 "1,0234" 吃成 1、把 "1.0.2" 变成 NaN 写进库）。 */
function navValueAfter(line, endIdx) {
  const toks = String(line).slice(endIdx).split(/[\s|│]+/).filter(Boolean);
  if (!toks.length) return { err: "只有日期，没找到净值" };
  for (const tk of toks) {
    if (/[，,]/.test(tk) && /^[\d,，.]+$/.test(tk))
      return { err: `「${tk}」含千分位逗号，无法确定真实数值（只贴「日期 + 单位净值」两列最稳）` };
    if (/%$/.test(tk)) return { err: `「${tk}」是百分数（年化或涨跌幅），不是单位净值` };
    const m = tk.match(/^[¥￥]?(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0) return { err: `净值「${tk}」不是正数` };
    if (v >= 1000) return { err: `净值「${tk}」明显不合理（≥1000）` };
    return { nav: v, tok: tk };
  }
  return { err: "日期后面没找到可当作单位净值的数字" };
}

/* 解析整段文本。返回 { rows, counts }：**每一行都在 rows 里**，一行都不会消失。 */
function parseNavText(text, existing) {
  const exist = existing || {};
  const rows = [], seenAt = {};
  String(text == null ? "" : text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;                                  /* 空行不占报告 */
    const ln = i + 1;
    /* 表头行（「净值日期 单位净值 日涨跌」之类）：没有日期也不是数据 */
    if (!navDateAt(line) && /(日期|净值|年化|涨跌)/.test(line) && !/\d{4}/.test(line)) return;
    const d = navDateAt(line);
    if (!d) { rows.push({ ln, raw: line, status: "bad", note: "没识别出日期（支持 2026-09-14 / 2026/9/14 / 2026年9月14日 / 20260914）" }); return; }
    const v = navValueAfter(line, d.end);
    if (v.err) { rows.push({ ln, raw: line, date: d.date, status: "bad", note: v.err }); return; }
    if (seenAt[d.date]) { rows.push({ ln, raw: line, date: d.date, nav: v.nav, status: "bad", note: `与第 ${seenAt[d.date]} 行日期重复` }); return; }
    seenAt[d.date] = ln;
    const old = exist[d.date];
    if (old !== undefined && old !== null && old !== "") {
      rows.push({
        ln, raw: line, date: d.date, nav: v.nav, old: Number(old), status: "exist",
        note: Number(old) === v.nav ? "该日期已有相同值" : `该日期已有 ${Number(old)}`,
      });
      return;
    }
    rows.push({ ln, raw: line, date: d.date, nav: v.nav, status: "new", note: "" });
  });

  /* 可疑值：与该产品最近一条已有净值、或同批的相邻条目相差 > 10%。
     理财产品单日净值波动几乎不可能到这个量级，出现基本就是**粘错了产品**。 */
  const keys = Object.keys(exist).sort();
  const ref = keys.length ? Number(exist[keys[keys.length - 1]]) : null;
  const ordered = rows.filter(r => r.date && (r.status === "new" || r.status === "exist"))
    .sort((a, b) => a.date.localeCompare(b.date));
  ordered.forEach((r, i) => {
    const prev = i > 0 ? ordered[i - 1].nav : ref;
    if (!prev) return;
    const diff = Math.abs(r.nav / prev - 1);
    if (diff > 0.10) {
      const txt = `与相邻净值 ${prev} 相差 ${(diff * 100).toFixed(1)}%`;
      if (r.status === "new") { r.status = "warn"; r.note = txt; }
      else r.note += `；${txt}`;
    }
  });

  const counts = { new: 0, exist: 0, warn: 0, bad: 0 };
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  return { rows, counts };
}

/* ============================================================
   截图识别净值（App 内 ML Kit，离线；图片不离开手机）
   ------------------------------------------------------------
   微众等代销 App 的净值在登录态里，外部程序拿不到公开接口。
   这里走「你自己截图 → 本机 OCR → 填进上面的粘贴框 → 你核对后写入」，
   不碰任何账号密码，也不绕过对方的鉴权。
   ============================================================ */
const _ocrDone = {};
window.__ocrDone = function (id, res) {
  const f = _ocrDone[id]; if (!f) return;
  delete _ocrDone[id]; f(res);
};
function ocrPick(pid) {
  if (!window.NativeNav || !window.NativeNav.ocr) return toast(bridgeMissingMsg("截图识别只在 App 内可用；网页版请直接粘贴"), 4200);
  const el = $("ocrFile"); if (!el) return;
  try { el.value = ""; } catch (e) { }
  el.click();
}
function ocrBridge(b64) {
  return new Promise(resolve => {
    if (!window.NativeNav || !window.NativeNav.ocr) return resolve({ ok: false, message: bridgeMissingMsg("仅 App 内可用") });
    const id = "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const timer = setTimeout(() => { delete _ocrDone[id]; resolve({ ok: false, message: "识别超时" }); }, 35000);
    _ocrDone[id] = r => { clearTimeout(timer); resolve(r || { ok: false }); };
    try { window.NativeNav.ocr(id, b64); }
    catch (e) { clearTimeout(timer); delete _ocrDone[id]; resolve({ ok: false, message: String(e) }); }
  });
}
/* 压缩到最长边 1600：截图通常 2–4MB，压完几百 KB，识别更快也不会撑爆桥 */
function fileToJpegBase64(file, maxSide) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("读图失败"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片格式不支持"));
      img.onload = () => {
        const m = maxSide || 1600;
        const k = Math.min(1, m / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || 1) * k));
        const h = Math.max(1, Math.round((img.height || 1) * k));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        const url = cv.toDataURL("image/jpeg", 0.86);
        resolve(url.slice(url.indexOf(",") + 1));
      };
      img.src = String(fr.result || "");
    };
    fr.readAsDataURL(file);
  });
}
/* OCR 文本 → 「日期 净值」行：日期与数字可能同一行，也可能上下相邻两行 */
async function ocrShot(pid, input) {
  const f = input && input.files && input.files[0];
  if (!f) return;
  toast("识别中…（本机处理，图片不上传）", 2600);
  try {
    const b64 = await fileToJpegBase64(f, 1600);
    const r = await ocrBridge(b64);
    if (!r || !r.ok) return toast((r && r.message) || "识别失败", 4200);
    const rows = ocrNavLines(r.text);
    if (!rows.length) return toast("没认出「日期 + 净值」，截图要带上日期和净值数字", 5200);
    const box = $("nBulk"); if (!box) return;
    const old = box.value.trim();
    const add = rows.filter(x => old.indexOf(x.split(" ")[0]) < 0);
    UI.navDraft = (old ? old + "\n" : "") + add.join("\n");
    box.value = UI.navDraft;
    bulkNav(pid);
    toast(add.length ? "认出 " + add.length + " 条，核对后点下方写入" : "这些日期本地已有，不用重复写", 4200);
  } catch (e) {
    toast("识别失败：" + String(e.message || e).slice(0, 50), 4200);
  }
}

/* ============================================================
   扫微众分享海报上的二维码 → 直接认出产品（App 内）
   ------------------------------------------------------------
   微众那三个 `*_no_auth` 接口要 App 注入的设备签名，站外调不通；但产品页
   「分享」出来的海报二维码是一条**公开短链**：它 302 到官网下载中转页时，
   跳转参数里就带着这只产品的销售代码（`jumpParam` → base64 → `action_param`）。
   所以这里只读短链自己吐出来的重定向参数，不碰任何登录态或签名接口。
   二维码在本机解（ML Kit），代码 → 发行方的反查在包内 Python（公开目录），
   解出来的代码走「粘贴添加产品」原有那条路，机构名自动填好。
   ============================================================ */
const _qrDone = {};
window.__qrDone = function (id, res) {
  const f = _qrDone[id]; if (!f) return;
  delete _qrDone[id]; f(res);
};
function qrBridge(b64) {
  return new Promise(resolve => {
    if (!window.NativeNav || !window.NativeNav.qr) return resolve({ ok: false, message: bridgeMissingMsg("仅 App 内可用") });
    const id = "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const timer = setTimeout(() => { delete _qrDone[id]; resolve({ ok: false, message: "识别超时" }); }, 40000);
    _qrDone[id] = r => { clearTimeout(timer); resolve(r || { ok: false }); };
    try { window.NativeNav.qr(id, b64); }
    catch (e) { clearTimeout(timer); delete _qrDone[id]; resolve({ ok: false, message: String(e) }); }
  });
}
function qrPick() {
  if (!window.NativeNav || !window.NativeNav.qr) return toast(bridgeMissingMsg("扫码添加只在 App 内可用；网页版请直接粘贴产品代码"), 4200);
  const el = $("qrFile"); if (!el) return;
  try { el.value = ""; } catch (e) { }
  el.click();
}
/* 二维码比整页文字吃分辨率：压太狠就解不出，这里留到 2000 */
async function qrShot(input) {
  const f = input && input.files && input.files[0];
  if (!f) return;
  toast("扫码中…（本机识别，图片不上传）", 2600);
  try {
    const b64 = await fileToJpegBase64(f, 2000);
    const r = await qrBridge(b64);
    if (!r || !r.ok) return toast((r && r.message) || "识别失败", 4200);
    const d = r.data || {};
    if (!d.ok || !d.code) return toast(d.message || "二维码里不是微众的产品页", 5200);
    applyQrProduct(d);
  } catch (e) {
    toast("识别失败：" + String(e.message || e).slice(0, 50), 4200);
  }
}
/* 解出来的代码塞进上面的粘贴框，机构用发行方全名兜底 —— 云端靠 inst 选数据源 */
function applyQrProduct(d) {
  const box = $("lkInput"); if (!box) return;
  const line = String(d.code).toUpperCase();
  const old = box.value.trim();
  if (old.split(/\r?\n/).some(x => x.trim().toUpperCase() === line)) {
    return toast(line + " 已经在列表里了", 3600);
  }
  box.value = (old ? old + "\n" : "") + line;
  const inst = $("lkInst");
  if (inst && d.orgName && !inst.value.trim()) inst.value = d.orgName;
  previewLink();
  toast(`认出 ${d.name || line}${d.orgName ? " · " + d.orgName : ""}`, 4600);
}

function openNav(pid) {
  const p = DATA.products.find(x => x.id === pid); if (!p) return;
  const s = navSeries(p).slice().reverse();
  /* 草稿留在一个模块级变量里：写入/删除一条净值会重画整个弹层，
     若每次都清空粘贴框，用户得把上百行重新贴一遍。 */
  const draft = UI.navDraft || "";
  openSheet(`<div class="sheet-t"><h3>${esc(prodLabel(p))} · 净值</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="field"><label>新增/修改净值</label>
      <div class="two">
        <input type="date" id="nDate" value="${today()}">
        <input type="number" step="0.0001" id="nVal" placeholder="份额净值">
      </div>
      <button class="btn pri full" style="margin-top:9px" onclick="addNav('${pid}')">保存净值</button>
    </div>
    <div class="field"><label>批量粘贴净值 <span class="muted">（每行：日期 + 单位净值）</span></label>
      <textarea id="nBulk" rows="5" oninput="bulkNav('${pid}')" placeholder="2026-09-10 1.0313&#10;2026-09-09 1.0312&#10;也支持 2026/9/9、2026年9月9日、20260909&#10;可直接整段复制官网的净值表">${esc(draft)}</textarea>
      <div class="chk-row">
        <label><input type="checkbox" id="nBulkOver" onchange="bulkNav('${pid}')"> 覆盖同日已有净值</label>
        <label><input type="checkbox" id="nBulkWarn" onchange="bulkNav('${pid}')"> 写入可疑行</label>
      </div>
      <button class="btn gh full" style="margin-top:8px" onclick="ocrPick('${pid}')">📷 截图识别净值</button>
      <input type="file" id="ocrFile" accept="image/*" style="display:none" onchange="ocrShot('${pid}', this)">
      <div class="tip">微众/其他 App 的产品页截个图就行，识别在本机完成、图片不上传；认出的行会先放进上面的粘贴框，核对后再写入。</div>
      <div id="nBulkPrev"></div>
    </div>
    <div class="field"><label>已有净值（${s.length} 条）</label>
      <div style="max-height:200px;overflow:auto">${s.map(([d, v]) => `<div class="sumline"><span class="k">${d}</span><span style="display:flex;gap:10px;align-items:center"><b>${Number(v).toFixed(4)}</b><button class="mini" style="padding:2px 7px;font-size:10.5px" onclick="delNav('${pid}','${d}')">删</button></span></div>`).join("") || `<span class="muted" style="font-size:12px">暂无</span>`}</div>
    </div>`);
  /* 草稿非空时立刻把预览画出来：写入/删除后弹层会重画，预览不能跟着丢 */
  bulkNav(pid);
}
function addNav(pid) {
  const p = DATA.products.find(x => x.id === pid);
  const d = $("nDate").value, v = Number($("nVal").value);
  if (!d || !(v > 0)) return toast("请填写日期与净值");
  p.navHistory = p.navHistory || {}; p.navHistory[d] = v;
  saveLocal(); toast("净值已保存"); openNav(pid); renderHome(); renderProd(); autoPush();
}
/* 粘贴 → 解析 → 画预览。**不写库**；文本框 oninput 与两个开关都走这里。 */
function bulkNav(pid) {
  const p = DATA.products.find(x => x.id === pid); if (!p) return;
  if ($("nBulk")) UI.navDraft = $("nBulk").value;
  const st = parseNavText(UI.navDraft || "", p.navHistory || {});
  UI.navParsed = st;
  const over = !!($("nBulkOver") && $("nBulkOver").checked);
  const inclWarn = !!($("nBulkWarn") && $("nBulkWarn").checked);
  const box = $("nBulkPrev"); if (!box) return;
  const writable = st.rows.filter(r =>
    r.status === "new" || (r.status === "warn" && inclWarn) || (r.status === "exist" && over));
  if (!st.rows.length) { box.innerHTML = ""; return; }
  const c = st.counts;
  /* 颜色直接引用 CSS 变量，避免依赖可能不存在的类名 */
  const chip = (n, col, lab) => n ? `<b style="color:var(${col})">${n}</b> ${lab}&nbsp;&nbsp;` : "";
  box.innerHTML = `<div class="note${writable.length ? " g" : ""}" style="margin:9px 0 8px">
      ${chip(c["new"], "--brand", "条新增")}${chip(c.warn, "--gold", "条可疑")}
      ${chip(c.exist, "--ink3", "条已存在")}${chip(c.bad, "--gold", "行无法识别")}
      <div style="margin-top:4px">${writable.length
      ? `将写入 <b>${writable.length}</b> 条`
      : "没有可写入的内容"}</div>
      ${(c.exist && !over) ? "<div>· 已存在的日期默认跳过（勾上面的开关可覆盖）</div>" : ""}
      ${(c.warn && !inclWarn) ? "<div>· 可疑行默认不写入 —— 请先核对是不是粘错了产品</div>" : ""}
      ${c.bad ? "<div>· 无法识别的行会保留在输入框里，改完再点一次</div>" : ""}
    </div>
    <div style="max-height:230px;overflow:auto"><table class="navtbl">
      <thead><tr><th>日期</th><th>净值</th><th style="text-align:left">说明</th></tr></thead>
      <tbody>${st.rows.slice(0, 60).map(r => `<tr>
        <td>${esc(r.date || "—")}</td>
        <td>${r.nav === undefined ? "—" : Number(r.nav).toFixed(4)}</td>
        <td style="text-align:left;font-size:11px;color:var(${r.status === "bad" ? "--gold" : "--ink3"})">${esc(r.note || "")}</td>
      </tr>`).join("")}</tbody></table>
      ${st.rows.length > 60 ? `<div class="muted" style="font-size:11px;padding:6px 0">只显示前 60 行（共 ${st.rows.length} 行，写入时会全部处理）</div>` : ""}
    </div>
    <button id="nCommit" class="btn pri full" style="margin-top:9px" onclick="commitNav('${pid}')"${writable.length ? "" : " disabled"}>确认写入 ${writable.length} 条</button>`;
}

/* 预览确认后真正落库。写入条数必须等于按钮上写的那个数字。 */
function commitNav(pid) {
  /* 防快速双击：点下即禁用按钮；openNav() 重渲染会重建按钮自然恢复。
     （不要用时间窗守卫 —— 直接调用本函数连续写入多批净值是合法场景） */
  const btn = $("nCommit");
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  const p = DATA.products.find(x => x.id === pid); if (!p) return;
  const st = UI.navParsed || parseNavText(UI.navDraft || "", p.navHistory || {});
  const over = !!($("nBulkOver") && $("nBulkOver").checked);
  const inclWarn = !!($("nBulkWarn") && $("nBulkWarn").checked);
  const doRows = st.rows.filter(r =>
    r.status === "new" || (r.status === "warn" && inclWarn) || (r.status === "exist" && over));
  if (!doRows.length) return toast("没有可写入的净值");
  p.navHistory = p.navHistory || {};
  let add = 0, cov = 0;
  for (const r of doRows) {
    if (r.status === "exist") cov++; else add++;
    p.navHistory[r.date] = r.nav;          /* r.nav 已在解析阶段校验为「正的有限数」 */
    /* 手工重新写入 = 有意恢复这一天：撤掉对应墓碑，
       否则推送前执行墓碑时会把刚恢复的净值又删掉。 */
    if (DATA.tomb && DATA.tomb.navs) delete DATA.tomb.navs[pid + "|" + r.date];
  }
  /* 未识别的行留在草稿里 —— 别让用户回原文里再挑一遍 */
  const left = st.rows.filter(r => r.status === "bad").map(r => r.raw).join("\n");
  UI.navDraft = left;
  saveLocal(); autoPush();
  openNav(pid);                            /* 重画：净值列表已更新，框里只剩未识别的行 */
  renderHome(); renderProd();
  toast(`已写入 ${add + cov} 条` + (cov ? `（覆盖 ${cov}）` : "")
    + (left ? `，${st.counts.bad} 行未识别已留在框里` : ""), 3400);
}
function delNav(pid, d) {
  const p = DATA.products.find(x => x.id === pid);
  if (!p || !p.navHistory || p.navHistory[d] === undefined) return;
  /* 留墓碑：云端抓取或另一台设备的旧快照都可能把这天再写回来 */
  tombAdd("navs", pid + "|" + d);
  delete p.navHistory[d];
  saveLocal(); openNav(pid); renderHome(); renderProd(); autoPush();
}
function delProd(pid) {
  if (!confirm("删除该产品及其所有交易记录？")) return;
  tombAdd("products", pid);
  /* 交易也要逐个留墓碑：否则别的设备按旧快照推送时，产品没了、交易还在，
     云端数据会变成「交易指向不存在的产品」（validate_data 直接报错）。 */
  for (const t of DATA.trades) if (t.prodId === pid) tombAdd("trades", t.id);
  DATA.products = DATA.products.filter(x => x.id !== pid);
  DATA.trades = DATA.trades.filter(t => t.prodId !== pid);
  saveLocal(); renderProd(); renderHome(); autoPush();
}
function delTrade(tid) {
  if (!confirm("删除这笔交易？")) return;
  tombAdd("trades", tid);
  DATA.trades = DATA.trades.filter(t => t.id !== tid);
  saveLocal(); renderTrade(); renderHome(); autoPush();
}

/* ============================================================
   净值更新：改为「云端更新说明」弹层
   ------------------------------------------------------------
   原先这里的浏览器端 fetch 实际不可用 —— 中国理财网信披平台被 CORS 拦截，
   点击后没有任何反应。净值改由云端 GitHub Actions 每天 08:00 / 12:00 抓取
   并提交到私有仓库，浏览器端只需「从云端拉取」。
   ============================================================ */
function refreshNav() {
  const last = (DATA.settings && DATA.settings.lastNavSync) || "";
  const hf = lastFetchInfo(), hfN = fetchFailCount(hf);
  const rows = DATA.products.map(p => {
    const st = fetchStatus(p);
    const srcTxt = navSrcText(navSrcInfo(p));
    return `<div class="sumline" style="align-items:flex-start">
      <span class="k" style="flex:1">${esc(prodLabel(p))}${srcTxt
        ? `<div class="tip" style="margin-top:2px">上次抓取来源：${esc(srcTxt)}</div>` : ""}</span>
      <b class="${st.ok ? "down" : "muted"}" style="font-size:10.5px;text-align:right;margin-left:8px">${esc(st.txt)}</b>
    </div>`;
  }).join("") || `<div class="empty">暂无产品</div>`;
  const ready = DATA.products.filter(p => fetchStatus(p).ok).length;
  openSheet(`<div class="sheet-t"><h3>净值更新说明</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      ${nativeFetchAvailable() ? `App 内置抓取器<b>直接在本机</b>访问各披露源，不受浏览器跨域限制，
      也不依赖 GitHub 定时任务。<br><br>
      打开 App / 切回前台会<b>自动核对</b>：只要还有产品没披露到昨天，就<b>每 3 分钟</b>查一次；
      全部追上后降到每 30 分钟一次。抓到即落盘并自动推送，不需要手动操作。<br><br>
      <b>每条净值都会并发查两条线</b>：<b>① 发行方官网</b>与<b>② 中国理财网信披平台</b>，
      自动采用更新的一条；同一天都有时用官网（原始披露方）。${aixhubLoggedIn()
        ? `<br>已登录<b>秒讯</b>：只有点「⚡ 立即抓取」时才顺带查它一次（后台轮询不碰它）。`
        : `<br>想要更早半天看到，可在「设置 → 秒讯」登录（可选，不登录不影响上面的抓取）。`}<br><br>
      ⓘ 公开披露本身有滞后（通常开放日次日～次二日）。发行方还没披露的日期，
      任何公开渠道都拿不到 —— 下面会列出两个源各自的最新日期。急用可点「⚡ 立即抓取」强制核对一次。`
      : `净值<b>不再由浏览器抓取</b>。北银 / 华夏 / 浦银 / 信银 / 南银 / 民生 官网均设置了跨域限制（CORS）或加密/风控，
      页面直连会被浏览器拦截 —— 这正是原「每日更新」按钮点了没反应的原因。<br><br>
      现在由云端 <b>GitHub Actions</b> 每天 <b>00:00 / 06:00 / 08:00</b> 自动抓取官方公开披露的净值，
      提交到你的私有仓库。<br><br>
      <b>每条净值都会同时查两条线</b>：<b>① 发行方官网</b>（历史全、多为原始披露）与
      <b>② 中国理财网信披平台</b>（覆盖任意发行方，部分产品反而更新更快）。云端自动比对后
      <b>采用更新的那条</b>；同一天两条线都有时用<b>官网</b>（原始披露方，避免转抄差），
      另一条线独有的历史日期会一并保留。<br><br>
      ⚠️ GitHub 的免费定时任务是「尽力而为」，实测常延迟数小时甚至跳过 ——
      <b>嫌慢就点上方「⚡ 立即抓取」</b>，手动触发不受排队影响，1-2 分钟出结果。`}
    </div>
    <div class="row-btn" style="margin-bottom:12px">
      <button id="btnFetchNow" class="btn pri" style="flex:1" onclick="triggerFetch()">⚡ 立即抓取</button>
      <button class="btn" style="flex:1" onclick="closeSheet();syncPull(true)">↓ 从云端拉取</button>
    </div>
    <div class="field"><label>云端最近一次抓取</label>
      <div id="navSyncTime" class="note ${last ? "g" : ""}">${last ? esc(last) : "暂无记录（云端抓取任务尚未写入）"}</div>
    </div>
    <div class="field"><label>手动抓取（⚡ 立即抓取）结果</label>
      <div id="manFetchBox">${manStatusHtml()}</div>
    </div>
    <div class="field"><label>各产品抓取就绪状态（${ready} / ${DATA.products.length} 可自动抓取）</label>
      <div>${rows}<div class="tip" style="margin-top:6px">判定口径与云端抓取脚本一致：<b>机构可识别</b> + <b>已填产品代码</b>。标 ⚠️ 的产品请到「交易」页的产品列表点「编辑」补填。</div></div>
    </div>
    <div class="row-btn" style="margin-top:14px">
      <button class="btn gh" style="flex:1" onclick="closeSheet();go('pg-trade')">去交易页管理产品</button>
    </div>`);
  ensureManualPolling();   /* 上次手动抓取还在跑就接着追踪 */
}

/* ============================================================
   GitHub 同步（1a：Token 直连私有仓库）
   ============================================================ */
const GH = "https://api.github.com";
function openSync() {
  /* Token 需要的权限按运行环境分两种说法：App 里「立即抓取」是本机 CPython 直接跑
     （见 triggerFetch 开头的 nativeFetchAvailable 分支），根本不派发 Actions，
     再让用户去勾 Actions:write 就是白要权限；网页端才需要它触发 update_nav.yml。 */
  const inApp = nativeFetchAvailable();
  const scope = inApp
    ? `本机只需一项：<code>Contents: Read and write</code>。净值在手机上本地抓，不派发云端任务，<b>不用给 Actions 权限</b>。`
    : `需要两项：<code>Contents: Read and write</code>（读写数据）+ <code>Actions: Read and write</code>（用「⚡ 立即抓取」触发云端任务；只给 Contents 会 403）。`;
  /* 预填值没被改过就别展开高级，首次配置只剩 Token 一格 */
  const advOpen = (SYNC.owner !== "glorywork" || SYNC.repo !== "licai-data" || SYNC.path !== "licai-data.json");
  /* 「App 更新」只在有本机更新桥的壳里出现：判的是 nativeUpdateAvailable() 而不是
     inApp —— 线上优先之后跑的是页面上的代码、装的是本机那个壳，两者版本可以错开
     （Java 只挡住「比本壳更老的代码」，新代码允许跑在旧壳上）。所以桥的存在与否
     只能运行时探测，探不到就别留一个点了没反应的按钮。 */
  const canUpd = nativeUpdateAvailable();
  openSheet(`<div class="sheet-t"><h3>数据同步设置</h3><button class="x" onclick="closeSheet()">✕</button></div>
    <div class="note b" style="margin-bottom:12px">
      数据存到你<b>自己的 GitHub 私有仓库</b>的一个 JSON 文件里，多设备打开即共享。
      请用<b>细粒度 Token</b>（Fine-grained PAT），<b>只授权那一个仓库</b>，权限：${scope}
    </div>
    <div class="field"><label>细粒度 Token</label><input id="sToken" type="password" value="${esc(SYNC.token)}" placeholder="github_pat_..."></div>
    <details class="adv"${advOpen ? " open" : ""}><summary>高级：仓库 / 数据文件路径</summary>
      <div class="field"><label>GitHub 用户名</label><input id="sOwner" value="${esc(SYNC.owner)}" placeholder="如 zhangsan"></div>
      <div class="field"><label>仓库名</label><input id="sRepo" value="${esc(SYNC.repo)}" placeholder="如 licai-data"></div>
      <div class="field"><label>数据文件路径</label><input id="sPath" value="${esc(SYNC.path)}" placeholder="licai-data.json"></div>
    </details>
    <div class="note">Token 只保存在本机，不会上传到任何第三方；若泄露可随时在 GitHub 上吊销。<br>
      改动会在一笔编辑后 1.5 秒自动推上去，顶栏那个胶囊说的就是「推上去没有」。</div>
    <div class="row-btn" style="margin-top:14px">
      <button class="btn gh" style="flex:1" onclick="saveSyncCfg()">保存配置</button>
      <button class="btn pri" style="flex:1" onclick="saveSyncCfg(true)">保存并测试</button>
    </div>
    <div class="row-btn" style="margin-top:9px">
      <button class="btn gh" style="flex:1" onclick="syncPull(true)">↓ 拉取云端数据</button>
      <button class="btn pri" style="flex:1" onclick="syncPush(true)">↑ 推送本地数据</button>
    </div>
    ${inApp ? "" : `<div class="row-btn" style="margin-top:9px">
      <button id="btnFetchNow" class="btn" style="flex:1" onclick="triggerFetch()">⚡ 立即抓取最新净值</button>
    </div>
    <div class="field" style="margin-top:10px"><label>手动抓取结果</label>
      <div id="manFetchBox">${manStatusHtml()}</div>
    </div>`}
    ${canUpd ? `<div class="field" style="margin-top:12px"><label>App 更新（本机壳 + 线上页面）</label>
      <div id="updBox"></div></div>` : ""}
    <div id="syncMsg" style="margin-top:10px"></div>`);
  if (!inApp) ensureManualPolling();
  if (canUpd) renderUpdBox();
}
function saveSyncCfg(test) {
  SYNC.owner = ($("sOwner").value || "").trim();
  SYNC.repo = ($("sRepo").value || "").trim();
  SYNC.path = ($("sPath").value || "licai-data.json").trim();
  SYNC.token = ($("sToken").value || "").trim();
  saveSync(); renderSet(); renderHome();
  if (test) testConn();
}
/* base64 ⇄ UTF-8（escape/unescape 已废弃，2026-09-15 审查替换） */
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function utf8ToB64(s) {
  const arr = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
async function ghReq(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: {
      "Authorization": "Bearer " + SYNC.token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),   /* 网络卡死时 20s 放弃，不再永久挂起 */
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`); }
  return r.status === 204 ? null : r.json();
}
/* 手动触发云端抓取（#延时对策，2026-09-16）：
   GitHub 免费仓库的 schedule 是「尽力而为」，实测延迟 2-9.5 小时且可能被跳过 ——
   点这个按钮用 workflow_dispatch 立刻触发一次（官方接口，非定时任务、无排队延迟）。
   需要令牌具备 Actions: Read and write（Contents 权限不够，403）。 */
/* ---------- 手动抓取结果跟踪（v31） ----------
   workflow_dispatch 成功只返回 204、**不带 run id**，所以「到底成没成」必须触发后
   主动去查最近一次 workflow_dispatch 运行。状态写进 localStorage：弹层关掉重开、
   或 PWA 被系统回收再打开，都还能看到上次结果（12 分钟上限自动收口，不会一直转圈）。 */
const LS_MANUAL = "licai.manualFetch";
let MANUAL = loadManual();
let _manPollTimer = null, _manPolling = false;
function loadManual() { try { return JSON.parse(localStorage.getItem(LS_MANUAL)) || {}; } catch (e) { return {}; } }
function saveManual() { try { localStorage.setItem(LS_MANUAL, JSON.stringify(MANUAL)); } catch (e) { } }
function stampOf(ms) {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function durTxt(ms) {
  ms = Math.max(0, Number(ms) || 0);
  return ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : `${Math.round(ms / 1000)} 秒`;
}
/* 状态条：一眼回答「手动抓取到底成没成、数据到没到」。
   workflow_dispatch 是异步的 —— 用户点完只看得到一个 toast，所以这里把
   触发时间 / 运行号 / 耗时 / 云端回报的抓取时间 / 新增条数都摊开写清楚。 */
function manStatusHtml() {
  const m = MANUAL || {};
  if (!m.t0) return `<div class="note">还没有抓取记录。点下面的「⚡ 立即抓取」${nativeFetchAvailable()
    ? "即可在本机直接抓取（不经过云端队列，通常几十秒出结果）。"
    : "可立刻触发一次云端抓取，不受定时排队影响。"}</div>`;
  const nat = !!m.native;
  const at = stampOf(m.t0);
  const what = nat ? "本机抓取" : "手动抓取";
  const run = m.runNo ? ` ｜ 运行 <b>#${esc(m.runNo)}</b>` : "";
  const clear = `<div style="margin-top:6px"><span class="more" onclick="resetManualFetch()">清除这条记录 ›</span></div>`;
  if (m.state === "running")
    return `<div class="note b"><b>⏳ ${what}进行中…</b>
      <div class="tip" style="color:inherit;margin-top:4px">${nat
        ? `开始时间 <b>${esc(at)}</b> ｜ 已处理 <b>${m.done || 0} / ${m.total || 0}</b> 只产品`
        : `触发时间 <b>${esc(at)}</b>${run}${m.dur ? " ｜ 已等 " + durTxt(m.dur) : ""}`}<br>
      ${nat ? "本机直接访问披露源，结果会逐只回填。" : (m.runNo ? "云端正在抓取，通常 1-4 分钟。" : "已提交，等待云端接单…")}本页可继续使用，出结果后这里会自动更新。${m.rules ? `<br>规则回填：${esc(m.rules)}` : ""}</div></div>`;
  if (m.state === "ok") {
    const extra = nat
      ? (m.added ? `<br>本次新增净值 <b>${m.added}</b> 条`
        : `<br>暂无新增（披露源还没更新到更新的一天）`)
      : (m.navTime
        ? `<br>云端回报的抓取时间 <b>${esc(m.navTime)}</b>` + (m.added ? ` ｜ 本次新增净值 <b>${m.added}</b> 条` : " ｜ 暂无新增（披露源还没更新）")
        : "");
    const late = (!nat && m.lateWait) ? `<br>ℹ️ 本结果在触发后 ${durTxt(m.lateWait)} 才被本机确认到（期间 App 离线或挂后台），并非云端实际耗时。` : "";
    const warn = m.fail ? `<br>⚠️ 但仍有 <b>${m.fail}</b> 只产品没拿到净值${m.msg ? "：" + esc(m.msg) : ""}` : "";
    /* 规则回填的话单独一行：它跟「净值拿到没」是两件事，混在一句里用户分不清缺的是哪个 */
    const ruleLine = m.rules ? `<br>规则回填：${esc(m.rules)}` : "";
    return `<div class="note g"><b>✅ ${what}成功</b>
      <div class="tip" style="color:inherit;margin-top:4px">${nat ? "开始" : "触发"}时间 <b>${esc(at)}</b>${run} ｜ 耗时 <b>${durTxt(m.dur)}</b>${extra}${late}${warn}${ruleLine}</div>${clear}</div>`;
  }
  if (m.state === "fail")
    return `<div class="note"><b>❌ ${what}失败</b>${m.conclusion ? `（云端结论：${esc(m.conclusion)}）` : ""}
      <div class="tip" style="color:inherit;margin-top:4px">${nat ? "开始" : "触发"}时间 <b>${esc(at)}</b>${run} ｜ 耗时 <b>${durTxt(m.dur)}</b>${m.msg ? `<br>${esc(m.msg)}` : ""}
      <br>${nat ? "可点「⚡ 立即抓取」重试；仍未取到就说明披露源当日还没更新。" : "到 GitHub 仓库的 Actions 页可看运行日志；整轮失败会自动建 Issue。"}</div>${clear}</div>`;
  if (m.state === "timeout")
    return `<div class="note"><b>⚠️ ${what}未在预期时间内完成</b>
      <div class="tip" style="color:inherit;margin-top:4px">${nat ? "开始" : "触发"}时间 <b>${esc(at)}</b>${run}<br>
      ${nat ? (m.msg ? esc(m.msg) : "App 可能被系统回收或网络中断，重试即可。")
        : "已等超过 12 分钟仍未拿到结论（GitHub 免费账号偶发排队）。可点「↓ 从云端拉取」直接看数据到没到。"}</div>${clear}</div>`;
  return `<div class="note"><b>⚠️ ${what}未能确认结果</b>
    <div class="tip" style="color:inherit;margin-top:4px">${nat ? "开始" : "触发"}时间 <b>${esc(at)}</b>${run}${m.msg ? "<br>" + esc(m.msg) : ""}<br>请点「↓ 从云端拉取」核对数据是否已更新。</div>${clear}</div>`;
}
/* 就地刷新状态条与「云端最近一次抓取」——不整页重画，避免弹层滚动位置被重置 */
function renderManBox() {
  const box = $("manFetchBox"); if (box) box.innerHTML = manStatusHtml();
  const t = $("navSyncTime");
  if (t) {
    const last = (DATA.settings && DATA.settings.lastNavSync) || "";
    t.className = "note " + (last ? "g" : "");
    t.textContent = last || "暂无记录（云端抓取任务尚未写入）";
  }
}
function resetManualFetch(silent) {
  clearTimeout(_manPollTimer); _manPolling = false;
  MANUAL = {}; saveManual(); renderManBox();
  if (!silent) toast("已清除手动抓取记录");
}
/* 触发后追踪运行结果；重开弹层 / App 重启都会接着追 */
function ensureManualPolling() {
  /* 本机抓取没有 run id 可查；只需收口「App 被杀导致一直转圈」的陈旧记录 */
  if (MANUAL && MANUAL.native) {
    if (MANUAL.state === "running" && Date.now() > (MANUAL.t0 || 0) + 3 * 60000) {
      MANUAL.state = "timeout"; MANUAL.dur = Date.now() - (MANUAL.t0 || 0);
      MANUAL.msg = "上次本机抓取未完成（App 可能被系统回收或网络中断）。";
      saveManual(); renderManBox();
    }
    return;
  }
  if (_manPolling || !MANUAL || MANUAL.state !== "running") return;
  if (Date.now() > (MANUAL.t0 || 0) + 12 * 60000) {          /* 陈旧记录直接收口，别一直转圈 */
    MANUAL.state = "timeout"; MANUAL.dur = Date.now() - (MANUAL.t0 || Date.now());
    saveManual(); renderManBox(); return;
  }
  _manPolling = true;
  _manPollTimer = setTimeout(pollManualRun, 4000);           /* 稍等一下：云端接单本身有几秒延迟 */
}
async function pollManualRun() {
  clearTimeout(_manPollTimer);
  if (!MANUAL || MANUAL.state !== "running") { _manPolling = false; return; }
  const started = MANUAL.t0, deadline = started + 12 * 60000;
  try {
    if (!MANUAL.runApiId) {
      /* 取「本次触发前后 90 秒内创建」的最新一次手动运行 */
      const r = await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}/actions/workflows/update_nav.yml/runs?event=workflow_dispatch&per_page=10`);
      const cand = (r.workflow_runs || [])
        .filter(x => new Date(x.created_at).getTime() >= started - 90000)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (cand) { MANUAL.runApiId = cand.id; MANUAL.runNo = cand.run_number || ""; }
    } else {
      const x = await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}/actions/runs/${MANUAL.runApiId}`);
      if (x.status === "completed") {
        /* v33：耗时改用 GitHub 记录的 run_started_at→updated_at（真实运行时长）。
           App 挂后台/离线时轮询被冻结，Date.now()-t0 会把「确认延迟」算进耗时
           （实测出现过「耗时 120 分 52 秒」），误导用户以为云端跑了 2 小时。 */
        const rs = x.run_started_at ? new Date(x.run_started_at).getTime() : 0;
        const up = x.updated_at ? new Date(x.updated_at).getTime() : 0;
        MANUAL.dur = (rs && up && up > rs) ? (up - rs) : Math.max(0, Date.now() - started);
        const late = Date.now() - started - MANUAL.dur;
        MANUAL.lateWait = late > 90000 ? late : 0;   /* 确认延迟超 90 秒才提示 */
        MANUAL.conclusion = x.conclusion || "unknown";
        MANUAL.state = x.conclusion === "success" ? "ok" : "fail";
        if (MANUAL.state === "ok") await collectManualResult();
        saveManual(); _manPolling = false; renderManBox(); return;
      }
    }
    MANUAL.dur = Date.now() - started;
  } catch (e) {
    const s = String(e);
    if (/403/.test(s)) {   /* 令牌只有 Contents 权限时查不了运行：如实说明，别无限转圈 */
      MANUAL.state = "unknown"; MANUAL.dur = Date.now() - started;
      MANUAL.msg = "令牌缺少 Actions 读取权限，无法自动确认结果。";
      saveManual(); _manPolling = false; renderManBox(); return;
    }
    /* 其余多为网络抖动：不算失败，下一轮再试 */
  }
  renderManBox();
  if (Date.now() > deadline) {
    MANUAL.state = "timeout"; MANUAL.dur = Date.now() - started;
    saveManual(); _manPolling = false; renderManBox(); return;
  }
  _manPollTimer = setTimeout(pollManualRun, 8000);
}
/* 云端跑完后拉一次数据，顺便把「云端回报的抓取时间 / 新增条数」记进状态 */
async function collectManualResult() {
  const before = navFingerprint();
  await syncPull(false);
  const after = navFingerprint();
  const lf = lastFetchInfo();
  MANUAL.navTime = (lf && lf.time) || "";
  MANUAL.fail = lf ? (Number(lf.fail) || 0) : 0;
  MANUAL.added = Math.max(0, after.count - before.count);
  saveManual();
}
async function triggerFetch() {
  /* App 内（WebView + 内置 CPython）走本机抓取；网页端仍然派发云端 Actions */
  if (nativeFetchAvailable()) return nativeFetchAll(true);
  if (!SYNC.owner || !SYNC.repo || !SYNC.token) { toast("请先在「数据同步设置」里配置仓库与 Token"); return; }
  const btn = $("btnFetchNow");
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = "触发中…"; }
  MANUAL = { state: "running", t0: Date.now(), runNo: "", runApiId: 0, dur: 0 };
  saveManual(); renderManBox();
  const dispatch = () => ghReq("POST",
    `${GH}/repos/${SYNC.owner}/${SYNC.repo}/actions/workflows/update_nav.yml/dispatches`,
    { ref: SYNC.branch || "main" });
  try {
    try {
      await dispatch();
    } catch (e) {
      /* v32 P1-4：ref 不写死 main —— 仓库默认分支不是 main 时 dispatch 会 404，
         此时探一次 default_branch 缓存下来并重试（平时零额外请求）。 */
      if (!/404/.test(String(e))) throw e;
      const repo = await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}`);
      SYNC.branch = (repo && repo.default_branch) || "main"; saveSync();
      await dispatch();
    }
    toast("已触发云端抓取，结果会自动出现在弹层里（约 1-4 分钟）", 4800);
    _manPolling = false; ensureManualPolling();      /* 触发成功即开始追踪运行结果 */
  } catch (e) {
    const s = String(e);
    MANUAL.state = "unknown"; MANUAL.dur = Date.now() - MANUAL.t0;
    if (/403/.test(s)) {
      MANUAL.msg = "令牌缺少 Actions 权限：GitHub → 令牌设置 → Repository permissions 里 Actions 勾 Read and write（改权限不换令牌值）。";
      toast("令牌缺少 Actions 权限：GitHub → 令牌设置 → Repository permissions 里 Actions 勾 Read and write（改权限不换令牌值）", 7000);
    } else if (/404/.test(s)) {
      MANUAL.msg = "触发失败：仓库里没有 update_nav.yml，或 Token 无权访问该仓库。";
      toast("触发失败：仓库里没有 update_nav.yml，或 Token 无权访问该仓库", 5200);
    } else {
      MANUAL.msg = "触发失败：" + s.slice(0, 120);
      toast("触发失败：" + s.slice(0, 90), 4200);
    }
    saveManual(); renderManBox();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⚡ 立即抓取"; }
  }
}
/* ============================================================
   本机抓取（仅 Android App 内生效）
   ------------------------------------------------------------
   网页端没有 window.NativeNav，本整段代码不会被触发，仍然走云端 Actions。
   App 内由 NavBridge 调起内置 CPython 的 navservice.fetch_one → fetch_nav.py，
   合并规则（已有净值不覆盖 + 单日 >10% 跳变拦截）完全复用 Python 的
   merge_nav，前端只负责落盘、渲染与推送，避免两套算法漂移。
   ============================================================ */
const _navDone = {};
let _nativeBusy = false;

/* ---------- 秒讯 / 净值账本（可选）：两把登录态都在 App 的本机加密区 ----------
   v78：秒讯 token 不再进 localStorage。值只在原生侧（NavBridge + SecretStore / Android Keystore），
   页面只问得到「有没有」（NativeNav.aixhubHas()），交出去的那一轮抓取由原生侧自己把值塞进载荷。
   以前这里是 licai.aixhubToken 明文一条，磁盘上可读、DevTools 一展开就是它 —— 铁律 #6 不接受。
   v79：净值账本那把 Cookie 走同一条路（SecretStore 第三个槽 + NativeNav.ledgermeHas()）。
   Cookie 和 token 是同一类东西：拿到就等于顶着用户的账号去要数据。它以前躺在
   licai.ledgermeCookie 里，明文、可读、不清缓存就一直在 —— 现在页面手里没有它，
   粘贴那一次交给原生侧落盘，之后每一轮抓取都由原生侧注入。 */
const AIX_LS = {
  email: "licai.aixhubEmail",
  at: "licai.aixhubAt", lic: "licai.aixhubLic", chk: "licai.aixhubChk"
};
const AIX_LEGACY_TOKEN = "licai.aixhubToken";   /* 历史遗留的明文键，见到就删，不读不传 */
const LGM_LS = {
  user: "licai.ledgermeUser",
  name: "licai.ledgermeName", at: "licai.ledgermeAt", chk: "licai.ledgermeChk"
};
const LGM_LEGACY_COOKIE = "licai.ledgermeCookie";   /* 同上：只删不读 */
const _aixDone = {};
let _aixChecking = false, _aixAutoTried = false;
let _lgmChecking = false, _lgmAutoTried = false;
function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }
/* 老版本存在 localStorage 里的那两把明文登录态：删掉它们，值就只留在加密区。
   不读它们、不拿它们去试登录、也不发给任何一侧 —— 删就是删。 */
function aixhubPurgeLegacy() { lsDel(AIX_LEGACY_TOKEN); }
aixhubPurgeLegacy();
function ledgermePurgeLegacy() { lsDel(LGM_LEGACY_COOKIE); }
ledgermePurgeLegacy();
function aixhubEmail() { return lsGet(AIX_LS.email); }
function ledgermeUser() { return lsGet(LGM_LS.user); }
function ledgermeName() { return lsGet(LGM_LS.name); }
/* 登录态的唯一来源是原生侧：这里不缓存、不猜 —— 每次画这一行都现问一次。 */
function aixhubLoggedIn() {
  try {
    const n = window.NativeNav;
    if (!n || typeof n.aixhubHas !== "function") return false;
    return !!n.aixhubHas();
  } catch (e) { return false; }
}
/* 桥在、但没有这个方法 = 这台机器的 App 还不认识加密区（v77 及以前的壳）。
   这种情况照实说，别画成「没登录」让用户白重登一遍。 */
function aixhubShellOld() {
  try {
    return nativeFetchAvailable()
      && typeof window.NativeNav.aixhubHas !== "function";
  } catch (e) { return false; }
}
/* v79：净值账本那把 Cookie 走同一条路 —— 页面只问「加密区里有没有」，值本身一次都不经过 JS。
   （用户粘贴那一次是例外：那一回由页面直接交给原生侧落盘，见 ledgermeLoginFlow。） */
function ledgermeLoggedIn() {
  try {
    const n = window.NativeNav;
    if (!n || typeof n.ledgermeHas !== "function") return false;
    return !!n.ledgermeHas();
  } catch (e) { return false; }
}
/* 桥在、但没有 ledgermeHas = 这台机器的 App 还不认识第三个槽（v78 及以前的壳）。
   那种壳上 Cookie 本来还躺在明文键里，而这一版页面已经把它删了 —— 照实说，
   别画成「没登录」让用户以为是自己掉的线，也别假装还能连。 */
function ledgermeShellOld() {
  try {
    return nativeFetchAvailable()
      && typeof window.NativeNav.ledgermeHas !== "function";
  } catch (e) { return false; }
}
function aixhubLic() {
  try {
    const o = JSON.parse(lsGet(AIX_LS.lic) || "null");
    return o && typeof o === "object" ? o : null;
  } catch (e) { return null; }
}
function aixhubLicInfo() {
  const l = aixhubLic();
  if (!l) return { known: false, expired: false, days: 0, until: "" };
  let exp = Number(l.expires_at) || 0;
  if (exp > 1e11) exp /= 1000;              /* 兼容毫秒；秒讯前端用的是秒 */
  let days = Number(l.remaining_days);
  if (exp) days = Math.max(0, Math.ceil((exp * 1000 - Date.now()) / 86400000));
  else if (!Number.isFinite(days)) days = 0;
  const expired = (l.state && l.state !== "active") || (exp > 0 && exp * 1000 <= Date.now());
  return {
    known: true, expired: !!expired, days: Math.max(0, days),
    until: exp ? stampOf(exp * 1000).slice(0, 10) : "", state: l.state || ""
  };
}
window.__aixDone = function (id, res) {
  const f = _aixDone[id]; if (!f) return;
  delete _aixDone[id]; f(res);
};
function aixhubBridge(method, args, label) {
  return new Promise(resolve => {
    if (!nativeFetchAvailable()) return resolve({ ok: false, message: (label || "秒讯登录") + "只在 Android App 内可用" });
    const id = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const timer = setTimeout(() => { delete _aixDone[id]; resolve({ ok: false, message: "超时，请重试" }); }, 30000);
    _aixDone[id] = r => { clearTimeout(timer); resolve(r || { ok: false }); };
    try { window.NativeNav[method].apply(window.NativeNav, [id].concat(args)); }
    catch (e) { clearTimeout(timer); delete _aixDone[id]; resolve({ ok: false, message: String(e) }); }
  });
}

/* 秒讯：/api/me?compact=1 的 license 里有 expires_at（秒）/state。
   以前只存 token，不看这个字段，所以只能等抓取撞 401 才知道失效。
   v78：这一趟不再需要页面交出 token —— 原生侧自己从加密区取；401 时也是让原生侧清。 */
async function aixhubCheck(silent) {
  if (!nativeFetchAvailable() || _aixChecking) return null;
  _aixChecking = true;
  const r = await aixhubBridge("aixhubMe", []);
  _aixChecking = false;
  if (r && r.ok) {
    lsSet(AIX_LS.lic, JSON.stringify(r.license || {}));
    lsSet(AIX_LS.chk, Date.now());
    renderAixhub();
    if (!silent) {
      const li = aixhubLicInfo();
      toast(li.expired
        ? "秒讯会员已到期/状态异常；官网抓取不受影响"
        : `秒讯登录有效${li.days ? "，会员剩余 " + li.days + " 天" : ""}`, 4200);
    }
    return r;
  }
  const msg = String((r && r.message) || "网络异常");
  if (Number(r && r.status) === 401) {
    /* 服务端说这个登录态废了：让原生侧清掉加密区里的那一份（页面手里本来就没有它） */
    try { window.NativeNav.aixhubClear(); } catch (e) { }
    lsDel(AIX_LS.lic); lsDel(AIX_LS.at);
    renderAixhub();
    if (!silent) toast("秒讯登录已失效，请重新登录（邮箱已记住）", 5200);
  } else if (!silent) {
    toast("秒讯状态检查失败：" + msg.slice(0, 90), 5200);
  }
  return null;
}
function aixhubCheckNow() { aixhubCheck(false); }
async function aixhubLoginFlow() {
  if (!nativeFetchAvailable()) return toast("秒讯登录只在 Android App 内可用（网页版没有本机桥）", 4600);
  if (aixhubShellOld()) {
    return toast("这台机器的 App 还不认识本机加密区（v77 及以前的壳）：先更新 App 再登录", 5600);
  }
  const email = (prompt("秒讯账号邮箱", aixhubEmail() || "") || "").trim().toLowerCase();
  if (!email) return;
  toast("正在发送验证码…", 1800);
  const s = await aixhubBridge("aixhubSend", [email]);
  if (!s.ok) return toast(s.message || "验证码发送失败", 5200);
  const code = (prompt("验证码已发到 " + email + "（10 分钟内有效）", "") || "").trim();
  if (!code) return;
  const r = await aixhubBridge("aixhubLogin", [email, code]);
  /* 回话里没有 token，只有 hasToken：值已经在本机加密区了，页面手里什么都没有 */
  if (!r.ok || !r.hasToken) return toast(r.message || "登录失败", 5200);
  lsSet(AIX_LS.email, email);
  lsDel(AIX_LS.at);
  renderAixhub();
  /* 登录后立刻读一次 license：把“还剩几天/是否已到期”显示出来 */
  const me = await aixhubBridge("aixhubMe", []);
  if (me && me.ok) { lsSet(AIX_LS.lic, JSON.stringify(me.license || {})); lsSet(AIX_LS.chk, Date.now()); }
  renderAixhub();
  const li = aixhubLicInfo();
  toast(me && me.ok && !li.expired
    ? `秒讯已登录${li.days ? "，会员剩余 " + li.days + " 天" : ""}，下一轮抓取会用它的数据`
    : "秒讯已登录，下一轮抓取会用它的数据", 4600);
  try { setTimeout(() => nativeFetchAll(true), 300); } catch (e) { }
}
function aixhubLogout() {
  /* 清的是加密区里那一份；页面顺手把本机缓存的到期快照也抹掉 */
  try { if (window.NativeNav && typeof window.NativeNav.aixhubClear === "function") window.NativeNav.aixhubClear(); } catch (e) { }
  lsDel(AIX_LS.at); lsDel(AIX_LS.lic); lsDel(AIX_LS.chk);
  aixhubPurgeLegacy();
  renderAixhub();
  toast("已退出秒讯，只走官网 + 中国理财网");
}
function renderAixhub() {
  const box = $("aixhubBox"); if (!box) return;
  syncAppOnly();
  /* 网页版：卡片已被 CSS 收掉，这里连内容都不渲染，那个 6 小时一次的自动检查
     定时器更不能起 —— 起了也只是每六小时撞一次「仅 App 可用」。 */
  if (!nativeFetchAvailable()) { box.innerHTML = ""; return; }
  /* 新页面 + 旧壳：这座桥还不认识加密区。画一句实话，别画成「没登录」骗人白重登。 */
  if (aixhubShellOld()) {
    box.innerHTML = `<div class="note b">这台机器的 App 还不认识本机加密区（v77 及以前的壳）。
      秒讯的登录态现在只存在 App 的加密区里，页面不再保存它 —— 先更新 App 再登录。
      不更新不影响官网 + 中国理财网那条线照抓。</div>`;
    return;
  }
  const on = aixhubLoggedIn();
  const li = aixhubLicInfo();
  let status = "";
  if (on) {
    if (li.known) {
      status = li.expired
        ? `<br><span style="color:var(--up)">会员已到期/状态异常${li.until ? "（到期日 " + li.until + "）" : ""}</span>`
        : `<br>会员剩余 <b>${li.days}</b> 天${li.until ? "（至 " + li.until + "）" : ""}`;
    } else {
      status = `<br>登录状态待检查`;
    }
  }
  box.innerHTML = `
    <div class="note ${on && !li.expired ? "g" : ""}">${on
      ? `已登录：<b>${esc(aixhubEmail() || "秒讯账号")}</b>${status}<br>
         登录态只存在本机加密区（Android Keystore），页面与浏览器都读不到它。<br>
         只有你点<b>「⚡ 立即抓取」</b>时才查一次秒讯（3 分钟内不重复），
         后台自动轮询不碰它；同一天以官网数值为准。`
      : `可选。秒讯（第三方监控站）的代销净值比官网快，但它要登录后才能读 ——
         登录后点「⚡ 立即抓取」会顺带查它一次，抢在官网更新前把最新一天补上。<br>
         <b>没登录也能用</b>：只走官网 + 中国理财网。`}</div>
    <div class="row-btn" style="margin-top:10px;flex-wrap:wrap">
      <button class="btn ${on ? "gh" : "pri"}" style="flex:1 1 45%" onclick="aixhubLoginFlow()">${on ? "重新登录" : "秒讯登录"}</button>
      ${on ? `<button class="btn gh" style="flex:1 1 45%" onclick="aixhubCheckNow()">检查状态</button>` : ""}
      ${on ? `<button class="btn gh" style="flex:1 1 45%" onclick="aixhubLogout()">退出秒讯</button>` : ""}
    </div>`;
  if (on && !_aixAutoTried) {
    _aixAutoTried = true;
    let chk = 0; try { chk = Number(lsGet(AIX_LS.chk) || 0); } catch (e) { }
    if (Date.now() - chk > 6 * 3600 * 1000) setTimeout(() => { aixhubCheck(true); }, 80);
  }
}

/* 净值账本：站点的 /api/*nav 都要登录 Cookie；只用用户本人粘贴的会话，不绕过登录。
   v79：这一趟不再需要页面交出 Cookie —— 原生侧自己从加密区取；判定失效时也是请原生侧清，
   页面手里从头到尾没有那个值（铁律 #6）。 */
async function ledgermeCheck(silent) {
  if (!nativeFetchAvailable() || _lgmChecking || !ledgermeLoggedIn()) return null;
  _lgmChecking = true;
  const r = await aixhubBridge("ledgermeCheck", [], "净值账本");
  _lgmChecking = false;
  if (r && r.ok) {
    lsSet(LGM_LS.user, r.user || "");
    lsSet(LGM_LS.name, r.name || "");
    lsSet(LGM_LS.chk, Date.now());
    renderLedgerme();
    if (!silent) toast("净值账本连接正常" + (r.name || r.user ? "：" + (r.name || r.user) : ""), 3600);
    return r;
  }
  const dead = Number(r && r.status) === 401 || /401|Cookie|登录|失效|unauthor/i.test(String((r && r.message) || ""));
  if (dead) {
    ledgermeClearNative();
    lsDel(LGM_LS.user); lsDel(LGM_LS.name); lsDel(LGM_LS.at); lsDel(LGM_LS.chk);
    ledgermePurgeLegacy();
    renderLedgerme();
  }
  if (!silent) toast(String((r && r.message) || "Cookie 检查失败").slice(0, 100), 5200);
  return null;
}
/* 请原生侧清掉加密区里那一份。方法在不在都要能站住：v78 及以前的壳没有它，
   那种机器上这行是空动作，页面画的那句实话由 ledgermeShellOld() 负责。 */
function ledgermeClearNative() {
  try {
    if (window.NativeNav && typeof window.NativeNav.ledgermeClear === "function") window.NativeNav.ledgermeClear();
  } catch (e) { }
}
function ledgermeCheckNow() { ledgermeCheck(false); }
async function ledgermeLoginFlow() {
  if (!nativeFetchAvailable()) return toast("净值账本连接只在 Android App 内可用（网页版没有本机桥）", 4600);
  if (ledgermeShellOld()) {
    return toast("这台机器的 App 还不认识加密区里的账本槽（v78 及以前的壳）：先更新 App 再连接", 5600);
  }
  const tip = "把 ledgerme.me 的登录 Cookie 粘贴到这里\n"
    + "（电脑/手机浏览器登录后：开发者工具 → Network → 任意 /api 请求 → Request Headers → Cookie）\n"
    + "验证通过就直接存进 App 的本机加密区，页面不保存它";
  /* 不回填旧值：页面手里根本没有它 */
  const c = (prompt(tip, "") || "").trim();
  if (!c) return;
  toast("正在验证 Cookie…", 1800);
  /* 值交给原生侧落盘（SecretStore 第三个槽）。回话里只有 hasCookie 这个布尔：
     验证没过原生侧就不存，页面没有「先存着再说」这条路。 */
  const r = await aixhubBridge("ledgermeSet", [c], "净值账本");
  if (!r || !r.ok || !r.hasCookie) return toast(String((r && r.message) || "Cookie 无效").slice(0, 100), 5600);
  lsSet(LGM_LS.user, r.user || "");
  lsSet(LGM_LS.name, r.name || "");
  lsSet(LGM_LS.chk, Date.now());
  lsDel(LGM_LS.at);
  ledgermePurgeLegacy();
  renderLedgerme();
  toast("净值账本已连接，Cookie 只存在本机加密区；手动抓取时会多查一条渠道", 4200);
}
function ledgermeLogout() {
  /* 清的是加密区里那一份；页面顺手把本机缓存的身份快照也抹掉 */
  ledgermeClearNative();
  lsDel(LGM_LS.user); lsDel(LGM_LS.name);
  lsDel(LGM_LS.at); lsDel(LGM_LS.chk);
  ledgermePurgeLegacy();
  renderLedgerme();
  toast("已断开净值账本，只走官网 + 中国理财网");
}
function renderLedgerme() {
  const box = $("ledgermeBox"); if (!box) return;
  syncAppOnly();
  if (!nativeFetchAvailable()) { box.innerHTML = ""; return; }
  /* 新页面 + 旧壳：这座桥还不认识第三个槽。画一句实话，别画成「没登录」骗人白粘一遍。 */
  if (ledgermeShellOld()) {
    box.innerHTML = `<div class="note b">这台机器的 App 还不认识加密区里的账本槽（v78 及以前的壳）。
      净值账本的 Cookie 现在只存在 App 的本机加密区里，页面不再保存它 —— 先更新 App 再连接。
      不更新不影响官网 + 中国理财网那条线照抓。</div>`;
    return;
  }
  const on = ledgermeLoggedIn();
  const who = ledgermeName() || ledgermeUser();
  box.innerHTML = `
    <div class="note ${on ? "g" : ""}">${on
      ? `已连接：<b>${esc(who || "ledgerme.me")}</b><br>
         只在点<b>「⚡ 立即抓取」</b>时查一次（3 分钟内不重复）。Cookie 只存在本机加密区
         （Android Keystore），页面与浏览器都读不到它；断开即从加密区删除。`
      : `可选。ledgerme.me（欣盈净值账本）是另一条账本/代销渠道。它的净值接口要登录，<br>
         需要你在浏览器登录后把 <b>Cookie</b> 粘贴进来；不登录不影响官网抓取。<br>
         <span class="muted">仅使用你本人账号的会话，不绕过登录、不保存密码；粘贴的 Cookie 直接进本机加密区，不写进浏览器缓存。</span>`}</div>
    <div class="row-btn" style="margin-top:10px;flex-wrap:wrap">
      <button class="btn ${on ? "gh" : "pri"}" style="flex:1 1 45%" onclick="ledgermeLoginFlow()">${on ? "更新 Cookie" : "连接净值账本"}</button>
      ${on ? `<button class="btn gh" style="flex:1 1 45%" onclick="ledgermeCheckNow()">检查连接</button>` : ""}
      ${on ? `<button class="btn gh" style="flex:1 1 45%" onclick="ledgermeLogout()">断开</button>` : ""}
    </div>`;
  if (on && !_lgmAutoTried) {
    _lgmAutoTried = true;
    let chk = 0; try { chk = Number(lsGet(LGM_LS.chk) || 0); } catch (e) { }
    if (Date.now() - chk > 6 * 3600 * 1000) setTimeout(() => { ledgermeCheck(true); }, 120);
  }
}
function nativeFetchAvailable() {
  try { return !!(window.NativeNav && window.NativeNav.ready && window.NativeNav.ready()); }
  catch (e) { return false; }
}
/* 本机壳的 origin —— 和私有仓 MainActivity.HOST 是同一个值，那边改了这边要跟。
   它是个结构性事实：这个 origin 只有本机壳会提供，Pages 那个 origin 永远不可能有桥。
   v68 起挂桥的时机也改了：三个桥只在 loadUrl 之前挂一次，origin 检查搬到每次调用时做
   （旧写法在 onPageStarted 里 add/remove，而那一刻这一份文档的 JS context 已经建好了 ——
     切后台被回收后重加载文档就再也看不到桥，用户报的「切回来变成网页版」是这么来的）。
   所以「在不在 App 里」信 origin，「这一刻能不能用」还得看桥在不在，两件事分开判。 */
const SHELL_HOST = "appassets.androidplatform.net";
function inShellHost() {
  try { return location.hostname === SHELL_HOST; } catch (e) { return false; }
}
/** 壳里桥没挂上时该说的话。不许再退回「只在 App 内可用」—— 用户已经在 App 里了。 */
const SHELL_NO_BRIDGE = "本机壳的桥在这一页没挂上（App 切后台被系统回收后偶发）：退回桌面再进来一次就恢复。"
  + "这不是网页版 —— 数据与密钥都在本机，这一次没有调用原生能力。";
function bridgeMissingMsg(webMsg) {
  return inShellHost() ? SHELL_NO_BRIDGE : webMsg;
}
/* 这一份文档里认出来过一次就不反悔：桥是挂上就不会掉的，
   中途某一次 ready() 抖动就把两节收掉，用户看到的就是「刚才还在，现在没了」。 */
let appOnlySeen = false;
let appOnlyTimer = 0;
/* 秒讯 / 净值账本这两节只在 App 里出现。
   理由是硬的：两个站都不给跨域许可 —— 实测 aixhub 的 /api/auth/send-code 连预检
   OPTIONS 都回 501，GET/POST 的响应里一个 Access-Control-Allow-Origin 都没有，
   ledgerme 同样。网页版发出去必然被浏览器拦死，那就别留一个点了只会回一句
   「仅 App 可用」的按钮：整节收掉，网页版根本不提这件事。
   类打在 <html> 上、藏人靠 CSS —— 卡片标题是 index.html 里的静态 HTML，
   等 renderAixhub 跑起来再逐个藏会闪一下。
   v59：判定不再只看「按下这一刻桥在不在」。桥是在壳里 onPageStarted 才挂的，
   冷启动 / 进程被回收后恢复时它可能比第一次 renderSet 晚到一步，旧写法判空了就
   整会话都看不见这两节（用户报的「有时候消失」就是这么来的）。现在三层兜：
   本机壳 origin 直接算数 → 认出来过就不反悔 → 都没认出来时排队重试，
   桥一到就补上并把设置页重画。网页版三个条件一个都不满足，照旧整节收掉。 */
function syncAppOnly() {
  const on = inShellHost() || nativeFetchAvailable();
  if (on) {
    appOnlySeen = true;
    if (appOnlyTimer) { clearInterval(appOnlyTimer); appOnlyTimer = 0; }
    document.documentElement.classList.add("inApp");
    return;
  }
  if (appOnlySeen) return;
  document.documentElement.classList.remove("inApp");
  if (!appOnlyTimer) armAppOnlyRetry();
}
function armAppOnlyRetry() {
  let n = 0;
  appOnlyTimer = setInterval(() => {
    /* 桥晚到会走到这里；约 5 秒内还没来就当它是网页版，别再空转 */
    if (inShellHost() || nativeFetchAvailable()) {
      clearInterval(appOnlyTimer); appOnlyTimer = 0;
      syncAppOnly();
      /* 这两节的内容是被守卫清空过的，光补类只剩两个空标题，得连渲染一起补 */
      const set = $("pg-set");
      if (set && set.classList.contains("on")) renderSet();
      return;
    }
    if (++n >= 12) { clearInterval(appOnlyTimer); appOnlyTimer = 0; }
  }, 400);
}
window.__navDone = function (id, res) {
  const f = _navDone[id]; if (!f) return;
  delete _navDone[id]; f(res);
};
function nativeNavFetch(p, withAixhub, withLedgerme) {
  return new Promise(resolve => {
    const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let settled = false;
    const finish = r => { if (settled) return; settled = true; delete _navDone[id]; resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: "本机抓取超时（90 秒）" }), 90000);
    _navDone[id] = r => { clearTimeout(timer); finish(r); };
    try {
      window.NativeNav.fetch(id, JSON.stringify({
        prodCode: prodCodeOf(p),
        regCode: String(p.regCode || p.code || "").trim(),
        name: String(p.name || ""),
        inst: String(p.inst || ""),
        navHistory: p.navHistory || {},
        /* v78：只交「这一轮要不要查秒讯」这个布尔值；token 由原生侧从加密区注入。
           v79：净值账本那条同理 —— 页面也只交布尔，Cookie 由原生侧注入，值不经过 JS。 */
        aixhub: !!withAixhub,
        ledgerme: !!withLedgerme
      }));
    } catch (e) { clearTimeout(timer); finish({ ok: false, error: String(e) }); }
  });
}
/* ---------- T1b：官网产品档案 → 底层/申赎规则的自动回填 ----------
   复用净值那条桥：同一个 NativeNav.fetch，多带一个 mode:"rules"，
   Python 侧在 navservice._fetch_rules 分派，不另开一个桥方法（也不另开一条线程）。
   fetchedAt 由页面盖：规则解析那一侧不读时钟，谁的表谁写 —— 披露日期另有其人
   （disc.source.publishedAt，站内自己写的那个），两者不许混。 */
function nativeRulesFetch(p) {
  return new Promise(resolve => {
    if (!nativeFetchAvailable()) {
      /* 网页版没有原生抓取，这条就是走不了 —— 如实说，不假装在跑（铁律 10） */
      resolve({ ok: false, error: bridgeMissingMsg("网页版没有本机抓取，规则自动回填用不了：底层规则请手工录入") });
      return;
    }
    const id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let settled = false;
    const finish = r => { if (settled) return; settled = true; delete _navDone[id]; resolve(r); };
    /* 徽银要先在官网列表里翻页找产品（实测单只 90~96 秒），90 秒那条超时是净值抓取的口径，
       照搬过来就会天天误报；这里给 240 秒，到点如实报「这一次没翻到」。 */
    const timer = setTimeout(() => finish({ ok: false, error: "本机规则检索超时（240 秒）：这一次没翻到，下次同步再试" }), 240000);
    _navDone[id] = r => { clearTimeout(timer); finish(r); };
    try {
      window.NativeNav.fetch(id, JSON.stringify({
        prodCode: prodCodeOf(p),
        regCode: String(p.regCode || p.code || "").trim(),
        name: String(p.name || ""),
        inst: String(p.inst || ""),
        mode: "rules",
        fetchedAt: new Date().toISOString()
      }));
    } catch (e) { clearTimeout(timer); finish({ ok: false, error: String(e) }); }
  });
}

/* 回填结果怎么说：补了什么、手工挡住了什么、还缺什么都要照实念一遍。
   「仍缺：赎回费分档」这类话必须出现在前台 —— 界面少说一句，用户就会以为账本是齐的。 */
function rulesResultText(res) {
  const zh = k => DISC_GAP_LABEL[k] || k;
  const left = (res.gaps || []).filter(g => g !== "source");
  const bits = [];
  bits.push(res.filled.length ? "已按官网档案回填：" + res.filled.map(zh).join("、")
    : "官网档案里没有可补的项");
  if (res.kept.length) bits.push("手工录入的不覆盖（" + res.kept.map(zh).join("、") + "）");
  if (left.length) bits.push("仍缺：" + left.map(zh).join("、"));
  return bits.join(" · ");
}

/* 只接了三家（第一期）。机构名和代码前缀都认一下：
   用户常常只填代码不填机构，而对没接入的机构白跑一趟、还说一句「网页版用不了」，
   那是把两件不相干的事说成一件事。 */
const RULES_ORGS = /(北银|徽银|农银)理财/;
const RULES_CODES = /^(PNHY|YJ|ADTC)/i;
function rulesOrgOk(p) {
  return RULES_ORGS.test(String((p && p.inst) || ""))
    || RULES_CODES.test(String((p && p.prodCode) || "").trim());
}

/**
 * 跑一次规则回填（就地改 p.disc，并落盘）。返回给用户看的一句话；不该跑时返回 ""。
 * trigger："add" 添加产品当场说一句，"sync" 跟着本机抓取那一趟走（写进抓取框）。
 */
async function autoFillRules(p, trigger) {
  if (!p || !rulesOrgOk(p) || !rulesDue(p)) return "";
  /* 网页版 / 桥没挂上：这条整段走不了。先说清楚再回来，也不写 rulesAt ——
     rulesAt 的意思是「真的试过一趟」，没发出去的请求不许给自己盖这个章。 */
  if (!nativeFetchAvailable()) {
    return bridgeMissingMsg("网页版没有本机抓取，规则自动回填用不了：在产品页「底层配置与申赎规则」里手工录入");
  }
  const say = m => {
    if (MANUAL && MANUAL.t0) { MANUAL.rules = m; saveManual(); renderManBox(); }
    if (trigger === "add") toast(m, 6500);
    return m;
  };
  /* 徽银那一站没有按代码直查的接口，只能一页一页翻（实测 129 页、单只 90~96 秒）：
     慢不是 bug，但必须提前说 —— 不然用户看到的是「点了没反应」。 */
  if (/徽银/.test(String(p.inst || "")) || /^PNHY/i.test(String(p.prodCode || ""))) {
    say("徽银理财没有按代码直查的接口，要在官网产品列表里翻页找这只产品，可能要一两分钟…");
    if (trigger === "add") toast("徽银在翻页找产品，可能要一分钟…", 6000);
  }
  const r = await nativeRulesFetch(p);
  /* 试过就是试过了：成败都写 rulesAt，否则每次同步都去翻一遍 129 页 */
  p.rulesAt = new Date().toISOString();
  if (!r || !r.ok) {
    saveLocal();
    return say("官网规则这次没读到：" + ((r && r.error) || "没有回包") + "（不改账面，下次同步再试）");
  }
  const res = applyAutoDisc(p, r);
  if (!res.ok) {
    saveLocal(); renderProd(); renderHome();
    return say("官网档案里没读到披露日期 —— 按铁律不入账，只记缺口："
      + (res.gaps || []).map(g => DISC_GAP_LABEL[g] || g).join("、"));
  }
  if (res.filled.length) { saveLocal(); renderProd(); renderHome(); autoPush(); }
  return say(rulesResultText(res));
}

async function nativeFetchAll(forceExtra) {
  if (_nativeBusy) return;
  /* 本机抓取不依赖 GitHub：没配同步也能抓、能落盘；配了才会在抓到新净值后自动推送 */
  const list = DATA.products.filter(p => fetchStatus(p).ok);
  if (!list.length) { toast("没有可抓取的产品：请先在「交易」页的产品列表补填产品代码或登记编码"); return; }
  _nativeBusy = true;
  /* 手动抓取前先确认秒讯登录态：过期就提前跳过，别等每只产品都撞一次 401。 */
  if (forceExtra && aixhubLoggedIn()) await aixhubCheck(true);
  /* 秒讯 / 净值账本只在你手动点「⚡ 立即抓取」时查（各 3 分钟内不重复）：
     它们的接口要登录态，后台定时轮询既没必要、也容易被风控；官网那条线照旧自动跑。 */
  /* 秒讯：会员到期也照样去问一次。
     以前是本地看 license.state/expires_at 就先跳过，等于替它做了决定 —— 而那个字段
     是本机缓存的旧快照（到期日按天算，跨过去的那一刻起就一直在「已到期」），
     实际站方续费、宽限、改口径都不会同步过来。用户要的是「照抓，抓不到再说」，
     所以这里只问原生侧「加密区里有没有登录态」；到期与否由服务器回什么话来决定
     （403/会员 → 提示，401 → 才算登录失效，并请原生侧清掉加密区里那一份）。
     顺带去掉那句每次打开都会弹一次的状态提示：本机抓取是自动跑的，
     一个「这次跳过秒讯」的 toast 每天要按十几次，纯噪音。真取不到下面会报。 */
  const aixOn = aixhubLoggedIn();
  let lastAix = 0;
  try { lastAix = Number(localStorage.getItem(AIX_LS.at) || 0); } catch (e) { }
  const withAixhub = aixOn && !!forceExtra && Date.now() - lastAix > 3 * 60000;
  if (aixOn && forceExtra && !withAixhub) {
    toast("秒讯 3 分钟内刚查过，这次只抓官网（不影响结果）", 3000);
  }
  if (withAixhub) lsSet(AIX_LS.at, Date.now());

  /* v79：这里只问原生侧「加密区里有没有」，页面手里再也没有那个值 */
  const lgmOn = ledgermeLoggedIn();
  let lastLgm = 0;
  try { lastLgm = Number(localStorage.getItem(LGM_LS.at) || 0); } catch (e) { }
  const withLedgerme = lgmOn && !!forceExtra && Date.now() - lastLgm > 3 * 60000;
  if (lgmOn && forceExtra && !withLedgerme) {
    toast("净值账本 3 分钟内刚查过，这次只抓官网（不影响结果）", 3000);
  }
  if (withLedgerme) lsSet(LGM_LS.at, Date.now());

  let aixErr = "", lgmErr = "";
  try { localStorage.setItem("licai.nativeFetchAt", String(Date.now())); } catch (e) { }
  const t0 = Date.now();
  MANUAL = { state: "running", t0, native: true, total: list.length, done: 0, added: 0, fail: 0 };
  saveManual(); renderManBox();
  const btn = $("btnFetchNow");
  if (btn) { btn.disabled = true; btn.textContent = "本机抓取中…"; }

  let added = 0, fail = 0, last = "";
  const fails = [], srcMap = {}, fetchedNavs = {}, ruleNotes = [];
  const runOne = async p => {
    /* 已经有今天的净值就没必要再问秒讯，进一步减少请求 */
    const l0 = latestNav(p);
    const wantAix = withAixhub && (!l0 || l0[0] < today());
    const wantLgm = withLedgerme && (!l0 || l0[0] < today());
    const r = await nativeNavFetch(p, wantAix, wantLgm);
    MANUAL.done = (MANUAL.done || 0) + 1;
    if (r && r.sources) {
      for (const s of r.sources) {
        if (s.src === "aixhub" && s.error) aixErr = s.error;
        if (s.src === "ledgerme" && s.error) lgmErr = s.error;
      }
    }
    if (r && r.ok) {
      /* 抓取是异步的：期间 syncPull 可能已经把 DATA 整体换成云端对象，
         这里按 id 重新定位，避免把新净值写进已被替换掉的旧对象而丢失 */
      const p2 = DATA.products.find(x => x.id === p.id) || p;
      const navs = r.navs || {}, n = Object.keys(navs).length;
      if (n) {
        fetchedNavs[p.id] = Object.assign(fetchedNavs[p.id] || {}, navs);
        p2.navHistory = p2.navHistory || {};
        Object.assign(p2.navHistory, navs);
        if (r.meta) for (const k in r.meta) if (!p2[k] && r.meta[k]) p2[k] = r.meta[k];
        added += n;
        saveLocal(); renderHome(); renderProd();
      }
      if (r.latest) {
        last = r.latest;
        /* 逐源明细（官网 / 中国理财网各自的披露日期）：产品详情页「最新净值取自…」读这里 */
        srcMap[p.id] = {
          latest: r.latest, via: r.via || "官网", label: r.label || "",
          why: r.why || "", sources: r.sources || [], conflicts: r.conflicts || []
        };
      }
    } else {
      fail++;
      fails.push(prodLabel(p) + "：" + ((r && r.error) || "未知错误"));
    }
    /* T1b：净值这一趟完了，再按冷却补一次底层/申赎规则（同一次运行里连着做：
       徽银那份列表索引还热着，省掉第二次翻页）。判据全在 rulesDue()/autoFillRules() 里，
       这里不留第二套 —— 没接入的机构、五项都齐的、30 天内试过的都不跑。 */
    const cur = DATA.products.find(x => x.id === p.id) || p;
    if (rulesDue(cur)) {
      const line = await autoFillRules(cur, "sync");
      if (line) ruleNotes.push(prodLabel(cur) + "：" + line);
    }
    MANUAL.added = added; MANUAL.fail = fail;
    saveManual(); renderManBox();
  };
  try {
    let i = 0;
    /* 并发 2：兼顾速度与目标站风控（中国理财网对同 IP 连续请求较敏感） */
    const workers = Array.from({ length: Math.min(2, list.length) }, async () => {
      while (i < list.length) { const p = list[i++]; await runOne(p); }
    });
    await Promise.all(workers);
    /* 收尾再合并一次：若抓取期间 syncPull 把 DATA 整体换成了云端对象，
       前面写进旧对象的增量会消失；这里按 id 补回当前对象（只补缺失日期，不重复计数） */
    let lateAdded = 0;
    for (const p of DATA.products) {
      const add = fetchedNavs[p.id];
      if (!add) continue;
      p.navHistory = p.navHistory || {};
      for (const d in add) if (!(d in p.navHistory)) { p.navHistory[d] = add[d]; lateAdded++; }
    }
    if (lateAdded) { added += lateAdded; saveLocal(); renderHome(); renderProd(); }
    MANUAL.state = (added === 0 && fail === list.length) ? "fail" : "ok";
    MANUAL.dur = Date.now() - t0;
    MANUAL.navTime = last || stampOf(Date.now());
    MANUAL.msg = fails.slice(0, 3).join("；");
    /* 规则回填这一趟的话留在抓取框里：慢的、只记缺口的、手工没被覆盖的，都要留字据。
       小屏只放得下三条，但「不入账 / 这次没读到」这类话不许被顺叙挤到看不见 ——
       最该被看到的那句最先报；真被截掉的，说清还有几只、去哪看。
       措辞要贴着屏上真有东西说：产品页那张卡片给的是「录成了什么、还缺什么」，
       当场那句「手工录入的不覆盖（…）」不在卡片上复述，
       所以这里只能承诺卡片上真给得出来的两样：录成的值、还缺的项。 */
    const hardLine = l => /不入账|没读到|用不了|超时/.test(l);
    const shown = ruleNotes.filter(hardLine).concat(ruleNotes.filter(l => !hardLine(l))).slice(0, 3);
    const more = ruleNotes.length - shown.length;
    MANUAL.rules = shown.length
      ? shown.join(" ｜ ") + (more > 0 ? ` ｜ 另有 ${more} 只没逐条列出，录成什么样、还缺什么在各产品页的规则卡片上` : "")
      : "";
    saveManual(); renderManBox();
    /* 本机抓取也写一份与云端相同结构的 lastFetch：
       告警条、产品详情里的「最新净值取自…」、上次抓取时间都复用云端那套展示，
       不新增界面。没有新增净值时不标脏，避免每 3 分钟白推一次 GitHub。 */
    DATA.settings = DATA.settings || {};
    DATA.settings.lastFetch = {
      time: stampOf(Date.now()), source: "app", total: list.length,
      ok: list.length - fail, fail: fail, items: fails.slice(0, 8),
      sig: fails.map(s => s.slice(0, 40)).join("|"), products: srcMap
    };
    if (added) saveLocal();
    else { try { localStorage.setItem(LS_DATA, JSON.stringify(DATA)); } catch (e) { } }
    renderAlert();
    if (added) autoPush();
    toast(added ? `本机抓取完成：新增 ${added} 条净值` + (fail ? `，${fail} 只失败` : "")
                : `本机抓取完成：暂无新净值` + (fail ? `（${fail} 只失败）` : ""), 4200);
    if (aixErr && withAixhub) {
      const dead = /401|登录已失效|token|unauthor/i.test(aixErr);
      const perm = /403|会员|权限/.test(aixErr);
      toast(dead ? "秒讯登录已失效，请到「设置 → 秒讯」重新登录（不影响官网抓取）"
        : perm ? "秒讯会员/权限异常，请到秒讯确认会员状态（不影响官网抓取）"
          : "秒讯这次没取到：" + aixErr.slice(0, 60), 6000);
      if (dead) {
        /* 登录态的值在加密区里，页面手里没有：清就得让原生侧来清（顺手删历史明文键） */
        try { if (window.NativeNav && typeof window.NativeNav.aixhubClear === "function") window.NativeNav.aixhubClear(); } catch (e) { }
        aixhubPurgeLegacy();
        lsDel(AIX_LS.lic); lsDel(AIX_LS.at);
        renderAixhub();
      }
    }
    if (lgmErr && withLedgerme) {
      const dead = /401|Cookie|登录|失效|unauthor/i.test(lgmErr);
      toast(dead ? "净值账本 Cookie 已失效，请到「设置 → 净值账本」更新（不影响官网抓取）"
        : "净值账本这次没取到：" + lgmErr.slice(0, 60), 6000);
      if (dead) {
        /* 失效的那一份在加密区里，页面只能请原生侧清；本机缓存的身份快照顺手抹掉。 */
        ledgermeClearNative();
        ledgermePurgeLegacy();
        lsDel(LGM_LS.user); lsDel(LGM_LS.name); lsDel(LGM_LS.at); lsDel(LGM_LS.chk);
        renderLedgerme();
      }
    }
  } finally {
    _nativeBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = "⚡ 立即抓取"; }
  }
}
/* App 启动 / 回到前台 / 页面可见时调用。节流按「有没有追上昨天」自适应：
   全部产品都已披露到昨天 → 30 分钟一次；只要有一只还落后 → 3 分钟一次。
   公开披露一更新就能在几分钟内落库，不必等用户手动点「立即抓取」。
   force=true 用于启动/升级后的首次抓取，只留 60 秒防抖。 */
window.__nativeAutoFetch = function (force) {
  if (!nativeFetchAvailable()) return;
  if (!DATA.products || !DATA.products.length) return;
  if (_nativeBusy) return;
  const now = Date.now();
  const last = Number(localStorage.getItem("licai.nativeFetchAt") || 0);
  const y = stampOf(now - 86400000).slice(0, 10);
  let behind = false;
  for (const p of DATA.products) {
    if (!fetchStatus(p).ok) continue;
    const l = latestNav(p);
    if (!l || l[0] < y) { behind = true; break; }
  }
  const wait = force ? 60000 : (behind ? 3 * 60000 : 30 * 60000);
  if (now - last < wait) return;
  nativeFetchAll();
};
function syncMsg(html) { const e = $("syncMsg"); if (e) e.innerHTML = html; else toast(html.replace(/<[^>]+>/g, "")); }
async function testConn() {
  if (!SYNC.owner || !SYNC.repo || !SYNC.token) return toast("请先填完整配置");
  syncMsg("测试连接中…");
  try {
    const repo = await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}`);
    if (repo && repo.default_branch) { SYNC.branch = repo.default_branch; saveSync(); }   /* v32 P1-4：缓存默认分支 */
    let exists = false;
    try { await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}/contents/${SYNC.path}`); exists = true; } catch (e) { }
    syncMsg(`<div class="note g">连接成功：<b>${esc(repo.full_name)}</b>（${repo.private ? "私有" : "⚠️ 公开！"}）<br>数据文件${exists ? "已存在" : "尚不存在，首次推送会自动创建"}</div>`);
  } catch (e) { syncMsg(`<div class="note">连接失败：${esc(String(e).slice(0, 140))}</div>`); }
}
async function syncPull(manual) {
  if (!SYNC.owner || !SYNC.repo || !SYNC.token) { if (manual) toast("请先配置同步"); return; }
  /* v32 P0-2：本地还有没推上去的改动时，静默拉取一律先推后拉（拉回自己的改动+云端独有净值）；
     推送失败就放弃本次拉取 —— 绝不能用云端旧数据覆盖本地新编辑。
     手动拉取本身有「本地未同步的改动将丢失」确认弹窗，直接放行。 */
  if (!manual && DIRTY) {
    await syncPush(false);
    if (DIRTY) return;
  }
  try {
    const info = await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}/contents/${SYNC.path}`);
    SYNC.sha = info.sha; saveSync();
    const remote = JSON.parse(b64ToUtf8(info.content));
    if (manual && !confirm("用云端数据覆盖本地？本地未同步的改动将丢失。\n建议：先在另一台设备推送，或先导出本地备份。")) return;
    /* 覆盖前留一份净值指纹，用来判断云端是不是真有新净值（见 notifyNewNav） */
    const before = navFingerprint();
    DATA = Object.assign({ products: [], trades: [], settings: {} }, remote);
    saveLocal();
    applyCalendarConfig();   /* 云端可能补了新的年份 / 截止时间 */
    const pullVer = _POS_VER;
    /* 云端数据同样要过一遍迁移：合并重复产品、搬迁销售代码。
       若发生变更则回写云端 —— 抓取脚本读到正确的产品代码后才会抓到净值。 */
    const migratedRemote = migrateData();
    /* 「拉下来的就是云端现势，本机没有待推的改动」这句判断要放在重画之前：
       saveLocal() 刚刚把 DIRTY 置成了 true（它不区分「用户改的」还是「拉回来的」），
       先清再画，否则设置页会拿着「还没推上去」的状态渲染一次，跟顶栏胶囊当场打架。 */
    if (!migratedRemote && _POS_VER === pullVer) { DIRTY = false; dirtyPersist(); }
    renderHome(); renderTrade(); renderProd(); renderSet();
    if (migratedRemote) { notifyMigrate(); autoPush(); }
    const after = navFingerprint();
    /* before.count 为 0 说明本机还没有任何净值（首次拉取 / 换设备），
       拿它当基准会算出「云端有 200 条新净值」这种荒唐提示，故跳过。 */
    if (before.count > 0) notifyNewNav(navDeltaSince(before.latest), after.latest);
    renderAlert();
    if (manual) toast(migratedRemote ? "已从云端拉取，并自动整理数据" : "已从云端拉取");
  } catch (e) {
    if (manual) toast("拉取失败：" + String(e).slice(0, 80), 3000);
  }
}
async function syncPush(manual) {
  if (!SYNC.owner || !SYNC.repo || !SYNC.token) { if (manual) toast("请先配置同步"); return; }
  /* v46：一次只允许一发 PUT 在飞。autoPush 的 debounce、退避重试、拉取前的补推、
     手动按钮四条路径都会调到这里；两发用同一个 sha 先后发出去，第二发必然 409 ——
     与其把它当并发冲突重合并一遍，不如压根不让它们重叠。
     在飞期间又改了数据就记一笔 _pushAgain，这发落地立刻补一发。 */
  if (_pushing) { _pushAgain = true; return; }
  _pushing = true;
  const body = { message: `update ledger ${new Date().toISOString().slice(0, 16)}` };
  const url = () => `${GH}/repos/${SYNC.owner}/${SYNC.repo}/contents/${SYNC.path}`;
  try {
    /* 推之前先读一次远端。两个原因，都跟「整文件替换」有关：
       ① GitHub Contents PUT 是整文件替换：payload 里少一块，云端就少一块。远端现势
          必须整个交给 mergeForPush（云端独有的产品 / 交易 / 净值日期、抓取脚本写的
          settings、别的设备写下的墓碑都靠它补回来）。
       ② 顺手拿到最新 sha，避免用陈旧 sha 提交导致 409 冲突。 */
    /** @type {any} */
    let robj = {};
    try {
      const cur = await ghReq("GET", url());
      if (cur && cur.sha) {
        body.sha = cur.sha;
        robj = JSON.parse(b64ToUtf8(cur.content)) || {};
      }
    } catch (e) { /* 读不到远端就按本地推，不阻断正常保存 */ }
    if (!body.sha) {
      try { const info = await ghReq("GET", url()); body.sha = info.sha; } catch (e) { }
    }
    /* 别的设备删除过的东西：先并合墓碑并在本地执行，再随本次 payload 一起推回去。
       没有这一步，本机旧快照会把已删产品 / 交易 / 净值原样复活。 */
    if (robj.tomb) {
      mergeTombs(tombstones(), robj.tomb);
      const removed = applyTombs(DATA);
      if (removed) { saveLocal(); renderHome(); renderProd(); renderTrade(); }
    }
    /* payload 在 PUT 前才生成：网络往返期间的用户编辑不会丢出本次推送。
       合并规则（不改动 DATA、云端独有条目保留、净值只补日期、同日保留本地、
       墓碑有效期内不复活、settings 取更新的一份）全在 js/domain/sync.js 里，可测；
       这里只负责网络与 sha。 */
    let res = null, pushVer = _POS_VER;
    for (let attempt = 0; ; attempt++) {
      const { payload, stats } = mergeForPush(DATA, robj);
      pushVer = _POS_VER;   /* payload 快照对应的数据版本（成功后据此决定是否清 dirty） */
      if (stats.products || stats.trades)
        console.info(`同步：本次推送保留了云端独有的 ${stats.products} 只产品 / ${stats.trades} 笔交易`);
      body.content = utf8ToB64(JSON.stringify(payload, null, 1));
      /* 只把合并后的两个抓取脚本字段留在本地，不整段覆盖 settings
         （旧写法 DATA.settings = payload.settings 会用网络往返前的旧快照回写） */
      DATA.settings = DATA.settings || {};
      for (const k of ["lastNavSync", "lastFetch"])
        if (payload.settings[k] !== undefined) DATA.settings[k] = payload.settings[k];
      try {
        res = await ghReq("PUT", url(), body);
        break;
      } catch (e0) {
        /* 409 / 422（sha 陈旧）＝读远端与 PUT 之间另一台设备提交了。合并是幂等的
           （mergeForPush 每次都以本地为骨架把远端现势并进来），所以直接重读现势、
           重跑一遍合并再发一次；只补这一发，再来就是和另一台设备对敲。 */
        if (attempt >= 1 || !/409|422/.test(String(e0))) throw e0;
        const cur2 = await ghReq("GET", url());
        if (!cur2 || !cur2.sha) throw e0;
        body.sha = cur2.sha;
        robj = JSON.parse(b64ToUtf8(cur2.content)) || {};
        if (robj.tomb) { mergeTombs(tombstones(), robj.tomb); applyTombs(DATA); }
        console.info("同步：这发撞上并发提交（409/422），已重读云端现势并重跑合并");
      }
    }
    SYNC.sha = res && res.content ? res.content.sha : ""; saveSync();
    /* 成功：排期与错误一起清零，退避从头算 */
    clearTimeout(_retryTimer); clearTimeout(_pushTimer);
    const wasErr = !!SYNC_ST.err;
    SYNC_ST.pushAt = Date.now(); SYNC_ST.err = ""; SYNC_ST.nextAt = 0; SYNC_ST.retryN = 0;
    /* 推送成功：payload 生成后没有新的本地改动才清 dirty（有的话说明网络期间又编辑了，
       新一轮 autoPush 会接着推） */
    if (pushVer === _POS_VER) { DIRTY = false; dirtyPersist(); } else { stPersist(); }
    /* 成功也要重画设置页：那里那句「还没推上去」如果只在 syncStateView 里更新，
       用户盯着设置页就会看到胶囊说「已同步」、下面一段还写着没推上去。 */
    renderSet();
    if (manual) toast("已推送到云端");
    else if (wasErr) toast("已补推到云端");   /* 之前失败过（离线重试 / 409）时给一句准话 */
  } catch (e) {
    SYNC_ST.err = String((e && e.message) || e).slice(0, 90);
    scheduleRetry();   /* 内部会 renderSet，胶囊与说明一起换 */
    if (manual) toast("推送失败：" + SYNC_ST.err, 3200);
    console.warn(e);
  } finally {
    _pushing = false;
    if (_pushAgain) { _pushAgain = false; syncPush(false); }
  }
}
/* 自动推送（静默，失败不打扰） */
let _pushTimer;
function autoPush() {
  if (!(SYNC.owner && SYNC.repo && SYNC.token)) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => syncPush(false), 1500);
}
/* ---------- 失败后的兜底（v46） ----------
   v45 只有「下次编辑再 debounce 一发」，所以最容易滞留 dirty 的组合就是它最容易
   出事的组合：离线改完 → 直接杀 App。现在补三层：
     · 失败退避重试 3s / 15s / 60s 各一发，用完就明说（状态文案由 syncLine 给）；
       为什么只三发：推送失败无非离线与 Token 失效，前者由 online / 切前台兜住，
       后者再多重试也只是给 GitHub 刷 401；
     · flushDirty：切回前台时显式补推（旧代码只调 checkCloudUpdate，而它第一行
       `if (!NOTIFY.on) return` 就把没开通知的设备全挡在外面，云端 sha 没变时也不推）；
     · 切到后台时抢一发：WebView 随时可能被回收，抢到的就是不掉的那笔。 */
const PUSH_BACKOFF = [3000, 15000, 60000];
let _retryTimer = 0, _pushing = false, _pushAgain = false;
function scheduleRetry() {
  clearTimeout(_retryTimer);
  if (!DIRTY || SYNC_ST.retryN >= PUSH_BACKOFF.length) { SYNC_ST.nextAt = 0; stPersist(); renderSet(); return; }
  const wait = PUSH_BACKOFF[SYNC_ST.retryN];
  SYNC_ST.retryN++;
  SYNC_ST.nextAt = Date.now() + wait;
  stPersist(); renderSet();
  _retryTimer = setTimeout(() => { SYNC_ST.nextAt = 0; syncPush(false); }, wait);
}
function flushDirty() {
  if (!DIRTY) return Promise.resolve();
  if (!(SYNC.owner && SYNC.repo && SYNC.token)) return Promise.resolve();
  return syncPush(false);
}

/* ============================================================
   App 自更新（v47）：判断在 JS，取包与拉起安装器在 Java
   ------------------------------------------------------------
   为什么要它：APK 只发在私有仓 licai-data 的 Release 上，浏览器下载必然要登录
   GitHub。而那枚 fine-grained Token 本来就在 App 里（数据同步用的就是它），
   所以「检查更新 → 下载 → 安装」整条链路在 App 内闭环，网页版一律不出现这块。
   公开仓原来的 apk-latest Release 已同步删除：包不再对公网可下载。

   职责切分：读 release JSON、比版本、给结论是纯逻辑，放 js/domain/update.js
   （有测试）；带凭据的二进制流和 REQUEST_INSTALL_PACKAGES 只能由 Java 做。
   下载 URL 用的是 API 的 asset.url + Token，不是 browser_download_url ——
   后者需要登录后的 Cookie，正是我们要绕开的那件事。
   ============================================================ */
const LS_UPD = "licai.upd";
/* 只缓存「上次查到的结论」，让设置页离线也能显示一行；包地址不进 localStorage
   （API 直链每次都要带 Token 现取，存了反而容易拿过期链接去下） */
let UPD = { at: 0, state: "", version: "", size: 0, text: "", canInstall: false };
let _updInfo = null, _updChecking = false, _updBusy = false;
const _updDone = {};
try { const s = localStorage.getItem(LS_UPD); if (s) UPD = Object.assign(UPD, JSON.parse(s)); } catch (e) { }
function saveUpd() { try { localStorage.setItem(LS_UPD, JSON.stringify(UPD)); } catch (e) { } }

function nativeUpdateAvailable() {
  try { return !!(window.NativeUpdate && typeof window.NativeUpdate.version === "function"); }
  catch (e) { return false; }
}
/* 本机 APK 的 versionName（如 "1.0.205"）。拿不到就交空串或 "err:原因" 给判断层 ——
   两种都要原样显示出来：v52 那次「检查更新失败」查不下去，就是因为这里把异常吞成了
   空串，界面上只剩一句「本机 空」，谁也分不清是没桥、桥抛异常、还是包本身没版本号。 */
function localApkVersion() {
  if (!nativeUpdateAvailable()) return "";
  try { return String(window.NativeUpdate.version() || ""); }
  catch (e) { return "err:" + String((e && e.message) || e).slice(0, 60); }
}
window.__updDone = function (id, res) {
  const f = _updDone[id]; if (!f) return;
  delete _updDone[id]; f(res);
};
/* 下载进度：Java 边写文件边回调（不写 id —— 进度只影响显示，不该和结果抢队列） */
window.__updProg = function (loaded, total) {
  const box = $("updBox"); if (!box) return;
  const pctTxt = total ? Math.min(100, Math.round(loaded / total * 100)) + "%" : "已下 " + Math.round(loaded / 1048576 * 10) / 10 + " MB";
  box.innerHTML = `<div class="note b">正在下载更新包… <b>${esc(pctTxt)}</b><br><span class="muted">下载完会自动弹出系统安装页。</span></div>`;
};
function updBridge(method, args, label, ms) {
  return new Promise(resolve => {
    if (!nativeUpdateAvailable()) return resolve({ ok: false, message: (label || "更新") + "只在 Android App 内可用" });
    const id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let settled = false;
    const finish = r => { if (settled) return; settled = true; delete _updDone[id]; resolve(r || { ok: false }); };
    const timer = setTimeout(() => finish({ ok: false, message: (label || "更新") + "超时，请重试" }), ms || 30000);
    _updDone[id] = r => { clearTimeout(timer); finish(r); };
    try { window.NativeUpdate[method].apply(window.NativeUpdate, [id].concat(args)); }
    catch (e) { clearTimeout(timer); finish({ ok: false, message: String(e) }); }
  });
}
/* 能不能拉起安装页（Android 8+ 的「安装未知应用」授权） */
function nativeCanInstall() {
  if (!nativeUpdateAvailable()) return true;   /* 网页版走不到这里 */
  try { return !!window.NativeUpdate.canInstall(); } catch (e) { return false; }
}
function openUnknownSources() {
  try { window.NativeUpdate.openInstallSettings(); toast("请在列表里找到「理财台账」→ 允许安装未知应用", 5200); }
  catch (e) { toast("打不开系统设置：" + String(e).slice(0, 80), 5200); }
}
/* 读私有仓最新的 Release。ghReq 复用同一条带 Token 的请求通道，
   404（仓库还没发过 release）单独收成一句人话，别把 HTTP 原文甩给用户 */
async function latestRelease(owner, repo) {
  try {
    const j = await ghReq("GET", GH + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/releases/latest");
    return readRelease(j);
  } catch (e) {
    const m = String(e && e.message || e);
    if (/HTTP 404/.test(m)) return { ok: false, error: "仓库 " + owner + "/" + repo + " 还没有正式版 Release" };
    if (/HTTP 401/.test(m)) return { ok: false, error: "Token 无效或已被吊销" };
    if (/HTTP 403/.test(m)) return { ok: false, error: "Token 没有这个仓库的 Contents 读取权限" };
    return { ok: false, error: m.slice(0, 120) };
  }
}
async function checkApkUpdate(manual) {
  if (!nativeUpdateAvailable()) { if (manual) toast("更新检查只在 Android App 内提供"); return; }
  if (!(SYNC.owner && SYNC.repo && SYNC.token)) { if (manual) toast("先在上面填好 GitHub Token 才能检查更新", 4600); return; }
  if (_updChecking) return;
  _updChecking = true;
  if (manual) renderUpdBox("正在检查…");
  let info, verdict;
  try {
    info = await latestRelease(SYNC.owner, SYNC.repo);
    verdict = updateVerdict(localApkVersion(), info);
  } catch (e) {
    info = { ok: false };
    verdict = updateVerdict(localApkVersion(), { ok: false, error: String(e && e.message || e).slice(0, 120) });
  }
  _updChecking = false;
  _updInfo = info && info.ok ? info : null;
  UPD = { at: Date.now(), state: verdict.state, version: verdict.version, size: verdict.size,
    text: verdict.text, canInstall: !!verdict.canInstall };
  saveUpd();
  renderUpdBox();
  if (manual || verdict.state === "new") {
    toast(verdict.state === "new" ? "有新包：" + verdict.version + "，在「数据同步」里更新" : verdict.text, 5200);
  }
  return verdict;
}
function applyApkUpdate() {
  if (!_updInfo) { toast("先点一次「检查更新」拿包地址", 4200); return checkApkUpdate(true); }
  if (!nativeCanInstall()) { toast("系统还没给「安装未知应用」权限，点下面的按钮去开启", 5600); renderUpdBox(); return; }
  if (_updBusy) return;
  _updBusy = true;
  const total = _updInfo.size || 0;
  const version = _updInfo.version, download = _updInfo.download;
  const write = html => { const b = $("updBox"); if (b) b.innerHTML = html; };
  /* 40MB 在移动网络下要走几分钟，弹层可能被用户关掉、甚至被 WebView 回收：
     进度与结果都写向 updBox，但那个节点可能已经不在 —— write() 统一做判空。 */
  write(`<div class="note b">正在下载 licai-ledger.apk…<br><span class="muted">约 ${(Math.round(total / 1048576 * 10) / 10) || "?"} MB，走的是带 Token 的 API 直链。</span></div>`);
  updBridge("install", [download, SYNC.token], "下载", 600000).then(r => {
    _updBusy = false;
    if (r && r.ok) {
      UPD = { at: Date.now(), state: "sent", version: version, size: total, text: "" };
      saveUpd();
      write(`<div class="note g">安装包已交给系统安装器（版本 ${esc(version)}）。<br>
        <span class="muted">在安装页点「继续安装」即可，数据不会丢；同签名的包是覆盖安装。</span></div>`);
      toast("请在系统安装页确认", 5200);
    } else {
      const msg = String((r && r.message) || "未知错误");
      write(`<div class="note r">下载/安装失败：${esc(msg.slice(0, 160))}<br>
        <span class="muted">常见原因：Token 权限不足、网络中断、或 release 里的包还没上传完。</span></div>
        <div class="row-btn" style="margin-top:10px"><button class="btn gh" style="flex:1" onclick="checkApkUpdate(true)">重新检查</button></div>`);
      toast("更新失败：" + msg.slice(0, 90), 5600);
    }
  });
}
/* 设置弹层里那行「App 更新」：只在 App 内出现，网页版整块不渲染 */
function renderUpdBox(msg) {
  const box = $("updBox"); if (!box) return;
  const cur = localApkVersion();
  if (msg) { box.innerHTML = `<div class="note b">${esc(msg)}</div>`; return; }
  const st = UPD.state;
  let line;
  if (st === "new") line = `<div class="note r">${esc(UPD.text)}<br><span class="muted">更新是在本机覆盖安装，台账数据不会被动。</span></div>`;
  else if (st === "sent") line = `<div class="note g">已把 ${esc(UPD.version || "新包")} 交给系统安装器。</div>`;
  else if (st === "latest") line = `<div class="note g">${esc(UPD.text)}</div>`;
  else if (st === "unknown") line = `<div class="note b">${esc(UPD.text || "还没检查过更新")}</div>`;
  else line = `<div class="note">还没检查过更新${cur ? "（本机 " + esc(cur) + "）" : ""}。包只发在你自己的私有仓，需要 Token 才能取。</div>`;
  const when = UPD.at ? `<div class="muted" style="margin-top:6px;font-size:12px">上次检查：${esc(stampOf(UPD.at))}</div>` : "";
  const perm = (st === "new" && !nativeCanInstall())
    ? `<div class="note r" style="margin-top:8px">系统还没允许本应用安装未知应用。<button class="btn gh" style="margin-top:6px;width:100%" onclick="openUnknownSources()">去系统设置开启</button></div>` : "";
  box.innerHTML = `${line}${when}${perm}
    <div class="row-btn" style="margin-top:10px">
      <button class="btn gh" style="flex:1" onclick="checkApkUpdate(true)">检查更新</button>
      ${(st === "new" || UPD.canInstall) ? `<button class="btn pri" style="flex:1" onclick="applyApkUpdate()">下载并安装${UPD.version ? " " + esc(UPD.version) : ""}</button>` : ""}
    </div>`;
}
/* 静默自动检查：每台设备 12 小时最多一次，且只在 App 内。
   为什么不每次打开都查：包地址在私有仓，一次检查 = 一次带 Token 的 API 调用，
   而新版本一周也未必有一次；用户真要点的是「有新包」那个按钮，不是每次都问网络。 */
function maybeAutoUpdCheck() {
  if (!nativeUpdateAvailable()) return;
  if (!(SYNC.owner && SYNC.repo && SYNC.token)) return;
  if (UPD.state === "sent") return;   /* 装着新包的路上，别再提示 */
  if (Date.now() - (Number(UPD.at) || 0) < 12 * 3600 * 1000) return;
  setTimeout(() => { checkApkUpdate(false); }, 3000);
}

/* ============================================================
   提醒：新净值通知 + 抓取异常告警
   ------------------------------------------------------------
   为什么没有「真正的后台推送」：
     本项目零后端，云端只有定时抓取的 GitHub Actions。
     真后台推送需要 Web Push（VAPID 密钥对 + 一台常驻服务端来投递），
     那会立刻打破「数据不出设备 + 零服务器成本」这两个前提，故不做。
     所以提醒做成两级：
       ① App 打开 / 切回前台时：自动比对云端文件 sha，有新净值直接提示；
       ② 页面挂在后台（装了主屏、或留着一个标签页）时：每 60 分钟轮询一次，
          发现新净值才发系统通知。
     iOS：Safari 里不上主屏会直接拒绝通知权限，必须「分享 → 添加到主屏幕」
          后从桌面图标打开（iOS 16.4+）。renderNotify 里会按环境给出提示。
   ============================================================ */
function loadNotify() {
  try { const s = localStorage.getItem(LS_NOTIFY); if (s) NOTIFY = Object.assign(NOTIFY, JSON.parse(s)); } catch (e) { }
  try { ALERT_DISMISSED = localStorage.getItem(LS_ALERT) || ""; } catch (e) { }
}
function saveNotify() {
  try { localStorage.setItem(LS_NOTIFY, JSON.stringify({ on: !!NOTIFY.on, lastCheck: NOTIFY.lastCheck || 0 })); } catch (e) { }
}
function saveAlertDismiss() { try { localStorage.setItem(LS_ALERT, ALERT_DISMISSED); } catch (e) { } }

function notifySupported() { return typeof Notification !== "undefined" && !!Notification; }
function notifyPermission() { return notifySupported() ? Notification.permission : "unsupported"; }
function isIOS() { return /iP(hone|ad|od)/.test(navigator.userAgent || ""); }
function isStandalone() {
  try {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || navigator.standalone === true;
  } catch (e) { return false; }
}
function canNotify() { return NOTIFY.on && notifyPermission() === "granted"; }

/* 发系统通知。
   优先走 SW 的 showNotification —— iOS(16.4+) 只认这条路径，
   `new Notification()` 在移动端 Safari 根本不存在，只作桌面浏览器的回退。
   tag 固定：同一条提醒重复发只替换，不会在通知中心堆一串。 */
async function pushNotify(title, body) {
  if (!canNotify()) return false;
  const opts = { body: body, icon: "./icon-192.png", badge: "./icon-192.png", tag: "licai-nav", lang: "zh-CN" };
  try {
    const reg = (navigator.serviceWorker && navigator.serviceWorker.getRegistration)
      ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
    new Notification(title, opts);            /* 回退：桌面浏览器 */
    return true;
  } catch (e) { return false; }
}

async function toggleNotify() {
  if (NOTIFY.on) {
    NOTIFY.on = false; saveNotify(); renderNotify();
    toast("已关闭新净值提醒"); return;
  }
  if (!notifySupported()) {
    toast("此环境不支持通知。iPhone 请先「分享 → 添加到主屏幕」，再从桌面图标打开", 4600);
    renderNotify(); return;
  }
  let perm = Notification.permission;
  if (perm === "default") {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = "denied"; }
  }
  if (perm !== "granted") {
    toast("通知权限被拒绝。请到浏览器/系统设置里允许本站通知，再回来开启", 4200);
    renderNotify(); return;
  }
  NOTIFY.on = true; saveNotify(); renderNotify();
  toast("已开启提醒：" + (isStandalone() ? "退到后台也能收到通知" : "页面在后台时会有通知"), 3200);
  pushNotify("提醒已开启", "抓到新净值、或云端抓取失败时会在这里告诉你。");
}

function renderNotify() {
  const box = $("notifyBox"); if (!box) return;
  const btn = $("btnNotify"), tip = $("notifyTip");
  const supported = notifySupported(), perm = notifyPermission();
  if (btn) btn.textContent = NOTIFY.on ? "关闭通知" : "开启通知";
  let html = "", t = "";
  if (!supported) {
    html = `<div class="note">当前环境不支持系统通知（可能是 <code>file://</code> 打开、或 App 内嵌浏览器）。<br>
            抓取异常仍会在首页顶部显示<b>告警条</b>。</div>`;
    t = isIOS() ? "iPhone / iPad：需先用 Safari「分享 → 添加到主屏幕」，再从桌面图标打开本页，通知才会生效。" : "";
  } else if (perm === "denied") {
    html = `<div class="note">通知权限已被拒绝。<br>需到浏览器设置里手动允许本站通知，再回来开启。</div>`;
  } else if (NOTIFY.on) {
    html = `<div class="note g">已开启。${isStandalone() ? "本页已装到桌面，退到后台也能收到通知。" : "本页留在后台（或装到桌面）时能收到通知。"}</div>`;
    t = "零后端设计：靠本页定时比对云端数据，<b>完全关闭浏览器后收不到推送</b>（那需要一台常驻服务器）。";
  } else {
    html = `<div class="note">开启后：抓到<b>新净值</b>、或云端<b>抓取失败</b>时会收到系统通知。<br>
            不开启也不影响使用 —— 首页顶部仍有告警条。</div>`;
    t = (isIOS() && !isStandalone())
      ? "iPhone / iPad：请先「分享 → 添加到主屏幕」，再从桌面图标打开，才能开启通知。" : "";
  }
  box.innerHTML = html;
  if (tip) tip.innerHTML = t;
}

/* ---------- 云端抓取健康度（云端写进 licai-data.json 的 settings.lastFetch） ---------- */
function lastFetchInfo() {
  const lf = DATA.settings && DATA.settings.lastFetch;
  return (lf && typeof lf === "object") ? lf : null;
}
/* 告警签名只取「失败集合」，不含时间戳：
   这样用户点掉之后不会因为下一轮抓取（时间变了）又冒出来，
   但只要失败的产品变了、或有新的产品开始失败，就会重新提示。 */
function fetchFailSig(lf) { return lf ? ("fetch:" + (lf.sig || "") + ":" + (Number(lf.fail) || 0)) : ""; }
function fetchFailCount(lf) { return lf ? (Number(lf.fail) || 0) : 0; }

function renderAlert() {
  const bar = $("alertBar"); if (!bar) return;
  const lf = lastFetchInfo();
  const n = fetchFailCount(lf);
  if (!n || fetchFailSig(lf) === ALERT_DISMISSED) {
    bar.className = "alert"; bar.innerHTML = ""; return;
  }
  const items = (lf.items || []).slice(0, 3)
    .map(s => `<div class="sm">· ${esc(s)}</div>`).join("");
  const more = n > 3 ? `<div class="sm">…另有 ${n - 3} 只，点「详情」看全部</div>` : "";
  bar.className = "alert warn show";
  bar.innerHTML = `<div class="tx">
      <b>${lf.source === "app" ? "本机抓取" : "云端抓取"}有 ${n} 只产品没拿到净值</b>${lf.time ? `<span class="sm"> · ${esc(lf.time)}</span>` : ""}
      ${items}${more}
      <div style="margin-top:4px"><span class="more" onclick="refreshNav()">详情与处理办法 ›</span></div>
    </div>
    <button class="x" title="本次不再提示" onclick="dismissAlert()">✕</button>`;
}
function dismissAlert() {
  ALERT_DISMISSED = fetchFailSig(lastFetchInfo());
  saveAlertDismiss(); renderAlert();
  toast("已忽略本次告警。失败的产品有变化时会重新提示", 3200);
}

/* ---------- 新净值检测 ---------- */
/* 净值指纹：最新披露日 + 净值总条数。
   只认「条数增长」不认减少 —— 云端抓取只增不删，减少说明是别的问题（比如换了账号）。 */
function navFingerprint() {
  let count = 0;
  for (const p of DATA.products) count += navCount(p);
  return { count: count, latest: latestDateAll() || "" };
}
/* 比上次同步更新的净值条数（披露日 > latestDate）。
   不能用总条数差：新增产品回填 122 条历史会被误报成「122 条新净值」。 */
function navDeltaSince(latestDate) {
  let n = 0;
  for (const p of DATA.products)
    for (const d in (p.navHistory || {}))
      if (d > latestDate) n++;
  return n;
}
/* 拉到新净值后的提醒。
   用户正盯着屏幕看的时候不再弹系统通知去打断他 —— 前台只给 toast。 */
function notifyNewNav(delta, latest) {
  if (!(delta > 0)) return;
  if (document.visibilityState === "visible") {
    toast(`云端有 ${delta} 条新净值（最近 ${latest}），已同步`, 3600);
  } else {
    pushNotify("净值已更新", `${delta} 条新净值 · 最近披露 ${latest}`);
  }
}
/* 后台轮询：只比对远端 sha，变了才真拉全量。
   15 分钟内不重复请求（GitHub API 有速率限制，而云端抓取本身一天只有两次）。 */
async function checkCloudUpdate() {
  if (!(SYNC.owner && SYNC.repo && SYNC.token)) return;
  if (!NOTIFY.on) return;
  if (Date.now() - (NOTIFY.lastCheck || 0) < 15 * 60000) return;
  NOTIFY.lastCheck = Date.now(); saveNotify();
  try {
    const info = await ghReq("GET", `${GH}/repos/${SYNC.owner}/${SYNC.repo}/contents/${SYNC.path}`);
    if (!info || !info.sha || info.sha === SYNC.sha) return;   /* 云端没变 */
    await syncPull(false);                                    /* 变了才拉 */
  } catch (e) { /* 静默：网络抖动不该打扰用户 */ }
}

/* ============================================================
   备份 / 恢复 / 清空
   ============================================================ */
function exportJSON() {
  const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `理财台账备份_${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);   /* v32 P2：下载启动后再回收，防内存滞留 */
  toast("已导出备份");
}
function importJSON() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json";
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const o = JSON.parse(rd.result);
        if (!o.products) throw new Error("格式不对");
        if (!confirm("导入将覆盖当前本地数据，确定？")) return;
        DATA = Object.assign({ products: [], trades: [], settings: {} }, o);
        applyCalendarConfig();
        saveLocal(); renderHome(); renderTrade(); renderProd(); renderSet(); toast("已导入");
      } catch (e) { toast("导入失败：" + e.message); }
    };
    rd.readAsText(f);
  };
  inp.click();
}
function clearAll() {
  if (!confirm("将清空本机全部产品与交易数据（云端不受影响），确定？")) return;
  DATA = { products: [], trades: [], settings: { hideAmount: false } };
  saveLocal(); renderHome(); renderTrade(); renderProd(); toast("已清空本地数据");
}

/* ============================================================
   启动
   ============================================================ */

/* ---------- 内联事件桥 ----------
   ES module 的顶层函数不再自动成为 window 属性，而 index.html 与各渲染函数里
   的内联 onclick/oninput 仍按全局查找。这里显式把入口挂回 window。
   ⚠️ 新增内联 handler 时必须同步加进这个清单 ——
   tests/handlers.test.mjs 会扫描 index.html / app.js 里的内联调用做双向校验。 */
Object.assign(window, {
  addNav, aixhubCheckNow, aixhubLoginFlow, aixhubLogout, applyApkUpdate, autoFillNav, bulkNav, calcShares, calMove, checkApkUpdate, clearAll,
  clearAnaCache, clearBdSearch, clearDetSearch, closeSheet, commitNav, delNav, delProd, delTrade, dismissAlert, editProd,
  exportJSON, go, importJSON, ledgermeCheckNow, ledgermeLoginFlow, ledgermeLogout, ocrPick, ocrShot, onBdSearch, onDetSearch, onProdCodeInput, onTradeDateChange, llmAsk, llmCancel, llmClearChat, llmClearKey, llmDataToggle, llmRetry, llmSaveCfg, llmSetKey, openAna, openAnaIndex, openDisc, openLinkAdd, openLlm, openMonthly,
  openNav, openProd, openProdDetail, openSync, openTrade, openUnknownSources, pickDay, pickProduct, previewLink, qrPick, qrShot,
  queryProduct, refreshAna, refreshNav, renderPick, renderTradeForm2, resetManualFetch, saveFromLink, saveDisc,
  saveProduct, saveSyncCfg, saveTrade, setBdInst, setBdSort, setDetInst, setDetSort, setDetTab, setGroup, setProdOv, setRepMonth, setSwitchTarget,
  setProdRange, setRange, syncPull, syncPush, toggleBdCols, toggleHide, toggleNotify, triggerFetch
});

(function init() {
  loadLocal();
  applyCalendarConfig();   /* 先合并云端日历（settings.tradeCal），再渲染任何日期 */
  loadNotify();
  /* 启动即做一次数据迁移：销售代码→产品代码、重复产品合并 */
  const migrated = migrateData();
  $("btnHide").textContent = DATA.settings.hideAmount ? "显示" : "隐藏";
  renderHome(); renderSet();
  renderAlert();
  if (migrated) notifyMigrate();
  /* 上次手动抓取若在系统回收时还没跑完，启动后接着追踪（12 分钟上限自动兜底） */
  ensureManualPolling();
  const pullP = (SYNC.owner && SYNC.repo && SYNC.token) ? syncPull(false) : Promise.resolve();
  /* App 内每天几次地看一眼私有仓有没有新包（12 小时节流，见 maybeAutoUpdCheck） */
  maybeAutoUpdCheck();
  window.addEventListener("online", () => {
    if (SYNC.owner) syncPull(false);
    if (nativeFetchAvailable()) { try { window.__nativeAutoFetch(); } catch (e) { } }
  });
  /* 横屏 / 桌面窗口拉伸都会改变产品收益表能不能一屏放下 —— 渐影是量出来的，
     不重算就会留在错的那一档（该提示能滑时不提示，不能滑时还挂着道影子）。 */
  window.addEventListener("resize", bdEdge);
  /* 渐影还得跟着滚动位置走：滑到最右时它必须收掉，否则「还能往右」成了假提示 */
  const boardWrapEl = $("boardWrap");
  if (boardWrapEl) boardWrapEl.addEventListener("scroll", bdEdge, { passive: true });
  /* App 内：必须等云端数据到位再抓 —— 首次安装时本地还没有产品，
     固定 1.2 秒的定时器会扑空，表现成「装完一直没净值」。最多等 6 秒。 */
  if (nativeFetchAvailable()) {
    Promise.race([pullP, new Promise(r => setTimeout(r, 6000))])
      .then(() => setTimeout(() => { try { window.__nativeAutoFetch(true); } catch (e) { } }, 600));
    /* 页面在前台时按自适应节流反复核对（落后时 3 分钟一次），
       公开源一披露就自动落库，不用一直盯着点「立即抓取」 */
    setInterval(() => {
      if (document.visibilityState === "visible") {
        try { window.__nativeAutoFetch(); } catch (e) { }
      }
    }, 2 * 60000);
  }

  /* 提醒的两条触发路径（详见「提醒」章节的说明）：
     ① 页面在后台时每 60 分钟比对一次云端版本，有新净值就发系统通知；
     ② 从后台切回前台时立刻核对一次，并重画告警条/提醒状态（可能是在别处改过数据）。 */
  setInterval(checkCloudUpdate, 60 * 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      /* v46：切回前台先补推本机改动，再核对云端。顺序很重要 ——
         checkCloudUpdate 在没开系统通知时第一行就 return，指望它兜 dirty 是兜不住的。 */
      flushDirty();
      checkCloudUpdate(); renderAlert(); renderNotify();
      /* App 回到前台：立刻按节流核对一次净值（切后台期间可能正好披露了新一天） */
      if (nativeFetchAvailable()) { try { window.__nativeAutoFetch(); } catch (e) { } }
    } else if (DIRTY) {
      /* 正要进后台：抢一发。WebView 可能在后台被回收，这一发抢到的就是不掉的那笔。
         不 await —— 页面已经看不见了，成功与否由顶栏胶囊下次显示时说话。 */
      syncPush(false);
    }
  });
  /* 胶囊上的「40 秒前 / 5 分前」是算出来的，不是事件驱动的：没有新事件时它也会旧，
     所以每分钟重画一次（纯本地，零网络请求）。 */
  setInterval(syncStateView, 60000);
  /* 注册 Service Worker（仅 https / localhost 生效，file:// 下自动跳过）
     SW 是「外壳缓存优先」，新版本必须等新 SW 装上并接管才生效 ——
     否则用户会一直看到旧的 index.html / app.js，表现为「推了代码但页面没变」。
     所以这里主动监听更新：updatefound 只在真的发现新版本时触发，
     新 SW 一装好（installed）且当前有旧 SW 在控制页面，就提示并自动刷新一次
     （sessionStorage 里记一下，确保每个版本最多刷一次，杜绝循环刷新）。 */
  /* App 内置版本不注册 SW：APK 已把静态资源打包，SW 只会在升级后继续喂旧壳。
     （页面由 WebViewAssetLoader 以 https 提供，不拦的话 SW 会真的装上。） */
  if (!nativeFetchAvailable() && "serviceWorker" in navigator && location.protocol !== "file:") {
    const FLAG = "licai_sw_reloaded";
    const reloadOnce = () => {
      try {
        if (sessionStorage.getItem(FLAG) === APP_VER) return;
        sessionStorage.setItem(FLAG, APP_VER);
      } catch (e) { /* 隐私模式下可能不可用，忽略 */ }
      toast(`已更新到 ${APP_VER}，即将刷新…`);
      setTimeout(() => location.reload(), 1000);
    };
    navigator.serviceWorker.register("./sw.js").then(reg => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          /* 首次安装时还没有 controller，不需要刷新，只有「替换旧版本」才刷 */
          if (nw.state === "installed" && navigator.serviceWorker.controller) reloadOnce();
        });
      });
    }).catch(() => { });
  }
})();
