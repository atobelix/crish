// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render } from '@testing-library/react';
import { UnitChromeActions } from './UnitChromeActions';
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

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function renderChrome(sessionId: string | null) {
  let utils!: ReturnType<typeof render>;
  act(() => {
    utils = render(<UnitChromeActions activeSessionId={sessionId} />);
  });
  return utils;
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

describe('UnitChromeActions 对话顶快捷行（覆盖层，非 quiet 工具簇）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
      activeSessionId: '',
    });
  });

  it('空会话：无 quiet、无打开文件；更多 / 分享 / 坞开关固定在', () => {
    seedSession('unit-empty', { messageCount: 0, title: EMPTY_SESSION_TITLE });
    const { getByTestId, queryByTestId, container } =
      renderChrome('unit-empty');
    const root = container.querySelector('[data-unit-chrome-actions="true"]');
    expect(root?.getAttribute('data-chat-top-header')).toBe('true');
    expect(root?.hasAttribute('data-canvas-quiet')).toBe(false);
    expect(queryByTestId('chat-open-files')).toBeNull();
    expect(queryByTestId('chat-open-overview')).toBeNull();
    expect(queryByTestId('chat-open-note')).toBeNull();
    expect(getByTestId('chat-header-more')).toBeTruthy();
    expect(getByTestId('chat-share')).toBeTruthy();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();
    expect(container.textContent).toContain(EMPTY_SESSION_TITLE);
    expect(container.textContent).not.toContain('未命名会话');
    expect(container.textContent).not.toContain('打开文件');
  });

  it('no-session / 草稿：右钮仍在，标题是新会话', () => {
    const none = renderChrome(null);
    const noneRoot = none.container.querySelector(
      '[data-unit-chrome-actions="true"]'
    );
    expect(noneRoot?.hasAttribute('data-canvas-quiet')).toBe(false);
    expect(none.queryByTestId('chat-open-files')).toBeNull();
    expect(none.getByTestId('right-dock-toggle')).toBeTruthy();
    expect(none.getByTestId('chat-share')).toBeTruthy();
    expect(none.container.textContent).toContain(EMPTY_SESSION_TITLE);
    none.unmount();

    const draft = renderChrome(PENDING_DRAFT_SESSION_ID);
    expect(draft.queryByTestId('chat-open-files')).toBeNull();
    expect(draft.getByTestId('right-dock-toggle')).toBeTruthy();
    expect(draft.container.textContent).toContain(EMPTY_SESSION_TITLE);
  });

  it('有消息后仍是覆盖层，工具钮不回到对话顶', () => {
    seedSession('unit-live', { messageCount: 2, title: '重构 IPC' });
    const { queryByTestId, getByTestId, container } = renderChrome('unit-live');
    expect(
      container
        .querySelector('[data-unit-chrome-actions="true"]')
        ?.hasAttribute('data-canvas-quiet')
    ).toBe(false);
    expect(queryByTestId('chat-open-files')).toBeNull();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();
    expect(container.textContent).toContain('重构 IPC');
  });

  it('子 Agent running 才出第三段面包屑', () => {
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

  it('Tip 走 bottom；源码无 quiet / 无工具广告行', () => {
    expect(UNIT_CHROME_TOOL_TIP_SIDE).toBe('bottom');
    const src = readFileSync(join(DIR, 'UnitChromeActions.tsx'), 'utf8');
    const css = readFileSync(join(DIR, 'UnitChromeActions.module.css'), 'utf8');
    expect(src).not.toMatch(/data-canvas-quiet/);
    expect(src).not.toMatch(/isUnitChromeCanvasQuiet/);
    expect(src).not.toMatch(/UNIT_TOOL_PANELS/);
    expect(src).not.toMatch(/chat-open-files/);
    expect(src).not.toMatch(/if\s*\(\s*rightDockCollapsed\s*&&/);
    expect(src).not.toMatch(/from\s+['"]\.\/ChatHeader['"]/);
    expect(src).toMatch(/data-testid="right-dock-toggle"/);
    expect(src).toMatch(/data-testid="chat-share"/);
    expect(src).toMatch(/data-chat-top-header/);
    expect(css).not.toMatch(/data-canvas-quiet/);
    expect(css).not.toMatch(/opacity:\s*0\.28/);
    expect(css).not.toMatch(/transform:\s*scale/);
    expect(css).toMatch(/height:\s*38px/);
    expect(css).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/--button-radius,\s*7px/);
    expect(css).not.toMatch(/\.chatTopHeader\s*\{[^}]*display:\s*none/);
  });
});
