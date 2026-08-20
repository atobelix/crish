# 对话顶栏与工具面板顶栏状态机与交互重构方案

> **文档定位**：`docs/dual-header-refactor/proposals/02-interaction-workflow-plan.md`  
> **角色**：交互状态机与组件工程专家（Interaction & Component Workflow Specialist）  
> **核心目标**：根除对话顶栏 (`UnitChromeActions`) 与工具面板顶栏 (`LeafToolTabStrip`) 的交互断层与状态机缺陷，重构信息架构、统一设计规范，确保与 `reference/chat-composer-component` 深度对齐。  
> **基准原则**：纯逻辑规划、反退避原则、零蓝色原则（Zero-Blue）、无果冻无重阴影、严禁破坏既有单测资产。

---

## 1. 现状诊断与架构断层分析

### 1.1 对话顶栏 Header (`UnitChromeActions.tsx` / `.module.css`)

当前 `UnitChromeActions` 承担了多 Unit 分屏下的对话顶部快捷操作，但在信息架构与交互实现上存在多处严重断层：

```
【当前 UnitChromeActions 布局现状】
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [leading?]  项目名 / 会话长标题 / (2个运行中) ─── [总览] [文件] [差异] [终端] [笔记] | [⋯] [🔗] [◨] │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▲                ▲               ▲                      ▲                    ▲   ▲   ▲
 (死文本)         (死文本)      (仅文字Badge无操作)       (产品工具组)        (更多)(分享)(右坞)
```

#### 关键缺陷清单：
1. **左侧面包屑为「死文本」，缺乏操作闭环**：
   - **项目名称 (Project)**：当前仅为纯文本渲染 `<span className={styles.bcProject}>{projectLabel}</span>`，点击无响应。用户无法通过项目标签快速创建当前项目下的新对话或切换回项目欢迎落地页。
   - **会话标题 (Session Title)**：当前为纯文本 `<span className={styles.bcSession}>{displayTitle}</span>`，无编辑交互。用户若需重命名必须退回侧边栏右键菜单，极度繁琐。
   - **子代理状态 (Subagents)**：当前仅在 `runningAgents > 0` 时展示静态文本 `2 个运行中`，既不可点击，也无法查看已完成/失败的子代理，未与子代理面板/抽屉（Subagent Team Board / Timeline）形成交互联动。
2. **按钮组织混乱，左右语义倒置**：
   - 当前左侧缺少操作按钮，而右侧将 `UNIT_TOOL_PANELS`（产品工具）、`ChatHeaderMore`（更多会话操作）、`chat-share`（分享复制）和 `right-dock-toggle`（右坞开关）混成一长串。
   - `ChatHeaderMore`（包含置顶、移动、导出、清空等**会话属性操作**）属于会话本体的管理，应归入左侧会话标题与子代理区域；
   - 右侧应专注于**工作区视图控制（统一侧栏开关）**与**产品工具（总览、文件、差异、终端、笔记）**。

---

### 1.2 工具面板顶栏 Header (`LeafToolTabStrip.tsx` / `.module.css`)

当前 `LeafToolTabStrip` 渲染在独立工具叶子（Tool Leaf）顶部，但结构上混合了「固定工具条」与「动态标签页」，导致严重的认知与交互混乱：

```
【当前 LeafToolTabStrip 布局现状】
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [总览] [文件] [差异] [终端] [笔记] | [ 文件 Tab  × ] [ 差异 Tab  × ] [ + ] [ ◨ 收起 ]             │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▲                                    ▲                             ▲       ▲
 (冗余的固定工具条 dockToolNav)        (关闭叉号过大/无图标)        (混在可滚动槽位内，易被overflow裁切)
```

#### 关键缺陷清单：
1. **冗余硬编码的固定工具条 (`dockToolNav`)**：
   - 现代码在左侧强行渲染了 `UNIT_TOOL_PANELS.map(...)`。当用户在右侧工具面板中已经打开了「文件」和「差异」标签时，左边依然常驻 5 个工具图标。
   - 这造成了极大的界面浪费与视觉噪音——用户困惑：「左边是按钮还是 Tab？点击左边是切换还是新建？」。
   - **用户裁决**：工具面板顶栏默认应为**纯标签（Tab）形式**，不应存在固定的工具按钮！打开了几个标签就显示几个标签。
