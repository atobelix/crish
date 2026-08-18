/**
 * subagent 域三 handler 行为测试（I5-M7：C8 事件契约信封对齐）。
 *
 * Rust 契约（crates/conex-types/src/events.rs + contracts/engine-events.json）：
 * - subagent-started：subagentId/subagentRunId/role/capabilityMode/startedAt
 *   （必填）+ description/mode/parentToolCallId（可选）；runId 由信封注入 = 父 run；
 * - subagent-event：event 为结构化负载 { kind: progress/message/tool, payload? }，
 *   handler 整体透传；
 * - subagent-ended：status 规范值 completed/failed/cancelled（前端正则映射
 *   stopped/failed/completed）+ summary（可选）/endedAt。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  onSubagentEnded,
  onSubagentEvent,
  onSubagentStarted,
  onSubagentEndedGlobal,
  onSubagentEventGlobal,
  onSubagentStartedGlobal,
} from './subagentHandlers';
import { useLayoutStore } from '../../../store/layoutStore';
import type { SessionAgent } from '../../../store/types';
import type { LegacyEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

const env = { runId: 'run-parent' } as HandlerEnv;

function legacy(type: string, raw: Record<string, unknown>): LegacyEnvelope {
  return { kind: 'legacy', type: type as LegacyEnvelope['type'], raw };
}

describe('onSubagentStarted（I5-M7 信封对齐：Rust 契约字段逐一消费）', () => {
  it('完整信封：subagentId/subagentRunId/parentRunId/parentToolCallId/description/mode 透传', () => {
    let captured: unknown;
    onSubagentStarted(
      {
        ...env,
        callbacks: {
          onSubagentStarted: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-started', {
        type: 'subagent-started',
        runId: 'run-parent',
        sessionId: 's1',
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        role: 'researcher',
        capabilityMode: 'readonly',
        startedAt: '2026-08-03T08:00:00.000Z',
        description: '调研子代理',
        mode: 'research',
        parentToolCallId: 'tc-9',
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      parentRunId: 'run-parent',
      parentToolCallId: 'tc-9',
      description: '调研子代理',
      mode: 'research',
    });
  });

  it('缺省兜底：runId 缺省取 env.runId、description/mode 兜底、parentToolCallId 缺省 undefined', () => {
    let captured: unknown;
    onSubagentStarted(
      {
        ...env,
        callbacks: {
          onSubagentStarted: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-started', {
        type: 'subagent-started',
        subagentId: 'sa-2',
        subagentRunId: 'sr-2',
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-2',
      subagentRunId: 'sr-2',
      parentRunId: 'run-parent',
      parentToolCallId: undefined,
      description: '协作 agent',
      mode: 'research',
    });
  });

  it('EngineEnvelope 强类型信封路径：字段正确透传', () => {
    let captured: unknown;
    onSubagentStarted(
      {
        ...env,
        callbacks: {
          onSubagentStarted: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      {
        kind: 'engine',
        type: 'subagent-started',
        originalType: 'subagent-started',
        raw: { runId: 'run-parent' },
        event: {
          type: 'subagent-started',
          sessionId: 's1',
          subagentId: 'sa-typed-1',
          subagentRunId: 'sr-typed-1',
          role: 'researcher',
          capabilityMode: 'readonly',
          startedAt: '2026-08-03T08:00:00.000Z',
          description: '强类型子代理',
          mode: 'research',
          parentToolCallId: 'tc-typed-9',
        },
      }
    );
    expect(captured).toEqual({
      subagentId: 'sa-typed-1',
      subagentRunId: 'sr-typed-1',
      parentRunId: 'run-parent',
      parentToolCallId: 'tc-typed-9',
      description: '强类型子代理',
      mode: 'research',
    });
  });
});

describe('onSubagentEvent（I5-M7：event 结构化负载整体透传）', () => {
  it('progress 类事件：event 对象原样透传（kind + payload）', () => {
    let captured: unknown;
    onSubagentEvent(
      {
        ...env,
        callbacks: {
          onSubagentEvent: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-event', {
        type: 'subagent-event',
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        event: { kind: 'progress', payload: { percent: 40, step: 'reading' } },
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      event: { kind: 'progress', payload: { percent: 40, step: 'reading' } },
    });
  });

  it('缺省 event / 非对象 event 兜底为空对象（不抛错）', () => {
    let captured: unknown;
    const cb = (info: unknown) => {
      captured = info;
    };
    onSubagentEvent(
      { ...env, callbacks: { onSubagentEvent: cb } } as unknown as HandlerEnv,
      legacy('subagent-event', { type: 'subagent-event', subagentId: 'sa-1' })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: '',
      event: {},
    });
  });

  it('EngineEnvelope 强类型信封路径：event 结构化负载透传', () => {
    let captured: unknown;
    onSubagentEvent(
      {
        ...env,
        callbacks: {
          onSubagentEvent: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      {
        kind: 'engine',
        type: 'subagent-event',
        originalType: 'subagent-event',
        raw: {
          event: { kind: 'progress', payload: { step: 'analysis' } },
        },
        event: {
          type: 'subagent-event',
          sessionId: 's1',
          subagentId: 'sa-ev-1',
          subagentRunId: 'sr-ev-1',
          event: { kind: 'progress', payload: { step: 'analysis' } },
        },
      }
    );
    expect(captured).toEqual({
      subagentId: 'sa-ev-1',
      subagentRunId: 'sr-ev-1',
      event: { kind: 'progress', payload: { step: 'analysis' } },
    });
  });
});

describe('onSubagentEnded（I5-M7：status 正则映射 + summary/endedAt 透传）', () => {
  it('EngineEnvelope 强类型信封路径：status 正则映射 + summary 消费', () => {
    let captured: unknown;
    onSubagentEnded(
      {
        ...env,
        callbacks: {
          onSubagentEnded: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      {
        kind: 'engine',
        type: 'subagent-ended',
        originalType: 'subagent-ended',
        raw: {},
        event: {
          type: 'subagent-ended',
          sessionId: 's1',
          subagentId: 'sa-end-1',
          subagentRunId: 'sr-end-1',
          status: 'completed',
          summary: '已完成任务',
          endedAt: '2026-08-03T08:00:00.000Z',
        },
      }
    );
    expect(captured).toEqual({
      subagentId: 'sa-end-1',
      subagentRunId: 'sr-end-1',
      status: 'completed',
      summary: '已完成任务',
    });
  });

  it('Rust 规范值映射：completed→completed、failed→failed、cancelled→stopped', () => {
    const cases: Array<[string, 'completed' | 'failed' | 'stopped']> = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'stopped'],
    ];
    for (const [wire, expected] of cases) {
      let captured: unknown;
      onSubagentEnded(
        {
          ...env,
          callbacks: {
            onSubagentEnded: (info: unknown) => {
              captured = info;
            },
          },
        } as unknown as HandlerEnv,
        legacy('subagent-ended', {
          type: 'subagent-ended',
          subagentId: 'sa-1',
          subagentRunId: 'sr-1',
          status: wire,
          summary: '收尾摘要',
          endedAt: '2026-08-03T08:00:00.000Z',
        })
      );
      expect(captured).toEqual({
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        status: expected,
        summary: '收尾摘要',
      });
    }
  });

  it('兼容宽松值：aborted/stopped 正则映射 stopped、error 映射 failed、stop 单字不命中', () => {
    // 前端解析器正则 /cancel|stopp?ed|abort/i（subagentHandlers.ts:52）：
    // stopped 需带 ed 后缀才命中，Rust 规范值 cancelled 走 cancel 分支
    const cases: Array<[string, 'completed' | 'failed' | 'stopped']> = [
      ['aborted', 'stopped'],
      ['stopped', 'stopped'],
      ['stop', 'completed'],
      ['error', 'failed'],
    ];
    for (const [wire, expected] of cases) {
      let captured: unknown;
      onSubagentEnded(
        {
          ...env,
          callbacks: {
            onSubagentEnded: (info: unknown) => {
              captured = info;
            },
          },
        } as unknown as HandlerEnv,
        legacy('subagent-ended', {
          type: 'subagent-ended',
          subagentId: 'sa-1',
          subagentRunId: 'sr-1',
          status: wire,
        })
      );
      expect(captured).toMatchObject({ status: expected });
    }
  });

  it('缺省 summary 兜底 undefined、未知 status 兜底 completed', () => {
    let captured: unknown;
    onSubagentEnded(
      {
        ...env,
        callbacks: {
          onSubagentEnded: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-ended', {
        type: 'subagent-ended',
        subagentId: 'sa-1',
        status: 'weird',
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: '',
      status: 'completed',
      summary: undefined,
    });
  });
});

describe('子代理面全局消费者（父 run 收口后兜底 → agents store，T-6）', () => {
  const created: string[] = [];
  let sid = '';

  beforeEach(() => {
    sid = `sess-sub-global-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().createSession({
      title: 'sub-global-test',
      id: sid,
      activate: false,
    });
    created.push(sid);
  });
  afterEach(() => {
    for (const s of created.splice(0)) {
      useSessionStore.getState().deleteSession(s);
    }
  });

  function agentById(id: string): SessionAgent | undefined {
    return useLayoutStore
      .getState()
      .sessionsById[sid]?.agents?.find((a) => a.id === id);
  }

  function toolCall(messageId: string, toolId: string) {
    return useLayoutStore
      .getState()
      .sessionsById[sid]?.messages?.find((m) => m.id === messageId)
      ?.toolCalls?.find((t) => t.id === toolId);
  }

  it('started 全局消费：agent 落 store（upsert 语义，字段对齐 per-run）', () => {
    onSubagentStartedGlobal({
      type: 'subagent-started',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      description: '调研模块 A',
      mode: 'research',
      parentToolCallId: 'tc-9',
    });
    const ag = agentById('sa-1');
    expect(ag).toBeDefined();
    expect(ag!.parentRunId).toBe('run-parent');
    expect(ag!.parentSessionId).toBe(sid);
    expect(ag!.description).toBe('调研模块 A');
    expect(ag!.mode).toBe('research');
    expect(ag!.status).toBe('running');
    expect(ag!.parentToolCallId).toBe('tc-9');
  });

  it('started 全局消费防双写：同 id agent 已存在（per-run 已建）→ 跳过不覆盖', () => {
    useLayoutStore.getState().upsertSessionAgent(sid, {
      id: 'sa-1',
      subagentRunId: 'sr-1',
      parentSessionId: sid,
      parentRunId: 'run-parent',
      description: 'per-run 已建标签',
      mode: 'research',
      status: 'running',
      messages: [],
      startedAt: 1,
    });
    onSubagentStartedGlobal({
      type: 'subagent-started',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      description: '迟到覆盖标签',
      mode: 'research',
    });
    expect(agentById('sa-1')!.description).toBe('per-run 已建标签');
  });

  it('started 全局消费：父工具卡置 running（running 态才更新）', () => {
    useLayoutStore
      .getState()
      .addMessage(useLayoutStore.getState().workspaces[0].id, sid, {
        id: 'm1',
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-running',
            name: 'run_subagent',
            arguments: '',
            status: 'running',
          },
        ],
      });
    onSubagentStartedGlobal({
      type: 'subagent-started',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      parentToolCallId: 'tc-running',
    });
    const tc = toolCall('m1', 'tc-running');
    expect(tc!.status).toBe('running');
    expect(tc!.output).toBe('协作进行中…');
  });

  it('started 全局消费：终态父工具卡不回退为 running', () => {
    useLayoutStore
      .getState()
      .addMessage(useLayoutStore.getState().workspaces[0].id, sid, {
        id: 'm1',
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-done',
            name: 'run_subagent',
            arguments: '',
            status: 'success',
            output: '旧输出',
          },
        ],
      });
    onSubagentStartedGlobal({
      type: 'subagent-started',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      parentToolCallId: 'tc-done',
    });
    const tc = toolCall('m1', 'tc-done');
    expect(tc!.status).toBe('success');
    expect(tc!.output).toBe('旧输出');
  });

  it('event 全局消费：message-delta 投影到 agent 时间线（applySubagentEventToMessages 同源）', () => {
    useLayoutStore.getState().upsertSessionAgent(sid, {
      id: 'sa-1',
      subagentRunId: 'sr-1',
      parentSessionId: sid,
      parentRunId: 'run-parent',
      description: '调研',
      mode: 'research',
      status: 'running',
      messages: [],
      startedAt: Date.now(),
    });
    onSubagentEventGlobal({
      type: 'subagent-event',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      event: {
        type: 'message-delta',
        block: { type: 'text', text: '调研结果：' },
      },
    });
    expect(agentById('sa-1')!.messages[0]?.text).toBe('调研结果：');
  });

  it('event 全局消费：agent 不存在 / 缺 sessionId → 静默跳过（不抛错）', () => {
    expect(() =>
      onSubagentEventGlobal({
        type: 'subagent-event',
        runId: 'run-parent',
        sessionId: sid,
        subagentId: 'sa-missing',
        subagentRunId: 'sr-1',
        event: { type: 'message-delta', block: { type: 'text', text: 'x' } },
      })
    ).not.toThrow();
    expect(() =>
      onSubagentEventGlobal({
        type: 'subagent-event',
        runId: 'run-parent',
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        event: { type: 'message-delta', block: { type: 'text', text: 'x' } },
      })
    ).not.toThrow();
  });

  it('ended 全局消费：status/summary/endedAt + 时间线消息收口 + 父工具卡终态', () => {
    useLayoutStore
      .getState()
      .addMessage(useLayoutStore.getState().workspaces[0].id, sid, {
        id: 'm1',
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-spawn',
            name: 'run_subagent',
            arguments: '',
            status: 'running',
          },
        ],
      });
    useLayoutStore.getState().upsertSessionAgent(sid, {
      id: 'sa-1',
      subagentRunId: 'sr-1',
      parentSessionId: sid,
      parentRunId: 'run-parent',
      parentToolCallId: 'tc-spawn',
      description: '调研',
      mode: 'research',
      status: 'running',
      messages: [
        {
          id: 'agent-asst-1',
          sender: 'assistant',
          text: '部分正文',
          timestamp: Date.now(),
          status: 'processing',
          toolCalls: [],
          blocks: [],
        },
      ],
      startedAt: Date.now(),
    });
    onSubagentEndedGlobal({
      type: 'subagent-ended',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      status: 'completed',
      summary: '完成调研',
    });
    const ag = agentById('sa-1')!;
    expect(ag.status).toBe('completed');
    expect(ag.summary).toBe('完成调研');
    expect(ag.endedAt).toBeTypeOf('number');
    expect(ag.messages[0]?.status).toBe('completed');
    const tc = toolCall('m1', 'tc-spawn');
    expect(tc!.status).toBe('success');
    expect(tc!.output).toBe('完成调研');
  });

  it('ended 全局消费：failed → 父工具卡 error + 兜底文案', () => {
    useLayoutStore
      .getState()
      .addMessage(useLayoutStore.getState().workspaces[0].id, sid, {
        id: 'm1',
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-spawn',
            name: 'run_subagent',
            arguments: '',
            status: 'running',
          },
        ],
      });
    useLayoutStore.getState().upsertSessionAgent(sid, {
      id: 'sa-1',
      subagentRunId: 'sr-1',
      parentSessionId: sid,
      parentRunId: 'run-parent',
      parentToolCallId: 'tc-spawn',
      description: '调研',
      mode: 'research',
      status: 'running',
      messages: [],
      startedAt: Date.now(),
    });
    onSubagentEndedGlobal({
      type: 'subagent-ended',
      runId: 'run-parent',
      sessionId: sid,
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      status: 'failed',
    });
    expect(agentById('sa-1')!.status).toBe('failed');
    const tc = toolCall('m1', 'tc-spawn');
    expect(tc!.status).toBe('error');
    expect(tc!.output).toBe('协作未完成');
  });
});

import { useSessionStore } from '@/store/sessionStore';