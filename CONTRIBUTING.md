# Contributing to Atlas SSH Client

## Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable, 1.76+)
- [Node.js](https://nodejs.org/) 18+
- Windows build tools (MSVC / Visual Studio Build Tools)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### Getting Started

```powershell
# Clone the repository
git clone https://github.com/aleynatila/atlas-shell.git
cd atlas-shell

# Install dependencies
npm install

# Run development server
npm run tauri:dev
```

## Project Structure

```
atlas/
├── .github/workflows/        # GitHub Actions CI/CD
├── src/                      # React + TypeScript
│   ├── App.tsx               # Main component
│   ├── main.tsx              # React entry point
│   ├── index.css             # Global styles
│   └── themes.ts             # Color themes
├── src-tauri/                # Tauri + Rust backend
│   ├── src/main.rs           # SSH/SFTP server
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri config
├── docs/                     # Documentation
└── data/                     # Data & seed scripts
```

## Code Style

- **TypeScript**: Use strict mode, avoid `any`
- **React**: Functional components with hooks
- **Rust**: Follow `cargo fmt` and `cargo clippy`
- **CSS**: Tailwind utility classes

## Making Changes

1. **Create a branch:**

   ```powershell
   git checkout -b feature/your-feature
   ```

2. **Make your changes:**
   - Keep commits atomic and well-described
   - Follow the existing code style
   - Test locally with `npm run tauri:dev`

3. **Build and test:**

   ```powershell
   npm run build         # TypeScript
   cargo check          # Rust
   npm run tauri:build  # Full release build
   ```

4. **Push and create PR:**
   ```powershell
   git push origin feature/your-feature
   ```

## Release Process

Releases are automated via GitHub Actions. To create a release:

1. Update version in `src-tauri/tauri.conf.json`:

   ```json
   "version": "0.2.0"
   ```

2. Commit and tag:

   ```powershell
   git add .
   git commit -m "Bump version to 0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```

3. GitHub Actions will automatically:
   - Build the release
   - Create installer (.exe)
   - Upload to Releases page

## Reporting Issues

- Include your OS and version
- Describe steps to reproduce
- Attach error messages/logs if applicable
- Share your SSH session config (without credentials)

## Questions?

Open an issue or check [RELEASES.md](./RELEASES.md) for release info or [README.md](./README.md) for features overview.
