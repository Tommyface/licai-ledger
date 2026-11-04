#!/usr/bin/env bash
# 语法门禁：CI 的「node --check」那一步在本地没有对应命令，v76 就是这么漏的 ——
# app.js 里多了一个引号，npm run check 全绿、线上整页空白、APK 里也是空白。
# 这一段把那一步搬进本地检查，一条都不能少：外壳（app.js / sw.js）与 js/ 下每个模块。
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "❌ $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "找不到 node：这一项检查要靠它解析页面 JS"

n=0
for f in app.js sw.js js/core/*.js js/domain/*.js; do
  [ -e "$f" ] || fail "要查的文件不存在：$f"
  if ! out=$(node --check "$f" 2>&1); then
    echo "$out" >&2
    fail "node 解析不了 $f —— 浏览器同样解析不了，这一份发出去就是白屏"
  fi
  n=$((n + 1))
done

echo "✅ 语法门禁：$n 个页面 JS 全部可解析（app.js / sw.js / js/core / js/domain）"
