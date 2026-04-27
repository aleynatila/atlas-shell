import { memo, useState } from "react";
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
  addSession: () => boolean;
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
  const [duplicateError, setDuplicateError] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto flex items-start justify-center p-8">
      <div className="w-full max-w-md">
        <div className="bg-hx-panel border border-hx-border p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div
              className="w-2 h-2 rotate-45 bg-hx-neon shrink-0"
              style={{ boxShadow: "0 0 8px var(--color-hx-neon)" }}
            />
            <h2
              className="text-sm font-black uppercase tracking-[0.25em] text-hx-neon"
              style={{
                textShadow:
                  "0 0 10px color-mix(in srgb, var(--color-hx-neon) 30%, transparent)",
              }}
            >
              New Session
            </h2>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                Session Name
                {duplicateError && (
                  <span className="ml-2 text-hx-danger normal-case tracking-normal font-normal">
                    — already exists
                  </span>
                )}
              </label>
              <input
                type="text"
                placeholder="e.g. prod-web-01"
                value={form.label}
                onChange={(e) => {
                  setDuplicateError(false);
                  setForm((f) => ({ ...f, label: e.target.value }));
                }}
                className={`hx-input w-full bg-hx-bg border-2 px-3 py-2.5 text-sm text-hx-text placeholder:text-hx-dim/50 focus:outline-none focus:border-hx-neon transition-colors ${
                  duplicateError
                    ? "border-hx-danger"
                    : "border-hx-border hover:border-hx-neon/40"
                }`}
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                Host / IP <span className="text-hx-danger">*</span>
              </label>
              <input
                type="text"
                placeholder="192.168.1.1 or hostname.com"
                value={form.host}
                onChange={(e) =>
                  setForm((f) => ({ ...f, host: e.target.value }))
                }
                className="hx-input w-full bg-hx-bg border-2 border-hx-border hover:border-hx-neon/40 focus:border-hx-neon px-3 py-2.5 text-sm text-hx-text placeholder:text-hx-dim/50 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                Port
              </label>
              <input
                type="number"
                min={1}
                max={65535}
                placeholder="22"
                value={form.port}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    port: Math.min(
                      65535,
                      Math.max(1, Number(e.target.value) || 22),
                    ),
                  }))
                }
                className="hx-input w-full bg-hx-bg border-2 border-hx-border hover:border-hx-neon/40 focus:border-hx-neon px-3 py-2.5 text-sm text-hx-text focus:outline-none transition-colors"
              />
            </div>

            {credentials.length > 0 && (
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                  Credential{" "}
                  <span className="normal-case font-normal text-hx-dim">
                    (optional)
                  </span>
                </label>
                <select
                  value={form.credentialId}
                  onChange={(e) => {
                    const cred = credentials.find(
                      (c) => c.id === e.target.value,
                    );
                    setForm((f) => ({
                      ...f,
                      credentialId: e.target.value,
                      user: cred ? cred.user : f.user,
                      pass: cred ? cred.pass || "" : f.pass,
                      keyPath: cred ? cred.keyPath || "" : f.keyPath,
                    }));
                  }}
                  className="hx-input w-full bg-hx-bg border-2 border-hx-border hover:border-hx-neon/40 focus:border-hx-neon px-3 py-2.5 text-sm text-hx-text focus:outline-none transition-colors"
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

            {!form.credentialId && (
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  placeholder="root"
                  value={form.user}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, user: e.target.value }))
                  }
                  className="hx-input w-full bg-hx-bg border-2 border-hx-border hover:border-hx-neon/40 focus:border-hx-neon px-3 py-2.5 text-sm text-hx-text placeholder:text-hx-dim/50 focus:outline-none transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                Private Key Path{" "}
                <span className="normal-case font-normal text-hx-dim">
                  (optional)
                </span>
              </label>
              <input
                type="text"
                placeholder="~/.ssh/id_rsa"
                value={form.keyPath}
                onChange={(e) =>
                  setForm((f) => ({ ...f, keyPath: e.target.value }))
                }
                className="hx-input w-full bg-hx-bg border-2 border-hx-border hover:border-hx-neon/40 focus:border-hx-neon px-3 py-2.5 text-sm text-hx-text placeholder:text-hx-dim/50 focus:outline-none transition-colors"
              />
            </div>

            {!form.credentialId && (
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-1.5">
                  Password{" "}
                  <span className="normal-case font-normal text-hx-dim">
                    (optional)
                  </span>
                </label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={form.pass}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, pass: e.target.value }))
                  }
                  className="hx-input w-full bg-hx-bg border-2 border-hx-border hover:border-hx-neon/40 focus:border-hx-neon px-3 py-2.5 text-sm text-hx-text placeholder:text-hx-dim/40 focus:outline-none transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-hx-muted mb-2">
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
                className="flex-1 py-2.5 text-[11px] font-bold uppercase tracking-widest text-hx-muted border-2 border-hx-border hover:border-hx-dim hover:text-hx-text transition-all hx-clip-btn"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const ok = addSession();
                  if (ok) {
                    closeView("new-session");
                  } else {
                    setDuplicateError(true);
                  }
                }}
                disabled={!form.host}
                className="flex-1 py-2.5 text-[11px] font-black uppercase tracking-widest hx-clip-btn transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: `linear-gradient(135deg, ${adaptColor(selectedColor, darkMode)}33, ${adaptColor(selectedColor, darkMode)}11)`,
                  border: `2px solid ${adaptColor(selectedColor, darkMode)}88`,
                  color: adaptColor(selectedColor, darkMode),
                  boxShadow: form.host
                    ? `0 0 16px ${adaptColor(selectedColor, darkMode)}25`
                    : "none",
                }}
              >
                ◆ Create Session
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
