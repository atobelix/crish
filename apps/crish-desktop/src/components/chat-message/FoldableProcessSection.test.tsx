/**
 * @vitest-environment jsdom
 * apps/crish-desktop/src/components/chat-message/FoldableProcessSection.test.tsx
 * 覆盖：until-found 属性注入、beforematch 精准触发、单轨测高作废调用、forceExpanded 约束。
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FoldableProcessSection } from './FoldableProcessSection';
import type { ProcessSegmentMetrics } from '../../api/toolPresentation';

function mockMetrics(): ProcessSegmentMetrics {
  return {
    thoughtCount: 0,
    thoughtDurationMs: 0,
    toolCount: 1,
    subagentCount: 0,
    searchCount: 0,
    commandCount: 0,
    readFilesCount: 1,
    editFilesCount: 0,
    readPaths: ['src/index.ts'],
    editPaths: [],
    injectionCount: 0,
    totalDurationMs: 0,
    hasRunning: false,
    hasError: false,
    isStreaming: false,
    leadAction: 'read',
  };
}

describe('FoldableProcessSection 动态测高与检索穿透断言', () => {
  it('终态折叠时必须通过 setAttribute 赋予 hidden="until-found"，严禁 return null', () => {
    const onToggle = vi.fn();
    const onExpand = vi.fn();

    render(
      <FoldableProcessSection
        msgId="msg-1"
        sectionId="msg-test-proc-0"
        items={[]}
        metrics={mockMetrics()}
        isExpanded={false}
        isFoldable={true}
        onToggle={onToggle}
        onExpand={onExpand}
        renderItem={() => <div data-testid="tool-item">read_file('src/index.ts')</div>}
      />
    );

    const slot = screen.getByTestId('process-slot-msg-test-proc-0');
    // 断言 1：DOM 节点必须常驻存在，严禁被卸载
    expect(slot).toBeInTheDocument();
    // 断言 2：属性必须是原生字符串 "until-found"，绝对不能是布尔反射的空字符串 ""
    expect(slot.getAttribute('hidden')).toBe('until-found');
  });

  it('原生 beforematch 触发时，必须精确调用 onExpand 与 onInvalidateActual', () => {
    const onToggle = vi.fn();
    const onExpand = vi.fn();
    const onInvalidateActual = vi.fn();

    render(
      <FoldableProcessSection
        msgId="msg-101"
        sectionId="msg-test-proc-1"
        items={[]}
        metrics={mockMetrics()}
        isExpanded={false}
        isFoldable={true}
        onToggle={onToggle}
        onExpand={onExpand}
        onInvalidateActual={onInvalidateActual}
        renderItem={() => <div>cargo test --workspace</div>}
      />
    );

    const slot = screen.getByTestId('process-slot-msg-test-proc-1');

    // 模拟 Chromium 原生检索命中时派发 beforematch
    const beforeMatchEvent = new Event('beforematch');
    slot.dispatchEvent(beforeMatchEvent);

    // 断言 1：仅精准展开本分段
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledWith('msg-test-proc-1');
    // 断言 2：必须调用测高作废通知
    expect(onInvalidateActual).toHaveBeenCalledTimes(1);
    expect(onInvalidateActual).toHaveBeenCalledWith('msg-101');
  });

  it('用户手动点击折叠栏时，触发 onToggle', () => {
    const onToggle = vi.fn();
    const onExpand = vi.fn();
    const onInvalidateActual = vi.fn();

    render(
      <FoldableProcessSection
        msgId="msg-202"
        sectionId="msg-test-proc-0"
        items={[]}
        metrics={mockMetrics()}
        isExpanded={true}
        isFoldable={true}
        onToggle={onToggle}
        onExpand={onExpand}
        onInvalidateActual={onInvalidateActual}
        renderItem={() => <div>Thinking details</div>}
      />
    );

    const toggleBtn = screen.getByTestId('process-toggle-msg-test-proc-0');
    fireEvent.click(toggleBtn);

    expect(onToggle).toHaveBeenCalledWith('msg-test-proc-0', false);
  });

  it('forceExpanded 为 true 时，折叠禁用且永不设置 hidden 属性', () => {
    const onToggle = vi.fn();
    const onExpand = vi.fn();

    render(
      <FoldableProcessSection
        msgId="msg-303"
        sectionId="msg-test-proc-subagent"
        items={[]}
        metrics={{ ...mockMetrics(), subagentCount: 1, leadAction: 'subagent' }}
        isExpanded={false}
        isFoldable={true}
        forceExpanded={true}
        onToggle={onToggle}
        onExpand={onExpand}
        renderItem={() => <div>Subagent task</div>}
      />
    );

    const slot = screen.getByTestId('process-slot-msg-test-proc-subagent');
    expect(slot.getAttribute('hidden')).toBeNull();

    const toggleBtn = screen.getByTestId('process-toggle-msg-test-proc-subagent');
    fireEvent.click(toggleBtn);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
