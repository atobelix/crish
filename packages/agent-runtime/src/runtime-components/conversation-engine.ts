
/**
 * ConversationEngine - 对话引擎
 *
 * �?AgentRuntime 中拆分出来的独立组件，负责：
 * 1. 对话消息的构建与追加
 * 2. Provider 调用的编�?
 * 3. Turn 循环的核心逻辑
 * 4. 消息格式转换
 *
 * 关键改进�?
 * - 对话逻辑与工具执行解�?
 * - 消息构建的结构化
 * - Turn 循环�?TurnLoop 状态机驱动
 */

import type {
  AgentMessage,
  AgentMessageBlock,
  ToolCallBlock,
  ToolResultBlock,
} from "@crish/shared-types";
import type {
  AgentProviderRequest,
  ProviderResponse,
  RuntimeRecoveryReason,
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
  /** Provider 返回的消�?*/
  assistantMessage: AgentMessage;
  /** 工具调用列表（如果有�?*/
  toolCalls: ToolCallBlock[];
  /** 是否需要继续下一�?*/
  shouldContinue: boolean;
  /** 结束原因（如�?shouldContinue �?false�?*/
  endReason?: TurnEndReason;
  /** Provider 诊断信息 */
  diagnostics?: unknown[];
}

// ─── 对话快照 ─────────────────────────────────────────────

export interface ConversationSnapshot {
  messages: AgentMessage[];
  turnCount: number;
  lastTurnAt: string | undefined;
}

// ─── ConversationEngine ───────────────────────────────────

export class ConversationEngine {
  private messages: AgentMessage[] = [];
  /**
   * 消息列表的只读视图引用（frozen view）�?
   *
   * 系统化设计：
   * - 该字段始终与 `this.messages` 保持同步（别名引用）�?
   * - 对于 in-place 变更（push），别名自动保持有效，因为两者指向同一数组�?
   * - 对于重赋值变更（replaceMessages / restoreFromSnapshot），通过 refreshFrozenView() 刷新引用�?
   * - 所有变更方法统一调用 refreshFrozenView()，保证该字段始终指向最新数组，
   *   即使未来 `messages` 改为 copy-on-write 模式也无需调整调用方�?
   *
   * 契约：getMessages() 返回此引用（O(1)，无拷贝）�?
   * 调用方必须将返回的数组视为只读；如需修改请自�?`.slice()` 拷贝�?
   * 或直接使�?getMessagesMutable() 获取可变引用�?
   */
  private frozenMessages: AgentMessage[] = this.messages;
  private turnCount = 0;
  private lastTurnAt: string | undefined;

  constructor(private readonly options: ConversationEngineOptions) {}

  /**
   * 刷新 frozenMessages 别名引用�?
   *
   * 在每次消息变更后调用�?
   * - in-place 变更（push）：no-op，因两者本就指向同一数组�?
   * - 重赋值变更（this.messages = ...）：更新别名指向新数组�?
   *
   * 统一在所有变更点调用，确�?frozenMessages 永远�?messages 同步�?
   * �?getMessages() 提供 O(1) 无拷贝返回的保证�?
   */
  private refreshFrozenView(): void {
    this.frozenMessages = this.messages;
  }

