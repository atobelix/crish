// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/internal/roving-focus/__tests__/useRovingFocus.test.ts
 * useRovingFocus 核心键盘漫游与无障碍状态机测试
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';
import { useRovingFocus } from '../useRovingFocus';
import {
  MenuCollectionProvider,
  useCollectionItem,
} from '../MenuCollectionContext';
import type { MenuItemRecord } from '../types';

describe('useRovingFocus 漫游引擎核心状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('1. DOM Roving TabIndex 模式', () => {
    const items: MenuItemRecord[] = [
      { id: 'item-1', textValue: 'Alpha' },
      { id: 'item-2', textValue: 'Beta' },
      { id: 'item-3', textValue: 'Gamma' },
    ];

    it('默认 autoFocus 自动选中首个可用项并设置 tabIndex=0，其余为 -1', () => {
      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          mode: 'dom',
          autoFocus: true,
        })
      );

      expect(result.current.focusedIndex).toBe(0);
      expect(result.current.focusedId).toBe('item-1');

      const itemProps0 = result.current.getItemProps(items[0], 0);
      const itemProps1 = result.current.getItemProps(items[1], 1);
      const containerProps = result.current.getContainerProps();

      expect(itemProps0.tabIndex).toBe(0);
      expect(itemProps1.tabIndex).toBe(-1);
      expect(containerProps.tabIndex).toBe(-1);
      expect(containerProps['data-floating-layer']).toBe('true');
      expect(containerProps['data-slot']).toBe('menu-content');
    });

    it('ArrowDown 与 ArrowUp 依次上下移动聚焦，且支持循环', () => {
      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          mode: 'dom',
          loop: true,
          autoFocus: true,
        })
      );

      expect(result.current.focusedIndex).toBe(0);

      // ArrowDown -> 1
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(1);

      // ArrowDown -> 2
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(2);

      // ArrowDown 循环 -> 0
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(0);

      // ArrowUp 向上循环 -> 2
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(2);
    });

    it('Home 和 End 分别直达首项与末项', () => {
      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          mode: 'dom',
          autoFocus: true,
        })
      );

      // End -> 2
      act(() => {
        result.current.handleKeyDown({
          key: 'End',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(2);

      // Home -> 0
      act(() => {
        result.current.handleKeyDown({
          key: 'Home',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(0);
    });
  });

  describe('2. Virtual ActiveDescendant 模式', () => {
    const items: MenuItemRecord[] = [
      { id: 'opt-1', textValue: 'Apple' },
      { id: 'opt-2', textValue: 'Banana' },
    ];

    it('容器具备 tabIndex=0 且通过 aria-activedescendant 标记当前项，子项 tabIndex 恒为 -1', () => {
      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          mode: 'virtual',
          autoFocus: true,
          role: 'listbox',
          slot: 'select-content',
        })
      );

      const containerProps = result.current.getContainerProps();
      expect(containerProps.tabIndex).toBe(0);
      expect(containerProps['aria-activedescendant']).toBe('opt-1');
      expect(containerProps.role).toBe('listbox');
      expect(containerProps['data-slot']).toBe('select-content');

      const itemProps0 = result.current.getItemProps(items[0], 0);
      const itemProps1 = result.current.getItemProps(items[1], 1);
      expect(itemProps0.tabIndex).toBe(-1);
      expect(itemProps0['aria-selected']).toBe(true);
      expect(itemProps1.tabIndex).toBe(-1);
      expect(itemProps1['aria-selected']).toBeUndefined();
    });
  });

  describe('3. 跳过 disabled / separator 与防死锁循环守卫', () => {
    const mixedItems: MenuItemRecord[] = [
      { id: '1', textValue: 'Enabled 1' },
      { id: 'sep-1', isSeparator: true },
      { id: '2', textValue: 'Disabled 2', disabled: true },
      { id: '3', textValue: 'Enabled 3' },
      { id: '4', textValue: 'Disabled 4', disabled: true },
    ];

    it('ArrowDown 自动跨过 separator 与 disabled 项', () => {
      const { result } = renderHook(() =>
        useRovingFocus({
          items: mixedItems,
          mode: 'dom',
          autoFocus: true,
        })
      );

      expect(result.current.focusedIndex).toBe(0); // Enabled 1

      // 按 ArrowDown，应跳过 separator(1) 和 disabled(2)，直达 3 (Enabled 3)
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(result.current.focusedIndex).toBe(3);

      // 再次按 ArrowDown，跳过 disabled(4)，循环回 0 (Enabled 1)
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(result.current.focusedIndex).toBe(0);
    });

    it('退化态：全列表皆为 disabled / separator 时，内置循环守卫确保不卡死、不无限循环', () => {
      const allDisabled: MenuItemRecord[] = [
        { id: 'd-1', disabled: true, textValue: 'None' },
        { id: 's-1', isSeparator: true },
        { id: 'd-2', disabled: true, textValue: 'None 2' },
      ];

      const { result } = renderHook(() =>
        useRovingFocus({
          items: allDisabled,
          autoFocus: true,
        })
      );

      // 无可用项，focusedIndex 为 -1
      expect(result.current.focusedIndex).toBe(-1);

      // 按下 ArrowDown，防死锁守卫保证循环 len 次后安全退出
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(result.current.focusedIndex).toBe(-1);

      // 按下 Home / End 也安全
      act(() => {
        result.current.handleKeyDown({
          key: 'Home',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });
      expect(result.current.focusedIndex).toBe(-1);
    });
  });

  describe('4. 焦点安全还原协议（Focus Restoration Protocol）', () => {
    it('按下 Escape 关闭：触发 onClose("escape") 并安全将焦点还原至触发源', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      const triggerRef = { current: trigger };
      const onClose = vi.fn();

      const items: MenuItemRecord[] = [{ id: '1', textValue: 'Item 1' }];

      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          triggerRef,
          onClose,
          autoFocus: true,
        })
      );

      // 按下 Escape
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      act(() => {
        result.current.handleKeyDown({
          key: 'Escape',
          preventDefault,
          stopPropagation,
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledWith('escape');
      expect(document.activeElement).toBe(trigger);

      trigger.remove();
    });

    it('按下 Enter 选中关闭：触发 onClose("select") 并将焦点还原至触发源', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const triggerRef = { current: trigger };
      const onSelect = vi.fn();
      const onClose = vi.fn();
      const items: MenuItemRecord[] = [{ id: '1', textValue: 'Item 1' }];

      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          triggerRef,
          onSelect,
          onClose,
          autoFocus: true,
        })
      );

      act(() => {
        result.current.handleKeyDown({
          key: 'Enter',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(onSelect).toHaveBeenCalledWith(items[0], 0);
      expect(onClose).toHaveBeenCalledWith('select');
      expect(document.activeElement).toBe(trigger);

      trigger.remove();
    });

    it('按下 Tab 键：触发 onClose("outside")，但严禁强行拉回焦点至触发源', () => {
      const trigger = document.createElement('button');
      const otherInput = document.createElement('input');
      document.body.appendChild(trigger);
      document.body.appendChild(otherInput);

      const triggerRef = { current: trigger };
      const onClose = vi.fn();
      const items: MenuItemRecord[] = [{ id: '1', textValue: 'Item 1' }];

      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          triggerRef,
          onClose,
          autoFocus: true,
        })
      );

      // 用户物理聚焦转移到 otherInput
      otherInput.focus();

      act(() => {
        result.current.handleKeyDown({
          key: 'Tab',
          preventDefault: vi.fn(),
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(onClose).toHaveBeenCalledWith('outside');
      // 严禁将焦点抢回 trigger
      expect(document.activeElement).toBe(otherInput);

      trigger.remove();
      otherInput.remove();
    });
  });

  describe('5. 级联子菜单交互与事件冒泡隔离', () => {
    it('在拥有子菜单的项上按 ArrowRight 触发 onSubmenuExpand 并阻止冒泡', () => {
      const onSubmenuExpand = vi.fn();
      const items: MenuItemRecord[] = [
        { id: '1', textValue: 'Item With Sub', hasSubmenu: true },
        { id: '2', textValue: 'Normal Item' },
      ];

      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          autoFocus: true,
          cascade: {
            onSubmenuExpand,
          },
        })
      );

      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowRight',
          preventDefault,
          stopPropagation,
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
      expect(onSubmenuExpand).toHaveBeenCalledWith(items[0], 0);
    });

    it('在子菜单中按 ArrowLeft 触发 onSubmenuCollapse 并绝对隔离冒泡', () => {
      const onSubmenuCollapse = vi.fn();
      const items: MenuItemRecord[] = [
        { id: 'sub-1', textValue: 'Sub Item 1' },
      ];

      const { result } = renderHook(() =>
        useRovingFocus({
          items,
          autoFocus: true,
          cascade: {
            isSubmenu: true,
            onSubmenuCollapse,
          },
        })
      );

      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowLeft',
          preventDefault,
          stopPropagation,
          target: document.createElement('div'),
        } as unknown as React.KeyboardEvent<HTMLElement>);
      });

      expect(preventDefault).toHaveBeenCalled();
      expect(stopPropagation).toHaveBeenCalled();
      expect(onSubmenuCollapse).toHaveBeenCalled();
    });
  });

  describe('6. 声明式 JSX 收集器 MenuCollectionContext 协同测试', () => {
    const DeclarativeItem: React.FC<{
      id: string;
      textValue: string;
      disabled?: boolean;
    }> = ({ id, textValue, disabled }) => {
      const ref = useRef<HTMLDivElement>(null);
      useCollectionItem({ id, textValue, disabled, ref });
      return React.createElement('div', { ref, id }, textValue);
    };

    const DeclarativeMenu: React.FC<{
      onReady?: (roving: ReturnType<typeof useRovingFocus>) => void;
    }> = ({ onReady }) => {
      const roving = useRovingFocus({ autoFocus: true });
      React.useEffect(() => {
        onReady?.(roving);
      });

      return React.createElement(
        'div',
        roving.getContainerProps(),
        React.createElement(DeclarativeItem, {
          id: 'dec-1',
          textValue: 'First',
        }),
        React.createElement(DeclarativeItem, {
          id: 'dec-2',
          textValue: 'Second',
        }),
        React.createElement(DeclarativeItem, {
          id: 'dec-3',
          textValue: 'Third',
        })
      );
    };

    it('声明式子项通过 DOM compareDocumentPosition 物理自动收集', () => {
      let rovingInstance: ReturnType<typeof useRovingFocus> | null = null;

      render(
        React.createElement(
          MenuCollectionProvider,
          null,
          React.createElement(DeclarativeMenu, {
            onReady: (r) => {
              rovingInstance = r;
            },
          })
        )
      );

      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(screen.getByText('Third')).toBeInTheDocument();

      // 验证 rovingInstance 可以自适应收集并导航
      expect(rovingInstance).not.toBeNull();
      act(() => {
        rovingInstance?.focusFirst();
      });
      expect(rovingInstance?.focusedIndex).toBe(0);

      act(() => {
        rovingInstance?.focusNext();
      });
      expect(rovingInstance?.focusedIndex).toBe(1);
    });
  });
});
