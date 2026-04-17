/**
 * Atlas Theme Definitions
 * Each theme maps directly to CSS custom-property values applied on <html>.
 * The "light" theme is the default (no class applied).
 * All others apply a `.theme-<id>` class on <html>.
 */

export interface ThemeDef {
  id: string;
  label: string;
  /** Short description shown under the card */
  description: string;
  /** Whether colour-sensitive UI (adaptColor) should use dark-variant accents */
  isDark: boolean;
  vars: {
    "--color-hx-bg": string;
    "--color-hx-panel": string;
    "--color-hx-border": string;
    "--color-hx-neon": string;
    "--color-hx-neon-hover": string;
    "--color-hx-purple": string;
    "--color-hx-text": string;
    "--color-hx-muted": string;
    "--color-hx-dim": string;
    "--color-hx-success": string;
    "--color-hx-warning": string;
    "--color-hx-danger": string;
  };
}

export const THEMES: ThemeDef[] = [
  {
    id: "light",
    label: "Light",
    description: "Clean white interface",
    isDark: false,
    vars: {
      "--color-hx-bg": "#f5f7fa",
      "--color-hx-panel": "#ffffff",
      "--color-hx-border": "#d0d9e8",
      "--color-hx-neon": "#0077cc",
      "--color-hx-neon-hover": "#005fa3",
      "--color-hx-purple": "#7c3aed",
      "--color-hx-text": "#1a2540",
      "--color-hx-muted": "#3d4f6e",
      "--color-hx-dim": "#5a6e8e",
      "--color-hx-success": "#00875a",
      "--color-hx-warning": "#b8860b",
      "--color-hx-danger": "#cc2244",
    },
  },
  {
    id: "dark",
    label: "Dark",
    description: "Deep navy dark mode",
    isDark: true,
    vars: {
      "--color-hx-bg": "#080a12",
      "--color-hx-panel": "#0d1121",
      "--color-hx-border": "#1e2d4a",
      "--color-hx-neon": "#29b6d4",
      "--color-hx-neon-hover": "#4ecde6",
      "--color-hx-purple": "#9b55cc",
      "--color-hx-text": "#d0dff0",
      "--color-hx-muted": "#7890aa",
      "--color-hx-dim": "#4a6080",
      "--color-hx-success": "#22c97a",
      "--color-hx-warning": "#d4aa00",
      "--color-hx-danger": "#e03055",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep purple void",
    isDark: true,
    vars: {
      "--color-hx-bg": "#0d0a1a",
      "--color-hx-panel": "#130f24",
      "--color-hx-border": "#2a2050",
      "--color-hx-neon": "#a855f7",
      "--color-hx-neon-hover": "#bf7aff",
      "--color-hx-purple": "#e040fb",
      "--color-hx-text": "#e0d8f8",
      "--color-hx-muted": "#9480c8",
      "--color-hx-dim": "#5a4d88",
      "--color-hx-success": "#34d399",
      "--color-hx-warning": "#fbbf24",
      "--color-hx-danger": "#f87171",
    },
  },
  {
    id: "forest",
    label: "Forest",
    description: "Calm deep green",
    isDark: true,
    vars: {
      "--color-hx-bg": "#080f0a",
      "--color-hx-panel": "#0d1810",
      "--color-hx-border": "#1a3020",
      "--color-hx-neon": "#22c97a",
      "--color-hx-neon-hover": "#4adda0",
      "--color-hx-purple": "#6ee7b7",
      "--color-hx-text": "#d0f0dc",
      "--color-hx-muted": "#6aaa88",
      "--color-hx-dim": "#3a6a50",
      "--color-hx-success": "#22c97a",
      "--color-hx-warning": "#d4aa00",
      "--color-hx-danger": "#e05555",
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Warm amber darkness",
    isDark: true,
    vars: {
      "--color-hx-bg": "#120a06",
      "--color-hx-panel": "#1e1008",
      "--color-hx-border": "#3a2215",
      "--color-hx-neon": "#f97316",
      "--color-hx-neon-hover": "#fb923c",
      "--color-hx-purple": "#e879f9",
      "--color-hx-text": "#f0dcc8",
      "--color-hx-muted": "#c08060",
      "--color-hx-dim": "#7a4a30",
      "--color-hx-success": "#4ade80",
      "--color-hx-warning": "#fbbf24",
      "--color-hx-danger": "#f87171",
    },
  },
];

export function getTheme(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
