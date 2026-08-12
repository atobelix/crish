// 通用倒计时 tick hook（M5 §3.3：倒计时/时钟类显示一律本地 interval 派生，绝不写回 store）
import { useEffect, useState } from 'react';

/**
 * 以 intervalMs 为步进返回当前时刻（Date.now()）：
 * - active=false 时停止计时（页面不可见/无条目时不空转，M4 §8.2 节能）；
 * - 组件卸载自动清除 interval。
 */
export function useCountdownTick(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);

  return now;
}
