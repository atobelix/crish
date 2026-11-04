// @vitest-environment jsdom
/**
 * AN4 组件级行为钉：
 * - 交错入场：同一批 7 行工具行按挂载序领 0/50/…/250/0ms 延时
 *   （50ms/行、总延时 ≤300ms），历史行零入场；
 * - 让位（§5.1）：输出排空进行中，行内指针按下同帧 settle 排空；
 * - 组自动折叠延后：组内排空未落定时不折叠，settle 后折叠，
 *   永不落定则 900ms 硬顶折叠；组头实况形成入场。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { MessageToolCall } from '../../../store/types';
import type { ToolRenderItem } from '../../../api/toolPresentation';
import { CompactToolRow } from '../CompactToolRow';
import { FoldableToolGroup } from '../FoldableToolGroup';
import type { ChatToolStackProps } from '../ChatToolCallBlock';
import {
  _resetToolRevealStateForTesting,
  hasActiveToolDrain,
  hasToolInteracted,
  registerToolDrain,
  unregisterToolDrain,
} from '../toolRevealState';

function stackProps(items: ToolRenderItem[]): ChatToolStackProps {
  return {
    items,
    agents: [],
    activeSessionId: 'sess-1',
    expandedTools: {},
    onToggleTool: () => {},
    approvalBusy: false,
    actions: {},
  } as ChatToolStackProps;
}

beforeEach(() => {
  _resetToolRevealStateForTesting();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AN4 · 工具行交错入场', () => {
  it('同批 7 行：延时 0/50/100/150/200/250/0ms（挂载序发放）', () => {
    const now = Date.now();
    const items: ToolRenderItem[] = Array.from({ length: 7 }, (_, i) => {
      const tc: MessageToolCall = {
        id: `s${i}`,
        name: 'web_search',
        status: 'success',
        arguments: '{"query":"x"}',
        output: 'ok',
        startedAt: now - 100,
        completedAt: now - 10,
      };
      return { kind: 'single', tc };
    });
    const props = stackProps(items);
    const { container } = render(
      <>
        {items.map((item) =>
          item.kind === 'single' ? (
            <CompactToolRow
              key={item.tc.id}
              tc={item.tc}
              rowKey={item.tc.id}
              msgId="m1"
              props={props}
            />
          ) : null
        )}
      </>
    );
    const delays = items.map((item) => {
      const id = item.kind === 'single' ? item.tc.id : '';
      const row = container.querySelector(`[data-tool-id="${id}"]`);
      expect(row?.getAttribute('data-entering')).toBe('true');
      return row instanceof HTMLElement
        ? row.style.getPropertyValue('--reveal-delay')
        : '';
    });
    expect(delays).toEqual([
      '0ms',
      '50ms',
      '100ms',
      '150ms',
      '200ms',
      '250ms',
      '0ms',
    ]);
  });

  it('历史行（旧时间戳）零入场', () => {
    const tc: MessageToolCall = {
      id: 'old1',
      name: 'web_search',
      status: 'success',
      arguments: '{"query":"x"}',
      output: 'ok',
      startedAt: Date.now() - 120_000,
      completedAt: Date.now() - 119_000,
    };
    const props = stackProps([{ kind: 'single', tc }]);
    const { container } = render(
      <CompactToolRow tc={tc} rowKey="old1" msgId="m1" props={props} />
    );
    const row = container.querySelector('[data-tool-id="old1"]');
    expect(row?.getAttribute('data-entering')).toBeNull();
  });
});

describe('AN4 · 让位：排空中交互同帧 settle（§5.1）', () => {
  it('展开行输出排空进行中，指针按下 → 排空落定 + 交互登记', () => {
    const now = Date.now();
    const running: MessageToolCall = {
      id: 'p1',
      name: 'web_search',
      status: 'running',
      arguments: '{"query":"x"}',
      startedAt: now - 50,
    };
    const props: ChatToolStackProps = {
      ...stackProps([{ kind: 'single', tc: running }]),
      expandedTools: { p1: true },
    };
    const { container, rerender } = render(
      <CompactToolRow tc={running} rowKey="p1" msgId="m1" props={props} />
    );
    expect(hasActiveToolDrain('p1')).toBe(false);

    const done: MessageToolCall = {
      ...running,
      status: 'success',
      output: 'x'.repeat(2000),
      completedAt: Date.now(),
    };
    rerender(
      <CompactToolRow
        tc={done}
        rowKey="p1"
        msgId="m1"
        props={{ ...props, items: [{ kind: 'single', tc: done }] }}
      />
    );
    // 输出到达 → 排空启动并注册
    expect(hasActiveToolDrain('p1')).toBe(true);

    const row = container.querySelector('[data-tool-id="p1"]');
    expect(row).not.toBeNull();
    fireEvent.pointerDown(row!);
    // 同帧让位：排空被 settle（注册清除）且交互已登记
    expect(hasActiveToolDrain('p1')).toBe(false);
    expect(hasToolInteracted('p1')).toBe(true);
  });
});

describe('AN4 · FoldableToolGroup 自动折叠延后（协调段）', () => {
  function gtc(
    id: string,
    status: MessageToolCall['status'],
    extra?: Partial<MessageToolCall>
  ): MessageToolCall {
    return { id, name: 'run_command', status, arguments: '', ...extra };
  }

  function hostProps(items: ToolRenderItem[]) {
    return {
      agents: [],
      activeSessionId: 's1',
      expandedTools: {},
      onToggleTool: vi.fn(),
      approvalBusy: false,
      items,
    };
  }

  it('组内排空未落定 → 不折叠；settle 后折叠', () => {
    const runningItems: ToolRenderItem[] = [
      { kind: 'single', tc: gtc('g1', 'running') },
      { kind: 'single', tc: gtc('g2', 'running') },
    ];
    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={runningItems}
        msgId="gm1"
        hostProps={hostProps(runningItems)}
      />
    );
    const root = getByTestId('foldable-tool-group');
    expect(root.getAttribute('data-expanded')).toBe('true');

    registerToolDrain('g1', vi.fn());
    const doneItems: ToolRenderItem[] = [
      { kind: 'single', tc: gtc('g1', 'success') },
      { kind: 'single', tc: gtc('g2', 'success') },
    ];
    rerender(
      <FoldableToolGroup
        items={doneItems}
        msgId="gm1"
        hostProps={hostProps(doneItems)}
      />
    );
    // 排空未落定：自动折叠被延后
    expect(root.getAttribute('data-expanded')).toBe('true');

    act(() => {
      unregisterToolDrain('g1');
    });
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('排空永不落定 → 900ms 硬顶后折叠', () => {
    vi.useFakeTimers();
    const runningItems: ToolRenderItem[] = [
      { kind: 'single', tc: gtc('h1', 'running') },
      { kind: 'single', tc: gtc('h2', 'running') },
    ];
    const { getByTestId, rerender } = render(
      <FoldableToolGroup
        items={runningItems}
        msgId="gm2"
        hostProps={hostProps(runningItems)}
      />
    );
    const root = getByTestId('foldable-tool-group');
    registerToolDrain('h1', vi.fn());
    const doneItems: ToolRenderItem[] = [
      { kind: 'single', tc: gtc('h1', 'success') },
      { kind: 'single', tc: gtc('h2', 'success') },
    ];
    rerender(
      <FoldableToolGroup
        items={doneItems}
        msgId="gm2"
        hostProps={hostProps(doneItems)}
      />
    );
    expect(root.getAttribute('data-expanded')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(899);
    });
    expect(root.getAttribute('data-expanded')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root.getAttribute('data-expanded')).toBe('false');
  });

  it('组头实况形成入场，历史组不入场', () => {
    const now = Date.now();
    const liveItems: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: gtc('e1', 'success', {
          startedAt: now - 100,
          completedAt: now - 10,
        }),
      },
      {
        kind: 'single',
        tc: gtc('e2', 'success', {
          startedAt: now - 90,
          completedAt: now - 5,
        }),
      },
    ];
    const { getByTestId } = render(
      <FoldableToolGroup
        items={liveItems}
        msgId="gm3"
        hostProps={hostProps(liveItems)}
      />
    );
    expect(
      getByTestId('foldable-tool-group').getAttribute('data-entering')
    ).toBe('true');
  });
});
