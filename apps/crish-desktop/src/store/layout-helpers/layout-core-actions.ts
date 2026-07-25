import {
  MAX_DIFF_FILES,
  MAX_TERMINAL_SESSIONS,
} from '@crish/shared-utils/browser';
import type { Settings, CronJob, McpServer, ProviderInfo } from '../../api/clientApi';
import {
  addCommandPermission as persistAddCommandPermission,
  removeCommandPermission as persistRemoveCommandPermission,
  saveCommandPermissions,
} from '../../api/commandPermissions';
import {
  permissionModeAfterPlanToggle,
  persistPermissionMode,
  planModeEnabledFor,
  type PermissionMode,
} from '../../api/permissionModes';
import {
  SHELL_CHROME_STORAGE_KEY,
  parseShellChromeMode,
  type ShellChromeMode,
} from '../../api/shellChrome';
import type { FileDiff, SettingsTabType } from '../types';
import { appendTerminalLine, upsertDiffFile } from './diff-selectors';
import { collapseToolColumnToTabs } from './ui-selectors';
import {
  isSettingsTabType,
  parseSettingsTab,
  parseUiSize,
  sanitizeActiveWorkers,
  sanitizeTokenUsage,
} from './store-initializers';
import {
  TAB_MODE_STORAGE_KEY,
  UI_SIZE_STORAGE_KEY,
  type ActiveWorkerState,
  type TelemetrySyncPayload,
  type UiSize,
} from './store-types';

