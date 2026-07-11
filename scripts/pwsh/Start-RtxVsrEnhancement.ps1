[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Root folder to scan recursively for video files")]
    [string]$Folder,

    [ValidateSet("LOW", "MEDIUM", "HIGH", "ULTRA")]
    [string]$Quality = "HIGH",

    [double]$Scale = 2.0,

    [ValidateSet("yuv420p", "yuv444p")]
    [string]$Chroma = "yuv420p",

    [switch]$SkipExisting,

    [string[]]$Extensions = @('.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv')
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$CanonicalProjectRoot = "C:\Users\Administrator\Desktop\Github Repos\vault-explorer"
$PythonScript = Join-Path (Join-Path $ProjectRoot 'python-scripts') 'rtx_vsr_stream.py'

if (-not (Test-Path $PythonScript)) {
    Write-Error "Could not locate rtx_vsr_stream.py at $PythonScript.\n Falling back to $CanonicalProjectRoot"
    $ProjectRoot = $CanonicalProjectRoot;
	$PythonScript = Join-Path (Join-Path $ProjectRoot 'python-scripts') 'rtx_vsr_stream.py'
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
Write-Host " VAULT EXPLORER RTX VSR ENHANCEMENT - RECURSIVE FOLDER RUN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Folder:  $Folder" -ForegroundColor Gray
Write-Host "Quality: $Quality" -ForegroundColor Gray
Write-Host "Scale:   $Scale" -ForegroundColor Gray
Write-Host "Chroma:  $Chroma" -ForegroundColor Gray
Write-Host "Skip:    $($SkipExisting.IsPresent)" -ForegroundColor Gray
Write-Host "Python:  $PythonExe" -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$FilterScript = {
    $ext = $_.Extension.ToLower()
    $Extensions -contains $ext
}

$Files = Get-ChildItem -Path $Folder -Recurse -File | Where-Object $FilterScript | Sort-Object LastWriteTime -Descending
Write-Host "Found $($Files.Count) video file(s) to process (newest first)." -ForegroundColor Gray

$Processed = 0
$Skipped = 0

foreach ($File in $Files) {
    $EnhancedDir = Join-Path $File.DirectoryName '.enhanced'
    $BaseName = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
    $OutputPath = Join-Path $EnhancedDir "$BaseName`_vsr.mp4"

    if ($SkipExisting -and (Test-Path $OutputPath)) {
        Write-Host "[SKIP] $($File.FullName) -> output already exists" -ForegroundColor DarkGray
        $Skipped++
        continue
    }

    if (-not (Test-Path $EnhancedDir)) {
        New-Item -ItemType Directory -Path $EnhancedDir -Force | Out-Null
    }

    $Processed++
    Write-Host "[$Processed/$($Files.Count)] $($File.FullName) -> $OutputPath" -ForegroundColor Cyan

    $ArgsList = @("-u", $PythonScript, "enhance", $File.FullName, $OutputPath, "--quality", $Quality, "--scale", $Scale, "--chroma", $Chroma)

    try {
        & $PythonExe $ArgsList
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "rtx_vsr_stream.py exited with code $LASTEXITCODE for $($File.FullName)"
        }
    }
    catch {
        Write-Error "Failed to process $($File.FullName): $_"
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Done. Processed: $Processed, Skipped: $Skipped" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
