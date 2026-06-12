import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { decodeTextBuffer } from "./encoding";
import {
  defineScopedRule,
  resolveScopedContext,
  skillToScopedContextRecord,
  type ScopedContextActivation,
  type ScopedContextRecord,
  type ScopedContextResolution,
  type ScopedContextResolverProject,
  type ScopedContextScope,
  type ScopedRuleInput
} from "./scoped-context";
import { loadSkillsFromDirectory, type AgentSkill, type SkillDiagnostic } from "./skills";
import { errorMessage } from "@crish/shared-utils";

export const SCOPED_CONTEXT_RESOURCE_VERSION = 1;

export interface ScopedContextResourcePathSet {
  files?: string[];
  dirs?: string[];
}

export interface ScopedSkillDirectory {
  dir: string;
  scope?: ScopedContextScope;
  activation?: ScopedContextActivation;
  appliesTo?: string[];
  tags?: string[];
}

export interface LoadScopedContextResourcesOptions extends ScopedContextResolverProject {
  includeAncestorContextFiles?: boolean;
  contextFileNames?: string[];
  maxRuleBytes?: number;
  globalRules?: ScopedContextResourcePathSet;
  workspaceRules?: ScopedContextResourcePathSet;
  projectRules?: ScopedContextResourcePathSet;
  globalSkillDirs?: Array<string | ScopedSkillDirectory>;
  workspaceSkillDirs?: Array<string | ScopedSkillDirectory>;
  projectSkillDirs?: Array<string | ScopedSkillDirectory>;
}

export interface LoadAndResolveScopedContextResourcesOptions extends LoadScopedContextResourcesOptions {
  userEnabledIds?: string[];
  userDisabledIds?: string[];
}

export interface ScopedContextResourceDiagnostic {
  severity: "warning";
  path: string;
  message: string;
}

export interface ScopedContextResourcesResult {
  version: typeof SCOPED_CONTEXT_RESOURCE_VERSION;
  records: ScopedContextRecord[];
  skills: AgentSkill[];
  diagnostics: ScopedContextResourceDiagnostic[];
  project: ScopedContextResolverProject;
}

export interface ScopedContextResourcesResolutionResult extends ScopedContextResourcesResult {
  resolution: ScopedContextResolution;
}

interface ParsedFrontmatter {
  data: Record<string, string | boolean>;
  body: string;
}

const DEFAULT_CONTEXT_FILE_NAMES = ["AGENTS.md", "CONEX.md", "PROJECT_RULES.md"];
const DEFAULT_MAX_RULE_BYTES = 256 * 1024;

export async function loadScopedContextResources(options: LoadScopedContextResourcesOptions): Promise<ScopedContextResourcesResult> {
  const cwd = resolve(options.cwd);
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : undefined;
  const workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
  const project: ScopedContextResolverProject = {
    cwd,
    workspaceRoot,
    projectRoot,
    projectMarkers: [...(options.projectMarkers ?? [])],
    projectFiles: [...(options.projectFiles ?? [])],
    projectTags: [...(options.projectTags ?? [])],
    packageNames: [...(options.packageNames ?? [])]
  };
  const diagnostics: ScopedContextResourceDiagnostic[] = [];
  const ruleRecords: ScopedContextRecord[] = [];
  const skills: AgentSkill[] = [];
  const skillRecords: ScopedContextRecord[] = [];
  const seenRuleFiles = new Set<string>();

  const addRuleFile = async (filePath: string, scope: ScopedContextScope, sourceLabel: string, order: number): Promise<void> => {
    const normalized = resolve(filePath);
    if (seenRuleFiles.has(normalized)) {
      return;
    }
    seenRuleFiles.add(normalized);
    const rule = await readScopedRuleFile(normalized, scope, sourceLabel, order, options.maxRuleBytes ?? DEFAULT_MAX_RULE_BYTES);
    if (rule.diagnostic) {
      diagnostics.push(rule.diagnostic);
    }
    if (rule.record) {
      ruleRecords.push(rule.record);
      project.projectFiles?.push(normalized);
      project.projectMarkers?.push(basename(normalized));
    }
  };

  let order = 0;
  if (options.includeAncestorContextFiles ?? true) {
    for (const filePath of await discoverAncestorContextFiles(cwd, projectRoot ?? workspaceRoot, options.contextFileNames ?? DEFAULT_CONTEXT_FILE_NAMES)) {
      await addRuleFile(filePath, "project", "ancestor-context", order++);
    }
  }

  for (const filePath of options.globalRules?.files ?? []) {
    await addRuleFile(filePath, "global", "global-rule", order++);
  }
  for (const filePath of options.workspaceRules?.files ?? []) {
    await addRuleFile(filePath, "workspace", "workspace-rule", order++);
  }
  for (const filePath of options.projectRules?.files ?? []) {
    await addRuleFile(filePath, "project", "project-rule", order++);
  }
  for (const dir of options.globalRules?.dirs ?? []) {
    for (const filePath of await listMarkdownFiles(dir, diagnostics)) {
      await addRuleFile(filePath, "global", "global-rule-dir", order++);
    }
  }
  for (const dir of options.workspaceRules?.dirs ?? []) {
    for (const filePath of await listMarkdownFiles(dir, diagnostics)) {
      await addRuleFile(filePath, "workspace", "workspace-rule-dir", order++);
    }
  }
  for (const dir of options.projectRules?.dirs ?? []) {
    for (const filePath of await listMarkdownFiles(dir, diagnostics)) {
      await addRuleFile(filePath, "project", "project-rule-dir", order++);
    }
  }

  const addSkills = async (inputs: Array<string | ScopedSkillDirectory> | undefined, fallbackScope: ScopedContextScope): Promise<void> => {
    for (const input of inputs ?? []) {
      const directory = normalizeSkillDirectory(input, fallbackScope);
      const loaded = await loadSkillsFromDirectory(directory.dir);
      diagnostics.push(...loaded.diagnostics.map(skillDiagnosticToResourceDiagnostic));
      for (const skill of loaded.skills) {
        skills.push(skill);
        skillRecords.push(
          skillToScopedContextRecord({
            skill,
            scope: directory.scope,
            activation: directory.activation,
            appliesTo: directory.appliesTo,
            tags: directory.tags,
            order: order++
          })
        );
      }
    }
  };

  await addSkills(options.globalSkillDirs, "global");
  await addSkills(options.workspaceSkillDirs, "workspace");
  await addSkills(options.projectSkillDirs, "project");

  return {
    version: SCOPED_CONTEXT_RESOURCE_VERSION,
    records: [...ruleRecords, ...skillRecords],
    skills,
    diagnostics,
    project
  };
}

