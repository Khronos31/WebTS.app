[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [string]$OutputDirectory = 'build/libusb-webusb-cancel-worker-zero-fastpath'
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
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) { throw "Missing em++: $emxxExecutable" }
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) { throw "Missing matching emcc: $emccExecutable" }
$config = Join-Path $repo 'build/libusb-webusb-nopthread'
$vendor = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$eventsSource = Join-Path $vendor 'os/events_posix.c'
$checker = Join-Path $PSScriptRoot 'check-vendor-sources.ps1'
& $checker
$requiredObjects = @('core.o', 'descriptor.o', 'emscripten_webusb.o', 'hotplug.o',
    'io.o', 'strerror.o', 'sync.o', 'threads_posix.o')
foreach ($name in $requiredObjects) {
    if (-not (Test-Path -LiteralPath (Join-Path $config $name) -PathType Leaf)) {
        throw "Missing official object: $name. Build the no-pthread overlay first."
    }
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

# Keep the pristine vendor tree untouched. The only source mutation is an
# ignored build copy, and the exact upstream text is checked before replacing.
$patchedSource = Join-Path $output 'events_posix-zero-fastpath.c'
$sourceText = [IO.File]::ReadAllText($eventsSource)
$needle = "static void em_libusb_wait(const _Atomic int *ptr, int expected_value, int timeout)`n{`n`tif (emscripten_is_main_runtime_thread()) {"
$replacement = "static void em_libusb_wait(const _Atomic int *ptr, int expected_value, int timeout)`n{`n`t/* Test-only fast path: poll(0) is already non-blocking. */`n`tif (timeout <= 0)`n`t`treturn;`n`tif (emscripten_is_main_runtime_thread()) {"
$normalized = $sourceText.Replace("`r`n", "`n")
if (-not $normalized.Contains($needle)) { throw 'events_posix.c fast-path context did not match the pinned upstream source.' }
$patched = $normalized.Replace($needle, $replacement)
[IO.File]::WriteAllText($patchedSource, $patched, [Text.UTF8Encoding]::new($false))

$harnessSource = Join-Path $repo 'scripts/libusb-webusb-cancel-regression.cpp'
$harnessObject = Join-Path $output 'libusb-webusb-cancel-regression.o'
$eventsObject = Join-Path $output 'events_posix-zero-fastpath.o'
$module = Join-Path $output 'libusb-webusb-cancel-worker-zero-fastpath-generated.js'
$compileArgs = @('-O0', '-I', $config, '-I', $vendor, '-DPLATFORM_POSIX=1', '-DOS_EMSCRIPTEN=1',
    '-DENABLE_LOGGING=1', '-matomics', '-mbulk-memory')
Push-Location $repo
try {
    & $emccExecutable @compileArgs '-c' $patchedSource '-o' $eventsObject
    if ($LASTEXITCODE -ne 0) { throw 'emcc failed compiling the zero-timeout fast-path copy.' }
    & $emxxExecutable @compileArgs '-std=c++20' '-c' $harnessSource '-o' $harnessObject
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed compiling the cancellation harness.' }
    $link = @('--bind', '-s', 'ASYNCIFY=1', '-s', 'ASSERTIONS=2', '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_ES6=1', '-s', 'ENVIRONMENT=web,worker',
        '-s', 'EXPORTED_RUNTIME_METHODS=["ccall"]',
        '-s', 'EXPORTED_FUNCTIONS=["_webts_libusb_webusb_cancel_regression","_webts_libusb_webusb_cancel_settle_regression","_webts_libusb_event_zero_timeout_smoke","_webts_libusb_webusb_cancel_user_free_regression","_webts_libusb_webusb_pending_close_regression"]',
        '-o', $module, $harnessObject, $eventsObject) + @($requiredObjects | ForEach-Object { Join-Path $config $_ })
    & $emxxExecutable @link
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed linking the zero-timeout fast-path Worker module.' }
} finally { Pop-Location }

$browserModule = Join-Path $output 'libusb-webusb-cancel-worker-zero-fastpath-browser.js'
$browserWasm = Join-Path $output 'libusb-webusb-cancel-worker-zero-fastpath.wasm'
$generatedWasm = Join-Path $output 'libusb-webusb-cancel-worker-zero-fastpath-generated.wasm'
Copy-Item -LiteralPath $module -Destination $browserModule -Force
$text = [IO.File]::ReadAllText($browserModule).Replace(
    'libusb-webusb-cancel-worker-zero-fastpath-generated.wasm',
    'libusb-webusb-cancel-worker-zero-fastpath.wasm')
[IO.File]::WriteAllText($browserModule, $text, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $generatedWasm -Destination $browserWasm -Force
Remove-Item -LiteralPath $module -Force
Remove-Item -LiteralPath $generatedWasm -Force
Write-Output "experimental zero-timeout fast-path Worker: $browserModule"
Write-Output "experimental wasm: $browserWasm"
