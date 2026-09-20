[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [int]$TimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/upstream-wasm'))
$module = Join-Path $build 'px4-stream-lifecycle-node.js'
$emxxExecutable = if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    $command = Get-Command em++ -ErrorAction Stop
    $command.Source
} else { [IO.Path]::GetFullPath($EmxxPath) }
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) {
    throw "Emscripten em++ was not found: $emxxExecutable"
}
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
$configDirectory = Join-Path $repo 'build/libusb-webusb'
$libusb = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$px4 = Join-Path $repo 'vendor/upstream/px4-userland'
$common = @('-O0', '-pthread', '-I', $configDirectory, '-I', $libusb,
    '-I', (Join-Path $px4 'include'), '-I', (Join-Path $px4 'src'),
    '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1', '-DPX4_Q3U4_STREAM_TEST_ACCESS=1')
$fixtureObject = Join-Path $build 'px4-stream-lifecycle-mock.o'
Push-Location $repo
try {
    & $emxxExecutable @common '-std=c++20' '-c' (Join-Path $repo 'scripts/px4-stream-lifecycle-mock.cpp') '-o' $fixtureObject
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed compiling the lifecycle fixture.' }
    $q3u4TestObject = Join-Path $build 'px4-q3u4-stream-test-access.o'
    & $emxxExecutable @common '-std=c++20' '-c' (Join-Path $px4 'src/q3u4_stream.cpp') '-o' $q3u4TestObject
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed compiling the test-access Q3U4 stream object.' }
    $px4Objects = Get-ChildItem -LiteralPath $build -Filter 'px4-*.o' -File |
        Where-Object { $_.Name -notin @('px4-stream-lifecycle-mock.o',
            'px4-q3u4_stream.o', 'px4-q3u4-stream-test-access.o',
            'px4-stream-source-smoke.o') } |
        Select-Object -ExpandProperty FullName
    $libusbObjects = Get-ChildItem -LiteralPath (Join-Path $repo 'build/libusb-webusb') -Filter '*.o' -File |
        Where-Object { $_.Name -ne 'libusb-webusb-smoke.o' } |
        Select-Object -ExpandProperty FullName
    $link = @('--bind', '-pthread', '-s', 'ASSERTIONS=2', '-s', 'PTHREAD_POOL_SIZE=2',
        '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
        '-s', 'ENVIRONMENT=node', '-s', 'EXIT_RUNTIME=1',
        '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
        '-s', 'EXPORTED_FUNCTIONS=["_webts_px4_stream_lifecycle_mock","_malloc","_free"]',
        '-o', $module) + @($fixtureObject, $q3u4TestObject) + $px4Objects + $libusbObjects
    & $emxxExecutable @link
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed linking the lifecycle fixture.' }

    $node = Get-Command node -ErrorAction Stop
    $stdoutPath = Join-Path $build 'px4-stream-lifecycle-runner.stdout.txt'
    $stderrPath = Join-Path $build 'px4-stream-lifecycle-runner.stderr.txt'
    $process = Start-Process -FilePath $node.Source -ArgumentList @(
        (Join-Path $repo 'scripts/px4-stream-lifecycle-runner.mjs'), $module
    ) -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
        $process.Kill($true)
        throw "PX4 lifecycle fixture exceeded ${TimeoutMilliseconds}ms."
    }
    $process.Refresh()
    $stdout = Get-Content -LiteralPath $stdoutPath -Raw
    if ($stdout -notmatch '"diagnostic":"OK"') {
        throw "PX4 lifecycle fixture did not return the fixed OK report: $stdout"
    }
    Write-Output $stdout.Trim()
    if (Test-Path -LiteralPath $stderrPath) {
        $stderr = Get-Content -LiteralPath $stderrPath -Raw
        if (-not [string]::IsNullOrWhiteSpace($stderr)) { throw "PX4 lifecycle fixture wrote stderr: $stderr" }
    }
} finally {
    Pop-Location
}
