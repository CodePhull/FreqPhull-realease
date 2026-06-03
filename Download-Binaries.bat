@echo off
title FREQ.PULL — Download Build Binaries
color 0B
echo.
echo  =============================================
echo   FREQ.PULL — Fetching yt-dlp + ffmpeg
echo   These get bundled into the .exe installer
echo  =============================================
echo.

if not exist "bin" mkdir bin

:: ── yt-dlp ──────────────────────────────────────────────────────────────────
echo  [*] Downloading yt-dlp.exe...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe' -UseBasicParsing"
if exist "bin\yt-dlp.exe" (
    echo  [OK] yt-dlp.exe
) else (
    echo  [WARN] PowerShell failed, trying curl...
    curl -L -o "bin\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    if exist "bin\yt-dlp.exe" (echo  [OK] yt-dlp.exe via curl) else (echo  [ERROR] Failed to download yt-dlp.exe)
)

:: ── ffmpeg ───────────────────────────────────────────────────────────────────
echo  [*] Downloading ffmpeg (~80MB, may take a minute)...

:: Write a proper ps1 script to temp so we avoid inline quoting issues
set PS_SCRIPT=%TEMP%\freqpull-ffmpeg-dl.ps1
(
echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
echo $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
echo $zip = "$env:TEMP\ffmpeg-freqpull.zip"
echo $out = "$env:TEMP\ffmpeg-freqpull-extract"
echo Write-Host "  Downloading zip..."
echo Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
echo Write-Host "  Extracting..."
echo Expand-Archive -Path $zip -DestinationPath $out -Force
echo $fe = Get-ChildItem $out -Recurse -Filter 'ffmpeg.exe'  ^| Select-Object -First 1
echo $fp = Get-ChildItem $out -Recurse -Filter 'ffprobe.exe' ^| Select-Object -First 1
echo if ^($fe^) { Copy-Item $fe.FullName -Destination 'bin\ffmpeg.exe'  -Force; Write-Host "  Copied ffmpeg.exe" }
echo if ^($fp^) { Copy-Item $fp.FullName -Destination 'bin\ffprobe.exe' -Force; Write-Host "  Copied ffprobe.exe" }
echo Remove-Item $zip -Force -ErrorAction SilentlyContinue
echo Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
) > "%PS_SCRIPT%"

powershell -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
del "%PS_SCRIPT%" 2>nul

if exist "bin\ffmpeg.exe" (
    echo  [OK] ffmpeg.exe
) else (
    echo  [WARN] PowerShell failed, trying curl + 7zip fallback...
    curl -L -o "%TEMP%\ffmpeg-freqpull.zip" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    if exist "%TEMP%\ffmpeg-freqpull.zip" (
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Expand-Archive '%TEMP%\ffmpeg-freqpull.zip' '%TEMP%\ffmpeg-freqpull-extract' -Force; $f=Get-ChildItem '%TEMP%\ffmpeg-freqpull-extract' -Recurse -Filter ffmpeg.exe | Select -First 1; if($f){Copy-Item $f.FullName bin\ffmpeg.exe -Force}; $p=Get-ChildItem '%TEMP%\ffmpeg-freqpull-extract' -Recurse -Filter ffprobe.exe | Select -First 1; if($p){Copy-Item $p.FullName bin\ffprobe.exe -Force}"
    )
    if exist "bin\ffmpeg.exe" (echo  [OK] ffmpeg.exe via curl) else (echo  [ERROR] Failed to download ffmpeg.exe)
)

if not exist "bin\ffprobe.exe" (
    echo  [WARN] ffprobe.exe missing — re-run this script or copy manually from the ffmpeg zip
)

echo.
echo  Contents of bin\:
dir /b bin\
echo.
echo  =============================================
echo   Done! Now run:  npm install  then  npm start
echo  =============================================
echo.
pause
