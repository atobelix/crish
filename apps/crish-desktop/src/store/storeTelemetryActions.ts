import { MAX_TERMINAL_SESSIONS, MAX_DIFF_FILES } from '@crish/shared-utils/browser';
import type { CronJob, McpServer, ProviderInfo, Settings } from '../api/clientApi';

export type TokenUsageState = { input: number; inputMax: number; output: number; outputMax: number; cost: number };
export type ActiveWorkerState = { id: string; taskName: string; elapsedSeconds: number };
export type TelemetrySyncPayload = {
  tokenUsage?: Partial<TokenUsageState> | TokenUsageState;
  activeWorkers?: ActiveWorkerState[];
  mcpServers?: McpServer[];
  cronJobs?: CronJob[];
};

export const DEFAULT_TOKEN_USAGE: TokenUsageState = { input: 0, inputMax: 160000, output: 0, outputMax: 40000, cost: 0 };
export const DEMO_TOKEN_USAGE: TokenUsageState = { input: 115482, inputMax: 160000, output: 24930, outputMax: 40000, cost: 0.345 };

export type TelemetryStoreSlice = {
  appSettings: Settings | null;
  providers: ProviderInfo[];
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  activeWorkers: ActiveWorkerState[];
  tokenUsage: TokenUsageState;
  killedWorkerIds: string[];
  manuallyTriggeredWorkers: ActiveWorkerState[];
  setProviders: (providers: ProviderInfo[]) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;
  killWorker: (id: string, taskName?: string) => void;
  triggerCronJobNow: (prompt: string) => void;
};

export type TelemetryImmerSet = (recipe: (state: TelemetryStoreSlice) => void) => void;
export type TelemetryGet = () => TelemetryStoreSlice;

export function finiteNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function isWorkerLike(w: unknown): w is { id: string; taskName?: unknown; elapsedSeconds?: unknown } {
  if (w == null || typeof w !== 'object') return false;
  const item = w as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0;
}

export function sanitizeActiveWorkers(list: unknown): ActiveWorkerState[] {
  if (!Array.isArray(list)) return [];
  const out: ActiveWorkerState[] = [];
  for (const w of list) {
    if (!isWorkerLike(w)) continue;
    out.push({ id: w.id, taskName: typeof w.taskName === 'string' ? w.taskName : '', elapsedSeconds: Math.max(0, finiteNumber(w.elapsedSeconds, 0)) });
  }
  return out;
}

export function sanitizeTokenUsage(raw: Partial<TokenUsageState> | TokenUsageState | null | undefined, base: TokenUsageState = DEFAULT_TOKEN_USAGE): TokenUsageState {
  if (!raw || typeof raw !== 'object') return { input: base.input, inputMax: base.inputMax, output: base.output, outputMax: base.outputMax, cost: base.cost };
  return {
    input: Math.max(0, finiteNumber(raw.input, base.input)),
    inputMax: Math.max(1, finiteNumber(raw.inputMax, base.inputMax)),
    output: Math.max(0, finiteNumber(raw.output, base.output)),
    outputMax: Math.max(1, finiteNumber(raw.outputMax, base.outputMax)),
    cost: Math.max(0, finiteNumber(raw.cost, base.cost)),
  };
}

export function createInitialTelemetryState(isDemo: boolean): Pick<TelemetryStoreSlice, 'appSettings' | 'providers' | 'scheduledTasks' | 'mcpServers' | 'activeWorkers' | 'tokenUsage' | 'killedWorkerIds' | 'manuallyTriggeredWorkers'> {
  return {
    appSettings: null, providers: [], scheduledTasks: [], mcpServers: [],
    activeWorkers: [], killedWorkerIds: [], manuallyTriggeredWorkers: [],
    tokenUsage: isDemo ? { ...DEMO_TOKEN_USAGE } : { ...DEFAULT_TOKEN_USAGE },
  };
}

export function createTelemetryActions(set: TelemetryImmerSet, get: TelemetryGet): Pick<TelemetryStoreSlice, 'setProviders' | 'setAppSettings' | 'setScheduledTasks' | 'setMcpServers' | 'syncTelemetryData' | 'killWorker' | 'triggerCronJobNow'> {
  return {
    setProviders: (providers) => set((state) => { state.providers = Array.isArray(providers) ? providers : []; }),
    setAppSettings: (settings) => set((state) => { state.appSettings = settings; }),
    setScheduledTasks: (tasks) => set((state) => { state.scheduledTasks = Array.isArray(tasks) ? tasks : []; }),
    setMcpServers: (servers) => set((state) => { state.mcpServers = Array.isArray(servers) ? servers : []; }),
    syncTelemetryData: (data) => set((state) => {
      if (data.tokenUsage) state.tokenUsage = sanitizeTokenUsage(data.tokenUsage, state.tokenUsage);
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map((w) => ({ ...w, elapsedSeconds: Math.max(0, finiteNumber(w.elapsedSeconds, 0) + 2) }));
      if (data.activeWorkers) {
        const live = sanitizeActiveWorkers(data.activeWorkers).filter((w) => !state.killedWorkerIds.includes(w.id));
        state.activeWorkers = [...live, ...state.manuallyTriggeredWorkers];
      }
      if (data.mcpServers) state.mcpServers = Array.isArray(data.mcpServers) ? data.mcpServers : state.mcpServers;
      if (data.cronJobs) state.scheduledTasks = Array.isArray(data.cronJobs) ? data.cronJobs : state.scheduledTasks;
    }),
    triggerCronJobNow: (prompt) => set((state) => {
      const label = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'task';
      const newWorker: ActiveWorkerState = { id: `worker-manual-${Date.now()}`, taskName: `Cron: ${label}`, elapsedSeconds: 0 };
      if (state.manuallyTriggeredWorkers.length < MAX_TERMINAL_SESSIONS) state.manuallyTriggeredWorkers.push(newWorker);
      if (state.activeWorkers.length < MAX_DIFF_FILES * 2) state.activeWorkers.push(newWorker);
    }),
    killWorker: (id, _taskName) => set((state) => {
      if (!id) return;
      state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.filter((w) => w.id !== id);
      state.activeWorkers = state.activeWorkers.filter((w) => w.id !== id);
      if (!state.killedWorkerIds.includes(id) && state.killedWorkerIds.length < MAX_TERMINAL_SESSIONS * 4) state.killedWorkerIds.push(id);
      state.tokenUsage.input = Math.max(0, finiteNumber(state.tokenUsage.input, 0) - 1500);
      const nextCost = finiteNumber(state.tokenUsage.cost, 0) - 0.0045;
      state.tokenUsage.cost = Math.max(0, parseFloat(nextCost.toFixed(4)));
    }),
  };
}
