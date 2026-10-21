/**
 * 技能副本的安装顺序。
 *
 * 先写入当前工作区技能库，失败后再写入用户主目录下的全局技能库。
 * 这里不登记外部目录，不改激活态，也不弹出提示。
 */

import {
  createGlobalSkill,
  createProjectSkill,
  type CreateSkillResult,
} from './skillsApiCreate';
import { t } from '../i18n';

export type SkillCopyWriters = {
  createProjectSkill: (
    opts: Parameters<typeof createProjectSkill>[0]
  ) => Promise<CreateSkillResult>;
  createGlobalSkill: (
    opts: Parameters<typeof createGlobalSkill>[0]
  ) => Promise<CreateSkillResult>;
};

export type OwnedSkillInstallRequest = {
  name: string;
  description?: string;
  content?: string;
  homeDir?: string;
  overwrite?: boolean;
};

export type OwnedSkillInstallResult =
  | {
      ok: true;
      scope: 'project' | 'global';
      skillPath: string;
      skillDir: string;
    }
  | { ok: false; error: string };

/**
 * 调用时再读取写入函数。
 * 测试可以替换这两个字段，而不必把界面和创建实现绑在一起。
 */
export const skillCopyWriters: SkillCopyWriters = {
  createProjectSkill,
  createGlobalSkill,
};

export async function installOwnedSkillPreferringProject(
  request: OwnedSkillInstallRequest,
  writers: SkillCopyWriters = skillCopyWriters
): Promise<OwnedSkillInstallResult> {
  const shared = {
    name: request.name,
    description: request.description,
    content: request.content,
    overwrite: request.overwrite,
  };
  const project = await writers.createProjectSkill(shared);
  if (project.ok) {
    return {
      ok: true,
      scope: 'project',
      skillPath: project.skillPath,
      skillDir: project.skillDir,
    };
  }
  const global = await writers.createGlobalSkill({
    ...shared,
    homeDir: request.homeDir,
  });
  if (global.ok) {
    return {
      ok: true,
      scope: 'global',
      skillPath: global.skillPath,
      skillDir: global.skillDir,
    };
  }
  return {
    ok: false,
    error: project.error || global.error || t('skill.import.writeFailed'),
  };
}
