import { beforeEach, describe, expect, it } from 'vitest';
import type { FileDiff, SessionState, WorkspaceState } from '../store/types';
import type { CronJob } from './clientApi';
import {
  PENDING_DRAFT_SESSION_ID,
  isPendingDraft,
} from '../store/draftSession';
import { usePermissionStore } from '../store/permissionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useTerminalStore } from '../store/terminalStore';
import {
  addCommandPermission,
  addMessage,
  addMessageToolCall,
  archiveSession,
  branchSession,
  closeSettings,
  createSession,
  createSessionAndOpenChat,
  enterDraftMode,
  filterCronJobs,
  findPanelCardLocation,
  findWorkspaceById,
  focusOrOpenPanel,
  getActiveDiffSource,
  getActiveSession,
  getActiveSessionId,
  getActiveWorkspace,
  getAppSettings,
  getCommandPermissions,
  getDiffFiles,
  getDropPreview,
  getLayoutState,
  getPermissionMode,
  getScheduledTasks,
  getSessionAgent,
  getSessionById,
  getSessionStoreState,
  getSettingsUiState,
  getWorkspaceById,
  getWorkspaceStoreState,
  hasSession,
  isCronJob,
  isDiffChange,
  isFileDiff,
  isNonEmptySessionId,
  normalizeCronJob,
  normalizeFileDiff,
  normalizeSessionId,
  openSettings,
  patchSession,
  pinSession,
  pushDiffFile,
  renameSession,
  resolveActiveSession,
  resolvePanelCardId,
  resolveSession,
  selectActiveSession,
  selectSessionAgent,
  selectSessionById,
  setActiveAgentId,
  setActiveDiffSource,
  setActiveSessionId,
  setAppSettings,
  setDropPreview,
  setGroupActiveCard,
  setPanelAgentId,
  setPermissionMode,
  setPlanModeEnabled,
  setScheduledTasks,
  setSettingsActiveTab,
  setShowSettingsOverlay,
  togglePanel,
  toggleSettingsOverlay,
  unarchiveSession,
  unpinSession,
  updateMessageToolCall,
  withActiveSession,
  withSession,
  workspaceHasCard,
} from './storeAccess';

// ── 纯函数单元（不依赖 / 不 mock zustand）──────────────────────────────────

