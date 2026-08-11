/**
 * 前端笔记 API 契约（Round6 · dual-engine-surface §5 / §8 B-05…B-09）
 *
 * - 命令名常量：与未来 Tauri 面 / 工具名对齐（前缀 note_ 为前端 IPC 约定）
 * - `NoteTransport`：可注入写/读通路；有 `@tauri-apps/api/core` 时尝试 invoke
 * - `createMemoryNoteTransport()`：进程内 apply/query/send_to_note，供单测与预览壳
 *
 * 纪律：
 * - 写路径仅经 apply_md / send_to_note；禁止 fs.write 当权威
 * - 不静默 onStreamEnd 写笔记（由桥 assertStreamCompleted 守卫）
 * - 本模块不 import 行级 EditorStore
 */

import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';

// ---------------------------------------------------------------------------
// 命令名常量（前端 IPC / 可与 agent-tools 工具名对照）
// ---------------------------------------------------------------------------

/** Tauri / 前端 IPC：事务化 apply MD 片段 */
export const NOTE_CMD_DOCUMENT_APPLY_MD = 'note_document_apply_md' as const;
/** Tauri / 前端 IPC：组合查询块摘要 */
export const NOTE_CMD_QUERY_BLOCKS = 'note_query_blocks' as const;
/** Tauri / 前端 IPC：显式 send_to_note Intent 写路径 */
export const NOTE_CMD_SEND_TO_NOTE = 'note_send_to_note' as const;

/** agent-tools 工具名（对照，非 IPC 命令） */
export const NOTE_TOOL_DOCUMENT_APPLY_MD = 'document_apply_md' as const;
export const NOTE_TOOL_QUERY_BLOCKS = 'query_blocks' as const;
export const NOTE_TOOL_SEND_TO_NOTE = 'send_to_note' as const;

export const NOTE_COMMANDS = {
  documentApplyMd: NOTE_CMD_DOCUMENT_APPLY_MD,
  queryBlocks: NOTE_CMD_QUERY_BLOCKS,
  sendToNote: NOTE_CMD_SEND_TO_NOTE,
} as const;

// ---------------------------------------------------------------------------
// 线格式类型（前端 camelCase；invoke 时再 snake_case 投影）
// ---------------------------------------------------------------------------

export type NoteApplyMode =
  'apply_md_fragment' | 'insert_blocks' | 'append_to_block';

export type NoteAttrValue = string | number | boolean | null;

/** apply_md / document_apply_md 请求 */
export type NoteApplyMdRequest = {
  docId: string;
  markdown: string;
  parentId?: string;
  afterBlockId?: string;
  mode?: NoteApplyMode;
  /** 幂等键（send_to_note 的 intentId；document_apply_md 可选） */
  intentId?: string;
  batchId?: string;
  messageId?: string;
  origin?: 'user' | 'agent';
};

/** apply 成功结果 */
export type NoteApplyMdResult = {
  ok: true;
  blockIds: string[];
  /** 本次实际新插入块数（幂等 hit 时为 0） */
  inserted: number;
  /** 是否命中幂等缓存 */
  idempotent: boolean;
};

/** apply / send 失败 */
export type NoteApplyMdFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteApplyMdOutcome = NoteApplyMdResult | NoteApplyMdFailure;

/** query_blocks 入参 */
export type NoteQueryBlocksParams = {
  docId: string;
  kindIn?: string[];
  attrsEq?: Record<string, NoteAttrValue>;
  textMatch?: string;
  refTo?: string;
  refFrom?: string;
  /** 默认 50，硬上限 200 */
  limit?: number;
};

/** 单条命中块摘要 */
export type NoteQueryBlockHit = {
  id: string;
  kind: string;
  /** 检索摘要片段，非权威全文 */
  snippet: string;
  attrs: Record<string, NoteAttrValue>;
};

/** query_blocks 出参 */
export type NoteQueryBlocksResult = {
  ok: true;
  blocks: NoteQueryBlockHit[];
  truncated: boolean;
};

export type NoteQueryBlocksFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteQueryBlocksOutcome =
  NoteQueryBlocksResult | NoteQueryBlocksFailure;

/** send_to_note 请求（对齐 Intent 字段，camelCase） */
export type NoteSendToNoteRequest = {
  intentId: string;
  markdown: string;
  docId: string;
  messageId?: string;
  parentId?: string;
  afterBlockId?: string;
  mode?: NoteApplyMode;
  origin?: 'user' | 'agent';
  batchId?: string;
};

// ---------------------------------------------------------------------------
// Transport 契约
// ---------------------------------------------------------------------------

