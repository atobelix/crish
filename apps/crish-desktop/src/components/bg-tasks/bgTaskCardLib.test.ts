/**
 * bgTaskCardLib 纯函数测试（T-AB-20）：
 * 时长 / 资源快照摘要（缺失容忍）/ 退出码 / 异常高亮 / KillResult 三态反馈 /
 * prompt 推荐输入 / 日志尾部截取。
 */
import { describe, expect, it } from 'vitest';
import {
  KILL_FEEDBACK_INVOKE_FAILED_TEXT,
  RESOURCE_MONITOR_DISABLED_TEXT,
  SUSPICIOUS_TASK_TEXT,
  TASK_AWAITING_INPUT_TEXT,
  buildKillConfirmPrompt,
  formatBgTaskDurationLabel,
  formatBgTaskDurationMs,
  formatBgTaskExitCode,
  formatBgTaskResourceSummary,
  formatKillResultFeedback,
  formatLogTailLines,
  formatRssBytes,
  formatSendInputFeedback,
  isBgTaskAbnormalState,
  recommendPromptAnswer,
  resolveBgTaskDurationMs,
} from './bgTaskCardLib';
import type { BackgroundTaskInfo } from '../../api/backgroundTasksApi';

function task(partial: Partial<BackgroundTaskInfo> & Pick<BackgroundTaskInfo, 'id'>): BackgroundTaskInfo {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    state: partial.state ?? 'running',
    ...(partial.durationMs !== undefined && { durationMs: partial.durationMs }),
    ...(partial.startedAt !== undefined && { startedAt: partial.startedAt }),
    ...(partial.finishedAtMs !== undefined && { finishedAtMs: partial.finishedAtMs }),
  };
}

// ── 时长 ───────────────────────────────────────────────────────────

describe('resolveBgTaskDurationMs', () => {
  it('durationMs 直用（负值钳 0）', () => {
    expect(resolveBgTaskDurationMs(task({ id: 'a', durationMs: 5000 }))).toBe(5000);
    expect(resolveBgTaskDurationMs(task({ id: 'a', durationMs: -3 }))).toBe(0);
  });

  it('无 durationMs：终态用 finished - started，活跃用 now - started', () => {
    expect(
      resolveBgTaskDurationMs(
        task({ id: 'a', startedAt: 1000, finishedAtMs: 3000 }),
      ),
    ).toBe(2000);
    expect(resolveBgTaskDurationMs(task({ id: 'b', startedAt: 5000 }), 7000)).toBe(2000);
  });

  it('无时间依据 → null', () => {
    expect(resolveBgTaskDurationMs(task({ id: 'a' }))).toBeNull();
  });
});

describe('formatBgTaskDurationMs', () => {
  it('秒 / 分 / 时 中文口径', () => {
    expect(formatBgTaskDurationMs(0)).toBe('0 秒');
    expect(formatBgTaskDurationMs(59_000)).toBe('59 秒');
    expect(formatBgTaskDurationMs(60_000)).toBe('1 分 0 秒');
    expect(formatBgTaskDurationMs(3_600_000)).toBe('1 时 0 分');
  });
});

describe('formatBgTaskDurationLabel', () => {
  it('活跃前缀「已运行」，终态前缀「时长」', () => {
    expect(
      formatBgTaskDurationLabel(task({ id: 'a', state: 'running', startedAt: 1000 }), 4000),
    ).toBe('已运行 3 秒');
    expect(
      formatBgTaskDurationLabel(
        task({ id: 'b', state: 'succeeded', startedAt: 1000, finishedAtMs: 3000 }),
      ),
    ).toBe('时长 2 秒');
  });

  it('无时间依据 → null', () => {
    expect(formatBgTaskDurationLabel(task({ id: 'a' }))).toBeNull();
  });
});

// ── 资源快照 ───────────────────────────────────────────────────────

describe('formatBgTaskResourceSummary', () => {
  it('完整快照 → CPU + 内存摘要', () => {
    expect(
      formatBgTaskResourceSummary({
        cpuPercent: 12.5,
        rssBytes: 1024 * 1024,
      }),
    ).toBe('CPU 12.5% · 内存 1.0 MB');
  });

  it('仅 CPU / 仅内存也可独立展示', () => {
    expect(formatBgTaskResourceSummary({ cpuPercent: 3 })).toBe('CPU 3.0%');
    expect(formatBgTaskResourceSummary({ rssBytes: 2 * 1024 * 1024 })).toBe('内存 2.0 MB');
  });

  it('null / undefined（未启用资源监控）→ 占位文案', () => {
    expect(formatBgTaskResourceSummary(null)).toBe(RESOURCE_MONITOR_DISABLED_TEXT);
    expect(formatBgTaskResourceSummary(undefined)).toBe(RESOURCE_MONITOR_DISABLED_TEXT);
    expect(formatBgTaskResourceSummary({})).toBe(RESOURCE_MONITOR_DISABLED_TEXT);
  });
});

