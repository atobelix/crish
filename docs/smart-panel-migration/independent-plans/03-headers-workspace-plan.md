# Conex / Crish — 顶栏与分屏工作区 SmartExpandablePanel 工业级落地方案

> **文档标识**：`docs/smart-panel-migration/independent-plans/03-headers-workspace-plan.md`  
> **战役工作区**：`docs/smart-panel-migration/`  
> **架构角色**：顶栏与分屏工作区重构专家（Headers & Workspace Layout Specialist）  
> **权威遵循**：`AGENTS.md`（反退避铁律、架构优雅）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计红线）  
> **参考资产库**：`reference/smart-expandable-panel/`（CSS Tokens / Search / Items / Submenu / Safe-Aim Engine / Position Engine / React Wrapper）  
> **关联总方案**：`docs/smart-panel-migration/00-total-migration-plan.md`

---

## 目录索引

1. [执行摘要与治理全景图](#1-执行摘要与治理全景图)
2. [项目选择器（ProjectPickerMenu）两处违规彻底根治与组件重构](#2-项目选择器projectpickermenu两处违规彻底根治与组件重构)
3. [对话顶栏更多操作（ChatHeaderMore）动作收敛与数据驱动重构](#3-对话顶栏更多操作chatheadermore动作收敛与数据驱动重构)
4. [子代理运行状态与终止卡片流（SubagentHeaderPanel）](#4-子代理运行状态与终止卡片流subagentheaderpanel)
5. [分屏 Tab 栏与加号工具面板（LeafToolTabStrip）自适应高度改造](#5-分屏-tab-栏与加号工具面板leaftooltabstrip自适应高度改造)
6. [Safe-Aim 轨迹保护与 WAI-ARIA 全键盘无障碍交互设计](#6-safe-aim-轨迹保护与-wai-aria-全键盘无障碍交互设计)
7. [Design Tokens 与视觉几何体系映射矩阵](#7-design-tokens-与视觉几何体系映射矩阵)
8. [单元测试零回归保障与断言矩阵](#8-单元测试零回归保障与断言矩阵)
9. [分步实施路线图与验收清单](#9-分步实施路线图与验收清单)

---

## 1. 执行摘要与治理全景图

### 1.1 背景与现状断层诊断
在 Conex / Crish 桌面端界面的顶栏与分屏工作区中，浮层、选择器与上下文菜单承担着项目切换、会话管理、子代理监控与工作区多标签扩展等高频交互。经深度代码审查与视觉走查，发现以下严重断层与架构违规：

1. **项目选择器（`ProjectPickerMenu.tsx`）存在 2 处严重视觉违规与 400+ 行手写 DOM 冗余**：
   - **违规 1**：在主菜单内直接嵌入一个带有外边框与深色底的 `<Input variant="search" />` 独立贴片，破坏了沉浸式内嵌顶栏的纯净度；
   - **违规 2**：二级子菜单（「添加项目」级联）使用了 `14px` 膨胀大圆角与未样式化的裸字排版，缺少操作图标（`FolderOpen`/`FolderPlus`），且缺少高灵敏度的防误触轨迹保护；
   - **架构冗余**：手写了 417 行 DOM，内部维护了脆弱的 `SafeTriangleTracker` 鼠标定时器状态、复杂的键盘遍历索引与绝对定位样板代码。
2. **对话顶栏更多操作（`ChatHeaderMore.tsx`）动作未收敛且混用手写 JSX**：
   - 依赖旧版 `ui/Menu` 的 `renderItem` 回调手写 `<button>` 列表，未统一使用标准化 `MenuItem[]` 数据契约；
   - 缺乏危险操作（`danger: true`）的语义化统一表达与同心发丝卡片光影。
3. **子代理状态面板（`SubagentHeaderPanel.tsx`）卡片流排版与键盘导航断层**：
   - 状态徽章（Badge）和终止按钮（Kill Button）为定制化手写 DOM，未接入全局 `SmartExpandablePanel` 的槽位布局体系；
   - 缺少键盘上下箭头导航时的穿透选择与快捷终止按键支持。
4. **分屏 Tab 栏加号面板（`LeafToolTabStrip.tsx`）自适应高度与空态契约**：
   - 加号按钮展开的工具面板在可用工具数量较少时容易产生固定高度死白空间或非预期滚动条；
   - 双态加号（`inFlow` / `pinned`）未与 `PositionEngine` 的动态视口计算实现无缝脱敏。

### 1.2 顶栏与分屏工作区治理全景图

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   Top Header & Split Workspace Layout Architecture                     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Level 1: Header Breadcrumbs & Controls ]                                             │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐ │
│  │ ProjectPickerMenu       │  │ ChatHeaderMore          │  │ SubagentHeaderPanel     │ │
│  │ - 28px 内嵌搜索 Header   │  │ - 严格 3 核心动作收敛    │  │ - 运行中绿色脉冲指示    │ │
│  │ - 8px/6px 同心发丝卡片  │  │ - 数据驱动 MenuItem[]   │  │ - 子代理卡片流与终止    │ │
│  │ - Safe-Aim 级联添加     │  │ - 危险项红色语义高亮    │  │ - 一键侧边栏穿透查看    │ │
│  └───────────┬─────────────┘  └───────────┬─────────────┘  └───────────┬─────────────┘ │
├──────────────┼────────────────────────────┼────────────────────────────┼───────────────┤
│ [ Level 2: Split Workspace & Tab Strip ]                                               │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│  │ LeafToolTabStrip (Row 1: 30px Tabs Track + InFlow/Pinned Dual Plus Button)        │ │
│  │ - 纯数据驱动 viewRegistry -> MenuItem[] 过滤已占 Tab                               │ │
│  │ - 1 项条目紧凑自适应贴合，彻底消灭死白空洞与原生滚动条                            │ │
│  │ - 零延迟关闭切换算法 + ESC 安全退栈                                                │ │
│  └─────────────────────────────────────┬─────────────────────────────────────────────┘ │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ [ Foundation Layer: SmartExpandablePanel Engine ]                                      │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│  │ SmartExpandablePanel (Core) + PositionEngine (120Hz RAF) + SafeAimEngine (SVG)    │ │
│  │ Zero-Blue Palette (#f6f5f3 / #0c0c0b) + Concentric Radii (14px / 8px / 6px / 4px) │ │
│  └───────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 项目选择器（ProjectPickerMenu）两处违规彻底根治与组件重构

### 2.1 现状源码深度解剖（`apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.tsx`）

当前 `ProjectPickerMenu.tsx` 共 417 行代码，主要结构如下：
1. **行 201–230**：手写 `searchWrapper`，内部直接塞入 `<Input variant="search" size="sm" ... />`，导致面板顶部出现独立的圆角灰底输入框；
2. **行 233–278**：手写 `scrollArea`，内部遍历 `filtered.map` 渲染 `<div className={styles.projectRow}>`，每个条目内嵌独立的绝对定位删除按钮与对勾图标；
3. **行 305–411**：手写 `addCascadeWrapper` 与 `cascadeSubmenu`，内部维护 `SafeTriangleTracker` 实例及原生键盘上下左右键事件分发逻辑；
4. **`ProjectPickerMenu.module.css:98-111`**：级联子菜单硬编码 `border-radius: var(--sep-radius-outer, 14px);`，在只有 2 个条目的小浮层上呈现出夸张的膨胀大圆角，且内部条目为纯文字裸排（无图标）。

### 2.2 违规 1 根治：28px 顶栏一体化内嵌搜索 Header

#### 视觉与结构规范：
- **废除**：独立 `<Input variant="search" />` 贴片组件；
- **恢复**：`.sep-search-wrapper` 一体化内嵌搜索结构：
  * **高度**：严格锁定为 `28px`（`min-height: 28px`），与面板内边距完美贴合；
  * **背景**：完全透明（`background: transparent; border: none; box-shadow: none;`）；
  * **左侧放大镜**：固定 `14×14px` 极细图标（`stroke-width: 1.8`），悬停/聚焦时从 `--sep-text-muted`（`#8b8780`）平滑过渡至 `--sep-text-secondary`；
  * **输入文字**：`font-size: 12.5px`，占位符文字 `搜索项目...`，支持 `autoFocus` 与即时过滤；
  * **底部分割线**：紧随搜索栏之后渲染 1px 极细发丝分割线（`.sep-search-divider`，颜色为 `var(--sep-divider-color)`）。

```css
/* 顶栏一体化搜索 Header 规范 */
.sep-search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  min-height: 28px;
  padding: 0 4px 0 6px;
  margin: 1px var(--sep-padding, 6px) 0 var(--sep-padding, 6px);
  background: transparent;
  flex-shrink: 0;
  box-sizing: border-box;
}

.sep-search-icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--sep-text-muted, #8b8780);
  pointer-events: none;
}

.sep-search-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--sep-text-primary, #1d1c1a);
  outline: none;
  box-shadow: none;
}
```

### 2.3 违规 2 根治：标准同心发丝二级卡片与 14px 图标补齐

#### 视觉与结构规范：
- **废除**：`14px` 膨胀外圆角与纯文字裸排；
- **重构**：二级子菜单收敛为标准同心发丝卡片：
  * **外层圆角**：`8px`（`--sep-submenu-radius: 8px`）；
  * **内层条目圆角**：`6px`（`--sep-item-radius: 6px`）；
  * **内边距**：`4px`（`padding: 4px;`）；
  * **发丝边框**：`1px solid var(--sep-border-color)`（浅色 `#e2dfd9` / 深色 `#2b2926`）；
  * **毛玻璃光影**：`backdrop-filter: blur(28px) saturate(160%); box-shadow: var(--sep-shadow);`；
  * **图标补齐**：
    - 「打开本地项目...」：补齐 `<Lucide.FolderOpen size={14} strokeWidth={1.8} />`；
    - 「新建空白项目...」：补齐 `<Lucide.FolderPlus size={14} strokeWidth={1.8} />`。

```
┌──────────────────────────────────────────────────────┐
│  主面板 (Outer: 14px / Padding: 6px)                 │
│  ┌────────────────────────────────────────────────┐  │
│  │ 🔍 搜索项目...                                 │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 📁 Alpha 项目                             ✓    │  │
│  │ 📁 Beta 项目                              🗑️   │  │
│  ├────────────────────────────────────────────────┤  │
│  │ 📁 通用项目                                    │  │
│  │ ➕ 添加项目                                 › ──┼──┐
│  └────────────────────────────────────────────────┘  ││
└──────────────────────────────────────────────────────┘│
                                                        ▼
                    ┌───────────────────────────────────────┐
                    │ 级联子卡片 (Outer: 8px / Pad: 4px)     │
                    │ ┌───────────────────────────────────┐ │
                    │ │ 📂 打开本地项目...                │ │
                    │ │ 📁➕ 新建空白项目...               │ │
                    │ └───────────────────────────────────┘ │
                    └───────────────────────────────────────┘
```

### 2.4 违规 3 / 架构根治：彻底接入 SmartExpandablePanel 纯数据驱动

将 417 行复杂状态机与 DOM 手写代码彻底重构为 `MenuItem[]` 声明式契约：

```typescript
// apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.tsx

import React, { useMemo, useState, useCallback } from 'react';
import {
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  addProjectFromPath,
  GENERAL_FOLDER,
  getActiveProjectId,
  listProjects,
  openProject,
  removeProject,
  setNoProject,
  type ProjectEntry,
} from '../../api/projectStore';
import { openDirectoryDialogSafe } from '../../api/openDirectoryDialog';
import { getSessionStoreState, setDraftFolder } from '../../api/storeAccess';
import { isPendingDraft } from '../../store/storeAccess';
import { ConfirmDialog, Tooltip } from '../ui';
import { useConfirmGate } from '../../hooks/useConfirmGate';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';

function syncDraftFolderOnProjectChange(folder: string): void {
  if (isPendingDraft(getSessionStoreState().activeSessionId)) {
    setDraftFolder(folder);
  }
}

export interface ProjectPickerMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose?: () => void;
  onChanged?: () => void;
  children: React.ReactNode;
  onContentMouseEnter?: () => void;
  onContentMouseLeave?: () => void;
}

export const ProjectPickerMenu: React.FC<ProjectPickerMenuProps> = ({
  open,
  onOpenChange,
  onClose,
  onChanged,
  children,
  onContentMouseEnter,
  onContentMouseLeave,
}) => {
  const [projectListVersion, setProjectListVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const activeId = getActiveProjectId();
  const [confirmGate, renderConfirmGate] = useConfirmGate();

  const refresh = useCallback(() => {
    setProjectListVersion((v) => v + 1);
  }, []);

  const projects = useMemo(() => {
    // 依赖 projectListVersion 与 open 状态即时获取最新项目列表
    void projectListVersion;
    return listProjects();
  }, [projectListVersion, open]);

  const handlePickFolder = async () => {
    setBusy(true);
    try {
      const path = await openDirectoryDialogSafe('选择现有项目文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        refresh();
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCreateEmptyProject = async () => {
    setBusy(true);
    try {
      const path = await openDirectoryDialogSafe('选择或创建空白文件夹');
      if (path) {
        addProjectFromPath(path);
        onChanged?.();
        refresh();
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveProject = async (p: ProjectEntry) => {
    const ok = await confirmGate({
      title: '移除项目',
      description: `确定从列表移除项目「${p.name}」？`,
      confirmLabel: '移除项目',
    });
    if (!ok) return;
    removeProject(p.id);
    refresh();
    onChanged?.();
  };

  const pickProject = useCallback(
    (id: string) => {
      openProject(id);
      syncDraftFolderOnProjectChange(id);
      onChanged?.();
      onOpenChange(false);
    },
    [onChanged, onOpenChange]
  );

  // 纯数据驱动 Schema 构造
  const menuItems = useMemo<MenuItem[]>(() => {
    const projectItems: MenuItem[] = projects.map((p) => {
      const isSelected = p.id === activeId;
      return {
        id: `proj:${p.id}`,
        type: 'selectable',
        label: p.name,
        sublabel: p.path,
        icon: <Folder size={14} />,
        selected: isSelected,
        searchKeywords: `${p.name} ${p.path}`,
        onSelect: () => pickProject(p.id),
        // 自定义尾部动作：非通用项目支持悬停删除按钮
        trailingAction:
          p.id !== GENERAL_FOLDER ? (
            <Tooltip content="从列表移除项目">
              <button
                type="button"
                className="sep-item-action-btn sep-danger-hover"
                aria-label={`从列表移除项目 ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemoveProject(p);
                }}
              >
                <Trash2 size={12} />
              </button>
            </Tooltip>
          ) : undefined,
      };
    });

    const isGeneralSelected = !activeId || activeId === GENERAL_FOLDER;

    return [
      // 1. 项目列表组（支持内嵌滚动与选中高亮）
      {
        id: 'project-list-group',
        type: 'group',
        isSelectableList: true,
        items: projectItems,
      },
      // 2. 分割线
      {
        id: 'sep-1',
        type: 'divider',
      },
      // 3. 通用项目固定选项
      {
        id: 'proj:general',
        type: 'selectable',
        label: '通用项目',
        icon: <Folder size={14} />,
        selected: isGeneralSelected,
        onSelect: () => {
          setNoProject();
          syncDraftFolderOnProjectChange(GENERAL_FOLDER);
          onChanged?.();
          onOpenChange(false);
        },
      },
      // 4. 添加项目级联子菜单（带有 Safe-Aim 轨迹保护）
      {
        id: 'action:add-project',
        type: 'submenu',
        label: '添加项目',
        icon: <Plus size={14} />,
        children: [
          {
            id: 'action:open-local',
            label: '打开本地项目...',
            icon: <FolderOpen size={14} />,
            disabled: busy,
            onSelect: handlePickFolder,
          },
          {
            id: 'action:create-empty',
            label: '新建空白项目...',
            icon: <FolderPlus size={14} />,
            disabled: busy,
            onSelect: handleCreateEmptyProject,
          },
        ],
      },
    ];
  }, [projects, activeId, busy, pickProject, onChanged, onOpenChange]);

  return (
    <>
      {renderConfirmGate(<ConfirmDialog />)}
      <SmartExpandablePanel
        open={open}
        onOpenChange={onOpenChange}
        onClose={onClose}
        trigger={children}
        items={menuItems}
        enableSearch={true}
        searchPlaceholder="搜索项目"
        position={{ side: 'bottom', align: 'center', sideOffset: 6 }}
        className="project-picker-panel"
        onMouseEnter={onContentMouseEnter}
        onMouseLeave={onContentMouseLeave}
      />
    </>
  );
};
```

---

## 3. 对话顶栏更多操作（ChatHeaderMore）动作收敛与数据驱动重构

### 3.1 顶栏操作收敛原则
对话顶栏右上角操作区域（`UnitChromeActions.tsx`）严格执行 **Exactly 3 核心动作** 架构规范：
1. **动作 1：应用预览（🌐 Globe）**：直接点击在右侧分屏打开/切换至应用预览；
2. **动作 2：代码产物与文件（📄 FileCode）**：直接点击在右侧分屏打开/切换至产物目录；
3. **动作 3：更多操作（⋯ MoreHorizontal）**：触发 `ChatHeaderMore`，展开所有低频管理操作。

### 3.2 更多操作（`ChatHeaderMore`）Schema 映射与标准化

将分散的 `<button>` 列表全面转化为 `MenuItem[]`，支持危险项语义标红、图标对齐与分组渲染：

```typescript
// apps/crish-desktop/src/components/chat-card/ChatHeaderMore.tsx

