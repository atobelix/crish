// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, waitFor } from '@testing-library/react';
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
import * as storeAccess from '../../store/storeAccess';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper';

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

    // 全局 LayoutTreeStore.toolColumnCollapsed 设为 false (因为 unit-a 展开了)
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
  });
});

describe('UnitChromeActions 笔记闸（02 F6 / F7）', () => {
  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
    vi.restoreAllMocks();
  });

  it('未 activate 不渲染 chat-open-note；activate 后出现，deactivate 后消失', async () => {
    deactivateNotePaper();
    const { queryByTestId, getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-a" />
    );
    expect(queryByTestId('chat-open-note')).toBeNull();

    act(() => {
      activateNotePaper();
    });
    await waitFor(() => {
      expect(getByTestId('chat-open-note')).toBeTruthy();
    });

    act(() => {
      deactivateNotePaper();
    });
    await waitFor(() => {
      expect(queryByTestId('chat-open-note')).toBeNull();
    });
  });

  it('F7 点击 chat-open-note 只走 openToolInSession(sid, note)', async () => {
    act(() => {
      activateNotePaper();
    });
    const spy = vi
      .spyOn(storeAccess, 'openToolInSession')
      .mockImplementation(() => {});
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-a" />
    );
    await waitFor(() => {
      expect(getByTestId('chat-open-note')).toBeTruthy();
    });
    act(() => {
      getByTestId('chat-open-note').click();
    });
    expect(spy).toHaveBeenCalledWith('unit-a', 'note');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('UnitChromeActions icon-only + tip 不落画布', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubToolViews(): void {
    vi.spyOn(viewRegistry, 'getView').mockReturnValue({
      id: 'files',
      title: '文件',
      category: 'tool',
      component: () => null,
    } as never);
  }

  it('文件钮 icon-only：完整 aria-label，可见文本不含「打开文件」', () => {
    stubToolViews();
    const { getByTestId } = render(
      <UnitChromeActions activeSessionId="unit-b" />
    );
    const filesBtn = getByTestId('chat-open-files');
    expect(filesBtn.getAttribute('aria-label')).toBe('打开文件');
    expect(filesBtn.textContent?.replace(/\s+/g, '')).toBe('');
    expect(UNIT_CHROME_TOOL_TIP_SIDE).toBe('left');
  });

  it('源码：Tip 走横向短词，不把 label 画成实体按钮', () => {
    const dir =
      typeof import.meta.dirname === 'string'
        ? import.meta.dirname
        : dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, 'UnitChromeActions.tsx'), 'utf8');
    expect(src).toMatch(/side=\{UNIT_CHROME_TOOL_TIP_SIDE\}/);
    expect(src).toMatch(/content=\{resolveUnitChromeToolTip\(label\)\}/);
    expect(src).not.toMatch(/<Tooltip key=\{id\} content=\{label\}>/);
    expect(src).toMatch(/icon=\{\s*<Icon /);
    expect(src).not.toMatch(/icon=\{\s*<Icon[\s\S]*?\}\s*>\s*\{label\}/);
  });
});

describe('UnitChromeActions 空画布静默不抢主区', () => {
  beforeEach(() => {
    useLayoutTreeStore.setState({ toolColumnCollapsed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
      activeSessionId: '',
    });
  });

  function stubToolViews(): void {
    vi.spyOn(viewRegistry, 'getView').mockReturnValue({
      id: 'files',
      title: '文件',
      category: 'tool',
      component: () => null,
    } as never);
  }

  function seedSession(id: string, messageCount: number): void {
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
      title: id,
      folder: GENERAL_FOLDER,
      isPinned: false,
      isArchived: false,
      timestamp: '2026-08-19',
      messages,
    } as unknown as SessionState;
    act(() => {
      useSessionStore.setState({
        sessions: [session],
        sessionsById: { [id]: session },
        activeSessionId: id,
      });
    });
  }

  it('session-empty：静默但仍挂工具钮，不整栏消失，可见文本不含「打开文件」', () => {
    stubToolViews();
    seedSession('unit-empty', 0);
    const { getByTestId, container } = render(
      <UnitChromeActions activeSessionId="unit-empty" />
    );
    const root = container.querySelector('[data-unit-chrome-actions="true"]');
    expect(root?.getAttribute('data-canvas-quiet')).toBe('true');
    expect(getByTestId('chat-open-files')).toBeTruthy();
    expect(getByTestId('chat-open-overview')).toBeTruthy();
    expect(getByTestId('right-dock-toggle')).toBeTruthy();
    expect(getByTestId('chat-open-files').getAttribute('aria-label')).toBe(
      '打开文件'
    );
    expect(container.textContent?.replace(/\s+/g, '')).not.toContain('打开文件');
  });

  it('no-session / 草稿：静默且入口仍在', () => {
    stubToolViews();
    const none = render(<UnitChromeActions activeSessionId={null} />);
    expect(
      none.container
        .querySelector('[data-unit-chrome-actions="true"]')
        ?.getAttribute('data-canvas-quiet')
    ).toBe('true');
    expect(none.getByTestId('chat-open-files')).toBeTruthy();
    none.unmount();

    const draft = render(
      <UnitChromeActions activeSessionId={PENDING_DRAFT_SESSION_ID} />
    );
    expect(
      draft.container
        .querySelector('[data-unit-chrome-actions="true"]')
        ?.getAttribute('data-canvas-quiet')
    ).toBe('true');
    expect(draft.getByTestId('chat-open-files')).toBeTruthy();
  });

  it('有消息后不再静默，工具钮仍在', async () => {
    stubToolViews();
    seedSession('unit-live', 2);
    const { getByTestId, container } = await act(async () =>
      render(<UnitChromeActions activeSessionId="unit-live" />)
    );
    expect(
      container
        .querySelector('[data-unit-chrome-actions="true"]')
        ?.getAttribute('data-canvas-quiet')
    ).toBe('false');
    expect(getByTestId('chat-open-files')).toBeTruthy();
  });

  it('源码/CSS：空态贴右叠层，不 display:none 整栏，不复活 ChatHeader', () => {
    const dir =
      typeof import.meta.dirname === 'string'
        ? import.meta.dirname
        : dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, 'UnitChromeActions.tsx'), 'utf8');
    const css = readFileSync(join(dir, 'UnitChromeActions.module.css'), 'utf8');
    expect(src).toMatch(/data-canvas-quiet=\{canvasQuiet \? 'true' : 'false'\}/);
    expect(src).not.toMatch(/if\s*\(\s*canvasQuiet\s*\)\s*return\s*null/);
    expect(src).not.toMatch(/from\s+['"]\.\/ChatHeader['"]/);
    expect(css).toMatch(/justify-content:\s*flex-end/);
    expect(css).toMatch(/\[data-canvas-quiet=['"]true['"]\]/);
    expect(css).not.toMatch(/\.toolbarActions\s*\{[^}]*display:\s*none/);
  });
});
