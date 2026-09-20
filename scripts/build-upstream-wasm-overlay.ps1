[CmdletBinding()]
param(
    [string]$OutputDirectory = 'build/upstream-wasm',
    [string]$EmxxPath = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\')
$buildPrefix = $buildRoot + '\'
if ($output -eq $buildRoot -or -not $output.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be a child of repo build/: $output"
}

if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    $emxx = Get-Command em++ -ErrorAction SilentlyContinue
    $emxxExecutable = if ($null -eq $emxx) { $null } else { $emxx.Source }
} else {
    $emxxExecutable = [IO.Path]::GetFullPath($EmxxPath)
}
if ($null -eq $emxxExecutable -or -not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) {
    throw 'Emscripten em++ was not found. Activate/install the requested toolchain first.'
}
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) { throw "Matching emcc was not found: $emccExecutable" }

$vendor = Join-Path $repo 'vendor\upstream'
$px4 = Join-Path $vendor 'px4-userland'
$siano = Join-Path $vendor 'siano-userland'
$b25 = Join-Path $vendor 'libaribb25'
$libusb = Join-Path $vendor 'libusb-1.0.30\libusb'
$libusbOutput = Join-Path $repo 'build\libusb-webusb'
$config = Join-Path $libusbOutput 'config.h'
$configDirectory = Split-Path -Parent $config
New-Item -ItemType Directory -Force -Path $output | Out-Null

$libusbBuild = Join-Path $PSScriptRoot 'build-libusb-webusb.ps1'
& $libusbBuild -OutputDirectory 'build/libusb-webusb' -EmxxPath $emxxExecutable
if ($LASTEXITCODE -ne 0) { throw 'Official libusb WebUSB backend build failed.' }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Missing generated libusb config: $config" }

$px4Common = @('-O0', '-pthread', '-I', $configDirectory, '-I', $libusb,
               '-I', (Join-Path $px4 'include'), '-I', (Join-Path $px4 'src'),
               '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1',
               '-DPX4_Q3U4_STREAM_TEST_ACCESS=1')
$sianoCommon = @('-O0', '-pthread', '-I', $configDirectory, '-I', $libusb,
                 '-I', $siano, '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1')
$b25Common = @('-O0', '-I', (Join-Path $b25 'src'))

function Compile-Cpp([string]$source, [string]$object) {
    & $emxxExecutable @px4Common '-std=c++20' '-c' $source '-o' $object
    if ($LASTEXITCODE -ne 0) { throw "em++ failed for $source with exit code $LASTEXITCODE" }
}

function Compile-C([string]$source, [string]$object, [string[]]$extraArgs = @()) {
    & $emccExecutable @sianoCommon @extraArgs '-c' $source '-o' $object
    if ($LASTEXITCODE -ne 0) { throw "emcc failed for $source with exit code $LASTEXITCODE" }
}

function Compile-B25-C([string]$source, [string]$object) {
    & $emccExecutable @b25Common '-c' $source '-o' $object
    if ($LASTEXITCODE -ne 0) { throw "emcc failed for $source with exit code $LASTEXITCODE" }
}

