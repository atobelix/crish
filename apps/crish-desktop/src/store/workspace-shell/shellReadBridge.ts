/**
 * Shell 状态读取桥（G13 断环：依赖倒置）。
 *
 * workspaceShellStore 是 shell 状态的 write owner；adapterShape / layoutRestorePolicy
 * 需要读取 openTabs / activeTab 做 fallback 定位，但直接 import workspaceShellStore
 * 会形成 adapterShape ↔ workspaceShellStore / layoutRestorePolicy ↔ workspaceShellStore
 * 环。本桥把「读 shell」能力下沉为注册式接口：
 *
 * - 低层（adapterShape / layoutRestorePolicy）只依赖本文件（无 store 依赖）；
 * - workspaceShellStore 模块加载时注册自身 getState 闭包（高层向低层注入实现）。
 *
 * 未注册（冷启动早期）时返回 null，调用方按既有 try/catch fallback 语义处理。
 */
import type { TabSurface } from './types';

export interface ShellReadApi {
  getActiveTab: () => TabSurface | null;
  getOpenTabs: () => TabSurface[];
  /** 写入 openTabs（syncShellDocksFromTree 反向投影用；可选） */
  setOpenTabs?: (tabs: TabSurface[]) => void;
  /** 冷启动兜底（applySafeCleanColdStart 用；可选） */
  resetToCleanDraft?: (workspaceKey?: string) => void;
}

let shellReadApi: ShellReadApi | null = null;

/** 由 workspaceShellStore 注册（模块加载时调用一次，幂等）。 */
export function registerShellReadApi(api: ShellReadApi): void {
  shellReadApi = api;
}

/** 读取已注册的 shell 读取器；未注册时返回 null。 */
export function getShellReadApi(): ShellReadApi | null {
  return shellReadApi;
}

/** 测试用：清空注册。 */
export function resetShellReadApiForTests(): void {
  shellReadApi = null;
}
