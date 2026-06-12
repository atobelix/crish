import { budgetTextForContext, stringifyToolOutput, type ToolOutputBudgetOptions } from "./tool-output-budget";
import { createStructuredSummary, structuredSummaryCacheKey } from "./structured-summary";
import type {
  AgentMessage,
  AgentMessageBlock,
  ContextCompressionCacheBoundaryMetadata,
  ContextCompressionHandoffMetadata,
  ContextCompressionPolicyMetadata,
  ContextCompressionReason,
  ContextCompressionRecord,
  ContextCompressionTrigger,
  JsonObject,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock
} from "@crish/shared-types";
import type {
  ContextCompressionRuntimeOptions,
  ContextStateSnapshot,
  ProviderUsage
} from "./types";
import { createId, nowIso } from "./session";

export interface ContextCompressionResult {
  record: ContextCompressionRecord;
  summaryMessage: AgentMessage;
  messages: AgentMessage[];
}

export interface ContextTokenEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageMessageIndex: number | null;
}

export interface ContextCompressionDecision {
  shouldCompress: boolean;
  trigger: ContextCompressionTrigger;
  reason: ContextCompressionReason;
  policy: ContextCompressionPolicyMetadata;
  handoffIntent: boolean;
  tokensBefore: number;
  thresholdTokens: number;
}

export interface SerializeContextOptions {
  toolOutputBudget?: ToolOutputBudgetOptions;
  includeThought?: boolean;
}

const DEFAULT_THRESHOLD_RATIO = 0.75;
const DEFAULT_TARGET_RECENT_RATIO = 0.25;
const DEFAULT_MIN_RECENT_MESSAGES = 4;
const DEFAULT_MIN_MESSAGES_TO_COMPRESS = 4;
const DEFAULT_MAX_SUMMARY_TOKENS = 4_000;

export class ContextCompressor {
  constructor(private readonly options: ContextCompressionRuntimeOptions) {}

  shouldCompress(messages: AgentMessage[], trigger: ContextCompressionTrigger = "threshold"): ContextCompressionDecision {
    const tokensBefore = estimateContextTokens(messages).tokens;
    const thresholdTokens = this.thresholdTokens();
    const hasEnoughMessages =
      messages.length > this.minRecentMessages() &&
      messages.length >= (this.options.minMessagesToCompress ?? DEFAULT_MIN_MESSAGES_TO_COMPRESS) + 1;
    return createCompressionDecision(trigger, tokensBefore, thresholdTokens, hasEnoughMessages);
  }

  async maybeCompress(messages: AgentMessage[], trigger: ContextCompressionTrigger = "threshold"): Promise<ContextCompressionResult | null> {
    if (messages.length === 0) return null;
    const decision = this.shouldCompress(messages, trigger);
    if (!decision.shouldCompress) return null;
    return this.compress(messages, trigger, decision.tokensBefore, decision);
  }

