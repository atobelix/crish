# Conex / Crish — 全仓 UI 像素级完美与极致交互参考对齐地毯式审计报告

> **文档版本**：v1.0 (Full-Sweep Reference Alignment Audit Report)
> **审查报告落盘路径**：`docs/ui-reference-alignment-audit/01-full-sweep-gap-report.md`
> **审计基准与参考原型资产**：
> 1. `reference/chat-composer-component/`（包含 `index.html`, `css/composer.css`, `js/popovers.js`, `css/flow/*.css`, `CONVERSATION_FLOW_SPEC.md`, `DESIGN_SYSTEM.md` 等）
> 2. `reference/smart-expandable-panel/`（包含 `css/tokens.css`, `css/panel.css`, `js/position-engine.js`, `js/safe-aim.js`, `react/SmartExpandablePanel.tsx`, `react/types.ts` 等）
> 3. `reference/展开面板设计.html`（智能无敌展开面板组件 v22.0 完整单文件原型）
> 4. 用户最新高保真界面设计与像素级交互规范
>
> **审查范围**：`apps/crish-desktop/src/` 中的全仓界面、组件、交互、边距体系与动效（除 `_sidebarScroll_...` 左侧边栏会话列表内容豁免外，其余全部严格审查）。

---

## 目录

- [一、审计综述与全仓设计系统断层分析](#一审计综述与全仓设计系统断层分析)
  - [1.1 核心断层与三大视觉硬伤](#11-核心断层与三大视觉硬伤)
  - [1.2 全局设计令牌（Tokens）与色彩空间偏离审查](#12-全局设计令牌tokens与色彩空间偏离审查)
  - [1.3 数学同心圆角与单层发丝边框基准比对](#13-数学同心圆角与单层发丝边框基准比对)
- [二、维度一：消息流（Message Stream）与步骤卡片审查](#二维度一消息流message-stream与步骤卡片审查)
  - [2.1 思考折叠条（Thinking Block）微动效与排版差距](#21-思考折叠条thinking-block微动效与排版差距)
  - [2.2 步骤进度（Plan Step & Milestone Spine）与呼吸脉冲态差距](#22-步骤进度plan-step--milestone-spine与呼吸脉冲态差距)
  - [2.3 子代理实时运行徽章（Subagent Live Capsule）与双行老虎机差距](#23-子代理实时运行徽章subagent-live-capsule与双行老虎机差距)
  - [2.4 代码产物胶囊（Artifact Chip）与实时同步线（Sync Line）差距](#24-代码产物胶囊artifact-chip与实时同步线sync-line差距)
  - [2.5 禁令违规排查（绿勾墙、方块 Spinner、重卡片阴影）](#25-禁令违规排查绿勾墙方块-spinner重卡片阴影)
- [三、维度二：通用展开面板与菜单体系（Smart Expandable Panel）审查](#三维度二通用展开面板与菜单体系smart-expandable-panel审查)
  - [3.1 单层纯色发丝边框与同心圆角结构审查](#31-单层纯色发丝边框与同心圆角结构审查)
  - [3.2 Zero-Canvas SVG 多边形 Safe-Aim 轨迹保护审查](#32-zero-canvas-svg-多边形-safe-aim-轨迹保护审查)
  - [3.3 WAI-ARIA 全键盘漫游与双向级联导航协议审查](#33-wai-aria-全键盘漫游与双向级联导航协议审查)
  - [3.4 全仓弹窗与下拉菜单普查（9 大核心菜单逐一剖析）](#34-全仓弹窗与下拉菜单普查9-大核心菜单逐一剖析)
- [四、维度三：右侧工作区面板与工具栏（Side Panel & Launcher Hub）审查](#四维度三右侧工作区面板与工具栏side-panel--launcher-hub审查)
  - [4.1 顶栏双态加号（in-flow 随流 vs pinned 固定）机制差距](#41-顶栏双态加号in-flow-随流-vs-pinned-固定机制差距)
  - [4.2 16px 微型叉号与 TabStrip 几何尺寸审查](#42-16px-微型叉号与-tabstrip-几何尺寸审查)
  - [4.3 二层功能工具条（Navigation Toolbar）审查](#43-二层功能工具条navigation-toolbar审查)
  - [4.4 空态极简居中启动 Hub 卡片（Launcher Hub）审查](#44-空态极简居中启动-hub-卡片launcher-hub审查)
- [五、维度四：输入区（Composer）四层堆叠与细节审查](#五维度四输入区composer四层堆叠与细节审查)
  - [5.1 Layer 1：浮动权限审批条（PermissionBar）剥离审查](#51-layer-1浮动权限审批条permissionbar剥离审查)
  - [5.2 Layer 2：目标/计划模式条（PlanProgressBar）与 Scrubber 联动审查](#52-layer-2目标计划模式条planprogressbar与-scrubber-联动审查)
  - [5.3 Layer 3：上下文与引用卡片条（AttachmentBar）审查](#53-layer-3上下文与引用卡片条attachmentbar审查)
  - [5.4 Layer 4：主输入区与墨绿实体圆形发送按钮（send-btn-circle）弹性动效审查](#54-layer-4主输入区与墨绿实体圆形发送按钮send-btn-circle弹性动效审查)
- [六、全仓整改优先级清单与文件改造实施矩阵](#六全仓整改优先级清单与文件改造实施矩阵)

---

# 一、审计综述与全仓设计系统断层分析

## 1.1 核心断层与三大视觉硬伤

经过对 `apps/crish-desktop/src/` 与参考原型库的全面源码比对，当前桌面端应用与原型资产之间存在**三大系统级架构与体验断层**：

1. **界面语言分裂（Fragmented Surface Hierarchy）**：
   - 参考原型：全仓统一使用**极简冷静的单层纸墨界面**，消息流中无重外边框、无沉重卡片阴影，思考过程、步骤进度、子智能体均以极高质感的无框行内流（Organic Flow）呈现；
   - Desktop 现状：在 `ChatMessageRow.module.css` 与 `InlineAgentPanel.module.css` 中大量使用灰色带边框矩形（如 `.thoughtTimelineSection` 带 1px 灰色实线框、灰色底色；内联子代理塞入了完整的输入框与上帝控件），导致消息流厚重、割裂。
2. **菜单系统未收敛（Missing Smart Expandable Panel Engine）**：
   - 参考原型：具备完整的 `SmartExpandablePanel` 引擎，包含硬件级 1px 单层发丝边框（`#e2dfd9` / `#2b2926`）、数学同心圆角（$R_{\text{inner}} = R_{\text{outer}} - P$）、Zero-Canvas SVG 多边形 Safe-Aim 轨迹保护、WAI-ARIA 双向全键盘导航；
   - Desktop 现状：现存 `apps/crish-desktop/src/components/ui/Menu/` 仅为基础的 Radix Popover 包装，不仅边框与圆角缺乏同心数学约束，且 Safe-Aim 仅作为一个 300ms 定时器状态机散落在个别组件（`ModelBadgePickerMenu.tsx`），全仓大部分菜单（`ComposePlusMenu`, `PermissionModeMenu`, `ProjectPickerMenu`, `SettingsQuickMenu`, `TiptapSlashMenu`）均未获得斜向防误触保护与子菜单键盘展开协议。
3. **输入区与工作区双态机制缺失（Missing Multi-Layer & Dual-State Dynamics）**：
   - 参考原型：Composer 具备清晰的四层垂直堆叠空间架构（浮动权限条 → 计划模式进度条 → 附件上下文药丸 → 输入区与弹缩圆形发送按钮）；右侧面板 TabStrip 具备随溢出状态自动切换的 `in-flow` vs `pinned` 双态加号与极简居中 Launcher Hub；
   - Desktop 现状：发送按钮为静态切换，缺乏 `width: 0 -> 32px` 的 Spring 弹性展开与墨绿实体圆质感；权限审批混杂在消息流 `CompactToolRow` 中；右侧面板加号硬编码在右侧端点，空态仍渲染夹具按钮。

---

## 1.2 全局设计令牌（Tokens）与色彩空间偏离审查

### 代码位置与现状
- **文件路径**：`apps/crish-desktop/src/styles/tokens.css:128-150`
- **缺陷代码片段**：
  ```css
  /* tokens.css:145-150 违规引入蓝色系变量作为主要强调色 */
  --accent-blue: #1d4ed8;
  --accent-blue-light: hsl(217, 70%, 96%);
  --accent-violet: hsl(258, 90%, 66%);
  --accent-violet-light: hsl(258, 40%, 97%);
  --accent-primary: var(--accent-blue); /* 违背 Zero-Blue 铁律 */
  --accent-secondary: var(--accent-blue-light);
  ```

### 差距分析与违背规范
- **违反《DESIGN_SYSTEM.md》第二条「绝对零蓝色原则 (Zero-Blue Policy)」**：整个界面（包括字体、边框、背景、高亮、Focus 状态）**绝对不允许出现任何蓝色的痕迹**。
- **色彩偏离**：原型采用带有 10% CMYK 暖黄色相倾向的自然墨阶（CMYK Yellow 10.3%，Zero Blue）。Desktop 当前的 `--accent-primary` 硬编码指向 `#1d4ed8`，破坏了界面的中性暖调纸张质感。

### 整改方案
在 `tokens.css` 中将 `--accent-primary` 修正为翡翠绿/墨阶中性色，彻底退役 `--accent-blue`：
```css
/* 对齐 reference/smart-expandable-panel/css/tokens.css */
--sep-bg-canvas: #f6f5f3;
--sep-bg-panel: rgba(255, 254, 252, 0.96);
--sep-border-color: #e2dfd9;   /* 浅色发丝边框 */
--sep-text-primary: #1d1c1a;   /* 暖墨黑 */
--sep-accent-color: hsl(160 84% 39%); /* #10b981 */
--sep-accent-light: hsl(160 84% 39% / 0.12);
--brand-deep: #059669;
```

---

## 1.3 数学同心圆角与单层发丝边框基准比对

### 代码位置与现状
- **文件路径**：`apps/crish-desktop/src/components/ui/Menu/Menu.module.css:27-35`
- **缺陷代码片段**：
  ```css
  /* Menu.module.css:27-35 随意组合圆角，破坏同心数学约束 */
  padding: var(--dropdown-padding, var(--space-1, 4px));
  border-radius: var(--dropdown-radius, var(--radius-lg, 8px));
  border: 1px solid var(--hairline-strong);
  ```

### 差距分析
- **同心圆角破损**：参考原型规定 $R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 6\text{px})$。外层 14px/16px，内边距 6px，内部行项必须严格为 8px/10px。Desktop 使用 8px 外圆角配合 4px 边距，内部项使用 6px，未能形成精确的同心视觉包裹，边缘缝隙不均。
- **发丝边框模糊**：Desktop 使用 `--hairline-strong`（透明度混合色），在部分高分屏下因亚像素计算产生发虚或重影；参考原型规定必须为清晰的实体 1px 发丝边框（Light: `#e2dfd9`, Dark: `#2b2926`）。

---

# 二、维度一：消息流（Message Stream）与步骤卡片审查

## 2.1 思考折叠条（Thinking Block）微动效与排版差距

### 1. 代码文件与行号
- **Desktop 路径**：
  - `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx:104-164`
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:477-500`
- **参考原型路径**：
  - `reference/chat-composer-component/css/flow/thinking.css:6-172`
  - `reference/chat-composer-component/js/components/ThinkingBlock.js:1-120`

### 2. 核心缺陷与差距比对

| 视觉/交互要素 | 参考原型规范 (`reference/flow/thinking.css`) | Desktop 现状 (`TimelineThoughtSection.tsx`) | 严重级别 |
|---|---|---|---|
| **外层容器** | `border: none; background: transparent;` 仅左侧内缩 `0.35em`，与正文流浑然一体 | `.thoughtTimelineSection` 带有实体灰底 + 1px 灰色边框，呈现厚重卡片感 | 🔴 高 |
| **标题与文案** | 极简 `思考了 3.4秒 >` 或实时态 `思考中 · 1.8秒 >` | 渲染复杂的 `第 N 阶段思考 · 3.4s · 共 1,234 字 (行内已截断)` | 🟡 中 |
| **图标** | 仅使用 Lucide Chevron 箭头，展开时 90° 弹性旋转 | 渲染 `BrainCircuit` / `Sparkles` + 独立的放大镜弹窗按钮 | 🟡 中 |
| **数字动效** | `font-variant-numeric: tabular-nums` 零抖动秒数跳动 | 简单字符串拼接，未约束等宽跳动 | 🟢 低 |
| **展开遮罩** | 上下两端具备 `linear-gradient` 白色渐变透明遮罩（`fade::before/after`） | 无渐变遮罩，直接截断并强插一个全宽 Button 操作条 | 🔴 高 |

### 3. 具体整改方案
1. 重构 `TimelineThoughtSection.tsx`，移除外层 `.thoughtTimelineSection` 的灰色背景和边框。
2. 引入原型标准结构：
   ```tsx
   <div className="flow-thinking" data-open={isOpen} data-live={isLive}>
     <button type="button" className="flow-thinking__head" onClick={() => setIsOpen(!isOpen)}>
       <span className="flow-thinking__label">{isLive ? '思考中' : '思考了'}</span>
       <span className="flow-thinking__sep">·</span>
       <span className="flow-thinking__tick">
         <span className="flow-thinking__tick-num">{durationSec}</span>秒
       </span>
       <span className="flow-thinking__chevron">
         <Lucide.ChevronRight size={12} />
       </span>
     </button>
     {isOpen && (
       <div className={`flow-thinking__fade ${isOverflow ? 'is-overflowing' : ''}`}>
         <div className="flow-thinking__body">{content}</div>
       </div>
     )}
   </div>
   ```
3. 在 `ChatMessageRow.module.css` 移植 `thinking.css` 中的上下 20px 渐变遮罩与 90° spring 旋转动效。

---

## 2.2 步骤进度（Plan Step & Milestone Spine）与呼吸脉冲态差距

### 1. 代码文件与行号
- **Desktop 路径**：
  - `apps/crish-desktop/src/components/chat-message-row/PlanApprovalRow.tsx:18-46`
  - `apps/crish-desktop/src/components/workspace/PlansSection.tsx:58-107`
- **参考原型路径**：
  - `reference/chat-composer-component/css/flow/plan.css:1-120`
  - `reference/chat-composer-component/CONVERSATION_FLOW_SPEC.md:520-536`

### 2. 核心缺陷与差距比对
- **缺乏流内步骤脊柱线（Milestone Spine）**：
  - 原型规范：`flow-plan-root` 包含竖直连续的 `0.75px` 贯穿连接线（`flow-plan-step::after`），从上一个步骤圆圈中心精准连到下一个步骤；
  - Desktop 现状：没有步骤脊柱线，仅在 `PlanApprovalRow.tsx` 中简单展示一个 `批准此计划` 按钮，或者在右侧工作区 `PlansSection.tsx` 中平铺展示 Cron 卡片。
- **状态圆圈指示器（Step Numbers）差距**：
  - 原型规范：16x16px 圆形徽标，已完成显示实心黑色/勾号 `✓`，进行中呈现翡翠绿呼吸光晕（`box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15)` 配合 `pulse` 动画），未开始呈现淡灰圆角圈；
  - Desktop 现状：完全缺失流式步骤圆圈徽标与脉冲呼吸态。

### 3. 具体整改方案
1. 新建 `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestoneSection.tsx`；
2. 落地 `plan.css` 结构，支持 `is-done`, `is-running`, `is-pending` 三态，并在步骤下方以 `padding-left: 24px` 递归嵌套 Purpose 与 Action。

---

## 2.3 子代理实时运行徽章（Subagent Live Capsule）与双行老虎机差距

### 1. 代码文件与行号
- **Desktop 路径**：
  - `apps/crish-desktop/src/components/agent-card/InlineAgentPanel.tsx:62-150`
  - `apps/crish-desktop/src/components/agent-card/InlineAgentPanelHeader.tsx:78-170`
- **参考原型路径**：
  - `reference/chat-composer-component/css/flow/subagent.css:1-150`
  - `reference/chat-composer-component/js/components/SubagentRoot.js:1-90`

### 2. 核心缺陷与差距比对
- **容器与排版过度设计**：
  - 原型规范（《CONVERSATION_FLOW_SPEC.md》§7.5）：默认**严格限制为两行**。第一行：`[›] 子任务 · {name} [dot] 8s`（或实时徽章 `⚡ {name} subagent 工作中 1.8秒`）；第二行：`[列1老虎机] · [列2] · [列3]` 实时追踪微轨迹。展开时为限高 240~320px 的单一内缩面板；
  - Desktop 现状：`InlineAgentPanel.tsx` 违规在消息流内挂载了包含完整 `InlineAgentComposer` 输入框、停止按钮组、待审批角标等重量级控件，严重撑爆对话流高度。
- **缺少实时运行闪电徽章与老虎机滚动**：
  - Desktop 使用通用的 `loading-spinner` 旋转方块，未对齐原型中高质感的 `⚡` 闪电脉冲与垂直滚动（Slot-machine Roller）多列动效。

### 3. 具体整改方案
1. 重构 `InlineAgentPanelHeader.tsx`，退役内联多余按钮，收敛为标准双行：
   - Line 1：`<span className="subagent-badge-live">⚡ {name} subagent 工作中 {duration}s</span>`
   - Line 2：1~3 列的老虎机轨迹预览；
2. 展开区域移除内嵌 Composer，统一复用主流的 `Thinking` / `Purpose` / `Action` 组件。

---

## 2.4 代码产物胶囊（Artifact Chip）与实时同步线（Sync Line）差距

### 1. 代码文件与行号
- **Desktop 路径**：
  - `apps/crish-desktop/src/components/chat-tool-call/ToolCallHeader.tsx:84-140`
  - `apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:34-110`
- **参考原型路径**：
  - `reference/chat-composer-component/css/flow/artifact-notebook.css:1-120`
  - `reference/chat-composer-component/js/components/ArtifactChip.js:1-60`

### 2. 核心缺陷与差距比对
- **产物未形成胶囊形态**：
  - 原型规范：生成的 Markdown/文件产物呈现为 `📄 已生成 [ PE-08-session-loop-ipc-batcher ]`，胶囊文字带绿色下划线（`#059669`），悬浮或点击可触发 Notebook 浮层或在右侧面板打开；
  - Desktop 现状：将代码产物当作普通的 `write_to_file` 工具调用输出，混杂在通用工具行中，无专属的 `ArtifactChip` 实体。
- **缺少实时同步提示线**：
  - 原型规范：后台同步或推送更新时，呈现 `🟢 正在同步...` 极简呼吸绿点与轻量文本；
  - Desktop 现状：直接显示粗糙的加载菊花或无任何状态感知。

---

## 2.5 禁令违规排查（绿勾墙、方块 Spinner、重卡片阴影）

### 1. 绿勾墙违规（Violations of "Green Checkmark Wall" Ban）
- **代码位置**：`apps/crish-desktop/src/components/chat-tool-call/ToolCallHeader.tsx:155-158`
  ```tsx
  } else if (tc.status === 'success') {
    inner = (
      <CheckCircle2 size={sz} strokeWidth={sw} color="var(--accent-green)" />
    );
  }
  ```
- **违规定性**：原型的《CONVERSATION_FLOW_SPEC.md》§8.5 / §8.7 **明确严禁「绿勾墙」**。工具执行成功默认应当**无图标**或采用极淡的中性色点，绝不允许每一行都堆砌高饱和的绿色勾号图标。

### 2. 方块与粗边框 Spinner 违规
- **代码位置**：`ToolCallHeader.tsx:150-153`、`InlineAgentPanelHeader.tsx:90-93`
  ```tsx
  <span className="loading-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
  ```
- **违规定性**：原型的所有运行态均采用 `5~6px` 柔和圆点脉冲动效（`flow-pulse-dot`），禁止使用突兀的旋转边框菊花。

---

# 三、维度二：通用展开面板与菜单体系（Smart Expandable Panel）审查

## 3.1 单层纯色发丝边框与同心圆角结构审查

### 1. 原型与 Desktop 结构规范对照

| 规范要素 | 参考原型 (`reference/smart-expandable-panel/`) | Desktop 现状 (`ui/Menu/Menu.module.css`) | 适配差距说明 |
|---|---|---|---|
| **外层圆角** | `--sep-radius-outer: 14px`（或 16px） | `var(--radius-lg, 8px)` | 过方，缺乏现代几何美感 |
| **内边距** | `--sep-padding: 6px` | `var(--space-1, 4px)` | 过窄，导致选项贴边 |
| **内层圆角** | `calc(var(--sep-radius-outer) - var(--sep-padding)) = 8px` | `var(--radius-md, 6px)` | 破坏同心几何公式 |
| **发丝边框** | 实体单层 1px：浅色 `#e2dfd9` / 深色 `#2b2926` | 动态混色 `1px solid var(--hairline-strong)` | 浅色下不够纯净，深色下边界模糊 |
| **毛玻璃与阴影** | 28px blur + 160% saturate + 4 层扩散环境光投影 | 单层 `box-shadow: var(--shadow-lg)` | 缺乏顶层 1px 高光（Specular Highlight）与通透感 |

---

## 3.2 Zero-Canvas SVG 多边形 Safe-Aim 轨迹保护审查

### 1. 代码文件与行号
- **Desktop 现状路径**：`apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts:1-150`
- **参考原型路径**：`reference/smart-expandable-panel/js/safe-aim.js:1-152`

### 2. 缺陷深度剖析
- **Desktop 实现残缺**：Desktop 中的 `SafeTriangle.ts` 仅仅是一个独立的计算类，依赖组件手动监听 `mousemove` 并通过 300ms `setTimeout` 进行状态挂起。全仓仅有 `ModelBadgePickerMenu.tsx` 局部接入，其余全部弹窗均处于无保护状态。
- **原型极致方案**：`safe-aim.js` 采用现代 **Zero-Canvas 方案**，在 DOM 树全局注入单例 `<svg id="sepSafeAimOverlay"><polygon points="..." /></svg>`，实时根据鼠标坐标与子菜单 Rect 绘制透明 SVG 多边形碰撞体，从物理 DOM 层阻止下层菜单项的 `mouseenter` 事件，零延迟、零定时器误差，斜向滑动 100% 丝滑稳定。

---

## 3.3 WAI-ARIA 全键盘漫游与双向级联导航协议审查

### 1. 代码文件与行号
- **Desktop 路径**：`apps/crish-desktop/src/components/ui/Menu/menuKeyNavigation.ts:1-80`
- **参考原型路径**：
  - `reference/smart-expandable-panel/js/keyboard-nav.js:1-110`
  - `reference/smart-expandable-panel/react/SmartExpandablePanel.tsx:315-355`

### 2. 差距比对
- **缺少双向多级展开协议**：
  - 原型标准：按下 `ArrowRight`（`→`）自动展开并进入子级菜单首项；按下 `ArrowLeft`（`←`）或 `Escape` 关闭当前子级并无缝回退到父级项；
  - Desktop 现状：`menuKeyNavigation.ts` 仅处理了 `ArrowUp` 与 `ArrowDown` 的单向列表漫游，遇到包含子菜单或折叠项的复杂面板时，无法通过纯键盘完成层级穿透。

---

## 3.4 全仓弹窗与下拉菜单普查（9 大核心菜单逐一剖析）

以下是对 `apps/crish-desktop/src/` 中全部 9 大核心弹窗/下拉菜单的地毯式普查与整改对照：

```
+---------------------------------------------------------------------------------------------------------+
| 全仓菜单组件普查与 SmartExpandablePanel 对齐差距矩阵                                                     |
+----+----------------------------+------------------------------------------+----------------------------+
| 序号| 组件名称 & 文件路径          | 现状缺陷与技术债务                        | 整改方案 (Target Action)   |
+----+----------------------------+------------------------------------------+----------------------------+
| 1  | ModelBadgePickerMenu.tsx   | 手写 SubmenuPortal，未复用统一面板基座；  | 迁移为 SmartExpandablePanel|
|    | (provider/)                | 级联坐标通过 position.ts 手工计算        | 树形 children 配置模式     |
+----+----------------------------+------------------------------------------+----------------------------+
| 2  | ComposePlusMenu.tsx        | 使用老旧 UnifiedSelectPopover 逻辑包装；  | 统一为带分组与快捷键徽章的 |
|    | (chat-composer/)           | 图标使用自定义 24px 灰色方块，间距偏大   | 14px 外圆角极简菜单        |
+----+----------------------------+------------------------------------------+----------------------------+
| 3  | PermissionModeMenu.tsx     | 药丸开关与外点关闭逻辑有竞态；缺少副标题 | 接入 SmartExpandablePanel  |
|    | (chat-composer/)           | 矩阵说明（Readonly/Plan/Ask/Full）       | 单选 Selectable 列表模式   |
+----+----------------------------+------------------------------------------+----------------------------+
| 4  | ProjectPickerMenu.tsx      | 内嵌手写 Search Input，未对齐无边框搜索栏;| 采用 panel-search-wrapper  |
|    | (chat-card/)               | 删除确认弹窗直接打断菜单流               | 纯发丝搜索头 + ActionRow   |
+----+----------------------------+------------------------------------------+----------------------------+
| 5  | SettingsQuickMenu.tsx      | 主题切换 SegmentedControl 样式与菜单割裂;| 整合为包含 Header / Switch |
|    | (settings/)                | 边框缺少同心几何约束                     | / Navigation 的复合面板    |
+----+----------------------------+------------------------------------------+----------------------------+
| 6  | SkillsMoreMenu.tsx         | 基础 Popover，缺少快捷键与危险项红色强调 | 接入 SmartExpandablePanel  |
|    | (settings-skills/)         |                                          | 支持 danger: true 变体     |
+----+----------------------------+------------------------------------------+----------------------------+
| 7  | TiptapSlashMenu.tsx        | 自行维护 DOM 高度与绝对定位；缺少分类头; | 彻底接入 SmartPanel 渲染层 |
|    | (chat-composer/)           | 键盘选择事件易被 Tiptap 编辑器拦截       | 统一快捷键与分类 Section   |
+----+----------------------------+------------------------------------------+----------------------------+
| 8  | SidebarContextMenus.tsx    | 独立手写的 ContextMenuFlyout；右键坐标   | 采用 calculatePointPosition|
|    | (sidebar/)                 | 溢出计算粗糙                             | 统一右键与点选坐标引擎     |
+----+----------------------------+------------------------------------------+----------------------------+
| 9  | ComposerFusedTrigger.tsx   | 模型与思考深度双触发区，间距与分割线生硬 | 采用原型 Fused Trigger:    |
|    | (chat-composer/)           |                                          | 14px 药丸 + 10px 发丝分割线|
+----+----------------------------+------------------------------------------+----------------------------+
```

---

# 四、维度三：右侧工作区面板与工具栏（Side Panel & Launcher Hub）审查

## 4.1 顶栏双态加号（in-flow 随流 vs pinned 固定）机制差距

### 1. 代码文件与行号
- **Desktop 路径**：`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx:143-182`
- **参考原型路径**：
  - `reference/chat-composer-component/css/composer.css:368-426`
  - `reference/chat-composer-component/index.html:120-160`

### 2. 核心缺陷与差距比对
- **双态加号机制缺失（Dual-State Tab Add Mechanism）**：
  - 原型规范：
    1. 当 Tab 数量较少未发生溢出时，`+` 按钮紧随最后一个 Tab 之后（`.top-bar-new-tab-btn.in-flow`），点击即可在末尾快速追加标签；
    2. 当 Tab 数量增多触发布局容器溢出（`.tree-pane-header.has-overflow`）时，`in-flow` 加号平滑淡隐并收缩宽度至 0，同时在顶栏最右侧固定动作区显示固定的加号（`.top-bar-new-tab-btn.pinned`）；
  - Desktop 现状：`LeafToolTabStrip.tsx` 将加号死板地硬编码在右侧 `.stickyTrailingGroup` 中，无论标签多少都固定在最右侧，完全缺失了原型中随流溢出动态切换的高级交互。

---

## 4.2 16px 微型叉号与 TabStrip 几何尺寸审查

### 1. 代码文件与行号
- **Desktop 路径**：`LeafToolTabStrip.module.css:35-114`
- **参考原型路径**：`reference/chat-composer-component/css/composer.css:445-472`

### 2. 差距比对
- **关闭按钮尺寸与交互质感**：
  - 原型规范：`width: 16px; height: 16px; border-radius: 3px;`，常态下仅维持 `opacity: 0.4` 的弱灰色，Hover 时出现柔和浅灰底色（`rgba(0, 0, 0, 0.08)`），点击区域精准克制；
  - Desktop 现状：Tab 高度为 24px（容器 30px），关闭按钮外边距与内边距不匀称，缺乏平滑过渡动画。
- **最大化与收起按钮**：
  - 原型具备完整的 `.side-panel-btn-maximize`（双向箭头放大至 100% 独占视口）与 `.collapseBtn`；Desktop 目前仅有收起按钮，分屏时缺少一键最大化当前叶的能力。

---

## 4.3 二层功能工具条（Navigation Toolbar）审查

### 1. 原型规范定义
- **参考路径**：`reference/chat-composer-component/css/composer.css:2221-2290`
- **规范结构**：
  - 属于 Side Panel 的 Row 2，高度固定 32px，下接 1px 发丝分割线；
  - 左侧导航区（`side-panel-toolbar-nav`）：包含 26x26px 的「后退」、「前进」、「刷新」动作按钮；
  - 右侧功能区（`side-panel-toolbar-actions`）：包含「在系统默认浏览器打开」、「分屏」等快捷入口；
  - 当处于 Empty 空态时，二层工具条自动隐藏（`is-empty .side-panel-toolbar { display: none; }`）。

### 2. Desktop 现状缺陷
- Desktop 目前将工具栏分散在各个具体的 Panel 内部（如 `BrowserPanel.tsx`, `PreviewToolbar.tsx`），导致不同工具叶的顶栏高度不统一（有的 36px，有的 28px，有的没有导航条），缺乏统一的二层导航框架。

---

## 4.4 空态极简居中启动 Hub 卡片（Launcher Hub）审查

### 1. 代码文件与行号
- **Desktop 路径**：`apps/crish-desktop/src/components/workspace/workspaceEmptyStateActions.tsx:35-90`
- **参考原型路径**：`reference/chat-composer-component/css/composer.css:2310-2395`

### 2. 核心缺陷与差距比对
- **残留测试夹具按钮**：
  - Desktop 现状：在 `WorkspaceEmptyStateLanding` 中依然渲染着测试夹具的 `打开笔记纸面（Strict）` 与 `打开笔记纸面（预览壳）` 两个大按钮，完全属于开发阶段遗留产物；
- **缺失极简 Launcher Hub**：
  - 原型规范：采用居中优雅的 `.side-panel-launcher-hub`（最大宽度 320px），以极轻的垂直列表卡片展示：
    1. 🌐 **应用预览 (App Preview)**：支持输入本地端口或 URL 快速预览；
    2. 📄 **代码产物与文件 (Artifacts & Files)**：快速浏览 AI 生成的变更文档与项目源码；
  - 卡片在 Hover 时仅产生 `rgba(0, 0, 0, 0.025)` 的轻微底色变化，图标从 `var(--text-tertiary)` 柔和提亮至 `var(--text-secondary)`。

---

# 五、维度四：输入区（Composer）四层堆叠与细节审查

## 5.1 Layer 1：浮动权限审批条（PermissionBar）剥离审查

### 1. 代码文件与行号
- **Desktop 路径**：`apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:77-111`
- **参考原型路径**：
  - `reference/chat-composer-component/css/flow/permission-bar.css:1-120`
  - `reference/chat-composer-component/CONVERSATION_FLOW_SPEC.md:609-623`

### 2. 核心缺陷剖析
- **审批依然混入消息流**：Desktop 目前通过 `CompactToolRow.tsx` 在消息流内部渲染 `ApprovalAskCard`（除非通过 slot 扩展绕过）。这违背了《CONVERSATION_FLOW_SPEC.md》核心原则：**「需要用户决策的事（权限/确认）在 Composer 上方独立条，绝不进对话流」**。
- **整改方案**：将所有处于 `pending_approval` 状态的工具调用统一收集至 Composer 外层，作为 Composer 堆叠的第一层横条渲染（包含拒绝、批准、始终允许等快捷按钮）。

---

## 5.2 Layer 2：目标/计划模式条（PlanProgressBar）与 Scrubber 联动审查

### 1. 代码文件与行号
- **Desktop 路径**：`apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx:1-150`
- **参考原型路径**：
  - `reference/chat-composer-component/css/flow/scrubber.css:1-120`
  - `reference/chat-composer-component/DESIGN_SYSTEM.md:36-41`

### 2. 差距比对
- **Scrubber 比例映射缺失**：
  - 原型规范：`FlowScrubber` 采用无轨设计，刻度高度（`heightPercent`）必须严格按真实消息块的高度比例映射，确保快速拖拽与微型地图导航的真实性；
  - Desktop 现状：当前 `FlowScrubber` 刻度高度分布较为机械，且在开启计划模式时，未能与输入框上方的步骤进度条完成双向高亮联动。

---

## 5.3 Layer 3：上下文与引用卡片条（AttachmentBar）审查

### 1. 代码文件与行号
- **Desktop 路径**：
  - `apps/crish-desktop/src/components/chat-composer/ComposerAttachmentBar.tsx:1-120`
  - `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:155-250`
- **参考原型路径**：`reference/chat-composer-component/css/file-cards.css:1-90`

### 2. 差距比对
- **删除按钮与微边框细节**：
  - 原型规范：附件卡片为 28px 高度的圆角 Pill，图片缩略图 27x27px 采用内嵌 `background-clip: padding-box`；删除按钮在 Hover 时以平滑渐变浮现于右上角，且点击卡片直接通过 `onOpenPath` 在右侧文件面板打开预览；
  - Desktop 现状：删除按钮在部分状态下常驻或显示生硬，与单行/多行切换时的布局存在 1px 垂直跳动抖动。

---

## 5.4 Layer 4：主输入区与墨绿实体圆形发送按钮（send-btn-circle）弹性动效审查

### 1. 代码文件与行号
- **Desktop 路径**：
  - `apps/crish-desktop/src/components/chat-composer/ComposerSendControls.tsx:140-185`
  - `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:428-460`
- **参考原型路径**：`reference/chat-composer-component/css/composer.css:1065-1120`

### 2. 核心缺陷与差距比对

```css
/* reference/chat-composer-component/css/composer.css:1065-1102 原型标准动效 */
.send-btn-circle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  width: 0;              /* 默认宽度为 0，完全隐藏且不占位 */
  margin-left: 0;
  opacity: 0;
  transform: scale(0.7);
  border-radius: 50%;
  background: var(--brand); /* #10b981 墨绿实体 */
  color: #fff;
  transition: width 0.3s cubic-bezier(0.22, 1.25, 0.36, 1),
              margin-left 0.3s cubic-bezier(0.22, 1.25, 0.36, 1),
              opacity 0.2s cubic-bezier(0.22, 1.25, 0.36, 1),
              transform 0.3s cubic-bezier(0.22, 1.25, 0.36, 1);
}

.send-btn-circle.active {
  width: 32px;           /* 输入文字后弹性弹出 */
  margin-left: 6px;
  opacity: 1;
  transform: scale(1);
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);
}
```

- **Desktop 现状硬伤**：
  - Desktop 的 `ComposerSendControls.tsx` 使用通用的 `Button` 组件，发送按钮常驻存在（仅通过 `disabled` 控制透明度与禁用态），完全**缺失了宽度由 0 弹出至 32px 的 Spring 弹性展开与收缩微动效**！
  - 发送按钮的背景色使用的是通用 `--accent-primary`（此前甚至被指向了蓝色），未采用高质感的翡翠绿实体填充（`#10b981`）与深绿 Hover（`#059669`）。

---

# 六、全仓整改优先级清单与文件改造实施矩阵

基于上述全方位地毯式审计，现制定如下精准整改实施矩阵，确保每一处代码缺陷均能追溯并彻底根治：

| 阶段 / 优先级 | 涉及模块 | 具体改造目标与整改动作 | 涉及的核心源码文件清单 |
|---|---|---|---|
| **Phase 1 (P0)**<br>基础设计系统与菜单基座 | **Smart Expandable Panel** | 1. 落地全局 Zero-Canvas SVG 多边形 Safe-Aim 保护单例；<br>2. 注入 1px 单层发丝边框与数学同心圆角令牌；<br>3. 重构 `ui/Menu/` 为统一的 SmartExpandablePanel 引擎。 | `styles/tokens.css`<br>`components/ui/Menu/Menu.tsx`<br>`components/ui/Menu/Menu.module.css`<br>`components/ui/internal/SafeTriangle.ts` |
| **Phase 2 (P0)**<br>全仓弹窗与下拉菜单迁移 | **9 大核心菜单** | 1. 将 ModelBadgePicker, ComposePlus, Permission, ProjectPicker, SettingsQuick 等 9 个菜单全面迁移至 SmartExpandablePanel；<br>2. 补齐 WAI-ARIA 双向多级键盘漫游。 | `components/provider/ModelBadgePickerMenu.tsx`<br>`components/chat-composer/ComposePlusMenu.tsx`<br>`components/chat-composer/PermissionModeMenu.tsx`<br>`components/chat-card/ProjectPickerMenu.tsx`<br>`components/settings/SettingsQuickMenu.tsx` |
| **Phase 3 (P0)**<br>输入区四层堆叠与发送动效 | **Chat Composer** | 1. 彻底实现 `send-btn-circle` 墨绿圆钮 0->32px Spring 弹缩展开；<br>2. 顶层挂载独立的 PermissionBar 权限审批条；<br>3. 优化 FusedTrigger 与 AttachmentBar 药丸胶囊。 | `components/chat-composer/ChatComposer.tsx`<br>`components/chat-composer/ComposerSendControls.tsx`<br>`components/chat-composer/ChatComposer.module.css`<br>`components/chat-composer/ComposerAttachmentBar.tsx` |
| **Phase 4 (P1)**<br>消息流与步骤进度有机化 | **Message Stream** | 1. 思考折叠条改用无框极简排版 + 上下渐变遮罩；<br>2. 落地 Plan Milestone 步骤进度脊柱线与脉冲呼吸指示器；<br>3. 子代理收敛为双行老虎机；移除绿勾墙与方块菊花。 | `components/chat-message-row/TimelineThoughtSection.tsx`<br>`components/chat-message-row/ChatMessageRow.module.css`<br>`components/agent-card/InlineAgentPanel.tsx`<br>`components/agent-card/InlineAgentPanelHeader.tsx`<br>`components/chat-tool-call/ToolCallHeader.tsx` |
| **Phase 5 (P1)**<br>右侧工作区面板与工具栏 | **Side Panel & Hub** | 1. TabStrip 实现 `in-flow` vs `pinned` 双态加号与 16px 微型叉号；<br>2. 规范 32px 二层功能工具条；<br>3. 废除 W5-B 夹具按钮，落地居中 Launcher Hub。 | `components/binary-tree/LeafToolTabStrip.tsx`<br>`components/binary-tree/LeafToolTabStrip.module.css`<br>`components/workspace/WorkspaceEmptyState.tsx`<br>`components/workspace/workspaceEmptyStateActions.tsx` |

---
*本审计报告遵循 Conex / Crish 极致架构与 UI 铁律，不妥协、不退避，作为后续像素级重构落地的权威验收对照依据。*
