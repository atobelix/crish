import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createClientMessageId,
  ensureClientMessageId,
  pickStableMessageId,
} from './message-identity';
import {
  SPLIT_LAYOUT_MAX_PANES,
  createSingleSessionLayout,
  validateSplitLayout,
  type SplitLayout,
  type SplitLayoutNode,
} from './session-workspace';
import { DEFAULT_RECURSION_GUARD } from './subagent';
import { createTypedInvoke } from './validators/typed-invoke';
import { RunTaskResponseSchema } from './validators/ipc-schemas';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('message-identity 默认 id 工厂', () => {
  it('有 crypto.randomUUID 时使用之', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-fixed' });
    expect(createClientMessageId()).toBe('uuid-fixed');
    const msg: { clientMessageId?: string } = {};
    expect(ensureClientMessageId(msg)).toBe('uuid-fixed');
    expect(msg.clientMessageId).toBe('uuid-fixed');
  });

  it('无 crypto.randomUUID 时退化为 cmsg-<时间36进制>-<随机> 且多次调用不重复', () => {
    vi.stubGlobal('crypto', undefined);
    const a = createClientMessageId();
    const b = createClientMessageId();
    expect(a).toMatch(/^cmsg-[0-9a-z]+-[0-9a-z]{1,8}$/);
    expect(a).not.toBe(b);

    vi.stubGlobal('crypto', { randomUUID: 'not-a-function' });
    expect(createClientMessageId()).toMatch(/^cmsg-/);
  });
});

describe('pickStableMessageId 读取 metadata.promptContext', () => {
  it('metadata 顶层无 client 键时回落到 promptContext，按 assistantClientMessageId > clientMessageId > client_message_id', () => {
    expect(
      pickStableMessageId({
        id: 'engine-1',
        metadata: {
          promptContext: {
            clientMessageId: 'c1',
            assistantClientMessageId: ' a1 ',
          },
        },
      })
    ).toBe('a1');
    expect(
      pickStableMessageId({
        id: 'engine-1',
        metadata: { promptContext: { client_message_id: 'c2' } },
      })
    ).toBe('c2');
  });

  it('promptContext 为数组/空白值时忽略并回落到引擎 id', () => {
    expect(
      pickStableMessageId({
        id: 'engine-2',
        metadata: { promptContext: ['x'] },
      })
    ).toBe('engine-2');
    expect(
      pickStableMessageId({
        message_id: 'engine-3',
        metadata: { promptContext: { clientMessageId: '   ' } },
      })
    ).toBe('engine-3');
  });
});

describe('validateSplitLayout 面板上限', () => {
  const chain = (ids: string[]): SplitLayoutNode =>
    ids.length === 1
      ? { type: 'pane', paneId: ids[0]! }
      : {
          type: 'split',
          axis: 'horizontal',
          ratio: 0.5,
          first: { type: 'pane', paneId: ids[0]! },
          second: chain(ids.slice(1)),
        };

  const layoutWith = (n: number): SplitLayout => {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const base = createSingleSessionLayout({
      layoutId: 'L',
      paneId: 'p0',
      sessionId: 's',
      updatedAt: 't',
    });
    return {
      ...base,
      panes: ids.map((paneId) => ({
        paneId,
        sessionId: `s-${paneId}`,
        role: 'secondary' as const,
      })),
      root: chain(ids),
    };
  };

  it(`恰好 ${SPLIT_LAYOUT_MAX_PANES} 个面板合法`, () => {
    expect(validateSplitLayout(layoutWith(SPLIT_LAYOUT_MAX_PANES))).toEqual({
      ok: true,
      issues: [],
    });
  });

  it(`超过 ${SPLIT_LAYOUT_MAX_PANES} 个面板报 too-many-panes（且只报这一条）`, () => {
    const r = validateSplitLayout(layoutWith(SPLIT_LAYOUT_MAX_PANES + 1));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['too-many-panes']);
    expect(r.issues[0]!.message).toContain(String(SPLIT_LAYOUT_MAX_PANES));
  });
});

describe('DEFAULT_RECURSION_GUARD（与 Rust 侧同值同语义）', () => {
  it('嵌套禁止、兄弟 5、并发 12、预算/超时不限', () => {
    expect(DEFAULT_RECURSION_GUARD).toEqual({
      maxDepth: 1,
      maxSiblings: 5,
      maxConcurrent: 12,
      totalTokenBudget: 0,
      totalTimeoutMs: 0,
    });
  });
});

describe('createTypedInvoke', () => {
  it('透传命令与参数，响应符合 schema 时返回解析结果', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ runId: 'r1', status: 'running', extra: 'dropped' });
    const typed = createTypedInvoke(invoke);
    await expect(
      typed('run_task', { goal: 'x' }, RunTaskResponseSchema)
    ).resolves.toEqual({
      runId: 'r1',
      status: 'running',
    });
    expect(invoke).toHaveBeenCalledWith('run_task', { goal: 'x' });
  });

  it('响应形状不符时抛出带命令名的错误并记录 schema 违规', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const typed = createTypedInvoke(async () => ({ runId: 42 }));
    await expect(
      typed('run_task', undefined, RunTaskResponseSchema)
    ).rejects.toThrow(/IPC response validation failed for "run_task"/);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]![0])).toContain('"run_task"');
  });

  it('底层 invoke 拒绝时原样向上抛出', async () => {
    const boom = new Error('ipc down');
    const typed = createTypedInvoke(async () => {
      throw boom;
    });
    await expect(typed('x', undefined, z.unknown())).rejects.toBe(boom);
  });
});
