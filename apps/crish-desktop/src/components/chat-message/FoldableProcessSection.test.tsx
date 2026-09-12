/**
 * @vitest-environment jsdom
 * apps/crish-desktop/src/components/chat-message/FoldableProcessSection.test.tsx
 * 覆盖：until-found 属性注入、beforematch 精准触发、单轨测高作废调用、forceExpanded 约束。
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
        showWorkTime={false}
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
        showWorkTime={false}
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
        showWorkTime={false}
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
        showWorkTime={false}
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
 * 控制栏工作时间（用户裁决 · 2026-09-11）
 *   ① 工作时长承载于控制栏 —— 即原「已深度思考」所在位置
 *   ② 运行中跳秒（裸时长，无前缀）；终态定格为「工作 xx 时间」（可跨秒 / 分 / 时）
 *   ③ 只有一个思考 或 一个工具调用 → 退化为「思考」/「已运行 N 条命令」
 *   ④ 顶部 dashed hairline 工作时间区已物理切除，禁止任何形式回潮
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('FoldableProcessSection 控制栏工作时间', () => {
  function renderBar(opts: {
    showWorkTime: boolean;
    isLive?: boolean;
    startTime?: number;
    endTime?: number;
    totalDurationMs?: number;
    metrics?: Partial<ProcessSegmentMetrics>;
  }) {
    // 同一 it 内可能连续渲染多组参数（穷举断言），先卸载上一棵渲染树
    cleanup();
    render(
      <FoldableProcessSection
        msgId="msg-cap"
        sectionId="msg-cap-proc-0"
        items={[]}
        metrics={{
          ...mockMetrics(),
          toolCount: 2,
          totalDurationMs: opts.totalDurationMs ?? 0,
          ...opts.metrics,
        }}
        startTime={opts.startTime}
        endTime={opts.endTime}
        showWorkTime={opts.showWorkTime}
        isLive={opts.isLive ?? false}
        isExpanded={true}
        isFoldable={true}
        onToggle={vi.fn()}
        onExpand={vi.fn()}
        renderItem={() => <div>item</div>}
      />
    );
    return screen.getByTestId('process-toggle-msg-cap-proc-0');
  }

  it('负向断言（物理切除）：dashed hairline 工作时间区节点已彻底消失', () => {
    renderBar({ showWorkTime: true, startTime: 1_700_000_000_000, endTime: 1_700_000_012_500 });
    expect(screen.queryByTestId('process-time-capsule')).toBeNull();
    expect(document.querySelector('[class*="timeCapsule"]')).toBeNull();
  });

  it('运行中（isLive）→ 控制栏跳秒且不写「工作」前缀，标记 data-live=true', () => {
    const bar = renderBar({ showWorkTime: true, isLive: true, startTime: Date.now() - 3_400 });
    expect(bar.getAttribute('data-live')).toBe('true');
    expect(bar.textContent ?? '').toMatch(/\d+\.\d 秒/);
    expect(bar.textContent ?? '').not.toContain('工作');
  });

  it('终态 → 控制栏定格为「已完成 xx 时间」，标记 data-live=false', () => {
    const bar = renderBar({
      showWorkTime: true,
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_012_500,
    });
    expect(bar.getAttribute('data-live')).toBe('false');
    expect(bar.textContent).toContain('已完成 12.5 秒');
  });

  it('单思考段（不显示工作时间区域）→ 退化为「思考」', () => {
    const bar = renderBar({
      showWorkTime: false,
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_003_200,
      metrics: { toolCount: 0, thoughtCount: 1, thoughtDurationMs: 3_200 },
    });
    expect(bar.textContent).toContain('思考');
    expect(bar.textContent ?? '').not.toContain('工作');
  });

  it('单工具调用段（命令行）→ 展示「已运行 N 条命令」', () => {
    const bar = renderBar({
      showWorkTime: false,
      metrics: { toolCount: 1, thoughtCount: 0, readFilesCount: 0, commandCount: 1 },
    });
    expect(bar.textContent).toContain('已运行 1 条命令');
  });

  it('工作时间段（showWorkTime=true）不得渲染前缀图标，工具描述段（showWorkTime=false）渲染主导图标', () => {
    // 1. showWorkTime=true: 不得有任何前缀图标
    const barWithTime = renderBar({ showWorkTime: true });
    expect(barWithTime.querySelector('svg')).toBeNull();

    // 2. showWorkTime=false: 存在对应主导动作图标
    const barWithTools = renderBar({
      showWorkTime: false,
      metrics: { toolCount: 1, commandCount: 1, readFilesCount: 0, leadAction: 'command' },
    });
    expect(barWithTools.querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
  });

  it('负向断言：控制栏文案区绝不得出现「已深度思考」', () => {
    const banned = ['已深', '度思考'].join('');
    for (const [capsule, live] of [[true, true], [true, false], [false, false]] as const) {
      const bar = renderBar({
        showWorkTime: capsule,
        isLive: live,
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_065_000,
        metrics: { thoughtCount: 3, thoughtDurationMs: 65_000, toolCount: 2 },
      });
      expect(bar.textContent ?? '').not.toContain(banned);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CSS 契约负向断言（样式欺骗零容忍）
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('FoldableProcessSection.module.css 契约', () => {
  /** 剥离 CSS 注释后再做契约扫描：注释内的反例文本不得被误判为真实声明 */
  const css = readFileSync(
    resolve(__dirname, 'FoldableProcessSection.module.css'),
    'utf-8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('同段内容槽 gap 必须为 0（思考 / 工具之间不得有额外留白）', () => {
    const block = css.match(/\.sectionBody:not\(\[hidden\]\)\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block).toMatch(/gap:\s*0/);
    // 负向断言：禁止以 padding 变相制造留白
    expect(block).toMatch(/padding-top:\s*0/);
    expect(block).toMatch(/padding-bottom:\s*0/);
  });

  it('负向断言（物理切除）：工作时间区样式已彻底消失，全文件不得残留 dashed 发丝分割', () => {
    expect(css).not.toMatch(/\.timeCapsule/);
    expect(css).not.toMatch(/border-top:[^;]*dashed/);
    expect(css).not.toMatch(/border-bottom:[^;]*dashed/);
  });

  it('负向断言（用户裁决）：控制栏不得携带任何发丝分割线', () => {
    const block = css.match(/\.controlBar\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block).not.toMatch(/border-bottom/);
    expect(block).not.toMatch(/border-top/);
    // 悬停态同样禁止回潮分割线
    const hover = css.match(/\.controlBar:hover\s*\{[^}]*\}/)?.[0] ?? '';
    expect(hover).not.toMatch(/border/);
  });

  it('控制栏文案与思考 / 工具行同构：14px、字重 400、继承色、严禁裸 Hex', () => {
    const block = css.match(/\.summaryLabel\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block).toMatch(/font-size:\s*14px/);
    expect(block).not.toMatch(/font-size:\s*var\(--font-size-(xs|micro|xxs)/);
    expect(block).toMatch(/font-weight:\s*var\(--font-weight-normal/);
    expect(block).not.toMatch(/font-weight:\s*(500|600|700)/);
    expect(block).toMatch(/color:\s*inherit/);
    // 负向断言：全文件零裸 Hex（Design Token 纪律）
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('负向断言：严禁对 [hidden] 施加 display: none !important', () => {
    expect(css).not.toMatch(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
  });
});
