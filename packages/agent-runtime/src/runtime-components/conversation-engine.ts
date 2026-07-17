/**
 * ConversationEngine - 对话引擎
 *
 * 从 AgentRuntime 中拆分出来的独立组件，负责：
 * 1. 对话消息的构建与追加
 * 2. Provider 调用的编排
 * 3. Turn 循环的核心逻辑
 * 4. 消息格式转换
 *
 * 关键改进：
 * - 对话逻辑与工具执行解耦
 * - 消息构建的结构化
 * - Turn 循环由 TurnLoop 状态机驱动
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentMessageBlock,
  ToolCallBlock,
  ToolResultBlock,
  TextBlock,
} from "@crish/shared-types";
import type {
  AgentProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  RuntimeRecoveryReason,
  AgentEndReason,
  AgentRuntimeOptions,
  AgentTool,
} from "../types";
import {
  type TurnEndReason,
} from "../state-machine";
import { createId, nowIso, createTextMessage } from "../session";
import { detectRecentToolErrorLoop, detectRepeatedToolCallLoop, runtimeSteeringText } from "../runtime-helpers";

// ─── 对话引擎配置 ─────────────────────────────────────────

export interface ConversationEngineOptions {
  sessionId: string;
  maxTurns: number;
  modelId: string;
  systemPrompt: string;
  /** 当前工作目录 */
  cwd: string;
}

// ─── Turn 结果 ────────────────────────────────────────────

export interface TurnResult {
  /** Provider 返回的消息 */
  assistantMessage: AgentMessage;
  /** 工具调用列表（如果有） */
  toolCalls: ToolCallBlock[];
  /** 是否需要继续下一轮 */
  shouldContinue: boolean;
  /** 结束原因（如果 shouldContinue 为 false） */
  endReason?: TurnEndReason;
  /** Provider 诊断信息 */
  diagnostics?: unknown[];
}

// ─── 对话快照 ─────────────────────────────────────────────

export interface ConversationSnapshot {
  messages: AgentMessage[];
  turnCount: number;
  lastTurnAt?: string;
}

// ─── ConversationEngine ───────────────────────────────────

export class ConversationEngine {
  private messages: AgentMessage[] = [];
  /**
   * 消息列表的只读视图引用（frozen view）。
   *
   * 系统化设计：
   * - 该字段始终与 `this.messages` 保持同步（别名引用）。
   * - 对于 in-place 变更（push），别名自动保持有效，因为两者指向同一数组。
   * - 对于重赋值变更（replaceMessages / restoreFromSnapshot），通过 refreshFrozenView() 刷新引用。
   * - 所有变更方法统一调用 refreshFrozenView()，保证该字段始终指向最新数组，
   *   即使未来 `messages` 改为 copy-on-write 模式也无需调整调用方。
   *
   * 契约：getMessages() 返回此引用（O(1)，无拷贝）。
   * 调用方必须将返回的数组视为只读；如需修改请自行 `.slice()` 拷贝，
   * 或直接使用 getMessagesMutable() 获取可变引用。
   */
  private frozenMessages: AgentMessage[] = this.messages;
  private turnCount = 0;
  private lastTurnAt?: string;

  constructor(private readonly options: ConversationEngineOptions) {}

  /**
   * 刷新 frozenMessages 别名引用。
   *
   * 在每次消息变更后调用：
   * - in-place 变更（push）：no-op，因两者本就指向同一数组。
   * - 重赋值变更（this.messages = ...）：更新别名指向新数组。
   *
   * 统一在所有变更点调用，确保 frozenMessages 永远与 messages 同步，
   * 为 getMessages() 提供 O(1) 无拷贝返回的保证。
   */
  private refreshFrozenView(): void {
    this.frozenMessages = this.messages;
  }

  /**
   * 初始化对话（添加系统提示）
   */
  initialize(): void {
    if (this.messages.length > 0) return;
    this.messages.push({
      id: createId("system"),
      role: "system",
      blocks: [{ type: "text", text: this.options.systemPrompt }],
      createdAt: nowIso()
    });
  }

  /**
   * 追加用户消息
   */
  appendUserMessage(text: string): AgentMessage {
    const message: AgentMessage = {
      id: createId("user"),
      role: "user",
      blocks: [{ type: "text", text }],
      createdAt: nowIso()
    };
    this.messages.push(message);
    return message;
  }

  /**
   * 追加 Assistant 消息（包含工具调用）
   */
  appendAssistantMessage(blocks: AgentMessageBlock[]): AgentMessage {
    const message: AgentMessage = {
      id: createId("assistant"),
      role: "assistant",
      blocks,
      createdAt: nowIso()
    };
    this.messages.push(message);
    this.refreshFrozenView();
    return message;
  }

