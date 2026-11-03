// @ts-check
/* ---------- 模型接入（T3）：请求构造 / 响应解析 / 来源分级 / 分块组装 ----------
   从 app.js 拆出来的纯函数（同 analysis.js / board.js 的做法）：拆出来才能被 node --test 钉住。

   ★ 这一层的七条口径（改任何一条都要同步改 tests/llm.test.mjs）：
     1. **JS 永不经手 key。** 请求里没有 key 字段、没有 Authorization 头，
        llmReq() 的输出会被原样丢给 window.NativeLlm.ask()，由原生侧补鉴权。
        所以这里连「key」这个字都不许出现成字段名 —— 出现了就等于承诺 JS 能填。
     2. **不猜端点返回的形状。** Responses 形制（output[] 里有 message / web_search_call）
        与 Chat 形制（choices[]）都收，认不出来就明说 unknown。
        ★ 真实端点到底返回什么、web_search_call 里带不带 URL 与发布时间，
          截至本版**没有实测过**（没有可用凭据）。解析器因此只做「有则收、无则明说」，
          绝不为了好看去补字段 —— 补出来的出处比没有出处更坏。
     3. **来源分级要 URL + 发布时间两样齐。** 缺任何一条就不入账，进 dropped 并写明缺哪样。
        与铁律 #3 同义：一条没有出处的「模型说的」不能进台账。
     4. **失败不自动重试。** 一次请求一次计费，超时 / 断网 / 5xx 一律把状态交回用户，
        由用户手点重试（llmCanRetry 只认「用户点过」这一个条件）。
        与铁律 #5 同义：自动重试 = 可能双份计费。
     5. **会话只活在这台机器的内存里。**（v65 多轮问答）上文压成一段文本随 input 上送，
        落在页面的 LLM.turns / LLM.turn 两个变量上 —— 不写 localStorage、不进 licai-data.json，
        刷新或换设备就从第一轮重新问。轮次到 LLM_MAX_ROUNDS 就停手，失败与超时的那轮也占额度。
        这道闸拦的是「连着点、连着计费」，不是拦「问得多」。
     6. **台账快照「勾了才给」。**（v66）默认关，开着时每一屏都写明本轮会带几只、多少字。
        出这台机器的字段是白名单那十个（名称/机构/代码/风险级/净值/净值日期/份额/成本/持有天数/状态），
        入参里混进别的键也不会出来；本机开着「隐藏金额」时份额与成本跟着一起藏 ——
        屏幕上被你藏掉的数，不许从这条路上漏出去。
     7. **协议形制由原生侧拼，页面不碰。**（v67 · R1）页面交出去的还是那两样（input / instructions），
        换成 Chat Completions 的 messages[] 是 LlmBridge.ask() 的事 —— 同一个形状两处各写一遍迟早对不上，
        而对不上的那一份是花钱的请求。设置里那个「协议」选择器只在**新壳**上出现：
        getConfig 回来的 JSON 里没有 apiStyle 这个键，就说明这台机器的壳还不认，那一行不画。
        另外，星火这类 OpenAI 兼容网关的失败是「HTTP 200 + body 里 code 非 0」，
        llmParse 认它是**业务错误**，把 code 与官方 message 原样交回用户 —— 不翻译、不美化、不归类。

   ★ v65 / v66 只改页面这一侧：桥面七个方法一字未动，所以不发包（壳里那份桥还是 v64 编进去的）。
     代价说清楚：壳加载的是 APK 里的 assets/www（MainActivity.START_URL），不是 GitHub Pages，
     所以 v65 这份页面在**下一次打包之前不会到手机上**；这里能验的只有本地浏览器 + 假桥。
   ★ v67（R1）桥面方法表仍未动，改的是原生侧的**行为**，所以这一版配套出 1.0.219：
     旧壳上「协议」这一行不画（getConfig 里没有那个键），发的还是 Responses —— 与 v66 行为一致。
*/

