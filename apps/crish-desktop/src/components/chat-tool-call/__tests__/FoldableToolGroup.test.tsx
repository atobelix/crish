// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { FoldableToolGroup } from '../FoldableToolGroup';
import type { ToolRenderItem } from '../../../api/toolPresentation';
import type { MessageToolCall } from '../../../store/types';

function tc(
  id: string,
  name: string,
  status: MessageToolCall['status'],
  extra?: Partial<MessageToolCall>
): MessageToolCall {
  return { id, name, status, arguments: '', ...extra };
}

function baseHostProps() {
  return {
    agents: [],
    activeSessionId: 's1',
    expandedTools: {},
    onToggleTool: vi.fn(),
    approvalBusy: false,
    items: [],
  };
}

describe('FoldableToolGroup 独立工具折叠组', () => {
  it('默认折叠：首屏展示摘要文案并保持折叠态', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success', { arguments: '{"command":"echo 1"}' }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success', { arguments: '{"command":"echo 2"}' }),
      },
    ];

    const { getByTestId, queryByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('false');

    const label = root.querySelector('[class*="summaryLabel"]');
    expect(label?.textContent).toContain('已运行 2 条命令');

    // 默认折叠时具有 hidden="until-found" 属性以支持 Ctrl+F 页面穿透
    const body = root.querySelector('[class*="groupBody"]');
    expect(body?.getAttribute('hidden')).toBe('until-found');
    expect(body?.getAttribute('data-expanded')).toBe('false');

    expect(queryByTestId('tool-group-error-badge')).toBeNull();
  });

  it('点击标题行可切换展开与收起，并通知 onInvalidate', () => {
    const onInvalidate = vi.fn();
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'find_by_name', 'success'),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
        onInvalidate={onInvalidate}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;
    expect(header).toBeTruthy();

    // 点击展开
    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('true');
    expect(onInvalidate).toHaveBeenCalledTimes(1);

    const body = root.querySelector('[class*="groupBody"]');
    expect(body?.hasAttribute('hidden')).toBe(false);
    expect(body?.getAttribute('data-expanded')).toBe('true');

    // 再次点击收起
    fireEvent.click(header);
    expect(root.getAttribute('data-expanded')).toBe('false');
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    expect(body?.getAttribute('hidden')).toBe('until-found');
    expect(body?.getAttribute('data-expanded')).toBe('false');
  });

  it('键盘 Enter / Space 可触发展开折叠切换', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'view_file', 'success'),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(root.getAttribute('data-expanded')).toBe('true');

    fireEvent.keyDown(header, { key: ' ' });
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('流式运行中存在 running 工具时，自动展开', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'running'),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('true');
  });

  it('存在执行错误时展示错误标记', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'error'),
      },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const errorBadge = getByTestId('tool-group-error-badge');
    expect(errorBadge).toBeTruthy();
    expect(errorBadge.querySelector('[data-icon="alert-triangle"]')).toBeTruthy();
  });
});
