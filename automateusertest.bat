@echo off
setlocal
title BabySteps - Automated User Test
cd /d "%~dp0"

echo ============================================================
echo   BabySteps automated user test
echo   A Chrome window will open and drive the site by itself.
echo   This console shows each test, each check, and PASS / FAIL.
echo ============================================================
echo.

if not exist ".env.e2e.local" (
  echo ERROR: .env.e2e.local not found. It holds E2E_EMAIL / E2E_PASSWORD / E2E_BASE_URL.
  pause
  exit /b 2
)

if not exist "node_modules\@playwright\test" (
  echo Installing test tooling first...
  call npm install || goto :fail
)
call npx playwright install chromium >nul 2>&1

rem Optional: pass a test-name filter, e.g.  automateusertest.bat "Login"
set FILTER=
if not "%~1"=="" set FILTER=-g "%~1"

call npx playwright test %FILTER%
set RESULT=%ERRORLEVEL%

echo.
if "%RESULT%"=="0" (
  echo ===== RESULT: ALL TESTS PASSED =====
) else (
  echo ===== RESULT: SOME TESTS FAILED  (screenshots + traces in e2e-results\) =====
)
echo.
set /p OPEN="Open the detailed HTML report now? (Y/N) "
if /i "%OPEN%"=="Y" call npx playwright show-report e2e-report
exit /b %RESULT%

:fail
echo Setup failed.
pause
exit /b 1
