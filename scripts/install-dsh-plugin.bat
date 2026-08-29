@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title DSH 插件一键安装

rem ============================================================
rem  DSH 插件安装菜单（封装 install-dsh-plugin.ps1）
rem  放在与 install-dsh-plugin.ps1 同目录，或自动回退到插件仓库
rem ============================================================

set "PS1=%~dp0install-dsh-plugin.ps1"
if not exist "%PS1%" set "PS1=D:\code\上下文精简插件\scripts\install-dsh-plugin.ps1"
if not exist "%PS1%" (
    echo [X] 找不到 install-dsh-plugin.ps1
    pause
    exit /b 1
)

:MENU
cls
echo ============================================================
echo                DSH 插件一键安装
echo ============================================================
echo   [1] 安装当前目录插件        （默认 D:\code\上下文精简插件）
echo   [2] 安装指定本地目录插件    （自动编译打包成 tarball）
echo   [3] 从 GitHub 安装          （github:owner/repo）
echo   [4] 从 npm 安装             （npm:包名）
echo   [5] 从 tarball 安装         （.tgz 文件路径）
echo   [6] 仅编译打包              （npm pack，不安装）
echo   --------------------------------------------------------
echo   [7] 查看脚本帮助            （install-dsh-plugin.ps1 参数说明）
echo   [0] 退出
echo ============================================================

set "PROFILE="
set "RESTART="
set "SOURCE="

choice /c 12345670 /n /m "请选择: "
goto OPT%errorlevel%

:OPT1
set "SOURCE=%CD%"
goto ASK_PROFILE

:OPT2
set /p "SOURCE=  本地插件目录路径: "
if "%SOURCE%"=="" (echo [X] 路径不能为空 & pause & goto MENU)
goto ASK_PROFILE

:OPT3
set /p "REPO=  仓库 (owner/repo): "
if "%REPO%"=="" (echo [X] 不能为空 & pause & goto MENU)
set "SOURCE=github:%REPO%"
goto ASK_PROFILE

:OPT4
set /p "PKG=  npm 包名: "
if "%PKG%"=="" (echo [X] 不能为空 & pause & goto MENU)
set "SOURCE=npm:%PKG%"
goto ASK_PROFILE

:OPT5
set /p "TGZ=  tarball 路径 (.tgz): "
if "%TGZ%"=="" (echo [X] 路径不能为空 & pause & goto MENU)
set "SOURCE=%TGZ%"
goto ASK_PROFILE

:OPT6
set /p "SRC6=  插件目录路径 (回车=当前目录): "
if "%SRC6%"=="" set "SRC6=%CD%"
echo.
echo ==> npm pack ...
pushd "%SRC6%"
call npm pack
set "PACKRC=%errorlevel%"
popd
if not "%PACKRC%"=="0" (echo [X] npm pack 失败) else (echo [OK] tarball 已生成)
echo.
pause
goto MENU

:OPT7
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Help '%PS1%' -Full"
echo.
pause
goto MENU

:ASK_PROFILE
echo.
set /p "PROFILE=  目标 profile (回车=web): "
if "%PROFILE%"=="" set "PROFILE=web"

choice /c YN /n /m "  安装成功后自动重启 DSH? [Y/N] (默认 N): "
if errorlevel 2 (set "RESTART=") else (set "RESTART=-Restart")

echo.
echo ==> 执行: install-dsh-plugin.ps1 "%SOURCE%" -Profile %PROFILE% %RESTART%
echo ------------------------------------------------------------
if "%RESTART%"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" "%SOURCE%" -Profile %PROFILE%
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" "%SOURCE%" -Profile %PROFILE% -Restart
)
echo ------------------------------------------------------------
echo.
echo 执行完毕。退出码 %errorlevel%
pause
goto MENU

:OPT8
exit /b 0
