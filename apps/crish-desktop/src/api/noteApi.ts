/**
 * 前端笔记 API（Round6–8 · dual-engine-surface §5 / §8 B-05…B-09）
 *
 * noteApi 拆分后主 barrel：Tauri 通路 + transport 组合工厂 + 便捷 API；
 * 对外公开面经 `export *` 全量保留，既有调用方 import 面零改动。
 *
 * - 命令名常量 / 线格式类型 / `NoteTransport` 契约 → `noteApiContracts.ts`
 * - snake_case 编解码 / 响应解析 / invoke 失败映射 → `noteApiWire.ts`
 * - 进程内 Memory transport → `noteApiMemory.ts`
 * - 本文件：`isNoteTauriRuntime` / `createTauriNoteTransport` /
 *   `createNoteTransport` / `createDefaultNoteTransport` 组合工厂 /
 *   set·get·resolveNoteTransport / note* 便捷 API / sink 适配
 *
 * ## 默认 transport 策略（W5-D）
 *
 * | 环境 | 默认通路 | 说明 |
 * |------|----------|------|
 * | 生产 / Tauri（`window.__TAURI__` / `__TAURI_INTERNALS__`） | `createTauriNoteTransport()` | 真命令面；missing/业务失败 → `ok:false`，**不**静默 Memory |
 * | 单测 / 纯浏览器（无 Tauri 全局） | `createMemoryNoteTransport()` | 可测闭环；产品壳仍可 `setDefaultNoteTransport` 注入 |
 * | 调用方显式 `transport` / `setDefaultNoteTransport` | 注入优先 | 覆盖环境默认 |
 *
 * `resolveNoteTransport(override?)` = override → 模块默认 → `createDefaultNoteTransport()`。
 *
 * ## invoke snake_case 映射（前端 camelCase → 后端 wire）
 *
 * Tauri 参数名对齐 `note_commands.rs`：`req` / `params`；字段 snake_case 对齐
 * `agent_tools::note_backend::{NoteApplyMdRequest, NoteQueryBlocksParams}` 与
 * `NoteSendToNoteArgs`。
 *
 * | 前端字段 (camelCase) | wire 字段 (snake_case) | 命令 |
 * |----------------------|------------------------|------|
 * | docId | doc_id | apply / query / send |
 * | markdown | markdown | apply / send |
 * | parentId | parent_id | apply / send |
 * | afterBlockId | after_block_id | apply / send |
 * | mode | mode | apply / send |
 * | intentId | intent_id | apply / send |
 * | batchId | batch_id | apply / send |
 * | messageId | message_id | apply / send |
 * | origin | origin | apply / send |
 * | kindIn | kind_in | query |
 * | attrsEq | attrs_eq | query |
 * | textMatch | text_match | query |
 * | refTo | ref_to | query |
 * | refFrom | ref_from | query |
 * | limit | limit | query |
 *
 * 响应解析兼容 snake_case / camelCase（`block_ids` ↔ `blockIds`）。
 *
 * 纪律：
 * - 写路径仅经 apply_md / send_to_note；禁止 fs.write 当权威
 * - 不静默 onStreamEnd 写笔记（由桥 assertStreamCompleted 守卫）
 * - 本模块不 import 行级 EditorStore
 */

import { invokeTyped } from './tauriInvoke';
import {
  NOTE_CMD_DOCUMENT_APPLY_MD,
  NOTE_CMD_QUERY_BLOCKS,
  NOTE_CMD_SEND_TO_NOTE,
} from './noteApiContracts';
import type {
  NoteApplyMdOutcome,
  NoteApplyMdRequest,
  NoteApplyMode,
  NoteQueryBlocksOutcome,
  NoteQueryBlocksParams,
  NoteSendToNoteRequest,
  NoteTransport,
} from './noteApiContracts';
import {
  mapInvokeFailure,
  parseApplyOutcome,
  parseQueryOutcome,
  wrapApplyInvokeArgs,
  wrapQueryInvokeArgs,
  wrapSendInvokeArgs,
} from './noteApiWire';
import { createMemoryNoteTransport } from './noteApiMemory';

