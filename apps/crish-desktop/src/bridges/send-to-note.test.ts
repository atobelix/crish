/**
 * send_to_note 薄桥单测（W5-B · B-06/B-07/B-08）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertStreamCompleted,
  buildSendToNoteIntent,
  clearSendToNoteIdempotencyForTests,
  createMockSendToNoteSink,
  dispatchSendToNote,
  EDITOR_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER,
  resetSendToNoteIntentSeqForTests,
  type SendToNoteIntent,
} from './send-to-note';

beforeEach(() => {
  resetSendToNoteIntentSeqForTests();
  clearSendToNoteIdempotencyForTests();
});

// ---------------------------------------------------------------------------
// assertStreamCompleted
// ---------------------------------------------------------------------------

describe('assertStreamCompleted', () => {
  it('仅 completed 放行', () => {
    expect(assertStreamCompleted('completed')).toEqual({ ok: true });
  });

  it('streaming / pending / undefined 拒绝', () => {
    for (const s of ['streaming', 'pending', 'error', undefined, null, '']) {
      const r = assertStreamCompleted(s as string | null | undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('stream_not_completed');
        expect(r.reason).toMatch(/流未完成|拒绝/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildSendToNoteIntent
// ---------------------------------------------------------------------------

describe('buildSendToNoteIntent', () => {
  it('接受 markdown 字符串快照并标注双 surface', () => {
    const r = buildSendToNoteIntent({
      messageId: 'msg-1',
      markdown: '# Hello\n\nworld',
      docId: 'doc-note-1',
      intentId: 'stn-fixed-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.type).toBe('send_to_note');
    expect(r.intent.intentId).toBe('stn-fixed-1');
    expect(r.intent.source.surface).toBe(EDITOR_SURFACE_CHAT);
    expect(r.intent.source.messageId).toBe('msg-1');
    expect(r.intent.source.markdown).toBe('# Hello\n\nworld');
    expect(r.intent.target.surface).toBe(EDITOR_SURFACE_NOTE_PAPER);
    expect(r.intent.target.docId).toBe('doc-note-1');
    expect(r.intent.target.mode).toBe('apply_md_fragment');
    expect(r.intent.origin).toBe('user');
  });

  it('运行时拒绝 lines 数组（B-07）', () => {
    const r = buildSendToNoteIntent({
      messageId: 'msg-1',
      // 故意绕过类型：模拟错误调用方传入 lines[]
      markdown: ['line1', 'line2'] as unknown as string,
      docId: 'doc-1',
      intentId: 'stn-lines',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid_markdown');
    expect(r.reason).toMatch(/lines\[\]|字符串快照/);
  });

  it('拒绝空 messageId / docId', () => {
    const a = buildSendToNoteIntent({
      messageId: '',
      markdown: 'x',
      docId: 'd',
      intentId: 'a',
    });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('invalid_message_id');

    const b = buildSendToNoteIntent({
      messageId: 'm',
      markdown: 'x',
      docId: '',
      intentId: 'b',
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('invalid_doc_id');
  });

  it('intent 载荷不含 lines 字段', () => {
    const r = buildSendToNoteIntent({
      messageId: 'm',
      markdown: 'snapshot',
      docId: 'd',
      intentId: 'c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const json = JSON.stringify(r.intent);
    expect(json).not.toMatch(/"lines"/);
    expect(r.intent.source).not.toHaveProperty('lines');
  });
});

// ---------------------------------------------------------------------------
// dispatch + mock sink
// ---------------------------------------------------------------------------

describe('dispatchSendToNote + mock sink', () => {
  it('成功：sink 收到 markdown 快照，返回 applied', async () => {
    const mock = createMockSendToNoteSink({
      ok: true,
      blockIds: ['b-a', 'b-b'],
    });
    const result = await dispatchSendToNote(
      {
        messageId: 'msg-ok',
        markdown: '## ok body',
        docId: 'doc-ok',
        intentId: 'idem-ok-1',
      },
      mock.sink,
      { streamStatus: 'completed' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(true);
    expect(result.blockIds).toEqual(['b-a', 'b-b']);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.source.markdown).toBe('## ok body');
  });

  it('失败：返回 Result，不假装已写树', async () => {
    const mock = createMockSendToNoteSink({
      ok: false,
      reason: 'doc not found',
    });
    const result = await dispatchSendToNote(
      {
        messageId: 'msg-fail',
        markdown: 'body',
        docId: 'missing',
        intentId: 'idem-fail-1',
      },
      mock.sink,
      { streamStatus: 'completed' }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('sink_reject');
    expect(result.reason).toMatch(/doc not found|拒绝/);
    // 无 applied / blockIds 成功字段
    expect(result).not.toHaveProperty('applied');
  });

  it('流未完成：拒绝且不调用 sink', async () => {
    const mock = createMockSendToNoteSink();
    const result = await dispatchSendToNote(
      {
        messageId: 'msg-stream',
        markdown: 'partial',
        docId: 'doc-1',
        intentId: 'idem-stream',
      },
      mock.sink,
      { streamStatus: 'streaming' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stream_not_completed');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('幂等 intentId：第二次不双插（applied=false，sink 只调一次）', async () => {
    const mock = createMockSendToNoteSink({ ok: true, blockIds: ['b-1'] });
    const cache = new Map();
    const input = {
      messageId: 'msg-idem',
      markdown: 'once',
      docId: 'doc-idem',
      intentId: 'idem-dup-1',
    };
    const first = await dispatchSendToNote(input, mock.sink, {
      streamStatus: 'completed',
      idempotencyCache: cache,
    });
    const second = await dispatchSendToNote(input, mock.sink, {
      streamStatus: 'completed',
      idempotencyCache: cache,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.applied).toBe(true);
      expect(second.applied).toBe(false);
      expect(second.intentId).toBe(first.intentId);
    }
    expect(mock.calls).toHaveLength(1);
  });

  it('可直接派发已构造 Intent', async () => {
    const mock = createMockSendToNoteSink();
    const intent: SendToNoteIntent = {
      type: 'send_to_note',
      intentId: 'hand-1',
      source: {
        surface: EDITOR_SURFACE_CHAT,
        messageId: 'm',
        markdown: 'hand',
      },
      target: {
        surface: EDITOR_SURFACE_NOTE_PAPER,
        docId: 'd',
        mode: 'insert_blocks',
      },
      origin: 'agent',
    };
    const r = await dispatchSendToNote(intent, mock.sink, {
      streamStatus: 'completed',
    });
    expect(r.ok).toBe(true);
    expect(mock.calls[0]!.origin).toBe('agent');
    expect(mock.calls[0]!.target.mode).toBe('insert_blocks');
  });
});