import React, { useMemo } from 'react';
import {
  Download,
  Folder,
  Link,
  MoreHorizontal,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { IconButton, Tooltip } from '../ui';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import { UNIT_CHROME_TOOL_TIP_SIDE } from './unitChromeLabel';

export interface FolderOption {
  id: string;
  label: string;
}

export interface ChatHeaderMoreProps {
  onClearHistory?: () => void;
  onExportMarkdown?: () => void;
  onTogglePin?: () => void;
  isPinned?: boolean;
  canExport?: boolean;
  onMoveToFolder?: (folderId: string) => void;
  folderOptions?: FolderOption[];
  currentFolder?: string;
  className?: string;
  onShare?: () => void;
  shareFlash?: boolean;
}

export const ChatHeaderMore: React.FC<ChatHeaderMoreProps> = ({
  onClearHistory,
  onExportMarkdown,
  onTogglePin,
  isPinned = false,
  canExport = true,
  onMoveToFolder,
  folderOptions,
  currentFolder,
  className,
  onShare,
  shareFlash = false,
}) => {
  const menuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];

    // 1. 固定/取消固定会话
    if (onTogglePin) {
      items.push({
        id: 'action:pin',
        label: isPinned ? '取消固定' : '固定会话',
        icon: isPinned ? <PinOff size={14} /> : <Pin size={14} />,
        onSelect: onTogglePin,
      });
    }

    // 2. 移动至文件夹/项目（如有多个可选）
    if (onMoveToFolder && folderOptions && folderOptions.length > 0) {
      const validFolders = folderOptions.filter((f) => f.id !== currentFolder);
      if (validFolders.length > 0) {
        items.push({
          id: 'submenu:move',
          type: 'submenu',
          label: '移动到项目...',
          icon: <Folder size={14} />,
          children: validFolders.map((f) => ({
            id: `move:${f.id}`,
            label: f.label,
            icon: <Folder size={14} />,
            onSelect: () => onMoveToFolder(f.id),
          })),
        });
      }
    }

    // 3. 导出与分享功能组
    const exportShareItems: MenuItem[] = [];
    if (onExportMarkdown && canExport) {
      exportShareItems.push({
        id: 'action:export',
        label: '导出 Markdown',
        icon: <Download size={14} />,
        shortcut: 'Ctrl+E',
        onSelect: onExportMarkdown,
      });
    }

    if (onShare) {
      exportShareItems.push({
        id: 'action:share',
        label: shareFlash ? '已复制 Markdown' : '分享会话',
        icon: <Link size={14} />,
        badge: shareFlash ? '已复制' : undefined,
        onSelect: onShare,
      });
    }

    if (exportShareItems.length > 0) {
      if (items.length > 0) {
        items.push({ id: 'divider:export-share', type: 'divider' });
      }
      items.push(...exportShareItems);
    }

    // 4. 危险操作组（清空记录）
    if (onClearHistory) {
      if (items.length > 0) {
        items.push({ id: 'divider:danger', type: 'divider' });
      }
      items.push({
        id: 'action:clear',
        label: '清空记录',
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: onClearHistory,
      });
    }

    return items;
  }, [
    onTogglePin,
    isPinned,
    onMoveToFolder,
    folderOptions,
    currentFolder,
    onExportMarkdown,
    canExport,
    onShare,
    shareFlash,
    onClearHistory,
  ]);

  const trigger = (
    <Tooltip content="更多操作" side={UNIT_CHROME_TOOL_TIP_SIDE}>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        className={className}
        data-testid="chat-header-more"
        aria-label="更多选项"
        icon={<MoreHorizontal size={16} />}
      />
    </Tooltip>
  );

  return (
    <SmartExpandablePanel
      trigger={trigger}
      items={menuItems}
      position={{ align: 'end', side: 'bottom', sideOffset: 6 }}
      className="chat-header-more-panel"
    />
  );
};
```

---

## 4. 子代理运行状态与终止卡片流（SubagentHeaderPanel）

### 4.1 顶栏胶囊状态指示规范
顶栏面包屑第 3 级（`UnitChromeActions.tsx:314-329`）集成子代理状态胶囊：
- **运行中状态（`runningCount > 0`）**：
  * 左侧展示 **绿色脉冲呼吸灯（`liveDot`）**，`5×5px` 圆点配合 `1.4s` 缩放呼吸动效；
  * 文字展示为 `${runningCount} 个运行中`；
  * 胶囊背景浅绿微调色淡入，悬停提供柔和高亮。
- **空闲/完成状态（`runningCount === 0`）**：
  * 左侧展示中性灰色机器人图标（`<Lucide.Bot size={13} />`）；
  * 文字展示为 `${agents.length} 个子代理`；
  * 右侧携带 11px 折叠小箭头（`<Lucide.ChevronDown size={11} />`）。

### 4.2 浮层卡片流与数据驱动重构

`SubagentHeaderPanel` 展开的浮层展示当前会话下派发的所有子代理卡片。
采用 `SmartExpandablePanel` 容器与标准化条目渲染，支持状态徽章、任务摘要截断、一键侧边栏穿透与终止操作：

```typescript
// apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.tsx