2. **加号 (+) 与收起按钮在标签溢出时的遮挡与推挤**：
   - 现代码中 `addTabContainer`（加号）和 `trailingActions`（收起按钮）被作为 `TabStrip` 的 `trailing` 插槽渲染在 `<div ref={scrollRef}>` 内部；
   - 当打开多个标签导致 `scrollWidth > clientWidth` 触发 `overflow-x: auto` 时，加号按钮和收起按钮会被推到最右侧不可视区域，用户必须向右横滚才能看到收起和加号按钮！
   - **规范要求**：
     - Header 最右侧必须留出**固定独立区域**放置「收起右侧面板」按钮（始终绝对可见）；
     - 加号 (+) 按钮在标签未溢出时跟随在标签末尾，或在标签过多横向滚动时**吸附在固定收起按钮左侧（Sticky Action Slot）**，绝不被 overflow 隐藏。
3. **标签样式失调与工具图标缺失**：
   - **比例失调**：当前 `.tab` 高度仅 24px，而 `.tabClose` 按钮使用了 `padding: 1px`、`rotate(90deg) scale(1.05)`，关闭叉号视觉占比甚至超越了标签本体；
   - **无图标**：当前 Tab 仅渲染文字 `labelOf(tab.id)`，缺少 `viewRegistry.getIcon(tabId)` 对应的前置工具图标（总览、文件、差异、终端、笔记），视觉辨识度极低。

---

## 2. 交互状态机与架构重构设计

```
【重构后目标双 Header 架构全景】

1. 对话顶栏 (Chat Header / UnitChromeActions - 38px 渐隐浮层):
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [ 📁 项目名 (可点击新建) ] / [ 💬 会话标题 (可点击编辑) ] [ 🤖 2/2 运行中 ▾ ] [ ⋯ 更多 ]   ───   [ ◧ 左栏 ] [ 📊 总览 ] [ 📁 文件 ] [ 🔀 差异 ] [ ⚡ 终端 ] [ 📝 笔记 ] │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
  └────────────────────────── 左侧：会话上下文与元数据操作区 ──────────────────────────┘   └── 右侧：统一侧栏与产品工具组 ──┘

2. 工具顶栏 (Tool Tab Strip / LeafToolTabStrip - 30px 实体行):
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [ 📁 文件.tsx  × ] [ 🔀 差异对比  × ] [ ⚡ 终端 1  × ] >>> [可横向滚动区域] >>>          │ [ ＋ 添加 ] │ [ ◨ 收起 ] │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
  └────────────────────── 动态纯标签区 (带工具Icon + 微型关闭钮) ──────────────────────┘  └── 吸附槽 ──┘ └── 固定槽 ──┘
```

---

### 2.1 对话顶栏 Header 状态机设计

#### A. 项目标签 (Project Breadcrumb Item)
- **语义**：当前会话所属的项目目录（或「常规会话」）。
- **交互动作**：点击触发「在当前项目下新建对话 / 进入草稿态」。
- **状态流转**：
  ```
  [Mouse Hover]   ──> 展示微弱背景高亮 (var(--tint-hover)) + 手型光标 (cursor: pointer)
                      Tooltip: "新建当前项目对话"
  [Mouse Click]   ──> 调用 getCompositionRoot().shell.openNewDraftTab(folder)
                      若多 Pane 模式，在当前 Leaf 或新建 Tab 进入草稿态 (PENDING_DRAFT_SESSION_ID)
  [Key Navigation]──> Tab 键可聚焦 (tabIndex=0)，Enter / Space 触发新建
  ```

#### B. 会话标题就地重命名 (Inline Rename State Machine)
- **状态机模型**：
  ```
                 ┌────────────────────────────────────────┐
                 │                  IDLE                  │
                 │   (展示 displayTitle，Hover 显轻铅笔)   │
                 └───────────────────┬────────────────────┘
                                     │ Click / Enter / DblClick
                                     ▼
                 ┌────────────────────────────────────────┐
                 │                EDITING                 │
                 │   (激活 <input />，全选当前标题内容)    │
                 └─────┬───────────────────────────┬──────┘
                       │                           │
          Enter / Blur │ (内容有效且发生变更)       │ Escape / Blur (未改动/输入为空)
                       ▼                           ▼
        ┌──────────────────────────────┐ ┌──────────────────────────────┐
        │          COMMITTING          │ │          CANCELING           │
        │ renameSession(sid, newTitle) │ │   回退原 displayTitle，恢复   │
        └──────────────┬───────────────┘ └──────────────┬───────────────┘
                       │                               │
                       └───────────────┬───────────────┘
                                       ▼
                                    [ IDLE ]
  ```
- **关键规则与防护**：
  - **空字符处理**：若用户清空输入框并失焦，不保存空标题，自动回退到重命名前的标题；
  - **最大长度**：限制最大 100 字符，超出禁止输入；
  - **无果冻/无重边框**：`<input />` 采用 24px 高度、0 阴影、`var(--border-subtle)` 极细边框，字体与原标题 13px 保持 1:1 绝对对齐，切换无任何布局跳动（Layout Shift）。