  /**
   * 追加工具结果消息
   */
  appendToolResults(results: ToolResultBlock[]): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const result of results) {
      const message: AgentMessage = {
        id: createId("tool"),
        role: "tool",
        blocks: [result],
        createdAt: nowIso()
      };
      this.messages.push(message);
      messages.push(message);
    }
    return messages;
  }

  /**
   * 构建 Provider 请求
   */
  buildProviderRequest(tools: AgentTool[], signal: AbortSignal): AgentProviderRequest {
    return {
      messages: [...this.messages],
      tools,
      sessionId: this.options.sessionId,
      cwd: "",
      signal,
      systemPrompt: this.options.systemPrompt
    };
  }

  /**
   * 处理 Provider 响应，提取工具调用和文本内容
   */
  processProviderResponse(response: ProviderResponse): TurnResult {
    this.turnCount++;
    this.lastTurnAt = nowIso();

    const blocks: AgentMessageBlock[] = [];
    const toolCalls: ToolCallBlock[] = [];

    // 提取文本内容
    if (response.text) {
      blocks.push({ type: "text", text: response.text });
    }

    // 提取工具调用
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        const toolCall: ToolCallBlock = {
          type: "tool-call",
          id: call.id,
          toolName: call.toolName,
          input: call.input,
        };
        toolCalls.push(toolCall);
        blocks.push(toolCall);
      }
    }

    // 追加 assistant 消息
    this.appendAssistantMessage(blocks);

    // 判断是否继续
    const shouldContinue = toolCalls.length > 0 && this.turnCount < this.options.maxTurns;
    const endReason: TurnEndReason | undefined = shouldContinue
      ? undefined
      : toolCalls.length > 0
        ? "max-turns"
        : "stop";

    return {
      assistantMessage: this.messages.at(-1)!,
      toolCalls,
      shouldContinue,
      endReason,
      diagnostics: response.diagnostics
    };
  }

  /**
   * 获取当前消息列表
   */
  getMessages(): AgentMessage[] {
    return [...this.messages];
  }

  /**
   * 获取 Turn 计数
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * 是否达到最大轮数
   */
  isMaxTurnsReached(): boolean {
    return this.turnCount >= this.options.maxTurns;
  }

  /**
   * 创建对话快照
   */
  getSnapshot(): ConversationSnapshot {
    return {
      messages: [...this.messages],
      turnCount: this.turnCount,
      lastTurnAt: this.lastTurnAt
    };
  }

  /**
   * 从快照恢复
   */
  restoreFromSnapshot(snapshot: ConversationSnapshot): void {
    this.messages = [...snapshot.messages];
    this.turnCount = snapshot.turnCount;
    this.lastTurnAt = snapshot.lastTurnAt;
  }

  /**
   * 追加任意消息（用于 system steering、恢复消息等场景）
   */
  appendMessage(message: AgentMessage): void {
    this.messages.push(message);
  }

  /**
   * 替换消息列表（用于压缩后）
   */
  replaceMessages(messages: AgentMessage[]): void {
    this.messages = [...messages];
  }

  /**
   * 获取消息列表的可变引用
   *
   * 仅用于 runtime 内部需要直接操作消息数组的场景（如上下文压缩）。
   * 调用者应优先使用 appendMessage / replaceMessages 等方法。
   */
  getMessagesMutable(): AgentMessage[] {
    return this.messages;
  }

  /**
   * 检测运行时恢复需求（工具错误循环、重复调用循环）。
   *
   * @returns 恢复原因，如果不需要恢复则返回 null
   */
  detectRecoveryNeed(
    options?: { maxConsecutiveToolErrors?: number; maxRepeatedToolCalls?: number }
  ): RuntimeRecoveryReason | null {
    const errorLoop = detectRecentToolErrorLoop(this.messages, options?.maxConsecutiveToolErrors ?? 2);
    if (errorLoop) return errorLoop;
    const repeatedLoop = detectRepeatedToolCallLoop(this.messages, options?.maxRepeatedToolCalls ?? 3);
    return repeatedLoop ?? null;
  }

  /**
   * 应用运行时纠偏（runtime steering）。
   *
   * 当检测到工具错误循环或重复调用循环时，注入系统纠偏消息。
   *
   * @param reason - 恢复原因
   * @param steeringCount - 当前纠偏计数
   * @param maxSteeringMessages - 最大纠偏次数
   * @returns 纠偏后的消息和新的计数
   */
  applySteering(
    reason: RuntimeRecoveryReason,
    steeringCount: number,
    maxSteeringMessages: number = 1
  ): { message: AgentMessage; newCount: number; shouldIntervene: boolean } {
    if (steeringCount >= maxSteeringMessages) {
      return { message: null as unknown as AgentMessage, newCount: steeringCount, shouldIntervene: true };
    }

    const message = createTextMessage("system", runtimeSteeringText(reason), {
      kind: "runtime-steering",
      reason,
      steeringCount: steeringCount + 1
    });
    this.appendMessage(message);
    return { message, newCount: steeringCount + 1, shouldIntervene: false };
  }
}
