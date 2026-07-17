import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ACTIVE_BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  BACKGROUND_TASK_STATE_LABELS,
  BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_TERMINAL_MAX_LINES,
  TERMINAL_BACKGROUND_TASK_STATES,
  backgroundTaskStateLabel,
  buildBackgroundTaskTerminalLines,
  canCancelBackgroundTask,
  cancelBackgroundTask,
  decideCancelBackgroundTask,
  dedupeBackgroundTasksById,
  extractBackgroundTaskArray,
  filterActiveBackgroundTasks,
  filterBackgroundTasks,
  filterTerminalBackgroundTasks,
  getBackgroundTaskOutput,
  isBackgroundTaskActive,
  isBackgroundTaskState,
  isBackgroundTaskTerminal,
  listBackgroundTasks,
  normalizeBackgroundTaskId,
  normalizeBackgroundTaskState,
  openBackgroundTaskInTerminal,
  parseBackgroundTask,
  parseBackgroundTaskList,
  parseBackgroundTaskOutput,
  parseBackgroundTaskStartedAt,
  parseCancelBackgroundTaskResult,
  resolveBackgroundTaskDisplayOutput,
  sortBackgroundTasksByStartedAt,
  type BackgroundTaskInfo,
} from './backgroundTasksApi';

vi.mock('./tauriInvoke', () => ({
  invokeCmd: vi.fn(),
}));

import { invokeCmd } from './tauriInvoke';

const mockedInvoke = vi.mocked(invokeCmd);

