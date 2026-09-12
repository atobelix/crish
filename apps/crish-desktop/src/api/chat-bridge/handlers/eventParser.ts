/**
 * 事件解析单一入口（T7：双 zod 合并）。
 *
 * 解析顺序：
 * 1. 优先 T6 生成解析器 parseEngineEvent（严格契约，载荷完整时直出具体信封类型）；
 * 2. 生成解析器覆盖不了的前端宽容形态（缺 sessionId/timestamp 等信封字段、
 *    历史别名 text-delta / run-completed / run-failed / run-cancelled、
 *    数据面 task 系与 timer、cron、security-audit 形状漂移）由
 *    本文件及领域子模块的宽容归一器兜底，全部收敛在本单一入口；
 * 3. 信封级遗留事件（subagent-* / error）以 legacy 信封直出；
 * 4. 其余一律 parseErr，由 EventRouter 显式登记 unknown-case（可观测，不静默吞）。
 *
 * resolveEventType 为纯信封类型抽取（type/event/kind 别名），供 onMsg 预过滤使用。
 * parseResolvedEvent 为已解析信封的解析入口（D6.1）：调用方若已持有
 * resolveEventType 结果，可直接传入避免二次 resolve。
 */
import {
  parseEngineEvent,
  parseOk,
  parseErr,
  type ParseResult,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type {
  EngineEventType,
  EngineEvent,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type { Normalizer } from './eventParserShared';
import { CORE_NORMALIZERS } from './eventParserCore';
import { DIAGNOSTIC_NORMALIZERS } from './eventParserDiagnostics';
import { TASK_NORMALIZERS } from './eventParserTask';
import { CONTINUITY_NORMALIZERS } from './eventParserContinuity';

export type { Normalizer } from './eventParserShared';

export type LegacyEventType =
  'subagent-started' | 'subagent-event' | 'subagent-ended' | 'error';

export const LEGACY_EVENT_TYPES: readonly LegacyEventType[] = [
  'subagent-started',
  'subagent-event',
  'subagent-ended',
  'error',
];

export interface EngineEnvelope<ET extends EngineEventType = EngineEventType> {
  kind: 'engine';
  type: ET;
  /** 原始 type 字段（宽容归一前的别名，如 run-cancelled），供 handler 区分行为 */
  originalType: string;
  event: Extract<EngineEvent, { type: ET }>;
  raw: Record<string, unknown>;
}

export interface LegacyEnvelope {
  kind: 'legacy';
  type: LegacyEventType;
  raw: Record<string, unknown>;
}

export type BridgeEventEnvelope =
  EngineEnvelope<EngineEventType> | LegacyEnvelope;

/** resolveEventType 返回的已解析信封形状（D6.1 共享 envelope） */
export interface ResolvedEventEnvelope {
  type: string;
  raw: Record<string, unknown>;
}

/** 纯信封类型抽取：type/event/kind 别名，trim 后返回；非对象/空 type 返回 null */
export function resolveEventType(
  event: unknown
): ResolvedEventEnvelope | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const raw = event as Record<string, unknown>;
  const type = String(raw.type ?? raw.event ?? raw.kind ?? '').trim();
  if (!type) return null;
  return { type, raw };
}

/**
 * 宽容归一器表（T-F 06 T4.1：键集与生成类型由
 * eventParser.normalizer-drift.test.ts 双向锁定——新增事件类型缺归一器即红）。
 */
export const ENGINE_NORMALIZERS: Record<string, Normalizer> = {
  ...CORE_NORMALIZERS,
  ...DIAGNOSTIC_NORMALIZERS,
  ...TASK_NORMALIZERS,
  ...CONTINUITY_NORMALIZERS,
};

function isLegacyEventType(type: string): type is LegacyEventType {
  return (LEGACY_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 单一解析入口（已解析信封版，D6.1）：入参为 resolveEventType 已产出的
 * `{ type, raw }`，不再二次 resolve——dataPlaneRouter / EventRouter 共享此入口。
 */
export function parseResolvedEvent(
  envelope: ResolvedEventEnvelope
): ParseResult<BridgeEventEnvelope> {
  const raw = envelope.raw;
  const type = envelope.type;

  const engine = parseEngineEvent(raw);
  if (engine.ok) {
    return parseOk({
      kind: 'engine',
      type: engine.data.type,
      originalType: type,
      event: engine.data,
      raw,
    });
  }

  const normalizer = ENGINE_NORMALIZERS[type];
  if (normalizer) {
    const event = normalizer(raw, type);
    if (event) {
      return parseOk({
        kind: 'engine',
        type: event.type,
        originalType: type,
        event,
        raw,
      });
    }
  }

  if (isLegacyEventType(type)) {
    return parseOk({ kind: 'legacy', type, raw });
  }

  return parseErr(engine.error || `unknown engine event type '${type}'`);
}

/** 单一解析入口：返回已收窄的分派信封；未知形态 parseErr（由调用方登记） */
export function parseBridgeEvent(
  input: unknown
): ParseResult<BridgeEventEnvelope> {
  const envelope = resolveEventType(input);
  if (!envelope) {
    return parseErr('engine event is not an object or missing type');
  }
  return parseResolvedEvent(envelope);
}
