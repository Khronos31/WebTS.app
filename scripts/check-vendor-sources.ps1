[CmdletBinding()]
param(
    [switch]$WriteLock
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $repo 'vendor\upstream'
$lockPath = Join-Path $repo 'vendor\SOURCE_LOCK.json'

$definitions = @(
    [pscustomobject]@{ Name = 'siano-userland'; Root = 'siano-userland'; Commit = 'eb73192e4e6dbdc4b84502ccfc5ec14f5ce86c86'; Origin = 'https://github.com/Khronos31/siano-userland.git'; License = 'GPL-2.0-or-later' },
    [pscustomobject]@{ Name = 'px4-userland'; Root = 'px4-userland'; Commit = '10a373dbda0603b2d8180bb2508e2d88dd70eb2d'; Origin = 'https://github.com/Khronos31/px4-userland.git'; License = 'GPL-2.0-only' },
    [pscustomobject]@{ Name = 'libusb-1.0.30'; Root = 'libusb-1.0.30'; Commit = '87a55632db62c9bdc58cd31d3ccfa673f1bb017f'; Origin = 'https://github.com/libusb/libusb.git'; License = 'LGPL-2.1-or-later' },
    [pscustomobject]@{ Name = 'libaribb25'; Root = 'libaribb25'; Commit = 'b978fe5caf6bfe162e944ad4d323b7c0205276e3'; Origin = 'https://github.com/shirow-github/libaribb25.git'; License = 'ISC' }
)

function Get-SourceFiles([string]$root) {
    $rootPath = Join-Path $vendor $root
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { throw "Missing vendor root: $root" }
    @(Get-ChildItem -LiteralPath $rootPath -Recurse -File | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($rootPath.Length + 1).Replace('\', '/')
        [pscustomobject]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
}

function Get-LockObject {
    [pscustomobject]@{
        schema = 1
        generatedBy = 'scripts/check-vendor-sources.ps1'
        sources = @($definitions | ForEach-Object {
            [pscustomobject]@{ name = $_.Name; origin = $_.Origin; commit = $_.Commit; license = $_.License; root = $_.Root; files = @(Get-SourceFiles $_.Root) }
        })
    }
}

if ($WriteLock) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
    Get-LockObject | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $lockPath -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { throw "Missing lock file: $lockPath" }
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
foreach ($source in $lock.sources) {
    $rootPath = Join-Path $vendor $source.root
    $expectedPaths = @($source.files | ForEach-Object { $_.path } | Sort-Object)
    $actualPaths = @(Get-ChildItem -LiteralPath $rootPath -Recurse -File | ForEach-Object {
        $_.FullName.Substring($rootPath.Length + 1).Replace('\', '/')
    } | Sort-Object)
    if ($expectedPaths.Count -ne $actualPaths.Count -or
        (Compare-Object -ReferenceObject $expectedPaths -DifferenceObject $actualPaths)) {
        throw "Locked file set mismatch: $($source.name)"
    }
    foreach ($file in $source.files) {
        $path = Join-Path $rootPath ($file.path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing locked file: $($source.name)/$($file.path)" }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $file.sha256) { throw "Checksum mismatch: $($source.name)/$($file.path)" }
    }
    Get-ChildItem -LiteralPath $rootPath -Recurse -File | ForEach-Object {
        if ($_.Name -match '(?i)^firmware' -or $_.Extension -match '(?i)^\.(bin|elf|exe|dll|so|a|o)$') {
            throw "Forbidden firmware/binary in vendor snapshot: $($_.FullName)"
        }
    }
}
Write-Output "vendor source lock verified: $($lock.sources.Count) roots"
