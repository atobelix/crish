/**
 * noteApi 契约单测（Round6 + W5-D Round8）
 * - Memory transport apply → query 命中
 * - intent 幂等
 * - 命令名常量 + manifest 登记
 * - parse 线格式
 * - Tauri transport：mock invokeTyped 成功 / ok:false 不抛 / snake_case 参数
 * - createDefaultNoteTransport 环境策略
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTyped } from './tauriInvoke';
import { isRegisteredCommand } from './transport/commandManifest';
import {
  NOTE_CMD_DOCUMENT_APPLY_MD,
  NOTE_CMD_DOCUMENT_HYDRATE,
  NOTE_CMD_QUERY_BLOCKS,
  NOTE_CMD_SEND_TO_NOTE,
  NOTE_COMMANDS,
  applyReqToWire,
  createDefaultNoteTransport,
  createMemoryNoteTransport,
  createNoteTransport,
  createTauriNoteTransport,
  isNoteTauriRuntime,
  parseApplyOutcome,
  parseQueryOutcome,
  queryParamsToWire,
  resolveNoteTransport,
  sendReqToWire,
  setDefaultNoteTransport,
  transportAsSendToNoteSink,
  wrapApplyInvokeArgs,
  wrapQueryInvokeArgs,
  wrapSendInvokeArgs,
  type MemoryNoteTransport,
} from './noteApi';

vi.mock('./tauriInvoke', () => ({
  invokeTyped: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeTyped);

describe('note 命令名常量', () => {
  it('与任务书对齐：note_document_apply_md / note_query_blocks / note_send_to_note / note_document_hydrate', () => {
    expect(NOTE_CMD_DOCUMENT_APPLY_MD).toBe('note_document_apply_md');
    expect(NOTE_CMD_QUERY_BLOCKS).toBe('note_query_blocks');
    expect(NOTE_CMD_SEND_TO_NOTE).toBe('note_send_to_note');
    expect(NOTE_CMD_DOCUMENT_HYDRATE).toBe('note_document_hydrate');
    expect(NOTE_COMMANDS.documentApplyMd).toBe(NOTE_CMD_DOCUMENT_APPLY_MD);
    expect(NOTE_COMMANDS.queryBlocks).toBe(NOTE_CMD_QUERY_BLOCKS);
    expect(NOTE_COMMANDS.sendToNote).toBe(NOTE_CMD_SEND_TO_NOTE);
    expect(NOTE_COMMANDS.documentHydrate).toBe(NOTE_CMD_DOCUMENT_HYDRATE);
  });

  it('commandManifest 已登记且 registered=true', () => {
    expect(isRegisteredCommand(NOTE_CMD_DOCUMENT_APPLY_MD)).toBe(true);
    expect(isRegisteredCommand(NOTE_CMD_QUERY_BLOCKS)).toBe(true);
    expect(isRegisteredCommand(NOTE_CMD_SEND_TO_NOTE)).toBe(true);
    expect(isRegisteredCommand(NOTE_CMD_DOCUMENT_HYDRATE)).toBe(true);
  });
});

describe('snake_case 线格式投影', () => {
  it('applyReqToWire 字段映射表', () => {
    const wire = applyReqToWire({
      docId: 'd1',
      markdown: '# hi',
      parentId: 'p1',
      afterBlockId: 'a1',
      mode: 'apply_md_fragment',
      intentId: 'i1',
      batchId: 'b1',
      messageId: 'm1',
      origin: 'user',
    });
    expect(wire).toEqual({
      doc_id: 'd1',
      markdown: '# hi',
      parent_id: 'p1',
      after_block_id: 'a1',
      mode: 'apply_md_fragment',
      intent_id: 'i1',
      batch_id: 'b1',
      message_id: 'm1',
      origin: 'user',
    });
    // 外层对齐 note_document_apply_md(req: ...)
    expect(wrapApplyInvokeArgs({ docId: 'd', markdown: 'x' })).toEqual({
      req: { doc_id: 'd', markdown: 'x' },
    });
  });

  it('queryParamsToWire 字段映射表', () => {
    const wire = queryParamsToWire({
      docId: 'd1',
      kindIn: ['heading'],
      attrsEq: { k: 'v' },
      textMatch: 'needle',
      refTo: 'rt',
      refFrom: 'rf',
      limit: 10,
    });
    expect(wire).toEqual({
      doc_id: 'd1',
      kind_in: ['heading'],
      attrs_eq: { k: 'v' },
      text_match: 'needle',
      ref_to: 'rt',
      ref_from: 'rf',
      limit: 10,
    });
    expect(wrapQueryInvokeArgs({ docId: 'd' })).toEqual({
      params: { doc_id: 'd' },
    });
  });

  it('sendReqToWire 字段映射表', () => {
    const wire = sendReqToWire({
      intentId: 'i1',
      markdown: 'body',
      docId: 'd1',
      messageId: 'm1',
      parentId: 'p',
      afterBlockId: 'a',
      mode: 'insert_blocks',
      origin: 'agent',
      batchId: 'b',
    });
    expect(wire).toEqual({
      intent_id: 'i1',
      markdown: 'body',
      doc_id: 'd1',
      message_id: 'm1',
      parent_id: 'p',
      after_block_id: 'a',
      mode: 'insert_blocks',
      origin: 'agent',
      batch_id: 'b',
    });
    expect(
      wrapSendInvokeArgs({
        intentId: 'i',
        markdown: 'x',
        docId: 'd',
      })
    ).toEqual({
      req: { intent_id: 'i', markdown: 'x', doc_id: 'd' },
    });
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

describe('createTauriNoteTransport · invokeTyped 契约', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    setDefaultNoteTransport(null);
  });

  it('成功路径：apply → query 命中 shape（snake_case 入参 + 响应）', async () => {
    const tauri = createTauriNoteTransport();

    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: true,
        block_ids: ['blk-a', 'blk-b'],
        inserted: 2,
        idempotent: false,
      },
    });
    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: true,
        blocks: [
          {
            id: 'blk-a',
            kind: 'heading',
            snippet: 'Title',
            attrs: {},
          },
          {
            id: 'blk-b',
            kind: 'paragraph',
            snippet: 'hello',
            attrs: { source: 'agent' },
          },
        ],
        truncated: false,
      },
    });

    const apply = await tauri.applyMd({
      docId: 'doc-tauri',
      markdown: '# Title\n\nhello',
      intentId: 'i-tauri-1',
      origin: 'user',
    });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.blockIds).toEqual(['blk-a', 'blk-b']);
    expect(apply.inserted).toBe(2);
    expect(apply.idempotent).toBe(false);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, NOTE_CMD_DOCUMENT_APPLY_MD, {
      req: {
        doc_id: 'doc-tauri',
        markdown: '# Title\n\nhello',
        intent_id: 'i-tauri-1',
        origin: 'user',
      },
    });

    const q = await tauri.queryBlocks({
      docId: 'doc-tauri',
      textMatch: 'hello',
      limit: 50,
    });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.blocks).toHaveLength(2);
    expect(q.blocks[0]).toMatchObject({
      id: 'blk-a',
      kind: 'heading',
      snippet: 'Title',
    });
    expect(q.blocks[1]!.attrs).toEqual({ source: 'agent' });
    expect(q.truncated).toBe(false);

    expect(mockInvoke).toHaveBeenNthCalledWith(2, NOTE_CMD_QUERY_BLOCKS, {
      params: {
        doc_id: 'doc-tauri',
        text_match: 'hello',
        limit: 50,
      },
    });
  });

  it('业务失败 ok:false 不抛（apply / query / send）', async () => {
    const tauri = createTauriNoteTransport();

    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: false,
        code: 'note.invalid',
        reason: 'doc_id must be non-empty',
      },
    });
    await expect(tauri.applyMd({ docId: '', markdown: 'x' })).resolves.toEqual({
      ok: false,
      code: 'note.invalid',
      reason: 'doc_id must be non-empty',
    });

    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: false,
        code: 'note.unwired',
        reason: 'note backend not wired',
      },
    });
    await expect(tauri.queryBlocks({ docId: 'd' })).resolves.toMatchObject({
      ok: false,
      code: 'note.unwired',
    });

    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: false,
        code: 'note.invalid',
        reason: 'intent_id must be non-empty',
      },
    });
    await expect(
      tauri.sendToNote({
        intentId: '  ',
        markdown: 'x',
        docId: 'd',
      })
    ).resolves.toMatchObject({ ok: false, code: 'note.invalid' });
  });

  it('invoke missing / error 结构化失败不抛', async () => {
    const tauri = createTauriNoteTransport();

    mockInvoke.mockResolvedValueOnce({ status: 'missing' });
    const missing = await tauri.applyMd({ docId: 'd', markdown: 'x' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('note.command_missing');
    }

    mockInvoke.mockResolvedValueOnce({
      status: 'error',
      kind: 'Internal',
      message: 'boom',
    });
    const err = await tauri.sendToNote({
      intentId: 'i',
      markdown: 'x',
      docId: 'd',
    });
    expect(err.ok).toBe(false);
    if (!err.ok) {
      expect(err.code).toBe('Internal');
      expect(err.reason).toContain('boom');
    }

    expect(mockInvoke).toHaveBeenLastCalledWith(NOTE_CMD_SEND_TO_NOTE, {
      req: { intent_id: 'i', markdown: 'x', doc_id: 'd' },
    });
  });
});

describe('createDefaultNoteTransport / resolveNoteTransport', () => {
  beforeEach(() => {
    setDefaultNoteTransport(null);
    mockInvoke.mockReset();
  });

  afterEach(() => {
    setDefaultNoteTransport(null);
    // 清理可能挂上的 Tauri 探测全局
    const w = window as unknown as Record<string, unknown>;
    delete w.__TAURI__;
    delete w.__TAURI_INTERNALS__;
    delete w.isTauri;
  });

  it('无 __TAURI__：默认 Memory（单测/纯浏览器）', async () => {
    expect(isNoteTauriRuntime()).toBe(false);
    const t = createDefaultNoteTransport();
    // Memory 可写可查；不应触发 invoke
    const r = await t.applyMd({ docId: 'def-mem', markdown: 'via default' });
    expect(r.ok).toBe(true);
    const q = await t.queryBlocks({ docId: 'def-mem' });
    expect(q.ok && q.blocks.length).toBe(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('有 __TAURI__：默认 Tauri transport', async () => {
    (window as unknown as { __TAURI__: object }).__TAURI__ = {};
    expect(isNoteTauriRuntime()).toBe(true);

    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: true,
        block_ids: ['t1'],
        inserted: 1,
        idempotent: false,
      },
    });

    const t = createDefaultNoteTransport();
    const r = await t.applyMd({ docId: 'def-tauri', markdown: 'shell' });
    expect(r.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      NOTE_CMD_DOCUMENT_APPLY_MD,
      expect.objectContaining({
        req: expect.objectContaining({ doc_id: 'def-tauri' }),
      })
    );
  });

  it('注入 transport 优先；resolve 尊重模块默认', async () => {
    const mem = createMemoryNoteTransport();
    const t = createNoteTransport({ transport: mem });
    await t.applyMd({ docId: 'd', markdown: 'via inject' });
    const q = await t.queryBlocks({ docId: 'd' });
    expect(q.ok && q.blocks.length).toBe(1);

    setDefaultNoteTransport(mem);
    const resolved = resolveNoteTransport();
    await resolved.applyMd({ docId: 'd2', markdown: 'mod-default' });
    expect(mem.blockCount('d2')).toBe(1);
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
