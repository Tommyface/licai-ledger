/* v130 五项 UI/功能需求的专项回归：
     node --test tests/ui_v130.test.mjs
   1) 交易页「我的产品 / 净值数据 / 交易记录」三卡可折叠（details 默认展开）；
   2) 设置页「新净值提醒」可折叠 + App 内改走原生系统通知（不再弹「此环境不支持通知」）；
   3) 首页监控入口移除（底部第 5 tab 是常驻入口；quota.test.mjs 也钉了反向）；
   4) 首页三行入口（月报/晴雨表/体检）不显示小字、slim 紧凑（market-page.test.mjs 钉了挂点）；
   5) 债市「更新此刻」的时点呈现：标题行「查于 capturedAt」+ 交易日 17:00 前的
      「当日批次还没发」提示（market-page.test.mjs 已把两个函数真跑）。
   这里钉的是接线与文案口径，防止后续重构悄悄退回。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const app = read("app.js");
const html = read("index.html");

const seg = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));

test("v130-1 交易页三卡折叠：details 默认展开、summary 带标题、按钮不触发折叠", () => {
  const trade = seg('id="pg-trade"', 'id="pg-prod"');
  const d = trade.match(/<details class="card" open>[\s\S]*?<\/details>/g) || [];
  assert.equal(d.length, 3, `交易页折叠卡应有 3 张（实际 ${d.length}）`);
  for (const name of ["我的产品", "净值数据", "交易记录"]) {
    const card = d.find(x => x.includes(`<h2>${name}</h2>`));
    assert.ok(card, `折叠卡缺「${name}」`);
    assert.ok(card.includes("<summary"), `「${name}」没包 summary`);
  }
  /* 挂点照旧：折叠不影响 renderProd/renderNav/renderTrade 的写入目标 */
  for (const id of ["prodList", "navList", "tradeList", "realList"]) {
    assert.ok(trade.includes(`id="${id}"`), `挂点 #${id} 丢了`);
  }
  /* summary 内按钮必须 stopPropagation（防某些内核把点击冒泡成折叠切换） */
  assert.match(trade, /onclick="event\.stopPropagation\(\);openLinkAdd\(\)"/);
  assert.match(trade, /onclick="event\.stopPropagation\(\);openProd\(\)"/);
  assert.match(trade, /onclick="event\.stopPropagation\(\);openTrade\(\)"/);
  /* 第四张「已实现收益」保持常显（结算一眼可对账） */
  assert.ok(trade.includes("已实现收益（赎回结算）") &&
    !trade.slice(trade.indexOf("已实现收益（赎回结算）")).includes("<details"),
    "已实现收益卡不该被折叠");
  /* summary 的浏览器默认 marker 在 CSS 里关掉 */
  assert.match(html, /details\.card > summary\{list-style:none/, "缺 summary marker 关闭样式");
});

test("v130-2 设置页提醒折叠 + App 内原生通知接线", () => {
  const settings = seg("新净值提醒", "备份与恢复");
  assert.match(settings, /<details class="card set-collapse" open>/, "新净值提醒没收进可折叠区块");
  assert.match(settings, /<summary><h2>新净值提醒<\/h2><\/summary>/);
  assert.match(settings, /id="notifyBox"/);
  assert.match(settings, /id="btnNotify" onclick="toggleNotify\(\)"/);
  /* App 内：toggleNotify 走 mode:"notify-test"；App 分支先于浏览器话术出现且
     处理完直接 return —— 运行时 App 永远不会走到「此环境不支持通知」那句。 */
  const tn = app.slice(app.indexOf("async function toggleNotify()"),
    app.indexOf("async function toggleNotify()") + 2400);
  assert.match(tn, /if \(nativeFetchAvailable\(\)\) \{/, "App 内分支缺失");
  assert.match(tn, /mode: "notify-test"/, "App 内没走原生确认通知");
  const appBranchAt = tn.indexOf('if (nativeFetchAvailable()) {');
  const browserWordAt = tn.indexOf("此环境不支持通知");
  assert.ok(appBranchAt > -1 && (browserWordAt < 0 || appBranchAt < browserWordAt),
    "App 分支要排在浏览器话术之前（保证 App 内不可达那句）");
  assert.match(tn.slice(appBranchAt, appBranchAt + 700), /return;/, "App 分支处理完没 return");
  /* 浏览器分支的 iPhone 话术保留（那是给 PWA/浏览器用户的正确提示） */
  assert.ok(app.includes("此环境不支持通知"), "浏览器分支话术被误删");
  /* canNotify / pushNotify 的原生路径 */
  assert.match(app, /NOTIFY\.on && \(notifyPermission\(\) === "granted" \|\| nativeFetchAvailable\(\)\)/,
    "canNotify 没认 App 内原生通知");
  assert.match(app, /mode: "notify-push", title: String\(title \|\| ""\), body: String\(body \|\| ""\)/,
    "pushNotify 没透传标题/正文到原生层");
  assert.match(app, /function nativeNotifyCall\(/, "缺原生通知的桥调用 helper");
  /* App 内文案如实讲边界：页面退后台比对暂停 */
  assert.match(app, /定时比对随之暂停/, "App 内没如实说明后台冻结边界");
});

test("v130-5 债市时点呈现：查于 capturedAt + 当日批次未发布提示", () => {
  assert.match(app, /function marketCheckedAtText\(/, "缺「查于」时刻 helper");
  assert.match(app, /function marketPendingText\(/, "缺「当日批次还没发」提示函数");
  assert.match(app, /今日（\$\{today\.slice\(5\)\}）批次预计约 17:00 发布/,
    "提示文案没写清发布时点");
  assert.match(app, /checkedAtText: marketCheckedAtText\(MARKET\)/,
    "债市页没把「查于」传进面板");
  assert.match(app, /pend \? `<span class="mkt-stale">\$\{esc\(pend\)\}<\/span>`/,
    "状态条没接「当日批次还没发」提示");
  /* 纯函数层：标题行 hint 支持 checkedAtText，未传时行为不变（模型接入页不受影响） */
  const mk = read("js/core/market.js");
  assert.match(mk, /opts && opts\.checkedAtText/, "market.js 面板没接 checkedAtText");
  assert.match(mk, /· 查于 \$\{esc/, "标题行没有「查于」字样");
});
