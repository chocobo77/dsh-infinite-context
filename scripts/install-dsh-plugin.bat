@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title DSH 插件一键安装

rem ==============================================================
rem  DSH 插件一键安装菜单 v1.1（封装 install-dsh-plugin.ps1）
rem  与 install-dsh-plugin.ps1 放同一目录，或自动回退到插件仓库。
rem  默认设置持久化在同级 install-dsh-plugin.cfg。
rem ==============================================================

set "PS1=%~dp0install-dsh-plugin.ps1"
if not exist "%PS1%" set "PS1=D:\code\上下文精简插件\scripts\install-dsh-plugin.ps1"
if not exist "%PS1%" (
    echo [X] 找不到 install-dsh-plugin.ps1，请把本 bat 与它放在同一目录。
    pause
    exit /b 1
)

rem ---- 读取持久化默认设置 ----
set "PROFILE=web"
set "DEFAULT_DIR=D:\code\上下文精简插件"
if exist "%~dp0install-dsh-plugin.cfg" (
    for /f "tokens=1,* delims==" %%a in ('type "%~dp0install-dsh-plugin.cfg"') do (
        if /i "%%a"=="PROFILE" set "PROFILE=%%b"
        if /i "%%a"=="DEFAULT_DIR" set "DEFAULT_DIR=%%b"
    )
)
set "RESTART=N"

:MENU
cls
echo.
echo  ============================================================
echo    DSH 插件一键安装
echo  ============================================================
echo    默认 Profile : %PROFILE%      （[7] 可修改，自动保存）
echo    默认插件目录 : %DEFAULT_DIR%
echo  ------------------------------------------------------------
echo    选择安装来源：
echo.
echo     [1] 当前默认目录插件        （%DEFAULT_DIR%）
echo     [2] 指定本地目录插件        （自动编译 -^> tarball 安装）
echo     [3] GitHub 仓库             （github:owner/repo）
echo     [4] npm 包                  （npm:package-name）
echo     [5] tarball 文件            （路径\to\plugin.tgz）
echo     [6] 仅编译打包，不安装      （npm pack）
echo.
echo     [7] 修改默认设置
echo     [8] 查看帮助
echo     [0] 退出
echo.
choice /c 123456780 /n /m " 请选择 [0-8]: "
goto OPT%errorlevel%

rem ==================== 来源 1：默认目录 ====================
:OPT1
set "SOURCE=%DEFAULT_DIR%"
goto CHECK_DIR

rem ==================== 来源 2：指定目录 ====================
:OPT2
echo.
echo  第 1 步 / 输入插件目录（右键可粘贴，回车确认）
set /p "INPUT_DIR=  目录路径: "
if "%INPUT_DIR%"=="" (
    echo  [X] 路径不能为空。
    goto PICK_AGAIN
)
set "SOURCE=%INPUT_DIR%"

:CHECK_DIR
echo.
echo  正在检查来源: %SOURCE%
if not exist "%SOURCE%\" (
    echo  [X] 目录不存在: %SOURCE%
    goto PICK_AGAIN
)
if not exist "%SOURCE%\package.json" (
    echo  [X] 该目录没有 package.json，不是插件目录。
    goto PICK_AGAIN
)
echo  [OK] 来源有效。
goto ASK_PROFILE

rem ==================== 来源 3：GitHub ====================
:OPT3
echo.
echo  第 1 步 / 输入 GitHub 仓库（格式 owner/repo）
set /p "REPO=  仓库: "
if "%REPO%"=="" (
    echo  [X] 不能为空。
    goto PICK_AGAIN
)
set "SOURCE=github:%REPO%"
goto ASK_PROFILE

rem ==================== 来源 4：npm ====================
:OPT4
echo.
echo  第 1 步 / 输入 npm 包名
set /p "PKG=  包名: "
if "%PKG%"=="" (
    echo  [X] 不能为空。
    goto PICK_AGAIN
)
set "SOURCE=npm:%PKG%"
goto ASK_PROFILE

rem ==================== 来源 5：tarball ====================
:OPT5
echo.
echo  第 1 步 / 输入 tarball 路径（.tgz）
set /p "TGZ=  路径: "
if "%TGZ%"=="" (
    echo  [X] 路径不能为空。
    goto PICK_AGAIN
)
if not exist "%TGZ%" (
    echo  [X] 文件不存在: %TGZ%
    goto PICK_AGAIN
)
set "SOURCE=%TGZ%"
goto ASK_PROFILE

