import { describe, expect, it } from 'vitest';
import {
  layoutStack,
  rubberBand,
  projectVelocity,
  STACK_CONSTANTS,
} from '../toastStackMath';

describe('toastStackMath 几何堆叠与手势物理纯函数测试', () => {
  const { PEEK, GAP, STEP, DEFAULT_HEIGHT } = STACK_CONSTANTS;

  describe('layoutStack', () => {
    it('空通知队列时返回空 targets 与 0 高度', () => {
      const result = layoutStack([], {}, false);
      expect(result.targets).toEqual([]);
      expect(result.listHeight).toBe(0);
    });

    it('单条通知时折叠态与展开态尺寸正确', () => {
      const toasts = [{ id: 't1' }];
      const heights = { t1: 64 };

      // 折叠态 (顶部)
      const collapsed = layoutStack(toasts, heights, false, 3, true);
      expect(collapsed.targets).toHaveLength(1);
      expect(collapsed.targets[0]).toEqual({
        y: 0,
        scale: 1,
        height: 64,
        opacity: 1,
        content: 1,
        origin: '50% 0',
      });
      expect(collapsed.listHeight).toBe(64);

      // 展开态 (顶部)
      const expanded = layoutStack(toasts, heights, true, 3, true);
      expect(expanded.targets).toHaveLength(1);
      expect(expanded.targets[0]).toEqual({
        y: 0,
        scale: 1,
        height: 64,
        opacity: 1,
        content: 1,
        origin: '50% 50%',
      });
      expect(expanded.listHeight).toBe(64);
    });

    it('折叠态（顶部锚定）：后排卡片高度归一化、内容遮蔽、露头偏移与递进缩放', () => {
      const toasts = [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }];
      // 首张卡片高度为 60，后续即使高度不同，折叠时也统一归一化为 60
      const heights = { t1: 60, t2: 80, t3: 100, t4: 50 };

      const res = layoutStack(toasts, heights, false, 3, true);
      expect(res.targets).toHaveLength(4);

      // 首张卡片 (index 0)
      expect(res.targets[0]).toEqual({
        y: 0,
        scale: 1,
        height: 60,
        opacity: 1,
        content: 1,
        origin: '50% 0',
      });

      // 第二张卡片 (index 1)
      expect(res.targets[1]).toEqual({
        y: PEEK * 1, // 14px
        scale: 1 - STEP * 1, // 0.95
        height: 60, // 强制归一化为 frontHeight
        opacity: 1,
        content: 0, // 内容完全遮蔽杜绝透字
        origin: '50% 0',
      });

      // 第三张卡片 (index 2)
      expect(res.targets[2]).toEqual({
        y: PEEK * 2, // 28px
        scale: 1 - STEP * 2, // 0.90
        height: 60, // 强制归一化为 frontHeight
        opacity: 1,
        content: 0,
        origin: '50% 0',
      });

      // 第四张卡片 (index 3 >= visibleToasts=3)，不可见
      expect(res.targets[3]).toEqual({
        y: PEEK * 3, // depth 为 min(3, 3) = 3
        scale: 1 - STEP * 3, // 0.85
        height: 60,
        opacity: 0,
        content: 0,
        origin: '50% 0',
      });

      // 连续外框高度: frontHeight + PEEK * (visibleCount - 1) = 60 + 14 * 2 = 88
      expect(res.listHeight).toBe(60 + PEEK * 2);
    });

    it('折叠态（底部锚定）：负向偏移与 50% 100% 变换原点', () => {
      const toasts = [{ id: 't1' }, { id: 't2' }];
      const heights = { t1: 50, t2: 50 };

      const res = layoutStack(toasts, heights, false, 3, false);
      expect(res.targets[0]!.y).toBe(0);
      expect(res.targets[0]!.origin).toBe('50% 100%');
      expect(res.targets[1]!.y).toBe(-PEEK);
      expect(res.targets[1]!.origin).toBe('50% 100%');
      expect(res.listHeight).toBe(50 + PEEK);
    });

    it('展开态（顶部锚定）：各卡片保留独立高度、正向累加 offset、内容全显示', () => {
      const toasts = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
      const heights = { t1: 50, t2: 70, t3: 90 };

      const res = layoutStack(toasts, heights, true, 3, true);
      expect(res.targets).toHaveLength(3);

      // t1: y = 0
      expect(res.targets[0]).toEqual({
        y: 0,
        scale: 1,
        height: 50,
        opacity: 1,
        content: 1,
        origin: '50% 50%',
      });

      // t2: y = 50 + 12 = 62
      expect(res.targets[1]).toEqual({
        y: 50 + GAP,
        scale: 1,
        height: 70,
        opacity: 1,
        content: 1,
        origin: '50% 50%',
      });

      // t3: y = (50 + 12) + (70 + 12) = 144
      expect(res.targets[2]).toEqual({
        y: 50 + GAP + 70 + GAP,
        scale: 1,
        height: 90,
        opacity: 1,
        content: 1,
        origin: '50% 50%',
      });

      // listHeight = 50 + 70 + 90 + 2 * GAP = 234
      expect(res.listHeight).toBe(50 + 70 + 90 + 2 * GAP);
    });

    it('展开态（底部锚定）：负向累加 offset', () => {
      const toasts = [{ id: 't1' }, { id: 't2' }];
      const heights = { t1: 50, t2: 60 };

      const res = layoutStack(toasts, heights, true, 3, false);
      expect(res.targets[0]!.y).toBe(0);
      expect(res.targets[1]!.y).toBe(-(50 + GAP));
      expect(res.listHeight).toBe(50 + 60 + GAP);
    });

    it('实测高度缺失时平滑回退至 DEFAULT_HEIGHT (48)', () => {
      const toasts = [{ id: 'missing-1' }, { id: 'missing-2' }];
      const res = layoutStack(toasts, {}, false, 3, true);
      expect(res.targets[0]!.height).toBe(DEFAULT_HEIGHT);
      expect(res.targets[1]!.height).toBe(DEFAULT_HEIGHT);
      expect(res.listHeight).toBe(DEFAULT_HEIGHT + PEEK);
    });
  });

  describe('rubberBand', () => {
    it('distance <= 0 或 dimension <= 0 返回 0', () => {
      expect(rubberBand(0, 380)).toBe(0);
      expect(rubberBand(-20, 380)).toBe(0);
      expect(rubberBand(50, 0)).toBe(0);
      expect(rubberBand(50, -100)).toBe(0);
    });

    it('返回严格单调且低于原始 distance 的阻尼位移', () => {
      const width = 380;
      const d1 = rubberBand(40, width);
      const d2 = rubberBand(80, width);
      const d3 = rubberBand(120, width);

      expect(d1).toBeGreaterThan(0);
      expect(d1).toBeLessThan(40);
      expect(d2).toBeGreaterThan(d1);
      expect(d2).toBeLessThan(80);
      expect(d3).toBeGreaterThan(d2);
      expect(d3).toBeLessThan(120);

      // 增量衰减 (等步长增量测试: 凹函数导数递减)
      const delta1 = d2 - d1; // 40 -> 80
      const delta2 = d3 - d2; // 80 -> 120
      expect(delta1).toBeGreaterThan(delta2);
    });

    it('无限拉扯时收敛于容器尺寸 (渐近饱和)', () => {
      const width = 380;
      const hugePull = rubberBand(100_000, width);
      expect(hugePull).toBeLessThan(width);
      expect(hugePull).toBeGreaterThan(width * 0.99);
    });
  });

  describe('projectVelocity', () => {
    it('速度为 0 时投影距离为 0', () => {
      expect(projectVelocity(0)).toBe(0);
    });

    it('根据指数摩擦阻尼模型准确投影自然滑行距离', () => {
      // 速度 1000 px/s: (1000 / 1000) * (0.99 / 0.01) = 99 px
      expect(projectVelocity(1000)).toBeCloseTo(99, 4);

      // 速度 500 px/s: 49.5 px
      expect(projectVelocity(500)).toBeCloseTo(49.5, 4);

      // 反向速度 -1200 px/s: -118.8 px
      expect(projectVelocity(-1200)).toBeCloseTo(-118.8, 4);
    });
  });
});
