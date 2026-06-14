@echo off
setlocal EnableDelayedExpansion
title FREQ.PHULL — Download Build Binaries
color 0B
echo.
echo  =============================================
echo   FREQ.PHULL — Fetching yt-dlp + ffmpeg
echo   These get bundled into the .exe installer
echo  =============================================
echo.

if not exist "bin" mkdir bin

REM ── yt-dlp ──────────────────────────────────────────────────────────────────
echo  [*] Downloading yt-dlp.exe (~17 MB)...
call :download_with_validation ^
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" ^
    "bin\yt-dlp.exe" ^
    10000000
if errorlevel 1 (
    echo  [ERROR] yt-dlp.exe download failed. Manual fix:
    echo          1. Open https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
    echo          2. Save the file as bin\yt-dlp.exe
)

REM ── ffmpeg ──────────────────────────────────────────────────────────────────
echo.
echo  [*] Downloading ffmpeg zip (~100 MB, may take a minute)...

set "FFZIP=%TEMP%\freqphull-ffmpeg.zip"
set "FFOUT=%TEMP%\freqphull-ffmpeg-extract"

REM Source 1: BtbN
call :download_with_validation ^
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" ^
    "%FFZIP%" ^
    50000000
if not errorlevel 1 goto extract_ffmpeg

REM Source 2: gyan.dev (different CDN)
echo  [WARN] BtbN failed, trying gyan.dev...
call :download_with_validation ^
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" ^
    "%FFZIP%" ^
    20000000
if not errorlevel 1 goto extract_ffmpeg

echo.
echo  [ERROR] Both ffmpeg sources failed. This is usually caused by:
echo          - Antivirus blocking the download
echo          - Corporate firewall / ISP intercepting the connection
echo          - Temporary GitHub/CDN outage
echo.
echo  Manual fix:
echo    1. Open one of these URLs in your browser:
echo       https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip
echo       https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
echo    2. Extract the zip
echo    3. Copy ffmpeg.exe and ffprobe.exe (in the bin\ subfolder) into:
echo       %CD%\bin\
echo.
goto :summary

:extract_ffmpeg
echo  [*] Extracting ffmpeg...
if exist "%FFOUT%" rd /s /q "%FFOUT%" 2>nul

REM Test zip validity before trying to extract.
powershell -ExecutionPolicy Bypass -Command ^
    "try { Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('%FFZIP%'); $z.Dispose(); exit 0 } catch { Write-Host ('Zip validation failed: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
    echo  [ERROR] Downloaded file is not a valid zip ^(probably an HTML error page^).
    echo          Check %FFZIP% — if it's tiny ^(under 1MB^), the download was blocked.
    del "%FFZIP%" 2>nul
    goto :summary
)

powershell -ExecutionPolicy Bypass -Command ^
    "Expand-Archive -Path '%FFZIP%' -DestinationPath '%FFOUT%' -Force"
if errorlevel 1 (
    echo  [ERROR] Extraction failed despite valid zip header. Try again or extract manually.
    goto :summary
)

REM Copy the binaries from wherever they ended up in the extracted tree.
powershell -ExecutionPolicy Bypass -Command ^
    "$fe = Get-ChildItem '%FFOUT%' -Recurse -Filter 'ffmpeg.exe'  | Select -First 1;" ^
    "$fp = Get-ChildItem '%FFOUT%' -Recurse -Filter 'ffprobe.exe' | Select -First 1;" ^
    "if ($fe) { Copy-Item $fe.FullName -Destination 'bin\ffmpeg.exe'  -Force; Write-Host ('  Copied ffmpeg.exe  (' + [Math]::Round($fe.Length/1MB,1) + ' MB)') }" ^
    "else     { Write-Host '  WARN: ffmpeg.exe not found in zip' };" ^
    "if ($fp) { Copy-Item $fp.FullName -Destination 'bin\ffprobe.exe' -Force; Write-Host ('  Copied ffprobe.exe (' + [Math]::Round($fp.Length/1MB,1) + ' MB)') }" ^
    "else     { Write-Host '  WARN: ffprobe.exe not found in zip' }"

del "%FFZIP%" 2>nul
rd /s /q "%FFOUT%" 2>nul

:summary
echo.
echo  =============================================
echo  Contents of bin\:
dir /b bin\ 2>nul
echo.
if exist "bin\yt-dlp.exe"  (echo   [OK]   yt-dlp.exe)  else (echo   [MISS] yt-dlp.exe)
if exist "bin\ffmpeg.exe"  (echo   [OK]   ffmpeg.exe)  else (echo   [MISS] ffmpeg.exe)
if exist "bin\ffprobe.exe" (echo   [OK]   ffprobe.exe) else (echo   [MISS] ffprobe.exe)
echo  =============================================
echo.
if exist "bin\yt-dlp.exe" if exist "bin\ffmpeg.exe" if exist "bin\ffprobe.exe" (
    echo   All binaries present. Run:  npm install  then  npm start
) else (
    echo   Some binaries missing. See instructions above for manual download.
)
echo.
pause
exit /b 0

REM ============================================================================
REM Subroutine: download_with_validation URL OUTFILE MIN_SIZE_BYTES
REM ============================================================================
:download_with_validation
set "DL_URL=%~1"
set "DL_OUT=%~2"
set "DL_MIN=%~3"

if exist "%DL_OUT%" del "%DL_OUT%" 2>nul

REM Try 1: PowerShell
echo    Trying PowerShell...
powershell -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
    "try { Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%DL_OUT%' -UseBasicParsing -TimeoutSec 120 } catch { Write-Host ('    PS error: ' + $_.Exception.Message); exit 1 }" ^
    2>nul

if exist "%DL_OUT%" call :check_size "%DL_OUT%" %DL_MIN% && goto :download_ok

REM Try 2: curl with explicit follow-redirects + fail-on-error
echo    PowerShell failed or file too small, trying curl...
if exist "%DL_OUT%" del "%DL_OUT%" 2>nul
curl -L -f --retry 3 --retry-delay 2 --connect-timeout 30 -o "%DL_OUT%" "%DL_URL%" 2>nul

if exist "%DL_OUT%" call :check_size "%DL_OUT%" %DL_MIN% && goto :download_ok

if exist "%DL_OUT%" (
    for %%A in ("%DL_OUT%") do echo    Downloaded file is only %%~zA bytes ^(expected %DL_MIN%+^) — looks like a stub/error page
    del "%DL_OUT%" 2>nul
)
exit /b 1

:download_ok
for %%A in ("%DL_OUT%") do echo    OK — got %%~zA bytes
exit /b 0

:check_size
for %%A in (%1) do if %%~zA LSS %2 exit /b 1
exit /b 0
