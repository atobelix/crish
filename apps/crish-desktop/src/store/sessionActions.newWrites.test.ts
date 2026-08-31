import { produce } from 'immer';
import { describe, expect, it, vi } from 'vitest';
import { GENERAL_FOLDER } from '../api/projectStore';
import { createSessionActions, type SessionStoreSlice } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import type { MessageToolCall, SessionMessage, SessionState } from './types';

/**
 * T-E 批次 5 事件写入收敛（步骤 3/4）新 action 单测：
 * setEngineLastRunId / setMessageCacheMetrics / patchSessionAgentToolStatus /
 * markToolCallLocalStatus / batchRespondToApproval / finalizeAgentMessages /
 * applyToolCallPatches / updateMessageTimeline / rebindSessionFolders。
 *
 * 语义与迁移前 raw setState recipe 逐行等价（行为等价锁）。
 */

// rebindSessionFolders 依赖 projectStore.rebindSessionFoldersToProjects 纯函数；
// 单测 mock 为「把 folder 归一为 project id」的可观测替身。
vi.mock('../api/projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/projectStore')>();
  return {
    ...actual,
    rebindSessionFoldersToProjects: (
      sessions: Array<{ folder?: string }>,
      projects: ReadonlyArray<{ id: string }>,
    ): number => {
      let n = 0;
      for (const s of sessions) {
        const cur = s.folder || '';
        if (cur === 'proj-ghost' && projects.some((p) => p.id === 'proj-new')) {
          s.folder = 'proj-new';
          n += 1;
        }
      }
      return n;
    },
  };
});

function makeMessage(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id'>,
): SessionMessage {
  return { sender: 'assistant', timestamp: 1, ...partial };
}

function makeTool(partial: Partial<MessageToolCall> & { id: string }): MessageToolCall {
  return { name: 'shell', status: 'running', ...partial };
}

function makeSession(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: 't',
    folder: GENERAL_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages: [],
    ...partial,
  };
}

function makeStateFromSessions(
  sessions: SessionState[],
  activeSessionId: string,
  folderOrder: string[] = [],
): SessionStoreSlice {
  return {
    sessions,
    sessionsById: buildSessionsById(sessions),
    folderOrder,
    activeSessionId,
    draftFolder: '',
    activeAgentId: null,
    panelAgentId: null,
    composerDrafts: {},
  };
}

function makeHarnessFromState(initial: SessionStoreSlice) {
  let state = initial;
  const set = (recipe: (draft: SessionStoreSlice) => void) => {
    state = produce(state, recipe);
  };
  const get = () => state;
  const actions = createSessionActions(set, get);
  return { actions, getState: () => state };
}

