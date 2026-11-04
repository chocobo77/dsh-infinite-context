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

hash="$(sha256sum "$tgz" | cut -d' ' -f1)"
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
