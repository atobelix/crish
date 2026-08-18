// 事件消费映射（F1 §2.5 矩阵 / F3 §2 分类 → store 动作）：纯函数、可单测
// 输入 = events.push.body.event 的 AgentEventEnvelope 扁平 JSON（M6 §10.5）或设备帧（WsGateway 分发产物）
// 职责：type → ingest 路由表；未知 type 宽容跳过（对齐 MessageKind::Unknown 语义，
//       crates/conex-types/src/device/envelope.rs:164-206：未登记 kind → Unknown 兜底不崩溃）。
// T1b 统一输入流收敛战役：timeline-truncate 路由 + parseEngineEvent 严格解析（未知/畸形宽容跳过），
//       generated 唯一解析权威（详案 T1b / T3）——新类型自动获严格结构校验。
import { ENGINE_EVENT_TYPES } from '@crish/shared-types';
import {
  isParseOk,
  parseEngineEvent,
} from '@crish/shared-types';
import type { EngineEvent } from '@crish/shared-types';
import type { SessionIndexEntry } from '@crish/shared-types';
import {
  readBool,
  readNumber,
  readRecord,
  readString,
  type EventEnvelopeFrame,
} from './eventReducers';

// ── store 动作路由结果（接线层据此调用 eventStore / sessionStore） ──

export type StoreIngestAction =
  | {
      kind: 'feed-append';
      sessionId: string;
      frame: EventEnvelopeFrame;
      preview: boolean;
    }
  | {
      kind: 'feed-hydrate';
      sessionId: string;
      events: EventEnvelopeFrame[];
      cursor: number;
    }
  | { kind: 'feed-set-cursor'; sessionId: string; seq: number }
  | { kind: 'session-upsert'; session: SessionIndexEntry }
  | { kind: 'session-remove'; sessionId: string }
  | { kind: 'sessions-refresh' }
  | { kind: 'run-active'; sessionId: string; runId: string }
  | { kind: 'run-terminal'; sessionId: string; runId: string; terminal: string }
  | { kind: 'approval-delta'; sessionId: string; delta: 1 | -1 }
  | { kind: 'ignore'; reason: string };

// ── 事件 type → ingest 路由表（F1 §2.5「实+刷+落」列；生成面 ENGINE_EVENT_TYPES 驱动全量断言） ──

export type EventRoute =
  /** 仅入 feed（全部已知事件的默认路由，F3 §2.12 展示型 + 通知型 + 忽略型统一入 feed 由渲染层分级） */
  | 'feed'
  /** agent-start：feed + 会话活动 run 标记（F1 §2.5 F03 活动任务新增） */
  | 'run-active'
  /** run-terminal：feed + 活动 run 清除（F1 §2.5 F03 移除） */
  | 'run-terminal'
  /** approval-requested：feed + 待审批计数 +1（F1 §5.3 / §2.5 落） */
  | 'approval-plus'
  /** approval-resolved：feed + 待审批计数 −1（F1 §5.3 落） */
  | 'approval-minus';

/** 会话级副作用路由（F1 §2.5 矩阵「落/刷」列；其余 45 类事件仅入 feed） */
const SESSION_SIDE_ROUTES: Readonly<Record<string, EventRoute>> = {
  'agent-start': 'run-active',
  'run-terminal': 'run-terminal',
  'approval-requested': 'approval-plus',
  'approval-resolved': 'approval-minus',
};

// 全量路由表：以生成面事件 type 列表为驱动（F3 §8.4 防漂移护栏同构——
// 新增事件 type 自动入表；测试断言每 type 有明确路由 + 特殊路由清单与 F1 §2.5 一致）
export const EVENT_ROUTES: Readonly<Record<string, EventRoute>> =
  Object.fromEntries(
    ENGINE_EVENT_TYPES.map((type) => [
      type,
      SESSION_SIDE_ROUTES[type] ?? 'feed',
    ])
  ) as Record<string, EventRoute>;

/** 已知事件 type 集合（feed 入站白名单数据面） */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(
  ENGINE_EVENT_TYPES
);

/** type → 路由（未知 type → null：宽容跳过，MessageKind::Unknown 语义） */
export function routeEventType(type: string): EventRoute | null {
  return EVENT_ROUTES[type] ?? null;
}

// ── parseEngineEvent 唯一解析权威（详案 T1b / T3：generated 严格解析） ──

