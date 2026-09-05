/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HeightOracle, classifyLine } from '../../src/core/HeightMap';
import { getCoordinatesFromIndex } from '../../src/core/measure';

const INDEX_CSS = fs.readFileSync(path.resolve(__dirname, '../../src/index.css'), 'utf-8');

describe('几何守恒与双层无盲区测量系统核心契约 (Geometric Invariance)', () => {
  describe('支柱 1: IFC 行盒垂直几何守恒契约', () => {
    it('interactive-checkbox 绝不包含 vertical-align: sub，高度严格锁定为 --grid-size', () => {
      const match = INDEX_CSS.match(/\.interactive-checkbox\s*\{([^}]+)\}/);
      expect(match).toBeTruthy();
      const body = match![1];
      expect(body).not.toContain('vertical-align: sub');
      expect(body).toContain('height: var(--grid-size)');
      expect(body).toContain('vertical-align: top');
      expect(body).toContain('align-items: center');
    });

    it('task-checkbox-wrapper 绝不包含硬编码 translateY(-1px)，宽度等宽锁定为 5ch', () => {
      const match = INDEX_CSS.match(/\.task-checkbox-wrapper\s*\{([^}]+)\}/);
      expect(match).toBeTruthy();
      const body = match![1];
      expect(body).not.toContain('transform: translateY(-1px)');
      expect(body).toContain('width: 5ch');
      expect(body).toContain('align-items: center');
      expect(body).toContain('justify-content: center');
    });

    it('style-sub / style-sup / style-footnote 采用 line-height: 0 隔离，禁止撑大 IFC 包含块', () => {
      const subMatch = INDEX_CSS.match(/\.style-sub\s*\{([^}]+)\}/);
      expect(subMatch).toBeTruthy();
      expect(subMatch![1]).toContain('line-height: 0 !important');
      expect(subMatch![1]).toContain('vertical-align: baseline !important');

      const supMatch = INDEX_CSS.match(/\.style-sup[^{]*\{([^}]+)\}/);
      expect(supMatch).toBeTruthy();
      expect(supMatch![1]).toContain('line-height: 0 !important');
      expect(supMatch![1]).toContain('vertical-align: baseline !important');
    });

    it('style-inline-code 与 style-mark 垂直 padding 归零，杜绝亚像素外溢', () => {
      const codeMatch = INDEX_CSS.match(/\.style-inline-code\s*\{([^}]+)\}/);
      expect(codeMatch).toBeTruthy();
      expect(codeMatch![1]).toMatch(/padding:\s*0\s+5px/);

      const markMatch = INDEX_CSS.match(/\.style-mark\s*\{([^}]+)\}/);
      expect(markMatch).toBeTruthy();
      expect(markMatch![1]).toMatch(/padding:\s*0\s+4px/);
    });
  });

  describe('支柱 2: 等宽槽位与幽灵字符流契约', () => {
    it('已定义 task-slot-container / ghost-token-stream / visual-overlay-widget', () => {
      expect(INDEX_CSS).toContain('.task-slot-container');
      expect(INDEX_CSS).toContain('.ghost-token-stream');
      expect(INDEX_CSS).toContain('.visual-overlay-widget');
    });

    it('任务项视觉占宽 (5ch + 1ch task-space = 6ch) 与源码 - [ ] (6ch) 绝对等宽，ΔX ≡ 0', () => {
      const wrapperMatch = INDEX_CSS.match(/\.task-checkbox-wrapper\s*\{([^}]+)\}/);
      const spaceMatch = INDEX_CSS.match(/\.task-space\s*\{([^}]+)\}/);
      expect(wrapperMatch![1]).toContain('width: 5ch');
      expect(spaceMatch![1]).toContain('width: 1ch');
      const sourceTaskMarkerLen = '- [ ] '.length;
      expect(sourceTaskMarkerLen).toBe(6);
      expect(5 + 1).toBe(sourceTaskMarkerLen);
    });
  });

  describe('支柱 3: 双层无盲区光标投影与行首退化消除契约', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      document.body.innerHTML = '';
      container = document.createElement('div');
      container.className = 'editor-scroll-container';
      document.body.appendChild(container);
    });

    it('复合部件在 Range 测量返回 0x0 时，平滑走 Tier 2 盒模型比例线性插值，绝对不返回 null', () => {
      const row = document.createElement('div');
      row.setAttribute('data-line-start', '100');
      row.setAttribute('data-line-length', '20');
      container.appendChild(row);

      const tokenEl = document.createElement('span');
      tokenEl.setAttribute('data-token-start', '100');
      tokenEl.setAttribute('data-token-length', '6');
      tokenEl.className = 'interactive-checkbox token-list-task';
      row.appendChild(tokenEl);

      tokenEl.getBoundingClientRect = () => ({
        left: 50,
        top: 200,
        right: 96.2,
        bottom: 228,
        width: 46.2,
        height: 28,
        x: 50,
        y: 200,
        toJSON: () => {},
      });

      row.getBoundingClientRect = () => ({
        left: 50,
        top: 200,
        right: 500,
        bottom: 228,
        width: 450,
        height: 28,
        x: 50,
        y: 200,
        toJSON: () => {},
      });

      container.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      const r0 = getCoordinatesFromIndex(100, container);
      expect(r0).not.toBeNull();
      expect(r0!.left).toBeCloseTo(50, 1);

      const r3 = getCoordinatesFromIndex(103, container);
      expect(r3).not.toBeNull();
      expect(r3!.left).toBeCloseTo(50 + 0.5 * 46.2, 1);

      const r6 = getCoordinatesFromIndex(106, container);
      expect(r6).not.toBeNull();
      expect(r6!.left).toBeCloseTo(96.2, 1);
    });

    it('行尾且超出已挂载 token 时，光标锚定于末尾 token 的 right 边缘，绝对不退化到 line.left', () => {
      const row = document.createElement('div');
      row.setAttribute('data-line-start', '100');
      row.setAttribute('data-line-length', '25');
      container.appendChild(row);

      const tokenEl = document.createElement('span');
      tokenEl.setAttribute('data-token-start', '100');
      tokenEl.setAttribute('data-token-length', '20');
      row.appendChild(tokenEl);

      tokenEl.getBoundingClientRect = () => ({
        left: 30,
        top: 100,
        right: 230,
        bottom: 128,
        width: 200,
        height: 28,
        x: 30,
        y: 100,
        toJSON: () => {},
      });

      row.getBoundingClientRect = () => ({
        left: 30,
        top: 100,
        right: 600,
        bottom: 128,
        width: 570,
        height: 28,
        x: 30,
        y: 100,
        toJSON: () => {},
      });

      const rEnd = getCoordinatesFromIndex(125, container);
      expect(rEnd).not.toBeNull();
      expect(rEnd!.left).toBeCloseTo(230, 1);
    });
  });

  describe('支柱 4: HeightMap 自适应特征预测模型契约', () => {
    it('标题行基准预测倍率严格为 1.0 (28px 网格绝对锁定，消除 8.4px 塌陷)', () => {
      const oracle = new HeightOracle();
      const kind = classifyLine('# 标题测试', false);
      expect(kind).toBe('heading');
      const pred = oracle.predict('heading', '# 标题测试', false);
      expect(pred).toBe(28);
    });

    it('含分式或大结构的独立数学公式块，预留充足高度 (>=84px)，消除滚入 55px 巨跳', () => {
      const oracle = new HeightOracle();
      const fracMath = '$$\\frac{a}{b}$$';
      const kind = classifyLine(fracMath, 'math_block');
      expect(kind).toBe('math');
      const predFrac = oracle.predict('math', fracMath, 'math_block');
      expect(predFrac).toBeGreaterThanOrEqual(84);
    });
  });
});
