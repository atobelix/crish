/**
 * Lightweight per-token stream buffer (plain zustand, NO immer).
 *
 * key = `${sessionId}::${messageId}`
 *
 * ## 定位（T4 单一投影 store 固化 · analysis/16 §①）
 *
 * 本 store 是「设计内必需桥」的**热缓冲（中间态）**，不是持久投影的第二真相源：
 * - 热缓冲（本文件）：每 token 流式增量帧（text/thinking/tools/images），
 *   Delta 可丢；流式期间存在，`commitStreamToSession` 收口后由
 *   `queueMicrotask clearStream` 时序闭环清空（helpers.ts 注释：严禁同步
 *   clearStream，杜绝组件切换瞬间白屏闪烁）；
 * - 持久投影（终态落点）：layoutStore/sessionStore.messages，run 收口后才写终态。
 * 渲染 view model 由页面壳层装配（useStreamMessageViewModel：订阅本缓冲 +
 * applyStream* 纯函数合并），复合组件不直连本缓冲。
 */

import { create } from 'zustand';
import type {
  MessageToolCall,
  MessageToolCallStatus,
  MessageImageRef,
} from './types';

/** Live tool row patch held only while status is intermediate (usually running). */
export type StreamToolLive = {
  id: string;
  name?: string;
  arguments?: string;
  explanation?: string;
  status?: MessageToolCallStatus;
  output?: string;
  startedAt?: number;
  approvalMeta?: MessageToolCall['approvalMeta'];
  images?: MessageImageRef[];
};

export type StreamEntry = {
  sessionId: string;
  messageId: string;
  text: string;
  thinking?: string;
  tools?: Record<string, StreamToolLive>;
  images?: MessageImageRef[];
};

export type StreamingState = {
  byKey: Record<string, StreamEntry>;
  setStreamText: (sessionId: string, messageId: string, text: string) => void;
  setStreamThinking: (
    sessionId: string,
    messageId: string,
    thinking: string
  ) => void;
  setStreamTool: (
    sessionId: string,
    messageId: string,
    toolId: string,
    patch: StreamToolLive
  ) => void;
  setStreamImages: (
    sessionId: string,
    messageId: string,
    images: MessageImageRef[]
  ) => void;
  updateStreamImage: (
    sessionId: string,
    messageId: string,
    imageId: string,
    patch: Partial<MessageImageRef>
  ) => void;
  clearStreamTool: (
    sessionId: string,
    messageId: string,
    toolId: string
  ) => void;
  clearStreamTools: (sessionId: string, messageId: string) => void;
  clearStream: (sessionId: string, messageId: string) => void;
  clearStreams: (sessionId: string, messageIds: string[]) => void;
  clearSession: (sessionId: string) => void;
  getStreamText: (sessionId: string, messageId: string) => string | undefined;
  getStreamThinking: (
    sessionId: string,
    messageId: string
  ) => string | undefined;
  getStreamTools: (
    sessionId: string,
    messageId: string
  ) => Record<string, StreamToolLive> | undefined;
  getStreamTool: (
    sessionId: string,
    messageId: string,
    toolId: string
  ) => StreamToolLive | undefined;
  getStreamImages: (
    sessionId: string,
    messageId: string
  ) => MessageImageRef[] | undefined;
  getStreamEntry: (
    sessionId: string,
    messageId: string
  ) => StreamEntry | undefined;
};

/** Same shape as streamBatchKey / design contract. */
export function streamStoreKey(sessionId: string, messageId: string): string {
  return `${sessionId}::${messageId}`;
}

function preserveRest(
  prev: StreamEntry | undefined
): Pick<StreamEntry, 'thinking' | 'tools' | 'images'> {
  const out: Pick<StreamEntry, 'thinking' | 'tools' | 'images'> = {};
  if (prev?.thinking !== undefined) out.thinking = prev.thinking;
  if (prev?.tools) out.tools = prev.tools;
  if (prev?.images) out.images = prev.images;
  return out;
}

function toolLiveEqual(a: StreamToolLive, b: StreamToolLive): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.arguments === b.arguments &&
    a.explanation === b.explanation &&
    a.status === b.status &&
    a.output === b.output &&
    a.startedAt === b.startedAt &&
    a.approvalMeta === b.approvalMeta &&
    a.images === b.images
  );
}

