/**
 * 块 chrome 状态模型（纯 TS，可测）。
 *
 * 覆盖：
 * - 静默默认（L0）：无常驻把手 / 菜单噪声（A-SIL-01）
 * - 把手悬停 / 焦点显隐（按需 chrome，A-SIL-02）
 * - 折叠（collapsed）本地呈现态
 * - 多选高亮 set / clear（逻辑 blockId，禁止像素测距）
 *
 * **不**接真实 DOM；UI 后接时以本 store 为呈现源。
 * **禁止** DOM 当真相；写路径必须 Intent → RS apply。
 */

import type { BlockId } from '@crish/block-paper-contract';

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
// Store
// ---------------------------------------------------------------------------

/**
 * 块 chrome 状态机（stub）。
 *
 * 默认 L0 静默：无 hover/focus/多选/命令时，所有把手 hidden。
 */
export class BlockChromeModel {
  private silentLevel: SilentLevel = 'L0';
  private hoveredBlockId: BlockId | null = null;
  private focusedBlockId: BlockId | null = null;
  private multiSelectedIds: BlockId[] = [];
  private collapsed = new Set<BlockId>();
  private commandActive = false;

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
}
