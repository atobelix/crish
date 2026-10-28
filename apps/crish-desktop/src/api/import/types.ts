/**
 * External conversation import — shared types.
 * Privacy: never log full message bodies; fixtures only use synthetic text.
 *
 * 载荷中立化（E3）：解析/映射载荷（NormalizedImportTurn / ParsedExternalConversation /
 * SessionImportPayload 等）与探测层类型（ImportFs / ImportPathEnv 等）全部来自
 * 官方插件包 @crish/plugin-import-claude-codex（不依赖 store/types）；
 * 本文件只保留宿主侧类型（UI 行 / store 写路径）与适配函数。
 */

import type { SessionMessage } from '../../store/types';
import type {
  ExternalSessionMeta,
  ExternalSessionSource,
  SessionImportPayload,
} from '@crish/plugin-import-claude-codex';

export type {
  ExternalSessionSource,
  ExternalImportRoots,
  ImportPathEnv,
  ImportDirEntry,
  ImportFs,
} from '@crish/plugin-import-claude-codex';

export type ExternalSessionScanIssue = {
  source: ExternalSessionSource;
  kind: 'warning' | 'error';
  message: string;
};

export type ExternalSessionSourceScan = {
  source: ExternalSessionSource;
  sessions: DetectedExternalSession[];
  issues: ExternalSessionScanIssue[];
};

export type ExternalSessionScanBatch = {
  sessions: DetectedExternalSession[];
  issues: ExternalSessionScanIssue[];
};

// ---------------------------------------------------------------------------
// UI / store write path (scan → select → importDetectedSessions)
// ---------------------------------------------------------------------------

/** Row shown in Import UI after scan. */
export type DetectedExternalSession = {
  id: string;
  source: 'claude-code' | 'codex';
  title: string;
  messageCount: number;
  project?: string;
  path?: string;
  updatedAt?: number;
  /** Optional cwd for folder mapping. */
  cwd?: string;
  /** File size bytes when known. */
  fileSize?: number;
};

/** Mapped session ready for createSession + addMessage. */
export type MappedImportSession = {
  source: 'claude-code' | 'codex';
  sourceId: string;
  title: string;
  folder?: string;
  messages: SessionMessage[];
  path?: string;
};

/**
 * 导入结果。
 * - skippedDuplicates：同一 source+sourceSessionId 已存在 → 软跳过
 * - skipped：含 map 失败 / 写失败 / 重复跳过
 */
export type ImportSessionsResult = {
  imported: number;
  skipped: number;
  /** 因 source+sourceSessionId 已存在而跳过的条数 */
  skippedDuplicates: number;
  errors: string[];
  sessionIds: string[];
};

/** 软去重策略：默认 skip（不覆盖已导入会话） */
export type ImportDuplicatePolicy = 'skip' | 'reimport';

/** 稳定去重键：source + sourceSessionId */
export function makeExternalImportKey(
  source: ExternalSessionSource | string,
  sourceSessionId: string
): string {
  return `${source}::${sourceSessionId}`;
}

/** Convert detect meta → UI DetectedExternalSession. */
export function metaToDetected(
  meta: ExternalSessionMeta
): DetectedExternalSession {
  return {
    id: meta.sourceSessionId,
    source: meta.source,
    title: meta.titlePreview,
    messageCount: meta.messageCountEstimate,
    ...(meta.projectLabel != null ? { project: meta.projectLabel } : {}),
    ...(meta.path != null ? { path: meta.path } : {}),
    ...(meta.mtimeMs != null
      ? { updatedAt: meta.mtimeMs }
      : meta.createdAtMs != null
        ? { updatedAt: meta.createdAtMs }
        : {}),
    ...(meta.cwd != null ? { cwd: meta.cwd } : {}),
    ...(meta.fileSize != null ? { fileSize: meta.fileSize } : {}),
  };
}

/** Convert SessionImportPayload + 适配后的消息 → MappedImportSession for store write. */
export function toMappedImportSession(
  imported: SessionImportPayload,
  messages: SessionMessage[]
): MappedImportSession {
  return {
    source: imported.source,
    sourceId: imported.sourceSessionId,
    title: imported.title,
    folder: imported.folder,
    messages,
    ...(imported.sourcePath ? { path: imported.sourcePath } : {}),
  };
}
