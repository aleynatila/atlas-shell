import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import "xterm/css/xterm.css";
import { NewSession } from "./components/NewSession";
import { Overview } from "./components/Overview";
import { Settings } from "./components/Settings";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { useCustomThemes } from "./hooks/useCustomThemes";
import { useSessionVault } from "./hooks/useSessionVault";
import {
    useGeneralSettings,
    useScripts,
    useTags,
} from "./hooks/useSettingsState";
import { useViewRouter } from "./hooks/useViewRouter";
import "./index.css";
import { getTheme, THEMES } from "./themes";
import { NEON_COLORS, type SessionEntry, type TabPane } from "./types";

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const { sessions, setSessions, saveSessions, credentials, saveCredentials } =
    useSessionVault();

  const [tabs, setTabs] = useState<TabPane[]>([]);
  // Stable ref for tabs — declared early so useViewRouter can fall back to
  // the most-recent tab when closing the active fixed view.
  const tabsRef = useRef<TabPane[]>([]);
  tabsRef.current = tabs;
  const { activeView, setActiveView, openViews, openView, closeView } =
    useViewRouter(() => tabsRef.current.map((t) => t.tabId));
  const [settingsTab, setSettingsTab] = useState<
    | "sessions"
    | "credentials"
    | "tags"
    | "scripts"
    | "general"
    | "updates"
    | "about"
    | "appearance"
  >("sessions");
  const [autoConnectTabId, setAutoConnectTabId] = useState<string | null>(null);
  const [splitTabs, setSplitTabs] = useState<
    Record<string, "horizontal" | "vertical">
  >({});
  const [selectedColor, setSelectedColor] = useState(NEON_COLORS[0]!);
  const [form, setForm] = useState({
    label: "",
    host: "",
    port: 22,
    user: "root",
    pass: "",
    keyPath: "",
    group: "",
    credentialId: "",
  });
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSession, setEditingSession] = useState<SessionEntry | null>(
    null,
  );
  const [editForm, setEditForm] = useState({
    label: "",
    host: "",
    port: 22,
    user: "root",
    pass: "",
    keyPath: "",
    group: "",
    credentialId: "",
  });
  const [editSelectedColor, setEditSelectedColor] = useState(NEON_COLORS[0]!);

  const { tags, saveTags } = useTags();
  const { scripts, saveScripts } = useScripts();
  const { generalSettings, saveGeneral } = useGeneralSettings();
  const { customThemes, importTheme, removeTheme } = useCustomThemes();

  const [importStatus, setImportStatus] = useState<string | null>(null);

  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const paneRefCallbacks = useRef<
    Record<string, (el: HTMLDivElement | null) => void>
  >({});

  // Stable refs for useCallback closures
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const splitTabsRef = useRef(splitTabs);
  splitTabsRef.current = splitTabs;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const openViewsRef = useRef(openViews);
  openViewsRef.current = openViews;

  // Apply theme
  useEffect(() => {
    const html = document.documentElement;
    const customIds = customThemes.map((t) => `theme-${t.id}`);
    html.classList.remove(
      "dark",
      ...THEMES.map((t) => `theme-${t.id}`),
      ...customIds,
    );
    const themeId = generalSettings.theme ?? "light";
    // Resolve `isDark` from either the built-in set or the custom set so
    // the `.dark` utility class still tracks light/dark for downstream UI.
    const resolved =
      THEMES.find((t) => t.id === themeId) ??
      customThemes.find((t) => t.id === themeId);
    if (themeId === "dark") {
      html.classList.add("dark", "theme-dark");
    } else if (themeId !== "light") {
      html.classList.add(`theme-${themeId}`);
      if (resolved?.isDark) html.classList.add("dark");
    }
  }, [generalSettings.theme, customThemes]);

  // Detach URL param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const detachId = params.get("detach");
    if (!detachId) return;
    try {
      const raw = localStorage.getItem("atlas_sessions");
      if (!raw) return;
      const all: SessionEntry[] = JSON.parse(raw);
      const sess = all.find((s) => s.id === detachId);
      if (!sess) return;
      const tab: TabPane = {
        tabId: crypto.randomUUID(),
        sessionEntry: sess,
        sshSessionId: null,
        connected: false,
      };
      setTabs([tab]);
      setActiveView(tab.tabId);
      setAutoConnectTabId(tab.tabId);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // saveSessions / saveCredentials are provided by useSessionVault above.
  // saveTags / saveScripts / saveGeneral are provided by their respective hooks above.

  // ── Session CRUD ──
  function addSession() {
    const newLabel = form.label || `${form.user}@${form.host}`;
    if (sessions.some((s) => s.label === newLabel)) return false;
    const cred = credentials.find((c) => c.id === form.credentialId);
    const s: SessionEntry = {
      id: crypto.randomUUID(),
      label: newLabel,
      host: form.host,
      port: Number(form.port) || 22,
      user: cred ? cred.user : form.user,
      pass: cred ? cred.pass : form.pass || undefined,
      keyPath: cred ? cred.keyPath : form.keyPath || undefined,
      group: form.group || undefined,
      color: selectedColor,
      credentialId: form.credentialId || undefined,
    };
    saveSessions([s, ...sessions]);
    setForm({
      label: "",
      host: "",
      port: 22,
      user: "root",
      pass: "",
      keyPath: "",
      group: "",
      credentialId: "",
    });
    setSelectedColor(NEON_COLORS[0]!);
    return true;
  }

  const removeSession = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const updated = sessionsRef.current.filter((s) => s.id !== id);
      setSessions(updated);
      try {
        localStorage.setItem("atlas_sessions", JSON.stringify(updated));
      } catch {}
      // Clean up keychain entry so credentials don't linger after session deletion
      invoke("delete_credential", { id: `sess_${id}` }).catch(() => {});
    },
    [setSessions],
  );

  function updateSession() {
    if (!editingSession || !editForm.host) return;
    const cred = credentials.find((c) => c.id === editForm.credentialId);
    const updated: SessionEntry = {
      ...editingSession,
      label: editForm.label || `${editForm.user}@${editForm.host}`,
      host: editForm.host,
      port: Number(editForm.port) || 22,
      user: cred ? cred.user : editForm.user,
      pass: cred ? cred.pass : editForm.pass || undefined,
      keyPath: cred ? cred.keyPath : editForm.keyPath || undefined,
      group: editForm.group || undefined,
      color: editSelectedColor,
      credentialId: editForm.credentialId || undefined,
    };
    saveSessions(
      sessions.map((s) => (s.id === editingSession.id ? updated : s)),
    );
    setEditingSession(null);
  }

  // ── View / Tab management ──
  // (openView / closeView provided by useViewRouter above)

  const openTab = useCallback(
    (entry: SessionEntry, autoConnect = true) => {
      const existing = tabsRef.current.find(
        (t) => t.sessionEntry.id === entry.id,
      );
      if (existing) {
        setActiveView(existing.tabId);
        return;
      }
      const tab: TabPane = {
        tabId: crypto.randomUUID(),
        sessionEntry: entry,
        sshSessionId: null,
        connected: false,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveView(tab.tabId);
      if (autoConnect) setAutoConnectTabId(tab.tabId);
    },
    [setActiveView],
  );

  const closeTabById = useCallback(
    (tabId: string) => {
      const remaining = tabsRef.current.filter((t) => t.tabId !== tabId);
      setTabs(remaining);
      if (activeViewRef.current === tabId) {
        if (remaining.length > 0)
          setActiveView(remaining[remaining.length - 1]!.tabId);
        else openView("overview");
      }
      if (remaining.length === 0 && !openViewsRef.current.has("overview"))
        openView("overview");
      if (splitTabsRef.current[tabId]) {
        setSplitTabs((prev) => {
          const next = { ...prev };
          delete next[tabId];
          return next;
        });
      }
      delete paneRefCallbacks.current[tabId];
      delete paneRefCallbacks.current[`split-${tabId}`];
    },
    [openView, setActiveView],
  );

  const closeAllTerminals = useCallback(() => {
    const allTabs = [...tabsRef.current];
    allTabs.forEach((t) => closeTabById(t.tabId));
  }, [closeTabById]);

  const prefillNewSession = useCallback(
    (host: string) => {
      setForm((f) => ({ ...f, host }));
      setSearchQuery("");
      openView("new-session");
    },
    [openView],
  );

  const toggleSplitForTab = useCallback(
    (tabId: string, direction?: "horizontal" | "vertical") => {
      setSplitTabs((prev) => {
        if (prev[tabId]) {
          if (direction && prev[tabId] !== direction)
            return { ...prev, [tabId]: direction };
          const next = { ...prev };
          delete next[tabId];
          return next;
        }
        return { ...prev, [tabId]: direction || "horizontal" };
      });
    },
    [],
  );

  const connectPane = useCallback((tabId: string) => {
    const el = paneRefs.current[tabId];
    if (el)
      (el as HTMLDivElement & { __reconnect?: () => void }).__reconnect?.();
  }, []);

  const disconnectSplitPane = useCallback((tabId: string) => {
    const el = paneRefs.current[`split-${tabId}`];
    if (el)
      (el as HTMLDivElement & { __disconnect?: () => void }).__disconnect?.();
  }, []);

  const detachTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((t) => t.tabId === tabId);
    if (!tab) return;
    try {
      const label = `detach${Date.now()}`;
      new WebviewWindow(label, {
        url:
          window.location.origin +
          "/?detach=" +
          encodeURIComponent(tab.sessionEntry.id),
        title: tab.sessionEntry.label,
        width: 1000,
        height: 650,
        decorations: false,
        resizable: true,
      });
    } catch (err) {
      console.error("Failed to detach window:", err);
    }
  }, []);

  // Ctrl+F5 → reconnect active tab
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "F5") {
        e.preventDefault();
        const av = activeViewRef.current;
        if (av && tabsRef.current.some((t) => t.tabId === av)) {
          connectPane(av);
        }
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [connectPane]);

  // ── SSH callbacks ──
  const handleConnected = useCallback((tabId: string, sshId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId ? { ...t, sshSessionId: sshId, connected: true } : t,
      ),
    );
  }, []);

  const handleDisconnected = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId ? { ...t, sshSessionId: null, connected: false } : t,
      ),
    );
  }, []);

  // ── Computed values ──
  const isOverview = activeView === "overview";
  const showSettings = activeView === "settings";
  const isNewSession = activeView === "new-session";
  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeView),
    [tabs, activeView],
  );
  const activeSplit = activeTab ? splitTabs[activeTab.tabId] : undefined;

  // Refit all visible terminal panes when split mode or active tab changes
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const key of Object.keys(paneRefs.current)) {
        const el = paneRefs.current[key] as HTMLDivElement & {
          __fit?: () => void;
        };
        el?.__fit?.();
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [activeSplit, activeView]);

  const activeThemeId = generalSettings.theme ?? "light";
  const darkMode =
    (
      THEMES.find((t) => t.id === activeThemeId) ??
      customThemes.find((t) => t.id === activeThemeId)
    )?.isDark ?? getTheme(activeThemeId).isDark;

  const getStablePaneRef = useCallback((id: string) => {
    if (!paneRefCallbacks.current[id]) {
      paneRefCallbacks.current[id] = (el: HTMLDivElement | null) => {
        paneRefs.current[id] = el;
      };
    }
    return paneRefCallbacks.current[id];
  }, []);

  const tabPasswords = useMemo(() => {
    const map: Record<string, string> = {};
    for (const tab of tabs) {
      map[tab.tabId] =
        passwords[tab.tabId] ||
        credentials.find((c) => c.id === tab.sessionEntry.credentialId)?.pass ||
        "";
    }
    return map;
  }, [tabs, passwords, credentials]);

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const normalizedOverviewSearch = deferredSearchQuery.trim().toLowerCase();
  const connectedTabsBySessionId = useMemo(() => {
    const map = new Map<string, TabPane>();
    for (const tab of tabs) map.set(tab.sessionEntry.id, tab);
    return map;
  }, [tabs]);
  const overviewSessions = useMemo(() => {
    if (!normalizedOverviewSearch) return sessions;
    return sessions.filter(
      (s) =>
        s.label.toLowerCase().includes(normalizedOverviewSearch) ||
        s.host.toLowerCase().includes(normalizedOverviewSearch),
    );
  }, [sessions, normalizedOverviewSearch]);

  const connectedCount = useMemo(
    () => tabs.filter((t) => t.connected).length,
    [tabs],
  );

  const handleEditSession = useCallback((s: SessionEntry) => {
    setEditForm({
      label: s.label,
      host: s.host,
      port: s.port,
      user: s.user,
      pass: s.pass || "",
      keyPath: s.keyPath || "",
      group: s.group || "",
      credentialId: s.credentialId || "",
    });
    setEditSelectedColor(s.color || NEON_COLORS[0]!);
    setEditingSession(s);
  }, []);

  // ── Render ──
  return (
    <div className="flex flex-col h-screen bg-hx-bg text-hx-text overflow-hidden">
      {/* ── Tab Bar ── */}
      <TabBar
        tabs={tabs}
        setTabs={setTabs}
        activeView={activeView}
        setActiveView={setActiveView}
        openViews={openViews}
        showSettings={showSettings}
        isOverview={isOverview}
        isNewSession={isNewSession}
        splitTabs={splitTabs}
        openView={openView}
        closeView={closeView}
        closeTabById={closeTabById}
        connectPane={connectPane}
        detachTab={detachTab}
        toggleSplitForTab={toggleSplitForTab}
        disconnectSplitPane={disconnectSplitPane}
        setSplitTabs={setSplitTabs}
        setAutoConnectTabId={setAutoConnectTabId}
      />

      {/* ── Main Content ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Settings — always mounted, hidden when not active (preserves tab state) */}
        <div
          style={{
            display: showSettings ? "flex" : "none",
            flex: 1,
            overflow: "hidden",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <Settings
            sessions={sessions}
            credentials={credentials}
            tags={tags}
            scripts={scripts}
            generalSettings={generalSettings}
            saveSessions={saveSessions}
            saveCredentials={saveCredentials}
            saveTags={saveTags}
            saveScripts={saveScripts}
            saveGeneral={saveGeneral}
            editingSession={editingSession}
            setEditingSession={setEditingSession}
            editForm={editForm}
            setEditForm={setEditForm}
            editSelectedColor={editSelectedColor}
            setEditSelectedColor={setEditSelectedColor}
            updateSession={updateSession}
            openTab={openTab}
            prefillNewSession={prefillNewSession}
            importStatus={importStatus}
            setImportStatus={setImportStatus}
            darkMode={darkMode}
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            closeAllTerminals={closeAllTerminals}
            customThemes={customThemes}
            importTheme={importTheme}
            removeTheme={removeTheme}
          />
        </div>

        {/* New Session — conditionally mounted */}
        {isNewSession && (
          <NewSession
            form={form}
            setForm={setForm}
            selectedColor={selectedColor}
            setSelectedColor={setSelectedColor}
            credentials={credentials}
            darkMode={darkMode}
            addSession={addSession}
            closeView={closeView}
          />
        )}

        {/* Overview + Terminal — always mounted; hidden while Settings/NewSession active
            Keeping this always-mounted prevents TerminalPane unmount/cleanup crashes
            and maintains active SSH connections while viewing other pages. */}
        <div
          className="relative flex-1 overflow-hidden"
          style={{ display: showSettings || isNewSession ? "none" : undefined }}
        >
          {/* Overview */}
          <div
            className={`absolute inset-0 flex overflow-hidden ${isOverview ? "" : "invisible"}`}
          >
            <Overview
              sessions={sessions}
              overviewSessions={overviewSessions}
              connectedTabsBySessionId={connectedTabsBySessionId}
              connectedCount={connectedCount}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              openTab={openTab}
              handleEditSession={handleEditSession}
              removeSession={removeSession}
              credentials={credentials}
              darkMode={darkMode}
              importStatus={importStatus}
              openView={openView}
              prefillNewSession={prefillNewSession}
              editingSession={editingSession}
              setEditingSession={setEditingSession}
              editForm={editForm}
              setEditForm={setEditForm}
              editSelectedColor={editSelectedColor}
              setEditSelectedColor={setEditSelectedColor}
              updateSession={updateSession}
            />
          </div>

          {/* Terminal view */}
          <div
            className={`absolute inset-0 flex flex-col overflow-hidden ${isOverview ? "invisible" : ""}`}
          >
            {/* Terminal pane(s) */}
            <div
              style={{
                flex: "1 1 0",
                minHeight: 0,
                minWidth: 0,
                overflow: "hidden",
                display: "grid",
                gap: activeSplit ? "4px" : "0",
                gridTemplateRows:
                  activeSplit === "horizontal" ? "1fr 1fr" : "1fr",
                gridTemplateColumns:
                  activeSplit === "vertical" ? "1fr 1fr" : "1fr",
              }}
            >
              <div
                style={{ overflow: "hidden", minHeight: 0, minWidth: 0 }}
                className={
                  activeSplit === "horizontal"
                    ? "border-b border-hx-border flex flex-col"
                    : activeSplit === "vertical"
                      ? "border-r border-hx-border flex flex-col"
                      : "flex flex-col"
                }
              >
                {tabs.map((tab) => (
                  <div
                    key={tab.tabId}
                    style={{
                      display: activeView === tab.tabId ? "flex" : "none",
                      flex: "1 1 0",
                      minHeight: 0,
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                    <TerminalPane
                      pane={tab}
                      password={tabPasswords[tab.tabId] ?? ""}
                      onConnected={handleConnected}
                      onDisconnected={handleDisconnected}
                      visible={activeView === tab.tabId}
                      paneRef={getStablePaneRef(tab.tabId)}
                      autoConnect={autoConnectTabId === tab.tabId}
                      fontSize={generalSettings.fontSize}
                      fontFamily={generalSettings.fontFamily}
                      disableAlternateScreen={
                        generalSettings.disableAlternateScreen ?? false
                      }
                    />
                  </div>
                ))}
              </div>

              {/* Split panes — always mounted (like main panes) to prevent
                  SSH reconnection when switching away and back to a split tab.
                  Visibility is controlled via display:none, not unmounting. */}
              <div
                style={{
                  display: activeSplit ? "flex" : "none",
                  flexDirection: "column",
                  overflow: "hidden",
                  minHeight: 0,
                  minWidth: 0,
                }}
              >
                {tabs.map((tab) => {
                  if (!splitTabs[tab.tabId]) return null;
                  const isActiveTab = activeView === tab.tabId;
                  return (
                    <div
                      key={`split-${tab.tabId}`}
                      style={{
                        display: isActiveTab ? "flex" : "none",
                        flex: "1 1 0",
                        minHeight: 0,
                        overflow: "hidden",
                      }}
                    >
                      <TerminalPane
                        pane={{
                          ...tab,
                          tabId: `split-${tab.tabId}`,
                          sshSessionId: null,
                          connected: false,
                        }}
                        password={tabPasswords[tab.tabId] ?? ""}
                        onConnected={handleConnected}
                        onDisconnected={handleDisconnected}
                        visible={isActiveTab}
                        paneRef={getStablePaneRef(`split-${tab.tabId}`)}
                        autoConnect
                        fontSize={generalSettings.fontSize}
                        fontFamily={generalSettings.fontFamily}
                        disableAlternateScreen={
                          generalSettings.disableAlternateScreen ?? false
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Quick Commands bar */}
            {activeTab && (
              <div
                className="flex items-center gap-1.5 px-3 py-1 border-t border-hx-border shrink-0 overflow-x-auto select-none"
                style={{ background: "#080A12" }}
              >
                <span className="text-[10px] text-hx-dim tracking-widest uppercase mr-1 shrink-0">
                  CMD
                </span>
                {scripts.filter((sc) => !sc.group || sc.group === activeTab.sessionEntry.group).map((sc) => (
                  <button
                    key={sc.id}
                    onClick={() => {
                      if (activeTab.sshSessionId) {
                        invoke("send_ssh_input", {
                          sessionId: activeTab.sshSessionId,
                          input: sc.content.endsWith("\n")
                            ? sc.content
                            : sc.content + "\n",
                        }).catch(() => {});
                        setTimeout(
                          () =>
                            paneRefs.current[activeTab.tabId] &&
                            (
                              paneRefs.current[
                                activeTab.tabId
                              ] as HTMLDivElement & {
                                __term?: { focus: () => void };
                              }
                            ).__term?.focus?.(),
                          50,
                        );
                      }
                    }}
                    title={sc.content}
                    className="px-2 py-0.5 text-[11px] font-mono bg-hx-neon/10 text-hx-neon border border-hx-neon/20 rounded hover:bg-hx-neon/25 transition-colors whitespace-nowrap shrink-0"
                  >
                    {sc.name}
                  </button>
                ))}
                {scripts.length === 0 && (
                  <span className="text-[10px] text-hx-dim font-mono italic">
                    No quick commands — add them in Settings → Scripts
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <StatusBar
        activeTab={activeTab}
        isOverview={isOverview}
        sessionCount={sessions.length}
      />
    </div>
  );
}

export default App;
