import { createHash } from "node:crypto";
import type { PromptAssemblyContextBlock } from "./prompt-assembly";
import type { AgentSkill } from "./skills";
import type { JsonObject, JsonValue } from "@crish/shared-types";

export const SCOPED_CONTEXT_VERSION = 1;

export type ScopedContextKind = "rule" | "skill";
export type ScopedContextScope = "global" | "workspace" | "project";
export type ScopedContextActivation = "enabled" | "recommended" | "disabled";
export type ScopedContextItemStatus = "active" | "recommended" | "disabled" | "inapplicable";

export interface ScopedContextSource {
  type: "global-rule" | "project-rule" | "workspace-rule" | "skill-file" | "user" | "system";
  path?: string;
  label?: string;
}

export interface ScopedContextRecord {
  id: string;
  kind: ScopedContextKind;
  title: string;
  content: string;
  description?: string;
  scope: ScopedContextScope;
  activation: ScopedContextActivation;
  appliesTo: string[];
  tags: string[];
  source?: ScopedContextSource;
  order: number;
}

export interface ScopedRuleInput {
  id?: string;
  title?: string;
  text: string;
  description?: string;
  scope?: ScopedContextScope;
  activation?: ScopedContextActivation;
  appliesTo?: string[];
  tags?: string[];
  source?: ScopedContextSource;
  order?: number;
}

export interface ScopedSkillInput {
  skill: AgentSkill;
  id?: string;
  title?: string;
  activation?: ScopedContextActivation;
  scope?: ScopedContextScope;
  appliesTo?: string[];
  tags?: string[];
  source?: ScopedContextSource;
  order?: number;
}

export interface ScopedContextResolverProject {
  cwd: string;
  workspaceRoot?: string;
  projectRoot?: string;
  projectMarkers?: string[];
  projectFiles?: string[];
  projectTags?: string[];
  packageNames?: string[];
}

export interface ScopedContextResolverInput extends ScopedContextResolverProject {
  rules?: ScopedRuleInput[];
  skills?: Array<AgentSkill | ScopedSkillInput>;
  records?: ScopedContextRecord[];
  userEnabledIds?: string[];
  userDisabledIds?: string[];
}

export interface ScopedContextCandidate {
  id: string;
  kind: ScopedContextKind;
  title: string;
  description?: string;
  scope: ScopedContextScope;
  activation: ScopedContextActivation;
  appliesTo: string[];
  tags: string[];
  source?: ScopedContextSource;
  reason: string;
}

export interface ScopedContextResolvedItem extends ScopedContextCandidate {
  status: ScopedContextItemStatus;
}

export interface ScopedContextDiagnostic {
  severity: "info" | "warning";
  id: string;
  code: "disabled" | "scope-mismatch" | "applies-to-mismatch" | "empty-content";
  message: string;
}

export interface ScopedContextResolution {
  version: typeof SCOPED_CONTEXT_VERSION;
  stableContext: PromptAssemblyContextBlock[];
  recommended: ScopedContextCandidate[];
  items: ScopedContextResolvedItem[];
  diagnostics: ScopedContextDiagnostic[];
  stableContextHash: string;
}

export function defineScopedRule(input: ScopedRuleInput): ScopedContextRecord {
  const title = normalizeText(input.title ?? input.text.slice(0, 80), "rule title");
  const content = normalizeText(input.text, "rule text");
  return {
    id: input.id ? normalizeId(input.id) : stableId("rule", `${input.scope ?? "project"}:${title}:${content}`),
    kind: "rule",
    title,
    content,
    description: optionalText(input.description),
    scope: input.scope ?? "project",
    activation: input.activation ?? "enabled",
    appliesTo: normalizeList(input.appliesTo),
    tags: normalizeList(input.tags),
    source: input.source,
    order: input.order ?? 0
  };
}

