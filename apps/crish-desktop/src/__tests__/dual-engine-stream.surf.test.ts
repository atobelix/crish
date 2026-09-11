/**
 * W5-C · A-SURF-04 / A-SURF-05 产品向探针（加深）
 *
 * | ID        | 夹具                                                         | 断言                                              |
 * |-----------|--------------------------------------------------------------|---------------------------------------------------|
 * | A-SURF-04 | mock stream token 热路径（骨架 + useChatStream/useAgentPanel） | applyMd / sendToNote / dispatchSendToNote 次数 = 0 |
 * | A-SURF-05 | 消息 completed 且 **不**发 send_to_note Intent                 | 目标笔记 block_count 不变、写计数 = 0             |
 *
 * 会计钉死（07 §3）：
 * - **≠ EL-08 关闭**（最低集仍缺 04/05 产品气泡联调全绿 + 06 UI + 11 等）
 * - **≠ W5-B 挂载完成** / **≠ B-05 气泡挂载**
 * - **未接真实 SSE**：底层 `streamAssistantResponseApi` / `streamCollaboratorRun` 仍 mock；
 *   本文件证明「产品 hook 导出路径上 token/complete 默认零写笔记」，
 *   非端到端 daemon SSE、非关 EL-08 声明
 *
 * 对齐：plans/07 §3 / §7；dual-engine-surface §5 / §7.2
 */
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryNoteTransport,
  setDefaultNoteTransport,
  type MemoryNoteTransport,
  type NoteTransport,
} from '../api/noteApi';
import {
  buildSendToNoteIntent,
  dispatchSendToNote,
  clearSendToNoteIdempotencyForTests,
  resetSendToNoteIntentSeqForTests,
} from '../bridges/send-to-note';
import { resetCompositionRoot } from '../app/compositionRoot';
import { useLayoutStore } from '../store/layoutStore';
import { useSessionStore } from '../store/sessionStore';
import { useChatStream } from '../hooks/useChatStream';
import { useAgentPanel } from '../hooks/useAgentStream';
import type { UseChatStreamOptions } from '../hooks/chat-stream/types';

// ---------------------------------------------------------------------------
// 底层 transport mock（诚实：未接真实 SSE）
// ---------------------------------------------------------------------------

const streamMocks = vi.hoisted(() => ({
  streamAssistantResponseApi: vi.fn(() => () => {}),
  streamCollaboratorRun: vi.fn(() => () => {}),
  sendToSubagent: vi.fn(async () => ({ ok: true, accepted: true })),
  getSubagentStatus: vi.fn(async () => null),
}));

vi.mock('../api/chatApi', () => ({
  streamAssistantResponseApi: streamMocks.streamAssistantResponseApi,
}));

vi.mock('../api/subagentApi', () => ({
  sendToSubagent: streamMocks.sendToSubagent,
  streamCollaboratorRun: streamMocks.streamCollaboratorRun,
  getSubagentStatus: streamMocks.getSubagentStatus,
}));

