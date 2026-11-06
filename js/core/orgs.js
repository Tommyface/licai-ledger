// @ts-check
/* ---------- 机构识别 ----------
   与云端 fetch_nav.py 的 ORG_ALIAS / detect_org() 严格对齐：
   云端也是按「机构名 / 产品名 / 各类代码」里是否含简称来选抓取器，
   所以前端的「能否自动抓净值」判定必须用同一套规则，否则会跟云端结论不一致。 */

/**
 * @typedef {{ inst?: string, manager?: string, name?: string, code?: string,
 *             prodCode?: string, regCode?: string, zcode?: string, instCode?: string,
 *             shareCode?: string }} ProductLike
 */

/** @type {ReadonlyArray<readonly [string, string]>} */
export const ORG_ALIAS = [
  ["北银", "bob"], ["北京银行", "bob"], ["bob", "bob"],
  ["华夏", "hx"], ["hx", "hx"],
  ["浦银", "spdb"], ["浦发", "spdb"], ["上海浦东发展", "spdb"], ["spdb", "spdb"],
  /* 信银理财：云端 ORG_ALIAS 里「信银理财 / 信银 / 中信 / citic」四项，
     前端必须一字不差地同序排列，否则前后端对同一产品会给出不同结论。
     注意「中信」是或关系的子串匹配，机构栏写「中信银行」也会判为信银。 */
  ["信银理财", "citic"], ["信银", "citic"], ["中信", "citic"], ["citic", "citic"],
  /* 南银 / 民生：与云端 ORG_ALIAS 末尾四/三项同序同构（2026-09-12 接入）。 */
  ["南银理财", "nanyin"], ["南银", "nanyin"], ["nanyin", "nanyin"],
  ["民生理财", "cmbc"], ["民生", "cmbc"], ["cmbc", "cmbc"],
  /* 宁银（宁波银行理财）：官网净值表可服务端直抓（2026-09-13 接入），
     与云端 ORG_ALIAS 末尾三项同序同构。注意「宁银」≠「南银」。 */
  ["宁银理财", "wmbnb"], ["宁银", "wmbnb"], ["wmbnb", "wmbnb"],
  /* 徽银（徽商银行理财）：官网 lccs.php 列表 + lccs_income_list.php 历史表直抓
     （2026-09-16 接入），与云端 ORG_ALIAS 末尾四项同序同构。 */
  ["徽银理财", "huiyin"], ["徽银", "huiyin"], ["hsbank", "huiyin"], ["huiyin", "huiyin"],
  /* 中银理财（bocwm.cn）：官网 webApi getNetWorthByCode 直抓全历史（2026-09-16 接入），
     与云端 ORG_ALIAS 末尾三项同序同构。
     注意「中银理财」≠「中国银行」—— 中行只是代销渠道，发行方是中银理财。 */
  ["中银理财", "bocwm"], ["中银", "bocwm"], ["bocwm", "bocwm"],
  /* 农银理财（abcwealth.com.cn）：官网 config.js 暴露 /awpsservice，净值接口可直抓全历史
     （2026-09-16 接入），与云端 ORG_ALIAS 末尾四项同序同构。 */
  ["农银理财", "nongyin"], ["农银", "nongyin"], ["abcwealth", "nongyin"], ["nongyin", "nongyin"],
  /* 杭银理财（hzbankwealth.com.cn）：eportal 静态 JSON 一次拿全量产品最新净值
     （2026-09-16 接入），与云端 ORG_ALIAS 末尾四项同序同构。 */
  ["杭银理财", "hangyin"], ["杭银", "hangyin"], ["hzbankwealth", "hangyin"], ["hangyin", "hangyin"],
  /* 兴银理财（cibwm.com.cn）：/api/public/pc/productVal/ 下拉全历史净值（2026-09-16 接入），
     与云端 ORG_ALIAS 末尾同序同构。 */
  ["兴银理财", "xingyin"], ["兴银", "xingyin"], ["cibwm", "xingyin"], ["xingyin", "xingyin"],
  /* 广银理财（cgbwmc.com.cn）：Rtp 框架 SPA，POST /wmpcext/noSessionServlet/{模块}/{动作}.fun
     整表翻页取最新净值（2026-09-16 接入）。产品代码形态极杂（1XFTLFB307A / LJR121 /
     HYGWCY0602A …）→ 不臆造正则，靠机构名判定。 */
  ["广银理财", "guangyin"], ["广银", "guangyin"], ["cgbwmc", "guangyin"], ["guangyin", "guangyin"],
  /* 交银理财（bocommwm.com）：「REQ_MESSAGE=JSON」表单 POST，
     queryJylcProductDetail.do 拿档案 + queryJylcBreakDetail.do 拿全历史（公开页、免登录）。
     现金管理类（c_interestway ≠ "0"）只披露万份收益，抓取端明确跳过，不喂净值曲线。
     ⚠️ 这三条是 2026-10-30 补的：云端早就有 bocom 抓取器和别名，前端这张表漏了，
     于是「机构栏写交银理财」在前端被判成 chinawealth、抓取就绪提示与实际不符。
     顺序与云端 ORG_ALIAS 严格一致：广银之后、工银之前。 */
  ["交银理财", "bocom"], ["交银", "bocom"], ["bocom", "bocom"],
  /* 工银理财（wm.icbc.com.cn）：自研 KitRequest 加密通道（主/工作密钥 + HMAC-MD5 签名 +
     AES-128-CBC 字段加密），走 clt/info/112901 列表 + 112902 明细取净值（2026-09-16 接入）。
     产品代码形态多样（26GS6464 主码 / 26G6464A 销售码）→ 不臆造正则。 */
  ["工银理财", "icbc"], ["工银", "icbc"], ["icbc", "icbc"],
  /* 建信理财（jxwm，2026-10-30 接入）：官网净值页要登录态，抓的是**建行「在售清单」
     渠道**（WCCMainPlatV5 TXCODE=NLCQ11，免凭证，清单自带当日净值）。别名写全，
     用户填「建行」「CCB」也能认。与云端 ORG_ALIAS 末尾同序同构。 */
  ["建信理财", "jxwm"], ["建信", "jxwm"], ["建行", "jxwm"], ["ccb", "jxwm"], ["jxwm", "jxwm"],
  /* 招银理财（cmbwm，2026-10-30 接入）：抓的是**招行信息披露站 cfweb**
     （cfweb.paas.cmbchina.com，请求头要 SM4 签名）。它认的是招行渠道代码
     （132031D / 8169），与微众货架那套 125323HR 不通用——机构栏写「招银理财」
     而代码是货架码时，官网这条会明确报「列表里没有」，净值仍由微众/中国理财网给。
     代码形态是纯数字且各家都可能是纯数字 → 不写 PRODCODE_RULES，靠机构名判定。 */
  ["招银理财", "cmbwm"], ["招银", "cmbwm"], ["cmbwm", "cmbwm"],
  /* 浙银理财（czbwm，2026-10-30 接入）：官网 apicms 免鉴权，列表码与微众货架码一致
     （ZYJYG0044A 同码同值），两条路都通。 */
  ["浙银理财", "czbwm"], ["浙银", "czbwm"], ["czbwm", "czbwm"],
  /* 青银理财（qdccb，2026-10-30 接入）：官网 eportal 只认**青银自营 11 位码**
     （CYCYGG30080），微众货架上的 CCRSFD* 一律 0 条 → 那些产品继续走货架。 */
  ["青银理财", "qdccb"], ["青银", "qdccb"], ["qdccb", "qdccb"],
  /* 光大理财（cebwm，2026-10-30 接入）：官网 cebwm.com 整站在知道创宇「加速乐」
     后面（连不存在的路径都回 412 + 一段混淆 JS），要过就得执行对方的 JS 绕过访问
     控制 → 不做。改抓**母公司光大银行**的「光大理财公司产品·最新净值」静态页：
     匿名、一个请求 99 只、数值与微众货架逐只对得上，但只有最新一条、没有历史
     （历史由 /eportal 的 getLsjz portlet 出，同样 412）。
     「光大」短名也收：在光大银行买的用户机构栏常写「光大银行」。
     ⚠️ 不写 PRODCODE_RULES：光大的 EW + 4 位数字 + 份额字母（EW2999A）与
     **中国银行代销码**撞形（app.js 链接解析的提示语里那句「中行 EW4455D」就是它），
     按形态判机构会把中行代销产品错认成光大理财。只按机构名判定。 */
  ["光大理财", "cebwm"], ["光大", "cebwm"], ["cebwm", "cebwm"]
];

