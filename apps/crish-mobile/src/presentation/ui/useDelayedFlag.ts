// 延迟置真（防闪窗）：condition 持续成立满 delayMs 后才为 true，
// condition 一落下立即归零。用于加载类呈现的防闪——快速完成的操作
// 不闪加载面，慢操作才出（深比 02-5 的 200ms 防闪口径）。
// delayMs 是时序门（同 Sheet 键盘交接超时先例），非动画时长，
// 不消费 theme.motion。
import { useEffect, useState } from 'react';

export function useDelayedFlag(condition: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!condition) {
      setElapsed(false);
      return undefined;
    }
    if (elapsed) return undefined;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [condition, delayMs, elapsed]);
  return condition && elapsed;
}

export default useDelayedFlag;
