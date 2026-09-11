# 对话顶栏与工具面板顶栏布局与设计系统重构方案
## Dual-Header Layout & Design System Architecture Plan

> **文档版本**：v1.0.0-PROPOSAL
> **责任领域**：Layout & Design System Architecture (`crish-desktop`)
> **涉及核心文件**：
> - `apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx`
> - `apps/crish-desktop/src/components/chat-card/UnitChromeActions.module.css`
> - `apps/crish-desktop/src/components/chat-card/ChatHeaderMore.tsx`
> - `apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.tsx` (新增)
> - `apps/crish-desktop/src/components/chat-card/SessionInlineRename.tsx` (新增)
> - `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`
> - `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css`
> - `reference/chat-composer-component/DESIGN_SYSTEM.md` (规范对齐基准)

---

## 1. 现状问题深度剖析与架构断层定位

### 1.1 对话顶栏 Header（`UnitChromeActions.tsx` / `UnitChromeActions.module.css`）现状缺陷

当前 `UnitChromeActions` 组件存在与 `reference/chat-composer-component` 设计规范断层、信息架构颠倒及交互缺失的问题：

```
【当前对话顶栏结构】
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [leading] 默认 / 会话 A / 1 个运行中                                     [总览][文件][差异][终端][笔记] | [⋯] [分享] [◨] │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  ▲ 纯只读文本，不可交互                                                     ▲ 更多操作堆叠在右侧，与产品工具混杂
```

1. **左侧信息架构为纯静态文本**：
   - **项目名称**（`projectLabel`）仅为静态 `<span>`，点击无响应，无法快速跳转到该项目对应的新建对话界面；
   - **对话名称**（`displayTitle`）仅为静态截断文本，无法直接就地点击重命名（必须去侧边栏右键菜单）；
   - **子代理状态呈现单薄且断层**：仅通过 `liveDot + N 个运行中` 展示数量，无法点击展开子代理管理面板，未与后端 `session.agents` 及多子代理生命周期做完整交互对接；
   - **更多操作（More）位置颠倒**：原 `ChatHeaderMore`（固定/导出/清空）被堆叠在右侧工具栏尾部，违反了“左侧聚合会话级元操作，右侧聚焦产品功能面板”的现代桌面 IDE 信息架构设计。
2. **右侧工具与控制按钮混杂**：
   - 右侧同时存在 5 个产品工具图标、分割线、`ChatHeaderMore`、独立分享按钮（`chat-share`）和侧栏开关（`right-dock-toggle`），视觉密度过大，层级混乱。

---

### 1.2 工具面板顶栏 Header（`LeafToolTabStrip.tsx` / `LeafToolTabStrip.module.css`）现状缺陷

当前 `LeafToolTabStrip` 存在结构冗余、Tab 样式比例失调以及加号按钮随滚动溢出隐藏的严重体验缺陷：

```
【当前工具面板顶栏结构】
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [总览][文件][差异][终端][笔记] | [总览] [文件 ✕] [+]                                                  [◨] │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  ▲ 冗余的固定工具按钮（违背纯 Tab 规范）   ▲ 叉号比标签大，无图标   ▲ 加号在 Tab 增多时被滚走截断    ▲ 展开/折叠
```

1. **违背纯标签（Pure Tab）设计规范**：
   - 左侧硬编码了 `dockToolNav`（总览、文件、差异、终端、笔记 5 个按钮），与对话顶栏的工具按钮形成重复冗余；用户明确要求工具栏默认应为纯标签（Tab）形式，不应存在固定的工具按钮。
2. **标签样式失调与图标缺失**：
   - 当前 Tab 项仅有纯文本，缺失直观的工具类型图标（`FolderTree`, `Terminal`, `GitBranch` 等）；
   - 关闭叉号按钮（`tabClose`）尺寸过大、Padding 过厚，视觉比重甚至超过了标签本身；且 Hover 带有突兀的 `rotate(90deg) scale(1.05)` 旋转变形，破坏了极简高级感。
