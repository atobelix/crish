// T1b 契约测：timeline-truncate / context-state / message-* 信封样例 →
// 断言 parseEngineEvent（generated 唯一解析权威）严格解析 + 未知/畸形载荷宽容跳过。
// 覆盖详案-T1-事件模型扩展 §5.2 B1/B2：mobile 主 feed 路径结构校验已接 generated parser，
// 新类型 timeline-truncate 自动获严格结构校验（default required），未知/畸形不崩溃不猜测。
// 说明：context-state 是 AgentMessage 节点的来源标记（metadata.kind），非独立事件——
// 走 message-start/end 与用户正文同源同一时间线（裁决 2），本测经 message-start 验证。
import {
  isParseOk,
  parseEngineEvent,
  parseEngineTimelineTruncateEvent,
} from '@crish/shared-types';
import { TIMELINE_TRUNCATE_REASON_VALUES } from '@crish/shared-types';
import { AGENT_MESSAGE_METADATA_KIND_VALUES } from '@crish/shared-types';
import { ENGINE_EVENT_TYPES } from '@crish/shared-types';
import {
  KNOWN_EVENT_TYPES,
  mapIngestFrame,
  parseEngineFrame,
  routeEventType,
  type StoreIngestAction,
} from '../domain/store/eventMappers';

/** 合法 timeline-truncate 信封样例（default required 全字段；详案 §1.2(a)） */
function validTimelineTruncate() {
  return {
    type: 'timeline-truncate',
    sessionId: 's-1',
    runId: 'r-1',
    sequence: 42,
    schemaVersion: 1,
    boundarySeq: 40,
    reason: 'user-requested',
    targetMessageId: 'um-7',
    timestamp: '2026-08-16T00:00:00.000Z',
  };
}

/** 携带 context-state 来源标记的 message-start 信封样例（裁决 2：非独立事件） */
function contextStateMessageStart() {
  return {
    type: 'message-start',
    sessionId: 's-1',
    runId: 'r-1',
    sequence: 44,
    schemaVersion: 1,
    message: {
      id: 'cm-1',
      role: 'user',
      createdAt: '2026-08-16T00:00:01.000Z',
      blocks: [
        {
          type: 'text',
          text: '[上下文状态] 模型已切换为 X',
        },
      ],
      metadata: { kind: 'context-state' },
    },
  };
}

describe('timeline-truncate 路由（T1b：KNOWN_EVENT_TYPES 补路由，生成面驱动）', () => {
  it('KNOWN_EVENT_TYPES 已含 timeline-truncate，路由为 feed（非会话副作用）', () => {
    expect(ENGINE_EVENT_TYPES).toContain('timeline-truncate');
    expect(KNOWN_EVENT_TYPES.has('timeline-truncate')).toBe(true);
    expect(routeEventType('timeline-truncate')).toBe('feed');
  });

  it('合法 timeline-truncate → feed-append（结构性完整入 feed）', () => {
    const actions = mapIngestFrame(validTimelineTruncate(), false);
    expect(actions[0]).toEqual({
      kind: 'feed-append',
      sessionId: 's-1',
      frame: validTimelineTruncate(),
      preview: false,
    });
  });
});

