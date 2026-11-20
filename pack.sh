#!/usr/bin/env bash
#
# 一键打包 dsh-infinite-context，供其他人通过 dsh plugin add 安装。
# （pack.ps1 的 Ubuntu 侧复刻；两侧语义保持一致，改一边记得改另一边。）
#
#   - 检查 Node.js 版本（>= 22）
#   - 缺少 node_modules 时执行 pnpm install --frozen-lockfile
#   - npm pack（自动触发 prepack：typecheck + vitest + build 三闸）
#   - 校验 tarball 只包含 dist、package.json、bundle.patch.yml、cordis.yml 等
#     运行文件，且不含 docs/tests/scripts/src/node_modules
#   - 生成 SHA256SUMS.txt，并打印安装命令
#
# 用法:
#   ./pack.sh                 # 输出到 release/，先清空
#   ./pack.sh --out-dir DIR   # 指定输出目录
#   ./pack.sh --skip-install  # 跳过依赖安装检查
#   ./pack.sh --keep-out-dir  # 保留输出目录里的旧文件
#
# dash (`sh pack.sh`) 不认识 pipefail/BASH_SOURCE：自动以 bash 重执行。
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

OUT_DIR="release"
SKIP_INSTALL=0
KEEP_OUT_DIR=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --out-dir=*) OUT_DIR="${1#*=}"; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --keep-out-dir) KEEP_OUT_DIR=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
err_file="$(mktemp "${TMPDIR:-/tmp}/dsh-pack-XXXXXXXX.log")"
cd "$root"
trap 'rm -f "$err_file"' EXIT

cyan() { if [ -t 1 ]; then printf '\033[36m%s\033[0m\n' "$1"; else printf '%s\n' "$1"; fi; }
green() { if [ -t 1 ]; then printf '\033[32m%s\033[0m\n' "$1"; else printf '%s\n' "$1"; fi; }
fail() { printf '%s\n' "$1" >&2; exit 1; }

cyan "==> dsh-infinite-context pack"
version="$(node -p "require('./package.json').version")"
echo "    version: $version"

if ! command -v node >/dev/null 2>&1; then
  fail "未找到 Node.js，请安装 Node.js >= 22.19.0。"
fi
node_version="$(node --version | tr -d 'v')"
node_major="${node_version%%.*}"
echo "    node: v$node_version"
if [ "$node_major" -lt 22 ]; then
  fail "需要 Node.js >= 22.19.0，当前为 v$node_version。"
fi

