# Runs scripts/ingest-front-page.js once and appends its output to the log. Called by the scheduled task
# "\VaultWares\Vault Streaming Front Page" (scripts/Register-FrontPageTask.ps1).
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA "VaultWares\vault-streaming"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "front-page-ingest.log"
$stamp = Get-Date -Format "ddd, dd MMM yyyy HH:mm"
Add-Content -Path $log -Value "---- $stamp"
Push-Location $repo
try {
    & node "scripts\ingest-front-page.js" 2>&1 | Add-Content -Path $log
    Add-Content -Path $log -Value "exit $LASTEXITCODE"
} finally {
    Pop-Location
}
