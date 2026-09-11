# 工具调用卡片与内部嵌套元素布局全景调研报告

> **战役工作区**：`docs/layout-token-system/`
> **所属阶段**：第一阶段详细调研（详细调研团队）
> **调研专题**：06 - 工具调用卡片与内部嵌套元素布局（Tool Cards & Nested Elements Layout）
> **调研员**：工具调用卡片与内部嵌套元素布局调研员
> **日期**：2026-09-11
> **规范锚点**：`AGENTS.md` §1、§4、§7、§13；`docs/layout-token-system/00-调研导航与调度锚点.md`

---

## 一、调研范围与执行摘要

### 1.1 调研背景与组件架构全景

Conex / Crish 桌面端作为一个多智能体协作与代码辅助工作台，其会话流（Chat Stream）不仅包含自然语言文本与 Markdown 渲染，更高度集成了复杂的状态化工具调用体系（Tool Invocations）、命令行终端实时日志（Terminal）、代码与 Git Diff 差异对比、高危权限审批（Approval Ask）、以及协作子代理（Subagent）的并行时间线与下钻面板。

在界面层级树上，这些组件天然处于多层容器的深度嵌套之中：

```
ChatMessageRow (消息行容器 .row / .rowAssistant)
  └── MessageContent (消息内容包含块)
        └── MessageToolCallsSection (.timelineTools)
              └── ChatToolStack (.toolStack)
                    ├── ToolGroup (.toolGroup - 2px 左竖线收拢分组)
                    ├── BatchApprovalBar (.batchBar - 批量审批栏)
                    └── CompactToolRow (.toolRow - 单行 24px 极简工具头)
                          ├── ToolCallHeader (24px 单行展开/折叠控制条)
                          └── ToolCallOutput (展开主体)
                                └── ToolResultBody (.toolResultBody - 圆角矩形卡片)
                                      ├── ToolCallInputPane (.toolSectionInput - 参数表格/命令行)
                                      ├── ToolCallOutputPane (.toolSectionOutput - 终端/JSON/文件/Diff)
                                      │     ├── ToolCallDiffPreview (.diffCard - 差异比对卡片)
                                      │     ├── ModernCodeBlock (.codeBlockCard - 代码高亮块)
                                      │     └── FileStat / GrepMatchList / DirList (结构化内衬)
                                      └── InlineAgentPanel (.flowSubagent / .inlineAgent - 子代理时间线与展开面板)
                                            ├── FlowSubagentLine1 (24px 行内徽标)
                                            ├── FlowSubagentLine2 (22px 链路追踪缩进)
                                            └── FlowSubagentPanel (.flowSubagentPanel - 1px 左轨线与展开消息流)
                                                  └── ApprovalAskCard (.approvalCard - 4px 风险色左边框审批卡)
```

### 1.2 核心调研结论与问题总结

经过对 `ModernToolCall.module.css`、`ChatToolCallBlock.module.css`、`ModernToolCall.tsx`、`AgentCard.module.css`、`InlineAgentPanel.module.css`、`ApprovalAskCard.module.css` 及配套 TSX 视图实现的深入全景代码核查与拓扑遍历，发现工具卡片与嵌套布局领域存在以下四个系统性失范与技术负债：

1. **内外边距阶梯断裂与散落裸值泛滥**：
   从 1px 到 28px 存在大量无 Token 约束的奇数、偶数与小数值硬编码（如 `1px`、`2px`、`3px`、`4px`、`5px`、`6px`、`7px`、`10px`、`13.5px`、`22px`、`28px`）。同一语义空间（如卡片内衬、头部高度、图标尺寸、行间距）在不同组件中各自发明微距，缺乏全局阶梯数学对齐。
2. **嵌套容器边框叠加与发丝边框视觉污染（Border Stacking & Visual Noise）**：
   当消息卡嵌套工具卡、工具卡嵌套代码块或 Diff 预览卡时，产生多达 3~4 层的 `1px solid var(--border-subtle)` / `var(--hairline)` 强实线叠加。代码中出现依赖 `!important` 抹除边框的打补丁补救策略（如 `.embeddedDiffCard { border: none !important; margin: 0 !important; }`），且虚线（`dashed`）、实线（`solid`）、不同不透明度背景（`color-mix`）在暗色和浅色模式下产生明显的“多层线框囚笼”感。
3. **子代理时间线与展开面板内边距割裂**：
   子代理行内时间线（`InlineAgentPanel`）、侧栏卡片（`AgentCard`）以及多代理看板（`AgentTeamBoard`）的头部高度在 22px、24px、26px、28px、32px、36px 之间严重漂移；展开面板内边距在 `20px 12px`、`14px 6px`、`6px 8px 8px`、`4px 6px 6px`、`3px 0 3px 12px` 之间随意组合，缩进基准（22px vs 28px vs 18px）未与图标和栅格对齐。
4. **审批卡片（ApprovalAskCard）双套架构并存与几何错位**：
   代码库中同时存在极简单层黑白灰设计的 `ModernApprovalCard` 与丰富状态驱动的 `ApprovalAskCard`，两者尺寸阶梯截然不同。后者的 `padding: 10px 12px 12px 14px;` 虽然试图用不对称内衬补偿 4px 左侧色条，但在 dense 模式下被重置为 `8px 8px 7px`；底部操作按钮组使用 `flex-wrap: wrap; justify-content: flex-end;`，在按钮换行时缺少行间距与卡片内衬的数学锁合，容易出现按钮边缘溢出或垂直间隙坍缩。

---

## 二、维度一：工具卡片内外边距阶梯与裸值离散度深度调研

### 2.1 结构化 JSON 工具卡片（ModernToolCall.module.css）

在 `ModernToolCall.module.css` 与 `ModernJsonToolCall.tsx` 中，结构化 JSON 工具卡片呈现出清晰的层次，但在关键尺寸上散落了大量裸值：

```css
/* apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css */

/* 1. 宿主外边距：依赖 --space-1_5 回退 6px */
.jsonToolCall {
  display: flex;
  flex-direction: column;
  margin: var(--space-1_5, 6px) 0; /* 行: 12 */
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

/* 2. 可点击头部行：硬编码上下 4px 内边距与 8px gap */
.jsonToolHead {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);        /* 行: 21 */
  background: transparent;
  border: none;
  padding: 4px 0;                 /* 行: 24: 裸值 4px */
  margin: 0;
  border-radius: var(--radius-sm, 4px); /* 行: 34 */
}

/* 3. 折叠指示器 Chevron：硬编码 14px */
.chevron {
  width: 14px;                    /* 行: 52: 裸值 14px */
  height: 14px;                   /* 行: 53: 裸值 14px */
}

/* 4. 参数胶囊 Pill：紧凑内衬 2px 8px，最大宽度限制 320px */
.paramPill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;               /* 行: 76: 裸值 2px 8px */
  border-radius: var(--radius-md, 6px); /* 行: 77 */
  font-size: var(--font-size-xs, 12px); /* 行: 80 */
  max-width: 320px;               /* 行: 82: 裸值 320px */
  line-height: 1.4;               /* 行: 86 */
}

/* 5. 状态指示符：14px 容器，带裸值 margin-left: 2px */
.statusIcon {
  width: 14px;                    /* 行: 94 */
  height: 14px;                   /* 行: 95 */
  margin-left: 2px;               /* 行: 96: 裸值 2px 微调补丁 */
}

/* 6. 脉冲点：6px 圆点 */
.pulseDot {
  width: 6px;                     /* 行: 113: 裸值 6px */
  height: 6px;                    /* 行: 114: 裸值 6px */
}

/* 7. 展开主体卡片：外上边距 8px，圆角 10px */
.jsonToolCard {
  margin-top: var(--space-2, 8px); /* 行: 133 */
  border-radius: var(--radius-xl, 10px); /* 行: 134: 裸值回退 10px */
  border: 1px solid var(--border-subtle); /* 行: 135 */
  background: var(--bg-card);
}

/* 8. 内部卡片分区内衬：10px 14px */
.cardSection {
  padding: var(--space-2_5, 10px) var(--space-3_5, 14px); /* 行: 144: 裸值 10px 14px */
}

.sectionLabel {
  font-size: var(--font-size-micro, 11px);
  margin-bottom: var(--space-1_5, 6px); /* 行: 151 */
}

.divider {
  height: 1px;                    /* 行: 190 */
}
```

