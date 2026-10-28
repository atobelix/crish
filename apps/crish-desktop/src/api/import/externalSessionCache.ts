/**
 * 外部会话探测缓存与增量加载管理器。
 *
 * 缓存只保存完整扫描结果，并绑定扫描时配置的自定义根目录。并发扫描时，
 * 仅最新请求可以更新缓存；扫描中根目录变化时会按新配置重试。
 */

import type {
  DetectedExternalSession,
  ExternalSessionScanBatch,
} from './types';
import {
  combineExternalSessionScans,
  scanClaudeCodeSessions,
  scanCodexSessions,
} from './scan';
import {
  getPersistedImportRoots,
  type PersistedImportRoots,
} from './importRootSettings';
import { safeSetJson } from '../localStorageApi';

const CACHE_KEY = 'crish_external_sessions_cache_v1';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存有效期

interface CachePayload {
  timestamp: number;
  rootsFingerprint: string;
  sessions: DetectedExternalSession[];
}

let latestScanRequestId = 0;

function rootsFingerprint(roots: PersistedImportRoots): string {
  return JSON.stringify([roots.claudeConfigDir ?? '', roots.codexHome ?? '']);
}

function currentRootsFingerprint(): string {
  return rootsFingerprint(getPersistedImportRoots());
}

function isCacheFresh(payload: CachePayload, now = Date.now()): boolean {
  const ageMs = now - payload.timestamp;
  return ageMs >= 0 && ageMs < CACHE_TTL_MS;
}

function readCachePayload(): CachePayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as Partial<CachePayload>;
    if (
      typeof payload.timestamp !== 'number' ||
      !Number.isFinite(payload.timestamp) ||
      typeof payload.rootsFingerprint !== 'string' ||
      !Array.isArray(payload.sessions)
    ) {
      return null;
    }
    return payload as CachePayload;
  } catch {
    return null;
  }
}

function invalidateCacheForRoots(fingerprint: string): void {
  try {
    const payload = readCachePayload();
    if (payload?.rootsFingerprint === fingerprint) {
      localStorage.removeItem(CACHE_KEY);
    }
  } catch {
    /* ignore unavailable storage */
  }
}

export function loadExternalSessionsFromCache(): ExternalSessionScanBatch {
  const payload = readCachePayload();
  if (
    !payload ||
    payload.rootsFingerprint !== currentRootsFingerprint() ||
    !isCacheFresh(payload)
  ) {
    return { sessions: [], issues: [] };
  }
  return { sessions: payload.sessions, issues: [] };
}

export function saveExternalSessionsToCache(
  sessions: DetectedExternalSession[]
): void {
  try {
    const payload: CachePayload = {
      timestamp: Date.now(),
      rootsFingerprint: currentRootsFingerprint(),
      sessions,
    };
    safeSetJson(CACHE_KEY, payload);
  } catch {
    /* quota / private mode */
  }
}

/**
 * 智能读取或按需扫描外部会话。
 * @param forceRefresh 是否强制重新扫描
 */
export async function getOrScanExternalSessions(
  forceRefresh = false
): Promise<ExternalSessionScanBatch> {
  const requestId = ++latestScanRequestId;
  const roots = getPersistedImportRoots();
  const requestRootsFingerprint = rootsFingerprint(roots);
  const cached = readCachePayload();

  if (
    !forceRefresh &&
    cached &&
    cached.rootsFingerprint === requestRootsFingerprint &&
    isCacheFresh(cached)
  ) {
    return { sessions: cached.sessions, issues: [] };
  }

  const [claudeScan, codexScan] = await Promise.all([
    scanClaudeCodeSessions({ persistedRoots: roots }),
    scanCodexSessions({ persistedRoots: roots }),
  ]);
  const result = combineExternalSessionScans([claudeScan, codexScan]);
  const rootsUnchanged = requestRootsFingerprint === currentRootsFingerprint();

  if (requestId === latestScanRequestId && !rootsUnchanged) {
    // 配置在扫描期间改变时丢弃混合根目录的结果，并按当前配置重新扫描。
    return getOrScanExternalSessions(true);
  }

  if (
    requestId === latestScanRequestId &&
    rootsUnchanged &&
    result.issues.length === 0
  ) {
    saveExternalSessionsToCache(result.sessions);
  } else if (
    requestId === latestScanRequestId &&
    rootsUnchanged &&
    result.issues.length > 0
  ) {
    invalidateCacheForRoots(requestRootsFingerprint);
  }
  return result;
}