#### C. 子代理胶囊入口 (Subagent Indicator & Panel Docking)
- **条件可见性**：
  - 若 `session.agents` 为空或未定义，该面包屑节点完全不渲染（0 占位）；
  - 若存在子代理（`session.agents.length > 0`），渲染交互胶囊按钮。
- **视觉状态机**：
  - `Running 态`（`runningCount > 0`）：展示绿色呼吸灯（`var(--accent-green)`，1.4s pulse）+ `${runningCount} 运行中`（或 `${runningCount}/${totalCount}`）；
  - `Done/Idle 态`（`runningCount === 0`）：展示灰色图标（`Bot` 或 `Layers`）+ `${totalCount} 个子代理`；
  - `Error 态`（含失败 agent）：展示琥珀色/浅红标记点 + `异常` 提示。
- **展开面板交互**：
  - 点击呼出子代理抽屉/弹窗（`SubagentTeamPanel` / `AgentTeamBoard`）；
  - 数据源直连：读取 `useSessionStore` 中的 `session.agents`（含 `id`, `displayLabel`, `mode`, `status`, `messages`, `startedAt`, `endedAt`, `depth` 等）；
  - 支持快速查看每个子代理的执行耗时、工具调用老虎机（traces）、独立终端日志或产物。

#### D. More 更多操作归位 (ChatHeaderMore)
- **位置迁移**：从最右侧移至左侧组合区末尾，紧随标题/子代理胶囊：
  `[Project] / [Title] [Subagents?] [ChatHeaderMore (⋯)]`
- **操作项清单**：
  1. **固定/取消固定**：`isPinned ? '取消置顶' : '置顶会话'`（调用 `pinSession` / `unpinSession`）；
  2. **移至项目文件夹**：`移到 ${folder.label}`（调用 `moveSessionRealtime`）；
  3. **导出 Markdown**：`导出 Markdown`（调用 `exportSessionToMarkdown`，仅在 `messageCount > 0` 时可用）；
  4. **清空记录**：`清空记录`（调用 `clearSessionMessages`，标红 danger 样式）。

#### E. 右侧：统一侧栏开关与产品工具组
- **左侧边栏统一开关**：
  - 固定在右侧操作区首位（或末位统一锚点），使用 `IconSidebarLeft`；
  - 点击联动 `getCompositionRoot().shell.toggleSidebar()` 或全局侧栏状态，提供统一全局入口。
- **产品工具组 (Product Tools Group)**：
  - 锁定 5 个核心工具：
    1. **总览** (`overview`, `LayoutDashboard`)：`openToolInSession(sid, 'overview')`
    2. **文件** (`files`, `FolderTree`)：`openToolInSession(sid, 'files')`
    3. **差异** (`diff`, `GitBranch`)：`openToolInSession(sid, 'diff')`
    4. **终端** (`terminal`, `Terminal`)：`openToolInSession(sid, 'terminal')`
    5. **笔记** (`note`, `FileText`)：`openToolInSession(sid, 'note')`（扩展激活时显示）
  - **状态与尺寸**：28px 按钮、`var(--button-radius, 7px)`、`side="bottom"` Tooltip、激活态 `data-active="true"`。

---

### 2.2 工具面板顶栏 Header 状态机设计

#### A. 纯标签化 (Pure TabStrip Model)
- 彻底剔除 `dockToolNav` 与 `dockToolDivider`；
- 工具顶栏的高度完全归属于当前的 `leaf.tabs`。
- 每个 Tab 项的数据结构：
  ```ts
  interface ToolTabItem {
    id: string;          // 面板 ID, 如 'files', 'diff', 'terminal'
    label: string;       // 标题, 如 '文件', '差异'
    icon: LucideIcon;    // 前置图标组件
    closable: boolean;   // tabs.length > 1 时可关闭
    active: boolean;     // id === leaf.activeTab
  }
  ```

#### B. 标签视觉重构与比例修正 (Tab Styling Specs)
- **高度与间距**：Tab 高度固定为 **24px**，内边距 `padding: 0 8px`，间距 `gap: 5px`；
- **三段式结构**：
  ```
  ┌─────────────────────────────────────────────────────────┐
  │ [ 📁 Icon (13px) ]  [ Label 文案 (12px) ]  [ ✕ Close (11px) ] │
  └─────────────────────────────────────────────────────────┘
  ```
- **关闭按钮 (`.tabClose`) 规范**：
  - 尺寸固定为 **16px × 16px** 极简点击区，图标尺寸 **10px**（strokeWidth: 2）；
  - 默认透明度 `opacity: 0.4`；Tab hover 时 `opacity: 0.7`；CloseBtn hover 时 `opacity: 1; background: var(--tint-strong); border-radius: 4px;`；
  - **禁用** 大幅度的 `scale(1.05)` 与突兀的 90 度强旋转，采用平滑的 `opacity/color` 过渡。

