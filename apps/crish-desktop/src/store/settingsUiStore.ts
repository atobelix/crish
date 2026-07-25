import {
  loadStoredPermissionMode,
  planModeEnabledFor,
  type PermissionMode,
} from '../api/permissionModes';
import {
  addCommandPermission as persistAddCommandPermission,
  loadCommandPermissions,
  removeCommandPermission as persistRemoveCommandPermission,
  saveCommandPermissions,
} from '../api/commandPermissions';
import {
  DEFAULT_SHELL_CHROME,
  parseShellChromeMode,
  SHELL_CHROME_STORAGE_KEY,
  type ShellChromeMode,
} from '../api/shellChrome';
import { isDemoMode } from '../api/appMode';
import { MAX_TERMINAL_SESSIONS, MAX_DIFF_FILES } from '@crish/shared-utils/browser';
import type { CronJob, McpServer, ProviderInfo, Settings } from '../api/clientApi';
import type { SettingsTabType } from './types';
import {
  DEFAULT_TOKEN_USAGE,
  DEMO_TOKEN_USAGE,
  DEFAULT_UI_SIZE,
  DEFAULT_SETTINGS_TAB,
  finiteNumber,
  parseUiSize,
  sanitizeActiveWorkers,
  sanitizeTokenUsage,
  UI_SIZE_STORAGE_KEY,
  useLayoutStore,
  type ActiveWorkerState,
  type TokenUsageState,
  type TelemetrySyncPayload,
  type UiSize,
} from './layoutStore';

export type { SettingsTabType } from './types';

export type SettingsUiSlice = {
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  permissionMode: PermissionMode;
  planModeEnabled: boolean;
  planApproved: boolean;
};

export type SettingsUiActions = {
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanModeEnabled: (enabled: boolean) => void;
  setPlanApproved: (approved: boolean) => void;
  addCommandPermission: (cmd: string) => void;
  removeCommandPermission: (cmd: string) => void;
  setCommandPermissions: (list: string[]) => void;
};

export type SettingsUiFacade = SettingsUiSlice & SettingsUiActions;

type SettingsUiStoreData = SettingsUiSlice & {
  commandPermissions: string[];
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  appSettings: Settings | null;
  scheduledTasks: CronJob[];
  mcpServers: McpServer[];
  providers: ProviderInfo[];
  activeWorkers: ActiveWorkerState[];
  tokenUsage: TokenUsageState;
  killedWorkerIds: string[];
  manuallyTriggeredWorkers: ActiveWorkerState[];
};

type SettingsUiStore = SettingsUiStoreData & SettingsUiActions & {
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setAppSettings: (settings: Settings | null) => void;
  setScheduledTasks: (tasks: CronJob[]) => void;
  setMcpServers: (servers: McpServer[]) => void;
  setProviders: (providers: ProviderInfo[]) => void;
  syncTelemetryData: (data: TelemetrySyncPayload) => void;
  addCommandPermission: (cmd: string) => void;
  removeCommandPermission: (cmd: string) => void;
  setCommandPermissions: (list: string[]) => void;
  killWorker: (id: string, taskName: string) => void;
  triggerCronJobNow: (prompt: string) => void;
};

const _initialPermissionMode = loadStoredPermissionMode();

