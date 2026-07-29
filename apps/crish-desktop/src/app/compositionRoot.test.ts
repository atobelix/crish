import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  getCompositionRoot,
  killAllPtysOnAppExit,
  registerCompositionRoot,
  resetCompositionRoot,
} from './compositionRoot';
import {
  registerPtyBinding,
  registerPtyHandlers,
  resetPtyRegistryForTests,
  ptyRegistry,
} from '../api/ptyRegistry';
import {
  getSnapshot,
  resetControlMetrics,
} from '../api/controlMetrics';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';

// 避免 dispatch 真连 daemon WS（同 runControlClient.test）
vi.mock('../api/daemonClient', () => ({
  getDesktopDaemonClient: () => {
    throw new Error('no-daemon-in-unit');
  },
}));

describe('compositionRoot (B3)', () => {
  beforeEach(() => {
    resetCompositionRoot();
    resetPtyRegistryForTests();
    resetControlMetrics();
  });

  it('register 后暴露 pty / session / shell / layout / workspace / tree / runControl / metrics 门面', () => {
    const root = registerCompositionRoot();
    expect(typeof root.pty.getHandlers).toBe('function');
    expect(typeof root.pty.killAll).toBe('function');
    expect(typeof root.session.getState).toBe('function');
    expect(typeof root.session.getActiveSessionId).toBe('function');
    expect(typeof root.session.enterDraft).toBe('function');
    expect(typeof root.session.openOrFocusSession).toBe('function');
    expect(typeof root.session.pinSession).toBe('function');
    expect(typeof root.session.unpinSession).toBe('function');
    expect(typeof root.session.archiveSession).toBe('function');
    expect(typeof root.session.unarchiveSession).toBe('function');
    expect(typeof root.session.branchSession).toBe('function');
    expect(typeof root.shell.getState).toBe('function');
    expect(typeof root.shell.openNewDraftTab).toBe('function');
    expect(typeof root.shell.setShellReady).toBe('function');
    expect(typeof root.layout.getState).toBe('function');
    expect(typeof root.layout.getSessions).toBe('function');
    expect(typeof root.layout.setSessions).toBe('function');
    expect(typeof root.layout.setTabModeEnabled).toBe('function');
    expect(typeof root.layout.getSidebarCollapsed).toBe('function');
    expect(typeof root.layout.setSidebarCollapsed).toBe('function');
    expect(typeof root.layout.toggleSidebarCollapsed).toBe('function');
    expect(typeof root.layout.getPlanModeEnabled).toBe('function');
    expect(typeof root.layout.setPlanModeEnabled).toBe('function');
    expect(typeof root.layout.togglePlanMode).toBe('function');
    expect(typeof root.layout.getAppSettings).toBe('function');
    expect(typeof root.layout.setAppSettings).toBe('function');
    expect(typeof root.workspace.getState).toBe('function');
    // tree ≠ layout：geometry / leaf↔session，非 chrome·sessions god-object
    expect(typeof root.tree.getState).toBe('function');
    expect(typeof root.tree.setLeafSessionId).toBe('function');
    expect(typeof root.runControl.dispatch).toBe('function');
    expect(typeof root.runControl.cooperativeStop).toBe('function');
    expect(typeof root.runControl.forceCancel).toBe('function');
    expect(typeof root.runControl.followUp).toBe('function');
    expect(typeof root.runControl.softInject).toBe('function');
    expect(typeof root.metrics.getSnapshot).toBe('function');
    expect(typeof root.metrics.record).toBe('function');
  });

  it('getCompositionRoot 未登记时惰性 register', () => {
    const root = getCompositionRoot();
    expect(root.session.getActiveSessionId).toBeTypeOf('function');
    // 幂等
    expect(getCompositionRoot()).toBe(root);
  });

  it('overrides 可替换单门面', () => {
    const fakeSession = {
      getState: () => ({}) as never,
      getActiveSessionId: () => 'sess-override',
      enterDraft: vi.fn(),
      openOrFocusSession: vi.fn(),
      pinSession: vi.fn(),
      unpinSession: vi.fn(),
      archiveSession: vi.fn(),
      unarchiveSession: vi.fn(),
      branchSession: vi.fn(),
    };
    const root = registerCompositionRoot({ session: fakeSession });
    expect(root.session.getActiveSessionId()).toBe('sess-override');
  });

  it('pty.killAll 清空全部 session 绑定（exit 门面）', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerCompositionRoot();
    registerPtyBinding('s1', 'pty-1');
    registerPtyBinding('s2', 'pty-2');

    const killed = await getCompositionRoot().pty.killAll();
    expect(killed.sort()).toEqual(['s1', 's2']);
    expect(ptyRegistry.size).toBe(0);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('session 门面：enterDraft / openOrFocusSession 可被 override 调用', () => {
    const enterDraft = vi.fn();
    const openOrFocusSession = vi.fn();
    const root = registerCompositionRoot({
      session: {
        getState: () => ({}) as never,
        getActiveSessionId: () => null as never,
        enterDraft,
        openOrFocusSession,
        pinSession: vi.fn(),
        unpinSession: vi.fn(),
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        branchSession: vi.fn(),
      },
    });
    root.session.enterDraft('proj-a');
    root.session.openOrFocusSession('s-1', { title: 'T' });
    expect(enterDraft).toHaveBeenCalledWith('proj-a');
    expect(openOrFocusSession).toHaveBeenCalledWith('s-1', { title: 'T' });
  });

  it('session 门面：pin / unpin / archive / unarchive / branch 可被 override 调用', () => {
    const pinSession = vi.fn();
    const unpinSession = vi.fn();
    const archiveSession = vi.fn();
    const unarchiveSession = vi.fn();
    const branchSession = vi.fn();
    const root = registerCompositionRoot({
      session: {
        getState: () => ({}) as never,
        getActiveSessionId: () => null as never,
        enterDraft: vi.fn(),
        openOrFocusSession: vi.fn(),
        pinSession,
        unpinSession,
        archiveSession,
        unarchiveSession,
        branchSession,
      },
    });
    root.session.pinSession('s-pin');
    root.session.unpinSession('s-unpin');
    root.session.archiveSession('s-arch');
    root.session.unarchiveSession('s-unarch');
    root.session.branchSession('s-src', '分叉标题');
    expect(pinSession).toHaveBeenCalledWith('s-pin');
    expect(unpinSession).toHaveBeenCalledWith('s-unpin');
    expect(archiveSession).toHaveBeenCalledWith('s-arch');
    expect(unarchiveSession).toHaveBeenCalledWith('s-unarch');
    expect(branchSession).toHaveBeenCalledWith('s-src', '分叉标题');
  });

  it('shell 门面：openNewDraftTab / setShellReady 可被 override 调用', () => {
    const openNewDraftTab = vi.fn();
    const setShellReady = vi.fn();
    const root = registerCompositionRoot({
      shell: {
        getState: () => ({}) as never,
        openNewDraftTab,
        setShellReady,
      },
    });
    root.shell.openNewDraftTab('folder-x');
    root.shell.setShellReady(true);
    expect(openNewDraftTab).toHaveBeenCalledWith('folder-x');
    expect(setShellReady).toHaveBeenCalledWith(true);
  });

  it('layout 门面：sessions / tabMode / sidebar / planMode / appSettings 可被 override 调用', () => {
    const setSessions = vi.fn();
    const setTabModeEnabled = vi.fn();
    const setSidebarCollapsed = vi.fn();
    const setPlanModeEnabled = vi.fn();
    const setAppSettings = vi.fn();
    let sidebar = false;
    let plan = false;
    let appSettings: { theme: string } | null = { theme: 'dark' };
    const root = registerCompositionRoot({
      layout: {
        getState: () => ({}) as never,
        getSessions: () => [{ id: 's1' }] as never,
        setSessions,
        setTabModeEnabled,
        getSidebarCollapsed: () => sidebar,
        setSidebarCollapsed: (v) => {
          sidebar = v;
          setSidebarCollapsed(v);
        },
        toggleSidebarCollapsed: () => {
          sidebar = !sidebar;
          setSidebarCollapsed(sidebar);
        },
        getPlanModeEnabled: () => plan,
        setPlanModeEnabled: (v) => {
          plan = v;
          setPlanModeEnabled(v);
        },
        togglePlanMode: () => {
          plan = !plan;
          setPlanModeEnabled(plan);
        },
        getAppSettings: () => appSettings as never,
        setAppSettings: (s) => {
          appSettings = s as { theme: string } | null;
          setAppSettings(s);
        },
      },
    });
    expect(root.layout.getSessions()).toEqual([{ id: 's1' }]);
    root.layout.setSessions([{ id: 's2' }] as never);
    root.layout.setTabModeEnabled(true);
    root.layout.toggleSidebarCollapsed();
    root.layout.togglePlanMode();
    root.layout.setAppSettings({ theme: 'light' } as never);
    expect(setSessions).toHaveBeenCalledWith([{ id: 's2' }]);
    expect(setTabModeEnabled).toHaveBeenCalledWith(true);
    expect(setSidebarCollapsed).toHaveBeenCalledWith(true);
    expect(setPlanModeEnabled).toHaveBeenCalledWith(true);
    expect(setAppSettings).toHaveBeenCalledWith({ theme: 'light' });
    expect(root.layout.getAppSettings()).toEqual({ theme: 'light' });
  });

  it('tree 门面：getState / setLeafSessionId 可被 override 调用', () => {
    const setLeafSessionId = vi.fn();
    const fakeTreeState = {
      tree: { root: { id: 'leaf-1' } },
      setToolColumnCollapsed: vi.fn(),
    };
    const root = registerCompositionRoot({
      tree: {
        getState: () => fakeTreeState as never,
        setLeafSessionId,
      },
    });
    expect(root.tree.getState().tree.root.id).toBe('leaf-1');
    root.tree.setLeafSessionId('leaf-1', 'sess-a');
    expect(setLeafSessionId).toHaveBeenCalledWith('leaf-1', 'sess-a');
  });

  it('B3 hydrate 路径：tree.getState 同形读 tree / setToolColumnCollapsed', () => {
    const setToolColumnCollapsed = vi.fn();
    const getState = vi.fn(() => ({
      tree: { root: { id: 'r', type: 'leaf' } },
      setToolColumnCollapsed,
    }));
    registerCompositionRoot({
      tree: {
        getState: getState as never,
        setLeafSessionId: vi.fn(),
      },
    });
    // 与 hydrateWorkspaceShell 同形
    const tree = getCompositionRoot().tree;
    const st = tree.getState();
    expect(st.tree.root.id).toBe('r');
    st.setToolColumnCollapsed(false);
    expect(getState).toHaveBeenCalled();
    expect(setToolColumnCollapsed).toHaveBeenCalledWith(false);
  });

  it('B3 bootstrap 路径：layout.getSessions / setSessions / setTabModeEnabled / setAppSettings 同形调用', () => {
    const getSessions = vi.fn(() => [] as never);
    const setSessions = vi.fn();
    const setTabModeEnabled = vi.fn();
    const setAppSettings = vi.fn();
    registerCompositionRoot({
      layout: {
        getState: () => ({}) as never,
        getSessions,
        setSessions,
        setTabModeEnabled,
        getSidebarCollapsed: () => false,
        setSidebarCollapsed: vi.fn(),
        toggleSidebarCollapsed: vi.fn(),
        getPlanModeEnabled: () => false,
        setPlanModeEnabled: vi.fn(),
        togglePlanMode: vi.fn(),
        getAppSettings: () => null,
        setAppSettings,
      },
    });
    // 与 AppBootstrap / useEngineBootstrap syncSessionsFromDaemon 同形
    const layout = getCompositionRoot().layout;
    const sessions = layout.getSessions();
    layout.setSessions(sessions);
    layout.setTabModeEnabled(true);
    layout.setAppSettings({ theme: 'dark' } as never);
    expect(getSessions).toHaveBeenCalled();
    expect(setSessions).toHaveBeenCalledWith([]);
    expect(setTabModeEnabled).toHaveBeenCalledWith(true);
    expect(setAppSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('B3 入口：getCompositionRoot().shell.openNewDraftTab / session.openOrFocusSession 转发', () => {
    const openNewDraftTab = vi.fn();
    const openOrFocusSession = vi.fn();
    const enterDraft = vi.fn();
    registerCompositionRoot({
      shell: {
        getState: () => ({}) as never,
        openNewDraftTab,
        setShellReady: vi.fn(),
      },
      session: {
        getState: () => ({}) as never,
        getActiveSessionId: () => null as never,
        enterDraft,
        openOrFocusSession,
        pinSession: vi.fn(),
        unpinSession: vi.fn(),
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        branchSession: vi.fn(),
      },
    });
    // 与 Sidebar / ChatEmptyState / AppShortcuts 同形调用
    getCompositionRoot().shell.openNewDraftTab(undefined);
    getCompositionRoot().shell.openNewDraftTab('proj-b');
    getCompositionRoot().session.openOrFocusSession('s-entry', {
      title: 'T',
      workspaceKey: 'proj-b',
    });
    getCompositionRoot().session.enterDraft('proj-b');
    expect(openNewDraftTab).toHaveBeenNthCalledWith(1, undefined);
    expect(openNewDraftTab).toHaveBeenNthCalledWith(2, 'proj-b');
    expect(openOrFocusSession).toHaveBeenCalledWith('s-entry', {
      title: 'T',
      workspaceKey: 'proj-b',
    });
    expect(enterDraft).toHaveBeenCalledWith('proj-b');
  });

  it('runControl 门面：dispatch L2/L3 写入 metrics（无 daemon 亦可）', async () => {
    const root = registerCompositionRoot();
    await root.runControl.dispatch({
      level: RUN_CONTROL_LEVEL.L2,
      runId: 'r-l2',
    });
    await root.runControl.dispatch({
      level: RUN_CONTROL_LEVEL.L3,
      runId: 'r-l3',
    });
    const snap = root.metrics.getSnapshot();
    expect(snap.run_control_L2).toBe(1);
    expect(snap.run_control_L3).toBe(1);
  });

  it('metrics 门面：record + getSnapshot', () => {
    const root = registerCompositionRoot();
    root.metrics.record('draft_enter');
    root.metrics.record('message_upsert', 2);
    const snap = root.metrics.getSnapshot();
    expect(snap.draft_enter).toBe(1);
    expect(snap.message_upsert).toBe(2);
    // 与 controlMetrics 同源
    expect(getSnapshot().draft_enter).toBe(1);
  });

  it('runControl.cooperativeStop / forceCancel 转发到 dispatch 语义', async () => {
    const dispatch = vi.fn(async () => true);
    const root = registerCompositionRoot({
      runControl: {
        dispatch,
        cooperativeStop: (opts) =>
          dispatch({
            level: RUN_CONTROL_LEVEL.L2,
            runId: opts.runId,
            sessionId: opts.sessionId,
            reason: opts.reason ?? 'ui-stop',
          }),
        forceCancel: (opts) =>
          dispatch({
            level: RUN_CONTROL_LEVEL.L3,
            runId: opts.runId,
            sessionId: opts.sessionId,
            reason: opts.reason ?? 'ui-force-cancel',
          }),
        followUp: (opts) =>
          dispatch({
            level: RUN_CONTROL_LEVEL.L1,
            runId: opts.runId,
            sessionId: opts.sessionId,
            reason: opts.reason ?? 'ui-follow-up',
            payload: { kind: 'follow_up', text: opts.text },
          }),
        softInject: (opts) =>
          dispatch({
            level: RUN_CONTROL_LEVEL.L1,
            runId: opts.runId,
            sessionId: opts.sessionId,
            reason: opts.reason ?? 'ui-soft-inject',
            payload: { kind: opts.kind ?? 'soft_inject', text: opts.text },
          }),
      },
    });
    await root.runControl.cooperativeStop({ runId: 'r1', sessionId: 's1' });
    await root.runControl.forceCancel({ runId: 'r2' });
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      level: RUN_CONTROL_LEVEL.L2,
      runId: 'r1',
      sessionId: 's1',
      reason: 'ui-stop',
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      level: RUN_CONTROL_LEVEL.L3,
      runId: 'r2',
      sessionId: undefined,
      reason: 'ui-force-cancel',
    });
  });

  it('runControl.followUp 记 L1 且不 cancel（send-while-running）', async () => {
    const root = registerCompositionRoot();
    await root.runControl.followUp({
      sessionId: 's-busy',
      text: 'later please',
      reason: 'ui-send-while-running',
    });
    const snap = root.metrics.getSnapshot();
    expect(snap.run_control_L1).toBe(1);
    expect(snap.run_control_L2).toBe(0);
    expect(snap.run_control_L3).toBe(0);
  });
});

describe('killAllPtysOnAppExit (app exit path)', () => {
  beforeEach(() => {
    resetCompositionRoot();
    resetPtyRegistryForTests();
  });

  it('走 compositionRoot.pty.killAll，不清抛', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerCompositionRoot();
    registerPtyBinding('exit-s', 'pty-exit');

    expect(() => killAllPtysOnAppExit()).not.toThrow();
    // fire-and-forget：等 promise 完成
    await vi.waitFor(() => {
      expect(ptyRegistry.size).toBe(0);
    });
    expect(kill).toHaveBeenCalledWith('pty-exit', 'exit-s');
  });

  it('未 register 时惰性门面仍可 kill', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerPtyBinding('lazy-s', 'pty-lazy');
    // 不调用 registerCompositionRoot
    killAllPtysOnAppExit();
    await vi.waitFor(() => {
      expect(ptyRegistry.size).toBe(0);
    });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
