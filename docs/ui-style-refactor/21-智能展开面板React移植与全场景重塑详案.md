# 智能展开面板（SmartPanel）React 移植与全场景重塑详案

> **战役工作区**：`docs/ui-style-refactor/`  
> **方案编号**：`PLAN-21`  
> **实施目标**：
> 1. 将 `reference/smart-expandable-panel/` 与 `展开面板设计.html` 规范化移植为 React + CSS Modules 标准原子级组件 `apps/crish-desktop/src/components/ui/SmartPanel/`；
> 2. 以左侧会话列表（`SessionRow.tsx`）的「更多操作」为首个试验田，跑通纯数据驱动、发丝边框、高危红字与高级选项原地手风琴折叠；
> 3. 彻底攻坚重塑面包屑文件下拉浮层（`FileBreadcrumb.tsx`）：废除切屏下钻（Drilldown），实现「原地树状展开/折叠」+ 顶部搜索栏内嵌 `[📂 打开目录]` 动作按钮（彻底根除用户截图 1 与 2 中的交互断层）。

---

## 一、修改与新建文件清单

| 操作类型 | 文件路径 | 职责定位 |
| :--- | :--- | :--- |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/types.ts` | 严格 TypeScript 类型契约（`MenuItem`, `MenuGroup`, `SmartPanelProps`） |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.tsx` | 主容器组件（Portal 挂载、双触发模式、双层滚动隔离） |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css` | 同心圆角、1px 实体发丝边框、4 层漫反射光影与毛玻璃 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartSearchHeader.tsx` | 28px 嵌入式搜索栏 + Action 槽位 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartItemRow.tsx` | 槽位化菜单条目（图标/文本/快捷键/展开箭头/对勾） |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartCollapsibleSection.tsx` | CSS Grid `0fr -> 1fr` 原地平滑折叠展开容器 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartSubmenu.tsx` | Safe-Aim 级联子菜单容器 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/hooks/usePanelPosition.ts` | 自适应视口边界计算与 32px 滞后防抖 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts` | Raycast 级 WAI-ARIA 全键盘无障碍漫游 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/hooks/useSafeAim.ts` | 120Hz 虚拟 SVG 碰撞多边形防误触算法 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/index.ts` | 模块统一导出 |
| **[NEW]** | `apps/crish-desktop/src/components/ui/SmartPanel/__tests__/SmartPanel.test.tsx` | 原子级组件单元测试套件 |
| **[MODIFY]** | `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx` | 试验田：接入 `SmartPanel`，落地发丝边框与高级选项原地折叠 |
| **[MODIFY]** | `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx` | 核心攻坚：重塑为搜索栏内嵌打开按钮 + 原地树状展开 |
| **[MODIFY]** | `apps/crish-desktop/src/components/files/FilesCard.module.css` | 浮层定位、树状缩进排版与图层防穿透样式 |
| **[MODIFY]** | `apps/crish-desktop/src/components/files/__tests__/FileBreadcrumb.test.tsx` | 补充原地展开与内嵌动作测试 |

---

## 二、第一部分：`SmartPanel` 组件底座实施契约

### 1. 数据驱动 Schema（`types.ts`）

```typescript
export interface MenuItem {
  id: string;
  type?: 'item' | 'selectable' | 'group' | 'sub-group' | 'divider' | 'submenu' | 'collapsible';
  label?: string;
  sublabel?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  badge?: string;
  tooltip?: string;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  searchKeywords?: string;
  children?: MenuItem[];
  onSelect?: (item: MenuItem, event?: React.MouseEvent | React.KeyboardEvent) => void;
}

export interface MenuGroup {
  id?: string;
  title?: string;
  isSelectableList?: boolean;
  items: MenuItem[];
}

export interface SmartPanelProps {
  items: Array<MenuItem | MenuGroup>;
  open: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  point?: { x: number; y: number } | null;
  searchPlaceholder?: string;
  enableSearch?: boolean;
  searchRightActions?: React.ReactNode; // 👈 关键：搜索栏右侧内嵌 Action 按钮槽位
  enableDivider?: boolean;
  enableTriangleAim?: boolean;
  maxPanelHeight?: number;
  onSelect?: (item: MenuItem) => void;
  onOpen?: () => void;
  onClose?: () => void;
  className?: string;
  style?: React.CSSProperties;
}
```

### 2. 同心圆角与 1px 实体发丝样式（`SmartPanel.module.css`）

```css
.sepContainer {
  position: fixed;
  z-index: var(--z-smart-panel, 500);
  pointer-events: auto;
  user-select: none;
}

