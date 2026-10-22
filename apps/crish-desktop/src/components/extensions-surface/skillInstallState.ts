/**
 * 技能副本写入成功之后的本机状态。
 *
 * 取消卸载标记，并把激活态记为已启用。不负责写文件。
 */

import { skillStableId } from '../../api/skillId';
import * as skillsApi from '../../api/skillsApi';
import { setSkillDismissed } from './skillDismissState';
import { t } from '../../i18n';

export async function enableInstalledSkillCopy(opts: {
  name: string;
  description?: string;
  skillPath: string;
  skillDir: string;
  scope: 'project' | 'global';
  content?: string;
}): Promise<void> {
  const name = opts.name.trim();
  if (!name) return;
  setSkillDismissed(name, false);
  const content = opts.content ?? '';
  const description = (
    opts.description || t('extensions.skill.defaultDescription', { name })
  ).trim();
  await skillsApi.setSkillActivation(
    {
      id: skillStableId(name, opts.skillPath),
      name,
      description,
      filePath: opts.skillPath,
      baseDir: opts.skillDir,
      content,
      raw: content,
      scope: opts.scope,
      activation: 'enabled',
      tags: [],
      appliesTo: [],
      disableModelInvocation: false,
      system: false,
    },
    'enabled'
  );
}
