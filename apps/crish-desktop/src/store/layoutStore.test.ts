/**
 * layoutStore 单测：安全默认、空工作区种子、无 ghost 面板、类型保真 helpers。
 *
 * ## 域拆分（2026-09-15 对齐）
 *
 * `useLayoutStore` 已纯化为**壳层布局域**（uiSize / tabModeEnabled /
 * shellChromeMode / chatMainSurface / sidebarCollapsed / hydrationComplete）。
 * 原单体 store 的其余状态已物理拆分：
 * - `workspaces` / `activeWorkspaceIndex` / `draggedTab` / `dropPreview` → `useWorkspaceStore`
 * - `activeAgentId` / `panelAgentId` / `activeSessionId` / `sessionsById` → `useSessionStore`
 *
 * 本文件仍覆盖 layoutStore 自身的纯函数与 chrome action；跨域不变量分别断言到
 * 对应 store（不再从 useLayoutStore 读已迁走的字段）。
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
  isSettingsTabType as is,
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
import { useWorkspaceStore } from './workspaceStore';
import { useSessionStore } from './sessionStore';
import { useSettingsUiStore } from './settingsUiStore';
import type { } from './types';
import type { WorkspaceState } from './types';

function snapshotChrome() {
  const layout = useLayoutStore.getState();
  const workspace = useWorkspaceStore.getState();
  const session = useSessionStore.getState();
  return {
    uiSize: layout.uiSize,
    tabModeEnabled: layout.tabModeEnabled,
    sidebarCollapsed: layout.sidebarCollapsed,
    workspacesLen: workspace.workspaces.length,
    activeWorkspaceIndex: workspace.activeWorkspaceIndex,
    activeAgentId: session.activeAgentId,
    panelAgentId: session.panelAgentId,
  };
}

const chrome0 = snapshotChrome();

afterEach(() => {
  // layoutStore（壳层 chrome）
  const layout = useLayoutStore.getState();
  layout.setUiSize(chrome0.uiSize);
  layout.setTabModeEnabled(chrome0.tabModeEnabled);
  layout.setSidebarCollapsed(chrome0.sidebarCollapsed);

  // sessionStore（agent 焦点）
  useSessionStore.setState({ activeAgentId: null, panelAgentId: null });

  // workspaceStore：确保工作区非空
  const workspace = useWorkspaceStore.getState();
  if (!workspace.workspaces.length) {
    useWorkspaceStore.setState({
      workspaces: seedInitialWorkspaces(),
      activeWorkspaceIndex: 0,
    });
  }
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

  it('SETTINGS_TAB_IDS covers ; parseSettingsTab rejects ghosts', () => {
    expect(SETTINGS_TAB_IDS.length).toBeGreaterThanOrEqual(10);
    expect(is('profile')).toBe(true);
    expect(is('security')).toBe(true);
    expect(is('not-a-tab')).toBe(false);
    expect(is('')).toBe(false);
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
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('runtime');
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
    expect(a.activeSessionId).toBe('s1');
    expect(a.sessionsById.s1?.id).toBe('s1');
    expect(a.folderOrder).toEqual(['f', 'g']);

    const empty = sanitizeSessionSeed({
      sessions: [],
      activeSessionId: 'ghost',
      folderOrder: [],
    });
    expect(empty.activeSessionId).toBe('__pending_draft__');
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
    expect(s.activeSessionId).toBe('s1');
    expect(s.sessionsById.s1?.id).toBe('s1');
  });
});

// ── live store behavior ─────────────────────────────────────────────────────

describe('store initial invariants（域拆分后各域自证）', () => {
  it('workspaceStore：工作区非空、索引钳制、无 agent 幽灵卡', () => {
    const s = useWorkspaceStore.getState();
    expect(s.workspaces.length).toBeGreaterThanOrEqual(1);
    expect(s.activeWorkspaceIndex).toBeGreaterThanOrEqual(0);
    expect(s.activeWorkspaceIndex).toBeLessThan(s.workspaces.length);
    expect(s.draggedTab).toBeNull();
    expect(s.dropPreview).toBeNull();

    const ids = s.workspaces.flatMap((ws) =>
      ws.columns.flatMap((c) =>
        c.groups.flatMap((g) => g.cards.map((x) => x.id))
      )
    );
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('runtime');
    // 别名归一化：browser 必须已被收敛为 preview，不得作为卡片 id 存活
    expect(ids).not.toContain('browser');
  });

  it('sessionStore：agent 焦点无幽灵 + 活动会话保真', () => {
    const s = useSessionStore.getState();
    expect(s.activeAgentId).toBeNull();
    expect(s.panelAgentId).toBeNull();
    // active session fidelity
    if (s.activeSessionId && s.activeSessionId !== '__pending_draft__') {
      expect(s.sessionsById[s.activeSessionId]?.id).toBe(s.activeSessionId);
    }
  });

  it('layoutStore：uiSize 合法、chrome 字段就位', () => {
    const s = useLayoutStore.getState();
    const ok: UiSize[] = ['small', 'medium', 'large'];
    expect(ok).toContain(s.uiSize);
    expect(typeof s.tabModeEnabled).toBe('boolean');
    expect(typeof s.sidebarCollapsed).toBe('boolean');
    expect(typeof s.hydrationComplete).toBe('boolean');
    // 已迁走的域不得回流到壳层 store
    expect(s).not.toHaveProperty('workspaces');
    expect(s).not.toHaveProperty('activeSessionId');
    expect(s).not.toHaveProperty('sessionsById');
  });

  it('settingsActiveTab is a known tab', () => {
    expect(
      is(useSettingsUiStore.getState().settingsActiveTab)
    ).toBe(true);
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

  // T11：遥测/worker/diff/权限/设置 UI action 已迁往对应独立 store，
  // 各自独立测试见对应 .test.ts。
});
