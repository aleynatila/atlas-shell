# Generate latest.json for Tauri updater
# Usage: .\generate-updater-json.ps1 -Version "0.3.1"

param([string]$Version = "0.3.1")

$installerPath = "src-tauri\target\release\bundle\nsis\atlas_${Version}_x64-setup.exe"
$installerUrl = "https://github.com/aleynatila/atlas-shell/releases/download/v${Version}/atlas_${Version}_x64-setup.exe"

if (-not (Test-Path $installerPath)) {
    Write-Error "Installer not found: $installerPath"
    exit 1
}

$fileSize = (Get-Item $installerPath).Length
$fileHash = (Get-FileHash $installerPath -Algorithm SHA256).Hash.ToLower()

$json = @{
    version  = $Version
    notes    = "Atlas v${Version}"
    pub_date = ([DateTime]::UtcNow.ToString("o"))
    platforms = @{
        "windows-x86_64" = @{
            signature = ""
            url       = $installerUrl
        }
    }
} | ConvertTo-Json -Depth 3

# Use UTF8Encoding($false) to avoid BOM (both Out-File -Encoding UTF8 and Encoding::UTF8 add BOM on Windows)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "latest.json"), $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Generated latest.json for version $Version"
Write-Host "Installer URL: $installerUrl"
Write-Host "Installer Size: $fileSize bytes"
Write-Host "Installer SHA256: $fileHash"