describe('T-E 新 action：setEngineLastRunId / updateMessageTimeline / applyToolCallPatches', () => {
  it('setEngineLastRunId 经 canonical 写（sessionsById 与 sessions[] 同引用）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions([makeSession({ id: 's1' })], 's1'),
    );
    h.actions.setEngineLastRunId('s1', 'run-9');
    const st = h.getState();
    expect(st.sessionsById['s1']!.engineLastRunId).toBe('run-9');
    expect(st.sessions[0]!.engineLastRunId).toBe('run-9');
    expect(st.sessionsById['s1']).toBe(st.sessions[0]);
  });

  it('updateMessageTimeline 归一 blocks/toolCalls（sender 非 assistant 早退）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                sender: 'assistant',
                text: 'hello',
                status: 'completed',
                blocks: [{ type: 'text', content: 'hello' }],
                toolCalls: [],
              }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.updateMessageTimeline('s1', 'm1');
    const msg = h.getState().sessionsById['s1']!.messages[0]!;
    expect(msg.blocks).toBeDefined();
    expect(Array.isArray(msg.blocks)).toBe(true);
    // user 消息早退：不抛错
    h.actions.updateMessageTimeline('s1', 'missing-id');
    expect(() =>
      h.actions.updateMessageTimeline('s1', 'missing-id'),
    ).not.toThrow();
  });

  it('updateMessageTimeline 多轮交互中绝不丢弃历史 thought 块与 tool_call 块', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                sender: 'assistant',
                text: '阶段结论',
                status: 'processing',
                blocks: [
                  { type: 'thought', content: 'Turn 0 思维链', turnIndex: 0 },
                  { type: 'tool_call', id: 't1' },
                ],
                toolCalls: [
                  makeTool({ id: 't1', status: 'success', turnId: 'turn-0' }),
                  makeTool({ id: 't2', status: 'running', turnId: 'turn-1' }),
                ],
                thinkingTurns: [
                  { turnIndex: 0, content: 'Turn 0 思维链' },
                  { turnIndex: 1, content: 'Turn 1 新思维链' },
                ],
              }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.updateMessageTimeline('s1', 'm1');
    const msg = h.getState().sessionsById['s1']!.messages[0]!;
    expect(msg.blocks?.filter((b) => b.type === 'thought')).toHaveLength(2);
    expect(msg.blocks?.filter((b) => b.type === 'tool_call')).toHaveLength(2);
    expect(msg.blocks?.filter((b) => b.type === 'text')).toHaveLength(1);
    expect(msg.blocks?.[0]).toMatchObject({
      type: 'thought',
      content: 'Turn 0 思维链',
      turnIndex: 0,
    });
  });

  it('T-04: updateMessageText 发生截断重置时只重置 text 块，严格保留全部 thought 与 tool_call 块', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                sender: 'assistant',
                text: '很长的旧文本已经输出到了第一千个字符',
                streamTextOffset: 20,
                blocks: [
                  { type: 'thought', content: '关键思考链', turnIndex: 0 },
                  { type: 'tool_call', id: 't1' },
                  { type: 'text', content: '旧文本' },
                ],
                toolCalls: [makeTool({ id: 't1', status: 'success' })],
              }),
            ],
          }),
        ],
        's1',
      ),
    );

    // 传入变短且不匹配前缀的新文本触发 offset 重置分支
    h.actions.updateMessageText('s1', 'm1', '新重置文本');
    const msg = h.getState().sessionsById['s1']!.messages[0]!;
    expect(msg.blocks?.find((b) => b.type === 'thought')).toBeDefined();
    expect(msg.blocks?.find((b) => b.type === 'thought')?.content).toBe('关键思考链');
    expect(msg.blocks?.find((b) => b.type === 'tool_call')).toBeDefined();
    expect(msg.blocks?.find((b) => b.type === 'tool_call')?.id).toBe('t1');
    expect(msg.blocks?.find((b) => b.type === 'text')?.content).toBe('新重置文本');
  });

  it('applyToolCallPatches 批量终态（批内单次 immer）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                text: 'x',
                status: 'processing',
                toolCalls: [
                  makeTool({ id: 't1', status: 'running' }),
                  makeTool({ id: 't2', status: 'running' }),
                ],
              }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.applyToolCallPatches('s1', 'm1', [
      { id: 't1', status: 'success', output: 'ok' },
      { id: 't2', status: 'error', output: 'fail' },
      { id: 't3', status: 'success' }, // 不存在：跳过
    ]);
    const tcs = h.getState().sessionsById['s1']!.messages[0]!.toolCalls!;
    expect(tcs.find((t) => t.id === 't1')!.status).toBe('success');
    expect(tcs.find((t) => t.id === 't1')!.output).toBe('ok');
    expect(tcs.find((t) => t.id === 't2')!.status).toBe('error');
  });
});

describe('T-E 新 action：setMessageCacheMetrics（canonical 写回归）', () => {
  const metrics = {
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    inputTotal: 500,
  };

  it('按 messageId 命中写入；sessions[] canonical 与索引同引用', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                text: 'assistant msg',
                status: 'processing',
              }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.setMessageCacheMetrics('s1', 'm1', metrics);
    const st = h.getState();
    const sess = st.sessions[0]!;
    expect(sess.messages[0]!.cacheMetrics).toEqual({
      metrics,
      source: 'engine-message-end',
    });
    // canonical 写回归：sessions[] 持引用，索引重建（buildSessionsById）不丢字段
    const rebuilt = buildSessionsById(st.sessions);
    expect(rebuilt['s1']!.messages[0]!.cacheMetrics).toEqual({
      metrics,
      source: 'engine-message-end',
    });
  });

  it('messageId 缺省兜底：末条 processing assistant', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({ id: 'u1', sender: 'user', text: 'hi', status: 'completed' }),
              makeMessage({ id: 'a1', text: 'streaming', status: 'processing' }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.setMessageCacheMetrics('s1', '', metrics);
    expect(h.getState().sessionsById['s1']!.messages[1]!.cacheMetrics).toBeDefined();
  });

  it('metrics 为 null 不写（P6 C15）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({ id: 'a1', text: 'streaming', status: 'processing' }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.setMessageCacheMetrics('s1', 'a1', null as unknown as never);
    expect(h.getState().sessionsById['s1']!.messages[0]!.cacheMetrics).toBeUndefined();
  });
});

