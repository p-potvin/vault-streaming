[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Root folder to scan recursively for image files")]
    [string]$Folder,

    [switch]$SkipExisting,

    [string[]]$Extensions = @('.jpg', '.jpeg', '.png', '.webp', '.bmp')
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ToolExe = Join-Path (Join-Path $ProjectRoot 'tools') 'realesrgan-ncnn-vulkan.exe'
$ModelsDir = Join-Path (Join-Path $ProjectRoot 'tools') 'models'

if (-not (Test-Path $ToolExe)) {
    Write-Error "Could not locate realesrgan-ncnn-vulkan.exe at $ToolExe"
    exit 1
}

if (-not (Test-Path $Folder)) {
    Write-Error "Folder not found: $Folder"
    exit 1
}

$ModelName = "realesrgan-x4plus"
if (Test-Path $ModelsDir) {
    $ModelFiles = Get-ChildItem -Path $ModelsDir -File
    $SafeTensors = $ModelFiles | Where-Object { $_.Extension -eq '.safetensors' } | Select-Object -First 1
    $NomosBin = $ModelFiles | Where-Object { $_.Name -match 'Nomos' -and $_.Extension -eq '.bin' } | Select-Object -First 1
    if ($SafeTensors) { $ModelName = $SafeTensors.BaseName }
    elseif ($NomosBin) { $ModelName = $NomosBin.BaseName }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " VAULT EXPLORER REAL-ESRGAN IMAGE ENHANCEMENT - RECURSIVE FOLDER RUN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Folder:     $Folder" -ForegroundColor Gray
Write-Host "Tool:       $ToolExe" -ForegroundColor Gray
Write-Host "Model:      $ModelName" -ForegroundColor Gray
Write-Host "Skip:       $($SkipExisting.IsPresent)" -ForegroundColor Gray
Write-Host "----------------------------------------------------------" -ForegroundColor Gray

$FilterScript = {
    $ext = $_.Extension.ToLower()
    $Extensions -contains $ext
}

$Files = Get-ChildItem -Path $Folder -Recurse -File | Where-Object $FilterScript | Sort-Object LastWriteTime -Descending
Write-Host "Found $($Files.Count) image file(s) to process (newest first)." -ForegroundColor Gray

$Processed = 0
$Skipped = 0

foreach ($File in $Files) {
    $ThumbsDir = Join-Path $File.DirectoryName '.thumbs'
    $OutputPath = Join-Path $ThumbsDir "$($File.BaseName)_realesrgan$($File.Extension)"

    if ($SkipExisting -and (Test-Path $OutputPath)) {
        Write-Host "[SKIP] $($File.FullName) -> output already exists" -ForegroundColor DarkGray
        $Skipped++
        continue
    }

    if (-not (Test-Path $ThumbsDir)) {
        New-Item -ItemType Directory -Path $ThumbsDir -Force | Out-Null
    }

    $Processed++
    Write-Host "[$Processed/$($Files.Count)] $($File.FullName) -> $OutputPath" -ForegroundColor Cyan

    $ArgsList = @($File.FullName, "-o", $OutputPath, "-n", $ModelName, "-g", "0", "-m", $ModelsDir)

    try {
        & $ToolExe $ArgsList
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "realesrgan-ncnn-vulkan.exe exited with code $LASTEXITCODE for $($File.FullName)"
        }
    }
    catch {
        Write-Error "Failed to process $($File.FullName): $_"
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Done. Processed: $Processed, Skipped: $Skipped" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
