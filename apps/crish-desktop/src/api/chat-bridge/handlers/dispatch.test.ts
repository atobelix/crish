/**
 * 分派表全键穷举（T7）：每个生成 EventType 至少命中一条 handler；
 * legacy 信封键（subagent-* / error）同样有 handler。
 */
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_EVENT_TYPES } from '../../../../../../packages/shared-types/src/generated/engine';
import { LEGACY_EVENT_TYPES } from './eventParser';
import {
  dispatchEvent,
  engineDispatchTable,
  legacyDispatchTable,
  onTimelineTruncate,
} from './dispatch';
import type { BridgeEventEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { useLayoutStore } from '../../../store/layoutStore';
import { onUiEvent } from '../../../api/uiEvents';

// R2-b ⑥：timeline-truncate 消费端失效传播断言（编辑会话消费端 mock）
const invalidationSpy = vi.hoisted(() => ({
  invalidateEditObjects: vi.fn(),
}));
vi.mock('../editSessionConsumer', () => ({
  editSessionConsumer: {
    open: vi.fn(),
    commit: vi.fn(),
    invalidate: vi.fn(),
    isOpen: vi.fn(),
  },
  invalidateEditObjects: invalidationSpy.invalidateEditObjects,
  bindEditSession: vi.fn(),
  getBoundEditSession: vi.fn(() => null),
  isEditSessionConsumerBound: vi.fn(() => false),
}));

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
    approvalFlow: {
      dispatch: () => {},
      snapshot: () => ({}),
    } as unknown as HandlerEnv['approvalFlow'],
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
    expect(Object.keys(engineDispatchTable).length).toBe(
      ENGINE_EVENT_TYPES.length
    );
  });

  it('legacy 信封键（subagent-* / error）均有 handler', () => {
    for (const type of LEGACY_EVENT_TYPES) {
      expect(typeof legacyDispatchTable[type]).toBe('function');
    }
    expect(Object.keys(legacyDispatchTable).length).toBe(
      LEGACY_EVENT_TYPES.length
    );
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

describe('onTimelineTruncate（R1 撤回消费：投影截断到 boundary + 回填事件派发）', () => {
  const created: string[] = [];
  let sid = '';

  beforeEach(() => {
    sid = `sess-retract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().createSession({
      title: 'retract-test',
      id: sid,
      activate: false,
    });
    created.push(sid);
    invalidationSpy.invalidateEditObjects.mockClear();
    const wsId = useLayoutStore.getState().workspaces[0].id;
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-u1',
      sender: 'user',
      text: '撤回我',
      timestamp: 1,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a1',
      sender: 'assistant',
      text: '第一轮回复',
      timestamp: 2,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a2',
      sender: 'assistant',
      text: '第二轮回复',
      timestamp: 3,
    });
  });

  afterEach(() => {
    for (const s of created.splice(0)) {
      useSessionStore.getState().deleteSession(s);
    }
  });

  function truncateEnvelope(
    sessionId: string | undefined,
    targetMessageId: string,
    boundarySeq: number
  ) {
    return {
      kind: 'engine',
      type: 'timeline-truncate',
      originalType: 'timeline-truncate',
      event: {
        type: 'timeline-truncate',
        sessionId,
        runId: 'run-1',
        boundarySeq,
        reason: 'user-requested',
        targetMessageId,
        timestamp: '2026-08-16T00:00:00.000Z',
      },
      raw: {},
    } as Parameters<typeof onTimelineTruncate>[1];
  }

  it('投影截断到 boundary（保留目标节点，丢弃其后）+ 派发 retract-backfill（boundary user 文本）', () => {
    const events: Array<{ sessionId: string; text: string }> = [];
    const off = onUiEvent('retract-backfill', (detail) => events.push(detail));
    onTimelineTruncate(makeEnv(), truncateEnvelope(sid, 'msg-u1', 5));
    off();

    const msgs = useLayoutStore.getState().sessionsById[sid].messages;
    expect(msgs.map((m) => m.id)).toEqual(['msg-u1']);
    expect(events).toEqual([{ sessionId: sid, text: '撤回我' }]);
  });

  it('目标节点非 user（assistant）→ 仍截断但不派发回填', () => {
    const events: Array<{ sessionId: string; text: string }> = [];
    const off = onUiEvent('retract-backfill', (detail) => events.push(detail));
    onTimelineTruncate(makeEnv(), truncateEnvelope(sid, 'msg-a1', 5));
    off();

    const msgs = useLayoutStore.getState().sessionsById[sid].messages;
    expect(msgs.map((m) => m.id)).toEqual(['msg-u1', 'msg-a1']);
    expect(events).toEqual([]);
  });

  it('缺 sessionId → 不消费不派发（载荷防御）', () => {
    const events: Array<{ sessionId: string; text: string }> = [];
    const off = onUiEvent('retract-backfill', (detail) => events.push(detail));
    onTimelineTruncate(makeEnv(), truncateEnvelope(undefined, 'msg-u1', 5));
    off();

    const msgs = useLayoutStore.getState().sessionsById[sid].messages;
    expect(msgs).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it('R2-b ⑥ 失效传播：boundary 之后的消息 id 收到 invalidate(truncate)', () => {
    onTimelineTruncate(makeEnv(), truncateEnvelope(sid, 'msg-u1', 5));

    // 截断范围 = target 之后全部节点（投影截断前收集）
    expect(invalidationSpy.invalidateEditObjects).toHaveBeenCalledWith(
      ['msg-a1', 'msg-a2'],
      'truncate'
    );
  });

  it('R2-b ⑥ 目标为末节点 → 无截断范围 → 不派发 invalidate', () => {
    onTimelineTruncate(makeEnv(), truncateEnvelope(sid, 'msg-a2', 5));

    expect(invalidationSpy.invalidateEditObjects).not.toHaveBeenCalled();
  });

  it('R2-b ⑥ 缺 sessionId → 不派发 invalidate（载荷防御）', () => {
    onTimelineTruncate(makeEnv(), truncateEnvelope(undefined, 'msg-u1', 5));

    expect(invalidationSpy.invalidateEditObjects).not.toHaveBeenCalled();
  });
});

describe('applyTimelineTruncate（sessionMessageActions · 投影截断到 boundary 直接单测）', () => {
  const created: string[] = [];
  let sid = '';

  beforeEach(() => {
    sid = `sess-applytruncate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().createSession({
      title: 'apply-truncate-test',
      id: sid,
      activate: false,
    });
    created.push(sid);
    const wsId = useLayoutStore.getState().workspaces[0].id;
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-u1',
      sender: 'user',
      text: '撤回我',
      timestamp: 1,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a1',
      sender: 'assistant',
      text: '第一轮回复',
      timestamp: 2,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a2',
      sender: 'assistant',
      text: '第二轮回复',
      timestamp: 3,
    });
    // pinned 含截断后节点（验证 pinned 清理语义）
    useLayoutStore.getState().pinMessage(sid, 'msg-a2');
  });

  afterEach(() => {
    for (const s of created.splice(0)) {
      useSessionStore.getState().deleteSession(s);
    }
  });

  it('投影截断到 boundary：保留边界节点、丢弃其后 + 后续 pinned 引用清理', () => {
    useLayoutStore.getState().applyTimelineTruncate(sid, 5, 'msg-u1');

    const sess = useLayoutStore.getState().sessionsById[sid];
    expect(sess.messages.map((m) => m.id)).toEqual(['msg-u1']);
    expect(sess.pinnedMessageIds ?? []).toEqual([]);
  });

  it('目标节点不存在 → 不截断（投影防御）', () => {
    useLayoutStore.getState().applyTimelineTruncate(sid, 5, 'msg-no-such');

    const sess = useLayoutStore.getState().sessionsById[sid];
    expect(sess.messages).toHaveLength(3);
    expect(sess.pinnedMessageIds).toEqual(['msg-a2']);
  });

  it('目标为末节点 → 无后续节点，无截断（快照不写空操作）', () => {
    useLayoutStore.getState().applyTimelineTruncate(sid, 5, 'msg-a2');

    const sess = useLayoutStore.getState().sessionsById[sid];
    expect(sess.messages.map((m) => m.id)).toEqual([
      'msg-u1',
      'msg-a1',
      'msg-a2',
    ]);
    expect(sess.pinnedMessageIds).toEqual(['msg-a2']);
  });
});

import { useSessionStore } from '@/store/sessionStore';