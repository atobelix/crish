/**
 * tree→shell dock 反向投影（显式生命周期，T06.9.1）。
 *
 * 原模块级永久订阅（AA-03 Q06：永不退订）改为显式注册/退订：
 * - bootstrapServices 启动时 registerTreeDockSync()，cleanup 时退订；
 * - 重复注册幂等（StrictMode 双执行安全）；
 * - 投影抑制：shell→tree 投影写树期间经 withTreeDockProjectionSuppressed
 *   置位 → 本订阅跳过反向同步，消除 shell↔tree 双向投影互触发回环。
 *
 * 语义：用户拖拽 / 分屏等纯 tree 变更（非 shell 投影路径）仍照常反推
 * shell rightDock 元数据，保证后续 applyDockToTree 重投影不拿旧 dock 覆盖树。
 */

import { useLayoutTreeStore } from '../layout-tree';
import type { LayoutTree } from '../layout-tree/types';
import { syncShellDocksFromTree } from './layoutRestorePolicy';
import { isTreeDockProjectionSuppressed } from './treeDockProjection';

let treeDockSyncRegistered = false;
let lastSyncedTree: LayoutTree | null = null;

/**
 * 注册 tree→shell dock 反向投影订阅，返回退订函数。
 * 幂等：已注册时返回 no-op；退订后可重新注册。
 */
export function registerTreeDockSync(): () => void {
  if (treeDockSyncRegistered) return () => {};
  treeDockSyncRegistered = true;
  lastSyncedTree = useLayoutTreeStore.getState().tree;
  const unsubscribe = useLayoutTreeStore.subscribe((state) => {
    if (state.tree !== lastSyncedTree) {
      lastSyncedTree = state.tree;
      if (isTreeDockProjectionSuppressed()) return;
      try {
        syncShellDocksFromTree(state.tree);
      } catch {
        /* 反向投影失败不阻断 tree 渲染 */
      }
    }
  });
  return () => {
    unsubscribe();
    treeDockSyncRegistered = false;
    lastSyncedTree = null;
  };
}
