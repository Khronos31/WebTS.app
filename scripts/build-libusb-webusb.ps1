[CmdletBinding()]
param(
    [string]$OutputDirectory = 'build/libusb-webusb',
    [string]$EmxxPath = '',
    [switch]$NoPthread
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $repo 'vendor\upstream\libusb-1.0.30\libusb'
if ($NoPthread -and $OutputDirectory -eq 'build/libusb-webusb') {
    $OutputDirectory = 'build/libusb-webusb-nopthread'
}
$variantName = if ($NoPthread) { 'non-pthread Asyncify' } else { 'pthread' }
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\')
$buildPrefix = $buildRoot + '\'
if ($output -eq $buildRoot -or -not $output.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be a child of repo build/: $output"
}
$config = Join-Path $output 'config.h'
$module = Join-Path $output 'libusb-webusb.js'
$browserModule = Join-Path $output 'libusb-webusb-browser.js'

New-Item -ItemType Directory -Force -Path $output | Out-Null

if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    $emxx = Get-Command em++ -ErrorAction SilentlyContinue
} else {
    $emxx = Get-Item -LiteralPath $EmxxPath -ErrorAction SilentlyContinue
}
$emxxExecutable = if ($null -eq $emxx) { $null } elseif ($emxx -is [IO.FileInfo]) { $emxx.FullName } else { $emxx.Source }
if ($null -eq $emxxExecutable -or -not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) {
    throw 'Emscripten em++ was not found. Activate/install the requested toolchain before running this smoke build.'
}

$checker = Join-Path $PSScriptRoot 'check-vendor-sources.ps1'
& $checker

@'
/* Generated for the official libusb Emscripten/WebUSB backend smoke build. */
#define PACKAGE "libusb"
#define PACKAGE_NAME "libusb"
#define PACKAGE_VERSION "1.0.30"
#define VERSION "1.0.30"
#define DEFAULT_VISIBILITY __attribute__ ((visibility ("default")))
#define PLATFORM_POSIX 1
#define HAVE_SYS_TIME_H 1
#define HAVE_CLOCK_GETTIME 1
#define HAVE_NFDS_T 1
#define HAVE_STRUCT_TIMESPEC 1
#define PRINTF_FORMAT(a, b) __attribute__((format(printf, a, b)))
'@ | Set-Content -LiteralPath $config -Encoding UTF8

$cSources = @(
    (Join-Path $vendor 'core.c'),
    (Join-Path $vendor 'descriptor.c'),
    (Join-Path $vendor 'hotplug.c'),
    (Join-Path $vendor 'io.c'),
    (Join-Path $vendor 'strerror.c'),
    (Join-Path $vendor 'sync.c'),
    (Join-Path $vendor 'os\events_posix.c'),
    (Join-Path $vendor 'os\threads_posix.c'),
    (Join-Path $repo 'scripts\libusb-webusb-smoke.c')
)
$cppSources = @(
    (Join-Path $vendor 'os\emscripten_webusb.cpp'),
    (Join-Path $repo 'scripts\libusb-webusb-diagnostic.cpp')
)
foreach ($source in ($cSources + $cppSources)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing libusb source: $source" }
}

$threadCompileArgs = if ($NoPthread) { @() } else { @('-pthread') }
$atomicArgs = if ($NoPthread) { @('-matomics', '-mbulk-memory') } else { @() }
$compileArgs = @('-O0') + $threadCompileArgs + @(
    '-I', $output, '-I', $vendor, '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1',
    '-DENABLE_LOGGING=1'
) + $atomicArgs
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) { throw "Matching emcc was not found: $emccExecutable" }
$objects = @()
Push-Location $repo
try {
    foreach ($source in $cSources) {
        $object = Join-Path $output (([IO.Path]::GetFileNameWithoutExtension($source)) + '.o')
        & $emccExecutable @compileArgs '-c' $source '-o' $object
        if ($LASTEXITCODE -ne 0) { throw "emcc failed for $source with exit code $LASTEXITCODE" }
        $objects += $object
    }
    foreach ($cppSource in $cppSources) {
        $cppObject = Join-Path $output (([IO.Path]::GetFileNameWithoutExtension($cppSource)) + '.o')
        & $emxxExecutable @compileArgs '-std=c++20' '-c' $cppSource '-o' $cppObject
        if ($LASTEXITCODE -ne 0) { throw "em++ failed for $cppSource with exit code $LASTEXITCODE" }
        $objects += $cppObject
    }
} finally {
    Pop-Location
}

$threadLinkArgs = if ($NoPthread) { @() } else { @('-pthread') }
$linkArgs = @('--bind') + $threadLinkArgs + $atomicArgs + @(
    '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=1',
    '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1',
    '-s', 'EXPORTED_RUNTIME_METHODS=["HEAPU32","ccall"]',
    # The same module is loaded by the Window UI and by a Dedicated Worker.
    # Keep both environments explicit; this does not grant Worker permission
    # to call requestDevice(), which remains Window/user-gesture only.
    '-s', 'ENVIRONMENT=web,worker', '-s', 'EXPORTED_FUNCTIONS=["_main","_libusb_init","_libusb_exit","_webts_libusb_enumerate","_webts_libusb_probe_webusb_device_count","_webts_libusb_probe_execution_context","_webts_libusb_get_last_diagnostic","_malloc","_free"]',
    '-o', $module
) + $objects

Push-Location $repo
try {
    & $emxxExecutable @linkArgs
    if ($LASTEXITCODE -ne 0) { throw "em++ failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

# Some Windows Emscripten installations create the linker output with an
# owner-only ACL.  Copy within ignored build/ so Vite can serve a normal
# inherited-ACL file without changing any vendored or source file.
Copy-Item -LiteralPath $module -Destination $browserModule -Force

Write-Output "libusb WebUSB backend $variantName module: $module"
Write-Output "browser-served module copy: $browserModule"
