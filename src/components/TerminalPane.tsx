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
  disableAlternateScreen?: boolean;
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
  disableAlternateScreen,
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
  // Set to true when WebGL context is lost so we can attempt recovery on next visible
  const webglLostRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const sshIdRef = useRef<string | null>(pane.sshSessionId);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Tracks whether a font update is pending for when this pane becomes visible
  const pendingFontUpdateRef = useRef(false);
  const disableAlternateScreenRef = useRef(disableAlternateScreen ?? false);
  disableAlternateScreenRef.current = disableAlternateScreen ?? false;
  const escapeSequenceRemainderRef = useRef("");

  const [dragOver, setDragOver] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sftpFiles, setSftpFiles] = useState<string[]>([]);
  const [sftpRemoteDir, setSftpRemoteDir] = useState("~");
  const [sftpTransfers, setSftpTransfers] = useState<TransferMap>({});
  const [currentCwd, setCurrentCwd] = useState("~");
  const currentCwdRef = useRef("~");
  const pwdResponseRef = useRef<string>("");
  const waitingForPwdRef = useRef(false);
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_IPC__?: unknown }).__TAURI_IPC__ === "function";

  function invokeSafe<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) {
    if (!isTauriRuntime) {
      return Promise.resolve(undefined as T | undefined);
    }
    return invoke<T>(command, args);
  }

  function listenSafe(
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime) {
      return Promise.resolve(() => {});
    }
    return listen(event, handler as Parameters<typeof listen>[1]);
  }

  function debugLog(message: string) {
    const line = `[TerminalPane] ${pane.tabId}: ${message}`;
    console.log(line);
    invokeSafe("debug_log", { message: line }).catch(() => {});
  }

  function warnLog(message: string, err?: unknown) {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : err
          ? String(err)
          : "";
    const line = detail
      ? `[TerminalPane] ${pane.tabId}: ${message} | ${detail}`
      : `[TerminalPane] ${pane.tabId}: ${message}`;
    console.warn(line, err);
    invokeSafe("debug_log", { message: line }).catch(() => {});
  }

  function getWheelScrollLines(event: WheelEvent, rows: number) {
    if (event.deltaY === 0 || event.shiftKey) return 0;

    const delta = Math.abs(event.deltaY);
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return Math.max(1, rows);
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return Math.max(1, Math.round(delta));
    }

    return Math.max(1, Math.round(delta / 16));
  }

  function shouldBlockAlternateScreen(
    params: Array<number | number[]>,
    action: "enter" | "exit",
  ) {
    if (!disableAlternateScreenRef.current) return false;

    const values = params.filter(
      (value): value is number => typeof value === "number",
    );
    const block = values.some((value) => [47, 1047, 1049].includes(value));

    if (block) {
      debugLog(
        `blocked alternate-screen ${action} sequence: ${values.join(";")}`,
      );
    }

    return block;
  }

  function stripAlternateScreenSequences(chunk: string) {
    if (!disableAlternateScreenRef.current) return chunk;

    const combined = `${escapeSequenceRemainderRef.current}${chunk}`;
    let remainder = "";

    const tailMatch = combined.match(/\x1b\[\??[0-9;]*$/);
    const complete = tailMatch ? combined.slice(0, tailMatch.index) : combined;

    if (tailMatch) {
      remainder = tailMatch[0];
    }

    const sanitized = complete.replace(
      /\x1b\[\?([0-9;]+)([hl])/g,
      (sequence, params: string) => {
        const values = params
          .split(";")
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value));

        return values.some((value) => [47, 1047, 1048, 1049].includes(value))
          ? ""
          : sequence;
      },
    );

    escapeSequenceRemainderRef.current = remainder;
    return sanitized;
  }

  useEffect(() => {
    currentCwdRef.current = currentCwd;
  }, [currentCwd]);

  // Listen to Tauri file-drop events only when this pane is visible
  useEffect(() => {
    if (!visible || !isTauriRuntime) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    Promise.all([
      listenSafe("tauri://file-drop", (e) => {
        setDragOver(false);
        const paths = e.payload as string[];
        if (paths && paths.length > 0) {
          const sid = sshIdRef.current;
          if (sid) {
            waitingForPwdRef.current = true;
            pwdResponseRef.current = "";
            invokeSafe("send_ssh_input", { sessionId: sid, input: "pwd\n" });
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
      listenSafe("tauri://file-drop-hover", () => {
        if ((window as any).__tabDragging) return;
        setDragOver(true);
      }),
      listenSafe("tauri://file-drop-cancelled", () => setDragOver(false)),
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
  }, [isTauriRuntime, visible]);

  // Listen to sftp-progress events
  useEffect(() => {
    if (!visible || !isTauriRuntime) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    listenSafe("sftp-progress", (e) => {
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
  }, [isTauriRuntime, visible]);

  function startSftpUpload() {
    const transfers: TransferMap = {};
    sftpFiles.forEach((fp) => {
      const id = crypto.randomUUID();
      const name = fp.split(/[\\/]/).pop() || fp;
      transfers[id] = { name, progress: 0, done: false };
      invokeSafe("upload_file_sftp", {
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
    const parserDisposables = [
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) =>
        shouldBlockAlternateScreen(params, "enter"),
      ),
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) =>
        shouldBlockAlternateScreen(params, "exit"),
      ),
    ];
    const onBufferChange = term.buffer.onBufferChange(() => {
      debugLog(
        `buffer changed -> type=${term.buffer.active.type} baseY=${term.buffer.active.baseY} viewportY=${term.buffer.active.viewportY}`,
      );
    });
    term.open(containerRef.current);

    // GPU-accelerated rendering via WebGL, fall back to canvas
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        warnLog(
          "WebGL context LOST - will attempt recovery on next tab switch",
        );
        webglRef.current = null;
        webglLostRef.current = true;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      webglLostRef.current = false;
      debugLog("WebGL renderer active");
    } catch (e) {
      // WebGL not available — canvas renderer is used automatically
      warnLog("WebGL unavailable, using canvas", e);
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
            invokeSafe("send_ssh_input", { sessionId: sid, input: text }).catch(
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
                invokeSafe("send_ssh_input", {
                  sessionId: sid,
                  input: text,
                }).catch(() => {});
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
      invokeSafe("send_ssh_input", { sessionId: sid, input: data }).catch(
        () => {},
      );
    });
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (!termRef.current) return; // already disposed — do not touch xterm internals
      if (!visibleRef.current) return; // skip resize work for hidden panes
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        requestAnimationFrame(() => {
          if (!termRef.current) return; // disposed during debounce window
          try {
            fitRef.current?.fit();
          } catch (_) {}
          const sid = sshIdRef.current;
          if (!sid) return;
          invokeSafe("resize_pty", {
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
        invokeSafe("send_ssh_input", { sessionId: sid, input: text }).catch(
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
    const handleWheel = (event: WheelEvent) => {
      const term = termRef.current;
      const sid = sshIdRef.current;
      if (!term) return;

      const lines = getWheelScrollLines(event, term.rows);
      if (lines === 0) return;

      if (
        disableAlternateScreenRef.current &&
        term.buffer.active.type === "normal" &&
        (term.buffer.active.baseY > 0 || term.buffer.active.viewportY > 0)
      ) {
        event.preventDefault();
        event.stopPropagation();
        term.scrollLines(event.deltaY < 0 ? -lines : lines);
        return;
      }

      if (!sid || term.buffer.active.type !== "alternate") return;

      const applicationCursorKeys = Boolean(
        (term as any)._core?.coreService?.decPrivateModes
          ?.applicationCursorKeys,
      );
      const direction = event.deltaY < 0 ? "A" : "B";
      const prefix = applicationCursorKeys ? "\x1bO" : "\x1b[";
      const input = `${prefix}${direction}`.repeat(lines);

      event.preventDefault();
      event.stopPropagation();
      invokeSafe("send_ssh_input", { sessionId: sid, input }).catch(() => {});
    };
    containerRef.current?.addEventListener("paste", handlePaste);
    containerRef.current?.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });
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
      onBufferChange.dispose();
      resizeObserver.disconnect();
      parserDisposables.forEach((disposable) => disposable.dispose());
      if (unlistenRef.current) unlistenRef.current();
      const sid = sshIdRef.current;
      if (sid)
        invokeSafe("stop_ssh_session", { sessionId: sid }).catch(() => {});
      containerRef.current?.removeEventListener("paste", handlePaste);
      containerRef.current?.removeEventListener("wheel", handleWheel, true);
      window.removeEventListener("resize", handleResize);
      containerRef.current?.removeEventListener(
        "contextmenu",
        handleContextMenu,
      );
      const webglToDispose = webglRef.current as any;
      escapeSequenceRemainderRef.current = "";
      termRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
      if (webglToDispose) {
        try {
          webglToDispose.dispose();
        } catch (_) {}
      }
      // Clear xterm's internal IdleTaskQueue before dispose so pending idle
      // callbacks (e.g. ViewportOverscanService.handleResize) don't fire after
      // the terminal services are torn down.
      try {
        const core = (term as any)._core;
        if (core?._idleTaskQueue?._queue) core._idleTaskQueue._queue = [];
        if (core?._viewport) core._viewport.dispose?.();
      } catch (_) {}
      try {
        term.dispose();
      } catch (err) {
        warnLog("term.dispose ERROR", err);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const term = termRef.current;
          debugLog(
            `became visible - webglLost=${webglLostRef.current} pendingFont=${pendingFontUpdateRef.current} hasTerm=${!!term}`,
          );
          try {
            // Recover WebGL context if it was lost while the tab was hidden
            if (webglLostRef.current && term && containerRef.current) {
              debugLog("attempting WebGL context recovery");
              try {
                const webgl = new WebglAddon();
                webgl.onContextLoss(() => {
                  warnLog("WebGL context LOST (recovery addon)");
                  webglRef.current = null;
                  webglLostRef.current = true;
                });
                term.loadAddon(webgl);
                webglRef.current = webgl;
                webglLostRef.current = false;
                debugLog("WebGL context recovered");
              } catch (e) {
                warnLog("WebGL recovery failed, staying on canvas", e);
                webglLostRef.current = false;
              }
            }

            // Apply any deferred font update first so fit() uses the correct metrics
            if (pendingFontUpdateRef.current) {
              pendingFontUpdateRef.current = false;
              debugLog("visible - applying deferred font refresh");
              applyFontRefresh();
            } else {
              fitRef.current?.fit();
              // Force a full re-render in case the canvas was blank
              term?.refresh(0, (term?.rows ?? 1) - 1);
            }
          } catch (err) {
            warnLog("visible recovery error", err);
          }
          term?.focus();
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const connect = useCallback(
    (overrideUser?: string, overridePass?: string) => {
      const term = termRef.current;
      if (!term) return;
      if (!isTauriRuntime) {
        warnLog("connect skipped because Tauri runtime is unavailable");
        term.write(
          "\r\n\x1b[31m✖ Tauri runtime unavailable in browser mode\x1b[0m\r\n",
        );
        return;
      }
      if (sshIdRef.current) {
        invokeSafe("stop_ssh_session", { sessionId: sshIdRef.current }).catch(
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
      invokeSafe("start_ssh_session", {
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
          listenSafe(`ssh-output-${sshId}`, (event) => {
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
              const output = stripAlternateScreenSequences(payload.output);
              if (output) {
                term.write(output);
              }
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
          invokeSafe("stop_ssh_session", { sessionId: sid }).catch(() => {});
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
    if (!changed) return;

    // If this pane is hidden (display:none), performing WebGL operations or
    // fit() on a zero-dimension container corrupts the renderer and causes a
    // white screen. Defer the visual refresh until the pane becomes visible.
    if (!visibleRef.current) {
      debugLog(
        `font change deferred - pane hidden. size=${fontSize} family=${fontFamily}`,
      );
      pendingFontUpdateRef.current = true;
      return;
    }
    debugLog(
      `font change - pane visible, applying immediately. size=${fontSize} family=${fontFamily}`,
    );
    applyFontRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, fontFamily]);

  function applyFontRefresh() {
    const term = termRef.current;
    if (!term) return;
    try {
      debugLog(
        `applyFontRefresh START - size=${term.options.fontSize} family=${term.options.fontFamily} webgl=${!!webglRef.current}`,
      );
      // Clear the WebGL texture atlas so it rebuilds with new font metrics.
      const wgl = webglRef.current as any;
      if (wgl) {
        wgl.clearTextureAtlas?.();
        debugLog("WebGL atlas cleared");
      }
      // fit() must come before refresh() so cols/rows match new cell size.
      fitRef.current?.fit();
      term.refresh(0, term.rows - 1);
      debugLog(`applyFontRefresh DONE - cols=${term.cols} rows=${term.rows}`);
    } catch (err) {
      warnLog("applyFontRefresh ERROR", err);
    }
  }

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