import React, { useMemo } from 'react';
import { Bot, ChevronDown, OctagonAlert, Play, CheckCircle2, XCircle } from 'lucide-react';
import type { SessionAgent } from '../../store/types';
import { countRunningSubagents } from './unitChromeLabel';
import { Tooltip } from '../ui';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import styles from './SubagentHeaderPanel.module.css';

export interface SubagentHeaderPanelProps {
  agents: SessionAgent[];
  parentSessionId: string;
}

export const SubagentHeaderPanel: React.FC<SubagentHeaderPanelProps> = ({
  agents,
  parentSessionId,
}) => {
  const runningCount = useMemo(() => countRunningSubagents(agents), [agents]);

  const trigger = (
    <Tooltip content="查看子 Agent 状态" side="bottom">
      <button
        type="button"
        id="bcAgentCapsule"
        className={`${styles.agentTrigger} ${styles.breadcrumbAgentBtn} breadcrumb-agent-btn ${
          runningCount > 0 ? styles.isRunning : ''
        }`}
        aria-label="展开子代理状态面板"
      >
        {runningCount > 0 ? (
          <>
            <span
              className={`${styles.liveDot} ${styles.agentLiveDot} agent-live-dot`}
              aria-hidden="true"
            />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {runningCount} 个运行中
            </span>
          </>
        ) : (
          <>
            <Bot size={13} className={styles.botIcon} aria-hidden="true" />
            <span
              className={`${styles.triggerText} ${styles.bcAgentText} bc-agent-text`}
            >
              {agents.length} 个子代理
            </span>
          </>
        )}
        <ChevronDown
          size={11}
          className={`${styles.bcChevron} bc-chevron`}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    return agents.map((agent) => {
      const anyAgent = agent as Partial<SessionAgent> & {
        name?: string;
        role?: string;
        task?: string;
      };
      const agentName =
        anyAgent.name ||
        anyAgent.role ||
        agent.displayLabel ||
        agent.description ||
        agent.mode ||
        '子代理';
      const agentTask = anyAgent.task || agent.summary || agent.description;
      const isRunning = agent.status === 'running';

      let statusBadgeText = '空闲';
      let statusIcon = <Bot size={14} />;
      let badgeClass = styles.badgeIdle;

      if (isRunning) {
        statusBadgeText = '运行中';
        statusIcon = <Play size={14} className={styles.pulseGreen} />;
        badgeClass = styles.badgeRunning;
      } else if (agent.status === 'completed') {
        statusBadgeText = '已完成';
        statusIcon = <CheckCircle2 size={14} />;
        badgeClass = styles.badgeCompleted;
      } else if (agent.status === 'failed') {
        statusBadgeText = '失败';
        statusIcon = <XCircle size={14} />;
        badgeClass = styles.badgeFailed;
      } else if (agent.status === 'stopped') {
        statusBadgeText = '已停止';
        statusIcon = <OctagonAlert size={14} />;
        badgeClass = styles.badgeStopped;
      }

      return {
        id: `agent:${agent.id}`,
        label: agentName,
        sublabel: agentTask,
        icon: statusIcon,
        badge: statusBadgeText,
        badgeClassName: badgeClass,
        searchKeywords: `${agentName} ${agentTask || ''}`,
        onSelect: () => {
          openAgentInSidePanel(agent.id, { sessionId: parentSessionId });
        },
        trailingAction: isRunning ? (
          <Tooltip content="终止子代理">
            <button
              type="button"
              className="sep-item-action-btn sep-danger-hover"
              aria-label="终止子代理"
              onClick={(e) => {
                e.stopPropagation();
                killSubagent(parentSessionId, agent.id);
              }}
            >
              <OctagonAlert size={12} />
            </button>
          </Tooltip>
        ) : undefined,
      };
    });
  }, [agents, parentSessionId]);

  return (
    <SmartExpandablePanel
      trigger={trigger}
      items={menuItems}
      position={{ align: 'start', side: 'bottom', sideOffset: 6 }}
      className="subagent-header-panel"
    />
  );
};
```

---

## 5. 分屏 Tab 栏与加号工具面板（LeafToolTabStrip）自适应高度改造

### 5.1 双态加号架构与视口防溢出算法
`LeafToolTabStrip.tsx`（分屏标签栏）具备行业领先的双态加号机制：
1. **随流加号（`inFlow`）**：在 Tab 总宽度未超出 Track 容器时，加号按钮紧随最后一个 Tab 之后；
2. **固定区加号（`pinned`）**：在 Tab 过多触发水平滚动溢出时（`hasOverflow === true`），`inFlow` 加号平滑淡出，右侧固定操作区中的 `pinned` 加号无缝淡入。

### 5.2 纯数据驱动加号菜单重构与自适应贴合

#### 核心治理点：
1. **纯数据驱动映射**：加号面板从 `viewRegistry.getToolViews()` 动态获取可用工具，并精确排除当前已打开的所有 Tab（`occupied = new Set(tabs)`）；
2. **根除 1 项条目时的死白空洞与原生滚动条**：
   - 彻底废除写死 `height: 220px` 或 `overflow-y: scroll`；
   - 面板高度根据可用工具条目数量自适应贴合（`height: auto; max-height: min(320px, 60vh)`）；
   - 当仅剩余 1–2 个工具时，面板高度紧凑贴合，绝不留多余空白空间，绝不出原生滚动条；
3. **全占满自动 Tooltip**：当所有工具均已被打开时，加号按钮退化为普通 Tooltip 提示「已打开全部工具」，不弹出空面板。

```typescript
// LeafToolTabStrip.tsx 中加号菜单的数据驱动渲染重构

