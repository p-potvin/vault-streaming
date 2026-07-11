[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Root folder to scan recursively for video files")]
    [string]$Folder
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PythonScript = Join-Path (Join-Path $ProjectRoot 'python-scripts') 'generate_previews.py'

if (-not (Test-Path $PythonScript)) {
    Write-Error "Could not locate generate_previews.py at $PythonScript"
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
Write-Host " VAULT EXPLORER PREVIEW GENERATOR - RECURSIVE FOLDER RUN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Folder: $Folder" -ForegroundColor Gray
Write-Host "Python: $PythonExe" -ForegroundColor Gray
Write-Host "Note:  python-script now sorts videos by date modified (newest first)." -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$ArgsList = @("-u", $PythonScript, $Folder)

& $PythonExe $ArgsList

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Preview generation run finished." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
