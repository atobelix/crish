import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentEvent,
  type AgentMessage,
  type AgentRuntimeOptions,
  type AgentTool,
  type JsonObject,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionRequest,
  type ProviderStreamEvent,
  type ToolArtifact,
  type RuntimeCheckpointRecord,
  type RuntimeCheckpointRestoreRecord,
  type RuntimeRecoveryReason,
  type SessionHeader,
  type ToolBatchCall,
  type ToolBatchResult,
  type ToolCallBlock,
  type ToolOutput,
  type ToolResultBlock
} from "./types";
import { ContextCompressor } from "./context-compression";
import { projectMessagesForProvider } from "./context-projection";
import { buildSessionContextFromEntries, createId, createTextMessage, findSessionLeafId, InMemorySessionStore, nowIso, SessionRecorder } from "./session";
import { budgetTextForContext, stringifyToolOutput } from "./tool-output-budget";
import { repairToolInput, validateToolInput } from "./tools";

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_ARTIFACT_CHARS = 200_000;
const DEFAULT_ARTIFACT_PREVIEW_CHARS = 4_000;

interface CollectedAssistantResult {
  message?: AgentMessage;
  error?: string;
}

const allowAllPolicy: PermissionPolicy = {
  decide(): PermissionDecision {
    return { behavior: "allow", reason: "default allow policy" };
  }
};

