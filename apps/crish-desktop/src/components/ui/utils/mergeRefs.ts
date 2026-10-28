/**
 * apps/crish-desktop/src/components/ui/utils/mergeRefs.ts
 * React 19 兼容的 Ref 合并工具（SSOT）
 *
 * 遵循 React 19 Ref Callback Cleanup 规范：
 * 若子 Ref 回调返回了清理函数，在节点卸载时自动依次执行清理。
 */
import React, { useCallback } from 'react';

export type PossibleRef<T> = React.Ref<T> | undefined;

/**
 * 纯函数：合并多个 Ref，完全遵照 React 19 Ref Callback Cleanup 规范。
 * 若子 Ref 回调返回了清理函数，在节点卸载时自动依次执行清理。
 */
export function mergeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  return (value: T | null) => {
    const cleanups: Array<() => void> = [];

    for (const ref of refs) {
      if (!ref) continue;

      if (typeof ref === 'function') {
        const cleanup = ref(value);
        if (typeof cleanup === 'function') {
          cleanups.push(cleanup);
        }
      } else {
        try {
          (ref as React.MutableRefObject<T | null>).current = value;
        } catch {
          // 容错处理：部分不可变 ref 对象防护
        }
      }
    }

    if (cleanups.length > 0) {
      return () => {
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            // 确保单个 cleanup 异常不阻断其余清理
          }
        }
      };
    }
    return undefined;
  };
}

/**
 * Hook 封装：在组件生命周期内稳定返回合并后的 Ref Callback
 */
export function useMergedRefs<T>(
  ...refs: PossibleRef<T>[]
): React.RefCallback<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(mergeRefs(...refs), refs);
}
