import { describe, expect, it } from 'vitest';
import {
  PENDING_DRAFT_SESSION_ID,
  SESSION_IDENTITY_KINDS,
  isPendingDraftSessionId,
  isSessionIdentityKind,
  resolveSessionIdentityKind,
  createClientMessageId,
  ensureClientMessageId,
  hasClientMessageId,
  pickStableMessageId,
  RUN_CONTROL_LEVEL,
  RUN_CONTROL_LEVELS,
  isRunControlLevel,
  runControlLevelCode,
  isTerminatingRunControl,
  isForceCancelRunControl,
  createRunControlIntent,
  type RunControlIntent,
  type SessionIdentityKind,
} from './index';

describe('session-identity (A1)', () => {
  it('PENDING_DRAFT_SESSION_ID 与 desktop 哨兵字面量对齐', () => {
    expect(PENDING_DRAFT_SESSION_ID).toBe('__pending_draft__');
  });

  it('isPendingDraftSessionId 仅识别哨兵', () => {
    expect(isPendingDraftSessionId(PENDING_DRAFT_SESSION_ID)).toBe(true);
    expect(isPendingDraftSessionId('__pending_draft__')).toBe(true);
    expect(isPendingDraftSessionId(null)).toBe(false);
    expect(isPendingDraftSessionId(undefined)).toBe(false);
    expect(isPendingDraftSessionId('')).toBe(false);
    expect(isPendingDraftSessionId('sess-1')).toBe(false);
    expect(isPendingDraftSessionId('__pending_draft')).toBe(false);
    expect(isPendingDraftSessionId(' __pending_draft__ ')).toBe(false);
  });

  it('SessionIdentityKind 三角状态固定', () => {
    expect([...SESSION_IDENTITY_KINDS]).toEqual(['draft', 'local', 'engine']);
    for (const kind of SESSION_IDENTITY_KINDS) {
      expect(isSessionIdentityKind(kind)).toBe(true);
    }
    expect(isSessionIdentityKind('pending')).toBe(false);
    expect(isSessionIdentityKind(1)).toBe(false);

    const draft: SessionIdentityKind = 'draft';
    expect(draft).toBe('draft');
  });

  it('resolveSessionIdentityKind 对哨兵返回 draft', () => {
    expect(resolveSessionIdentityKind(PENDING_DRAFT_SESSION_ID)).toBe('draft');
    expect(resolveSessionIdentityKind('sess-abc')).toBe('local');
    expect(resolveSessionIdentityKind(null)).toBe(null);
    expect(resolveSessionIdentityKind('')).toBe(null);
  });
});

