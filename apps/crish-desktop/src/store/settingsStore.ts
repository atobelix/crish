/**
 * settingsStore — 设置 / 遥测域（独立 zustand + immer 实例）。
 *
 * ## Scope（T11 拆分）
 *
 * Owns：
 * - `appSettings` / `providers`（应用设置）
 * - `scheduledTasks`（定时任务列表；引擎遥测 cronJobs 合并）
 * - `mcpServers`（MCP 服务）
 * - `tokenUsage`（用量条 token 计数；遥测权威值）
 *
 * 跨域：`syncTelemetryData` 的 worker 侧落盘经 `workerStore.applyTelemetryWorkers`
 * 单向委托（settings → worker，无环）。
 *
 * ## 持久化
 *
 * 分片 key：`crish-settings-v1`，partialize 仅 `scheduledTasks`
 * （用户可配置、值得跨重启保留；appSettings/providers/mcp/tokenUsage
 * 由引擎事件权威回灌，不做本地持久化，避免陈旧数据覆盖）。
 *
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md §3
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import type { CronJob, McpServer, ProviderInfo, Settings } from '../api/clientApi';
import { isDemoMode } from '../api/appMode';
import { sanitizeTokenUsage } from './layout-helpers/store-initializers';
import {
  DEFAULT_TOKEN_USAGE,
  DEMO_TOKEN_USAGE,
  type TelemetrySyncPayload,
  type TokenUsageState,
} from './layout-helpers/store-types';
import { useWorkerStore } from './workerStore';

export interface SettingsStore {
  appSettings: Settings | null;
  providers: ProviderInfo[];
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  tokenUsage: TokenUsageState;
  setProviders: (providers: ProviderInfo[]) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer((set) => ({
          appSettings: null,
          providers: [],
          scheduledTasks: [],
          mcpServers: [],
          tokenUsage: isDemoMode()
            ? { ...DEMO_TOKEN_USAGE }
            : { ...DEFAULT_TOKEN_USAGE },

          setProviders: (providers: ProviderInfo[]) =>
            set((state) => {
              state.providers = Array.isArray(providers) ? providers : [];
            }),

          setAppSettings: (settings: Settings | null) =>
            set((state) => {
              state.appSettings = settings;
            }),

          setScheduledTasks: (tasks: CronJob[]) =>
            set((state) => {
              state.scheduledTasks = Array.isArray(tasks) ? tasks : [];
            }),

          setMcpServers: (servers: McpServer[]) =>
            set((state) => {
              state.mcpServers = Array.isArray(servers) ? servers : [];
            }),

          syncTelemetryData: (data: TelemetrySyncPayload) => {
            set((state) => {
              if (data.tokenUsage) {
                state.tokenUsage = sanitizeTokenUsage(
                  data.tokenUsage,
                  state.tokenUsage
                );
              }
              if (data.mcpServers) {
                state.mcpServers = Array.isArray(data.mcpServers)
                  ? data.mcpServers
                  : state.mcpServers;
              }
              if (data.cronJobs) {
                state.scheduledTasks = Array.isArray(data.cronJobs)
                  ? data.cronJobs
                  : state.scheduledTasks;
              }
            });
            // worker 侧落盘：elapsed 递增 + 活 worker 合并（过滤 killed）——单向依赖
            useWorkerStore.getState().applyTelemetryWorkers({
              activeWorkers: data.activeWorkers,
            });
          },
        })),
        {
          name: 'crish-settings-v1',
          partialize: (s) => ({
            scheduledTasks: s.scheduledTasks,
          }),
        }
      )
    ),
    'SettingsStore'
  )
);
