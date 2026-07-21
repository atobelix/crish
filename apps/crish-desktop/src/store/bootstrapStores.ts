import { useLayoutStore } from './layoutStore';
import { useSessionStore } from './sessionStore';
import { useWorkspaceStore } from './workspaceStore';
import { useSettingsUiStore } from './settingsUiStore';
import { initStoreAccess } from '../api/storeAccess';

const activeSyncs = new Set<string>();

// ── Session sync ──
function syncLayoutToSession(): void {
  const layout = useLayoutStore.getState();
  useSessionStore.setState({
    sessions: layout.sessions,
    activeSessionId: layout.activeSessionId,
    folderOrder: layout.folderOrder,
    activeAgentId: layout.activeAgentId,
    panelAgentId: layout.panelAgentId,
    composerDrafts: layout.composerDrafts,
    terminalBySession: layout.terminalBySession,
    terminalLines: layout.terminalLines,
  } as Partial<ReturnType<typeof useSessionStore.getState>>);
}

function syncSessionToLayout(): void {
  const ss = useSessionStore.getState();
  useLayoutStore.setState({
    sessions: ss.sessions,
    activeSessionId: ss.activeSessionId,
    folderOrder: ss.folderOrder,
    activeAgentId: ss.activeAgentId,
    panelAgentId: ss.panelAgentId,
    composerDrafts: ss.composerDrafts,
    terminalBySession: ss.terminalBySession,
    terminalLines: ss.terminalLines,
  });
}

function syncLayoutToWorkspace(): void {
  const layout = useLayoutStore.getState();
  useWorkspaceStore.setState({
    activeWorkspaceIndex: layout.activeWorkspaceIndex,
    draggedTab: layout.draggedTab,
    dropPreview: layout.dropPreview,
    diffFiles: layout.diffFiles,
    activeDiffSource: layout.activeDiffSource,
  } as Partial<ReturnType<typeof useWorkspaceStore.getState>>);
}

function syncLayoutToSettingsUi(): void {
  const layout = useLayoutStore.getState();
  useSettingsUiStore.setState({
    showSettingsOverlay: layout.showSettingsOverlay,
    settingsActiveTab: layout.settingsActiveTab,
    permissionMode: layout.permissionMode,
    planModeEnabled: layout.planModeEnabled,
    planApproved: layout.planApproved,
    commandPermissions: layout.commandPermissions,
    uiSize: layout.uiSize,
    shellChromeMode: layout.shellChromeMode,
    chatMainSurface: layout.chatMainSurface,
    sidebarCollapsed: layout.sidebarCollapsed,
    appSettings: layout.appSettings,
    scheduledTasks: layout.scheduledTasks,
    activeWorkers: layout.activeWorkers,
    tokenUsage: layout.tokenUsage,
    killedWorkerIds: layout.killedWorkerIds,
    manuallyTriggeredWorkers: layout.manuallyTriggeredWorkers,
  } as Partial<ReturnType<typeof useSettingsUiStore.getState>>);
}

function syncWorkspaceToLayout(): void {
  const ws = useWorkspaceStore.getState();
  useLayoutStore.setState({
    workspaces: ws.workspaces,
    activeWorkspaceIndex: ws.activeWorkspaceIndex,
    tabModeEnabled: ws.tabModeEnabled,
    draggedTab: ws.draggedTab,
    dropPreview: ws.dropPreview,
    diffFiles: ws.diffFiles,
    activeDiffSource: ws.activeDiffSource,
  });
}

function syncSettingsUiToLayout(): void {
  const ui = useSettingsUiStore.getState();
  useLayoutStore.setState({
    mcpServers: ui.mcpServers,
    providers: ui.providers,
    activeWorkers: ui.activeWorkers,
    tokenUsage: ui.tokenUsage,
    killedWorkerIds: ui.killedWorkerIds,
    manuallyTriggeredWorkers: ui.manuallyTriggeredWorkers,
  });
}

let batchRollback = false;

export function setBatchRollback(v: boolean): void { batchRollback = v; }

// ── Store update frequency logging ──
const _counters = new Map<string, number>();
const _STORE_NAMES = ['layoutStore', 'sessionStore', 'workspaceStore', 'settingsUiStore'];
let _freqInterval: ReturnType<typeof setInterval> | null = null;

function _setupFrequencyLogging(): void {
  if (process.env.NODE_ENV !== 'development') return;
  _freqInterval = setInterval(() => {
    for (const name of _STORE_NAMES) {
      const count = _counters.get(name) ?? 0;
      if (count > 0) {
        console.log(`[StoreFreq] ${name}: ${count} updates in last 60s`);
      }
      _counters.set(name, 0);
    }
  }, 60000);
}

function _teardownFrequencyLogging(): void {
  if (_freqInterval !== null) {
    clearInterval(_freqInterval);
    _freqInterval = null;
  }
}

export function bootstrapStores(): () => void {
  const unsubs: (() => void)[] = [];
  _setupFrequencyLogging();

  unsubs.push(useLayoutStore.subscribe(() => {
    _counters.set('layoutStore', (_counters.get('layoutStore') ?? 0) + 1);
    if (batchRollback) return;
    const path = 'layout→all';
    if (activeSyncs.has(path)) return;
    activeSyncs.add(path);
    try {
      syncLayoutToWorkspace();
      syncLayoutToSettingsUi();
      syncLayoutToSession();
    } finally {
      activeSyncs.delete(path);
    }
  }));

  unsubs.push(useWorkspaceStore.subscribe(() => {
    _counters.set('workspaceStore', (_counters.get('workspaceStore') ?? 0) + 1);
    if (batchRollback) return;
    const path = 'workspace→layout';
    if (activeSyncs.has(path)) return;
    activeSyncs.add(path);
    try {
      syncWorkspaceToLayout();
    } finally {
      activeSyncs.delete(path);
    }
  }));

  unsubs.push(useSettingsUiStore.subscribe(() => {
    _counters.set('settingsUiStore', (_counters.get('settingsUiStore') ?? 0) + 1);
    if (batchRollback) return;
    const path = 'settingsUi→layout';
    if (activeSyncs.has(path)) return;
    activeSyncs.add(path);
    try {
      syncSettingsUiToLayout();
    } finally {
      activeSyncs.delete(path);
    }
  }));

  unsubs.push(useSessionStore.subscribe(() => {
    _counters.set('sessionStore', (_counters.get('sessionStore') ?? 0) + 1);
    if (batchRollback) return;
    const path = 'session→layout';
    if (activeSyncs.has(path)) return;
    activeSyncs.add(path);
    try {
      syncSessionToLayout();
    } finally {
      activeSyncs.delete(path);
    }
  }));

  initStoreAccess(useSessionStore, useWorkspaceStore, useSettingsUiStore);

  if (process.env.NODE_ENV === 'development') {
    const invariantInterval = setInterval(() => {
      const session = useSessionStore.getState();
      if ('permissionMode' in session) {
        console.error('[Invariant] permissionMode should not be in sessionStore');
      }
    }, 30000);
    unsubs.push(() => clearInterval(invariantInterval));
  }

  return () => {
    _teardownFrequencyLogging();
    for (const fn of unsubs) {
      fn();
    }
  };
}
