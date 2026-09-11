# Conex / Crish — 侧边栏、文件管理与差异工具 SmartExpandablePanel 重构落地方案

> **文档标识**：`docs/smart-panel-migration/independent-plans/05-sidebar-files-diff-plan.md`
> **战役工作区**：`docs/smart-panel-migration/`
> **架构角色**：侧边栏、文件管理与差异工具重构专家（Sidebar, Files & Diff Specialist）
> **权威遵循**：`AGENTS.md`（反退避铁律、架构优雅、测试资产保护）、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/smart-panel-migration/00-total-migration-plan.md`
> **参考资产库**：`reference/smart-expandable-panel/`（CSS Tokens / Panel / Search / Items / Submenu / Safe-Aim / Position / React Wrapper）

---

## 目录索引

1. [架构愿景与重构目标矩阵](#1-架构愿景与重构目标矩阵)
2. [侧边栏会话右键菜单重构方案（SessionContextMenu & SidebarContextMenus）](#2-侧边栏会话右键菜单重构方案sessioncontextmenu--sidebarcontextmenus)
3. [侧边栏排序/过滤级联下拉重构方案（ContextMenuFlyout）](#3-侧边栏排序过滤级联下拉重构方案contextmenuflyout)
4. [侧边栏快捷设置菜单重构方案（SettingsQuickMenu）](#4-侧边栏快捷设置菜单重构方案settingsquickmenu)
5. [文件浏览器与路径面包屑重构方案（FileBreadcrumb, FileActions, FileViewerCard）](#5-文件浏览器与路径面包屑重构方案filebreadcrumb-fileactions-fileviewercard)
6. [Git 差异工具与随手笔记浮层重构方案（DiffHeaderControls, DiffCardFileList, SlashMenuOverlay）](#6-git-差异工具与随手笔记浮层重构方案diffheadercontrols-diffcardfilelist-slashmenuoverlay)
7. [Design Tokens 与视觉契约映射表](#7-design-tokens-与视觉契约映射表)
8. [向后兼容与测试套件零回归保障](#8-向后兼容与测试套件零回归保障)
9. [四阶段分步实施路线图与验收自检清单](#9-四阶段分步实施路线图与验收自检清单)

---

## 1. 架构愿景与重构目标矩阵

### 1.1 现状痛点诊断与根因分析

在 Conex / Crish 桌面端现有架构中，侧边栏、文件管理与差异工具模块分散着大量各自为政的手写浮层与菜单实现，存在五大系统性架构缺陷：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               存量交互浮层五大断层诊断                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 手写 DOM 模板膨胀  │ SessionContextMenu 存在 10+ 手写 <button> 与自研 measureMenu 坐标钳位 │
│ 2. 脆弱定时器级联     │ ContextMenuFlyout 依赖 80ms/150ms setTimeout 防抖，易发生子菜单闪退     │
│ 3. 悬停气泡视觉噪点   │ SettingsQuickMenu 子项全套包裹 <Tooltip>，划过时频跳黑色大标签气泡      │
│ 4. 孤立手写目录浮层   │ FileBreadcrumb 维护 120 行独立手写 DOM 浮层，缺少统一搜索与键盘导航    │
│ 5. 杂色青底严重侵蚀   │ 菜单直接消费 --sidebar-hover/active，在白底面板呈现 20%~30% 泥灰脏色块   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 改造收益与目标矩阵

对照 `reference/smart-expandable-panel/` 资产库，本方案对目标模块进行全面工业级下沉与重构：

| 模块组件 | 当前实现机制 | 迁移目标与架构升级 | 核心收益 |
| :--- | :--- | :--- | :--- |
| `SessionContextMenu.tsx` | 296 行，手写 10 个 `<button>`、自研 25 行 `measureMenu` 与 38 行键盘漫游 | 迁移至 `SmartExpandablePanel` 坐标点模式（`openAtPoint` / `point: {x,y}`），配置标准 `MenuItem[]` | 缩减代码 ~180 行，统一 14px/8px 同心圆角、1px 实体发丝边框与 `danger` 危险项 |
| `ContextMenuFlyout.tsx` | 394 行，自研 `FlyKey` 状态机、80ms/150ms 定时器与手动 `flipLeft` 视口计算 | 迁移至数据驱动级联 `MenuItem.children` 与 `type: 'submenu'`，接入 SVG Safe-Aim 碰撞多边形 | 彻底移除脆弱定时器，120Hz 重心坐标斜切防误触，视口自适应双向翻转 |
| `SettingsQuickMenu.tsx` | 306 行，Radix `Menu` + 内部手写 DOM + 每个菜单项包裹 `<Tooltip>` | 顶部嵌入主题分段控制器，选项转换为标准 `MenuItem[]`，消灭子项全套 Tooltip 悬停噪点 | 消除悬停视觉干扰，锁定 `--sep-bg-item-hover`（4.5% 极浅暖灰），消灭青灰泥底 |
| `FileBreadcrumb.tsx` | 345 行，内嵌 120 行手写 `filesBcFlyout` 目录树与全局 DOM 监听 | 废弃手写浮层，整体替换为带搜索过滤（`enableSearch: true`）与条目导航的 `SmartExpandablePanel` | 异步目录即时搜索过滤、原生键盘上下键漫游、统一回车直达 |
| `FileActions.tsx` & `FileViewerCard.tsx` | 旧版 `Menu` 嵌套自定义 options 与展开折叠逻辑 | 打开方式胶囊（`HostOpeners`）与「更多操作」全面收敛至标准 `MenuItem[]` | 统一图标与文字栅格对齐、多应用展开折叠规范化 |
| `DiffHeaderControls.tsx` & `DiffCardFileList.tsx` | 原生 `Select` 控件与手写内联操作栏 | AI 改动回合（`turnOptions`）、Git 分支选择与对比维度升级为智能数据驱动选择器 | 统一搜索与时间戳副标题、手风琴折叠与内联操作对齐 `--sep-*` 统一 Token |
| `SlashMenuOverlay.tsx` | 独立 `@crish/block-paper` 样式 | 视觉样式对齐 `--sep-*` 规范（14px/8px 同心圆角、实体发丝边框），保持 CONN-B 只读保护 | 保持编辑器内核契约同时实现全局视觉一致性 |

---

## 2. 侧边栏会话右键菜单重构方案（SessionContextMenu & SidebarContextMenus）

### 2.1 现状代码与架构断层分析

当前 `SessionContextMenu.tsx`（296 行）存在以下严重问题：
1. **重复造轮子**：内嵌 25 行手写 `measureMenu` 视口钳位算法（第 27–55 行）与 38 行手写 `focusMenuItem`/`onMenuKeyDown`（第 58–95 行）；
2. **DOM 结构臃肿脆弱**：手写 10 个 `<button className={styles.contextMenuItem}>` 与 3 条 `<div className={styles.contextMenuDivider}>`（第 174–291 行）；
3. **视觉不一致**：使用 `--radius-2xl`（非数学同心圆角）、`box-shadow: var(--shadow-lg)`（存在黑色伪环）、`:hover` 时直接读取 `--sidebar-hover`（在白底卡片中呈现青绿泥色）；
4. **危险项粗糙**：删除按钮使用内联样式 `style={{ color: 'var(--text-danger)' }}`，缺少浅红半透明背景与焦点态安全保护。

### 2.2 纯数据驱动 Schema 设计

将 10 个业务动作收敛为标准 `MenuItem[]` Schema：

```typescript
// apps/crish-desktop/src/components/sidebar/sessionMenuSchema.ts

