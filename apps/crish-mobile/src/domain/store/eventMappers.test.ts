// eventMappers 单测：事件映射（F1 §2.5 矩阵 → store 动作）——映射表全量由生成面驱动
// （ENGINE_EVENT_TYPES 事件 type 列表 + DEVICE_KINDS kind 列表，F3 §8.4 防漂移护栏同构）
import { ENGINE_EVENT_TYPES } from '@crish/shared-types';
import { DEVICE_KINDS } from '@crish/shared-types';
import type { SessionIndexEntry } from '@crish/shared-types';
import {
  EVENT_ROUTES,
  KNOWN_EVENT_TYPES,
  extractEnvelope,
  extractSessionIndexEntry,
  mapDeviceFrame,
  mapIngestFrame,
  routeEventType,
  type StoreIngestAction,
} from './eventMappers';

function frame(
  overrides: { type?: string; runId?: string; sessionId?: string } = {}
) {
  return { type: 'message-end', sessionId: 's-1', ...overrides };
}

function pushFrame(event: unknown, body: Record<string, unknown> = {}) {
  return { kind: 'events.push', body: { sessionId: 's-1', event, ...body } };
}

describe('路由表全量覆盖（F3 §8.4 防漂移：生成面事件 type 列表驱动）', () => {
  it('ENGINE_EVENT_TYPES 每个 type 都有明确路由（KNOWN_EVENT_TYPES 与生成面一致）', () => {
    for (const type of ENGINE_EVENT_TYPES) {
      expect(routeEventType(type)).not.toBeNull();
      expect(KNOWN_EVENT_TYPES.has(type)).toBe(true);
    }
    expect(Object.keys(EVENT_ROUTES).sort()).toEqual(
      [...ENGINE_EVENT_TYPES].sort()
    );
  });

  it('会话级副作用路由与 F1 §2.5「落/刷」列一致（agent-start/run-terminal/approval-*）', () => {
    expect(routeEventType('agent-start')).toBe('run-active');
    expect(routeEventType('run-terminal')).toBe('run-terminal');
    expect(routeEventType('approval-requested')).toBe('approval-plus');
    expect(routeEventType('approval-resolved')).toBe('approval-minus');
    // 抽样：其余事件仅入 feed
    expect(routeEventType('message-end')).toBe('feed');
    expect(routeEventType('task-started')).toBe('feed');
    expect(routeEventType('security-audit')).toBe('feed');
    expect(routeEventType('cache-stats-updated')).toBe('feed');
  });

  it('未知 type 宽容跳过（MessageKind::Unknown 语义：不崩溃、不猜测）', () => {
    expect(routeEventType('future-event-99')).toBeNull();
    expect(routeEventType('')).toBeNull();
    const actions = mapIngestFrame(
      { type: 'future-event-99', sessionId: 's-1' },
      false
    );
    expect(actions).toEqual([
      { kind: 'ignore', reason: 'unknown-event-type:future-event-99' },
    ]);
  });
});

