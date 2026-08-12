/**
 * 产品 Strict MD 前缀叶输入接线（CONN-D2/D3 · 桌面 mdPrefix 写锥）
 *
 * ## 角色
 * - 把库侧 `commitMdPrefixFromLeaf` / `createTurnIntoProvisionalCollabSink`
 *   接到 note-paper / 空态产品路径（与 CONN-B slash 写锥并列、**独立通道**）。
 * - 有 `applyOps` / 注入 `TurnIntoSink` → 可写；无后端 → **disabled**（不假装转块）。
 * - 文本叶 / Strict content-row HiddenInput 在「行首 MD 前缀 + 提交」后调用
 *   `commitProductMdPrefixFromLeaf`（或 `tryProductMdPrefixAfterLeafEdit` /
 *   `simulateProductMdPrefixSubmit`）。
 *
 * ## CONN-D3
 * - Strict content-row 叶宿主（`StrictContentRowLeaf`）→ 本桥产品路径
 * - `simulateProductMdPrefixSubmit`：行首 `# `/`- ` + 提交可测（无 DOM 亦可）
 * - **≠** A-BLK-08/09 全 e2e；**≠ EL-01**；UI **禁止**读 pending 当 kind
 *
 * ## 诚实边界（钉死）
 * - **桌面接线 ≠ 打开完成**；**≠ A-BLK-08/09 全表 e2e**；**≠ EL-01**
 * - provisional wire = strip `text_edit` + `pending_turn_into_flavour`；
 *   真 kind 权威在 RS apply（CONN-D）；mock applyOps **不**证权威
 * - UI **禁止**单读 `pending_turn_into_flavour` 当块 kind（权威是投影 kind）
 * - composing 双守卫（fast_path + submit）**不回退**
 * - **禁止**用本桥 / 库 `mdPrefixHost` 单测关 A-BLK-08/09 / EL-01
 * - **CONN-G2**：product-ipc applyOps 写成功（applied>0）经 adapt 发
 *   `notifyNoteDocWritten(source: product_apply)`；失败/未 applied 不通知；**≠ 打开完成**
 *
 * ## 与 slash 关系
 * - 本文件只走 `TurnIntoSink`；slash 仍走 `IntentSink`（productSlashSink）
 * - 同 `strictApplyOps` 可同时驱动两通道；**不互抹**
 *
 * surface = note-paper；文件域独立，避 SD-04-R StrictPanel 大重构对撞。
 */

