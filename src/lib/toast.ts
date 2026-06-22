// Lightweight global toast bus. Framework-agnostic publish/subscribe so any
// module (including non-React code paths and class-component error boundaries)
// can emit toasts without prop drilling.

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  detail?: string;
  duration: number; // ms; 0 = sticky until dismissed
}

export interface ShowToastOptions {
  variant?: ToastVariant;
  detail?: string;
  duration?: number;
}

type Listener = (toasts: Toast[]) => void;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  // Pass a fresh array so React useSyncExternalStore-style consumers see new ref
  const snapshot = toasts.slice();
  for (const l of listeners) l(snapshot);
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  l(toasts.slice());
  return () => {
    listeners.delete(l);
  };
}

export function getToastsSnapshot(): Toast[] {
  return toasts;
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

export function showToast(
  message: string,
  opts: ShowToastOptions = {},
): number {
  const id = nextId++;
  const variant = opts.variant ?? "info";
  const duration =
    opts.duration ??
    (variant === "error" ? 8000 : variant === "warning" ? 6000 : 4000);
  const toast: Toast = {
    id,
    message,
    variant,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    duration,
  };
  toasts = [...toasts, toast];
  emit();
  if (duration > 0) {
    const handle = setTimeout(() => dismissToast(id), duration);
    timers.set(id, handle);
  }
  return id;
}
