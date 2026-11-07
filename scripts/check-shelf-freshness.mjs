#!/usr/bin/env node
/* ============================================================
   v98 · 静态索引健康「软哨兵」：新鲜度 + 体积护栏

   只提示、不阻断：退出码恒 0（除非脚本自身读不到索引而崩，那是真错误）。
   为什么不设硬阈值把 CI 变红：
     · 慢变字段快照过期是「该重跑了」，不是「代码坏了」；90 天后把每个 PR
       都染红，只会逼人绕过门禁或手工改日期，属于审查报告反对的假红；
     · 用户手机上由 app.js 的 shelfFreshness() 徽标看得到同一结论，
       两处共用同一个判据（判断收口在 js/core/webank.js），不会口径分叉。
   体积护栏同理：只报数 + 超阈值提醒，不拦发布（351 KB 原文 / gzip 21 KB，
   零构建下必须同步 import，压成 JSON 再 fetch 会破坏离线可用）。

   用法：node scripts/check-shelf-freshness.mjs
   复验：改 js/core/webank-shelf.js 的 meta.captured_at 或临时造一个
        过期索引，本脚本应打印 ⚠️ 但 exit 仍为 0。
   ============================================================ */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SHELF from "../js/core/webank-shelf.js";
import { shelfFreshness, SHELF_FRESH_DAYS, SHELF_STALE_DAYS } from "../js/core/webank.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDX = path.join(ROOT, "js/core/webank-shelf.js");

/* 护栏阈值（软）：原文 >600 KB 或 gzip >80 KB 时提醒重审字段清单。
   当前 352,135 B / gzip 约 21 KB，余量充足。 */
const RAW_WARN = 600 * 1024;
const GZIP_WARN = 80 * 1024;

const f = shelfFreshness(SHELF);
const tag = { fresh: "✅", aging: "🟡", stale: "⚠️", unknown: "⚠️" }[f.level] || "•";
console.log(`静态索引健康：${tag} ${f.label}（快照 ${f.captured_at} · 阈值 新鲜≤${SHELF_FRESH_DAYS}天 / 过期>${SHELF_STALE_DAYS}天）`);
if (f.days != null) console.log(`  已过 ${f.days} 天 · 货架 ${SHELF.meta.shelf_rows} 只 · 代销证据 ${SHELF.meta.agents_rows} 只`);
if (f.hint) console.log(`  提示：${f.hint}`);

const raw = fs.readFileSync(IDX);
const gz = zlib.gzipSync(raw, { level: 9 });
console.log(`  体积：原文 ${raw.length.toLocaleString()} B / gzip -9 ${gz.length.toLocaleString()} B · ${SHELF.meta.shelf_rows} 只`);
if (raw.length > RAW_WARN || gz.length > GZIP_WARN) {
  console.log(`  ⚠️ 体积超过软阈值（原文 ${RAW_WARN} B / gzip ${GZIP_WARN} B），建议重审字段白名单；本次不阻断。`);
}

/* 软哨兵：快照过期 / 体积膨胀都只是提醒，绝不 exit 1。
   真正该红的（版本不一致、SHELL 漏文件、语法错、测试挂）由各自硬门禁守。 */
console.log("  软哨兵完成（退出码恒 0，不阻断发布）");
process.exit(0);
