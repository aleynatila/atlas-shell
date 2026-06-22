import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A localStorage-backed `useState` replacement that:
 * - lazily hydrates from the given key on first render,
 * - writes through synchronously on every update (or via a debounced trailing
 *   timer when `debounceMs` > 0),
 * - tolerates malformed JSON by falling back to `initial`.
 *
 * Returns the standard tuple plus a stable `save` wrapper that updates state
 * and (with debounceMs) coalesces rapid persistence writes.
 */
export function usePersistedState<T>(
  key: string,
  initial: T | (() => T),
  options: {
    /** Map state -> JSON before write (e.g. strip secrets). Defaults to identity. */
    serialize?: (value: T) => unknown;
    /** Coalesce writes within this many ms (trailing). 0 = synchronous. */
    debounceMs?: number;
  } = {},
): [T, React.Dispatch<React.SetStateAction<T>>, (next: T) => void] {
  const { serialize, debounceMs = 0 } = options;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) {
        return typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return JSON.parse(raw) as T;
    } catch {
      return typeof initial === "function" ? (initial as () => T)() : initial;
    }
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeNow = useCallback(
    (value: T) => {
      try {
        const payload = serializeRef.current
          ? serializeRef.current(value)
          : value;
        localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        /* quota / private mode / unavailable storage — ignore */
      }
    },
    [key],
  );

  const save = useCallback(
    (next: T) => {
      setState(next);
      if (debounceMs > 0) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => writeNow(next), debounceMs);
      } else {
        writeNow(next);
      }
    },
    [debounceMs, writeNow],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return [state, setState, save];
}
