/**
 * Shell 状态读取桥（G13 断环：依赖倒置）。
 *
 * 已删除 getOpenTabs / setOpenTabs（标签不在 shell）。
 * 保留 getActiveTab / resetToCleanDraft / closeTabBySessionId。
 */

import type { SessionTab } from './types';

export interface ShellReadApi {
  getActiveTab: () => SessionTab | null;
  /** 冷启动兜底（applySafeCleanColdStart 用） */
  resetToCleanDraft?: (workspaceKey?: string) => void;
  /** 级联删除会话时摘 tab（SessionCoordinator） */
  closeTabBySessionId?: (sessionId: string) => void;
}

let shellReadApi: ShellReadApi | null = null;

export function registerShellReadApi(api: ShellReadApi): void {
  shellReadApi = api;
}

export function getShellReadApi(): ShellReadApi | null {
  return shellReadApi;
}
