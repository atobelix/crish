/**
 * strictSlashBinding — Strict 面板 slash 写锥解析（SD-04-R / CONN-B）
 *
 * 有 sink → writable + injected-sink；无 → readonly + none。
 * 禁止「可点无写」静默。**≠ EL-01**；**≠ A-BLK-02 e2e**。
 */

import type { IntentSink } from '@crish/block-paper';
import type { SlashOverlayWriteMode } from './SlashMenuOverlay';
import type { ProductSlashSinkSource } from './productSlashSink';

export type ResolveStrictSlashBindingInput = {
  slashIntentSink?: IntentSink;
  /** 写模式覆盖；省略则按 sink 有无 */
  slashWriteMode?: SlashOverlayWriteMode;
  /** 能力来源覆盖；省略则按 sink 有无 */
  slashSinkSource?: ProductSlashSinkSource;
};

export type StrictSlashBinding = {
  writeMode: SlashOverlayWriteMode;
  sinkSource: ProductSlashSinkSource;
};

/**
 * 解析 Strict slash 写模式与 sink 来源诚实标注。
 * 产品默认：无 sink → 只读 catalog；有 sink → 可写。
 */
export function resolveStrictSlashBinding(
  input: ResolveStrictSlashBindingInput
): StrictSlashBinding {
  const hasSink = Boolean(input.slashIntentSink);
  return {
    writeMode: input.slashWriteMode ?? (hasSink ? 'writable' : 'readonly'),
    sinkSource: input.slashSinkSource ?? (hasSink ? 'injected-sink' : 'none'),
  };
}
