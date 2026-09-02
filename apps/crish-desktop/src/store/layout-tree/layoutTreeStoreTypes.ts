/**
 * layoutTreeStore 类型契约（Store State / Actions / 联合类型）。
 *
 * 会话身份写端没有 setLeafSessionId；身份只在 leaf.tabs[].sessionId。
 */

import type {
  LayoutTree,
  DropDirection,
  TreeDragSource,
} from './types';
import type { SplitRegion } from './layoutTreeInsert';
import type { DropZone } from './dropDetection';

export interface LayoutTreeStoreState {
  /** 当前布局树 */
  tree: LayoutTree;
  /** 当前激活（聚焦）的 leaf id */
  activeLeafId: string | null;
  /** 拖拽源（null = 未拖拽） */
  draggedSource: TreeDragSource | null;
  /** 当前检测到的 drop zone */
  activeDropZone: DropZone | null;
  /** 历史栈：过去的 tree 快照（undo 用） */
  past: LayoutTree[];
  /** 历史栈：未来的 tree 快照（redo 用） */
  future: LayoutTree[];
  /** 右侧面板（功能区）是否折叠 */
  toolColumnCollapsed: boolean;
}

export interface LayoutTreeStoreActions {
  // ── 结构操作（推历史） ──────────────────────────────────────
  /** 替换整棵树（反序列化/迁移） */
  setTree: (tree: LayoutTree) => void;
  /** 重置为单 chat 叶的未提交新对话界面 */
  resetTree: () => void;
  /** 合并分支 */
  mergeBranch: (branchId: string, keepIndex?: 0 | 1) => void;
  /** 移动叶子（几何，不改 tabs 内容） */
  moveLeaf: (
    sourceId: string,
    targetId: string,
    direction: DropDirection
  ) => void;
  /** 调整分割比例（commit=true 推历史，false 不推用于拖拽手势） */
  resizeBranch: (branchId: string, ratio: number, commit?: boolean) => void;
  /**
   * 同时更新 tree + toolColumnCollapsed + activeLeafId（推历史）。
   */
  setTreeWithDock: (
    tree: LayoutTree,
    toolColumnCollapsed: boolean,
    activeLeafId?: string | null
  ) => void;

  // ── 会话 tab 命令 ──────────────────────────────────────────
  /** 激活该叶 tab；即使树不变也聚焦该叶。不推历史。 */
  activateTab: (leafId: string, tabId: string) => void;
  /** 只改该 tab 的 dock，不改拓扑、不推历史 */
  updateTabDock: (
    tabId: string,
    patch: import('./sessionTabModel').RightToolDockState | Partial<import('./sessionTabModel').RightToolDockState>
  ) => void;
  /** 写本叶坞：有活动 tab 写 tab.dock，否则写叶上新对话坞 */
  updateLeafDock: (
    leafId: string,
    patch: import('./sessionTabModel').RightToolDockState | Partial<import('./sessionTabModel').RightToolDockState>
  ) => void;
  /** 进入本叶新对话界面（不建标签）；带真 sessionId 则插入标签。推历史。 */
  addTab: (
    leafId: string,
    tabOrWorkspaceKey?:
      | string
      | {
          tabId?: string;
          title?: string;
          workspaceKey?: string;
          dock?: Partial<import('./sessionTabModel').RightToolDockState>;
        }
  ) => void;
  /** 打开或聚焦会话（已存在则激活，否则插入新 tab 并激活）。推历史（新建时）。 */
  openSession: (
    sessionId: string,
    opts: { title?: string; workspaceKey?: string; activeLeafId: string }
  ) => { leafId: string; tabId: string; created: boolean };
  /** 发送成功：把未提交新对话物化成真会话标签。推历史。 */
  promoteDraftTab: (
    draftSessionId: string,
    realSessionId: string,
    patch?: { title?: string }
  ) => void;
  /** 修改指定 sessionId 的 tab 标题。不推历史。 */
  updateTabTitle: (sessionId: string, title: string) => void;
  /** 重置为单 chat 叶的未提交新对话界面。推历史。 */
  resetToSingleDraftLeaf: (workspaceKey?: string) => void;
  /** 从该叶删 tab；空则 prune（唯一叶留下新对话界面）。推历史。 */
  removeTab: (leafId: string, tabId: string) => void;
  /** 同一对象搬到目标叶。推历史。 */
  moveTab: (
    srcLeafId: string,
    tabId: string,
    dstLeafId: string,
    insertIdx: number
  ) => void;
  /** 从源拿走，在目标旁 split 出新叶。推历史。 */
  splitTab: (
    srcLeafId: string,
    tabId: string,
    dstLeafId: string,
    region: SplitRegion
  ) => void;

  // ── 焦点操作（不推历史） ────────────────────────────────────
  /** 设置激活 leaf */
  setActiveLeaf: (leafId: string | null) => void;
  /** 折叠/展开右侧面板（功能区） */
  toggleToolColumnCollapsed: () => void;
  /** 显式设置功能区折叠（Adapter / RightToolDock 用） */
  setToolColumnCollapsed: (collapsed: boolean) => void;

  // ── 拖拽状态（不推历史） ────────────────────────────────────
  setDraggedSource: (source: TreeDragSource | null) => void;
  setActiveDropZone: (zone: DropZone | null) => void;
  commitDrop: () => void;
  cancelDrag: () => void;

  // ── 历史操作 ──────────────────────────────────────────────
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export type LayoutTreeStore = LayoutTreeStoreState & LayoutTreeStoreActions;
