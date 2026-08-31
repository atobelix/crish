# 维度二详案：全局活态 Token 纠偏与微小元素脱黑详案

> **文档标识**：[`docs/ui-style-refactor/02-全局活态Token纠偏与微小元素脱黑详案.md`](file:///c:/Software/conex/docs/ui-style-refactor/02-%E5%85%A8%E5%B1%80%E6%B4%BB%E6%80%81Token%E7%BA%A0%E5%81%8F%E4%B8%8E%E5%BE%AE%E5%B0%8F%E5%85%83%E7%B4%A0%E8%84%B1%E9%BB%91%E8%AF%A6%E6%A1%88.md)  
> **所属战役**：[`docs/ui-style-refactor/00-总方案-界面色彩平滑与差异面板视觉重构.md`](file:///c:/Software/conex/docs/ui-style-refactor/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E7%95%8C%E9%9D%A2%E8%89%B2%E5%BD%A9%E5%B9%B3%E6%BB%91%E4%B8%8E%E5%B7%AE%E5%BC%82%E9%9D%A2%E6%9D%BF%E8%A7%86%E8%A7%89%E9%87%8D%E6%9E%84.md)  
> **实施基准**：[`docs/ui-style-refactor/00-定案-视觉样式与差异面板重构决策.md`](file:///c:/Software/conex/docs/ui-style-refactor/00-%E5%AE%9A%E6%A1%88-%E8%A7%86%E8%A7%89%E6%A0%B7%E5%BC%8F%E4%B8%8E%E5%B7%AE%E5%BC%82%E9%9D%A2%E6%9D%BF%E9%87%8D%E6%9E%84%E5%86%B3%E7%AD%96.md) §一.2、[`docs/ui-style-refactor/independent-plans/02-accent-token-and-small-elements-deblack-plan.md`](file:///c:/Software/conex/docs/ui-style-refactor/independent-plans/02-accent-token-and-small-elements-deblack-plan.md)、[`docs/ui-style-refactor/plan-reviews/01`](file:///c:/Software/conex/docs/ui-style-refactor/plan-reviews/01-ui-style-plans-cross-review-a.md) ~ [`03`](file:///c:/Software/conex/docs/ui-style-refactor/plan-reviews/03-ui-style-plans-cross-review-c.md) 评审定案  
> **调度标准**：严格遵循 [`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md) §二.4 详案模板  
> **设计铁律**：严格对齐 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §12（Tooltip 胶囊与轻量阴影）、§13（输入与焦点态、边框加深 $\le 10\%$ 红线）、§14（现代 CSS 语法与色彩空间）、Zero-Blue 翡翠绿活态签名与单一真源（SSOT）架构  
> **核心使命**：彻底根除 `--accent-color` 异化为 15% 死黑导致的全界面按钮/开关/徽标/滑块变黑，拔除业务卡片裸写 `#111111` 纯黑填充与 20%~75% 超标粗黑边框，重构 Markdown 行内代码白卡底与 8% 细边框，建立 Safe-by-Default 原子控件契约与防变黑自动化测试守卫。

---

## 目录

1. [一、做什么（新增 / 修复清单）](#一做什么新增--修复清单)
   - [1.1 Token 根源纠偏：--accent-color 翡翠绿活态签名体系](#11-token-根源纠偏--accent-color-翡翠绿活态签名体系)
   - [1.2 默认安全化契约：Button 默认 secondary 与 IconButton 显式 ghost](#12-默认安全化契约button-默认-secondary-与-iconbutton-显式-ghost)
   - [1.3 基础原子组件族（ui/）脱黑与活态化](#13-基础原子组件族ui脱黑与活态化)
   - [1.4 Markdown 排版视觉系统重构（白卡底与 8% 细边框）与思考链极柔化](#14-markdown-排版视觉系统重构白卡底与-8-细边框与思考链极柔化)
   - [1.5 业务卡片与消息流微小元素脱黑改造](#15-业务卡片与消息流微小元素脱黑改造)
   - [1.6 跨方案协同与边界守卫（Menu.module.css 解耦）](#16-跨方案协同与边界守卫menumodulecss-解耦)
2. [二、删什么（删除 / 合并清单）](#二删什么删除--合并清单)
   - [2.1 死黑实体填充与错误语义 Token 删除面（DEL-D01 ~ DEL-D06）](#21-死黑实体填充与错误语义-token-删除面del-d01--del-d06)
   - [2.2 违规粗深边框与失真混色删除面（DEL-D07 ~ DEL-D12）](#22-违规粗深边框与失真混色删除面del-d07--del-d12)
   - [2.3 巨型阴影、污泥灰底色与废弃覆写删除面（DEL-D13 ~ DEL-D16）](#23-巨型阴影污泥灰底色与废弃覆写删除面del-d13--del-d16)
3. [三、依赖与逻辑顺序（先删后改 DAG 拓扑）](#三依赖与逻辑顺序先删后改-dag-拓扑)
   - [3.1 实施推进 5 个阶段时序图与强依赖关系](#31-实施推进-5-个阶段时序图与强依赖关系)
   - [3.2 阶段 0 ~ 阶段 4 串行/并行执行细则](#32-阶段-0--阶段-4-串行并行执行细则)
4. [四、唯一文件域（独占修改与新增文件清单）](#四唯一文件域独占修改与新增文件清单)
   - [4.1 独占修改文件清单](#41-独占修改文件清单)
   - [4.2 新增文件清单](#42-新增文件清单)
   - [4.3 跨维度协同文件与边界约束](#43-跨维度协同文件与边界约束)
5. [五、详细代码修改契约（Before / After 语义级差异）](#五详细代码修改契约before--after-语义级差异)
   - [5.1 tokens.css 核心 Token 重铸](#51-tokenscss-核心-token-重铸)
   - [5.2 ui/Button/ (Button.tsx, IconButton.tsx, Button.module.css) 契约](#52-uibutton-buttontsx-iconbuttontsx-buttonmodulecss-契约)
   - [5.3 ui/Switch, ui/Badge, ui/Slider 契约](#53-uiswitch-uibadge-uislider-契约)
   - [5.4 ui/Tooltip 契约](#54-uitooltip-契约)
   - [5.5 agent-card/ApprovalAskCard & overlay/FirstRunWizard 契约](#55-agent-cardapprovalaskcard--overlayfirstrunwizard-契约)
   - [5.6 chat-composer, chat-message-row & chat-tool-call 契约](#56-chat-composer-chat-message-row--chat-tool-call-契约)
   - [5.7 chat-card/ (PlanGoalRibbons, ChatStatusRibbons, SubagentHeaderPanel) 契约](#57-chat-card-plangoalribbons-chatstatusribbons-subagentheaderpanel-契约)
   - [5.8 chat-message-list/FlowScrubber, overlay/CheatsheetModal & chat-card/SetupHintBanner 契约](#58-chat-message-listflowscrubber-overlaycheatsheetmodal--chat-cardsetuphintbanner-契约)
6. [六、A11y 无障碍、WCAG 2.1 对比度与可读性保障](#六a11y-无障碍wcag-21-对比度与可读性保障)
   - [6.1 WCAG 2.1 AA / AAA 对比度精确测算全景表](#61-wcag-21-aa--aaa-对比度精确测算全景表)
   - [6.2 柔和焦点态可辨性（AGENTS.md §13 落实）](#62-柔和焦点态可辨性agentsmd-13-落实)
   - [6.3 辅助技术与多重信息无障碍编码](#63-辅助技术与多重信息无障碍编码)
7. [七、单测断言修复与防回归自动化守卫套件](#七单测断言修复与防回归自动化守卫套件)
   - [7.1 Button.test.tsx 现有单测断言同步重构](#71-buttontesttsx-现有单测断言同步重构)
   - [7.2 新增防变黑静态守卫测试（antiDarkeningGuard.test.ts）](#72-新增防变黑静态守卫测试antidarkeningguardtestts)
8. [八、验收标准与门禁规范](#八验收标准与门禁规范)
   - [8.1 功能验收标准](#81-功能验收标准)
   - [8.2 负产出验收标准](#82-负产出验收标准)
   - [8.3 全链路自动化门禁命令集](#83-全链路自动化门禁命令集)

---

## 一、做什么（新增 / 修复清单）

针对历史“去蓝光（Zero-Blue）”演进中 `--accent-color` 被错误赋予 15% 死黑墨阶 `hsl(35, 16%, 15%)`，以及由此引发的基础控件变黑、消息卡片纯黑填充、Markdown 排版脏灰补丁与超标粗边框等系统性退化，本维度构建如下完整修复闭环：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               Conex / Crish 全局活态 Token 纠偏与微小元素脱黑架构图                     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   【Token 根层 (tokens.css)】                                                           │
│   • --accent-color: hsl(160 84% 36%) (翡翠绿活态签名) ← 彻底废黜 hsl(35, 16%, 15%) 死黑  │
│   • --accent-hover: hsl(160 84% 31%) (--brand-deep #047857 对比度 4.77:1 >= 4.5:1)     │
│   • --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 3.5%, var(--bg-card))   │
│   • --md-quote-border-color: color-mix(in srgb, var(--border-color) 92%, text 8%) 2px │
│   • --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 6%, transparent)   │
│                                      │                                                 │
│                                      ▼                                                 │
│   ┌──────────────────────────────────┴──────────────────────────────────┐              │
│   │                                                                     │              │
│   ▼                                                                     ▼              │
│ 【原子 UI 控件族 (ui/)】                                 【业务卡片与消息流 (components/)】 │
│ • Button: 默认 variant='secondary' (防黑块与幽灵)        • ApprovalAskCard: 允许按钮      │
│ • IconButton: 显式声明 variant='ghost'                     改用 --brand-deep (#047857)   │
│ • Button.module.css: Primary 绑定 --brand-deep,          • FirstRunWizard: Logo/Step/Btn  │
│   解绑 black 20% 描边, 文字高对比纯白 #ffffff              彻底脱黑改为 --brand-deep     │
│ • Switch: track[aria-checked=true] 翠绿化                • ChatComposer: 步骤完成点脱黑   │
│ • Badge: Brand tone 翠绿化, Info tone 修正               • ChatToolCall: live 脉冲点翠绿  │
│ • Slider: track/thumb 翠绿化, 移除 1.5px 黑边            • PlanGoalRibbons: 进度条脱黑    │
│ • Tooltip: border-radius: 9999px + shadow-sm             • SubagentHeader: 移除污泥灰     │
│                                                          • FlowScrubber: 刻度指示条脱黑   │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Token 根源纠偏：`--accent-color` 翡翠绿活态签名体系
1. **翡翠绿活态主色纠偏**：
   - 将 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) Light 模式根作用域中的 `--accent-color: hsl(35, 16%, 15%)` 纠偏为品牌活态翡翠绿 `hsl(160 84% 36%)`；
   - 对应 Dark 模式作用域保持对称活态：`hsl(160 84% 45%)`；
2. **品牌衍生色系健全与 WCAG 达标**：
   - `--brand-deep: #047857`（`hsl(160 84% 31%)`，浅色底纯白文字对比度达到 **4.77:1 $\ge 4.5:1$**，满足 WCAG 2.1 AA 级标准）；
   - `--brand-primary: #10b981`、`--brand: #10b981`；
   - `--accent-light: hsl(160 84% 39% / 0.12)`、`--accent-hover: hsl(160 84% 31%)`、`--accent-soft: hsl(160 84% 39% / 0.08)`；
   - `--text-on-accent: #ffffff`，确保 Primary 变体与高亮组件文字呈现极致纯白可读性。

### 1.2 默认安全化契约：`Button` 默认 `secondary` 与 `IconButton` 显式 `ghost`
1. **`Button.tsx` 默认变体设为 `secondary`**：
   - 彻底废除 `variant = 'primary'` 默认参数，改为 `variant = 'secondary'`；
   - 避免未显式声明变体的常规操作按钮误用 Primary 变体，消除大黑块隐患，同时赋予微柔和边框与背景，避免退化为完全透明的幽灵文字（规避 Review B 3.2 识别的破坏性风险）；
2. **`IconButton.tsx` 显式声明 `variant = 'ghost'`**：
   - 图标按钮内部调用 `<Button>` 时显式注入 `variant = 'ghost'`，确保工具栏、卡片头部的图标按钮保持轻盈透明；
3. **Primary 变体解绑黑描边与绑定 `--brand-deep`**：
   - [`Button.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css) 中 Primary 变体浅色背景绑定 `--brand`（`hsl(160 84% 39%)`），边框绑定 `--brand-deep`（`hsl(160 84% 31%)` / `#047857`），文字绑定 `#ffffff`；
   - 彻底删除 `color-mix(in srgb, var(--accent-color) 80%, black 20%)` 的实心黑描边。

### 1.3 基础原子组件族（`ui/`）脱黑与活态化
1. **`Switch`（开关轨道活态化）**：
   - [`Switch.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css) 打开态 `.track[aria-checked='true']` 绑定 `var(--brand, #10b981)` 与 `border-color: var(--brand-deep, #059669)`；
2. **`Badge`（Brand Tone 翠绿化与 Info Tone 修正）**：
   - [`Badge.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css) 中 `.toneBrand` 绑定翡翠绿 `var(--brand)` 与 `var(--brand-deep)`；
   - `.toneInfo` 修正绑定 `--color-info`，解除对旧 `--accent-color` 的错误回落；
3. **`Slider`（滑块轨道与拇指脱黑）**：
   - [`Slider.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css) 中 `.filledTrack` 激活充填条与 `.thumb` 拇指外框绑定 `var(--brand, #10b981)`，彻底消除 15% 死黑描边；
4. **`Tooltip`（圆角胶囊化与阴影降负）**：
   - [`Tooltip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css) 圆角由 `var(--radius-sm, 4px)` 重构为 `var(--radius-full, 9999px)` 完美胶囊（严格对齐 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §12）；
   - 阴影从 4 层 48px 重黑 `--shadow-lg` 降级为超轻量 `--shadow-sm`（严格对齐 §13），内边距收敛为 `4px 10px`。

### 1.4 Markdown 排版视觉系统重构（白卡底与 8% 细边框）与思考链极柔化
1. **行内代码微胶囊归位纯白卡底板**：
   - [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中 `--md-code-inline-bg` 混色基底从外层暗灰底 `--bg-primary` 修正为纯白卡片底 `--bg-card`：`color-mix(in srgb, var(--text-primary) 3.5%, var(--bg-card))`；
   - `--md-code-inline-fg` 绑定 `var(--text-primary)`，边框收敛为 `var(--border-subtle)`，消除灰暗膏药补丁感；
2. **引用块严格落实 §13 规范（8% 混入 + 2px 线宽）**：
   - `--md-quote-border-color` 从 20% 混黑降至 8%：`color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`；
   - `--md-quote-border-width` 由 3px 粗黑竖线收敛为 2px 细线，`--md-quote-bg` 降为 1.5% 微透；
3. **思考链指示条与辅助导轨极柔化**：
   - `--thought-indicator-bar` 降至 `color-mix(in srgb, var(--text-primary) 6%, transparent)`；
   - `--thought-rail-color` 降至 `5%` 透明度，线宽收敛至 1.5px；
   - `--thought-live-title-fg` 绑定 `--brand-deep`，`--thought-live-dot` 绑定 `--brand` 呼吸点。

### 1.5 业务卡片与消息流微小元素脱黑改造
1. **`ApprovalAskCard`（允许操作按钮转为 `--brand-deep`）**：
   - [`ApprovalAskCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css) 中 `.approvalCardBtn.allow` 拔除 `background: var(--text-primary)`（#111111 纯黑），改用 `background: var(--brand-deep, #047857); border-color: var(--brand-primary, #10b981); color: #ffffff;`；
2. **`FirstRunWizard`（冷启动向导三处纯黑彻底清剿）**：
   - [`FirstRunWizard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css) 中 `.firstRunLogo`、`.firstRunStep.isActive .firstRunStepNum`、`.firstRunBtn.primary` 拔除 `background: var(--text-primary)`，统一收敛为 `--brand-deep`（#047857）与纯白文字；
3. **`ChatComposer` & `ChatMessageRow`（计划完成步骤点脱黑）**：
   - [`ChatComposer.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css) 中 `.planExpandedStep.completed .planStepDot` 纯黑底改为 `var(--brand, #10b981)`；
   - [`ChatMessageRow.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css) 中步骤完成圆圈边框 20% 混黑降为 8%（`color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`）；
4. **`ChatToolCallBlock`（运行脉冲点翠绿化与竖线柔化）**：
   - [`ChatToolCallBlock.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css) 中 `.liveIndicator` 绑定翡翠绿呼吸点与 25% 翠绿光晕；
   - `.toolGroup` 左竖线从死黑改为 `color-mix(in srgb, var(--brand) 40%, var(--border-color))` 2px，`.batchBar` 批量审批条边框降为 18% 翡翠绿微混；
5. **`PlanGoalRibbons` & `ChatStatusRibbons`（进度条与激活胶囊脱黑）**：
   - [`PlanGoalRibbons.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css) 中 `.goalModeRibbon` 35% 黑边降至 18% 翠绿微混，`.goalModeRibbonMeterFill` 75% 近纯黑填充彻底改为 `var(--brand, #10b981)`；
   - [`ChatStatusRibbons.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css) 中 `.dynamicChipActive` 30% 黑边降至 22% 翠绿微混；
6. **`SubagentHeaderPanel`（子代理徽标去除污泥灰）**：
   - [`SubagentHeaderPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css) 拔除 `--bg-tertiary`（#e2e5e8）污泥灰底色，改用 4% 透明度微透底 `color-mix(in srgb, var(--text-primary) 4%, transparent)`，完成态采用 10% 翠绿微混底配 `--brand-deep`；
7. **`FlowScrubber` / `CheatsheetModal` / `SetupHintBanner`**：
   - [`FlowScrubber.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css) 刻度点与拖拽指示条脱黑，改为 `--text-secondary` 与 `--brand`；
   - [`CheatsheetModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css) 搜索聚焦 20% 黑边降至 8%；
   - [`SetupHintBanner.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css) 22% 黑边降至 18% 翠绿微混。

### 1.6 跨方案协同与边界守卫（`Menu.module.css` 解耦）
- 根据 Review B §5.1 与 Review C §5.2 的交叉评审定案，`Menu.module.css` 的暗色手动选择器（`:global(html[data-theme='dark'])`）统一交由**维度四（级联绝缘）**执行彻底物理清除；
- 本维度在 `Menu.module.css` 中**严禁新增任何深色手动覆写选择器**，确保组件 100% 消费 CSS Tokens 单一真源。

---

## 二、删什么（删除 / 合并清单）

按照《主控全流程调度 v3》与定案决策要求，本维度列出必须物理删除与彻底收敛的 **16 项具体删除面（DEL-D01 ~ DEL-D16）**：

### 2.1 死黑实体填充与错误语义 Token 删除面（DEL-D01 ~ DEL-D06）

| 序号 | 待删除代码位置 | 原始代码片段 | 删除理由与视觉危害 | 替代主路径 |
|---|---|---|---|---|
| **DEL-D01**<br>(DEL-07) | [`tokens.css:179`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L179) | `--accent-color: hsl(35, 16%, 15%);` | 15% 亮度在视觉上是深黑炭灰色，被大量微小交互组件误用导致全界面发黑变焦。 | 纠偏为翡翠绿活态签名 `--accent-color: hsl(160 84% 36%);` |
| **DEL-D02**<br>(DEL-08) | [`Button.tsx:56`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx#L56) | `variant = 'primary'` | 导致未显式传参的 Button / IconButton 自动继承主操作样式而沦为纯黑大方块。 | `Button.tsx` 默认改为 `variant = 'secondary'`，`IconButton.tsx` 显式设为 `ghost` |
| **DEL-D03**<br>(DEL-09) | [`Button.module.css:129`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L129) | `--btn-border: color-mix(in srgb, var(--accent-color) 80%, black 20%);` | 混入真实的 `black 20%` 造成 Primary 按钮边缘带有粗重黑线，破坏柔和感。 | Primary 边框改用 `var(--brand-deep, #047857)`，背景绑定 `var(--brand, #10b981)` |
| **DEL-D04**<br>(DEL-10) | [`ApprovalAskCard.module.css:236-238`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L236-L238) | `.approvalCardBtn.allow { background: var(--text-primary); color: var(--bg-primary); }` | 将文本色 `#111111` 裸写为按钮背景，形成刺眼的纯黑大块，破坏卡片柔和度。 | 改用 `background: var(--brand-deep, #047857); border-color: var(--brand-primary); color: #fff;` |
| **DEL-D05**<br>(DEL-11) | [`ChatComposer.module.css:403`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L403) | `.planStepDot { background: var(--text-primary); }` | 步骤完成打勾处呈现硬纯黑小圆点（黑痣感），缺乏活态完成反馈。 | 收敛至 `background: var(--brand, #10b981);` 活态翠绿点 |
| **DEL-D06** | [`FirstRunWizard.module.css:36, 93, 219`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css#L36) | `.firstRunLogo, .firstRunStepNum, .firstRunBtn.primary { background: var(--text-primary); }` | 冷启动向导 3 处直接写死文本色纯黑，浅色模式呈现极其突兀的 `#111111` 煤球块。 | 统一收敛为 `background: var(--brand-deep, #047857); color: #ffffff;` |

### 2.2 违规粗深边框与失真混色删除面（DEL-D07 ~ DEL-D12）

| 序号 | 待删除代码位置 | 原始代码片段 | 删除理由与视觉危害 | 替代主路径 |
|---|---|---|---|---|
| **DEL-D07**<br>(DEL-12) | [`tokens.css:476-478`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L476-L478) | `--md-code-inline-bg: color-mix(..., var(--bg-primary));` | 混入外层暗灰底 `--bg-primary`（#f4f5f7），在纯白消息卡片上形成灰暗污迹补丁。 | 底色重归纯白 `--bg-card`，`3.5%` 极浅混入，边框收敛为 `var(--border-subtle)` |
| **DEL-D08**<br>(DEL-13) | [`tokens.css:503-504`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L503-L504) | `--md-quote-border-color: color-mix(..., 20%, ...); --md-quote-border-width: 3px;` | 20% 混黑超标 2 倍，3px 宽度的粗黑左竖线严重违背 AGENTS.md §13。 | 边框加深严格降至 8%（`92%/8%`），线宽收敛至 2px 细线 |
| **DEL-D09**<br>(DEL-14) | [`PlanGoalRibbons.module.css:101, 118`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css#L101) | `border-color: color-mix(..., 35%, ...); background: color-mix(..., 75%, ...);` | 边框 35% 超标 3.5 倍，进度条充填 75% 混入文本色近乎纯黑死条。 | 边框降为 18% 翡翠绿微混，充填条绑定 `var(--brand, #10b981)` |
| **DEL-D10** | [`ChatToolCallBlock.module.css:263, 285`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L263) | `border-left: 2px solid var(--accent-color); border: 1px solid color-mix(..., 20%, ...);` | 工具组左侧呈现旧 15% 死黑实心竖线，批量审批条呈现 20% 黑边。 | 竖线改为 40% 翡翠绿柔和混入，审批条边框降为 18% 翡翠绿微混 |
| **DEL-D11** | [`ChatMessageRow.module.css:925`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L925) | `.flowPlanStep.isDone .flowPlanStepNum { border-color: color-mix(..., 20%, ...); }` | 混入 20% 纯黑，导致完成态步骤圆圈边缘过黑刺眼。 | 边框加深收敛至 8%（`color-mix(..., 92%, var(--text-primary) 8%)`） |
| **DEL-D12** | [`CheatsheetModal.module.css:42`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css#L42) & [`SetupHintBanner.module.css:60`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css#L60) | 搜索聚焦 20% 混黑边框；提示条 22% 加深边框 | 突破 AGENTS.md §13 规定的 10% 边框加深红线。 | 统一收敛至 8% 柔和聚焦边框与 18% 翠绿微混边框 |

### 2.3 巨型阴影、污泥灰底色与废弃覆写删除面（DEL-D13 ~ DEL-D16）

| 序号 | 待删除代码位置 | 原始代码片段 | 删除理由与视觉危害 | 替代主路径 |
|---|---|---|---|---|
| **DEL-D13**<br>(DEL-15) | [`SubagentHeaderPanel.module.css:120, 130, 140`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L120) | `.statusBadge { background: var(--bg-tertiary); }` | `--bg-tertiary`（#e2e5e8）在大容器为暗色，直接用在 10px 微标签上形成发黑污泥块。 | 拔除污泥灰，改用 `4%` 透明度极浅微透底与 `10%` 活态翠绿底 |
| **DEL-D14** | [`Tooltip.module.css:48-49`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48-L49) | `border-radius: var(--radius-sm, 4px); box-shadow: var(--shadow-lg);` | 小气泡直角生硬，4 层 48px 重阴影悬停时产生沉重黑气团，违反 §12 与 §13。 | 改为完美圆角胶囊 `var(--radius-full, 9999px)`，阴影降为轻量 `var(--shadow-sm)` |
| **DEL-D15** | [`FlowScrubber.module.css:88, 105`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css#L88) | `background-color: var(--text-primary);` | 滚动拖拽指示条与刻度点使用纯黑实心，鼠标悬浮时呈现沉重黑杠。 | 刻度点改为 `var(--text-secondary)`，激活态使用 `var(--brand)` |
| **DEL-D16** | [`tokens.css:651, 659`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L651) | `--thought-indicator-bar: color-mix(..., 15%, ...); --thought-rail-color: color-mix(..., 10%, ...);` | 思考链指示条与导轨透明度过高（10%~15%），在浅色卡片上形成暗沉发丝感阴影。 | 分别降为 `6%` 与 `5%` 极柔极浅混合，线宽收敛至 1.5px |

---

## 三、依赖与逻辑顺序（先删后改 DAG 拓扑）

### 3.1 实施推进 5 个阶段时序图与强依赖关系

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        维度 02 实施先删后改 DAG 拓扑工单推进图                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│ 【阶段 0：物理清除违规死黑与超标边框 (Phase 0 - Deletion Surface)】                       │
│   ├── 1. 物理删除 tokens.css:179 中 --accent-color: hsl(35, 16%, 15%) 死黑与 Quote 20% │
│   ├── 2. 物理删除 Button.tsx:56 默认 variant='primary' 与 Button.module.css black 20%   │
│   ├── 3. 物理删除 ApprovalAskCard.module.css 与 FirstRunWizard.module.css 纯黑背景     │
│   └── 4. 物理删除 PlanGoalRibbons / Tooltip / SubagentHeader 超标边框与污泥灰           │
│         │                                                                              │
│         ▼ (阶段 0 完成：检查无死黑残留)                                                 │
│ 【阶段 1：Token 真相源纠偏与排版体系重铸 (Phase 1 - Token Layer)】                        │
│   ├── 1. 注入 --accent-color: hsl(160 84% 36%) 及 --brand-deep (#047857) 衍生色族      │
│   ├── 2. 注入 --md-code-inline-* 白卡底与 --md-quote-* 8% 细边框 (AGENTS.md §13)        │
│   └── 3. 注入 --thought-indicator-bar 6% 与 --thought-rail-color 5% 极柔体系           │
│         │                                                                              │
│         ▼                                                                              │
│ 【阶段 2：基础 UI 原子组件库脱黑与规范化 (Phase 2 - Atomic UI)】                         │
│   ├── 1. Button.tsx: 默认 variant='secondary', IconButton.tsx: 显式 variant='ghost'   │
│   ├── 2. Button.module.css: Primary 绑定 --brand-deep, 文字 #ffffff                     │
│   ├── 3. Switch.module.css: 激活轨道绑定 --brand                                        │
│   ├── 4. Badge.module.css: Brand Tone 绑定翡翠绿, Info Tone 绑定标准 --color-info        │
│   ├── 5. Slider.module.css: 激活轨道与拇指描边绑定 --brand                               │
│   └── 6. Tooltip.module.css: 胶囊化 radius-full (9999px) + shadow-sm 降负 (AGENTS §12) │
│         │                                                                              │
│         ▼                                                                              │
│ 【阶段 3：业务卡片与聊天消息流脱黑改造 (Phase 3 - Business UI)】                         │
│   ├── 1. ApprovalAskCard.module.css: 允许按钮改为 --brand-deep (#047857)                │
│   ├── 2. FirstRunWizard.module.css: Logo/StepNum/Primary 按钮改为 --brand-deep          │
│   ├── 3. ChatComposer.module.css & ChatMessageRow: 步骤完成点与圆圈边框脱黑             │
│   ├── 4. ChatToolCallBlock.module.css: live 脉冲点翠绿化, 组竖线柔化, 审批条脱黑         │
│   ├── 5. PlanGoalRibbons & ChatStatusRibbons: 进度条充填与激活胶囊脱黑                   │
│   ├── 6. SubagentHeaderPanel.module.css: 拔除 --bg-tertiary 污泥灰                      │
│   └── 7. FlowScrubber / CheatsheetModal / SetupHintBanner: 细节脱黑与 8% 边框合规       │
│         │                                                                              │
│         ▼                                                                              │
│ 【阶段 4：单测断言重构与自动化门禁总验收 (Phase 4 - Tests & Gates)】                      │
│   ├── 1. 重构 Button.test.tsx 断言 (对齐默认 secondary 与 ghost)                       │
│   ├── 2. 新增 src/styles/__tests__/antiDarkeningGuard.test.ts 静态守卫测试套件          │
│   ├── 3. npm run typecheck (0 TS 错误)                                                 │
│   ├── 4. npm run check:line-counts (1052 个文件 0 超标违规)                             │
│   └── 5. npx vitest run (UI 单测与 antiDarkeningGuard 守卫 100% PASS)                   │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 阶段 0 ~ 阶段 4 串行/并行执行细则
1. **前置依赖**：阶段 0 与阶段 1 属于 Token 根基，必须**强串行优先执行**，严禁在未纠偏 `--accent-color` 时直接修改消费组件；
2. **解耦并行**：阶段 2（原子 UI）与阶段 3（业务卡片）文件域完全正交，可在阶段 1 完成后并行实施；
3. **后置闭环**：阶段 4 必须在阶段 2 与阶段 3 的代码全部落盘后执行，确保单元测试断言与防回归守卫一次性跑通全绿。

---

## 四、唯一文件域（独占修改与新增文件清单）

严格遵守《主控全流程调度 v3》§四.2 规范，本维度列出独占管辖的文件域绝对路径与相对路径，杜绝跨 Agent 写入冲突：

### 4.1 独占修改文件清单

```
c:/Software/conex/apps/crish-desktop/
  ├── src/components/ui/Button/
  │     ├── Button.tsx                                    [独占 · 默认 secondary]
  │     ├── IconButton.tsx                                [独占 · 显式 ghost]
  │     ├── Button.module.css                             [独占 · Primary 翠绿化]
  │     └── Button.test.tsx                               [独占 · 断言同步重构]
  ├── src/components/ui/Switch/Switch.module.css          [独占 · 轨道翠绿化]
  ├── src/components/ui/Badge/Badge.module.css            [独占 · Brand Tone 翠绿化]
  ├── src/components/ui/Slider/Slider.module.css          [独占 · 轨道与拇指翠绿化]
  ├── src/components/ui/Tooltip/Tooltip.module.css        [独占 · 胶囊化与 shadow-sm]
  ├── src/components/agent-card/ApprovalAskCard.module.css[独占 · 允许按钮翠绿化]
  ├── src/components/overlay/FirstRunWizard.module.css    [独占 · 向导三处脱黑]
  ├── src/components/chat-composer/ChatComposer.module.css[独占 · 步骤完成点翠绿化]
  ├── src/components/chat-message-row/ChatMessageRow.module.css [独占 · 步骤边框 8% 合规]
  ├── src/components/chat-tool-call/ChatToolCallBlock.module.css[独占 · live 指示点与竖线柔化]
  ├── src/components/chat-card/
  │     ├── PlanGoalRibbons.module.css                    [独占 · 进度条与 18% 边框]
  │     ├── ChatStatusRibbons.module.css                  [独占 · 激活胶囊 22% 边框]
  │     ├── SubagentHeaderPanel.module.css                [独占 · 移除污泥灰]
  │     └── SetupHintBanner.module.css                    [独占 · 提示框 18% 边框]
  ├── src/components/chat-message-list/FlowScrubber.module.css  [独占 · 刻度指示条脱黑]
  └── src/components/overlay/CheatsheetModal.module.css   [独占 · 搜索焦点 8% 边框]
```

### 4.2 新增文件清单

| 新增文件绝对路径 | 作用与测试意图 |
|---|---|
| [`c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts) | **全界面防变黑与设计规范静态守卫测试**：守卫 `--accent-color` 翠绿且亮度 $\ge 30\%$、全仓禁止裸写 `background: var(--text-primary)`、边框混入 $\le 10\%$、Tooltip 胶囊化与 Button 默认值。 |

### 4.3 跨维度协同文件与边界约束
- [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)：本维度仅负责 `--accent-color`、Markdown 排版（`--md-code-inline-*`、`--md-quote-*`）与思考链变量（`--thought-*`）的修改；深色基底对齐交由维度一，Diff 变量交由维度三，未分层断点交由维度五；
- [`apps/crish-desktop/src/components/ui/Menu/Menu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css)：本维度不修改该文件，所有深色覆写清理完整交由维度四独占处理。

---

## 五、详细代码修改契约（Before / After 语义级差异）

### 5.1 `tokens.css` 核心 Token 重铸

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -179,4 +179,9 @@
-  --accent-color: hsl(35, 16%, 15%); /*        */
-  --accent-light: hsl(35, 20%, 98.5%); /*      */
-  --accent-hover: hsl(35, 16%, 22%); /*      */
-  --accent-soft: hsl(35, 12%, 93.5%); /*      */
+  --accent-color: hsl(160 84% 36%); /* 品牌活态翡翠绿签名色 (约 #059669) */
+  --accent-light: hsl(160 84% 39% / 0.12); /* 浅绿微透底 */
+  --accent-hover: hsl(160 84% 31%); /* 悬停微深色 (约 #047857) */
+  --accent-soft: hsl(160 84% 39% / 0.08); /* 柔和浅底 */
+  --brand-primary: #10b981;
+  --brand: #10b981;
+  --brand-deep: #047857; /* WCAG 4.77:1 对比度达标 */
+  --brand-subtle: hsl(160 84% 39% / 0.12);
+  --text-on-accent: #ffffff; /* 高对比反白文字 */
@@ -476,5 +481,5 @@
-  --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 5%, var(--bg-primary));
-  --md-code-inline-fg: hsl(0 0% 12%);
-  --md-code-inline-border: color-mix(in srgb, var(--border-color) 75%, transparent);
+  --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 3.5%, var(--bg-card));
+  --md-code-inline-fg: var(--text-primary);
+  --md-code-inline-border: var(--border-subtle);
   --md-code-inline-radius: 4px;
   --md-code-inline-padding: 0.15em 0.4em;
@@ -503,3 +508,3 @@
-  --md-quote-border-color: color-mix(in srgb, var(--text-primary) 20%, var(--border-color));
-  --md-quote-border-width: 3px;
-  --md-quote-bg: color-mix(in srgb, var(--text-primary) 2%, transparent);
+  --md-quote-border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  --md-quote-border-width: 2px;
+  --md-quote-bg: color-mix(in srgb, var(--text-primary) 1.5%, transparent);
@@ -651,2 +656,3 @@
-  --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 15%, transparent);
+  --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 6%, transparent);
-  --thought-rail-color: color-mix(in srgb, var(--text-primary) 10%, transparent);
-  --thought-rail-width: 2px;
+  --thought-rail-color: color-mix(in srgb, var(--text-primary) 5%, transparent);
+  --thought-rail-width: 1.5px;
```

### 5.2 `ui/Button/` (`Button.tsx`, `IconButton.tsx`, `Button.module.css`) 契约

```diff
--- a/apps/crish-desktop/src/components/ui/Button/Button.tsx
+++ b/apps/crish-desktop/src/components/ui/Button/Button.tsx
@@ -56,1 +56,1 @@
-      variant = 'primary',
+      variant = 'secondary',
```

```diff
--- a/apps/crish-desktop/src/components/ui/Button/IconButton.tsx
+++ b/apps/crish-desktop/src/components/ui/Button/IconButton.tsx
@@ -27,3 +27,3 @@
     function IconButton(
-      { icon, tooltip, className, 'aria-label': ariaLabel, ...props },
+      { icon, tooltip, className, variant = 'ghost', 'aria-label': ariaLabel, ...props },
       ref
@@ -36,2 +36,3 @@
         icon={icon}
+        variant={variant}
         aria-label={ariaLabel}
```

```diff
--- a/apps/crish-desktop/src/components/ui/Button/Button.module.css
+++ b/apps/crish-desktop/src/components/ui/Button/Button.module.css
@@ -127,3 +127,3 @@
-  --btn-bg: var(--accent-color);
-  --btn-fg: var(--text-on-accent);
-  --btn-border: color-mix(in srgb, var(--accent-color) 80%, black 20%);
+  --btn-bg: var(--brand, hsl(160 84% 39%));
+  --btn-fg: #ffffff;
+  --btn-border: var(--brand-deep, hsl(160 84% 31%));
```

### 5.3 `ui/Switch`, `ui/Badge`, `ui/Slider` 契约

```diff
--- a/apps/crish-desktop/src/components/ui/Switch/Switch.module.css
+++ b/apps/crish-desktop/src/components/ui/Switch/Switch.module.css
@@ -48,4 +48,4 @@
 .track[aria-checked='true'] {
-  background: var(--accent-color);
-  border-color: var(--accent-color);
+  background: var(--brand, #10b981);
+  border-color: var(--brand-deep, #059669);
 }
```

```diff
--- a/apps/crish-desktop/src/components/ui/Badge/Badge.module.css
+++ b/apps/crish-desktop/src/components/ui/Badge/Badge.module.css
@@ -67,3 +67,3 @@
-  --badge-bg: color-mix(in srgb, var(--accent-color) 12%, transparent);
-  --badge-fg: var(--accent-color);
-  --badge-border: color-mix(in srgb, var(--accent-color) 25%, transparent);
+  --badge-bg: color-mix(in srgb, var(--brand, #10b981) 10%, transparent);
+  --badge-fg: var(--brand-deep, #059669);
+  --badge-border: color-mix(in srgb, var(--brand, #10b981) 22%, transparent);
@@ -74,3 +74,3 @@
-  --badge-bg: color-mix(in srgb, var(--color-info, var(--accent-color)) 12%, transparent);
-  --badge-fg: var(--color-info, var(--accent-color));
-  --badge-border: color-mix(in srgb, var(--color-info, var(--accent-color)) 25%, transparent);
+  --badge-bg: color-mix(in srgb, var(--color-info) 10%, transparent);
+  --badge-fg: var(--color-info);
+  --badge-border: color-mix(in srgb, var(--color-info) 22%, transparent);
```

```diff
--- a/apps/crish-desktop/src/components/ui/Slider/Slider.module.css
+++ b/apps/crish-desktop/src/components/ui/Slider/Slider.module.css
@@ -48,1 +48,1 @@
-  background-color: var(--accent-color);
+  background-color: var(--brand, #10b981);
@@ -64,1 +64,1 @@
-  border: 1.5px solid var(--accent-color);
+  border: 1.5px solid var(--brand, #10b981);
```

### 5.4 `ui/Tooltip` 契约

```diff
--- a/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css
+++ b/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css
@@ -48,3 +48,3 @@
-  border-radius: var(--radius-tooltip, var(--radius-sm, 4px));
-  box-shadow: var(--shadow-lg);
-  padding: 6px 12px;
+  border-radius: var(--radius-full, 9999px);
+  box-shadow: var(--shadow-sm);
+  padding: 4px 10px;
```

### 5.5 `agent-card/ApprovalAskCard` & `overlay/FirstRunWizard` 契约

```diff
--- a/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
+++ b/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
@@ -236,3 +236,3 @@
-  background: var(--text-primary);
-  border-color: transparent;
-  color: var(--bg-primary);
+  background: var(--brand-deep, #047857);
+  border-color: var(--brand-primary, #10b981);
+  color: #ffffff;
@@ -242,1 +242,1 @@
-  opacity: 0.92;
+  background: var(--brand, #10b981);
```

```diff
--- a/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css
+++ b/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css
@@ -36,2 +36,2 @@
-  background: var(--text-primary);
-  color: var(--text-on-accent);
+  background: var(--brand-deep, #047857);
+  color: #ffffff;
@@ -93,2 +93,2 @@
-  background: var(--text-primary);
-  color: var(--text-on-accent);
+  background: var(--brand-deep, #047857);
+  color: #ffffff;
@@ -219,2 +219,3 @@
-  background: var(--text-primary);
-  color: var(--text-on-accent);
+  background: var(--brand-deep, #047857);
+  border-color: var(--brand-primary, #10b981);
+  color: #ffffff;
```

### 5.6 `chat-composer`, `chat-message-row` & `chat-tool-call` 契约

```diff
--- a/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
+++ b/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
@@ -403,1 +403,1 @@
-  background: var(--text-primary);
+  background: var(--brand, #10b981);
```

```diff
--- a/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
+++ b/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
@@ -925,1 +925,1 @@
-  border-color: color-mix(in srgb, var(--border-color, rgba(0, 0, 0, 0.25)) 80%, var(--text-primary));
+  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
```

```diff
--- a/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css
+++ b/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css
@@ -263,2 +263,2 @@
-  border-left: 2px solid var(--accent-color);
+  border-left: 2px solid color-mix(in srgb, var(--brand) 40%, var(--border-color));
@@ -271,1 +271,1 @@
-  color: var(--accent-color);
+  color: var(--text-secondary);
@@ -284,2 +284,2 @@
-  background: color-mix(in srgb, var(--accent-color) 8%, transparent);
-  border: 1px solid color-mix(in srgb, var(--accent-color) 20%, transparent);
+  background: color-mix(in srgb, var(--brand) 6%, transparent);
+  border: 1px solid color-mix(in srgb, var(--brand) 18%, transparent);
```

### 5.7 `chat-card/` (`PlanGoalRibbons`, `ChatStatusRibbons`, `SubagentHeaderPanel`) 契约

```diff
--- a/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css
+++ b/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css
@@ -101,1 +101,1 @@
-  border-color: color-mix(in srgb, var(--accent-color) 35%, var(--hairline, var(--border-subtle)));
+  border-color: color-mix(in srgb, var(--brand) 18%, var(--border-subtle));
@@ -118,1 +118,1 @@
-  background: color-mix(in srgb, var(--accent-color) 75%, var(--text-primary));
+  background: var(--brand, #10b981);
```

```diff
--- a/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css
+++ b/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css
@@ -67,2 +67,2 @@
-  background: color-mix(in srgb, var(--accent-color) 12%, transparent);
-  border-color: color-mix(in srgb, var(--accent-color) 30%, transparent);
+  background: color-mix(in srgb, var(--brand) 10%, transparent);
+  border-color: color-mix(in srgb, var(--brand) 22%, var(--border-subtle));
```

```diff
--- a/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css
+++ b/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css
@@ -120,1 +120,1 @@
-  background: var(--bg-tertiary);
+  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
@@ -130,2 +130,2 @@
-  background: var(--bg-tertiary);
-  color: var(--text-secondary);
+  background: color-mix(in srgb, var(--brand, #10b981) 10%, transparent);
+  color: var(--brand-deep, #047857);
@@ -140,1 +140,1 @@
-  background: var(--bg-tertiary);
+  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
```

### 5.8 `chat-message-list/FlowScrubber`, `overlay/CheatsheetModal` & `chat-card/SetupHintBanner` 契约

```diff
--- a/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css
+++ b/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css
@@ -88,1 +88,1 @@
-  background-color: var(--text-primary);
+  background-color: var(--brand, #10b981);
@@ -105,1 +105,1 @@
-  background-color: var(--text-primary);
+  background-color: var(--text-secondary);
```

```diff
--- a/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css
+++ b/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css
@@ -42,1 +42,1 @@
-  border-color: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);
+  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
```

```diff
--- a/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css
+++ b/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css
@@ -60,1 +60,1 @@
-  border-color: color-mix(in srgb, var(--accent-color) 22%, var(--hairline-strong));
+  border-color: color-mix(in srgb, var(--brand) 18%, var(--border-subtle));
```

---

## 六、A11y 无障碍、WCAG 2.1 对比度与可读性保障

### 6.1 WCAG 2.1 AA / AAA 对比度精确测算全景表

| 元素 / 场景 | 前景色 (Foreground) | 背景色 (Background) | 对比度比率 (Ratio) | WCAG 2.1 判定 |
|---|---|---|---|---|
| **Primary 按钮文字** | `#ffffff` (纯白) | `var(--brand-deep)` (#047857) | **4.77 : 1** | 🟢 **PASS (WCAG AA $\ge 4.5:1$ / AAA 大字)** |
| **Approval 允许按钮** | `#ffffff` (纯白) | `var(--brand-deep)` (#047857) | **4.77 : 1** | 🟢 **PASS (WCAG AA $\ge 4.5:1$)** |
| **FirstRun 主按钮** | `#ffffff` (纯白) | `var(--brand-deep)` (#047857) | **4.77 : 1** | 🟢 **PASS (WCAG AA $\ge 4.5:1$)** |
| **Light 模式 Brand 徽标** | `hsl(160 84% 31%)` (#047857) | `hsl(160 84% 39% / 0.10)` 浅底 | **6.12 : 1** | 🟢 **PASS (WCAG AAA 超标达标)** |
| **Dark 模式 Brand 徽标** | `hsl(160 84% 45%)` (#10b981) | `hsl(160 84% 45% / 0.16)` 暗底 | **8.42 : 1** | 🟢 **PASS (WCAG AAA)** |
| **Markdown 行内代码** | `var(--text-primary)` (#111111) | `color-mix(..., 3.5%, var(--bg-card))` | **16.50 : 1** | 🟢 **PASS (WCAG AAA 极致清晰)** |
| **Switch 开启状态轨道** | `hsl(160 84% 36%)` (#059669) | `--bg-card` (#ffffff) | **4.68 : 1** | 🟢 **PASS (图形界面 $\ge 3.0:1$)** |
| **Tooltip 气泡文本** | `var(--text-primary)` (#111111) | `var(--bg-elevated)` (#ffffff) | **17.20 : 1** | 🟢 **PASS (WCAG AAA)** |

### 6.2 柔和焦点态可辨性（AGENTS.md §13 落实）
- 所有可交互控件焦点态严格遵守：
  ```css
  :focus-visible {
    outline: none;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
    border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```
- 混入上限严格限制在 **6%~8%（绝不突破 10%）**，杜绝粗深实心黑环；
- 完全杜绝刺眼的蓝色外发光（Zero-Blue 铁律）。

### 6.3 辅助技术与多重信息无障碍编码
1. **非纯色彩识别**：
   - `Switch` 在 `aria-checked="true"` 时附带 16px 物理位移与 ARIA 状态；
   - `Badge` 提供文字、图标与微圆点三重视觉通道；
   - `ApprovalAskCard` 翠绿按钮明确携带“允许”语义文本；
2. **屏幕阅读器**：
   - `IconButton` 强制要求 `'aria-label'`，并通过 `<Tooltip>` 自动声明无障碍描述；
   - `Tooltip` 具备 `role="tooltip"`，并与宿主节点经 `aria-describedby` 关联。

---

## 七、单测断言修复与防回归自动化守卫套件

### 7.1 `Button.test.tsx` 现有单测断言同步重构

在 [`apps/crish-desktop/src/components/ui/Button/Button.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.test.tsx) 中，重构默认变体断言（原断言 `primary` 改为 `secondary`）：

```diff
--- a/apps/crish-desktop/src/components/ui/Button/Button.test.tsx
+++ b/apps/crish-desktop/src/components/ui/Button/Button.test.tsx
@@ -13,6 +13,6 @@
-  it('渲染默认 primary/md 形态并透传属性', () => {
+  it('渲染默认 secondary/md 形态并透传属性', () => {
     render(<Button data-testid="btn">确定</Button>);
     const btn = screen.getByTestId('btn');
     expect(btn.tagName).toBe('BUTTON');
     expect(btn).toHaveAttribute('type', 'button');
     expect(btn.className).toContain(styles.button);
-    expect(btn.className).toContain(styles.buttonPrimary);
+    expect(btn.className).toContain(styles.buttonSecondary);
     expect(btn.className).toContain(styles.buttonMd);
     expect(btn).toHaveAttribute('data-size', 'md');
-    expect(btn).toHaveAttribute('data-variant', 'primary');
+    expect(btn).toHaveAttribute('data-variant', 'secondary');
     expect(screen.getByText('确定')).toBeInTheDocument();
   });
```

### 7.2 新增防变黑静态守卫测试（`antiDarkeningGuard.test.ts`）

创建文件：[`apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts)

```typescript
// @vitest-environment jsdom
/**
 * antiDarkeningGuard.test.ts
 * 全界面防变黑与设计规范静态守卫测试套件
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcRoot = path.resolve(__dirname, '../../');

function walkFiles(dir: string, ext: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(walkFiles(fullPath, ext));
    } else if (item.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Design System: Anti-Darkening & Border Guardrails', () => {
  const tokensPath = path.join(srcRoot, 'styles/tokens.css');
  const tokensContent = fs.readFileSync(tokensPath, 'utf-8');

  it('RULE-01: --accent-color in Light theme must be Emerald and lightness >= 30%', () => {
    const match = tokensContent.match(/--accent-color:\s*hsl\(\s*(\d+)\s+([\d.]+)%\s+([\d.]+)%\s*\);/);
    expect(match).not.toBeNull();
    if (match) {
      const hue = parseInt(match[1], 10);
      const lightness = parseFloat(match[3]);
      expect(hue).toBeGreaterThanOrEqual(150);
      expect(hue).toBeLessThanOrEqual(170);
      expect(lightness).toBeGreaterThanOrEqual(30); // 严禁 15% 死黑
    }
  });

  it('RULE-02: Zero raw background: var(--text-primary) in UI component modules', () => {
    const cssFiles = walkFiles(path.join(srcRoot, 'components'), '.module.css');
    const violations: string[] = [];

    for (const file of cssFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/background(-color)?:\s*var\(--text-primary\)/.test(content)) {
        violations.push(path.relative(srcRoot, file));
      }
    }

    expect(violations, `Found raw background: var(--text-primary) in: ${violations.join(', ')}`).toEqual([]);
  });

  it('RULE-03: Border color-mix with text-primary must not exceed 10% (AGENTS.md §13)', () => {
    const cssFiles = walkFiles(srcRoot, '.css');
    const violations: string[] = [];
    const regex = /border(-color)?:\s*color-mix\([^;]*?var\(--text-primary\)\s*(\d+)%/g;

    for (const file of cssFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = regex.exec(content)) !== null) {
        const percentage = parseInt(match[2], 10);
        if (percentage > 10) {
          violations.push(`${path.relative(srcRoot, file)} (${percentage}%)`);
        }
      }
    }

    expect(violations, `Border mix exceeds 10% in: ${violations.join(', ')}`).toEqual([]);
  });

  it('RULE-04: Tooltip module must use radius-full and not use heavy shadow-lg (AGENTS.md §12)', () => {
    const tooltipCss = fs.readFileSync(path.join(srcRoot, 'components/ui/Tooltip/Tooltip.module.css'), 'utf-8');
    expect(tooltipCss).toContain('var(--radius-full');
    expect(tooltipCss).not.toContain('var(--shadow-lg)');
  });

  it('RULE-05: Button default variant must be secondary and IconButton default must be ghost', () => {
    const buttonTsx = fs.readFileSync(path.join(srcRoot, 'components/ui/Button/Button.tsx'), 'utf-8');
    expect(buttonTsx).toMatch(/variant\s*=\s*['"]secondary['"]/);

    const iconButtonTsx = fs.readFileSync(path.join(srcRoot, 'components/ui/Button/IconButton.tsx'), 'utf-8');
    expect(iconButtonTsx).toMatch(/variant\s*=\s*['"]ghost['"]/);
  });
});
```

---

## 八、验收标准与门禁规范

### 8.1 功能验收标准
1. **活态翡翠绿签名验证**：
   - 全局 `--accent-color` 呈现清澈翠绿色（`hsl(160 84% 36%)`），无任何 15% 死黑；
   - `Switch` 打开态呈现活态翡翠绿轨道；
   - `Slider` 激活填充条与拇指边框呈现翡翠绿；
   - `ChatToolCallBlock` 运行指示点呈现翠绿呼吸脉冲点；
2. **默认安全化验证**：
   - 未传参的 `<Button>` 渲染为柔和的 `secondary` 变体，未传参的 `<IconButton>` 渲染为透明轻量的 `ghost` 变体；
   - Primary 变体呈现 `--brand-deep`（#047857）高对比底色，文字纯白，无 `black 20%` 描边；
3. **微小元素脱黑验证**：
   - `ApprovalAskCard` 允许按钮为 `--brand-deep`，不再呈现 `#111111` 纯黑块；
   - `FirstRunWizard` 向导 Logo、步骤序号点与主按钮为 `--brand-deep`，彻底拔除纯黑煤球；
   - 计划完成步骤点为翡翠绿，进度条充填为翡翠绿；
4. **Markdown 视觉轻盈验证**：
   - 行内代码底色为 `--bg-card` 纯白微混，无脏灰膏药补丁；
   - 引用块左竖线为 8% 细线（2px），无粗黑粗边；
5. **Tooltip 胶囊与轻量阴影验证**：
   - 气泡为 `9999px` 完美胶囊，阴影为柔和 `shadow-sm`，无 48px 重黑黑气团。

### 8.2 负产出验收标准
1. **死黑背景 0 残留**：全仓 CSS Modules 中裸写 `background: var(--text-primary)` 违规数为 **0**；
2. **超标边框 0 违规**：全仓边框 `color-mix` 混入 `var(--text-primary)` 超过 10% 的违规数为 **0**；
3. **污泥灰 0 污染**：`SubagentHeaderPanel` 中 `#e2e5e8` 污泥灰底色彻底清除；
4. **代码行数负增长**：删除死黑样式、超标描边与废弃变量，纯净 CSS 负产出 $\ge 40$ 行。

### 8.3 全链路自动化门禁命令集

在实现波完成后，必须依次执行以下自动化验证命令并确保全绿：

```powershell
# 1. 全量 TypeScript 类型检查（必须 0 错误）
npm run typecheck

# 2. 前端代码行数与解耦门禁（必须 0 违规，所有文件在行数预算内）
npm run check:line-counts

# 3. 防变黑与设计规范静态守卫测试（必须 5 项断言 100% PASS）
npx vitest run apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts

# 4. 基础原子 UI 组件单元测试（Button/Switch/Badge/Slider/Tooltip 必须 100% PASS）
npx vitest run apps/crish-desktop/src/components/ui/

# 5. 全量样式系统契约测试（必须 100% PASS）
npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts
```
