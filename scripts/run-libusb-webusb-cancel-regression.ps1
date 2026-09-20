[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [int]$TimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/libusb-webusb-cancel-regression'))
$configDirectory = [IO.Path]::GetFullPath((Join-Path $repo 'build/libusb-webusb-nopthread'))
$vendor = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$module = Join-Path $build 'libusb-webusb-cancel-regression.js'

if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    $command = Get-Command em++ -ErrorAction Stop
    $emxxExecutable = $command.Source
} else {
    $emxxExecutable = [IO.Path]::GetFullPath($EmxxPath)
}
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) {
    throw "Missing em++: $emxxExecutable"
}

$checker = Join-Path $PSScriptRoot 'check-vendor-sources.ps1'
& $checker
if (-not (Test-Path -LiteralPath (Join-Path $configDirectory 'config.h') -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'build-libusb-webusb.ps1') `
        -NoPthread -OutputDirectory 'build/libusb-webusb-nopthread' `
        -EmxxPath $emxxExecutable
    if ($LASTEXITCODE -ne 0) { throw 'Base official libusb build failed.' }
}

New-Item -ItemType Directory -Force -Path $build | Out-Null
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) {
    throw "Matching emcc was not found: $emccExecutable"
}
$cSources = @('core.c', 'descriptor.c', 'hotplug.c', 'io.c', 'strerror.c',
    'sync.c', 'os/events_posix.c', 'os/threads_posix.c') |
    ForEach-Object { Join-Path $vendor $_ }
$cppSources = @(
    (Join-Path $vendor 'os/emscripten_webusb.cpp'),
    (Join-Path $repo 'scripts/libusb-webusb-cancel-regression.cpp')
)
$compileArgs = @('-O0', '-pthread', '-I', $configDirectory,
    '-I', $vendor, '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1',
    '-DENABLE_LOGGING=1')
$objects = @()
Push-Location $repo
try {
    foreach ($source in $cSources) {
        $object = Join-Path $build (([IO.Path]::GetFileNameWithoutExtension($source)) + '.o')
        & $emccExecutable @compileArgs '-c' $source '-o' $object
        if ($LASTEXITCODE -ne 0) { throw "emcc failed for $source" }
        $objects += $object
    }
    foreach ($source in $cppSources) {
        $object = Join-Path $build (([IO.Path]::GetFileNameWithoutExtension($source)) + '.o')
        & $emxxExecutable @compileArgs '-std=c++20' '-c' $source '-o' $object
        if ($LASTEXITCODE -ne 0) { throw "em++ failed for $source" }
        $objects += $object
    }
    $linkArgs = @('--bind', '-pthread', '-s', 'SHARED_MEMORY=1', '-s', 'PTHREAD_POOL_SIZE=1', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2',
        '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=node',
        '-s', 'EXPORTED_RUNTIME_METHODS=["ccall"]',
        '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_webusb_cancel_regression","_webts_libusb_webusb_cancel_settle_regression"]',
        '-o', $module) + $objects
    & $emxxExecutable @linkArgs
    if ($LASTEXITCODE -ne 0) { throw 'em++ link failed.' }

    $node = Get-Command node -ErrorAction Stop
    $runner = Join-Path $repo 'scripts/libusb-webusb-cancel-regression-runner.mjs'
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
        throw "libusb WebUSB cancellation regression exceeded ${TimeoutMilliseconds}ms."
    }
    $process.Refresh()
    if ($process.ExitCode -ne 0) {
        throw "Regression process exited with code $($process.ExitCode): stdout=$($process.StandardOutput.ReadToEnd()) stderr=$($process.StandardError.ReadToEnd())"
    }
    $result = $process.StandardOutput.ReadToEnd()
    if ($result -notmatch '"diagnostic":"OBSERVED"') {
        throw "Regression did not observe expected behavior: $result"
    }
    $errorOutput = $process.StandardError.ReadToEnd()
    if (-not [string]::IsNullOrWhiteSpace($errorOutput)) {
        throw "Regression stderr: $errorOutput"
    }
    Write-Output $result.Trim()
} finally {
    Pop-Location
}
