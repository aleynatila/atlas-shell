import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import {
    ChevronRight,
    Download,
    Edit2,
    ExternalLink,
    FolderOpen,
    Info,
    Key,
    Play,
    Plus,
    RefreshCw,
    Server,
    Trash2,
    X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "../lib/toast";
import {
    CUSTOM_THEME_ID_PREFIX,
    serializeTheme,
    THEMES,
    toCustomThemeTemplate,
    type ThemeDef,
} from "../themes";
import {
    adaptColor,
    COLOR_PAIRS,
    NEON_COLORS,
    type Credential,
    type GeneralSettings,
    type Script,
    type SessionEntry,
    type Tag,
} from "../types";

interface SettingsProps {
  sessions: SessionEntry[];
  credentials: Credential[];
  tags: Tag[];
  scripts: Script[];
  generalSettings: GeneralSettings;
  saveSessions: (list: SessionEntry[]) => void;
  saveCredentials: (list: Credential[]) => void;
  saveTags: (list: Tag[]) => void;
  saveScripts: (list: Script[]) => void;
  saveGeneral: (s: GeneralSettings) => void;
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
  openTab: (entry: SessionEntry, autoConnect?: boolean) => void;
  prefillNewSession: (host: string) => void;
  importStatus: string | null;
  setImportStatus: (s: string | null) => void;
  darkMode: boolean;
  closeAllTerminals: () => void;
  customThemes: ThemeDef[];
  importTheme: (
    raw: unknown,
  ) => { ok: true; theme: ThemeDef } | { ok: false; error: string };
  removeTheme: (id: string) => void;
  settingsTab:
    | "sessions"
    | "credentials"
    | "tags"
    | "scripts"
    | "general"
    | "updates"
    | "about"
    | "appearance";
  setSettingsTab: React.Dispatch<
    React.SetStateAction<
      | "sessions"
      | "credentials"
      | "tags"
      | "scripts"
      | "general"
      | "updates"
      | "about"
      | "appearance"
    >
  >;
}

export function Settings({
  sessions,
  credentials,
  tags,
  scripts,
  generalSettings,
  saveSessions,
  saveCredentials,
  saveTags,
  saveScripts,
  saveGeneral,
  editingSession,
  setEditingSession,
  editForm,
  setEditForm,
  editSelectedColor,
  setEditSelectedColor,
  updateSession,
  openTab,
  prefillNewSession,
  importStatus,
  setImportStatus,
  darkMode,
  settingsTab,
  setSettingsTab,
  closeAllTerminals,
  customThemes,
  importTheme,
  removeTheme,
}: SettingsProps) {
  // ── Settings-local state ──
  // settingsTab is now lifted to App.tsx so it persists when navigating away
  const [settingsSearch, setSettingsSearch] = useState("");

  // Draft state for General tab — saved explicitly via Save button
  const [generalDraft, setGeneralDraft] = useState({
    logPath: generalSettings.logPath,
  });
  const [generalSaved, setGeneralSaved] = useState(false);

  // Draft state for Appearance tab
  const [appearanceDraft, setAppearanceDraft] = useState({
    fontSize: generalSettings.fontSize,
    fontFamily: generalSettings.fontFamily,
  });
  const [appearanceSaved, setAppearanceSaved] = useState(false);
  const [showCloseWarning, setShowCloseWarning] = useState(false);

  // Credential form
  const [credForm, setCredForm] = useState({
    label: "",
    user: "root",
    pass: "",
    keyPath: "",
  });
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  // Tag form
  const [tagForm, setTagForm] = useState({ name: "", color: NEON_COLORS[0] });
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  // Script form
  const [scriptForm, setScriptForm] = useState({
    name: "",
    content: "",
    group: "",
  });
  const [editingScript, setEditingScript] = useState<Script | null>(null);
  const [scriptSearch, setScriptSearch] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );

  // Dynamic app version
  const [appVersion, setAppVersion] = useState("…");
  useEffect(() => {
    let mounted = true;
    getAppVersion()
      .then((v) => {
        if (mounted) setAppVersion(normalizeVersion(v));
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // ── Credential CRUD ──
  function addCredential() {
    if (!credForm.user) return;
    const c: Credential = {
      id: crypto.randomUUID(),
      label: credForm.label || credForm.user,
      user: credForm.user,
      pass: credForm.pass || undefined,
      keyPath: credForm.keyPath || undefined,
    };
    saveCredentials([c, ...credentials]);
    setCredForm({ label: "", user: "root", pass: "", keyPath: "" });
  }
  function updateCredential() {
    if (!editingCred) return;
    const updated: Credential = {
      ...editingCred,
      label: credForm.label || credForm.user,
      user: credForm.user,
      pass: credForm.pass || undefined,
      keyPath: credForm.keyPath || undefined,
    };
    saveCredentials(
      credentials.map((c) => (c.id === editingCred.id ? updated : c)),
    );
    setEditingCred(null);
    setCredForm({ label: "", user: "root", pass: "", keyPath: "" });
  }
  function removeCredential(id: string) {
    saveCredentials(credentials.filter((c) => c.id !== id));
  }

  // ── Tag CRUD ──
  function addTag() {
    if (!tagForm.name) return;
    const t: Tag = {
      id: crypto.randomUUID(),
      name: tagForm.name,
      color: tagForm.color ?? NEON_COLORS[0]!,
    };
    saveTags([t, ...tags]);
    setTagForm({ name: "", color: NEON_COLORS[0]! });
  }
  function updateTag() {
    if (!editingTag) return;
    saveTags(
      tags.map((t) =>
        t.id === editingTag.id
          ? {
              ...editingTag,
              name: tagForm.name,
              color: tagForm.color ?? NEON_COLORS[0]!,
            }
          : t,
      ),
    );
    setEditingTag(null);
    setTagForm({ name: "", color: NEON_COLORS[0]! });
  }
  function removeTag(id: string) {
    saveTags(tags.filter((t) => t.id !== id));
  }

  // ── Script CRUD ──
  function addScript() {
    if (!scriptForm.name || !scriptForm.content) return;
    const s: Script = {
      id: crypto.randomUUID(),
      name: scriptForm.name,
      content: scriptForm.content,
      group: scriptForm.group || undefined,
    };
    saveScripts([s, ...scripts]);
    setScriptForm({ name: "", content: "", group: "" });
  }
  function updateScript() {
    if (!editingScript) return;
    saveScripts(
      scripts.map((s) =>
        s.id === editingScript.id
          ? {
              ...editingScript,
              ...scriptForm,
              group: scriptForm.group || undefined,
            }
          : s,
      ),
    );
    setEditingScript(null);
    setScriptForm({ name: "", content: "", group: "" });
  }
  function removeScript(id: string) {
    saveScripts(scripts.filter((s) => s.id !== id));
  }

  // ── Import / Export ──
  function exportSettings() {
    const data = {
      sessions,
      credentials,
      tags,
      scripts,
      generalSettings,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function importSettings(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (Array.isArray(data.sessions)) saveSessions(data.sessions);
        if (Array.isArray(data.credentials)) saveCredentials(data.credentials);
        if (Array.isArray(data.tags)) saveTags(data.tags);
        if (Array.isArray(data.scripts)) saveScripts(data.scripts);
        if (data.generalSettings) saveGeneral(data.generalSettings);
        setImportStatus("✓ Settings imported successfully");
        setTimeout(() => setImportStatus(null), 4000);
      } catch {
        setImportStatus("✗ Import failed — invalid file");
        setTimeout(() => setImportStatus(null), 4000);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left nav */}
      <div className="w-44 bg-hx-panel border-r border-hx-border flex flex-col gap-1 p-3 shrink-0">
        {(
          [
            "sessions",
            "credentials",
            "tags",
            "scripts",
            "appearance",
            "general",
            "updates",
            "about",
          ] as const
        ).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setSettingsTab(tab);
              setSettingsSearch("");
            }}
            className={`text-left px-3 py-2 text-xs font-mono uppercase tracking-widest transition-colors rounded-sm ${
              settingsTab === tab
                ? "text-hx-neon bg-hx-neon/10"
                : "text-hx-muted hover:text-hx-text hover:bg-hx-neon/5"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Right content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        {/* Settings search */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search settings..."
            value={settingsSearch}
            onChange={(e) => setSettingsSearch(e.target.value)}
            className="hx-input bg-hx-bg border border-hx-border px-3 py-1.5 text-xs w-full font-mono"
          />
        </div>

        {/* ── Sessions tab ── */}
        {settingsTab === "sessions" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon">
                Sessions
              </h2>
              <div className="flex items-center gap-2">
                {importStatus && (
                  <span
                    className={`text-[10px] font-mono ${importStatus.startsWith("✓") ? "text-hx-success" : "text-hx-danger"}`}
                  >
                    {importStatus}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-2">
              {sessions.length === 0 && (
                <p className="text-hx-dim text-xs font-mono">
                  No sessions saved.
                </p>
              )}
              {(() => {
                const filtered = sessions.filter((s) => {
                  const q = settingsSearch.toLowerCase();
                  return (
                    !q ||
                    s.label.toLowerCase().includes(q) ||
                    s.host.toLowerCase().includes(q) ||
                    (s.user || "").toLowerCase().includes(q)
                  );
                });
                if (
                  sessions.length > 0 &&
                  filtered.length === 0 &&
                  settingsSearch
                ) {
                  return (
                    <div className="flex flex-col items-center justify-center py-14 gap-4">
                      <div className="relative p-2">
                        <div
                          className="w-10 h-10 border border-hx-neon/20 rotate-45 flex items-center justify-center"
                          style={{ boxShadow: "0 0 12px rgba(0,229,255,0.04)" }}
                        >
                          <Server
                            size={14}
                            className="text-hx-dim -rotate-45"
                          />
                        </div>
                        <div className="absolute inset-0 border border-hx-neon/08 rotate-45" />
                      </div>
                      <p className="text-hx-muted text-xs font-mono">
                        No session found for{" "}
                        <span className="text-hx-text font-bold">
                          "{settingsSearch}"
                        </span>
                      </p>
                      <button
                        onClick={() => prefillNewSession(settingsSearch)}
                        className="hx-clip-btn flex items-center gap-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-hx-neon border border-hx-neon/40 hover:border-hx-neon/80 hover:bg-hx-neon/10 transition-all"
                        style={{ boxShadow: "0 0 10px rgba(0,229,255,0.08)" }}
                      >
                        <Plus size={11} />
                        Create session for "{settingsSearch}"
                      </button>
                    </div>
                  );
                }
                return filtered.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center gap-3 p-3 bg-hx-panel border transition-colors cursor-pointer ${
                      editingSession?.id === s.id
                        ? "border-hx-neon/50"
                        : "border-hx-border hover:border-hx-border/80"
                    }`}
                    onClick={() => {
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
                    }}
                    onDoubleClick={() => openTab(s, true)}
                  >
                    <div
                      className="w-1.5 h-1.5 rotate-45 shrink-0"
                      style={{ background: s.color || "#00E5FF" }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono text-hx-text truncate">
                        {s.label}
                      </div>
                      <div className="text-[10px] text-hx-muted font-mono">
                        {s.user ? `${s.user}@` : ""}
                        {s.host}:{s.port}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openTab(s, true);
                      }}
                      className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                      title="Connect"
                    >
                      <Play size={11} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        saveSessions(sessions.filter((x) => x.id !== s.id));
                        if (editingSession?.id === s.id)
                          setEditingSession(null);
                      }}
                      className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}

        {/* ── Credentials tab ── */}
        {settingsTab === "credentials" && (
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
              Credentials
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {/* Form */}
              <div className="bg-hx-panel border border-hx-border p-4 space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  {editingCred ? "Edit Credential" : "New Credential"}
                </p>
                {[
                  {
                    label: "Label",
                    key: "label" as const,
                    placeholder: "production-root",
                    type: "text",
                  },
                  {
                    label: "Username",
                    key: "user" as const,
                    placeholder: "root",
                    type: "text",
                  },
                  {
                    label: "Password",
                    key: "pass" as const,
                    placeholder: "optional",
                    type: "password",
                  },
                  {
                    label: "Key Path",
                    key: "keyPath" as const,
                    placeholder: "/home/.ssh/id_rsa",
                    type: "text",
                  },
                ].map(({ label, key, placeholder, type }) => (
                  <div key={key}>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                      {label}
                    </label>
                    <input
                      type={type}
                      placeholder={placeholder}
                      value={String(credForm[key])}
                      onChange={(e) =>
                        setCredForm((f) => ({ ...f, [key]: e.target.value }))
                      }
                      className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs"
                    />
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  {editingCred && (
                    <button
                      onClick={() => {
                        setEditingCred(null);
                        setCredForm({
                          label: "",
                          user: "root",
                          pass: "",
                          keyPath: "",
                        });
                      }}
                      className="flex-1 py-1.5 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={editingCred ? updateCredential : addCredential}
                    className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                    style={{
                      background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                      border: "1px solid #00E5FF55",
                      color: "#00E5FF",
                    }}
                  >
                    {editingCred ? "◆ Update" : "◆ Add"}
                  </button>
                </div>
              </div>
              {/* List */}
              <div className="space-y-2">
                {credentials.length === 0 && (
                  <p className="text-hx-dim text-xs font-mono">
                    No credentials saved.
                  </p>
                )}
                {credentials.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 p-3 bg-hx-panel border border-hx-border"
                  >
                    <Key size={11} className="text-hx-neon/60 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono text-hx-text truncate">
                        {c.label}
                      </div>
                      <div className="text-[10px] text-hx-muted">
                        {c.user}
                        {c.keyPath ? " · key" : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setEditingCred(c);
                        setCredForm({
                          label: c.label,
                          user: c.user,
                          pass: c.pass || "",
                          keyPath: c.keyPath || "",
                        });
                      }}
                      className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                    >
                      <Edit2 size={11} />
                    </button>
                    <button
                      onClick={() => removeCredential(c.id)}
                      className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Tags tab ── */}
        {settingsTab === "tags" && (
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
              Tags
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-hx-panel border border-hx-border p-4 space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  {editingTag ? "Edit Tag" : "New Tag"}
                </p>
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    placeholder="production"
                    value={tagForm.name}
                    onChange={(e) =>
                      setTagForm((f) => ({ ...f, name: e.target.value }))
                    }
                    className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-2">
                    Color
                  </label>
                  <div className="flex gap-3">
                    {COLOR_PAIRS.map(({ dark: canonical, light: lightC }) => {
                      const c = darkMode ? canonical : lightC;
                      const isSelected = tagForm.color === canonical;
                      return (
                        <button
                          key={canonical}
                          onClick={() =>
                            setTagForm((f) => ({ ...f, color: canonical }))
                          }
                          className="w-5 h-5 rotate-45 transition-all hover:scale-110"
                          style={{
                            background: c,
                            boxShadow: isSelected ? `0 0 10px ${c}` : "none",
                            outline: isSelected
                              ? `2px solid ${c}`
                              : "2px solid transparent",
                            outlineOffset: "2px",
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  {editingTag && (
                    <button
                      onClick={() => {
                        setEditingTag(null);
                        setTagForm({ name: "", color: NEON_COLORS[0] });
                      }}
                      className="flex-1 py-1.5 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={editingTag ? updateTag : addTag}
                    className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                    style={{
                      background: `linear-gradient(135deg,${tagForm.color}22,${tagForm.color}0a)`,
                      border: `1px solid ${tagForm.color}55`,
                      color: tagForm.color,
                    }}
                  >
                    {editingTag ? "◆ Update" : "◆ Add"}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {tags.length === 0 && (
                  <p className="text-hx-dim text-xs font-mono">
                    No tags saved.
                  </p>
                )}
                {tags.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 p-3 bg-hx-panel border border-hx-border"
                  >
                    <div
                      className="w-2 h-2 rotate-45 shrink-0"
                      style={{ background: t.color }}
                    />
                    <span className="flex-1 text-xs font-mono text-hx-text">
                      {t.name}
                    </span>
                    <button
                      onClick={() => {
                        setEditingTag(t);
                        setTagForm({ name: t.name, color: t.color });
                      }}
                      className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                    >
                      <Edit2 size={11} />
                    </button>
                    <button
                      onClick={() => removeTag(t.id)}
                      className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Scripts tab ── */}
        {settingsTab === "scripts" &&
          (() => {
            const allGroups = [
              ...new Set(
                scripts.filter((s) => s.group).map((s) => s.group as string),
              ),
            ].sort();
            const q = scriptSearch.trim().toLowerCase();
            const ungrouped = scripts.filter((s) => !s.group);

            const isOpen = (key: string) => !collapsedFolders.has(key);
            const toggleFolder = (key: string) => {
              setCollapsedFolders((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            };

            const selectScript = (s: Script) => {
              setEditingScript(s);
              setScriptForm({
                name: s.name,
                content: s.content,
                group: s.group || "",
              });
            };
            const clearScript = () => {
              setEditingScript(null);
              setScriptForm({ name: "", content: "", group: "" });
            };

            const ScriptRow = memo(({ s }: { s: Script }) => (
              <div
                className={`group flex items-center gap-2 px-3 py-2 border-b border-hx-border/30 transition-colors cursor-pointer ${
                  editingScript?.id === s.id
                    ? "bg-hx-neon/8 border-l-2 border-l-hx-neon"
                    : "hover:bg-hx-neon/5"
                }`}
                onClick={() => selectScript(s)}
              >
                <span className="text-[10px] text-hx-dim/50 font-mono shrink-0">
                  ›
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-mono text-hx-text truncate block">
                    {s.name}
                  </span>
                  <span className="text-[10px] text-hx-dim font-mono truncate block">
                    {s.content.split("\n")[0]}
                  </span>
                </div>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      selectScript(s);
                    }}
                    className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                    title="Edit"
                  >
                    <Edit2 size={11} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeScript(s.id);
                      if (editingScript?.id === s.id) clearScript();
                    }}
                    className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ));

            const FolderSection = ({
              folderKey,
              label,
              folderScripts,
            }: {
              folderKey: string;
              label: string;
              folderScripts: Script[];
            }) => {
              const open = isOpen(folderKey);
              return (
                <div>
                  <button
                    onClick={() => toggleFolder(folderKey)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-hx-neon/5 transition-colors border-b border-hx-border/30"
                  >
                    <ChevronRight
                      size={10}
                      className={`text-hx-dim transition-transform duration-150 shrink-0 ${open ? "rotate-90" : ""}`}
                    />
                    <FolderOpen
                      size={12}
                      className={`shrink-0 transition-colors ${open ? "text-hx-neon/70" : "text-hx-muted"}`}
                    />
                    <span
                      className={`text-[11px] font-mono flex-1 text-left truncate ${open ? "text-hx-text" : "text-hx-muted"}`}
                    >
                      {label}
                    </span>
                    <span className="text-[10px] font-mono text-hx-dim/60 shrink-0 bg-hx-bg px-1.5 py-0.5 rounded">
                      {folderScripts.length}
                    </span>
                  </button>
                  {open && (
                    <div className="border-l border-hx-neon/10 ml-5">
                      {folderScripts.map((s) => (
                        <ScriptRow key={s.id} s={s} />
                      ))}
                    </div>
                  )}
                </div>
              );
            };

            // Flat search results
            const searchResults = q
              ? scripts.filter(
                  (s) =>
                    s.name.toLowerCase().includes(q) ||
                    s.content.toLowerCase().includes(q) ||
                    (s.group ?? "").toLowerCase().includes(q),
                )
              : null;

            return (
              <div
                className="flex gap-5 min-h-0"
                style={{ height: "calc(100vh - 180px)" }}
              >
                {/* ── Left column: folder tree ── */}
                <div
                  className="flex flex-col gap-3 min-h-0"
                  style={{ width: "38%" }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between flex-none">
                    <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon">
                      Scripts
                    </h2>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-hx-dim font-mono">
                        {scripts.length} total
                      </span>
                      <button
                        onClick={clearScript}
                        className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-hx-neon/70 border border-hx-neon/20 hover:bg-hx-neon/10 hover:text-hx-neon transition-colors"
                        title="New script"
                      >
                        <Plus size={10} />
                        New
                      </button>
                    </div>
                  </div>

                  {/* Search */}
                  <div className="relative flex-none">
                    <input
                      type="text"
                      placeholder="Search scripts..."
                      value={scriptSearch}
                      onChange={(e) => setScriptSearch(e.target.value)}
                      className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs font-mono"
                    />
                    {scriptSearch && (
                      <button
                        onClick={() => setScriptSearch("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-hx-dim hover:text-hx-text"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>

                  {/* Tree */}
                  <div
                    className="flex-1 min-h-0 overflow-y-auto border border-hx-border bg-hx-bg"
                    style={{
                      scrollbarWidth: "thin",
                      scrollbarColor: "var(--color-hx-border) transparent",
                    }}
                  >
                    {/* Empty state */}
                    {scripts.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-40 gap-3 text-center px-4">
                        <Play size={22} className="text-hx-border" />
                        <div>
                          <p className="text-xs text-hx-muted font-mono">
                            No scripts yet
                          </p>
                          <p className="text-[10px] text-hx-dim font-mono mt-1">
                            Fill the form → click Add Script
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Search: flat results */}
                    {searchResults &&
                      (searchResults.length === 0 ? (
                        <p className="text-[10px] text-hx-dim font-mono px-3 py-4 text-center">
                          No matching scripts
                        </p>
                      ) : (
                        <div>
                          {searchResults.map((s) => (
                            <ScriptRow key={s.id} s={s} />
                          ))}
                        </div>
                      ))}

                    {/* Normal: accordion folder tree */}
                    {!searchResults && scripts.length > 0 && (
                      <div>
                        {ungrouped.length > 0 && (
                          <FolderSection
                            folderKey="__general__"
                            label="General"
                            folderScripts={ungrouped}
                          />
                        )}
                        {allGroups.map((group) => (
                          <FolderSection
                            key={group}
                            folderKey={group}
                            label={group}
                            folderScripts={scripts.filter(
                              (s) => s.group === group,
                            )}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Right column: form ── */}
                <div className="flex-1 min-h-0">
                  <div className="bg-hx-panel border border-hx-border p-5 flex flex-col gap-4 h-full">
                    {/* Form header */}
                    <div className="flex items-center justify-between flex-none">
                      <p className="text-xs font-bold uppercase tracking-[0.15em] text-hx-neon">
                        {editingScript ? "Edit Script" : "New Script"}
                      </p>
                      {editingScript && (
                        <button
                          onClick={clearScript}
                          className="text-hx-dim hover:text-hx-text transition-colors"
                          title="Cancel edit"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>

                    {/* Name */}
                    <div className="flex-none">
                      <label className="block text-[11px] font-mono text-hx-muted mb-1.5">
                        Name
                      </label>
                      <input
                        type="text"
                        placeholder="update-system"
                        value={scriptForm.name}
                        onChange={(e) =>
                          setScriptForm((f) => ({ ...f, name: e.target.value }))
                        }
                        className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs"
                      />
                    </div>

                    {/* Folder / Group */}
                    <div className="flex-none">
                      <label className="block text-[11px] font-mono text-hx-muted mb-1.5">
                        Folder / Group{" "}
                        <span className="text-hx-dim">(optional)</span>
                      </label>
                      <input
                        type="text"
                        list="script-groups"
                        placeholder="production"
                        value={scriptForm.group}
                        onChange={(e) =>
                          setScriptForm((f) => ({
                            ...f,
                            group: e.target.value,
                          }))
                        }
                        className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs"
                      />
                      <datalist id="script-groups">
                        {allGroups.map((g) => (
                          <option key={g} value={g} />
                        ))}
                      </datalist>
                      {allGroups.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {allGroups.map((g) => (
                            <button
                              key={g}
                              type="button"
                              onClick={() =>
                                setScriptForm((f) => ({
                                  ...f,
                                  group: f.group === g ? "" : g,
                                }))
                              }
                              className={`px-2 py-0.5 text-[10px] font-mono border transition-colors ${
                                scriptForm.group === g
                                  ? "bg-hx-neon/15 text-hx-neon border-hx-neon/30"
                                  : "bg-hx-bg text-hx-dim border-hx-border hover:text-hx-text hover:border-hx-border/80"
                              }`}
                            >
                              {g}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Commands */}
                    <div className="flex-1 flex flex-col min-h-0">
                      <label className="block text-[11px] font-mono text-hx-muted mb-1.5 flex-none">
                        Commands
                      </label>
                      <textarea
                        placeholder={
                          "apt update && apt upgrade -y\nsystemctl restart nginx"
                        }
                        value={scriptForm.content}
                        onChange={(e) =>
                          setScriptForm((f) => ({
                            ...f,
                            content: e.target.value,
                          }))
                        }
                        className="hx-input flex-1 min-h-0 w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono resize-none"
                      />
                    </div>

                    {/* Action button */}
                    <div className="flex-none flex justify-end">
                      <button
                        onClick={editingScript ? updateScript : addScript}
                        disabled={!scriptForm.name || !scriptForm.content}
                        className="hx-clip-btn px-6 py-2 text-[11px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background:
                            "linear-gradient(135deg,#00E5FF33,#00E5FF15)",
                          border: "1px solid #00E5FF66",
                          color: "#00E5FF",
                          boxShadow: "0 0 12px rgba(0,229,255,0.1)",
                        }}
                      >
                        {editingScript ? "◆ Update" : "◆ Add Script"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

        {/* ── Appearance tab ── */}
        {settingsTab === "appearance" && (
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
              Appearance
            </h2>

            {/* Warning banner */}
            <div
              className="mb-4 flex items-start gap-2 px-4 py-3 max-w-lg rounded-md"
              style={{ background: "#0f172a", border: "1px solid #334155" }}
            >
              <span
                className="text-sm leading-none mt-0.5 shrink-0"
                style={{ color: "#fb923c" }}
              >
                ⚠
              </span>
              <p
                className="text-[10px] font-mono leading-relaxed"
                style={{ color: "#cbd5e1" }}
              >
                Changing font settings will{" "}
                <strong style={{ color: "#fb923c" }}>
                  close all open terminals
                </strong>
                . Unsaved session output will be lost. Apply changes only when
                you're ready.
              </p>
            </div>
            <div className="bg-hx-panel border border-hx-border p-5 space-y-6 max-w-lg">
              {/* Font Family */}
              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  Terminal Font Family
                </label>
                <select
                  value={appearanceDraft.fontFamily}
                  onChange={(e) =>
                    setAppearanceDraft((d) => ({
                      ...d,
                      fontFamily: e.target.value,
                    }))
                  }
                  className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                >
                  <optgroup label="── Recommended ──">
                    <option value="'Cascadia Mono', Consolas, monospace">
                      Cascadia Mono
                    </option>
                    <option value="'Cascadia Code', Consolas, monospace">
                      Cascadia Code (ligatures)
                    </option>
                    <option value="'Fira Code', Consolas, monospace">
                      Fira Code (ligatures)
                    </option>
                    <option value="'JetBrains Mono', Consolas, monospace">
                      JetBrains Mono
                    </option>
                    <option value="'Source Code Pro', Consolas, monospace">
                      Source Code Pro
                    </option>
                    <option value="'Hack', Consolas, monospace">Hack</option>
                    <option value="'Inconsolata', Consolas, monospace">
                      Inconsolata
                    </option>
                    <option value="'Ubuntu Mono', Consolas, monospace">
                      Ubuntu Mono
                    </option>
                    <option value="'Roboto Mono', Consolas, monospace">
                      Roboto Mono
                    </option>
                    <option value="'IBM Plex Mono', Consolas, monospace">
                      IBM Plex Mono
                    </option>
                    <option value="'Iosevka', Consolas, monospace">
                      Iosevka
                    </option>
                  </optgroup>
                  <optgroup label="── System Fonts ──">
                    <option value="Consolas, monospace">Consolas</option>
                    <option value="'Lucida Console', monospace">
                      Lucida Console
                    </option>
                    <option value="'Courier New', monospace">
                      Courier New
                    </option>
                    <option value="Menlo, monospace">Menlo</option>
                    <option value="Monaco, monospace">Monaco</option>
                    <option value="'DejaVu Sans Mono', monospace">
                      DejaVu Sans Mono
                    </option>
                  </optgroup>
                </select>

                {/* Font Preview */}
                <div className="border border-hx-border bg-hx-bg p-4 space-y-2">
                  <p className="text-[9px] font-mono uppercase tracking-widest text-hx-dim mb-2">
                    Preview
                  </p>
                  <div
                    style={{
                      fontFamily: appearanceDraft.fontFamily,
                      fontSize: appearanceDraft.fontSize,
                    }}
                    className="text-hx-text leading-relaxed"
                  >
                    <div>{`atlas-shell v${appVersion} — SSH Client`}</div>
                    <div className="text-hx-neon">
                      root@server:~$ ls -la /var/log/
                    </div>
                    <div className="text-hx-muted">
                      drwxr-xr-x 2 root root 4096 Apr 20 12:34 nginx/
                    </div>
                    <div className="text-hx-muted">
                      -rw-r--r-- 1 root root 8192 Apr 20 12:34 syslog
                    </div>
                    <div className="text-hx-success">
                      ✓ Connected to 192.168.1.1 · latency 12ms
                    </div>
                    <div className="text-hx-danger">
                      ✗ Connection refused: port 22 not reachable
                    </div>
                    <div className="text-hx-dim">
                      AaBbCcDd EeFfGgHh IiJjKk 0123456789 !@#$%^&*()
                    </div>
                    <div className="text-hx-dim">
                      {"[ ] { } < > /\\ | - _ = + ; : \" ' ` ~ , . ?"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Font Size */}
              <div className="space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  Terminal Font Size
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min={8}
                    max={28}
                    step={1}
                    value={appearanceDraft.fontSize}
                    onChange={(e) =>
                      setAppearanceDraft((d) => ({
                        ...d,
                        fontSize: Number(e.target.value),
                      }))
                    }
                    className="flex-1 accent-hx-neon"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        setAppearanceDraft((d) => ({
                          ...d,
                          fontSize: Math.max(8, d.fontSize - 1),
                        }))
                      }
                      className="w-7 h-7 border border-hx-border text-hx-dim hover:text-hx-text hover:border-hx-neon/40 text-sm leading-none flex items-center justify-center transition-colors"
                    >
                      −
                    </button>
                    <span className="text-sm font-mono text-hx-text w-8 text-center">
                      {appearanceDraft.fontSize}
                    </span>
                    <button
                      onClick={() =>
                        setAppearanceDraft((d) => ({
                          ...d,
                          fontSize: Math.min(28, d.fontSize + 1),
                        }))
                      }
                      className="w-7 h-7 border border-hx-border text-hx-dim hover:text-hx-text hover:border-hx-neon/40 text-sm leading-none flex items-center justify-center transition-colors"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="flex justify-between text-[9px] font-mono text-hx-dim px-0.5">
                  <span>8px</span>
                  <span>14px</span>
                  <span>20px</span>
                  <span>28px</span>
                </div>
              </div>

              {/* Apply button */}
              <div className="pt-1 border-t border-hx-border space-y-3">
                {!showCloseWarning ? (
                  <button
                    onClick={() => setShowCloseWarning(true)}
                    className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                    style={{
                      background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                      border: "1px solid #00E5FF55",
                      color: "#00E5FF",
                    }}
                  >
                    Apply Appearance Settings
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] font-mono text-orange-400">
                      This will close all open terminals. Continue?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          closeAllTerminals();
                          saveGeneral({
                            ...generalSettings,
                            fontSize: appearanceDraft.fontSize,
                            fontFamily: appearanceDraft.fontFamily,
                          });
                          setShowCloseWarning(false);
                          setAppearanceSaved(true);
                          setTimeout(() => setAppearanceSaved(false), 2500);
                        }}
                        className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all hover:bg-orange-500/20"
                        style={{
                          background:
                            "linear-gradient(135deg, #ea580c22, #ea580c0a)", // Şeffaf turuncu
                          border: "1px solid #ea580c", // Belirgin turuncu kenarlık
                          color: "#fdba74", // Açık turuncu
                        }}
                      >
                        Yes, close &amp; apply
                      </button>
                      <button
                        onClick={() => setShowCloseWarning(false)}
                        className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all hover:bg-slate-700"
                        style={{
                          background:
                            "linear-gradient(135deg, #33415544, #1e293b44)", // Yarı şeffaf lacivert/gri
                          border: "1px solid #475569",
                          color: "#94a3b8", // Soluk mavi-gri
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {appearanceSaved && (
                  <p className="text-[10px] font-mono text-hx-success">
                    ✓ Appearance settings applied
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── General tab ── */}
        {settingsTab === "general" && (
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
              General Settings
            </h2>
            <div className="bg-hx-panel border border-hx-border p-5 space-y-4 max-w-md">
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                  Log Folder Path
                </label>
                <input
                  type="text"
                  placeholder="/var/log/atlas"
                  value={generalDraft.logPath}
                  onChange={(e) =>
                    setGeneralDraft((d) => ({ ...d, logPath: e.target.value }))
                  }
                  className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                />
              </div>
              {/* Save button */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => {
                    saveGeneral({
                      ...generalSettings,
                      logPath: generalDraft.logPath,
                    });
                    setGeneralSaved(true);
                    setTimeout(() => setGeneralSaved(false), 2000);
                  }}
                  className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                  style={{
                    background: generalSaved
                      ? "linear-gradient(135deg,#00FF8822,#00FF880a)"
                      : "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                    border: generalSaved
                      ? "1px solid #00FF8855"
                      : "1px solid #00E5FF55",
                    color: generalSaved ? "#00FF88" : "#00E5FF",
                  }}
                >
                  {generalSaved ? "✓ Saved" : "Save Settings"}
                </button>
              </div>
              <p className="text-[10px] text-hx-dim font-mono">
                Font and appearance settings have moved to the{" "}
                <button
                  onClick={() => setSettingsTab("appearance")}
                  className="text-hx-neon hover:underline cursor-pointer"
                >
                  Appearance
                </button>{" "}
                tab.
              </p>
              <div className="pt-2 border-t border-hx-border space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                      PuTTY Mode (Nano/Vim Scrollback)
                    </label>
                    <p className="text-[10px] text-hx-dim font-mono mt-1 leading-relaxed">
                      Nano/vim çıkınca önceki terminal satırları silinsin mi?
                      <span className="text-hx-muted">
                        {" "}
                        Kapalı = standart davranış (önerilen). Açık = PuTTY gibi
                        nano içeriği scrollback'te kalır ama ekran sıfırlanır.
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      saveGeneral({
                        ...generalSettings,
                        disableAlternateScreen: !(
                          generalSettings.disableAlternateScreen ?? false
                        ),
                      })
                    }
                    className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${(generalSettings.disableAlternateScreen ?? false) ? "bg-hx-neon/30" : "bg-hx-border"}`}
                  >
                    <div
                      className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${(generalSettings.disableAlternateScreen ?? false) ? "left-4 bg-hx-neon" : "left-0.5 bg-hx-dim"}`}
                      style={
                        (generalSettings.disableAlternateScreen ?? false)
                          ? { boxShadow: "0 0 6px var(--color-hx-neon)" }
                          : {}
                      }
                    />
                  </button>
                </div>
              </div>
              {/* Theme picker */}
              <div className="pt-2 border-t border-hx-border space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  Theme
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {[...THEMES, ...customThemes].map((t) => {
                    const isActive =
                      (generalSettings.theme ?? "light") === t.id;
                    const isCustom = t.id.startsWith(CUSTOM_THEME_ID_PREFIX);
                    return (
                      <div key={t.id} className="relative group">
                        <button
                          onClick={() =>
                            saveGeneral({ ...generalSettings, theme: t.id })
                          }
                          className={`flex flex-col items-start gap-1 px-3 py-2.5 border transition-all text-left hx-clip-btn w-full ${
                            isActive
                              ? "border-hx-neon/70 bg-hx-neon/10"
                              : "border-hx-border hover:border-hx-neon/40 hover:bg-hx-neon/5"
                          }`}
                        >
                          <div className="flex gap-1 mb-0.5">
                            {[
                              t.vars["--color-hx-bg"],
                              t.vars["--color-hx-panel"],
                              t.vars["--color-hx-neon"],
                            ].map((c, i) => (
                              <span
                                key={i}
                                className="w-3 h-3 rounded-sm border border-white/10"
                                style={{ background: c }}
                              />
                            ))}
                          </div>
                          <span
                            className={`text-[10px] font-bold uppercase tracking-widest ${isActive ? "text-hx-neon" : "text-hx-text"}`}
                          >
                            {t.label}
                            {isCustom && (
                              <span className="ml-1 text-hx-dim font-normal">
                                ·custom
                              </span>
                            )}
                          </span>
                          <span className="text-[9px] text-hx-dim font-mono">
                            {t.description}
                          </span>
                        </button>
                        {isCustom && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if ((generalSettings.theme ?? "light") === t.id) {
                                saveGeneral({
                                  ...generalSettings,
                                  theme: "light",
                                });
                              }
                              removeTheme(t.id);
                              showToast(`Removed theme "${t.label}"`, {
                                variant: "info",
                              });
                            }}
                            title="Remove custom theme"
                            className="absolute top-1 right-1 p-0.5 text-hx-dim hover:text-hx-danger opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X size={10} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Theme import / export */}
                <div className="flex gap-2 pt-1">
                  <label
                    className="flex-1 py-1.5 text-[9px] font-bold uppercase tracking-widest hx-clip-btn flex items-center justify-center gap-1.5 cursor-pointer transition-all"
                    style={{
                      background: "linear-gradient(135deg,#BD00FF22,#BD00FF0a)",
                      border: "1px solid #BD00FF55",
                      color: "#BD00FF",
                    }}
                  >
                    <FolderOpen size={10} />
                    Import Theme
                    <input
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        if (file.size > 64 * 1024) {
                          showToast("Theme file too large", {
                            variant: "error",
                            detail: "Theme JSON must be < 64 KB.",
                          });
                          return;
                        }
                        try {
                          const text = await file.text();
                          const parsed = JSON.parse(text);
                          const result = importTheme(parsed);
                          if (result.ok) {
                            saveGeneral({
                              ...generalSettings,
                              theme: result.theme.id,
                            });
                            showToast(
                              `Imported theme "${result.theme.label}"`,
                              { variant: "success" },
                            );
                          } else {
                            showToast("Theme import failed", {
                              variant: "error",
                              detail: result.error,
                            });
                          }
                        } catch (err) {
                          showToast("Theme import failed", {
                            variant: "error",
                            detail:
                              err instanceof Error
                                ? err.message
                                : "Invalid JSON.",
                          });
                        }
                      }}
                    />
                  </label>
                  <button
                    onClick={() => {
                      const activeId = generalSettings.theme ?? "light";
                      const current =
                        THEMES.find((t) => t.id === activeId) ??
                        customThemes.find((t) => t.id === activeId) ??
                        THEMES[0]!;
                      const template = current.id.startsWith(
                        CUSTOM_THEME_ID_PREFIX,
                      )
                        ? current
                        : toCustomThemeTemplate(current);
                      const json = serializeTheme(template);
                      const blob = new Blob([json], {
                        type: "application/json",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${template.id}.json`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                    className="flex-1 py-1.5 text-[9px] font-bold uppercase tracking-widest hx-clip-btn flex items-center justify-center gap-1.5 transition-all"
                    style={{
                      background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                      border: "1px solid #00E5FF55",
                      color: "#00E5FF",
                    }}
                  >
                    <Download size={10} />
                    Export Theme
                  </button>
                </div>
                <p className="text-[9px] text-hx-dim font-mono leading-relaxed">
                  Theme JSON must use a <code>custom-*</code> id and include all
                  <code> --color-hx-*</code> values. See README for the schema.
                </p>
              </div>
              {/* Import / Export */}
              <div className="pt-3 border-t border-hx-border space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  Data Backup
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={exportSettings}
                    className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn flex items-center justify-center gap-1.5 transition-all"
                    style={{
                      background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                      border: "1px solid #00E5FF55",
                      color: "#00E5FF",
                    }}
                  >
                    <Download size={10} />
                    Export
                  </button>
                  <label
                    className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                    style={{
                      background: "linear-gradient(135deg,#BD00FF22,#BD00FF0a)",
                      border: "1px solid #BD00FF55",
                      color: "#BD00FF",
                    }}
                  >
                    <FolderOpen size={10} />
                    Import
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) importSettings(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                {importStatus && (
                  <p
                    className={`text-[10px] font-mono ${importStatus.startsWith("✓") ? "text-hx-success" : "text-hx-danger"}`}
                  >
                    {importStatus}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Updates tab ── */}
        {settingsTab === "updates" && (
          <UpdatesTab
            generalSettings={generalSettings}
            saveGeneral={saveGeneral}
          />
        )}

        {/* ── About tab ── */}
        {settingsTab === "about" && (
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
              About
            </h2>
            <div className="bg-hx-panel border border-hx-border p-6 space-y-5 max-w-md">
              <div className="flex items-center gap-3">
                <div
                  className="w-3 h-3 rotate-45 bg-hx-neon shrink-0"
                  style={{ boxShadow: "0 0 12px #00E5FF" }}
                />
                <span className="text-lg font-black tracking-[0.25em] uppercase text-hx-neon">
                  Atlas
                </span>
                <span className="text-xs text-hx-dim font-mono bg-hx-bg border border-hx-border px-2 py-0.5 rounded">
                  {`v${appVersion}`}
                </span>
              </div>
              <p className="text-xs text-hx-muted font-mono leading-relaxed">
                A modern SSH client built with Tauri, React, and Rust. Supports
                multi-tab sessions, split terminal views, SCP uploads, quick
                commands, and Solar PuTTY import.
              </p>
              <div className="border-t border-hx-border pt-4 space-y-2 text-[10px] font-mono">
                {[
                  ["Framework", "Tauri v2 + React 18"],
                  ["Language", "TypeScript + Rust"],
                  ["Terminal", "xterm.js"],
                  ["Protocol", "SSHv2 (libssh2)"],
                  ["Platform", "Windows x64"],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between border-b border-hx-border/50 pb-1"
                  >
                    <span className="text-hx-dim">{label}</span>
                    <span className="text-hx-muted">{value}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-hx-border pt-4 mt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-hx-dim">
                    Made by
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      shellOpen("https://github.com/aleynatila");
                    }}
                    className="text-[10px] font-mono text-hx-neon hover:underline cursor-pointer"
                  >
                    Aleyna Atila
                  </button>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] font-mono text-hx-dim">
                    GitHub
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      shellOpen("https://github.com/aleynatila");
                    }}
                    className="text-[10px] font-mono text-hx-muted hover:text-hx-neon hover:underline transition-colors cursor-pointer"
                  >
                    github.com/aleynatila
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Info size={11} className="text-hx-dim" />
                <span className="text-[10px] text-hx-dim font-mono">
                  Settings stored in browser localStorage per origin. Use
                  Export/Import (General) to transfer data between dev and
                  production builds.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Edit Sidebar (settings page) ── */}
      {editingSession && settingsTab === "sessions" && (
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

// ── Updates Tab ───────────────────────────────────────────────────────────────

const RELEASES_URL = "https://github.com/aleynatila/atlas-shell/releases";

interface UpdateInfo {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
  downloadUrl: string | null;
}

function UpdatesTab({
  generalSettings,
  saveGeneral,
}: {
  generalSettings: GeneralSettings;
  saveGeneral: (s: GeneralSettings) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [latestRelease, setLatestRelease] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cached Update object from checkForUpdates — reused for install so we
  // don't call checkUpdate() twice (second call can fail on flaky networks).
  const pendingUpdateRef = useRef<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState("…");
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(() => {
    try {
      return localStorage.getItem("atlas_last_update_check");
    } catch {
      return null;
    }
  });

  const updatePermissionAsked = generalSettings.updatePermissionAsked ?? false;
  const autoCheck = generalSettings.autoCheckUpdates ?? false;
  const hasTauriRuntime =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    let mounted = true;
    getAppVersion()
      .then((version) => {
        if (mounted && version) setCurrentVersion(normalizeVersion(version));
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await shellOpen(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!latestRelease || !hasTauriRuntime) {
      setError(
        "Signed updater is only available inside the Tauri desktop app.",
      );
      return;
    }
    setInstalling(true);
    setInstallStatus("Downloading signed update package...");
    setError(null);
    try {
      // Reuse the Update object cached during checkForUpdates to avoid a
      // second network round-trip that can fail independently and silently
      // report "no update available" even though one was found moments ago.
      let update = pendingUpdateRef.current;
      if (!update) {
        update = await checkUpdate();
      }
      if (!update) {
        setError("No update available. Please check for updates first.");
        setInstalling(false);
        return;
      }
      await update.downloadAndInstall((event: { event: string }) => {
        if (event.event === "Started") {
          setInstallStatus("Downloading signed update package...");
        } else if (event.event === "Finished") {
          setInstallStatus("Update installed. Restarting Atlas...");
        }
      });
      setConfirmInstall(false);
      setUpdateAvailable(false);
      setLatestRelease((current) =>
        current
          ? { ...current, version: currentVersion, name: `v${currentVersion}` }
          : current,
      );
      setInstallStatus("Update installed. Restarting Atlas...");
      await relaunch();
    } catch (err) {
      setError(`Update failed: ${String(err)}`);
      setInstallStatus(null);
    } finally {
      setInstalling(false);
    }
  }, [currentVersion, hasTauriRuntime, latestRelease]);

  const checkForUpdates = useCallback(async () => {
    if (!hasTauriRuntime) {
      setError(
        "Update checks are only available inside the packaged Atlas desktop app.",
      );
      setLatestRelease(null);
      setUpdateAvailable(null);
      return;
    }

    setChecking(true);
    setError(null);
    setInstallStatus(null);
    try {
      // Use the Tauri updater plugin (routes through Rust, no CORS/WebView restrictions).
      // check() returns null when no update is available (current === latest).
      const update = await checkUpdate();
      // Cache for downloadAndInstall so it doesn't need a second network call.
      pendingUpdateRef.current = update ?? null;
      let info: UpdateInfo;
      let effectiveShouldUpdate: boolean;

      if (update) {
        // A newer version is available
        effectiveShouldUpdate = true;
        info = {
          version: normalizeVersion(update.version),
          name: `v${normalizeVersion(update.version)}`,
          body: update.body || "",
          publishedAt: normalizePublishedAt(update.date),
          htmlUrl: RELEASES_URL,
          downloadUrl: null,
        };
      } else {
        // Already on latest version
        effectiveShouldUpdate = false;
        info = {
          version: currentVersion,
          name: `v${currentVersion}`,
          body: "",
          publishedAt: "",
          htmlUrl: RELEASES_URL,
          downloadUrl: null,
        };
      }

      setUpdateAvailable(effectiveShouldUpdate);
      setLatestRelease(info);

      const now = new Date().toISOString();
      setLastChecked(now);
      try {
        localStorage.setItem("atlas_last_update_check", now);
        localStorage.setItem("atlas_latest_release", JSON.stringify(info));
        localStorage.setItem(
          "atlas_update_available",
          JSON.stringify(effectiveShouldUpdate),
        );
      } catch {}
    } catch (err) {
      setUpdateAvailable(null);
      setError(`Update check failed: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  }, [currentVersion, hasTauriRuntime]);

  // Auto-check on mount if enabled
  useEffect(() => {
    if (!updatePermissionAsked || !autoCheck) return;
    // Only auto-check once per 6 hours
    const last = localStorage.getItem("atlas_last_update_check");
    if (last) {
      const elapsed = Date.now() - new Date(last).getTime();
      if (elapsed < 6 * 60 * 60 * 1000) {
        try {
          const cached = localStorage.getItem("atlas_latest_release");
          const cachedAvailability = localStorage.getItem(
            "atlas_update_available",
          );
          if (cached) setLatestRelease(JSON.parse(cached));
          if (cachedAvailability)
            setUpdateAvailable(JSON.parse(cachedAvailability));
        } catch {}
        return;
      }
    }
    void checkForUpdates();
  }, [autoCheck, checkForUpdates, updatePermissionAsked]);

  // Cache latest release for auto-check throttle
  useEffect(() => {
    if (latestRelease && updateAvailable !== null) {
      try {
        localStorage.setItem(
          "atlas_latest_release",
          JSON.stringify(latestRelease),
        );
        localStorage.setItem(
          "atlas_update_available",
          JSON.stringify(updateAvailable),
        );
      } catch {}
    }
  }, [latestRelease, updateAvailable]);

  const versionComparison = latestRelease
    ? compareVersions(latestRelease.version, currentVersion)
    : null;
  const isNewer =
    !!latestRelease && versionComparison !== null && versionComparison > 0;
  const isUpToDate =
    !!latestRelease && versionComparison !== null && versionComparison <= 0;
  const releaseDateLabel = latestRelease?.publishedAt
    ? formatPublishedAt(latestRelease.publishedAt)
    : null;

  return (
    <div>
      <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
        Updates
      </h2>
      <div className="bg-hx-panel border border-hx-border p-5 space-y-4 max-w-md">
        {/* Current version */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
              Current Version
            </p>
            <span className="text-sm font-bold text-hx-text font-mono">
              v{currentVersion}
            </span>
          </div>
          {isUpToDate && (
            <div className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rotate-45 bg-hx-success"
                style={{ boxShadow: "0 0 6px var(--color-hx-success)" }}
              />
              <span className="text-[10px] text-hx-success font-mono font-bold">
                Up to date
              </span>
            </div>
          )}
          {isNewer && (
            <div className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rotate-45 bg-hx-warning"
                style={{ boxShadow: "0 0 6px var(--color-hx-warning)" }}
              />
              <span className="text-[10px] text-hx-warning font-mono font-bold">
                Update available
              </span>
            </div>
          )}
          {!latestRelease && !checking && (
            <div
              className="w-2 h-2 rotate-45 bg-hx-dim"
              style={{ opacity: 0.5 }}
            />
          )}
        </div>

        {/* Latest version */}
        <div className="border-t border-hx-border pt-3">
          <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
            Latest Version
          </p>
          {checking ? (
            <div className="flex items-center gap-2">
              <RefreshCw size={12} className="text-hx-neon animate-spin" />
              <span className="text-xs text-hx-muted font-mono">
                Checking...
              </span>
            </div>
          ) : latestRelease ? (
            <div>
              <span
                className={`text-sm font-bold font-mono ${isNewer ? "text-hx-warning" : "text-hx-success"}`}
                data-latest-version={latestRelease.version}
              >
                v{latestRelease.version}
              </span>
              {latestRelease.name &&
                latestRelease.name !== `v${latestRelease.version}` && (
                  <span className="text-[10px] text-hx-muted font-mono ml-2">
                    — {latestRelease.name}
                  </span>
                )}
              {releaseDateLabel && (
                <p className="text-[10px] text-hx-dim font-mono mt-0.5">
                  Released {releaseDateLabel}
                </p>
              )}
            </div>
          ) : error ? (
            <p className="text-[10px] text-hx-danger font-mono">{error}</p>
          ) : (
            <span className="text-sm text-hx-muted font-mono">—</span>
          )}
        </div>

        {/* Release notes (if newer) */}
        {isNewer && latestRelease?.body && (
          <div className="border-t border-hx-border pt-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
              What's New
            </p>
            <div className="text-[11px] text-hx-muted font-mono leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto pr-1">
              {latestRelease.body.length > 500
                ? latestRelease.body.slice(0, 500) + "..."
                : latestRelease.body}
            </div>
          </div>
        )}

        {/* Update permission */}
        {!updatePermissionAsked && (
          <div className="border-t border-hx-border pt-3 space-y-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
              Automatic Update Checks
            </p>
            <p className="text-[10px] text-hx-muted font-mono leading-relaxed">
              Allow Atlas to check the signed Atlas update feed automatically.
              Atlas will not install anything silently; it only checks for new
              versions and asks before downloading and applying a signed update.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  saveGeneral({
                    ...generalSettings,
                    updatePermissionAsked: true,
                    autoCheckUpdates: true,
                  })
                }
                className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                style={{
                  background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                  border: "1px solid #00E5FF55",
                  color: "#00E5FF",
                }}
              >
                Allow
              </button>
              <button
                onClick={() =>
                  saveGeneral({
                    ...generalSettings,
                    updatePermissionAsked: true,
                    autoCheckUpdates: false,
                  })
                }
                className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                style={{
                  background: "linear-gradient(135deg,#33415544,#1e293b44)",
                  border: "1px solid #475569",
                  color: "#cbd5e1",
                }}
              >
                Not Now
              </button>
            </div>
          </div>
        )}

        {/* Auto-check toggle */}
        <div className="border-t border-hx-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
              Auto-check for updates
            </span>
            <button
              disabled={!updatePermissionAsked}
              onClick={() =>
                saveGeneral({
                  ...generalSettings,
                  autoCheckUpdates: !autoCheck,
                })
              }
              className={`relative w-8 h-4 rounded-full transition-colors ${autoCheck ? "bg-hx-neon/30" : "bg-hx-border"} ${!updatePermissionAsked ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              <div
                className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${autoCheck ? "left-4 bg-hx-neon" : "left-0.5 bg-hx-dim"}`}
                style={
                  autoCheck ? { boxShadow: "0 0 6px var(--color-hx-neon)" } : {}
                }
              />
            </button>
          </div>
          {lastChecked && (
            <p className="text-[10px] text-hx-dim font-mono mt-1">
              Last checked: {new Date(lastChecked).toLocaleString()}
            </p>
          )}
          {!updatePermissionAsked && (
            <p className="text-[10px] text-hx-dim font-mono mt-1">
              Enable permission above to allow background update checks.
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={checkForUpdates}
            disabled={checking || installing}
            className={`flex-1 py-2.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all flex items-center justify-center gap-1.5 ${checking ? "opacity-40 cursor-wait" : ""}`}
            style={{
              background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
              border: "1px solid #00E5FF55",
              color: "#00E5FF",
            }}
          >
            <RefreshCw size={10} className={checking ? "animate-spin" : ""} />
            {checking ? "Checking..." : "◆ Check for Updates"}
          </button>

          {isNewer && latestRelease && (
            <button
              onClick={() => setConfirmInstall(true)}
              disabled={installing}
              className={`flex-1 py-2.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all flex items-center justify-center gap-1.5 ${installing ? "opacity-60 cursor-wait" : ""}`}
              style={{
                background: "linear-gradient(135deg,#00FF8822,#00FF880a)",
                border: "1px solid #00FF8855",
                color: "#00FF88",
              }}
            >
              {installing ? (
                <>
                  <RefreshCw size={10} className="animate-spin" />
                  {installStatus ?? "Updating..."}
                </>
              ) : (
                <>
                  <Download size={10} />◆ Install v{latestRelease.version}
                </>
              )}
            </button>
          )}
        </div>

        {confirmInstall && latestRelease && (
          <div className="border border-hx-border bg-hx-bg px-3 py-3 space-y-3">
            <p className="text-[10px] text-hx-warning font-mono">
              Atlas will download and verify the signed v{latestRelease.version}
              update package, then restart the app to finish applying it.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => void downloadAndInstall()}
                disabled={installing}
                className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                style={{
                  background: "linear-gradient(135deg,#00FF8822,#00FF880a)",
                  border: "1px solid #00FF8855",
                  color: "#00FF88",
                }}
              >
                Confirm Install
              </button>
              <button
                onClick={() => setConfirmInstall(false)}
                className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                style={{
                  background: "linear-gradient(135deg,#33415544,#1e293b44)",
                  border: "1px solid #475569",
                  color: "#cbd5e1",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Status messages */}
        {installStatus && !error && (
          <p className="text-[10px] text-hx-success font-mono">
            {installStatus}
          </p>
        )}
        {error && (
          <p className="text-[10px] text-hx-danger font-mono">{error}</p>
        )}

        {/* GitHub link */}
        <button
          onClick={() => void openExternalUrl(RELEASES_URL)}
          className="w-full flex items-center justify-center gap-1.5 text-[10px] text-hx-muted font-mono hover:text-hx-neon transition-colors cursor-pointer"
        >
          <ExternalLink size={9} />
          View all releases on GitHub
        </button>
      </div>
    </div>
  );
}

/** Compare semver strings. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map(Number);
  const pb = normalizeVersion(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").split("-")[0] ?? "";
}

function normalizePublishedAt(
  ...candidates: Array<string | undefined>
): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (!Number.isNaN(Date.parse(normalized))) {
      return normalized;
    }
  }
  return "";
}

function formatPublishedAt(value: string): string | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleDateString();
}

// ── Edit Session Sidebar (shared between Settings and Overview) ──

interface EditSessionSidebarProps {
  editingSession: SessionEntry;
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
  credentials: Credential[];
  darkMode: boolean;
}

export const EditSessionSidebar = memo(function EditSessionSidebar({
  editingSession,
  setEditingSession,
  editForm,
  setEditForm,
  editSelectedColor,
  setEditSelectedColor,
  updateSession,
  credentials,
  darkMode,
}: EditSessionSidebarProps) {
  return (
    <div className="w-72 bg-hx-panel border-l border-hx-border flex flex-col shrink-0 overflow-y-auto">
      {/* Sidebar header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hx-border shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rotate-45 bg-hx-neon"
            style={{ boxShadow: "0 0 6px #00E5FF" }}
          />
          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-hx-neon">
            Edit Session
          </span>
        </div>
        <button
          onClick={() => setEditingSession(null)}
          className="text-hx-dim hover:text-hx-text transition-colors"
        >
          <X size={13} />
        </button>
      </div>
      {/* Sidebar body */}
      <div className="px-4 py-4 space-y-3 flex-1">
        {[
          {
            label: "Session Name",
            key: "label" as const,
            type: "text",
          },
          {
            label: "Host / IP",
            key: "host" as const,
            type: "text",
          },
          {
            label: "Port",
            key: "port" as const,
            type: "text",
          },
        ].map(({ label, key, type }) => (
          <div key={key}>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
              {label}
            </label>
            <input
              type={type}
              placeholder=""
              value={String(editForm[key])}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, [key]: e.target.value }))
              }
              className="hx-input w-full bg-hx-bg border border-hx-border px-2 py-1.5 text-xs"
            />
          </div>
        ))}
        {credentials.length > 0 && (
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
              Credential
            </label>
            <select
              value={editForm.credentialId}
              onChange={(e) => {
                const cred = credentials.find((c) => c.id === e.target.value);
                setEditForm((f) => ({
                  ...f,
                  credentialId: e.target.value,
                  user: cred ? cred.user : f.user,
                  // Clear pass/keyPath when removing a credential so the old
                  // credential password doesn't silently carry over into the session.
                  pass: cred ? cred.pass || "" : "",
                  keyPath: cred ? cred.keyPath || "" : "",
                }));
              }}
              className="hx-input w-full bg-hx-bg border border-hx-border px-2 py-1.5 text-xs font-mono"
            >
              <option value="">— none —</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {[
          {
            label: "Username",
            key: "user" as const,
            type: "text",
          },
          {
            label: "Key Path",
            key: "keyPath" as const,
            type: "text",
          },
          {
            label: "Password",
            key: "pass" as const,
            type: "password",
          },
        ]
          .filter(({ key }) =>
            editForm.credentialId && (key === "user" || key === "pass")
              ? false
              : true,
          )
          .map(({ label, key, type }) => (
            <div key={key}>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
                {label}
              </label>
              <input
                type={type}
                placeholder=""
                value={String(editForm[key])}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, [key]: e.target.value }))
                }
                className="hx-input w-full bg-hx-bg border border-hx-border px-2 py-1.5 text-xs"
              />
            </div>
          ))}
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-2">
            Accent Color
          </label>
          <div className="flex items-center gap-2">
            {COLOR_PAIRS.map(({ dark: canonical, light: lightC }) => {
              const c = darkMode ? canonical : lightC;
              const isSelected = editSelectedColor === canonical;
              return (
                <button
                  key={canonical}
                  onClick={() => setEditSelectedColor(canonical)}
                  className="w-5 h-5 rotate-45 transition-all hover:scale-110"
                  style={{
                    background: c,
                    boxShadow: isSelected ? `0 0 10px ${c}` : "none",
                    outline: isSelected
                      ? `2px solid ${c}`
                      : "2px solid transparent",
                    outlineOffset: "2px",
                  }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            onClick={() => setEditingSession(null)}
            className="flex-1 py-2 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
          >
            Cancel
          </button>
          <button
            onClick={updateSession}
            className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
            style={{
              background: `linear-gradient(135deg, ${adaptColor(editSelectedColor, darkMode)}22, ${adaptColor(editSelectedColor, darkMode)}0a)`,
              border: `1px solid ${adaptColor(editSelectedColor, darkMode)}55`,
              color: adaptColor(editSelectedColor, darkMode),
            }}
          >
            ◆ Save
          </button>
        </div>
      </div>
    </div>
  );
});
