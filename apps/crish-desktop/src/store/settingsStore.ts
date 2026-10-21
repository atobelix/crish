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
 * 分片 key：`crish-settings-v1`，partialize 仅 `scheduledTasks`。
 * 用户接入的 MCP 名单写在 `crish_settings.mcpServers`，由 setAppSettings 投影到
 * `mcpServers`。这里不再另存一份，避免两份缓存互相覆盖。
 * appSettings / providers / tokenUsage 仍由引擎或设置载荷回灌。
 *
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md §3
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import type {
  CronJob,
  McpServer,
  ProviderInfo,
  Settings,
} from '../api/clientApi';
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
  /** 启动时是否自动探测并呈现外部活跃长对话预览（Claude Code / Codex） */
  autoShowExternalSessionOnStartup: boolean;
  setProviders: (providers: ProviderInfo[]) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  /** 用户改过名单之后，刷新和遥测不能再用另一份数组把刚导入的服务冲掉。 */
  mcpRosterEpoch: number;
  lockMcpRoster: () => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;
  setAutoShowExternalSessionOnStartup: (enabled: boolean) => void;
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
          mcpRosterEpoch: 0,
          autoShowExternalSessionOnStartup: true,
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
              // 缺字段或空设置不得清掉已接入名单；显式空数组表示用户已全部移除。
              if (
                settings &&
                Array.isArray(settings.mcpServers) &&
                state.mcpRosterEpoch === 0
              ) {
                state.mcpServers = settings.mcpServers;
              }
            }),

          setScheduledTasks: (tasks: CronJob[]) =>
            set((state) => {
              state.scheduledTasks = Array.isArray(tasks) ? tasks : [];
            }),

          setMcpServers: (servers: McpServer[]) =>
            set((state) => {
              state.mcpServers = Array.isArray(servers) ? servers : [];
            }),

          lockMcpRoster: () =>
            set((state) => {
              state.mcpRosterEpoch += 1;
            }),

          syncTelemetryData: (data: TelemetrySyncPayload) => {
            set((state) => {
              if (data.tokenUsage) {
                state.tokenUsage = sanitizeTokenUsage(
                  data.tokenUsage,
                  state.tokenUsage
                );
              }
              if (data.mcpServers && state.mcpRosterEpoch === 0) {
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

          setAutoShowExternalSessionOnStartup: (enabled: boolean) =>
            set((state) => {
              state.autoShowExternalSessionOnStartup = Boolean(enabled);
            }),
        })),
        {
          name: 'crish-settings-v1',
          partialize: (s) => ({
            scheduledTasks: s.scheduledTasks,
            autoShowExternalSessionOnStartup:
              s.autoShowExternalSessionOnStartup,
          }),
        }
      )
    ),
    'SettingsStore'
  )
);

/** 扩展页、设置页对 MCP 名单的用户写入。锁定后不被刷新或遥测覆盖。 */
export function commitUserMcpRoster(servers: McpServer[]): void {
  const store = useSettingsStore.getState();
  store.lockMcpRoster();
  store.setMcpServers(servers);
}
