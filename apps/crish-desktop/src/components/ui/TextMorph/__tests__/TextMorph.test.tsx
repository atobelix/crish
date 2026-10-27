// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TextMorph, toGlyphs } from '../TextMorph';
import styles from '../TextMorph.module.css';

describe('TextMorph 字形流转组件', () => {
  describe('toGlyphs 字符频次索引算法', () => {
    it('正确为相同字符分配唯一的频次索引 key', () => {
      const glyphs = toGlyphs('Running');
      expect(glyphs).toEqual([
        { char: 'R', key: 'R-0' },
        { char: 'u', key: 'u-0' },
        { char: 'n', key: 'n-0' },
        { char: 'n', key: 'n-1' },
        { char: 'i', key: 'i-0' },
        { char: 'n', key: 'n-2' },
        { char: 'g', key: 'g-0' },
      ]);
    });

    it('空字符串返回空数组', () => {
      expect(toGlyphs('')).toEqual([]);
    });
  });

  describe('DOM 渲染与可访问性 (a11y)', () => {
    it('正确渲染无障碍 srOnly 文本与 aria-hidden 尺寸外盒', () => {
      const { container } = render(<TextMorph>Thinking</TextMorph>);
      const sr = container.querySelector(`.${styles.srOnly}`);
      expect(sr).not.toBeNull();
      expect(sr?.textContent).toBe('Thinking');

      const frame = container.querySelector(`.${styles.frame}`);
      expect(frame).not.toBeNull();
      expect(frame?.getAttribute('aria-hidden')).toBe('true');
    });

    it('空格字符被保活为不换行空格 (\u00a0)', () => {
      const { container } = render(<TextMorph>Running Tool</TextMorph>);
      const spaceGlyph = container.querySelector('[data-key=" -0"]');
      expect(spaceGlyph).not.toBeNull();
      expect(spaceGlyph?.textContent).toBe('\u00a0');
    });

    it('支持自定义 as 标签与 className / id', () => {
      const { container } = render(
        <TextMorph as="div" id="morph-test" className="custom-class">
          Status
        </TextMorph>
      );
      const root = container.querySelector('#morph-test');
      expect(root).not.toBeNull();
      expect(root?.tagName.toLowerCase()).toBe('div');
      expect(root?.classList.contains('custom-class')).toBe(true);
    });
  });

  describe('字形流转与节点保留 (DOM Stability)', () => {
    it('字符变更时共有字符稳定复用唯一频次 key', () => {
      const { rerender, container } = render(<TextMorph>Publishing</TextMorph>);
      const initialGlyphs = Array.from(
        container.querySelectorAll('[data-key]')
      );
      const initialKeys = initialGlyphs.map((g) => g.getAttribute('data-key'));

      // Publishing 共有字符 P, u, b, l, i, s, h
      expect(initialKeys).toContain('P-0');
      expect(initialKeys).toContain('u-0');
      expect(initialKeys).toContain('b-0');
      expect(initialKeys).toContain('l-0');
      expect(initialKeys).toContain('i-0');
      expect(initialKeys).toContain('s-0');
      expect(initialKeys).toContain('h-0');

      rerender(<TextMorph>Published</TextMorph>);

      const nextGlyphs = Array.from(container.querySelectorAll('[data-key]'));
      const nextKeys = nextGlyphs.map((g) => g.getAttribute('data-key'));

      // 验证共有字符的 key 保持一致
      expect(nextKeys).toContain('P-0');
      expect(nextKeys).toContain('u-0');
      expect(nextKeys).toContain('b-0');
      expect(nextKeys).toContain('l-0');
      expect(nextKeys).toContain('i-0');
      expect(nextKeys).toContain('s-0');
      expect(nextKeys).toContain('h-0');
      // 验证新增字符 e, d
      expect(nextKeys).toContain('e-0');
      expect(nextKeys).toContain('d-0');
      // 验证完整文本在容器内包含
      expect(container.textContent).toContain('Published');
    });
  });
});
