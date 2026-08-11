// ── Shared Types & Constants ──────────────────────────────────────────────────

export interface Credential {
  id: string;
  label: string;
  user: string;
  pass?: string;
  keyPath?: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Script {
  id: string;
  name: string;
  content: string;
  group?: string;
}

export interface GeneralSettings {
  logPath: string;
  fontSize: number;
  fontFamily: string;
  /** Legacy field kept for import compatibility */
  darkMode?: boolean;
  theme: string;
  autoCheckUpdates?: boolean;
  updatePermissionAsked?: boolean;
  disableAlternateScreen?: boolean;
  /** Speculative client-side local echo for high-latency SSH sessions */
  predictiveEcho?: "off" | "auto" | "always";
  predictiveEchoThresholdMs?: number;
}

export interface SshOutputPayload {
  session: string;
  output: string;
}

export interface SCPProgressPayload {
  id: string;
  bytes_sent: number;
  total: number;
  done: boolean;
  error?: string;
  remote_path?: string;
  protocol?: string;
}

export interface DragDropPayload {
  paths?: string[];
  position?: { x: number; y: number };
}

export interface DragOverPayload {
  position?: { x: number; y: number };
}

export interface SessionEntry {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  pass?: string;
  keyPath?: string;
  group?: string;
  color?: string;
  credentialId?: string;
}

export interface TabPane {
  tabId: string;
  sessionEntry: SessionEntry;
  sshSessionId: string | null;
  connected: boolean;
}

export const COLOR_PAIRS = [
  { dark: "#00E5FF", light: "#0077cc" },
  { dark: "#BD00FF", light: "#7c3aed" },
  { dark: "#00FF88", light: "#00875a" },
  { dark: "#FFD700", light: "#b8860b" },
  { dark: "#FF3860", light: "#cc2244" },
];

export const NEON_COLORS = COLOR_PAIRS.map((p) => p.dark);

export function adaptColor(color: string, isDark: boolean): string {
  if (isDark) return color;
  const pair = COLOR_PAIRS.find(
    (p) =>
      p.dark.toLowerCase() === color.toLowerCase() ||
      p.light.toLowerCase() === color.toLowerCase(),
  );
  return pair ? pair.light : color;
}

export type TransferMap = Record<
  string,
  {
    name: string;
    progress: number;
    done: boolean;
    error?: string;
    remotePath?: string;
    remoteDir?: string;
    protocol?: string;
  }
>;
