/**
 * @vitest-environment jsdom
 * apps/crish-desktop/src/components/chat-message/FoldableProcessSection.test.tsx
 * 覆盖：until-found 属性注入、beforematch 精准触发、单轨测高作废调用、forceExpanded 约束。
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FoldableProcessSection, formatDurationLabel } from './FoldableProcessSection';
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
        showTimeCapsule={false}
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
        showTimeCapsule={false}
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
        showTimeCapsule={false}
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
        showTimeCapsule={false}
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 顶部工作时间胶囊（用户裁决 · 2026-09-11）
 *   ① 最上面只有时间，绝不出现「已深度思考」等状态词
 *   ② 运行中跳秒；终态定格为「工作 xx 时间」（可跨秒 / 分 / 时）
 *   ③ 只有一个思考 或 一个工具调用 → 工作时间区域与分割线一律不显示
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('FoldableProcessSection 顶部工作时间胶囊', () => {
  function renderCapsule(opts: {
    showTimeCapsule: boolean;
    isLive?: boolean;
    startTime?: number;
    endTime?: number;
    totalDurationMs?: number;
  }) {
    render(
      <FoldableProcessSection
        msgId="msg-cap"
        sectionId="msg-cap-proc-0"
        items={[]}
        metrics={{
          ...mockMetrics(),
          toolCount: 2,
          totalDurationMs: opts.totalDurationMs ?? 0,
        }}
        startTime={opts.startTime}
        endTime={opts.endTime}
        showTimeCapsule={opts.showTimeCapsule}
        isLive={opts.isLive ?? false}
        isExpanded={true}
        isFoldable={true}
        onToggle={vi.fn()}
        onExpand={vi.fn()}
        renderItem={() => <div>item</div>}
      />
    );
  }

  it('showTimeCapsule=false（单思考 / 单工具）→ 胶囊与虚线分割一律不渲染', () => {
    renderCapsule({ showTimeCapsule: false, startTime: 1_700_000_000_000, endTime: 1_700_000_012_000 });
    expect(screen.queryByTestId('process-time-capsule')).toBeNull();
  });

  it('运行中（isLive）→ 胶囊跳秒且不写「工作」前缀，标记 data-live=true', () => {
    renderCapsule({ showTimeCapsule: true, isLive: true, startTime: Date.now() - 3_400 });
    const cap = screen.getByTestId('process-time-capsule');
    expect(cap.getAttribute('data-live')).toBe('true');
    expect(cap.textContent ?? '').toMatch(/^\d+\.\d 秒$/);
    // 负向断言：绝不出现「已深度思考」
    expect(cap.textContent ?? '').not.toContain('已深度思考');
  });

  it('终态 → 定格为「工作 xx 时间」，标记 data-live=false', () => {
    renderCapsule({
      showTimeCapsule: true,
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_012_500,
    });
    const cap = screen.getByTestId('process-time-capsule');
    expect(cap.getAttribute('data-live')).toBe('false');
    expect(cap.textContent).toBe('工作 12.5 秒');
  });

  it('终态且无法取得有效耗时 → 不渲染（杜绝「工作 0.0 秒」样式假象）', () => {
    renderCapsule({ showTimeCapsule: true, startTime: 1_700_000_000_000, totalDurationMs: 0 });
    expect(screen.queryByTestId('process-time-capsule')).toBeNull();
  });

  it('负向断言：胶囊文案区不得出现任何状态词（只承载时间）', () => {
    renderCapsule({
      showTimeCapsule: true,
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_065_000,
    });
    const text = screen.getByTestId('process-time-capsule').textContent ?? '';
    expect(text).toBe('工作 1 分 5 秒');
    for (const banned of ['已深度思考', '思考', '工具', '运行中', '正在']) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('formatDurationLabel 边界穷举', () => {
  it('秒 / 分秒 / 时分的档位切换', () => {
    expect(formatDurationLabel(0)).toBe('0.0 秒');
    expect(formatDurationLabel(999)).toBe('1.0 秒');
    expect(formatDurationLabel(12_500)).toBe('12.5 秒');
    expect(formatDurationLabel(59_900)).toBe('59.9 秒');
    expect(formatDurationLabel(60_000)).toBe('1 分 0 秒');
    expect(formatDurationLabel(65_000)).toBe('1 分 5 秒');
    expect(formatDurationLabel(3_599_000)).toBe('59 分 59 秒');
    expect(formatDurationLabel(3_600_000)).toBe('1 小时 0 分');
    expect(formatDurationLabel(7_260_000)).toBe('2 小时 1 分');
  });
});
