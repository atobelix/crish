// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { TreeLeafPanel } from './TreeLeafPanel';
import * as workspaceShellModule from '../../store/workspace-shell';
import { useLayoutStore } from '../../store/layoutStore';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf } from '../../store/layout-tree/types';
import type { SessionState } from '../../store/types';
import { registerBuiltInViews, type ViewFactoryMap } from '../../services/view-registry';
import type { ViewRenderContext } from '../../services/view-registry';
import { lazy } from 'react';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper';

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
  FilesCard: () => (
    <div data-testid="mock-files-card" />
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

// 维度 3 步骤 1 / 3-E：registerBuiltInViews 改为接收 factory 参数注入。
// 测试仅 chat/files/file-viewer 被实际渲染（vi.mock 已拦截），其余视图用 stub。
const stubFactory = () => (() => null) as unknown as React.ComponentType<ViewRenderContext>;
const routingTestFactories: ViewFactoryMap = {
  chat: () =>
    lazy(() =>
      import('../chat-card/ChatCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.ChatCard
            sessionId={ctx.sessionId}
            handleGlobalTabClick={ctx.openView}
          />
        ),
      }))
    ),
  files: () =>
    lazy(() =>
      import('../files/FilesCard').then((m) => ({
        default: () => <m.FilesCard />,
      }))
    ),
  'file-viewer': () =>
    lazy(() =>
      import('../files/FileViewerCard').then((m) => ({
        default: (ctx: ViewRenderContext) => {
          const filePath = (ctx.params?.filePath as string) || '';
          const initialMode =
            (ctx.params?.initialMode as 'plain' | 'diff') || 'plain';
          return (
            <m.FileViewerCard
              key={filePath}
              filePath={filePath}
              initialMode={initialMode}
            />
          );
        },
      }))
    ),
  terminal: stubFactory,
  preview: stubFactory,
  overview: stubFactory,
  diff: stubFactory,
  runtime: stubFactory,
  agent: stubFactory,
  browser: stubFactory,
  'flow-dag': stubFactory,
};

describe('TreeLeafPanel 真实路由分发与 Props 透传 (Task 1)', () => {
  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    deactivateNotePaper();
    registerBuiltInViews(routingTestFactories);
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

  it('TreeLeafPanel 渲染 FilesCard', async () => {
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
      />
    );

    const filesCard = await waitFor(() =>
      screen.getByTestId('mock-files-card')
    );
    expect(filesCard).toBeDefined();
  });

  it('F6 默认 chat 叶出现顶快捷行；打开文件在对话顶；不挂 LeafToolTabStrip', async () => {
    deactivateNotePaper();
    const leaf = createLeaf('chat', ['chat'], 'chat', 'session-123');
    useLayoutTreeStore.setState({
      activeLeafId: leaf.id,
      tree: { root: leaf, version: 1 },
    });

    const { container, getByTestId, queryByTestId } = render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const chrome = container.querySelector('[data-unit-chrome-actions="true"]');
    expect(chrome).toBeTruthy();
    expect(chrome?.getAttribute('data-chat-top-header')).toBe('true');
    expect(chrome?.hasAttribute('data-canvas-quiet')).toBe(false);
    expect(container.querySelector('[data-leaf-tool-tab-strip]')).toBeNull();
    expect(getByTestId('top-quick-artifacts-btn')).toBeTruthy();
    expect(getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();
    expect(getByTestId('chat-header-more')).toBeTruthy();
  });

  it('F11 note 未注册时本地 fallback，不是纯空白', () => {
    deactivateNotePaper();
    const leaf = createLeaf('note', ['note'], 'note', 'session-123');
    render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
        isDragSource={false}
      />
    );
    expect(screen.getByText(/未知面板类型：note/)).toBeTruthy();
    expect(screen.getByText(/笔记扩展未激活/)).toBeTruthy();
    expect(screen.queryByTestId('note-paper-strict-panel')).toBeNull();
  });
});