#### 事实证据与问题剖析
- **外边距不对称**：`.jsonToolCall` 的垂直外边距为 `margin: var(--space-1_5, 6px) 0;`（`ModernToolCall.module.css:12`），而下文的 `.terminalCard` 为 `margin: var(--space-2, 8px) 0;`（`ModernToolCall.module.css:200`），`.diffCard` 为 `margin: var(--space-2, 8px) 0;`（`ModernToolCall.module.css:646`）。同为顶级工具卡，卡片外边距在 6px 与 8px 之间摇摆，在连续渲染多个工具卡片时导致间距阶梯跳跃。
- **微距裸值补偿**：`.statusIcon` 的 `margin-left: 2px;`（`ModernToolCall.module.css:96`）属于典型的视觉贴边补偿代码。因为头部容器 `gap: 8px` 已经生效，但图标与胶囊之间为了视觉紧凑，又额外叠加了 2px 左外边距，缺乏明确的布局模型解释。
- **内衬非常规刻度**：`.cardSection` 使用了 `padding: var(--space-2_5, 10px) var(--space-3_5, 14px);`（`ModernToolCall.module.css:144`）。10px 和 14px 既非 4px 栅格（4, 8, 12, 16），也非 8px 栅格，属于 0.5 步进的非常规妥协值。

---

### 2.2 终端命令行卡片（ModernTerminalToolCall）

终端卡片在 `ModernToolCall.module.css` 中的内衬和控制条布局：

```css
/* apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css */

.terminalCard {
  margin: var(--space-2, 8px) 0;  /* 行: 200 */
  border-radius: var(--radius-xl, 10px); /* 行: 201 */
  border: 1px solid var(--border-subtle);
  background: var(--bg-card);
}

.terminalHead {
  gap: var(--space-2, 8px);       /* 行: 215 */
  padding: var(--space-2, 8px) var(--space-3, 12px); /* 行: 216: 8px 12px */
}

.terminalCopyBtn {
  width: 22px;                    /* 行: 257: 裸值 22px */
  height: 22px;                   /* 行: 258: 裸值 22px */
  border-radius: var(--radius-sm, 4px);
}

.terminalOutput {
  margin: 0;
  padding: var(--space-2_5, 10px) var(--space-3, 12px); /* 行: 304: 10px 12px */
  line-height: 1.5;
  background: color-mix(in srgb, var(--bg-card) 96%, var(--text-primary) 4%); /* 行: 316 */
}

.terminalLine {
  min-height: 18px;               /* 行: 321: 裸值 18px 行高锁定 */
  line-height: 1.5;
}

/* 渐进折叠条 */
.terminalMidFoldBarWrapper {
  margin: 4px 0;                  /* 行: 331: 裸值 4px */
}

.terminalMidFoldBar {
  gap: 6px;                       /* 行: 338: 裸值 6px */
  padding: 6px 12px;              /* 行: 340: 裸值 6px 12px */
  border-top: 1px dashed var(--border-subtle);    /* 行: 343: 虚线 */
  border-bottom: 1px dashed var(--border-subtle); /* 行: 344: 虚线 */
  border-radius: var(--radius-sm, 4px);
}

.terminalCollapseBtn {
  padding: 5px 12px;              /* 行: 376: 裸值 5px 12px */
  border-top: 1px dashed var(--border-subtle);
}
```

#### 事实证据与问题剖析
- **控制条内衬不对齐**：`.terminalMidFoldBar` 的 padding 为 `6px 12px`（`ModernToolCall.module.css:340`），而折叠按钮 `.terminalCollapseBtn` 的 padding 却是 `5px 12px`（`ModernToolCall.module.css:376`）。两者作为折叠与展开的对称控件，上下内衬相差 1px，缺乏几何一致性。
- **按钮尺寸离散**：`.terminalCopyBtn` 的尺寸为 `22px × 22px`（`ModernToolCall.module.css:257-258`），而在 `ChatToolCallBlock.module.css:564` 中，`.toolSectionActionBtn` 的高度是 `24px`；在 `AgentCard.module.css:108` 中，`.agentCardBtn` 是 `24px × 24px`；而在 `ChatToolCallBlock.module.css:906` 中，`.openInspectorBtn` 高度是 `22px`。22px 与 24px 并存，造成可点击区域（Hit Target）的微小漂移。

---

### 2.3 堆叠工具行与结果容器（ChatToolCallBlock.module.css）

`ChatToolCallBlock.module.css` 是主时间线工具堆叠的核心样式库，行数高达 1296 行。调研发现了大量裸值与规则冲突：

