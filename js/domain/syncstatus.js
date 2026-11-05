// @ts-check
/* 同步状态的显示口径（v46）。

   为什么单独成模块：v45 之前顶栏那三个字是 syncPush 成功那一刻硬写死的（app.js 旧
   3042 行），DIRTY 只往 localStorage 里存、从不露面。结果「本地有改动没推上去」和
   「刚刚推成功」在界面上长得一模一样 —— 自动推送其实一直在跑（autoPush 1.5 秒
   debounce），用户看不见它，卸载重装前就只能靠「我记得我推过」给自己壮胆。
   所以缺的从来不是同步机制，是**把机制的结果说出来**。

   这里只回答两个问题：顶栏该显示哪几个字、设置页该说哪一句。输入全是时间戳与
   一个错误串，输出纯字符串 —— 存哪儿、什么时候重试，都留在 app.js。 */

/**
 * 「多久以前」的口语量级：手机上看同步状态不需要精确到秒，
 * 但需要区分「刚推完」和「昨天推的」。
 * @param {number} ms 距今的毫秒数（负数按 0 处理，时钟回拨不至于显示 -3 秒）
 * @returns {string}
 */
export function relAge(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  if (s <= 3) return "刚刚";
  if (s < 60) return s + " 秒";
  if (s < 3600) return Math.floor(s / 60) + " 分";
  if (s < 86400) return Math.floor(s / 3600) + " 小时";
  return Math.floor(s / 86400) + " 天";
}

/** relAge + 「前」，但「刚刚」本身已经是「前」的意思，不加后缀才读得通 */
export function ago(ms) {
  const r = relAge(ms);
  return r === "刚刚" ? r : r + "前";
}

/**
 * 顶栏状态胶囊。
 *
 * 口径只有一条值得强调：**dirtyAt 存在就一律报「没推上去」**，哪怕 pushAt 更新。
 * 推送成功后用户再改一笔，dirtyAt 会晚于 pushAt；反过来若哪天真出现 pushAt 比
 * dirtyAt 新（重试路径的时序），也宁可显示待推送 —— 显示错成「已同步」是让人
 * 放心去卸载，显示错成「待推送」只是多点一次按钮，两种错不是同一种代价。
 *
 * @param {{cfgOk?:boolean, dirtyAt?:number, pushAt?:number, err?:string, now?:number}} st
 * @returns {{text:string, cls:string}} cls 对应 index.html 里 .sync-state 的修饰类
 */
export function syncBadge(st) {
  const now = st.now || Date.now();
  if (!st.cfgOk) return { text: "未连接", cls: "" };
  if (st.dirtyAt) {
    /* 失败过就别再报中性的「待推送」：那会让人以为只是还没轮到，
       而实际上退避重试可能已经跑完了在等人管。 */
    if (st.err) return { text: "推送失败", cls: "bad" };
    return { text: "待推送 · " + ago(now - st.dirtyAt), cls: "warn" };
  }
  if (st.pushAt) return { text: "已同步 · " + ago(now - st.pushAt), cls: "ok" };
  /* 配置在、本机没改动、也还没推过 —— 全新设备或刚清过状态 */
  return { text: "已连接", cls: "" };
}

/**
 * 设置页里那一整句：把顶栏装不下的原因与下一步交代清楚。
 * @param {{cfgOk?:boolean, dirtyAt?:number, pushAt?:number, err?:string, nextAt?:number,
 *          retryN?:number, maxRetry?:number, now?:number}} st
 *   retryN 按「排期中的这一发是第几次重试」给（app.js 的 scheduleRetry 先自增再排期），
 *   所以它等于 1 就是「第 1/3 次」，不要再 +1。
 * @returns {string} 纯文本（不含 HTML，由调用方决定怎么上色）
 */
export function syncLine(st) {
  const now = st.now || Date.now();
  const max = st.maxRetry || 3;
  if (!st.cfgOk) return "尚未连接云端：填好仓库与 Token 后，改动会在 1.5 秒后自动推上去。";
  if (!st.dirtyAt) {
    if (!st.pushAt) return "本机没有待推送的改动，这次运行还没推过。";
    return "本机改动都已推上去了（最后一次推送：" + ago(now - st.pushAt) + "）。";
  }
  let s = "本地有改动还没推上去（最后编辑：" + ago(now - st.dirtyAt) + "）。";
  if (!st.err) return s + " 自动推送在跑，不用管它。";
  s += " 上次失败：" + st.err + "。";
  if (st.nextAt && st.nextAt > now) {
    const wait = relAge(st.nextAt - now);
    s += (wait === "刚刚" ? "马上" : wait + "后") + "自动重试（第 " + Number(st.retryN || 0) + "/" + max + " 次）。";
  } else if (Number(st.retryN || 0) >= max) {
    /* 退避用完就实话实说，别继续演「马上就好」：此时只有用户点得动 */
    s += " 自动重试已用完，可以点上面的「↑ 推送到云端」，或等下次联网 / 切回前台再试。";
  } else {
    s += " 正在准备下一次重试。";
  }
  return s;
}

