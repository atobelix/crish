/**
 * 把一张外部技能卡片导入为本应用技能副本。
 *
 * 只编排三件事：准备正文、按工作区优先写入副本、写入成功后启用。
 * 按钮、提示和乐观名单由导入界面自己维护。
 */

import {
  resolveDetectedSkillContent,
  resolveUserHomeDir,
} from '../../api/skillImportContent';
import { installOwnedSkillPreferringProject } from '../../api/skillOwnedInstall';
import { readSkillText } from '../../api/skillFileRead';
import { tryHomeDir } from '../../api/skillsApiFs';
import {
  isDisallowedSkillName,
  isQualifiedSkill,
  type DetectedExternalSkill,
} from './detectExternalSkills';
import { enableInstalledSkillCopy } from './skillInstallState';
import { t } from '../../i18n';

export type ImportDetectedSkillResult = {
  ok: boolean;
  message: string;
};

export async function importDetectedSkill(
  skill: DetectedExternalSkill
): Promise<ImportDetectedSkillResult> {
  if (isDisallowedSkillName(skill.name) || !isQualifiedSkill(skill)) {
    return {
      ok: false,
      message: t('extensions.skill.import.disallowed', { name: skill.name }),
    };
  }

  const homeDir = await resolveUserHomeDir(tryHomeDir);
  const body = await resolveDetectedSkillContent(skill, homeDir, readSkillText);
  if (!body.ok) return { ok: false, message: body.message };

  const wrote = await installOwnedSkillPreferringProject({
    name: skill.name,
    description: skill.description,
    content: body.content,
    homeDir,
    overwrite: true,
  });
  if (!wrote.ok) {
    return {
      ok: false,
      message: t('extensions.skill.import.failed', { detail: wrote.error }),
    };
  }

  await enableInstalledSkillCopy({
    name: skill.name,
    description: skill.description,
    skillPath: wrote.skillPath,
    skillDir: wrote.skillDir,
    scope: wrote.scope,
    content: body.content,
  });
  return {
    ok: true,
    message:
      wrote.scope === 'project'
        ? t('extensions.skill.import.projectEnabled', { name: skill.name })
        : t('extensions.skill.import.globalEnabled', { name: skill.name }),
  };
}
