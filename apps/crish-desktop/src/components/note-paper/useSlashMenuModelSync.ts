/**
 * SlashMenuModel → React 同步（SD-13）
 *
 * model 非 React 状态；subscribe + 快照指纹作 getSnapshot，驱动重绘。
 * **≠ EL-01**。
 */

import { useSyncExternalStore } from 'react';
import type { SlashMenuModel } from '@crish/block-paper';

/**
 * 订阅 menu；返回版本指纹（调用方 void 或作 deps）。
 * SSR getServerSnapshot 固定 `'ssr'`。
 */
export function useSlashMenuModelSync(
  menu: SlashMenuModel,
  syncToken: number | string = 0
): string {
  return useSyncExternalStore(
    (onStoreChange) => menu.subscribe(onStoreChange),
    () => {
      // 用快照指纹作 getSnapshot（避免无限循环）
      const s = menu.getSnapshot();
      return [
        s.open ? '1' : '0',
        s.blockId ?? '',
        String(s.offset),
        s.query,
        String(s.activeIndex),
        s.items.map((i) => i.id).join(','),
        String(syncToken),
      ].join('|');
    },
    () => 'ssr'
  );
}
