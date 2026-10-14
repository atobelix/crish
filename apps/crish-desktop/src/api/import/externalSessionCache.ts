/**
 * 外部会话探测缓存与增量加载管理器。
 *
 * 核心优化：
 * 1. 本地存储持久化：打开软件或切换到扩展工作台时，0ms 从缓存瞬时渲染，绝不白屏打转；
 * 2. 避免重复全盘探测：记录上次扫描时间戳，防抖节流；
 * 3. 仅在用户显式点击「重新扫描」或缓存过期时触发底层 I/O。
 */

import type { DetectedExternalSession } from './types';
import { scanClaudeCodeSessions, scanCodexSessions } from './scan';

const CACHE_KEY = 'crish_external_sessions_cache_v1';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存有效期

interface CachePayload {
  timestamp: number;
  sessions: DetectedExternalSession[];
}

export function loadExternalSessionsFromCache(): DetectedExternalSession[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const payload: CachePayload = JSON.parse(raw);
    if (Array.isArray(payload?.sessions)) {
      return payload.sessions;
    }
  } catch {
    /* ignore json parse error */
  }
  return [];
}

export function saveExternalSessionsToCache(
  sessions: DetectedExternalSession[]
): void {
  try {
    const payload: CachePayload = {
      timestamp: Date.now(),
      sessions,
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota error */
  }
}

/**
 * 智能读取或按需扫描外部会话
 * @param forceRefresh 是否强制重新扫描
 */
export async function getOrScanExternalSessions(
  forceRefresh = false
): Promise<DetectedExternalSession[]> {
  const cached = loadExternalSessionsFromCache();

  // 若存在缓存且非强制刷新，检查是否在有效期内
  if (!forceRefresh && cached.length > 0) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const payload: CachePayload = JSON.parse(raw);
        if (Date.now() - payload.timestamp < CACHE_TTL_MS) {
          return cached;
        }
      }
    } catch {
      return cached;
    }
  }

  // 执行真实探测
  const [claudeSessions, codexSessions] = await Promise.all([
    scanClaudeCodeSessions().catch(() => [] as DetectedExternalSession[]),
    scanCodexSessions().catch(() => [] as DetectedExternalSession[]),
  ]);

  const merged = [...claudeSessions, ...codexSessions];
  saveExternalSessionsToCache(merged);
  return merged;
}
