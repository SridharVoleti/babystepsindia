@echo off
cd /d "%~dp0"
if not exist ".env.local" (
    echo .env.local not found - copying .env.local.example
    copy .env.local.example .env.local >nul
)
start "" http://localhost:3000
call npm run dev
