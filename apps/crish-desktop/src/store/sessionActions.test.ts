import { produce } from 'immer';
import { describe, expect, it, vi } from 'vitest';
import { GENERAL_FOLDER } from '../api/projectStore';
import { createSessionActions, type SessionStoreSlice } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from './draftSession';
import type { SessionMessage, SessionState } from './types';

// setActiveSessionId 正式版会动态 import projectStore 并 dispatch window 事件；
// node 测试环境无 DOM，统一走 demo 短路避免 unhandled rejection。
vi.mock('../api/appMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/appMode')>();
  return {
    ...actual,
    isDemoMode: () => true,
  };
});

function makeMessage(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id'>
): SessionMessage {
  return {
    sender: 'assistant',
    timestamp: 1,
    ...partial,
  };
}

/**
 * 测试辅助：从 sessionsById 取某个 session，缺失时抛出明确错误。
 * 用于在严格空检查下避免 `!` 断言，同时给出可读的失败信息。
 */
function getSessionOrThrow(
  state: SessionStoreSlice,
  id: string
): SessionState {
  const s = state.sessionsById[id];
  if (!s) throw new Error(`test harness: expected session "${id}" to exist`);
  return s;
}

/**
 * 测试辅助：取某 session 的第 N 条消息，缺失时抛出明确错误。
 */
function getMessageOrThrow(
  state: SessionStoreSlice,
  sessionId: string,
  index: number
): SessionMessage {
  const session = getSessionOrThrow(state, sessionId);
  const msg = session.messages[index];
  if (!msg) {
    throw new Error(
      `test harness: expected message at index ${index} in session "${sessionId}" to exist`
    );
  }
  return msg;
}

function emptyShell(
  partial: Partial<SessionState> & { id: string }
): SessionState {
  return {
    title: '新会话',
    folder: GENERAL_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: [],
    ...partial,
  };
}

function makeStateFromSessions(
  sessions: SessionState[],
  activeSessionId: string,
  draftFolder = ''
): SessionStoreSlice {
  return {
    sessions,
    sessionsById: buildSessionsById(sessions),
    folderOrder: Array.from(new Set(sessions.map((s) => s.folder))),
    activeSessionId,
    draftFolder,
    activeAgentId: null,
    panelAgentId: null,
    terminalLines: [],
    terminalBySession: {},
    composerDrafts: {},
  };
}

function makeState(messages: SessionMessage[]): SessionStoreSlice {
  const session: SessionState = {
    id: 's1',
    title: 't',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages,
  };
  return makeStateFromSessions([session], 's1');
}

/** Minimal immer set/get harness for SessionActions. */
function makeHarness(messages: SessionMessage[]) {
  return makeHarnessFromState(makeState(messages));
}

function makeHarnessFromState(initial: SessionStoreSlice) {
  let state = initial;
  let produceCalls = 0;
  let changed = false;

  const set = (recipe: (draft: SessionStoreSlice) => void) => {
    produceCalls += 1;
    const next = produce(state, recipe);
    changed = next !== state;
    state = next;
  };
  const get = () => state;
  const actions = createSessionActions(set, get);

  return {
    actions,
    getState: () => state,
    get produceCalls() {
      return produceCalls;
    },
    get changed() {
      return changed;
    },
    // Actions mutate via getSessionById → sessionsById; read the same path.
    message: () => getMessageOrThrow(state, 's1', 0),
  };
}