  /**
   * 初始化对话（添加系统提示�?
   */
  initialize(): void {
    if (this.messages.length > 0) return;
    this.messages.push({
      id: createId("system"),
      role: "system",
      blocks: [{ type: "text", text: this.options.systemPrompt }],
      createdAt: nowIso()
    });
    this.refreshFrozenView();
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
    this.refreshFrozenView();
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
   * 批量追加工具结果消息�?
   *
   * 系统化改进：将多�?tool_result block 合并为单�?`role: "tool"` 消息�?
   * 而非每个结果单独成消息。这减少了消息数量与 provider 请求体的结构膨胀�?
   *
   * 兼容性说明：
   * - OpenAI Chat Completions 构建器（openai-request-build.ts buildChatMessages�?
   *   �?Responses API 构建器（buildResponsesInput）均通过 `for (const block of message.blocks)`
   *   遍历 `role: "tool"` 消息�?blocks，为每个 tool-result 生成独立的输出项�?
   *   因此单条消息含多�?tool_result block 完全兼容�?
   * - 上下文压缩（context-compression.ts）同样遍�?blocks，兼容�?
   * - 未采�?Anthropic 风格�?`role: "user"` + �?tool_result block 方案�?
   *   因为现有代码（openai-request-build / context-compression / agent-session-loop /
   *   task-snapshot-projection）均通过 `role === "tool"` 识别工具结果消息�?
   *   改为 user 角色会破坏这些消费者，需要跨文件改动，风险过高�?
   *
   * 注意：此方法当前在运行时未被调用（实际工具结果追加发生在 agent-session-loop.ts
   * 通过 recordMessage -> appendMessage 逐条追加）。此处的批量化实现为未来
   * 将调用方迁移到本方法做好准备。如需消除运行时的消息膨胀，需另行修改
   * agent-session-loop.ts �?executing-tools 分支（超出本次改动范围）�?
   *
   * @returns 包含单条批量消息的数组（空输入时返回空数组）。保持原 `AgentMessage[]`
   *          返回签名以兼�?API�?
   */
  appendToolResults(results: ToolResultBlock[]): AgentMessage[] {
    if (results.length === 0) return [];
    const message: AgentMessage = {
      id: createId("tool"),
      role: "tool",
      blocks: results.slice(),
      createdAt: nowIso()
    };
    this.messages.push(message);
    this.refreshFrozenView();
    return [message];
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

    const textBlocks = this.buildTextBlocks(response.text);
    const toolCalls = this.buildToolCallBlocks(response.toolCalls);
    const blocks = [...textBlocks, ...toolCalls];

    this.appendAssistantMessage(blocks);

    const shouldContinue = toolCalls.length > 0 && this.turnCount < this.options.maxTurns;
    const endReason = this.determineEndReason(shouldContinue, toolCalls.length);

    return {
      assistantMessage: this.messages.at(-1)!,
      toolCalls,
      shouldContinue,
      ...(endReason !== undefined ? { endReason } : {}),
      diagnostics: response.diagnostics
    };
  }

  private buildTextBlocks(text: string | undefined): AgentMessageBlock[] {
    if (!text) return [];
    return [{ type: "text", text }];
  }

  private buildToolCallBlocks(toolCalls: ProviderResponse["toolCalls"]): ToolCallBlock[] {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map((call) => ({
      type: "tool-call",
      id: call.id,
      toolName: call.toolName,
      input: call.input,
    }));
  }

  private determineEndReason(shouldContinue: boolean, toolCallCount: number): TurnEndReason | undefined {
    if (shouldContinue) return undefined;
    return toolCallCount > 0 ? "max-turns" : "stop";
  }

  /**
   * 获取当前消息列表（O(1)，无拷贝）�?
   *
   * 返回内部 frozenMessages 引用：调用方必须将返回的数组视为只读，不得直接修�?
   * （如 push/splice/pop 等）。如需修改，请自行 `.slice()` 拷贝，或使用
   * getMessagesMutable() 获取可变引用�?
   *
   * 已确认所有调用方（agent-session-loop.ts）均不修改返回数组：
   * - conversationNeedsTextSynthesis：只读遍�?+ 局�?slice 子拷�?
   * - SteeringContext.messages / TurnContext.messages：传递给评估/hook 的只读消�?
   */
  getMessages(): AgentMessage[] {
    return this.frozenMessages;
  }

  /**
   * 获取 Turn 计数
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * 是否达到最大轮�?
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
      lastTurnAt: this.lastTurnAt,
    };
  }

  /**
   * 从快照恢�?
   */
  restoreFromSnapshot(snapshot: ConversationSnapshot): void {
    this.messages = [...snapshot.messages];
    this.turnCount = snapshot.turnCount;
    this.lastTurnAt = snapshot.lastTurnAt ?? this.lastTurnAt;
    this.refreshFrozenView();
  }

  /**
   * 追加任意消息（用�?system steering、恢复消息等场景�?
   */
  appendMessage(message: AgentMessage): void {
    this.messages.push(message);
    this.refreshFrozenView();
  }

  /**
   * 替换消息列表（用于压缩后�?
   */
  replaceMessages(messages: AgentMessage[]): void {
    this.messages = [...messages];
    this.refreshFrozenView();
  }

  /**
   * 获取消息列表的可变引�?
   *
   * 仅用�?runtime 内部需要直接操作消息数组的场景（如上下文压缩）�?
   * 调用者应优先使用 appendMessage / replaceMessages 等方法�?
   */
  getMessagesMutable(): AgentMessage[] {
    return this.messages;
  }

  /**
   * 检测运行时恢复需求（工具错误循环、重复调用循环）�?
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
   * 应用运行时纠偏（runtime steering）�?
   *
   * 当检测到工具错误循环或重复调用循环时，注入系统纠偏消息�?
   *
   * @param reason - 恢复原因
   * @param steeringCount - 当前纠偏计数
   * @param maxSteeringMessages - 最大纠偏次�?
   * @returns 纠偏后的消息和新的计�?
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
