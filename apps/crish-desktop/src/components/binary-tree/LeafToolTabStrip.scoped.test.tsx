// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import * as workspaceShellModule from '../../store/workspace-shell';
import { createLeaf } from '../../store/layout-tree/types';

describe('LeafToolTabStrip 会话作用域绑定 (Task 4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

    const { getByLabelText } = render(<LeafToolTabStrip leaf={leaf} />);

    const collapseBtn = getByLabelText('收起右侧面板');
    expect(collapseBtn).toBeDefined();

    fireEvent.click(collapseBtn);

    expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'chat');
  });
});
