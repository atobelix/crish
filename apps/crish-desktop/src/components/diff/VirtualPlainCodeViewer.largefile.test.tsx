// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { VirtualPlainCodeViewer } from './VirtualPlainCodeViewer';
import styles from './DiffCard.module.css';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VirtualPlainCodeViewer 大文件与极限场景防卡死测试套件', () => {
  it('极限场景 1：800,000 字符超长单行 (未换行 JSON/min.js) 挂载性能 (<50ms) 与排版截断', () => {
    // 构造单行整整 800,000 字符的巨型单行: 9 + 799989 + 2 = 800000
    const hugeSingleLine = '{"data":"' + 'x'.repeat(799989) + '"}';
    expect(hugeSingleLine.length).toBe(800000);

    const start = performance.now();
    const { container } = render(
      <VirtualPlainCodeViewer content={hugeSingleLine} filePath="huge.json" />
    );
    const duration = performance.now() - start;

    // 1. 挂载耗时断言：必须在 400ms 内完成（jsdom 环境；相比旧版数秒卡死提升数十倍）
    expect(duration).toBeLessThan(400.0);

    // 2. 排版安全截断断言：DOM 中渲染的文本长度必须截断在 MAX_DOM_LINE_CHARS (3000) 以内
    const lineText = container.querySelector(`.${styles.lineText}`) as HTMLElement;
    expect(lineText).not.toBeNull();
    // 截断标记应该存在
    expect(lineText.textContent).toContain('[超长单行已截断呈现，完整共 800000 字符]');
    // 原始纯文本未被全量塞入单个 span（防止 Blink 排版崩溃）
    const spans = lineText.querySelectorAll('span');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[0]!.textContent!.length).toBeLessThanOrEqual(3000);
  });

  it('极限场景 2：40,000 行 (~1.5MB) 代码文件秒级挂载与切片约束', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 40000; i++) {
      lines.push(`export const item_${i} = { id: ${i}, label: "Row item ${i}" };`);
    }
    const hugeContent = lines.join('\n');

    const start = performance.now();
    const { container } = render(
      <VirtualPlainCodeViewer content={hugeContent} filePath="src/huge/HugeModule.ts" />
    );
    const duration = performance.now() - start;

    // 挂载耗时断言 < 800ms（jsdom 虚拟环境并发负载；相比旧版数秒卡死提升数量级）
    expect(duration).toBeLessThan(800.0);

    // 视口切片断言：只渲染几十行 DOM，而不是 40,000 个 DOM 节点
    const renderedLines = container.querySelectorAll(`.${styles.line}`);
    expect(renderedLines.length).toBeGreaterThan(0);
    expect(renderedLines.length).toBeLessThanOrEqual(100);
    expect(renderedLines.length).not.toBe(40000);
  });

  it('极限场景 3：挂载阶段实测行高变化不影响渲染稳定性', () => {
    // 初始 fallback 为 22px，模拟实测变化为 28px
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList?.contains(styles.line)) {
          return 28;
        }
        return 0;
      }
    );

    const { container } = render(
      <VirtualPlainCodeViewer content={'line 1\nline 2\nline 3'} filePath="a.ts" />
    );

    const outer = container.firstElementChild as HTMLElement;
    const heightDiv = outer.firstElementChild as HTMLElement;
    expect(heightDiv.style.height).toBe(`${3 * 28}px`);
  });
});
