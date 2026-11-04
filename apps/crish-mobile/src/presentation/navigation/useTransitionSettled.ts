import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';

/**
 * 转场落定单源 Hook（方案 21 流畅度门）：
 * 在页面切换或转场未落定（前 delayMs 或 InteractionManager 未释放）时保持 settled=false，
 * 待 InteractionManager 释放或超时兜底后置为 true，避开与原生转场或抽屉收起的 CPU 争抢。
 */
export function useTransitionSettled(delayMs = 350, key?: unknown): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSettled(false);

    const task = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) {
        setSettled(true);
      }
    });

    const timer = setTimeout(() => {
      if (!cancelled) {
        setSettled(true);
      }
    }, delayMs);

    return () => {
      cancelled = true;
      if (typeof task?.cancel === 'function') {
        task.cancel();
      }
      clearTimeout(timer);
    };
  }, [delayMs, key]);

  return settled;
}
