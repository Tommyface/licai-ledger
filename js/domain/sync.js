// @ts-check
/* 整文件同步（GitHub Contents PUT）的合并语义。

   为什么单独成模块：云端同步是「整文件替换」，payload 生成前必须把远端的现势并进
   来，否则这次推送就把别的设备 / Actions 刚写的东西删掉了。v43 之前这段代码散在
   app.js 的 syncPush 里，而且只并了「同 id 产品的净值日期」——
   · 云端独有的产品（另一台设备刚加的产品）被这次 PUT **整只删掉**；
   · 云端独有的交易（另一台设备刚记的买卖）同样被删；
   · Actions 抓完净值回填的档案字段（orgName / prodCode 等）被本地旧快照抹回空值。
   这三条都不会报错，只在另一台设备上表现为「我加的产品不见了」。

   所以合并规则集中在这里，做成可执行的纯函数：调用方只负责网络与 sha。
   语义与数据端的 scripts/merge_remote.py 对称（那边以远端为骨架补净值，
   这边以本地为骨架补云端条目），墓碑口径两侧一致（30 天内不复活）。 */

import { normTomb, mergeTombs, purgeTombs } from "./tomb.js";
import { normDisc, discHasContent } from "../core/disc.js";

/** 与 app.js / tomb.js / merge_remote.py 保持同一个有效期 */
export const PUSH_TOMB_DAYS = 30;

/**
 * 取产品的净值字典。数据文件可能被手改坏（navHistory 写成字符串 / 数组），
 * 这里不跟着坏：读时按空字典处理，需要写时（create）替换成真对象。
 * @param {any} p @param {boolean} [create]
 */
function nhOf(p, create) {
  const h = p && p.navHistory;
  if (h && typeof h === "object" && !Array.isArray(h)) return h;
  if (!p) return {};
  if (!create) return {};
  p.navHistory = {};
  return p.navHistory;
}

/** 同上，settings / tomb 这类「应该是对象」的字段 */
function objOf(v) {
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
}

/**
 * 生成本次 PUT 的 payload：本地快照为骨架，把远端独有且没被删过的东西并进来。
 *
 * 规则（按重要性排序）：
 *  1. 不改动传入的 local —— 全程在深拷贝上操作（静默推送不能动本地账面）；
 *  2. 远端独有的产品 / 交易 → 保留（这是本次修复的核心：以前会被整文件覆盖删掉）；
 *  3. 墓碑并集内仍有效的条目 → 不复活（任何设备删过都算删过）；过期墓碑不再屏蔽；
 *  4. 同 id 产品的净值：只补本地没有的日期，同日冲突保留本地（用户显式补录优先）；
 *  5. 同 id 产品的档案字段：本地为空才用远端（抓取回填的 orgName 等不被旧快照抹掉）；
 *  6. settings 只认抓取脚本的 lastNavSync / lastFetch，取时间更新的一份；
 *     其余 settings 键保留本地 —— 用户在本地改过的同步设置不能被远端旧值带回。
 *
 * @param {any} local 本地 DATA（不会被修改）
 * @param {any} remote 云端数据文件解析结果；读不到时传 {}（按纯本地推送）
 * @param {{now?: number, tombDays?: number}} [opts] now = 当前毫秒时间戳（测试可注入）
 * @returns {{payload: any, stats: {products:number, trades:number, navs:number, fields:number, settings:number}}}
 */
