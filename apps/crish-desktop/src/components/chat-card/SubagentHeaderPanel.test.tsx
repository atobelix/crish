// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SubagentHeaderPanel } from './SubagentHeaderPanel';
import type { SessionAgent } from '../../store/types';
import * as openAgentPanelModule from '../../api/openAgentPanel';
import * as subagentRecoveryApiModule from '../../api/subagentRecoveryApi';

vi.mock('../../api/openAgentPanel', () => ({
  openAgentInSidePanel: vi.fn(),
}));

vi.mock('../../api/subagentRecoveryApi', () => ({
  killSubagent: vi.fn(),
}));

function createMockAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'subagent-1',
    subagentRunId: 'run-1',
    parentSessionId: 'sess-parent',
    parentRunId: 'prun-1',
    displayLabel: '代码分析器',
    description: '分析模块结构',
    mode: 'analyze',
    status: 'running',
    summary: '正在扫描文件域',
    messages: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('SubagentHeaderPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders running count and liveDot when running agents exist', () => {
    const agents = [
      createMockAgent({ id: 'sub-1', status: 'running' }),
      createMockAgent({ id: 'sub-2', status: 'completed' }),
    ];

    render(<SubagentHeaderPanel agents={agents} parentSessionId="sess-1" />);

    expect(
      screen.getByRole('button', { name: '展开子代理状态面板' })
    ).toBeInTheDocument();
    expect(screen.getByText('1 个运行中')).toBeInTheDocument();
  });

  it('renders total count and bot icon when no running agents exist', () => {
    const agents = [
      createMockAgent({ id: 'sub-1', status: 'completed' }),
      createMockAgent({ id: 'sub-2', status: 'stopped' }),
    ];

    render(<SubagentHeaderPanel agents={agents} parentSessionId="sess-1" />);

    expect(screen.getByText('2 个子代理')).toBeInTheDocument();
  });

  it('renders subagent items in popover menu upon click', () => {
    const agents = [
      createMockAgent({
        id: 'sub-1',
        displayLabel: '测试执行器',
        status: 'running',
        summary: '运行单测中',
      }),
      createMockAgent({
        id: 'sub-2',
        displayLabel: '文档生成器',
        status: 'completed',
        summary: '文档生成完毕',
      }),
    ];

    render(<SubagentHeaderPanel agents={agents} parentSessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: '展开子代理状态面板' }));

    expect(screen.getByText('测试执行器')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('运行单测中')).toBeInTheDocument();

    expect(screen.getByText('文档生成器')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('文档生成完毕')).toBeInTheDocument();
  });

  it('navigates to side panel on clicking subagent info card', () => {
    const agents = [createMockAgent({ id: 'sub-1', displayLabel: '架构评审' })];

    render(<SubagentHeaderPanel agents={agents} parentSessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: '展开子代理状态面板' }));
    fireEvent.click(screen.getByText('架构评审'));

    expect(openAgentPanelModule.openAgentInSidePanel).toHaveBeenCalledWith(
      'sub-1',
      {
        sessionId: 'sess-1',
      }
    );
  });

  it('calls killSubagent when clicking kill button for running subagent', () => {
    const agents = [
      createMockAgent({ id: 'sub-running', status: 'running' }),
      createMockAgent({ id: 'sub-idle', status: 'completed' }),
    ];

    render(<SubagentHeaderPanel agents={agents} parentSessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: '展开子代理状态面板' }));

    const killButtons = screen.getAllByRole('button', { name: '终止子代理' });
    expect(killButtons).toHaveLength(1);

    fireEvent.click(killButtons[0]);

    expect(subagentRecoveryApiModule.killSubagent).toHaveBeenCalledWith(
      'sess-1',
      'sub-running'
    );
    expect(openAgentPanelModule.openAgentInSidePanel).not.toHaveBeenCalled();
  });
});
