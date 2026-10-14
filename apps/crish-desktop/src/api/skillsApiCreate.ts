/**
 * apps/crish-desktop/src/api/skillsApiCreate.ts
 *
 * 技能模板创建（项目级 / 全局级）—— 从 skillsApi.ts 拆出（行数门禁收敛）。
 * FS 写入经 skillsApiFs；写后失效斜杠缓存（skillsApiSlashCache）。
 */

import { getWorkspacePath } from './projectStore';
import { joinPath, normalizeSlashName } from './skillsApiHelpers';
import { mkdirAny, readTextAny, writeTextAny, tryHomeDir } from './skillsApiFs';
import { invalidateSkillSlashCache } from './skillsApiSlashCache';

export type CreateSkillResult =
  | { ok: true; skillPath: string; skillDir: string }
  | { ok: false; error: string };

/** 组装 SKILL.md 正文（frontmatter + 用户正文或默认模板；两处创建流共用） */
function buildSkillMarkdown(opts: {
  name: string;
  slug: string;
  desc: string;
  content?: string;
}): string {
  const rawContent = opts.content?.trim();
  if (rawContent) {
    if (rawContent.startsWith('---')) return rawContent;
    return [
      '---',
      `name: ${opts.slug}`,
      `description: ${JSON.stringify(opts.desc)}`,
      'activation: recommended',
      '---',
      '',
      rawContent,
      '',
    ].join('\n');
  }
  return [
    '---',
    `name: ${opts.slug}`,
    `description: ${JSON.stringify(opts.desc)}`,
    'activation: recommended',
    '---',
    '',
    `# ${opts.name.trim() || opts.slug}`,
    '',
    '## 何时使用',
    '',
    `- ${opts.desc}`,
    '',
    '## 步骤',
    '',
    '1. 阅读任务上下文',
    '2. 按本技能约定执行',
    '3. 完成后做简要校验',
    '',
  ].join('\n');
}

/** 写入 SKILL.md 并失效斜杠缓存 */
async function writeSkillTemplate(
  skillDir: string,
  skillPath: string,
  body: string
): Promise<CreateSkillResult> {
  const mk = await mkdirAny(skillDir);
  if (!mk) {
    // 尝试直接写（部分 fs 会自动建父目录）
  }
  const wrote = await writeTextAny(skillPath, body);
  if (!wrote) {
    return {
      ok: false,
      error: '无法写入 SKILL.md（需要桌面壳 plugin-fs 权限）',
    };
  }
  invalidateSkillSlashCache();
  return { ok: true, skillPath, skillDir };
}

/** 在项目 .conex/skills 下创建技能模板 */
export async function createProjectSkill(opts: {
  name: string;
  description?: string;
  workspacePath?: string | null;
  content?: string;
  overwrite?: boolean;
}): Promise<CreateSkillResult> {
  const workspace = (opts.workspacePath ?? getWorkspacePath() ?? '').trim();
  if (!workspace) return { ok: false, error: '未打开工作区，无法创建项目技能' };
  const slug = normalizeSlashName(opts.name);
  if (!slug) return { ok: false, error: '技能名称无效' };

  const skillDir = joinPath(joinPath(workspace, '.conex/skills'), slug);
  const skillPath = joinPath(skillDir, 'SKILL.md');
  const existing = await readTextAny(skillPath);
  if (existing != null && !opts.overwrite)
    return { ok: false, error: `已存在：${skillPath}` };

  const desc = (opts.description || `${opts.name} 技能`).trim();
  const body = buildSkillMarkdown({
    name: opts.name,
    slug,
    desc,
    content: opts.content,
  });
  return writeSkillTemplate(skillDir, skillPath, body);
}

/** 在用户主目录全局 skills 下创建技能模板 */
export async function createGlobalSkill(opts: {
  name: string;
  description?: string;
  homeDir?: string | null;
  content?: string;
  overwrite?: boolean;
}): Promise<CreateSkillResult> {
  let home = (opts.homeDir || '').trim();
  if (!home) {
    home = (await tryHomeDir()) || '';
    if (!home && typeof process !== 'undefined' && process.env) {
      home = process.env.USERPROFILE || process.env.HOME || '';
    }
  }
  home = home.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!home)
    return { ok: false, error: '未获取到用户主目录，无法创建全局技能' };
  const slug = normalizeSlashName(opts.name);
  if (!slug) return { ok: false, error: '技能名称无效' };

  const skillDir = joinPath(joinPath(home, '.crish/skills'), slug);
  const skillPath = joinPath(skillDir, 'SKILL.md');
  const existing = await readTextAny(skillPath);
  if (existing != null && !opts.overwrite)
    return { ok: false, error: `已存在：${skillPath}` };

  const desc = (opts.description || `${opts.name} 技能`).trim();
  const body = buildSkillMarkdown({
    name: opts.name,
    slug,
    desc,
    content: opts.content,
  });
  return writeSkillTemplate(skillDir, skillPath, body);
}
