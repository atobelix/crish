/**
 * CONN-D3：模拟「行首 MD 前缀键入 + 提交」产品路径（SD-22）
 *
 * 叶提交见 `noteMdPrefixBridge.commit`。公开入口仍为 `noteMdPrefixBridge.ts`。
 *
 * - 有 binding.sink → 进 TurnInto 写锥；wireCalls 可含 `pending_turn_into_flavour`
 * - disabled / 无 sink → `stage: product` 拒绝，**不**假转块
 * - composing=true → 库双守卫拒绝，wire/sink 不增
 *
 * **不**碰 DOM / PM View；供 vitest 与宿主无 UI 回放。
 * **≠** A-BLK-08/09 全 e2e；**≠ EL-01**。
 */

import { TextLeafModel } from '@crish/block-paper';
import { commitProductMdPrefixFromLeaf } from './noteMdPrefixBridge.commit';
import type {
  SimulateProductMdPrefixSubmitInput,
  SimulateProductMdPrefixSubmitResult,
} from './noteMdPrefixBridge.types';

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
