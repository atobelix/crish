import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  UseModernPresenceOptions,
  UseModernPresenceResult,
  ModernPresenceState,
} from './types';

/**
 * 计算最大安全超时兜底时间（毫秒）
 * 依据公式：safetyTimeoutMs = Math.max(duration, 150) + 50
 * 若未提供 duration 则默认 300ms
 */
export function computeSafetyTimeout(options: {
  durationMs?: number;
  duration?: number;
  safetyTimeoutMs?: number;
}): number {
  if (
    typeof options.safetyTimeoutMs === 'number' &&
    options.safetyTimeoutMs >= 0
  ) {
    return options.safetyTimeoutMs;
  }
  const d = options.durationMs ?? options.duration;
  if (typeof d === 'number' && d >= 0) {
    return Math.max(d, 150) + 50;
  }
  return 300;
}

/**
 * 检测当前运行环境是否为 JSDOM 或缺乏真实 CSS 动效引擎
 */
export function isJSDOMEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator?.userAgent;
  if (typeof ua === 'string' && ua.toLowerCase().includes('jsdom')) {
    return true;
  }
  // 检测是否支持基础的 CSS.supports
  if (
    typeof window.CSS === 'undefined' ||
    typeof window.CSS.supports !== 'function'
  ) {
    return true;
  }
  return false;
}

/**
 * 现代 CSS 原生存在性状态机（具备 JSDOM 环境自愈与安全天花板兜底）
 *
 * 核心机制：
 * 1. 进场：基于 @starting-style 声明首帧初态，React 侧立即 isMounted: true，无需 JS 介入；
 * 2. 退场：原生 transitionend 事件驱动，在 CSS 动效结束后优雅卸载（isMounted: false）；
 * 3. JSDOM 自动化测试自愈：单测环境中无 CSS 引擎，自动旁路立即同步卸载，杜绝单测被挂死；
 * 4. 双重安全天花板兜底定时器：针对 prefers-reduced-motion、transition: none 及后台 tab 节流，
 *    在 safetyTimeoutMs = Math.max(duration, 150) + 50ms 到期后强制完成物理卸载，彻底杜绝内存泄漏与死锁。
 */
export function useModernPresence({
  visible,
  durationMs,
  duration,
  safetyTimeoutMs,
  exitProperty,
  onExitComplete,
  bypassInTest,
}: UseModernPresenceOptions): UseModernPresenceResult {
  const [isMounted, setIsMounted] = useState<boolean>(visible);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;
  const wasVisibleRef = useRef(visible);

  const effectiveSafetyTimeout = computeSafetyTimeout({
    durationMs,
    duration,
    safetyTimeoutMs,
  });

  const shouldBypass =
    bypassInTest === true
      ? true
      : bypassInTest === false
        ? false
        : isJSDOMEnvironment();

  useEffect(() => {
    if (visible) {
      // 展开：立即置为已挂载，并清理任何待执行的退出兜底定时器
      setIsMounted(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    } else if (wasVisibleRef.current) {
      // 从可见变为不可见：启动退出生命期
      if (shouldBypass) {
        // 1. JSDOM 测试环境或配置显式旁路：同步物理卸载，防止单元测试挂死
        setIsMounted(false);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = undefined;
        }
        onExitCompleteRef.current?.();
      } else {
        // 2. 真实浏览器环境：挂载安全天花板兜底定时器
        // 应对 prefers-reduced-motion: reduce、transition: none、后台 tab 事件丢失
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          setIsMounted(false);
          timeoutRef.current = undefined;
          onExitCompleteRef.current?.();
        }, effectiveSafetyTimeout);
      }
    }

    wasVisibleRef.current = visible;

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    };
  }, [visible, shouldBypass, effectiveSafetyTimeout]);

  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent<any> | TransitionEvent) => {
      // 仅在收起阶段处理退出动画结束事件
      if (visible) return;

      // 必须是当前宿主节点自身触发的事件，严格过滤子元素过渡冒泡
      if (e.target !== e.currentTarget) return;

      // 若指定了关键属性（如 'opacity'），需精准匹配，避免较快属性提前终止退场
      if (
        exitProperty &&
        'propertyName' in e &&
        e.propertyName &&
        e.propertyName !== exitProperty
      ) {
        return;
      }

      // 正常动效完成：清理兜底定时器并执行物理卸载
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
      setIsMounted(false);
      onExitCompleteRef.current?.();
    },
    [visible, exitProperty]
  );

  const dataState: ModernPresenceState = visible ? 'open' : 'closed';

  return {
    isMounted,
    dataState,
    presenceProps: {
      'data-state': dataState,
      onTransitionEnd,
    },
  };
}
