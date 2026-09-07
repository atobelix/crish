export const part3 = `
---

## 3. 二叉分形树拓扑与分裂/合并算法深度剖析（Fractal Binary Tree & Split/Merge Algorithms）

### 3.1 树数据结构模型：\`LayoutNode = LayoutLeaf | LayoutBranch\` 纯数据定义与不变式

Conex 的多分屏布局内核建立在一个经典的纯函数式二叉树模型之上（定义于 \`src/store/layout-tree/types.ts\`）。
模型摒弃了传统网格式（CSS Grid）的行列固定划分，采用分形递归二叉树：每个视口区域要么是一个不可再分的叶子节点（\`LayoutLeaf\`），要么是由一条水平或垂直分割线切开的分支节点（\`LayoutBranch\`）。

\`\`\`typescript
export interface LayoutLeaf {
  type: 'leaf';
  id: string;
  panelId: 'chat';
  tabs: SessionTab[];
  activeTabId: string;
  dock?: RightToolDockState;
}

export interface LayoutBranch {
  type: 'branch';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: [LayoutNode, LayoutNode]; // 严格二叉元组
  splitRatio: number;                 // 0.12 <= splitRatio <= 0.88
}

export type LayoutNode = LayoutLeaf | LayoutBranch;

export interface LayoutTree {
  root: LayoutNode;
  version: 3;
}
\`\`\`

#### 三大底层不变式（Mathematical Invariants）：
1. **严格二叉完备性（Binary Completeness）**：分支节点的 \`children\` 数组长度恒等于 2。整棵树没有空指针子节点；
2. **拓扑非退化性（Non-Degenerate Topology）**：任何分支节点必须至少拥有两个子节点。当其中一个子节点被移除时，该分支节点必须立即解构塌陷，由其幸存兄弟节点无损顶替；
3. **比例有界性（Bounded Split Ratio）**：\`splitRatio\` 严格受限于常量区间 \`[0.12, 0.88]\`。这保证了在任何方向的分屏中，最小的窗格至少占据母空间的 12%，从根本上杜绝了除以零或窗格完全不可见（0 像素）的渲染异常。

---

### 3.2 树展平与几何投影算法：\`flattenTree\` 递归遍历与归一化百分比 Rect 坐标系

直接递归渲染 React 组件树会导致 DOM 层级深陷、手柄定位极度繁琐。系统在 \`src/store/layout-tree/layoutTreeFlatten.ts\` 中实现了一套极其高效的**空间展平与归一化投影算法**。

#### 算法数学模型：
给定根节点分配的初始空间：
$$\text{Rect}_{\text{root}} = \{ x: 0, y: 0, w: 1, h: 1 \}$$
对于任意分支节点 $N_{\text{branch}} = (\text{direction}, \text{ratio}, C_1, C_2)$ 与分配空间 $\text{Rect} = (x, y, w, h)$：

- **水平分割（\`direction === 'horizontal'\`）**：
  $$\text{Rect}_{C_1} = \{ x, y, w \times \text{ratio}, h \}$$
  $$\text{Rect}_{C_2} = \{ x + w \times \text{ratio}, y, w \times (1 - \text{ratio}), h \}$$
- **垂直分割（\`direction === 'vertical'\`）**：
  $$\text{Rect}_{C_1} = \{ x, y, w, h \times \text{ratio} \}$$
  $$\text{Rect}_{C_2} = \{ x, y + h \times \text{ratio}, w, h \times (1 - \text{ratio}) \}$$

#### 展平算法源码剖析：
\`\`\`typescript
export function flattenTree(root: LayoutNode, options?: { collapsedDomain?: CollapsedDomain }) {
  const leaves: FlatPanel[] = [];
  const branches: FlatBranch[] = [];
  flattenRecursive(root, { x: 0, y: 0, width: 1, height: 1 }, leaves, branches, options?.collapsedDomain);
  return { leaves, branches };
}

function flattenRecursive(
  node: LayoutNode,
  rect: Rect,
  leavesOut: FlatPanel[],
  branchesOut: FlatBranch[],
  collapsedDomain?: CollapsedDomain
): void {
  if (isLeaf(node)) {
    leavesOut.push({
      leafId: node.id,
      panelId: 'chat',
      tabs: node.tabs,
      activeTabId: node.activeTabId,
      dock: createDefaultDock(node.dock),
      sessionId: node.tabs.find((t) => t.tabId === node.activeTabId)?.sessionId ?? '',
      rect: leafMatchesCollapsedDomain(node, collapsedDomain)
        ? { x: rect.x, y: rect.y, width: 0, height: 0 }
        : rect,
    });
    return;
  }

  const { direction, splitRatio, children } = node;
  // 记录 branch 绝对几何占比，用于 Sash 物理定位
  branchesOut.push({ branchId: node.id, direction, splitRatio, rect });

  if (direction === 'horizontal') {
    const firstWidth = rect.width * splitRatio;
    flattenRecursive(children[0], { x: rect.x, y: rect.y, width: firstWidth, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
    flattenRecursive(children[1], { x: rect.x + firstWidth, y: rect.y, width: rect.width - firstWidth, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
  } else {
    const firstHeight = rect.height * splitRatio;
    flattenRecursive(children[0], { x: rect.x, y: rect.y, width: rect.width, height: firstHeight }, leavesOut, branchesOut, collapsedDomain);
    flattenRecursive(children[1], { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: rect.height - firstHeight }, leavesOut, branchesOut, collapsedDomain);
  }
}
\`\`\`

**特性保证**：
- 单次 $O(N)$ 递归遍历；
- 输出所有叶子的绝对百分比坐标与所有分支的分割手柄矩形；
- 无论树结构如何深层嵌套，渲染层全部平铺展开，彻底消除了 DOM 的层级嵌套！

---

### 3.3 窗格分裂算法：\`splitLeaf\` / \`splitTab\` / \`splitSessionFromSidebar\`

窗格分裂是多分屏系统的核心交互，支持“拖拽标签到边缘分屏”与“从侧栏拖入会话直接分屏”。

#### 算子执行流程拓扑图：
\`\`\`
[发起分屏: splitTab(tree, srcLeafId, tabId, dstLeafId, region, splitRatio)]
                 │
                 ▼
        目标区域 region === 'center' ?
       ┌─────────┴─────────┐
       ▼ YES               ▼ NO
  moveTab 合并为标签     确定分屏方向 direction:
                        - left / right => 'horizontal'
                        - top / bottom => 'vertical'
                           │
                           ▼
                    从源叶剥离该 Tab:
                    src.tabs.filter(t => t.tabId !== tabId)
                           │
                           ▼
                    构造全新目标 Leaf:
                    fresh = createLeaf({ tabs: [tab], activeTabId: tab.tabId })
                           │
                           ▼
                    构造二叉 Branch:
                    first, second = (region 为 right/bottom) ? [dst, fresh] : [fresh, dst]
                    branch = createBranch(direction, first, second, splitRatio)
                           │
                           ▼
                    替换目标节点 replaceNode(root, dstLeafId, branch)
                           │
                           ▼
                    级联修剪源叶 pruneEmptyLeaves(tree)
\`\`\`

在 \`src/store/layout-tree/layoutTreeInsert.ts:199-281\` 中：
- 当源叶与目标叶相同时（在同一个窗格内向右切分）：原叶作为左子节点，新建叶作为右子节点，直接由父 Branch 原地替换；
- 当源叶与目标叶不同时：在目标位置创建 Branch 插入，并将源叶中对应的 Tab 移除。若源叶此时变空，调用 \`pruneEmptyLeaves\` 自动折叠消除源窗格。

---

### 3.4 窗格合并与折叠消除算法：\`removeNodeFromTree\` 兄弟节点提升与 \`pruneEmptyLeaves\` 级联修剪

#### 1. 兄弟节点提升（Tree Collapse）：
在 \`src/store/layout-tree/layoutTreeMoveRemove.ts\` 中：
当删除某个节点 \`nodeId\` 时，找到其父节点 \`parent\`。因为父节点只有两个子节点，被删除节点的兄弟节点将直接提升，取代父节点的位置：

\`\`\`typescript
export function removeNodeFromTree(tree: LayoutTree, nodeId: string): LayoutTree | null {
  const { root } = tree;
  if (root.id === nodeId) return null; // 根节点不可删

  const parentInfo = findParent(root, nodeId);
  if (!parentInfo) return null;

  const { parent, index } = parentInfo;
  // 幸存兄弟节点：index 为 0 保留 1，为 1 保留 0
  const keepIndex: 0 | 1 = index === 0 ? 1 : 0;
  const newRoot = removeBranch(root, parent.id, keepIndex);
  return { ...tree, root: newRoot };
}
\`\`\`

#### 2. 空叶级联修剪循环（\`pruneEmptyLeaves\`）：
当多个 Tab 被连续关闭或移走时，树中可能产生无内容的空叶。
\`\`\`typescript
export function pruneEmptyLeaves(tree: LayoutTree): LayoutTree {
  let current = tree;
  let changed = false;
  // 设定最大防御上限 32 轮，防止环形结构死循环
  for (let guard = 0; guard < 32; guard++) {
    const leaves = collectLeaves(current.root);
    const empty = leaves.filter((l) => l.tabs.length === 0);
    if (empty.length === 0) return changed ? current : tree;

    // 唯一空叶保护铁律：如果全树只剩一个叶子且为空，绝不删除它！
    // 而是保留其作为“新对话草稿态（Draft Composer）”，防止整个桌面视口坍塌成空白！
    if (leaves.length === 1) {
      const only = leaves[0]!;
      if (only.activeTabId !== '') {
        return { ...current, root: replaceNode(current.root, only.id, { ...only, activeTabId: '' }) };
      }
      return changed ? current : tree;
    }

    // 移除第一个空叶，触发兄弟提升
    const next = removeLeafFromTree(current, empty[0]!.id);
    if (!next) return changed ? current : tree;
    current = next;
    changed = true;
  }
  return current;
}
\`\`\`

---

### 3.5 跨窗格会话标签迁移算法：\`moveTab\` / \`moveNode\` 深度剪枝与挂载

- 算法保证：会话标签跨窗格迁移是原子的；
- 不变式约束：\`sessionIdTaken(tree.root, tab.sessionId, tabId)\`。在执行任何插入或移动前，全树扫描是否有冲突的 Session 实例，保证同一会话在全分屏系统中全局唯一；
- 顺序保持：\`moveTab\` 支持指定目标索引 \`targetIndex\`，精确实现拖拽插入到目标窗格标签栏的任意指定缝隙中。

---

### 3.6 自适应 Drop Zone 判定算法：\`detectDropZone\` 距离梯度加权与边缘/中心识别

拖拽放置判定的核心难点在于：如何在不同尺寸的窗格中，既让边缘切分易于触发，又让中心合并标签不产生误触？
在 \`src/store/layout-tree/dropDetection.ts\` 中：
- 摒弃了早期版本的固定比例划分，采用**归一化距离梯度加权算法**；
- 引入 \`minAdaptiveSize = 200px\` 自适应机制：当窗格被挤压至 200px 以下的极窄宽度时，边缘切分判定区域自动扩大，提升拖拽操作的容错率与手感。
`;