#### C. 吸附加号与右侧固定收起槽位 (Sticky Add & Pinned Collapse Layout)
- **DOM 结构三段式布局**：
  ```tsx
  <div className={styles.header} data-leaf-tool-tab-strip="true">
    {/* 1. 可横向滚动标签区 (TabStrip) */}
    <div className={styles.tabScrollContainer}>
      <TabStrip ... />
    </div>

    {/* 2. 吸附加号按钮 (+) */}
    {availablePanels.length > 0 && (
      <div className={styles.stickyAddSlot}>
        <Menu
          trigger={
            <Tooltip content="添加工具标签">
              <IconButton size="xs" variant="ghost" icon={<Plus size={13} />} />
            </Tooltip>
          }
          options={availablePanels.map(pid => ({ ... }))}
        />
      </div>
    )}

    {/* 3. 右侧绝对固定收起按钮 (Collapse Dock) */}
    <div className={styles.pinnedActionSlot}>
      <Tooltip content="收起右侧面板">
        <IconButton
          size="xs"
          variant="ghost"
          onClick={handleCollapseDock}
          icon={<IconSidebarRight size={14} />}
        />
      </Tooltip>
    </div>
  </div>
  ```
- **CSS Flex 隔离与防遮挡机制**：
  - `.tabScrollContainer` 设置 `flex: 1 1 auto; min-width: 0; overflow-x: auto;`；
  - `.stickyAddSlot` 设置 `flex-shrink: 0; margin-left: 4px;`，保证即使 `.tabScrollContainer` 产生水平滚动，加号按钮紧贴在固定收起按钮左侧，永远处于可视区域；
  - `.pinnedActionSlot` 设置 `flex-shrink: 0; width: 24px; display: flex; align-items: center; justify-content: center;`，预留固定槽位。

---

## 3. 双 Header 统一设计系统与规范语言

| 属性 | 对话顶栏 (`UnitChromeActions`) | 工具面板顶栏 (`LeafToolTabStrip`) | 统一规范依据 |
| :--- | :--- | :--- | :--- |
| **容器定位** | 覆盖浮层 (`position: relative / absolute`) | 实体顶栏 (`position: relative`) | 对话流需无缝滚动，工具面板需明确物理分界 |
| **容器高度** | **38px**（渐隐遮罩背景） | **30px**（底部分割线 `border-bottom`） | 符合桌面端微内核视错觉对齐要求 |
| **按钮尺寸** | **28px × 28px**（`size="sm"`） | **24px × 24px**（`size="xs"`） | 对应 38px / 30px 容器黄金比例 |
| **按钮圆角** | `var(--button-radius, 7px)` | `var(--radius-md, 6px)` | 统一圆角族系 |
| **色彩策略** | **Zero-Blue 零蓝色**（中性灰 `#111111` + opacity） | **Zero-Blue 零蓝色**（中性灰 `#111111` + opacity） | 严禁出现任何蓝色/紫色高亮 |
| **Hover 动效** | `background: var(--tint-hover)` (4% 混合) | `background: var(--tint-hover)` (4% 混合) | **严禁** hover 抬升阴影与放大果冻 |
| **Active 状态** | `color: var(--text-primary); font-weight: 500;` | `--bg-primary` 浅底 + 极细 `var(--border-subtle)` | 柔软边界（对比度加深 ≤ 10%） |
| **Tooltip 策略** | 统一自定义 `<Tooltip side="bottom">` | 统一自定义 `<Tooltip side="bottom">` | 严禁原生 HTML `title` 属性 |

---

## 4. 源码级重构 Diff 设计

### 4.1 对话顶栏：`UnitChromeActions.tsx` 改造设计

