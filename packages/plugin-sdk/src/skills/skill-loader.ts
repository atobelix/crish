/**
 * SkillLoader — 技能加载器。
 *
 * 依据 ROUND-08-plugin-sdk.md §2.4 任务 4-6 + §3.7：
 *   1. 扫描技能目录（skills/<name>/SKILL.md）
 *   2. 解析 frontmatter（迁移自 agent-tools/src/skills.ts）
 *   3. 技能 → 工具转换（toTool）：将 SKILL.md 内容包装为可被 LLM 调用的工具
 *
 * 技能目录结构（禁令 15/16/17，移除 agents/ 子目录避免与 agent-subagent 概念混淆）：
 *   skills/
 *     <skill-name>/
 *       SKILL.md          # frontmatter + 正文
 *       scripts/          # 可选，辅助脚本
 *       prompts/          # 可选，prompt 片段
 *
 * 迁移要点（对齐 agent-tools/src/skills.ts 的 loadSkillsFromDirectory）：
 * - frontmatter 解析逻辑保留（kebab-case 键、布尔/字符串/列表值）
 * - 名称校验保留（小写字母+数字+连字符，禁止首尾连字符、连续连字符）
 * - 描述校验保留（非空，长度上限 1024）
 * - 二进制检测保留（null byte 探测，避免误将二进制当 Markdown 解析）
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolExecutionContext,
  ToolOutput,
} from '@crish/shared-types';
import type {
  LoadSkillsOptions,
  LoadSkillsResult,
  PluginSkill,
  SkillDiagnostic,
} from './skill-types';

const DEFAULT_MAX_SKILL_BYTES = 512 * 1024;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * SkillLoader — 技能加载与转换。
 *
 * 职责：
 * 1. loadFromDirectory：扫描技能根目录，解析每个 <name>/SKILL.md
 * 2. toTool：将技能转换为 ToolDefinition，供 api.registerTool() 注册
 *
 * 线程安全：无状态，可在多个加载流程复用。
 */
export class SkillLoader {
  /**
   * 从目录加载全部技能。
   *
   * 扫描规则（对齐迁移前的 loadSkillsFromDirectory）：
   * - 若目录直接含 SKILL.md，将该目录视为单个技能
   * - 否则递归子目录（跳过 . 开头与 node_modules）
   * - 单个技能加载失败不影响其他技能（记录 warning 诊断）
   *
   * @param skillsDir 技能根目录
   * @param options 加载选项（maxSkillBytes 等）
   */
  async loadFromDirectory(
    skillsDir: string,
    options: LoadSkillsOptions = {},
  ): Promise<LoadSkillsResult> {
    const result: MutableLoadSkillsResult = { skills: [], diagnostics: [] };
    const maxBytes = normalizeMaxBytes(options.maxSkillBytes);
    await this.loadSkillsInto(skillsDir, result, true, maxBytes);
    return result;
  }