import React from 'react';
import * as Lucide from 'lucide-react';
import type { MenuItem } from '../ui/SmartExpandablePanel';
import type { SessionMenuAction } from './SidebarContextMenus';

export interface BuildSessionMenuItemsParams {
  isPinned: boolean;
  onAction: (action: SessionMenuAction) => void;
}

export function buildSessionMenuItems({
  isPinned,
  onAction,
}: BuildSessionMenuItemsParams): MenuItem[] {
  return [
    // 视图窗口打开组
    {
      id: 'open-current',
      label: '在此处打开',
      icon: <Lucide.MessageCircle size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('open-current'),
    },
    {
      id: 'open-split',
      label: '拆分视图',
      icon: <Lucide.Columns2 size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('open-split'),
    },
    {
      id: 'open-new',
      label: '在新窗口打开',
      icon: <Lucide.ExternalLink size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('open-new'),
    },
    { id: 'div-1', type: 'divider' },

    // 会话状态管理组
    {
      id: 'rename',
      label: '重命名',
      icon: <Lucide.PenLine size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('rename'),
    },
    {
      id: 'pin-toggle',
      label: isPinned ? '取消置顶' : '置顶',
      icon: isPinned ? (
        <Lucide.PinOff size={14} strokeWidth={1.75} aria-hidden />
      ) : (
        <Lucide.Pin size={14} strokeWidth={1.75} aria-hidden />
      ),
      onSelect: () => onAction(isPinned ? 'unpin' : 'pin'),
    },
    {
      id: 'archive',
      label: '归档',
      icon: <Lucide.Archive size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('archive'),
    },
    {
      id: 'branch',
      label: '分叉',
      icon: <Lucide.GitFork size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('branch'),
    },
    { id: 'div-2', type: 'divider' },

    // 辅助与危险操作组
    {
      id: 'copy-id',
      label: '复制会话 ID',
      icon: <Lucide.Copy size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('copy-id'),
    },
    {
      id: 'delete',
      label: '删除当前对话',
      icon: <Lucide.Trash2 size={14} strokeWidth={1.75} aria-hidden />,
      danger: true, // 触发红色字阶与 --sep-danger-light 浅红悬停
      onSelect: () => onAction('delete'),
    },
    { id: 'div-3', type: 'divider' },

    // 导出操作
    {
      id: 'export',
      label: '导出 Markdown',
      tooltip: '导出为 Markdown',
      icon: <Lucide.FileDown size={14} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onAction('export'),
    },
  ];
}
```

### 2.3 `SessionContextMenu.tsx` 重构实现

全面接入 `SmartExpandablePanel` 坐标点模式，保留 `LayerStack` 拓扑与测试契约：

```tsx
// apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx

