/* 模型接入（T3）的纯逻辑测试：
     node --test tests/llm.test.mjs
   钉的是 js/domain/llm.js 头部那四条口径：
     1. JS 不经手密钥 —— 请求体里连字段名都不许出现；
     2. 不猜端点形状 —— 认得就收，认不得明说 unknown；
     3. 来源要 URL + 发布时间两样齐才入账，缺哪样写哪样；
     4. 失败不自动重试 —— 只有落定之后才允许出现重试这条路。
   ★ 真端点没测过（没有凭据），所以这里的用例是「形状契约」而不是「线上实况」：
     拿到真响应后必须回来补一条按实况形状的用例，别把这份 fixture 当成事实。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { llmReq, llmSource, llmGradeSources, llmParse, llmChunkFeed, llmChunkJoin,
  llmCanRetry, llmDegrade, LLM_BRIDGE, LLM_BRIDGE_METHODS, LLM_TIMEOUT_MS, LLM_CHUNK_MAX_PARTS } from "../js/domain/llm.js";

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

test("桥名与超时上限是常量，Java 侧与页面侧都读它们", () => {
  assert.equal(LLM_BRIDGE, "NativeLlm");
  assert.ok(LLM_TIMEOUT_MS >= 30000 && LLM_TIMEOUT_MS <= 300000, "超时不该短到把正常回答判成失败");
});

test("桥面清单：七个方法，一个不多一个不少（verify-web.sh 按它点名）", () => {
  assert.deepEqual(LLM_BRIDGE_METHODS,
    ["ready", "getConfig", "setConfig", "hasKey", "promptKey", "clearKey", "ask"]);
  /* 清单里不许出现「把密钥交回页面」的方法 */
  for (const m of LLM_BRIDGE_METHODS) assert.ok(!/getkey|readkey|exportkey|reveal/i.test(m), m);
});
