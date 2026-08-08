/**
 * Lightweight per-token stream buffer (plain zustand, NO immer).
 *
 * Active assistant text/thinking and intermediate tool progress land here
 * during SSE frames so the session store (immer → messages array new ref →
 * ChatCard re-render) is not touched on every token / dense tool tick.
 * Durable text + final tool results commit once on stream end / cancel /
 * success|error|pending_approval.
 *
 * key = `${sessionId}::${messageId}`
 */

import { create } from 'zustand';
import type { MessageToolCall, MessageToolCallStatus, MessageImageRef } from './types';

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
  /** 工具调用产出的图片 ref（异步解析完成时通过 updateStreamImage 更新状态） */
  images?: MessageImageRef[];
};

export type StreamEntry = {
  sessionId: string;
  messageId: string;
  text: string;
  thinking?: string;
  /** Intermediate tool progress keyed by toolCallId (no immer). */
  tools?: Record<string, StreamToolLive>;
  /** 流式期间增量解析出的图片 ref（消息级，跨工具聚合） */
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
  /** 设置流式消息的图片（直接替换 images 数组） */
  setStreamImages: (
    sessionId: string,
    messageId: string,
    images: MessageImageRef[]
  ) => void;
  /** 更新单个图片 ref 状态（异步解析完成时调用） */
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
        [key]: {
          sessionId,
          messageId,
          text,
          ...preserveRest(prev),
        },
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
    const tools = { ...(prev?.tools || Object.create(null)), [toolId]: nextTool };
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
    // 浅比较：相同引用直接跳过，避免无谓的新对象分配
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
    // 浅合并：patch 覆盖既有字段，未提供字段保留
    const nextImg: MessageImageRef = { ...prevImg, ...patch };
    // 若 patch 未带来任何变化，跳过更新
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
      // 重新读取以避免并发覆盖：仅当 entry 仍存在且 images 引用未变时替换
      const cur = state.byKey[key];
      if (!cur?.images || cur.images !== prev.images) return state;
      return {
        byKey: {
          ...state.byKey,
          [key]: { ...cur, images },
        },
      };
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
          [key]: {
            ...cur,
            ...(hasTools ? { tools } : { tools: undefined }),
          },
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
      return {
        byKey: {
          ...state.byKey,
          [key]: rest,
        },
      };
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

  getStreamText: (sessionId, messageId) => {
    return get().byKey[streamStoreKey(sessionId, messageId)]?.text;
  },

  getStreamThinking: (sessionId, messageId) => {
    return get().byKey[streamStoreKey(sessionId, messageId)]?.thinking;
  },

  getStreamTools: (sessionId, messageId) => {
    return get().byKey[streamStoreKey(sessionId, messageId)]?.tools;
  },

  getStreamTool: (sessionId, messageId, toolId) => {
    return get().byKey[streamStoreKey(sessionId, messageId)]?.tools?.[toolId];
  },

  getStreamImages: (sessionId, messageId) => {
    return get().byKey[streamStoreKey(sessionId, messageId)]?.images;
  },

  getStreamEntry: (sessionId, messageId) => {
    return get().byKey[streamStoreKey(sessionId, messageId)];
  },
}));

/** Imperative helpers (callbacks / batchers; no React). */
export function setStreamText(
  sessionId: string,
  messageId: string,
  text: string
): void {
  useStreamingStore.getState().setStreamText(sessionId, messageId, text);
}

export function setStreamThinking(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  useStreamingStore.getState().setStreamThinking(sessionId, messageId, thinking);
}

export function setStreamTool(
  sessionId: string,
  messageId: string,
  toolId: string,
  patch: StreamToolLive
): void {
  useStreamingStore.getState().setStreamTool(sessionId, messageId, toolId, patch);
}

export function clearStreamTool(
  sessionId: string,
  messageId: string,
  toolId: string
): void {
  useStreamingStore.getState().clearStreamTool(sessionId, messageId, toolId);
}

export function clearStreamTools(sessionId: string, messageId: string): void {
  useStreamingStore.getState().clearStreamTools(sessionId, messageId);
}

export function clearStream(sessionId: string, messageId: string): void {
  useStreamingStore.getState().clearStream(sessionId, messageId);
}

export function clearSessionStreams(sessionId: string): void {
  useStreamingStore.getState().clearSession(sessionId);
}

export function getStreamText(
  sessionId: string,
  messageId: string
): string | undefined {
  return useStreamingStore.getState().getStreamText(sessionId, messageId);
}

export function getStreamThinking(
  sessionId: string,
  messageId: string
): string | undefined {
  return useStreamingStore.getState().getStreamThinking(sessionId, messageId);
}

export function getStreamTools(
  sessionId: string,
  messageId: string
): Record<string, StreamToolLive> | undefined {
  return useStreamingStore.getState().getStreamTools(sessionId, messageId);
}

export function getStreamTool(
  sessionId: string,
  messageId: string,
  toolId: string
): StreamToolLive | undefined {
  return useStreamingStore.getState().getStreamTool(sessionId, messageId, toolId);
}

