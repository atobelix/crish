/**
 * AgentSessionLoop - 单状态机驱动的核心循环
 *
 * 替代 runtime.ts 中的双层 while 循环 + 双状态机（RunLifecycle + TurnLoop），
 * 使用单一 AgentSession 状态机驱动整个运行周期。
 *
 * 关键改进：
 * - turn-end 事件只在 turn-complete 状态发射一次（消除 9 处重复）
 * - 状态机是主动控制器，不是被动记录器
 * - 统一输入队列，不区分输入来源
 */

import type {
  AgentEvent,
  AgentMessage,
  ContextCompressionRecord,
  JsonObject,
  PermissionDecision,
  PermissionRequest,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolBatchCall,
  ToolBatchResult,
  ToolBatchFailurePolicy,
  ToolCallBlock,
  ToolOutput,
  ToolResultBlock,
  ToolExecutionContext,
} from "@crish/shared-types";
import { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS, DEFAULT_MAX_TURNS } from "@crish/shared-types";
import type {
  AgentRuntimeOptions,
  AgentTool,
  RuntimePermissionPolicy,
  RuntimePermissionRequest,
} from "./types";
import type { ProviderStreamContractEvent } from "./provider-stream-contract";
import { ConversationEngine, ToolExecutor, ProviderCallGateway, ContextManager, ProgressEventQueue, ProviderResponseConsumer, ContextCompressionGate, SingleToolExecutor } from "./runtime-components";
import type { ToolExecuteHook } from "./runtime-components";
import { TokenTracker } from "./provider-transport/token-tracker";
import {
  flushEvents,
  withSessionEntryMetadata,
  isNoProgressAssistant,
  checkpointRecordsFromToolResult,
  checkpointRestoreRecordFromToolResult,
  validationAdviceForToolInput,
  isExpiredApprovalDecision,
  summarizeToolCall,
  isToolTimeoutCause,
  abortReason,
  unrefTimer,
  runtimeSteeringText,
} from "./runtime-helpers";
import { assemblePromptForProvider, type PromptAssemblyContextBlock } from "./prompt-assembly";
import { type ProviderStreamFinishReason } from "./provider-stream-contract";
import { createId, createTextMessage, nowIso, SessionRecorder } from "./session";
import { combineAbortSignals } from "@crish/shared-utils";
import { validateToolInput } from "./tools";
import {
  createAgentSessionMachine,
  shouldStopForMaxTurns,
  type AgentSessionContext,
  type AgentSessionState,
  type AgentSessionEvent,
  type AgentEndReason,
} from "./state-machine/agent-session";
import { AgentInputQueue } from "./agent-input-queue";
import type { ConexStateMachine } from "./state-machine/core";
import {
  SteeringCoordinator,
  RecoverySteeringStrategy,
  type SteeringContext,
  type SteeringPhase,
  type SteeringAction,
} from "./steering";
import {
  ExtensionRegistry,
  type AgentHooks as AgentHooksType,
  type HookContext,
  type TurnContext,
  type ErrorContext,
} from "./hooks";

// ─── 内部类型 ─────────────────────────────────────────────

interface ToolExecutionReliabilityOptions {
  timeoutMs: number;
  parallelFailurePolicy: ToolBatchFailurePolicy;
}

// ─── 辅助函数 ─────────────────────────────────────────────

function runtimeStopReasonFromProviderFinishReason(reason: ProviderStreamFinishReason): "stop" | "tool-call" | "length" | "error" {
  if (reason === "tool-call" || reason === "length" || reason === "error") return reason;
  if (reason === "cancelled") return "error";
  return "stop";
}

function normalizeToolExecutionOptions(options: AgentRuntimeOptions["toolExecution"]): ToolExecutionReliabilityOptions {
  return {
    timeoutMs: positiveIntegerLocal(options?.timeoutMs, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS),
    parallelFailurePolicy: options?.parallelFailurePolicy ?? "continue-drain"
  };
}

/**
 * 最近一轮用户输入之后：用过工具，却几乎没有助手正文 → 需要强制收尾总结。
 */
function isTransientProviderError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b502\b/.test(m) ||
    /\b503\b/.test(m) ||
    /\b504\b/.test(m) ||
    /\b520\b/.test(m) ||
    /bad gateway/.test(m) ||
    /gateway timeout/.test(m) ||
    /rate.?limit/.test(m) ||
    /timeout|timed out/.test(m) ||
    /econnreset|enotfound|fetch failed|network|socket/.test(m) ||
    /temporarily unavailable|overloaded|server error/.test(m)
  );
}

/**
 * 可中止的 sleep：与 AbortSignal 竞态，避免重试等待阻塞 abort。
 */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function conversationNeedsTextSynthesis(conversation: ConversationEngine): boolean {
  const messages = conversation.getMessages();
  if (messages.length === 0) return false;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return false;

  const after = messages.slice(lastUserIdx + 1);
  // 忽略我们自己注入的收尾提示后的空窗
  let sawTool = false;
  let proseChars = 0;
  for (const m of after) {
    if (m.role === "tool") {
      sawTool = true;
      continue;
    }
    if (m.role === "assistant") {
      for (const b of m.blocks ?? []) {
        if (b.type === "tool-call") sawTool = true;
        if (b.type === "text" && typeof (b as { text?: string }).text === "string") {
          proseChars += (b as { text: string }).text.trim().length;
        }
      }
    }
  }
  return sawTool && proseChars < 40;
}

