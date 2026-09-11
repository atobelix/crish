# 全局侧栏与全屏/弹窗设置布局调研报告

> **战役工作区**：`docs/layout-token-system/survey/`
> **调研岗位**：全局侧栏与全屏/弹窗设置布局调研员
> **归属任务**：系统性 Token 体系建设战役（第一阶段 · 调研维度 07）
> **调研对象**：Conex / Crish 桌面端全局侧栏（Sidebar）、会话列表（SidebarSessionList）、侧栏导航（SidebarNav）、全屏设置面板（SettingsPanel）以及设置通用排版组件（SettingsUI）。

---

## 一、调研背景与输入证据源

在桌面端应用架构中，全局侧栏与全屏设置面板是视口顶级壳层（Shell）之下最核心的导航与配置容器。它们直接承载了用户的日常会话切换、快捷操作、搜索筛选以及系统全量参数配置。然而，随着桌面端功能演进，侧栏与设置面板在内外部边距阶梯、滚动容器边界、组件内部对齐以及跨层边距传递上积累了大量微米级微调补丁与硬编码魔术数值。

### 1.1 核心输入源码文件

本次全景调研严格基于以下关键源码与样式契约展开核查：
1. `apps/crish-desktop/src/components/sidebar/Sidebar.module.css`（全局侧栏根容器、头部避让、滚动槽、底栏）
2. `apps/crish-desktop/src/components/sidebar/Sidebar.tsx` / `SidebarHeader.tsx`（侧栏宿主与头部 DOM 结构）
3. `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css`（会话分组、虚拟化/流式列表项、胶囊项微距）
4. `apps/crish-desktop/src/components/sidebar/SidebarNav.module.css` / `SidebarNav.tsx`（顶部快捷操作、搜索框透明形态 ①）
5. `apps/crish-desktop/src/components/settings/SettingsPanel.module.css`（全屏设置 Cover、36px 顶栏、双列主体、内容区）
6. `apps/crish-desktop/src/components/settings/SettingsPanel.tsx` / `SettingsSidebar.tsx`（设置壳层逻辑、Wheel 事件拦截、侧栏导航）
7. `apps/crish-desktop/src/components/settings/SettingsUI.module.css` / `SettingsUI.tsx`（设置通用 Page、Section、Card、Row 容器阶梯）
8. `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` / `ModelsSettingsTab.tsx`（模型管理页视口型工作台特化）
9. `apps/crish-desktop/src/styles/tokens.css`（全局 Design Tokens 定义）

---

## 二、侧边栏（Sidebar）垂直节奏与微米级内边距解构

全局侧栏采用两阶段弹性盒模型，从上至下依次由「硬件级顶栏避让区」、「顶部快捷导航与搜索区」、「会话滚动展示区」以及「底部个人资料卡片区」四段垂直堆叠组成。

```
┌──────────────────────────────────────────────────────────┐  ▲
│ .sidebarHeaderBar (height: 36px, padding: 0 10px)        │  │ 36px 硬件标题栏避让
├──────────────────────────────────────────────────────────┤  ▼
│ .sidebarTop (padding: 4px 10px 0 10px)                   │  ▲
│   └─ .topActions (gap: 4px)                              │  │ 快捷区 + 搜索框
│       ├─ [新对话] (height: 32px, padding: 0 8px)         │  │ (形态 ① 无边框设计)
│       ├─ [定时任务] (height: 32px, padding: 0 8px)       │  │
│       └─ [搜索框] (height: 32px, padding: 0 8px)         │  ▼
├──────────────────────────────────────────────────────────┤  ▲
│ .sidebarScroll (padding: 10px 2px 14px 8px; gap: 14px)   │  │
│   ├─ [置顶会话分组]                                       │  │
│   │   └─ .sessionItem (height: 28px, padding: 0 4px 0 10px)│ 独立滚动区 (flex: 1)
│   └─ [项目/全部会话分组]                                  │  │ (右留白 2px 护航滚动条)
│       └─ .sessionItem (height: 28px, padding: 0 4px 0 10px)│  │
├──────────────────────────────────────────────────────────┤  ▼
│ .sidebarFooter (padding: 4px 10px 8px 10px; gap: 8px)    │  ▲ 底部卡片区
│   ├─ .userProfileCard (padding: 4px 8px)                 │  │ (height: ~48px)
│   └─ .footerGearCol (设置齿轮)                            │  ▼
└──────────────────────────────────────────────────────────┘
```

### 2.1 头部 36px 硬件避让与双轨实现

在桌面端（Tauri）宿主环境下，窗口顶部必须留出与操作系统标题栏完全一致的拖拽区与控制区避让空间：