export function createLayoutCoreActions(
  set: (updater: (state: any) => void) => void,
  get: () => any
) {
  return {
    setActiveDiffSource: (diff: FileDiff | null) =>
      set((state) => {
        state.activeDiffSource = diff;
        if (diff) {
          upsertDiffFile(state.diffFiles, diff);
        }
      }),
    setDiffFiles: (files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])) =>
      set((state) => {
        const next =
          typeof files === 'function'
            ? (files as (prev: FileDiff[]) => FileDiff[])(state.diffFiles)
            : files;
        state.diffFiles = Array.isArray(next) ? next : [];
        state.activeDiffSource = state.diffFiles[0] || null;
      }),
    pushDiffFile: (diff: FileDiff) =>
      set((state) => {
        upsertDiffFile(state.diffFiles, diff);
        state.activeDiffSource = diff;
      }),
    removeDiffFile: (filePath: string) =>
      set((state) => {
        const path = filePath || '';
        state.diffFiles = state.diffFiles.filter((f: FileDiff) => f.filePath !== path);
        if (state.activeDiffSource?.filePath === path) {
          state.activeDiffSource = state.diffFiles[0] || null;
        }
      }),
    setPermissionMode: (mode: PermissionMode) => {
      set((state) => {
        state.permissionMode = mode;
        state.planModeEnabled = planModeEnabledFor(mode);
        state.planApproved = false;
      });
      persistPermissionMode(mode);
    },
    setPlanModeEnabled: (enabled: boolean) => {
      let nextMode: PermissionMode = 'ask';
      set((state) => {
        nextMode = permissionModeAfterPlanToggle(state.permissionMode, enabled);
        state.permissionMode = nextMode;
        state.planModeEnabled = planModeEnabledFor(nextMode);
        state.planApproved = false;
      });
      persistPermissionMode(nextMode);
    },
    setPlanApproved: (approved: boolean) =>
      set((state) => {
        state.planApproved = approved;
      }),
    addCommandPermission: (cmd: string) =>
      set((state) => {
        state.commandPermissions = persistAddCommandPermission(
          state.commandPermissions,
          cmd
        );
      }),
    removeCommandPermission: (cmd: string) =>
      set((state) => {
        state.commandPermissions = persistRemoveCommandPermission(
          state.commandPermissions,
          cmd
        );
      }),
    setCommandPermissions: (list: string[]) =>
      set((state) => {
        const next = Array.isArray(list)
          ? list.filter((c) => typeof c === 'string')
          : [];
        state.commandPermissions = next;
        saveCommandPermissions(next);
      }),
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
    syncTelemetryData: (data: TelemetrySyncPayload) =>
      set((state) => {
        if (data.tokenUsage) {
          state.tokenUsage = sanitizeTokenUsage(
            data.tokenUsage,
            state.tokenUsage
          );
        }

        state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map(
          (w: ActiveWorkerState) => ({
            id: w.id,
            taskName: w.taskName,
            elapsedSeconds: Math.max(
              0,
              (typeof w.elapsedSeconds === 'number' && Number.isFinite(w.elapsedSeconds) ? w.elapsedSeconds : 0) + 2
            ),
          })
        );

        if (data.activeWorkers) {
          const live = sanitizeActiveWorkers(data.activeWorkers).filter(
            (w: ActiveWorkerState) => !state.killedWorkerIds.includes(w.id)
          );
          state.activeWorkers = [
            ...live,
            ...state.manuallyTriggeredWorkers,
          ];
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
      }),
    addTerminalLine: (line: string, sessionId?: string) =>
      set((state) => {
        const text = typeof line === 'string' ? line : String(line ?? '');
        const sid = sessionId || state.activeSessionId || '_global';
        if (!state.terminalBySession[sid]) state.terminalBySession[sid] = [];
        appendTerminalLine(state.terminalBySession[sid], text);
        if (
          !sessionId ||
          sessionId === state.activeSessionId ||
          !state.activeSessionId
        ) {
          state.terminalLines = state.terminalBySession[sid];
        }
      }),
    clearTerminalLines: (sessionId?: string) =>
      set((state) => {
        const sid = sessionId || state.activeSessionId || '_global';
        state.terminalBySession[sid] = [];
        if (
          !sessionId ||
          sessionId === state.activeSessionId ||
          !state.activeSessionId
        ) {
          state.terminalLines = [];
        }
      }),
    triggerCronJobNow: (prompt: string) =>
      set((state) => {
        const label =
          typeof prompt === 'string' && prompt.trim()
            ? prompt.trim()
            : 'task';
        const newWorker: ActiveWorkerState = {
          id: `worker-manual-${Date.now()}`,
          taskName: `Cron: ${label}`,
          elapsedSeconds: 0,
        };
        if (state.manuallyTriggeredWorkers.length < MAX_TERMINAL_SESSIONS)
          state.manuallyTriggeredWorkers.push(newWorker);
        if (state.activeWorkers.length < MAX_DIFF_FILES * 2)
          state.activeWorkers.push(newWorker);
      }),
    killWorker: (id: string, _taskName?: string) =>
      set((state) => {
        void _taskName;
        if (!id) return;
        state.manuallyTriggeredWorkers =
          state.manuallyTriggeredWorkers.filter((w: ActiveWorkerState) => w.id !== id);
        state.activeWorkers = state.activeWorkers.filter((w: ActiveWorkerState) => w.id !== id);
        if (
          !state.killedWorkerIds.includes(id) &&
          state.killedWorkerIds.length < MAX_TERMINAL_SESSIONS * 4
        ) {
          state.killedWorkerIds.push(id);
        }
        const curInput =
          typeof state.tokenUsage.input === 'number' &&
          Number.isFinite(state.tokenUsage.input)
            ? state.tokenUsage.input
            : 0;
        state.tokenUsage.input = Math.max(0, curInput - 1500);
        const curCost =
          typeof state.tokenUsage.cost === 'number' &&
          Number.isFinite(state.tokenUsage.cost)
            ? state.tokenUsage.cost
            : 0;
        const nextCost = curCost - 0.0045;
        state.tokenUsage.cost = Math.max(0, parseFloat(nextCost.toFixed(4)));
      }),
    setUiSize: (size: UiSize) => {
      const next = parseUiSize(size);
      set((state) => {
        state.uiSize = next;
      });
      try {
        localStorage.setItem(UI_SIZE_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    setShellChromeMode: (mode: ShellChromeMode) => {
      const next = parseShellChromeMode(mode);
      set((state) => {
        state.shellChromeMode = next;
      });
      try {
        localStorage.setItem(SHELL_CHROME_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    setChatMainSurface: (surface: 'chat' | 'scheduled') =>
      set((state) => {
        state.chatMainSurface = surface === 'scheduled' ? 'scheduled' : 'chat';
      }),
    setSidebarCollapsed: (collapsed: boolean) =>
      set((state) => {
        state.sidebarCollapsed = !!collapsed;
      }),
    setTabModeEnabled: (enabled: boolean) => {
      const on = !!enabled;
      set((state) => {
        state.tabModeEnabled = on;
        if (on) {
          for (const ws of state.workspaces) {
            collapseToolColumnToTabs(ws);
          }
        }
      });
      try {
        localStorage.setItem(TAB_MODE_STORAGE_KEY, on ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
    setShowSettingsOverlay: (show: boolean) =>
      set((state) => {
        state.showSettingsOverlay = !!show;
      }),
    setSettingsActiveTab: (tab: SettingsTabType) =>
      set((state) => {
        if (isSettingsTabType(tab)) {
          state.settingsActiveTab = tab;
        }
      }),
    openSettings: (tab?: SettingsTabType) =>
      set((state) => {
        if (tab !== undefined) {
          state.settingsActiveTab = parseSettingsTab(
            tab,
            state.settingsActiveTab
          );
        }
        state.showSettingsOverlay = true;
      }),
  };
}
