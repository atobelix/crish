/**
 * 探测系统及外部软件（Antigravity、Claude Code、Codex、Cursor、Local 规则库等）中的用户已安装技能 (Skills)
 * 严格过滤软件系统内置自带技能，仅向用户呈现通用的、用户制作或外部安装的技能。
 */

import { readSkillText } from '../../api/skillFileRead';
import { invokeResult } from '../../api/tauriInvoke';

export type DetectedExternalSkillSource =
  'Claude Code' | 'Codex' | 'Antigravity' | 'Cursor' | 'Local';

export type ExternalSkillSource = DetectedExternalSkillSource;

export interface DetectedExternalSkill {
  id: string;
  name: string;
  description: string;
  source: DetectedExternalSkillSource;
  filePath: string;
  skillDir: string;
  dirPath?: string;
  content?: string;
  isBuiltin?: boolean;
}

export interface ScanTarget {
  source: DetectedExternalSkillSource;
  isBuiltin: boolean;
  getDir: (home: string) => string;
}

/**
 * 外部技能扫描目录配置（仅扫描用户制作/用户安装的技能目录，严禁收录系统内置目录）
 */
export const SCAN_TARGETS: ScanTarget[] = [
  {
    source: 'Antigravity',
    isBuiltin: false,
    getDir: (home) => `${home}/.gemini/antigravity/skills`.replace(/\\/g, '/'),
  },
  {
    source: 'Claude Code',
    isBuiltin: false,
    getDir: (home) => `${home}/.claude/skills`.replace(/\\/g, '/'),
  },
  {
    source: 'Codex',
    isBuiltin: false,
    getDir: (home) => `${home}/.codex/skills`.replace(/\\/g, '/'),
  },
  {
    source: 'Cursor',
    isBuiltin: false,
    getDir: (home) => `${home}/.cursor/skills`.replace(/\\/g, '/'),
  },
  {
    source: 'Local',
    isBuiltin: false,
    getDir: (home) => `${home}/.agents/skills`.replace(/\\/g, '/'),
  },
];

const BUILTIN_PATH_REGEX = /(?:^|[/\\])(?:builtin|\.system)(?:[/\\]|$)/i;

/**
 * 判断技能路径是否属于系统内置或专有宿主绑定目录
 * 若包含 /builtin/、\builtin\、/.system/、\.system\，或对应目录名，一律判定为内置技能
 */
export function isBuiltinSkillPath(pathStr?: string): boolean {
  if (!pathStr) return false;
  if (BUILTIN_PATH_REGEX.test(pathStr)) return true;
  const lower = pathStr.toLowerCase();
  if (
    lower.includes('/builtin/') ||
    lower.includes('\\builtin\\') ||
    lower.includes('/.system/') ||
    lower.includes('\\.system\\')
  ) {
    return true;
  }
  const normalized = lower.replace(/\\/g, '/');
  return (
    normalized.includes('/builtin/') ||
    normalized.includes('/.system/') ||
    normalized.endsWith('/builtin') ||
    normalized.endsWith('/.system') ||
    normalized.startsWith('builtin/') ||
    normalized.startsWith('.system/') ||
    normalized === 'builtin' ||
    normalized === '.system'
  );
}

/**
 * 判断技能是否属于系统内置或专有宿主绑定的技能
 */
export function isBuiltinSkill(skill: {
  filePath?: string;
  skillDir?: string;
  dirPath?: string;
  isBuiltin?: boolean;
}): boolean {
  if (skill.isBuiltin === true) return true;
  if (isBuiltinSkillPath(skill.filePath)) return true;
  if (isBuiltinSkillPath(skill.skillDir)) return true;
  if (isBuiltinSkillPath(skill.dirPath)) return true;
  return false;
}

/**
 * 过滤丢弃所有系统内置技能，确保绝不向用户呈现
 */
export function filterOutBuiltinSkills<
  T extends {
    filePath?: string;
    skillDir?: string;
    dirPath?: string;
    isBuiltin?: boolean;
  },
>(skills: T[]): T[] {
  return skills.filter((skill) => !isBuiltinSkill(skill));
}

/**
 * 杂质与不适配技能黑名单：
 * 严禁收录宿主专有环境脚本、运维循环、损坏工具或缺少通用 AI 提示词指令的非标准技能
 */
