import {
  readText as clipboardRead,
  writeText as clipboardWrite,
} from "@tauri-apps/api/clipboard";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/api/shell";
import { invoke } from "@tauri-apps/api/tauri";
import { appWindow, WebviewWindow } from "@tauri-apps/api/window";
import {
  Columns2,
  Download,
  Edit2,
  ExternalLink,
  FolderOpen,
  Info,
  Key,
  Minus,
  MoreVertical,
  Play,
  Plus,
  RefreshCw,
  Rows2,
  Server,
  Settings,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import "./index.css";
import { getTheme, THEMES } from "./themes";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Credential {
  id: string;
  label: string;
  user: string;
  pass?: string;
  keyPath?: string;
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface Script {
  id: string;
  name: string;
  content: string;
}

interface GeneralSettings {
  logPath: string;
  fontSize: number;
  fontFamily: string;
  /** Legacy field kept for import compatibility */
  darkMode?: boolean;
  theme: string;
}

interface SshOutputPayload {
  session: string;
  output: string;
}

interface SessionEntry {
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

interface TabPane {
  tabId: string;
  sessionEntry: SessionEntry;
  sshSessionId: string | null;
  connected: boolean;
}

const COLOR_PAIRS = [
  { dark: "#00E5FF", light: "#0077cc" },
  { dark: "#BD00FF", light: "#7c3aed" },
  { dark: "#00FF88", light: "#00875a" },
  { dark: "#FFD700", light: "#b8860b" },
  { dark: "#FF3860", light: "#cc2244" },
];

const NEON_COLORS = COLOR_PAIRS.map((p) => p.dark);

function adaptColor(color: string, isDark: boolean): string {
  if (isDark) return color;
  const pair = COLOR_PAIRS.find(
    (p) =>
      p.dark.toLowerCase() === color.toLowerCase() ||
      p.light.toLowerCase() === color.toLowerCase(),
  );
  return pair ? pair.light : color;
}

// ── TerminalPane ──────────────────────────────────────────────────────────────

interface TerminalPaneProps {
  pane: TabPane;
  password: string;
  onConnected: (tabId: string, sshId: string) => void;
  onDisconnected: (tabId: string) => void;
  visible: boolean;
  paneRef?: (el: HTMLDivElement | null) => void;
  autoConnect?: boolean;
  onCwdChange?: (cwd: string) => void;
}

const TerminalPane = memo(function TerminalPane({
  pane,
  password,
  onConnected,
  onDisconnected,
  visible,
  paneRef,
  autoConnect,
  onCwdChange,
}: TerminalPaneProps) {
  const promptRef = useRef<{
    stage: "user" | "pass";
    user: string;
    pass: string;
  } | null>(null);
  const connectCredsRef = useRef<
    ((user?: string, pass?: string) => void) | null
  >(null);
  const wrapperRef = useRef<HTMLDivElement>(null); // outer div: resize-observed, paneRef target
  const containerRef = useRef<HTMLDivElement>(null); // inner div: xterm mounts here
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const sshIdRef = useRef<string | null>(pane.sshSessionId);

  const [dragOver, setDragOver] = useState(false);
  const [sftpFiles, setSftpFiles] = useState<string[]>([]);
  const [sftpRemoteDir, setSftpRemoteDir] = useState("~");
  const [sftpTransfers, setSftpTransfers] = useState<
    Record<
      string,
      {
        name: string;
        progress: number;
        done: boolean;
        error?: string;
        remotePath?: string;
      }
    >
  >({});
  const [currentCwd, setCurrentCwd] = useState("~");
  const currentCwdRef = useRef("~");
  const pwdResponseRef = useRef<string>("");
  const waitingForPwdRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    currentCwdRef.current = currentCwd;
  }, [currentCwd]);

  // Listen to Tauri file-drop events only when this pane is visible
  useEffect(() => {
    if (!visible) return;
    let unlistenDrop: UnlistenFn | null = null;
    let unlistenHover: UnlistenFn | null = null;
    let unlistenCancel: UnlistenFn | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("tauri://file-drop", (e) => {
        setDragOver(false);
        const paths = e.payload as string[];
        if (paths && paths.length > 0) {
          const sid = sshIdRef.current;
          if (sid) {
            // Query pwd when files are dropped to get current directory
            waitingForPwdRef.current = true;
            pwdResponseRef.current = "";
            invoke("send_ssh_input", { sessionId: sid, input: "pwd\n" });
            // Wait 500ms for pwd response, then show dialog
            setTimeout(() => {
              setSftpRemoteDir(currentCwdRef.current || "~");
              setSftpFiles(paths);
              waitingForPwdRef.current = false;
            }, 500);
          } else {
            setSftpRemoteDir("~");
            setSftpFiles(paths);
          }
        }
      }).then((u) => {
        unlistenDrop = u;
      });
      listen("tauri://file-drop-hover", () => {
        // suppress SFTP overlay when a tab drag is in progress
        if ((window as any).__tabDragging) return;
        setDragOver(true);
      }).then((u) => {
        unlistenHover = u;
      });
      listen("tauri://file-drop-cancelled", () => setDragOver(false)).then(
        (u) => {
          unlistenCancel = u;
        },
      );
    });
    return () => {
      unlistenDrop?.();
      unlistenHover?.();
      unlistenCancel?.();
    };
  }, [visible]);

  // Listen to sftp-progress events
  useEffect(() => {
    if (!visible) return;
    let unlisten: UnlistenFn | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("sftp-progress", (e) => {
        const p = e.payload as {
          id: string;
          bytes_sent: number;
          total: number;
          done: boolean;
          error?: string;
          remote_path?: string;
        };
        setSftpTransfers((prev) => ({
          ...prev,
          [p.id]: {
            ...(prev[p.id] || { name: p.id }),
            progress:
              p.total > 0 ? Math.round((p.bytes_sent / p.total) * 100) : 0,
            done: p.done,
            error: p.error,
            ...(p.remote_path
              ? {
                  remotePath: p.remote_path,
                  remoteDir: p.remote_path.substring(
                    0,
                    p.remote_path.lastIndexOf("/"),
                  ),
                }
              : {}),
          },
        }));
      }).then((u) => {
        unlisten = u;
      });
    });
    return () => {
      unlisten?.();
    };
  }, [visible]);

  function startSftpUpload() {
    const transfers: typeof sftpTransfers = {};
    sftpFiles.forEach((fp) => {
      const id = crypto.randomUUID();
      const name = fp.split(/[\\/]/).pop() || fp;
      transfers[id] = { name, progress: 0, done: false };
      invoke("upload_file_sftp", {
        transferId: id,
        host: pane.sessionEntry.host,
        port: pane.sessionEntry.port,
        user: pane.sessionEntry.user,
        pass: pane.sessionEntry.pass || password || "",
        keyPath: pane.sessionEntry.keyPath || null,
        localPath: fp,
        remoteDir: sftpRemoteDir,
      }).catch((err) => {
        setSftpTransfers((prev) => ({
          ...prev,
          [id]: { ...prev[id], done: true, error: String(err) },
        }));
      });
    });
    setSftpTransfers((prev) => ({ ...prev, ...transfers }));
    setSftpFiles([]);
  }

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#000000",
        foreground: "#afb4b7",
        cursor: "#BD00FF",
        cursorAccent: "#000000",
        selectionBackground: "#00E5FF33",
        black: "#000000",
        red: "#FF3860",
        green: "#00FF88",
        yellow: "#FFD700",
        blue: "#00E5FF",
        magenta: "#BD00FF",
        cyan: "#00FFC8",
        white: "#C8D6E5",
        brightBlack: "#2A3550",
        brightRed: "#FF6080",
        brightGreen: "#40FFA0",
        brightYellow: "#FFE040",
        brightBlue: "#40EFFF",
        brightMagenta: "#D040FF",
        brightCyan: "#40FFD8",
        brightWhite: "#E8F0F8",
      },
      fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 15,
      lineHeight: 1.4,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    // Use a longer delay on initial mount so split pane containers have time to settle
    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch (_) {}
      term.focus();
    }, 150);
    term.write("\x1b[36m\x1b[2m╔══════════════════════════╗\x1b[0m\r\n");
    term.write("\x1b[36m\x1b[2m║  ATLAS TERMINAL  v1.0    ║\x1b[0m\r\n");
    term.write("\x1b[36m\x1b[2m╚══════════════════════════╝\x1b[0m\r\n\r\n");
    term.write(
      `\x1b[35m◆ Target:\x1b[0m \x1b[36m${pane.sessionEntry.user}@${pane.sessionEntry.host}:${pane.sessionEntry.port}\x1b[0m\r\n`,
    );
    const needsPrompt =
      !pane.sessionEntry.pass && !pane.sessionEntry.keyPath && !password;
    if (needsPrompt) {
      term.write(`\r\nlogin as: `);
      promptRef.current = { stage: "user", user: "", pass: "" };
    }
    termRef.current = term;
    fitRef.current = fitAddon;

    // Copy/Paste handling
    const showCopiedMessage = () => {
      const msg = "\x1b[2m[copied]\x1b[0m ";
      const visibleLen = "[copied] ".length; // 9 visible chars, not raw string length
      term.write(msg);
      setTimeout(() => {
        // Erase only the visible characters
        for (let i = 0; i < visibleLen; i++) {
          term.write("\b \b");
        }
      }, 1500);
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      clipboardRead()
        .then((text) => {
          if (!text) return;
          const sid = sshIdRef.current;
          if (sid) {
            invoke("send_ssh_input", { sessionId: sid, input: text }).catch(
              () => {},
            );
          } else if (promptRef.current) {
            const pr = promptRef.current;
            if (pr.stage === "user") {
              pr.user += text;
              term.write(text);
            } else {
              pr.pass += text;
            }
          }
        })
        .catch(() => {
          // fallback to navigator.clipboard
          navigator.clipboard
            ?.readText()
            .then((text) => {
              if (!text) return;
              const sid = sshIdRef.current;
              if (sid)
                invoke("send_ssh_input", { sessionId: sid, input: text }).catch(
                  () => {},
                );
            })
            .catch(() => {});
        });
    };
    containerRef.current?.addEventListener("contextmenu", handleContextMenu);

    // Auto-copy on selection (PuTTY-style)
    const onSelection = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel) return;
      clipboardWrite(sel).catch(() => {
        navigator.clipboard?.writeText(sel).catch(() => {});
      });
    });

    const onData = term.onData((data: string) => {
      // Ctrl+C: if selection exists copy it, otherwise send interrupt to SSH
      if (data === "\x03") {
        const sel = term.getSelection();
        if (sel) {
          clipboardWrite(sel)
            .then(() => {
              showCopiedMessage();
            })
            .catch(() => {
              navigator.clipboard
                ?.writeText(sel)
                .then(() => {
                  showCopiedMessage();
                })
                .catch(() => {});
            });
          term.clearSelection();
          return;
        }
        // No selection → send Ctrl+C to SSH (interrupt command)
      }
      const pr = promptRef.current;
      if (pr !== null) {
        if (data === "\r" || data === "\n") {
          if (pr.stage === "user") {
            const finalUser = pr.user || pane.sessionEntry.user;
            term.write(
              `\r\n${finalUser}@${pane.sessionEntry.host}'s password: `,
            );
            pr.stage = "pass";
            pr.user = finalUser;
          } else {
            term.write("\r\n");
            const captUser = pr.user;
            const captPass = pr.pass;
            promptRef.current = null;
            connectCredsRef.current?.(captUser, captPass);
          }
        } else if (data === "\x7f" || data === "\b") {
          if (pr.stage === "user" && pr.user.length > 0) {
            pr.user = pr.user.slice(0, -1);
            term.write("\b \b");
          } else if (pr.stage === "pass" && pr.pass.length > 0) {
            pr.pass = pr.pass.slice(0, -1);
          }
        } else {
          if (pr.stage === "user") {
            pr.user += data;
            term.write(data);
          } else {
            pr.pass += data;
          }
        }
        return;
      }
      const sid = sshIdRef.current;
      if (!sid) return;
      invoke("send_ssh_input", { sessionId: sid, input: data }).catch(() => {});
    });
    const handleResize = () => {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch (_) {}
        const sid = sshIdRef.current;
        if (!sid) return;
        invoke("resize_pty", {
          sessionId: sid,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      });
    };
    // Ctrl+V / system paste support
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      e.preventDefault();
      const sid = sshIdRef.current;
      if (sid) {
        invoke("send_ssh_input", { sessionId: sid, input: text }).catch(
          () => {},
        );
      } else if (promptRef.current) {
        const pr = promptRef.current;
        if (pr.stage === "user") {
          pr.user += text;
          term.write(text);
        } else {
          pr.pass += text;
        }
      }
    };
    containerRef.current?.addEventListener("paste", handlePaste);
    window.addEventListener("resize", handleResize);

    // ResizeObserver watches containerRef (the exact div xterm measures during fit())
    // so any layout shift (split open/close, CMD bar appear/disappear) triggers refit
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      onData.dispose();
      onSelection.dispose();
      resizeObserver.disconnect();
      if (unlistenRef.current) unlistenRef.current();
      const sid = sshIdRef.current;
      if (sid) invoke("stop_ssh_session", { sessionId: sid }).catch(() => {});
      containerRef.current?.removeEventListener("paste", handlePaste);
      window.removeEventListener("resize", handleResize);
      containerRef.current?.removeEventListener(
        "contextmenu",
        handleContextMenu,
      );
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) {
      // Double RAF: first frame lets DOM settle, second lets xterm measure correctly
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            fitRef.current?.fit();
          } catch (_) {}
          termRef.current?.focus();
        });
      });
    }
  }, [visible]);

  const connect = useCallback(
    (overrideUser?: string, overridePass?: string) => {
      const term = termRef.current;
      if (!term) return;
      if (sshIdRef.current) {
        invoke("stop_ssh_session", { sessionId: sshIdRef.current }).catch(
          () => {},
        );
        if (unlistenRef.current) unlistenRef.current();
        sshIdRef.current = null;
      }
      // Reset CWD on new connection
      setCurrentCwd("~");
      try {
        fitRef.current?.fit();
      } catch (_) {}
      term.clear();
      const connectUser = overrideUser || pane.sessionEntry.user;
      const connectPass =
        overridePass || pane.sessionEntry.pass || password || "";
      term.write(
        `\x1b[36m◆ Baglaniliyor: ${connectUser}@${pane.sessionEntry.host}:${pane.sessionEntry.port}...\x1b[0m\r\n`,
      );
      invoke("start_ssh_session", {
        host: pane.sessionEntry.host,
        port: pane.sessionEntry.port,
        user: connectUser,
        pass: connectPass,
        cols: term.cols,
        rows: term.rows,
        keyPath: pane.sessionEntry.keyPath || null,
        keyPassphrase: null,
      })
        .then((id: unknown) => {
          const sshId = id as string;
          sshIdRef.current = sshId;
          onConnected(pane.tabId, sshId);
          listen("ssh-output", (event) => {
            const payload = event.payload as SshOutputPayload;
            if (payload.session === sshId) {
              // If waiting for pwd response, don't display to terminal yet
              if (waitingForPwdRef.current) {
                pwdResponseRef.current += payload.output;
                // Look for complete lines (paths, not shell prompts)
                const lines = pwdResponseRef.current.split(/[\r\n]+/);
                for (const line of lines) {
                  const trimmed = line.trim();
                  // Filter out shell prompts and commands, find actual path responses
                  // Valid pwd output: /path or ~/path
                  // Invalid: shell prompts (containing $, #, >, %), or command echo
                  if (
                    (trimmed.startsWith("/") || trimmed.startsWith("~")) &&
                    trimmed.length > 0 &&
                    !trimmed.includes("$") &&
                    !trimmed.includes("#") &&
                    !trimmed.includes(">") &&
                    !trimmed.includes("%") &&
                    !trimmed.startsWith("pwd")
                  ) {
                    // Found pwd output
                    currentCwdRef.current = trimmed;
                    setCurrentCwd(trimmed);
                    onCwdChange?.(trimmed);
                    waitingForPwdRef.current = false;
                    pwdResponseRef.current = "";
                    break;
                  }
                }
              } else {
                // Normal output, display to terminal
                term.write(payload.output);
              }
            }
          }).then((u) => {
            unlistenRef.current = u;
          });
        })
        .catch((err) => {
          term.write(`\r\n\x1b[31m✖ Hata: ${String(err)}\x1b[0m\r\n`);
          // Re-prompt on auth failure
          if (overridePass !== undefined) {
            term.write(`\r\nlogin as: `);
            promptRef.current = { stage: "user", user: "", pass: "" };
          }
          onDisconnected(pane.tabId);
        });
    },
    [pane, password, onConnected, onDisconnected],
  );

  useEffect(() => {
    connectCredsRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (wrapperRef.current) {
      const el = wrapperRef.current as HTMLDivElement & {
        __connect?: () => void;
        __disconnect?: () => void;
        __fit?: () => void;
      };
      el.__connect = connect;
      el.__fit = () => {
        try {
          fitRef.current?.fit();
        } catch (_) {}
      };
      el.__disconnect = () => {
        const sid = sshIdRef.current;
        if (sid) {
          invoke("stop_ssh_session", { sessionId: sid }).catch(() => {});
          if (unlistenRef.current) unlistenRef.current();
          sshIdRef.current = null;
        }
        onDisconnected(pane.tabId);
      };
    }
  }, [connect, onDisconnected, pane.tabId]);

  // Auto-connect on first mount when autoConnect=true
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    const needsPrompt =
      !pane.sessionEntry.pass && !pane.sessionEntry.keyPath && !password;
    if (autoConnect && visible && !autoConnectedRef.current && !needsPrompt) {
      autoConnectedRef.current = true;
      setTimeout(() => connect(), 150);
    }
  }, [
    visible,
    autoConnect,
    pane.sessionEntry.pass,
    pane.sessionEntry.keyPath,
    connect,
  ]);

  const activeTransfers = Object.entries(sftpTransfers).filter(
    ([, v]) => !v.done || v.error,
  );
  const doneTransfers = Object.entries(sftpTransfers).filter(
    ([, v]) => v.done && !v.error,
  );

  return (
    <div
      ref={(el) => {
        (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current =
          el;
        paneRef?.(el);
      }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#000000",
        display: visible ? "flex" : "none",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* xterm mounts here — flex-1 so height is flex-determined, not absolute.
          This ensures fit() measures the exact available height (excluding CMD/Status bars). */}
      <div
        ref={containerRef}
        className="hx-scanlines"
        style={{
          flex: "1 1 0",
          minHeight: 0,
          width: "100%",
          overflow: "hidden",
          background: "#000000",
          cursor: "text",
        }}
        tabIndex={-1}
        onMouseDown={() => termRef.current?.focus()}
        onClick={() => termRef.current?.focus()}
      />

      {/* Drag-over overlay */}
      {dragOver && (
        <div className="absolute inset-0 bg-hx-neon/10 border-2 border-dashed border-hx-neon flex items-center justify-center z-20 pointer-events-none">
          <div className="text-hx-neon text-sm font-mono tracking-widest">
            DROP FILES TO UPLOAD VIA SFTP
          </div>
        </div>
      )}

      {/* SFTP file confirm dialog */}
      {sftpFiles.length > 0 && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-30">
          <div className="bg-hx-panel border border-hx-neon/30 rounded p-4 w-80 flex flex-col gap-3">
            <div className="text-hx-neon text-xs font-bold tracking-widest uppercase">
              Upload via SFTP
            </div>
            <div className="text-xs text-hx-muted">Files:</div>
            {sftpFiles.map((fp) => (
              <div key={fp} className="text-xs text-hx-text font-mono truncate">
                {fp.split(/[\\/]/).pop()}
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-hx-muted">Remote directory</label>
              <input
                className="hx-input text-xs px-2 py-1"
                value={sftpRemoteDir || currentCwd}
                onChange={(e) => setSftpRemoteDir(e.target.value)}
                placeholder="~/uploads"
              />
              <span className="text-[10px] text-hx-dim font-mono">
                SSH terminalindeki mevcut kod dizini otomatik doldurulur (
                {currentCwd})
              </span>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSftpFiles([])}
                className="px-3 py-1 text-xs text-hx-muted hover:text-hx-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={startSftpUpload}
                className="px-3 py-1 text-xs bg-hx-neon/20 text-hx-neon border border-hx-neon/30 rounded hover:bg-hx-neon/30 transition-colors"
              >
                Upload
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SFTP Transfer Toast */}
      {(activeTransfers.length > 0 || doneTransfers.length > 0) && (
        <SftpToast
          transfers={sftpTransfers}
          activeTransfers={activeTransfers}
          doneTransfers={doneTransfers}
          onDismiss={(id) =>
            setSftpTransfers((prev) => {
              const n = { ...prev };
              delete n[id];
              return n;
            })
          }
          onClearDone={() =>
            setSftpTransfers((prev) => {
              const n: typeof prev = {};
              for (const [k, v] of Object.entries(prev)) {
                if (!v.done) n[k] = v;
              }
              return n;
            })
          }
        />
      )}
    </div>
  );
});

// ── SftpToast ─────────────────────────────────────────────────────────────────

type TransferMap = Record<
  string,
  {
    name: string;
    progress: number;
    done: boolean;
    error?: string;
    remotePath?: string;
    remoteDir?: string;
  }
>;

function SftpToast({
  transfers,
  activeTransfers,
  doneTransfers,
  onDismiss,
  onClearDone,
}: {
  transfers: TransferMap;
  activeTransfers: [string, TransferMap[string]][];
  doneTransfers: [string, TransferMap[string]][];
  onDismiss: (id: string) => void;
  onClearDone: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = Object.keys(transfers).length;
  const inProgress = activeTransfers.filter(([, v]) => !v.done).length;
  const errors = Object.values(transfers).filter((v) => v.error).length;
  const allDone = inProgress === 0;

  // Overall progress
  const overallProgress =
    total > 0
      ? Math.round(
          Object.values(transfers).reduce((s, v) => s + v.progress, 0) / total,
        )
      : 0;

  return (
    <>
      {/* Toast pill */}
      <div
        className="absolute bottom-3 right-3 z-20 group cursor-pointer"
        onClick={() => setExpanded(true)}
      >
        {/* Collapsed pill */}
        <div className="flex items-center gap-3 bg-hx-panel border border-hx-border rounded-full px-4 py-2 shadow-lg transition-all hover:border-hx-neon/40 hover:shadow-[0_0_16px_rgba(0,229,255,0.15)]">
          <Upload
            size={15}
            className={
              allDone ? "text-hx-success" : "text-hx-neon animate-pulse"
            }
          />
          <span className="text-xs font-mono text-hx-muted">
            {allDone
              ? errors > 0
                ? `${errors} failed`
                : `${total} done`
              : `${inProgress}/${total} uploading`}
          </span>
          {!allDone && (
            <div className="w-20 h-1.5 bg-hx-border rounded overflow-hidden">
              <div
                className="h-full bg-hx-neon transition-all"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          )}
        </div>

        {/* Hover expand */}
        <div className="hidden group-hover:flex flex-col gap-2 absolute bottom-full right-0 mb-2 bg-hx-panel border border-hx-border rounded p-3 w-80 shadow-xl max-h-56 overflow-y-auto">
          {Object.entries(transfers)
            .slice(-5)
            .map(([id, t]) => (
              <div key={id} className="flex items-center gap-2 text-[10px]">
                <span
                  className="text-hx-muted truncate flex-1 font-mono"
                  title={t.remotePath}
                >
                  {t.name}
                </span>
                {t.error ? (
                  <span className="text-hx-danger shrink-0">error</span>
                ) : t.done ? (
                  <span
                    className="text-hx-success shrink-0 truncate max-w-32 font-mono"
                    title={t.remotePath}
                  >
                    ✓ {t.remoteDir || "done"}
                  </span>
                ) : (
                  <span className="text-hx-neon shrink-0">{t.progress}%</span>
                )}
              </div>
            ))}
        </div>
      </div>

      {/* Modal */}
      {expanded && (
        <div
          className="absolute inset-0 bg-black/60 flex items-center justify-center z-40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div className="bg-hx-panel border border-hx-neon/20 rounded p-4 w-96 max-h-[70vh] flex flex-col gap-3 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Upload size={14} className="text-hx-neon" />
                <span className="text-xs font-bold tracking-widest uppercase text-hx-neon">
                  SFTP Transfers
                </span>
              </div>
              <div className="flex items-center gap-2">
                {doneTransfers.length > 0 && (
                  <button
                    onClick={onClearDone}
                    className="text-[10px] text-hx-dim hover:text-hx-muted transition-colors"
                  >
                    Clear done
                  </button>
                )}
                <button
                  onClick={() => setExpanded(false)}
                  className="text-hx-dim hover:text-hx-text transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {Object.entries(transfers).length === 0 ? (
                <p className="text-xs text-hx-dim text-center py-4">
                  No transfers
                </p>
              ) : (
                Object.entries(transfers).map(([id, t]) => (
                  <div
                    key={id}
                    className="bg-hx-bg border border-hx-border rounded px-3 py-2 flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-hx-text font-mono truncate">
                        {t.name}
                      </span>
                      <button
                        onClick={() => onDismiss(id)}
                        className="text-hx-dim hover:text-hx-text transition-colors shrink-0"
                      >
                        <X size={10} />
                      </button>
                    </div>
                    {t.error ? (
                      <span className="text-[10px] text-hx-danger font-mono">
                        ✖ {t.error}
                      </span>
                    ) : t.done ? (
                      <div className="flex flex-col gap-0.5">
                        {t.remoteDir && (
                          <span
                            className="text-[10px] text-hx-dim font-mono truncate"
                            title={t.remoteDir}
                          >
                            📁 {t.remoteDir}
                          </span>
                        )}
                        <span
                          className="text-[10px] text-hx-success font-mono truncate"
                          title={t.remotePath}
                        >
                          ✓ {t.name}
                          {!t.remoteDir && t.remotePath
                            ? ` → ${t.remotePath}`
                            : ""}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-hx-border rounded overflow-hidden">
                          <div
                            className="h-full bg-hx-neon transition-all"
                            style={{ width: `${t.progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-hx-neon font-mono shrink-0">
                          {t.progress}%
                        </span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── SessionCard ───────────────────────────────────────────────────────────────

interface SessionCardProps {
  session: SessionEntry;
  isOpen: boolean;
  isConnected: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: (e: React.MouseEvent) => void;
  autoConnect?: boolean;
  credentials?: Credential[];
  darkMode?: boolean;
}

const SessionCard = memo(
  function SessionCard({
    session,
    isOpen,
    isConnected,
    onOpen,
    onEdit,
    onRemove,
    credentials,
    darkMode,
  }: SessionCardProps) {
    const isDark = darkMode ?? true;
    const accent = adaptColor(session.color || "#00E5FF", isDark);
    const statusColor = isConnected
      ? isDark
        ? "#00FF88"
        : "#00875a"
      : isOpen
        ? accent
        : isDark
          ? "#2A3550"
          : "#a0aec0";
    const statusText = isConnected ? "CONNECTED" : isOpen ? "OPEN" : "IDLE";

    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!menuOpen) return;
      const handler = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setMenuOpen(false);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [menuOpen]);

    return (
      <div onClick={onOpen} className="hx-card group cursor-pointer">
        {/* Inner panel with accent top border */}
        <div
          className="bg-hx-panel border border-hx-border group-hover:border-hx-neon/20 transition-colors p-4 relative"
          style={{ borderTop: `2px solid ${accent}` }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rotate-45 transition-colors shrink-0"
                style={{
                  background: statusColor,
                  boxShadow: isConnected ? `0 0 6px ${statusColor}` : "none",
                }}
              />
              <span
                className="text-[9px] font-mono uppercase tracking-widest"
                style={{ color: statusColor }}
              >
                {statusText}
              </span>
            </div>
            {/* 3-dot context menu */}
            <div
              ref={menuRef}
              className="relative opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="p-1 text-hx-dim hover:text-hx-text transition-colors rounded"
              >
                <MoreVertical size={13} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 bg-hx-panel border border-hx-border z-50 min-w-27.5 shadow-lg">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit();
                    }}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs font-mono text-hx-muted hover:text-hx-neon hover:bg-hx-neon/5 transition-colors"
                  >
                    <Edit2 size={10} /> Edit
                  </button>
                  <button
                    onClick={(e) => {
                      setMenuOpen(false);
                      onRemove(e);
                    }}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 text-xs font-mono text-hx-muted hover:text-hx-danger hover:bg-hx-danger/5 transition-colors"
                  >
                    <Trash2 size={10} /> Delete
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Session info */}
          <div className="flex items-center gap-2 mb-1">
            <Server size={12} className="text-hx-dim shrink-0" />
            <span className="text-sm font-bold text-hx-text truncate">
              {session.label}
            </span>
          </div>
          <div className="font-mono text-[11px] text-hx-muted mb-1 pl-5 truncate">
            {session.user}@{session.host}:{session.port}
          </div>
          {session.group && (
            <div
              className="text-[10px] pl-5 mb-3 font-mono truncate"
              style={{ color: accent + "99" }}
            >
              ◆ {session.group}
            </div>
          )}
          {!session.group && <div className="mb-3" />}

          {/* Auth type */}
          <div className="flex items-center gap-1.5 mb-4">
            <Key size={10} className="text-hx-dim" />
            <span className="text-[10px] text-hx-dim font-mono">
              {session.credentialId
                ? credentials?.find(
                    (c: Credential) => c.id === session.credentialId,
                  )?.label || "linked credential"
                : session.keyPath
                  ? "key auth"
                  : "password auth"}
            </span>
          </div>

          {/* Open button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="hx-clip-btn w-full py-2 text-[11px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-all"
            style={{
              background: `linear-gradient(135deg, ${accent}22, ${accent}0a)`,
              border: `1px solid ${accent}55`,
              color: accent,
            }}
          >
            <Play size={10} fill={accent} />
            Open Session
          </button>
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.session === next.session &&
      prev.isOpen === next.isOpen &&
      prev.isConnected === next.isConnected &&
      prev.darkMode === next.darkMode &&
      prev.credentials === next.credentials
    );
  },
);

// ── OverviewCardGrid ──────────────────────────────────────────────────────────

interface OverviewCardGridProps {
  overviewSessions: SessionEntry[];
  connectedTabsBySessionId: Map<string, TabPane>;
  onOpenTab: (entry: SessionEntry) => void;
  onEditSession: (session: SessionEntry) => void;
  onRemoveSession: (id: string, e: React.MouseEvent) => void;
  credentials: Credential[];
  darkMode: boolean;
}

const OverviewCardGrid = memo(
  function OverviewCardGrid({
    overviewSessions,
    connectedTabsBySessionId,
    onOpenTab,
    onEditSession,
    onRemoveSession,
    credentials,
    darkMode,
  }: OverviewCardGridProps) {
    return (
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        }}
      >
        {overviewSessions.map((s) => {
          const connectedTab = connectedTabsBySessionId.get(s.id);
          return (
            <SessionCard
              key={s.id}
              session={s}
              isOpen={!!connectedTab}
              isConnected={connectedTab?.connected ?? false}
              onOpen={() => onOpenTab(s)}
              onEdit={() => onEditSession(s)}
              onRemove={(e) => onRemoveSession(s.id, e)}
              credentials={credentials}
              darkMode={darkMode}
            />
          );
        })}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.overviewSessions === next.overviewSessions &&
      prev.connectedTabsBySessionId === next.connectedTabsBySessionId &&
      prev.onOpenTab === next.onOpenTab &&
      prev.onEditSession === next.onEditSession &&
      prev.onRemoveSession === next.onRemoveSession &&
      prev.credentials === next.credentials &&
      prev.darkMode === next.darkMode
    );
  },
);

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [sessions, setSessions] = useState<SessionEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_sessions") || "[]");
    } catch {
      return [];
    }
  });

  const [tabs, setTabs] = useState<TabPane[]>([]);
  const [activeView, setActiveView] = useState<string>("overview"); // "overview" | "settings" | "new-session" | tabId
  const [openViews, setOpenViews] = useState<
    Set<"overview" | "settings" | "new-session">
  >(() => new Set(["overview"] as const));
  const [autoConnectTabId, setAutoConnectTabId] = useState<string | null>(null);
  const [splitTabs, setSplitTabs] = useState<
    Record<string, "horizontal" | "vertical">
  >({});
  const [tabContextMenu, setTabContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [selectedColor, setSelectedColor] = useState(NEON_COLORS[0]);
  const [form, setForm] = useState({
    label: "",
    host: "",
    port: 22,
    user: "root",
    pass: "",
    keyPath: "",
    group: "",
    credentialId: "",
  });
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSession, setEditingSession] = useState<SessionEntry | null>(
    null,
  );
  const [editForm, setEditForm] = useState({
    label: "",
    host: "",
    port: 22,
    user: "root",
    pass: "",
    keyPath: "",
    group: "",
    credentialId: "",
  });
  const [editSelectedColor, setEditSelectedColor] = useState(NEON_COLORS[0]);
  const [settingsSearch, setSettingsSearch] = useState("");
  const [settingsTab, setSettingsTab] = useState<
    "sessions" | "credentials" | "tags" | "scripts" | "general" | "about"
  >("sessions");

  const [credentials, setCredentials] = useState<Credential[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_credentials") || "[]");
    } catch {
      return [];
    }
  });
  const [tags, setTags] = useState<Tag[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_tags") || "[]");
    } catch {
      return [];
    }
  });
  const [scripts, setScripts] = useState<Script[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_scripts") || "[]");
    } catch {
      return [];
    }
  });
  const [generalSettings, setGeneralSettings] = useState<GeneralSettings>(
    () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem("atlas_general") || "null",
        );
        if (saved) {
          // Migrate legacy darkMode field
          if (!saved.theme) {
            saved.theme = saved.darkMode ? "dark" : "light";
          }
          return saved as GeneralSettings;
        }
        return {
          logPath: "",
          fontSize: 15,
          fontFamily: "'Fira Code', Consolas, monospace",
          theme: "light",
        };
      } catch {
        return {
          logPath: "",
          fontSize: 15,
          fontFamily: "'Fira Code', Consolas, monospace",
          theme: "light",
        };
      }
    },
  );

  // Credential form
  const [credForm, setCredForm] = useState({
    label: "",
    user: "root",
    pass: "",
    keyPath: "",
  });
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  // Tag form
  const [tagForm, setTagForm] = useState({ name: "", color: NEON_COLORS[0] });
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  // Script form
  const [scriptForm, setScriptForm] = useState({ name: "", content: "" });
  const [editingScript, setEditingScript] = useState<Script | null>(null);

  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const paneRefCallbacks = useRef<
    Record<string, (el: HTMLDivElement | null) => void>
  >({});

  // Tab drag-reorder state
  const dragTabId = useRef<string | null>(null);
  const dragOverTabId = useRef<string | null>(null);
  const [tabDragOverId, setTabDragOverId] = useState<string | null>(null);
  const [tabDragGhost, setTabDragGhost] = useState<{
    x: number;
    y: number;
    offsetX: number;
    label: string;
    color: string;
    connected: boolean;
  } | null>(null);

  // Stable refs for useCallback closures
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Migrate plaintext passwords from localStorage to OS keychain on first run,
  // then load passwords from keychain into memory.
  useEffect(() => {
    (async () => {
      // ── Credentials ──
      const enrichedCreds = await Promise.all(
        credentials.map(async (c) => {
          // Migrate existing plaintext pass to keychain
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
      // Strip plaintext from localStorage
      try {
        localStorage.setItem(
          "atlas_credentials",
          JSON.stringify(enrichedCreds.map(({ pass: _p, ...rest }) => rest)),
        );
      } catch {}

      // ── Sessions ──
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
          // Session uses a credential — pass comes from the credential
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

  // Apply theme to <html> so all CSS variables cascade correctly
  useEffect(() => {
    const html = document.documentElement;
    // Remove all known theme classes
    html.classList.remove("dark", ...THEMES.map((t) => `theme-${t.id}`));
    const theme = generalSettings.theme ?? "light";
    if (theme === "dark") {
      html.classList.add("dark", "theme-dark");
    } else if (theme !== "light") {
      html.classList.add(`theme-${theme}`);
    }
  }, [generalSettings.theme]);

  // Ctrl+F5 → reconnect active tab
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "F5") {
        e.preventDefault();
        if (activeView && tabs.some((t) => t.tabId === activeView)) {
          connectPane(activeView);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, tabs]);

  // Detach URL param — open a session directly when spawned as new window
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const detachId = params.get("detach");
    if (!detachId) return;
    try {
      const raw = localStorage.getItem("atlas_sessions");
      if (!raw) return;
      const all: SessionEntry[] = JSON.parse(raw);
      const sess = all.find((s) => s.id === detachId);
      if (!sess) return;
      const tab: TabPane = {
        tabId: crypto.randomUUID(),
        sessionEntry: sess,
        sshSessionId: null,
        connected: false,
      };
      setTabs([tab]);
      setActiveView(tab.tabId);
      setAutoConnectTabId(tab.tabId);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveSessions(list: SessionEntry[]) {
    setSessions(list);
    // Strip passwords from localStorage copy — passwords live in OS keychain only
    try {
      localStorage.setItem(
        "atlas_sessions",
        JSON.stringify(list.map(({ pass: _p, ...rest }) => rest)),
      );
    } catch {}
    // Persist each session's own password (sessions without credentialId) to keychain
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
  }
  function saveCredentials(list: Credential[]) {
    setCredentials(list);
    // Strip passwords from localStorage copy — passwords live in OS keychain only
    try {
      localStorage.setItem(
        "atlas_credentials",
        JSON.stringify(list.map(({ pass: _p, ...rest }) => rest)),
      );
    } catch {}
    // Persist each credential's password to keychain
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
  }
  function saveTags(list: Tag[]) {
    setTags(list);
    try {
      localStorage.setItem("atlas_tags", JSON.stringify(list));
    } catch {}
  }
  function saveScripts(list: Script[]) {
    setScripts(list);
    try {
      localStorage.setItem("atlas_scripts", JSON.stringify(list));
    } catch {}
  }
  function saveGeneral(s: GeneralSettings) {
    setGeneralSettings(s);
    try {
      localStorage.setItem("atlas_general", JSON.stringify(s));
    } catch {}
  }

  const [importStatus, setImportStatus] = useState<string | null>(null);

  function addSession() {
    const newLabel = form.label || `${form.user}@${form.host}`;
    if (sessions.some((s) => s.label === newLabel)) return;
    const cred = credentials.find((c) => c.id === form.credentialId);
    const s: SessionEntry = {
      id: crypto.randomUUID(),
      label: newLabel,
      host: form.host,
      port: Number(form.port) || 22,
      user: cred ? cred.user : form.user,
      pass: cred ? cred.pass : form.pass || undefined,
      keyPath: cred ? cred.keyPath : form.keyPath || undefined,
      group: form.group || undefined,
      color: selectedColor,
      credentialId: form.credentialId || undefined,
    };
    saveSessions([s, ...sessions]);
    setForm({
      label: "",
      host: "",
      port: 22,
      user: "root",
      pass: "",
      keyPath: "",
      group: "",
      credentialId: "",
    });
    setSelectedColor(NEON_COLORS[0]);
    closeView("new-session");
  }

  const removeSession = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = sessionsRef.current.filter((s) => s.id !== id);
    setSessions(updated);
    try {
      localStorage.setItem("atlas_sessions", JSON.stringify(updated));
    } catch {}
  }, []);

  function updateSession() {
    if (!editingSession || !editForm.host) return;
    const cred = credentials.find((c) => c.id === editForm.credentialId);
    const updated: SessionEntry = {
      ...editingSession,
      label: editForm.label || `${editForm.user}@${editForm.host}`,
      host: editForm.host,
      port: Number(editForm.port) || 22,
      user: cred ? cred.user : editForm.user,
      pass: cred ? cred.pass : editForm.pass || undefined,
      keyPath: cred ? cred.keyPath : editForm.keyPath || undefined,
      group: editForm.group || undefined,
      color: editSelectedColor,
      credentialId: editForm.credentialId || undefined,
    };
    saveSessions(
      sessions.map((s) => (s.id === editingSession.id ? updated : s)),
    );
    setEditingSession(null);
  }

  // ── Credential CRUD ────────────────────────────────────
  function addCredential() {
    if (!credForm.user) return;
    const c: Credential = {
      id: crypto.randomUUID(),
      label: credForm.label || credForm.user,
      user: credForm.user,
      pass: credForm.pass || undefined,
      keyPath: credForm.keyPath || undefined,
    };
    saveCredentials([c, ...credentials]);
    setCredForm({ label: "", user: "root", pass: "", keyPath: "" });
  }
  function updateCredential() {
    if (!editingCred) return;
    const updated: Credential = {
      ...editingCred,
      label: credForm.label || credForm.user,
      user: credForm.user,
      pass: credForm.pass || undefined,
      keyPath: credForm.keyPath || undefined,
    };
    saveCredentials(
      credentials.map((c) => (c.id === editingCred.id ? updated : c)),
    );
    setEditingCred(null);
    setCredForm({ label: "", user: "root", pass: "", keyPath: "" });
  }
  function removeCredential(id: string) {
    saveCredentials(credentials.filter((c) => c.id !== id));
  }

  // ── Tag CRUD ───────────────────────────────────────────
  function addTag() {
    if (!tagForm.name) return;
    const t: Tag = {
      id: crypto.randomUUID(),
      name: tagForm.name,
      color: tagForm.color,
    };
    saveTags([t, ...tags]);
    setTagForm({ name: "", color: NEON_COLORS[0] });
  }
  function updateTag() {
    if (!editingTag) return;
    saveTags(
      tags.map((t) =>
        t.id === editingTag.id
          ? { ...editingTag, name: tagForm.name, color: tagForm.color }
          : t,
      ),
    );
    setEditingTag(null);
    setTagForm({ name: "", color: NEON_COLORS[0] });
  }
  function removeTag(id: string) {
    saveTags(tags.filter((t) => t.id !== id));
  }

  // ── Script CRUD ────────────────────────────────────────
  function addScript() {
    if (!scriptForm.name || !scriptForm.content) return;
    const s: Script = {
      id: crypto.randomUUID(),
      name: scriptForm.name,
      content: scriptForm.content,
    };
    saveScripts([s, ...scripts]);
    setScriptForm({ name: "", content: "" });
  }
  function updateScript() {
    if (!editingScript) return;
    saveScripts(
      scripts.map((s) =>
        s.id === editingScript.id ? { ...editingScript, ...scriptForm } : s,
      ),
    );
    setEditingScript(null);
    setScriptForm({ name: "", content: "" });
  }
  function removeScript(id: string) {
    saveScripts(scripts.filter((s) => s.id !== id));
  }

  function openView(kind: "overview" | "settings" | "new-session") {
    setOpenViews((prev) => {
      if (prev.has(kind)) return prev;
      return new Set([...prev, kind]);
    });
    setActiveView((prev) => (prev === kind ? prev : kind));
  }
  function closeView(kind: "overview" | "settings" | "new-session") {
    setOpenViews((prev) => {
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
    if (activeView === kind) {
      const other = [...openViews].find((v) => v !== kind);
      if (other) setActiveView(other);
      else if (tabs.length > 0) setActiveView(tabs[tabs.length - 1].tabId);
      else setActiveView("");
    }
  }

  const openTab = useCallback((entry: SessionEntry, autoConnect = true) => {
    const existing = tabsRef.current.find(
      (t) => t.sessionEntry.id === entry.id,
    );
    if (existing) {
      setActiveView(existing.tabId);
      return;
    }
    const tab: TabPane = {
      tabId: crypto.randomUUID(),
      sessionEntry: entry,
      sshSessionId: null,
      connected: false,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveView(tab.tabId);
    if (autoConnect) setAutoConnectTabId(tab.tabId);
  }, []);

  function closeTab(tabId: string, e: React.MouseEvent) {
    e.stopPropagation();
    closeTabById(tabId);
  }

  function closeTabById(tabId: string) {
    const remaining = tabs.filter((t) => t.tabId !== tabId);
    setTabs(remaining);
    if (activeView === tabId) {
      if (remaining.length > 0)
        setActiveView(remaining[remaining.length - 1].tabId);
      else {
        // No tabs left — force overview open
        openView("overview");
      }
    }
    // If no tabs remain, ensure overview is open
    if (remaining.length === 0 && !openViews.has("overview")) {
      openView("overview");
    }
    if (splitTabs[tabId]) {
      setSplitTabs((prev) => {
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    }
    delete paneRefCallbacks.current[tabId];
    delete paneRefCallbacks.current[`split-${tabId}`];
  }

  function toggleSplitForTab(
    tabId: string,
    direction?: "horizontal" | "vertical",
  ) {
    setSplitTabs((prev) => {
      if (prev[tabId]) {
        if (direction && prev[tabId] !== direction) {
          return { ...prev, [tabId]: direction };
        }
        const next = { ...prev };
        delete next[tabId];
        return next;
      }
      return { ...prev, [tabId]: direction || "horizontal" };
    });
  }

  function connectPane(tabId: string) {
    const el = paneRefs.current[tabId];
    if (el) (el as HTMLDivElement & { __connect?: () => void }).__connect?.();
  }

  function disconnectSplitPane(tabId: string) {
    const el = paneRefs.current[`split-${tabId}`];
    if (el)
      (el as HTMLDivElement & { __disconnect?: () => void }).__disconnect?.();
  }

  function detachTab(tabId: string) {
    const tab = tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    try {
      const label = `detach${Date.now()}`;
      new WebviewWindow(label, {
        url:
          window.location.origin +
          "/?detach=" +
          encodeURIComponent(tab.sessionEntry.id),
        title: tab.sessionEntry.label,
        width: 1000,
        height: 650,
        decorations: false,
        resizable: true,
      });
    } catch (err) {
      console.error("Failed to detach window:", err);
    }
  }

  function exportSettings() {
    const data = {
      sessions,
      credentials,
      tags,
      scripts,
      generalSettings,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importSettings(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (Array.isArray(data.sessions)) saveSessions(data.sessions);
        if (Array.isArray(data.credentials)) saveCredentials(data.credentials);
        if (Array.isArray(data.tags)) saveTags(data.tags);
        if (Array.isArray(data.scripts)) saveScripts(data.scripts);
        if (data.generalSettings) saveGeneral(data.generalSettings);
        setImportStatus("✓ Settings imported successfully");
        setTimeout(() => setImportStatus(null), 4000);
      } catch {
        setImportStatus("✗ Import failed — invalid file");
        setTimeout(() => setImportStatus(null), 4000);
      }
    };
    reader.readAsText(file);
  }

  const handleConnected = useCallback((tabId: string, sshId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId ? { ...t, sshSessionId: sshId, connected: true } : t,
      ),
    );
  }, []);

  const handleDisconnected = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId ? { ...t, sshSessionId: null, connected: false } : t,
      ),
    );
  }, []);

  const isOverview = activeView === "overview";
  const showSettings = activeView === "settings";
  const isNewSession = activeView === "new-session";
  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeView),
    [tabs, activeView],
  );
  const activeSplit = activeTab ? splitTabs[activeTab.tabId] : undefined;

  // Refit all visible terminal panes when split mode or active tab changes
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const key of Object.keys(paneRefs.current)) {
        const el = paneRefs.current[key] as HTMLDivElement & {
          __fit?: () => void;
        };
        el?.__fit?.();
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [activeSplit, activeView]);

  const darkMode = getTheme(generalSettings.theme ?? "light").isDark;

  const getStablePaneRef = useCallback((id: string) => {
    if (!paneRefCallbacks.current[id]) {
      paneRefCallbacks.current[id] = (el: HTMLDivElement | null) => {
        paneRefs.current[id] = el;
      };
    }
    return paneRefCallbacks.current[id];
  }, []);

  const tabPasswords = useMemo(() => {
    const map: Record<string, string> = {};
    for (const tab of tabs) {
      map[tab.tabId] =
        passwords[tab.tabId] ||
        credentials.find((c) => c.id === tab.sessionEntry.credentialId)?.pass ||
        "";
    }
    return map;
  }, [tabs, passwords, credentials]);

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const normalizedOverviewSearch = deferredSearchQuery.trim().toLowerCase();
  const connectedTabsBySessionId = useMemo(() => {
    const map = new Map<string, TabPane>();
    for (const tab of tabs) {
      map.set(tab.sessionEntry.id, tab);
    }
    return map;
  }, [tabs]);
  const overviewSessions = useMemo(() => {
    if (!normalizedOverviewSearch) return sessions;
    return sessions.filter(
      (session) =>
        session.label.toLowerCase().includes(normalizedOverviewSearch) ||
        session.host.toLowerCase().includes(normalizedOverviewSearch),
    );
  }, [sessions, normalizedOverviewSearch]);

  const connectedCount = useMemo(
    () => tabs.filter((t) => t.connected).length,
    [tabs],
  );

  const handleEditSession = useCallback((s: SessionEntry) => {
    setEditForm({
      label: s.label,
      host: s.host,
      port: s.port,
      user: s.user,
      pass: s.pass || "",
      keyPath: s.keyPath || "",
      group: s.group || "",
      credentialId: s.credentialId || "",
    });
    setEditSelectedColor(s.color || NEON_COLORS[0]);
    setEditingSession(s);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-hx-bg text-hx-text overflow-hidden">
      {/* ── Tab Bar ──────────────────────────────────────── */}
      <div
        data-tauri-drag-region
        className="hx-tabbar flex items-stretch border-b border-white/10 shrink-0 h-9 w-full relative select-none overflow-hidden"
      >
        {/* Settings — far left, opens as a tab */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() =>
            activeView === "settings"
              ? closeView("settings")
              : openView("settings")
          }
          className={`flex items-center px-3 border-r border-white/10 shrink-0 transition-colors ${showSettings ? "text-hx-neon bg-hx-neon/10" : "text-white/50 hover:text-white/90 hover:bg-white/10"}`}
          title="Settings"
        >
          <Settings size={12} />
        </button>

        {/* Virtual tabs: overview + settings */}
        {openViews.has("overview") && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 1 && tabs.length > 0) {
                e.preventDefault();
                closeView("overview");
              }
            }}
            onClick={() => setActiveView("overview")}
            className={`hx-tab group flex items-center gap-1.5 px-4 text-xs whitespace-nowrap shrink-0 ${isOverview ? "hx-tab-virtual-active" : ""}`}
            style={
              isOverview ? { borderTop: "2px solid var(--color-hx-neon)" } : {}
            }
          >
            <Server size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap pr-2">
              Overview
            </span>
            {/* Only allow closing overview when there are SSH tabs open */}
            {tabs.length > 0 && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeView("overview");
                }}
                className="ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-hx-danger leading-none"
              >
                <X size={9} />
              </span>
            )}
          </button>
        )}
        {openViews.has("settings") && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 1) {
                e.preventDefault();
                closeView("settings");
              }
            }}
            onClick={() => setActiveView("settings")}
            className={`hx-tab group flex items-center gap-1.5 px-4 text-xs whitespace-nowrap shrink-0 ${showSettings ? "hx-tab-virtual-active" : ""}`}
            style={
              showSettings
                ? { borderTop: "2px solid var(--color-hx-neon)" }
                : {}
            }
          >
            <Settings size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap pr-2">
              Settings
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeView("settings");
              }}
              className="ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-hx-danger leading-none"
            >
              <X size={9} />
            </span>
          </button>
        )}
        {openViews.has("new-session") && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              if (e.button === 1) {
                e.preventDefault();
                closeView("new-session");
              }
            }}
            onClick={() => setActiveView("new-session")}
            className={`hx-tab group flex items-center gap-1.5 px-4 text-xs whitespace-nowrap shrink-0 ${isNewSession ? "hx-tab-virtual-active" : ""}`}
            style={
              isNewSession
                ? { borderTop: "2px solid var(--color-hx-neon)" }
                : {}
            }
          >
            <Plus size={11} />
            <span>New Session</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeView("new-session");
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 cursor-pointer hover:text-hx-danger leading-none"
            >
              <X size={9} />
            </span>
          </button>
        )}

        {/* SSH terminal tabs */}
        <div
          className="flex-1 min-w-0 overflow-hidden grid items-stretch"
          style={{
            gridTemplateColumns: `${tabs.map(() => "minmax(0, 180px)").join(" ")} auto 1fr`,
          }}
        >
          {tabs.map((tab) => {
            const accent = tab.sessionEntry.color || "#00E5FF";
            const isActive = activeView === tab.tabId;
            return (
              <div
                key={tab.tabId}
                data-tab-id={tab.tabId}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTabById(tab.tabId);
                  }
                }}
                onClick={() => setActiveView(tab.tabId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTabContextMenu({
                    tabId: tab.tabId,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
                className={`hx-tab group flex items-center gap-1 pl-1 pr-2 min-w-0 text-xs whitespace-nowrap cursor-default ${
                  isActive ? "hx-tab-term-active" : ""
                } ${tabDragOverId === tab.tabId ? "ring-1 ring-hx-neon/40" : ""}`}
                style={
                  isActive
                    ? {
                        borderTop: `2px solid ${adaptColor(accent, false)}`,
                      }
                    : {}
                }
              >
                {/* Drag handle — 3 dots, mouse-based drag (HTML5 DnD broken in WebView2) */}
                <span
                  className="flex flex-col gap-0.75 p-1 opacity-0 group-hover:opacity-30 hover:opacity-70! cursor-grab active:cursor-grabbing shrink-0 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dragTabId.current = tab.tabId;
                    (window as any).__tabDragging = true;
                    const tabEl =
                      e.currentTarget.closest<HTMLElement>("[data-tab-id]");
                    const tabRect = tabEl
                      ? tabEl.getBoundingClientRect()
                      : null;
                    const offsetX = tabRect ? e.clientX - tabRect.left : 0;
                    setTabDragGhost({
                      x: e.clientX,
                      y: e.clientY,
                      offsetX,
                      label: tab.sessionEntry.label,
                      color: accent,
                      connected: !!tab.connected,
                    });
                    const onMove = (me: MouseEvent) => {
                      setTabDragGhost((prev) =>
                        prev ? { ...prev, x: me.clientX, y: me.clientY } : null,
                      );
                      const els =
                        document.querySelectorAll<HTMLElement>("[data-tab-id]");
                      let found: string | null = null;
                      for (const el of els) {
                        const r = el.getBoundingClientRect();
                        if (me.clientX >= r.left && me.clientX <= r.right) {
                          found = el.getAttribute("data-tab-id");
                          break;
                        }
                      }
                      setTabDragOverId(found);
                      dragOverTabId.current = found;
                    };
                    const onUp = () => {
                      const fromId = dragTabId.current;
                      const toId = dragOverTabId.current;
                      if (fromId && toId && fromId !== toId) {
                        setTabs((prev) => {
                          const next = [...prev];
                          const fromIdx = next.findIndex(
                            (t) => t.tabId === fromId,
                          );
                          const toIdx = next.findIndex((t) => t.tabId === toId);
                          if (fromIdx < 0 || toIdx < 0) return prev;
                          const [moved] = next.splice(fromIdx, 1);
                          next.splice(toIdx, 0, moved);
                          return next;
                        });
                      }
                      dragTabId.current = null;
                      dragOverTabId.current = null;
                      setTabDragOverId(null);
                      setTabDragGhost(null);
                      (window as any).__tabDragging = false;
                      document.removeEventListener("mousemove", onMove);
                      document.removeEventListener("mouseup", onUp);
                    };
                    document.addEventListener("mousemove", onMove);
                    document.addEventListener("mouseup", onUp);
                  }}
                >
                  <span className="w-0.75 h-0.75 rounded-full bg-current" />
                  <span className="w-0.75 h-0.75 rounded-full bg-current" />
                  <span className="w-0.75 h-0.75 rounded-full bg-current" />
                </span>
                <div
                  className="w-1.5 h-1.5 rotate-45 shrink-0"
                  style={{
                    background: tab.connected
                      ? isActive
                        ? "#00875a"
                        : "#00FF88"
                      : isActive
                        ? adaptColor(accent, false)
                        : "rgba(255,255,255,0.2)",
                    boxShadow:
                      tab.connected && !isActive ? "0 0 6px #00FF88" : "none",
                  }}
                />
                <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {tab.sessionEntry.label}
                </span>
                {splitTabs[tab.tabId] && (
                  <Columns2
                    size={9}
                    className="text-hx-neon/60 shrink-0 mx-0.5"
                  />
                )}
                <span
                  onClick={(e) => closeTab(tab.tabId, e)}
                  className="ml-auto pl-1 shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100! transition-opacity cursor-pointer hover:text-hx-danger leading-none"
                >
                  <X size={10} />
                </span>
              </div>
            );
          })}
          {/* + opens Sessions overview — sits right after last tab */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => openView("overview")}
            className="flex items-center justify-center w-8 h-full text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            title="Sessions"
          >
            <Plus size={12} />
          </button>
          {/* Drag spacer — empty area for window dragging */}
          <div data-tauri-drag-region className="h-full" />
        </div>

        {/* Controls */}
        {/* Window controls */}
        <div className="shrink-0 flex items-center">
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => appWindow.minimize()}
            className="flex items-center justify-center w-11 h-full text-white/75 hover:text-white hover:bg-white/10 transition-colors"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => appWindow.toggleMaximize()}
            className="flex items-center justify-center w-11 h-full text-white/75 hover:text-white hover:bg-white/10 transition-colors"
            title="Maximize"
          >
            <Square size={12} />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => appWindow.close()}
            className="flex items-center justify-center w-11 h-full text-white/75 hover:text-white hover:bg-red-500/80 transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Tab drag ghost — Chrome-style floating clone */}
      {tabDragGhost && (
        <div
          className="fixed z-9999 pointer-events-none select-none"
          style={{
            left: tabDragGhost.x - tabDragGhost.offsetX,
            top: 0,
            height: 36,
            transform: `translateY(${tabDragGhost.y - 18}px)`,
            transition: "none",
            willChange: "transform, left",
          }}
        >
          <div
            className="flex items-center gap-1 pl-1 pr-3 h-full text-xs whitespace-nowrap border-t-2 shadow-xl"
            style={{
              borderTopColor: adaptColor(tabDragGhost.color, false),
              background: "#131620",
              borderBottom: "1px solid rgba(255,255,255,0.12)",
              borderLeft: "1px solid rgba(255,255,255,0.08)",
              borderRight: "1px solid rgba(255,255,255,0.08)",
              opacity: 0.92,
              boxShadow:
                "0 8px 24px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.4)",
              minWidth: 80,
              maxWidth: 180,
              cursor: "grabbing",
            }}
          >
            <div
              className="w-1.5 h-1.5 rotate-45 shrink-0"
              style={{
                background: tabDragGhost.connected
                  ? "#00FF88"
                  : adaptColor(tabDragGhost.color, false),
                boxShadow: tabDragGhost.connected ? "0 0 6px #00FF88" : "none",
              }}
            />
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">
              {tabDragGhost.label}
            </span>
          </div>
        </div>
      )}

      {/* Tab context menu */}
      {tabContextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setTabContextMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabContextMenu(null);
          }}
        >
          <div
            className="absolute bg-hx-panel border border-hx-border rounded shadow-xl py-1 min-w-45"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Reconnect */}
            <button
              onClick={() => {
                connectPane(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
            >
              <RefreshCw size={12} />
              Reconnect
            </button>
            {/* Duplicate */}
            <button
              onClick={() => {
                const src = tabs.find((t) => t.tabId === tabContextMenu.tabId);
                if (src) {
                  const tab: TabPane = {
                    tabId: crypto.randomUUID(),
                    sessionEntry: src.sessionEntry,
                    sshSessionId: null,
                    connected: false,
                  };
                  setTabs((prev) => [...prev, tab]);
                  setActiveView(tab.tabId);
                  setAutoConnectTabId(tab.tabId);
                }
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
            >
              <Plus size={12} />
              Duplicate
            </button>
            {/* Detach */}
            <button
              onClick={() => {
                detachTab(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
            >
              <ExternalLink size={12} />
              Detach
            </button>
            <div className="border-t border-hx-border my-1" />
            {/* Split options */}
            {splitTabs[tabContextMenu.tabId] ? (
              <>
                <button
                  onClick={() => {
                    const current = splitTabs[tabContextMenu.tabId];
                    toggleSplitForTab(
                      tabContextMenu.tabId,
                      current === "horizontal" ? "vertical" : "horizontal",
                    );
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  {splitTabs[tabContextMenu.tabId] === "horizontal" ? (
                    <Columns2 size={12} />
                  ) : (
                    <Rows2 size={12} />
                  )}
                  {splitTabs[tabContextMenu.tabId] === "horizontal"
                    ? "Switch to Vertical"
                    : "Switch to Horizontal"}
                </button>
                <button
                  onClick={() => {
                    disconnectSplitPane(tabContextMenu.tabId);
                    toggleSplitForTab(tabContextMenu.tabId);
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  <X size={12} />
                  Close Split
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    toggleSplitForTab(tabContextMenu.tabId, "vertical");
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  <Columns2 size={12} />
                  Split Vertical
                </button>
                <button
                  onClick={() => {
                    toggleSplitForTab(tabContextMenu.tabId, "horizontal");
                    setTabContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-hx-text hover:bg-hx-neon/10 hover:text-hx-neon transition-colors flex items-center gap-2"
                >
                  <Rows2 size={12} />
                  Split Horizontal
                </button>
              </>
            )}
            <div className="border-t border-hx-border my-1" />
            {/* Close */}
            <button
              onClick={() => {
                closeTabById(tabContextMenu.tabId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-danger hover:bg-hx-danger/10 transition-colors flex items-center gap-2"
            >
              <X size={12} />
              Close
            </button>
            {/* Close All */}
            <button
              onClick={() => {
                setTabs([]);
                setSplitTabs({});
                if (openViews.has("overview")) setActiveView("overview");
                else if (openViews.has("settings")) setActiveView("settings");
                else setActiveView("");
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-danger hover:bg-hx-danger/10 transition-colors flex items-center gap-2"
            >
              <X size={12} />
              Close All
            </button>
            {/* Close Others */}
            <button
              onClick={() => {
                const keepId = tabContextMenu.tabId;
                setTabs((prev) => prev.filter((t) => t.tabId === keepId));
                setSplitTabs((prev) => {
                  const next: typeof prev = {};
                  if (prev[keepId]) next[keepId] = prev[keepId];
                  return next;
                });
                setActiveView(keepId);
                setTabContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-hx-danger hover:bg-hx-danger/10 transition-colors flex items-center gap-2"
            >
              <X size={12} />
              Close Others
            </button>
          </div>
        </div>
      )}

      {/* ── Main Content ─────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {showSettings ? (
          /* ── Settings Panel ──────────────────────────── */
          <div className="flex flex-1 overflow-hidden">
            {/* Left nav */}
            <div className="w-44 bg-hx-panel border-r border-hx-border flex flex-col gap-1 p-3 shrink-0">
              {(
                [
                  "sessions",
                  "credentials",
                  "tags",
                  "scripts",
                  "general",
                  "about",
                ] as const
              ).map((tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setSettingsTab(tab);
                    setSettingsSearch("");
                  }}
                  className={`text-left px-3 py-2 text-xs font-mono uppercase tracking-widest transition-colors rounded-sm ${
                    settingsTab === tab
                      ? "text-hx-neon bg-hx-neon/10"
                      : "text-hx-muted hover:text-hx-text hover:bg-hx-neon/5"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Right content */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Settings search */}
              <div className="mb-4">
                <input
                  type="text"
                  placeholder="Search settings..."
                  value={settingsSearch}
                  onChange={(e) => setSettingsSearch(e.target.value)}
                  className="hx-input bg-hx-bg border border-hx-border px-3 py-1.5 text-xs w-full font-mono"
                />
              </div>
              {/* ── Sessions tab ── */}
              {settingsTab === "sessions" && (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon">
                      Sessions
                    </h2>
                    <div className="flex items-center gap-2">
                      {importStatus && (
                        <span
                          className={`text-[10px] font-mono ${importStatus.startsWith("✓") ? "text-hx-success" : "text-hx-danger"}`}
                        >
                          {importStatus}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    {sessions.length === 0 && (
                      <p className="text-hx-dim text-xs font-mono">
                        No sessions saved.
                      </p>
                    )}
                    {sessions
                      .filter((s) => {
                        const q = settingsSearch.toLowerCase();
                        return (
                          !q ||
                          s.label.toLowerCase().includes(q) ||
                          s.host.toLowerCase().includes(q) ||
                          (s.user || "").toLowerCase().includes(q)
                        );
                      })
                      .map((s) => (
                        <div
                          key={s.id}
                          className={`flex items-center gap-3 p-3 bg-hx-panel border transition-colors cursor-pointer ${
                            editingSession?.id === s.id
                              ? "border-hx-neon/50"
                              : "border-hx-border hover:border-hx-border/80"
                          }`}
                          onClick={() => {
                            setEditForm({
                              label: s.label,
                              host: s.host,
                              port: s.port,
                              user: s.user,
                              pass: s.pass || "",
                              keyPath: s.keyPath || "",
                              group: s.group || "",
                              credentialId: s.credentialId || "",
                            });
                            setEditSelectedColor(s.color || NEON_COLORS[0]);
                            setEditingSession(s);
                          }}
                          onDoubleClick={() => {
                            openTab(s, true);
                          }}
                        >
                          <div
                            className="w-1.5 h-1.5 rotate-45 shrink-0"
                            style={{ background: s.color || "#00E5FF" }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono text-hx-text truncate">
                              {s.label}
                            </div>
                            <div className="text-[10px] text-hx-muted font-mono">
                              {s.user}@{s.host}:{s.port}
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openTab(s, true);
                            }}
                            className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                            title="Connect"
                          >
                            <Play size={11} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              saveSessions(
                                sessions.filter((x) => x.id !== s.id),
                              );
                              if (editingSession?.id === s.id)
                                setEditingSession(null);
                            }}
                            className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* ── Credentials tab ── */}
              {settingsTab === "credentials" && (
                <div>
                  <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
                    Credentials
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    {/* Form */}
                    <div className="bg-hx-panel border border-hx-border p-4 space-y-3">
                      <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                        {editingCred ? "Edit Credential" : "New Credential"}
                      </p>
                      {(
                        [
                          {
                            label: "Label",
                            key: "label",
                            placeholder: "production-root",
                            type: "text",
                          },
                          {
                            label: "Username",
                            key: "user",
                            placeholder: "root",
                            type: "text",
                          },
                          {
                            label: "Password",
                            key: "pass",
                            placeholder: "optional",
                            type: "password",
                          },
                          {
                            label: "Key Path",
                            key: "keyPath",
                            placeholder: "/home/.ssh/id_rsa",
                            type: "text",
                          },
                        ] as {
                          label: string;
                          key: keyof typeof credForm;
                          placeholder: string;
                          type: string;
                        }[]
                      ).map(({ label, key, placeholder, type }) => (
                        <div key={key}>
                          <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                            {label}
                          </label>
                          <input
                            type={type}
                            placeholder={placeholder}
                            value={String(credForm[key])}
                            onChange={(e) =>
                              setCredForm((f) => ({
                                ...f,
                                [key]: e.target.value,
                              }))
                            }
                            className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs"
                          />
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        {editingCred && (
                          <button
                            onClick={() => {
                              setEditingCred(null);
                              setCredForm({
                                label: "",
                                user: "root",
                                pass: "",
                                keyPath: "",
                              });
                            }}
                            className="flex-1 py-1.5 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={
                            editingCred ? updateCredential : addCredential
                          }
                          className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                          style={{
                            background:
                              "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                            border: "1px solid #00E5FF55",
                            color: "#00E5FF",
                          }}
                        >
                          {editingCred ? "◆ Update" : "◆ Add"}
                        </button>
                      </div>
                    </div>
                    {/* List */}
                    <div className="space-y-2">
                      {credentials.length === 0 && (
                        <p className="text-hx-dim text-xs font-mono">
                          No credentials saved.
                        </p>
                      )}
                      {credentials.map((c) => (
                        <div
                          key={c.id}
                          className="flex items-center gap-3 p-3 bg-hx-panel border border-hx-border"
                        >
                          <Key size={11} className="text-hx-neon/60 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono text-hx-text truncate">
                              {c.label}
                            </div>
                            <div className="text-[10px] text-hx-muted">
                              {c.user}
                              {c.keyPath ? " · key" : ""}
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              setEditingCred(c);
                              setCredForm({
                                label: c.label,
                                user: c.user,
                                pass: c.pass || "",
                                keyPath: c.keyPath || "",
                              });
                            }}
                            className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                          >
                            <Edit2 size={11} />
                          </button>
                          <button
                            onClick={() => removeCredential(c.id)}
                            className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Tags tab ── */}
              {settingsTab === "tags" && (
                <div>
                  <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
                    Tags
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-hx-panel border border-hx-border p-4 space-y-3">
                      <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                        {editingTag ? "Edit Tag" : "New Tag"}
                      </p>
                      <div>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                          Name
                        </label>
                        <input
                          type="text"
                          placeholder="production"
                          value={tagForm.name}
                          onChange={(e) =>
                            setTagForm((f) => ({ ...f, name: e.target.value }))
                          }
                          className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-2">
                          Color
                        </label>
                        <div className="flex gap-3">
                          {COLOR_PAIRS.map(
                            ({ dark: canonical, light: lightC }) => {
                              const c = darkMode ? canonical : lightC;
                              const isSelected = tagForm.color === canonical;
                              return (
                                <button
                                  key={canonical}
                                  onClick={() =>
                                    setTagForm((f) => ({
                                      ...f,
                                      color: canonical,
                                    }))
                                  }
                                  className="w-5 h-5 rotate-45 transition-all hover:scale-110"
                                  style={{
                                    background: c,
                                    boxShadow: isSelected
                                      ? `0 0 10px ${c}`
                                      : "none",
                                    outline: isSelected
                                      ? `2px solid ${c}`
                                      : "2px solid transparent",
                                    outlineOffset: "2px",
                                  }}
                                />
                              );
                            },
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        {editingTag && (
                          <button
                            onClick={() => {
                              setEditingTag(null);
                              setTagForm({ name: "", color: NEON_COLORS[0] });
                            }}
                            className="flex-1 py-1.5 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={editingTag ? updateTag : addTag}
                          className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                          style={{
                            background: `linear-gradient(135deg,${tagForm.color}22,${tagForm.color}0a)`,
                            border: `1px solid ${tagForm.color}55`,
                            color: tagForm.color,
                          }}
                        >
                          {editingTag ? "◆ Update" : "◆ Add"}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {tags.length === 0 && (
                        <p className="text-hx-dim text-xs font-mono">
                          No tags saved.
                        </p>
                      )}
                      {tags.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center gap-3 p-3 bg-hx-panel border border-hx-border"
                        >
                          <div
                            className="w-2 h-2 rotate-45 shrink-0"
                            style={{ background: t.color }}
                          />
                          <span className="flex-1 text-xs font-mono text-hx-text">
                            {t.name}
                          </span>
                          <button
                            onClick={() => {
                              setEditingTag(t);
                              setTagForm({ name: t.name, color: t.color });
                            }}
                            className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                          >
                            <Edit2 size={11} />
                          </button>
                          <button
                            onClick={() => removeTag(t.id)}
                            className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Scripts tab ── */}
              {settingsTab === "scripts" && (
                <div>
                  <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
                    Scripts
                  </h2>
                  <div className="space-y-4">
                    <div className="bg-hx-panel border border-hx-border p-4 space-y-3">
                      <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                        {editingScript ? "Edit Script" : "New Script"}
                      </p>
                      <div>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                          Name
                        </label>
                        <input
                          type="text"
                          placeholder="update-system"
                          value={scriptForm.name}
                          onChange={(e) =>
                            setScriptForm((f) => ({
                              ...f,
                              name: e.target.value,
                            }))
                          }
                          className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/50 mb-1">
                          Commands
                        </label>
                        <textarea
                          placeholder={
                            "apt update && apt upgrade -y\nsystemctl restart nginx"
                          }
                          value={scriptForm.content}
                          onChange={(e) =>
                            setScriptForm((f) => ({
                              ...f,
                              content: e.target.value,
                            }))
                          }
                          rows={5}
                          className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono resize-y"
                        />
                      </div>
                      <div className="flex gap-2">
                        {editingScript && (
                          <button
                            onClick={() => {
                              setEditingScript(null);
                              setScriptForm({ name: "", content: "" });
                            }}
                            className="flex-1 py-1.5 text-[10px] uppercase tracking-widest text-hx-muted border border-hx-border hover:text-hx-text transition-colors hx-clip-btn"
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={editingScript ? updateScript : addScript}
                          className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest hx-clip-btn transition-all"
                          style={{
                            background:
                              "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                            border: "1px solid #00E5FF55",
                            color: "#00E5FF",
                          }}
                        >
                          {editingScript ? "◆ Update" : "◆ Add"}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {scripts.length === 0 && (
                        <p className="text-hx-dim text-xs font-mono">
                          No scripts saved.
                        </p>
                      )}
                      {scripts.map((s) => (
                        <div
                          key={s.id}
                          className="p-3 bg-hx-panel border border-hx-border"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-mono font-bold text-hx-neon">
                              {s.name}
                            </span>
                            <div className="flex gap-1">
                              <button
                                onClick={() => {
                                  setEditingScript(s);
                                  setScriptForm({
                                    name: s.name,
                                    content: s.content,
                                  });
                                }}
                                className="p-1 text-hx-dim hover:text-hx-neon transition-colors"
                              >
                                <Edit2 size={11} />
                              </button>
                              <button
                                onClick={() => removeScript(s.id)}
                                className="p-1 text-hx-dim hover:text-hx-danger transition-colors"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </div>
                          <pre className="text-[10px] text-hx-muted font-mono whitespace-pre-wrap line-clamp-3">
                            {s.content}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── General tab ── */}
              {settingsTab === "general" && (
                <div>
                  <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
                    General Settings
                  </h2>
                  <div className="bg-hx-panel border border-hx-border p-5 space-y-4 max-w-md">
                    <div>
                      <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                        Log Folder Path
                      </label>
                      <input
                        type="text"
                        placeholder="/var/log/atlas"
                        value={generalSettings.logPath}
                        onChange={(e) =>
                          saveGeneral({
                            ...generalSettings,
                            logPath: e.target.value,
                          })
                        }
                        className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                        Terminal Font Size
                      </label>
                      <input
                        type="number"
                        min={8}
                        max={24}
                        value={generalSettings.fontSize}
                        onChange={(e) =>
                          saveGeneral({
                            ...generalSettings,
                            fontSize: Number(e.target.value),
                          })
                        }
                        className="hx-input w-24 bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1.5">
                        Terminal Font Family
                      </label>
                      <input
                        type="text"
                        placeholder="'Fira Code', Consolas, monospace"
                        value={generalSettings.fontFamily}
                        onChange={(e) =>
                          saveGeneral({
                            ...generalSettings,
                            fontFamily: e.target.value,
                          })
                        }
                        className="hx-input w-full bg-hx-bg border border-hx-border px-3 py-2 text-xs font-mono"
                      />
                    </div>
                    <p className="text-[10px] text-hx-dim font-mono">
                      Font settings apply to new terminal sessions.
                    </p>
                    {/* Theme picker */}
                    <div className="pt-2 border-t border-hx-border space-y-2">
                      <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                        Theme
                      </label>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {THEMES.map((t) => {
                          const isActive =
                            (generalSettings.theme ?? "light") === t.id;
                          return (
                            <button
                              key={t.id}
                              onClick={() =>
                                saveGeneral({
                                  ...generalSettings,
                                  theme: t.id,
                                })
                              }
                              className={`flex flex-col items-start gap-1 px-3 py-2.5 border transition-all text-left hx-clip-btn ${
                                isActive
                                  ? "border-hx-neon/70 bg-hx-neon/10"
                                  : "border-hx-border hover:border-hx-neon/40 hover:bg-hx-neon/5"
                              }`}
                            >
                              {/* Mini palette preview */}
                              <div className="flex gap-1 mb-0.5">
                                {[
                                  t.vars["--color-hx-bg"],
                                  t.vars["--color-hx-panel"],
                                  t.vars["--color-hx-neon"],
                                ].map((c, i) => (
                                  <span
                                    key={i}
                                    className="w-3 h-3 rounded-sm border border-white/10"
                                    style={{ background: c }}
                                  />
                                ))}
                              </div>
                              <span
                                className={`text-[10px] font-bold uppercase tracking-widest ${isActive ? "text-hx-neon" : "text-hx-text"}`}
                              >
                                {t.label}
                              </span>
                              <span className="text-[9px] text-hx-dim font-mono">
                                {t.description}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {/* Import / Export */}
                    <div className="pt-3 border-t border-hx-border space-y-2">
                      <p className="text-[10px] font-mono uppercase tracking-widest text-hx-neon/60">
                        Data Backup
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={exportSettings}
                          className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn flex items-center justify-center gap-1.5 transition-all"
                          style={{
                            background:
                              "linear-gradient(135deg,#00E5FF22,#00E5FF0a)",
                            border: "1px solid #00E5FF55",
                            color: "#00E5FF",
                          }}
                        >
                          <Download size={10} />
                          Export
                        </button>
                        <label
                          className="flex-1 py-2 text-[10px] font-bold uppercase tracking-widest hx-clip-btn flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                          style={{
                            background:
                              "linear-gradient(135deg,#BD00FF22,#BD00FF0a)",
                            border: "1px solid #BD00FF55",
                            color: "#BD00FF",
                          }}
                        >
                          <FolderOpen size={10} />
                          Import
                          <input
                            type="file"
                            accept=".json"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) importSettings(file);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </div>
                      {importStatus && (
                        <p
                          className={`text-[10px] font-mono ${importStatus.startsWith("✓") ? "text-hx-success" : "text-hx-danger"}`}
                        >
                          {importStatus}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── About tab ── */}
              {settingsTab === "about" && (
                <div>
                  <h2 className="text-xs font-black uppercase tracking-[0.2em] text-hx-neon mb-4">
                    About
                  </h2>
                  <div className="bg-hx-panel border border-hx-border p-6 space-y-5 max-w-md">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-3 h-3 rotate-45 bg-hx-neon shrink-0"
                        style={{ boxShadow: "0 0 12px #00E5FF" }}
                      />
                      <span className="text-lg font-black tracking-[0.25em] uppercase text-hx-neon">
                        Atlas
                      </span>
                      <span className="text-xs text-hx-dim font-mono bg-hx-bg border border-hx-border px-2 py-0.5 rounded">
                        v0.1.0
                      </span>
                    </div>
                    <p className="text-xs text-hx-muted font-mono leading-relaxed">
                      A modern SSH client built with Tauri, React, and Rust.
                      Supports multi-tab sessions, split terminal views, SFTP
                      uploads, quick commands, and Solar PuTTY import.
                    </p>
                    <div className="border-t border-hx-border pt-4 space-y-2 text-[10px] font-mono">
                      {[
                        ["Framework", "Tauri v1 + React 18"],
                        ["Language", "TypeScript + Rust"],
                        ["Terminal", "xterm.js"],
                        ["Protocol", "SSHv2 (libssh2)"],
                        ["Platform", "Windows x64"],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="flex justify-between border-b border-hx-border/50 pb-1"
                        >
                          <span className="text-hx-dim">{label}</span>
                          <span className="text-hx-muted">{value}</span>
                        </div>
                      ))}
                    </div>
                    <div className="border-t border-hx-border pt-4 mt-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono text-hx-dim">
                          Made by
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            shellOpen("https://github.com/aleynatila");
                          }}
                          className="text-[10px] font-mono text-hx-neon hover:underline cursor-pointer"
                        >
                          Aleyna Atila
                        </button>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] font-mono text-hx-dim">
                          GitHub
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            shellOpen("https://github.com/aleynatila");
                          }}
                          className="text-[10px] font-mono text-hx-muted hover:text-hx-neon hover:underline transition-colors cursor-pointer"
                        >
                          github.com/aleynatila
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Info size={11} className="text-hx-dim" />
                      <span className="text-[10px] text-hx-dim font-mono">
                        Settings stored in browser localStorage per origin. Use
                        Export/Import (General) to transfer data between dev and
                        production builds.
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* ── Edit Sidebar (settings page) ── */}
            {editingSession && settingsTab === "sessions" && (
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
                  {credentials.length > 0 && (
                    <div>
                      <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
                        Credential
                      </label>
                      <select
                        value={editForm.credentialId}
                        onChange={(e) => {
                          const cred = credentials.find(
                            (c) => c.id === e.target.value,
                          );
                          setEditForm((f) => ({
                            ...f,
                            credentialId: e.target.value,
                            user: cred ? cred.user : f.user,
                            pass: cred ? cred.pass || "" : f.pass,
                            keyPath: cred ? cred.keyPath || "" : f.keyPath,
                          }));
                        }}
                        className="hx-input w-full bg-hx-bg border border-hx-border px-2 py-1.5 text-xs font-mono"
                      >
                        <option value="">— none —</option>
                        {credentials.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label} ({c.user})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {(
                    [
                      {
                        label: "Session Name",
                        key: "label",
                        placeholder: "My Server",
                        type: "text",
                      },
                      {
                        label: "Host / IP",
                        key: "host",
                        placeholder: "192.168.1.1",
                        type: "text",
                      },
                      {
                        label: "Port",
                        key: "port",
                        placeholder: "22",
                        type: "text",
                      },
                      {
                        label: "Username",
                        key: "user",
                        placeholder: "root",
                        type: "text",
                      },
                      {
                        label: "Group",
                        key: "group",
                        placeholder: "production",
                        type: "text",
                      },
                      {
                        label: "Key Path",
                        key: "keyPath",
                        placeholder: "/home/.ssh/id_rsa",
                        type: "text",
                      },
                      {
                        label: "Password",
                        key: "pass",
                        placeholder: "optional",
                        type: "password",
                      },
                    ] as {
                      label: string;
                      key: keyof typeof editForm;
                      placeholder: string;
                      type: string;
                    }[]
                  ).map(({ label, key, placeholder, type }) => (
                    <div key={key}>
                      <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
                        {label}
                      </label>
                      <input
                        type={type}
                        placeholder={placeholder}
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
            )}
          </div>
        ) : isNewSession ? (
          /* ── New Session tab ─────────────────────────── */
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
                {(
                  [
                    {
                      label: "Session Name",
                      key: "label",
                      placeholder: "My Server",
                      type: "text",
                    },
                    {
                      label: "Host / IP",
                      key: "host",
                      placeholder: "192.168.1.1",
                      type: "text",
                    },
                    {
                      label: "Port",
                      key: "port",
                      placeholder: "22",
                      type: "text",
                    },
                    {
                      label: "Username",
                      key: "user",
                      placeholder: "root",
                      type: "text",
                    },
                    {
                      label: "Group (optional)",
                      key: "group",
                      placeholder: "production",
                      type: "text",
                    },
                    {
                      label: "Private Key Path (optional)",
                      key: "keyPath",
                      placeholder: "/home/user/.ssh/id_rsa",
                      type: "text",
                    },
                    {
                      label: "Password (optional)",
                      key: "pass",
                      placeholder: "Leave blank to enter later",
                      type: "password",
                    },
                  ] as {
                    label: string;
                    key: keyof typeof form;
                    placeholder: string;
                    type: string;
                  }[]
                ).map(({ label, key, placeholder, type }) => (
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
        ) : (
          /* ── Overview + Terminal (both always mounted, toggled via visibility) ── */
          <div className="relative flex-1 overflow-hidden">
            {/* ── Overview: hex-grid ──────────────────────── */}
            <div
              className={`absolute inset-0 flex overflow-hidden ${isOverview ? "" : "invisible"}`}
            >
              {/* Main content */}
              <div
                className="flex-1 overflow-y-auto p-6"
                style={{
                  scrollbarWidth: "thin",
                  scrollbarColor: "var(--color-hx-border) transparent",
                }}
              >
                {/* Header */}
                <div className="flex flex-col gap-3 mb-5">
                  <div className="flex items-end justify-between">
                    <div>
                      <h1
                        className="text-base font-black tracking-[0.2em] uppercase text-hx-neon"
                        style={{ textShadow: "0 0 20px #00E5FF44" }}
                      >
                        ◆ Overview
                      </h1>
                      <p className="text-[11px] text-hx-muted mt-1 font-mono">
                        {sessions.length} saved · {connectedCount} connected
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {importStatus && (
                        <span
                          className={`text-[10px] font-mono ${importStatus.startsWith("✓") ? "text-hx-success" : "text-hx-danger"}`}
                        >
                          {importStatus}
                        </span>
                      )}
                      <button
                        onClick={() => openView("new-session")}
                        className="hx-clip-btn flex items-center gap-2 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-hx-neon border border-hx-neon/40 hover:border-hx-neon/80 hover:bg-hx-neon/10 transition-all"
                        style={{ boxShadow: "0 0 12px rgba(0,229,255,0.08)" }}
                      >
                        <Plus size={12} />
                        New Session
                      </button>
                    </div>
                  </div>
                  <input
                    type="text"
                    placeholder="Search sessions..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="hx-input bg-hx-bg border border-hx-border px-3 py-1.5 text-xs w-full font-mono"
                  />
                </div>

                {/* Empty state */}
                {sessions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-56 gap-5">
                    <div className="relative">
                      <div
                        className="w-16 h-16 border border-hx-neon/25 rotate-45 flex items-center justify-center"
                        style={{ boxShadow: "0 0 20px rgba(0,229,255,0.05)" }}
                      >
                        <Server size={20} className="text-hx-dim -rotate-45" />
                      </div>
                      <div className="absolute -inset-3 border border-hx-neon/10 rotate-45" />
                    </div>
                    <p className="text-hx-muted text-sm">Kayıtlı oturum yok</p>
                    <button
                      onClick={() => openView("new-session")}
                      className="text-xs text-hx-neon hover:underline font-mono tracking-wider"
                    >
                      + İlk oturumu oluştur
                    </button>
                  </div>
                ) : (
                  /* Session card grid */
                  <OverviewCardGrid
                    overviewSessions={overviewSessions}
                    connectedTabsBySessionId={connectedTabsBySessionId}
                    onOpenTab={openTab}
                    onEditSession={handleEditSession}
                    onRemoveSession={removeSession}
                    credentials={credentials}
                    darkMode={darkMode}
                  />
                )}
              </div>

              {/* ── Edit Sidebar ── */}
              {editingSession && (
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
                    {credentials.length > 0 && (
                      <div>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
                          Credential
                        </label>
                        <select
                          value={editForm.credentialId}
                          onChange={(e) => {
                            const cred = credentials.find(
                              (c) => c.id === e.target.value,
                            );
                            setEditForm((f) => ({
                              ...f,
                              credentialId: e.target.value,
                              user: cred ? cred.user : f.user,
                              pass: cred ? cred.pass || "" : f.pass,
                              keyPath: cred ? cred.keyPath || "" : f.keyPath,
                            }));
                          }}
                          className="hx-input w-full bg-hx-bg border border-hx-border px-2 py-1.5 text-xs font-mono"
                        >
                          <option value="">— none —</option>
                          {credentials.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label} ({c.user})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {(
                      [
                        {
                          label: "Session Name",
                          key: "label",
                          placeholder: "My Server",
                          type: "text",
                        },
                        {
                          label: "Host / IP",
                          key: "host",
                          placeholder: "192.168.1.1",
                          type: "text",
                        },
                        {
                          label: "Port",
                          key: "port",
                          placeholder: "22",
                          type: "text",
                        },
                        {
                          label: "Username",
                          key: "user",
                          placeholder: "root",
                          type: "text",
                        },
                        {
                          label: "Group",
                          key: "group",
                          placeholder: "production",
                          type: "text",
                        },
                        {
                          label: "Key Path",
                          key: "keyPath",
                          placeholder: "/home/.ssh/id_rsa",
                          type: "text",
                        },
                        {
                          label: "Password",
                          key: "pass",
                          placeholder: "optional",
                          type: "password",
                        },
                      ] as {
                        label: string;
                        key: keyof typeof editForm;
                        placeholder: string;
                        type: string;
                      }[]
                    ).map(({ label, key, placeholder, type }) => (
                      <div key={key}>
                        <label className="block text-[10px] font-mono uppercase tracking-widest text-hx-neon/60 mb-1">
                          {label}
                        </label>
                        <input
                          type={type}
                          placeholder={placeholder}
                          value={String(editForm[key])}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              [key]: e.target.value,
                            }))
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
                        {COLOR_PAIRS.map(
                          ({ dark: canonical, light: lightC }) => {
                            const c = darkMode ? canonical : lightC;
                            const isSelected = editSelectedColor === canonical;
                            return (
                              <button
                                key={canonical}
                                onClick={() => setEditSelectedColor(canonical)}
                                className="w-5 h-5 rotate-45 transition-all hover:scale-110"
                                style={{
                                  background: c,
                                  boxShadow: isSelected
                                    ? `0 0 10px ${c}`
                                    : "none",
                                  outline: isSelected
                                    ? `2px solid ${c}`
                                    : "2px solid transparent",
                                  outlineOffset: "2px",
                                }}
                              />
                            );
                          },
                        )}
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
              )}
            </div>
            {/* ── Terminal view ──────────────────────────── */}
            <div
              className={`absolute inset-0 flex flex-col overflow-hidden ${isOverview ? "invisible" : ""}`}
            >
              {/* Terminal pane(s) + quick commands */}
              <div
                style={{
                  flex: "1 1 0",
                  minHeight: 0,
                  minWidth: 0,
                  overflow: "hidden",
                  display: "grid",
                  gap: activeSplit ? "4px" : "0",
                  gridTemplateRows:
                    activeSplit === "horizontal" ? "1fr 1fr" : "1fr",
                  gridTemplateColumns:
                    activeSplit === "vertical" ? "1fr 1fr" : "1fr",
                }}
              >
                <div
                  style={{ overflow: "hidden", minHeight: 0, minWidth: 0 }}
                  className={
                    activeSplit === "horizontal"
                      ? "border-b border-hx-border flex flex-col"
                      : activeSplit === "vertical"
                        ? "border-r border-hx-border flex flex-col"
                        : "flex flex-col"
                  }
                >
                  {tabs.map((tab) => (
                    <div
                      key={tab.tabId}
                      style={{
                        display: activeView === tab.tabId ? "flex" : "none",
                        flex: "1 1 0",
                        minHeight: 0,
                        flexDirection: "column",
                        overflow: "hidden",
                      }}
                    >
                      <TerminalPane
                        pane={tab}
                        password={tabPasswords[tab.tabId] ?? ""}
                        onConnected={handleConnected}
                        onDisconnected={handleDisconnected}
                        visible={activeView === tab.tabId}
                        paneRef={getStablePaneRef(tab.tabId)}
                        autoConnect={autoConnectTabId === tab.tabId}
                        onCwdChange={() => {}}
                      />
                    </div>
                  ))}
                </div>

                {activeTab && activeSplit && (
                  <div
                    key={`split-${activeTab.tabId}`}
                    style={{ overflow: "hidden", minHeight: 0, minWidth: 0 }}
                    className="flex flex-col"
                  >
                    <div
                      style={{
                        flex: "1 1 0",
                        minHeight: 0,
                        overflow: "hidden",
                      }}
                    >
                      <TerminalPane
                        pane={{
                          ...activeTab,
                          tabId: `split-${activeTab.tabId}`,
                          sshSessionId: null,
                          connected: false,
                        }}
                        password={tabPasswords[activeTab.tabId] ?? ""}
                        onConnected={handleConnected}
                        onDisconnected={handleDisconnected}
                        visible={!!activeSplit}
                        paneRef={getStablePaneRef(`split-${activeTab.tabId}`)}
                        autoConnect
                        onCwdChange={() => {}}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Quick Commands bar — shrink-0 ensures terminal gets all space except this bar */}
              {activeTab && (
                <div
                  className="flex items-center gap-1.5 px-3 py-1 border-t border-hx-border shrink-0 overflow-x-auto select-none"
                  style={{ background: "#080A12" }}
                >
                  <span className="text-[10px] text-hx-dim tracking-widest uppercase mr-1 shrink-0">
                    CMD
                  </span>
                  {scripts.map((sc) => (
                    <button
                      key={sc.id}
                      onClick={() => {
                        if (activeTab.sshSessionId) {
                          invoke("send_ssh_input", {
                            sessionId: activeTab.sshSessionId,
                            input: sc.content.endsWith("\n")
                              ? sc.content
                              : sc.content + "\n",
                          }).catch(() => {});
                          setTimeout(
                            () =>
                              paneRefs.current[activeTab.tabId] &&
                              (
                                paneRefs.current[
                                  activeTab.tabId
                                ] as HTMLDivElement & {
                                  __term?: { focus: () => void };
                                }
                              ).__term?.focus?.(),
                            50,
                          );
                        }
                      }}
                      title={sc.content}
                      className="px-2 py-0.5 text-[11px] font-mono bg-hx-neon/10 text-hx-neon border border-hx-neon/20 rounded hover:bg-hx-neon/25 transition-colors whitespace-nowrap shrink-0"
                    >
                      {sc.name}
                    </button>
                  ))}
                  {scripts.length === 0 && (
                    <span className="text-[10px] text-hx-dim font-mono italic">
                      No quick commands — add them in Settings → Scripts
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Status Bar ───────────────────────────────────── */}
      <div
        className="flex items-center gap-4 px-4 py-1 border-t border-hx-border text-[10px] text-hx-dim shrink-0 font-mono select-none"
        style={{ background: "#080A12" }}
      >
        {activeTab?.connected ? (
          <>
            <span
              className="flex items-center gap-1.5"
              style={{ color: "#00FF88" }}
            >
              <div
                className="w-1.5 h-1.5 rotate-45 bg-current"
                style={{ boxShadow: "0 0 4px #00FF88" }}
              />
              CONNECTED
            </span>
            <span>
              {activeTab.sessionEntry.user}@{activeTab.sessionEntry.host}
            </span>
            <span>
              {activeTab.sessionEntry.keyPath ? "KEY AUTH" : "PASS AUTH"}
            </span>
            <span>UTF-8</span>
          </>
        ) : isOverview ? (
          <span>◆ {sessions.length} sessions</span>
        ) : (
          <span>NOT CONNECTED</span>
        )}
        <div className="flex-1" />
        <span
          className="flex items-center gap-1.5"
          style={{ color: "#00E5FF66" }}
        >
          <span
            className="w-1.5 h-1.5 rotate-45 inline-block"
            style={{ background: "#00E5FF", boxShadow: "0 0 6px #00E5FF" }}
          />
          <span
            className="font-black tracking-[0.2em] text-xs uppercase"
            style={{ textShadow: "0 0 10px #00E5FF55" }}
          >
            Atlas
          </span>
          <span
            className="text-[9px] font-mono ml-1.5"
            style={{ color: "#00E5FF99" }}
          >
            by Aleyna Atila
          </span>
        </span>
      </div>
    </div>
  );
}

export default App;