1. **绝对定位浮动开关 vs 占位拖拽行**：
   - 在 [`apps/crish-desktop/src/components/sidebar/Sidebar.module.css:33-50`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L33-L50) 中，定义了旧版或脱离文档流的 `.sidebarHeader`：
     ```css
     .sidebarHeader {
       position: absolute;
       top: 0;
       left: 0;
       width: 52px;
       height: var(--header-height, 36px);
       min-height: var(--header-height, 36px);
       display: flex;
       align-items: center;
       padding: 0 10px;
       box-sizing: border-box;
       flex-shrink: 0;
       z-index: calc(var(--z-sidebar, 100) + 1);
       -webkit-app-region: no-drag !important;
     }
     ```
   - 在 [`Sidebar.module.css:53-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L53-L65) 中，引入了整行语义化容器 `.sidebarHeaderBar`：
     ```css
     .sidebarHeaderBar {
       width: 100%;
       height: var(--header-height, 36px);
       min-height: var(--header-height, 36px);
       display: flex;
       align-items: center;
       justify-content: space-between;
       padding: 0 10px;
       box-sizing: border-box;
       flex-shrink: 0;
       -webkit-app-region: drag;
     }
     ```
   - **macOS 交通灯红绿灯硬避让**：在 [`Sidebar.module.css:83-86`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L83-L86) 中，专门针对 macOS 平台注入了强约束规则：
     ```css
     .sidebarHeader[data-mac='true'] {
       width: 106px;
       padding-left: 70px;
     }
     ```
     这里的 `padding-left: 70px` 物理避开了 macOS 左上角原生「关闭/最小化/缩放」三色交通灯按钮的 70px 占用区。

2. **设计逻辑与问题**：
   - 头部高度严格绑定 `--header-height: 36px`，确保侧边栏收起/展开时，主聊天窗口视口和侧栏顶部的分界水平线与整个桌面窗口的 36px 标题栏绝对齐平。
   - 但是，代码中同时存在绝对定位浮动开关（`.sidebarHeader`）和整行占位容器（`.sidebarHeaderBar`），两者 padding 均为 `0 10px`，缺乏统一的 `--sidebar-header-*` 布局 Token，使得避让逻辑依赖手写常量。

### 2.2 顶部快捷区与搜索输入框包装器

紧随 36px 顶栏之后的是 `.sidebarTop` 容器：
- 在 [`Sidebar.module.css:88-93`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L88-L93)：
  ```css
  .sidebarTop {
    padding: 4px 10px 0 10px;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  ```
- 内部子组件 `SidebarNav` 在 [`SidebarNav.module.css:1-8`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L1-L8) 中定义了垂直堆叠流：
  ```css
  .topActions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 0;
    padding-left: 0;
    padding-right: 0;
  }
  ```
- 包含三项：「新对话」按钮、「定时任务」按钮与「会话搜索框」。三者统一赋予 `.navItem` 样式契约（[`SidebarNav.module.css:10-38`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L10-L38)）：
  - 按钮高度：`height: var(--control-height); min-height: var(--control-height);`（通常为 32px）
  - 内边距：`padding: 0 8px;`
  - 圆角：`border-radius: var(--radius-lg);`（8px）
  - 间距：`gap: var(--space-2);`（8px 图标与文字间距）
  - 搜索框特化形态（**形态 ①：侧边栏无边框透明纯净型**，[`SidebarNav.module.css:79-108`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L79-L108)）：
    ```css
    .navItem[role='search'] {
      cursor: text;
      background: transparent;
      border: none;
      box-shadow: none;
    }
    .navItem[role='search']:hover,
    .navItem[role='search']:focus-within {
      background: var(--sidebar-hover);
      border: none;
      box-shadow: none;
    }
    ```
- **搜索输入框包装器的跨模块对比**：
  在设置面板侧栏中，同形态搜索框包装器（[`SettingsPanel.module.css:108-126`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L108-L126)）使用了显式外边距：
  ```css
  .searchWrap {
    margin: var(--space-1, 4px) 0 var(--space-2, 8px);
    padding: 0 8px;
    height: var(--control-height, 32px);
  }
  ```
  而在主侧栏中，搜索框被直接纳入 `gap: 4px` 的 flex 垂直流中，外部由 `.sidebarTop` 的 `padding: 4px 10px 0 10px` 提供左右对齐。这种微观排版虽然视觉接近，但底层一个靠 `gap` 一个靠 `margin: 4px 0 8px`，暴露了缺乏共享布局类与统一定义的现状。

### 2.3 会话滚动区 `padding: 10px 2px 14px 8px;` 的微米级排版哲学

会话列表滚动槽 `.sidebarScroll` 的内边距是经过多轮界面实测后锁定的高敏感几何契约：
在 [`Sidebar.module.css:95-106`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L95-L106) 中：
```css
.sidebarScroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 2px 14px 8px; /* 收紧右侧留白至 2px，左侧与顶栏中轴对齐 */
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0; /* Enable flex-1 scrolling */
  contain: layout paint;
  transform: translateZ(0);
}
```

深入剖析该 `padding: 10px 2px 14px 8px;`（上 10px、右 2px、下 14px、左 8px）背后的布局事实依据：

1. **顶部 10px 垂直呼吸分割**：
   - 顶部 `.sidebarTop` 包含「新对话」、「定时任务」与「搜索框」，最后一行搜索框底部无 extra margin。若紧贴会话滚动区，首个分类标签（如「置顶」或「全部会话」）会与搜索框产生压迫感。10px 的顶留白精准构建了「静态控制区」与「动态内容流」的视觉阶梯。
2. **底部 14px 滚动回弹缓冲**：
   - 列表项滚动到底部时，如果底部留白过小（如 0 或 4px），最后一个会话卡片会紧贴底部个人中心卡片（`sidebarFooter`），产生视觉切断感。14px 保证了滚动到底部时留出自然的空隙。
3. **左侧 8px 绝对中轴对齐**：
   - 观察父级与平级容器的左边距阶梯：
     - 头部 `.sidebarHeaderBar`：`padding: 0 10px;`，折叠按钮 `.sidebar-toggle-btn` 自身带有内边距；
     - 顶部操作区 `.sidebarTop`：`padding: 4px 10px 0 10px;`；内部 `.navItem` 的 `padding: 0 8px;`，图标宽度 16px，左边缘距离侧栏容器左壁总距离为：$10\text{px} + 8\text{px} = 18\text{px}$；
     - 会话滚动区 `.sidebarScroll`：`padding-left: 8px;`；
     - 内部会话项 `.sessionItem`（[`SidebarSessionList.module.css:307-331`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L307-L331)）：
       `padding: 0 4px 0 10px;`，文字/图标起始距离为：$8\text{px} + 10\text{px} = 18\text{px}$！
     - **事实结论**：左侧 8px 搭配子项 `padding-left: 10px`，与上方快捷按钮的 `10px + 8px` 实现了物理几何上的**完全等值对齐（18px 绝对对齐线）**。
4. **右侧 2px 极窄留白防遮挡滑块**：
   - Windows 平台及 WebKit 默认滚动条宽度通常为 6px–10px，贴靠在滚动容器的最右侧内壁。
   - 如果右侧内边距设为对称的 8px 或 10px，滚动条会浮在右内壁向内缩进的位置，与会话胶囊项右侧产生巨大空洞；
   - 会话胶囊项 `.sessionItem` 内部包含右侧绝对定位的操作按钮 `.sessionActionsBtn`（width: 24px, right: 0，[`SidebarSessionList.module.css:478-504`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L478-L504)）与时间戳 `.sessionTime`（right: 0，[`SidebarSessionList.module.css:458-476`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L458-L476)）；
   - 将右侧留白收窄至 2px 时，滚动条紧靠容器右边缘渲染，与 `.sessionItem`（具有 `padding-right: 4px`）之间形成仅约 2px 的极微缝隙，既保证鼠标在悬停和点击会话右侧「...」操作按钮时不会误触发滚动条拖拽，又防止了滚动条滑块遮挡会话操作触发点与时间戳，同时最大限度拓宽了会话标题的文本截断阈值。

### 2.4 侧栏底部个人中心与设置入口

- 在 [`Sidebar.module.css:108-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L108-L118) 中：
  ```css
  .sidebarFooter {
    padding: 4px 10px 8px 10px;
    border-top: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    background: transparent;
    box-sizing: border-box;
    min-height: 0;
  }
  ```
