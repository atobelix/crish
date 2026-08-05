/**
 * BgTaskActions 测试（T-AB-20）：kill 二次确认 + KillResult 三态反馈渲染；
 * send_input 输入框调用契约（appendNewline 默认 true）；prompt 推荐输入预填。
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BgTaskActions } from './BgTaskActions';
import type {
  BackgroundTaskInfo,
  KillBackgroundTaskResult,
  SendBackgroundTaskInputResult,
} from '../../api/backgroundTasksApi';

function task(
  partial: Partial<BackgroundTaskInfo> & Pick<BackgroundTaskInfo, 'id'>,
): BackgroundTaskInfo {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    state: partial.state ?? 'running',
    ...(partial.command !== undefined && { command: partial.command }),
  };
}

const okSend = (): SendBackgroundTaskInputResult => ({
  ok: true,
  taskId: 't1',
  appendedNewline: true,
});
const failSend = (): SendBackgroundTaskInputResult => ({
  ok: false,
  reason: 'invoke_failed',
});

function makeKillSpy(result: KillBackgroundTaskResult | null = null) {
  return vi.fn<(taskId: string) => Promise<KillBackgroundTaskResult | null>>(
    async () => result,
  );
}

describe('BgTaskActions — kill 二次确认流程', () => {
  it('首次点击「终止任务」只展开确认区，不调用 onKill', () => {
    const onKill = makeKillSpy();
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onKill).not.toHaveBeenCalled();
  });

  it('确认终止 → onKill 被调用并渲染「已终止」反馈', async () => {
    const onKill = makeKillSpy({ kind: 'killed', taskId: 't1', viaForce: false });
    const onKillApplied = vi.fn();
    render(
      <BgTaskActions task={task({ id: 't1' })} onKill={onKill} onKillApplied={onKillApplied} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认终止' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已终止');
    });
    expect(onKill).toHaveBeenCalledWith('t1');
    expect(onKillApplied).toHaveBeenCalledWith({ kind: 'killed', taskId: 't1', viaForce: false });
  });

  it('viaForce=true → 「已终止（强制升级）」反馈', async () => {
    const onKill = makeKillSpy({ kind: 'killed', taskId: 't1', viaForce: true });
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认终止' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已终止（强制升级）');
    });
  });

  it('取消确认 → 不调用 onKill、无反馈', () => {
    const onKill = makeKillSpy();
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onKill).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('alreadyExited → 展示自然退出与退出码', async () => {
    const onKill = makeKillSpy({ kind: 'alreadyExited', taskId: 't1', exitCode: 1 });
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认终止' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('进程已自然退出（退出码 1）');
    });
  });

  it('failed → 「终止失败：原因」', async () => {
    const onKill = makeKillSpy({ kind: 'failed', taskId: 't1', reason: '权限不足' });
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认终止' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('终止失败：权限不足');
    });
  });

  it('onKill 返回 null（命令不可用）→ 兜底失败反馈', async () => {
    const onKill = makeKillSpy(null);
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认终止' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('终止失败：命令不可用');
    });
  });

  it('kill 进行中按钮禁用（pending 期间不可重复提交）', async () => {
    let release!: () => void;
    const gate = new Promise<KillBackgroundTaskResult | null>((resolve) => {
      release = () => resolve({ kind: 'killed', taskId: 't1', viaForce: false });
    });
    const onKill = vi.fn(async () => gate);
    render(<BgTaskActions task={task({ id: 't1' })} onKill={onKill} />);
    fireEvent.click(screen.getByRole('button', { name: /终止任务/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认终止' }));
    expect(screen.getByRole('button', { name: '确认终止' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    release();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已终止');
    });
  });
});

describe('BgTaskActions — send_input 调用契约', () => {
  it('默认 appendNewline=true；发送成功清空输入并反馈「已发送」', async () => {
    const onSendInput = vi.fn<typeof sendStub>(async () => okSend());
    render(<BgTaskActions task={task({ id: 't1' })} onSendInput={onSendInput} />);
    const input = screen.getByRole('textbox', { name: '向任务 t1 发送输入' });
    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已发送');
    });
    expect(onSendInput).toHaveBeenCalledWith('t1', 'y', true);
    expect(screen.getByRole('textbox', { name: '向任务 t1 发送输入' })).toHaveValue('');
  });

  it('取消勾选「追加换行」→ appendNewline=false 透传', async () => {
    const onSendInput = vi.fn<typeof sendStub>(async () => okSend());
    render(<BgTaskActions task={task({ id: 't1' })} onSendInput={onSendInput} />);
    fireEvent.click(screen.getByLabelText('追加换行'));
    const input = screen.getByRole('textbox', { name: '向任务 t1 发送输入' });
    fireEvent.change(input, { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(onSendInput).toHaveBeenCalledWith('t1', 'go', false);
    });
  });

  it('空输入不调用 onSendInput，发送按钮禁用', () => {
    const onSendInput = vi.fn<typeof sendStub>(async () => okSend());
    render(<BgTaskActions task={task({ id: 't1' })} onSendInput={onSendInput} />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('Enter 键提交；发送失败反馈「发送失败」', async () => {
    const onSendInput = vi.fn<typeof sendStub>(async () => failSend());
    render(<BgTaskActions task={task({ id: 't1' })} onSendInput={onSendInput} />);
    const input = screen.getByRole('textbox', { name: '向任务 t1 发送输入' });
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('发送失败');
    });
    expect(onSendInput).toHaveBeenCalledWith('t1', 'x', true);
  });
});

describe('BgTaskActions — prompt 推荐输入预填', () => {
  it('推荐输入存在时预填输入框', () => {
    render(
      <BgTaskActions task={task({ id: 't1' })} recommendedInput="y" />,
    );
    expect(screen.getByRole('textbox', { name: '向任务 t1 发送输入' })).toHaveValue('y');
  });

  it('无推荐输入不预填', () => {
    render(<BgTaskActions task={task({ id: 't1' })} recommendedInput={null} />);
    expect(screen.getByRole('textbox', { name: '向任务 t1 发送输入' })).toHaveValue('');
  });
});

describe('BgTaskActions — 可见性', () => {
  it('非活跃任务（终态）不渲染操作面', () => {
    const { container } = render(
      <BgTaskActions task={task({ id: 't1', state: 'succeeded' })} />,
    );
    expect(container.querySelector('.actions')).toBeNull();
    expect(screen.queryByRole('button', { name: /终止任务/ })).toBeNull();
  });
});

// 类型别名：与 props 签名一致的 onSendInput 桩类型
type SendStub = (
  taskId: string,
  text: string,
  appendNewline: boolean,
) => Promise<SendBackgroundTaskInputResult>;
const sendStub: SendStub = async () => okSend();
