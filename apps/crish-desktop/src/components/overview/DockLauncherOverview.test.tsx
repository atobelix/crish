// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import {
  DockLauncherOverview,
  resolveSearchOrUrl,
} from './DockLauncherOverview';

// 模拟外部依赖
vi.mock('../../store/storeAccess', () => ({
  useSessionAgents: vi.fn(() => []),
  useSessionField: vi.fn(() => []),
  selectSessions: vi.fn(),
}));

vi.mock('../../hooks/useEngineState', () => ({
  useEngineState: vi.fn(() => ({
    bgTasks: [],
    workflows: [],
    activeRuns: [],
    pendingApprovals: [],
  })),
}));

vi.mock('./useOverviewState', () => ({
  useOverviewState: vi.fn(() => ({
    liveTasks: [],
    openBgTask: vi.fn(),
    focusSession: vi.fn(),
  })),
}));

vi.mock('../../api/openAgentPanel', () => ({
  openAgentInSidePanel: vi.fn(),
}));

vi.mock('../../api/subagentRecoveryApi', () => ({
  killSubagent: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../api/tool-presentation/agentRoleLabel', () => ({
  mapSubagentRoleWireName: vi.fn((name: string) => {
    if (name === 'implementer') return '代码实现专家';
    if (name === 'researcher') return '技术调研员';
    return name;
  }),
}));

import { useSessionAgents } from '../../store/storeAccess';
import { useEngineState } from '../../hooks/useEngineState';
import { useOverviewState } from './useOverviewState';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';

describe('resolveSearchOrUrl 纯函数解析测试', () => {
  it('正确保留已有完整 URL 与 scheme', () => {
    expect(resolveSearchOrUrl('https://example.com/test')).toBe(
      'https://example.com/test'
    );
    expect(resolveSearchOrUrl('http://mysite.org')).toBe('http://mysite.org');
    expect(resolveSearchOrUrl('about:blank')).toBe('about:blank');
  });

  it('针对本地 localhost 与 127.0.0.1 自动补齐 http://', () => {
    expect(resolveSearchOrUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveSearchOrUrl('127.0.0.1:8080/dashboard')).toBe(
      'http://127.0.0.1:8080/dashboard'
    );
  });

  it('针对纯合法域名自动补齐 https://', () => {
    expect(resolveSearchOrUrl('github.com')).toBe('https://github.com');
    expect(resolveSearchOrUrl('vite.dev/guide')).toBe('https://vite.dev/guide');
    expect(resolveSearchOrUrl('sub.domain.co.uk:9000/path')).toBe(
      'https://sub.domain.co.uk:9000/path'
    );
  });

  it('普通搜索关键词自动转为 Google 检索 URL', () => {
    expect(resolveSearchOrUrl('hello world')).toBe(
      'https://www.google.com/search?q=hello%20world'
    );
    expect(resolveSearchOrUrl('react')).toBe(
      'https://www.google.com/search?q=react'
    );
    expect(resolveSearchOrUrl('   ')).toBe('');
  });
});