export * from './noteApiContracts';
export * from './noteApiWire';
export * from './noteApiMemory';

// ---------------------------------------------------------------------------
// Tauri runtime 探测 + transport（命令未注册 → missing 结构化失败，不抛）
// ---------------------------------------------------------------------------

/**
 * 是否存在 Tauri 运行时全局（生产桌面壳）。
 * 单测 / Vite 纯浏览器无此全局 → 走 Memory 默认。
 */
export function isNoteTauriRuntime(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      isTauri?: boolean;
    };
    return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri);
  } catch {
    return false;
  }
}

/**
 * 经 `invokeTyped` 调用 workbench 已注册的 note_* 命令。
 * 非 Tauri / 命令缺失 → ok:false + code note.command_missing（不抛）。
 * 业务失败（后端 `{ ok:false, code, reason }`）同样不抛。
 *
 * invoke 参数：外层 `req`/`params` + 内层 snake_case 字段（见 wrap*InvokeArgs）。
 */
export function createTauriNoteTransport(): NoteTransport {
  return {
    async applyMd(req) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_DOCUMENT_APPLY_MD,
        wrapApplyInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_DOCUMENT_APPLY_MD);
      }
      return parseApplyOutcome(res.data);
    },
    async queryBlocks(params) {
      const res = await invokeTyped<unknown>(
        NOTE_CMD_QUERY_BLOCKS,
        wrapQueryInvokeArgs(params)
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
        wrapSendInvokeArgs(req)
      );
      if (res.status !== 'ok') {
        return mapInvokeFailure(res, NOTE_CMD_SEND_TO_NOTE);
      }
      return parseApplyOutcome(res.data);
    },
  };
}

// ---------------------------------------------------------------------------
// 工厂：注入优先 → 环境默认；可选「Tauri missing → Memory」显式 fallback
// ---------------------------------------------------------------------------

export type CreateNoteTransportOptions = {
  /** 显式注入（单测 / 预览壳）；优先使用 */
  transport?: NoteTransport;
  /**
   * 当未注入且选用 Tauri 通路、命令 missing 时，是否回退到进程内 Memory。
   * 默认 false：Tauri 环境内命令缺失应暴露失败，禁止静默假写。
   * （非 Tauri 环境请用 `createDefaultNoteTransport()`，直接 Memory。）
   */
  fallbackMemory?: boolean;
};

/**
 * 构造笔记 transport：
 * 1. 注入 `transport` → 直接用
 * 2. 否则 `createDefaultNoteTransport()`；若 `fallbackMemory` 且当前为 Tauri
 *    且命令 missing → Memory（仅显式开启时）
 */
export function createNoteTransport(
  options: CreateNoteTransportOptions = {}
): NoteTransport {
  if (options.transport) return options.transport;

  const base = createDefaultNoteTransport();
  if (!options.fallbackMemory || !isNoteTauriRuntime()) return base;

  // 仅 Tauri 默认 + 显式 fallback：命令 missing 时落 Memory
  const tauri = base;
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

/**
 * **默认 transport 策略**（W5-D 明确入口）：
 *
 * - 生产 / Tauri 环境（`isNoteTauriRuntime()`）→ `createTauriNoteTransport()`
 * - 单测 / 无 `window.__TAURI__` → `createMemoryNoteTransport()`
 *
 * Tauri 内命令 missing **不会**在此函数内回退 Memory（避免假写）；
 * 需要 missing→Memory 时用 `createNoteTransport({ fallbackMemory: true })`。
 */
export function createDefaultNoteTransport(): NoteTransport {
  if (isNoteTauriRuntime()) {
    return createTauriNoteTransport();
  }
  return createMemoryNoteTransport();
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
 * 解析生效 transport：
 * 1. 调用方 `override`
 * 2. 模块 `setDefaultNoteTransport`
 * 3. `createDefaultNoteTransport()`（Tauri 真通路 / 非 Tauri Memory）
 */
export function resolveNoteTransport(
  override?: NoteTransport | null
): NoteTransport {
  if (override) return override;
  if (defaultNoteTransport) return defaultNoteTransport;
  return createDefaultNoteTransport();
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
