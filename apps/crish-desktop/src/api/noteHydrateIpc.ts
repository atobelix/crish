/**
 * 笔记文档 hydrate / open IPC 契约（真 hydrate 方向 · B-09 延伸）
 *
 * ## 命令
 * - wire：`note_document_hydrate`（`NOTE_CMD_DOCUMENT_HYDRATE`）
 * - 入参：`{ req: { doc_id, limit?, prefer_query? } }` snake_case
 * - 成功：`{ ok:true, doc_id, rev, blocks[], source:'tauri-ipc',
 *           hydrate_path:'doc-session'|'query-blocks', truncated? }`
 * - 失败：`{ ok:false, code, reason }`（IPC missing / 业务失败均不抛半态）
 *
 * ## 与既有 note_* 的关系
 * - `note_query_blocks` = 组合检索摘要；`adaptNoteTransportAsHydrate` → source=`note-transport`
 * - **本命令** = 打开/加载文档后的 **hydrate 投影形状**；`source` 固定 `tauri-ipc`（IPC 通道）
 * - **数据面分轨** `hydrate_path`：
 *   - 默认 `doc-session`：`load_doc` → `DocSession::hydrate` → CDCS 树投影
 *   - `prefer_query` → `query-blocks`：派生索引对照轨（禁止抬 full hydrate）
 * - **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01**
 * - 产品 Strict 默认见 `createProductStrictHydrateTransport`：
 *   可检测 Tauri → 本 IPC（`tauri-ipc`）；无 Tauri → fixture（**≠ 生产权威**）
 *
 * ## 可注入面
 * - `NoteHydrateIpc`：命令契约（mock / Tauri）
 * - Strict 面板适配见 `hydrateProjection.adaptNoteHydrateIpcAsTransport`
 * - `createMockNoteHydrateIpc`：契约测 / 无后端（**禁止** fixture 伪装本 source）
 */

import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';

// ---------------------------------------------------------------------------
// 命令名
// ---------------------------------------------------------------------------

/** Tauri / 前端 IPC：文档 hydrate 投影（open/load 形状） */
export const NOTE_CMD_DOCUMENT_HYDRATE = 'note_document_hydrate' as const;

// ---------------------------------------------------------------------------
// 请求 / 线格式
// ---------------------------------------------------------------------------

/** 后端数据面分轨（与 source=tauri-ipc IPC 通道正交） */
export type NoteHydratePath = 'doc-session' | 'query-blocks';

/** 前端 camelCase 请求 */
export type NoteHydrateDocumentRequest = {
  docId: string;
  /** 块投影条数上限（默认 200，硬上限与 query 对齐） */
  limit?: number;
  /** true → 强制 query 派生轨（对照）；默认 false = doc-session */
  preferQuery?: boolean;
};

/** 线格式成功块（snake_case 兼容 camelCase 解析） */
export type NoteHydrateIpcBlockWire = {
  id: string;
  flavour: string;
  index: number;
  parentId?: string;
  props?: Record<string, unknown>;
  text?: string;
};

export type NoteHydrateIpcSuccess = {
  ok: true;
  docId: string;
  rev: number;
  blocks: NoteHydrateIpcBlockWire[];
  /** 专用 hydrate 命令成功时恒为 tauri-ipc（IPC 通道；≠ fixture） */
  source: 'tauri-ipc';
  /**
   * 数据面分轨：默认 doc-session；preferQuery → query-blocks。
   * mock 未标时解析为 doc-session（与后端默认一致）。
   */
  hydratePath: NoteHydratePath;
  truncated?: boolean;
};

export type NoteHydrateIpcFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteHydrateIpcOutcome =
  NoteHydrateIpcSuccess | NoteHydrateIpcFailure;

/**
 * 桌面/workbench 侧可注入的 hydrate IPC 面。
 * 产品 Strict 在可检测 Tauri 时经 `createProductStrictHydrateTransport` 默认走此面；
 * 无 Tauri / 测环境仍 fixture。成功 source 恒 `tauri-ipc`（≠ fixture 伪装）。
 */
export type NoteHydrateIpc = {
  hydrateDocument(
    req: NoteHydrateDocumentRequest
  ): Promise<NoteHydrateIpcOutcome>;
};

// ---------------------------------------------------------------------------
// snake_case 投影
// ---------------------------------------------------------------------------

export function hydrateReqToWire(
  req: NoteHydrateDocumentRequest
): Record<string, unknown> {
  const wire: Record<string, unknown> = { doc_id: req.docId };
  if (req.limit !== undefined) wire.limit = req.limit;
  if (req.preferQuery !== undefined) wire.prefer_query = req.preferQuery;
  return wire;
}

/** Tauri 外层：对齐 `note_document_hydrate(req: ...)` */
export function wrapHydrateInvokeArgs(
  req: NoteHydrateDocumentRequest
): Record<string, unknown> {
  return { req: hydrateReqToWire(req) };
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function coerceString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function coerceIndex(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return Math.floor(v);
  }
  return fallback;
}

/**
 * 解析 hydrate 线格式响应（兼容 snake_case / camelCase）。
 * 成功时 **强制** source=`tauri-ipc`（禁止 fixture 伪装）。
 */
