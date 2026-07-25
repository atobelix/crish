/**
 * ToolExecutionCoordinator — 工具执行协调器
 *
 * 从 AgentSessionLoop 提取，负责工具批量执行、单个工具执行与结果处理。
 */

import type { AgentEvent, AgentMessage, JsonObject, PermissionDecision, PermissionRequest, ToolBatchCall, ToolBatchResult, ToolBatchFailurePolicy, ToolCallBlock, ToolOutput, ToolResultBlock, ToolExecutionContext, ToolProgressUpdate } from '@crish/shared-types';
import type { AgentTool, RuntimePermissionPolicy } from '../types';
import { ToolExecutor, SingleToolExecutor, ProgressEventQueue, type ToolExecuteHook } from '../runtime-components';
import type { ConversationEngine } from '../runtime-components';
import type { SessionRecorder } from '../session';
import { createId } from '../session';
import { validateToolInput, repairToolInput } from '../tools';
import { withSessionEntryMetadata, checkpointRecordsFromToolResult, checkpointRestoreRecordFromToolResult, buildPermissionDenyToolOutput, summarizeToolCall, isToolTimeoutCause, abortReason, validationAdviceForToolInput } from '../runtime-helpers';
import type { HookContext, AgentHooks as AgentHooksType, ToolHook, ToolResult } from '../hooks';
import { ApprovalPipeline } from '../approval/approval-pipeline';
import { findFatalToolError } from './types';
import type { ToolExecutionReliabilityOptions } from './types';

export interface ToolExecCtx {
  sessionId: string;
  cwd: string | undefined;
  tools: AgentTool[];
  signal: AbortSignal;
  recorder: SessionRecorder;
  composedHooks: Partial<AgentHooksType>;
  permissionPolicy: RuntimePermissionPolicy;
  approvalPipeline: ApprovalPipeline;
  hooks?: ToolHook<JsonObject, ToolOutput>[];
  contextManager: {
    materializeOutput: (tc: ToolCallBlock, o: ToolOutput) => Promise<ToolOutput>;
    restoreProviderToolInput: (i: JsonObject) => JsonObject;
  };
  machine: { getContext: () => { turnIndex: number } };
  options: { subagentDepth?: number; contextCompression?: { contextState?: { trackFileOp?: (record: any) => void } } };
  conversation: ConversationEngine;
  inputQueue: import('../agent-input-queue').AgentInputQueue;
}

type ToolEvent = { type: 'event'; event: AgentEvent } | { type: 'result'; result: Awaited<ReturnType<SingleToolExecutor['execute']>> };

export class ToolExecutionCoordinator {
  readonly toolExecutor: ToolExecutor;
  readonly singleToolExecutor: SingleToolExecutor;
  readonly toolExecution: ToolExecutionReliabilityOptions;
  sawToolsThisRun = false;

  constructor(toolExecution: ToolExecutionReliabilityOptions) {
    this.toolExecution = toolExecution;
    this.toolExecutor = new ToolExecutor({ timeoutMs: toolExecution.timeoutMs, parallelFailurePolicy: toolExecution.parallelFailurePolicy as ToolBatchFailurePolicy });
    this.singleToolExecutor = new SingleToolExecutor(toolExecution.timeoutMs, []);
  }

  async *executeToolBatch(toolCalls: ToolCallBlock[], ctx: ToolExecCtx): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
    const self = this;
    const executeOne: ToolExecuteHook = async function* (tc: ToolCallBlock, _tools: AgentTool[], _sid: string, _cwd: string, sig: AbortSignal, bid: string) {
      return yield* self.executeSingleTool(tc, _tools, bid, sig, ctx);
    };

    const batchResults: ToolBatchResult[] = yield* relayAndRecord(
      this.toolExecutor.executeBatchWithEvents(toolCalls, ctx.tools, ctx.sessionId, ctx.cwd ?? '', ctx.signal, executeOne),
      ctx.recorder
    );

