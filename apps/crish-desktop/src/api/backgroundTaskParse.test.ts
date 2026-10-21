import { describe, expect, it } from 'vitest';
import {
  coerceText,
  parseBackgroundTask,
  parseBackgroundTaskStartedAt,
  parseBgTaskResourceSample,
} from './backgroundTaskParse';
import {
  backgroundTaskStateLabel,
  isBackgroundTaskActive,
  isBackgroundTaskState,
  isBackgroundTaskTerminal,
  normalizeBackgroundTaskId,
  normalizeBackgroundTaskState,
} from './backgroundTaskState';

describe('parseBackgroundTaskStartedAt', () => {
  it('接受有限数字原样返回', () => {
    expect(parseBackgroundTaskStartedAt(1_700_000_000_000)).toBe(
      1_700_000_000_000
    );
    expect(parseBackgroundTaskStartedAt(0)).toBe(0);
  });

  it('ISO 字符串解析为毫秒，带首尾空白也可', () => {
    expect(parseBackgroundTaskStartedAt('  2026-10-21T12:00:00Z ')).toBe(
      Date.UTC(2026, 9, 21, 12, 0, 0)
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['空串', '   '],
    ['不可解析串', 'not a date'],
    ['null', null],
    ['对象', { t: 1 }],
  ])('无效输入（%s）→ undefined', (_label, raw) => {
    expect(parseBackgroundTaskStartedAt(raw)).toBeUndefined();
  });
});

describe('coerceText', () => {
  it('trim 字符串，非字符串 → 空串', () => {
    expect(coerceText('  hi  ')).toBe('hi');
    expect(coerceText(42)).toBe('');
    expect(coerceText(undefined)).toBe('');
  });
});

describe('parseBgTaskResourceSample', () => {
  it('camelCase 字段优先', () => {
    expect(
      parseBgTaskResourceSample({
        sampledAtMs: 10,
        cpuPercent: 12.5,
        rssBytes: 2048,
        lastOutputAtMs: 9,
        sampled_at_ms: 99,
        cpu_percent: 99,
      })
    ).toEqual({
      sampledAtMs: 10,
      cpuPercent: 12.5,
      rssBytes: 2048,
      lastOutputAtMs: 9,
    });
  });

  it('snake_case 回退', () => {
    expect(
      parseBgTaskResourceSample({
        sampled_at_ms: 1,
        cpu_percent: 2,
        rss_bytes: 3,
        last_output_at_ms: 4,
      })
    ).toEqual({
      sampledAtMs: 1,
      cpuPercent: 2,
      rssBytes: 3,
      lastOutputAtMs: 4,
    });
  });

  it('非数值 / 非有限数被忽略；畸形根 → 空快照', () => {
    expect(
      parseBgTaskResourceSample({
        sampledAtMs: '10',
        cpuPercent: Number.NaN,
        rssBytes: Number.POSITIVE_INFINITY,
      })
    ).toEqual({});
    expect(parseBgTaskResourceSample(null)).toEqual({});
    expect(parseBgTaskResourceSample([1, 2])).toEqual({});
  });
});

describe('parseBackgroundTask', () => {
  it('非对象 / 数组 / 缺 id → null', () => {
    expect(parseBackgroundTask(null)).toBeNull();
    expect(parseBackgroundTask('task')).toBeNull();
    expect(parseBackgroundTask([{ id: 'a' }])).toBeNull();
    expect(parseBackgroundTask({ state: 'running' })).toBeNull();
    expect(parseBackgroundTask({ id: '   ' })).toBeNull();
  });

  it('仅 id 时：label 回退 id，state=unknown，不带任何可选字段', () => {
    expect(parseBackgroundTask({ id: ' t1 ' })).toEqual({
      id: 't1',
      label: 't1',
      state: 'unknown',
    });
  });

  it('id 别名 taskId / task_id 与数字 id', () => {
    expect(parseBackgroundTask({ taskId: 'a' })?.id).toBe('a');
    expect(parseBackgroundTask({ task_id: 'b' })?.id).toBe('b');
    expect(parseBackgroundTask({ id: 7 })?.id).toBe('7');
    expect(parseBackgroundTask({ id: Number.NaN })).toBeNull();
  });

  it('完整 camelCase 载荷全部映射', () => {
    const resource = { sampledAtMs: 5, cpuPercent: 1 };
    expect(
      parseBackgroundTask({
        id: 'job',
        status: 'In Progress',
        command: '  npm run build  ',
        label: ' Build ',
        startedAt: 100,
        summary: ' done 50% ',
        exitCode: 0,
        durationMs: 1500,
        finishedAtMs: 1600,
        lineCount: 42,
        lastOutputAtMs: 1550,
        resource,
        prompt: ' Continue? [y/N] ',
        sessionId: ' s-1 ',
        suspicious: false,
      })
    ).toEqual({
      id: 'job',
      label: 'Build',
      state: 'running',
      sessionId: 's-1',
      command: 'npm run build',
      startedAt: 100,
      summary: 'done 50%',
      exitCode: 0,
      durationMs: 1500,
      finishedAtMs: 1600,
      lineCount: 42,
      lastOutputAtMs: 1550,
      resource: { sampledAtMs: 5, cpuPercent: 1 },
      prompt: 'Continue? [y/N]',
      suspicious: false,
    });
  });

  it('snake_case 与次级别名回退', () => {
    expect(
      parseBackgroundTask({
        task_id: 'x',
        state: 'done',
        cmd: 'ls',
        name: '',
        title: ' Listing ',
        started_at: '2026-01-01T00:00:00Z',
        outputPreview: ' preview ',
        exit_code: 2,
        duration: 30,
        finished_at_ms: 40,
        line_count: 3,
        last_output_at_ms: 35,
        session_id: 'sess',
      })
    ).toEqual({
      id: 'x',
      label: 'Listing',
      state: 'succeeded',
      sessionId: 'sess',
      command: 'ls',
      startedAt: Date.UTC(2026, 0, 1),
      summary: 'preview',
      exitCode: 2,
      durationMs: 30,
      finishedAtMs: 40,
      lineCount: 3,
      lastOutputAtMs: 35,
    });
  });

  it('label 缺失时取命令前 64 字符', () => {
    const longCmd = 'x'.repeat(100);
    expect(parseBackgroundTask({ id: 'c', command: longCmd })?.label).toBe(
      'x'.repeat(64)
    );
  });

  it('summary 回退链：summary → outputPreview → detail；纯空白跳过', () => {
    expect(
      parseBackgroundTask({
        id: 'a',
        summary: '  ',
        outputPreview: ' ',
        detail: ' d ',
      })?.summary
    ).toBe('d');
    expect(parseBackgroundTask({ id: 'a', summary: ' ' })).not.toHaveProperty(
      'summary'
    );
  });

  it('finishedAt 作为第三级回退；字符串时间戳不解析', () => {
    expect(parseBackgroundTask({ id: 'a', finishedAt: 77 })?.finishedAtMs).toBe(
      77
    );
    const t = parseBackgroundTask({
      id: 'a',
      finishedAt: '2026-01-01',
      exitCode: '0',
      lineCount: Number.NaN,
    });
    expect(t).not.toHaveProperty('finishedAtMs');
    expect(t).not.toHaveProperty('exitCode');
    expect(t).not.toHaveProperty('lineCount');
  });

  it('resource: null 显式保留；非对象省略', () => {
    expect(parseBackgroundTask({ id: 'a', resource: null })).toHaveProperty(
      'resource',
      null
    );
    expect(
      parseBackgroundTask({ id: 'a', resource: 'busy' })
    ).not.toHaveProperty('resource');
  });

  it('非布尔 suspicious、空 prompt、空 sessionId 被省略', () => {
    const t = parseBackgroundTask({
      id: 'a',
      suspicious: 'yes',
      prompt: '   ',
      sessionId: ' ',
    });
    expect(t).toEqual({ id: 'a', label: 'a', state: 'unknown' });
  });
});

describe('backgroundTaskState', () => {
  it('normalizeBackgroundTaskId 只接受非空字符串与有限数字', () => {
    expect(normalizeBackgroundTaskId(' a ')).toBe('a');
    expect(normalizeBackgroundTaskId(3)).toBe('3');
    expect(normalizeBackgroundTaskId(undefined)).toBeNull();
    expect(normalizeBackgroundTaskId('')).toBeNull();
    expect(normalizeBackgroundTaskId(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeBackgroundTaskId(true)).toBeNull();
  });

  it.each([
    ['pending', 'queued'],
    ['IDLE', 'queued'],
    ['in_progress', 'running'],
    ['in progress', 'running'],
    ['Busy', 'running'],
    ['completed', 'succeeded'],
    ['OK', 'succeeded'],
    ['errored', 'failed'],
    ['canceled', 'cancelled'],
    ['stopped', 'cancelled'],
    ['terminated', 'killed'],
    ['timed_out', 'timed-out'],
    ['expired', 'timed-out'],
    ['unknown', 'unknown'],
    ['weird', 'unknown'],
    ['   ', 'unknown'],
  ])('normalizeBackgroundTaskState(%s) → %s', (raw, expected) => {
    expect(normalizeBackgroundTaskState(raw)).toBe(expected);
  });

  it('null/undefined → unknown', () => {
    expect(normalizeBackgroundTaskState(null)).toBe('unknown');
    expect(normalizeBackgroundTaskState(undefined)).toBe('unknown');
  });

  it('活跃 / 终态判定基于归一后的状态', () => {
    expect(isBackgroundTaskActive('pending')).toBe(true);
    expect(isBackgroundTaskActive('running')).toBe(true);
    expect(isBackgroundTaskActive('done')).toBe(false);
    expect(isBackgroundTaskTerminal('done')).toBe(true);
    expect(isBackgroundTaskTerminal('timeout')).toBe(true);
    expect(isBackgroundTaskTerminal('killed')).toBe(true);
    expect(isBackgroundTaskTerminal('running')).toBe(false);
    expect(isBackgroundTaskTerminal('???')).toBe(false);
  });

  it('isBackgroundTaskState 仅接受规范值', () => {
    expect(isBackgroundTaskState('running')).toBe(true);
    expect(isBackgroundTaskState('timed-out')).toBe(true);
    expect(isBackgroundTaskState('done')).toBe(false);
    expect(isBackgroundTaskState(1)).toBe(false);
  });

  it('状态标签：别名与未知输入均映射到对应规范状态的标签', () => {
    expect(backgroundTaskStateLabel('done')).toBe(
      backgroundTaskStateLabel('succeeded')
    );
    expect(backgroundTaskStateLabel({})).toBe(
      backgroundTaskStateLabel('unknown')
    );
    expect(backgroundTaskStateLabel('running')).not.toBe(
      backgroundTaskStateLabel('failed')
    );
  });
});
