/**
 * OPT-B6 / dedup #5: InlineAgentPanel 展开消息区的 Markdown 渲染路径。
 *
 * 观测面（2026-09-15 修正）：面板已不再经 StreamingMarkdownView 中转，
 * 而是对每条消息直挂一个 MarkdownBlockItem 根块
 * （InlineAgentPanel.tsx:228）。故断言必须落在 MarkdownBlockItem 真实
 * 渲染出的 DOM 契约上，而非某个中间组件被调用的次数：
 *   - 封口分支（isSealed=true）：data-sealed="true" / data-streaming="false"
 *     + class 含 md-block-sealed（等待 Rust 异步 HTML 注入，不画源码）；
 *   - 活跃尾块分支（isActiveTail = isStreaming && isLast && !isSealed）：
 *     data-sealed="false" / data-streaming="true" + class 含 md-block-active，
 *     且只注入 Markdown 渲染器生成的 HTML，不把源码写进容器。
 *
 * 回归背景：历史实现恒传 isLast={false}，使 processing 消息的 isActiveTail
 * 恒为 false，落入封口分支渲染成空容器 ⇒ 子代理实时正文不可见。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionAgent } from '../../store/types';

vi.mock('../../store/sessionStore', () => ({
  selectActiveAgentId: (s: { activeAgentId?: string | null }) =>
    s.activeAgentId ?? null,
  selectPanelAgentId: (s: { panelAgentId?: string | null }) =>
    s.panelAgentId ?? null,
  useSessionField: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeAgentId: null,
      panelAgentId: null,
      sessionsById: {},
    }),
}));

vi.mock('../../hooks/useAgentStream', () => ({
  useAgentPanel: () => ({
    handleSend: vi.fn(),
    handleStopGeneration: vi.fn(),
    handleForceCancelGeneration: vi.fn(),
    sending: false,
    stopping: false,
    expandedTools: {},
    onToggleTool: vi.fn(),
  }),
}));

vi.mock('../../hooks/useAgentToolApproval', () => ({
  useAgentToolApproval: () => ({
    approvalBusy: false,
    onApprovalAllow: vi.fn(),
    onApprovalDeny: vi.fn(),
  }),
}));

vi.mock('../chat-composer/ChatComposer', () => ({
  ComposerField: () => <div data-testid="composer-field" />,
}));

vi.mock('../chat-tool-call/ChatToolCallBlock', () => ({
  ChatToolStack: () => <div data-testid="tool-stack" />,
}));

vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../../api/markdownRenderLite', () => ({
  stripThoughtPlaceholders: (t: string) => t,
}));

vi.mock('../../api/markdownRenderAsync', () => {
  const render = (markdown: string) =>
    `<p>${markdown.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p>`;
  return {
    useAsyncMarkdownHtml: vi.fn((markdown: string) => ({
      html: markdown ? render(markdown) : '',
      loading: false,
      failed: false,
    })),
    useStreamingMarkdownHtml: vi.fn((markdown: string, enabled: boolean) =>
      enabled && markdown ? render(markdown) : ''
    ),
  };
});

import { InlineAgentPanel } from './InlineAgentPanel';

function makeAgent(
  overrides: Partial<SessionAgent> & {
    messages?: SessionAgent['messages'];
  }
): SessionAgent {
  return {
    id: 'agent-1',
    mode: 'explore',
    description: 'test agent',
    status: 'completed',
    messages: [],
    ...overrides,
  } as SessionAgent;
}

/** 取面板展开消息区内全部 MarkdownBlockItem 根块（按 DOM 顺序） */
function getMdBlocks(): HTMLElement[] {
  const panel = document.querySelector('.flow-subagent__panel-inner');
  expect(panel).not.toBeNull();
  return Array.from(
    panel!.querySelectorAll<HTMLElement>('[data-md-variant="chat"]')
  );
}

