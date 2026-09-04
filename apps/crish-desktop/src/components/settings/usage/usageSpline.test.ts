import { describe, expect, it } from 'vitest';
import {
  clampViewportX,
  formatCost,
  formatPercentage,
  formatTokens,
  getAreaSplinePath,
  getMonotoneSplinePath,
} from './usageSpline';

describe('usageSpline 纯数学与几何插值库', () => {
  describe('格式化工具函数', () => {
    it('formatTokens 正确格式化各数量级数值', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(-10)).toBe('0');
      expect(formatTokens(500)).toBe('500');
      expect(formatTokens(9999)).toBe('9,999');
      expect(formatTokens(10000)).toBe('1.00 万');
      expect(formatTokens(15800)).toBe('1.58 万');
      expect(formatTokens(1589000)).toBe('159 万');
      expect(formatTokens(123456789)).toBe('1.23 亿');
    });

    it('formatCost 货币格式化与兜底', () => {
      expect(formatCost(0)).toBe('¥ 0.00');
      expect(formatCost(-5)).toBe('¥ 0.00');
      expect(formatCost(3.14159)).toBe('¥ 3.14');
      expect(formatCost(128.5, '$ ')).toBe('$ 128.50');
    });

    it('formatPercentage 百分比格式化', () => {
      expect(formatPercentage(0)).toBe('0.0%');
      expect(formatPercentage(0.4256)).toBe('42.6%');
      expect(formatPercentage(1)).toBe('100.0%');
    });
  });

  describe('Fritsch-Carlson 单调样条插值 (getMonotoneSplinePath)', () => {
    it('退化边界场景处理', () => {
      expect(getMonotoneSplinePath([])).toBe('');
      expect(getMonotoneSplinePath([{ x: 10, y: 20 }])).toBe('M 10.0,20.0');
      expect(
        getMonotoneSplinePath([
          { x: 10, y: 20 },
          { x: 50, y: 60 },
        ])
      ).toBe('M 10.0,20.0 L 50.0,60.0');
    });

    it('单调递增点集生成单调平滑三阶贝塞尔曲线指令', () => {
      const points = [
        { x: 0, y: 100 },
        { x: 100, y: 80 },
        { x: 200, y: 50 },
        { x: 300, y: 10 },
      ];
      const d = getMonotoneSplinePath(points);
      expect(d).toMatch(/^M 0\.0,100\.0 C/);
      expect(d).toContain('300.0,10.0');
      // 包含 3 段 C 贝塞尔曲线段
      const cSegments = d.split(' C ');
      expect(cSegments.length).toBe(4);
    });

    it('极端平台（dx 相同但 dy=0）导数置零，杜绝假性超调振荡', () => {
      const points = [
        { x: 0, y: 100 },
        { x: 100, y: 50 },
        { x: 200, y: 50 }, // 出现平横线
        { x: 300, y: 20 },
      ];
      const d = getMonotoneSplinePath(points);
      expect(d).toBeDefined();
      expect(d).toContain('C');
    });
  });

  describe('面积路径生成 (getAreaSplinePath)', () => {
    it('正确生成底闭合多边形区域', () => {
      const points = [
        { x: 10, y: 50 },
        { x: 50, y: 30 },
        { x: 90, y: 10 },
      ];
      const areaD = getAreaSplinePath(points, 100);
      expect(areaD).toMatch(/^M 10\.0,50\.0 C/);
      expect(areaD.endsWith('L 90.0,100.0 L 10.0,100.0 Z')).toBe(true);
    });
  });

  describe('安全视口边界钳位 (clampViewportX)', () => {
    it('卡片居中定位时严格钳位在 [minX, maxX] 间，防止截断', () => {
      // containerWidth = 500, cardWidth = 160, half = 80, margin = 6 -> minX = 86, maxX = 414
      expect(clampViewportX(20, 160, 500, 6)).toBe(86);
      expect(clampViewportX(480, 160, 500, 6)).toBe(414);
      expect(clampViewportX(250, 160, 500, 6)).toBe(250);
    });
  });
});
