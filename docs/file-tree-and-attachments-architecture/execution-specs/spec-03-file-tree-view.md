# 施工任务书 03：目录树虚拟滚动平滑居中与脉冲高亮

> **文档标识**：`docs/file-tree-and-attachments-architecture/execution-specs/spec-03-file-tree-view.md`
> **所属战役**：`docs/file-tree-and-attachments-architecture/`
> **指派角色**：`FileTreeView Virtual Scroll Engineer`
> **纪律铁律**：纯逻辑规划，禁止自主过度发挥，严禁改动虚拟滚动底层 Hook，严格独占文件域，严禁执行 git commit。

---

## 一、独占文件白名单（Forbidden to touch any other file）

1. `apps/crish-desktop/src/components/files/FileTreeView.tsx`（核心实现）
2. `apps/crish-desktop/src/components/files/FileTreeView.test.tsx`（单元测试）

---

## 二、必须落地的核心逻辑

在 `apps/crish-desktop/src/components/files/FileTreeView.tsx` 中：

### 1. 引入统一路径判定
从 `../../api/workspaceFsApi` 引入 `isSameFsPath`。

### 2. 虚拟滚动精准平滑居中停泊（Scroll-Into-View）
利用已有的 `containerRef` 与 `ITEM_HEIGHT = 28`：
```typescript
const [pulseTarget, setPulseTarget] = React.useState<string | null>(null);

React.useEffect(() => {
  if (!selected || !containerRef.current) return;

  const targetIndex = flatTree.findIndex((n) => isSameFsPath(n.path, selected));
  if (targetIndex === -1) return;

  const container = containerRef.current;
  const viewHeight = container.clientHeight;
  if (viewHeight <= 0) return;

  const itemTop = targetIndex * ITEM_HEIGHT;
  const itemBottom = itemTop + ITEM_HEIGHT;
  const currentScrollTop = container.scrollTop;

  // 判定是否在舒适可见视口范围内（留 1 行余量）
  const isInView =
    itemTop >= currentScrollTop + ITEM_HEIGHT &&
    itemBottom <= currentScrollTop + viewHeight - ITEM_HEIGHT;

  if (!isInView) {
    // 精准计算使目标节点居中的理想位置
    const idealScrollTop = Math.max(0, itemTop - Math.floor((viewHeight - ITEM_HEIGHT) / 2));
    container.scrollTo({ top: idealScrollTop, behavior: 'smooth' });
  }

  // 挂载 1.4s 呼吸高亮
  setPulseTarget(selected);
  const timer = setTimeout(() => setPulseTarget(null), 1400);

  // 尝试将键盘焦点转移至该行（无缝衔接键盘导航）
  focusTreeRow(targetIndex);

  return () => clearTimeout(timer);
}, [selected, flatTree, focusTreeRow]);
```

### 3. 行级高亮样式渲染
在渲染行（`visibleItems.map`）时：
```typescript
const isRowSelected = selected ? isSameFsPath(node.path, selected) : false;
const isRowPulsing = pulseTarget ? isSameFsPath(node.path, pulseTarget) : false;

className={`${styles.filesRow} ${isRowSelected ? styles.selected : ''} ${
  isRowPulsing ? styles.isSelectedPulse : ''
}`}
```

---

## 三、单元测试与验收命令

在 `FileTreeView.test.tsx` 中验证：
1. 当 `selected` 指向深层条目时，`container.scrollTo` 被调用并传入计算出的居中 `top` 偏移量；
2. 匹配行挂载选中态与脉冲高亮态。

验收执行命令：
```powershell
npx vitest run src/components/files/FileTreeView.test.tsx
```