export function skillToScopedContextRecord(input: AgentSkill | ScopedSkillInput): ScopedContextRecord {
  const wrapped = isScopedSkillInput(input) ? input : { skill: input };
  const skill = wrapped.skill;
  const scope = wrapped.scope ?? skill.scope ?? "global";
  const activation = wrapped.activation ?? skill.activation ?? "recommended";
  const appliesTo = normalizeList(wrapped.appliesTo ?? skill.appliesTo);
  const tags = normalizeList(wrapped.tags ?? skill.tags);
  return {
    id: wrapped.id ? normalizeId(wrapped.id) : stableId("skill", `${skill.name}:${skill.filePath}`),
    kind: "skill",
    title: normalizeText(wrapped.title ?? skill.name, "skill title"),
    content: normalizeText(skill.content, "skill content"),
    description: optionalText(skill.description),
    scope,
    activation,
    appliesTo,
    tags,
    source: wrapped.source ?? {
      type: "skill-file",
      path: skill.filePath,
      label: skill.name
    },
    order: wrapped.order ?? 100
  };
}

export function resolveScopedContext(input: ScopedContextResolverInput): ScopedContextResolution {
  const records = normalizeRecords(input);
  const userEnabledIds = new Set(normalizeIdList(input.userEnabledIds));
  const userDisabledIds = new Set(normalizeIdList(input.userDisabledIds));
  const active: ScopedContextRecord[] = [];
  const recommended: ScopedContextCandidate[] = [];
  const items: ScopedContextResolvedItem[] = [];
  const diagnostics: ScopedContextDiagnostic[] = [];

  for (const record of records) {
    const applicability = recordApplicability(record, input);
    const baseCandidate = candidateFromRecord(record, applicability.reason);
    if (!record.content.trim()) {
      diagnostics.push(diagnostic(record, "empty-content", "warning", "Scoped context item has no content."));
      items.push({ ...baseCandidate, status: "inapplicable" });
      continue;
    }
    if (!applicability.applies) {
      diagnostics.push(diagnostic(record, applicability.code, "info", applicability.reason));
      items.push({ ...baseCandidate, reason: applicability.reason, status: "inapplicable" });
      continue;
    }
    if (userDisabledIds.has(record.id) || record.activation === "disabled") {
      diagnostics.push(diagnostic(record, "disabled", "info", "Scoped context item is disabled."));
      items.push({ ...baseCandidate, reason: "disabled", status: "disabled" });
      continue;
    }
    if (record.activation === "enabled" || userEnabledIds.has(record.id)) {
      active.push(record);
      items.push({ ...baseCandidate, reason: userEnabledIds.has(record.id) ? "enabled-by-user" : "enabled-by-policy", status: "active" });
      continue;
    }

    const candidate = { ...baseCandidate, reason: "recommended-for-project" };
    recommended.push(candidate);
    items.push({ ...candidate, status: "recommended" });
  }

  const stableContext = buildStableContext(active);
  return {
    version: SCOPED_CONTEXT_VERSION,
    stableContext,
    recommended,
    items,
    diagnostics,
    stableContextHash: hashJson({ version: SCOPED_CONTEXT_VERSION, stableContext })
  };
}

