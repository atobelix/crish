/**
 * 产品 Strict 空态 slash 写锥绑定（CONN-B / CONN-B3 · 06 链 B）
 *
 * ## 角色
 * - 空态 → Strict 默认 **显式** 解析 slash 写能力：有 `applyOps` / sink → 可写；
 *   无后端 → **只读 catalog**（禁用提交），禁止「可点无写」静默假路径。
 * - 可写时经 `createCollabApplySink`（生产形状）；**禁止** mock 当生产默认。
 * - **CONN-B3**：产品默认后端见 `resolveProductStrictApplyOps`（`noteApplyOpsIpc`）；
 *   有 Tauri / 显式 IPC → `source=product-ipc`；无 → 只读。
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠ A-BLK-02 产品 e2e 满关**
 * - 无 `note_apply_ops` / 无注入时默认只读；**禁止** 静默 mock 可写
 * - fixture hydrate ≠ 可写；读通 ≠ 写锥通
 */

import {
  createCollabApplySink,
  type ApplyOpsAdapter,
  type CollabApplySink,
  type CollabApplySinkOptions,
  type IntentSink,
} from '@crish/block-paper';

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
