/**
 * SessionSyncService —— 会话双向同步服务
 *
 * 职责：
 * - 本地变更入 SyncQueue 定期 flush 到引擎
 * - 引擎变更增量拉取到本地
 * - SyncQueue 使用 IndexedDB 持久化（断网/崩溃不丢失）
 * - 冲突解决（按数据类型选择策略）
 * - 通过 eventBus 广播同步状态变更
 *
 * 同步策略：
 * - Push：每 5s 或积压 10 条批量 POST；指数退避重试最多 5 次
 * - Pull：正常 5min，刚重连后 10s 内连续 3 次
 * - 冲突：消息内容/UI 状态本地优先；AI 回复/tool output/消息状态引擎优先；元数据 LWW
 */

import { eventBus } from './EventBus';

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface SyncQueueItem {
  id: string;
  sessionId: string;
  operation: 'create' | 'update' | 'delete' | 'add-message' | 'update-status';
  payload: any;
  localVersion: number;
  createdAt: number;
  retryCount: number;
  status: 'pending' | 'in-flight' | 'confirmed' | 'conflict' | 'failed';
}

export interface SyncStatusEvent {
  isSyncing: boolean;
  pendingCount: number;
  lastSyncAt: number | null;
  error?: string;
}

export type ConflictFieldType =
  | 'message-content'
  | 'ai-reply'
  | 'tool-output'
  | 'session-metadata'
  | 'message-status'
  | 'ui-state';

export interface ConflictInfo {
  itemId: string;
  sessionId: string;
  fieldType: ConflictFieldType;
  local: any;
  remote: any;
  resolved: any;
  strategy: 'local-first' | 'engine-first' | 'lww';
}

export type SyncStrategy = 'local-first' | 'engine-first' | 'lww';

const STORE_NAME = 'session-sync-queue';
const DB_NAME = 'crish-sync';
const DB_VERSION = 1;

const PUSH_INTERVAL_MS = 5_000;
const PUSH_BATCH_SIZE = 10;
const MAX_RETRY = 5;
const RETRY_BASE_MS = 1_000;
const PULL_NORMAL_INTERVAL_MS = 300_000;
const PULL_RECONNECT_INTERVAL_MS = 10_000;
const PULL_RECONNECT_BURST = 3;

const SYNC_STATUS_EVENT = 'sync:status:changed';
const SYNC_CONFLICT_EVENT = 'sync:conflict:detected';
const SYNC_ERROR_EVENT = 'sync:error';

