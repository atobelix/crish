/**
 * Conex Canonical Event Model
 *
 * 统一事件架构的核心：所有事件在产生时即映射�?Canonical 格式�? * 每层只做 Canonical <-> 层特定格�?的双向转换，禁止层间直接转换�? *
 * 设计原则�? * 1. 单一真相源：Canonical Event 是事件的唯一定义
 * 2. 双向转换：每层有独立�?Adapter，只负责 Canonical <-> 层格�? * 3. 事件溯源：每个事件携�?traceId / spanId / causationId
 * 4. 诊断友好：每个事件可附带 Diagnostic 信息
 * 5. Schema 校验：通过 Registry 校验事件格式，防止漂�? */

// ─── Canonical Event 核心类型 ──────────────────────────────

/**
 * 事件领域分类
 */
export type ConexEventDomain =
  | "conversation"   // 对话消息相关
  | "tool"           // 工具调用相关
  | "approval"       // 审批流程相关
  | "session"        // 会话管理相关
  | "provider"       // Provider 通信相关
  | "checkpoint"     // 检查点/快照相关
  | "goal"           // Goal Run 相关
  | "lifecycle"      // 生命周期状态转换
  | "diagnostic"     // 诊断信息
  | "background"     // 后台任务
  | "rendering"      // 渲染管线
  | "test";          // 测试专用

/**
 * 事件来源�? */
export type ConexEventSourceLayer =
  | "runtime"
  | "orchestrator"
  | "daemon"
  | "workbench";

/**
 * 诊断信息
 */
export interface ConexDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  detail?: unknown | undefined;
}

/**
 * Canonical Event - 事件的统一表示
 *
 * 所有层的事件在跨层传输时必须转换为此格式�? * 每个事件携带完整的追踪信息，支持端到端追踪�? */
export interface ConexCanonicalEvent {
  // ─── 身份 ───────────────────────────────────────────
  /** 全局唯一事件 ID */
  eventId: string;
  /** 端到端追�?ID（从用户操作到最�?UI 渲染�?*/
  traceId: string;
  /** 当前跨度 ID */
  spanId: string;

  // ─── 来源 ───────────────────────────────────────────
  /** 产生此事件的层 */
  sourceLayer: ConexEventSourceLayer;
  /** 来源状态机类型（如果事件由状态机转移产生） */
  sourceMachineType?: string | undefined;
  /** 来源状态机实例 ID */
  sourceMachineId?: string | undefined;

  // ─── 时间 ───────────────────────────────────────────
  /** 事件发生时间（ISO 8601） */
  occurredAt: string;
  /** 处理层接收时间（ISO 8601） */
  receivedAt?: string | undefined;

  // ─── 分类 ───────────────────────────────────────────
  /** 事件领域 */
  domain: ConexEventDomain;
  /** 领域内的事件类型 */
  eventType: string;

  // ─── 载荷 ───────────────────────────────────────────
  /** 事件数据 */
  payload: unknown;

  // ─── 关联 ───────────────────────────────────────────
  /** 关联的请求/操作 ID */
  correlationId?: string | undefined;
  /** 导致此事件的上一个事件 ID（因果链） */
  causationId?: string | undefined;

  // ─── 诊断 ───────────────────────────────────────────
  diagnostics?: ConexDiagnostic[] | undefined;
}

// ─── Adapter 接口 ─────────────────────────────────────────

/**
 * 事件适配器接�? *
 * 每层实现此接口，负责 Canonical <-> 层特定格�?的双向转换�? * 新增事件类型时，只需在对�?Adapter 中增加映射，
 * 编译器通过 exhaustive check 提示遗漏�? */
export interface ConexCanonicalAdapter<TLayerEvent> {
  /** 将层特定事件转换�?Canonical 格式 */
  toCanonical(event: TLayerEvent, context: AdapterContext): ConexCanonicalEvent;
  /** �?Canonical 格式转换为层特定事件 */
  fromCanonical(canonical: ConexCanonicalEvent): TLayerEvent;
}

/**
 * Adapter 上下文，提供转换时需要的额外信息
 */
export interface AdapterContext {
  traceId: string;
  spanId: string;
  sessionId: string;
  runId?: string | undefined;
  causationId?: string | undefined;
}

// ─── Event Schema Registry ────────────────────────────────

/**
 * 事件 Schema 校验结果
 */
export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