export async function loadAndResolveScopedContextResources(
  options: LoadAndResolveScopedContextResourcesOptions
): Promise<ScopedContextResourcesResolutionResult> {
  const loaded = await loadScopedContextResources(options);
  return {
    ...loaded,
    resolution: resolveScopedContext({
      ...loaded.project,
      records: loaded.records,
      userEnabledIds: options.userEnabledIds,
      userDisabledIds: options.userDisabledIds
    })
  };
}

async function readScopedRuleFile(
  filePath: string,
  fallbackScope: ScopedContextScope,
  sourceLabel: string,
  order: number,
  maxRuleBytes: number
): Promise<{ record?: ScopedContextRecord; diagnostic?: ScopedContextResourceDiagnostic }> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return { diagnostic: warning(filePath, "Scoped rule path is not a file.") };
    }
    if (fileStat.size > maxRuleBytes) {
      return { diagnostic: warning(filePath, `Scoped rule file exceeds ${maxRuleBytes} bytes.`) };
    }
    const decoded = decodeTextBuffer(await readFile(filePath));
    if (decoded.encoding === "binary") {
      return { diagnostic: warning(filePath, "Scoped rule file is binary.") };
    }
    const parsed = parseFrontmatter(decoded.text);
    const title = stringField(parsed.data.title) ?? stringField(parsed.data.name) ?? basename(filePath).replace(/\.md$/i, "");
    const ruleInput: ScopedRuleInput = {
      id: stringField(parsed.data.id) ?? stableRuleId(sourceLabel, filePath),
      title,
      text: parsed.body.trim(),
      description: stringField(parsed.data.description),
      scope: scopeField(parsed.data.scope) ?? fallbackScope,
      activation: activationField(parsed.data.activation) ?? "enabled",
      appliesTo: stringList(parsed.data["applies-to"] ?? parsed.data.appliesTo),
      tags: stringList(parsed.data.tags),
      source: {
        type: fallbackScope === "global" ? "global-rule" : fallbackScope === "workspace" ? "workspace-rule" : "project-rule",
        path: filePath,
        label: sourceLabel
      },
      order
    };
    return { record: defineScopedRule(ruleInput) };
  } catch (error) {
    return { diagnostic: warning(filePath, `Failed to read scoped rule file: ${errorMessage(error)}`) };
  }
}

async function discoverAncestorContextFiles(cwd: string, stopRoot: string | undefined, names: string[]): Promise<string[]> {
  const result: string[] = [];
  let current = resolve(cwd);
  const root = resolve(current, "/");
  const stop = stopRoot ? resolve(stopRoot) : undefined;

  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      try {
        if ((await stat(candidate)).isFile()) {
          result.unshift(candidate);
        }
      } catch { /* not a file, skip */ }
    }
    if (stop && samePath(current, stop)) {
      break;
    }
    if (samePath(current, root)) {
      break;
    }
    const parent = dirname(current);
    if (samePath(parent, current)) {
      break;
    }
    current = parent;
  }

  return uniquePaths(result);
}

async function listMarkdownFiles(dir: string, diagnostics: ScopedContextResourceDiagnostic[]): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    diagnostics.push(warning(dir, `Failed to list scoped rule directory: ${errorMessage(error)}`));
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeSkillDirectory(input: string | ScopedSkillDirectory, fallbackScope: ScopedContextScope): Required<ScopedSkillDirectory> {
  if (typeof input === "string") {
    return { dir: input, scope: fallbackScope, activation: "recommended", appliesTo: [], tags: [] };
  }
  return {
    dir: input.dir,
    scope: input.scope ?? fallbackScope,
    activation: input.activation ?? "recommended",
    appliesTo: input.appliesTo ?? [],
    tags: input.tags ?? []
  };
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith("---")) {
    return { data: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: content };
  }
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, string | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    data[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return { data, body };
}

function skillDiagnosticToResourceDiagnostic(diagnostic: SkillDiagnostic): ScopedContextResourceDiagnostic {
  return {
    severity: "warning",
    path: diagnostic.path,
    message: diagnostic.message
  };
}

function warning(path: string, message: string): ScopedContextResourceDiagnostic {
  return { severity: "warning", path, message };
}

function stringField(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function scopeField(value: string | boolean | undefined): ScopedContextScope | undefined {
  return value === "global" || value === "workspace" || value === "project" ? value : undefined;
}

function activationField(value: string | boolean | undefined): ScopedContextActivation | undefined {
  return value === "enabled" || value === "recommended" || value === "disabled" ? value : undefined;
}

function stringList(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableRuleId(sourceLabel: string, filePath: string): string {
  const normalized = relative(resolve("."), resolve(filePath)).replace(/\\/g, "/");
  return `rule:${sourceLabel}:${normalized}`;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const normalized = resolve(item).toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}


