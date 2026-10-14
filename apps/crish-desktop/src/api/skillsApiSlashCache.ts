/**
 * apps/crish-desktop/src/api/skillsApiSlashCache.ts
 *
 * 技能斜杠命令缓存（斜杠菜单用，避免每次按键全量扫描）与失效广播。
 * 从 skillsApi.ts 拆出（行数门禁收敛）：skillsApi 与 skillsApiCreate 共同消费。
 */

import { getWorkspacePath } from './projectStore';
import { normalizeSlashName } from './skillsApiHelpers';
import { discoverSkills } from './skillsApiDiscovery';
import type { DesktopSkill, SkillSlashCommand } from './skillsApi.types';

/** 启用且未禁用模型调用的技能 → 斜杠命令 */
export function skillsToSlashCommands(
  skills: DesktopSkill[]
): SkillSlashCommand[] {
  return skills
    .filter(
      (s) =>
        (s.activation === 'enabled' || s.activation === 'recommended') &&
        !s.disableModelInvocation
    )
    .map((s) => ({
      cmd: `/skill:${normalizeSlashName(s.name)}`,
      desc: s.description.slice(0, 120),
      skillId: s.id,
      skillName: s.name,
      filePath: s.filePath,
    }))
    .sort((a, b) => a.cmd.localeCompare(b.cmd));
}

/** 缓存：斜杠菜单用，避免每次按键全量扫描 */
let slashCache: {
  at: number;
  commands: SkillSlashCommand[];
  skills: DesktopSkill[];
} | null = null;
const SLASH_CACHE_MS = 30_000;

export async function getSkillSlashCommandsCached(force = false): Promise<{
  commands: SkillSlashCommand[];
  skills: DesktopSkill[];
}> {
  if (!force && slashCache && Date.now() - slashCache.at < SLASH_CACHE_MS) {
    return { commands: slashCache.commands, skills: slashCache.skills };
  }
  const res = await discoverSkills({ workspacePath: getWorkspacePath() });
  const commands = skillsToSlashCommands(res.skills);
  slashCache = { at: Date.now(), commands, skills: res.skills };
  return { commands, skills: res.skills };
}

export function invalidateSkillSlashCache() {
  slashCache = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crish-skills-changed'));
  }
}
