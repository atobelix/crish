/**
 * 运行时权限同步（主 run 活单元）。
 *
 * 前端权限选择器同时承担两件事：
 * 1. 写入本地权限 store（下一次 run 的初始模式）；
 * 2. 若该会话有活动主 run，经 `core_set_run_permission_mode` 更新活单元
 *    ——子代理 `PermissionCell` 经父链实时跟随，无需逐个广播。
 *
 * 无活动 run / 旧壳无该命令 → 静默忽略（权限 store 已落，下一次 run 生效）。
 */
import { invokeTyped } from './tauriInvoke';
import type { PermissionMode } from './permissionModes';

export async function syncRuntimePermissionMode(
  sessionId: string | null | undefined,
  mode: PermissionMode
): Promise<void> {
  if (!sessionId) return;
  try {
    await invokeTyped<null>('core_set_run_permission_mode', {
      sessionId,
      mode,
    });
  } catch {
    /* swallow-ok: 无活动 run 或旧壳未注册命令；下一次 run 使用本地 store */
  }
}
