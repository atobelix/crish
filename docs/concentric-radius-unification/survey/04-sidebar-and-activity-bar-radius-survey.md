# 全仓同心圆角与边距现状统一调查报告 — 侧边栏、活动栏与顶部窗口栏

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **调查任务**：维度 04 — 侧边栏（Sidebar）、活动栏（ActivityBar）、顶部窗口栏（TitleBar / InsetChrome）及侧边悬停气泡/菜单父子容器同心度勘察  
> **勘察代表**：Agent-04（侧边栏与活动栏勘察员）  
> **勘察日期**：2026-10-25  
> **状态**：已完成 (Completed)  
> **数据基准**：
> - 理想同心圆角几何标尺：$R_{outer} = R_{inner} + Padding \iff R_{inner} = \max(0, R_{outer} - Padding)$
> - 同心偏差度定义：$\Delta = R_{outer} - (R_{inner} + Padding)$
>   - $\Delta = 0$：内外圆弧严格同心，边缘留白处处等距（Concentric Harmony）；
>   - $\Delta < 0$：内角偏大或外角偏小，内角逼近或刺破外轮廓，产生**视觉挤压**（Corner Pinching / Visual Squeeze）；
>   - $\Delta > 0$：内角过小或外角过大，产生**外圆内方/空隙坍陷**（Optical Sinking）；
>   - $P_x \neq P_y$：非对称边距引发的**双轴椭圆撕裂**（Anisotropic Tearing）。

---

## 一、 勘察范围与物理模块映射说明

在 Conex / Crish 桌面端架构中，侧边栏、全局活动导航以及顶栏窗口控制经过了系统级重构，其在源码中的物理载体映射如下：

