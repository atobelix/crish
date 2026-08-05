// @vitest-environment jsdom
/**
 * BgTaskCard 测试（T-AB-20）：任务卡片四态渲染（running / completed / failed / killed）
 * 与资源快照缺失容忍；prompt 高亮条件；疑似卡死标记；日志尾部展开。
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BgTaskCard } from './BgTaskCard';
import {
  RESOURCE_MONITOR_DISABLED_TEXT,
  SUSPICIOUS_TASK_TEXT,
  TASK_AWAITING_INPUT_TEXT,
} from './bgTaskCardLib';
import type { BackgroundTaskInfo, BackgroundTaskResourceSample } from '../../api/backgroundTasksApi';

const NOW = 10_000;

function task(
  partial: Partial<BackgroundTaskInfo> & Pick<BackgroundTaskInfo, 'id'>,
): BackgroundTaskInfo {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    state: partial.state ?? 'running',
    ...(partial.command !== undefined && { command: partial.command }),
    ...(partial.startedAt !== undefined && { startedAt: partial.startedAt }),
    ...(partial.durationMs !== undefined && { durationMs: partial.durationMs }),
    ...(partial.finishedAtMs !== undefined && { finishedAtMs: partial.finishedAtMs }),
    ...(partial.exitCode !== undefined && { exitCode: partial.exitCode }),
    ...(partial.resource !== undefined && { resource: partial.resource }),
    ...(partial.prompt !== undefined && { prompt: partial.prompt }),
    ...(partial.suspicious !== undefined && { suspicious: partial.suspicious }),
    ...(partial.summary !== undefined && { summary: partial.summary }),
  };
}

const sampleResource: BackgroundTaskResourceSample = {
  cpuPercent: 12.5,
  rssBytes: 1024 * 1024,
};

describe('BgTaskCard — 四态渲染', () => {
  it('running：状态徽标 + 已运行时长 + 资源快照', () => {
    render(
      <BgTaskCard
        task={task({ id: 't1', state: 'running', startedAt: 7000, resource: sampleResource })}
        now={NOW}
      />,
    );
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('已运行 3 秒')).toBeInTheDocument();
    expect(screen.getByText('CPU 12.5% · 内存 1.0 MB')).toBeInTheDocument();
  });

  it('completed（succeeded）：徽标 + 时长前缀「时长」', () => {
    render(
      <BgTaskCard
        task={task({
          id: 't2',
          state: 'succeeded',
          startedAt: 1000,
          finishedAtMs: 3000,
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('时长 2 秒')).toBeInTheDocument();
  });

  it('failed：异常高亮 + 退出码展示', () => {
    const { container } = render(
      <BgTaskCard task={task({ id: 't3', state: 'failed', exitCode: 1 })} now={NOW} />,
    );
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('退出码 1')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="bg-task-card"]')?.className).toContain(
      'isAbnormal',
    );
  });

  it('killed：异常高亮 + 已终止徽标', () => {
    const { container } = render(
      <BgTaskCard task={task({ id: 't4', state: 'killed', exitCode: -9 })} now={NOW} />,
    );
    expect(screen.getByText('已终止')).toBeInTheDocument();
    expect(screen.getByText('退出码 -9')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="bg-task-card"]')?.className).toContain(
      'isAbnormal',
    );
  });
});

describe('BgTaskCard — 资源快照缺失容忍', () => {
  it('resource 缺失（未启用 resourceMonitor）→ 展示「未启用资源监控」', () => {
    render(
      <BgTaskCard task={task({ id: 't1', state: 'running' })} now={NOW} />,
    );
    expect(screen.getByText(RESOURCE_MONITOR_DISABLED_TEXT)).toBeInTheDocument();
  });

  it('resource 为 null 同样容忍', () => {
    render(
      <BgTaskCard task={task({ id: 't1', state: 'running', resource: null })} now={NOW} />,
    );
    expect(screen.getByText(RESOURCE_MONITOR_DISABLED_TEXT)).toBeInTheDocument();
  });
});

describe('BgTaskCard — prompt 高亮条件', () => {
  it('prompt 有值 → 高亮「任务等待输入」+ 提示文本 + 预填推荐输入', () => {
    render(
      <BgTaskCard
        task={task({ id: 't1', state: 'running', prompt: 'Proceed? [Y/n]' })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('bg-task-prompt-banner')).toBeInTheDocument();
    expect(screen.getByText(TASK_AWAITING_INPUT_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Proceed? [Y/n]')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '向任务 t1 发送输入' })).toHaveValue('y');
  });

  it('prompt 缺失 → 不高亮、不渲染输入相关预填', () => {
    render(<BgTaskCard task={task({ id: 't1', state: 'running' })} now={NOW} />);
    expect(screen.queryByTestId('bg-task-prompt-banner')).toBeNull();
    expect(screen.queryByText(TASK_AWAITING_INPUT_TEXT)).toBeNull();
  });
});

describe('BgTaskCard — 疑似卡死标记', () => {
  it('suspicious 事件标记（props 注入）→ 展示「疑似卡死」', () => {
    render(
      <BgTaskCard task={task({ id: 't1', state: 'running' })} suspicious now={NOW} />,
    );
    expect(screen.getByText(SUSPICIOUS_TASK_TEXT)).toBeInTheDocument();
  });

  it('task.suspicious 快照字段 → 同样展示', () => {
    render(
      <BgTaskCard
        task={task({ id: 't1', state: 'running', suspicious: true })}
        now={NOW}
      />,
    );
    expect(screen.getByText(SUSPICIOUS_TASK_TEXT)).toBeInTheDocument();
  });

  it('无标记 → 不展示', () => {
    render(<BgTaskCard task={task({ id: 't1', state: 'running' })} now={NOW} />);
    expect(screen.queryByText(SUSPICIOUS_TASK_TEXT)).toBeNull();
  });
});

describe('BgTaskCard — 日志尾部展开', () => {
  it('展开后读取并展示尾部行（复用 getOutput 桩）', async () => {
    const getOutput = vi.fn(async () => 'L1\nL2\nL3\nL4\nL5\nL6');
    render(
      <BgTaskCard task={task({ id: 't1', state: 'running' })} getOutput={getOutput} now={NOW} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /日志尾部/ }));
    await waitFor(() => {
      expect(screen.getByTestId('bg-task-log-tail')).toHaveTextContent('L2');
    });
    expect(screen.getByTestId('bg-task-log-tail')).toHaveTextContent('L6');
    expect(getOutput).toHaveBeenCalledWith('t1');
  });

  it('读取失败 → 回退展示摘要并提示', async () => {
    const getOutput = vi.fn(async () => {
      throw new Error('boom');
    });
    render(
      <BgTaskCard
        task={task({ id: 't1', state: 'running', summary: '摘要内容' })}
        getOutput={getOutput}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /日志尾部/ }));
    await waitFor(() => {
      expect(screen.getByTestId('bg-task-log-tail')).toHaveTextContent('摘要内容');
    });
    expect(screen.getByRole('status')).toHaveTextContent('读取日志失败');
  });
});

describe('BgTaskCard — 主体点击（打开终端）', () => {
  it('点击头部触发 onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    render(
      <BgTaskCard task={task({ id: 't1', state: 'running' })} onOpenOutput={onOpenOutput} now={NOW} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /t1，运行中，在终端中查看输出/ }));
    expect(onOpenOutput).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('空格键同样触发', () => {
    const onOpenOutput = vi.fn();
    render(
      <BgTaskCard task={task({ id: 't1', state: 'running' })} onOpenOutput={onOpenOutput} now={NOW} />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /t1，运行中，在终端中查看输出/ }), {
      key: ' ',
    });
    expect(onOpenOutput).toHaveBeenCalledTimes(1);
  });
});