describe('sessionActions message no-op short-circuit', () => {
  it('updateMessageText same string does not replace state tree', () => {
    const h = makeHarness([
      makeMessage({
        id: 'm1',
        text: 'hello',
        blocks: [{ type: 'text', content: 'hello' }],
      }),
    ]);
    const before = h.getState();
    h.actions.updateMessageText('s1', 'm1', 'hello');
    expect(h.changed).toBe(false);
    expect(h.getState()).toBe(before);
    expect(h.message().text).toBe('hello');
  });

  it('updateMessageThinking same string is a no-op', () => {
    const h = makeHarness([makeMessage({ id: 'm1', thinking: 'plan A' })]);
    const before = h.getState();
    h.actions.updateMessageThinking('s1', 'm1', 'plan A');
    expect(h.changed).toBe(false);
    expect(h.getState()).toBe(before);
  });

  it('updateMessageToolCall identical fields is a no-op', () => {
    const h = makeHarness([
      makeMessage({
        id: 'm1',
        toolCalls: [
          {
            id: 'tc1',
            name: 'read',
            arguments: '{}',
            status: 'running',
            output: 'partial',
          },
        ],
      }),
    ]);
    const before = h.getState();
    h.actions.updateMessageToolCall('s1', 'm1', 'tc1', {
      status: 'running',
      output: 'partial',
    });
    expect(h.changed).toBe(false);
    expect(h.getState()).toBe(before);
  });

  it('setSessionMessageStatus same status/thinkingTime is a no-op', () => {
    const h = makeHarness([
      makeMessage({ id: 'm1', status: 'processing', thinkingTime: 12 }),
    ]);
    const before = h.getState();
    h.actions.setSessionMessageStatus('s1', 'm1', 'processing', 12);
    expect(h.changed).toBe(false);
    expect(h.getState()).toBe(before);
  });

  it('updateMessageText different string still updates', () => {
    const h = makeHarness([makeMessage({ id: 'm1', text: 'a' })]);
    h.actions.updateMessageText('s1', 'm1', 'ab');
    expect(h.changed).toBe(true);
    expect(h.message().text).toBe('ab');
  });
});