/** 桥名。Java 侧 addJavascriptInterface(..., "NativeLlm") 必须同名，verify-web.sh 比对两侧方法。 */
export const LLM_BRIDGE = "NativeLlm";
/**
 * 桥面清单：页面侧只经这几个方法碰原生，一个不多。
 * scripts/verify-web.sh（私有仓）会拿这张表逐个点 LlmBridge.java 里的方法名 ——
 * 页面调了原生没有的方法，表现是「点了没反应」而构建全绿，只能靠这张表拦。
 * 清单放在纯模块里而不是散在 app.js 的调用点，是为了让它可测、可比对。
 */
export const LLM_BRIDGE_METHODS = ["ready", "getConfig", "setConfig", "hasKey", "promptKey", "clearKey", "ask"];
/* 回传为什么要分块：Java→JS 单次 evaluateJavascript 的上限没有实测数据
   （沙箱里没有真机），所以不赌它 —— 原生侧按块喂 (seq, total, text)，JS 侧拼。
   块大小是原生侧的事，这里只校验序号：JS 不需要知道切了多少字节。 */
/** 一次问答的等待上限：模型端点慢是常态，120 秒还没回就当失败（不自动重发）。 */
export const LLM_TIMEOUT_MS = 120000;
/** 分块缓冲的上限：块数超过这个数一定是拿错了响应，别把内存吃光。 */
export const LLM_CHUNK_MAX_PARTS = 512;
/**
 * 一个会话最多发几轮（v65）。这不是产品能力，是**防误点的闸门**：
 * 每一轮都是一次真实计费，而多轮问答最容易出的事故就是「连着点、越点越贵」。
 * 到数就停手，要接着问得先把上文清掉 —— 清空这个动作本身就是一次「我知道我要再花钱」。
 */
export const LLM_MAX_ROUNDS = 6;
/** 上文回看的长度上限（字符）。超了从最旧的那轮丢起，最近几轮对新问题最有用。 */
export const LLM_TRANSCRIPT_MAX_CHARS = 8000;
/** 台账快照（v66）的两处上限：条数与字数。超限是「写明还有多少没带上」，不是静默截。 */
export const LLM_SNAPSHOT_MAX_ITEMS = 30;
export const LLM_SNAPSHOT_MAX_CHARS = 4000;
/** 本机开着「隐藏金额」时，快照里金额位的替代文案。 */
export const LLM_SNAPSHOT_MASKED = "（金额已隐藏）";

/**
 * 构造发给桥的请求体。**只有问题与指令两样**：
 * baseUrl / model / 密钥全在原生侧的配置里，JS 连提它们的字段都没有 ——
 * 少一个入口就少一处能被篡改的地方（页面里任何一段脚本都能调桥）。
 * @param {{ input?: string, instructions?: string }} q
 * @returns {{ v: number, input: string, instructions: string }}
 */
export function llmReq(q) {
  const o = q || {};
  return {
    v: 1,
    input: String(o.input == null ? "" : o.input),
    instructions: String(o.instructions == null ? "" : o.instructions),
  };
}

/**
 * 把已经落定的轮次压成**一段纯文本**，接在新问题前面发给模型（v65 多轮问答）。
 * ★ 为什么是文本而不是结构化的消息数组：原生侧 LlmBridge.ask() 把 input 原样塞进
 *   请求体的字符串字段（`req.put("input", input)`），要变成 [{role, content}] 就是 Java 改动。
 *   v65 不动壳、不发包，所以上下文只能用文本带 —— 这不为好看，为的是「不碰密钥那条路」。
 * 丢掉的旧轮次要在文本里写明丢了几轮，不许静默缩水：
 * 用户以为模型还记得，其实模型这回看不到那几轮了。
 * @param {{q?: string, a?: string}[]|null} turns
 * @returns {string}
 */
export function llmTranscript(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const parts = [];
  for (const t of list) {
    const q = String((t && t.q) || "").trim();
    if (!q) continue;                       /* 没问出去的一轮不进上文 */
    const a = String((t && t.a) || "").trim();
    parts.push("问：" + q + "\n答：" + (a || "（这一轮没有拿到答案）"));
  }
  if (!parts.length) return "";
  const keep = [];
  let used = 0, dropped = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const n = parts[i].length + 2;
    /* 最新那一轮一定留着，哪怕它自己就超长 —— 否则新问题变成一句没头没尾的话 */
    if (keep.length && used + n > LLM_TRANSCRIPT_MAX_CHARS) { dropped = i + 1; break; }
    keep.unshift(parts[i]);
    used += n;
  }
  if (dropped) keep.unshift("（更早 " + dropped + " 轮没有带上：超过上文长度上限）");
  return keep.join("\n\n");
}

