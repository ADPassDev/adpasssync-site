#Requires -Version 5.1
<#
.SYNOPSIS
    Publish the ADPassSync installers to R2 so the portal can serve them.
.DESCRIPTION
    The portal download (/api/portal/download) builds one ZIP from two R2
    objects in the adpasssync-installers bucket:

        current/ADPassSync-Setup.msi   <- INSTALLER_OBJECT_KEY (required)
        current/ADPassCredProv.msi     <- CREDPROV_OBJECT_KEY  (optional)

    Run this after `installer/build-msi.ps1` and
    `installer/credprov/build-credprov-msi.ps1` in the ADPassSync repo, so both
    packages move together and customers never get a ZIP with a stale
    credential provider in it.

    Note: `wrangler r2 object put` cannot set custom metadata, so the objects
    carry no `version` field and the ZIP README omits the version lines. Set
    the metadata from the R2 dashboard (or the S3 API, header
    `x-amz-meta-version`) if you want the versions shown.
.PARAMETER ProductRoot
    Path to the ADPassSync product repo (default: sibling ..\ADPassSync).
.PARAMETER Msi
    Explicit path to ADPassSync.msi. Overrides discovery under ProductRoot.
.PARAMETER CredProvMsi
    Explicit path to ADPassCredProv.msi. Overrides discovery under ProductRoot.
.PARAMETER SkipCredProv
    Publish only the server MSI.
.EXAMPLE
    pwsh -NoProfile -File scripts/publish-installers.ps1
    pwsh -NoProfile -File scripts/publish-installers.ps1 -ProductRoot E:\GitHub\ADPassSync
#>
param(
    [string]$ProductRoot,
    [string]$Msi,
    [string]$CredProvMsi,
    [switch]$SkipCredProv
)

$ErrorActionPreference = 'Stop'
$SiteRoot = Split-Path -Parent $PSScriptRoot
$Bucket = 'adpasssync-installers'

if (-not $ProductRoot) {
    $ProductRoot = Join-Path (Split-Path -Parent $SiteRoot) 'ADPassSync'
}

# Newest MSI matching $Filter under $Dir, or $null.
function Find-Msi([string]$Dir, [string]$Filter) {
    if (-not (Test-Path $Dir)) { return $null }
    Get-ChildItem -Path $Dir -Recurse -Filter $Filter -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\obj\\' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

if (-not $Msi) {
    $found = Find-Msi (Join-Path $ProductRoot 'installer\bin') 'ADPassSync.msi'
    if (-not $found) {
        throw "ADPassSync.msi not found under $ProductRoot\installer\bin. Build it first, or pass -Msi."
    }
    $Msi = $found.FullName
}
if (-not (Test-Path $Msi)) { throw "Not found: $Msi" }

if (-not $SkipCredProv -and -not $CredProvMsi) {
    $found = Find-Msi (Join-Path $ProductRoot 'installer\credprov\bin') 'ADPassCredProv.msi'
    if (-not $found) {
        throw "ADPassCredProv.msi not found under $ProductRoot\installer\credprov\bin. Build it first, pass -CredProvMsi, or use -SkipCredProv."
    }
    $CredProvMsi = $found.FullName
}
if ($CredProvMsi -and -not (Test-Path $CredProvMsi)) { throw "Not found: $CredProvMsi" }

function Publish-Object([string]$Path, [string]$Key) {
    $size = [math]::Round((Get-Item $Path).Length / 1MB, 1)
    Write-Host "-> $Bucket/$Key  ($size MB)" -ForegroundColor Cyan
    Write-Host "   $Path" -ForegroundColor DarkGray
    & npx --yes wrangler r2 object put "$Bucket/$Key" `
        --file "$Path" `
        --content-type 'application/x-msi' `
        --remote
    if ($LASTEXITCODE -ne 0) { throw "upload failed: $Key" }
}

Push-Location $SiteRoot
try {
    Publish-Object $Msi 'current/ADPassSync-Setup.msi'
    if ($CredProvMsi) {
        Publish-Object $CredProvMsi 'current/ADPassCredProv.msi'
    } else {
        Write-Host "Skipping credential provider (-SkipCredProv)." -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Published. Sign in to the portal and download to confirm the ZIP' -ForegroundColor Green
Write-Host 'now contains both MSIs.' -ForegroundColor Green
