/**
 * 笔记镜像 detect / import 提案 IPC 契约（A-INV-02 / W2-E 产品装配 · CONN-E）
 *
 * ## 命令
 * - wire：`note_detect_mirror_drift`（`NOTE_CMD_DETECT_MIRROR_DRIFT`）
 * - wire：`note_import_mirror_proposal`（`NOTE_CMD_IMPORT_MIRROR_PROPOSAL`）
 *
 * ## 与 UI 关系
 * - detect 成功 → 可映射为 `MirrorDriftReportView` 注入 `MirrorDriftStatusBar`
 * - 三路决策须先经 `resolveThreeWayAction`（X-05），再 `importMirrorProposal`
 * - **不** apply；`applied` 恒 false
 *
 * ## 诚实边界
 * - **≠ EL-03**；**≠ inotify 产品满关**
 * - **未做**：timer poll 与 OS watcher **双开** debounce（E3 仅 opt-in 单路调度）
 * - 空态默认 **不** 注入 report；须显式 detect / E3 调度 / mock 注入
 * - **CONN-E2 默认策略**：产品空态 **默认关** StatusBar（避免空态噪声）；
 *   仅 showMirrorDriftBar / mirrorDriftReport opt-in 才挂；detect/import 仍走本 IPC
 * - **CONN-E3**：`enableMirrorDetectSchedule` + mirrorIpc → `detectMirrorDrift` →
 *   report 喂 StatusBar；默认关时无 detect 定时器（见 mirrorDetectSchedule /
 *   useMirrorDetectProduct）
 */

import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';
import type {
  MirrorDriftClass,
  MirrorDriftReportView,
  ThreeWayStrategy,
} from '../components/note-paper/mirrorDriftUi';

// ---------------------------------------------------------------------------
// 命令名
// ---------------------------------------------------------------------------

/** Tauri：detect 镜像漂移（hash/mtime vs mirror_meta） */
export const NOTE_CMD_DETECT_MIRROR_DRIFT = 'note_detect_mirror_drift' as const;
/** Tauri：import 提案（Op 批或冲突；不 apply；X-05） */
export const NOTE_CMD_IMPORT_MIRROR_PROPOSAL =
  'note_import_mirror_proposal' as const;

// ---------------------------------------------------------------------------
// 请求 / 线格式
// ---------------------------------------------------------------------------

export type NoteDetectMirrorRequest = {
  docId: string;
  /** 权威 rev；缺省由后端 session / store 水位解析 */
  authorityRev?: number;
};

export type NoteImportMirrorRequest = {
  docId: string;
  /** 须由 resolveThreeWayAction 给出；禁止前端默认 silent drop */
  strategy: ThreeWayStrategy;
  unpushedOpCount?: number;
  authorityRev?: number;
  /** 默认 true：用 DocSession 树做块级 diff */
  useSessionTree?: boolean;
};

export type NoteMirrorReportFields = {
  docId: string;
  class: MirrorDriftClass;
  path?: string;
  lastExportRev?: number;
  authorityRev?: number;
  pendingLag?: number;
  mirrorChanged?: boolean;
  authorityChanged?: boolean;
  fileExists?: boolean;
  storedHash?: string;
  fileHash?: string | null;
};

export type NoteDetectMirrorSuccess = NoteMirrorReportFields & {
  ok: true;
  source: 'tauri-ipc';
};

export type NoteMirrorIpcFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteDetectMirrorOutcome =
  NoteDetectMirrorSuccess | NoteMirrorIpcFailure;

export type NoteImportMirrorKind = 'no_change' | 'op_batch' | 'conflict';

export type NoteImportMirrorSuccess = {
  ok: true;
  kind: NoteImportMirrorKind;
  report: NoteMirrorReportFields;
  /** 恒 false：本命令只提案 */
  applied: false;
  source: 'tauri-ipc';
  strategy?: ThreeWayStrategy;
  ops?: unknown[];
  opsCount?: number;
  sourceMdHash?: string;
  preservesUnpushed?: boolean;
  discardsUnpushed?: boolean;
  isBlockLevelDiff?: boolean;
  reason?: string;
  unpushedOpCount?: number;
  silentOverwriteBlocked?: boolean;
  suggestedStrategies?: ThreeWayStrategy[];
  conflictedBlocks?: Array<{ blockId: string; reason: string }>;
};