describe('parseEngineEvent 严格解析（generated 唯一解析权威）', () => {
  it('合法 timeline-truncate：默认必填全解析，reason 为规范 kebab-case', () => {
    const parsed = parseEngineEvent(validTimelineTruncate());
    expect(isParseOk(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('expected ok parse');
    // TS 判别式收窄：EngineEvent 是带 type 判别符的 tagged union，
    // 用真值守卫判 `type === "timeline-truncate"` 收敛到 EngineTimelineTruncateEvent，
    // 再访问 reason/boundarySeq 等变体字段才无 TS2339。
    if (parsed.data.type !== 'timeline-truncate') {
      throw new Error('expected timeline-truncate event');
    }
    expect(parsed.data).toMatchObject({
      boundarySeq: 40,
      targetMessageId: 'um-7',
      runId: 'r-1',
    });
    expect(TIMELINE_TRUNCATE_REASON_VALUES).toContain(parsed.data.reason);
    expect(parsed.data.reason).toBe('user-requested');
  });

  it('context-state 来源标记经 message-start 解析（裁决 2：metadata.kind 非常量集之一）', () => {
    expect(AGENT_MESSAGE_METADATA_KIND_VALUES).toContain('context-state');
    const parsed = parseEngineEvent(contextStateMessageStart());
    expect(isParseOk(parsed)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.type).toBe('message-start');
    const message = (
      parsed.data as { message?: { metadata?: { kind?: string } } }
    ).message;
    expect(message?.metadata?.kind).toBe('context-state');
  });

  it('message-* 常规样例：message-delta / message-end 严格解析仍绿（回归不破坏既有解析）', () => {
    const delta = parseEngineEvent({
      type: 'message-delta',
      sessionId: 's-1',
      runId: 'r-1',
      sequence: 45,
      schemaVersion: 1,
      timestamp: '2026-08-16T00:00:03.000Z',
      messageId: 'cm-1',
      block: { type: 'text', text: '增量' },
    });
    expect(isParseOk(delta)).toBe(true);

    const end = parseEngineEvent({
      type: 'message-end',
      sessionId: 's-1',
      runId: 'r-1',
      sequence: 46,
      schemaVersion: 1,
      message: {
        id: 'cm-1',
        role: 'assistant',
        createdAt: '2026-08-16T00:00:02.000Z',
        blocks: [{ type: 'text', text: '终态' }],
      },
    });
    expect(isParseOk(end)).toBe(true);
  });
});

describe('parseEngineEvent 宽容跳过（未知/畸形，MessageKind::Unknown 语义）', () => {
  it('未知事件 type → strict parse 失败；parseEngineFrame 返回 null；mapIngestFrame 忽略', () => {
    const unknown = { type: 'future-event-99', sessionId: 's-1' };
    const parsed = parseEngineEvent(unknown);
    expect(isParseOk(parsed)).toBe(false);
    expect(parseEngineFrame(unknown as never)).toBeNull();
    expect(mapIngestFrame(unknown as never, false)).toEqual([
      { kind: 'ignore', reason: 'unknown-event-type:future-event-99' },
    ]);
  });

  it('畸形 timeline-truncate（缺 default-required 必填字段 boundarySeq）→ over-refuse 宽容跳过，不污染 feed', () => {
    const malformed = { ...validTimelineTruncate() } as Record<string, unknown>;
    delete malformed.boundarySeq;
    const parsed = parseEngineEvent(malformed);
    expect(isParseOk(parsed)).toBe(false);

    const frame = malformed as never;
    expect(parseEngineFrame(frame)).toBeNull();
    const actions = mapIngestFrame(frame, false) as StoreIngestAction[];
    expect(actions[0]?.kind).toBe('ignore');
  });

  it('畸形 timeline-truncate（reason 非规范值）→ strict parse 失败宽容跳过', () => {
    const bad = { ...validTimelineTruncate(), reason: 'not-a-reason' };
    const parsed = parseEngineEvent(bad);
    expect(isParseOk(parsed)).toBe(false);
    expect(parseEngineFrame(bad)).toBeNull();
  });

  it('type 判别符优先于字段：parseEngineEvent 按 type 分包；parseEngineTimelineTruncateEvent 对 type 不符严格拒绝', () => {
    const mismatch = { ...validTimelineTruncate(), type: 'agent-start' };
    // parseEngineEvent 按 type 判别符分发（agent-start），相同顶层字段恰可解析
    // 成 agent-start 样例 → 走 agent-start 分包；此处语义是「判别符是唯一 router」。
    const routed = parseEngineEvent(mismatch);
    expect(isParseOk(routed)).toBe(true);
    if (routed.ok) expect(routed.data.type).toBe('agent-start');
    // 而逐事件分包严格锁 type：直接调 timeline-truncate 分包对 type 不符拒绝
    const direct = parseEngineTimelineTruncateEvent(mismatch);
    expect(isParseOk(direct)).toBe(false);
  });
});
