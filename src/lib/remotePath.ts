import type { RemoteEntry } from "../types";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

export function joinRemote(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

/** "/var/log/" -> "/var/log"; "/" stays "/". Used as a cache key. */
export function normalizeRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function filterEntries(
  entries: RemoteEntry[],
  query: string,
  foldersOnly: boolean,
): RemoteEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) => (!foldersOnly || e.is_dir) && (!q || e.name.toLowerCase().includes(q)),
  );
}