describe('InlineAgentPanel markdown path (dedup #5)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('completed assistant text uses the sealed branch (isSealed=true, isStreaming=false)', () => {
    const agent = makeAgent({
      status: 'completed',
      messages: [
        {
          id: 'a1',
          sender: 'assistant',
          text: '**done** body',
          timestamp: 1,
          status: 'completed',
        },
      ],
    });

    render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-1" defaultOpen />
    );

    const blocks = getMdBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // 封口分支契约：data-sealed="true" / data-streaming="false"
    expect(blocks[0]!.getAttribute('data-sealed')).toBe('true');
    expect(blocks[0]!.getAttribute('data-streaming')).toBe('false');
    expect(blocks[0]!.className).toContain('md-block-sealed');
    expect(blocks[0]!.className).not.toContain('md-block-active');
    // 封口块禁止把 Markdown 源码直接画给用户（缓存未命中时保持空容器，
    // 等待 Rust 异步 HTML 原子替换）。
    expect(blocks[0]!.textContent).not.toContain('**done**');
    // 全块范围内不得出现活跃尾块
    expect(
      document.querySelectorAll('[data-sealed="false"]').length
    ).toBe(0);
  });

  it('processing assistant text stays on the active-tail branch and shows rendered HTML only', () => {
    const agent = makeAgent({
      status: 'running',
      messages: [
        {
          id: 'a2',
          sender: 'assistant',
          text: 'partial stream…',
          timestamp: 2,
          status: 'processing',
        },
      ],
    });

    render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-1" defaultOpen />
    );

    const blocks = getMdBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // 活跃尾块分支契约（回归核心）：isLast 必须让未封口块成为尾块，
    // 否则 isActiveTail 恒 false ⇒ 渲染成空容器。
    expect(blocks[0]!.getAttribute('data-sealed')).toBe('false');
    expect(blocks[0]!.getAttribute('data-streaming')).toBe('true');
    expect(blocks[0]!.className).toContain('md-block-active');
    expect(blocks[0]!.className).not.toContain('md-block-sealed');
    // 活跃尾块只显示解析后的 HTML；等待编译时不允许源码落进 DOM。
    expect(blocks[0]!.textContent).toContain('partial stream…');
    expect(blocks[0]!.innerHTML).toBe('<p>partial stream…</p>');
    expect(blocks[0]!.textContent).not.toContain('**');
  });

  it('未封口块恰好是活跃尾块（isLast 契约，禁止恒 false）', () => {
    const agent = makeAgent({
      status: 'running',
      messages: [
        {
          id: 'a3',
          sender: 'assistant',
          text: '已完成段落',
          timestamp: 3,
          status: 'completed',
        },
        {
          id: 'a4',
          sender: 'assistant',
          text: '正在追加的段落',
          timestamp: 4,
          status: 'processing',
        },
      ],
    });

    render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-1" defaultOpen />
    );

    const blocks = getMdBlocks();
    expect(blocks).toHaveLength(2);
    // 已封口块 → 封口分支
    expect(blocks[0]!.getAttribute('data-sealed')).toBe('true');
    expect(blocks[0]!.getAttribute('data-streaming')).toBe('false');
    // 未封口块 → 活跃尾块分支（安全编译后正文可见）
    expect(blocks[1]!.getAttribute('data-sealed')).toBe('false');
    expect(blocks[1]!.getAttribute('data-streaming')).toBe('true');
    expect(blocks[1]!.textContent).toContain('正在追加的段落');
    expect(blocks[1]!.innerHTML).toBe('<p>正在追加的段落</p>');
  });

  it('空文本消息不产生 Markdown 根块', () => {
    const agent = makeAgent({
      status: 'completed',
      messages: [
        {
          id: 'a5',
          sender: 'assistant',
          text: '',
          timestamp: 5,
          status: 'completed',
        },
      ],
    });

    render(
      <InlineAgentPanel agent={agent} parentSessionId="sess-1" defaultOpen />
    );

    expect(getMdBlocks()).toHaveLength(0);
    expect(screen.getByRole('region')).toBeInTheDocument();
  });
});