describe('mapIngestFrame（事件信封 → store 动作）', () => {
  it('默认路由：feed-append（preview 透传）', () => {
    const actions = mapIngestFrame(
      frame({ type: 'message-end', runId: 'r-1' }),
      false
    );
    expect(actions).toEqual([
      {
        kind: 'feed-append',
        sessionId: 's-1',
        frame: frame({ type: 'message-end', runId: 'r-1' }),
        preview: false,
      },
    ]);
    const previewActions = mapIngestFrame(
      frame({ type: 'message-delta' }),
      true
    );
    expect(previewActions[0]).toMatchObject({
      kind: 'feed-append',
      preview: true,
    });
  });

  it('agent-start → feed-append + run-active（F1 F03 活动任务新增）', () => {
    const actions = mapIngestFrame(
      frame({ type: 'agent-start', runId: 'r-1' }),
      false
    );
    expect(actions).toEqual([
      {
        kind: 'feed-append',
        sessionId: 's-1',
        frame: expect.any(Object),
        preview: false,
      },
      { kind: 'run-active', sessionId: 's-1', runId: 'r-1' },
    ]);
  });

  it('agent-start 缺 runId（数据面/预览帧）→ 仅入 feed，容忍跳过活动标记', () => {
    const actions = mapIngestFrame(frame({ type: 'agent-start' }), true);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('feed-append');
  });

  it('run-terminal → feed-append + run-terminal（terminal 三态透传）', () => {
    const actions = mapIngestFrame(
      {
        type: 'run-terminal',
        sessionId: 's-1',
        runId: 'r-1',
        terminal: 'failed',
      },
      false
    );
    expect(actions).toEqual([
      {
        kind: 'feed-append',
        sessionId: 's-1',
        frame: expect.any(Object),
        preview: false,
      },
      {
        kind: 'run-terminal',
        sessionId: 's-1',
        runId: 'r-1',
        terminal: 'failed',
      },
    ]);
  });

  it('approval-requested / approval-resolved → 待审批计数 ±1（F1 §5.3 落）', () => {
    const plus = mapIngestFrame(frame({ type: 'approval-requested' }), false);
    expect(plus[1]).toEqual({
      kind: 'approval-delta',
      sessionId: 's-1',
      delta: 1,
    });
    const minus = mapIngestFrame(frame({ type: 'approval-resolved' }), false);
    expect(minus[1]).toEqual({
      kind: 'approval-delta',
      sessionId: 's-1',
      delta: -1,
    });
  });
});

describe('extractEnvelope（宽容信封解析，保留原对象引用不复制载荷）', () => {
  it('合法扁平信封 → 原对象引用（载荷字段原样保留）', () => {
    const raw = {
      type: 'tool-end',
      runId: 'r-1',
      sequence: 41,
      schemaVersion: 1,
      sessionId: 's-1',
      result: { id: 'tc-9', isError: false },
    };
    const envelope = extractEnvelope(raw);
    expect(envelope).not.toBeNull();
    expect(envelope).toBe(raw as unknown as ReturnType<typeof extractEnvelope>);
    expect(envelope!['result']).toEqual({ id: 'tc-9', isError: false });
  });

  it('缺 type/sessionId → null（宽容跳过）；fallbackSessionId 兜底', () => {
    expect(extractEnvelope({ type: 'message-end' })).toBeNull();
    expect(extractEnvelope({ sessionId: 's-1' })).toBeNull();
    expect(extractEnvelope(null)).toBeNull();
    expect(extractEnvelope('str')).toBeNull();
    expect(extractEnvelope({ type: 'message-end' }, 's-1')).not.toBeNull();
  });

  it('extractSessionIndexEntry：缺 id/updatedAt → null；字段类型过滤', () => {
    const valid = {
      id: 's-1',
      title: '修复登录页 bug',
      isPinned: true,
      updatedAt: 1_754_700_000_000,
      messageCount: 42,
      engineLastRunId: 'r-1',
    };
    const entry = extractSessionIndexEntry(valid) as SessionIndexEntry;
    expect(entry.id).toBe('s-1');
    expect(entry.title).toBe('修复登录页 bug');
    expect(entry.isPinned).toBe(true);
    expect(entry.messageCount).toBe(42);
    expect(entry.engineLastRunId).toBe('r-1');
    expect(extractSessionIndexEntry({ id: 's-1' })).toBeNull();
    expect(extractSessionIndexEntry({ updatedAt: 1 })).toBeNull();
    expect(
      extractSessionIndexEntry({ id: 's-1', updatedAt: 1, title: 123 })
    ).toMatchObject({
      id: 's-1',
    });
  });
});

