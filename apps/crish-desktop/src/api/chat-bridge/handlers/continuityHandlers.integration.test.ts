/**
 * continuityHandlers 集成面：recovery-escalated（熔断侧/子代理侧）handler
 * 消费 → continuityUiStore 横幅。goal-* handler 的投影纯函数已由
 * continuityHandlers.test.ts 覆盖（纯函数层），本文件覆盖 handler 层接线。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { onRecoveryEscalated } from './continuityHandlers';
import {
  resetContinuityUiStoreForTests,
  useContinuityUiStore,
  CIRCUIT_BANNER_DEFAULT_MESSAGE,
} from '../../continuity/continuityUiStore';

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

describe('onRecoveryEscalated（熔断侧，detail=circuit-trip）', () => {
  beforeEach(() => {
    resetContinuityUiStoreForTests();
  });

  it('detail=circuit-trip 且无 subagentRunId → 熔断横幅', () => {
    onRecoveryEscalated(
      {} as never,
      escalatedEnvelope({ sessionId: 's1', detail: 'circuit-trip' }) as never
    );
    const banner = useContinuityUiStore.getState().circuitBanners['s1'];
    expect(banner).toBeDefined();
    expect(banner!.message).toBe(CIRCUIT_BANNER_DEFAULT_MESSAGE);
    expect(banner!.reason).toBe('circuit-trip');
    expect(banner!.dismissed).toBe(false);
  });

  it('detail 非 circuit-trip → 不弹横幅', () => {
    onRecoveryEscalated(
      {} as never,
      escalatedEnvelope({ sessionId: 's1', detail: 'other' }) as never
    );
    expect(
      useContinuityUiStore.getState().circuitBanners['s1']
    ).toBeUndefined();
  });

  it('子代理侧（subagentRunId=Some、detail=None）→ 不弹横幅（留给失败卡片）', () => {
    onRecoveryEscalated(
      {} as never,
      escalatedEnvelope({
        sessionId: 's1',
        subagentRunId: 'r1',
        kind: 'timeout',
        retries: 2,
      }) as never
    );
    expect(
      useContinuityUiStore.getState().circuitBanners['s1']
    ).toBeUndefined();
  });

  it('空 sessionId → 不弹横幅（无归属不投影）', () => {
    onRecoveryEscalated(
      {} as never,
      escalatedEnvelope({ sessionId: '', detail: 'circuit-trip' }) as never
    );
    expect(
      useContinuityUiStore.getState().circuitBanners['s1']
    ).toBeUndefined();
  });
});
