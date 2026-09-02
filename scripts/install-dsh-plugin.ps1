<#
.SYNOPSIS
  DSH 插件一键安装脚本（通用，适用于任何 DSH 插件）。

.DESCRIPTION
  依照官方插件安装方式（dsh plugin --profile <name> add <source>）封装：
    - 自动定位：node、harness 根目录（apps\cli\lib\bin.js）、$DSH_HOME、目标 profile。
      harness 根目录按优先级探测：运行中的 DSH 进程工作目录（PEB） → cfg 记忆值 → 常见安装位置 → 浅层文件系统检索。
      解析结果持久化到同级 install-dsh-plugin.cfg，下次零成本复用。
    - 本地插件目录：自动校验 dsh.bundle 清单 → npm pack（自动触发 prepare/prepack 编译）
      → 安装 tarball。tarball 固定输出到 ~/.dsh/packages/（持久化目录），
      避免 dsh plugin add 的“临时路径陷阱”（file:D:/Temp/... 被清理后重启解析失败）。
    - tgz / npm: 包名 / github:owner/repo / https URL：直接透传给 dsh plugin add。
    - 安装后自动校验目标 profile 的依赖指向：发现指向临时目录的 file:/link: 旧依赖时，
      自动重定向到持久化 tarball 并重同步（修复“重启失败”类问题）。
    - 识别已知 pnpm 错误并给出修复提示（supply-chain 策略 / ignored builds / 旧符号链接）。
    - -Restart 安装成功后联动重启脚本（分离进程，先送消息再杀 3080 端口宿主）。

  关键约束（详见 dsh-infinite-context 仓库 DSH插件开发经验.md）：
    * Node 24 拒绝对 node_modules 下的 .ts 做类型剥离（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
      因此作为包安装的插件必须发布编译后的 dist/ JS，源码 .ts 直载只适用于 file:/// 手工部署。
    * bundle 补丁入口必须用裸子路径说明符（包名/子路径），不能用相对路径（相对 profile 目录解析）。
    * tarball 依赖必须指向持久化目录（~/.dsh/packages/），不能指向 %TEMP%（会被清理）。

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
  harness 检出根目录（默认自动探测，见上方优先级说明）。

.PARAMETER KeepPatch
  保留 profile cordis.patch.yml 中的旧手动条目（默认自动清理同 id 条目）。

.PARAMETER DetectOnly
  只解析并打印 node / harness / DSH_HOME / profile / 来源，不打包、不安装、不重启。
  用于安全验证自动探测是否命中正确目录。

.PARAMETER Cfg
  持久化配置文件路径（默认与脚本同目录 install-dsh-plugin.cfg，GBK 编码与 bat 兼容）。

.EXAMPLE
  .\install-dsh-plugin.ps1 -DetectOnly                              # 只验证自动探测
  .\install-dsh-plugin.ps1                                          # 安装当前目录插件到 web profile
  .\install-dsh-plugin.ps1 D:\code\上下文精简插件 -Restart           # 安装并重启
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
  [switch]$KeepPatch,

  # 只探测不安装（安全测试用）
  [switch]$DetectOnly,

  [string]$Cfg
)

$ErrorActionPreference = 'Continue'

# 脚本所在目录（PS 5.1 的 param 默认值里 $PSScriptRoot 可能为空，故在体内解析）
$script:ScriptDir = if ($PSScriptRoot) { $PSScriptRoot }
  elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
  else { (Get-Location).Path }
$script:CfgPath = if ($Cfg) { $Cfg } else { Join-Path $script:ScriptDir 'install-dsh-plugin.cfg' }

function Write-Step([string]$msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "  [X]  $msg" -ForegroundColor Red }

