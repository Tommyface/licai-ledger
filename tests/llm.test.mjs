/* 模型接入（T3）的纯逻辑测试：
     node --test tests/llm.test.mjs
   钉的是 js/domain/llm.js 头部那七条口径：
     1. JS 不经手密钥 —— 请求体里连字段名都不许出现；
     2. 不猜端点形状 —— 认得就收，认不得明说 unknown；
     3. 来源要 URL + 发布时间两样齐才入账，缺哪样写哪样；
     4. 失败不自动重试 —— 只有落定之后才允许出现重试这条路；
     5. 会话只活在本机内存里 —— 上文压成文本带上，轮次到 LLM_MAX_ROUNDS 就停；
     6. 台账快照勾了才给 —— 出机器只有白名单十个字段，凭据形状的键一个字都不许跟着走，
        「隐藏金额」开着时份额与成本一起藏；
     7. 协议形制由原生侧拼 —— 页面只交 input/instructions，网关那种「HTTP 200 + code 非 0」
        的失败要报成业务错误，code 与官方原话原样交回。
   ★ 真端点没测过（没有凭据），所以这里的用例是「形状契约」而不是「线上实况」：
     拿到真响应后必须回来补一条按实况形状的用例，别把这份 fixture 当成事实。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { llmReq, llmSource, llmGradeSources, llmParse, llmChunkFeed, llmChunkJoin,
  llmCanRetry, llmDegrade, LLM_BRIDGE, LLM_BRIDGE_METHODS, LLM_TIMEOUT_MS, LLM_CHUNK_MAX_PARTS,
  llmTranscript, llmRoundInput, llmBudget, LLM_MAX_ROUNDS, LLM_TRANSCRIPT_MAX_CHARS,
  llmSnapshot, LLM_SNAPSHOT_MAX_ITEMS, LLM_SNAPSHOT_MAX_CHARS, LLM_SNAPSHOT_MASKED,
  llmMetaOf, llmMetaErr, LLM_CANCEL_TEXT } from "../js/domain/llm.js";

/* ---- 口径 1：JS 不经手密钥 ---- */
test("请求体只有问题与指令，没有任何凭据字段", () => {
  const r = llmReq({ input: "这只产品最近能赎吗", instructions: "按台账数据回答" });
  assert.deepEqual(Object.keys(r).sort(), ["input", "instructions", "v"]);
  const s = JSON.stringify(r).toLowerCase();
  for (const w of ["key", "token", "authorization", "bearer", "secret", "baseurl", "model"])
    assert.ok(!s.includes(w), "请求体里出现了 " + w + "：" + s);
});

test("请求体：缺输入也不炸，null 当空串", () => {
  assert.deepEqual(llmReq({}), { v: 1, input: "", instructions: "" });
  assert.deepEqual(llmReq(null).input, "");
  assert.equal(llmReq({ input: null }).input, "");
});

/* ---- 口径 3：来源分级 ---- */
test("来源：URL 与发布时间两样齐才算有出处", () => {
  const s = llmSource({ url: "https://www.chinawealth.com.cn/x.html", title: "某期说明书", published_at: "2026-09-30T00:00:00Z" });
  assert.equal(s.ok, true);
  assert.equal(s.host, "www.chinawealth.com.cn");
  assert.equal(s.why, "");
});

test("来源：缺时间 / 缺链接 / 相对时间 / 非法链接，四种都不收并写明原因", () => {
  assert.match(llmSource({ url: "https://a.cn/x" }).why, /发布时间/);
  assert.match(llmSource({ title: "只有标题" }).why, /链接/);
  assert.match(llmSource({ url: "https://a.cn/x", publishedAt: "今天" }).why, /发布时间/);
  assert.match(llmSource({ url: "javascript:alert(1)", publishedAt: "2026-01-01" }).why, /链接/);
});

test("来源分级：同一条被引两次只列一次，丢弃的保留原因", () => {
  const g = llmGradeSources([
    { url: "https://a.cn/1", publishedAt: "2026-09-01" },
    { url: "https://a.cn/1", publishedAt: "2026-09-01" },
    { url: "https://a.cn/2", title: "没时间的这篇" },
  ]);
  assert.equal(g.graded.length, 1);
  assert.equal(g.dropped.length, 1);
  assert.equal(g.dropped[0].title, "没时间的这篇");
  assert.deepEqual(llmGradeSources(null), { graded: [], dropped: [] });
});

