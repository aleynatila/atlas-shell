import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {
    dismissToast,
    getToastsSnapshot,
    subscribeToasts,
    type Toast,
} from "../lib/toast";

const VARIANT_STYLES: Record<
  Toast["variant"],
  { border: string; bg: string; text: string; Icon: typeof Info }
> = {
  info: {
    border: "border-hx-neon/40",
    bg: "bg-hx-bg/95",
    text: "text-hx-neon",
    Icon: Info,
  },
  success: {
    border: "border-hx-success/40",
    bg: "bg-hx-bg/95",
    text: "text-hx-success",
    Icon: CheckCircle2,
  },
  warning: {
    border: "border-hx-warning/40",
    bg: "bg-hx-bg/95",
    text: "text-hx-warning",
    Icon: AlertTriangle,
  },
  error: {
    border: "border-hx-danger/60",
    bg: "bg-hx-bg/95",
    text: "text-hx-danger",
    Icon: XCircle,
  },
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>(() => getToastsSnapshot());

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-9999 flex flex-col gap-2 max-w-sm"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => {
        const v = VARIANT_STYLES[t.variant];
        const Icon = v.Icon;
        return (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className={`flex items-start gap-2 px-3 py-2 border ${v.border} ${v.bg} backdrop-blur-sm font-mono text-[11px] tracking-wide shadow-lg`}
            style={{ boxShadow: "0 0 14px rgba(0,0,0,0.35)" }}
          >
            <Icon size={14} className={`${v.text} mt-0.5 flex-none`} />
            <div className="flex-1 min-w-0">
              <div className={`${v.text} font-bold uppercase`}>{t.message}</div>
              {t.detail && (
                <div className="text-hx-muted mt-1 wrap-break-word whitespace-pre-wrap">
                  {t.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              className="text-hx-dim hover:text-hx-text transition-colors flex-none"
              aria-label="Dismiss notification"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
