/**
 * 验证码重新发送倒计时：restart() 重置为 seconds 并逐秒递减到 0。
 */
import { useCallback, useEffect, useState } from 'react';

export function useResendCountdown(seconds: number) {
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = window.setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left]);

  const restart = useCallback(() => setLeft(seconds), [seconds]);
  const stop = useCallback(() => setLeft(0), []);

  return { left, restart, stop };
}
