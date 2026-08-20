// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { UnitChromeActions } from './UnitChromeActions';
import { viewRegistry } from '../../services/view-registry';
import { UNIT_CHROME_TOOL_TIP_SIDE } from './unitChromeLabel';
import {
  useWorkspaceShellStore,
  createDefaultDock,
} from '../../store/workspace-shell';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { useLayoutStore } from '../../store/layoutStore';
import { useSessionStore } from '../../store/sessionStore';
import type { SessionState } from '../../store/types';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';
import { EMPTY_SESSION_TITLE } from '../../api/sessionTitle';
import * as storeAccess from '../../store/storeAccess';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function renderChrome(
  sessionId: string | null,
  extra?: { leading?: React.ReactNode }
) {
  let utils!: ReturnType<typeof render>;
  act(() => {
    utils = render(
      <UnitChromeActions
        activeSessionId={sessionId}
        leading={extra?.leading}
      />
    );
  });
  return utils;
}

function stubCoreTools(): void {
  vi.spyOn(viewRegistry, 'getView').mockImplementation((id: string) => {
    if (id === 'note') return undefined as never;
    return {
      id,
      title: id,
      category: 'tool',
      component: () => null,
    } as never;
  });
}

function seedSession(
  id: string,
  extra?: Partial<SessionState> & { messageCount?: number }
): void {
  const messageCount = extra?.messageCount ?? 0;
  const messages =
    messageCount > 0
      ? Array.from({ length: messageCount }, (_, i) => ({
          id: `m${i}`,
          sender: 'user',
          timestamp: 1,
          text: 'hi',
        }))
      : [];
  const session = {
    id,
    title: extra?.title ?? id,
    folder: extra?.folder ?? GENERAL_FOLDER,
    isPinned: extra?.isPinned ?? false,
    isArchived: false,
    timestamp: '2026-08-19',
    messages,
    agents: extra?.agents ?? [],
  } as unknown as SessionState;
  act(() => {
    useSessionStore.setState({
      sessions: [session],
      sessionsById: { [id]: session },
      activeSessionId: id,
    });
    useLayoutStore.setState((st) => {
      st.sessionsById = { [id]: session };
      st.activeSessionId = id;
    });
  });
}

describe('UnitChromeActions 分屏折叠作用域单源化 (Task 2)', () => {
  beforeEach(() => {
    useLayoutStore.setState((st) => {
      st.sessionsById = {
        'unit-a': {
          id: 'unit-a',
          title: '会话 A',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [],
          agents: [],
        } as unknown as SessionState,
        'unit-b': {
          id: 'unit-b',
          title: '会话 B',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [],
          agents: [],
        } as unknown as SessionState,
      };
      st.activeSessionId = 'unit-b';
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-a',
          kind: 'conversation',
          sessionId: 'unit-a',
          workspaceKey: GENERAL_FOLDER,
          title: '会话 A',
          rightDock: createDefaultDock({
            collapsed: false,
            openPanelIds: ['files'],
            activePanelId: 'files',
          }),
        },
        {
          tabId: 'tab-b',
          kind: 'conversation',
          sessionId: 'unit-b',
          workspaceKey: GENERAL_FOLDER,
          title: '会话 B',
          rightDock: createDefaultDock({
            collapsed: true,
            openPanelIds: ['overview'],
            activePanelId: null,
          }),
        },
      ],
      activeTabId: 'tab-b',
    });

    useLayoutTreeStore.setState({
      toolColumnCollapsed: false,
    });
  });

  it('当多 Unit 分屏时，Unit B 折叠右坞后其展开按钮必须可见（不受 Unit A 展开导致的全局 false 影响）', () => {
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-b" />
    );

    const expandBtn = getByTestId('right-dock-toggle');
    expect(expandBtn).toBeDefined();
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('坞展开时右钮仍在 DOM，不卸载开关', () => {
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-a" />
    );
    const toggle = getByTestId('right-dock-toggle');
    expect(toggle).toBeDefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('data-active')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('收起右侧工具栏');
  });
});

