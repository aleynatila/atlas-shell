/**
 * Runs automatically via `npm version` hook (package.json "version" script).
 * Syncs the new version from package.json into tauri.conf.json and Cargo.toml,
 * then stages those files so they're included in the version bump commit.
 */
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const version = pkg.version;

// ── tauri.conf.json ──────────────────────────────────────────────────────────
const tauriConf = JSON.parse(
  await readFile("src-tauri/tauri.conf.json", "utf8"),
);
tauriConf.version = version;
await writeFile(
  "src-tauri/tauri.conf.json",
  JSON.stringify(tauriConf, null, 2) + "\n",
  "utf8",
);

// ── Cargo.toml ───────────────────────────────────────────────────────────────
let cargoToml = await readFile("src-tauri/Cargo.toml", "utf8");
cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`);
await writeFile("src-tauri/Cargo.toml", cargoToml, "utf8");

// Stage so npm version commit picks them up
execSync("git add src-tauri/tauri.conf.json src-tauri/Cargo.toml");

console.log(`✓ Synced v${version} → tauri.conf.json, Cargo.toml`);
