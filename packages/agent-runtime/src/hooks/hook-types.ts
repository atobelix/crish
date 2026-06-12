/**
 * Hook 系统与扩展性基础 — 类型定义
 *
 * 定义 AgentHooks 接口、HookContext、TurnContext 等核心类型，
 * 以及 Extension 接口为未来的插件系统奠基。
 *
 * 设计原则：
 * 1. 所有 Hook 都是可选的 — 如果没有 Hook 注册，循环行为与之前完全一致
 * 2. Hook 在 AgentSessionLoop 的状态转移点自然调用
 * 3. beforeToolCall/afterToolCall 通过 Extension Registry 管理
 * 4. Extension 是未来插件系统的最小接口
 */

import type { AgentMessage, JsonObject, ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "../types";
import type { ToolDefinition } from "../tools/tool-definition";

// ─── HookContext ────────────────────────────────────────────

/**
 * 工具调用 Hook 上下文
 *
 * beforeToolCall 和 afterToolCall 共享的基础上下文。
 */
export interface HookContext {
  /** 会话 ID */
  sessionId: string;
  /** 当前工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具实例（如果有） */
  tool?: AgentTool;
  /** 工具调用输入 */
  input: JsonObject;
  /** 工具调用输出（仅在 afterToolCall 中可用） */
  output?: ToolOutput;
  /** 当前工作目录 */
  cwd: string;
  /** Turn 编号 */
  turnIndex: number;
}

// ─── TurnContext ────────────────────────────────────────────

/**
 * Turn 级别 Hook 上下文
 *
 * shouldStopAfterTurn 和 prepareNextTurn 使用。
 */
export interface TurnContext {
  /** 会话 ID */
  sessionId: string;
  /** 当前 Turn 编号 */
  turnIndex: number;
  /** 最大 Turn 数 */
  maxTurns: number;
  /** 当前对话消息列表 */
  messages: AgentMessage[];
  /** 本轮工具调用数量 */
  toolCallCount: number;
  /** 本轮工具调用列表 */
  toolCalls: Array<{ toolName: string; input: JsonObject }>;
  /** 当前工作目录 */
  cwd: string;
  /** 是否有待处理的新输入 */
  hasPendingInput: boolean;
  /** 是否已中止 */
  isAborted: boolean;
}

// ─── ErrorContext ────────────────────────────────────────────

/**
 * 错误 Hook 上下文
 *
 * onError 使用。
 */
export interface ErrorContext {
  /** 会话 ID */
  sessionId: string;
  /** 当前状态 */
  state: string;
  /** 当前 Turn 编号 */
  turnIndex: number;
  /** 当前工作目录 */
  cwd: string;
}

// ─── AgentHooks ────────────────────────────────────────────

/**
 * Agent 生命周期 Hook 接口
 *
 * 在 AgentSessionLoop 的状态转移点自然调用：
 * - awaiting-input → prepareNextTurn
 * - executing-tools → beforeToolCall / afterToolCall
 * - turn-complete → shouldStopAfterTurn
 * - 任何状态的 error → onError
 *
 * 所有 Hook 都是可选的。如果没有注册，循环行为与之前完全一致。
 */
export interface AgentHooks {
  /** 工具调用前拦截 */
  beforeToolCall?: (ctx: HookContext) => Promise<{
    /** 是否阻止本次调用 */
    block?: boolean;
    /** 阻止原因 */
    reason?: string;
    /** 修改后的输入（如果不阻止） */
    modifiedInput?: JsonObject;
  }>;

  /** 工具调用后改写结果 */
  afterToolCall?: (ctx: HookContext) => Promise<{
    /** 修改后的输出 */
    modifiedOutput?: ToolOutput;
    /** 是否终止整个运行 */
    terminate?: boolean;
    /** 终止原因 */
    terminateReason?: string;
  }>;

  /** 每轮结束后判断是否提前终止 */
  shouldStopAfterTurn?: (ctx: TurnContext) => boolean;

  /** 准备下一轮（可切换模型、修改 prompt） */
  prepareNextTurn?: (ctx: TurnContext) => Promise<{
    /** 切换模型 */
    model?: string;
    /** Prompt 覆盖 */
    promptOverride?: string;
  }>;

  /** 错误处理策略 */
  onError?: (error: Error, ctx: ErrorContext) => "retry" | "skip" | "abort";
}

// ─── Extension ──────────────────────────────────────────────

/**
 * UIComponentRegistration — UI 组件注册信息
 *
 * 用于 Web UI 等前端扩展。
 */
export interface UIComponentRegistration {
  /** 组件 ID */
  id: string;
  /** 组件类型（如 panel、toolbar-item、status-bar-widget） */
  type: string;
  /** 组件标签 */
  label: string;
  /** 组件入口（渲染函数或路径） */
  entry: string | (() => unknown);
  /** 元数据 */
  metadata?: JsonObject;
}

/**
 * CommandRegistration — 命令注册信息
 *
 * 用于 CLI 或 UI 中的自定义命令。
 */
export interface CommandRegistration {
  /** 命令名称 */
  name: string;
  /** 命令描述 */
  description: string;
  /** 命令处理器 */
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
  /** 元数据 */
  metadata?: JsonObject;
}

/**
 * Extension — 扩展接口
 *
 * 为未来的插件系统奠基。第三方可以通过 Extension 注册工具、Hook、
 * UI 组件和命令，无需修改核心代码。
 */
export interface Extension {
  /** 扩展名称（唯一标识） */
  name: string;
  /** 扩展版本 */
  version: string;

  /** 注册自定义工具（使用 ToolDefinition 最小接口） */
  tools?: ToolDefinition[];

  /** 注册生命周期 Hook */
  hooks?: Partial<AgentHooks>;

  /** 注册自定义 UI 组件（Web UI 使用） */
  uiComponents?: UIComponentRegistration[];

  /** 注册自定义命令 */
  commands?: CommandRegistration[];
}