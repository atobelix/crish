// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SessionAgent } from '../../store/types';
import * as openAgentPanelModule from '../../api/openAgentPanel';

vi.mock('../chat-message-row/StreamingMarkdownView', () => ({
  StreamingMarkdownView: (props: { text: string }) => <div>{props.text}</div>,
}));

vi.mock('../../store/sessionStore', () => ({
  selectActiveAgentId: () => null,
  selectPanelAgentId: () => null,
  useSessionField: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeAgentId: null,
      panelAgentId: null,
      sessionsById: {},
    }),
}));

vi.mock('../../api/openAgentPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/openAgentPanel')>();
  return {
    ...actual,
    openAgentInSidePanel: vi.fn(),
    planOpenAgentInSidePanel: vi.fn(() => ({ action: 'focus', setActiveAgentId: false })),
  };
});

import { InlineAgentPanel } from './InlineAgentPanel';

function makeAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'subagent-perf-1',
    description: '并发性能与协议校验 subagent',
    mode: 'explore',
    status: 'running',
    startedAt: Date.now() - 1800,
    summary: '已扫描 12 个文件 -> 命中 2 个冲突点',
    messages: [],
    ...overrides,
  } as SessionAgent;
}

describe('InlineAgentPanel Time-Line Inline Badge (§5.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染时间线行内徽章：闪电图标、名称、工作中状态与呼吸绿点、链路追踪摘要', () => {
    const agent = makeAgent();
    const { container } = render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-main" />
    );

    // 检查行内徽章容器
    const root = container.querySelector('.flow-subagent');
    expect(root).not.toBeNull();
    expect(root?.classList.contains('is-running')).toBe(true);

    // Line 1: 闪电图标、标题、工作中与 5px 呼吸绿点
    expect(container.querySelector('[data-icon="zap"]')).not.toBeNull();
    expect(screen.getByText(/并发性能与协议校验 subagent/)).toBeDefined();
    expect(screen.getByText(/工作中/)).toBeDefined();
    expect(container.querySelector('.flow-subagent__dot')).not.toBeNull();

    // Line 2: 链路追踪摘要
    expect(
      screen.getByText('已扫描 12 个文件 -> 命中 2 个冲突点')
    ).toBeDefined();

    // 点击行内徽章分流到侧栏 openAgentInSidePanel
    const btn = screen.getByRole('button', { name: /并发性能与协议校验 subagent/ });
    fireEvent.click(btn);
    expect(openAgentPanelModule.openAgentInSidePanel).toHaveBeenCalledWith(
      'subagent-perf-1',
      { sessionId: 'sess-main' }
    );
  });
});
