// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
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

vi.mock('../../api/backgroundTasksApi', () => ({
  openBackgroundTaskInTerminal: vi.fn(),
  getBackgroundTaskOutput: vi.fn(async () => 'task output line 1'),
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER: '（无输出）',
  BACKGROUND_TASK_STATE_LABELS: {
    queued: '排队中',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    'timed-out': '已超时',
    killed: '已终止',
    unknown: '未知',
  },
}));

import { useSessionAgents } from '../../store/storeAccess';
import { useEngineState } from '../../hooks/useEngineState';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import {
  openBackgroundTaskInTerminal,
  getBackgroundTaskOutput,
} from '../../api/backgroundTasksApi';

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

  it('最少情况（无子智能体且无后台任务）：渲染 isMinimal 居中布局与软件全功能工具入口', () => {
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

    // 检查全套 Conex 软件工具入口（包含审阅、文件、终端、浏览器、运行时、协作体、编排图、笔记）
    expect(getByText('审阅')).toBeTruthy();
    expect(getByText('打开文件')).toBeTruthy();
    expect(getByText('终端')).toBeTruthy();
    expect(getByText('浏览器')).toBeTruthy();
    expect(getByText('运行时')).toBeTruthy();
    expect(getByText('协作体')).toBeTruthy();
    expect(getByText('编排图')).toBeTruthy();
    expect(getByText('笔记')).toBeTruthy();

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
    fireEvent.click(getByText('浏览器'));
    expect(onOpenTool).toHaveBeenCalledWith('preview');

    // 点击运行时入口
    fireEvent.click(getByText('运行时'));
    expect(onOpenTool).toHaveBeenCalledWith('runtime');

    // 点击协作体入口
    fireEvent.click(getByText('协作体'));
    expect(onOpenTool).toHaveBeenCalledWith('agent');

    // 点击编排图入口
    fireEvent.click(getByText('编排图'));
    expect(onOpenTool).toHaveBeenCalledWith('flow-dag');

    // 点击笔记入口
    fireEvent.click(getByText('笔记'));
    expect(onOpenTool).toHaveBeenCalledWith('note');
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

  it('搜索框支持即时筛选工具功能', () => {
    const onOpenTool = vi.fn();
    const { getByPlaceholderText, getByText, queryByText } = render(
      <DockLauncherOverview sessionId="session-1" onOpenTool={onOpenTool} />
    );

    const input = getByPlaceholderText('搜索或输入网址...');
    fireEvent.change(input, { target: { value: '终端' } });

    // 应该只保留终端，过滤掉其他工具
    expect(getByText('终端')).toBeTruthy();
    expect(queryByText('审阅')).toBeNull();
    expect(queryByText('打开文件')).toBeNull();

    // 回车直接选中该工具
    fireEvent.submit(input.closest('form')!);
    expect(onOpenTool).toHaveBeenCalledWith('terminal');
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

  it('动态增量：严格限定当前会话后台任务，排除其他会话任务与无关全局工作流', async () => {
    vi.mocked(useEngineState).mockReturnValue({
      bgTasks: [
        {
          id: 'bg-1',
          sessionId: 'session-1',
          command: 'npm run typecheck',
          label: '类型检查',
          state: 'running',
        },
        {
          id: 'timer-1',
          sessionId: 'session-1',
          command: 'timer',
          label: '1m 40s timer',
          state: 'running',
        },
        {
          id: 'bg-other-session',
          sessionId: 'session-2',
          command: 'cargo test',
          label: '其他会话的任务',
          state: 'running',
        },
      ],
      workflows: [
        {
          id: 'wf-global',
          name: '全局定时备份',
          schedule: '0 0 * * *',
        },
      ],
      activeRuns: [],
      pendingApprovals: [],
    } as any);

    const onOpenTool = vi.fn();
    const { getByText, queryByText } = render(
      <DockLauncherOverview sessionId="session-1" onOpenTool={onOpenTool} />
    );

    // 检查后台任务标题与徽标（仅 session-1 的 2 个任务）
    expect(getByText('后台任务')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();

    // 检查当前会话任务均正确展示
    expect(getByText('Run npm run typecheck')).toBeTruthy();
    expect(getByText('1m 40s timer')).toBeTruthy();

    // 严厉断言：其他会话的任务与全局工作流绝对不得出现
    expect(queryByText('Run cargo test')).toBeNull();
    expect(queryByText('其他会话的任务')).toBeNull();
    expect(queryByText('全局定时备份')).toBeNull();

    // 点击后台常驻任务，调用终端打开
    fireEvent.click(getByText('Run npm run typecheck'));
    await waitFor(() => {
      expect(getBackgroundTaskOutput).toHaveBeenCalledWith('bg-1');
      expect(openBackgroundTaskInTerminal).toHaveBeenCalledWith(
        '类型检查',
        'task output line 1'
      );
      expect(onOpenTool).toHaveBeenCalledWith('terminal', { taskId: 'bg-1' });
    });
  });
});
