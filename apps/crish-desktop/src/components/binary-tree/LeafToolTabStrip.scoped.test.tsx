// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import { createLeaf } from '../../store/layout-tree/types';
import { useLayoutStore } from '../../store/layoutStore';
import { viewRegistry } from '../../services/view-registry';
import * as storeAccess from '../../store/storeAccess';

describe('LeafToolTabStrip 纯标签化与防溢出吸附验证', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLayoutStore.getState().setTabModeEnabled(true);
    vi.spyOn(viewRegistry, 'getTitle').mockImplementation((id: string) => id);
    vi.spyOn(viewRegistry, 'getIcon').mockImplementation(
      () => () => <span data-testid="tool-icon" />
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('不再渲染 dockToolNav 固定工具条', () => {
    const leaf = createLeaf(
      'tool-leaf-1',
      ['files', 'diff'],
      'files',
      'sess-b'
    );
    const { queryByRole } = render(<LeafToolTabStrip leaf={leaf} />);
    expect(queryByRole('toolbar', { name: '会话工具' })).toBeNull();
  });

  it('每个 Tab 渲染对应的工具 Icon 与微型关闭按钮（多 Tab 时）', () => {
    const leaf = createLeaf(
      'tool-leaf-1',
      ['files', 'diff'],
      'files',
      'sess-b'
    );
    const { getByText, getAllByTestId, getAllByLabelText } = render(
      <LeafToolTabStrip leaf={leaf} />
    );
    expect(getByText('files')).toBeTruthy();
    expect(getAllByTestId('tool-icon')).toHaveLength(2);
    expect(getAllByLabelText(/关闭/)).toHaveLength(2);
  });

  it('单 Tab 时不显示关闭叉号', () => {
    const leaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    const { queryByLabelText } = render(<LeafToolTabStrip leaf={leaf} />);
    expect(queryByLabelText(/关闭/)).toBeNull();
  });

  it('点击收起按钮显式触发 openToolInSession(sessionId, "chat")', () => {
    const openToolSpy = vi
      .spyOn(storeAccess, 'openToolInSession')
      .mockImplementation(() => {});
    const leaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    const { getByLabelText } = render(<LeafToolTabStrip leaf={leaf} />);
    fireEvent.click(getByLabelText('收起右侧面板'));
    expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'chat');
  });

  it('支持最大化/恢复面板按钮切换', () => {
    const onToggleMaximize = vi.fn();
    const leaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    const { getByLabelText } = render(
      <LeafToolTabStrip leaf={leaf} onToggleMaximize={onToggleMaximize} />
    );
    const maxBtn = getByLabelText('最大化面板');
    expect(maxBtn).toBeTruthy();
    fireEvent.click(maxBtn);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('Row 2 导航工具条在预览视图展示，在普通视图或空态不展示', () => {
    const previewLeaf = createLeaf(
      'tool-leaf-1',
      ['preview'],
      'preview',
      'sess-b'
    );
    const { getByTestId, queryByTestId, rerender } = render(
      <LeafToolTabStrip leaf={previewLeaf} />
    );
    expect(getByTestId('side-panel-toolbar')).toBeTruthy();

    const filesLeaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    rerender(<LeafToolTabStrip leaf={filesLeaf} />);
    expect(queryByTestId('side-panel-toolbar')).toBeNull();
  });

  it('空态（0 个 Tab）时渲染 Launcher Hub 居中卡片组，点击触发对应工具打开', () => {
    const openToolSpy = vi
      .spyOn(storeAccess, 'openToolInSession')
      .mockImplementation(() => {});

    const emptyLeaf = {
      type: 'leaf' as const,
      id: 'tool-leaf-1',
      panelId: 'files',
      tabs: [],
      activeTab: '',
      sessionId: 'sess-b',
    };
    const { getByTestId, queryByTestId } = render(
      <LeafToolTabStrip leaf={emptyLeaf} />
    );

    // 空态下 Row 2 隐藏
    expect(queryByTestId('side-panel-toolbar')).toBeNull();

    // 空态 Launcher Hub 展示
    expect(getByTestId('side-panel-launcher-hub')).toBeTruthy();

    // 点击应用预览卡片
    const previewCard = getByTestId('launcher-card-preview');
    expect(previewCard).toBeTruthy();
    fireEvent.click(previewCard);
    expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'preview');

    // 点击代码产物与文件卡片
    const filesCard = getByTestId('launcher-card-files');
    expect(filesCard).toBeTruthy();
    fireEvent.click(filesCard);
    expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'files');
  });

  it('关闭 Tab 时触发 is-leaving 动效类并在 220ms 后调用 onCloseTab', () => {
    vi.useFakeTimers();
    const onCloseTab = vi.fn();
    const leaf = createLeaf(
      'tool-leaf-1',
      ['files', 'diff'],
      'files',
      'sess-b'
    );
    const { getByLabelText, container } = render(
      <LeafToolTabStrip leaf={leaf} onCloseTab={onCloseTab} />
    );

    const closeFilesBtn = getByLabelText('关闭 files');
    fireEvent.click(closeFilesBtn);

    // 应该标记 isLeaving 类
    const tabEl = container.querySelector('[data-tab-id="files"]');
    expect(tabEl?.className).toContain('isLeaving');

    expect(onCloseTab).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onCloseTab).toHaveBeenCalledWith('files');
    vi.useRealTimers();
  });

  it('包含随流加号与固定区加号（双态加号结构）', () => {
    const leaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    const { container } = render(<LeafToolTabStrip leaf={leaf} />);
    const inFlowBtn = container.querySelector('.side-panel-add-btn.in-flow');
    const pinnedBtn = container.querySelector('.side-panel-add-btn.pinned');
    expect(inFlowBtn).toBeTruthy();
    expect(pinnedBtn).toBeTruthy();
  });
});