import React, { useMemo, useRef } from 'react';
import { SmartExpandablePanel } from '../ui/SmartExpandablePanel';
import { useLayerRegistration } from '../ui/internal/layer-registration/useLayerRegistration';
import type {
  SessionContextMenuState,
  SessionMenuAction,
} from './SidebarContextMenus';
import { buildSessionMenuItems } from './sessionMenuSchema';

export const SESSION_CONTEXT_MENU_LAYER_ID = 'sidebar-session-context-menu';

export interface SessionContextMenuProps {
  contextMenu: SessionContextMenuState;
  menuRef?: React.RefObject<HTMLDivElement | null>;
  isPinned: boolean;
  onSessionAction: (action: SessionMenuAction) => void;
  onCloseContextMenu?: () => void;
  contextMenuTriggerRef?: React.RefObject<HTMLElement | null>;
}

export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  contextMenu,
  menuRef: externalMenuRef,
  isPinned,
  onSessionAction,
  onCloseContextMenu,
  contextMenuTriggerRef,
}) => {
  const localMenuRef = useRef<HTMLDivElement | null>(null);
  const activeMenuRef = externalMenuRef || localMenuRef;

  // 维持与 LayerStack 的 Exclusive 互斥槽
  useLayerRegistration(
    {
      id: SESSION_CONTEXT_MENU_LAYER_ID,
      type: 'context-menu',
      dismissible: true,
      onDismiss: () => onCloseContextMenu?.(),
      elementRef: activeMenuRef,
      anchorRef: contextMenuTriggerRef,
      restoreFocusTarget: contextMenuTriggerRef?.current ?? undefined,
    },
    true
  );

  const items = useMemo(() => {
    return buildSessionMenuItems({
      isPinned,
      onAction: onSessionAction,
    });
  }, [isPinned, onSessionAction]);

  return (
    <SmartExpandablePanel
      items={items}
      open={true}
      point={{ x: contextMenu.x, y: contextMenu.y }}
      onClose={onCloseContextMenu}
      panelRef={activeMenuRef}
      aria-label="会话操作"
      data-testid="session-context-menu"
      style={{
        zIndex: 'var(--z-context-menu, var(--z-popover))',
        pointerEvents: 'auto',
      }}
    />
  );
};
```

---

## 3. 侧边栏排序/过滤级联下拉重构方案（ContextMenuFlyout）

### 3.1 现状痛点与定时器隐患

`ContextMenuFlyout.tsx` 目前包含 394 行高度特化的自研代码：
1. **脆弱的超时机制**：使用 `setTimeout(..., 80)` 展开和 `setTimeout(..., 150)` 宽限期关闭，容易在快速划动鼠标时发生抖动甚至状态错乱；
2. **手写视口检测**：在 `useLayoutEffect` 中使用 `rowRect.right + flyoutWidth > window.innerWidth - 8` 手动计算 `flipLeft`；
3. **手动维护 DOM 引用与键盘导航**：维护 `flyoutRefs` 与 `rowRefs` 字典映射，手动分发 `ArrowRight`/`ArrowLeft`。

### 3.2 级联子菜单纯数据 Schema 设计

将「排序与过滤」主菜单与其三个二级子项（排序方式、分组方式、列表范围）转换为纯数据驱动 `MenuItem.children`：

```typescript
// apps/crish-desktop/src/components/sidebar/sortFilterMenuSchema.ts

import type { MenuItem, MenuGroup } from '../ui/SmartExpandablePanel';

export interface BuildSortFilterMenuParams {
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onClose: () => void;
}

export function buildSortFilterMenuSchema({
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onClose,
}: BuildSortFilterMenuParams): MenuGroup[] {
  return [
    {
      id: 'sort-filter-group',
      title: '排序与过滤',
      items: [
        {
          id: 'sort',
          label: '排序方式',
          type: 'submenu',
          children: [
            {
              id: 'sort-active',
              type: 'selectable',
              label: '按最近活跃',
              selected: sortType === 'active',
              onSelect: () => {
                onSetSortType('active');
                onClose();
              },
            },
            {
              id: 'sort-name',
              type: 'selectable',
              label: '按名称',
              selected: sortType === 'name',
              onSelect: () => {
                onSetSortType('name');
                onClose();
              },
            },
          ],
        },
        {
          id: 'group',
          label: '分组方式',
          type: 'submenu',
          children: [
            {
              id: 'group-folder',
              type: 'selectable',
              label: '按项目分组',
              selected: groupType === 'folder',
              onSelect: () => {
                onSetGroupType('folder');
                onClose();
              },
            },
            {
              id: 'group-none',
              type: 'selectable',
              label: '平铺列表',
              selected: groupType === 'none',
              onSelect: () => {
                onSetGroupType('none');
                onClose();
              },
            },
          ],
        },
        {
          id: 'filter',
          label: '列表范围',
          type: 'submenu',
          children: [
            {
              id: 'filter-all',
              type: 'selectable',
              label: '全部会话',
              selected: filterType === 'all',
              onSelect: () => {
                onSetFilterType('all');
                onClose();
              },
            },
            {
              id: 'filter-pinned',
              type: 'selectable',
              label: '仅置顶',
              selected: filterType === 'pinned',
              onSelect: () => {
                onSetFilterType('pinned');
                onClose();
              },
            },
          ],
        },
      ],
    },
  ];
}
```

### 3.3 `ContextMenuFlyout.tsx` 精简重构

彻底移除手写 DOM、定时器与手动视口翻转，全权委托给 `SmartExpandablePanel` + `SafeAimEngine`：

```tsx
// apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx

import React, { useMemo } from 'react';
import { SmartExpandablePanel } from '../ui/SmartExpandablePanel';
import { buildSortFilterMenuSchema } from './sortFilterMenuSchema';

export interface ContextMenuFlyoutProps {
  sortMenuRef?: React.RefObject<HTMLDivElement | null>;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
  sortTriggerRef?: React.RefObject<HTMLElement | null>;
}

export const ContextMenuFlyout: React.FC<ContextMenuFlyoutProps> = ({
  sortMenuRef,
  sortDropdownOpen,
  sortDropdownCoords,
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onCloseSortDropdown,
  sortTriggerRef,
}) => {
  const groups = useMemo(() => {
    return buildSortFilterMenuSchema({
      sortType,
      groupType,
      filterType,
      onSetSortType,
      onSetGroupType,
      onSetFilterType,
      onClose: onCloseSortDropdown,
    });
  }, [
    sortType,
    groupType,
    filterType,
    onSetSortType,
    onSetGroupType,
    onSetFilterType,
    onCloseSortDropdown,
  ]);

  if (!sortDropdownOpen) return null;

  return (
    <SmartExpandablePanel
      items={groups}
      open={sortDropdownOpen}
      triggerRef={sortTriggerRef}
      point={!sortTriggerRef?.current ? sortDropdownCoords : undefined}
      panelRef={sortMenuRef}
      enableTriangleAim={true} // 启用 120Hz SVG Safe-Aim 斜切碰撞保护
      onClose={onCloseSortDropdown}
      aria-label="排序与过滤"
      data-testid="sort-filter-menu"
    />
  );
};
```

---

## 4. 侧边栏快捷设置菜单重构方案（SettingsQuickMenu）

### 4.1 现状痛点与视觉噪点诊断

1. **Tooltip 悬停噪点爆炸**：旧版 `SettingsQuickMenu.tsx:286-300` 为每个快捷条目都套了一层 `<Tooltip content={entry.title}>`。当用户在菜单中上下移动鼠标时，高频弹窗黑色 Tooltip 气泡，遮挡相邻选项并造成严重的视觉噪点；
2. **样式杂色与非同心圆角**：原实现使用 `styles.sbQuickMenu`，圆角为 `var(--radius-xl)`（12px），子项悬停为 `var(--sidebar-hover)`，在浅色白底浮层中产生高对比泥灰底；
3. **顶部主题段缺乏统一容器槽位**：外观分段控制器直接手写在 Popover 内容顶部，与下方菜单项的左右内衬存在 2px 错位。

### 4.2 结构重构与数据驱动设计

1. **消灭子项 Tooltip**：彻底移除快捷项的 `<Tooltip>` 包装，将说明文字作为无干扰的 `sublabel` 或标准语义 `aria-label`；
2. **头部嵌入主题分段控制器**：通过 `SmartExpandablePanel` 提供的 `headerSlot` 属性统一注入外观分段控件；
3. **条目 Schema 标准化**：

```typescript
// apps/crish-desktop/src/components/settings/settingsQuickSchema.ts

import React from 'react';
import * as Lucide from 'lucide-react';
import type { MenuItem } from '../ui/SmartExpandablePanel';
import type { SettingsTabType } from '../../store/types';

export interface BuildSettingsQuickItemsParams {
  onNavigate: (tab?: SettingsTabType) => void;
}

export function buildSettingsQuickItems({
  onNavigate,
}: BuildSettingsQuickItemsParams): MenuItem[] {
  return [
    {
      id: 'models',
      label: '模型与密钥',
      icon: <Lucide.Orbit size={16} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onNavigate('models'),
    },
    {
      id: 'appearance',
      label: '外观与字体',
      icon: <Lucide.Palette size={16} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onNavigate('appearance'),
    },
    {
      id: 'all',
      label: '全部设置',
      icon: <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />,
      onSelect: () => onNavigate(undefined),
    },
  ];
}
```

### 4.3 `SettingsQuickMenu.tsx` 完整重构实现

```tsx
// apps/crish-desktop/src/components/settings/SettingsQuickMenu.tsx

import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { openSettings } from '../../store/settingsUiStore';
import type { SettingsTabType } from '../../store/types';
import { readStoredTheme, setTheme, type UiTheme } from '../../api/themeStore';
import { SmartExpandablePanel, Tooltip, SegmentedControl } from '../ui';
import { buildSettingsQuickItems } from './settingsQuickSchema';
import styles from './SettingsQuickMenu.module.css';

