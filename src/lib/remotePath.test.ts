import { describe, expect, it } from "vitest";
import type { RemoteEntry } from "../types";
import {
  filterEntries,
  formatBytes,
  joinRemote,
  parentOf,
} from "./remotePath";

const e = (name: string, is_dir = false): RemoteEntry => ({
  name,
  is_dir,
  is_symlink: false,
  size: 0,
  mtime: 0,
});

describe("path helpers", () => {
  it("joins and splits remote paths", () => {
    expect(joinRemote("/", "etc")).toBe("/etc");
    expect(joinRemote("/var/log/", "syslog")).toBe("/var/log/syslog");
    expect(parentOf("/var/log")).toBe("/var");
    expect(parentOf("/var")).toBe("/");
    expect(parentOf("/")).toBe("/");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("filterEntries", () => {
  const list = [e("Logs", true), e("syslog"), e("auth.log"), e("backup", true)];
  it("matches case-insensitively", () => {
    expect(filterEntries(list, "LOG", false).map((x) => x.name)).toEqual([
      "Logs",
      "syslog",
      "auth.log",
    ]);
  });
  it("can show folders only", () => {
    expect(filterEntries(list, "", true).map((x) => x.name)).toEqual([
      "Logs",
      "backup",
    ]);
  });
  it("returns everything for an empty query", () => {
    expect(filterEntries(list, "  ", false)).toHaveLength(4);
  });
});