export const DISALLOWED_SKILL_NAMES = new Set<string>([
  'disk-cleanup',
  'babysit',
  'loop',
  'statusline',
  'update-cli-config',
  'update-cursor-settings',
  'automate',
  'canvas',
  'create-hook',
  'create-rule',
  'create-skill',
  'create-subagent',
  'env-setup',
  'migrate-to-skills',
  'onboard',
  'review',
  'review-bugbot',
  'review-security',
  'sdk',
  'shell',
  'split-to-prs',
  'automation',
  'generative_ui',
  'generative-ui',
  'agy-customizations',
  'antigravity-guide',
  'ui-extension',
  'ui-plugin-navigation',
  'plugin',
  'migrate-workflows',
]);

/**
 * 判断技能名称是否属于杂质、宿主私有工具或被禁止的非通用脚本
 */
export function isDisallowedSkillName(name?: string): boolean {
  if (!name) return true;
  const lower = name.toLowerCase().trim();
  if (DISALLOWED_SKILL_NAMES.has(lower)) return true;
  if (lower.startsWith('firecrawl')) return true;
  return false;
}

/**
 * 校验技能是否属于格式合规、正文有效、可供模型调用的高质量标准技能
 */
export function isQualifiedSkill(skill: {
  name: string;
  filePath?: string;
  skillDir?: string;
  dirPath?: string;
  content?: string | null;
  isBuiltin?: boolean;
}): boolean {
  if (!skill.name || isDisallowedSkillName(skill.name)) return false;
  if (isBuiltinSkill(skill)) return false;
  if (
    isBuiltinSkillPath(skill.filePath) ||
    isBuiltinSkillPath(skill.skillDir)
  ) {
    return false;
  }

  // 杜绝空技能或缺乏有效正文的损坏脚本（正文非空时至少须包含 30 字符实质指令）
  if (typeof skill.content === 'string') {
    const trimmed = skill.content.trim();
    if (trimmed.length < 30) return false;
    // 排除显式禁用模型调用的技能
    if (/disable-model-invocation:\s*true/i.test(trimmed)) return false;
  }
  return true;
}

import { DEFAULT_PRESET_EXTERNAL_SKILLS } from './detectExternalSkillsPresets';

export { DEFAULT_PRESET_EXTERNAL_SKILLS };

export function parseSkillMarkdown(
  content: string,
  folderName = 'skill'
): { name: string; description: string } {
  let name = '';
  let description = '';
  const trimmed = content.trim();

  // 1. 解析 YAML frontmatter
  if (trimmed.startsWith('---')) {
    const endIdx = trimmed.indexOf('---', 3);
    if (endIdx > 3) {
      const frontmatter = trimmed.slice(3, endIdx);
      const remainingBody = trimmed.slice(endIdx + 3).trim();

      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      if (nameMatch?.[1]) {
        name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }

      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch?.[1]) {
        description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }

      if (!description && remainingBody) {
        const bodyLines = remainingBody
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const nonHeaderLine = bodyLines.find((l) => !l.startsWith('#'));
        if (nonHeaderLine) {
          description = nonHeaderLine.slice(0, 150);
        }
      }
    }
  }

  // 2. 回退一级标题
  if (!name) {
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch?.[1]) {
      name = titleMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  if (!name) {
    name = folderName;
  }

  // 3. 回退说明信息
  if (!description) {
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const contentLine = lines.find(
      (l) => !l.startsWith('#') && !l.startsWith('---')
    );
    if (contentLine) {
      description = contentLine.slice(0, 150);
    } else {
      description = `${name} 技能说明`;
    }
  }

  return { name, description };
}

async function resolveHomeDir(): Promise<string | undefined> {
  let home: string | undefined;

  try {
    const pathApi = await (
      import(/* @vite-ignore */ '@tauri-apps/api/path') as Promise<{
        homeDir?: () => Promise<string>;
      } | null>
    ).catch(() => null);

    if (pathApi?.homeDir) {
      const h = await pathApi.homeDir();
      if (h && h.trim()) home = h.trim();
    }
  } catch {
    // ignore
  }

  if (typeof process !== 'undefined' && process.env) {
    const pe = process.env as Record<string, string | undefined>;
    if (!home) home = pe.USERPROFILE || pe.HOME;
  }

  return home ? home.replace(/\\/g, '/') : undefined;
}

interface DirEntry {
  name: string;
  isDir: boolean;
}

async function listDirItems(dirPath: string): Promise<DirEntry[]> {
  try {
    const res = await invokeResult<{
      items?: Array<{ name: string; is_dir?: boolean; isDir?: boolean }>;
    }>('workbench_list_directory', { path: dirPath });
    if (res.status === 'ok' && Array.isArray(res.data?.items)) {
      return res.data.items
        .map((i) => ({
          name: i.name,
          isDir: Boolean(i.is_dir ?? i.isDir),
        }))
        .filter((i) => Boolean(i.name));
    }
  } catch {
    // ignore
  }
  return [];
}

