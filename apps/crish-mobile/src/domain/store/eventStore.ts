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
  type EventEnvelopeFrame,
  type EventWindow,
} from './eventReducers';

/** 事件流域连接相位（F3 §3.2.1 连接状态机；由接线层投影） */
export type FeedNetwork = 'live' | 'reconnecting' | 'offline';

export interface EventState {
  /** 会话 → 事件窗口（M5 §3.1.1 streams；R2UX-05-09 窗口卸载 ≤4 活跃窗口由接线层调度） */
  windows: Record<string, EventWindow>;
  network: FeedNetwork;

  /** events.push 入站 ingest（preview 帧不推进游标，M6 §10.5；nowMs 注入便于测试） */
  ingest: (
    sessionId: string,
    frame: EventEnvelopeFrame,
    preview?: boolean,
    nowMs?: number
  ) => void;
  /** events.resume.page / C03 分页合并（快照重建 + 增量续接，M6 §4.1.3） */
  hydrate: (
    sessionId: string,
    events: readonly EventEnvelopeFrame[],
    cursor?: number,
    nowMs?: number
  ) => void;
  /** 游标对齐（events.resume.done resumedTo / subscribe.ok nextSequence）：只升不降 */
  setCursor: (sessionId: string, seq: number) => void;
  setNetwork: (network: FeedNetwork) => void;
  /** 窗口卸载（R2UX-05-09 内存预算：非活跃窗口卸载释放） */
  unloadWindow: (sessionId: string) => void;
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

    ingest: (sessionId, frame, preview = false, nowMs = nowDefault()) =>
      set((s) => {
        appendFeed(ensureWindow(s, sessionId), frame, preview, nowMs);
      }),

    hydrate: (sessionId, events, cursor, nowMs = nowDefault()) =>
      set((s) => {
        hydrateFeed(ensureWindow(s, sessionId), events, cursor, nowMs);
      }),

    setCursor: (sessionId, seq) =>
      set((s) => {
        advanceCursor(ensureWindow(s, sessionId), seq);
      }),

    setNetwork: (network) =>
      set((s) => {
        s.network = network;
      }),

    unloadWindow: (sessionId) =>
      set((s) => {
        delete s.windows[sessionId];
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
