/**
 * tests/websearch.test.mjs · S2 讯飞联网检索判据契约测试
 * 样本按 2026-11-10 真实打靶响应结构构造（不是臆造的形状）：
 *  wsearch = tools:[{type:"web_search"}] → output 含 web_search_call/completed
 *  xfpriv  = 私有嵌套 → 200、顶层带 tools、output 里没有检索动作，却给出冲突数值
 *  preview = OpenAI 官方写法 → 400 invalid_prompt
 *  plain   = 无工具 → 模型自述无法联网
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  XF_DEFAULT_BASE, XF_MODEL, SEARCH_TOOL, XF_UNGROUNDED,
  xfEndpoint, xfBody, xfTextOf, xfGrounding, xfUrlsFromText, xfClue, xfBannerHtml,
} from "../js/core/websearch.js";

const Q = "2026年11月10日 中国10年期国债收益率";
const WSEARCH = {
  id: "resp_1", model: XF_MODEL, object: "response", status: "completed",
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed",
      action: { type: "search", query: Q, queries: [Q] } },
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text",
      text: "2026年11月10日，中国10年期国债收益率约为 1.60%。来源：财政部 https://www.mof.gov.cn/ 与中债 https://www.chinabond.com.cn/。" }] },
  ],
  output_text: "2026年11月10日，中国10年期国债收益率约为 1.60%。来源：财政部 https://www.mof.gov.cn/ 与中债 https://www.chinabond.com.cn/。",
  tools: [SEARCH_TOOL],
  usage: { input_tokens: 8604, output_tokens: 1822 },
};
const XFPRIV = {
  id: "resp_2", model: XF_MODEL, status: "completed",
  output: [
    { type: "reasoning" },
    { type: "message", content: [{ type: "output_text",
      text: "2026年11月10日中国10年期国债收益率约为 1.35%。数据来源：中国债券信息网。" }] },
  ],
  output_text: "2026年11月10日中国10年期国债收益率约为 1.35%。",
  tools: [{ type: "web_search", web_search: { enable: true, search_mode: "deep" } }],
  usage: { input_tokens: 543, output_tokens: 5867 },
};
const PLAIN = {
  output: [{ type: "reasoning" }, { type: "message", content: [{ text: "我无法提供实时数据。" }] }],
  output_text: "我无法提供实时数据。",
};
const PREVIEW_ERR = { error: { code: "invalid_prompt", message: "invalid request", type: "invalid_request_error" } };

/* ---------- 1. 端点与请求体 ---------- */
test("端点归一：填到 /v1 补 /responses；切形制时把残留段换掉", () => {
  assert.equal(xfEndpoint(XF_DEFAULT_BASE), XF_DEFAULT_BASE + "/responses");
  assert.equal(xfEndpoint(XF_DEFAULT_BASE + "/responses"), XF_DEFAULT_BASE + "/responses");
  assert.equal(xfEndpoint(XF_DEFAULT_BASE + "/chat/completions"), XF_DEFAULT_BASE + "/responses");
  assert.equal(xfEndpoint("http://example.com/v1"), "", "非 https 一律拒");
  assert.equal(xfEndpoint(""), XF_DEFAULT_BASE + "/responses");
});

test("请求体：工具名只许 web_search，绝不出现 web_search_preview 或私有嵌套", () => {
  const b = xfBody({ input: "今天国债收益率", instructions: "只陈述事实" });
  assert.equal(b.model, XF_MODEL);
  assert.equal(b.stream, false);
  assert.equal(b.tools.length, 1);
  assert.deepEqual(b.tools[0], { type: "web_search" });
  assert.ok(!JSON.stringify(b).includes("web_search_preview"));
  assert.ok(!JSON.stringify(b).includes("search_mode"));
  assert.equal(b.instructions, "只陈述事实");
});

test("search=false 不带 tools（避免误触发检索）", () => {
  const b = xfBody({ input: "你好", search: false });
  assert.equal(b.tools, undefined);
});

test("SEARCH_TOOL 被冻结，不允许就地改写", () => {
  assert.ok(Object.isFrozen(SEARCH_TOOL));
  assert.throws(() => { SEARCH_TOOL.type = "web_search_preview"; }, TypeError);
});

/* ---------- 2. 核心判据：只有 web_search_call/completed 才算真联网 ---------- */
test("wsearch：output 含 web_search_call 且 completed → grounded=true，检索词可回收", () => {
  const g = xfGrounding(WSEARCH);
  assert.equal(g.grounded, true);
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].status, "completed");
  assert.ok(g.queries.includes(Q));
  assert.ok(g.note.includes("结构化引用"), "必须诚实说明网关不给 citation");
});

