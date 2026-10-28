/**
 * 右坞二叉树空间模型类型定义（Dock Tree Type Contracts）
 *
 * 遵循单一真理源（SSOT）与类型契约正交抽象原则。
 */

import type {
  BaseSpatialLeaf,
  SpatialBranch,
  SpatialNode,
  SpatialTree,
} from './spatialTree';

/** 规范的工具视图类型（必须与 ViewRegistry 严格对齐） */
export type ToolViewId =
  | 'terminal'
  | 'preview'
  | 'files'
  | 'diff'
  | 'overview'
  | 'file-viewer'
  | 'agent'
  | 'runtime'
  | 'flow-dag'
  | (string & {});

/** 正交工具标签实体（不可变） */
export interface ToolTab {
  readonly tabId: string; // 全局不可变唯一 ID，如 "dtab_l9x2_a1b2c3"
  readonly viewId: ToolViewId; // 纯视图类型
  readonly title?: string; // 可选标题覆盖
  readonly params?: Readonly<Record<string, unknown>>; // 结构化不可变参数，如 { filePath, initialMode } 或 { url } 或 { cwd }
}

/** 右坞叶子节点：一个分屏窗格 */
export interface DockLeaf extends BaseSpatialLeaf {
  readonly type: 'leaf';
  readonly id: string;
  readonly tabs: readonly ToolTab[];
  readonly activeTabId: string | null; // 充要不变量：tabs.length === 0 ⇔ activeTabId === null
}

export type DockBranch = SpatialBranch<DockLeaf>;
export type DockNode = SpatialNode<DockLeaf>;

export interface DockTree extends SpatialTree<DockLeaf> {
  readonly root: DockNode;
  readonly activeDockLeafId: string | null; // 当前具有焦点的右坞窗格 ID
  readonly version: 2; // V2 架构版本
}

/** 打开工具标签输入参数 */
export interface OpenToolInput {
  readonly viewId: ToolViewId;
  readonly title?: string;
  readonly params?: Record<string, unknown>;
  readonly targetLeafId?: string;
  readonly isSingleton?: boolean;
}
