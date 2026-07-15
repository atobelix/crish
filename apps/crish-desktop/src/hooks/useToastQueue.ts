import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastItem = {
  id: string;
  message: string;
  onUndo?: () => void;
};

const AUTO_DISMISS_MS = 5000;

/**
 * Multi-toast queue with auto-dismiss.
 * Timers live in a ref Map so dismiss / unmount clear them;
 * showToast itself does not return a cleanup (callers ignore returns).
 */
export function useToastQueue() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t != null) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const showToast = useCallback(
    (message: string, onUndo?: () => void) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev, { id, message, onUndo }]);
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    return () => {
      for (const t of timersRef.current.values()) {
        clearTimeout(t);
      }
      timersRef.current.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
}
