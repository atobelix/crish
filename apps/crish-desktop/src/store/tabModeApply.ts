/**
 * tabMode 单一写端：layoutStore.tabModeEnabled → workspaceStore 字段。
 * 禁止对树投影。抽屉内单条 vs 垂直堆叠由维 05 读此 flag。
 */
import { useLayoutStore } from './layoutStore';
import { useWorkspaceStore } from './workspaceStore';
import { registerTabModeReader } from './workspace-shell/tabModeReadBridge';

function applyTabMode(on: boolean): void {
  useWorkspaceStore.getState().applyTabModeEnabled(on);
}

/** 装配 flag 同步；返回退订。bootstrapStores 调一次。 */
export function initTabModeProjection(): () => void {
  registerTabModeReader(() => useLayoutStore.getState().tabModeEnabled);
  applyTabMode(useLayoutStore.getState().tabModeEnabled);
  return useLayoutStore.subscribe((state, prev) => {
    if (state.tabModeEnabled === prev.tabModeEnabled) return;
    applyTabMode(state.tabModeEnabled);
  });
}