3. **加号按钮在标签溢出时被隐藏**：
   - 加号按钮（`addTabBtn`）挂载在 Tab 列表的末尾或随 Tab 列表共同处于 `overflow-x: auto` 的滚动容器中；当打开 4~6 个以上标签引发水平滚动时，加号按钮被推至视口右侧外部被截断，用户无法在溢出态下直接添加新面板。
4. **两处 Header 缺少统一的设计系统与度量规范**：
   - 对话顶栏（38px 渐隐层）与工具面板顶栏（30px 实体层）的按钮尺寸、内边距、图标规格、微动效规范互不统一。

---

## 2. 目标设计系统与架构蓝图

### 2.1 整体架构设计全景图

```
==========================================================================================================
【重构后对话顶栏 Header】(UnitChromeActions)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [项目 Badge ↗] / [对话名称 ✎ (点击重命名)] / [子代理面板 ▾ (动态指示)] [⋯ 更多]          [总览][文件][差异][终端][笔记] [◨] │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  └─────────────── 左侧：会话上下文与元操作聚合区 ───────────────┘          └── 右侧：产品工具 + 统一侧栏开关 ──┘

==========================================================================================================
【重构后工具面板顶栏 Header】(LeafToolTabStrip)
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [ 📊 总览 ✕ ] [ 📁 文件 ✕ ] [ 🌿 差异 ✕ ] [ 💻 终端 ✕ ] ───(水平滚动区)───> │ [+] [◨]                 │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  └────────────────── 纯标签列表（打开几个显示几个，带专属图标与精致叉号） ──────────────────┘ └── 固定动作区(永不溢出) ┘
```

---

### 2.2 设计系统规范对齐（Design System Tokens & Metrics）

严格遵循 `reference/chat-composer-component/DESIGN_SYSTEM.md` 与仓库 Zero-Blue（零蓝色）原则：

| 度量/属性项 | 对话顶栏 (UnitChromeActions) | 工具面板顶栏 (LeafToolTabStrip) | 设计规范依据 |
| :--- | :--- | :--- | :--- |
| **容器高度** | `36px`（渐隐浮层覆盖） | `34px`（实体底色 + 下发丝线） | 密度统一，无跳跃感 |
| **背景样式** | `linear-gradient` 极柔和淡出 | `var(--card-header-bg, var(--bg-secondary))` | 视觉轻量，分层明确 |
| **内边距 (Padding)** | `0 10px` | `0 8px` | 严格对齐左右栅格 |
| **通用按钮尺寸** | `26px × 26px`，圆角 `var(--radius-md, 6px)` | `24px × 24px`，圆角 `var(--radius-sm, 4px)` | 微交互基准尺寸 |
| **图标规格 (Icon)** | `15px × 15px`，`strokeWidth: 1.6` | `13px × 13px`，`strokeWidth: 1.6` | 精致、极简、无笨重感 |
| **Tab 标签尺寸** | N/A | 高度 `24px`，最大宽 `130px`，圆角 `5px` | 紧凑高效 |
| **Tab 关闭叉号** | N/A | 容器 `14px × 14px`，图标 `10px`，`strokeWidth: 2` | 解决比例失调，微型精致 |
| **颜色体系 (Zero-Blue)** | 墨阶：`--text-primary`, `--text-secondary`, `--text-tertiary` | 墨阶：`--text-primary`, `--text-secondary`, `--text-tertiary` | 绝对禁止任何蓝色边框/高亮 |
| **运行态指示** | `--accent-green` (`#10b981`)，仅用于 agent 存活 | N/A | 品牌绿独占运行态 |
| **过渡动效** | `120ms` 柔和淡入淡出，**禁止任何果冻/变形/旋转** | `120ms` 柔和淡入淡出，**禁止任何果冻/变形/旋转** | 极简微动效 |

---

## 3. 详细设计与模块实现方案

### 3.1 对话顶栏 Header 重构设计（`UnitChromeActions`）

#### 3.1.1 左侧四大模块架构

