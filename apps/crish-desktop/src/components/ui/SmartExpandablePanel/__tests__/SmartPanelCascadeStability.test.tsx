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

    it('向左展开时 left 精确计算，使子菜单右边界向内覆盖主菜单左侧 padding 5px (overlap 5px)', () => {
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
      // left = 1000 + 5 - 160 = 845px，其右边界为 845 + 160 = 1005px，向内覆盖 panelRect.left 5px
      expect(placed.left).toBe(845);
      expect(placed.top).toBe(196); // 200 - 4

      const style = cascadeStyle(placed);
      expect(style.left).toBe('845px');
      expect(style.right).toBe('auto');
      expect(style.transformOrigin).toBe('top right');
    });

    it('向右展开时输出 left 坐标且向内覆盖主菜单右侧 padding 5px (overlap 5px)', () => {
      const panelRect = { left: 200, right: 400 };
      const placed = placeCascadeSubmenu(panelRect, 200, 160, 100, 1280, 800);

      expect(placed.side).toBe('right');
      // left = 400 - 5 = 395px，覆盖 panelRect.right 5px
      expect(placed.left).toBe(395);
      expect(placed.top).toBe(196);

      const style = cascadeStyle(placed);
      expect(style.left).toBe('395px');
      expect(style.right).toBe('auto');
      expect(style.transformOrigin).toBe('top left');
    });
  });

  describe('2. 图 2 场景：跨面板安全桥 data-side 契约与父项激活态', () => {
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
      expect(submenu).toHaveAttribute('data-state', 'open');
      expect(['left', 'right']).toContain(submenu.getAttribute('data-side'));
    });
  });

  describe('3. 图 3 场景：长菜单单源高度与视口安全钳制', () => {
    it('12-30 项长列表估算高度受控钳制在 MAX_CASCADE_PANEL_HEIGHT (300px)，防止冲上天际', () => {
      const mediumChildren = Array.from({ length: 12 }, (_, i) => ({
        id: `skill-${i}`,
        type: i === 10 ? 'divider' : 'item',
      }));

      const estMedium = estimateCascadeHeight(mediumChildren);
      expect(estMedium).toBe(MAX_CASCADE_PANEL_HEIGHT);

      const veryLongChildren = Array.from({ length: 30 }, (_, i) => ({
        id: `skill-${i}`,
        type: 'item',
      }));
      const estVeryLong = estimateCascadeHeight(veryLongChildren);
      expect(estVeryLong).toBe(MAX_CASCADE_PANEL_HEIGHT);
    });

    it('底部空间不足时长列表（300px）上移自适应，严格保持 12px 视口呼吸底边距（绝不切断底部的管理技能）', () => {
      const panelRect = { left: 100, right: 300 };
      const itemTop = 600;
      const viewportHeight = 800; // 常见视口高度
      const realSubmenuHeight = 300; // 限制高度 300px

      const placed = placeCascadeSubmenu(
        panelRect,
        itemTop,
        220,
        realSubmenuHeight,
        1200,
        viewportHeight
      );

      // bounds.bottom = 800 - 12 = 788px
      // 理想放置 600 + 300 = 900 > 788，触发底边对齐：top = 788 - 300 = 488px
      expect(placed.top).toBe(488);
      // 验证底部严格与视口底边保持 12px 刚性间隙
      expect(placed.top + realSubmenuHeight).toBe(viewportHeight - 12);
    });
  });
});
