import { readFile, writeFile } from "node:fs/promises";

function usage() {
  console.error(
    "Usage: node scripts/generate-updater-manifest.mjs <version> <notes-file> <signature-file> <asset-url> <output-file> [pub-date]",
  );
  process.exit(1);
}

const [versionArg, notesFile, signatureFile, assetUrl, outputFile, pubDateArg] =
  process.argv.slice(2);

if (!versionArg || !notesFile || !signatureFile || !assetUrl || !outputFile) {
  usage();
}

const version = versionArg.trim().replace(/^v/i, "");
const notes = (await readFile(notesFile, "utf8")).trim();
const signature = (await readFile(signatureFile, "utf8")).trim();
const pubDate = pubDateArg ?? new Date().toISOString();

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    "windows-x86_64": {
      signature,
      url: assetUrl,
    },
  },
};

await writeFile(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");