export interface SettingsQuickMenuProps {
  trigger?: React.ReactNode;
  renderTrigger?: (params: {
    open: boolean;
    triggerProps: {
      ref?: React.RefObject<HTMLButtonElement | null>;
      'aria-haspopup': 'menu';
      'aria-expanded': boolean;
      'aria-controls'?: string;
      onClick: () => void;
    };
  }) => React.ReactNode;
}

const THEME_OPTIONS = [
  { value: 'default', label: '浅色', 'aria-label': '浅色主题' },
  { value: 'dark', label: '深色', 'aria-label': '深色主题' },
] as const;

export const SettingsQuickMenu: React.FC<SettingsQuickMenuProps> = ({
  trigger,
  renderTrigger,
}) => {
  const [open, setOpen] = useState(false);
  const [theme, setThemeLocal] = useState<UiTheme>(() => readStoredTheme());
  const btnRef = useRef<HTMLButtonElement>(null);
  const restoreOnCloseRef = useRef(false);
  const menuId = useId();
  const themeGroupId = useId();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      const shouldRestore = restoreOnCloseRef.current;
      restoreOnCloseRef.current = false;
      if (shouldRestore) {
        queueMicrotask(() => btnRef.current?.focus());
      }
    }
    setOpen(nextOpen);
  }, []);

  const applyTheme = (t: UiTheme) => {
    setTheme(t);
    setThemeLocal(t);
  };

  const handleNavigate = (tab?: SettingsTabType) => {
    restoreOnCloseRef.current = true;
    setOpen(false);
    openSettings(tab);
  };

  const items = useMemo(() => {
    return buildSettingsQuickItems({ onNavigate: handleNavigate });
  }, []);

  const triggerProps = {
    ref: btnRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => handleOpenChange(!open),
  };

  const defaultTrigger = (
    <Tooltip content="快捷设置" disabled={open}>
      <button
        type="button"
        className={`${styles.sidebarFooterSettings}${open ? ` ${styles.isOpen}` : ''}`}
        data-testid="settings-button"
        aria-label={open ? '关闭快捷设置菜单' : '打开快捷设置菜单'}
        {...triggerProps}
      >
        <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />
        <span>设置</span>
        <Lucide.ChevronUp
          size={14}
          strokeWidth={1.75}
          className={styles.sbQuickChev}
          aria-hidden
        />
      </button>
    </Tooltip>
  );

  const finalTrigger = renderTrigger
    ? renderTrigger({ open, triggerProps })
    : (trigger ?? defaultTrigger);

  const headerSlot = (
    <div className={styles.sbQuickSection} role="none">
      <div className={styles.sbQuickLabel} id={themeGroupId}>
        外观
      </div>
      <SegmentedControl
        aria-label="外观"
        size="sm"
        block
        className={styles.sbQuickSegment}
        value={theme === 'dark' ? 'dark' : 'default'}
        options={[...THEME_OPTIONS]}
        onChange={(v) => applyTheme(v === 'dark' ? 'dark' : 'default')}
      />
    </div>
  );

  return (
    <div className={styles.sbQuickWrap} data-density="compact">
      {finalTrigger}
      <SmartExpandablePanel
        id={menuId}
        items={items}
        open={open}
        triggerRef={btnRef}
        headerSlot={headerSlot}
        enableDivider={true}
        onClose={() => handleOpenChange(false)}
        aria-label="快捷设置"
      />
    </div>
  );
};
```

---

## 5. 文件浏览器与路径面包屑重构方案（FileBreadcrumb, FileActions, FileViewerCard）

### 5.1 `FileBreadcrumb.tsx` 重点重构

#### 5.1.1 现状痛点分析
当前 `FileBreadcrumb.tsx` 第 232–329 行维护了约 **120 行高耦合手写浮层**：
- 手写搜索输入框（`filesBcFlyoutSearch`）与原生 `<input type="search" />`；
- 手写列表项渲染与高亮匹配（`filesBcFlyoutList`、`filesBcFlyoutItem`）；
- 手写外部点击监听（`document.addEventListener('mousedown')`）与键盘 Escape 拦截。

#### 5.1.2 基于 `SmartExpandablePanel` 的重构架构
全面废除 120 行手写浮层，配置为带搜索与内嵌滚动列表的 `SmartExpandablePanel`：
- `enableSearch: true`：启用顶栏一体化极简搜索框；
- `isSelectableList: true`：支持长目录列表 160px~280px 平滑自适应滚动；
- 底部嵌入「打开此目录」操作项或主面板操作槽。

```tsx
// apps/crish-desktop/src/components/files/FileBreadcrumb.tsx（核心改造段）

import React, { useCallback, useMemo, useRef, useState } from 'react';
import styles from './FilesCard.module.css';
import { Tooltip, SmartExpandablePanel, type MenuItem } from '../ui';
import {
  detectFileKind,
  listDirectory,
  pathDirname,
  pathRelativeToRoot,
  resolveWorkspacePath,
  type FsDirEntry,
} from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import type { ViewMode } from './hooks/useFilePreview';
import * as Lucide from 'lucide-react';