/**
 * 笔记读写通路。产品可注入 Tauri / Memory / 自定义 mock。
 * 失败返回 Result（ok:false），不抛半写态。
 */
export type NoteTransport = {
  applyMd(req: NoteApplyMdRequest): Promise<NoteApplyMdOutcome>;
  queryBlocks(params: NoteQueryBlocksParams): Promise<NoteQueryBlocksOutcome>;
  sendToNote(req: NoteSendToNoteRequest): Promise<NoteApplyMdOutcome>;
};

// ---------------------------------------------------------------------------
// snake_case 投影（未来 Tauri 线格式）
// ---------------------------------------------------------------------------

function applyReqToWire(req: NoteApplyMdRequest): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    doc_id: req.docId,
    markdown: req.markdown,
  };
  if (req.parentId !== undefined) wire.parent_id = req.parentId;
  if (req.afterBlockId !== undefined) wire.after_block_id = req.afterBlockId;
  if (req.mode !== undefined) wire.mode = req.mode;
  if (req.intentId !== undefined) wire.intent_id = req.intentId;
  if (req.batchId !== undefined) wire.batch_id = req.batchId;
  if (req.messageId !== undefined) wire.message_id = req.messageId;
  if (req.origin !== undefined) wire.origin = req.origin;
  return wire;
}

function queryParamsToWire(
  params: NoteQueryBlocksParams
): Record<string, unknown> {
  const wire: Record<string, unknown> = { doc_id: params.docId };
  if (params.kindIn !== undefined) wire.kind_in = params.kindIn;
  if (params.attrsEq !== undefined) wire.attrs_eq = params.attrsEq;
  if (params.textMatch !== undefined) wire.text_match = params.textMatch;
  if (params.refTo !== undefined) wire.ref_to = params.refTo;
  if (params.refFrom !== undefined) wire.ref_from = params.refFrom;
  if (params.limit !== undefined) wire.limit = params.limit;
  return wire;
}

function sendReqToWire(req: NoteSendToNoteRequest): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    intent_id: req.intentId,
    markdown: req.markdown,
    doc_id: req.docId,
  };
  if (req.messageId !== undefined) wire.message_id = req.messageId;
  if (req.parentId !== undefined) wire.parent_id = req.parentId;
  if (req.afterBlockId !== undefined) wire.after_block_id = req.afterBlockId;
  if (req.mode !== undefined) wire.mode = req.mode;
  if (req.origin !== undefined) wire.origin = req.origin;
  if (req.batchId !== undefined) wire.batch_id = req.batchId;
  return wire;
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function coerceString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function coerceBlockIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => coerceString(x)).filter((s) => s.length > 0);
}

/** 解析 apply / send 线格式响应（兼容 camelCase / snake_case） */
export function parseApplyOutcome(raw: unknown): NoteApplyMdOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'apply 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code ?? rec.reason) || 'note.apply_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'apply 失败',
    };
  }
  const blockIds = coerceBlockIds(rec.blockIds ?? rec.block_ids);
  const insertedRaw = rec.inserted;
  const inserted =
    typeof insertedRaw === 'number' && Number.isFinite(insertedRaw)
      ? insertedRaw
      : blockIds.length;
  const idempotent = rec.idempotent === true;
  return {
    ok: true,
    blockIds,
    inserted,
    idempotent,
  };
}

/** 解析 query 线格式响应 */
export function parseQueryOutcome(raw: unknown): NoteQueryBlocksOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'query 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code ?? rec.reason) || 'note.query_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'query 失败',
    };
  }
  const blocksRaw = rec.blocks;
  const blocks: NoteQueryBlockHit[] = [];
  if (Array.isArray(blocksRaw)) {
    for (const item of blocksRaw) {
      const b = asRec(item);
      if (!b) continue;
      const id = coerceString(b.id);
      if (!id) continue;
      const attrsRaw = asRec(b.attrs) ?? {};
      const attrs: Record<string, NoteAttrValue> = {};
      for (const [k, v] of Object.entries(attrsRaw)) {
        if (
          v === null ||
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean'
        ) {
          attrs[k] = v;
        }
      }
      blocks.push({
        id,
        kind: coerceString(b.kind) || 'paragraph',
        snippet: coerceString(b.snippet),
        attrs,
      });
    }
  }
  return {
    ok: true,
    blocks,
    truncated: rec.truncated === true,
  };
}

function mapInvokeFailure(
  res: Extract<InvokeTypedResult<unknown>, { status: 'missing' | 'error' }>,
  cmd: string
): NoteApplyMdFailure {
  if (res.status === 'missing') {
    return {
      ok: false,
      code: 'note.command_missing',
      reason: `笔记命令不可用（${cmd} 未注册 / 非 Tauri）`,
    };
  }
  return {
    ok: false,
    code: res.kind || 'note.invoke_error',
    reason: res.message || `invoke ${cmd} 失败`,
  };
}

