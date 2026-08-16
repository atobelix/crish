/**
 * 产品 Strict 空态 slash 写锥绑定（CONN-B / CONN-B3 · 06 链 B）
 *
 * ## 角色
 * - 空态 → Strict 默认 **显式** 解析 slash 写能力：有 `applyOps` / sink → 可写；
 *   无后端 → **只读 catalog**（禁用提交），禁止「可点无写」静默假路径。
 * - 可写时经 `createCollabApplySink`（生产形状）；**禁止** mock 当生产默认。
 * - **CONN-B3**：产品默认后端见 `resolveProductStrictApplyOps`（`noteApplyOpsIpc`）；
 *   有 Tauri / 显式 IPC → `source=product-ipc`；无 → 只读。
 * - **CONN-G2**：product-ipc 写成功（applied>0）经 adapt 发 `notifyNoteDocWritten(source: product_apply)`，
 *   同 doc Strict hydrate 读回；**≠ EL-08 / EL-01 / 打开完成**。
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠ A-BLK-02 产品 e2e 满关**
 * - 无 `note_apply_ops` / 无注入时默认只读；**禁止** 静默 mock 可写
 * - fixture hydrate ≠ 可写；读通 ≠ 写锥通
 *
 * ## R2-b ⑥ 冲突失效（主控裁决② 接线）
 * collab apply 拒绝（applyOps 返回 ok:false / wire 映射失败 / 抛错）→
 * 经 `createCollabApplySink` 的 `onApplyRejected` 钩子绑定块域编辑会话
 * `invalidateEditSession(blockId, 'collab-conflict')`——不自动合并、不静默 LWW；
 * 块域编辑面立即失效，UI 展示冲突并让用户重新确认/丢弃本地编辑。
 */

import {
  createCollabApplySink,
  type ApplyOpsAdapter,
  type CollabApplySink,
  type CollabApplySinkOptions,
  type IntentSink,
  type PaperIntent,
} from '@crish/block-paper';
import { invalidateEditSession } from '../../api/editSession';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** slash 写模式：可提交 / 只读 catalog（禁提交） */
export type ProductSlashWriteMode = 'writable' | 'readonly';

/**
 * 写锥能力来源（诚实标注，可测 data 属性）。
 * - `none`：无 applyOps / sink → 只读
 * - `injected-applyOps`：宿主直接注入 ApplyOpsAdapter + createCollabApplySink
 * - `product-ipc`：经 note_apply_ops IPC 适配（CONN-B3；真 Tauri 或显式 mock IPC）
 * - `injected-sink`：直接注入 IntentSink（测/高级宿主；须调用方自证形状）
 */
export type ProductSlashSinkSource =
  'none' | 'injected-applyOps' | 'product-ipc' | 'injected-sink';

export type CreateProductStrictSlashBindingOptions = {
  /**
   * 真 apply 适配器（DocSession::apply / IPC 等价）。
   * 有值 → 可写 + `createCollabApplySink`；**禁止**空实现冒充生产。
   */
  applyOps?: ApplyOpsAdapter;
  /**
   * 直接注入 Intent sink（优先于 applyOps）。
   * 生产默认应优先 `applyOps` + collab 工厂；本项供测 / 已组好的 sink。
   */
  slashIntentSink?: IntentSink;
  /**
   * 覆盖 source 标注（CONN-B3：`product-ipc`）。
   * 仅当走 `applyOps` 路径时生效；默认 `injected-applyOps`。
   */
  sourceLabel?: Extract<
    ProductSlashSinkSource,
    'injected-applyOps' | 'product-ipc'
  >;
  /** wire 选项：块 id 分配（slash insert） */
  allocateId?: CollabApplySinkOptions['allocateId'];
  /** wire 选项：order key */
  resolveOrder?: CollabApplySinkOptions['resolveOrder'];
  /** 其余 StructureToOps 选项透传 */
  wireOptions?: Omit<
    CollabApplySinkOptions,
    'applyOps' | 'allocateId' | 'resolveOrder'
  >;
};

/** 产品 Strict slash 写锥绑定结果 */
export type ProductStrictSlashBinding = {
  /** 可写 / 只读 */
  mode: ProductSlashWriteMode;
  /** 可写时的 sink；只读为 undefined */
  sink: IntentSink | undefined;
  /**
   * collab 审计句柄（wireCalls / results）；仅 `injected-applyOps` 时非 null。
   * 测可断言 wireCalls；**≠** mock.calls 关 EL。
   */
  collab: CollabApplySink | null;
  /** 能力来源诚实标注 */
  source: ProductSlashSinkSource;
};

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * R2-b ⑥ 冲突失效助手：从被拒 intent 中提取受影响块 id（供编辑会话失效广播）。
 * - `TextEditIntent` / `SlashInsertIntent`：单块 `blockId`；
 * - `DeleteBlocksIntent` / `MoveBlocksIntent` / `ToggleCollapseIntent`：批量 `blockIds`；
 * - `OpIntent` / `InsertBlockIntent`（parentId 语义，非被编辑块）：无 → 空数组（不误失效）。
 */
function rejectedIntentBlockIds(intent: PaperIntent): string[] {
  if ('blockId' in intent && typeof intent.blockId === 'string') {
    return [intent.blockId];
  }
  if ('blockIds' in intent && Array.isArray(intent.blockIds)) {
    return intent.blockIds;
  }
  return [];
}

/**
 * 解析产品 Strict 空态 slash 写锥绑定。
 *
 * | 输入 | mode | sink |
 * |------|------|------|
 * | `slashIntentSink` | writable | 透传 |
 * | `applyOps` | writable | createCollabApplySink(...).sink |
 * | 皆无 | **readonly** | undefined |
 *
 * 诚实：无后端 **不得** 静默 mock 可写；只读态由 UI 钉死 data-slash-write-mode。
 */
export function createProductStrictSlashBinding(
  options: CreateProductStrictSlashBindingOptions = {}
): ProductStrictSlashBinding {
  if (options.slashIntentSink) {
    return {
      mode: 'writable',
      sink: options.slashIntentSink,
      collab: null,
      source: 'injected-sink',
    };
  }

  if (typeof options.applyOps === 'function') {
    const collab = createCollabApplySink({
      applyOps: options.applyOps,
      // R2-b ⑥ 宿主接线（主控裁决②）：apply 拒绝（冲突/rev 不符/wire 失败/抛错）
      // → 绑定块域编辑会话 invalidate('collab-conflict')——只通知不改结果
      // （ok:false 透传，submitIntent 侧 code='sink_reject' 语义不变）
      onApplyRejected: ({ intent }) => {
        for (const blockId of rejectedIntentBlockIds(intent)) {
          invalidateEditSession(blockId, 'collab-conflict');
        }
      },
      ...(options.allocateId !== undefined
        ? { allocateId: options.allocateId }
        : {}),
      ...(options.resolveOrder !== undefined
        ? { resolveOrder: options.resolveOrder }
        : {}),
      ...(options.wireOptions ?? {}),
    });
    return {
      mode: 'writable',
      sink: collab.sink,
      collab,
      source: options.sourceLabel ?? 'injected-applyOps',
    };
  }

  return {
    mode: 'readonly',
    sink: undefined,
    collab: null,
    source: 'none',
  };
}
