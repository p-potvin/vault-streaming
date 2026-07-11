[CmdletBinding()]
param(
    [Parameter(Position = 0, HelpMessage = "Optional: audio file or folder to benchmark. If omitted, runs the synthetic 10s benchmark.")]
    [string]$Path,

    [switch]$Native,

    [switch]$ForceSimulation
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PythonScript = Join-Path (Join-Path $ProjectRoot 'python-scripts') 'benchmark_asr.py'

if (-not (Test-Path $PythonScript)) {
    Write-Error "Could not locate benchmark_asr.py at $PythonScript"
    exit 1
}

$VenvCandidates = @(
    (Join-Path $ProjectRoot '.venv\Scripts\python.exe'),
    "C:\Users\Administrator\Desktop\Github Repos\vault-explorer\.venv\Scripts\python.exe"
)

$PythonExe = "python"
foreach ($Candidate in $VenvCandidates) {
    if (Test-Path $Candidate) {
        $PythonExe = $Candidate
        break
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " VAULT EXPLORER ASR BENCHMARK RUNNER" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Python: $PythonExe" -ForegroundColor Gray
if ($Path) { Write-Host "Path:   $Path" -ForegroundColor Gray }
Write-Host "Native mode:   $($Native.IsPresent)" -ForegroundColor Gray
Write-Host "Force simulation: $($ForceSimulation.IsPresent)" -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$ArgsList = @("-u", $PythonScript)
if ($Native) { $ArgsList += "--native" }
if ($ForceSimulation) { $ArgsList += "--force-simulation" }

# benchmark_asr.py is self-contained and creates a synthetic 10s WAV internally.
# If a folder is provided, run the benchmark once per audio file found.
if ($Path -and (Test-Path $Path)) {
    if ((Get-Item $Path) -is [System.IO.FileInfo]) {
        # Single file: still run the synthetic benchmark; it doesn't consume an external file yet.
        Write-Host "Path is a file. Running the standard synthetic benchmark (external file input is not supported by benchmark_asr.py)." -ForegroundColor Yellow
    }
    else {
        $AudioFiles = Get-ChildItem -Path $Path -Recurse -File -Include *.wav,*.mp3,*.flac,*.m4a,*.ogg | Sort-Object LastWriteTime -Descending
        Write-Host "Found $($AudioFiles.Count) audio file(s). benchmark_asr.py uses synthetic audio, so running one benchmark pass." -ForegroundColor Gray
    }
}

& $PythonExe $ArgsList

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "ASR benchmark run finished." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