# ============================================================ 配置持久化（GBK/936，与 bat 保持一致）
function Read-Cfg([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  try {
    $text = [Text.Encoding]::GetEncoding(936).GetString([IO.File]::ReadAllBytes($path))
    foreach ($ln in ($text -split "`r?`n")) {
      if ($ln -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $map[$matches[1].ToUpper()] = $matches[2].Trim()
      }
    }
  } catch { Write-Warn2 "cfg 读取失败（忽略）: $($_.Exception.Message)" }
  return $map
}

function Write-Cfg([string]$path, [hashtable]$map) {
  try {
    $dir = Split-Path $path -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $sb = [Text.StringBuilder]::new()
    foreach ($k in ($map.Keys | Sort-Object)) { [void]$sb.AppendLine("$k=$($map[$k])") }
    [IO.File]::WriteAllBytes($path, [Text.Encoding]::GetEncoding(936).GetBytes($sb.ToString()))
  } catch { Write-Warn2 "cfg 写入失败（不影响安装）: $($_.Exception.Message)" }
}

# 合并一个新 key/value 到 cfg（保留其它键，如 bat 写的 PROFILE / DEFAULT_DIR）
function Save-CfgKey([string]$key, [string]$value) {
  $map = Read-Cfg $script:CfgPath
  $map[$key] = $value
  Write-Cfg $script:CfgPath $map
}

# ============================================================ 定位 node
function Resolve-NodeExe {
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:ProgramW6432\nodejs\node.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# ============================================================ 读取指定进程的工作目录（PEB，x64 Win10/11；失败返回 $null）
function Read-ProcessCwd {
  param([int]$ProcessId)
  try {
    if (-not ('DshCwdReader' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshCwdReader {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)]
  public struct PBI { public IntPtr ExitStatus; public IntPtr PebBase; public IntPtr AffinityMask; public IntPtr BasePriority; public UIntPtr UniquePid; public IntPtr InheritedFromPid; }
  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr h, int cls, out PBI pbi, int len, out int ret);
}
'@ -ErrorAction Stop | Out-Null
    }
    $h = [DshCwdReader]::OpenProcess(0x0410, $false, $ProcessId)  # QUERY_LIMITED_INFORMATION | VM_READ | QUERY_INFORMATION
    if ($h -eq [IntPtr]::Zero) { return $null }
    try {
      $pbi = New-Object DshCwdReader+PBI
      $len = [Runtime.InteropServices.Marshal]::SizeOf($pbi)
      $ret = 0
      if ([DshCwdReader]::NtQueryInformationProcess($h, 0, [ref]$pbi, $len, [ref]$ret) -ne 0) { return $null }
      $peb = $pbi.PebBase
      $buf = New-Object byte[] 8
      $read = [IntPtr]::Zero
      if (-not [DshCwdReader]::ReadProcessMemory($h, [IntPtr]::Add($peb, 0x20), $buf, 8, [ref]$read)) { return $null }
      $pp = [BitConverter]::ToInt64($buf, 0)
      $buf2 = New-Object byte[] 0x400
      if (-not [DshCwdReader]::ReadProcessMemory($h, [IntPtr]$pp, $buf2, 0x400, [ref]$read)) { return $null }
      $cdLen = [BitConverter]::ToUInt16($buf2, 0x38)
      $cdPtr = [BitConverter]::ToInt64($buf2, 0x40)
      if ($cdLen -le 0 -or $cdPtr -eq 0) { return $null }
      $cbuf = New-Object byte[] $cdLen
      if (-not [DshCwdReader]::ReadProcessMemory($h, [IntPtr]$cdPtr, $cbuf, $cdLen, [ref]$read)) { return $null }
      return [Text.Encoding]::Unicode.GetString($cbuf).TrimEnd([char]0, [char]' ', [char]"`t")
    } finally { [DshCwdReader]::CloseHandle($h) | Out-Null }
  } catch { return $null }
}

# ============================================================ 从运行中的 DSH 进程推导 harness 根
function Get-RunningHarnessRoot {
  $port = 3080
  if ($env:DSH_WEB_URL -match ':(\d+)/?$') { $port = [int]$Matches[1] }
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.CommandLine) { return $null }
  $cmd = $proc.CommandLine
  if ($cmd -notmatch 'apps[/\\]cli[/\\]lib[/\\]bin\.js') { return $null }
  # 绝对路径情形（带引号 / 不带引号）
  $abs = $null
  if ($cmd -match '"([A-Za-z]:[\\/][^"]*apps[\\/]cli[\\/]lib[\\/]bin\.js)"') { $abs = $Matches[1] }
  elseif ($cmd -match '([A-Za-z]:[\\/](?:[^\\\/"\s]*[\\/])*apps[\\/]cli[\\/]lib[\\/]bin\.js)') { $abs = $Matches[1] }
  if ($abs) {
    $p = $abs
    for ($i = 0; $i -lt 4; $i++) { $p = Split-Path $p -Parent }
    if (Test-Path (Join-Path $p 'apps\cli\lib\bin.js')) { return $p }
    return $null
  }
  # 相对路径（node apps/cli/lib/bin.js web）→ 读取进程工作目录
  $cwd = Read-ProcessCwd $conn.OwningProcess
  if ($cwd -and (Test-Path (Join-Path $cwd 'apps\cli\lib\bin.js'))) { return $cwd }
  return $null
}