test("★ 私有嵌套假成功：200 + 顶层 tools，但没有检索动作 → grounded=false", () => {
  const g = xfGrounding(XFPRIV);
  assert.equal(g.grounded, false, "这是最危险的一例：不能看 200 / tools 字段就当联网");
  assert.equal(g.calls.length, 0);
  assert.equal(g.note, XF_UNGROUNDED);
});

test("无工具 / 顶层假开关 / 400 错误体，一律 grounded=false", () => {
  for (const obj of [PLAIN, PREVIEW_ERR, null, {}, { output: [] },
                     { output: [{ type: "message", content: [] }] }]) {
    assert.equal(xfGrounding(obj).grounded, false);
  }
});

test("判据不依赖 tools 字段：有 tools 无检索仍 false，无 tools 有检索仍 true", () => {
  assert.equal(xfGrounding({ tools: [SEARCH_TOOL], output: [{ type: "message" }] }).grounded, false);
  const bare = { output: [{ type: "web_search_call", status: "completed", action: { query: "x" } }] };
  assert.equal(xfGrounding(bare).grounded, true);
});

test("严格口径：只要有一次检索没 completed，整轮按未联网处理", () => {
  const mixed = {
    output: [
      { type: "web_search_call", status: "completed", action: { query: "a" } },
      { type: "web_search_call", status: "failed", action: { query: "b" } },
    ],
  };
  assert.equal(xfGrounding(mixed).grounded, false);
  assert.equal(xfGrounding(mixed).calls.length, 2);
});

test("action.query 单值形态也能收集（网关两种写法都出现过）", () => {
  const g = xfGrounding({ output: [{ type: "web_search_call", status: "completed", action: { query: "单值检索词" } }] });
  assert.equal(g.grounded, true);
  assert.deepEqual(g.queries, ["单值检索词"]);
});

/* ---------- 3. 正文与引用 ---------- */
test("xfTextOf 从 output[] 抽 message 正文", () => {
  assert.ok(xfTextOf(WSEARCH).includes("1.60%"));
  assert.equal(xfTextOf(PLAIN), "我无法提供实时数据。");
});

test("xfUrlsFromText 抽 URL 去重、去尾标点、限量", () => {
  const urls = xfUrlsFromText(WSEARCH.output_text);
  assert.deepEqual(urls, ["https://www.mof.gov.cn/", "https://www.chinabond.com.cn/"]);
  assert.equal(xfUrlsFromText("重复 https://a.cn/ 和 https://a.cn/。")[0], "https://a.cn/");
  assert.ok(xfUrlsFromText(("https://x.cn/ ".repeat(40))).length <= 20);
});

/* ---------- 4. 线索红线：不进事实层、不冒充时间 ---------- */
test("xfClue：verified 恒 false、publishedAt 恒 null、timeUnknown 恒 true", () => {
  const c = xfClue(WSEARCH, { asOf: "2026-11-10 20:26" });
  assert.equal(c.verified, false);
  assert.equal(c.publishedAt, null);
  assert.equal(c.timeUnknown, true);
  assert.equal(c.noCitations, true);
  assert.equal(c.grounded, true);
  assert.equal(c.asOf, "2026-11-10 20:26");
  assert.equal(c.urls.length, 2);
});

test("★ 假成功那一轮包成线索后仍标未联网，且明说正文不可作事实", () => {
  const c = xfClue(XFPRIV);
  assert.equal(c.grounded, false);
  assert.ok(c.note.includes("不可作事实"));
  assert.equal(c.verified, false);
  assert.ok(c.text.includes("1.35%"), "原文保留，但只是待核文本，不进事实层/白名单");
});

test("xfBannerHtml：未联网用 ws-warn 并写「未联网」，联网用 ws-ok", () => {
  const bad = xfBannerHtml(xfGrounding(XFPRIV), { asOf: "2026-11-10 20:26" });
  assert.ok(bad.includes("ws-warn"));
  assert.ok(bad.includes("未联网"));
  assert.ok(bad.includes("数据时点 2026-11-10 20:26"));
  const good = xfBannerHtml(xfGrounding(WSEARCH));
  assert.ok(good.includes("ws-ok"));
  assert.ok(good.includes("检索词"));
  assert.ok(good.includes("结构化引用"));
});

test("HTML 转义：检索词里的尖括号不会注入", () => {
  const g = { grounded: true, queries: ["<img src=x onerror=alert(1)>"], note: "ok" };
  const h = xfBannerHtml(g);
  assert.ok(!h.includes("<img"));
  assert.ok(h.includes("&lt;img"));
});
