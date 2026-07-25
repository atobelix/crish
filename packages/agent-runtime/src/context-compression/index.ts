import { createStructuredSummary } from "../structured-summary";
import { stringifyToolOutput } from "../tool-output-budget";
import type {
  AgentMessage,
  ContextCompressionHandoffMetadata,
  ContextCompressionPolicyMetadata,
  ContextCompressionReason,
  ContextCompressionRecord,
  ContextCompressionTrigger,
  JsonObject,
  ToolCallBlock,
} from "@crish/shared-types";
import type { ContextCompressionRuntimeOptions, ContextStateSnapshot } from "../types";
import { createId, nowIso } from "../session";
import { estimateContextTokens, estimateMessageTokens, applyTokenEstimateSafetyFactor } from "./token-estimator";
import { buildFileOpsXml, createCompressionSummaryMessage, createCompressionCacheBoundary, serializeMessagesForSummary } from "./serializer";
import {
  compactJson,
  collectThoughtBlocks,
  exitCodeFromToolResult,
  formatCommandFact,
  isTerminalToolName,
  lastUserMessageText,
  lastUserMessageMetadata,
  readFilesFromSnapshotHints,
  modifiedFilesFromSnapshotHints,
  includeLatestUserMessage,
  resolveContextState,
  includeRequiredToolCallMessages,
} from "./compression-utils";

export interface CompressionHistoryEntry {
  timestamp: string;
  tokensBefore: number;
  tokensAfter: number;
  compressedMessageIds: string[];
}

export interface ContextCompressionResult {
  record: ContextCompressionRecord;
  summaryMessage: AgentMessage;
  messages: AgentMessage[];
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

    const state = await resolveContextState(
      this.options.contextState !== undefined
        ? { snapshotForCompression: () => this.options.contextState!.snapshotForCompression() as Promise<{ completedTaskSummaries: string[]; pendingTasks: string[]; sessionEvents: string[]; fileSnapshotHints: string[]; previousCompressionSummary?: string; readFiles?: string[]; modifiedFiles?: string[] }> }
        : undefined
    );
    const commandFacts = extractRecentTerminalCommandFacts(messages);

    let thoughtSummary: string | undefined;
    const thoughtSummarizer = (this.options as { thoughtSummarizer?: { summarize(input: Record<string, unknown>): Promise<string> } }).thoughtSummarizer;
    if (thoughtSummarizer && compressed.length > 0) {
      const thoughtBlocks = collectThoughtBlocks(compressed);
      if (thoughtBlocks.length > 0) {
        try {
          thoughtSummary = await thoughtSummarizer.summarize({
            trigger,
            reason: decision.reason,
            policy: decision.policy,
            handoffIntent: decision.handoffIntent,
            serializedConversation: thoughtBlocks.join("\n\n"),
            recentSuccessfulCommands: commandFacts.successful,
            recentFailedDiagnostics: commandFacts.failed,
            completedTaskSummaries: state.completedTaskSummaries,
            pendingTasks: state.pendingTasks,
            sessionEvents: state.sessionEvents,
            fileSnapshotHints: state.fileSnapshotHints,
            maxSummaryTokens: this.options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          console.warn(`[context-compression] thoughtSummarizer failed, continuing without thought summary: ${message}`);
        }
      }
    }

    const serializedConversation = serializeMessagesForSummary(compressed, {
      toolOutputBudget: this.options.toolOutputBudget ?? { inlineChars: 4_000 },
      includeThought: this.options.includeThought ?? false,
      ...(thoughtSummary !== undefined ? { thoughtSummary } : {})
    });

    let summary: string;
    try {
      summary = await this.options.summarizer.summarize({
        trigger,
        reason: decision.reason,
        policy: decision.policy,
        handoffIntent: decision.handoffIntent,
        serializedConversation,
        ...(state.previousCompressionSummary !== undefined ? { previousSummary: state.previousCompressionSummary } : {}),
        recentSuccessfulCommands: commandFacts.successful,
        recentFailedDiagnostics: commandFacts.failed,
        completedTaskSummaries: state.completedTaskSummaries,
        pendingTasks: state.pendingTasks,
        sessionEvents: state.sessionEvents,
        fileSnapshotHints: state.fileSnapshotHints,
        maxSummaryTokens: this.options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[context-compression] summarizer failed, skip compression this turn: ${message}`);
      return null;
    }
    const tokensAfter = estimateContextTokens([createCompressionSummaryMessage(summary), ...kept]).tokens;
    const userGoalText = lastUserMessageText(messages);
    const structuredSummary = await createStructuredSummary({
      kind: "context-compression",
      ...(userGoalText !== undefined ? { goal: userGoalText } : {}),
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
    const cacheBoundary = await createCompressionCacheBoundary({
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
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(decision.policy !== undefined ? { policy: decision.policy } : {}),
      summary,
      ...(kept[0]?.id !== undefined ? { firstKeptMessageId: kept[0].id } : {}),
      compressedMessageIds: compressed.map((message) => message.id),
      keptMessageIds: kept.map((message) => message.id),
      tokensBefore,
      tokensAfter,
      ...(decision.thresholdTokens !== undefined ? { thresholdTokens: decision.thresholdTokens } : {}),
      createdAt: nowIso(),
      ...(handoff !== undefined ? { handoff } : {}),
      ...(cacheBoundary !== undefined ? { cacheBoundary } : {}),
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
      }) as JsonObject
    };

    await this.options.contextState?.recordCompression?.(record);
    const fileOpsXml = buildFileOpsXml(state.readFiles, state.modifiedFiles);
    const summaryMessage = createCompressionSummaryMessage(summary, record, fileOpsXml);

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

function createCompressionDecision(
  trigger: ContextCompressionTrigger,
  tokensBefore: number,
  thresholdTokens: number,
  hasEnoughMessages: boolean
): ContextCompressionDecision {
  const reason = reasonForTrigger(trigger);
  const tokensForThreshold = applyTokenEstimateSafetyFactor(tokensBefore);
  const thresholdExceeded = tokensForThreshold >= thresholdTokens;
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

export function findFirstKeptMessageIndex(messages: AgentMessage[], targetRecentTokens: number, minRecentMessages = 4): number {
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
  firstKeptIndex = safeCompactionCutoff(messages, firstKeptIndex);
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
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi]!;
    if (message.role !== "tool") continue;
    const blocks = message.blocks;
    for (let bi = blocks.length - 1; bi >= 0; bi--) {
      const block = blocks[bi]!;
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

export function safeCompactionCutoff(messages: AgentMessage[], initialCutoff: number): number {
  return includeRequiredToolCallMessages(messages, initialCutoff);
}