/* ============================================================
 * IndexedDB 封装
 * ============================================================ */

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbWrite<T>(table: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite');
    tx.objectStore(table).put(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbDelete(table: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readwrite');
    tx.objectStore(table).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbReadAll<T>(table: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly');
    const req = tx.objectStore(table).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbReadByIndex<T>(
  table: string,
  indexName: string,
  value: string,
): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly');
    const req = tx.objectStore(table).index(indexName).getAll(value);
    req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbCountByIndex(
  table: string,
  indexName: string,
  value: string,
): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly');
    const req = tx.objectStore(table).index(indexName).count(value);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/* ============================================================
 * 冲突解决策略
 * ============================================================ */

function getConflictStrategy(fieldType: ConflictFieldType): SyncStrategy {
  switch (fieldType) {
    case 'message-content':
    case 'ui-state':
      return 'local-first';
    case 'ai-reply':
    case 'tool-output':
    case 'message-status':
      return 'engine-first';
    case 'session-metadata':
      return 'lww';
  }
}

function resolveByStrategy(
  local: any,
  remote: any,
  localVersion: number,
  remoteVersion: number,
  strategy: SyncStrategy,
): any {
  switch (strategy) {
    case 'local-first':
      return local;
    case 'engine-first':
      return remote;
    case 'lww':
      return localVersion >= remoteVersion ? local : remote;
  }
}

/* ============================================================
 * daemon 通信助手（轻量封装，不引入 daemonClient 全部依赖）
 * ============================================================ */

async function daemonRequest(
  type: string,
  payload: Record<string, unknown>,
  expectedResponse: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const { getDesktopDaemonClient } = await import('../api/daemonClient');
  const client = getDesktopDaemonClient();
  if (!client.isConnected()) {
    const ok = await client.waitUntilConnected(8_000);
    if (!ok) throw new Error('Daemon not connected');
  }
  return (await client.request(
    { type, ...payload },
    expectedResponse,
    timeoutMs,
  )) as Record<string, unknown>;
}

/* ============================================================
 * SessionSyncService
 * ============================================================ */

export class SessionSyncService {
  private static instance: SessionSyncService;

  private queue: SyncQueueItem[] = [];
  private loaded = false;
  private syncing = false;
  private lastSyncAt: number | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectPullCount = 0;
  private engineCursor: number = 0;

  private constructor() {
    // 私有构造，使用 getInstance
  }

  /** 获取单例 */
  static getInstance(): SessionSyncService {
    if (!SessionSyncService.instance) {
      SessionSyncService.instance = new SessionSyncService();
    }
    return SessionSyncService.instance;
  }

  /* ---------- 初始化 ---------- */

  /** 启动同步服务（应用启动时调用一次） */
  async init(): Promise<void> {
    if (this.loaded) return;
    await this.loadQueue();
    this.loaded = true;
    this.engineCursor = this.loadCursor();
    this.schedulePush();
    this.schedulePull(false);
    this.listenConnection();
  }

  /* ---------- 公开 API ---------- */

  enqueue(
    sessionId: string,
    operation: SyncQueueItem['operation'],
    payload: any,
  ): void {
    const item: SyncQueueItem = {
      id: crypto.randomUUID(),
      sessionId,
      operation,
      payload,
      localVersion: Date.now(),
      createdAt: Date.now(),
      retryCount: 0,
      status: 'pending',
    };
    this.queue.push(item);
    void dbWrite(STORE_NAME, item).catch((err) =>
      console.error('[SessionSync] dbWrite enqueue failed:', err),
    );
    this.emitStatus();
    // 积压达到阈值立即触发 push
    if (this.getPendingItems().length >= PUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  async pullFromEngine(): Promise<number> {
    try {
      const res = await daemonRequest('sync-pull', {
        since: this.engineCursor,
        limit: 50,
      }, 'sync-pulled');
      const changes = (res.changes ?? []) as Record<string, unknown>[];
      const cursor = res.cursor as number | undefined;
      if (cursor != null && cursor > this.engineCursor) {
        this.engineCursor = cursor;
        this.saveCursor();
      }
      if (changes.length > 0) {
        await this.applyRemoteChanges(changes);
      }
      this.lastSyncAt = Date.now();
      this.emitStatus();
      return changes.length;
    } catch (err) {
      console.error('[SessionSync] pullFromEngine failed:', err);
      eventBus.emit(SYNC_ERROR_EVENT, {
        operation: 'pull',
        error: String(err),
      }, 'daemon');
      return 0;
    }
  }

  async fullSync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.emitStatus();
    try {
      await this.flush();
      await this.pullFromEngine();
    } finally {
      this.syncing = false;
      this.emitStatus();
    }
  }

  async triggerSync(): Promise<void> {
    return this.fullSync();
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  getPendingCount(): number {
    return this.getPendingItems().length;
  }

  resolveConflict(local: any, remote: any): any {
    // 默认 LWW 策略
    return resolveByStrategy(local, remote, Date.now(), Date.now(), 'lww');
  }

  /** 已确认的变更从队列移除 */
  async confirmItem(id: string): Promise<void> {
    const idx = this.queue.findIndex((i) => i.id === id);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
    await dbDelete(STORE_NAME, id).catch(() => {});
    this.emitStatus();
  }

  /** 销毁服务（清理定时器） */
  destroy(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearTimeout(this.pullTimer);
    this.queue = [];
    this.loaded = false;
  }

  /* ---------- 内部：队列管理 ---------- */

  private getPendingItems(): SyncQueueItem[] {
    return this.queue.filter(
      (i) => i.status === 'pending' && i.retryCount < MAX_RETRY,
    );
  }

  private async loadQueue(): Promise<void> {
    try {
      this.queue = await dbReadAll<SyncQueueItem>(STORE_NAME);
    } catch (err) {
      console.error('[SessionSync] load queue failed:', err);
      this.queue = [];
    }
  }

  private saveCursor(): void {
    try {
      localStorage.setItem('crish_sync_cursor', String(this.engineCursor));
    } catch {
      /* ignore */
    }
  }

  private loadCursor(): number {
    try {
      const v = localStorage.getItem('crish_sync_cursor');
      return v ? Number(v) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /* ---------- 内部：Push ---------- */

  private async flush(): Promise<void> {
    const pending = this.getPendingItems();
    if (pending.length === 0) return;
    if (this.syncing) return;

    this.syncing = true;
    this.emitStatus();

    // 标记为 in-flight
    for (const item of pending) {
      item.status = 'in-flight';
      void dbWrite(STORE_NAME, item).catch(() => {});
    }

    try {
      const res = await daemonRequest('sync-push', {
        batch: pending.map(({ id, sessionId, operation, payload, localVersion }) => ({
          id,
          sessionId,
          operation,
          payload,
          localVersion,
        })),
      }, 'sync-pushed');

      const confirmed = (res.confirmed ?? []) as string[];
      const conflicts = (res.conflicts ?? []) as Record<string, unknown>[];

      // 处理确认项
      for (const id of confirmed) {
        await this.confirmItem(id);
      }

      // 处理冲突项
      for (const conflict of conflicts) {
        await this.handleConflict(conflict);
      }
    } catch (err) {
      console.error('[SessionSync] flush failed:', err);
      // 重试计数 + 退避
      for (const item of pending) {
        item.retryCount += 1;
        if (item.retryCount >= MAX_RETRY) {
          item.status = 'failed';
        } else {
          item.status = 'pending';
        }
        void dbWrite(STORE_NAME, item).catch(() => {});
      }
      eventBus.emit(SYNC_ERROR_EVENT, {
        operation: 'push',
        error: String(err),
      }, 'daemon');
    } finally {
      this.syncing = false;
      this.emitStatus();
    }
  }

  /* ---------- 内部：Pull ---------- */

  private async applyRemoteChanges(
    changes: Record<string, unknown>[],
  ): Promise<void> {
    const { mergeDaemonSessions, isOfflineOrEmptyRemote } = await import(
      '../api/sessionDaemonSync'
    );
    const { useLayoutStore } = await import('../store/layoutStore');

    // 分组：会话元数据变更 vs 消息变更
    const metaChanges: Record<string, unknown>[] = [];
    const messageChanges: Record<string, unknown>[] = [];

    for (const c of changes) {
      const op = c.operation as string;
      if (op === 'add-message' || op === 'update-status') {
        messageChanges.push(c);
      } else {
        metaChanges.push(c);
      }
    }

    // 处理消息级变更（引擎优先）
    if (messageChanges.length > 0) {
      const store = useLayoutStore.getState();
      const sessions = store.sessions ?? [];
      let modified = false;

      for (const change of messageChanges) {
        const sessionId = change.sessionId as string;
        const sid = (sessionId ?? '').trim();
        if (!sid) continue;

        const idx = sessions.findIndex(
          (s) => s.id.trim().toLowerCase() === sid.toLowerCase(),
        );
        if (idx === -1) continue;

        const session = sessions[idx]!;
        const op = change.operation as string;

        if (op === 'add-message') {
          const msg = change.message as Record<string, unknown>;
          if (!msg || !msg.id) continue;
          // 引擎优先：如果本地已有同 id 消息则覆盖内容
          const existingIdx = session.messages.findIndex(
            (m: any) => m.id && String(m.id) === String(msg.id),
          );
          if (existingIdx !== -1) {
            // 引擎优先 — 覆盖本地（AI 回复/tool output 以引擎为准）
            sessions[idx] = {
              ...session,
              messages: [
                ...session.messages.slice(0, existingIdx),
                { ...session.messages[existingIdx]!, ...msg } as any,
                ...session.messages.slice(existingIdx + 1),
              ],
            };
          } else {
            // 新消息追加
            sessions[idx] = {
              ...session,
              messages: [...session.messages, msg as any],
            };
          }
          modified = true;
        } else if (op === 'update-status') {
          const msgId = change.messageId as string;
          const status = change.status as any;
          if (!msgId) continue;
          const msgIdx = session.messages.findIndex(
            (m: any) => m.id && String(m.id) === String(msgId),
          );
          if (msgIdx !== -1) {
            sessions[idx] = {
              ...session,
              messages: [
                ...session.messages.slice(0, msgIdx),
                { ...session.messages[msgIdx]!, status },
                ...session.messages.slice(msgIdx + 1),
              ],
            };
            modified = true;
          }
        }
      }

      if (modified) {
        useLayoutStore.setState({ sessions });
      }
    }

    // 处理会话元数据变更（走 mergeDaemonSessions LWW）
    if (metaChanges.length > 0) {
      const store = useLayoutStore.getState();
      const remoteList = metaChanges
        .filter((c) => c.sessionId)
        .map((c) => ({
          id: c.sessionId as string,
          title: (c.title as string) ?? '',
          updatedAt: (c.updatedAt as string | number) ?? Date.now(),
          cwd: (c.cwd as string) ?? '',
        }));
      if (!isOfflineOrEmptyRemote(remoteList)) {
        const merged = mergeDaemonSessions(store.sessions ?? [], remoteList);
        if (merged !== store.sessions) {
          useLayoutStore.setState({ sessions: merged });
        }
      }
    }
  }

  /* ---------- 冲突处理 ---------- */

  private async handleConflict(
    conflict: Record<string, unknown>,
  ): Promise<void> {
    const itemId = conflict.itemId as string;
    const sessionId = conflict.sessionId as string;
    const localPayload = conflict.localPayload;
    const remotePayload = conflict.remotePayload;
    const fieldType = (conflict.fieldType as ConflictFieldType) ?? 'session-metadata';

    const strategy = getConflictStrategy(fieldType);
    const localVersion =
      this.queue.find((i) => i.id === itemId)?.localVersion ?? 0;
    const remoteVersion = (conflict.remoteVersion as number) ?? 0;

    const resolved = resolveByStrategy(
      localPayload,
      remotePayload,
      localVersion,
      remoteVersion,
      strategy,
    );

    const info: ConflictInfo = {
      itemId,
      sessionId,
      fieldType,
      local: localPayload,
      remote: remotePayload,
      resolved,
      strategy,
    };

    eventBus.emit(SYNC_CONFLICT_EVENT, info, 'daemon');

    // 如果引擎胜出，丢弃本地 pending 项
    if (strategy === 'engine-first' || strategy === 'lww') {
      if (itemId) {
        await this.confirmItem(itemId);
      }
    }
  }

  /* ---------- 定时器调度 ---------- */

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flush();
      this.schedulePush();
    }, PUSH_INTERVAL_MS);
  }

  private schedulePull(isReconnect: boolean): void {
    if (this.pullTimer) clearTimeout(this.pullTimer);

    const delay = isReconnect
      ? PULL_RECONNECT_INTERVAL_MS
      : PULL_NORMAL_INTERVAL_MS;

    this.pullTimer = setTimeout(() => {
      this.pullTimer = null;
      void this.pullFromEngine().then(() => {
        // 重连后爆发式拉取：10s 间隔连续 3 次
        if (isReconnect && this.reconnectPullCount < PULL_RECONNECT_BURST) {
          this.reconnectPullCount += 1;
          this.schedulePull(true);
        } else {
          this.reconnectPullCount = 0;
          this.schedulePull(false);
        }
      });
    }, delay);
  }

  /* ---------- 连接状态监听 ---------- */

  private listenConnection(): void {
    import('../api/daemonClient').then(({ getDesktopDaemonClient }) => {
      const client = getDesktopDaemonClient();
      client.onState((state) => {
        if (state === 'connected') {
          // 重连后：立即全量同步 + 爆发式增量拉取
          this.reconnectPullCount = 0;
          void this.fullSync().then(() => {
            this.schedulePull(true);
          });
        } else if (state === 'disconnected' || state === 'failed') {
          // 断连时暂停 pull，保留 push 等待恢复
          if (this.pullTimer) {
            clearTimeout(this.pullTimer);
            this.pullTimer = null;
          }
        }
      });
    });
  }

  /* ---------- 状态广播 ---------- */

  private emitStatus(): void {
    const evt: SyncStatusEvent = {
      isSyncing: this.syncing,
      pendingCount: this.getPendingCount(),
      lastSyncAt: this.lastSyncAt,
    };
    eventBus.emit(SYNC_STATUS_EVENT, evt, 'daemon');
  }
}

/** 全局单例 */
export const sessionSyncService = SessionSyncService.getInstance();
