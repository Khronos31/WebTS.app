[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [int]$TimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/libusb-webusb-cancel-regression'))
$module = Join-Path $build 'libusb-webusb-cancel-regression.js'
& (Join-Path $PSScriptRoot 'run-libusb-webusb-cancel-regression.ps1') -EmxxPath $EmxxPath -TimeoutMilliseconds $TimeoutMilliseconds | Out-Null
if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { throw 'Cancellation regression module was not built.' }
$node = Get-Command node -ErrorAction Stop
$runner = Join-Path $repo 'scripts/libusb-webusb-cancel-settle-regression-runner.mjs'
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node.Source
$startInfo.Arguments = '"' + $runner + '" "' + $module + '"'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
[void]$process.Start()
if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    $process.Kill($true)
    throw "Cancellation settle regression exceeded ${TimeoutMilliseconds}ms."
}
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
if ($process.ExitCode -ne 0) { throw "Settle regression failed: stdout=$stdout stderr=$stderr" }
if ($stderr -and -not [string]::IsNullOrWhiteSpace($stderr)) { throw "Settle regression stderr: $stderr" }
$report = $stdout.Trim() | ConvertFrom-Json
if ($report.diagnostic -ne 'OBSERVED' -or $report.resolved.diagnostic -ne 'OBSERVED' -or
    $report.resolved.callbackCount -ne 1 -or $report.resolved.callbackStatus -ne 3) {
    throw "Unexpected settle regression report: $stdout"
}
Write-Output $stdout.Trim()