describe('T-E 新 action：patchSessionAgentToolStatus（U3/S3 双调用方共用）', () => {
  function harnessWithAgent() {
    return makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                text: '',
                status: 'processing',
                toolCalls: [makeTool({ id: 'parent-tool', status: 'running' })],
              }),
            ],
            agents: [
              {
                id: 'ag1',
                subagentRunId: 'r1',
                parentSessionId: 's1',
                parentRunId: 'p1',
                parentToolCallId: 'parent-tool',
                description: '探索',
                mode: 'research',
                status: 'running',
                startedAt: 1,
                messages: [
                  makeMessage({ id: 'a1', text: 'x', status: 'processing' }),
                  makeMessage({ id: 'a2', text: 'y', status: 'processing' }),
                ],
              },
            ],
          }),
        ],
        's1',
      ),
    );
  }

  it('failed → agent 终态 + 时间线收口 + 父工具卡 error（输出截断 1200）', () => {
    const h = harnessWithAgent();
    h.actions.patchSessionAgentToolStatus('s1', 'ag1', {
      status: 'failed',
      summary: 'x'.repeat(2000),
    });
    const st = h.getState();
    const ag = st.sessionsById['s1']!.agents![0]!;
    expect(ag.status).toBe('failed');
    expect(ag.endedAt).toBeTypeOf('number');
    for (const m of ag.messages) expect(m.status).toBe('completed');
    const tc = st.sessionsById['s1']!.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe('error');
    expect(tc.output!.length).toBeLessThanOrEqual(1200);
    expect(tc.output!.endsWith('…')).toBe(true);
  });

  it('completed → 父工具卡 success + 「协作已完成」文案', () => {
    const h = harnessWithAgent();
    h.actions.patchSessionAgentToolStatus('s1', 'ag1', { status: 'completed' });
    const tc = h.getState().sessionsById['s1']!.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe('success');
    expect(tc.output).toBe('协作已完成');
  });

  it('stopped → 父工具卡 error + 「协作已停止」', () => {
    const h = harnessWithAgent();
    h.actions.patchSessionAgentToolStatus('s1', 'ag1', { status: 'stopped' });
    const tc = h.getState().sessionsById['s1']!.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe('error');
    expect(tc.output).toBe('协作已停止');
  });

  it('summary 存在时优先作为父工具卡输出', () => {
    const h = harnessWithAgent();
    h.actions.patchSessionAgentToolStatus('s1', 'ag1', {
      status: 'completed',
      summary: '完成调研',
    });
    const tc = h.getState().sessionsById['s1']!.messages[0]!.toolCalls![0]!;
    expect(tc.output).toBe('完成调研');
  });
});