/* ============================================================
   抓取失败的原因分类与告警标题（v84）

   为什么要有这一档：`settings.lastFetch.items` 里每一行是抓取器写的
   「产品名 — 数据源：原因」，而「原因」其实有三类完全不同的事：
     · blocked —— 披露源把请求拦下了（风控 / 验证失败 / 频繁 / 受限 / 安全校验）；
                  数据很可能存在，是我们这一轮取不到，等冷却即可，不该反复手动抓。
     · refused —— 自家闸门拒取（份额类别对不上，宁可不填）；净值不缺，缺的是账本
                  里那个代码字段，动作是去核对，不是去等披露。
     · missing —— 其余（未披露、未取到、原因没写）。
   告警条从前只有一句「有 N 只产品没拿到净值」，把前两类也说成「没拿到」——同一个
   句子盖住三种病因，用户就会去做错的那一种：对着被拦的源反复点「立即抓取」，或者
   去改本来填对了的代码。铁律 #10：降级要降得诚实，说不清就说不清，不许替源猜。
   ============================================================ */

/** 披露源侧的拦截特征。认「被限制」这件事本身，不认具体哪家风控的措辞。 */
const FETCH_BLOCK_MARKS = /风控|验证失败|频繁|受限|拦截|安全校验/;
/** 自家闸门拒取的特征（判据在 navsources/banks/chinawealth.py:_cw_pick_row）。 */
const FETCH_REFUSE_MARKS = /份额类别对不上|宁可不填/;

/**
 * 一行失败原因 → "blocked" | "refused" | "missing"。
 *
 * 认不出来的一律退回 "missing"：把它升级成「被拦下」会骗人说源坏了，
 * 降级成「没有数据」会骗人说产品没披露 —— 两边都是假话，宁可按原样。
 * 一行里同时出现两类关键词时（多源原因用「；」并到一行）先判闸门拒取：
 * 那是我们自己拦的，跟源的状态无关，说出来才是可行动的。
 *
 * @param {unknown} line lastFetch.items 里的一条
 * @returns {"blocked"|"refused"|"missing"}
 */
export function fetchFailKind(line) {
  const s = String(line || "");
  if (FETCH_REFUSE_MARKS.test(s)) return "refused";
  if (FETCH_BLOCK_MARKS.test(s)) return "blocked";
  return "missing";
}

/**
 * 首页告警条的标题（含「本机抓取 / 云端抓取」前缀）。
 *
 * 计数口径：`fail` 是失败产品数，`items` 只留前 20 条。分不出原因的那部分
 * （fail 减掉已分类的条数）照实算进「这轮没拿到」，绝不因为前面有一条是
 * 被拦下，就把整批说成被拦下。
 *
 * @param {{fail?:number, items?:unknown, source?:string}|null} lf settings.lastFetch
 * @returns {string} 零失败时返回空串，由调用方决定不显示
 */
export function fetchAlertHeading(lf) {
  const n = lf ? (Number(lf.fail) || 0) : 0;
  const who = (lf && lf.source === "app") ? "本机抓取" : "云端抓取";
  if (!n) return "";
  const items = (lf && Array.isArray(lf.items)) ? lf.items : [];
  let blocked = 0, refused = 0;
  for (const it of items) {
    const k = fetchFailKind(it);
    if (k === "blocked") blocked++;
    else if (k === "refused") refused++;
  }
  if (!blocked && !refused) return `${who}有 ${n} 只产品没拿到净值`;
  const parts = [];
  if (blocked) parts.push(`${blocked} 只是请求被披露源拦下、不是这些产品没有净值`);
  if (refused) parts.push(`${refused} 只是份额类别对不上、宁可不填，核对后自动补上`);
  const rest = Math.max(0, n - blocked - refused);
  if (rest) parts.push(`${rest} 只这轮没拿到`);
  return `${who}有 ${n} 只产品这轮没入账（${parts.join("；")}）`;
}
