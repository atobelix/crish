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
  const expiredRef = useRef(false);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const busyRef = useRef(busy);
  busyRef.current = busy;

  // 进度条百分比与初始总时长记忆及动态倒计时计算（防止闭包初值冻结）
  useEffect(() => {
    if (remainingMs == null) return;
    if (remainingMs <= 0) {
      setTimeoutPercent(0);
      expiredRef.current = true;
      if (!timeoutFiredRef.current && !busyRef.current) {
        timeoutFiredRef.current = true;
        onTimeoutRef.current?.();
      }
      return;
    }

    const total = Math.max(remainingMs, 1);
    timeoutTotalRef.current = total;
    timeoutFiredRef.current = false;
    expiredRef.current = false;
    setTimeoutPercent(100);

    const endTime = Date.now() + remainingMs;

    const interval = setInterval(() => {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        setTimeoutPercent(0);
        expiredRef.current = true;
        clearInterval(interval);
        if (!timeoutFiredRef.current && !busyRef.current) {
          timeoutFiredRef.current = true;
          onTimeoutRef.current?.();
        }
        return;
      }
      const pct = Math.max(
        0,
        Math.min(100, (remaining / timeoutTotalRef.current) * 100)
      );
      setTimeoutPercent(pct);
    }, 100);
    return () => clearInterval(interval);
  }, [remainingMs]);

  // 当 busy 状态从 true 变为 false 时，若已过期则补发 onTimeout
  useEffect(() => {
    if (busy) return;
    if (expiredRef.current && !timeoutFiredRef.current) {
      timeoutFiredRef.current = true;
      onTimeoutRef.current?.();
    }
  }, [busy]);

  return { timeoutPercent };
}