vi.mock('../api/transport', () => ({
  getTransport: () => ({
    onStatus: vi.fn(() => () => {}),
    isReady: vi.fn(() => true),
    waitUntilConnected: vi.fn(async () => true),
    onMessage: vi.fn(),
    invoke: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// 计数探针：包装 NoteTransport，记录写路径调用
// ---------------------------------------------------------------------------

type WriteProbe = {
  transport: NoteTransport;
  applyMdCalls: number;
  sendToNoteCalls: number;
  /** 全部写路径计数（apply + send） */
  totalWriteCalls: number;
  mem: MemoryNoteTransport;
};

function createProbedNoteTransport(seed?: {
  docId: string;
  blocks: Array<[string, string, string]>;
}): WriteProbe {
  const mem = createMemoryNoteTransport();
  if (seed) {
    mem.seedDoc(seed.docId, seed.blocks);
  }
  let applyMdCalls = 0;
  let sendToNoteCalls = 0;
  const transport: NoteTransport = {
    applyMd: async (req) => {
      applyMdCalls += 1;
      return mem.applyMd(req);
    },
    queryBlocks: (params) => mem.queryBlocks(params),
    sendToNote: async (req) => {
      sendToNoteCalls += 1;
      return mem.sendToNote(req);
    },
  };
  return {
    get applyMdCalls() {
      return applyMdCalls;
    },
    get sendToNoteCalls() {
      return sendToNoteCalls;
    },
    get totalWriteCalls() {
      return applyMdCalls + sendToNoteCalls;
    },
    transport,
    mem,
  };
}

/**
 * 模拟 chat 流式 token 热路径：仅更新本地缓冲，**禁止**触碰笔记 transport。
 * 骨架探针；产品路径见下方 useChatStream / useAgentPanel 加深测。
 */
function simulateStreamTokenPath(args: {
  onToken: (chunk: string) => void;
  tokens: string[];
  /** 若误注入笔记写，会在此调用 */
  noteWrite?: () => void | Promise<void>;
}): { buffer: string } {
  let buffer = '';
  for (const t of args.tokens) {
    buffer += t;
    args.onToken(t);
    // A-SURF-04 纪律：stream 回调内不得写笔记
  }
  void args.noteWrite;
  return { buffer };
}

/**
 * 模拟流完成且 **无** send_to_note Intent：仅标记消息 completed。
 */
function simulateStreamCompleteWithoutIntent(args: {
  messageId: string;
  markdown: string;
  setStatus: (id: string, status: 'completed') => void;
}): { status: 'completed'; messageId: string; markdown: string } {
  args.setStatus(args.messageId, 'completed');
  return {
    status: 'completed',
    messageId: args.messageId,
    markdown: args.markdown,
  };
}

// ---------------------------------------------------------------------------
// 会话 / options 夹具（产品 hook 路径）
// ---------------------------------------------------------------------------

const CHAT_SID = 'sess-surf-chat-04';
const AGENT_PARENT = 'sess-surf-agent-parent';
const AGENT_ID = 'agent-surf-04';

function seedChatSession(sessionId = CHAT_SID) {
  const sess = {
    id: sessionId,
    title: 'surf chat',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: [] as Array<Record<string, unknown>>,
    agents: [] as Array<Record<string, unknown>>,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  useSessionStore.setState((st) => {
    const s = st as Record<string, unknown>;
    s.sessionsById = {
      ...(s.sessionsById as object),
      [sessionId]: sess,
    };
    const list = Array.isArray(s.sessions) ? [...(s.sessions as object[])] : [];
    const idx = list.findIndex((x: { id?: string }) => x.id === sessionId);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    s.sessions = list;
    s.activeSessionId = sessionId;
  });
  useLayoutStore.setState((st) => {
    const s = st as Record<string, unknown>;
    s.sessionsById = {
      ...(s.sessionsById as object),
      [sessionId]: sess,
    };
    const list = Array.isArray(s.sessions) ? [...(s.sessions as object[])] : [];
    const idx = list.findIndex((x: { id?: string }) => x.id === sessionId);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    s.sessions = list;
    s.activeSessionId = sessionId;
  });
}

function seedAgentParent() {
  const agent = {
    id: AGENT_ID,
    description: 'surf agent',
    mode: 'research' as const,
    status: 'idle' as const,
    messages: [] as Array<Record<string, unknown>>,
    createdAt: Date.now(),
  };
  const sess = {
    id: AGENT_PARENT,
    title: 'surf agent parent',
    messages: [],
    agents: [agent],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  useSessionStore.setState((st) => {
    const s = st as Record<string, unknown>;
    s.sessionsById = {
      ...(s.sessionsById as object),
      [AGENT_PARENT]: sess,
    };
    const list = Array.isArray(s.sessions) ? [...(s.sessions as object[])] : [];
    const idx = list.findIndex((x: { id?: string }) => x.id === AGENT_PARENT);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    s.sessions = list;
  });
  useLayoutStore.setState((st) => {
    const s = st as Record<string, unknown>;
    s.sessionsById = {
      ...(s.sessionsById as object),
      [AGENT_PARENT]: sess,
    };
    const list = Array.isArray(s.sessions) ? [...(s.sessions as object[])] : [];
    const idx = list.findIndex((x: { id?: string }) => x.id === AGENT_PARENT);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    s.sessions = list;
  });
}

function makeChatOptions(
  overrides: Partial<UseChatStreamOptions> = {}
): UseChatStreamOptions {
  return {
    wsId: 'ws-surf',
    onShowToast: vi.fn(),
    handleGlobalTabClick: vi.fn(),
    chatInput: '',
    setChatInput: vi.fn(),
    setSlashMenuOpen: vi.fn(),
    attachments: [],
    setAttachments: vi.fn(),
    skillCommandsEnabled: true,
    needsKeySetup: false,
    setPickerInlineError: vi.fn(),
    ...overrides,
  };
}

type StreamCallbacksCapture = {
  onChunk?: (chunk: string) => void;
  onComplete?: () => void;
  onThought?: (t: string) => void;
  onRunError?: (message: string, kind?: string, detail?: unknown) => void;
};

function lastChatStreamCallbacks(): StreamCallbacksCapture {
  const call = streamMocks.streamAssistantResponseApi.mock.calls.at(-1);
  return (call?.[1] ?? {}) as StreamCallbacksCapture;
}

function lastAgentStreamCallbacks(): StreamCallbacksCapture {
  const call = streamMocks.streamCollaboratorRun.mock.calls.at(-1);
  return (call?.[2] ?? {}) as StreamCallbacksCapture;
}

// ---------------------------------------------------------------------------
// A-SURF-04 · 骨架
// ---------------------------------------------------------------------------

describe('A-SURF-04 流式 token 路径笔记写计数 = 0（探针骨架）', () => {
  let probe: WriteProbe;

  beforeEach(() => {
    clearSendToNoteIdempotencyForTests();
    resetSendToNoteIntentSeqForTests();
    probe = createProbedNoteTransport({
      docId: 'doc-surf04',
      blocks: [['b1', 'paragraph', 'seed']],
    });
  });

  it('mock stream token 热路径：applyMd / sendToNote 调用次数均为 0', () => {
    const localBuf: string[] = [];
    const { buffer } = simulateStreamTokenPath({
      tokens: ['Hello', ' ', 'world', '!', ' 🚀'],
      onToken: (c) => {
        localBuf.push(c);
      },
    });

    expect(buffer).toBe('Hello world! 🚀');
    expect(localBuf.join('')).toBe(buffer);
    expect(probe.applyMdCalls).toBe(0);
    expect(probe.sendToNoteCalls).toBe(0);
    expect(probe.totalWriteCalls).toBe(0);
    expect(probe.mem.blockCount('doc-surf04')).toBe(1);
  });

  it('stream 路径即使用户持有 NoteTransport 引用，也不得被 token 回调调用', async () => {
    const spyApply = vi.fn(probe.transport.applyMd);
    const spySend = vi.fn(probe.transport.sendToNote);
    const held: NoteTransport = {
      applyMd: spyApply,
      queryBlocks: probe.transport.queryBlocks,
      sendToNote: spySend,
    };

    const streamHandler = (_chunk: string) => {
      void held;
    };

    for (const t of ['a', 'b', 'c']) {
      streamHandler(t);
    }

    expect(spyApply).not.toHaveBeenCalled();
    expect(spySend).not.toHaveBeenCalled();
    expect(probe.mem.blockCount('doc-surf04')).toBe(1);
  });

  it('对照：显式 send_to_note 才会产生写（证明探针可红）', async () => {
    const built = buildSendToNoteIntent({
      messageId: 'msg-1',
      docId: 'doc-surf04',
      markdown: '## from chat\n\nbody',
      origin: 'user',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await dispatchSendToNote(built.intent, {
      transport: probe.transport,
      streamStatus: 'completed',
    });
    expect(result.ok).toBe(true);
    expect(probe.sendToNoteCalls + probe.applyMdCalls).toBeGreaterThan(0);
    expect(probe.mem.blockCount('doc-surf04')).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// A-SURF-04 · 产品 hook 导出路径加深（mock 底层 SSE/engine transport）
// ---------------------------------------------------------------------------

describe('A-SURF-04 产品路径：useChatStream / useAgentStream token → 笔记写 = 0', () => {
  let probe: WriteProbe;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    clearSendToNoteIdempotencyForTests();
    resetSendToNoteIntentSeqForTests();
    resetCompositionRoot();
    streamMocks.streamAssistantResponseApi.mockClear();
    streamMocks.streamCollaboratorRun.mockClear();
    streamMocks.streamAssistantResponseApi.mockImplementation(() => () => {});
    streamMocks.streamCollaboratorRun.mockImplementation(() => () => {});

    probe = createProbedNoteTransport({
      docId: 'doc-surf04-product',
      blocks: [['b1', 'paragraph', 'seed-product']],
    });
    setDefaultNoteTransport(probe.transport);

    // 贴近真实跨界：若 hook 误调桥，spy 必红
    const bridge = await import('../bridges/send-to-note');
    dispatchSpy = vi.spyOn(bridge, 'dispatchSendToNote');

    seedChatSession();
    seedAgentParent();
  });

  afterEach(() => {
    dispatchSpy?.mockRestore();
    setDefaultNoteTransport(null);
    resetCompositionRoot();
    vi.clearAllMocks();
  });

  it('useChatStream 真实导出路径：mock token 热路径 apply/sendToNote/dispatch = 0', () => {
    // 诚实边界：未接真实 SSE；仅 mock streamAssistantResponseApi 回调
    const { result } = renderHook(() => useChatStream(makeChatOptions()));

    act(() => {
      result.current.runStreamingAssistant(
        'hello surf',
        'user-surf-1',
        CHAT_SID
      );
    });

    expect(streamMocks.streamAssistantResponseApi).toHaveBeenCalled();
    const cb = lastChatStreamCallbacks();
    expect(typeof cb.onChunk).toBe('function');

    const beforeBlocks = probe.mem.blockCount('doc-surf04-product');

    act(() => {
      cb.onChunk?.('Hello');
      cb.onChunk?.(' ');
      cb.onChunk?.('from');
      cb.onChunk?.(' ');
      cb.onChunk?.('useChatStream');
    });

    expect(probe.applyMdCalls).toBe(0);
    expect(probe.sendToNoteCalls).toBe(0);
    expect(probe.totalWriteCalls).toBe(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(probe.mem.blockCount('doc-surf04-product')).toBe(beforeBlocks);
  });

  it('useAgentPanel（useAgentStream 导出）：mock token 热路径 apply/sendToNote/dispatch = 0', async () => {
    const { result } = renderHook(() =>
      useAgentPanel({
        parentSessionId: AGENT_PARENT,
        agentId: AGENT_ID,
        isRunning: false,
        useDaemonSync: false,
      })
    );

    await act(async () => {
      await result.current.handleSend('agent token probe');
    });

    expect(streamMocks.streamCollaboratorRun).toHaveBeenCalled();
    const cb = lastAgentStreamCallbacks();
    expect(typeof cb.onChunk).toBe('function');

    const beforeBlocks = probe.mem.blockCount('doc-surf04-product');

    act(() => {
      cb.onChunk?.('chunk-a');
      cb.onChunk?.('chunk-b');
      cb.onChunk?.('chunk-c');
    });

    expect(probe.applyMdCalls).toBe(0);
    expect(probe.sendToNoteCalls).toBe(0);
    expect(probe.totalWriteCalls).toBe(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(probe.mem.blockCount('doc-surf04-product')).toBe(beforeBlocks);
  });
});

// ---------------------------------------------------------------------------
// A-SURF-05 · 骨架
// ---------------------------------------------------------------------------

describe('A-SURF-05 完成态无 Intent → 笔记版本不变（探针骨架）', () => {
  let probe: WriteProbe;

  beforeEach(() => {
    clearSendToNoteIdempotencyForTests();
    resetSendToNoteIntentSeqForTests();
    probe = createProbedNoteTransport({
      docId: 'doc-surf05',
      blocks: [
        ['h1', 'heading', 'Title'],
        ['p1', 'paragraph', 'Body'],
      ],
    });
  });

  it('消息 completed 且不发 send_to_note → block_count 不变、写计数 = 0', () => {
    const before = probe.mem.blockCount('doc-surf05');
    expect(before).toBe(2);

    const statuses = new Map<string, string>();
    const completed = simulateStreamCompleteWithoutIntent({
      messageId: 'asst-1',
      markdown: 'final assistant text that must NOT auto-write note',
      setStatus: (id, status) => {
        statuses.set(id, status);
      },
    });

    expect(completed.status).toBe('completed');
    expect(statuses.get('asst-1')).toBe('completed');
    expect(probe.mem.blockCount('doc-surf05')).toBe(before);
    expect(probe.totalWriteCalls).toBe(0);
  });

  it('完成态 + 显式 Intent 才会改 block_count（对照可红）', async () => {
    const before = probe.mem.blockCount('doc-surf05');

    const built = buildSendToNoteIntent({
      messageId: 'asst-2',
      docId: 'doc-surf05',
      markdown: 'explicit note insert',
      origin: 'user',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await dispatchSendToNote(built.intent, {
      transport: probe.transport,
      streamStatus: 'completed',
    });
    expect(result.ok).toBe(true);
    expect(probe.mem.blockCount('doc-surf05')).toBeGreaterThan(before);
  });

  it('流未完成时 dispatch 拒绝 → 笔记不变（与 05 同向）', async () => {
    const before = probe.mem.blockCount('doc-surf05');
    const result = await dispatchSendToNote(
      {
        messageId: 'asst-3',
        docId: 'doc-surf05',
        markdown: 'still streaming…',
        origin: 'user',
      },
      {
        transport: probe.transport,
        streamStatus: 'streaming',
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stream_not_completed');
    }
    expect(probe.mem.blockCount('doc-surf05')).toBe(before);
    expect(probe.totalWriteCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A-SURF-05 · 产品 hook 完成态加深
// ---------------------------------------------------------------------------

describe('A-SURF-05 产品路径：completed 无 Intent → block_count 不变', () => {
  let probe: WriteProbe;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    clearSendToNoteIdempotencyForTests();
    resetSendToNoteIntentSeqForTests();
    resetCompositionRoot();
    streamMocks.streamAssistantResponseApi.mockClear();
    streamMocks.streamCollaboratorRun.mockClear();
    streamMocks.streamAssistantResponseApi.mockImplementation(() => () => {});
    streamMocks.streamCollaboratorRun.mockImplementation(() => () => {});

    probe = createProbedNoteTransport({
      docId: 'doc-surf05-product',
      blocks: [
        ['h1', 'heading', 'Title'],
        ['p1', 'paragraph', 'Body'],
      ],
    });
    setDefaultNoteTransport(probe.transport);

    const bridge = await import('../bridges/send-to-note');
    dispatchSpy = vi.spyOn(bridge, 'dispatchSendToNote');

    seedChatSession();
    seedAgentParent();
  });

  afterEach(() => {
    dispatchSpy?.mockRestore();
    setDefaultNoteTransport(null);
    resetCompositionRoot();
    vi.clearAllMocks();
  });

  it('useChatStream onComplete（无 Intent）→ block_count 不变、写计数 = 0', async () => {
    // 诚实：mock onComplete，非真实 SSE end-of-stream
    const { result } = renderHook(() => useChatStream(makeChatOptions()));

    act(() => {
      result.current.runStreamingAssistant(
        'complete without note',
        'user-surf-c1',
        CHAT_SID
      );
    });

    const cb = lastChatStreamCallbacks();
    const before = probe.mem.blockCount('doc-surf05-product');
    expect(before).toBe(2);

    act(() => {
      cb.onChunk?.('final assistant text must NOT auto-write note');
    });

    await act(async () => {
      cb.onComplete?.();
      // finishComplete 内有微任务 / 动态 import；冲刷一轮
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(probe.mem.blockCount('doc-surf05-product')).toBe(before);
    expect(probe.applyMdCalls).toBe(0);
    expect(probe.sendToNoteCalls).toBe(0);
    expect(probe.totalWriteCalls).toBe(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('useAgentPanel onComplete（无 Intent）→ block_count 不变、写计数 = 0', async () => {
    const { result } = renderHook(() =>
      useAgentPanel({
        parentSessionId: AGENT_PARENT,
        agentId: AGENT_ID,
        isRunning: false,
        useDaemonSync: false,
      })
    );

    await act(async () => {
      await result.current.handleSend('agent complete without note');
    });

    const cb = lastAgentStreamCallbacks();
    const before = probe.mem.blockCount('doc-surf05-product');
    expect(before).toBe(2);

    act(() => {
      cb.onChunk?.('agent final text');
      cb.onComplete?.();
    });

    expect(probe.mem.blockCount('doc-surf05-product')).toBe(before);
    expect(probe.totalWriteCalls).toBe(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 会计钉死：本文件绿 ≠ EL-08 关
// ---------------------------------------------------------------------------

describe('A-SURF-04/05 会计：≠ EL-08 关闭', () => {
  it('显式否决：本探针绿不得宣称为 EL-08 关闭（07 §3）', () => {
    // 最低集 1–8 全绿才可关 EL-08；本文件仅交付 04/05 计数探针加深子集
    const el08ClosedByThisSuiteAlone = false;
    const realSseConnected = false;
    const bubbleSendToNoteMounted = false; // B-05 产品气泡仍未闭
    expect(el08ClosedByThisSuiteAlone).toBe(false);
    expect(realSseConnected).toBe(false);
    expect(bubbleSendToNoteMounted).toBe(false);
  });
});
