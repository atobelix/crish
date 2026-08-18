/**
 * 工作区 / 标签 DnD / 面板相关 action 实现。
 * 仍挂在同一 useLayoutStore，不单独建 zustand store。
 *
 * T4-7 拆分：按域拆为 workspaceCreateActions / workspaceSwitchActions /
 * workspaceCleanupActions；共享类型与辅助位于 workspaceActionsCore。
 * 本文件保留为 re-export hub + createWorkspaceActions 装配，消费方 import 路径不变。
 *
 * 面板开合/收尾委托 layoutHelpers 纯 API，避免 ghost chat 列与空壳布局。
 */

// 共享类型与辅助 re-export（消费方仍经 './workspaceActions' 导入）
export type {
  LayoutSnapshot,
  DraggedTabState,
  WorkspaceStoreSlice,
  WorkspaceImmerSet,
  WorkspaceStoreGet,
} from './workspaceActionsCore';

import type {
  WorkspaceImmerSet,
  WorkspaceStoreGet,
  WorkspaceStoreSlice,
} from './workspaceActionsCore';
import type { WorkspaceCreateActionsSlice } from './workspaceCreateActions';
import type { WorkspaceSwitchActionsSlice } from './workspaceSwitchActions';
import type { WorkspaceCleanupActionsSlice } from './workspaceCleanupActions';
import {
  createWorkspaceCreateActions,
} from './workspaceCreateActions';
import {
  createWorkspaceSwitchActions,
} from './workspaceSwitchActions';
import {
  createWorkspaceCleanupActions,
} from './workspaceCleanupActions';

/** 工作区 / DnD / 面板域 action 签名（与 LayoutStore 同名方法一致） */
export interface WorkspaceActions
  extends WorkspaceCreateActionsSlice,
    WorkspaceSwitchActionsSlice,
    WorkspaceCleanupActionsSlice {}

/**
 * 创建工作区域 actions，供 layoutStore 的 immer((set,get)=>({...})) 展开。
 * T4-7：三域实现已拆分至子文件，本函数仅装配。
 */
export function createWorkspaceActions<T extends WorkspaceStoreSlice>(
  set: WorkspaceImmerSet<T>,
  get: WorkspaceStoreGet<T>,
): WorkspaceActions {
  return {
    ...createWorkspaceCreateActions<T>(set, get),
    ...createWorkspaceSwitchActions<T>(set, get),
    ...createWorkspaceCleanupActions<T>(set, get),
  };
}