```css
/* apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css */

/* 1. 工具堆栈容器：2px 上下内衬 */
.toolStack {
  padding: 2px 0;                 /* 行: 9: 裸值 2px 0 */
  font-size: var(--font-size-sm);
}

.toolStack > .toolRow + .toolRow {
  margin-top: 1px;                /* 行: 17: 裸值 1px 间距 */
}

/* 2. 单行工具头：严格锁死 24px 高度 */
.toolRowHead {
  gap: 6px;                       /* 行: 60: 裸值 6px */
  padding: 0 4px;                 /* 行: 64: 裸值 0 4px */
  border-radius: var(--radius-md, 6px);
  height: 24px;                   /* 行: 70: 裸值 24px */
  min-height: 24px;               /* 行: 71 */
  max-height: 24px;               /* 行: 72 */
  line-height: 24px;              /* 行: 73 */
}

/* 3. 图标与指示器插槽：16px 与 14px */
.toolRowIcoSlot {
  flex: 0 0 16px;                 /* 行: 101: 裸值 16px */
  width: 16px;                    /* 行: 102 */
  height: 16px;                   /* 行: 103 */
}

.toolRowChevronSlot {
  flex: 0 0 14px;                 /* 行: 139: 裸值 14px */
  width: 14px;                    /* 行: 140 */
  height: 14px;                   /* 行: 141 */
}

/* 4. 运行/错误指示点：尺寸在 4px, 5px, 6px 间严重冲突！ */
.toolPulseDot {
  width: 4px;                     /* 行: 218: 裸值 4px */
  height: 4px;                    /* 行: 219 */
  margin-right: 5px;              /* 行: 227: 裸值 5px */
}

.toolErrorDot {
  width: 6px;                     /* 行: 240: 裸值 6px */
  height: 6px;                    /* 行: 241 */
  margin-right: 5px;              /* 行: 249 */
}

.toolLivePulseDot {
  width: 5px;                     /* 行: 1276: 裸值 5px */
  height: 5px;                    /* 行: 1277 */
}

.liveIndicator {
  width: 6px;                     /* 行: 1265: 裸值 6px */
  height: 6px;                    /* 行: 1266 */
}

/* 5. 分组线：2px 竖线，4px 边距，8px 内衬 */
.toolGroup {
  border-left: 2px solid var(--border-subtle); /* 行: 418 */
  margin: 4px 0;                  /* 行: 419 */
  padding-left: 8px;              /* 行: 420 */
}

/* 6. 展开结果容器主体：上下外边距 4px 0 6px 0 */
.toolResultBody {
  padding: 0;
  background: var(--bg-card);
  border-radius: var(--radius-lg, 8px); /* 行: 456 */
  border: 1px solid var(--border-subtle); /* 行: 457 */
  margin: 4px 0 6px 0;            /* 行: 458: 裸值 4px 0 6px 0 */
  box-shadow: var(--shadow-sm);
}

/* 7. 输入/输出分区分栏：10px 14px */
.toolSection {
  padding: 10px 14px;             /* 行: 480: 裸值 10px 14px */
}

.toolSectionInput {
  border-bottom: 1px solid var(--border-subtle); /* 行: 484: 中分割线 */
}

.toolSectionHeader {
  min-height: 20px;               /* 行: 503: 裸值 20px */
  margin-bottom: 6px;             /* 行: 504: 裸值 6px */
}

/* 8. 悬浮操作按钮栏：绝对定位裸值 */
.toolFloatingActions {
  position: absolute;
  top: 8px;                       /* 行: 555: 裸值 8px */
  right: 12px;                    /* 行: 556: 裸值 12px */
  gap: 4px;                       /* 行: 560 */
}

/* 9. 命令行单行展示内衬 */
.toolSectionShellSingleLine {
  padding: 6px 12px;              /* 行: 618: 裸值 6px 12px */
}

.toolMetaParam {
  margin-top: 2px;                /* 行: 677 */
  padding-left: 14px;             /* 行: 678: 裸值 14px 缩进 */
}

/* 10. Key-Value 表格布局 */
.toolKeyCell {
  min-width: 90px;                /* 行: 700: 裸值 90px 硬编码列宽 */
}

.toolValPre {
  padding: 4px 6px;               /* 行: 714: 裸值 4px 6px */
  border-radius: var(--radius-md, 6px);
  max-height: 160px;              /* 行: 719: 裸值 160px 最大高度 */
}

/* 11. 文件属性网格 */
.fileStatGrid {
  gap: 8px 16px;                  /* 行: 772: 裸值 8px 16px */
  padding: 2px 0;                 /* 行: 773 */
}

.fileStatLabel {
  min-width: 52px;                /* 行: 788: 裸值 52px */
}

/* 12. 文件跳转按钮的外边距偏移 */
.toolRowFileOpen {
  margin: 2px 0 4px 28px;         /* 行: 1069: 裸值 28px 缩进！ */
  padding: 2px 8px;               /* 行: 1076 */
}
```

#### 事实证据与问题剖析
1. **状态点尺寸（Dot Size）严重分裂**：
   - 运行脉冲点 `.toolPulseDot`（行 218）：`4px × 4px`；
   - 活跃脉冲点 `.toolLivePulseDot`（行 1276）：`5px × 5px`；
   - 子代理呼吸点 `.flowSubagentDot`（`InlineAgentPanel.module.css:70`）：`5px × 5px`；
   - 错误指示点 `.toolErrorDot`（行 240）：`6px × 6px`；
   - 实时指示点 `.liveIndicator`（行 1265）：`6px × 6px`；
   - 状态点 `.statusDot`（`AgentCard.module.css:405`）：`6px × 6px`；
   - 骨架屏点 `.skeletonDot`（`AgentCard.module.css:658`）：`6px × 6px`。
   在同一个桌面应用内，表示“运行/活跃”的小圆点在 4px、5px、6px 三种尺寸间混用，毫无系统规范。
2. **缩进基准（Indentation Anchors）断层**：
   - `.toolMetaParam` 的缩进是 `padding-left: 14px;`（行 678）；
   - `.toolRowFileOpen` 的左外边距缩进是 `margin-left: 28px;`（行 1069）；
   - `InlineAgentPanel.module.css:96` 中第二行链路追踪的缩进是 `padding-left: 22px;`；
   - `InlineAgentPanel.module.css:620` 中思考折叠体的缩进是 `padding-left: 18px;`。
   14px、18px、22px、28px 完全是各个开发者根据肉眼临时调凑出来的数字，没有统一基于“图标宽度 + gap”的几何对齐公式。

---

### 2.4 Diff 预览卡片内外边距与表格列宽（ToolCallDiffPreview / ModernToolCall.module.css）

在代码 Diff 差异比对卡片中，内外边距与三列布局存在精细但未 Token 化的排版：

```css
/* apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css */

.diffCardHeader,
.gitDiffCardHeader {
  min-height: 36px;               /* 行: 680: 裸值 36px 高度 */
  padding: var(--space-2, 8px) var(--space-3, 12px); /* 行: 674 */
  border-bottom: 1px solid var(--border-subtle);
}

.diffStatAdd,
.gitDiffAdd {
  padding: 1px 6px;               /* 行: 740: 裸值 1px 6px */
  border-radius: var(--radius-xs, 4px);
}

.diffActionBtn,
.diffCopyBtn {
  width: 24px;                    /* 行: 765: 裸值 24px */
  height: 24px;                   /* 行: 766 */
}

/* 核心三列排版：行号列、符号列、代码列 */
.diffGutterCol,
.lineNumCol {
  width: 36px;                    /* 行: 853: 裸值 36px 固定列宽 */
  min-width: 36px;                /* 行: 854 */
  padding: 1px 8px 1px 0;         /* 行: 857: 裸值 1px 8px 1px 0 */
  font-size: var(--font-size-micro, 11px);
}

.diffSignCol {
  width: 16px;                    /* 行: 865: 裸值 16px 固定列宽 */
  min-width: 16px;                /* 行: 866 */
  padding: 1px 0;                 /* 行: 870: 裸值 1px 0 */
}

.diffLineContent,
.lineContent {
  padding: 1px 10px;              /* 行: 888: 裸值 1px 10px */
}

.diffMoreIndicator {
  padding: 8px 12px;              /* 行: 914: 裸值 8px 12px */
  border-top: 1px solid var(--border-subtle);
}

.diffMoreBtn {
  padding: 3px 10px;              /* 行: 927: 裸值 3px 10px */
  border-radius: var(--radius-md, 6px);
  border: 1px solid var(--border-subtle);
}
```

#### 与 `ChatToolCallBlock.module.css` 中的 Diff 列宽严重割裂：
在 `ChatToolCallBlock.module.css` 中也存在一套旧版或并行的 `.lineNumCol`：
```css
/* apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:1192-1200 */
.lineNumCol {
  width: 22px;                    /* 严重冲突：这里是 22px，而上面是 36px！ */
  text-align: center;             /* 严重冲突：这里居中，而上面是右对齐 padding-right: 8px！ */
  user-select: none;
  border-right: none;
  padding: 2px 0;                 /* 严重冲突：这里是 2px 0，上面是 1px 8px 1px 0！ */
  flex-shrink: 0;
}
.lineContent {
  margin: 0;
  padding: 2px 10px;              /* 垂直 padding 2px vs 1px */
}
```
**严重事实**：在同一个仓库中，Diff 行号列宽存在 `36px`（右对齐带 8px 距）和 `22px`（居中无间距）两套截然相反的布局！一旦类名命中不同或组件复用漂移，代码 Diff 的行号列会产生剧烈的水平跳动。

