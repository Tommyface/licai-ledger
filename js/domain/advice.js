// @ts-check
/* ---------- T7a：这一只现在赎不赎得出来、赎要付多少（v74 起）----------
   从 app.js 拆出来的纯函数：拆出来才能被 node --test 逐条钉住（同 disc.js / analysis.js 的做法）。

   这一层只做一件事：把 T1 录下来的「最短持有期 / 开放安排 / 赎回费分档」和 position.js
   算好的持仓，合成一条**当下**的赎回结论。它不给「该不该换到另一只」的建议 ——
   跨产品比较要另定口径，这一版不碰。

   ★ 四条口径（改任何一条都要同步改 tests/advice.test.mjs）：
     1. **不重算任何算钱的口径。** 份额、成本、市值、持有天数、费率档位、净值滞后
        全部来自 position.js / disc.js / calendar.js 的既有函数，这里再写一遍就是
        第二份实现，两处不一致时结论无从追溯。
     2. **null 是不知道，0 是知道且为零。** 赎回费没披露 → ratePct/fee/net 一律 null，
        绝不按 0% 算出「赎回来一分钱不亏」这种看着最舒服也最害人的假话。
     3. **文本里不写钱。** 钱（fee / net / market）只以数字字段返回，由渲染层走
        shown() / money() 现算现显 —— 隐私遮罩是显示态，数字一旦进了文本就绕过了它。
     4. **函数内不读时钟、不碰网络、不写账本。** 「今天」由调用方传进来（td），
        跨天复用与单测都靠这一条；这一层一旦自己去读表，结论就被钉死在算的那一刻。
*/

import { normDisc, feeRateFor, discGaps, DISC_GAP_LABEL, DISC_TIER_LABEL } from "../core/disc.js";
import { navLagTradingDays } from "./calendar.js";

/* 出处分级的中文说法复用 disc.js 那张表，这里只兜住「分级缺失」这一种脏数据。 */
/** @param {any} tier @returns {string} */
function DISC_TIER_TEXT(tier) { return DISC_TIER_LABEL[String(tier || "unknown")] || DISC_TIER_LABEL.unknown; }

/** 结论档位。skip / unclear 都不许显示成绿色：「没录」与「判得出」不是一回事。 */
export const ADV_VERDICTS = { yes: "现在赎得出来", no: "现在赎不出来", unclear: "判不了", skip: "不适用" };

/* 每一行的抬头。措辞留在这一层（与 analysis.js 同做法）才能在测试里逐条钉住；
   页面只负责印字，不负责想话。 */
export const ADV_LINE_TITLES = {
  shares: "持仓", lock: "持有期", open: "开放安排", fee: "赎回费",
  money: "市值", next: "再等几天", nav: "净值新旧", source: "出处", gap: "还缺"
};

/* 开放安排的识别只认「随时可赎 / 每个交易日」这一类明确表述，认不出就按未知处理。
   自由文本里有「每月 15 日开放」「持有满 30 天后可赎」这类要靠日历才能判的写法，
   在这里硬猜会给出「今天赎不出来」或「今天赎得出来」这种错的确定答案 ——
   宁可不判，把原文回显出来让用户自己看（与 parseFeeLine 认不出的行要回显同理）。 */
const OPEN_DAILY = /(每个?交易日|每日|天天|随时|无封闭|不设封闭|开放式|可赎回)/;
/** @param {string} s @returns {boolean} */
export function isOpenRuleDaily(s) { return OPEN_DAILY.test(String(s || "")); }

/**
 * 一条结论行。level 只借 T2 那五档（页面已按同一套词表上色），档位外一律降级成 na。
 * @param {string} key @param {string} level @param {string} text
 */
function line(key, level, text) {
  const ok = ["ok", "warn", "bad", "na", "skip"];
  return { key, title: ADV_LINE_TITLES[key] || key,
           level: ok.indexOf(level) >= 0 ? level : "na", text: String(text || "") };
}

const r2 = v => Math.round(Number(v) * 100) / 100;

