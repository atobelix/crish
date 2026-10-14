/**
 * apps/crish-desktop/src/store/sessionEvictionProbes.ts
 *
 * 会话软驱逐状态机的类型契约与运行态探针集合（Wave 1 · Task W1-E）。
 * 负责收集分屏可见叶、打开标签、流式推流状态、水合状态及 LRU 访问时间戳。
 */

import { isPendingDraft } from './draftSession';
import { listChatLeaves, useLayoutTreeStore } from './layout-tree';
import type { LayoutNode } from './layout-tree/types';
import { useStreamingStore } from './streamingStore';
import type { SessionState } from './types';
import { ownedChatLeaves } from './workspace-shell/treeSessionQuery';

/**
 * 可见标签快照供应器（依赖倒置）：由 workspace-shell 侧注册。
 * 探针不直连 workspaceShellStore，避免 eviction ↔ shell ↔ sessionStore 循环依赖；
 * 无注册（未初始化 / 纯逻辑单测路径）时快照为 null，仅退化为布局树口径。
 */
export interface ShellVisibilitySnapshot {
  activeSessionId?: string | null;
  openTabs?: OpenTabsInput;
  openTabIds?: OpenTabsInput;
  tabs?: OpenTabsInput;
}
type ShellVisibilityProvider = () => ShellVisibilitySnapshot | null;

let shellVisibilityProvider: ShellVisibilityProvider | null = null;

export function setShellVisibilityProvider(
  fn: ShellVisibilityProvider | null
): void {
  shellVisibilityProvider = fn;
}

function readShellVisibilitySnapshot(): ShellVisibilitySnapshot | null {
  try {
    return shellVisibilityProvider?.() ?? null;
  } catch {
    /* provider 未就绪 / 存储异常时按无快照处理 */
    return null;
  }
}

/** 会话内存软驱逐三级保活状态机枚举（SSOT） */
export type SessionEvictionTier =
  'PinnedActive' | 'OpenRetained' | 'EvictableCandidate';

/** 支持扩展在 SessionState 上的软驱逐与水合元数据字段 */
export interface EvictableSessionFields {
  /** 会话级流式状态标记（支持直接标记或由消息/块/StreamingStore 派生） */
  isStreaming?: boolean;
  /** 最近一次访问/聚焦该会话的时间戳 (epoch ms)，用于 LRU 淘汰排序 */
  lastAccessedAt?: number;
  /** 最近一次更新时间 (epoch ms 或 ISO 字符串) */
  updatedAt?: number | string;
  /** 水合状态机离散状态（对齐 Plan 09） */
  hydrationStatus?:
    | 'Shell_Lazy'
    | 'Hydrating_LocalDb'
    | 'Fallback_Engine'
    | 'Hydrated_Ready'
    | 'Degraded_Error';
  /** 水合元数据 */
  hydrationMeta?: {
    status?: string;
    requestToken?: number;
    lastHydratedAt?: number;
  };
}

export type EvictableSessionState = SessionState & EvictableSessionFields;

/** 兼容多种形态的打开标签集合输入（Set / 数组 / SessionTab[] / 工作区映射表） */
export type OpenTabsInput =
  | ReadonlySet<string>
  | readonly (string | { sessionId?: string; id?: string })[]
  | Readonly<
      Record<
        string,
        | readonly (string | { sessionId?: string; id?: string })[]
        | ReadonlySet<string>
      >
    >
  | null
  | undefined;

export interface SessionEvictionOptions {
  /** 当前活跃聚焦会话 ID */
  activeSessionId?: string | null;
  /** 外部显式传入的流式推流会话 ID 集合 */
  streamingSessionIds?: ReadonlySet<string> | readonly string[];
  /** 外部显式传入的打开标签集合（或 WorkspaceShellStore.openTabs 形状） */
  openTabs?: OpenTabsInput;
  /** 外部显式传入的分屏可见叶会话 ID 集合 */
  visibleSplitSessionIds?: ReadonlySet<string> | readonly string[];
  /** 显式传入的布局树根节点（缺省从 useLayoutTreeStore 读取） */
  layoutTreeRoot?: LayoutNode | null;
  /** 常驻已水合会话数预算上限（默认 SESSION_HYDRATE_KEEP_K） */
  keepBudget?: number;
  /** 可选：非分屏可见的后台打开标签保活上限（默认不限制） */
  openRetainedLimit?: number;
}

export interface SessionEvictionDescriptor {
  sessionId: string;
  tier: SessionEvictionTier;
  isHydrated: boolean;
  isStreaming: boolean;
  isActive: boolean;
  isVisibleInSplit: boolean;
  isOpenInTab: boolean;
  lastAccessedAt: number;
  orderIndex: number;
}

