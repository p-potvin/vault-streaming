# Initialize and start the stopwatch
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# Your command here
npm run dist

# Stop the timer and output the duration
$stopwatch.Stop()
Write-Host "Command execution time: $($stopwatch.Elapsed.TotalMilliseconds) ms" -ForegroundColor Green
Write-Host -NoNewLine 'Press any key to continue...';
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown');