import type {
  AgentMessage,
  AgentMessageBlock,
  ToolResultBlock,
} from "@crish/shared-types";

export function textFromBlocks(blocks: AgentMessageBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function collectThoughtBlocks(messages: AgentMessage[]): string[] {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type === "thought" && block.text.trim()) {
        blocks.push(block.text);
      }
    }
  }
  return blocks;
}

export function compactJson(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function exitCodeFromToolResult(block: ToolResultBlock): number | undefined {
  const json = block.output.json;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    return numberField(record.exitCode) ?? numberField(record.exit_code);
  }
  const match = stringifyOutput(block.output).match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function stringifyOutput(output: { text?: string; json?: unknown }): string {
  if (typeof output.text === "string") return output.text;
  return JSON.stringify(output.json ?? "");
}

export function formatCommandFact(command: string, cwd: string | undefined, exitCode: number | undefined, output: string): string {
  const newlineIdx = output.search(/\r?\n/);
  const firstLine = (newlineIdx === -1 ? output : output.slice(0, newlineIdx)).trim();
  return [`$ ${command}`, cwd ? `cwd=${cwd}` : undefined, exitCode !== undefined ? `exit=${exitCode}` : undefined, firstLine ? `result=${firstLine}` : undefined]
    .filter(Boolean)
    .join(" | ");
}

export function isTerminalToolName(toolName: string): boolean {
  return /(?:shell|terminal|command|run_command)/i.test(toolName);
}

export function lastUserMessageText(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = textFromBlocks(message.blocks).trim();
    return text.length > 0 ? text : message.id;
  }
  return undefined;
}

export function lastUserMessageMetadata(messages: AgentMessage[]): { lastUserMessageId?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") return { lastUserMessageId: message.id };
  }
  return {};
}

export function readFilesFromSnapshotHints(hints: string[]): string[] {
  return filePathsFromSnapshotHints(hints, (hint) => !/\b(?:checkpoint|edit|write|mutation|modified|restore)\b/i.test(hint));
}

export function modifiedFilesFromSnapshotHints(hints: string[]): string[] {
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

export function includeLatestUserMessage(messages: AgentMessage[], firstKeptIndex: number): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      return Math.min(firstKeptIndex, index);
    }
  }
  return firstKeptIndex;
}

export async function resolveContextState(reader: { snapshotForCompression?: () => Promise<{
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  previousCompressionSummary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
}> } | undefined): Promise<{
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  previousCompressionSummary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
}> {
  if (!reader?.snapshotForCompression) {
    return {
      completedTaskSummaries: [],
      pendingTasks: [],
      sessionEvents: [],
      fileSnapshotHints: [],
    };
  }
  return reader.snapshotForCompression();
}

export function includeRequiredToolCallMessages(messages: AgentMessage[], firstKeptIndex: number): number {
  const callIndexById = new Map<string, number>();
  const resultIndexById = new Map<string, number>();
  const resultIdsByMessage: string[][] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const resultIds: string[] = [];
    for (const block of messages[i]!.blocks) {
      if (block.type === "tool-call") callIndexById.set(block.id, i);
      if (block.type === "tool-result") {
        resultIds.push(block.toolCallId);
        resultIndexById.set(block.toolCallId, i);
      }
    }
    resultIdsByMessage[i] = resultIds;
  }

  let index = firstKeptIndex;
  while (index > 0) {
    let earliestMissing = index;
    let hasMissing = false;

    // Reverse tracing: tool_result → tool_call
    // If a tool_result is in the kept range but its tool_call is before it,
    // extend kept range backward to include the tool_call.
    for (let i = index; i < messages.length; i++) {
      for (const toolCallId of resultIdsByMessage[i]!) {
        const callIndex = callIndexById.get(toolCallId);
        if (callIndex === undefined) {
          return 0;
        }
        if (callIndex < index) {
          hasMissing = true;
          earliestMissing = Math.min(earliestMissing, callIndex);
        }
      }
    }

    // Forward tracing: tool_call → tool_result
    // If a tool_call is in the kept range but its tool_result is before it
    // (or missing entirely), extend kept range or return 0.
    for (let i = index; i < messages.length; i++) {
      for (const block of messages[i]!.blocks) {
        if (block.type !== "tool-call") continue;
        const resultIndex = resultIndexById.get(block.id);
        if (resultIndex === undefined) {
          return 0;
        }
        if (resultIndex < index) {
          hasMissing = true;
          earliestMissing = Math.min(earliestMissing, resultIndex);
        }
      }
    }

    if (!hasMissing) return index;
    index = earliestMissing;
  }
  return 0;
}
