[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Root folder to scan recursively for video files")]
    [string]$Folder,

    [Parameter(Mandatory = $true, Position = 1, HelpMessage = "Target spoken language (e.g., fr, qc, es, ja, zh, it, pt)")]
    [string]$Language,

    [switch]$SkipExisting,

    [string[]]$Extensions = @('.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.wmv')
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PythonScript = Join-Path (Join-Path $ProjectRoot 'python-scripts') 'audio_normalize.py'

if (-not (Test-Path $PythonScript)) {
    Write-Error "Could not locate audio_normalize.py at $PythonScript"
    exit 1
}

if (-not (Test-Path $Folder)) {
    Write-Error "Folder not found: $Folder"
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
Write-Host " VAULT EXPLORER SPOKEN TRANSLATION - RECURSIVE FOLDER RUN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Folder:   $Folder" -ForegroundColor Gray
Write-Host "Language: $Language" -ForegroundColor Gray
Write-Host "Skip:     $($SkipExisting.IsPresent)" -ForegroundColor Gray
Write-Host "Python:   $PythonExe" -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$FilterScript = {
    $ext = $_.Extension.ToLower()
    $Extensions -contains $ext
}

$Files = Get-ChildItem -Path $Folder -Recurse -File | Where-Object $FilterScript | Sort-Object LastWriteTime -Descending
Write-Host "Found $($Files.Count) video file(s) to process (newest first)." -ForegroundColor Gray

$env:PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION = "python"

$Processed = 0
$Skipped = 0

foreach ($File in $Files) {
    $EnhancedDir = Join-Path $File.DirectoryName '.enhanced'
    $OutputPath = Join-Path $EnhancedDir $File.Name

    if ($SkipExisting -and (Test-Path $OutputPath)) {
        Write-Host "[SKIP] $($File.FullName) -> output already exists" -ForegroundColor DarkGray
        $Skipped++
        continue
    }

    $Processed++
    Write-Host "[$Processed/$($Files.Count)] $($File.FullName)" -ForegroundColor Cyan

    $ArgsList = @("-u", $PythonScript, $File.FullName, $Folder, "--translate-to", $Language)

    try {
        & $PythonExe $ArgsList
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "audio_normalize.py exited with code $LASTEXITCODE for $($File.FullName)"
        }
    }
    catch {
        Write-Error "Failed to process $($File.FullName): $_"
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Done. Processed: $Processed, Skipped: $Skipped" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
