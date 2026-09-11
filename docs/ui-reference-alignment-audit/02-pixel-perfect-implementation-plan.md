# Conex / Crish — 全仓界面与交互极致像素级重构落地方案

> **文档版本**：v1.0 (Production Master Architecture Plan)
> **权威输出路径**：`docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md`
> **对齐资产**：
> 1. `reference/chat-composer-component/`（包含 `index.html`, `css/composer.css`, `js/popovers.js`, `css/flow/*.css`, `CONVERSATION_FLOW_SPEC.md`, `DESIGN_SYSTEM.md`）
> 2. `reference/smart-expandable-panel/`（包含 `css/tokens.css`, `css/panel.css`, `js/safe-aim.js`, `js/position-engine.js`, `react/SmartExpandablePanel.tsx`）
> 3. `reference/展开面板设计.html`
> 4. 用户高保真界面截图资产与真实设计需求
>
> **红线纪律**：严禁采用粗暴覆盖、魔术补偿或妥协式补丁代码；方案严格遵照纯逻辑规划、零退避原则，给出每一个组件的精准 TypeScript 契约、DOM 语义树、CSS 视觉规范与迁移路径。

---

## 目录

- [一、全局设计系统与架构基准（Design System Baseline）](#一全局设计系统与架构基准design-system-baseline)
  - [1.1 绝对零蓝色（Zero-Blue）与墨阶中性暖色调](#11-绝对零蓝色zero-blue与墨阶中性暖色调)
  - [1.2 数学同心圆角几何体系（Concentric Curvature Hierarchy）](#12-数学同心圆角几何体系concentric-curvature-hierarchy)
  - [1.3 空间层级与向下平滑淡隐遮罩（Fixed Sticky Fade Mask）](#13-空间层级与向下平滑淡隐遮罩fixed-sticky-fade-mask)
- [二、模块一：对话顶栏（Chat Top Header）极致对齐方案](#二模块一对话顶栏chat-top-header极致对齐方案)
  - [2.1 现状缺陷剖析与退役清单](#21-现状缺陷剖析与退役清单)
  - [2.2 三级面包屑导航（3-Level Breadcrumbs）](#22-三级面包屑导航3-level-breadcrumbs)
  - [2.3 右侧四元极简动作组（Top Actions）](#23-右侧四元极简动作组top-actions)
  - [2.4 DOM 结构树、TypeScript 契约与 CSS 完整规范](#24-dom-结构树typescript-契约与-css-完整规范)
- [三、模块二：右侧工作区面板（Side Panel）与 Tab 管理器](#三模块二右侧工作区面板side-panel与-tab-管理器)
  - [3.1 双层顶栏架构（Row 1: Tabs Header + Row 2: Navigation Toolbar）](#31-双层顶栏架构row-1-tabs-header--row-2-navigation-toolbar)
  - [3.2 标签栏（Tab Strip）与 13px 专属图标 / 16px 微型叉号](#32-标签栏tab-strip与-13px-专属图标--16px-微型叉号)
  - [3.3 双态加号智能切换机制（In-flow 随流 vs Pinned 固定）](#33-双态加号智能切换机制in-flow-随流-vs-pinned-固定)
  - [3.4 空态居中启动 Hub 卡片（Launcher Hub）](#34-空态居中启动-hub-卡片launcher-hub)
  - [3.5 DOM 结构树、TypeScript 契约与 CSS 完整规范](#35-dom-结构树typescript-契约与-css-完整规范)
- [四、模块三：输入区（Composer）四层垂直堆叠与墨绿圆形发送按钮](#四模块三输入区composer四层垂直堆叠与墨绿圆形发送按钮)
  - [4.1 四层空间垂直堆叠体系](#41-四层空间垂直堆叠体系)
  - [4.2 Layer 1：浮动权限审批条（Permission Bar）](#42-layer-1浮动权限审批条permission-bar)
  - [4.3 Layer 2：目标/计划模式进度条（Plan Progress Bar & Scrubber）](#43-layer-2目标计划模式进度条plan-progress-bar--scrubber)
  - [4.4 Layer 3：上下文与文件引用卡片区（Attachment Bar）](#44-layer-3上下文与文件引用卡片区attachment-bar)
  - [4.5 Layer 4：主输入区与墨绿色实体圆形发送按钮（[ 🟢 ⬆ ]）](#45-layer-4主输入区与墨绿色实体圆形发送按钮---)
  - [4.6 DOM 结构树、TypeScript 契约与 CSS 完整规范](#46-dom-结构树typescript-契约与-css-完整规范)
- [五、模块四：消息流（Message Stream）叙事层级与步骤卡片](#五模块四消息流message-stream叙事层级与步骤卡片)
  - [5.1 思考折叠条（Thinking Block）与双向平滑渐变遮罩](#51-思考折叠条thinking-block与双向平滑渐变遮罩)
  - [5.2 步骤进度里程碑（Plan Step & Milestone Spine）](#52-步骤进度里程碑plan-step--milestone-spine)
  - [5.3 子代理实时运行徽章（Subagent Live Capsule）](#53-子代理实时运行徽章subagent-live-capsule)
  - [5.4 代码产物胶囊与实时同步行（Artifact Chip & Sync Line）](#54-代码产物胶囊与实时同步行artifact-chip--sync-line)
  - [5.5 DOM 结构树、TypeScript 契约与 CSS 完整规范](#55-dom-结构树typescript-契约与-css-完整规范)
- [六、模块五：分屏模式下点击无响应的深层根因与架构根治](#六模块五分屏模式下点击无响应的深层根因与架构根治)
  - [6.1 事件竞争与状态机抢占根因分析（TreeLeafPanel.tsx）](#61-事件竞争与状态机抢占根因分析treeleafpaneltsx)
  - [6.2 根治方案：捕获穿透防护与冒泡阶段事件调度](#62-根治方案捕获穿透防护与冒泡阶段事件调度)
  - [6.3 验证断言与反回归测试用例设计](#63-验证断言与反回归测试用例设计)
- [七、模块六：SmartExpandablePanel 设计系统与全仓弹窗菜单改造](#七模块六smartexpandablepanel-设计系统与全仓弹窗菜单改造)
  - [7.1 单层纯色实体发丝边框与设计令牌（Design Tokens）](#71-单层纯色实体发丝边框与设计令牌design-tokens)
  - [7.2 Zero-Canvas SVG 多边形 Safe-Aim 轨迹保护引擎](#72-zero-canvas-svg-多边形-safe-aim-轨迹保护引擎)
  - [7.3 WAI-ARIA 全键盘漫游与双向级联导航协议](#73-wai-aria-全键盘漫游与双向级联导航协议)
  - [7.4 全仓弹窗菜单普查与重构对照表（5 大核心菜单）](#74-全仓弹窗菜单普查与重构对照表5-大核心菜单)
- [八、精准迁移实施步骤与文件变动矩阵（Step-by-Step Migration）](#八精准迁移实施步骤与文件变动矩阵step-by-step-migration)
  - [8.1 全仓组件文件变动矩阵](#81-全仓组件文件变动矩阵)
  - [8.2 6 阶段演进实施路线图](#82-6-阶段演进实施路线图)
  - [8.3 生产级验收门禁清单](#83-生产级验收门禁清单)

---

# 一、全局设计系统与架构基准（Design System Baseline）

## 1.1 绝对零蓝色（Zero-Blue）与墨阶中性暖色调

在整个界面的设计语言中，彻底废除传统 UI 中滥用的冷色调高饱和蓝色（如 `#0066cc`、`#3b82f6` 等）。
全仓统一采用**带有 10% CMYK 暖黄色相倾向的自然纸墨阶灰度体系**，配合高级中性黑、纯白以及特定业务语义的**翡翠绿（Emerald Accent）**。

| Token 变量 | 浅色主题值 (Light) | 深色主题值 (Dark) | 用途说明 |
|---|---|---|---|
| `--bg-page` | `#ffffff` | `#0c0c0b` | 页面基底底色 |
| `--bg-canvas` | `#f6f5f3` | `#141412` | 外围画布置灰底色 |
| `--bg-panel` | `rgba(255, 254, 252, 0.96)` | `rgba(24, 23, 21, 0.96)` | 浮层与工作区毛玻璃背景 |
| `--bg-item-hover` | `rgba(0, 0, 0, 0.04)` | `rgba(245, 244, 240, 0.06)` | 列表项与按钮悬浮微底色 |
| `--bg-item-active` | `rgba(0, 0, 0, 0.08)` | `rgba(245, 244, 240, 0.10)` | 按下与选中态底色 |
| `--text-primary` | `#111111` / `#1d1c1a` | `#f5f4f0` | 正文标题、高频文本 |
| `--text-secondary` | `#666666` / `#5c5954` | `#b5b2aa` | 辅助说明、状态文本 |
| `--text-tertiary` | `#999999` / `#8b8780` | `#78756d` | 分割符、未激活图标、占位符 |
| `--border-color` | `rgba(0, 0, 0, 0.08)` / `#e2dfd9` | `#2b2926` | 单层发丝边框，绝无双重模糊阴影 |
| `--brand-primary` / `--brand` | `#10b981` (HSL: 160° 84% 39%) | `#10b981` | 品牌高光绿、发送按钮、运行呼吸灯 |
| `--brand-deep` | `#059669` | `#059669` | 悬停态深绿、下划线超链接 |

## 1.2 数学同心圆角几何体系（Concentric Curvature Hierarchy）

严格对齐 `reference/smart-expandable-panel/css/tokens.css` 的**同心圆角几何体系（Concentric Curvature）**与自然幂律分布：

$$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 6\text{px})$$

```
+-------------------------------------------------------------------+  -- L1: Panel Shell (R_outer: 14px~16px)
|  Padding: 6px                                                     |
|  +-------------------------------------------------------------+  |  -- L2: Inner Container (R_inner: 8px~10px)
|  |  +-------------------------------------------------------+  |  |  -- L3: Item Row (R_item: 8px)
|  |  | [Icon 13px]  Title Text            [Badge (R: 4px)]   |  |  |
|  |  +-------------------------------------------------------+  |  |
|  +-------------------------------------------------------------+  |
+-------------------------------------------------------------------+
```

- **L1 级（外层浮动面板/卡片）**：`border-radius: 14px`（或 16px），内边距 `padding: 6px`；
- **L2 级（内部滚动容器/组块）**：`border-radius: 8px`（$14 - 6 = 8\text{px}$）；
- **L3 级（菜单项/交互行）**：`border-radius: 8px`，高度 28px，水平内边距 10px；
- **L4 级（小图标操作按钮）**：`border-radius: 6px`（24×24px 或 28×28px）；
- **L5 级（微型徽标/Tag）**：`border-radius: 4px`，高度 16px；
- **L6 级（实体状态胶囊 Pill）**：`border-radius: 9999px`；
- **L7 级（圆形动作按钮）**：`border-radius: 50%`（如 32×32px 墨绿色发送按钮）。

## 1.3 空间层级与向下平滑淡隐遮罩（Fixed Sticky Fade Mask）

对话顶栏采用 **38px 吸顶与负下边距（Negative Margin）方案**，绝不在 DOM 流中生硬挤占下层消息滚动的可见高度：

```css
.chat-top-header {
  position: sticky;
  top: 0;
  left: 0;
  width: 100%;
  height: 38px;
  min-height: 38px;
  margin-bottom: -38px; /* 负外边距：使得下方消息流平滑滚动到顶栏下方 */
  z-index: 10;
  pointer-events: none; /* 穿透空白区 */
  background: linear-gradient(
    to bottom,
    var(--bg-page, #ffffff) 0%,
    var(--bg-page, #ffffff) 65%,
    rgba(255, 255, 255, 0.94) 82%,
    rgba(255, 255, 255, 0.45) 94%,
    rgba(255, 255, 255, 0) 100%
  );
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  box-sizing: border-box;
}

.chat-top-left,
.chat-top-actions {
  pointer-events: auto; /* 仅按钮与交互区域接收鼠标事件 */
}
```

---

# 二、模块一：对话顶栏（Chat Top Header）极致对齐方案

## 2.1 现状缺陷剖析与退役清单

### 现状问题（`apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx`）：
1. **粗糙的 5 大产品功能按钮散落在顶栏**：`UNIT_TOOL_PANELS`（总览、文件、差异、终端、笔记）堆叠在右侧，破坏了对话区的极简呼吸感，与原型规范严重背离；
2. **`ChatHeaderMore` 放置错位**：目前 `ChatHeaderMore` 被错误塞入左侧面包屑结尾，导致面包屑拖沓臃肿；
3. **左侧边栏开关与右侧工具栏开关杂糅**：混在工具栏中间，还加了破坏视觉连贯性的 `toolbarDivider`；
4. **缺乏三级统一面包屑规范**：项目名未与新建草稿态联动，子代理胶囊缺少专属 1.4s 呼吸动效。

### 彻底退役清单（Deprecation List）：
- ❌ 彻底移除 `UNIT_TOOL_PANELS` 及其渲染循环（`UNIT_TOOL_PANELS.map`）；
- ❌ 彻底移除顶栏中间的静态 `toolbarDivider`；
- ❌ 彻底移除硬编码的 5 个工具激活态逻辑（转由右侧 Side Panel TabManager 统一管理）。

---

## 2.2 三级面包屑导航（3-Level Breadcrumbs）

三级面包屑统一置于 `.chat-top-left` 区域，单行截断不换行：

```
[ 项目名 Badge ]  /  [ 会话标题 (点击就地编辑) ]  /  [ ⚡ 2 个运行中 ▾ ]
```

### 层级规范：
1. **Level 1：项目名 Badge（`.breadcrumb-project`）**
   - 展示当前会话所属项目名称（如 `conex` 或 `通用项目`）；
   - 最大宽度 `max-width: 110px`，文字溢出省略；
   - 交互：点击直接触发 `enterDraftMode(folder)` 进入该项目的新建对话草稿态；
2. **分隔符（`.bc-sep`）**
   - 极淡灰 `/`，`color: var(--text-tertiary, #cccccc)`，不可选；
3. **Level 2：会话标题（`.breadcrumb-session`）**
   - 展示会话实时标题，最大宽度 `max-width: 140px`；
   - 集成 `<SessionInlineRename />`：
     - Hover 浮现编辑铅笔图标（`Pencil` 12px）；
     - 点击切换为实体 `<input />` 输入框，自动 focus + 全选文本；
     - `Enter` 触发 `renameSession(sid, newTitle)` 保存，`Escape` 放弃，失焦自动回退；
4. **Level 3：子代理状态胶囊（`.breadcrumb-agent-btn`）**
   - 仅在会话存在活跃或已派发子代理时渲染（通过 `agents.length > 0` 感知）；
   - 左侧内嵌 **1.4s 呼吸绿点（`agent-live-dot`）**：
     ```css
     .agent-live-dot {
       width: 5px;
       height: 5px;
       border-radius: 50%;
       background: #10b981;
       flex-shrink: 0;
       animation: agentDotPulse 1.4s ease-in-out infinite;
     }
     @keyframes agentDotPulse {
       0%, 100% { transform: scale(1); opacity: 0.8; }
       50% { transform: scale(1.35); opacity: 1; box-shadow: 0 0 6px rgba(16, 185, 129, 0.6); }
     }
     ```
   - 文本展示：`N 个运行中`（或 `全部就绪`）；
   - 右侧微型箭头（`bc-chevron` 11px），激活展开时顺畅旋转 180°；
   - 点击呼出 `<SubagentHeaderPanel />` 下拉浮层（展示子代理运行状态、耗时、任务摘要与终止按钮）。

---

## 2.3 右侧四元极简动作组（Top Actions）

右侧操作区 `.chat-top-actions` 严格仅保留 **4 个标准动作**，高度统一为 28×28px，圆角 6px：

```
[ 🌐 应用预览 ]   [ 📄 代码产物与文件 ]   [ ⋯ 更多 ]   [ ◨ 右坞开关 ]
```

| 按钮标识 | 图标 | Tooltip 提示 | 交互触发逻辑 | 视觉状态 |
|---|---|---|---|---|
| `topQuickPreviewBtn` | `Lucide.Globe` (14px) | `打开应用预览` | `openToolInSession(sid, 'preview')` 或 `overview` | 侧栏已打开对应 Tab 时呈现 `.active` 高亮 |
| `topQuickArtifactsBtn` | `Lucide.FileCode` (14px) | `打开代码产物与文件` | `openToolInSession(sid, 'files')` | 侧栏已打开对应 Tab 时呈现 `.active` 高亮 |
| `topMoreBtn` | `Lucide.MoreHorizontal` (14px) | `更多操作` | 呼出 `<ChatHeaderMore />`（置顶、导出 Markdown、清空历史、移动项目、分享） | 浮层打开时呈现 `.active` |
| `rightDockToggle` | `IconSidebarRight` (14px) | `展开/收起右侧工作区` | `handleToggleRightDock()`（切换分屏开闭） | 坞展开时高亮；侧栏未展开时保留 36px 窗口控制留白 |

---

## 2.4 DOM 结构树、TypeScript 契约与 CSS 完整规范

### DOM 语义树
```html
<header class="chat-top-header" data-unit-chrome-actions="true">
  <!-- 左侧三级面包屑 -->
  <div class="chat-top-left">
    <nav class="top-breadcrumbs" aria-label="Breadcrumb">
      <div class="breadcrumb-item">
        <button type="button" class="breadcrumb-project" title="点击新建此项目对话">
          conex
        </button>
      </div>
      <span class="bc-sep" aria-hidden="true">/</span>
      <div class="breadcrumb-item">
        <div class="breadcrumb-session">
          <span class="session-title-text">重构连接池异步化</span>
          <button type="button" class="session-rename-btn" aria-label="重命名会话">
            <svg class="lucide-pencil"><!-- 12px --></svg>
          </button>
        </div>
      </div>
      <span class="bc-sep bc-agent-sep" aria-hidden="true">/</span>
      <div class="breadcrumb-item">
        <button type="button" class="breadcrumb-agent-btn" aria-expanded="false">
          <span class="agent-live-dot"></span>
          <span class="agent-btn-text">2 个运行中</span>
          <svg class="bc-chevron"><!-- 11px --></svg>
        </button>
      </div>
    </nav>
  </div>

  <!-- 右侧极简四元组 -->
  <div class="chat-top-actions">
    <button type="button" class="top-action-btn" data-testid="top-quick-preview-btn" title="打开应用预览">
      <svg class="lucide-globe"><!-- 14px --></svg>
    </button>
    <button type="button" class="top-action-btn" data-testid="top-quick-artifacts-btn" title="打开代码产物与文件">
      <svg class="lucide-file-code"><!-- 14px --></svg>
    </button>
    <div class="chat-header-more-trigger">
      <button type="button" class="top-action-btn" data-testid="top-more-btn" title="更多操作">
        <svg class="lucide-more-horizontal"><!-- 14px --></svg>
      </button>
    </div>
    <button type="button" class="top-action-btn right-dock-toggle" data-testid="right-dock-toggle" title="收起/展开右侧工作区">
      <svg class="icon-sidebar-right"><!-- 14px --></svg>
    </button>
  </div>
</header>
```

### TypeScript 接口契约（`UnitChromeActions.tsx`）
```typescript
export interface UnitChromeActionsProps {
  activeSessionId?: string | null;
  className?: string;
  leading?: React.ReactNode;
  onClearHistory?: () => void;
  onExportMarkdown?: () => void;
}
```

### CSS 完整规范（`UnitChromeActions.module.css`）
```css
.chatTopHeader {
  position: sticky;
  top: 0;
  left: 0;
  width: 100%;
  height: 38px;
  min-height: 38px;
  margin-bottom: -38px;
  z-index: 10;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    var(--bg-page, #ffffff) 0%,
    var(--bg-page, #ffffff) 65%,
    rgba(255, 255, 255, 0.94) 82%,
    rgba(255, 255, 255, 0.45) 94%,
    rgba(255, 255, 255, 0) 100%
  );
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  box-sizing: border-box;
  flex-shrink: 0;
  user-select: none;
}

.topLeft {
  height: 28px;
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.breadcrumbs {
  height: 28px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
}

.bcProjectBtn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  border-radius: 4px;
  color: var(--text-secondary, #777777);
  font-weight: 500;
  font-size: 13px;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: all 150ms ease;
}

.bcProjectBtn:hover {
  background: var(--bg-item-hover, rgba(0, 0, 0, 0.05));
  color: var(--text-primary, #111111);
}

.bcSep {
  color: var(--text-tertiary, #cccccc);
  font-size: 12px;
  margin: 0 1px;
  flex-shrink: 0;
}

.topActions {
  height: 28px;
  display: flex;
  align-items: center;
  gap: 4px;
  pointer-events: auto;
  margin-right: 36px;
  transition: margin-right 150ms cubic-bezier(0.16, 1, 0.3, 1);
}

:global([data-has-side-panel="true"]) .topActions {
  margin-right: 0;
}

.topActionBtn {
  width: 28px;
  height: 28px;
  min-width: 28px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary, #666666);
  padding: 0;
  transition: background 150ms ease, color 150ms ease;
}

.topActionBtn:hover {
  background: var(--bg-item-hover, rgba(0, 0, 0, 0.05));
  color: var(--text-primary, #111111);
}

.topActionBtn.isActive {
  background: var(--bg-item-active, rgba(0, 0, 0, 0.08));
  color: var(--text-primary, #111111);
}
```

---

# 三、模块二：右侧工作区面板（Side Panel）与 Tab 管理器

## 3.1 双层顶栏架构（Row 1: Tabs Header + Row 2: Navigation Toolbar）

右侧工作区面板（`chat-side-panel`）采用严谨的**双层垂直功能划分架构**：
- **第一层（Row 1: Tabs Strip）**：高度 38px，包含 Tab 列表、双态加号（`in-flow` 与 `pinned`）、最大化/收起操作；
- **第二层（Row 2: Action Toolbar）**：高度 32px，包含后退、前进、刷新、在浏览器中打开动作；在空态（无打开 Tab）时自动隐藏。

```
+-----------------------------------------------------------------------------------------+
| [Tab 1: 🌐 预览  ×] [Tab 2: 📄 文件  ×]  [+] (in-flow)       |  [+ pinned] [⤢ 最大化] [◨ 收起] |  <-- Row 1: 38px
+-----------------------------------------------------------------------------------------+
| [ ◀ 后退 ] [ ▶ 前进 ] [ 🔄 刷新 ]                            |             [ ↗ 浏览器中打开 ] |  <-- Row 2: 32px
+-----------------------------------------------------------------------------------------+
|                                                                                         |
|                                     [ 面板内容区 ]                                       |
|                                                                                         |
+-----------------------------------------------------------------------------------------+
```

---

## 3.2 标签栏（Tab Strip）与 13px 专属图标 / 16px 微型叉号

### Tab 项（`.side-panel-tab-item`）规格：
- **几何与尺寸**：高度 26px，最大宽度 `max-width: 140px`，内边距 `padding: 0 4px 0 7px`，圆角 4px；
- **专属图标**：13×13px（`stroke-width: 1.8`），左侧对齐；
- **微型关闭按钮（`.tab-item-close-btn`）**：
  - 16×16px 实体尺寸，内部内嵌 10×10px `Lucide.X`（`stroke-width: 2`）；
  - 默认微透明 `opacity: 0.65`，Hover 时 `opacity: 1` + 放大至 1.08x，背景轻量微加深；
- **进入/退出弹簧动效（Spring Animation）**：
  - 标签新建进入：`sideTabSlideIn 220ms cubic-bezier(0.16, 1, 0.3, 1)`（平滑扩展宽度 0→140px）；
  - 标签关闭退出：宽度压缩至 0、边距合拢、透明度与缩放平滑收缩至 0.88x，不产生任何生硬跳闪。

---

## 3.3 双态加号智能切换机制（In-flow 随流 vs Pinned 固定）

为解决多 Tab 溢出时的交互痛点，设计了**智能双态加号系统**：
1. **随流态加号（`.side-panel-add-btn.in-flow`）**：
   - 当 Tab 数量较少、未触发横向滚动条溢出时，加号紧随在最后一个 Tab 项右侧（随流排列）；
2. **固定态加号（`.side-panel-add-btn.pinned`）**：
   - 监听 `.side-panel-tabs-track` 的 `scrollWidth > clientWidth`；
   - 一旦发生溢出，给外层容器附加 `.has-overflow` 类名；
   - 此时 `in-flow` 加号宽度平滑压缩至 0 并隐藏；同时固定在右侧集群（`.side-panel-tab-fixed-cluster`）的 `pinned` 加号以 Scale 0.85→1.0 弹簧渐显，确保用户始终能以最少位移快速追加标签。

```css
/* Add Tab Buttons (+): in-flow and pinned */
.sidePanelAddBtn {
  width: 26px;
  height: 26px;
  min-width: 26px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #666666);
  cursor: pointer;
  transition: all 160ms cubic-bezier(0.16, 1, 0.3, 1);
}

.sidePanelAddBtn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-primary, #111111);
}

.sidePanelAddBtn.pinned {
  opacity: 0;
  width: 0;
  min-width: 0;
  transform: scale(0.85);
  pointer-events: none;
  overflow: hidden;
}

.hasOverflow .sidePanelAddBtn.pinned {
  opacity: 1;
  width: 26px;
  min-width: 26px;
  transform: scale(1);
  pointer-events: auto;
  margin-right: 2px;
}

.hasOverflow .sidePanelAddBtn.inFlow {
  opacity: 0;
  pointer-events: none;
  width: 0;
  min-width: 0;
}
```

---

## 3.4 空态居中启动 Hub 卡片（Launcher Hub）

当右侧面板处于打开但没有激活任何 Tab 时（`tabs.length === 0`），隐藏第二层 Toolbar，在面板正中心展示极简卡片启动器：

```
+-------------------------------------------------------------+
|                                                             |
|                   [  工作区启动中心  ]                       |
|                                                             |
|   +-----------------------------------------------------+   |
|   | [ 🌐 ]  应用预览                                    |   |
|   |         在右侧实时预览当前 Web / 桌面应用           |   |
|   +-----------------------------------------------------+   |
|   +-----------------------------------------------------+   |
|   | [ 📄 ]  代码产物与文件                              |   |
|   |         浏览会话生成的文件、差异与产物              |   |
|   +-----------------------------------------------------+   |
|                                                             |
+-------------------------------------------------------------+
```

### 卡片规范：
- **容器**：最大宽度 320px，纵向居中，入场附带 `launcherHubFadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1)`；
- **卡片项（`.side-panel-launcher-card`）**：
  - 8px 圆角，内边距 `8px 12px`，底色透明，Hover 时渐变至 `var(--bg-item-hover)`；
  - 左侧 32×32px 浅灰色圆角图标盒，内部 16px 图标；
  - 右侧文字区：13px 标题（加粗 500） + 11px 辅助描述（`color: var(--text-tertiary)`）。

---

## 3.5 DOM 结构树、TypeScript 契约与 CSS 完整规范

### DOM 语义树
```html
<aside class="chat-side-panel" data-side-panel="true" data-is-maximized="false">
  <!-- Row 1: 标签栏 -->
  <div class="side-panel-tab-header">
    <div class="side-panel-tabs-track">
      <div class="side-panel-tabs-list" role="tablist">
        <div class="side-panel-tab-item active" role="tab" aria-selected="true" data-tab-id="preview">
          <span class="side-panel-tab-icon">
            <svg class="lucide-globe"><!-- 13px --></svg>
          </span>
          <span class="tab-item-title">应用预览</span>
          <button type="button" class="tab-item-close-btn" aria-label="关闭 应用预览">
            <svg class="lucide-x"><!-- 10px --></svg>
          </button>
        </div>
        <button type="button" class="side-panel-add-btn in-flow" aria-label="添加工具标签">
          <svg class="lucide-plus"><!-- 13px --></svg>
        </button>
      </div>
    </div>
    <div class="side-panel-tab-fixed-cluster">
      <button type="button" class="side-panel-add-btn pinned" aria-label="添加工具标签">
        <svg class="lucide-plus"><!-- 13px --></svg>
      </button>
      <button type="button" class="side-panel-btn side-panel-btn-maximize" aria-label="最大化面板">
        <svg class="lucide-maximize-2"><!-- 14px --></svg>
      </button>
      <button type="button" class="side-panel-btn side-panel-btn-collapse" aria-label="收起面板">
        <svg class="icon-sidebar-right"><!-- 14px --></svg>
      </button>
    </div>
  </div>

  <!-- Row 2: 动作工具条 -->
  <div class="side-panel-toolbar">
    <div class="side-panel-toolbar-nav">
      <button type="button" class="side-panel-btn" title="后退" disabled>
        <svg class="lucide-chevron-left"><!-- 14px --></svg>
      </button>
      <button type="button" class="side-panel-btn" title="前进" disabled>
        <svg class="lucide-chevron-right"><!-- 14px --></svg>
      </button>
      <button type="button" class="side-panel-btn" title="刷新">
        <svg class="lucide-rotate-cw"><!-- 14px --></svg>
      </button>
    </div>
    <div class="side-panel-toolbar-actions">
      <button type="button" class="side-panel-btn" title="在浏览器中打开">
        <svg class="lucide-external-link"><!-- 14px --></svg>
      </button>
    </div>
  </div>

  <!-- 内容区 / 空态 Launcher Hub -->
  <div class="side-panel-content">
    <!-- 当 tabs.length === 0 时渲染 Launcher Hub -->
  </div>
</aside>
```

### TypeScript 接口契约（`LeafToolTabStrip.tsx` & `SidePanelHost.tsx`）
```typescript
export interface SidePanelTabItem {
  id: string;
  title: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  canClose?: boolean;
}

export interface LeafToolTabStripProps {
  leafId: string;
  sessionId?: string | null;
  tabs: string[];
  activeTab: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: (panelId: string) => void;
  onToggleMaximize: () => void;
  onCollapse: () => void;
  isMaximized?: boolean;
}
```

---

# 四、模块三：输入区（Composer）四层垂直堆叠与墨绿圆形发送按钮

## 4.1 四层空间垂直堆叠体系

在主输入区域，建立自顶向下的 **4 层垂直空间层级**，杜绝以往把权限卡、进度条生硬挤入聊天流造成的滚动抖动与遮挡问题：

```
+-------------------------------------------------------------------------+
|  Layer 1: 权限审批条 [ 🛡️ 正在请求执行 shell 命令... ] [拒绝] [允许] [始终允许]  |  <-- 浮于 Composer 上方
+-------------------------------------------------------------------------+
|  Layer 2: 目标/计划模式进度条 [ ✓ 1 ] [ ② 80% ] [ 3 ] ━━━━━●━━━━  (Scrubber)  |  <-- 计划激活时常驻吸顶
+-------------------------------------------------------------------------+
|  Layer 3: 上下文与文件引用卡片 [ 📄 index.ts × ] [ 📄 parser.ts × ]             |  <-- 附件与引用胶囊
+-------------------------------------------------------------------------+
|  Layer 4: [ ＋ ]  输入提示词或使用 / 选择技能...  [ 🛡️ ] [ 3.7 | High ] [ 🟢 ⬆ ] |  <-- 核心输入卡片
+-------------------------------------------------------------------------+
```

---

## 4.2 Layer 1：浮动权限审批条（Permission Bar）

严格对齐 `reference/chat-composer-component/css/flow/permission-bar.css`：
- **双行结构**：
  - Line 1：盾牌图标 + 风险等级 Badge（高风险橙红 / 低风险中性灰）+ 倒计时槽位（`slot-timer`，60s 倒计时数字翻滚）+ 更多细节展开箭头；
  - Line 2：真实命令预览（代码块背景，语法高亮）+ 动作按钮组：
    - `[ 拒绝 ]`（`.flow-permission-bar__btn--deny`，淡灰文字，Hover 微红）；
    - `[ 允许 ]`（`.flow-permission-bar__btn--allow`，墨绿色高亮）；
    - `[ 始终允许 ]`（`.flow-permission-bar__btn--always`，次级中性高亮）；
- **审批完成瞬态**：审批后不直接突兀消失，平滑渐变为 `[ ✓ 已允许 ]` 态（0.3s），然后以 Scale 0.96 向上合拢淡出。

---

## 4.3 Layer 2：目标/计划模式进度条（Plan Progress Bar & Scrubber）

- **双向联动**：与消息流中的 `PlanStep` 里程碑双向同步；
- **Scrubber 刻度线**：采用带有磁吸刻度的进度条，Hover 显示步骤 Tooltip，点击直接平滑滚动至对应消息流步骤；
- **呼吸脉冲**：当前正在执行的步骤在进度条上以 `1.4s` 墨绿光晕律动。

---

## 4.4 Layer 3：上下文与文件引用卡片区（Attachment Bar）

- **卡片芯片（`.composer-attachment-chip`）**：
  - 24px 高度，圆角 6px，背景 `rgba(0, 0, 0, 0.03)`；
  - 左侧文件类型小图标（13px），中间文件名，右侧 14px 微型叉号；
  - 点击文件名直接在右侧 Side Panel 打开该文件；
  - 拖拽外部文件进入 Composer 区域时，触发全卡片发丝虚线高亮（`drag-drop-overlay`）。

---

## 4.5 Layer 4：主输入区与墨绿色实体圆形发送按钮（[ 🟢 ⬆ ]）

### 底部栅格与操作分布：
- **左侧（`data-composer-grid="left"`）**：
  - `[ ＋ ]` 按钮（28×28px，圆角 6px），点击呼出 `ComposePlusMenu`（添加文件、插入技能、添加扩展）；
- **中间（`data-composer-grid="text"`）**：
  - 富文本输入内核（`TiptapComposerField`），无下划线，聚焦时边框仅混入 3%~5% 中性深灰（遵循全页空态与对话态聚焦克制红线）；
- **右侧（`data-composer-grid="right"`）**：
  - `[ 🛡️ ]` 权限模式切换菜单（全自动 / 询问 / 只读）；
  - `[ 3.7 Sonnet | High ]` 模型切换徽标；
  - `[ 📊 ]` 上下文 Token 仪表胶囊；
  - **墨绿色实体圆形发送按钮（`.send-btn-circle`）**：
    - 尺寸：32×32px 绝对正圆（`border-radius: 50%`）；
    - 色值：`background: var(--brand, #10b981)`，Hover 态 `background: var(--brand-deep, #059669)`；
    - 图标：白单色向上箭头 `Lucide.ArrowUp`（16×16px，`stroke-width: 2.5`）；
    - 状态机弹簧动效：
      - 空文本/不可发送时：`width: 0`, `opacity: 0`, `transform: scale(0.7)`, `margin-left: 0`；
      - 有文本可发送时：`width: 32px`, `opacity: 1`, `transform: scale(1)`, `margin-left: 6px`, `box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25)`；
      - 运行处理中时：平滑切换为红色方块停止按钮 `[ ⏹ ]`（Shift+点击触发强制终止）。

---

## 4.6 DOM 结构树、TypeScript 契约与 CSS 完整规范

```html
<div class="composer-container">
  <!-- Layer 1: 权限审批条 -->
  <div class="flow-permission-bar" data-risk="high">
    <div class="flow-permission-bar__line1">
      <div class="flow-permission-bar__title-group">
        <svg class="lucide-shield-alert"><!-- 14px --></svg>
        <span class="flow-permission-bar__badge" data-risk="high">Shell 命令审批</span>
        <span class="flow-permission-bar__summary">请求执行 cargo test</span>
      </div>
      <div class="flow-permission-bar__meta-right">
        <span class="flow-permission-bar__timer slot-timer">59s</span>
      </div>
    </div>
    <div class="flow-permission-bar__line2">
      <code class="flow-permission-bar__cmd">cargo test --workspace -- --nocapture</code>
      <div class="flow-permission-bar__actions">
        <button type="button" class="flow-permission-bar__btn flow-permission-bar__btn--deny">拒绝</button>
        <button type="button" class="flow-permission-bar__btn flow-permission-bar__btn--allow">允许</button>
        <button type="button" class="flow-permission-bar__btn flow-permission-bar__btn--always">始终允许</button>
      </div>
    </div>
  </div>

  <!-- Layer 2: 计划进度条 -->
  <div class="plan-progress-bar">
    <!-- 步骤进度指示 -->
  </div>

  <!-- Layer 3 & 4: Composer 卡片 -->
  <div class="composer-card" data-multiline="0">
    <div class="composer-attachment-bar">
      <!-- 附件卡片 -->
    </div>
    <div class="input-main-layout">
      <div class="action-left">
        <button type="button" class="composer-tool-btn plus-btn">
          <svg class="lucide-plus"><!-- 16px --></svg>
        </button>
      </div>
      <div class="field-slot">
        <!-- Tiptap 富文本输入区 -->
      </div>
      <div class="action-right">
        <button type="button" class="composer-tool-btn perm-btn">
          <svg class="lucide-shield"><!-- 14px --></svg>
        </button>
        <button type="button" class="model-badge-btn">
          <span>Claude 3.7 Sonnet</span>
        </button>
        <button type="button" class="send-btn-circle active" aria-label="发送消息">
          <svg class="lucide-arrow-up"><!-- 16px --></svg>
        </button>
      </div>
    </div>
  </div>
</div>
```

---

# 五、模块四：消息流（Message Stream）叙事层级与步骤卡片

## 5.1 思考折叠条（Thinking Block）与双向平滑渐变遮罩

严格对齐 `reference/chat-composer-component/css/flow/thinking.css`：
- **摘要行（Head）**：
  - 左侧内嵌微型箭头 `›`（展开顺畅旋转 90°）；
  - 文本格式：
    - 已完成态：`思考了 3.4秒 >`（`font-variant-numeric: tabular-nums` 杜绝秒数抖动）；
    - 运行态（Live）：`思考中 · 1.8秒`（带有 `#059669` 翡翠绿脉冲高亮）；
- **展开内容区（Body）**：
  - 最大高度 `max-height: 168px`，内部滚动；
  - **双向平滑渐变遮罩（Fade Masks）**：
    - 溢出滚动时，顶部与底部动态启用 20px `linear-gradient` 白底渐变遮罩；
    - 绝不使用突兀的硬边框或沉重阴影。

---

## 5.2 步骤进度里程碑（Plan Step & Milestone Spine）

对齐 `reference/chat-composer-component/css/flow/plan.css`：
- **左侧连续纵向中轴脊线（Spine Line）**：
  - 宽度为精细的 `0.75px`（`background-color: var(--border-color)`）；
  - 精准居中对齐在 16px 步骤圆点正下方（`left: 7.625px`）；
- **步骤编号圆点（`.flow-plan-step__num`）**：
  - 16×16px 实体圆，字体 11px Tabular 加粗；
  - **已完成态**：纯白底 + 深色文本 + `1px solid rgba(0, 0, 0, 0.25)`；
  - **正在执行态（Live）**：`background: rgba(16, 185, 129, 0.1)` + `color: #10b981` + `box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15)`；
  - **等待态**：浅灰底 + `color: var(--text-tertiary)`。

---

## 5.3 子代理实时运行徽章（Subagent Live Capsule）

对齐 `reference/chat-composer-component/css/flow/subagent.css`：
- **双行叙事布局**：
  - Line 1：闪电图标（`⚡` 13px） + 子代理名称（如 `并发性能与协议校验 subagent`） + 状态徽标（`工作中 · 1.8s`，内嵌 5px 呼吸绿点）；
  - Line 2：缩进对齐的动态链路追踪痕迹（`padding-left: 22px`，如 `已扫描 12 个文件 -> 命中 2 个冲突点`）；
- **交互**：点击直接在右侧 Side Panel 打开子代理独立执行上下文视图。

---

## 5.4 代码产物胶囊与实时同步行（Artifact Chip & Sync Line）

对齐 `reference/chat-composer-component/css/flow/artifact-notebook.css`：
- **产物芯片（`.flow-artifact__chip`）**：
  - 呈现为高级的翡翠绿下划线链接（`color: var(--brand-deep, #059669)`，下划线偏移 3px，`text-decoration-color: rgba(16, 185, 129, 0.35)`）；
  - Hover 时下划线与文字加深，点击呼出浮动 Notebook 预览面板或在右侧工作区打开；
- **同步状态行**：
  - `🟢 正在同步...`（伴随 1.4s 呼吸绿点），同步完成后平滑转换为 `✓ 已落盘 (1.2KB)`。

---

## 5.5 DOM 结构树、TypeScript 契约与 CSS 完整规范

```html
<!-- 消息流中的复合叙事单元 -->
<div class="flow-message-root">
  <!-- 1. 思考折叠条 -->
  <div class="flow-thinking is-live" data-open="false">
    <button type="button" class="flow-thinking__head">
      <span class="flow-thinking__chevron">›</span>
      <span class="flow-thinking__live-label">思考中</span>
      <span class="flow-thinking__sep">·</span>
      <span class="flow-thinking__tick">1.8秒</span>
    </button>
    <div class="flow-thinking__fade">
      <div class="flow-thinking__body">正在分析 TreeLeafPanel 手势捕获链条...</div>
    </div>
  </div>

  <!-- 2. 计划步骤里程碑 -->
  <div class="flow-plan-root">
    <div class="flow-plan-step is-running">
      <div class="flow-plan-step__head">
        <span class="flow-plan-step__num">1</span>
        <span class="flow-plan-step__title">根除 TreeLeafPanel 捕获冲突</span>
      </div>
      <div class="flow-plan-step__body">
        <!-- 3. 子代理运行徽章 -->
        <div class="flow-subagent">
          <div class="flow-subagent__line1">
            <span class="flow-subagent__icon">⚡</span>
            <span class="flow-subagent__title">Gesture-Audit-Agent</span>
            <span class="flow-subagent__status">
              <span class="flow-subagent__dot"></span>
              <span>工作中 1.2s</span>
            </span>
          </div>
        </div>

        <!-- 4. 代码产物胶囊 -->
        <div class="flow-artifact">
          <span class="flow-artifact__icon">📄</span>
          <div class="flow-artifact__main">
            <span class="flow-artifact__prefix">已生成</span>
            <button type="button" class="flow-artifact__chip">TreeLeafPanel.fix.patch</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

# 六、模块五：分屏模式下点击无响应的深层根因与架构根治

## 6.1 事件竞争与状态机抢占根因分析（TreeLeafPanel.tsx）

### 🐛 深层根因深度剖析：
在 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx` 第 189 行：
```tsx
<div
  ref={leafElRef}
  className={styles.leaf}
  onPointerDownCapture={handleActivate}  // <--- 致命架构缺陷点
  ...
>
```

1. **捕获阶段抢跑（Capture-Phase Preemption）**：
   - `onPointerDownCapture` 在 DOM 事件派发的**捕获阶段（Capture Phase）**无差别执行；
   - 当用户在分屏窗格内点击任何交互元素（如顶栏更多按钮、模式下拉选项、输入框、模型切换器）时，外层 Leaf 容器优先捕获到 `pointerdown`；
2. **状态机同步刷新导致目标卸载（Unmount / Blur Mutation）**：
   - 捕获回调立即调用 `handleActivate()`，触发 `setActiveLeaf(leaf.id)` 及 `shell.activateTab(...)`；
   - Zustand store 触发 React 树全局同步 re-render，导致正在触发点击的目标 DOM 节点发生微观重新挂载（Re-mount）或焦点强行转移；
   - 随后的 `pointerup` 和 `click` 事件链条断裂，导致用户感觉“点了没有任何反应”。

---

## 6.2 根治方案：捕获穿透防护与冒泡阶段事件调度

### 改造策略：
1. **移除 `onPointerDownCapture`，改用冒泡阶段的 `onPointerDown`**；
2. **增加交互元素智能穿透守卫（Interactive Guard）**：
   - 若 `e.target` 属于可交互组件（按钮、输入框、下拉菜单、链接），则不抢占焦点与活跃态，让子组件事件正常闭环。

```tsx
// TreeLeafPanel.tsx 修复方案
const handlePointerDown = useCallback((e: React.PointerEvent) => {
  const target = e.target as HTMLElement | null;
  // 智能守卫：如果是交互元素内部触发，放行事件流，不执行抢跑中断
  if (target && target.closest('button, input, textarea, select, [role="menuitem"], [data-radix-popper-content-wrapper], [data-interactive="true"]')) {
    return;
  }
  handleActivate();
}, [handleActivate]);

return (
  <div
    ref={leafElRef}
    className={styles.leaf}
    onPointerDown={handlePointerDown}  // 替换 onPointerDownCapture
    ...
  >
```

---

## 6.3 验证断言与反回归测试用例设计

编写专项回归测试 `TreeLeafPanel.gesture-fix.test.tsx`：
1. **断言 1**：在分屏状态下点击叶子内部的 `<button>`，断言按钮的 `onClick` 回调必定触发；
2. **断言 2**：在分屏状态下点击 Radix / SmartPanel 菜单项，断言菜单选择逻辑执行且浮层正常关闭；
3. **断言 3**：在分屏空白区域点击时，正确激活当前 Leaf 并同步 Shell Active Session。

---

# 七、模块六：SmartExpandablePanel 设计系统与全仓弹窗菜单改造

## 7.1 单层纯色实体发丝边框与设计令牌（Design Tokens）

严格对齐 `reference/smart-expandable-panel/css/tokens.css`：
- **发丝边框**：
  - 浅色：`border: 1px solid #e2dfd9`；
  - 深色：`border: 1px solid #2b2926`；
  - 严禁双重模糊阴影，使用单层柔和弥散阴影：`box-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09)`；
- **同心圆角**：
  - 外壳 `--sep-radius-outer: 14px`，内边距 `6px`，选项项 `--sep-item-radius: 8px`。

---

## 7.2 Zero-Canvas SVG 多边形 Safe-Aim 轨迹保护引擎

引入 `SafeAimEngine`（`reference/smart-expandable-panel/js/safe-aim.js`）：
- **原理**：当鼠标从一级菜单项向右侧二级级联子菜单斜向移动时，在 `body` 挂载一个透明的 SVG 多边形（Safe Triangle）；
- **重心坐标判定（Barycentric Coordinates）**：
  - 鼠标当前点 $P$、子菜单左上角 $A$、子菜单左下角 $B$ 构成动态保护三角；
  - 只要光标处于三角形内，暂停触发同级其它菜单项的 Hover 关闭逻辑，彻底杜绝二级菜单“一碰就消失”的恶性体验。

```typescript
// SafeAim 核心算法规范
export class SafeAimEngine {
  isPointerInSafeZone(point: { x: number; y: number }): boolean {
    if (!this.enabled || !this.activeSubmenu) return false;
    const subRect = this.activeSubmenu.getBoundingClientRect();
    const mouse = this.getPreviousMousePos();
    const isSubmenuOnRight = subRect.left >= mouse.x;

    const pTop = isSubmenuOnRight
      ? { x: subRect.left, y: subRect.top }
      : { x: subRect.right, y: subRect.top };
    const pBottom = isSubmenuOnRight
      ? { x: subRect.left, y: subRect.bottom }
      : { x: subRect.right, y: subRect.bottom };

    return this.pointInTriangle(point, mouse, pTop, pBottom);
  }
}
```

---

## 7.3 WAI-ARIA 全键盘漫游与双向级联导航协议

实现完整的 WAI-ARIA Menu 键盘交互矩阵：
- `ArrowDown` / `ArrowUp`：循环遍历同级选项；
- `ArrowRight` 或 `Enter`（当存在子菜单时）：聚焦并展开二级子菜单，自动 Focus 首个子项；
- `ArrowLeft` 或 `Escape`（在二级子菜单中）：关闭二级菜单，焦点无缝回退给一级触发项；
- `Escape`（在一级菜单中）：关闭整个面板，焦点还给 Trigger 按钮。

---

## 7.4 全仓弹窗菜单普查与重构对照表（5 大核心菜单）

| 菜单组件路径 | 现状问题 | 重构对齐标准 |
|---|---|---|
| `ModelBadgePickerMenu.tsx` | 嵌套硬写 CSS，二级服务商模型级联无 Safe-Aim 轨迹保护 | 接入 `SmartExpandablePanel`，单层 `#e2dfd9` 边框，Safe-Aim 轨迹保护，全键盘漫游 |
| `ComposePlusMenu.tsx` | 原生 Menu，样式与圆角不统一 | 采用 `SmartExpandablePanel`，统一 14px/8px 同心圆角，左侧 14px 图标与右侧快捷键对齐 |
| `PermissionModeMenu.tsx` | 简单浮层，缺少单选指示器与 WAI-ARIA 属性 | 采用 `SmartExpandablePanel` Selectable 模式，右侧呈现翡翠绿勾选标 |
| `ProjectPickerMenu.tsx` | 级联“添加项目”容易误触关闭 | 接入 Safe-Aim 三角保护，搜索框支持实时过滤与首项自动高亮 |
| `ChatHeaderMore.tsx` | 独立 Popover 样式，与全局设计系统割裂 | 统一基于 `SmartExpandablePanel` 封装，规范危险项红字与微型操作图标 |

---

# 八、精准迁移实施步骤与文件变动矩阵（Step-by-Step Migration）

## 8.1 全仓组件文件变动矩阵

| 序号 | 文件路径 | 变动类型 | 核心改造职责 |
|---|---|---|---|
| 1 | `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx` | **[MODIFY]** | 移除 `onPointerDownCapture` 改为 `onPointerDown` + 穿透守卫，根除分屏点击冲突 |
| 2 | `apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx` | **[MODIFY]** | 彻底移除 5 个粗糙工具按钮；实现左侧三级面包屑与右侧四元极简动作组 |
| 3 | `apps/crish-desktop/src/components/chat-card/UnitChromeActions.module.css` | **[MODIFY]** | 落地 38px 负外边距向下淡隐遮罩与零蓝设计规范 |
| 4 | `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx` | **[MODIFY]** | 重构右侧面板双层顶栏、13px 图标、16px 微型叉号、双态加号（In-flow/Pinned） |
| 5 | `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css` | **[MODIFY]** | 落地 Tab 弹簧进入/退出动效与溢出感知样式 |
| 6 | `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx` | **[MODIFY]** | 装配四层垂直堆叠结构，接入墨绿色实体圆形发送按钮（[ 🟢 ⬆ ]） |
| 7 | `apps/crish-desktop/src/components/chat-composer/ComposerSendControls.tsx` | **[MODIFY]** | 实现 32×32px 墨绿正圆发送按钮与弹簧形变状态机 |
| 8 | `apps/crish-desktop/src/components/ui/SmartPanel/SmartExpandablePanel.tsx` | **[NEW]** | 从 reference 完整引入现代单层发丝边框与全键盘导航面板内核 |
| 9 | `apps/crish-desktop/src/components/ui/SmartPanel/SafeAimEngine.ts` | **[NEW]** | 引入 Zero-Canvas SVG 多边形轨迹保护引擎 |
| 10 | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx` | **[MODIFY]** | 基于 SmartExpandablePanel 改造模型切换菜单 |
| 11 | `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx`| **[MODIFY]** | 对齐 `思考了 3.4秒 >` 摘要规范与双向平滑渐变遮罩 |

---

## 8.2 6 阶段演进实施路线图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: 根基修复 —— TreeLeafPanel 手势捕获与状态机冲突彻底根治              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: 顶栏重构 —— Chat Top Header 3 级面包屑与四元极简动作组对齐          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: 工作区面板 —— Side Panel 双层顶栏、双态加号与 Launcher Hub 落地     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 4: 输入中枢 —— Composer 四层垂直堆叠与墨绿实体正圆发送按钮装配        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 5: 消息叙事 —— 思考折叠条、步骤中轴脊线、子代理徽章与产物胶囊对齐     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 6: 设计系统收口 —— SmartExpandablePanel 全仓 5 大菜单改造与 Safe-Aim   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 8.3 生产级验收门禁清单

- [ ] **Typecheck 全绿**：`npm run typecheck` 零类型报错；
- [ ] **分屏手势无冲突**：在左右分屏下点选菜单、按钮、输入框 100% 响应，无事件截断；
- [ ] **顶栏像素级对齐**：38px 负外边距淡隐遮罩平滑，无 5 大粗糙静态按钮；
- [ ] **Tab 管理器双态加号**：溢出时 `in-flow` 加号平滑消失，`pinned` 加号弹簧显现；
- [ ] **Composer 圆形发送按钮**：有文字输入时 32px 墨绿正圆平滑展开，空文本时优雅收缩至 0；
- [ ] **Safe-Aim 轨迹保护**：斜向划入二级级联菜单 100% 不闪退、不误关；
- [ ] **全量单元测试覆盖**：新增与修改的测试用例全部通过，测试资产 0 丢失。
