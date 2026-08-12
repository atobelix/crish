/**
 * 产品 Strict MD 前缀叶提交（SD-22 · CONN-D2 写锥）
 *
 * 绑定工厂见 `noteMdPrefixBridge.binding`；CONN-D3 模拟见
 * `noteMdPrefixBridge.simulate`。公开入口仍为 `noteMdPrefixBridge.ts`。
 *
 * ### composing 铁律
 * 透传库双守卫；composing=true → 不进 sink / wireCalls 不增。
 *
 * ### 诚实
 * 成功仅证明桌面写锥形状通；**≠** A-BLK-08 e2e / **≠ EL-01**。
 * provisional wire = strip `text_edit` + `pending_turn_into_flavour`；
 * UI **禁止**单读 pending 当块 kind。
 */

import {
  commitMdPrefixFromLeaf,
  tryMdPrefixAfterLeafEdit,
  type MdPrefixCommitOptions,
  type MdPrefixLeafSnapshot,
  type TurnIntoIntent,
} from '@crish/block-paper';
import type {
  CommitProductMdPrefixOptions,
  ProductMdPrefixBinding,
  ProductMdPrefixCommitResult,
} from './noteMdPrefixBridge.types';

// ---------------------------------------------------------------------------
// 叶输入产品路径（HiddenInput / TextLeaf 宿主入口）
// ---------------------------------------------------------------------------

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
