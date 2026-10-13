@echo off
chcp 65001 >nul
title LifeBoard 生成局域网证书
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-cert.ps1"
if errorlevel 1 (
  echo.
  echo   生成失败。可以把上面的信息发给我看看。
)
echo.
pause
