/**
 * apps/crish-desktop/src/api/chat-bridge/editSessionConsumer.ts
 * 编辑会话消费端（统一输入流收敛战役 · R7 · 详案-R2 §1.1/§1.2-⑥）。
 *
 * 消费 R2a 交付的「apps/crish-desktop/src/api/editSession」抽象（open/commit/
 * invalidate + 对象 id+rev 记账 + 前端内存事件总线，不进消息 seq）。本模块
 * **不实现**会话注册表/rev 记账/事件总线（不重复实现），只做消费侧薄映射：
 * - 统一消费门面（open/commit/invalidate/isOpen → 委托 editSession 便捷函数）
 * - 批量失效助手 invalidateEditObjects（撤回/截断移除多个对象）
 * - reason 语义对齐：R2a `EditSessionInvalidateReason`
 *   （withdraw/truncate/collab-conflict/external）
 *
 * 签名契约（对齐 R2a registry.ts / types.ts）：
 * - `open(objectId, baseRev?: number)`：声明持有编辑会话（记录 baseRev）
 * - `commit(objectId, expectRev?: number)`：提交并关闭会话；expectRev 不符 →
 *   rev_conflict（不静默推进 rev，对齐 persistence.rs `PersistError::Conflict`）
 * - `invalidate(objectId, reason)`：对象被远端撤回/截断/合并冲突/外部变更 →
 *   编辑面立即失效（广播 invalidated 事件）
 * - `isOpen(objectId)`：会话是否仍持有（R2-a② 投影刷新 effect 判定面）
 */
import {
  commitEditSession,
  invalidateEditSession,
  isEditSessionOpen,
  openEditSession,
} from '../editSession';
import type { EditSessionInvalidateReason } from '../editSession';

/** 编辑对象失效原因（R2a 规范 union 再导出：withdraw/truncate/collab-conflict/external） */
export type EditObjectInvalidationReason = EditSessionInvalidateReason;

/** 编辑会话消费门面（薄委托；消费方不直连 editSession 内部） */
export const editSessionConsumer: {
  open(objectId: string, baseRev?: number): void;
  commit(objectId: string, expectRev?: number): boolean;
  invalidate(objectId: string, reason: EditObjectInvalidationReason): void;
  isOpen(objectId: string): boolean;
} = {
  open(objectId: string, baseRev?: number): void {
    if (!objectId) return;
    openEditSession(objectId, baseRev);
  },
  commit(objectId: string, expectRev?: number): boolean {
    if (!objectId) return true;
    // 未持有会话 → not_open：消费方视为成功（无会话可提交）
    const r = commitEditSession(
      objectId,
      expectRev !== undefined ? { expectRev } : undefined
    );
    return r.ok;
  },
  invalidate(objectId: string, reason: EditObjectInvalidationReason): void {
    if (!objectId) return;
    invalidateEditSession(objectId, reason);
  },
  isOpen(objectId: string): boolean {
    if (!objectId) return false;
    return isEditSessionOpen(objectId);
  },
};

/**
 * 批量失效：对象被撤回/截断移除后，对其 id 集合广播失效（sessionMessageActions /
 * timeline-truncate 消费端共用；无会话的 id 由抽象内 hadSession=false 广播）。
 */
export function invalidateEditObjects(
  objectIds: readonly string[],
  reason: EditObjectInvalidationReason
): void {
  if (!objectIds || objectIds.length === 0) return;
  for (const id of objectIds) {
    editSessionConsumer.invalidate(id, reason);
  }
}