/**
 * 事件信封 → `parseEngineEvent` 严格结构解析（generated 唯一解析权威，
 * 对齐 approvalWiring.ts 既有先例，M5 §1.4 走生成面）。
 * 返回解析后的 `EngineEvent`；未知 type / 畸形载荷 / 缺必填字段 → `null`
 * （宽容跳过，MessageKind::Unknown 语义，不崩溃不猜测——M6 §10.5）。
 * 新增事件 type 自动获严格结构校验，无需手写第 N 套解析。
 */
export function parseEngineFrame(
  frame: EventEnvelopeFrame
): EngineEvent | null {
  const parsed = parseEngineEvent(frame);
  return isParseOk(parsed) ? parsed.data : null;
}

// ── 信封解析（宽容：扁平 JSON 校验 type/sessionId，保留原对象引用不复制载荷） ──

/**
 * 事件信封提取：校验 type/sessionId 后返回**原对象引用**（事件体字段平铺在顶层，
 * 原样保留供 feed 渲染；不复制契约字段，M5 §1.3 组合纪律）。解析失败 → null（宽容跳过）。
 */
export function extractEnvelope(
  v: unknown,
  fallbackSessionId?: string
): EventEnvelopeFrame | null {
  const obj = readRecord(v);
  if (!obj) return null;
  const type = obj['type'];
  const sessionId = obj['sessionId'] ?? fallbackSessionId;
  if (typeof type !== 'string' || typeof sessionId !== 'string') return null;
  return obj as unknown as EventEnvelopeFrame;
}

/** 会话索引条目提取（session.updated 载荷；缺 id/updatedAt → null 宽容跳过） */
export function extractSessionIndexEntry(v: unknown): SessionIndexEntry | null {
  const obj = readRecord(v);
  if (!obj) return null;
  const id = obj['id'];
  const updatedAt = obj['updatedAt'];
  if (typeof id !== 'string' || typeof updatedAt !== 'number') return null;
  const entry: SessionIndexEntry = { id, updatedAt };
  for (const key of ['title', 'folder', 'timestamp'] as const) {
    const value = obj[key];
    if (typeof value === 'string') entry[key] = value;
  }
  for (const key of ['isPinned', 'isArchived', 'hydratedFromEngine'] as const) {
    const value = obj[key];
    if (typeof value === 'boolean') entry[key] = value;
  }
  for (const key of ['messageCount', 'engineCursor'] as const) {
    const value = obj[key];
    if (typeof value === 'number') entry[key] = value;
  }
  const engineLastRunId = obj['engineLastRunId'];
  if (typeof engineLastRunId === 'string')
    entry.engineLastRunId = engineLastRunId;
  return entry;
}

// ── 事件信封 → store 动作 ────────────────────────────────────────────────

/**
 * 事件信封 → store 动作（type → ingest 路由表；未知 type 宽容跳过）：
 * - 全部已知类型：feed-append（preview 透传，M6 §10.5）；
 * - 会话级副作用（F1 §2.5「落/刷」列）：agent-start → run-active、
 *   run-terminal → run-terminal、approval-requested/resolved → approval-delta；
 * - 未知 type → ignore（MessageKind::Unknown 语义，不崩溃不猜测）。
 */
export function mapIngestFrame(
  frame: EventEnvelopeFrame,
  preview: boolean
): StoreIngestAction[] {
  const route = routeEventType(frame.type);
  if (route === null) {
    return [{ kind: 'ignore', reason: `unknown-event-type:${frame.type}` }];
  }
  // T1b：timeline-truncate 为 default-required 语义关键事件（R1 撤回出站）。
  // parseEngineEvent 严格解析 → 结构性完整才入 feed；未知/畸形载荷（缺任一
  // 必填字段 boundarySeq/reason/targetMessageId/... 或 type 不符）宽容跳过，
  // 拒畸形入 feed，避免污染 R1 撤回重放基准（详案 T1 决定 3 over-refuse）。
  if (frame.type === 'timeline-truncate' && parseEngineFrame(frame) === null) {
    return [
      {
        kind: 'ignore',
        reason:
          'timeline-truncate:parseEngineEvent strict-parse failed (malformed/unknown, lenient skip)',
      },
    ];
  }
  const actions: StoreIngestAction[] = [
    { kind: 'feed-append', sessionId: frame.sessionId, frame, preview },
  ];
  switch (route) {
    case 'run-active': {
      // 信封 runId（emit 层注入）；数据面/缺失 runId 无法维护活动标记，仅入 feed
      const runId = readString(frame, 'runId');
      if (runId) {
        actions.push({ kind: 'run-active', sessionId: frame.sessionId, runId });
      }
      break;
    }
    case 'run-terminal': {
      // 信封与事件体 runId 一致（events.rs:1105-1107 注入值覆盖事件字段）；terminal 三态透传
      const runId = readString(frame, 'runId');
      if (runId) {
        actions.push({
          kind: 'run-terminal',
          sessionId: frame.sessionId,
          runId,
          terminal: readString(frame, 'terminal') ?? 'unknown',
        });
      }
      break;
    }
    case 'approval-plus':
      actions.push({
        kind: 'approval-delta',
        sessionId: frame.sessionId,
        delta: 1,
      });
      break;
    case 'approval-minus':
      actions.push({
        kind: 'approval-delta',
        sessionId: frame.sessionId,
        delta: -1,
      });
      break;
    default:
      break;
  }
  return actions;
}

