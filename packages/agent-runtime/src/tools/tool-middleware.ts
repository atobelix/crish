/**
 * ToolMiddleware — 工具中间件接口与内置实现（Layer 3）
 *
 * 所有业务逻辑（权限、物化、Checkpoint）通过 ToolMiddleware 管线注入，
 * 而不是硬编码在 ToolExecutor 或 AgentSessionLoop 中。
 *
 * 中间件生命周期：
 * 1. beforeExecute → 可阻止执行（proceed: false）或修改输入
 * 2. 工具执行（execute）
 * 3. afterExecute → 可修改输出（如物化大输出）
 *
 * 内置中间件：
 * - PermissionMiddleware：对接 PermissionDecider
 * - CheckpointMiddleware：对接 CheckpointManager
 * - OutputMaterializationMiddleware：对接 ContextManager.materializeOutput
 */

import type {
  AgentEvent,
  JsonObject,
  PermissionRequest,
  ToolCallBlock,
  ToolOutput,
  ToolExecutionContext,
  ApprovalHandler,
} from "@crish/shared-types";
import type { AgentMessage } from "@crish/shared-types";
import type { RegisteredTool } from "./tool-definition";
import type { RuntimePermissionPolicy, RuntimePermissionRequest } from "../types";
import type { ContextManager } from "../runtime-components/context-manager";
import type { CheckpointManager, CheckpointMetadata } from "../checkpoint/checkpoint-manager";
import { createId, nowIso } from "../session";

// ─── ToolMiddleware 接口 ─────────────────────────────────────────

/**
 * 工具中间件接口。
 *
 * beforeExecute 在工具执行前调用，可以：
 * - 阻止执行（proceed: false）并附带 blockReason
 * - 修改输入（modifiedInput）
 *
 * afterExecute 在工具执行后调用，可以：
 * - 修改输出（如物化大输出、脱敏）
 * - 记录事件（如 checkpoint）
 */
export interface ToolMiddleware {
  /** 中间件名称（用于日志和调试） */
  name: string;

