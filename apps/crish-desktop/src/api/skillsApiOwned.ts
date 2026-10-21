/**
 * 技能副本写入与卸载。
 *
 * 只通过桌面壳命令写入已授权工作区或用户主目录下的技能库。
 * 命令尚未就绪时，项目技能回退到既有的工作区写文件命令。
 */

import { getWorkspacePath } from './projectStore';
import { invokeTyped } from './tauriInvoke';
import { writeTextFile } from './workspaceFsApi';
import { t } from '../i18n';

export type OwnedSkillScope = 'project' | 'global';

type OwnedSkillWrite = {
  skillPath?: string;
  skillDir?: string;
  scope?: string;
  removed?: boolean;
};

export async function installOwnedSkillCopy(opts: {
  scope: OwnedSkillScope;
  slug: string;
  content: string;
  overwrite: boolean;
  workspacePath?: string;
  skillPath: string;
  skillDir: string;
}): Promise<
  | { ok: true; skillPath: string; skillDir: string }
  | { ok: false; error: string }
> {
  const workspacePath = (opts.workspacePath || '').trim();
  const res = await invokeTyped<OwnedSkillWrite>(
    'workbench_mutate_owned_skill',
    {
      action: 'install',
      scope: opts.scope,
      ...(opts.scope === 'project' && workspacePath ? { workspacePath } : {}),
      slug: opts.slug,
      content: opts.content,
      overwrite: opts.overwrite,
    }
  );
  if (res.status === 'ok') {
    return {
      ok: true,
      skillPath: res.data?.skillPath || opts.skillPath,
      skillDir: res.data?.skillDir || opts.skillDir,
    };
  }
  if (res.status === 'missing' && opts.scope === 'project' && workspacePath) {
    try {
      await writeTextFile(opts.skillPath, opts.content, opts.overwrite);
      return { ok: true, skillPath: opts.skillPath, skillDir: opts.skillDir };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (res.status === 'missing') {
    return {
      ok: false,
      error: t('extensions.skill.import.globalWriteUnavailable'),
    };
  }
  return {
    ok: false,
    error: res.message || t('extensions.skill.import.writeFailed'),
  };
}

/** 按技能标识卸载项目副本和全局副本。目录不存在时视为已经卸掉。 */
export async function removeOwnedSkillCopies(slug: string): Promise<boolean> {
  const name = slug.trim();
  if (!name) return false;
  let removed = false;
  const workspace = (getWorkspacePath() || '').trim();
  const calls: Array<Record<string, unknown>> = [];
  if (workspace) {
    calls.push({
      action: 'remove',
      scope: 'project',
      workspacePath: workspace,
      slug: name,
    });
  }
  calls.push({ action: 'remove', scope: 'global', slug: name });
  for (const args of calls) {
    const res = await invokeTyped<OwnedSkillWrite>(
      'workbench_mutate_owned_skill',
      args
    );
    if (res.status === 'ok' && res.data?.removed) removed = true;
  }
  return removed;
}
