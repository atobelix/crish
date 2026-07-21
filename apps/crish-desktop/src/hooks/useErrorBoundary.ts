import { useCallback, useEffect, useRef, useState } from 'react';

type UseErrorBoundaryOptions = {
  autoResetTimeout?: number;
  onAutoReset?: () => void;
};

type UseErrorBoundaryResult = {
  resetKey: number;
  reset: () => void;
  handleError: () => void;
  isPendingReset: boolean;
};

function useErrorBoundary(options?: UseErrorBoundaryOptions): UseErrorBoundaryResult {
  const { autoResetTimeout, onAutoReset } = options ?? {};
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [isPendingReset, setIsPendingReset] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const handleError = useCallback(() => {
    if (autoResetTimeout && autoResetTimeout > 0) {
      clearTimer();
      setIsPendingReset(true);
      timerRef.current = setTimeout(() => {
        setIsPendingReset(false);
        setResetKey(k => k + 1);
        onAutoReset?.();
      }, autoResetTimeout);
    }
  }, [autoResetTimeout, clearTimer, onAutoReset]);

  const reset = useCallback(() => {
    clearTimer();
    setIsPendingReset(false);
    setResetKey(k => k + 1);
  }, [clearTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { resetKey, reset, handleError, isPendingReset };
}

export { useErrorBoundary };
