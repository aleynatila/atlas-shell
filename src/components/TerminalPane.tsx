import {
    readText as clipboardRead,
    writeText as clipboardWrite,
} from "@tauri-apps/api/clipboard";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/tauri";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import "xterm/css/xterm.css";
import { TERMINAL_THEME } from "../themes";
import type { SshOutputPayload, TabPane, TransferMap } from "../types";
import { SftpToast } from "./SftpToast";

interface TerminalPaneProps {
  pane: TabPane;
  password: string;
  onConnected: (tabId: string, sshId: string) => void;
  onDisconnected: (tabId: string) => void;
  visible: boolean;
  paneRef?: (el: HTMLDivElement | null) => void;
  autoConnect?: boolean;
  fontSize?: number;
  fontFamily?: string;
}

export const TerminalPane = memo(function TerminalPane({
  pane,
  password,
  onConnected,
  onDisconnected,
  visible,
  paneRef,
  autoConnect,
  fontSize,
  fontFamily,
}: TerminalPaneProps) {
  const promptRef = useRef<{
    stage: "user" | "pass";
    user: string;
    pass: string;
  } | null>(null);
  const connectCredsRef = useRef<
    ((user?: string, pass?: string) => void) | null
  >(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const sshIdRef = useRef<string | null>(pane.sshSessionId);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const [dragOver, setDragOver] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sftpFiles, setSftpFiles] = useState<string[]>([]);
  const [sftpRemoteDir, setSftpRemoteDir] = useState("~");
  const [sftpTransfers, setSftpTransfers] = useState<TransferMap>({});
  const [currentCwd, setCurrentCwd] = useState("~");
  const currentCwdRef = useRef("~");
  const pwdResponseRef = useRef<string>("");
  const waitingForPwdRef = useRef(false);

  useEffect(() => {
    currentCwdRef.current = currentCwd;
  }, [currentCwd]);

  // Listen to Tauri file-drop events only when this pane is visible
  useEffect(() => {
    if (!visible) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    Promise.all([
      listen("tauri://file-drop", (e) => {
        setDragOver(false);
        const paths = e.payload as string[];
        if (paths && paths.length > 0) {
          const sid = sshIdRef.current;
          if (sid) {
            waitingForPwdRef.current = true;
            pwdResponseRef.current = "";
            invoke("send_ssh_input", { sessionId: sid, input: "pwd\n" });
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
      }),
      listen("tauri://file-drop-hover", () => {
        if ((window as any).__tabDragging) return;
        setDragOver(true);
      }),
      listen("tauri://file-drop-cancelled", () => setDragOver(false)),
    ]).then((fns) => {
      if (mounted) {
        unlisteners.push(...fns);
      } else {
        fns.forEach((u) => u());
      }
    });

    return () => {
      mounted = false;
      unlisteners.forEach((u) => u());
    };
  }, [visible]);

  // Listen to sftp-progress events
  useEffect(() => {
    if (!visible) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;

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
      if (mounted) unlisteners.push(u);
      else u();
    });

    return () => {
      mounted = false;
      unlisteners.forEach((u) => u());
    };
  }, [visible]);

  function startSftpUpload() {
    const transfers: TransferMap = {};
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
      // Bold text uses bright color variants — ls executables (01;32) use brightGreen
      // instead of the darker base green, maintaining readability everywhere.
      drawBoldTextInBrightColors: true,
      theme: TERMINAL_THEME,
      fontFamily:
        fontFamily || "'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: fontSize || 15,
      lineHeight: 1.4,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // GPU-accelerated rendering via WebGL, fall back to canvas
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglRef.current = null;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
    } catch (_) {
      // WebGL not available — canvas renderer is used automatically
      webglRef.current = null;
    }

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

    const showCopiedMessage = () => {
      const msg = "\x1b[2m[copied]\x1b[0m ";
      const visibleLen = "[copied] ".length;
      term.write(msg);
      setTimeout(() => {
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

    const onSelection = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel) return;
      clipboardWrite(sel).catch(() => {
        navigator.clipboard?.writeText(sel).catch(() => {});
      });
    });

    const onData = term.onData((data: string) => {
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
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (!visibleRef.current) return; // skip resize work for hidden panes
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
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
      }, 80);
    };
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

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
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
      setCurrentCwd("~");
      setConnecting(true);
      try {
        fitRef.current?.fit();
      } catch (_) {}
      term.clear();
      const connectUser = overrideUser || pane.sessionEntry.user;
      const connectPass =
        overridePass || pane.sessionEntry.pass || password || "";
      term.write(
        `\x1b[36m◆ Connecting: ${connectUser}@${pane.sessionEntry.host}:${pane.sessionEntry.port}...\x1b[0m\r\n`,
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
          setConnecting(false);
          onConnected(pane.tabId, sshId);
          listen(`ssh-output-${sshId}`, (event) => {
            const payload = event.payload as SshOutputPayload;
            if (waitingForPwdRef.current) {
              pwdResponseRef.current += payload.output;
              const lines = pwdResponseRef.current.split(/[\r\n]+/);
              for (const line of lines) {
                const trimmed = line.trim();
                if (
                  (trimmed.startsWith("/") || trimmed.startsWith("~")) &&
                  trimmed.length > 0 &&
                  !trimmed.includes("$") &&
                  !trimmed.includes("#") &&
                  !trimmed.includes(">") &&
                  !trimmed.includes("%") &&
                  !trimmed.startsWith("pwd")
                ) {
                  currentCwdRef.current = trimmed;
                  setCurrentCwd(trimmed);
                  waitingForPwdRef.current = false;
                  pwdResponseRef.current = "";
                  break;
                }
              }
            } else {
              term.write(payload.output);
            }
          }).then((u) => {
            unlistenRef.current = u;
          });
        })
        .catch((err) => {
          setConnecting(false);
          term.write(`\r\n\x1b[31m✖ Error: ${String(err)}\x1b[0m\r\n`);
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

  // Apply font size/family changes to active terminal immediately
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let changed = false;
    if (fontSize && term.options.fontSize !== fontSize) {
      term.options.fontSize = fontSize;
      changed = true;
    }
    if (fontFamily && term.options.fontFamily !== fontFamily) {
      term.options.fontFamily = fontFamily;
      changed = true;
    }
    if (changed) {
      try {
        // Clear the WebGL texture atlas so it is rebuilt with the new font metrics.
        // Without this, the cached glyph bitmaps stay at the old size and the
        // terminal looks garbled after a font size change.
        const wgl = webglRef.current as any;
        if (wgl) {
          wgl.clearTextureAtlas?.();
        }
        // fit() recalculates cols/rows based on new cell dimensions and issues
        // a proper resize — this must come before refresh().
        fitRef.current?.fit();
        term.refresh(0, term.rows - 1);
      } catch (_) {}
    }
  }, [fontSize, fontFamily]);

  const activeTransfers = useMemo(
    () => Object.entries(sftpTransfers).filter(([, v]) => !v.done || v.error),
    [sftpTransfers],
  );
  const doneTransfers = useMemo(
    () => Object.entries(sftpTransfers).filter(([, v]) => v.done && !v.error),
    [sftpTransfers],
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
        background: "#0b0f14",
        display: visible ? "flex" : "none",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        ref={containerRef}
        className="hx-scanlines"
        style={{
          flex: "1 1 0",
          minHeight: 0,
          width: "100%",
          overflow: "hidden",
          background: "#0b0f14",
          cursor: "text",
        }}
        tabIndex={-1}
        onMouseDown={() => termRef.current?.focus()}
        onClick={() => termRef.current?.focus()}
      />

      {/* Connecting indicator */}
      {connecting && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-2 bg-hx-panel/90 border border-hx-neon/30 rounded-full px-3 py-1.5 shadow-lg">
          <div className="w-2 h-2 rounded-full bg-hx-neon animate-pulse" />
          <span className="text-[10px] font-mono text-hx-neon tracking-widest uppercase">
            Connecting...
          </span>
        </div>
      )}

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
              const n: TransferMap = {};
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
