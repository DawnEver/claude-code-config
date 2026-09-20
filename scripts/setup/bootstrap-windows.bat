@echo off
setlocal
title Non-Admin Installer - Rust and Node.js LTS

echo ========================================================
echo   Installing Rust + Node.js LTS (User-level / No Admin)
echo ========================================================
echo.

set "TEMP_DIR=%USERPROFILE%\.dev_installer_temp"
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"
set "NODE_DIR=%USERPROFILE%\nodejs"

echo [1/4] Checking and installing Rust...
where rustc >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Rust is already installed.
    rustc --version
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$temp = [System.Environment]::ExpandEnvironmentVariables('%TEMP_DIR%');" ^
        "$exePath = Join-Path $temp 'rustup-init.exe';" ^
        "Write-Host '[*] Downloading rustup-init.exe...';" ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
        "(New-Object System.Net.WebClient).DownloadFile('https://win.rustup.rs/x86_64', $exePath);" ^
        "Write-Host '[*] Running unattended Rust installation...';" ^
        "& $exePath -y --no-modify-path;" ^
        "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User');" ^
        "$cargoPath = Join-Path $env:USERPROFILE '.cargo\bin';" ^
        "if ($userPath -notlike '*' + $cargoPath + '*') { [Environment]::SetEnvironmentVariable('Path', $userPath + ';' + $cargoPath, 'User') };" ^
        "Write-Host '[OK] Rust installed successfully.'"
)
echo.

echo [2/4] Checking and installing Node.js LTS...
where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Node.js is already installed.
    node -v
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ErrorActionPreference = 'Stop';" ^
        "$temp = [System.Environment]::ExpandEnvironmentVariables('%TEMP_DIR%');" ^
        "$nodeDir = [System.Environment]::ExpandEnvironmentVariables('%NODE_DIR%');" ^
        "Write-Host '[*] Fetching latest Node.js LTS release info...';" ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
        "$index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json';" ^
        "$lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1;" ^
        "$ver = $lts.version;" ^
        "$zipName = 'node-' + $ver + '-win-x64.zip';" ^
        "$url = 'https://nodejs.org/dist/' + $ver + '/' + $zipName;" ^
        "$zipPath = Join-Path $temp $zipName;" ^
        "Write-Host ('[*] Downloading Node.js ' + $ver + '...');" ^
        "(New-Object System.Net.WebClient).DownloadFile($url, $zipPath);" ^
        "Write-Host '[*] Extracting files...';" ^
        "if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir };" ^
        "Expand-Archive -Path $zipPath -DestinationPath $temp -Force;" ^
        "Move-Item -Path (Join-Path $temp ('node-' + $ver + '-win-x64')) -Destination $nodeDir;" ^
        "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User');" ^
        "if ($userPath -notlike '*' + $nodeDir + '*') { [Environment]::SetEnvironmentVariable('Path', $userPath + ';' + $nodeDir, 'User') };" ^
        "Write-Host '[OK] Node.js installed successfully.'"
)
echo.

echo [3/4] Cleaning up temporary files...
if exist "%TEMP_DIR%" rd /s /q "%TEMP_DIR%"
echo [OK] Cleaned temporary directory.
echo.

echo [4/4] Verifying installations...
set "PATH=%USERPROFILE%\.cargo\bin;%USERPROFILE%\nodejs;%PATH%"

echo --------------------------------------------------------
where rustc >nul 2>nul && (rustc --version) || (echo [!] rustc not found)
where cargo >nul 2>nul && (cargo --version) || (echo [!] cargo not found)
where node >nul 2>nul && (node -v) || (echo [!] node not found)
where npm >nul 2>nul && (npm -v) || (echo [!] npm not found)
echo --------------------------------------------------------
echo.
echo All steps completed!
echo Please restart PowerShell / VS Code for the PATH changes to take effect.
echo.
pause