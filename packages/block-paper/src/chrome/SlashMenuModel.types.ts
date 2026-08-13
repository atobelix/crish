/**
 * Slash 菜单公开类型（SD-55 · types）。
 *
 * 默认目录 / 过滤见 `slashCatalog`；状态机见 `SlashMenuModel`。
 * 既有调用方仍从 `./SlashMenuModel` 取类型（barrel re-export）。
 *
 * **≠ EL-01**；**≠** 占 SD-13 Overlay / SD-48 DomHost；**≠** 默开 catalog。
 */

import type {
  BlockId,
  IntentId,
  SlashContribution,
} from '@crish/block-paper-contract';
import type { SlashInsertIntent } from './structureIntents';

// ---------------------------------------------------------------------------
// 回调 / 结果
// ---------------------------------------------------------------------------

/** 是否处于 IME composition 的查询回调 */
export type IsComposingFn = () => boolean;

/** 打开结果 */
export type SlashOpenResult =
  | { ok: true; snapshot: SlashMenuSnapshot }
  | {
      ok: false;
      code: 'composing' | 'already_open' | 'invalid_anchor';
      reason: string;
    };

/** 选中 catalog 项 → Intent 结果 */
export type SlashSelectResult =
  | { ok: true; intent: SlashInsertIntent; snapshot: SlashMenuSnapshot }
  | {
      ok: false;
      code:
        | 'composing'
        | 'not_open'
        | 'no_active_item'
        | 'item_not_found'
        | 'invalid_anchor';
      reason: string;
    };

// ---------------------------------------------------------------------------
// 视图 / 快照
// ---------------------------------------------------------------------------

/** 过滤后的菜单项视图 */
export type SlashMenuItemView = {
  id: string;
  title: string;
  description?: string;
  group?: string;
};

/** 只读快照 */
export type SlashMenuSnapshot = {
  open: boolean;
  /** 锚定块 */
  blockId: BlockId | null;
  /** 块内 offset（触发 `/` 的位置） */
  offset: number;
  /** 过滤查询串（`/` 后输入） */
  query: string;
  /** 当前过滤后的可见项 */
  items: SlashMenuItemView[];
  /** 高亮索引（键盘导航） */
  activeIndex: number;
};

/** 构造选项 */
export type SlashMenuModelOptions = {
  /** 注入 IME 查询；默认恒 false */
  isComposing?: IsComposingFn;
  /** 初始菜单项目录；缺省用内置静默样例 */
  catalog?: readonly SlashContribution[];
  /**
   * intentId 工厂；缺省 `nextIntentId('slash')`。
   * 便于宿主对接全局 id 空间 / 单测可预测。
   */
  createIntentId?: () => IntentId;
  /**
   * catalog item id → flavour 映射；缺省 identity（id 即 flavour）。
   */
  resolveFlavour?: (catalogItemId: string) => string;
};
