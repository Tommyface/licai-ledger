/* App 自更新的判断口径（v47）：
     node --test tests/update.test.mjs
   重点是那条安全口径：取不到 / 读不懂时绝不许说「已是最新」。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVer, cmpVer, readRelease, updateVerdict, APK_ASSET } from "../js/domain/update.js";

const rel = (over) => Object.assign({
  tag_name: "apk-latest", name: "理财台账 APK · latest", draft: false, prerelease: false,
  published_at: "2026-10-31T04:22:58Z",
  body: "自动构建 · 本仓 `33f9a29d`\napkVersion=1.0.205\n网页资源 `glorywork/licai-ledger@ad1b434`",
  assets: [{ name: APK_ASSET, state: "uploaded", size: 42927899, url: "https://api.github.com/repos/o/r/releases/assets/1" }]
}, over || {});

test("cmpVer：数字段比较，不是字符串比较", () => {
  assert.equal(cmpVer("1.0.204", "1.0.205"), -1);
  assert.equal(cmpVer("1.0.9", "1.0.10"), -1);      /* 字符串比会反过来，这是最常见的坑 */
  assert.equal(cmpVer("1.0.205", "1.0.205"), 0);
  assert.equal(cmpVer("1.0.206", "1.0.205"), 1);
  assert.equal(cmpVer("1.0", "1.0.0"), 0);          /* 缺的段按 0 补 */
  assert.ok(Number.isNaN(cmpVer("abc", "1.0.1")));
  assert.ok(Number.isNaN(cmpVer("", "1.0.1")));
});

test("parseVer 只收两到三段纯数字", () => {
  assert.deepEqual(parseVer("1.0.205"), [1, 0, 205]);
  assert.deepEqual(parseVer(" 1.0 "), [1, 0]);
  assert.equal(parseVer("1.0.205-rc1"), null);
  assert.equal(parseVer("v1.0.205"), null);
  assert.equal(parseVer(null), null);
});

test("readRelease：正常包（机器口径那行）", () => {
  const r = readRelease(rel());
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.0.205");
  assert.equal(r.size, 42927899);
  assert.match(r.download, /^https:\/\/api\.github\.com\//, "必须走 API 地址，不是 browser_download_url");
  assert.equal(r.published, "2026-10-31 04:22");
});

test("readRelease：没有机器行时退回中文那行", () => {
  const r = readRelease(rel({ body: "版本 `1.0.204`（versionCode 同号）" }));
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.0.204");
});

test("readRelease：草稿 / 预发布 / 无版本 / 无包，一律 ok=false 并给原因", () => {
  assert.equal(readRelease(rel({ draft: true })).ok, false);
  assert.match(readRelease(rel({ draft: true })).error, /草稿/);
  assert.match(readRelease(rel({ prerelease: true })).error, /预发布/);
  assert.match(readRelease(rel({ body: "没写版本" })).error, /版本号/);
  assert.match(readRelease(rel({ assets: [] })).error, new RegExp(APK_ASSET));
  assert.match(readRelease(rel({ assets: [{ name: "别的.zip", url: "x", state: "uploaded" }] })).error, /licai-ledger/);
  assert.equal(readRelease(null).ok, false);
});

test("readRelease：跳过 state 不是 uploaded 的同名残留资产", () => {
  const r = readRelease(rel({
    assets: [
      { name: APK_ASSET, state: "open", size: 0, url: "" },
      { name: APK_ASSET, state: "uploaded", size: 123, url: "https://api.github.com/x" }
    ]
  }));
  assert.equal(r.ok, true);
  assert.equal(r.size, 123);
});

test("updateVerdict：三种状态各说各话", () => {
  const v = updateVerdict("1.0.204", readRelease(rel()));
  assert.equal(v.state, "new");
  assert.match(v.text, /有新包 1\.0\.205/);
  assert.match(v.text, /40\.9 MB/);

  assert.equal(updateVerdict("1.0.205", readRelease(rel())).state, "latest");
  assert.match(updateVerdict("1.0.205", readRelease(rel())).text, /已经是最新（1\.0\.205）/);

  /* 本机比云端还新（内测装过更新的包）：算 latest，不许催促降级 */
  assert.equal(updateVerdict("1.0.206", readRelease(rel())).state, "latest");
});

test("安全口径：取不到信息时不许说「已是最新」", () => {
  const bad = updateVerdict("1.0.204", readRelease({ message: "Not Found" }));
  assert.equal(bad.state, "unknown");
  assert.doesNotMatch(bad.text, /已是最新/);
  assert.match(bad.text, /没取到更新信息/);

  const weird = updateVerdict("", readRelease(rel()));
  assert.equal(weird.state, "unknown");
  assert.doesNotMatch(weird.text, /已是最新/);

  const nil = updateVerdict("1.0.204", null);
  assert.equal(nil.state, "unknown");
  assert.doesNotMatch(nil.text, /已是最新/);
});

/* ---------- v53：判断不了 ≠ 把人堵死 ---------- */
test("本机版本读不出来：仍然交出包地址该有的字段，并标 canInstall", () => {
  const info = readRelease(rel());
  for (const cur of ["", "err:NameNotFoundException", "abc", "1.0.205-rc1"]) {
    const v = updateVerdict(cur, info);
    assert.equal(v.state, "unknown", `curVersion=${JSON.stringify(cur)} 应该判不了`);
    assert.doesNotMatch(v.text, /已是最新|已经是最新/);
    assert.equal(v.canInstall, true, "云端包是拿到的，必须给下载按钮：App 里点不动 + 私有仓网页要登录 = 用户没有任何一条升级路");
    assert.equal(v.version, "1.0.205", "按钮上要知道自己将要装哪一版");
    assert.equal(v.size, info.size, "进度条按这个算总长，丢了它就只会显示「已下 x MB」");
  }
});

test("文案要把「壳里读版本失败」这件事说出来，而不是只报一个空", () => {
  const v = updateVerdict("", readRelease(rel()));
  assert.match(v.text, /读不出本机版本/);
  assert.match(v.text, /空/, "本机给的是空串，就得让他看见是空，不是猜一个");
  assert.match(v.text, /1\.0\.205/, "同时要说清云端是哪一版");
  assert.match(v.text, /覆盖安装|不会丢/, "得说清直接装的风险边界，否则等于让人赌");

  const e = updateVerdict("err:SecurityException", readRelease(rel()));
  assert.match(e.text, /SecurityException/, "壳抛的异常要原样带出来 —— v52 那次查不下去，就是因为异常被吞成空串");
});

test("canInstall 只在「有包可装」时为真", () => {
  assert.equal(updateVerdict("1.0.204", readRelease(rel())).canInstall, true);
  assert.equal(updateVerdict("1.0.205", readRelease(rel())).canInstall, false, "已经最新，别再给一个下载按钮");
  assert.equal(updateVerdict("1.0.204", null).canInstall, false, "连包都没取到，装什么");
  assert.equal(updateVerdict("1.0.204", readRelease(rel({ assets: [] }))).canInstall, false);
});
