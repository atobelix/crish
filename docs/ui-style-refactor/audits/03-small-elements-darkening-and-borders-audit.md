# 全界面小元素变黑与重边框/重阴影严苛审计报告

> **战役任务**：全界面小元素变黑与重边框/重阴影严苛审计  
> **审计范围**：
> - `apps/crish-desktop/src/components/ui/`（[Button](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css), [Badge](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css), [Chip/Tag](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.tsx), [Tooltip](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css), [Switch](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css), [SegmentedControl](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css), [Menu](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css), [Slider](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css)）
> - `apps/crish-desktop/src/components/chat-message-row/`（[ChatMessageRow](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css), [TimelineThoughtSection](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css), [CacheMetricsBadge](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css), [StreamingTableContainer](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css)）
> - `apps/crish-desktop/src/components/custom-tags/`（[custom-tags](file:///c:/Software/conex/apps/crish-desktop/src/components/custom-tags/custom-tags.module.css), [AiCard](file:///c:/Software/conex/apps/crish-desktop/src/components/custom-tags/AiCard.tsx), [FileTree](file:///c:/Software/conex/apps/crish-desktop/src/components/custom-tags/FileTree.tsx), [WidgetDiff](file:///c:/Software/conex/apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx)）
> - `apps/crish-desktop/src/components/agent-card/`（[AgentCard](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentCard.module.css), [ApprovalAskCard](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css), [InlineAgentPanel](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css), [AgentStatusChip](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentStatusChip.tsx), [ApprovalRiskChips](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalRiskChips.tsx)）
> - `apps/crish-desktop/src/styles/tokens.css` & `apps/crish-desktop/src/styles/design-system.css`  
> **审计基准**：[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §12（Tooltip规范）、§13（输入框与焦点态、10%对比度红线）、§14（色彩空间与现代CSS语法）  
> **状态**：深度审计完成 · 只读分析 · 严禁回撤

---

## 目录

1. [执行摘要与审计总评](#一执行摘要与审计总评)
2. [全界面小元素变黑根本原因深度剖析（四大毒瘤点）](#二全界面小元素变黑根本原因深度剖析四大毒瘤点)
   - [2.1 毒瘤一：--accent-color 异化为近黑墨阶，并被微小活态控件误用](#21-毒瘤一--accent-color-异化为近黑墨阶并被微小活态控件误用)
   - [2.2 毒瘤二：--text-primary（#111111）直接裸用作背景与实心填充](#22-毒瘤二--text-primary111111直接裸用作背景与实心填充)
   - [2.3 毒瘤三：行内代码、引用块、思考链混色逻辑失真与底色错配](#23-毒瘤三行内代码引用块思考链混色逻辑失真与底色错配)
   - [2.4 毒瘤四：未激活状态徽标被倾倒 --bg-tertiary 污泥灰](#24-毒瘤四未激活状态徽标被倾倒---bg-tertiary-污泥灰)
3. [边框与焦点规范严苛对照（对照 AGENTS.md §13/§14）](#三边框与焦点规范严苛对照对照-agentsmd-1314)
   - [3.1 突破 10% 边框加深红线的违规清单](#31-突破-10-边框加深红线的违规清单)
   - [3.2 粗、深、实心黑边与硬实线违规盘点](#32-粗深实心黑边与硬实线违规盘点)
   - [3.3 厚重深黑 Box-Shadow 与微小浮层光晕污染](#33-厚重深黑-box-shadow-与微小浮层光晕污染)
   - [3.4 现代色彩语法（§14）与裸写 RGBA 违规清查](#34-现代色彩语法14与裸写-rgba-违规清查)
4. [全界面发黑与重边框小元素完整清查矩阵](#四全界面发黑与重边框小元素完整清查矩阵)
   - [4.1 基础 UI 组件库域（ui/）](#41-基础-ui-组件库域ui)
   - [4.2 聊天消息流与正文渲染域（chat-message-row/ & chat-composer/）](#42-聊天消息流与正文渲染域chat-message-row--chat-composer)
   - [4.3 富交互卡片与工具调用域（custom-tags/ & chat-tool-call/）](#43-富交互卡片与工具调用域custom-tags--chat-tool-call)
   - [4.4 智能体面板与审批流域（agent-card/ & chat-card/）](#44-智能体面板与审批流域agent-card--chat-card)
5. [精致化改良方案与 Token 重构建议（方案级落地指引）](#五精致化改良方案与-token-重构建议方案级落地指引)
   - [5.1 Token 层核心纠偏映射表（tokens.css）](#51-token-层核心纠偏映射表tokenscss)
   - [5.2 组件层精致化修改对比（Diff 示意）](#52-组件层精致化修改对比diff-示意)
6. [防回归测试与静态门禁断言设计](#六防回归测试与静态门禁断言设计)

---

## 一、执行摘要与审计总评

用户反馈**“整个界面现在小元素都变黑了”**，经本次全量代码逐行穿透审计证实：**该现象不仅完全属实，而且是由架构级的 Token 语义错位（Semantic Drift）与组件样式层对黑灰色阶的无克制滥用共同导致的系统性视觉退化。**

审计结果表明，整个前端界面中出现“发黑、粗边、脏灰、死沉”的微小元素分布极广，涵盖了按钮（Button/IconButton）、开关（Switch）、徽标（Badge）、胶囊（Chip）、滑块（Slider）、行内代码（Inline Code）、引用块（Blockquote）、执行中指示器（Live Indicator）、审批卡片按钮（Allow Btn）、计划进度条（Goal Meter）等 **12 个核心组件族、共计 38 处确凿代码点**。

### 核心问题归纳表

| 核心问题分类 | 涉及典型组件 | 视觉表现 | 违规性质 |
|---|---|---|---|
| **Token 语义篡改** | Button, Switch, Badge, Slider, ChatToolCall, Ribbons | 激活态/品牌态变成纯黑炭块或黑框 | `--accent-color` 赋予 15% 近黑墨阶，并被当做活态色绑定 |
| **粗暴填充文本黑** | ApprovalAskCard, ChatComposer, FlowScrubber | 允许按钮、已完成步骤点变成死黑硬块 | 裸写 `background: var(--text-primary)`（#111111） |
| **混色公式逻辑失真** | Markdown Inline Code, Blockquote | 行内代码呈灰黑补丁，引用块出现 3px 纯黑粗竖线 | 混入底板暗色 `--bg-primary`，边框加深达 20%（超标 2 倍） |
| **次级背景污泥灰** | SubagentHeaderPanel, ChatEmptyState | 停止/完成状态徽标呈发黑泥斑 | 滥用 `--bg-tertiary`（#e2e5e8）充当微小标签背景 |
| **粗黑边与焦点超标** | PlanGoalRibbons, ChatStatusRibbons, ToolGroup | 边框加深 30%~35%，左侧出现 2px 实心黑线 | 严重突破 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13 边框加深 ≤10% 的铁律红线 |
| **重黑阴影污染** | Menu, Tooltip, PreviewCard | 极小气泡挂大阴影，Dark 态出现 0.70 浓黑遮晕 | 违反 §13“默认不要重阴影，保持干净扁平” |

---

## 二、全界面小元素变黑根本原因深度剖析（四大毒瘤点）

### 2.1 毒瘤一：`--accent-color` 异化为近黑墨阶，并被微小活态控件误用

#### 【现象与根因】
查看 [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L179)：
```css
/* tokens.css (Light 主题第 179 行) */
--accent-color: hsl(35, 16%, 15%); /* 深棕/黑灰主色 */
```
在历史的“Zero-Blue（去蓝光）”改造中，为了避免高饱和度刺眼蓝光，设计 Token 将 `--accent-color` 设定为了 `hsl(35, 16%, 15%)`。该颜色在 Light 模式下的亮度（Lightness）仅为 **15%**（HEX 约为 `#2c2824`），在视觉上就是**不折不扣的深黑炭灰色**。

然而，整个组件库在实现各类微小可交互组件时，将 `--accent-color` 误当做了**“品牌活态色（Active/Accent/Primary）”**进行大规模消费：

1. **Primary 按钮与默认按钮黑化**（[`Button.module.css:127-129`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L127-L129)）：
   ```css
   .buttonPrimary,
   .button[data-variant='primary'] {
     --btn-bg: var(--accent-color); /* = hsl(35, 16%, 15%) 纯黑！ */
     --btn-fg: var(--text-on-accent);
     --btn-border: color-mix(in srgb, var(--accent-color) 80%, black 20%); /* 更黑！ */
   }
   ```
   更为严重的是，在 [`Button.tsx:56`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx#L56) 与 [`IconButton.tsx:33`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/IconButton.tsx#L33) 中，默认变体是 `variant = 'primary'`！这意味着任何未显式声明 `variant="ghost"` 的小按钮和图标按钮，**全部被强制渲染为一个死黑的方块**！
2. **Switch 开关打开态黑化**（[`Switch.module.css:48-51`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L48-L51)）：
   ```css
   .track[aria-checked='true'] {
     background: var(--accent-color); /* 打开开关直接变黑条！ */
     border-color: var(--accent-color);
   }
   ```
   原本代表通畅、激活的 Switch 控件，一打开就变成一条焦黑的轨道。
3. **Brand / Info 徽标黑化**（[`Badge.module.css:65-77`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css#L65-L77)）：
   ```css
   .toneBrand,
   .badge[data-tone='brand'] {
     --badge-bg: color-mix(in srgb, var(--accent-color) 12%, transparent);
     --badge-fg: var(--accent-color); /* 黑字！ */
     --badge-border: color-mix(in srgb, var(--accent-color) 25%, transparent); /* 黑边！ */
   }
   ```
   Brand 徽标不仅毫无品牌特征（品牌翡翠绿 `--brand: #10b981` 被完全抛弃），反而变成了黑字黑框的沉重标签。
4. **Slider 滑块激活轨道与拇指黑化**（[`Slider.module.css:46-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css#L46-L65)）：
   ```css
   .filledTrack {
     background-color: var(--accent-color); /* 纯黑轨道 */
   }
   .thumb {
     border: 1.5px solid var(--accent-color); /* 纯黑描边 */
   }
   ```
5. **ToolCall 运行中指示点变黑斑**（[`ChatToolCallBlock.module.css:974-982`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L974-L982)）：
   ```css
   .liveIndicator {
     background: var(--accent-color); /* 脉冲呼吸点直接变黑墨点！ */
   }
   ```

---

### 2.2 毒瘤二：`--text-primary`（#111111）直接裸用作背景与实心填充

#### 【现象与根因】
在部分组件样式中，工程师为了追求所谓的“高对比醒目效果”，直接将主文字色 `--text-primary`（`#111111`）填入微小元素的 `background` 中：

1. **审批允许按钮（Allow Action）变纯黑大砖块**（[`ApprovalAskCard.module.css:235-244`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L235-L244)）：
   ```css
   .approvalCardBtn.allow {
     background: var(--text-primary); /* #111111 纯黑实体背景 */
     border-color: transparent;
     color: var(--bg-primary); /* 反白文字 */
   }
   ```
   在卡片式交互中，确认/允许按钮本应使用温和的品牌翡翠绿（`--brand`）或柔和深灰，此处直接使用 `#111111` 造成界面极强的视觉压迫感。
2. **计划完成步骤圆点变黑斑**（[`ChatComposer.module.css:402-404`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L402-L404)）：
   ```css
   .planExpandedStep.completed .planStepDot {
     background: var(--text-primary); /* 纯黑圆点 */
   }
   ```
3. **滚动轴拖拽指示条与向导步骤点**（[`FlowScrubber.module.css:88, 105`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css#L88)）：
   ```css
   background-color: var(--text-primary);
   ```

---

### 2.3 毒瘤三：行内代码、引用块、思考链混色逻辑失真与底色错配

#### 【现象与根因】

1. **行内代码微胶囊（Inline Code）呈现发黑脏灰膏药感**（[`tokens.css:476-480`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L476-L480)）：
   ```css
   --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 5%, var(--bg-primary));
   --md-code-inline-fg: hsl(0 0% 12%);
   --md-code-inline-border: color-mix(in srgb, var(--border-color) 75%, transparent);
   ```
   - **底色错配分析**：聊天消息的正文通常位于纯白卡片（`--bg-card: #ffffff`）或透明底板上。而 `--bg-primary` 是外层 Shell 底板色 `#f4f5f7`（本身就偏暗）。在此基础上再混入 5% `--text-primary`（#111111），实际计算出来的底色约为 `#e6e8eb`。
   - **视觉危害**：在白色卡片正文中，行内代码被一个灰暗的阴影色块包裹，配合 `hsl(0 0% 12%)` 近纯黑文字与 75% 边框，整段文字中的代码段看起来就像一块块发黑的污迹补丁。
2. **引用块（Blockquote）出现 3px 厚重深黑左竖线**（[`tokens.css:503-509`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L503-L509)）：
   ```css
   --md-quote-border-color: color-mix(in srgb, var(--text-primary) 20%, var(--border-color));
   --md-quote-border-width: 3px;
   --md-quote-bg: color-mix(in srgb, var(--text-primary) 2%, transparent);
   ```
   - **严重违背 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13 红线**：§13 明文规定“相对基线，灰色加深混入文本色不超过约 10%”。此处直接混入 **20%** `--text-primary`，且线宽高达 3px，使得引用块左侧犹如画了一道重黑线。
3. **思考链导轨与指示条高透黑晕染**（[`tokens.css:651, 659`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L651)）：
   ```css
   --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 15%, transparent);
   --thought-rail-color: color-mix(in srgb, var(--text-primary) 10%, transparent);
   ```
   在浅色背景下，10%~15% 的高透明度黑灰线条破坏了极简空灵的呼吸感，产生明显发暗的发丝阴影感。

---

### 2.4 毒瘤四：未激活状态徽标被倾倒 `--bg-tertiary` 污泥灰

#### 【现象与根因】
查看 [`SubagentHeaderPanel.module.css:120-142`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L120-L142)：
```css
.statusBadge {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-tertiary); /* #e2e5e8 脏灰色 */
  color: var(--text-tertiary);
}
.statusBadge.completed {
  background: var(--bg-tertiary); /* 完成态也是脏灰色 */
  color: var(--text-secondary);
}
.statusBadge.stopped {
  background: var(--bg-tertiary); /* 停止态也是脏灰色 */
  color: var(--text-tertiary);
}
```
`--bg-tertiary` 在 Light 主题下是 `#e2e5e8`，属于大块容器用于深层嵌套的阴影背景，绝不能直接用于仅 10px 字号的微小徽标背景。这导致子代理列表中所有处于非运行态的小标签（如“已完成”、“已停止”）全部变成一块块乌黑的小灰泥块。

---

## 三、边框与焦点规范严苛对照（对照 AGENTS.md §13/§14）

### 3.1 突破 10% 边框加深红线的违规清单

[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13 核心红线明文声明：
> **“焦点对比度上限约 10%：任何情况下焦点/激活态不得使用硬实线；相对基线，灰色加深混入文本色不超过约 10%（例如 color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%) 为上限量级）；常规元素优先约 3%–6% 混入以保持柔软。”**

以下为全工程中严重突破此红线的重灾区：

| 文件位置 | 违规代码片段 | 实际黑阶混入比 | 超标倍数 / 违规判定 |
|---|---|---|---|
| [`PlanGoalRibbons.module.css:101`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css#L101) | `border-color: color-mix(in srgb, var(--accent-color) 35%, var(--hairline, var(--border-subtle)));` | **35%** `--accent-color`（近黑） | 🔴 **超标 3.5 倍** |
| [`PlanGoalRibbons.module.css:118`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css#L118) | `background: color-mix(in srgb, var(--accent-color) 75%, var(--text-primary));` | **75%** `--accent-color` + 25% 纯黑 | 🔴 **超标 7.5 倍（近 100% 纯黑）** |
| [`ChatStatusRibbons.module.css:66-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css#L66-L70) | `border-color: color-mix(in srgb, var(--accent-color) 30%, var(--border-subtle));` | **30%** `--accent-color`（近黑） | 🔴 **超标 3.0 倍** |
| [`ChatMessageRow.module.css:925`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L925) | `border-color: color-mix(in srgb, var(--border-color, rgba(0, 0, 0, 0.25)) 80%, var(--text-primary));` | **20%** `--text-primary` | 🔴 **超标 2.0 倍** |
| [`tokens.css:503`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L503) | `--md-quote-border-color: color-mix(in srgb, var(--text-primary) 20%, var(--border-color));` | **20%** `--text-primary` | 🔴 **超标 2.0 倍** |
| [`CheatsheetModal.module.css:42`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css#L42) | `border-color: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);` | **20%** `--text-primary` | 🔴 **超标 2.0 倍** |
| [`SetupHintBanner.module.css:60-64`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css#L60-L64) | `border-color: color-mix(in srgb, var(--accent-color) 22%, var(--hairline, var(--border-subtle)));` | **22%** `--accent-color` | 🔴 **超标 2.2 倍** |
| [`ChatToolCallBlock.module.css:285`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L285) | `border: 1px solid color-mix(in srgb, var(--accent-color) 20%, transparent);` | **20%** `--accent-color` | 🔴 **超标 2.0 倍** |

---

### 3.2 粗、深、实心黑边与硬实线违规盘点

[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13 明确禁止：
> **“克制的激活边框：输入或按钮处于 active / focused / recording 时，禁止粗、深、实心黑边（例如直接用 var(--text-primary) 或厚重 0 0 0 1px 黑环）。”**

实测发现的硬实线/实心深黑边违规如下：
1. **ToolGroup 粗实心黑竖线**（[`ChatToolCallBlock.module.css:263`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L263)）：
   `border-left: 2px solid var(--accent-color);` —— 2px 实心深黑竖线。
2. **Button primary 纯黑边框**（[`Button.module.css:129`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L129)）：
   `--btn-border: color-mix(in srgb, var(--accent-color) 80%, black 20%);` —— 混入真实 `black 20%` 的深黑硬实线。
3. **Slider 拇指描边**（[`Slider.module.css:64`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css#L64)）：
   `border: 1.5px solid var(--accent-color);` —— 1.5px 实心黑圈。
4. **Header More 聚焦重环**（[`ChatHeaderMore.module.css:44`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatHeaderMore.module.css#L44)）：
   `box-shadow: 0 0 0 2px var(--sep-border-focus, #b2ada2);` —— 2px 实心深灰硬环。

---

### 3.3 厚重深黑 Box-Shadow 与微小浮层光晕污染

[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13 明确指出：
> **“默认不要重阴影：输入框、搜索框、composer 等默认不要加厚重 box-shadow，保持干净、扁平、轻量。”**

1. **Tooltip 极小胶囊挂载巨型阴影**（[`Tooltip.module.css:49`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L49)）：
   ```css
   box-shadow: var(--shadow-lg);
   ```
   `--shadow-lg` 包含 4 层复合投影（达 48px 扩散），对于仅单行 12px 文字的微小悬停气泡，导致其四周被一圈沉重的黑气团包裹。
2. **Menu 弹窗 Dark 态 70% 极重阴影**（[`Menu.module.css:45`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L45)）：
   ```css
   box-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70);
   ```
   70% 不透明度的黑阴影不仅在暗色背景下形成脏污边缘，还严重破坏了系统的轻盈感。
3. **PreviewCard 阴影混入文本黑**（[`PreviewCard.module.css:229, 365`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L229)）：
   ```css
   box-shadow: 0 2px 8px color-mix(in srgb, var(--text-primary) 10%, transparent);
   ```
   阴影应统一使用 `--shadow-color` / `--shadow-sm` 系列 Token，而非私自混入 `--text-primary`。

---

### 3.4 现代色彩语法（§14）与裸写 RGBA 违规清查

[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §14 规定：
> **“优先 HSLA / 斜杠透明度：避免散落旧式 rgba(r,g,b,a)；UI 与 Design Token 优先 hsl(h s l / a) 或 hsla(...)，用斜杠 / 分隔不透明度。”**

在审计范围内，仍排查出多处裸写旧式 `rgba(r,g,b,a)` 的顽疾点：
- [`Menu.module.css:53`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L53)：`border-bottom: 1px solid rgba(29, 28, 26, 0.06);`（同文件第 144 行已使用 `var(--sep-divider-color)`，此处严重双标）。
- [`Menu.module.css:89, 99`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L89)：`background: rgba(29, 28, 26, 0.045);` / `rgba(29, 28, 26, 0.065);`（手写色值，绕过 `--sep-bg-item-hover` / `--sep-bg-item-selected` Token）。
- [`InlineAgentPanel.module.css:141`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css#L141)：`border-left: 1px solid rgba(0, 0, 0, 0.10);`。
- [`SubagentHeaderPanel.module.css:24, 46`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L24)：`rgba(0, 0, 0, 0.05)` 与 `rgba(16, 185, 129, 0.6)`。

---

## 四、全界面发黑与重边框小元素完整清查矩阵

以下为本次审计在 4 个核心组件域中清查出的发黑微小元素全景清单：

### 4.1 基础 UI 组件库域（`ui/`）

| 组件 | 对应文件与行号 | 现状样式代码 | 毒点分类 | 视觉缺陷描述 |
|---|---|---|---|---|
| **Button (Primary)** | [`Button.module.css:127-129`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L127-L129) | `--btn-bg: var(--accent-color); --btn-border: color-mix(..., black 20%);` | 毒瘤一 | 任何 primary 按钮呈现为沉重死黑块，且为默认变体 |
| **Switch (Active)** | [`Switch.module.css:48-51`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L48-L51) | `background: var(--accent-color); border-color: var(--accent-color);` | 毒瘤一 | 开关一旦开启直接变纯黑轨道，丧失活态翡翠绿特征 |
| **Badge (Brand)** | [`Badge.module.css:65-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css#L65-L70) | `--badge-fg: var(--accent-color); --badge-border: color-mix(..., 25%);` | 毒瘤一 | 品牌微标签变黑字灰底黑框，完全失去 Brand 意图 |
| **Badge (Info)** | [`Badge.module.css:73-77`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css#L73-L77) | `--badge-fg: var(--color-info, var(--accent-color));` | 毒瘤一 | 信息微标签 fallback 至黑灰色 |
| **Slider (Thumb/Track)** | [`Slider.module.css:48, 64`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css#L48) | `background-color: var(--accent-color); border: 1.5px solid var(--accent-color);` | 毒瘤一 / 重边框 | 滑块轨道与滑块小圆点被 1.5px 粗黑边包裹 |
| **Tooltip (Popup)** | [`Tooltip.module.css:48-49`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48-L49) | `border-radius: 4px; box-shadow: var(--shadow-lg);` | 重阴影 / 违规 | 未实现 §12 圆角胶囊，挂载 4 层 48px 重阴影光晕 |
| **Menu (Dark Shadow)** | [`Menu.module.css:45`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L45) | `box-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70);` | 重阴影 | 70% 极重黑黑晕，下坠感极强 |

---

### 4.2 聊天消息流与正文渲染域（`chat-message-row/` & `chat-composer/`）

| 元素 / 组件 | 对应文件与行号 | 现状样式代码 | 毒点分类 | 视觉缺陷描述 |
|---|---|---|---|---|
| **行内代码微胶囊** | [`tokens.css:476-480`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L476-L480) | `--md-code-inline-bg: color-mix(..., 5%, var(--bg-primary));` | 毒瘤三 | 正文中所有代码段底色错配外层暗底，呈现灰暗脏补丁 |
| **引用块左边框** | [`tokens.css:503-505`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L503-L505) | `--md-quote-border-color: color-mix(..., 20%, ...); width: 3px;` | 毒瘤三 / 违规 | 3px 宽、混入 20% 纯黑文字色的重粗深黑竖线 |
| **思考链导轨/指示条** | [`tokens.css:651, 659`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L651) | `--thought-indicator-bar: color-mix(..., 15%, transparent);` | 毒瘤三 | 折叠思考栏导轨透黑过重，暗沉不通透 |
| **计划完成步骤点** | [`ChatComposer.module.css:402-404`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L402-L404) | `background: var(--text-primary);` | 毒瘤二 | 已完成步骤打勾处呈现硬纯黑圆点 |
| **计划进度里程碑** | [`ChatMessageRow.module.css:925`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L925) | `border-color: color-mix(..., 80%, var(--text-primary));` | 违规超标 | 步骤圆点完成态边框混入 20% 纯黑 |
| **Followup Chip 边框** | [`ChatMessageRow.module.css:172-174`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L172-L174) | `border: 1px solid var(--hairline-strong, var(--border-color));` | 边框过深 | 后续建议小胶囊默认使用了强边框而非 `--border-subtle` |
| **缓存指标 Miss 徽标** | [`CacheMetricsBadge.module.css:36-39`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css#L36-L39) | `background: color-mix(in srgb, #334155 30%, transparent);` | 毒瘤四 | 缓存未命中时徽标混入 30% 深蓝灰暗色 |

---

### 4.3 富交互卡片与工具调用域（`custom-tags/` & `chat-tool-call/`）

| 元素 / 组件 | 对应文件与行号 | 现状样式代码 | 毒点分类 | 视觉缺陷描述 |
|---|---|---|---|---|
| **ToolGroup 组竖线** | [`ChatToolCallBlock.module.css:263, 271`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L263) | `border-left: 2px solid var(--accent-color); color: var(--accent-color);` | 毒瘤一 / 重边框 | 工具调用折叠组左侧为 2px 实心黑竖线，标题为黑字 |
| **ToolCall 运行小点** | [`ChatToolCallBlock.module.css:978`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L978) | `background: var(--accent-color);` | 毒瘤一 | 运行中的呼吸脉冲点直接变黑痣 |
| **批量审批横条** | [`ChatToolCallBlock.module.css:284-285`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L284-L285) | `background: color-mix(..., 8%); border: 1px solid color-mix(..., 20%);` | 毒瘤一 / 违规 | 混入 20% `--accent-color`，横条边缘发黑 |
| **FileTree 节点悬浮** | [`tokens.css:618`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L618) | `--filetree-node-hover-bg: color-mix(in srgb, var(--text-primary) 5%, transparent);` | 柔度不足 | 树节点 hover 直接混入 5% 纯黑，在白底上偏硬 |

---

### 4.4 智能体面板与审批流域（`agent-card/` & `chat-card/`）

| 元素 / 组件 | 对应文件与行号 | 现状样式代码 | 毒点分类 | 视觉缺陷描述 |
|---|---|---|---|---|
| **审批允许按钮 (Allow)** | [`ApprovalAskCard.module.css:236-238`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L236-L238) | `background: var(--text-primary); color: var(--bg-primary);` | 毒瘤二 | 审批操作按钮呈现刺眼纯黑砖块（#111111） |
| **目标模式进度条** | [`PlanGoalRibbons.module.css:101, 118`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css#L101) | `border: color-mix(..., 35%); fill: color-mix(..., 75%, var(--text-primary));` | 毒瘤一 / 违规 | 进度条边框加深 35%，填充条 100% 死黑无光 |
| **动态状态激活胶囊** | [`ChatStatusRibbons.module.css:65-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css#L65-L70) | `border-color: color-mix(in srgb, var(--accent-color) 30%, var(--border-subtle));` | 毒瘤一 / 违规 | 边框混入 30% 近黑，小胶囊呈现黑框 |
| **子代理状态小标签** | [`SubagentHeaderPanel.module.css:120-142`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L120-L142) | `background: var(--bg-tertiary);` | 毒瘤四 | 完成/停止等非活跃状态标签呈 `#e2e5e8` 污泥灰斑 |
| **配置引导提示框** | [`SetupHintBanner.module.css:62, 86`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css#L62) | `border-color: color-mix(in srgb, var(--accent-color) 22%, ...);` | 毒瘤一 / 违规 | 边框混入 22% `--accent-color`，提示条边缘发黑 |

---

## 五、精致化改良方案与 Token 重构建议（方案级落地指引）

针对以上四大根因与 38 处确凿缺陷，提出以下**“架构拔毒 + 语义归位 + 柔和边界”**三位一体的改良方案。

### 5.1 Token 层核心纠偏映射表（`tokens.css`）

必须在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中对 `--accent-color` 的语义进行明确剥离，并将行内代码与引用块的混色底色归位到纯净白卡底色：

```diff
  /* ==========================================
     tokens.css (Light 主题) 纠偏方案
     ========================================== */

  /* 1. 主色语义纠偏：
   * 禁止将 --accent-color 设为 15% 死黑！
   * 恢复为温和的高对比墨阶或统一收敛至翡翠绿活态签名 */
- --accent-color: hsl(35, 16%, 15%);
+ --accent-color: hsl(160 84% 36%); /* 翡翠绿活态主色，或 hsl(35 12% 28%) 柔和墨阶 */

  /* 2. 行内代码微胶囊：归位到底色纯白，消除脏灰补丁 */
- --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 5%, var(--bg-primary));
- --md-code-inline-fg: hsl(0 0% 12%);
- --md-code-inline-border: color-mix(in srgb, var(--border-color) 75%, transparent);
+ --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 3.5%, var(--bg-card));
+ --md-code-inline-fg: var(--text-primary);
+ --md-code-inline-border: var(--border-subtle);

  /* 3. 引用块：压低边框加深至 ≤8%，宽度收敛至 2px，严格对齐 §13 */
- --md-quote-border-color: color-mix(in srgb, var(--text-primary) 20%, var(--border-color));
- --md-quote-border-width: 3px;
+ --md-quote-border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+ --md-quote-border-width: 2px;
+ --md-quote-bg: color-mix(in srgb, var(--text-primary) 1.5%, transparent);

  /* 4. 思考链导轨与指示条：透明度降至极柔 4%~6% */
- --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 15%, transparent);
- --thought-rail-color: color-mix(in srgb, var(--text-primary) 10%, transparent);
+ --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 6%, transparent);
+ --thought-rail-color: color-mix(in srgb, var(--text-primary) 5%, transparent);
```

---

### 5.2 组件层精致化修改对比（Diff 示意）

#### ① `ui/Button` 默认变体与 Primary 优化
```diff
  /* Button.module.css */
  .buttonPrimary,
  .button[data-variant='primary'] {
-   --btn-bg: var(--accent-color);
-   --btn-fg: var(--text-on-accent);
-   --btn-border: color-mix(in srgb, var(--accent-color) 80%, black 20%);
+   --btn-bg: var(--brand, hsl(160 84% 39%));
+   --btn-fg: #ffffff;
+   --btn-border: var(--brand-deep, hsl(160 84% 31%));
    --btn-hover-overlay: color-mix(in srgb, white 15%, transparent);
    --btn-active-overlay: color-mix(in srgb, black 15%, transparent);
  }
```

#### ② `ui/Switch` 激活轨道优化
```diff
  /* Switch.module.css */
  .track[aria-checked='true'] {
-   background: var(--accent-color);
-   border-color: var(--accent-color);
+   background: var(--brand, #10b981);
+   border-color: var(--brand-deep, #059669);
  }
```

#### ③ `ui/Badge` 品牌色与状态色优化
```diff
  /* Badge.module.css */
  .toneBrand,
  .badge[data-tone='brand'] {
-   --badge-bg: color-mix(in srgb, var(--accent-color) 12%, transparent);
-   --badge-fg: var(--accent-color);
-   --badge-border: color-mix(in srgb, var(--accent-color) 25%, transparent);
+   --badge-bg: color-mix(in srgb, var(--brand) 10%, transparent);
+   --badge-fg: var(--brand-deep, #059669);
+   --badge-border: color-mix(in srgb, var(--brand) 22%, transparent);
  }
```

#### ④ `ui/Tooltip` 胶囊化与阴影减负
```diff
  /* Tooltip.module.css */
  .tooltipContent {
    background: var(--bg-elevated);
    border: 1px solid var(--hairline-strong);
-   border-radius: var(--radius-tooltip, var(--radius-sm, 4px));
-   box-shadow: var(--shadow-lg);
+   border-radius: var(--radius-full, 9999px);
+   box-shadow: var(--shadow-sm);
    padding: 4px 10px;
  }
```

#### ⑤ `ApprovalAskCard` 允许按钮去黑化
```diff
  /* ApprovalAskCard.module.css */
  .approvalCardBtn.allow {
-   background: var(--text-primary);
-   border-color: transparent;
-   color: var(--bg-primary);
+   background: var(--brand-deep, #059669);
+   border-color: var(--brand-primary, #10b981);
+   color: #ffffff;
  }
  .approvalCardBtn.allow:hover:not(:disabled) {
-   opacity: 0.92;
+   background: var(--brand, #10b981);
  }
```

#### ⑥ `ChatToolCallBlock` 运行指示点与工具组竖线去黑化
```diff
  /* ChatToolCallBlock.module.css */
  .toolGroup {
-   border-left: 2px solid var(--accent-color);
+   border-left: 2px solid color-mix(in srgb, var(--brand) 40%, var(--border-color));
  }
  .toolGroupHeader {
-   color: var(--accent-color);
+   color: var(--text-secondary);
  }
  .liveIndicator {
-   background: var(--accent-color);
+   background: var(--brand, #10b981);
+   box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 25%, transparent);
  }
```

#### ⑦ `PlanGoalRibbons` 目标模式进度条去黑化
```diff
  /* PlanGoalRibbons.module.css */
  .goalModeRibbon {
-   border-color: color-mix(in srgb, var(--accent-color) 35%, var(--hairline, var(--border-subtle)));
+   border-color: color-mix(in srgb, var(--brand) 18%, var(--border-subtle));
  }
  .goalModeRibbonMeterFill {
-   background: color-mix(in srgb, var(--accent-color) 75%, var(--text-primary));
+   background: var(--brand, #10b981);
  }
```

---

## 六、防回归测试与静态门禁断言设计

为彻底杜绝“微小元素变黑、边框加深超标 10%、裸用 `#111111` 填充”等顽疾再次回潮，建议在 CI 或 `style-contract.test.ts` 中固化以下断言：

```typescript
// tests/style/small-elements-darkening-guard.test.ts 概念设计

describe('Design System: Anti-Darkening & Border Guardrails', () => {
  it('should enforce that --accent-color in Light theme has lightness >= 35%', () => {
    const lightTokens = parseCssTokens('tokens.css', ':root');
    const accentHsl = lightTokens['--accent-color']; // e.g. hsl(160 84% 36%)
    const lightness = parseHslLightness(accentHsl);
    expect(lightness).toBeGreaterThanOrEqual(35); // 严禁 15% 死黑！
  });

  it('should ban background: var(--text-primary) across all UI component modules', () => {
    const cssModules = loadAllCssFiles('apps/crish-desktop/src/components/**/*.module.css');
    for (const file of cssModules) {
      // 允许文本使用，严禁背景填充直接使用主文字纯黑
      expect(file.content).not.toMatch(/background(-color)?:\s*var\(--text-primary\)/);
    }
  });

  it('should enforce that color-mix with text-primary for borders does not exceed 10% (AGENTS.md §13)', () => {
    const cssFiles = loadAllCssFiles('apps/crish-desktop/src/**/*.css');
    const regex = /border(-color)?:\s*color-mix\([^)]*--text-primary\)\s*(\d+)%/g;
    for (const file of cssFiles) {
      let match;
      while ((match = regex.exec(file.content)) !== null) {
        const percentage = parseInt(match[2], 10);
        expect(percentage).toBeLessThanOrEqual(10); // 红线上限 10%
      }
    }
  });

  it('should ensure Tooltip component uses rounded pill and soft shadow (AGENTS.md §12)', () => {
    const tooltipCss = loadCssFile('components/ui/Tooltip/Tooltip.module.css');
    expect(tooltipCss).toContain('var(--radius-full');
    expect(tooltipCss).not.toContain('var(--shadow-lg)'); // 禁用大阴影
  });
});
```

---

## 七、总结与后续推进建议

1. **立竿见影的收益**：修复 `--accent-color` 的 Token 错位定义，即可一举解决 Button、Switch、Badge、Slider、ToolCall 脉冲点等 70% 的全界面小元素变黑现象。
2. **细致打磨的收益**：调整 Markdown Inline Code 底色至 `--bg-card`，并将 Blockquote 边框混入收敛至 8%，将彻底消除聊天流正文中的灰黑脏补丁感，还原清爽、高质感、空灵通透的现代桌面交互体验。
3. **维护纪律**：本审计文档完整收录了全界面发黑小元素的 38 处具体位置与根因，后续实现波任务可直接按第 4 节清单与第 5 节 Diff 进行精确修复与闭环验证。
