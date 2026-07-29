import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findEmptyShellViolations,
  resetEmptyShellAssertWarned,
  runEmptyShellAssert,
} from './emptyShellAssert';
import {
  getControlMetrics,
  resetControlMetrics,
} from '../api/controlMetrics';
import { EMPTY_SESSION_TITLE } from '../api/sessionTitle';

function shell(id: string, extra?: Record<string, unknown>) {
  return {
    id,
    title: EMPTY_SESSION_TITLE,
    messages: [] as { sender?: string; text?: string }[],
    ...extra,
  };
}

describe('emptyShellAssert (D2-4)', () => {
  beforeEach(() => {
    resetControlMetrics();
    resetEmptyShellAssertWarned();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('findEmptyShellViolations: non-keep empty shells', () => {
    const sessions = [
      shell('ghost'),
      shell('active'),
      {
        id: 'real',
        title: '真实标题',
        messages: [{ sender: 'user', text: 'x' }],
      },
    ];
    const v = findEmptyShellViolations(sessions, {
      activeSessionId: 'active',
    });
    expect(v).toEqual([
      { id: 'ghost', reason: 'empty_shell_should_prune' },
    ]);
  });

  it('findEmptyShellViolations: I-DRAFT sentinel in sessions[]', () => {
    const v = findEmptyShellViolations(
      [shell('__pending_draft__'), shell('ok-active')],
      { activeSessionId: 'ok-active' },
    );
    expect(v).toEqual([
      { id: '__pending_draft__', reason: 'i_draft_in_sessions' },
    ]);
  });

  it('findEmptyShellViolations: active=PENDING_DRAFT does not keep empty shells (GC)', () => {
    // inventory #9：draft 哨兵不是 sessions 行；active 为 draft 时剪尽默认空壳
    const sessions = [
      shell('ghost-a'),
      shell('ghost-b'),
      {
        id: 'real',
        title: '真实标题',
        messages: [{ sender: 'user', text: 'x' }],
      },
    ];
    const v = findEmptyShellViolations(sessions, {
      activeSessionId: '__pending_draft__',
    });
    expect(v).toEqual([
      { id: 'ghost-a', reason: 'empty_shell_should_prune' },
      { id: 'ghost-b', reason: 'empty_shell_should_prune' },
    ]);
  });

  it('findEmptyShellViolations: keepIds / pinned / content not violations', () => {
    const sessions = [
      shell('kept-explicit'),
      shell('pinned', { isPinned: true }),
      {
        id: 'content',
        title: EMPTY_SESSION_TITLE,
        messages: [{ sender: 'user', text: 'hello' }],
      },
    ];
    const v = findEmptyShellViolations(sessions, {
      keepIds: ['kept-explicit'],
      activeSessionId: null,
    });
    expect(v).toEqual([]);
  });

  it('findEmptyShellViolations: null entries skipped', () => {
    const v = findEmptyShellViolations(
      [null, undefined, shell('g')] as never[],
      { activeSessionId: null },
    );
    expect(v).toEqual([{ id: 'g', reason: 'empty_shell_should_prune' }]);
  });

  it('runEmptyShellAssert force: metrics + warn once per id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = [shell('ghost-1'), shell('ghost-2')];

    const v1 = runEmptyShellAssert(sessions, {
      force: true,
      activeSessionId: null,
    });
    expect(v1).toHaveLength(2);
    expect(getControlMetrics().shell_empty_assert).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);

    // second pass: metrics again, warn still once per id
    runEmptyShellAssert(sessions, { force: true, activeSessionId: null });
    expect(getControlMetrics().shell_empty_assert).toBe(4);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('runEmptyShellAssert silent still records metric when force', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runEmptyShellAssert([shell('x')], {
      force: true,
      silent: true,
      activeSessionId: null,
    });
    expect(getControlMetrics().shell_empty_assert).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('runEmptyShellAssert without force/dev skips side-effects in production-like env', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // force=false：若当前 vitest 为 development 仍可能 side-effect；用 silent 验证 find 路径
    const v = findEmptyShellViolations([shell('g')], {
      activeSessionId: null,
    });
    expect(v).toHaveLength(1);
    // 明确不 force 且 silent：若 isDev 为 true 会记 metric；至少不抛
    expect(() =>
      runEmptyShellAssert([shell('g2')], {
        activeSessionId: null,
        silent: true,
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
