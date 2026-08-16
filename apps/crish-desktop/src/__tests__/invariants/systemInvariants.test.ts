/**
 * E0-1 gate-invariants — master plan §14.1 I-* as runnable unit tests.
 *
 * Pure assertions + small fixtures; no full App mount.
 * Reuses prepareSessionsForUi, emptyShellAssert,
 * layout-tree conversation unit helpers, ptyRegistry pure map ops,
 * and upsertMessageById.
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §14.1 / E0-1
 * @see docs/plans/progress/e0-invariants.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PENDING_DRAFT_SESSION_ID,
  isPendingDraft,
} from '../../store/draftSession';
import {
  prepareSessionsForUi,
  EMPTY_SESSION_TITLE,
} from '../../api/sessionTitle';
import { findEmptyShellViolations } from '../../dev/emptyShellAssert';
import {
  createLeaf,
  createBranch,
  type LayoutTree,
} from '../../store/layout-tree/types';
import {
  dedupeDuplicateSessionChatLeaves,
  findChatLeafBySessionId,
  findDuplicateSessionChatLeaves,
  listChatLeaves,
} from '../../store/layout-tree/conversationUnit';
import { validateRestorableLayoutTree } from '../../store/layout-tree/layoutRestorePolicy';
import {
  bindSessionPty,
  getSessionPty,
  listBoundSessionIds,
  takeSessionPty,
} from '../../api/ptyRegistry';
import {
  upsertMessageById,
  getMessageById,
} from '../../store/sessionSharedHelpers';
import type { SessionMessage } from '../../store/types';
import {
  getControlMetrics,
  resetControlMetrics,
} from '../../api/controlMetrics';

// ── fixtures ─────────────────────────────────────────────────────────

function shellSession(
  id: string,
  extra?: { title?: string; messages?: { sender?: string; text?: string }[] }
) {
  return {
    id,
    title: extra?.title ?? EMPTY_SESSION_TITLE,
    messages: extra?.messages ?? ([] as { sender?: string; text?: string }[]),
  };
}

function msg(
  id: string,
  partial: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id,
    sender: partial.sender ?? 'user',
    text: partial.text ?? '',
    timestamp: partial.timestamp ?? 1,
    ...partial,
  };
}

// ── I-DRAFT: draft not in sessions[] ─────────────────────────────────

describe('I-DRAFT — draft not in sessions[]', () => {
  it('PENDING_DRAFT_SESSION_ID is the shared sentinel', () => {
    expect(PENDING_DRAFT_SESSION_ID).toBe('__pending_draft__');
    expect(isPendingDraft(PENDING_DRAFT_SESSION_ID)).toBe(true);
    expect(isPendingDraft('real-session')).toBe(false);
    expect(isPendingDraft(null)).toBe(false);
  });

  it('prepareSessionsForUi strips PENDING_DRAFT from sessions[]', () => {
    const sessions = [
      shellSession(PENDING_DRAFT_SESSION_ID, {
        title: 'leak',
        messages: [{ sender: 'user', text: 'should not list' }],
      }),
      shellSession('content', {
        title: '真实会话',
        messages: [{ sender: 'user', text: 'hi' }],
      }),
    ];

    expect(prepareSessionsForUi(sessions, null).map((s) => s.id)).toEqual([
      'content',
    ]);
    // even if active is the sentinel, never keep it as a list row
    expect(
      prepareSessionsForUi(sessions, PENDING_DRAFT_SESSION_ID).map((s) => s.id)
    ).toEqual(['content']);
  });

  it('findEmptyShellViolations flags sentinel in sessions[] as i_draft_in_sessions', () => {
    const v = findEmptyShellViolations(
      [
        shellSession(PENDING_DRAFT_SESSION_ID),
        shellSession('ok', {
          title: 'ok',
          messages: [{ sender: 'user', text: 'x' }],
        }),
      ],
      { activeSessionId: 'ok' }
    );
    expect(v).toEqual([
      { id: PENDING_DRAFT_SESSION_ID, reason: 'i_draft_in_sessions' },
    ]);
  });

  it('clean sessions[] has zero I-DRAFT violations', () => {
    const sessions = [
      shellSession('a', {
        title: 'A',
        messages: [{ sender: 'user', text: 'one' }],
      }),
    ];
    const listed = prepareSessionsForUi(sessions, null);
    expect(listed.every((s) => !isPendingDraft(s.id))).toBe(true);
    expect(
      findEmptyShellViolations(listed, { activeSessionId: 'a' }).filter(
        (x) => x.reason === 'i_draft_in_sessions'
      )
    ).toHaveLength(0);
  });

  it('inventory #9: draft active → prepare + assert prune all default empty shells', () => {
    // 单一心智模型：新对话 = PENDING_DRAFT；空壳仅 hydrate GC，非 create/reuse
    const dirty = [
      shellSession(PENDING_DRAFT_SESSION_ID),
      shellSession('ghost-1'),
      shellSession('ghost-2'),
      shellSession('hist', {
        title: '历史',
        messages: [{ sender: 'user', text: 'x' }],
      }),
    ];
    const cleaned = prepareSessionsForUi(dirty, PENDING_DRAFT_SESSION_ID);
    expect(cleaned.map((s) => s.id)).toEqual(['hist']);
    expect(cleaned.every((s) => !isPendingDraft(s.id))).toBe(true);
    // assert 在 draft active 下：sessions 已净则零 violation
    expect(
      findEmptyShellViolations(cleaned, {
        activeSessionId: PENDING_DRAFT_SESSION_ID,
      })
    ).toEqual([]);
    // 未 prepare 的脏列表：assert 应报空壳 + I-DRAFT
    const rawViolations = findEmptyShellViolations(dirty, {
      activeSessionId: PENDING_DRAFT_SESSION_ID,
    });
    expect(rawViolations).toEqual(
      expect.arrayContaining([
        { id: PENDING_DRAFT_SESSION_ID, reason: 'i_draft_in_sessions' },
        { id: 'ghost-1', reason: 'empty_shell_should_prune' },
        { id: 'ghost-2', reason: 'empty_shell_should_prune' },
      ])
    );
  });
});

// ── I-SHELL: 1 session ≤ 1 chat leaf ─────────────────────────────────

describe('I-SHELL — 1 session ≤ 1 chat leaf', () => {
  it('findDuplicateSessionChatLeaves detects multi-leaf same session', () => {
    const a1 = createLeaf('chat', ['chat'], 'chat', 'sess-dup');
    const a2 = createLeaf('chat', ['chat'], 'chat', 'sess-dup');
    const ok = createLeaf('chat', ['chat'], 'chat', 'sess-ok');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch(
        'horizontal',
        createBranch('horizontal', a1, a2, 0.5),
        ok,
        0.5
      ),
    };

    const dups = findDuplicateSessionChatLeaves(tree.root);
    expect(
      dups
        .get('sess-dup')
        ?.map((l) => l.id)
        .sort()
    ).toEqual([a1.id, a2.id].sort());
    expect(dups.has('sess-ok')).toBe(false);
  });

  it('dedupeDuplicateSessionChatLeaves restores ≤1 chat leaf per session', () => {
    const a1 = createLeaf('chat', ['chat'], 'chat', 'dup');
    const a2 = createLeaf('chat', ['chat'], 'chat', 'dup');
    const other = createLeaf('chat', ['chat'], 'chat', 'ok');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch(
        'horizontal',
        createBranch('horizontal', a1, a2, 0.5),
        other,
        0.5
      ),
    };

    const next = dedupeDuplicateSessionChatLeaves(tree);
    expect(findDuplicateSessionChatLeaves(next.root).size).toBe(0);
    expect(findChatLeafBySessionId(next.root, 'dup')?.id).toBe(a1.id);
    expect(listChatLeaves(next.root)).toHaveLength(2);
  });

  it('validateRestorableLayoutTree rejects duplicate-session binding', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 's1');
    const b = createLeaf('chat', ['chat'], 'chat', 's1');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', a, b, 0.5),
    };
    const verdict = validateRestorableLayoutTree(tree);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('duplicate-session-binding');
    }
  });

  it('valid multi-unit (distinct sessions) satisfies I-SHELL', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 's-a');
    const b = createLeaf('chat', ['chat'], 'chat', 's-b');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', a, b, 0.5),
    };
    expect(findDuplicateSessionChatLeaves(tree.root).size).toBe(0);
    const verdict = validateRestorableLayoutTree(tree);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.multiUnit).toBe(true);
      expect(verdict.chatCount).toBe(2);
    }
  });
});

// ── I-PTY: 1 session ≤ 1 live ptyId ──────────────────────────────────

describe('I-PTY — 1 session ≤ 1 live ptyId (registry map)', () => {
  it('bindSessionPty is Map semantics: rebind overwrites, never multi-value', () => {
    let map = bindSessionPty(new Map(), 's1', 'pty-old');
    map = bindSessionPty(map, 's1', 'pty-new');
    expect(getSessionPty(map, 's1')).toBe('pty-new');
    expect(listBoundSessionIds(map)).toEqual(['s1']);
    // invariant: each session key appears once
    expect([...map.keys()].filter((k) => k === 's1')).toHaveLength(1);
  });

  it('multi-session: each session has independent single pty; take A keeps B', () => {
    let map = bindSessionPty(new Map(), 'sA', 'pty-A');
    map = bindSessionPty(map, 'sB', 'pty-B');
    expect(getSessionPty(map, 'sA')).toBe('pty-A');
    expect(getSessionPty(map, 'sB')).toBe('pty-B');

    const { map: afterA, ptyId } = takeSessionPty(map, 'sA');
    expect(ptyId).toBe('pty-A');
    expect(getSessionPty(afterA, 'sA')).toBeUndefined();
    expect(getSessionPty(afterA, 'sB')).toBe('pty-B');
  });

  it('empty ids never create a live binding', () => {
    const empty = new Map<string, string>();
    expect(bindSessionPty(empty, '', 'pty-a').size).toBe(0);
    expect(bindSessionPty(empty, 's1', '  ').size).toBe(0);
  });
});

// ── optional: message upsert by id idempotency (I-MSG-ID support) ────

describe('message upsert by id (idempotent merge)', () => {
  beforeEach(() => {
    resetControlMetrics();
  });

  afterEach(() => {
    resetControlMetrics();
  });

  it('same id updates in place; length stays 1', () => {
    const messages: SessionMessage[] = [];
    expect(
      upsertMessageById(messages, msg('m1', { text: 'first', sender: 'user' }))
    ).toBe('appended');
    expect(
      upsertMessageById(
        messages,
        msg('m1', { text: 'second', sender: 'user', timestamp: 2 })
      )
    ).toBe('updated');

    expect(messages).toHaveLength(1);
    expect(getMessageById(messages, 'm1')?.text).toBe('second');
    // I-MSG-ID：无重复 message.id（旧重复 id 辅助随旁路投影删除，内联等价断言）
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
    expect(getControlMetrics().message_upsert).toBe(2);
  });

  it('distinct ids append; replaying same payload remains single row per id', () => {
    const messages: SessionMessage[] = [];
    const a = msg('a', { text: 'A' });
    const b = msg('b', { text: 'B', sender: 'assistant', status: 'completed' });

    upsertMessageById(messages, a);
    upsertMessageById(messages, b);
    upsertMessageById(messages, { ...a, text: 'A-replay' });
    upsertMessageById(messages, { ...b, text: 'B-replay' });

    expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(getMessageById(messages, 'a')?.text).toBe('A-replay');
    expect(getMessageById(messages, 'b')?.text).toBe('B-replay');
    // I-MSG-ID：无重复 message.id（旧重复 id 辅助随旁路投影删除，内联等价断言）
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
  });
});
