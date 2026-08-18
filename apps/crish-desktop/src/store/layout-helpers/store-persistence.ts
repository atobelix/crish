import type { SessionState, WorkspaceState } from '../types';
import { isDemoMode } from '../../api/appMode';
import {
  ensureMigrated,
  hydrateSessionsFromRust,
  persistAllSessions,
  runMigrationCleanupIfNeeded,
} from '../../api/sessionPersistence';
import {
  pickSessionDomain,
  sessionDomainChanged,
  type SessionDomainSlice,
} from '../../api/sessionPersistGate';
import {
  clampActiveWorkspaceIndex,
  ensureNonEmptyWorkspaces,
  sanitizeSessionSeed,
} from './store-initializers';
import type { WorkspaceLayoutSnapshot } from './store-types';

export interface PersistableStoreState {
  workspaces?: WorkspaceState[];
  sidebarCollapsed?: boolean;
  activeWorkspaceIndex?: number;
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  activeSessionId: string;
  folderOrder: string[];
  hydrationComplete: boolean;
  activeAgentId: string | null;
  panelAgentId: string | null;
}

export interface StoreApiLike<S extends { hydrationComplete: boolean }> {
  getState: () => S;
  setState: (
    partial: S | Partial<S> | ((state: S) => void),
    replace?: boolean
  ) => void;
  subscribe: (listener: (state: S) => void) => () => void;
}

/**
 * 依赖倒置（G13 断环）：会话激活由调用方 store 自身 action 提供，
 * 避免 store-persistence 反向 import api/storeAccess（api → store 大环）。
 * layoutStore 与 sessionStore 天然满足该接口。
 */
export type SessionActivatableStore<S extends PersistableStoreState> =
  StoreApiLike<S> & {
    /** 会话激活（触发引擎懒水合）；不存在时降级为空操作 */
    setActiveSessionId?: (id: string) => void;
  };

export function serializeWorkspaceLayout<
  S extends {
    workspaces: WorkspaceState[];
    sidebarCollapsed: boolean;
    activeWorkspaceIndex: number;
  },
>(state: S): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    workspaces: state.workspaces.map((ws) => ({
      id: ws.id,
      columns: ws.columns,
    })),
    sidebarCollapsed: state.sidebarCollapsed,
    activeWorkspaceIndex: state.activeWorkspaceIndex,
  };
}

export function deserializeWorkspaceLayout<
  S extends {
    workspaces: WorkspaceState[];
    sidebarCollapsed: boolean;
    activeWorkspaceIndex: number;
  },
>(snapshot: WorkspaceLayoutSnapshot, state: S): void {
  const index = clampActiveWorkspaceIndex(
    snapshot.workspaces,
    snapshot.activeWorkspaceIndex
  );
  state.workspaces = snapshot.workspaces.map((ws) => ({
    id: ws.id,
    columns: ws.columns,
  }));
  state.activeWorkspaceIndex = index;
  state.sidebarCollapsed = snapshot.sidebarCollapsed;
}

/** 等待 store 会话回灌完成 */
export function waitForStoreHydration<S extends { hydrationComplete: boolean }>(
  store: {
    getState: () => S;
    subscribe: (listener: (state: S) => void) => () => void;
  }
): Promise<void> {
  return new Promise((resolve) => {
    if (store.getState().hydrationComplete) {
      resolve();
      return;
    }
    const unsub = store.subscribe((state) => {
      if (state.hydrationComplete) {
        unsub();
        resolve();
      }
    });
  });
}

/**
 * 挂载会话持久化订阅（SQLite 主路径 + localStorage 回退）。
 * demo 模式不持久化，直接返回 no-op cleanup。
 *
 * Stream D 改造后：
 *   - 启动时先 `ensureMigrated`（localStorage → SQLite 一次性迁移）
 *   - 再用 `hydrateSessionsFromRust` 从 SQLite 回灌会话（替代磁盘镜像）
 *   - 订阅变更时走 `persistAllSessions`（委托 SQLite，回退 localStorage）
 *   - 已删除磁盘镜像（mirrorSessionsToDisk / restoreSessionsFromDiskMirror）
 *
 * 由 App 在 mount 时调用一次，unmount 时执行返回的 cleanup。
 */
