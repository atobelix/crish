/**
 * 笔记 apply_ops 线格式投影与响应解析（SD-34 切开 · wire）
 *
 * 成功时强制 `source='tauri-ipc'`。**≠ EL-01 / EL-08**。
 */

import type { InvokeTypedResult } from './tauriInvoke';
import type {
  NoteApplyOpsIpcFailure,
  NoteApplyOpsIpcOutcome,
  NoteApplyOpsRequest,
} from './noteApplyOpsIpc.types';

export function applyOpsReqToWire(
  req: NoteApplyOpsRequest
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    doc_id: req.docId,
    ops_json: req.opsJson,
  };
  if (req.intentId !== undefined) wire.intent_id = req.intentId;
  if (req.origin !== undefined) wire.origin = req.origin;
  return wire;
}

/** Tauri 外层：对齐 `note_apply_ops(req: ...)` */
export function wrapApplyOpsInvokeArgs(
  req: NoteApplyOpsRequest
): Record<string, unknown> {
  return { req: applyOpsReqToWire(req) };
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function coerceString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function coerceNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.max(0, Math.floor(v));
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Math.max(0, Math.floor(Number(v)));
  }
  return fallback;
}

/**
 * 解析 apply_ops 线格式响应（兼容 snake_case / camelCase）。
 * 成功时 **强制** source=`tauri-ipc`。
 */
export function parseApplyOpsIpcOutcome(raw: unknown): NoteApplyOpsIpcOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'apply_ops 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code ?? rec.reason) || 'note.apply_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'apply_ops 失败',
    };
  }
  if (rec.ok !== true) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'apply_ops 响应缺 ok 字段',
    };
  }

  const docId = coerceString(rec.docId ?? rec.doc_id);
  if (!docId) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'apply_ops 成功响应缺 doc_id',
    };
  }

  const intentRaw = coerceString(rec.intentId ?? rec.intent_id);
  return {
    ok: true,
    docId,
    rev: coerceNum(rec.rev, 0),
    applied: coerceNum(rec.applied, 0),
    source: 'tauri-ipc',
    ...(intentRaw ? { intentId: intentRaw } : {}),
  };
}

export function mapApplyOpsInvokeFailure(
  res: Extract<InvokeTypedResult<unknown>, { status: 'missing' | 'error' }>,
  cmd: string
): NoteApplyOpsIpcFailure {
  if (res.status === 'missing') {
    return {
      ok: false,
      code: 'note.command_missing',
      reason: `笔记 apply_ops 命令不可用（${cmd} 未注册 / 非 Tauri）`,
    };
  }
  return {
    ok: false,
    code: res.kind || 'note.invoke_error',
    reason: res.message || `invoke ${cmd} 失败`,
  };
}
