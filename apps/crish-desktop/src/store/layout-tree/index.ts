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
} from './dropDetection';

// ── 几何原语（geometry primitives；独立模块，斩断 types→services 反向边）─
// Rect / Pointer 从 dropDetection 上移到独立 geometry.ts，让类型消费不再经
// dropDetection 触达 services/view-registry（store → services 反向边）。
export type { Rect, Pointer } from './geometry';

// ── isPrimaryPanel 注入面（斩断 store → services 反向边）──────────────
// layout-tree 内部需要判断 panel 是否为 primary chat 面板（dropDetection /
// conversationUnit / operations / treePanelAccess 共 4 处）。原本各文件直引
// `services/view-registry` 的 viewRegistry.isPrimary，形成 4 条 store → services
// 反向边。
//
// 本块以**注入式函数指针**替代直接 import：compositionRoot 在 bootstrap 阶段
// 最先注入真实实现（`viewRegistry.isPrimary`），store 内部只调用本门面函数，
// 斩断运行期反向边。默认实现返回 false（未注入时安全降级；注入由
// compositionRoot.buildDefaultRoot 调用 setPrimaryPanelChecker 保证）。
//
// 时序安全：registerBuiltInViews 在 main.tsx startup 最先执行（注册 view），
// 随后 bootstrap-orchestrator → compositionRoot 注入 checker。任何 tree
// 拖拽/分屏操作都在渲染后才可能触发 isPrimaryPanel，故未注入窗口无风险。
let _isPrimaryPanel: (panelId: string) => boolean = () => false;

/** 注入 primary 判定函数（compositionRoot bootstrap 阶段最先调用）。 */
export function setPrimaryPanelChecker(
  fn: (panelId: string) => boolean
): void {
  _isPrimaryPanel = fn;
}

/**
 * 判断 panelId 是否为 primary chat 面板。
 * 由注入函数驱动；未注入时返回 false（安全降级）。
 */
export function isPrimaryPanel(panelId: string): boolean {
  return _isPrimaryPanel(panelId);
}

// ── Store ───────────────────────────────────────────────────────────
export {
  useLayoutTreeStore,
  waitLayoutTreeHydration,
  layoutTreeStorageKey,
} from './layoutTreeStore';
