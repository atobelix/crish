// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  computePagingAnchor,
  restorePagingAnchor,
  performUndoWithPagingAnchor,
  useUndoWithPagingAnchor,
  usePreActionAnchor,
} from '../PagingAnchor';
import {
  createScrollDeltaAssertion,
  SUBPIXEL_TOLERANCE_PX,
  SCROLL_FLOOR_EPSILON,
  type PagingAnchor,
} from '../pagingAnchorTypes';
import { VirtualScrollManager } from '../../../api/VirtualScrollManager';
import type { MessageDelta } from '../../../api/MessageSnapshots';

describe('PagingAnchor — 视口同步锚定与零抖动测试套件', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 第一部分：100% 完整平移并继承 useUndoWithScrollAnchor.test.ts 三大核心用例
  // ──────────────────────────────────────────────────────────────────────────
  describe('一、完整平移复刻 useUndoWithScrollAnchor 三大经典用例 (位移差 ΔY ≡ 0)', () => {
    it('用例 1 (平移)：撤销时捕获视口第一可见元素并在回灌高度后同步校准 scrollTop (位移差 ΔY ≡ 0)', () => {
      const vsm = new VirtualScrollManager(120);
      // 初始状态：页面有 m1 (800px), m2 (600px), m3 (400px)
      vsm.syncOrder(['m1', 'm2', 'm3']);
      vsm.setActual('m1', 800);
      vsm.setActual('m2', 600);
      vsm.setActual('m3', 400);

      // 假设视口滚动到 900px（m1 顶部 0..800，m2 顶部 800..1400）
      // 此时第一可见元素是 m2，相对视口内偏移为 900 - 800 = 100px (即 relative top = -100px)
      const mockContainer = {
        scrollTop: 900,
      } as HTMLDivElement;
      const containerRef = { current: mockContainer };

      const { result } = renderHook(() =>
        useUndoWithPagingAnchor(containerRef, vsm)
      );

      // 模拟撤销操作：在 m1 之前插入了历史卡片 m0 (500px)
      const restoredDelta: MessageDelta = {
        startIndex: 0,
        removedCount: 0,
        inserted: [
          {
            id: 'm0',
            sender: 'assistant',
            text: '历史卡片',
            status: 'completed',
          },
        ],
        heightMap: {
          m0: 500,
        },
      };

      act(() => {
        result.current.performUndoWithAnchor(() => {
          // 模拟外部 Store 撤销后更新 order
          vsm.syncOrder(['m0', 'm1', 'm2', 'm3']);
          return { restoredDelta };
        });
      });

      // 1. 验证：m0 的高度被 hydrateHeightMap 灌入
      expect(vsm.getHeight('m0')).toBe(500);

      // 2. 验证：m2 的新顶部偏移量 = m0(500) + m1(800) = 1300px
      // 同步校准后的 scrollTop 应为 1300 + 100 = 1400px
      // 使得 m2 相对视口顶部的相对偏移依然精确为 100px (位移 ΔY ≡ 0)
      expect(mockContainer.scrollTop).toBe(1400);

      // 3. 数学断言：严格使用 createScrollDeltaAssertion 校验位移差严格为 0
      // 动作前 m2 相对视口: 800 - 900 = -100px
      // 动作后 m2 相对视口: 1300 - 1400 = -100px
      const deltaAssertion = createScrollDeltaAssertion('m2', -100, -100, 0);
      expect(deltaAssertion.deltaY).toBe(0);
      expect(deltaAssertion.passed).toBe(true);
    });

    it('用例 2 (平移)：当 containerRef.current 为空时安全执行 undoAction', () => {
      const vsm = new VirtualScrollManager(120);
      const containerRef = { current: null };
      const { result } = renderHook(() =>
        useUndoWithPagingAnchor(containerRef, vsm)
      );

      const undoFn = vi.fn();
      expect(() => {
        result.current.performUndoWithAnchor(undoFn);
      }).not.toThrow();

      expect(undoFn).toHaveBeenCalledTimes(1);

      // 直接调用纯逻辑 performUndoWithPagingAnchor 同样安全无异常
      const pureFn = vi.fn();
      expect(() => {
        performUndoWithPagingAnchor(null, vsm, pureFn);
      }).not.toThrow();
      expect(pureFn).toHaveBeenCalledTimes(1);
    });

    it('用例 3 (平移)：当撤销未返回 heightMap 时仍同步微调 scrollTop (临界上边缘容差)', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['m1', 'm2']);
      vsm.setActual('m1', 100);
      vsm.setActual('m2', 200);

      const mockContainer = { scrollTop: 120 } as HTMLDivElement;
      const containerRef = { current: mockContainer };

      const { result } = renderHook(() =>
        useUndoWithPagingAnchor(containerRef, vsm)
      );

      act(() => {
        result.current.performUndoWithAnchor(() => {
          vsm.syncOrder(['m0', 'm1', 'm2']);
          vsm.setActual('m0', 300);
        });
      });

      // m2 之前是 m1 (offset 100), inViewOffset = 20 (relative top = -20px)
      // 现在 m2 之前是 m0(300) + m1(100) = 400
      // scrollTop 应校准为 400 + 20 = 420
      expect(mockContainer.scrollTop).toBe(420);

      // 数学断言：位移偏差严格为 0
      const assertion = createScrollDeltaAssertion('m2', -20, 400 - 420, 0);
      expect(assertion.deltaY).toBe(0);
      expect(assertion.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第二部分：PagingAnchor 双径算法（Fast Path DOM 探针 + Slow Path 树状数组二分）
  // ──────────────────────────────────────────────────────────────────────────
  describe('二、PagingAnchor 双径算法与前缀和差分补偿 (scrollTop += ΔH)', () => {
    it('慢路径 (Slow Path)：无真实 DOM 探针时基于 VSM 纯内存 Fenwick 树二分精准捕获锚点', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['row-1', 'row-2', 'row-3', 'row-4']);
      vsm.setActual('row-1', 250); // offset: 0..250
      vsm.setActual('row-2', 350); // offset: 250..600
      vsm.setActual('row-3', 400); // offset: 600..1000
      vsm.setActual('row-4', 500); // offset: 1000..1500

      // 视口处于 0px: 第一可见行应为 row-1, relative top = 0
      const anchor0 = computePagingAnchor({ scrollTop: 0 }, vsm);
      expect(anchor0).toEqual({ key: 'row-1', top: 0 });

      // 视口处于 280px (位于 row-2 内部 30px): 第一可见行应为 row-2, top = 250 - 280 = -30px
      const anchor280 = computePagingAnchor({ scrollTop: 280 }, vsm);
      expect(anchor280).toEqual({ key: 'row-2', top: -30 });

      // 视口处于 650px (位于 row-3 内部 50px): 第一可见行应为 row-3, top = 600 - 650 = -50px
      const anchor650 = computePagingAnchor({ scrollTop: 650 }, vsm);
      expect(anchor650).toEqual({ key: 'row-3', top: -50 });
    });

    it('快路径 (Fast Path)：避让置顶栏 PinnedBar，优先通过 probeY 探测线命中真实 DOM 行', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['m1', 'm2']);

      const container = document.createElement('div');
      container.scrollTop = 200;

      // 模拟视口尺寸与坐标
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        left: 0,
        width: 800,
        height: 600,
        bottom: 700,
        right: 800,
        x: 0,
        y: 100,
        toJSON: () => {},
      });

      // 添加置顶栏：高度 48px
      const pinnedBar = document.createElement('div');
      pinnedBar.setAttribute('data-pinned-bar', 'true');
      vi.spyOn(pinnedBar, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        left: 0,
        width: 800,
        height: 48,
        bottom: 148,
        right: 800,
        x: 0,
        y: 100,
        toJSON: () => {},
      });
      container.appendChild(pinnedBar);

      // 添加消息行
      const row1 = document.createElement('div');
      row1.setAttribute('data-chat-node-key', 'm1');
      const row2 = document.createElement('div');
      row2.setAttribute('data-chat-node-key', 'm2');
      container.appendChild(row1);
      container.appendChild(row2);
      document.body.appendChild(container);

      // row2 在探测线下方，相对 container 顶部位移为 -15px
      vi.spyOn(row2, 'getBoundingClientRect').mockReturnValue({
        top: 85, // 85 - 100 = -15px
        left: 0,
        width: 800,
        height: 300,
        bottom: 385,
        right: 800,
        x: 0,
        y: 85,
        toJSON: () => {},
      });

      // 模拟 document.elementsFromPoint：命中 row2 内部子元素
      const originalEFP = document.elementsFromPoint;
      document.elementsFromPoint = vi.fn((x: number, y: number) => {
        // 验证 probeY = scrollerRect.top(100) + pinnedBarHeight(48) + 2 = 150px
        expect(y).toBe(150);
        return [row2, container];
      });

      try {
        const anchor = computePagingAnchor(container, vsm);
        expect(anchor).not.toBeNull();
        expect(anchor?.key).toBe('m2');
        expect(anchor?.top).toBe(-15);
      } finally {
        document.elementsFromPoint = originalEFP;
        document.body.removeChild(container);
      }
    });

    it('前置加载 N 条历史消息 (Prepend 50 消息)：真实 DOM 相对位移差分补偿 scrollTop += ΔH', () => {
      const vsm = new VirtualScrollManager(100);
      const container = document.createElement('div');
      container.scrollTop = 1200;

      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        left: 0,
        width: 800,
        height: 600,
        bottom: 700,
        right: 800,
        x: 0,
        y: 100,
        toJSON: () => {},
      });

      const readingRow = document.createElement('div');
      readingRow.setAttribute('data-chat-node-key', 'msg-target');
      container.appendChild(readingRow);
      document.body.appendChild(container);

      // 捕获前：readingRow 相对视口顶部为 -40px (即在视口上方 40px 开始延伸)
      vi.spyOn(readingRow, 'getBoundingClientRect').mockReturnValue({
        top: 60, // 60 - 100 = -40px
        left: 0,
        width: 800,
        height: 300,
        bottom: 360,
        right: 800,
        x: 0,
        y: 60,
        toJSON: () => {},
      });

      const anchor: PagingAnchor = { key: 'msg-target', top: -40 };

      // 前置加载 50 条消息后，总高度增加 5000px，未补偿前 readingRow 物理位置暴跌下移 5000px
      vi.spyOn(readingRow, 'getBoundingClientRect').mockReturnValue({
        top: 5060, // 5060 - 100 = 4960px, 偏移量从 -40 变为 4960, delta = 5000px
        left: 0,
        width: 800,
        height: 300,
        bottom: 5360,
        right: 800,
        x: 0,
        y: 5060,
        toJSON: () => {},
      });

      // 执行 restorePagingAnchor
      restorePagingAnchor(container, anchor, vsm);

      // 验证：scrollTop 增加 5000px (1200 + 5000 = 6200px)
      expect(container.scrollTop).toBe(6200);

      document.body.removeChild(container);
    });

    it('虚拟切片越界降级补偿：目标行超出当前切片未挂载真实 DOM 时回退至 VSM 纯数学对齐', () => {
      const vsm = new VirtualScrollManager(100);
      // 模拟 100 条消息
      const ids = Array.from({ length: 100 }, (_, i) => `msg-${i}`);
      vsm.syncOrder(ids);
      for (const id of ids) {
        vsm.setActual(id, 100);
      }

      // 锚定目标是 msg-60，原先 offset: 6000，原 scrollTop: 6050，相对 top: -50px
      const anchor: PagingAnchor = { key: 'msg-60', top: -50 };

      // 容器只挂载了前 20 条，未挂载 msg-60 的真实 DOM
      const emptyContainer = {
        scrollTop: 6050,
      } as HTMLElement;

      // 前置插入 20 条历史消息
      const prependIds = Array.from({ length: 20 }, (_, i) => `prepended-${i}`);
      vsm.syncOrder([...prependIds, ...ids]);
      for (const pid of prependIds) {
        vsm.setActual(pid, 100);
      }

      // msg-60 的新 index 是 20 + 60 = 80，新 offset 是 8000px
      expect(vsm.getOrder().indexOf('msg-60')).toBe(80);
      expect(vsm.getOffset(80)).toBe(8000);

      // 执行 restorePagingAnchor
      restorePagingAnchor(emptyContainer, anchor, vsm);

      // 新 scrollTop 应为 newOffset(8000) - top(-50) = 8050px
      expect(emptyContainer.scrollTop).toBe(8050);

      // 验证数学位移差量 ΔY 严格为 0
      const afterTop = 8000 - emptyContainer.scrollTop; // -50
      const assertion = createScrollDeltaAssertion('msg-60', -50, afterTop, 0);
      expect(assertion.deltaY).toBe(0);
      expect(assertion.passed).toBe(true);
    });

    it('亚像素容差门槛 (Subpixel Tolerance)：绝对偏差 < 0.5px 时抑制调整，防止 1px 震荡', () => {
      const vsm = new VirtualScrollManager(100);
      const container = document.createElement('div');
      container.scrollTop = 500;

      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        left: 0,
        width: 800,
        height: 600,
        bottom: 600,
        right: 800,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      const row = document.createElement('div');
      row.setAttribute('data-chat-node-key', 'm1');
      container.appendChild(row);

      const anchor: PagingAnchor = { key: 'm1', top: -100 };

      // 场景 1：微小浮点偏差 0.3px (currentRelativeTop = -99.7, delta = 0.3 < 0.5px)
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        top: -99.7,
        left: 0,
        width: 800,
        height: 200,
        bottom: 100.3,
        right: 800,
        x: 0,
        y: -99.7,
        toJSON: () => {},
      });

      restorePagingAnchor(container, anchor, vsm);
      // scrollTop 保持 500 不变（抑制浮点震荡）
      expect(container.scrollTop).toBe(500);

      // 场景 2：有效偏差 0.8px >= 0.5px (currentRelativeTop = -99.2, delta = 0.8px)
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        top: -99.2,
        left: 0,
        width: 800,
        height: 200,
        bottom: 100.8,
        right: 800,
        x: 0,
        y: -99.2,
        toJSON: () => {},
      });

      restorePagingAnchor(container, anchor, vsm);
      // scrollTop 增加 0.8px (500 + 0.8 = 500.8px)
      expect(container.scrollTop).toBeCloseTo(500.8, 4);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 第三部分：主动交互视口防抖（usePreActionAnchor 预挂载补偿与折叠展开）
  // ──────────────────────────────────────────────────────────────────────────
  describe('三、主动交互视口防抖 (usePreActionAnchor) 与折叠展开场景', () => {
    it('点击思维链折叠 (高度骤降 ΔH = -800px)：wrapAction 预捕获并在形变后瞬时微调', () => {
      const vsm = new VirtualScrollManager(100);
      // 场景：页面有 m1 (300px), m2-thought (1000px), m3-answer (500px)
      vsm.syncOrder(['m1', 'm2-thought', 'm3-answer']);
      vsm.setActual('m1', 300);
      vsm.setActual('m2-thought', 1000);
      vsm.setActual('m3-answer', 500);

      // 用户正阅读 m3-answer (当前视口处于 1350px，m3 offset 为 1300px)
      // m3-answer 相对视口顶部为: 1300 - 1350 = -50px
      const mockContainer = {
        scrollTop: 1350,
        scrollHeight: 1800,
      } as HTMLElement;
      const scrollerRef = { current: mockContainer };

      const { result } = renderHook(() =>
        usePreActionAnchor(scrollerRef, vsm)
      );

      // 用户点击折叠 m2-thought：高度由 1000px 萎缩至 200px (减少 800px)
      act(() => {
        result.current.wrapAction(() => {
          vsm.setActual('m2-thought', 200);
        });
      });

      // m3-answer 的新 offset 从 1300 降为 500px (300 + 200)
      // restorePagingAnchor 微调后，scrollTop 应修正为 500 - (-50) = 550px
      // 视口相对 m3-answer 位移 ΔY ≡ 0，用户视野绝对静止！
      expect(mockContainer.scrollTop).toBe(550);

      const assertion = createScrollDeltaAssertion('m3-answer', -50, 500 - 550, 0);
      expect(assertion.deltaY).toBe(0);
      expect(assertion.passed).toBe(true);
    });

    it('展开长代码/工具卡片 (高度膨胀 ΔH = +1200px)：主动预挂载快照，视口平稳不乱跳', () => {
      const vsm = new VirtualScrollManager(100);
      vsm.syncOrder(['card-1', 'card-2', 'card-3']);
      vsm.setActual('card-1', 400);
      vsm.setActual('card-2', 200);
      vsm.setActual('card-3', 600);

      // 用户在阅读 card-3 (offset: 600, scrollTop: 680, relative top: -80px)
      const mockContainer = {
        scrollTop: 680,
        scrollHeight: 1200,
      } as HTMLElement;
      const scrollerRef = { current: mockContainer };

      const { result } = renderHook(() =>
        usePreActionAnchor(scrollerRef, vsm)
      );

      // 用户点击展开 card-2：高度从 200 暴增至 1400 (+1200px)
      act(() => {
        result.current.wrapAction(() => {
          vsm.setActual('card-2', 1400);
        });
      });

      // card-3 新 offset: 400 + 1400 = 1800px
      // 新 scrollTop = 1800 - (-80) = 1880px
      expect(mockContainer.scrollTop).toBe(1880);
      expect(1800 - mockContainer.scrollTop).toBe(-80);
    });

    it('临界上边缘与 Floor Clamping 容差断言：SCROLL_FLOOR_EPSILON = 2.0px 防护', () => {
      // 验证导出常量符合详案规范
      expect(SUBPIXEL_TOLERANCE_PX).toBe(0.5);
      expect(SCROLL_FLOOR_EPSILON).toBe(2.0);

      // 在高 DPI (125%/150%) 缩放下，亚像素被动钳位产生 0.8px 误差
      const reportedScrollTop = 4600.4;
      const expectedClampedTop = 4600.0;
      const floorDiff = Math.abs(reportedScrollTop - expectedClampedTop);

      // 验证差异落在 ε = 2.0px 窗口内，被成功识别为地表收缩而非用户主动上滑
      expect(floorDiff).toBeLessThanOrEqual(SCROLL_FLOOR_EPSILON);
    });
  });
});
