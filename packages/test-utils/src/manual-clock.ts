/**
 * 手动时钟 mock — 统一时间相关测试的时间控制
 *
 * 解决问题：preview-queue.test.ts 与 preview-queue.adversarial.test.ts 中
 * manualClock API 不一致（前者缺 set 方法）。
 *
 * 用法：
 *   import { manualClock } from "@crish/test-utils";
 *   const clock = manualClock(Date.UTC(2026, 0, 1));
 *   const queue = new PreviewQueue({ now: clock.now });
 *   clock.advance(100);  // 前进 100ms
 *   clock.set(0);        // 重置到 epoch
 */

export interface ManualClock {
  /** 获取当前时间（毫秒） */
  now: () => number;
  /** 前进指定毫秒 */
  advance: (ms: number) => void;
  /** 直接设置当前时间（毫秒） */
  set: (ms: number) => void;
}

/**
 * 创建一个手动控制的时钟。
 * @param initial 初始时间（毫秒），默认为 Date.UTC(2026, 0, 1)
 */
export function manualClock(initial: number = Date.UTC(2026, 0, 1)): ManualClock {
  let current = initial;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
