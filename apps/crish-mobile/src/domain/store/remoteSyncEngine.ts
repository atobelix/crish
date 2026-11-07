// 远程会话增量同步引擎（RemoteSyncEngine）
// 纪律：UTF-8 无 BOM、中文注释、非必要不兼容、杜绝打补丁。
// 核心职责：
// 1. 离线秒开（Offline First）：打开会话时从本地 SQLite 快速读取最新事件并水合至 eventStore，0 延迟首绘，离线/断网完全可用；
// 2. 差分续传（Incremental Catch-up）：根据本地 SQLite 记录的最大已同步 sequence，仅拉取落后的增量事件，杜绝从 0 开始的全量回放；
// 3. 实时流式批量落盘（Streaming Batch Persistence）：接收 events.push 时立即更新 Zustand 视图保证打字机 60fps 流畅，后台经防抖批量落入 SQLite；
// 4. 向上翻页（Backward Pagination）：向上滚动加载指定 sequence 之前的历史事件；
// 5. 游标对齐：为 events.subscribe 提供全量本地已知游标，实现精准差分订阅。

import { eventStore, lastSeqOf } from './eventStore';
import type { EventEnvelopeFrame } from './eventReducers';
import { extractEnvelope } from './eventMappers';
import type { RemoteEventDao, RemoteEventRow } from '@/db/dao/remoteEventDao';
import type { RemoteSessionDao } from '@/db/dao/remoteSessionDao';
import type { RemoteSyncDao } from '@/db/dao/remoteSyncDao';
import type { MonitorRepository } from '@/adapters/repositories/monitorRepository';
import type { WsGateway } from '@/network/WsGateway';
import { createLogger } from '@/adapters/platform/logger';

const log = createLogger('sync');

/** 异步防抖写缓冲池：将高频流式推送事件批量汇总事务落盘，避免阻塞 JS 渲染线程 */
export class AsyncEventWriteBuffer {
  private buffer: RemoteEventRow[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxIntervalMs: number;
  private readonly maxSize: number;
  private readonly eventDao: RemoteEventDao;
  private readonly syncDao: RemoteSyncDao;
  private isFlushing = false;

  constructor(
    eventDao: RemoteEventDao,
    syncDao: RemoteSyncDao,
    maxIntervalMs = 200,
    maxSize = 20
  ) {
    this.eventDao = eventDao;
    this.syncDao = syncDao;
    this.maxIntervalMs = maxIntervalMs;
    this.maxSize = maxSize;
  }

  /** 将一条待落盘事件推入缓冲 */
  push(row: RemoteEventRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.maxSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.maxIntervalMs);
    }
  }

  /** 强制立即清空缓冲并批量落入 SQLite 事务 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0 || this.isFlushing) return;
    this.isFlushing = true;
    const batch = [...this.buffer];
    this.buffer = [];

    try {
      await this.eventDao.insertEvents(batch);

      // 按 (deviceId, sessionId) 汇总计算当前批次的最大 sequence
      const maxSeqMap = new Map<
        string,
        { deviceId: string; sessionId: string; seq: number }
      >();
      for (const item of batch) {
        const key = `${item.deviceId}::${item.sessionId}`;
        const prev = maxSeqMap.get(key);
        if (!prev || item.sequence > prev.seq) {
          maxSeqMap.set(key, {
            deviceId: item.deviceId,
            sessionId: item.sessionId,
            seq: item.sequence,
          });
        }
      }

      // 更新已同步游标
      for (const { deviceId, sessionId, seq } of maxSeqMap.values()) {
        const current = await this.syncDao.getLastSyncedSequence(
          deviceId,
          sessionId
        );
        if (seq > current) {
          await this.syncDao.updateSyncState(deviceId, sessionId, seq);
        }
      }
    } catch (err) {
      log.warn('[RemoteSyncEngine] 异步批量落盘异常:', err);
    } finally {
      this.isFlushing = false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.flush();
  }
}

export interface RemoteSyncEngineOptions {
  eventDao: RemoteEventDao;
  sessionDao?: RemoteSessionDao;
  syncDao: RemoteSyncDao;
  monitor?: MonitorRepository;
  gateway?: WsGateway;
  ownerDeviceId?: string;
  batchFlushIntervalMs?: number;
  batchMaxBufferSize?: number;
}

/** 增量同步状态机与持久化引擎 */
export class RemoteSyncEngine {
  private readonly eventDao: RemoteEventDao;
  private readonly sessionDao?: RemoteSessionDao;
  private readonly syncDao: RemoteSyncDao;
  private monitor?: MonitorRepository;
  private gateway?: WsGateway;
  private ownerDeviceId?: string;
  private readonly writeBuffer: AsyncEventWriteBuffer;
  private readonly inflightCatchUp = new Set<string>();

