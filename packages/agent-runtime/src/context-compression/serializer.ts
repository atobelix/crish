import { budgetTextForContext, stringifyToolOutput, type ToolOutputBudgetOptions } from "../tool-output-budget";
import { createStructuredSummary, structuredSummaryCacheKey } from "../structured-summary";
import type {
  AgentMessage,
  AgentMessageBlock,
  ContextCompressionCacheBoundaryMetadata,
  ContextCompressionRecord,
  ContextCompressionReason,
  JsonObject,
  TextBlock
} from "@crish/shared-types";
import { createId, nowIso } from "../session";

export interface SerializeContextOptions {
  toolOutputBudget?: ToolOutputBudgetOptions;
  includeThought?: boolean;
  thoughtSummary?: string;
}

export function buildFileOpsXml(readFiles: string[] | undefined, modifiedFiles: string[] | undefined): string | undefined {
  const reads = readFiles?.filter(Boolean);
  const edits = modifiedFiles?.filter(Boolean);
  if ((!reads || reads.length === 0) && (!edits || edits.length === 0)) return undefined;

  const parts: string[] = [];
  if (reads && reads.length > 0) {
    parts.push(`    <read_files>\n${reads.map((p) => `      <file>${escapeXml(p)}</file>`).join("\n")}\n    </read_files>`);
  }
  if (edits && edits.length > 0) {
    parts.push(`    <modified_files>\n${edits.map((p) => `      <file>${escapeXml(p)}</file>`).join("\n")}\n    </modified_files>`);
  }
  return `<file_operations>\n${parts.join("\n")}\n</file_operations>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
      let text = "";
      let thought = "";
      const toolCalls: string[] = [];
      for (const block of message.blocks) {
        if (block.type === "text") text += block.text;
        else if (block.type === "thought") { if (options.includeThought === true) thought += block.text; }
        else if (block.type === "tool-call") toolCalls.push(`${block.toolName}(${JSON.stringify(block.input)})`);
      }
      if (thought.trim()) {
        if (options.thoughtSummary) {
          parts.push(`[Assistant thought summary]: ${options.thoughtSummary}`);
        } else {
          parts.push(`[Assistant thought]: ${thought}`);
        }
      }
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

export function createCompressionSummaryMessage(summary: string, record?: ContextCompressionRecord, fileOpsXml?: string): AgentMessage {
  const text = fileOpsXml
    ? `${fileOpsXml}\n\n<context_checkpoint>\n${summary.trim()}\n</context_checkpoint>`
    : `<context_checkpoint>\n${summary.trim()}\n</context_checkpoint>`;
  return {
    id: record?.id ?? createId("context"),
    role: "user",
    createdAt: record?.createdAt ?? nowIso(),
    blocks: [
      {
        type: "text",
        text
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

export async function createCompressionCacheBoundary(input: {
  reason: ContextCompressionReason;
  structuredSummary: Awaited<ReturnType<typeof createStructuredSummary>>;
  compressed: AgentMessage[];
  kept: AgentMessage[];
}): Promise<ContextCompressionCacheBoundaryMetadata> {
  const structuredSummary = input.structuredSummary;
  const stablePrefixHash = structuredSummary.stableHash;
  const compressedMessageIds = input.compressed.map((message) => message.id);
  const keptMessageIds = input.kept.map((message) => message.id);
  return compactJson({
    kind: "context-compression-cache-boundary",
    version: 1,
    stablePrefixHash,
    cacheKey: `context-compression:v1:${stablePrefixHash}`,
    structuredSummaryCacheKey: await structuredSummaryCacheKey(structuredSummary),
    structuredSummaryStableHash: structuredSummary.stableHash,
    invalidates: ["prompt-stable-prefix", "message-history", "usage-baseline", "volatile-context"],
    invalidationReason: input.reason,
    compressedMessageIds,
    keptMessageIds,
    firstKeptMessageId: input.kept[0]?.id
  }) as unknown as ContextCompressionCacheBoundaryMetadata;
}

function textFromBlocks(blocks: AgentMessageBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function compactJson(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}
