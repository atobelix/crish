/**
 * sessionStoreCompatibilityAdapter — 状态树双轨兼容代理层 (Compatibility Adapter Layer)
 *
 * 依据详案：
 * - docs/full-stack-performance-audit/01-状态管理与重渲染优化实施详案.md §2.2
 * - Reviewer-01 §2.1 & §5.1 (双轨兼容代理层设计与渐进平滑迁移)
 *
 * 核心设计动机：
 * 1. 物理归一化分层：将全局低频元数据切片 (metaById, Tier 2A) 与单会话高频内容切片 (messagesBySessionId, Tier 2B) 物理隔离；
 * 2. 渐进式无损兼容：对外暴露只读 Proxy 字典 sessionsById 与浅映射数组 sessions，
 *    既有 84+ 个业务与测试文件完全无感知地维持原 SessionState[id] 访问形态，全仓 0 编译红屏；
 * 3. 彻底阻断推流级联：更新 messagesBySessionId[sessionId] 时，不触碰 metaById 与顶层 sessionsById，
 *    阻断 Immer 对顶层会话字典的克隆扩散与全屏重渲染。
 */

import type { SessionState, SessionMessage, SessionAgent } from '../types';

/**
 * 协作子 Agent 状态别名，对齐 SessionAgent 契约
 */
export type SubAgentState = SessionAgent;

/**
 * 低频会话元数据切片 (Tier 2A)
 * 物理上与高频 messages 和 agents 解耦。
 * 兼容 SessionState 的所有非消息/非 Agent 元属性，
 * 同时支持 createdAt, updatedAt 等演进字段。
 */
export interface SessionMeta {
  readonly id: string;
  title: string;
  titleSource?: 'auto-trivial' | 'auto' | 'user';
  folder?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  branchParentId?: string;
  timestamp?: string;
  timestampSource?: 'local' | 'remote';
  pinnedMessageIds?: string[];
  pinnedMessageColors?: Record<string, string>;
  engineCursor?: number;
  engineLastRunId?: string;
  hydratedFromEngine?: boolean;
  messagesHydrated?: boolean;
  messageCount?: number;
  hydrateTruncated?: boolean;
  goalMode?: SessionState['goalMode'];
  truncatedToolChainIds?: string[];
  importMeta?: SessionState['importMeta'];
  createdAt?: string;
  updatedAt?: string;
  activeAgentId?: string | null;
  [key: string]: unknown;
}

/**
 * 为单个会话构建向后兼容的虚拟复合视图。
 * 将低频 SessionMeta 与高频 SessionMessage[]、SessionAgent[] 拼合为符合 SessionState 契约的复合对象。
 */
export function createCompatibleSessionView(
  meta: SessionMeta,
  messages: SessionMessage[] = [],
  agents: SessionAgent[] = []
): SessionState {
  const {
    messages: _m,
    agents: _a,
    ...restMeta
  } = meta as Record<string, unknown>;

  return {
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp:
      (meta.timestamp as string) ||
      (meta.updatedAt as string) ||
      (meta.createdAt as string) ||
      new Date().toISOString(),
    ...restMeta,
    messages: messages ?? [],
    agents: agents ?? [],
  } as SessionState;
}

/**
 * 基于 Proxy 的全局 sessionsById 兼容字典。
 * 拦截读取操作，按需将 metaById 与 messagesBySessionId、agentsBySessionId 拼合为 SessionState 视图。
 *
 * 行为契约：
 * 1. get(target, prop)：
 *    - 当访问 sessionsById[id] 且 id 存在于 metaById 时，按需拼合复合视图返回；
 *    - 对 Symbol/内部属性/原型属性正常穿透；
 *    - 未命中 id 返回 undefined。
 * 2. has(target, prop)：
 *    - 当 id in sessionsById 时，严格基于 metaById 中是否存在该 id 进行判断；
 *    - 对非 string 属性穿透 Reflect.has。
 * 3. ownKeys(target)：
 *    - 返回 Object.keys(metaById)，兼容 Object.keys()、Object.values()、Object.entries() 与 for...in。
 * 4. getOwnPropertyDescriptor(target, prop)：
 *    - 为已有 id 提供合法的属性描述符（enumerable: true, configurable: true, writable: true, value: compositeView）；
 *    - 未命中 id 返回 undefined。
 */
export function createSessionsByIdCompatibilityProxy(
  metaById: Record<string, SessionMeta>,
  messagesBySessionId: Record<string, SessionMessage[] | undefined> = {},
  agentsBySessionId: Record<string, SessionAgent[] | undefined> = {}
): Record<string, SessionState> {
  return new Proxy({} as Record<string, SessionState>, {
    get(target, prop: string | symbol, receiver) {
      if (typeof prop !== 'string') {
        return Reflect.get(target, prop, receiver);
      }
      if (metaById && Object.prototype.hasOwnProperty.call(metaById, prop)) {
        const meta = metaById[prop];
        if (!meta) return undefined;
        const msgs = messagesBySessionId?.[prop] ?? [];
        const ags = agentsBySessionId?.[prop] ?? [];
        return createCompatibleSessionView(meta, msgs, ags);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop: string | symbol) {
      if (typeof prop !== 'string') {
        return Reflect.has(target, prop);
      }
      return Boolean(
        metaById &&
        Object.prototype.hasOwnProperty.call(metaById, prop) &&
        metaById[prop] !== undefined
      );
    },
    ownKeys() {
      return metaById ? Object.keys(metaById) : [];
    },
    getOwnPropertyDescriptor(target, prop: string | symbol) {
      if (
        typeof prop === 'string' &&
        metaById &&
        Object.prototype.hasOwnProperty.call(metaById, prop) &&
        metaById[prop] !== undefined
      ) {
        const meta = metaById[prop];
        const msgs = messagesBySessionId?.[prop] ?? [];
        const ags = agentsBySessionId?.[prop] ?? [];
        return {
          enumerable: true,
          configurable: true,
          writable: true,
          value: createCompatibleSessionView(meta, msgs, ags),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/**
 * 兼容性辅助函数：基于有序 sessionIds 数组生成兼容的 SessionState[] 列表。
 */
export function createCompatibleSessionsList(
  sessionIds: string[],
  metaById: Record<string, SessionMeta>,
  messagesBySessionId: Record<string, SessionMessage[] | undefined> = {},
  agentsBySessionId: Record<string, SessionAgent[] | undefined> = {}
): SessionState[] {
  return sessionIds
    .map((id) => {
      const meta = metaById[id];
      if (!meta) return null;
      return createCompatibleSessionView(
        meta,
        messagesBySessionId[id] ?? [],
        agentsBySessionId[id] ?? []
      );
    })
    .filter((s): s is SessionState => s !== null);
}
