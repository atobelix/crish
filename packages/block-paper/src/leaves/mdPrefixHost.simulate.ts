/**
 * 模拟「行首输入 MD 前缀 + 提交」（SD-46 · 产品形状可测）。
 *
 * 公开入口仍为 `mdPrefixHost.ts`（barrel）。
 * **不**碰 DOM / PM View；**只**走注入的 `TurnIntoSink`。
 * **≠ EL-01**；**≠ A-BLK-08/09 e2e**；provisional ≠ kind。
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
import { TextLeafModel } from './TextLeafModel';
import type { TurnIntoSink } from './turnInto';
import {
  commitMdPrefixFromLeaf,
  type MdPrefixCommitOptions,
  type MdPrefixCommitResult,
  type MdPrefixLeafSnapshot,
} from './mdPrefixHost.commit';

export type SimulateMdPrefixSubmitInput = {
  blockId: BlockId;
  /**
   * 行首要键入的前缀全文（如 `'# '` / `'- '` / `'> '`）。
   * 内部经 TextLeafModel.applyLocalEdit 写入，再 commit。
   */
  prefixText: string;
  /** 键入前已有正文；缺省空（纯行首） */
  initialText?: string;
  fromFlavour?: string;
  /**
   * 若 true：叶进入 composing 后再写入前缀，期望被拒。
   * 用于产品路径 composing 回归。
   */
  composing?: boolean;
  /** 透传 createIntentId */
  createIntentId?: () => IntentId;
  loose?: boolean;
};

export type SimulateMdPrefixSubmitResult = {
  /** 叶在 commit 前的 plain 文本 */
  leafText: string;
  /** 非 composing 时 applyLocalEdit 产出的 text_edit；composing 期为 null */
  textEditIntentId: string | null;
  /** 叶 composing 快照（commit 时） */
  wasComposing: boolean;
  commit: MdPrefixCommitResult;
};

/**
 * 模拟「行首输入 MD 前缀 + 提交」完整产品形状：
 * 1. TextLeafModel 写入 prefix
 * 2. `commitMdPrefixFromLeaf` → TurnIntoIntent → 可注入 sink
 *
 * **不**碰 DOM / PM View；供 vitest 与宿主无 UI 回放。
 * RS 真 turn_into Op **仍未做**——sink 侧仅 Intent / provisional wire。
 */
export async function simulateMdPrefixSubmit(
  input: SimulateMdPrefixSubmitInput,
  sink: TurnIntoSink,
  hostOptions: Omit<MdPrefixCommitOptions, 'sink'> = {}
): Promise<SimulateMdPrefixSubmitResult> {
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

  const snapshot: MdPrefixLeafSnapshot = {
    blockId: leaf.blockId,
    text: leaf.getText(),
    caretOffset: leaf.getText().length,
    isComposing: () => leaf.isComposing(),
  };
  if (input.fromFlavour !== undefined) {
    snapshot.fromFlavour = input.fromFlavour;
  }

  const commitOpts: MdPrefixCommitOptions = {
    sink,
  };
  if (hostOptions.loose !== undefined) {
    commitOpts.loose = hostOptions.loose;
  } else if (input.loose !== undefined) {
    commitOpts.loose = input.loose;
  }
  if (hostOptions.createIntentId !== undefined) {
    commitOpts.createIntentId = hostOptions.createIntentId;
  } else if (input.createIntentId !== undefined) {
    commitOpts.createIntentId = input.createIntentId;
  }
  if (hostOptions.onCommitted !== undefined) {
    commitOpts.onCommitted = hostOptions.onCommitted;
  }

  const commit = await commitMdPrefixFromLeaf(snapshot, commitOpts);

  return {
    leafText: leaf.getText(),
    textEditIntentId: textEdit?.intentId ?? null,
    wasComposing: leaf.isComposing(),
    commit,
  };
}
