// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import {
  TurnProcessNodeView,
  countProcessMetrics,
} from '../TurnProcessNodeView';
import type { AssistantTimelineItem } from '../../../api/toolPresentation';

describe('countProcessMetrics 指标纯函数', () => {
  it('正确统计 single 与 group 混合的工具调用与思考耗时', () => {
    const items: AssistantTimelineItem[] = [
      {
        kind: 'thought',
        key: 'th-1',
        content: 'Thinking step 1',
        durationMs: 1500,
      },
      {
        kind: 'tools',
        key: 'tl-1',
        items: [
          {
            kind: 'single',
            tc: { id: 't-1', name: 'read_file', args: '{}' } as any,
          },
          {
            kind: 'group',
            id: 'grp-1',
            label: 'Search group',
            tools: [
              { id: 't-2', name: 'grep_search', args: '{}' } as any,
              { id: 't-3', name: 'find_by_name', args: '{}' } as any,
            ],
          },
        ],
      },
      {
        kind: 'thought',
        key: 'th-2',
        content: 'Thinking step 2',
        durationMs: 2500,
      },
    ];

    const metrics = countProcessMetrics(items);
    expect(metrics.toolCount).toBe(3); // 1 single + 2 group
    expect(metrics.thoughtCount).toBe(2);
    expect(metrics.durationMs).toBe(4000);
  });
});

