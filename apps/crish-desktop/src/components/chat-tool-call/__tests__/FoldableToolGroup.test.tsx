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
        tc: tc('t1', 'run_command', 'success', {
          arguments: '{"command":"echo 1"}',
        }),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success', {
          arguments: '{"command":"echo 2"}',
        }),
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
      {
        kind: 'single',
        tc: tc('t2', 'grep_search', 'success'),
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
    // 折叠时保留 160ms CSS Grid 过渡缓冲，过渡结束后 (transitionend) 打上 hidden="until-found"
    fireEvent.transitionEnd(body!, { propertyName: 'grid-template-rows' });
    expect(body?.getAttribute('hidden')).toBe('until-found');
    expect(body?.getAttribute('data-expanded')).toBe('false');
  });

  it('键盘 Enter / Space 可触发展开折叠切换', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'view_file', 'success'),
      },
      {
        kind: 'single',
        tc: tc('t2', 'view_file', 'success'),
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

  it('流式运行中存在 running 工具时自动展开，全部完成后自动收敛折叠（手动切换除外）', () => {
    const runningItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success'),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'running'),
      },
    ];
    const completedItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success'),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'success'),
      },
    ];

    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={runningItems}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items: runningItems }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('true');

    // 工具执行完成 → 自动收敛折叠为单行摘要
    rerender(
      <FoldableToolGroup
        items={completedItems}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items: completedItems }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('存在执行错误时展示错误标记', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'run_command', 'success'),
      },
      {
        kind: 'single',
        tc: tc('t2', 'run_command', 'error'),
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
    expect(
      errorBadge.querySelector('[data-icon="alert-triangle"]')
    ).toBeTruthy();
  });

  it('单工具不做组级折叠：直出工具行，意图说明与命令可见，详情仍默认折叠', () => {
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: tc('t1', 'bash', 'success', {
          arguments: '{"command":"pwd"}',
          explanation: '查看当前目录',
          output: '/workspace/crish',
        }),
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
    expect(root.getAttribute('data-single-tool')).toBe('true');
    // 无组级摘要栏、无 hidden 槽位
    expect(root.querySelector('[class*="groupHeader"]')).toBeNull();
    expect(root.querySelector('[hidden]')).toBeNull();
    const row = root.querySelector(
      '.tool-row[data-tool-id="t1"]'
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute('data-expanded')).toBe('false');
    const head = row.querySelector('.tool-row-head') as HTMLElement;
    expect(head.textContent).toContain('查看当前目录');
    expect(head.textContent).toContain('Bash');
    expect(head.textContent).toContain('pwd');
  });

  it('单工具 → 多工具（流式追加）后切换为组级折叠，完成后自动收敛', () => {
    const one: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'running') },
    ];
    const two: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success') },
      { kind: 'single', tc: tc('t2', 'run_command', 'running') },
    ];
    const twoDone: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success') },
      { kind: 'single', tc: tc('t2', 'run_command', 'success') },
    ];
    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={one}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items: one }}
      />
    );
    expect(
      getByTestId('foldable-tool-group').getAttribute('data-single-tool')
    ).toBe('true');

    rerender(
      <FoldableToolGroup
        items={two}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items: two }}
      />
    );
    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-single-tool')).toBeNull();
    expect(root.getAttribute('data-expanded')).toBe('true');

    rerender(
      <FoldableToolGroup
        items={twoDone}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items: twoDone }}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('收起长内容时若滚出屏幕顶部，触发视口平滑回退保护', () => {
    const items: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success') },
      { kind: 'single', tc: tc('t2', 'run_command', 'success') },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
        defaultExpanded={true}
      />
    );

    const root = getByTestId('foldable-tool-group');
    const scrollIntoViewMock = vi.fn();
    root.scrollIntoView = scrollIntoViewMock;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: -200,
      bottom: 600,
      left: 0,
      right: 500,
      width: 500,
      height: 800,
      x: 0,
      y: -200,
      toJSON: () => {},
    });

    const header = root.querySelector('[class*="groupHeader"]') as HTMLElement;
    fireEvent.click(header);

    expect(root.getAttribute('data-expanded')).toBe('false');
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'smooth',
    });
  });

  it('聚焦槽位内部子项时通过 onFocusCapture 主动唤醒展开', () => {
    const items: ToolRenderItem[] = [
      { kind: 'single', tc: tc('t1', 'run_command', 'success') },
      { kind: 'single', tc: tc('t2', 'run_command', 'success') },
    ];

    const { getByTestId } = render(
      <FoldableToolGroup
        items={items}
        msgId="m1"
        hostProps={{ ...baseHostProps(), items }}
      />
    );

    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('false');

    const innerChild = root.querySelector(
      '[class*="groupBodyInner"]'
    ) as HTMLElement;
    fireEvent.focus(innerChild);

    expect(root.getAttribute('data-expanded')).toBe('true');
  });
});
