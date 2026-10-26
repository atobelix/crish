// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  blendBackgroundChain,
  clusterLeftOffsets,
  computeVerticalGapDistribution,
  detectStutter,
  countPersistentChevrons,
  countVisibleBorderElements,
  findStutterIssues,
  runHierarchyAudit,
  registerHierarchyAuditGlobal,
} from './hierarchyAudit';
import type { RGB } from './colorUtils';

describe('hierarchyAudit 运行时层级与清晰度度量审计器', () => {
  describe('blendBackgroundChain 多层背景合成算法', () => {
    const darkFallback: RGB = { r: 20, g: 20, b: 20, a: 1 };

    it('单层不透明背景直接覆盖底板', () => {
      const chain: RGB[] = [{ r: 255, g: 0, b: 0, a: 1 }];
      const result = blendBackgroundChain(chain, darkFallback);
      expect(result).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    });

    it('单层半透明背景与暗色底板正确混合', () => {
      // 50% 白 (255, 255, 255, 0.5) 盖在 (20, 20, 20, 1) 上
      // 255 * 0.5 + 20 * 1 * 0.5 = 127.5 + 10 = 137.5 -> 138
      const chain: RGB[] = [{ r: 255, g: 255, b: 255, a: 0.5 }];
      const result = blendBackgroundChain(chain, darkFallback);
      expect(result.r).toBe(138);
      expect(result.g).toBe(138);
      expect(result.b).toBe(138);
      expect(result.a).toBe(1);
    });

    it('多层半透明背景由内至外正向累积合成', () => {
      // 祖先层：50% 纯红 (255, 0, 0, 0.5)
      // 叶子层：50% 纯蓝 (0, 0, 255, 0.5)
      // chain 顺序为 [leaf, ancestor]
      const leaf: RGB = { r: 0, g: 0, b: 255, a: 0.5 };
      const ancestor: RGB = { r: 255, g: 0, b: 0, a: 0.5 };
      const result = blendBackgroundChain([leaf, ancestor], darkFallback);

      expect(result.a).toBe(1);
      expect(result.b).toBeGreaterThan(100);
      expect(result.r).toBeGreaterThan(20);
    });

    it('空背景链直接回退到底板颜色', () => {
      const result = blendBackgroundChain([], darkFallback);
      expect(result).toEqual(darkFallback);
    });
  });

  describe('clusterLeftOffsets 左缘 2px 容差聚类算法', () => {
    it('空输入返回 0 簇', () => {
      const result = clusterLeftOffsets([]);
      expect(result.uniqueCount).toBe(0);
      expect(result.clusters).toEqual([]);
    });

    it('容差 2px 内的左缘坐标合并为单簇', () => {
      const items = [
        { left: 100.0, selector: 'row.one' },
        { left: 100.8, selector: 'row.two' },
        { left: 101.5, selector: 'row.three' },
      ];
      const result = clusterLeftOffsets(items, 2.0);
      expect(result.uniqueCount).toBe(1);
      expect(result.clusters[0].leftOffset).toBe(100);
    });

    it('超过 2px 容差的左缘坐标被划分为不同簇', () => {
      const items = [
        { left: 24.0, selector: 'user.bubble' },
        { left: 24.5, selector: 'assistant.bubble' },
        { left: 48.0, selector: 'tool.group' },
        { left: 72.0, selector: 'nested.content' },
      ];
      const result = clusterLeftOffsets(items, 2.0);
      expect(result.uniqueCount).toBe(3);
      expect(result.clusters.map((c) => c.leftOffset)).toEqual([24, 48, 72]);
    });
  });

  describe('computeVerticalGapDistribution 垂直间距比值算法', () => {
    it('正确计算簇内与块间平均间距及比值', () => {
      const groupGaps = [10, 10, 10]; // 平均 10
      const blockGaps = [25, 25, 30]; // 平均 26.7
      const result = computeVerticalGapDistribution(groupGaps, blockGaps);

      expect(result.groupGapAverage).toBe(10);
      expect(result.blockGapAverage).toBe(26.7);
      expect(result.gapRatio).toBe(2.67);
    });

    it('groupGaps 为空时安全返回 0 比值，不产生 NaN 或除零异常', () => {
      const result = computeVerticalGapDistribution([], [20]);
      expect(result.gapRatio).toBe(0);
      expect(result.groupGapAverage).toBe(0);
      expect(result.blockGapAverage).toBe(20);
    });
  });

  describe('detectStutter 字符级口吃检测', () => {
    it('检测到典型的「列出目录 crates 列出目录 crates」口吃文案', () => {
      const issue = detectStutter('列出目录 crates 列出目录 crates');
      expect(issue).toBe('列出目录 crates');
    });

    it('检测到带括号的口吃「搜索「pub async fn run」 搜索「pub async fn run」」', () => {
      const issue = detectStutter(
        '搜索「pub async fn run」 搜索「pub async fn run」'
      );
      expect(issue).toBe('搜索「pub async fn run」');
    });

    it('检测到无空格中文连续口吃「执行命令执行命令」', () => {
      const issue = detectStutter('正在执行命令执行命令中');
      expect(issue).toBe('执行命令');
    });

    it('正常文本不误报口吃', () => {
      expect(
        detectStutter('读取 src/main.rs 并写入 inventory.json')
      ).toBeNull();
      expect(detectStutter('这是一个没有口吃的正常消息回答')).toBeNull();
      expect(detectStutter('')).toBeNull();
      expect(detectStutter('ok ok')).toBeNull(); // 长度 < 6 或单词过短
    });
  });

  describe('DOM 扫描函数与 runHierarchyAudit 综合运行', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('countPersistentChevrons 正确统计折叠箭头', () => {
      const container = document.createElement('div');
      container.innerHTML = `
        <div class="chat-tool-header">
          <span class="chevron-icon">▼</span>
          <span class="title">工具详情</span>
          <span class="custom-caret">▶</span>
        </div>
      `;
      document.body.appendChild(container);

      expect(countPersistentChevrons(container)).toBe(2);
    });

    it('findStutterIssues 找出包含口吃的子节点', () => {
      const container = document.createElement('div');
      container.innerHTML = `
        <div class="chat-tool-call">
          <span class="tool-title">写入 inventory.json 写入 inventory.json</span>
        </div>
        <div class="normal-row">
          <p>正常无重复文案</p>
        </div>
      `;
      document.body.appendChild(container);

      const issues = findStutterIssues(container);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].repeatedSubstring).toContain('写入 inventory.json');
    });

    it('countVisibleBorderElements 扫描描边并排除表单控件', () => {
      const container = document.createElement('div');
      const boxWithBorder = document.createElement('div');
      boxWithBorder.className = 'card-box';
      boxWithBorder.style.border = '1px solid rgb(255, 255, 255)';
      // 模拟 getBoundingClientRect
      boxWithBorder.getBoundingClientRect = () => ({
        width: 100,
        height: 50,
        top: 0,
        left: 0,
        bottom: 50,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      const inputElement = document.createElement('input');
      inputElement.style.border = '1px solid rgb(255, 255, 255)';

      container.appendChild(boxWithBorder);
      container.appendChild(inputElement);
      document.body.appendChild(container);

      const borders = countVisibleBorderElements(container);
      // input 元素被明确排除，仅统计 card-box
      expect(borders).toBe(1);
    });

    it('runHierarchyAudit 生成完整的度量报告结构', () => {
      const container = document.createElement('div');
      container.setAttribute('data-role', 'chat-message-list');
      container.innerHTML = `
        <div class="chat-message-row">
          <p style="color: #ffffff;">你好世界</p>
        </div>
      `;
      document.body.appendChild(container);

      const report = runHierarchyAudit(container);
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('theme');
      expect(report).toHaveProperty('viewport');
      expect(report.violations).toHaveProperty('textContrastBelowThreshold');
      expect(report.violations).toHaveProperty('stutterIssues');
      expect(report.metrics).toHaveProperty('totalTextNodesAudited');
      expect(report.metrics).toHaveProperty('visibleBorderElementsCount');
      expect(report.metrics).toHaveProperty('leftEdges');
      expect(report.metrics).toHaveProperty('verticalGaps');
      expect(report.metrics).toHaveProperty('persistentChevronsCount');
    });

    it('registerHierarchyAuditGlobal 挂载 window.__CRISH_HIERARCHY_AUDIT__', () => {
      registerHierarchyAuditGlobal();
      const w = window as unknown as {
        __CRISH_HIERARCHY_AUDIT__?: typeof runHierarchyAudit;
      };
      expect(typeof w.__CRISH_HIERARCHY_AUDIT__).toBe('function');
      const res = w.__CRISH_HIERARCHY_AUDIT__!();
      expect(res).toHaveProperty('timestamp');
    });
  });
});
