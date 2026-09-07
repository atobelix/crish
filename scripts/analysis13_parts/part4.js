export const part4 = `
---

## 4. 分屏拖拽调节器（Resize Splitter）与高性能手势控制（Splitter & Gesture Control Engine）

### 4.1 全局树手柄：\`TreeResizeSash\` 架构与水平/垂直绝对定位投影

在多分屏二叉树中，分隔手柄（Sash）是用户调整窗格比例的关键桥梁。
在 \`src/components/binary-tree/TreeResizeSash.tsx\` 中，手柄不是由 Flexbox 自动排版，而是依托 \`flattenTree\` 输出的 \`branch.rect\` 执行精准的**绝对几何投影**：

- **水平分割线（Horizontal Sash · 左右调节）**：
  \`\`\`typescript
  el.style.left = \`\${(rect.x + rect.width * ratio) * 100}%\`;
  el.style.top = \`\${rect.y * 100}%\`;
  el.style.height = \`\${rect.height * 100}%\`;
  \`\`\`
  光标呈现为 \`cursor: col-resize\`，手柄宽度 6px，通过 \`transform: translateX(-3px)\` 居中对齐；
- **垂直分割线（Vertical Sash · 上下调节）**：
  \`\`\`typescript
  el.style.top = \`\${(rect.y + rect.height * ratio) * 100}%\`;
  el.style.left = \`\${rect.x * 100}%\`;
  el.style.width = \`\${rect.width * 100}%\`;
  \`\`\`
  光标呈现为 \`cursor: row-resize\`，手柄高度 6px，通过 \`transform: translateY(-3px)\` 居中对齐；
- **视觉常态绝缘与激活高亮**：
  - 常态下 \`.sash::after\` 背景为完全透明（\`background: transparent\`），因为相邻窗格各自自带 1px 的发丝边框，如果手柄常态也画线，会导致两窗格交界处出现 3 条黑线的视觉灾难；
  - 仅在用户鼠标悬停（\`:hover\`）或按下拖拽（\`[data-active='true']\`）时，伪元素亮出 2px 的翡翠品牌绿（\`var(--accent-green, #10b981)\`）。

---

### 4.2 零 React 重新渲染的高性能手势管线

桌面客户端分屏拖拽的核心挑战是：在用户以 60Hz/120Hz 甚至 240Hz 极速拖动鼠标时，如何保证不丢帧、零卡顿、无撕裂？

#### 传统状态流的灾难：
若在 \`pointermove\` 事件中直接调用 \`store.resizeBranch(ratio)\`：
- Zustand 派生状态改变 → 触发 \`flattenTree\` → 触发 \`BinaryTreeWorkspace\` 重新渲染 → 重新构造并比对所有 Leaf 与 Sash 虚拟节点；
- 造成每秒触发上百次全量 React Reconciliation，导致渲染管线严重拥堵，表现为鼠标跟手严重滞后。

#### \`useTreeResize\` 的零重绘直写架构：
\`src/hooks/useTreeResize.ts\` 彻底切断了手势期间的 React 渲染环路，设计了纯 DOM 驱动的“旁路直写引擎”：

\`\`\`
[ 1. 拖拽开始 pointerdown ]
  │
  ├── body.classList.add('tree-resizing')
  │   └── 触发 CSS: .tree-resizing .leaf { transition: none !important; will-change: ... }
  ├── 一次性扫描建立缓存: collectLiveResizeDomMap()
  │   └── Map<leafId, HTMLElement>, Map<branchId, HTMLElement>
  └── 计算当前像素基准尺寸:
      pixelRect = canvas.getBoundingClientRect() * branch.rect
  │
[ 2. 拖拽进行 pointermove (极速触发) ]
  │
  ├── 纯数学计算: newRatio = (e.clientX - pixelRect.left) / pixelRect.width
  ├── 数学校验: clampSplitRatioForParent(newRatio, parentPx)
  └── requestAnimationFrame(() => {
        // A. 纯算法产生下一帧虚拟树 (耗时 < 0.1ms)
        const nextTree = resizeBranchTree(tree.root, branchId, newRatio);
        const { leaves, branches } = flattenTree(nextTree.root);
        // B. 绕过 React，直接刷物理 DOM inline style
        for (const leaf of leaves) {
          const el = domMap.leaves.get(leaf.leafId);
          el.style.left = \`\${leaf.rect.x * 100}%\`;
          el.style.width = \`\${leaf.rect.width * 100}%\`;
        }
        for (const branch of branches) {
          const el = domMap.branches.get(branch.branchId);
          el.style.left = \`\${(branch.rect.x + branch.rect.width * branch.splitRatio) * 100}%\`;
        }
      });
  │   (注意: 此阶段 React 组件完全不感知，渲染帧率稳锁 120 FPS!)
  │
[ 3. 拖拽松开 pointerup / pointercancel ]
  │
  ├── body.classList.remove('tree-resizing')
  ├── 清空并释放 DOM 缓存: clearLiveResizeDomCache()
  ├── 若发生实质位移 (didMove === true):
  │   ├── pushHistory() 记录撤销重做状态
  │   └── store.resizeBranch(branchId, finalRatio) 一次性写入单一真理源
  └── 恢复 React 受控状态
\`\`\`

---

### 4.3 瞬态防抖与尺寸钳制安全防线

在拖拽过程中，若用户将分割条直接拉到视口边缘，会导致被挤压窗格的宽度变为 0 甚至负数。
在 \`src/hooks/treeResizeClamp.ts\` 中定义了严格的防坍塌保护算法：

\`\`\`typescript
export const MIN_CHILD_PX = 120; // 单个分屏视窗物理最小像素宽度/高度

export function splitRatioBounds(parentPx: number): { min: number; max: number } {
  if (parentPx <= 0) return { min: 0.12, max: 0.88 };
  // 计算在当前容器物理像素下，120px 占据的比例
  const minRatioByPx = MIN_CHILD_PX / parentPx;
  const maxRatioByPx = 1 - minRatioByPx;

  // 综合业务比例界限 [0.12, 0.88] 与像素界限，双重收紧
  const min = Math.max(0.12, minRatioByPx);
  const max = Math.min(0.88, maxRatioByPx);

  return min <= max ? { min, max } : { min: 0.5, max: 0.5 };
}
\`\`\`
即使在 800px 宽的小屏窗口中，左右双分屏的最小宽度也被死死锁定在 120px 以上，绝不发生布局坍塌！

---

### 4.4 叶内坞调节手柄：\`LeafDockResizer\` 0px 跨越与负外边距对称热区

除了二叉树节点之间的 Sash，每个叶子内部的“主对话列”与“右侧工具抽屉”之间同样需要可调节手柄（\`LeafDockResizer.tsx\`）。
这里的架构设计极其精妙：
1. **0 占位宽（\`width: 0; flex: 0 0 0;\`）**：手柄在 Flex 盒模型中不占用任何实际空间，保证对话列与抽屉在百分比划分上 100% 精确；
2. **负边距跨越（\`margin-left: -4px; margin-right: -4px;\`）**：将手柄左右拉伸 4px，使其几何中心恰好重合在右侧抽屉的 1px 左边框（\`border-left\`）上；
3. **伪元素 8px 热区（\`::before\`）**：
   \`\`\`css
   .leafDockResizer::before {
     content: '';
     position: absolute;
     left: -4px;
     width: 8px;
     top: 0; bottom: 0;
     pointer-events: auto;
   }
   \`\`\`
   有效扩大鼠标悬停与点击的命中范围，无论用户鼠标偏左还是偏右 4px，均能顺畅捕捉拖拽手势！

---

### 4.5 拖拽全链路“防粘手与防事件丢失”四重防线

在跨 iframe 复杂的桌面应用场景中，普通事件监听极易出现严重 Bug。本系统构筑了**四重立体防线**：

| 防线层级 | 实现方式 | 防范的致命 Bug |
| :--- | :--- | :--- |
| **第一道：硬件级捕获** | \`handleEl.setPointerCapture(e.pointerId)\` | 用户鼠标快速划过视窗边缘甚至移出整个桌面窗口时，事件丢失 |
| **第二道：iframe 黑洞屏蔽** | \`disableIframePointerEvents()\` | 鼠标划过 PreviewCard 或外部嵌入页面时，指针事件被 iframe 吞噬（事件黑洞） |
| **第三道：全局 Body 标记** | \`document.body.classList.add('is-resizing')\` | 拖拽过程中意外选中文本、高亮代码，引发全屏文本选区闪烁 |
| **第四道：系统手势收敛** | 同时监听 \`pointercancel\` 与 \`blur\` | 用户按下 Alt+Tab、Win 键或触发系统多任务手势时，拖拽状态未释放导致鼠标粘手 |

---

### 4.6 键盘无障碍微调系统

\`TreeResizeSash.tsx\` 严格践行了 WAI-ARIA 分割器（Separator）的可访问性规范：
- 节点绑定 \`role="separator"\`、\`aria-orientation\`、\`aria-valuenow\`、\`tabIndex={0}\`；
- 用户可通过键盘将焦点移动到分割线上；
- 按下 \`ArrowLeft\` / \`ArrowUp\`，比例步进降低 2%；按下 \`ArrowRight\` / \`ArrowDown\`，比例步进增加 2%；
- 按下 \`Home\` 键，分割线迅速滑向最小边界；按下 \`End\` 键，分割线迅速滑向最大边界；
- 按下双击手势，立即触发 \`resizeBranch(branchId, 0.5)\` 恢复 1:1 均分。
`;
