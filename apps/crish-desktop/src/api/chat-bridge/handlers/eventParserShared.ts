/**
 * 事件解析共享辅助与类型定义（T7）。
 */
import type {
  EngineEvent,
  ToolCategory,
  ToolConcurrency,
  AgentMessage,
  AgentMessageBlock,
  AgentMessageBlockToolCall,
  AgentMessageBlockToolResult,
  RunTerminalStatus,
  ToolBatchCall,
  ToolBatchResult,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
} from '../../../../../../packages/shared-types/src/generated/engine';
import type { JsonValue } from '../../../../../../packages/shared-types/src/primitive-types';
import { blockText } from './eventUtils';
import { logInternalError } from '../../userFacingErrors';

export type Normalizer = (
  raw: Record<string, unknown>,
  type: string
) => EngineEvent | null;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 宽容路径深度守卫（T-F 06 T4.4）：对齐生成 parser 的 256 层常量语义
 * （packages/shared-types/src/generated/engine/parser.ts:65-100，`depth > 256`
 * 拒绝）——宽容归一器透传自由 JSON（tool-call input / tool-result output /
 * message block）前先做深度检查，超限返回 true（调用方记可观测日志并回退），
 * 不依赖 EventRouter 顶层 try/catch 兜底（EventRouter.ts:109-115）。
 */
export const MAX_JSON_DEPTH = 256;

export function jsonDepthExceeds(
  v: unknown,
  budget: number = MAX_JSON_DEPTH
): boolean {
  if (budget < 0) return true;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (jsonDepthExceeds(item, budget - 1)) return true;
    }
    return false;
  }
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (jsonDepthExceeds(o[key], budget - 1)) return true;
  }
  return false;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export function isToolCategory(v: unknown): v is ToolCategory {
  return (
    typeof v === 'string' &&
    (
      [
        'terminal',
        'filesystem',
        'network',
        'mcp',
        'skill',
        'agent',
        'internal',
      ] as const
    ).includes(v as ToolCategory)
  );
}

export function isToolConcurrency(v: unknown): v is ToolConcurrency {
  return (
    typeof v === 'string' &&
    (['parallel', 'sequential', 'exclusive'] as const).includes(
      v as ToolConcurrency
    )
  );
}

/**
 * 工具分类宽容取值（T-F 06 T4.3 显式化）：合法值直通；未知/缺失 → 登记日志
 * 后回退 'terminal'（不再静默降级——Rust 新枚举值进兜底可观测）。
 * 非安全向：此处仅影响 UI 分类图标/分组，回退不改变安全语义。
 */
export function toolCategoryOr(v: unknown): ToolCategory {
  if (isToolCategory(v)) return v;
  logInternalError(
    'engine-protocol',
    `未知 tool category '${String(v)}'，回退 terminal`
  );
  return 'terminal';
}

export function emptyAgentMessage(): AgentMessage {
  return { id: '', role: 'assistant', createdAt: '', blocks: [] };
}

export function emptyCheckpointRecord(): RuntimeCheckpointRecord {
  return {
    id: '',
    kind: 'workspace-checkpoint',
    label: '',
    toolCallId: '',
    toolName: '',
  };
}

export function emptyCheckpointRestoreRecord(): RuntimeCheckpointRestoreRecord {
  return {
    checkpointId: '',
    toolCallId: '',
    toolName: '',
    restored: [],
    deleted: [],
    skipped: [],
  };
}

/**
 * 事件体附加信封注入的 runId（可选）：Rust 三缓存事件的变体体不占 runId
 * 字段，由信封扁平化注入（raw 顶层同名键）；宽容归一时一并读入，
 * wire 层值与信封注入值天然一致（同一来源），老帧缺失时省略。
 */
export function withEnvelopeRunId<E extends EngineEvent>(
  event: E,
  raw: Record<string, unknown>
): E {
  const runId = str(raw.runId);
  return runId ? Object.assign(event, { runId }) : event;
}

/** 双形态取值：camelCase 优先、snake_case 兜底（风格对齐 backgroundTasksApi 双容错） */
export function alt(
  raw: Record<string, unknown>,
  camel: string,
  snake: string
): unknown {
  const v = raw[camel];
  return v !== undefined ? v : raw[snake];
}

/** 日志尾部容错：字符串按单元素数组收窄，数组过滤字符串元素，其余空数组 */
export function tailArray(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  return strArray(v);
}

/** 资源快照宽容读取：JSON 可序列化值直通，畸形/缺失回退空对象 */
export function normalizeResource(v: unknown): JsonValue {
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return v as JsonValue;
  }
  if (Array.isArray(v) || isRecord(v)) return v as JsonValue;
  return {};
}

