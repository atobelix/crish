/**
 * 产品 Strict MD 前缀写锥类型（SD-22 · noteMdPrefixBridge 切开 · types）
 *
 * 工厂见 `noteMdPrefixBridge.binding`；叶提交见 `noteMdPrefixBridge.commit`；
 * CONN-D3 模拟见 `noteMdPrefixBridge.simulate`。公开入口仍为 `noteMdPrefixBridge.ts`。
 *
 * ## 写锥纪律
 * - 本模块只声明绑定 / 提交结果形状，**不得**写盘、不得另开第二写锥
 * - **≠ EL-01**；**≠ A-BLK-08/09 e2e**；provisional pending ≠ 投影 kind
 */

import type {
  ApplyOpsAdapter,
  MdPrefixCommitOptions,
  MdPrefixCommitResult,
  TurnIntoIntent,
  TurnIntoProvisionalCollabSink,
  TurnIntoSink,
} from '@crish/block-paper';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** MD 前缀写模式：可提交 turn_into / 禁用（无后端） */
export type ProductMdPrefixWriteMode = 'writable' | 'disabled';

/**
 * 写锥能力来源（诚实标注，可测 data 属性）。
 * - `none`：无 applyOps / sink → disabled
 * - `injected-applyOps`：经 createTurnIntoProvisionalCollabSink 包装
 * - `product-ipc`：经 note_apply_ops IPC 适配（CONN-B3）
 * - `injected-sink`：直接注入 TurnIntoSink（测/高级宿主）
 */
export type ProductMdPrefixSinkSource =
  'none' | 'injected-applyOps' | 'product-ipc' | 'injected-sink';

export type CreateProductMdPrefixBindingOptions = {
  /**
   * 真 apply 适配器（DocSession::apply / IPC 等价）。
   * 有值 → 可写 + provisional collab sink；**禁止**空实现冒充生产。
   */
  applyOps?: ApplyOpsAdapter;
  /**
   * 直接注入 TurnInto sink（优先于 applyOps）。
   * 生产默认应优先 `applyOps` + provisional 工厂；本项供测 / 已组好的 sink。
   */
  turnIntoSink?: TurnIntoSink;
  /**
   * 覆盖 source 标注（CONN-B3：`product-ipc`）。
   * 仅当走 `applyOps` 路径时生效；默认 `injected-applyOps`。
   */
  sourceLabel?: Extract<
    ProductMdPrefixSinkSource,
    'injected-applyOps' | 'product-ipc'
  >;
};

/**
 * 产品 Strict MD 前缀写锥绑定结果。
 *
 * | 输入 | mode | sink |
 * |------|------|------|
 * | `turnIntoSink` | writable | 透传 |
 * | `applyOps` | writable | createTurnIntoProvisionalCollabSink(...).sink |
 * | 皆无 | **disabled** | undefined |
 */
export type ProductMdPrefixBinding = {
  mode: ProductMdPrefixWriteMode;
  /** 可写时的 TurnInto sink；disabled 为 undefined */
  sink: TurnIntoSink | undefined;
  /**
   * provisional collab 审计句柄（wireCalls / results）；
   * 仅 `injected-applyOps` 时非 null。测可断言 wireCalls 含 pending；**≠** 关 EL。
   */
  collab: TurnIntoProvisionalCollabSink | null;
  /** 能力来源诚实标注 */
  source: ProductMdPrefixSinkSource;
};

export type CommitProductMdPrefixOptions = Omit<
  MdPrefixCommitOptions,
  'sink'
> & {
  /**
   * 未注入 sink 时是否仍尝试（默认 false → 直接 no_sink 拒绝）。
   * 生产应走 binding.sink；仅诊断可开。
   */
  allowMissingSink?: boolean;
};

export type ProductMdPrefixCommitResult =
  | MdPrefixCommitResult
  | {
      ok: false;
      stage: 'product';
      code: 'no_sink' | 'disabled';
      reason: string;
    };

export type SimulateProductMdPrefixSubmitInput = {
  blockId: string;
  /**
   * 行首要键入的前缀全文（如 `'# '` / `'- '` / `'> '`）。
   * 经 TextLeafModel.applyLocalEdit 写入后再走产品 commit。
   */
  prefixText: string;
  /** 键入前已有正文；缺省空（纯行首） */
  initialText?: string;
  fromFlavour?: string;
  /**
   * 若 true：叶进入 composing 后再写入前缀，期望被拒（双守卫不回退）。
   */
  composing?: boolean;
  binding: ProductMdPrefixBinding;
  createIntentId?: () => string;
  onCommitted?: (intent: TurnIntoIntent) => void;
  loose?: boolean;
};

export type SimulateProductMdPrefixSubmitResult = {
  /** 叶在 commit 前的 plain 文本 */
  leafText: string;
  /** 非 composing 时 applyLocalEdit 产出的 text_edit id；composing 期可能为 null */
  textEditIntentId: string | null;
  wasComposing: boolean;
  commit: ProductMdPrefixCommitResult;
};

export type ResolveStrictMdPrefixBindingInput = {
  turnIntoSink?: TurnIntoSink;
  mdPrefixWriteMode?: ProductMdPrefixWriteMode;
  mdPrefixSinkSource?: ProductMdPrefixSinkSource;
};

export type StrictMdPrefixUiBinding = {
  writeMode: ProductMdPrefixWriteMode;
  sinkSource: ProductMdPrefixSinkSource;
};
