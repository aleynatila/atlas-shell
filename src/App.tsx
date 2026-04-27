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
import "./index.css";
import { getTheme, THEMES } from "./themes";
import {
  NEON_COLORS,
  type Credential,
  type GeneralSettings,
  type SessionEntry,
  type TabPane,
} from "./types";

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [sessions, setSessions] = useState<SessionEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_sessions") || "[]");
    } catch {
      return [];
    }
  });

  const [tabs, setTabs] = useState<TabPane[]>([]);
  const [activeView, setActiveView] = useState<string>("overview");
  const [openViews, setOpenViews] = useState<
    Set<"overview" | "settings" | "new-session">
  >(() => new Set(["overview"] as const));
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
  const [selectedColor, setSelectedColor] = useState(NEON_COLORS[0]);
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
  const [editSelectedColor, setEditSelectedColor] = useState(NEON_COLORS[0]);

  const [credentials, setCredentials] = useState<Credential[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_credentials") || "[]");
    } catch {
      return [];
    }
  });
  const [tags, setTags] = useState<import("./types").Tag[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_tags") || "[]");
    } catch {
      return [];
    }
  });
  const [scripts, setScripts] = useState<import("./types").Script[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_scripts") || "[]");
    } catch {
      return [];
    }
  });
  const [generalSettings, setGeneralSettings] = useState<GeneralSettings>(
    () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem("atlas_general") || "null",
        );
        if (saved) {
          if (!saved.theme) {
            saved.theme = saved.darkMode ? "dark" : "light";
          }
          return saved as GeneralSettings;
        }
        return {
          logPath: "",
          fontSize: 15,
          fontFamily: "'Cascadia Mono', Consolas, monospace",
          theme: "light",
          autoCheckUpdates: false,
          updatePermissionAsked: false,
          disableAlternateScreen: false,
        };
      } catch {
        return {
          logPath: "",
          fontSize: 15,
          fontFamily: "'Cascadia Mono', Consolas, monospace",
          theme: "light",
          autoCheckUpdates: false,
          updatePermissionAsked: false,
          disableAlternateScreen: false,
        };
      }
    },
  );

  const [importStatus, setImportStatus] = useState<string | null>(null);

  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const paneRefCallbacks = useRef<
    Record<string, (el: HTMLDivElement | null) => void>
  >({});

  // Stable refs for useCallback closures
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const openViewsRef = useRef(openViews);
  openViewsRef.current = openViews;
  const splitTabsRef = useRef(splitTabs);
  splitTabsRef.current = splitTabs;

  // Debounce timers for localStorage/keychain writes
  const saveSessionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const saveCredsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Keychain migration + load ──
  useEffect(() => {
    (async () => {
      const enrichedCreds = await Promise.all(
        credentials.map(async (c) => {
          if (c.pass) {
            await invoke("set_credential", {
              id: "cred_" + c.id,
              password: c.pass,
            }).catch(() => {});
          }
          const stored = await invoke<string | null>("get_credential", {
            id: "cred_" + c.id,
          }).catch(() => null);
          return { ...c, pass: stored ?? c.pass };
        }),
      );
      setCredentials(enrichedCreds);
      try {
        localStorage.setItem(
          "atlas_credentials",
          JSON.stringify(enrichedCreds.map(({ pass: _p, ...rest }) => rest)),
        );
      } catch {}

      const enrichedSessions = await Promise.all(
        sessions.map(async (s) => {
          if (!s.credentialId) {
            if (s.pass) {
              await invoke("set_credential", {
                id: "sess_" + s.id,
                password: s.pass,
              }).catch(() => {});
            }
            const stored = await invoke<string | null>("get_credential", {
              id: "sess_" + s.id,
            }).catch(() => null);
            return { ...s, pass: stored ?? s.pass };
          }
          const cred = enrichedCreds.find((c) => c.id === s.credentialId);
          return { ...s, pass: cred?.pass };
        }),
      );
      setSessions(enrichedSessions);
      try {
        localStorage.setItem(
          "atlas_sessions",
          JSON.stringify(enrichedSessions.map(({ pass: _p, ...rest }) => rest)),
        );
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme
  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove("dark", ...THEMES.map((t) => `theme-${t.id}`));
    const theme = generalSettings.theme ?? "light";
    if (theme === "dark") {
      html.classList.add("dark", "theme-dark");
    } else if (theme !== "light") {
      html.classList.add(`theme-${theme}`);
    }
  }, [generalSettings.theme]);

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

  // ── Persistence helpers (stable — no state closures) ──
  const saveSessions = useCallback((list: SessionEntry[]) => {
    setSessions(list);
    if (saveSessionsTimerRef.current)
      clearTimeout(saveSessionsTimerRef.current);
    saveSessionsTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(
          "atlas_sessions",
          JSON.stringify(list.map(({ pass: _p, ...rest }) => rest)),
        );
      } catch {}
      list.forEach((s) => {
        if (!s.credentialId) {
          if (s.pass) {
            invoke("set_credential", {
              id: "sess_" + s.id,
              password: s.pass,
            }).catch(() => {});
          } else {
            invoke("delete_credential", { id: "sess_" + s.id }).catch(() => {});
          }
        }
      });
    }, 400);
  }, []);
  const saveCredentials = useCallback((list: Credential[]) => {
    setCredentials(list);
    if (saveCredsTimerRef.current) clearTimeout(saveCredsTimerRef.current);
    saveCredsTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(
          "atlas_credentials",
          JSON.stringify(list.map(({ pass: _p, ...rest }) => rest)),
        );
      } catch {}
      list.forEach((c) => {
        if (c.pass) {
          invoke("set_credential", {
            id: "cred_" + c.id,
            password: c.pass,
          }).catch(() => {});
        } else {
          invoke("delete_credential", { id: "cred_" + c.id }).catch(() => {});
        }
      });
    }, 400);
  }, []);
  const saveTags = useCallback((list: import("./types").Tag[]) => {
    setTags(list);
    try {
      localStorage.setItem("atlas_tags", JSON.stringify(list));
    } catch {}
  }, []);
  const saveScripts = useCallback((list: import("./types").Script[]) => {
    setScripts(list);
    try {
      localStorage.setItem("atlas_scripts", JSON.stringify(list));
    } catch {}
  }, []);
  const saveGeneral = useCallback((s: GeneralSettings) => {
    setGeneralSettings(s);
    try {
      localStorage.setItem("atlas_general", JSON.stringify(s));
    } catch {}
  }, []);

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
    setSelectedColor(NEON_COLORS[0]);
    return true;
  }

  const removeSession = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = sessionsRef.current.filter((s) => s.id !== id);
    setSessions(updated);
    try {
      localStorage.setItem("atlas_sessions", JSON.stringify(updated));
    } catch {}
    // Clean up keychain entry so credentials don't linger after session deletion
    invoke("delete_credential", { id: `sess_${id}` }).catch(() => {});
  }, []);

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
  const openView = useCallback(
    (kind: "overview" | "settings" | "new-session") => {
      setOpenViews((prev) => {
        if (prev.has(kind)) return prev;
        return new Set([...prev, kind]);
      });
      setActiveView((prev) => (prev === kind ? prev : kind));
    },
    [],
  );
  const closeView = useCallback(
    (kind: "overview" | "settings" | "new-session") => {
      setOpenViews((prev) => {
        const next = new Set(prev);
        next.delete(kind);
        return next;
      });
      if (activeViewRef.current === kind) {
        const other = [...openViewsRef.current].find((v) => v !== kind);
        if (other) setActiveView(other);
        else if (tabsRef.current.length > 0)
          setActiveView(tabsRef.current[tabsRef.current.length - 1].tabId);
        else setActiveView("");
      }
    },
    [],
  );

  const openTab = useCallback((entry: SessionEntry, autoConnect = true) => {
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
  }, []);

  const closeTabById = useCallback(
    (tabId: string) => {
      const remaining = tabsRef.current.filter((t) => t.tabId !== tabId);
      setTabs(remaining);
      if (activeViewRef.current === tabId) {
        if (remaining.length > 0)
          setActiveView(remaining[remaining.length - 1].tabId);
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
    [openView],
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

  const darkMode = getTheme(generalSettings.theme ?? "light").isDark;

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
    setEditSelectedColor(s.color || NEON_COLORS[0]);
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
            importStatus={importStatus}
            setImportStatus={setImportStatus}
            darkMode={darkMode}
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            closeAllTerminals={closeAllTerminals}
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

              {activeTab && activeSplit && (
                <div
                  key={`split-${activeTab.tabId}`}
                  style={{ overflow: "hidden", minHeight: 0, minWidth: 0 }}
                  className="flex flex-col"
                >
                  <div
                    style={{
                      flex: "1 1 0",
                      minHeight: 0,
                      overflow: "hidden",
                    }}
                  >
                    <TerminalPane
                      pane={{
                        ...activeTab,
                        tabId: `split-${activeTab.tabId}`,
                        sshSessionId: null,
                        connected: false,
                      }}
                      password={tabPasswords[activeTab.tabId] ?? ""}
                      onConnected={handleConnected}
                      onDisconnected={handleDisconnected}
                      visible={!!activeSplit}
                      paneRef={getStablePaneRef(`split-${activeTab.tabId}`)}
                      autoConnect
                      fontSize={generalSettings.fontSize}
                      fontFamily={generalSettings.fontFamily}
                      disableAlternateScreen={
                        generalSettings.disableAlternateScreen ?? false
                      }
                    />
                  </div>
                </div>
              )}
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
                {scripts.map((sc) => (
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