export function mergeForPush(local, remote, opts) {
  const now = (opts && opts.now) || Date.now();
  const days = (opts && opts.tombDays) || PUSH_TOMB_DAYS;
  const payload = JSON.parse(JSON.stringify(local || {}));
  const r = (remote && typeof remote === "object") ? remote : {};
  const stats = { products: 0, trades: 0, navs: 0, fields: 0, settings: 0 };

  /* 墓碑取并集后随 payload 上传：本机快照里没有、但别的设备刚写下的删除记录，
     不带上就会被这次 PUT 抹掉，下次拉取时那东西又活过来。 */
  const tomb = mergeTombs(normTomb(payload.tomb), r.tomb);
  payload.tomb = tomb;
  /* 过期墓碑不参与「不许复活」判断（用副本清理，别把要上传的历史抹了） */
  const live = JSON.parse(JSON.stringify(tomb));
  purgeTombs(live, now, days);
  const deadP = live.products, deadT = live.trades, deadN = live.navs;

  const prods = Array.isArray(payload.products) ? payload.products : (payload.products = []);
  const byId = new Map(prods.map(p => [String(p && p.id), p]));
  for (const rp of Array.isArray(r.products) ? r.products : []) {
    if (!rp || rp.id === undefined || rp.id === null) continue;
    const id = String(rp.id);
    if (deadP[id]) continue;                       // 任何设备删过 → 不复活
    const copy = JSON.parse(JSON.stringify(rp));
    let p = byId.get(id);
    if (!p) {                                      // 云端独有：整只保留
      prods.push(copy);
      byId.set(id, copy);
      stats.products++;
      // 独有的产品也可能带墓碑内的净值日期，统一按规则 3 清一遍
      const nh = nhOf(copy);
      for (const d of Object.keys(nh))
        if (deadN[id + "|" + d]) delete nh[d];
      continue;
    }
    const lh = nhOf(p, true), rh = nhOf(copy);
    for (const d of Object.keys(rh)) {
      if (deadN[id + "|" + d]) continue;           // 用户明确删过这一天
      if (lh[d] === undefined || lh[d] === null || lh[d] === "") {
        lh[d] = rh[d];
        stats.navs++;
      }
    }
    for (const k in copy) {                        // 规则 5：只填空白（disc 除外）
      if (k === "navHistory" || k === "id" || k === "disc") continue;
      const v = copy[k];
      if (v === undefined || v === null || v === "") continue;
      const cur = p[k];
      if (cur === undefined || cur === null || cur === "" ||
        (Array.isArray(cur) && cur.length === 0)) { p[k] = v; stats.fields++; }
    }
    /* v81 第 4 步：disc 单独判，不套规则 5。对象类型用「只填空值」会两头误判 ——
       本地 normDisc() 生成的全空骨架也是非空对象，会把另一台设备 / 云端回填的真值
       挡在门外；反过来本地 auto 值又会盖掉别台设备手工录的 manual 值（同一型事故）。
       口径全复用 disc.js 的 normDisc / discHasContent，这里不另立一套空值语义。 */
    const L = normDisc(p.disc), R = normDisc(copy.disc);
    let takeDisc = false;
    if (L.status === "manual") takeDisc = false;             // 手工录入绝对优先
    else if (R.status === "manual") takeDisc = true;         // 别台设备手工录的，盖过 auto/none
    else if (!discHasContent(L) && discHasContent(R)) takeDisc = true;  // 本地只是全空骨架
    if (takeDisc) { p.disc = copy.disc; stats.fields++; }
  }

  const trades = Array.isArray(payload.trades) ? payload.trades : (payload.trades = []);
  const seen = new Set(trades.map(t => String(t && t.id)));
  for (const rt of Array.isArray(r.trades) ? r.trades : []) {
    if (!rt || rt.id === undefined || rt.id === null) continue;
    const id = String(rt.id);
    if (deadT[id] || seen.has(id)) continue;       // 删过 / 本地已有
    trades.push(JSON.parse(JSON.stringify(rt)));
    seen.add(id);
    stats.trades++;
  }

  payload.settings = objOf(payload.settings);
  const rs = objOf(r.settings);
  for (const k of ["lastNavSync", "lastFetch"]) {
    const a = rs[k], b = payload.settings[k];
    const ta = a ? String(a.time || a) : "";
    const tb = b ? String(b.time || b) : "";
    if (ta && ta > tb) { payload.settings[k] = JSON.parse(JSON.stringify(a)); stats.settings++; }
  }

  return { payload, stats };
}
