/**
 * BlockChrome 公开类型（SD-40 · types）。
 *
 * 快照投影 / 静默守卫见 `BlockChrome.snapshot`；状态机见 `BlockChromeModel`。
 * 既有调用方仍从 `./BlockChrome` 取类型（barrel re-export）。
 *
 * **≠ EL-01**；**≠ A-BLK 全表 e2e**。
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
import type { StructureIntentOrigin } from './structureIntents';

// ---------------------------------------------------------------------------
// 静默层级 / 把手可见性
// ---------------------------------------------------------------------------

/**
 * 静默模式层级（产品默认 L0）。
 * - `L0`：极净纸面；把手仅 hover/focus；无常驻菜单
 * - `L1`：按需块操作（多选/命令态可抬高 chrome）
 */
export type SilentLevel = 'L0' | 'L1';

/** 单块把手呈现态 */
export type HandleVisibility = 'hidden' | 'hover' | 'focus' | 'multi';

/** chrome 只读快照 */
export type BlockChromeSnapshot = {
  silentLevel: SilentLevel;
  /** 当前悬停块（无则 null） */
  hoveredBlockId: BlockId | null;
  /** 当前焦点块（无则 null） */
  focusedBlockId: BlockId | null;
  /** 多选高亮的有序 blockId（逻辑 id，非像素推导） */
  multiSelectedIds: BlockId[];
  /** 折叠中的块 id 集合（拷贝） */
  collapsedIds: BlockId[];
  /**
   * 是否处于「命令态」（slash 打开 / 批量操作条等）。
   * true 时允许 L1 级 chrome 露出；关闭后回到 silentLevel 默认。
   */
  commandActive: boolean;
};

// ---------------------------------------------------------------------------
// 结构操作结果（W3-F）
// ---------------------------------------------------------------------------

/** 危险/批量结构操作拒绝码 */
export type ChromeStructureRejectCode =
  'empty_selection' | 'silent_l0_guard' | 'invalid_target';

export type ChromeStructureResult<T> =
  | { ok: true; intent: T; snapshot: BlockChromeSnapshot }
  | {
      ok: false;
      code: ChromeStructureRejectCode;
      reason: string;
    };

export type ChromeStructureOptions = {
  /** intentId 工厂；缺省 nextIntentId('chrome') */
  createIntentId?: () => IntentId;
  /** 覆盖 origin；缺省 chrome / batch */
  origin?: StructureIntentOrigin;
  /**
   * 显式 blockIds；缺省用 multiSelectedIds。
   * 在 L0 且无多选/命令态时，显式传入仍受 silent_l0_guard（危险操作）。
   */
  blockIds?: readonly BlockId[];
};

/** `BlockChromeModel` 构造选项 */
export type BlockChromeModelOptions = {
  createIntentId?: () => IntentId;
};