/**
 * 这一轮真正发出去的 input = 上文 + 台账快照 + 新问题（顺序就按这个排：先给人看过的历史，
 * 再给本轮的依据，最后才是要回答的那句）。没有上文也没有快照时就是新问题本身。
 * @param {{q?: string, a?: string}[]|null} turns @param {string} q @param {string} [snapshot]
 */
export function llmRoundInput(turns, q, snapshot) {
  const fresh = String(q == null ? "" : q).trim();
  const blocks = [];
  const hist = llmTranscript(turns);
  if (hist) blocks.push("【以前几轮的问答，按时间先后】\n" + hist);
  const snap = String(snapshot == null ? "" : snapshot).trim();
  if (snap) blocks.push(snap);
  if (!blocks.length) return fresh;
  blocks.push("【这一次要问的】\n" + fresh);
  return blocks.join("\n\n");
}

/** 一个字段进快照前的过一遍：只留一行、限长、去掉可能造成「看着像凭据」的空白粘连。 */
function oneLine(v, max) {
  const s = String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim();
  const lim = max || 80;
  return s.length > lim ? s.slice(0, lim) + "…" : s;
}

function num(v, dp) {
  const n = Number(v);
  return isFinite(n) ? n.toFixed(dp === undefined ? 2 : dp) : "—";
}

/**
 * 把本机台账压成一段文本，作为「这一轮给模型看的依据」（v66）。
 * ★ 白名单出字段：只写 name / inst / code / risk / nav / navDate / shares / cost /
 *   holdDays / state 这十个。入参里就算混着 token、secret、仓库路径、任何别的键，
 *   一个字都不会出来 —— 这段文本是要出这台机器的，白名单比黑名单可靠。
 * ★ 缺就如实写缺：没净值写「无净值」，日期不明写「日期不明」。
 *   猜一个数进去，模型会把它当本机台账的真数引用，那比空着坏得多。
 * ★ 本机开着「隐藏金额」时，份额与成本都不出机器 —— 屏幕上被你藏掉的数，
 *   不许从这条路上漏出去。产品名 / 代码 / 风险级 / 单位净值 / 日期照旧带着，
 *   那些本来就是披露里的公开信息，藏了反而什么问题都答不上。
 * @param {Array<{name?:string,inst?:string,code?:string,risk?:any,nav?:number,navDate?:string,shares?:number,cost?:number,holdDays?:number,state?:string}>|null} items
 * @param {{hide?: boolean, today?: string}} [opts]
 * @returns {string}
 */
