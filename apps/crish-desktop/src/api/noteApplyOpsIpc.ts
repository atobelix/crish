/**
 * 笔记 collab wire apply IPC 契约（CONN-B3 · 产品 slash / mdPrefix 写锥后端）
 *
 * ## 命令
 * - wire：`note_apply_ops`（`NOTE_CMD_APPLY_OPS`）
 * - 入参：`{ req: { doc_id, ops_json, intent_id?, origin? } }` snake_case
 * - 成功：`{ ok:true, doc_id, rev, applied, source:'tauri-ipc', intent_id? }`
 * - 失败：`{ ok:false, code, reason }`（IPC missing / 业务失败均不抛半态）
 *
 * ## 与产品写锥关系
 * - TS `createCollabApplySink` / `ApplyOpsAdapter` 产出 collab Op 数组 JSON
 * - 本命令 = 桌面真 apply 入口（`DocSession::apply` via `commit_ops`）
 * - 产品默认：`resolveProductStrictApplyOps` —
 *   可检测 Tauri → 本 IPC；**无 Tauri → 不装配（readonly）**；
 *   **禁止** 无后端静默 mock 可写
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠ A-BLK 全表 e2e**；IPC 可测 **≠** 打开完成
 * - mock IPC **仅** 契约测 / 注入测；**禁止** 当生产默认
 * - 无 Tauri 时 `resolveProductStrictApplyOps` 返回 `none`（只读）
 */

import type { ApplyOpsAdapter, IntentSinkResult } from '@crish/block-paper';
import { isNoteTauriRuntime } from './noteApi';
import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';

// ---------------------------------------------------------------------------
// 命令名
// ---------------------------------------------------------------------------

/** Tauri / 前端 IPC：collab wire JSON → DocSession::apply */
export const NOTE_CMD_APPLY_OPS = 'note_apply_ops' as const;

// ---------------------------------------------------------------------------
// 请求 / 线格式
// ---------------------------------------------------------------------------

/** 前端 camelCase 请求 */
export type NoteApplyOpsRequest = {
  docId: string;
  /** collab Op 数组 JSON 字符串（createCollabApplySink wire 形状） */
  opsJson: string;
  /** 幂等 / 审计键（ApplyOpsAdapter meta.intentId） */
  intentId?: string;
  /** user | agent | remote | system；默认 user */
  origin?: string;
};

export type NoteApplyOpsIpcSuccess = {
  ok: true;
  docId: string;
  rev: number;
  applied: number;
  /** 专用 apply_ops 成功时恒为 tauri-ipc（≠ mock 伪装生产） */
  source: 'tauri-ipc';
  intentId?: string;
};

export type NoteApplyOpsIpcFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteApplyOpsIpcOutcome =
  NoteApplyOpsIpcSuccess | NoteApplyOpsIpcFailure;

/**
 * 可注入 apply_ops IPC 面（mock / Tauri）。
 * 产品 Strict 在可检测 Tauri 时经 `resolveProductStrictApplyOps` 默认走此面；
 * **无 Tauri 不得** 静默 mock 可写。
 */
export type NoteApplyOpsIpc = {
  applyOps(req: NoteApplyOpsRequest): Promise<NoteApplyOpsIpcOutcome>;
};

// ---------------------------------------------------------------------------
// snake_case 投影
// ---------------------------------------------------------------------------

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