export function getStreamEntry(
  sessionId: string,
  messageId: string
): StreamEntry | undefined {
  return useStreamingStore.getState().getStreamEntry(sessionId, messageId);
}

/**
 * Merge live stream text into a message view-model for timeline rendering.
 * Prefers full cumulative stream text; appends trailing delta after durable
 * blocks when tools already committed a text prefix into the session store.
 */
export function applyStreamTextToMessage(
  msg: {
    text?: string | undefined;
    blocks?: Array<{ type: string; id?: string; content?: string }> | undefined;
  },
  streamText: string | undefined
): typeof msg {
  if (streamText == null) return msg;
  const committed = msg.text || '';
  if (streamText === committed) return msg;

  if (!msg.blocks?.length) {
    return { ...msg, text: streamText };
  }

  const trailing =
    committed && streamText.startsWith(committed)
      ? streamText.slice(committed.length)
      : committed
        ? null
        : streamText;

  if (trailing === null) {
    // Divergence: use stream as authoritative full text for display.
    return { ...msg, text: streamText };
  }
  if (!trailing) {
    return { ...msg, text: streamText };
  }

  const blocks = msg.blocks.map((b) => ({ ...b }));
  const last = blocks[blocks.length - 1];
  if (last?.type === 'text') {
    blocks[blocks.length - 1] = {
      ...last,
      content: (last.content || '') + trailing,
    };
  } else {
    blocks.push({ type: 'text', content: trailing });
  }
  return { ...msg, text: streamText, blocks };
}

type MsgWithTools = {
  text?: string | undefined;
  toolCalls?: MessageToolCall[] | undefined;
  blocks?: Array<{ type: string; id?: string; content?: string }> | undefined;
};

/**
 * Merge intermediate tool rows from streamingStore into a message view-model.
 * Does not downgrade terminal session statuses (success/error).
 * Ensures tool_call blocks exist so timeline cards render live.
 */
export function applyStreamToolsToMessage<T extends MsgWithTools>(
  msg: T,
  tools: Record<string, StreamToolLive> | undefined
): T {
  if (!tools) return msg;
  const ids = Object.keys(tools);
  if (ids.length === 0) return msg;

  const toolCalls = [...(msg.toolCalls || [])];
  const indexById = new Map(toolCalls.map((t, i) => [t.id, i]));
  let changed = false;

  for (const toolId of ids) {
    const live = tools[toolId];
    if (!live) continue;
    const idx = indexById.get(toolId);
    if (idx === undefined) {
      const tc: MessageToolCall = {
        id: toolId,
        name: live.name || 'tool',
        status: live.status || 'running',
        ...(live.arguments !== undefined ? { arguments: live.arguments } : {}),
        ...(live.explanation !== undefined
          ? { explanation: live.explanation }
          : {}),
        ...(live.output !== undefined ? { output: live.output } : {}),
        ...(live.startedAt !== undefined ? { startedAt: live.startedAt } : {}),
        ...(live.approvalMeta !== undefined
          ? { approvalMeta: live.approvalMeta }
          : {}),
      };
      indexById.set(toolId, toolCalls.length);
      toolCalls.push(tc);
      changed = true;
      continue;
    }
    const existing = toolCalls[idx]!;
    // Never let intermediate lite state clobber durable terminal rows.
    if (existing.status === 'success' || existing.status === 'error') {
      continue;
    }
    const merged: MessageToolCall = {
      ...existing,
      ...(live.name !== undefined ? { name: live.name } : {}),
      ...(live.arguments !== undefined ? { arguments: live.arguments } : {}),
      ...(live.explanation !== undefined
        ? { explanation: live.explanation }
        : {}),
      ...(live.status !== undefined ? { status: live.status } : {}),
      ...(live.output !== undefined ? { output: live.output } : {}),
      ...(live.startedAt !== undefined ? { startedAt: live.startedAt } : {}),
      ...(live.approvalMeta !== undefined
        ? { approvalMeta: live.approvalMeta }
        : {}),
    };
    if (
      merged.name !== existing.name ||
      merged.arguments !== existing.arguments ||
      merged.explanation !== existing.explanation ||
      merged.status !== existing.status ||
      merged.output !== existing.output ||
      merged.startedAt !== existing.startedAt ||
      merged.approvalMeta !== existing.approvalMeta
    ) {
      toolCalls[idx] = merged;
      changed = true;
    }
  }

  if (!changed) return msg;

  const blocks = msg.blocks ? msg.blocks.map((b) => ({ ...b })) : [];
  const inBlocks = new Set(
    blocks
      .filter((b) => b.type === 'tool_call' && b.id)
      .map((b) => b.id as string)
  );
  for (const tc of toolCalls) {
    if (!inBlocks.has(tc.id)) {
      blocks.push({ type: 'tool_call', id: tc.id });
      inBlocks.add(tc.id);
    }
  }

  return { ...msg, toolCalls, blocks };
}