1. **项目 Badge（Project Badge）**：
   - **交互**：点击触发新建会话草稿 `enterDraftMode(folder)` 并聚焦主对话流，支持跳转到新建对话界面；
   - **视觉**：渲染项目名称（`projectLabel`），Hover 态具备胶囊底色（`var(--bg-hover)`）与文字加深反馈，带轻量 `Tooltip: "点击新建当前项目对话"`。
2. **对话名称与内联重命名（Session Inline Rename）**：
   - **状态**：非编辑态（展示会话标题 `displayTitle` + Hover 出现微型编辑铅笔图标 `Pencil`）；编辑态（渲染极简原生 `<input>`）；
   - **交互**：
     - 单击标题或铅笔图标直接切换为编辑态；
     - 自动选中文本、自动聚焦；
     - 按 `Enter` 调用 `renameSession(sessionId, newTitle.trim())` 提交；
     - 按 `Escape` 取消；
     - 失去焦点（`onBlur`）自动保存并退出编辑态；
   - **样式约束**：无重投影，零蓝色边框，焦点态仅使用柔和的 `var(--border-focus)`（混合比 ≤ 8% `--text-primary`）。
3. **子代理面板（Subagent Header Panel）**：
   - **数据对接**：
     ```ts
     const agents = useSessionField((s) => sid ? s.sessionsById[sid]?.agents : undefined);
     const runningCount = useMemo(() => countRunningSubagents(agents), [agents]);
     ```
   - **条件渲染**：当且仅当 `agents && agents.length > 0` 时展示；
   - **触发器呈现**：
     - 若 `runningCount > 0`：展示品牌绿发光小圆点（`liveDot`，`2s` 呼吸动效）+ `${runningCount} 个运行中`；
     - 若 `runningCount === 0`：展示静态微型图标 + `${agents.length} 个子代理`；
   - **展开浮层面板（Popover Panel）**：
     - 点击触发器展开子代理实时状态卡片列表；
     - 列表项包含：子代理 Role / 名称、当前状态（running / idle / finished / error）、持续耗时（Elapsed）、当前正在执行的工具或步骤、以及快捷终止按钮（`killSubagent`）或侧栏聚焦查看按钮（`openAgentInSidePanel`）。
4. **更多操作按钮（ChatHeaderMore）**：
   - **位置**：移入左侧集群末尾（紧跟在子代理面板或对话名后）；
   - **操作项**：
     - 📌 固定 / 取消固定会话（`pinSession` / `unpinSession`）；
     - 📁 移到其他项目文件夹（`moveSessionRealtime`）；
     - 📥 导出 Markdown（`tryDownloadSessionMarkdown`）；
     - 🔗 分享 / 复制 Markdown（带 `SHARE_FLASH` 绿光反馈）；
     - 🗑 清空记录（`clearSessionMessages`，危险项）。

#### 3.1.2 右侧产品工具与统一侧栏按钮

1. **产品工具组（5 项核心工具）**：
   - 总览（`overview`，`LayoutDashboard`）；
   - 文件（`files`，`FolderTree`）；
   - 差异（`diff`，`GitBranch`）；
   - 终端（`terminal`，`Terminal`）；
   - 笔记（`note`，`FileText`）；
   - 点击时调用 `openToolInSession(sid, panelId)`，直接在工具分屏/右坞展开对应面板。
2. **统一侧栏触发按钮**：
   - 单一固定按钮，图标使用标准 `IconSidebarRight`；
   - Tooltip 提示“展开右侧面板” / “收起右侧面板”；
   - 彻底移除原右侧多余的独立分享等按钮，保持界面极简克制。

---

### 3.2 工具面板顶栏 Header 重构设计（`LeafToolTabStrip`）

#### 3.2.1 彻底剥离固定工具按钮，回归纯粹标签栏

- 移除 `dockToolNav` 与 `dockToolDivider` DOM 结构与样式；
- 工具面板顶栏 100% 由当前叶子的实际打开标签 `leaf.tabs` 动态渲染，打开几个就渲染几个。

