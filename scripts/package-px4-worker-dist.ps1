[CmdletBinding()]
param(
    [string]$SourceDirectory = 'build/upstream-wasm',
    [string]$DistDirectory = 'dist/build/upstream-wasm'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = [IO.Path]::GetFullPath((Join-Path $repo $SourceDirectory))
$dist = [IO.Path]::GetFullPath((Join-Path $repo $DistDirectory))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\') + '\'
$distRoot = [IO.Path]::GetFullPath((Join-Path $repo 'dist')).TrimEnd('\') + '\'
if (-not $source.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "SourceDirectory must be under repo build/: $source"
}
if (-not $dist.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "DistDirectory must be under repo dist/: $dist"
}

$assets = @(
    'px4-stream-lifecycle-worker-browser.js',
    'px4-stream-lifecycle-worker.js',
    'px4-stream-lifecycle-worker.wasm'
)
$manifestPath = Join-Path $source 'px4-stream-lifecycle-worker.manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Missing PX4 Worker provenance manifest: $manifestPath. Rebuild the Worker module first."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $null -eq $manifest.sourceFiles -or
    $null -eq $manifest.linkedObjects -or $null -eq $manifest.assets) {
    throw "Invalid PX4 Worker provenance manifest: $manifestPath"
}
try {
    & (Join-Path $PSScriptRoot 'check-vendor-sources.ps1')
} catch {
    throw "Vendor source lock verification failed before packaging the PX4 Worker: $($_.Exception.Message)"
}
foreach ($sourceEntry in @($manifest.sourceFiles)) {
    if ([IO.Path]::IsPathRooted([string]$sourceEntry.path)) {
        throw "Absolute provenance path is not allowed: $($sourceEntry.path)"
    }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $repo ([string]$sourceEntry.path)))
    $repoPrefix = [IO.Path]::GetFullPath($repo).TrimEnd('\') + '\'
    if (-not $sourcePath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Missing PX4 Worker provenance input: $($sourceEntry.path)"
    }
    $actualHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$sourceEntry.sha256).ToLowerInvariant()) {
        throw "PX4 Worker source is newer than the generated asset manifest: $($sourceEntry.path)"
    }
}
$buildPrefix = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\') + '\'
foreach ($objectEntry in @($manifest.linkedObjects)) {
    if ([IO.Path]::IsPathRooted([string]$objectEntry.path)) {
        throw "Absolute linked-object path is not allowed: $($objectEntry.path)"
    }
    $objectPath = [IO.Path]::GetFullPath((Join-Path $repo ([string]$objectEntry.path)))
    if (-not $objectPath.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $objectPath -PathType Leaf)) {
        throw "Missing linked object from PX4 Worker manifest: $($objectEntry.path)"
    }
    $actualHash = (Get-FileHash -LiteralPath $objectPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$objectEntry.sha256).ToLowerInvariant()) {
        throw "Linked object changed after the PX4 Worker build: $($objectEntry.path)"
    }
}
$manifestAssetNames = @($manifest.assets | ForEach-Object { [string]$_.name })
$manifestAssetSet = (@($manifestAssetNames | Sort-Object) -join '|')
$allowedAssetSet = (@($assets | Sort-Object) -join '|')
if ($manifestAssetSet -ne $allowedAssetSet) {
    throw 'PX4 Worker provenance manifest asset set does not match the allowlist.'
}
foreach ($asset in $assets) {
    $path = Join-Path $source $asset
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing generated PX4 Worker asset: $path. Run build-px4-stream-lifecycle-worker.ps1 first."
    }
    $manifestAsset = @($manifest.assets | Where-Object { $_.name -eq $asset })[0]
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$manifestAsset.sha256).ToLowerInvariant()) {
        throw "PX4 Worker asset hash does not match its manifest: $asset"
    }
}

$browserText = Get-Content -LiteralPath (Join-Path $source $assets[0]) -Raw
if ($browserText -match 'px4-stream-lifecycle-worker-generated\.(js|wasm)' -or
    $browserText -notmatch 'px4-stream-lifecycle-worker\.js' -or
    $browserText -notmatch 'px4-stream-lifecycle-worker\.wasm' -or
    $browserText -notmatch 'webts_px4_stream_lifecycle_mock') {
    throw 'PX4 Worker browser module has a stale helper/WASM reference or missing lifecycle export.'
}

New-Item -ItemType Directory -Path $dist -Force | Out-Null
foreach ($asset in $assets) {
    $destination = Join-Path $dist $asset
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Force
    }
    Copy-Item -LiteralPath (Join-Path $source $asset) -Destination $destination
}

$unexpected = Get-ChildItem -LiteralPath $dist -File -Filter 'px4-stream-lifecycle-worker-*' |
    Where-Object { $_.Name -notin $assets }
if ($unexpected) {
    $names = ($unexpected | Select-Object -ExpandProperty Name) -join ', '
    throw "Unexpected PX4 Worker assets in dist package: $names"
}

foreach ($asset in $assets) {
    $destination = Join-Path $dist $asset
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or
        (Get-Item -LiteralPath $destination).Length -le 0) {
        throw "Packaged PX4 Worker asset is missing or empty: $destination"
    }
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $source $asset) -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $destinationHash) {
        throw "Packaged PX4 Worker asset hash mismatch: $asset"
    }
}
Write-Output "PX4 Worker production assets packaged: $dist"
Write-Output ($assets -join ', ')
