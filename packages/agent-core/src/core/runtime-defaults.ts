import { resolve } from "node:path";
import type { ToolOutputBudgetRuntimeOptions } from '@crish/shared-types';
import type { AgentRuntimeOptions, ContextStateReader, ContextSummaryRequest, ContextSummarizer, ToolExecutionRuntimeOptions } from './runtime-options';

export interface ProductRuntimeDefaultsOptions {
  cwd: string;
  contextWindowTokens?: number;
  thresholdTokens?: number;
  preferredWorkingTokens?: number;
  contextState?: ContextStateReader;
  artifactDir?: string;
}

export const DEFAULT_PRODUCT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_PRODUCT_AUTO_COMPACT_AT_TOKENS = 180_000;
export const DEFAULT_PRODUCT_PREFERRED_WORKING_TOKENS = 200_000;
export const DEFAULT_PRODUCT_TOOL_EXECUTION_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_TOOL_OUTPUT_BUDGET: Required<Pick<ToolOutputBudgetRuntimeOptions, "inlineChars" | "headRatio" | "artifactChars">> = {
  inlineChars: 8_000,
  headRatio: 0.55,
  artifactChars: 200_000
};

const DEFAULT_TOOL_EXECUTION: Readonly<Required<ToolExecutionRuntimeOptions>> = {
  timeoutMs: DEFAULT_PRODUCT_TOOL_EXECUTION_TIMEOUT_MS,
  parallelFailurePolicy: "continue-drain"
};

export function createProductRuntimeDefaults(
  options: ProductRuntimeDefaultsOptions
): Pick<AgentRuntimeOptions, "contextCompression" | "toolOutputBudget" | "recovery" | "toolExecution"> {
  const cwd = resolve(options.cwd);
  const contextWindowTokens = positiveInteger(options.contextWindowTokens, DEFAULT_PRODUCT_CONTEXT_WINDOW_TOKENS);
  const preferredWorkingTokens = positiveInteger(options.preferredWorkingTokens, DEFAULT_PRODUCT_PREFERRED_WORKING_TOKENS);
  const artifactDir = options.artifactDir ?? resolve(cwd, ".codex", "agent-artifacts");
  const toolOutputBudget: ToolOutputBudgetRuntimeOptions = {
    ...DEFAULT_TOOL_OUTPUT_BUDGET,
    artifactDir
  };

  return {
    contextCompression: {
      enabled: true,
      contextWindowTokens,
      thresholdTokens: positiveInteger(options.thresholdTokens, DEFAULT_PRODUCT_AUTO_COMPACT_AT_TOKENS),
      targetRecentTokens: Math.min(64_000, Math.floor(preferredWorkingTokens * 0.35)),
      minRecentMessages: 8,
      maxSummaryTokens: 8_000,
      summarizer: new ExtractiveContextSummarizer(),
      ...(options.contextState ? { contextState: options.contextState } : {}),
      toolOutputBudget
    },
    toolOutputBudget,
    recovery: {
      enabled: true,
      maxConsecutiveToolErrors: 2,
      maxRepeatedToolCalls: 3,
      maxSteeringMessages: 1
    },
    toolExecution: { ...DEFAULT_TOOL_EXECUTION }
  };
}

export class ExtractiveContextSummarizer implements ContextSummarizer {
  async summarize(request: ContextSummaryRequest): Promise<string> {
    const parts = [
      "Context checkpoint",
      "",
      "Completed:",
      ...listOrFallback(request.completedTaskSummaries.slice(-12), "- None recorded"),
      "",
      "Pending:",
      ...listOrFallback(request.pendingTasks.slice(-12), "- None recorded"),
      "",
      "Recent events:",
      ...listOrFallback(request.sessionEvents.slice(-16), "- None recorded"),
      "",
      "Key files:",
      ...listOrFallback(request.fileSnapshotHints.slice(-12), "- None recorded"),
      "",
      "Successful commands:",
      ...listOrFallback(request.recentSuccessfulCommands.slice(-8), "- None recorded"),
      "",
      "Failed diagnostics:",
      ...listOrFallback(request.recentFailedDiagnostics.slice(-8), "- None recorded"),
      "",
      "Previous context:",
      trimForSummary(request.previousSummary ?? request.serializedConversation, 12_000)
    ];
    return trimForSummary(parts.join("\n"), Math.max(4_000, request.maxSummaryTokens * 4));
  }
}

function listOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}

function trimForSummary(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  const headChars = Math.floor(maxChars * 0.58);
  const tailChars = maxChars - headChars;
  return `${normalized.slice(0, headChars)}\n\n[Middle omitted: ${normalized.length - maxChars} chars]\n\n${normalized.slice(-tailChars)}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
