/**
 * 笔记镜像 detect / import 线格式解析（SD-33 · parse）
 *
 * 成功 source 强制 `tauri-ipc`。**≠ EL-03**；解析可测 ≠ inotify 满关。
 */
import type {
  MirrorDriftClass,
  MirrorDriftReportView,
  ThreeWayStrategy,
} from '../components/note-paper/mirrorDriftUi';
import type {
  NoteDetectMirrorOutcome,
  NoteDetectMirrorSuccess,
  NoteImportMirrorKind,
  NoteImportMirrorOutcome,
  NoteImportMirrorSuccess,
  NoteMirrorReportFields,
} from './noteMirrorIpc.types';

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
