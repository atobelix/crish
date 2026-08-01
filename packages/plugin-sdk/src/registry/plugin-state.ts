// packages/plugin-sdk/src/registry/plugin-state.ts
// 约束来源：ROUND-08-plugin-sdk.md §2.5 + §3.5（PluginState 状态机）
//
// 状态转移规则：
//   discovered → loading → loaded → active
//                       ↘ error
//   active → inactive（手动停用）
//   inactive → active（手动启用，需重新 activate）
//   任意状态 → error（加载/激活失败）
//   error → discovered（重试）
//
// 设计原则（系统化）：
// - 状态机是单一权威来源，PluginRegistry / PluginStore / PluginLoader 共享同一套转移规则
// - transferState() 纯函数校验转移合法性，非法转移抛错（fail-fast，不静默忽略）
// - PluginStateEntry 同时承载状态 + 错误信息 + 转移历史（诊断友好）

/**
 * 插件状态机联合类型。
 *
 * 状态语义：
 * - discovered：已发现（manifest 已解析），未加载
 * - loading：动态 import + activate 中
 * - loaded：已加载（activate 成功，能力已校验）
 * - active：已激活（能力已注册到 hookBus / toolRegistry）
 * - inactive：已停用（能力已注销，可重新激活）
 * - error：加载/激活失败
 */
export type PluginState =
  | 'discovered'
  | 'loading'
  | 'loaded'
  | 'active'
  | 'inactive'
  | 'error';

/**
 * 允许的状态转移映射（禁令：状态机校验的单一权威来源）。
 *
 * 每个 key 表示当前状态，value 数组表示可转移到的目标状态。
 * 不在此映射中的转移视为非法，transferState() 会抛错。
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<PluginState, readonly PluginState[]>
> = {
  discovered: ['loading', 'error'],
  loading: ['loaded', 'error'],
  loaded: ['active', 'error'],
  active: ['inactive', 'error'],
  inactive: ['active', 'error'],
  error: ['discovered'],
};

/**
 * 校验状态转移是否合法。
 * @returns true 表示合法，false 表示非法
 */
export function isValidTransition(
  from: PluginState,
  to: PluginState,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * 执行状态转移（纯函数，不变异入参）。
 *
 * 系统化设计：所有状态变更必须经过此函数，确保转移合法性校验集中管理。
 * 非法转移抛错（fail-fast），避免插件进入未定义状态。
 *
 * @param entry 当前状态条目
 * @param to 目标状态
 * @param reason 转移原因（可选，用于诊断）
 * @returns 新的状态条目（不可变）
 * @throws Error 当转移不合法时
 */
export function transferState(
  entry: PluginStateEntry,
  to: PluginState,
  reason?: string,
): PluginStateEntry {
  const from = entry.state;
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid plugin state transition: ${from} -> ${to} ` +
        `(plugin: ${entry.pluginId}). ` +
        `Allowed transitions from '${from}': [${ALLOWED_TRANSITIONS[from].join(', ')}]`,
    );
  }
  const now = nowIso();
  const transition: PluginStateTransitionRecord = {
    from,
    to,
    at: now,
    ...(reason !== undefined ? { reason } : {}),
  };
  return {
    pluginId: entry.pluginId,
    state: to,
    updatedAt: now,
    ...(to === 'error' && reason !== undefined ? { error: reason } : {}),
    history: [...entry.history, transition],
  };
}

/**
 * 创建初始 discovered 状态条目。
 */
export function createDiscoveredEntry(pluginId: string): PluginStateEntry {
  return {
    pluginId,
    state: 'discovered',
    updatedAt: nowIso(),
    history: [],
  };
}

/**
 * 插件状态条目（含状态 + 错误信息 + 转移历史）。
 *
 * 与 shared-types 的 PluginStateEntryLike 兼容（结构子集），
 * 额外承载 history 字段供运行时诊断。
 */
export interface PluginStateEntry {
  readonly pluginId: string;
  readonly state: PluginState;
  readonly updatedAt: string;
  /** error 状态下的错误信息 */
  readonly error?: string;
  /** 状态转移历史（用于诊断） */
  readonly history: ReadonlyArray<PluginStateTransitionRecord>;
}

/** 状态转移记录（诊断用） */
export interface PluginStateTransitionRecord {
  readonly from: PluginState;
  readonly to: PluginState;
  readonly at: string;
  readonly reason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}