Push-Location $repo
try {
    $px4Objects = @()
    foreach ($name in @('error.cpp', 'identity.cpp', 'libusb_transport.cpp',
                        'libusb_transport_test_access.cpp', 'it930x_protocol.cpp',
                        'tagged_ts_demux.cpp', 'q3u4_stream.cpp', 'mock_transport.cpp')) {
        $object = Join-Path $output ("px4-" + ($name -replace '\.cpp$', '.o'))
        Compile-Cpp (Join-Path (Join-Path $px4 'src') $name) $object
        $px4Objects += $object
    }
    $px4Smoke = Join-Path $output 'px4-transport-smoke.o'
    Compile-Cpp (Join-Path $repo 'scripts\px4-transport-smoke.cpp') $px4Smoke
    $px4Objects += $px4Smoke
    $px4EnumerationShim = Join-Path $output 'px4-enumeration-shim.o'
    Compile-Cpp (Join-Path $repo 'scripts\px4-enumeration-shim.cpp') $px4EnumerationShim
    $px4Objects += $px4EnumerationShim
    $px4RuntimeMock = Join-Path $output 'px4-runtime-mock.o'
    Compile-Cpp (Join-Path $repo 'scripts\px4-runtime-mock.cpp') $px4RuntimeMock
    $px4Objects += $px4RuntimeMock
    $px4ProtocolSmoke = Join-Path $output 'px4-it930x-protocol-smoke.o'
    Compile-Cpp (Join-Path $repo 'scripts\px4-it930x-protocol-smoke.cpp') $px4ProtocolSmoke
    $px4Objects += $px4ProtocolSmoke
    $px4TaggedTsDemuxSmoke = Join-Path $output 'px4-tagged-ts-demux-smoke.o'
    Compile-Cpp (Join-Path $repo 'scripts\px4-tagged-ts-demux-smoke.cpp') $px4TaggedTsDemuxSmoke
    $px4Objects += $px4TaggedTsDemuxSmoke
    $px4StreamSourceSmoke = Join-Path $output 'px4-stream-source-smoke.o'
    Compile-Cpp (Join-Path $repo 'scripts\px4-stream-source-smoke.cpp') $px4StreamSourceSmoke
    $px4Objects += $px4StreamSourceSmoke

    $libusbObjects = Get-ChildItem -LiteralPath $libusbOutput -Filter '*.o' -File |
        Where-Object { $_.Name -ne 'libusb-webusb-smoke.o' } |
        Select-Object -ExpandProperty FullName
    $px4Module = Join-Path $output 'px4-transport-smoke.js'
    $link = @('--bind', '-pthread', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1',
              '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
              '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]', '-s', 'ENVIRONMENT=web',
              '-s', 'EXPORTED_FUNCTIONS=["_webts_px4_portable_link_smoke","_webts_px4_enumerate_native_summary","_webts_px4_grouping_mock_summary","_webts_px4_runtime_mock_open_close","_webts_px4_it930x_protocol_mock","_webts_px4_tagged_ts_demux_mock","_webts_px4_stream_source_link_smoke","_malloc","_free"]',
              '-o', $px4Module) + $px4Objects + $libusbObjects
    & $emxxExecutable @link
    if ($LASTEXITCODE -ne 0) { throw "em++ failed linking PX4 Transport smoke with exit code $LASTEXITCODE" }
    Copy-Item -LiteralPath $px4Module -Destination (Join-Path $output 'px4-transport-smoke-browser.js') -Force
    $px4Generated = Get-Content -LiteralPath $px4Module -Raw
    if ($px4Generated -notmatch 'Module\["ccall"\]' -or
        $px4Generated -notmatch 'HEAPU8' -or
        $px4Generated -notmatch '_webts_px4_grouping_mock_summary' -or
        $px4Generated -notmatch '_webts_px4_runtime_mock_open_close' -or
        $px4Generated -notmatch '_webts_px4_it930x_protocol_mock' -or
        $px4Generated -notmatch '_webts_px4_tagged_ts_demux_mock' -or
        $px4Generated -notmatch '_webts_px4_stream_source_link_smoke') {
        throw 'PX4 overlay does not expose the required ccall/grouping/runtime/protocol mock ABI.'
    }

    $sianoObjects = @()
    foreach ($name in @('protocol.c', 'stream-state.c', 'siano-ts.c')) {
        $object = Join-Path $output ("siano-" + ($name -replace '\.(c)$', '.o'))
        Compile-C (Join-Path $siano $name) $object
        $sianoObjects += $object
    }
    $sianoModule = Join-Path $output 'siano-ts-smoke.js'
    $sianoLink = @('--bind', '-pthread', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1',
                   '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
                   '-s', 'ENVIRONMENT=web,worker', '-o', $sianoModule) + $sianoObjects + $libusbObjects
    & $emxxExecutable @sianoLink
    if ($LASTEXITCODE -ne 0) { throw "em++ failed linking Siano smoke with exit code $LASTEXITCODE" }

    # Keep the locked vendor snapshot immutable.  The Rio shim includes
    # siano-ts.c, so compile that one translation unit against an explicit,
    # checked patch copy which adds bounded counters.  The other Siano smoke
    # objects intentionally remain byte-for-byte vendor builds.
    $sianoCounterSourceDirectory = Join-Path $output 'siano-ts-counters-source'
    New-Item -ItemType Directory -Force -Path $sianoCounterSourceDirectory | Out-Null
    $sianoCounterSource = Join-Path $sianoCounterSourceDirectory 'siano-ts.c'
    Copy-Item -LiteralPath (Join-Path $siano 'siano-ts.c') -Destination $sianoCounterSource -Force
    $sianoCounterPatch = Join-Path $repo 'scripts\siano-ts-counters.patch'
    $sianoCounterRelativeDirectory = $sianoCounterSourceDirectory.Substring($repo.Length).TrimStart('\')
    & git -C $repo apply --check --directory=$sianoCounterRelativeDirectory $sianoCounterPatch
    if ($LASTEXITCODE -ne 0) { throw 'Siano counter patch does not apply cleanly to the locked source.' }
    & git -C $repo apply --directory=$sianoCounterRelativeDirectory $sianoCounterPatch
    if ($LASTEXITCODE -ne 0) { throw 'Siano counter patch application failed.' }
    $sianoCounterPatchedSource = Join-Path $sianoCounterSourceDirectory 'siano-ts-counters-patched.c'
    Copy-Item -LiteralPath $sianoCounterSource -Destination $sianoCounterPatchedSource -Force
    $sianoRioShim = Join-Path $output 'siano-rio-enumeration-shim.o'
    $sianoCounterArgs = @('-I', $sianoCounterSourceDirectory,
                          '-DWEBTS_SIANO_TS_COUNTERS_PATCHED=1')
    Compile-C (Join-Path $repo 'scripts\siano-rio-enumeration-shim.c') $sianoRioShim $sianoCounterArgs
    $sianoStopSmoke = Join-Path $output 'siano-stop-boundary-smoke.o'
    Compile-C (Join-Path $repo 'scripts\siano-stop-boundary-smoke.c') $sianoStopSmoke
    $sianoVersionSmoke = Join-Path $output 'siano-version-response-smoke.o'
    Compile-C (Join-Path $repo 'scripts\siano-version-response-smoke.c') $sianoVersionSmoke
    $sianoRioModule = Join-Path $output 'siano-rio-enumeration.js'
    $sianoRioLink = @('--bind', '-pthread', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1',
                      '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
                      '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
                      '-s', 'ENVIRONMENT=web,worker',
                      '-s', 'EXPORTED_FUNCTIONS=["_webts_siano_enumerate_rio","_webts_siano_lifecycle_create_close","_webts_siano_lifecycle_open_link_smoke","_webts_siano_lifecycle_open","_webts_siano_lifecycle_close","_webts_siano_lifecycle_open_close_probe","_webts_siano_lifecycle_start_version","_webts_siano_firmware_validate_stage","_webts_siano_release_first_stop_mock","_webts_siano_version_response_mock","_webts_siano_ts_queue_mock","_webts_siano_live_stats_snapshot","_webts_siano_live_stats_mock","_malloc","_free"]',
                      '-o', $sianoRioModule) + @($sianoRioShim, $sianoObjects[0], $sianoObjects[1]) + $libusbObjects
    $sianoRioLink += $sianoStopSmoke
    $sianoRioLink += $sianoVersionSmoke
    & $emxxExecutable @sianoRioLink
    if ($LASTEXITCODE -ne 0) { throw "em++ failed linking Siano Rio enumeration with exit code $LASTEXITCODE" }
    Copy-Item -LiteralPath $sianoRioModule -Destination (Join-Path $output 'siano-rio-enumeration-browser.js') -Force
    # Inspect the browser-served copy: on Windows em++ may create the original
    # JS with an owner-only ACL that the Vite process cannot read.
    $sianoRioGenerated = Get-Content -LiteralPath (Join-Path $output 'siano-rio-enumeration-browser.js') -Raw
    if ($sianoRioGenerated -notmatch 'ccall' -or
        $sianoRioGenerated -notmatch 'HEAPU8' -or
        $sianoRioGenerated -notmatch '_webts_siano_ts_queue_mock' -or
        $sianoRioGenerated -notmatch '_webts_siano_live_stats_snapshot' -or
        $sianoRioGenerated -notmatch '_webts_siano_live_stats_mock' -or
        $sianoRioGenerated -notmatch '_webts_siano_release_first_stop_mock' -or
        $sianoRioGenerated -notmatch '_webts_siano_version_response_mock') {
        throw 'Siano Rio enumeration module does not expose the required ccall/HEAPU8/stop/version ABI.'
    }

    $b25Objects = @()
    foreach ($name in @('multi2.c', 'ts_section_parser.c', 'arib_std_b25.c')) {
        $object = Join-Path $output ("b25-" + ($name -replace '\.c$', '.o'))
        Compile-B25-C (Join-Path (Join-Path $b25 'src') $name) $object
        $b25Objects += $object
    }
    $b25Smoke = Join-Path $output 'libaribb25-smoke.o'
    Compile-B25-C (Join-Path $repo 'scripts\libaribb25-smoke.c') $b25Smoke
    $b25FacadeSmoke = Join-Path $output 'libaribb25-facade-smoke.o'
    Compile-B25-C (Join-Path $repo 'scripts\libaribb25-facade-smoke.c') $b25FacadeSmoke
    $b25Module = Join-Path $output 'libaribb25-smoke.js'
    $b25Link = @('-s', 'ASSERTIONS=1', '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1',
                 '-s', 'EXPORT_ES6=1', '-s', 'EXPORTED_RUNTIME_METHODS=["ccall"]',
                 '-s', 'ENVIRONMENT=web',
                 '-s', 'EXPORTED_FUNCTIONS=["_webts_b25_core_no_card_smoke","_webts_b25_facade_no_card_smoke"]',
                 '-o', $b25Module) + @($b25Smoke, $b25FacadeSmoke) + $b25Objects
    & $emccExecutable @b25Link
    if ($LASTEXITCODE -ne 0) { throw "emcc failed linking libaribb25 smoke with exit code $LASTEXITCODE" }
    Copy-Item -LiteralPath $b25Module -Destination (Join-Path $output 'libaribb25-smoke-browser.js') -Force
    # Emscripten may create an owner-only generated JS file on Windows. Inspect
    # the same-directory browser-served copy, which inherits the build ACL.
    $b25Generated = Get-Content -LiteralPath (Join-Path $output 'libaribb25-smoke-browser.js') -Raw
    if ($b25Generated -notmatch 'ccall' -or
        $b25Generated -notmatch '_webts_b25_core_no_card_smoke' -or
        $b25Generated -notmatch '_webts_b25_facade_no_card_smoke') {
        throw 'libaribb25 smoke module does not expose the required ccall/core/facade ABI.'
    }
}
finally {
    Pop-Location
}

Write-Output "PX4 Transport overlay: $px4Module"
Write-Output "Siano source overlay: $sianoModule"
Write-Output "Siano Rio enumeration overlay: $sianoRioModule"
Write-Output "libaribb25 core overlay: $b25Module"
