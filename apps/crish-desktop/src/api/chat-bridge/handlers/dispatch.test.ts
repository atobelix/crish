/**
 * 分派表全键穷举（T7）：每个生成 EventType 至少命中一条 handler；
 * legacy 信封键（subagent-* / error）同样有 handler。
 */
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_EVENT_TYPES } from '../../../../../../packages/shared-types/src/generated/engine';
import { LEGACY_EVENT_TYPES } from './eventParser';
import { dispatchEvent, engineDispatchTable, legacyDispatchTable } from './dispatch';
import type { BridgeEventEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

function makeEnv(): HandlerEnv {
  return {
    state: {
      cancelled: false,
      finished: false,
      assistantText: '',
      assistantThought: '',
      unsub: null,
      endTimer: null,
    },
    approvalFlow: { dispatch: () => {}, snapshot: () => ({}) } as unknown as HandlerEnv['approvalFlow'],
    callbacks: {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onComplete: vi.fn(),
      onToolStart: vi.fn(),
      onToolSuccess: vi.fn(),
      onToolError: vi.fn(),
    } as unknown as HandlerEnv['callbacks'],
    runId: 'run-test',
    sessionId: 'sess-test',
    finish: () => {},
    tryResumeFinish: () => {},
  };
}

describe('分派表全键穷举（T7）', () => {
  it('每个生成 EventType 至少命中一条 handler（24 键全覆盖）', () => {
    expect(ENGINE_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const type of ENGINE_EVENT_TYPES) {
      expect(typeof engineDispatchTable[type]).toBe('function');
    }
    expect(Object.keys(engineDispatchTable).length).toBe(ENGINE_EVENT_TYPES.length);
  });

  it('legacy 信封键（subagent-* / error）均有 handler', () => {
    for (const type of LEGACY_EVENT_TYPES) {
      expect(typeof legacyDispatchTable[type]).toBe('function');
    }
    expect(Object.keys(legacyDispatchTable).length).toBe(LEGACY_EVENT_TYPES.length);
  });

  it('dispatchEvent 对 engine 信封与 legacy 信封均可分派且不抛错', () => {
    const env = makeEnv();
    const engineEnvelope = {
      kind: 'engine',
      type: 'message-delta',
      originalType: 'message-delta',
      event: {
        type: 'message-delta',
        sessionId: 's',
        timestamp: '',
        messageId: '',
        block: { type: 'text', text: 'hi' },
      },
      raw: { type: 'message-delta', block: { type: 'text', text: 'hi' } },
    } as unknown as BridgeEventEnvelope;
    expect(() => dispatchEvent(env, engineEnvelope)).not.toThrow();

    const legacyEnvelope = {
      kind: 'legacy',
      type: 'subagent-started',
      raw: { type: 'subagent-started', subagentId: 'sa-1' },
    } as BridgeEventEnvelope;
    expect(() => dispatchEvent(env, legacyEnvelope)).not.toThrow();
  });
});
