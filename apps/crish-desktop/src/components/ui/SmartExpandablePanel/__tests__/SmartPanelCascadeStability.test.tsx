// @vitest-environment jsdom
/**
 * SmartPanelCascadeStability.test.tsx
 *
 * 针对级联展开面板不稳定缺陷（图 1~4 场景）的工业级回归验收套件：
 * 1. 【图 1 场景】向左展开时的几何精确贴合：消除历史 46px 真空大空洞，保证子菜单右边界与主菜单左边界严格相隔 gap (6px)；
 * 2. 【图 2 场景】跨面板透明安全桥契约：验证 data-side="left" / "right" 属性正确挂载，配合 CSS ::before 桥接物理空隙；
 * 3. 【图 3 场景】长菜单视口钳制与垂直对齐：验证超长列表估算高度与 CSS max-height (360px) 保持单源一致，绝不过顶悬空；
 * 4. 【图 4 场景】斜向下划动到子菜单底部选项（如管理技能）：验证多帧斜向下轨迹不被质心矢量误杀，持续享有安全区保护。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  placeCascadeSubmenu,
  cascadeStyle,
  estimateCascadeHeight,
  estimateCascadeWidth,
  MAX_CASCADE_PANEL_HEIGHT,
} from '../PositionEngine';
import { SafeAimEngine } from '../../internal/SafeAimEngine';
import { SmartExpandablePanel } from '../SmartExpandablePanel';
import type { MenuItem } from '../types';

describe('级联展开面板稳定性与几何对齐专项测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('1. 图 1 场景：向左展开时的无空洞几何贴合', () => {
    it('短子项「对话」估算宽度精准对齐 min-width 160px，消除 200px 盲猜空洞', () => {
      const width = estimateCascadeWidth([{ label: '对话' }]);
      expect(width).toBe(160);
    });

    it('向左展开时 left 精确计算，使子菜单右边界严格紧贴主菜单左边界 (gap 6px)', () => {
      const panelRect = { left: 1000, right: 1200 };
      const viewportWidth = 1280;
      const viewportHeight = 800;

      const placed = placeCascadeSubmenu(
        panelRect,
        200,
        160, // 短条目宽度 160px
        100,
        viewportWidth,
        viewportHeight
      );

      expect(placed.side).toBe('left');
      // left = 1000 - 6 - 160 = 834px，其右边界为 834 + 160 = 994px，与 panelRect.left 相差正好是 gap 6px
      expect(placed.left).toBe(834);

      const style = cascadeStyle(placed);
      expect(style.left).toBe('834px');
      expect(style.right).toBe('auto');
      expect(style.transformOrigin).toBe('top right');
    });

    it('向右展开时输出 left 坐标且 right 为 auto', () => {
      const panelRect = { left: 200, right: 400 };
      const placed = placeCascadeSubmenu(panelRect, 200, 160, 100, 1280, 800);

      expect(placed.side).toBe('right');
      expect(placed.left).toBe(400 + 6);

      const style = cascadeStyle(placed);
      expect(style.left).toBe('406px');
      expect(style.right).toBe('auto');
      expect(style.transformOrigin).toBe('top left');
    });
  });

  describe('2. 图 2 场景：跨面板安全桥 data-side 契约', () => {
    it('展开二级子菜单时在 DOM 上挂载对应 data-side 属性', async () => {
      const items: MenuItem[] = [
        {
          id: 'parent-1',
          label: '使用 skill',
          type: 'submenu',
          children: [
            { id: 'sub-1', label: '技能 A' },
            { id: 'sub-2', label: '管理技能...' },
          ],
        },
      ];

      render(
        <SmartExpandablePanel
          open={true}
          items={items}
          position={{ align: 'start', side: 'bottom' }}
        />
      );

      const triggerItem = screen.getByText('使用 skill');
      fireEvent.mouseEnter(triggerItem);

      // rAF 触发真实排版
      act(() => {
        vi.runAllTimers();
      });

      const submenu = screen.getByRole('menu', { name: '使用 skill' });
      expect(submenu).toBeInTheDocument();
      expect(submenu).toHaveAttribute('data-side');
      expect(['left', 'right']).toContain(submenu.getAttribute('data-side'));
    });
  });

  describe('3. 图 3 场景：长菜单单源高度与视口安全钳制', () => {
    it('超长子项列表估算高度严格钳制在 MAX_CASCADE_PANEL_HEIGHT (360px)', () => {
      const veryLongChildren = Array.from({ length: 15 }, (_, i) => ({
        id: `skill-${i}`,
        type: i === 13 ? 'divider' : 'item',
      }));

      const estHeight = estimateCascadeHeight(veryLongChildren);
      expect(estHeight).toBe(MAX_CASCADE_PANEL_HEIGHT);
    });

    it('底部空间不足时只上移真实高度，避免将子菜单顶飞出触发行视线', () => {
      const panelRect = { left: 100, right: 300 };
      const itemTop = 650;
      const viewportHeight = 700; // 较紧凑的视口

      const placed = placeCascadeSubmenu(
        panelRect,
        itemTop,
        200,
        MAX_CASCADE_PANEL_HEIGHT, // 360px
        1200,
        viewportHeight
      );

      // maxTop = 700 - 8 - 360 = 332px
      expect(placed.top).toBe(332);
      expect(placed.top).toBeGreaterThan(0);
    });
  });

  describe('4. 图 4 场景：斜向下划动到底部选项的轨迹保护', () => {
    let engine: SafeAimEngine;

    beforeEach(() => {
      const oldOverlay = document.getElementById('sepSafeAimOverlay');
      if (oldOverlay) oldOverlay.remove();
      engine = SafeAimEngine.getInstance({ enabled: true, timeoutMs: 300 });
      engine.initSvgOverlay();
    });

    afterEach(() => {
      engine.clearSubmenu();
      engine.destroy();
    });

    it('光标从主菜单项向右下方的「管理技能...」斜切移动时，安全区不被误杀释放', () => {
      const triggerEl = document.createElement('button');
      const submenuEl = document.createElement('div');
      document.body.appendChild(triggerEl);
      document.body.appendChild(submenuEl);

      // 模拟图 4 场景：主菜单项在左侧 (y=600)，子菜单在右侧 (left: 200, right: 380, top: 400, bottom: 760)
      // 子菜单的几何中心在 (290, 580)
      submenuEl.getBoundingClientRect = () => ({
        left: 200,
        top: 400,
        right: 380,
        bottom: 760,
        width: 180,
        height: 360,
        x: 200,
        y: 400,
        toJSON: () => {},
      });

      engine.setSubmenu(triggerEl, submenuEl, 'right');

      // 帧 1：鼠标在主项触发点 (100, 600)
      engine.onMouseMove({ clientX: 100, clientY: 600 });
      // 帧 2：鼠标斜向右下方移动 (140, 650)，朝着底部的管理技能 (y=740) 划去
      engine.onMouseMove({ clientX: 140, clientY: 650 });

      // 此时 vx = +40 (向右)，vy = +50 (向下)
      // 目标点在斜向右下方 (160, 680)
      const isProtected = engine.isPointerInSafeZone({ x: 160, y: 680 });
      expect(isProtected).toBe(true);

      // 帧 3：鼠标直接进入子菜单矩形内部 (220, 740)
      engine.onMouseMove({ clientX: 220, clientY: 740 });
      expect(engine.isPointerInSafeZone({ x: 220, y: 740 })).toBe(true);

      triggerEl.remove();
      submenuEl.remove();
    });

    it('当光标明确向左倒退反向离开右侧子菜单时，安全区立即释放', () => {
      const triggerEl = document.createElement('button');
      const submenuEl = document.createElement('div');
      document.body.appendChild(triggerEl);
      document.body.appendChild(submenuEl);

      submenuEl.getBoundingClientRect = () => ({
        left: 200,
        top: 400,
        right: 380,
        bottom: 760,
        width: 180,
        height: 360,
        x: 200,
        y: 400,
        toJSON: () => {},
      });

      engine.setSubmenu(triggerEl, submenuEl, 'right');

      // 鼠标向左倒退远离：从 (150, 500) 移至 (120, 500)
      engine.onMouseMove({ clientX: 150, clientY: 500 });
      engine.onMouseMove({ clientX: 120, clientY: 500 });

      // vx = -30 < -2，判定为反向倒退远离
      expect(engine.isPointerInSafeZone({ x: 130, y: 500 })).toBe(false);

      triggerEl.remove();
      submenuEl.remove();
    });
  });
});
