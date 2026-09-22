@echo off
setlocal EnableDelayedExpansion
REM ===================================================================
REM  Freq.Phull check runner - Windows native
REM
REM  gauntlet.sh needs bash (Git Bash / WSL). Where that is not on PATH,
REM  this runs the same regression tests through plain node and gives a
REM  pass/fail summary.
REM
REM  What this does NOT cover: the gauntlet's python3 static guards, which
REM  re-assert that specific constants and wiring are still present in the
REM  source. The node tests below carry the actual regression logic; the
REM  python blocks are a second belt on top. Install Git Bash if you want
REM  the full 107.
REM
REM  No 'pause' at the end - this is meant to be runnable from CI and from
REM  a terminal without blocking. Double-clicking it will close the window
REM  when done; run it from cmd to read the output.
REM ===================================================================

cd /d "%~dp0"

echo.
echo ==== syntax ====
set SYNTAX_FAIL=0
for %%F in (server.js main.js preload.js integrity.js prebuild.js renderer\app.js) do (
  node -c "%%F" 2>nul
  if errorlevel 1 (
    echo   FAIL  %%F
    node -c "%%F"
    set SYNTAX_FAIL=1
  ) else (
    echo   ok    %%F
  )
)

echo.
echo ==== extension syntax ====
for %%F in (extension\background.js extension\content.js extension\panel.js) do (
  if exist "%%F" (
    node -c "%%F" 2>nul
    if errorlevel 1 (
      echo   FAIL  %%F
      node -c "%%F"
      set SYNTAX_FAIL=1
    ) else (
      echo   ok    %%F
    )
  )
)

REM JSON validation deliberately removed.
REM
REM It was done with `node -e "...readFileSync('extension\manifest.json')..."`,
REM where cmd hands the path straight into a JS string literal and \m is eaten
REM as an escape - node then looked for 'extensionmanifest.json', failed, and
REM the check reported a perfectly valid manifest as broken. Quoting around
REM that in batch is a swamp, and it is redundant anyway: test-ext-crossbrowser
REM .js JSON.parse()s the manifest and package.json is parsed by npm and by
REM electron-builder on every build. A broken one cannot get past those.
REM
REM A check that cries wolf is worse than no check - it trains you to ignore
REM red, which is the opposite of what this file is for.

echo.
echo ==== regression tests ====
set PASS=0
set FAIL=0
set FAILED_LIST=
for %%F in (tools\test-*.js) do (
  node "tools\%%~nxF" >"%TEMP%\fp_check_out.txt" 2>&1
  if errorlevel 1 (
    echo   FAIL  %%~nxF
    type "%TEMP%\fp_check_out.txt"
    echo.
    set /a FAIL+=1
    set FAILED_LIST=!FAILED_LIST! %%~nxF
  ) else (
    echo   ok    %%~nxF
    set /a PASS+=1
  )
)
del "%TEMP%\fp_check_out.txt" 2>nul

echo.
echo ==== python analysis tests (optional) ====
python tools\test-analyze.py >"%TEMP%\fp_py_out.txt" 2>&1
if errorlevel 1 (
  echo   skipped or failed - see below. Not counted: needs python on PATH
  echo   with numpy/scipy/sklearn, which the app keeps in its own runtime.
  type "%TEMP%\fp_py_out.txt"
) else (
  echo   ok    test-analyze.py
)
del "%TEMP%\fp_py_out.txt" 2>nul

echo.
echo ===================================================================
echo   syntax:  %SYNTAX_FAIL% failure group^(s^)   ^(0 = clean^)
echo   tests:   %PASS% passed, %FAIL% failed
if not "%FAILED_LIST%"=="" echo   failed:  %FAILED_LIST%
echo ===================================================================
echo.

if %SYNTAX_FAIL% NEQ 0 exit /b 1
if %FAIL% NEQ 0 exit /b 1
echo   ALL CHECKS PASSED
exit /b 0