rem ==================== 来源 6：仅打包 ====================
:OPT6
echo.
echo  第 1 步 / 输入插件目录（回车 = 默认 %DEFAULT_DIR%）
set /p "SRC6=  目录路径: "
if "%SRC6%"=="" set "SRC6=%DEFAULT_DIR%"
echo.
echo  第 2 步 / 开始 npm pack（自动触发编译）...
pushd "%SRC6%"
call npm pack
set "PACKRC=%errorlevel%"
popd
echo.
if "%PACKRC%"=="0" (
    echo  [OK] 打包成功，tarball 在上方输出路径（或插件目录内）。
) else (
    echo  [X] 打包失败（退出码 %PACKRC%）。常见原因：缺依赖 → 先在插件目录执行 pnpm install。
)
echo.
echo  8 秒后返回菜单...
choice /c Q /n /t 8 /d Q >nul
goto MENU

rem ==================== 来源 7：设置 ====================
:OPT7
echo.
echo  ============================================================
echo   修改默认设置（保存到 install-dsh-plugin.cfg）
echo  ============================================================
echo   当前 Profile     : %PROFILE%
echo   当前默认插件目录 : %DEFAULT_DIR%
echo  ------------------------------------------------------------
echo   [1] 修改默认 Profile
echo   [2] 修改默认插件目录
echo   [0] 返回主菜单
choice /c 120 /n /m " 请选择: "
if errorlevel 3 goto MENU
if errorlevel 2 goto SET_DIR
echo.
set /p "PROFILE=  新 Profile 名称 (回车取消): "
goto SAVE_CFG

:SET_DIR
echo.
set /p "DEFAULT_DIR=  新默认插件目录 (回车取消): "

:SAVE_CFG
(
    echo PROFILE=%PROFILE%
    echo DEFAULT_DIR=%DEFAULT_DIR%
) > "%~dp0install-dsh-plugin.cfg"
echo.
echo  [OK] 已保存。
choice /c Q /n /t 2 /d Q >nul
goto MENU

rem ==================== 公共：确认 Profile ====================
:ASK_PROFILE
echo.
echo  第 2 步 / 目标 profile（回车 = %PROFILE%）
set /p "PROFILE_IN=  profile: "
if not "%PROFILE_IN%"=="" set "PROFILE=%PROFILE_IN%"

rem ==================== 公共：确认重启 ====================
echo.
echo  第 3 步 / 安装成功后是否自动重启 DSH？
choice /c YN /n /m "  自动重启 [Y/N，默认 N]: "
if errorlevel 2 (set "RESTART=N") else (set "RESTART=Y")

rem ==================== 公共：确认执行 ====================
:CONFIRM
cls
echo.
echo  ============================================================
echo    执行前确认
echo  ============================================================
echo    来源      : %SOURCE%
echo    目标      : profile "%PROFILE%"
echo    自动重启  : %RESTART%
echo  ------------------------------------------------------------
echo    将执行    :
echo      install-dsh-plugin.ps1 "%SOURCE%" -Profile %PROFILE%
if "%RESTART%"=="Y" echo                -Restart
echo  ============================================================
choice /c YN /n /m "  确认执行? [Y/N]: "
if errorlevel 2 (
    echo  已取消。
    choice /c Q /n /t 3 /d Q >nul
    goto MENU
)

rem ==================== 执行 ====================
echo.
if "%RESTART%"=="Y" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" "%SOURCE%" -Profile %PROFILE% -Restart
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" "%SOURCE%" -Profile %PROFILE%
)
set "RC=%errorlevel%"

rem ==================== 结果页 ====================
echo.
echo  ============================================================
if "%RC%"=="0" (
    echo    [OK] 安装完成！
    echo  ------------------------------------------------------------
    echo    下一步验证：
    echo     1. 重启 DSH 后看启动日志无 plugin tree 报错
    echo     2. 出现插件 ready 日志（如 memoryContext ready）
    echo     3. 对话中调用插件工具（如 memory_status）确认功能
    echo    卸载方法：dsh plugin --profile %PROFILE% remove ^<插件包名^>
) else (
    echo    [X] 安装失败（退出码 %RC%）
    echo  ------------------------------------------------------------
    echo    常见处理：
    echo     - 构建失败     → 插件目录先 pnpm install 再重试
    echo     - 策略拦截     → 依赖发布过新，稍后重试或清 profile 锁文件
    echo     - 解析失败     → 删 profile 的 node_modules 与 pnpm-lock.yaml 重跑
)
echo  ============================================================
echo.
echo  返回菜单（Q 退出程序）...
choice /c QX /n /t 15 /d Q /m " 15 秒后自动返回; 按 X 退出: "
if errorlevel 2 exit /b 0
goto MENU

rem ==================== 来源 8：帮助 ====================
:OPT8
cls
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Help '%PS1%' -Full"
echo.
choice /c Q /n /t 30 /d Q /m " 看完后回车返回菜单（30 秒自动返回）: "
goto MENU

rem ==================== 来源 9：退出 ====================
:OPT9
exit /b 0

:PICK_AGAIN
echo.
echo  重新选择来源...
choice /c Q /n /t 3 /d Q >nul
goto MENU
