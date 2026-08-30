<#
.SYNOPSIS
  DSH 插件一键安装脚本（通用，适用于任何 DSH 插件）。

.DESCRIPTION
  依照官方插件安装方式（dsh plugin --profile <name> add <source>）封装：
    - 本地插件目录：自动校验 dsh.bundle 清单 → npm pack（自动触发 prepare/prepack 编译）
      → 安装 tarball。不走 link: 直装，因为 pnpm link 指向 $DSH_HOME 之外的目录时
      Node 无法沿真实路径解析 @deepseek-ai/* peers（已在 bundle-test profile 实测踩坑）。
    - tgz / npm: 包名 / github:owner/repo / https URL：直接透传给 dsh plugin add。
    - 自动定位 node（优先 v24，strip-only 模式需要）与 harness CLI（通常不在 PATH）。
    - 识别已知 pnpm 错误并给出修复提示（supply-chain 策略 / ignored builds / 旧符号链接）。
    - -Restart 安装成功后联动重启脚本（分离进程，先送消息再杀 3080 端口宿主）。

  关键约束（详见 dsh-infinite-context 仓库 DSH插件安装注意事项.md）：
    * Node 24 拒绝对 node_modules 下的 .ts 做类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
      因此作为包安装的插件必须发布编译后的 dist/ JS，源码 .ts 直载只适用于 file:/// 手工部署。
    * bundle 补丁入口必须用裸子路径说明符（包名/子路径），不能用相对路径（相对 profile 目录解析）。

.PARAMETER Source
  安装来源：本地插件目录 / .tgz 路径 / npm:包名 / github:owner/repo / https URL。
  省略时使用当前目录（须含 package.json）。

.PARAMETER Profile
  目标 DSH profile 名称（默认 web）。

.PARAMETER SkipBuild
  本地目录来源时跳过 npm pack，直接安装目录（link: 方式，仅建议源码在 $DSH_HOME 内时使用）。

.PARAMETER Restart
  安装成功后启动分离的重启脚本重启 DSH。

.PARAMETER HarnessRoot
  harness 检出根目录（默认自动探测 D:\Program files\deepseek-harness 等常见位置）。

.EXAMPLE
  .\install-dsh-plugin.ps1                                    # 安装当前目录插件到 web profile
  .\install-dsh-plugin.ps1 D:\code\上下文精简插件 -Restart     # 安装并重启
  .\install-dsh-plugin.ps1 github:chocobo77/dsh-infinite-context -Profile test
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Source,

  [string]$Profile = 'web',

  [switch]$SkipBuild,

  [switch]$Restart,

  [string]$HarnessRoot,

  # 保留 profile cordis.patch.yml 中的旧手动条目（默认自动清理同 id 条目）
  [switch]$KeepPatch
)

$ErrorActionPreference = 'Continue'

function Write-Step([string]$msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "  [X]  $msg" -ForegroundColor Red }

# ---------------------------------------------------------------- 定位 node
function Resolve-NodeExe {
  $candidates = @('C:\Program Files\nodejs\node.exe', "$env:ProgramFiles\nodejs\node.exe")
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# ---------------------------------------------------------- 定位 harness CLI
function Resolve-HarnessRoot {
  param([string]$Override)
  if ($Override) {
    if (Test-Path (Join-Path $Override 'apps\cli\lib\bin.js')) { return $Override }
    Write-Fail "HarnessRoot '$Override' 下找不到 apps\cli\lib\bin.js"
    return $null
  }
  $candidates = @(
    'D:\Program files\deepseek-harness',
    "$env:ProgramFiles\deepseek-harness",
    "$env:LOCALAPPDATA\deepseek-harness",
    "$env:USERPROFILE\deepseek-harness"
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'apps\cli\lib\bin.js')) { return $c }
  }
  Write-Fail "未找到 harness 检出目录（试过: $($candidates -join ' ; ')）。用 -HarnessRoot 显式指定。"
  return $null
}

$node = Resolve-NodeExe
if (-not $node) { Write-Fail '未找到 node.exe'; exit 1 }
$nodeVersion = & $node -p "process.versions.node" 2>$null
Write-Step "node: $node ($nodeVersion)"
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) {
  Write-Warn2 "node 版本 $nodeVersion 低于 22；strip-only/内置 sqlite 需要 22.19+（本机建议 v24.19.0）。"
}

$harness = Resolve-HarnessRoot -Override $HarnessRoot
if (-not $harness) { exit 1 }
$cli = Join-Path $harness 'apps\cli\lib\bin.js'
Write-Ok "harness CLI: $cli"

# ------------------------------------------------------------ 解析安装来源
$kind = $null        # 'tarball' | 'registry' | 'dir'
$installArg = $null
$packDir = Join-Path $env:TEMP ("dsh-plugin-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

if (-not $Source) { $Source = (Get-Location).Path }

if ($Source -match '^(npm|github):' -or $Source -match '^https?://') {
  $kind = 'registry'; $installArg = $Source
}
elseif ($Source -like '*.tgz' -and (Test-Path $Source)) {
  $kind = 'tarball'; $installArg = (Resolve-Path $Source).Path
}
elseif (Test-Path $Source) {
  # 本地目录
  $pkgPath = Join-Path $Source 'package.json'
  if (-not (Test-Path $pkgPath)) { Write-Fail "'$Source' 不是插件目录（缺 package.json）"; exit 1 }
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $hasBundle = $null -ne $pkg.dsh -and $null -ne $pkg.dsh.bundle
  if (-not $hasBundle) {
    Write-Fail "package.json 未声明 dsh.bundle 清单——按官方要求只有 dsh.client 是不可安装的（contributing.md）。"
    exit 1
  }
  Write-Ok "dsh.bundle 清单: $($pkg.dsh.bundle.patch)"

  $buildScript = $null
  foreach ($s in @('prepare', 'prepack', 'build')) {
    if ($pkg.scripts -and $pkg.scripts.PSObject.Properties[$s]) { $buildScript = $s; break }
  }

  if ($SkipBuild -or -not $buildScript) {
    if (-not $buildScript) { Write-Warn2 "无 prepare/prepack/build 脚本，按原样安装目录（若包内是 .ts 源码，装到 node_modules 会因 strip-only 限制失败）。" }
    else { Write-Warn2 "-SkipBuild：跳过构建，直接 link: 安装目录。源码在 `$DSH_HOME 之外时 peers 可能解析失败。" }
    $kind = 'dir'; $installArg = (Resolve-Path $Source).Path
  }
  else {
    Write-Step "npm pack（触发 $buildScript 编译）…"
    New-Item -ItemType Directory -Path $packDir -Force | Out-Null
    Push-Location $Source
    try {
      $packOut = & npm pack --pack-destination $packDir 2>&1
      $packExit = $LASTEXITCODE
      $packOut | ForEach-Object { Write-Host "  $_" }
      if ($packExit -ne 0) {
        $joined = ($packOut | Out-String)
        if ($joined -match 'is not recognized|ERR_PNPM_NO_IMPORTER|pnpm install') {
          Write-Warn2 "构建失败疑似缺依赖 → 自动 pnpm install 后重试一次…"
          & pnpm install 2>&1 | ForEach-Object { Write-Host "  $_" }
          $packOut = & npm pack --pack-destination $packDir 2>&1
          $packExit = $LASTEXITCODE
          $packOut | ForEach-Object { Write-Host "  $_" }
        }
      }
      if ($packExit -ne 0) { Write-Fail 'npm pack 失败，中止。'; Pop-Location; exit 1 }
      $tgzName = ($packOut | Where-Object { $_ -match '\.tgz\s*$' } | Select-Object -Last 1).Trim()
      if (-not $tgzName) { Write-Fail '无法从 npm pack 输出解析 tarball 文件名'; Pop-Location; exit 1 }
      $kind = 'tarball'
      $installArg = Join-Path $packDir (Split-Path $tgzName -Leaf)
      Write-Ok "tarball: $installArg"
    }
    finally { Pop-Location }
  }
}
else {
  Write-Fail "来源 '$Source' 不存在（既不是目录也不是 tgz）。npm:/github: 前缀写法请显式带前缀。"
  exit 1
}

# ---------------------------------------------------------------- 执行安装
# 记录安装前 profile 已有的依赖（用于安装后定位新装的包 → 读取其 bundle ids）
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$profilePkgPath = Join-Path $profileDir 'package.json'
$beforeDeps = @()
if (Test-Path $profilePkgPath) {
  try {
    $pj = Get-Content $profilePkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pj.dependencies) { $beforeDeps = @($pj.dependencies.PSObject.Properties.Name) }
  } catch { }
}

Write-Step "安装到 profile '$Profile'：dsh plugin --profile $Profile add $installArg"
Push-Location $harness
try {
  $out = & $node $cli plugin --profile $Profile add $installArg 2>&1
  $exit = $LASTEXITCODE
  $out | ForEach-Object { Write-Host "  $_" }
}
finally { Pop-Location }

$outText = ($out | Out-String)

# ------------------------------------------------------- 已知错误识别与提示
if ($exit -ne 0) {
  if ($outText -match 'ERR_PNPM_IGNORED_BUILDS') {
    Write-Warn2 "pnpm 提示有依赖构建脚本被忽略（esbuild 等）。若后续构建/测试报错，在插件目录执行 'pnpm approve-builds'。此提示通常不阻塞安装。"
    if ($outText -match 'Done in') { Write-Ok '检测到安装完成（Done in），按成功处理。'; $exit = 0 }
  }
  if ($outText -match 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION') {
    Write-Fail 'profile 锁文件未通过 supply-chain 策略（某依赖发布时间过新）。修复：等该依赖满龄后重试，或在 profile 目录 pnpm clean --lockfile 后重装。'
  }
  if ($outText -match 'ERR_PNPM_NO_|ERR_MODULE_NOT_FOUND') {
    Write-Fail '模块解析失败。若此前装过同名的 link:/目录版，删除 profile 的 node_modules 与 pnpm-lock.yaml 后重跑本脚本。'
  }
  if ($exit -ne 0) { Write-Fail "安装失败（exit $exit）。"; exit $exit }
}
Write-Ok "安装流程结束。"

# ------------------------------ 幂等清理：移除旧手动方式残留的同 id 条目 ------------------------------
# 场景（2026-08-30 事故）：插件先以手动 file:/// 方式写入 profile cordis.patch.yml，
# 之后又以 bundle 机制安装 → 同 id entry 出现两次 → loader 报 duplicate loader entry id。
# 本步骤在安装成功后，自动识别 profile 补丁层里与本插件 bundle.patch.yml 同 id 的旧条目
# 并移除（先备份）。混排了其它插件条目的块保守跳过，避免误删。-KeepPatch 可跳过清理。
if (-not $KeepPatch) {
  # 收集 profile 内所有已安装 bundle 声明的 entry id：
  # bundle 层与补丁层出现同 id 即为重复（与具体插件无关），均可安全清理。
  $ids = @()
  $nmDir = Join-Path $profileDir 'node_modules'
  if (Test-Path $nmDir) {
    foreach ($dep in (Get-ChildItem $nmDir -Directory -ErrorAction SilentlyContinue)) {
      $bpPath = Join-Path $dep.FullName 'bundle.patch.yml'
      if (Test-Path $bpPath) {
        $bp = [IO.File]::ReadAllText($bpPath)
        $ids += [regex]::Matches($bp, '(?m)^\s*-\s*id:\s*([A-Za-z0-9_\-.]+)') | ForEach-Object { $_.Groups[1].Value }
      }
    }
    $ids = @($ids | Select-Object -Unique)
  }
  $patchPath = Join-Path $profileDir 'cordis.patch.yml'
  if ($ids.Count -gt 0 -and (Test-Path $patchPath)) {
    $bytes = [IO.File]::ReadAllBytes($patchPath)
    $hadBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $raw = [IO.File]::ReadAllText($patchPath)
    $idPattern = ($ids | ForEach-Object { [regex]::Escape($_) }) -join '|'
    if ($raw -notmatch "id:\s*($idPattern)\b") {
      Write-Ok "profile 补丁层无本插件旧条目，无需清理。"
    } else {
      $lines = $raw -split "`r?`n"
      $preface = @()
      $blocks = @()
      $cur = $null
      foreach ($ln in $lines) {
        if ($ln -match '^-') {
          if ($cur) { $blocks += ,$cur }
          $cur = @($ln)
        } elseif ($cur) { $cur += $ln }
        else { $preface += $ln }
      }
      if ($cur) { $blocks += ,$cur }
      $removedIds = @()
      $mixed = $false
      $kept = @()
      foreach ($b in $blocks) {
        $bIds = [regex]::Matches(($b -join "`n"), '(?m)^\s*-?\s*id:\s*([A-Za-z0-9_\-.]+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
        $hasMatch = @($bIds | Where-Object { $ids -contains $_ }).Count -gt 0
        $hasForeign = @($bIds | Where-Object { $ids -notcontains $_ }).Count -gt 0
        if ($hasMatch -and $hasForeign) { $mixed = $true; $kept += ,$b; continue }
        if ($hasMatch) { $removedIds += @($bIds); continue }
        $kept += ,$b
      }
      if ($mixed) {
        Write-Warn2 "profile 补丁层存在与本插件混排的块（同块含其它插件 id），为避免误删未自动清理。请手动核对：$patchPath"
      } elseif ($removedIds.Count -gt 0) {
        $bak = "$patchPath.bak_" + (Get-Date -Format 'yyyyMMdd_HHmmss')
        Copy-Item $patchPath $bak -Force
        $newLines = @()
        $newLines += $preface
        foreach ($b in $kept) { $newLines += ''; $newLines += $b }
        $body = ($newLines -join "`r`n").TrimEnd()
        if (-not ($body -match '(?m)^\s*-')) {
          $body = "# $($removedIds -join ' / ') 现由 bundle 机制管理，旧手动条目已移除（幂等清理）。`r`n# 备份: $bak`r`n[]"
        }
        [IO.File]::WriteAllText($patchPath, $body + "`r`n", (New-Object System.Text.UTF8Encoding($hadBom)))
        Write-Ok "幂等清理：已移除 profile 补丁层旧条目 [$($removedIds -join ', ')]（备份: $bak）"
      }
    }
  }
}

# ---------------------------------------------------------------- 重启
if ($Restart) {
  $restartScript = 'D:\code\DSH\restart-dsh-plugins.ps1'
  if (Test-Path $restartScript) {
    Write-Step "75 秒后自动重启 DSH（分离进程，先让本窗口消息送达）…"
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$restartScript) -WindowStyle Hidden
    Write-Ok "重启脚本已启动：杀 3080 端口宿主 → node apps\cli\lib\bin.js web → 轮询端口自检。"
  }
  else {
    Write-Warn2 "未找到 $restartScript。请手动重启：结束 3080 端口进程后在 $harness 执行 node apps\cli\lib\bin.js web"
  }
}
else {
  Write-Step "下一步"
  Write-Host "  重启 DSH 使插件生效，然后验证："
  Write-Host "    - 启动日志无 plugin tree 报错；插件服务出现 ready 日志（如 memoryContext ready）"
  Write-Host "    - 或用另一 profile 先试装：.\install-dsh-plugin.ps1 <source> -Profile test"
}
