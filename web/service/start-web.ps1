# start-web.ps1 — launch the Vault Streaming web client as a persistent service.
#
# Run by the "VaultStreamingWeb" scheduled task at boot. greencloud's nginx is the
# only intended front door; it injects the auth token so viewers never handle it.
#
# Binds 0.0.0.0, NOT the Tailscale address. Tailscale on Windows hands inbound
# peer connections to a local proxy, so a socket bound only to 100.71.101.21
# never sees them — verified: peers reached a 0.0.0.0 listener on 8787 while an
# identical service bound to the tailnet IP on 8722 was refused. Reachability is
# therefore fenced by the "Vault Streaming web (tailnet)" firewall rule
# (inbound 8722 allowed only from 100.64.0.0/10) plus the VW_WEB_TOKEN gate,
# rather than by the bind address.
#
# Tailscale is still waited for: nothing can reach this until the tailnet is up,
# and starting after it keeps the log honest about when the service went live.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LogDir = Join-Path $env:LOCALAPPDATA 'VaultStreaming'
$LogFile = Join-Path $LogDir 'web-server.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'ddd, dd MMM yyyy HH:mm'), $msg
    Add-Content -Path $LogFile -Value $line
}

$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$tailnetIp = $null
for ($i = 0; $i -lt 60; $i++) {
    try {
        $candidate = (& $tailscale ip -4 2>$null | Select-Object -First 1)
        if ($candidate -match '^\d+\.\d+\.\d+\.\d+$') { $tailnetIp = $candidate.Trim(); break }
    } catch { }
    Start-Sleep -Seconds 5
}

if (-not $tailnetIp) {
    Write-Log 'FATAL: Tailscale address never appeared after 5 minutes; not starting.'
    exit 1
}

Write-Log "Tailnet up ($tailnetIp); starting web client on 0.0.0.0:8722 (repo: $RepoRoot)"

# VW_WEB_TOKEN and the rest come from the repo .env, which server.js loads itself.
$env:VW_WEB_HOST = '0.0.0.0'

Set-Location $RepoRoot
& node "web/server.js" *>> $LogFile

Write-Log "Server exited with code $LASTEXITCODE"
exit $LASTEXITCODE