- 包含两个并列列：
  - 左列 `.footerUserCol`（flex: 1）：承载 `.userProfileCard`（`padding: 4px 8px; border-radius: var(--button-radius, 8px);`）；
  - 右列 `.footerGearCol`（flex-shrink: 0）：承载设置齿轮按钮（`gap: var(--space-1_5);`）。

---

## 三、全屏设置面板（SettingsPanel）双列架构

全屏设置面板是一个完全接管应用视口的全屏模态层（通过覆盖根布局），其设计语言与主界面的侧栏+主对话工作区保持同构。

```
┌────────────────────────────────────────────────────────────────────────┐  ▲
│ .coverHeader (height: 36px, padding: 0 12px; -webkit-app-region: drag)  │  │ 36px 顶栏
│ └─ .coverHeaderSpacer (flex: 1) ─────────── [最小化][最大化][关闭(Esc)]│  ▼
├──────────────────────────┬─────────────────────────────────────────────┤  ▲
│ .coverNav (width: 240px) │ .coverContent (flex: 1, min-width: 0)       │  │
│ padding: 8px 10px        │ 常规: padding: 24px 32px 32px; gap: 14px    │  │
│                          │ 模型: padding: 20px 32px 24px;              │  │
│ ├─ .sidebarTopActions    │                                             │  │
│ │   ├─ [返回应用 (Esc)]   │ ┌─────────────────────────────────────────┐ │  │
│ │   └─ .searchWrap       │ │ .settingsUiPage                         │ │  │
│ ├─ .navScroll (flex: 1)  │ │ (max-width: 820px, padding-bottom: 24px)│ │  │
│ │   ├─ .navGroup (10px)  │ │ ├─ .settingsUiPageHead                  │ │  │
│ │   └─ .sidebarTab (32px)│ │ └─ .settingsUiPageBody (gap: 20px)       │ │  │
│ └─ <SidebarFooter />     │ └─────────────────────────────────────────┘ │  │
└──────────────────────────┴─────────────────────────────────────────────┘  ▼
```

