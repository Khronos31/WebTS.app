[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [int]$TimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fastBuild = Join-Path $repo 'build/libusb-webusb-cancel-worker-zero-fastpath'
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/libusb-webusb-pending-close-regression'))
$config = Join-Path $repo 'build/libusb-webusb-nopthread'
$vendor = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$emxxExecutable = if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    (Get-Command em++ -ErrorAction Stop).Source
} else { [IO.Path]::GetFullPath($EmxxPath) }
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) { throw "Missing em++: $emxxExecutable" }
$emccExecutable = Join-Path (Split-Path -Parent $emxxExecutable) 'emcc.exe'
if (-not (Test-Path -LiteralPath $emccExecutable -PathType Leaf)) { throw "Missing matching emcc: $emccExecutable" }

& (Join-Path $PSScriptRoot 'build-libusb-webusb-cancel-worker-zero-fastpath.ps1') -EmxxPath $emxxExecutable
$patchedEvents = Join-Path $fastBuild 'events_posix-zero-fastpath.c'
if (-not (Test-Path -LiteralPath $patchedEvents -PathType Leaf)) { throw 'Missing ignored fast-path source copy.' }
foreach ($name in @('core.o','descriptor.o','emscripten_webusb.o','hotplug.o','io.o','strerror.o','sync.o','threads_posix.o')) {
    if (-not (Test-Path -LiteralPath (Join-Path $config $name) -PathType Leaf)) { throw "Missing no-pthread object: $name" }
}
New-Item -ItemType Directory -Force -Path $build | Out-Null
$source = Join-Path $repo 'scripts/libusb-webusb-cancel-regression.cpp'
$eventsObject = Join-Path $build 'events_posix-zero-fastpath.o'
$harnessObject = Join-Path $build 'libusb-webusb-cancel-regression.o'
$module = Join-Path $build 'libusb-webusb-pending-close-regression.js'
$compile = @('-O0','-I',$config,'-I',$vendor,'-DPLATFORM_POSIX=1','-DOS_EMSCRIPTEN=1','-DENABLE_LOGGING=1','-matomics','-mbulk-memory')
Push-Location $repo
try {
    & $emccExecutable @compile '-c' $patchedEvents '-o' $eventsObject
    if ($LASTEXITCODE -ne 0) { throw 'emcc failed compiling the patched event source.' }
    & $emxxExecutable @compile '-std=c++20' '-c' $source '-o' $harnessObject
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed compiling the pending-close harness.' }
    $link = @('--bind','-s','ASYNCIFY=1','-s','ASSERTIONS=2','-s','MODULARIZE=1','-s','EXPORT_ES6=1','-s','ENVIRONMENT=node',
        '-s','EXPORTED_RUNTIME_METHODS=["ccall"]',
        '-s','EXPORTED_FUNCTIONS=["_webts_libusb_webusb_pending_close_regression"]',
        '-o',$module,$harnessObject,$eventsObject) + @('core.o','descriptor.o','emscripten_webusb.o','hotplug.o','io.o','strerror.o','sync.o','threads_posix.o' | ForEach-Object { Join-Path $config $_ })
    & $emxxExecutable @link
    if ($LASTEXITCODE -ne 0) { throw 'em++ failed linking the pending-close Node module.' }
} finally { Pop-Location }
$node = Get-Command node -ErrorAction Stop
$runner = Join-Path $repo 'scripts/libusb-webusb-pending-close-regression-runner.mjs'
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
    throw "Pending-close regression exceeded ${TimeoutMilliseconds}ms."
}
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
if ($process.ExitCode -ne 0) { throw "Pending-close regression failed: stdout=$stdout stderr=$stderr" }
if (-not [string]::IsNullOrWhiteSpace($stderr)) { throw "Pending-close regression stderr: $stderr" }
$report = $stdout.Trim() | ConvertFrom-Json
if ($report.diagnostic -ne 'OBSERVED' -or $report.callbacks -ne 0 -or
    $report.status -ne 255 -or $report.closeReturned -ne $true -or
    $report.fakeTransferInCalls -ne 1) {
    throw "Unexpected pending-close report: $stdout"
}
Write-Output $stdout.Trim()
