// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/internal/positioner/__tests__/geometry.test.ts
 *
 * Positioner 纯数学几何核心解算引擎完备单元测试
 *
 * 覆盖专项：
 * 1. 双模输入源归一化 (normalizeAnchorToRect)
 * 2. 宿主有效视口探测与 Win32 8px 最大化边缘补偿 (getEffectiveViewport)
 * 3. Containing Block 相对偏移校正 (correctContainingBlock, DEF-01)
 * 4. 基本四向定位与次轴对齐解算 (computePosition)
 * 5. 视口碰撞单向无震荡 Flip 与迟滞记忆锁 (DEF-08)
 * 6. 极小视口刚性安全锚定边界保护 (DEF-07)
 * 7. 视口边缘安全留白与超大尺寸极限钳位 (edgePadding & clamp)
 * 8. Select 原位覆盖模式 (alignItemWithTrigger, DEF-09)
 * 9. DOM 样式应用与现代 CSS translate 独立属性解耦 (applyPositionStyles, DEF-03)
 * 10. useStableAnchor 值语义数值防抖 (DEF-02)
 */

import { describe, expect, it } from 'vitest';
import {
  computePosition,
  getEffectiveViewport,
  normalizeAnchorToRect,
  correctContainingBlock,
  applyPositionStyles,
  calculateSubmenuPosition,
} from '../geometry';
import { useStableAnchor } from '../useStableAnchor';
import { usePositioner } from '../usePositioner';
import { renderHook } from '@testing-library/react';
import type { AnchorRect, VirtualPoint } from '../types';