export function llmSnapshot(items, opts) {
  const o = opts || {};
  const hide = !!o.hide;
  const list = Array.isArray(items) ? items : [];
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) ? String(o.today) : "日期不明";
  const head = "【本机台账快照 · " + list.length + " 只 · 截至 " + td
    + (hide ? " · 金额按本机设置隐去" : "") + "】";
  if (!list.length) return head + "\n（本机台账里没有产品，这一份快照没带任何持仓）";
  const cap = Math.min(list.length, LLM_SNAPSHOT_MAX_ITEMS);
  const lines = [];
  let used = head.length + 1, cutByChars = 0;
  for (let i = 0; i < cap; i++) {
    const it = list[i] || {};
    const bits = [
      (i + 1) + ". " + (oneLine(it.name, 70) || "（无名产品）"),
      oneLine(it.inst, 40) || "机构未填",
      "代码 " + (oneLine(it.code, 40) || "未填"),
      "风险 " + (oneLine(it.risk, 24) || "未填"),
      "净值 " + (isFinite(Number(it.nav)) && Number(it.nav) > 0 ? num(it.nav, 4) : "无净值")
        + "（" + (/^\d{4}-\d{2}-\d{2}$/.test(String(it.navDate || "")) ? it.navDate : "日期不明") + "）",
      hide ? "份额 " + LLM_SNAPSHOT_MASKED : "份额 " + num(it.shares, 2),
      hide ? "成本 " + LLM_SNAPSHOT_MASKED : "成本 " + num(it.cost, 2),
      "持有 " + (isFinite(Number(it.holdDays)) && Number(it.holdDays) > 0 ? Math.round(Number(it.holdDays)) + " 天" : "不足 1 天或未起算"),
    ];
    if (it.state) bits.push("状态 " + oneLine(it.state, 24));
    const line = bits.join(" · ");
    if (lines.length && used + line.length + 1 > LLM_SNAPSHOT_MAX_CHARS) { cutByChars = cap - i; break; }
    lines.push(line);
    used += line.length + 1;
  }
  const out = lines.slice();
  const skipped = list.length - cap;
  if (skipped > 0) out.push("（另有 " + skipped + " 只未列出：超过条数上限 " + LLM_SNAPSHOT_MAX_ITEMS + " 只）");
  else if (cutByChars > 0) out.push("（另有 " + cutByChars + " 只未列出：超过字数上限 " + LLM_SNAPSHOT_MAX_CHARS + " 字）");
  return head + "\n" + out.join("\n");
}

/**
 * 还不许再发第 used+1 轮。used = 这个会话里已经发出去的请求数（含失败与超时的）。
 * ★ 失败的那一轮照样占额度：它多半已经到端点、已经计费了，把它抹掉等于把闸门松开。
 * @param {number} used
 * @returns {{ok: boolean, used: number, left: number, why: string}}
 */
export function llmBudget(used) {
  const n = Number(used) | 0;
  if (n >= LLM_MAX_ROUNDS) return {
    ok: false, used: n, left: 0,
    why: "这个会话已经发满 " + LLM_MAX_ROUNDS + " 轮，到数就停 —— 每一轮都是一次计费。"
      + "要接着问先「清空上文」，清空后从第一轮重新问。",
  };
  return { ok: true, used: n, left: LLM_MAX_ROUNDS - n, why: "" };
}

/**
 * 一条来源。两样齐才算有出处：可核实的链接 + 发布时间。
 * 只有标题、只有域名、或者时间写的是「今天」这种相对说法，一律不收 ——
 * 用户事后点不回去或者查不到当时那版，等于没出处。
 * @param {any} s
 * @returns {{ ok: boolean, url: string, title: string, publishedAt: string, host: string, why: string }}
 */
export function llmSource(s) {
  const o = s && typeof s === "object" ? s : {};
  const url = String(o.url || o.href || o.link || "").trim();
  const title = String(o.title || o.name || "").trim();
  const at = String(o.publishedAt || o.published_at || o.publishTime || o.publish_time
    || o.date || o.publishedDate || "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, url, title, publishedAt: at, host: "", why: "没有可点开的 http(s) 链接" };
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return { ok: false, url, title, publishedAt: at, host: "", why: "链接本身不合法" }; }
  if (!isRealDate(at)) return { ok: false, url, title, publishedAt: at, host, why: "缺发布时间（无法确定看到的是哪一版披露）" };
  return { ok: true, url, title, publishedAt: at, host, why: "" };
}

/** 必须是 YYYY-MM-DD（可带时间后缀）的绝对日期；「今天」「近日」「2026」都不算。 */
function isRealDate(s) {
  return /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(String(s || ""));
}

/**
 * 把一组候选来源分成「可入账」与「被丢弃」。
 * 丢弃的那一份保留原文与原因，页面上要能列出来 ——
 * 静默丢掉来源，用户就以为模型说的没有出处；全收，又等于放了假出处进来。
 * @param {any[]} list
 * @returns {{ graded: any[], dropped: { url: string, title: string, why: string }[] }}
 */
