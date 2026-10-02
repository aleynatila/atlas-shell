import { X } from "lucide-react";
import { memo } from "react";
import { adaptColor, COLOR_PAIRS, type Credential, type SessionEntry } from "../types";

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