| 逻辑概念模块 | 物理文件域（TSX / CSS Module） | 职责与覆盖范围 |
| :--- | :--- | :--- |
| **侧栏外壳与折叠** | `apps/crish-desktop/src/components/sidebar/Sidebar.tsx`<br>`apps/crish-desktop/src/components/sidebar/Sidebar.module.css` | 侧栏主容器（展开/收起/临时展开/图标折叠/抽屉遮罩）、滚动区域（10px 走廊咬合）、宽度拖拽手柄 |
| **侧栏头部** | `apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx`<br>`apps/crish-desktop/src/components/sidebar/Sidebar.module.css` | 36px 顶栏容器、折叠/展开开关（`SidebarToggle`）、流体变形品牌图标、品牌标题 |
| **活动栏与全局导航** | `apps/crish-desktop/src/components/sidebar/SidebarNav.tsx`<br>`apps/crish-desktop/src/components/sidebar/SidebarNav.module.css` | 顶部快捷动作（新对话、定时任务、扩展入口）、侧栏纯净搜索输入框、折叠态 32px 方形图标导航带 |
| **会话列表系统** | `apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx`<br>`apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`<br>`apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css` | 28px 高度会话行胶囊、Hover/Active/Focus 态、分支徽标、定时任务计数徽标、悬浮更多操作按钮（24px）、虚拟滚动与拖拽幽灵卡片 |
| **项目与置顶分区** | `apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx`<br>`apps/crish-desktop/src/components/sidebar/session-list/PinnedSection.tsx`<br>`apps/crish-desktop/src/components/sidebar/session-list/GeneralSection.tsx`<br>`apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css` | 28px 分组控制行、排序/过滤触发钮、新建项目钮、项目文件夹折叠卡片、超出折叠切换行（26px 钮）、项目管理弹窗 |
| **侧栏底栏与用户卡片** | `apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx`<br>`apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx`<br>`apps/crish-desktop/src/components/sidebar/Sidebar.module.css` | 底部容器、用户个人卡片（`userProfileCard`）、正圆头像（26px）、设置齿轮按钮（32px）与更新脉冲点（8px）、安装更新按钮 |
| **顶部窗口栏与内嵌 Chrome** | `apps/crish-desktop/src/components/top-bar/AppTopBar.tsx`<br>`apps/crish-desktop/src/components/top-bar/AppTopBar.module.css`<br>`apps/crish-desktop/src/components/shell/WindowControls.tsx`<br>`apps/crish-desktop/src/components/shell/WindowControls.module.css` | 36px 绝对浮层/流内工作区顶栏、拖拽区（`spacer`）、Windows 11 原生规范无圆角直角窗控按钮组（最小化/最大化/关闭） |
| **侧边气泡、菜单与级联面板** | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.tsx`<br>`apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx`<br>`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx`<br>`apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css`<br>`apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css` | 会话右键菜单（`contextMenu` / `SmartPanel`）、排序过滤下拉菜单（`sortFilterMenu`）、二级级联飞出菜单（`sortFilterFlyout`） |

---

## 二、 侧栏外壳与折叠系统几何勘察（Sidebar Shell & Collapsed System）

### 2.1 侧栏宿主容器几何
- **源码位置**：[`Sidebar.module.css:1-14`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L1-L14)
- **外框尺寸与圆角**：
  - 宽度：`var(--sidebar-width)`（默认 260px，最小 180px，最大 480px）；
  - 高度：`height: 100%`；
  - 圆角：`border-radius: 0;`（无圆角，作为桌面视口左侧贴边基础列）；
  - 背景：`background: transparent;`（无独立底色，底色由主窗口透出）；
  - 边框：`border-right: none;`（已彻底移除硬垂直边线，呼吸感全靠布局留白）。
- **拖拽手柄几何**：[`Sidebar.module.css:384-414`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L384-L414)
  - 宽度：6px 触控区（`right: -3px;`），内部 1px 细线伪元素（`left: 2.5px; width: 1px;`）；
  - 圆角：`border-radius: 0;`。

### 2.2 侧栏纵向留白与 10px 边距走廊咬合
侧栏内容自上而下分为三段，其内衬边距设计呈现出高度一致的 10px 走廊约束：
1. **Header 行**：[`Sidebar.module.css:35-67`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L35-L67)
   - `padding: 0 10px;`（左 10px，右 10px）；
2. **Top Actions 区域**：[`Sidebar.module.css:189-194`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L189-L194)
   - `padding: var(--space-1) var(--space-2_5) 0 var(--space-2_5);` $\implies$ `padding: 4px 10px 0 10px;`；
3. **滚动主体区域**：[`Sidebar.module.css:196-212`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L196-L212)
   - `padding: var(--space-2_5) var(--space-0_5, 2px) var(--space-3_5) var(--space-2_5);` $\implies$ `padding: 10px 2px 14px 10px;`；
   - 配合 `scrollbar-gutter: stable;`（预留 10px 物理滑轨通道），右侧实际呼吸感 = $2\text{px} + 10\text{px} = 12\text{px}$，与左侧 10px 保持平衡；
4. **Footer 区域**：[`Sidebar.module.css:281-291`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L281-L291)
   - `padding: var(--space-1) var(--space-2_5) var(--space-2) var(--space-2_5);` $\implies$ `padding: 4px 10px 8px 10px;`。

### 2.3 折叠态（Icon-Collapse Mode）几何演变
- **源码位置**：[`Sidebar.module.css:440-488`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L440-L488)
- **外框宽度**：`var(--sidebar-width-collapsed)`（固定 48px）；
- **内边距收敛**：
  - `.iconCollapse .sidebarTop`: `padding: 4px 8px 0 8px;`
  - `.iconCollapse .sidebarScroll`: `padding: 10px 8px 14px 8px;`
  - `.iconCollapse .sidebarFooter`: `padding: 10px 8px;`
- **内部项几何对齐**：
  - 侧栏内所有交互项（导航按钮、会话指示点、用户头像卡片）在折叠态下均被强制重构为 **$32\text{px} \times 32\text{px}$** 的正方形图标交互块；
  - 边距公式验算：$8\text{px (左留白)} + 32\text{px (交互块)} + 8\text{px (右留白)} = 48\text{px}$，几何网格 100% 严密对齐。

---

## 三、 侧栏头部与全局导航区勘察（SidebarHeader & SidebarNav / Activity Bar）

### 3.1 侧栏折叠开关（SidebarToggle & SidebarHeaderLeft）
- **外层容器**：`.sidebarHeaderBar` / `.sidebarHeaderLeft`
  - 源码：[`Sidebar.module.css:55-75`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L55-L75)
  - 尺寸：高度 36px（`var(--header-height)`），左侧留白 10px；
  - 圆角：$R_{outer} = 0\text{px}$（贴边外壳）。
- **内层按钮**：`<IconButton size="md" variant="ghost" ... className="sidebar-toggle-btn" />`
  - 源码：[`SidebarHeader.tsx:92-103, 149-162`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx#L92-L103)
  - 按钮样式：[`Button.module.css:117-124, 294-298`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L117-L124)
  - 尺寸：宽度 32px，高度 32px；
  - 内层圆角：$R_{inner} = \text{var}(--\text{button-radius}) = \text{var}(--\text{radius-btn}) = 7\text{px}$（[`tokens.css:500-502`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L500-L502) 用户锁 U1）；
  - 纵向偏移：$P_y = (36 - 32) / 2 = 2\text{px}$。
- **内部图标形态**：`.toggleIconMorph`（$18\text{px} \times 18\text{px}$ 正方形）
  - 内部 SVG 品牌 Logo：圆点 `rx="16" ry="16"`（正圆）与线条。

### 3.2 全局导航动作项（SidebarNav / Activity Bar）
- **外层容器**：`.topActions`
  - 源码：[`SidebarNav.module.css:1-8`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L1-L8)
  - 间距：`gap: 4px;`，折叠态下变为 `gap: var(--space-2);`（8px）。
- **导航项交互卡片**：`.navItem`（新对话、定时任务、扩展）
  - 源码：[`SidebarNav.module.css:10-41`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L10-L41)
  - 高度：`height: var(--control-height);`（32px）；
  - 内边距：`padding: 0 8px;`（水平内边距 8px）；
  - 圆角声明：`border-radius: var(--radius-lg);`；
  - 对应 Token：[`tokens.css:506`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L506) 中 `--radius-lg: var(--radius-m);`（**8px**）；
  - 内部图标：`<AppIcon size={16} />`，尺寸 $16\text{px} \times 16\text{px}$，水平 gap 8px；
  - 激活态：`.navItem.isActive` 产生 `background: var(--sidebar-active); border-color: transparent;`。
- **搜索输入框**：`.navItem[role='search']`
  - 源码：[`SidebarNav.module.css:86-135`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L86-L135)
  - 外轮廓：共享 `.navItem` 的 32px 高度与 8px 圆角（`var(--radius-lg)`）；
  - 内部 input：`<Input bare type="search" ... />`，内部声明清空了 border、outline、background、padding 与 margin（`padding: 0; margin: 0; border: none;`）；
  - 同心分析：搜索框属于“外包胶囊内嵌零边框无底色文本”形态，不存在内外容器双重边框断层。

---

## 四、 会话列表项与嵌套组件勘察（SidebarSessionList & SessionRow）

会话列表项是侧边栏中交互频次最高、视觉嵌套层级最深的区域。

```
+-----------------------------------------------------------------------------------------+
| .sessionItemWrap (h: 28px)                                                              |
|  +-----------------------------------------------------------------------------------+  |
|  | .sessionItem (h: 28px, Ro = 8px, pad: 0 4px 0 32px)                                |  |
|  |  +-----------------------+   +--------------------------------------------------+  |  |
|  |  | .sessionTextCol       |   | .sessionTrailing (h: 24px, right: 0)            |  |  |
|  |  | (14px title / 12px)  |   |  [Badge] [Time] +-----------------------------+  |  |  |
|  |  |                       |   |                 | .sessionActionsBtn          |  |  |  |
|  |  |                       |   |                 | (24x24, Ri = 8px, Py = 2px) |  |  |  |
|  |  |                       |   |                 +-----------------------------+  |  |  |
|  |  +-----------------------+   +--------------------------------------------------+  |  |
|  +-----------------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------------+
```

### 4.1 会话行交互胶囊（`.sessionItem`）
- **外层包裹**：`.sessionItemWrap`（[`SidebarSessionList.module.css:361-371`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L361-L371)）
  - 固定高度：`height: 28px; min-height: 28px; max-height: 28px;`（来自 `SIDEBAR_SESSION_ROW_HEIGHT = 28`）；
  - 严格限制：`overflow: hidden; contain: strict;`。
- **胶囊主体**：`.sessionItem`（[`SidebarSessionList.module.css:373-400`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L373-L400)）
  - 尺寸：宽度 100%，高度 28px；
  - 圆角声明：`border-radius: var(--radius-lg);` $\implies$ **$R_{outer} = 8\text{px}$**；
  - 内边距：`padding: 0 var(--space-1) 0 var(--space-8);` $\implies$ **$P_y = 0\text{px}, P_{right} = 4\text{px}, P_{left} = 32\text{px}$**；
  - 交互底色：常态 transparent，悬浮 `var(--sidebar-hover)`，选中 `var(--sidebar-active)`，按下 `color-mix` 介于二者之间。

### 4.2 嵌套尾部操作按钮（`.sessionActionsBtn`）
- **源码位置**：[`SidebarSessionList.module.css:607-636`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L607-L636)、[`SessionRow.tsx:403-420`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx#L403-L420)
- **物理尺寸**：宽度 24px，高度 24px（常量 `SESSION_ACTIONS_BTN_PX = 24`）；
- **内部圆角**：`border-radius: var(--radius-md);` $\implies$ **$R_{inner} = 8\text{px}$**；
- **定位关系**：
  - 挂载在 `.sessionTrailing`（高度 24px，右浮动容器）中；
  - 声明 `position: absolute; right: 0; top: 50%; transform: translateY(-50%);`；
  - 相对外层 `.sessionItem` 顶边/底边偏移：$P_y = (28 - 24) / 2 = \mathbf{2\text{px}}$；
  - 相对外层 `.sessionItem` 右侧边框偏移：由于 `.sessionItem` 具有 `padding-right: var(--space-1) = 4px`，因此按钮右缘距外胶囊右缘正好为 $P_x = \mathbf{4\text{px}}$；
- **同心几何计算**：
  $$\begin{aligned}
  R_{inner\_ideal\_y} &= R_{outer} - P_y = 8\text{px} - 2\text{px} = 6\text{px} \\
  R_{inner\_ideal\_x} &= R_{outer} - P_x = 8\text{px} - 4\text{px} = 4\text{px} \\
  \Delta_y &= R_{outer} - (R_{inner} + P_y) = 8 - (8 + 2) = \mathbf{-2\text{px}} \\
  \Delta_x &= R_{outer} - (R_{inner} + P_x) = 8 - (8 + 4) = \mathbf{-4\text{px}}
  \end{aligned}$$
- **病灶深度剖析**：
  - **严重同心挤压（Corner Pinching）**：外层容器圆角为 8px，内层按钮圆角同样被赋予了 8px（因为 `--radius-lg` 和 `--radius-md` 在 `tokens.css` 中均映射为 `--radius-m: 8px`）。
  - 内层圆角中心 $(x_{ci}, y_{ci})$ 相对外层圆角中心外偏，导致右上角与右下角内弧曲线曲率与外框发生几何碰撞。当用户鼠标悬停在会话上并继续悬停在更多按钮时，按钮高亮底色（`var(--tint-hover)`）与会话胶囊底色同时渲染，角部留白被急剧挤占，产生明显的“角尖顶撞外框”不良观感。

### 4.3 嵌套定时任务徽标（`.sessionScheduleBadge`）
- **源码位置**：[`SidebarSessionList.module.css:590-606`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L590-L606)、[`SessionRow.tsx:117-130`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx#L117-L130)
- **尺寸与内边距**：高度 14px（12px icon + 1px top/bottom pad），`padding: 1px 4px;`；
- **内部圆角**：`border-radius: var(--radius-sm);` $\implies$ **$R_{inner} = 4\text{px}$**；
- **垂直间距**：$P_y = (28 - 14) / 2 = 7\text{px}$；
- **同心计算**：$R_{outer} - P_y = 8 - 7 = 1\text{px}$，实际 $R_{inner} = 4\text{px}$，$\Delta = -3\text{px}$；
- **视觉判定**：徽标默认无深色背景底色，字重轻量，虽然代数不完全同心，但视觉挤压感弱。

### 4.4 拖拽幽灵卡片（`.sidebarDragGhost`）
- **源码位置**：[`SidebarSessionList.module.css:749-763`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L749-L763)
- **外框尺寸与圆角**：
  - 内边距：`padding: 8px 12px;`
  - 圆角声明：`border-radius: var(--radius-xl);` $\implies$ **$R_{outer} = 12\text{px}$**（`tokens.css:507` 中 `--radius-xl: var(--radius-l) = 12px`）；
  - 阴影与边框：`border: 1px solid var(--border-color); box-shadow: var(--shadow-lg);`；
  - 内部文本单行，无多层嵌套卡片，12px 圆角呈现出平滑的拖拽浮动感。

---

## 五、 项目分组、置顶区与管理弹窗勘察（ProjectsSection, PinnedSection & ProjectManageModal）

### 5.1 分组标题行与操作按钮（`.sectionLabelRow` & `.folderHeaderRow`）
- **外层行容器**：
  - 源码：[`SidebarSessionList.module.css:58-67, 221-230`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L58-L67)
  - 尺寸：高度固定 28px（`height: 28px; min-height: 28px; max-height: 28px;`）；
  - 内边距：`padding: 0 var(--space-1) 0 var(--space-2);` $\implies$ **左 8px，右 4px**；
  - 圆角：行容器本身为透明容器，无圆角。
- **头部快捷按钮**（`.sectionSortBtn`, `.sectionNew`, `.folderMoreBtn`, `.folderNewBtn`）：
  - 源码：[`SidebarSessionList.module.css:133-158, 294-322`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L133-L158)
  - 尺寸：$24\text{px} \times 24\text{px}$；
  - 圆角：`border-radius: var(--radius-md);` $\implies$ **8px**；
  - 垂直偏移：$P_y = (28 - 24) / 2 = 2\text{px}$，水平右侧偏移：$P_x = 4\text{px}$；
  - 样式特点：悬浮时设置 `background-color: transparent;` 与 `--btn-hover-overlay: transparent;`，仅文字/图标变亮（无底色渲染，避免了 8px 圆角与 28px 行的视觉底色错位）。

### 5.2 超出折叠切换行（`.foldToggleRow` & `.foldToggleBtn`）
- **外层容器**：`.foldToggleRow`（[`SidebarSessionList.module.css:839-849`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L839-L849)）
  - 高度：28px，内边距 `padding: 0 4px;`；
- **内层按钮**：`.foldToggleBtn`（[`SidebarSessionList.module.css:851-874`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L851-L874)）
  - 宽度：100%，高度：26px；
  - 内边距：`padding: 0 8px;`；
  - 圆角声明：`border-radius: var(--radius-md);` $\implies$ **8px**；
  - 几何偏移：垂直上下各 $1\text{px}$，左右各 $4\text{px}$；
  - 交互状态：hover/active 时保持 `background: transparent;`，不显露底色。

### 5.3 置顶拖放区（`.pinnedDropZone`）
- **源码位置**：[`SidebarSessionList.module.css:188-201`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L188-L201)
- **外层圆角**：`border-radius: var(--radius-lg);` $\implies$ **8px**；
- **拖放态**：`border-color: transparent; background-color: transparent;`（做减法，移除了历史绿框，内部会话项通过平移让位）；
- **内部项**：承载置顶会话列表，各会话项圆角亦为 8px。

### 5.4 项目管理弹窗深度勘察（ProjectManageModal）
项目管理弹窗是侧栏弹出的关键子系统，存在明确的父子容器嵌套链条。
- **弹窗模态外壳**：`.modalPanel`（[`ProjectManageModal.module.css:1-11`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L1-L11)）
  - 宽度：440px；
  - 圆角声明：`border-radius: var(--radius-2xl, 24px);`；
  - 真实 Token 校验：`tokens.css:508` 中 `--radius-2xl: var(--radius-l) = 12px;`，因此在 CSS 变量生效时实际渲染为 **12px**，而非常量 fallback 的 24px。
- **已选文件夹列表卡片**：`.folderListCard`（[`ProjectManageModal.module.css:99-110`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L99-L110)）
  - 内边距：`padding: var(--space-1_5, 6px);` $\implies$ **6px**；
  - 外层圆角：`border-radius: var(--radius-lg, 12px);` $\implies$ **12px**（`tokens.css:506` 中 `--radius-lg: var(--radius-m) = 8px`！**严重 Token 漂移：fallback 写 12px，实际生效却是 8px！**）；
- **文件夹单项卡片**：`.folderItem`（[`ProjectManageModal.module.css:113-126`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L113-L126)）
  - 内边距：`padding: 6px 10px;`；
  - 内层圆角：`border-radius: var(--radius-md, 8px);` $\implies$ **8px**；
  - **同心几何验算**：
    - 若以 Token 生效值计：$R_{outer} = 8\text{px}, Padding = 6\text{px} \implies R_{inner\_ideal} = 8 - 6 = 2\text{px}$。
    - 实际 $R_{inner} = 8\text{px}$，偏差度 $\Delta = 8 - (8 + 6) = \mathbf{-6\text{px}}$！
    - 若以 Fallback 注释意图计：$R_{outer} = 12\text{px}, Padding = 6\text{px} \implies R_{inner\_ideal} = 12 - 6 = 6\text{px}$。
    - 实际 $R_{inner} = 8\text{px}$，偏差度 $\Delta = 12 - (8 + 6) = \mathbf{-2\text{px}}$。
- **文件夹单项内的删除按钮**：`.folderRemoveBtn`（[`ProjectManageModal.module.css:168-185`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L168-L185)）
  - 尺寸：$22\text{px} \times 22\text{px}$；
  - 圆角：`border-radius: var(--radius-xs, 4px);` $\implies$ **4px**；
  - 父级 `.folderItem` 圆角为 8px，垂直内边距 6px，水平内边距 10px；
  - 同心垂直：$R_{ideal} = \max(0, 8 - 6) = 2\text{px}$，实际 4px，$\Delta = -2\text{px}$。

---

## 六、 侧栏底栏与用户卡片勘察（SidebarFooter & UserProfileCard）

### 6.1 用户个人卡片（UserProfileCard）
- **外层交互按钮**：`.userProfileCard`
  - 源码：[`Sidebar.module.css:307-336`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L307-L336)
  - 尺寸：宽度 100%，高度 $\approx 34\text{px}$（26px 头像 + 上下各 4px padding）；
  - 内边距：`padding: 4px 8px;` $\implies$ **$P_y = 4\text{px}, P_x = 8\text{px}$**；
  - 外层圆角：`border-radius: var(--radius-btn);` $\implies$ **$R_{outer} = 7\text{px}$**（用户锁 U1）；
  - 交互底色：常态 transparent，hover `var(--sidebar-hover)`，active/open `var(--tint-active)`。
- **内层头像容器与正圆头像**：
  - 源码：[`Sidebar.module.css:337-355`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L337-L355)
  - 头像容器：`.userAvatarContainer`（$26\text{px} \times 26\text{px}$）；
  - 头像本身：`.userAvatar`（$26\text{px} \times 26\text{px}$），`border-radius: 50%;` $\implies$ **$R_{inner} = 13\text{px}$**；
- **同心几何计算与形态学诊断**：
  $$\begin{aligned}
  R_{outer} &= 7\text{px} \\
  R_{inner} &= 13\text{px} \\
  R_{inner} + P_y &= 13\text{px} + 4\text{px} = 17\text{px} \implies \Delta_y = 7 - 17 = \mathbf{-10\text{px}} \\
  R_{inner} + P_x &= 13\text{px} + 8\text{px} = 21\text{px} \implies \Delta_x = 7 - 21 = \mathbf{-14\text{px}}
  \end{aligned}$$
- **核心病灶发现**：
  1. **内圆角反超外圆角（Inverted Curvature）**：外层容器圆角为 7px，内层头像为半径 13px 的正圆。内圆弧曲率远大于外壳曲率，视觉上圆形头像如同“强行塞入浅圆角矩形”中；
  2. **双轴边距撕裂（Anisotropic Tearing）**：$P_x = 8\text{px}$ 是 $P_y = 4\text{px}$ 的两倍，导致头像距离左缘与上缘留白严重失衡；
  3. **侧栏内部圆角 Token 割裂**：侧栏上部的 `SidebarNav .navItem` 采用 8px（`var(--radius-lg)`），而下部同为长条交互卡片的 `UserProfileCard` 却采用 7px（`var(--radius-btn)`），同列纵向对齐存在 1px 细微顿挫。

### 6.2 设置齿轮按钮与更新脉冲点（SettingsIconButton & PulseDot）
- **外层设置按钮**：`<IconButton size="md" ... data-testid="sidebar-settings-gear-btn" />`
  - 源码：[`SidebarFooter.tsx:34-58`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx#L34-L58)
  - 尺寸：$32\text{px} \times 32\text{px}$；
  - 圆角：`border-radius: var(--button-radius);` $\implies$ **7px**；
- **内层更新脉冲点**：`.gearUpdatePulseDot`
  - 源码：[`Sidebar.module.css:373-383`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L373-L383)
  - 尺寸：$8\text{px} \times 8\text{px}$，`border-radius: 50%;`（半径 4px）；
  - 定位：`position: absolute; top: 4px; right: 4px;`；
  - 隔离光晕：`box-shadow: 0 0 0 2px var(--bg-secondary);`；
  - 几何验算：脉冲点物理半径 4px + 2px 扩散环 = 实际视觉半径 6px。距离按钮右上边缘净距离仅为 $4\text{px} - 2\text{px} = 2\text{px}$。
  - 同心度计算：$R_o = 7\text{px}, P = 2\text{px}, R_i = 6\text{px} \implies \Delta = 7 - (6 + 2) = \mathbf{-1\text{px}}$。光晕环距离按钮右上角极为贴近。

---

## 七、 顶部窗口栏与内嵌 Chrome 勘察（AppTopBar & WindowControls）

### 7.1 应用顶栏布局容器（AppTopBar）
- **源码位置**：[`AppTopBar.module.css:8-51`](file:///c:/Software/conex/apps/crish-desktop/src/components/top-bar/AppTopBar.module.css#L8-L51)、[`AppTopBar.tsx:26-46`](file:///c:/Software/conex/apps/crish-desktop/src/components/top-bar/AppTopBar.tsx#L26-L46)
- **容器属性**：
  - 高度：`height: var(--header-height, 36px); min-height: 36px; max-height: 36px;`；
  - 定位机制：挂载在 `.workspaces-column` 第一子位，`pointer-events: none`（允许点击穿透到底层标签条），仅右侧窗控区域响应事件（`pointer-events: auto`）；
  - 背景与边框：`background: transparent; border-bottom: none;`；
  - 圆角：`border-radius: 0;`。
- **尾部窗控插槽**：`.trail`
  - 内边距：`padding-left: var(--space-1, 4px); padding-right: 0;`（右侧 0 间距直接贴靠视口右缘）。

### 7.2 窗口控制按钮组（WindowControls）
- **源码位置**：[`WindowControls.module.css:9-64`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/WindowControls.module.css#L9-L64)、[`WindowControls.tsx:112-166`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/WindowControls.tsx#L112-L166)
- **外层按钮组**：`.controlsGroup`
  - 高度：`height: 100%`（铺满 36px），`align-items: stretch;`；
- **窗控按钮**：`.winBtn`（最小化、最大化/还原、关闭应用）
  - 宽度：`width: var(--window-caption-btn-width);`（Windows 规范约 46px）；
  - 高度：`height: 100%;`（36px）；
  - 边距与圆角：`margin: 0; padding: 0; border: none; border-radius: 0;`；
  - 背景：常态 transparent，hover `var(--tint-hover)`，active `var(--tint-active)`；
  - 关闭按钮特别处理：`.closeBtn:hover` 为 `background: var(--window-close-hover-bg);`（经典 Win11 红色）。
- **OS 原生契约与同心度合规性**：
  - **规范合规**：此处 $R_{outer} = 0, R_{inner} = 0, Padding = 0 \implies \Delta = 0$。
  - Windows 11 DWM（Desktop Window Manager）会对原生窗口四角施加系统级圆角裁剪。当关闭按钮在右上角被 hover 变红时，其红底直角直接交由 DWM 裁剪为硬件平滑弧线，不露出锯齿方角。这一设计完全符合操作系统级平台契约。

---

## 八、 侧边上下文菜单与级联飞出面板勘察（SidebarContextMenus & SmartPanel Flyout）

### 8.1 会话右键菜单（SidebarContextMenus & SmartPanel）
在右键单击会话项时，激活会话操作菜单。系统中有两套相关实现：`SidebarContextMenus.module.css` 中的 `.contextMenu` 以及委托给 `SmartPanel.module.css` 的面板。

#### 8.1.1 独立上下文菜单（`SidebarContextMenus.module.css`）
- **外层面板**：`.contextMenu`（[`SidebarContextMenus.module.css:1-14`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L1-L14)）
  - 内边距：`padding: var(--space-1_5);` $\implies$ **6px**；
  - 外层圆角：`border-radius: var(--radius-2xl);` $\implies$ **12px**（`tokens.css:508` 中 `--radius-2xl: var(--radius-l) = 12px`）；
  - 边框与阴影：`border: 1px solid var(--border-color); box-shadow: var(--shadow-lg);`；
- **内层菜单项**：`.contextMenuItem`（[`SidebarContextMenus.module.css:48-64`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L48-L64)）
  - 高度与内衬：`min-height: 32px; padding: 6px 10px;`；
  - 内层圆角：`border-radius: var(--radius-md);` $\implies$ **8px**；
- **同心几何分析**：
  $$\begin{aligned}
  R_{outer} &= 12\text{px} \\
  Padding &= 6\text{px} \\
  R_{inner\_ideal} &= R_{outer} - Padding = 12\text{px} - 6\text{px} = \mathbf{6\text{px}} \\
  R_{inner\_actual} &= 8\text{px} \\
  \Delta &= R_{outer} - (R_{inner} + Padding) = 12 - (8 + 6) = \mathbf{-2\text{px}}
  \end{aligned}$$
  **诊断**：内菜单项圆角为 8px，超出了理想同心圆角 6px，首末项在悬浮高亮时角部与外框 12px 弧线产生 -2px 的视觉夹紧。

#### 8.1.2 基于 SmartPanel 的会话菜单（`SmartPanel.module.css`）
- **外层面板**：`.panel`（[`SmartPanel.module.css:33-50`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L33-L50)）
  - 内边距：`padding: 6px;`；
  - 外层圆角：`border-radius: var(--sep-radius-outer, 14px);`；
  - **重大历史断层**：在 `SmartPanel.module.css:195` 的核心注释中，原作者明确写道：
    ```css
    /* 槽位化菜单条目 (Outer 14px - Padding 6px = Item 8px) */
    ```
    原作者的几何意图是完美同心的：$14\text{px} - 6\text{px} = 8\text{px}$（$\Delta = 0$）！
    然而，后续在 `tokens.css:282` 将 `--sep-radius-outer` 强行锁死为 `var(--radius-l)`（12px）。
    导致运行时 CSS 变量优先解析为 **12px**，fallback 的 14px 完全失效！
    结果：外层变成了 12px，而内部条目 `.item` 仍保持 8px（`var(--radius-m)`），原本天衣无缝的同心公式被破坏为 $12 - (8 + 6) = \mathbf{-2\text{px}}$！

### 8.2 排序与筛选下拉级联菜单（ContextMenuFlyout）
- **一级排序面板**：`.sortFilterMenu`（[`SidebarContextMenus.module.css:96-111`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L96-L111)）
  - 内边距：`padding: 6px;`；
  - 外层圆角：`border-radius: var(--sep-radius-outer);` $\implies$ **12px**；
  - 内层交互行：`.sortFilterRow`，`padding: 4px 8px; border-radius: var(--radius-m);` $\implies$ **8px**；
  - 同心度计算：$R_o = 12\text{px}, P = 6\text{px}, R_i = 8\text{px} \implies \Delta = \mathbf{-2\text{px}}$。
- **二级级联飞出菜单**：`.sortFilterFlyout`（[`SidebarContextMenus.module.css:182-200`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L182-L200)）
  - 内边距：`padding: 6px;`；
  - 外层圆角：`border-radius: var(--sep-radius-outer);` $\implies$ **12px**；
  - 内层选项：`.sortFilterOption`，`padding: 4px 8px; border-radius: var(--radius-m);` $\implies$ **8px**；
  - 同心度计算：$R_o = 12\text{px}, P = 6\text{px}, R_i = 8\text{px} \implies \Delta = \mathbf{-2\text{px}}$。

---

## 九、 全景父子容器几何同心测量矩阵表（Concentric Audit Matrix）

下表完整收录本次勘察覆盖的全部 12 组核心容器与嵌套子项，严格按照同心度方程量化：

| 序号 | 容器（Parent） | 嵌套子项（Child） | 代码精确位置 | 外圆角 $R_o$ | 内边距 $P (P_x, P_y)$ | 内圆角 $R_i$ | 理论同心 $R_i^*$ | 偏差 $\Delta$ | 几何形态学诊断 |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **01** | 会话行交互胶囊<br>`.sessionItem` | 尾部更多操作按钮<br>`.sessionActionsBtn` | `SidebarSessionList.module.css:380`<br>`SidebarSessionList.module.css:622`<br>`SessionRow.tsx:32, 407` | **8px**<br>`--radius-lg` | $P_x = 4\text{px}$<br>$P_y = 2\text{px}$ | **8px**<br>`--radius-md` | $R_{ix}^* = 4\text{px}$<br>$R_{iy}^* = 6\text{px}$ | **-4px (X)**<br>**-2px (Y)** | **严重挤压**：$R_o = R_i = 8\text{px}$，内角曲率过大，高亮时角部空间急剧压迫 |
| **02** | 会话行交互胶囊<br>`.sessionItem` | 定时任务计数徽标<br>`.sessionScheduleBadge` | `SidebarSessionList.module.css:380`<br>`SidebarSessionList.module.css:596`<br>`SessionRow.tsx:118` | **8px**<br>`--radius-lg` | $P_x \ge 4\text{px}$<br>$P_y = 7\text{px}$ | **4px**<br>`--radius-sm` | $R_{iy}^* = 1\text{px}$ | **-3px (Y)** | **可接受偏离**：微型文本徽标，无强对比底色，视觉冲击弱 |
| **03** | 会话行重命名态<br>`.sessionItem.isRenaming` | 会话重命名输入框<br>`.sessionRenameInput` | `SidebarSessionList.module.css:685`<br>`SidebarSessionList.module.css:473`<br>`SessionRow.tsx:361` | **8px**<br>`--radius-lg` | $P_x = 8\text{px}$<br>$P_y = 4\text{px}$ | **0px**<br>`border: none` | $0\text{px}$ | **0px** | **完美单层**：内部 input 纯净无底色，仅外层渲染焦点环 |
| **04** | 折叠态会话指示项<br>`[collapsed] .sessionItem` | 正圆未读/活动原点<br>`.sessionItem::before` | `SidebarSessionList.module.css:818`<br>`SidebarSessionList.module.css:827` | **8px**<br>`--radius-md` | $P_x = 12\text{px}$<br>$P_y = 12\text{px}$ | **4px**<br>`50% (8x8)` | $0\text{px}$ | **-8px** | **无冲突同心**：$P (12\text{px}) > R_o (8\text{px})$，小点位于平坦中心区 |
| **05** | 全局导航按钮<br>`SidebarNav .navItem` | 图标与搜索输入框<br>`[role='search'] input` | `SidebarNav.module.css:32`<br>`SidebarNav.module.css:102`<br>`SidebarNav.tsx:81` | **8px**<br>`--radius-lg` | $P_x = 8\text{px}$<br>$P_y = 0\text{px}$ | **0px**<br>`border: none` | $0\text{px}$ | **0px** | **结构良好**：输入框 bare 处理，外层统一 8px 胶囊底色 |
| **06** | 侧栏底部用户卡片<br>`.userProfileCard` | 个人圆形头像容器<br>`.userAvatar` | `Sidebar.module.css:313`<br>`Sidebar.module.css:347`<br>`UserProfileCard.tsx:59` | **7px**<br>`--radius-btn` | $P_x = 8\text{px}$<br>$P_y = 4\text{px}$ | **13px**<br>`50% (26x26)` | $R_{ix}^* = 0\text{px}$<br>$R_{iy}^* = 3\text{px}$ | **-14px (X)**<br>**-10px (Y)** | **严重倒挂/撕裂**：内圆角 13px 反超外圆角 7px，且 $P_x \neq P_y$ 产生轴向椭圆撕裂 |
| **07** | 侧栏设置齿轮按钮<br>`IconButton size="md"` | 更新就绪脉冲红点<br>`.gearUpdatePulseDot` | `Button.module.css:121`<br>`Sidebar.module.css:373`<br>`SidebarFooter.tsx:49` | **7px**<br>`--button-radius` | 净 $P \approx 2\text{px}$<br>(含 2px 环) | **6px**<br>(含 2px 环) | $5\text{px}$ | **-1px** | **轻微紧贴**：2px 阴影扩散环使有效边界极度贴近按钮 7px 圆角内弧 |
| **08** | 项目管理文件夹容器<br>`.folderListCard` | 文件夹项卡片<br>`.folderItem` | `ProjectManageModal.module.css:104`<br>`ProjectManageModal.module.css:118` | **8px (实)**<br>`12px (fallback)` | $P_x = 6\text{px}$<br>$P_y = 6\text{px}$ | **8px**<br>`--radius-md` | $2\text{px}$ (实)<br>$6\text{px}$ (意图) | **-6px (实)**<br>**-2px (意图)** | **Token 漂移挤压**：`--radius-lg` 在 tokens 映射为 8px，导致内外圆角等大（8px）严重挤压 |
| **09** | 文件夹项卡片<br>`.folderItem` | 单项移除按钮<br>`.folderRemoveBtn` | `ProjectManageModal.module.css:118`<br>`ProjectManageModal.module.css:178` | **8px**<br>`--radius-md` | $P_x = 10\text{px}$<br>$P_y = 6\text{px}$ | **4px**<br>`--radius-xs` | $R_{iy}^* = 2\text{px}$<br>$R_{ix}^* = 0\text{px}$ | **-2px (Y)**<br>**-6px (X)** | **轻度挤压**：移除按钮 4px 圆角略大，水平 10px 留白处偏平 |
| **10** | 会话右键菜单<br>`.contextMenu` / `.panel` | 菜单单条条目<br>`.contextMenuItem` / `.item` | `SidebarContextMenus.module.css:6, 59`<br>`SmartPanel.module.css:40, 211` | **12px**<br>`--sep-radius-outer` | $P_x = 6\text{px}$<br>$P_y = 6\text{px}$ | **8px**<br>`--radius-md` | $6\text{px}$ | **-2px** | **历史意图破坏**：设计原本计划 14px - 6px = 8px，Token 偶数化收口为 12px 后未联动调整内项 |
| **11** | 排序筛选下拉飞出菜单<br>`.sortFilterFlyout` | 筛选单项单选条目<br>`.sortFilterOption` | `SidebarContextMenus.module.css:190`<br>`SidebarContextMenus.module.css:236` | **12px**<br>`--sep-radius-outer` | $P_x = 6\text{px}$<br>$P_y = 6\text{px}$ | **8px**<br>`--radius-m` | $6\text{px}$ | **-2px** | **同心差值失衡**：同项 10，外 12px 与内 8px 在 6px 留白下产生 -2px 偏差 |
| **12** | 顶部流内顶栏与窗控<br>`AppTopBar` / `controlsGroup` | Windows 原生窗控按钮<br>`WindowControls .winBtn` | `AppTopBar.module.css:8`<br>`WindowControls.module.css:25` | **0px**<br>(直角贴边) | $P = 0\text{px}$ | **0px**<br>(直角铺满) | $0\text{px}$ | **0px** | **平台原生规范**：Win11 规范贴边铺满，外圆角由系统 DWM 硬件级直接裁剪 |

---

## 十、 五大核心病灶、成因穿透与治理建议（Root Causes & Remedies）

### 病灶一：内外圆角等大导致的角部挤压（$R_o = R_i = 8\text{px}$）
- **现场证据**：[`SidebarSessionList.module.css:380, 622`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L380)
  - 外层会话胶囊：`border-radius: var(--radius-lg)`（解析为 8px）；
  - 内层操作按钮：`border-radius: var(--radius-md)`（解析为 8px）；
  - 按钮边距：垂直 $P_y = 2\text{px}$，水平 $P_x = 4\text{px}$；
  - 偏差度：$\Delta_y = -2\text{px}, \Delta_x = -4\text{px}$。
- **根因穿透**：
  CSS 编写者误以为 `--radius-lg` 比 `--radius-md` 大一个台阶（直觉以为可能是 12px vs 8px 或 10px vs 6px）。但在 `tokens.css:505-506` 中：
  ```css
  --radius-md: var(--radius-m); /* 8px */
  --radius-lg: var(--radius-m); /* 8px */
  ```
  两者完全等价！导致外层与内层同时拿到 8px，内角圆弧直接顶向外框。
- **治理建议**：
  保持外层 `.sessionItem` 8px 不变；根据同心公式 $R_{inner} = \max(0, R_{outer} - P)$，且内嵌按钮垂直留白为 2px，将 `.sessionActionsBtn` 的圆角重构为 **6px**（或 `--radius-s: 4px`），使 $R_i + P_y = 6 + 2 = 8\text{px}$，达成 $\Delta_y = 0$ 完美同心。

---

### 病灶二：设计意图与 Token SSOT 偶数化收口的脱节断层（SmartPanel 14px $\to$ 12px）
- **现场证据**：[`SmartPanel.module.css:40, 195, 211`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L40) 与 [`SidebarContextMenus.module.css:6, 59`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L6)
  - 注释证据：`/* 槽位化菜单条目 (Outer 14px - Padding 6px = Item 8px) */`
  - 运行现状：外层面板实效 `border-radius: var(--sep-radius-outer) = 12px`；
  - 内层项：`border-radius: var(--radius-m) = 8px`；
  - 偏差度：$\Delta = 12 - (8 + 6) = -2\text{px}$。
- **根因穿透**：
  历史重构中推行“全仓圆角 5 档 SSOT（4/8/12/20/9999px）”，将 `--sep-radius-outer` 由 14px 强制降级对齐到 `--radius-l` (12px)。但未能联动将内层 `.item` 的圆角从 8px 调整至 6px，导致原本闭合的数学公式断裂。
- **治理建议**：
  方案 A（遵循 12px 外壳）：外层维持 `--radius-l` (12px)，内边距 6px，将内层条目圆角收敛为 **6px**（同心公式 $12 - 6 = 6\text{px}$）；  
  方案 B（遵循 8px 内项）：若内项必须保持 `--radius-m` (8px)，则外层容器圆角必须恢复为 **14px**（$14 - 6 = 8\text{px}$），需在 Token 层确立语义层级契约。

---

### 病灶三：底栏用户卡片外小内大与非对称各向异性撕裂
- **现场证据**：[`Sidebar.module.css:313, 347`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L313)
  - 外层卡片：`border-radius: var(--radius-btn) = 7px; padding: 4px 8px;`
  - 内层头像：`width: 26px; height: 26px; border-radius: 50% = 13px;`
  - 偏差度：$\Delta_y = -10\text{px}, \Delta_x = -14\text{px}$。
- **根因穿透**：
  `UserProfileCard` 被机械套用了“按钮圆角 7px”（用户锁 U1）。但该卡片实际上是一个高 34px、内含 26px 正圆头像的复合展示容器，并非单纯的文字按钮。7px 的极浅外轮廓包裹 13px 的大圆形头像，形成了视觉上的“外方内圆/内凸外平”的反差；且水平 8px、垂直 4px 的非对称边距使得四个象限的同心度无法通过单一标量拟合。
- **治理建议**：
  将 `UserProfileCard` 视为独立展示卡片（`--radius-m: 8px` 或微胶囊形态），调整水平/垂直内边距比例，使正圆头像与容器边缘过渡平缓。

---

### 病灶四：同一侧栏纵向轴线上的 7px 与 8px 混用不均
- **现场证据**：
  - 顶栏切换按钮：7px（`--button-radius`）；
  - 全局导航动作项（新对话/定时任务/扩展）：8px（`--radius-lg`）；
  - 会话列表项：8px（`--radius-lg`）；
  - 底栏用户卡片：7px（`--radius-btn`）；
  - 底栏设置齿轮按钮：7px（`--button-radius`）；
  - 折叠态会话指示点容器：8px（`--radius-md`）；
  - 折叠态用户卡片容器：7px（`--radius-btn`）。
- **根因穿透**：
  组件开发者在消费 Token 时，部分组件使用了通用按钮规则（`--radius-btn: 7px`），部分组件使用了列表项/通用中圆角规则（`--radius-lg / --radius-md: 8px`）。在展开态下由于宽度占满，1px 差异不明显；但在折叠态下，所有按钮均表现为 $32\text{px} \times 32\text{px}$ 的方形图标块，一列排开时，上部项为 8px 圆角，底部项为 7px 圆角，形成亚微米级的触觉与视觉不统一。
- **治理建议**：
  明确折叠态方形图标按钮统一继承 `--radius-md`（8px），或为侧栏长条交互胶囊建立专用的 `--sidebar-item-radius` 语义契约。

---

### 病灶五：项目管理弹窗 Fallback 与 Token 实效值的“双源漂移”
- **现场证据**：[`ProjectManageModal.module.css:104`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L104)
  - CSS 声明：`border-radius: var(--radius-lg, 12px);`
  - 意图：作者希望该列表卡片拥有 12px 大圆角；
  - 现实：`--radius-lg` 被解析为 `--radius-m` = 8px，fallback 的 12px 完全未命中；
  - 结果：外层容器实际为 8px，内部 `.folderItem` 同样为 8px，导致 $\Delta = -6\text{px}$ 的严重挤压。
- **治理建议**：
  清理具有误导性的 fallback 常量，显式指定语义 Token（如卡片外壳显式使用 `--radius-l` 或 `--radius-xl`），彻底消除“代码注释/fallback 想写 12px，实际运行沦为 8px”的虚假同心现象。

---

## 十一、 勘察结论与汇报摘要

1. **同心现状评级**：
   - 顶部窗口栏与窗控（`AppTopBar` / `WindowControls`）：**优秀 (A+)**，完全符合 Win11 原生规范，无同心度隐患；
   - 侧栏外壳与折叠系统（`Sidebar` / `SidebarNav`）：**良好 (A-)**，10px 边距走廊咬合严密，搜索输入框无多层边框冲突；
   - 会话列表与操作项（`SessionRow`）：**存在几何缺陷 (B-)**，更多操作按钮与会话胶囊 $R_o = R_i = 8\text{px}$ 产生 -2px / -4px 的角部挤压；
   - 弹层与上下文菜单（`SmartPanel` / `SidebarContextMenus`）：**存在断层 (B)**，受历史 14px $\to$ 12px Token 变更影响，普遍残留 -2px 同心偏差；
   - 底部用户卡片（`UserProfileCard`）：**形态失配 (C+)**，内圆角 13px 反超外圆角 7px，且两轴边距不对称。
2. **下一步落地输入**：
   本报告已完整提供全仓侧栏与顶栏各容器的精确位置、代数差值与几何诊断，将直接作为下一步统一编写同心圆角自动化校验门禁（`motion-concentric-contract.test.ts` 扩展）与样式收敛计划（Plan）的不可辩驳的物理证据。