.sepPanel {
  width: max-content;
  min-width: 200px;
  max-width: min(340px, 90vw);
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border-color, #e2dfd9);
  border-radius: var(--radius-lg, 12px);
  padding: 6px;
  box-shadow: var(--shadow-xl, 0 16px 36px -6px rgba(0, 0, 0, 0.12));
  backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

/* CSS Grid 0fr -> 1fr 原地手风琴展开容器 */
.collapsibleContent {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s cubic-bezier(0.22, 1.25, 0.36, 1);
  overflow: hidden;
}

.collapsibleContent.isExpanded {
  grid-template-rows: 1fr;
}

.collapsibleInner {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 2px;
}
```

---

## 三、第二部分：试验田 —— 左侧会话列表（`SessionRow.tsx`）接入

### 1. 业务动作标准化为 `MenuItem[]`

```typescript
const menuItems: MenuItem[] = [
  {
    id: 'rename',
    label: '重命名',
    shortcut: 'F2',
    icon: <Pencil size={14} />,
    onSelect: () => handleStartRename(),
  },
  {
    id: 'branch',
    label: '分叉会话',
    shortcut: 'Ctrl+Shift+D',
    icon: <GitFork size={14} />,
    onSelect: () => handleBranchSession(),
  },
  { type: 'divider', id: 'div-1' },
  {
    id: 'advanced',
    type: 'collapsible',
    label: '高级与导出',
    children: [
      {
        id: 'export-md',
        label: '导出为 Markdown',
        icon: <FileText size={14} />,
        onSelect: () => handleExportMarkdown(),
      },
      {
        id: 'copy-id',
        label: '复制会话 ID',
        icon: <Copy size={14} />,
        onSelect: () => handleCopySessionId(),
      },
    ],
  },
  { type: 'divider', id: 'div-2' },
  {
    id: 'delete',
    label: '删除会话',
    shortcut: 'Del',
    icon: <Trash2 size={14} />,
    danger: true, // 👈 警示红字与浅红微底
    onSelect: () => handleDeleteSession(),
  },
];
```

---

## 四、第三部分：核心攻坚 —— 面包屑文件下拉浮层彻底重塑

### 1. 顶部搜索栏内嵌打开按钮（对标图 2）

```tsx
<SmartSearchHeader
  value={filter}
  onChange={setFilter}
  placeholder="筛选文件或目录…"
  rightActions={
    <Tooltip content={`在文件树中打开此目录 (${currentLabel}) · Enter`}>
      <button
        type="button"
        className={styles.filesBcDirectOpenBtn}
        onClick={handleDirectOpenCurrentDir}
        aria-label="打开此目录"
      >
        <FolderTree size={14} />
      </button>
    </Tooltip>
  }
/>
```

### 2. 原地树状展开/折叠（Inline Accordion Tree）

- 彻底移除翻页切屏（Drilldown）；
- 维护 `expandedPaths: Set<string>` 与 `dirCache: Record<string, FsDirEntry[]>`；
- 点击目录项：
  - 若已展开，折叠子树（`expandedPaths.delete(path)`）；
  - 若未展开，若无缓存则异步拉取 `loadDir(path)` 并缓存，加入 `expandedPaths`；
  - 子级渲染带有 `depth * 14px` 的树状级联缩进与展开 Chevron 旋转动效；
- 点击文件项：直接触发 `onOpenFile(filePath)` 并平滑关闭浮层；
- 双击目录项：在文件树中直达打开该目录并关闭浮层。

---

## 五、验证与门禁标准

1. **类型检查**：`npm run typecheck` 0 错误；
2. **行数门禁**：`npm run check:line-counts` 0 违规（每个拆分子文件 ≤ 200 行）；
3. **架构分层**：`npm run check:ui-layer` 0 违规（`SmartPanel` 零业务依赖）；
4. **单元测试**：新增 `SmartPanel.test.tsx` 并跑通 `FileBreadcrumb.test.tsx`；
5. **双重审查流程**：实施完成后，立即派发严格质检 Agent 逐行逐像素挑刺验收。