```diff
--- a/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx
+++ b/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx
@@ -15,7 +15,7 @@ import React, {
-import { Link } from 'lucide-react';
+import { Link, Bot, Edit2, Check, X } from 'lucide-react';
 import { ChatHeaderMore } from './ChatHeaderMore';
 import { IconButton, Tooltip } from '../ui';
@@ -25,2 +25,3 @@ import {
-import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
+import { IconSidebarLeft, IconSidebarRight } from '../sidebar/SidebarToggleIcons';
+import { renameSession } from '../../api/storeAccess';
+import { getCompositionRoot } from '../../app/compositionRoot';
@@ -88,4 +89,8 @@ export const UnitChromeActions: React.FC<UnitChromeActionsProps> = React.memo(
     const displayTitle = useSessionField((s) => {
       if (!sid || isPendingDraft(sid)) return EMPTY_SESSION_TITLE;
       const sess = s.sessionsById[sid];
       if (!sess) return EMPTY_SESSION_TITLE;
       return sessionListDisplayTitle(sess);
     });
+    const agents = useSessionField((s) => (sid ? s.sessionsById[sid]?.agents : undefined));
+    const totalAgents = agents?.length ?? 0;
     const runningAgents = useSessionField((s) => {
       if (!sid) return 0;
       return countRunningSubagents(s.sessionsById[sid]?.agents);
     });
+
+    // ── 标题编辑状态机 ───────────────────────────────────────
+    const [isEditingTitle, setIsEditingTitle] = useState(false);
+    const [editTitleValue, setEditTitleValue] = useState('');
+    const titleInputRef = useRef<HTMLInputElement>(null);
+
+    const handleStartRename = useCallback(() => {
+      if (!realSession) return;
+      setEditTitleValue(displayTitle);
+      setIsEditingTitle(true);
+      setTimeout(() => titleInputRef.current?.select(), 20);
+    }, [realSession, displayTitle]);
+
+    const handleCommitRename = useCallback(() => {
+      const trimmed = editTitleValue.trim();
+      if (trimmed && trimmed !== displayTitle && realSession) {
+        renameSession(sid, trimmed);
+      }
+      setIsEditingTitle(false);
+    }, [editTitleValue, displayTitle, realSession, sid]);
+
+    const handleCancelRename = useCallback(() => {
+      setIsEditingTitle(false);
+    }, []);
+
+    const handleProjectClick = useCallback(() => {
+      getCompositionRoot().shell.openNewDraftTab(folder);
+    }, [folder]);
+
+    const handleToggleSubagentPanel = useCallback(() => {
+      // 触发子代理面板/抽屉展开
+      window.dispatchEvent(new CustomEvent('toggle-subagent-panel', { detail: { sessionId: sid } }));
+    }, [sid]);
+
+    const handleToggleLeftSidebar = useCallback(() => {
+      getCompositionRoot().shell.toggleSidebar?.();
+    }, []);
+
     return (
       <header
         className={`${styles.chatTopHeader}${className ? ` ${className}` : ''}`}
         data-unit-chrome-actions="true"
         data-chat-top-header="true"
         aria-label="对话快捷操作"
       >
         {/* ── 左侧：项目 / 标题 / 子代理 / 更多 ── */}
         <div className={styles.topLeft}>
           {leading}
           <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
-            <span className={`${styles.bcItem} ${styles.bcProject}`}>
-              {projectLabel}
-            </span>
+            <Tooltip content="点击在此项目下新建对话" side={UNIT_CHROME_TOOL_TIP_SIDE}>
+              <button
+                type="button"
+                className={`${styles.bcItem} ${styles.bcProject} ${styles.clickableBc}`}
+                onClick={handleProjectClick}
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
+            {isEditingTitle ? (
+              <div className={styles.titleEditForm}>
+                <input
+                  ref={titleInputRef}
+                  type="text"
+                  className={styles.titleInput}
+                  value={editTitleValue}
+                  maxLength={100}
+                  onChange={(e) => setEditTitleValue(e.target.value)}
+                  onKeyDown={(e) => {
+                    if (e.key === 'Enter') handleCommitRename();
+                    else if (e.key === 'Escape') handleCancelRename();
+                  }}
+                  onBlur={handleCommitRename}
+                />
+              </div>
+            ) : (
+              <Tooltip content={realSession ? "点击重命名会话" : undefined} side={UNIT_CHROME_TOOL_TIP_SIDE}>
+                <button
+                  type="button"
+                  className={`${styles.bcItem} ${styles.bcSession} ${realSession ? styles.clickableBc : ''}`}
+                  onClick={realSession ? handleStartRename : undefined}
+                >
+                  <span>{displayTitle}</span>
+                </button>
+              </Tooltip>
+            )}
 
-            {runningAgents > 0 ? (
+            {totalAgents > 0 ? (
               <>
                 <span className={styles.bcSep} aria-hidden="true">
                   /
                 </span>
-                <span className={`${styles.bcItem} ${styles.bcAgent}`}>
-                  <span className={styles.liveDot} aria-hidden="true" />
-                  {runningAgents} 个运行中
-                </span>
+                <Tooltip content="查看子代理运行状态" side={UNIT_CHROME_TOOL_TIP_SIDE}>
+                  <button
+                    type="button"
+                    className={`${styles.bcItem} ${styles.bcAgentBtn}`}
+                    onClick={handleToggleSubagentPanel}
+                  >
+                    <span className={runningAgents > 0 ? styles.liveDotPulse : styles.staticDot} />
+                    <span>{runningAgents > 0 ? `${runningAgents} 运行中` : `${totalAgents} 子代理`}</span>
+                  </button>
+                </Tooltip>
               </>
             ) : null}
+
+            {/* 更多会话操作归位到左侧元数据区 */}
+            <ChatHeaderMore
+              className={styles.actionBtnSm}
+              onTogglePin={realSession ? handleTogglePin : undefined}
+              isPinned={isPinned}
+              onExportMarkdown={handleExport}
+              canExport={canExport}
+              onClearHistory={realSession && messageCount > 0 ? handleClear : undefined}
+              onMoveToFolder={realSession ? handleMoveToFolder : undefined}
+              folderOptions={folderOptions}
+              currentFolder={folder || GENERAL_FOLDER}
+            />
           </nav>
         </div>
 
-        <div className={styles.topActions}>
+        {/* ── 右侧：左侧边栏统一开关 + 5项产品工具 ── */}
+        <div className={styles.topActions}>
+          <Tooltip content="切换左侧边栏" side={UNIT_CHROME_TOOL_TIP_SIDE}>
+            <IconButton
+              type="button"
+              variant="ghost"
+              size="sm"
+              className={styles.actionBtn}
+              data-testid="sidebar-toggle-btn"
+              aria-label="切换左侧边栏"
+              onClick={handleToggleLeftSidebar}
+              icon={<IconSidebarLeft size={15} aria-hidden />}
+            />
+          </Tooltip>
+          <span className={styles.toolbarDivider} aria-hidden="true" />
+          {UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => {
+            if (!viewRegistry.getView(id)) return null;
+            const isOpen = openPanelSet.has(id);
+            const isActive = !rightDockCollapsed && activePanelId === id;
+            return (
+              <Tooltip key={id} content={resolveUnitChromeToolTip(label)} side={UNIT_CHROME_TOOL_TIP_SIDE}>
+                <IconButton
+                  type="button"
+                  variant="ghost"
+                  size="sm"
+                  className={styles.actionBtn}
+                  data-testid={testId}
+                  data-panel={id}
+                  data-active={isActive ? 'true' : 'false'}
+                  data-open={isOpen && !rightDockCollapsed ? 'true' : 'false'}
+                  aria-label={label}
+                  aria-pressed={isActive}
+                  onClick={() => handleOpenTool(id)}
+                  icon={<Icon size={15} strokeWidth={1.75} aria-hidden />}
+                />
+              </Tooltip>
+            );
+          })}
+        </div>
```

