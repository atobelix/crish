import { describe, expect, it } from 'vitest';
import {
  clampViewportX,
  computeDecimatedTicks,
  formatCost,
  formatPercentValue,
  formatTokens,
  getAreaSplinePath,
  getModelColor,
  getMonotoneSplinePath,
  normalizeModelRatio,
} from './usageSpline';

describe('usageSpline 纯数学与几何插值库', () => {
  describe('格式化与归一化守卫工具函数', () => {
    it('formatTokens 正确格式化各数量级数值与临界进位', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(-10)).toBe('0');
      expect(formatTokens(500)).toBe('500');
      expect(formatTokens(9999)).toBe('9,999');
      expect(formatTokens(10000)).toBe('1.00 万');
      expect(formatTokens(15800)).toBe('1.58 万');
      expect(formatTokens(1589000)).toBe('159 万');
      expect(formatTokens(99960000)).toBe('1.0 亿'); // 修复 10000 万临界进位
      expect(formatTokens(123456789)).toBe('1.2 亿');
    });

    it('formatCost 货币格式化与兜底', () => {
      expect(formatCost(0)).toBe('¥ 0.00');
      expect(formatCost(-5)).toBe('¥ 0.00');
      expect(formatCost(3.14159)).toBe('¥ 3.14');
      expect(formatCost(128.5, '$ ')).toBe('$ 128.50');
    });

    it('normalizeModelRatio 精确将百分制数值安全归一化为 0~1 比例', () => {
      expect(normalizeModelRatio(0)).toBe(0);
      expect(normalizeModelRatio(-1)).toBe(0);
      expect(normalizeModelRatio(0.5)).toBeCloseTo(0.005, 4); // 修复 0.5% 小模型被放大 100 倍 Bug
      expect(normalizeModelRatio(35.73)).toBeCloseTo(0.3573, 4);
      expect(normalizeModelRatio(100)).toBe(1.0);
      expect(normalizeModelRatio(150)).toBe(1.0);
    });

    it('formatPercentValue 百分数格式化（入参 0~100，T23 定语义）', () => {
      expect(formatPercentValue(0)).toBe('0.0%');
      expect(formatPercentValue(0.5)).toBe('0.5%'); // 0.5% 小模型
      expect(formatPercentValue(100)).toBe('100.0%');
      expect(formatPercentValue(35.73)).toBe('35.7%'); // 修复 3573.3% 暴涨 Bug
    });

    it('getModelColor 正确映射语义配色且避免撞色与索引偏置错误', () => {
      expect(getModelColor('deepseek-chat').stroke).toBe('var(--usage-color-brand)');
      expect(getModelColor('claude-3-5-sonnet').stroke).toBe('var(--usage-color-claude)');
      expect(getModelColor('minimax-abab6.5').stroke).toBe('var(--usage-color-minimax)');
      expect(getModelColor('kimi-latest').stroke).toBe('var(--usage-color-kimi)');
      expect(getModelColor('other', 4).stroke).toBe('var(--usage-color-other)');
      expect(getModelColor('__others__').stroke).toBe('var(--usage-color-other)');
      expect(getModelColor('gpt-4o').stroke).toBe('var(--usage-color-cost-total)');
      // fallbackIdx 4 映射到 other
      expect(getModelColor('unknown-custom-model', 4).stroke).toBe('var(--usage-color-other)');
    });

    it('computeDecimatedTicks 7d 完整保留 7 天日历刻度无遗漏', () => {
      const points7d = [
        { label: '08-29' },
        { label: '08-30' },
        { label: '08-31' },
        { label: '09-01' },
        { label: '09-02' },
        { label: '09-03' },
        { label: '09-04' },
      ];
      const ticks = computeDecimatedTicks(points7d, '7d');
      expect(ticks).toHaveLength(7);
      expect(ticks[0]!.label).toBe('08-29');
      expect(ticks[6]!.label).toBe('09-04');
      expect(ticks[0]!.transform).toBe('translateX(0%)');
      expect(ticks[6]!.transform).toBe('translateX(-100%)');
    });

    it('computeDecimatedTicks 24h 滑动窗口防物理叠字碰撞', () => {
      // 模拟滑动窗口：首点为 17:00，第二点为 18:00
      const pointsSliding = Array.from({ length: 24 }, (_, i) => ({
        label: `${String((17 + i) % 24).padStart(2, '0')}:00`,
      }));
      const ticks = computeDecimatedTicks(pointsSliding, '24h');
      expect(ticks.length).toBeLessThanOrEqual(5);
      // 验证任意相邻两项的 index 跨度 >= 3，物理上绝无文字叠字重叠
      for (let i = 0; i < ticks.length - 1; i++) {
        expect(ticks[i + 1]!.index - ticks[i]!.index).toBeGreaterThanOrEqual(3);
      }
      expect(ticks[0]!.transform).toBe('translateX(0%)');
      expect(ticks[ticks.length - 1]!.transform).toBe('translateX(-100%)');
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
