// @vitest-environment jsdom
/**
 * BG5：会话级工具后台指示——计数随注册表快照增减；点开列工具名与
 * 时长；行内取消调 kill 后以快照刷新。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ToolBackgroundIndicator } from './ToolBackgroundIndicator';
import type { ToolBackgroundTaskInfo } from '../../api/toolBackgroundApi';

vi.mock('../../api/toolBackgroundApi', () => ({
  listToolBackgroundTasks: vi.fn(),
  cancelToolBackgroundTask: vi.fn(),
}));

import {
  cancelToolBackgroundTask,
  listToolBackgroundTasks,
} from '../../api/toolBackgroundApi';

const mockedList = vi.mocked(listToolBackgroundTasks);
const mockedCancel = vi.mocked(cancelToolBackgroundTask);

function task(
  partial: Partial<ToolBackgroundTaskInfo> &
    Pick<ToolBackgroundTaskInfo, 'callId'>
): ToolBackgroundTaskInfo {
  return {
    callId: partial.callId,
    toolName: partial.toolName ?? 'web_search',
    state: partial.state ?? 'running',
    queuedAtMs: partial.queuedAtMs ?? Date.now() - 30000,
    startedAtMs:
      partial.startedAtMs !== undefined
        ? partial.startedAtMs
        : Date.now() - 25000,
  };
}

describe('ToolBackgroundIndicator（BG5）', () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedCancel.mockReset();
    mockedCancel.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('无条目 / 无会话 / 待建会话 → 不渲染', async () => {
    mockedList.mockResolvedValue([]);
    const { container } = render(<ToolBackgroundIndicator sessionId="s1" />);
    await waitFor(() => expect(mockedList).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();

    const draft = render(<ToolBackgroundIndicator sessionId={null} />);
    expect(draft.container.firstChild).toBeNull();
    const pending = render(<ToolBackgroundIndicator sessionId="__pending-1" />);
    expect(pending.container.firstChild).toBeNull();
  });

  it('计数随快照呈报，点开列工具名与时长', async () => {
    mockedList.mockResolvedValue([
      task({ callId: 'a', toolName: 'web_search' }),
      task({
        callId: 'b',
        toolName: 'search_context',
        state: 'queued',
        startedAtMs: null,
      }),
    ]);
    render(<ToolBackgroundIndicator sessionId="s1" />);
    const pill = await screen.findByRole('button', { name: /后台中 2/ });
    expect(pill.textContent).toContain('后台中 2');

    fireEvent.click(pill);
    expect(await screen.findByText('web_search')).not.toBeNull();
    expect(screen.getByText('search_context')).not.toBeNull();
    expect(screen.getByText('排队中')).not.toBeNull();
    expect(screen.getByText(/已运行 2[4-6](\.\d)? 秒/)).not.toBeNull();
  });

  it('行内取消 → kill 后刷新快照，计数递减', async () => {
    // 状态化假注册表：list 恒读当前集合，cancel 把条目移出集合——
    // 与真实注册表语义一致，且对打开面板等额外刷新调用免疫。
    let server = [
      task({ callId: 'a' }),
      task({ callId: 'b', toolName: 'search_context' }),
    ];
    mockedList.mockImplementation(async () => server);
    mockedCancel.mockImplementation(async (callId: string) => {
      server = server.filter((t) => t.callId !== callId);
      return true;
    });
    render(<ToolBackgroundIndicator sessionId="s1" />);
    const pill = await screen.findByRole('button', { name: /后台中 2/ });
    fireEvent.click(pill);
    const row = (await screen.findByText('web_search')).closest('div')!;
    const cancelBtn = row.querySelector('button')!;
    expect(cancelBtn.textContent).toBe('取消');
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith('a'));
    await screen.findByRole('button', { name: /后台中 1/ });
  });

  it('会话切换 → 以新会话重新拉取', async () => {
    mockedList.mockResolvedValue([task({ callId: 'a' })]);
    const { rerender } = render(<ToolBackgroundIndicator sessionId="s1" />);
    await screen.findByRole('button', { name: /后台中 1/ });
    rerender(<ToolBackgroundIndicator sessionId="s2" />);
    await waitFor(() => expect(mockedList).toHaveBeenCalledWith('s2'));
  });
});