#### 3.2.2 标签样式重构（Tab Visual Re-engineering）

1. **图标接入**：
   - 每个 Tab 标签头部渲染 `viewRegistry.getIcon(tabId)`；
   - 图标与文本垂直居中对齐，间距 `5px`。
2. **微型关闭按钮（Mini Close Button）**：
   - 废除原 20px 大叉号与旋转动画；
   - 关闭按钮尺寸降为 `14px × 14px`，图标 `10px`；
   - Hover 时平滑呈现浅灰底色 `var(--wash-hover)`，文字与叉号色彩加深；
   - 仅当 `tabs.length > 1` 时显示关闭按钮。
3. **标签尺寸与激活态**：
   - 高度 `24px`，内边距 `0 8px`，圆角 `5px`；
   - 激活 Tab 背景采用 `var(--bg-primary)`，微发丝边框 `var(--border-subtle)`，与内容面板无缝衔接。

#### 3.2.3 加号按钮与收起按钮吸附防溢出架构（Sticky Actions Bar）

为解决“标签过多时加号按钮随滚动溢出隐藏”的致命缺陷，将顶栏拆分为**两个并列的弹性区域**：

```html
<div className={styles.header}>
  {/* 1. 纯 Tab 滚动区：占据剩余全部宽度，超出时自适应水平滚动 */}
  <div className={styles.tabsScrollArea} ref={tabScrollRef}>
    <div className={styles.tabsTrack} role="tablist">
      {tabs.map((tabId) => (
        <TabItem ... />
      ))}
    </div>
  </div>

  {/* 2. 固定操作区：永不收缩、永不溢出、吸附在最右侧 */}
  <div className={styles.stickyTrailingGroup}>
    {availablePanels.length > 0 && (
      <AddPanelDropdown availablePanels={availablePanels} onSelect={openPanel} />
    )}
    <IconButton
      icon={<IconSidebarRight size={13} />}
      onClick={handleCollapseDock}
      aria-label="收起右侧面板"
    />
  </div>
</div>
```

**CSS 弹性吸附原理**：
- `tabsScrollArea`：`flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none;`（隐藏原生粗滚动条，支持水平滚轮）；
- `stickyTrailingGroup`：`flex: 0 0 auto; flex-shrink: 0; display: flex; align-items: center; gap: 4px; padding-left: 6px; background: inherit;`；
- **效果**：无论打开 1 个还是 20 个 Tab，加号下拉按钮和收起面板按钮永远稳定固定在最右侧，绝不被隐藏。

---

## 4. 关键代码 Diff 设计与实现细节

### 4.1 `UnitChromeActions.tsx` 关键 Diff