  /**
   * 技能 → 工具转换。
   *
   * 将 SKILL.md 内容包装为 ToolDefinition，供 api.registerTool() 注册。
   * 工具执行时返回 SKILL.md 正文 + 用户输入，由 LLM 按指令操作。
   *
   * @param skill 已加载的技能
   * @returns 工具定义（含 execute 函数）
   */
  toTool(skill: PluginSkill): ToolDefinition {
    return {
      name: skill.name,
      description: skill.description,
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Optional user input appended to the skill content',
          },
        },
      },
      async execute(
        input: JsonObject,
        _ctx: ToolExecutionContext,
      ): Promise<ToolOutput> {
        const userInput = readStringField(input, 'input');
        const header = `# Skill: ${skill.name}`;
        const body = skill.content;
        const tail =
          userInput !== undefined
            ? `\n\n## User Input\n${userInput}`
            : '\n\n## User Input\n(none)';
        return { text: `${header}\n\n${body}${tail}` };
      },
    };
  }

  // ─── 内部：递归加载 ──────────────────────────────────────────

  private async loadSkillsInto(
    dir: string,
    result: MutableLoadSkillsResult,
    includeRootMarkdown: boolean,
    maxBytes: number,
  ): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, {
        withFileTypes: true,
        encoding: 'utf8',
      });
    } catch {
      result.diagnostics.push(
        diagnostic('error', 'skill-directory-unreadable', dir, [
          `Failed to read skill directory: ${dir}`,
        ]),
      );
      return;
    }

    // 若目录直接含 SKILL.md，视为单个技能目录
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      const skill = await this.loadSkillFile(
        join(dir, 'SKILL.md'),
        result,
        maxBytes,
      );
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
        await this.loadSkillsInto(fullPath, result, false, maxBytes);
        continue;
      }
      if (includeRootMarkdown && entry.isFile() && entry.name.endsWith('.md')) {
        const skill = await this.loadSkillFile(fullPath, result, maxBytes);
        if (skill) {
          result.skills.push(skill);
        }
      }
    }
  }

  private async loadSkillFile(
    filePath: string,
    result: MutableLoadSkillsResult,
    maxBytes: number,
  ): Promise<PluginSkill | null> {
    let content: string;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        result.diagnostics.push(
          diagnostic('warning', 'skill-file-not-file', filePath, [
            'Skill path is not a file.',
          ]),
        );
        return null;
      }
      if (fileStat.size > maxBytes) {
        result.diagnostics.push(
          diagnostic('warning', 'skill-file-too-large', filePath, [
            `Skill file exceeds ${maxBytes} bytes.`,
          ]),
        );
        return null;
      }
      const buffer = await readFile(filePath);
      if (isBinaryBuffer(buffer)) {
        result.diagnostics.push(
          diagnostic('warning', 'skill-file-binary', filePath, [
            'Skill file is binary.',
          ]),
        );
        return null;
      }
      content = buffer.toString('utf8');
    } catch {
      result.diagnostics.push(
        diagnostic('warning', 'skill-file-unreadable', filePath, [
          `Failed to read skill file: ${filePath}`,
        ]),
      );
      return null;
    }

    const parsed = parseFrontmatter(content);
    if (!parsed) {
      result.diagnostics.push(
        diagnostic('warning', 'skill-frontmatter-malformed', filePath, [
          'SKILL.md frontmatter is malformed or missing closing delimiter.',
        ]),
      );
      return null;
    }

    const baseDir = dirname(filePath);
    const fallbackName = basename(baseDir)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const fm = parsed.data;
    const name = stringField(fm, 'name', fallbackName);
    const description = stringField(
      fm,
      'description',
      firstMarkdownSentence(parsed.body) ?? name,
    );

    const nameErrors = validateSkillName(name);
    for (const msg of nameErrors) {
      result.diagnostics.push(
        diagnostic('warning', 'skill-name-invalid', filePath, [msg]),
      );
    }
    const descErrors = validateSkillDescription(description);
    for (const msg of descErrors) {
      result.diagnostics.push(
        diagnostic('warning', 'skill-description-invalid', filePath, [msg]),
      );
    }

    const scope = parseScope(fm['scope']);
    const activation = parseActivation(fm['activation']);
    const runAs = parseRunAs(fm['run-as'] ?? fm['runAs']);
    const readOnly = fm['read-only'] === true || fm['readOnly'] === true;
    const invocation = parseInvocation(fm['invocation']);
    const allowedTools = stringList(fm['allowed-tools'] ?? fm['allowedTools']);
    const appliesTo = stringList(fm['applies-to'] ?? fm['appliesTo']);
    const tags = stringList(fm['tags']);
    const disableModelInvocation =
      fm['disable-model-invocation'] === true ||
      fm['disableModelInvocation'] === true;

    const skill: PluginSkill = {
      name,
      description,
      filePath,
      baseDir,
      content: parsed.body.trim(),
      disableModelInvocation,
      ...(scope !== undefined ? { scope } : {}),
      ...(activation !== undefined ? { activation } : {}),
      ...(runAs !== undefined ? { runAs } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(invocation !== undefined ? { invocation } : {}),
      ...(appliesTo.length > 0 ? { appliesTo } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
    return skill;
  }
}

// ─── 内部辅助类型与函数 ──────────────────────────────────────

interface MutableLoadSkillsResult {
  skills: PluginSkill[];
  diagnostics: SkillDiagnostic[];
}

type FrontmatterValue = string | boolean | string[];

interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

/**
 * 解析 SKILL.md frontmatter（迁移自 agent-tools/src/skills.ts）。
 *
 * 格式：
 *   ---
 *   name: my-skill
 *   description: A skill
 *   tags: [a, b, c]
 *   ---
 *   正文内容
 *
 * 支持的值类型：
 * - 布尔：true / false
 * - 字符串：去除首尾引号
 * - 列表：[a, b, c] 字面量（逗号分隔）
 *
 * 无 frontmatter 时返回 { data: {}, body: content }。
 */
function parseFrontmatter(content: string): ParsedFrontmatter | null {
  if (!content.startsWith('---')) {
    return { data: {}, body: content };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return null; // 缺少闭合分隔符
  }
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const data: Record<string, FrontmatterValue> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = (match[1] ?? '').trim();
    const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    if (value === 'true') {
      data[key] = true;
    } else if (value === 'false') {
      data[key] = false;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      data[key] = value;
    }
  }
  return { data, body };
}

function firstMarkdownSentence(content: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith('#'));
  return line?.slice(0, 160);
}

function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length === 0) {
    errors.push('Skill name is required.');
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`Skill name exceeds ${MAX_SKILL_NAME_LENGTH} characters.`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      'Skill name must use lowercase letters, numbers, and hyphens only.',
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

function parseScope(
  value: FrontmatterValue | undefined,
): PluginSkill['scope'] | undefined {
  if (value === 'global' || value === 'project' || value === 'workspace') {
    return value;
  }
  return undefined;
}

function parseActivation(
  value: FrontmatterValue | undefined,
): PluginSkill['activation'] | undefined {
  if (value === 'enabled' || value === 'recommended' || value === 'disabled') {
    return value;
  }
  return undefined;
}

function parseRunAs(
  value: FrontmatterValue | undefined,
): PluginSkill['runAs'] | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  if (lower === 'inline' || lower === 'subagent') {
    return lower;
  }
  return undefined;
}

function parseInvocation(
  value: FrontmatterValue | undefined,
): PluginSkill['invocation'] | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  if (lower === 'auto' || lower === 'manual') {
    return lower;
  }
  return undefined;
}

function stringList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((s): s is string => typeof s === 'string');
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringField(
  data: Record<string, FrontmatterValue>,
  key: string,
  fallback: string,
): string {
  const value = data[key];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0];
  }
  return fallback;
}

function readStringField(input: JsonObject, key: string): string | undefined {
  const value: JsonValue | undefined = input[key];
  return typeof value === 'string' ? value : undefined;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  // 探测前 8KB 是否含 null byte（对齐 git 的 binary 检测启发式）
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_SKILL_BYTES;
}

function diagnostic(
  severity: SkillDiagnostic['severity'],
  code: SkillDiagnostic['code'],
  path: string,
  messageParts: readonly string[],
): SkillDiagnostic {
  return {
    severity,
    code,
    path,
    message: messageParts.join(''),
  };
}
