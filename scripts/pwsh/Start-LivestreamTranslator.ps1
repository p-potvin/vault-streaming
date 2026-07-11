[CmdletBinding()]
param(
    [string]$Voice = "ff_siwis",
    [string]$Lang = "fr-fr",
    [double]$Threshold = 0.005,
    [double]$Volume = 0.80
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$PythonScript = Join-Path (Join-Path $ProjectRoot 'python-scripts') 'livestream_translator.py'

if (-not (Test-Path $PythonScript)) {
    Write-Error "Could not locate livestream_translator.py at $PythonScript"
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
Write-Host " VAULT EXPLORER REAL-TIME LIVESTREAM TRANSLATOR" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Voice:     $Voice" -ForegroundColor Gray
Write-Host "Language:  $Lang" -ForegroundColor Gray
Write-Host "Threshold: $Threshold" -ForegroundColor Gray
Write-Host "Volume:    $Volume" -ForegroundColor Gray
Write-Host "Python:    $PythonExe" -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor Gray
Write-Host "Play audio in your browser/app. Press Ctrl+C to stop." -ForegroundColor Yellow
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$ArgsList = @("-u", $PythonScript, "--voice", $Voice, "--lang", $Lang, "--threshold", $Threshold, "--volume", $Volume)

& $PythonExe $ArgsList

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Livestream translator stopped." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
