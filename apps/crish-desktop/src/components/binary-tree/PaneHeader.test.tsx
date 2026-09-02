// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LayoutLeaf } from '../../store/types';
import { useSessionStore } from '../../store/storeAccess';

const shellMocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  addTab: vi.fn(),
  removeTab: vi.fn(),
}));

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({ shell: shellMocks }),
}));

vi.mock('../shell/SessionTabDragContext', () => ({
  useSessionTabDrag: () => ({
    startSessionDrag: vi.fn(),
  }),
}));

import { PaneHeader } from './PaneHeader';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function makeTab(
  tabId: string,
  sessionId: string,
  title: string
) {
  return {
    tabId,
    sessionId,
    title,
    workspaceKey: '对话',
    dock: {
      collapsed: true,
      openPanelIds: [] as string[],
      activePanelId: null as string | null,
      widthRatio: 0.5,
    },
  };
}

function makeLeaf(
  id: string,
  tabs: ReturnType<typeof makeTab>[],
  activeTabId: string
): LayoutLeaf {
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs,
    activeTab: 'chat',
    activeTabId,
  } as unknown as LayoutLeaf;
}

describe('PaneHeader 叶子拥有会话标签', () => {
  beforeEach(() => {
    shellMocks.activateTab.mockReset();
    shellMocks.addTab.mockReset();
    shellMocks.removeTab.mockReset();
    useSessionStore.setState({
      sessionsById: {
        s1: { id: 's1', title: '会话一' },
        s2: { id: 's2', title: '会话二' },
        s3: { id: 's3', title: '会话三' },
      },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('两叶各自 aria-selected 只跟本叶 activeTabId', () => {
    const leafA = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta3', 's3', '会话三')],
      'ta1'
    );
    const leafB = makeLeaf('leaf-b', [makeTab('tb2', 's2', '会话二')], 'tb2');

    const { container } = render(
      <div>
        <PaneHeader leaf={leafA} isActive isChat />
        <PaneHeader leaf={leafB} isActive={false} isChat />
      </div>
    );

    const aTabs = container.querySelectorAll(
      '[data-leaf-id], [data-pane-header="true"]'
    );
    const headers = container.querySelectorAll('[data-pane-header="true"]');
    expect(headers).toHaveLength(2);

    const aSelected = headers[0]!.querySelectorAll('[aria-selected="true"]');
    const bSelected = headers[1]!.querySelectorAll('[aria-selected="true"]');
    expect(aSelected).toHaveLength(1);
    expect(aSelected[0]!.getAttribute('data-tab-id')).toBe('ta1');
    expect(bSelected).toHaveLength(1);
    expect(bSelected[0]!.getAttribute('data-tab-id')).toBe('tb2');
    void aTabs;
  });

  it('点 tab 只调 activateTab(leafId, tabId)', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta3', 's3', '会话三')],
      'ta1'
    );
    const { getByText } = render(<PaneHeader leaf={leaf} isActive isChat />);
    fireEvent.click(getByText('会话三'));
    expect(shellMocks.activateTab).toHaveBeenCalledTimes(1);
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta3');
    expect(shellMocks.addTab).not.toHaveBeenCalled();
    expect(shellMocks.removeTab).not.toHaveBeenCalled();
  });

  it('加号只调 addTab(leafId)', () => {
    const leaf = makeLeaf('leaf-b', [makeTab('tb2', 's2', '会话二')], 'tb2');
    const { getAllByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    fireEvent.click(getAllByLabelText('新对话')[0]!);
    expect(shellMocks.addTab).toHaveBeenCalledTimes(1);
    expect(shellMocks.addTab).toHaveBeenCalledWith('leaf-b');
    expect(shellMocks.activateTab).not.toHaveBeenCalled();
  });

  it('关 active tab：先 activate 左邻，220ms 后再 removeTab', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta3', 's3', '会话三'),
        makeTab('ta4', 's4', '会话四'),
      ],
      'ta3'
    );
    const { getByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    fireEvent.click(getByLabelText('关闭 会话三'));
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta1');
    expect(shellMocks.removeTab).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(219);
    });
    expect(shellMocks.removeTab).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta3');
  });

  it('源码点击路径不含死轨符号', () => {
    const src = readFileSync(join(DIR, './PaneHeader.tsx'), 'utf8');
    expect(src).not.toMatch(/setLeafSessionId/);
    expect(src).not.toMatch(/bindActiveChatLeafSession/);
    expect(src).not.toMatch(/tabsForUnit/);
    expect(src).not.toMatch(/openNewDraftTab/);
    expect(src).not.toMatch(/applyDockToTree/);
    expect(src).toMatch(/visibleTabs/);
    expect(src).toMatch(/leaf\.tabs/);
  });

  it('窗口拖拽只在标签按钮以外：标签项退出 drag-region', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一')],
      'ta1'
    );
    const { container, getByRole } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    const header = container.querySelector('[data-pane-header="true"]');
    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);
    const tab = getByRole('tab');
    expect(tab.getAttribute('data-tauri-drag-region')).toBe('false');
    const list = header?.querySelector('[role="tablist"] > div');
    expect(list?.hasAttribute('data-tauri-drag-region')).toBe(false);
  });
});
