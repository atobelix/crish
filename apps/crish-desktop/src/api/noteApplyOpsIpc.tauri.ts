/**
 * Tauri `note_apply_ops` IPC 工厂（SD-34 切开 · tauri）
 *
 * 命令缺失 / 业务失败 → ok:false，不抛。**≠ EL-01 / EL-08**。
 */

import { invokeTyped } from './tauriInvoke';
import {
  NOTE_CMD_APPLY_OPS,
  type NoteApplyOpsIpc,
} from './noteApplyOpsIpc.types';
import {
  mapApplyOpsInvokeFailure,
  parseApplyOpsIpcOutcome,
  wrapApplyOpsInvokeArgs,
} from './noteApplyOpsIpc.wire';

/**
 * 经 `invokeTyped` 调 workbench `note_apply_ops`。
 */
export function createTauriNoteApplyOpsIpc(): NoteApplyOpsIpc {
  return {
    async applyOps(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_APPLY_OPS,
        wrapApplyOpsInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapApplyOpsInvokeFailure(res, NOTE_CMD_APPLY_OPS);
      }
      return parseApplyOpsIpcOutcome(res.data);
    },
  };
}
