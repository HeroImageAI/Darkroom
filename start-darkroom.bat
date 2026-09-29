@echo off
title Darkroom
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and try again. & pause & exit /b 1)
if not exist node_modules (
  echo Installing Darkroom dependencies, one moment...
  call npm install || (pause & exit /b 1)
)
call npx tsx scripts\launch.ts
if errorlevel 1 pause
