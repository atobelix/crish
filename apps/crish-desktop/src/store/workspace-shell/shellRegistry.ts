/**
 * Shell store 注册侧效：从 workspaceShellStore 拆出。
 * G13 断环——向 shellReadBridge 注册本 store 的读取闭包。
 */

import type { SessionTab } from './types';
import { registerShellReadApi } from './shellReadBridge';

interface ShellStoreAccess {
  getState: () => {
    getActiveTab: () => SessionTab | null;
    resetToCleanDraft: (workspaceKey?: string) => void;
    closeTabBySessionId: (sessionId: string, workspaceKey?: string) => void;
  };
}

export function registerShellStoreReadApi(store: ShellStoreAccess): void {
  registerShellReadApi({
    getActiveTab: () => store.getState().getActiveTab(),
    resetToCleanDraft: (workspaceKey) =>
      store.getState().resetToCleanDraft(workspaceKey),
    closeTabBySessionId: (sessionId) =>
      store.getState().closeTabBySessionId(sessionId),
  });
}