function positiveIntegerLocal(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && Number.isInteger(value)) return value;
  return fallback;
}

// ─── AgentSessionLoop ─────────────────────────────────────

export class AgentSessionLoop {
  private readonly machine: ConexStateMachine<AgentSessionState, AgentSessionEvent, AgentSessionContext>;
  private readonly toolExecution: ToolExecutionReliabilityOptions;
  private readonly toolExecutor: ToolExecutor;
  private readonly steeringCoordinator: SteeringCoordinator;
  private readonly extensionRegistry: ExtensionRegistry;
  private readonly composedHooks: Partial<AgentHooksType>;
  private readonly providerConsumer: ProviderResponseConsumer;
  private readonly compressionGate: ContextCompressionGate;
  private readonly singleToolExecutor: SingleToolExecutor;
  private readonly permissionPolicy: RuntimePermissionPolicy;
  /** 工具回合结束后若无文字总结，最多强制收尾一次，避免「只有工具、没有回复」 */
  private synthesisNudgeUsed = false;
  /** 本 run 是否执行过工具（比扫 messages 更稳） */
  private sawToolsThisRun = false;
  /** 上游 502/网络等瞬时错误重试次数 */
  private providerTransientRetries = 0;
  private static readonly MAX_PROVIDER_TRANSIENT_RETRIES = 3;

  constructor(
    private readonly options: AgentRuntimeOptions,
    private readonly inputQueue: AgentInputQueue,
    private readonly conversation: ConversationEngine,
    private readonly contextManager: ContextManager,
    private readonly providerGateway: ProviderCallGateway,
    private readonly tools: AgentTool[],
    private readonly abortController: AbortController,
    private readonly recorder: SessionRecorder,
    private readonly sessionId: string,
    private readonly tokenTracker: TokenTracker,
    permissionPolicy: RuntimePermissionPolicy,
    extensionRegistry?: ExtensionRegistry,
  ) {
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.toolExecution = normalizeToolExecutionOptions(options.toolExecution);
    this.toolExecutor = new ToolExecutor({
      timeoutMs: this.toolExecution.timeoutMs,
      parallelFailurePolicy: this.toolExecution.parallelFailurePolicy,
    });
    this.machine = createAgentSessionMachine(this.sessionId, maxTurns);
    this.providerConsumer = new ProviderResponseConsumer();
    this.compressionGate = new ContextCompressionGate(contextManager);
    this.singleToolExecutor = new SingleToolExecutor(this.toolExecution.timeoutMs, []);
    this.permissionPolicy = permissionPolicy;

    this.extensionRegistry = extensionRegistry ?? new ExtensionRegistry();
    this.composedHooks = this.extensionRegistry.collectHooks();

    const recoveryOptions = this.options.recovery;
    this.steeringCoordinator = new SteeringCoordinator(
      this.conversation,
      [
        new RecoverySteeringStrategy({
          maxConsecutiveToolErrors: recoveryOptions?.maxConsecutiveToolErrors,
          maxRepeatedToolCalls: recoveryOptions?.maxRepeatedToolCalls,
          maxSteeringMessages: recoveryOptions?.maxSteeringMessages ?? 1,
        }),
      ],
      {
        maxSteeringBudget: recoveryOptions?.maxSteeringMessages ?? 1,
      },
    );
  }