describe('storeAccess pure helpers (no zustand mock)', () => {
  describe('session id guards', () => {
    it('isNonEmptySessionId rejects null/undefined/empty', () => {
      expect(isNonEmptySessionId(null)).toBe(false);
      expect(isNonEmptySessionId(undefined)).toBe(false);
      expect(isNonEmptySessionId('')).toBe(false);
      expect(isNonEmptySessionId('abc')).toBe(true);
    });

    it('normalizeSessionId trims and drops blank', () => {
      expect(normalizeSessionId(null)).toBeUndefined();
      expect(normalizeSessionId(undefined)).toBeUndefined();
      expect(normalizeSessionId('')).toBeUndefined();
      expect(normalizeSessionId('   ')).toBeUndefined();
      expect(normalizeSessionId('  sid-1  ')).toBe('sid-1');
    });
  });

  describe('selectSessionById / selectActiveSession / selectSessionAgent', () => {
    const sessions: SessionState[] = [
      {
        id: 's1',
        title: 'one',
        folder: '',
        isPinned: false,
        isArchived: false,
        timestamp: '1',
        messages: [],
        agents: [
          {
            id: 'a1',
            subagentRunId: 'r1',
            parentSessionId: 's1',
            parentRunId: 'pr1',
            description: 'helper',
            mode: 'default',
            status: 'running',
            messages: [],
            startedAt: 1,
            depth: 0,
            subagentPath: ['a1'],
          },
        ],
      },
      {
        id: 's2',
        title: 'two',
        folder: '',
        isPinned: false,
        isArchived: false,
        timestamp: '2',
        messages: [],
      },
    ];
    const byId: Readonly<Record<string, SessionState>> = {
      s1: sessions[0]!,
      s2: sessions[1]!,
    };

    it('selectSessionById uses index then falls back; guards empty id', () => {
      expect(selectSessionById(sessions, null)).toBeUndefined();
      expect(selectSessionById(sessions, '')).toBeUndefined();
      expect(selectSessionById(sessions, 's1', byId)?.title).toBe('one');
      expect(selectSessionById(sessions, 's2')?.title).toBe('two');
      expect(selectSessionById(sessions, 'missing')).toBeUndefined();
    });

    it('selectActiveSession returns undefined when active id empty', () => {
      expect(selectActiveSession(sessions, null, byId)).toBeUndefined();
      expect(selectActiveSession(sessions, 's2', byId)?.id).toBe('s2');
    });

    it('selectSessionAgent guards missing session/agent', () => {
      expect(selectSessionAgent(undefined, 'a1')).toBeUndefined();
      expect(selectSessionAgent(sessions[0], null)).toBeUndefined();
      expect(selectSessionAgent(sessions[0], 'a1')?.description).toBe('helper');
      expect(selectSessionAgent(sessions[0], 'nope')).toBeUndefined();
      expect(selectSessionAgent(sessions[1], 'a1')).toBeUndefined();
    });
  });

  describe('workspace pure lookups', () => {
    const ws: WorkspaceState = {
      id: 'ws-a',
      columns: [
        {
          id: 'col-0',
          widthRatio: 1,
          groups: [
            {
              id: 'g0',
              activeCardId: 'chat',
              heightRatio: 1,
              cards: [
                { id: 'chat', title: 'Chat' },
                { id: 'terminal', title: 'Terminal' },
              ],
            },
          ],
        },
      ],
    };

    it('findWorkspaceById guards empty id', () => {
      expect(findWorkspaceById([ws], null)).toBeUndefined();
      expect(findWorkspaceById([ws], '')).toBeUndefined();
      expect(findWorkspaceById([ws], 'ws-a')?.id).toBe('ws-a');
      expect(findWorkspaceById([ws], 'other')).toBeUndefined();
    });

    it('findPanelCardLocation + workspaceHasCard', () => {
      expect(findPanelCardLocation(null, 'chat')).toBeUndefined();
      expect(findPanelCardLocation(ws, '')).toBeUndefined();
      expect(findPanelCardLocation(ws, 'terminal')).toEqual({
        colIdx: 0,
        groupIdx: 0,
        cardId: 'terminal',
      });
      expect(workspaceHasCard(ws, 'chat')).toBe(true);
      expect(workspaceHasCard(ws, 'diff')).toBe(false);
    });

    it('resolvePanelCardId maps plan→tasks and drops settings', () => {
      expect(resolvePanelCardId(null)).toBeUndefined();
      expect(resolvePanelCardId('')).toBeUndefined();
      expect(resolvePanelCardId('settings')).toBeUndefined();
      expect(resolvePanelCardId('plan')).toBe('tasks');
      expect(resolvePanelCardId('terminal')).toBe('terminal');
    });
  });

  describe('FileDiff typing fidelity', () => {
    const good: FileDiff = {
      filePath: 'src/a.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: '+x', lineNum: 1 }],
    };

    it('isDiffChange / isFileDiff / normalizeFileDiff', () => {
      expect(isDiffChange({ type: 'addition', content: '+x' })).toBe(true);
      expect(isDiffChange({ type: 'bogus', content: 'x' })).toBe(false);
      expect(isDiffChange({ type: 'normal' })).toBe(false);

      expect(isFileDiff(good)).toBe(true);
      expect(isFileDiff(null)).toBe(false);
      expect(isFileDiff({ filePath: '', additions: 0, deletions: 0, changes: [] })).toBe(
        false,
      );
      expect(
        isFileDiff({
          filePath: 'x',
          additions: 0,
          deletions: 0,
          changes: [{ type: 'addition', content: 1 }],
        }),
      ).toBe(false);

      const n = normalizeFileDiff({
        filePath: '  path.ts  ',
        additions: 2,
        deletions: 1,
        changes: [{ type: 'deletion', content: '-y' }],
      });
      expect(n).toEqual({
        filePath: 'path.ts',
        additions: 2,
        deletions: 1,
        changes: [{ type: 'deletion', content: '-y' }],
      });
      expect(normalizeFileDiff({ filePath: 'x' })).toBeNull();
    });
  });

  describe('CronJob typing fidelity', () => {
    const good: CronJob = {
      id: 'cron-1',
      cronExpression: '0 3 * * *',
      prompt: 'nightly',
      targetSession: 'new-session',
      status: 'active',
      nextRun: new Date(0).toISOString(),
    };

    it('isCronJob / normalizeCronJob / filterCronJobs', () => {
      expect(isCronJob(good)).toBe(true);
      expect(isCronJob({ ...good, targetSession: 'other' })).toBe(false);
      expect(isCronJob({ ...good, status: 'done' })).toBe(false);
      expect(isCronJob({ ...good, id: '' })).toBe(false);

      expect(normalizeCronJob({ ...good, id: '  c2  ' })?.id).toBe('c2');
      expect(normalizeCronJob({ id: 'x' })).toBeNull();

      expect(filterCronJobs(null)).toEqual([]);
      expect(filterCronJobs(undefined)).toEqual([]);
      expect(filterCronJobs([good, { id: 'bad' }, null])).toEqual([good]);
    });
  });
});

