/**
 * 性能日志中间件：测量每次 set 的同步耗时并打印轻量摘要。
 *
 * 仅在 development 环境启用；production 下直接透传 set，零开销。
 *
 * 类型说明：本中间件是纯透传中间件（不添加 / 消费 mutator），
 * 泛型 Mps / Mcs 完整透传，确保 immer / devtools / persist 等
 * 其他中间件的 mutator 元组不丢失。
 *
 * 实现说明：用 Proxy 包装 set，保持 set 的所有重载签名（由 Mps 决定）
 * 完整传递给内层 config。Proxy 的 apply trap 拦截每次 set 调用，
 * 在调用前后插入性能测量和日志。Reflect.apply 保证原始 set 的所有
 * 重载行为不变。无任何 as 类型断言，完全类型安全。
 *
 * 性能注意：
 * - measure 后立即 clearMarks / clearMeasures，避免 getEntriesByName 随调用次数 O(N) 增长
 * - 不 dump 完整 prev/next state（streaming 时极贵），仅打印 action 名 + top-level keys
 * - window.__streamingActive 时跳过详细日志（保留 budget 检查）
 *   由 api/streamStop.markStreamingActive 在 stream start/end 设置（ref-count）
 */
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';
import { checkBudget } from '../../api/performance-budget';

function topLevelKeys(state: unknown): string[] {
  if (state !== null && typeof state === 'object') {
    return Object.keys(state as object);
  }
  return [];
}

function isStreamingActive(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as Window & { __streamingActive?: boolean }).__streamingActive)
  );
}

export const withLogger = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  config: StateCreator<T, Mps, Mcs>,
): StateCreator<T, Mps, Mcs> => {
  const wrapped: StateCreator<T, Mps, Mcs> = (set, get, api) => {
    if (process.env.NODE_ENV !== 'development') {
      return config(set, get, api);
    }

    // Proxy 保持 set 的所有重载签名，apply trap 拦截每次调用
    const instrumentedSet: typeof set = new Proxy(set, {
      apply(target, thisArg, argArray) {
        const actionName = api.setState.name || 'anonymous';
        const markName = `store:${actionName}`;
        const startMark = `${markName}:start`;
        const endMark = `${markName}:end`;

        performance.mark(startMark);
        const prev = get();
        const result = Reflect.apply(target, thisArg, argArray);
        const next = get();
        performance.mark(endMark);
        performance.measure(markName, startMark, endMark);

        const measures = performance.getEntriesByName(markName);
        const last = measures[measures.length - 1];
        if (last) checkBudget('store:transaction', last.duration);

        // Prevent unbounded PerformanceEntry accumulation (O(N) getEntriesByName growth)
        performance.clearMarks(startMark);
        performance.clearMarks(endMark);
        performance.clearMeasures(markName);

        // Streaming: keep budget timing, skip verbose console work
        if (isStreamingActive()) {
          return result;
        }

        const duration = last?.duration ?? 0;
        // 默认 action 名多为 anonymous；sub-ms 更新刷屏无意义，只记慢路径
        if (duration < 2 && actionName === 'anonymous') {
          return result;
        }

        const durationMs = duration.toFixed(2);
        const prevKeys = topLevelKeys(prev);
        const nextKeys = topLevelKeys(next);
        console.groupCollapsed(
          `[Store] ${actionName} ${durationMs}ms keys=${nextKeys.length}`,
        );
        console.log('prev keys:', prevKeys);
        console.log('next keys:', nextKeys);
        console.groupEnd();

        return result;
      },
    });

    return config(instrumentedSet, get, api);
  };
  return wrapped;
};
