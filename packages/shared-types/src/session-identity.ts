/**
 * 会话身份契约（中控 A1）
 *
 * 三角状态：draft | local | engine。禁止隐式转换；各层按 kind 显式推进。
 *
 * 与 primitive-types.SessionIdentity（sessionId/workspaceId/cwd 载体）不同：
 * 本文件描述的是「身份阶段」，不是工作区绑定字段。
 *
 * 草稿哨兵真源为本包；desktop `draftSession.ts` re-export，避免双常量漂移。
 *
 * @see docs/architecture/session-pending-draft-adr.md
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §3.3 / §4
 */

/** 会话身份阶段：草稿 → 本地已 mint → 引擎已确认 */
export type SessionIdentityKind = 'draft' | 'local' | 'engine';

export const SESSION_IDENTITY_KINDS = ['draft', 'local', 'engine'] as const;

/**
 * Pending Draft 哨兵 sessionId。
 * 光杆单例仅作脏数据 / 测试 / clearDraft 无叶时回退；
 * 生产路径 mint 的草稿 tab 必须用 `mintDraftSessionId(tabId)`。
 */
export const PENDING_DRAFT_SESSION_ID = '__pending_draft__' as const;

/** 叶内 draft tab 的 sessionId 前缀。完整值 = 前缀 + tabId */
export const PENDING_DRAFT_PREFIX = '__pending_draft__:' as const;

/** 由 tabId mint 每 tab 唯一的草稿哨兵（同叶多次 + 互不碰撞） */
export function mintDraftSessionId(tabId: string): string {
  return `${PENDING_DRAFT_PREFIX}${tabId}`;
}

/** 带阶段的会话身份引用（契约层最小结构） */
export interface SessionIdentityRef {
  kind: SessionIdentityKind;
  /** draft 时为光杆哨兵或 `__pending_draft__:${tabId}`；local/engine 为真实 id */
  sessionId: string;
}

/** 是否为 Pending Draft 哨兵 id（光杆或 per-tab 前缀；null/undefined → false） */
export function isPendingDraftSessionId(
  id: string | null | undefined
): boolean {
  if (!id) return false;
  return id === PENDING_DRAFT_SESSION_ID || id.startsWith(PENDING_DRAFT_PREFIX);
}

export function isSessionIdentityKind(
  value: unknown
): value is SessionIdentityKind {
  return (
    typeof value === 'string' &&
    (SESSION_IDENTITY_KINDS as readonly string[]).includes(value)
  );
}

/** 由 sessionId 推断身份阶段：哨兵 → draft，其余默认为 local（引擎确认由上层写入） */
export function resolveSessionIdentityKind(
  sessionId: string | null | undefined
): SessionIdentityKind | null {
  if (sessionId == null || sessionId === '') return null;
  if (isPendingDraftSessionId(sessionId)) return 'draft';
  return 'local';
}