describe('sessionActions create/prune paths', () => {
  it('setSessions prunes non-active empty shells but keeps scheduled titles', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'active' }),
          emptyShell({ id: 'ghost' }),
          emptyShell({ id: 'sched', title: '定时 · 巡检' }),
          emptyShell({
            id: 'content',
            title: '新会话',
            messages: [
              makeMessage({ id: 'm', sender: 'user', text: '有正文' }),
            ],
          }),
        ],
        'active'
      )
    );
    h.actions.setSessions(h.getState().sessions);
    const ids = h.getState().sessions.map((s) => s.id);
    expect(ids).toContain('active');
    expect(ids).toContain('sched');
    expect(ids).toContain('content');
    expect(ids).not.toContain('ghost');
    // 有消息的默认标题被推导
    expect(getSessionOrThrow(h.getState(), 'content').title).toContain('有正文');
  });

  it('createSession activate:false keeps current active shell and scheduled title', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 'active-shell' }), emptyShell({ id: 'other-ghost' })],
        'active-shell'
      )
    );
    const schedId = h.actions.createSession({
      id: 'wf-sched-1',
      title: '定时 · 每日 PR 总结',
      folder: GENERAL_FOLDER,
      activate: false,
    });
    expect(schedId).toBe('wf-sched-1');
    const st = h.getState();
    // 不抢焦点
    expect(st.activeSessionId).toBe('active-shell');
    expect(st.sessionsById['wf-sched-1']?.title).toBe('定时 · 每日 PR 总结');
    // activate:false 后台建壳不误删用户空壳 / 其它幽灵
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['active-shell', 'other-ghost', 'wf-sched-1'].sort()
    );
  });

  it('createSession activate:true keeps previous empty shells when minting new', () => {
    // mint 新会话不再剪掉旧空壳，避免用户连建后一切换就丢
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'old-active' }),
          emptyShell({ id: 'ghost-2' }),
          emptyShell({
            id: 'kept-content',
            title: '真实对话',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
        ],
        'old-active'
      )
    );
    const newId = h.actions.createSession({
      id: 'brand-new',
      title: '新会话',
      folder: GENERAL_FOLDER,
      activate: true,
    });
    expect(newId).toBe('brand-new');
    const st = h.getState();
    expect(st.activeSessionId).toBe('brand-new');
    const ids = st.sessions.map((s) => s.id);
    expect(ids).toContain('brand-new');
    expect(ids).toContain('kept-content');
    expect(ids).toContain('old-active');
    expect(ids).toContain('ghost-2'); // mint 不 prune 既有空壳
  });

  it('createSession does not reuse scheduled empty-looking session as shell', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'sched',
            title: '定时 · 任务',
            folder: GENERAL_FOLDER,
          }),
        ],
        'sched'
      )
    );
    // 无 explicit id：若复用逻辑误把定时当壳，会返回 sched
    const id = h.actions.createSession({
      title: '新会话',
      folder: GENERAL_FOLDER,
      activate: true,
    });
    expect(id).not.toBe('sched');
    const st = h.getState();
    expect(st.sessionsById.sched?.title).toBe('定时 · 任务');
    expect(st.activeSessionId).toBe(id);
  });

  it('setActiveSessionId does not prune other empty shells', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'a' }),
          emptyShell({ id: 'b' }),
          emptyShell({ id: 'sched', title: '定时 · x' }),
        ],
        'a'
      )
    );
    h.actions.setActiveSessionId('b');
    const st = h.getState();
    expect(st.activeSessionId).toBe('b');
    // 切换只改焦点，空「新会话」仍保留（用户可再点回来）
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['a', 'b', 'sched'].sort()
    );
  });

  it('createSession activate:true always mints (never reuses empty shell)', () => {
    // draft 契约：无 reuse；mint 新 id 且保留既有空壳（连建不丢）
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'active-shell', folder: demoFolder }),
          emptyShell({ id: 'peer-ghost', folder: demoFolder }),
          emptyShell({
            id: 'content',
            title: '已有',
            folder: demoFolder,
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
        ],
        'active-shell'
      )
    );
    const id = h.actions.createSession({ activate: true });
    expect(id).not.toBe('active-shell');
    expect(id).not.toBe('peer-ghost');
    const st = h.getState();
    expect(st.activeSessionId).toBe(id);
    expect(st.sessionsById[id]).toBeDefined();
    // mint 不 prune peer / 旧活动空壳
    expect(st.sessionsById['active-shell']).toBeDefined();
    expect(st.sessionsById['peer-ghost']).toBeDefined();
    expect(st.sessionsById.content).toBeDefined();
  });

  it('createSession activate:false without id never reuses empty shell', () => {
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 'active-shell', folder: demoFolder })],
        'active-shell'
      )
    );
    const id = h.actions.createSession({
      title: '后台壳',
      activate: false,
    });
    // 不得吞掉用户正在看的空白活动会话
    expect(id).not.toBe('active-shell');
    const st = h.getState();
    expect(st.activeSessionId).toBe('active-shell');
    expect(st.sessionsById['active-shell']).toBeDefined();
    expect(st.sessionsById[id]).toBeDefined();
    // 非活动默认标题空壳会被 prune；若 title 为真实则保留
    expect(st.sessionsById[id]?.title).toBe('后台壳');
  });

  it('setActiveSessionId keeps pinned empty shell', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'a' }),
          emptyShell({ id: 'pinned-ghost', isPinned: true }),
          emptyShell({ id: 'b' }),
        ],
        'a'
      )
    );
    h.actions.setActiveSessionId('b');
    const st = h.getState();
    // 切换不 prune：空壳 a 与 pinned 都保留
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['a', 'b', 'pinned-ghost'].sort()
    );
  });

  it('createSession activate:true existing id prunes other empty shells', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'old' }),
          emptyShell({ id: 'target' }),
          emptyShell({ id: 'sched', title: '定时 · keep' }),
        ],
        'old'
      )
    );
    const id = h.actions.createSession({
      id: 'target',
      activate: true,
    });
    expect(id).toBe('target');
    const st = h.getState();
    expect(st.activeSessionId).toBe('target');
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['sched', 'target'].sort()
    );
  });

  it('createSession never swallows content session as shell', () => {
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'was-shell',
            folder: demoFolder,
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
        ],
        'was-shell'
      )
    );
    const id = h.actions.createSession({ activate: true });
    // mint 新 id，不改动已有正文
    expect(id).not.toBe('was-shell');
    const st = h.getState();
    expect(st.sessionsById['was-shell']).toBeDefined();
    expect(getSessionOrThrow(st, 'was-shell').messages).toHaveLength(1);
    expect(st.activeSessionId).toBe(id);
    expect(st.sessionsById[id]).toBeDefined();
  });

  it('createSession mints even when peer empty shell exists', () => {
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'active-content',
            folder: demoFolder,
            title: '进行中',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'work' })],
          }),
          emptyShell({ id: 'peer-shell', folder: demoFolder }),
        ],
        'active-content'
      )
    );
    const id = h.actions.createSession({ activate: true });
    // 草稿契约：不复用 peer，始终 mint
    expect(id).not.toBe('peer-shell');
    expect(id).not.toBe('active-content');
    const st = h.getState();
    expect(st.activeSessionId).toBe(id);
    expect(st.sessionsById['peer-shell']).toBeDefined();
    expect(st.sessionsById['active-content']).toBeDefined();
  });

  // ── Phase 2 draft 契约（enter → 连点 → commit → setActive）────────────
  it('enterDraftMode: sessions length unchanged; active is pending sentinel', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'hist',
            title: '历史',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'x' })],
          }),
        ],
        'hist'
      )
    );
    const beforeLen = h.getState().sessions.length;
    h.actions.enterDraftMode('proj-a');
    const st = h.getState();
    expect(st.activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);
    expect(st.activeSessionId).toBe('__pending_draft__');
    expect(isPendingDraft(st.activeSessionId)).toBe(true);
    expect(st.draftFolder).toBe('proj-a');
    expect(st.sessions).toHaveLength(beforeLen);
    expect(st.sessions).toHaveLength(1);
    expect(st.sessionsById.hist).toBeDefined();
    expect(st.sessionsById[PENDING_DRAFT_SESSION_ID]).toBeUndefined();
    expect(st.activeAgentId).toBeNull();
    expect(st.panelAgentId).toBeNull();
  });

  it('enterDraftMode x3: sessions still unchanged (no mint on multi-click)', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'hist',
            title: '历史',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'x' })],
          }),
        ],
        'hist'
      )
    );
    const beforeIds = h.getState().sessions.map((s) => s.id);
    h.actions.enterDraftMode('f-a');
    h.actions.enterDraftMode('f-b');
    h.actions.enterDraftMode('f-c');
    const st = h.getState();
    expect(st.sessions).toHaveLength(beforeIds.length);
    expect(st.sessions.map((s) => s.id)).toEqual(beforeIds);
    expect(st.activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);
    // 最后一次 enter 的 folder 生效
    expect(st.draftFolder).toBe('f-c');
    expect(st.sessionsById[PENDING_DRAFT_SESSION_ID]).toBeUndefined();
  });

  it('commitDraftIfNeeded: sessions+1; active real id; draftFolder cleared', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'real',
            title: '真会话',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
        ],
        'real'
      )
    );
    // 非草稿：返回当前真实 active，sessions 不变
    expect(h.actions.commitDraftIfNeeded()).toBe('real');
    expect(h.getState().sessions).toHaveLength(1);

    h.actions.enterDraftMode('proj-commit');
    expect(h.getState().sessions).toHaveLength(1);
    expect(h.getState().activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);

    const id = h.actions.commitDraftIfNeeded({ title: '首条标题' });
    expect(id).toBeTruthy();
    expect(isPendingDraft(id)).toBe(false);
    expect(id).not.toBe(PENDING_DRAFT_SESSION_ID);
    const st = h.getState();
    expect(st.activeSessionId).toBe(id);
    expect(isPendingDraft(st.activeSessionId)).toBe(false);
    expect(st.draftFolder).toBe('');
    expect(st.sessionsById[id]?.title).toBe('首条标题');
    // 历史 + 新 mint
    expect(st.sessions).toHaveLength(2);
    expect(st.sessions.map((s) => s.id).sort()).toEqual(['real', id].sort());
  });

  it('commitDraftIfNeeded uses draftFolder as sess.folder', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'hist',
            title: '历史',
            folder: 'other-folder',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'x' })],
          }),
        ],
        'hist'
      )
    );
    const enterFolder = 'proj-from-enter';
    h.actions.enterDraftMode(enterFolder);
    expect(h.getState().draftFolder).toBe(enterFolder);

    const id = h.actions.commitDraftIfNeeded({ title: '绑定 folder' });
    const sess = h.getState().sessionsById[id];
    expect(sess).toBeDefined();
    // 契约：folder 取 enter 时的 draftFolder，非活动历史会话 folder
    expect(sess!.folder).toBe(enterFolder);
    expect(sess!.folder).not.toBe('other-folder');
    expect(h.getState().draftFolder).toBe('');
  });

  it('setActive to real session clears draftFolder', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 'a' })], 'a')
    );
    h.actions.enterDraftMode('f1');
    expect(h.getState().activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);
    expect(h.getState().draftFolder).toBe('f1');

    h.actions.setActiveSessionId('a');
    const st = h.getState();
    expect(st.activeSessionId).toBe('a');
    expect(st.draftFolder).toBe('');
  });

  it('setActiveSessionId(pending) is allowed even when not in sessions list', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 'a' })], 'a', 'pre-existing')
    );
    // 直接 setActive 到哨兵：不得因「不在 sessions 列表」而拒绝
    h.actions.setActiveSessionId(PENDING_DRAFT_SESSION_ID);
    const st = h.getState();
    expect(st.activeSessionId).toBe(PENDING_DRAFT_SESSION_ID);
    expect(isPendingDraft(st.activeSessionId)).toBe(true);
    // 仍在草稿态时不强制清 draftFolder（仅切到真实/空才清）
    expect(st.draftFolder).toBe('pre-existing');
    expect(st.sessions).toHaveLength(1);
    expect(st.sessionsById[PENDING_DRAFT_SESSION_ID]).toBeUndefined();
  });

  it('setDraftFolder / clearDraft manage draft binding', () => {
    const h = makeHarnessFromState(makeStateFromSessions([], ''));
    h.actions.enterDraftMode('folder-1');
    h.actions.setDraftFolder('folder-2');
    expect(h.getState().draftFolder).toBe('folder-2');
    h.actions.clearDraft();
    const st = h.getState();
    expect(st.draftFolder).toBe('');
    expect(st.activeSessionId).toBe('');
  });

  it('setActiveSessionId switches terminal view without dropping peer shells', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'a' }),
          emptyShell({ id: 'b' }),
          emptyShell({ id: 'ghost' }),
        ],
        'a'
      )
    );
    const st0 = h.getState();
    st0.terminalBySession = {
      a: ['keep-a'],
      b: ['keep-b'],
      ghost: ['keep-ghost'],
    };
    h.actions.setActiveSessionId('b');
    const st = h.getState();
    // 会话与各会话 terminal 缓冲均保留；仅当前 terminalLines 切到 b
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['a', 'b', 'ghost'].sort()
    );
    expect(st.terminalBySession.ghost).toEqual(['keep-ghost']);
    expect(st.terminalBySession.a).toEqual(['keep-a']);
    expect(st.terminalBySession.b).toEqual(['keep-b']);
    expect(st.terminalLines).toEqual(['keep-b']);
  });

  it('branchSession prunes non-active empty shells', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'src',
            title: '原会话',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
          emptyShell({ id: 'ghost' }),
        ],
        'src'
      )
    );
    h.actions.branchSession('src', '分叉标题');
    const st = h.getState();
    expect(st.activeSessionId).not.toBe('src');
    expect(st.sessionsById.ghost).toBeUndefined();
    expect(st.sessionsById.src).toBeDefined();
    expect(st.sessionsById[st.activeSessionId]?.branchParentId).toBe('src');
    expect(st.sessionsById[st.activeSessionId]?.title).toBe('分叉标题');
  });
});

