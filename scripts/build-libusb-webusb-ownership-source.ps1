[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

# Test-only. Produces ignored build copies of the pinned official
# emscripten_webusb.cpp and io.c with the WebTS.app transfer-ownership patch
# applied. The pristine vendor tree is never modified, and the patched copies
# are not an M1, production, or real-USB path.
#
# Emits two absolute paths: the patched backend, then the patched core io.c.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vendorDirectory = Join-Path $repo 'vendor/upstream/libusb-1.0.30/libusb'
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\') + '\'
if (-not $output.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be under repo build/: $output"
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Read-NormalizedText([string]$path) {
    return ([IO.File]::ReadAllText($path)).Replace("`r`n", "`n").TrimEnd("`n")
}

function New-PatchedCopy(
    [string]$SourcePath, [string]$PatchDirectory, [string]$DestinationName,
    [string[]]$MustNotMatch, [string[]]$MustMatch
) {
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Missing pinned official source: $SourcePath"
    }
    $text = ([IO.File]::ReadAllText($SourcePath)).Replace("`r`n", "`n")
    $pairs = Get-ChildItem -LiteralPath $PatchDirectory -Filter '*.needle' | Sort-Object Name
    if ($pairs.Count -eq 0) { throw "No patch pairs found in $PatchDirectory" }
    foreach ($needleFile in $pairs) {
        $replacementFile = [IO.Path]::ChangeExtension($needleFile.FullName, '.replacement')
        if (-not (Test-Path -LiteralPath $replacementFile -PathType Leaf)) {
            throw "Missing replacement for $($needleFile.Name)"
        }
        $needle = Read-NormalizedText $needleFile.FullName
        $replacement = Read-NormalizedText $replacementFile
        $occurrences = ([regex]::Matches($text, [regex]::Escape($needle))).Count
        if ($occurrences -ne 1) {
            throw "Patch hunk $($needleFile.Name) matched $occurrences times in the pinned source; expected exactly 1."
        }
        $text = $text.Replace($needle, $replacement)
    }
    foreach ($pattern in $MustNotMatch) {
        if ($text -match $pattern) { throw "Patched copy of $DestinationName still matches '$pattern'." }
    }
    foreach ($pattern in $MustMatch) {
        if ($text -notmatch $pattern) { throw "Patched copy of $DestinationName is missing '$pattern'." }
    }
    $destination = Join-Path $output $DestinationName
    [IO.File]::WriteAllText($destination, $text, [Text.UTF8Encoding]::new($false))
    return $destination
}

# 1. Backend: the WebUSB promise callback must own shared state instead of a
#    raw usbi_transfer*, and cancellation must deliver one bounded completion.
$backend = New-PatchedCopy `
    -SourcePath (Join-Path $vendorDirectory 'os/emscripten_webusb.cpp') `
    -PatchDirectory (Join-Path $PSScriptRoot 'libusb-ownership-patch') `
    -DestinationName 'emscripten_webusb-ownership.cpp' `
    -MustNotMatch @('ValPtr<PromiseResult>', 'sizeof\(PromiseResult\)') `
    -MustMatch @('TransferSharedState', 'webts_libusb_em_late_after_detach_count')

# 2. Core: disconnect must reclaim a completion the backend already queued, so
#    a transfer is completed exactly once across the two paths.
$core = New-PatchedCopy `
    -SourcePath (Join-Path $vendorDirectory 'io.c') `
    -PatchDirectory (Join-Path $PSScriptRoot 'libusb-ownership-patch-io') `
    -DestinationName 'io-ownership.c' `
    -MustNotMatch @() `
    -MustMatch @('WebTS\.app test-only ownership patch', 'to_cancel->completed_list\.next != NULL')

Write-Output $backend
Write-Output $core