// ---------------------------------------------------------------------------
// Memory transport（对齐 agent-tools MemoryNoteBackend 极简语义）
// ---------------------------------------------------------------------------

type MemBlock = {
  id: string;
  kind: string;
  text: string;
  attrs: Record<string, NoteAttrValue>;
  level: number;
};

type MemDoc = { blocks: MemBlock[] };

export type MemoryNoteTransport = NoteTransport & {
  /** 预置文档块（测试夹具）：(id, kind, text) */
  seedDoc(docId: string, blocks: Array<[string, string, string]>): void;
  /** 清空所有文档与幂等缓存 */
  clear(): void;
  /** 当前文档块数（测试） */
  blockCount(docId: string): number;
};

function parseAtxHeading(line: string): number | null {
  let i = 0;
  while (i < line.length && line[i] === '#') i += 1;
  if (i === 0 || i > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  return i;
}

/** 极简 MD 行 → 块草案（kind, text, level） */
function parseMdLines(
  markdown: string
): Array<{ kind: string; text: string; level: number }> {
  const out: Array<{ kind: string; text: string; level: number }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed.trim().length === 0) continue;
    const level = parseAtxHeading(trimmed);
    if (level !== null) {
      const title = trimmed.replace(/^#+\s*/, '').trim();
      out.push({ kind: 'heading', text: title, level });
    } else {
      out.push({ kind: 'paragraph', text: trimmed, level: 0 });
    }
  }
  return out;
}

/**
 * 进程内笔记通路：apply → query 可测闭环。
 * 语义对齐 `crates/agent-tools` MemoryNoteBackend（极简 MD / intent 幂等）。
 */
