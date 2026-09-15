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

    // 画布宽度自愈扩容：500 字符在关闭换行模式下画布宽度必须大于 3000px，提供真实水平滚动轨道
    const canvasDiv = outer.firstElementChild as HTMLElement;
    const canvasWidthNum = parseFloat(canvasDiv.style.width);
    expect(canvasWidthNum).toBeGreaterThan(3000);

    const lineTexts = Array.from(
      container.querySelectorAll(`.${styles.lineText}`)
    );
    expect(lineTexts.length).toBeGreaterThan(0);
    for (const el of lineTexts) {
      const styleEl = el as HTMLElement;
      expect(styleEl.style.whiteSpace).toBe('pre');
      expect(styleEl.style.overflowX).toBe('hidden');
      expect(styleEl.style.overflowX).not.toBe('auto');
      expect(styleEl.style.width).toBe('max-content');
    }

    // 行号常驻左侧 sticky 契约：横向滚动时不被卷出屏幕
    const gutter = container.querySelector(`.${styles.gutterNum}`) as HTMLElement;
    expect(gutter.style.position).toBe('sticky');
    expect(gutter.style.left).toBe('0px');
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

  it('紧凑排版契约：清除多余边框与冗余边距，行号与文本保持微距视觉分离', () => {
    const { container } = render(
      <VirtualPlainCodeViewer content="console.log('compact');" filePath="d.ts" />
    );
    const line = container.querySelector(`.${styles.line}`) as HTMLElement;
    expect(line.style.borderLeftStyle).toBe('none');

    const gutter = container.querySelector(`.${styles.gutterNum}`) as HTMLElement;
    expect(gutter.style.padding).toBe('0px 3px');

    const text = container.querySelector(`.${styles.lineText}`) as HTMLElement;
    expect(text.style.padding).toBe('0px 2px 0px 6px');
  });

  it('滚动触底与尾行保障契约：画布容器杜绝 overflow: hidden 物理剪裁，行号顶端对齐', () => {
    const lines = Array.from({ length: 69 }, (_, i) => `line ${i + 1}: ${'code '.repeat(i % 5 === 0 ? 30 : 5)}`);
    const { container } = render(
      <VirtualPlainCodeViewer content={lines.join('\n')} filePath="hourly_loc.py" wordWrap={true} />
    );
    const outer = container.firstElementChild as HTMLElement;
    const canvasDiv = outer.firstElementChild as HTMLElement;

    // 1. 核心防护：画布占位容器严禁 overflow: hidden，避免物理剪切尾行内容
    expect(canvasDiv.style.overflow).not.toBe('hidden');
    expect(canvasDiv.style.overflowY).not.toBe('hidden');

    // 2. 行号对齐保护：折行情况下行号保持与首行 baseline 对齐 (flex-start)，杜绝居中沉底
    const gutter = container.querySelector(`.${styles.gutterNum}`) as HTMLElement;
    expect(gutter.style.alignItems).toBe('flex-start');

    // 3. 文本行高统一
    const text = container.querySelector(`.${styles.lineText}`) as HTMLElement;
    expect(text.style.lineHeight).toBeTruthy();
  });

  it('超长单行场景：截断提示按钮完整可交互，展开后无物理截断阻碍', () => {
    const hugeLine = '{"key":"' + 'v'.repeat(4000) + '"}';
    const { container } = render(
      <VirtualPlainCodeViewer content={hugeLine} filePath="eslint_report.json" wordWrap={true} />
    );
    const outer = container.firstElementChild as HTMLElement;
    const canvasDiv = outer.firstElementChild as HTMLElement;
    expect(canvasDiv.style.overflow).not.toBe('hidden');

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('点击展开');
  });
});
