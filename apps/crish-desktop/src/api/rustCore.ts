import { invokeCmd, invokeResult } from './tauriInvoke';
import {
  normalizeFileHits,
  QUICK_OPEN_RESULT_LIMIT,
  type QuickOpenHit,
} from './quickOpenHelpers';

/**
 * Rust Core API 桥接层
 * 所有调用通过 Tauri invoke 转发到 Rust Core 的 command handler
 */

// ===== Search API =====

export interface SearchRequest {
  query: string;
  limit?: number;
  searchType?: 'FilenameFuzzy' | 'TextRegex' | 'CodeSymbol';
  caseSensitive?: boolean;
}

export interface FileHit {
  path: string;
  score: number;
  matchIndices: number[];
}

export type { QuickOpenHit };

export type SearchFilesOutcome =
  | { status: 'ok'; hits: FileHit[] }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export async function searchFiles(request: SearchRequest): Promise<FileHit[]> {
  const outcome = await searchFilesDetailed(request);
  return outcome.status === 'ok' ? outcome.hits : [];
}

/** 结构化搜索：区分 ok / 命令缺失 / 错误（QuickOpen 诚实空态用） */
export async function searchFilesDetailed(
  request: SearchRequest,
): Promise<SearchFilesOutcome> {
  const limit = request.limit ?? QUICK_OPEN_RESULT_LIMIT;
  const res = await invokeResult<unknown>('core_search_files', {
    query: request.query,
    limit,
  });
  if (res.status === 'missing') return { status: 'missing' };
  if (res.status === 'error') return { status: 'error', message: res.message };
  return { status: 'ok', hits: normalizeFileHits(res.data, limit) };
}

/** Rebuild resident fuzzy index for a workspace root (gitignored walk). */
export async function rebuildSearchIndex(root: string): Promise<{ fileCount: number } | null> {
  const res = await invokeResult<{ fileCount?: number; file_count?: number }>(
    'core_rebuild_search_index',
    { root },
  );
  if (res.status !== 'ok' || !res.data) return null;
  const n = res.data.fileCount ?? res.data.file_count ?? 0;
  return { fileCount: typeof n === 'number' ? n : 0 };
}

// ===== Compaction API =====

export interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface CompactionResult {
  messages: Message[];
  tokensConsumed: number;
  cacheHitRateOptimized: boolean;
}

export async function compactMessages(
  messages: Message[],
  maxTokens: number
): Promise<CompactionResult> {
  const res = await invokeCmd<CompactionResult>('core_compact_messages', { messages, maxTokens });
  return res ?? { messages, tokensConsumed: 0, cacheHitRateOptimized: false };
}

export async function countTokens(text: string): Promise<number> {
  const count = await invokeCmd<number>('core_count_tokens', { text });
  return count ?? text.length;
}

// ===== Sandbox API =====

export type GatekeeperResult = 'Allowed' | 'NeedsConfirmation' | 'Blocked';

export async function checkCommand(
  cmd: string,
  args: string[]
): Promise<GatekeeperResult> {
  const res = await invokeCmd<GatekeeperResult>('core_check_command', { cmd, args });
  return res ?? 'Allowed';
}

// ===== Diff API =====

export interface DiffResult {
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'Context' | 'Addition' | 'Deletion';
  content: string;
}

export async function computeDiff(
  oldText: string,
  newText: string
): Promise<DiffResult> {
  const res = await invokeCmd<DiffResult>('core_compute_diff', { oldText, newText });
  return res ?? { hunks: [], addedLines: 0, removedLines: 0 };
}

// ===== Health API =====

export interface RustCoreStatus {
  searchIndexReady: boolean;
  dbReady: boolean;
  compactionReady: boolean;
}

/**
 * Core status from StatusHandler.
 * searchIndexReady is honest: true only when resident path count > 0.
 * Missing/failed invoke → null (callers must not invent ready=true).
 */
export async function getRustCoreStatus(): Promise<RustCoreStatus | null> {
  const res = await invokeResult<{
    searchIndexReady?: boolean;
    search_index_ready?: boolean;
    dbReady?: boolean;
    db_ready?: boolean;
    compactionReady?: boolean;
    compaction_ready?: boolean;
  }>('core_get_status', {});
  if (res.status !== 'ok' || !res.data) return null;
  const d = res.data;
  return {
    searchIndexReady: Boolean(d.searchIndexReady ?? d.search_index_ready),
    dbReady: Boolean(d.dbReady ?? d.db_ready),
    compactionReady: Boolean(d.compactionReady ?? d.compaction_ready),
  };
}
