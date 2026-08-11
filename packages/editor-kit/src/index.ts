/**
 * @crish/editor-kit
 *
 * 块纸面投影控制面（W3-A + W3-B）：
 * - ViewportQuery：窗口 + overscan → 可见索引
 * - HeightMap：预估 + 实测回填 + prefix sum
 * - pin：焦点 + composing 驻留 DOM 不变量
 * - applyProjectionDiff：mock 增量 patch + fullRemount 计数
 * - SelectionStore：逻辑选区（blockId+offset / 块多选）
 * - ImeMachine + structureKeyGuard：composition 状态机与结构键过滤
 *
 * **包边界**（// A-SURF 双 surface 纪律）：
 * - 共享纪律与无状态工具，**不**共享真相
 * - 不接真实 DocSession / RS 权威层；**禁止** re-export yrs / YText
 * - **禁止** 依赖 markdown-editor / 行级 Doc store / lines[] 权威
 * - **禁止** CSS hidden 假虚拟化、像素测距选块
 * - 不实现完整 PM 叶子（W3-D）
 * - surface 常量 re-export 自 `@crish/block-paper-contract`（A-SURF-01/09）
 */

// Viewport
export {
  queryViewport,
  queryViewportByScroll,
  type ViewportWindow,
  type ViewportQueryInput,
  type ViewportQueryResult,
} from './viewport/ViewportQuery';

// HeightMap
export {
  HeightMap,
  STABLE_EPSILON,
  DEFAULT_ESTIMATE_PX,
  type HeightSlot,
} from './viewport/HeightMap';

// pin
export {
  buildPinSet,
  ensureComposingPinned,
  assertComposingPinned,
  checkUnmountAllowed,
  assertUnmountAllowed,
  filterUnmountCandidates,
  validatePinSnapshot,
  PinViolationError,
  type PinViolationCode,
  type PinResult,
  type PinInput,
} from './viewport/pin';

// Diff
export {
  applyProjectionDiff,
  createDiffApplyState,
  type MemoryBlock,
  type DiffApplyState,
  type ApplyDiffStats,
  type ApplyDiffResult,
} from './diff/applyProjectionDiff';

// Selection（W3-B）
export {
  SelectionStore,
  collectPinnedFromSel,
  type LogicPos,
  type LogicRange,
  type BlockMultiSel,
  type EditorSel,
  type SelectionSnapshot,
} from './selection/SelectionStore';

// IME（W3-B）
export {
  ImeMachine,
  type ImePhase,
  type ImeSnapshot,
  type ImeStartResult,
  type ImeEndResult,
} from './ime/ImeMachine';

export {
  guardStructureIntent,
  filterStructureIntents,
  isStructureOrSlashIntent,
  type StructureKeyKind,
  type GuardableIntent,
  type StructureGuardRejectCode,
  type StructureGuardResult,
} from './ime/structureKeyGuard';

// Surface 常量 / 类型（契约 re-export；A-SURF-01 / A-SURF-09）
// 本包不持有产品 store；仅转发枚举供两侧标注
export {
  EDITOR_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
  type EditorSurface,
  type EditorSurfaceId,
} from '@crish/block-paper-contract';
