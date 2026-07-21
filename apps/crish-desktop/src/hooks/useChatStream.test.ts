/**
 * useChatStream pure helpers — cancel / live-run / empty-session /
 * terminal tool patches. No React render required.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  buildTerminalToolPatches,
  canStreamLocalSession,
  ensureSessionMessages,
  isLiveStreamRun,
  resolveStreamSessionId,
  safeCancelStream,
  stopAssistantPlaceholderText,
} from './useChatStream';

describe('resolveStreamSessionId (empty session — no invent remote)', () => {
  it('prefers override over active', () => {
    expect(resolveStreamSessionId('sess-a', 'sess-b')).toBe('sess-a');
  });

  it('falls back to active when override empty', () => {
    expect(resolveStreamSessionId(null, 'sess-b')).toBe('sess-b');
    expect(resolveStreamSessionId('', 'sess-b')).toBe('sess-b');
    expect(resolveStreamSessionId('   ', 'sess-b')).toBe('sess-b');
    expect(resolveStreamSessionId(undefined, 'sess-b')).toBe('sess-b');
  });

  it('returns null for blank override + blank active (never invents)', () => {
    expect(resolveStreamSessionId(null, null)).toBeNull();
    expect(resolveStreamSessionId('', '')).toBeNull();
    expect(resolveStreamSessionId('  ', '  ')).toBeNull();
    expect(resolveStreamSessionId(undefined, undefined)).toBeNull();
  });

  it('trims whitespace-only ids', () => {
    expect(resolveStreamSessionId('  sess-x  ', null)).toBe('sess-x');
  });

  it('returns null for pending draft sentinel (never stream on draft)', () => {
    expect(resolveStreamSessionId('__pending_draft__', 'sess-b')).toBe(
      'sess-b'
    );
    expect(resolveStreamSessionId(null, '__pending_draft__')).toBeNull();
    expect(
      resolveStreamSessionId('__pending_draft__', '__pending_draft__')
    ).toBeNull();
  });
});

describe('canStreamLocalSession', () => {
  it('requires non-empty id AND local existence', () => {
    expect(canStreamLocalSession('sess-1', true)).toBe(true);
    expect(canStreamLocalSession('sess-1', false)).toBe(false);
    expect(canStreamLocalSession('', true)).toBe(false);
    expect(canStreamLocalSession(null, true)).toBe(false);
    expect(canStreamLocalSession('  ', true)).toBe(false);
    expect(canStreamLocalSession(undefined, false)).toBe(false);
  });
});

describe('isLiveStreamRun', () => {
  it('true only when entry assistantMsgId matches', () => {
    expect(isLiveStreamRun({ assistantMsgId: 'a1' }, 'a1')).toBe(true);
    expect(isLiveStreamRun({ assistantMsgId: 'a1' }, 'a2')).toBe(false);
    expect(isLiveStreamRun(undefined, 'a1')).toBe(false);
    expect(isLiveStreamRun(null, 'a1')).toBe(false);
    expect(isLiveStreamRun({ assistantMsgId: 'a1' }, '')).toBe(false);
  });
});

describe('safeCancelStream', () => {
  it('calls cancel and returns true', () => {
    const cancel = vi.fn();
    expect(safeCancelStream(cancel)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('swallows throw and returns false', () => {
    const cancel = vi.fn(() => {
      throw new Error('boom');
    });
    expect(safeCancelStream(cancel)).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('no-ops on null/undefined/non-function', () => {
    expect(safeCancelStream(null)).toBe(false);
    expect(safeCancelStream(undefined)).toBe(false);
    expect(safeCancelStream(123 as unknown as () => void)).toBe(false);
  });
});

describe('stopAssistantPlaceholderText', () => {
  it('returns 已停止。 only when text empty', () => {
    expect(stopAssistantPlaceholderText('')).toBe('已停止。');
    expect(stopAssistantPlaceholderText('   ')).toBe('已停止。');
    expect(stopAssistantPlaceholderText(null)).toBe('已停止。');
    expect(stopAssistantPlaceholderText(undefined)).toBe('已停止。');
    expect(stopAssistantPlaceholderText('已有正文')).toBeNull();
  });
});

describe('buildTerminalToolPatches', () => {
  const tools = [
    { id: 't-run', status: 'running', output: '执行中…' },
    { id: 't-run-real', status: 'running', output: 'partial log' },
    { id: 't-pend', status: 'pending_approval', output: '' },
    { id: 't-ok', status: 'success', output: 'done' },
    { id: 't-err', status: 'error', output: 'fail' },
  ];

  it('stop: only incomplete tools → error / 已停止', () => {
    const patches = buildTerminalToolPatches(tools, 'stop');
    expect(patches.map((p) => p.id).sort()).toEqual(
      ['t-pend', 't-run', 't-run-real'].sort()
    );
    expect(patches.find((p) => p.id === 't-run')?.output).toBe('执行中…');
    expect(patches.find((p) => p.id === 't-pend')?.output).toBe('已停止');
    expect(patches.find((p) => p.id === 't-run-real')?.output).toBe(
      'partial log'
    );
    expect(patches.every((p) => p.status === 'error')).toBe(true);
  });

  it('complete: pending_approval and running placeholders get honest copy', () => {
    const patches = buildTerminalToolPatches(tools, 'complete');
    expect(patches.find((p) => p.id === 't-pend')?.output).toBe(
      '回合结束时仍待确认'
    );
    expect(patches.find((p) => p.id === 't-run')?.output).toBe(
      '回合结束时工具未返回结果'
    );
    expect(patches.find((p) => p.id === 't-run-real')?.output).toBe(
      'partial log'
    );
  });

  it('error reason uses failure-oriented copy', () => {
    const patches = buildTerminalToolPatches(
      [
        { id: 'a', status: 'pending_approval' },
        { id: 'b', status: 'running', output: '运行中' },
      ],
      'error'
    );
    expect(patches.find((p) => p.id === 'a')?.output).toBe(
      '运行失败时仍待确认'
    );
    expect(patches.find((p) => p.id === 'b')?.output).toBe(
      '运行失败时工具未返回结果'
    );
  });

  it('empty / null toolCalls → []', () => {
    expect(buildTerminalToolPatches(undefined, 'stop')).toEqual([]);
    expect(buildTerminalToolPatches(null, 'complete')).toEqual([]);
    expect(buildTerminalToolPatches([], 'error')).toEqual([]);
  });

  it('skips tools without id', () => {
    expect(
      buildTerminalToolPatches(
        [
          { id: '', status: 'running' },
          { id: 'ok', status: 'running' },
        ],
        'stop'
      )
    ).toEqual([{ id: 'ok', status: 'error', output: '已停止' }]);
  });
});

describe('ensureSessionMessages', () => {
  it('returns false for null/undefined (no invent)', () => {
    expect(ensureSessionMessages(null)).toBe(false);
    expect(ensureSessionMessages(undefined)).toBe(false);
  });

  it('initializes missing messages array in place', () => {
    const sess: { messages?: SessionMessage[] } = {};
    expect(ensureSessionMessages(sess)).toBe(true);
    expect(Array.isArray(sess.messages)).toBe(true);
    expect(sess.messages).toEqual([]);
  });

  it('keeps existing messages array', () => {
    const sess = { messages: [{ id: 'm1' }] as never[] };
    expect(ensureSessionMessages(sess)).toBe(true);
    expect(sess.messages).toHaveLength(1);
  });

  it('replaces non-array messages with []', () => {
    const sess = { messages: null as unknown as undefined };
    expect(ensureSessionMessages(sess)).toBe(true);
    expect(sess.messages).toEqual([]);
  });
});

describe('live-run + cancel contract (composition)', () => {
  it('after delete, isLiveStreamRun is false so complete/drain must no-op', () => {
    const entry = { assistantMsgId: 'asst-1', cancel: vi.fn() };
    expect(isLiveStreamRun(entry, 'asst-1')).toBe(true);
    // simulate stop: handle removed from manager before cancel
    const afterDelete = undefined;
    expect(isLiveStreamRun(afterDelete, 'asst-1')).toBe(false);
    // cancel still safe even if it throws / fires onComplete
    entry.cancel.mockImplementation(() => {
      throw new Error('engine cancel');
    });
    expect(safeCancelStream(entry.cancel)).toBe(false);
  });

  it('supersede: new assistant id is live; old is not', () => {
    const current = { assistantMsgId: 'asst-new' };
    expect(isLiveStreamRun(current, 'asst-old')).toBe(false);
    expect(isLiveStreamRun(current, 'asst-new')).toBe(true);
  });
});