```diff
--- a/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx
+++ b/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx
@@ -14,6 +14,8 @@ import React, {
 } from 'react';
 import { Link } from 'lucide-react';
 import { ChatHeaderMore } from './ChatHeaderMore';
+import { SessionInlineRename } from './SessionInlineRename';
+import { SubagentHeaderPanel } from './SubagentHeaderPanel';
 import { IconButton, Tooltip } from '../ui';
 import {
-  countRunningSubagents,
   resolveUnitChromeLabel,
   resolveUnitChromeToolTip,
   UNIT_CHROME_TOOL_TIP_SIDE,
@@ -37,6 +39,8 @@ import {
   pinSession,
   unpinSession,
   clearSessionMessages,
+  renameSession,
+  enterDraftMode,
 } from '../../api/storeAccess';
@@ -93,9 +97,9 @@ export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
       return sessionListDisplayTitle(sess);
     });
-    const runningAgents = useSessionField((s) => {
-      if (!sid) return 0;
-      return countRunningSubagents(s.sessionsById[sid]?.agents);
+    const sessionAgents = useSessionField((s) => {
+      if (!sid) return undefined;
+      return s.sessionsById[sid]?.agents;
     });
     const canExport = messageCount > 0;
     const projectLabel = resolveUnitChromeLabel(
@@ -191,6 +195,19 @@ export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
       [realSession, sid, isPinned]
     );

+    const handleJumpToNewDraft = useCallback(() => {
+      enterDraftMode(folder);
+    }, [folder]);
+
+    const handleRename = useCallback(
+      (newTitle: string) => {
+        if (!realSession) return;
+        renameSession(sid, newTitle);
+      },
+      [realSession, sid]
+    );
+
     return (
       <header
         className={`${styles.chatTopHeader}${className ? ` ${className}` : ''}`}
@@ -273,28 +290,44 @@ export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
         <div className={styles.topLeft}>
           {leading}
           <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
-            <span className={`${styles.bcItem} ${styles.bcProject}`}>
-              {projectLabel}
-            </span>
+            <Tooltip content="点击新建此项目对话" side={UNIT_CHROME_TOOL_TIP_SIDE}>
+              <button
+                type="button"
+                className={`${styles.bcItem} ${styles.bcProjectBtn}`}
+                onClick={handleJumpToNewDraft}
+              >
+                {projectLabel}
+              </button>
+            </Tooltip>
             <span className={styles.bcSep} aria-hidden="true">
               /
             </span>
-            <span className={`${styles.bcItem} ${styles.bcSession}`}>
-              {displayTitle}
-            </span>
-            {runningAgents > 0 ? (
+            <SessionInlineRename
+              title={displayTitle}
+              onRename={handleRename}
+              disabled={!realSession}
+            />
+            {sessionAgents && sessionAgents.length > 0 ? (
               <>
                 <span className={styles.bcSep} aria-hidden="true">
                   /
                 </span>
-                <span className={`${styles.bcItem} ${styles.bcAgent}`}>
-                  <span className={styles.liveDot} aria-hidden="true" />
-                  {runningAgents} 个运行中
-                </span>
+                <SubagentHeaderPanel
+                  agents={sessionAgents}
+                  parentSessionId={sid}
+                />
               </>
             ) : null}
+            <ChatHeaderMore
+              className={styles.leftMoreBtn}
+              onTogglePin={realSession ? handleTogglePin : undefined}
+              isPinned={isPinned}
+              onExportMarkdown={handleExport}
+              canExport={canExport}
+              onClearHistory={
+                realSession && messageCount > 0 ? handleClear : undefined
+              }
+              onMoveToFolder={realSession ? handleMoveToFolder : undefined}
+              onShare={realSession ? handleShare : undefined}
+              shareFlash={shareFlash}
+              folderOptions={folderOptions}
+              currentFolder={folder || GENERAL_FOLDER}
+            />
           </nav>
         </div>

         <div className={styles.topActions}>
@@ -326,45 +359,17 @@ export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
           {UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => {
             ...
           })}
-          <ChatHeaderMore ... />
-          <IconButton data-testid="chat-share" ... />
           <Tooltip
             content={resolveUnitChromeToolTip(dockLabel)}
             side={UNIT_CHROME_TOOL_TIP_SIDE}
           >
             <IconButton
               type="button"
               variant="ghost"
               size="sm"
               className={styles.actionBtn}
               data-testid="right-dock-toggle"
               data-active={rightDockCollapsed ? 'false' : 'true'}
               aria-label={dockLabel}
               aria-expanded={!rightDockCollapsed}
               aria-pressed={!rightDockCollapsed}
               onClick={handleToggleRightDock}
               icon={<IconSidebarRight size={15} aria-hidden />}
             />
           </Tooltip>
         </div>
       </header>
```

---

### 4.2 `LeafToolTabStrip.tsx` 关键 Diff