---

## 三、维度二：嵌套容器边框叠加与视觉污染（Visual Noise & Border Stacking）

### 3.1 包含块容器链与边框堆叠模型

在典型的消息交互场景下，用户提出“分析代码并修复错误”，助手消息会渲染工具调用栈。以下是真实的 DOM 嵌套层级与每层容器所施加的边框/发丝线：

| 层级 | 容器组件与类名 | 包含文件与行号 | 边框与阴影声明 | 背景填充 |
| :--- | :--- | :--- | :--- | :--- |
| **L1 消息行** | `ChatMessageRow` (`.rowAssistant`) | `ChatMessageRow.module.css:48` | 无边框（纯 padding-bottom: 16px） | 透明 |
| **L2 时间线项** | `ProcessItemRenderer` (`.toolsTimelineItem`) | `MessageContent.module.css:130` | 无边框 | 透明 |
| **L3 工具集成区** | `MessageToolCallsSection` (`.timelineTools`) | `ChatMessageRow.module.css:802` | `border: none;` | 透明 |
| **L4 工具堆栈** | `ChatToolStack` (`.toolStack`) | `ChatToolCallBlock.module.css:2` | 无边框 | 透明 |
| **L5 工具单行** | `CompactToolRow` (`.toolRow`) | `ChatToolCallBlock.module.css:21` | 折叠态无边框 | 透明 |
| **L6 展开卡主体** | `ToolCallOutput` (`.toolResultBody`) | `ChatToolCallBlock.module.css:450` | **`border: 1px solid var(--border-subtle);`**<br>`box-shadow: var(--shadow-sm);`<br>`border-radius: var(--radius-lg, 8px);` | `var(--bg-card)` |
| **L7 输入输出分区**| `ToolCallInputPane` (`.toolSectionInput`) | `ChatToolCallBlock.module.css:484` | **`border-bottom: 1px solid var(--border-subtle);`** | 透明 |
| **L8 嵌套子块** | `ToolCallDiffPreview` (`.diffCard`) | `ModernToolCall.module.css:644` | **`border: 1px solid var(--border-subtle);`**<br>`border-radius: var(--radius-xl, 10px);` | `var(--bg-card)` |
| **L9 Diff 头部** | `.diffCardHeader` | `ModernToolCall.module.css:668` | **`border-bottom: 1px solid var(--border-subtle);`** | `color-mix(...)` |
| **L10 嵌套代码块** | `ModernCodeBlock` (`.codeBlockCard`) | `ModernToolCall.module.css:560` | **`border: 1px solid var(--border-subtle);`**<br>`border-radius: var(--radius-lg, 8px);` | `var(--bg-card)` |
| **L11 参数 Pre 块** | `toolValPre` (`.toolValPre`) | `ChatToolCallBlock.module.css:712` | **`border: 1px solid var(--border-subtle);`**<br>`border-radius: var(--radius-md, 6px);` | `var(--bg-primary)` |

### 3.2 边框叠加产生的视觉污染现象

#### 现象 1：“框中套框”的 3 重边框嵌套
当工具展开且内部包含 Diff 时，L6（`.toolResultBody`）、L8（`.diffCard`）与 L10（`.codeBlockCard`）直接产生 3 重同质边框嵌套：
1. 外层边框：`toolResultBody` 的 `1px solid var(--border-subtle)`（带 8px 圆角）；
2. 中层边框：`diffCard` 的 `1px solid var(--border-subtle)`（带 10px 圆角）；
3. 内部元素：`diffPreviewTag` 的 `1px solid var(--border-subtle)` 或 `diffMoreBtn` 的 `1px solid var(--border-subtle)`。

#### 现象 2：`!important` 补丁治理的死角与反模式
为了缓解上述嵌套边框问题，开发者在代码中注入了硬性清除代码：
```css
/* apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css:660-666 */
.diffCard.embeddedDiffCard,
.gitDiffCard.embeddedDiffCard {
  border: none;
  border-radius: 0;
  margin: 0;
  background: transparent;
}

/* apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:609-614 */
.embeddedDiffCard {
  border: none !important;
  border-radius: 0 !important;
  margin: 0 !important;
  background: transparent !important;
}
```
**严重事实**：
- 使用了 4 个 `!important` 强制重置 `border`、`border-radius`、`margin` 和 `background`！这直接违背了 `AGENTS.md` §7“严禁补丁、绕过与作弊”中“穿透表象找到架构断层，用原生、精确方式解决问题”的铁律。
- 该补丁仅对传递了 `className={styles.embeddedDiffCard}` 的 `ToolCallDiffPreview` 起效；如果工具渲染的是 `ModernTerminalToolCall`、`ModernApprovalCard`、`toolValPre` 或自定义插件卡片，这一套抹平机制完全失效，双重甚至三重边框依然原样暴露。

#### 现象 3：圆角嵌套的几何数学失真（Nested Radius Mismatch）
UI 几何学中，嵌套容器的圆角必须满足 **$R_{outer} = R_{inner} + Padding$**，否则内层圆角会在转角处与外层圆角发生贴角或产生畸变。
现状数据：
- 外层 `.toolResultBody`：`border-radius: var(--radius-lg, 8px);`，内衬 `padding: 10px 14px;`；
- 内层 `.diffCard`：`border-radius: var(--radius-xl, 10px);`；
- 内层 `.toolValPre`：`border-radius: var(--radius-md, 6px);`。
当外层半径为 8px、内衬为 10px 时，内层如果保留 10px 圆角，外层圆角曲率反而小于内层（$8px < 10px$），在转角处形成极为怪异的“内大外小”几何畸变。

#### 现象 4：暗色模式与浅色模式下的发丝线混用污染
代码库中同时混用了以下多种边框变量：
1. `var(--border-subtle)`
2. `var(--hairline, var(--border-subtle))`
3. `var(--hairline-strong, var(--border-color))`
4. `var(--border-color)`
5. `rgba(0, 0, 0, 0.10)`（`InlineAgentPanel.module.css:140`）
6. `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`（焦点态）

在深色主题（Dark Mode）下，`rgba(0, 0, 0, 0.10)` 变成纯黑且带有微弱脏感，而 `var(--hairline)` 则由于不同组件使用了不同的回退，导致有的边框亮、有的边框暗、有的发丝线在 125% 或 150% DPI 缩放下发生亚像素闪烁（Subpixel Jitter）。

---

## 四、维度三：子代理（Subagent）时间线与展开面板内边距调研

### 4.1 子代理在主对话流中的时间线行内徽标（InlineAgentPanel.module.css）

在主会话时间线中，子代理通过 `InlineAgentPanel.tsx` 渲染为行内协作条：

