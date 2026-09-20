[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [int]$TimeoutMilliseconds = 20000,
    [int[]]$Scenarios = @(0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
)

# Test-only. Links the harness twice against the pinned official libusb core
# and backend: once pristine (the failure baseline) and once against an ignored
# build copy carrying the WebTS.app transfer-ownership patch. Each scenario
# runs in its own bounded Node child with a fake navigator.usb only. No real
# USB, firmware, mode, tune, TS, or production path is involved.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$configDirectory = [IO.Path]::GetFullPath((Join-Path $repo 'build/libusb-webusb-nopthread'))
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/libusb-webusb-ownership'))

$emxxExecutable = if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    (Get-Command em++ -ErrorAction Stop).Source
} else { [IO.Path]::GetFullPath($EmxxPath) }
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) { throw "Missing em++: $emxxExecutable" }
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) { throw "Missing matching emcc: $emccExecutable" }

& (Join-Path $PSScriptRoot 'check-vendor-sources.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $configDirectory 'config.h') -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'build-libusb-webusb.ps1') `
        -NoPthread -OutputDirectory 'build/libusb-webusb-nopthread' -EmxxPath $emxxExecutable
    if ($LASTEXITCODE -ne 0) { throw 'Base official libusb build failed.' }
}

New-Item -ItemType Directory -Force -Path $build | Out-Null
$patchedSources = @(& (Join-Path $PSScriptRoot 'build-libusb-webusb-ownership-source.ps1') `
    -OutputDirectory 'build/libusb-webusb-ownership')
if ($patchedSources.Count -ne 2) { throw 'Expected a patched backend and a patched core copy.' }
$patchedBackend = $patchedSources[0]
$patchedCore = $patchedSources[1]
foreach ($path in $patchedSources) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Patched copy was not produced: $path" }
}

$harness = Join-Path $repo 'scripts/libusb-webusb-ownership-regression.cpp'
$backendSource = Join-Path $vendor 'os/emscripten_webusb.cpp'
# io.c is compiled per variant because the patched copy changes core's
# disconnect/completed-list ordering; everything else is shared and pristine.
$cSources = @('core.c', 'descriptor.c', 'hotplug.c', 'strerror.c',
    'sync.c', 'os/events_posix.c', 'os/threads_posix.c') |
    ForEach-Object { Join-Path $vendor $_ }
$compileArgs = @('-O0', '-pthread', '-I', $configDirectory, '-I', $vendor,
    '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1')

Push-Location $repo
try {
    $sharedObjects = @()
    foreach ($source in $cSources) {
        $object = Join-Path $build (([IO.Path]::GetFileNameWithoutExtension($source)) + '.o')
        & $emccExecutable @compileArgs '-c' $source '-o' $object
        if ($LASTEXITCODE -ne 0) { throw "emcc failed for $source" }
        $sharedObjects += $object
    }

    $variants = @(
        @{ Name = 'stock'; Backend = $backendSource; Core = (Join-Path $vendor 'io.c'); Define = @() },
        @{ Name = 'patched'; Backend = $patchedBackend; Core = $patchedCore; Define = @('-DWEBTS_LIBUSB_OWNERSHIP_PATCH=1') }
    )
    $modules = @{}
    foreach ($variant in $variants) {
        $coreObject = Join-Path $build ("io-" + $variant.Name + '.o')
        & $emccExecutable @compileArgs '-c' $variant.Core '-o' $coreObject
        if ($LASTEXITCODE -ne 0) { throw "emcc failed for the $($variant.Name) core io.c." }
        $backendObject = Join-Path $build ("backend-" + $variant.Name + '.o')
        & $emxxExecutable @compileArgs '-std=c++20' '-c' $variant.Backend '-o' $backendObject
        if ($LASTEXITCODE -ne 0) { throw "em++ failed for the $($variant.Name) backend." }
        $harnessObject = Join-Path $build ("harness-" + $variant.Name + '.o')
        & $emxxExecutable @compileArgs @($variant.Define) '-std=c++20' '-c' $harness '-o' $harnessObject
        if ($LASTEXITCODE -ne 0) { throw "em++ failed for the $($variant.Name) harness." }
        $module = Join-Path $build ("libusb-webusb-ownership-" + $variant.Name + '.js')
        $link = @('--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=1',
            '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
            '-s', 'ENVIRONMENT=node', '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
            '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_ownership_regression","_malloc","_free"]',
            '-o', $module, $harnessObject, $backendObject, $coreObject) + $sharedObjects
        & $emxxExecutable @link
        if ($LASTEXITCODE -ne 0) { throw "em++ failed linking the $($variant.Name) module." }
        $modules[$variant.Name] = $module
    }

    $node = (Get-Command node -ErrorAction Stop).Source
    $runner = Join-Path $repo 'scripts/libusb-webusb-ownership-regression-runner.mjs'
    function Invoke-Scenario([string]$module, [int]$scenario) {
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $node
        $startInfo.Arguments = '"' + $runner + '" "' + $module + '" ' + $scenario
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            $process.Kill($true)
            return @{ Outcome = 'TIMEOUT'; Report = $null; Stderr = '' }
        }
        $process.Refresh()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            return @{ Outcome = 'CHILD_FAILED'; Report = $null; Stderr = $stderr }
        }
        $line = ($stdout -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
        if ([string]::IsNullOrWhiteSpace($line)) {
            return @{ Outcome = 'NO_REPORT'; Report = $null; Stderr = $stderr }
        }
        return @{ Outcome = 'REPORTED'; Report = ($line | ConvertFrom-Json); Stderr = $stderr }
    }

    $failures = @()
    $summary = @()
    foreach ($scenario in $Scenarios) {
        $stock = Invoke-Scenario $modules['stock'] $scenario
        $patched = Invoke-Scenario $modules['patched'] $scenario
        $stockDiagnostic = if ($stock.Outcome -eq 'REPORTED') { $stock.Report.diagnostic } else { $stock.Outcome }
        $patchedDiagnostic = if ($patched.Outcome -eq 'REPORTED') { $patched.Report.diagnostic } else { $patched.Outcome }

        # The natural-completion guard must hold for both variants. Every other
        # scenario is a stock failure baseline: stock must not report OK, and
        # the patched copy must. Scenario 8 is a deliberate use-after-free in
        # the pristine backend, so any non-OK stock outcome (including a failed
        # child) is recorded as-is and never interpreted as safe.
        if ($scenario -eq 7) {
            if ($stockDiagnostic -ne 'OK') { $failures += "scenario ${scenario}: stock natural completion regressed ($stockDiagnostic)" }
            if ($patchedDiagnostic -ne 'OK') { $failures += "scenario ${scenario}: patched natural completion regressed ($patchedDiagnostic)" }
        } else {
            if ($stockDiagnostic -eq 'OK') { $failures += "scenario ${scenario}: stock unexpectedly satisfied the ownership expectations" }
            if ($patchedDiagnostic -ne 'OK') { $failures += "scenario ${scenario}: patched copy did not satisfy the expectations ($patchedDiagnostic)" }
        }
        if ($patched.Outcome -eq 'REPORTED' -and -not [string]::IsNullOrWhiteSpace($patched.Stderr)) {
            $failures += "scenario ${scenario}: patched child wrote to stderr"
        }
        $summary += [ordered]@{
            scenario = $scenario
            stock = $stockDiagnostic
            patched = $patchedDiagnostic
            stockReport = $stock.Report
            patchedReport = $patched.Report
        }
    }
    $output = [ordered]@{
        diagnostic = if ($failures.Count -eq 0) { 'OK' } else { 'FAILED' }
        physicalAbortProven = $false
        realUsbUsed = $false
        scenarios = $summary
        failures = $failures
    }
    Write-Output ($output | ConvertTo-Json -Depth 6 -Compress)
    if ($failures.Count -ne 0) { throw ("libusb ownership regression failed: " + ($failures -join '; ')) }
} finally {
    Pop-Location
}
