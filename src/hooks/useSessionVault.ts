import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Credential, SessionEntry } from "../types";

/**
 * Owns the persisted session + credential store. Responsibilities:
 *
 * - Lazy-hydrate from `localStorage` on first render.
 * - On mount, migrate any inline passwords into the OS keychain via the Rust
 *   `set_credential` / `get_credential` commands, and rewrite localStorage
 *   with the password fields stripped so secrets never live there at rest.
 * - Provide debounced `saveSessions` / `saveCredentials` writers that mirror
 *   updates to both localStorage (without passwords) and the keychain.
 *
 * State setters are exposed for the few places that need them (e.g. CRUD that
 * also clears keychain entries on delete).
 */
export function useSessionVault() {
  const [sessions, setSessions] = useState<SessionEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_sessions") || "[]");
    } catch {
      return [];
    }
  });
  const [credentials, setCredentials] = useState<Credential[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_credentials") || "[]");
    } catch {
      return [];
    }
  });

  const saveSessionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const saveCredsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Keychain migration + load (runs once on mount) ──
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

  useEffect(
    () => () => {
      if (saveSessionsTimerRef.current)
        clearTimeout(saveSessionsTimerRef.current);
      if (saveCredsTimerRef.current) clearTimeout(saveCredsTimerRef.current);
    },
    [],
  );

  return {
    sessions,
    setSessions,
    saveSessions,
    credentials,
    setCredentials,
    saveCredentials,
  };
}
