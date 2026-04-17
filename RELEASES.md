# Release Instructions

## Automated Releases (Recommended)

Releases are automatically built and published to GitHub Releases using GitHub Actions.

### Creating a Release

1. **Update version in `src-tauri/tauri.conf.json`:**

   ```json
   {
     "package": {
       "version": "0.2.0"
     }
   }
   ```

2. **Create a git tag:**

   ```powershell
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. **GitHub Actions will automatically:**
   - Build the release on Windows runner
   - Create NSIS installer (.exe file)
   - Upload to GitHub Releases

### Manual Release (If needed)

1. **Build locally:**

   ```powershell
   npm run tauri:build
   ```

2. **Find the .exe file:**

   ```
   src-tauri/target/release/bundle/nsis/atlas_X.Y.Z_x64-setup.exe
   ```

3. **Upload to GitHub Releases:**
   - Go to [Releases](https://github.com/aleynatila/atlas-shell/releases)
   - Click "Draft a new release"
   - Tag: `vX.Y.Z`
   - Title: `Release X.Y.Z`
   - Upload the `.exe` file
   - Publish

## Release Files

- **atlas_X.Y.Z_x64-setup.exe** — Windows NSIS installer with wizard
- Generated at: `src-tauri/target/release/bundle/nsis/`

## Notes

- The installer will use the version from `tauri.conf.json`
- Old releases remain available for download on the Releases page
- Users can download and run installers without building from source
