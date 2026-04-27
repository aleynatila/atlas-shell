import { Edit2, Key, MoreVertical, Play, Server, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { adaptColor, type Credential, type SessionEntry } from "../types";

interface SessionCardProps {
  session: SessionEntry;
  isOpen: boolean;
  isConnected: boolean;
  onOpen: (s: SessionEntry) => void;
  onEdit: (s: SessionEntry) => void;
  onRemove: (id: string, e: React.MouseEvent) => void;
  autoConnect?: boolean;
  credentials?: Credential[];
  darkMode?: boolean;
}

export const SessionCard = memo(
  function SessionCard({
    session,
    isOpen,
    isConnected,
    onOpen,
    onEdit,
    onRemove,
    credentials,
    darkMode,
  }: SessionCardProps) {
    const isDark = darkMode ?? true;
    const accent = adaptColor(session.color || "#00E5FF", isDark);
    const statusColor = isConnected
      ? isDark
        ? "#00FF88"
        : "#00875a"
      : isOpen
        ? accent
        : isDark
          ? "#2A3550"
          : "#a0aec0";
    const statusText = isConnected ? "CONNECTED" : isOpen ? "OPEN" : "IDLE";

    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!menuOpen) return;
      const handleMouse = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setMenuOpen(false);
          setConfirmDelete(false);
        }
      };
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setMenuOpen(false);
          setConfirmDelete(false);
        }
      };
      document.addEventListener("mousedown", handleMouse);
      document.addEventListener("keydown", handleKey);
      return () => {
        document.removeEventListener("mousedown", handleMouse);
        document.removeEventListener("keydown", handleKey);
      };
    }, [menuOpen]);

    return (
      <div
        onClick={() => onOpen(session)}
        className="hx-card group cursor-pointer"
      >
        <div
          className="bg-hx-panel border border-hx-border group-hover:border-hx-neon/20 transition-colors p-4 relative"
          style={{ borderTop: `2px solid ${accent}` }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rotate-45 transition-colors shrink-0"
                style={{
                  background: statusColor,
                  boxShadow: isConnected ? `0 0 6px ${statusColor}` : "none",
                }}
              />
              <span
                className="text-[9px] font-mono uppercase tracking-widest"
                style={{ color: statusColor }}
              >
                {statusText}
              </span>
            </div>
            {/* 3-dot context menu */}
            <div
              ref={menuRef}
              className="relative opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="p-1 text-hx-dim hover:text-hx-text transition-colors rounded"
              >
                <MoreVertical size={13} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 bg-hx-panel border border-hx-border z-50 min-w-27.5 shadow-lg">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmDelete(false);
                      onEdit(session);
                    }}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs font-mono text-hx-muted hover:text-hx-neon hover:bg-hx-neon/5 transition-colors"
                  >
                    <Edit2 size={10} /> Edit
                  </button>
                  {confirmDelete ? (
                    <div className="px-3 py-2 flex flex-col gap-1.5">
                      <span className="text-[10px] text-hx-danger font-mono">
                        Delete?
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={(e) => {
                            setMenuOpen(false);
                            setConfirmDelete(false);
                            onRemove(session.id, e);
                          }}
                          className="flex-1 text-[10px] font-mono py-1 text-hx-danger border border-hx-danger/40 hover:bg-hx-danger/10 transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="flex-1 text-[10px] font-mono py-1 text-hx-muted border border-hx-border hover:bg-white/5 transition-colors"
                        >
                          No
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs font-mono text-hx-muted hover:text-hx-danger hover:bg-hx-danger/5 transition-colors"
                    >
                      <Trash2 size={10} /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Session info */}
          <div className="flex items-center gap-2 mb-1">
            <Server size={12} className="text-hx-dim shrink-0" />
            <span className="text-sm font-bold text-hx-text truncate">
              {session.label}
            </span>
          </div>
          <div className="font-mono text-[11px] text-hx-muted mb-1 pl-5 truncate">
            {session.user}@{session.host}:{session.port}
          </div>
          {session.group && (
            <div
              className="text-[10px] pl-5 mb-3 font-mono truncate"
              style={{ color: accent + "99" }}
            >
              ◆ {session.group}
            </div>
          )}
          {!session.group && <div className="mb-3" />}

          {/* Auth type */}
          <div className="flex items-center gap-1.5 mb-4">
            <Key size={10} className="text-hx-dim" />
            <span className="text-[10px] text-hx-dim font-mono">
              {session.credentialId
                ? credentials?.find(
                    (c: Credential) => c.id === session.credentialId,
                  )?.label || "linked credential"
                : session.keyPath
                  ? "key auth"
                  : "password auth"}
            </span>
          </div>

          {/* Open button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen(session);
            }}
            className="hx-clip-btn w-full py-2 text-[11px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-all"
            style={{
              background: `linear-gradient(135deg, ${accent}22, ${accent}0a)`,
              border: `1px solid ${accent}55`,
              color: accent,
            }}
          >
            <Play size={10} fill={accent} />
            Open Session
          </button>
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.session === next.session &&
      prev.isOpen === next.isOpen &&
      prev.isConnected === next.isConnected &&
      prev.darkMode === next.darkMode &&
      prev.credentials === next.credentials
    );
  },
);
