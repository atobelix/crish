/**
 * 块 chrome 状态模型（纯 TS，可测）。
 *
 * 覆盖：
 * - 静默默认（L0）：无常驻把手 / 菜单噪声（A-SIL-01）
 * - 把手悬停 / 焦点显隐（按需 chrome，A-SIL-02）
 * - 折叠（collapsed）本地呈现态
 * - 多选高亮 set / clear（逻辑 blockId，禁止像素测距）
 * - **W3-F**：多选删除 / 折叠 → 批量结构 Intent（经 submitIntent → sink）
 *
 * 呈现源：UI / **`BlockChromeDomHost`** 以本 store 为投影输入。
 * **禁止** DOM 当真相；写路径必须 Intent → **`createCollabApplySink`** → RS apply。
 *
 * ## 轨
 * - **W3-F Strict 子集**：`requestDeleteSelected` → `delete_blocks` → collab sink（见 `chrome.w3f_apply.test.ts`）
 * - mock sink **仅**形状（`chrome.w3f.test.ts`）；**≠** Strict 关闭证据
 * - **W3-F DOM 余量**：`BlockChromeDomHost` 把手/多选框 DOM（`chrome.w3f_dom.test.ts`）
 * - **桌面 React chrome 挂载已交**（`BlockChromeDomMount`）；**DOM 交付 ≠ EL-01**
 * - **仍未交付（精确）**：A-BLK 全表 e2e、真 Pointer 拖拽产品 e2e、产品级 chrome 交互 e2e
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
// SD-05：中性 intentId；禁止 chrome→TextLeafModel 仅为 id
import { nextIntentId } from '../intentId';
import {
  buildDeleteBlocksIntent,
  buildToggleCollapseIntent,
  type DeleteBlocksIntent,
  type StructureIntentOrigin,
  type ToggleCollapseIntent,
} from './structureIntents';

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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * 块 chrome 状态机。
 *
 * 默认 L0 静默：无 hover/focus/多选/命令时，所有把手 hidden。
 * 危险批量操作（删除）在纯 L0 且无多选/命令抬升时拒绝（A-SIL）。
 */
export class BlockChromeModel {
  private silentLevel: SilentLevel = 'L0';
  private hoveredBlockId: BlockId | null = null;
  private focusedBlockId: BlockId | null = null;
  private multiSelectedIds: BlockId[] = [];
  private collapsed = new Set<BlockId>();
  private commandActive = false;
  private readonly createIntentId: () => IntentId;

  constructor(options: { createIntentId?: () => IntentId } = {}) {
    this.createIntentId =
      options.createIntentId ?? (() => nextIntentId('chrome'));
  }

  // -----------------------------------------------------------------------
  // 静默层级
  // -----------------------------------------------------------------------

  setSilentLevel(level: SilentLevel): BlockChromeSnapshot {
    this.silentLevel = level;
    return this.getSnapshot();
  }

  getSilentLevel(): SilentLevel {
    return this.silentLevel;
  }

  // -----------------------------------------------------------------------
  // 把手：hover / focus
  // -----------------------------------------------------------------------

  /** 悬停块（null = 离开） */
  setHovered(blockId: BlockId | null): BlockChromeSnapshot {
    this.hoveredBlockId = blockId && blockId.length > 0 ? blockId : null;
    return this.getSnapshot();
  }

  /** 焦点块（null = 失焦） */
  setFocused(blockId: BlockId | null): BlockChromeSnapshot {
    this.focusedBlockId = blockId && blockId.length > 0 ? blockId : null;
    return this.getSnapshot();
  }

  /**
   * 计算指定块的把手可见性（A-SIL 按需）。
   *
   * 优先级：multi > focus > hover > hidden
   * L0 且无交互 → 一律 hidden（默认纸面无噪声）
   */
  getHandleVisibility(blockId: BlockId): HandleVisibility {
    if (!blockId) return 'hidden';
    if (this.multiSelectedIds.includes(blockId)) return 'multi';
    if (this.focusedBlockId === blockId) return 'focus';
    if (this.hoveredBlockId === blockId) return 'hover';
    // 命令态下仍不强制常驻所有把手（避免 L0 退化为 Notion 常驻 chrome）
    return 'hidden';
  }

  // -----------------------------------------------------------------------
  // 折叠
  // -----------------------------------------------------------------------

  setCollapsed(blockId: BlockId, collapsed: boolean): BlockChromeSnapshot {
    if (!blockId) return this.getSnapshot();
    if (collapsed) {
      this.collapsed.add(blockId);
    } else {
      this.collapsed.delete(blockId);
    }
    return this.getSnapshot();
  }

  toggleCollapsed(blockId: BlockId): BlockChromeSnapshot {
    if (!blockId) return this.getSnapshot();
    if (this.collapsed.has(blockId)) {
      this.collapsed.delete(blockId);
    } else {
      this.collapsed.add(blockId);
    }
    return this.getSnapshot();
  }

  isCollapsed(blockId: BlockId): boolean {
    return this.collapsed.has(blockId);
  }

  // -----------------------------------------------------------------------
  // 多选高亮（逻辑 id）
  // -----------------------------------------------------------------------

