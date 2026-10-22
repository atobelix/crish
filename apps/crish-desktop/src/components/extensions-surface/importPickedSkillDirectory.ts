/**
 * 从用户选中的目录复制技能。
 *
 * 目录枚举和技能副本写入分开。选中的目录一律复制进本应用技能库，不登记成附加扫描根。
 */

import { readSkillText } from '../../api/skillFileRead';
import { skillCopyName } from '../../api/skillImportContent';
import { joinPath } from '../../api/skillsApiHelpers';
import { installOwnedSkillPreferringProject } from '../../api/skillOwnedInstall';
import { invokeResult } from '../../api/tauriInvoke';
import { enableInstalledSkillCopy } from './skillInstallState';
import { t } from '../../i18n';

const MAX_SKILLS_PER_PICK = 40;

type ListedItem = {
  name?: string;
  is_dir?: boolean;
  isDir?: boolean;
};

export type PickedSkillTarget = {
  name: string;
  filePath: string;
};

function isDirectory(item: ListedItem): boolean {
  return Boolean(item.is_dir ?? item.isDir);
}

/** 根目录自身有技能文件时只取这一份，否则取每个子目录中的技能文件。 */
export function collectSkillFileTargets(
  root: string,
  items: ListedItem[]
): PickedSkillTarget[] {
  const named = items.filter((item) => item.name);
  const rootSkill = named.find(
    (item) =>
      !isDirectory(item) && String(item.name).toUpperCase() === 'SKILL.MD'
  );
  if (rootSkill) {
    const name = root.split(/[\\/]/).filter(Boolean).pop() || 'skill';
    return [{ name, filePath: joinPath(root, 'SKILL.md') }];
  }
  const targets: PickedSkillTarget[] = [];
  for (const item of named) {
    if (!isDirectory(item) || String(item.name).startsWith('.')) continue;
    const name = String(item.name);
    targets.push({
      name,
      filePath: joinPath(joinPath(root, name), 'SKILL.md'),
    });
  }
  return targets;
}

async function listSkillDirectory(dir: string): Promise<ListedItem[] | null> {
  const listed = await invokeResult<{ items?: ListedItem[] }>(
    'workbench_list_directory',
    { path: dir }
  );
  if (listed.status !== 'ok' || !Array.isArray(listed.data?.items)) return null;
  return listed.data.items;
}

export async function importPickedSkillDirectory(
  dir: string
): Promise<{ ok: boolean; message: string }> {
  const root = dir.trim();
  if (!root)
    return { ok: false, message: t('extensions.skill.import.noDirectory') };

  const items = await listSkillDirectory(root);
  if (!items) {
    return {
      ok: false,
      message: t('extensions.skill.import.directoryUnreadable'),
    };
  }

  const targets = collectSkillFileTargets(root, items);
  if (targets.length === 0) {
    return { ok: false, message: t('extensions.skill.import.directoryEmpty') };
  }

  let imported = 0;
  let truncated = 0;
  for (const target of targets.slice(0, MAX_SKILLS_PER_PICK)) {
    const loaded = await readSkillText(target.filePath);
    if (!loaded.ok) {
      if (loaded.reason === 'truncated') truncated += 1;
      continue;
    }
    const name = skillCopyName(loaded.content, target.name);
    const wrote = await installOwnedSkillPreferringProject({
      name,
      content: loaded.content,
      overwrite: true,
    });
    if (!wrote.ok) continue;
    await enableInstalledSkillCopy({
      name,
      skillPath: wrote.skillPath,
      skillDir: wrote.skillDir,
      scope: wrote.scope,
      content: loaded.content,
    });
    imported += 1;
  }
  if (imported === 0 && truncated > 0) {
    return {
      ok: false,
      message: t('extensions.skill.import.allTruncated'),
    };
  }
  if (imported === 0) {
    return { ok: false, message: t('extensions.skill.import.noneWritten') };
  }
  if (truncated > 0) {
    return {
      ok: true,
      message: t('extensions.skill.import.partial', { imported, truncated }),
    };
  }
  return {
    ok: true,
    message: t('extensions.skill.import.importedCount', { imported }),
  };
}
