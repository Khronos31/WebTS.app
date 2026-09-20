[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [string]$OutputDirectory = 'build/upstream-wasm'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\')
$buildPrefix = $buildRoot + '\'
if ($output -eq $buildRoot -or -not $output.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be a child of repo build/: $output"
}
$emxxExecutable = if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    $command = Get-Command em++ -ErrorAction Stop
    $command.Source
} else { [IO.Path]::GetFullPath($EmxxPath) }
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) {
    throw "Emscripten em++ was not found: $emxxExecutable"
}

$nodeModule = Join-Path $output 'px4-stream-lifecycle-node.js'
if (-not (Test-Path -LiteralPath $nodeModule -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'run-px4-stream-lifecycle-fixture.ps1') -EmxxPath $emxxExecutable
    if ($LASTEXITCODE -ne 0) { throw 'The source-linked PX4 lifecycle fixture could not be prepared.' }
}

$libusbOutput = Join-Path $repo 'build/libusb-webusb'
$libusb = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$px4 = Join-Path $repo 'vendor/upstream/px4-userland'
$configDirectory = Join-Path $repo 'build/libusb-webusb'
$fixtureObject = Join-Path $output 'px4-stream-lifecycle-mock.o'
$q3u4TestObject = Join-Path $output 'px4-q3u4-stream-test-access.o'
foreach ($required in @($fixtureObject, $q3u4TestObject, (Join-Path $libusbOutput 'core.o'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing prepared object: $required" }
}

$libusbObjects = Get-ChildItem -LiteralPath $libusbOutput -Filter '*.o' -File |
    Where-Object { $_.Name -ne 'libusb-webusb-smoke.o' } |
    Select-Object -ExpandProperty FullName
$px4Objects = Get-ChildItem -LiteralPath $output -Filter 'px4-*.o' -File |
    Where-Object { $_.Name -notin @('px4-stream-lifecycle-mock.o',
        'px4-q3u4_stream.o', 'px4-q3u4-stream-test-access.o',
        'px4-stream-source-smoke.o') } |
    Select-Object -ExpandProperty FullName
$module = Join-Path $output 'px4-stream-lifecycle-worker-generated.js'
$common = @('-O0', '-pthread', '-I', $configDirectory, '-I', $libusb,
    '-I', (Join-Path $px4 'include'), '-I', (Join-Path $px4 'src'),
    '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1',
    '-DPX4_Q3U4_STREAM_TEST_ACCESS=1')
$link = @('--bind', '-pthread', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2',
    '-s', 'PTHREAD_POOL_SIZE=2', '-s', 'ALLOW_MEMORY_GROWTH=1',
    '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker',
    '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
    '-s', 'EXPORTED_FUNCTIONS=["_webts_px4_stream_lifecycle_mock","_malloc","_free"]',
    '-o', $module) + @($fixtureObject, $q3u4TestObject) + $px4Objects + $libusbObjects

Push-Location $repo
try {
    & $emxxExecutable @link
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed linking the PX4 Worker lifecycle module.' }
} finally {
    Pop-Location
}

$browserModule = Join-Path $output 'px4-stream-lifecycle-worker-browser.js'
$pthreadWorkerModule = Join-Path $output 'px4-stream-lifecycle-worker.js'
$generatedWasm = Join-Path $output 'px4-stream-lifecycle-worker-generated.wasm'
$browserWasm = Join-Path $output 'px4-stream-lifecycle-worker.wasm'
# Remove old generated copies before recreating the browser assets.  An
# existing Emscripten output can have owner-only ACLs; overwriting it with
# Copy-Item preserves that ACL instead of inheriting build/ permissions.
foreach ($browserAsset in @($browserModule, $pthreadWorkerModule, $browserWasm)) {
    if (Test-Path -LiteralPath $browserAsset) {
        Remove-Item -LiteralPath $browserAsset -Force
    }
}
Copy-Item -LiteralPath $module -Destination $browserModule -Force
# Emscripten's generated pthread bootstrap uses a same-directory relative
# `px4-stream-lifecycle-worker.js` URL. Copy it into build/ with inherited ACL
# so the dedicated browser Worker can fetch it, without touching vendor/source.
Copy-Item -LiteralPath $module -Destination $pthreadWorkerModule -Force
$browserText = Get-Content -LiteralPath $browserModule -Raw
$browserText = $browserText.Replace('px4-stream-lifecycle-worker-generated.js', 'px4-stream-lifecycle-worker.js')
$browserText = $browserText.Replace('px4-stream-lifecycle-worker-generated.wasm', 'px4-stream-lifecycle-worker.wasm')
Set-Content -LiteralPath $browserModule -Value $browserText -Encoding UTF8
$pthreadText = Get-Content -LiteralPath $pthreadWorkerModule -Raw
$pthreadText = $pthreadText.Replace('px4-stream-lifecycle-worker-generated.js', 'px4-stream-lifecycle-worker.js')
$pthreadText = $pthreadText.Replace('px4-stream-lifecycle-worker-generated.wasm', 'px4-stream-lifecycle-worker.wasm')
Set-Content -LiteralPath $pthreadWorkerModule -Value $pthreadText -Encoding UTF8
Copy-Item -LiteralPath $generatedWasm -Destination $browserWasm -Force
# Do not leave the owner-only linker artifacts in the Vite-served directory;
# the inherited-ACL copies above are the only browser assets needed here.
Remove-Item -LiteralPath $module -Force
Remove-Item -LiteralPath $generatedWasm -Force
$generated = Get-Content -LiteralPath $browserModule -Raw
if ($generated -notmatch 'Module\["ccall"\]' -or
    $generated -notmatch 'HEAPU8' -or
    $generated -notmatch '_webts_px4_stream_lifecycle_mock') {
    throw 'PX4 Worker module does not expose ccall, HEAPU8, and the lifecycle ABI.'
}
$provenanceFiles = @(
    (Join-Path $repo 'scripts/px4-stream-lifecycle-mock.cpp'),
    (Join-Path $repo 'scripts/run-px4-stream-lifecycle-fixture.ps1'),
    (Join-Path $repo 'scripts/build-px4-stream-lifecycle-worker.ps1'),
    (Join-Path $px4 'include/px4/q3u4_stream.h'),
    (Join-Path $px4 'src/q3u4_stream.cpp')
)
foreach ($provenanceFile in $provenanceFiles) {
    if (-not (Test-Path -LiteralPath $provenanceFile -PathType Leaf)) {
        throw "PX4 Worker provenance input is missing: $provenanceFile"
    }
}
$sourceEntries = @($provenanceFiles | ForEach-Object {
    [ordered]@{
        path = $_.Substring($repo.Length + 1).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
$assetPaths = @($browserModule, $pthreadWorkerModule, $browserWasm)
$assetEntries = @($assetPaths | ForEach-Object {
    [ordered]@{
        name = [IO.Path]::GetFileName($_)
        sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
$linkedObjectPaths = @($fixtureObject, $q3u4TestObject) + @($px4Objects) + @($libusbObjects)
$linkedObjectEntries = @($linkedObjectPaths | Sort-Object -Unique | ForEach-Object {
    [ordered]@{
        path = $_.Substring($repo.Length + 1).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    }
})
$manifest = [ordered]@{
    schema = 1
    sourceFiles = $sourceEntries
    linkedObjects = $linkedObjectEntries
    assets = $assetEntries
}
$manifestPath = Join-Path $output 'px4-stream-lifecycle-worker.manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Output "PX4 Worker lifecycle link staging (removed after ACL-safe copy): $module"
Write-Output "browser-served module copy: $browserModule"
Write-Output "browser-served pthread worker copy: $pthreadWorkerModule"
Write-Output "provenance manifest: $manifestPath"
