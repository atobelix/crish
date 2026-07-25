/**
 * AgentSessionLoop - 单状态机驱动的核心循环
 *
 * 本文件为瘦身后的主类，通过 4 个 Delegate 组件实现职责分离。
 */

import type { AgentEvent, AgentMessage, JsonObject, ToolCallBlock } from '@crish/shared-types';
import { DEFAULT_MAX_TURNS } from '@crish/shared-types';
import { RingBuffer } from '@crish/shared-utils';
import type { AgentRuntimeOptions, AgentTool, RuntimePermissionPolicy } from '../types';
import { ErrorClassifier } from '../error-classifier';
import { MAX_PAYLOAD_IMAGE_RECOVERY, scrubImagesOldestFirst } from '../payload-image-recovery';
import { ConversationEngine, ProviderCallGateway, ContextManager, ContextCompressionGate, ProviderResponseConsumer } from '../runtime-components';
import type { ConsumeResult } from '../runtime-components';
import { TokenLedger } from '../token-ledger';
import { flushEvents, withSessionEntryMetadata, abortReason } from '../runtime-helpers';
import { createId, nowIso, createTextMessage, SessionRecorder, pruneHistoricalToolOutputs } from '../session';
import { AsyncMutex } from '@crish/shared-utils';
import type { ConexStateMachine } from '../state-machine/core';
import { createAgentSessionMachine, shouldStopForMaxTurns, type AgentSessionContext, type AgentSessionState, type AgentSessionEvent, type AgentEndReason } from '../state-machine/agent-session';
import { AgentInputQueue } from '../agent-input-queue';
import { SteeringCoordinator, RecoverySteeringStrategy } from '../steering';
import { ExtensionRegistry, type AgentHooks as AgentHooksType, type TurnContext } from '../hooks';
import { ProviderCallCoordinator } from './provider-call';
import { ToolExecutionCoordinator, type ToolExecCtx } from './tool-execution';
import { SteeringDelegate } from './steering-delegate';
import { RecoveryCoordinator } from './recovery';
import { DELTA_QUEUE_CAPACITY, isTransientProviderError, findFatalToolError, conversationNeedsTextSynthesis, normalizeToolExecutionOptions, sleepMs, createSynthesisNudgeMessage } from './types';
import { ApprovalPipeline } from '../approval/approval-pipeline';
import { ApprovalCache } from '../approval/approval-cache';

interface HandlerResult {
  endReason?: AgentEndReason;
  endError?: string | undefined;
}

export class AgentSessionLoop {
  private readonly machine: ConexStateMachine<AgentSessionState, AgentSessionEvent, AgentSessionContext>;
  private readonly providerCall: ProviderCallCoordinator;
  private readonly toolExec: ToolExecutionCoordinator;
  private readonly steering: SteeringDelegate;
  private readonly recovery: RecoveryCoordinator;
  private readonly options: AgentRuntimeOptions;
  private readonly inputQueue: AgentInputQueue;
  private readonly conversation: ConversationEngine;
  private readonly contextManager: ContextManager;
  private readonly providerGateway: ProviderCallGateway;
  private readonly tools: AgentTool[];
  private readonly abortController: AbortController;
  private readonly recorder: SessionRecorder;
  private readonly sessionId: string;
  private readonly ledger: TokenLedger;
  private readonly permissionPolicy: RuntimePermissionPolicy;
  private readonly approvalPipeline: ApprovalPipeline;
  private readonly composedHooks: Partial<AgentHooksType>;
  private readonly compressionGate: ContextCompressionGate;
  private readonly sessionMutex = new AsyncMutex();
  private static readonly MAX_LENGTH_CONTINUE_NUDGES = 1;

