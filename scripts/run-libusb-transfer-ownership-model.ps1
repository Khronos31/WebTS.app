[CmdletBinding()]
param(
    [string]$EmxxPath = '',
    [int]$TimeoutMilliseconds = 10000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $repo 'build/upstream-wasm'))
$module = Join-Path $build 'libusb-transfer-ownership-model.js'
$emxxExecutable = if ([string]::IsNullOrWhiteSpace($EmxxPath)) {
    $command = Get-Command em++ -ErrorAction Stop
    $command.Source
} else { [IO.Path]::GetFullPath($EmxxPath) }
if (-not (Test-Path -LiteralPath $emxxExecutable -PathType Leaf)) { throw "Missing em++: $emxxExecutable" }
Push-Location $repo
try {
    $compilerArgs = @(
        (Join-Path $repo 'scripts/libusb-transfer-ownership-model.cpp'), '-O0',
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node',
        '-sEXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
        '-sEXPORTED_FUNCTIONS=["_webts_libusb_transfer_ownership_model","_malloc","_free"]',
        '-o', $module
    )
    & $emxxExecutable @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Emscripten model build failed.' }
    $node = Get-Command node -ErrorAction Stop
    $runner = Join-Path $repo 'scripts/libusb-transfer-ownership-model-runner.mjs'
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
        throw "Ownership model exceeded ${TimeoutMilliseconds}ms."
    }
    $process.Refresh()
    if ($null -eq $process.ExitCode -or $process.ExitCode -ne 0) {
        throw "Ownership model process exited with code $($process.ExitCode)."
    }
    $result = $process.StandardOutput.ReadToEnd()
    if ($result -notmatch '"diagnostic":"OK"') { throw "Ownership model failed: $result" }
    $errorOutput = $process.StandardError.ReadToEnd()
    if (-not [string]::IsNullOrWhiteSpace($errorOutput)) { throw "Ownership model stderr: $errorOutput" }
    Write-Output $result.Trim()
} finally {
    Pop-Location
}
