import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  cancelToolBackgroundTask,
  listToolBackgroundTasks,
  parseToolBackgroundPlaceholder,
  parseToolBackgroundTask,
  parseToolBackgroundTaskList,
  toolBackgroundElapsedMs,
} from './toolBackgroundApi';

vi.mock('./tauriInvoke', () => ({
  invokeResult: vi.fn(),
  invokeTyped: vi.fn(),
}));

import { invokeTyped } from './tauriInvoke';

const mockedInvokeTyped = vi.mocked(invokeTyped);

beforeEach(() => {
  mockedInvokeTyped.mockReset();
});

describe('parseToolBackgroundTask', () => {
  it('解析 running 条目（camelCase wire）', () => {
    expect(
      parseToolBackgroundTask({
        callId: 'c1',
        toolName: 'web_search',
        state: 'running',
        queuedAtMs: 1000,
        startedAtMs: 1200,
        settledAtMs: null,
        durationMs: 5000,
      })
    ).toEqual({
      callId: 'c1',
      toolName: 'web_search',
      state: 'running',
      queuedAtMs: 1000,
      startedAtMs: 1200,
    });
  });

  it('排队条目 startedAtMs 为 null', () => {
    const parsed = parseToolBackgroundTask({
      callId: 'c2',
      toolName: 'search_context',
      state: 'queued',
      queuedAtMs: 2000,
      startedAtMs: null,
    });
    expect(parsed?.state).toBe('queued');
    expect(parsed?.startedAtMs).toBeNull();
  });

  it('终态 / 缺 id / 畸形一律 null', () => {
    expect(
      parseToolBackgroundTask({ callId: 'c1', state: 'settled-ok' })
    ).toBeNull();
    expect(parseToolBackgroundTask({ state: 'running' })).toBeNull();
    expect(parseToolBackgroundTask(null)).toBeNull();
    expect(parseToolBackgroundTask('running')).toBeNull();
  });
});

describe('parseToolBackgroundTaskList', () => {
  it('接受裸数组与 { tasks } 两形，过滤终态与畸形', () => {
    const wire = [
      {
        callId: 'a',
        toolName: 't1',
        state: 'running',
        queuedAtMs: 1,
        startedAtMs: 2,
      },
      {
        callId: 'b',
        toolName: 't2',
        state: 'cancelled',
        queuedAtMs: 1,
        startedAtMs: 2,
      },
      { nope: true },
    ];
    expect(parseToolBackgroundTaskList(wire).map((t) => t.callId)).toEqual([
      'a',
    ]);
    expect(
      parseToolBackgroundTaskList({ tasks: wire }).map((t) => t.callId)
    ).toEqual(['a']);
    expect(parseToolBackgroundTaskList(undefined)).toEqual([]);
    expect(parseToolBackgroundTaskList({})).toEqual([]);
  });
});

describe('parseToolBackgroundPlaceholder', () => {
  it('识别 BG2 占位信封', () => {
    const output = JSON.stringify({
      mode: 'background',
      callId: 'call-9',
      toolName: 'web_search',
      elapsedMs: 20000,
      note: '该工具已转入后台继续执行，尚未完成。',
    });
    expect(parseToolBackgroundPlaceholder(output)).toEqual({
      callId: 'call-9',
      toolName: 'web_search',
      elapsedMs: 20000,
    });
  });

  it('普通输出 / 残缺信封 / 非 JSON 一律 null', () => {
    expect(parseToolBackgroundPlaceholder('普通文本结果')).toBeNull();
    expect(
      parseToolBackgroundPlaceholder(JSON.stringify({ mode: 'background' }))
    ).toBeNull();
    expect(
      parseToolBackgroundPlaceholder(
        JSON.stringify({ mode: 'other', callId: 'x', elapsedMs: 1 })
      )
    ).toBeNull();
    expect(parseToolBackgroundPlaceholder('')).toBeNull();
    expect(parseToolBackgroundPlaceholder(undefined)).toBeNull();
  });
});

describe('toolBackgroundElapsedMs', () => {
  const ph = { callId: 'c1', toolName: 't', elapsedMs: 20000 };
  it('completedAt 锚点：信封时长 + 落盘后墙钟', () => {
    expect(
      toolBackgroundElapsedMs(ph, { startedAt: 0, completedAt: 21000 }, 31000)
    ).toBe(30000);
  });
  it('缺 completedAt 时以 startedAt + elapsedMs 为锚', () => {
    expect(toolBackgroundElapsedMs(ph, { startedAt: 1000 }, 31000)).toBe(30000);
  });
  it('无锚点时只报信封时长；now 早于锚点不负增长', () => {
    expect(toolBackgroundElapsedMs(ph, {}, 31000)).toBe(20000);
    expect(toolBackgroundElapsedMs(ph, { completedAt: 99000 }, 31000)).toBe(
      20000
    );
  });
});

describe('listToolBackgroundTasks', () => {
  it('ok 时解析快照并带 sessionId 调用', async () => {
    mockedInvokeTyped.mockResolvedValue({
      status: 'ok',
      data: [
        {
          callId: 'a',
          toolName: 't',
          state: 'running',
          queuedAtMs: 1,
          startedAtMs: 2,
        },
      ],
    });
    await expect(listToolBackgroundTasks('s1')).resolves.toHaveLength(1);
    expect(mockedInvokeTyped).toHaveBeenCalledWith(
      'core_list_tool_background_tasks',
      { sessionId: 's1' }
    );
  });

  it('missing / error / 空 sessionId 归一为空数组且不抛', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'missing' });
    await expect(listToolBackgroundTasks('s1')).resolves.toEqual([]);
    mockedInvokeTyped.mockResolvedValue({
      status: 'error',
      kind: 'Internal',
      message: 'boom',
    });
    await expect(listToolBackgroundTasks('s1')).resolves.toEqual([]);
    mockedInvokeTyped.mockClear();
    await expect(listToolBackgroundTasks('  ')).resolves.toEqual([]);
    expect(mockedInvokeTyped).not.toHaveBeenCalled();
  });
});

describe('cancelToolBackgroundTask', () => {
  it('ok 且返回 true 才算取消生效', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'ok', data: true });
    await expect(cancelToolBackgroundTask('c1')).resolves.toBe(true);
    expect(mockedInvokeTyped).toHaveBeenCalledWith(
      'core_cancel_tool_background_task',
      { callId: 'c1' }
    );
    mockedInvokeTyped.mockResolvedValue({ status: 'ok', data: false });
    await expect(cancelToolBackgroundTask('c1')).resolves.toBe(false);
  });

  it('missing / error / 空 id 归一为 false 且不抛', async () => {
    mockedInvokeTyped.mockResolvedValue({ status: 'missing' });
    await expect(cancelToolBackgroundTask('c1')).resolves.toBe(false);
    mockedInvokeTyped.mockResolvedValue({
      status: 'error',
      kind: 'Internal',
      message: 'boom',
    });
    await expect(cancelToolBackgroundTask('c1')).resolves.toBe(false);
    mockedInvokeTyped.mockClear();
    await expect(cancelToolBackgroundTask('')).resolves.toBe(false);
    expect(mockedInvokeTyped).not.toHaveBeenCalled();
  });
});