    return batchResults.map((r: ToolBatchResult): ToolResultBlock => ({
      type: 'tool-result', toolCallId: r.id, toolName: r.toolName, output: r.output, isError: r.isError,
    }));
  }

  async *executeSingleTool(toolCall: ToolCallBlock, tools: AgentTool[], batchId: string, signal: AbortSignal, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, ToolBatchResult> {
    const startedAt = Date.now();
    const call = this.toBatchCall(toolCall, tools);
    yield { type: 'tool-start', sessionId: ctx.sessionId, batchId, call, timestamp: new Date().toISOString() } as AgentEvent;

    const tool = tools.find((c) => c.name === toolCall.toolName);
    if (!tool) {
      const r = this.toResult(call, startedAt, { text: `Tool not found: ${toolCall.toolName}` }, true);
      yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
      return r;
    }

    const hookCtx: ToolExecutionContext = {
      toolCallId: toolCall.id,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd ?? '',
      signal,
      emit: (_u: ToolProgressUpdate) => {},
      metadata: { subagentDepth: ctx.options.subagentDepth ?? 0 },
    };

    if (ctx.hooks?.length) {
      for (const hook of ctx.hooks) {
        if (!hook.beforeExecute) continue;
        const beforeResult = await hook.beforeExecute(toolCall.input, hookCtx);
        if (beforeResult.status === "blocked_by_gatekeeper") {
          const r = this.toResult(call, startedAt, { text: beforeResult.reason ?? `Tool execution blocked by hook: ${toolCall.toolName}` }, true);
          yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
          return r;
        }
        if (beforeResult.status === "pending_approval") {
          const decision = yield* this.resolvePermission(tool, toolCall.input, toolCall.id, ctx);
          if (decision.behavior !== "allow") {
            const r = this.toResult(call, startedAt, buildPermissionDenyToolOutput(decision), true);
            yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
            return r;
          }
        }
        if (beforeResult.modifiedInput) {
          toolCall = { ...toolCall, input: beforeResult.modifiedInput };
        }
      }
    }

    const { effectiveInput: hookInput, blocked } = yield* this.handleBeforeHook(toolCall, tool, batchId, startedAt, call, ctx);
    if (blocked) return blocked;

    let effectiveInput = ctx.contextManager.restoreProviderToolInput(hookInput);
    const repaired = repairToolInput(tool, effectiveInput);
    if (repaired.notes.length > 0) {
      effectiveInput = repaired.input;
      yield {
        type: 'tool-input-repaired',
        sessionId: ctx.sessionId,
        batchId,
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        notes: repaired.notes,
        timestamp: new Date().toISOString(),
      } as AgentEvent;
    }
    const effectiveToolCall: ToolCallBlock = { ...toolCall, input: effectiveInput };

    const valError = yield* this.handleValidation(tool, effectiveInput, call, startedAt, batchId, ctx);
    if (valError) return valError;

    const permission = yield* this.resolvePermission(tool, effectiveInput, toolCall.id, ctx);
    if (permission.behavior !== 'allow') {
      const r = this.toResult(call, startedAt, buildPermissionDenyToolOutput(permission), true);
      yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
      return r;
    }

    if (signal.aborted) {
      const output = await ctx.contextManager.materializeOutput(effectiveToolCall, { text: isToolTimeoutCause(abortReason(signal)) ? 'Tool execution timed out' : 'Tool execution cancelled' });
      const r = this.toResult(call, startedAt, output, true);
      yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
      return r;
    }

    let result = yield* this.runToolExecution(effectiveToolCall, tool, call, startedAt, batchId, signal, ctx);

    if (ctx.hooks?.length) {
      const toolR: ToolResult<ToolOutput> = {
        output: result.output,
        isError: result.isError,
        durationMs: Date.now() - startedAt,
      };
      for (const hook of ctx.hooks) {
        if (hook.onResult) {
          const modified = await hook.onResult(toolR, hookCtx);
          result = { ...result, output: modified.output, isError: modified.isError };
        }
      }
    }

    return result;
  }

  async *handleToolResult(results: ToolResultBlock[], ctx: ToolExecCtx): AsyncGenerator<AgentEvent, { fatalError?: string; hasSteering: boolean }> {
    this.sawToolsThisRun = true;
    if (results.length > 0) {
      const msg: AgentMessage = { id: createId('tool'), role: 'tool', createdAt: new Date().toISOString(), blocks: results } as AgentMessage;
      yield* this.recordMsg(msg, ctx.conversation, ctx.recorder, ctx.sessionId);
    }
    const fatalError = findFatalToolError(results, ctx.tools);
    if (fatalError) return { fatalError, hasSteering: false };
    return { fatalError: undefined as unknown as string, hasSteering: ctx.inputQueue.hasPending() };
  }

  private async *handleBeforeHook(toolCall: ToolCallBlock, tool: AgentTool, batchId: string, startedAt: number, call: ToolBatchCall, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, { effectiveInput: JsonObject; blocked: ToolBatchResult | null }> {
    let effectiveInput = toolCall.input;
    if (!ctx.composedHooks.beforeToolCall) return { effectiveInput, blocked: null };
    const hookCtx: HookContext = { sessionId: ctx.sessionId, toolCallId: toolCall.id, toolName: toolCall.toolName, tool, input: toolCall.input, cwd: ctx.cwd ?? '', turnIndex: ctx.machine.getContext().turnIndex };
    const beforeResult = await ctx.composedHooks.beforeToolCall(hookCtx);
    if (beforeResult.block) {
      const r = this.toResult(call, startedAt, { text: beforeResult.reason ?? `Tool call blocked by hook: ${toolCall.toolName}` }, true);
      yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
      return { effectiveInput, blocked: r };
    }
    if (beforeResult.modifiedInput) effectiveInput = beforeResult.modifiedInput;
    return { effectiveInput, blocked: null };
  }

  private async *handleValidation(tool: AgentTool, input: JsonObject, call: ToolBatchCall, startedAt: number, batchId: string, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, ToolBatchResult | null> {
    const errors = validateToolInput(tool, input);
    if (errors.length === 0) return null;
    const advice = validationAdviceForToolInput(tool, input, errors);
    const textLines = ['Tool input validation failed:', ...errors.map((e) => `- ${e}`), ...advice];
    const r = this.toResult(call, startedAt, { text: textLines.join('\n') }, true);
    yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
    return r;
  }

  private async *runToolExecution(effectiveToolCall: ToolCallBlock, tool: AgentTool, call: ToolBatchCall, startedAt: number, batchId: string, signal: AbortSignal, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, ToolBatchResult> {
    const queue = new ProgressEventQueue<ToolEvent>();
    const execCtx: ToolExecutionContext = {
      toolCallId: effectiveToolCall.id, sessionId: ctx.sessionId, cwd: ctx.cwd ?? '', signal,
      emit: (u: any) => queue.push({ type: 'event', event: { type: 'tool-update', sessionId: ctx.sessionId, batchId, toolCallId: effectiveToolCall.id, update: u, timestamp: new Date().toISOString() } as AgentEvent }),
      metadata: { subagentDepth: ctx.options.subagentDepth ?? 0 },
    };

    this.singleToolExecutor.execute(effectiveToolCall, (i: any, c: any) => tool.execute(i, c), execCtx, signal)
      .then((r: any) => queue.push({ type: 'result', result: r }), (cause: any) => queue.push({ type: 'result', result: { output: { text: cause instanceof Error ? cause.message : String(cause) }, isError: true } }));

    let execResult: Awaited<ReturnType<SingleToolExecutor['execute']>> | undefined;
    while (!execResult) {
      const next = await queue.next();
      if (next.done) break;
      if (next.value.type === 'event') yield next.value.event;
      else execResult = next.value.result;
    }
    queue.close();
    if (!execResult) execResult = { output: { text: 'Tool execution ended without a result' }, isError: true };

    return yield* this.handleExecResult(effectiveToolCall, call, startedAt, batchId, execResult, ctx);
  }

  private async *handleExecResult(toolCall: ToolCallBlock, call: ToolBatchCall, startedAt: number, batchId: string, execResult: any, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, ToolBatchResult> {
    if (!execResult.isError) {
      let materialized = await ctx.contextManager.materializeOutput(toolCall, execResult.output);
      if (ctx.composedHooks.afterToolCall) {
        const hc: HookContext = { sessionId: ctx.sessionId, toolCallId: toolCall.id, toolName: toolCall.toolName, tool: ctx.tools.find((t: AgentTool) => t.name === toolCall.toolName)!, input: toolCall.input, output: materialized, cwd: ctx.cwd ?? '', turnIndex: ctx.machine.getContext().turnIndex };
        const afterResult = await ctx.composedHooks.afterToolCall(hc);
        if (afterResult.terminate) {
          const r = this.toResult(call, startedAt, afterResult.modifiedOutput ?? materialized, false);
          yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
          return r;
        }
        if (afterResult.modifiedOutput) materialized = await ctx.contextManager.materializeOutput(toolCall, afterResult.modifiedOutput);
      }
      const r = this.toResult(call, startedAt, materialized, false);
      yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
      yield* this.recordCheckpoints(r, ctx.recorder, ctx.sessionId);
      return r;
    }
    return yield* this.handleErrorResult(toolCall, call, startedAt, batchId, execResult, ctx);
  }

  private async *handleErrorResult(toolCall: ToolCallBlock, call: ToolBatchCall, startedAt: number, batchId: string, execResult: any, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, ToolBatchResult> {
    const rawJson = execResult.output?.json && typeof execResult.output.json === 'object' ? execResult.output.json as JsonObject : {};
    const isTimeout = rawJson.timedOut === true;
    const isCancelled = rawJson.cancelled === true || (ctx.signal.aborted && !isTimeout);
    const causeText = isTimeout ? 'Tool execution timed out' : isCancelled ? (typeof execResult.output?.text === 'string' && execResult.output.text ? execResult.output.text : 'Tool execution cancelled') : (execResult.output?.text ?? 'Tool execution error');
    const structuredJson: JsonObject = { ...rawJson, timedOut: isTimeout, cancelled: isCancelled && !isTimeout } as JsonObject;
    const errorOutput = await ctx.contextManager.materializeOutput(toolCall, { text: causeText, json: structuredJson });
    const r = this.toResult(call, startedAt, errorOutput, true);
    yield { type: 'tool-end', sessionId: ctx.sessionId, batchId, result: r, timestamp: new Date().toISOString() } as AgentEvent;
    return r;
  }

  private async *resolvePermission(tool: AgentTool, input: JsonObject, toolCallId: string, ctx: ToolExecCtx): AsyncGenerator<AgentEvent, PermissionDecision> {
    const sReq: PermissionRequest = { id: toolCallId, sessionId: ctx.sessionId, cwd: ctx.cwd ?? '', toolCallId, toolName: tool.name, parameters: input, summary: tool.summarize(input), toolMetadata: { category: tool.category, isReadOnly: tool.isReadOnly(input), fatalOnError: tool.fatalOnError ?? false, concurrency: tool.concurrency } } as PermissionRequest;

    // approval-requested 事件必须在 handler.requestApproval 等待用户审批期间发出。
    // 否则形成死锁：runtime 等 handler.requestApproval() 返回 → 客户端等 approval-requested 事件 → 互相等待。
    //
    // 原实现的 bug：onApprovalRequested 回调只把事件 push 到数组，而 yield 要等 decide() 返回后才执行。
    // decide() 内部会 await handler.requestApproval()，该 await 直到用户审批才完成 → 事件永远发不出 → 死锁。
    //
    // 修复：用 deferred 让回调把事件立即交给 generator。
    // generator 用 Promise.race 同时等待「事件就绪」和「decide 完成」：
    //   - ask 路径：回调先 resolve deferred → generator yield 事件 → 再 await decide（等用户审批）
    //   - allow/deny 路径：decide 先完成，不触发回调 → generator 跳过 yield，直接返回决策
    const deferred: { resolve: ((event: AgentEvent) => void) | null } = { resolve: null };
    const approvalRequestedPromise = new Promise<AgentEvent>((resolve) => {
      deferred.resolve = resolve;
    });

    const decidePromise = ctx.approvalPipeline.decide(
      { tool, input, permissionRequest: sReq },
      async (req, dec) => {
        deferred.resolve?.({ type: 'approval-requested', sessionId: ctx.sessionId, request: req, decision: dec, timestamp: new Date().toISOString() } as AgentEvent);
      }
    );

    const raceWinner = await Promise.race([
      decidePromise.then((decision) => ({ type: 'decision' as const, decision })),
      approvalRequestedPromise.then((event) => ({ type: 'event' as const, event })),
    ]);

    if (raceWinner.type === 'event') {
      yield raceWinner.event;
    }

    const decision = await decidePromise;
    if (decision.behavior !== 'allow') {
      yield { type: 'approval-resolved', sessionId: ctx.sessionId, requestId: toolCallId, decision, timestamp: new Date().toISOString() } as AgentEvent;
    }
    return decision;
  }

  private toBatchCall(c: ToolCallBlock, tools: AgentTool[]): ToolBatchCall {
    const t = tools.find((x) => x.name === c.toolName);
    return { id: c.id, toolName: c.toolName, input: c.input, summary: summarizeToolCall(t, c.input, c.toolName), category: t?.category ?? 'internal' as const, concurrency: t?.concurrency ?? 'exclusive' as const };
  }

  private toResult(call: ToolBatchCall, startedAt: number, output: ToolOutput, isError: boolean): ToolBatchResult {
    const now = new Date().toISOString();
    return { id: call.id, toolName: call.toolName, output, isError, durationMs: Date.now() - startedAt, startedAt: new Date(startedAt).toISOString(), endedAt: now, outputByteSize: Buffer.byteLength(JSON.stringify(output), 'utf8') } as ToolBatchResult;
  }

  private async *recordMsg(msg: AgentMessage, conv: ConversationEngine, recorder: SessionRecorder, sid: string): AsyncGenerator<AgentEvent> {
    yield { type: 'message-start', sessionId: sid, message: msg } as AgentEvent;
    conv.appendMessage(msg);
    const entry = await recorder.recordMessage(msg);
    yield { type: 'message-end', sessionId: sid, message: withSessionEntryMetadata(msg, entry) } as AgentEvent;
  }

  private async *recordCheckpoints(result: ToolBatchResult, recorder: SessionRecorder, sid: string): AsyncGenerator<AgentEvent> {
    for (const cp of checkpointRecordsFromToolResult(result)) {
      await recorder.recordCheckpoint(cp.label, cp as unknown as JsonObject);
      yield { type: 'checkpoint-created', sessionId: sid, timestamp: new Date().toISOString(), checkpoint: cp } as AgentEvent;
    }
    const restore = checkpointRestoreRecordFromToolResult(result);
    if (restore) yield { type: 'checkpoint-restored', sessionId: sid, timestamp: new Date().toISOString(), restore } as AgentEvent;
  }
}

async function* relayAndRecord<T>(source: AsyncGenerator<AgentEvent, T>, recorder: SessionRecorder): AsyncGenerator<AgentEvent, T> {
  let result: T | undefined;
  while (true) {
    const next = await source.next();
    if (next.done) { result = next.value; break; }
    await recorder.recordEvent(next.value);
    yield next.value;
  }
  return result as T;
}
