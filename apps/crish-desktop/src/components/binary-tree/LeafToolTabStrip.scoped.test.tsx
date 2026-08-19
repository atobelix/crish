// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import * as workspaceShellModule from '../../store/workspace-shell';
import { createLeaf } from '../../store/layout-tree/types';
import { useLayoutStore } from '../../store/layoutStore';
import { viewRegistry } from '../../services/view-registry';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper';

describe('LeafToolTabStrip 会话作用域绑定 (Task 4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLayoutStore.getState().setTabModeEnabled(true);
  });

  it('点击工具叶子收起按钮时，必须显式调用 openToolInSession 绑定当前 leaf.sessionId', () => {
    const openToolSpy = vi
      .spyOn(workspaceShellModule, 'openToolInSession')
      .mockImplementation(() => {});

    const leaf = createLeaf(
      'tool-leaf-1',
      ['overview', 'files'],
      'overview',
      'sess-b'
    );

    const { getByLabelText, container } = render(
      <LeafToolTabStrip leaf={leaf} />
    );

    const collapseBtn = getByLabelText('收起右侧面板');
    expect(collapseBtn).toBeDefined();
    const strip = container.querySelector('[data-leaf-tool-tab-strip="true"]');
    expect(strip?.getAttribute('data-tab-mode')).toBe('on');

    fireEvent.click(collapseBtn);

    expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'chat');
  });
});

describe('LeafToolTabStrip 坞头工具导航', () => {
  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
    vi.restoreAllMocks();
  });

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

  it('坞头有打开文件等图标钮，点击走 openToolInSession', () => {
    stubCoreTools();
    const openToolSpy = vi
      .spyOn(workspaceShellModule, 'openToolInSession')
      .mockImplementation(() => {});
    const leaf = createLeaf('tool-leaf-1', ['overview'], 'overview', 'sess-b');
    const { getByTestId, queryByTestId } = render(
      <LeafToolTabStrip leaf={leaf} />
    );
    expect(getByTestId('chat-open-files').getAttribute('aria-label')).toBe(
      '打开文件'
    );
    expect(getByTestId('chat-open-files').textContent?.replace(/\s+/g, '')).toBe(
      ''
    );
    expect(queryByTestId('chat-open-note')).toBeNull();
    fireEvent.click(getByTestId('chat-open-files'));
    expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'files');
  });

  it('activate 笔记后坞头出现 chat-open-note', async () => {
    const leaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    activateNotePaper();
    const { getByTestId } = render(<LeafToolTabStrip leaf={leaf} />);
    await waitFor(() => {
      expect(getByTestId('chat-open-note')).toBeTruthy();
    });
    const spy = vi
      .spyOn(workspaceShellModule, 'openToolInSession')
      .mockImplementation(() => {});
    act(() => {
      getByTestId('chat-open-note').click();
    });
    expect(spy).toHaveBeenCalledWith('sess-b', 'note');
  });
});
