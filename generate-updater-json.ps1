# Generate latest.json for Tauri updater
# Usage: .\generate-updater-json.ps1 -Version "0.3.4"
#
# Prerequisites:
#   Set TAURI_SIGNING_PRIVATE_KEY before building so Tauri generates .nsis.zip + .nsis.zip.sig:
#     $env:TAURI_SIGNING_PRIVATE_KEY = "<base64-private-key>"
#     npm run tauri:build
#
# The build produces:
#   atlas_VERSION_x64-setup.exe          (full installer for fresh installs)
#   atlas_VERSION_x64-setup.nsis.zip     (updater artifact — smaller, for in-app updates)
#   atlas_VERSION_x64-setup.nsis.zip.sig (minisign signature for the zip)
#
# Upload all three to the GitHub release.

param([string]$Version = "0.3.4")

$nsisDir      = "src-tauri\target\release\bundle\nsis"
$installerExe = "$nsisDir\atlas_${Version}_x64-setup.exe"
$updaterZip   = "$nsisDir\atlas_${Version}_x64-setup.nsis.zip"
$sigFile      = "$nsisDir\atlas_${Version}_x64-setup.nsis.zip.sig"

$exeUrl       = "https://github.com/aleynatila/atlas-shell/releases/download/v${Version}/atlas_${Version}_x64-setup.exe"
$zipUrl       = "https://github.com/aleynatila/atlas-shell/releases/download/v${Version}/atlas_${Version}_x64-setup.nsis.zip"

if (-not (Test-Path $installerExe)) {
    Write-Error "Installer not found: $installerExe"
    exit 1
}

# The Tauri updater uses the .nsis.zip artifact (not the .exe) and verifies it with the .sig file.
if (-not (Test-Path $updaterZip)) {
    Write-Warning ".nsis.zip not found — updater artifact was not generated."
    Write-Warning "Set TAURI_SIGNING_PRIVATE_KEY and rebuild: `$env:TAURI_SIGNING_PRIVATE_KEY='<key>'; npm run tauri:build"
    Write-Warning "Falling back to .exe URL (updater signature verification will fail without a valid signature)."
    $artifactUrl = $exeUrl
} else {
    $artifactUrl = $zipUrl
    Write-Host "Using updater artifact: $updaterZip"
}

# Read the minisign signature from the .sig file (produced by Tauri build with signing key set).
$signature = ""
if (Test-Path $sigFile) {
    $signature = (Get-Content $sigFile -Raw -Encoding UTF8).Trim()
    Write-Host "Signature loaded from $sigFile"
} else {
    Write-Warning ".sig file not found — signature will be empty."
    Write-Warning "The Tauri updater WILL REJECT the update without a valid signature."
}

$fileSize = (Get-Item $installerExe).Length
$fileHash = (Get-FileHash $installerExe -Algorithm SHA256).Hash.ToLower()

$json = @{
    version  = $Version
    notes    = "Atlas v${Version}"
    pub_date = ([DateTime]::UtcNow.ToString("o"))
    platforms = @{
        "windows-x86_64" = @{
            signature = $signature
            url       = $artifactUrl
        }
    }
} | ConvertTo-Json -Depth 3

# Use UTF8Encoding($false) to avoid BOM (both Out-File -Encoding UTF8 and Encoding::UTF8 add BOM on Windows)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "latest.json"), $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Generated latest.json for version $Version"
Write-Host "Artifact URL: $artifactUrl"
Write-Host "Installer Size: $fileSize bytes"
Write-Host "Installer SHA256: $fileHash"
