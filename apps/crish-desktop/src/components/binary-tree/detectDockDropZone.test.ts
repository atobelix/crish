// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  computeDockIndicatorRect,
  computePaneDropKind,
  detectDockDropZone,
  MIN_DOCK_SPLIT_WIDTH,
  MIN_DOCK_SPLIT_HEIGHT,
  type RectLike,
} from './detectDockDropZone';

describe('detectDockDropZone 纯几何落点探测与物理硬围栏测试', () => {
  describe('物理硬围栏切断（Physical Bounding Fence）', () => {
    it('当指针超出 dockRootEl 边界时，立即短路返回 null', () => {
      const container = document.createElement('div');
      container.getBoundingClientRect = () => ({
        left: 500,
        top: 40,
        right: 900,
        bottom: 700,
        width: 400,
        height: 660,
        x: 500,
        y: 40,
        toJSON: () => {},
      });

      // 1. 指针在顶栏区域（y = 20 < top: 40）
      const dropOnTopBar = detectDockDropZone({ x: 600, y: 20 }, container, {
        sourceLeafId: 'leaf_1',
        tabId: 'tab_a',
      });
      expect(dropOnTopBar).toBeNull();

      // 2. 指针在左侧聊天会话区域（x = 300 < left: 500）
      const dropOnLeftChat = detectDockDropZone({ x: 300, y: 300 }, container, {
        sourceLeafId: 'leaf_1',
        tabId: 'tab_a',
      });
      expect(dropOnLeftChat).toBeNull();

      // 3. 指针在右侧屏幕边缘之外（x = 950 > right: 900）
      const dropOnRightOuter = detectDockDropZone(
        { x: 950, y: 300 },
        container,
        { sourceLeafId: 'leaf_1', tabId: 'tab_a' }
      );
      expect(dropOnRightOuter).toBeNull();

      // 4. 指针在底部屏幕之外（y = 750 > bottom: 700）
      const dropOnBottomOuter = detectDockDropZone(
        { x: 600, y: 750 },
        container,
        { sourceLeafId: 'leaf_1', tabId: 'tab_a' }
      );
      expect(dropOnBottomOuter).toBeNull();
    });

    it('dockRootEl 为 null 时安全返回 null', () => {
      const res = detectDockDropZone({ x: 600, y: 300 }, null, {
        sourceLeafId: 'leaf_1',
        tabId: 'tab_a',
      });
      expect(res).toBeNull();
    });
  });

  describe('几何五分法落点判定（Five-Zone Geometry）', () => {
    const standardRect: RectLike = {
      left: 100,
      top: 100,
      width: 400,
      height: 400,
    };

    it('中心 50% 区域判定为 tab-strip（合并入标签栏）', () => {
      // 窗格中心点 (300, 300) -> rx=0.5, ry=0.5
      const kind = computePaneDropKind({ x: 300, y: 300 }, standardRect);
      expect(kind).toBe('tab-strip');

      // 边缘临界内侧（rx=0.26, ry=0.5）
      const kindInner = computePaneDropKind({ x: 204, y: 300 }, standardRect);
      expect(kindInner).toBe('tab-strip');
    });

    it('左侧 25% 判定为 split-left', () => {
      // rx = 0.125 < 0.25, ry = 0.5
      const kind = computePaneDropKind({ x: 150, y: 300 }, standardRect);
      expect(kind).toBe('split-left');
    });

    it('右侧 25% 判定为 split-right', () => {
      // rx = 0.875 > 0.75, ry = 0.5
      const kind = computePaneDropKind({ x: 450, y: 300 }, standardRect);
      expect(kind).toBe('split-right');
    });

    it('顶部 25% 判定为 split-top', () => {
      // rx = 0.5, ry = 0.125 < 0.25
      const kind = computePaneDropKind({ x: 300, y: 150 }, standardRect);
      expect(kind).toBe('split-top');
    });

    it('底部 25% 判定为 split-bottom', () => {
      // rx = 0.5, ry = 0.875 > 0.75
      const kind = computePaneDropKind({ x: 300, y: 450 }, standardRect);
      expect(kind).toBe('split-bottom');
    });

    it('角落区域按照距最近边缘的轴向精准决断', () => {
      // 左上角：rx = 0.05, ry = 0.15 -> 距离左边更近，决断为 split-left
      const kindCornerLeft = computePaneDropKind(
        { x: 120, y: 160 },
        standardRect
      );
      expect(kindCornerLeft).toBe('split-left');

      // 左上角：rx = 0.15, ry = 0.05 -> 距离顶边更近，决断为 split-top
      const kindCornerTop = computePaneDropKind(
        { x: 160, y: 120 },
        standardRect
      );
      expect(kindCornerTop).toBe('split-top');
    });
  });

  describe('尺寸下限守卫（Min-Size Guard）', () => {
    it('窗格宽度 < 240px 时，禁止左右分屏，自动平滑降级为 tab-strip', () => {
      const narrowRect: RectLike = {
        left: 100,
        top: 100,
        width: 200, // < 240px
        height: 300,
      };

      // 即使落在左侧 25%（x = 110, rx = 0.05）
      const kind = computePaneDropKind({ x: 110, y: 250 }, narrowRect);
      expect(kind).toBe('tab-strip');

      // 落在右侧 25%（x = 290, rx = 0.95）
      const kindRight = computePaneDropKind({ x: 290, y: 250 }, narrowRect);
      expect(kindRight).toBe('tab-strip');
    });

    it('窗格高度 < 160px 时，禁止上下分屏，自动平滑降级为 tab-strip', () => {
      const shortRect: RectLike = {
        left: 100,
        top: 100,
        width: 300,
        height: 120, // < 160px
      };

      // 即使落在顶部 25%（y = 110, ry = 0.08）
      const kindTop = computePaneDropKind({ x: 250, y: 110 }, shortRect);
      expect(kindTop).toBe('tab-strip');

      // 落在底部 25%（y = 210, ry = 0.92）
      const kindBottom = computePaneDropKind({ x: 250, y: 210 }, shortRect);
      expect(kindBottom).toBe('tab-strip');
    });
  });

  describe('指示高亮框几何计算（computeDockIndicatorRect）', () => {
    const paneRect: RectLike = {
      left: 100,
      top: 50,
      width: 400,
      height: 300,
    };

    it('split-left 占据左半区域', () => {
      const ind = computeDockIndicatorRect('split-left', paneRect);
      expect(ind.left).toBe(102);
      expect(ind.top).toBe(52);
      expect(ind.width).toBe(400 * 0.5 - 4);
      expect(ind.height).toBe(300 - 4);
    });

    it('split-right 占据右半区域', () => {
      const ind = computeDockIndicatorRect('split-right', paneRect);
      expect(ind.left).toBe(100 + 400 * 0.5 + 2);
      expect(ind.top).toBe(52);
      expect(ind.width).toBe(400 * 0.5 - 4);
    });

    it('split-top 占据上半区域', () => {
      const ind = computeDockIndicatorRect('split-top', paneRect);
      expect(ind.top).toBe(52);
      expect(ind.height).toBe(300 * 0.5 - 4);
    });

    it('split-bottom 占据下半区域', () => {
      const ind = computeDockIndicatorRect('split-bottom', paneRect);
      expect(ind.top).toBe(50 + 300 * 0.5 + 2);
      expect(ind.height).toBe(300 * 0.5 - 4);
    });

    it('tab-strip 占据全窗格区域', () => {
      const ind = computeDockIndicatorRect('tab-strip', paneRect);
      expect(ind.left).toBe(102);
      expect(ind.top).toBe(52);
      expect(ind.width).toBe(400 - 4);
      expect(ind.height).toBe(300 - 4);
    });
  });
});