function _readStoredUiSize(): UiSize {
  try {
    return parseUiSize(localStorage.getItem(UI_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_SIZE;
  }
}

function _readStoredShellChrome(): ShellChromeMode {
  try {
    return parseShellChromeMode(localStorage.getItem(SHELL_CHROME_STORAGE_KEY));
  } catch {
    return DEFAULT_SHELL_CHROME;
  }
}


const _settingsData: SettingsUiStoreData = {
  showSettingsOverlay: false,
  settingsActiveTab: DEFAULT_SETTINGS_TAB,
  permissionMode: _initialPermissionMode,
  planModeEnabled: planModeEnabledFor(_initialPermissionMode),
  planApproved: false,
  commandPermissions: loadCommandPermissions(),
  uiSize: _readStoredUiSize(),
  shellChromeMode: _readStoredShellChrome(),
  chatMainSurface: 'chat',
  sidebarCollapsed: false,
  appSettings: null,
  scheduledTasks: [],
  mcpServers: [],
  providers: [],
  activeWorkers: [],
  tokenUsage: isDemoMode() ? { ...DEMO_TOKEN_USAGE } : { ...DEFAULT_TOKEN_USAGE },
  killedWorkerIds: [],
  manuallyTriggeredWorkers: [],
};

export const createSettingsUiSlice = (set: any) => ({
  ..._settingsData,

  syncTelemetryData: (data: any) => set((state: any) => {
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

        addCommandPermission: (cmd: string) => set((state: any) => {
          state.commandPermissions = persistAddCommandPermission(state.commandPermissions, cmd);
        }),
        removeCommandPermission: (cmd: string) => set((state: any) => {
          state.commandPermissions = persistRemoveCommandPermission(state.commandPermissions, cmd);
        }),
        setCommandPermissions: (list: string[]) => set((state: any) => {
          const next = Array.isArray(list) ? list.filter((c: any) => typeof c === 'string') : [];
          state.commandPermissions = next;
          saveCommandPermissions(next);
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

        triggerCronJobNow: (prompt: string) => set((state) => {
          const label = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'task';
          const newWorker: ActiveWorkerState = {
            id: `worker-manual-${Date.now()}`,
            taskName: `Cron: ${label}`,
            elapsedSeconds: 0,
          };
          if (state.manuallyTriggeredWorkers.length < MAX_TERMINAL_SESSIONS) state.manuallyTriggeredWorkers.push(newWorker);
          if (state.activeWorkers.length < MAX_DIFF_FILES * 2) state.activeWorkers.push(newWorker);
        }),
});

export { DEFAULT_SETTINGS_TAB } from './layoutStore';

export const selectShowSettingsOverlay = (
  s: Pick<SettingsUiSlice, 'showSettingsOverlay'>,
) => s.showSettingsOverlay;

export const selectSettingsActiveTab = (
  s: Pick<SettingsUiSlice, 'settingsActiveTab'>,
) => s.settingsActiveTab;

export const selectPermissionMode = (s: Pick<SettingsUiSlice, 'permissionMode'>) =>
  s.permissionMode;

export const selectPlanModeEnabled = (s: Pick<SettingsUiSlice, 'planModeEnabled'>) =>
  s.planModeEnabled;

export const selectPlanApproved = (s: Pick<SettingsUiSlice, 'planApproved'>) =>
  s.planApproved;

export const selectOpenSettings = (s: Pick<SettingsUiActions, 'openSettings'>) =>
  s.openSettings;

export const selectSetShowSettingsOverlay = (
  s: Pick<SettingsUiActions, 'setShowSettingsOverlay'>,
) => s.setShowSettingsOverlay;

export const selectSetSettingsActiveTab = (
  s: Pick<SettingsUiActions, 'setSettingsActiveTab'>,
) => s.setSettingsActiveTab;

export const useSettingsUiStore = useLayoutStore;

export const selectSetPermissionMode = (
  s: Pick<SettingsUiActions, 'setPermissionMode'>,
) => s.setPermissionMode;

export const selectSetPlanModeEnabled = (
  s: Pick<SettingsUiActions, 'setPlanModeEnabled'>,
) => s.setPlanModeEnabled;

export const selectSetPlanApproved = (
  s: Pick<SettingsUiActions, 'setPlanApproved'>,
) => s.setPlanApproved;

export function useSettingsUiField<T>(selector: (state: SettingsUiFacade) => T): T {
  return useSettingsUiStore(
    selector as (state: ReturnType<typeof useSettingsUiStore.getState>) => T,
  );
}

export function useShowSettingsOverlay(): boolean {
  return useSettingsUiStore((s) => s.showSettingsOverlay);
}

export function useSettingsActiveTab(): string {
  return useSettingsUiStore((s) => s.settingsActiveTab);
}

export function usePermissionMode(): PermissionMode {
  return useSettingsUiStore((s) => s.permissionMode);
}

export function usePlanModeEnabled(): boolean {
  return useSettingsUiStore((s) => s.planModeEnabled);
}

export function usePlanApproved(): boolean {
  return useSettingsUiStore((s) => s.planApproved);
}

export function useOpenSettings(): (tab?: SettingsTabType) => void {
  return useSettingsUiStore((s) => s.openSettings);
}

export function getSettingsUiState(): SettingsUiFacade {
  return useSettingsUiStore.getState() as unknown as SettingsUiFacade;
}

export function getPermissionMode(): PermissionMode {
  return getSettingsUiState().permissionMode;
}

export function openSettings(tab?: SettingsTabType): void {
  getSettingsUiState().openSettings(tab);
}

export function closeSettings(): void {
  getSettingsUiState().setShowSettingsOverlay(false);
}

export function toggleSettingsOverlay(): void {
  const s = getSettingsUiState();
  s.setShowSettingsOverlay(!s.showSettingsOverlay);
}

export function setShowSettingsOverlay(show: boolean): void {
  getSettingsUiState().setShowSettingsOverlay(show);
}

export function setSettingsActiveTab(tab: SettingsTabType): void {
  getSettingsUiState().setSettingsActiveTab(tab);
}

export function setPermissionMode(mode: PermissionMode): void {
  getSettingsUiState().setPermissionMode(mode);
}

export function setPlanModeEnabled(enabled: boolean): void {
  getSettingsUiState().setPlanModeEnabled(enabled);
}

export function setPlanApproved(approved: boolean): void {
  getSettingsUiState().setPlanApproved(approved);
}

export function addCommandPermission(cmd: string): void {
  getSettingsUiState().addCommandPermission(cmd);
}

export function removeCommandPermission(cmd: string): void {
  getSettingsUiState().removeCommandPermission(cmd);
}

export function setCommandPermissions(list: string[]): void {
  getSettingsUiState().setCommandPermissions(list);
}