describe('Positioner 定位引擎纯数学核心与几何守卫测试', () => {
  const defaultViewport = {
    width: 1000,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
  };

  // =========================================================================
  // 1. normalizeAnchorToRect 双模输入源归一化测试
  // =========================================================================
  describe('normalizeAnchorToRect 输入归一化', () => {
    it('规范化 VirtualPoint 点坐标（默认宽高为 0）', () => {
      const rect = normalizeAnchorToRect({ x: 120, y: 240 });
      expect(rect).toEqual<AnchorRect>({
        left: 120,
        top: 240,
        right: 120,
        bottom: 240,
        width: 0,
        height: 0,
      });
    });

    it('规范化附带宽高的 VirtualPoint 选区或光标', () => {
      const rect = normalizeAnchorToRect({
        x: 50,
        y: 80,
        width: 60,
        height: 20,
      });
      expect(rect).toEqual<AnchorRect>({
        left: 50,
        top: 80,
        right: 110,
        bottom: 100,
        width: 60,
        height: 20,
      });
    });

    it('规范化标准 AnchorRect 矩形对象', () => {
      const rect = normalizeAnchorToRect({
        left: 10,
        top: 20,
        right: 110,
        bottom: 70,
        width: 100,
        height: 50,
      });
      expect(rect).toEqual<AnchorRect>({
        left: 10,
        top: 20,
        right: 110,
        bottom: 70,
        width: 100,
        height: 50,
      });
    });

    it('规范化 React RefObject 实体', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      el.getBoundingClientRect = () =>
        ({
          left: 30,
          top: 40,
          right: 130,
          bottom: 90,
          width: 100,
          height: 50,
        }) as DOMRect;

      const ref = { current: el };
      const rect = normalizeAnchorToRect(ref);
      expect(rect).toEqual<AnchorRect>({
        left: 30,
        top: 40,
        right: 130,
        bottom: 90,
        width: 100,
        height: 50,
      });
      document.body.removeChild(el);
    });

    it('规范化函数式动态获取锚点', () => {
      const getter = () => ({ x: 200, y: 300, width: 10, height: 15 });
      const rect = normalizeAnchorToRect(getter);
      expect(rect).toEqual<AnchorRect>({
        left: 200,
        top: 300,
        right: 210,
        bottom: 315,
        width: 10,
        height: 15,
      });
    });

    it('无效或空输入返回 null', () => {
      expect(normalizeAnchorToRect(null)).toBeNull();
      expect(normalizeAnchorToRect(undefined)).toBeNull();
      expect(normalizeAnchorToRect({} as unknown as VirtualPoint)).toBeNull();
    });
  });

  // =========================================================================
  // 2. getEffectiveViewport 与 Win32 8px 最大化边缘补偿
  // =========================================================================
  describe('getEffectiveViewport 视口与 Win32 最大化补偿', () => {
    it('显式传入自定义视口时精确优先使用', () => {
      const vp = getEffectiveViewport({
        width: 640,
        height: 480,
        offsetLeft: 10,
        offsetTop: 20,
      });
      expect(vp).toEqual({
        width: 640,
        height: 480,
        offsetLeft: 10,
        offsetTop: 20,
      });
    });

    it('在非 Windows 或未最大化环境下使用真实视口', () => {
      document.documentElement.removeAttribute('data-window-maximized');
      const vp = getEffectiveViewport();
      expect(vp.offsetLeft).toBe(0);
      expect(vp.offsetTop).toBe(0);
      expect(vp.width).toBeGreaterThanOrEqual(320);
      expect(vp.height).toBeGreaterThanOrEqual(200);
    });

    it('在 Windows 最大化环境下自动补偿四周 8px 溢出边界', () => {
      const originalUserAgent = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        configurable: true,
      });
      document.documentElement.setAttribute('data-window-maximized', 'true');

      // 模拟视口 1280x800
      window.innerWidth = 1280;
      window.innerHeight = 800;
      if (window.visualViewport) {
        Object.defineProperty(window.visualViewport, 'width', {
          value: 1280,
          configurable: true,
        });
        Object.defineProperty(window.visualViewport, 'height', {
          value: 800,
          configurable: true,
        });
      }

      const vp = getEffectiveViewport();
      expect(vp.offsetLeft).toBe(8);
      expect(vp.offsetTop).toBe(8);
      expect(vp.width).toBe(1280 - 16);
      expect(vp.height).toBe(800 - 16);

      // 清理环境
      document.documentElement.removeAttribute('data-window-maximized');
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      });
    });
  });

  // =========================================================================
  // 3. correctContainingBlock 包含块相对偏移校正 (DEF-01)
  // =========================================================================
  describe('correctContainingBlock 包含块相对偏移校正 (DEF-01)', () => {
    it('无包含块或挂载在 document.body 时坐标保持不变', () => {
      expect(correctContainingBlock(200, 300, null)).toEqual({
        x: 200,
        y: 300,
      });
      expect(correctContainingBlock(200, 300, document.body)).toEqual({
        x: 200,
        y: 300,
      });
      expect(
        correctContainingBlock(200, 300, document.documentElement)
      ).toEqual({ x: 200, y: 300 });
    });

    it('在局部定位容器中精准扣除包含块左上角物理偏移', () => {
      const cbRect = { left: 150, top: 100, scrollLeft: 0, scrollTop: 0 };
      const corrected = correctContainingBlock(350, 450, cbRect);
      // X = 350 - 150 = 200, Y = 450 - 100 = 350
      expect(corrected).toEqual({ x: 200, y: 350 });
    });

    it('在包含滚动条的包含块中考虑 scrollLeft 和 scrollTop', () => {
      const cbRect = { left: 150, top: 100, scrollLeft: 30, scrollTop: 20 };
      const corrected = correctContainingBlock(350, 450, cbRect);
      // offsetX = 150 - 30 = 120, offsetY = 100 - 20 = 80
      // X = 350 - 120 = 230, Y = 450 - 80 = 370
      expect(corrected).toEqual({ x: 230, y: 370 });
    });

    it('支持传入包含 getBoundingClientRect 的真实 DOM 容器', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      el.getBoundingClientRect = () =>
        ({
          left: 80,
          top: 60,
          right: 480,
          bottom: 360,
          width: 400,
          height: 300,
        }) as DOMRect;
      el.scrollLeft = 10;
      el.scrollTop = 5;

      const corrected = correctContainingBlock(280, 260, el);
      // offsetX = 80 - 10 = 70, offsetY = 60 - 5 = 55
      // X = 280 - 70 = 210, Y = 260 - 55 = 205
      expect(corrected).toEqual({ x: 210, y: 205 });
      document.body.removeChild(el);
    });
  });

  // =========================================================================
  // 4. computePosition 基本四向定位与次轴对齐
  // =========================================================================
  describe('computePosition 基础解算与对齐', () => {
    const anchor: AnchorRect = {
      left: 200,
      top: 200,
      right: 300,
      bottom: 240,
      width: 100,
      height: 40,
    };
    const floating = { width: 120, height: 150 };

    it('默认 bottom + start 放置与边距偏移', () => {
      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'start',
        sideOffset: 6,
        alignOffset: 0,
        viewport: defaultViewport,
      });

      // y = anchor.bottom + 6 = 246
      // x = anchor.left = 200
      expect(res.x).toBe(200);
      expect(res.y).toBe(246);
      expect(res.actualSide).toBe('bottom');
      expect(res.actualAlign).toBe('start');
      expect(res.isFlippedSide).toBe(false);
      expect(res.isFlippedAlign).toBe(false);
      expect(res.transformOrigin).toBe('top left');
    });

    it('bottom + center 居中对齐次轴', () => {
      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'center',
        viewport: defaultViewport,
      });

      // x = anchor.left + (anchor.width - floatW) / 2 = 200 + (100 - 120) / 2 = 190
      expect(res.x).toBe(190);
      expect(res.y).toBe(246);
      expect(res.actualAlign).toBe('center');
      expect(res.transformOrigin).toBe('top center');
    });

    it('bottom + end 右对齐次轴', () => {
      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'end',
        viewport: defaultViewport,
      });

      // x = anchor.right - floatW = 300 - 120 = 180
      expect(res.x).toBe(180);
      expect(res.y).toBe(246);
      expect(res.actualAlign).toBe('end');
      expect(res.transformOrigin).toBe('top right');
    });

    it('top + start 向上弹出', () => {
      const res = computePosition({
        anchor,
        floating,
        side: 'top',
        align: 'start',
        sideOffset: 6,
        viewport: defaultViewport,
      });

      // y = anchor.top - floatH - sideOffset = 200 - 150 - 6 = 44
      expect(res.x).toBe(200);
      expect(res.y).toBe(44);
      expect(res.actualSide).toBe('top');
      expect(res.transformOrigin).toBe('bottom left');
    });

    it('right + start 向右弹出', () => {
      const res = computePosition({
        anchor,
        floating,
        side: 'right',
        align: 'start',
        sideOffset: 8,
        viewport: defaultViewport,
      });

      // x = anchor.right + sideOffset = 300 + 8 = 308
      // y = anchor.top = 200
      expect(res.x).toBe(308);
      expect(res.y).toBe(200);
      expect(res.actualSide).toBe('right');
      expect(res.transformOrigin).toBe('top left');
    });

    it('left + start 向左弹出', () => {
      const res = computePosition({
        anchor,
        floating,
        side: 'left',
        align: 'start',
        sideOffset: 8,
        viewport: defaultViewport,
      });

      // x = anchor.left - floatW - sideOffset = 200 - 120 - 8 = 72
      // y = anchor.top = 200
      expect(res.x).toBe(72);
      expect(res.y).toBe(200);
      expect(res.actualSide).toBe('left');
      expect(res.transformOrigin).toBe('top right');
    });
  });

  // =========================================================================
  // 5. 碰撞单向无震荡 Flip 与迟滞记忆锁 (DEF-08)
  // =========================================================================
  describe('视口碰撞 Flip 与迟滞记忆锁 (DEF-08)', () => {
    it('底部空间不足且上方空间更大时单向翻转至 top', () => {
      // 锚点位于底部边缘：top: 720, bottom: 760 (视口高 800)
      const anchor: AnchorRect = {
        left: 200,
        top: 720,
        right: 300,
        bottom: 760,
        width: 100,
        height: 40,
      };
      const floating = { width: 120, height: 150 };

      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        viewport: defaultViewport,
      });

      expect(res.actualSide).toBe('top');
      expect(res.isFlippedSide).toBe(true);
      // y = 720 - 150 - 6 = 564
      expect(res.y).toBe(564);
      expect(res.transformOrigin).toContain('bottom');
    });

    it('顶部空间不足且下方空间更大时单向翻转至 bottom', () => {
      // 锚点位于顶部边缘：top: 20, bottom: 50
      const anchor: AnchorRect = {
        left: 200,
        top: 20,
        right: 300,
        bottom: 50,
        width: 100,
        height: 30,
      };
      const floating = { width: 120, height: 100 };

      const res = computePosition({
        anchor,
        floating,
        side: 'top',
        viewport: defaultViewport,
      });

      expect(res.actualSide).toBe('bottom');
      expect(res.isFlippedSide).toBe(true);
      // y = 50 + 6 = 56
      expect(res.y).toBe(56);
      expect(res.transformOrigin).toContain('top');
    });

    it('次轴对齐轴碰撞避让翻折 (start -> end)', () => {
      // 锚点贴靠右侧边缘：left: 920, right: 980 (视口宽 1000)
      const anchor: AnchorRect = {
        left: 920,
        top: 200,
        right: 980,
        bottom: 240,
        width: 60,
        height: 40,
      };
      const floating = { width: 150, height: 100 };

      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'start',
        viewport: defaultViewport,
      });

      // 920 + 150 = 1070 > 992 (1000 - 8)，翻折为 end
      // x = anchor.right - floatW = 980 - 150 = 830
      expect(res.actualAlign).toBe('end');
      expect(res.isFlippedAlign).toBe(true);
      expect(res.x).toBe(830);
    });

    it('Flip Hysteresis 迟滞记忆锁：保持当前方位不因高度缩减产生横跳', () => {
      const anchor: AnchorRect = {
        left: 200,
        top: 300,
        right: 300,
        bottom: 340,
        width: 100,
        height: 40,
      };

      // 假设当前浮层之前因溢出已翻转到 'top'
      // 搜索过滤后浮层高度从 300px 缩小至 60px（此时上下两边都能容纳）
      const res = computePosition({
        anchor,
        floating: { width: 120, height: 60 },
        side: 'bottom', // 原始期望方向为 bottom
        currentSide: 'top', // 传入当前已生效的 top
        viewport: defaultViewport,
      });

      // 迟滞锁：因为上方依然放得下，保持 top，严禁跳回 bottom！
      expect(res.actualSide).toBe('top');
      expect(res.y).toBe(300 - 60 - 6);
    });
  });

  // =========================================================================
  // 6. 极小视口刚性安全锚定边界保护 (DEF-07)
  // =========================================================================
  describe('极小视口刚性安全锚定 (DEF-07)', () => {
    it('极小视口下展开高浮层，Y 坐标绝不向上逆推遮挡触发按钮', () => {
      // 视口高 250px，触发器在 top: 110, bottom: 138，浮层天然高 200px
      const lowViewport = {
        width: 800,
        height: 250,
        offsetLeft: 0,
        offsetTop: 0,
      };
      const anchor: AnchorRect = {
        left: 200,
        top: 110,
        right: 300,
        bottom: 138,
        width: 100,
        height: 28,
      };
      const floating = { width: 160, height: 200 };

      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        sideOffset: 6,
        edgePadding: 8,
        viewport: lowViewport,
      });

      // spaceBelow = 242 - 144 = 98px
      // spaceAbove = 104 - 8 = 96px
      // 下方略大，actualSide 为 bottom
      expect(res.actualSide).toBe('bottom');

      // 刚性铁律断言：y 绝不可小于 anchor.bottom + sideOffset (144px)！
      expect(res.y).toBeGreaterThanOrEqual(anchor.bottom + 6);
      expect(res.y).toBe(144);

      // 可用高度必须严格等于 spaceBelow = 98px，由容器内部 overflow-y: auto 承接
      expect(res.availableHeight).toBe(98);
      expect(res.availableHeight).toBeGreaterThan(0);
    });

    it('向上弹出时即便放不下，也绝不向下挤压遮挡 anchor.top', () => {
      const lowViewport = {
        width: 800,
        height: 250,
        offsetLeft: 0,
        offsetTop: 0,
      };
      const anchor: AnchorRect = {
        left: 200,
        top: 120,
        right: 300,
        bottom: 150,
        width: 100,
        height: 30,
      };
      const floating = { width: 160, height: 200 };

      const res = computePosition({
        anchor,
        floating,
        side: 'top',
        sideOffset: 6,
        edgePadding: 8,
        avoidCollisions: false, // 强制向上弹出测试
        viewport: lowViewport,
      });

      expect(res.actualSide).toBe('top');
      // 刚性铁律断言：浮层底边 (y + floatH) 绝对不能超过 anchor.top - sideOffset (114px)
      expect(res.y + floating.height).toBeLessThanOrEqual(anchor.top - 6);
      expect(res.availableHeight).toBe(Math.max(0, 120 - 6 - 8)); // 106px
    });
  });

  // =========================================================================
  // 7. 视口边缘安全留白与超大尺寸极限钳位
  // =========================================================================
  describe('视口边缘留白与极端尺寸钳位', () => {
    it('左侧越界被严密钳位在 edgePadding 留白处', () => {
      const anchor: AnchorRect = {
        left: 2,
        top: 200,
        right: 50,
        bottom: 240,
        width: 48,
        height: 40,
      };
      const floating = { width: 120, height: 100 };

      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'start',
        edgePadding: 8,
        viewport: defaultViewport,
      });

      expect(res.x).toBe(8); // 钳位到 edgePadding 8px
    });

    it('右侧越界被严密钳位在 maxX - floatW 处', () => {
      const anchor: AnchorRect = {
        left: 950,
        top: 200,
        right: 998,
        bottom: 240,
        width: 48,
        height: 40,
      };
      const floating = { width: 100, height: 100 };

      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'start',
        edgePadding: 8,
        viewport: defaultViewport,
      });

      // maxX = 1000 - 8 = 992. 992 - 100 = 892
      expect(res.x).toBe(892);
      expect(res.x + floating.width).toBeLessThanOrEqual(992);
    });

    it('超尺寸菜单（5000px 高）钳位不产生负坐标且贴边稳固', () => {
      const anchor: AnchorRect = {
        left: 100,
        top: 200,
        right: 200,
        bottom: 240,
        width: 100,
        height: 40,
      };
      const giantFloating = { width: 160, height: 5000 };

      const res = computePosition({
        anchor,
        floating: giantFloating,
        side: 'bottom',
        viewport: { width: 1280, height: 600 },
      });

      expect(res.y).toBeGreaterThanOrEqual(0);
      expect(res.x).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 8. Select 原位覆盖模式 (alignItemWithTrigger, DEF-09)
  // =========================================================================
  describe('Select 原位覆盖模式 (DEF-09)', () => {
    const triggerRect: AnchorRect = {
      left: 300,
      top: 400,
      right: 460,
      bottom: 432,
      width: 160,
      height: 32,
    };
    const popup = { width: 200, height: 260 };

    it('启用 alignItemWithTrigger 时选中项精确对齐触发器中心', () => {
      const res = computePosition({
        anchor: triggerRect,
        floating: popup,
        alignItemWithTrigger: true,
        selectedItemOffsetY: 60, // 当前选中第 2 项，相对弹层顶部 60px
        viewport: defaultViewport,
      });

      // targetX = 300 - (200 - 160) / 2 = 300 - 20 = 280
      expect(res.x).toBe(280);

      // targetY = trigger.top + trigger.height / 2 - selectedItemOffsetY
      // targetY = 400 + 16 - 60 = 356
      expect(res.y).toBe(356);
      expect(res.actualSide).toBe('bottom');
      expect(res.actualAlign).toBe('center');
      expect(res.transformOrigin).toBe('center center');
      expect(res.availableWidth).toBe(1000 - 16);
      expect(res.availableHeight).toBe(800 - 16);
    });

    it('未指定 selectedItemOffsetY 时采用默认 4px 上移微调', () => {
      const res = computePosition({
        anchor: triggerRect,
        floating: popup,
        alignItemWithTrigger: true,
        viewport: defaultViewport,
      });

      // 默认 targetY = anchor.top - 4 = 400 - 4 = 396
      expect(res.y).toBe(396);
      expect(res.transformOrigin).toBe('center center');
    });
  });

  // =========================================================================
  // 9. applyPositionStyles 现代 CSS translate 样式注入与解耦 (DEF-01, DEF-03)
  // =========================================================================
  describe('applyPositionStyles 样式应用与现代 CSS translate (DEF-01, DEF-03)', () => {
    it('采用现代独立属性 style.translate，彻底不覆盖 style.transform', () => {
      const el = document.createElement('div');
      // 预先模拟 CSS @starting-style 动效写入 transform
      el.style.transform = 'scale(0.975)';

      const positionRes = computePosition({
        anchor: {
          left: 100,
          top: 100,
          right: 200,
          bottom: 130,
          width: 100,
          height: 30,
        },
        floating: { width: 150, height: 120 },
        side: 'bottom',
        viewport: defaultViewport,
      });

      applyPositionStyles(el, positionRes, null, 100);

      // 核心断言 DEF-03：style.transform 保持原有 scale 动效未被抹去！
      expect(el.style.transform).toBe('scale(0.975)');

      // 核心断言 DEF-03：style.translate 写入独立位移
      expect(el.style.translate).toBe(`${positionRes.x}px ${positionRes.y}px`);

      // 验证 CSS 变量与可见性注入
      expect(el.style.position).toBe('fixed');
      expect(el.style.left).toBe('0px');
      expect(el.style.top).toBe('0px');
      expect(el.style.getPropertyValue('--transform-origin')).toBe(
        positionRes.transformOrigin
      );
      expect(el.style.getPropertyValue('--available-width')).toBe(
        `${positionRes.availableWidth}px`
      );
      expect(el.style.getPropertyValue('--available-height')).toBe(
        `${positionRes.availableHeight}px`
      );
      expect(el.style.getPropertyValue('--anchor-width')).toBe('100px');
      expect(el.style.visibility).toBe('visible');
      expect(el.style.pointerEvents).toBe('auto');
    });

    it('挂载在局部 Containing Block 时自动在 style.translate 中扣除容器偏移 (DEF-01)', () => {
      const el = document.createElement('div');
      const container = document.createElement('div');
      document.body.appendChild(container);
      container.getBoundingClientRect = () =>
        ({
          left: 100,
          top: 80,
          right: 600,
          bottom: 480,
          width: 500,
          height: 400,
        }) as DOMRect;
      container.scrollLeft = 0;
      container.scrollTop = 0;

      const positionRes = computePosition({
        anchor: {
          left: 200,
          top: 200,
          right: 300,
          bottom: 230,
          width: 100,
          height: 30,
        },
        floating: { width: 150, height: 120 },
        side: 'bottom',
        viewport: defaultViewport,
      });

      // res.x = 200, res.y = 236
      // 包含块 offset: left 100, top 80
      // 最终 translate: (200 - 100) = 100px, (236 - 80) = 156px
      applyPositionStyles(el, positionRes, container);

      expect(el.style.translate).toBe('100px 156px');
      document.body.removeChild(container);
    });
  });

  // =========================================================================
  // 10. useStableAnchor 值语义数值防抖 (DEF-02)
  // =========================================================================
  describe('useStableAnchor 值语义防抖 (DEF-02)', () => {
    it('相同数值的不同字面量对象保持引用不变，杜绝无限重新渲染', () => {
      const { result, rerender } = renderHook(
        ({ anchor }) => useStableAnchor(anchor),
        {
          initialProps: { anchor: { x: 100, y: 200 } as VirtualPoint },
        }
      );

      const firstRef = result.current;

      // 模拟父组件重新渲染传入全新的字面量对象，但数值一致
      rerender({ anchor: { x: 100, y: 200 } });
      expect(result.current).toBe(firstRef);

      // 数值改变时更新引用
      rerender({ anchor: { x: 105, y: 200 } });
      expect(result.current).not.toBe(firstRef);
      expect((result.current as VirtualPoint).x).toBe(105);
    });
  });

  // =========================================================================
  // 11. usePositioner Hook 集成与生命周期测试
  // =========================================================================
  describe('usePositioner 2-Phase DOM 探测与生命周期集成', () => {
    it('open 为 true 时完成真实 DOM 测量并注入 translate 样式', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      // 模拟尺寸为 160x200
      Object.defineProperty(el, 'offsetWidth', {
        value: 160,
        configurable: true,
      });
      Object.defineProperty(el, 'offsetHeight', {
        value: 200,
        configurable: true,
      });

      const contentRef = { current: el };
      const anchor: VirtualPoint = { x: 100, y: 150 };

      const { result } = renderHook(() =>
        usePositioner({
          open: true,
          anchor,
          contentRef,
          viewport: defaultViewport,
        })
      );

      expect(result.current.isPositioned).toBe(true);
      expect(result.current.result).not.toBeNull();
      expect(result.current.result?.actualSide).toBe('bottom');
      // style.translate 应该已注入
      expect(el.style.translate).toContain('px');
      expect(el.style.visibility).toBe('visible');

      document.body.removeChild(el);
    });

    it('open 为 false 时重置定位状态并清除 result', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      Object.defineProperty(el, 'offsetWidth', {
        value: 160,
        configurable: true,
      });
      Object.defineProperty(el, 'offsetHeight', {
        value: 200,
        configurable: true,
      });
      const contentRef = { current: el };

      const { result, rerender } = renderHook(
        ({ open }) =>
          usePositioner({
            open,
            anchor: { x: 100, y: 150 },
            contentRef,
            viewport: defaultViewport,
          }),
        { initialProps: { open: true } }
      );

      expect(result.current.isPositioned).toBe(true);

      rerender({ open: false });
      expect(result.current.isPositioned).toBe(false);
      expect(result.current.result).toBeNull();

      document.body.removeChild(el);
    });
  });

  // =========================================================================
  // 11. calculateSubmenuPosition 级联二级子菜单负重叠与对齐测试 (PE-05)
  // =========================================================================
  describe('calculateSubmenuPosition (二级子菜单 5px 负重叠与基线对齐)', () => {
    it('默认使用 -5px 负重叠向左展开，右边界压在父级选项 padding 区域', () => {
      const rowRect = {
        left: 500,
        right: 660,
        top: 200,
        bottom: 232,
        width: 160,
        height: 32,
        x: 500,
        y: 200,
        toJSON: () => {},
      } as DOMRect;

      const res = calculateSubmenuPosition(rowRect, 180, 240);
      expect(res.side).toBe('left');
      // targetX = 500 - 180 - (-5) = 325. 子菜单右侧为 325 + 180 = 505，覆盖父级 left (500) 5px
      expect(res.x).toBe(325);
      // targetY = 200 - 4 = 196
      expect(res.y).toBe(196);
      expect(res.transformOrigin).toBe('top right');
    });

    it('向右展开时左边界覆盖父级选项右边缘 5px (x = rowRect.right - 5)', () => {
      const rowRect = {
        left: 50,
        right: 210,
        top: 200,
        bottom: 232,
        width: 160,
        height: 32,
        x: 50,
        y: 200,
        toJSON: () => {},
      } as DOMRect;

      const res = calculateSubmenuPosition(rowRect, 180, 240);
      expect(res.side).toBe('right');
      // targetX = 210 + (-5) = 205. 覆盖父级 right (210) 5px
      expect(res.x).toBe(205);
      expect(res.y).toBe(196);
      expect(res.transformOrigin).toBe('top left');
    });

    it('显式指定 preferredSide = right 时产生 5px 负重叠', () => {
      const rowRect = {
        left: 300,
        right: 460,
        top: 150,
        bottom: 182,
        width: 160,
        height: 32,
        x: 300,
        y: 150,
        toJSON: () => {},
      } as DOMRect;

      const res = calculateSubmenuPosition(rowRect, 180, 240, -5, 8, 'right');
      expect(res.side).toBe('right');
      expect(res.x).toBe(455);
      expect(res.y).toBe(146);
    });
  });

  // =========================================================================
  // 12. 视口底部极端情况下的向上翻折与锚点严丝合缝对齐测试
  // =========================================================================
  describe('视口底部向上翻折与锚点底边/顶边严丝合缝对齐', () => {
    it('侧栏更多按钮 (side: right, align: start) 在视口中间向下对齐：top = anchor.top', () => {
      const anchor: AnchorRect = {
        left: 200,
        right: 228,
        top: 300,
        bottom: 328,
        width: 28,
        height: 28,
      };
      const floating = { width: 180, height: 260 };

      const res = computePosition({
        anchor,
        floating,
        side: 'right',
        align: 'start',
        sideOffset: 6,
        viewport: defaultViewport,
      });

      expect(res.actualSide).toBe('right');
      expect(res.actualAlign).toBe('start');
      expect(res.isFlippedAlign).toBe(false);
      expect(res.x).toBe(228 + 6);
      // 向下对齐时：面板顶边平齐按钮顶边
      expect(res.y).toBe(anchor.top);
    });

    it('侧栏更多按钮 (side: right, align: start) 靠近视口底部向上翻折：bottom = anchor.bottom，垂直间隙必须为 0', () => {
      // 视口高 800 (maxY: 792)，按钮在 bottom: 760, top: 732
      const anchor: AnchorRect = {
        left: 200,
        right: 228,
        top: 732,
        bottom: 760,
        width: 28,
        height: 28,
      };
      const floating = { width: 180, height: 260 };

      const res = computePosition({
        anchor,
        floating,
        side: 'right',
        align: 'start',
        sideOffset: 6,
        viewport: defaultViewport,
      });

      expect(res.actualSide).toBe('right');
      // 次轴对齐翻折至 end
      expect(res.actualAlign).toBe('end');
      expect(res.isFlippedAlign).toBe(true);
      expect(res.x).toBe(228 + 6);
      // 关键几何断言：面板底边与按钮底边紧贴，间隙精确为 0！
      expect(res.y).toBe(anchor.bottom - floating.height);
      expect(res.y + floating.height).toBe(anchor.bottom);
    });

    it('垂直常规弹出 (side: bottom) 靠近视口底部向上翻折：bottom = anchor.top - sideOffset，间隙精确为 sideOffset', () => {
      const anchor: AnchorRect = {
        left: 400,
        right: 480,
        top: 720,
        bottom: 752,
        width: 80,
        height: 32,
      };
      const floating = { width: 180, height: 200 };

      const res = computePosition({
        anchor,
        floating,
        side: 'bottom',
        align: 'start',
        sideOffset: 6,
        viewport: defaultViewport,
      });

      expect(res.actualSide).toBe('top');
      expect(res.isFlippedSide).toBe(true);
      // 关键几何断言：面板底边距离按钮顶边精确为 sideOffset
      expect(res.y).toBe(anchor.top - floating.height - 6);
      expect(res.y + floating.height).toBe(anchor.top - 6);
    });
  });
});