### 3.1 顶层全屏容器与遮罩管理

1. **`.settingsCover` 视口脱离与包含块生成**：
   在 [`apps/crish-desktop/src/components/settings/SettingsPanel.module.css:8-21`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L8-L21) 中：
   ```css
   .settingsCover {
     position: fixed;
     inset: 0;
     width: 100vw;
     height: 100vh;
     display: flex;
     flex-direction: column;
     background: var(--bg-workspace, var(--bg-primary));
     color: var(--text-primary);
     font-family: var(--font-sans);
     pointer-events: auto;
     isolation: isolate;
     overflow: hidden;
   }
   ```
   - `position: fixed; inset: 0;` 将其直接提升为最高层级的独立视口图层；
   - `isolation: isolate;` 建立了独立堆叠上下文，防止内部任何 Popper、Dropdown 或 Tooltip 的 `z-index` 污染到底层的工作区。
2. **内部包装器 `.settingsPanel` / `.settingsDialogBody`**：
   在 [`SettingsPanel.module.css:23-34, 359-372`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L23-L34)：
   承接 Dialog 内部的 flex 垂直流，占满 100% 高度与宽度，`min-height: 0; overflow: hidden;`。

### 3.2 顶栏操作区 `.coverHeader`（36px 硬件对齐）

在 [`SettingsPanel.module.css:37-50`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L37-L50) 中：
```css
.coverHeader {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2, 8px);
  height: var(--header-height, 36px);
  min-height: var(--header-height, 36px);
  padding: 0 var(--space-3, 12px);
  background: var(--bg-workspace, var(--bg-primary));
  flex-shrink: 0;
  box-sizing: border-box;
  -webkit-app-region: drag;
}
```
- **核心职能**：
  - `height: 36px` 与主应用标题栏（TitleBar）完全相同；
  - `-webkit-app-region: drag` 使得全屏设置页展开后，顶部 36px 区域依然具备原生桌面窗口的抓取与拖拽移动能力；
  - 右侧嵌入 `<WindowControls onClose={onClose} />`，保留系统窗口控制（最小化、最大化、关闭/返回）。

### 3.3 双列主体 `.coverBody`

在 [`SettingsPanel.module.css:224-234`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L224-L234) 中：
```css
.coverBody {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
  margin: 0;
  padding: 0;
  gap: 0;
  background: var(--bg-workspace, var(--bg-primary));
  overflow: hidden;
}
```
通过零间距、零内边距的横向 Flex 容器，将视口垂直扣除 36px 后的剩余高度无损分配给左侧导航与右侧内容区。

### 3.4 专属侧栏导航 `.coverNav`（240px）

在 [`SettingsPanel.module.css:237-250`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L237-L250) 中：
```css
.coverNav {
  width: var(--settings-sidebar-width, 240px);
  flex-shrink: 0;
  height: 100%;
  background: var(--bg-workspace, var(--bg-primary));
  padding: 8px 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0;
}
```
其内部排版结构与尺寸链如下：
1. **顶部操作区 `.sidebarTopActions`**（[`SettingsPanel.module.css:85-90`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L85-L90)）：
   - `display: flex; flex-direction: column; gap: var(--space-1_5, 6px); margin-bottom: var(--space-1, 4px);`
   - 「返回应用」按钮 `.sidebarBackBtn`：高度 32px，圆角 8px；
   - 搜索输入框包装器 `.searchWrap`（[`SettingsPanel.module.css:108-126`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L108-L126)）：
     ```css
     .searchWrap {
       width: 100%;
       height: var(--control-height, 32px);
       min-height: var(--control-height, 32px);
       box-sizing: border-box;
       margin: var(--space-1, 4px) 0 var(--space-2, 8px);
       padding: 0 8px;
       border-radius: var(--radius-lg, 8px);
       background: transparent;
       border: none;
       box-shadow: none;
     }
     ```
2. **中间分类列表 `.navScroll`**（[`SettingsPanel.module.css:207-215`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L207-L215)）：
   - `flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0; gap: var(--space-0_5, 2px);`
   - 分组标签 `.navGroup`：`padding: 10px 10px 4px; font-size: 11px;`
   - 单个 Tab 项 `.sidebarTab`（[`SettingsPanel.module.css:295-315`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L295-L315)）：
     - `padding: 6px 10px; min-height: 32px; gap: var(--space-2, 8px); border-radius: var(--radius-lg, 8px);`
     - 激活态 `.sidebarTab.active`：`background: var(--bg-card); border: 1px solid var(--border-subtle); box-shadow: var(--shadow-sm);`（微浮起白卡质感）。
