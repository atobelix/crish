/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HeightOracle, classifyLine } from '../../src/core/HeightMap';
import { TEST_LAYOUT_MEASUREMENTS } from './helpers/layout-metrics-data';
import { getCoordinatesFromIndex, getDOMPointFromIndex, disposeContainerMeasurementCache } from '../../src/core/measure';

const INDEX_CSS = fs.readFileSync(path.resolve(__dirname, '../../src/index.css'), 'utf-8');
const LIST_CSS = fs.readFileSync(path.resolve(__dirname, '../../src/styles/list-indent.css'), 'utf-8');
const ENTRY = fs.readFileSync(path.resolve(__dirname, '../../src/main.tsx'), 'utf-8');
const EDITOR_CSS = INDEX_CSS + '\n' + LIST_CSS;

function rule(pattern: RegExp): string {
  const match = EDITOR_CSS.match(pattern);
  expect(match).toBeTruthy();
  return match![1];
}

/**
 * 原10个案例全部保留其问题域。旧槽宽字面量改为实际设计令牌，
 * 旧“Range失败必须比例插值”改为只允许真实编辑面或原子两端。
 * 逐条映射记于01-geometry审计报告；不减少验证维度。
 */
describe('几何守恒与原生源码投影契约', () => {
  describe('行盒与内容样式', () => {
    it('interactive-checkbox 不使用 vertical-align:sub，并服从实际行高令牌', () => {
      const body = rule(/\.interactive-checkbox\s*\{([^}]+)\}/);
      expect(body).not.toContain('vertical-align: sub');
      expect(body).toContain('height: var(--grid-size)');
      expect(body).toContain('vertical-align: top');
      expect(body).toContain('align-items: center');
    });

    it('任务控件不做像素偏移补偿，其占宽由统一标记槽拥有', () => {
      const body = rule(/\.task-checkbox-wrapper\s*\{([^}]+)\}/);
      expect(body).not.toContain('transform: translateY(-1px)');
      expect(body).not.toMatch(/(?:^|;)\s*width:\s*\d+(?:em|ch|px)/);
      expect(body).toContain('align-items: center');
      expect(body).toContain('justify-content: center');
      const slot = rule(/\.list-marker-slot\s*\{([^}]+)\}/);
      expect(slot).toContain('width: var(--marker-slot)');
      expect(slot).toContain('margin-inline-end: var(--marker-gap)');
    });

    it('style-sub/style-sup/style-footnote 不撑大所属行盒', () => {
      const sub = rule(/\.style-sub\s*\{([^}]+)\}/);
      expect(sub).toContain('line-height: 0 !important');
      expect(sub).toContain('vertical-align: baseline !important');
      const sup = rule(/\.style-sup[^{]*\{([^}]+)\}/);
      expect(sup).toContain('line-height: 0 !important');
      expect(sup).toContain('vertical-align: baseline !important');
    });

    it('style-inline-code 与 style-mark 的垂直内距归零', () => {
      expect(rule(/\.style-inline-code\s*\{([^}]+)\}/)).toMatch(/padding:\s*0\s+5px/);
      expect(rule(/\.style-mark\s*\{([^}]+)\}/)).toMatch(/padding:\s*0\s+4px/);
    });
  });

  describe('统一标记槽与真实样式入口', () => {
    it('标记源与预览层处于统一槽内，且样式文件确实接入应用入口', () => {
      expect(LIST_CSS).toContain('.list-marker-slot');
      expect(LIST_CSS).toContain('.marker-source');
      expect(LIST_CSS).toContain('.marker-visual');
      const imported = /(?:^|\n)\s*import\s+['"]\.\/styles\/list-indent\.css['"]/.test(ENTRY) ||
        /(?:^|\n)\s*@import\s+['"]\.\/styles\/list-indent\.css['"]/.test(INDEX_CSS);
      expect(imported, '不能只读取未被应用导入的样式而让门禁通过').toBe(true);
    });

    it('三种列表标记共享设计令牌，槽宽不依赖任务文本或序号类型', () => {
      const slot = rule(/\.list-marker-slot\s*\{([^}]+)\}/);
      expect(slot).toContain('width: var(--marker-slot)');
      expect(slot).toContain('height: var(--grid-size)');
      expect(LIST_CSS).toMatch(/\.token-list-bullet,\s*\.token-list-number,\s*\.token-list-task/);
      expect(INDEX_CSS).toMatch(/--marker-slot:\s*[^;]+;/);
      expect(INDEX_CSS).toMatch(/--marker-gap:\s*[^;]+;/);
      expect(INDEX_CSS).toMatch(/--indent-unit:\s*[^;]+;/);
    });
  });

  describe('可测编辑面与原子边界', () => {
    let container: HTMLDivElement;
    let originalRect: PropertyDescriptor | undefined;
    let textRects: WeakMap<Node, (offset: number) => DOMRect>;

    beforeEach(() => {
      document.body.innerHTML = '';
      container = document.createElement('div');
      container.className = 'editor-scroll-container';
      container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
      document.body.appendChild(container);
      textRects = new WeakMap();
      originalRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value(this: Range) {
        const textRect = textRects.get(this.startContainer);
        if (textRect) return textRect(this.startOffset);
        if (!this.collapsed && this.startContainer === this.endContainer && this.endOffset === this.startOffset + 1) {
          const selected = this.startContainer.childNodes[this.startOffset];
          if (selected?.nodeType === 1) return (selected as Element).getBoundingClientRect();
        }
        return new DOMRect();
      } });
    });

    afterEach(() => {
      disposeContainerMeasurementCache(container);
      if (originalRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRect);
      else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
      document.body.innerHTML = '';
    });

    it('Range 无编辑文本时不得比例插值；明确的原子控件仅有前后两端', () => {
      const row = document.createElement('div');
      row.dataset.lineStart = '100';
      row.dataset.lineLength = '20';
      row.getBoundingClientRect = () => new DOMRect(50, 200, 450, 28);
      container.appendChild(row);
      const token = document.createElement('span');
      token.dataset.tokenStart = '100';
      token.dataset.tokenLength = '6';
      token.className = 'interactive-checkbox token-list-task';
      token.getBoundingClientRect = () => new DOMRect(50, 200, 46.2, 28);
      row.appendChild(token);

      for (const index of [100, 103, 106]) expect(getCoordinatesFromIndex(index, container)).toBeNull();
      token.dataset.sourceRole = 'atomic';
      expect(getCoordinatesFromIndex(100, container)?.left).toBe(50);
      expect(getCoordinatesFromIndex(103, container, 'backward')?.left).toBe(50);
      expect(getCoordinatesFromIndex(103, container, 'forward')?.left).toBeCloseTo(96.2, 6);
      expect(getCoordinatesFromIndex(106, container)?.left).toBeCloseTo(96.2, 6);
    });

    it('行尾没有文本时不能凭 token.right 定位；真实尾部 Range 提供精确边界', () => {
      const row = document.createElement('div');
      row.dataset.lineStart = '100';
      row.dataset.lineLength = '25';
      row.getBoundingClientRect = () => new DOMRect(30, 100, 570, 28);
      container.appendChild(row);
      const token = document.createElement('span');
      token.dataset.tokenStart = '100';
      token.dataset.tokenLength = '20';
      token.getBoundingClientRect = () => new DOMRect(30, 100, 200, 28);
      row.appendChild(token);
      expect(getCoordinatesFromIndex(125, container)).toBeNull();

      const text = document.createTextNode('abcdefghijklmnopqrst');
      token.appendChild(text);
      textRects.set(text, offset => new DOMRect(30 + offset * 10, 100, 0, 20));
      const end = getCoordinatesFromIndex(125, container)!;
      expect(end.left).toBe(230);
      expect(end.height).toBe(20);
      expect(getDOMPointFromIndex(125, container)?.offset).toBe(20);
    });

    it('有效 Range 的非等宽与非单调坐标原样保留', () => {
      const token = document.createElement('span');
      token.dataset.tokenStart = '0';
      token.dataset.tokenLength = '3';
      token.textContent = 'אab';
      container.appendChild(token);
      textRects.set(token.firstChild!, offset => new DOMRect([80, 60, 70, 90][offset], 7.25, 0, 18.5));
      expect(getCoordinatesFromIndex(1, container)).toEqual({ left: 60, top: 7.25, height: 18.5, bottom: 25.75 });
      expect(getCoordinatesFromIndex(2, container)?.left).toBe(70);
    });
  });

  describe('行高预测消费实际度量', () => {
    it('标题基准行高与实际行高一致，不重复写死28px', () => {
      const oracle = new HeightOracle({ ...TEST_LAYOUT_MEASUREMENTS, lineHeight: 36 });
      expect(classifyLine('# 标题测试', false)).toBe('heading');
      expect(oracle.predict('heading', '# 标题测试', false)).toBe(oracle.lineHeight);
    });

    it('含大结构公式预留完整的多行空间，跟随实际行高', () => {
      const oracle = new HeightOracle({ ...TEST_LAYOUT_MEASUREMENTS, lineHeight: 36 });
      const formula = '$$\\frac{a}{b}$$';
      expect(classifyLine(formula, 'math_block')).toBe('math');
      expect(oracle.predict('math', formula, 'math_block')).toBeGreaterThanOrEqual(oracle.lineHeight * 3);
    });
  });
});
