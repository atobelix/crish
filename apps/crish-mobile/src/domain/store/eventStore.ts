// eventStore（M5 §3.1.1 领域层 store）：vanilla createStore + immer，零 React 依赖
// 纯逻辑在 eventReducers.ts（jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）
// 入站接口：ingest（events.push 事件帧）——网络接线（WsGateway 分发）由后续轮次消费本接口
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  appendFeed,
  advanceCursor,
  createWindow,
  hydrateFeed,
  readNumber,
  stableSortBySeq,
  type EventEnvelopeFrame,
  type EventWindow,
} from './eventReducers';
import { sourceAllowed } from './sessionStore';

/** 事件流域连接相位（F3 §3.2.1 连接状态机；由接线层投影） */
export type FeedNetwork = 'live' | 'reconnecting' | 'offline';

export interface EventState {
  /** 会话 → 事件窗口（M5 §3.1.1 streams；R2UX-05-09 窗口卸载 ≤4 活跃窗口由接线层调度） */
  windows: Record<string, EventWindow>;
  network: FeedNetwork;
  /**
   * 数据面属主设备盖章（M7 设备分区，与 sessionStore 同口径）：带
   * sourceDeviceId 的入站写入与盖章不符 → 直接丢弃（sourceAllowed），
   * 防旧接线在途帧在设备切换后落进新设备窗口。null = 未盖章不设防。
   */
  ownerDeviceId: string | null;
  /** 盖章不符被丢弃的写入计数（M7 诊断面） */
  droppedWriteCount: number;

  /** events.push 入站 ingest（preview 帧不推进游标，M6 §10.5；nowMs 注入便于测试） */
  ingest: (
    sessionId: string,
    frame: EventEnvelopeFrame,
    preview?: boolean,
    nowMs?: number,
    sourceDeviceId?: string
  ) => void;
  /**
   * 批量 ingest（R4 展示合帧单事务落店）：一次 set/通知按序落多条帧，
   * 逐帧 appendFeed 语义（去重/同 seq 覆盖/游标/环形裁剪）不变。
   * 仅接线层展示合帧缓冲使用；协议帧仍走逐帧 ingest。
   */
  ingestBatch: (
    sessionId: string,
    frames: readonly EventEnvelopeFrame[],
    preview: boolean,
    nowMs?: number,
    sourceDeviceId?: string
  ) => void;
  /** events.resume.page / C03 分页合并（快照重建 + 增量续接，M6 §4.1.3） */
  hydrate: (
    sessionId: string,
    events: readonly EventEnvelopeFrame[],
    cursor?: number,
    nowMs?: number,
    sourceDeviceId?: string
  ) => void;
  /** 向上翻页：将更早历史事件合并进窗口头部（自动按 sequence 升序排序与去重，不降低 lastSeq） */
  prependHistory: (
    sessionId: string,
    events: readonly EventEnvelopeFrame[],
    nowMs?: number,
    sourceDeviceId?: string
  ) => void;
  /** 游标对齐（events.resume.done resumedTo / subscribe.ok nextSequence）：只升不降 */
  setCursor: (sessionId: string, seq: number, sourceDeviceId?: string) => void;
  setNetwork: (network: FeedNetwork) => void;
  /** 窗口卸载（R2UX-05-09 内存预算：非活跃窗口卸载释放） */
  unloadWindow: (sessionId: string, sourceDeviceId?: string) => void;
  /** 属主盖章（runtime 接线建立/切换时调用；只改章，不动数据） */
  stampOwner: (deviceId: string | null) => void;
  /**
   * 快照恢复（CON-3）：同设备分区快照的事件窗口整表装入 live
   * （remoteData 编排专用；恢复的是已断开的存量，network 置 offline）。
   */
  restoreWindows: (windows: Record<string, EventWindow>) => void;
  /** 解绑 / 换机：清空全部窗口与连接相位（连带清盖章与丢弃计数） */
  reset: () => void;
}

function nowDefault(): number {
  return Date.now();
}

/** 惰性取窗口（不存在则建空窗口） */
function ensureWindow(state: EventState, sessionId: string): EventWindow {
  let window = state.windows[sessionId];
  if (!window) {
    window = createWindow();
    state.windows[sessionId] = window;
  }
  return window;
}

// 显式 StoreApi 标注：immer 中间件组合链的推断类型引用外部模块 draft 类型，
// 无法在导出声明中命名（TS4023/TS2883），公共面以 StoreApi<EventState> 收敛（approvalStore 同款）
export const eventStore: StoreApi<EventState> = createStore<EventState>()(
  immer((set) => ({
    windows: {},
    network: 'live',
    ownerDeviceId: null,
    droppedWriteCount: 0,

    ingest: (
      sessionId,
      frame,
      preview = false,
      nowMs = nowDefault(),
      sourceDeviceId
    ) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        appendFeed(ensureWindow(s, sessionId), frame, preview, nowMs);
      }),

    ingestBatch: (
      sessionId,
      frames,
      preview,
      nowMs = nowDefault(),
      sourceDeviceId
    ) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        if (frames.length === 0) return;
        const win = ensureWindow(s, sessionId);
        for (const frame of frames) {
          appendFeed(win, frame, preview, nowMs);
        }
      }),

    hydrate: (
      sessionId,
      events,
      cursor,
      nowMs = nowDefault(),
      sourceDeviceId
    ) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        hydrateFeed(ensureWindow(s, sessionId), events, cursor, nowMs);
      }),

    prependHistory: (sessionId, events, nowMs = nowDefault(), sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        const win = ensureWindow(s, sessionId);
        const existingSeqs = new Set(
          win.entries
            .map((e) => readNumber(e, 'sequence'))
            .filter((sq): sq is number => sq !== undefined)
        );
        for (const frame of events) {
          const sq = readNumber(frame, 'sequence');
          if (sq !== undefined && existingSeqs.has(sq)) continue;
          win.entries.push({ ...frame, receivedAtMs: nowMs });
        }
        win.entries = stableSortBySeq(win.entries);
      }),

    setCursor: (sessionId, seq, sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        advanceCursor(ensureWindow(s, sessionId), seq);
      }),

    setNetwork: (network) =>
      set((s) => {
        s.network = network;
      }),

    unloadWindow: (sessionId, sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        delete s.windows[sessionId];
      }),

    stampOwner: (deviceId) =>
      set((s) => {
        s.ownerDeviceId = deviceId;
      }),

    restoreWindows: (windows) =>
      set((s) => {
        s.windows = windows;
        s.network = 'offline';
      }),

    reset: () =>
      set((s) => {
        s.windows = {};
        s.network = 'offline';
        s.ownerDeviceId = null;
        s.droppedWriteCount = 0;
      }),
  }))
);

/** 游标选择器（resume 请求 lastSequences 数据面，M6 §9.3：会话 → 最后已确认序列） */
export function lastSeqOf(sessionId: string): number {
  return eventStore.getState().windows[sessionId]?.lastSeq ?? 0;
}

/** 窗口选择器（feed 渲染数据面；未建窗返回空窗口视图） */
export function windowOf(sessionId: string): EventWindow {
  return (
    eventStore.getState().windows[sessionId] ?? {
      entries: [],
      lastSeq: 0,
      truncatedCount: 0,
    }
  );
}
