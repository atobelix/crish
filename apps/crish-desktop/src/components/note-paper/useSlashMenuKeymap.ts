/**
 * slash 浮层键盘漫游（SD-13）
 *
 * ↑↓ 移动高亮；Enter 确认；Escape 关闭。仅 open 时监听。
 * 跳过 IME composing / Process 键。
 * 结合 LeafScope 与焦点包含守卫，杜绝非活跃分屏全局截获按键。
 */

import { useEffect } from 'react';
import type { SlashMenuModel } from '@crish/block-paper';
import { useLeafScope } from '../../contexts/LeafScopeContext';

export type UseSlashMenuKeymapOptions = {
  /** menu 是否 open（关则不挂 listener） */
  open: boolean;
  menu: SlashMenuModel;
  runSelectActive: () => void | Promise<void>;
  finishClose: () => void;
  containerRef?: React.RefObject<HTMLElement | null>;
};

/** 键盘 ↑↓ Enter Escape → model / select / close */
export function useSlashMenuKeymap(options: UseSlashMenuKeymapOptions): void {
  const { open, menu, runSelectActive, finishClose, containerRef } = options;
  const scope = useLeafScope();

  useEffect(() => {
    if (!open) return;

    const onKey = (ev: KeyboardEvent) => {
      if (ev.isComposing || ev.key === 'Process') return;

      // 1. 所属分屏未激活时守卫：非活跃窗口不吞咽按键
      if (scope.inLeafScope && !scope.isActive) return;

      // 2. 焦点包含守卫：若焦点位于当前分屏外部或非本容器/编辑器，不拦截按键
      const activeEl = document.activeElement;
      if (scope.inLeafScope && scope.leafRootRef.current) {
        if (
          activeEl &&
          activeEl !== document.body &&
          !scope.leafRootRef.current.contains(activeEl)
        ) {
          return;
        }
      }

      if (containerRef?.current) {
        if (
          activeEl &&
          activeEl !== document.body &&
          !containerRef.current.contains(activeEl)
        ) {
          return;
        }
      }

      switch (ev.key) {
        case 'ArrowDown': {
          ev.preventDefault();
          menu.moveActive(1);
          break;
        }
        case 'ArrowUp': {
          ev.preventDefault();
          menu.moveActive(-1);
          break;
        }
        case 'Enter': {
          ev.preventDefault();
          void runSelectActive();
          break;
        }
        case 'Escape': {
          ev.preventDefault();
          ev.stopPropagation();
          menu.close();
          finishClose();
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    open,
    menu,
    runSelectActive,
    finishClose,
    containerRef,
    scope.inLeafScope,
    scope.isActive,
    scope.leafRootRef,
  ]);
}
