// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  measureCursorLineBox,
  isValidClientRect,
  isPhysicallyVisibleNonZeroRect,
  isAnchorInsideVisibleField,
  computeViewportEdgeAlignment,
  calculateSafeCursorAnchor,
} from './safeCursorAnchor';

describe('safeCursorAnchor 几何探测器防漂移测试 (DIM-06)', () => {
  describe('measureCursorLineBox 物理行高包围盒', () => {
    it('应当构建包含真实行高的 LineBox DOMRect', () => {
      const mockView = {
        coordsAtPos: vi.fn().mockReturnValue({
          top: 300,
          bottom: 322,
          left: 150,
          right: 152,
        }),
      };

      const rect = measureCursorLineBox(mockView as any, 10, 1);
      expect(rect.top).toBe(300);
      expect(rect.bottom).toBe(322);
      expect(rect.height).toBe(22);
      expect(rect.left).toBe(150);
      expect(rect.width).toBe(2);
    });

    it('对 null 或无 coordsAtPos 视图安全返回全零 DOMRect', () => {
      const r1 = measureCursorLineBox(null, 0);
      expect(r1.width).toBe(0);
      expect(r1.height).toBe(0);

      const r2 = measureCursorLineBox({} as any, 0);
      expect(r2.width).toBe(0);
      expect(r2.height).toBe(0);
    });

    it('当测量行高过小或为 0 时强制保底最小行高 (16px) 与光标宽度 (2px)', () => {
      const mockView = {
        coordsAtPos: vi.fn().mockReturnValue({
          top: 100,
          bottom: 100,
          left: 50,
          right: 50,
        }),
      };
      const rect = measureCursorLineBox(mockView as any, 0, 1);
      expect(rect.height).toBe(16);
      expect(rect.width).toBe(2);
    });
  });

  describe('isPhysicallyVisibleNonZeroRect 物理可见与防噪点判定', () => {
    it('应当准确识别合法的非零物理包围盒', () => {
      const rect = new DOMRect(120, 240, 2, 18);
      expect(isPhysicallyVisibleNonZeroRect(rect)).toBe(true);
    });

    it('应当坚决拒绝 (0, 0, 0, 0) 全零包围盒', () => {
      const rect = new DOMRect(0, 0, 0, 0);
      expect(isPhysicallyVisibleNonZeroRect(rect)).toBe(false);
    });

    it('应当过滤 DPI 缩放下 0.000031px 的亚像素微小噪点', () => {
      const noisyRect = new DOMRect(0.000031, 0.000015, 0, 0);
      expect(isPhysicallyVisibleNonZeroRect(noisyRect)).toBe(false);
    });

    it('应当拒绝 NaN、Infinity 与负值尺寸', () => {
      expect(
        isPhysicallyVisibleNonZeroRect({
          top: NaN,
          left: 0,
          width: 10,
          height: 10,
        })
      ).toBe(false);
      expect(
        isPhysicallyVisibleNonZeroRect({
          top: 0,
          left: Infinity,
          width: 10,
          height: 10,
        })
      ).toBe(false);
      expect(
        isPhysicallyVisibleNonZeroRect({
          top: 0,
          left: 0,
          width: -2,
          height: 10,
        })
      ).toBe(false);
    });
  });

  describe('isValidClientRect 几何有效性判定', () => {
    it('接收有限数值且非负尺寸的 DOMRect', () => {
      expect(isValidClientRect(new DOMRect(0, 0, 0, 0))).toBe(true);
      expect(isValidClientRect(new DOMRect(100, 200, 10, 20))).toBe(true);
    });

    it('拒绝非法或非对象输入', () => {
      expect(isValidClientRect(null)).toBe(false);
      expect(isValidClientRect(undefined)).toBe(false);
      expect(isValidClientRect('invalid')).toBe(false);
      expect(isValidClientRect({ top: 0, left: 0, width: -1, height: 0 })).toBe(
        false
      );
    });
  });

  describe('isAnchorInsideVisibleField 可视视口边界检查', () => {
    it('光标处于容器内部时返回 true', () => {
      const mockField = document.createElement('div');
      mockField.getBoundingClientRect = vi.fn().mockReturnValue(
        new DOMRect(100, 500, 600, 200) // top: 500, bottom: 700
      );

      const insideCursor = new DOMRect(120, 550, 2, 20);
      expect(isAnchorInsideVisibleField(insideCursor, mockField)).toBe(true);
    });

    it('光标滚出容器上边界时返回 false', () => {
      const mockField = document.createElement('div');
      mockField.getBoundingClientRect = vi.fn().mockReturnValue(
        new DOMRect(100, 500, 600, 200) // top: 500, bottom: 700
      );

      const aboveCursor = new DOMRect(120, 450, 2, 20); // 470 < 500 - 4
      expect(isAnchorInsideVisibleField(aboveCursor, mockField)).toBe(false);
    });

    it('光标滚出容器下边界时返回 false', () => {
      const mockField = document.createElement('div');
      mockField.getBoundingClientRect = vi.fn().mockReturnValue(
        new DOMRect(100, 500, 600, 200) // top: 500, bottom: 700
      );

      const belowCursor = new DOMRect(120, 720, 2, 20); // 720 > 700 + 4
      expect(isAnchorInsideVisibleField(belowCursor, mockField)).toBe(false);
    });
  });

  describe('computeViewportEdgeAlignment 视口边界智能翻折建议', () => {
    it('距离视口顶部 < 120px 时建议 side="bottom"', () => {
      const res = computeViewportEdgeAlignment(50, 20, 120);
      expect(res.suggestedSide).toBe('bottom');
      expect(res.nearEdge).toBe(true);
    });

    it('距离视口底部 < 120px 时建议 side="top"', () => {
      // 假设视口高度为 800
      const res = computeViewportEdgeAlignment(750, 20, 120);
      expect(res.suggestedSide).toBe('top');
      expect(res.nearEdge).toBe(true);
    });
  });

  describe('calculateSafeCursorAnchor 四级备援回退与熔断引擎', () => {
    it('Level 1: 具有精确光标 LineBox 时直接采用', () => {
      const rawRect = new DOMRect(100, 300, 2, 20);
      const res = calculateSafeCursorAnchor({
        rawCursorRect: rawRect,
      });

      expect(res).not.toBeNull();
      expect(res?.top).toBe(300);
      expect(res?.left).toBe(100);
      expect(res?.isFallback).toBe(false);
      expect(res?.isValid).toBe(true);
    });

    it('Level 2: 光标失败但 Selection Range 成功时降级为 Range 锚点', () => {
      const range = document.createRange();
      const div = document.createElement('div');
      div.textContent = 'hello';
      document.body.appendChild(div);
      range.selectNodeContents(div);
      range.getBoundingClientRect = vi
        .fn()
        .mockReturnValue(new DOMRect(80, 250, 40, 18));

      const res = calculateSafeCursorAnchor({
        rawCursorRect: new DOMRect(0, 0, 0, 0), // invalid
        selectionRange: range,
      });

      expect(res).not.toBeNull();
      expect(res?.top).toBe(250);
      expect(res?.left).toBe(80);
      expect(res?.isFallback).toBe(true);
    });

    it('Level 3: 光标与选区均失败时降级为 Editor DOM Content Box', () => {
      const editorDom = document.createElement('div');
      editorDom.getBoundingClientRect = vi
        .fn()
        .mockReturnValue(new DOMRect(50, 200, 400, 100));

      const res = calculateSafeCursorAnchor({
        rawCursorRect: null,
        editorViewDom: editorDom,
      });

      expect(res).not.toBeNull();
      expect(res?.top).toBe(208); // 200 + 8
      expect(res?.left).toBe(62); // 50 + 12
      expect(res?.isFallback).toBe(true);
    });

    it('Level 4: Editor DOM 亦未就绪时降级为 Composer Container Box', () => {
      const container = document.createElement('div');
      container.getBoundingClientRect = vi
        .fn()
        .mockReturnValue(new DOMRect(40, 180, 500, 120));

      const res = calculateSafeCursorAnchor({
        rawCursorRect: null,
        editorViewDom: null,
        composerContainer: container,
      });

      expect(res).not.toBeNull();
      expect(res?.top).toBe(192); // 180 + 12
      expect(res?.left).toBe(56); // 40 + 16
      expect(res?.isFallback).toBe(true);
    });

    it('终极熔断防线: 当 4 级探测均失败时必须返回 null，拒绝向 (0,0) 挂载', () => {
      const res = calculateSafeCursorAnchor({
        rawCursorRect: null,
        editorViewDom: null,
        composerContainer: null,
      });
      expect(res).toBeNull();
    });
  });
});