export function llmGradeSources(list) {
  const graded = [], dropped = [];
  const seen = Object.create(null);
  for (const raw of Array.isArray(list) ? list : []) {
    const s = llmSource(raw);
    const k = s.url || s.title;
    if (s.ok) {
      if (seen[k]) continue;                 /* 同一篇被引两次不重复列 */
      seen[k] = 1;
      graded.push(s);
    } else {
      dropped.push({ url: s.url, title: s.title, why: s.why });
    }
  }
  return { graded, dropped };
}

/**
 * 网关型业务错误：HTTP 状态是 200，失败写在 body 里（星火 /v1 的 10007 / 10013 / 11200 这一类）。
 * ★ 只在「这一份 body 里没有可读正文」时才认它 —— 有些端点正常响应也带个 code（200 / "000000"），
 *   先认 code 会把一次问答判成失败，那比漏判坏得多：用户会以为没扣到答案，其实拿到了。
 * code 与 message 原样交回（换行压成空格是显示层的规矩，不是改写内容）；
 * message 超过 200 字截断，与原生侧 brief() 同一类处理 —— 一整段 HTML 错误页不该进提示条。
 * @param {any} obj
 * @returns {string} 空串 = 这条不是业务错误
 */
function bizError(obj) {
  if (!Object.prototype.hasOwnProperty.call(obj, "code")) return "";
  const cs = String(obj.code == null ? "" : obj.code).trim();
  /* "0" 与 "000000" 这类是成功码；非数字的 code（"INVALID_KEY"）不是 0，照当错误。 */
  if (!cs || Number(cs) === 0) return "";
  const raw = String(obj.message || obj.msg || "").replace(/[\r\n\t]+/g, " ").trim();
  const msg = raw ? (raw.length > 200 ? raw.slice(0, 200) + "…" : raw) : "端点没给 message";
  return "端点回业务错误 code " + cs + "：" + msg;
}

/**
 * 解析端点返回。认三种形状，认不出就说 unknown 并把原文长度交回去。
 *   responses —— Responses 形制：output[] 里有 {type:"message",content:[{text}]} 与 web_search_call
 *   chat      —— Chat 形制：choices[0].message.content
 *   unknown   —— 其它（含错误体；星火这类网关的 code 非 0 会报成业务错误而不是「形状不认识」）
 * @param {any} obj 已经 JSON.parse 过的响应
 * @returns {{ shape: string, ok: boolean, text: string, sources: any[], dropped: any[], usage: { input: number, output: number }, error: string }}
 */
export function llmParse(obj) {
  const out = { shape: "unknown", ok: false, text: "", sources: /** @type {any[]} */ ([]), dropped: /** @type {any[]} */ ([]), usage: { input: 0, output: 0 }, error: "" };
  if (!obj || typeof obj !== "object") { out.error = "响应不是对象"; return out; }
  if (obj.error) {
    out.error = String(obj.error.message || obj.error.code || "端点返回 error 字段");
    return out;
  }
  const usage = obj.usage || {};
  out.usage.input = Number(usage.input_tokens || usage.prompt_tokens || 0) || 0;
  out.usage.output = Number(usage.output_tokens || usage.completion_tokens || 0) || 0;

  const pieces = /** @type {string[]} */ ([]);
  if (Array.isArray(obj.output)) {
    out.shape = "responses";
    for (const item of obj.output) {
      const it = item && typeof item === "object" ? item : {};
      if (it.type === "message" || typeof it.content === "string" || Array.isArray(it.content)) {
        if (typeof it.content === "string") pieces.push(it.content);
        else for (const c of it.content) {
          const cc = c && typeof c === "object" ? c : {};
          const t = cc.text || cc.content;
          if (typeof t === "string") pieces.push(t);
          else if (t && typeof t === "object" && typeof t.value === "string") pieces.push(t.value);
        }
      }
      /* web_search_call 里的来源：结构没实测过，所以两处都找一遍 ——
         item.sources[]（顶层）与 item.action.sources[]（Responses 文档里的那种）。
         找不到就是找不到，不编。 */
      const cand = [].concat(Array.isArray(it.sources) ? it.sources : [],
        it.action && Array.isArray(it.action.sources) ? it.action.sources : []);
      for (const c of cand) out.sources.push(c);
    }
  } else if (Array.isArray(obj.choices)) {
    out.shape = "chat";
    const m = (obj.choices[0] && obj.choices[0].message) || {};
    if (typeof m.content === "string") pieces.push(m.content);
    const tool = obj.choices[0] && obj.choices[0].tool_calls;
    if (Array.isArray(tool)) {
      for (const t of tool) {
        const fn = t && t.function && t.function.arguments;
        if (typeof fn === "string") { try { const g = JSON.parse(fn); if (Array.isArray(g.sources)) out.sources.push(...g); } catch (e) { /* 参数不是 JSON 就当没有 */ } }
      }
    }
  }
  if (typeof obj.output_text === "string" && !pieces.length) pieces.push(obj.output_text);

  const g = llmGradeSources(out.sources);
  out.dropped = g.dropped;
  out.text = pieces.join("\n").trim();
  out.ok = !!out.text;
  out.sources = g.graded;
  if (!out.ok && !out.error) {
    /* 没正文才去认业务错误码（理由见 bizError 上面那段）。
       报出来的是端点自己的 code 与原话，不是「大概是什么问题」。 */
    const biz = bizError(obj);
    out.error = biz ? biz : (out.shape === "unknown"
      ? "认不出的响应形状（既没有 output[] 也没有 choices[]）"
      : "响应里没有正文");
  }
  return out;
}

