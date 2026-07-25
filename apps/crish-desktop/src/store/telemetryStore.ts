import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { isDemoMode } from '../api/appMode';
import { MAX_TERMINAL_SESSIONS, MAX_DIFF_FILES } from '@crish/shared-utils/browser';
import {
  DEFAULT_TOKEN_USAGE,
  DEMO_TOKEN_USAGE,
  finiteNumber,
  sanitizeTokenUsage,
  sanitizeActiveWorkers,
  type TokenUsageState,
  type ActiveWorkerState,
  type TelemetrySyncPayload,
} from './layoutStore';
import type { CronJob, McpServer } from '../api/clientApi';

type TelemetryStoreData = {
  appSettings: any | null;
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  providers: any[];
  activeWorkers: ActiveWorkerState[];
  tokenUsage: TokenUsageState;
  killedWorkerIds: string[];
  hydratedFromDisk: boolean;
  manuallyTriggeredWorkers: ActiveWorkerState[];
};

type TelemetryStore = TelemetryStoreData & {
  setAppSettings: (settings: any | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  setProviders: (providers: any[]) => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;
  killWorker: (id: string, taskName: string) => void;
  triggerCronJobNow: (prompt: string) => void;
  killWorkerIds: string[];
};

const _initialTokenUsage = isDemoMode()
  ? { ...DEMO_TOKEN_USAGE }
  : { ...DEFAULT_TOKEN_USAGE };

const _telemetryData: TelemetryStoreData = {
  appSettings: null,
  scheduledTasks: [],
  mcpServers: [],
  providers: [],
  activeWorkers: [],
  tokenUsage: _initialTokenUsage,
  killedWorkerIds: [],
  hydratedFromDisk: false,
  manuallyTriggeredWorkers: [],
};

export const useTelemetryStore = create<TelemetryStore>()(
  withDevtools(
    withLogger(
      immer((set: any, get: any) => ({
        ..._telemetryData,
        killWorkerIds: [],

        setAppSettings: (settings: any) => set((state: any) => {
          state.appSettings = settings;
        }),
        setScheduledTasks: (tasks: any) => set((state: any) => {
          state.scheduledTasks = Array.isArray(tasks) ? tasks : [];
        }),
        setMcpServers: (servers: any) => set((state: any) => {
          state.mcpServers = Array.isArray(servers) ? servers : [];
        }),
        setProviders: (providers: any) => set((state: any) => {
          state.providers = Array.isArray(providers) ? providers : [];
        }),
        syncTelemetryData: (data: TelemetrySyncPayload) => set((state: any) => {
          if (data.tokenUsage) {
            state.tokenUsage = sanitizeTokenUsage(data.tokenUsage, state.tokenUsage);
          }
          state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map((w: any) => ({
            id: w.id,
            taskName: w.taskName,
            elapsedSeconds: Math.max(0, finiteNumber(w.elapsedSeconds, 0) + 2),
          }));
          if (data.activeWorkers) {
            const live = sanitizeActiveWorkers(data.activeWorkers).filter(
              (w: any) => !state.killedWorkerIds.includes(w.id),
            );
            state.activeWorkers = [...live, ...state.manuallyTriggeredWorkers];
          }
          if (data.mcpServers) {
            state.mcpServers = Array.isArray(data.mcpServers) ? data.mcpServers : state.mcpServers;
          }
          if (data.cronJobs) {
            state.scheduledTasks = Array.isArray(data.cronJobs) ? data.cronJobs : state.scheduledTasks;
          }
        }),
        killWorker: (id: string, _taskName: string) => set((state: any) => {
          if (!id) return;
          state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.filter((w: any) => w.id !== id);
          state.activeWorkers = state.activeWorkers.filter((w: any) => w.id !== id);
          if (!state.killedWorkerIds.includes(id) && state.killedWorkerIds.length < MAX_TERMINAL_SESSIONS * 4) {
            state.killedWorkerIds.push(id);
          }
          state.tokenUsage.input = Math.max(0, finiteNumber(state.tokenUsage.input, 0) - 1500);
          const nextCost = finiteNumber(state.tokenUsage.cost, 0) - 0.0045;
          state.tokenUsage.cost = Math.max(0, parseFloat(nextCost.toFixed(4)));
        }),
        triggerCronJobNow: (prompt: string) => set((state: any) => {
          const label = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'task';
          const newWorker: ActiveWorkerState = {
            id: `worker-manual-${Date.now()}`,
            taskName: `Cron: ${label}`,
            elapsedSeconds: 0,
          };
          if (state.manuallyTriggeredWorkers.length < MAX_TERMINAL_SESSIONS) state.manuallyTriggeredWorkers.push(newWorker);
          if (state.activeWorkers.length < MAX_DIFF_FILES * 2) state.activeWorkers.push(newWorker);
        }),
      })) as any,
    ),
    'TelemetryStore',
  ),
);

export function getTelemetryState() {
  return useTelemetryStore.getState();
}