  /**
   * 设置多选高亮。空列表 → clear。
   * **禁止**调用方用像素测距推导 id；此处仅存逻辑列表。
   */
  setMultiSelected(blockIds: readonly BlockId[]): BlockChromeSnapshot {
    const seen = new Set<BlockId>();
    const ids: BlockId[] = [];
    for (const id of blockIds) {
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    this.multiSelectedIds = ids;
    return this.getSnapshot();
  }

  /** 清空多选高亮 */
  clearMultiSelected(): BlockChromeSnapshot {
    this.multiSelectedIds = [];
    return this.getSnapshot();
  }

  /** 是否在多选高亮中 */
  isMultiSelected(blockId: BlockId): boolean {
    return this.multiSelectedIds.includes(blockId);
  }

  // -----------------------------------------------------------------------
  // 命令态（slash / 批量条）
  // -----------------------------------------------------------------------

  setCommandActive(active: boolean): BlockChromeSnapshot {
    this.commandActive = active;
    return this.getSnapshot();
  }

  // -----------------------------------------------------------------------
  // W3-F：多选 → 批量结构 Intent
  // -----------------------------------------------------------------------

  /**
   * 是否允许危险结构操作（删除等）。
   *
   * 对齐 A-SIL：纯 L0 静默纸面、无多选高亮、无命令态 → 拒绝危险批量。
   * 抬升条件（任一）：
   * - silentLevel === 'L1'
   * - commandActive
   * - multiSelectedIds 非空（用户已显式多选）
   */
  canPerformDangerousStructure(): boolean {
    if (this.silentLevel === 'L1') return true;
    if (this.commandActive) return true;
    if (this.multiSelectedIds.length > 0) return true;
    return false;
  }

  /**
   * 多选（或显式 ids）→ `delete_blocks` Intent。
   *
   * - 空选区 → `empty_selection`
   * - 纯 L0 无多选/命令 → `silent_l0_guard`（危险操作守卫）
   * - 成功时**本地**清多选高亮（呈现层收敛；权威删除仍靠 sink/RS）
   * - **不**直接改文档树
   */
  requestDeleteSelected(
    options: ChromeStructureOptions = {}
  ): ChromeStructureResult<DeleteBlocksIntent> {
    const ids = this.resolveTargetIds(options.blockIds);
    if (ids.length === 0) {
      return {
        ok: false,
        code: 'empty_selection',
        reason: 'BlockChromeModel.requestDeleteSelected：无选中块可删',
      };
    }
    if (!this.canPerformDangerousStructure()) {
      return {
        ok: false,
        code: 'silent_l0_guard',
        reason:
          '静默 L0：禁止无多选/命令态的危险批量删除（A-SIL）；请先多选或进入命令态/L1',
      };
    }

    const intent = buildDeleteBlocksIntent({
      blockIds: ids,
      origin: options.origin ?? (ids.length > 1 ? 'batch' : 'chrome'),
      createIntentId: options.createIntentId ?? this.createIntentId,
    });

    // 本地呈现：清多选噪声（A-SIL-02）；折叠/焦点保留
    this.multiSelectedIds = [];
    return { ok: true, intent, snapshot: this.getSnapshot() };
  }

  /**
   * 多选 / 焦点 / 显式 ids → `toggle_collapse` Intent，并同步本地 collapsed 集。
   *
   * 折叠属呈现态，危险性低于删除：
   * - 允许单焦点块折叠（无需多选抬升）
   * - 仍拒绝完全无目标（empty_selection）
   *
   * @param collapsed 强制目标态；缺省 = 逐块 toggle
   */
  requestToggleCollapse(
    collapsed?: boolean,
    options: ChromeStructureOptions = {}
  ): ChromeStructureResult<ToggleCollapseIntent> {
    let ids = this.resolveTargetIds(options.blockIds);
    // 无多选时回落焦点块（单块折叠）
    if (ids.length === 0 && this.focusedBlockId) {
      ids = [this.focusedBlockId];
    }
    if (ids.length === 0) {
      return {
        ok: false,
        code: 'empty_selection',
        reason: 'BlockChromeModel.requestToggleCollapse：无目标块',
      };
    }

    const intent = buildToggleCollapseIntent({
      blockIds: ids,
      origin: options.origin ?? 'chrome',
      createIntentId: options.createIntentId ?? this.createIntentId,
      ...(collapsed !== undefined ? { collapsed } : {}),
    });

    // 本地呈现同步（乐观）；权威以 sink/投影为准
    for (const id of ids) {
      if (collapsed === true) {
        this.collapsed.add(id);
      } else if (collapsed === false) {
        this.collapsed.delete(id);
      } else if (this.collapsed.has(id)) {
        this.collapsed.delete(id);
      } else {
        this.collapsed.add(id);
      }
    }

    return { ok: true, intent, snapshot: this.getSnapshot() };
  }

  // -----------------------------------------------------------------------
  // 重置 / 快照
  // -----------------------------------------------------------------------

  /**
   * 回到默认静默纸面：清 hover/focus/多选/命令；保留折叠与 silentLevel。
   * 对齐 A-SIL-02：chrome 关闭后不残留噪声（折叠属文档呈现，可保留）。
   */
  resetToSilent(): BlockChromeSnapshot {
    this.hoveredBlockId = null;
    this.focusedBlockId = null;
    this.multiSelectedIds = [];
    this.commandActive = false;
    return this.getSnapshot();
  }

  getSnapshot(): BlockChromeSnapshot {
    return {
      silentLevel: this.silentLevel,
      hoveredBlockId: this.hoveredBlockId,
      focusedBlockId: this.focusedBlockId,
      multiSelectedIds: [...this.multiSelectedIds],
      collapsedIds: [...this.collapsed],
      commandActive: this.commandActive,
    };
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private resolveTargetIds(explicit?: readonly BlockId[]): BlockId[] {
    if (explicit !== undefined) {
      const seen = new Set<BlockId>();
      const ids: BlockId[] = [];
      for (const id of explicit) {
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return ids;
    }
    return [...this.multiSelectedIds];
  }
}