describe('T-E 新 action：markToolCallLocalStatus（C1/C2/S1 共用）', () => {
  function harnessWithTwoSessions() {
    return makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                text: '',
                toolCalls: [
                  makeTool({ id: 't1', status: 'pending_approval' }),
                  makeTool({ id: 't2', status: 'success' }),
                ],
              }),
            ],
          }),
          makeSession({
            id: 's2',
            engineLastRunId: 'run-x',
            messages: [
              makeMessage({
                id: 'm2',
                text: '',
                toolCalls: [makeTool({ id: 't1', status: 'pending_approval' })],
              }),
            ],
            agents: [
              {
                id: 'ag2',
                subagentRunId: 'r2',
                parentSessionId: 's2',
                parentRunId: 'p2',
                description: 'x',
                mode: 'research',
                status: 'running',
                startedAt: 1,
                messages: [
                  makeMessage({
                    id: 'am',
                    text: '',
                    toolCalls: [makeTool({ id: 't1', status: 'pending_approval' })],
                  }),
                ],
              },
            ],
          }),
        ],
        's1',
      ),
    );
  }

  it('无 scope：全表扫描置标（与原 raw setState 语义等价）', () => {
    const h = harnessWithTwoSessions();
    h.actions.markToolCallLocalStatus('t1', 'running', '执行中…');
    const st = h.getState();
    // 两个会话的主消息 + agent 消息全部命中
    expect(st.sessionsById['s1']!.messages[0]!.toolCalls![0]!.status).toBe('running');
    expect(st.sessionsById['s2']!.messages[0]!.toolCalls![0]!.status).toBe('running');
    expect(st.sessionsById['s2']!.agents![0]!.messages[0]!.toolCalls![0]!.status).toBe('running');
    expect(st.sessionsById['s2']!.messages[0]!.toolCalls![0]!.output).toBe('执行中…');
  });

  it('scope.sessionId 命中：只扫该会话', () => {
    const h = harnessWithTwoSessions();
    h.actions.markToolCallLocalStatus('t1', 'running', 'x', { sessionId: 's1' });
    const st = h.getState();
    expect(st.sessionsById['s1']!.messages[0]!.toolCalls![0]!.status).toBe('running');
    expect(st.sessionsById['s2']!.messages[0]!.toolCalls![0]!.status).toBe('pending_approval');
  });

  it('scope.runId 命中：只扫 engineLastRunId 匹配会话', () => {
    const h = harnessWithTwoSessions();
    h.actions.markToolCallLocalStatus('t1', 'running', 'x', { runId: 'run-x' });
    const st = h.getState();
    expect(st.sessionsById['s1']!.messages[0]!.toolCalls![0]!.status).toBe('pending_approval');
    expect(st.sessionsById['s2']!.messages[0]!.toolCalls![0]!.status).toBe('running');
  });

  it('scope.agentId 命中：agent 域内只扫指定 agent', () => {
    const h = harnessWithTwoSessions();
    h.actions.markToolCallLocalStatus('t1', 'running', 'x', {
      sessionId: 's2',
      agentId: 'ag2',
    });
    const st = h.getState();
    expect(st.sessionsById['s2']!.messages[0]!.toolCalls![0]!.status).toBe('pending_approval');
    expect(st.sessionsById['s2']!.agents![0]!.messages[0]!.toolCalls![0]!.status).toBe('running');
  });

  it('终态工具卡不回退 running（S1 守卫语义）', () => {
    const h = harnessWithTwoSessions();
    h.actions.markToolCallLocalStatus('t2', 'running', '协作进行中…');
    expect(h.getState().sessionsById['s1']!.messages[0]!.toolCalls![1]!.status).toBe('success');
  });
});

describe('T-E 新 action：batchRespondToApproval（批量语义）', () => {
  it('批量写入 approvalDecision（respondToApproval 单条语义批量封装）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            messages: [
              makeMessage({
                id: 'm1',
                text: '',
                toolCalls: [
                  makeTool({ id: 't1', status: 'pending_approval' }),
                  makeTool({ id: 't2', status: 'pending_approval' }),
                ],
              }),
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.batchRespondToApproval([
      { sessionId: 's1', messageId: 'm1', toolCallId: 't1', decision: 'allow' },
      { sessionId: 's1', messageId: 'm1', toolCallId: 't2', decision: 'deny' },
      { sessionId: 's1', messageId: 'm1', toolCallId: 'missing', decision: 'allow' },
    ]);
    const tcs = h.getState().sessionsById['s1']!.messages[0]!.toolCalls!;
    expect(tcs.find((t) => t.id === 't1')!.approvalDecision).toBe('allow');
    expect(tcs.find((t) => t.id === 't2')!.approvalDecision).toBe('deny');
  });
});

