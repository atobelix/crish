/**
 * D2-4 empty-shell-assert：dev 不变量（inventory #9 心智模型）。
 *
 * ## 与 Pending Draft 的分工（单一模型，勿混为「新建复用」）
 *
 * | 概念 | 真源 | sessions[] |
 * |------|------|------------|
 * | 用户「新对话」草稿 | `activeSessionId = __pending_draft__` | **不入列** |
 * | 幽灵「新会话」空壳 | 历史脏数据 / 落盘半成品 | hydrate GC 剪掉；此处 assert 探测漏网 |
 *
 * 探测 `sessions[]` 中「本应被 prune / 不得入列表」的行：
 * - **I-DRAFT**：`PENDING_DRAFT` 哨兵出现在 `sessions[]`（脏入，永不合法）
 * - **empty_shell_should_prune**：非 keep 的 `isEmptyShellSession`（默认标题 + 无实质 + 未置顶）
 *
 * keepIds / 真实 activeSessionId：允许短暂保留「当前活动的空白真会话」
 * （commit 后尚未发消息）；**active 为 draft 哨兵时不当 keep**（与 `prepareSessionsForUi` 一致）。
 *
 * 本模块 **不是** create / reuse 路径；仅 dev 卫士 + metric。
 *
 * 纯函数 `findEmptyShellViolations` 可单测；
 * `runEmptyShellAssert` 在 dev（或 force）下记 metric + console.warn once（按 session id）。
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md Round D2-4
 * @see docs/architecture/session-pending-draft-adr.md
 * @see docs/plans/progress/architecture-dedup-inventory.md #9
 * @see ../api/sessionTitle.ts `prepareSessionsForUi`
 */

import {
  isEmptyShellSession,
  type ShellSessionLike,
} from '../api/sessionTitle';
import { recordShellEmptyAssert } from '../api/controlMetrics';

/** 与 draftSession.PENDING_DRAFT_SESSION_ID 字面量对齐（避免 dev→store 环依赖） */
const PENDING_DRAFT_ID = '__pending_draft__';

export type EmptyShellViolationReason =
  | 'i_draft_in_sessions'
  | 'empty_shell_should_prune';

export type EmptyShellViolation = {
  id: string;
  reason: EmptyShellViolationReason;
};

export type EmptyShellAssertSession = ShellSessionLike & { id: string };

/**
 * 找出应被剪掉 / 违反 I-DRAFT 的会话（hydrate GC 漏网探测）。
 *
 * keepIds 通常含真实 activeSessionId（commit 后短暂空白真会话可保留）。
 * **I-DRAFT**：`__pending_draft__` 永不进 keep；若出现在 sessions[] 必报 `i_draft_in_sessions`。
 * active 为 draft 哨兵时等价「无 keep active」——与 `prepareSessionsForUi` 一致，剪尽默认空壳。
 */
export function findEmptyShellViolations(
  sessions: ReadonlyArray<EmptyShellAssertSession | null | undefined>,
  opts?: {
    keepIds?: Iterable<string> | null;
    activeSessionId?: string | null;
  },
): EmptyShellViolation[] {
  const keep = new Set<string>();
  if (opts?.keepIds) {
    for (const id of opts.keepIds) {
      if (id) keep.add(id);
    }
  }
  const active = opts?.activeSessionId;
  // draft 哨兵不是 sessions[] 行，不可 keep；仅真实 session id 可 keep
  if (active && active !== PENDING_DRAFT_ID) {
    keep.add(active);
  }

  const out: EmptyShellViolation[] = [];
  for (const s of sessions) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    if (s.id === PENDING_DRAFT_ID) {
      out.push({ id: s.id, reason: 'i_draft_in_sessions' });
      continue;
    }
    if (keep.has(s.id)) continue;
    if (isEmptyShellSession(s)) {
      out.push({ id: s.id, reason: 'empty_shell_should_prune' });
    }
  }
  return out;
}

/** 已 warn 过的 id，避免刷屏 */
const warnedIds = new Set<string>();

/** 单测重置 warn 去重表 */
export function resetEmptyShellAssertWarned(): void {
  warnedIds.clear();
}

function isDevEnabled(force?: boolean): boolean {
  if (force) return true;
  try {
    // Vite
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return (
    typeof process !== 'undefined' && process.env.NODE_ENV === 'development'
  );
}

/**
 * 扫描并（dev）上报：每个 violation 计 metric；每个 id 仅 console.warn 一次。
 * @returns 发现的 violations（生产默认不 side-effect，除非 force）
 */
export function runEmptyShellAssert(
  sessions: ReadonlyArray<EmptyShellAssertSession | null | undefined>,
  opts?: {
    keepIds?: Iterable<string> | null;
    activeSessionId?: string | null;
    /** 单测强制开启 side-effect */
    force?: boolean;
    /** 关闭 console（仍记 metric，若 enabled） */
    silent?: boolean;
  },
): EmptyShellViolation[] {
  const violations = findEmptyShellViolations(sessions, opts);
  if (!violations.length) return violations;

  const enabled = isDevEnabled(opts?.force);
  if (!enabled) return violations;

  recordShellEmptyAssert(violations.length);

  if (!opts?.silent) {
    for (const v of violations) {
      if (warnedIds.has(v.id)) continue;
      warnedIds.add(v.id);
      console.warn(
        `[empty-shell-assert] ${v.reason}: session "${v.id}" should have been pruned (I-DRAFT / shouldList)`,
      );
    }
  }

  return violations;
}
