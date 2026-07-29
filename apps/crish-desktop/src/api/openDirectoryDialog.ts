/**
 * 统一原生目录选择器入口（PR-7）。
 * 所有「选择文件夹」路径必须经本 helper，禁止散落 Function()/动态 import。
 *
 * 注意：勿在 info 级日志打印完整文件系统路径（可用是否为空 / 目录名摘要）。
 * 宿主权限在 agent-workbench capabilities（dialog:default / dialog:allow-open）。
 */

import { open } from '@tauri-apps/plugin-dialog';

/** 原生目录对话框不可用（非 Tauri / 插件未加载 / capability 缺失） */
export class DirectoryDialogUnavailableError extends Error {
  readonly code = 'DIRECTORY_DIALOG_UNAVAILABLE' as const;

  constructor(message = 'native directory dialog unavailable') {
    super(message);
    this.name = 'DirectoryDialogUnavailableError';
  }
}

/**
 * 打开系统原生「选择文件夹」对话框。
 * @param title 对话框标题（中文 UI 文案由调用方传入）
 * @returns 选中的绝对路径；用户取消返回 null
 * @throws {DirectoryDialogUnavailableError} 插件不可用时抛出（不记录完整路径）
 */
export async function openDirectoryDialog(
  title?: string,
): Promise<string | null> {
  let selected: string | string[] | null;
  try {
    selected = await open({
      directory: true,
      multiple: false,
      title: title ?? '选择文件夹',
    });
  } catch {
    // 禁止 info 级完整路径日志；由调用方 toast 或 fallback
    throw new DirectoryDialogUnavailableError();
  }

  if (typeof selected === 'string' && selected.trim()) {
    return selected;
  }
  // 用户取消 / 未选择
  return null;
}

/**
 * 安全版：取消与不可用均返回 null（供按钮 onClick 直接 await）。
 */
export async function openDirectoryDialogSafe(
  title?: string,
): Promise<string | null> {
  try {
    return await openDirectoryDialog(title);
  } catch {
    return null;
  }
}
