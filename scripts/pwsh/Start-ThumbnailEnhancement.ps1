[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Root folder to scan recursively for image files")]
    [string]$Folder,

    [switch]$SkipExisting,

    [string[]]$Extensions = @('.jpg', '.jpeg', '.png', '.webp', '.bmp')
)

$MagickExe = "magick"
try { $MagickExe = (Get-Command magick -ErrorAction Stop).Source } catch {}

if (-not (Test-Path $Folder)) {
    Write-Error "Folder not found: $Folder"
    exit 1
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " VAULT EXPLORER THUMBNAIL ENHANCEMENT - RECURSIVE FOLDER RUN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Folder: $Folder" -ForegroundColor Gray
Write-Host "Magick: $MagickExe" -ForegroundColor Gray
Write-Host "Skip:   $($SkipExisting.IsPresent)" -ForegroundColor Gray
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
    $OutputPath = Join-Path $ThumbsDir "$($File.BaseName)_enhanced.jpg"

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

    $ArgsList = @(
        $File.FullName,
        "-adaptive-sharpen", "0x1",
        "-modulate", "100,120",
        "-sigmoidal-contrast", "3x50%",
        "-quality", "88",
        $OutputPath
    )

    try {
        & $MagickExe $ArgsList
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "magick exited with code $LASTEXITCODE for $($File.FullName)"
        }
    }
    catch {
        Write-Error "Failed to process $($File.FullName): $_"
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Done. Processed: $Processed, Skipped: $Skipped" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
