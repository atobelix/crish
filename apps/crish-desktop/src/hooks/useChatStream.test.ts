/**
 * useChatStream pure helpers — cancel / live-run / empty-session /
 * terminal tool patches. No React render required.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  buildTerminalToolPatches,
  canStreamLocalSession,
  decideSendWhileRunning,
  ensureSessionMessages,
  isLiveStreamRun,
  isSessionAiBusy,
  resolveStreamSessionId,
  resolveTerminalDurationMs,
  safeCancelStream,
  stopAssistantPlaceholderText,
} from './chat-stream/helpers';

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

describe('decideSendWhileRunning / isSessionAiBusy (W8-3 follow_up)', () => {
  it('busy → follow_up；idle → start（永不 force abort）', () => {
    expect(decideSendWhileRunning(true)).toBe('follow_up');
    expect(decideSendWhileRunning(false)).toBe('start');
  });

  it('isSessionAiBusy: live stream 时判定忙，hasLiveStream 为 false 时禁止判定 busy（防死锁不变量）', () => {
    expect(isSessionAiBusy({ hasLiveStream: true, messages: [] })).toBe(true);
    expect(
      isSessionAiBusy({
        hasLiveStream: true,
        messages: [{ sender: 'assistant', status: 'processing' }],
      })
    ).toBe(true);
    expect(
      isSessionAiBusy({
        hasLiveStream: false,
        messages: [{ sender: 'assistant', status: 'processing' }],
      })
    ).toBe(false);
    expect(
      isSessionAiBusy({
        hasLiveStream: false,
        messages: [
          { sender: 'user', status: 'queued' },
          { sender: 'assistant', status: 'completed' },
        ],
      })
    ).toBe(false);
    expect(isSessionAiBusy({ hasLiveStream: false, messages: null })).toBe(
      false
    );
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
  it('never injects system stop text into assistant bubble', () => {
    expect(stopAssistantPlaceholderText('')).toBeNull();
    expect(stopAssistantPlaceholderText('   ')).toBeNull();
    expect(stopAssistantPlaceholderText(null)).toBeNull();
    expect(stopAssistantPlaceholderText(undefined)).toBeNull();
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

/**
 * 软收口耗时固化（节点 6 / M2）。
 *
 * 根因：后端 wire 未回报 durationMs 时工具恒为 0，终态过程段
 * `segEnd = max(startTime + durationMs)` 退化为 `max(startTime)`，
 * 「工作 xx 时间」少算末项整段执行时长甚至归零。
 */
describe('软收口耗时固化 · resolveTerminalDurationMs / buildTerminalToolPatches', () => {
  const NOW = 1_700_000_000_000;

  it('缺 durationMs + 有 startedAt → 按真实挂钟补齐', () => {
    expect(resolveTerminalDurationMs({ startedAt: NOW - 4_500 }, NOW)).toBe(4_500);
  });

  it('已有正值 durationMs → 返回 undefined（后端回报优先，禁止覆盖）', () => {
    expect(resolveTerminalDurationMs({ startedAt: NOW - 4_500, durationMs: 1_200 }, NOW)).toBeUndefined();
  });

  it('durationMs = 0 视为缺失（wire 缺省值，不得当作真实 0 耗时）', () => {
    expect(resolveTerminalDurationMs({ startedAt: NOW - 900, durationMs: 0 }, NOW)).toBe(900);
  });

  it('无 startedAt → 不产出字段（禁止伪造挂钟）', () => {
    expect(resolveTerminalDurationMs({ durationMs: 0 }, NOW)).toBeUndefined();
    expect(resolveTerminalDurationMs({}, NOW)).toBeUndefined();
  });

  it('挂钟早于 startedAt（时钟回拨）→ 夹到 0，禁止负耗时', () => {
    expect(resolveTerminalDurationMs({ startedAt: NOW + 5_000 }, NOW)).toBe(0);
  });

  it('收口补丁真实携带 durationMs（正向：锚定物理终点）', () => {
    const startedAt = Date.now() - 6_000;
    const patches = buildTerminalToolPatches(
      [{ id: 't1', status: 'running', output: '执行中…', startedAt }],
      'complete'
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.durationMs).toBeGreaterThanOrEqual(6_000);
    expect(patches[0]!.durationMs).toBeLessThan(6_000 + 5_000);
  });

  it('负向断言：无 startedAt 的工具不得被塞入编造的 durationMs', () => {
    const patches = buildTerminalToolPatches(
      [{ id: 't1', status: 'running', output: '执行中…' }],
      'complete'
    );
    expect(patches[0]).not.toHaveProperty('durationMs');
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
    const sess = { messages: null as unknown as SessionMessage[] | null };
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
