[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [string]$OutputDirectory = 'build/libusb-webusb-cancel-worker'
)

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
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) {
    throw "Missing em++: $emxxExecutable"
}
$config = Join-Path $repo 'build/libusb-webusb-nopthread'
$vendor = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$requiredObjects = @('core.o', 'descriptor.o', 'emscripten_webusb.o', 'events_posix.o',
    'hotplug.o', 'io.o', 'strerror.o', 'sync.o', 'threads_posix.o')
foreach ($name in $requiredObjects) {
    if (-not (Test-Path -LiteralPath (Join-Path $config $name) -PathType Leaf)) {
        throw "Missing official libusb object: $name. Build the no-pthread WebUSB overlay first."
    }
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
$harnessObject = Join-Path $output 'libusb-webusb-cancel-regression.o'
$module = Join-Path $output 'libusb-webusb-cancel-worker-generated.js'
$source = Join-Path $repo 'scripts/libusb-webusb-cancel-regression.cpp'
$compile = @('-O0', '-I', $config, '-I', $vendor, '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1',
    '-DENABLE_LOGGING=1', '-std=c++20', '-c', $source, '-o', $harnessObject)
$link = @('--bind', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2', '-s', 'MODULARIZE=1',
    '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker',
    '-s', 'EXPORTED_RUNTIME_METHODS=["ccall"]',
    '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_webusb_cancel_regression","_webts_libusb_webusb_cancel_settle_regression","_webts_libusb_event_zero_timeout_smoke","_webts_libusb_webusb_pending_close_regression"]',
    '-o', $module, $harnessObject) + @($requiredObjects | ForEach-Object { Join-Path $config $_ })
Push-Location $repo
try {
    & $emxxExecutable @compile
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed compiling the cancellation harness.' }
    & $emxxExecutable @link
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed linking the cancellation Worker module.' }
} finally { Pop-Location }
$browserModule = Join-Path $output 'libusb-webusb-cancel-worker-browser.js'
$browserWasm = Join-Path $output 'libusb-webusb-cancel-worker.wasm'
$generatedWasm = Join-Path $output 'libusb-webusb-cancel-worker-generated.wasm'
foreach ($asset in @($browserModule, $browserWasm)) {
    if (Test-Path -LiteralPath $asset) { Remove-Item -LiteralPath $asset -Force }
}
Copy-Item -LiteralPath $module -Destination $browserModule
$text = (Get-Content -LiteralPath $browserModule -Raw).Replace(
    'libusb-webusb-cancel-worker-generated.wasm', 'libusb-webusb-cancel-worker.wasm')
Set-Content -LiteralPath $browserModule -Value $text -Encoding UTF8
Copy-Item -LiteralPath $generatedWasm -Destination $browserWasm
Remove-Item -LiteralPath $module -Force
Remove-Item -LiteralPath $generatedWasm -Force
$check = Get-Content -LiteralPath $browserModule -Raw
if ($check -notmatch 'Module\[["'']ccall["'']\]' -or
    $check -notmatch 'webts_libusb_webusb_cancel_regression' -or
    $check -notmatch 'webts_libusb_webusb_pending_close_regression' -or
    $check -match 'cancel-worker-generated\.wasm') {
    throw 'Cancellation Worker module contract is invalid.'
}
Write-Output "libusb cancellation Worker (test-only): $browserModule"
Write-Output "libusb cancellation Worker wasm: $browserWasm"