function BcFileIcon({ name }: { name: string }) {
  const k = detectFileKind(name);
  const color = fileExtColor(name);
  const sz = 14;
  if (k === 'image') return <Lucide.Image size={sz} style={{ color }} aria-hidden />;
  if (k === 'pdf') return <Lucide.FileText size={sz} style={{ color }} aria-hidden />;
  if (k === 'table') return <Lucide.Table size={sz} style={{ color }} aria-hidden />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|css|html|json|md|yml|yaml)$/i.test(name)) {
    return <Lucide.FileCode2 size={sz} style={{ color }} aria-hidden />;
  }
  return <Lucide.File size={sz} style={{ color }} aria-hidden />;
}

export const FileBreadcrumb = React.memo(function FileBreadcrumb({
  root,
  cwd,
  selected,
  view,
  onNavigate,
  onRefresh,
  onOpenFile,
}: FileBreadcrumbProps) {
  const [activeFlyoutDir, setActiveFlyoutDir] = useState<{
    path: string;
    label: string;
    entries: FsDirEntry[];
    loading: boolean;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const loadDir = useCallback(async (dirPath: string, label: string) => {
    setActiveFlyoutDir({ path: dirPath, label, entries: [], loading: true });
    try {
      const list = await listDirectory(resolveWorkspacePath(dirPath));
      setActiveFlyoutDir({ path: dirPath, label, entries: list, loading: false });
    } catch {
      setActiveFlyoutDir(null);
    }
  }, []);

  const panelItems: MenuItem[] = useMemo(() => {
    if (!activeFlyoutDir) return [];
    const items: MenuItem[] = activeFlyoutDir.entries.map((ent) => ({
      id: ent.path,
      label: ent.name,
      icon: ent.isDir ? (
        <Lucide.Folder size={14} aria-hidden />
      ) : (
        <BcFileIcon name={ent.name} />
      ),
      sublabel: ent.isDir ? '文件夹' : undefined,
      selected: selected === ent.path,
      searchKeywords: ent.name,
      onSelect: () => {
        if (ent.isDir) {
          void loadDir(ent.path, ent.name);
          void onRefresh(ent.path);
        } else {
          setActiveFlyoutDir(null);
          void onOpenFile(ent.path);
        }
      },
    }));

    // 底部附加操作项：直接打开当前完整目录
    items.push({ id: 'div-goto', type: 'divider' });
    items.push({
      id: 'goto-dir',
      label: `打开此目录 (${activeFlyoutDir.label})`,
      icon: <Lucide.FolderOpen size={14} aria-hidden />,
      onSelect: () => {
        const path = activeFlyoutDir.path;
        setActiveFlyoutDir(null);
        onNavigate(path);
      },
    });

    return items;
  }, [activeFlyoutDir, selected, loadDir, onRefresh, onOpenFile, onNavigate]);

  return (
    <div className={styles.filesCrumbs} aria-label="工作区相对路径">
      {/* 渲染面包屑段 ... */}
      {/* 弹出目录选择浮层 */}
      <SmartExpandablePanel
        items={panelItems}
        open={Boolean(activeFlyoutDir)}
        triggerRef={triggerRef}
        enableSearch={true}
        searchPlaceholder="筛选文件…"
        maxPanelHeight={360}
        onClose={() => setActiveFlyoutDir(null)}
        aria-label={`${activeFlyoutDir?.label || ''} 目录内容`}
      />
    </div>
  );
});
```

### 5.2 `FileActions.tsx` 与 `FileViewerCard.tsx` 操作收敛

将「打开方式（HostOpeners）」与「更多操作」全量收敛为标准 `MenuItem[]` Schema：

```typescript
// apps/crish-desktop/src/components/files/fileActionsSchema.ts

import React from 'react';
import * as Lucide from 'lucide-react';
import type { MenuItem } from '../ui/SmartExpandablePanel';
import type { HostOpener } from '../../api/hostOpenersApi';

export function buildHostOpenersSchema(params: {
  fileOpeners: HostOpener[];
  selectedPath: string;
  onOpenWith: (op: HostOpener) => void;
  onCopyPath: (mode: 'abs' | 'rel') => void;
  onReveal: () => void;
}): MenuItem[] {
  const { fileOpeners, onOpenWith, onCopyPath, onReveal } = params;

  return [
    {
      id: 'copy-path',
      label: '复制路径',
      icon: <Lucide.Copy size={14} aria-hidden />,
      onSelect: () => onCopyPath('abs'),
    },
    {
      id: 'reveal-file',
      label: '在文件管理器中显示',
      icon: <Lucide.FolderOpen size={14} aria-hidden />,
      onSelect: onReveal,
    },
    { id: 'div-openers', type: 'divider' },
    ...fileOpeners.map((op) => ({
      id: op.id,
      label: op.displayName,
      icon: op.iconDataUrl ? (
        <img
          src={op.iconDataUrl}
          width={14}
          height={14}
          alt=""
          style={{ flexShrink: 0, objectFit: 'contain' }}
        />
      ) : (
        <Lucide.AppWindow size={14} aria-hidden />
      ),
      onSelect: () => onOpenWith(op),
    })),
  ];
}
```

---

## 6. Git 差异工具与随手笔记浮层重构方案（DiffHeaderControls, DiffCardFileList, SlashMenuOverlay）

### 6.1 `DiffHeaderControls.tsx` 升级方案

#### 改造点：
1. **AI 轮次选择器**（`turnOptions`）：从旧版 `Select` 升级为带时间戳副文本与高亮勾选的 `SmartExpandablePanel`；
2. **Git 分支切换器**（`branches`）：支持分支快速过滤搜索（`enableSearch: true`）；
3. **按钮组对齐**：视图切换（Split/Unified）、复制 Patch、清空变更列表统一对齐 24×24px 极简微圆角。

```typescript
// 数据源转换 Schema
export function buildTurnOptionsSchema(
  options: { value: string; label: string; hint?: string }[],
  currentTurnKey: string,
  onSelect: (key: string) => void
): MenuItem[] {
  return options.map((opt) => ({
    id: opt.value,
    type: 'selectable',
    label: opt.label,
    sublabel: opt.hint,
    selected: opt.value === currentTurnKey,
    onSelect: () => onSelect(opt.value),
  }));
}
```

### 6.2 `DiffCardFileList.tsx` 升级方案

1. **单文件对比维度选择器**（`compareOptions`）：
   - `git`（Git 工作区改动）、`session-merged`（AI 汇总改动）、`turn-*`（第 N 轮 AI 修改）、`plain`（当前源码全文）统一接入数据驱动 `MenuItem[]`；
2. **操作条与手风琴对齐**：
   - 暂存/取消暂存/放弃修改/接受写入/拒绝操作一律采用 6px 微圆角与 `--sep-*` 状态 Token。

### 6.3 `SlashMenuOverlay.tsx` 随手笔记块斜杠菜单样式与 Token 对齐

#### 架构安全守则（CONN-B）：
保持 `useSlashMenuModelSync`、`useSlashMenuSelect` 与 `useSlashMenuKeymap` 业务状态机 100% 完整无损，仅在视觉层与容器层对齐 `SmartExpandablePanel` 设计 Token：

```css
/* packages/block-paper/src/chrome/blockChrome.css（对齐段） */

.bp-slash-host {
  border-radius: var(--sep-radius-outer, 14px);
  padding: var(--sep-padding, 6px);
  background: var(--sep-bg-panel, rgba(255, 254, 252, 0.96));
  border: 1px solid var(--sep-border-color, #e2dfd9);
  box-shadow: var(--sep-shadow);
  backdrop-filter: blur(var(--sep-backdrop-blur, 28px));
}

.bp-slash-host .bp-slash-item {
  border-radius: var(--sep-item-radius, 8px);
  min-height: var(--sep-item-height, 28px);
  padding: 0 var(--sep-item-padding-h, 10px);
}

.bp-slash-host .bp-slash-item:hover,
.bp-slash-host .bp-slash-item[data-active='1'] {
  background: var(--sep-bg-item-hover, rgba(29, 28, 26, 0.045));
  color: var(--sep-text-primary, #1d1c1a);
}

html[data-theme='dark'] .bp-slash-host {
  background: var(--sep-bg-panel, rgba(24, 23, 21, 0.96));
  border: 1px solid var(--sep-border-color, #2b2926);
}

html[data-theme='dark'] .bp-slash-host .bp-slash-item:hover,
html[data-theme='dark'] .bp-slash-host .bp-slash-item[data-active='1'] {
  background: var(--sep-bg-item-hover, rgba(245, 244, 240, 0.06));
  color: var(--sep-text-primary, #f5f4f0);
}
```

---

## 7. Design Tokens 与视觉契约映射表

### 7.1 核心 Token 对照表

| Token 变量 | 浅色模式（Light / Default） | 深色模式（Dark） | 用途与约束 |
| :--- | :--- | :--- | :--- |
| `--sep-radius-outer` | `14px` | `14px` | 主面板与浮层外壳圆角 |
| `--sep-padding` | `6px` | `6px` | 主面板容器内衬边距 |
| `--sep-radius-inner` | `8px` (`14px - 6px`) | `8px` (`14px - 6px`) | **数学同心圆角**：条目与手风琴卡片 |
| `--sep-btn-radius` | `6px` | `6px` | 次级按钮与操作图标容器 |
| `--sep-bg-panel` | `rgba(255, 254, 252, 0.96)` | `rgba(24, 23, 21, 0.96)` | 磨砂毛玻璃背景（Zero-Blue） |
| `--sep-border-color` | `#e2dfd9` | `#2b2926` | 单层纯色实体发丝边框 |
| `--sep-bg-item-hover` | `rgba(29, 28, 26, 0.045)` (4.5%) | `rgba(245, 244, 240, 0.06)` (6%) | **轻柔暖灰悬停，严禁青绿泥色** |
| `--sep-bg-item-selected` | `rgba(29, 28, 26, 0.065)` (6.5%) | `rgba(245, 244, 240, 0.09)` (9%) | 选中态背景 |
| `--sep-accent-color` | `#10b981` (Emerald) | `#10b981` (Emerald) | 品牌对勾与激活高亮 |
| `--sep-danger-color` | `hsl(0 84% 60%)` | `hsl(0 84% 60%)` | 危险操作警示色 |

### 7.2 严禁 `--sidebar-hover` 杂色侵蚀红线

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        【强制视觉红线：彻底消灭杂色泥底】                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ ❌ 绝对禁止：在白底浮层中引用 --sidebar-hover / --sidebar-active（产生 20%~30% 脏青灰）  │
│ ✅ 严格锁定：全仓浮层选项一律绑定 --sep-bg-item-hover（4.5% 柔和微灰）与翡翠绿对勾     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. 向后兼容与测试套件零回归保障

### 8.1 现有核心测试资产保护清单

重构后必须确保以下存量测试套件 100% 绿灯通过：

1. `SidebarContextMenus.exclusive.test.tsx`：
   - 验证 `SESSION_CONTEXT_MENU_LAYER_ID` 正常向 `LayerStack` 注册；
   - 验证打开菜单时驱逐 `dropdown-menu` 并抑制 Tooltip（`data-floating-active="true"`）；
   - 验证外点关闭后 trigger 按钮不会误重开（`shouldSuppressMenuReopen`）。
2. `SidebarContextMenus.flyout.test.tsx`：
   - 验证鼠标移出后安全关闭；
   - 验证 `ArrowRight` 展开并聚焦子项首项，`ArrowLeft` / `Esc` 关闭子菜单且不关闭主菜单；
   - 验证条目 `tabIndex={0}` 与 `role="menuitem"` 无障碍可达。
3. `SettingsQuickMenu.test.tsx`：
   - 验证主题分段控制器正常切换浅色/深色并写入 `data-theme`；
   - 验证 Esc 关闭菜单还原焦点至设置触发按钮；
   - 验证无 `999px` 大胶囊或 `.ui-segment` 遗留死皮。
4. `DiffCardFileList.test.tsx` & `CompactDiffHeader.test.tsx`：
   - 验证暂存/取消暂存、AI 轮次选择与对比模式切换状态机完全正确。
5. `SlashMenuOverlay.test.tsx` & `SlashMenuOverlay.line-budget.test.ts`：
   - 验证 CONN-B 只读防护（`data-slash-write-mode`）与体积行数预算（<400 行）。

---

## 9. 四阶段分步实施路线图与验收自检清单

### 9.1 四阶段演进路线

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     侧边栏、文件管理与差异工具重构实施路线                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 1: 侧边栏菜单群收敛 ]                                                          │
│  ├── 迁移 SessionContextMenu 至 SmartExpandablePanel 坐标点模式 (废除 measureMenu)   │
│  ├── 迁移 ContextMenuFlyout 至 MenuItem.children 级联模式 (移除 80ms/150ms 定时器)    │
│  └── 跑通 SidebarContextMenus.*.test.tsx 测试套件                                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 2: 快捷设置菜单与视觉净化 ]                                                    │
│  ├── 重构 SettingsQuickMenu，头部嵌入 SegmentedControl                                 │
│  ├── 消灭子项全套 Tooltip 悬停黑气泡噪点，绑定 --sep-* Token                           │
│  └── 跑通 SettingsQuickMenu.test.tsx 测试套件                                          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 3: 文件管理与路径面包屑彻底重构 ]                                              │
│  ├── 重点改造 FileBreadcrumb.tsx，彻底废弃 120 行独立手写浮层                          │
│  ├── 替换为带搜索与内嵌滚动的 SmartExpandablePanel 目录面板                            │
│  └── 收敛 FileActions 与 FileViewerCard 的 HostOpeners 与更多操作菜单                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Phase 4: 差异工具、随手笔记与全仓门禁验证 ]                                          │
│  ├── 升级 DiffHeaderControls 与 DiffCardFileList 选择器                                │
│  ├── 对齐 SlashMenuOverlay 视觉 Token 与同心圆角                                       │
│  └── 执行全量 npm run typecheck 与 vitest 验证 800+ 单元测试 100% 绿灯                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 验收自检断言清单（Checklist）

- [ ] **[断言 1 - 几何同心与实体边框]**：侧边栏右键菜单、设置快捷菜单、文件面包屑浮层严格遵循外角 14px、内衬 6px、条目 8px 数学同心对齐，边框为 1px `#e2dfd9`/`#2b2926` 实体发丝。
- [ ] **[断言 2 - 杂色清零]**：在任何主题（浅色/深色/彩色皮肤）下，白底浮层悬停严格表现为 4.5%~6% 极浅暖灰，绝无深青绿泥色块。
- [ ] **[断言 3 - 脆弱定时器清零]**：`ContextMenuFlyout` 中的 80ms/150ms 定时器与手动 `flipLeft` 代码全部移除，由 SafeAimEngine 重心坐标与 PositionEngine 统一托管。
- [ ] **[断言 4 - 冗余 Tooltip 清零]**：快捷设置菜单与会话右键菜单内部选项不再包裹多余 Tooltip，悬停干净无跳动。
- [ ] **[断言 5 - 手写目录浮层清零]**：`FileBreadcrumb.tsx` 中的 120 行手写 `filesBcFlyout` 浮层与事件监听全部移除，统一使用 `SmartExpandablePanel`。
- [ ] **[断言 6 - 测试资产零回归]**：全仓运行 `npm test`，相关测试 100% 通过，无破坏性改动。
