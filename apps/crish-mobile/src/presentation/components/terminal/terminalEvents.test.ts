// 终端页事件派生单测（F3 §4.1/§4.2 数据形态 → 终端行 + run 状态）
// 覆盖：跨窗口按 runId 过滤与 seq 排序、tool-update tool-progress 文本抽取、
// tool-args-delta 排除、task-output line/chunk、run 状态派生（agent-start/run-terminal 三态）。
import type { EventWindow, FeedEntry } from '@/domain/store/eventReducers';
import {
  collectRunTerminalChunks,
  deriveRunStatus,
  entriesOfRun,
  runTerminalStateOf,
} from './terminalEvents';

/** 测试夹具：构造 FeedEntry（信封扁平字段，receivedAtMs 本地附加） */
function makeFrame(
  type: string,
  overrides: Record<string, unknown> = {},
  receivedAtMs = 1_000
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    receivedAtMs,
    ...overrides,
  } as FeedEntry;
}

function windowOf(entries: FeedEntry[]): EventWindow {
  return {
    entries,
    lastSeq: 0,
    truncatedCount: 0,
  };
}

function toolUpdate(text: string, kind = 'tool-progress', runId = 'run-1') {
  return makeFrame('tool-update', {
    runId,
    update: { text, metadata: { kind } },
  });
}

function taskOutput(line: string, runId = 'run-1') {
  return makeFrame('task-output', { runId, line });
}

describe('entriesOfRun 跨窗口过滤与排序', () => {
  it('跨会话窗口展平 + runId 过滤', () => {
    const windows = {
      's-1': windowOf([
        makeFrame('tool-update', { runId: 'run-1' }),
        makeFrame('tool-update', { runId: 'run-2' }),
      ]),
      's-2': windowOf([makeFrame('task-output', { runId: 'run-1' })]),
    };
    const entries = entriesOfRun(windows, 'run-1');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.runId === 'run-1')).toBe(true);
  });

  it('seq 升序稳定排序（M6 §8.3 顺序契约）', () => {
    const windows = {
      's-1': windowOf([
        makeFrame('tool-update', { runId: 'run-1', sequence: 10 }),
        makeFrame('task-output', { runId: 'run-1', sequence: 3 }),
        makeFrame('tool-update', { runId: 'run-1', sequence: 7 }),
      ]),
    };
    const sequences = entriesOfRun(windows, 'run-1').map(
      (e) => (e as { sequence?: number }).sequence ?? 0
    );
    expect(sequences).toEqual([3, 7, 10]);
  });

  it('无窗口时返回空数组', () => {
    expect(entriesOfRun({}, 'run-1')).toEqual([]);
  });
});

describe('collectRunTerminalChunks 终端文本抽取（F3 §4.1 S1 协议）', () => {
  it('tool-update tool-progress 文本抽取', () => {
    const chunks = collectRunTerminalChunks([toolUpdate('build ok\n')]);
    expect(chunks).toEqual(['build ok\n']);
  });

  it('tool-args-delta 入参预览不进终端行', () => {
    const chunks = collectRunTerminalChunks([
      toolUpdate('{"path":"a.ts"}', 'tool-args-delta'),
      toolUpdate('真实输出'),
    ]);
    expect(chunks).toEqual(['真实输出']);
  });

  it('task-output 优先 line、兜底 chunk', () => {
    const chunks = collectRunTerminalChunks([
      taskOutput('行输出'),
      makeFrame('task-output', { runId: 'run-1', chunk: '块输出' }),
    ]);
    expect(chunks).toEqual(['行输出', '块输出']);
  });

  it('其它事件类型（message-delta/tool-start 等）不产生终端行', () => {
    const chunks = collectRunTerminalChunks([
      makeFrame('message-delta', { runId: 'run-1', text: '正文' }),
      makeFrame('tool-start', { runId: 'run-1', toolName: 'bash' }),
      makeFrame('run-terminal', { runId: 'run-1', terminal: 'completed' }),
    ]);
    expect(chunks).toEqual([]);
  });

  it('update 缺 text 或结构缺失时宽容跳过', () => {
    const chunks = collectRunTerminalChunks([
      makeFrame('tool-update', { runId: 'run-1' }),
      makeFrame('tool-update', { runId: 'run-1', update: 'not-record' }),
    ]);
    expect(chunks).toEqual([]);
  });
});

describe('run 状态派生（F1 §4.3 状态条数据面）', () => {
  it('agent-start → running（附开始时间）', () => {
    const status = deriveRunStatus(
      [makeFrame('agent-start', { runId: 'run-1' }, 5_000)],
      'run-1'
    );
    expect(status.state).toBe('running');
    expect(status.startedAtMs).toBe(5_000);
  });

  it('run-terminal completed → 已完成', () => {
    const status = deriveRunStatus(
      [
        makeFrame(
          'run-terminal',
          { runId: 'run-1', terminal: 'completed' },
          9_000
        ),
      ],
      'run-1'
    );
    expect(status.state).toBe('completed');
    expect(status.endedAtMs).toBe(9_000);
  });

  it('run-terminal cancelled → 已取消', () => {
    const status = deriveRunStatus(
      [makeFrame('run-terminal', { runId: 'run-1', terminal: 'cancelled' })],
      'run-1'
    );
    expect(status.state).toBe('cancelled');
  });

  it('run-terminal failed → 失败 + error 摘要（F3 §3.3.3）', () => {
    const status = deriveRunStatus(
      [
        makeFrame('agent-start', { runId: 'run-1' }),
        makeFrame('run-terminal', {
          runId: 'run-1',
          terminal: 'failed',
          error: 'exit code 1',
        }),
      ],
      'run-1'
    );
    expect(status.state).toBe('failed');
    expect(status.reason).toBe('exit code 1');
  });

  it('run-terminal 缺 error 时兜底 reason', () => {
    const status = deriveRunStatus(
      [
        makeFrame('run-terminal', {
          runId: 'run-1',
          terminal: 'failed',
          reason: '工具不存在',
        }),
      ],
      'run-1'
    );
    expect(status.reason).toBe('工具不存在');
  });

  it('无该 run 事件 → unknown（诚实化）', () => {
    const status = deriveRunStatus([], 'run-1');
    expect(status.state).toBe('unknown');
  });

  it('其它 run 的事件不影响本 run 状态', () => {
    const status = deriveRunStatus(
      [makeFrame('run-terminal', { runId: 'run-2', terminal: 'failed' })],
      'run-1'
    );
    expect(status.state).toBe('unknown');
  });

  it('runTerminalStateOf 未知值容错为 unknown', () => {
    expect(runTerminalStateOf('completed')).toBe('completed');
    expect(runTerminalStateOf('weird')).toBe('unknown');
    expect(runTerminalStateOf(undefined)).toBe('unknown');
  });
});