```css
/* apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css */

/* 1. 时间线宿主：左内衬 2px */
.flowSubagent {
  margin: 2px 0;                  /* 行: 3 */
  padding-left: var(--space-0_5, 2px); /* 行: 5: 裸值 2px */
}

/* 2. 第一行头部：高度 24px，零内衬 */
.flowSubagentLine1 {
  gap: 6px;                       /* 行: 12: 裸值 6px */
  min-height: 24px;               /* 行: 15: 裸值 24px */
  padding: 0;                     /* 行: 16 */
  margin: 0;
  font-size: var(--font-size-sm, 13px);
}

.flowSubagentIcon {
  width: 16px;                    /* 行: 37: 裸值 16px */
  height: 16px;                   /* 行: 38 */
}

.flowSubagentTitle {
  max-width: 60%;                 /* 行: 54: 裸值 60% */
}

/* 3. 呼吸指示绿点：5px 尺寸与 2.5px/4.5px 扩散环 */
.flowSubagentDot {
  width: 5px;                     /* 行: 70: 裸值 5px */
  height: 5px;                    /* 行: 71 */
  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--accent-color) 22%, transparent); /* 行: 74 */
}

/* 4. 第二行链路追踪：高度 22px，强行内衬 22px 缩进！ */
.flowSubagentLine2 {
  gap: 8px;                       /* 行: 95: 裸值 8px */
  padding: 1px 0 1px 22px;        /* 行: 96: 裸值 22px 缩进！ */
  min-height: 22px;               /* 行: 99: 裸值 22px */
  font-size: var(--font-size-sm, 13px);
}

/* 5. 展开面板：左轨线与内衬 */
.flowSubagentPanel {
  margin: 4px 0 6px 4px;          /* 行: 133: 裸值 4px 0 6px 4px */
  padding: 3px 0 3px 12px;        /* 行: 134: 裸值 3px 0 3px 12px */
  max-height: 280px;              /* 行: 136: 裸值 280px */
  border-left: 1px solid rgba(0, 0, 0, 0.10); /* 行: 140: 裸色 rgba(0,0,0,0.10)！ */
}

.flowSubagentPanelInner {
  max-height: 274px;              /* 行: 146 */
  gap: 6px;                       /* 行: 151: 裸值 6px */
  padding: 4px 4px 8px 4px;       /* 行: 152: 裸值 4px 4px 8px 4px */
}

/* 6. 折叠头部行（InlineAgentPanelHeader） */
.inlineAgentHeadRow {
  min-height: 26px;               /* 行: 173: 裸值 26px 高度 */
}

.inlineAgentHead {
  gap: 5px;                       /* 行: 179: 裸值 5px */
  padding: 4px 6px 4px 8px;       /* 行: 185: 裸值 4px 6px 4px 8px */
  min-height: 26px;               /* 行: 190: 裸值 26px */
}

.inlineAgentHeadActions {
  padding: 2px 6px;               /* 行: 208: 裸值 2px 6px */
}

.agentHeadBtn {
  width: 24px;                    /* 行: 235: 裸值 24px */
  height: 24px;                   /* 行: 236 */
  border-radius: var(--radius-sm);
}

/* 7. 展开流与输入框容器内衬 */
.inlineAgentStream {
  max-height: 240px;              /* 行: 428 */
  padding: 5px 8px;               /* 行: 430: 裸值 5px 8px */
}

.inlineAgentComposerWrap {
  padding: var(--space-2, 6px);   /* 行: 500: 裸值 6px */
}

.inlineAgentComposerWrapDense {
  padding: var(--space-1, 4px) var(--space-2, 5px) var(--space-2, 5px); /* 行: 508: 裸值 4px 5px 5px */
}
```

### 4.2 独立/嵌入子代理卡片（AgentCard.module.css）

作为对比，右侧侧栏或全屏卡片 `AgentCard.module.css` 的排版：

```css
/* apps/crish-desktop/src/components/agent-card/AgentCard.module.css */

/* 1. 头部高度与内衬：32px 严格限制 vs Slim 28px */
.agentCardHeader {
  gap: 4px;                       /* 行: 29: 裸值 4px */
  padding: 0 8px;                 /* 行: 30: 裸值 0 8px */
  height: 32px;                   /* 行: 31: 裸值 32px */
  min-height: 32px;               /* 行: 32 */
  max-height: 32px;               /* 行: 33 */
  border-bottom: 1px solid var(--hairline, var(--border-subtle));
}

.agentCardHeaderSlim {
  padding: 3px 6px;               /* 行: 185: 覆盖为 3px 6px */
  min-height: 28px;               /* 行: 186: 覆盖为 28px！与 height: 32px 冲突！ */
}

/* 2. 状态徽标与操作按钮 */
.agentCardBadge {
  padding: 0 5px;                 /* 行: 59: 裸值 0 5px */
  border-radius: var(--radius-sm, 4px);
  line-height: 1.45;
}

.agentCardBtn {
  width: 24px;                    /* 行: 107: 裸值 24px */
  height: 24px;                   /* 行: 108 */
  padding: var(--space-0_5);
}

/* 3. 卡片主体内衬：常规 6px 8px 8px vs 紧凑 4px 6px 6px */
.agentCardBody {
  padding: 6px 8px 8px;           /* 行: 137: 裸值 6px 8px 8px */
}

.agentCardDense .agentCardBody {
  padding: 4px 6px 6px;           /* 行: 141: 裸值 4px 6px 6px */
}

/* 4. 空状态内衬的多种撕裂 */
.agentCardEmpty {
  padding: 20px 12px;             /* 行: 22: 裸值 20px 12px */
  gap: var(--space-1_5);
}

.agentCardEmptyMsgs {
  padding: 14px 6px;              /* 行: 147: 裸值 14px 6px */
}

.agentCardEmptyHintPad {
  padding: 16px 10px;             /* 行: 558: 裸值 16px 10px */
}

/* 5. 提示气泡与骨架屏内衬 */
.agentPromptBubble {
  padding: 5px 8px;               /* 行: 167: 裸值 5px 8px */
  border-radius: var(--radius-lg);
}

.skeletonContainer {
  padding: 16px 12px;             /* 行: 617: 裸值 16px 12px */
  gap: var(--space-3);
}

.skeletonCard {
  padding: 8px 10px;              /* 行: 646: 裸值 8px 10px */
}

/* 6. 多 Agent 团队看板 */
.agentTeamBoard {
  padding: 4px 6px 5px;           /* 行: 299: 裸值 4px 6px 5px */
}

.agentTeamBoardCompact {
  padding: 3px 5px 4px;           /* 行: 314: 裸值 3px 5px 4px */
}

.agentTeamCard {
  padding: 5px 8px;               /* 行: 374: 裸值 5px 8px */
  border-radius: var(--radius-md);
}

/* 7. 输入区底部渐变栏内衬 */
.agentCardComposer {
  padding: 10px 8px 8px;          /* 行: 585: 裸值 10px 8px 8px */
}

.agentCardComposerDense {
  padding: 8px 6px 6px;           /* 行: 592: 裸值 8px 6px 6px */
}
```

### 4.3 头部高度阶梯对比与严重冲突

将系统中所有涉案组件的“头部控制行高度”汇总横向对比，发现了令人触目惊心的割裂：

