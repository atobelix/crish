/**
 * 前端笔记 API 契约 · 线格式编解码（noteApi 拆分后子模块 ②）
 *
 * - snake_case 投影：applyReqToWire / queryParamsToWire / sendReqToWire
 * - invoke 参数包装：wrapApplyInvokeArgs / wrapQueryInvokeArgs / wrapSendInvokeArgs
 * - 响应解析：parseApplyOutcome / parseQueryOutcome（兼容 snake_case / camelCase）
 * - invoke 失败映射：mapInvokeFailure（Tauri 通路共用）
 *
 * 类型契约见 `noteApiContracts.ts`；Tauri 通路 / 组合工厂见主 barrel `noteApi.ts`。
 */

import type {
  NoteApplyMdFailure,
  NoteApplyMdOutcome,
  NoteApplyMdRequest,
  NoteAttrValue,
  NoteQueryBlockHit,
  NoteQueryBlocksOutcome,
  NoteQueryBlocksParams,
  NoteRedoTextRequest,
  NoteSendToNoteRequest,
  NoteUndoOutcome,
  NoteUndoTextRequest,
} from './noteApiContracts';
import type { InvokeTypedResult } from './tauriInvoke';

// ---------------------------------------------------------------------------
// snake_case 投影（对齐 note_commands.rs / note_backend 线格式）
// ---------------------------------------------------------------------------

/**
 * apply_md 请求 → wire 字段（snake_case）。
 * Tauri 外层参数名见 `wrapApplyInvokeArgs`（`req`）。
 */
export function applyReqToWire(
  req: NoteApplyMdRequest
): Record<string, unknown> {
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

/**
 * query_blocks 入参 → wire 字段（snake_case）。
 * Tauri 外层参数名见 `wrapQueryInvokeArgs`（`params`）。
 */
export function queryParamsToWire(
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

/**
 * send_to_note 请求 → wire 字段（snake_case）。
 * Tauri 外层参数名见 `wrapSendInvokeArgs`（`req`）。
 */
export function sendReqToWire(
  req: NoteSendToNoteRequest
): Record<string, unknown> {
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

/** Tauri invoke 参数：对齐 `note_document_apply_md(req: NoteApplyMdRequest)` */
export function wrapApplyInvokeArgs(
  req: NoteApplyMdRequest
): Record<string, unknown> {
  return { req: applyReqToWire(req) };
}

/** Tauri invoke 参数：对齐 `note_query_blocks(params: NoteQueryBlocksParams)` */
export function wrapQueryInvokeArgs(
  params: NoteQueryBlocksParams
): Record<string, unknown> {
  return { params: queryParamsToWire(params) };
}

/** Tauri invoke 参数：对齐 `note_send_to_note(req: NoteSendToNoteArgs)` */
export function wrapSendInvokeArgs(
  req: NoteSendToNoteRequest
): Record<string, unknown> {
  return { req: sendReqToWire(req) };
}

/**
 * undo_text 请求 → wire 字段（snake_case）。
 */
export function undoReqToWire(
  req: NoteUndoTextRequest
): Record<string, unknown> {
  return {
    doc_id: req.docId,
    block_id: req.blockId,
  };
}

/**
 * redo_text 请求 → wire 字段（snake_case）。
 */
export function redoReqToWire(
  req: NoteRedoTextRequest
): Record<string, unknown> {
  return {
    doc_id: req.docId,
    block_id: req.blockId,
  };
}

export function wrapUndoInvokeArgs(
  req: NoteUndoTextRequest
): Record<string, unknown> {
  return { req: undoReqToWire(req) };
}

export function wrapRedoInvokeArgs(
  req: NoteRedoTextRequest
): Record<string, unknown> {
  return { req: redoReqToWire(req) };
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

export function mapInvokeFailure(
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

/** 解析 undo / redo 线格式响应 */
export function parseUndoOutcome(raw: unknown): NoteUndoOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'undo/redo 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code ?? rec.reason) || 'note.undo_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'undo/redo 失败',
    };
  }
  return {
    ok: true,
    docId: coerceString(rec.docId ?? rec.doc_id),
    blockId: coerceString(rec.blockId ?? rec.block_id),
    rev: typeof rec.rev === 'number' ? rec.rev : Number(rec.rev) || 0,
    text: coerceString(rec.text),
    isNoop: rec.isNoop === true || rec.is_noop === true,
    source: typeof rec.source === 'string' ? rec.source : undefined,
  };
}