async function readSkillFile(filePath: string): Promise<string | null> {
  try {
    const loaded = await readSkillText(filePath);
    return loaded.ok ? loaded.content : null;
  } catch {
    return null;
  }
}

/**
 * 探测系统及外部软件的用户技能目录
 * 严格过滤所有系统内置自带技能，仅返回用户制作或下载的通用技能
 */
export async function detectExternalSkills(options?: {
  fallback?: boolean;
}): Promise<DetectedExternalSkill[]> {
  const allowFallback = options?.fallback !== false;
  const home = await resolveHomeDir();
  const results: DetectedExternalSkill[] = [];
  const seenPaths = new Set<string>();

  if (home) {
    for (const target of SCAN_TARGETS) {
      if (target.isBuiltin) continue;
      const rootDir = target.getDir(home);
      if (isBuiltinSkillPath(rootDir)) continue;

      try {
        const items = await listDirItems(rootDir);
        for (const item of items) {
          const sub = item.name;
          if (sub.startsWith('.') || sub === '__pycache__') continue;
          if (isDisallowedSkillName(sub)) continue;

          let name = sub;
          let description = `${target.source} 外部技能：${sub}`;
          let skillDir = `${rootDir}/${sub}`;
          let filePath = `${skillDir}/SKILL.md`;
          let content: string | null = null;

          if (isBuiltinSkillPath(skillDir) || isBuiltinSkillPath(filePath)) {
            continue;
          }

          if (item.isDir) {
            if (seenPaths.has(filePath) || seenPaths.has(skillDir)) continue;
            content = await readSkillFile(filePath);
            if (!content || !content.trim() || content.trim().length < 30) {
              // 杜绝空技能或缺乏有效正文的空目录
              continue;
            }
            if (/disable-model-invocation:\s*true/i.test(content)) {
              continue;
            }
            const parsed = parseSkillMarkdown(content, sub);
            name = parsed.name || sub;
            if (isDisallowedSkillName(name)) continue;
            description = parsed.description || description;
          } else {
            // 单文件技能或指令（仅保留 .md 标准说明）
            if (seenPaths.has(`${rootDir}/${sub}`)) continue;
            const ext = sub.split('.').pop()?.toLowerCase();
            const baseName = sub.replace(/\.[^.]+$/, '');
            if (ext !== 'md') continue;
            if (isDisallowedSkillName(baseName)) continue;

            name = baseName;
            skillDir = rootDir;
            filePath = `${rootDir}/${sub}`;

            if (isBuiltinSkillPath(filePath)) continue;

            content = await readSkillFile(filePath);
            if (!content || !content.trim() || content.trim().length < 30)
              continue;
            if (/disable-model-invocation:\s*true/i.test(content)) continue;

            const parsed = parseSkillMarkdown(content, baseName);
            name = parsed.name || baseName;
            if (isDisallowedSkillName(name)) continue;
            description =
              parsed.description || `${target.source} 外部技能：${baseName}`;
          }

          const safeSource = target.source.toLowerCase().replace(/\s+/g, '-');
          const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
          const id = safeName.startsWith(`${safeSource}-`)
            ? `ext-skill-${safeName}`
            : `ext-skill-${safeSource}-${safeName}`;

          const skillObj: DetectedExternalSkill = {
            id,
            name,
            description,
            source: target.source,
            filePath,
            skillDir,
            dirPath: skillDir,
            content: content || undefined,
            isBuiltin: false,
          };

          if (!isQualifiedSkill(skillObj)) {
            continue;
          }

          seenPaths.add(filePath);
          seenPaths.add(skillDir);
          results.push(skillObj);
        }
      } catch {
        // 继续下一个探测目标
      }
    }
  }

  const cleanPresets = DEFAULT_PRESET_EXTERNAL_SKILLS.filter(
    (p) => isQualifiedSkill(p) && !isBuiltinSkill(p)
  );

  if (allowFallback) {
    if (results.length === 0) {
      return [...cleanPresets];
    }
    // 对尚未探测到的官方通用标准技能进行补充，确保开箱即用
    for (const preset of cleanPresets) {
      if (
        !results.some(
          (r) =>
            r.name.toLowerCase() === preset.name.toLowerCase() ||
            r.id.toLowerCase() === preset.id.toLowerCase()
        )
      ) {
        results.push(preset);
      }
    }
  }

  return results.filter((s) => isQualifiedSkill(s) && !isBuiltinSkill(s));
}
