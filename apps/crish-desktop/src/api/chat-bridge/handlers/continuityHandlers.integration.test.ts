/**
 * continuityHandlers 集成面：recovery-escalated 子代理侧 handler 消费 → session store。
 * goal-* handler 的投影纯函数已由 continuityHandlers.test.ts 覆盖（纯函数层），
 * 本文件覆盖 handler 层接线。
 */
import { describe, expect, it } from 'vitest';
import { onRecoveryEscalated } from './continuityHandlers';
import { useSessionStore } from '../../../store/sessionStore';

type EscalatedPayload = {
  sessionId: string;
  subagentRunId?: string;
  kind?: string;
  retries?: number;
  detail?: string;
};

/** 构造 recovery-escalated engine 信封（形状对齐生成类型 EngineRecoveryEscalatedEvent） */
function escalatedEnvelope(payload: EscalatedPayload) {
  return {
    kind: 'engine' as const,
    type: 'recovery-escalated' as const,
    originalType: 'recovery-escalated',
    raw: { ...payload, type: 'recovery-escalated' },
    event: {
      type: 'recovery-escalated' as const,
      sessionId: payload.sessionId,
      kind: payload.kind ?? 'network',
      retries: payload.retries ?? 0,
      elapsedMs: 0,
      ...(payload.subagentRunId !== undefined
        ? { subagentRunId: payload.subagentRunId }
        : {}),
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
    },
  };
}

describe('onRecoveryEscalated（子代理侧投影）', () => {
  it('子代理侧（subagentRunId=Some）→ 投影 errorKind/retries 到 agent', () => {
    const testSession = {
      id: 's1',
      title: 'Test Session',
      messages: [],
      agents: [
        {
          id: 'a1',
          name: 'subagent-1',
          role: 'assistant' as const,
          subagentRunId: 'r1',
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    useSessionStore.setState((s) => ({
      ...s,
      sessions: [testSession as never],
      sessionsById: { s1: testSession as never },
    }));

    onRecoveryEscalated(
      {} as never,
      escalatedEnvelope({
        sessionId: 's1',
        subagentRunId: 'r1',
        kind: 'timeout',
        retries: 2,
      }) as never
    );

    const store = useSessionStore.getState();
    const agent = store.sessionsById['s1']?.agents?.find((a) => a.id === 'a1');
    expect(agent?.errorKind).toBe('timeout');
    expect(agent?.retries).toBe(2);
  });

  it('无 subagentRunId 熔断侧事件 → 安全忽略不崩溃', () => {
    expect(() => {
      onRecoveryEscalated(
        {} as never,
        escalatedEnvelope({ sessionId: 's1', detail: 'circuit-trip' }) as never
      );
    }).not.toThrow();
  });

  it('空 sessionId → 安全忽略', () => {
    expect(() => {
      onRecoveryEscalated(
        {} as never,
        escalatedEnvelope({ sessionId: '', detail: 'circuit-trip' }) as never
      );
    }).not.toThrow();
  });
});
