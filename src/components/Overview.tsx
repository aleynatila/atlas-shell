import { FolderOpen, Plus, Server } from "lucide-react";
import { useMemo, useState } from "react";
import type { Credential, SessionEntry, TabPane } from "../types";
import { OverviewCardGrid } from "./OverviewCardGrid";
import { EditSessionSidebar } from "./Settings";

interface OverviewProps {
  sessions: SessionEntry[];
  overviewSessions: SessionEntry[];
  connectedTabsBySessionId: Map<string, TabPane>;
  connectedCount: number;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  openTab: (entry: SessionEntry, autoConnect?: boolean) => void;
  handleEditSession: (s: SessionEntry) => void;
  removeSession: (id: string, e: React.MouseEvent) => void;
  credentials: Credential[];
  darkMode: boolean;
  importStatus: string | null;
  openView: (kind: "overview" | "settings" | "new-session") => void;
  prefillNewSession: (host: string) => void;
  editingSession: SessionEntry | null;
  setEditingSession: (s: SessionEntry | null) => void;
  editForm: {
    label: string;
    host: string;
    port: number;
    user: string;
    pass: string;
    keyPath: string;
    group: string;
    credentialId: string;
  };
  setEditForm: React.Dispatch<
    React.SetStateAction<{
      label: string;
      host: string;
      port: number;
      user: string;
      pass: string;
      keyPath: string;
      group: string;
      credentialId: string;
    }>
  >;
  editSelectedColor: string;
  setEditSelectedColor: (c: string) => void;
  updateSession: () => void;
}