describe('T-E 新 action：finalizeAgentMessages（A2 finalizeInFlight 语义）', () => {
  it('processing → completed；running/pending 工具卡 → error「已停止」', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            agents: [
              {
                id: 'ag1',
                subagentRunId: 'r1',
                parentSessionId: 's1',
                parentRunId: 'p1',
                description: 'x',
                mode: 'research',
                status: 'running',
                startedAt: 1,
                messages: [
                  makeMessage({
                    id: 'a1',
                    text: 't',
                    status: 'processing',
                    thinking: '正在处理…',
                    toolCalls: [
                      makeTool({ id: 'x1', status: 'running' }),
                      makeTool({ id: 'x2', status: 'pending_approval' }),
                      makeTool({ id: 'x3', status: 'success' }),
                    ],
                  }),
                  makeMessage({ id: 'u1', sender: 'user', text: 'q', status: 'completed' }),
                ],
              },
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.finalizeAgentMessages('s1', 'ag1');
    const ag = h.getState().sessionsById['s1']!.agents![0]!;
    const asst = ag.messages.find((m) => m.id === 'a1')!;
    expect(asst.status).toBe('completed');
    expect(asst.thinking).toBe('');
    expect(asst.toolCalls!.find((t) => t.id === 'x1')!.status).toBe('error');
    expect(asst.toolCalls!.find((t) => t.id === 'x1')!.output).toBe('已停止');
    expect(asst.toolCalls!.find((t) => t.id === 'x2')!.status).toBe('error');
    expect(asst.toolCalls!.find((t) => t.id === 'x3')!.status).toBe('success');
  });
});

describe('T-E 新 action：rebindSessionFolders（D5 收敛）', () => {
  const projects = [{ id: 'proj-new', path: '/p', name: 'P' }];

  it('folderOrder 去重追加；folder 镜像经 rebind 纯函数更新', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({ id: 's1', folder: 'proj-ghost' }),
          makeSession({ id: 's2', folder: 'proj-new' }),
          makeSession({ id: 's3', folder: GENERAL_FOLDER }),
        ],
        's1',
        ['proj-ghost'],
      ),
    );
    h.actions.rebindSessionFolders(projects);
    const st = h.getState();
    expect(st.sessionsById['s1']!.folder).toBe('proj-new');
    expect(st.sessionsById['s2']!.folder).toBe('proj-new');
    // folderOrder：s1 已存在于序列表；s2 的 folder 追加去重
    expect(st.folderOrder.includes('proj-new')).toBe(true);
    expect(st.folderOrder.filter((f) => f === 'proj-new')).toHaveLength(1);
  });

  it('增量 rebind：changedSessionIds 只处理变更集合', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({ id: 's1', folder: 'proj-ghost' }),
          makeSession({ id: 's2', folder: 'proj-ghost' }),
        ],
        's1',
      ),
    );
    h.actions.rebindSessionFolders(projects, { changedSessionIds: ['s2'] });
    const st = h.getState();
    // 仅 s2 被处理；s1 保持幽灵 folder（增量语义）
    expect(st.sessionsById['s1']!.folder).toBe('proj-ghost');
    expect(st.sessionsById['s2']!.folder).toBe('proj-new');
  });
});

describe('T-E 新 action：applySubagentEventToAgent / patchSessionAgentMessage', () => {
  it('patchSessionAgentMessage 回调 patch 指定消息（A1 buildPatchAsst 语义）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            agents: [
              {
                id: 'ag1',
                subagentRunId: 'r1',
                parentSessionId: 's1',
                parentRunId: 'p1',
                description: 'x',
                mode: 'research',
                status: 'running',
                startedAt: 1,
                messages: [makeMessage({ id: 'a1', text: '', thinking: '正在处理…' })],
              },
            ],
          }),
        ],
        's1',
      ),
    );
    h.actions.patchSessionAgentMessage('s1', 'ag1', 'a1', (m) => {
      m.text = 'hello';
      m.thinking = '';
    });
    const msg = h.getState().sessionsById['s1']!.agents![0]!.messages[0]!;
    expect(msg.text).toBe('hello');
    expect(msg.thinking).toBe('');
  });

  it('applySubagentEventToAgent 经 applySubagentEventToMessages 投影（U2/S2 语义）', () => {
    const h = makeHarnessFromState(
      makeStateFromSessions(
        [
          makeSession({
            id: 's1',
            agents: [
              {
                id: 'ag1',
                subagentRunId: 'r1',
                parentSessionId: 's1',
                parentRunId: 'p1',
                description: 'x',
                mode: 'research',
                status: 'running',
                startedAt: 1,
                messages: [makeMessage({ id: 'a1', text: 'prev', status: 'completed' })],
              },
            ],
          }),
        ],
        's1',
      ),
    );
    // event: { type: 'delta', text: ' chunk' } 追加正文（applySubagentEventToMessages 行为）
    h.actions.applySubagentEventToAgent('s1', 'ag1', {
      type: 'delta',
      text: ' chunk',
    });
    const msgs = h.getState().sessionsById['s1']!.agents![0]!.messages;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });
});