export function parseHydrateIpcOutcome(raw: unknown): NoteHydrateIpcOutcome {
  const rec = asRec(raw);
  if (!rec) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'hydrate 响应非对象',
    };
  }
  if (rec.ok === false) {
    return {
      ok: false,
      code: coerceString(rec.code ?? rec.reason) || 'note.hydrate_failed',
      reason: coerceString(rec.reason ?? rec.message) || 'hydrate 失败',
    };
  }
  if (rec.ok !== true) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'hydrate 响应缺 ok 字段',
    };
  }

  const docId = coerceString(rec.docId ?? rec.doc_id);
  if (!docId) {
    return {
      ok: false,
      code: 'note.invalid_response',
      reason: 'hydrate 成功响应缺 doc_id',
    };
  }

  const revRaw = rec.rev;
  const rev =
    typeof revRaw === 'number' && Number.isFinite(revRaw)
      ? Math.max(0, Math.floor(revRaw))
      : 1;

  const blocksRaw = rec.blocks;
  const blocks: NoteHydrateIpcBlockWire[] = [];
  if (Array.isArray(blocksRaw)) {
    blocksRaw.forEach((item, i) => {
      const b = asRec(item);
      if (!b) return;
      const id = coerceString(b.id);
      if (!id) return;
      const flavour = coerceString(b.flavour ?? b.kind) || 'paragraph';
      const index = coerceIndex(b.index, i);
      const parentIdRaw = b.parentId ?? b.parent_id;
      const parentId =
        parentIdRaw === undefined || parentIdRaw === null
          ? undefined
          : coerceString(parentIdRaw) || undefined;
      const propsRaw = asRec(b.props ?? b.attrs);
      const textRaw = b.text ?? b.snippet;
      const text =
        textRaw === undefined || textRaw === null
          ? undefined
          : coerceString(textRaw);
      blocks.push({
        id,
        flavour,
        index,
        ...(parentId ? { parentId } : {}),
        ...(propsRaw ? { props: propsRaw } : {}),
        ...(text !== undefined ? { text } : {}),
      });
    });
  }

  const pathRaw = coerceString(rec.hydratePath ?? rec.hydrate_path);
  const hydratePath: NoteHydratePath =
    pathRaw === 'query-blocks' ? 'query-blocks' : 'doc-session';

  return {
    ok: true,
    docId,
    rev,
    blocks,
    source: 'tauri-ipc',
    hydratePath,
    truncated: rec.truncated === true,
  };
}

function mapInvokeFailure(
  res: Extract<InvokeTypedResult<unknown>, { status: 'missing' | 'error' }>,
  cmd: string
): NoteHydrateIpcFailure {
  if (res.status === 'missing') {
    return {
      ok: false,
      code: 'note.command_missing',
      reason: `笔记 hydrate 命令不可用（${cmd} 未注册 / 非 Tauri）`,
    };
  }
  return {
    ok: false,
    code: res.kind || 'note.invoke_error',
    reason: res.message || `invoke ${cmd} 失败`,
  };
}

// ---------------------------------------------------------------------------
// Mock IPC（契约测）
// ---------------------------------------------------------------------------

export type MockNoteHydrateDoc = {
  rev?: number;
  blocks: NoteHydrateIpcBlockWire[];
  truncated?: boolean;
};

/**
 * 进程内 mock hydrate IPC：形状与 Tauri 成功/失败一致。
 * 不宣称产品默认；仅测契约与 adapter。
 */
export function createMockNoteHydrateIpc(
  docs: Record<string, MockNoteHydrateDoc> = {}
): NoteHydrateIpc & {
  seed(docId: string, doc: MockNoteHydrateDoc): void;
  clear(): void;
  setNextError(err: { code: string; reason: string } | null): void;
} {
  const store = new Map<string, MockNoteHydrateDoc>();
  for (const [id, doc] of Object.entries(docs)) {
    store.set(id, doc);
  }
  let nextError: { code: string; reason: string } | null = null;

  return {
    seed(docId, doc) {
      store.set(docId, doc);
    },
    clear() {
      store.clear();
      nextError = null;
    },
    setNextError(err) {
      nextError = err;
    },
    async hydrateDocument(req) {
      if (nextError) {
        const err = nextError;
        nextError = null;
        return { ok: false, code: err.code, reason: err.reason };
      }
      const docId = req.docId?.trim() ?? '';
      if (!docId) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: 'doc_id must be non-empty',
        };
      }
      const doc = store.get(docId);
      if (!doc) {
        // 未 seed = 空投影成功（与 fixture 空 doc 可测 empty 对齐）
        return {
          ok: true,
          docId,
          rev: 0,
          blocks: [],
          source: 'tauri-ipc',
          hydratePath: 'doc-session',
          truncated: false,
        };
      }
      const limit = Math.min(Math.max(req.limit ?? 200, 1), 200);
      const sliced = doc.blocks.slice(0, limit).map((b, i) => ({
        ...b,
        index: b.index ?? i,
      }));
      // mock 默认真路径标签；preferQuery 时标 query-blocks（对照轨可测）
      const hydratePath: NoteHydratePath = req.preferQuery
        ? 'query-blocks'
        : 'doc-session';
      return {
        ok: true,
        docId,
        rev: doc.rev ?? 1,
        blocks: sliced,
        source: 'tauri-ipc',
        hydratePath,
        truncated: doc.truncated === true || doc.blocks.length > limit,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tauri IPC
// ---------------------------------------------------------------------------

/**
 * 经 `invokeTyped` 调 workbench `note_document_hydrate`。
 * 命令缺失 / 业务失败 → ok:false，不抛。
 */
export function createTauriNoteHydrateIpc(): NoteHydrateIpc {
  return {
    async hydrateDocument(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_DOCUMENT_HYDRATE,
        wrapHydrateInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_DOCUMENT_HYDRATE);
      }
      return parseHydrateIpcOutcome(res.data);
    },
  };
}
