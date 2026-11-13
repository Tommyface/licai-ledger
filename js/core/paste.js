/* ---------- 粘贴内容 → 产品键 ----------
   从 app.js 拆出来的纯函数（2026-10-30）：拆出来才能被 node --test 直接测到。
   app.js 里那些依赖 DATA / DOM 的部分（去重、预览、落库）留在原处。 */

import { detectOrgByProdCode } from "./orgs.js";

/* ============================================================
   粘贴链接添加产品
   ------------------------------------------------------------
   为什么前端只做「抽键 + 判机构」、不抓页面：
     跨域会被 CORS 拦死（这正是当初把抓取挪到 GitHub Actions 的原因），
     而各行分享链接的 query 里基本都直接带着可用代码 ——
     中国理财网 prodRegCode、北银 PROD_CODE、宁银 projectcode …

   ★ 云端契约（勿改，改了这里会静默失效）：
     fetch_nav.py 的 detect_org() 只看 inst / name / prodCode / code …
     里的**关键词**，不看产品代码形态。所以用链接建产品时**尽量把识别到的
     机构名写进 inst**（如「北银理财」），否则要靠产品代码去货架目录反查。
     2026-10-30 起反查是有的（微众全量目录 454 只：代码在架上就认得出发行方、
     并直接取现值），但那只在**微众/网商卖的产品**上成立 —— 别家渠道买的、
     或代码不在架上的，机构栏空着云端就会以「无法识别机构」跳过。
     另外名称**故意留空**：merge_nav 只在字段为空时回填，留空云端才能把
     真实产品名（来自中国理财网 productDetail）写上。
   ============================================================ */
export const LINK_REG_KEYS = ["prodregcode", "regcode", "registercode", "zcode", "instcode",
  "financingregistercode", "cpdjbm", "cpdjjbm"];
export const LINK_PROD_KEYS = ["prodcode", "productcode", "projectcode", "productid",
  "sharecode", "salescode", "fundcode", "cpbm", "code"];

/* v135 中行手机银行 H5 链接（ebsnew.boc.cn/bocphone/...）：productId 是中行
   内部代码（如 WFZDJQRKA，纯字母形态很常见），监控/净值走中行 BMPS 游客网关
   （私有仓 bocmob.py）。它**不能**进 prodCode —— 中银理财官网（bocwm.cn）
   不认这串代码，混进去只会让官网源白查报错；独立存 bocPid 字段。 */
export const BOC_H5_RE = /ebsnew\.boc\.cn\/bocphone\//i;
export const BOC_PID_RE = /^[A-Z0-9]{6,20}$/;

/**
 * 解析用户粘贴的链接/代码/文本。
 * @param {string} raw
 * @returns {{code: string, prodCode: string, bocPid: string, org: string, ok: boolean, msg: string, bare: boolean}}
 *   bare = 整行只有一个产品代码（形态表没收录的那种，见 ②b）
 *   bocPid = 中行手机银行内部代码（v135，仅中行链接有；不进 prodCode）
 */
