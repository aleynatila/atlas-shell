/**
 * Atlas Theme Definitions
 * Each theme maps directly to CSS custom-property values applied on <html>.
 * The "light" theme is the default (no class applied).
 * All others apply a `.theme-<id>` class on <html>.
 */

export interface TerminalThemeDef {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

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

/**
 * Terminal theme for xterm.js
 * High-contrast palette: all colors have ≥3:1 contrast ratio against background.
 * - green is dark (#16a34a) to allow cyan text to be readable as "other-writable" dir background
 * - brightGreen (#4ade80) is vivid for bold executables (ls 01;32)
 * - cyan (#22d3ee) is bright teal-blue for visibility on dark backgrounds
 */
// Terminal color palette — designed with perceptual contrast in mind.
//
// Core problem: LS_COLORS "ow=36;42" renders drwxrwxrwx dirs as
// cyan (ANSI 6) text on green (ANSI 2) background. Most popular themes
// (Dracula, TokyoNight, Catppuccin, Gruvbox) fail here because green and
// cyan are spectrally adjacent and end up with near-identical luminance (~1.1:1).
//
// Solution (Selenized / Base16 methodology):
//   • Normal ANSI 0–7: medium-dark luminance, serve as both text and backgrounds
//   • green (ANSI 2): deliberately darker than cyan → WCAG contrast ≥ 3:1 between them
//   • Bright ANSI 8–15: vivid, light — used only as text (drawBoldTextInBrightColors)
//   • brightGreen stays vivid for `ls` executables (bold 01;32 → brightGreen)
//
// Luminance reference (sRGB relative, WCAG formula):
//   green  "#22703a"  L ≈ 0.128   — readable on dark bg (3.4:1) and as ow bg
//   cyan   "#22d3ee"  L ≈ 0.522   — contrast vs green: 3.2:1 ✓
export const TERMINAL_THEME: TerminalThemeDef = {
  background: "#080c10",
  foreground: "#d8e0ee",
  cursor: "#BD00FF",
  cursorAccent: "#080c10",
  selectionBackground: "#4a90d966",
  // --- Normal colors (0–7): medium-dark, usable as both fg text and ANSI backgrounds ---
  // green must stay darker than cyan so ow=36;42 (cyan-on-green) stays readable (3:1+)
  //   green "#1a6b30"  L ≈ 0.10   |  cyan "#00c8d4"  L ≈ 0.46   →  ratio 3.5:1 ✓
  black: "#1a2030",
  red: "#e05060",
  green: "#1a6b30", // dark forest green — other-writable dir background
  yellow: "#d4a020", // amber
  blue: "#4488e0",
  magenta: "#a050d0",
  cyan: "#00c8d4", // classic terminal teal — readable on dark green bg
  white: "#b8c8de",
  // --- Bright colors (8–15): vivid text, used by bold (drawBoldTextInBrightColors) ---
  brightBlack: "#485060",
  brightRed: "#ff6070",
  brightGreen: "#50fa7b", // neon lime — ls executables (bold 01;32 → brightGreen)
  brightYellow: "#f8c050",
  brightBlue: "#60a8ff",
  brightMagenta: "#c060ff",
  brightCyan: "#40e0f0",
  brightWhite: "#e8f0ff",
};