const renderAddButton = (isInFlow: boolean) => {
  const btnClass = `${styles.addBtn} ${
    isInFlow ? styles.inFlow : styles.pinned
  } ${isInFlow ? 'in-flow' : 'pinned'} side-panel-add-btn`;

  const btnElement = (
    <button
      type="button"
      className={btnClass}
      aria-label="添加功能面板"
    >
      <Plus size={13} strokeWidth={2} />
    </button>
  );

  if (availablePanels.length === 0) {
    return (
      <Tooltip content="已打开全部工具标签" side="bottom">
        {btnElement}
      </Tooltip>
    );
  }

  const addMenuItems: MenuItem[] = availablePanels.map((pid) => {
    const Icon = viewRegistry.getIcon(pid);
    const title = viewRegistry.getTitle(pid);
    return {
      id: `tool:${pid}`,
      label: title,
      icon: Icon ? <Icon size={14} /> : undefined,
      onSelect: () => openPanel(pid),
    };
  });

  return (
    <SmartExpandablePanel
      trigger={
        <Tooltip content="添加工具标签" side="bottom">
          {btnElement}
        </Tooltip>
      }
      items={addMenuItems}
      position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
      className="leaf-tool-add-panel"
    />
  );
};
```

---

## 6. Safe-Aim 轨迹保护与 WAI-ARIA 全键盘无障碍交互设计

### 6.1 Safe-Aim 零 Canvas SVG 虚拟多边形碰撞算法

在 `ProjectPickerMenu` 的「添加项目」以及 `ChatHeaderMore` 的「移动到项目」等二级级联子菜单场景中，用户鼠标从父条目斜向滑向子菜单时，极易划过相邻项导致子菜单闪退。

```
                    Safe-Aim Collision Triangle
       (x0, y0)
     Mouse Cursor ─────────────────────────┐ Submenu Top (x1, y1)
            \                              │
             \    Safe Triangle Polygon    │  Floating Submenu
              \   (Zero-Canvas SVG)        │  (Cascade)
               \                           │
                └──────────────────────────┘ Submenu Bottom (x2, y2)
