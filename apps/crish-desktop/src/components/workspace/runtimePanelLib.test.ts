/**
 * RuntimePanel 文案纯函数：时长 / 空态 / aria / 计数。
 */
import { describe, expect, it } from 'vitest';
import {
  emptyBgTasksHint,
  emptyLiveTasksHint,
  emptyPlansHint,
  formatBgTaskMeta,
  formatElapsed,
  formatEngineStatusFull,
  formatEngineStatusShort,
  formatEngineStatusTitle,
  formatSectionCount,
  formatUsageRingAria,
  liveTaskAriaLabel,
} from './runtimePanelLib';

describe('formatElapsed', () => {
  it('seconds under one minute', () => {
    expect(formatElapsed(0)).toBe('0 秒');
    expect(formatElapsed(59)).toBe('59 秒');
  });

  it('minutes with remainder seconds', () => {
    expect(formatElapsed(60)).toBe('1 分 0 秒');
    expect(formatElapsed(125)).toBe('2 分 5 秒');
  });

  it('hours with remainder minutes', () => {
    expect(formatElapsed(3600)).toBe('1 时 0 分');
    expect(formatElapsed(7325)).toBe('2 时 2 分');
  });

  it('clamps negative / fractional input', () => {
    expect(formatElapsed(-5)).toBe('0 秒');
    expect(formatElapsed(90.9)).toBe('1 分 30 秒');
  });
});

describe('engine status copy', () => {
  it('short / full / title follow ConnectionStatus 四态（D2 投影）', () => {
    expect(formatEngineStatusShort('connected')).toBe('就绪');
    expect(formatEngineStatusShort('reconnecting')).toBe('重连中');
    expect(formatEngineStatusShort('waiting')).toBe('连接中');
    expect(formatEngineStatusShort('disconnected')).toBe('未就绪');
    expect(formatEngineStatusShort('degraded')).toBe('降级');
    expect(formatEngineStatusFull('connected')).toBe('引擎就绪');
    expect(formatEngineStatusFull('disconnected')).toBe('引擎未就绪');
    expect(formatEngineStatusFull('reconnecting')).toBe('引擎重连中');
    expect(formatEngineStatusTitle('connected')).toMatch(/已连接/);
    expect(formatEngineStatusTitle('disconnected')).toMatch(/未连接/);
    expect(formatEngineStatusTitle('reconnecting')).toMatch(/重连/);
  });
});

describe('empty hints split offline vs empty', () => {
  it('live / bg / plans（connected → 空态文案；其余连接态 → 未连接）', () => {
    expect(emptyLiveTasksHint('connected')).toMatch(/暂无/);
    expect(emptyLiveTasksHint('disconnected')).toBe('未连接');
    expect(emptyLiveTasksHint('reconnecting')).toBe('未连接');
    expect(emptyBgTasksHint('connected')).toMatch(/暂无/);
    expect(emptyBgTasksHint('disconnected')).toBe('未连接');
    expect(emptyBgTasksHint('waiting')).toBe('未连接');
    expect(emptyPlansHint('connected')).toMatch(/暂无/);
    expect(emptyPlansHint('disconnected')).toBe('未连接');
    expect(emptyPlansHint('degraded')).toBe('未连接');
  });
});

describe('formatSectionCount', () => {
  it('hides zero / negatives, keeps positive', () => {
    expect(formatSectionCount(0)).toBeNull();
    expect(formatSectionCount(-2)).toBeNull();
    expect(formatSectionCount(1)).toBe('1');
    expect(formatSectionCount(12)).toBe('12');
  });
});

describe('liveTaskAriaLabel', () => {
  it('names task with elapsed and optional session hint', () => {
    expect(
      liveTaskAriaLabel({ taskName: '重构', elapsedSeconds: 65, hasSession: true }),
    ).toBe('重构，已运行 1 分 5 秒，点击打开对应会话');
    expect(
      liveTaskAriaLabel({ taskName: '  ', elapsedSeconds: 3, hasSession: false }),
    ).toBe('引擎任务，已运行 3 秒');
  });
});

describe('formatBgTaskMeta', () => {
  it('opening wins, else state label + truncated command', () => {
    expect(formatBgTaskMeta({ state: 'running', opening: true })).toBe('打开中…');
    expect(formatBgTaskMeta({ state: 'running' })).toMatch(/运行/);
    const long = 'c'.repeat(100);
    expect(formatBgTaskMeta({ state: 'done', command: long }).length).toBeLessThan(60);
  });
});

describe('formatUsageRingAria', () => {
  it('clamps percent and speaks context', () => {
    expect(formatUsageRingAria(42)).toBe('上下文占用约 42%');
    expect(formatUsageRingAria(150)).toBe('上下文占用约 100%');
    expect(formatUsageRingAria(-5)).toBe('上下文占用约 0%');
  });
});
