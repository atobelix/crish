/**
 * 导入前的正文准备。
 *
 * 只决定要写入的文本和副本标识：沿用卡片正文、读取来源文件，或把正文留空交给技能模板。
 * 不写盘，也不判断技能该进哪个库。
 */

import { parseFrontmatter } from './skillsApiHelpers';
import { t } from '../i18n';

export type SkillContentSource = {
  name: string;
  content?: string | null;
  filePath?: string;
};

export type ResolvedSkillContent =
  { ok: true; content?: string } | { ok: false; message: string };

export type LoadedSkillText =
  | { ok: true; content: string }
  | { ok: false; reason: 'empty' | 'truncated' | 'missing' };

/** 读文件结果里，截断或不完整的正文不能当成可写入的技能。 */
export function interpretSkillText(
  read:
    | {
        content?: string;
        truncated?: boolean;
      }
    | null
    | undefined
): LoadedSkillText {
  if (!read) return { ok: false, reason: 'missing' };
  if (read.truncated) return { ok: false, reason: 'truncated' };
  const text = read.content?.trim() || '';
  if (!text) return { ok: false, reason: 'empty' };
  return { ok: true, content: text };
}

/**
 * 副本目录用正文里的名称。
 * 发现和卸载都认这个名称；用文件夹名会写到另一条路径上。
 */
export function skillCopyName(content: string, fallback: string): string {
  const fromFile = parseFrontmatter(content).data.name;
  if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();
  return fallback.trim() || 'skill';
}

export function expandHomePath(
  path: string | undefined,
  homeDir: string
): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  if (!homeDir || (normalized !== '~' && !normalized.startsWith('~/'))) {
    return normalized;
  }
  if (normalized === '~') return homeDir;
  return `${homeDir}/${normalized.slice(2).replace(/^[/]+/, '')}`;
}

export async function resolveUserHomeDir(
  readHome: () => Promise<string | null | undefined>
): Promise<string> {
  const fromHost = (await readHome()) || '';
  const fromEnv =
    typeof process !== 'undefined'
      ? process.env?.USERPROFILE || process.env?.HOME || ''
      : '';
  return (fromHost.trim() || fromEnv).replace(/\\/g, '/').replace(/\/+$/, '');
}

export async function resolveDetectedSkillContent(
  skill: SkillContentSource,
  homeDir: string,
  readText: (path: string) => Promise<LoadedSkillText>
): Promise<ResolvedSkillContent> {
  const inline = skill.content?.trim() || '';
  if (inline) return { ok: true, content: inline };

  const filePath = expandHomePath(skill.filePath, homeDir);
  if (!filePath) return { ok: true };

  const loaded = await readText(filePath);
  if (!loaded.ok && loaded.reason === 'truncated') {
    return {
      ok: false,
      message: t('extensions.skill.import.truncatedBody', { name: skill.name }),
    };
  }
  if (!loaded.ok && loaded.reason === 'empty') {
    return {
      ok: false,
      message: t('extensions.skill.import.emptyBody', { name: skill.name }),
    };
  }
  if (!loaded.ok) return { ok: true };
  return { ok: true, content: loaded.content };
}
