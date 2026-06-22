import { useCallback, useEffect, useState } from "react";
import {
    injectCustomThemeStyle,
    validateThemeJson,
    type ThemeDef,
} from "../themes";

const STORAGE_KEY = "atlas_custom_themes";

function loadFromStorage(): ThemeDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Re-validate each entry so a corrupted/legacy/hand-edited payload can't
    // smuggle invalid CSS or arbitrary props into the runtime.
    return parsed
      .map((t) => validateThemeJson(t))
      .filter((t): t is ThemeDef => !!t);
  } catch {
    return [];
  }
}

function writeToStorage(themes: ThemeDef[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
  } catch {
    /* quota / private mode — ignore */
  }
}

/**
 * User-imported custom themes. Persisted to `localStorage` under
 * `atlas_custom_themes`. The runtime CSS for each theme is re-injected via
 * `injectCustomThemeStyle` whenever the list changes, so newly imported
 * themes become selectable immediately without a reload.
 *
 * Validation runs on every load and on every import — a malformed entry can
 * never reach the DOM as live CSS.
 */
export function useCustomThemes() {
  const [customThemes, setCustomThemes] = useState<ThemeDef[]>(loadFromStorage);

  // Re-inject CSS whenever the custom theme list changes.
  useEffect(() => {
    injectCustomThemeStyle(customThemes);
  }, [customThemes]);

  const importTheme = useCallback(
    (
      raw: unknown,
    ): { ok: true; theme: ThemeDef } | { ok: false; error: string } => {
      const validated = validateThemeJson(raw);
      if (!validated) {
        return {
          ok: false,
          error:
            "Invalid theme JSON. Required: custom-* id, label, and vars block with valid CSS colors.",
        };
      }
      setCustomThemes((prev) => {
        const next = [...prev.filter((t) => t.id !== validated.id), validated];
        writeToStorage(next);
        return next;
      });
      return { ok: true, theme: validated };
    },
    [],
  );

  const removeTheme = useCallback((id: string) => {
    setCustomThemes((prev) => {
      const next = prev.filter((t) => t.id !== id);
      writeToStorage(next);
      return next;
    });
  }, []);

  return { customThemes, importTheme, removeTheme };
}
