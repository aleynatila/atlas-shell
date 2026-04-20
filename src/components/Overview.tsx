import { Plus, Server } from "lucide-react";
import { memo } from "react";
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

export const Overview = memo(function Overview({
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
  editingSession,
  setEditingSession,
  editForm,
  setEditForm,
  editSelectedColor,
  setEditSelectedColor,
  updateSession,
}: OverviewProps) {
  return (
    <div className="absolute inset-0 flex overflow-hidden">
      {/* Main content */}
      <div
        className="flex-1 overflow-y-auto p-6"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "var(--color-hx-border) transparent",
        }}
      >
        {/* Header */}
        <div className="flex flex-col gap-3 mb-5">
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
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="hx-input bg-hx-bg border border-hx-border px-3 py-1.5 text-xs w-full font-mono"
          />
        </div>

        {/* Empty state */}
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
        ) : (
          <OverviewCardGrid
            overviewSessions={overviewSessions}
            connectedTabsBySessionId={connectedTabsBySessionId}
            onOpenTab={openTab}
            onEditSession={handleEditSession}
            onRemoveSession={removeSession}
            credentials={credentials}
            darkMode={darkMode}
          />
        )}
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
});
