@echo off
cd /d "%~dp0"

if not exist ".env.local" (
    echo .env.local not found - copying .env.local.example
    copy .env.local.example .env.local >nul
)

echo.
echo === Running tests (IA-001 + existing suite) ===
call npm test
if errorlevel 1 (
    echo.
    echo Tests failed - aborting before launch.
    pause
    exit /b 1
)

echo.
echo === Type-checking ===
call npm run typecheck
if errorlevel 1 (
    echo.
    echo Type check failed - aborting before launch.
    pause
    exit /b 1
)

echo.
echo === Validation passed - starting dev server ===
start "" http://localhost:3000
call npm run dev