# ============================================================ 浅层文件系统检索 harness 根
function Find-HarnessRootBySearch {
  $names = @('deepseek-harness', 'dsh-harness', 'harness', 'deepseek')
  $roots = @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { $_.Root })
  foreach ($root in $roots) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    $bases = @($root)
    foreach ($extra in @('Program Files', 'Program Files (x86)', 'tools', 'dev', 'code', 'apps', 'scoop\apps')) {
      $bases += (Join-Path $root $extra)
    }
    foreach ($base in ($bases | Select-Object -Unique)) {
      foreach ($n in $names) {
        $p = Join-Path (Join-Path $base $n) 'apps\cli\lib\bin.js'
        if (Test-Path $p) {
          $hp = $p; for ($i = 0; $i -lt 4; $i++) { $hp = Split-Path $hp -Parent }
          if (Test-Path (Join-Path $hp 'apps\cli\lib\bin.js')) { return $hp }
        }
      }
    }
  }
  # 各盘根目录一级子目录扫描（跳过系统/无关目录），检查 <dir>\apps\... 与 <dir>\deepseek-harness\apps\...
  foreach ($root in $roots) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    $top = Get-ChildItem $root -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch '^\$|^Windows$|^ProgramData$|^PerfLogs$|^Recovery$|^System Volume Information$|^node_modules$|^Temp$|^temp$' }
    foreach ($d in $top) {
      $p2 = Join-Path $d.FullName 'apps\cli\lib\bin.js'
      if (Test-Path $p2) { return $d.FullName }
      foreach ($n in $names) {
        $p3 = Join-Path (Join-Path $d.FullName $n) 'apps\cli\lib\bin.js'
        if (Test-Path $p3) {
          $hp = $p3; for ($i = 0; $i -lt 4; $i++) { $hp = Split-Path $hp -Parent }
          if (Test-Path (Join-Path $hp 'apps\cli\lib\bin.js')) { return $hp }
        }
      }
    }
  }
  return $null
}

# ============================================================ 定位 harness 根目录
function Resolve-HarnessRoot {
  param([string]$Override)
  if ($Override) {
    if (Test-Path (Join-Path $Override 'apps\cli\lib\bin.js')) { return $Override }
    Write-Fail "HarnessRoot '$Override' 下找不到 apps\cli\lib\bin.js"
    return $null
  }
  Write-Step "自动定位 harness 根目录…"
  # 1) 运行中的 DSH 进程（最权威：就是当前在跑的那个）
  $fromProc = Get-RunningHarnessRoot
  if ($fromProc) { Write-Ok "运行中的 DSH 进程（端口 $(if ($env:DSH_WEB_URL -match ':(\d+)') { $Matches[1] } else { 3080 })）工作目录: $fromProc"; return $fromProc }
  # 2) cfg 记忆值
  $cached = $script:Cfg['HARNESS']
  if ($cached) {
    if (Test-Path (Join-Path $cached 'apps\cli\lib\bin.js')) { Write-Ok "cfg 记忆的 harness: $cached"; return $cached }
    Write-Warn2 "cfg 中的 HARNESS 已失效（$cached），重新探测…"
  }
  # 3) 常见安装位置
  $candidates = @(
    'D:\Program files\deepseek-harness',
    "$env:ProgramFiles\deepseek-harness",
    "$env:ProgramW6432\deepseek-harness",
    "$env:ProgramFiles(x86)\deepseek-harness",
    "$env:LOCALAPPDATA\deepseek-harness",
    "$env:USERPROFILE\deepseek-harness",
    "$env:USERPROFILE\harness\deepseek-harness"
  ) | Where-Object { $_ } | Select-Object -Unique
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'apps\cli\lib\bin.js')) { Write-Ok "常见安装位置: $c"; return $c }
  }
  # 4) 浅层检索
  $found = Find-HarnessRootBySearch
  if ($found) { Write-Ok "文件系统检索到: $found"; return $found }
  Write-Fail "未找到 harness 检出目录（apps\cli\lib\bin.js）。用 -HarnessRoot 显式指定。"
  return $null
}

# ============================================================ 定位 $DSH_HOME（用户数据目录，含 profiles）
function Resolve-DshHome {
  if ($env:DSH_HOME -and (Test-Path $env:DSH_HOME)) { return $env:DSH_HOME }
  if ($env:USERPROFILE) {
    $d = Join-Path $env:USERPROFILE '.dsh'
    if (Test-Path $d) { return $d }
  }
  return $null
}

# ============================================================ 主流程
$script:Cfg = Read-Cfg $script:CfgPath

# ---- node
$node = Resolve-NodeExe
if (-not $node) { Write-Fail '未找到 node.exe'; exit 1 }
$nodeVersion = & $node -p "process.versions.node" 2>$null
Write-Step "node: $node ($nodeVersion)"
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 22) {
  Write-Warn2 "node 版本 $nodeVersion 低于 22；strip-only/内置 sqlite 需要 22.19+（本机建议 v24.19.0）。"
}

