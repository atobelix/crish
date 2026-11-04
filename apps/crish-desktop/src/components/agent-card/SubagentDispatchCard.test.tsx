// @vitest-environment jsdom
/**
 * R4b 流内分派卡验收：
 *  - 状态行三态（运行：当前动作+已完成 N/M 步+已用时 / 完成：结论首行+用时·共 N 个工具 /
 *    失败：错误类别+摘要+重试/关闭上卡面）
 *  - 身份标与 resolveAgentIdentities 会话分配一致（并行两卡不同色）
 *  - 待审批徽标按 R7 arbiter 口径（main-agent 裁决不计）
 *  - 整卡点击走 openAgentInSidePanel；恢复按钮点击不触发进侧栏
 *  - 负断言：卡面不渲染 agent 的消息正文/工具输出（无主流内展开体）
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { SessionAgent } from '../../store/types';
import { resolveAgentIdentities } from '../../api/tool-presentation/agentIdentity';
import { SubagentDispatchCard } from './SubagentDispatchCard';

const h = vi.hoisted(() => ({
  state: {
    sessionsById: {} as Record<string, unknown>,
    panelAgentId: null as string | null,
    activeAgentId: null as string | null,
  },
  openAgentInSidePanel: vi.fn(),
  resumeSubagent: vi.fn(async () => ({ ok: true, message: '已恢复' })),
  killSubagent: vi.fn(async () => ({ ok: true, message: '已关闭' })),
}));

vi.mock('../../store/storeAccess', () => ({
  useSessionField: (selector: (s: typeof h.state) => unknown) =>
    selector(h.state),
  selectSessionsById: (s: typeof h.state) => s.sessionsById,
  selectPanelAgentId: (s: typeof h.state) => s.panelAgentId,
  selectActiveAgentId: (s: typeof h.state) => s.activeAgentId,
}));

vi.mock('../../api/subagentRecoveryApi', () => ({
  isRecoveryCommandReady: () => true,
  resumeSubagent: h.resumeSubagent,
  killSubagent: h.killSubagent,
}));

vi.mock('../../api/openAgentPanel', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/openAgentPanel')>();
  return { ...actual, openAgentInSidePanel: h.openAgentInSidePanel };
});

function makeAgent(over: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: 'ag-1',
    parentSessionId: 'sess-1',
    parentToolCallId: 't-sub-1',
    displayLabel: 'researcher',
    status: 'running',
    messages: [],
    startedAt: Date.now() - 3_000,
    ...over,
  } as SessionAgent;
}

function setSession(agents: SessionAgent[]) {
  h.state.sessionsById = {
    'sess-1': { id: 'sess-1', agents, messages: [] },
  };
}

function toolMsg(toolCalls: unknown[]) {
  return [
    { id: 'm1', role: 'assistant', content: '', toolCalls },
  ] as unknown as SessionAgent['messages'];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.panelAgentId = null;
  h.state.activeAgentId = null;
});

describe('SubagentDispatchCard', () => {
  it('运行态：角色名标题 + 运行中 + 当前动作与已完成 N/M 步', () => {
    const agent = makeAgent({
      messages: toolMsg([
        { id: 'c1', name: 'read_file', status: 'success' },
        { id: 'c2', name: 'grep_search', status: 'running' },
      ]),
    });
    setSession([agent]);
    const { container } = render(
      <SubagentDispatchCard agent={agent} parentSessionId="sess-1" />
    );
    const card = container.querySelector('[data-dispatch-card="1"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-agent-id')).toBe('ag-1');
    expect(card?.getAttribute('data-parent-tool-call-id')).toBe('t-sub-1');
    expect(card?.getAttribute('data-status')).toBe('running');
    expect(card?.textContent).toContain('研究员');
    expect(card?.textContent).toContain('运行中');
    expect(card?.textContent).toContain('已完成 1/2 步');
  });

  it('身份一致：并行两卡的身份标与会话分配同色且互不撞色', () => {
    const a1 = makeAgent({ id: 'ag-1' });
    const a2 = makeAgent({ id: 'ag-2', displayLabel: 'implementer' });
    setSession([a1, a2]);
    const expected = resolveAgentIdentities([a1, a2]);
    const { container } = render(
      <>
        <SubagentDispatchCard agent={a1} parentSessionId="sess-1" />
        <SubagentDispatchCard agent={a2} parentSessionId="sess-1" />
      </>
    );
    const hues = Array.from(container.querySelectorAll('[data-hue-index]')).map(
      (el) => el.getAttribute('data-hue-index')
    );
    expect(hues).toEqual([
      String(expected.get('ag-1')?.hueIndex),
      String(expected.get('ag-2')?.hueIndex),
    ]);
    expect(hues[0]).not.toBe(hues[1]);
  });

  it('完成态：结论首行 + 用时 · 共 N 个工具', () => {
    const agent = makeAgent({
      status: 'completed',
      summary: '结论第一行\n细节第二行不应上卡',
      startedAt: 1_000,
      finishedAt: 61_000,
      messages: toolMsg([
        { id: 'c1', name: 'read_file', status: 'success' },
        { id: 'c2', name: 'grep_search', status: 'success' },
        { id: 'c3', name: 'run_command', status: 'success' },
      ]),
    });
    setSession([agent]);
    const { container } = render(
      <SubagentDispatchCard agent={agent} parentSessionId="sess-1" />
    );
    const card = container.querySelector('[data-dispatch-card="1"]');
    expect(card?.textContent).toContain('已完成');
    expect(card?.textContent).toContain('结论第一行');
    expect(card?.textContent).not.toContain('细节第二行不应上卡');
    expect(card?.textContent).toContain('共 3 个工具');
    expect(card?.textContent).toContain('用时');
  });

  it('失败态：错误类别 + 摘要 + 重试/关闭在卡面，恢复点击不进侧栏', async () => {
    const agent = makeAgent({
      status: 'failed',
      summary: '连接超时未能完成',
    });
    setSession([agent]);
    const { container, getByRole } = render(
      <SubagentDispatchCard agent={agent} parentSessionId="sess-1" />
    );
    const card = container.querySelector('[data-dispatch-card="1"]');
    expect(card?.textContent).toContain('失败');
    expect(card?.textContent).toContain('执行异常');
    expect(card?.textContent).toContain('连接超时未能完成');
    fireEvent.click(getByRole('button', { name: '重试恢复' }));
    await waitFor(() => {
      expect(h.resumeSubagent).toHaveBeenCalledTimes(1);
    });
    expect(h.openAgentInSidePanel).not.toHaveBeenCalled();
    expect(getByRole('button', { name: '关闭' })).toBeTruthy();
  });

  it('待审批徽标：arbiter 缺省计入、main-agent 裁决不计', () => {
    const pendingUser = makeAgent({
      id: 'ag-p1',
      messages: toolMsg([
        { id: 'c1', name: 'run_command', status: 'pending_approval' },
      ]),
    });
    const pendingMain = makeAgent({
      id: 'ag-p2',
      messages: toolMsg([
        {
          id: 'c1',
          name: 'run_command',
          status: 'pending_approval',
          approvalMeta: { arbiter: 'main-agent' },
        },
      ]),
    });
    setSession([pendingUser, pendingMain]);
    const { container } = render(
      <>
        <SubagentDispatchCard agent={pendingUser} parentSessionId="sess-1" />
        <SubagentDispatchCard agent={pendingMain} parentSessionId="sess-1" />
      </>
    );
    const cards = container.querySelectorAll('[data-dispatch-card="1"]');
    expect(cards[0]?.textContent).toContain('1 待批');
    expect(cards[1]?.textContent).not.toContain('待批');
  });

  it('整卡点击 → openAgentInSidePanel(agentId, { sessionId })', () => {
    const agent = makeAgent();
    setSession([agent]);
    const { container } = render(
      <SubagentDispatchCard agent={agent} parentSessionId="sess-1" />
    );
    const card = container.querySelector('[data-dispatch-card="1"]');
    fireEvent.click(card as HTMLElement);
    expect(h.openAgentInSidePanel).toHaveBeenCalledWith('ag-1', {
      sessionId: 'sess-1',
    });
  });

  it('负断言：卡面不渲染 agent 消息正文与工具输出（无展开体）', () => {
    const agent = makeAgent({
      messages: [
        {
          id: 'm0',
          role: 'assistant',
          content: '深层消息正文XYZ',
          toolCalls: [
            {
              id: 'c1',
              name: 'read_file',
              status: 'running',
              output: '深层工具输出XYZ',
            },
          ],
        },
      ] as unknown as SessionAgent['messages'],
    });
    setSession([agent]);
    const { container } = render(
      <SubagentDispatchCard agent={agent} parentSessionId="sess-1" />
    );
    const card = container.querySelector('[data-dispatch-card="1"]');
    expect(card?.textContent).not.toContain('深层消息正文XYZ');
    expect(card?.textContent).not.toContain('深层工具输出XYZ');
    expect(
      card?.querySelector('[data-inline-agent-panel], [data-testid="markdown"]')
    ).toBeNull();
  });
});