if [ "$SKIP_INSTALL" -eq 0 ] && [ ! -d node_modules ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    fail "未找到 pnpm。请安装 pnpm 11，或在依赖已就绪时加 --skip-install。"
  fi
  cyan "==> pnpm install --frozen-lockfile"
  if ! pnpm install --frozen-lockfile 2>"$err_file"; then
    [ -s "$err_file" ] && cat "$err_file"
    fail "pnpm install 失败。"
  fi
fi

if [ -d "$OUT_DIR" ] && [ "$KEEP_OUT_DIR" -eq 0 ]; then
  rm -rf "$OUT_DIR"
fi
mkdir -p "$OUT_DIR"

cyan "==> npm pack"
pack_output="$(npm pack --pack-destination "$OUT_DIR" 2>"$err_file")" || {
  [ -s "$err_file" ] && cat "$err_file"
  fail "npm pack 失败。"
}
tgz_name="$(printf '%s\n' "$pack_output" | grep -E '\.tgz$' | tail -n 1)"
[ -n "$tgz_name" ] || fail "npm pack 未返回 tarball 文件名。"
tgz_name="${tgz_name//[[:space:]]/}"
tgz="$OUT_DIR/$tgz_name"
[ -f "$tgz" ] || fail "tarball 不存在：$tgz"

cyan "==> 校验 tarball 内容"
entries="$(tar -tzf "$tgz" 2>"$err_file")" || {
  [ -s "$err_file" ] && cat "$err_file"
  fail "tar 无法读取 $tgz。"
}
for required in "package/package.json" "package/bundle.patch.yml" "package/cordis.yml"; do
  printf '%s\n' "$entries" | grep -qx "$required" || fail "tarball 缺少 $required。"
done
printf '%s\n' "$entries" | grep -qE '^package/dist/.*\.js$' || fail "tarball 缺少 dist/*.js，构建可能失败。"
forbidden="$(printf '%s\n' "$entries" | grep -E '^package/(docs|tests|scripts|src|node_modules)/' || true)"
if [ -n "$forbidden" ]; then
  fail "tarball 含不应发布的路径：$forbidden"
fi
entry_count="$(printf '%s\n' "$entries" | wc -l)"
echo "    entries: $entry_count"

# bundle.patch.yml 的裸子路径条目经安装包的 exports 映射解析（见 patch 内注释）。
# 条目名缺 exports 时 loader 静默加载失败——/compact-force 曾因此失踪（2026-11-19）。
cyan "==> 校验 patch 条目可经 exports 解析"
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const yml = fs.readFileSync("bundle.patch.yml", "utf8");
const problems = [];
const subs = [...yml.matchAll(/^[ ]*name:[ ]*dsh-infinite-context\/([A-Za-z0-9_-]+)[ ]*$/gm)].map(m => m[1]);
for (const s of subs) if (pkg.exports?.["./" + s] === undefined) problems.push("exports 缺少子路径 ./" + s);
if (pkg.dsh?.client) {
  const c = pkg.exports?.["./client"];
  if (c === undefined) problems.push("声明了 dsh.client 但 exports[\"./client\"] 缺失（浏览器半不会加载）");
  else if (!fs.existsSync(c)) problems.push("exports[\"./client\"] 指向不存在的文件：" + c);
  if (!/^[ ]*name:[ ]*dsh-infinite-context[ ]*$/m.test(yml)) problems.push("声明了 dsh.client 但 bundle.patch.yml 没有裸包名条目（name: dsh-infinite-context）——子路径条目不会合成浏览器半（2026-11-19 事故）");
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("    patch entries: " + subs.length + "，全部可解析" + (pkg.dsh?.client ? "；client 半已声明且裸包名条目在位" : ""));
' || fail "bundle.patch.yml/dsh.client 与 exports 不一致（安装后 loader 将无法加载对应模块）。"

# 哈希三条路，探测后使用：MSYS bash 未必带 sha256sum 或 openssl，pipefail 下
# 第一条缺失会直接中断脚本；命令存在也可能失败（旧 openssl 不认 -r），所以
# 每路非零退出都当空哈希、继续落到下一路。node 是本项目的硬依赖，兜底。
hash=""
if command -v sha256sum >/dev/null 2>&1; then
  hash="$(sha256sum "$tgz" | cut -d' ' -f1)" || hash=""
fi
if [ -z "$hash" ] && command -v openssl >/dev/null 2>&1; then
  hash="$(openssl dgst -sha256 -r "$tgz" | cut -d' ' -f1)" || hash=""
fi
if [ -z "$hash" ]; then
  hash="$(node -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$tgz")" || hash=""
fi
if [ -z "$hash" ]; then
  fail "无法计算 sha256（sha256sum / openssl / node 都不可用）。"
fi
printf '%s  %s\n' "$hash" "$tgz_name" > "$OUT_DIR/SHA256SUMS.txt"
echo "    sha256: $hash"

size_kb="$(du -k "$tgz" | cut -f1)"
full="$(cd "$OUT_DIR" && pwd)/$tgz_name"
echo ""
green "==> 完成"
echo "    tarball: $full (${size_kb} KB)"
echo "    sha256 : $OUT_DIR/SHA256SUMS.txt"
echo ""
cyan "安装方式："
echo "    dsh plugin --profile <profile> add $full"
echo ""
echo "或由 pnpm 管理 profile 依赖时："
echo "    pnpm add \"file:$full\""
echo ""
