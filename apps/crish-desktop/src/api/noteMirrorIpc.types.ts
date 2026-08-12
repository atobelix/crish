/**
 * 笔记镜像 detect / import IPC 类型（SD-33 · types）
 *
 * **≠ EL-03**；**≠ inotify 产品满关**；切开 ≠ 重做 E2′ / E3。
 */
import type {
  MirrorDriftClass,
  ThreeWayStrategy,
} from '../components/note-paper/mirrorDriftUi';

/** Tauri：detect 镜像漂移（hash/mtime vs mirror_meta） */
export const NOTE_CMD_DETECT_MIRROR_DRIFT = 'note_detect_mirror_drift' as const;
/** Tauri：import 提案（Op 批或冲突；不 apply；X-05） */
export const NOTE_CMD_IMPORT_MIRROR_PROPOSAL =
  'note_import_mirror_proposal' as const;

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