function mapInvokeFailure(
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

// ---------------------------------------------------------------------------
// Mock IPC（契约测 / 注入测 · **禁止** 生产默认）
// ---------------------------------------------------------------------------

/**
 * 进程内 mock apply_ops IPC：形状与 Tauri 成功/失败一致。
 * **仅** 测 / 显式注入；**禁止** 无 Tauri 时静默当生产默认。
 */
export function createMockNoteApplyOpsIpc(): NoteApplyOpsIpc & {
  clear(): void;
  setNextError(err: { code: string; reason: string } | null): void;
  /** 记录的 apply 调用（wireCalls 串联测） */
  calls: NoteApplyOpsRequest[];
  /** 模拟 rev 水位（每次成功 +applied） */
  revByDoc: Map<string, number>;
} {
  const calls: NoteApplyOpsRequest[] = [];
  const revByDoc = new Map<string, number>();
  let nextError: { code: string; reason: string } | null = null;

  return {
    calls,
    revByDoc,
    clear() {
      calls.length = 0;
      revByDoc.clear();
      nextError = null;
    },
    setNextError(err) {
      nextError = err;
    },
    async applyOps(req) {
      calls.push(req);
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
      if (!req.opsJson?.trim()) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: 'ops_json must be non-empty',
        };
      }
      // 粗计 applied：解析数组长度；非法 JSON → invalid
      let applied = 0;
      try {
        const parsed: unknown = JSON.parse(req.opsJson);
        if (!Array.isArray(parsed)) {
          return {
            ok: false,
            code: 'note.invalid',
            reason: 'ops_json must be a JSON array',
          };
        }
        applied = parsed.length;
      } catch (e) {
        return {
          ok: false,
          code: 'note.invalid',
          reason: `ops_json parse: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const prev = revByDoc.get(docId) ?? 0;
      const rev = applied > 0 ? prev + 1 : prev;
      revByDoc.set(docId, rev);
      return {
        ok: true,
        docId,
        rev,
        applied,
        source: 'tauri-ipc',
        ...(req.intentId?.trim() ? { intentId: req.intentId.trim() } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tauri IPC
// ---------------------------------------------------------------------------

/**
 * 经 `invokeTyped` 调 workbench `note_apply_ops`。
 * 命令缺失 / 业务失败 → ok:false，不抛。
 */
export function createTauriNoteApplyOpsIpc(): NoteApplyOpsIpc {
  return {
    async applyOps(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_APPLY_OPS,
        wrapApplyOpsInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_APPLY_OPS);
      }
      return parseApplyOpsIpcOutcome(res.data);
    },
  };
}

// ---------------------------------------------------------------------------
// ApplyOpsAdapter 适配 + 产品默认解析
// ---------------------------------------------------------------------------

/**
 * 将 `NoteApplyOpsIpc` 适配为库 `ApplyOpsAdapter`（固定 docId）。
 * createCollabApplySink / productSlashSink / mdPrefix 均可注入。
 */
export function adaptNoteApplyOpsIpcAsApplyOps(
  ipc: NoteApplyOpsIpc,
  docId: string,
  options: { origin?: string } = {}
): ApplyOpsAdapter {
  return async (opsJson, meta): Promise<IntentSinkResult> => {
    const outcome = await ipc.applyOps({
      docId,
      opsJson,
      intentId: meta.intentId,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    });
    if (outcome.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `[${outcome.code}] ${outcome.reason}`,
    };
  };
}

/**
 * 产品 Strict apply 能力来源（诚实标注）。
 * - `none`：无后端 → 只读（**默认无 Tauri**）
 * - `product-ipc`：经 note_apply_ops（真 Tauri 或**显式** mock IPC 注入）
 * - `injected-applyOps`：宿主直接注入 ApplyOpsAdapter
 */
export type ProductStrictApplyOpsSource =
  'none' | 'product-ipc' | 'injected-applyOps';

export type ResolveProductStrictApplyOpsOptions = {
  /** 目标文档 id（IPC 必填） */
  docId: string;
  /**
   * 直接注入 ApplyOpsAdapter（测 / 宿主；优先于 IPC）。
   * **≠** 生产静默 mock。
   */
  applyOps?: ApplyOpsAdapter;
  /**
   * 显式注入 apply_ops IPC（测 mock 串联 / 自定义后端）。
   * 有值 → product-ipc 可写路径，**即使** 非 Tauri。
   */
  applyOpsIpc?: NoteApplyOpsIpc;
  /**
   * 覆盖 Tauri 探测（测用）。
   * 未传时使用 `isNoteTauriRuntime()`。
   */
  isTauriRuntime?: boolean;
  /** 透传 origin（默认 user） */
  origin?: string;
};

export type ProductStrictApplyOpsResolution = {
  applyOps: ApplyOpsAdapter | undefined;
  source: ProductStrictApplyOpsSource;
};

/**
 * 解析产品 Strict 空态 / 面板的 **默认 apply 写锥**（CONN-B3）。
 *
 * | 输入 | source | applyOps |
 * |------|--------|----------|
 * | 显式 `applyOps` | injected-applyOps | 透传 |
 * | 显式 `applyOpsIpc` | product-ipc | adapt(ipc, docId) |
 * | 可检测 Tauri | product-ipc | adapt(createTauri..., docId) |
 * | 皆无 | **none** | undefined（只读）|
 *
 * 诚实钉死：
 * - **无 Tauri 且无注入 → readonly**；禁止静默 mock 可写
 * - mock IPC **仅** 经 `applyOpsIpc` 显式注入才进产品绑定
 * - **≠ EL-01**
 */
export function resolveProductStrictApplyOps(
  options: ResolveProductStrictApplyOpsOptions
): ProductStrictApplyOpsResolution {
  if (typeof options.applyOps === 'function') {
    return {
      applyOps: options.applyOps,
      source: 'injected-applyOps',
    };
  }

  const originOpts =
    options.origin !== undefined ? { origin: options.origin } : {};

  if (options.applyOpsIpc) {
    return {
      applyOps: adaptNoteApplyOpsIpcAsApplyOps(
        options.applyOpsIpc,
        options.docId,
        originOpts
      ),
      source: 'product-ipc',
    };
  }

  const tauri =
    options.isTauriRuntime !== undefined
      ? options.isTauriRuntime
      : isNoteTauriRuntime();

  if (tauri) {
    return {
      applyOps: adaptNoteApplyOpsIpcAsApplyOps(
        createTauriNoteApplyOpsIpc(),
        options.docId,
        originOpts
      ),
      source: 'product-ipc',
    };
  }

  return { applyOps: undefined, source: 'none' };
}
