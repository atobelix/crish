// =============================================================================
// apps/crish-desktop/src/components/diff/DiffCardHandlers.ts
// 从 DiffCard.tsx 拆出的文件级操作处理器（acceptCurrentFile / rejectCurrentFile）。
// 纯结构性重构，行为零变更。
// =============================================================================

import { classifyFileDiff, formatApplyFailureToast, applyFileDiffToDisk } from '../../api/applyFileDiff';
import type { FileDiff } from '../../store/types';

export function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

/**
 * 安全自动应用单个文件变更到磁盘；失败走 toastFail 上报。
 */
export async function acceptCurrentFile(
  f: FileDiff,
  applyBusy: boolean,
  setApplyBusy: (v: boolean) => void,
  removeDiffFile: (filePath: string) => void,
  setPanelErr: (msg: string) => void,
  toastFail: (message: string) => void
): Promise<void> {
  if (applyBusy) return;
  if (!classifyFileDiff(f).ok) {
    toastFail('无法安全自动应用，请在编辑器确认');
    return;
  }
  setApplyBusy(true);
  try {
    const result = await applyFileDiffToDisk(f);
    if (result.ok === true) {
      removeDiffFile(f.filePath);
      setPanelErr('');
      return;
    }
    const msg = formatApplyFailureToast(1, [
      { filePath: f.filePath, result },
    ]);
    toastFail(msg || result.message || '无法安全自动应用，请在编辑器确认');
  } catch (e) {
    toastFail(
      `应用失败 · ${basename(f.filePath)}：${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    setApplyBusy(false);
  }
}

/**
 * 移除单个文件变更项。
 */
export function rejectCurrentFile(
  f: FileDiff,
  removeDiffFile: (filePath: string) => void
): void {
  removeDiffFile(f.filePath);
}
