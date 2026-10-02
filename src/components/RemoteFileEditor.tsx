import { Loader2, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RemoteFileContent } from "../types";

interface RemoteFileEditorProps {
  host: string;
  port: number;
  user: string;
  pass: string;
  keyPath?: string | null;
  path: string;
  invokeSafe: <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T | undefined>;
  onClose: () => void;
  /** Called after a successful save so the listing can refresh size/mtime. */
  onSaved?: () => void;
}

export function RemoteFileEditor({
  host,
  port,
  user,
  pass,
  keyPath,
  path,
  invokeSafe,
  onClose,
  onSaved,
}: RemoteFileEditorProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const textRef = useRef(text);
  textRef.current = text;

  const dirty = text !== saved;
  const name = path.split("/").pop() || path;

  function connArgs() {
    return { host, port, user, pass, keyPath: keyPath || null };
  }

  useEffect(() => {
    let cancelled = false;
    invokeSafe<RemoteFileContent>("read_remote_file", { ...connArgs(), path })
      .then((res) => {
        if (cancelled || !res) return;
        setText(res.content);
        setSaved(res.content);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  async function save() {
    if (saving || loading || loadError) return;
    const content = textRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      await invokeSafe("write_remote_file", { ...connArgs(), path, content });
      setSaved(content);
      onSaved?.();
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  return (
    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-[37]">
      <div className="bg-hx-panel border border-hx-neon/30 rounded p-4 w-[44rem] max-w-[95%] h-[34rem] max-h-[85vh] flex flex-col gap-3 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-bold tracking-widest uppercase text-hx-neon shrink-0">
              Edit
            </span>
            <span
              className="text-[11px] text-hx-text font-mono truncate"
              title={path}
            >
              {name}
              {dirty ? " •" : ""}
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={save}
              disabled={!dirty || saving || loading || !!loadError}
              title="Save (Ctrl+S)"
              className="flex items-center gap-1.5 px-3 py-1 text-xs bg-hx-neon/20 text-hx-neon border border-hx-neon/30 rounded hover:bg-hx-neon/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </button>
            <button
              onClick={requestClose}
              title="Close"
              className="text-hx-dim hover:text-hx-text transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="text-[10px] text-hx-dim font-mono truncate" title={path}>
          {path}
        </div>

        <div className="flex-1 min-h-0 border border-hx-border rounded relative">
          {loading ? (
            <div className="flex items-center justify-center h-full text-hx-dim">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : loadError ? (
            <div className="p-3 text-xs text-hx-danger font-mono">
              {loadError}
            </div>
          ) : (
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setConfirmDiscard(false);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  requestClose();
                }
              }}
              spellCheck={false}
              autoFocus
              wrap="off"
              className="w-full h-full resize-none bg-transparent text-xs font-mono text-hx-text p-2 outline-none overflow-auto"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 min-h-[1rem]">
          <span className="text-[10px] font-mono text-hx-danger truncate">
            {saveError}
          </span>
          {confirmDiscard && (
            <span className="text-[10px] font-mono text-hx-neon shrink-0">
              Unsaved changes - click close again to discard
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
