import { memo } from "react";
import { adaptColor, COLOR_PAIRS, type Credential } from "../types";

interface NewSessionProps {
  form: {
    label: string;
    host: string;
    port: number;
    user: string;
    pass: string;
    keyPath: string;
    group: string;
    credentialId: string;
  };
  setForm: React.Dispatch<
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
  selectedColor: string;
  setSelectedColor: (c: string) => void;
  credentials: Credential[];
  darkMode: boolean;
  addSession: () => void;
  closeView: (kind: "overview" | "settings" | "new-session") => void;
}

export const NewSession = memo(function NewSession({
  form,
  setForm,
  selectedColor,
  setSelectedColor,
  credentials,
  darkMode,
  addSession,
  closeView,
}: NewSessionProps) {
  return (
    <div className="flex-1 overflow-y-auto flex items-start justify-center p-8">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-2 h-2 rotate-45 bg-hx-neon"
            style={{ boxShadow: "0 0 8px #00E5FF" }}
          />
          <h2
            className="text-xs font-black uppercase tracking-[0.25em] text-hx-neon"
            style={{ textShadow: "0 0 10px #00E5FF55" }}
          >
            New Session
          </h2>
        </div>
        <div className="space-y-3">
          {credentials.length > 0 && (
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                Credential (optional)
              </label>
              <select
                value={form.credentialId}
                onChange={(e) => {
                  const cred = credentials.find((c) => c.id === e.target.value);
                  setForm((f) => ({
                    ...f,
                    credentialId: e.target.value,
                    user: cred ? cred.user : f.user,
                    pass: cred ? cred.pass || "" : f.pass,
                    keyPath: cred ? cred.keyPath || "" : f.keyPath,
                  }));
                }}
                className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
              >
                <option value="">— none (enter manually below) —</option>
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
              label: "Group (optional)",
              key: "group" as const,
              placeholder: "production",
              type: "text",
            },
            {
              label: "Private Key Path (optional)",
              key: "keyPath" as const,
              placeholder: "/home/user/.ssh/id_rsa",
              type: "text",
            },
            {
              label: "Password (optional)",
              key: "pass" as const,
              placeholder: "Leave blank to enter later",
              type: "password",
            },
          ].map(({ label, key, placeholder, type }) => (
            <div key={key}>
              <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                {label}
              </label>
              <input
                type={type}
                placeholder={placeholder}
                value={String(form[key])}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [key]: e.target.value }))
                }
                className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs"
              />
            </div>
          ))}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-2">
              Accent Color
            </label>
            <div className="flex items-center gap-3">
              {COLOR_PAIRS.map(({ dark: canonical, light: lightC }) => {
                const c = darkMode ? canonical : lightC;
                const isSelected = selectedColor === canonical;
                return (
                  <button
                    key={canonical}
                    onClick={() => setSelectedColor(canonical)}
                    className="w-6 h-6 rotate-45 transition-all hover:scale-110"
                    style={{
                      background: c,
                      boxShadow: isSelected ? `0 0 14px ${c}` : "none",
                      outline: isSelected
                        ? `2px solid ${c}`
                        : "2px solid transparent",
                      outlineOffset: "3px",
                    }}
                  />
                );
              })}
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => closeView("new-session")}
              className="flex-1 py-2.5 text-[11px] font-bold uppercase tracking-widest text-hx-muted border border-hx-border hover:border-hx-dim hover:text-hx-text transition-all hx-clip-btn"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                addSession();
                closeView("new-session");
              }}
              disabled={!form.host}
              className="flex-1 py-2.5 text-[11px] font-black uppercase tracking-widest hx-clip-btn transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: `linear-gradient(135deg, ${adaptColor(selectedColor, darkMode)}22, ${adaptColor(selectedColor, darkMode)}0a)`,
                border: `1px solid ${adaptColor(selectedColor, darkMode)}66`,
                color: adaptColor(selectedColor, darkMode),
                boxShadow: `0 0 16px ${adaptColor(selectedColor, darkMode)}18`,
              }}
            >
              ◆ Create Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
