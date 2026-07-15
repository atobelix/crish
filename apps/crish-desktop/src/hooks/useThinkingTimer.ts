import { useEffect, useRef, useState } from 'react';

/**
 * 助手 processing 时累加思考秒数；结束后停表（不重置，便于最后一帧展示）。
 */
export function useThinkingTimer(isProcessing: boolean): number {
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isProcessing) {
      setThinkingSeconds(0);
      thinkingIntervalRef.current = setInterval(() => {
        setThinkingSeconds((prev) => prev + 1);
      }, 1000);
    } else if (thinkingIntervalRef.current) {
      clearInterval(thinkingIntervalRef.current);
      thinkingIntervalRef.current = null;
    }
    return () => {
      if (thinkingIntervalRef.current) clearInterval(thinkingIntervalRef.current);
    };
  }, [isProcessing]);

  return thinkingSeconds;
}
