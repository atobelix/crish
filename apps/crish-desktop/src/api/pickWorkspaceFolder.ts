/**
 * 选择工作区文件夹并加入项目列表（PR-7）。
 *
 * 流程：Rust 原生目录选择命令（选择结果同时登记）→ 保存项目 → 返回路径。
 * - 成功：写入项目 store，返回路径
 * - 用户取消：no-op，返回 null（不打开应用内选择器）
 * - 原生对话框不可用：emitUiEvent('workspace-picker-unavailable')（App 层桥接为可见
 *   toast）+ emitUiEvent('open-project-picker')（打开应用内选择器）
 *
 * ToastBus 死通道迁移（2026-08-09）：旧 toastBus 无渲染器、发射即不可见；
 * 改为 uiEvents 事件桥，由 App.tsx useToastQueue 宿主订阅弹可见 toast。
 */

import {
  pickAndAddWorkspaceProject,
  WorkspaceAccessError,
} from './workspaceAccessApi';
import { emitUiEvent } from './uiEvents';
import { toast } from '../services/toast';

/**
 * 选择工作区目录并注册为项目。
 * @returns 成功时的路径；取消或失败时 null
 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  try {
    const project = await pickAndAddWorkspaceProject();
    return project?.path ?? null;
  } catch (error) {
    // 原生对话框不可用 → 事件桥（App 层 toast）+ 应用内项目选择器
    const message =
      error instanceof WorkspaceAccessError
        ? error.message
        : '无法打开本地文件夹选择器。';
    toast.error(message);
    emitUiEvent('workspace-picker-unavailable');
    emitUiEvent('open-project-picker');
    return null;
  }
}