export interface SessionEvictionPlan {
  descriptorsById: Record<string, SessionEvictionDescriptor>;
  /** 级别 1：当前聚焦 + 流式推流中会话，绝对禁止驱逐 */
  pinnedActiveIds: string[];
  /** 级别 2：分屏可见或标签栏打开会话，高优先级保活 */
  openRetainedIds: string[];
  /** 级别 3：后台非打开非推流历史会话（已水合候选） */
  evictableCandidateIds: string[];
  /** 按 LRU 顺序（最久未访问优先）选出的待软驱逐会话 ID 列表 */
  sessionIdsToEvict: string[];
}

/** 模块级会话最近访问时间戳表（辅助未挂载 lastAccessedAt 字段的会话精确执行 LRU） */
const sessionAccessTimestamps = new Map<string, number>();

/** 记录会话最近一次访问时间戳（供激活/切换/水合时调用） */
export function recordSessionAccess(
  sessionId: string,
  timestamp: number = Date.now()
): void {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (
    sid &&
    !isPendingDraft(sid) &&
    Number.isFinite(timestamp) &&
    timestamp > 0
  ) {
    sessionAccessTimestamps.set(sid, timestamp);
  }
}

/** 清空模块级访问时间戳记录（仅供单测隔离重置使用） */
export function clearSessionAccessTimestamps(): void {
  sessionAccessTimestamps.clear();
}

export function isValidRealSessionId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.trim().length > 0 && !isPendingDraft(id.trim())
  );
}

export function addOpenTabsInputToSet(
  input: OpenTabsInput,
  target: Set<string>
): void {
  if (!input) return;
  if (input instanceof Set) {
    for (const item of input)
      if (isValidRealSessionId(item)) target.add(item.trim());
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const sid =
        item && typeof item === 'object' ? (item.sessionId ?? item.id) : item;
      if (isValidRealSessionId(sid)) target.add(sid.trim());
    }
  } else if (typeof input === 'object') {
    for (const val of Object.values(input))
      addOpenTabsInputToSet(val as OpenTabsInput, target);
  }
}

/** 收集当前屏幕上所有分屏叶（Split Panes）正在活跃展示的会话 ID */
export function getVisibleSplitSessionIds(
  layoutTreeRoot?: LayoutNode | null
): Set<string> {
  const visible = new Set<string>();
  const root =
    layoutTreeRoot !== undefined
      ? layoutTreeRoot
      : useLayoutTreeStore.getState()?.tree?.root;
  if (root) {
    for (const owned of ownedChatLeaves(root)) {
      const activeTab = owned.activeTabId
        ? owned.tabs.find((t) => t.tabId === owned.activeTabId)
        : undefined;
      if (activeTab && isValidRealSessionId(activeTab.sessionId))
        visible.add(activeTab.sessionId.trim());
    }
    for (const leaf of listChatLeaves(root)) {
      const legacySid = (leaf as { sessionId?: unknown }).sessionId;
      if (isValidRealSessionId(legacySid)) visible.add(legacySid.trim());
      if (leaf.activeTabId && Array.isArray(leaf.tabs)) {
        const hit = leaf.tabs.find(
          (t) =>
            t &&
            typeof t === 'object' &&
            (t as { tabId?: unknown }).tabId === leaf.activeTabId
        ) as { sessionId?: unknown } | undefined;
        if (hit && isValidRealSessionId(hit.sessionId))
          visible.add(hit.sessionId.trim());
      }
    }
  }
  // 可见标签快照经依赖倒置供应器获取（workspaceShellStore 侧注册）；
  // 探针不直连 shell store——避免 eviction ↔ shell ↔ sessionStore 循环依赖。
  const snapshot = readShellVisibilitySnapshot();
  if (snapshot) {
    const activeSid = snapshot.activeSessionId;
    if (isValidRealSessionId(activeSid)) visible.add(activeSid.trim());
  }
  return visible;
}

/** 收集所有处于分屏或工作区标签栏中打开的会话 ID（联动 WorkspaceShellStore 与 LayoutTreeStore） */
export function getOpenTabSessionIds(options?: {
  openTabs?: OpenTabsInput;
  visibleSplitSessionIds?: ReadonlySet<string> | readonly string[];
  layoutTreeRoot?: LayoutNode | null;
}): Set<string> {
  const open = getVisibleSplitSessionIds(options?.layoutTreeRoot);
  addOpenTabsInputToSet(options?.visibleSplitSessionIds as OpenTabsInput, open);
  addOpenTabsInputToSet(options?.openTabs, open);

  const root =
    options?.layoutTreeRoot !== undefined
      ? options.layoutTreeRoot
      : useLayoutTreeStore.getState()?.tree?.root;
  if (root) {
    for (const owned of ownedChatLeaves(root))
      addOpenTabsInputToSet(owned.tabs, open);
    for (const leaf of listChatLeaves(root))
      addOpenTabsInputToSet(leaf.tabs as OpenTabsInput, open);
  }
  // shell 侧可能持有的打开标签形状经供应器读取（workspaceShellStore 不直连，
  // 避免 eviction → shell → session 循环依赖）；无快照时仅退化为布局树口径。
  const snapshot = readShellVisibilitySnapshot();
  if (snapshot) {
    addOpenTabsInputToSet(snapshot.openTabs, open);
    addOpenTabsInputToSet(snapshot.openTabIds, open);
    addOpenTabsInputToSet(snapshot.tabs, open);
  }
  return open;
}

