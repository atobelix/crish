/**
 * 消息身份契约（中控 A1）
 *
 * 用户消息幂等键：clientMessageId（UI 发送前生成）。
 * 引擎侧 id（engineMessageId）可选映射，禁止仅靠本地 uuid 去重。
 * upsert / hydrate 合并时必须以同一稳定 id 为准，避免 stream final + 回放双气泡。
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §3.3 / §9.3
 */

/** UI 在发送前生成的客户端消息幂等键 */
export type ClientMessageId = string;

/** 引擎/协议侧消息 id（若有） */
export type EngineMessageId = string;

/** 消息身份：client 必填语义 + 可选引擎映射 */
export interface MessageIdentity {
  clientMessageId: ClientMessageId;
  engineMessageId?: EngineMessageId;
}

/** 可被 ensureClientMessageId 处理的最小消息形状 */
export interface ClientMessageIdCarrier {
  clientMessageId?: ClientMessageId | null;
}

/**
 * 从引擎/回放载荷中解析稳定消息 id 时的字段优先级。
 * clientMessageId 最高，保证与 UI 乐观消息同 id upsert。
 */
export const STABLE_MESSAGE_ID_FIELDS = [
  'clientMessageId',
  'client_message_id',
  'messageId',
  'message_id',
  'id',
] as const;

export type StableMessageIdField = (typeof STABLE_MESSAGE_ID_FIELDS)[number];

/** 可被 pickStableMessageId 扫描的最小载荷 */
export type StableMessageIdSource = Record<string, unknown> & {
  metadata?: unknown;
};

function defaultCreateClientMessageId(): ClientMessageId {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Node < 19 / 无 crypto.randomUUID 时的退化路径
  return `cmsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成新的 clientMessageId（发送路径工厂）。
 */
export function createClientMessageId(
  createId: () => string = defaultCreateClientMessageId
): ClientMessageId {
  return createId();
}

/**
 * 确保消息带有非空 clientMessageId。
 * - 已有非空字符串：原样返回，不改写
 * - 否则：生成 id，写回 `msg.clientMessageId`，并返回该 id
 */
export function ensureClientMessageId(
  msg: ClientMessageIdCarrier,
  options?: { createId?: () => string }
): ClientMessageId {
  const existing = msg.clientMessageId;
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const id = (options?.createId ?? defaultCreateClientMessageId)();
  msg.clientMessageId = id;
  return id;
}

/** 是否为非空 clientMessageId */
export function hasClientMessageId(
  msg: ClientMessageIdCarrier | null | undefined
): boolean {
  return (
    typeof msg?.clientMessageId === 'string' && msg.clientMessageId.length > 0
  );
}

/** 非空字符串 trim；否则 null */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * 从 metadata / nested promptContext 取 client 幂等键。
 * 引擎常把 UI clientMessageId 挂在 metadata，而顶层 `id` 仍是 engine uuid。
 */
function pickClientIdFromMetadata(
  source: StableMessageIdSource
): string | null {
  const meta = source.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  for (const key of [
    'clientMessageId',
    'client_message_id',
    'assistantClientMessageId',
    'assistant_client_message_id',
  ] as const) {
    const hit = nonEmptyString(m[key]);
    if (hit) return hit;
  }
  // runtime enrichMsg 可能嵌套 promptContext
  const pc = m.promptContext;
  if (pc && typeof pc === 'object' && !Array.isArray(pc)) {
    const p = pc as Record<string, unknown>;
    for (const key of [
      'assistantClientMessageId',
      'clientMessageId',
      'client_message_id',
    ] as const) {
      const hit = nonEmptyString(p[key]);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 从多种字段候选中解析稳定消息 id。
 * 优先级：
 * 1. 顶层 clientMessageId / client_message_id
 * 2. metadata(.promptContext) 内 client / assistant client 幂等键
 * 3. messageId / message_id / id（引擎 id）
 * 无候选时返回 null（调用方再填 hyd-* 等确定性回退）。
 */
export function pickStableMessageId(
  source: StableMessageIdSource | null | undefined
): string | null {
  if (!source || typeof source !== 'object') return null;

  // 1) 顶层 client 幂等键（最高）
  const topClient =
    nonEmptyString(source.clientMessageId) ??
    nonEmptyString(source.client_message_id);
  if (topClient) return topClient;

  // 2) metadata 内 client 键优先于 engine id，避免 hyd 与 assistant-msg 分裂
  const fromMeta = pickClientIdFromMetadata(source);
  if (fromMeta) return fromMeta;

  // 3) messageId / id 等引擎侧字段
  for (const key of ['messageId', 'message_id', 'id'] as const) {
    const hit = nonEmptyString(source[key]);
    if (hit) return hit;
  }
  return null;
}
