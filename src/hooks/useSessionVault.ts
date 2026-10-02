import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { planKeychainWrite } from "../lib/keychainSync";
import type { Credential, SessionEntry } from "../types";

/**
 * Owns the persisted session + credential store.
 *
 * Storage strategy (priority order):
 *   1. Tauri file store  → {AppData}/atlas/store/{key}
 *      Written via the Rust `write_store` command.  Survives WebView2 profile
 *      wipes and works identically in dev (http://localhost:5173) and
 *      production (tauri://localhost) because it bypasses browser-origin
 *      namespacing entirely.
 *   2. localStorage fallback (migration source)
 *      On first load, if the file store is empty we migrate from localStorage
 *      and then write through to the file store so subsequent loads are fast.
 *
 * Passwords are never written to disk — they live in the OS keychain only.
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
  // Last password written to (or read from) the OS keychain per entry id, so saves
  // only touch entries whose password actually changed. Each keychain call is a
  // Windows Credential Manager round trip.
  const keychainPassRef = useRef<Map<string, string | undefined>>(new Map());

  // ── Startup: file-store load + keychain migration ──
  useEffect(() => {
    (async () => {
      // ── Credentials ──
      let baseCreds = credentials;
      try {
        const stored = await invoke<string | null>("read_store", {
          key: "atlas_credentials",
        });
        if (stored) {
          baseCreds = JSON.parse(stored) as Credential[];
        } else if (credentials.length > 0) {
          // Migrate localStorage → file store on first run
          await invoke("write_store", {
            key: "atlas_credentials",
            value: JSON.stringify(credentials.map(({ pass: _p, ...r }) => r)),
          }).catch(() => {});
        }
      } catch {}

      const enrichedCreds = await Promise.all(
        baseCreds.map(async (c) => {
          if (c.pass) {
            await invoke("set_credential", {
              id: "cred_" + c.id,
              password: c.pass,
            }).catch(() => {});
          }
          const pw = await invoke<string | null>("get_credential", {
            id: "cred_" + c.id,
          }).catch(() => null);
          return { ...c, pass: pw ?? c.pass };
        }),
      );
      setCredentials(enrichedCreds);
      enrichedCreds.forEach((c) =>
        keychainPassRef.current.set("cred_" + c.id, c.pass),
      );
      const credsNoPass = enrichedCreds.map(({ pass: _p, ...r }) => r);
      await invoke("write_store", {
        key: "atlas_credentials",
        value: JSON.stringify(credsNoPass),
      }).catch(() => {});
      try {
        localStorage.setItem("atlas_credentials", JSON.stringify(credsNoPass));
      } catch {}

      // ── Sessions ──
      let baseSessions = sessions;
      try {
        const stored = await invoke<string | null>("read_store", {
          key: "atlas_sessions",
        });
        if (stored) {
          baseSessions = JSON.parse(stored) as SessionEntry[];
        } else if (sessions.length > 0) {
          // Migrate localStorage → file store on first run
          await invoke("write_store", {
            key: "atlas_sessions",
            value: JSON.stringify(sessions.map(({ pass: _p, ...r }) => r)),
          }).catch(() => {});
        }
      } catch {}

      const enrichedSessions = await Promise.all(
        baseSessions.map(async (s) => {
          if (!s.credentialId) {
            if (s.pass) {
              await invoke("set_credential", {
                id: "sess_" + s.id,
                password: s.pass,
              }).catch(() => {});
            }
            const pw = await invoke<string | null>("get_credential", {
              id: "sess_" + s.id,
            }).catch(() => null);
            return { ...s, pass: pw ?? s.pass };
          }
          const cred = enrichedCreds.find((c) => c.id === s.credentialId);
          return { ...s, pass: cred?.pass };
        }),
      );
      setSessions(enrichedSessions);
      enrichedSessions.forEach((s) => {
        if (!s.credentialId) keychainPassRef.current.set("sess_" + s.id, s.pass);
      });
      const sessNoPass = enrichedSessions.map(({ pass: _p, ...r }) => r);
      await invoke("write_store", {
        key: "atlas_sessions",
        value: JSON.stringify(sessNoPass),
      }).catch(() => {});
      try {
        localStorage.setItem("atlas_sessions", JSON.stringify(sessNoPass));
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only touch keychain entries whose password changed (see planKeychainWrite).
  const syncKeychain = useCallback((id: string, pass: string | undefined) => {
    const action = planKeychainWrite(keychainPassRef.current, id, pass);
    if (action === "set") {
      invoke("set_credential", { id, password: pass }).catch(() => {});
    } else if (action === "delete") {
      invoke("delete_credential", { id }).catch(() => {});
    }
  }, []);

  const saveSessions = useCallback((list: SessionEntry[]) => {
    setSessions(list);
    // Cancel any pending debounced save before writing immediately
    if (saveSessionsTimerRef.current) {
      clearTimeout(saveSessionsTimerRef.current);
      saveSessionsTimerRef.current = null;
    }
    const noPass = list.map(({ pass: _p, ...rest }) => rest);
    const json = JSON.stringify(noPass);
    try {
      localStorage.setItem("atlas_sessions", json);
    } catch {}
    invoke("write_store", { key: "atlas_sessions", value: json }).catch(() => {});
    list.forEach((s) => {
      if (!s.credentialId) syncKeychain("sess_" + s.id, s.pass);
    });
  }, [syncKeychain]);

  const saveCredentials = useCallback((list: Credential[]) => {
    setCredentials(list);
    if (saveCredsTimerRef.current) clearTimeout(saveCredsTimerRef.current);
    saveCredsTimerRef.current = setTimeout(() => {
      const noPass = list.map(({ pass: _p, ...rest }) => rest);
      const json = JSON.stringify(noPass);
      try {
        localStorage.setItem("atlas_credentials", json);
      } catch {}
      invoke("write_store", { key: "atlas_credentials", value: json }).catch(
        () => {},
      );
      list.forEach((c) => syncKeychain("cred_" + c.id, c.pass));
    }, 400);
  }, [syncKeychain]);

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
