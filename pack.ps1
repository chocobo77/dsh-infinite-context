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
