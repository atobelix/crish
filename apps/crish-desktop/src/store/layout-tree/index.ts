/**
 * layout-tree package — **binary geometry write owner**.
 *
 * ## Ownership
 *
 * Owns: LayoutTree root, activeLeafId, history, drag/drop zone, leaf sessionId bind
 * (via setLeafSessionId / conversation unit helpers). Mutations only through
 * layoutTreeStore actions + pure `operations.ts` (split/merge/move/resize/applyDrop).
 *
 * Does **not** own:
 * - Tab bar order / openTabs → workspaceShellStore
 * - Session messages / sessions[] → layoutStore (session facade)
 * - UI chrome (sidebar, tabMode) → layoutStore
 *
 * ## Forbidden writes
 *
 * - Components: do not open/focus sessions by mutating the tree alone — shell owns tab lifecycle.
 * - Do not mirror tree into layoutStore.workspaces for the tree workspace path.
 * - Do not invent a second tree store; hydrate/restore must go through this package.
 *
 * ## compositionRoot naming trap
 *
 * `compositionRoot.layout` = **layoutStore** (god chrome/sessions), **not** this package.
 * Tree has no compositionRoot facade yet (residual — hydrate still uses getState).
 *
 * @see ./layoutTreeStore.ts
 * @see ../storeOwnership.ts (`LAYOUT_TREE_OWNERSHIP`)
 *
 * ---
 * Barrel rules: only re-export symbols external consumers use.
 * Internal cross-imports use deep paths (e.g. operations → types), not this barrel.
 * New internal APIs are not auto-exported.
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
  isLeaf,
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

// ── Conversation Unit（session ↔ chat leaf 1:1 绑定） ────────────────
export {
  findChatLeafBySessionId,
  listChatLeaves,
  listToolLeaves,
  findUnitRootId,
  removeUnitBySessionId,
  dedupeDuplicateSessionChatLeaves,
} from './conversationUnit';

// ── Drop Detection ──────────────────────────────────────────────────
export {
  detectDropZone,
  findLeafAtPointer,
  rectFromDOM,
  isZoneSame,
  isUnitScopedDropAllowed,
  type DropZone,
  type Rect,
} from './dropDetection';

// ── Store ───────────────────────────────────────────────────────────
export {
  useLayoutTreeStore,
  waitLayoutTreeHydration,
  layoutTreeStorageKey,
} from './layoutTreeStore';