// ── 设备帧（kind 分发表，M6 §3.1）→ store 动作 ───────────────────────────

export interface DeviceFrameInput {
  /** M6 §3.1 kind（DEVICE_KINDS；未知 kind 宽容跳过） */
  kind: string;
  body: unknown;
}

/**
 * 设备帧 → store 动作（观测面消费子集，M6 §3.1 分发表）：
 * - events.push / events.resume.page / events.resume.done → feed 面；
 * - session.updated / session.removed / session.updatedAll → 会话面；
 * - 其余 kind（pair 域、auth 域、device 域、remote 域、result 域、stream 域、heartbeat、error）
 *   不属观测面 store 消费面（WsGateway 其它路由，M5 §1.4）→ 宽容跳过。
 */
export function mapDeviceFrame(input: DeviceFrameInput): StoreIngestAction[] {
  switch (input.kind) {
    case 'events.push': {
      const body = readRecord(input.body);
      const frame = extractEnvelope(
        body?.['event'],
        readString(body, 'sessionId')
      );
      if (!frame) {
        return [{ kind: 'ignore', reason: 'events.push 事件信封解析失败' }];
      }
      return mapIngestFrame(frame, readBool(body, 'preview'));
    }
    case 'events.resume.page': {
      const body = readRecord(input.body);
      const sessionId = readString(body, 'sessionId');
      const cursor = readNumber(body, 'nextAfterSequence');
      if (!sessionId || cursor === undefined) {
        return [
          {
            kind: 'ignore',
            reason: 'events.resume.page 缺 sessionId/nextAfterSequence',
          },
        ];
      }
      const events = readRecord(body)?.['events'];
      const frames: EventEnvelopeFrame[] = Array.isArray(events)
        ? events
            .map((e) => extractEnvelope(e, sessionId))
            .filter((f): f is EventEnvelopeFrame => f !== null)
        : [];
      return [{ kind: 'feed-hydrate', sessionId, events: frames, cursor }];
    }
    case 'events.resume.done': {
      const body = readRecord(input.body);
      const sessionId = readString(body, 'sessionId');
      const resumedTo = readNumber(body, 'resumedTo');
      if (!sessionId || resumedTo === undefined) {
        return [
          {
            kind: 'ignore',
            reason: 'events.resume.done 缺 sessionId/resumedTo',
          },
        ];
      }
      return [{ kind: 'feed-set-cursor', sessionId, seq: resumedTo }];
    }
    case 'session.updated': {
      const session = extractSessionIndexEntry(
        readRecord(readRecord(input.body)?.['session'])
      );
      if (!session) {
        return [{ kind: 'ignore', reason: 'session.updated 载荷解析失败' }];
      }
      return [{ kind: 'session-upsert', session }];
    }
    case 'session.removed': {
      const sessionId = readString(readRecord(input.body), 'sessionId');
      if (!sessionId) {
        return [{ kind: 'ignore', reason: 'session.removed 缺 sessionId' }];
      }
      return [{ kind: 'session-remove', sessionId }];
    }
    case 'session.updatedAll':
      // 索引代数刷新信号（M6 §10.5）：列表全量拉取由接线层 repository 执行
      return [{ kind: 'sessions-refresh' }];
    default:
      return [{ kind: 'ignore', reason: `kind-out-of-scope:${input.kind}` }];
  }
}