/** @type {Readonly<Record<string, string>>} */
export const ORG_NAME = { bob: "北银理财", hx: "华夏理财", spdb: "浦银理财", citic: "信银理财",
                         nanyin: "南银理财", cmbc: "民生理财", wmbnb: "宁银理财",
                         huiyin: "徽银理财", bocwm: "中银理财", nongyin: "农银理财",
                         hangyin: "杭银理财", xingyin: "兴银理财", guangyin: "广银理财",
                         icbc: "工银理财", bocom: "交银理财",
                         jxwm: "建信理财", cmbwm: "招银理财",
                         czbwm: "浙银理财", qdccb: "青银理财",
                         /* 前端只显示发行方名，和 jxwm/cmbwm 一样不带渠道后缀
                            （云端 ORG_NAME 里那条带「光大银行披露页」，用于抓取日志）。 */
                         cebwm: "光大理财", chinawealth: "中国理财网" };

/**
 * 机构识别：先按别名表（与云端同序），再按「理财」→ 中国理财网，最后按 Z 开头的登记编码兜底。
 * @param {ProductLike | null | undefined} p
 * @returns {string} 机构代码（bob/hx/...），识别不出返回 ""
 */
export function detectOrg(p) {
  if (!p) return "";
  const hay = [p.inst, p.manager, p.name, p.prodCode, p.code]
    .map(v => String(v == null ? "" : v)).join(" ").toLowerCase();
  for (const [alias, code] of ORG_ALIAS) { if (hay.indexOf(alias) >= 0) return code; }
  /* 通用规则（与云端 detect_org 同构）：名称/机构含「理财」→ 中国理财网通用
     聚合源（覆盖招银/工银/中银/交银/宁银/苏银等全部 32 家发行方）。
     已接入机构在 ORG_ALIAS 里优先命中，走各自官网抓取器（历史更全）。 */
  if (hay.indexOf("理财") >= 0) return "chinawealth";
  /* 兜底（与云端同构）：机构未识别但登记编码 Z 开头（Z+12~14 位数字）。 */
  const reg = String(p.regCode || p.zcode || p.instCode || p.shareCode || p.code || "")
    .trim().toUpperCase();
  if (/^Z\d{12,14}$/.test(reg)) return "chinawealth";
  return "";
}

