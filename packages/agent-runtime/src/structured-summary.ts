import { createHash } from "node:crypto";
import { isRecord } from "@crish/shared-utils";

export const STRUCTURED_SUMMARY_VERSION = 1;

export type StructuredSummaryKind =
  | "context-compression"
  | "branch-summary"
  | "subagent-task"
  | "plan-handoff"
  | "requirements-alignment"
  | "generic";

export interface StructuredSummaryInput {
  kind?: StructuredSummaryKind;
  goal?: string;
  constraints?: string[];
  progress?: string[];
  decisions?: string[];
  nextSteps?: string[];
  criticalContext?: string[];
  readFiles?: string[];
  modifiedFiles?: string[];
  pendingQuestions?: string[];
  risks?: string[];
  sourceIds?: string[];
}

export interface StructuredSummary extends Required<Omit<StructuredSummaryInput, "kind" | "goal">> {
  version: typeof STRUCTURED_SUMMARY_VERSION;
  kind: StructuredSummaryKind;
  goal: string;
  stableHash: string;
}

const EMPTY_GOAL = "Continue from the summarized context.";

export function createStructuredSummary(input: StructuredSummaryInput = {}): StructuredSummary {
  const withoutHash: Omit<StructuredSummary, "stableHash"> = {
    version: STRUCTURED_SUMMARY_VERSION,
    kind: input.kind ?? "generic",
    goal: normalizeText(input.goal) ?? EMPTY_GOAL,
    constraints: normalizeLines(input.constraints),
    progress: normalizeLines(input.progress),
    decisions: normalizeLines(input.decisions),
    nextSteps: normalizeLines(input.nextSteps),
    criticalContext: normalizeLines(input.criticalContext),
    readFiles: normalizePaths(input.readFiles),
    modifiedFiles: normalizePaths(input.modifiedFiles),
    pendingQuestions: normalizeLines(input.pendingQuestions),
    risks: normalizeLines(input.risks),
    sourceIds: normalizeLines(input.sourceIds)
  };

  return {
    ...withoutHash,
    stableHash: hashSummary(withoutHash)
  };
}

export function mergeStructuredSummaries(
  base: StructuredSummaryInput | undefined,
  update: StructuredSummaryInput
): StructuredSummary {
  const left = createStructuredSummary(base);
  const right = createStructuredSummary(update);
  return createStructuredSummary({
    kind: update.kind ?? base?.kind ?? left.kind,
    goal: update.goal ?? base?.goal ?? left.goal,
    constraints: [...left.constraints, ...right.constraints],
    progress: [...left.progress, ...right.progress],
    decisions: [...left.decisions, ...right.decisions],
    nextSteps: [...left.nextSteps, ...right.nextSteps],
    criticalContext: [...left.criticalContext, ...right.criticalContext],
    readFiles: [...left.readFiles, ...right.readFiles],
    modifiedFiles: [...left.modifiedFiles, ...right.modifiedFiles],
    pendingQuestions: [...left.pendingQuestions, ...right.pendingQuestions],
    risks: [...left.risks, ...right.risks],
    sourceIds: [...left.sourceIds, ...right.sourceIds]
  });
}

export function structuredSummaryToJson(summary: StructuredSummaryInput): string {
  return JSON.stringify(createStructuredSummary(summary));
}

export function parseStructuredSummaryJson(value: string): StructuredSummary {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("structured summary must be a JSON object");
  }
  const kind = parseKind(parsed.kind);
  const goal = stringValue(parsed.goal);
  const constraints = stringArray(parsed.constraints);
  const progress = stringArray(parsed.progress);
  const decisions = stringArray(parsed.decisions);
  const nextSteps = stringArray(parsed.nextSteps);
  const criticalContext = stringArray(parsed.criticalContext);
  const readFiles = stringArray(parsed.readFiles);
  const modifiedFiles = stringArray(parsed.modifiedFiles);
  const pendingQuestions = stringArray(parsed.pendingQuestions);
  const risks = stringArray(parsed.risks);
  const sourceIds = stringArray(parsed.sourceIds);
  return createStructuredSummary({
    ...(kind !== undefined ? { kind } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
    ...(nextSteps !== undefined ? { nextSteps } : {}),
    ...(criticalContext !== undefined ? { criticalContext } : {}),
    ...(readFiles !== undefined ? { readFiles } : {}),
    ...(modifiedFiles !== undefined ? { modifiedFiles } : {}),
    ...(pendingQuestions !== undefined ? { pendingQuestions } : {}),
    ...(risks !== undefined ? { risks } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {})
  });
}

export function renderStructuredSummary(summary: StructuredSummaryInput): string {
  const normalized = createStructuredSummary(summary);
  return [
    `<structured_summary version="${normalized.version}" kind="${normalized.kind}" stableHash="${normalized.stableHash}">`,
    section("Goal", normalized.goal),
    listSection("Constraints", normalized.constraints),
    listSection("Progress", normalized.progress),
    listSection("Decisions", normalized.decisions),
    listSection("Next Steps", normalized.nextSteps),
    listSection("Critical Context", normalized.criticalContext),
    listSection("Read Files", normalized.readFiles),
    listSection("Modified Files", normalized.modifiedFiles),
    listSection("Pending Questions", normalized.pendingQuestions),
    listSection("Risks", normalized.risks),
    listSection("Source IDs", normalized.sourceIds),
    "</structured_summary>"
  ]
    .filter(Boolean)
    .join("\n");
}

export function structuredSummaryCacheKey(summary: StructuredSummaryInput): string {
  return `structured-summary:v${STRUCTURED_SUMMARY_VERSION}:${createStructuredSummary(summary).stableHash}`;
}

function section(title: string, body: string): string {
  return [`## ${title}`, body].join("\n");
}

function listSection(title: string, values: string[]): string {
  return section(title, values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None");
}

function normalizeLines(values: string[] | undefined): string[] {
  return unique((values ?? []).map((value) => normalizeText(value)).filter((value): value is string => Boolean(value)));
}

function normalizePaths(values: string[] | undefined): string[] {
  return normalizeLines(values).map((value) => value.replace(/\\/g, "/")).sort();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized ? normalized : undefined;
}

function hashSummary(value: Omit<StructuredSummary, "stableHash">): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}

function parseKind(value: unknown): StructuredSummaryKind | undefined {
  return value === "context-compression" ||
    value === "branch-summary" ||
    value === "subagent-task" ||
    value === "plan-handoff" ||
    value === "requirements-alignment" ||
    value === "generic"
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}