| 组件名称 | CSS 类名与文件位置 | 高度声明方式 | 实际高度值 | 内边距 (Padding) |
| :--- | :--- | :--- | :--- | :--- |
| **通用工具单行头** | `.toolRowHead` (`ChatToolCallBlock:70-72`) | `height: 24px; min/max: 24px` | **24px** | `0 4px` |
| **子代理时间线行 1** | `.flowSubagentLine1` (`InlineAgentPanel:15`) | `min-height: 24px` | **24px** | `0` |
| **子代理时间线行 2** | `.flowSubagentLine2` (`InlineAgentPanel:99`) | `min-height: 22px` | **22px** | `1px 0 1px 22px` |
| **子代理折叠头** | `.inlineAgentHead` (`InlineAgentPanel:190`) | `min-height: 26px` | **26px** | `4px 6px 4px 8px` |
| **子代理卡片 Slim 头**| `.agentCardHeaderSlim` (`AgentCard:186`) | `min-height: 28px` | **28px** (冲突) | `3px 6px` |
| **子代理卡片常规头** | `.agentCardHeader` (`AgentCard:31-33`) | `height: 32px; min/max: 32px` | **32px** | `0 8px` |
| **Diff 差异卡片头** | `.diffCardHeader` (`ModernToolCall:680`) | `min-height: 36px` | **36px** | `8px 12px` |
| **GitDiff 差异卡片头**| `.gitDiffCardHeader` (`ChatToolCallBlock:1102`)| `min-height: var(--..., 36px)`| **36px** | `4px 8px` |
| **轮次过程折叠条** | `.turnProcessControlBar` (`MessageContent:15`)| `height: 33px` | **33px** | `6px 0` |

#### 深度问题诊断：
1. **高度从 22px 到 36px 离散多达 8 个层级**（22, 24, 26, 28, 32, 33, 36），完全不存在一个基准的 `--header-height-sm`、`--header-height-md` 规范。
2. **CSS 规则自相矛盾**：在 `AgentCardHeader.tsx:44` 中，同时挂载了两个类名：
   `className={`${styles.agentCardHeader} ${styles.agentCardHeaderSlim}`}`。
   - `styles.agentCardHeader` 声明了：`height: 32px; min-height: 32px; max-height: 32px;`；
   - `styles.agentCardHeaderSlim` 声明了：`min-height: 28px;`。
   由于 `max-height: 32px` 和 `height: 32px` 依然有效，`min-height: 28px` 根本无法将容器高度缩减至 28px，只能靠内部 `padding: 3px 6px` 产生轻微视觉变化，属于死代码级别的样式冲突！

---

## 五、维度四：审批卡片（ApprovalAskCard）内外边距与按钮组对齐

### 5.1 双套审批卡片实现分裂对比

系统中存在两套并行的审批卡片实现，反映了不同迭代时期的设计思路冲突：

```
实现 A: ModernApprovalCard.tsx + ModernToolCall.module.css:401-556
  - 定位：极简高危命令执行授权卡片（单层纯净黑白灰，Raycast 级）
  - 外观：无彩色边框，灰色背景，极简黑白灰按钮

实现 B: ApprovalAskCard.tsx + ApprovalAskCard.module.css:1-302
  - 定位：生产级权限与风险控制卡（信任域、风险等级颜色条、倒计时、白名单记住）
  - 外观：带 4px/6px 彩色左边框（橙/红/绿），复杂芯片，可选说明输入框
```

#### 实现 A（ModernApprovalCard）内衬与阶梯：
- 容器外边距：`margin: var(--space-2, 8px) 0;`
- 容器圆角：`border-radius: var(--radius-xl, 12px);`
- 头部内边距：`padding: var(--space-3, 12px) var(--space-4, 16px); gap: var(--space-3, 12px);`
- 标题字号：`font-size: 13.5px;`（非标准浮点字号）
- 主体内衬：`padding: 14px 16px;`（裸值 14px 16px）
- 底部内衬：`padding: 12px 16px; gap: var(--space-3, 12px);`
- 按钮间距：`gap: var(--space-2, 8px);`

#### 实现 B（ApprovalAskCard）内衬与阶梯：
- 容器外边距：`margin: 6px 0 8px;`（dense 下：`margin: 4px 0;`）
- 容器圆角：`border-radius: var(--radius-lg);`
- 容器边框：`border: 1px solid var(--hairline, var(--border-subtle)); border-left: 4px solid var(--accent-orange);`
  - 当 `data-risk-level="critical"` 时：`border-left-width: 6px; border-left-color: var(--accent-danger);`
- 容器内衬：`padding: 10px 12px 12px 14px;`（左侧 14px，其余 10px/12px，dense 下：`padding: 8px 8px 7px;`）
- 内部垂直 gap：`gap: var(--space-1_5);`

```css
/* apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css */

.approvalCard {
  margin: 6px 0 8px;              /* 行: 2: 裸值 6px 0 8px */
  padding: 10px 12px 12px 14px;  /* 行: 3: 裸值 10px 12px 12px 14px */
  border-radius: var(--radius-lg);
  border: 1px solid var(--hairline, var(--border-subtle));
  border-left: 4px solid var(--accent-orange); /* 行: 6: 4px 色条 */
  gap: var(--space-1_5);
}

.approvalCardTop {
  gap: var(--space-1_5);          /* 行: 20 */
}

/* 风险标签芯片 */
.approvalCardChip {
  padding: 1px 6px;               /* 行: 95: 裸值 1px 6px */
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--hairline, var(--border-subtle));
}

/* 命令行执行框 */
.approvalCardCmd {
  padding: 4px 0;                 /* 行: 155: 裸值 4px 0 */
  max-height: 4.5em;              /* 行: 160: 裸值 4.5em */
}

/* 补充说明 Textarea 输入框 */
.approvalCardNote {
  gap: 3px;                       /* 行: 167: 裸值 3px */
  margin-top: var(--space-0_5);   /* 行: 170 */
}

.approvalCardInput {
  min-height: 40px;               /* 行: 175: 裸值 40px */
  max-height: 96px;               /* 行: 176: 裸值 96px */
  padding: 6px 8px;               /* 行: 180: 裸值 6px 8px */
  border: 1px solid var(--hairline-strong, var(--border-color, var(--border-subtle)));
  border-radius: var(--radius-md);
}

/* 底部操作按钮栏 */
.approvalCardActions {
  display: flex;
  flex-wrap: wrap;                /* 行: 204: 允许换行 */
  justify-content: flex-end;      /* 行: 205: 靠右对齐 */
  gap: var(--space-1_5);          /* 行: 206 */
  margin-top: var(--space-0_5);   /* 行: 207 */
}

.approvalCardBtn {
  height: 28px;                   /* 行: 211: 裸值 28px 高度 */
  padding: 0 12px;                /* 行: 212: 裸值 0 12px */
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--hairline-strong, var(--border-color, var(--border-subtle)));
}

/* 紧凑模式下的规则覆盖 */
:global(.agent-card--dense) .approvalCard {
  margin: 4px 0;                  /* 行: 263 */
  padding: 8px 8px 7px;           /* 行: 264: 裸值 8px 8px 7px，左侧补偿消失！ */
}

:global(.agent-card--dense) .approvalCardActions {
  gap: var(--space-1);            /* 行: 270 */
}

:global(.agent-card--dense) .approvalCardBtn {
  min-height: 28px;               /* 行: 274: min-height 28px，与常规 height 28px 产生属性漂移！ */
  padding: 4px 8px;               /* 行: 275: 裸值 4px 8px */
}

/* 倒计时条 */
.approvalCardTimeoutBar {
  height: 2px;                    /* 行: 282: 裸值 2px */
  margin: 6px 0 0;                /* 行: 283: 裸值 6px 0 0 */
}
```