  async compress(
    messages: AgentMessage[],
    trigger: ContextCompressionTrigger = "manual",
    tokensBefore = estimateContextTokens(messages).tokens,
    decision = createCompressionDecision(trigger, tokensBefore, this.thresholdTokens(), true)
  ): Promise<ContextCompressionResult | null> {
    const firstKeptIndex = findFirstKeptMessageIndex(messages, this.targetRecentTokens(), this.minRecentMessages());
    const compressed = messages.slice(0, firstKeptIndex);
    const kept = messages.slice(firstKeptIndex);
    if (compressed.length < (this.options.minMessagesToCompress ?? DEFAULT_MIN_MESSAGES_TO_COMPRESS)) {
      return null;
    }

    const state = await resolveContextState(this.options.contextState);
    const commandFacts = extractRecentTerminalCommandFacts(messages);
    const serializedConversation = serializeMessagesForSummary(compressed, {
      toolOutputBudget: this.options.toolOutputBudget ?? { inlineChars: 4_000 },
      includeThought: false
    });
    const summary = await this.options.summarizer.summarize({
      trigger,
      reason: decision.reason,
      policy: decision.policy,
      handoffIntent: decision.handoffIntent,
      serializedConversation,
      previousSummary: state.previousCompressionSummary,
      recentSuccessfulCommands: commandFacts.successful,
      recentFailedDiagnostics: commandFacts.failed,
      completedTaskSummaries: state.completedTaskSummaries,
      pendingTasks: state.pendingTasks,
      sessionEvents: state.sessionEvents,
      fileSnapshotHints: state.fileSnapshotHints,
      maxSummaryTokens: this.options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS
    });
    const tokensAfter = estimateContextTokens([createCompressionSummaryMessage(summary), ...kept]).tokens;
    const structuredSummary = createStructuredSummary({
      kind: "context-compression",
      goal: lastUserMessageText(messages) ?? undefined,
      progress: [summary, ...state.completedTaskSummaries],
      nextSteps: state.pendingTasks,
      criticalContext: [
        ...state.sessionEvents,
        ...state.fileSnapshotHints,
        ...commandFacts.successful,
        ...commandFacts.failed
      ],
      readFiles: readFilesFromSnapshotHints(state.fileSnapshotHints),
      modifiedFiles: modifiedFilesFromSnapshotHints(state.fileSnapshotHints),
      risks: commandFacts.failed,
      sourceIds: messages.map((message) => message.id)
    });
    const cacheBoundary = createCompressionCacheBoundary({
      reason: decision.reason,
      structuredSummary,
      compressed,
      kept
    });
    const handoff = createHandoffMetadata({
      trigger,
      reason: decision.reason,
      policy: decision.policy,
      summary,
      messages,
      compressed,
      kept,
      tokensBefore,
      tokensAfter,
      thresholdTokens: decision.thresholdTokens,
      state,
      commandFacts
    });

    const record: ContextCompressionRecord = {
      id: createId("compact"),
      trigger,
      reason: decision.reason,
      policy: decision.policy,
      summary,
      firstKeptMessageId: kept[0]?.id,
      compressedMessageIds: compressed.map((message) => message.id),
      keptMessageIds: kept.map((message) => message.id),
      tokensBefore,
      tokensAfter,
      thresholdTokens: decision.thresholdTokens,
      createdAt: nowIso(),
      handoff,
      cacheBoundary,
      details: compactJson({
        policy: decision.policy,
        handoffIntent: decision.handoffIntent,
        recentSuccessfulCommands: commandFacts.successful,
        recentFailedDiagnostics: commandFacts.failed,
        completedTaskSummaries: state.completedTaskSummaries,
        pendingTasks: state.pendingTasks,
        sessionEvents: state.sessionEvents,
        fileSnapshotHints: state.fileSnapshotHints,
        structuredSummary: structuredSummary as unknown as JsonObject,
        structuredSummaryCacheKey: cacheBoundary.structuredSummaryCacheKey,
        cacheBoundary: cacheBoundary as unknown as JsonObject
      })
    };

    await this.options.contextState?.recordCompression?.(record);
    const summaryMessage = createCompressionSummaryMessage(summary, record);

    return {
      record,
      summaryMessage,
      messages: [summaryMessage, ...kept]
    };
  }

  private thresholdTokens(): number {
    return this.options.thresholdTokens ?? Math.floor(this.options.contextWindowTokens * (this.options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO));
  }

  private targetRecentTokens(): number {
    return this.options.targetRecentTokens ?? Math.floor(this.options.contextWindowTokens * (this.options.targetRecentRatio ?? DEFAULT_TARGET_RECENT_RATIO));
  }

  private minRecentMessages(): number {
    return Math.max(1, this.options.minRecentMessages ?? DEFAULT_MIN_RECENT_MESSAGES);
  }
}

export function createCompressionSummaryMessage(summary: string, record?: ContextCompressionRecord): AgentMessage {
  return {
    id: record?.id ?? createId("context"),
    role: "user",
    createdAt: record?.createdAt ?? nowIso(),
    blocks: [
      {
        type: "text",
        text: `<context_checkpoint>\n${summary.trim()}\n</context_checkpoint>`
      }
    ],
    metadata: compactJson({
      kind: "context-compression-summary",
      compactionId: record?.id,
      trigger: record?.trigger,
      reason: record?.reason,
      policy: record?.policy,
      handoff: record?.handoff,
      tokensBefore: record?.tokensBefore,
      tokensAfter: record?.tokensAfter,
      thresholdTokens: record?.thresholdTokens,
      cacheBoundary: record?.cacheBoundary
    })
  };
}