  /**
   * 主循环：状态机解释器
   *
   * 每个 case 只关心"当前状态要做什么"，
   * 下一个状态完全由 send() 的参数决定。
   */
  async *run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]> {
    const userMessage = typeof userInput === "string" ? createTextMessage("user", userInput) : userInput;
    this.inputQueue.enqueue(userMessage);

    // idle → awaiting-input
    this.dispatch("INITIALIZED");

    const startEvent: AgentEvent = { type: "agent-start", sessionId: this.sessionId, timestamp: nowIso() };
    yield* this.recordEvent(startEvent, this.recorder);

    let endReason: AgentEndReason = "stop";
    let endError: string | undefined;

    // ─── 状态机解释器 ───────────────────────────────────────
    while (!this.machine.is("done")) {
      const state = this.machine.getCurrent();

      try {
      switch (state) {
        // ── awaiting-input: 从队列中取输入，注入对话 ──────────
        case "awaiting-input": {
          if (this.abortController.signal.aborted) {
            this.dispatch("ABORT");
            endReason = "aborted";
            break;
          }

          const input = this.inputQueue.dequeue();
          if (!input) {
            this.dispatch("NO_INPUT");
            break;
          }

          // 记录用户消息（emit message-start/end + append to conversation）
          yield* this.recordMessage(input, this.conversation, this.recorder);
          this.dispatch("INPUT_READY");
          break;
        }

        // ── preparing-turn: recovery + compression ──────────
        case "preparing-turn": {
          if (this.abortController.signal.aborted) {
            this.dispatch("ABORT");
            endReason = "aborted";
            break;
          }

          // ★ 智能 Steer 注入点（仅在工具调用迭代时注入，新输入周期由 awaiting-input 处理）
          if (this.machine.getContext().toolCallCount > 0 && this.inputQueue.hasPending()) {
            const steerInput = this.inputQueue.dequeue();
            if (steerInput) {
              yield* this.recordMessage(steerInput, this.conversation, this.recorder);
            }
          }

          const turnIndex = this.machine.getContext().turnIndex + 1;

          // 发射 turn-start
          yield* this.recordEvent(
            { type: "turn-start", sessionId: this.sessionId, turnIndex, timestamp: nowIso() },
            this.recorder
          );

          // 纠偏评估（通过 SteeringCoordinator）
          const recoveryOptions = this.options.recovery;
          if (recoveryOptions?.enabled !== false) {
            const steeringContext: SteeringContext = {
              messages: this.conversation.getMessages(),
              turnIndex: this.machine.getContext().turnIndex,
              steeringCount: this.steeringCoordinator.getSteeringCount(),
              toolCallCount: this.machine.getContext().toolCallCount,
              hasPendingInput: this.inputQueue.hasPending(),
            };
            // 评估 after-tools 策略（恢复检测：工具错误循环、重复调用）
            const afterToolsEvaluation = this.steeringCoordinator.evaluate("after-tools", steeringContext);
            const afterToolsApplied = this.steeringCoordinator.apply(afterToolsEvaluation.actions, this.sessionId);
            yield* flushEvents(afterToolsApplied.events);
            if (afterToolsApplied.interventionRequired) {
              endReason = "error";
              endError = "Runtime intervention required";
              this.dispatch("INTERVENTION_REQUIRED");
              break;
            }
            // 评估 before-turn 策略（Goal audit 等）
            const beforeTurnContext: SteeringContext = {
              ...steeringContext,
              steeringCount: this.steeringCoordinator.getSteeringCount(),
            };
            const beforeTurnEvaluation = this.steeringCoordinator.evaluate("before-turn", beforeTurnContext);
            const beforeTurnApplied = this.steeringCoordinator.apply(beforeTurnEvaluation.actions, this.sessionId);
            yield* flushEvents(beforeTurnApplied.events);
            if (beforeTurnApplied.interventionRequired) {
              endReason = "error";
              endError = "Runtime intervention required";
              this.dispatch("INTERVENTION_REQUIRED");
              break;
            }
          }

          // 上下文压缩
          const compressionResult = await this.compressionGate.maybeCompress(this.conversation.getMessagesMutable());
          if (compressionResult.compressed) {
            this.conversation.replaceMessages(compressionResult.messages);
          }

          this.dispatch("TURN_PREPARED");
          break;
        }

        // ── streaming: 调用 Provider，收集助手消息 ────────────
        case "streaming": {
          const callIterator = this.buildProviderCall();
          // 流式 delta 经队列边收边 yield，避免只能等整段 message-end
          const deltaQueue: AgentEvent[] = [];
          let deltaWaiters: Array<() => void> = [];
          const wake = () => {
            const w = deltaWaiters;
            deltaWaiters = [];
            for (const r of w) r();
          };
          const consumePromise = this.providerConsumer.consume(
            callIterator,
            this.tools,
            this.abortController.signal,
            (d) => {
              deltaQueue.push({
                type: "message-delta",
                sessionId: this.sessionId,
                block:
                  d.kind === "thought"
                    ? {
                        type: "thought",
                        text: d.text,
                        ...(d.redacted !== undefined ? { redacted: d.redacted } : {}),
                      }
                    : { type: "text", text: d.text },
                timestamp: nowIso(),
              } as AgentEvent);
              wake();
            },
          );
          let consumeResult: Awaited<ReturnType<ProviderResponseConsumer["consume"]>> | undefined;
          const done = consumePromise.then((r) => {
            consumeResult = r;
            wake();
            return r;
          });
          while (true) {
            while (deltaQueue.length > 0) {
              const next = deltaQueue.shift()!;
              yield* this.emitEvent(next);
            }
            if (consumeResult) break;
            await Promise.race([
              done,
              new Promise<void>((resolve) => {
                deltaWaiters.push(resolve);
              }),
            ]);
          }
          while (deltaQueue.length > 0) {
            yield* this.emitEvent(deltaQueue.shift()!);
          }
          if (!consumeResult) {
            consumeResult = await done;
          }

          // emit 在流期间收集的 provider-diagnostic 事件
          for (const diagnostic of consumeResult.diagnostics) {
            yield* this.emitEvent({
              type: "provider-diagnostic",
              sessionId: this.sessionId,
              diagnostic,
              timestamp: nowIso(),
            });
          }

          const assistantResult = consumeResult.response;

          if (assistantResult.type === "error") {
            if (this.abortController.signal.aborted) {
              endReason = "aborted";
              this.dispatch("ABORT");
              break;
            }
            const errMsg = assistantResult.error ?? "Provider stream failed";
            // 502 / 网络等瞬时错误：退避重试，不立刻杀死 agent
            if (
              isTransientProviderError(errMsg) &&
              this.providerTransientRetries < AgentSessionLoop.MAX_PROVIDER_TRANSIENT_RETRIES
            ) {
              this.providerTransientRetries += 1;
              const waitMs = 600 * this.providerTransientRetries;
              yield* this.emitEvent({
                type: "provider-diagnostic",
                sessionId: this.sessionId,
                diagnostic: {
                  phase: "retry",
                  message: `Transient provider error, retry ${this.providerTransientRetries}/${AgentSessionLoop.MAX_PROVIDER_TRANSIENT_RETRIES}: ${errMsg}`,
                },
                timestamp: nowIso(),
              } as AgentEvent);
              await sleepMs(waitMs, this.abortController.signal);
              this.dispatch("NO_PROGRESS_CONTINUE");
              break;
            }
            // 仍有工具成果：软降级，让模型基于已有结果收尾，而不是整 run 失败
            if (this.sawToolsThisRun && !this.synthesisNudgeUsed) {
              this.synthesisNudgeUsed = true;
              this.inputQueue.enqueue(
                createTextMessage(
                  "user",
                  `【系统】上游模型暂时失败：${errMsg.slice(0, 240)}。请仅基于已完成的工具结果给出结论；不要再调用工具。若必须停止请说明原因。`,
                ),
              );
              this.dispatch("INPUT_AVAILABLE");
              break;
            }
            // 致命 provider 错误：走 onError hook，并对外暴露 runtime-error
            const providerError = new Error(errMsg);
            const action = this.handleErrorWithHook(providerError, state);
            yield* this.emitEvent({
              type: "runtime-error",
              sessionId: this.sessionId,
              timestamp: nowIso(),
              error: errMsg,
            });
            if (action === "retry") {
              this.dispatch("NO_PROGRESS_CONTINUE");
              break;
            }
            if (action === "skip") {
              this.dispatchErrorRecovery(state);
              break;
            }
            endReason = "error";
            endError = errMsg;
            this.dispatch("PROVIDER_ERROR");
            break;
          }
          // 成功一轮后清零瞬时重试计数
          this.providerTransientRetries = 0;

          if (assistantResult.type === "empty-response") {
            this.dispatch("STEERING_NEEDED");
            break;
          }

          // Only "message" type reaches here
          const msg = assistantResult.message;
          this.conversation.appendMessage(msg);
          const assistantEntry = await this.recorder.recordMessage(msg);
          yield* this.recordEvent(
            { type: "message-end", sessionId: this.sessionId, message: withSessionEntryMetadata(msg, assistantEntry) },
            this.recorder
          );

          if (msg.metadata?.stopReason === "error") {
            endReason = "error";
            endError = typeof msg.metadata.error === "string" ? msg.metadata.error : "Provider stream failed";
            this.dispatch("PROVIDER_ERROR");
            break;
          }

          // Check for tool calls
          const toolCalls = msg.blocks.filter(
            (block): block is ToolCallBlock => block.type === "tool-call"
          );

          if (toolCalls.length === 0) {
            // Assistant 正常停止，无 tool calls
            this.steeringCoordinator.resetSteeringCount();
            this.dispatch("NO_TOOL_CALLS");
            break;
          }

          // 有 tool calls，进入执行状态
          this.dispatch("HAS_TOOL_CALLS", { count: toolCalls.length });
          break;
        }

        // ── steering-evaluation: 评估并执行纠偏动作 ──────────
        case "steering-evaluation": {
          const steerCtx = this.machine.getContext();
          const maxSteeringMessages = this.options.recovery?.maxSteeringMessages ?? 3;
          if (steerCtx.steeringCount > maxSteeringMessages) {
            endReason = "error";
            endError = "Steering budget exhausted";
            this.dispatch("STEERING_BUDGET_EXHAUSTED");
            break;
          }

          const steeringContext = {
            messages: this.conversation.getMessages(),
            turnIndex: steerCtx.turnIndex,
            steeringCount: steerCtx.steeringCount,
            toolCallCount: steerCtx.toolCallCount,
            hasPendingInput: this.inputQueue.hasPending(),
          };
          const evaluation = this.steeringCoordinator.evaluate("empty-response", steeringContext);

          if (evaluation.actions.length === 0) {
            endReason = "error";
            endError = "No steering strategy handled empty response";
            this.dispatch("STEERING_BUDGET_EXHAUSTED");
            break;
          }

          const applied = this.steeringCoordinator.apply(evaluation.actions, this.sessionId);
          yield* flushEvents(applied.events);

          if (applied.interventionRequired) {
            endReason = "error";
            endError = "Runtime intervention required";
            this.dispatch("INTERVENTION_REQUIRED");
            break;
          }

          this.dispatch("STEERING_COMPLETE");
          break;
        }

        // ── executing-tools: 批量执行工具调用 ─────────────────
        case "executing-tools": {
          // 重新获取 tool calls（从最后一条 assistant 消息）
          const messages = this.conversation.getMessagesMutable();
          const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
          const toolCalls = lastAssistant
            ? lastAssistant.blocks.filter((b): b is ToolCallBlock => b.type === "tool-call")
            : [];

          const toolResults = yield* this.executeToolCalls(toolCalls, this.tools, this.recorder);
          this.sawToolsThisRun = true;
          if (toolResults.every((block) => !block.isError)) {
            this.steeringCoordinator.resetSteeringCount();
          }
          for (const block of toolResults) {
            const message: AgentMessage = {
              id: createId("tool"),
              role: "tool",
              createdAt: nowIso(),
              blocks: [block]
            };
            yield* this.recordMessage(message, this.conversation, this.recorder);
          }

          this.dispatch("TOOLS_COMPLETE");
          break;
        }

        // ── turn-complete: 发射 turn-end，决定下一步 ──────────
        case "turn-complete": {
          const ctx = this.machine.getContext();

          // ★ 唯一的 turn-end 发射点（消除 9 处重复）
          yield* this.recordEvent(
            {
              type: "turn-end",
              sessionId: this.sessionId,
              turnIndex: ctx.turnIndex,
              timestamp: nowIso(),
              toolCallCount: ctx.toolCallCount,
            },
            this.recorder
          );

          // 决定下一步
          if (ctx.abortReason || this.abortController.signal.aborted) {
            endReason = ctx.endReason === "error" ? "error" : "aborted";
            endError = endError ?? (ctx.abortReason as string | undefined) ?? (abortReason(this.abortController.signal) as string | undefined);
            this.dispatch("FINISH");
          } else if (ctx.endReason === "error") {
            endReason = "error";
            this.dispatch("FINISH");
          } else if (ctx.endReason === "aborted") {
            endReason = "aborted";
            this.dispatch("FINISH");
          } else if (shouldStopForMaxTurns(ctx)) {
            // 触顶前若仍只有工具没有结论，先抢一轮收尾（仍计入合成预算）
            if (
              !this.synthesisNudgeUsed &&
              this.sawToolsThisRun &&
              conversationNeedsTextSynthesis(this.conversation)
            ) {
              this.synthesisNudgeUsed = true;
              this.inputQueue.enqueue(
                createTextMessage(
                  "user",
                  "轮次将尽。请立刻基于已有工具结果给出完整中文总结与建议，不要再调用工具。",
                ),
              );
              this.dispatch("INPUT_AVAILABLE");
            } else {
              endReason = "max-turns";
              this.dispatch("MAX_TURNS_REACHED");
            }
          } else if (this.composedHooks.shouldStopAfterTurn) {
            // ★ Hook: shouldStopAfterTurn — 如果任何注册的 Hook 返回 true，提前终止
            const turnCtx: TurnContext = {
              sessionId: this.sessionId,
              turnIndex: ctx.turnIndex,
              maxTurns: ctx.maxTurns,
              messages: this.conversation.getMessages(),
              toolCallCount: ctx.toolCallCount,
              toolCalls: [],
              cwd: this.options.cwd,
              hasPendingInput: this.inputQueue.hasPending(),
              isAborted: this.abortController.signal.aborted,
            };
            if (this.composedHooks.shouldStopAfterTurn(turnCtx)) {
              endReason = "stop";
              this.dispatch("SHOULD_STOP");
            } else if (ctx.toolCallCount > 0) {
              this.dispatch("NEXT_TURN");
            } else if (this.inputQueue.hasPending()) {
              this.dispatch("INPUT_AVAILABLE");
            } else {
              this.dispatch("SHOULD_STOP");
            }
          } else if (ctx.toolCallCount > 0) {
            // 工具调用迭代继续：回到 preparing-turn 进行下一轮 provider 调用
            this.dispatch("NEXT_TURN");
          } else if (this.inputQueue.hasPending()) {
            // 无工具调用但有新输入：切换到新输入周期
            this.dispatch("INPUT_AVAILABLE");
          } else if (
            !this.synthesisNudgeUsed &&
            this.sawToolsThisRun &&
            conversationNeedsTextSynthesis(this.conversation)
          ) {
            // 已跑过工具但尚无实质文字结论：注入一次收尾提示，禁止再空停
            this.synthesisNudgeUsed = true;
            this.inputQueue.enqueue(
              createTextMessage(
                "user",
                "请基于以上工具结果，用完整中文给出分析结论与下一步建议。不要再调用工具；若信息不足请明确说明缺什么。",
              ),
            );
            this.dispatch("INPUT_AVAILABLE");
          } else {
            // 正常停止
            this.dispatch("SHOULD_STOP");
          }
          break;
        }

        // ── idle/done: 不应到达 ────────────────────────────
        default:
          break;
      }
      } catch (cause) {
        // 未预期异常：交给 onError hook 决定 retry / skip / abort
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const action = this.handleErrorWithHook(error, state);
        yield* this.emitEvent({
          type: "runtime-error",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          error: error.message,
        });
        if (action === "retry") {
          // 保持当前状态，下一轮循环重试
          continue;
        }
        if (action === "skip") {
          // 跳过本次错误，尽量推进到下一安全状态
          this.dispatchErrorRecovery(state);
          continue;
        }
        endReason = "error";
        endError = error.message;
        this.dispatchFatalError(state);
      }
    }

    // ─── 收尾 ─────────────────────────────────────────────
    const finalCtx = this.machine.getContext();
    if (finalCtx.endReason !== "stop") {
      endReason = finalCtx.endReason;
    }

    yield* this.recordEvent(
      {
        type: "agent-end",
        sessionId: this.sessionId,
        timestamp: nowIso(),
        reason: endReason,
        error: endError,
      },
      this.recorder
    );

    return this.conversation.getMessagesMutable();
  }

  private async *executeToolCalls(
    toolCalls: ToolCallBlock[],
    tools: AgentTool[],
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
    const self = this;
    const executeOne: ToolExecuteHook = async function* (toolCall, _tools, _sessionId, _cwd, signal, batchId) {
      return yield* self.executeSingleTool(toolCall, _tools, batchId, signal, recorder);
    };

    const batchResults: ToolBatchResult[] = yield* relayAndRecord(
      this.toolExecutor.executeBatchWithEvents(
        toolCalls,
        tools,
        this.sessionId,
        this.options.cwd,
        this.abortController.signal,
        executeOne
      ),
      recorder
    );

    return batchResults.map(
      (result): ToolResultBlock => ({
        type: "tool-result",
        toolCallId: result.id,
        toolName: result.toolName,
        output: result.output,
        isError: result.isError,
      })
    );
  }

  private async *executeSingleTool(
    toolCall: ToolCallBlock,
    tools: AgentTool[],
    batchId: string,
    signal: AbortSignal,
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, ToolBatchResult> {
    const startedAt = Date.now();
    const call = this.toBatchCall(toolCall, tools);

    yield* this.emitEvent({ type: "tool-start", sessionId: this.sessionId, batchId, call, timestamp: nowIso() });

    const tool = tools.find((candidate) => candidate.name === toolCall.toolName);
    if (!tool) {
      const result = this.toToolBatchResult(call, startedAt, { text: `Tool not found: ${toolCall.toolName}` }, true);
      yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
      return result;
    }

    // ★ Hook: beforeToolCall — 如果注册了 Hook，在工具执行前拦截
    let effectiveInput = toolCall.input;
    let inputModifiedByHook = false;
    if (this.composedHooks.beforeToolCall) {
      const hookCtx: HookContext = {
        sessionId: this.sessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        tool,
        input: toolCall.input,
        cwd: this.options.cwd,
        turnIndex: this.machine.getContext().turnIndex,
      };
      const beforeResult = await this.composedHooks.beforeToolCall(hookCtx);
      if (beforeResult.block) {
        const result = this.toToolBatchResult(
          call, startedAt,
          { text: beforeResult.reason ?? `Tool call blocked by hook: ${toolCall.toolName}` },
          true
        );
        yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
        return result;
      }
      if (beforeResult.modifiedInput) {
        effectiveInput = beforeResult.modifiedInput;
        inputModifiedByHook = true;
      }
    }

    const effectiveToolCall: ToolCallBlock = inputModifiedByHook ? { ...toolCall, input: effectiveInput } : toolCall;
    if (inputModifiedByHook) {
      yield* this.emitEvent({
        type: "tool-input-repaired",
        sessionId: this.sessionId,
        timestamp: nowIso(),
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        notes: ["beforeToolCall modified tool input"],
      });
    }

    const validationErrors = validateToolInput(tool, effectiveInput);
    if (validationErrors.length > 0) {
      const advice = validationAdviceForToolInput(tool, effectiveInput, validationErrors);
      const result = this.toToolBatchResult(
        call,
        startedAt,
        { text: [`Tool input validation failed:`, ...validationErrors.map((error) => `- ${error}`), ...advice].join("\n") },
        true
      );
      yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
      return result;
    }

    const permission = yield* this.resolvePermission(tool, effectiveInput, toolCall.id);
    if (permission.behavior !== "allow") {
      if (isExpiredApprovalDecision(permission)) {
        yield* this.emitEvent(
          {
            type: "runtime-error",
            sessionId: this.sessionId,
            timestamp: nowIso(),
            error: permission.reason ?? "Approval expired"
          }
        );
        throw new Error(permission.reason ?? "Approval expired");
      }
      const result = this.toToolBatchResult(call, startedAt, { text: permission.reason ?? "Tool execution denied" }, true);
      yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
      return result;
    }

    if (signal.aborted) {
      const cause = abortReason(signal);
      const output = await this.materializeLargeToolOutput(
        effectiveToolCall,
        { text: isToolTimeoutCause(cause) ? `Tool execution timed out` : `Tool execution cancelled` }
      );
      const result = this.toToolBatchResult(call, startedAt, output, true);
      yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
      return result;
    }

    type ToolExecutionItem =
      | { type: "event"; event: AgentEvent }
      | { type: "result"; result: Awaited<ReturnType<SingleToolExecutor["execute"]>> };

    const toolEventQueue = new ProgressEventQueue<ToolExecutionItem>();
    const context: ToolExecutionContext = {
      toolCallId: toolCall.id,
      sessionId: this.sessionId,
      cwd: this.options.cwd,
      signal,
      emit: (update) => {
        toolEventQueue.push({
          type: "event",
          event: {
            type: "tool-update",
            sessionId: this.sessionId,
            batchId,
            toolCallId: toolCall.id,
            update,
            timestamp: nowIso(),
          },
        });
      },
      metadata: { subagentDepth: this.options.subagentDepth ?? 0 }
    };

    void this.singleToolExecutor.execute(
      effectiveToolCall,
      (input, ctx) => tool.execute(input, ctx),
      context,
      signal,
    ).then(
      (result) => {
        toolEventQueue.push({ type: "result", result });
      },
      (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        toolEventQueue.push({
          type: "result",
          result: { output: { text: message }, isError: true },
        });
      }
    );

    let execResult: Awaited<ReturnType<SingleToolExecutor["execute"]>> | undefined;
    while (!execResult) {
      const next = await toolEventQueue.next();
      if (next.done) break;
      if (next.value.type === "event") {
        yield* this.emitEvent(next.value.event);
        continue;
      }
      execResult = next.value.result;
    }
    toolEventQueue.close();

    if (!execResult) {
      execResult = { output: { text: "Tool execution ended without a result" }, isError: true };
    }

    if (!execResult.isError) {
      let materializedOutput = await this.materializeLargeToolOutput(effectiveToolCall, execResult.output);

      if (this.composedHooks.afterToolCall) {
        const hookCtx: HookContext = {
          sessionId: this.sessionId,
          toolCallId: toolCall.id,
          toolName: toolCall.toolName,
          tool,
          input: effectiveInput,
          output: materializedOutput,
          cwd: this.options.cwd,
          turnIndex: this.machine.getContext().turnIndex,
        };
        const afterResult = await this.composedHooks.afterToolCall(hookCtx);
        if (afterResult.terminate) {
          const result = this.toToolBatchResult(call, startedAt, afterResult.modifiedOutput ?? materializedOutput, false);
          yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
          this.abortController.abort(afterResult.terminateReason ?? "Terminated by afterToolCall hook");
          return result;
        }
        if (afterResult.modifiedOutput) {
          materializedOutput = await this.materializeLargeToolOutput(effectiveToolCall, afterResult.modifiedOutput);
        }
      }

      const result = this.toToolBatchResult(call, startedAt, materializedOutput, false);
      yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
      yield* this.recordToolCheckpointEvents(result, recorder);
      return result;
    }

    // 错误路径 — 构造结构化错误输出
    const isTimeout = signal.aborted && execResult.output?.json && typeof execResult.output.json === 'object' && 'timedOut' in (execResult.output.json as Record<string, unknown>);
    const causeText = isTimeout ? "Tool execution timed out" : (execResult.output?.text ?? "Tool execution error");
    const structuredJson: JsonObject | undefined = isTimeout ? {
      timedOut: true,
      runtimeToolExecution: { status: "timeout", timedOut: true, timeoutMs: this.toolExecution.timeoutMs }
    } : undefined;
    const errorOutput = await this.materializeLargeToolOutput(
      effectiveToolCall,
      { text: causeText, ...(structuredJson ? { json: structuredJson } : {}) }
    );
    const result = this.toToolBatchResult(call, startedAt, errorOutput, true);
    yield* this.emitEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() });
    return result;
  }

  private async materializeLargeToolOutput(toolCall: ToolCallBlock, output: ToolOutput): Promise<ToolOutput> {
    return this.contextManager.materializeOutput(toolCall, output);
  }

  /**
   * 先策略判定，仅 ask 时广播 approval-requested 并挂起。
   * toolCallId 与真实工具调用 id 对齐，避免桌面批准打空。
   */
  private async *resolvePermission(
    tool: AgentTool,
    input: JsonObject,
    toolCallId: string
  ): AsyncGenerator<AgentEvent, PermissionDecision> {
    const request: RuntimePermissionRequest = {
      id: toolCallId,
      sessionId: this.sessionId,
      cwd: this.options.cwd,
      tool,
      input,
      summary: tool.summarize(input),
    };

    // 构造可序列化的 PermissionRequest：从 RuntimePermissionRequest 提取扁平字段，
    // 避免将 AgentTool（含 execute/summarize 等函数）泄漏到事件流。
    const serializableRequest: PermissionRequest = {
      id: toolCallId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      toolCallId,
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

    // 先判定：allow/deny 不广播 approval-requested（避免只读误弹确认）
    let decision = await this.permissionPolicy.decide(request);

    if (decision.behavior === "allow") {
      return decision;
    }

    if (decision.behavior === "deny") {
      yield* this.emitEvent({
        type: "approval-resolved",
        sessionId: this.sessionId,
        requestId: toolCallId,
        decision,
        timestamp: nowIso(),
      });
      return decision;
    }

    // behavior === "ask"：仅此刻请求人工确认并阻塞后续工具
    if (decision.behavior === "ask" && this.options.approvalHandler) {
      const decisionMetadata: JsonObject = {
        ...(decision.metadata ?? {}),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
      const requestWithDecisionMetadata: PermissionRequest = {
        ...serializableRequest,
        ...(Object.keys(decisionMetadata).length > 0
          ? { metadata: { ...(serializableRequest.metadata ?? {}), ...decisionMetadata } }
          : {}),
      };

      yield* this.emitEvent({
        type: "approval-requested",
        sessionId: this.sessionId,
        request: requestWithDecisionMetadata,
        timestamp: nowIso(),
      });

      decision = await this.options.approvalHandler.requestApproval(requestWithDecisionMetadata);

      yield* this.emitEvent({
        type: "approval-resolved",
        sessionId: this.sessionId,
        requestId: toolCallId,
        decision,
        timestamp: nowIso(),
      });
      return decision;
    }

    // ask 但无 handler：安全默认拒绝
    const denied: PermissionDecision = {
      behavior: "deny",
      reason: decision.reason ?? "Approval required but no approval handler configured",
      metadata: { ...(decision.metadata ?? {}), matchedRule: "daemon-ask-no-handler" },
    };
    yield* this.emitEvent({
      type: "approval-resolved",
      sessionId: this.sessionId,
      requestId: toolCallId,
      decision: denied,
      timestamp: nowIso(),
    });
    return denied;
  }

  private async *recordToolCheckpointEvents(result: ToolBatchResult, recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    for (const checkpoint of checkpointRecordsFromToolResult(result)) {
      await recorder.recordCheckpoint(checkpoint.label, checkpoint as unknown as JsonObject);
      await this.options.contextCompression?.contextState?.recordCheckpoint?.(checkpoint);
      yield* this.emitEvent(
        {
          type: "checkpoint-created",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          checkpoint
        }
      );
    }

    const restore = checkpointRestoreRecordFromToolResult(result);
    if (restore) {
      yield* this.emitEvent(
        {
          type: "checkpoint-restored",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          restore
        }
      );
    }
  }

  private toBatchCall(call: ToolCallBlock, tools: AgentTool[]): ToolBatchCall {
    const tool = tools.find((candidate) => candidate.name === call.toolName);
    return {
      id: call.id,
      toolName: call.toolName,
      input: call.input,
      summary: summarizeToolCall(tool, call.input, call.toolName),
      category: tool?.category ?? "internal",
      concurrency: tool?.concurrency ?? "exclusive"
    };
  }

  private toToolBatchResult(call: ToolBatchCall, startedAt: number, output: ToolOutput, isError: boolean): ToolBatchResult {
    return {
      id: call.id,
      toolName: call.toolName,
      output,
      isError,
      durationMs: Date.now() - startedAt
    };
  }

  private async *recordMessage(
    message: AgentMessage,
    conversation: ConversationEngine,
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent> {
    const start: AgentEvent = { type: "message-start", sessionId: this.sessionId, message };
    yield* this.recordEvent(start, recorder);
    conversation.appendMessage(message);
    const entry = await recorder.recordMessage(message);
    yield* this.recordEvent({ type: "message-end", sessionId: this.sessionId, message: withSessionEntryMetadata(message, entry) }, recorder);
  }

  private projectSystemPromptForProvider(): string | undefined {
    return this.contextManager.projectSystemPrompt(this.options.systemPrompt);
  }

  private projectPromptContextForProvider(): {
    stableContext?: PromptAssemblyContextBlock[];
    volatileContext?: PromptAssemblyContextBlock[];
  } {
    return this.contextManager.projectPromptContext(this.options.promptContext);
  }

  private restoreProviderToolInput(input: JsonObject): JsonObject {
    return this.contextManager.restoreProviderToolInput(input);
  }

  private async *recordEvent(event: AgentEvent, recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    await recorder.recordEvent(event);
    yield event;
  }

  private async *emitEvent(event: AgentEvent): AsyncGenerator<AgentEvent> {
    yield event;
  }

  private async emitAndRecord(event: AgentEvent, recorder: SessionRecorder, events?: AgentEvent[]): Promise<void> {
    await recorder.recordEvent(event);
    events?.push(event);
  }

  /**
   * 安全发送状态机事件，检查返回值，失败时抛出 INVALID_TRANSITION。
   */
  private dispatch(event: AgentSessionEvent, payload?: unknown): void {
    const result = this.machine.send(event, payload);
    if (!result.ok) {
      throw new Error(`INVALID_TRANSITION: ${result.message}`);
    }
  }

  /**
   * 构建 Provider 调用，返回流迭代器。
   */
  private buildProviderCall(): AsyncIterable<ProviderStreamContractEvent> {
    const messages = this.conversation.getMessagesMutable();
    const providerSystemPrompt = this.contextManager.projectSystemPrompt(this.options.systemPrompt);
    const providerMessages = this.contextManager.projectForProvider(messages);
    const promptAssembly = assemblePromptForProvider({
      systemPrompt: providerSystemPrompt,
      messages: providerMessages,
      tools: this.tools,
    });

    const providerRequest = {
      sessionId: this.sessionId,
      cwd: this.options.cwd,
      systemPrompt: promptAssembly.payload.systemPrompt,
      messages: promptAssembly.payload.messages,
      tools: promptAssembly.payload.tools,
      promptAssembly: promptAssembly.metadata,
      signal: this.abortController.signal,
    };

    return this.providerGateway.call(this.options.provider, providerRequest);
  }

  /**
   * 通过 Hook 系统处理错误（onError 未注册时默认 abort）
   */
  private handleErrorWithHook(error: Error, state: string): "retry" | "skip" | "abort" {
    if (this.composedHooks.onError) {
      const errorCtx: ErrorContext = {
        sessionId: this.sessionId,
        state,
        turnIndex: this.machine.getContext().turnIndex,
        cwd: this.options.cwd,
      };
      return this.composedHooks.onError(error, errorCtx);
    }
    return "abort";
  }

  /**
   * skip 策略：按当前状态尽量推进，避免卡死；转移失败时回退到 abort。
   */
  private dispatchErrorRecovery(state: AgentSessionState): void {
    const tryDispatch = (event: AgentSessionEvent): boolean => {
      try {
        this.dispatch(event);
        return true;
      } catch {
        return false;
      }
    };
    let ok = false;
    switch (state) {
      case "preparing-turn":
        ok = tryDispatch("TURN_PREPARED");
        break;
      case "streaming":
        ok = tryDispatch("NO_PROGRESS_CONTINUE");
        break;
      case "steering-evaluation":
        ok = tryDispatch("STEERING_COMPLETE");
        break;
      case "executing-tools":
        ok = tryDispatch("TOOLS_COMPLETE");
        break;
      case "awaiting-input":
        ok = tryDispatch("NO_INPUT");
        break;
      case "turn-complete":
        ok = tryDispatch("SHOULD_STOP");
        break;
      default:
        break;
    }
    if (!ok) this.dispatchFatalError(state);
  }

  /**
   * abort 策略：将状态机送入错误终止路径（吞掉二次 INVALID_TRANSITION）。
   */
  private dispatchFatalError(state: AgentSessionState): void {
    const tryDispatch = (event: AgentSessionEvent): boolean => {
      try {
        this.dispatch(event);
        return true;
      } catch {
        return false;
      }
    };
    if (state === "streaming") {
      if (tryDispatch("PROVIDER_ERROR")) return;
    } else if (state === "executing-tools") {
      if (tryDispatch("ABORT")) return;
    } else if (state === "turn-complete") {
      if (tryDispatch("FINISH")) return;
    } else if (state !== "done") {
      if (tryDispatch("ERROR")) return;
    }
    // 兜底：已在 done 或转移失败时不再抛出
  }
}

// ─── 事件中继 ─────────────────────────────────────────────

async function* relayAndRecord<T>(
  source: AsyncGenerator<AgentEvent, T>,
  recorder: SessionRecorder
): AsyncGenerator<AgentEvent, T> {
  let result: T | undefined;
  let done = false;

  while (true) {
    const next = await source.next();
    if (next.done) {
      result = next.value;
      done = true;
      break;
    }
    await recorder.recordEvent(next.value);
    yield next.value;
  }

  if (done) return result as T;
  return undefined as never;
}
