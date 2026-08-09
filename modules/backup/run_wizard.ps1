# WhatsApp Business archive wizard launcher.
# Ensures a working Python installation exists, then runs wa_archive.py.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$archive = Join-Path $scriptDir "wa_archive.py"

if (-not (Test-Path $archive)) {
    Write-Host "ERROR [E93] wa_archive.py was not found next to this script." -ForegroundColor Red
    exit 1
}

function Get-PythonCommand {
    foreach ($name in @("python", "py")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            # Windows may expose a Store alias that is not a working Python executable
            if ($cmd.Source -and $cmd.Source -like "*WindowsApps*python*.exe") {
                $probe = & $cmd.Source --version 2>$null
                if (-not $probe) { continue }
            }
            return $cmd.Name
        }
    }
    return $null
}

$python = Get-PythonCommand

if (-not $python) {
    Write-Host "Python is not installed. Installing it with winget..." -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR [E94] winget is not available." -ForegroundColor Red
        Write-Host "Install Python 3.12 manually from https://www.python.org/downloads/ and run this script again."
        exit 1
    }
    winget install --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
    $python = Get-PythonCommand
}

if (-not $python) {
    Write-Host "ERROR [E94] Python was installed but is not available on PATH yet." -ForegroundColor Red
    Write-Host "Close and reopen PowerShell, then run this script again."
    exit 1
}

& $python $archive wizard
exit $LASTEXITCODE
