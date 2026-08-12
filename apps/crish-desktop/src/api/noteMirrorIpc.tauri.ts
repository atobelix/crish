/**
 * Tauri note_detect_mirror_drift / note_import_mirror_proposal（SD-33 · tauri）
 *
 * **≠ EL-03**；**≠ inotify 产品满关**；命令缺失 → 结构化失败，不抛半态。
 */
import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';
import {
  NOTE_CMD_DETECT_MIRROR_DRIFT,
  NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
  type NoteMirrorIpc,
  type NoteMirrorIpcFailure,
} from './noteMirrorIpc.types';
import {
  parseDetectMirrorOutcome,
  parseImportMirrorOutcome,
} from './noteMirrorIpc.parse';
import {
  wrapDetectMirrorInvokeArgs,
  wrapImportMirrorInvokeArgs,
} from './noteMirrorIpc.wire';

function mapInvokeFailure(
  res: Extract<InvokeTypedResult<unknown>, { status: 'missing' | 'error' }>,
  cmd: string
): NoteMirrorIpcFailure {
  if (res.status === 'missing') {
    return {
      ok: false,
      code: 'note.command_missing',
      reason: `笔记 mirror 命令不可用（${cmd} 未注册 / 非 Tauri）`,
    };
  }
  return {
    ok: false,
    code: res.kind || 'note.invoke_error',
    reason: res.message || `invoke ${cmd} 失败`,
  };
}

/** 经 `invokeTyped` 调 workbench mirror detect/import。 */
export function createTauriNoteMirrorIpc(): NoteMirrorIpc {
  return {
    async detectMirrorDrift(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_DETECT_MIRROR_DRIFT,
        wrapDetectMirrorInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_DETECT_MIRROR_DRIFT);
      }
      return parseDetectMirrorOutcome(res.data);
    },
    async importMirrorProposal(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
        wrapImportMirrorInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_IMPORT_MIRROR_PROPOSAL);
      }
      return parseImportMirrorOutcome(res.data);
    },
  };
}
