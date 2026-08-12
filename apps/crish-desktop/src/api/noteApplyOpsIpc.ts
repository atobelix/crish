/**
 * 笔记 collab wire apply IPC 契约（CONN-B3 · 产品 slash / mdPrefix 写锥后端 · SD-34）
 *
 * ## SD-34 切开（主文件 <400 · ≠ EL-01/08）
 * 实现已拆；本文件保持既有 import 路径（EmptyState / G2 测 / B3 测仍从此 barrel）：
 * - `noteApplyOpsIpc.types`：命令名 + 请求 / 成功失败 / IPC 面
 * - `noteApplyOpsIpc.wire`：snake_case 投影 + 响应解析
 * - `noteApplyOpsIpc.mock`：契约测 mock（**禁止** 生产默认）
 * - `noteApplyOpsIpc.tauri`：`invokeTyped` 真 IPC
 * - `noteApplyOpsIpc.adapt`：ApplyOpsAdapter + `resolveProductStrictApplyOps`
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
 * ## CONN-G2 · 写后 Strict 读回（不回退）
 * - `adaptNoteApplyOpsIpcAsApplyOps` 在 IPC **ok 且 applied>0** 时
 *   `notifyNoteDocWritten({ docId, source:'product_apply', intentId? })`
 * - slash（productSlashSink）/ mdPrefix（noteMdPrefixBridge）共用本适配 → 自动走总线
 * - 失败 / applied=0 **不** 通知；**≠ EL-08 / EL-01 / 打开完成**
 *
 * ## 诚实边界
 * - **SD-34 ≠ EL-01**；**≠ EL-08**；**≠ A-BLK 全表 e2e**；IPC 可测 **≠** 打开完成
 * - mock IPC **仅** 契约测 / 注入测；**禁止** 当生产默认
 * - 无 Tauri 时 `resolveProductStrictApplyOps` 返回 `none`（只读）
 * - 切开 / 绿测 **不得** 假关 EL-01 / EL-08
 */

export { NOTE_CMD_APPLY_OPS } from './noteApplyOpsIpc.types';
export type {
  NoteApplyOpsIpc,
  NoteApplyOpsIpcFailure,
  NoteApplyOpsIpcOutcome,
  NoteApplyOpsIpcSuccess,
  NoteApplyOpsRequest,
} from './noteApplyOpsIpc.types';

export {
  applyOpsReqToWire,
  parseApplyOpsIpcOutcome,
  wrapApplyOpsInvokeArgs,
} from './noteApplyOpsIpc.wire';

export {
  createMockNoteApplyOpsIpc,
  type MockNoteApplyOpsIpc,
} from './noteApplyOpsIpc.mock';

export { createTauriNoteApplyOpsIpc } from './noteApplyOpsIpc.tauri';

export {
  adaptNoteApplyOpsIpcAsApplyOps,
  resolveProductStrictApplyOps,
  type ProductStrictApplyOpsResolution,
  type ProductStrictApplyOpsSource,
  type ResolveProductStrictApplyOpsOptions,
} from './noteApplyOpsIpc.adapt';
