import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { decodeTextBuffer } from '@crish/agent-context';
import { errorMessage } from '@crish/shared-utils';

export interface AgentSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  content: string;
  disableModelInvocation: boolean;
  scope?: 'global' | 'project' | 'workspace';
  activation?: 'enabled' | 'recommended' | 'disabled';
  runAs?: 'inline' | 'subagent';
  readOnly?: boolean;
  allowedTools?: string[];
  invocation?: 'auto' | 'manual';
  appliesTo?: string[];
  tags?: string[];
}

export interface LoadSkillsResult {
  skills: AgentSkill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillDiagnostic {
  severity: 'warning';
  code:
    | 'skill-directory-unreadable'
    | 'skill-file-unreadable'
    | 'skill-file-not-file'
    | 'skill-file-too-large'
    | 'skill-file-binary'
    | 'skill-name-invalid'
    | 'skill-description-invalid';
  path: string;
  message: string;
}

export interface LoadSkillsOptions {
  maxSkillBytes?: number;
}

interface ParsedFrontmatter {
  data: Record<string, string | boolean>;
  body: string;
}

const DEFAULT_MAX_SKILL_BYTES = 512 * 1024;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export async function loadSkillsFromDirectory(
  dir: string,
  options: LoadSkillsOptions = {}
): Promise<LoadSkillsResult> {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  await loadSkillsInto(dir, result, true, normalizeLoadSkillsOptions(options));
  return result;
}

export function formatSkillInvocation(
  skill: AgentSkill,
  userInstruction?: string
): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return userInstruction ? `${block}\n\n${userInstruction}` : block;
}

async function loadSkillsInto(
  dir: string,
  result: LoadSkillsResult,
  includeRootMarkdown: boolean,
  options: Required<LoadSkillsOptions>
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    result.diagnostics.push(
      warning(
        'skill-directory-unreadable',
        dir,
        `Failed to read skill directory: ${errorMessage(error)}`
      )
    );
    return;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    const skill = await loadSkillFile(join(dir, 'SKILL.md'), result, options);
    if (skill) {
      result.skills.push(skill);
    }
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await loadSkillsInto(fullPath, result, false, options);
      continue;
    }
    if (includeRootMarkdown && entry.isFile() && entry.name.endsWith('.md')) {
      const skill = await loadSkillFile(fullPath, result, options);
      if (skill) {
        result.skills.push(skill);
      }
    }
  }
}

async function loadSkillFile(
  filePath: string,
  result: LoadSkillsResult,
  options: Required<LoadSkillsOptions>
): Promise<AgentSkill | null> {
  let content: string;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      result.diagnostics.push(
        warning('skill-file-not-file', filePath, 'Skill path is not a file.')
      );
      return null;
    }
    if (fileStat.size > options.maxSkillBytes) {
      result.diagnostics.push(
        warning(
          'skill-file-too-large',
          filePath,
          `Skill file exceeds ${options.maxSkillBytes} bytes.`
        )
      );
      return null;
    }
    const decoded = decodeTextBuffer(await readFile(filePath));
    if (decoded.encoding === 'binary') {
      result.diagnostics.push(
        warning('skill-file-binary', filePath, 'Skill file is binary.')
      );
      return null;
    }
    content = decoded.text;
  } catch (error) {
    result.diagnostics.push(
      warning(
        'skill-file-unreadable',
        filePath,
        `Failed to read skill file: ${errorMessage(error)}`
      )
    );
    return null;
  }

  const parsed = parseFrontmatter(content);
  const baseDir = dirname(filePath);
  const fallbackName = basename(baseDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = String(parsed.data.name || fallbackName);
  const description = String(
    parsed.data.description || firstMarkdownSentence(parsed.body) || name
  );
  for (const message of validateSkillName(name)) {
    result.diagnostics.push(warning('skill-name-invalid', filePath, message));
  }
  for (const message of validateSkillDescription(description)) {
    result.diagnostics.push(
      warning('skill-description-invalid', filePath, message)
    );
  }
  const runAsRaw = String(
    parsed.data['run-as'] ?? parsed.data.runAs ?? ''
  ).toLowerCase();
  const runAs =
    runAsRaw === 'subagent'
      ? 'subagent'
      : runAsRaw === 'inline'
        ? 'inline'
        : undefined;
  const readOnly =
    parsed.data['read-only'] === true || parsed.data.readOnly === true;
  const invocationRaw = String(parsed.data.invocation || '').toLowerCase();
  const invocation =
    invocationRaw === 'manual'
      ? 'manual'
      : invocationRaw === 'auto'
        ? 'auto'
        : undefined;
  const allowedTools = stringList(
    parsed.data['allowed-tools'] ?? parsed.data.allowedTools
  );

  return {
    name,
    description,
    filePath,
    baseDir,
    content: parsed.body.trim(),
    disableModelInvocation: parsed.data['disable-model-invocation'] === true,
    ...(runAs ? { runAs } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(invocation ? { invocation } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(skillScope(parsed.data.scope) !== undefined
      ? { scope: skillScope(parsed.data.scope) }
      : {}),
    ...(skillActivation(parsed.data.activation) !== undefined
      ? { activation: skillActivation(parsed.data.activation) }
      : {}),
    ...(stringList(parsed.data['applies-to'] ?? parsed.data.appliesTo).length >
    0
      ? {
          appliesTo: stringList(
            parsed.data['applies-to'] ?? parsed.data.appliesTo
          ),
        }
      : {}),
    ...(stringList(parsed.data.tags).length > 0
      ? { tags: stringList(parsed.data.tags) }
      : {}),
  } as AgentSkill;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---')) {
    return { data: {}, body: content };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { data: {}, body: content };
  }
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const data: Record<string, string | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!.trim();
    const value = match[2]!.trim().replace(/^["']|["']$/g, '');
    data[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return { data, body };
}

function firstMarkdownSentence(content: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'));
  return line?.slice(0, 160);
}

function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`Skill name exceeds ${MAX_SKILL_NAME_LENGTH} characters.`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      'Skill name must use lowercase letters, numbers, and hyphens only.'
    );
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('Skill name must not start or end with a hyphen.');
  }
  if (name.includes('--')) {
    errors.push('Skill name must not contain consecutive hyphens.');
  }
  return errors;
}

function validateSkillDescription(description: string): string[] {
  if (!description.trim()) {
    return ['Skill description is required.'];
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return [
      `Skill description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
    ];
  }
  return [];
}

function skillScope(
  value: string | boolean | undefined
): AgentSkill['scope'] | undefined {
  return value === 'global' || value === 'project' || value === 'workspace'
    ? value
    : undefined;
}

function skillActivation(
  value: string | boolean | undefined
): AgentSkill['activation'] | undefined {
  return value === 'enabled' || value === 'recommended' || value === 'disabled'
    ? value
    : undefined;
}

function stringList(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLoadSkillsOptions(
  options: LoadSkillsOptions
): Required<LoadSkillsOptions> {
  return {
    maxSkillBytes: positiveInteger(
      options.maxSkillBytes,
      DEFAULT_MAX_SKILL_BYTES
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function warning(
  code: SkillDiagnostic['code'],
  path: string,
  message: string
): SkillDiagnostic {
  return { severity: 'warning', code, path, message };
}
