/**
 * tabMode 单一写端投影：layoutStore.tabModeEnabled →
 * workspaceStore 字段 + 遗留 columns 合并/拆分 + 右坞树重投影。
 * 不持有第三份状态。
 */
import { useLayoutStore } from './layoutStore';
import { useWorkspaceStore } from './workspaceStore';
import { reprojectAllSessionDocks } from './workspace-shell/adapterShape';
import { registerTabModeReader } from './workspace-shell/tabModeReadBridge';

function applyTabMode(on: boolean): void {
  useWorkspaceStore.getState().applyTabModeEnabled(on);
  reprojectAllSessionDocks();
}

/** 装配投影；返回退订。bootstrapStores 调一次。 */
export function initTabModeProjection(): () => void {
  registerTabModeReader(() => useLayoutStore.getState().tabModeEnabled);
  applyTabMode(useLayoutStore.getState().tabModeEnabled);
  return useLayoutStore.subscribe((state, prev) => {
    if (state.tabModeEnabled === prev.tabModeEnabled) return;
    applyTabMode(state.tabModeEnabled);
  });
}
