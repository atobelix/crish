/**
 * layoutStore 单测：安全默认、空工作区种子、无 ghost 面板、类型保真 helpers。
 * 操作全局 singleton 后尽量复位，避免污染其他门面测试。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampActiveWorkspaceIndex,
  DEFAULT_SETTINGS_TAB,
  DEFAULT_TOKEN_USAGE,
  DEFAULT_UI_SIZE,
  DEFAULT_WORKSPACE_ID,
  ensureNonEmptyWorkspaces,
  finiteNumber,
  isSettingsTabType,
  parseSettingsTab,
  parseUiSize,
  sanitizeActiveWorkers,
  sanitizeSessionSeed,
  sanitizeTokenUsage,
  seedInitialWorkspaces,
  SETTINGS_TAB_IDS,
  stripGhostPanelsFromWorkspace,
  useLayoutStore,
  type UiSize,
} from './layoutStore';
import type { CronJob, ProviderInfo } from '../api/clientApi';
import type { WorkspaceState } from './types';

function snapshotChrome() {
  const s = useLayoutStore.getState();
  return {
    uiSize: s.uiSize,
    tabModeEnabled: s.tabModeEnabled,
    settingsActiveTab: s.settingsActiveTab,
    showSettingsOverlay: s.showSettingsOverlay,
    sidebarCollapsed: s.sidebarCollapsed,
    planApproved: s.planApproved,
    permissionMode: s.permissionMode,
    planModeEnabled: s.planModeEnabled,
    tokenUsage: { ...s.tokenUsage },
    activeWorkers: [...s.activeWorkers],
    manuallyTriggeredWorkers: [...s.manuallyTriggeredWorkers],
    killedWorkerIds: [...s.killedWorkerIds],
    diffFiles: [...s.diffFiles],
    activeDiffSource: s.activeDiffSource,
    commandPermissions: [...s.commandPermissions],
    workspacesLen: s.workspaces.length,
    activeWorkspaceIndex: s.activeWorkspaceIndex,
    activeAgentId: s.activeAgentId,
    panelAgentId: s.panelAgentId,
  };
}

const chrome0 = snapshotChrome();

afterEach(() => {
  const s = useLayoutStore.getState();
  s.setUiSize(chrome0.uiSize);
  s.setTabModeEnabled(chrome0.tabModeEnabled);
  s.setSettingsActiveTab(chrome0.settingsActiveTab);
  s.setShowSettingsOverlay(chrome0.showSettingsOverlay);
  s.setSidebarCollapsed(chrome0.sidebarCollapsed);
  s.setPlanApproved(false);
  s.setDiffFiles([]);
  s.setCommandPermissions(chrome0.commandPermissions);
  // 遥测 / worker 复位
  useLayoutStore.setState((st) => {
    st.tokenUsage = { ...chrome0.tokenUsage };
    st.activeWorkers = [];
    st.manuallyTriggeredWorkers = [];
    st.killedWorkerIds = [];
    st.activeAgentId = null;
    st.panelAgentId = null;
    // 确保工作区非空
    if (!st.workspaces.length) {
      st.workspaces = seedInitialWorkspaces();
      st.activeWorkspaceIndex = 0;
    }
  });
});

// ── pure helpers ────────────────────────────────────────────────────────────

describe('layoutStore pure helpers — type fidelity & safe defaults', () => {
  it('parseUiSize accepts only three sizes; unknown → medium', () => {
    expect(parseUiSize('small')).toBe('small');
    expect(parseUiSize('large')).toBe('large');
    expect(parseUiSize('medium')).toBe('medium');
    expect(parseUiSize('huge')).toBe(DEFAULT_UI_SIZE);
    expect(parseUiSize(null)).toBe(DEFAULT_UI_SIZE);
    expect(parseUiSize(1)).toBe(DEFAULT_UI_SIZE);
    expect(DEFAULT_UI_SIZE).toBe('medium');
  });

  it('SETTINGS_TAB_IDS covers SettingsTabType; parseSettingsTab rejects ghosts', () => {
    expect(SETTINGS_TAB_IDS.length).toBeGreaterThanOrEqual(10);
    expect(isSettingsTabType('profile')).toBe(true);
    expect(isSettingsTabType('security')).toBe(true);
    expect(isSettingsTabType('not-a-tab')).toBe(false);
    expect(isSettingsTabType('')).toBe(false);
    expect(parseSettingsTab('models')).toBe('models');
    expect(parseSettingsTab('ghost-tab')).toBe(DEFAULT_SETTINGS_TAB);
    expect(parseSettingsTab(undefined, 'security')).toBe('security');
  });

  it('sanitizeTokenUsage clamps NaN/negative and fills defaults', () => {
    expect(sanitizeTokenUsage(null)).toEqual(DEFAULT_TOKEN_USAGE);
    const dirty = sanitizeTokenUsage({
      input: -5,
      inputMax: NaN,
      output: 10,
      outputMax: 0,
      cost: Number.POSITIVE_INFINITY,
    });
    expect(dirty.input).toBe(0);
    expect(dirty.inputMax).toBe(DEFAULT_TOKEN_USAGE.inputMax);
    expect(dirty.output).toBe(10);
    expect(dirty.outputMax).toBe(1); // max(1, finite)
    expect(dirty.cost).toBe(0);

    const base = { input: 1, inputMax: 2, output: 3, outputMax: 4, cost: 0.5 };
    expect(sanitizeTokenUsage({ input: 9 }, base).input).toBe(9);
    expect(sanitizeTokenUsage({ input: 9 }, base).output).toBe(3);
  });

  it('sanitizeActiveWorkers drops id-less ghosts and normalizes elapsed', () => {
    expect(sanitizeActiveWorkers(null)).toEqual([]);
    expect(
      sanitizeActiveWorkers([
        { id: 'w1', taskName: 'a', elapsedSeconds: -3 },
        { id: '', taskName: 'x', elapsedSeconds: 1 },
        { taskName: 'no-id', elapsedSeconds: 1 },
        { id: 'w2', taskName: 99, elapsedSeconds: 'x' },
        null,
      ])
    ).toEqual([
      { id: 'w1', taskName: 'a', elapsedSeconds: 0 },
      { id: 'w2', taskName: '', elapsedSeconds: 0 },
    ]);
  });

  it('finiteNumber rejects NaN / Infinity / non-numbers', () => {
    expect(finiteNumber(3, 0)).toBe(3);
    expect(finiteNumber(NaN, 7)).toBe(7);
    expect(finiteNumber(Infinity, 7)).toBe(7);
    expect(finiteNumber('1', 7)).toBe(7);
  });
});

describe('empty workspace seed & no ghost panels', () => {
  it('seedInitialWorkspaces is non-empty with DEFAULT_WORKSPACE_ID and a chat card', () => {
    const list = seedInitialWorkspaces();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(DEFAULT_WORKSPACE_ID);
    const cards = list[0]!.columns.flatMap((c) =>
      c.groups.flatMap((g) => g.cards.map((x) => x.id))
    );
    expect(cards).toContain('chat');
    expect(cards).not.toContain('settings');
    expect(cards).not.toContain('runtime');
  });

  it('ensureNonEmptyWorkspaces reseeds empty / null', () => {
    expect(ensureNonEmptyWorkspaces([]).length).toBe(1);
    expect(ensureNonEmptyWorkspaces(null).length).toBe(1);
    expect(ensureNonEmptyWorkspaces(undefined).length).toBe(1);
    const custom = ensureNonEmptyWorkspaces([], 'ws-custom');
    expect(custom[0]!.id).toBe('ws-custom');
  });

  it('stripGhostPanelsFromWorkspace drops settings/runtime and remaps browser/plan', () => {
    const dirty: WorkspaceState = {
      id: 'ws-x',
      columns: [
        {
          id: 'col-chat-ws-x',
          widthRatio: 0.5,
          groups: [
            {
              id: 'g-chat',
              activeCardId: 'chat',
              cards: [{ id: 'chat', title: '对话' }],
              heightRatio: 1,
            },
          ],
        },
        {
          id: 'col-tools',
          widthRatio: 0.5,
          groups: [
            {
              id: 'g-ghost',
              activeCardId: 'settings',
              cards: [
                { id: 'settings', title: '设置' },
                { id: 'runtime', title: '运行' },
                { id: 'browser', title: '浏览器' },
                { id: 'plan', title: '计划' },
                { id: 'preview', title: '预览' },
              ],
              heightRatio: 1,
            },
          ],
        },
      ],
    };
    const clean = stripGhostPanelsFromWorkspace(dirty);
    const ids = clean.columns.flatMap((c) =>
      c.groups.flatMap((g) => g.cards.map((x) => x.id))
    );
    expect(ids).toContain('chat');
    expect(ids).toContain('preview');
    expect(ids).toContain('tasks'); // plan → tasks
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('runtime');
    expect(ids).not.toContain('browser');
    expect(ids).not.toContain('plan');
    // browser + preview 去重只剩 preview
    expect(ids.filter((x) => x === 'preview').length).toBe(1);
  });

  it('stripGhostPanelsFromWorkspace reseeds when only ghosts remain', () => {
    const onlyGhost: WorkspaceState = {
      id: 'ws-empty',
      columns: [
        {
          id: 'col-1',
          widthRatio: 1,
          groups: [
            {
              id: 'g1',
              activeCardId: 'settings',
              cards: [{ id: 'settings', title: '设置' }],
              heightRatio: 1,
            },
          ],
        },
      ],
    };
    const clean = stripGhostPanelsFromWorkspace(onlyGhost);
    const ids = clean.columns.flatMap((c) =>
      c.groups.flatMap((g) => g.cards.map((x) => x.id))
    );
    expect(ids).toContain('chat');
    expect(ids).not.toContain('settings');
  });

  it('clampActiveWorkspaceIndex bounds index', () => {
    const ws = seedInitialWorkspaces();
    expect(clampActiveWorkspaceIndex(ws, 0)).toBe(0);
    expect(clampActiveWorkspaceIndex(ws, 99)).toBe(0);
    expect(clampActiveWorkspaceIndex(ws, -3)).toBe(0);
    expect(clampActiveWorkspaceIndex([], 5)).toBe(0);
    const two = [...ws, ...seedInitialWorkspaces('ws-1')];
    expect(clampActiveWorkspaceIndex(two, 1)).toBe(1);
    expect(clampActiveWorkspaceIndex(two, 2)).toBe(1);
  });

  it('sanitizeSessionSeed clears ghost activeSessionId', () => {
    const a = sanitizeSessionSeed({
      sessions: [
        {
          id: 's1',
          title: 't',
          folder: 'f',
          isPinned: false,
          isArchived: false,
          timestamp: '',
          messages: [],
        },
      ],
      activeSessionId: 'missing',
      folderOrder: ['f', '', 'g'],
    });
    expect(a.activeSessionId).toBe('');
    expect(a.sessionsById.s1?.id).toBe('s1');
    expect(a.folderOrder).toEqual(['f', 'g']);

    const empty = sanitizeSessionSeed({
      sessions: [],
      activeSessionId: 'ghost',
      folderOrder: [],
    });
    expect(empty.activeSessionId).toBe('');
    expect(Object.keys(empty.sessionsById)).toHaveLength(0);
  });

  it('sanitizeSessionSeed clears pending draft sentinel', () => {
    const s = sanitizeSessionSeed({
      sessions: [
        {
          id: 's1',
          title: 't',
          folder: 'f',
          isPinned: false,
          isArchived: false,
          timestamp: '',
          messages: [],
        },
      ],
      activeSessionId: '__pending_draft__',
      folderOrder: ['f'],
    });
    expect(s.activeSessionId).toBe('');
    expect(s.sessionsById.s1?.id).toBe('s1');
  });
});

// ── live store behavior ─────────────────────────────────────────────────────

describe('useLayoutStore initial invariants', () => {
  it('starts with non-empty workspaces, clamped index, no agent ghosts', () => {
    const s = useLayoutStore.getState();
    expect(s.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(s.activeWorkspaceIndex).toBeGreaterThanOrEqual(0);
    expect(s.activeWorkspaceIndex).toBeLessThan(s.workspaces.length);
    expect(s.activeAgentId).toBeNull();
    expect(s.panelAgentId).toBeNull();
    expect(s.draggedTab).toBeNull();
    expect(s.dropPreview).toBeNull();
    expect(s.activeDiffSource).toBeNull();
    expect(s.diffFiles).toEqual([]);

    const ids = s.workspaces.flatMap((ws) =>
      ws.columns.flatMap((c) =>
        c.groups.flatMap((g) => g.cards.map((x) => x.id))
      )
    );
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('runtime');
    // active session fidelity
    if (s.activeSessionId) {
      expect(s.sessionsById[s.activeSessionId]?.id).toBe(s.activeSessionId);
    }
  });

  it('uiSize is a legal UiSize', () => {
    const size = useLayoutStore.getState().uiSize;
    const ok: UiSize[] = ['small', 'medium', 'large'];
    expect(ok).toContain(size);
  });

  it('settingsActiveTab is a known tab', () => {
    expect(isSettingsTabType(useLayoutStore.getState().settingsActiveTab)).toBe(
      true
    );
  });
});

describe('useLayoutStore actions — guards', () => {
  it('setUiSize coerces invalid to medium and persists legal values', () => {
    const s = useLayoutStore.getState();
    s.setUiSize('large');
    expect(useLayoutStore.getState().uiSize).toBe('large');
    s.setUiSize('small');
    expect(useLayoutStore.getState().uiSize).toBe('small');
    s.setUiSize('gigantic' as unknown as UiSize);
    expect(useLayoutStore.getState().uiSize).toBe(DEFAULT_UI_SIZE);
  });

  it('setSettingsActiveTab ignores illegal tabs; openSettings falls back', () => {
    const s = useLayoutStore.getState();
    s.setSettingsActiveTab('models');
    expect(useLayoutStore.getState().settingsActiveTab).toBe('models');
    s.setSettingsActiveTab('not-real' as unknown as SettingsTabType);
    expect(useLayoutStore.getState().settingsActiveTab).toBe('models');

    s.openSettings('security');
    expect(useLayoutStore.getState().showSettingsOverlay).toBe(true);
    expect(useLayoutStore.getState().settingsActiveTab).toBe('security');

    s.openSettings('___ghost___' as unknown as SettingsTabType);
    expect(useLayoutStore.getState().settingsActiveTab).toBe('security');
    expect(useLayoutStore.getState().showSettingsOverlay).toBe(true);

    s.setShowSettingsOverlay(false);
  });

  it('syncTelemetryData sanitizes tokenUsage and workers; respects killed ids', () => {
    const s = useLayoutStore.getState();
    s.syncTelemetryData({
      tokenUsage: { input: -1, cost: NaN, output: 5 },
      activeWorkers: [
        { id: 'live', taskName: 't', elapsedSeconds: 1 },
        { id: 'dead', taskName: 'd', elapsedSeconds: 2 },
      ],
    });
    let st = useLayoutStore.getState();
    expect(st.tokenUsage.input).toBe(0);
    expect(st.tokenUsage.output).toBe(5);
    expect(Number.isFinite(st.tokenUsage.cost)).toBe(true);
    expect(st.activeWorkers.some((w) => w.id === 'live')).toBe(true);

    s.killWorker('dead', 'd');
    s.syncTelemetryData({
      activeWorkers: [
        { id: 'live', taskName: 't', elapsedSeconds: 3 },
        { id: 'dead', taskName: 'd', elapsedSeconds: 9 },
      ],
    });
    st = useLayoutStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'dead')).toBe(false);
    expect(st.killedWorkerIds).toContain('dead');
  });

  it('setDiffFiles / removeDiffFile keep activeDiffSource coherent', () => {
    const s = useLayoutStore.getState();
    const a = {
      filePath: 'a.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition' as const, content: '+x' }],
    };
    const b = {
      filePath: 'b.ts',
      additions: 0,
      deletions: 1,
      changes: [{ type: 'deletion' as const, content: '-y' }],
    };
    s.setDiffFiles([a, b]);
    expect(useLayoutStore.getState().activeDiffSource?.filePath).toBe('a.ts');
    s.removeDiffFile('a.ts');
    expect(useLayoutStore.getState().activeDiffSource?.filePath).toBe('b.ts');
    s.removeDiffFile('b.ts');
    expect(useLayoutStore.getState().activeDiffSource).toBeNull();
    expect(useLayoutStore.getState().diffFiles).toEqual([]);
  });

  it('setProviders / setScheduledTasks / setMcpServers reject non-arrays safely', () => {
    const s = useLayoutStore.getState();
    s.setProviders([]);
    // null/undefined may be accepted at type-level under loose null checks; runtime still clamps
    s.setProviders(null as unknown as ProviderInfo[]);
    expect(useLayoutStore.getState().providers).toEqual([]);
    s.setScheduledTasks(undefined as unknown as CronJob[]);
    expect(Array.isArray(useLayoutStore.getState().scheduledTasks)).toBe(true);
    s.setMcpServers('nope' as unknown as McpServer[]);
    expect(useLayoutStore.getState().mcpServers).toEqual([]);
  });

  it('triggerCronJobNow seeds a manual worker with safe label', () => {
    const before = useLayoutStore.getState().activeWorkers.length;
    useLayoutStore.getState().triggerCronJobNow('  deploy  ');
    const workers = useLayoutStore.getState().activeWorkers;
    expect(workers.length).toBe(before + 1);
    expect(workers[workers.length - 1]!.taskName).toContain('deploy');
    useLayoutStore.getState().triggerCronJobNow('   ');
    const last = useLayoutStore.getState().activeWorkers.slice(-1)[0]!;
    expect(last.taskName).toContain('task');
  });
});
