/**
 * External conversation import — shared types.
 * Privacy: never log full message bodies; fixtures only use synthetic text.
 *
 * UI wiring (`ExternalSessionImport`) uses DetectedExternalSession + scan/import APIs.
 * Parsers use NormalizedImportTurn → mapToCrishSession / MappedImportSession.
 */

import type { SessionMessage } from '../../store/types';

/**
 * Supported external transcript sources (v1).
 * `'codex'` is the UI/store id; `'codex-cli'` accepted as alias in parsers.
 */
export type ExternalSessionSource = 'claude-code' | 'codex' | 'codex-cli';

/** Normalize aliases → canonical UI source. */
export function canonicalExternalSource(
  source: ExternalSessionSource,
): 'claude-code' | 'codex' {
  return source === 'claude-code' ? 'claude-code' : 'codex';
}

export function externalSourceLabel(source: ExternalSessionSource): string {
  return canonicalExternalSource(source) === 'claude-code'
    ? 'Claude Code'
    : 'Codex CLI';
}

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
  source: 'claude-code' | 'codex',
  sourceSessionId: string,
): string {
  return `${source}::${sourceSessionId}`;
}

// ---------------------------------------------------------------------------
// Path / FS / detect (parser pipeline)
// ---------------------------------------------------------------------------

/** Platform hints for default path resolution (injectable for tests). */
export type ImportPathEnv = {
  home?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  platform?: string;
  sep?: '\\' | '/';
};

export type ExternalImportRoots = {
  home: string;
  claudeConfig: string;
  claudeProjects: string;
  codexHome: string;
  codexSessions: string;
};

export type ImportDirEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  modified?: string | number;
  path: string;
};

export type ImportFs = {
  listDir: (dirPath: string, allowRoot: string) => Promise<ImportDirEntry[]>;
  readText: (
    filePath: string,
    allowRoot: string,
    opts?: { maxBytes?: number; maxLines?: number },
  ) => Promise<{ content: string; truncated: boolean; path: string }>;
  exists?: (path: string, allowRoot: string) => Promise<boolean>;
};

/** Metadata from detect (richer than DetectedExternalSession). */
export type ExternalSessionMeta = {
  source: 'claude-code' | 'codex';
  path: string;
  sourceSessionId: string;
  titlePreview: string;
  projectLabel?: string;
  cwd?: string;
  mtimeMs?: number;
  createdAtMs?: number;
  fileSize?: number;
  messageCountEstimate: number;
};

export type DetectExternalSessionsOptions = {
  fs: ImportFs;
  env?: ImportPathEnv;
  limit?: number;
  liteReadBytes?: number;
  sources?: Array<'claude-code' | 'codex'>;
  maxFileSizeBytes?: number;
};

export type DetectExternalSessionsResult = {
  roots: ExternalImportRoots;
  sessions: ExternalSessionMeta[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Parse → map
// ---------------------------------------------------------------------------

export type NormalizedImportTurn = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  timestampMs: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments?: string;
    output?: string;
    isError?: boolean;
    status?: 'success' | 'error' | 'running';
  }>;
};

export type ParsedExternalConversation = {
  source: 'claude-code' | 'codex';
  sourceSessionId: string;
  title?: string;
  cwd?: string;
  createdAtMs?: number;
  turns: NormalizedImportTurn[];
  warnings: string[];
  lineCount: number;
  skippedLineCount: number;
};

export type MapToCrishSessionOptions = {
  sourcePath: string;
  sessionId?: string;
  title?: string;
  folder?: string;
  nowMs?: number;
  idFactory?: () => string;
};

/** Full import payload (also convertible to MappedImportSession). */
export type ImportedCrishSession = {
  source: 'claude-code' | 'codex';
  sourcePath: string;
  sourceSessionId: string;
  sessionId: string;
  title: string;
  folder: string;
  timestamp: string;
  messages: SessionMessage[];
  createdAtMs?: number;
  warnings: string[];
};

/** Convert detect meta → UI DetectedExternalSession. */
export function metaToDetected(meta: ExternalSessionMeta): DetectedExternalSession {
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

/** Convert ImportedCrishSession → MappedImportSession for store write. */
export function toMappedImportSession(
  imported: ImportedCrishSession,
): MappedImportSession {
  return {
    source: imported.source,
    sourceId: imported.sourceSessionId,
    title: imported.title,
    folder: imported.folder,
    messages: imported.messages,
    ...(imported.sourcePath ? { path: imported.sourcePath } : {}),
  };
}
