/**
 * 快捷键冲突状态订阅：把 ShortcutService 的冲突快照接入 React 渲染。
 * 快照引用由服务侧保证稳定（冲突集无变化不换新数组），可直接喂 useSyncExternalStore。
 */
import { useSyncExternalStore } from 'react';
import {
  ShortcutService,
  type ShortcutConflict,
} from '../services/ShortcutService';

export function useShortcutConflicts(): ShortcutConflict[] {
  const service = ShortcutService.getInstance();
  return useSyncExternalStore(
    (onStoreChange) => service.subscribeConflicts(onStoreChange),
    () => service.getConflicts(),
    () => service.getConflicts()
  );
}
