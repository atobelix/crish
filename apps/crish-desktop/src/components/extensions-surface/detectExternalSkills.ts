/**
 * 探测系统及外部软件（Antigravity、Local 规则库等）中的已安装技能 (Skills)
 */

import { invokeResult } from '../../api/tauriInvoke';

export interface DetectedExternalSkill {
  id: string;
  name: string;
  description: string;
  source: 'Antigravity' | 'Local';
  filePath: string;
  skillDir: string;
  dirPath?: string;
  content?: string;
  isBuiltin?: boolean;
}

interface ScanTarget {
  source: 'Antigravity' | 'Local';
  isBuiltin: boolean;
  getDir: (home: string) => string;
}

const SCAN_TARGETS: ScanTarget[] = [
  {
    source: 'Antigravity',
    isBuiltin: false,
    getDir: (home) => `${home}/.gemini/antigravity/skills`.replace(/\\/g, '/'),
  },
  {
    source: 'Antigravity',
    isBuiltin: true,
    getDir: (home) =>
      `${home}/.gemini/antigravity/builtin/skills`.replace(/\\/g, '/'),
  },
  {
    source: 'Local',
    isBuiltin: false,
    getDir: (home) => `${home}/.agents/skills`.replace(/\\/g, '/'),
  },
];

export const DEFAULT_PRESET_EXTERNAL_SKILLS: DetectedExternalSkill[] = [
  {
    id: 'ext-skill-antigravity-disk-cleanup',
    name: 'disk-cleanup',
    description:
      'Comprehensive rules, safety boundaries, and procedures for inspecting and cleaning disk space.',
    source: 'Antigravity',
    filePath: '~/.gemini/antigravity/skills/disk-cleanup/SKILL.md',
    skillDir: '~/.gemini/antigravity/skills/disk-cleanup',
    dirPath: '~/.gemini/antigravity/skills/disk-cleanup',
    isBuiltin: false,
  },
  {
    id: 'ext-skill-antigravity-repo-to-resume-tailor',
    name: 'repo-to-resume-tailor',
    description:
      'Analyze a full code repository and generate one resume-ready project description grounded in repository evidence.',
    source: 'Antigravity',
    filePath: '~/.gemini/antigravity/skills/repo-to-resume-tailor/SKILL.md',
    skillDir: '~/.gemini/antigravity/skills/repo-to-resume-tailor',
    dirPath: '~/.gemini/antigravity/skills/repo-to-resume-tailor',
    isBuiltin: false,
  },
  {
    id: 'ext-skill-antigravity-resume-master',
    name: 'resume-master',
    description:
      '通过直接编写可编辑的 HTML 源文件，来创建新简历或根据职位描述（JD）量身定制现有简历，最终交付可打印 PDF。',
    source: 'Antigravity',
    filePath: '~/.gemini/antigravity/skills/resume-master/SKILL.md',
    skillDir: '~/.gemini/antigravity/skills/resume-master',
    dirPath: '~/.gemini/antigravity/skills/resume-master',
    isBuiltin: false,
  },
  {
    id: 'ext-skill-antigravity-automation',
    name: 'automation',
    description:
      'Interactive guide to design and create a scheduled background automation.',
    source: 'Antigravity',
    filePath: '~/.gemini/antigravity/builtin/skills/automation/SKILL.md',
    skillDir: '~/.gemini/antigravity/builtin/skills/automation',
    dirPath: '~/.gemini/antigravity/builtin/skills/automation',
    isBuiltin: true,
  },
  {
    id: 'ext-skill-antigravity-generative-ui',
    name: 'generative_ui',
    description:
      'How to render rich interactive HTML widgets inline in the chat or as standalone artifacts.',
    source: 'Antigravity',
    filePath: '~/.gemini/antigravity/builtin/skills/generative_ui/SKILL.md',
    skillDir: '~/.gemini/antigravity/builtin/skills/generative_ui',
    dirPath: '~/.gemini/antigravity/builtin/skills/generative_ui',
    isBuiltin: true,
  },
];

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

async function listSubDirs(dirPath: string): Promise<string[]> {
  try {
    const res = await invokeResult<{
      items?: Array<{ name: string; is_dir?: boolean; isDir?: boolean }>;
    }>('workbench_list_directory', { path: dirPath });
    if (res.status === 'ok' && Array.isArray(res.data?.items)) {
      return res.data.items
        .filter((i) => Boolean(i.is_dir ?? i.isDir))
        .map((i) => i.name)
        .filter(Boolean);
    }
  } catch {
    // ignore
  }
  return [];
}

async function readSkillFile(filePath: string): Promise<string | null> {
  try {
    const res = await invokeResult<{ content?: string }>(
      'workbench_read_file_content',
      {
        path: filePath,
        maxLines: 5000,
      }
    );
    if (res.status === 'ok' && typeof res.data?.content === 'string') {
      return res.data.content;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 探测系统及外部软件的技能目录
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
      const rootDir = target.getDir(home);
      try {
        const subDirs = await listSubDirs(rootDir);
        for (const sub of subDirs) {
          const skillDir = `${rootDir}/${sub}`;
          const filePath = `${skillDir}/SKILL.md`;
          if (seenPaths.has(filePath)) continue;

          const content = await readSkillFile(filePath);
          if (content) {
            const { name, description } = parseSkillMarkdown(content, sub);
            const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
            const id = `ext-skill-${target.source.toLowerCase()}-${safeName}`;

            seenPaths.add(filePath);
            results.push({
              id,
              name,
              description,
              source: target.source,
              filePath,
              skillDir,
              dirPath: skillDir,
              content,
              isBuiltin: target.isBuiltin,
            });
          }
        }
      } catch {
        // 继续下一个探测目标
      }
    }
  }

  if (results.length === 0 && allowFallback) {
    return [...DEFAULT_PRESET_EXTERNAL_SKILLS];
  }

  return results;
}
