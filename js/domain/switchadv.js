// @ts-check
/* ---------- T7b：从这一只换到另一只，换得动吗、要多背什么（v75 起）----------
   五条口径，逐条都有 tests/switchadv.test.mjs 与闸门第 10 节盯着：

   1) 不另起炉灶算钱。A 能不能赎、赎要付多少、扣完剩多少，全部直接取
      redeemAdvice 的结果（market / ratePct / fee / net 四个字段原样转发）。
      这一层一旦出现第二处「份额 × 净值」或「费率 ÷ 100」，
      T7a 改口径时这里就会悄悄算出另一个数 —— 折钱永远只在一处。

   2) 结论只有四档：换得动 / 换不动 / 判不了 / 不适用。没有「该换」这一档。
      台账能录的披露项就是 disc.js 里那五样（持有期、开放安排、赎回费分档、
      底层资产、投资范围）—— 没有业绩比较基准、没有风险等级、没有申购费、
      也没有申赎确认时效。拿净值历史折算出来的数去说「该换」，
      正是 app.js 里警告过的「拿着缺档的规则算出看不出错的建议」。
      所以这里只把确定的说确定、不知道的原样写成不知道，方向由用户自己定。

   3) null 是不知道，0 是知道且为零。B 的最短持有没录 → 那一行判不了，
      绝不按「没有锁定期」放行；申购费与到账空档没有字段 → 明说算不出，
      也不许把这两个成本当 0 算进总账。

   4) 结论文本里不写钱，也不写收益数字。年化是拿钱算出来的，
      页面在「隐藏金额」时连持仓年化一起遮（renderHome 那条口径已经定了），
      这一层要是把「高 0.83 个百分点」写进文本，等于绕过遮罩把收益摆在大屏上。
      数字留在字段上，由页面走 shown(pct(...)) 现算现显。

   5) 不读时钟、不读表、不写账、不发请求、不缓存。td 由调用方给。
      换 = 一笔赎回 + 一笔申购，两笔各自照披露计费（铁律 5 不双计费在这一版的意思是：
      引擎既不多算一笔，也绝不代替用户生成那两笔交易）。
*/
import { normDisc, feeRateFor, discGaps, DISC_GAP_LABEL, DISC_TIER_LABEL } from "../core/disc.js";
import { redeemAdvice, isOpenRuleDaily } from "./advice.js";
import { navLagTradingDays } from "./calendar.js";

/** 结论四档 —— 顺序即档位，测试钉的是「没有该换这一档」 */
export const SW_VERDICTS = { ready: "现在换得动", no: "现在换不动", unclear: "判不了", skip: "不适用" };

/** 每一行的中文题头：屏上出现的行名只从这里出，不许在函数里现编 */
export const SW_LINE_TITLES = {
  pick: "对比对象", from: "这一只（要赎的）", to: "那一只（要换进的）",
  lock: "重新锁定", open: "那一只的开放安排", feeFrom: "赎回这一笔",
  feeTo: "申购那一笔", gap: "到账空档", tierTo: "那一只的赎回费",
  perf: "历史收益", nav: "净值新旧", source: "两边出处", miss: "还缺"
};

/** @param {string} key @param {string} level @param {string} text */
function line(key, level, text) {
  return { key, title: SW_LINE_TITLES[key] || key, level, text };
}

/** 出处那一行：合格就说分级与站内披露日期，不合格就明说（判据在 disc.js，铁律 3） */
function srcText(d) {
  const x = normDisc(d);
  if (x.source && x.source.publishedAt) {
    return `${DISC_TIER_LABEL[x.source.tier] || x.source.tier}（披露日 ${x.source.publishedAt}）`;
  }
  return "没有合格出处（缺链接或站内披露日期）：按你手工录的值判";
}

/** toLockDays 的两种「没数」：null = 没录（不知道），0 = 披露为无持有期限制（知道且为零）。
 *  渲染层必须分开显示，把 0 也画成破折号就等于把「知道」说成「不知道」。 */
/**
 * @param {{ a?: any, b?: any, posA?: any, posB?: any, td?: string }} inp
 * @returns {{ verdict: string, verdictText: string, unlockInDays: number | null,
 *            market: number | null, ratePct: number | null, fee: number | null, net: number | null,
 *            toLockDays: number | null, toRatePct: number | null,
 *            perf: { a: number | null, b: number | null, diff: number | null, holdA: number, holdB: number },
 *            lines: { key: string, title: string, level: string, text: string }[],
 *            gaps: string[], from: any, to: any, advA: any }}
 */