describe('mapDeviceFrame（设备帧 kind → store 动作，M6 §3.1 分发表）', () => {
  it('events.push → mapIngestFrame 委托（preview 透传）', () => {
    const actions = mapDeviceFrame(
      pushFrame(
        { type: 'agent-start', runId: 'r-1', sessionId: 's-1' },
        { preview: true }
      )
    );
    expect(actions[0]).toMatchObject({ kind: 'feed-append', preview: true });
    expect(actions[1]).toEqual({
      kind: 'run-active',
      sessionId: 's-1',
      runId: 'r-1',
    });
  });

  it('events.push 载荷畸形 → 宽容跳过（不崩溃）', () => {
    expect(mapDeviceFrame({ kind: 'events.push', body: {} })).toEqual([
      { kind: 'ignore', reason: 'events.push 事件信封解析失败' },
    ]);
    expect(
      mapDeviceFrame({ kind: 'events.push', body: { event: 42 } })
    ).toEqual([{ kind: 'ignore', reason: 'events.push 事件信封解析失败' }]);
  });

  it('events.resume.page → feed-hydrate（事件列表 + nextAfterSequence 游标）', () => {
    const actions = mapDeviceFrame({
      kind: 'events.resume.page',
      body: {
        sessionId: 's-1',
        events: [
          { type: 'message-end', sequence: 1, sessionId: 's-1' },
          { type: 'message-end', sequence: 2, sessionId: 's-1' },
        ],
        nextAfterSequence: 2,
        hasMore: true,
      },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'feed-hydrate',
      sessionId: 's-1',
      cursor: 2,
    });
  });

  it('events.resume.done → feed-set-cursor（resumedTo）', () => {
    expect(
      mapDeviceFrame({
        kind: 'events.resume.done',
        body: { sessionId: 's-1', resumedTo: 135 },
      })
    ).toEqual([{ kind: 'feed-set-cursor', sessionId: 's-1', seq: 135 }]);
    expect(
      mapDeviceFrame({ kind: 'events.resume.done', body: { sessionId: 's-1' } })
    ).toEqual([
      { kind: 'ignore', reason: 'events.resume.done 缺 sessionId/resumedTo' },
    ]);
  });

  it('session.updated → session-upsert（会话索引广播，M6 §10.5）', () => {
    const actions = mapDeviceFrame({
      kind: 'session.updated',
      body: {
        session: {
          id: 's-1',
          title: '修复登录页 bug',
          updatedAt: 1_754_700_000_000,
        },
      },
    });
    expect(actions).toEqual([
      {
        kind: 'session-upsert',
        session: {
          id: 's-1',
          title: '修复登录页 bug',
          updatedAt: 1_754_700_000_000,
        },
      },
    ]);
  });

  it('session.removed → session-remove；session.updatedAll → sessions-refresh（对账信号）', () => {
    expect(
      mapDeviceFrame({ kind: 'session.removed', body: { sessionId: 's-1' } })
    ).toEqual([{ kind: 'session-remove', sessionId: 's-1' }]);
    expect(
      mapDeviceFrame({ kind: 'session.updatedAll', body: { version: 3 } })
    ).toEqual([{ kind: 'sessions-refresh' }]);
  });

  it('kind 全量：DEVICE_KINDS 每个 kind 不抛错（消费面外 kind 宽容跳过）', () => {
    for (const kind of DEVICE_KINDS) {
      const actions = mapDeviceFrame({ kind, body: {} });
      expect(Array.isArray(actions)).toBe(true);
      expect(actions.length).toBeGreaterThan(0);
    }
    // 消费面外 kind 显式 ignore（观测面只读，M6 §3.1 其它路由归 WsGateway）
    const outOfScope = mapDeviceFrame({
      kind: 'pair.hello',
      body: {},
    }) as StoreIngestAction[];
    expect(outOfScope[0]).toEqual({
      kind: 'ignore',
      reason: 'kind-out-of-scope:pair.hello',
    });
    expect(
      (
        mapDeviceFrame({
          kind: 'remote.getStatus',
          body: {},
        }) as StoreIngestAction[]
      )[0]
    ).toMatchObject({ kind: 'ignore' });
    expect(
      (
        mapDeviceFrame({ kind: 'heartbeat', body: {} }) as StoreIngestAction[]
      )[0]
    ).toMatchObject({ kind: 'ignore' });
    expect(
      (
        mapDeviceFrame({
          kind: 'unknown.kind' as string,
          body: {},
        }) as StoreIngestAction[]
      )[0]
    ).toMatchObject({ kind: 'ignore' });
  });
});
