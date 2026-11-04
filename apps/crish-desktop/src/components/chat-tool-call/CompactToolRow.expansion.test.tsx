// @vitest-environment jsdom
/**
 * E1：CompactToolRow 展开政策渲染冒烟——
 * 政策三态在共享行渲染器上的落地（主聊天与 Agent 侧栏共用同一
 * CompactToolRow，两宿主在此一并验）：
 * - side-diff 行：整行头改道（role=button + data-open-target，
 *   点击/Enter → onOpenDiff 首个解析 diff），无 chevron、无展开体；
 * - 宿主未提供 onOpenDiff → 诚实降级为静态行；
 * - file_stat 行：行头摘要（类型/大小/只读/紧凑 mtime）+ 路径可点，
 *   无展开体；
 * - grep 无匹配行：「无匹配」摘要，无展开体；
 * - shell 有输出行：仍可内联展开（chevron + aria-expanded + 切换回调）。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { FileDiff, MessageToolCall } from '../../store/types';
import { CompactToolRow } from './CompactToolRow';
import type { ChatToolStackProps } from './ChatToolCallBlock';

const DIFF: FileDiff = {
  filePath: 'src/a.ts',
  additions: 1,
  deletions: 1,
  changes: [
    { type: 'deletion', content: 'old' },
    { type: 'addition', content: 'new' },
  ],
};

function stubProps(
  tc: MessageToolCall,
  actions: ChatToolStackProps['actions'] = {},
  onToggleTool: ChatToolStackProps['onToggleTool'] = () => {}
): ChatToolStackProps {
  return {
    items: [{ kind: 'single', tc }],
    agents: [],
    activeSessionId: 'sess-1',
    expandedTools: {},
    onToggleTool,
    approvalBusy: false,
    actions,
  };
}

describe('CompactToolRow 展开政策（E1）', () => {
  afterEach(() => {
    cleanup();
  });

  it('side-diff 行：整行改道侧栏，无 chevron / 无展开体', () => {
    const onOpenDiff = vi.fn();
    const tc: MessageToolCall = {
      id: 'd1',
      name: 'replace_file_content',
      status: 'success',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
      output: '完成',
      diffs: [DIFF],
    };
    const { container } = render(
      <CompactToolRow
        tc={tc}
        rowKey="d1"
        msgId="m1"
        props={stubProps(tc, { onOpenDiff })}
      />
    );
    expect(
      container.querySelector('[data-testid="tool-chevron-d1"]')
    ).toBeNull();
    expect(container.querySelector('[role="region"]')).toBeNull();

    const head = container.querySelector('div[role="button"]');
    expect(head).not.toBeNull();
    expect(head?.getAttribute('data-open-target')).toBe('side-diff-panel');
    expect(head?.getAttribute('aria-expanded')).toBeNull();
    expect(head?.getAttribute('aria-label')).toContain('在右侧面板查看差异');

    fireEvent.click(head!);
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onOpenDiff).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'src/a.ts' })
    );

    fireEvent.keyDown(head!, { key: 'Enter' });
    expect(onOpenDiff).toHaveBeenCalledTimes(2);
  });

  it('side-diff 行：宿主未提供 onOpenDiff → 静态行（不伪装可点）', () => {
    const tc: MessageToolCall = {
      id: 'd2',
      name: 'replace_file_content',
      status: 'success',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
      output: '完成',
      diffs: [DIFF],
    };
    const { container } = render(
      <CompactToolRow
        tc={tc}
        rowKey="d2"
        msgId="m1"
        props={stubProps(tc, {})}
      />
    );
    expect(container.querySelector('div[role="button"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="tool-chevron-d2"]')
    ).toBeNull();
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it('file_stat 行：轻量属性头（无冗长属性串） + 路径可点 + 无展开体', () => {
    const onOpenPath = vi.fn();
    const tc: MessageToolCall = {
      id: 's1',
      name: 'file_stat',
      status: 'success',
      arguments: JSON.stringify({ path: 'src/main.rs' }),
      output:
        'src/main.rs: file\nsize: 8251 bytes\nmtime: 1785676954141 ms\nreadonly: false',
    };
    const { container } = render(
      <CompactToolRow
        tc={tc}
        rowKey="s1"
        msgId="m1"
        props={stubProps(tc, { onOpenPath })}
      />
    );
    // 用户裁决（2026-11-02）：file_stat 行头无需冗长属性字符串，仅展示动作与路径
    expect(container.textContent).toContain('属性');
    expect(container.textContent).toContain('main.rs');
    expect(container.textContent).not.toContain('可读写');
    expect(
      container.querySelector('[data-testid="tool-chevron-s1"]')
    ).toBeNull();
    expect(container.querySelector('[role="region"]')).toBeNull();

    // 行头唯一的按钮即路径按钮（stat 路径已入可点集合）
    const pathBtn = container.querySelector('button');
    expect(pathBtn?.textContent).toContain('main.rs');
    fireEvent.click(pathBtn!);
    expect(onOpenPath).toHaveBeenCalledWith('src/main.rs');
  });

  it('grep 无匹配行：「无匹配」摘要 + 无展开体', () => {
    const tc: MessageToolCall = {
      id: 'g1',
      name: 'grep_search',
      status: 'success',
      arguments: JSON.stringify({ pattern: 'foo' }),
      output: '(no matches)',
    };
    const { container } = render(
      <CompactToolRow tc={tc} rowKey="g1" msgId="m1" props={stubProps(tc)} />
    );
    expect(container.textContent).toContain('无匹配');
    expect(
      container.querySelector('[data-testid="tool-chevron-g1"]')
    ).toBeNull();
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it('shell 有输出行：仍可内联展开（chevron + 切换回调）', () => {
    const onToggleTool = vi.fn();
    const tc: MessageToolCall = {
      id: 'c1',
      name: 'run_command',
      status: 'success',
      arguments: JSON.stringify({ CommandLine: 'ls' }),
      output: 'file-a\nfile-b',
    };
    const { container } = render(
      <CompactToolRow
        tc={tc}
        rowKey="c1"
        msgId="m1"
        props={stubProps(tc, {}, onToggleTool)}
      />
    );
    expect(
      container.querySelector('[data-testid="tool-chevron-c1"]')
    ).not.toBeNull();
    const head = container.querySelector('div[role="button"]');
    expect(head?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head!);
    expect(onToggleTool).toHaveBeenCalledWith('c1', false);
  });
});