// ── 集成：真实 layout store（不 mock zustand）──────────────────────────────

describe('storeAccess + domain facades', () => {
  beforeEach(() => {
    // 复位到可预期的会话/UI 切片，避免测试间污染
    const seedId = createSession({ title: 'storeAccess-seed', id: `sa-seed-${Date.now()}` });
    setActiveSessionId(seedId);
    closeSettings();
    setPermissionMode('ask');
    setPlanModeEnabled(false);
    setDropPreview(null);
    setActiveAgentId(null);
    setPanelAgentId(null);
    setActiveDiffSource(null);
    setAppSettings(null);
    setScheduledTasks([]);
  });

  it('getSessionStoreState / getActiveSession / getSessionById / getActiveSessionId stay consistent', () => {
    const id = getSessionStoreState().activeSessionId;
    expect(id).toBeTruthy();
    expect(getActiveSessionId()).toBe(id);
    const byId = getSessionById(id);
    const active = getActiveSession();
    expect(byId?.id).toBe(id);
    expect(active?.id).toBe(id);
    expect(byId).toBe(active);
  });

  it('resolveSession / hasSession / withSession guard null and missing ids', () => {
    const id = getActiveSessionId();
    expect(resolveSession(null)).toBeUndefined();
    expect(resolveSession(undefined)).toBeUndefined();
    expect(resolveSession('')).toBeUndefined();
    expect(resolveSession('   ')).toBeUndefined();
    expect(resolveSession('___missing_session___')).toBeUndefined();
    expect(hasSession(null)).toBe(false);
    expect(hasSession(id)).toBe(true);
    expect(resolveSession(id)?.id).toBe(id);
    expect(resolveActiveSession()?.id).toBe(id);

    let ran = false;
    withSession(null, () => {
      ran = true;
    });
    expect(ran).toBe(false);

    const title = withSession(id, (s) => s.title);
    expect(typeof title).toBe('string');

    const activeTitle = withActiveSession((s) => s.title);
    expect(activeTitle).toBe(getActiveSession()?.title);
  });

  it('session mutations no-op on empty/missing session id (no throw)', () => {
    const before = getActiveSessionId();
    expect(() => {
      patchSession('', { goalMode: null });
      patchSession('___nope___', {
        goalMode: { active: true, goal: 'x', iteration: 0, tasks: [] },
      });
      renameSession('', 'nope');
      pinSession('___nope___');
      archiveSession('');
      addMessage('ws', '', {
        id: 'm',
        sender: 'user',
        text: 'x',
        timestamp: 1,
        status: 'completed',
      });
    }).not.toThrow();
    expect(getActiveSessionId()).toBe(before);
    expect(getSessionById(before)?.title).toBeTruthy();
  });

  it('setActiveSessionId ignores empty id', () => {
    const before = getActiveSessionId();
    setActiveSessionId('');
    setActiveSessionId('   ');
    expect(getActiveSessionId()).toBe(before);
  });

  it('createSession + setActiveSessionId + patchSession + renameSession', () => {
    const id = createSession({ title: 'access-create', id: `sa-create-${Date.now()}` });
    setActiveSessionId(id);
    expect(getSessionStoreState().activeSessionId).toBe(id);
    expect(getSessionById(id)?.title).toBe('access-create');

    renameSession(id, 'access-renamed');
    expect(getSessionById(id)?.title).toBe('access-renamed');

    patchSession(id, {
      goalMode: {
        active: true,
        goal: 'ship facade',
        iteration: 1,
        tasks: [],
      },
    });
    expect(getSessionById(id)?.goalMode?.goal).toBe('ship facade');
    patchSession(id, { goalMode: null });
    // sessionActions 对 null/undefined 使用 delete，字段变为 undefined
    expect(getSessionById(id)?.goalMode).toBeUndefined();
  });

  it('createSessionAndOpenChat (deprecated): enterDraft only — no empty shell mint', () => {
    // Compat shim：名似 mint，实际只 enterDraft + chat surface；产品入口应 openNewDraftTab
    const seedId = getSessionStoreState().activeSessionId;
    const beforeLen = getSessionStoreState().sessions.length;
    const beforeIds = new Set(getSessionStoreState().sessions.map((s) => s.id));

    const returned = createSessionAndOpenChat('proj-draft');
    expect(returned).toBe(PENDING_DRAFT_SESSION_ID);
    expect(isPendingDraft(returned)).toBe(true);

    const st = getSessionStoreState();
    const layout = getLayoutState();
    expect(st.activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);
    // draftFolder 在 sessionStore 上
    expect(st.draftFolder).toBe('proj-draft');
    // sessions 不增、不 mint 默认标题空壳
    expect(st.sessions).toHaveLength(beforeLen);
    expect(st.sessions.every((s) => beforeIds.has(s.id))).toBe(true);
    expect(st.sessionsById[PENDING_DRAFT_SESSION_ID]).toBeUndefined();
    // chat surface 打开
    expect(layout.chatMainSurface).toBe('chat');

    // 连点：sessions 仍不变
    createSessionAndOpenChat('proj-draft-2');
    createSessionAndOpenChat('proj-draft-3');
    expect(getSessionStoreState().sessions).toHaveLength(beforeLen);
    expect(getSessionStoreState().activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);
    expect(getSessionStoreState().draftFolder).toBe('proj-draft-3');

    // 恢复 seed 避免污染后续用例
    if (seedId && !isPendingDraft(seedId)) {
      setActiveSessionId(seedId);
    } else {
      enterDraftMode();
    }
  });

  it('pinSession + unpinSession', () => {
    const id = getActiveSessionId();
    pinSession(id);
    expect(getSessionById(id)?.isPinned).toBe(true);
    unpinSession(id);
    expect(getSessionById(id)?.isPinned).toBeFalsy();
  });

  it('setActiveAgentId + setPanelAgentId', () => {
    // setActiveAgentId(non-null) remaps to panelAgentId; main column stays null
    setActiveAgentId('agent-a');
    expect(getSessionStoreState().activeAgentId).toBeNull();
    expect(getSessionStoreState().panelAgentId).toBe('agent-a');
    setPanelAgentId('agent-b');
    expect(getSessionStoreState().panelAgentId).toBe('agent-b');
    setActiveAgentId(null);
    setPanelAgentId(null);
    expect(getSessionStoreState().activeAgentId).toBeNull();
    expect(getSessionStoreState().panelAgentId).toBeNull();
  });

  it('addMessage + addMessageToolCall + updateMessageToolCall', () => {
    const sid = getSessionStoreState().activeSessionId;
    const msgId = `msg-${Date.now()}`;
    const toolId = `tool-${Date.now()}`;
    addMessage('ws-test', sid, {
      id: msgId,
      sender: 'assistant',
      text: 'hello',
      timestamp: Date.now(),
      status: 'completed',
    });
    expect(getSessionById(sid)?.messages.some((m) => m.id === msgId)).toBe(true);

    addMessageToolCall(sid, msgId, {
      id: toolId,
      name: 'shell',
      status: 'pending_approval',
      arguments: 'echo hi',
    });
    let tc = getSessionById(sid)
      ?.messages.find((m) => m.id === msgId)
      ?.toolCalls?.find((t) => t.id === toolId);
    expect(tc?.status).toBe('pending_approval');

    updateMessageToolCall(sid, msgId, toolId, {
      status: 'running',
      output: '执行中…',
    });
    tc = getSessionById(sid)
      ?.messages.find((m) => m.id === msgId)
      ?.toolCalls?.find((t) => t.id === toolId);
    expect(tc?.status).toBe('running');
    expect(tc?.output).toBe('执行中…');
  });

  it('branchSession creates a focused child session', () => {
    const parentId = getSessionStoreState().activeSessionId;
    branchSession(parentId, 'branched-from-access');
    const childId = getSessionStoreState().activeSessionId;
    expect(childId).not.toBe(parentId);
    expect(getSessionById(childId)?.title).toBe('branched-from-access');
  });

  it('archiveSession + unarchiveSession', () => {
    const id = createSession({
      title: 'to-archive',
      id: `sa-arch-${Date.now()}`,
      activate: false,
    });
    archiveSession(id);
    expect(getSessionById(id)?.isArchived).toBe(true);
    unarchiveSession(id);
    expect(getSessionById(id)?.isArchived).toBeFalsy();
  });

  it('settings UI: open / close / toggle / setSettingsActiveTab via storeAccess', () => {
    openSettings('models');
    expect(getSettingsUiState().showSettingsOverlay).toBe(true);
    expect(getSettingsUiState().settingsActiveTab).toBe('models');

    setSettingsActiveTab('security');
    expect(getSettingsUiState().settingsActiveTab).toBe('security');

    closeSettings();
    expect(getSettingsUiState().showSettingsOverlay).toBe(false);

    toggleSettingsOverlay();
    expect(getSettingsUiState().showSettingsOverlay).toBe(true);
    toggleSettingsOverlay();
    expect(getSettingsUiState().showSettingsOverlay).toBe(false);

    setShowSettingsOverlay(true);
    expect(getSettingsUiState().showSettingsOverlay).toBe(true);
  });

  it('getPermissionMode mirrors settings facade + permission store', () => {
    setPermissionMode('full');
    expect(getPermissionMode()).toBe('full');
    expect(getPermissionMode()).toBe('full');
    expect(usePermissionStore.getState().permissionMode).toBe('full');
    setPermissionMode('ask');
    expect(getPermissionMode()).toBe('ask');
  });

  it('getWorkspaceStoreState / getActiveWorkspace operate on workspace store', () => {
    const ws = getWorkspaceStoreState();
    expect(Array.isArray(ws.workspaces)).toBe(true);
    expect(typeof ws.togglePanel).toBe('function');
    expect(getActiveWorkspace()?.id).toBe(
      ws.workspaces[ws.activeWorkspaceIndex]?.id,
    );
  });

  it('getWorkspaceById + focusOrOpenPanel empty/missing guards', () => {
    const wsState = getWorkspaceStoreState();
    const wsId = wsState.workspaces[wsState.activeWorkspaceIndex]?.id;
    expect(wsId).toBeTruthy();
    if (!wsId) return;

    expect(getWorkspaceById(null)).toBeUndefined();
    expect(getWorkspaceById('')).toBeUndefined();
    expect(getWorkspaceById(wsId)?.id).toBe(wsId);
    expect(getWorkspaceById('___no_ws___')).toBeUndefined();

    // 空 / 未知工作区 no-op
    expect(() => {
      focusOrOpenPanel('', 'terminal');
      focusOrOpenPanel('___no_ws___', 'terminal');
      focusOrOpenPanel(wsId, '');
    }).not.toThrow();

    closeSettings();
    focusOrOpenPanel(wsId, 'settings');
    expect(getSettingsUiState().showSettingsOverlay).toBe(true);
  });

  it('setGroupActiveCard + togglePanel + focusOrOpenPanel touch workspace cards', () => {
    const wsState = getWorkspaceStoreState();
    const wsId = wsState.workspaces[wsState.activeWorkspaceIndex]?.id;
    expect(wsId).toBeTruthy();
    if (!wsId) return;

    // 默认工作区至少有 chat 列
    setGroupActiveCard(wsId, 0, 0, 'chat');
    const after = getWorkspaceStoreState();
    const group = after.workspaces.find((w) => w.id === wsId)?.columns[0]?.groups[0];
    expect(group?.activeCardId).toBe('chat');

    focusOrOpenPanel(wsId, 'terminal');
    const withTerm = getWorkspaceStoreState();
    const hasTerminal = withTerm.workspaces
      .find((w) => w.id === wsId)
      ?.columns.some((c) =>
        c.groups.some((g) => g.cards.some((card) => card.id === 'terminal')),
      );
    expect(hasTerminal).toBe(true);

    // settings 死映射 → 设置浮层
    closeSettings();
    focusOrOpenPanel(wsId, 'settings');
    expect(getSettingsUiState().showSettingsOverlay).toBe(true);

    // plan → tasks
    focusOrOpenPanel(wsId, 'plan');
    const hasTasks = getWorkspaceStoreState()
      .workspaces.find((w) => w.id === wsId)
      ?.columns.some((c) =>
        c.groups.some((g) => g.cards.some((card) => card.id === 'tasks')),
      );
    expect(hasTasks).toBe(true);

    togglePanel(wsId, 'diff', true);
    const hasDiff = getWorkspaceStoreState()
      .workspaces.find((w) => w.id === wsId)
      ?.columns.some((c) =>
        c.groups.some((g) => g.cards.some((card) => card.id === 'diff')),
      );
    expect(hasDiff).toBe(true);
  });

  it('setDropPreview / getDropPreview writes workspace DnD slice', () => {
    setDropPreview({ colIdx: 1, groupIdx: 0, direction: 'top' });
    expect(getDropPreview()).toEqual({
      colIdx: 1,
      groupIdx: 0,
      direction: 'top',
    });
    expect(getWorkspaceStoreState().dropPreview).toEqual({
      colIdx: 1,
      groupIdx: 0,
      direction: 'top',
    });
    setDropPreview(null);
    expect(getDropPreview()).toBeNull();
  });

  it('cross-domain: pushDiffFile / setActiveDiffSource with FileDiff fidelity', () => {
    const diff: FileDiff = {
      filePath: 'src/api/storeAccess.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: '+export function getLayoutState()' }],
    };
    pushDiffFile(diff);
    expect(getDiffFiles().some((d) => d.filePath === diff.filePath)).toBe(true);
    expect(useTerminalStore.getState().diffFiles.some((d) => d.filePath === diff.filePath)).toBe(true);
    setActiveDiffSource(diff);
    expect(getActiveDiffSource()?.filePath).toBe(diff.filePath);
    expect(useTerminalStore.getState().activeDiffSource?.filePath).toBe(diff.filePath);

    // 非法 FileDiff 不写入、不清空已有 active
    const beforeActive = getActiveDiffSource()?.filePath;
    pushDiffFile({ filePath: '', additions: 0, deletions: 0, changes: [] } as FileDiff);
    expect(getDiffFiles().some((d) => d.filePath === '')).toBe(false);
    setActiveDiffSource({ filePath: '', additions: 1, deletions: 0, changes: [] } as FileDiff);
    expect(getActiveDiffSource()?.filePath).toBe(beforeActive);

    setActiveDiffSource(null);
    expect(getActiveDiffSource()).toBeNull();
  });

  it('cross-domain: setAppSettings / setScheduledTasks / CronJob fidelity', () => {
    const settings = { packages: ['@crish/demo'] } as Parameters<typeof setAppSettings>[0];
    setAppSettings(settings);
    expect(getAppSettings()).toEqual(settings);
    expect(useSettingsStore.getState().appSettings).toEqual(settings);

    const tasks: CronJob[] = [
      {
        id: 'cron-1',
        cronExpression: '0 3 * * *',
        prompt: 'nightly',
        targetSession: 'new-session',
        status: 'active',
        nextRun: new Date(0).toISOString(),
      },
    ];
    setScheduledTasks(tasks);
    expect(getScheduledTasks()).toEqual(tasks);

    // 混入非法项时只保留合法 CronJob
    setScheduledTasks([
      tasks[0]!,
      { id: 'bad' } as CronJob,
      {
        id: 'cron-2',
        cronExpression: '* * * * *',
        prompt: 'ok',
        targetSession: 'current-session',
        status: 'paused',
        nextRun: 't',
      },
    ]);
    const stored = getScheduledTasks();
    expect(stored.map((t) => t.id).sort()).toEqual(['cron-1', 'cron-2']);
    expect(stored.every(isCronJob)).toBe(true);

    setAppSettings(null);
    setScheduledTasks([]);
    expect(getScheduledTasks()).toEqual([]);
  });

  it('cross-domain: addCommandPermission + getCommandPermissions', () => {
    const before = getCommandPermissions().length;
    const cmd = `sa-perm-${Date.now()}`;
    addCommandPermission(cmd);
    const list = getCommandPermissions();
    expect(list.length).toBeGreaterThanOrEqual(before);
    expect(list.some((c) => c.includes(cmd) || c === cmd)).toBe(true);
  });

  it('getSessionAgent returns undefined for missing agent', () => {
    const sid = getActiveSessionId();
    expect(getSessionAgent(sid, '___no_such_agent___')).toBeUndefined();
  });
});
