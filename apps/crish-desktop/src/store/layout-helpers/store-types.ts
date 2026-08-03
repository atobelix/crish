import type { SettingsTabType, ColumnState } from '../types';
import type { McpServer, CronJob } from '../../api/clientApi';
import {
  DEFAULT_SHELL_CHROME,
  SHELL_CHROME_IDS,
  SHELL_CHROME_STORAGE_KEY,
  parseShellChromeMode,
  type ShellChromeMode,
} from '../../api/shellChrome';

/** UI 密度三档 — 与 tokens `[data-ui-size]` / 设置外观一致 */
export type UiSize = 'small' | 'medium' | 'large';

export const UI_SIZE_IDS = [
  'small',
  'medium',
  'large',
] as const satisfies readonly UiSize[];

export const DEFAULT_UI_SIZE: UiSize = 'medium';

export type { ShellChromeMode };
export {
  DEFAULT_SHELL_CHROME,
  SHELL_CHROME_IDS,
  SHELL_CHROME_STORAGE_KEY,
  parseShellChromeMode,
};

/** 设置侧栏合法 tab（与 SettingsTabType 同步；openSettings 白名单） */
export const SETTINGS_TAB_IDS = [
  'profile',
  'appearance',
  'personalize',
  'models',
  'usage',
  'schedule',
  'rules',
  'shortcuts',
  'skills',
  'mcp',
  'plugins',
  'security',
] as const satisfies readonly SettingsTabType[];

export const DEFAULT_SETTINGS_TAB: SettingsTabType = 'profile';

export const SETTINGS_TAB_SET: ReadonlySet<string> = new Set(SETTINGS_TAB_IDS);

/**
 * 遥测 / 用量条 token 计数。
 * T-47：扩展 4D 可选字段（cacheRead / cacheWrite / savedCost）——
 * 全可选向后兼容；undefined = 未上报（UI 隐藏而非显示 0）。
 */
export type TokenUsageState = {
  input: number;
  inputMax: number;
  output: number;
  outputMax: number;
  cost: number;
  /** 缓存命中读取 token（4D；undefined = 未上报） */
  cacheRead?: number;
  /** 缓存写入 token（4D；undefined = 未上报） */
  cacheWrite?: number;
  /** 缓存节省金额 USD（4D：2D 全价 - 4D 实际价；undefined = 未上报） */
  savedCost?: number;
};

/** 产品态安全默认（全 0；上限与历史 demo 一致） */
export const DEFAULT_TOKEN_USAGE: TokenUsageState = {
  input: 0,
  inputMax: 160000,
  output: 0,
  outputMax: 40000,
  cost: 0,
};

/** demo 展示用假数据（仅 isDemoMode） */
export const DEMO_TOKEN_USAGE: TokenUsageState = {
  input: 115482,
  inputMax: 160000,
  output: 24930,
  outputMax: 40000,
  cost: 0.345,
};

/** 后台 worker / cron 触发条目 */
export type ActiveWorkerState = {
  id: string;
  taskName: string;
  elapsedSeconds: number;
};

/** 首个工作区稳定 id（empty seed / close 重种共用） */
export const DEFAULT_WORKSPACE_ID = 'ws-0';

/** localStorage keys（集中，避免字面量漂移） */
export const UI_SIZE_STORAGE_KEY = 'crish_ui_size';
export const TAB_MODE_STORAGE_KEY = 'crish_tab_mode';

/** syncTelemetryData 入参（去掉 data: any） */
export type TelemetrySyncPayload = {
  tokenUsage?: Partial<TokenUsageState> | TokenUsageState;
  activeWorkers?: ActiveWorkerState[];
  mcpServers?: McpServer[];
  cronJobs?: CronJob[];
};

export interface WorkspaceLayoutSnapshot {
  version: number;
  workspaces: Array<{
    id: string;
    columns: ColumnState[];
  }>;
  sidebarCollapsed: boolean;
  activeWorkspaceIndex: number;
}
