/**
 * Runs automatically via `npm version` hook (package.json "version" script).
 * Syncs the new version from package.json into tauri.conf.json, Cargo.toml and
 * Cargo.lock (the app's own package entry), then stages those files so they're
 * included in the version bump commit. Without the Cargo.lock update the next
 * cargo build rewrote it and left the working tree dirty after every release.
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

// ── Cargo.lock (only the atlas-tauri package entry) ─────────────────────────
let cargoLock = await readFile("src-tauri/Cargo.lock", "utf8");
const lockEntry = /(name = "atlas-tauri"?
version = ")[^"]*(")/;
if (!lockEntry.test(cargoLock)) {
  throw new Error("atlas-tauri entry not found in src-tauri/Cargo.lock");
}
cargoLock = cargoLock.replace(lockEntry, `$1${version}$2`);
await writeFile("src-tauri/Cargo.lock", cargoLock, "utf8");

// Stage so npm version commit picks them up
execSync(
  "git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock",
);

console.log(`✓ Synced v${version} → tauri.conf.json, Cargo.toml, Cargo.lock`);