# ---- harness / DSH_HOME
$harness = Resolve-HarnessRoot -Override $HarnessRoot
if (-not $harness) { exit 1 }
$cli = Join-Path $harness 'apps\cli\lib\bin.js'
$dshHome = Resolve-DshHome
if (-not $dshHome) { Write-Fail '未找到 $DSH_HOME（$env:DSH_HOME 或 ~/.dsh）。'; exit 1 }
$profileDir = Join-Path $dshHome "profiles\$Profile"
Write-Ok "harness CLI : $cli"
Write-Ok "DSH_HOME    : $dshHome"
Write-Ok "目标 profile: $Profile（$profileDir）"

# 记忆到 cfg（保留其它键）
Save-CfgKey 'HARNESS' $harness
Save-CfgKey 'DSH_HOME' $dshHome

# ---- pnpm 预检（dsh plugin 底层依赖 pnpm，缺了必然失败）
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) { Write-Fail 'PATH 上找不到 pnpm（DSH plugin 管理依赖它）。请先安装 pnpm。'; exit 1 }
Write-Ok "pnpm: $($pnpm.Source)"

# ---- 解析安装来源
$kind = $null        # 'tarball' | 'registry' | 'dir'
$installArg = $null
$packDir = Join-Path $dshHome 'packages'   # 持久化目录，规避临时路径陷阱

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
    if ($DetectOnly) {
      # 只探测：报告将打包到的持久化位置即可，不真正打包
      Write-Ok "来源为本地目录（build: $buildScript），将 npm pack 到 $packDir"
      $kind = 'dir-pending-pack'
    }
    else {
      Write-Step "npm pack（触发 $buildScript 编译）→ $packDir"
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
}
else {
  Write-Fail "来源 '$Source' 不存在（既不是目录也不是 tgz）。npm:/github: 前缀写法请显式带前缀。"
  exit 1
}

# ---- DetectOnly：只报告，退出
if ($DetectOnly) {
  Write-Step "DetectOnly：仅打印解析结果（不打包 / 不安装 / 不重启）"
  Write-Host "  node     : $node ($nodeVersion)"
  Write-Host "  harness  : $harness"
  Write-Host "  DSH_HOME : $dshHome"
  Write-Host "  profile  : $Profile -> $profileDir"
  Write-Host "  source   : [$kind] $installArg"
  Write-Host "  pack dir : $packDir（持久化，规避临时路径陷阱）"
  Write-Host "  pnpm     : $($pnpm.Source)"
  Write-Ok "探测完成。cfg 已记忆 HARNESS/DSH_HOME：$script:CfgPath"
  exit 0
}

# ---- 执行安装
# 记录安装前 profile 已有的依赖（用于安装后定位新装的包 → 读取其 bundle ids）
$beforeDeps = @()
if (Test-Path $profileDir) {
  $profilePkgPath = Join-Path $profileDir 'package.json'
  if (Test-Path $profilePkgPath) {
    try {
      $pj = Get-Content $profilePkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pj.dependencies) { $beforeDeps = @($pj.dependencies.PSObject.Properties.Name) }
    } catch { }
  }
}

