import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    Columns2,
    ExternalLink,
    Minus,
    Plus,
    RefreshCw,
    Rows2,
    Server,
    Settings,
    Square,
    X,
} from "lucide-react";
import { memo, useRef, useState } from "react";
import { adaptColor, type TabPane } from "../types";

interface TabBarProps {
  tabs: TabPane[];
  setTabs: React.Dispatch<React.SetStateAction<TabPane[]>>;
  activeView: string;
  setActiveView: (v: string) => void;
  openViews: Set<"overview" | "settings" | "new-session">;
  showSettings: boolean;
  isOverview: boolean;
  isNewSession: boolean;
  splitTabs: Record<string, "horizontal" | "vertical">;
  openView: (kind: "overview" | "settings" | "new-session") => void;
  closeView: (kind: "overview" | "settings" | "new-session") => void;
  closeTabById: (tabId: string) => void;
  connectPane: (tabId: string) => void;
  detachTab: (tabId: string) => void;
  toggleSplitForTab: (
    tabId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  disconnectSplitPane: (tabId: string) => void;
  setSplitTabs: React.Dispatch<
    React.SetStateAction<Record<string, "horizontal" | "vertical">>
  >;
  setAutoConnectTabId: (id: string) => void;
}

export const TabBar = memo(function TabBar({
  tabs,
  setTabs,
  activeView,
  setActiveView,
  openViews,
  showSettings,
  isOverview,
  isNewSession,
  splitTabs,
  openView,
  closeView,
  closeTabById,
  connectPane,
  detachTab,
  toggleSplitForTab,
  disconnectSplitPane,
  setSplitTabs,
  setAutoConnectTabId,
}: TabBarProps) {
  // Tab drag-reorder state (local to TabBar)
  const dragTabId = useRef<string | null>(null);
  const dragOverTabId = useRef<string | null>(null);
  const [tabDragOverId, setTabDragOverId] = useState<string | null>(null);
  const [tabDragGhost, setTabDragGhost] = useState<{
    x: number;
    y: number;
    offsetX: number;
    label: string;
    color: string;
    connected: boolean;
  } | null>(null);

  // Tab context menu state (local to TabBar)
  const [tabContextMenu, setTabContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  return (
    <>
      <div
        data-tauri-drag-region
        className="hx-tabbar flex items-stretch border-b border-white/10 shrink-0 h-9 w-full relative select-none overflow-hidden"
      >
        {/* Settings — far left */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() =>
            activeView === "settings"
              ? closeView("settings")
              : openView("settings")
          }
          className={`flex items-center px-3 border-r border-white/10 shrink-0 transition-colors ${showSettings ? "text-hx-neon bg-hx-neon/10" : "text-white/50 hover:text-white/90 hover:bg-white/10"}`}
          title="Settings"
        >
          <Settings size={12} />
        </button>

        {/* Virtual tabs: overview + settings */}
        {openViews.has("overview") && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 1 && tabs.length > 0) {
                e.preventDefault();
                closeView("overview");
              }
            }}
            onClick={() => setActiveView("overview")}
            className={`hx-tab group flex items-center gap-1.5 px-4 text-xs whitespace-nowrap shrink-0 ${isOverview ? "hx-tab-virtual-active" : ""}`}
            style={
              isOverview ? { borderTop: "2px solid var(--color-hx-neon)" } : {}
            }
          >
            <Server size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap pr-2">
              Overview
            </span>
            {tabs.length > 0 && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeView("overview");
                }}
                className="ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-hx-danger leading-none"
              >
                <X size={9} />
              </span>
            )}
          </button>
        )}
        {openViews.has("settings") && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 1) {
                e.preventDefault();
                closeView("settings");
              }
            }}
            onClick={() => setActiveView("settings")}
            className={`hx-tab group flex items-center gap-1.5 px-4 text-xs whitespace-nowrap shrink-0 ${showSettings ? "hx-tab-virtual-active" : ""}`}
            style={
              showSettings
                ? { borderTop: "2px solid var(--color-hx-neon)" }
                : {}
            }
          >
            <Settings size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap pr-2">
              Settings
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeView("settings");
              }}
              className="ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-hx-danger leading-none"
            >
              <X size={9} />
            </span>
          </button>
        )}
        {openViews.has("new-session") && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 1) {
                e.preventDefault();
                closeView("new-session");
              }
            }}
            onClick={() => setActiveView("new-session")}
            className={`hx-tab group flex items-center gap-1.5 px-4 text-xs whitespace-nowrap shrink-0 ${isNewSession ? "hx-tab-virtual-active" : ""}`}
            style={
              isNewSession
                ? { borderTop: "2px solid var(--color-hx-neon)" }
                : {}
            }
          >
            <Plus size={11} />
            <span>New Session</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeView("new-session");
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 cursor-pointer hover:text-hx-danger leading-none"
            >
              <X size={9} />
            </span>
          </button>
        )}

        {/* SSH terminal tabs */}
        <div
          className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden flex items-stretch"
          style={{ scrollbarWidth: "none" }}
        >
          {tabs.map((tab) => {
            const accent = tab.sessionEntry.color || "#00E5FF";
            const isActive = activeView === tab.tabId;
            return (
              <div
                key={tab.tabId}
                data-tab-id={tab.tabId}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTabById(tab.tabId);
                  }
                }}
                onClick={() => setActiveView(tab.tabId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTabContextMenu({
                    tabId: tab.tabId,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
                className={`hx-tab group flex items-center gap-1 pl-1 pr-2 w-44 shrink-0 text-xs whitespace-nowrap cursor-default ${
                  isActive ? "hx-tab-term-active" : ""
                } ${tabDragOverId === tab.tabId ? "ring-1 ring-hx-neon/40" : ""}`}
                style={
                  isActive
                    ? {
                        borderTop: `2px solid ${adaptColor(accent, false)}`,
                      }
                    : {}
                }
              >
                {/* Drag handle */}
                <span
                  className="flex flex-col gap-0.75 p-1 opacity-0 group-hover:opacity-30 hover:opacity-70! cursor-grab active:cursor-grabbing shrink-0 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dragTabId.current = tab.tabId;
                    (window as any).__tabDragging = true;
                    const tabEl =
                      e.currentTarget.closest<HTMLElement>("[data-tab-id]");
                    const tabRect = tabEl
                      ? tabEl.getBoundingClientRect()
                      : null;
                    const offsetX = tabRect ? e.clientX - tabRect.left : 0;
                    setTabDragGhost({
                      x: e.clientX,
                      y: e.clientY,
                      offsetX,
                      label: tab.sessionEntry.label,
                      color: accent,
                      connected: !!tab.connected,
                    });
                    const onMove = (me: MouseEvent) => {
                      setTabDragGhost((prev) =>
                        prev ? { ...prev, x: me.clientX, y: me.clientY } : null,
                      );
                      const els =
                        document.querySelectorAll<HTMLElement>("[data-tab-id]");
                      let found: string | null = null;
                      for (const el of els) {
                        const r = el.getBoundingClientRect();
                        if (me.clientX >= r.left && me.clientX <= r.right) {
                          found = el.getAttribute("data-tab-id");
                          break;
                        }
                      }
                      setTabDragOverId(found);
                      dragOverTabId.current = found;
                    };
                    const onUp = () => {
                      const fromId = dragTabId.current;
                      const toId = dragOverTabId.current;
                      if (fromId && toId && fromId !== toId) {
                        setTabs((prev) => {
                          const next = [...prev];
                          const fromIdx = next.findIndex(
                            (t) => t.tabId === fromId,
                          );
                          const toIdx = next.findIndex((t) => t.tabId === toId);
                          if (fromIdx < 0 || toIdx < 0) return prev;
                          const [moved] = next.splice(fromIdx, 1);
                          next.splice(toIdx, 0, moved);
                          return next;
                        });
                      }
                      dragTabId.current = null;
                      dragOverTabId.current = null;
                      setTabDragOverId(null);
                      setTabDragGhost(null);
                      (window as any).__tabDragging = false;
                      document.removeEventListener("mousemove", onMove);
                      document.removeEventListener("mouseup", onUp);
                    };
                    document.addEventListener("mousemove", onMove);
                    document.addEventListener("mouseup", onUp);
                  }}
                >
                  <span className="w-0.75 h-0.75 rounded-full bg-current" />
                  <span className="w-0.75 h-0.75 rounded-full bg-current" />
                  <span className="w-0.75 h-0.75 rounded-full bg-current" />
                </span>
                <div
                  className="w-1.5 h-1.5 rotate-45 shrink-0"
                  style={{
                    background: tab.connected
                      ? isActive
                        ? "#00875a"
                        : "#00FF88"
                      : isActive
                        ? adaptColor(accent, false)
                        : "rgba(255,255,255,0.2)",
                    boxShadow:
                      tab.connected && !isActive ? "0 0 6px #00FF88" : "none",
                  }}
                />
                <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {tab.sessionEntry.label}
                </span>
                {splitTabs[tab.tabId] && (
                  <Columns2
                    size={9}
                    className="text-hx-neon/60 shrink-0 mx-0.5"
                  />
                )}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTabById(tab.tabId);
                  }}
                  className="ml-auto pl-1 shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100! transition-opacity cursor-pointer hover:text-hx-danger leading-none"
                >
                  <X size={10} />
                </span>
              </div>
            );
          })}
          {/* + opens Sessions overview */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => openView("overview")}
            className="flex items-center justify-center w-8 h-full shrink-0 text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            title="Sessions"
          >
            <Plus size={12} />
          </button>
          {/* Drag spacer */}
          <div data-tauri-drag-region className="flex-1 h-full min-w-4" />
        </div>

        {/* Window controls */}
        <div className="shrink-0 flex items-center">
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => getCurrentWebviewWindow().minimize()}
            className="flex items-center justify-center w-11 h-full text-white/75 hover:text-white hover:bg-white/10 transition-colors"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => getCurrentWebviewWindow().toggleMaximize()}
            className="flex items-center justify-center w-11 h-full text-white/75 hover:text-white hover:bg-white/10 transition-colors"
            title="Maximize"
          >
            <Square size={12} />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => getCurrentWebviewWindow().close()}
            className="flex items-center justify-center w-11 h-full text-white/75 hover:text-white hover:bg-red-500/80 transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Tab drag ghost */}
      {tabDragGhost && (
        <div
          className="fixed z-9999 pointer-events-none select-none"
          style={{
            left: tabDragGhost.x - tabDragGhost.offsetX,
            top: 0,
            height: 36,
            transform: `translateY(${tabDragGhost.y - 18}px)`,
            transition: "none",
            willChange: "transform, left",
          }}
        >
          <div
            className="flex items-center gap-1 pl-1 pr-3 h-full text-xs whitespace-nowrap border-t-2 shadow-xl"
            style={{
              borderTopColor: adaptColor(tabDragGhost.color, false),
              background: "#131620",
              borderBottom: "1px solid rgba(255,255,255,0.12)",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
              borderRight: "1px solid rgba(255,255,255,0.08)",
              opacity: 0.92,
              boxShadow:
                "0 8px 24px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.4)",
              minWidth: 80,
              maxWidth: 180,
              cursor: "grabbing",
            }}
          >
            <div
              className="w-1.5 h-1.5 rotate-45 shrink-0"
              style={{
                background: tabDragGhost.connected
                  ? "#00FF88"
                  : adaptColor(tabDragGhost.color, false),
                boxShadow: tabDragGhost.connected ? "0 0 6px #00FF88" : "none",
              }}
            />
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">
              {tabDragGhost.label}
            </span>
          </div>
        </div>
      )}

      {/* Tab context menu */}
      {tabContextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setTabContextMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabContextMenu(null);
          }}
        >
          <div
            className="absolute bg-hx-panel border border-hx-border rounded shadow-xl py-1 min-w-45"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Reconnect */}
            <button
              onClick={() => {
                connectPane(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
            >
              <RefreshCw size={12} />
              Reconnect
            </button>
            {/* Duplicate */}
            <button
              onClick={() => {
                const src = tabs.find((t) => t.tabId === tabContextMenu.tabId);
                if (src) {
                  const tab: TabPane = {
                    tabId: crypto.randomUUID(),
                    sessionEntry: src.sessionEntry,
                    sshSessionId: null,
                    connected: false,
                  };
                  setTabs((prev) => [...prev, tab]);
                  setActiveView(tab.tabId);
                  setAutoConnectTabId(tab.tabId);
                }
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
            >
              <Plus size={12} />
              Duplicate
            </button>
            {/* Detach */}
            <button
              onClick={() => {
                detachTab(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
            >
              <ExternalLink size={12} />
              Detach
            </button>
            <div className="border-t border-hx-border my-1" />
            {/* Split options */}
            {splitTabs[tabContextMenu.tabId] ? (
              <>
                <button
                  onClick={() => {
                    const current = splitTabs[tabContextMenu.tabId];
                    toggleSplitForTab(
                      tabContextMenu.tabId,
                      current === "horizontal" ? "vertical" : "horizontal",
                    );
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  {splitTabs[tabContextMenu.tabId] === "horizontal" ? (
                    <Columns2 size={12} />
                  ) : (
                    <Rows2 size={12} />
                  )}
                  {splitTabs[tabContextMenu.tabId] === "horizontal"
                    ? "Switch to Vertical"
                    : "Switch to Horizontal"}
                </button>
                <button
                  onClick={() => {
                    disconnectSplitPane(tabContextMenu.tabId);
                    toggleSplitForTab(tabContextMenu.tabId);
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  <X size={12} />
                  Close Split
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    toggleSplitForTab(tabContextMenu.tabId, "vertical");
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  <Columns2 size={12} />
                  Split Vertical
                </button>
                <button
                  onClick={() => {
                    toggleSplitForTab(tabContextMenu.tabId, "horizontal");
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  <Rows2 size={12} />
                  Split Horizontal
                </button>
              </>
            )}
            <div className="border-t border-hx-border my-1" />
            {/* Close */}
            <button
              onClick={() => {
                closeTabById(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-danger hover:bg-hx-danger/10 transition-colors flex items-center gap-2"
            >
              <X size={12} />
              Close
            </button>
            {/* Close All */}
            <button
              onClick={() => {
                setTabs([]);
                setSplitTabs({});
                if (openViews.has("overview")) setActiveView("overview");
                else if (openViews.has("settings")) setActiveView("settings");
                else setActiveView("");
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-danger hover:bg-hx-danger/10 transition-colors flex items-center gap-2"
            >
              <X size={12} />
              Close All
            </button>
            {/* Close Others */}
            <button
              onClick={() => {
                const keepId = tabContextMenu.tabId;
                setTabs((prev) => prev.filter((t) => t.tabId === keepId));
                setSplitTabs((prev) => {
                  const next: typeof prev = {};
                  if (prev[keepId]) next[keepId] = prev[keepId];
                  return next;
                });
                setActiveView(keepId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-danger hover:bg-hx-danger/10 transition-colors flex items-center gap-2"
            >
              <X size={12} />
              Close Others
            </button>
          </div>
        </div>
      )}
    </>
  );
});
