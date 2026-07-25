/**
 * IndexedDB 底层读写与事务辅助
 */

import type { SessionMessage } from '../../store/layoutStore';
import { keyIndexManager, removeAsyncItem, setAsyncItem } from '../asyncStorage';
import { messagesToJsonl } from './sessionHydration';
import {
  SESSION_AGENTS_PREFIX,
  SESSION_BODY_PREFIX,
} from './sessionPersistenceTypes';

/**
 * 持久化游标：记录每个 session 已落盘的消息条数，用于支持增量追加。
 */
export const persistedMessageCounts = new Map<string, number>();

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

export async function saveSessionBodyAsync(
  sessionId: string,
  messages: SessionMessage[],
  serializedJsonl?: string | null
): Promise<void> {
  const id = asNonEmptyString(sessionId);
  if (!id) return;
  const msgs = messages || [];
  const key = SESSION_BODY_PREFIX + id;
  const content =
    serializedJsonl != null ? serializedJsonl : messagesToJsonl(msgs);
  await setAsyncItem(key, content);
  keyIndexManager.addKey(key);
  try {
    localStorage.setItem(key, content);
    persistedMessageCounts.set(id, msgs.length);
  } catch {
    /* quota */
  }
}

export async function cleanupOrphanSessionsAsync(
  activeIds: Set<string>
): Promise<void> {
  const allKeys = await keyIndexManager.getKeys();
  for (const k of allKeys) {
    if (k.startsWith(SESSION_BODY_PREFIX)) {
      const sessionId = k.slice(SESSION_BODY_PREFIX.length);
      if (!activeIds.has(sessionId)) {
        await removeAsyncItem(k);
        keyIndexManager.deleteKey(k);
        localStorage.removeItem(k);
      }
    } else if (k.startsWith(SESSION_AGENTS_PREFIX)) {
      const sessionId = k.slice(SESSION_AGENTS_PREFIX.length);
      if (!activeIds.has(sessionId)) {
        await removeAsyncItem(k);
        keyIndexManager.deleteKey(k);
        localStorage.removeItem(k);
      }
    }
  }
}