describe('sessionActions delete / active safety / Chinese titles', () => {
  it('deleteSession removes target, reassigns active, prunes peer shells', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'keep-content',
            title: '真实对话',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
          emptyShell({ id: 'victim' }),
          emptyShell({ id: 'ghost' }),
        ],
        'victim'
      )
    );
    h.getState().terminalBySession = {
      victim: ['line'],
      'keep-content': ['ok'],
    };
    // harness 上直接改 initial 后需再走 actions 读最新；此处 mutate 返回对象
    const st0 = h.getState();
    st0.terminalBySession = { victim: ['line'], 'keep-content': ['ok'] };

    const ok = h.actions.deleteSession('victim');
    expect(ok).toBe(true);
    const st = h.getState();
    expect(st.sessionsById.victim).toBeUndefined();
    expect(st.sessionsById.ghost).toBeUndefined(); // 空壳 prune
    expect(st.sessionsById['keep-content']).toBeDefined();
    expect(st.activeSessionId).toBe('keep-content');
    expect(st.terminalBySession.victim).toBeUndefined();
    expect(st.terminalLines).toEqual(['ok']);
  });

  it('deleteSession empty / missing is a guarded no-op', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 'only' })], 'only')
    );
    expect(h.actions.deleteSession('')).toBe(false);
    expect(h.actions.deleteSession('nope')).toBe(false);
    expect(h.getState().activeSessionId).toBe('only');
    expect(h.getState().sessions).toHaveLength(1);
  });

  it('setActiveSessionId ignores unknown id (no ghost active)', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 'a' })], 'a')
    );
    h.actions.setActiveSessionId('missing-id');
    expect(h.getState().activeSessionId).toBe('a');
  });

  it('archiveSession of active switches to neighbor non-archived', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'a',
            title: 'A',
            messages: [makeMessage({ id: 'm1', sender: 'user', text: 'a' })],
          }),
          emptyShell({
            id: 'b',
            title: 'B',
            messages: [makeMessage({ id: 'm2', sender: 'user', text: 'b' })],
          }),
        ],
        'a'
      )
    );
    h.actions.archiveSession('a');
    const st = h.getState();
    expect(getSessionOrThrow(st, 'a').isArchived).toBe(true);
    expect(st.activeSessionId).toBe('b');
  });

  it('renameSession sanitizes CJK and strips control / slash noise', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 's1', title: '新会话' })], 's1')
    );
    h.actions.renameSession('s1', '  /cmd  \u200B帮我重构模块。  ');
    expect(getSessionOrThrow(h.getState(), 's1').title).toBe('帮我重构模块');

    // 空清洗结果不覆盖
    h.actions.renameSession('s1', '  /help  ');
    expect(getSessionOrThrow(h.getState(), 's1').title).toBe('帮我重构模块');

    // 码点截断（48）不劈半
    const longZh = '中'.repeat(60);
    h.actions.renameSession('s1', longZh);
    const titled = getSessionOrThrow(h.getState(), 's1').title;
    expect(Array.from(titled).length).toBe(49); // 48 + …
    expect(titled.endsWith('…')).toBe(true);
  });

  it('createSession uses EMPTY_SESSION_TITLE and sanitizes opts.title', () => {
    const h = makeHarnessFromState(makeStateFromSessions([], ''));
    const id = h.actions.createSession({
      title: '  ## 修复登录崩溃！ ',
      folder: '常规会话',
      activate: true,
    });
    expect(getSessionOrThrow(h.getState(), id).title).toBe('修复登录崩溃');

    const id2 = h.actions.createSession({
      id: 'plain-new',
      activate: false,
    });
    // 未给 title → 清晰「新会话」
    expect(getSessionOrThrow(h.getState(), id2).title).toBe('新会话');
  });

  it('addMessage auto-titles default shell from first Chinese user text', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 's1', title: '新会话' })], 's1')
    );
    h.actions.addMessage(
      'ws',
      's1',
      makeMessage({
        id: 'm1',
        sender: 'user',
        text: '帮我写一个排序函数',
      })
    );
    expect(getSessionOrThrow(h.getState(), 's1').title).toContain('帮我写');

    // 用户手改后不再覆盖
    h.actions.renameSession('s1', '我的标题');
    h.actions.addMessage(
      'ws',
      's1',
      makeMessage({
        id: 'm2',
        sender: 'user',
        text: '另一句',
      })
    );
    expect(getSessionOrThrow(h.getState(), 's1').title).toBe('我的标题');
  });

  it('branchSession sanitizes title and clears agent focus', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'src',
            title: '原会话',
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
        ],
        'src'
      )
    );
    // 模拟侧栏 agent 焦点
    const st0 = h.getState();
    st0.panelAgentId = 'ag1';
    st0.activeAgentId = null;

    h.actions.branchSession('src', '  分叉标题。 ');
    const st = h.getState();
    expect(st.activeSessionId).not.toBe('src');
    expect(getSessionOrThrow(st, st.activeSessionId).title).toBe('分叉标题');
    expect(st.panelAgentId).toBeNull();
    expect(getSessionOrThrow(st, st.activeSessionId).branchParentId).toBe('src');
  });
});
