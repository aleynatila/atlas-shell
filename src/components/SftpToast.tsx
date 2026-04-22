import { Upload, X } from "lucide-react";
import { memo, useState } from "react";
import type { TransferMap } from "../types";

const PROTOCOL_STYLES: Record<string, { label: string; className: string }> = {
  rsync: { label: "rsync", className: "text-purple-400 border-purple-400/40" },
  scp:   { label: "scp",   className: "text-hx-neon border-hx-neon/40" },
  sftp:  { label: "sftp",  className: "text-hx-dim border-hx-border" },
};

function ProtocolBadge({ protocol }: { protocol: string }) {
  const style = PROTOCOL_STYLES[protocol] ?? { label: protocol, className: "text-hx-dim border-hx-border" };
  return (
    <span className={`text-[9px] font-mono uppercase border rounded px-1 py-px shrink-0 ${style.className}`}>
      {style.label}
    </span>
  );
}

export const SftpToast = memo(function SftpToast({
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
                {t.protocol && !t.done && !t.error && (
                  <ProtocolBadge protocol={t.protocol} />
                )}
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
                      <div className="flex items-center gap-1.5 shrink-0">
                        {t.protocol && (
                          <ProtocolBadge protocol={t.protocol} />
                        )}
                        <button
                          onClick={() => onDismiss(id)}
                          className="text-hx-dim hover:text-hx-text transition-colors"
                        >
                          <X size={10} />
                        </button>
                      </div>
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
});
