// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { ChatToolStack } from '../../src/components/chat-tool-call/ChatToolCallBlock';
import type { MessageToolCall } from '../../src/store/layoutStore';
import type { ToolRenderItem } from '../../src/api/toolPresentation';

function makeItem(
  tc: Partial<MessageToolCall> & {
    id: string;
    name: string;
    status: MessageToolCall['status'];
  }
): ToolRenderItem {
  return {
    kind: 'single',
    tc: {
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments || '{}',
      status: tc.status,
      output: tc.output,
      diffs: tc.diffs,
      explanation: tc.explanation,
    } as MessageToolCall,
  };
}

const sharedProps = {
  agents: [],
  activeSessionId: '',
  expandedTools: {},
  onToggleTool: vi.fn(),
  approvalBusy: false,
  pendingApprovalMsgId: '',
  onOpenDiff: vi.fn(),
  onOpenPath: vi.fn(),
  onOpenTerminal: vi.fn(),
  onApprovalAllow: vi.fn(),
  onApprovalDeny: vi.fn(),
};

/**
 * 把 Tooltip useId 生成的 aria-describedby 序列化为稳定序号。
 * 全量套件下 useId 计数依赖挂载顺序，直接快照会跨 run 漂移。
 */
function withStableDescribedBy(node: Element | null): Element | null {
  if (!node) return node;
  let seq = 0;
  const map = new Map<string, string>();
  for (const el of node.querySelectorAll('[aria-describedby]')) {
    const raw = el.getAttribute('aria-describedby');
    if (!raw) continue;
    const next = raw
      .split(/\s+/)
      .map((token) => {
        if (!/^_r_[^_].*_/.test(token) && !/^:r/.test(token) && !/_r_/.test(token)) {
          return token;
        }
        if (!map.has(token)) map.set(token, `_r_${seq++}_`);
        return map.get(token)!;
      })
      .join(' ');
    el.setAttribute('aria-describedby', next);
  }
  return node;
}

/**
 * 快照归一化之外，保持每个 Tooltip 触发器的一对一引用不变量。
 * 该断言不能只依赖快照文本，否则归一化器把两个真实 ID 合并时不会报警。
 */
function assertDescribedByReferences(node: Element | null): void {
  expect(node).not.toBeNull();
  if (!node) return;

  const elements = Array.from(
    node.querySelectorAll<HTMLElement>('[aria-describedby]')
  );
  const references = elements.flatMap((element) => {
    const value = element.getAttribute('aria-describedby') || '';
    const tokens = value.split(/\s+/).filter(Boolean);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens).size).toBe(tokens.length);
    return tokens;
  });

  expect(references.length).toBeGreaterThan(0);
  expect(new Set(references).size).toBe(references.length);
}

describe('ChatToolCallBlock snapshots', () => {
  it('renders successful tool', () => {
    const items = [
      makeItem({
        id: 'tool_success',
        name: 'read_file',
        status: 'success',
        arguments: JSON.stringify({ filePath: '/src/main.ts' }),
        output: 'file content loaded',
      }),
    ];
    const { container } = render(
      <ChatToolStack items={items} {...sharedProps} />
    );
    const root = withStableDescribedBy(container.firstChild);
    assertDescribedByReferences(root);
    expect(root).toMatchSnapshot();
  });

  it('renders error tool', () => {
    const items = [
      makeItem({
        id: 'tool_error',
        name: 'shell',
        status: 'error',
        arguments: JSON.stringify({ command: 'npm run build' }),
        output: 'Error: build failed - syntax error in src/index.ts',
      }),
    ];
    const { container } = render(
      <ChatToolStack items={items} {...sharedProps} />
    );
    const root = withStableDescribedBy(container.firstChild);
    assertDescribedByReferences(root);
    expect(root).toMatchSnapshot();
  });

  it('renders running tool', () => {
    const items = [
      makeItem({
        id: 'tool_running',
        name: 'shell',
        status: 'running',
        arguments: JSON.stringify({ command: 'npm test' }),
      }),
    ];
    const { container } = render(
      <ChatToolStack items={items} {...sharedProps} />
    );
    const root = withStableDescribedBy(container.firstChild);
    assertDescribedByReferences(root);
    expect(root).toMatchSnapshot();
  });

  it('renders tool with duration', () => {
    const items = [
      makeItem({
        id: 'tool_duration',
        name: 'edit_file',
        status: 'success',
        arguments: JSON.stringify({ filePath: '/src/utils.ts' }),
        output:
          'Applied 3 changes:\n- Added import\n- Refactored helper\n- Updated types',
      }),
    ];
    const { container } = render(
      <ChatToolStack items={items} {...sharedProps} />
    );
    const root = withStableDescribedBy(container.firstChild);
    assertDescribedByReferences(root);
    expect(root).toMatchSnapshot();
  });

  it('keeps a real aria-describedby relation when the tooltip is mounted', () => {
    const items = [
      makeItem({
        id: 'tool_relation',
        name: 'read_file',
        status: 'success',
        arguments: JSON.stringify({ filePath: '/src/main.ts' }),
        output: 'file content loaded',
      }),
    ];
    const { container } = render(
      <ChatToolStack items={items} {...sharedProps} />
    );
    const root = container.firstChild;
    assertDescribedByReferences(root);
    const target = root?.querySelector<HTMLElement>('button[aria-describedby]');
    expect(target).not.toBeNull();
    if (!target) return;

    vi.useFakeTimers();
    try {
      fireEvent.focus(target);
      act(() => vi.advanceTimersByTime(350));
      const describedBy = target.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
      expect(describedBy).toHaveLength(1);
      const tooltip = document.getElementById(describedBy[0]!);
      expect(tooltip).toHaveAttribute('role', 'tooltip');
      expect(tooltip).toBeInTheDocument();
    } finally {
      fireEvent.blur(target);
      vi.useRealTimers();
    }
  });
});