```

#### 重心坐标（Barycentric Coordinates）命中判定算法：
对于点 $P(x,y)$ 与三角形顶点 $A(x_0,y_0)$、$B(x_1,y_1)$、$C(x_2,y_2)$：
$$
\vec{v_0} = C - A, \quad \vec{v_1} = B - A, \quad \vec{v_2} = P - A
$$
通过点积求重心坐标系数 $(u, v)$：
$$
u = \frac{(\vec{v_1}\cdot\vec{v_1})(\vec{v_2}\cdot\vec{v_0}) - (\vec{v_1}\cdot\vec{v_0})(\vec{v_2}\cdot\vec{v_1})}{(\vec{v_0}\cdot\vec{v_0})(\vec{v_1}\cdot\vec{v_1}) - (\vec{v_0}\cdot\vec{v_1})^2}
$$
$$
v = \frac{(\vec{v_0}\cdot\vec{v_0})(\vec{v_2}\cdot\vec{v_1}) - (\vec{v_0}\cdot\vec{v_1})(\vec{v_2}\cdot\vec{v_0})}{(\vec{v_0}\cdot\vec{v_0})(\vec{v_1}\cdot\vec{v_1}) - (\vec{v_0}\cdot\vec{v_1})^2}
$$
当且仅当 $u \ge 0, v \ge 0, u + v \le 1$ 时，鼠标指针完全处于安全区域内，系统**严格锁定当前子菜单不关闭**。

### 6.2 WAI-ARIA 全键盘漫游状态机（Roving TabIndex）

顶栏与分屏工作区的所有面板全面接入 WAI-ARIA 规范：

| 键盘按键 | 行为与状态转移 | 边界处理 |
| :--- | :--- | :--- |
| `↑`（ArrowUp） | 将高亮焦点移动至上一个可交互条目 | 到达首项时循环回到底部最后一项；自动跳过 `divider` 和 `disabled` 项 |
| `↓`（ArrowDown） | 将高亮焦点移动至下一个可交互条目 | 到达末项时循环回到顶部第一项；若搜索栏有焦点则下移至首个结果 |
| `→`（ArrowRight） | 若当前项为 `submenu`，展开级联子菜单并聚焦其首项 | 非子菜单项无操作 |
| `←`（ArrowLeft） | 若当前处于级联子菜单中，安全退回到父级项并聚焦 | 处于主菜单时无操作 |
| `Enter` / `Space` | 触发当前高亮项的 `onSelect` 回调并关闭面板 | 若为子菜单项则展开子级 |
| `Escape` | 级联子菜单优先退栈；顶层主菜单安全关闭并恢复触发器焦点 | 保证页面焦点不丢失 |

---

## 7. Design Tokens 与视觉几何体系映射矩阵

所有顶栏与工作区分屏浮层严格绑定项目全局 Design Tokens，彻底根除硬编码像素与非标准变量：

| 属性维度 | Light 浅色模式 Token | Dark 深色模式 Token | 设计规范与几何约束 |
| :--- | :--- | :--- | :--- |
| **主面板外圆角** | `--sep-radius-outer: 14px` | `--sep-radius-outer: 14px` | 大圆角弥散气泡感 |
| **面板内衬 Padding** | `--sep-padding: 6px` | `--sep-padding: 6px` | 四周均匀内衬 |
| **主面板条目圆角** | `--sep-item-radius: 8px` | `--sep-item-radius: 8px` | $14 - 6 = 8\text{px}$ 数学同心圆角 |
| **二级子卡片外角** | `--sep-submenu-radius: 8px`| `--sep-submenu-radius: 8px`| 小型浮层收敛圆角，告别 14px 膨胀 |
| **二级子卡片条目** | `--sep-subitem-radius: 6px`| `--sep-subitem-radius: 6px`| $8 - 2 = 6\text{px}$ 紧凑同心圆角 |
| **面板背景色板** | `rgba(255, 254, 252, 0.96)` | `rgba(18, 17, 16, 0.96)` | Zero-Blue 暖白/碳黑墨阶底色 |
| **实体发丝边框** | `#e2dfd9` | `#2b2926` | 单层实体发丝线，无多层模糊杂影 |
| **条目悬停 Hover** | `rgba(29, 28, 26, 0.045)` | `rgba(255, 255, 255, 0.06)`| 4.5% 轻柔微灰，杜绝深青灰色块 |
| **条目选中态 Selected** | `rgba(29, 28, 26, 0.065)` | `rgba(255, 255, 255, 0.09)`| 6.5% 微灰背景 + `#059669` 翡翠绿对勾 |
| **毛玻璃弥散光影** | `0 12px 36px rgba(0,0,0,0.08)`| `0 16px 48px rgba(0,0,0,0.45)`| 28px 毛玻璃模糊 + 160% 饱和度 |

