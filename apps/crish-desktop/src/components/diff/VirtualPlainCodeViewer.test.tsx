// @vitest-environment jsdom
/**
 * diff/VirtualPlainCodeViewer 换行与行高契约测试
 *
 * 重构契约：
 * 1. 默认开启自动换行（wordWrap = true）：
 *    行文本 white-space: pre-wrap + break-word，单行严禁出现独立滚动条（overflow-x: hidden）；
 * 2. 关闭自动换行（wordWrap = false）：
 *    行文本 white-space: pre，单行依然严禁独立滚动条，横向滚动由外部容器统一接管（overflow-x: auto）；
 * 3. 行高按实测高度动态适配（ui-size 缩放安全）；
 * 4. 动态折行高度推算：长行折行后能准确定位视口高度，触底完整可达。
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

describe('diff/VirtualPlainCodeViewer 换行与行高契约', () => {
  it('默认自动换行：行文本 white-space: pre-wrap，杜绝单行独立横向滚动条', () => {
    const { container } = render(
      <VirtualPlainCodeViewer
        content={'x'.repeat(500) + '\n短行'}
        filePath="a.ts"
      />
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.overflowX).toBe('hidden');

    const lineTexts = Array.from(
      container.querySelectorAll(`.${styles.lineText}`)
    );
    expect(lineTexts.length).toBeGreaterThan(0);
    for (const el of lineTexts) {
      const styleEl = el as HTMLElement;
      expect(styleEl.style.whiteSpace).toBe('pre-wrap');
      expect(styleEl.style.overflowX).toBe('hidden');
      expect(styleEl.style.overflowX).not.toBe('auto');
    }
  });

  it('关闭自动换行：行文本 white-space: pre，外部容器接管横向滚动，单行仍无独立滚动条', () => {
    const { container } = render(
      <VirtualPlainCodeViewer
        content={'x'.repeat(500) + '\n短行'}
        filePath="a.ts"
        wordWrap={false}
      />
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.style.overflowX).toBe('auto');

    const lineTexts = Array.from(
      container.querySelectorAll(`.${styles.lineText}`)
    );
    expect(lineTexts.length).toBeGreaterThan(0);
    for (const el of lineTexts) {
      const styleEl = el as HTMLElement;
      expect(styleEl.style.whiteSpace).toBe('pre');
      expect(styleEl.style.overflowX).toBe('hidden');
      expect(styleEl.style.overflowX).not.toBe('auto');
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

  it('折行高度动态估算：超长行在换行模式下参与总高度累加', () => {
    const longLine = 'a'.repeat(800);
    const { container } = render(
      <VirtualPlainCodeViewer content={`${longLine}\nb`} filePath="c.ts" wordWrap={true} />
    );
    const outer = container.firstElementChild as HTMLElement;
    const heightDiv = outer.firstElementChild as HTMLElement;
    const parsedHeight = parseFloat(heightDiv.style.height);
    // 800 字符长行按 ~80 字符/行计算折成多行，总高度远大于 2 * 22px
    expect(parsedHeight).toBeGreaterThan(2 * 22);
  });
});