export function Overview({
  sessions,
  overviewSessions,
  connectedTabsBySessionId,
  connectedCount,
  searchQuery,
  setSearchQuery,
  openTab,
  handleEditSession,
  removeSession,
  credentials,
  darkMode,
  importStatus,
  openView,
  prefillNewSession,
  editingSession,
  setEditingSession,
  editForm,
  setEditForm,
  editSelectedColor,
  setEditSelectedColor,
  updateSession,
}: OverviewProps) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  // All unique groups from ALL sessions (not filtered by search)
  const allGroups = useMemo(
    () =>
      [...new Set(sessions.filter((s) => s.group).map((s) => s.group as string))].sort(),
    [sessions],
  );

  const hasGroups = allGroups.length > 0;
  const ungroupedCount = sessions.filter((s) => !s.group).length;

  // Secondary filter: apply group on top of search results
  const displayedSessions = useMemo(() => {
    if (selectedGroup === null) return overviewSessions;
    if (selectedGroup === "__ungrouped__")
      return overviewSessions.filter((s) => !s.group);
    return overviewSessions.filter((s) => s.group === selectedGroup);
  }, [overviewSessions, selectedGroup]);

  return (
    <div className="absolute inset-0 flex overflow-hidden">

      {/* ── Folder sidebar ── */}
      {hasGroups && (
        <div
          className="flex flex-col border-r border-hx-border shrink-0 overflow-y-auto"
          style={{
            width: 168,
            scrollbarWidth: "thin",
            scrollbarColor: "var(--color-hx-border) transparent",
            background: "rgba(0,0,0,0.15)",
          }}
        >
          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-hx-dim px-4 pt-5 pb-2">
            Folders
          </p>

          {/* All */}
          <button
            onClick={() => setSelectedGroup(null)}
            className={`flex items-center gap-2 px-4 py-2 text-[11px] font-mono text-left transition-colors ${
              selectedGroup === null
                ? "text-hx-neon bg-hx-neon/10 border-r-2 border-hx-neon"
                : "text-hx-muted hover:text-hx-text hover:bg-white/5"
            }`}
          >
            <span className="text-[10px] shrink-0">◆</span>
            <span className="flex-1 truncate">All</span>
            <span className="text-[9px] text-hx-dim shrink-0">{sessions.length}</span>
          </button>

          {/* Group folders */}
          {allGroups.map((g) => (
            <button
              key={g}
              onClick={() => setSelectedGroup(g)}
              className={`flex items-center gap-2 px-4 py-2 text-[11px] font-mono text-left transition-colors ${
                selectedGroup === g
                  ? "text-hx-neon bg-hx-neon/10 border-r-2 border-hx-neon"
                  : "text-hx-muted hover:text-hx-text hover:bg-white/5"
              }`}
            >
              <FolderOpen size={11} className="shrink-0" />
              <span className="flex-1 truncate">{g}</span>
              <span className="text-[9px] text-hx-dim shrink-0">
                {sessions.filter((s) => s.group === g).length}
              </span>
            </button>
          ))}

          {/* Ungrouped */}
          {ungroupedCount > 0 && (
            <>
              <div className="mx-4 my-1 h-px bg-hx-border/40" />
              <button
                onClick={() => setSelectedGroup("__ungrouped__")}
                className={`flex items-center gap-2 px-4 py-2 text-[11px] font-mono text-left transition-colors ${
                  selectedGroup === "__ungrouped__"
                    ? "text-hx-neon bg-hx-neon/10 border-r-2 border-hx-neon"
                    : "text-hx-dim hover:text-hx-text hover:bg-white/5"
                }`}
              >
                <Server size={11} className="shrink-0" />
                <span className="flex-1 truncate">Ungrouped</span>
                <span className="text-[9px] text-hx-dim shrink-0">{ungroupedCount}</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Main content ── */}
      <div
        className="flex-1 flex flex-col overflow-hidden min-w-0"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "var(--color-hx-border) transparent",
        }}
      >
        {/* Header */}
        <div className="flex flex-col gap-3 px-6 pt-6 pb-3 flex-none">
          <div className="flex items-end justify-between">
            <div>
              <h1
                className="text-base font-black tracking-[0.2em] uppercase text-hx-neon"
                style={{ textShadow: "0 0 20px #00E5FF44" }}
              >
                ◆ Overview
              </h1>
              <p className="text-[11px] text-hx-muted mt-1 font-mono">
                {sessions.length} saved · {connectedCount} connected
                {selectedGroup && selectedGroup !== "__ungrouped__" && (
                  <span className="text-hx-dim"> · 📁 {selectedGroup}</span>
                )}
                {selectedGroup === "__ungrouped__" && (
                  <span className="text-hx-dim"> · ungrouped</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {importStatus && (
                <span
                  className={`text-[10px] font-mono ${importStatus.startsWith("✓") ? "text-hx-success" : "text-hx-danger"}`}
                >
                  {importStatus}
                </span>
              )}
              <button
                onClick={() => openView("new-session")}
                className="hx-clip-btn flex items-center gap-2 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-hx-neon border border-hx-neon/40 hover:border-hx-neon/80 hover:bg-hx-neon/10 transition-all"
                style={{ boxShadow: "0 0 12px rgba(0,229,255,0.08)" }}
              >
                <Plus size={12} />
                New Session
              </button>
            </div>
          </div>
          <div className="relative">
            <input
              type="text"
              placeholder="Search sessions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="hx-input bg-hx-bg border border-hx-border px-3 py-1.5 text-xs w-full font-mono pr-7"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-hx-dim hover:text-hx-text transition-colors"
                title="Clear search"
              >
                <span className="text-sm leading-none">×</span>
              </button>
            )}
          </div>
        </div>

        {/* Scrollable grid */}
        <div className="flex-1 min-h-0 overflow-auto" data-overview-scroll="1">
          <div className="px-6 pb-6">
            {sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-56 gap-5">
                <div className="relative">
                  <div
                    className="w-16 h-16 border border-hx-neon/25 rotate-45 flex items-center justify-center"
                    style={{ boxShadow: "0 0 20px rgba(0,229,255,0.05)" }}
                  >
                    <Server size={20} className="text-hx-dim -rotate-45" />
                  </div>
                  <div className="absolute -inset-3 border border-hx-neon/10 rotate-45" />
                </div>
                <p className="text-hx-muted text-sm">No sessions saved</p>
                <button
                  onClick={() => openView("new-session")}
                  className="text-xs text-hx-neon hover:underline font-mono tracking-wider"
                >
                  + Create your first session
                </button>
              </div>
            ) : displayedSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-5">
                <div className="relative p-3">
                  <div
                    className="w-14 h-14 border border-hx-neon/20 rotate-45 flex items-center justify-center"
                    style={{ boxShadow: "0 0 16px rgba(0,229,255,0.04)" }}
                  >
                    <Server size={17} className="text-hx-dim -rotate-45" />
                  </div>
                  <div className="absolute inset-0 border border-hx-neon/08 rotate-45" />
                </div>
                {searchQuery ? (
                  <>
                    <p className="text-hx-muted text-sm font-mono">
                      No session found for{" "}
                      <span className="text-hx-text font-bold">"{searchQuery}"</span>
                    </p>
                    <button
                      onClick={() => prefillNewSession(searchQuery)}
                      className="hx-clip-btn flex items-center gap-2 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-hx-neon border border-hx-neon/40 hover:border-hx-neon/80 hover:bg-hx-neon/10 transition-all"
                      style={{ boxShadow: "0 0 12px rgba(0,229,255,0.08)" }}
                    >
                      <Plus size={12} />
                      Create session for "{searchQuery}"
                    </button>
                  </>
                ) : (
                  <p className="text-hx-muted text-sm font-mono">No sessions in this folder</p>
                )}
              </div>
            ) : (
              <OverviewCardGrid
                overviewSessions={displayedSessions}
                connectedTabsBySessionId={connectedTabsBySessionId}
                onOpenTab={openTab}
                onEditSession={handleEditSession}
                onRemoveSession={removeSession}
                credentials={credentials}
                darkMode={darkMode}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Edit Sidebar ── */}
      {editingSession && (
        <EditSessionSidebar
          editingSession={editingSession}
          setEditingSession={setEditingSession}
          editForm={editForm}
          setEditForm={setEditForm}
          editSelectedColor={editSelectedColor}
          setEditSelectedColor={setEditSelectedColor}
          updateSession={updateSession}
          credentials={credentials}
          darkMode={darkMode}
        />
      )}
    </div>
  );
}