/* ---- 口径 2：不猜形状 ---- */
/* Responses 形制：正文在 output[].message.content[]，来源在 web_search_call.action.sources[] */
const RESP = {
  output: [
    { type: "web_search_call", action: { sources: [
      { url: "https://www.chinawealth.com.cn/d/1", title: "披露 A", published_at: "2026-10-28" },
      { url: "https://weixin.qq.com/s/xxxx", title: "公众号文章 B" }] } },
    { type: "message", content: [{ text: "该理财产品于 2026-10-28 披露…" }] },
  ],
  output_text: "该理财产品于 2026-10-28 披露…",
  usage: { input_tokens: 120, output_tokens: 45 },
};

test("解析：Responses 形制收正文，来源按两样齐分级，缺时间的进丢弃", () => {
  const r = llmParse(RESP);
  assert.equal(r.shape, "responses");
  assert.equal(r.ok, true);
  assert.match(r.text, /2026-10-28 披露/);
  assert.equal(r.sources.length, 1, "只有带发布时间的那篇能入账");
  assert.equal(r.sources[0].url, "https://www.chinawealth.com.cn/d/1");
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0].why, /发布时间/);
  assert.deepEqual(r.usage, { input: 120, output: 45 });
});

test("解析：来源挂在顶层 sources[] 也认（结构没实测过，两处都找）", () => {
  const r = llmParse({ output: [{ type: "web_search_call", sources: [{ url: "https://a.cn/x", publishedAt: "2026-10-01" }] },
    { type: "message", content: "正文" }] });
  assert.equal(r.sources.length, 1);
  assert.equal(r.text, "正文");
});

