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
$LogDir = Join-Path $RepoRoot 'logs'
$LogFile = Join-Path $LogDir 'web-server.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'ddd, dd MMM yyyy HH:mm'), $msg
    Add-Content -Path $LogFile -Value $line
}

trap {
    try { Write-Log "FATAL: $($_.Exception.Message)" } catch { }
    exit 1
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

# Reclaim the port before starting. Stop-ScheduledTask kills this wrapper but not
# the node child it spawned, so a "restart" would leave the old server holding
# 8722 while the new one died on EADDRINUSE — the service looked restarted while
# still running the previous configuration (observed: relaxed source limits in
# .env silently had no effect for 40 minutes).
$portOwners = (netstat -ano | Select-String ':8722\s.*LISTENING') |
    ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique
foreach ($owner in $portOwners) {
    try {
        Write-Log "Killing stale listener on 8722 (pid $owner)"
        Stop-Process -Id $owner -Force -ErrorAction Stop
    } catch { Write-Log "Could not kill pid ${owner}: $_" }
}
if ($portOwners) { Start-Sleep -Seconds 2 }

# Stop-ScheduledTask ends only the process the task launched (conhost); this script, cmd and node then carried on
# without it, node still holding 8722 (Sat, 21 Nov 2026: the task said "Ready" while the server ran on). Two guards:
#  1. a kill-on-close job object holding this script: everything it starts (cmd, node, node's ffmpeg / yt-dlp) is in
#     it, and Windows ends them all when this script ends, however it ends;
#  2. this script ends when the process that launched it does (checked every 2 s while the server runs).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VwKillOnCloseJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic BasicLimits; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    static IntPtr handle;   // kept open for this process's life: closing it is what ends the job's processes
    public static string Join() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return "CreateJobObject failed " + Marshal.GetLastWin32Error();
        var ext = new Extended();
        ext.BasicLimits.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int len = Marshal.SizeOf(typeof(Extended));
        IntPtr p = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(ext, p, false);
            if (!SetInformationJobObject(handle, 9, p, (uint)len)) return "SetInformationJobObject failed " + Marshal.GetLastWin32Error();
        } finally { Marshal.FreeHGlobal(p); }
        if (!AssignProcessToJobObject(handle, GetCurrentProcess())) return "AssignProcessToJobObject failed " + Marshal.GetLastWin32Error();
        return null;
    }
}
'@
$jobError = [VwKillOnCloseJob]::Join()
if ($jobError) { Write-Log "Job object not set ($jobError): a stopped task may leave node running" }

$launcherPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$launcher = Get-Process -Id $launcherPid -ErrorAction SilentlyContinue
function Test-LauncherGone { return ($launcher -and $launcher.HasExited) }

# Supervise rather than exit. The server has died mid-session at least once (an
# unhandled rejection out of a trailer/yt-dlp path took the process with it), and
# a scheduled task that simply ends leaves the site down until someone notices.
# Restart with a short backoff; give up only if it is crash-looping, which means
# something is genuinely broken rather than transient.
$backoff = 2
$recentFailures = 0
$lastStart = Get-Date

while ($true) {
    # Keep the child attached through cmd redirection. A PowerShell pipeline to
    # Out-File can throw a broken-pipe console error under a detached conhost
    # task and terminate this supervisor after the child exits.
    $psi = [System.Diagnostics.ProcessStartInfo]::new('cmd.exe', "/d /c `"node web/server.js >> `"$LogFile`" 2>&1`"")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $RepoRoot
    $server = [System.Diagnostics.Process]::Start($psi)
    while (-not $server.WaitForExit(2000)) {
        if (Test-LauncherGone) {
            # the task was stopped: end here, and the job object ends cmd, node and their children with us
            Write-Log 'Task stopped (launcher gone); stopping the server.'
            exit 0
        }
    }
    $code = $server.ExitCode
    $ranFor = (Get-Date) - $lastStart

    Write-Log "Server exited with code $code after $([int]$ranFor.TotalSeconds)s"

    if ($ranFor.TotalSeconds -lt 60) { $recentFailures++ } else { $recentFailures = 0; $backoff = 2 }
    if ($recentFailures -ge 5) {
        Write-Log 'FATAL: five failures inside a minute each — crash loop, not restarting.'
        exit 1
    }

    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 60)
    $lastStart = Get-Date
    Write-Log 'Restarting server...'
}
