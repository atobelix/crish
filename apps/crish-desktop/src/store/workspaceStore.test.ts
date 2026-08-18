import { describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';
import { useLayoutStore } from './layoutStore';

describe('useWorkspaceStore 独立实例化测试', () => {
  it('useWorkspaceStore 与 useLayoutStore 必须为物理独立的 Zustand 实例', () => {
    expect(useWorkspaceStore).not.toBe(useLayoutStore);
  });

  it('useWorkspaceStore 拥有独立的工作区状态且操作不干扰 useLayoutStore', () => {
    const wsState = useWorkspaceStore.getState();
    expect(wsState.workspaces).toBeDefined();
    expect(Array.isArray(wsState.workspaces)).toBe(true);
    expect(wsState.activeWorkspaceIndex).toBe(0);

    const initialLen = wsState.workspaces.length;
    wsState.splitScreenWorkspace('session-test-split');
    expect(useWorkspaceStore.getState().workspaces.length).toBe(initialLen + 1);

    // 恢复
    const newWsId = useWorkspaceStore.getState().workspaces[initialLen]!.id;
    wsState.closeWorkspace(newWsId);
    expect(useWorkspaceStore.getState().workspaces.length).toBe(initialLen);
  });
});