3. **底部用户信息与系统状态**：
   在 [`SettingsSidebar.tsx:197`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L197) 中，直接复用了主侧栏的 `<SidebarFooter />`，保证在设置页面内也能随时观察当前账号与版本更新提示。

### 3.5 主内容功能区 `.coverContent`

在 [`SettingsPanel.module.css:261-281`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L261-L281) 中：
```css
.coverContent {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  margin: 0;
  border-radius: var(--radius-lg) 0 0 0;
  border: none;
  box-shadow: none;
  padding: 24px 32px 32px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3_5, 14px);
  position: relative;
  background: var(--bg-elevated, var(--bg-card));
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: auto;
  contain: strict;
  align-items: stretch;
}
```
- **视觉契约**：
  - `border-radius: var(--radius-lg) 0 0 0;`：左上角单侧圆角（8px–12px），在左侧平坦深色导航（`--bg-workspace`）与右侧明亮主内容卡底（`--bg-elevated`）之间形成精致的内嵌纸面边缘；
  - `contain: strict;`：将内容区域的布局、重绘与尺寸完全隔离，阻止设置页内部大量的复杂表单、开关、输入框引起全屏重排。

---

## 四、设置内容区内边距割裂与滚动容器双轨约束

设置面板内部最尖锐的布局断层，发生于「常规文档流 Tab」与「模型管理 Models Tab」之间。两者在内边距几何与滚动容器管线上存在彻底的分化。

### 4.1 常规 Tab 与 Models Tab 的属性矩阵对比

| 布局属性 / 行为 | 常规设置 Tab（Profile, Appearance, Personalize, etc.） | 模型设置 Tab（ModelsSettingsTab） | 割裂事实与冲突影响 |
| :--- | :--- | :--- | :--- |
| **容器内边距** | `padding: 24px 32px 32px;` (`SettingsPanel.module.css:270`) | `padding: 20px 32px 24px;` (`SettingsPanel.module.css:292`) | 顶部差 4px、底部差 8px。切换 Tab 时内容容器发生跳动 |
| **容器溢出行为** | `overflow-y: auto; overflow-x: hidden;` | `overflow: hidden;` | 常规 Tab 依赖外层滚动；Models Tab 强制抹除外层滚动 |
| **越界动量行为** | `overscroll-behavior: auto;` | `overscroll-behavior: none;` | Models Tab 必须强行锁死任何向外传播的滑轮物理动量 |
| **滚动条宿主** | `.coverContent` 本身产生右侧主滚动条 | 外层无滚动条，由内部 `.mrlList` 与 `.modelsDetail` 各自滚动 | 滚动条位置从视口最右侧突变到卡片内部的分栏右侧 |
| **子组件高度契约** | 流式自适应高度，底部有 `padding-bottom: 24px` | 强制 `height: 100%; flex: 1 1 0; min-height: 0;` | 必须挂载 `.fillViewport` 与 `.fillViewportBody` |
| **最大宽度限制** | `max-width: var(--settings-content-max, 820px);` | 占满 100% 容器宽度（不受 820px 限制） | 宽度策略断裂（居中文档流 vs 撑满视口分栏流） |

### 4.2 Models Tab 的视口型双栏工作台架构

