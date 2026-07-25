/**
 * asyncStorage.ts — 异步 IndexedDB 存储层适配器
 *
 * 【重构目标】
 * 替换全库 270+ 处同步 localStorage 磁盘 I/O 阻塞调用。
 * localStorage 读写属于 Chromium 的同步跨进程 IPC，触发 SQLite WAL 刷新，
 * 在大 Key（如会话历史 JSONL）写入时会阻塞 UI 主线程 10ms ~ 200ms，
 * 导致流式 AI 输出时出现 Long Task 卡顿、掉帧和输入延迟。
 *
 * 新实现使用 idb-keyval（封装 IndexedDB）异步写入：
 *   - 写操作完全不阻塞主线程
 *   - 存储容量从 5MB 提升至 > 100MB（IndexedDB 限额）
 *   - 内存 Set 缓存 key 索引，消除 O(N) localStorage.length 扫描
 *
 * @module asyncStorage
 */

import { get, set, del, keys, createStore, type UseStore } from 'idb-keyval';

// ── IDB 实例（与 localStorage 完全隔离） ────────────────────────────────────

const SESSION_STORE: UseStore = createStore('conex-sessions-db', 'sessions');
const CONFIG_STORE: UseStore = createStore('conex-config-db', 'config');

// ── 内存 Key 索引管理（消除 O(N) IDB/localStorage 全量扫表） ──────────────

class KeyIndexManager {
  private sessionKeys: Set<string> | null = null;
  private configKeys: Set<string> | null = null;

  private async loadSessionKeys(): Promise<Set<string>> {
    if (this.sessionKeys !== null) return this.sessionKeys;
    try {
      const allKeys = await keys(SESSION_STORE);
      this.sessionKeys = new Set(allKeys.map(String));
    } catch {
      this.sessionKeys = new Set();
    }
    return this.sessionKeys;
  }

  private async loadConfigKeys(): Promise<Set<string>> {
    if (this.configKeys !== null) return this.configKeys;
    try {
      const allKeys = await keys(CONFIG_STORE);
      this.configKeys = new Set(allKeys.map(String));
    } catch {
      this.configKeys = new Set();
    }
    return this.configKeys;
  }

  async getSessionKeys(): Promise<Set<string>> {
    return this.loadSessionKeys();
  }

  async getConfigKeys(): Promise<Set<string>> {
    return this.loadConfigKeys();
  }

  addKey(key: string): void {
    this.addSessionKey(key);
    this.addConfigKey(key);
  }

  deleteKey(key: string): void {
    this.removeSessionKey(key);
    this.removeConfigKey(key);
  }

  async getKeys(): Promise<Set<string>> {
    const sessionSet = await this.getSessionKeys();
    const configSet = await this.getConfigKeys();
    return new Set([...sessionSet, ...configSet]);
  }

  addSessionKey(key: string): void {
    this.sessionKeys?.add(key);
  }

  removeSessionKey(key: string): void {
    this.sessionKeys?.delete(key);
  }

  addConfigKey(key: string): void {
    this.configKeys?.add(key);
  }

  removeConfigKey(key: string): void {
    this.configKeys?.delete(key);
  }
}

export const keyIndex = new KeyIndexManager();

// ── 会话数据异步读写 API ────────────────────────────────────────────────────

/** 异步写入会话数据（替代 localStorage.setItem(BODY_PREFIX + id, ...) 的同步阻塞） */
export async function setSessionItem<T>(key: string, value: T): Promise<void> {
  try {
    await set(key, value, SESSION_STORE);
    keyIndex.addSessionKey(key);
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[asyncStorage] Failed to write session key:', key, err);
    }
  }
}

/** 异步读取会话数据（非阻塞） */
export async function getSessionItem<T>(key: string, fallback: T): Promise<T> {
  try {
    const val = await get<T>(key, SESSION_STORE);
    return val !== undefined ? val : fallback;
  } catch {
    return fallback;
  }
}

/** 异步删除会话数据 */
export async function removeSessionItem(key: string): Promise<void> {
  try {
    await del(key, SESSION_STORE);
    keyIndex.removeSessionKey(key);
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[asyncStorage] Failed to delete session key:', key, err);
    }
  }
}

// ── 配置数据异步读写 API ────────────────────────────────────────────────────

/** 异步写入配置数据 */
export async function setConfigItem<T>(key: string, value: T): Promise<void> {
  try {
    await set(key, value, CONFIG_STORE);
    keyIndex.addConfigKey(key);
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[asyncStorage] Failed to write config key:', key, err);
    }
  }
}

/** 异步读取配置数据 */
export async function getConfigItem<T>(key: string, fallback: T): Promise<T> {
  try {
    const val = await get<T>(key, CONFIG_STORE);
    return val !== undefined ? val : fallback;
  } catch {
    return fallback;
  }
}

/** 异步删除配置数据 */
export async function removeConfigItem(key: string): Promise<void> {
  try {
    await del(key, CONFIG_STORE);
    keyIndex.removeConfigKey(key);
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[asyncStorage] Failed to delete config key:', key, err);
    }
  }
}

// ── 孤儿会话清理（使用内存 Key 索引，消除 O(N) localStorage.length 扫表） ─

/**
 * 清理不再活跃的会话存储数据
 * 使用内存 Set 索引代替 O(N) localStorage.key(i) 轮询，
 * 避免 Chromium 同步跨进程 IPC 索引定位。
 */
export async function cleanupOrphanSessions(activeIds: Set<string>, keyPrefix: string): Promise<void> {
  const allKeys = await keyIndex.getSessionKeys();
  const deletePromises: Promise<void>[] = [];

  for (const k of allKeys) {
    if (k.startsWith(keyPrefix)) {
      const sessionId = k.slice(keyPrefix.length);
      if (!activeIds.has(sessionId)) {
        deletePromises.push(removeSessionItem(k));
      }
    }
  }

  await Promise.allSettled(deletePromises);
}

// ── 兼容性别名 ──────────────────────────────────────────────────────────────
export const getAsyncItem = getSessionItem;
export const setAsyncItem = setSessionItem;
export const removeAsyncItem = removeSessionItem;
export const keyIndexManager = keyIndex;
