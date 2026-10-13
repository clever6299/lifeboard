@echo off
chcp 65001 >nul
title LifeBoard 本地服务
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。请先安装 Node.js（https://nodejs.org），
  echo   或者直接使用 GitHub Pages 上的网址，不需要本地服务。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 LifeBoard 本地服务...
echo   浏览器会自动打开 http://localhost:5173
echo.

start "" http://localhost:5173
node server.js

echo.
echo   服务已停止。
pause