  /**
   * 工具执行前钩子。
   *
   * @param tool - 运行时工具对象
   * @param input - 工具输入
   * @param ctx - 工具执行上下文
   * @returns proceed=true 表示继续执行；proceed=false 表示阻止执行
   */
  beforeExecute?(
    tool: RegisteredTool,
    input: JsonObject,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareBeforeResult>;

  /**
   * 工具执行后钩子。
   *
   * @param tool - 运行时工具对象
   * @param input - 工具输入（可能是 beforeExecute 修改后的版本）
   * @param output - 工具输出
   * @param ctx - 工具执行上下文
   * @returns 修改后的输出（或原输出）
   */
  afterExecute?(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult>;
}

/**
 * beforeExecute 返回结果。
 */
export interface MiddlewareBeforeResult {
  /** 是否继续执行 */
  proceed: boolean;
  /** 修改后的输入（可选） */
  modifiedInput?: JsonObject;
  /** 阻止原因（proceed=false 时使用） */
  blockReason?: string;
  /** 附加的事件（可选） */
  events?: AgentEvent[];
}

/**
 * afterExecute 返回结果。
 */
export interface MiddlewareAfterResult {
  /** 修改后的输出（可选） */
  output?: ToolOutput;
  /** 附加的事件（可选） */
  events?: AgentEvent[];
}

// ─── PermissionMiddleware ────────────────────────────────────────

/**
 * 权限中间件 — 对接 PermissionDecider。
 *
 * 在 beforeExecute 中评估权限策略：
 * - allow → 继续执行
 * - deny → 阻止执行，返回 blockReason
 * - ask → 请求审批（如果提供了 approvalHandler）
 *
 * 产出事件：
 * - approval-requested（策略返回 ask 时）
 * - approval-resolved（审批完成后）
 */
export interface PermissionMiddlewareOptions {
  /** RuntimePermissionPolicy 实例 */
  permissionPolicy: RuntimePermissionPolicy;
  /** ApprovalHandler 实例（可选，用于策略返回 ask 时） */
  approvalHandler?: ApprovalHandler;
  /** session ID（用于事件） */
  sessionId: string;
  /** cwd（用于 PermissionRequest） */
  cwd: string;
}

export class PermissionMiddleware implements ToolMiddleware {
  readonly name = "permission";

  constructor(private readonly options: PermissionMiddlewareOptions) {}

  async beforeExecute(
    tool: RegisteredTool,
    input: JsonObject,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareBeforeResult> {
    const request: RuntimePermissionRequest = {
      id: createId("perm"),
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      tool,
      input,
      summary: tool.summarize(input),
    };

    const events: AgentEvent[] = [];

    // 评估权限
    const decision = await this.options.permissionPolicy.decide(
      request as RuntimePermissionRequest
    );

    if (decision.behavior === "ask") {
      // 构造可序列化的 PermissionRequest：从 RuntimePermissionRequest 提取扁平字段，
      // 避免将 AgentTool（含 execute/summarize 等函数）泄漏到事件流。
      const serializableRequest: PermissionRequest = {
        id: request.id,
        sessionId: request.sessionId,
        cwd: request.cwd,
        toolCallId: request.id,
        toolName: tool.name,
        parameters: input,
        summary: request.summary,
        toolMetadata: {
          category: tool.category,
          isReadOnly: tool.isReadOnly(input),
          fatalOnError: tool.fatalOnError,
          concurrency: tool.concurrency,
        },
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      };
      events.push({
        type: "approval-requested",
        sessionId: ctx.sessionId,
        request: serializableRequest,
        timestamp: nowIso(),
      });

      const finalDecision = await this.options.approvalHandler?.requestApproval(serializableRequest);
      const resolvedDecision = finalDecision ?? decision;

      events.push({
        type: "approval-resolved",
        sessionId: ctx.sessionId,
        requestId: request.id,
        decision,
        timestamp: nowIso(),
      });

      if (resolvedDecision.behavior === "deny") {
        return {
          proceed: false,
          blockReason: resolvedDecision.reason ?? "Permission denied",
          events,
        };
      }

      // allow → 继续执行
      return { proceed: true, events };
    }

    // deny → 阻止执行
    if (decision.behavior === "deny") {
      return {
        proceed: false,
        blockReason: decision.reason ?? "Permission denied",
        events,
      };
    }

    // allow → 继续执行
    return { proceed: true, events };
  }
}

// ─── CheckpointMiddleware ─────────────────────────────────────────

/**
 * Checkpoint 中间件 — 对接 CheckpointManager。
 *
 * 在 afterExecute 中：
 * - 如果权限评估建议创建 snapshot 且工具属于 filesystem 分类，
 *   则通过 CheckpointManager 创建 checkpoint
 * - 产出 checkpoint-created 事件
 */
export interface CheckpointMiddlewareOptions {
  /** CheckpointManager 实例 */
  checkpointManager: CheckpointManager;
  /** session ID（用于事件） */
  sessionId: string;
  /** 权限评估结果（来自 PermissionMiddleware） */
  permissionDecision?: import("@crish/shared-types").PermissionDecision;
  /** 当前消息列表（用于 checkpoint 创建） */
  messages?: () => AgentMessage[];
  /** 当前 turn 索引 */
  turnIndex?: number;
}

export class CheckpointMiddleware implements ToolMiddleware {
  readonly name = "checkpoint";

  constructor(private readonly options: CheckpointMiddlewareOptions) {}

  async afterExecute(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult> {
    // 只对 filesystem 工具的写操作创建 checkpoint
    if (tool.category !== "filesystem") return {};
    if (tool.isReadOnly(input)) return {};
    if (output.text && output.text.includes("Error")) return {};

    const messages = this.options.messages?.();
    if (!messages) return {};

    const checkpoint = this.options.checkpointManager.createCheckpoint(
      messages,
      this.options.turnIndex ?? 0,
      {
        label: `Pre-${tool.name} checkpoint`,
        description: tool.summarize(input),
      }
    );

    const checkpointRecord: import("@crish/shared-types").RuntimeCheckpointRecord = {
      id: checkpoint.checkpointId,
      kind: "workspace-checkpoint",
      label: checkpoint.label ?? `Pre-${tool.name}`,
      toolCallId: ctx.toolCallId,
      toolName: tool.name,
      metadata: checkpoint as unknown as JsonObject,
    };

    const events: AgentEvent[] = [
      {
        type: "checkpoint-created",
        sessionId: ctx.sessionId,
        timestamp: nowIso(),
        checkpoint: checkpointRecord,
      },
    ];

    return { events };
  }
}

// ─── OutputMaterializationMiddleware ─────────────────────────────

/**
 * 输出物化中间件 — 对接 ContextManager.materializeOutput。
 *
 * 在 afterExecute 中：
 * - 如果工具输出超过阈值，将完整输出保存为 artifact 文件，
 *   返回带预览的精简输出
 */
export interface OutputMaterializationMiddlewareOptions {
  /** ContextManager 实例 */
  contextManager: ContextManager;
  /** 当前工具调用块（用于 materializeOutput） */
  toolCallBlock: ToolCallBlock;
}

export class OutputMaterializationMiddleware implements ToolMiddleware {
  readonly name = "output-materialization";

  constructor(private readonly options: OutputMaterializationMiddlewareOptions) {}

  async afterExecute(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult> {
    const materialized = await this.options.contextManager.materializeOutput(
      this.options.toolCallBlock,
      output
    );

    // 如果物化没有改变输出，返回原输出
    if (materialized === output) return {};

    return { output: materialized };
  }
}

// ─── MiddlewarePipeline ───────────────────────────────────────────

/**
 * 中间件管线 — 按顺序执行一组 ToolMiddleware。
 *
 * 执行流程：
 * 1. 按顺序执行所有 beforeExecute → 如果任何一个返回 proceed=false，停止执行
 * 2. 执行工具
 * 3. 按顺序执行所有 afterExecute → 依次修改输出
 */
export class MiddlewarePipeline {
  constructor(private readonly middlewares: ToolMiddleware[]) {}

  /**
   * 执行所有 beforeExecute 钩子。
   *
   * 如果任何一个返回 proceed=false，立即停止并返回阻止原因。
   * 如果某个 beforeExecute 返回 modifiedInput，后续中间件使用修改后的输入。
   *
   * @returns proceed=true 表示所有中间件同意执行；proceed=false 表示被阻止
   */
  async runBefore(
    tool: RegisteredTool,
    input: JsonObject,
    ctx: ToolExecutionContext
  ): Promise<{ proceed: boolean; input: JsonObject; blockReason?: string; events: AgentEvent[] }> {
    let currentInput = input;
    const allEvents: AgentEvent[] = [];

    for (const middleware of this.middlewares) {
      if (!middleware.beforeExecute) continue;

      const result = await middleware.beforeExecute(tool, currentInput, ctx);

      if (result.events) {
        allEvents.push(...result.events);
      }

      if (!result.proceed) {
        return {
          proceed: false,
          input: currentInput,
          blockReason: result.blockReason ?? `Blocked by middleware: ${middleware.name}`,
          events: allEvents,
        };
      }

      if (result.modifiedInput) {
        currentInput = result.modifiedInput;
      }
    }

    return {
      proceed: true,
      input: currentInput,
      events: allEvents,
    };
  }

  /**
   * 执行所有 afterExecute 钩子。
   *
   * 按顺序执行，每个中间件可以修改输出。
   * 修改后的输出传递给下一个中间件。
   */
  async runAfter(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<{ output: ToolOutput; events: AgentEvent[] }> {
    let currentOutput = output;
    const allEvents: AgentEvent[] = [];

    for (const middleware of this.middlewares) {
      if (!middleware.afterExecute) continue;

      const result = await middleware.afterExecute(tool, input, currentOutput, ctx);

      if (result.events) {
        allEvents.push(...result.events);
      }

      if (result.output) {
        currentOutput = result.output;
      }
    }

    return {
      output: currentOutput,
      events: allEvents,
    };
  }
}