import {
  commitMdPrefixFromLeaf,
  createTurnIntoProvisionalCollabSink,
  TextLeafModel,
  tryMdPrefixAfterLeafEdit,
  type ApplyOpsAdapter,
  type MdPrefixCommitOptions,
  type MdPrefixCommitResult,
  type MdPrefixLeafSnapshot,
  type TurnIntoIntent,
  type TurnIntoProvisionalCollabSink,
  type TurnIntoSink,
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

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 解析产品 Strict MD 前缀写锥绑定。
 *
 * 诚实：无后端 **不得** 静默 mock 可写；disabled 由 UI 钉
 * `data-md-prefix-write-mode=disabled`。
 */
export function createProductMdPrefixBinding(
  options: CreateProductMdPrefixBindingOptions = {}
): ProductMdPrefixBinding {
  if (options.turnIntoSink) {
    return {
      mode: 'writable',
      sink: options.turnIntoSink,
      collab: null,
      source: 'injected-sink',
    };
  }

  if (typeof options.applyOps === 'function') {
    const collab = createTurnIntoProvisionalCollabSink(options.applyOps);
    return {
      mode: 'writable',
      sink: collab.sink,
      collab,
      source: options.sourceLabel ?? 'injected-applyOps',
    };
  }

  return {
    mode: 'disabled',
    sink: undefined,
    collab: null,
    source: 'none',
  };
}

// ---------------------------------------------------------------------------
// 叶输入产品路径（HiddenInput / TextLeaf 宿主入口）
// ---------------------------------------------------------------------------

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

/**
 * 产品路径核心：叶快照 → `commitMdPrefixFromLeaf` → 已绑定 TurnInto sink。
 *
 * 宿主典型接线（非 composing 键入空格后，文本叶 / HiddenInput）：
 * ```ts
 * const binding = createProductMdPrefixBinding({ applyOps });
 * const r = await commitProductMdPrefixFromLeaf(
 *   { blockId, text: '# ', caretOffset: 2, isComposing: () => false, fromFlavour: 'paragraph' },
 *   binding
 * );
 * // binding.collab?.wireCalls 可见 pending_turn_into_flavour
 * ```
 *
 * ### composing 铁律
 * 透传库双守卫；composing=true → 不进 sink / wireCalls 不增。
 *
 * ### 诚实
 * 成功仅证明桌面写锥形状通；**≠** A-BLK-08 e2e / **≠** EL-01。
 */
export async function commitProductMdPrefixFromLeaf(
  leaf: MdPrefixLeafSnapshot,
  binding: ProductMdPrefixBinding,
  options: CommitProductMdPrefixOptions = {}
): Promise<ProductMdPrefixCommitResult> {
  if (binding.mode === 'disabled' || !binding.sink) {
    return {
      ok: false,
      stage: 'product',
      code: binding.mode === 'disabled' ? 'disabled' : 'no_sink',
      reason:
        'commitProductMdPrefixFromLeaf：无 TurnInto 写锥（CONN-D2：须 inject applyOps/sink；禁止静默假转块）',
    };
  }
  void options.allowMissingSink;

  const commitOpts: MdPrefixCommitOptions = {
    sink: binding.sink,
  };
  if (options.loose !== undefined) commitOpts.loose = options.loose;
  if (options.createIntentId !== undefined) {
    commitOpts.createIntentId = options.createIntentId;
  }
  if (options.onCommitted !== undefined) {
    commitOpts.onCommitted = options.onCommitted;
  }

  return commitMdPrefixFromLeaf(leaf, commitOpts);
}

/**
 * 叶编辑后尝试 MD 前缀（宿主在 applyLocalEdit / HiddenInput 提交后调用）。
 * 与 `commitProductMdPrefixFromLeaf` 同写锥；不替宿主改叶缓冲。
 */
export async function tryProductMdPrefixAfterLeafEdit(
  leaf: {
    blockId: string;
    getText(): string;
    isComposing(): boolean;
  },
  binding: ProductMdPrefixBinding,
  options: CommitProductMdPrefixOptions & {
    caretOffset?: number;
    fromFlavour?: string;
  } = {}
): Promise<ProductMdPrefixCommitResult> {
  if (binding.mode === 'disabled' || !binding.sink) {
    return {
      ok: false,
      stage: 'product',
      code: binding.mode === 'disabled' ? 'disabled' : 'no_sink',
      reason:
        'tryProductMdPrefixAfterLeafEdit：无 TurnInto 写锥（CONN-D2 disabled）',
    };
  }

  const { allowMissingSink: _a, ...rest } = options;
  void _a;
  return tryMdPrefixAfterLeafEdit(leaf, {
    sink: binding.sink,
    ...rest,
  });
}

/**
 * HiddenInput / 产品键路径形状：用 plain 文本快照模拟「前缀已写入叶缓冲」。
 * **不**碰 DOM；供 Strict 宿主与集成测。真 PM View 键入全链仍可能未接。
 */
export async function commitProductMdPrefixFromPlainText(input: {
  blockId: string;
  /** 含 MD 前缀的 plain 文本（如 `'# '`） */
  text: string;
  caretOffset?: number;
  isComposing?: boolean | (() => boolean);
  fromFlavour?: string;
  binding: ProductMdPrefixBinding;
  createIntentId?: () => string;
  onCommitted?: (intent: TurnIntoIntent) => void;
  loose?: boolean;
}): Promise<ProductMdPrefixCommitResult> {
  const snap: MdPrefixLeafSnapshot = {
    blockId: input.blockId,
    text: input.text,
  };
  if (input.caretOffset !== undefined) snap.caretOffset = input.caretOffset;
  else snap.caretOffset = input.text.length;
  if (input.isComposing !== undefined) snap.isComposing = input.isComposing;
  if (input.fromFlavour !== undefined) snap.fromFlavour = input.fromFlavour;

  const opts: CommitProductMdPrefixOptions = {};
  if (input.createIntentId !== undefined) {
    opts.createIntentId = input.createIntentId;
  }
  if (input.onCommitted !== undefined) opts.onCommitted = input.onCommitted;
  if (input.loose !== undefined) opts.loose = input.loose;

  return commitProductMdPrefixFromLeaf(snap, input.binding, opts);
}

// ---------------------------------------------------------------------------
// CONN-D3：模拟「行首 MD 前缀键入 + 提交」产品路径
// ---------------------------------------------------------------------------

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

/**
 * CONN-D3 产品路径：模拟 Strict 叶「行首 `# `/`- ` + 提交」→ `commitProductMdPrefixFromLeaf`。
 *
 * - 有 binding.sink → 进 TurnInto 写锥；wireCalls 可含 `pending_turn_into_flavour`
 * - disabled / 无 sink → `stage: product` 拒绝，**不**假转块
 * - composing=true → 库双守卫拒绝，wire/sink 不增
 *
 * **不**碰 DOM / PM View；供 vitest 与宿主无 UI 回放。
 * **≠** A-BLK-08/09 全 e2e；**≠ EL-01**。
 */
export async function simulateProductMdPrefixSubmit(
  input: SimulateProductMdPrefixSubmitInput
): Promise<SimulateProductMdPrefixSubmitResult> {
  const leaf = new TextLeafModel(
    input.blockId,
    input.initialText ?? '',
    input.createIntentId ? { createIntentId: input.createIntentId } : undefined
  );

  if (input.composing) {
    leaf.beginComposition(leaf.getText().length);
  }

  const prefix = input.prefixText ?? '';
  const start = leaf.getText().length;
  const textEdit = leaf.applyLocalEdit(start, start, prefix);

  const commit = await commitProductMdPrefixFromLeaf(
    {
      blockId: leaf.blockId,
      text: leaf.getText(),
      caretOffset: leaf.getText().length,
      isComposing: () => leaf.isComposing(),
      fromFlavour: input.fromFlavour ?? 'paragraph',
    },
    input.binding,
    {
      ...(input.createIntentId !== undefined
        ? { createIntentId: input.createIntentId }
        : {}),
      ...(input.onCommitted !== undefined
        ? { onCommitted: input.onCommitted }
        : {}),
      ...(input.loose !== undefined ? { loose: input.loose } : {}),
    }
  );

  return {
    leafText: leaf.getText(),
    textEditIntentId: textEdit?.intentId ?? null,
    wasComposing: leaf.isComposing(),
    commit,
  };
}

/**
 * 从 Strict 面板 props 拼装叶宿主用 binding（无 collab 审计句柄）。
 * EmptyState / 测可用 `createProductMdPrefixBinding` 拿 collab.wireCalls。
 */
export function bindingFromStrictMdPrefixProps(input: {
  turnIntoSink?: TurnIntoSink;
  writeMode?: ProductMdPrefixWriteMode;
  sinkSource?: ProductMdPrefixSinkSource;
}): ProductMdPrefixBinding {
  const hasSink = Boolean(input.turnIntoSink);
  const mode =
    input.writeMode ??
    (hasSink ? ('writable' as const) : ('disabled' as const));
  if (mode === 'disabled' || !input.turnIntoSink) {
    return {
      mode: 'disabled',
      sink: undefined,
      collab: null,
      source: input.sinkSource ?? 'none',
    };
  }
  return {
    mode: 'writable',
    sink: input.turnIntoSink,
    collab: null,
    source: input.sinkSource ?? 'injected-sink',
  };
}

// ---------------------------------------------------------------------------
// Strict 面板写模式解析（轻量；不抢 StrictPanel 大重构）
// ---------------------------------------------------------------------------

export type ResolveStrictMdPrefixBindingInput = {
  turnIntoSink?: TurnIntoSink;
  mdPrefixWriteMode?: ProductMdPrefixWriteMode;
  mdPrefixSinkSource?: ProductMdPrefixSinkSource;
};

export type StrictMdPrefixUiBinding = {
  writeMode: ProductMdPrefixWriteMode;
  sinkSource: ProductMdPrefixSinkSource;
};

/**
 * 解析 Strict 上 MD 前缀写模式与来源诚实标注。
 * 产品默认：无 sink → disabled；有 sink → writable。
 */
export function resolveStrictMdPrefixBinding(
  input: ResolveStrictMdPrefixBindingInput
): StrictMdPrefixUiBinding {
  const hasSink = Boolean(input.turnIntoSink);
  return {
    writeMode: input.mdPrefixWriteMode ?? (hasSink ? 'writable' : 'disabled'),
    sinkSource:
      input.mdPrefixSinkSource ?? (hasSink ? 'injected-sink' : 'none'),
  };
}