export function switchAdvice(inp) {
  const args = inp && typeof inp === "object" ? inp : {};
  const a = args.a && typeof args.a === "object" ? args.a : null;
  const b = args.b && typeof args.b === "object" ? args.b : null;
  const posA = args.posA && typeof args.posA === "object" ? args.posA : null;
  const posB = args.posB && typeof args.posB === "object" ? args.posB : null;
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(args.td || "")) ? String(args.td) : "";

  const out = {
    verdict: "unclear", verdictText: SW_VERDICTS.unclear,
    unlockInDays: null,
    market: null, ratePct: null, fee: null, net: null,
    toLockDays: null, toRatePct: null,
    perf: { a: null, b: null, diff: null, holdA: 0, holdB: 0 },
    lines: [], gaps: [], from: null, to: null, advA: null
  };

  /* 1 没选对象 / 选的就是这一只：整题不成立，别拿 undefined 去比 */
  if (!a || !b) {
    out.verdict = "skip"; out.verdictText = SW_VERDICTS.skip;
    out.lines.push(line("pick", "skip", "还没选要换进的那一只：跨产品的比较要两只都在，本工具不从一只里推出另一只"));
    return out;
  }
  if (String(a.id) === String(b.id)) {
    out.verdict = "skip"; out.verdictText = SW_VERDICTS.skip;
    out.lines.push(line("pick", "skip", "对比对象就是这一只：换给自己不叫换仓"));
    return out;
  }
  out.from = a; out.to = b;

  /* 2 A 侧照抄 T7a —— 赎不出来就谈不上换，钱也一律用它的字段 */
  const advA = redeemAdvice({ p: a, pos: posA, td });
  out.advA = advA;
  out.market = advA.market; out.ratePct = advA.ratePct;
  out.fee = advA.fee; out.net = advA.net; out.unlockInDays = advA.unlockInDays;
  if (advA.verdict === "skip") {
    out.verdict = "skip"; out.verdictText = SW_VERDICTS.skip;
    out.lines.push(line("from", "skip", `这一只${advA.verdictText}：${advA.lines.length ? advA.lines[0].text : "没有可赎的东西"}`));
    return out;
  }
  if (advA.verdict === "no") {
    out.verdict = "no"; out.verdictText = SW_VERDICTS.no;
    out.lines.push(line("from", "bad", `这一只还在最短持有期内（还差 ${advA.unlockInDays} 天），这会儿换不动`));
  } else if (advA.verdict === "unclear") {
    out.verdict = "unclear"; out.verdictText = SW_VERDICTS.unclear;
    out.lines.push(line("from", "na", `这一只能不能赎都判不了：${(advA.lines.filter(l => l.level === "na")[0] || {}).text || "关键披露项没录"}`));
  } else {
    out.lines.push(line("from", "ok", `这一只现在赎得出来（已持有 ${advA.holdDays} 天）`));
  }
  if (advA.ratePct === null) {
    out.lines.push(line("feeFrom", "warn", "赎回费没披露：这一笔要扣多少算不出 —— 这是「不知道」，不是「不要钱」"));
  } else {
    out.lines.push(line("feeFrom", advA.ratePct > 0 ? "warn" : "ok", `赎回费落在 ${advA.ratePct}% 这一档，扣完到手见上方数字`));
  }

  /* 3 B 侧「换过去要背的」：持有期与开放安排按同一条 null 口径 */
  const db = normDisc(b.disc);
  const gb = discGaps(b.disc).filter(g => g !== "source");
  let toOk = true;
  if (db.lockDays === null) {
    toOk = false;
    out.toLockDays = null;
    out.lines.push(line("lock", "na", `信息不足（缺${DISC_GAP_LABEL.lockDays}）：换过去要锁多久不知道，不许按「没有锁定」放行`));
  } else if (db.lockDays === 0) {
    out.toLockDays = 0;
    out.lines.push(line("lock", "ok", "那一只披露为无持有期限制：换进去不用重新锁"));
  } else {
    out.toLockDays = db.lockDays;
    out.lines.push(line("lock", "warn", `换过去等于从零起算，要再锁 ${db.lockDays} 天才能赎（这一只在手的 ${Math.floor(Number((posA && posA.holdDays) || 0))} 天历史带不过去）`));
  }
  if (!db.openRule) {
    toOk = false;
    out.lines.push(line("open", "na", `信息不足（缺${DISC_GAP_LABEL.openRule}）：不知道那一只什么时候能赎`));
  } else if (!isOpenRuleDaily(db.openRule)) {
    toOk = false;
    out.lines.push(line("open", "na", `那一只的开放安排认不出来：原文「${db.openRule}」。这条要照披露原文自己判，本工具不猜`));
  } else {
    out.lines.push(line("open", "ok", `那一只的开放安排读得出可赎回：原文「${db.openRule}」`));
  }
  /* 那一只买进去之后落在哪一档：holdDays = 0 是「刚买进去」这一确定事实，不是猜的 */
  if (!db.feeRedeem.length) {
    toOk = false;
    out.lines.push(line("tierTo", "na", `信息不足（缺${DISC_GAP_LABEL.feeRedeem}）：那一只将来赎要付多少也算不出`));
  } else {
    const rt = feeRateFor(b.disc, 0);
    if (rt === null) {
      toOk = false;
      out.lines.push(line("tierTo", "warn", "那一只的分档里有空洞：刚买进去不落任何已录档位，请照披露补齐"));
    } else {
      out.toRatePct = rt;
      out.lines.push(line("tierTo", rt > 0 ? "warn" : "ok", `刚换进去那一刻落在 ${rt}% 这一档（这是那一只将来赎回时的成本，不是现在的）`));
    }
  }

  /* 4 台账里没有的三样成本：照实说算不出，一律不按 0 计入 */
  out.lines.push(line("feeTo", "na", "申购费：台账里没有这一项（能录的披露项就是底层配置那张卡上的五样）。这一侧要付多少算不出，不是零"));
  out.lines.push(line("gap", "na", "到账空档：赎回来几天到账、买进去哪天确认起息，台账里也没录。这段两边都不沾的日子本工具算不出，同样不是零"));

  /* 5 收益：只有两边都建了仓、都满 7 天才给数，而且只当参考 */
  const va = posA && posA.annualValid ? Number(posA.holdAnnual) : null;
  const vb = posB && posB.annualValid ? Number(posB.holdAnnual) : null;
  out.perf.holdA = Math.floor(Number((posA && posA.holdDays) || 0));
  out.perf.holdB = Math.floor(Number((posB && posB.holdDays) || 0));
  if (va === null || vb === null) {
    out.lines.push(line("perf", "na", "两边的持仓年化凑不齐（那一只没建仓，或任一边持有不足 7 天）：本工具不拿净值走势假装预测收益，详情页的 7 日年化只是展示"));
  } else {
    out.perf.a = va; out.perf.b = vb; out.perf.diff = vb - va;
    out.lines.push(line("perf", "warn", `两边的年化各按自己的持有天数折算（这一只 ${out.perf.holdA} 天、那一只 ${out.perf.holdB} 天），窗口不同、不是同一把尺。差多少见上方数字，它不构成换过去的依据`));
  }

  /* 6 净值新旧：上面的数全按 lastDate 那天算的，落后太多要当场说明 */
  const la = posA && posA.lastDate ? navLagTradingDays(String(posA.lastDate), td) : 0;
  const lb = posB && posB.lastDate ? navLagTradingDays(String(posB.lastDate), td) : 0;
  if (la >= 2 || lb >= 2) {
    out.lines.push(line("nav", "warn", `这一只按 ${String((posA && posA.lastDate) || "—")} 的净值算（落后 ${la} 个交易日）、那一只按 ${String((posB && posB.lastDate) || "—")}（落后 ${lb} 个交易日）：先补净值再谈换`));
  }

  /* 7 出处：两边各说一句（铁律 3 的判据在 disc.js，这里只念结果） */
  out.lines.push(line("source", (a.disc && a.disc.source && a.disc.source.publishedAt && b.disc && b.disc.source && b.disc.source.publishedAt) ? "ok" : "na",
    `这一只：${srcText(a.disc)}｜那一只：${srcText(b.disc)}`));

  /* 8 缺项一次列全 + 指回补的地方：跨产品就是两倍的缺项，散在各行用户数不过来 */
  out.gaps = gb.slice();
  if (out.gaps.length) {
    out.lines.push(line("miss", "warn", `那一只还缺 ${out.gaps.length} 项（${out.gaps.map(g => DISC_GAP_LABEL[g] || g).join("、")}）：进了那一只的详情页，在「录入 / 修改配置」里照披露原文补`));
  }

  /* 9 结论：A 赎不出来就是换不动；A 判不了就是判不了；A 赎得出来时，
        B 的关键项没录齐也只能是判不了 —— 两边都齐才叫「换得动」。
        注意这一档的名字是「换得动」，不是「该换」。 */
  if (advA.verdict === "yes") {
    out.verdict = toOk ? "ready" : "unclear";
    out.verdictText = SW_VERDICTS[out.verdict];
    if (!toOk) out.lines.unshift(line("to", "na", "那一只的关键披露项还没录齐：换得动换不动先判不了（下面每行都说了缺什么）"));
  } else if (out.verdict === "no" && !toOk) {
    out.lines.unshift(line("to", "na", "顺带说一句：那一只的关键披露项也没录齐，就算这边赎得出来照样判不了"));
  }
  return out;
}