export function initStorePersistence<S extends PersistableStoreState>(
  store: SessionActivatableStore<S>
): () => void {
  if (isDemoMode()) {
    return () => undefined;
  }

  const abortController = new AbortController();

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一份会话域切片：遥测等字段变更时引用不变 → 跳过落盘 */
  let lastDomain: SessionDomainSlice | null = pickSessionDomain(
    store.getState()
  );

  const unsub = store.subscribe((state) => {
    const domain = pickSessionDomain(state);
    // 仅 sessions / activeSessionId / folderOrder 变化时调度写入
    if (!sessionDomainChanged(lastDomain, domain)) {
      return;
    }
    lastDomain = domain;

    // boot 窗口守卫（PERSIST-01 P0-2 残余闭合）：hydrate 未完成时
    // 只允许「非空会话集」的持久化，禁止空列表经 debounce 触发全删
    // （配合 Rust 库层三护栏 + JS 空 keep 守卫，从时序面堵死清理竞态）。
    if (!state.hydrationComplete && state.sessions.length === 0) {
      return;
    }

    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const cur = store.getState();
        void persistAllSessions(
          cur.sessions,
          cur.activeSessionId,
          cur.folderOrder
        );
      } catch (e) {
        console.warn('[sessionPersistence] save failed', e);
      }
    }, 350);
  });

  // 启动时：先迁移，再从 SQLite 回灌会话（替代磁盘镜像）
  void ensureMigrated()
    .then(async () => {
      const restored = await hydrateSessionsFromRust();
      // 迁移完成 30 天后清理 localStorage（非阻塞，不影响首屏）
      void runMigrationCleanupIfNeeded();
      return restored;
    })
    .then(async (restored) => {
      if (abortController.signal.aborted) return;

      if (restored?.sessions?.length) {
        const cur = store.getState();
        let applied = false;
        let filledBodies = false;
        // 经 store 自身 action 激活（依赖倒置：store-persistence 不再反向
        // import api/storeAccess，G13 断环——api → store 大环的收口边）
        const setActiveSessionId = (id: string) =>
          store.setActiveSessionId?.(id);

        if (cur.sessions.length === 0) {
          // 冷启动无 seed：全量回灌 SQLite
          store.setState((state: PersistableStoreState) => {
            // 二次检查：recipe 内仍空才写入
            if (state.sessions.length > 0) return;

            const sanitized = sanitizeSessionSeed({
              sessions: restored.sessions,
              activeSessionId: restored.activeSessionId,
              folderOrder: restored.folderOrder,
            });
            state.sessions = sanitized.sessions;
            state.sessionsById = sanitized.sessionsById;
            state.activeSessionId = sanitized.activeSessionId;
            state.folderOrder = sanitized.folderOrder.length
              ? sanitized.folderOrder
              : state.folderOrder;
            // 回灌后清 ghost agent 焦点（会话集合已变）
            state.activeAgentId = null;
            state.panelAgentId = null;
            // empty workspace seed：若被外部掏空则重种
            if (state.workspaces) {
              state.workspaces = ensureNonEmptyWorkspaces(state.workspaces);
              state.activeWorkspaceIndex = clampActiveWorkspaceIndex(
                state.workspaces,
                state.activeWorkspaceIndex ?? 0
              );
            }
            applied = true;
          });
        } else {
          // Stream D 关键：seedSessions 只读 localStorage body，而 body 主存 SQLite。
          // 若 LS 壳 messages=[]、SQLite 有正文，旧逻辑 early-return 会永久跳过回灌，
          // 随后 350ms persist 还会用空数组把 SQLite 擦掉。此处仅补全空正文，不覆盖
          // 用户已在内存中的消息 / 新建会话。
          store.setState((state: PersistableStoreState) => {
            const byId = new Map(
              restored.sessions.map((s) => [s.id, s] as const)
            );
            let any = false;
            const next = state.sessions.map((s) => {
              if (!s?.id) return s;
              const localLen = s.messages?.length ?? 0;
              if (localLen > 0) return s;
              const r = byId.get(s.id);
              if (!r || !(r.messages?.length > 0)) return s;
              any = true;
              return {
                ...s,
                messages: r.messages,
                agents: r.agents?.length ? r.agents : s.agents,
                ...(r.engineCursor !== undefined
                  ? { engineCursor: r.engineCursor }
                  : {}),
                ...(r.engineLastRunId !== undefined
                  ? { engineLastRunId: r.engineLastRunId }
                  : {}),
                ...(r.hydratedFromEngine !== undefined
                  ? { hydratedFromEngine: r.hydratedFromEngine }
                  : {}),
                ...(r.pinnedMessageIds?.length
                  ? { pinnedMessageIds: r.pinnedMessageIds }
                  : {}),
              };
            });
            if (!any) return;
            const sanitized = sanitizeSessionSeed({
              sessions: next,
              activeSessionId: state.activeSessionId,
              folderOrder: state.folderOrder,
            });
            state.sessions = sanitized.sessions;
            state.sessionsById = sanitized.sessionsById;
            filledBodies = true;
          });
        }

        // 全量回灌或补正文后：再 activate 触发引擎懒水合；有写入则落盘对齐 LS 镜像
        if (!applied && !filledBodies) {
          // 即便未改 sessions，active 仍可能是 seed 直接写入、未走 setActiveSessionId，
          // 空正文远程壳需要一次 activate 才拉 read-session-events。
          // 仅 hydrate 激活、不建 shell tab：建 tab / 绑 leaf 由 shell 手势统一决策
          // （PE-01 T04.4 回灌编排主责；此处避免 E2 阶段抢先写 shell openTabs 与
          //  E4 hydrateWorkspaceShell 的 restore 路径竞态）。
          try {
            const after = store.getState();
            if (
              after.activeSessionId &&
              after.sessionsById[after.activeSessionId]
            ) {
              setActiveSessionId(after.activeSessionId);
            }
          } catch {
            /* ignore */
          }
          return;
        }
        try {
          const after = store.getState();
          // 直接写 activeSessionId 绕过 setActiveSessionId，空正文远程壳不会拉引擎。
          // 再走一遍 setActive：焦点幂等，且触发 needsEngineMessageHydrate 懒水合。
          // 同上：仅 hydrate 激活，不建 shell tab（open/focus 归 shell 单一手势）。
          if (
            after.activeSessionId &&
            after.sessionsById[after.activeSessionId]
          ) {
            setActiveSessionId(after.activeSessionId);
          }
          void persistAllSessions(
            after.sessions,
            after.activeSessionId,
            after.folderOrder
          );
        } catch {
          /* ignore */
        }
      }
    })
    .catch((e) => {
      console.warn('[sessionPersistence] migrate/hydrate failed', e);
    })
    .finally(() => {
      if (!abortController.signal.aborted) {
        store.setState((state: PersistableStoreState) => {
          state.hydrationComplete = true;
        });
      }
    });

  return () => {
    abortController.abort();
    if (persistTimer) clearTimeout(persistTimer);
    unsub();
  };
}
