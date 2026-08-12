/**
 * ApplyOpsAdapter 适配 + 产品默认解析（SD-34 切开 · adapt · CONN-G2 / B3）
 *
 * ## CONN-G2
 * `adaptNoteApplyOpsIpcAsApplyOps`：IPC **ok 且 applied>0** 才
 * `notifyNoteDocWritten(source: 'product_apply')`。失败 / applied=0 **不** 通知。
 *
 * ## 无 Tauri
 * `resolveProductStrictApplyOps` 无注入且非 Tauri → source=`none`（只读）。
 * **禁止** 静默 mock 可写。
 *
 * **≠ EL-01**；**≠ EL-08**；切开 / 绿测 ≠ 关账。
 */

import type { ApplyOpsAdapter, IntentSinkResult } from '@crish/block-paper';
import { notifyNoteDocWritten } from '../bridges/note-doc-written';
import { isNoteTauriRuntime } from './noteApi';
import { createTauriNoteApplyOpsIpc } from './noteApplyOpsIpc.tauri';
import type { NoteApplyOpsIpc } from './noteApplyOpsIpc.types';

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
      // CONN-G2：实际有 op 落地才通知 Strict 读回（applied=0 不打扰投影）
      if (outcome.applied > 0) {
        const writtenDocId =
          typeof outcome.docId === 'string' && outcome.docId.length > 0
            ? outcome.docId
            : docId;
        notifyNoteDocWritten({
          docId: writtenDocId,
          intentId: outcome.intentId ?? meta.intentId,
          source: 'product_apply',
        });
      }
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
 * - product-ipc 路径写成功 applied>0 自动走 CONN-G2 总线（见 adapt）
 * - **≠ EL-01**；**≠ EL-08**
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