  constructor(opts: RemoteSyncEngineOptions) {
    this.eventDao = opts.eventDao;
    this.sessionDao = opts.sessionDao;
    this.syncDao = opts.syncDao;
    this.monitor = opts.monitor;
    this.gateway = opts.gateway;
    this.ownerDeviceId = opts.ownerDeviceId;
    this.writeBuffer = new AsyncEventWriteBuffer(
      opts.eventDao,
      opts.syncDao,
      opts.batchFlushIntervalMs ?? 200,
      opts.batchMaxBufferSize ?? 20
    );
  }

  setMonitor(monitor?: MonitorRepository): void {
    this.monitor = monitor;
  }

  setGateway(gateway?: WsGateway): void {
    this.gateway = gateway;
  }

  getGateway(): WsGateway | undefined {
    return this.gateway;
  }

  getSessionDao(): RemoteSessionDao | undefined {
    return this.sessionDao;
  }

  /** 保存或更新远程会话元数据至本地 SQLite */
  async saveSessionSummary(
    row: Parameters<RemoteSessionDao['upsertSession']>[0]
  ): Promise<void> {
    if (this.sessionDao) {
      await this.sessionDao.upsertSession(row);
    }
  }

  setOwnerDeviceId(deviceId?: string): void {
    this.ownerDeviceId = deviceId;
  }

  getOwnerDeviceId(): string {
    return this.ownerDeviceId ?? 'default_device';
  }

