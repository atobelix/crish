// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const listWorkflowsMock = vi.hoisted(() => vi.fn(async () => []));
const closeSettingsMock = vi.hoisted(() => vi.fn());
const injectSeedMock = vi.hoisted(() => vi.fn());
const dispatchCardMock = vi.hoisted(() => vi.fn(() => 'inj-test-1'));
const emitUiEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../api/workflowApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workflowApi')>();
  return {
    ...actual,
    listWorkflows: (...args: unknown[]) => listWorkflowsMock(...args),
    listWorkflowRuns: vi.fn(async () => []),
  };
});

vi.mock('../../api/projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/projectStore')>();
  return {
    ...actual,
    getWorkspacePath: () => '',
  };
});

vi.mock('../../store/storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/storeAccess')>();
  return {
    ...actual,
    closeSettings: (...args: unknown[]) => closeSettingsMock(...args),
  };
});

vi.mock('../../store/sessionStore', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../store/sessionStore')
  >();
  return {
    ...actual,
    useSessionStore: {
      ...actual.useSessionStore,
      // 定向草稿注入以活跃会话寻址：测试固定一个目标会话 ID
      getState: () => ({
        ...actual.useSessionStore.getState(),
        activeSessionId: 'sess-target-1',
      }),
    },
  };
});

vi.mock('../../api/draft/sessionDraftManager', () => ({
  sessionDraftManager: {
    injectSeed: (...args: unknown[]) => injectSeedMock(...args),
  },
}));

vi.mock('../../api/workflow-api/workflowAssistantCard', () => ({
  dispatchWorkflowAssistantCard: (...args: unknown[]) =>
    dispatchCardMock(...args),
  WORKFLOW_CREATE_TEMPLATE: '/schedule 模板',
}));

vi.mock('../../api/uiEvents', () => ({
  emitUiEvent: (...args: unknown[]) => emitUiEventMock(...args),
}));

import { SettingsScheduleTab } from './SettingsScheduleTab';

describe('SettingsScheduleTab I4 死皮拉回', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorkflowsMock.mockResolvedValue([]);
  });

  it('筛选走 SegmentedControl 且有选中态，不再渲染幽灵分段 / 裸 choice', async () => {
    render(<SettingsScheduleTab />);

    const group = await screen.findByRole('radiogroup', { name: '任务筛选' });
    expect(group).toBeTruthy();
    expect(document.querySelector('.ui-segment')).toBeNull();
    expect(document.querySelector('.ui-segment-item')).toBeNull();
    expect(document.querySelector('.settings-choice-btn')).toBeNull();
    expect(document.querySelector('.settings-choice-group')).toBeNull();

    const all = screen.getByRole('radio', { name: '全部' });
    const paused = screen.getByRole('radio', { name: '暂停' });
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(paused).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(paused);
    expect(paused).toHaveAttribute('aria-checked', 'true');
    expect(all).toHaveAttribute('aria-checked', 'false');
  });

  it('新建/收起走 ui/Button；创建方式走 SegmentedControl', async () => {
    render(<SettingsScheduleTab />);

    const toggle = await screen.findByRole('button', { name: '新建' });
    expect(toggle).toHaveAttribute('data-variant', 'secondary');
    expect(toggle).toHaveAttribute('data-size', 'sm');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute(
      'data-variant',
      'secondary'
    );
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    const createGroup = screen.getByRole('radiogroup', { name: '创建方式' });
    expect(createGroup).toBeTruthy();
    expect(document.querySelector('.settings-create-path')).toBeNull();
    expect(document.querySelector('.settings-create-paths')).toBeNull();

    const ai = screen.getByRole('radio', { name: '用对话创建（推荐）' });
    const manual = screen.getByRole('radio', { name: '手动创建' });
    expect(ai).toHaveAttribute('aria-checked', 'false');
    expect(manual).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(manual);
    expect(manual).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('form', { name: '新建定时任务' })).toBeTruthy();
    expect(screen.getByPlaceholderText('名称')).toBeTruthy();
  });

  it('空态「暂无计划任务」走产品卡片，不是 fieldset', async () => {
    render(<SettingsScheduleTab />);

    const empty = await screen.findByText('暂无计划任务');
    expect(empty.closest('.settings-ui-card')).toBeTruthy();
    expect(document.querySelector('fieldset')).toBeNull();
  });

  it('用对话创建写入会话定向草稿并关闭设置', async () => {
    render(<SettingsScheduleTab />);

    fireEvent.click(await screen.findByRole('button', { name: '新建' }));
    fireEvent.click(screen.getByRole('radio', { name: '用对话创建（推荐）' }));

    expect(injectSeedMock).toHaveBeenCalledTimes(1);
    const payload = injectSeedMock.mock.calls[0]?.[0] as {
      targetSessionId: string;
      content: string;
    };
    expect(payload.targetSessionId).toBe('sess-target-1');
    expect(payload.content).toMatch(/定时任务/);
    // 可见助手卡片同步派发（维度五 TC-WG-01）
    expect(dispatchCardMock).toHaveBeenCalledTimes(1);
    expect(dispatchCardMock.mock.calls[0]?.[0]).toBe('sess-target-1');
    expect(closeSettingsMock).toHaveBeenCalled();

    await waitFor(() => {
      expect(emitUiEventMock).toHaveBeenCalledWith('open-chat');
    });
  });
});
