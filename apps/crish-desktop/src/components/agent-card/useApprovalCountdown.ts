import { useEffect, useRef, useState } from 'react';

export interface UseApprovalCountdownOptions {
  /** 超时倒计时剩余毫秒数 */
  remainingMs?: number | undefined;
  /** 提交进行中标志（提交中不触发超时） */
  busy?: boolean | undefined;
  /** 超时到达回调 */
  onTimeout?: (() => void) | undefined;
}

export interface UseApprovalCountdownResult {
  /** 进度条百分比（0 - 100） */
  timeoutPercent: number;
}

/**
 * 审批卡超时倒计时与自动派发 Hook：
 * 负责剩余时间进度计算与超时回调触发。
 */
export function useApprovalCountdown({
  remainingMs,
  busy,
  onTimeout,
}: UseApprovalCountdownOptions): UseApprovalCountdownResult {
  const [timeoutPercent, setTimeoutPercent] = useState(100);
  const timeoutTotalRef = useRef(remainingMs ?? 0);
  const timeoutFiredRef = useRef(false);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  // 进度条百分比与初始总时长记忆
  useEffect(() => {
    if (remainingMs == null || remainingMs <= 0) return;
    timeoutTotalRef.current = Math.max(remainingMs, 1);
    timeoutFiredRef.current = false;
    setTimeoutPercent(100);

    const interval = setInterval(() => {
      const pct = Math.max(
        0,
        Math.min(100, (remainingMs / timeoutTotalRef.current) * 100)
      );
      setTimeoutPercent(pct);
    }, 100);
    return () => clearInterval(interval);
  }, [remainingMs]);

  // 超时触发（提交中 busy 期间不判超时）
  useEffect(() => {
    if (remainingMs == null || remainingMs > 0) return;
    if (timeoutFiredRef.current) return;
    if (busy) return;
    timeoutFiredRef.current = true;
    onTimeoutRef.current?.();
  }, [remainingMs, busy]);

  return { timeoutPercent };
}