```diff
--- a/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
+++ b/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
@@ -27,13 +27,10 @@ import {
   type LayoutLeaf,
 } from '../../store/storeAccess';
-import { IconButton, TabStrip, Tooltip, Menu } from '../ui';
+import { IconButton, Tooltip, Menu } from '../ui';
 import { viewRegistry } from '../../services/view-registry';
-import { UNIT_TOOL_PANELS } from '../chat-card/unitChromeTools';
-import {
-  resolveUnitChromeToolTip,
-  UNIT_CHROME_TOOL_TIP_SIDE,
-} from '../chat-card/unitChromeLabel';
 import styles from './LeafToolTabStrip.module.css';

 export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
@@ -103,11 +100,6 @@ export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
     if (tabs.length === 0) return null;

     const occupied = new Set(dockOpenIds?.length ? dockOpenIds : tabs);
     const availablePanels = viewRegistry
       .getToolViews()
       .map((v) => v.id)
       .filter((pid) => !occupied.has(pid));

     return (
       <div
         className={styles.header}
         data-leaf-tool-tab-strip="true"
         data-tab-strip-leaf-id={leaf.id}
         data-tab-count={tabs.length}
         data-tab-mode={tabModeEnabled ? 'on' : 'off'}
       >
-        <div className={styles.dockToolNav} role="toolbar" aria-label="会话工具">
-          {UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => ... )}
-        </div>
-        <span className={styles.dockToolDivider} aria-hidden="true" />
-        <TabStrip ... />
+        {/* 1. 纯 Tab 列表水平滚动区 */}
         <div className={styles.tabsScrollArea} role="tablist" aria-label="工具面板标签栏">
           {tabs.map((tabId) => {
             const label = viewRegistry.getTitle(tabId);
             const Icon = viewRegistry.getIcon(tabId);
             const isActive = tabId === activeTab;
             return (
               <div
                 key={tabId}
                 role="tab"
                 aria-selected={isActive}
                 tabIndex={isActive ? 0 : -1}
                 className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                 onClick={() => handleActivate(tabId)}
                 data-tool-tab-id={tabId}
               >
                 {Icon && <Icon size={13} className={styles.tabIcon} aria-hidden />}
                 <span className={styles.tabLabel}>{label}</span>
                 {showCloseBtn ? (
                   <Tooltip content={`关闭 ${label}`}>
                     <button
                       type="button"
                       className={styles.tabCloseBtn}
                       onClick={(e) => {
                         e.stopPropagation();
                         handleClose(e, tabId);
                       }}
                       aria-label={`关闭 ${label}`}
                     >
                       <X size={10} strokeWidth={2} />
                     </button>
                   </Tooltip>
                 ) : null}
               </div>
             );
           })}
         </div>

         {/* 2. 吸附在右侧的固定动作区（加号 + 收起） */}
         <div className={styles.stickyTrailingGroup}>
           {availablePanels.length > 0 && (
             <Menu
               position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
               trigger={
                 <IconButton
                   type="button"
                   variant="ghost"
                   size="xs"
                   className={styles.addTabBtn}
                   aria-label="添加功能面板"
                   icon={<Plus size={13} />}
                 />
               }
               options={availablePanels.map((pid) => {
                 const Icon = viewRegistry.getIcon(pid);
                 return {
                   id: pid,
                   label: viewRegistry.getTitle(pid),
                   icon: Icon ? <Icon size={13} /> : undefined,
                   onClick: () => openPanel(pid),
                 };
               })}
             />
           )}
           <Tooltip content="收起右侧面板">
             <IconButton
               type="button"
               variant="ghost"
               size="xs"
               className={styles.collapseBtn}
               onClick={handleCollapseDock}
               aria-label="收起右侧面板"
               icon={<IconSidebarRight size={13} />}
             />
           </Tooltip>
         </div>
       </div>
     );
```

---

### 4.3 新增子组件架构设计

#### 4.3.1 `SessionInlineRename.tsx`（内联重命名组件）

```tsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Pencil } from 'lucide-react';
import styles from './SessionInlineRename.module.css';

interface SessionInlineRenameProps {
  title: string;
  onRename: (newTitle: string) => void;
  disabled?: boolean;
}

export const SessionInlineRename: React.FC<SessionInlineRenameProps> = ({
  title,
  onRename,
  disabled = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(title);
  }, [title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleCommit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    } else {
      setEditValue(title);
    }
    setIsEditing(false);
  }, [editValue, title, onRename]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      setEditValue(title);
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className={styles.renameInput}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={handleKeyDown}
        maxLength={64}
        aria-label="修改会话名称"
      />
    );
  }

  return (
    <button
      type="button"
      className={styles.titleDisplayBtn}
      onClick={() => !disabled && setIsEditing(true)}
      title="点击修改会话名称"
      disabled={disabled}
    >
      <span className={styles.titleText}>{title}</span>
      {!disabled && <Pencil size={11} className={styles.editIcon} aria-hidden />}
    </button>
  );
};
```

#### 4.3.2 `SubagentHeaderPanel.tsx`（子代理面板组件）

```tsx
import React, { useMemo } from 'react';
import { Bot, Play, CheckCircle2, AlertCircle, XOctagon } from 'lucide-react';
import type { SessionAgent } from '../../store/types';
import { countRunningSubagents } from './unitChromeLabel';
import { Menu, IconButton, Tooltip } from '../ui';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import styles from './SubagentHeaderPanel.module.css';

interface SubagentHeaderPanelProps {
  agents: SessionAgent[];
  parentSessionId: string;
}

export const SubagentHeaderPanel: React.FC<SubagentHeaderPanelProps> = ({
  agents,
  parentSessionId,
}) => {
  const runningCount = useMemo(() => countRunningSubagents(agents), [agents]);

  const trigger = (
    <button
      type="button"
      className={`${styles.agentTrigger} ${runningCount > 0 ? styles.isRunning : ''}`}
      aria-label="展开子代理状态面板"
    >
      {runningCount > 0 ? (
        <>
          <span className={styles.liveDot} aria-hidden="true" />
          <span className={styles.triggerText}>{runningCount} 个运行中</span>
        </>
      ) : (
        <>
          <Bot size={13} className={styles.botIcon} aria-hidden="true" />
          <span className={styles.triggerText}>{agents.length} 个子代理</span>
        </>
      )}
    </button>
  );

  return (
    <Menu
      trigger={trigger}
      position={{ align: 'start', side: 'bottom', sideOffset: 6 }}
      panel={{ contentClassName: styles.subagentMenuPanel }}
      options={agents.map((agent) => ({
        id: agent.id,
        label: agent.name || agent.role || agent.id,
      }))}
      renderItem={(opt) => {
        const agent = agents.find((a) => a.id === opt.id);
        if (!agent) return null;
        const isRunning = agent.status === 'running';

        return (
          <div key={agent.id} className={styles.agentItemRow}>
            <div
              className={styles.agentInfo}
              onClick={() => openAgentInSidePanel({ mode: 'focus', agentId: agent.id, parentSessionId })}
            >
              <div className={styles.agentHeaderLine}>
                <span className={styles.agentName}>{agent.name || agent.role || '子代理'}</span>
                <span className={`${styles.statusBadge} ${styles[agent.status || 'idle']}`}>
                  {isRunning ? '运行中' : agent.status === 'completed' ? '已完成' : '空闲'}
                </span>
              </div>
              {agent.task && <div className={styles.agentTask}>{agent.task}</div>}
            </div>
            {isRunning && (
              <Tooltip content="终止子代理">
                <IconButton
                  size="xs"
                  variant="ghost"
                  className={styles.killBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    killSubagent(agent.id);
                  }}
                  icon={<XOctagon size={12} />}
                />
              </Tooltip>
            )}
          </div>
        );
      }}
    />
  );
};
```

---

## 5. 验收标准与断言清单（Verification & Assertions）

为保障重构质量并契约化防回归，执行以下验收断言：

### 5.1 对话顶栏断言（`UnitChromeActions.scoped.test.tsx`）

- [ ] **断言 1（左侧项目跳转）**：点击项目 Badge 必须触发 `enterDraftMode(folder)`，并将对话流切换至草稿/新建态；
- [ ] **断言 2（对话名称重命名）**：
  - 点击会话名称切换为 `<input>` 编辑框；
  - 修改后按下 `Enter` 触发 `renameSession(sid, newTitle)`；
  - 按下 `Escape` 恢复原始名称并不调用写入；