export type NoteImportMirrorOutcome =
  NoteImportMirrorSuccess | NoteMirrorIpcFailure;

/**
 * 可注入 mirror IPC 面（mock / Tauri）。
 * StatusBar 三路上层经 bridge 调用 import；detect 用于刷新 report。
 */
export type NoteMirrorIpc = {
  detectMirrorDrift(
    req: NoteDetectMirrorRequest
  ): Promise<NoteDetectMirrorOutcome>;
  importMirrorProposal(
    req: NoteImportMirrorRequest
  ): Promise<NoteImportMirrorOutcome>;
};

// ---------------------------------------------------------------------------
// snake_case 投影
// ---------------------------------------------------------------------------

export function detectMirrorReqToWire(
  req: NoteDetectMirrorRequest
): Record<string, unknown> {
  const wire: Record<string, unknown> = { doc_id: req.docId };
  if (req.authorityRev !== undefined) wire.authority_rev = req.authorityRev;
  return wire;
}

export function wrapDetectMirrorInvokeArgs(
  req: NoteDetectMirrorRequest
): Record<string, unknown> {
  return { req: detectMirrorReqToWire(req) };
}

export function importMirrorReqToWire(
  req: NoteImportMirrorRequest
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    doc_id: req.docId,
    strategy: req.strategy,
  };
  if (req.unpushedOpCount !== undefined) {
    wire.unpushed_op_count = req.unpushedOpCount;
  }
  if (req.authorityRev !== undefined) wire.authority_rev = req.authorityRev;
  if (req.useSessionTree !== undefined) {
    wire.use_session_tree = req.useSessionTree;
  }
  return wire;
}

export function wrapImportMirrorInvokeArgs(
  req: NoteImportMirrorRequest
): Record<string, unknown> {
  return { req: importMirrorReqToWire(req) };
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function coerceString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function coerceNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return fallback;
}

const DRIFT_CLASSES: ReadonlySet<string> = new Set([
  'none',
  'mirror_only',
  'authority_only',
  'both',
  'no_meta',
  'missing_file',
]);

function parseDriftClass(raw: unknown): MirrorDriftClass | null {
  const s = coerceString(raw);
  return DRIFT_CLASSES.has(s) ? (s as MirrorDriftClass) : null;
}

const STRATEGIES: ReadonlySet<string> = new Set([
  'retain_local_and_reimport',
  'drop_unacked',
  'conflict_blocks',
]);

function parseStrategy(raw: unknown): ThreeWayStrategy | undefined {
  const s = coerceString(raw);
  return STRATEGIES.has(s) ? (s as ThreeWayStrategy) : undefined;
}

function parseReportFields(
  rec: Record<string, unknown>
): NoteMirrorReportFields | null {
  const docId = coerceString(rec.docId ?? rec.doc_id);
  const cls = parseDriftClass(rec.class);
  if (!docId || !cls) return null;
  const path = coerceString(rec.path);
  const fileHashRaw = rec.fileHash ?? rec.file_hash;
  return {
    docId,
    class: cls,
    ...(path ? { path } : {}),
    lastExportRev: coerceNum(rec.lastExportRev ?? rec.last_export_rev, 0),
    authorityRev: coerceNum(rec.authorityRev ?? rec.authority_rev, 0),
    pendingLag: coerceNum(rec.pendingLag ?? rec.pending_lag, 0),
    mirrorChanged: rec.mirrorChanged === true || rec.mirror_changed === true,
    authorityChanged:
      rec.authorityChanged === true || rec.authority_changed === true,
    fileExists: rec.fileExists !== false && rec.file_exists !== false,
    storedHash: coerceString(rec.storedHash ?? rec.stored_hash) || undefined,
    fileHash:
      fileHashRaw === null || fileHashRaw === undefined
        ? null
        : coerceString(fileHashRaw) || null,
  };
}

/** detect 线格式 → 前端 outcome（成功 source 强制 tauri-ipc） */
export function parseDetectMirrorOutcome(
  raw: unknown
): NoteDetectMirrorOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'detect_mirror 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code) || 'note.detect_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'detect 失败',
    };
  }
  if (rec.ok !== true) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'detect_mirror 响应缺 ok 字段',
    };
  }
  const fields = parseReportFields(rec);
  if (!fields) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'detect 成功响应缺 doc_id / class',
    };
  }
  return { ok: true, source: 'tauri-ipc', ...fields };
}

