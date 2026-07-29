/**
 * ToolMiddleware — 工具中间件接口与内置实现（Layer 3）
 *
 * 精简 Hook 体系（红线禁令 7）：
 * 仅保留 3 个 Hook：beforeExecute、onResult、onError（彻底剔除冗余 Hook 阶段与 6 阶段管道）
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
import type { CheckpointManager } from "../checkpoint/checkpoint-manager";
import { createId, nowIso } from "../session";

// ─── ToolMiddleware 接口 ─────────────────────────────────────────

/**
 * 工具中间件接口
 *
 * 精简为 3 个 Hook 方法：beforeExecute / onResult / onError
 */
export interface ToolMiddleware {
  /** 中间件名称（用于日志和调试） */
  name: string;

  /**
   * 工具执行前钩子
   */
  beforeExecute?(
    tool: RegisteredTool,
    input: JsonObject,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareBeforeResult>;

  /**
   * 工具执行后结果钩子
   */
  onResult?(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult>;

  /**
   * 工具执行错误钩子
   */
  onError?(
    tool: RegisteredTool,
    input: JsonObject,
    error: Error,
    ctx: ToolExecutionContext
  ): Promise<void>;
}

/**
 * beforeExecute 返回结果
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
 * onResult 返回结果
 */
export interface MiddlewareAfterResult {
  /** 修改后的输出（可选） */
  output?: ToolOutput;
  /** 附加的事件（可选） */
  events?: AgentEvent[];
}

// ─── PermissionMiddleware ────────────────────────────────────────

export interface PermissionMiddlewareOptions {
  /** RuntimePermissionPolicy 实例 */
  permissionPolicy: RuntimePermissionPolicy;
  /** ApprovalHandler 实例（可选，用于策略返回 ask 时） */
  approvalHandler?: ApprovalHandler;
  /** session ID（用于事件） */
  sessionId: string;
  /** cwd */
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

      return { proceed: true, events };
    }

    if (decision.behavior === "deny") {
      return {
        proceed: false,
        blockReason: decision.reason ?? "Permission denied",
        events,
      };
    }

    return { proceed: true, events };
  }
}

// ─── CheckpointMiddleware ─────────────────────────────────────────

export interface CheckpointMiddlewareOptions {
  checkpointManager: CheckpointManager;
  sessionId: string;
  permissionDecision?: import("@crish/shared-types").PermissionDecision;
  messages?: () => AgentMessage[];
  turnIndex?: number;
}

export class CheckpointMiddleware implements ToolMiddleware {
  readonly name = "checkpoint";

  constructor(private readonly options: CheckpointMiddlewareOptions) {}

  async onResult(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult> {
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

export interface OutputMaterializationMiddlewareOptions {
  contextManager: ContextManager;
  toolCallBlock: ToolCallBlock;
}

export class OutputMaterializationMiddleware implements ToolMiddleware {
  readonly name = "output-materialization";

  constructor(private readonly options: OutputMaterializationMiddlewareOptions) {}

  async onResult(
    tool: RegisteredTool,
    input: JsonObject,
    output: ToolOutput,
    ctx: ToolExecutionContext
  ): Promise<MiddlewareAfterResult> {
    const materialized = await this.options.contextManager.materializeOutput(
      this.options.toolCallBlock,
      output
    );

    if (materialized === output) return {};

    return { output: materialized };
  }
}