- [ ] **断言 3（子代理状态与浮层）**：
  - 当 `agents` 存在时显示触发器；
  - 存在运行态子代理时绿点呼吸闪烁且显示数量；
  - 点击展开浮层能够列出所有子代理并可调用 `killSubagent` / `openAgentInSidePanel`；
- [ ] **断言 4（More 按钮在左）**：`ChatHeaderMore` 位于 `topLeft` 导航内，支持置顶、移动目录、导出与清空；
- [ ] **断言 5（右侧 5 工具与单边栏钮）**：右侧仅展示 `UNIT_TOOL_PANELS`（总览/文件/差异/终端/笔记）与单一固定 `right-dock-toggle` 按钮。

### 5.2 工具面板顶栏断言（`LeafToolTabStrip.scoped.test.tsx`）

- [ ] **断言 6（彻底移除固定工具按钮）**：`LeafToolTabStrip` 根节点内 `queryByRole('toolbar', { name: '会话工具' })` 为 `null`，不再渲染 `dockToolNav`；
- [ ] **断言 7（纯 Tab 列表与专属图标）**：
  - 仅渲染 `leaf.tabs` 对应的标签项；
  - 每个 Tab 均包含对应的 `Icon` 节点；
- [ ] **断言 8（精致微型关闭叉号）**：
  - Tab 数量为 1 时不显示叉号；
  - Tab 数量 > 1 时显示微型叉号，点击精准触发 `removeTabFromLeaf`；
  - 叉号图标尺寸固定为 10px，无旋转变形；
- [ ] **断言 9（加号与收起按钮吸附不溢出）**：
  - 打开 8 个 Tab 引发 Tab 容器溢出水平滚动时，`stickyTrailingGroup`（加号与收起按钮）保持 `position/flex` 稳定在最右侧，`offsetWidth > 0` 且完全可见、可交互；
  - 点击加号弹出 `availablePanels` 菜单；
  - 点击收起按钮精准触发 `openToolInSession(leaf.sessionId, 'chat')`。

### 5.3 视觉与设计系统断言

- [ ] **Zero-Blue 校验**：两个 Header 的 CSS 变量与计算样式中不存在任何未经映射的蓝色高亮（`#00f`, `#0066ff`, `rgb(0, 122, 255)` 等）；
- [ ] **微动效与无果冻**：无 `scale` 弹跳变形，无 `jelly` 果冻动效，所有过渡时长 `≤ 150ms`。

---

## 6. 实施演进路线（Implementation Roadmap）

1. **Step 1（子组件与基础基座）**：
   - 实现 `SessionInlineRename.tsx` + `SessionInlineRename.module.css`；
   - 实现 `SubagentHeaderPanel.tsx` + `SubagentHeaderPanel.module.css`；
2. **Step 2（对话顶栏 UnitChromeActions 重构）**：
   - 调整 `UnitChromeActions.tsx` 左侧（项目、名称重命名、子代理面板、More 更多操作）；
   - 优化右侧（5 个产品工具 + 单一侧栏按钮）；
   - 更新 `UnitChromeActions.module.css`；
3. **Step 3（工具面板顶栏 LeafToolTabStrip 重构）**：
   - 剥离 `dockToolNav` 与 `dockToolDivider`；
   - 重构 TabItem 图标与微型关闭叉号；
   - 实施 `tabsScrollArea` 与 `stickyTrailingGroup` 吸附防溢出布局；
   - 更新 `LeafToolTabStrip.module.css`；
4. **Step 4（测试套件回归与 CI 门禁验证）**：
   - 更新 `UnitChromeActions.scoped.test.tsx`；
   - 更新 `LeafToolTabStrip.scoped.test.tsx`；
   - 执行 `npm test` 与 `npm run typecheck` 验证全绿通过。