# ---- 预检修复：移除目标 profile 中指向临时/缺失路径的旧依赖（临时路径陷阱）
# 场景：此前用 dsh plugin add 装过 <临时目录> 的 tarball，package.json 里记成
#   file:D:/Temp/dsh-plugin-install-xxx/...tgz；临时目录被清理后，任何 pnpm 操作
#   （包括本次 add）都会因解析不到该路径而 ENOENT 失败。先摘掉这些失效条目再安装。
function Repair-BrokenDeps {
  param([string]$ProfileDir)
  $pkgPath = Join-Path $ProfileDir 'package.json'
  if (-not (Test-Path $pkgPath)) { return }
  try {
    $pj = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $pj.dependencies) { return }
    $removed = @()
    foreach ($depName in @($pj.dependencies.PSObject.Properties.Name)) {
      $spec = [string]$pj.dependencies.$depName
      $isFileLink = $spec -match '^(file|link):'
      $isTemp = $spec -match '(?i)(file|link):[^ ]*(?:[\\/])(?:temp|tmp)(?:[\\/]|$)' -or
                $spec -match '(?i)^(file|link):[A-Za-z]:[\\/](?:temp|tmp)(?:[\\/]|$)'
      $isMissing = $false
      if ($isFileLink) {
        $tgt = $spec -replace '^(file|link):', ''
        if ($tgt -match '^file:///') { $tgt = $tgt -replace '^file:///', '' }
        if ($tgt -match '^/[A-Za-z]:/') { $tgt = ($tgt.Substring(1)) -replace '/', '\' }
        elseif ($tgt -match '^[A-Za-z]:') { $tgt = $tgt -replace '/', '\' }
        if ($tgt -and -not (Test-Path $tgt)) { $isMissing = $true }
      }
      if ($isMissing -or $isTemp) {
        Write-Warn2 "目标 profile 依赖 $depName 指向不可用/临时路径（$spec）→ 安装前先移除该条目"
        $pj.dependencies.PSObject.Properties.Remove($depName)
        $removed += $depName
      }
    }
    if ($removed.Count -gt 0) {
      # 注意：必须写 无 BOM 的 UTF-8 —— Node 的 JSON.parse 不接受 BOM（PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM）
      $json = $pj | ConvertTo-Json -Depth 20
      [IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      Write-Ok "预检已移除失效依赖条目: $($removed -join ', ')（本次 add 会重新以持久化 tarball 加入）"
    }
  } catch { Write-Warn2 "预检修复读取 package.json 失败（跳过）: $($_.Exception.Message)" }
}

Write-Step "预检目标 profile 的失效依赖（临时路径陷阱）…"
Repair-BrokenDeps $profileDir

Write-Step "安装到 profile '$Profile'：dsh plugin --profile $Profile add $installArg"
Push-Location $harness
try {
  $out = & $node $cli plugin --profile $Profile add $installArg 2>&1
  $exit = $LASTEXITCODE
  $out | ForEach-Object { Write-Host "  $_" }
}
finally { Pop-Location }

$outText = ($out | Out-String)

# ---- 已知错误识别与提示
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

# ---- 校验/修复目标 profile 的依赖指向（临时路径陷阱防护）
function Get-PkgNameFromTgz([string]$tgzPath) {
  return [IO.Path]::GetFileNameWithoutExtension([IO.Path]::GetFileName($tgzPath)) -replace '-[\d][^\-]*$', ''
}

$installedPkg = $null
if ($kind -eq 'tarball') {
  $profilePkgPath2 = Join-Path $profileDir 'package.json'
  if (Test-Path $profilePkgPath2) {
    try {
      $pj2 = Get-Content $profilePkgPath2 -Raw -Encoding UTF8 | ConvertFrom-Json
      $added = @($pj2.dependencies.PSObject.Properties.Name) | Where-Object { $_ -notin $beforeDeps }
      $installedPkg = if ($added.Count -eq 1) { $added[0] } else { Get-PkgNameFromTgz $installArg }
      $spec = $pj2.dependencies.$installedPkg
      if ($spec) {
        $persistUrl = 'file:' + ($installArg -replace '\\', '/' -replace ' ', '%20')
        $isTemp = $spec -match '(?i)^(file|link):[A-Za-z]:[\\/].*(?:[\\/])(?:temp|tmp)(?:[\\/]|$)' -or
                  $spec -match '(?i)^(file|link):[A-Za-z]:[\\/]temp[\\/]'
        if ($isTemp) {
          Write-Warn2 "目标 profile 依赖仍指向临时目录（$spec）→ 重定向到持久化 tarball…"
          $pj2.dependencies.$installedPkg = $persistUrl
          # 无 BOM 的 UTF-8（同上，Node JSON.parse 不接受 BOM）
          $json = $pj2 | ConvertTo-Json -Depth 20
          [IO.File]::WriteAllText($profilePkgPath2, $json, (New-Object System.Text.UTF8Encoding($false)))
          Write-Ok "已重定向: $installedPkg = $persistUrl"
          Write-Warn2 "正在该 profile 重跑 pnpm install 使锁文件与 node_modules 一致（offline 优先）…"
          Push-Location $profileDir
          try {
            $null = & pnpm install --offline 2>&1
            if ($LASTEXITCODE -ne 0) { $null = & pnpm install 2>&1 }
          } finally { Pop-Location }
        }
        elseif ($spec -eq $persistUrl) {
          Write-Ok "依赖已指向持久化 tarball（无临时路径陷阱）: $spec"
        }
        else {
          Write-Ok "依赖为非常规来源，按原样保留: $spec"
        }
      }
    } catch { Write-Warn2 "依赖指向检查失败（跳过）: $($_.Exception.Message)" }
  }
}

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
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $restartScript) -WindowStyle Hidden
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
  Write-Host "    - 依赖已指向持久化 tarball（$packDir），不会再因临时目录被清理而重启失败"
}
