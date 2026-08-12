/**
 * slash 写模式解析（SD-13 · CONN-B）
 *
 * - 显式 readonly → 禁提交（data-slash-write-mode=readonly）
 * - 显式 writable → 允许（有 sink 则 submit，无 sink 则 intent-only）
 * - 未传 → 库测兼容 legacy（不强制只读）
 *
 * **≠ EL-01**；解析器 ≠ 产品 e2e 关。
 */

import type { IntentSink } from '@crish/block-paper';
import type { SlashOverlayWriteMode } from './SlashMenuOverlay.types';

/** 解析后的写模式：显式 | 库测兼容 legacy */
export type ResolvedSlashWriteMode = SlashOverlayWriteMode | 'legacy';

/** data-slash-write-mode 可测取值 */
export type SlashDataWriteMode = 'readonly' | 'writable' | 'intent-only';

/** writeMode prop → 内部解析态 */
export function resolveSlashWriteMode(
  writeMode?: SlashOverlayWriteMode
): ResolvedSlashWriteMode {
  return writeMode ?? 'legacy';
}

export function isSlashReadOnly(resolved: ResolvedSlashWriteMode): boolean {
  return resolved === 'readonly';
}

/**
 * 可测 data-slash-write-mode：
 * - readonly → readonly
 * - 有 sink → writable
 * - 显式 writable 无 sink → writable（意图可写，由调用方 sink）
 * - legacy 无 sink → intent-only
 */
export function toSlashDataWriteMode(
  resolved: ResolvedSlashWriteMode,
  sink: IntentSink | undefined
): SlashDataWriteMode {
  if (resolved === 'readonly') return 'readonly';
  if (sink) return 'writable';
  if (resolved === 'writable') return 'writable';
  return 'intent-only';
}
