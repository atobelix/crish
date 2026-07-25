/**
 * 自动会话索引中间件：监听 sessions 变化，自动重建 sessionsById 映射。
 *
 * 纯透传中间件（不添加 / 消费 mutator），泛型 Mps / Mcs 完整透传，
 * 确保 immer / devtools / persist 等其他中间件的 mutator 元组不丢失。
 *
 * 工作原理：在 store 创建后注册 subscribe 监听器，当 sessions 数组
 * 引用变化时，重建 id → session 映射并写入 state.sessionsById。
 * 使用引用比较（!==）避免无变化的冗余重建。
 *
 * 类型约束说明：
 *   - S 必须 extends SessionsAwareState：本中间件需要读写 sessions / sessionsById
 *   - set 在 immer + persist + devtools 组合下类型退化为不可调用的 union（TS2349），
 *     需通过 unknown 中转断言为 recipe-only 签名（见 subscribe 回调内注释）。
 *     这是 zustand middleware 类型增广的已知限制，运行时 set 仍支持 recipe 形式。
 *   - withAutoIndex 必须应用在 immer（或其他支持 recipe 形式的中间件）之后。
 *     layoutStore 的中间件组合已满足此约束：
 *     withDevtools(withLogger(withPersist(withAutoIndex(immer(...)))))
 */
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';

/**
 * 本中间件要求 state 形状包含 sessions 数组与 sessionsById 映射。
 * 泛型 S 必须 extends 此接口，使 set/subscribe 内可安全读写这两个字段。
 */
export interface SessionsAwareState {
  sessions: ReadonlyArray<{ id: string }>;
  sessionsById: Record<string, unknown>;
}

/**
 * 从 sessions 数组构建 id → session 映射。
 * - 跳过无 id 或 id 非字符串的元素
 * - 使用 Object.create(null) 避免 prototype 污染
 */
function buildSessionsMap(
  sessions: ReadonlyArray<{ id: string }>
): Record<string, unknown> {
  const map: Record<string, unknown> = Object.create(null);
  for (const s of sessions) {
    if (s && typeof s.id === 'string' && s.id.length > 0) {
      map[s.id] = s;
    }
  }
  return map;
}

export const withAutoIndex = <
  S extends SessionsAwareState,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  config: StateCreator<S, Mps, Mcs>,
): StateCreator<S, Mps, Mcs> =>
  (set, get, api) => {
    const store = config(set, get, api);
    let prevSessions: ReadonlyArray<{ id: string }> | null = null;

    api.subscribe((state) => {
      if (!state || !Array.isArray(state.sessions)) return;
      if (state.sessions === prevSessions) return;
      prevSessions = state.sessions;
      const newMap = buildSessionsMap(state.sessions);
      (state as SessionsAwareState).sessionsById = newMap;
    });

    return store;
  };
