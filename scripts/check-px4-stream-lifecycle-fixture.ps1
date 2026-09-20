[CmdletBinding()]
param(
    [int]$RepeatCount = 5,
    [int]$TimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/upstream-wasm'))
$module = Join-Path $build 'px4-stream-lifecycle-node.js'
$runner = Join-Path $repo 'scripts/px4-stream-lifecycle-runner.mjs'
if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { throw "Missing Node fixture module: $module" }
if ($RepeatCount -lt 1 -or $RepeatCount -gt 20) { throw 'RepeatCount must be between 1 and 20.' }
$node = Get-Command node -ErrorAction Stop
$expectedSignature = $null

for ($index = 1; $index -le $RepeatCount; ++$index) {
    $stdoutPath = Join-Path $build ("px4-stream-lifecycle-repeat-$index.stdout.txt")
    $stderrPath = Join-Path $build ("px4-stream-lifecycle-repeat-$index.stderr.txt")
    $process = Start-Process -FilePath $node.Source -ArgumentList @($runner, $module) -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
        $process.Kill($true)
        throw "PX4 lifecycle repeat $index exceeded ${TimeoutMilliseconds}ms."
    }
    $stdout = Get-Content -LiteralPath $stdoutPath -Raw
    try { $report = $stdout | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "PX4 lifecycle repeat $index returned invalid JSON: $stdout" }
    if ($report.diagnostic -ne 'OK' -or $report.attached -ne $true -or
        $report.readBytes -ne 188 -or $report.packets -ne 2 -or $report.bytes -ne 376 -or
        $report.finalTerminal -ne 5 -or $report.detached -ne $true -or
        $report.released -ne $true -or $report.shutdown -ne $true) {
        throw "PX4 lifecycle repeat $index returned an unexpected fixed report: $stdout"
    }
    $signature = [ordered]@{
        diagnostic = [string]$report.diagnostic
        attached = [bool]$report.attached
        readBytes = [int]$report.readBytes
        packets = [int]$report.packets
        bytes = [int]$report.bytes
        finalTerminal = [int]$report.finalTerminal
        detached = [bool]$report.detached
        released = [bool]$report.released
        shutdown = [bool]$report.shutdown
    } | ConvertTo-Json -Compress
    if ($null -eq $expectedSignature) { $expectedSignature = $signature }
    elseif ($signature -ne $expectedSignature) {
        throw "PX4 lifecycle repeat $index differed from the first fixed report: $signature"
    }
    $stderr = Get-Content -LiteralPath $stderrPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
        throw "PX4 lifecycle repeat $index wrote stderr: $stderr"
    }
    Write-Output ("repeat {0}: {1}" -f $index, $signature)
}
