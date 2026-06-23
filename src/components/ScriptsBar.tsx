import { invoke } from "@tauri-apps/api/core";
import { ChevronUp, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Script, TabPane } from "../types";

interface ScriptsBarProps {
  scripts: Script[];
  activeTab: TabPane;
  paneRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}

export function ScriptsBar({ scripts, activeTab, paneRefs }: ScriptsBarProps) {
  const sessionGroup = activeTab.sessionEntry.group ?? null;
  const allGroups = [
    ...new Set(scripts.filter((s) => s.group).map((s) => s.group as string)),
  ].sort();

  const [selectedFolder, setSelectedFolder] = useState<string | null>(
    sessionGroup ?? allGroups[0] ?? null,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedFolder(sessionGroup ?? allGroups[0] ?? null);
    setDropdownOpen(false);
  }, [activeTab.tabId, sessionGroup]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))
        setDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const runScript = (sc: Script) => {
    if (!activeTab.sshSessionId) return;
    invoke("send_ssh_input", {
      sessionId: activeTab.sshSessionId,
      input: sc.content.endsWith("\n") ? sc.content : sc.content + "\n",
    }).catch(() => {});
    setTimeout(() => {
      (paneRefs.current[activeTab.tabId] as HTMLDivElement & { __term?: { focus: () => void } })
        ?.__term?.focus?.();
    }, 50);
  };

  const ungrouped = scripts.filter((s) => !s.group);
  const folderScripts = selectedFolder
    ? scripts.filter((s) => s.group === selectedFolder)
    : [];

  if (scripts.length === 0) {
    return (
      <div
        className="flex items-center px-3 py-1 border-t border-hx-border shrink-0 select-none"
        style={{ background: "#080A12" }}
      >
        <span className="text-[10px] text-hx-dim font-mono italic">
          No quick commands — add in Settings → Scripts
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1 border-t border-hx-border shrink-0 select-none"
      style={{ background: "#080A12" }}
    >
      {/* Label */}
      <span className="text-[10px] text-hx-dim tracking-widest uppercase shrink-0">
        CMD
      </span>

      {/* Ungrouped scripts — always visible, no scroll */}
      {ungrouped.map((sc) => (
        <button
          key={sc.id}
          onClick={() => runScript(sc)}
          title={sc.content}
          className="px-2 py-0.5 text-[11px] font-mono bg-hx-neon/10 text-hx-neon border border-hx-neon/20 rounded hover:bg-hx-neon/25 transition-colors whitespace-nowrap shrink-0"
        >
          {sc.name}
        </button>
      ))}

      {/* Divider when both ungrouped and folders exist */}
      {ungrouped.length > 0 && allGroups.length > 0 && (
        <span className="text-hx-dim/30 shrink-0 px-0.5 select-none">│</span>
      )}

      {/* Folder dropdown — only if folders exist */}
      {allGroups.length > 0 && (
        <div ref={dropdownRef} className="relative shrink-0">
          <button
            onClick={() => setDropdownOpen((o) => !o)}
            className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono border rounded transition-colors whitespace-nowrap ${
              selectedFolder
                ? "bg-hx-neon/15 text-hx-neon border-hx-neon/30 hover:bg-hx-neon/25"
                : "bg-white/5 text-hx-dim border-hx-border hover:text-hx-text hover:bg-white/10"
            }`}
          >
            <FolderOpen size={10} />
            <span>{selectedFolder ?? "Folders"}</span>
            <ChevronUp
              size={9}
              className={`transition-transform duration-150 ${dropdownOpen ? "" : "rotate-180"}`}
            />
          </button>

          {dropdownOpen && (
            <div className="absolute bottom-full mb-1.5 left-0 min-w-40 bg-hx-panel border border-hx-border shadow-xl z-50 py-1">
              {allGroups.map((g) => (
                <button
                  key={g}
                  onClick={() => { setSelectedFolder(g); setDropdownOpen(false); }}
                  className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono transition-colors ${
                    selectedFolder === g
                      ? "text-hx-neon bg-hx-neon/10"
                      : "text-hx-muted hover:text-hx-text hover:bg-white/5"
                  }`}
                >
                  <FolderOpen size={10} className="shrink-0 opacity-60" />
                  <span className="flex-1 truncate">{g}</span>
                  <span className="text-[10px] text-hx-dim/50 shrink-0">
                    {scripts.filter((s) => s.group === g).length}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Selected folder's scripts — scrollable pill strip */}
      {folderScripts.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1"
          style={{ scrollbarWidth: "none" }}
        >
          {folderScripts.map((sc) => (
            <button
              key={sc.id}
              onClick={() => runScript(sc)}
              title={sc.content}
              className="px-2 py-0.5 text-[11px] font-mono bg-hx-neon/10 text-hx-neon border border-hx-neon/20 rounded hover:bg-hx-neon/25 transition-colors whitespace-nowrap shrink-0"
            >
              {sc.name}
            </button>
          ))}
        </div>
      )}

      {/* Prompt when a folder is selected but empty (shouldn't happen, but guard) */}
      {selectedFolder && folderScripts.length === 0 && (
        <span className="text-[10px] text-hx-dim font-mono italic">
          No scripts in "{selectedFolder}"
        </span>
      )}
    </div>
  );
}