export const useStreamingStore = create<StreamingState>((set, get) => ({
  byKey: Object.create(null) as Record<string, StreamEntry>,

  setStreamText: (sessionId, messageId, text) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    if (prev?.text === text) return;
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: { sessionId, messageId, text, ...preserveRest(prev) },
      },
    }));
  },

  setStreamThinking: (sessionId, messageId, thinking) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    if (prev?.thinking === thinking) return;
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: {
          sessionId,
          messageId,
          text: prev?.text ?? '',
          thinking,
          ...(prev?.tools ? { tools: prev.tools } : {}),
          ...(prev?.images ? { images: prev.images } : {}),
        },
      },
    }));
  },

  setStreamTool: (sessionId, messageId, toolId, patch) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    const prevTool = prev?.tools?.[toolId];
    const nextTool: StreamToolLive = prevTool
      ? { ...prevTool, ...patch, id: toolId }
      : { ...patch, id: toolId };
    if (prevTool && toolLiveEqual(prevTool, nextTool)) return;
    const tools = {
      ...(prev?.tools || Object.create(null)),
      [toolId]: nextTool,
    };
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: {
          sessionId,
          messageId,
          text: prev?.text ?? '',
          ...(prev?.thinking !== undefined ? { thinking: prev.thinking } : {}),
          ...(prev?.images ? { images: prev.images } : {}),
          tools,
        },
      },
    }));
  },

  setStreamImages: (sessionId, messageId, images) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    if (prev?.images === images) return;
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: {
          sessionId,
          messageId,
          text: prev?.text ?? '',
          ...(prev?.thinking !== undefined ? { thinking: prev.thinking } : {}),
          ...(prev?.tools ? { tools: prev.tools } : {}),
          images,
        },
      },
    }));
  },

  updateStreamImage: (sessionId, messageId, imageId, patch) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    if (!prev?.images) return;
    const idx = prev.images.findIndex((img) => img.id === imageId);
    if (idx === -1) return;
    const prevImg = prev.images[idx]!;
    const nextImg: MessageImageRef = { ...prevImg, ...patch };
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof MessageImageRef>) {
      if (nextImg[k] !== prevImg[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const images = prev.images.slice();
    images[idx] = nextImg;
    set((state) => {
      const cur = state.byKey[key];
      if (!cur?.images || cur.images !== prev.images) return state;
      return { byKey: { ...state.byKey, [key]: { ...cur, images } } };
    });
  },

  clearStreamTool: (sessionId, messageId, toolId) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    if (!prev?.tools || !(toolId in prev.tools)) return;
    set((state) => {
      const cur = state.byKey[key];
      if (!cur?.tools || !(toolId in cur.tools)) return state;
      const tools = { ...cur.tools };
      delete tools[toolId];
      const hasTools = Object.keys(tools).length > 0;
      return {
        byKey: {
          ...state.byKey,
          [key]: { ...cur, ...(hasTools ? { tools } : { tools: undefined }) },
        },
      };
    });
  },

  clearStreamTools: (sessionId, messageId) => {
    const key = streamStoreKey(sessionId, messageId);
    const prev = get().byKey[key];
    if (!prev?.tools) return;
    set((state) => {
      const cur = state.byKey[key];
      if (!cur?.tools) return state;
      const { tools: _drop, ...rest } = cur;
      return { byKey: { ...state.byKey, [key]: rest } };
    });
  },

  clearStream: (sessionId, messageId) => {
    const key = streamStoreKey(sessionId, messageId);
    if (!(key in get().byKey)) return;
    set((state) => {
      if (!(key in state.byKey)) return state;
      const next = { ...state.byKey };
      delete next[key];
      return { byKey: next };
    });
  },

  clearStreams: (sessionId, messageIds) => {
    if (!messageIds || messageIds.length === 0) return;
    const targetKeys = new Set(
      messageIds.map((mid) => streamStoreKey(sessionId, mid))
    );
    set((state) => {
      let changed = false;
      const next: Record<string, StreamEntry> = Object.create(null);
      for (const [k, v] of Object.entries(state.byKey)) {
        if (targetKeys.has(k)) {
          changed = true;
          continue;
        }
        next[k] = v;
      }
      return changed ? { byKey: next } : state;
    });
  },

  clearSession: (sessionId) => {
    const prefix = `${sessionId}::`;
    set((state) => {
      let changed = false;
      const next: Record<string, StreamEntry> = Object.create(null);
      for (const [k, v] of Object.entries(state.byKey)) {
        if (k.startsWith(prefix)) {
          changed = true;
          continue;
        }
        next[k] = v;
      }
      return changed ? { byKey: next } : state;
    });
  },

  getStreamText: (sessionId, messageId) =>
    get().byKey[streamStoreKey(sessionId, messageId)]?.text,
  getStreamThinking: (sessionId, messageId) =>
    get().byKey[streamStoreKey(sessionId, messageId)]?.thinking,
  getStreamTools: (sessionId, messageId) =>
    get().byKey[streamStoreKey(sessionId, messageId)]?.tools,
  getStreamTool: (sessionId, messageId, toolId) =>
    get().byKey[streamStoreKey(sessionId, messageId)]?.tools?.[toolId],
  getStreamImages: (sessionId, messageId) =>
    get().byKey[streamStoreKey(sessionId, messageId)]?.images,
  getStreamEntry: (sessionId, messageId) =>
    get().byKey[streamStoreKey(sessionId, messageId)],
}));

// ── 命令式辅助函数（callbacks / batchers；无 React）─────────────────
// 从 streamingStoreHelpers.ts 拆出（T4-11 基线清零），hub 保留 re-export，
// 消费方 import 路径不变。
export {
  setStreamText,
  setStreamThinking,
  setStreamTool,
  clearStreamTool,
  clearStreamTools,
  clearStream,
  clearStreams,
  clearSessionStreams,
  getStreamText,
  getStreamThinking,
  getStreamTools,
  getStreamTool,
  getStreamEntry,
} from './streamingStoreHelpers';


