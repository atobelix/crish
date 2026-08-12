/**
 * 进程内 mock mirror IPC（SD-33 · mock）
 *
 * 形状与 Tauri 成功/失败一致。**禁止** 假关 EL-03；**不**模拟 poll timer 双开。
 * **≠** 重做 E2′ / E3；X-05：unpushed>0 且非 drop_unacked → conflict blocked。
 */
import type {
  MockMirrorDocState,
  NoteDetectMirrorRequest,
  NoteImportMirrorRequest,
  NoteMirrorIpc,
  NoteMirrorReportFields,
} from './noteMirrorIpc.types';

/**
 * 进程内 mock mirror IPC：形状与 Tauri 成功/失败一致。
 * **禁止** 假关 EL-03；**不**模拟 poll timer 双开。
 */
export function createMockNoteMirrorIpc(
  docs: Record<string, MockMirrorDocState> = {}
): NoteMirrorIpc & {
  seed(docId: string, state: MockMirrorDocState): void;
  clear(): void;
  setNextError(err: { code: string; reason: string } | null): void;
  /** 记录的 import 调用（串联测） */
  importCalls: NoteImportMirrorRequest[];
  detectCalls: NoteDetectMirrorRequest[];
} {
  const store = new Map<string, MockMirrorDocState>();
  for (const [id, s] of Object.entries(docs)) store.set(id, s);
  let nextError: { code: string; reason: string } | null = null;
  const importCalls: NoteImportMirrorRequest[] = [];
  const detectCalls: NoteDetectMirrorRequest[] = [];

  return {
    importCalls,
    detectCalls,
    seed(docId, state) {
      store.set(docId, state);
    },
    clear() {
      store.clear();
      nextError = null;
      importCalls.length = 0;
      detectCalls.length = 0;
    },
    setNextError(err) {
      nextError = err;
    },
    async detectMirrorDrift(req) {
      detectCalls.push(req);
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
      const st = store.get(docId) ?? { class: 'no_meta' as const };
      const cls = st.class ?? 'no_meta';
      return {
        ok: true,
        source: 'tauri-ipc',
        docId,
        class: cls,
        path: st.path,
        lastExportRev: st.lastExportRev ?? 0,
        authorityRev: req.authorityRev ?? st.authorityRev ?? 0,
        pendingLag: st.pendingLag ?? 0,
        mirrorChanged:
          st.mirrorChanged ??
          (cls === 'mirror_only' || cls === 'both' || cls === 'missing_file'),
        authorityChanged:
          st.authorityChanged ?? (cls === 'authority_only' || cls === 'both'),
        fileExists: st.fileExists ?? cls !== 'missing_file',
      };
    },
    async importMirrorProposal(req) {
      importCalls.push(req);
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
      const st = store.get(docId) ?? { class: 'mirror_only' as const };
      const unpushed = Math.max(0, req.unpushedOpCount ?? 0);
      const report: NoteMirrorReportFields = {
        docId,
        class: st.class ?? 'mirror_only',
        path: st.path,
        lastExportRev: st.lastExportRev ?? 1,
        authorityRev: req.authorityRev ?? st.authorityRev ?? 1,
        pendingLag: st.pendingLag ?? 0,
        mirrorChanged: true,
        authorityChanged: false,
        fileExists: st.fileExists ?? true,
      };

      // 镜像 X-05：unpushed>0 且非 drop_unacked → conflict blocked
      if (
        st.forceSilentBlock ||
        (unpushed > 0 && req.strategy !== 'drop_unacked')
      ) {
        return {
          ok: true,
          kind: 'conflict',
          report,
          applied: false,
          source: 'tauri-ipc',
          reason: `存在 ${unpushed} 条 unpushed op；拒绝静默覆盖`,
          unpushedOpCount: unpushed,
          silentOverwriteBlocked: true,
          suggestedStrategies: [
            'drop_unacked',
            'conflict_blocks',
            'retain_local_and_reimport',
          ],
          conflictedBlocks: [],
        };
      }

      if (req.strategy === 'conflict_blocks') {
        return {
          ok: true,
          kind: 'conflict',
          report,
          applied: false,
          source: 'tauri-ipc',
          reason: '策略 ConflictBlocks：标记冲突，不自动 apply',
          unpushedOpCount: unpushed,
          silentOverwriteBlocked: unpushed > 0,
          suggestedStrategies: ['drop_unacked', 'retain_local_and_reimport'],
          conflictedBlocks: [],
        };
      }

      const cls = st.class ?? 'mirror_only';
      if (cls === 'none' || cls === 'authority_only' || cls === 'no_meta') {
        return {
          ok: true,
          kind: 'no_change',
          report: { ...report, class: cls },
          applied: false,
          source: 'tauri-ipc',
        };
      }

      return {
        ok: true,
        kind: 'op_batch',
        report,
        applied: false,
        source: 'tauri-ipc',
        strategy: req.strategy,
        ops: [],
        opsCount: st.opsCount ?? 1,
        preservesUnpushed: req.strategy === 'retain_local_and_reimport',
        discardsUnpushed: req.strategy === 'drop_unacked' && unpushed > 0,
        isBlockLevelDiff: true,
      };
    },
  };
}