export function createMemoryNoteTransport(): MemoryNoteTransport {
  const docs = new Map<string, MemDoc>();
  const intents = new Map<string, NoteApplyMdResult>();
  let idSeq = 1;

  const nextId = (): string => {
    const id = `mem-block-${idSeq}`;
    idSeq += 1;
    return id;
  };

  const ensureDoc = (docId: string): MemDoc => {
    let doc = docs.get(docId);
    if (!doc) {
      doc = { blocks: [] };
      docs.set(docId, doc);
    }
    return doc;
  };

  const applyMd = async (
    req: NoteApplyMdRequest
  ): Promise<NoteApplyMdOutcome> => {
    if (typeof req.docId !== 'string' || req.docId.trim().length === 0) {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'doc_id must be non-empty',
      };
    }
    if (typeof req.markdown !== 'string') {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'markdown must be a string snapshot',
      };
    }

    if (req.intentId !== undefined) {
      if (req.intentId.trim().length === 0) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: 'intent_id must be non-empty when provided',
        };
      }
      const prev = intents.get(req.intentId);
      if (prev) {
        return {
          ok: true,
          blockIds: [...prev.blockIds],
          inserted: 0,
          idempotent: true,
        };
      }
    }

    const mode: NoteApplyMode = req.mode ?? 'apply_md_fragment';
    const doc = ensureDoc(req.docId);

    if (mode === 'append_to_block') {
      const tid =
        req.afterBlockId ??
        (doc.blocks.length > 0
          ? doc.blocks[doc.blocks.length - 1]!.id
          : undefined);
      if (!tid) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: 'append_to_block: no target block',
        };
      }
      const block = doc.blocks.find((b) => b.id === tid);
      if (!block) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: `block not found: ${tid}`,
        };
      }
      if (block.text.length > 0 && req.markdown.length > 0) {
        block.text += '\n';
      }
      block.text += req.markdown.replace(/\s+$/, '');
      const result: NoteApplyMdResult = {
        ok: true,
        blockIds: [tid],
        inserted: 0,
        idempotent: false,
      };
      if (req.intentId) {
        intents.set(req.intentId, {
          ok: true,
          blockIds: [...result.blockIds],
          inserted: result.inserted,
          idempotent: false,
        });
      }
      return result;
    }

    let insertAt = doc.blocks.length;
    if (req.afterBlockId) {
      const idx = doc.blocks.findIndex((b) => b.id === req.afterBlockId);
      if (idx < 0) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: `after_block_id not found: ${req.afterBlockId}`,
        };
      }
      insertAt = idx + 1;
    }

    if (req.parentId && doc.blocks.length > 0) {
      if (!doc.blocks.some((b) => b.id === req.parentId)) {
        return {
          ok: false,
          code: 'note.not_found',
          reason: `parent_id not found: ${req.parentId}`,
        };
      }
    }

    const drafts = parseMdLines(req.markdown);
    const newBlocks: MemBlock[] = [];
    const blockIds: string[] = [];
    for (const d of drafts) {
      const id = nextId();
      blockIds.push(id);
      newBlocks.push({
        id,
        kind: d.kind,
        text: d.text,
        attrs: {},
        level: d.level,
      });
    }

    for (let i = 0; i < newBlocks.length; i += 1) {
      doc.blocks.splice(insertAt + i, 0, newBlocks[i]!);
    }

    const result: NoteApplyMdResult = {
      ok: true,
      blockIds,
      inserted: newBlocks.length,
      idempotent: false,
    };
    if (req.intentId) {
      intents.set(req.intentId, {
        ok: true,
        blockIds: [...result.blockIds],
        inserted: result.inserted,
        idempotent: false,
      });
    }
    return result;
  };

  const queryBlocks = async (
    params: NoteQueryBlocksParams
  ): Promise<NoteQueryBlocksOutcome> => {
    if (typeof params.docId !== 'string' || params.docId.trim().length === 0) {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'doc_id must be non-empty',
      };
    }
    const limitRaw = params.limit ?? 50;
    const limit = Math.min(200, Math.max(1, limitRaw));
    const doc = docs.get(params.docId);
    if (!doc) {
      return { ok: true, blocks: [], truncated: false };
    }

    const kindSet =
      params.kindIn && params.kindIn.length > 0 ? new Set(params.kindIn) : null;

    const hits: NoteQueryBlockHit[] = [];
    for (const b of doc.blocks) {
      if (kindSet && !kindSet.has(b.kind)) continue;
      if (
        params.textMatch &&
        params.textMatch.length > 0 &&
        !b.text.includes(params.textMatch)
      ) {
        continue;
      }
      if (params.attrsEq) {
        let ok = true;
        for (const [k, v] of Object.entries(params.attrsEq)) {
          if (b.attrs[k] !== v) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      hits.push({
        id: b.id,
        kind: b.kind,
        snippet: b.text.slice(0, 200),
        attrs: { ...b.attrs },
      });
    }

    const truncated = hits.length > limit;
    return {
      ok: true,
      blocks: truncated ? hits.slice(0, limit) : hits,
      truncated,
    };
  };

  const sendToNote = async (
    req: NoteSendToNoteRequest
  ): Promise<NoteApplyMdOutcome> => {
    if (typeof req.intentId !== 'string' || req.intentId.trim().length === 0) {
      return {
        ok: false,
        code: 'note.invalid',
        reason: 'intent_id must be non-empty',
      };
    }
    return applyMd({
      docId: req.docId,
      markdown: req.markdown,
      parentId: req.parentId,
      afterBlockId: req.afterBlockId,
      mode: req.mode ?? 'apply_md_fragment',
      intentId: req.intentId,
      batchId: req.batchId,
      messageId: req.messageId,
      origin: req.origin ?? 'user',
    });
  };

  return {
    applyMd,
    queryBlocks,
    sendToNote,
    seedDoc(docId, blocks) {
      const doc = ensureDoc(docId);
      for (const [id, kind, text] of blocks) {
        doc.blocks.push({
          id,
          kind,
          text,
          attrs: {},
          level: kind === 'heading' ? 1 : 0,
        });
      }
    },
    clear() {
      docs.clear();
      intents.clear();
      idSeq = 1;
    },
    blockCount(docId) {
      return docs.get(docId)?.blocks.length ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Tauri transport（命令未注册 → missing 结构化失败，不抛）
// ---------------------------------------------------------------------------

/**
 * 经 `invokeTyped` 调用未来 Tauri 笔记命令。
 * 非 Tauri / 命令缺失 → ok:false + code note.command_missing。
 */
export function createTauriNoteTransport(): NoteTransport {
  return {
    async applyMd(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_DOCUMENT_APPLY_MD,
        applyReqToWire(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_DOCUMENT_APPLY_MD);
      }
      return parseApplyOutcome(res.data);
    },
    async queryBlocks(params) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_QUERY_BLOCKS,
        queryParamsToWire(params)
      );
      if (res.status !== 'ok') {
        if (res.status === 'missing') {
          return {
            ok: false,
            code: 'note.command_missing',
            reason: `笔记命令不可用（${NOTE_CMD_QUERY_BLOCKS} 未注册 / 非 Tauri）`,
          };
        }
        return {
          ok: false,
          code: res.kind || 'note.invoke_error',
          reason: res.message || `invoke ${NOTE_CMD_QUERY_BLOCKS} 失败`,
        };
      }
      return parseQueryOutcome(res.data);
    },
    async sendToNote(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_SEND_TO_NOTE,
        sendReqToWire(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_SEND_TO_NOTE);
      }
      return parseApplyOutcome(res.data);
    },
  };
}

