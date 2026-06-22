import { useCallback, useState } from "react";
import type { GeneralSettings, Script, Tag } from "../types";
import { usePersistedState } from "./usePersistedState";

const DEFAULT_GENERAL: GeneralSettings = {
  logPath: "",
  fontSize: 15,
  fontFamily: "'Cascadia Mono', Consolas, monospace",
  theme: "light",
  autoCheckUpdates: false,
  updatePermissionAsked: false,
  disableAlternateScreen: false,
};

export function useTags() {
  const [tags, , saveTagsRaw] = usePersistedState<Tag[]>("atlas_tags", []);
  const saveTags = useCallback(
    (list: Tag[]) => saveTagsRaw(list),
    [saveTagsRaw],
  );
  return { tags, saveTags };
}

export function useScripts() {
  const [scripts, , saveScriptsRaw] = usePersistedState<Script[]>(
    "atlas_scripts",
    [],
  );
  const saveScripts = useCallback(
    (list: Script[]) => saveScriptsRaw(list),
    [saveScriptsRaw],
  );
  return { scripts, saveScripts };
}

export function useGeneralSettings() {
  // Manage state directly here because we need to derive `theme` from a
  // legacy `darkMode` field on first load, which `usePersistedState`'s
  // generic JSON.parse path cannot do.
  const [generalSettings, setGeneralSettings] = useState<GeneralSettings>(
    () => {
      try {
        const raw = localStorage.getItem("atlas_general");
        if (!raw) return DEFAULT_GENERAL;
        const parsed = JSON.parse(raw) as Partial<GeneralSettings> & {
          darkMode?: boolean;
        };
        if (!parsed.theme) {
          parsed.theme = parsed.darkMode ? "dark" : "light";
        }
        return { ...DEFAULT_GENERAL, ...parsed } as GeneralSettings;
      } catch {
        return DEFAULT_GENERAL;
      }
    },
  );
  const saveGeneral = useCallback((s: GeneralSettings) => {
    setGeneralSettings(s);
    try {
      localStorage.setItem("atlas_general", JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, []);
  return { generalSettings, saveGeneral };
}