/**
 * 分块组装的状态机。Java 侧按 (seq, total, text) 逐块喂进来。
 * 乱序 / 重复 / 越界 / 超块数 —— 全部当场报错，不静默拼接：
 * 拼出错文比拿不到答案更坏，用户会拿一段被截断的话当结论。
 * @param {{ total: number, parts: (string|null)[], got: number }|null} st
 * @param {number} seq @param {number} total @param {string} text
 * @returns {{ st: { total: number, parts: (string|null)[], got: number }, done: boolean, error: string }}
 */
export function llmChunkFeed(st, seq, total, text) {
  const s = (st && st.parts) ? st : { total: 0, parts: /** @type {(string|null)[]} */ ([]), got: 0 };
  const t = Number(total) | 0, q = Number(seq) | 0;
  if (!(t >= 1) || t > LLM_CHUNK_MAX_PARTS) return { st: s, done: false, error: "块数不合法：" + total };
  if (q < 0 || q >= t) return { st: s, done: false, error: "块号越界：" + seq + "/" + total };
  if (s.total && s.total !== t) return { st: s, done: false, error: "同一轮请求的 total 变了（" + s.total + " → " + t + "）" };
  if (!s.total) { s.total = t; s.parts = new Array(t).fill(null); s.got = 0; }
  if (s.parts[q] !== null) return { st: s, done: false, error: "第 " + q + " 块重复送达" };
  s.parts[q] = String(text == null ? "" : text);
  s.got++;
  if (s.got < s.total) return { st: s, done: false, error: "" };
  return { st: s, done: true, error: "" };
}

/** 拼出整段：只在 done 之后调用。 */
export function llmChunkJoin(st) {
  return (st && st.parts ? st.parts : []).map(p => p == null ? "" : p).join("");
}

/**
 * 能不能重试。落定（拿到结果 / 明确失败 / 超时）之后才允许出现「重试」这颗按钮，
 * 而点击的一定为是用户 —— 代码路径里没有任何地方自己调 ask() 第二遍（铁律 #5）。
 * @param {{ phase?: string }|null} st
 */
export function llmCanRetry(st) {
  const ph = (st && st.phase) || "";
  return ph === "done" || ph === "error" || ph === "timeout";
}

/**
 * 无桥 / 无凭据时的诚实降级文案。宁可不给答案，也不装作算过了。
 * @param {{ inApp: boolean, hasKey: boolean }} env
 */
export function llmDegrade(env) {
  const e = env || { inApp: false, hasKey: false };
  if (!e.inApp) return "模型问答只在本机 App 内可用：网页版没有原生桥，而且密钥不能存在浏览器里。";
  if (!e.hasKey) return "还没有配置模型密钥：设置 → 模型接入 → 配置密钥（密钥只存在本机加密区，页面读不到）。";
  return "";
}