  constructor(
    options: AgentRuntimeOptions, inputQueue: AgentInputQueue,
    conversation: ConversationEngine, contextManager: ContextManager,
    providerGateway: ProviderCallGateway, tools: AgentTool[],
    abortController: AbortController, recorder: SessionRecorder,
    sessionId: string, _tokenTracker: import('../provider-transport/token-tracker').TokenTracker,
    ledger: TokenLedger, permissionPolicy: RuntimePermissionPolicy,
    extensionRegistry?: ExtensionRegistry,
  ) {
    this.options = options; this.inputQueue = inputQueue; this.conversation = conversation;
    this.contextManager = contextManager; this.providerGateway = providerGateway; this.tools = tools;
    this.abortController = abortController; this.recorder = recorder; this.sessionId = sessionId;
    this.ledger = ledger; this.permissionPolicy = permissionPolicy;
    this.machine = createAgentSessionMachine(sessionId, options.maxTurns ?? DEFAULT_MAX_TURNS);
    const extReg = extensionRegistry ?? new ExtensionRegistry();
    this.composedHooks = extReg.collectHooks();
    this.approvalPipeline = new ApprovalPipeline({
      permissionPolicy: this.permissionPolicy,
      ...(this.options.approvalHandler ? { approvalHandler: this.options.approvalHandler } : {}),
      cache: new ApprovalCache(),
    });
    this.compressionGate = new ContextCompressionGate(contextManager);
    this.toolExec = new ToolExecutionCoordinator(normalizeToolExecutionOptions(options.toolExecution));
    this.providerCall = new ProviderCallCoordinator(new ProviderResponseConsumer());
    const ro = options.recovery;
    this.steering = new SteeringDelegate(new SteeringCoordinator(conversation, [new RecoverySteeringStrategy({
      maxConsecutiveToolErrors: ro?.maxConsecutiveToolErrors, maxRepeatedToolCalls: ro?.maxRepeatedToolCalls,
      maxSteeringMessages: ro?.maxSteeringMessages ?? 1,
    })], { maxSteeringBudget: ro?.maxSteeringMessages ?? 1 }));
    this.recovery = new RecoveryCoordinator(AgentSessionLoop.MAX_LENGTH_CONTINUE_NUDGES);
  }

