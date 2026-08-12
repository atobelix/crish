/**
 * slash 浮层键盘漫游（SD-13）
 *
 * ↑↓ 移动高亮；Enter 确认；Escape 关闭。仅 open 时监听。
 * 跳过 IME composing / Process 键。
 *
 * **≠ EL-01**；**≠ `/` 键触发全路径 e2e**。
 */

import { useEffect } from 'react';
import type { SlashMenuModel } from '@crish/block-paper';

export type UseSlashMenuKeymapOptions = {
  /** menu 是否 open（关则不挂 listener） */
  open: boolean;
  menu: SlashMenuModel;
  runSelectActive: () => void | Promise<void>;
  finishClose: () => void;
};

/** 键盘 ↑↓ Enter Escape → model / select / close */
export function useSlashMenuKeymap(options: UseSlashMenuKeymapOptions): void {
  const { open, menu, runSelectActive, finishClose } = options;

  useEffect(() => {
    if (!open) return;

    const onKey = (ev: KeyboardEvent) => {
      if (ev.isComposing || ev.key === 'Process') return;
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
  }, [open, menu, runSelectActive, finishClose]);
}
