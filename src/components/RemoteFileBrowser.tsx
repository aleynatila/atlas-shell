import {
  ArrowUp,
  Download,
  File,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import {
  filterEntries,
  formatBytes,
  joinRemote,
  parentOf,
} from "../lib/remotePath";
import type { RemoteEntry, RemoteListing } from "../types";
import { RemoteFileEditor } from "./RemoteFileEditor";

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface RemoteFileBrowserProps {
  host: string;
  port: number;
  user: string;
  pass: string;
  keyPath?: string | null;
  /** The terminal's current directory (from OSC 7); Files opens in it and follows it. */
  cwd?: string | null;
  /** Called whenever the listed directory changes. */
  onPathChange?: (path: string) => void;
  /** Bump to re-list the current directory (e.g. after an upload finished). */
  refreshKey?: number;
  invokeSafe: <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onClose: () => void;
  onStartDownload: (transferId: string, name: string) => void;
}

export const RemoteFileBrowser = memo(function RemoteFileBrowser({
  host,
  port,
  user,
  pass,
  keyPath,
  cwd,
  onPathChange,
  refreshKey,
  invokeSafe,
  onClose,
  onStartDownload,
}: RemoteFileBrowserProps) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [foldersOnly, setFoldersOnly] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const pathRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  // Only the most recent load may update state (rapid clicks can overlap).
  const loadSeq = useRef(0);

  function connArgs() {
    return { host, port, user, pass, keyPath: keyPath || null };
  }

  function load(target: string | null) {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    invokeSafe<RemoteListing>("list_remote_dir", {
      ...connArgs(),
      path: target,
    })
      .then((res) => {
        if (!res || seq !== loadSeq.current) return;
        if (res.path !== pathRef.current) {
          setQuery("");
          pathRef.current = res.path;
          onPathChange?.(res.path);
        }
        setPath(res.path);
        setEntries(res.entries);
        setSelected(new Set());
      })
      .catch((err) => {
        if (seq === loadSeq.current) setError(String(err));
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
  }

  const navigate = load;

  const lastRefreshRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === lastRefreshRef.current) return;
    lastRefreshRef.current = refreshKey;
    if (pathRef.current) load(pathRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Open in the terminal's directory, then follow it whenever it changes. Only a
  // *change* of the terminal's directory moves the list, so browsing by hand is
  // never overridden.
  const lastCwdRef = useRef(cwd);
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      load(cwd && cwd.startsWith("/") ? cwd : null);
      return;
    }
    if (cwd === lastCwdRef.current) return;
    lastCwdRef.current = cwd;
    if (cwd && cwd.startsWith("/")) load(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const visibleEntries = filterEntries(entries, query, foldersOnly);
  const allSelected =
    visibleEntries.length > 0 &&
    visibleEntries.every((e) => selected.has(e.name));

  function toggleSelectAll() {
    setSelected(
      allSelected ? new Set() : new Set(visibleEntries.map((e) => e.name)),
    );
  }

  async function downloadSelected() {
    if (!path || selected.size === 0) return;
    const localDir = await invokeSafe<string | null>("pick_download_folder");
    if (!localDir) return;
    for (const name of selected) {
      const entry = entries.find((e) => e.name === name);
      const id = crypto.randomUUID();
      onStartDownload(id, name);
      if (entry?.is_dir) {
        invokeSafe("download_folder_scp", {
          transferId: id,
          ...connArgs(),
          remotePath: joinRemote(path, name),
          localDir,
        });
      } else {
        invokeSafe("download_file_scp", {
          transferId: id,
          ...connArgs(),
          remotePath: joinRemote(path, name),
          localDir,
        });
      }
    }
    setSelected(new Set());
  }

  const breadcrumbs =
    path && path !== "/"
      ? path.split("/").filter(Boolean)
      : [];

  return (
    <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-[35]">
      <div className="bg-hx-panel border border-hx-neon/30 rounded p-4 w-[30rem] h-[32rem] max-h-[80vh] flex flex-col gap-3 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Folder size={14} className="text-hx-neon shrink-0" />
            <span className="text-xs font-bold tracking-widest uppercase text-hx-neon shrink-0">
              Files
            </span>
            <span className="text-[10px] text-hx-dim font-mono truncate">
              {host}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => load(path)}
              title="Refresh"
              className="text-hx-dim hover:text-hx-text transition-colors"
            >
              <RefreshCw size={13} />
            </button>
            <button
              onClick={onClose}
              className="text-hx-dim hover:text-hx-text transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 flex-nowrap overflow-x-auto whitespace-nowrap text-[10px] font-mono shrink-0">
          <button
            className="text-hx-muted hover:text-hx-neon transition-colors"
            onClick={() => navigate("/")}
          >
            /
          </button>
          {breadcrumbs.map((seg, i) => {
            const segPath = "/" + breadcrumbs.slice(0, i + 1).join("/");
            return (
              <span key={segPath} className="flex items-center gap-1">
                {i > 0 && <span className="text-hx-dim">/</span>}
                <button
                  className="text-hx-muted hover:text-hx-neon transition-colors"
                  onClick={() => navigate(segPath)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 border border-hx-border rounded">
            <Search size={12} className="text-hx-dim shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter files…"
              className="flex-1 min-w-0 bg-transparent text-xs font-mono text-hx-text outline-none placeholder:text-hx-dim"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="text-hx-dim hover:text-hx-text"
                title="Clear filter"
              >
                <X size={11} />
              </button>
            )}
          </div>
          <label className="flex items-center gap-1 text-[10px] text-hx-muted cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={foldersOnly}
              onChange={(e) => setFoldersOnly(e.target.checked)}
            />
            Folders only
          </label>
        </div>

        {/* Listing */}
        <div className="flex-1 overflow-y-auto border border-hx-border rounded min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-hx-dim">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="p-3 text-xs text-hx-danger font-mono">
              {error}
            </div>
          ) : (
            <>
              {path && path !== "/" && (
                <button
                  onClick={() => navigate(parentOf(path))}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-hx-muted hover:bg-hx-border/30 transition-colors text-left"
                >
                  <ArrowUp size={13} />
                  <span className="font-mono">..</span>
                </button>
              )}
              {visibleEntries.length === 0 && (
                <div className="p-3 text-xs text-hx-dim text-center">
                  {entries.length === 0 ? "Empty directory" : "No matches"}
                </div>
              )}
              {visibleEntries.map((entry) => (
                <div
                  key={entry.name}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-hx-border/30 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(entry.name)}
                    onChange={() => toggleSelect(entry.name)}
                    title={entry.is_dir ? "Select folder to download" : "Select file to download"}
                    className="shrink-0"
                  />
                  <button
                    onClick={() =>
                      entry.is_dir &&
                      path &&
                      navigate(joinRemote(path, entry.name))
                    }
                    onDoubleClick={() =>
                      !entry.is_dir &&
                      path &&
                      setEditing(joinRemote(path, entry.name))
                    }
                    title={entry.is_dir ? undefined : "Double-click to view / edit"}
                    className={`flex items-center gap-2 flex-1 min-w-0 text-left ${
                      entry.is_dir
                        ? "text-hx-text hover:text-hx-neon cursor-pointer"
                        : "text-hx-text cursor-default"
                    }`}
                  >
                    {entry.is_dir ? (
                      <Folder size={13} className="text-hx-neon shrink-0" />
                    ) : (
                      <File size={13} className="text-hx-dim shrink-0" />
                    )}
                    <span className="font-mono truncate">
                      {entry.name}
                      {entry.is_symlink ? " →" : ""}
                    </span>
                  </button>
                  {!entry.is_dir && (
                    <span className="text-[10px] text-hx-dim font-mono shrink-0">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                  <span className="text-[10px] text-hx-dim font-mono shrink-0 w-32 text-right hidden sm:inline">
                    {formatDate(entry.mtime)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleSelectAll}
              disabled={loading || visibleEntries.length === 0}
              className="text-[10px] text-hx-muted hover:text-hx-neon transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
            <span className="text-[10px] text-hx-dim font-mono">
              {selected.size > 0 ? `${selected.size} selected` : ""}
            </span>
          </div>
          <button
            onClick={downloadSelected}
            disabled={selected.size === 0}
            className="flex items-center gap-1.5 px-3 py-1 text-xs bg-hx-neon/20 text-hx-neon border border-hx-neon/30 rounded hover:bg-hx-neon/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={12} />
            Download via SCP
          </button>
        </div>
      </div>
      {editing && (
        <RemoteFileEditor
          host={host}
          port={port}
          user={user}
          pass={pass}
          keyPath={keyPath}
          path={editing}
          invokeSafe={invokeSafe}
          onClose={() => setEditing(null)}
          onSaved={() => load(pathRef.current)}
        />
      )}
    </div>
  );
});