function createCompressionCacheBoundary(input: {
  reason: ContextCompressionReason;
  structuredSummary: ReturnType<typeof createStructuredSummary>;
  compressed: AgentMessage[];
  kept: AgentMessage[];
}): ContextCompressionCacheBoundaryMetadata {
  const stablePrefixHash = input.structuredSummary.stableHash;
  const compressedMessageIds = input.compressed.map((message) => message.id);
  const keptMessageIds = input.kept.map((message) => message.id);
  return compactJson({
    kind: "context-compression-cache-boundary",
    version: 1,
    stablePrefixHash,
    cacheKey: `context-compression:v1:${stablePrefixHash}`,
    structuredSummaryCacheKey: structuredSummaryCacheKey(input.structuredSummary),
    structuredSummaryStableHash: input.structuredSummary.stableHash,
    invalidates: ["prompt-stable-prefix", "message-history", "usage-baseline", "volatile-context"],
    invalidationReason: input.reason,
    compressedMessageIds,
    keptMessageIds,
    firstKeptMessageId: input.kept[0]?.id
  }) as unknown as ContextCompressionCacheBoundaryMetadata;
}

function createCompressionDecision(
  trigger: ContextCompressionTrigger,
  tokensBefore: number,
  thresholdTokens: number,
  hasEnoughMessages: boolean
): ContextCompressionDecision {
  const reason = reasonForTrigger(trigger);
  const thresholdExceeded = tokensBefore >= thresholdTokens;
  const thresholdGated = isThresholdGatedTrigger(trigger);
  const policy: ContextCompressionPolicyMetadata = {
    tier: tierForReason(reason),
    action: actionForReason(reason),
    forced: !thresholdGated,
    thresholdExceeded,
    providerRetry: false
  };
  return {
    shouldCompress: hasEnoughMessages && (!thresholdGated || thresholdExceeded),
    trigger,
    reason,
    policy,
    handoffIntent: policy.action === "promote-handoff",
    tokensBefore,
    thresholdTokens
  };
}

function reasonForTrigger(trigger: ContextCompressionTrigger): ContextCompressionReason {
  if (trigger === "auto" || trigger === "preflight") return "threshold";
  return trigger;
}

function isThresholdGatedTrigger(trigger: ContextCompressionTrigger): boolean {
  return trigger === "auto" || trigger === "threshold";
}

function tierForReason(reason: ContextCompressionReason): ContextCompressionPolicyMetadata["tier"] {
  if (reason === "manual") return "manual";
  if (reason === "overflow" || reason === "incomplete") return "recovery";
  if (reason === "idle") return "background";
  if (reason === "handoff") return "handoff";
  return "proactive";
}

function actionForReason(reason: ContextCompressionReason): ContextCompressionPolicyMetadata["action"] {
  if (reason === "overflow" || reason === "incomplete" || reason === "handoff") return "promote-handoff";
  return "compact";
}

function createHandoffMetadata(input: {
  trigger: ContextCompressionTrigger;
  reason: ContextCompressionReason;
  policy: ContextCompressionPolicyMetadata;
  summary: string;
  messages: AgentMessage[];
  compressed: AgentMessage[];
  kept: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
  thresholdTokens: number;
  state: ContextStateSnapshot;
  commandFacts: { successful: string[]; failed: string[] };
}): ContextCompressionHandoffMetadata {
  return {
    trigger: input.trigger,
    reason: input.reason,
    tier: input.policy.tier,
    action: input.policy.action,
    providerRetry: input.policy.providerRetry,
    summary: input.summary,
    compressedMessageCount: input.compressed.length,
    keptMessageCount: input.kept.length,
    tokensBefore: input.tokensBefore,
    tokensAfter: input.tokensAfter,
    thresholdTokens: input.thresholdTokens,
    ...(input.kept[0]?.id ? { firstKeptMessageId: input.kept[0].id } : {}),
    ...(input.messages.at(-1)?.id ? { lastMessageId: input.messages.at(-1)!.id } : {}),
    ...lastUserMessageMetadata(input.messages),
    completedTaskSummaries: input.state.completedTaskSummaries,
    pendingTasks: input.state.pendingTasks,
    sessionEvents: input.state.sessionEvents,
    fileSnapshotHints: input.state.fileSnapshotHints,
    recentSuccessfulCommands: input.commandFacts.successful,
    recentFailedDiagnostics: input.commandFacts.failed
  };
}

function lastUserMessageMetadata(messages: AgentMessage[]): { lastUserMessageId?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") return { lastUserMessageId: message.id };
  }
  return {};
}

