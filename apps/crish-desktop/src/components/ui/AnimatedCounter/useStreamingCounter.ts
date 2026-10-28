import { useEffect, useRef, useState } from 'react';

export interface UseStreamingCounterOptions {
  /** 外部传入的最新实时数值 */
  value: number;
  /** 是否正处于流式生成状态 */
  isStreaming?: boolean;
  /** 流式聚合节流窗口（默认 100ms） */
  throttleMs?: number;
}

export function useStreamingCounter({
  value,
  isStreaming = false,
  throttleMs = 100,
}: UseStreamingCounterOptions) {
  // 当前展示给 AnimatedCounter 的数值
  const [displayValue, setDisplayValue] = useState(value);
  // 是否启用完整重型动画（流式中关闭重型滚轮，仅轻量步进；落定时开启）
  const [enableOdometer, setEnableOdometer] = useState(!isStreaming);

  const pendingValueRef = useRef(value);
  const lastFlushTimeRef = useRef(0);
  const rafHandleRef = useRef<number | null>(null);

  useEffect(() => {
    pendingValueRef.current = value;

    // 模式 A：非流式状态（如设置页、一次性加载、流式已结束）
    if (!isStreaming) {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
      setEnableOdometer(true);
      setDisplayValue(value);
      return;
    }

    // 模式 B：流式高速吞吐状态
    setEnableOdometer(false);
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = now - lastFlushTimeRef.current;

    const flush = () => {
      lastFlushTimeRef.current =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      setDisplayValue(pendingValueRef.current);
      rafHandleRef.current = null;
    };

    if (elapsed >= throttleMs) {
      flush();
    } else if (rafHandleRef.current === null) {
      rafHandleRef.current = requestAnimationFrame(() => {
        const currentTime =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (currentTime - lastFlushTimeRef.current >= throttleMs) {
          flush();
        } else {
          rafHandleRef.current = null;
        }
      });
    }
  }, [value, isStreaming, throttleMs]);

  // 组件卸载清理
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
      }
    };
  }, []);

  return {
    displayValue,
    enableOdometer,
  };
}
