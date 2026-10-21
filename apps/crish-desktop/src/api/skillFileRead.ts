/**
 * 读取一份完整的技能正文。
 *
 * 超过读取上限时返回截断，调用方不得把预览写进技能库。
 */

import { invokeResult } from './tauriInvoke';
import { interpretSkillText, type LoadedSkillText } from './skillImportContent';

const SKILL_FILE_MAX_LINES = 20000;

export async function readSkillText(path: string): Promise<LoadedSkillText> {
  const target = path.trim();
  if (!target) return { ok: false, reason: 'missing' };
  const read = await invokeResult<{ content?: string; truncated?: boolean }>(
    'workbench_read_file_content',
    { path: target, maxLines: SKILL_FILE_MAX_LINES }
  );
  if (read.status !== 'ok') return { ok: false, reason: 'missing' };
  return interpretSkillText(read.data);
}