---

### 4.2 工具面板顶栏：`LeafToolTabStrip.tsx` 改造设计

```diff
--- a/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
+++ b/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
@@ -120,44 +120,11 @@ export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
     return (
       <div
         className={styles.header}
         data-leaf-tool-tab-strip="true"
         data-tab-strip-leaf-id={leaf.id}
         data-tab-count={tabs.length}
         data-tab-mode={tabModeEnabled ? 'on' : 'off'}
       >
-        <div className={styles.dockToolNav} role="toolbar" aria-label="会话工具">
-          {UNIT_TOOL_PANELS.map(({ id, label, testId, Icon }) => {
-            ...
-          })}
-        </div>
-        <span className={styles.dockToolDivider} aria-hidden="true" />
-        <TabStrip
+        {/* 1. 纯受控动态标签滚动条 */}
+        <div className={styles.tabListWrapper}>
+          <TabStrip
             appearance={{
               className: styles.tabStrip,
               scrollClassName: styles.tabs,
               tabClassName: styles.tab,
               tabActiveClassName: styles.tabActive,
               ariaLabel: '工具面板',
             }}
             activeId={activeTab ?? null}
             tabs={tabs.map((tabId) => ({
               id: tabId,
               label: labelOf(tabId),
               closable: showCloseBtn,
               data: { 'data-tool-tab-id': tabId },
             }))}
             onActiveChange={handleActivate}
             onClose={(tabId, e) => handleClose(e, tabId)}
             slots={{
               renderTab: (tab) => {
                 const label = labelOf(tab.id);
+                const Icon = viewRegistry.getIcon(tab.id);
                 return (
                   <>
+                    {Icon ? <Icon size={13} className={styles.tabIcon} aria-hidden /> : null}
                     <span className={styles.tabLabel}>{label}</span>
                     {showCloseBtn ? (
                       <Tooltip content={`关闭 ${label}`}>
                         <IconButton
                           size="xs"
                           variant="ghost"
                           className={styles.tabClose}
                           tabIndex={-1}
                           aria-label={`关闭 ${label}`}
                           onClick={(e) => handleClose(e, tab.id)}
-                          icon={<X size={12} strokeWidth={2} />}
+                          icon={<X size={10} strokeWidth={2} />}
                         />
                       </Tooltip>
                     ) : null}
                   </>
                 );
               },
-              trailing: ...
             }}
           />
+        </div>
+
+        {/* 2. 标签过多时吸附在收起按钮左侧的加号按钮 */}
+        {availablePanels.length > 0 && (
+          <div className={styles.stickyAddSlot}>
+            <Menu
+              position={{ align: 'start', side: 'bottom', sideOffset: 4 }}
+              trigger={
+                <Tooltip content="添加工具标签" side="bottom">
+                  <IconButton
+                    type="button"
+                    variant="ghost"
+                    size="xs"
+                    className={styles.addTabBtn}
+                    aria-label="添加功能面板"
+                    icon={<Plus size={13} />}
+                  />
+                </Tooltip>
               }
               options={availablePanels.map((pid) => {
                 const Icon = viewRegistry.getIcon(pid);
                 return {
                   id: pid,
                   label: viewRegistry.getTitle(pid),
                   icon: Icon ? <Icon size={14} /> : undefined,
                   onClick: () => openPanel(pid),
                 };
               })}
             />
           </div>
         )}
 
         {/* 3. 右侧绝对固定独立收起按钮 */}
         <div className={styles.pinnedCollapseSlot}>
           <Tooltip content="收起右侧面板" side="bottom">
             <IconButton
               type="button"
               variant="ghost"
               size="xs"
               className={styles.collapseBtn}
               onClick={handleCollapseDock}
               aria-label="收起右侧面板"
               icon={<IconSidebarRight size={14} />}
             />
           </Tooltip>
         </div>
       </div>
     );
```

