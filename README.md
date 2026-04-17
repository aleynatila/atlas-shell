<div align="center">

# ◆ Atlas SSH Client

**A fast, modern, native SSH client built with Tauri + React**

![Version](https://img.shields.io/badge/version-0.1.0-00E5FF?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-00E5FF?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-00E5FF?style=flat-square)
![Rust](https://img.shields.io/badge/rust-1.76+-orange?style=flat-square)
![React](https://img.shields.io/badge/react-18-blue?style=flat-square)

</div>

---

## Screenshots

<div align="center">

<!-- Screenshot 1: Overview / Session List -->
<img src="docs/screenshots/overview.png" alt="Overview – Session List" width="100%" />
<sub>Session overview with search and accent colors</sub>

<br /><br />

<!-- Screenshot 2: Terminal (connected) -->
<img src="docs/screenshots/terminal.png" alt="Terminal – Connected SSH Session" width="100%" />
<sub>Terminal with ANSI colors, font rendering, and quick commands bar</sub>

<br /><br />

<!-- Screenshot 3: Split view -->
<img src="docs/screenshots/split.png" alt="Split Terminal View" width="100%" />
<sub>Horizontal split — two sessions side by side</sub>

<br /><br />

<!-- Screenshot 4: Settings -->
<img src="docs/screenshots/settings.png" alt="Settings Panel" width="100%" />
<sub>Settings panel — manage sessions, credentials, scripts</sub>

<br /><br />

<!-- Screenshot 5: SFTP drag-drop -->
<img src="docs/screenshots/sftp.png" alt="SFTP File Transfer" width="100%" />
<sub>Drag-and-drop SFTP file upload with live progress</sub>

</div>

---

## Features

| Feature                   | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| **Multi-tab SSH**         | Open multiple SSH sessions simultaneously, switch instantly                 |
| **Split Terminal**        | Side-by-side or stacked terminal panes                                      |
| **SFTP Drag & Drop**      | Drag files from Explorer onto the terminal to upload via SFTP               |
| **Session Management**    | Save sessions with labels, colors, groups; import from Solar-PuTTY          |
| **Credentials Vault**     | Reusable credentials (user/pass/key) linked to sessions                     |
| **Quick Commands**        | Configurable command bar — one click sends a command to the active terminal |
| **Script Library**        | Save and run multi-line scripts on any session                              |
| **PuTTY-style Clipboard** | Auto-copy on selection, right-click to paste                                |
| **Custom Title Bar**      | Frameless window with built-in minimize/maximize/close controls             |
| **Dark UI**               | Neon-accented dark theme with per-session accent colors                     |
| **Auto-connect**          | Sessions can be configured to connect on open                               |
| **Solar-PuTTY Import**    | Import sessions and credentials from Solar-PuTTY JSON export                |

---

## Tech Stack

| Layer                 | Technology                                                 |
| --------------------- | ---------------------------------------------------------- |
| **Shell/Desktop**     | [Tauri](https://tauri.app) v1.8 (Rust)                     |
| **Frontend**          | React 18 + TypeScript                                      |
| **Terminal Emulator** | [xterm.js](https://xtermjs.org) v5.3 + FitAddon            |
| **SSH / SFTP**        | [ssh2](https://crates.io/crates/ssh2) Rust crate (libssh2) |
| **Styling**           | Tailwind CSS v4                                            |
| **Icons**             | lucide-react                                               |
| **Build**             | Vite + Cargo                                               |

---

## Download

### Latest Release

Download the latest **Atlas SSH Client** executable from the [Releases](https://github.com/aleynatila/atlas-shell/releases) page.

The installer (`atlas_*_x64-setup.exe`) includes a wizard that will guide you through the installation process.

**Features:**

- 📦 One-click installer with wizard interface
- ⚡ Automatic updates (future feature planned)
- 🔧 Uninstall support via Windows Control Panel

---

## Getting Started

### Running from Release

1. Download `atlas_*_x64-setup.exe` from [Releases](https://github.com/aleynatila/atlas-shell/releases)
2. Run the installer and follow the wizard
3. Launch **Atlas SSH Client** from Start Menu
4. Add your SSH sessions in Settings → Sessions

### Development Setup

#### Prerequisites

- [Rust](https://rustup.rs/) (stable, 1.76+)
- [Node.js](https://nodejs.org/) 18+
- Windows build tools (MSVC / Visual Studio Build Tools)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

#### Install & Run

```powershell
# Clone
git clone https://github.com/aleynatila/atlas-shell.git
cd atlas-shell

# Install JS dependencies
npm install

# Run in development mode (starts Vite + Tauri dev)
npm run tauri:dev
```

#### Build for Production

```powershell
npm run tauri:build
# Installer output: src-tauri/target/release/bundle/nsis/
```

---

## Project Structure

```
atlas/
├── src/                    # React + TypeScript frontend
│   ├── App.tsx             # Main application (single-file)
│   ├── index.css           # Global styles + xterm overrides
│   └── main.tsx            # React entry point
├── src-tauri/              # Tauri / Rust backend
│   ├── src/
│   │   └── main.rs         # SSH session management, SFTP upload
│   ├── Cargo.toml
│   └── tauri.conf.json     # Window config, allowlist, bundle
├── docs/
│   └── screenshots/        # Place your screenshots here
├── index.html
├── package.json
├── tailwind.config.js
└── vite.config.ts
```

---

## Configuration

Sessions and credentials are persisted to `localStorage` under the keys:

| Key                 | Contents                       |
| ------------------- | ------------------------------ |
| `atlas_sessions`    | Array of saved SSH sessions    |
| `atlas_credentials` | Array of reusable credentials  |
| `atlas_scripts`     | Saved scripts / quick commands |
| `atlas_tags`        | Tag definitions                |
| `atlas_general`     | Font size, font family, theme  |

---

## Importing from Solar-PuTTY

1. In Solar-PuTTY: **File → Export Sessions** → save as JSON
2. In Atlas: **Settings → Sessions → Import** → select the JSON file

---

## License

[MIT](LICENSE) © 2026

- **Backend:** Rust with `ssh2` crate for SSH, `once_cell` for static session storage, `mpsc` channels for IPC
- **IPC:** Tauri commands (`start_ssh_session`, `send_ssh_input`, `resize_pty`, `stop_ssh_session`) and event emitters (`ssh-output`)

Notes

- Sessions are saved to `localStorage`; they are NOT encrypted. For production, use a secure storage backend.
- The default host/user in the UI is `127.0.0.1` / `root`; update these before connecting to real servers.
- To use SSH key auth, provide the absolute path to the private key file (e.g., `C:\Users\YourUser\.ssh\id_rsa` or `/home/user/.ssh/id_rsa`).

Windows packaging (.exe via NSIS)

---

By default Tauri on Windows produces an `.msi` installer, but you can request an `.exe` NSIS installer by setting the `bundle.targets` to `nsis` in the Tauri config. The project has been updated to target NSIS; see [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json).

Prerequisites for building NSIS installer on Windows:

- Install Rust via rustup.
- Install Node.js (>=16) and run `npm install` in the project root.
- Install NSIS (makensis) and ensure it's on `PATH`. You can install via Chocolatey:

```powershell
choco install nsis -y
```

Build steps (PowerShell):

```powershell
cd c:/Projects/atlas
npm install
npm run tauri:build
```

Output

- After a successful build, the NSIS installer will be under `src-tauri/target/release/bundle/nsis/` (e.g. `Atlas_1.0.0_setup.exe`).

Notes

- Ensure you add real icon files to the `icons/` folder listed in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) before building.
- If you prefer both `.msi` and `.exe`, set `"targets": ["msi","nsis"]` in the bundle config.