export function parseProductInput(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const norm = s => String(s).toUpperCase().replace(/[\s"']/g, "");
  if (!text) return { code: "", prodCode: "", bocPid: "", org: "", ok: false, msg: "请粘贴产品链接、产品代码或登记编码", bare: false };

  /* ① 收集参数：URL query、hash 路由里的 query，以及「名称=值」形式的参数串 */
  const params = {};
  const eatQuery = (s) => {
    const i = s.indexOf("?");
    if (i < 0) return;
    s.slice(i + 1).split("&").forEach(kv => {
      const j = kv.indexOf("=");
      if (j <= 0) return;
      const k = kv.slice(0, j).toLowerCase().trim();
      let v = kv.slice(j + 1).trim();
      try { v = decodeURIComponent(v); } catch (e) { /* 原样保留 */ }
      if (k && v) params[k] = v;
    });
  };
  eatQuery(text);
  const hi = text.indexOf("#");
  if (hi >= 0) eatQuery(text.slice(hi));
  text.replace(/([A-Za-z_]{3,24})\s*=\s*([^&\s]{4,40})/g, (m, k, v) => {
    const kk = k.toLowerCase();
    if (!params[kk]) params[kk] = v;
    return m;
  });
  const pickParam = (keys) => { for (const k of keys) if (params[k]) return norm(params[k]); return ""; };

  let code = pickParam(LINK_REG_KEYS);
  let prodCode = pickParam(LINK_PROD_KEYS);

  /* v135 中行手机银行链接：productId 提取为 bocPid，绝不混进 prodCode。
     带 productid 参数的链接不止中行一家，所以先验域再取值。 */
  let bocPid = "";
  if (BOC_H5_RE.test(text)) {
    bocPid = pickParam(["productid"]);
    if (!BOC_PID_RE.test(bocPid)) bocPid = "";
    prodCode = "";                 /* 中行内部代码不进产品代码栏（官网源不认它） */
  }

  /* 参数值形态不对就不认。★ 必须含数字：否则 `?code=weixin` 这类**占位参数**
     会被 norm 转成 WEIXIN（6 位纯字母）恰好通过长度关，被当成产品代码入库
     （2026-10-30 审计抓到的：注释声称排除了它，实现没有）。
     形态表认识的值一律放行，不受这条约束。 */
  if (code && !/^[ZC]\d{12,14}$/.test(code)) code = "";
  if (prodCode && !detectOrgByProdCode(prodCode).org
    && !/^[ZC]\d{12,14}$/.test(prodCode)
    && !(/^[A-Z0-9]{6,20}$/.test(prodCode) && /\d/.test(prodCode))) prodCode = "";

  /* ② 全文候选兜底：切成「连续字母数字串」逐个用现有形态识别器归类 ——
        不能直接全文正则扫，否则 Z7008926000006 里的 12 位数字会被误当成华夏的 12 位产品代码 */
  const tokens = (text.match(/[A-Za-z0-9]{6,24}/g) || []).map(norm);
  for (const tk of tokens) {
    if (!code && /^[ZC]\d{12,14}$/.test(tk)) { code = tk; continue; }
    if (!prodCode && detectOrgByProdCode(tk).org) prodCode = tk;
  }

  /* ②b 整行**就是**一个代码（或「产品代码：25112035B」这种带标签的写法）时
        直接收下，不再要求形态表认识它。
        漏掉这一步会让「扫微众海报」这条链死掉：二维码里是华夏的销售码
        25112035B（8 位数字 + 份额字母），形态表只写了「华夏 = 12 位数字」，
        于是本机明明认得这是产品码，粘贴框里却判成「无法识别」，
        表现就是「扫码识别成功、点确认提示没有可添加的产品」。
        ★ 必须**按空白切词**取末词：norm 会吃掉空格，直接对整行取尾串会把
        「25112035B 10000」粘成一个不存在的代码（2026-10-30 审出的误收面）。
        收的条件：末词是 6~20 位字母数字且含数字；前面的词合起来不超过 14 字符、
        不含数字、也没有 6 位以上的字母数字串；且不是「纯数字且恰好是
        日期/手机号/身份证位数」这种串 —— 8/11/15/18 位纯数字一律拒收，
        真实货架码都带份额字母（25112035B、125323HR、YJ01251204A、EW4455D），
        而被误贴进来的 20261028 / 13800138000 / 身份证恰好都是纯数字。
        带 ? & = 或 / 的一律不走这条路 —— 那是链接，不是代码。 */
  let bare = false;
  if (!code && !prodCode && !/[?=&]/.test(text) && !text.includes("/")) {
    const words = text.split(/\s+/).filter(Boolean);
    /* 取一个词**结尾**的字母数字串：「产品代码：25112035B」没有空格，
       整词不过形态关，但它尾下的那一串就是代码。句末标点（「25112035B。」）
       先剥掉再取尾串。 */
    const tailRun = w => {
      const s = norm(w).replace(/[^A-Z0-9]+$/g, "");
      const m = s.match(/[A-Z0-9]{6,20}$/);
      return m ? m[0] : "";
    };
    const tail = words.length ? tailRun(words[words.length - 1]) : "";
    const restWords = words.slice(0, -1);
    const rest = restWords.join("");
    if (/^[A-Z0-9]{6,20}$/.test(tail) && /\d/.test(tail)
      && !(/^\d+$/.test(tail) && [8, 11, 15, 18].indexOf(tail.length) >= 0)
      && rest.length <= 14
      && restWords.every(w => !/\d/.test(w) && !/[A-Za-z0-9]{6,}/.test(w))) {
      prodCode = tail; bare = true;
    }
  }

  /* ②c 微众分享短链：代码藏在 302 之后的 jumpParam 里，浏览器跨域拿不到
        （App 里由 Python 侧 webank_link 解，对应界面上的「📱 扫二维码添加」）。
        不单独认出来的话，用户只会看到一句「没认出来」，不知道差在哪一步。 */
  const shareLink = /gzhjdata\.webank\.com\/hj\/su\//i.test(text);

  /* ③ 判机构 */
  let org = prodCode ? detectOrgByProdCode(prodCode).org : "";
  if (!org && code) org = "chinawealth";
  const okay = !!(code || prodCode || bocPid);
  let msg = "";
  if (BOC_H5_RE.test(text) && !bocPid) {
    msg = "这是中行手机银行的产品页链接，但里面没有 productId 参数。"
      + "请在产品页点「分享」重新复制链接（链接里应带 productId=…），"
      + "或把登记编码（Z 开头）单独贴上。";
  } else if (bocPid) {
    msg = `已提取中行手机银行代码 ${bocPid}（存入「中行手机银行代码」栏，`
      + "净值/额度走中行通道）。机构栏建议填发行方全名（中银理财自营多为"
      + "「中银理财」，代销别家请以产品说明书为准）。";
  } else if (shareLink && !okay) {
    msg = "这是微众的分享短链：产品代码要跟着它的跳转才解得出来，浏览器里跨域做不到。"
      + "请在 App 里用下面的「📱 扫二维码添加」，或到产品页把「产品代码」复制成单独一行"
      + "（如 25112035B）。";
  } else if (!okay) {
    msg = "没从这段内容里认出产品代码或登记编码。银行 App 的分享链接里通常带 "
      + "prodRegCode= / PROD_CODE= 这类参数；纯文本请把代码单独占一行"
      + "（如 25112035B），或把「登记编码」（Z 开头）一并贴上。";
  } else if (prodCode && !code && !org) {
    /* 能认出代码、认不出发行方：银行代销链接与裸码都会走到这里。
       微众/网商货架上的产品云端会按代码反查出发行方并直接取现值，机构栏可以留空；
       不在架上的就必须补一项，否则云端以「无法识别机构」跳过。 */
    msg = `已识别产品代码 ${prodCode}，但发行机构未识别：`
      + "若这是微众/网商货架上买的产品，云端会按代码反查出发行方，机构栏可留空；"
      + "否则请在下方「发行机构」栏填理财公司全名（如「华夏理财」），"
      + "或补「登记编码」（Z 开头，产品说明书 / 中国理财网可查）。";
  }
  return { code, prodCode, bocPid, org, ok: okay, msg, bare };
}

/**
 * 这一行到底能不能落库 —— app.js 的预览（按钮上写几只）与保存**必须**用同一个
 * 判据，否则就是「按钮说确认添加 1 只、点下去 toast 没有可添加的产品」那个事故。
 * 拆成纯函数是为了让 node --test 能真的执行它（app.js 是脚本，顶层函数 import 不到，
 * 以前只能文本比对，测绿了也不代表两处同源）。
 * 放行条件：有识别出的机构 / 用户在机构栏填了 / 有登记编码（中国理财网按编码就能取）
 * / 整行就是一个裸代码（网页版没有扫码，裸码是主路径，云端会拿它去微众·网商
 * 货架 454 只目录反查发行方）。
 * @param {{ok?:boolean, code?:string, prodCode?:string, bocPid?:string, org?:string, bare?:boolean}} r parseProductInput 的结果
 * @param {string} manualInst 「发行机构」栏里的内容
 */
export function rowAddable(r, manualInst) {
  if (!r || !r.ok) return false;
  const org = String(manualInst || "").trim();
  return !!(r.org || org || r.code || r.bare || r.bocPid);
}
