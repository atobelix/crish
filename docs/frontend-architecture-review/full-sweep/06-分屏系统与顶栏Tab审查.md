# 二叉树分屏、Sash 拖拽与顶栏 Tab 标签系统 (BinaryTree, Shell & Tabs) 深度审查报告

> **审查范围**：`apps/crish-desktop/src/components/binary-tree/` 全量源码、`apps/crish-desktop/src/components/shell/` 全量源码、`apps/crish-desktop/src/components/AppTopBar.tsx`、`apps/crish-desktop/src/styles/shell/shell-layout.css`、`apps/crish-desktop/src/components/chat-card/` 工具栏与动作区等相关前端实现。  
> **审计纪律**：纯前端代码实证（.tsx, .ts, .css），无编译执行，所有判定均依托精确代码路径与行号。

---

## 目录

- [一、 顶栏与面板 Tab 栏视觉割裂深度剖析（基于实证与代码对比）](#一-顶栏与面板-tab-栏视觉割裂深度剖析基于实证与代码对比)
  - [1.1 核心视觉症结：双层 Chrome 堆叠与 74px 垂直空间挤压](#11-核心视觉症结双层-chrome-堆叠与-74px-垂直空间挤压)
  - [1.2 色彩与表面层级混乱：斑驳的「灰底-白Tab-灰线-灰底-胶囊」错落](#12-色彩与表面层级混乱斑驳的灰底-白tab-灰线-灰底-胶囊错落)
  - [1.3 Tab 规格与形态割裂：三套互不相容的标签设计系统](#13-tab-规格与形态割裂三套互不相容的标签设计系统)
  - [1.4 边距、对齐与无障碍焦点态割裂](#14-边距对齐与无障碍焦点态割裂)
  - [1.5 与 Cursor / VSCode / AFFiNE 工业级体验的差距根因](#15-与-cursor--vscode--affine-工业级体验的差距根因)
- [二、 TreeLeafPanel 静态分发与僵尸参数深度审查](#二-treeleafpanel-静态分发与僵尸参数深度审查)
  - [2.1 `switch(panelId)` 硬编码路由实证](#21-switchpanelid-硬编码路由实证)
  - [2.2 僵尸参数溯源：`wsId="default"`, `colIdx={0}`, `groupIdx={0}`](#22-僵尸参数溯源wsiddefault-colidx0-groupidx0)
  - [2.3 阻碍动态插件化注册的核心架构缺陷](#23-阻碍动态插件化注册的核心架构缺陷)
- [三、 Sash 拖拽分割线与 Ghost 幽灵遮罩审查](#三-sash-拖拽分割线与-ghost-幽灵遮罩审查)
  - [3.1 `TreeResizeSash`：两端悬空渐变与 1.5px 次像素模糊](#31-treeresizesash两端悬空渐变与-15px-次像素模糊)
  - [3.2 `DropZoneOverlay`：生硬蓝光遮罩与直角圆角几何冲突](#32-dropzoneoverlay生硬蓝光遮罩与直角圆角几何冲突)
  - [3.3 拖拽 Ghost 浮层的多套冗余实现与动画不同步](#33-拖拽-ghost-浮层的多套冗余实现与动画不同步)
- [四、 商业级一体化顶栏、TabStrip 与 ViewRegistry 重构设计方案](#四-商业级一体化顶栏tabstrip-与-viewregistry-重构设计方案)
  - [4.1 架构总览：统一 Chrome 分层模型与沉浸式顶栏方案](#41-架构总览统一-chrome-分层模型与沉浸式顶栏方案)
  - [4.2 工业级 TabStrip 规范重构（消除 999px 胶囊，统一平嵌质感）](#42-工业级-tabstrip-规范重构消除-999px-胶囊统一平嵌质感)
  - [4.3 动态 ViewRegistry 面板注册中心体系设计](#43-动态-viewregistry-面板注册中心体系设计)
  - [4.4 现代化 Sash 分割线与 Morphing DropZone 视觉重构](#44-现代化-sash-分割线与-morphing-dropzone-视觉重构)
- [五、 结论与重构任务落地分解表](#五-结论与重构任务落地分解表)

---

## 一、 顶栏与面板 Tab 栏视觉割裂深度剖析（基于实证与代码对比）

### 1.1 核心视觉症结：双层 Chrome 堆叠与 74px 垂直空间挤压

通过审查顶栏与分屏面板的源码结构，发现了整个桌面端顶部最严重的架构与视觉冲突：**两道相互独立、生硬并列的 Chrome 顶栏（Double Chrome Stacking）**。

```
+---------------------------------------------------------------------------------------------+
| AppTopBar (44px)   [SidebarToggle]  [ Tab 1 ] [ Tab 2 ] [+]        [Help] [-] [□] [X]      |  <- shell-layout.css:12
+---------------------------------------------------------------------------------------------+  <- 1px solid var(--border-color)
| Leaf Header (30px) [总览 (999px pill)] [+]                   [RightDockToggle]             |  <- LeafToolTabStrip.module.css:5
+---------------------------------------------------------------------------------------------+  <- 1px hairline
| Leaf Content Body (calc(100% - 74px))                                                       |
+---------------------------------------------------------------------------------------------+
```

#### 代码实证分析：

1. **第 1 行顶栏（`AppTopBar`）**：
   - 源码位置：[`apps/crish-desktop/src/components/AppTopBar.tsx:40-146`](file:///c:/Software/conex/apps/crish-desktop/src/components/AppTopBar.tsx#L40-L146)
   - 样式定义：[`apps/crish-desktop/src/styles/shell/shell-layout.css:12-32`](file:///c:/Software/conex/apps/crish-desktop/src/styles/shell/shell-layout.css#L12-L32)
   - 高度强制锁定：`height: var(--header-height); min-height: var(--header-height); max-height: var(--header-height);`（系统 token 中 `--header-height` 为 `44px`）。
   - 背景与下边框：`background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);`。
2. **第 2 行面板顶栏（`LeafToolTabStrip` / `ChatHeader`）**：
   - 源码位置：[`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx:105-199`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx#L105-L199) 与 [`apps/crish-desktop/src/components/chat-card/ChatHeader.tsx:84-142`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatHeader.tsx#L84-L142)
   - 样式定义：[`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css:5-24`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L5-L24) 与 [`apps/crish-desktop/src/components/chat-card/ChatHeader.module.css:4-26`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatHeader.module.css#L4-L26)
   - 高度强制锁定：`height: 30px; min-height: 30px; max-height: 30px;`。
   - 边框：`border-bottom: var(--hairline-width, 1px) solid var(--hairline);`。

#### 为什么用户会觉得「灰色背景生硬、内边距与对齐割裂」？

- **空间压迫**：在 1080p 或笔记本屏幕上，仅窗口顶端就被 `44px + 30px = 74px` 的纯控制栏占用，且这两行没有任何内容交互，全为灰色导航背景与按钮，产生了强烈的「框架压倒内容」的呆板感。
- **双重实线切断**：第 1 行底部有 `1px solid var(--border-color)`，第 2 行底部又有 `1px solid var(--hairline)`。在两个色块极其接近的灰色区域之间夹着一道深灰线，紧接着下方又是一道细灰线，形成视觉上的「双重梯田」阶梯。

---

### 1.2 色彩与表面层级混乱：斑驳的「灰底-白Tab-灰线-灰底-胶囊」错落

仔细梳理 CSS 变量在各组件中的实际继承与混合路径，可以发现表面材质（Surface Material）的严重无序性：

| 层次节点               | 对应代码位置                             | 声明的背景颜色 (Light 主题)                  | 实际计算色彩/观感                         |
| :--------------------- | :--------------------------------------- | :------------------------------------------- | :---------------------------------------- |
| **窗口外壳顶栏**       | `shell-layout.css:22`                    | `var(--bg-secondary)`                        | `hsl(35, 12%, 91.5%)` 暖深灰              |
| **顶栏全局 Tab 容器**  | `GlobalSessionTabBar.module.css:54`      | `transparent`                                | 透出 `--bg-secondary` 暖深灰              |
| **顶栏全局激活 Tab**   | `GlobalSessionTabBar.module.css:55, 171` | `var(--bg-primary)`                          | `hsl(35, 12%, 94%)` 浅灰白                |
| **二叉树 Canvas 画布** | `BinaryTreeWorkspace.module.css:41`      | `var(--bg-primary)`                          | `hsl(35, 12%, 94%)` 浅灰白                |
| **分屏 Leaf 容器**     | `BinaryTreeWorkspace.module.css:69`      | `var(--bg-primary)`                          | `hsl(35, 12%, 94%)` 浅灰白                |
| **工具 Leaf 标签栏**   | `LeafToolTabStrip.module.css:16`         | `var(--card-header-bg, var(--bg-secondary))` | **突然跳回** `hsl(35, 12%, 91.5%)` 深灰！ |
| **工具 Leaf 激活 Tab** | `LeafToolTabStrip.module.css:84`         | `var(--bg-primary)`                          | 跑道圆胶囊亮白，漂浮在深灰条上            |
| **对话 Leaf 工具栏**   | `ChatHeader.module.css:18`               | `var(--shell-inset-bg, var(--bg-primary))`   | `hsl(35, 12%, 94%)` 浅灰白                |

#### 视觉断层根因：

当用户进行分屏（例如左边是对话 Chat，右边是总览 Overview 工具）时，顶部呈现出可怕的色彩交错：

1. 最顶上一整行是深灰（`--bg-secondary`），中间浮着浅白色的会话 Tab；
2. 左半侧 Chat 面板顶栏是浅白底（`ChatHeader`），无 Tab，只写着「项目名」；
3. 右半侧 Tool 面板顶栏**突然变成深灰底**（`LeafToolTabStrip`），上面嵌着一个圆鼓鼓的白色 999px 药丸胶囊「总览」；
4. 结果是：**同一水平线上的左右两个分屏，顶部栏一个白底、一个深灰底；顶栏上方又顶着一条深灰底。** 没有任何节奏感和对称性，界面破碎感极强。

---

### 1.3 Tab 规格与形态割裂：三套互不相容的标签设计系统

在 `crish-desktop` 中，目前居然存在 **3 套完全独立的 Tab 样式规则**，分别散落在 3 个不同的 CSS 文件中，且尺寸、圆角、内边距、交互完全互掐：

```
[全局会话 Tab: GlobalSessionTabBar]  -> 高 36px, 圆角 6px (radius-md), padding: 0 2px 0 10px, 矩形微卡片
[Unit 会话 Tab: UnitSessionTabStrip] -> 高 24px, 圆角 6px (radius-md), padding: 0 2px 0 10px, 紧凑矩形
[工具 Leaf Tab: LeafToolTabStrip]    -> 高 24px, 圆角 999px (胶囊药丸), padding: 0 10px, 独立跑道圆
```

#### 代码实测比对：

1. **`GlobalSessionTabBar.module.css`**：
   - [`GlobalSessionTabBar.module.css:53`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/GlobalSessionTabBar.module.css#L53): `--global-tab-h: calc(var(--header-height) - 8px);`（即 `36px`）。
   - [`GlobalSessionTabBar.module.css:13`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/GlobalSessionTabBar.module.css#L13): `--global-tab-radius: var(--radius-md);`（`6px`）。
   - 样式策略：等宽拉伸 `flex: 1 1 0`，最大宽度 200px。
2. **`UnitSessionTabStrip.module.css`**：
   - [`UnitSessionTabStrip.module.css:19-20`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/UnitSessionTabStrip.module.css#L19-L20): `--unit-tab-h: 24px; --unit-tab-radius: var(--radius-md);`。
   - 样式策略：固定左贴合，最大宽度 180px。
3. **`LeafToolTabStrip.module.css`**：
   - [`LeafToolTabStrip.module.css:48-52`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L48-L52): `height: 24px; border-radius: 999px; max-width: 140px; padding: 0 10px;`。
   - [`LeafToolTabStrip.module.css:123`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L123): 关闭按钮 hover 时竟然带有特殊的旋转放大动画 `transform: rotate(90deg) scale(1.05);`，而其他所有 Tab 的关闭按钮均无此动画。

#### 评注：

在一个专业的现代桌面应用中，**绝对不应同时出现矩形 Tab 和 999px 跑道圆药丸 Tab 作为平级导航**。999px 药丸是典型的移动端 Filter Chip 风格，强行塞入 IDE 桌面分屏顶栏，与整体工程感、生产力工具的干练风格格格不入。

---

### 1.4 边距、对齐与无障碍焦点态割裂

1. **左侧 Rail 与侧栏展开宽度的对齐缝隙**：
   - `AppTopBar.tsx:48` 中的 `.app-top-bar__rail` 宽度同步 `--sidebar-width`，但内边距设定为 `padding: 0 var(--space-2_5) 0 calc(var(--space-3) + 1px)`（[`shell-layout.css:41`](file:///c:/Software/conex/apps/crish-desktop/src/styles/shell/shell-layout.css#L41)），其中 `calc(var(--space-3) + 1px)` 是硬编码的魔术数字补偿。
   - 当侧栏展开时，侧栏内部图标与顶栏 Toggle 图标在 X 轴上产生了 1px 左右的亚像素错位。
2. **右侧窗口控制区（Trail）硬编码宽度**：
   - [`shell-layout.css:167`](file:///c:/Software/conex/apps/crish-desktop/src/styles/shell/shell-layout.css#L167)：`min-width: calc(var(--titlebar-item-h) * 4 + 24px);`，写死了最小宽度以防止被 Tab 挤压。然而由于没有使用统一的 Flex 栅格分配，当会话标签增多时，Tab 栏右侧的 Fade 遮罩（`data-overflow-end`）会生硬地切入窗口控制区左侧的分隔线。
3. **焦点环对比度违规**：
   - 依据仓库协作指令第 13 条《UI：输入框与焦点态》，焦点态必须柔软且不得使用高反差实心黑边。
   - 然而在 [`LeafToolTabStrip.module.css:94-97`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L94-L97) 与 [`GlobalSessionTabBar.module.css:164-167`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/GlobalSessionTabBar.module.css#L164-L167) 中，直接使用 `box-shadow: var(--focus-ring)`，未对嵌入顶栏的紧凑 Tab 进行微调，键盘聚焦时会弹出粗重的外发光环，破坏了顶栏一体性。

---

### 1.5 与 Cursor / VSCode / AFFiNE 工业级体验的差距根因

| 维度                        | Cursor / VSCode                                                     | AFFiNE                                         | 当前 Crish-Desktop                                 |
| :-------------------------- | :------------------------------------------------------------------ | :--------------------------------------------- | :------------------------------------------------- |
| **顶栏层级**                | 彻底一体化：窗口控制、标题与 TabBar 共享同一行或纯内容顶栏          | 沉浸式通栏：标题栏与内容无色差，极简无边框融合 | **两行生硬叠加**（44px 顶栏 + 30px 面板栏）        |
| **分屏顶栏 (Editor Group)** | 统一 35px 高度，平嵌贴合，底边带有精致的 Active Accent Line (1.5px) | 统一低反差淡染底色，无缝平滑连通下方画布       | **左右分屏顶栏背景色不一致**（一个浅白、一个深灰） |
| **Tab 视觉形态**            | 严谨平直/微倒角几何卡片，与代码编辑器直接相连                       | 极轻圆角微底（4px radius），极简字重与间距     | **999px 跑道圆药丸**与 **6px 矩形** 混合乱用       |
| **交互细腻度**              | 拖拽时平滑 Morphing 动画，Sash 拖拽全屏联动                         | 流畅的柔和阴影与半透明材质高亮                 | 突兀的 1.5px 粗蓝光遮罩，无动效切换                |

---

## 二、 TreeLeafPanel 静态分发与僵尸参数深度审查

### 2.1 `switch(panelId)` 硬编码路由实证

在 [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:254-295`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L254-L295) 中，面板内容的分发完全由一个静态的 `switch(panelId)` 语句控制：

```tsx
// apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:254-295
if (panelId.startsWith('file-viewer:')) {
  const filePath = panelId.substring('file-viewer:'.length);
  return (
    <FileViewerCard
      key={filePath}
      filePath={filePath}
      onShowToast={onShowToast}
    />
  );
}

switch (panelId) {
  case 'chat':
    return (
      <ChatCard
        wsId="default"
        colIdx={0}
        groupIdx={0}
        handleGlobalTabClick={handleOpenTool}
        onShowToast={onShowToast}
        // draft 时传 PENDING_DRAFT；否则优先 leaf 绑定
        sessionId={sessionForPanel ?? undefined}
      />
    );
  case 'terminal':
    return <TerminalCard sessionId={sessionForPanel ?? undefined} />;
  case 'preview':
    return <PreviewCard wsId="default" onShowToast={onShowToast} />;
  case 'overview':
    return <OverviewCard wsId="default" onOpenPanel={handleOpenTool} />;
  case 'files':
    return <FilesCard onShowToast={onShowToast} />;
  case 'diff':
    return <DiffCard onShowToast={onShowToast} />;
  case 'runtime':
    return <RuntimePanel wsId="default" onShowToast={onShowToast} />;
  case 'agent':
    return <AgentCard />;
  default:
    return <div className={styles.emptyState}>未知面板类型：{panelId}</div>;
}
```

### 2.2 僵尸参数溯源：`wsId="default"`, `colIdx={0}`, `groupIdx={0}`

#### 1. `colIdx={0}` 与 `groupIdx={0}` 彻底失效

审查 [`apps/crish-desktop/src/components/chat-card/ChatCard.tsx:19-33`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatCard.tsx#L19-L33)：

```tsx
interface ChatCardProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
  sessionId?: string | null;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(
  ({ wsId, onShowToast, handleGlobalTabClick, sessionId }) => { ... }
);
```

- **证据确凿**：`ChatCardProps` 声明了 `colIdx` 和 `groupIdx`，但组件实现签名 `({ wsId, onShowToast, handleGlobalTabClick, sessionId })` 中**直接丢弃了 `colIdx` 与 `groupIdx`**，内部逻辑连解构都没有进行！
- **历史根源**：这是在引入二叉树布局之前的多列（Multi-Column Grid）旧架构残留。在二叉树架构下，面板归属直接由 `LayoutLeaf.id` 和 `LayoutLeaf.sessionId` 决定，传统的 `colIdx/groupIdx` 已经彻底成为僵尸代码。

#### 2. `wsId="default"` 的无意义透传

- 在 `TreeLeafPanel.tsx` 中，`ChatCard`、`PreviewCard`、`OverviewCard`、`RuntimePanel` 被硬编码灌入 `wsId="default"`。
- 然而现代架构下，工作区由 `activeProjectId` 与 `currentWorkspaceFolderKey` 决定（[`apps/crish-desktop/src/api/projectStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/projectStore.ts)）。所有会话均通过 `sessionId` 或全局 store 隔离，`wsId="default"` 在子组件内仅作为兼容旧签名存在，没有任何业务隔离价值。

---

### 2.3 阻碍动态插件化注册的核心架构缺陷

当前架构不仅在 `TreeLeafPanel.tsx` 中硬编码了 `switch-case`，其面板元数据（标题、图标、动作）更是分散在多个文件：

1. **面板文案散落**：
   - [`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx:27-35`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx#L27-L35) 声明了私有常量 `PANEL_LABELS`；
   - [`apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts) 中声明了 `getPanelTitle`；
   - 两处若有新增面板，必须同时手动维护两份映射表，极易漂移。
2. **面板图标与工具栏入口散落**：
   - [`apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx:21-46`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx#L21-L46) 中硬编码了 `UNIT_TOOL_PANELS` 数组（包含 `overview`, `files`, `diff`, `terminal` 的图标与文案）。
3. **后果**：
   - 外部扩展、后续新功能（如代码编辑器、数据库查看器、API 调试器、思维导图等）**完全无法在不修改核心二叉树代码的前提下动态接入**；
   - 违反面向对象与模块化设计的开闭原则（Open-Closed Principle）。

---

## 三、 Sash 拖拽分割线与 Ghost 幽灵遮罩审查

### 3.1 `TreeResizeSash`：两端悬空渐变与 1.5px 次像素模糊

审查 [`apps/crish-desktop/src/components/binary-tree/TreeResizeSash.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeResizeSash.tsx) 与 [`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:155-242`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L155-L242)：

```css
/* apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:183-210 */
.sash::after {
  content: '';
  position: absolute;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    var(--tint-active) 20%,
    var(--tint-strong) 50%,
    var(--tint-active) 80%,
    transparent 100%
  );
  opacity: 0.5;
  transition:
    opacity var(--transition-fast),
    width var(--transition-fast),
    height var(--transition-fast);
  pointer-events: none;
}

.sashHorizontal::after {
  top: 12%;
  bottom: 12%;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  border-radius: 1px;
}

.sashHorizontal:hover::after,
.sashHorizontal[data-active='true']::after {
  width: 1.5px;
}
```

#### 缺陷分析：

1. **两端悬空 12%（`top: 12%; bottom: 12%`）**：
   - 设计初衷可能是为了做出「悬浮在中间的精致短线」，但在实际分屏界面中，由于面板顶部和底部都有边框线，中间的 Sash 缺了上下各 12%，导致面板之间的分割关系在视觉上**断裂、不连贯**，用户在顶部和底部区域移动鼠标时，无法直观确认此处是分界线。
2. **1.5px 亚像素模糊（Subpixel Jitter）**：
   - 在高 DPI 屏幕或 Windows 系统缩放比例为 125%/150% 的环境下，`1.5px` 的 CSS 宽度会被光栅化为非整数物理像素，导致垂直线上出现半透明羽化模糊（Antialiasing Blur），观感发虚。
   - 正确做法应为始终保持 `1px` 物理线宽，仅通过调节颜色对比度（如由 `--hairline` 过渡到 `--accent-color` 或 `--text-primary` 的 15% 混入）来呈现激活状态。

---

### 3.2 `DropZoneOverlay`：生硬蓝光遮罩与直角圆角几何冲突

审查 [`apps/crish-desktop/src/components/binary-tree/DropZoneOverlay.tsx:37-84`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/DropZoneOverlay.tsx#L37-L84) 与 [`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:245-275`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L245-L275)：

```css
/* apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:245-263 */
.dropOverlay {
  position: absolute;
  pointer-events: none;
  z-index: var(--z-drag-highlight, 100);
  border-radius: var(--radius-md);
  background-color: color-mix(in srgb, var(--accent-color) 12%, transparent);
  border: 1.5px solid var(--accent-color);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-color) 25%, transparent);
  transition:
    top var(--transition-fast),
    left var(--transition-fast),
    width var(--transition-fast),
    height var(--transition-fast);
}
```

#### 缺陷分析：

1. **几何违和（直角底 vs 4 圆角遮罩）**：
   - 二叉树多面板时，所有 Leaf 均为严格的 `border-radius: 0` 直角以确保无缝拼合（[`BinaryTreeWorkspace.module.css:71`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L71)）。
   - 但是 `DropZoneOverlay` 却强行设置了 `border-radius: var(--radius-md)`（`6px`）。
   - 当拖拽分屏到左半边时，右侧两个角是圆角，左侧两个角也是圆角，导致四个角落漏出底下面板的直角背景，如同贴了一张没对齐的创可贴。
2. **高发光外阴影违背克制设计**：
   - `box-shadow: 0 0 8px var(--accent-color)` 具有浓厚的粗糙调试框既视感。现代化设计（如 VSCode、AFFiNE）均采用平整的半透明磨砂面（`background: color-mix(in srgb, var(--accent-color) 8%, transparent)`）配合细腻的 1px 内描边，绝不使用大面积荧光发光。

---

### 3.3 拖拽 Ghost 浮层的多套冗余实现与动画不同步

代码中目前存在多处拖拽 Ghost 浮层的定义：

1. `BinaryTreeWorkspace.tsx:254-265`：使用 Portal 渲染 `styles.ghost`；
2. `SessionTabDragContext.tsx:42-57`：使用 Portal 渲染 `stripStyles.dragGhost`；
3. `topBarDragConst.ts` 与 `topBarDragLib.ts` 中单独定义的各种 DOM 类名。

这导致标签拖拽和面板拖拽时的浮层文字大小、内边距、阴影程度、甚至是否有旋转角度完全不一致，增加了代码维护心智负担。

---

## 四、 商业级一体化顶栏、TabStrip 与 ViewRegistry 重构设计方案

### 4.1 架构总览：统一 Chrome 分层模型与沉浸式顶栏方案

对标 **Cursor** 与 **AFFiNE**，我们提出一套「**沉浸式无缝顶栏（Seamless Integrated Shell）**」架构方案：

```
+---------------------------------------------------------------------------------------------------+
| Integrated AppTopBar (36px 一体化单行顶栏)                                                        |
| [SidebarToggle] | [Active Workspace / Breadcrumb] | [ Global Search Bar / Center Title ] | [WinCtl] |
+---------------------------------------------------------------------------------------------------+
| BinaryTree Workspace Canvas (无缝底面, var(--bg-primary))                                         |
| +-----------------------------------------+ +---------------------------------------------------+ |
| | Pane 1: Chat (32px Integrated TabStrip) | | Pane 2: Tools (32px Integrated TabStrip)          | |
| | [ 💬 对话 A ] [ 💬 对话 B ]  [+]     [🛠️] | | [ 📊 总览 ] [ 📁 文件 ] [ 💻 终端 ]   [+]      [✖] | |
| |-----------------------------------------| |---------------------------------------------------| |
| | Chat Message Flow Body                  | | Tool View Body (Dynamic ViewRegistry Rendered)    | |
| +-----------------------------------------+ +---------------------------------------------------+ |
+---------------------------------------------------------------------------------------------------+
```

#### 核心设计原则：

1. **消灭 44px + 30px 双层堆叠**：
   - 窗口顶栏（`AppTopBar`）收缩至 **36px**，专注于：侧栏开关、面包屑/工作区切换、全局命令中心（Search）、全局操作与窗口控制。
   - 消除第二行的空闲填充，所有分屏面板的 TabBar 统一为 **32px**，且与下方内容区**背景同色平嵌**。
2. **统一底色与消灭斑驳跳色**：
   - 整个工作区与顶栏统一采用 `--bg-primary` 连续流，仅以 1px `--hairline` 精细分隔，杜绝局部深灰块突兀插入。

---

### 4.2 工业级 TabStrip 规范重构（消除 999px 胶囊，统一平嵌质感）

#### 1. 彻底废弃 999px 药丸，统一定义 Tab 规范 Token：

```css
/* 统一 Tab 设计系统规范 (建议置于 tokens.css 或 TabStrip.module.css) */
:root {
  --tab-height-standard: 28px;
  --tab-radius-standard: 4px;
  --tab-font-size: 12px;
  --tab-font-weight-normal: 400;
  --tab-font-weight-active: 500;

  /* 低反差淡染材质 */
  --tab-bg-idle: transparent;
  --tab-bg-hover: color-mix(in srgb, var(--text-primary) 5%, transparent);
  --tab-bg-active: color-mix(
    in srgb,
    var(--text-primary) 8%,
    var(--bg-primary)
  );
  --tab-active-border: color-mix(
    in srgb,
    var(--border-subtle) 80%,
    transparent
  );
  --tab-indicator-color: var(--accent-color, var(--text-primary));
}
```

#### 2. 精致平嵌 Tab 结构与样式实现：

```css
/* 现代 IDE 风格的 Tab 项 */
.tabItem {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-height-standard);
  padding: 0 8px 0 10px;
  border-radius: var(--tab-radius-standard);
  background: var(--tab-bg-idle);
  color: var(--text-secondary);
  font-size: var(--tab-font-size);
  font-weight: var(--tab-font-weight-normal);
  cursor: pointer;
  user-select: none;
  position: relative;
  transition:
    background-color 120ms ease,
    color 120ms ease;
  border: 1px solid transparent;
}

.tabItem:hover {
  background: var(--tab-bg-hover);
  color: var(--text-primary);
}

.tabItem[data-active='true'] {
  background: var(--tab-bg-active);
  color: var(--text-primary);
  font-weight: var(--tab-font-weight-active);
  border-color: var(--tab-active-border);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--shadow-color) 4%, transparent);
}

/* 底部极简 Accent 指示线（可选模式） */
.tabItem[data-active='true']::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 6px;
  right: 6px;
  height: 2px;
  background: var(--tab-indicator-color);
  border-radius: 1px;
}

/* 优雅渐显的关闭按钮 */
.tabCloseBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background-color 120ms ease;
}

.tabItem:hover .tabCloseBtn,
.tabItem[data-active='true'] .tabCloseBtn {
  opacity: 0.6;
}

.tabCloseBtn:hover {
  opacity: 1 !important;
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
}
```

---

### 4.3 动态 ViewRegistry 面板注册中心体系设计

为了彻底根除 `switch(panelId)` 硬编码以及 `wsId="default"`, `colIdx={0}`, `groupIdx={0}` 等僵尸参数，设计一套可扩展的 `ViewRegistry` 架构：

#### 1. 契约定义：`ViewDefinition` 接口

```typescript
// apps/crish-desktop/src/services/view-registry/ViewTypes.ts

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ShowToastFn } from '../../hooks/useToastQueue';

export interface ViewContext {
  /** 当前 Leaf 唯一标识 */
  leafId: string;
  /** 所属会话 ID（若绑定） */
  sessionId?: string;
  /** 是否为激活分屏 */
  isActive: boolean;
  /** 全局 Toast 触发器 */
  onShowToast: ShowToastFn;
  /** 在当前或关联会话打开另一个面板 */
  openView: (viewId: string) => void;
}

export interface ViewDefinition {
  /** 唯一视图 ID，如 'chat' | 'overview' | 'terminal' | 'files' */
  readonly id: string;
  /** 展示名称，如 '对话' | '总览' | '终端' */
  readonly title: string;
  /** 对应图标组件 */
  readonly icon: LucideIcon;
  /** 是否属于对话核心域（影响分屏归属规则） */
  readonly isChatDomain?: boolean;
  /** 是否支持单例模式（单例面板在分屏中不可重复开启） */
  readonly singleton?: boolean;
  /** 懒加载渲染组件 */
  readonly component:
    React.LazyExoticComponent<React.FC<ViewContext>> | React.FC<ViewContext>;
  /** 自定义右侧操作区组件（可选） */
  readonly headerActions?: React.FC<ViewContext>;
}
```

#### 2. 单例注册中心：`ViewRegistry`

```typescript
// apps/crish-desktop/src/services/view-registry/ViewRegistry.ts

import { ViewDefinition } from './ViewTypes';

class ViewRegistryImpl {
  private views = new Map<string, ViewDefinition>();
  private listeners = new Set<() => void>();

  public register(definition: ViewDefinition): () => void {
    if (this.views.has(definition.id)) {
      console.warn(
        `[ViewRegistry] Overwriting existing view: ${definition.id}`
      );
    }
    this.views.set(definition.id, definition);
    this.notify();
    return () => this.unregister(definition.id);
  }

  public unregister(id: string): void {
    if (this.views.delete(id)) {
      this.notify();
    }
  }

  public get(id: string): ViewDefinition | undefined {
    return this.views.get(id);
  }

  public getAll(): ViewDefinition[] {
    return Array.from(this.views.values());
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}

export const ViewRegistry = new ViewRegistryImpl();
```

#### 3. 重构后的 `TreeLeafPanel.tsx`（O(1) 动态分发）

```tsx
// apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx (重构后核心分发)

import { ViewRegistry } from '../../services/view-registry/ViewRegistry';

function DynamicLeafBody({
  panelId,
  leafId,
  leafSessionId,
  isActiveLeaf,
  onShowToast,
}: LeafBodyProps) {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const inDraft = isPendingDraft(activeSessionId || '');
  const sessionForPanel =
    inDraft && isActiveLeaf
      ? activeSessionId
      : leafSessionId || activeSessionId;

  const handleOpenView = useCallback(
    (targetViewId: string) => {
      if (sessionForPanel && !sessionForPanel.startsWith('__pending')) {
        openToolInSession(sessionForPanel, targetViewId);
      } else {
        openToolInActiveTab(targetViewId);
      }
    },
    [sessionForPanel]
  );

  // 1. 动态文件查看器特殊前缀处理
  if (panelId.startsWith('file-viewer:')) {
    const filePath = panelId.substring('file-viewer:'.length);
    return (
      <FileViewerCard
        key={filePath}
        filePath={filePath}
        onShowToast={onShowToast}
      />
    );
  }

  // 2. 从注册中心获取视图定义 (O(1) 动态分发)
  const viewDef = ViewRegistry.get(panelId);
  if (!viewDef) {
    return <div className={styles.emptyState}>未知面板类型：{panelId}</div>;
  }

  const ViewComponent = viewDef.component;

  // 3. 统一规范的 context 注入，彻底消灭 wsId, colIdx, groupIdx 僵尸参数！
  return (
    <ViewComponent
      leafId={leafId}
      sessionId={sessionForPanel ?? undefined}
      isActive={isActiveLeaf}
      onShowToast={onShowToast}
      openView={handleOpenView}
    />
  );
}
```

---

### 4.4 现代化 Sash 分割线与 Morphing DropZone 视觉重构

#### 1. 贯通式 Hairline Sash：

```css
/* apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css (重构后) */
.sash {
  position: absolute;
  z-index: var(--z-splitter, 5);
  background: transparent;
  touch-action: none;
}

.sashHorizontal {
  width: 8px;
  cursor: col-resize;
  transform: translateX(-4px);
}

.sashVertical {
  height: 8px;
  cursor: row-resize;
  transform: translateY(-4px);
}

/* 贯通式细线，去除 12% 截断，改用 1px 整数像素 */
.sash::after {
  content: '';
  position: absolute;
  background: var(--hairline);
  opacity: 0.8;
  transition:
    background-color 150ms ease,
    opacity 150ms ease;
  pointer-events: none;
}

.sashHorizontal::after {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
}

.sashVertical::after {
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-50%);
}

/* Hover 与 Active 态：优雅加深，不改变线宽以避免次像素模糊 */
.sash:hover::after,
.sash[data-active='true']::after {
  background: var(--accent-color, var(--text-primary));
  opacity: 1;
}
```

#### 2. 无缝平整 DropZone 遮罩：

```css
.dropOverlay {
  position: absolute;
  pointer-events: none;
  z-index: var(--z-drag-highlight, 100);
  border-radius: 0; /* 严格直角，与 Leaf 面板完美贴合 */
  background: color-mix(in srgb, var(--accent-color) 8%, transparent);
  border: 1px solid var(--accent-color);
  box-shadow: inset 0 0 0 1px
    color-mix(in srgb, var(--accent-color) 30%, transparent);
  transition: all 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

---

## 五、 结论与重构任务落地分解表

| 序号  | 缺陷/重构项                                                | 影响文件                                                        | 预期收益                                              | 建议批次    |
| :---- | :--------------------------------------------------------- | :-------------------------------------------------------------- | :---------------------------------------------------- | :---------- |
| **1** | **消除双层 74px 顶栏堆叠**，实现 36px 一体化单行顶栏       | `AppTopBar.tsx`, `shell-layout.css`                             | 释放 38px 垂直可视面积，消除视觉压迫感                | **Phase 1** |
| **2** | **废除 999px 胶囊药丸 Tab**，统一为现代 IDE 平嵌 Tab 规范  | `LeafToolTabStrip.module.css`, `GlobalSessionTabBar.module.css` | 终结三套 Tab 割裂混乱，建立统一设计规范               | **Phase 1** |
| **3** | **建立 `ViewRegistry` 视图注册中心**，重构 `TreeLeafPanel` | `TreeLeafPanel.tsx`, `services/view-registry/`                  | 移除 `switch-case` 硬编码，支持外部插件与面板动态扩展 | **Phase 2** |
| **4** | **清除 `wsId`, `colIdx`, `groupIdx` 僵尸参数**             | `ChatCard.tsx`, `TreeLeafPanel.tsx`, `useChatCardState.ts`      | 净化 props 接口，彻底扫除旧网格架构历史包袱           | **Phase 2** |
| **5** | **修复 Sash 12% 悬空截断与 1.5px 模糊**，重构贯通式细线    | `BinaryTreeWorkspace.module.css`, `TreeResizeSash.tsx`          | 消除拖拽分屏次像素发虚，提升拖拽跟手感                | **Phase 3** |
| **6** | **重构 DropZone 遮罩**，直角对齐与低反差半透明材质         | `DropZoneOverlay.tsx`, `BinaryTreeWorkspace.module.css`         | 消除粗暴的荧光发光框，达成商业级视觉水准              | **Phase 3** |

---

_报告生成完毕。本审计报告可作为下一步前端顶栏与分屏系统架构重构的标准实施依据。_
