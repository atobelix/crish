// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  SmartExpandablePanel,
  PositionEngine,
  SafeAimEngine,
  useWheelIsolation,
  useSmartPanel,
  type MenuItem,
  type MenuGroup,
} from './index';
import { placeCascadeSubmenu } from './PositionEngine';

describe('SmartExpandablePanel Foundation & Core Engines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('PositionEngine', () => {
    it('calculates downward position when space below is sufficient', () => {
      const engine = new PositionEngine();
      const triggerEl = document.createElement('button');
      vi.spyOn(triggerEl, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 100,
        right: 200,
        bottom: 130,
        width: 100,
        height: 30,
        x: 100,
        y: 100,
        toJSON: () => {},
      });

      const panelEl = document.createElement('div');
      Object.defineProperty(panelEl, 'offsetWidth', { value: 260 });
      Object.defineProperty(panelEl, 'offsetHeight', { value: 150 });

      const listEl = document.createElement('div');
      Object.defineProperty(listEl, 'scrollHeight', { value: 120 });

      const bounds = { left: 10, top: 10, right: 1000, bottom: 800 };
      const res = engine.calculateTriggerPosition({
        triggerEl,
        panelEl,
        listEl,
        headerHeight: 0,
        bounds,
        itemCount: 4,
      });

      expect(res.directionY).toBe('down');
      expect(res.y).toBe(138); // 130 + 8
      expect(res.origin).toBe('left top');
      expect(res.triggerWidth).toBe(100);
    });

    it('flips upward when space below is insufficient and protects trigger from being covered', () => {
      const engine = new PositionEngine();
      const triggerEl = document.createElement('button');
      vi.spyOn(triggerEl, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 600,
        right: 200,
        bottom: 630,
        width: 100,
        height: 30,
        x: 100,
        y: 600,
        toJSON: () => {},
      });

      const panelEl = document.createElement('div');
      Object.defineProperty(panelEl, 'offsetWidth', { value: 260 });
      Object.defineProperty(panelEl, 'offsetHeight', { value: 200 });

      const listEl = document.createElement('div');
      Object.defineProperty(listEl, 'scrollHeight', { value: 200 });

      const bounds = { left: 10, top: 10, right: 1000, bottom: 650 };
      const res = engine.calculateTriggerPosition({
        triggerEl,
        panelEl,
        listEl,
        headerHeight: 0,
        bounds,
        itemCount: 8,
      });

      expect(res.directionY).toBe('up');
      expect(res.y).toBeLessThan(600); // Strictly above trigger
      expect(res.origin).toBe('left bottom');
    });

    it('enforces compact fit (no 92px blank space or scrollbar) when itemCount <= 2', () => {
      const engine = new PositionEngine();
      const triggerEl = document.createElement('button');
      vi.spyOn(triggerEl, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 100,
        right: 200,
        bottom: 130,
        width: 100,
        height: 30,
        x: 100,
        y: 100,
        toJSON: () => {},
      });

      const panelEl = document.createElement('div');
      const listEl = document.createElement('div');
      const bounds = { left: 10, top: 10, right: 1000, bottom: 800 };

      const res = engine.calculateTriggerPosition({
        triggerEl,
        panelEl,
        listEl,
        headerHeight: 0,
        bounds,
        itemCount: 2,
      });

      expect(res.allowedListHeight).toBeNull();
    });

    it('maintains direction with 32px hysteresis to prevent edge jitter', () => {
      const engine = new PositionEngine({ hysteresisY: 32 });
      const triggerEl = document.createElement('button');
      const panelEl = document.createElement('div');
      const listEl = document.createElement('div');
      Object.defineProperty(panelEl, 'offsetWidth', { value: 200 });
      Object.defineProperty(panelEl, 'offsetHeight', { value: 150 });
      Object.defineProperty(listEl, 'scrollHeight', { value: 150 });

      // First call: space below is greater -> sets direction 'down'
      vi.spyOn(triggerEl, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 250,
        right: 200,
        bottom: 280,
        width: 100,
        height: 30,
        x: 100,
        y: 250,
        toJSON: () => {},
      });
      const bounds1 = { left: 0, top: 0, right: 1000, bottom: 600 };
      const res1 = engine.calculateTriggerPosition({
        triggerEl,
        panelEl,
        listEl,
        headerHeight: 0,
        bounds: bounds1,
        itemCount: 5,
      });
      expect(res1.directionY).toBe('down');

      // Second call: space above slightly exceeds space below by 10px (< 32px hysteresis)
      // Should remain 'down' without flipping!
      vi.spyOn(triggerEl, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 200,
        right: 200,
        bottom: 230,
        width: 100,
        height: 30,
        x: 100,
        y: 200,
        toJSON: () => {},
      });
      const bounds2 = { left: 0, top: 0, right: 1000, bottom: 420 };
      const res2 = engine.calculateTriggerPosition({
        triggerEl,
        panelEl,
        listEl,
        headerHeight: 0,
        bounds: bounds2,
        itemCount: 5,
      });
      expect(res2.directionY).toBe('down');
    });

    it('短级联贴着触发行向面板外侧展开，不再预留 200px', () => {
      const placed = placeCascadeSubmenu(
        { left: 180, right: 400 },
        640,
        180,
        80,
        1200,
        760
      );
      expect(placed.side).toBe('right');
      expect(placed.left).toBe(406);
      expect(placed.top).toBe(640);
    });

    it('底部放不下时只上移超出的高度', () => {
      const placed = placeCascadeSubmenu(
        { left: 180, right: 400 },
        700,
        180,
        120,
        1200,
        760
      );
      expect(placed.top).toBe(760 - 8 - 120);
      expect(placed.left).toBe(406);
    });

    it('右侧空间不够时翻到主面板左侧', () => {
      const placed = placeCascadeSubmenu(
        { left: 900, right: 1120 },
        200,
        200,
        80,
        1200,
        800
      );
      expect(placed.side).toBe('left');
      expect(placed.left).toBe(900 - 6 - 200);
      expect(placed.top).toBe(200);
    });

    it('calculates submenu position and flips horizontally when right boundary is exceeded', () => {
      const engine = new PositionEngine();
      const triggerItemEl = document.createElement('div');
      vi.spyOn(triggerItemEl, 'getBoundingClientRect').mockReturnValue({
        left: 900,
        top: 200,
        right: 990,
        bottom: 228,
        width: 90,
        height: 28,
        x: 900,
        y: 200,
        toJSON: () => {},
      });

      const submenuEl = document.createElement('div');
      Object.defineProperty(submenuEl, 'offsetWidth', { value: 200 });
      Object.defineProperty(submenuEl, 'offsetHeight', { value: 150 });

      const bounds = { left: 10, top: 10, right: 1000, bottom: 800 };
      const res = engine.calculateSubmenuPosition({
        triggerItemEl,
        submenuEl,
        bounds,
      });

      expect(res.isFlipLeft).toBe(true);
      expect(res.x).toBe(900 - 200 - 4);
    });

    it('calculates point position for context menus', () => {
      const engine = new PositionEngine();
      const panelEl = document.createElement('div');
      const listEl = document.createElement('div');
      Object.defineProperty(panelEl, 'offsetWidth', { value: 200 });
      Object.defineProperty(panelEl, 'offsetHeight', { value: 100 });
      Object.defineProperty(listEl, 'scrollHeight', { value: 100 });

      const bounds = { left: 0, top: 0, right: 1000, bottom: 1000 };
      const res = engine.calculatePointPosition({
        point: { x: 300, y: 400 },
        panelEl,
        listEl,
        headerHeight: 0,
        bounds,
        itemCount: 3,
      });

      expect(res.x).toBe(300);
      expect(res.y).toBe(400);
      expect(res.directionY).toBe('down');
    });
  });

  describe('SafeAimEngine', () => {
    it('correctly tests point in triangle using barycentric coordinates', () => {
      const engine = new SafeAimEngine({ enabled: true, debug: false });
      const triggerEl = document.createElement('div');
      const submenuEl = document.createElement('div');

      vi.spyOn(submenuEl, 'getBoundingClientRect').mockReturnValue({
        left: 300,
        top: 100,
        right: 500,
        bottom: 300,
        width: 200,
        height: 200,
        x: 300,
        y: 100,
        toJSON: () => {},
      });

      engine.setSubmenu(triggerEl, submenuEl);

      // Simulate moving towards submenu: previous at (100, 200), current at (150, 200)
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 100, clientY: 200 })
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 150, clientY: 200 })
      );

      // Point inside triangle (e.g. 200, 200)
      expect(engine.isPointerInSafeZone({ x: 200, y: 200 })).toBe(true);

      // Point outside triangle (e.g. 50, 50)
      expect(engine.isPointerInSafeZone({ x: 50, y: 50 })).toBe(false);

      engine.destroy();
    });

    it('releases safe zone immediately when cursor moves in reverse direction (v · d <= 0)', () => {
      const engine = new SafeAimEngine({ enabled: true });
      const triggerEl = document.createElement('div');
      const submenuEl = document.createElement('div');

      vi.spyOn(submenuEl, 'getBoundingClientRect').mockReturnValue({
        left: 300,
        top: 100,
        right: 500,
        bottom: 300,
        width: 200,
        height: 200,
        x: 300,
        y: 100,
        toJSON: () => {},
      });

      engine.setSubmenu(triggerEl, submenuEl);

      // Move leftwards away from submenu: (200, 200) -> (150, 200)
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 200, clientY: 200 })
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 150, clientY: 200 })
      );

      // Reverse motion should instantly release protection
      expect(engine.isPointerInSafeZone({ x: 200, y: 200 })).toBe(false);

      engine.destroy();
    });

    it('melts safe zone when cursor lingers for > 300ms (safety timeout)', () => {
      const engine = new SafeAimEngine({ enabled: true, timeoutMs: 300 });
      const triggerEl = document.createElement('div');
      const submenuEl = document.createElement('div');

      vi.spyOn(submenuEl, 'getBoundingClientRect').mockReturnValue({
        left: 300,
        top: 100,
        right: 500,
        bottom: 300,
        width: 200,
        height: 200,
        x: 300,
        y: 100,
        toJSON: () => {},
      });

      engine.setSubmenu(triggerEl, submenuEl);

      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 100, clientY: 200 })
      );
      window.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 150, clientY: 200 })
      );

      // First check: in safe zone
      expect(engine.isPointerInSafeZone({ x: 200, y: 200 })).toBe(true);

      // Advance time by 350ms without entering submenu
      act(() => {
        vi.advanceTimersByTime(350);
      });

      // Timeout should have melted the zone
      expect(engine.isPointerInSafeZone({ x: 200, y: 200 })).toBe(false);

      engine.destroy();
    });

    it('supports submenu stack push and pop', () => {
      const engine = new SafeAimEngine({ enabled: true });
      const t1 = document.createElement('div');
      const s1 = document.createElement('div');
      const t2 = document.createElement('div');
      const s2 = document.createElement('div');

      engine.pushSubmenu(t1, s1);
      expect(engine.getActiveSubmenu()?.submenuEl).toBe(s1);

      engine.pushSubmenu(t2, s2);
      expect(engine.getActiveSubmenu()?.submenuEl).toBe(s2);

      engine.popSubmenu();
      expect(engine.getActiveSubmenu()?.submenuEl).toBe(s1);

      engine.clearSubmenu();
      expect(engine.getActiveSubmenu()).toBeNull();

      engine.destroy();
    });
  });

  describe('useWheelIsolation Hook', () => {
    it('prevents default when scrolling at boundaries', () => {
      const TestComponent = () => {
        const ref = useRef<HTMLDivElement>(null);
        useWheelIsolation(ref, true);
        return (
          <div
            ref={ref}
            data-testid="wheel-box"
            style={{ height: 100, overflow: 'auto' }}
          />
        );
      };

      render(<TestComponent />);
      const el = screen.getByTestId('wheel-box');

      Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
      Object.defineProperty(el, 'scrollHeight', { value: 300 });
      Object.defineProperty(el, 'clientHeight', { value: 100 });

      // Wheel up at top: should preventDefault
      const wheelUpEvent = new WheelEvent('wheel', {
        deltaY: -20,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(wheelUpEvent, 'preventDefault');
      el.dispatchEvent(wheelUpEvent);
      expect(preventDefaultSpy).toHaveBeenCalled();

      // Wheel down at bottom: should preventDefault
      Object.defineProperty(el, 'scrollTop', { value: 200, writable: true });
      const wheelDownEvent = new WheelEvent('wheel', {
        deltaY: 20,
        cancelable: true,
      });
      const preventDownSpy = vi.spyOn(wheelDownEvent, 'preventDefault');
      el.dispatchEvent(wheelDownEvent);
      expect(preventDownSpy).toHaveBeenCalled();
    });
  });

  describe('useSmartPanel Hook', () => {
    it('manages open/close/toggle and point state', () => {
      let result!: ReturnType<typeof useSmartPanel>;
      const TestHook = () => {
        result = useSmartPanel(false);
        return null;
      };

      render(<TestHook />);
      expect(result.isOpen).toBe(false);

      act(() => result.open());
      expect(result.isOpen).toBe(true);

      act(() => result.close());
      expect(result.isOpen).toBe(false);

      act(() => result.toggle());
      expect(result.isOpen).toBe(true);

      act(() => result.openAtPoint({ x: 50, y: 100 }));
      expect(result.isOpen).toBe(true);
      expect(result.point).toEqual({ x: 50, y: 100 });
    });
  });

  describe('SmartExpandablePanel Component Interactions', () => {
    const mockItems: MenuItem[] = [
      { id: 'item-1', label: '新建会话', shortcut: '⌘N', badge: 'New' },
      {
        id: 'item-2',
        label: '项目设置',
        sublabel: '配置当前项目规则',
        tooltip: '打开项目设置',
      },
      { id: 'item-3', label: '禁用项', disabled: true },
      { id: 'item-4', label: '危险操作', danger: true },
      {
        id: 'item-5',
        label: '高级选项',
        collapsible: true,
        children: [
          { id: 'sub-1', label: '子选项 A' },
          { id: 'sub-2', label: '子选项 B' },
        ],
      },
    ];

    it('renders trigger and opens panel on click', () => {
      const onOpen = vi.fn();
      render(
        <SmartExpandablePanel
          trigger={<button>打开菜单</button>}
          items={mockItems}
          open={true}
          onOpen={onOpen}
        />
      );

      expect(screen.getByText('打开菜单')).toBeInTheDocument();
      expect(screen.getByText('新建会话')).toBeInTheDocument();
      expect(screen.getByText('项目设置')).toBeInTheDocument();
      expect(screen.getByText('⌘N')).toBeInTheDocument();
      expect(screen.getByText('New')).toBeInTheDocument();
    });

    it('filters items when searching and clears query', () => {
      render(
        <SmartExpandablePanel
          items={mockItems}
          open={true}
          enableSearch={true}
          searchPlaceholder="搜索菜单..."
        />
      );

      const input = screen.getByPlaceholderText('搜索菜单...');
      fireEvent.change(input, { target: { value: '设置' } });

      expect(screen.getByText('项目设置')).toBeInTheDocument();
      expect(screen.queryByText('新建会话')).not.toBeInTheDocument();

      const clearBtn = screen.getByLabelText('清空搜索');
      fireEvent.click(clearBtn);

      expect(screen.getByText('新建会话')).toBeInTheDocument();
    });

    it('shows empty result when search yields no matches', () => {
      render(
        <SmartExpandablePanel
          items={mockItems}
          open={true}
          enableSearch={true}
        />
      );

      const input = screen.getByPlaceholderText(/搜索/);
      fireEvent.change(input, { target: { value: 'XYZNotFound' } });

      expect(screen.getByText('未找到匹配结果')).toBeInTheDocument();
    });

    it('triggers onSelect when an enabled item is clicked', () => {
      const handleSelect = vi.fn();
      render(
        <SmartExpandablePanel
          items={mockItems}
          open={true}
          onSelect={handleSelect}
        />
      );

      fireEvent.click(screen.getByText('新建会话'));
      expect(handleSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'item-1', label: '新建会话' })
      );
    });

    it('does not trigger onSelect for disabled items', () => {
      const handleSelect = vi.fn();
      render(
        <SmartExpandablePanel
          items={mockItems}
          open={true}
          onSelect={handleSelect}
        />
      );

      fireEvent.click(screen.getByText('禁用项'));
      expect(handleSelect).not.toHaveBeenCalled();
    });

    it('toggles collapsible accordion items', () => {
      render(<SmartExpandablePanel items={mockItems} open={true} />);

      const toggleBtn = screen.getByText('高级选项');
      expect(screen.getByText('子选项 A')).toBeInTheDocument();

      fireEvent.click(toggleBtn);
      // Click again toggles expanded
      fireEvent.click(toggleBtn);
    });

    it('handles selectable items with emerald checkmark', () => {
      const selectableItems: MenuItem[] = [
        { id: 'opt-1', type: 'selectable', label: '选项 1', selected: true },
        { id: 'opt-2', type: 'selectable', label: '选项 2', selected: false },
      ];

      render(<SmartExpandablePanel items={selectableItems} open={true} />);
      expect(screen.getByText('选项 1')).toBeInTheDocument();
      expect(screen.getByText('选项 2')).toBeInTheDocument();
    });

    it('renders group headers and dividers in grouped mode', () => {
      const groups: MenuGroup[] = [
        {
          id: 'g1',
          title: '常用功能',
          items: [{ id: 'g1-1', label: '功能 1' }],
        },
        {
          id: 'g2',
          title: '系统设置',
          items: [{ id: 'g2-1', label: '功能 2' }],
        },
      ];

      render(
        <SmartExpandablePanel items={groups} open={true} enableDivider={true} />
      );
      expect(screen.getByText('常用功能')).toBeInTheDocument();
      expect(screen.getByText('系统设置')).toBeInTheDocument();
      expect(screen.getByText('功能 1')).toBeInTheDocument();
      expect(screen.getByText('功能 2')).toBeInTheDocument();
    });

    it('handles keyboard roving navigation and escape key', () => {
      const handleClose = vi.fn();
      render(
        <SmartExpandablePanel
          items={mockItems}
          open={true}
          enableSearch={true}
          onClose={handleClose}
        />
      );

      // Press ArrowDown
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

      // Press Escape
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(handleClose).toHaveBeenCalled();
    });
  });
});
