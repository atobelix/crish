/**
 * ProjectionDiff / DocEvent / MountSpec / Intent 类型草稿。
 *
 * 对齐：`docs/block-workspace-architecture/plans/interfaces/00-W0接口冻结.md` §2–§3
 *
 * 字段语义不可漂移；名称可在 crate 内微调。
 * 本文件仅 TS 契约，不接线 editor-kit / doc-collab 业务。
 */

import type { BlockId, DocId, DocRev, IntentId } from './block-id';

// ---------------------------------------------------------------------------
// ProjectionDiff / DocEvent（01 → 04）
// ---------------------------------------------------------------------------

/**
 * 投影 upsert 条目。
 * 未知块不得由呈现层推断变更；未出现在 upserts = 内容未变。
 */
export type ProjectionUpsert = {
  id: BlockId;
  /** 已校验 schema 子集；具体形状由 flavour schema 约束 */
  props: unknown;
  /** 子块有序 id；折叠时可不下发孙块 */
  children?: BlockId[];
};

/**
 * 投影增量差分。
 *
 * 不变量：
 * - `rev` 单调
 * - 未知块 **不推断** 变更
 * - `fullRebuild` 默认禁止 true；仅灾难恢复，且计入 A-IME-07 / A-COL-03
 */
export type ProjectionDiff = {
  docId: DocId;
  /** 单调版本 */
  rev: DocRev;
  upserts: ProjectionUpsert[];
  removes: BlockId[];
  /** 叶子文本变了，需重投 */
  textTouches: BlockId[];
  /**
   * 仅允许字面 `false` 或省略。
   * 禁止实现波把 `true` 当作默认收敛路径。
   */
  fullRebuild?: false;
};

/**
 * 文档侧 → 呈现侧事件联合。
 */
export type DocEvent =
  | { type: 'projection'; diff: ProjectionDiff }
  | { type: 'reject'; intentId: IntentId; reason: string }
  | { type: 'awareness'; peers: unknown };

// ---------------------------------------------------------------------------
// MountSpec / HeightMap / Intent（04 → 05）
// ---------------------------------------------------------------------------

/** 视口窗口（展开序列上的区间语义由 04 实现钉死；此处锁字段名） */
export type ViewportWindow = {
  startIndex: number;
  endIndex: number;
};

/** 单块高度条目（HeightMap 原子） */
export type HeightEntry = {
  id: BlockId;
  px: number;
  /** true = 估算未回填；false = 实测 */
  estimated: boolean;
};

/**
 * 挂载规格：当前窗口 + pin 集 + 高度图切片。
 *
 * 不变量：
 * - composing 块必须在 `pinned`
 * - 卸载焦点块 = 违规
 */
export type MountSpec = {
  window: ViewportWindow;
  /** 焦点 + composing 等必须驻留 DOM 的块 */
  pinned: BlockId[];
  heights: HeightEntry[];
};

/**
 * HeightMap 逻辑视图：按块 id 的高度表。
 * W0 冻结文中高度嵌在 MountSpec；此别名供 04/05 索引侧复用。
 */
export type HeightMap = ReadonlyMap<BlockId, HeightEntry>;

/**
 * 呈现 → RS 的意图。
 *
 * - `text_edit`：叶子文本局部替换（range + insert）
 * - `op`：结构 / 批量 Op（ops 载荷形状由 conex-doc-collab 钉死，此处 unknown）
 *
 * 每条意图必须带 `intentId`，供 reject / 乐观收敛关联。
 */
export type TextEditIntent = {
  type: 'text_edit';
  blockId: BlockId;
  /** UTF-16 或 grapheme 坐标由 IME 矩阵钉死；此处锁二元组形状 */
  range: [number, number];
  insert: string;
  intentId: IntentId;
};

export type OpIntent = {
  type: 'op';
  ops: unknown[];
  intentId: IntentId;
};

export type Intent = TextEditIntent | OpIntent;