function task(
  partial: Partial<BackgroundTaskInfo> & Pick<BackgroundTaskInfo, 'id'>,
): BackgroundTaskInfo {
  return {
    label: partial.label ?? partial.id,
    state: partial.state ?? 'running',
    command: partial.command,
    startedAt: partial.startedAt,
    summary: partial.summary,
    id: partial.id,
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── id normalize ────────────────────────────────────────────────────

describe('normalizeBackgroundTaskId', () => {
  it('trims and rejects empty', () => {
    expect(normalizeBackgroundTaskId('  bg-1  ')).toBe('bg-1');
    expect(normalizeBackgroundTaskId('')).toBeNull();
    expect(normalizeBackgroundTaskId('   ')).toBeNull();
    expect(normalizeBackgroundTaskId(null)).toBeNull();
    expect(normalizeBackgroundTaskId(undefined)).toBeNull();
  });

  it('accepts finite numbers, rejects objects / NaN', () => {
    expect(normalizeBackgroundTaskId(42)).toBe('42');
    expect(normalizeBackgroundTaskId(Number.NaN)).toBeNull();
    expect(normalizeBackgroundTaskId({})).toBeNull();
    expect(normalizeBackgroundTaskId([])).toBeNull();
  });
});

// ── state normalize ─────────────────────────────────────────────────

describe('normalizeBackgroundTaskState', () => {
  it('maps canonical states', () => {
    for (const s of [
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed-out',
      'unknown',
    ] as const) {
      expect(normalizeBackgroundTaskState(s)).toBe(s);
    }
  });

  it('maps common aliases and case/underscore variants', () => {
    expect(normalizeBackgroundTaskState('PENDING')).toBe('queued');
    expect(normalizeBackgroundTaskState('in_progress')).toBe('running');
    expect(normalizeBackgroundTaskState('In Progress')).toBe('running');
    expect(normalizeBackgroundTaskState('success')).toBe('succeeded');
    expect(normalizeBackgroundTaskState('completed')).toBe('succeeded');
    expect(normalizeBackgroundTaskState('error')).toBe('failed');
    expect(normalizeBackgroundTaskState('canceled')).toBe('cancelled');
    expect(normalizeBackgroundTaskState('aborted')).toBe('cancelled');
    expect(normalizeBackgroundTaskState('timeout')).toBe('timed-out');
    expect(normalizeBackgroundTaskState('timed_out')).toBe('timed-out');
  });

  it('empty / unknown → unknown', () => {
    expect(normalizeBackgroundTaskState(null)).toBe('unknown');
    expect(normalizeBackgroundTaskState('')).toBe('unknown');
    expect(normalizeBackgroundTaskState('  ')).toBe('unknown');
    expect(normalizeBackgroundTaskState('weird-status')).toBe('unknown');
  });
});

describe('state predicates & labels', () => {
  it('isBackgroundTaskState guards the closed set', () => {
    expect(isBackgroundTaskState('running')).toBe(true);
    expect(isBackgroundTaskState('nope')).toBe(false);
    expect(BACKGROUND_TASK_STATES).toContain('unknown');
  });

  it('active vs terminal partitions', () => {
    for (const s of ACTIVE_BACKGROUND_TASK_STATES) {
      expect(isBackgroundTaskActive(s)).toBe(true);
      expect(isBackgroundTaskTerminal(s)).toBe(false);
    }
    for (const s of TERMINAL_BACKGROUND_TASK_STATES) {
      expect(isBackgroundTaskTerminal(s)).toBe(true);
      expect(isBackgroundTaskActive(s)).toBe(false);
    }
    expect(isBackgroundTaskActive('unknown')).toBe(false);
    expect(isBackgroundTaskTerminal('unknown')).toBe(false);
  });

  it('aliases work through predicates', () => {
    expect(isBackgroundTaskActive('in_progress')).toBe(true);
    expect(isBackgroundTaskTerminal('success')).toBe(true);
  });

  it('backgroundTaskStateLabel uses Chinese short labels', () => {
    expect(backgroundTaskStateLabel('running')).toBe('运行中');
    expect(backgroundTaskStateLabel('SUCCESS')).toBe('已完成');
    expect(backgroundTaskStateLabel('???')).toBe(BACKGROUND_TASK_STATE_LABELS.unknown);
  });
});

// ── startedAt ───────────────────────────────────────────────────────

describe('parseBackgroundTaskStartedAt', () => {
  it('accepts finite numbers and ISO strings', () => {
    expect(parseBackgroundTaskStartedAt(1_700_000_000_000)).toBe(1_700_000_000_000);
    const iso = '2024-01-02T03:04:05.000Z';
    expect(parseBackgroundTaskStartedAt(iso)).toBe(Date.parse(iso));
  });

  it('rejects invalid', () => {
    expect(parseBackgroundTaskStartedAt(Number.NaN)).toBeUndefined();
    expect(parseBackgroundTaskStartedAt('not-a-date')).toBeUndefined();
    expect(parseBackgroundTaskStartedAt('')).toBeUndefined();
    expect(parseBackgroundTaskStartedAt(null)).toBeUndefined();
    expect(parseBackgroundTaskStartedAt({})).toBeUndefined();
  });
});

// ── parse single task ───────────────────────────────────────────────

describe('parseBackgroundTask', () => {
  it('parses camelCase and snake_case ids / state / started', () => {
    const t = parseBackgroundTask({
      task_id: ' t1 ',
      status: 'in_progress',
      name: 'Build',
      cmd: 'npm run build',
      started_at: 100,
      summary: ' building ',
    });
    expect(t).toEqual({
      id: 't1',
      label: 'Build',
      state: 'running',
      command: 'npm run build',
      startedAt: 100,
      summary: 'building',
    });
  });

  it('accepts title and outputPreview as label/summary fallbacks', () => {
    const t = parseBackgroundTask({
      id: 'x',
      title: 'Dev server',
      state: 'running',
      outputPreview: 'listening on 5173',
    });
    expect(t?.label).toBe('Dev server');
    expect(t?.summary).toBe('listening on 5173');
  });

  it('label falls back to command slice then id', () => {
    const long = 'x'.repeat(80);
    expect(parseBackgroundTask({ id: 'a', command: long })?.label).toBe(long.slice(0, 64));
    expect(parseBackgroundTask({ id: 'only-id' })?.label).toBe('only-id');
  });

  it('returns null without id or non-object', () => {
    expect(parseBackgroundTask(null)).toBeNull();
    expect(parseBackgroundTask('x')).toBeNull();
    expect(parseBackgroundTask({ label: 'no-id' })).toBeNull();
    expect(parseBackgroundTask({ id: '  ' })).toBeNull();
  });
});

// ── extract / parse list / empty paths ──────────────────────────────

describe('extractBackgroundTaskArray & parseBackgroundTaskList', () => {
  it('empty / error shapes → []', () => {
    expect(extractBackgroundTaskArray(null)).toEqual([]);
    expect(extractBackgroundTaskArray(undefined)).toEqual([]);
    expect(extractBackgroundTaskArray(42)).toEqual([]);
    expect(extractBackgroundTaskArray('oops')).toEqual([]);
    expect(extractBackgroundTaskArray({ foo: 1 })).toEqual([]);
    expect(parseBackgroundTaskList(null)).toEqual([]);
    expect(parseBackgroundTaskList({ tasks: null })).toEqual([]);
  });

  it('supports direct array and { tasks | items | backgroundTasks }', () => {
    expect(extractBackgroundTaskArray([{ id: 'a' }])).toHaveLength(1);
    expect(extractBackgroundTaskArray({ tasks: [{ id: 'a' }] })).toHaveLength(1);
    expect(extractBackgroundTaskArray({ items: [{ id: 'b' }] })).toHaveLength(1);
    expect(extractBackgroundTaskArray({ backgroundTasks: [{ id: 'c' }] })).toHaveLength(1);
    expect(extractBackgroundTaskArray({ data: [{ id: 'd' }] })).toHaveLength(1);
    expect(extractBackgroundTaskArray({ data: { tasks: [{ id: 'e' }] } })).toHaveLength(1);
  });

  it('skips invalid rows and normalizes survivors', () => {
    const list = parseBackgroundTaskList({
      tasks: [
        null,
        1,
        { id: '' },
        { id: 'ok', state: 'SUCCESS', label: 'A' },
        { taskId: 'ok2', status: 'failed' },
      ],
    });
    expect(list.map((t) => t.id)).toEqual(['ok', 'ok2']);
    expect(list[0].state).toBe('succeeded');
    expect(list[1].state).toBe('failed');
  });

  it('dedupes by id keeping first occurrence', () => {
    const list = parseBackgroundTaskList([
      { id: 'dup', label: 'first', state: 'running' },
      { id: 'dup', label: 'second', state: 'failed' },
      { id: ' other ', label: 'third', state: 'queued' },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'dup', label: 'first', state: 'running' });
    expect(list[1].id).toBe('other');
  });
});

describe('dedupeBackgroundTasksById', () => {
  it('returns empty for empty input', () => {
    expect(dedupeBackgroundTasksById([])).toEqual([]);
  });

  it('keeps first id and skips blank ids', () => {
    const a = task({ id: '1', label: 'a' });
    const b = task({ id: '1', label: 'b' });
    const blank = { ...task({ id: 'x' }), id: '  ' };
    expect(dedupeBackgroundTasksById([a, b, blank as BackgroundTaskInfo])).toEqual([a]);
  });
});

// ── filter / sort ───────────────────────────────────────────────────

describe('filterBackgroundTasks', () => {
  const sample: BackgroundTaskInfo[] = [
    task({ id: 'r1', state: 'running', label: 'Vite', command: 'npm run dev' }),
    task({ id: 'q1', state: 'queued', label: 'Wait', command: 'sleep 1' }),
    task({ id: 's1', state: 'succeeded', label: 'Build', command: 'npm run build' }),
    task({ id: 'f1', state: 'failed', label: 'Test', command: 'npm test' }),
  ];

  it('nullish / empty → []', () => {
    expect(filterBackgroundTasks(null)).toEqual([]);
    expect(filterBackgroundTasks(undefined)).toEqual([]);
    expect(filterBackgroundTasks([])).toEqual([]);
  });

  it('filters by states set', () => {
    const out = filterBackgroundTasks(sample, { states: ['failed', 'succeeded'] });
    expect(out.map((t) => t.id).sort()).toEqual(['f1', 's1']);
  });

  it('activeOnly true/false', () => {
    expect(filterActiveBackgroundTasks(sample).map((t) => t.id).sort()).toEqual([
      'q1',
      'r1',
    ]);
    expect(filterTerminalBackgroundTasks(sample).map((t) => t.id).sort()).toEqual([
      'f1',
      's1',
    ]);
  });

  it('query matches label / command / id case-insensitively', () => {
    expect(filterBackgroundTasks(sample, { query: 'VITE' }).map((t) => t.id)).toEqual([
      'r1',
    ]);
    expect(filterBackgroundTasks(sample, { query: 'npm test' }).map((t) => t.id)).toEqual([
      'f1',
    ]);
    expect(filterBackgroundTasks(sample, { query: 'r1' }).map((t) => t.id)).toEqual([
      'r1',
    ]);
    expect(filterBackgroundTasks(sample, { query: '   ' })).toHaveLength(4);
  });

  it('combines activeOnly with query', () => {
    expect(
      filterBackgroundTasks(sample, { activeOnly: true, query: 'npm' }).map((t) => t.id),
    ).toEqual(['r1']);
  });
});

describe('sortBackgroundTasksByStartedAt', () => {
  it('sorts newer first; missing startedAt last; stable by id', () => {
    const list = [
      task({ id: 'b', startedAt: 10 }),
      task({ id: 'a', startedAt: 20 }),
      task({ id: 'z' }),
      task({ id: 'm', startedAt: 20 }),
    ];
    expect(sortBackgroundTasksByStartedAt(list).map((t) => t.id)).toEqual([
      'a',
      'm',
      'b',
      'z',
    ]);
  });

  it('empty → [] and does not mutate input', () => {
    expect(sortBackgroundTasksByStartedAt([])).toEqual([]);
    const input = [task({ id: 'x', startedAt: 1 }), task({ id: 'y', startedAt: 2 })];
    const copy = [...input];
    sortBackgroundTasksByStartedAt(input);
    expect(input).toEqual(copy);
  });
});

// ── output ──────────────────────────────────────────────────────────

describe('parseBackgroundTaskOutput', () => {
  it('handles null / string / object fields', () => {
    expect(parseBackgroundTaskOutput(null)).toBe('');
    expect(parseBackgroundTaskOutput(undefined)).toBe('');
    expect(parseBackgroundTaskOutput('hello')).toBe('hello');
    expect(parseBackgroundTaskOutput({ output: 'o' })).toBe('o');
    expect(parseBackgroundTaskOutput({ text: 't' })).toBe('t');
    expect(parseBackgroundTaskOutput({ content: 'c' })).toBe('c');
    expect(parseBackgroundTaskOutput({ outputPreview: 'p' })).toBe('p');
  });

  it('stringifies plain objects and numbers', () => {
    expect(parseBackgroundTaskOutput({ foo: 1 })).toContain('"foo"');
    expect(parseBackgroundTaskOutput(0)).toBe('0');
  });
});

describe('buildBackgroundTaskTerminalLines', () => {
  it('uses placeholder for empty and splits CRLF', () => {
    expect(buildBackgroundTaskTerminalLines(null)).toEqual([
      BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
    ]);
    expect(buildBackgroundTaskTerminalLines('')).toEqual([
      BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
    ]);
    expect(buildBackgroundTaskTerminalLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('caps at max lines and sanitizes bad cap', () => {
    const many = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n');
    expect(buildBackgroundTaskTerminalLines(many)).toHaveLength(
      BACKGROUND_TASK_TERMINAL_MAX_LINES,
    );
    expect(buildBackgroundTaskTerminalLines(many, 3)).toEqual(['L0', 'L1', 'L2']);
    expect(buildBackgroundTaskTerminalLines('a\nb', 0)[0]).toBe('a');
    expect(buildBackgroundTaskTerminalLines('a\nb', Number.NaN)).toHaveLength(2);
  });
});

describe('resolveBackgroundTaskDisplayOutput', () => {
  it('prefers output then summary then command then fallbacks', () => {
    const t = task({ id: '1', summary: 'sum', command: 'cmd' });
    expect(resolveBackgroundTaskDisplayOutput('out', t)).toBe('out');
    expect(resolveBackgroundTaskDisplayOutput('', t)).toBe('sum');
    expect(resolveBackgroundTaskDisplayOutput(null, { command: 'cmd' })).toBe('cmd');
    expect(
      resolveBackgroundTaskDisplayOutput(null, null, { errorFallback: '读取失败' }),
    ).toBe('读取失败');
    expect(resolveBackgroundTaskDisplayOutput(null)).toBe(
      BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
    );
  });
});

// ── cancel semantics ────────────────────────────────────────────────

describe('canCancelBackgroundTask & decideCancelBackgroundTask', () => {
  it('canCancel only for active tasks with id', () => {
    expect(canCancelBackgroundTask(null)).toBe(false);
    expect(canCancelBackgroundTask(task({ id: '1', state: 'running' }))).toBe(true);
    expect(canCancelBackgroundTask(task({ id: '1', state: 'queued' }))).toBe(true);
    expect(canCancelBackgroundTask(task({ id: '1', state: 'succeeded' }))).toBe(false);
    expect(canCancelBackgroundTask(task({ id: '1', state: 'unknown' }))).toBe(false);
    expect(canCancelBackgroundTask({ id: '', state: 'running' })).toBe(false);
  });

  it('decide: missing_id / not_found / not_cancellable / ok', () => {
    expect(decideCancelBackgroundTask('')).toEqual({ ok: false, reason: 'missing_id' });
    expect(decideCancelBackgroundTask('  ')).toEqual({ ok: false, reason: 'missing_id' });

    const list = [
      task({ id: 'run', state: 'running' }),
      task({ id: 'done', state: 'succeeded' }),
    ];
    expect(decideCancelBackgroundTask('missing', list)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(decideCancelBackgroundTask('done', list)).toEqual({
      ok: false,
      reason: 'not_cancellable',
      state: 'succeeded',
    });
    expect(decideCancelBackgroundTask(' run ', list)).toEqual({
      ok: true,
      taskId: 'run',
    });
    // 无列表时仅校验 id
    expect(decideCancelBackgroundTask('any-id')).toEqual({ ok: true, taskId: 'any-id' });
  });
});

describe('parseCancelBackgroundTaskResult', () => {
  it('parses wrapped task or direct object; null on bad', () => {
    expect(
      parseCancelBackgroundTaskResult({
        task: { id: 'c1', state: 'cancelled', title: 'X' },
      }),
    ).toMatchObject({ id: 'c1', state: 'cancelled', label: 'X' });
    expect(
      parseCancelBackgroundTaskResult({ id: 'c2', status: 'canceled' }),
    ).toMatchObject({ id: 'c2', state: 'cancelled' });
    expect(parseCancelBackgroundTaskResult(null)).toBeNull();
    expect(parseCancelBackgroundTaskResult({ task: { label: 'no-id' } })).toBeNull();
  });
});

// ── async wrappers (invoke mocked) ──────────────────────────────────

describe('listBackgroundTasks', () => {
  it('returns [] when invoke returns null', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    await expect(listBackgroundTasks()).resolves.toEqual([]);
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_list_background_tasks');
  });

  it('parses and dedupes invoke payload', async () => {
    mockedInvoke.mockResolvedValueOnce({
      tasks: [
        { id: 'a', state: 'running', label: 'A' },
        { id: 'a', state: 'failed', label: 'dup' },
        { id: 'b', status: 'success' },
      ],
    });
    const list = await listBackgroundTasks();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'a', label: 'A', state: 'running' });
    expect(list[1]).toMatchObject({ id: 'b', state: 'succeeded' });
  });
});

describe('getBackgroundTaskOutput', () => {
  it('returns empty for blank id without invoke', async () => {
    await expect(getBackgroundTaskOutput('  ')).resolves.toBe('');
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('trims id and parses payload', async () => {
    mockedInvoke.mockResolvedValueOnce({ output: 'log line' });
    await expect(getBackgroundTaskOutput('  tid  ')).resolves.toBe('log line');
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_get_background_task_output', {
      taskId: 'tid',
    });
  });

  it('null invoke → empty string', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    await expect(getBackgroundTaskOutput('x')).resolves.toBe('');
  });
});

describe('cancelBackgroundTask', () => {
  it('skips invoke when pure decision fails', async () => {
    await expect(cancelBackgroundTask('')).resolves.toBeNull();
    await expect(
      cancelBackgroundTask('done', [task({ id: 'done', state: 'failed' })]),
    ).resolves.toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('invokes and parses cancelled task', async () => {
    mockedInvoke.mockResolvedValueOnce({
      task: { id: 'run', state: 'cancelled', title: 'Job' },
    });
    const known = [task({ id: 'run', state: 'running' })];
    const res = await cancelBackgroundTask('run', known);
    expect(res).toMatchObject({ id: 'run', state: 'cancelled', label: 'Job' });
    expect(mockedInvoke).toHaveBeenCalledWith('workbench_cancel_background_task', {
      taskId: 'run',
    });
  });

  it('null invoke → null', async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    await expect(cancelBackgroundTask('x')).resolves.toBeNull();
  });
});

// ── terminal open (DOM events) ──────────────────────────────────────

describe('openBackgroundTaskInTerminal', () => {
  it('dispatches append + open-terminal with capped lines', () => {
    const events: CustomEvent[] = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((ev: Event) => {
      events.push(ev as CustomEvent);
      return true;
    });
    try {
      openBackgroundTaskInTerminal('T', 'line1\nline2');
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('crish-terminal-append');
      expect(events[0].detail).toEqual({
        title: 'T',
        lines: ['line1', 'line2'],
      });
      expect(events[1].type).toBe('crish-open-terminal');

      events.length = 0;
      openBackgroundTaskInTerminal('Empty', '');
      expect(events[0].detail.lines).toEqual([BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER]);
    } finally {
      spy.mockRestore();
    }
  });
});