/**
 * 判定单个会话是否处于流式推流状态（isStreaming=true）。
 * 综合检查：外部流式集合、会话级 isStreaming 字段、StreamingStore 热缓冲、消息/块/思考/工具/子 Agent 运行态。
 */
export function isSessionStreaming(
  session: SessionState | null | undefined,
  explicitStreamingIds?: ReadonlySet<string> | null
): boolean {
  if (!session?.id) return false;
  const sid = session.id;
  if (explicitStreamingIds?.has(sid)) return true;

  const ext = session as EvictableSessionState & { status?: unknown };
  if (
    ext.isStreaming === true ||
    ext.status === 'streaming' ||
    ext.status === 'processing' ||
    ext.status === 'running'
  ) {
    return true;
  }

  try {
    const byKey = useStreamingStore.getState()?.byKey;
    if (byKey) {
      const prefix = `${sid}::`;
      for (const [key, entry] of Object.entries(byKey)) {
        if (entry?.sessionId === sid || key.startsWith(prefix)) return true;
      }
    }
  } catch {
    /* ignore */
  }

  if (Array.isArray(session.messages)) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i] as
        | (SessionState['messages'][number] & { isStreaming?: unknown })
        | undefined;
      if (!msg) continue;
      if (
        msg.isStreaming === true ||
        msg.status === 'processing' ||
        (msg.status as unknown) === 'streaming' ||
        msg.blocks?.some((b) => b?.isStreaming === true) ||
        msg.thinkingTurns?.some((t) => t?.isStreaming === true) ||
        msg.toolCalls?.some(
          (tc) => tc?.status === 'running' || tc?.status === 'pending_approval'
        )
      ) {
        return true;
      }
    }
  }

  return Boolean(session.agents?.some((ag) => ag?.status === 'running'));
}

/** 收集所有正在进行流式推流的会话 ID 集合 */
export function getActiveStreamingSessionIds(
  sessionsById: Readonly<Record<string, SessionState>>,
  sessions: readonly SessionState[] = [],
  explicitStreamingIds?: ReadonlySet<string> | readonly string[]
): Set<string> {
  const streaming = new Set<string>();
  addOpenTabsInputToSet(explicitStreamingIds as OpenTabsInput, streaming);
  try {
    const byKey = useStreamingStore.getState()?.byKey;
    if (byKey) {
      for (const entry of Object.values(byKey)) {
        if (isValidRealSessionId(entry?.sessionId))
          streaming.add(entry.sessionId.trim());
      }
    }
  } catch {
    /* ignore */
  }
  for (const [id, sess] of Object.entries(sessionsById)) {
    if (sess && isSessionStreaming(sess, streaming)) streaming.add(id);
  }
  for (const sess of sessions) {
    if (
      sess?.id &&
      !streaming.has(sess.id) &&
      isSessionStreaming(sessionsById[sess.id] ?? sess, streaming)
    ) {
      streaming.add(sess.id);
    }
  }
  return streaming;
}

/** 判定会话当前是否在内存中驻留了已水合的消息正文 */
export function isSessionBodyHydrated(
  session: SessionState | null | undefined
): boolean {
  if (
    !session ||
    !isValidRealSessionId(session.id) ||
    !Array.isArray(session.messages) ||
    session.messages.length === 0
  ) {
    return false;
  }
  if ((session as EvictableSessionState).hydrationStatus === 'Shell_Lazy')
    return false;
  return !(
    session.messagesHydrated === false && session.hydratedFromEngine !== true
  );
}

/** 解析会话用于 LRU 比较的最近访问时间戳（epoch ms） */
export function resolveSessionLruTimestamp(session: SessionState): number {
  const ext = session as EvictableSessionState;
  const candidates = [
    ext.lastAccessedAt,
    ext.hydrationMeta?.lastHydratedAt,
    sessionAccessTimestamps.get(session.id),
    typeof ext.updatedAt === 'number'
      ? ext.updatedAt
      : typeof ext.updatedAt === 'string'
        ? Date.parse(ext.updatedAt)
        : NaN,
    session.timestamp ? Date.parse(session.timestamp) : NaN,
    session.messages?.[session.messages.length - 1]?.timestamp,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  return 0;
}
