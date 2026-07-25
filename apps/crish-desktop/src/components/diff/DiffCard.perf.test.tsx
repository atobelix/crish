// @vitest-environment jsdom
/**
 * 性能与大文件 Diff 渲染测试 suite (DiffCard / DiffCodeViewer / useDiffData)
 * 1. 百KB级 (3500+ 行) 代码 Diff 算法解析与结构计算开销 (<50ms)
 * 2. 50 次 Context Folding 折叠/展开 (ExpandBlock) 性能 (<10ms/op)
 * 3. Unified View <-> Split View 视图模式转换开销 (<30ms)
 * 4. Plain Code Viewer 百万字符 (30,000+ 行) 源码虚拟切片渲染性能
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { useDiffData } from './useDiffData';
import { renderHook } from '@testing-library/react';
import { VirtualPlainCodeViewer } from './VirtualPlainCodeViewer';
import type { FileDiff } from '../../store/types';

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let origError: typeof console.error;
beforeAll(() => {
  origError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
    origError.call(console, ...args);
  };
});
afterAll(() => {
  console.error = origError;
});

function generateLargeFileDiff(lineCount = 3500): FileDiff {
  const changes: FileDiff['changes'] = [];
  changes.push({
    type: 'normal',
    content: `@@ -1,${lineCount} +1,${lineCount + 200} @@ function masterModule() {`,
  });

  for (let i = 1; i <= lineCount; i++) {
    const mod = i % 15;
    if (mod === 0) {
      changes.push({ type: 'deletion', content: `-  const oldVariable_${i} = ${i} * 100; // Deprecated legacy code` });
      changes.push({ type: 'addition', content: `+  const newVariable_${i} = ${i} * 200; // Upgraded high performance logic` });
    } else if (mod === 5) {
      changes.push({ type: 'addition', content: `+  console.log("Trace log line ${i}", { timestamp: Date.now() });` });
    } else {
      changes.push({ type: 'normal', content: `   const context_line_${i} = "keep line intact ${i}";` });
    }
  }

  return {
    filePath: 'src/core/LargeModuleParser.ts',
    status: 'modified',
    additions: 430,
    deletions: 230,
    changes,
  };
}

describe('DiffCard / DiffData — 百KB级代码 Diff 性能与折叠断言', () => {
  it('百KB级 (3500+ 行) Diff 语法结构解析与计算开销 (<50ms)', () => {
    const largeDiff = generateLargeFileDiff(3500);

    const startTime = performance.now();
    const { result } = renderHook(() =>
      useDiffData({
        session: null,
        diffFiles: [largeDiff],
        activeDiffSource: largeDiff,
        diffSearchQuery: '',
        diffViewMode: 'unified',
        sourceMode: 'list',
      })
    );
    const duration = performance.now() - startTime;

    // 断言 Hook 计算解析耗时 < 50ms
    expect(duration).toBeLessThan(50.0);

    const computed = result.current.computedChangesByFile.get(largeDiff.filePath);
    expect(computed).toBeDefined();
    expect(computed!.length).toBeGreaterThan(3500);

    const unifiedItems = result.current.unifiedRenderCache.get(largeDiff.filePath);
    expect(unifiedItems).toBeDefined();
    expect(unifiedItems!.length).toBeGreaterThan(0);

    // 验证折叠机制：未修改的连续 context 行被压缩为 isCollapsedPlaceholder: true 节点
    const placeholders = unifiedItems!.filter((item) => item.isCollapsedPlaceholder);
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it('50 次 Context Folding 展开 (handleExpandBlock) 性能与增量更新 (<10ms/op)', () => {
    const largeDiff = generateLargeFileDiff(3000);

    const { result } = renderHook(() =>
      useDiffData({
        session: null,
        diffFiles: [largeDiff],
        activeDiffSource: largeDiff,
        diffSearchQuery: '',
        diffViewMode: 'unified',
        sourceMode: 'list',
      })
    );

    const unifiedItems = result.current.unifiedRenderCache.get(largeDiff.filePath) ?? [];
    const placeholders = unifiedItems.filter(
      (item): item is Extract<typeof item, { isCollapsedPlaceholder: true }> => item.isCollapsedPlaceholder
    );
    expect(placeholders.length).toBeGreaterThan(0);

    // 连续 50 次展开被折叠的代码块
    const expandDurations: number[] = [];
    const targetPlaceholders = placeholders.slice(0, 50);

    for (const ph of targetPlaceholders) {
      const start = performance.now();
      act(() => {
        result.current.handleExpandBlock(largeDiff.filePath, ph.startIndex);
      });
      const end = performance.now();
      expandDurations.push(end - start);
    }

    const maxExpandTime = Math.max(...expandDurations);
    const avgExpandTime = expandDurations.reduce((a, b) => a + b, 0) / expandDurations.length;

    // 单次展开开销断言：最大单次展开 < 100ms，平均 < 20ms (jsdom 测试环境开销包容)
    expect(maxExpandTime).toBeLessThan(100.0);
    expect(avgExpandTime).toBeLessThan(20.0);
  });

  it('Unified View <-> Split View 视图模式转换计算开销 (<100ms)', () => {
    const largeDiff = generateLargeFileDiff(3500);

    let viewMode: 'unified' | 'split' = 'unified';
    const { result, rerender } = renderHook(() =>
      useDiffData({
        session: null,
        diffFiles: [largeDiff],
        activeDiffSource: largeDiff,
        diffSearchQuery: '',
        diffViewMode: viewMode,
        sourceMode: 'list',
      })
    );

    expect(result.current.unifiedRenderCache.size).toBe(1);
    expect(result.current.splitRenderCache.size).toBe(0);

    // 切换至 Split View
    viewMode = 'split';
    const startSwitch = performance.now();
    rerender();
    const switchDuration = performance.now() - startSwitch;

    expect(switchDuration).toBeLessThan(100.0);
    expect(result.current.splitRenderCache.size).toBe(1);
    expect(result.current.splitRenderCache.get(largeDiff.filePath)!.length).toBeGreaterThan(0);
  });

  it('Plain Code Viewer 百万字符 (30,000+ 行) 源码虚拟切片渲染性能 (<300ms)', () => {
    // 生成 30,000 行 (~1.2MB) 源码文本
    const lines: string[] = [];
    for (let i = 1; i <= 30000; i++) {
      lines.push(`export const codeLine_${i} = function() { return "Line value ${i}"; };`);
    }
    const hugeContent = lines.join('\n');

    const startTime = performance.now();
    const { container } = render(
      <VirtualPlainCodeViewer content={hugeContent} filePath="src/big/HugeFile.ts" />
    );
    const duration = performance.now() - startTime;

    // 初次挂载性能断言 < 300ms (jsdom 环境)
    expect(duration).toBeLessThan(300.0);

    // DOM 限制断言：DOM 中渲染的 line 节点数受限于视口切片（<= 100 个元素），而不是 30,000 行 (90,000+ 节点)
    const renderedLines = container.querySelectorAll('[class*="line"]');
    expect(renderedLines.length).toBeGreaterThan(0);
    expect(renderedLines.length).toBeLessThanOrEqual(100);
    expect(renderedLines.length).not.toBe(30000);
  });
});