function lastUserMessageText(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = textFromBlocks(message.blocks).trim();
    return text.length > 0 ? text : message.id;
  }
  return undefined;
}

function readFilesFromSnapshotHints(hints: string[]): string[] {
  return filePathsFromSnapshotHints(hints, (hint) => !/\b(?:checkpoint|edit|write|mutation|modified|restore)\b/i.test(hint));
}

function modifiedFilesFromSnapshotHints(hints: string[]): string[] {
  return filePathsFromSnapshotHints(hints, (hint) => /\b(?:checkpoint|edit|write|mutation|modified|restore)\b/i.test(hint));
}

function filePathsFromSnapshotHints(hints: string[], predicate: (hint: string) => boolean): string[] {
  const paths = new Set<string>();
  for (const hint of hints) {
    if (!predicate(hint)) continue;
    const path = hint.split(":")[0]?.trim();
    if (path) paths.add(path.replace(/\\/g, "/"));
  }
  return [...paths].sort();
}

export function estimateContextTokens(messages: AgentMessage[]): ContextTokenEstimate {
  const latestCompressionSummary = findLatestCompressionSummary(messages);
  let usageInfo: { usage: ProviderUsage; index: number } | undefined;
  for (let index = messages.length - 1; index > latestCompressionSummary.index; index--) {
    const message = messages[index]!;
    if (latestCompressionSummary.createdAtMs !== undefined && messageCreatedAtMs(message) <= latestCompressionSummary.createdAtMs) {
      continue;
    }
    const usage = providerUsageFromMessage(message);
    if (usage?.totalTokens !== undefined) {
      usageInfo = { usage, index };
      break;
    }
  }

  if (!usageInfo) {
    const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageMessageIndex: null };
  }

  const usageTokens = usageInfo.usage.totalTokens ?? 0;
  const trailingTokens = messages.slice(usageInfo.index + 1).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageMessageIndex: usageInfo.index
  };
}

function findLatestCompressionSummary(messages: AgentMessage[]): { index: number; createdAtMs?: number } {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.metadata?.kind === "context-compression-summary") {
      return { index, createdAtMs: messageCreatedAtMs(messages[index]!) };
    }
  }
  return { index: -1 };
}