---

## 8. 单元测试零回归保障与断言矩阵

为确保本次重构 100% 保护现有测试资产，针对全套测试用例制定如下契约映射：

### 8.1 `ProjectPickerMenu.test.tsx` 契约保障
1. **DOM 角色断言**：主面板保持 `role="menu"` 与 `aria-label="选择项目"`，各项目保持 `role="menuitem"`；
2. **搜索功能断言**：搜索框保持 `role="searchbox"` 或对应语义，输入关键词时项目列表即时更新；
3. **选择与关闭断言**：点击项目触发 `projectStore.openProject`、`onChanged` 及 `onOpenChange(false)`；
4. **添加项目级联断言**：Hover 或点击「添加项目」展开 `role="menu"`（`aria-label="添加项目"`），包含「打开本地项目...」和「新建空白项目...」；
5. **受控卸载断言**：`open={false}` 时面板安全从 DOM 树中卸载。

### 8.2 `SubagentHeaderPanel.test.tsx` 契约保障
1. **运行中状态断言**：存在运行中 Agent 时展示 `${count} 个运行中` 与 `liveDot`；
2. **空闲状态断言**：无运行中 Agent 时展示 `${count} 个子代理` 与 Bot 图标；
3. **列表弹出断言**：点击展开后展示各子代理名称、状态文本（运行中/已完成/失败/已停止）及摘要；
4. **侧边栏跳转断言**：点击卡片触发 `openAgentInSidePanel(agent.id, ...)`；
5. **终止子代理断言**：点击终止按钮触发 `killSubagent(parentSessionId, agent.id)` 且不触发卡片跳转事件。