// ---------------------------------------------------------------------------
// 工厂：注入优先 → 否则 Tauri；可选 memory fallback
// ---------------------------------------------------------------------------

export type CreateNoteTransportOptions = {
  /** 显式注入（单测 / 预览壳）；优先使用 */
  transport?: NoteTransport;
  /**
   * 当未注入且 Tauri 命令 missing 时，是否回退到进程内 Memory。
   * 默认 false（产品路径应显式注入或等 RS 接线）。
   */
  fallbackMemory?: boolean;
};

/**
 * 构造笔记 transport：
 * 1. 注入 `transport` → 直接用
 * 2. 否则 Tauri invoke；若 `fallbackMemory` 且命令 missing → Memory
 */
export function createNoteTransport(
  options: CreateNoteTransportOptions = {}
): NoteTransport {
  if (options.transport) return options.transport;

  const tauri = createTauriNoteTransport();
  if (!options.fallbackMemory) return tauri;

  const memory = createMemoryNoteTransport();
  return {
    async applyMd(req) {
      const r = await tauri.applyMd(req);
      if (!r.ok && r.code === 'note.command_missing') {
        return memory.applyMd(req);
      }
      return r;
    },
    async queryBlocks(params) {
      const r = await tauri.queryBlocks(params);
      if (!r.ok && r.code === 'note.command_missing') {
        return memory.queryBlocks(params);
      }
      return r;
    },
    async sendToNote(req) {
      const r = await tauri.sendToNote(req);
      if (!r.ok && r.code === 'note.command_missing') {
        return memory.sendToNote(req);
      }
      return r;
    },
  };
}

// ---------------------------------------------------------------------------
// 模块默认 transport（桥接 dispatch 可省略注入）
// ---------------------------------------------------------------------------

let defaultNoteTransport: NoteTransport | null = null;

/** 设置模块默认 NoteTransport（单测 / 预览壳启动时注入 Memory） */
export function setDefaultNoteTransport(transport: NoteTransport | null): void {
  defaultNoteTransport = transport;
}

/** 读取模块默认 transport；未设置时返回 null */
export function getDefaultNoteTransport(): NoteTransport | null {
  return defaultNoteTransport;
}

/**
 * 解析生效 transport：options > 模块默认 > Tauri（无 memory 静默回退，避免假写）
 */
export function resolveNoteTransport(
  override?: NoteTransport | null
): NoteTransport {
  if (override) return override;
  if (defaultNoteTransport) return defaultNoteTransport;
  return createTauriNoteTransport();
}

// ---------------------------------------------------------------------------
// 便捷 API（走 resolveNoteTransport）
// ---------------------------------------------------------------------------

export async function noteDocumentApplyMd(
  req: NoteApplyMdRequest,
  transport?: NoteTransport | null
): Promise<NoteApplyMdOutcome> {
  return resolveNoteTransport(transport).applyMd(req);
}

export async function noteQueryBlocks(
  params: NoteQueryBlocksParams,
  transport?: NoteTransport | null
): Promise<NoteQueryBlocksOutcome> {
  return resolveNoteTransport(transport).queryBlocks(params);
}

export async function noteSendToNote(
  req: NoteSendToNoteRequest,
  transport?: NoteTransport | null
): Promise<NoteApplyMdOutcome> {
  return resolveNoteTransport(transport).sendToNote(req);
}

/**
 * 将 NoteTransport 适配为桥层 SendToNoteSink 形状。
 * 失败 → { ok:false, reason }；成功 → { ok:true, blockIds }。
 */
export function transportAsSendToNoteSink(transport: NoteTransport): (intent: {
  intentId: string;
  source: { markdown: string; messageId: string };
  target: {
    docId: string;
    parentId?: string;
    afterBlockId?: string;
    mode: NoteApplyMode;
  };
  origin: 'user' | 'agent';
}) => Promise<{ ok: boolean; reason?: string; blockIds?: string[] }> {
  return async (intent) => {
    const outcome = await transport.sendToNote({
      intentId: intent.intentId,
      markdown: intent.source.markdown,
      docId: intent.target.docId,
      messageId: intent.source.messageId,
      parentId: intent.target.parentId,
      afterBlockId: intent.target.afterBlockId,
      mode: intent.target.mode,
      origin: intent.origin,
    });
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    return { ok: true, blockIds: [...outcome.blockIds] };
  };
}