  async *run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]> {
    const release = await this.sessionMutex.acquire();
    try {
      const userMessage = typeof userInput === 'string' ? createTextMessage('user', userInput) : userInput;
      this.inputQueue.enqueue(userMessage);
      this.dispatch('INITIALIZED');
      yield* this.recordEvent({ type: 'agent-start', sessionId: this.sessionId, timestamp: nowIso() }, this.recorder);

      let endReason: AgentEndReason = 'stop';
      let endError: string | undefined;

      while (!this.machine.is('done')) {
        const state = this.machine.getCurrent();
        try {
          let r: HandlerResult = {};
          switch (state) {
            case 'awaiting-input': r = yield* this.handleAwaitingInput(); break;
            case 'preparing-turn': r = yield* this.handlePrepareTurn(); break;
            case 'streaming': r = yield* this.handleStreaming(); break;
            case 'steering-evaluation': r = yield* this.handleSteeringEvaluation(); break;
            case 'executing-tools': r = yield* this.handleExecutingTools(); break;
            case 'turn-complete': r = yield* this.handleTurnComplete(); break;
            default: break;
          }
          if (r.endReason) { endReason = r.endReason; endError = r.endError; }
          if (endReason) break;
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          const action = this.recovery.handleErrorWithHook(error, state, this.composedHooks, this.sessionId, this.machine.getContext().turnIndex, this.options.cwd);
          yield* this.emitEvent({ type: 'runtime-error', sessionId: this.sessionId, timestamp: nowIso(), error: error.message });
          if (action === 'retry') continue;
          if (action === 'skip') {
            const ev = this.recovery.dispatchErrorRecovery(state as AgentSessionState);
            if (ev) { try { this.dispatch(ev); continue; } catch (e) { console.warn('[SessionLoop] dispatchErrorRecovery failed:', e); } }
          }
          endReason = 'error';
          endError = error.message;
          const fe = this.recovery.dispatchFatalError(state as AgentSessionState);
          if (fe) { try { this.dispatch(fe); } catch (e) { console.warn('[SessionLoop] dispatchFatalError failed:', e); } }
          break;
        }
      }

      const finalCtx = this.machine.getContext();
      if (finalCtx.endReason !== 'stop') endReason = finalCtx.endReason as AgentEndReason;
      const endPayload: Record<string, unknown> = { type: 'agent-end', sessionId: this.sessionId, timestamp: nowIso(), reason: endReason };
      if (endError !== undefined) endPayload.error = endError;
      yield* this.recordEvent(endPayload as AgentEvent, this.recorder);
      return this.conversation.getMessagesMutable();
    } finally {
      release();
    }
  }

  private async *handleAwaitingInput(): AsyncGenerator<AgentEvent, HandlerResult> {
    if (this.abortController.signal.aborted) { this.dispatch('ABORT'); return { endReason: 'aborted' }; }
    const input = this.inputQueue.dequeue();
    if (!input) { this.dispatch('NO_INPUT'); return {}; }
    yield* this.recordMessage(input, this.conversation, this.recorder);
    this.dispatch('INPUT_READY');
    return {};
  }

  private async *handlePrepareTurn(): AsyncGenerator<AgentEvent, HandlerResult> {
    if (this.abortController.signal.aborted) { this.dispatch('ABORT'); return { endReason: 'aborted' }; }
    if (this.options.readPendingInputs) {
      for (const msg of await this.options.readPendingInputs(this.sessionId)) this.inputQueue.enqueue(msg);
    }
    if (this.inputQueue.hasPending()) {
      const si = this.inputQueue.dequeue();
      if (si) yield* this.recordMessage(si, this.conversation, this.recorder);
    }
    yield* this.recordEvent({ type: 'turn-start', sessionId: this.sessionId, turnIndex: this.machine.getContext().turnIndex + 1, timestamp: nowIso() }, this.recorder);

    const ro = this.options.recovery;
    if (ro?.enabled !== false) {
      const ctx = this.machine.getContext();
      const sc = { messages: this.conversation.getMessages(), turnIndex: ctx.turnIndex, steeringCount: this.steering.steeringCoordinator.getSteeringCount(), toolCallCount: ctx.toolCallCount, hasPendingInput: this.inputQueue.hasPending() };
      for (const phase of ['after-tools', 'before-turn'] as const) {
        const evalResult = this.steering.evaluate(phase, sc);
        const applied = this.steering.apply(evalResult.actions, this.sessionId);
        yield* flushEvents(applied.events);
        if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return { endReason: 'error', endError: 'Runtime intervention required' }; }
      }
    }

    const mbc = this.conversation.getMessagesMutable();
    if (this.contextManager.shouldCompress(mbc)) {
      yield* this.emitEvent({ type: 'context-compression-start', sessionId: this.sessionId, timestamp: nowIso(), reason: 'auto', tokensBefore: mbc.length });
      const cr = await this.compressionGate.maybeCompress(mbc);
      if (cr.compressed) {
        this.conversation.replaceMessages(cr.messages);
        if (cr.record) await this.recorder.recordCompaction(cr.record);
        pruneHistoricalToolOutputs(this.conversation.getMessagesMutable(), 10);
        global.gc?.();
        yield* this.emitEvent({ type: 'context-compression-end', sessionId: this.sessionId, timestamp: nowIso(), aborted: false, ...(cr.record ? { result: cr.record } : {}) });
      } else {
        yield* this.emitEvent({ type: 'context-compression-end', sessionId: this.sessionId, timestamp: nowIso(), aborted: true });
      }
    }
    this.dispatch('TURN_PREPARED');
    return {};
  }

  private async *handleStreaming(): AsyncGenerator<AgentEvent, HandlerResult> {
    const callIterator = await this.providerCall.buildProviderCall(this.conversation, this.contextManager, { ...(this.options.systemPrompt !== undefined ? { systemPrompt: this.options.systemPrompt } : {}), provider: this.options.provider, cwd: this.options.cwd ?? '' }, this.tools, this.sessionId, this.abortController.signal, this.providerGateway);

    const deltaQueue = new RingBuffer<AgentEvent>(DELTA_QUEUE_CAPACITY);
    let deltaWaiters: Array<() => void> = [];
    const wake = () => { const w = deltaWaiters; deltaWaiters = []; for (const r of w) r(); };
    const turnIndex = this.machine.getContext().turnIndex;

    const consumePromise = this.providerCall.providerConsumer.consume(callIterator, this.tools, this.abortController.signal, (d) => {
      deltaQueue.pushOverwritingOldest({
        type: 'message-delta', sessionId: this.sessionId,
        block: d.kind === 'thought' ? { type: 'thought', text: d.text, ...(d.redacted !== undefined ? { redacted: d.redacted } : {}) } : { type: 'text', text: d.text },
        timestamp: nowIso(),
      } as AgentEvent);
      wake();
    });
    const consumeImpl = (async () => { return await consumePromise; })();

    let consumeResult: ConsumeResult | undefined;
    const done = consumeImpl.then((r) => { consumeResult = r; wake(); return r; });

    while (true) {
      while (deltaQueue.size > 0) yield* this.emitEvent(deltaQueue.shift()!);
      if (this.inputQueue.hasPending()) {
        const si = this.inputQueue.dequeue();
        if (si) { yield* this.recordMessage(si, this.conversation, this.recorder); this.dispatch('INPUT_AVAILABLE' as AgentSessionEvent); return {}; }
      }
      if (consumeResult) break;
      await Promise.race([done, new Promise<void>((resolve) => deltaWaiters.push(resolve))]);
    }
    if (this.machine.getCurrent() !== 'streaming') return {};
    while (deltaQueue.size > 0) yield* this.emitEvent(deltaQueue.shift()!);
    if (!consumeResult) consumeResult = await done;

    for (const d of consumeResult.diagnostics) {
      yield* this.emitEvent({ type: 'provider-diagnostic', sessionId: this.sessionId, diagnostic: d, timestamp: nowIso() } as AgentEvent);
    }

    const ar = consumeResult.response;
    if (ar.type === 'error') return yield* this.handleStreamError(ar.error ?? 'Provider stream failed');
    this.providerCall.providerTransientRetries = 0;
    if (ar.type === 'empty-response') { this.dispatch('STEERING_NEEDED'); return {}; }
    if (ar.type !== 'message') return {};

    const msg = this.enrichMsg(ar.message);
    this.conversation.appendMessage(msg);
    const entry = await this.recorder.recordMessage(msg);
    yield* this.recordEvent({ type: 'message-end', sessionId: this.sessionId, message: withSessionEntryMetadata(msg, entry) }, this.recorder);
    this.providerCall.recordTokenUsage(msg, turnIndex, this.ledger, this.options.provider.id);

    if (msg.metadata?.stopReason === 'error') { this.dispatch('PROVIDER_ERROR'); return { endReason: 'error', endError: typeof msg.metadata.error === 'string' ? msg.metadata.error : 'Provider stream failed' }; }

    const toolCalls = msg.blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call');
    if (toolCalls.length === 0) return yield* this.handleNoToolCalls(msg);
    if (msg.metadata?.stopReason !== 'length') { this.providerCall.lengthMaxTokensEscalationCount = 0; this.providerCall.lengthContinueNudgeCount = 0; }

    this.dispatch('HAS_TOOL_CALLS' as AgentSessionEvent, { count: toolCalls.length });
    return {};
  }

  private async *handleStreamError(errMsg: string): AsyncGenerator<AgentEvent, HandlerResult> {
    const classified = ErrorClassifier.classify(new Error(errMsg));
    const isPayloadTooLarge = classified.legacyKind === 'payload-too-large';

    if (isPayloadTooLarge && this.providerCall.payloadRecoveryRetries < MAX_PAYLOAD_IMAGE_RECOVERY) {
      const scrubbed = scrubImagesOldestFirst(this.conversation.getMessages());
      if (scrubbed.stripped > 0) {
        this.providerCall.payloadRecoveryRetries++; this.conversation.replaceMessages(scrubbed.messages);
        yield* this.emitEvent({ type: 'provider-diagnostic', sessionId: this.sessionId, diagnostic: { phase: 'retry', errorKind: 'payload-too-large', reason: `Payload too large: scrubbed ${scrubbed.stripped} image(s)`, attempt: this.providerCall.payloadRecoveryRetries, maxAttempts: MAX_PAYLOAD_IMAGE_RECOVERY, retryable: true }, timestamp: nowIso() } as unknown as AgentEvent);
        this.dispatch('NO_PROGRESS_CONTINUE'); return {};
      }
      const cr = await this.compressionGate.maybeCompress(this.conversation.getMessagesMutable());
      if (cr.compressed) {
        this.providerCall.payloadRecoveryRetries++; this.conversation.replaceMessages(cr.messages);
        if (cr.record) await this.recorder.recordCompaction(cr.record);
        pruneHistoricalToolOutputs(this.conversation.getMessagesMutable(), 10);
        global.gc?.();
        yield* this.emitEvent({ type: 'provider-diagnostic', sessionId: this.sessionId, diagnostic: { phase: 'retry', errorKind: 'payload-too-large', reason: `Payload too large: compressed context`, attempt: this.providerCall.payloadRecoveryRetries, maxAttempts: MAX_PAYLOAD_IMAGE_RECOVERY, retryable: true }, timestamp: nowIso() } as unknown as AgentEvent);
        this.dispatch('NO_PROGRESS_CONTINUE'); return {};
      }
    }

    if (isTransientProviderError(errMsg) && this.providerCall.providerTransientRetries < ProviderCallCoordinator.MAX_PROVIDER_TRANSIENT_RETRIES) {
      this.providerCall.providerTransientRetries++;
      yield* this.emitEvent({ type: 'provider-diagnostic', sessionId: this.sessionId, diagnostic: { phase: 'retry', message: `Transient provider error, retry ${this.providerCall.providerTransientRetries}/${ProviderCallCoordinator.MAX_PROVIDER_TRANSIENT_RETRIES}: ${errMsg}` }, timestamp: nowIso() } as AgentEvent);
      await sleepMs(600 * this.providerCall.providerTransientRetries, this.abortController.signal);
      this.dispatch('NO_PROGRESS_CONTINUE'); return {};
    }

    if (this.toolExec.sawToolsThisRun && !this.steering.synthesisNudgeUsed) {
      this.steering.injectSynthesisNudge(this.inputQueue, `上游模型暂时失败：${errMsg.slice(0, 240)}。请仅基于已完成的工具结果给出结论；不要再调用工具。若必须停止请说明原因。`);
      this.dispatch('INPUT_AVAILABLE'); return {};
    }

    const action = this.recovery.handleErrorWithHook(new Error(errMsg), 'streaming', this.composedHooks, this.sessionId, this.machine.getContext().turnIndex, this.options.cwd);
    const classifyResult = ErrorClassifier.classify(errMsg);
    yield* this.emitEvent({ type: 'runtime-error', sessionId: this.sessionId, timestamp: nowIso(), error: errMsg, retryable: classifyResult.retryable });
    if (action === 'retry') { this.dispatch('NO_PROGRESS_CONTINUE'); return {}; }
    if (action === 'skip') {
      const ev = this.recovery.dispatchErrorRecovery('streaming' as AgentSessionState);
      if (ev) { try { this.dispatch(ev); return {}; } catch (e) { console.warn('[SessionLoop] dispatchErrorRecovery failed:', e); } }
    }
    this.dispatch('PROVIDER_ERROR');
    return { endReason: 'error', endError: errMsg };
  }

  private async *handleNoToolCalls(msg: AgentMessage): AsyncGenerator<AgentEvent, HandlerResult> {
    if (msg.metadata?.stopReason === 'length') {
      const la = this.providerCall.handleLengthFinishReason(msg, this.steering.steeringCoordinator);
      if (la.type === 'escalated') {
        this.conversation.appendMessage(createSynthesisNudgeMessage(la.nudgeText));
        this.steering.steeringCoordinator.resetSteeringCount();
        this.dispatch('NO_PROGRESS_CONTINUE'); return {};
      }
      if (this.recovery.shouldRetryWithEscalation()) {
        this.conversation.appendMessage(createSynthesisNudgeMessage('Previous assistant output was truncated by the model length limit. Continue exactly from where you left off; do not repeat earlier text unless needed for continuity. Do not call tools unless necessary.'));
        this.steering.steeringCoordinator.resetSteeringCount();
        this.dispatch('NO_PROGRESS_CONTINUE'); return {};
      }
    } else {
      this.providerCall.lengthMaxTokensEscalationCount = 0;
      this.providerCall.lengthContinueNudgeCount = 0;
    }
    this.steering.steeringCoordinator.resetSteeringCount();
    this.dispatch('NO_TOOL_CALLS');
    return {};
  }

  private async *handleSteeringEvaluation(): AsyncGenerator<AgentEvent, HandlerResult> {
    const ctx = this.machine.getContext();
    const maxSteering = this.options.recovery?.maxSteeringMessages ?? 3;
    if (ctx.steeringCount > maxSteering) { this.dispatch('STEERING_BUDGET_EXHAUSTED'); return { endReason: 'error', endError: 'Steering budget exhausted' }; }

    const sc = { messages: this.conversation.getMessages(), turnIndex: ctx.turnIndex, steeringCount: ctx.steeringCount, toolCallCount: ctx.toolCallCount, hasPendingInput: this.inputQueue.hasPending() };
    const evaluation = this.steering.evaluate('empty-response', sc);
    if (evaluation.actions.length === 0) { this.dispatch('STEERING_BUDGET_EXHAUSTED'); return { endReason: 'error', endError: 'No steering strategy handled empty response' }; }
    const applied = this.steering.apply(evaluation.actions, this.sessionId);
    yield* flushEvents(applied.events);
    if (applied.interventionRequired) { this.dispatch('INTERVENTION_REQUIRED'); return { endReason: 'error', endError: 'Runtime intervention required' }; }
    this.dispatch('STEERING_COMPLETE');
    return {};
  }

  private async *handleExecutingTools(): AsyncGenerator<AgentEvent, HandlerResult> {
    if (this.abortController.signal.aborted) { this.dispatch('ABORT'); return { endReason: 'aborted' }; }

    const lastAssistant = this.conversation.getMessagesMutable().filter((m) => m.role === 'assistant').pop();
    const toolCalls = lastAssistant ? lastAssistant.blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call') : [];

    const results = yield* this.toolExec.executeToolBatch(toolCalls, this.makeToolExecCtx());
    this.toolExec.sawToolsThisRun = true;
    if (results.every((b) => !b.isError)) this.steering.steeringCoordinator.resetSteeringCount();

    if (results.length > 0) {
      const msg: AgentMessage = { id: createId('tool'), role: 'tool', createdAt: nowIso(), blocks: results } as AgentMessage;
      yield* this.recordMessage(msg, this.conversation, this.recorder);
    }
    const fatal = findFatalToolError(results, this.tools);
    if (fatal) { yield* this.emitEvent({ type: 'runtime-error', sessionId: this.sessionId, timestamp: nowIso(), error: fatal }); this.dispatch('ERROR'); return { endReason: 'error', endError: fatal }; }
    if (this.inputQueue.hasPending()) {
      const si = this.inputQueue.dequeue();
      if (si) { yield* this.recordMessage(si, this.conversation, this.recorder); this.dispatch('INPUT_AVAILABLE' as AgentSessionEvent); return {}; }
    }
    this.dispatch('TOOLS_COMPLETE');
    return {};
  }

  private async *handleTurnComplete(): AsyncGenerator<AgentEvent, HandlerResult> {
    const ctx = this.machine.getContext();
    yield* this.recordEvent({ type: 'turn-end', sessionId: this.sessionId, turnIndex: ctx.turnIndex, timestamp: nowIso(), toolCallCount: ctx.toolCallCount }, this.recorder);

    if (ctx.abortReason || this.abortController.signal.aborted) {
      this.dispatch('FINISH');
      return { endReason: ctx.endReason === 'error' ? 'error' : 'aborted', endError: (ctx.abortReason as string | undefined) ?? (abortReason(this.abortController.signal) as string | undefined) };
    }
    if (ctx.endReason === 'error') { this.dispatch('FINISH'); return { endReason: 'error' }; }
    if (ctx.endReason === 'aborted') { this.dispatch('FINISH'); return { endReason: 'aborted' }; }

    if (shouldStopForMaxTurns(ctx)) {
      if (!this.steering.synthesisNudgeUsed && this.toolExec.sawToolsThisRun && conversationNeedsTextSynthesis(this.conversation)) {
        this.steering.injectSynthesisNudge(this.inputQueue, '轮次将尽。请立刻基于已有工具结果给出完整中文总结与建议，不要再调用工具。');
        this.dispatch('INPUT_AVAILABLE'); return {};
      }
      this.dispatch('MAX_TURNS_REACHED');
      return { endReason: 'max-turns' };
    }

    if (this.composedHooks.shouldStopAfterTurn) {
      const tc: TurnContext = { sessionId: this.sessionId, turnIndex: ctx.turnIndex, maxTurns: ctx.maxTurns, messages: this.conversation.getMessages(), toolCallCount: ctx.toolCallCount, toolCalls: [], cwd: this.options.cwd, hasPendingInput: this.inputQueue.hasPending(), isAborted: this.abortController.signal.aborted };
      if (this.composedHooks.shouldStopAfterTurn(tc)) { this.dispatch('SHOULD_STOP'); return {}; }
      if (ctx.toolCallCount > 0) { this.dispatch('NEXT_TURN'); return {}; }
      if (this.inputQueue.hasPending()) { this.dispatch('INPUT_AVAILABLE'); return {}; }
      this.dispatch('SHOULD_STOP'); return {};
    }

    if (ctx.toolCallCount > 0) { this.dispatch('NEXT_TURN'); return {}; }
    if (this.inputQueue.hasPending()) { this.dispatch('INPUT_AVAILABLE'); return {}; }
    if (!this.steering.synthesisNudgeUsed && this.toolExec.sawToolsThisRun && conversationNeedsTextSynthesis(this.conversation)) {
      this.steering.injectSynthesisNudge(this.inputQueue, '请基于以上工具结果，用完整中文给出分析结论与下一步建议。不要再调用工具；若信息不足请明确说明缺什么。');
      this.dispatch('INPUT_AVAILABLE'); return {};
    }
    this.dispatch('SHOULD_STOP');
    return {};
  }

  private makeToolExecCtx(): ToolExecCtx {
    return {
      sessionId: this.sessionId, cwd: this.options.cwd, tools: this.tools, signal: this.abortController.signal,
      recorder: this.recorder, composedHooks: this.composedHooks, permissionPolicy: this.permissionPolicy,
      approvalPipeline: this.approvalPipeline, ...(this.options.hooks !== undefined ? { hooks: this.options.hooks } : {}),
      contextManager: { materializeOutput: (tc, o) => this.contextManager.materializeOutput(tc, o), restoreProviderToolInput: (i) => this.contextManager.restoreProviderToolInput(i) },
      machine: { getContext: () => ({ turnIndex: this.machine.getContext().turnIndex }) },
      options: { ...(this.options.subagentDepth !== undefined ? { subagentDepth: this.options.subagentDepth } : {}) },
      conversation: this.conversation, inputQueue: this.inputQueue,
    };
  }

  private enrichMsg(message: AgentMessage): AgentMessage {
    const pm = this.options.promptContext?.metadata && typeof this.options.promptContext.metadata === 'object' ? this.options.promptContext.metadata as JsonObject : undefined;
    const assembly = this.providerCall.lastPromptAssembly;
    if (!assembly && !pm) return message;
    return {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        ...(assembly ? { promptAssembly: { stablePrefixHash: assembly.stablePrefixHash, toolSchemaHash: assembly.toolSchemaHash, cacheStrategy: assembly.cacheStrategy, version: assembly.version, layout: assembly.layout } } : {}),
        ...(pm ? { promptContext: pm } : {}),
      } as JsonObject,
    };
  }

  private async *recordMessage(msg: AgentMessage, conversation: ConversationEngine, recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    yield* this.recordEvent({ type: 'message-start', sessionId: this.sessionId, message: msg }, recorder);
    conversation.appendMessage(msg);
    const entry = await recorder.recordMessage(msg);
    yield* this.recordEvent({ type: 'message-end', sessionId: this.sessionId, message: withSessionEntryMetadata(msg, entry) }, recorder);
  }

  private async *recordEvent(event: AgentEvent, recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    await recorder.recordEvent(event);
    yield event;
  }

  private async *emitEvent(event: AgentEvent): AsyncGenerator<AgentEvent> {
    yield event;
  }

  private dispatch(event: AgentSessionEvent, payload?: unknown): void {
    const result = this.machine.send(event, payload);
    if (!result.ok) throw new Error(`INVALID_TRANSITION: ${result.message}`);
  }
}