function messageCreatedAtMs(message: AgentMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

export function estimateMessageTokens(message: AgentMessage): number {
  const chars = message.blocks.reduce((sum, block) => sum + estimateBlockChars(block), 0);
  return Math.ceil(chars / 4);
}

export function serializeMessagesForSummary(messages: AgentMessage[], options: SerializeContextOptions = {}): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      const text = textFromBlocks(message.blocks);
      if (text.trim()) parts.push(`[${capitalize(message.role)}]: ${text}`);
      continue;
    }

    if (message.role === "assistant") {
      const text = textFromBlocks(message.blocks);
      const thought = options.includeThought ? thoughtFromBlocks(message.blocks) : "";
      const toolCalls = message.blocks
        .filter((block): block is ToolCallBlock => block.type === "tool-call")
        .map((block) => `${block.toolName}(${JSON.stringify(block.input)})`);
      if (thought.trim()) parts.push(`[Assistant thought]: ${thought}`);
      if (text.trim()) parts.push(`[Assistant]: ${text}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      continue;
    }

    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type !== "tool-result") continue;
        const raw = stringifyToolOutput(block.output);
        const budgeted = budgetTextForContext(raw, options.toolOutputBudget ?? { inlineChars: 4_000 });
        parts.push(`[Tool result: ${block.toolName} ${block.isError ? "error" : "ok"}]: ${budgeted.text}`);
      }
    }
  }
  return parts.join("\n\n");
}

export function findFirstKeptMessageIndex(messages: AgentMessage[], targetRecentTokens: number, minRecentMessages = DEFAULT_MIN_RECENT_MESSAGES): number {
  if (messages.length <= minRecentMessages) return 0;

  let tokens = 0;
  let index = messages.length - 1;
  const minIndex = Math.max(0, messages.length - minRecentMessages);
  for (; index >= 0; index--) {
    tokens += estimateMessageTokens(messages[index]!);
    if (tokens >= targetRecentTokens && index <= minIndex) break;
  }

  let firstKeptIndex = Math.min(index, minIndex);
  firstKeptIndex = Math.max(0, firstKeptIndex);
  firstKeptIndex = includeLatestUserMessage(messages, firstKeptIndex);
  firstKeptIndex = includeRequiredToolCallMessages(messages, firstKeptIndex);
  return firstKeptIndex;
}

export function extractRecentTerminalCommandFacts(messages: AgentMessage[], limit = 8): { successful: string[]; failed: string[] } {
  const calls = new Map<string, ToolCallBlock>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type === "tool-call") calls.set(block.id, block);
    }
  }

  const successful: string[] = [];
  const failed: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool") continue;
    for (const block of [...message.blocks].reverse()) {
      if (block.type !== "tool-result") continue;
      const call = calls.get(block.toolCallId);
      if (!call || !isTerminalToolName(block.toolName)) continue;
      const command = typeof call.input.command === "string" ? call.input.command : block.toolName;
      const cwd = typeof call.input.cwd === "string" ? call.input.cwd : undefined;
      const exitCode = exitCodeFromToolResult(block);
      const fact = formatCommandFact(command, cwd, exitCode, stringifyToolOutput(block.output));
      if (exitCode === 0 && successful.length < limit) successful.push(fact);
      if (exitCode !== undefined && exitCode !== 0 && failed.length < limit) failed.push(fact);
    }
    if (successful.length >= limit && failed.length >= limit) break;
  }
  return { successful: successful.reverse(), failed: failed.reverse() };
}

function includeRequiredToolCallMessages(messages: AgentMessage[], firstKeptIndex: number): number {
  let index = firstKeptIndex;
  for (;;) {
    const kept = messages.slice(index);
    const resultIds = new Set<string>();
    const callIds = new Set<string>();
    for (const message of kept) {
      for (const block of message.blocks) {
        if (block.type === "tool-result") resultIds.add(block.toolCallId);
        if (block.type === "tool-call") callIds.add(block.id);
      }
    }
    const missing = [...resultIds].some((id) => !callIds.has(id));
    if (!missing || index === 0) return index;
    index -= 1;
  }
}

function includeLatestUserMessage(messages: AgentMessage[], firstKeptIndex: number): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      return Math.min(firstKeptIndex, index);
    }
  }
  return firstKeptIndex;
}

function estimateBlockChars(block: AgentMessageBlock): number {
  if (block.type === "text" || block.type === "thought") return block.text.length;
  if (block.type === "tool-call") return block.toolName.length + JSON.stringify(block.input).length;
  return block.toolName.length + stringifyToolOutput(block.output).length;
}

function textFromBlocks(blocks: AgentMessageBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function thoughtFromBlocks(blocks: AgentMessageBlock[]): string {
  return blocks
    .filter((block) => block.type === "thought")
    .map((block) => block.text)
    .join("");
}

async function resolveContextState(reader: ContextCompressionRuntimeOptions["contextState"]): Promise<ContextStateSnapshot> {
  if (!reader) {
    return {
      completedTaskSummaries: [],
      pendingTasks: [],
      sessionEvents: [],
      fileSnapshotHints: []
    };
  }
  return reader.snapshotForCompression();
}

function providerUsageFromMessage(message: AgentMessage): ProviderUsage | undefined {
  const usage = message.metadata?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const totalTokens = numberField(record.totalTokens);
  if (totalTokens === undefined) return undefined;
  return {
    totalTokens,
    promptTokens: numberField(record.promptTokens),
    completionTokens: numberField(record.completionTokens),
    cacheReadTokens: numberField(record.cacheReadTokens),
    cacheWriteTokens: numberField(record.cacheWriteTokens),
    reasoningTokens: numberField(record.reasoningTokens)
  };
}

function exitCodeFromToolResult(block: ToolResultBlock): number | undefined {
  const json = block.output.json;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    return numberField(record.exitCode) ?? numberField(record.exit_code);
  }
  const match = stringifyToolOutput(block.output).match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function formatCommandFact(command: string, cwd: string | undefined, exitCode: number | undefined, output: string): string {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return [`$ ${command}`, cwd ? `cwd=${cwd}` : undefined, exitCode !== undefined ? `exit=${exitCode}` : undefined, firstLine ? `result=${firstLine}` : undefined]
    .filter(Boolean)
    .join(" | ");
}

function isTerminalToolName(toolName: string): boolean {
  return /(?:shell|terminal|command|run_command)/i.test(toolName);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function compactJson(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}