export class AgentRuntime {
  private readonly sessionId: string;
  private readonly abortController = new AbortController();
  private recoverySteeringCount = 0;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.sessionId = options.sessionId ?? createId("session");
  }

  abort(reason?: string): void {
    this.abortController.abort(reason);
  }

  async *run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]> {
    const sessionStore = this.options.sessionStore ?? new InMemorySessionStore();
    const header: SessionHeader = {
      type: "session",
      id: this.sessionId,
      cwd: this.options.cwd,
      createdAt: nowIso(),
      version: 1
    };
    await sessionStore.open(header);

    const resumedEntries = this.options.resumeSession && sessionStore.readAll ? await sessionStore.readAll() : [];
    const recorder = new SessionRecorder(sessionStore, findSessionLeafId(resumedEntries));
    const messages: AgentMessage[] = [
      ...(this.options.resumeSession ? buildSessionContextFromEntries(resumedEntries) : []),
      ...(this.options.initialMessages ?? [])
    ];
    const tools = await this.resolveTools();
    const userMessage = typeof userInput === "string" ? createTextMessage("user", userInput) : userInput;

    const startEvent = this.event({ type: "agent-start" });
    yield* this.recordEvent(startEvent, recorder);

    yield* this.recordMessage(userMessage, messages, recorder);

    let endReason: Extract<AgentEvent, { type: "agent-end" }>["reason"] = "stop";
    let endError: string | undefined;
    const maxTurns = this.options.maxTurns ?? DEFAULT_MAX_TURNS;

    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex++) {
      if (this.abortController.signal.aborted) {
        endReason = "aborted";
        break;
      }

      yield* this.recordEvent(
        {
          type: "turn-start",
          sessionId: this.sessionId,
          turnIndex,
          timestamp: nowIso()
        },
        recorder
      );

      const recoveryEvents: AgentEvent[] = [];
      const recovery = await this.handleRuntimeRecovery(messages, recorder, recoveryEvents);
      yield* flushEvents(recoveryEvents);
      if (recovery === "intervention-required") {
        endReason = "error";
        endError = "Runtime intervention required";
        yield* this.recordEvent(
          {
            type: "turn-end",
            sessionId: this.sessionId,
            turnIndex,
            timestamp: nowIso(),
            toolCallCount: 0
          },
          recorder
        );
        break;
      }

      const compressionEvents: AgentEvent[] = [];
      await this.maybeCompressContext(messages, recorder, compressionEvents);
      yield* flushEvents(compressionEvents);

      const assistantResult = yield* this.collectAssistantMessage(messages, tools, recorder);
      if (!assistantResult.message) {
        endReason = this.abortController.signal.aborted ? "aborted" : "error";
        endError = assistantResult.error ?? "Provider stream failed before producing an assistant message";
        yield* this.recordEvent(
          {
            type: "turn-end",
            sessionId: this.sessionId,
            turnIndex,
            timestamp: nowIso(),
            toolCallCount: 0
          },
          recorder
        );
        break;
      }

      const assistant = assistantResult.message;
      messages.push(assistant);
      await recorder.recordMessage(assistant);

      if (this.abortController.signal.aborted) {
        endReason = "aborted";
        yield* this.recordEvent(
          {
            type: "turn-end",
            sessionId: this.sessionId,
            turnIndex,
            timestamp: nowIso(),
            toolCallCount: 0
          },
          recorder
        );
        break;
      }

      if (assistant.metadata?.stopReason === "error") {
        endReason = "error";
        endError = typeof assistant.metadata.error === "string" ? assistant.metadata.error : "Provider stream failed";
        yield* this.recordEvent(
          {
            type: "turn-end",
            sessionId: this.sessionId,
            turnIndex,
            timestamp: nowIso(),
            toolCallCount: 0
          },
          recorder
        );
        break;
      }

      if (isNoProgressAssistant(assistant)) {
        const noProgressEvents: AgentEvent[] = [];
        const recovery = await this.applyRuntimeSteering("empty-response", messages, recorder, noProgressEvents);
        yield* flushEvents(noProgressEvents);
        if (recovery === "intervention-required") {
          endReason = "error";
          endError = "Runtime intervention required";
          yield* this.recordEvent(
            {
              type: "turn-end",
              sessionId: this.sessionId,
              turnIndex,
              timestamp: nowIso(),
              toolCallCount: 0
            },
            recorder
          );
          break;
        }
        yield* this.recordEvent(
          {
            type: "turn-end",
            sessionId: this.sessionId,
            turnIndex,
            timestamp: nowIso(),
            toolCallCount: 0
          },
          recorder
        );
        continue;
      }

      const toolCalls = assistant.blocks.filter((block): block is ToolCallBlock => block.type === "tool-call");
      if (toolCalls.length === 0) {
        this.recoverySteeringCount = 0;
        yield* this.recordEvent(
          {
            type: "turn-end",
            sessionId: this.sessionId,
            turnIndex,
            timestamp: nowIso(),
            toolCallCount: 0
          },
          recorder
        );
        break;
      }

      const toolResults = yield* this.executeToolCalls(toolCalls, tools, recorder);
      if (toolResults.every((block) => !block.isError)) {
        this.recoverySteeringCount = 0;
      }
      for (const block of toolResults) {
        const message: AgentMessage = {
          id: createId("tool"),
          role: "tool",
          createdAt: nowIso(),
          blocks: [block]
        };
        yield* this.recordMessage(message, messages, recorder);
      }

      yield* this.recordEvent(
        {
          type: "turn-end",
          sessionId: this.sessionId,
          turnIndex,
          timestamp: nowIso(),
          toolCallCount: toolCalls.length
        },
        recorder
      );
    }

    if (messages.at(-1)?.role === "tool" && endReason === "stop") {
      endReason = "max-turns";
    }

    yield* this.recordEvent(
      {
        type: "agent-end",
        sessionId: this.sessionId,
        timestamp: nowIso(),
        reason: endReason,
        error: endError
      },
      recorder
    );
    return messages;
  }

  private async resolveTools(): Promise<AgentTool[]> {
    const fromSources = await Promise.all((this.options.toolSources ?? []).map((source) => source.listTools()));
    const tools = [...(this.options.tools ?? []), ...fromSources.flat()];
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate tool registered: ${tool.name}`);
      }
      seen.add(tool.name);
    }
    return tools;
  }

  private async handleRuntimeRecovery(
    messages: AgentMessage[],
    recorder: SessionRecorder,
    events: AgentEvent[]
  ): Promise<"continue" | "intervention-required"> {
    const options = this.options.recovery;
    if (options?.enabled === false || messages.length === 0) return "continue";

    const reason =
      detectRecentToolErrorLoop(messages, options?.maxConsecutiveToolErrors ?? 2) ??
      detectRepeatedToolCallLoop(messages, options?.maxRepeatedToolCalls ?? 3);
    if (!reason) return "continue";

    return this.applyRuntimeSteering(reason, messages, recorder, events);
  }

  private async applyRuntimeSteering(
    reason: RuntimeRecoveryReason,
    messages: AgentMessage[],
    recorder: SessionRecorder,
    events: AgentEvent[]
  ): Promise<"continue" | "intervention-required"> {
    const options = this.options.recovery;
    const maxSteeringMessages = options?.maxSteeringMessages ?? 1;
    if (this.recoverySteeringCount >= maxSteeringMessages) {
      await this.emitAndRecord(
        {
          type: "runtime-intervention-required",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          reason,
          choices: ["rollback", "pause", "user-instruction"],
          message: "The agent did not recover after runtime steering."
        },
        recorder,
        events
      );
      return "intervention-required";
    }

    const message = createTextMessage("system", runtimeSteeringText(reason), {
      kind: "runtime-steering",
      reason,
      steeringCount: this.recoverySteeringCount + 1
    });
    messages.push(message);
    await recorder.recordMessage(message);
    this.recoverySteeringCount += 1;
    await this.emitAndRecord(
      {
        type: "runtime-steering",
        sessionId: this.sessionId,
        timestamp: nowIso(),
        reason,
        message
      },
      recorder,
      events
    );
    return "continue";
  }

  private async maybeCompressContext(messages: AgentMessage[], recorder: SessionRecorder, events: AgentEvent[]): Promise<void> {
    const options = this.options.contextCompression;
    if (!options || options.enabled === false || messages.length === 0) return;

    const compressor = new ContextCompressor({
      ...options,
      toolOutputBudget: options.toolOutputBudget ?? this.options.toolOutputBudget
    });
    const decision = compressor.shouldCompress(messages, "auto");
    if (!decision.shouldCompress) return;

    await this.emitAndRecord(
      {
        type: "context-compression-start",
        sessionId: this.sessionId,
        timestamp: nowIso(),
        reason: "auto",
        tokensBefore: decision.tokensBefore
      },
      recorder,
      events
    );

    try {
      const result = await compressor.compress(messages, "auto", decision.tokensBefore);
      if (!result) {
        await this.emitAndRecord(
          {
            type: "context-compression-end",
            sessionId: this.sessionId,
            timestamp: nowIso(),
            aborted: true,
            error: "No compressible context region"
          },
          recorder,
          events
        );
        return;
      }

      messages.splice(0, messages.length, ...result.messages);
      await recorder.recordCompaction(result.record);
      await this.emitAndRecord(
        {
          type: "context-compression-end",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          result: result.record,
          aborted: false
        },
        recorder,
        events
      );
    } catch (cause) {
      await this.emitAndRecord(
        {
          type: "context-compression-end",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          aborted: true,
          error: cause instanceof Error ? cause.message : String(cause)
        },
        recorder,
        events
      );
    }
  }

  private async *collectAssistantMessage(
    messages: AgentMessage[],
    tools: AgentTool[],
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, CollectedAssistantResult> {
    const assistant: AgentMessage = {
      id: createId("assistant"),
      role: "assistant",
      createdAt: nowIso(),
      blocks: []
    };

    let textBuffer = "";
    let thoughtBuffer = "";
    let stopReason: "stop" | "tool-call" | "length" | "error" = "stop";
    let error: string | undefined;
    let usage: Extract<ProviderStreamEvent, { type: "stop" }>["usage"];
    let messageStarted = false;
    const ensureMessageStarted = async function* (runtime: AgentRuntime): AsyncGenerator<AgentEvent, void> {
      if (messageStarted) return;
      messageStarted = true;
      yield* runtime.recordEvent({ type: "message-start", sessionId: runtime.sessionId, message: assistant }, recorder);
    };

    try {
      for await (const event of this.options.provider.stream({
        sessionId: this.sessionId,
        cwd: this.options.cwd,
        systemPrompt: this.options.systemPrompt,
        messages: projectMessagesForProvider(messages, {
          toolOutputBudget: this.options.toolOutputBudget ?? this.options.contextCompression?.toolOutputBudget
        }),
        tools,
        signal: this.abortController.signal
      })) {
        if (this.abortController.signal.aborted) {
          stopReason = "error";
          error = "aborted";
          break;
        }
        if (event.type === "text-delta") {
          yield* ensureMessageStarted(this);
          textBuffer += event.text;
          const block = { type: "text", text: event.text } as const;
          assistant.blocks.push(block);
          yield* this.recordEvent({ type: "message-delta", sessionId: this.sessionId, messageId: assistant.id, block }, recorder);
        } else if (event.type === "thought-delta") {
          yield* ensureMessageStarted(this);
          thoughtBuffer += event.text;
          const block = { type: "thought", text: event.text, ...(event.redacted !== undefined ? { redacted: event.redacted } : {}) } as const;
          assistant.blocks.push(block);
          yield* this.recordEvent({ type: "message-delta", sessionId: this.sessionId, messageId: assistant.id, block }, recorder);
        } else if (event.type === "tool-call") {
          yield* ensureMessageStarted(this);
          const tool = tools.find((candidate) => candidate.name === event.toolName);
          const repair = tool ? repairToolInput(tool, event.input) : { input: event.input, repaired: false, notes: [] };
          const block: ToolCallBlock = {
            type: "tool-call",
            id: event.id ?? createId("call"),
            toolName: event.toolName,
            input: repair.input
          };
          if (repair.repaired) {
            yield* this.recordEvent(
              {
                type: "tool-input-repaired",
                sessionId: this.sessionId,
                timestamp: nowIso(),
                toolCallId: block.id,
                toolName: block.toolName,
                notes: repair.notes
              },
              recorder
            );
          }
          assistant.blocks.push(block);
          yield* this.recordEvent({ type: "message-delta", sessionId: this.sessionId, messageId: assistant.id, block }, recorder);
        } else if (event.type === "provider-diagnostic") {
          yield* this.recordEvent({ type: "provider-diagnostic", sessionId: this.sessionId, timestamp: nowIso(), diagnostic: event.diagnostic }, recorder);
        } else if (event.type === "stop") {
          stopReason = event.reason;
          error = event.error;
          usage = event.usage;
        }
      }
    } catch (cause) {
      stopReason = "error";
      error = cause instanceof Error ? cause.message : String(cause);
    }

    if (stopReason === "error" && assistant.blocks.length === 0) {
      const runtimeError = error ?? "Provider stream failed before producing an assistant message";
      yield* this.recordEvent({ type: "runtime-error", sessionId: this.sessionId, timestamp: nowIso(), error: runtimeError }, recorder);
      return { error: runtimeError };
    }

    yield* ensureMessageStarted(this);
    assistant.metadata = {
      stopReason,
      ...(error ? { error } : {}),
      text: textBuffer,
      ...(thoughtBuffer ? { thought: thoughtBuffer } : {}),
      ...(usage ? { usage: usage as unknown as JsonObject } : {})
    };
    yield* this.recordEvent({ type: "message-end", sessionId: this.sessionId, message: assistant }, recorder);
    return { message: assistant };
  }

  private async *executeToolCalls(
    toolCalls: ToolCallBlock[],
    tools: AgentTool[],
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    for (const batch of this.partitionToolCalls(toolCalls, tools)) {
      const batchId = createId("batch");
      const calls = batch.map((call) => this.toBatchCall(call, tools));
      yield* this.recordEvent(
        {
          type: "tool-batch-start",
          sessionId: this.sessionId,
          batchId,
          timestamp: nowIso(),
          summary: this.summarizeBatch(calls),
          calls
        },
        recorder
      );

      const batchResults =
        calls.length > 1 && calls.every((call) => call.concurrency === "parallel")
          ? yield* this.executeParallelBatch(batch, calls, tools, batchId, recorder)
          : yield* this.executeSequentialBatch(batch, calls, tools, batchId, recorder);

      yield* this.recordEvent(
        {
          type: "tool-batch-end",
          sessionId: this.sessionId,
          batchId,
          timestamp: nowIso(),
          calls: batchResults
        },
        recorder
      );

      results.push(
        ...batchResults.map((result): ToolResultBlock => ({
          type: "tool-result",
          toolCallId: result.id,
          toolName: result.toolName,
          output: result.output,
          isError: result.isError
        }))
      );
    }
    return results;
  }

  private async *executeSequentialBatch(
    toolCalls: ToolCallBlock[],
    calls: ToolBatchCall[],
    tools: AgentTool[],
    batchId: string,
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, ToolBatchResult[]> {
    const results: ToolBatchResult[] = [];
    for (let index = 0; index < toolCalls.length; index++) {
      results.push(yield* this.executeSingleTool(toolCalls[index]!, calls[index]!, tools, batchId, recorder));
    }
    return results;
  }

  private async *executeParallelBatch(
    toolCalls: ToolCallBlock[],
    calls: ToolBatchCall[],
    tools: AgentTool[],
    batchId: string,
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, ToolBatchResult[]> {
    type ParallelItem =
      | { type: "event"; event: AgentEvent }
      | { type: "result"; index: number; result: ToolBatchResult }
      | { type: "error"; error: unknown };
    const queue = new AsyncEventQueue<ParallelItem>();
    const results: Array<ToolBatchResult | undefined> = new Array(toolCalls.length);
    let completed = 0;

    for (let index = 0; index < toolCalls.length; index++) {
      const iterator = this.executeSingleTool(toolCalls[index]!, calls[index]!, tools, batchId, recorder);
      void (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              queue.push({ type: "result", index, result: next.value });
              break;
            }
            queue.push({ type: "event", event: next.value });
          }
        } catch (error) {
          queue.push({ type: "error", error });
        }
      })();
    }

    while (completed < toolCalls.length) {
      const next = await queue.next();
      if (next.done) break;
      if (next.value.type === "event") {
        yield next.value.event;
        continue;
      }
      if (next.value.type === "error") {
        throw next.value.error;
      }
      results[next.value.index] = next.value.result;
      completed += 1;
    }

    queue.close();
    return results.filter((result): result is ToolBatchResult => Boolean(result));
  }

  private async *executeSingleTool(
    toolCall: ToolCallBlock,
    call: ToolBatchCall,
    tools: AgentTool[],
    batchId: string,
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, ToolBatchResult> {
    const startedAt = Date.now();
    yield* this.recordEvent({ type: "tool-start", sessionId: this.sessionId, batchId, call, timestamp: nowIso() }, recorder);

    const tool = tools.find((candidate) => candidate.name === toolCall.toolName);
    if (!tool) {
      const result = this.toToolBatchResult(call, startedAt, { text: `Tool not found: ${toolCall.toolName}` }, true);
      yield* this.recordEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() }, recorder);
      return result;
    }

    const validationErrors = validateToolInput(tool, toolCall.input);
    if (validationErrors.length > 0) {
      const advice = validationAdviceForToolInput(tool, toolCall.input, validationErrors);
      const result = this.toToolBatchResult(
        call,
        startedAt,
        { text: [`Tool input validation failed:`, ...validationErrors.map((error) => `- ${error}`), ...advice].join("\n") },
        true
      );
      yield* this.recordEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() }, recorder);
      return result;
    }

    const permission = yield* this.resolvePermission(tool, toolCall.input, recorder);
    if (permission.behavior !== "allow") {
      const result = this.toToolBatchResult(call, startedAt, { text: permission.reason ?? "Tool execution denied" }, true);
      yield* this.recordEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() }, recorder);
      return result;
    }

    const progressQueue = new AsyncEventQueue<AgentEvent>();
    const execution = Promise.resolve()
      .then(() =>
        tool.execute(toolCall.input, {
          toolCallId: toolCall.id,
          sessionId: this.sessionId,
          cwd: this.options.cwd,
          signal: this.abortController.signal,
          emit: (update) => {
            progressQueue.push({
              type: "tool-update",
              sessionId: this.sessionId,
              batchId,
              toolCallId: toolCall.id,
              update,
              timestamp: nowIso()
            });
          }
        })
      )
      .then(
        (output) => ({ ok: true as const, output }),
        (cause) => ({ ok: false as const, cause })
      )
      .finally(() => progressQueue.close());

    while (true) {
      const next = await progressQueue.next();
      if (next.done) break;
      yield* this.recordEvent(next.value, recorder);
    }

    const completed = await execution;
    if (completed.ok) {
      const output = await this.materializeLargeToolOutput(toolCall, completed.output);
      const result = this.toToolBatchResult(call, startedAt, output, false);
      yield* this.recordEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() }, recorder);
      yield* this.recordToolCheckpointEvents(result, recorder);
      return result;
    }

    const output = await this.materializeLargeToolOutput(toolCall, {
      text: completed.cause instanceof Error ? completed.cause.message : String(completed.cause)
    });
    const result = this.toToolBatchResult(call, startedAt, output, true);
    yield* this.recordEvent({ type: "tool-end", sessionId: this.sessionId, batchId, result, timestamp: nowIso() }, recorder);
    return result;
  }

  private async materializeLargeToolOutput(toolCall: ToolCallBlock, output: ToolOutput): Promise<ToolOutput> {
    if (typeof output.text !== "string") return output;
    const threshold = this.options.toolOutputBudget?.artifactChars ?? DEFAULT_ARTIFACT_CHARS;
    if (output.text.length <= threshold) return output;

    const artifactDir = this.toolOutputArtifactDir();
    await mkdir(artifactDir, { recursive: true });
    const hash = createHash("sha256").update(output.text).digest("hex");
    const fileName = `${safeArtifactName(toolCall.toolName)}-${safeArtifactName(toolCall.id)}-${hash.slice(0, 16)}.log`;
    const filePath = join(artifactDir, fileName);
    await writeFile(filePath, output.text, "utf8");

    const previewChars = Math.min(this.options.toolOutputBudget?.inlineChars ?? DEFAULT_ARTIFACT_PREVIEW_CHARS, DEFAULT_ARTIFACT_PREVIEW_CHARS);
    const preview = budgetTextForContext(output.text, { inlineChars: previewChars, headRatio: this.options.toolOutputBudget?.headRatio });
    const artifact: ToolArtifact = {
      kind: "log",
      title: `Full tool output: ${toolCall.toolName}`,
      uri: filePath,
      metadata: {
        artifactKind: "tool-output",
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        originalChars: output.text.length,
        sha256: hash,
        artifactPath: filePath
      }
    };

    return {
      ...output,
      text: `Full tool output saved to artifact: ${filePath}\nOriginal characters: ${output.text.length.toLocaleString("en-US")}\n\nPreview:\n${preview.text}`,
      artifacts: [...(output.artifacts ?? []), artifact]
    };
  }

  private toolOutputArtifactDir(): string {
    const configured = this.options.toolOutputBudget?.artifactDir;
    if (configured) return isAbsolute(configured) ? configured : resolve(this.options.cwd, configured);
    return resolve(this.options.cwd, ".codex", "agent-artifacts", this.sessionId);
  }

  private async *resolvePermission(
    tool: AgentTool,
    input: JsonObject,
    recorder: SessionRecorder
  ): AsyncGenerator<AgentEvent, PermissionDecision> {
    const request: PermissionRequest = {
      id: createId("approval"),
      sessionId: this.sessionId,
      cwd: this.options.cwd,
      tool,
      input,
      summary: tool.summarize(input)
    };

    const policy = this.options.permissionPolicy ?? allowAllPolicy;
    const policyDecision = await policy.decide(request);
    if (policyDecision.behavior !== "ask") {
      return policyDecision;
    }

    yield* this.recordEvent({ type: "approval-requested", sessionId: this.sessionId, request, timestamp: nowIso() }, recorder);
    const decision: PermissionDecision = this.options.approvalHandler
      ? await this.options.approvalHandler.requestApproval(request)
      : { behavior: "deny", reason: "Approval required but no approval handler is configured" };
    policy.recordDecision?.(request, decision);
    yield* this.recordEvent(
      { type: "approval-resolved", sessionId: this.sessionId, requestId: request.id, decision, timestamp: nowIso() },
      recorder
    );
    return decision;
  }

  private async *recordToolCheckpointEvents(result: ToolBatchResult, recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    for (const checkpoint of checkpointRecordsFromToolResult(result)) {
      await recorder.recordCheckpoint(checkpoint.label, checkpoint as unknown as JsonObject);
      await this.options.contextCompression?.contextState?.recordCheckpoint?.(checkpoint);
      yield* this.recordEvent(
        {
          type: "checkpoint-created",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          checkpoint
        },
        recorder
      );
    }

    const restore = checkpointRestoreRecordFromToolResult(result);
    if (restore) {
      yield* this.recordEvent(
        {
          type: "checkpoint-restored",
          sessionId: this.sessionId,
          timestamp: nowIso(),
          restore
        },
        recorder
      );
    }
  }

  private partitionToolCalls(toolCalls: ToolCallBlock[], tools: AgentTool[]): ToolCallBlock[][] {
    const batches: ToolCallBlock[][] = [];
    for (const call of toolCalls) {
      const tool = tools.find((candidate) => candidate.name === call.toolName);
      const canJoinPrevious = tool?.concurrency === "parallel" && batches.at(-1)?.every((item) => {
        const previousTool = tools.find((candidate) => candidate.name === item.toolName);
        return previousTool?.concurrency === "parallel";
      });
      if (canJoinPrevious) {
        batches.at(-1)!.push(call);
      } else {
        batches.push([call]);
      }
    }
    return batches;
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

  private summarizeBatch(calls: ToolBatchCall[]): string {
    if (calls.length === 1) {
      return calls[0]!.summary;
    }
    const counts = new Map<string, number>();
    for (const call of calls) {
      counts.set(call.category, (counts.get(call.category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([category, count]) => `${count} ${category}`)
      .join(", ");
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

  private event(event: Omit<Extract<AgentEvent, { type: "agent-start" }>, "sessionId" | "timestamp">): AgentEvent {
    return { ...event, sessionId: this.sessionId, timestamp: nowIso() };
  }

  private async *recordMessage(message: AgentMessage, messages: AgentMessage[], recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    const start: AgentEvent = { type: "message-start", sessionId: this.sessionId, message };
    yield* this.recordEvent(start, recorder);
    yield* this.recordEvent({ type: "message-end", sessionId: this.sessionId, message }, recorder);
    messages.push(message);
    await recorder.recordMessage(message);
  }

  private async *recordEvent(event: AgentEvent, recorder: SessionRecorder): AsyncGenerator<AgentEvent> {
    await recorder.recordEvent(event);
    yield event;
  }

  private async emitAndRecord(event: AgentEvent, recorder: SessionRecorder, events?: AgentEvent[]): Promise<void> {
    await recorder.recordEvent(event);
    events?.push(event);
  }

}

function* flushEvents(events: AgentEvent[]): Generator<AgentEvent> {
  for (const event of events) {
    yield event;
  }
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function detectRecentToolErrorLoop(messages: AgentMessage[], minErrors: number): RuntimeRecoveryReason | undefined {
  let errors = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "system" || message.role === "assistant") continue;
    if (message.role === "user") break;
    if (message.role !== "tool") continue;
    for (const block of message.blocks) {
      if (block.type !== "tool-result") continue;
      if (!isToolResultFailure(block)) return undefined;
      errors += 1;
      if (errors >= minErrors) return "tool-errors";
    }
  }
  return undefined;
}

function isToolResultFailure(block: ToolResultBlock): boolean {
  if (block.isError) return true;
  const exitCode = exitCodeFromToolOutput(block.output);
  return exitCode !== undefined && exitCode !== 0;
}

function exitCodeFromToolOutput(output: ToolOutput): number | undefined {
  const json = output.json;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    const exitCode = numberFromUnknown(record.exitCode) ?? numberFromUnknown(record.exit_code);
    if (exitCode !== undefined) return exitCode;
  }
  const match = stringifyToolOutput(output).match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detectRepeatedToolCallLoop(messages: AgentMessage[], minRepeats: number): RuntimeRecoveryReason | undefined {
  const counts = new Map<string, number>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "tool-call") continue;
      const signature = `${block.toolName}:${JSON.stringify(block.input)}`;
      const next = (counts.get(signature) ?? 0) + 1;
      if (next >= minRepeats) return "tool-loop";
      counts.set(signature, next);
    }
  }
  return undefined;
}

function isNoProgressAssistant(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return !message.blocks.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    if (block.type === "tool-call") return true;
    if (block.type === "tool-result") return true;
    return false;
  });
}

function runtimeSteeringText(reason: RuntimeRecoveryReason): string {
  if (reason === "tool-errors") {
    return [
      "Runtime steering: recent tool calls failed repeatedly.",
      "Do not repeat the same call. Diagnose the failure briefly, change the arguments or strategy, and continue only with a materially different next action.",
      "If the blocker cannot be resolved with the available tools, stop and explain the blocker."
    ].join("\n");
  }
  if (reason === "empty-response") {
    return [
      "Runtime steering: the previous assistant turn produced no visible text and no tool call.",
      "Do not stop silently. Either call the next required tool or explain the blocker in one concise message.",
      "If the user requested file creation or inspection, use the available filesystem tools before answering."
    ].join("\n");
  }
  return [
    "Runtime steering: the same tool call appears to be repeating.",
    "Stop the loop, summarize what is already known, and choose a different strategy or ask for user guidance instead of issuing the same call again."
  ].join("\n");
}

function checkpointRecordsFromToolResult(result: ToolBatchResult): RuntimeCheckpointRecord[] {
  const records: RuntimeCheckpointRecord[] = [];
  for (const artifact of result.output.artifacts ?? []) {
    const metadata = artifact.metadata ?? {};
    const checkpointId = stringValue(metadata.checkpointId);
    const manifestPath = stringValue(metadata.manifestPath);
    if (checkpointId && manifestPath) {
      records.push({
        id: checkpointId,
        kind: "workspace-checkpoint",
        label: stringValue(metadata.label) ?? artifact.title,
        toolCallId: result.id,
        toolName: result.toolName,
        artifactUri: artifact.uri,
        manifestPath,
        metadata
      });
      continue;
    }

    const snapshotPath = stringValue(metadata.snapshotPath);
    if (snapshotPath) {
      records.push({
        id: createId("snapshot"),
        kind: "file-snapshot",
        label: artifact.title,
        toolCallId: result.id,
        toolName: result.toolName,
        artifactUri: artifact.uri,
        snapshotPath,
        sourcePath: stringValue(metadata.sourcePath),
        metadata
      });
    }
  }
  return records;
}

function checkpointRestoreRecordFromToolResult(result: ToolBatchResult): RuntimeCheckpointRestoreRecord | null {
  const json = result.output.json;
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const checkpointId = stringValue(record.checkpointId);
  if (!checkpointId) return null;
  const restored = stringArrayValue(record.restored);
  const deleted = stringArrayValue(record.deleted);
  const skipped = stringArrayValue(record.skipped);
  if (restored.length === 0 && deleted.length === 0 && skipped.length === 0) return null;
  return {
    checkpointId,
    toolCallId: result.id,
    toolName: result.toolName,
    restored,
    deleted,
    skipped,
    metadata: json as JsonObject
  };
}

function validationAdviceForToolInput(tool: AgentTool, input: JsonObject, errors: string[]): string[] {
  const hasParseError = typeof input.__parseError === "string" || errors.some((error) => /JSON parse failed/i.test(error));
  if (!hasParseError) return [];

  const rawArguments = typeof input.__rawArguments === "string" ? input.__rawArguments : "";
  const rawNote = rawArguments
    ? `- Raw argument preview: ${rawArguments.slice(0, 240).replace(/\s+/g, " ")}${rawArguments.length > 240 ? "..." : ""}`
    : "";
  const common = [
    "- Repair hint: send one valid JSON object only; do not include prose, markdown fences, comments, or trailing text in tool arguments."
  ];

  if (tool.name === "write_file") {
    return [
      ...common,
      "- For long content, do not retry write_file with a huge content string.",
      '- Use edit instead, in small chunks: {"path":"target/file.ext","edits":[{"op":"insert_tail","content":"...short chunk..."}]}.',
      "- Keep each edit chunk small enough to escape safely; after writing, read the file or rely on the edit result preview before continuing.",
      ...(rawNote ? [rawNote] : [])
    ];
  }

  if (tool.name === "edit") {
    return [
      ...common,
      '- Prefer small edits: {"path":"target/file.ext","edits":[{"op":"insert_tail","content":"...short chunk..."}]}.',
      "- If replacing existing content, read with format=hashline first and use line anchors.",
      ...(rawNote ? [rawNote] : [])
    ];
  }

  if (tool.name === "shell_command") {
    return [
      ...common,
      '- Use the minimal shape {"command":"..."} for commands.',
      "- Do not embed long generated file content in shell_command; use edit insert_tail chunks for file writes.",
      ...(rawNote ? [rawNote] : [])
    ];
  }

  return [...common, ...(rawNote ? [rawNote] : [])];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "artifact";
}

function summarizeToolCall(tool: AgentTool | undefined, input: JsonObject, fallback: string): string {
  if (!tool) return fallback;
  try {
    const summary = tool.summarize(input);
    return summary.trim() || fallback;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `${tool.name} (invalid input: ${reason})`;
  }
}