/* 仅凭「产品代码」形态推测机构——只用于输入时的实时提示。
   权威判定始终以 detectOrg()（机构名/产品名）为准。
   注：浦银官网接口实际按「登记编码」查询，未发现可靠的产品代码前缀规律，
       故此处不臆造规则，改为提示用户填登记编码。 */
/** @type {ReadonlyArray<readonly [RegExp, string, string]>} */
export const PRODCODE_RULES = [
  [/^YJ\d{6,}[A-Z]?$/i, "bob", "北银产品代码：YJ + 数字（可带份额后缀字母）"],
  [/^\d{12}$/, "hx", "华夏产品代码：12 位数字"],
  /* 信银份额代码 = 2 位前缀 + 6 位数字 + 1 位份额字母（共 9 位），如 AF251387C。
     前缀 AF / AM 为公募，BF / BB 为私募；私募净值披露受限，云端可能抓不到历史。
     7 位母产品代码（去掉末位份额字母）在信银官网查不到，故此处要求末位字母必填。 */
  [/^(?:AF|AM|BF|BB)\d{6}[0-9A-Z]$/i, "citic", "信银产品代码：AF/AM/BF/BB + 6 位数字 + 份额字母（如 AF251387C）"],
  /* 信银「母产品代码」：AF/AM/BF/BB + 6 位数字，缺了末位份额字母。
     信银官网只认 9 位份额代码，8 位母代码一律返回「未查询到该产品信息」，
     所以这里必须单独提醒补全，否则用户会以为云端抓取坏了。 */
  [/^(?:AF|AM|BF|BB)\d{6}$/i, "citic", "⚠️ 这像是信银的母产品代码（缺末位份额字母），必须补上份额字母才能查到净值"],
  /* 南银：10 位销售代码 NYYW + 6 位数字，如 NYYW000016。
     官网加密接口只认销售代码，登记编码（Z 开头）可由云端自动反查补齐。 */
  [/^NYYW\d{6}$/i, "nanyin", "南银销售代码：NYYW + 6 位数字（如 NYYW000016）"],
  /* 民生：10 位产品代码 F + 3 位字母 + 5 位数字 + 份额字母，如 FBAG65601C。
     实测全集前缀 FBAG/FBAE/FBAF/FSAE/FSAF/FSAG/FGAE/FGAG/FGAF；登记编码查询 0 命中。 */
  [/^F[A-Z]{3}\d{5}[A-Z]$/i, "cmbc", "民生产品代码：F + 3 位字母 + 5 位数字 + 份额字母（如 FBAG65601C）"],
  /* 宁银：Z + 2 位字母 + 7 位数字 + 份额字母，如 ZGN2360006C。官网净值表按此份额代码查询。 */
  [/^Z[A-Z]{2}\d{7}[A-Z]$/i, "wmbnb", "宁银产品代码：Z + 2 位字母 + 7 位数字 + 份额字母（如 ZGN2360006C）"],
  /* 漏写份额字母的徽银代码（PNHY260395）：先归到徽银，抓取端会按前缀唯一匹配
     补全；命中多个份额时抓取会明确报歧义，提示补字母。 */
  [/^PNHY\d{6}_?$/i, "huiyin", "⚠️ 徽银代码末尾通常带份额字母（如 PNHY260395A）；漏写时按前缀匹配，多份额会要求补全"],
  /* 徽银：PNHY + 6 位数字 +（可带下划线）+ 份额字母，如 PNHY260367F / PNHY240108_B。
     官网 lccs.php 列表按此代码定位产品；比对时云端会忽略下划线。 */
  [/^PNHY\d{6}_?[A-Z]$/i, "huiyin", "徽银产品代码：PNHY + 6 位数字 +（可带 _）+ 份额字母（如 PNHY260367F）"],
  /* 浙银：官网列表同时有母代码 ZYJYG00440 与份额码 ZYJYG0044A，净值按份额码查。
     只给母代码时云端会报「名下有 N 个份额，请填具体份额代码」——这里先提示，
     省得用户以为抓取坏了。形态取自官网列表实测（916 只）：母代码 = ZY + 3 位字母
     + 5 位数字，份额码 = 同样前缀 + 4 位数字 + 份额字母；另有 GPZ…/JXYA… 等少量
     不规则形态，索引能查到但不写正则（宁可从机构栏判定，也不臆造规则）。 */
  [/^ZY[A-Z]{3}\d{4}[A-Z]$/i, "czbwm", "浙银份额码：ZY + 3 位字母 + 4 位数字 + 份额字母（如 ZYJYG0044A）"],
  [/^ZY[A-Z]{3}\d{5}$/i, "czbwm", "⚠️ 这像是浙银的母代码（末尾是数字），请补成份额字母（如 ZYJYG0044A）"]
];