### 5.2 按钮组对齐与几何缺陷分析

1. **左侧内衬补偿在紧凑态丢失**：
   - 常规态下，`.approvalCard` 的内边距是 `10px 12px 12px 14px;`（左侧 14px）。这是因为左侧存在 `4px solid var(--accent-orange)`（或 6px critical），设计师特意多给了 2px 左内衬，以使内部文本在视觉重心上居中。
   - 然而在 `:global(.agent-card--dense) .approvalCard`（行 264）中，内边距被粗暴地重写为 `8px 8px 7px;`，左内衬与右内衬完全等同为 8px。由于左侧 4px 边框的物理占位，内容文本立刻向右紧贴边框，导致视觉压抑。
2. **按钮高度声明属性不一致**：
   - 常规态 `.approvalCardBtn`（行 211）使用 `height: 28px;`；
   - 紧凑态 `:global(.agent-card--dense) .approvalCardBtn`（行 274）却使用 `min-height: 28px;` 并加上 `padding: 4px 8px;`。若字体或图标稍大，高度就会被撑开超过 28px，破坏垂直栅格锁合。
3. **按钮换行时的垂直错位**：
   `.approvalCardActions` 包含了“取消准备 (Esc)”、“记住并允许”、“拒绝”、“允许”多达 3~4 个按钮。在侧栏面板（宽度通常在 280px~340px）中，这些按钮必定发生折行换行（`flex-wrap: wrap`）。此时由于只设置了 `gap: var(--space-1_5)`，换行后的上一行按钮与下一行按钮之间贴紧，且由于缺乏专用的按钮容器分栏规划，会导致输入框、提示信息与按钮组之间的视觉重叠。

---

## 六、维度五：散落裸值清单统计与 Token 规范缺失诊断

### 6.1 全量裸值分布透视表（Bare Value Matrix）

经过全量代码分析，在所涉样式表中出现的硬编码裸值（完全未使用 CSS 变量，或在回退项中发明了未注册刻度）分布如下：

| 测量类型 | 出现的散落裸值 | 具体文件与代表行号 | 造成的体验缺陷与规范缺失 |
| :--- | :--- | :--- | :--- |
| **高度 (Height)** | `1.5px`, `2px`, `20px`, `22px`, `24px`, `26px`, `28px`, `32px`, `33px`, `36px`, `40px` | `ModernToolCall:258,680`<br>`ChatToolCallBlock:70,503,1102`<br>`InlineAgentPanel:15,99,173`<br>`AgentCard:31,186`<br>`ApprovalAskCard:175,211` | 头部控制栏存在 8 级不同高度；按钮与插槽高度各异；无统一 Header/Row 高度 Token |
| **外边距 (Margin)** | `1px`, `2px`, `4px`, `6px`, `8px`, `14px`, `28px` | `ChatToolCallBlock:17,419,458,677,1069`<br>`InlineAgentPanel:3,133`<br>`ApprovalAskCard:2,170,207` | 缩进基准无数学模型（14px, 18px, 22px, 28px 混用）；上下间距 1px 到 8px 随机波动 |
| **内边距 (Padding)** | `0 4px`, `0 5px`, `0 8px`, `1px 6px`, `1px 10px`, `2px 0`, `2px 6px`, `2px 8px`, `3px 6px`, `4px 0`, `4px 6px`, `5px 8px`, `6px 8px`, `6px 12px`, `7px 12px`, `8px 10px`, `10px 12px`, `10px 14px`, `12px 16px`, `14px 6px`, `14px 16px`, `16px 10px`, `16px 12px`, `20px 12px` | `ModernToolCall:24,76,144,216,304,340,418,465,529,674,857,888`<br>`ChatToolCallBlock:9,64,480,618,714,773,1076,1101,1197,1214`<br>`AgentCard:22,30,59,137,141,147,167,185,299,314,374,558,585,617,646`<br>`InlineAgentPanel:96,134,152,185,208,430,508`<br>`ApprovalAskCard:3,95,180,212,264,275` | 内边距组合多达 24 种！没有标准卡片内衬阶梯（Compact/Normal/Relaxed），全部各自手写复合值 |
| **间距 (Gap)** | `1px`, `2px`, `3px`, `4px`, `5px`, `6px`, `8px`, `12px`, `14px`, `16px` | `ModernToolCall:21,215,615,673,723,732,913`<br>`ChatToolCallBlock:60,435,511,625,632,654,675,696,742,772,812`<br>`AgentCard:19,29,44,152,208,321,359,440,478,616,648`<br>`InlineAgentPanel:12,95,151,179,206,445,470`<br>`ApprovalAskCard:10,20,87,142,167,206,270` | 水平/垂直 gap 出现奇数（1px, 3px, 5px）与非 Token 偶数（6px, 12px, 14px），无规则 |
| **圆角 (Radius)** | `2px`, `4px`, `6px`, `8px`, `10px`, `12px`, `999px` | `ModernToolCall:34,77,134,201,259,350,403,434,476,547,562,647,741,768,793,928`<br>`ChatToolCallBlock:23,65,146,456,569,717,908,966,1019,1046,1077,1091`<br>`AgentCard:60,101,168,214,272,352,376,501,644,668,676`<br>`InlineAgentPanel:239,298,454,461,527`<br>`ApprovalAskCard:4,96,179,213,265,284` | 圆角存在 8px, 10px, 12px 混乱嵌套；数学几何关系未锁定 |
| **点与图符尺寸** | `4px`, `5px`, `6px`, `8px`, `11px`, `12px`, `13px`, `13.5px`, `14px`, `16px`, `22px`, `24px` | `ModernToolCall:52,94,113,257,432,765`<br>`ChatToolCallBlock:102,140,218,240,327,380,564,963,1265,1276`<br>`AgentCard:107,405,415,423`<br>`InlineAgentPanel:37,70,235`<br>`ApprovalAskCard:211` | 图标、点指示器、控制按钮尺寸互不兼容，未归入 Icon / Indicator Token 刻度 |

### 6.2 Token 语义断层深度分析

通过审查 `apps/crish-desktop/src/` 中的全局样式变量，发现目前系统只定义了部分低阶或零散的 CSS 变量（如 `--space-1` 到 `--space-4`），但在组件消费层存在三重断裂：
1. **回退值直接成为实际标准**：
   例如 `var(--space-1_5, 6px)`、`var(--space-2, 8px)`、`var(--space-2_5, 10px)`、`var(--space-3_5, 14px)`。大量组件直接在 fallback 参数中塞入任意数字，导致一旦全局变量未命中，组件便呈现各自不同的回退尺寸。
2. **缺乏组件级语义 Token（Semantic Component Tokens）**：
   系统缺乏如下高阶语义 Token：
   - `--card-padding-compact`: `6px 8px`
   - `--card-padding-normal`: `10px 12px`
   - `--card-padding-relaxed`: `14px 16px`
   - `--tool-row-height`: `24px`
   - `--card-header-height`: `32px`
   - `--indicator-dot-size`: `6px`
   - `--radius-card-outer`: `8px`
   - `--radius-card-inner`: `6px`
   由于缺乏这些语义契约，每一个写 CSS 的开发者都在使用裸值或随意拼凑 `--space-*`。