describe('message-identity (A1)', () => {
  it('createClientMessageId 生成非空 id', () => {
    const a = createClientMessageId();
    const b = createClientMessageId();
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('ensureClientMessageId 保留已有非空值', () => {
    const msg = { clientMessageId: 'cmsg-fixed' };
    expect(ensureClientMessageId(msg)).toBe('cmsg-fixed');
    expect(msg.clientMessageId).toBe('cmsg-fixed');
  });

  it('ensureClientMessageId 为空时生成并写回', () => {
    const msg: { clientMessageId?: string | null } = {};
    const id = ensureClientMessageId(msg, { createId: () => 'cmsg-gen-1' });
    expect(id).toBe('cmsg-gen-1');
    expect(msg.clientMessageId).toBe('cmsg-gen-1');
  });

  it('ensureClientMessageId 将 null/空串视为缺失', () => {
    const withNull: { clientMessageId?: string | null } = {
      clientMessageId: null,
    };
    const withEmpty: { clientMessageId?: string | null } = {
      clientMessageId: '',
    };
    expect(
      ensureClientMessageId(withNull, { createId: () => 'filled-null' })
    ).toBe('filled-null');
    expect(
      ensureClientMessageId(withEmpty, { createId: () => 'filled-empty' })
    ).toBe('filled-empty');
    expect(hasClientMessageId(withNull)).toBe(true);
    expect(hasClientMessageId({ clientMessageId: '' })).toBe(false);
    expect(hasClientMessageId(undefined)).toBe(false);
  });

  it('pickStableMessageId 优先 clientMessageId，再 messageId / id', () => {
    expect(
      pickStableMessageId({
        id: 'engine-1',
        messageId: 'mid-1',
        clientMessageId: 'cmsg-1',
      })
    ).toBe('cmsg-1');
    expect(
      pickStableMessageId({
        id: 'engine-1',
        client_message_id: 'cmsg-snake',
      })
    ).toBe('cmsg-snake');
    expect(pickStableMessageId({ message_id: 'mid-snake' })).toBe('mid-snake');
    expect(pickStableMessageId({ id: '  only-id  ' })).toBe('only-id');
    expect(pickStableMessageId({ id: '' })).toBeNull();
    expect(pickStableMessageId(null)).toBeNull();
    expect(pickStableMessageId(undefined)).toBeNull();
  });

  it('pickStableMessageId 扫描 metadata / promptContext 嵌套 clientMessageId', () => {
    expect(
      pickStableMessageId({
        id: 'engine-asst-1',
        metadata: { clientMessageId: 'assistant-msg-local-1' },
      })
    ).toBe('assistant-msg-local-1');
    expect(
      pickStableMessageId({
        id: 'engine-asst-2',
        metadata: {
          promptContext: { assistantClientMessageId: 'assistant-msg-pc' },
        },
      })
    ).toBe('assistant-msg-pc');
    // 顶层 clientMessageId 仍优先于 metadata
    expect(
      pickStableMessageId({
        clientMessageId: 'top-level',
        metadata: { clientMessageId: 'meta-level' },
      })
    ).toBe('top-level');
  });
});

describe('run-control (A1)', () => {
  it('L0–L3 映射与 wire 名固定', () => {
    expect(RUN_CONTROL_LEVEL.L0).toBe('continue');
    expect(RUN_CONTROL_LEVEL.L1).toBe('soft_inject');
    expect(RUN_CONTROL_LEVEL.L2).toBe('cooperative_stop');
    expect(RUN_CONTROL_LEVEL.L3).toBe('force_cancel');
    expect([...RUN_CONTROL_LEVELS]).toEqual([
      'continue',
      'soft_inject',
      'cooperative_stop',
      'force_cancel',
    ]);
  });

  it('isRunControlLevel / runControlLevelCode', () => {
    expect(isRunControlLevel('soft_inject')).toBe(true);
    expect(isRunControlLevel('abort')).toBe(false);
    expect(runControlLevelCode('continue')).toBe('L0');
    expect(runControlLevelCode('soft_inject')).toBe('L1');
    expect(runControlLevelCode('cooperative_stop')).toBe('L2');
    expect(runControlLevelCode('force_cancel')).toBe('L3');
  });

  it('终止语义：L2/L3 终止；仅 L3 为 force', () => {
    expect(isTerminatingRunControl('continue')).toBe(false);
    expect(isTerminatingRunControl('soft_inject')).toBe(false);
    expect(isTerminatingRunControl('cooperative_stop')).toBe(true);
    expect(isTerminatingRunControl('force_cancel')).toBe(true);
    expect(isForceCancelRunControl('cooperative_stop')).toBe(false);
    expect(isForceCancelRunControl('force_cancel')).toBe(true);
  });

  it('createRunControlIntent 构造完整载荷', () => {
    const intent = createRunControlIntent('soft_inject', {
      reason: 'user-followup',
      runId: 'run-1',
      sessionId: 'sess-1',
      payload: { text: '补充一点' },
    }) satisfies RunControlIntent;

    expect(intent).toEqual({
      level: 'soft_inject',
      reason: 'user-followup',
      runId: 'run-1',
      sessionId: 'sess-1',
      payload: { text: '补充一点' },
    });
  });
});
