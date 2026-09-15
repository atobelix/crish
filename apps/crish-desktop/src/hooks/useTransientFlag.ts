import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 瞬态标志位：置 true 后经 durationMs 自动回落 false。
 *
 * **卸载时必定清除挂起的定时器**——这是本 hook 存在的唯一理由。
 *
 * 缺陷收敛背景（2026-09-15）：工具卡片组件群此前各自手写
 * `setTimeout(() => setCopied(false), N)` 且从不清理（6 处 / 5 文件）。
 * 组件被虚拟列表回收行、被条件分支卸载、或测试环境 teardown 之后，
 * 挂起的定时器仍会触发 setState；React 内部 `resolveUpdatePriority`
 * 随即访问已拆除的 `window` ⇒ 抛未捕获异常。全量套件曾据此判
 * `ModernToolCall.test.tsx` 失败（isolated 复跑恒绿 ⇒ 并发下才暴露）。
 *
 * 统一到单一实现，杜绝同型泄漏复发（SSOT；不再逐组件手写定时器账本）。
 *
 * @param durationMs 标志位保持时长（毫秒）
 * @returns flag 当前标志位；trigger 重新计时并置 true；reset 立即清除并置 false
 */
export function useTransientFlag(durationMs: number): {
  flag: boolean;
  trigger: () => void;
  reset: () => void;
} {
  const [flag, setFlag] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    setFlag(false);
  }, [clearTimer]);

  const trigger = useCallback(() => {
    clearTimer();
    setFlag(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setFlag(false);
    }, durationMs);
  }, [clearTimer, durationMs]);

  // 卸载清理：这是本 hook 的核心契约，不可删除
  useEffect(() => clearTimer, [clearTimer]);

  return { flag, trigger, reset };
}
