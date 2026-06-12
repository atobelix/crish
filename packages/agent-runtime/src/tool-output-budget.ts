import type { JsonObject, JsonValue, ToolOutput } from "@crish/shared-types";

export interface ToolOutputBudgetOptions {
  inlineChars?: number;
  headRatio?: number;
}

export interface BudgetedText {
  text: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
}

const DEFAULT_INLINE_CHARS = 24_000;
const DEFAULT_HEAD_RATIO = 0.4;

export function budgetTextForContext(text: string, options: ToolOutputBudgetOptions = {}): BudgetedText {
  const inlineChars = Math.max(1, options.inlineChars ?? DEFAULT_INLINE_CHARS);
  if (text.length <= inlineChars) {
    return {
      text,
      truncated: false,
      originalChars: text.length,
      omittedChars: 0
    };
  }

  const headChars = Math.max(1, Math.floor(inlineChars * clampRatio(options.headRatio ?? DEFAULT_HEAD_RATIO)));
  const tailChars = inlineChars - headChars;
  const omittedChars = Math.max(0, text.length - headChars - tailChars);
  const marker = `\n\n[... ${omittedChars.toLocaleString("en-US")} characters omitted from ${text.length.toLocaleString("en-US")} total ...]\n\n`;

  return {
    text: `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`,
    truncated: true,
    originalChars: text.length,
    omittedChars
  };
}

export function budgetToolOutputForContext(
  output: ToolOutput,
  options: ToolOutputBudgetOptions & { toolName?: string } = {}
): ToolOutput {
  const rawText = stringifyToolOutput(output);
  const budgeted = budgetTextForContext(rawText, options);
  if (!budgeted.truncated) return output;
  const contextBudget = compactJson({
    toolName: options.toolName,
    truncated: true,
    originalChars: budgeted.originalChars,
    omittedChars: budgeted.omittedChars
  });

  return {
    text: budgeted.text,
    artifacts: output.artifacts,
    json: { contextBudget }
  };
}

export function stringifyToolOutput(output: ToolOutput): string {
  if (typeof output.text === "string") return output.text;
  if (output.json !== undefined) return JSON.stringify(output.json, null, 2);
  if (output.artifacts?.length) {
    return output.artifacts.map((artifact) => artifact.text ?? artifact.uri ?? artifact.title).join("\n");
  }
  return "";
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HEAD_RATIO;
  return Math.min(0.8, Math.max(0.2, value));
}

function compactJson(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