describe('formatRssBytes', () => {
  it('MB / GB 换算', () => {
    expect(formatRssBytes(0)).toBe('0.0 MB');
    expect(formatRssBytes(1536 * 1024)).toBe('1.5 MB');
    expect(formatRssBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

// ── 退出码 / 异常高亮 ──────────────────────────────────────────────

describe('formatBgTaskExitCode', () => {
  it('有限数值 → 「退出码 N」；null / undefined → null', () => {
    expect(formatBgTaskExitCode(0)).toBe('退出码 0');
    expect(formatBgTaskExitCode(1)).toBe('退出码 1');
    expect(formatBgTaskExitCode(-9)).toBe('退出码 -9');
    expect(formatBgTaskExitCode(null)).toBeNull();
    expect(formatBgTaskExitCode(undefined)).toBeNull();
  });
});

describe('isBgTaskAbnormalState', () => {
  it('failed / killed 高亮；其余不高亮', () => {
    expect(isBgTaskAbnormalState('failed')).toBe(true);
    expect(isBgTaskAbnormalState('killed')).toBe(true);
    expect(isBgTaskAbnormalState('running')).toBe(false);
    expect(isBgTaskAbnormalState('succeeded')).toBe(false);
    expect(isBgTaskAbnormalState('cancelled')).toBe(false);
    expect(isBgTaskAbnormalState('timed-out')).toBe(false);
    expect(isBgTaskAbnormalState('unknown')).toBe(false);
  });
});

// ── KillResult 三态反馈 ────────────────────────────────────────────

describe('formatKillResultFeedback', () => {
  it('killed → 「已终止」；viaForce → 「已终止（强制升级）」', () => {
    expect(formatKillResultFeedback({ kind: 'killed', taskId: 'a', viaForce: false })).toEqual({
      tone: 'ok',
      text: '已终止',
    });
    expect(formatKillResultFeedback({ kind: 'killed', taskId: 'a', viaForce: true })).toEqual({
      tone: 'ok',
      text: '已终止（强制升级）',
    });
  });

  it('alreadyExited → 自然退出 + 可选退出码', () => {
    expect(
      formatKillResultFeedback({ kind: 'alreadyExited', taskId: 'a', exitCode: 1 }),
    ).toEqual({ tone: 'info', text: '进程已自然退出（退出码 1）' });
    expect(
      formatKillResultFeedback({ kind: 'alreadyExited', taskId: 'a', exitCode: null }),
    ).toEqual({ tone: 'info', text: '进程已自然退出' });
  });

  it('failed → 「终止失败：原因」；null → 命令不可用兜底', () => {
    expect(
      formatKillResultFeedback({ kind: 'failed', taskId: 'a', reason: '权限不足' }),
    ).toEqual({ tone: 'error', text: '终止失败：权限不足' });
    expect(
      formatKillResultFeedback({ kind: 'failed', taskId: 'a', reason: null }),
    ).toEqual({ tone: 'error', text: '终止失败：未知原因' });
    expect(formatKillResultFeedback(null)).toEqual({
      tone: 'error',
      text: KILL_FEEDBACK_INVOKE_FAILED_TEXT,
    });
    expect(formatKillResultFeedback(undefined)).toEqual({
      tone: 'error',
      text: KILL_FEEDBACK_INVOKE_FAILED_TEXT,
    });
  });
});

describe('buildKillConfirmPrompt', () => {
  it('含任务名与两阶段终止说明', () => {
    const text = buildKillConfirmPrompt({ label: 'npm run dev' });
    expect(text).toContain('npm run dev');
    expect(text).toContain('优雅终止信号');
    expect(text).toContain('强制终止');
  });
});

// ── send_input ─────────────────────────────────────────────────────

describe('formatSendInputFeedback', () => {
  it('成功 / 失败文案', () => {
    expect(formatSendInputFeedback(true)).toBe('已发送');
    expect(formatSendInputFeedback(false)).toBe('发送失败');
  });
});

describe('recommendPromptAnswer', () => {
  it('[Y/n] 系 → y；[y/N] → n', () => {
    expect(recommendPromptAnswer('Proceed? [Y/n]')).toBe('y');
    expect(recommendPromptAnswer('Continue? (yes/no)')).toBe('y');
    expect(recommendPromptAnswer('(y/n)')).toBe('y');
    expect(recommendPromptAnswer('Overwrite? [y/N]')).toBe('n');
  });

  it('无法推断 → null（不预填）', () => {
    expect(recommendPromptAnswer('请输入密码:')).toBeNull();
    expect(recommendPromptAnswer('Press Enter to continue')).toBeNull();
    expect(recommendPromptAnswer(null)).toBeNull();
    expect(recommendPromptAnswer('')).toBeNull();
  });
});

// ── 日志尾部 ───────────────────────────────────────────────────────

describe('formatLogTailLines', () => {
  it('取最后 N 行；不足 N 行全保留；空输出 → 占位单行', () => {
    expect(formatLogTailLines('a\nb\nc\nd\ne\nf', 3)).toEqual(['d', 'e', 'f']);
    expect(formatLogTailLines('a\nb', 3)).toEqual(['a', 'b']);
    expect(formatLogTailLines('', 3)).toEqual(['（无输出）']);
    expect(formatLogTailLines(null, 3)).toEqual(['（无输出）']);
    expect(formatLogTailLines('a\nb\nc', 0)).toEqual(['a', 'b', 'c']);
  });

  it('默认截取 5 行', () => {
    const lines = formatLogTailLines(
      Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n'),
    );
    expect(lines).toEqual(['L5', 'L6', 'L7', 'L8', 'L9']);
  });
});

// ── 文案常量（供组件测试断言锚定） ─────────────────────────────────

describe('文案常量', () => {
  it('占位 / 疑似卡死 / 等待输入 文案稳定', () => {
    expect(RESOURCE_MONITOR_DISABLED_TEXT).toBe('未启用资源监控');
    expect(SUSPICIOUS_TASK_TEXT).toBe('疑似卡死');
    expect(TASK_AWAITING_INPUT_TEXT).toBe('任务等待输入');
  });
});
