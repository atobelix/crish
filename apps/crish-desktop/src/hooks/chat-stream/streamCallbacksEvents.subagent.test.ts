/**
 * applySubagentStarted 的 R4a 落数测试：引擎 SubagentStarted 展示字段
 * （role/capabilityMode/startedAt）经 chatApi info 透传后，必须落入
 * SessionAgent 的 displayLabel/capabilityMode/startedAt，且嵌套链
 * depth/subagentPath 按 parentToolCallId 派生——与全局面
 * （subagentHandlers.onSubagentStartedGlobal）同一口径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySubagentStarted } from './streamCallbacksEvents';
import { useSessionStore } from '../../store/sessionStore';
import type { SessionAgent } from '../../store/types';

let sid = '';
const created: string[] = [];

beforeEach(() => {
  sid = `sess-r4a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  useSessionStore.getState().createSession({
    title: 'r4a-subagent',
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
  return useSessionStore
    .getState()
    .sessionsById[sid]?.agents?.find((a) => a.id === id);
}

function start(info: Parameters<typeof applySubagentStarted>[0]['info']) {
  applySubagentStarted({
    sid,
    info,
    upsertSessionAgent: (sessionId, agent) =>
      useSessionStore.getState().upsertSessionAgent(sessionId, agent),
    queueToolCallPatch: vi.fn(),
  });
}

const baseInfo = {
  subagentId: 'sa-1',
  subagentRunId: 'sr-1',
  parentRunId: 'run-parent',
  description: '实现模块 B',
  mode: 'implement',
};

describe('applySubagentStarted（R4a 展示字段落数）', () => {
  it('完整 info：displayLabel/capabilityMode/startedAt 落字段，主派 depth 0 / 路径仅自身', () => {
    start({
      ...baseInfo,
      parentToolCallId: 'tc-main-1',
      role: 'implementer',
      capabilityMode: 'read-only',
      startedAt: '2026-08-03T08:00:00.000Z',
    });
    const ag = agentById('sa-1');
    expect(ag).toBeDefined();
    expect(ag!.displayLabel).toBe('implementer');
    expect(ag!.capabilityMode).toBe('read-only');
    expect(ag!.startedAt).toBe(Date.parse('2026-08-03T08:00:00.000Z'));
    expect(ag!.depth).toBe(0);
    expect(ag!.subagentPath).toEqual(['sa-1']);
    expect(ag!.status).toBe('running');
  });

  it('嵌套分派：parentToolCallId 命中父 agent 时间线 → depth+1、路径续接', () => {
    useSessionStore.getState().upsertSessionAgent(sid, {
      id: 'sa-parent',
      subagentRunId: 'sr-parent',
      parentSessionId: sid,
      parentRunId: 'run-parent',
      description: '父 agent',
      mode: 'research',
      status: 'running',
      messages: [
        {
          id: 'parent-asst-1',
          sender: 'assistant',
          text: '',
          timestamp: Date.now(),
          status: 'processing',
          toolCalls: [
            {
              id: 'tc-spawn-child',
              name: 'run_subagent',
              arguments: '',
              status: 'running',
            },
          ],
          blocks: [],
        },
      ],
      startedAt: Date.now(),
      depth: 0,
      subagentPath: ['sa-parent'],
    });
    start({
      ...baseInfo,
      subagentId: 'sa-child',
      subagentRunId: 'sr-child',
      parentToolCallId: 'tc-spawn-child',
      role: 'reviewer',
      capabilityMode: 'read-only',
      startedAt: '2026-08-03T09:00:00.000Z',
    });
    const child = agentById('sa-child');
    expect(child).toBeDefined();
    expect(child!.depth).toBe(1);
    expect(child!.subagentPath).toEqual(['sa-parent', 'sa-child']);
    expect(child!.displayLabel).toBe('reviewer');
  });

  it('展示字段缺失：不伪造 displayLabel/capabilityMode，startedAt 回退本地时刻', () => {
    const before = Date.now();
    start({ ...baseInfo });
    const ag = agentById('sa-1');
    expect(ag).toBeDefined();
    expect(ag!.displayLabel).toBeUndefined();
    expect(ag!.capabilityMode).toBeUndefined();
    expect(ag!.startedAt).toBeGreaterThanOrEqual(before);
    expect(ag!.startedAt).toBeLessThanOrEqual(Date.now());
    expect(ag!.depth).toBe(0);
    expect(ag!.subagentPath).toEqual(['sa-1']);
  });

  it('startedAt 不可解析 → 回退本地时刻，不写入 NaN', () => {
    const before = Date.now();
    start({ ...baseInfo, startedAt: 'garbage-time' });
    const ag = agentById('sa-1');
    expect(ag).toBeDefined();
    expect(Number.isFinite(ag!.startedAt)).toBe(true);
    expect(ag!.startedAt).toBeGreaterThanOrEqual(before);
  });
});
