// @ts-check
/* App 自更新的判断口径（v47）。

   为什么需要它：APK 现在只发在私有仓的 Release 上，手机上想更新就必然要带凭据 ——
   而凭据本来就在 App 里（「数据同步」那枚 fine-grained Token），没道理让浏览器再
   登录一次 GitHub。于是更新流程挪进 App：JS 判断该不该升、Java 负责拉流与拉安装器。

   判断部分（读 release JSON、比版本、给结论）放这里，纯函数、可测：
   「明明有新包却说不新」和「新包没到位就说已是最新」都会让用户白等一次更新，
   而后者更糟 —— 他会以为自己是最新版，继续用一个旧壳去抓净值。
   所以 unknown / error 一律不许输出「已是最新」，测试专门锁这条。 */

/** 私有仓 Release 里固定的资产名；构建时同名覆盖，所以 URL 也稳定 */
export const APK_ASSET = "licai-ledger.apk";

/**
 * readRelease 的返回口径：ok=false 时 error 必填、其余字段为空值。
 * @typedef {{ok:boolean, version:string, size:number, download:string,
 *            name:string, published:string, error?:string}} ReleaseInfo
 */

/**
 * "1.0.205" → [1,0,205]；非法输入返回 null（不许当 0 用）
 * @param {string} v
 * @returns {number[]|null}
 */
export function parseVer(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d+(\.\d+){1,2}$/.test(s)) return null;
  return s.split(".").map(x => Number(x));
}

/**
 * @param {string} a @param {string} b
 * @returns {number} a<b → -1，相等 → 0，a>b → 1，任一方非法 → NaN
 */
export function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return NaN;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * 从 GitHub Releases API 的响应里取出「这个包能不能装」。
 *
 * 版本从哪来：release 的 body 里有一行机器口径 `apkVersion=1.0.NNN`
 * （私有仓 .github/workflows/android.yml 每次构建写入）。
 * 为什么不用 `browser_download_url`：那是 github.com 的网页地址，私有仓需要登录
 * 后的 Cookie；带 Token 走 API 的 `url` + `Accept: application/octet-stream`
 * 才会 302 到免凭据的签名直链。Java 侧用的就是 `url`。
 *
 * @param {any} j Release API 的 JSON 解析结果
 * @returns {ReleaseInfo}
 */
export function readRelease(j) {
  /** @type {(e: string) => ReleaseInfo} */
  const bad = (e) => ({ ok: false, version: "", size: 0, download: "", name: "", published: "", error: e });
  if (!j || typeof j !== "object") return bad("没拿到 release 数据");
  if (j.draft) return bad("这个 release 是草稿");
  if (j.prerelease) return bad("这个 release 标记为预发布");
  const body = String(j.body || "");
  let m = body.match(/apkVersion=([0-9][0-9.]*)/);
  let version = m ? m[1] : "";
  if (!version) {
    /* 兜底：旧版 body 只有中文那行「版本 `1.0.205`」，手改或历史包也可能这样 */
    m = body.match(/版本\s*`([0-9][0-9.]*)`/);
    version = m ? m[1] : "";
  }
  if (!parseVer(version)) return bad("release 里读不出版本号");
  const assets = Array.isArray(j.assets) ? j.assets : [];
  /* 同名资产可能留着一份未发布完成的（state 不是 uploaded），必须跳过 */
  let hit = null;
  for (const a of assets) {
    if (!a || a.name !== APK_ASSET) continue;
    if (a.state && a.state !== "uploaded") continue;
    if (!a.url) continue;
    hit = a;
    break;
  }
  if (!hit) return bad("release 里没有 " + APK_ASSET);
  return {
    ok: true,
    version: version,
    size: Number(hit.size) || 0,
    download: String(hit.url || ""),
    name: String(j.name || version),
    published: String(j.published_at || "").replace("T", " ").slice(0, 16)
  };
}

/**
 * 该不该提示更新。curVersion 取 App 自己的 versionName（Java 侧给）。
 *
 * canInstall = 「这条结论后面应该出现下载按钮」。它单独存在是因为 v52 之前
 * 只有 state==="new" 才给按钮：本机版本一旦读不出来（壳里 PackageManager 抽风、
 * 改装过的包、versionName 被写过），用户就同时失去两条路 —— App 里点不动，
 * 私有仓的 release 页面在浏览器里又要登录。判断不了新旧是一回事，把人堵死是另一回事：
 * 包地址明明拿到了，覆盖装一个同签名的包不会丢数据，最坏只是白下一次。
 *
 * @param {string} curVersion 本机 APK 的 versionName，如 "1.0.204"；读不出传空串
 * @param {ReturnType<typeof readRelease>|null} info
 * @returns {{state:"new"|"latest"|"unknown", text:string, version:string, size:number, canInstall:boolean}}
 */
export function updateVerdict(curVersion, info) {
  if (!info || !info.ok) {
    return {
      state: "unknown", version: "", size: 0, canInstall: false,
      text: "没取到更新信息：" + ((info && info.error) || "未知原因") + "。"
    };
  }
  const mb = info.size ? " · " + (Math.round(info.size / 1048576 * 10) / 10) + " MB" : "";
  const c = cmpVer(curVersion, info.version);
  if (Number.isNaN(c)) {
    /* 宁可说「判断不了」，也绝不让他以为已经是最新 —— 但按钮照给 */
    return {
      state: "unknown", version: info.version, size: info.size, canInstall: true,
      text: "读不出本机版本（壳里给的是「" + (curVersion || "空") + "」），比不了新旧。"
        + "云端最新 " + info.version + mb + "。不确定也可以直接装："
        + "同签名覆盖安装，台账数据不会丢。"
    };
  }
  if (c < 0) {
    return {
      state: "new", version: info.version, size: info.size, canInstall: true,
      text: "有新包 " + info.version + "（本机 " + curVersion + "）" + mb
        + (info.published ? " · " + info.published : "") + "。"
    };
  }
  return {
    state: "latest", version: info.version, size: info.size, canInstall: false,
    text: "已经是最新（" + curVersion + "）。"
  };
}
