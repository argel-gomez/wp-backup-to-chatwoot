# Lanzador del asistente de archivo de WhatsApp Business.
# Garantiza que exista un Python funcional y despues delega en wa_archive.py,
# que a su vez instala sus propias dependencias de pip si faltan.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$archive = Join-Path $scriptDir "wa_archive.py"

if (-not (Test-Path $archive)) {
    Write-Host "ERROR [E93] no se encuentra wa_archive.py junto a este script." -ForegroundColor Red
    exit 1
}

function Get-PythonCommand {
    foreach ($name in @("python", "py")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            # en Windows hay un alias de la Store que no es un Python real
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
    Write-Host "Python no esta instalado. Instalandolo con winget..." -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR [E94] winget no esta disponible." -ForegroundColor Red
        Write-Host "Instala Python 3.12 manualmente desde https://www.python.org/downloads/ y volve a correr este script."
        exit 1
    }
    winget install --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
    $python = Get-PythonCommand
}

if (-not $python) {
    Write-Host "ERROR [E94] Python se instalo pero todavia no se ve en el PATH." -ForegroundColor Red
    Write-Host "Cerra y volve a abrir PowerShell, despues corre este script de nuevo."
    exit 1
}

& $python $archive wizard
exit $LASTEXITCODE
