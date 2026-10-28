// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react';
import { TreeLeafPanel } from './TreeLeafPanel';
import * as workspaceShellModule from '../../store/workspace-shell';
import * as storeAccess from '../../store/storeAccess';
import { useLayoutStore } from '../../store/layoutStore';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createDefaultDock } from '../../store/layout-tree/sessionTabModel';
import type { LayoutLeaf, SessionState } from '../../store/types';
import {
  registerBuiltInViews,
  type ViewFactoryMap,
} from '../../services/view-registry';
import type { ViewRenderContext } from '../../services/view-registry';
import { lazy } from 'react';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper';

// audit-repair-202609 T3：mock ptyRegistry（TreeLeafPanel 经动态 import 调用）
vi.mock('../../api/ptyRegistry', () => ({
  ensurePtyForSession: vi.fn(async () => 'pty-mock'),
  killPtyForSession: vi.fn(async () => undefined),
  killPtyForSessionBackground: vi.fn(),
  ptyRegistry: new Map(),
  bindSessionPty: vi.fn(),
  getSessionPty: vi.fn(),
  registerPtyBinding: vi.fn(),
  unbind: vi.fn(),
}));

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
  FilesCard: () => <div data-testid="mock-files-card" />,
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
const stubFactory = () =>
  (() => null) as unknown as React.ComponentType<ViewRenderContext>;
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

