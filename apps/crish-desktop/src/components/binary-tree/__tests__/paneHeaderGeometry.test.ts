import { describe, expect, it } from 'vitest';
import {
  computeNaturalTabWidth,
  computeCloseLockWidth,
  nextAvailableNeighborId,
  type LeafSessionTab,
} from '../paneHeaderGeometry';
import {
  TAB_WIDTH_MAX_PX,
  TAB_WIDTH_MIN_PX,
  TAB_GAP_PX,
  NON_TAB_SPACE_PX,
  CLOSE_BTN_RIGHT_OFFSET_PX,
} from '../../../utils/tabStripGeometry';

describe('paneHeaderGeometry 几何计算与关闭锁宽数学守卫', () => {
  describe('computeNaturalTabWidth 自然宽度自适应均分', () => {
    it('count 或 containerWidth 为 0 时安全回退 TAB_WIDTH_MAX_PX', () => {
      expect(computeNaturalTabWidth(0, 500)).toBe(TAB_WIDTH_MAX_PX);
      expect(computeNaturalTabWidth(3, 0)).toBe(TAB_WIDTH_MAX_PX);
      expect(computeNaturalTabWidth(-1, -100)).toBe(TAB_WIDTH_MAX_PX);
    });

    it('容器宽裕时严格锁定为标准 240px，严禁无故撑大', () => {
      // 2 个标签，每个 240，总需 2*240 + 4 = 484px；容器 1000px
      expect(computeNaturalTabWidth(2, 1000)).toBe(TAB_WIDTH_MAX_PX);
    });

    it('空间紧缩时全员严格同比例均分压缩，严禁溢出视野', () => {
      const containerWidth = 908;
      const available = containerWidth - NON_TAB_SPACE_PX; // 872px
      const count = 12;
      // fitted = floor((872 - 11*4) / 12) = floor(828 / 12) = 69px
      const expected = Math.floor((available - (count - 1) * TAB_GAP_PX) / count);
      expect(computeNaturalTabWidth(count, containerWidth)).toBe(expected);
      expect(expected).toBe(69);
      // 总占用宽度 12 * 69 + 11 * 4 = 872 <= 872，绝不溢出
      expect(count * expected + (count - 1) * TAB_GAP_PX).toBeLessThanOrEqual(available);
    });

    it('极限压迫下钳制在 TAB_WIDTH_MIN_PX (28px)', () => {
      expect(computeNaturalTabWidth(50, 200)).toBe(TAB_WIDTH_MIN_PX);
    });
  });

  describe('computeCloseLockWidth 关闭防跳与光标连击几何对齐', () => {
    it('非末尾标签关闭（分支 A）：保留当前实测宽度，使右邻标签平移补位', () => {
      const lockWidth = computeCloseLockWidth({
        isRightmost: false,
        remainingCount: 5,
        mouseXInContainer: 350,
        measuredWidth: 80,
      });
      expect(lockWidth).toBe(80);
    });

    it('末尾标签关闭且光标坐标有效（分支 B）：反推等宽让前序标签叉号对齐光标', () => {
      const remainingCount = 3;
      // 假设光标位于 350px 处
      // neededWidth = (350 + 15 - 2*4) / 3 = (357) / 3 = 119px
      const mouseX = 350;
      const expectedNeeded = Math.round(
        (mouseX + CLOSE_BTN_RIGHT_OFFSET_PX - (remainingCount - 1) * TAB_GAP_PX) / remainingCount
      );
      const lockWidth = computeCloseLockWidth({
        isRightmost: true,
        remainingCount,
        mouseXInContainer: mouseX,
        measuredWidth: 70,
      });
      expect(lockWidth).toBe(expectedNeeded);
      expect(lockWidth).toBe(119);
    });

    it('末尾标签关闭但反推值超出 240px：严格钳制在 240px，绝不强行拉伸', () => {
      const lockWidth = computeCloseLockWidth({
        isRightmost: true,
        remainingCount: 2,
        mouseXInContainer: 800, // 超大坐标
        measuredWidth: 150,
      });
      expect(lockWidth).toBe(TAB_WIDTH_MAX_PX);
    });

    it('光标坐标为 null（量测失败或边界异常）：安全回退 measuredWidth，杜绝跳变至 240px 撑爆容器', () => {
      const lockWidth = computeCloseLockWidth({
        isRightmost: true,
        remainingCount: 10,
        mouseXInContainer: null,
        measuredWidth: 65,
      });
      expect(lockWidth).toBe(65);
    });

    it('容器 maxFittingWidth 防御生效：锁宽不得超出容器极限，杜绝横向溢出与滚动', () => {
      const lockWidth = computeCloseLockWidth({
        isRightmost: true,
        remainingCount: 8,
        mouseXInContainer: 600,
        measuredWidth: 70,
        maxFittingWidth: 75, // 容器极限
      });
      expect(lockWidth).toBeLessThanOrEqual(75);
    });

    it('存活标签数为 0 时安全回退 measuredWidth', () => {
      const lockWidth = computeCloseLockWidth({
        isRightmost: true,
        remainingCount: 0,
        mouseXInContainer: 100,
        measuredWidth: 80,
      });
      expect(lockWidth).toBe(80);
    });
  });

  describe('nextAvailableNeighborId 邻居激活推导', () => {
    const tabs: LeafSessionTab[] = [
      { tabId: 't1', sessionId: 's1' },
      { tabId: 't2', sessionId: 's2' },
      { tabId: 't3', sessionId: 's3' },
    ];

    it('关闭中间标签时优先激活左邻', () => {
      expect(nextAvailableNeighborId(tabs, 't2', new Set())).toBe('t1');
    });

    it('关闭最左侧标签时激活右邻', () => {
      expect(nextAvailableNeighborId(tabs, 't1', new Set())).toBe('t2');
    });

    it('左邻已在离场集合时，正确跳过并找到下一个可用存活标签', () => {
      expect(nextAvailableNeighborId(tabs, 't2', new Set(['t1']))).toBe('t3');
    });

    it('仅剩一个标签时返回 null', () => {
      expect(nextAvailableNeighborId([tabs[0]], 't1', new Set())).toBeNull();
    });
  });
});