describe('DockLauncherOverview 组件测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('最少情况（无子智能体且无后台任务）：渲染 isMinimal 居中布局与核心工具入口', () => {
    const onOpenTool = vi.fn();
    const { container, getByPlaceholderText, getByText } = render(
      <DockLauncherOverview sessionId="session-1" onOpenTool={onOpenTool} />
    );

    // 检查根容器拥有 isMinimal 类
    const rootEl = container.firstElementChild;
    expect(rootEl?.className).toContain('isMinimal');

    // 检查搜索输入框
    const input = getByPlaceholderText('搜索或输入网址...');
    expect(input).toBeTruthy();

    // 检查四个核心工具入口
    expect(getByText('审阅')).toBeTruthy();
    expect(getByText('打开文件')).toBeTruthy();
    expect(getByText('终端')).toBeTruthy();
    const browserTool = getByText(/网页预览|浏览器/);
    expect(browserTool).toBeTruthy();

    // 点击终端入口
    fireEvent.click(getByText('终端'));
    expect(onOpenTool).toHaveBeenCalledWith('terminal');

    // 点击审阅入口
    fireEvent.click(getByText('审阅'));
    expect(onOpenTool).toHaveBeenCalledWith('diff');

    // 点击打开文件入口
    fireEvent.click(getByText('打开文件'));
    expect(onOpenTool).toHaveBeenCalledWith('files');

    // 点击浏览器入口
    fireEvent.click(browserTool);
    expect(onOpenTool).toHaveBeenCalledWith('preview');
  });

  it('在搜索框回车提交合法 URL，调用 onOpenTool(preview, { url })', () => {
    const onOpenTool = vi.fn();
    const { getByPlaceholderText } = render(
      <DockLauncherOverview sessionId="session-1" onOpenTool={onOpenTool} />
    );

    const input = getByPlaceholderText('搜索或输入网址...');
    fireEvent.change(input, { target: { value: 'vite.dev' } });
    fireEvent.submit(input.closest('form')!);

    expect(onOpenTool).toHaveBeenCalledWith('preview', {
      url: 'https://vite.dev',
    });
  });

  it('动态增量：存在子智能体时正确渲染区域、解析名称并支持侧栏打开与终止', async () => {
    const mockAgents = [
      {
        id: 'agent-1',
        displayLabel: 'implementer',
        description: '代码实现',
        mode: 'implement',
        status: 'running' as const,
        parentSessionId: 'session-1',
        parentRunId: 'run-1',
        subagentRunId: 'sub-run-1',
        messages: [],
      },
      {
        id: 'agent-2',
        displayLabel: '',
        description: '已完成的分析任务',
        mode: 'explore',
        status: 'completed' as const,
        parentSessionId: 'session-1',
        parentRunId: 'run-1',
        subagentRunId: 'sub-run-2',
        messages: [],
      },
    ];

    vi.mocked(useSessionAgents).mockReturnValue(mockAgents as any);

    const onOpenTool = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <DockLauncherOverview sessionId="session-1" onOpenTool={onOpenTool} />
    );

    // 有动态数据时不再为 isMinimal
    const rootEl = container.firstElementChild;
    expect(rootEl?.className).not.toContain('isMinimal');

    // 检查子智能体标题与数量徽标
    expect(getByText('子智能体')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();

    // 检查角色映射
    expect(getByText('代码实现专家')).toBeTruthy();
    expect(getByText('已完成的分析任务')).toBeTruthy();

    // 点击智能体项打开侧栏面板
    fireEvent.click(getByText('代码实现专家'));
    expect(openAgentInSidePanel).toHaveBeenCalledWith('agent-1', {
      sessionId: 'session-1',
    });

    // 点击运行中的终止按钮
    const stopBtn = getByLabelText('终止子智能体');
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);
    expect(killSubagent).toHaveBeenCalledWith(
      'session-1',
      'agent-1',
      'dock-launcher-kill'
    );
  });

  it('动态增量：存在后台任务与实时任务时渲染对应列表', () => {
    const mockOpenBgTask = vi.fn();
    const mockFocusSession = vi.fn();

    vi.mocked(useOverviewState).mockReturnValue({
      liveTasks: [
        {
          id: 'live-1',
          taskName: '实时分析会话',
          elapsedSeconds: 65,
          sessionId: 'session-live',
          kind: 'session',
        },
      ],
      openBgTask: mockOpenBgTask,
      focusSession: mockFocusSession,
    } as any);

    vi.mocked(useEngineState).mockReturnValue({
      bgTasks: [
        {
          id: 'bg-1',
          command: 'npm run test',
          label: '测试任务',
          state: 'running',
        },
      ],
      workflows: [],
      activeRuns: [],
      pendingApprovals: [],
    } as any);

    const onOpenTool = vi.fn();
    const { getByText } = render(
      <DockLauncherOverview sessionId="session-1" onOpenTool={onOpenTool} />
    );

    // 检查后台任务标题与徽标
    expect(getByText('后台任务')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();

    // 检查条目
    expect(getByText('实时分析会话')).toBeTruthy();
    expect(getByText('测试任务')).toBeTruthy();

    // 点击实时任务聚焦会话
    fireEvent.click(getByText('实时分析会话'));
    expect(mockFocusSession).toHaveBeenCalledWith('session-live');

    // 点击后台常驻任务
    fireEvent.click(getByText('测试任务'));
    expect(mockOpenBgTask).toHaveBeenCalled();
  });
});