export interface SchemaValidationError {
  domain: string;
  eventType: string;
  path: string;
  message: string;
  expected?: string | undefined;
  received?: string | undefined;
}

/**
 * 事件 Schema 定义
 */
export interface EventSchemaDefinition {
  domain: string;
  eventType: string;
  requiredFields: string[];
  fieldTypes: Record<string, string>;
  description?: string | undefined;
}

/**
 * Event Schema Registry
 *
 * 注册和校验所�?Canonical Event 的格式�? * 运行时可查询，防止格式漂移�? */
export class EventSchemaRegistry {
  private schemas = new Map<string, EventSchemaDefinition>();

  /**
   * 注册事件 Schema
   */
  register(schema: EventSchemaDefinition): void {
    const key = this.schemaKey(schema.domain, schema.eventType);
    this.schemas.set(key, schema);
  }

  /**
   * 批量注册
   */
  registerAll(schemas: EventSchemaDefinition[]): void {
    for (const schema of schemas) {
      this.register(schema);
    }
  }

  /**
   * 校验事件是否符合注册�?Schema
   */
  validate(event: ConexCanonicalEvent): SchemaValidationResult {
    const key = this.schemaKey(event.domain, event.eventType);
    const schema = this.schemas.get(key);

    if (!schema) {
      return {
        valid: false,
        errors: [{
          domain: event.domain,
          eventType: event.eventType,
          path: "",
          message: `No schema registered for ${event.domain}/${event.eventType}`,
          expected: "registered schema",
          received: "unregistered"
        }]
      };
    }

    const errors: SchemaValidationError[] = [];

    // 检查必需字段
    for (const field of schema.requiredFields) {
      if (getNestedValue(event, field) === undefined) {
        errors.push({
          domain: event.domain,
          eventType: event.eventType,
          path: field,
          message: `Required field "${field}" is missing`,
          expected: schema.fieldTypes[field],
          received: "undefined"
        });
      }
    }

    // 检查字段类型
    for (const [field, expectedType] of Object.entries(schema.fieldTypes)) {
      const value = getNestedValue(event, field);
      if (value !== undefined && !checkType(value, expectedType)) {
        errors.push({
          domain: event.domain,
          eventType: event.eventType,
          path: field,
          message: `Field "${field}" has wrong type`,
          expected: expectedType,
          received: typeof value
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 获取指定领域/类型�?Schema
   */
  getSchema(domain: string, eventType: string): EventSchemaDefinition | undefined {
    return this.schemas.get(this.schemaKey(domain, eventType));
  }

  /**
   * 列出所有已注册的领�?   */
  listDomains(): string[] {
    const domains = new Set<string>();
    for (const schema of this.schemas.values()) {
      domains.add(schema.domain);
    }
    return [...domains];
  }

  /**
   * 列出指定领域的所有事件类�?   */
  listEventTypes(domain: string): string[] {
    const types: string[] = [];
    for (const schema of this.schemas.values()) {
      if (schema.domain === domain) {
        types.push(schema.eventType);
      }
    }
    return types;
  }

  private schemaKey(domain: string, eventType: string): string {
    return `${domain}:${eventType}`;
  }
}

// ─── Canonical Event 工厂 ─────────────────────────────────

/**
 * 创建 Canonical Event 的工厂函�? */
export function createCanonicalEvent(options: {
  domain: ConexEventDomain;
  eventType: string;
  payload: unknown;
  context: AdapterContext;
  sourceLayer: ConexEventSourceLayer;
  sourceMachineType?: string | undefined;
  sourceMachineId?: string | undefined;
  diagnostics?: ConexDiagnostic[] | undefined;
}): ConexCanonicalEvent {
  return {
    eventId: createEventId(),
    traceId: options.context.traceId,
    spanId: options.context.spanId,
    sourceLayer: options.sourceLayer,
    sourceMachineType: options.sourceMachineType,
    sourceMachineId: options.sourceMachineId,
    occurredAt: new Date().toISOString(),
    domain: options.domain,
    eventType: options.eventType,
    payload: options.payload,
    correlationId: options.context.runId,
    causationId: options.context.causationId,
    diagnostics: options.diagnostics
  };
}

// ─── 内置 Schema 定义 ─────────────────────────────────────

/**
 * Runtime 层核心事件的 Schema 定义
 */
export const RUNTIME_EVENT_SCHEMAS: EventSchemaDefinition[] = [
  {
    domain: "conversation",
    eventType: "agent-start",
    requiredFields: ["payload.sessionId"],
    fieldTypes: { "payload.sessionId": "string" },
    description: "Agent run started"
  },
  {
    domain: "conversation",
    eventType: "agent-end",
    requiredFields: ["payload.sessionId", "payload.reason"],
    fieldTypes: { "payload.sessionId": "string", "payload.reason": "string" },
    description: "Agent run ended"
  },
  {
    domain: "conversation",
    eventType: "turn-start",
    requiredFields: ["payload.sessionId", "payload.turnIndex"],
    fieldTypes: { "payload.sessionId": "string", "payload.turnIndex": "number" },
    description: "Turn started"
  },
  {
    domain: "conversation",
    eventType: "turn-end",
    requiredFields: ["payload.sessionId", "payload.turnIndex"],
    fieldTypes: { "payload.sessionId": "string", "payload.turnIndex": "number" },
    description: "Turn ended"
  },
  {
    domain: "tool",
    eventType: "tool-batch-start",
    requiredFields: ["payload.sessionId", "payload.batchId"],
    fieldTypes: { "payload.sessionId": "string", "payload.batchId": "string" },
    description: "Tool batch execution started"
  },
  {
    domain: "tool",
    eventType: "tool-batch-end",
    requiredFields: ["payload.sessionId", "payload.batchId"],
    fieldTypes: { "payload.sessionId": "string", "payload.batchId": "string" },
    description: "Tool batch execution ended"
  },
  {
    domain: "tool",
    eventType: "tool-start",
    requiredFields: ["payload.sessionId", "payload.batchId", "payload.call.id"],
    fieldTypes: { "payload.sessionId": "string", "payload.batchId": "string", "payload.call.id": "string" },
    description: "Single tool execution started"
  },
  {
    domain: "tool",
    eventType: "tool-end",
    requiredFields: ["payload.sessionId", "payload.batchId", "payload.result.id"],
    fieldTypes: { "payload.sessionId": "string", "payload.batchId": "string", "payload.result.id": "string" },
    description: "Single tool execution ended"
  },
  {
    domain: "approval",
    eventType: "approval-requested",
    requiredFields: ["payload.sessionId", "payload.request.id"],
    fieldTypes: { "payload.sessionId": "string", "payload.request.id": "string" },
    description: "Approval requested for tool execution"
  },
  {
    domain: "approval",
    eventType: "approval-resolved",
    requiredFields: ["payload.sessionId", "payload.requestId"],
    fieldTypes: { "payload.sessionId": "string", "payload.requestId": "string" },
    description: "Approval resolved"
  },
  {
    domain: "provider",
    eventType: "provider-diagnostic",
    requiredFields: ["payload.sessionId"],
    fieldTypes: { "payload.sessionId": "string" },
    description: "Provider diagnostic event"
  },
  {
    domain: "checkpoint",
    eventType: "checkpoint-created",
    requiredFields: ["payload.sessionId", "payload.checkpoint.id"],
    fieldTypes: { "payload.sessionId": "string", "payload.checkpoint.id": "string" },
    description: "Checkpoint created"
  },
  {
    domain: "checkpoint",
    eventType: "checkpoint-restored",
    requiredFields: ["payload.sessionId", "payload.restore.checkpointId"],
    fieldTypes: { "payload.sessionId": "string", "payload.restore.checkpointId": "string" },
    description: "Checkpoint restored"
  },
  {
    domain: "lifecycle",
    eventType: "state-transition",
    requiredFields: ["payload.machineType", "payload.fromState", "payload.toState", "payload.triggerEvent"],
    fieldTypes: {
      "payload.machineType": "string",
      "payload.fromState": "string",
      "payload.toState": "string",
      "payload.triggerEvent": "string"
    },
    description: "State machine transition"
  },
  {
    domain: "conversation",
    eventType: "message-start",
    requiredFields: ["payload.sessionId", "payload.message.id"],
    fieldTypes: { "payload.sessionId": "string", "payload.message.id": "string" },
    description: "Message started"
  },
  {
    domain: "conversation",
    eventType: "message-delta",
    requiredFields: ["payload.sessionId", "payload.messageId"],
    fieldTypes: { "payload.sessionId": "string", "payload.messageId": "string" },
    description: "Message delta (streaming)"
  },
  {
    domain: "conversation",
    eventType: "message-end",
    requiredFields: ["payload.sessionId", "payload.message.id"],
    fieldTypes: { "payload.sessionId": "string", "payload.message.id": "string" },
    description: "Message ended"
  },
  {
    domain: "diagnostic",
    eventType: "runtime-error",
    requiredFields: ["payload.sessionId", "payload.error"],
    fieldTypes: { "payload.sessionId": "string", "payload.error": "string" },
    description: "Runtime error"
  },
  {
    domain: "conversation",
    eventType: "context-compression-start",
    requiredFields: ["payload.sessionId"],
    fieldTypes: { "payload.sessionId": "string" },
    description: "Context compression started"
  },
  {
    domain: "conversation",
    eventType: "context-compression-end",
    requiredFields: ["payload.sessionId", "payload.aborted"],
    fieldTypes: { "payload.sessionId": "string", "payload.aborted": "boolean" },
    description: "Context compression ended"
  }
];

// ─── Runtime Adapter ──────────────────────────────────────

/**
 * Runtime 层的 Canonical Adapter
 *
 * �?AgentEvent 转换�?ConexCanonicalEvent，反之亦然�? */
export class RuntimeCanonicalAdapter implements ConexCanonicalAdapter<unknown> {
  toCanonical(event: unknown, context: AdapterContext): ConexCanonicalEvent {
    const agentEvent = event as Record<string, unknown>;
    const type = agentEvent.type as string;
    const { domain, eventType } = classifyRuntimeEvent(type);

    return createCanonicalEvent({
      domain,
      eventType,
      payload: agentEvent,
      context,
      sourceLayer: "runtime",
      diagnostics: extractDiagnostics(agentEvent)
    });
  }

  fromCanonical(canonical: ConexCanonicalEvent): unknown {
    return canonical.payload;
  }
}

// ─── 工具函数 ─────────────────────────────────────────────

function createEventId(): string {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function classifyRuntimeEvent(type: string): { domain: ConexEventDomain; eventType: string } {
  if (CONVERSATION_EVENT_TYPES.has(type)) return { domain: "conversation", eventType: type };
  if (TOOL_EVENT_TYPES.has(type)) return { domain: "tool", eventType: type };
  if (APPROVAL_EVENT_TYPES.has(type)) return { domain: "approval", eventType: type };
  if (CHECKPOINT_EVENT_TYPES.has(type)) return { domain: "checkpoint", eventType: type };
  if (type === "provider-diagnostic") return { domain: "provider", eventType: type };
  if (type === "runtime-error") return { domain: "diagnostic", eventType: type };
  return { domain: "diagnostic", eventType: type };
}

const CONVERSATION_EVENT_TYPES = new Set([
  "agent-start", "agent-end", "turn-start", "turn-end",
  "message-start", "message-delta", "message-end",
  "context-compression-start", "context-compression-end",
  "runtime-steering", "runtime-intervention-required"
]);

const TOOL_EVENT_TYPES = new Set([
  "tool-batch-start", "tool-batch-end", "tool-start", "tool-update", "tool-end",
  "tool-input-repaired"
]);

const APPROVAL_EVENT_TYPES = new Set([
  "approval-requested", "approval-resolved"
]);

const CHECKPOINT_EVENT_TYPES = new Set([
  "checkpoint-created", "checkpoint-restored"
]);

function extractDiagnostics(event: Record<string, unknown>): ConexDiagnostic[] | undefined {
  const diagnostic = event.diagnostic as Record<string, unknown> | undefined;
  if (!diagnostic) return undefined;
  return [{
    code: String(diagnostic.phase ?? diagnostic.code ?? "unknown"),
    severity: "info",
    message: String(diagnostic.reason ?? diagnostic.message ?? "")
  }];
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function checkType(value: unknown, expectedType: string): boolean {
  const actual = typeof value;
  switch (expectedType) {
    case "string": return actual === "string";
    case "number": return actual === "number";
    case "boolean": return actual === "boolean";
    case "object": return actual === "object" && value !== null;
    case "array": return Array.isArray(value);
    default: return true;
  }
}

/**
 * 创建全局默认�?Schema Registry 并注册内�?Schema
 */
export function createDefaultSchemaRegistry(): EventSchemaRegistry {
  const registry = new EventSchemaRegistry();
  registry.registerAll(RUNTIME_EVENT_SCHEMAS);
  return registry;
}