/** message-delta 的宽容 block 归一：text/thought 直读，tool-call/tool-result 原样透传，未知按 text 取 text/content */
export function normalizeDeltaBlock(b: unknown): AgentMessageBlock {
  if (!isRecord(b)) return { type: 'text', text: '' };
  // T-F 06 T4.4：宽容路径深度守卫（对齐生成 parser 256 层语义）——
  // 超限返回可识别失败（空 text 块 + 日志），不依赖 EventRouter 顶层 catch。
  if (jsonDepthExceeds(b)) {
    logInternalError(
      'engine-protocol',
      'normalizeDeltaBlock 载荷超 256 层深度，回退空 text 块'
    );
    return { type: 'text', text: '' };
  }
  const kind = String(b.type ?? b.kind ?? '').trim();
  if (kind === 'thought') {
    const block: AgentMessageBlock = {
      type: 'thought',
      text: blockText(b),
      ...(b.redacted === true ? { redacted: true } : {}),
    };
    return block;
  }
  if (kind === 'tool-call') {
    return {
      type: 'tool-call',
      id: str(b.id ?? b.toolCallId),
      toolName: str(b.toolName ?? b.name),
      input: (b.input ?? {}) as AgentMessageBlockToolCall['input'],
    };
  }
  if (kind === 'tool-result') {
    return {
      type: 'tool-result',
      toolCallId: str(b.toolCallId ?? b.id),
      toolName: str(b.toolName ?? b.name),
      output: (b.output ?? {}) as AgentMessageBlockToolResult['output'],
      isError: b.isError === true,
    };
  }
  return { type: 'text', text: blockText(b) };
}

/** run-terminal 家族（含别名）宽容归一：terminal 拼写变体与来源 type 推断 */
export function normalizeRunTerminal(
  raw: Record<string, unknown>,
  sourceType: string
): EngineEvent {
  const rawTerm = String(raw.terminal ?? '')
    .trim()
    .toLowerCase();
  let terminal: RunTerminalStatus;
  if (rawTerm === 'failed' || rawTerm === 'error') terminal = 'failed';
  else if (rawTerm === 'cancelled' || rawTerm === 'canceled')
    terminal = 'cancelled';
  else if (rawTerm === 'completed') terminal = 'completed';
  else if (sourceType === 'run-failed') terminal = 'failed';
  else if (sourceType === 'run-cancelled') terminal = 'cancelled';
  else {
    // T-F 06 T4.3：非安全向静默默认显式化——未知 terminal 不再静默降级
    // completed（Rust 新枚举值会被吞掉且不可观测），登记日志后回退。
    // 消费方宽容度：run-terminal 是前端硬依赖（terminal 字段必须为规范值），
    // 保留原始值会破坏生成类型消费，故回退 completed + 显式登记。
    logInternalError(
      'engine-protocol',
      `normalizeRunTerminal 未知 terminal '${rawTerm}'（来源 ${sourceType}），回退 completed`
    );
    terminal = 'completed';
  }
  const error =
    typeof raw.error === 'string'
      ? raw.error
      : typeof raw.message === 'string'
        ? raw.message
        : undefined;
  return {
    type: 'run-terminal',
    sessionId: str(raw.sessionId),
    runId: str(raw.runId),
    timestamp: str(raw.timestamp),
    terminal,
    ...(error ? { error } : {}),
  };
}

/**
 * tool-batch-start 的宽容 calls 抽取：从原始 payload 保留批内调用，不硬编码空数组。
 * 逐项宽容（id/toolCallId 别名、category/concurrency 默认值，语义对齐 tool-start 归一器）；
 * 原始 payload 无 calls 数组时返回 null（调用方记可观测日志后回退空数组）。
 */
export function normalizeBatchCalls(rawCalls: unknown): ToolBatchCall[] | null {
  if (!Array.isArray(rawCalls)) return null;
  // T-F 06 T4.4：宽容路径深度守卫（对齐生成 parser 256 层语义）——
  // 超限返回 null（调用方记可观测日志后回退空数组），不依赖顶层 catch。
  if (jsonDepthExceeds(rawCalls)) {
    logInternalError(
      'engine-protocol',
      'normalizeBatchCalls 载荷超 256 层深度，回退空批'
    );
    return null;
  }
  return rawCalls.map((c) => {
    const r = isRecord(c) ? c : {};
    return {
      id: str(r.id ?? r.toolCallId),
      toolName: str(r.toolName ?? r.name),
      summary: str(r.summary),
      input: (r.input ?? r.parameters ?? {}) as ToolBatchCall['input'],
      category: toolCategoryOr(r.category),
      concurrency: isToolConcurrency(r.concurrency)
        ? r.concurrency
        : 'sequential',
    };
  });
}

/**
 * tool-batch-end 的宽容 calls 抽取：从原始 payload 保留批内结果，不硬编码空数组。
 * 逐项宽容（toolCallId/id 别名、output 字符串归一、isError 真值判定，语义对齐 tool-end 归一器）；
 * 原始 payload 无 calls 数组时返回 null（调用方记可观测日志后回退空数组）。
 */
export function normalizeBatchResults(
  rawCalls: unknown
): ToolBatchResult[] | null {
  if (!Array.isArray(rawCalls)) return null;
  return rawCalls.map((c) => {
    const r = isRecord(c) ? c : {};
    const output =
      typeof r.output === 'string'
        ? { text: r.output }
        : isRecord(r.output)
          ? (r.output as unknown as ToolBatchResult['output'])
          : {};
    return {
      id: str(r.toolCallId ?? r.id ?? r.tool_call_id),
      toolName: str(r.toolName ?? r.name),
      output,
      isError: r.isError === true || (r.error != null && r.error !== false),
      durationMs: num(r.durationMs) ?? 0,
    };
  });
}
