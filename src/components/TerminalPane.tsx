import { getVersion as getAppVersion } from "@tauri-apps/api/app";

// Cached at module level so every TerminalPane instance shares the same
// resolved value and we never call getAppVersion() more than once.
const _appVersionPromise: Promise<string> = getAppVersion().catch(() => "");
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
    readText as clipboardRead,
    writeText as clipboardWrite,
} from "@tauri-apps/plugin-clipboard-manager";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebglAddon } from "xterm-addon-webgl";
import "xterm/css/xterm.css";
import { showToast } from "../lib/toast";
import { TERMINAL_THEME } from "../themes";
import type {
    DragDropPayload,
    DragOverPayload,
    SCPProgressPayload,
    SshOutputPayload,
    TabPane,
    TransferMap,
} from "../types";
import { SCPToast } from "./SftpToast";

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
  const passwordRef = useRef(password);
  passwordRef.current = password;
  const escapeSequenceRemainderRef = useRef("");

  const [dragOver, setDragOver] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [SCPFiles, setSCPFiles] = useState<string[]>([]);
  const [SCPRemoteDir, setSCPRemoteDir] = useState("");
  const [SCPTransfers, setSCPTransfers] = useState<TransferMap>({});
  const [currentCwd, setCurrentCwd] = useState("~");
  const currentCwdRef = useRef("~");
  // Reconnect storm guard: track consecutive auto-reconnect attempts
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Credentials entered via the in-terminal prompt — reused for auto-reconnect
  // so sessions without saved passwords can reconnect after a disconnect.
  const lastTypedCredsRef = useRef<{ user: string; pass: string } | null>(null);
  // Set when the backend emits "authentication failed" so [disconnected]
  // handler shows prompt instead of auto-reconnecting with bad creds.
  const authFailedRef = useRef(false);
  const MAX_AUTO_RECONNECTS = 3;
  const RECONNECT_DELAY_MS = 3000;
  const appVersionRef = useRef("");
  const isTauriRuntime =
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
      "object";

  useEffect(() => {
    _appVersionPromise.then((v) => {
      appVersionRef.current = v;
    });
  }, []);

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

    const hasAlt = values.some((value) =>
      [47, 1047, 1048, 1049].includes(value),
    );

    // Block both enter and exit at parser level. Without blocking exit,
    // xterm will try to restore the normal buffer visually which leaves
    // garbage on screen (nano artefacts). Stream-level stripping is a
    // further layer but the parser handler is the primary safeguard.
    if (hasAlt) {
      debugLog(
        `blocked alternate-screen ${action} sequence: ${values.join(";")}`,
      );
      return true;
    }

    return false;
  }

  function stripAlternateScreenSequences(chunk: string) {
    if (!disableAlternateScreenRef.current) return chunk;

    const combined = `${escapeSequenceRemainderRef.current}${chunk}`;
    let remainder = "";

    // eslint-disable-next-line no-control-regex -- we intentionally match ESC (0x1b) for ANSI parsing
    const tailMatch = combined.match(/\x1b\[\??[0-9;]*$/);
    const complete = tailMatch ? combined.slice(0, tailMatch.index) : combined;

    if (tailMatch) {
      remainder = tailMatch[0];
    }

    const sanitized = complete.replace(
      // eslint-disable-next-line no-control-regex -- ESC (0x1b) is required for ANSI sequence detection
      /\x1b\[\??([0-9;]*)([hl])/g,
      (sequence, params: string, modeChar: string) => {
        const values = (params || "")
          .split(";")
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value));

        const isAltScreen = values.some((value) =>
          [47, 1047, 1049].includes(value),
        );
        if (!isAltScreen) return sequence;

        // On exit (l), clear the visible screen so nano's UI is removed
        // before the shell prompt redraws. \x1b[2J erases the display;
        // \x1b[H moves cursor to home so the shell prompt lands at top-left.
        if (modeChar === "l") return "\x1b[2J\x1b[H";

        // On enter (h), just strip — we never switch buffers.
        return "";
      },
    );

    escapeSequenceRemainderRef.current = remainder;
    return sanitized;
  }

  useEffect(() => {
    currentCwdRef.current = currentCwd;
  }, [currentCwd]);

  // Helper: check if a {x, y} point (screen coords from Tauri v2 drag events)
  // falls within this pane's bounding rect.
  function isDropInsidePane(x: number, y: number): boolean {
    const el = wrapperRef.current;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  }

  // Listen to Tauri v2 file-drop events only when this pane is visible.
  // v2 drag-drop payload includes { paths, position } so we can route drops
  // to the correct split-pane instead of showing the dialog on all panes.
  useEffect(() => {
    if (!visible || !isTauriRuntime) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    Promise.all([
      listenSafe("tauri://drag-drop", (e) => {
        const payload = e.payload as DragDropPayload;
        const paths =
          payload.paths ??
          (Array.isArray(e.payload) ? (e.payload as string[]) : []);
        const pos = payload.position;

        // If position info is available, only handle the drop if it landed
        // inside this pane (fixes split-pane: both panels showing dialog).
        if (pos && !isDropInsidePane(pos.x, pos.y)) return;

        setDragOver(false);
        if (Array.isArray(paths) && paths.length > 0) {
          setSCPFiles(paths);

          // Scan the terminal buffer backwards from the cursor to find the
          // most recent shell prompt and extract its path component.
          // e.g. "root@host:/playroom# " → "/playroom"
          const term = termRef.current;
          let detectedCwd = "";
          if (term) {
            const buf = term.buffer.active;
            const startLine = buf.baseY + buf.cursorY;
            const PROMPT_RE = /[\w.-]+@[\w.-]+:([^#$\s]+)[#$]/;
            for (let i = startLine; i >= Math.max(0, startLine - 20); i--) {
              const line = buf.getLine(i)?.translateToString().trim() ?? "";
              const m = line.match(PROMPT_RE);
              if (m?.[1]) {
                detectedCwd = m[1];
                break;
              }
            }
          }

          if (detectedCwd) {
            setSCPRemoteDir(
              detectedCwd === "~" ? currentCwdRef.current || "~" : detectedCwd,
            );
          } else {
            setSCPRemoteDir(currentCwdRef.current || "~");
          }
        }
      }),
      listenSafe("tauri://drag-over", (e) => {
        if ((window as any).__tabDragging) return;
        const payload = e.payload as DragOverPayload;
        const pos = payload?.position;
        // Only light up the overlay for the pane under the cursor.
        if (pos) {
          setDragOver(isDropInsidePane(pos.x, pos.y));
        } else {
          setDragOver(true);
        }
      }),
      listenSafe("tauri://drag-leave", () => setDragOver(false)),
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

  // Listen to SCP-progress events
  useEffect(() => {
    if (!visible || !isTauriRuntime) return;
    const unlisteners: Array<() => void> = [];
    let mounted = true;

    listenSafe("SCP-progress", (e) => {
      const p = e.payload as SCPProgressPayload;
      setSCPTransfers((prev) => {
        // Only handle progress for transfers THIS pane started.
        // app.emit_all() broadcasts to all webviews; ignoring unknown IDs
        // prevents other panes' uploads from leaking into this pane's toast,
        // and also prevents re-adding entries the user already dismissed.
        const existing = prev[p.id];
        if (!existing) return prev;
        return {
          ...prev,
          [p.id]: {
            ...existing,
            progress:
              p.total > 0 ? Math.round((p.bytes_sent / p.total) * 100) : 0,
            done: p.done,
            error: p.error,
            ...(p.protocol ? { protocol: p.protocol } : {}),
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
        };
      });
    }).then((u) => {
      if (mounted) unlisteners.push(u);
      else u();
    });

    return () => {
      mounted = false;
      unlisteners.forEach((u) => u());
    };
  }, [isTauriRuntime, visible]);

  function startSCPUpload() {
    const transfers: TransferMap = {};
    SCPFiles.forEach((fp) => {
      const id = crypto.randomUUID();
      const name = fp.split(/[\\/]/).pop() || fp;
      transfers[id] = { name, progress: 0, done: false };
      invokeSafe("upload_file_scp", {
        transferId: id,
        host: pane.sessionEntry.host,
        port: pane.sessionEntry.port,
        user: pane.sessionEntry.user,
        pass: pane.sessionEntry.pass || password || "",
        keyPath: pane.sessionEntry.keyPath || null,
        localPath: fp,
        remoteDir: SCPRemoteDir || currentCwdRef.current,
      }).catch((err) => {
        setSCPTransfers((prev) => {
          const existing = prev[id];
          if (!existing) return prev;
          return {
            ...prev,
            [id]: { ...existing, done: true, error: String(err) },
          };
        });
      });
    });
    setSCPTransfers((prev) => ({ ...prev, ...transfers }));
    setSCPFiles([]);
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
      scrollback: 5000,
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
      // OSC 7: shell reports current working directory after every prompt.
      // Payload format: `file://<host>/<urlencoded-path>` (terminated by BEL or ST).
      // We strip the scheme + host and URL-decode the path, then update CWD state.
      // This replaces the previous fragile `cd`-sniffing + `pwd` round-trip.
      term.parser.registerOscHandler(7, (data: string) => {
        try {
          let path = data;
          if (path.startsWith("file://")) {
            const slash = path.indexOf("/", 7);
            path = slash >= 0 ? path.slice(slash) : "";
          }
          if (!path) return true;
          const decoded = decodeURIComponent(path);
          if (decoded && decoded !== currentCwdRef.current) {
            currentCwdRef.current = decoded;
            setCurrentCwd(decoded);
          }
        } catch {
          /* malformed OSC 7 payload — ignore */
        }
        return true; // handled — do not pass through to renderer
      }),
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
        showToast("Terminal GPU context lost", {
          variant: "warning",
          detail:
            "Falling back to canvas renderer; will retry on next tab switch.",
        });
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      webglLostRef.current = false;
      debugLog("WebGL renderer active");
    } catch (e) {
      // WebGL not available — canvas renderer is used automatically
      warnLog("WebGL unavailable, using canvas", e);
      webglRef.current = null;
      showToast("WebGL renderer unavailable", {
        variant: "info",
        detail:
          "Using canvas renderer. Performance may be reduced on large scrollback.",
      });
    }

    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch (_) {}
      term.focus();
    }, 150);
    _appVersionPromise.then((ver) => {
      appVersionRef.current = ver;
      if (!termRef.current) return;
      term.write("\x1b[36m\x1b[2m╔══════════════════════════╗\x1b[0m\r\n");
      term.write(
        `\x1b[36m\x1b[2m║  ATLAS TERMINAL  v${(ver || "…").padEnd(6)}║\x1b[0m\r\n`,
      );
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
    });
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
          const term = termRef.current;
          if (term) {
            try {
              term.paste(text);
              return;
            } catch {
              // fallthrough to raw send
            }
          }
          const sid = sshIdRef.current;
          if (sid) {
            invokeSafe("send_ssh_input", { sessionId: sid, input: text }).catch(
              () => {},
            );
          } else if (promptRef.current) {
            const pr = promptRef.current;
            if (pr.stage === "user") {
              pr.user += text;
              termRef.current?.write(text);
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
              const term = termRef.current;
              if (term) {
                try {
                  term.paste(text);
                  return;
                } catch {}
              }
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
            lastTypedCredsRef.current = { user: captUser, pass: captPass };
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
      // Skip when container has no dimensions (parent is display:none)
      if (
        !containerRef.current ||
        containerRef.current.offsetWidth === 0 ||
        containerRef.current.offsetHeight === 0
      )
        return;
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
      const term = termRef.current;
      if (term) {
        try {
          // Use xterm's paste API so bracketed-paste and EOL normalization
          // are handled correctly for apps like nano.
          term.paste(text);
          return;
        } catch (err) {
          // fallback to raw send below
        }
      }
      const sid = sshIdRef.current;
      if (sid) {
        invokeSafe("send_ssh_input", { sessionId: sid, input: text }).catch(
          () => {},
        );
      } else if (promptRef.current) {
        const pr = promptRef.current;
        if (pr.stage === "user") {
          pr.user += text;
          termRef.current?.write(text);
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
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      termRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
      // WebGL addon dispose enqueues a resize task via RenderService's own
      // IdleTaskQueue. That task fires async (requestIdleCallback) after the
      // renderer is already null, crashing with "cannot read handleResize of
      // undefined". Patch every known IdleTaskQueue to a no-op _process so
      // any pending/newly-enqueued callbacks are silently swallowed.
      try {
        const core = (term as any)._core;
        const silenceQueue = (q: any) => {
          if (!q) return;
          q._queue = [];
          q._process = () => {};
        };
        silenceQueue(core?._idleTaskQueue);
        silenceQueue(core?._renderService?._idleTaskQueue);
        // Null out the renderer reference so any task that slips through
        // finds nothing to crash on.
        if (core?._renderService) core._renderService._renderer = null;
      } catch (_) {}
      if (webglToDispose) {
        try {
          webglToDispose.dispose();
        } catch (_) {}
        // Silence again after dispose in case it registered new tasks.
        try {
          const core = (term as any)._core;
          const silenceQueue = (q: any) => {
            if (!q) return;
            q._queue = [];
            q._process = () => {};
          };
          silenceQueue(core?._idleTaskQueue);
          silenceQueue(core?._renderService?._idleTaskQueue);
        } catch (_) {}
      }
      try {
        const core = (term as any)._core;
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
      // Stop any previous session and remove its listener BEFORE clearing
      // the terminal. unlistenRef may still be null if the listenSafe()
      // promise never resolved (fast auth failure race); the per-sshId guard
      // in the output handler handles that case.
      if (sshIdRef.current) {
        invokeSafe("stop_ssh_session", { sessionId: sshIdRef.current }).catch(
          () => {},
        );
        if (unlistenRef.current) {
          unlistenRef.current();
        }
        sshIdRef.current = null;
        unlistenRef.current = null;
      }
      // Clear stale prompt state so a previous "login as:" prompt doesn't
      // intercept keystrokes on the new connection.
      promptRef.current = null;
      setCurrentCwd("~");
      setConnecting(true);
      try {
        fitRef.current?.fit();
      } catch (_) {}
      // Full reset: clears viewport + scrollback so reconnect starts clean.
      term.reset();
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
          reconnectCountRef.current = 0; // reset on successful connect
          onConnected(pane.tabId, sshId);
          listenSafe(`ssh-output-${sshId}`, (event) => {
            // Discard events from a session that is no longer current.
            // This handles the race where auth fails before the listenSafe()
            // promise resolves, leaving unlistenRef.current null when
            // the user reconnects, so the old listener survives briefly.
            if (sshIdRef.current !== sshId) return;
            const payload = event.payload as SshOutputPayload;

            // Detect auth failure so [disconnected] handler shows prompt
            // instead of retrying with the same bad credentials.
            if (payload.output.includes("authentication failed")) {
              authFailedRef.current = true;
            }

            // Detect session termination signals from the Rust backend.
            // "[disconnected]" is always the final event emitted; clean up
            // refs and show the credential prompt so reconnect starts fresh.
            if (payload.output === "[disconnected]") {
              sshIdRef.current = null;
              if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
              }
              term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
              onDisconnected(pane.tabId);

              // Auth failed → clear bad creds and ask again immediately.
              if (authFailedRef.current) {
                authFailedRef.current = false;
                lastTypedCredsRef.current = null;
                term.write("\r\nlogin as: ");
                promptRef.current = { stage: "user", user: "", pass: "" };
                return;
              }

              const lc = lastTypedCredsRef.current;
              const hasCreds = !!(
                pane.sessionEntry.pass ||
                pane.sessionEntry.keyPath ||
                password ||
                lc?.pass
              );
              if (hasCreds && reconnectCountRef.current < MAX_AUTO_RECONNECTS) {
                reconnectCountRef.current += 1;
                term.write(
                  `\r\n\x1b[90m[reconnecting in 3s… attempt ${reconnectCountRef.current}/${MAX_AUTO_RECONNECTS}]\x1b[0m\r\n`,
                );
                if (reconnectTimerRef.current)
                  clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = setTimeout(() => {
                  reconnectTimerRef.current = null;
                  connectCredsRef.current?.(lc?.user, lc?.pass);
                }, RECONNECT_DELAY_MS);
              } else if (
                hasCreds &&
                reconnectCountRef.current >= MAX_AUTO_RECONNECTS
              ) {
                term.write(
                  `\r\n\x1b[31m[auto-reconnect limit reached — press Ctrl+F5 to reconnect manually]\x1b[0m\r\n`,
                );
                term.write("\r\nlogin as: ");
                promptRef.current = { stage: "user", user: "", pass: "" };
              } else {
                term.write("\r\nlogin as: ");
                promptRef.current = { stage: "user", user: "", pass: "" };
              }
              return;
            }

            // CWD updates are now handled by the OSC 7 parser registered on the
            // terminal; the SSH output stream is written directly without any
            // out-of-band pwd-sniffing.
            const output = stripAlternateScreenSequences(payload.output);
            if (output) {
              term.write(output);
            }
          }).then((u) => {
            unlistenRef.current = u;
          });
        })
        .catch((err) => {
          setConnecting(false);
          term.write(`\r\n\x1b[31m✖ Error: ${String(err)}\x1b[0m\r\n`);
          term.write(`\r\nlogin as: `);
          promptRef.current = { stage: "user", user: "", pass: "" };
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
        __reconnect?: () => void;
        __disconnect?: () => void;
        __fit?: () => void;
      };
      el.__connect = connect;
      // __reconnect: stop any active session, reset terminal, show fresh
      // credential prompt — user types new user/pass from scratch.
      // If credentials are already saved, skip the prompt and reconnect directly.
      el.__reconnect = () => {
        const term = termRef.current;
        if (!term) return;
        if (sshIdRef.current) {
          invokeSafe("stop_ssh_session", { sessionId: sshIdRef.current }).catch(
            () => {},
          );
          if (unlistenRef.current) {
            unlistenRef.current();
            unlistenRef.current = null;
          }
          sshIdRef.current = null;
        }
        // Reset auto-reconnect budget so manual reconnect always gets 3 fresh attempts
        reconnectCountRef.current = 0;
        setConnecting(false);
        onDisconnected(pane.tabId);
        promptRef.current = null;
        term.reset();
        const lc = lastTypedCredsRef.current;
        const hasCreds = !!(
          pane.sessionEntry.pass ||
          pane.sessionEntry.keyPath ||
          password ||
          lc?.pass
        );
        if (hasCreds) {
          connectCredsRef.current?.(lc?.user, lc?.pass);
        } else {
          term.write("\r\nlogin as: ");
          promptRef.current = { stage: "user", user: "", pass: "" };
        }
      };
      el.__fit = () => {
        try {
          fitRef.current?.fit();
        } catch (_) {}
      };
      el.__disconnect = () => {
        const sid = sshIdRef.current;
        if (sid) {
          invokeSafe("stop_ssh_session", { sessionId: sid }).catch(() => {});
          if (unlistenRef.current) {
            unlistenRef.current();
            unlistenRef.current = null;
          }
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
    () => Object.entries(SCPTransfers).filter(([, v]) => !v.done || v.error),
    [SCPTransfers],
  );
  const doneTransfers = useMemo(
    () => Object.entries(SCPTransfers).filter(([, v]) => v.done && !v.error),
    [SCPTransfers],
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
            DROP FILES TO UPLOAD VIA SCP
          </div>
        </div>
      )}

      {/* SCP file confirm dialog */}
      {SCPFiles.length > 0 && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-30">
          <div className="bg-hx-panel border border-hx-neon/30 rounded p-4 w-80 flex flex-col gap-3">
            <div className="text-hx-neon text-xs font-bold tracking-widest uppercase">
              Upload via SCP
            </div>
            <div className="text-xs text-hx-muted">Files:</div>
            {SCPFiles.map((fp) => (
              <div key={fp} className="text-xs text-hx-text font-mono truncate">
                {fp.split(/[\\/]/).pop()}
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-hx-muted">Remote directory</label>
              <input
                className="hx-input text-xs px-2 py-1"
                value={SCPRemoteDir || currentCwd}
                onChange={(e) => setSCPRemoteDir(e.target.value)}
                placeholder="~/uploads"
              />
              {currentCwd && currentCwd !== "~" && (
                <span className="text-[10px] text-hx-dim font-mono">
                  Terminal CWD: {currentCwd}
                </span>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSCPFiles([])}
                className="px-3 py-1 text-xs text-hx-muted hover:text-hx-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={startSCPUpload}
                className="px-3 py-1 text-xs bg-hx-neon/20 text-hx-neon border border-hx-neon/30 rounded hover:bg-hx-neon/30 transition-colors"
              >
                Upload
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SCP Transfer Toast */}
      {(activeTransfers.length > 0 || doneTransfers.length > 0) && (
        <SCPToast
          transfers={SCPTransfers}
          activeTransfers={activeTransfers}
          doneTransfers={doneTransfers}
          onDismiss={(id) =>
            setSCPTransfers((prev) => {
              const n = { ...prev };
              delete n[id];
              return n;
            })
          }
          onClearDone={() =>
            setSCPTransfers((prev) => {
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