---

### 4.3 样式 Diff：`LeafToolTabStrip.module.css` 核心优化

```diff
--- a/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css
+++ b/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css
@@ -1,24 +1,31 @@
 .header {
   display: flex;
   align-items: center;
-  gap: 6px;
+  gap: 0;
   height: 30px;
   min-height: 30px;
   max-height: 30px;
-  padding: 0 8px;
+  padding: 0 4px 0 6px;
   box-sizing: border-box;
   border-bottom: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
   background: var(--card-header-bg, var(--bg-secondary));
   flex-shrink: 0;
   width: 100%;
   min-width: 0;
   overflow: hidden;
   position: relative;
   z-index: var(--z-sticky, 2);
 }
 
+.tabListWrapper {
+  flex: 1 1 auto;
+  min-width: 0;
+  height: 100%;
+  overflow: hidden;
+}
+
 .tab {
   display: inline-flex;
   align-items: center;
-  gap: 6px;
+  gap: 5px;
   height: 24px;
   max-width: 140px;
-  padding: 0 10px;
+  padding: 0 6px 0 8px;
   border: 1px solid transparent;
   border-radius: var(--radius-md, 6px);
   background: transparent;
   color: var(--text-secondary);
   font-size: var(--font-size-xs, 12px);
   cursor: pointer;
   user-select: none;
 }
 
+.tabIcon {
+  flex-shrink: 0;
+  opacity: 0.75;
+}
 
 .tabClose {
   display: inline-flex;
   align-items: center;
   justify-content: center;
-  opacity: 0.5;
-  border-radius: var(--radius-sm, 4px);
-  padding: 1px;
+  width: 16px;
+  height: 16px;
+  opacity: 0.4;
+  border-radius: 4px;
+  padding: 0;
   flex-shrink: 0;
-  transition: transform var(--transition-fast) cubic-bezier(0.4, 0, 0.2, 1), background-color var(--transition-fast), opacity var(--transition-fast);
+  transition: background-color var(--transition-fast), opacity var(--transition-fast);
 }
 
 .tab:hover .tabClose {
-  opacity: 0.75;
+  opacity: 0.7;
 }
 
 .tabClose:hover {
   opacity: 1;
   background: var(--tint-strong);
-  transform: rotate(90deg) scale(1.05);
 }
 
+.stickyAddSlot {
+  flex-shrink: 0;
+  display: flex;
+  align-items: center;
+  margin-left: 2px;
+  margin-right: 4px;
+}
 
+.pinnedCollapseSlot {
+  flex-shrink: 0;
+  display: flex;
+  align-items: center;
+  justify-content: center;
+  width: 24px;
+  height: 24px;
+}
```

---

## 5. 验收断言与测试覆盖方案 (Definition of Done)

### 5.1 单元测试与状态机断言

必须更新并新增测试用例（位于 `UnitChromeActions.scoped.test.tsx` 与 `LeafToolTabStrip.scoped.test.tsx`）：

