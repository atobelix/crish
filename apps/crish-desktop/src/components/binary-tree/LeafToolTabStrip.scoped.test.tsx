// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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
});