/**
 * @param {string} code
 * @returns {{ org: string, tip: string }}
 */
export function detectOrgByProdCode(code) {
  const s = String(code == null ? "" : code).trim();
  if (!s) return { org: "", tip: "" };
  for (const [re, org, tip] of PRODCODE_RULES) { if (re.test(s)) return { org, tip }; }
  if (/^Z\d{10,}$/i.test(s)) return { org: "", tip: "这看起来是「登记编码」——请填到上方登记编码栏；填好后云端会走中国理财网通用查询（覆盖全部发行方）" };
  return { org: "", tip: "" };
}

/**
 * 是不是标准登记编码形态（Z + 12~14 位数字）。
 *
 * 判据只有这一份：Python 侧同名函数在 navsources/base.py:is_reg_code()，
 * 两边必须一致 —— 台账 App 的「登记编码」栏写在 `code` 字段里，
 * 谁把那个 `Z7001…` 当成产品代码交出去，中国理财网的份额类别闸门就会
 * 对该产品**永久拒取**（不写错数，但静默少一路来源）。
 * @param {any} v
 * @returns {boolean}
 */
export function isRegCode(v) {
  return /^Z\d{12,14}$/.test(String(v == null ? "" : v).trim().toUpperCase());
}

/**
 * 云端抓取所需的产品代码（对齐 fetch_nav.py 的 get_prod_code：prodCode → code → shareCode）。
 *
 * 与云端唯一的差异是这里**跳过登记编码形态**：App 的「登记编码」栏就是 `code`，
 * 老数据里不少人把 Z 编码填在了「产品代码」旁边那一栏，直接当产品代码交出去，
 * 中国理财网会认为份额类别对不上而永久拒取 —— 症状是「这轮没拿到净值」，
 * 真正的病因是这个字段串位。宁可不给产品代码（还有一条按编码查的路），
 * 也不要给一个长得像登记编码的产品代码。
 * @param {ProductLike | null | undefined} p
 * @returns {string}
 */
