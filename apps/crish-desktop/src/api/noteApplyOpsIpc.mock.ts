/**
 * 进程内 mock apply_ops IPC（SD-34 切开 · mock）
 *
 * **仅** 契约测 / 显式注入；**禁止** 无 Tauri 时静默当生产默认。
 * **≠ EL-01**；**≠ EL-08**。
 */

import type {
  NoteApplyOpsIpc,
  NoteApplyOpsRequest,
} from './noteApplyOpsIpc.types';

export type MockNoteApplyOpsIpc = NoteApplyOpsIpc & {
  clear(): void;
  setNextError(err: { code: string; reason: string } | null): void;
  /** 记录的 apply 调用（wireCalls 串联测） */
  calls: NoteApplyOpsRequest[];
  /** 模拟 rev 水位（每次成功 +applied） */
  revByDoc: Map<string, number>;
};

/**
 * 形状与 Tauri 成功/失败一致。
 * **禁止** 无 Tauri 时静默当生产默认（resolve 无注入 → source=none）。
 */
export function createMockNoteApplyOpsIpc(): MockNoteApplyOpsIpc {
  const calls: NoteApplyOpsRequest[] = [];
  const revByDoc = new Map<string, number>();
  let nextError: { code: string; reason: string } | null = null;

  return {
    calls,
    revByDoc,
    clear() {
      calls.length = 0;
      revByDoc.clear();
      nextError = null;
    },
    setNextError(err) {
      nextError = err;
    },
    async applyOps(req) {
      calls.push(req);
      if (nextError) {
        const err = nextError;
        nextError = null;
        return { ok: false, code: err.code, reason: err.reason };
      }
      const docId = req.docId?.trim() ?? '';
      if (!docId) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: 'doc_id must be non-empty',
        };
      }
      if (!req.opsJson?.trim()) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: 'ops_json must be non-empty',
        };
      }
      // 粗计 applied：解析数组长度；非法 JSON → invalid
      let applied = 0;
      try {
        const parsed: unknown = JSON.parse(req.opsJson);
        if (!Array.isArray(parsed)) {
          return {
            ok: false,
            code: 'note.invalid',
            reason: 'ops_json must be a JSON array',
          };
        }
        applied = parsed.length;
      } catch (e) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: `ops_json parse: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const prev = revByDoc.get(docId) ?? 0;
      const rev = applied > 0 ? prev + 1 : prev;
      revByDoc.set(docId, rev);
      return {
        ok: true,
        docId,
        rev,
        applied,
        source: 'tauri-ipc',
        ...(req.intentId?.trim() ? { intentId: req.intentId.trim() } : {}),
      };
    },
  };
}