describe('TurnProcessNodeView 组件生命周期与渲染', () => {
  const sampleItems: AssistantTimelineItem[] = [
    {
      kind: 'tools',
      key: 'tl-1',
      items: [
        {
          kind: 'single',
          tc: { id: 't-1', name: 'read_file', args: '{}' } as any,
        },
        {
          kind: 'single',
          tc: { id: 't-2', name: 'grep_search', args: '{}' } as any,
        },
      ],
    },
    {
      kind: 'thought',
      key: 'th-1',
      content: 'Deep reasoning',
      durationMs: 3500,
    },
  ];

  it('验证生成期平铺直出（不渲染 33px 控制栏）', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <TurnProcessNodeView
        msgId="msg-live-1"
        items={sampleItems}
        isTurnLive={true}
        hasFinalAnswer={false}
        turnStatus="processing"
        isExpanded={false}
        onToggleExpand={onToggle}
        renderChildren={() => <div data-testid="live-children">Live Stream Content</div>}
      />
    );

    // 生成中不应出现折叠按钮控制栏
    expect(screen.queryByRole('button')).toBeNull();
    // 渲染直出容器
    expect(screen.getByTestId('live-children')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass(/liveProcessStream/);
  });

  it('验证终态渲染 33px 控制栏与摘要文案（"N 项工具调用 · 思考耗时 Xs"）', () => {
    const onToggle = vi.fn();
    render(
      <TurnProcessNodeView
        msgId="msg-done-1"
        items={sampleItems}
        isTurnLive={false}
        hasFinalAnswer={true}
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={onToggle}
        renderChildren={() => <div data-testid="child-content">Hidden Steps</div>}
      />
    );

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass(/turnProcessControlBar/);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'process-slot-msg-done-1');

    // 检查文案："2 项工具调用 · 思考耗时 3.5s"
    expect(screen.getByText('2 项工具调用 · 思考耗时 3.5s')).toBeInTheDocument();

    // 检查收起状态下的 chevron 与 slot
    const slot = document.getElementById('process-slot-msg-done-1');
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveAttribute('hidden', 'until-found');
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });

  it('验证 Tool-Only 终态纯工具调用轮次自动触发收折（toolCount >= 2）', () => {
    const toolOnlyItems: AssistantTimelineItem[] = [
      {
        kind: 'tools',
        key: 'tl-1',
        items: [
          { kind: 'single', tc: { id: 't-1', name: 'read_file', args: '{}' } as any },
          { kind: 'single', tc: { id: 't-2', name: 'read_file', args: '{}' } as any },
        ],
      },
    ];

    render(
      <TurnProcessNodeView
        msgId="msg-tool-only"
        items={toolOnlyItems}
        isTurnLive={false}
        hasFinalAnswer={false} // 无正文回答
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={vi.fn()}
        renderChildren={() => <div>Tool Content</div>}
      />
    );

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(screen.getByText('2 项工具调用')).toBeInTheDocument();
  });

  it('验证 Tool-Only 单个工具调用（toolCount < 2）保持单行展开不折叠', () => {
    const singleToolItem: AssistantTimelineItem[] = [
      {
        kind: 'tools',
        key: 'tl-1',
        items: [
          { kind: 'single', tc: { id: 't-1', name: 'read_file', args: '{}' } as any },
        ],
      },
    ];

    render(
      <TurnProcessNodeView
        msgId="msg-single-tool"
        items={singleToolItem}
        isTurnLive={false}
        hasFinalAnswer={false}
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={vi.fn()}
        renderChildren={() => <div data-testid="single-tool-content">Single Tool</div>}
      />
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('single-tool-content')).toBeInTheDocument();
  });

  it('验证仅思考无耗时回退显示"已深度思考"', () => {
    const thoughtOnlyItems: AssistantTimelineItem[] = [
      {
        kind: 'thought',
        key: 'th-1',
        content: 'Reasoning without timer',
        durationMs: 0,
      },
    ];

    render(
      <TurnProcessNodeView
        msgId="msg-thought-fallback"
        items={thoughtOnlyItems}
        isTurnLive={false}
        hasFinalAnswer={true}
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={vi.fn()}
        renderChildren={() => <div>Thought content</div>}
      />
    );

    expect(screen.getByText('已深度思考')).toBeInTheDocument();
  });

  it('验证点击切换展开/收起，并更新 aria-expanded 与 chevron 状态', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TurnProcessNodeView
        msgId="msg-toggle"
        items={sampleItems}
        isTurnLive={false}
        hasFinalAnswer={true}
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={onToggle}
        renderChildren={() => <div>Toggled Content</div>}
      />
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('msg-toggle');

    // 重新渲染为展开态
    rerender(
      <TurnProcessNodeView
        msgId="msg-toggle"
        items={sampleItems}
        isTurnLive={false}
        hasFinalAnswer={true}
        turnStatus="completed"
        isExpanded={true}
        onToggleExpand={onToggle}
        renderChildren={() => <div>Toggled Content</div>}
      />
    );

    expect(button).toHaveAttribute('aria-expanded', 'true');
    const slot = document.getElementById('process-slot-msg-toggle');
    expect(slot).not.toHaveAttribute('hidden');
    const chevron = button.querySelector('span[aria-hidden="true"]');
    expect(chevron).toHaveClass(/chevronOpen/);
  });

  it('验证 until-found 槽位在 beforematch 原生事件派发时自动触发展开', () => {
    const onToggle = vi.fn();
    render(
      <TurnProcessNodeView
        msgId="msg-search-match"
        items={sampleItems}
        isTurnLive={false}
        hasFinalAnswer={true}
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={onToggle}
        renderChildren={() => <div data-testid="target-text">Keyword here</div>}
      />
    );

    const slot = document.getElementById('process-slot-msg-search-match')!;
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveAttribute('hidden', 'until-found');

    // 模拟 Chromium 原生 find-in-page 触发 beforematch 事件
    act(() => {
      slot.dispatchEvent(new Event('beforematch'));
    });

    expect(onToggle).toHaveBeenCalledWith('msg-search-match');
  });

  it('验证 React onBeforeMatch 属性也可正常捕获 beforematch 事件', () => {
    const onToggle = vi.fn();
    render(
      <TurnProcessNodeView
        msgId="msg-react-match"
        items={sampleItems}
        isTurnLive={false}
        hasFinalAnswer={true}
        turnStatus="completed"
        isExpanded={false}
        onToggleExpand={onToggle}
        renderChildren={() => <div>React match</div>}
      />
    );

    const slot = document.getElementById('process-slot-msg-react-match')!;
    act(() => {
      fireEvent(slot, new Event('beforematch'));
    });

    expect(onToggle).toHaveBeenCalledWith('msg-react-match');
  });
});
