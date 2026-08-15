// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TreeLeafPanel } from './TreeLeafPanel';
import * as workspaceShellModule from '../../store/workspace-shell';
import { useLayoutStore } from '../../store/layoutStore';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf } from '../../store/layout-tree/types';
import type { SessionState } from '../../store/types';

// Mock the lazy components to verify props and routing
vi.mock('../chat-card/ChatCard', () => ({
  ChatCard: (props: any) => (
    <div data-testid="mock-chat-card">
      <button
        data-testid="trigger-files-tool"
        onClick={() => props.handleGlobalTabClick('files')}
      >
        Open Files
      </button>
      <button
        data-testid="trigger-diff-tool"
        onClick={() => props.handleGlobalTabClick('diff')}
      >
        Open Diff
      </button>
    </div>
  ),
}));

vi.mock('../files/FilesCard', () => ({
  FilesCard: (props: any) => (
    <div
      data-testid="mock-files-card"
      data-has-toast={String(Boolean(props.onShowToast))}
    />
  ),
}));

vi.mock('../files/FileViewerCard', () => ({
  FileViewerCard: (props: any) => (
    <div
      data-testid={`mock-file-viewer-${props.filePath}`}
      data-path={props.filePath}
    />
  ),
}));

describe('TreeLeafPanel 真实路由分发与 Props 透传 (Task 1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLayoutStore.setState((st) => {
      st.sessionsById = {
        'session-123': {
          id: 'session-123',
          title: '会话 123',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [],
          agents: [],
        } as unknown as SessionState,
      };
      st.activeSessionId = 'session-123';
    });
  });

  it('TreeLeafPanel 渲染 ChatCard 时注入真实 handleOpenTool，点击工具入口触发 openToolInSession', async () => {
    const openToolSpy = vi
      .spyOn(workspaceShellModule, 'openToolInSession')
      .mockImplementation(() => {});

    const leaf = createLeaf('chat-leaf-1', ['chat'], 'chat', 'session-123');
    useLayoutTreeStore.setState({
      activeLeafId: leaf.id,
      tree: { root: leaf, version: 1 },
    });

    render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
        isActive={true}
        isDragSource={false}
        onShowToast={vi.fn()}
      />
    );

    const filesBtn = await waitFor(() =>
      screen.getByTestId('trigger-files-tool')
    );
    filesBtn.click();

    expect(openToolSpy).toHaveBeenCalledWith('session-123', 'files');

    const diffBtn = screen.getByTestId('trigger-diff-tool');
    diffBtn.click();

    expect(openToolSpy).toHaveBeenCalledWith('session-123', 'diff');
  });

  it('TreeLeafPanel 渲染 FilesCard 时透传 onShowToast', async () => {
    const onShowToast = vi.fn();
    const leaf = createLeaf(
      'tool-leaf-files',
      ['files'],
      'files',
      'session-123'
    );

    render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
        isDragSource={false}
        onShowToast={onShowToast}
      />
    );

    const filesCard = await waitFor(() =>
      screen.getByTestId('mock-files-card')
    );
    expect(filesCard.getAttribute('data-has-toast')).toBe('true');
  });
});
