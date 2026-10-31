// 通用倒计时 tick hook（M5 §3.3：倒计时/时钟类显示一律本地 interval 派生，绝不写回 store）
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * 以 intervalMs 为步进返回当前时刻（Date.now()）：
 * - active=false 时停止计时（页面不可见/无条目时不空转，M4 §8.2 节能）；
 * - 应用退后台冻结定时器（锁屏/切走不空转耗电），回前台立即对齐最新时刻并恢复；
 * - 组件卸载自动清除 interval。
 */
export function useCountdownTick(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  const [foreground, setForeground] = useState(
    () => AppState.currentState === 'active'
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const isActive = next === 'active';
      setForeground(isActive);
      // 唤醒瞬间立即对齐（后台冻结期间的时长不丢：下一次渲染即为准确剩余时间）
      if (isActive) setNow(Date.now());
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!active || !foreground) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active, foreground]);

  return now;
}
