import { produce } from 'immer';
import { describe, expect, it, vi } from 'vitest';
import { GENERAL_FOLDER } from '../api/projectStore';
import * as sessionTitleApi from '../api/sessionTitle';
import {
  createSessionActions,
  type SessionStoreSlice,
} from './sessionActions';
import { buildSessionsById } from './sessionIndex';
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

function makeMessage(partial: Partial<SessionMessage> & Pick<SessionMessage, 'id'>): SessionMessage {
  return {
    sender: 'assistant',
    timestamp: 1,
    ...partial,
  };
}

function emptyShell(
  partial: Partial<SessionState> & { id: string },
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
): SessionStoreSlice {
  return {
    sessions,
    sessionsById: buildSessionsById(sessions),
    folderOrder: Array.from(new Set(sessions.map((s) => s.folder))),
    activeSessionId,
    activeAgentId: null,
    panelAgentId: null,
    permissionMode: 'ask',
    planModeEnabled: false,
    planApproved: false,
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
    message: () => state.sessionsById.s1.messages[0],
  };
}

describe('sessionActions message no-op short-circuit', () => {
  it('updateMessageText same string does not replace state tree', () => {
    const h = makeHarness([
      makeMessage({ id: 'm1', text: 'hello', blocks: [{ type: 'text', content: 'hello' }] }),
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
            messages: [makeMessage({ id: 'm', sender: 'user', text: '有正文' })],
          }),
        ],
        'active',
      ),
    );
    h.actions.setSessions(h.getState().sessions);
    const ids = h.getState().sessions.map((s) => s.id);
    expect(ids).toContain('active');
    expect(ids).toContain('sched');
    expect(ids).toContain('content');
    expect(ids).not.toContain('ghost');
    // 有消息的默认标题被推导
    expect(h.getState().sessionsById.content.title).toContain('有正文');
  });

  it('createSession activate:false keeps current active shell and scheduled title', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 'active-shell' }), emptyShell({ id: 'other-ghost' })],
        'active-shell',
      ),
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
      ['active-shell', 'other-ghost', 'wf-sched-1'].sort(),
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
        'old-active',
      ),
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
        [emptyShell({ id: 'sched', title: '定时 · 任务', folder: GENERAL_FOLDER })],
        'sched',
      ),
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
        'a',
      ),
    );
    h.actions.setActiveSessionId('b');
    const st = h.getState();
    expect(st.activeSessionId).toBe('b');
    // 切换只改焦点，空「新会话」仍保留（用户可再点回来）
    expect(st.sessions.map((s) => s.id).sort()).toEqual(['a', 'b', 'sched'].sort());
  });

  it('createSession activate:true reuses active empty shell and prunes peers', () => {
    // demo 模式 createSession 固定 folder=常规会话；壳必须同 folder 才可复用
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
        'active-shell',
      ),
    );
    // 无 explicit id：应复用当前活动空壳，而非再 mint 新 id
    const id = h.actions.createSession({ activate: true });
    expect(id).toBe('active-shell');
    const st = h.getState();
    expect(st.activeSessionId).toBe('active-shell');
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['active-shell', 'content'].sort(),
    );
    expect(st.sessionsById['peer-ghost']).toBeUndefined();
  });

  it('createSession activate:false without id never reuses empty shell', () => {
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 'active-shell', folder: demoFolder })],
        'active-shell',
      ),
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
        'a',
      ),
    );
    h.actions.setActiveSessionId('b');
    const st = h.getState();
    // 切换不 prune：空壳 a 与 pinned 都保留
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['a', 'b', 'pinned-ghost'].sort(),
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
        'old',
      ),
    );
    const id = h.actions.createSession({
      id: 'target',
      activate: true,
    });
    expect(id).toBe('target');
    const st = h.getState();
    expect(st.activeSessionId).toBe('target');
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['sched', 'target'].sort(),
    );
  });

  it('createSession aborts stale reuse when shell is no longer empty (race)', () => {
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({
            id: 'was-shell',
            folder: demoFolder,
            // 已有正文：find 若仍返回该 id（竞态脏读），draft 内须拒绝复用
            messages: [makeMessage({ id: 'm', sender: 'user', text: 'hi' })],
          }),
        ],
        'was-shell',
      ),
    );
    const spy = vi
      .spyOn(sessionTitleApi, 'findReusableEmptyShell')
      .mockReturnValue('was-shell');
    const id = h.actions.createSession({ activate: true });
    spy.mockRestore();
    // 不得吞掉已有正文的会话
    expect(id).not.toBe('was-shell');
    const st = h.getState();
    expect(st.sessionsById['was-shell']).toBeDefined();
    expect(st.sessionsById['was-shell'].messages).toHaveLength(1);
    expect(st.activeSessionId).toBe(id);
    expect(st.sessionsById[id]).toBeDefined();
  });

  it('createSession aborts stale reuse when shell folder no longer matches', () => {
    const demoFolder = '常规会话';
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 'other-proj', folder: 'project-x' })],
        '',
      ),
    );
    const spy = vi
      .spyOn(sessionTitleApi, 'findReusableEmptyShell')
      .mockReturnValue('other-proj');
    const id = h.actions.createSession({
      activate: true,
      // demo 模式 find/复检 folder 固定为 常规会话
    });
    spy.mockRestore();
    // 拒绝跨 folder 脏复用；mint 新 id 并激活
    expect(id).not.toBe('other-proj');
    expect(h.getState().activeSessionId).toBe(id);
    // mint 的新壳在 demo 下归 常规会话
    expect(h.getState().sessionsById[id]?.folder).toBe(demoFolder);
    // mint 不跨剪其它 folder 空壳
    expect(h.getState().sessionsById['other-proj']).toBeDefined();
  });

  it('createSession activate:true reuses peer empty shell when active has content', () => {
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
        'active-content',
      ),
    );
    const id = h.actions.createSession({ activate: true });
    expect(id).toBe('peer-shell');
    const st = h.getState();
    expect(st.activeSessionId).toBe('peer-shell');
    expect(st.sessions.map((s) => s.id).sort()).toEqual(
      ['active-content', 'peer-shell'].sort(),
    );
  });

  it('setActiveSessionId switches terminal view without dropping peer shells', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          emptyShell({ id: 'a' }),
          emptyShell({ id: 'b' }),
          emptyShell({ id: 'ghost' }),
        ],
        'a',
      ),
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
    expect(st.sessions.map((s) => s.id).sort()).toEqual(['a', 'b', 'ghost'].sort());
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
        'src',
      ),
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
        'victim',
      ),
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
      makeStateFromSessions([emptyShell({ id: 'only' })], 'only'),
    );
    expect(h.actions.deleteSession('')).toBe(false);
    expect(h.actions.deleteSession('nope')).toBe(false);
    expect(h.getState().activeSessionId).toBe('only');
    expect(h.getState().sessions).toHaveLength(1);
  });

  it('setActiveSessionId ignores unknown id (no ghost active)', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([emptyShell({ id: 'a' })], 'a'),
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
        'a',
      ),
    );
    h.actions.archiveSession('a');
    const st = h.getState();
    expect(st.sessionsById.a.isArchived).toBe(true);
    expect(st.activeSessionId).toBe('b');
  });

  it('renameSession sanitizes CJK and strips control / slash noise', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 's1', title: '新会话' })],
        's1',
      ),
    );
    h.actions.renameSession('s1', '  /cmd  \u200B帮我重构模块。  ');
    expect(h.getState().sessionsById.s1.title).toBe('帮我重构模块');

    // 空清洗结果不覆盖
    h.actions.renameSession('s1', '  /help  ');
    expect(h.getState().sessionsById.s1.title).toBe('帮我重构模块');

    // 码点截断（48）不劈半
    const longZh = '中'.repeat(60);
    h.actions.renameSession('s1', longZh);
    const titled = h.getState().sessionsById.s1.title;
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
    expect(h.getState().sessionsById[id].title).toBe('修复登录崩溃');

    const id2 = h.actions.createSession({
      id: 'plain-new',
      activate: false,
    });
    // 未给 title → 清晰「新会话」
    expect(h.getState().sessionsById[id2].title).toBe('新会话');
  });

  it('addMessage auto-titles default shell from first Chinese user text', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [emptyShell({ id: 's1', title: '新会话' })],
        's1',
      ),
    );
    h.actions.addMessage('ws', 's1', makeMessage({
      id: 'm1',
      sender: 'user',
      text: '帮我写一个排序函数',
    }));
    expect(h.getState().sessionsById.s1.title).toContain('帮我写');

    // 用户手改后不再覆盖
    h.actions.renameSession('s1', '我的标题');
    h.actions.addMessage('ws', 's1', makeMessage({
      id: 'm2',
      sender: 'user',
      text: '另一句',
    }));
    expect(h.getState().sessionsById.s1.title).toBe('我的标题');
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
        'src',
      ),
    );
    // 模拟侧栏 agent 焦点
    const st0 = h.getState();
    st0.panelAgentId = 'ag1';
    st0.activeAgentId = null;

    h.actions.branchSession('src', '  分叉标题。 ');
    const st = h.getState();
    expect(st.activeSessionId).not.toBe('src');
    expect(st.sessionsById[st.activeSessionId].title).toBe('分叉标题');
    expect(st.panelAgentId).toBeNull();
    expect(st.sessionsById[st.activeSessionId].branchParentId).toBe('src');
  });
});