```ts
describe('UnitChromeActions Header 重构与状态机验证', () => {
  it('点击项目名称应调用 openNewDraftTab 进入草稿新建态', () => {
    const spy = vi.spyOn(getCompositionRoot().shell, 'openNewDraftTab').mockImplementation(() => {});
    const { getByText } = renderChrome('unit-live');
    fireEvent.click(getByText('默认'));
    expect(spy).toHaveBeenCalled();
  });

  it('点击标题进入编辑态，按 Enter 或 Blur 成功触发 renameSession', () => {
    const renameSpy = vi.spyOn(sessionAccess, 'renameSession').mockImplementation(() => {});
    const { getByText, container } = renderChrome('unit-live');
    fireEvent.click(getByText('重构 IPC'));
    const input = container.querySelector('input');
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: '重构 IPC 新方案' } });
    fireEvent.keyDown(input!, { key: 'Enter' });
    expect(renameSpy).toHaveBeenCalledWith('unit-live', '重构 IPC 新方案');
  });

  it('子代理存在时展示交互胶囊，点击派发子代理面板切换事件', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    seedSession('unit-agents', {
      agents: [{ id: 'a1', status: 'running' }] as never
    });
    const { getByText } = renderChrome('unit-agents');
    expect(getByText('1 运行中')).toBeTruthy();
    fireEvent.click(getByText('1 运行中'));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'toggle-subagent-panel' }));
  });

  it('ChatHeaderMore 归位在左侧面包屑内，右侧保留统一侧栏开关与 5 项产品工具', () => {
    const { getByTestId } = renderChrome('unit-live');
    expect(getByTestId('chat-header-more')).toBeTruthy();
    expect(getByTestId('sidebar-toggle-btn')).toBeTruthy();
    expect(getByTestId('chat-open-overview')).toBeTruthy();
    expect(getByTestId('chat-open-files')).toBeTruthy();
    expect(getByTestId('chat-open-diff')).toBeTruthy();
    expect(getByTestId('chat-open-terminal')).toBeTruthy();
  });
});

describe('LeafToolTabStrip 纯标签化与防遮挡验证', () => {
  it('工具顶栏不再渲染 dockToolNav 固定工具条', () => {
    const leaf = createLeaf('tool-leaf-1', ['files', 'diff'], 'files', 'sess-b');
    const { queryByTestId } = render(<LeafToolTabStrip leaf={leaf} />);
    expect(queryByTestId('chat-open-files')).toBeNull(); // 不再作为固定按钮出现在顶栏
  });

  it('每个 Tab 均渲染对应的工具 Icon 与微型关闭按钮', () => {
    const leaf = createLeaf('tool-leaf-1', ['files'], 'files', 'sess-b');
    const { container, getByText } = render(<LeafToolTabStrip leaf={leaf} />);
    expect(getByText('文件')).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy(); // Icon 存在
  });

  it('收起按钮位于右侧 pinnedCollapseSlot，不受 Tab 数量增多影响', () => {
    const leaf = createLeaf('tool-leaf-1', ['files', 'diff', 'terminal', 'overview'], 'files', 'sess-b');
    const { getByLabelText } = render(<LeafToolTabStrip leaf={leaf} />);
    const collapseBtn = getByLabelText('收起右侧面板');
    expect(collapseBtn.parentElement?.className).toContain('pinnedCollapseSlot');
  });
});
```

---

## 6. 实施路线图与交付清单

1. **Phase 1: 组件与布局解耦**
   - 移除 `LeafToolTabStrip.tsx` 中的 `dockToolNav`；
   - 重构 `LeafToolTabStrip` 为三段式布局（滚动 TabStrip、吸附加号、固定收起按钮）；
   - 在 `TabStrip.renderTab` 中接入 `viewRegistry.getIcon`。
2. **Phase 2: 对话 Header 状态机落地**
   - 实现项目点击新建草稿对话；
   - 接入就地重命名状态机（`InlineRenameInput` / 状态切换）；
   - 接入子代理交互胶囊与面板事件通道；
   - 将 `ChatHeaderMore` 移入左侧面包屑组，右侧接入 `IconSidebarLeft` 统一侧栏开关。
3. **Phase 3: 样式与视觉精细打磨**
   - 全面应用 Zero-Blue 颜色变量与 38px/30px 尺寸规范；
   - 修正 `.tabClose` 按钮比例与微交互。
4. **Phase 4: 全量测试验证与门禁通过**
   - 运行 `npx vitest run src/components/chat-card/UnitChromeActions.scoped.test.tsx`
   - 运行 `npx vitest run src/components/binary-tree/LeafToolTabStrip.scoped.test.tsx`
   - 运行 `npm run typecheck` 确保 TypeScript 0 错误。
