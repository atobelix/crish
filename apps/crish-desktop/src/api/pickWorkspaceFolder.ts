/**
 * 选择工作区文件夹并加入项目列表（PR-7）。
 *
 * 流程：原生目录对话框 → addProjectFromPath → 返回路径。
 * - 成功：写入项目 store，返回路径
 * - 用户取消：no-op，返回 null（不打开应用内选择器）
 * - 原生对话框不可用：中文 toast + emitUiEvent('open-project-picker')
 */

import {
  DirectoryDialogUnavailableError,
  openDirectoryDialog,
} from './openDirectoryDialog';
import { addProjectFromPath } from './projectStore';
import { emitUiEvent } from './uiEvents';
import { toastBus } from '../services/ToastBus';

/**
 * 选择工作区目录并注册为项目。
 * @returns 成功时的路径；取消或失败时 null
 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  try {
    const path = await openDirectoryDialog('选择项目文件夹');
    if (!path) {
      // 用户取消：no-op
      return null;
    }
    addProjectFromPath(path);
    return path;
  } catch (err) {
    // 原生对话框不可用 → 中文提示 + 应用内项目选择器
    if (
      err instanceof DirectoryDialogUnavailableError ||
      (err instanceof Error && err.message.includes('DIRECTORY_DIALOG'))
    ) {
      toastBus.warning('无法打开系统文件夹选择器，请使用应用内项目列表');
      emitUiEvent('open-project-picker');
      return null;
    }
    toastBus.warning('无法打开系统文件夹选择器，请使用应用内项目列表');
    emitUiEvent('open-project-picker');
    return null;
  }
}
