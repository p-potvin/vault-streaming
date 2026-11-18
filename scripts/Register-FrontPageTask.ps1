# Registers "\VaultWares\Vault Streaming Front Page": scripts/ingest-front-page.js at 06:30 and 18:30, hidden
# (conhost --headless). Each run makes at most 1500 TMDB requests, 4 per second, no retries (see the script).
# Log: %LOCALAPPDATA%\VaultWares\vault-streaming\front-page-ingest.log
# Stop: Disable-ScheduledTask -TaskPath "\VaultWares\" -TaskName "Vault Streaming Front Page"
# Remove: Unregister-ScheduledTask -TaskPath "\VaultWares\" -TaskName "Vault Streaming Front Page" -Confirm:$false
$runner = Join-Path $PSScriptRoot "Run-FrontPageIngest.ps1"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless pwsh.exe -NoProfile -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At "06:30"),
    (New-ScheduledTaskTrigger -Daily -At "18:30")
)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskPath "\VaultWares\" -TaskName "Vault Streaming Front Page" -Action $action -Trigger $triggers `
    -Settings $settings -Description "vault-streaming: copies TMDB's trending and provider pages into the vault-raggae catalog (Discover). Log %LOCALAPPDATA%\VaultWares\vault-streaming\front-page-ingest.log" `
    -Force | Out-Null
"registered \VaultWares\Vault Streaming Front Page (06:30, 18:30)"