为什么 Models Tab 必须强行覆盖 `.coverContent` 的默认规则？
查看 [`ModelsSettingsTab.tsx:400-463`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx#L400-L463) 与 [`ModelsSettingsTab.module.css:8-33`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L8-L33)：

```tsx
<SettingsPage title="模型" meta={headerMeta} fillViewport>
  {/* 顶部固定行：全局默认模型 */}
  <div style={{ flexShrink: 0 }}>
    <SettingsSection title="默认模型">
      <SettingsCard><SettingsRow ... /></SettingsCard>
    </SettingsSection>
  </div>

  {/* 核心双栏分栏卡片 */}
  <div className={`${styles.modelsSplit} models-split`}>
    <ModelProfileList ... />   {/* 左侧服务商导轨 .modelsRail (210px) */}
    <ModelConfigEditor ... />  {/* 右侧详情工作台 .modelsDetail (flex: 1) */}
  </div>
</SettingsPage>
```

1. **工作台物理高度必须撑满**：
   - 模型页不是简单的只读长表单，而是一个类似 IDE 的双栏管理器：左侧是服务商列表（可能多达 20+ 个），右侧是该服务商下的模型树（可能包含 50+ 个模型的勾选、测试与参数编辑）。
   - 如果允许外层 `.coverContent` 滚动，用户在右侧滚动模型列表时，极易因滑轮越界带动整个页面上下位移，导致顶部的服务商列表和标题整体被滚出视口。
2. **双重内部滚动槽**：
   - 左侧 `.mrlList`（[`ModelsSettingsTab.module.css:56-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L56-L65)）：`overflow-y: auto; overscroll-behavior: contain; padding: 8px; gap: 4px;`
   - 右侧 `.modelsDetail`（[`ModelsSettingsTab.module.css:127-138`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L127-L138)）：`overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px;`
   - 两侧互不干扰，各自拥有独立的滚动边界。

### 4.3 滚动边界混淆与 JS 事件补偿补丁

由于 CSS 层面没有针对「文档型 Tab」与「工作台型 Tab」提供正交的容器抽象，导致两者共享同一个 `<div className={styles.coverContent}>` 节点。这直接在运行时引发了滚动冲突，迫使宿主组件在 TSX 中书写补丁代码：

在 [`apps/crish-desktop/src/components/settings/SettingsPanel.tsx:215-243`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.tsx#L215-L243) 中：
```typescript
const handleRootWheel = (e: React.WheelEvent) => {
  // 【Task-E 核心阻断 1】：模型工作区等视口型 Tab 硬性拦截，严禁以任何 JS 形式篡改 scrollTop
  if (safeActiveTab === 'models') {
    return;
  }

  if (contentAreaRef.current) {
    const target = e.target as HTMLElement;

    // 文本输入框、代码块与下拉框原生自滚动，豁免外层干预
    if (
      target.closest('textarea') ||
      target.closest('pre') ||
      target.closest('select')
    ) {
      return;
    }

    // 【Task-E 核心阻断 2】：修复内边距空白误判导致的 2x 双倍速狂飙滚动
    // 只要 target 属于 contentAreaRef.current（包括自身内边距空白区及其所有子元素），
    // 100% 交由浏览器原生渲染管线接管，JS 不得叠加 scrollTop！
    if (contentAreaRef.current.contains(target)) {
      return;
    }

    // 仅当用户在侧栏空白处、顶栏拖拽条空白处滚动时，才辅助滚动常规设置页
    contentAreaRef.current.scrollTop += e.deltaY;
  }
};
```

**问题根因分析**：
- 为什么会出现“双倍速狂飙滚动”？因为在早期实现中，当鼠标悬浮在 `.coverContent` 的 `padding: 24px 32px 32px` 空白边缘时，浏览器原生会触发一次滚动；同时，顶层的 `onWheel={handleRootWheel}` 又捕获到了该事件，并在 JS 中执行了 `scrollTop += e.deltaY`，导致一次滚轮转动叠加了两次位移！
- 根因在于没有从容器架构上将「可滚动的长文档容器」与「全屏固定的视口工作台」解耦，只能依赖脆弱的事件捕获与硬编码 `contains` 判断进行防守。

---

## 五、从祖父级 Cover 到底层表单项的边距传递链

为了查明跨层边距累加如何影响最终的视觉间距，我们建立从最外层视口直到底层表单原子控件的完整传递拓扑链。

### 5.1 8 级容器级联拓扑链

```
Level 0: .settingsCover (全屏视口，100vw × 100vh)
  │
  ├─ Level 1: .coverBody (flex: 1, min-height: 0, gap: 0, margin: 0, padding: 0)
  │    │
  │    ├─ Level 2: .coverContent (flex: 1, min-width: 0, background: --bg-elevated)
  │    │    │      常规: padding: 24px 32px 32px; gap: 14px;
  │    │    │      模型: padding: 20px 32px 24px;
  │    │    │
  │    │    └─ Level 3: .settingsUiPage (width: 100%, max-width: 820px, margin: 0 auto)
  │    │         │      padding-bottom: 24px; gap: 16px;
  │    │         │
  │    │         ├─ .settingsUiPageHead (margin: 0, padding: 0 2px)
  │    │         │    └─ .settingsUiHeadInline (gap: 12px)
  │    │         │         └─ .settingsUiPageTitle (font-size: 20px, line-height: dense)
  │    │         │
  │    │         └─ Level 4: .settingsUiPageBody (gap: 20px)
  │    │              │
  │    │              └─ Level 5: .settingsUiSection (gap: 8px)
  │    │                   │
  │    │                   ├─ .settingsUiSectionTitle (margin: 0, padding: 0 4px, font-size: 12px)
  │    │                   │
  │    │                   └─ Level 6: .settingsUiSectionContent (gap: 12px)
  │    │                        │
  │    │                        └─ Level 7: .settingsUiCard (border-radius: 12px, border: 0.1px)
  │    │                             │
  │    │                             └─ Level 8: .settingsUiRow (padding: 10px 14px, gap: 12px)
  │    │                                  │
  │    │                                  ├─ .settingsUiRowIcon (flex-shrink: 0)
  │    │                                  ├─ .settingsUiRowBody (flex: 1, gap: 4px)
  │    │                                  │    ├─ .settingsUiRowTitle (font-size: 14px)
  │    │                                  │    └─ .settingsUiRowDesc (font-size: 13px)
  │    │                                  └─ .settingsUiRowControl (gap: 12px)
  │    │                                       └─ 原子控件: .controlInput / .controlSelect / Switch
```

### 5.2 边距累加与几何间距事实测算

以常规设置页中的一个普通文本输入框为例，测算其距离视口边缘与卡片边缘的实际累计间距：

1. **水平方向边距传递**：
   - 视口左边界到 `.coverNav` 右边界：$240\text{px}$（侧栏固定占用）；
   - `.coverNav` 右边界到 `.coverContent` 内容起始线：$32\text{px}$（`padding-left: 32px`）；
   - `.settingsUiPage` 处于居中对齐态（`margin: 0 auto`，`max-width: 820px`）：
     - 当窗口宽度为 $1400\text{px}$ 时，`.coverContent` 可用宽度为 $1400 - 240 = 1160\text{px}$；
     - 去除内边距后的净内容宽度为 $1160 - (32 \times 2) = 1096\text{px}$；
     - `.settingsUiPage` 两侧自动外边距各为 $(1096 - 820) / 2 = 138\text{px}$；
   - 卡片内部内边距：`.settingsUiRow` 具有 `padding: 10px 14px;`；
   - 控件自身距离卡片内部左边缘距离：$14\text{px}$（若为 RowBody 文字）或位于右侧（靠靠右对齐）。
2. **垂直方向边距传递与空间稀疏度**：
   从顶部 36px 硬件栏到底部首个输入控件的垂直空间累加如下：
   - 硬件顶栏：$36\text{px}$；
   - 内容区顶内边距：$24\text{px}$（`coverContent.padding-top`）；
   - 页面根间距：$16\text{px}$（`settingsUiPage.gap: 16px`）；
   - 页面主标题高度与行高：约 $24\text{px}$；
   - 主体垂直间距：$20\text{px}$（`settingsUiPageBody.gap: 20px`）；
   - 分组标题外边距与文字：约 $20\text{px}$；
   - 分组内部间距：$8\text{px}$（`settingsUiSection.gap: 8px`）；
   - 卡片行内边距：$10\text{px}$（`settingsUiRow.padding-top: 10px`）；
   - **累计垂直避让高度**：$36 + 24 + 16 + 24 + 20 + 20 + 8 + 10 = 158\text{px}$。
   用户必须在垂直向下凝视近 160px 后，才能看到第一个实际可操作的表单控件。这种多层 gap 与 padding 的机械嵌套，在较小笔记本屏幕（如 1366×768 或 1280×800）下造成了严重的垂直空间浪费。

---

## 六、Token 体系现状审计与工业级缺位盘点

经过对全局 CSS 文件的穷举扫描，我们发现当前代码库在侧栏与设置面板的 Token 体系建设上存在显著的结构性断层。

### 6.1 `--settings-*` 命名空间贫瘠与数值漂移

全局仅检索到两组以 `--settings-` 开头的 Token：

1. **`--settings-sidebar-width`**：
   - `tokens.css:394`：`--settings-sidebar-width: 240px;`（默认基线）
   - `tokens.css:1224`：`--settings-sidebar-width: 220px;`（compact 模式）
   - `tokens.css:1281`：`--settings-sidebar-width: 260px;`（comfortable 模式）
   - 评价：该 Token 建立了良好的响应式分级，已被 `SettingsPanel.module.css:238` 消费。
2. **`--settings-content-max` 的严重撕裂**：
   - 在 `tokens.css:698` 中定义为：`--settings-content-max: 720px;`
   - 在 `SettingsUI.module.css:6` 的兜底规则中写为：`max-width: var(--settings-content-max, 820px);`
   - 在 `SkillsSettingsTab.module.css:8` 的兜底规则中写为：`max-width: var(--settings-content-max, 720px);`
   - **事实证据**：同一个语义概念「设置主内容最大宽度」，在通用组件库中是 820px，而在 Skills 插件页面中是 720px，全局全局 tokens 又是 720px！产生了整整 100px 的视觉跳动与认知分歧。

### 6.2 严重缺乏的布局 Token 清单

除上述两个变量外，目前侧栏与设置面板中大量关键布局参数全部处于**硬编码裸数值**状态：

| 物理布局属性 | 当前实际硬编码数值 | 出现位置（文件:行号） | 建议的语义化 Token 契约 |
| :--- | :--- | :--- | :--- |
| **侧栏顶部避让** | `36px` | `Sidebar.module.css:38, 55` | `--sidebar-header-height: var(--header-height, 36px);` |
| **侧栏顶部内边距** | `4px 10px 0 10px` | `Sidebar.module.css:89` | `--sidebar-top-padding: 4px 10px 0 10px;` |
| **侧栏快捷项间距** | `4px` | `SidebarNav.module.css:4` | `--sidebar-nav-gap: var(--space-1, 4px);` |
| **会话滚动区内边距**| `10px 2px 14px 8px` | `Sidebar.module.css:98` | `--sidebar-scroll-padding: 10px 2px 14px 8px;` |
| **会话分组大间距** | `14px` | `Sidebar.module.css:101` | `--sidebar-group-gap: var(--space-3_5, 14px);` |
| **会话卡片项高度** | `28px` | `SidebarSessionList.module.css:296, 311` | `--sidebar-session-item-height: 28px;` |
| **会话胶囊纵向微距**| `3px` | `SidebarSessionList.module.css:286` | `--sidebar-session-gap: 3px;` |
| **设置顶栏高度** | `36px` | `SettingsPanel.module.css:42` | `--settings-header-height: var(--header-height, 36px);` |
| **设置导航内边距** | `8px 10px` | `SettingsPanel.module.css:243` | `--settings-nav-padding: 8px 10px;` |
| **设置搜索外边距** | `4px 0 8px` | `SettingsPanel.module.css:117` | `--settings-search-margin: 4px 0 8px;` |
| **常规内容区内边距**| `24px 32px 32px` | `SettingsPanel.module.css:270` | `--settings-content-padding: 24px 32px 32px;` |
| **模型内容区内边距**| `20px 32px 24px` | `SettingsPanel.module.css:292` | `--settings-workbench-padding: 20px 32px 24px;` |
| **内容区纵向间距** | `14px` | `SettingsPanel.module.css:273` | `--settings-content-gap: var(--space-3_5, 14px);` |
| **设置区块间距** | `20px` | `SettingsUI.module.css:53` | `--settings-section-gap: var(--space-5, 20px);` |
| **设置卡片行内边距**| `10px 14px` | `SettingsUI.module.css:93` | `--settings-row-padding: 10px 14px;` |
| **卡片超细微边框** | `0.1px solid` | `SettingsUI.module.css:80` | `--settings-card-border: 1px solid var(--border-subtle);` |

> [!WARNING]
> **关于 0.1px 亚像素边框的潜在渲染隐患**：
> 在 [`SettingsUI.module.css:80`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.module.css#L80) 中，存在 `border: 0.1px solid hsl(35 10% 95%);`。在不同 DPI 缩放（如 Windows 125%、150% 或 175% 缩放比例）以及不同的 WebView2 / Chromium 渲染管线下，`0.1px` 会导致极其严重的边框缺失、虚化或边缘断线现象，属于典型的魔术数值脆弱代码，必须由标准 Design Token 统一收敛为精确的 `1px` 或通过透明度与微弱阴影呈现。

---

## 七、调研结论与第二阶段方案实施指引

通过对 Sidebar 侧栏与 SettingsPanel 设置面板的全景调研，提炼出系统性 Token 体系建设战役第二阶段（方案制定与工程重构）的实施方向：

1. **构建三层 Token 架构中的「组件布局 Token（Component Layout Tokens）」**：
   - 严禁在 CSS Module 中直接裸写 `padding: 10px 2px 14px 8px` 或 `margin: 4px 0 8px` 等魔术数值；
   - 建立 `--sidebar-*` 与 `--settings-*` 专有布局 Token，由第二层语义 Token（`--space-*`、`--control-height`）派生，在 `tokens.css` 统一集中管理。
2. **消歧与收敛最大宽度 Token（`--settings-content-max`）**：
   - 统一全仓口径为单一数值（建议锁定为 800px 或 820px，提供更舒适的双列控件排版），同步修正 `tokens.css`、`SettingsUI.module.css` 与 `SkillsSettingsTab.module.css`，彻底消除 720px 与 820px 之间 100px 的视觉漂移。
3. **架构解耦：区分长文档设置（Document Settings）与视口工作台（Workbench Settings）**：
   - 将 `.coverContent` 的内边距与滚动策略进行语义化分型：
     - `data-layout-kind="document"`：外层承载滚动条，内边距采用 `--settings-content-padding: 24px 32px 32px`，居中限宽 820px；
     - `data-layout-kind="workbench"`：外层锁定 `overflow: hidden; overscroll-behavior: none;`，内边距采用 `--settings-workbench-padding: 20px 32px 24px`，宽度撑满 100%，由内部独立的 split 容器管理双列滚动；
   - 废除 `SettingsPanel.tsx` 中基于 `safeActiveTab === 'models'` 的硬编码 `handleRootWheel` 补丁，从容器层级契约上彻底杜绝事件拦截与“双倍速狂飙滚动”的架构断层。
4. **边距传递链扁平化与紧凑化（Compact Mode）支持**：
   - 梳理 Level 0 到 Level 8 的垂直间距总和（目前首个控件需 158px 避让），在紧凑模式下动态压缩 `settingsUiPageBody.gap`（20px $\to$ 14px）与 `coverContent.padding`（24px $\to$ 16px），大幅提升中小屏幕下的信息获取密度。
5. **消除 0.1px 魔术边框，回归原生规范**：
   - 彻底清理 `SettingsUI.module.css` 中的 `0.1px`，对齐仓库《严禁补丁、绕过与作弊》第 7 条军规，以原生精确、跨高分屏一致的 `1px` 搭配现代 `oklch` / `hsl(h s l / a)` 斜杠透明度实现柔和的高级卡片边缘。
