/**
 * 产品 Strict 默认 hydrate 工厂（SD-24 切开 · product factory）
 *
 * - 可检测 Tauri → `tauri-ipc`（`note_document_hydrate`）
 * - 无 Tauri → `fixture`（`createEmptyStateStrictDemoTransport`）
 * - **禁止** 无 Tauri 时返回 tauri-ipc；**禁止** fixture 伪装 ipc
 * - **≠** 打开完成（G-HYD）；**≠ EL-01/04/08**
 */

import {
  createTauriNoteHydrateIpc,
  type NoteHydrateIpc,
} from '../../api/noteHydrateIpc';
import { isNoteTauriRuntime } from '../../api/noteApi';
import { adaptNoteHydrateIpcAsTransport } from './hydrateProjection.adapt';
import { createEmptyStateStrictDemoTransport } from './hydrateProjection.fixture';
import type { NoteHydrateTransport } from './hydrateProjection.types';

/**
 * 产品 Strict 空态选用的 hydrate 来源。
 * - `tauri-ipc`：可检测 Tauri 运行时，走 `note_document_hydrate`
 * - `fixture`：无 Tauri（单测 / 纯浏览器），保留演示轨
 */
export type ProductStrictHydrateSource = 'tauri-ipc' | 'fixture';

export type ResolveProductStrictHydrateSourceOptions = {
  /**
   * 覆盖运行时探测（单测注入）。
   * 未传时使用 `isNoteTauriRuntime()`（`__TAURI__` / `__TAURI_INTERNALS__` / `isTauri`）。
   */
  isTauriRuntime?: boolean;
};

/**
 * 解析产品 Strict 默认 hydrate 来源（纯选择逻辑，可单测）。
 *
 * 纪律：
 * - **禁止** 无 Tauri 时返回 tauri-ipc（否则 fixture 伪装）
 * - **禁止** 用 fixture 响应字符串冒充 ipc source
 * - 选择 tauri-ipc **≠** 打开完成（G-HYD 全条件）/ **≠** EL-04/01
 */
export function resolveProductStrictHydrateSource(
  options: ResolveProductStrictHydrateSourceOptions = {}
): ProductStrictHydrateSource {
  const tauri =
    options.isTauriRuntime !== undefined
      ? options.isTauriRuntime
      : isNoteTauriRuntime();
  return tauri ? 'tauri-ipc' : 'fixture';
}

export type CreateProductStrictHydrateTransportOptions =
  ResolveProductStrictHydrateSourceOptions & {
    /**
     * 注入 hydrate IPC（测 mock / 自定义后端）。
     * 仅当解析结果为 `tauri-ipc` 时使用；未传则 `createTauriNoteHydrateIpc()`。
     */
    hydrateIpc?: NoteHydrateIpc;
  };

/**
 * 工作区空态打开 Strict 面板时的 **产品默认** hydrate 通路。
 *
 * | 环境 | 默认 source | transport |
 * |------|-------------|---------|
 * | 可检测 Tauri | `tauri-ipc` | `adaptNoteHydrateIpcAsTransport(createTauriNoteHydrateIpc())` |
 * | 无 Tauri | `fixture` | `createEmptyStateStrictDemoTransport(docId)` |
 *
 * 诚实边界（钉死 · R10）：
 * - **fixture ≠ 生产权威**；无 Tauri 回退 fixture **不是** 伪装 ipc
 * - 有 Tauri 时失败/空/成功走真 IPC 三态，**不**静默回退 fixture
 * - **≠ 打开完成**（G-HYD 全条件）；**≠ EL-01/EL-04/EL-08**
 * - 后端默认 `hydrate_path=doc-session`（真 DocSession 投影）；
 *   产品「打开完成」叙事仍须 G-HYD 全条件，本工厂不关账
 * - 调用方可经 `WorkspaceEmptyState.strictHydrateTransport` 覆盖
 */
export function createProductStrictHydrateTransport(
  docId: string,
  options: CreateProductStrictHydrateTransportOptions = {}
): NoteHydrateTransport {
  const source = resolveProductStrictHydrateSource(options);
  if (source === 'tauri-ipc') {
    const ipc = options.hydrateIpc ?? createTauriNoteHydrateIpc();
    return adaptNoteHydrateIpcAsTransport(ipc);
  }
  return createEmptyStateStrictDemoTransport(docId);
}