describe('UnitChromeActions 对话顶快捷行（三级面包屑 + 极简动作组）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
      activeSessionId: '',
    });
  });

  it('空会话：无 quiet；极简 4 元动作组固定在顶栏；彻底移除 5 个粗糙产品工具', () => {
    stubCoreTools();
    seedSession('unit-empty', { messageCount: 0, title: EMPTY_SESSION_TITLE });
    const { getByTestId, queryByTestId, container } =
      renderChrome('unit-empty');
    const root = container.querySelector('[data-unit-chrome-actions="true"]');
    expect(root?.getAttribute('data-chat-top-header')).toBe('true');
    expect(root?.hasAttribute('data-canvas-quiet')).toBe(false);

    // 4 大标准动作组在顶栏
    expect(getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(getByTestId('top-quick-artifacts-btn')).toBeTruthy();
    expect(getByTestId('chat-header-more')).toBeTruthy();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();

    // 5 个粗糙产品工具及左侧栏开关已彻底从顶栏退役
    expect(queryByTestId('chat-open-overview')).toBeNull();
    expect(queryByTestId('chat-open-files')).toBeNull();
    expect(queryByTestId('chat-open-diff')).toBeNull();
    expect(queryByTestId('chat-open-terminal')).toBeNull();
    expect(queryByTestId('chat-open-note')).toBeNull();
    expect(queryByTestId('sidebar-toggle-btn')).toBeNull();

    expect(getByTestId('top-quick-preview-btn').getAttribute('aria-label')).toBe(
      '打开应用预览'
    );
    expect(getByTestId('top-quick-artifacts-btn').getAttribute('aria-label')).toBe(
      '打开代码产物与文件'
    );

    expect(container.textContent).toContain(EMPTY_SESSION_TITLE);
    expect(container.textContent).not.toContain('未命名会话');
  });

  it('no-session / 草稿：极简动作组入口仍在，标题是新会话', () => {
    stubCoreTools();
    const none = renderChrome(null);
    const noneRoot = none.container.querySelector(
      '[data-unit-chrome-actions="true"]'
    );
    expect(noneRoot?.hasAttribute('data-canvas-quiet')).toBe(false);
    expect(none.getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(none.getByTestId('top-quick-artifacts-btn')).toBeTruthy();
    expect(none.getByTestId('right-dock-toggle')).toBeTruthy();
    expect(none.container.textContent).toContain(EMPTY_SESSION_TITLE);
    none.unmount();

    const draft = renderChrome(PENDING_DRAFT_SESSION_ID);
    expect(draft.getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(draft.getByTestId('top-quick-artifacts-btn')).toBeTruthy();
    expect(draft.getByTestId('right-dock-toggle')).toBeTruthy();
    expect(draft.container.textContent).toContain(EMPTY_SESSION_TITLE);
  });

  it('有消息后仍是覆盖层，极简动作组仍在对话顶', () => {
    stubCoreTools();
    seedSession('unit-live', { messageCount: 2, title: '重构 IPC' });
    const { getByTestId, container } = renderChrome('unit-live');
    expect(
      container
        .querySelector('[data-unit-chrome-actions="true"]')
        ?.hasAttribute('data-canvas-quiet')
    ).toBe(false);
    expect(getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(getByTestId('top-quick-artifacts-btn')).toBeTruthy();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();
    expect(container.textContent).toContain('重构 IPC');
  });

  it('leading 插槽渲染在对话顶', () => {
    stubCoreTools();
    seedSession('unit-lead', { messageCount: 1 });
    const { getByTestId } = renderChrome('unit-lead', {
      leading: <span data-testid="chrome-leading">搜</span>,
    });
    expect(getByTestId('chrome-leading')).toBeTruthy();
    expect(getByTestId('top-quick-artifacts-btn')).toBeTruthy();
  });

  it('点击应用预览按钮走 openToolInSession(sid, preview)', () => {
    stubCoreTools();
    const spy = vi
      .spyOn(storeAccess, 'openToolInSession')
      .mockImplementation(() => {});
    seedSession('unit-open', { messageCount: 1 });
    const { getByTestId } = renderChrome('unit-open');
    act(() => {
      getByTestId('top-quick-preview-btn').click();
    });
    expect(spy).toHaveBeenCalledWith('unit-open', 'preview');
  });

  it('点击代码产物与文件走 openToolInSession(sid, files)', () => {
    stubCoreTools();
    const spy = vi
      .spyOn(storeAccess, 'openToolInSession')
      .mockImplementation(() => {});
    seedSession('unit-open', { messageCount: 1 });
    const { getByTestId } = renderChrome('unit-open');
    act(() => {
      getByTestId('top-quick-artifacts-btn').click();
    });
    expect(spy).toHaveBeenCalledWith('unit-open', 'files');
  });

  it('子 Agent running 才出第三段面包屑', () => {
    stubCoreTools();
    seedSession('unit-agents', {
      messageCount: 1,
      title: '有子代理',
      agents: [
        { status: 'running' },
        { status: 'running' },
        { status: 'completed' },
      ] as never,
    });
    const { container } = renderChrome('unit-agents');
    expect(container.textContent).toContain('2 个运行中');
  });

  it('Tip 走 bottom；覆盖层无 quiet / 无果冻；样式符合 38px 与 6px 圆角规范', () => {
    expect(UNIT_CHROME_TOOL_TIP_SIDE).toBe('bottom');
    const src = readFileSync(join(DIR, 'UnitChromeActions.tsx'), 'utf8');
    const css = readFileSync(join(DIR, 'UnitChromeActions.module.css'), 'utf8');
    expect(src).not.toMatch(/data-canvas-quiet/);
    expect(src).not.toMatch(/isUnitChromeCanvasQuiet/);
    expect(src).not.toMatch(/UNIT_TOOL_PANELS/);
    expect(src).toMatch(/openToolInSession/);
    expect(src).toMatch(/top-quick-preview-btn/);
    expect(src).toMatch(/top-quick-artifacts-btn/);
    expect(src).toMatch(/onMoveToFolder/);
    expect(src).toMatch(/onTogglePin/);
    expect(src).toMatch(/onExportMarkdown/);
    expect(src).toMatch(/onClearHistory/);
    expect(src).not.toMatch(/if\s*\(\s*rightDockCollapsed\s*&&/);
    expect(src).not.toMatch(/from\s+['"]\.\/ChatHeader['"]/);
    expect(src).not.toMatch(/sidebar-toggle-btn/);
    expect(src).toMatch(/data-testid="right-dock-toggle"/);
    expect(src).toMatch(/data-chat-top-header/);
    expect(src).toMatch(/\{leading\}/);
    expect(css).not.toMatch(/data-canvas-quiet/);
    expect(css).not.toMatch(/opacity:\s*0\.28/);
    expect(css).not.toMatch(/transform:\s*scale/);
    expect(css).toMatch(/height:\s*38px/);
    expect(css).toMatch(/margin-bottom:\s*-38px/);
    expect(css).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/border-radius:\s*6px/);
    expect(css).not.toMatch(/\.chatTopHeader\s*\{[^}]*display:\s*none/);
  });
});

describe('UnitChromeActions 重构与交互验证 (00-总方案 §4.1 & 02-pixel-perfect §2)', () => {
  beforeEach(() => {
    stubCoreTools();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('点击项目名称应调用 enterDraftMode 进入新建草稿态', () => {
    const draftSpy = vi.spyOn(storeAccess, 'enterDraftMode').mockImplementation(() => {});
    seedSession('sess-proj', { folder: 'my-proj' });
    const { getByText } = renderChrome('sess-proj');
    act(() => {
      fireEvent.click(getByText(/my-proj|默认/));
    });
    expect(draftSpy).toHaveBeenCalledWith('my-proj');
  });

  it('点击标题进入编辑态，按 Enter 成功触发 renameSession', () => {
    const renameSpy = vi.spyOn(storeAccess, 'renameSession').mockImplementation(() => {});
    seedSession('sess-rename', { title: '旧标题' });
    const { getByText, container } = renderChrome('sess-rename');
    act(() => {
      fireEvent.click(getByText('旧标题'));
    });
    const input = container.querySelector('input');
    expect(input).toBeTruthy();
    act(() => {
      fireEvent.change(input!, { target: { value: '新标题' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    expect(renameSpy).toHaveBeenCalledWith('sess-rename', '新标题');
  });

  it('子代理存在时展示状态胶囊，包含数量与状态徽章', () => {
    seedSession('sess-agent', {
      agents: [
        { id: 'ag-1', name: '调研专家', status: 'running' },
        { id: 'ag-2', name: '测试专家', status: 'completed' },
      ] as never,
    });
    const { getByText } = renderChrome('sess-agent');
    expect(getByText('1 个运行中')).toBeTruthy();
  });

  it('左侧包含三级面包屑，右侧包含四元极简动作组（preview, artifacts, more, rightDockToggle）', () => {
    seedSession('sess-tools');
    const { getByTestId, queryByTestId } = renderChrome('sess-tools');
    expect(getByTestId('top-quick-preview-btn')).toBeTruthy();
    expect(getByTestId('top-quick-artifacts-btn')).toBeTruthy();
    expect(getByTestId('chat-header-more')).toBeTruthy();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();
    expect(queryByTestId('sidebar-toggle-btn')).toBeNull();
    expect(queryByTestId('chat-open-overview')).toBeNull();
    expect(queryByTestId('chat-open-files')).toBeNull();
  });
});
