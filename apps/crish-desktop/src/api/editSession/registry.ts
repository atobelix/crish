/**
 * 编辑会话注册表（R2-a① · 统一输入流收敛战役）
 *
 * 前端唯一「编辑会话」轻量抽象：对象 id → 会话状态 + 内存事件总线。
 * - `open(objectId, baseRev?)`：声明持有（无竞态则建立会话，记录 baseRev）
 * - `commit(objectId, { expectRev }?)`：提交并失效——推进 rev、清会话、
 *   广播失效（订阅方刷新）；版本不符 → `rev_conflict` 上报，不静默 LWW
 * - `invalidate(objectId, reason?)`：外部失效（撤回/截断/collab conflict）
 *   → 编辑面立即失效
 *
 * 复用后端先例（只读核实，不写 Rust）：
 * - write_paths_state.rs 声明记账 / Rail 模式：去中心化持有，**非全局锁**
 * - conex-db lease_guard.rs：open 声明 → commit/invalidate 释放
 * - CT-01 doc.rev 版本契约：commit 带 expectRev，不符 → 冲突上报
 *
 * 事件总线为内存态，**不进消息时间线 seq**（17 审计纪律：编辑/定制状态
 * 属独立带；「不可丢」指前端内存态生命周期，不是落库）。
 */

import type {
  EditSessionCommitOptions,
  EditSessionCommitResult,
  EditSessionEvent,
  EditSessionInvalidateReason,
  EditSessionInvalidateResult,
  EditSessionListener,
  EditSessionOpenResult,
  EditSessionState,
} from './types';

/** 编辑会话注册表（会话级记账 + 内存事件总线） */
export class EditSessionRegistry {
  private sessions = new Map<string, EditSessionState>();
  private listeners = new Set<EditSessionListener>();

  /**
   * 声明持有编辑。
   * 无竞态（该 id 无会话）→ 建立会话并记录 baseRev，广播 `opened`；
   * 已持有 → `already_open`（保留原会话，首个持有者为准）。
   */
  open(objectId: string, baseRev?: number): EditSessionOpenResult {
    const existing = this.sessions.get(objectId);
    if (existing) {
      return { ok: false, code: 'already_open', session: existing };
    }
    const session: EditSessionState = {
      objectId,
      baseRev,
      openedAtMs: Date.now(),
    };
    this.sessions.set(objectId, session);
    this.emit({ type: 'opened', objectId, baseRev });
    return { ok: true, session };
  }

  /**
   * 提交并失效：推进 rev（baseRev+1，rev 单调 +1 对齐 CT-01）、清会话、
   * 广播 `committed`（订阅方刷新）——替换裸 `dirtyRef=true` /
   * `clearDraftSnapshot` 的一次性清空。
   *
   * 带 expectRev 且与会话 baseRev 不符 → `rev_conflict`（不静默 LWW、
   * 不自动合并，对齐 persistence.rs `PersistError::Conflict`）；冲突时
   * **不清会话**，由调用方决定重试或 invalidate。
   */
  commit(
    objectId: string,
    options?: EditSessionCommitOptions
  ): EditSessionCommitResult {
    const session = this.sessions.get(objectId);
    if (!session) {
      return { ok: false, code: 'not_open' };
    }
    if (
      options?.expectRev !== undefined &&
      session.baseRev !== options.expectRev
    ) {
      return {
        ok: false,
        code: 'rev_conflict',
        expectRev: options.expectRev,
        baseRev: session.baseRev,
      };
    }
    this.sessions.delete(objectId);
    // rev 推进：baseRev 未知（未接线真实 rev）→ 占位 0；已知 → 单调 +1
    const committedRev =
      session.baseRev === undefined ? 0 : session.baseRev + 1;
    this.emit({ type: 'committed', objectId, committedRev });
    return { ok: true, session, committedRev };
  }

  /**
   * 外部失效（撤回 / 截断 / collab conflict / 其它外部变更）：
   * 清会话并广播 `invalidated` → 编辑面立即失效。
   * 无会话时也广播（hadSession=false），订阅方可统一刷新。
   */
  invalidate(
    objectId: string,
    reason: EditSessionInvalidateReason = 'external'
  ): EditSessionInvalidateResult {
    const session = this.sessions.get(objectId);
    const hadSession = session !== undefined;
    if (session) {
      this.sessions.delete(objectId);
    }
    this.emit({ type: 'invalidated', objectId, reason, hadSession });
    return { ok: true, hadSession };
  }

  /** 该 id 当前是否有未关闭的编辑会话 */
  isOpen(objectId: string): boolean {
    return this.sessions.has(objectId);
  }

  /** 读取指定 id 的会话状态（无 → undefined） */
  get(objectId: string): EditSessionState | undefined {
    return this.sessions.get(objectId);
  }

  /** 当前存活会话数 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** 当前存活会话清单（R2-b 失效传播遍历用；返回副本） */
  listActive(): EditSessionState[] {
    return [...this.sessions.values()];
  }

  /** 订阅事件总线；返回退订函数 */
  subscribe(listener: EditSessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 清空全部会话（测试隔离 / 会话销毁） */
  clearAll(): void {
    this.sessions.clear();
  }

  private emit(event: EditSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** 前端全局编辑会话注册表单例（生产路径默认；测可注入独立实例） */
export const defaultEditSessionRegistry = new EditSessionRegistry();

// ---------------------------------------------------------------------------
// 便捷函数（消费方一行调用；测需要隔离时用 new EditSessionRegistry() 实例）
// ---------------------------------------------------------------------------

/** 声明持有编辑（无竞态则建立会话，记录 baseRev） */
export function openEditSession(
  objectId: string,
  baseRev?: number
): EditSessionOpenResult {
  return defaultEditSessionRegistry.open(objectId, baseRev);
}

/** 提交并失效：推进 rev、清会话、广播失效（订阅方刷新） */
export function commitEditSession(
  objectId: string,
  options?: EditSessionCommitOptions
): EditSessionCommitResult {
  return defaultEditSessionRegistry.commit(objectId, options);
}

/** 外部失效（撤回/截断/collab conflict 事件）→ 编辑面立即失效 */
export function invalidateEditSession(
  objectId: string,
  reason?: EditSessionInvalidateReason
): EditSessionInvalidateResult {
  return defaultEditSessionRegistry.invalidate(objectId, reason);
}

/** 该 id 当前是否有未关闭的编辑会话（投影刷新保护判定） */
export function isEditSessionOpen(objectId: string): boolean {
  return defaultEditSessionRegistry.isOpen(objectId);
}

/** 读取指定 id 的会话状态（无 → undefined） */
export function getEditSession(objectId: string): EditSessionState | undefined {
  return defaultEditSessionRegistry.get(objectId);
}

/** 订阅事件总线；返回退订函数 */
export function subscribeEditSession(
  listener: EditSessionListener
): () => void {
  return defaultEditSessionRegistry.subscribe(listener);
}
