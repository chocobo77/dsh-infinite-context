#requires -Version 5.1
<#
.SYNOPSIS
  一键打包 dsh-infinite-context，供其他人通过 dsh plugin add 安装。
.DESCRIPTION
  - 检查 Node.js 版本
  - 缺少 node_modules 时执行 pnpm install --frozen-lockfile
  - npm pack（自动触发 prepack/prepare 构建）
  - 校验 tarball 只包含 dist、package.json、bundle.patch.yml、cordis.yml 等运行文件
  - 生成 SHA256SUMS.txt，并打印安装命令
.PARAMETER OutDir
  输出目录，默认 release。
.PARAMETER SkipInstall
  跳过依赖安装检查（适用于已确保依赖就绪的 CI）。
.PARAMETER KeepOutDir
  保留输出目录里的旧文件（默认先清空）。
#>
[CmdletBinding()]
param(
  [string]$OutDir = "release",
  [switch]$SkipInstall,
  [switch]$KeepOutDir
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$errFile = Join-Path $env:TEMP ("dsh-pack-" + [Guid]::NewGuid().ToString("N") + ".log")
Push-Location $root
try {
  Write-Host "==> dsh-infinite-context pack" -ForegroundColor Cyan
  $pkg = Get-Content -Raw -Encoding UTF8 "package.json" | ConvertFrom-Json
  $version = $pkg.version
  Write-Host "    version: $version"

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "未找到 Node.js，请安装 Node.js >= 22.19.0。" }
  $nodeVersion = (& node --version).Trim()
  $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
  Write-Host "    node: $nodeVersion"
  if ($nodeMajor -lt 22) { throw "需要 Node.js >= 22.19.0，当前为 $nodeVersion。" }

  if (-not $SkipInstall -and -not (Test-Path "node_modules")) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) { throw "未找到 pnpm。请安装 pnpm 11，或在依赖已就绪时加 -SkipInstall。" }
    Write-Host "==> pnpm install --frozen-lockfile"
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & pnpm install --frozen-lockfile 2> $errFile
    $code = $LASTEXITCODE
    $ErrorActionPreference = $saved
    if ($code -ne 0) { Get-Content $errFile -ErrorAction SilentlyContinue | Write-Host; throw "pnpm install 失败。" }
  }

  if (Test-Path $OutDir) {
    if (-not $KeepOutDir) { Remove-Item -Recurse -Force $OutDir }
  }
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  Write-Host "==> npm pack"
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $packOutput = & npm pack --pack-destination $OutDir 2> $errFile
  $code = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($code -ne 0) { Get-Content $errFile -ErrorAction SilentlyContinue | Write-Host; throw "npm pack 失败。" }
  $tgzName = ($packOutput | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1)
  if (-not $tgzName) { throw "npm pack 未返回 tarball 文件名。" }
  $tgzName = $tgzName.Trim()
  $tgz = Join-Path $OutDir $tgzName
  if (-not (Test-Path $tgz)) { throw "tarball 不存在：$tgz" }

  Write-Host "==> 校验 tarball 内容"
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $entries = @(& tar -tzf $tgz 2> $errFile)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($code -ne 0) { Get-Content $errFile -ErrorAction SilentlyContinue | Write-Host; throw "tar 无法读取 $tgz。" }
  $required = @("package/package.json", "package/bundle.patch.yml", "package/cordis.yml")
  foreach ($item in $required) {
    if (-not ($entries -contains $item)) { throw "tarball 缺少 $item。" }
  }
  if (-not ($entries | Where-Object { $_ -like "package/dist/*.js" })) {
    throw "tarball 缺少 dist/*.js，构建可能失败。"
  }
  $forbidden = @($entries | Where-Object { $_ -match '^package/(docs|tests|scripts|src|node_modules)/' })
  if ($forbidden.Count -gt 0) {
    $nl = [Environment]::NewLine
    throw ("tarball 含不应发布的路径：" + $nl + ($forbidden -join $nl))
  }
  Write-Host "    entries: $($entries.Count)"

  # bundle.patch.yml 的裸子路径条目经安装包的 exports 映射解析（见 patch 内注释）。
  # 条目名缺 exports 时 loader 静默加载失败——/compact-force 曾因此失踪（2026-11-19）。
  Write-Host "==> 校验 patch 条目可经 exports 解析" -ForegroundColor Cyan
  $check = @(& node -e '
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
')
  if ($LASTEXITCODE -ne 0) {
    if ($check) { Write-Host ($check -join [Environment]::NewLine) }
    throw "bundle.patch.yml/dsh.client 与 exports 不一致（安装后 loader 将无法加载对应模块）。"
  }
  Write-Host ($check -join [Environment]::NewLine)

  $hash = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLowerInvariant()
  $sumFile = Join-Path $OutDir "SHA256SUMS.txt"
  "$hash  $tgzName" | Set-Content -Encoding ASCII $sumFile
  Write-Host "    sha256: $hash"

  $size = [math]::Round((Get-Item $tgz).Length / 1KB, 1)
  $full = (Resolve-Path $tgz).Path
  Write-Host ""
  Write-Host "==> 完成" -ForegroundColor Green
  Write-Host "    tarball: $full ($size KB)"
  Write-Host "    sha256 : $sumFile"
  Write-Host ""
  Write-Host "安装方式：" -ForegroundColor Cyan
  Write-Host "    dsh plugin --profile <profile> add $full"
  Write-Host ""
  Write-Host "或由 pnpm 管理 profile 依赖时："
  Write-Host ("    pnpm add ""file:{0}""" -f $full.Replace('\','/'))
} finally {
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  Pop-Location
}
