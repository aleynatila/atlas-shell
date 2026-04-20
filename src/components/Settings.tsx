import { open as shellOpen } from "@tauri-apps/api/shell";
import {
    Download,
    Edit2,
    ExternalLink,
    FolderOpen,
    Info,
    Key,
    Play,
    RefreshCw,
    Trash2,
    X,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { THEMES } from "../themes";
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
  importStatus: string | null;
  setImportStatus: (s: string | null) => void;
  darkMode: boolean;
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
  importStatus,
  setImportStatus,
  darkMode,
}: SettingsProps) {
  // ── Settings-local state ──
  const [settingsTab, setSettingsTab] = useState<
    | "sessions"
    | "credentials"
    | "tags"
    | "scripts"
    | "general"
    | "updates"
    | "about"
  >("sessions");
  const [settingsSearch, setSettingsSearch] = useState("");

  // Draft state for General tab — saved explicitly via Save button
  const [generalDraft, setGeneralDraft] = useState({
    logPath: generalSettings.logPath,
    fontSize: generalSettings.fontSize,
    fontFamily: generalSettings.fontFamily,
  });
  const [generalSaved, setGeneralSaved] = useState(false);

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
  const [scriptForm, setScriptForm] = useState({ name: "", content: "" });
  const [editingScript, setEditingScript] = useState<Script | null>(null);

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
      color: tagForm.color,
    };
    saveTags([t, ...tags]);
    setTagForm({ name: "", color: NEON_COLORS[0] });
  }
  function updateTag() {
    if (!editingTag) return;
    saveTags(
      tags.map((t) =>
        t.id === editingTag.id
          ? { ...editingTag, name: tagForm.name, color: tagForm.color }
          : t,
      ),
    );
    setEditingTag(null);
    setTagForm({ name: "", color: NEON_COLORS[0] });
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
    };
    saveScripts([s, ...scripts]);
    setScriptForm({ name: "", content: "" });
  }
  function updateScript() {
    if (!editingScript) return;
    saveScripts(
      scripts.map((s) =>
        s.id === editingScript.id ? { ...editingScript, ...scriptForm } : s,
      ),
    );
    setEditingScript(null);
    setScriptForm({ name: "", content: "" });
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
    a.click();
    URL.revokeObjectURL(url);
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
    <div className="flex flex-1 overflow-hidden">
      {/* Left nav */}
      <div className="w-44 bg-hx-panel border-r border-hx-border flex flex-col gap-1 p-3 shrink-0">
        {(
          [
            "sessions",
            "credentials",
            "tags",
            "scripts",
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
      <div className="flex-1 overflow-y-auto p-6">
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
              {sessions
                .filter((s) => {
                  const q = settingsSearch.toLowerCase();
                  return (
                    !q ||
                    s.label.toLowerCase().includes(q) ||
                    s.host.toLowerCase().includes(q) ||
                    (s.user || "").toLowerCase().includes(q)
                  );
                })
                .map((s) => (
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
                      setEditSelectedColor(s.color || NEON_COLORS[0]);
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
                        {s.user}@{s.host}:{s.port}
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
                ))}
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
        {settingsTab === "scripts" && (
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
              Scripts
            </h2>
            <div className="space-y-4">
              <div className="bg-hx-panel border border-hx-border p-4 space-y-3">
                <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  {editingScript ? "Edit Script" : "New Script"}
                </p>
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    placeholder="update-system"
                    value={scriptForm.name}
                    onChange={(e) =>
                      setScriptForm((f) => ({ ...f, name: e.target.value }))
                    }
                    className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                    Commands
                  </label>
                  <textarea
                    placeholder={
                      "apt update && apt upgrade -y\nsystemctl restart nginx"
                    }
                    value={scriptForm.content}
                    onChange={(e) =>
                      setScriptForm((f) => ({ ...f, content: e.target.value }))
                    }
                    rows={5}
                    className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono resize-y"
                  />
                </div>
                <div className="flex gap-2">
                  {editingScript && (
                    <button
                      onClick={() => {
                        setEditingScript(null);
                        setScriptForm({ name: "", content: "" });
                      }}
                      className="flex-1 py-1.5 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={editingScript ? updateScript : addScript}
                    className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                    style={{
                      background: "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                      border: "1px solid #00E5FF55",
                      color: "#00E5FF",
                    }}
                  >
                    {editingScript ? "◆ Update" : "◆ Add"}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {scripts.length === 0 && (
                  <p className="text-hx-dim text-xs font-mono">
                    No scripts saved.
                  </p>
                )}
                {scripts.map((s) => (
                  <div
                    key={s.id}
                    className="p-3 bg-hx-panel border border-hx-border"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-mono font-bold text-hx-neon">
                        {s.name}
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            setEditingScript(s);
                            setScriptForm({ name: s.name, content: s.content });
                          }}
                          className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                        >
                          <Edit2 size={11} />
                        </button>
                        <button
                          onClick={() => removeScript(s.id)}
                          className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                    <pre className="text-[10px] text-hx-muted font-mono whitespace-pre-wrap line-clamp-3">
                      {s.content}
                    </pre>
                  </div>
                ))}
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
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                  Terminal Font Size
                </label>
                <input
                  type="number"
                  min={8}
                  max={32}
                  value={generalDraft.fontSize}
                  onChange={(e) =>
                    setGeneralDraft((d) => ({
                      ...d,
                      fontSize: Number(e.target.value),
                    }))
                  }
                  className="hx-input w-24 bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                  Terminal Font Family
                </label>
                <select
                  value={generalDraft.fontFamily}
                  onChange={(e) =>
                    setGeneralDraft((d) => ({
                      ...d,
                      fontFamily: e.target.value,
                    }))
                  }
                  className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                >
                  <option value="'Cascadia Mono', Consolas, monospace">Cascadia Mono (Regular)</option>
                  <option value="'Cascadia Code', Consolas, monospace">Cascadia Code</option>
                  <option value="'Fira Code', Consolas, monospace">Fira Code</option>
                  <option value="'JetBrains Mono', Consolas, monospace">JetBrains Mono</option>
                  <option value="'Source Code Pro', Consolas, monospace">Source Code Pro</option>
                  <option value="Consolas, monospace">Consolas</option>
                  <option value="'Courier New', monospace">Courier New</option>
                </select>
              </div>
              {/* Save button */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => {
                    saveGeneral({
                      ...generalSettings,
                      logPath: generalDraft.logPath,
                      fontSize: generalDraft.fontSize,
                      fontFamily: generalDraft.fontFamily,
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
                  {generalSaved ? "✓ Saved" : "Save Font Settings"}
                </button>
              </div>
              <p className="text-[10px] text-hx-dim font-mono">
                Font changes apply immediately to all open terminals.
              </p>
              {/* Theme picker */}
              <div className="pt-2 border-t border-hx-border space-y-2">
                <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                  Theme
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {THEMES.map((t) => {
                    const isActive =
                      (generalSettings.theme ?? "light") === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() =>
                          saveGeneral({ ...generalSettings, theme: t.id })
                        }
                        className={`flex flex-col items-start gap-1 px-3 py-2.5 border transition-all text-left hx-clip-btn ${
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
                        </span>
                        <span className="text-[9px] text-hx-dim font-mono">
                          {t.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
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
                  v0.1.0
                </span>
              </div>
              <p className="text-xs text-hx-muted font-mono leading-relaxed">
                A modern SSH client built with Tauri, React, and Rust. Supports
                multi-tab sessions, split terminal views, SFTP uploads, quick
                commands, and Solar PuTTY import.
              </p>
              <div className="border-t border-hx-border pt-4 space-y-2 text-[10px] font-mono">
                {[
                  ["Framework", "Tauri v1 + React 18"],
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

const CURRENT_VERSION = "0.1.7";
const GITHUB_REPO = "aleynatila/atlas-shell";
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

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
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(() => {
    try {
      return localStorage.getItem("atlas_last_update_check");
    } catch {
      return null;
    }
  });

  const autoCheck = generalSettings.autoCheckUpdates ?? true;

  const downloadAndInstall = useCallback(async () => {
    if (!latestRelease) return;
    const url = latestRelease.downloadUrl;
    if (!url) {
      shellOpen(latestRelease.htmlUrl);
      return;
    }
    setInstalling(true);
    setInstallStatus("Downloading installer...");
    setError(null);
    try {
      const { Command } = await import("@tauri-apps/api/shell");
      // Download to %TEMP% then launch installer; PS exits after Start-Process returns
      const ps = `$dest = "$env:TEMP\\atlas-update.exe"; (New-Object Net.WebClient).DownloadFile('${url}', $dest); Start-Process $dest`;
      const result = await new Command("powershell", [
        "-NoProfile",
        "-Command",
        ps,
      ]).execute();
      if (result.code !== 0) {
        throw new Error(
          result.stderr || "PowerShell exited with code " + result.code,
        );
      }
      setInstallStatus("Installer launched — closing app...");
      setTimeout(async () => {
        const { exit } = await import("@tauri-apps/api/process");
        await exit(0);
      }, 1200);
    } catch (err) {
      setError(`Update failed: ${String(err)}`);
      setInstalling(false);
      setInstallStatus(null);
    }
  }, [latestRelease]);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers: { Accept: "application/vnd.github.v3+json" } },
      );
      if (!res.ok) {
        if (res.status === 404) {
          setError("No releases found yet.");
        } else if (res.status === 403) {
          setError("Rate limited — try again in a minute.");
        } else {
          setError(`GitHub API error (${res.status})`);
        }
        setChecking(false);
        return;
      }
      const data = await res.json();
      const tag: string = data.tag_name ?? "";
      const version = tag.replace(/^v/, "");

      // Find .exe asset for download
      const assets: { name: string; browser_download_url: string }[] =
        data.assets ?? [];
      const exeAsset = assets.find(
        (a) => a.name.endsWith(".exe") || a.name.endsWith(".msi"),
      );

      const info: UpdateInfo = {
        version,
        name: data.name || tag,
        body: data.body || "",
        publishedAt: data.published_at || "",
        htmlUrl: data.html_url || RELEASES_URL,
        downloadUrl: exeAsset?.browser_download_url ?? null,
      };
      setLatestRelease(info);

      const now = new Date().toISOString();
      setLastChecked(now);
      try {
        localStorage.setItem("atlas_last_update_check", now);
      } catch {}
    } catch (err) {
      setError(`Network error: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  }, []);

  // Auto-check on mount if enabled
  useEffect(() => {
    if (!autoCheck) return;
    // Only auto-check once per 6 hours
    const last = localStorage.getItem("atlas_last_update_check");
    if (last) {
      const elapsed = Date.now() - new Date(last).getTime();
      if (elapsed < 6 * 60 * 60 * 1000) {
        // Restore cached result
        try {
          const cached = localStorage.getItem("atlas_latest_release");
          if (cached) setLatestRelease(JSON.parse(cached));
        } catch {}
        return;
      }
    }
    checkForUpdates().then(() => {
      // Cache the result
      try {
        const cached = localStorage.getItem("atlas_latest_release");
        if (!cached) {
          // Will be set after state update, so save on next tick
          setTimeout(() => {
            const el = document.querySelector(
              "[data-latest-version]",
            ) as HTMLElement | null;
            if (el?.dataset.latestVersion) {
              // Handled below in effect
            }
          }, 100);
        }
      } catch {}
    });
  }, [autoCheck, checkForUpdates]);

  // Cache latest release for auto-check throttle
  useEffect(() => {
    if (latestRelease) {
      try {
        localStorage.setItem(
          "atlas_latest_release",
          JSON.stringify(latestRelease),
        );
      } catch {}
    }
  }, [latestRelease]);

  const isNewer =
    latestRelease &&
    compareVersions(latestRelease.version, CURRENT_VERSION) > 0;
  const isUpToDate =
    latestRelease &&
    compareVersions(latestRelease.version, CURRENT_VERSION) <= 0;

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
              v{CURRENT_VERSION}
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
              {latestRelease.publishedAt && (
                <p className="text-[10px] text-hx-dim font-mono mt-0.5">
                  Released{" "}
                  {new Date(latestRelease.publishedAt).toLocaleDateString()}
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

        {/* Auto-check toggle */}
        <div className="border-t border-hx-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
              Auto-check for updates
            </span>
            <button
              onClick={() =>
                saveGeneral({
                  ...generalSettings,
                  autoCheckUpdates: !autoCheck,
                })
              }
              className={`relative w-8 h-4 rounded-full transition-colors ${autoCheck ? "bg-hx-neon/30" : "bg-hx-border"}`}
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
              onClick={downloadAndInstall}
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
                  <Download size={10} />◆ Update to v{latestRelease.version}
                </>
              )}
            </button>
          )}
        </div>

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
          onClick={() => shellOpen(RELEASES_URL)}
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
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
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
                  pass: cred ? cred.pass || "" : f.pass,
                  keyPath: cred ? cred.keyPath || "" : f.keyPath,
                }));
              }}
              className="hx-input w-full bg-hx-bg border border-hx-border px-2 py-1.5 text-xs font-mono"
            >
              <option value="">— none —</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.user})
                </option>
              ))}
            </select>
          </div>
        )}
        {[
          {
            label: "Session Name",
            key: "label" as const,
            placeholder: "My Server",
            type: "text",
          },
          {
            label: "Host / IP",
            key: "host" as const,
            placeholder: "192.168.1.1",
            type: "text",
          },
          {
            label: "Port",
            key: "port" as const,
            placeholder: "22",
            type: "text",
          },
          {
            label: "Username",
            key: "user" as const,
            placeholder: "root",
            type: "text",
          },
          {
            label: "Group",
            key: "group" as const,
            placeholder: "production",
            type: "text",
          },
          {
            label: "Key Path",
            key: "keyPath" as const,
            placeholder: "/home/.ssh/id_rsa",
            type: "text",
          },
          {
            label: "Password",
            key: "pass" as const,
            placeholder: "optional",
            type: "password",
          },
        ].map(({ label, key, placeholder, type }) => (
          <div key={key}>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
              {label}
            </label>
            <input
              type={type}
              placeholder={placeholder}
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