### 8.3 `LeafToolTabStrip.scoped.test.tsx` 极限测试保障（562 行，15+ 断言）
1. **基础渲染与双态加号**：保持 `.side-panel-add-btn.in-flow` 与 `.side-panel-add-btn.pinned` 类名与结构；
2. **过滤已占 Tab**：加号菜单弹出时自动过滤已打开的 Tab 项；
3. **Tab 切换与动画**：点击切换 Tab、中键关闭 Tab、多 Tab 并发关闭与 220ms 退出动画完整维持；
4. **空态 Launcher Hub**：0 Tab 时无缝展示 `SidePanelLauncherHub` 居中卡片组；
5. **ESC 键退栈压测**：加号菜单展开后按 ESC 安全关闭，连续 50 次高频切换零死锁、零内存泄漏。

---

## 9. 分步实施路线图与验收清单

### 9.1 阶段规划

| 阶段 | 实施任务 | 涉及核心文件 | 验收标准 |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **项目选择器重构** | `ProjectPickerMenu.tsx`<br>`ProjectPickerMenu.module.css` | 1. 废除独立 `<Input>` 贴片，恢复 28px 一体化搜索 Header<br>2. 二级卡片收敛为 8px/6px 同心圆角并补齐 14px 图标<br>3. 全面接入 `SmartExpandablePanel`<br>4. `ProjectPickerMenu.test.tsx` 全绿 |
| **Phase 2** | **对话顶栏更多操作收敛** | `ChatHeaderMore.tsx`<br>`ChatHeaderMore.module.css`<br>`UnitChromeActions.tsx` | 1. 严格收敛为 3 核心顶栏动作<br>2. 更多操作转换为 `MenuItem[]` 纯数据驱动<br>3. 危险项语义标红与同心发丝卡片样式<br>4. `UnitChromeActions.scoped.test.tsx` 全绿 |
| **Phase 3** | **子代理状态卡片流升级** | `SubagentHeaderPanel.tsx`<br>`SubagentHeaderPanel.module.css` | 1. 顶栏绿色呼吸灯胶囊视觉打磨<br>2. 面板卡片流接入 `SmartExpandablePanel`<br>3. 键盘上下选择与侧边栏/终止操作打通<br>4. `SubagentHeaderPanel.test.tsx` 全绿 |
| **Phase 4** | **分屏 Tab 栏加号面板改造** | `LeafToolTabStrip.tsx`<br>`LeafToolTabStrip.module.css` | 1. 加号面板纯数据驱动化，动态过滤已占 Tab<br>2. 1 项条目时紧凑自适应贴合，彻底消灭死白空洞与原生滚动条<br>3. `LeafToolTabStrip.scoped.test.tsx` 全绿 |
| **Phase 5** | **全量集成与视觉走查** | 全仓顶栏与分屏组件 | 1. `npm run typecheck` 零类型报错<br>2. `npm test` 全量单测 100% 绿灯<br>3. CDP WebView2 9222 真实高保真走查 |

### 9.2 最终验收断言清单

- [ ] **视觉纯净度**：搜索栏与顶栏 100% 融为一体，彻底消灭任何灰底贴片与重边框；
- [ ] **同心圆角严谨度**：主面板 14px 外角 / 6px 内衬 / 8px 条目；二级子菜单 8px 外角 / 4px 内衬 / 6px 条目；
- [ ] **色彩纯净度**：浅色模式下无深青灰色块，深色模式下为中性碳素墨阶；
- [ ] **防误触顺滑度**：Safe-Aim 轨迹保护让斜向滑向子菜单 120Hz 丝滑稳定；
- [ ] **测试资产完整度**：全仓 800+ 单元测试 100% 通过，无 `--no-verify`，无退避妥协。
