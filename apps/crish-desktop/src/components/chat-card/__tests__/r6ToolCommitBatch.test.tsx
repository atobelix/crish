// @vitest-environment jsdom
/**
 * R6：桥接层工具提交微批（性能审计 P2「桥接层零合并」）+ 消费层投影计数。
 *
 * 夹具：一条助手消息挂 4 个 running 工具，同一 tick 内 4 个终态 commit
 * 同时到达（并行工具同时收官的典型形态）。
 * 断言：
 * - 同步点：store 尚未写入（commit 先入队）——4 次提交塌缩为 1 次 flush；
 * - 微任务后：4 个工具全部落盘为终态（保序、不吞终结事件），同工具同窗口
 *   的重复 commit 合并为最终字段；
 * - 消费层：useChatMessages 的重渲染（= 投影重算触发点）在整段 commit
 *   期间不随提交个数增长（<= 2 次：flush 一轮 + 容忍一轮框架调度）。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../store/sessionStore';
import type {
  MessageToolCall,
  SessionMessage,
  SessionState,
} from '../../../store/types';
import {
  commitToolPatchToSession,
  flushPendingToolCommits,
} from '../../../hooks/chat-stream/helpers';
import { useChatMessages } from '../useChatMessages';

const SID = 'sess-r6-batch';
const MID = 'asst-r6-batch';

function makeTool(id: string): MessageToolCall {
  return {
    id,
    name: 'shell',
    status: 'running',
    arguments: 'ls',
  } as MessageToolCall;
}

function seedSession(): void {
  const assistant: SessionMessage = {
    id: MID,
    sender: 'assistant',
    text: '正在执行',
    timestamp: 2,
    status: 'processing',
    toolCalls: [makeTool('t1'), makeTool('t2'), makeTool('t3'), makeTool('t4')],
  } as SessionMessage;
  const userMsg: SessionMessage = {
    id: 'u-r6',
    sender: 'user',
    text: '跑一下',
    timestamp: 1,
    status: 'completed',
  } as SessionMessage;
  useSessionStore.setState((st) => {
    st.sessionsById = {
      [SID]: {
        id: SID,
        title: 'R6 微批夹具',
        folder: '对话',
        isPinned: false,
        isArchived: false,
        timestamp: 't0',
        messages: [userMsg, assistant],
        messagesHydrated: true,
        agents: [],
      } as unknown as SessionState,
    };
    st.activeSessionId = SID;
  });
}

function storeTools(): MessageToolCall[] {
  const session = useSessionStore.getState().sessionsById[SID];
  const msg = session?.messages.find((m) => m.id === MID);
  return msg?.toolCalls ?? [];
}

describe('R6 工具提交微批', () => {
  beforeEach(() => {
    flushPendingToolCommits();
    seedSession();
  });

  it('4 个终态同 tick 提交：同步点零落盘，微任务后全部终态落盘', async () => {
    for (const id of ['t1', 't2', 't3', 't4']) {
      commitToolPatchToSession(SID, MID, id, {
        id,
        status: 'success',
        output: `out-${id}`,
      });
    }
    // 同步点：入队未落盘
    expect(storeTools().map((t) => t.status)).toEqual([
      'running',
      'running',
      'running',
      'running',
    ]);

    await Promise.resolve();

    const tools = storeTools();
    expect(tools.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(tools.map((t) => t.status)).toEqual([
      'success',
      'success',
      'success',
      'success',
    ]);
    expect(tools.map((t) => t.output)).toEqual([
      'out-t1',
      'out-t2',
      'out-t3',
      'out-t4',
    ]);
    // 合并基保留了工具的既有字段（name/arguments 来自 store 行）
    expect(tools.every((t) => t.name === 'shell')).toBe(true);
  });

  it('同工具同窗口重复 commit 合并为最终字段且只保留一份', async () => {
    commitToolPatchToSession(SID, MID, 't1', {
      id: 't1',
      status: 'success',
      output: '第一次收官',
    });
    commitToolPatchToSession(SID, MID, 't1', {
      id: 't1',
      status: 'success',
      output: '修正后的收官',
      durationMs: 42,
    });
    await Promise.resolve();
    const t1 = storeTools().find((t) => t.id === 't1');
    expect(t1?.status).toBe('success');
    expect(t1?.output).toBe('修正后的收官');
    expect(storeTools().filter((t) => t.id === 't1')).toHaveLength(1);
  });

  it('flushPendingToolCommits 同步收尾（生命周期边界语义）', () => {
    commitToolPatchToSession(SID, MID, 't2', {
      id: 't2',
      status: 'error',
      output: 'boom',
    });
    flushPendingToolCommits();
    const t2 = storeTools().find((t) => t.id === 't2');
    expect(t2?.status).toBe('error');
    expect(t2?.output).toBe('boom');
  });

  it('消费层投影触发次数不随同 tick 提交个数增长', async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: SID,
        localMsgFilter: '',
        mainSurface: 'chat',
      });
    });
    expect(result.current.displayMessages.map((m) => m.id)).toEqual([
      'u-r6',
      MID,
    ]);
    const beforeCommits = renders;

    await act(async () => {
      for (const id of ['t1', 't2', 't3', 't4']) {
        commitToolPatchToSession(SID, MID, id, {
          id,
          status: 'success',
          output: `out-${id}`,
        });
      }
      // 让微任务 flush 落盘并完成一轮渲染调度
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeTools().every((t) => t.status === 'success')).toBe(true);
    // 旧行为：每次 commit 一次 store 写入 → 至少 4 轮重渲染/投影。
    // 微批后：整段提交只允许 flush 触发的合并渲染（<=2 轮容忍框架调度）。
    expect(renders - beforeCommits).toBeLessThanOrEqual(2);
  });
});
