/**
 * 二叉树布局 — 公共 API barrel。
 *
 * 仅再导出外部消费者实际使用的符号。
 * 内部跨模块互引应直接走深路径（如 operations.ts → types.ts），
 * 不经过 barrel — barrel 是对外契约，不是内部依赖图。
 *
 * 维护规则：新增内部 API 不自动加入 barrel；仅当外部消费者实际需要时才导出。
 * 这避免"全量再导出"反模式导致的孤儿 API 堆积。
 */

// ── 类型（外部消费者实际引用的） ─────────────────────────────────────
export type {
  LayoutLeaf,
  FlatBranch,
  TreeDragSource,
} from './types';

// ── 业务常量（TreeResizeSash 用） ───────────────────────────────────
export {
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  isBranch,
  isChatDomain,
  isSameDomain,
} from './types';

// ── 查询操作（外部消费者实际引用的） ─────────────────────────────────
export {
  findNodeById,
  collectLeaves,
  flattenTree,
} from './operations';

// ── Drop Detection ──────────────────────────────────────────────────
export {
  detectDropZone,
  findLeafAtPointer,
  rectFromDOM,
  isZoneSame,
  type DropZone,
  type Rect,
} from './dropDetection';

// ── Store ───────────────────────────────────────────────────────────
export { useLayoutTreeStore } from './layoutTreeStore';

// ── 迁移 ───────────────────────────────────────────────────────────
export {
  migrateLayoutIfNeeded,
  __resetMigrationFlagForTests,
} from './migration';
