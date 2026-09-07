/**
 * 统一原生文件选择器入口。
 * 所有「选择文件/添加附件」路径必须经本 helper，禁止散落动态 import 或多轨实现。
 */

import { open } from '@tauri-apps/plugin-dialog';

export interface OpenFileDialogOptions {
  title?: string;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

export class FileDialogUnavailableError extends Error {
  readonly code = 'FILE_DIALOG_UNAVAILABLE' as const;

  constructor(message = 'native file dialog unavailable') {
    super(message);
    this.name = 'FileDialogUnavailableError';
  }
}

/**
 * 打开系统原生「添加文件」对话框（支持多选）。
 * 用户取消返回 null；插件不可用抛出 FileDialogUnavailableError
 */
export async function openFileDialog(
  options?: OpenFileDialogOptions
): Promise<string[] | null> {
  let selected: string | string[] | null;
  try {
    selected = await open({
      directory: false,
      multiple: options?.multiple ?? true,
      title: options?.title ?? '添加文件',
      filters: options?.filters,
    });
  } catch {
    throw new FileDialogUnavailableError();
  }

  if (!selected) return null;
  if (Array.isArray(selected)) {
    return selected.filter((p) => typeof p === 'string' && p.trim().length > 0);
  }
  if (typeof selected === 'string' && selected.trim().length > 0) {
    return [selected.trim()];
  }
  return null;
}

/**
 * 安全版：取消或不可用均返回 null
 */
export async function openFileDialogSafe(
  options?: OpenFileDialogOptions
): Promise<string[] | null> {
  try {
    return await openFileDialog(options);
  } catch {
    return null;
  }
}
