// tests/unit/helpers/test-env.ts
// W3-3 测试基建（S-EL-11）：单测环境可复用的环境 stub 协议（非测试文件，
// 不匹配 vitest include 的 *.test.ts 模式，不产生独立测试条目）。
//
// 1. stubScrollWidth(measureFn)——R-10 scrollWidth stub 协议：jsdom 无布局，
//    HTMLElement.prototype.scrollWidth 恒 0，锁宽测宽等依赖真实宽度的
//    路径需要确定性测量值（先例：stream-table-lock.test.ts:109-116 固定
//    列宽 100 使测宽循环确定性产出 [CELL_WIDTH, ...]）；
// 2. stubRequestAnimationFrame()——帧时钟 stub，统一三处既有先例的语义
//    （stream-buffer.test.ts:7 / append-cursor.test.ts:365 /
//    stream-frame-batch.test.ts:90）：fake timers + rAF → setTimeout(cb,16)
//    + cancelAnimationFrame → clearTimeout，测试用 vi.advanceTimersByTime
//    （或返回的 advanceFrame）精确推进帧边界；
// 3. stubRafManualTick()——手动 tick stub（先例：metrics.test.ts:24-42）：
//    注册回调由测试显式 tick(ts) 驱动并传入帧时间戳——FPS 滚动窗口采样
//    依赖时间戳语义，与帧时钟型用途不同。
//
// 用法：beforeEach 安装、afterEach 调用返回的 restore（等价于
// vi.unstubAllGlobals + vi.useRealTimers 的组合）。

import { vi } from 'vitest';

/**
 * 安装 scrollWidth stub（R-10 协议）：替换 HTMLElement.prototype.scrollWidth
 * 的 getter 为 measureFn（jsdom 无布局恒 0，需要确定性测量值时使用）。
 * 返回 restore()——恢复原始 descriptor（afterEach 调用）。
 */
export function stubScrollWidth(measureFn: () => number): () => void {
  const orig = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollWidth'
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: measureFn,
  });
  return () => {
    if (orig) {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', orig);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollWidth;
    }
  };
}

/**
 * 安装帧时钟型 rAF stub（三先例统一语义）：
 * vi.useFakeTimers() + rAF → setTimeout(cb, 16) + cancelAnimationFrame →
 * clearTimeout；测试以 advanceFrame()（= vi.advanceTimersByTime(16)）推进
 * 帧。返回 { advanceFrame, restore }。
 */
export function stubRequestAnimationFrame(): {
  advanceFrame: () => void;
  restore: () => void;
} {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(cb, 16)
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  return {
    advanceFrame: () => {
      vi.advanceTimersByTime(16);
    },
    restore: () => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

/**
 * 安装手动 tick 型 rAF stub（metrics.test.ts:24-42 先例语义）：注册回调
 * 由测试显式 tick(ts) 推进并传入帧时间戳（FPS 滚动窗口采样依赖时间戳）。
 * 返回 { tick, getPending, registeredCount, restore }。
 */
export function stubRafManualTick(): {
  tick: (ts: number) => void;
  getPending: () => boolean;
  registeredCount: () => number;
  restore: () => void;
} {
  const frames: number[] = [];
  let nextCb: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
    nextCb = cb;
    frames.push(frames.length + 1);
    return frames.length;
  }) as typeof requestAnimationFrame);
  return {
    tick: (ts: number) => {
      const cb = nextCb!;
      nextCb = null;
      cb(ts);
    },
    getPending: () => nextCb !== null,
    registeredCount: () => frames.length,
    restore: () => vi.unstubAllGlobals(),
  };
}
