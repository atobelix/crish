// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
    expect(container.firstChild).toMatchSnapshot();
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
    expect(container.firstChild).toMatchSnapshot();
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
    expect(container.firstChild).toMatchSnapshot();
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
    expect(container.firstChild).toMatchSnapshot();
  });
});
