/**
 * Shell store 注册侧效：从 workspaceShellStore 拆出。
 * G13 断环——向 shellReadBridge 注册本 store 的读取/写入闭包，
 * adapterShape / layoutRestorePolicy 经桥访问 shell，不再 import 本文件。
 *
 * 必须在 useWorkspaceShellStore 定义之后执行（依赖其 getState/setState）。
 */

import type { TabSurface } from './types';
import { registerShellReadApi } from './shellReadBridge';

interface ShellStoreAccess {
  getState: () => {
    getActiveTab: () => TabSurface | null;
    openTabs: TabSurface[];
    resetToCleanDraft: (workspaceKey?: string) => void;
  };
  setState: (patch: Partial<{ openTabs: TabSurface[] }>) => void;
}

/**
 * 注册 shell 读取桥接。抽出参数以避免子模块直接 import store 形成自环。
 */
export function registerShellStoreReadApi(store: ShellStoreAccess): void {
  registerShellReadApi({
    getActiveTab: () => store.getState().getActiveTab(),
    getOpenTabs: () => store.getState().openTabs,
    setOpenTabs: (tabs) => store.setState({ openTabs: tabs }),
    resetToCleanDraft: (workspaceKey) =>
      store.getState().resetToCleanDraft(workspaceKey),
  });
}
