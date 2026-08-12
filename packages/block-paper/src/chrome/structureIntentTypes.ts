/**
 * 结构 Intent 类型与守卫（SD-08 · structureIntents 三切 · types）
 *
 * 与 `TextLeafModel` 产出的 `text_edit`（文本 Intent）区分：
 * - 文本 Intent：叶子局部替换（W0 `TextEditIntent`）
 * - 结构 Intent：插入 / 删除 / 移动 / 折叠 / slash 选中项
 *
 * 联合：`PaperIntent = TextIntent | StructureIntent | OpIntent(W0)`
 * builders 见 `structureIntentBuilders`；collab wire 见 `structureIntentToWire`。
 *
 * ## 写路径纪律（强制 · W3-D Strict / G-INV-3）
 *
 * - **UI StructureIntent 不得直接写盘 / 旁路 mutate 树**
 * - 必须：`StructureIntent` → ops / wire → `createCollabApplySink` / IPC → RS apply
 * - **≠ EL-01**；禁止 mock sink 冒充 Strict 关闭
 */

import type {
  BlockId,
  IntentId,
  OpIntent,
  TextEditIntent,
} from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// 起源 / 种类
// ---------------------------------------------------------------------------

/**
 * Intent 产生来源（审计 / 宿主路由，非 RS 权威字段）。
 * - slash：slash 菜单确认
 * - chrome：把手 / 批量条 / 多选
 * - keyboard：结构键（Enter/Tab 等，宿主映射后）
 * - drag：拖拽落点
 * - batch：批量工具
 * - unknown：未标注
 */
export type StructureIntentOrigin =
  'slash' | 'chrome' | 'keyboard' | 'drag' | 'batch' | 'unknown';

/** 结构 Intent 的 type 判别字面量 */
export type StructureIntentType =
  | 'insert_block'
  | 'delete_blocks'
  | 'move_blocks'
  | 'toggle_collapse'
  | 'slash_insert';

const STRUCTURE_INTENT_TYPES: ReadonlySet<string> =
  new Set<StructureIntentType>([
    'insert_block',
    'delete_blocks',
    'move_blocks',
    'toggle_collapse',
    'slash_insert',
  ]);

// ---------------------------------------------------------------------------
// 结构 Intent 载荷
// ---------------------------------------------------------------------------

type StructureIntentBase = {
  intentId: IntentId;
  /** 产生来源 */
  origin: StructureIntentOrigin;
};

/** 在 parent 下插入一块（flavour 指定） */
export type InsertBlockIntent = StructureIntentBase & {
  type: 'insert_block';
  /** 父块；根级用 null */
  parentId: BlockId | null;
  /** 插入参考（同级 after）；可选 */
  afterBlockId?: BlockId | null;
  flavour: string;
  /** 可选预分配 id；缺省由 RS 分配 */
  blockIds?: BlockId[];
};

/** 批量删除 */
export type DeleteBlocksIntent = StructureIntentBase & {
  type: 'delete_blocks';
  blockIds: BlockId[];
};

/** 批量移动到 parent + index */
export type MoveBlocksIntent = StructureIntentBase & {
  type: 'move_blocks';
  blockIds: BlockId[];
  parentId: BlockId | null;
  /** 目标父下插入索引；缺省由宿主/RS 约定 */
  index?: number;
};

/** 折叠 / 展开（本地呈现优先；仍走 Intent 以便权威同步） */
export type ToggleCollapseIntent = StructureIntentBase & {
  type: 'toggle_collapse';
  blockIds: BlockId[];
  /**
   * 强制目标态；缺省表示「逐块 toggle」。
   * true = 折叠；false = 展开。
   */
  collapsed?: boolean;
};

/**
 * Slash 选中 catalog 项 → 在锚点处插入/转换块。
 * 语义上是 insert_block 的 slash 特化（带 anchor offset + catalogItemId）。
 */
export type SlashInsertIntent = StructureIntentBase & {
  type: 'slash_insert';
  /** 触发 slash 的锚点块 */
  blockId: BlockId;
  /** 块内 offset（触发 `/` 的位置） */
  offset: number;
  /** 目标 flavour（通常 = catalog item id 或映射后） */
  flavour: string;
  /** 目录项 id（与 SlashContribution.id 对齐） */
  catalogItemId: string;
  /** 可选父块；缺省由锚点推导 */
  parentId?: BlockId | null;
};

export type StructureIntent =
  | InsertBlockIntent
  | DeleteBlocksIntent
  | MoveBlocksIntent
  | ToggleCollapseIntent
  | SlashInsertIntent;

// ---------------------------------------------------------------------------
// PaperIntent 联合（文本 ∪ 结构 ∪ W0 op）
// ---------------------------------------------------------------------------

/** 文本 Intent（与 TextLeafModel 对齐的别名） */
export type TextIntent = TextEditIntent;

/**
 * 纸面可下发 sink 的 Intent 联合。
 * - `TextIntent` / W0 `op`：W3-D 已通
 * - `StructureIntent`：W3-F chrome / slash 接通
 *
 * 注意：UI 扩展 `request_slash` / `structure_key`（editor-kit GuardableIntent）
 * 仍不进 sink，须先映射为本联合成员。
 */
export type PaperIntent = TextIntent | StructureIntent | OpIntent;

// ---------------------------------------------------------------------------
// 类型守卫
// ---------------------------------------------------------------------------

/** 是否为纸面结构 Intent（非 W0 text_edit/op，非 UI 扩展） */
export function isStructureIntent(intent: unknown): intent is StructureIntent {
  if (intent == null || typeof intent !== 'object') return false;
  const t = (intent as { type?: unknown }).type;
  return typeof t === 'string' && STRUCTURE_INTENT_TYPES.has(t);
}

/** 是否为可进 mock/未来 RS sink 的 PaperIntent */
export function isPaperIntent(intent: unknown): intent is PaperIntent {
  if (intent == null || typeof intent !== 'object') return false;
  const t = (intent as { type?: unknown }).type;
  if (t === 'text_edit' || t === 'op') return true;
  return isStructureIntent(intent);
}
