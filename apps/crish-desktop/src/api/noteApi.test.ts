/**
 * noteApi 契约单测（Round6）
 * - Memory transport apply → query 命中
 * - intent 幂等
 * - 命令名常量
 * - parse 线格式
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NOTE_CMD_DOCUMENT_APPLY_MD,
  NOTE_CMD_QUERY_BLOCKS,
  NOTE_CMD_SEND_TO_NOTE,
  NOTE_COMMANDS,
  createMemoryNoteTransport,
  createNoteTransport,
  parseApplyOutcome,
  parseQueryOutcome,
  setDefaultNoteTransport,
  transportAsSendToNoteSink,
  type MemoryNoteTransport,
} from './noteApi';

describe('note 命令名常量', () => {
  it('与任务书对齐：note_document_apply_md / note_query_blocks / note_send_to_note', () => {
    expect(NOTE_CMD_DOCUMENT_APPLY_MD).toBe('note_document_apply_md');
    expect(NOTE_CMD_QUERY_BLOCKS).toBe('note_query_blocks');
    expect(NOTE_CMD_SEND_TO_NOTE).toBe('note_send_to_note');
    expect(NOTE_COMMANDS.documentApplyMd).toBe(NOTE_CMD_DOCUMENT_APPLY_MD);
    expect(NOTE_COMMANDS.queryBlocks).toBe(NOTE_CMD_QUERY_BLOCKS);
    expect(NOTE_COMMANDS.sendToNote).toBe(NOTE_CMD_SEND_TO_NOTE);
  });
});

describe('createMemoryNoteTransport', () => {
  let mem: MemoryNoteTransport;

  beforeEach(() => {
    mem = createMemoryNoteTransport();
  });

  it('apply → query 命中写入块', async () => {
    const apply = await mem.applyMd({
      docId: 'doc-1',
      markdown: '# Title\n\nhello body',
      intentId: 'i-apply-1',
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.idempotent).toBe(false);
    expect(apply.inserted).toBe(2);
    expect(apply.blockIds).toHaveLength(2);

    const q = await mem.queryBlocks({ docId: 'doc-1' });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.blocks).toHaveLength(2);
    expect(q.blocks[0]!.kind).toBe('heading');
    expect(q.blocks[0]!.snippet).toBe('Title');
    expect(q.blocks[1]!.kind).toBe('paragraph');
    expect(q.blocks[1]!.snippet).toBe('hello body');
    expect(mem.blockCount('doc-1')).toBe(2);
  });

  it('text_match 过滤', async () => {
    await mem.applyMd({
      docId: 'doc-f',
      markdown: 'alpha\n\nbeta needle\n\ngamma',
    });
    const q = await mem.queryBlocks({
      docId: 'doc-f',
      textMatch: 'needle',
    });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.blocks).toHaveLength(1);
    expect(q.blocks[0]!.snippet).toContain('needle');
  });

  it('intent 幂等：同 intentId 不双插', async () => {
    const first = await mem.applyMd({
      docId: 'doc-idemp',
      markdown: 'once only',
      intentId: 'same-intent',
    });
    const second = await mem.applyMd({
      docId: 'doc-idemp',
      markdown: 'once only',
      intentId: 'same-intent',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.inserted).toBe(1);
    expect(second.idempotent).toBe(true);
    expect(second.inserted).toBe(0);
    expect(second.blockIds).toEqual(first.blockIds);
    expect(mem.blockCount('doc-idemp')).toBe(1);
  });

  it('sendToNote 走 apply 路径并写 message 元数据可幂等', async () => {
    const r1 = await mem.sendToNote({
      intentId: 'stn-1',
      docId: 'doc-stn',
      markdown: '## from chat',
      messageId: 'msg-1',
      origin: 'user',
    });
    const r2 = await mem.sendToNote({
      intentId: 'stn-1',
      docId: 'doc-stn',
      markdown: '## from chat',
      messageId: 'msg-1',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(true);
    const q = await mem.queryBlocks({ docId: 'doc-stn' });
    expect(q.ok && q.blocks.length).toBe(1);
  });

  it('拒绝空 docId', async () => {
    const r = await mem.applyMd({ docId: '', markdown: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('note.invalid');
  });

  it('seedDoc 预置可被 query 命中', async () => {
    mem.seedDoc('seeded', [
      ['b1', 'paragraph', 'seeded text'],
      ['b2', 'heading', 'H'],
    ]);
    const q = await mem.queryBlocks({ docId: 'seeded', kindIn: ['heading'] });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.blocks).toHaveLength(1);
    expect(q.blocks[0]!.id).toBe('b2');
  });
});

describe('parseApplyOutcome / parseQueryOutcome', () => {
  it('解析 snake_case 与 camelCase', () => {
    const a = parseApplyOutcome({
      block_ids: ['x', 'y'],
      inserted: 2,
      idempotent: false,
    });
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.blockIds).toEqual(['x', 'y']);
      expect(a.inserted).toBe(2);
    }

    const b = parseApplyOutcome({
      ok: false,
      reason: 'nope',
      code: 'note.x',
    });
    expect(b.ok).toBe(false);

    const q = parseQueryOutcome({
      blocks: [{ id: '1', kind: 'paragraph', snippet: 's', attrs: {} }],
      truncated: true,
    });
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.blocks[0]!.id).toBe('1');
      expect(q.truncated).toBe(true);
    }
  });
});

describe('createNoteTransport / transportAsSendToNoteSink', () => {
  beforeEach(() => {
    setDefaultNoteTransport(null);
  });

  it('注入 transport 优先', async () => {
    const mem = createMemoryNoteTransport();
    const t = createNoteTransport({ transport: mem });
    await t.applyMd({ docId: 'd', markdown: 'via inject' });
    const q = await t.queryBlocks({ docId: 'd' });
    expect(q.ok && q.blocks.length).toBe(1);
  });

  it('transportAsSendToNoteSink 适配桥 sink 形状', async () => {
    const mem = createMemoryNoteTransport();
    const sink = transportAsSendToNoteSink(mem);
    const r = await sink({
      intentId: 'adapt-1',
      source: { markdown: 'snap', messageId: 'm' },
      target: {
        docId: 'd-adapt',
        mode: 'apply_md_fragment',
      },
      origin: 'user',
    });
    expect(r.ok).toBe(true);
    expect(r.blockIds?.length).toBe(1);
    expect(mem.blockCount('d-adapt')).toBe(1);
  });
});
