@echo off
setlocal
cd /d "%~dp0"
if not exist "tools\deno\deno.exe" (
  if not exist "tools\deno" mkdir "tools\deno"
  curl.exe --fail --location --retry 2 --output "tools\deno.zip" "https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip"
  if errorlevel 1 exit /b 1
  powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('tools\deno.zip', 'tools\deno')"
  if errorlevel 1 exit /b 1
)
if not exist "tools\ffmpeg.exe" (
  curl.exe --fail --location --retry 2 --output "tools\ffmpeg.exe.part" "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64"
  if errorlevel 1 exit /b 1
  move /y "tools\ffmpeg.exe.part" "tools\ffmpeg.exe" >nul
)
if not exist "build" mkdir "build"
if "%~1"=="bun-test" goto setup_bun
if "%~1"=="bun-native" goto setup_bun
if "%~1"=="bun-archives" goto setup_bun
if "%~1"=="bun-smoke" goto setup_bun
if "%~1"=="package-test" goto setup_bun
goto after_bun
:setup_bun
if not exist "tools\bun\bun-windows-x64\bun.exe" (
  if not exist "tools\bun" mkdir "tools\bun"
  curl.exe --fail --location --retry 2 --output "tools\bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-windows-x64.zip"
  if errorlevel 1 exit /b 1
  powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $hash=(Get-FileHash -LiteralPath 'tools/bun.zip' -Algorithm SHA256).Hash.ToLowerInvariant(); if ($hash -ne '0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d') { throw 'Bun SHA-256 mismatch' }; Expand-Archive -LiteralPath 'tools/bun.zip' -DestinationPath 'tools/bun' -Force"
  if errorlevel 1 exit /b 1
)
:after_bun
if "%~1"=="indra-reference" (
  if not exist "tools\uv\uv.exe" (
    if not exist "tools\uv" mkdir "tools\uv"
    curl.exe --fail --location --retry 2 --output "tools\uv.zip" "https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-pc-windows-msvc.zip"
    if errorlevel 1 exit /b 1
    powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $hash=[Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes('tools\uv.zip')); if ([BitConverter]::ToString($hash).Replace('-','').ToLowerInvariant() -ne '3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672') { throw 'uv SHA-256 mismatch' }; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('tools\uv.zip', 'tools\uv')"
    if errorlevel 1 exit /b 1
  )
  set "UV_CACHE_DIR=%CD%\build\uv-cache"
  set "UV_PYTHON_INSTALL_DIR=%CD%\build\python"
)
set "DENO_DIR=%CD%\build\deno-cache"
set "XBERG_CACHE_DIR=%CD%\build\models\xberg"
"tools\deno\deno.exe" run --no-config --node-modules-dir=auto -A "tests\run-matrix.js" %*
exit /b %errorlevel%
