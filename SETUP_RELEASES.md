# GitHub Releases Setup

## What's Been Set Up

✅ **GitHub Actions Workflow** (`.github/workflows/release.yml`)

- Automatically builds release .exe installer on git tag push
- Uploads to GitHub Releases
- No manual steps needed after tagging

✅ **Release .exe Created** (`atlas_0.1.0_x64-setup.exe`)

- 2.36 MB NSIS installer with wizard
- Located at: `src-tauri/target/release/bundle/nsis/`

✅ **Documentation Updated**

- README.md includes download instructions
- RELEASES.md has release process guide
- .gitignore prevents build artifacts from being committed

## Next Steps

### Option 1: Automatic Release (Recommended)

```powershell
# Update version in src-tauri/tauri.conf.json
# Example: "version": "0.1.0" → "0.1.1"

# Commit and tag
git add .
git commit -m "Release 0.1.1"
git tag v0.1.1
git push origin main --tags

# GitHub Actions will automatically:
# 1. Build the release
# 2. Create atlas_0.1.1_x64-setup.exe
# 3. Upload to Releases page
```

### Option 2: Manual Release Upload

If you have an .exe file ready:

1. Go to: https://github.com/aleynatila/atlas-shell/releases
2. Click "Create a new release"
3. Tag version: v0.1.0
4. Upload: `src-tauri/target/release/bundle/nsis/atlas_0.1.0_x64-setup.exe`
5. Publish

## Distribute to Users

Users can download the .exe directly from:

```
https://github.com/aleynatila/atlas-shell/releases
```

They simply:

1. Download the latest `.exe` file
2. Run the installer wizard
3. Launch Atlas SSH Client from Start Menu

---

**Note:** Replace `aleynatila` in README.md and links with your actual GitHub username.