3. **样式污染与 CSS 作用域渗透**：
   在 `ApprovalAskCard.module.css:262`、`InlineAgentPanel.module.css:524`、`ChatToolCallBlock.module.css:609` 中，频繁使用 `:global(.agent-card--dense)`、`:global(.approval-card)`、`!important` 进行反向覆盖，导致嵌套层级越深，样式特异性（Specificity）越高，最终无法系统性维护。

---

## 七、调研整改建议与架构演进方案（面向第二阶段）

基于上述事实证据，提出在系统性 Token 体系建设第二阶段必须落地的六项架构重构契约：

### 7.1 建立 3 层 Token 架构模型（3-Tier Token System）

1. **第 1 层：全局几何基尺（Global Geometric Primitives）**
   - 严格基于 4px 栅格步进，严禁奇数与小数值：
     - `--scale-0_5: 2px;`
     - `--scale-1: 4px;`
     - `--scale-1_5: 6px;`
     - `--scale-2: 8px;`
     - `--scale-3: 12px;`
     - `--scale-4: 16px;`
     - `--scale-5: 20px;`
     - `--scale-6: 24px;`
     - `--scale-8: 32px;`
2. **第 2 层：布局语义 Token（Layout Semantic Tokens）**
   - 统一内外边距阶梯：
     - `--inset-card-sm: var(--scale-1_5) var(--scale-2);` (6px 8px)
     - `--inset-card-md: var(--scale-2) var(--scale-3);` (8px 12px)
     - `--inset-card-lg: var(--scale-3) var(--scale-4);` (12px 16px)
   - 统一控制行高度：
     - `--row-height-compact: 24px;` (对应极简工具行与时间线单行)
     - `--row-height-header: 32px;` (对应卡片与分栏头部)
3. **第 3 层：组件专有契约 Token（Component Contract Tokens）**
   - `--tool-card-outer-radius: var(--radius-lg, 8px);`
   - `--tool-card-inner-radius: var(--radius-md, 6px);`
   - `--tool-dot-size: 6px;`（全系统统一指示点为 6px，废除 4px 与 5px）

### 7.2 边框穿透与嵌套消除规范（No Border Pollution Rule）

1. **废除 `!important` 补丁**：
   在组件架构设计上明确**单一包含块原则（Single Box Model）**。当 `ToolCallDiffPreview` 作为子组件渲染于 `ToolCallOutput` 内时，由父级上下文通过属性驱动（如 `variant="embedded"`），原生不施加外层 border、margin 与 shadow，而非通过类名覆盖并加 `!important`。
2. **嵌套圆角数学法则（Radius Inset Math）**：
   在所有嵌套卡片中，刚性推行：
   $$R_{inner} = \max(0, R_{outer} - Padding_{inner})$$
   当外层卡片圆角为 8px，内衬为 10px 时，内层容器圆角必须为 0 或至多 4px，彻底根治“外小内大”畸变。

### 7.3 子代理时间线与高度阶梯收敛

1. **头部高度归一化**：
   - 所有的行内时间线控制行（`flowSubagentLine1`、`toolRowHead`、`inlineAgentHead`）统一锁定为 **24px**；
   - 所有的卡片级标题栏（`agentCardHeader`、`diffCardHeader`）统一锁定为 **32px**；
   - 彻底清除 22px、26px、28px、33px、36px 等过渡性无序高度。
2. **统一缩进几何公式**：
   - 第二行与下级折叠的缩进必须严格对齐：
     $$\text{Indent} = \text{Icon Width (16px)} + \text{Gap (8px)} = 24px$$
   - 彻底废除手写的 14px、18px、22px、28px 散落缩进。

### 7.4 审批卡片统一合并与对称几何校准

1. **收敛双套实现**：
   废除已沦为死代码或残缺实现的 `ModernApprovalCard.tsx`，将极简纯净的视觉语言（深浅中性黑白灰）与 `ApprovalAskCard.tsx` 完整的风险后端（`riskMeta`、`requiresDoubleConfirm`、倒计时）合二为一。
2. **内衬与左侧色条平衡模型**：
   当存在 4px 左侧指示条时，通过内衬 Token `--approval-card-pad-l` 统一计算：
   $$\text{Padding-Left} = \text{Base Padding (12px)} + \text{Bar Width (4px)} - \text{Optical Compensation (2px)} = 14px$$
   并在 dense 模式下等比例收缩为 10px，禁止粗暴清空补偿。

---

## 八、附录：重点涉案代码位置索引

| 组件/文件路径 | 关键行号 | 涉及调研维度与事实描述 |
| :--- | :--- | :--- |
| `apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css` | 12, 24, 76, 96, 134, 144 | 结构化 JSON 工具卡片外边距 6px、头部 padding 4px 0、胶囊 2px 8px、散落裸值 10px 14px |
| `apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css` | 200, 216, 258, 304, 340, 376 | 终端卡片外边距 8px、输出内衬 10px 12px、复制按钮 22px、折叠栏 6px vs 5px 对称失衡 |
| `apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css` | 403, 440, 465, 529 | 审批卡片圆角 12px、标题字号 13.5px 裸浮点数、主体内衬 14px 16px |
| `apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css` | 660-666, 680, 853, 865, 888 | Diff 卡片 embeddedDiffCard 抹平补丁、头部高度 36px、行号列宽 36px |
| `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 70-73, 101, 139, 218, 240 | 单行工具头 24px 严格死锁、图标槽 16px、指示点 4px vs 6px 分裂 |
| `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 418-420, 456-458, 480, 555 | 分组左线 2px、结果卡片外边距 4px 0 6px 0、分区内衬 10px 14px、悬浮栏 top: 8px right: 12px |
| `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 609-614 | 4 个 `!important` 强行重置 embeddedDiffCard 的反模式证据 |
| `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 700, 714, 772, 788, 1069 | 表格列宽 90px、Pre 块 4px 6px、文件网格 52px、文件跳转 28px 缩进 |
| `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 1192-1200 | Diff 差异行号列宽 22px（与 ModernToolCall 的 36px 严重冲突） |
| `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 1265, 1276 | 实时指示点 6px vs 脉冲点 5px 尺寸混用 |
| `apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css` | 15, 70, 96, 99, 140, 152 | 行 1 24px、指示绿点 5px、行 2 22px 缩进与 22px 高度、左轨线硬编码 rgba(0,0,0,0.10) |
| `apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css` | 173, 185, 235, 430, 508 | 折叠头 26px 高度、按钮 24px、展开流 5px 8px、输入区 wrap 4px 5px 5px 裸值 |
| `apps/crish-desktop/src/components/agent-card/AgentCard.module.css` | 22, 31-33, 59, 137, 141, 185-186 | 空态内衬 20px 12px、头部 32px 与 Slim 28px 声明冲突、主体内衬 6px 8px 8px vs 4px 6px 6px |
| `apps/crish-desktop/src/components/agent-card/AgentCard.module.css` | 299, 314, 374, 558, 585, 617, 646 | 团队看板内衬 4px 6px 5px vs 3px 5px 4px、空态提示 16px 10px、输入底部 10px 8px 8px、骨架屏 16px 12px |
| `apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css` | 2, 3, 6, 46, 175, 211, 264, 274 | 审批卡外边距 6px 0 8px、内边距 10px 12px 12px 14px（dense 8px 8px 7px 补偿丢失）、按钮 height 28px vs min-height 28px |