/**
 * 当下这一笔赎回的结论。
 * @param {{ p?: any, pos?: any, td?: string }} a  p=产品，pos=computePosition(p, trades, td) 的结果，td=「今天」YYYY-MM-DD
 * @returns {{ verdict: string, verdictText: string, holdDays: number, unlockInDays: number | null,
 *            ratePct: number | null, market: number | null, fee: number | null, net: number | null,
 *            nextDrop: { days: number, fromPct: number, toPct: number } | null,
 *            lines: { key: string, title: string, level: string, text: string }[], gaps: string[],
 *            source: any, openRuleText: string }}
 */
export function redeemAdvice(a) {
  const args = a && typeof a === "object" ? a : {};
  const p = args.p && typeof args.p === "object" ? args.p : {};
  const pos = args.pos && typeof args.pos === "object" ? args.pos : null;
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(args.td || "")) ? String(args.td) : "";
  const disc = normDisc(p.disc);
  const gaps = discGaps(p.disc).filter(g => g !== "source");

  const out = {
    verdict: "unclear", verdictText: ADV_VERDICTS.unclear,
    holdDays: 0, unlockInDays: null,
    ratePct: null, market: null, fee: null, net: null, nextDrop: null,
    lines: [], gaps, source: disc.source || null, openRuleText: disc.openRule
  };

  /* 1 有没有可赎的东西：没持仓这一整题都不成立，别拿 0 份去算钱 */
  if (!pos || !(Number(pos.shares) > 0)) {
    out.verdict = "skip"; out.verdictText = ADV_VERDICTS.skip;
    out.lines.push(line("shares", "skip",
      pos && pos.inTransit ? "买入还在途、份额没确认，「赎」这个动作这会儿还不成立"
                           : "没有已确认持仓，赎不赎、赎多少都不适用"));
    return out;
  }

  const holdDays = Number(pos.holdDays) || 0;
  out.holdDays = holdDays;

  /* 2 持有期这一关：字段没录就是判不了，绝不按 0 天放行（与 T2 第 4 条同一口径） */
  let timeOk = false;
  if (disc.lockDays === null) {
    out.lines.push(line("lock", "na", `信息不足（缺${DISC_GAP_LABEL.lockDays}）：这一关判不了，不许按 0 天放行`));
  } else if (disc.lockDays === 0) {
    timeOk = true;
    out.lines.push(line("lock", "ok", "披露为无持有期限制"));
  } else if (holdDays < disc.lockDays) {
    out.unlockInDays = disc.lockDays - holdDays;
    out.lines.push(line("lock", "bad", `还在最短持有期内：已持有 ${holdDays} 天，要求 ${disc.lockDays} 天，还差 ${out.unlockInDays} 天`));
  } else {
    timeOk = true;
    out.lines.push(line("lock", "ok", `已持有 ${holdDays} 天，满 ${disc.lockDays} 天要求`));
  }

  /* 3 开放安排：读得懂且表明确实可赎才算过；空着或读不懂都只是「判不了」，
        读不懂时把原文照回显 —— 屏上有原文，用户才看得出是我们认不出而不是产品没写 */
  if (!disc.openRule) {
    out.lines.push(line("open", "na", `信息不足（缺${DISC_GAP_LABEL.openRule}）：不知道有没有固定开放日`));
  } else if (!isOpenRuleDaily(disc.openRule)) {
    out.lines.push(line("open", "na", `开放安排认不出来：原文「${disc.openRule}」。这条要照披露原文自己判，本工具不猜`));
  } else {
    out.lines.push(line("open", "ok", `开放安排读得出可赎回：原文「${disc.openRule}」`));
  }
  const openOk = !!disc.openRule && isOpenRuleDaily(disc.openRule);

  /* 4 结论词：三档里最保守的那一档 —— 持有期与开放安排有一项判不了就是「判不了」 */
  if (!timeOk && out.unlockInDays !== null) { out.verdict = "no"; out.verdictText = ADV_VERDICTS.no; }
  else if (timeOk && openOk) { out.verdict = "yes"; out.verdictText = ADV_VERDICTS.yes; }
  else { out.verdict = "unclear"; out.verdictText = ADV_VERDICTS.unclear; }

  /* 5 赎回费落在哪一档：feeRateFor 返回 null 是「不知道」，与 0% 是两回事 */
  const tierOk = disc.feeRedeem.length > 0 && timeOk;
  if (!disc.feeRedeem.length) {
    out.lines.push(line("fee", "na", `信息不足（缺${DISC_GAP_LABEL.feeRedeem}）：赎回来要扣多少算不了`));
  } else if (!timeOk) {
    out.lines.push(line("fee", "skip", "还在持有期内 / 持有期判不了，现在谈不上落在哪一档费率"));
  } else {
    const rate = feeRateFor(disc, holdDays);
    if (rate === null) {
      out.lines.push(line("fee", "warn", `持有 ${holdDays} 天不落任何已录档位：分档区间里有空洞，请照披露原文补齐`));
    } else {
      out.ratePct = rate;
      out.lines.push(line("fee", rate > 0 ? "warn" : "ok", `持有 ${holdDays} 天落在 ${rate}% 这一档`));
    }
  }

  /* 6 钱：只有「市值成立」且「费率已知」才算得出，两个条件缺一个都是 null。
        市值来自 position.js（已确认份额 × 最新净值），这里不重算。 */
  const market = Number(pos.market);
  if (isFinite(market) && market > 0) {
    out.market = r2(market);
    if (out.ratePct !== null && tierOk) {
      out.fee = r2(market * out.ratePct / 100);
      out.net = r2(market - out.fee);
    }
  } else {
    out.lines.push(line("money", "na", "最新净值缺失或为零，市值不成立，赎多少算不了"));
  }

  /* 7 再等几天能降到下一档：只有当前档已知、且后面确实有更低的档才提示。
        当前档未知时不算 —— 不知道现在扣几个点，就说不准「等一等能省多少」。 */
  if (out.ratePct !== null) {
    const later = disc.feeRedeem.filter(f => f.from > holdDays && isFinite(f.ratePct) && f.ratePct < out.ratePct)
      .sort((x, y) => x.from - y.from)[0];
    if (later) {
      out.nextDrop = { days: later.from - holdDays, fromPct: out.ratePct, toPct: later.ratePct };
      out.lines.push(line("next", "warn",
        `再等 ${out.nextDrop.days} 天可降到 ${out.nextDrop.toPct}% 这一档（现在落在 ${out.nextDrop.fromPct}%）`));
    }
  }

  /* 8 净值新不新：上面的钱是按 lastDate 那天算的，落后太多要当场说明（不猜今天的净值） */
  if (pos.lastDate && td) {
    const lag = navLagTradingDays(String(pos.lastDate), td);
    if (lag >= 2) out.lines.push(line("nav", "warn", `上面的数字按 ${pos.lastDate} 的净值算，已落后 ${lag} 个交易日`));
  }

  /* 9 出处：有就报是哪一版披露，没有就明说 —— 判据本身在 disc.js（铁律 3） */
  if (disc.source && disc.source.publishedAt) {
    out.lines.push(line("source", "ok", `规则出处：${DISC_TIER_TEXT(disc.source.tier)}（披露日 ${disc.source.publishedAt}）`));
  } else if (discGaps(p.disc).indexOf("source") >= 0) {
    out.lines.push(line("source", "na", "没有合格出处（缺链接或站内披露日期）：下面的判定按你手工录的值走"));
  }

  /* 10 还缺什么一次列全并指回补录的地方 —— 上面每行各说一句会重复，用户看不出总共差几项 */
  if (gaps.length) {
    out.lines.push(line("gap", "na",
      `还缺 ${gaps.map(g => DISC_GAP_LABEL[g] || g).join("、")}：在上面「底层配置与申赎规则」那张卡里照披露原文补`));
  }
  return out;
}
