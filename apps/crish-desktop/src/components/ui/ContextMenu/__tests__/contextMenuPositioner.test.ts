// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/ContextMenu/__tests__/contextMenuPositioner.test.ts
 *
 * ContextMenu 几何解算引擎与纯辅助函数单元测试
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import {
  extractAnchorY,
  resolveFallbackSide,
  resolveActualSide,
  resolveSubmenuOffsets,
  clampCoordinatesToViewport,
  isPointInSafeAimTriangle,
  cn,
  extractTextFromChildren,
  DEFAULT_CONTEXT_MENU_OFFSET,
  SUBMENU_OVERLAP_SIDE_OFFSET,
  SUBMENU_ALIGN_OFFSET,
} from '../contextMenuPositioner';

describe('contextMenuPositioner 纯几何与辅助函数', () => {
  describe('cn 样式拼接纯函数', () => {
    it('正确过滤假值并拼接有效类名', () => {
      expect(cn('btn', false, null, undefined, 'active')).toBe('btn active');
      expect(cn()).toBe('');
      expect(cn('single')).toBe('single');
    });
  });

  describe('extractTextFromChildren 递归文本提取纯函数', () => {
    it('从字符串与数字中提取文本', () => {
      expect(extractTextFromChildren('Save Document')).toBe('Save Document');
      expect(extractTextFromChildren(42)).toBe('42');
    });

    it('从嵌套 React 节点中提取平铺文本', () => {
      const element = React.createElement(
        'div',
        null,
        React.createElement('span', null, 'Hello '),
        React.createElement('strong', null, 'World')
      );
      expect(extractTextFromChildren(element)).toBe('Hello World');
    });

    it('对空输入返回空字符串', () => {
      expect(extractTextFromChildren(null)).toBe('');
      expect(extractTextFromChildren(undefined)).toBe('');
    });
  });

  describe('extractAnchorY 与方向解析', () => {
    it('从 VirtualPoint 中提取 y 坐标', () => {
      expect(extractAnchorY({ x: 100, y: 550 })).toBe(550);
    });

    it('从 DOMRect 中提取 top 坐标', () => {
      expect(
        extractAnchorY({
          top: 320,
          left: 10,
          right: 100,
          bottom: 350,
          width: 90,
          height: 30,
        } as DOMRect)
      ).toBe(320);
    });

    it('从空锚点返回 null', () => {
      expect(extractAnchorY(null)).toBeNull();
      expect(extractAnchorY(undefined)).toBeNull();
    });

    it('resolveFallbackSide：根据垂直坐标阈值判定主轴方向', () => {
      expect(resolveFallbackSide({ x: 100, y: 550 })).toBe('top');
      expect(resolveFallbackSide({ x: 100, y: 250 })).toBe('bottom');
      expect(resolveFallbackSide(null)).toBe('bottom');
    });

    it('resolveActualSide：优先使用真实 positioner 测量结果', () => {
      expect(resolveActualSide('top', { x: 100, y: 100 })).toBe('top');
      expect(resolveActualSide('right', { x: 100, y: 550 })).toBe('right');
      expect(resolveActualSide(undefined, { x: 100, y: 600 })).toBe('top');
      expect(resolveActualSide(undefined, { x: 100, y: 100 })).toBe('bottom');
    });
  });

  describe('resolveSubmenuOffsets 规范对齐', () => {
    it('默认返回负 5px 重叠规范与负 4px 对齐偏移', () => {
      const offsets = resolveSubmenuOffsets();
      expect(offsets.sideOffset).toBe(SUBMENU_OVERLAP_SIDE_OFFSET);
      expect(offsets.alignOffset).toBe(SUBMENU_ALIGN_OFFSET);
      expect(offsets.sideOffset).toBe(-5);
      expect(offsets.alignOffset).toBe(-4);
    });

    it('支持自定义重叠覆盖', () => {
      const offsets = resolveSubmenuOffsets(-2, 0);
      expect(offsets.sideOffset).toBe(-2);
      expect(offsets.alignOffset).toBe(0);
    });
  });

  describe('clampCoordinatesToViewport 坐标夹紧', () => {
    it('正常范围内坐标保持不变', () => {
      const clamped = clampCoordinatesToViewport(
        { x: 300, y: 400 },
        { width: 200, height: 300 },
        { width: 1000, height: 1000 }
      );
      expect(clamped).toEqual({ x: 300, y: 400 });
    });

    it('右下溢出坐标被夹紧至最大安全边缘', () => {
      const clamped = clampCoordinatesToViewport(
        { x: 950, y: 950 },
        { width: 200, height: 300 },
        { width: 1000, height: 1000 }
      );
      expect(clamped.x).toBe(1000 - 200 - 8);
      expect(clamped.y).toBe(1000 - 300 - 8);
    });

    it('左上溢出坐标被夹紧至最小内边距', () => {
      const clamped = clampCoordinatesToViewport(
        { x: -50, y: -20 },
        { width: 200, height: 300 },
        { width: 1000, height: 1000 }
      );
      expect(clamped.x).toBe(8);
      expect(clamped.y).toBe(8);
    });
  });

  describe('isPointInSafeAimTriangle Safe-Aim 防抖', () => {
    it('目标在光标右侧时正确计算三角形引导区', () => {
      const prevCursor = { x: 100, y: 100 };
      const targetRect = { left: 200, top: 50, right: 400, bottom: 250 };

      // 处于三角形引导区内部
      expect(
        isPointInSafeAimTriangle({ x: 150, y: 100 }, prevCursor, targetRect)
      ).toBe(true);

      // 处于三角形引导区外部（上方）
      expect(
        isPointInSafeAimTriangle({ x: 150, y: 10 }, prevCursor, targetRect)
      ).toBe(false);

      // 处于三角形引导区外部（下方）
      expect(
        isPointInSafeAimTriangle({ x: 150, y: 300 }, prevCursor, targetRect)
      ).toBe(false);
    });
  });
});
