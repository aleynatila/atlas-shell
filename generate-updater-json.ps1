param([string]$Version = "0.3.4")

# Paths
$nsisDir = "src-tauri\target\release\bundle\nsis"
$installerExe = Join-Path $nsisDir ([string]::Format("atlas_{0}_x64-setup.exe", $Version))
$updaterZip = Join-Path $nsisDir ([string]::Format("atlas_{0}_x64-setup.nsis.zip", $Version))
$sigFile = Join-Path $nsisDir ([string]::Format("atlas_{0}_x64-setup.nsis.zip.sig", $Version))

# URLs
$exeUrl = [string]::Format("https://github.com/aleynatila/atlas-shell/releases/download/v{0}/atlas_{0}_x64-setup.exe", $Version)
$zipUrl = [string]::Format("https://github.com/aleynatila/atlas-shell/releases/download/v{0}/atlas_{0}_x64-setup.nsis.zip", $Version)

# Default artifact URL -> installer exe. Switch to zip if present.
$artifactUrl = $exeUrl

if (-not (Test-Path $installerExe)) {
    Write-Error "Installer not found: $installerExe"
    exit 1
}

if (Test-Path $updaterZip) {
    $artifactUrl = $zipUrl
    Write-Host "Using updater artifact: $updaterZip"
}
else {
    Write-Warning ".nsis.zip not found - using installer .exe"
    Write-Warning "Set TAURI_SIGNING_PRIVATE_KEY and rebuild if you need signed updater artifacts"
}

# Read signature if present (minisign output), otherwise use empty string
$signature = ""
if (Test-Path $sigFile) {
    $signature = (Get-Content $sigFile -Raw -Encoding UTF8).Trim()
    Write-Host "Signature loaded from $sigFile"
}

$fileSize = (Get-Item $installerExe).Length
$fileHash = (Get-FileHash $installerExe -Algorithm SHA256).Hash.ToLower()

$jsonObj = @{
    version   = $Version
    notes     = "Atlas v$Version"
    pub_date  = ([DateTime]::UtcNow.ToString("o"))
    platforms = @{
        "windows-x86_64" = @{
            signature = $signature
            url       = $artifactUrl
        }
    }
}

$json = $jsonObj | ConvertTo-Json -Depth 4

# Write BOM-free UTF8
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "latest.json"), $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Generated latest.json for version $Version"
Write-Host "Artifact URL: $artifactUrl"
Write-Host "Installer Size: $fileSize bytes"
Write-Host "Installer SHA256: $fileHash"