test("解析：Chat 形制与 output_text 兜底", () => {
  const c = llmParse({ choices: [{ message: { content: "回答" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  assert.equal(c.shape, "chat");
  assert.equal(c.text, "回答");
  assert.deepEqual(c.usage, { input: 3, output: 4 });
  assert.equal(c.sources.length, 0, "没有来源就是没有，不编");
  assert.equal(llmParse({ output_text: "只有这个" }).text, "只有这个");
});

test("解析：错误体与认不出的形状都如实报，不返回半截正文", () => {
  const e = llmParse({ error: { message: "insufficient_quota" } });
  assert.equal(e.ok, false);
  assert.match(e.error, /insufficient_quota/);
  const u = llmParse({ result: "???" });
  assert.equal(u.shape, "unknown");
  assert.match(u.error, /认不出的响应形状/);
  assert.equal(llmParse(null).error, "响应不是对象");
  assert.equal(llmParse({ output: [{ type: "message", content: [] }] }).error, "响应里没有正文");
});

test("不变式：解析结果里的来源永远带 URL 与发布时间（铁律 #3 的机器保证）", () => {
  for (const obj of [RESP, { output: [] }, { choices: [] }, { error: {} }, null, [], { output_text: "x" }]) {
    const r = llmParse(obj);
    assert.ok(Array.isArray(r.sources) && Array.isArray(r.dropped));
    for (const s of r.sources) {
      assert.match(s.url, /^https?:\/\//);
      assert.match(s.publishedAt, /^\d{4}-\d{2}-\d{2}/);
    }
  }
});

/* ---- 分块组装：拼出错文比拿不到答案更坏 ---- */
function feedAll(chunks) {
  let st = null;
  const errs = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = llmChunkFeed(st, i, chunks.length, chunks[i]);
    st = r.st; if (r.error) errs.push(r.error);
    if (r.done) return { text: llmChunkJoin(st), errs };
  }
  return { text: null, errs };
}

test("分块：按序送达拼回原文", () => {
  const { text, errs } = feedAll(["第一段", "第二段", "第三段"]);
  assert.deepEqual(errs, []);
  assert.equal(text, "第一段第二段第三段");
});

test("分块：乱序送达照样拼对（序号说话，不看到达顺序）", () => {
  let st = null;
  for (const [q, t] of [[2, "C"], [0, "A"], [1, "B"]]) {
    const r = llmChunkFeed(st, q, 3, t);
    st = r.st;
    assert.equal(r.error, "");
    if (r.done) assert.equal(llmChunkJoin(st), "ABC");
  }
  assert.equal(llmChunkJoin(st), "ABC");
});

test("分块：重复块 / 越界 / total 变了 / 块数超上限，四种都当场报错", () => {
  const one = llmChunkFeed(null, 0, 2, "A").st;
  assert.match(llmChunkFeed(one, 0, 2, "A").error, /重复送达/);
  assert.match(llmChunkFeed(one, 5, 2, "X").error, /越界/);
  assert.match(llmChunkFeed(one, 1, 3, "B").error, /total 变了/);
  assert.match(llmChunkFeed(null, 0, LLM_CHUNK_MAX_PARTS + 1, "A").error, /块数不合法/);
  assert.match(llmChunkFeed(null, 0, 0, "A").error, /块数不合法/);
});

test("分块：没拼满就不算完成", () => {
  const r = llmChunkFeed(null, 0, 3, "A");
  assert.equal(r.done, false);
  assert.equal(r.error, "");
  assert.equal(llmChunkJoin(r.st) + "", "A");   /* 未完成时不拿它当结论 */
});

/* ---- 口径 4：不自动重试 ---- */
test("重试：只有落定（成功 / 失败 / 超时）才允许，进行中不许", () => {
  assert.equal(llmCanRetry({ phase: "running" }), false);
  assert.equal(llmCanRetry({ phase: "" }), false);
  assert.equal(llmCanRetry(null), false);
  for (const ph of ["done", "error", "timeout"]) assert.equal(llmCanRetry({ phase: ph }), true, ph);
});

/* ---- 诚实降级 ---- */
test("降级：网页版 / 没配密钥 / 都齐，三种说法各不相同", () => {
  assert.match(llmDegrade({ inApp: false, hasKey: false }), /只在本机 App 内可用/);
  assert.match(llmDegrade({ inApp: true, hasKey: false }), /还没有配置模型密钥/);
  assert.equal(llmDegrade({ inApp: true, hasKey: true }), "");
  assert.match(llmDegrade(null), /只在本机 App 内可用/);
});

/* ---- v68：在壳里但桥没挂上，是第三种情况，不是「网页版」 ---- */
test("降级多一档：壳的 origin 在、桥不在 —— 说「桥没挂上、退出重进」，不许再说「这是网页版」", () => {
  const web = llmDegrade({ inApp: false, hasKey: false });
  const shell = llmDegrade({ inApp: false, hasKey: false, shell: true });
  assert.match(shell, /桥在这一页没挂上/);
  assert.match(shell, /这不是网页版/);
  assert.doesNotMatch(shell, /只在本机 App 内可用/,
    "用户已经在 App 里了，还指着「只在 App 内可用」那句就是假话");
  /* 这一档必须把「这次什么都没发生」说清楚：没发出去、不计费（铁律 #5 + #10） */
  assert.match(shell, /没有发出去|没有调用原生能力/);
  assert.match(shell, /不计费|不双计费|退出|再进来一次/);
  /* shell 只是附加的一档，缺省时行为必须与 v67 逐字一致 */
  assert.equal(llmDegrade({ inApp: false, hasKey: false, shell: undefined }), web);
  assert.equal(llmDegrade({ inApp: false, hasKey: false, shell: false }), web);
  assert.equal(llmDegrade(null), web);
  /* inApp 为真时 shell 不参与：那一屏讲的是「桥在，缺密钥」 */
  assert.match(llmDegrade({ inApp: true, hasKey: false, shell: true }), /还没有配置模型密钥/);
  /* 两句都不许承诺自动重来 —— 重发由用户点，费用才不重复 */
  for (const s of [web, shell]) assert.doesNotMatch(s, /自动(重发|重试|再来)/);
});

test("桥名与超时上限是常量，Java 侧与页面侧都读它们", () => {
  assert.equal(LLM_BRIDGE, "NativeLlm");
  assert.ok(LLM_TIMEOUT_MS >= 30000 && LLM_TIMEOUT_MS <= 300000, "超时不该短到把正常回答判成失败");
});

test("桥面清单：八个方法，一个不多一个不少（v76 起含 cancel，verify-web.sh 按它点名）", () => {
  assert.deepEqual(LLM_BRIDGE_METHODS,
    ["ready", "getConfig", "setConfig", "hasKey", "promptKey", "clearKey", "ask", "cancel"]);
  /* 清单里不许出现「把密钥交回页面」的方法 */
  for (const m of LLM_BRIDGE_METHODS) assert.ok(!/getkey|readkey|exportkey|reveal/i.test(m), m);
});


/* ---- v76 · 取消这一轮的口径（纯模块侧）----
   「取消」这两个字最容易说错的地方不在代码，在话：它是「不再等」，不是「撤回」。
   请求早就发出去了，计不计费只有端点知道 —— 所以这句话里既不能出现「未计费」这种
   确定的钱话（铁律 #10 不许编），也不能让人以为取消后代码会自己再试一次（铁律 #5）。 */
test("取消那句说的是「不再等」，不是「撤回」，也不许出现确定的钱话", () => {
  assert.match(LLM_CANCEL_TEXT, /可能已经计费/);
  assert.match(LLM_CANCEL_TEXT, /不会自己重发/);
  assert.match(LLM_CANCEL_TEXT, /由你取消/);
  assert.doesNotMatch(LLM_CANCEL_TEXT, /未计费|一定没|不收费|退款|免费|已撤回/);
  /* 这段文案要经 esc() 进屏：夹 HTML 就会被念成字面标记 */
  assert.doesNotMatch(LLM_CANCEL_TEXT, /<[a-z/]/i);
});

test("取消是一档落定：重试的门为它开着，但 running 时不给点", () => {
  assert.equal(llmCanRetry({ phase: "cancelled" }), true);
  assert.equal(llmCanRetry({ phase: "running" }), false);
  assert.equal(llmCanRetry({ phase: "done" }), true);
  assert.equal(llmCanRetry(null), false);
});

test("取消不是第二个方法表项：清单里只有一个 cancel", () => {
  assert.equal(LLM_BRIDGE_METHODS.filter(m => m === "cancel").length, 1);
  /* 顺手钉住：新方法也不许变成「把密钥交回页面」的那一类 */
  assert.ok(!/getkey|readkey|exportkey|reveal/i.test("cancel"));
});

/* ---- 口径 5（v65 多轮问答）：上文压成文本、失败也占额度、上限是防误点的闸 ----
   这几条钉的是「多轮」这件事的形状，不是端点的实况：
   上文的形状由我们定（原生那条路只认字符串），什么时候被端点顶回来要等真凭据实测。 */
test("上文：没问过就是空串，第一轮的 input 与 v64 同一个形状", () => {
  assert.equal(llmTranscript([]), "");
  assert.equal(llmTranscript(null), "");
  assert.equal(llmRoundInput([], "最短持有期到什么时候？"), "最短持有期到什么时候？");
  assert.equal(llmRoundInput(null, "  带空格的  "), "带空格的");
});

test("上文：一轮变成「问 / 答」两行，没拿到答案时明说，不许冒充", () => {
  assert.equal(llmTranscript([{ q: "A", a: "B" }]), "问：A\n答：B");
  assert.match(llmTranscript([{ q: "A", a: "" }]), /这一轮没有拿到答案/);
  assert.match(llmTranscript([{ q: "A", err: "HTTP 429" }]), /这一轮没有拿到答案/,
    "失败的那轮在原文里也不能被当成答案");
});

test("上文：按先后串起来，空问题那一轮跳过", () => {
  const t = llmTranscript([{ q: "第一问", a: "一答" }, { q: "  " }, { q: "第二问", a: "二答" }]);
  assert.ok(t.indexOf("第一问") < t.indexOf("第二问"), "先后顺序变了");
  assert.equal(t.split("问：").length - 1, 2);
});

test("上文：超过长度上限从最旧的丢起，并写明丢了几轮（不许静默缩水）", () => {
  assert.ok(LLM_TRANSCRIPT_MAX_CHARS >= 2000, "上限小于一篇像样的回答，等于每轮都失忆");
  const big = "字".repeat(2000);
  const turns = [];
  for (let i = 0; i < 5; i++) turns.push({ q: "第" + i + "问", a: big });
  const t = llmTranscript(turns);
  assert.ok(t.length <= LLM_TRANSCRIPT_MAX_CHARS + 60, "收不住长度：" + t.length);
  assert.match(t, /更早 \d+ 轮没有带上/);
  assert.ok(t.includes("第4问"), "最新那轮一定得留着");
  assert.ok(!t.includes("第0问"), "该丢的最旧那轮还留着");
});

test("上文：最新一轮自己就超长也别丢掉 —— 新问题不能变成一句没头没尾的话", () => {
  const t = llmTranscript([{ q: "老问", a: "老答" }, { q: "新问", a: "字".repeat(LLM_TRANSCRIPT_MAX_CHARS + 10) }]);
  assert.ok(t.includes("新问"), t.slice(0, 60));
});

test("发给模型的 input：有上文时是「以前几轮 + 这一次要问的」两段", () => {
  const s = llmRoundInput([{ q: "上一问", a: "上一答" }], "那它手续费呢");
  assert.match(s, /以前几轮的问答/);
  assert.match(s, /问：上一问\n答：上一答/);
  assert.match(s, /这一次要问的】\n那它手续费呢$/);
});

test("上文是纯文本：形状由我们定，不出现结构化消息的字段", () => {
  const t = llmTranscript([{ q: "A", a: "B" }]);
  assert.equal(typeof t, "string");
  assert.ok(!/"role"|"content"/.test(t), "原生那条路只认字符串，这里冒出结构化字段就是骗测试");
});

test("轮次闸门：上限之内放行，到数就停并说清怎么接着问", () => {
  assert.ok(LLM_MAX_ROUNDS >= 2 && LLM_MAX_ROUNDS <= 20, "上限既不能形同虚设，也不该小到手滑就撞");
  for (let n = 0; n < LLM_MAX_ROUNDS; n++) {
    const g = llmBudget(n);
    assert.equal(g.ok, true, String(n));
    assert.equal(g.left, LLM_MAX_ROUNDS - n);
  }
  const full = llmBudget(LLM_MAX_ROUNDS);
  assert.equal(full.ok, false);
  assert.equal(full.left, 0);
  assert.match(full.why, /清空上文/);
  assert.match(full.why, /计费/);
  assert.equal(llmBudget(LLM_MAX_ROUNDS + 3).ok, false);
  assert.equal(llmBudget(undefined).ok, true, "拿不到数就当第一轮，别把用户锁死");
});

test("闸门只看轮数不看成败：失败与超时的那轮照样占额度（铁律 #5 的连体闸）", () => {
  const rows = [{ q: "A", a: "" }, { q: "B", err: "HTTP 500" }];
  assert.equal(llmTranscript(rows).split("问：").length - 1, 2, "失败的那轮也要进上文");
  assert.equal(llmBudget(rows.length).ok, rows.length < LLM_MAX_ROUNDS);
});

/* ---- 口径 6：台账快照（v66）---- */
const SNAP_ITEM = { name: "稳健增利 90 天", inst: "某理财子", code: "Z1002023000123",
  risk: "R3", nav: 1.0873, navDate: "2026-10-31", shares: 12000.5, cost: 13000.25,
  holdDays: 45, state: "持仓中" };

test("快照：白名单只出那十个字段，混进来的凭据与仓库信息一个字都不跟着走", () => {
  const dirty = Object.assign({}, SNAP_ITEM, {
    token: "sk-LEAKCHECK-abcdef", apiKey: "KEY-LEAKCHECK", Authorization: "Bearer LEAKCHECK",
    repo: "glorywork/licai-data", path: "/data/licai/sync/licai-data.json",
    password: "hunter2", baseUrl: "https://LEAKCHECK.test/v1",
  });
  const s = llmSnapshot([dirty], { today: "2026-11-03" });
  for (const w of ["LEAKCHECK", "sk-", "Bearer", "token", "licai-data", "hunter2", "/data/", "baseUrl"])
    assert.ok(!s.toLowerCase().includes(w.toLowerCase()), "快照漏出了 " + w + "：" + s);
  assert.match(s, /稳健增利/);
  assert.match(s, /Z1002023000123/);
});

test("快照：头部写明几只、截至哪天；日期不合法就写「日期不明」而不是猜今天", () => {
  const s = llmSnapshot([SNAP_ITEM, SNAP_ITEM], { today: "2026-11-03" });
  assert.match(s, /^【本机台账快照 · 2 只 · 截至 2026-11-03】/);
  assert.match(llmSnapshot([SNAP_ITEM], { today: "不是日期" }), /截至 日期不明】/);
  assert.match(llmSnapshot([SNAP_ITEM], {}), /截至 日期不明】/);
});

test("快照：空台账也出一段说明，不是空串 —— 模型不能把「没带」读成「没持仓」以外的意思", () => {
  const s = llmSnapshot([], { today: "2026-11-03" });
  assert.match(s, /0 只/);
  assert.match(s, /这一份快照没带任何持仓/);
  assert.match(llmSnapshot(null, {}), /没有产品/);
});

test("快照：缺的字段照实写缺，不补一个数进去（猜出来的数会被当成本机真数引用）", () => {
  const s = llmSnapshot([{ name: "只写了名字" }], { today: "2026-11-03" });
  assert.match(s, /机构未填/);
  assert.match(s, /代码 未填/);
  assert.match(s, /风险 未填/);
  assert.match(s, /净值 无净值（日期不明）/);
  assert.match(s, /持有 不足 1 天或未起算/);
});

test("快照：本机开着「隐藏金额」时份额与成本一起藏，公开的那几样照旧带着", () => {
  const s = llmSnapshot([SNAP_ITEM], { hide: true, today: "2026-11-03" });
  assert.ok(!s.includes("12000.50") && !s.includes("13000.25"), "金额没藏住：" + s);
  assert.ok(s.includes(LLM_SNAPSHOT_MASKED), "没写明是「已隐藏」，模型会当成缺数：" + s);
  assert.match(s, /份额 /);
  assert.match(s, /成本 /);
  assert.match(s, /金额按本机设置隐去/);
  assert.match(s, /1\.0873/, "单位净值是公开披露信息，跟着藏就没法答了");
  assert.match(s, /Z1002023000123/);
  assert.match(s, /R3/);
  const open = llmSnapshot([SNAP_ITEM], { today: "2026-11-03" });
  assert.ok(open.includes("12000.50") && open.includes("13000.25"), "没开隐藏时金额该带着");
});

test("快照：超过条数上限时写明还有几只没列，不是静默截", () => {
  const many = Array.from({ length: LLM_SNAPSHOT_MAX_ITEMS + 5 }, (_, i) =>
    Object.assign({}, SNAP_ITEM, { name: "产品" + i }));
  const s = llmSnapshot(many, { today: "2026-11-03" });
  assert.match(s, /^【本机台账快照 · 35 只/);
  assert.match(s, /另有 5 只未列出：超过条数上限 30 只/);
  assert.equal(s.split("\n").length, LLM_SNAPSHOT_MAX_ITEMS + 2, "列出的条数要和上限对得上");
});

test("快照：条数没超但字数超了，同样写明还有几只没带上（两种截法说的是不同的原因）", () => {
  const long = Array.from({ length: LLM_SNAPSHOT_MAX_ITEMS }, () => Object.assign({}, SNAP_ITEM, {
    name: "长".repeat(80), inst: "机构".repeat(30), code: "C".repeat(50),
  }));
  const s = llmSnapshot(long, { today: "2026-11-03" });
  assert.match(s, /超过字数上限 4000 字/);
  assert.ok(!/超过条数上限/.test(s), "条数没超就别报条数");
  assert.ok(s.length < LLM_SNAPSHOT_MAX_CHARS + 200, "截完还超字数就是没截：" + s.length);
  const listed = s.split("\n").filter(l => /^\d+\./.test(l)).length;
  const cut = Number((s.match(/另有 (\d+) 只未列出/) || [])[1]);
  assert.equal(listed + cut, LLM_SNAPSHOT_MAX_ITEMS, "列出的 + 没列出的要等于本轮的只数");
});

test("快照：字段自己超长就截一行加省略号，换行被压平 —— 不撑破结构也不留多行", () => {
  const s = llmSnapshot([{ name: "甲".repeat(100) + "\n换行", inst: "乙".repeat(60) }],
    { today: "2026-11-03" });
  const line = s.split("\n")[1];
  assert.ok(!line.includes("换行"), "字段里的换行会多出一行，把「一条一只」的结构打散");
  assert.match(line, /甲…/);
  assert.ok(!line.includes("乙".repeat(60)));
});

test("三段式 input：上文在前、快照在中、这一次要问的在最后；两参调用还是老形状", () => {
  const snap = llmSnapshot([SNAP_ITEM], { today: "2026-11-03" });
  const three = llmRoundInput([{ q: "上一句", a: "上一答" }], "这一句", snap);
  const i1 = three.indexOf("【以前几轮的问答");
  const i2 = three.indexOf("【本机台账快照");
  const i3 = three.indexOf("【这一次要问的】");
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, `顺序应是 上文→快照→新问：${i1}/${i2}/${i3}`);
  assert.equal(llmRoundInput([{ q: "上一句", a: "上一答" }], "这一句").indexOf("台账快照"), -1,
    "没勾就别把快照塞进去 —— 「勾了才给」是这一条的全部意义");
  assert.equal(llmRoundInput([], "这一句", ""), "这一句");
});

/* ---- 口径 7：协议形制与网关业务错误（v67 · R1）----
   星火这类 OpenAI 兼容网关的失败是「HTTP 200 + body 里 code 非 0」：状态码说是成功，
   真失败写在 body 里。原生侧把 body 原样分块交回（它不解析内容），所以这一层分类
   落在页面侧，也就能在这里钉住。
   ★ 用例里的 code 取自星火公开的网关返回码表（10007 / 10013 / 10907 / 11200 等），
     那是「按文档写的形状」，不是实测回来的样本 —— 拿到真凭据后要回来补实况用例。 */

test("业务错误：HTTP 200 里 code 非 0 要报成业务错误，不许停在「形状不认识」", () => {
  const r = llmParse({ code: 11200, message: "余额不足或已透支", sid: "aBc123" });
  assert.equal(r.ok, false);
  assert.equal(r.shape, "unknown", "形状仍按认不出报 —— 只是错误说得更准，不是猜出了形状");
  assert.match(r.error, /11200/);
  assert.match(r.error, /余额不足或已透支/, "官方原话一字不动地交回，翻译一次就多一处说错的地方");
  assert.equal(r.text, "");
  assert.equal(r.sources.length, 0, "错误体里不许混出来源");
});

test("业务错误：code 是字符串也照原样带，不重新格式化", () => {
  assert.equal(llmParse({ code: "10007", message: "APPID不存在" }).error,
    "端点回业务错误 code 10007：APPID不存在");
});

test("业务错误：端点没给 message 就写「没给」，不替它编一个原因", () => {
  assert.equal(llmParse({ code: 10013 }).error, "端点回业务错误 code 10013：端点没给 message");
});

test("成功码不算业务错误：0 与「000000」这类跟「没有 code 键」一样只按形状判", () => {
  for (const c of [0, "0", "000000"]) {
    const r = llmParse({ code: c, message: "success" });
    assert.match(r.error, /认不出的响应形状/, "code=" + c + " 是成功码，报成业务错误就是把成功说成失败");
    assert.ok(!/业务错误/.test(r.error));
  }
});

test("有正文时先认正文：带个非 0 code 的 choices 响应不许被判成失败", () => {
  /* 有些兼容网关正常响应也回 code:200。先认 code 就会把一次成功的问答说成没成功，
     用户以为没拿到答案（其实拿到了、也已经计费了）—— 这个误判比漏判贵。 */
  const r = llmParse({ code: 200, choices: [{ message: { content: "答复在此" } }] });
  assert.equal(r.ok, true);
  assert.equal(r.shape, "chat");
  assert.equal(r.text, "答复在此");
});

test("错误优先级：body 里有 error 字段就用它，code 只是后面那层兜底", () => {
  const r = llmParse({ error: { message: "Invalid API Key" }, code: 11200, message: "另一种说法" });
  assert.equal(r.error, "Invalid API Key");
});

test("业务错误的 message：换行压平、超长截断 —— 一整段错误页不许进提示条", () => {
  const r = llmParse({ code: 10907, message: "<html>\n" + "X".repeat(400) });
  assert.ok(!r.error.includes("\n"), "带换行的错误体把提示条撑成多行：" + r.error);
  assert.ok(r.error.length < 260, "message 没截断，长度 " + r.error.length);
  assert.match(r.error, /…$/);
});

test("协议形制不由页面拼：发给桥的请求体里不许出现 apiStyle / messages / tools", () => {
  const s = JSON.stringify(llmReq({ input: "q", instructions: "i" })).toLowerCase();
  for (const w of ["apistyle", "messages", "tools", "choices", "chat/completions", "responses"])
    assert.ok(!s.includes(w), "页面请求体里出现了 " + w + "：同一个形状两处各写一遍迟早对不上");
});

/* ---- v69：壳回来的元信息是「对象」而不是「JSON 字符串」时，必须自己说清楚 ----
   1.0.220 每轮问答都显示「原生侧没回元信息」，而真情况是 LlmBridge 把元信息拼成了
   JS 对象字面量：String(obj) 得 "[object Object]"，JSON.parse 必抛。
   这一组是**实喂**（把两种形状真的喂进去），不是拿正则数文案 —— 参数类型这种东西
   只有真跑一次才看得见。 */

test("对象形状的元信息：读不成，但原因要说「类型不一致」而不是「没回」", () => {
  const rd = llmMetaOf({ ok: true, status: 200, bytes: 44, error: "" });
  assert.equal(rd.meta, null);
  assert.match(rd.why, /对象/);
  assert.match(rd.why, /参数类型不一致/);
  assert.ok(!/没回/.test(rd.why), "把「类型不一致」说成「没回」就是这次误导排查方向的那句话：" + rd.why);
  const msg = llmMetaErr(rd.meta, rd.why, 44);
  assert.match(msg, /参数类型不一致/);
  assert.match(msg, /响应正文已收到 44 字/, "端点已经跑完的那一轮，得让用户看见正文到了：" + msg);
});

test("字符串形状的元信息：正常读到，why 为空", () => {
  const rd = llmMetaOf('{"ok":true,"status":200,"bytes":44,"error":""}');
  assert.equal(rd.why, "");
  assert.equal(rd.meta.ok, true);
  assert.equal(rd.meta.bytes, 44);
});

test("坏 JSON、空回、ok 不为真、标量：四档各是各的一句话", () => {
  assert.match(llmMetaOf('{"ok":tru').why, /不是合法 JSON/);
  const empt = llmMetaOf("");                      // 桥真的回了一句空参数
  assert.deepEqual(empt.meta, {});
  assert.match(llmMetaErr(empt.meta, empt.why, 0), /空元信息/);
  assert.match(llmMetaErr(empt.meta, empt.why, 0), /没有收到任何响应正文/);
  const noOk = llmMetaOf('{"status":500,"bytes":0}');
  assert.match(llmMetaErr(noOk.meta, noOk.why, 0), /ok 不为真/);
  const scal = llmMetaOf("5");                     // JSON.parse 认得的标量
  assert.match(scal.why, /不是对象/);
  assert.match(scal.why, /开头是「5」/);
});

test("壳给了错误原因就用它原样说，不套正文那一串（也不许冒出没回那句）", () => {
  const rd = llmMetaOf('{"ok":false,"status":500,"error":"端点回 HTTP 500"}');
  const msg = llmMetaErr(rd.meta, rd.why, 0);
  assert.equal(msg, "端点回 HTTP 500");
});

test("这一组读法里任何一条都不许产出「原生侧没回元信息」", () => {
  const cases = [{ ok: true }, "", "[]", "{}", "null", "{坏", 5, undefined, null];
  for (const c of cases) {
    const rd = llmMetaOf(c);
    const msg = (rd.meta && rd.meta.error) ? String(rd.meta.error) : llmMetaErr(rd.meta, rd.why, 0);
    assert.ok(!/原生侧没回元信息/.test(msg), JSON.stringify(c) + " 读出来还是那句兜底话：" + msg);
  }
});
