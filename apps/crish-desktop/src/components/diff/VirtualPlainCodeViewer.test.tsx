// @vitest-environment jsdom
/**
 * diff/VirtualPlainCodeViewer 行高契约测试（审计 F7-F15）
 *
 * 缺陷：固定行高 20px + whiteSpace: pre-wrap 折行假设失效——
 * 长行折成多行后实际行高 > 20px，虚拟窗口 startIndex/offsetTop 错位、
 * totalHeight 偏小导致底部内容滚动不到；ui-size 缩放后行高整体漂移。
 *
 * 修复契约：
 * 1. 行文本不折行（white-space: pre + 横向滚动，与 .lineText 基类一致）——
 *    行高恒定，虚拟滚动数学保持精确；
 * 2. 行高按首行实测（offsetHeight）而非硬编码 20px——ui-size 缩放安全。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { VirtualPlainCodeViewer } from './VirtualPlainCodeViewer';
import styles from './DiffCard.module.css';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('diff/VirtualPlainCodeViewer 行高契约（F7-F15）', () => {
  it('长行不折行：行文本 white-space: pre + 横向滚动', () => {
    const { container } = render(
      <VirtualPlainCodeViewer
        content={'x'.repeat(500) + '\n短行'}
        filePath="a.ts"
      />
    );
    const lineTexts = Array.from(
      container.querySelectorAll(`.${styles.lineText}`)
    );
    expect(lineTexts.length).toBeGreaterThan(0);
    for (const el of lineTexts) {
      const styleEl = el as HTMLElement;
      expect(styleEl.style.whiteSpace).toBe('pre');
      expect(styleEl.style.overflowX).toBe('auto');
    }
  });

  it('行高按实测高度而非硬编码 20px（ui-size 缩放安全）', () => {
    // ui-size large 下首行实测 34px：精准针对应行 DOM，不污染外部容器
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList?.contains(styles.line)) {
          return 34;
        }
        return 0;
      }
    );
    const { container } = render(
      <VirtualPlainCodeViewer content={'a\nb\nc'} filePath="b.ts" />
    );
    const outer = container.firstElementChild as HTMLElement;
    // 结构：滚动容器 > 高度占位 div > pre > 行
    const heightDiv = outer.firstElementChild as HTMLElement;
    expect(heightDiv.style.height).toBe(`${3 * 34}px`);
    expect(heightDiv.style.height).not.toBe(`${3 * 20}px`);
  });
});