function normalizeRecords(input: ScopedContextResolverInput): ScopedContextRecord[] {
  return [
    ...(input.records ?? []),
    ...(input.rules ?? []).map(defineScopedRule),
    ...(input.skills ?? []).map(skillToScopedContextRecord)
  ]
    .map((record, index) => ({ ...record, order: record.order ?? index }))
    .sort((left, right) => left.order - right.order || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function buildStableContext(records: ScopedContextRecord[]): PromptAssemblyContextBlock[] {
  const rules = records.filter((record) => record.kind === "rule");
  const skills = records.filter((record) => record.kind === "skill");
  const blocks: PromptAssemblyContextBlock[] = [];

  if (rules.length > 0) {
    blocks.push({
      id: "scoped-context:rules",
      kind: "custom-stable",
      label: "Scoped Rules",
      content: {
        version: SCOPED_CONTEXT_VERSION,
        rules: rules.map((record) =>
          compactJson({
            id: record.id,
            title: record.title,
            text: record.content,
            scope: record.scope,
            tags: record.tags,
            source: sourceJson(record.source)
          })
        )
      }
    });
  }

  if (skills.length > 0) {
    blocks.push({
      id: "scoped-context:skills",
      kind: "skills-hook",
      label: "Scoped Skills",
      content: {
        version: SCOPED_CONTEXT_VERSION,
        skills: skills.map((record) =>
          compactJson({
            id: record.id,
            name: record.title,
            description: record.description,
            location: record.source?.path,
            content: record.content,
            scope: record.scope,
            tags: record.tags
          })
        )
      }
    });
  }

  return blocks;
}

function recordApplicability(
  record: ScopedContextRecord,
  project: ScopedContextResolverProject
): { applies: true; reason: string; code?: never } | { applies: false; reason: string; code: "scope-mismatch" | "applies-to-mismatch" } {
  if (!scopeMatches(record.scope, record.source?.path, project)) {
    return { applies: false, code: "scope-mismatch", reason: `scope ${record.scope} does not match current project context` };
  }
  if (!appliesToProject(record.appliesTo, project)) {
    return { applies: false, code: "applies-to-mismatch", reason: "appliesTo matchers did not match current project context" };
  }
  return { applies: true, reason: "applies-to-current-project" };
}

function scopeMatches(scope: ScopedContextScope, sourcePath: string | undefined, project: ScopedContextResolverProject): boolean {
  if (scope === "global") {
    return true;
  }
  const cwd = normalizePath(project.cwd);
  const projectRoot = normalizeOptionalPath(project.projectRoot);
  const workspaceRoot = normalizeOptionalPath(project.workspaceRoot);

  if (scope === "workspace") {
    return workspaceRoot ? isInsidePath(cwd, workspaceRoot) : true;
  }

  if (projectRoot) {
    return isInsidePath(cwd, projectRoot);
  }
  if (sourcePath) {
    const sourceDir = parentPath(normalizePath(sourcePath));
    return sourceDir ? isInsidePath(cwd, sourceDir) || isInsidePath(sourceDir, cwd) : true;
  }
  return true;
}

function appliesToProject(matchers: string[], project: ScopedContextResolverProject): boolean {
  if (matchers.length === 0) {
    return true;
  }
  return matchers.some((matcher) => matcherMatchesProject(matcher, project));
}

function matcherMatchesProject(matcher: string, project: ScopedContextResolverProject): boolean {
  const normalized = matcher.trim().toLowerCase();
  if (!normalized || normalized === "*") {
    return true;
  }
  if (normalized.startsWith("tag:")) {
    return normalizeList(project.projectTags).includes(normalized.slice(4).trim());
  }
  if (normalized.startsWith("file:")) {
    const file = normalized.slice(5).trim();
    return normalizeList([...(project.projectFiles ?? []), ...(project.projectMarkers ?? [])]).some((item) => normalizePath(item).endsWith(file));
  }
  if (normalized.startsWith("path:")) {
    return projectPaths(project).some((item) => item.includes(normalized.slice(5).trim()));
  }
  if (normalized.startsWith("package:")) {
    return normalizeList(project.packageNames).includes(normalized.slice(8).trim());
  }

  const searchable = [
    ...projectPaths(project),
    ...normalizeList(project.projectTags),
    ...normalizeList(project.packageNames),
    ...normalizeList(project.projectMarkers).map(normalizePath),
    ...normalizeList(project.projectFiles).map(normalizePath)
  ];
  return searchable.some((item) => item.includes(normalized));
}

function candidateFromRecord(record: ScopedContextRecord, reason: string): ScopedContextCandidate {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    description: record.description,
    scope: record.scope,
    activation: record.activation,
    appliesTo: record.appliesTo,
    tags: record.tags,
    source: record.source,
    reason
  };
}

function diagnostic(
  record: ScopedContextRecord,
  code: ScopedContextDiagnostic["code"],
  severity: ScopedContextDiagnostic["severity"],
  message: string
): ScopedContextDiagnostic {
  return { severity, id: record.id, code, message };
}

function isScopedSkillInput(value: AgentSkill | ScopedSkillInput): value is ScopedSkillInput {
  return typeof (value as ScopedSkillInput).skill === "object";
}

function sourceJson(source: ScopedContextSource | undefined): JsonObject | undefined {
  if (!source) return undefined;
  return compactJson({
    type: source.type,
    path: source.path,
    label: source.label
  });
}

function projectPaths(project: ScopedContextResolverProject): string[] {
  return normalizeList([project.cwd, project.workspaceRoot, project.projectRoot]).map(normalizePath);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "").toLowerCase();
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  return value ? normalizePath(value) : undefined;
}

function isInsidePath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : undefined;
}

function normalizeId(value: string): string {
  return normalizeText(value, "id");
}

function normalizeText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeList(values: Array<string | undefined> | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))];
}

function normalizeIdList(values: Array<string | undefined> | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${hashText(value).slice(0, 12)}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(canonicalValue(value)));
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

function compactJson(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}