/** import 线格式 → 前端 outcome */
export function parseImportMirrorOutcome(
  raw: unknown
): NoteImportMirrorOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'import_mirror 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code) || 'note.import_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'import 失败',
    };
  }
  if (rec.ok !== true) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'import_mirror 响应缺 ok 字段',
    };
  }

  const kindRaw = coerceString(rec.kind);
  const kind: NoteImportMirrorKind =
    kindRaw === 'op_batch' || kindRaw === 'conflict' || kindRaw === 'no_change'
      ? kindRaw
      : 'no_change';

  const reportRec = asRec(rec.report) ?? rec;
  const report = parseReportFields(reportRec);
  if (!report) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'import 成功响应缺 report.doc_id / class',
    };
  }

  const out: NoteImportMirrorSuccess = {
    ok: true,
    kind,
    report,
    applied: false,
    source: 'tauri-ipc',
  };

  const strategy = parseStrategy(rec.strategy);
  if (strategy) out.strategy = strategy;
  if (Array.isArray(rec.ops)) out.ops = rec.ops as unknown[];
  if (rec.opsCount !== undefined || rec.ops_count !== undefined) {
    out.opsCount = coerceNum(rec.opsCount ?? rec.ops_count, 0);
  }
  const hash = coerceString(rec.sourceMdHash ?? rec.source_md_hash);
  if (hash) out.sourceMdHash = hash;
  if (rec.preservesUnpushed === true || rec.preserves_unpushed === true) {
    out.preservesUnpushed = true;
  }
  if (rec.discardsUnpushed === true || rec.discards_unpushed === true) {
    out.discardsUnpushed = true;
  }
  if (rec.isBlockLevelDiff === true || rec.is_block_level_diff === true) {
    out.isBlockLevelDiff = true;
  }
  const reason = coerceString(rec.reason);
  if (reason) out.reason = reason;
  if (
    rec.unpushedOpCount !== undefined ||
    rec.unpushed_op_count !== undefined
  ) {
    out.unpushedOpCount = coerceNum(
      rec.unpushedOpCount ?? rec.unpushed_op_count,
      0
    );
  }
  if (
    rec.silentOverwriteBlocked === true ||
    rec.silent_overwrite_blocked === true
  ) {
    out.silentOverwriteBlocked = true;
  }
  const suggested = rec.suggestedStrategies ?? rec.suggested_strategies;
  if (Array.isArray(suggested)) {
    out.suggestedStrategies = suggested
      .map((s) => parseStrategy(s))
      .filter((s): s is ThreeWayStrategy => s != null);
  }
  const blocks = rec.conflictedBlocks ?? rec.conflicted_blocks;
  if (Array.isArray(blocks)) {
    out.conflictedBlocks = blocks
      .map((b) => {
        const br = asRec(b);
        if (!br) return null;
        const blockId = coerceString(br.blockId ?? br.block_id);
        if (!blockId) return null;
        return {
          blockId,
          reason: coerceString(br.reason),
        };
      })
      .filter((b): b is { blockId: string; reason: string } => b != null);
  }

  return out;
}

/** detect 成功 → UI `MirrorDriftReportView` */
export function detectSuccessToReportView(
  det: NoteDetectMirrorSuccess
): MirrorDriftReportView {
  return {
    docId: det.docId,
    class: det.class,
    path: det.path,
    lastExportRev: det.lastExportRev,
    authorityRev: det.authorityRev,
    pendingLag: det.pendingLag,
    mirrorChanged: det.mirrorChanged,
    authorityChanged: det.authorityChanged,
    fileExists: det.fileExists,
  };
}

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

// ---------------------------------------------------------------------------
// Mock IPC（契约测 / UI 串联）
// ---------------------------------------------------------------------------

export type MockMirrorDocState = {
  class?: MirrorDriftClass;
  path?: string;
  lastExportRev?: number;
  authorityRev?: number;
  pendingLag?: number;
  mirrorChanged?: boolean;
  authorityChanged?: boolean;
  fileExists?: boolean;
  /** import 时强制返回 conflict + silent_overwrite_blocked（测 X-05 透传） */
  forceSilentBlock?: boolean;
  /** import 无 unpushed 时返回 op_batch */
  opsCount?: number;
};

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

// ---------------------------------------------------------------------------
// Tauri IPC
// ---------------------------------------------------------------------------

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