export function prodCodeOf(p) {
  if (!p) return "";
  for (const k of ["prodCode", "code", "shareCode"]) {
    const v = String(p[k] == null ? "" : p[k]).trim();
    if (v && !isRegCode(v)) return v;      // 登记编码不是产品代码（见 isRegCode）
  }
  return "";
}

/**
 * 登记编码这一栏「该显示什么」（v86）。
 *
 * 账本里同一件事有两个字段：App 自己写的是 `code`（表单①、列表、详情都读它），
 * 云端抓净值时认的读侧别名是 `regCode`。只读 `code` 就会出现这种局面：
 * 云端早就知道某只产品的登记编码，屏幕上却写「登记编码 -」，
 * 用户据此以为缺东西、手工去补 —— 他要的「自动补齐」第一步其实是「先看见」。
 * 读的时候 `code` 优先（那是用户自己填的那一栏），空了才念 `regCode`。
 * @param {ProductLike | null | undefined} p
 * @returns {string}
 */
export function regCodeOf(p) {
  if (!p) return "";
  const c = String(p.code == null ? "" : p.code).trim();
  if (c) return c;
  return String(p.regCode == null ? "" : p.regCode).trim();
}

/** 这一栏此刻显示的值是不是来自云端别名（而不是用户在本机填的那一栏）。
    界面要用它补一句「（云端）」：同一个位置两种出处，不标出来就分不清。
    @param {ProductLike | null | undefined} p
    @returns {boolean} */
export function regCodeFromCloud(p) {
  if (!p) return false;
  return !String(p.code == null ? "" : p.code).trim()
    && !!String(p.regCode == null ? "" : p.regCode).trim();
}

/**
 * 云端抓取就绪状态（与云端逻辑对齐）：
 * 常规机构：必须填「产品代码」；中国理财网聚合源：凭登记编码（Z 开头）即可查询。
 * @param {ProductLike | null | undefined} p
 * @returns {{ ok: boolean, lv: "ok" | "warn", txt: string }}
 */
export function fetchStatus(p) {
  const code = String(p && p.prodCode || "").trim();
  const org = detectOrg(p);
  const reg = String((p && (p.regCode || p.code)) || "").trim().toUpperCase();
  const hasReg = isRegCode(reg);
  const nm = String((p && p.name) || "").trim();
  /* 按产品名称搜索只在名称足够完整时才有意义（"某产品"这类短名在信披平台搜不到），
     故要求 6 字以上 —— 与云端「按名搜索」的实际可用性对齐。 */
  const hasName = nm.length >= 6;
  /* 中国理财网信披平台：登记编码（精确）或完整产品名称（模糊）任一即可查，覆盖任意发行方 */
  const cwVia = hasReg ? "按登记编码" : (hasName ? "按产品名称" : "");
  /* 发行方官网抓取器：只认「产品代码」 */
  const official = org && org !== "chinawealth" && ORG_NAME[org];

  if (official && code) {
    /* 两条线都能跑 —— 云端会同时抓、自动择优（更新的胜，同日以官网为准） */
    return { ok: true, lv: "ok", txt: `✓ 双线自动抓取（${ORG_NAME[org]}官网 + 中国理财网）` };
  }
  if (official && !code) {
    return cwVia
      ? { ok: true, lv: "ok", txt: `✓ 中国理财网可抓（${cwVia}）—— 补填「产品代码」还能叠加 ${ORG_NAME[org]} 官网（历史更全）` }
      : { ok: false, lv: "warn", txt: `⚠️ 缺产品代码：${ORG_NAME[org]} 官网按产品代码查询；也可填登记编码（Z 开头）走中国理财网` };
  }
  if (cwVia) {
    return { ok: true, lv: "ok", txt: `✓ 中国理财网可自动抓最新净值（${cwVia}）` };
  }
  if (org === "chinawealth") {
    return { ok: false, lv: "warn", txt: "⚠️ 中国理财网查询需填登记编码（Z 开头）或完整产品名称" };
  }
  if (!org) return { ok: false, lv: "warn", txt: "⚠️ 机构未识别（机构栏填理财公司全名如「招银理财/工银理财」，或填 Z 开头登记编码走中国理财网）" };
  return { ok: false, lv: "warn", txt: "⚠️ 缺产品代码，云端无法抓净值" };
}