/**
 * 性能日志中间件：测量每次 set 的同步耗时并打印 prev/next 状态快照。
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
 */
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';
import { checkBudget } from '../../api/performance-budget';

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
        const markName = `store:${api.setState.name || 'anonymous'}`;
        performance.mark(`${markName}:start`);
        const prev = get();
        const result = Reflect.apply(target, thisArg, argArray);
        const next = get();
        performance.mark(`${markName}:end`);
        performance.measure(markName, `${markName}:start`, `${markName}:end`);
        const measures = performance.getEntriesByName(markName);
        const last = measures[measures.length - 1];
        if (last) checkBudget('store:transaction', last.duration);
        console.groupCollapsed(`[Store] ${api.setState.name || 'anonymous'}`);
        console.log('prev:', prev);
        console.log('next:', next);
        console.groupEnd();
        return result;
      },
    });

    return config(instrumentedSet, get, api);
  };
  return wrapped;
};
