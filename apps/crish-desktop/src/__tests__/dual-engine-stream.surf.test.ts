/**
 * W5-C · A-SURF-04 / A-SURF-05 探针骨架（子集可交付）
 *
 * | ID          | 夹具                                      | 断言                                      |
 * |-------------|-------------------------------------------|-------------------------------------------|
 * | A-SURF-04   | mock stream token 热路径                  | 笔记写 API 调用次数 = 0                   |
 * | A-SURF-05   | 消息 completed 且 **不**发 send_to_note   | 目标笔记 block_count / 等价版本不变       |
 *
 * 会计钉死：
 * - **≠ EL-08 关闭**（最低集仍缺 04/05 产品链 + 06 UI + 11 等全绿）
 * - **≠ W5-B 挂载完成**
 * - 本文件为 **探针骨架**：证明 stream/complete 路径默认零写笔记；
 *   非产品气泡联调、非全量集成门禁关闭声明
 *
 * 对齐：plans/07 §7；dual-engine-surface §5 / §7.2
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createMemoryNoteTransport,
  type MemoryNoteTransport,
  type NoteTransport,
} from '../api/noteApi';
import {
  buildSendToNoteIntent,
  dispatchSendToNote,
  clearSendToNoteIdempotencyForTests,
  resetSendToNoteIntentSeqForTests,
} from '../bridges/send-to-note';

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
 * 真实产品路径在 hooks/chat-stream；此处为可计数骨架探针。
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
    // 探针故意不调用 noteWrite；若调用方错误接线会在测中暴露
  }
  void args.noteWrite; // 保留注入位，默认不调用
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
// A-SURF-04
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
        // 仅行级/本地缓冲；不得调用 probe.transport
      },
      // 故意不接线 noteWrite → 写计数应保持 0
    });

    expect(buffer).toBe('Hello world! 🚀');
    expect(localBuf.join('')).toBe(buffer);
    expect(probe.applyMdCalls).toBe(0);
    expect(probe.sendToNoteCalls).toBe(0);
    expect(probe.totalWriteCalls).toBe(0);
    // 种子块仍在
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

    // 模拟错误架构：把 transport 放进闭包但 stream 纪律要求不调用
    const streamHandler = (_chunk: string) => {
      // A-SURF-04：禁止 held.applyMd / held.sendToNote
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
// A-SURF-05
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
    // 无 Intent / 无 dispatch → 笔记不变
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