  /**
   * 离线秒开水合（Zero-latency Instant Hydration）：
   * 打开会话瞬间从本地 SQLite 读取最新 N 条事件，立即水合进 eventStore。
   * 0 网络往返，离线/断网完全可用。
   */
  async hydrateSessionFromLocal(
    sessionId: string,
    deviceId?: string,
    limit = 100
  ): Promise<{ count: number; lastSeq: number }> {
    const targetDevice = deviceId ?? this.getOwnerDeviceId();
    const rows = await this.eventDao.getRecentEvents(
      targetDevice,
      sessionId,
      limit
    );
    if (rows.length === 0) {
      return { count: 0, lastSeq: 0 };
    }

    const frames: EventEnvelopeFrame[] = [];
    let maxSeq = 0;
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.rawPayload);
        const frame = extractEnvelope(parsed, sessionId);
        if (frame) {
          frames.push(frame);
          if (typeof frame.sequence === 'number' && frame.sequence > maxSeq) {
            maxSeq = frame.sequence;
          }
        }
      } catch (err) {
        log.warn('[RemoteSyncEngine] 解析本地事件 JSON 异常:', err);
      }
    }

    if (frames.length > 0) {
      eventStore
        .getState()
        .hydrate(sessionId, frames, maxSeq, undefined, targetDevice);
    }

    return { count: frames.length, lastSeq: maxSeq };
  }

  /**
   * 差分续传追平（Incremental Catch-up）：
   * 从本地 SQLite 读取最大游标，仅拉取落后的增量事件，批量入库并追加渲染。
   * 彻底杜绝从 sequence 0 的全量回放。
   */
  async catchUpSession(
    sessionId: string,
    deviceId?: string,
    maxPages = 6
  ): Promise<{ fetchedCount: number; lastSeq: number }> {
    if (this.inflightCatchUp.has(sessionId)) {
      return { fetchedCount: 0, lastSeq: lastSeqOf(sessionId) };
    }
    this.inflightCatchUp.add(sessionId);

    const targetDevice = deviceId ?? this.getOwnerDeviceId();
    try {
      // 1. 查找当前本地最大游标
      let after = await this.syncDao.getLastSyncedSequence(
        targetDevice,
        sessionId
      );
      if (after === 0) {
        after = await this.eventDao.getLatestSequence(targetDevice, sessionId);
      }
      if (after === 0) {
        after = lastSeqOf(sessionId);
      }

      if (!this.monitor) {
        return { fetchedCount: 0, lastSeq: after };
      }

      let totalFetched = 0;
      for (let page = 0; page < maxPages; page++) {
        const result = await this.monitor.readSessionEvents({
          sessionId,
          afterSequence: after,
          maxEvents: 200,
        });

        const frames = result.events
          .map((ev) => extractEnvelope(ev, sessionId))
          .filter((f): f is EventEnvelopeFrame => f !== null);

        if (frames.length > 0) {
          // 2. 立即更新视图驱动界面追加渲染
          eventStore
            .getState()
            .hydrate(
              sessionId,
              frames,
              result.nextAfterSequence,
              undefined,
              targetDevice
            );

          // 3. 批量持久化到本地 SQLite
          const rows: RemoteEventRow[] = frames.map((frame) => ({
            deviceId: targetDevice,
            sessionId,
            sequence: typeof frame.sequence === 'number' ? frame.sequence : 0,
            kind: 'agent-event',
            eventType: typeof frame.type === 'string' ? frame.type : 'unknown',
            receivedAtMs: Date.now(),
            rawPayload: JSON.stringify(frame),
          }));

          await this.eventDao.insertEvents(rows);
          await this.syncDao.updateSyncState(
            targetDevice,
            sessionId,
            result.nextAfterSequence,
            result.hasMore
          );
          totalFetched += frames.length;
        }

        if (!result.hasMore || result.nextAfterSequence <= after) {
          after = result.nextAfterSequence;
          break;
        }
        after = result.nextAfterSequence;
      }

      return { fetchedCount: totalFetched, lastSeq: after };
    } catch (err) {
      log.warn(`[RemoteSyncEngine] 差分续传失败（${sessionId}）:`, err);
      return { fetchedCount: 0, lastSeq: lastSeqOf(sessionId) };
    } finally {
      this.inflightCatchUp.delete(sessionId);
    }
  }

  /** 将事件记入异步批量落盘缓冲 */
  recordEvent(
    sessionId: string,
    frame: EventEnvelopeFrame,
    deviceId?: string,
    preview = false
  ): void {
    const targetDevice = deviceId ?? this.getOwnerDeviceId();
    const seq = typeof frame.sequence === 'number' ? frame.sequence : null;
    if (!preview && seq !== null) {
      this.writeBuffer.push({
        deviceId: targetDevice,
        sessionId,
        sequence: seq,
        kind: 'agent-event',
        eventType: typeof frame.type === 'string' ? frame.type : 'unknown',
        receivedAtMs: Date.now(),
        rawPayload: JSON.stringify(frame),
      });
    }
  }

  /**
   * 实时事件流式摄入（双轨执行）：
   * 内存轨：立即调用 eventStore.ingest 驱动 UI 60fps 流畅打字；
   * 存储轨：进入防抖批量缓冲池异步落盘至 SQLite。
   */
  ingestLiveEvent(
    sessionId: string,
    frame: EventEnvelopeFrame,
    deviceId?: string,
    preview = false
  ): void {
    const targetDevice = deviceId ?? this.getOwnerDeviceId();
    // 1. 内存轨（毫秒级响应）
    eventStore
      .getState()
      .ingest(sessionId, frame, preview, Date.now(), targetDevice);

    // 2. 存储轨
    this.recordEvent(sessionId, frame, targetDevice, preview);
  }

  /**
   * 向上滚动分页加载更早历史事件（Backward Pagination）：
   * 先从本地 SQLite 读取，若本地已读完且服务端仍有历史则按需向远端拉取。
   */
  async loadEarlierEvents(
    sessionId: string,
    beforeSequence: number,
    deviceId?: string,
    limit = 50
  ): Promise<{ events: EventEnvelopeFrame[]; hasMore: boolean }> {
    const targetDevice = deviceId ?? this.getOwnerDeviceId();
    const rows = await this.eventDao.getEventsBefore(
      targetDevice,
      sessionId,
      beforeSequence,
      limit
    );

    const frames: EventEnvelopeFrame[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.rawPayload);
        const frame = extractEnvelope(parsed, sessionId);
        if (frame) frames.push(frame);
      } catch (err) {
        log.warn('[RemoteSyncEngine] 解析历史事件 JSON 异常:', err);
      }
    }

    if (frames.length > 0) {
      eventStore
        .getState()
        .prependHistory(sessionId, frames, Date.now(), targetDevice);
    }

    const syncState = await this.syncDao.getSyncState(targetDevice, sessionId);
    const hasMore =
      rows.length >= limit || (syncState ? syncState.hasMoreHistory : false);

    return { events: frames, hasMore };
  }

  /** 获取指定设备全部会话的最新游标映射（供 events.subscribe 使用） */
  async getAllLatestSequences(
    deviceId?: string
  ): Promise<Record<string, number>> {
    const targetDevice = deviceId ?? this.getOwnerDeviceId();
    return this.syncDao.getAllLatestSequences(targetDevice);
  }

  /** 强制排空写缓冲落盘 */
  async flush(): Promise<void> {
    await this.writeBuffer.flush();
  }

  /** 销毁引擎（清空定时器并落盘） */
  dispose(): void {
    this.writeBuffer.dispose();
    this.inflightCatchUp.clear();
  }
}

// ── 全局默认单例管理 ──────────────────────────────────────────

let activeRemoteSyncEngine: RemoteSyncEngine | null = null;

export function getRemoteSyncEngine(): RemoteSyncEngine | null {
  return activeRemoteSyncEngine;
}

export function setRemoteSyncEngine(engine: RemoteSyncEngine | null): void {
  if (activeRemoteSyncEngine && activeRemoteSyncEngine !== engine) {
    activeRemoteSyncEngine.dispose();
  }
  activeRemoteSyncEngine = engine;
}