function makeChatLeaf(opts: {
  id?: string;
  sessionId: string;
  tabId?: string;
  dock?: unknown;
}): LayoutLeaf {
  const tabId = opts.tabId ?? 'tab-1';
  const dock = createDefaultDock(opts.dock);
  return {
    type: 'leaf',
    id: opts.id ?? 'chat-leaf-1',
    panelId: 'chat',
    tabs: [
      {
        tabId,
        sessionId: opts.sessionId,
        title: opts.sessionId,
        workspaceKey: '对话',
        dock,
      },
    ],
    activeTab: 'chat',
    activeTabId: tabId,
    dock,
  } as unknown as LayoutLeaf;
}

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

  it('TreeLeafPanel 渲染 ChatCard 时注入真实 handleOpenTool，点击工具入口触发 openToolInLeaf', async () => {
    const openToolSpy = vi
      .spyOn(workspaceShellModule, 'openToolInLeaf')
      .mockImplementation(() => {});

    const leaf = makeChatLeaf({
      id: 'chat-leaf-1',
      sessionId: 'session-123',
    });
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

    expect(openToolSpy).toHaveBeenCalledWith('chat-leaf-1', 'files');

    const diffBtn = screen.getByTestId('trigger-diff-tool');
    diffBtn.click();

    expect(openToolSpy).toHaveBeenCalledWith('chat-leaf-1', 'diff');
  });

  it('chat 叶 dock 开 files 时抽屉内渲染 FilesCard，叶根仍 data-panel-id=chat', async () => {
    const leaf = makeChatLeaf({
      id: 'chat-leaf-files',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['files'],
        activePanelId: 'files',
        widthRatio: 0.4,
      },
    });

    const { container } = render(
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
    const root = container.querySelector('[data-leaf-id]') as HTMLElement;
    expect(root.getAttribute('data-panel-id')).toBe('chat');
    expect(root.getAttribute('data-dock-open')).toBe('true');
    expect(
      container.querySelector('[data-leaf-tool-tab-strip="true"]')
    ).toBeTruthy();
  });

  it('F6 默认 chat 叶出现顶快捷行；打开文件在对话顶；不挂 LeafToolTabStrip', async () => {
    deactivateNotePaper();
    const leaf = makeChatLeaf({ id: 'chat', sessionId: 'session-123' });
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
    expect(getByTestId('top-quick-files-btn')).toBeTruthy();
    expect(getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(getByTestId('chat-header-more')).toBeTruthy();
    expect(queryByTestId('right-dock-toggle')).toBeNull();
    const dockBtn = getByTestId('top-quick-dock-btn');
    expect(dockBtn).toBeTruthy();
    expect(chrome?.contains(dockBtn)).toBe(false);
    expect(container.querySelector('[data-leaf-id]')?.contains(dockBtn)).toBe(
      true
    );
  });

  it('F11 note 未注册时抽屉空态 fallback，叶根仍 chat', () => {
    deactivateNotePaper();
    const leaf = makeChatLeaf({
      id: 'chat-note',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['note'],
        activePanelId: 'note',
        widthRatio: 0.4,
      },
    });
    const { container } = render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
        isDragSource={false}
      />
    );
    expect(screen.getByText(/未能加载工具: note/)).toBeTruthy();
    expect(screen.queryByTestId('note-paper-strict-panel')).toBeNull();
    expect(
      container.querySelector('[data-leaf-id]')?.getAttribute('data-panel-id')
    ).toBe('chat');
  });

  it('计划任务管理界面 (chatMainSurface === "scheduled") 下，右侧工具坞绝对不渲染，顶栏坞开关隐藏', async () => {
    act(() => {
      useLayoutStore.setState({ chatMainSurface: 'scheduled' });
    });

    const leaf = makeChatLeaf({
      id: 'chat-leaf-scheduled',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['files'],
        activePanelId: 'files',
      },
    });

    const { container, queryByTestId } = render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const root = container.querySelector('[data-leaf-id]') as HTMLElement;
    expect(root.getAttribute('data-dock-open')).toBe('false');
    expect(queryByTestId('top-quick-dock-btn')).toBeNull();
    expect(
      container.querySelector('[data-leaf-dock-drawer="true"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-unit-chrome-actions="true"]')
    ).toBeNull();
  });

  it('点击右侧面板全屏/最大化按钮，抽屉获得 maximized 类名并覆盖，再次点击恢复', async () => {
    act(() => {
      useLayoutStore.setState({ chatMainSurface: 'chat' });
    });

    const leaf = makeChatLeaf({
      id: 'chat-leaf-max',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['files'],
        activePanelId: 'files',
      },
    });

    const { container, getByLabelText, getByTestId } = render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const drawer = container.querySelector(
      '[data-leaf-dock-drawer="true"]'
    ) as HTMLElement;
    expect(drawer).toBeTruthy();
    expect(drawer.getAttribute('data-maximized')).toBe('false');
    expect(drawer.className).not.toContain('maximized');
    expect(getByTestId('top-quick-dock-btn')).toBeTruthy();

    const maxBtn = getByLabelText(/最大化(面板|窗格)/);
    fireEvent.click(maxBtn);

    expect(drawer.getAttribute('data-maximized')).toBe('true');
    expect(drawer.className).toContain('maximized');
    // 最大化全屏时，右侧边栏切换按钮仍常驻可见
    expect(getByTestId('top-quick-dock-btn')).toBeTruthy();

    const restoreBtn = getByLabelText(/恢(复|原)(面板|窗格)/);
    fireEvent.click(restoreBtn);

    expect(drawer.getAttribute('data-maximized')).toBe('false');
    expect(drawer.className).not.toContain('maximized');
    expect(getByTestId('top-quick-dock-btn')).toBeTruthy();
  });

  it('关闭最后一个标签时，触发 updateLeafDock 将 collapsed 置为 true', async () => {
    act(() => {
      useLayoutStore.setState({ chatMainSurface: 'chat' });
    });

    const updateLeafDockSpy = vi
      .spyOn(storeAccess, 'updateLeafDock')
      .mockImplementation(() => {});

    const leaf = makeChatLeaf({
      id: 'chat-leaf-close-last',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['files'],
        activePanelId: 'files',
      },
    });

    const { getByLabelText, container } = render(
      <TreeLeafPanel
        leaf={leaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const closeBtn = getByLabelText('关闭 文件');
    fireEvent.click(closeBtn);

    const filesTab = container.querySelector('.side-panel-tab-item')!;
    fireEvent.transitionEnd(filesTab, { propertyName: 'max-width' });

    expect(updateLeafDockSpy).toHaveBeenCalledWith(
      'chat-leaf-close-last',
      expect.objectContaining({ collapsed: true })
    );
  });

  it('在 tabModeEnabled 模式下，已打开的多个 Dock 标签保持 Keep-Alive 常驻保活，仅通过 display 切换显隐', async () => {
    act(() => {
      useLayoutStore.setState({ chatMainSurface: 'chat' });
    });

    const leafWithTwoTabs = makeChatLeaf({
      id: 'chat-leaf-keep-alive',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['files', 'terminal'],
        activePanelId: 'files',
      },
    });

    const { container, rerender } = render(
      <TreeLeafPanel
        leaf={leafWithTwoTabs}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const filesPane = container.querySelector(
      'div[data-view-id="files"]'
    ) as HTMLElement;
    const terminalPane = container.querySelector(
      'div[data-view-id="terminal"]'
    ) as HTMLElement;

    expect(filesPane).toBeTruthy();
    expect(terminalPane).toBeTruthy();

    expect(filesPane.getAttribute('data-active-tab')).toBe('true');
    expect(filesPane.getAttribute('aria-hidden')).toBe('false');
    expect(filesPane.style.display).toBe('flex');

    expect(terminalPane.getAttribute('data-active-tab')).toBe('false');
    expect(terminalPane.getAttribute('aria-hidden')).toBe('true');
    expect(terminalPane.style.display).toBe('none');

    // 切换到 terminal 标签
    const updatedLeaf = makeChatLeaf({
      id: 'chat-leaf-keep-alive',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['files', 'terminal'],
        activePanelId: 'terminal',
      },
    });

    rerender(
      <TreeLeafPanel
        leaf={updatedLeaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
        isDragSource={false}
      />
    );

    const updatedFiles = container.querySelector(
      'div[data-view-id="files"]'
    ) as HTMLElement;
    const updatedTerm = container.querySelector(
      'div[data-view-id="terminal"]'
    ) as HTMLElement;

    expect(updatedFiles.getAttribute('data-active-tab')).toBe('false');
    expect(updatedFiles.getAttribute('aria-hidden')).toBe('true');
    expect(updatedFiles.style.display).toBe('none');

    expect(updatedTerm.getAttribute('data-active-tab')).toBe('true');
    expect(updatedTerm.getAttribute('aria-hidden')).toBe('false');
    expect(updatedTerm.style.display).toBe('flex');
  });

  it('closing terminal tab kills exactly the session-scoped pty keys (T3)', async () => {
    const ptyRegistryModule = await import('../../api/ptyRegistry');
    const killSpy = vi.mocked(ptyRegistryModule.killPtyForSession);
    killSpy.mockClear();

    const leaf = makeChatLeaf({
      id: 'term-leaf-1',
      sessionId: 'session-123',
      dock: {
        collapsed: false,
        openPanelIds: ['terminal'],
        activePanelId: 'terminal',
      },
    });
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

    const closeBtn = await screen.findByRole('button', { name: '关闭 终端' });
    fireEvent.click(closeBtn);

    // 精准断言：只杀 `<sid>` 与 `<sid>:split-2`，禁止无前缀霰弹 key
    await waitFor(() => {
      expect(killSpy).toHaveBeenCalled();
    });
    const killedKeys = killSpy.mock.calls.map((c) => c[0]);
    expect(
      killedKeys.some(
        (k) => k.startsWith('dtab_terminal') || k === 'session-123'
      )
    ).toBe(true);
  });
});
