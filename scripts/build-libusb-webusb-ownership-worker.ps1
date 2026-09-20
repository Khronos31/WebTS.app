[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [string]$OutputDirectory = 'build/libusb-webusb-ownership-worker'
)

# Test-only. Links the transfer-ownership regression harness as two opt-in
# Dedicated Worker modules (pristine backend and patched build copy) with a
# fake navigator.usb only. Both use the experimental zero-timeout fast-path
# copy of events_posix.c, because the pinned upstream em_libusb_wait() path
# does not return for a zero timeout on a Worker runtime thread in Chrome.
# These modules are not an M1, production, or real-USB path.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\') + '\'
if (-not $output.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be under repo build/: $output"
}
$emxxExecutable = if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    (Get-Command em++ -ErrorAction Stop).Source
} else { [IO.Path]::GetFullPath($EmxxPath) }
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) { throw "Missing em++: $emxxExecutable" }
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) { throw "Missing matching emcc: $emccExecutable" }

& (Join-Path $PSScriptRoot 'check-vendor-sources.ps1')
$config = Join-Path $repo 'build/libusb-webusb-nopthread'
$vendor = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
# io.c is compiled per variant below because the patched copy changes core's
# disconnect/completed-list ordering; everything else is shared and pristine.
$requiredObjects = @('core.o', 'descriptor.o', 'hotplug.o', 'strerror.o',
    'sync.o', 'threads_posix.o')
foreach ($name in $requiredObjects) {
    if (-not (Test-Path -LiteralPath (Join-Path $config $name) -PathType Leaf)) {
        throw "Missing official no-pthread object: $name. Build the no-pthread overlay first."
    }
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

# Ignored build copy of the pinned events_posix.c. The exact upstream text is
# verified before it is replaced; the vendor tree is never modified.
$eventsSource = Join-Path $vendor 'os/events_posix.c'
$patchedEvents = Join-Path $output 'events_posix-zero-fastpath.c'
$needle = "static void em_libusb_wait(const _Atomic int *ptr, int expected_value, int timeout)`n{`n`tif (emscripten_is_main_runtime_thread()) {"
$replacement = "static void em_libusb_wait(const _Atomic int *ptr, int expected_value, int timeout)`n{`n`t/* Test-only fast path: poll(0) is already non-blocking. */`n`tif (timeout <= 0)`n`t`treturn;`n`tif (emscripten_is_main_runtime_thread()) {"
$normalized = ([IO.File]::ReadAllText($eventsSource)).Replace("`r`n", "`n")
if (-not $normalized.Contains($needle)) { throw 'events_posix.c fast-path context did not match the pinned upstream source.' }
[IO.File]::WriteAllText($patchedEvents, $normalized.Replace($needle, $replacement), [Text.UTF8Encoding]::new($false))

$patchedSources = @(& (Join-Path $PSScriptRoot 'build-libusb-webusb-ownership-source.ps1') `
    -OutputDirectory 'build/libusb-webusb-ownership')
if ($patchedSources.Count -ne 2) { throw 'Expected a patched backend and a patched core copy.' }
$patchedBackend = $patchedSources[0]
$patchedCore = $patchedSources[1]
foreach ($path in $patchedSources) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Patched copy was not produced: $path" }
}

$harness = Join-Path $repo 'scripts/libusb-webusb-ownership-regression.cpp'
$compileArgs = @('-O0', '-I', $config, '-I', $vendor, '-DPLATFORM_POSIX=1',
    '-DOS_EMSCRIPTEN=1', '-DENABLE_LOGGING=1', '-matomics', '-mbulk-memory')

Push-Location $repo
try {
    $eventsObject = Join-Path $output 'events_posix-zero-fastpath.o'
    & $emccExecutable @compileArgs '-c' $patchedEvents '-o' $eventsObject
    if ($LASTEXITCODE -ne 0) { throw 'emcc failed compiling the zero-timeout fast-path events copy.' }

    $variants = @(
        @{ Name = 'stock'; Backend = (Join-Path $vendor 'os/emscripten_webusb.cpp'); Core = (Join-Path $vendor 'io.c'); Define = @() },
        @{ Name = 'patched'; Backend = $patchedBackend; Core = $patchedCore; Define = @('-DWEBTS_LIBUSB_OWNERSHIP_PATCH=1') }
    )
    foreach ($variant in $variants) {
        $coreObject = Join-Path $output ("io-" + $variant.Name + '.o')
        & $emccExecutable @compileArgs '-c' $variant.Core '-o' $coreObject
        if ($LASTEXITCODE -ne 0) { throw "emcc failed for the $($variant.Name) core io.c." }
        $backendObject = Join-Path $output ("backend-" + $variant.Name + '.o')
        & $emxxExecutable @compileArgs '-std=c++20' '-c' $variant.Backend '-o' $backendObject
        if ($LASTEXITCODE -ne 0) { throw "em++ failed for the $($variant.Name) backend." }
        $harnessObject = Join-Path $output ("harness-" + $variant.Name + '.o')
        & $emxxExecutable @compileArgs @($variant.Define) '-std=c++20' '-c' $harness '-o' $harnessObject
        if ($LASTEXITCODE -ne 0) { throw "em++ failed for the $($variant.Name) harness." }

        $generated = Join-Path $output ("libusb-webusb-ownership-worker-" + $variant.Name + '-generated.js')
        $link = @('--bind', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2', '-s', 'MODULARIZE=1',
            '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker',
            '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
            '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_ownership_regression","_malloc","_free"]',
            '-o', $generated, $harnessObject, $backendObject, $coreObject, $eventsObject) +
            @($requiredObjects | ForEach-Object { Join-Path $config $_ })
        & $emxxExecutable @link
        if ($LASTEXITCODE -ne 0) { throw "em++ failed linking the $($variant.Name) Worker module." }

        $browserModule = Join-Path $output ("libusb-webusb-ownership-worker-" + $variant.Name + '-browser.js')
        $browserWasm = Join-Path $output ("libusb-webusb-ownership-worker-" + $variant.Name + '.wasm')
        $generatedWasm = Join-Path $output ("libusb-webusb-ownership-worker-" + $variant.Name + '-generated.wasm')
        Copy-Item -LiteralPath $generated -Destination $browserModule -Force
        $text = ([IO.File]::ReadAllText($browserModule)).Replace(
            ("libusb-webusb-ownership-worker-" + $variant.Name + '-generated.wasm'),
            ("libusb-webusb-ownership-worker-" + $variant.Name + '.wasm'))
        [IO.File]::WriteAllText($browserModule, $text, [Text.UTF8Encoding]::new($false))
        Copy-Item -LiteralPath $generatedWasm -Destination $browserWasm -Force
        Remove-Item -LiteralPath $generated -Force
        Remove-Item -LiteralPath $generatedWasm -Force
        if ($text -notmatch 'webts_libusb_ownership_regression' -or
            $text -notmatch 'Module\[["'']ccall["'']\]' -or
            $text -match ("ownership-worker-" + $variant.Name + '-generated\.wasm')) {
            throw "Ownership Worker module contract is invalid for $($variant.Name)."
        }
        Write-Output "libusb ownership Worker ($($variant.Name), test-only): $browserModule"
    }
} finally { Pop-Location }
