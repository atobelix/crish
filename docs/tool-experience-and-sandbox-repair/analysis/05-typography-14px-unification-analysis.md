# 消息流与工具调用排版字号统一至 14px 深度调研与架构规划报告

> 战役工作区：`docs/tool-experience-and-sandbox-repair/`  
> 责任席位：子 Agent A5（Typography Specialist）  
> 调研目标：落实用户最新裁决“文字现在统一调整到14px吧，我看13或者更小的有点看不清了。当然工具调用的输出结果维持小一点是没问题的”，深入排查前端聊天流、过程段与工具调用相关组件及 CSS 样式，建立双阵营（14px 目标类 vs 小号代码类）精密分类标准，给出垂直居中、行高与图标适配方案，并梳理完整的测试契约变更清单。

---

## 一、用户诉求穿透与字号架构沿革

### 1. 用户最新裁决原文
> **“然后就是文字现在统一调整到14px吧，我看13或者更小的有点看不清了。当然工具调用的输出结果维持小一点是没问题的。”**

该裁决包含两项具有极高指导意义的核心指示：
1. **主视觉信息与控制层（14px 铁律）**：当前聊天流中大量存在的 13px（历史定版）以及 12px/11px 的界面控制文案、折叠摘要、状态指示、动作意图与思考正文，因物理字号偏小导致用户长时间阅读时辨识困难、视觉疲劳，必须**无条件、彻底地上调并统一至 14px**。
2. **数据输出与代码层（小号豁免）**：用户明确界定了合理的豁免边界——工具调用展开后的执行结果（如终端输出 stdout/stderr、代码差异 diff 行、文件内容预览、结构化日志与微元数据等），由于其本身属于高密度、等宽（monospace）的数据产物，维持紧凑的小号（如 12px mono / 11px micro）是完全可接受且符合开发工具排版预期的。

### 2. 仓库排版历史沿革与演化闭环
回顾本仓库前端消息流排版的演进历程，可以清晰看到本次整改的历史定位：
- **2026-09-11（统一排版纪律初立）**：用户裁决“思考和终端的文字大小不一样，边距感觉也是不一样……左边看上去不够统一；工具调用容器里面的元素颜色文字粗细也不一样，花了字体还偏小”。当时确定了“思考行 / 工具行 / 折叠控制栏必须同构：24px 行高、14px 字号、字重 400、默认浅色”的基础规范。
- **2026-11-02（战役 D5 阶段 13px 降档定版试验）**：在工具呈现收敛过程中，为追求“折叠过程区相比正文更紧凑、层级更下沉”，将过程段（思考行、工具头、控制栏）字号统一降一档至 13px，并在 `processTypographyContract.test.ts` 和 `hc1.contract.test.ts` 中固化了 13px 的负向断言。
- **2026-11-04（本次用户最新裁决）**：经过实际场景的真实使用，用户明确反馈 13px 偏小费眼、“有点看不清了”，直接推翻了 D5 的 13px 降档定版试验。本次整改的目标即是**废除 D5 13px 口径，将消息流与过程区的控制文本、摘要文本、思考文本全面恢复并巩固至 14px**，同时精确划清输出结果小字号边界，形成架构自洽、阅读舒适的排版体系。

---

## 二、全站低于 14px 文本元素全面排查与分类清单

通过对 `apps/crish-desktop/src/components/chat-*` 以及全局 design tokens 的全面源码扫描，全站所有低于 14px 的文本元素被清晰划分为两大阵营：

### 阵营 A：必须统一上调至 14px 的界面元素（目标界面类）
此类元素均属于**界面导航、交互控制、单行摘要、意图说明、状态反馈及思考正文**，直接面向用户的阅读与操作识别，必须统一调整为 14px（对应 Design Token `--font-size-base` / `--font-size-body` / `14px`）。

| 序号 | 所在组件 / 模块文件 | CSS 类名 / 选择器 | 当前字号 | 目标字号 | 视觉语义与调整说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A-1** | `FoldableProcessSection.module.css:87` | `.summaryLabel` | `13px` | **`14px`** | 折叠控制栏聚合摘要（如“已完成 12.5 秒”、“已运行 3 条命令”），用户扫视首要焦点 |
| **A-2** | `FoldableProcessSection.module.css:104` | `.chevron` | `var(--font-size-sm, 13px)` | **`14px`** | 控制栏右侧折叠箭头指示器 |
| **A-3** | `ChatToolCallBlock.module.css:26` | `.toolStack` | `13px` | **`14px`** | 工具栈根字号基线 |
| **A-4** | `ChatToolCallBlock.module.css:113` | `.toolRowHead` | `13px` | **`14px`** | 单工具行头整体基线容器 |
| **A-5** | `ChatToolCallBlock.module.css:240` | `.toolRowSummary` | `13px` | **`14px`** | 工具行头主摘要文本包裹区 |
| **A-6** | `ChatToolCallBlock.module.css:249` | `.toolActionText` | `13px` | **`14px`** | 工具动作词（如“读取”、“编辑”、“写入”、“执行”） |
| **A-7** | `ChatToolCallBlock.module.css:261` | `.toolHumanText` | 继承 `13px` | **`14px`** | 工具自然语言意图描述（toolHumanLabel） |
| **A-8** | `ChatToolCallBlock.module.css:270` | `.dotSeparator` | `13px` | **`14px`** | 动作与参数之间的中圆点分隔符 |
| **A-9** | `ChatToolCallBlock.module.css:319` | `.toolParamText` | `13px` | **`14px`** | 工具参数文本（命令、路径、入参摘要等） |
| **A-10** | `ChatToolCallBlock.module.css:337` | `.toolErrorParamText` | `13px` | **`14px`** | 工具报错参数文本 |
| **A-11** | `ChatToolCallBlock.module.css:348` | `.toolSecondaryMetaInline` | `13px` | **`14px`** | 行头内联次要指标（如“32 行”、“1 处匹配”） |
| **A-12** | `ChatToolCallBlock.module.css:364` | `.diffStatsInline`, `.diffStatsBtn` | `13px` | **`14px`** | 行头内联 diff 统计（`+2 -1`） |
| **A-13** | `ChatToolCallBlock.module.css:420` | `.toolSecondaryMeta` | `13px` | **`14px`** | 行头右侧次要元数据 |
| **A-14** | `ChatToolCallBlock.module.css:489` | `.duration` | `13px` | **`14px`** | 单工具执行耗时文本（如“0.3 秒”） |
| **A-15** | `ChatToolCallBlock.module.css:907` | `.fileStatTitle` | `var(--font-size-sm, 13px)` | **`14px`** | 文件卡片顶部标题（文件名） |
| **A-16** | `FoldableToolGroup.module.css:44` | `.groupHeader` | `13px` | **`14px`** | 多工具折叠组头容器基线 |
| **A-17** | `FoldableToolGroup.module.css:79` | `.summaryLabel` | `13px` | **`14px`** | 组头聚合摘要（如“运行 3 个工具”） |
| **A-18** | `ReasoningRow.module.css:85` | `.reasoningRow` | `13px` | **`14px`** | 思考行单行按钮容器基线 |
| **A-19** | `ReasoningRow.module.css:145` | `.reasoningLabel` | `13px` | **`14px`** | 思考中状态文字徽标（“思考中”） |
| **A-20** | `ReasoningRow.module.css:158` | `.reasoningSummary` | `13px` | **`14px`** | 思考摘要行外框 |
| **A-21** | `ReasoningRow.module.css:168` | `.summaryText` | `13px` | **`14px`** | 思考单行流式跟踪文字（尾窗切片最新行） |
| **A-22** | `ReasoningRow.module.css:252` | `.durationBadge` | `13px` | **`14px`** | 思考完成状态与耗时（“已思考 3.2 秒”） |
| **A-23** | `ReasoningRow.module.css:309` | `.reasoningContent` | `13px` | **`14px`** | **展开态思考思维链全文内容**（用户深度阅读的核心正文） |
| **A-24** | `InFlowStatusLine.module.css:10` | `.statusLine` | `var(--font-size-sm, 12px)` | **`14px`** | 对话流内瞬态状态行（“正在准备工具调用...”等） |
| **A-25** | `MessageContent.module.css:61` | `.turnProcessControlBar .summaryLabel` | `var(--font-size-xs, 12px)` | **`14px`** | 轮次过程控制栏摘要 |
| **A-26** | `MessageContent.module.css:170` | `.interruptedMark` | `var(--font-size-xs, 12px)` | **`14px`** | 对话中断提示信息 |
| **A-27** | `MessageContent.module.css:180` | `.stoppedMark` | `var(--font-size-meta)` (12px) | **`14px`** | 用户主动停止生成提示 |
| **A-28** | `ChatMessageRow.module.css:614` | `.errorBanner` | `var(--font-size-sm, 13px)` | **`14px`** | 消息行错误横幅文本 |

---

### 阵营 B：维持小号（11px ~ 12px）的输出与代码元素（豁免输出类）
此类元素均属于**工具调用的展开输出结果、代码块、终端日志、结构化表格网格、代码 diff、行号及微辅助信息**。符合用户“当然工具调用的输出结果维持小一点是没问题的”的豁免授权，维持现有小号等宽或辅助小字阶。

| 序号 | 所在组件 / 模块文件 | CSS 类名 / 选择器 | 当前字号 | 维持字号与原因 |
| :--- | :--- | :--- | :--- | :--- |
| **B-1** | `ChatToolCallBlock.module.css:711` | `.toolSectionContent` | `var(--font-size-xs, 12px)` | 工具输出视口正文（代码/文本日志容器），等宽 12px 保证高密度 |
| **B-2** | `ChatToolCallBlock.module.css:813` | `.toolResultPreCmd` | `var(--font-size-xs, 12px)` | 终端命令具体入参代码（`<pre>`），等宽 12px |
| **B-3** | `ChatToolCallBlock.module.css:882` | `.toolValPre` | `var(--font-size-xs, 12px)` | KV 表格中长文本内容，等宽 12px |
| **B-4** | `ChatToolCallBlock.module.css:919` | `.fileStatMeta` | `var(--font-size-xs, 12px)` | 文件卡片次级属性元数据，12px 弱化辅助 |
| **B-5** | `ChatToolCallBlock.module.css:940` | `.fileStatItem` | `var(--font-size-xs, 12px)` | 文件属性网格单元项，12px 紧凑网格 |
| **B-6** | `ChatToolCallBlock.module.css:965` | `.grepMatchList`, `.grepMatchRow` | `var(--font-size-xs, 12px)` | grep 检索代码匹配行，等宽 12px 代码 |
| **B-7** | `ChatToolCallBlock.module.css:998` | `.dirList`, `.dirListItem` | `var(--font-size-xs, 12px)` | list_dir 目录列表输出，等宽 12px |
| **B-8** | `ChatToolCallBlock.module.css:1032` | `.toolOutputCode`, `.toolInputCode` | `var(--font-size-xs, 12px)` | 工具输入/输出大段代码块（read_file/edit_file 等），等宽 12px |
| **B-9** | `ChatToolCallBlock.module.css:1042` | `.emptyOutputBlock` | `var(--font-size-xs, 12px)` | 空输出提示，12px 弱提示 |
| **B-10** | `ChatToolCallBlock.module.css:1078` | `.toolResultPre` | `var(--font-size-xs)` (12px) | 工具标准 pre 代码输出，等宽 12px |
| **B-11** | `ToolCallDiffPreview.module.css:87` | `.diffFilename` | `var(--font-size-xs)` (12px) | Diff 卡片内部文件路径，等宽 12px |
| **B-12** | `ToolCallDiffPreview.module.css:209` | `.diffLineRow` | `var(--font-size-xs)` (12px) | Diff 卡片代码行（`+` 增 `/` `-` 删），等宽 12px |
| **B-13** | `ChatToolCallBlock.module.css:624` | `.toolSectionBadge`, `.toolSectionKind`, `.toolSectionMeta` | `var(--font-size-micro, 11px)` | 输出面板内的小徽标、类型标签与次级信息，11px micro |
| **B-14** | `ChatToolCallBlock.module.css:781` | `.terminalCwdBadge` | `var(--font-size-micro, 11px)` | 终端当前工作目录胶囊，11px micro |
| **B-15** | `ChatToolCallBlock.module.css:833` | `.toolMetaParam`, `.toolKeyValueRow`, `.toolKeyCell` | `var(--font-size-micro, 11px)` | KV 键名与微参数标签，11px micro |
| **B-16** | `ChatToolCallBlock.module.css:946` | `.fileStatLabel` | `var(--font-size-micro, 11px)` | 文件属性名标签（“大小”、“修改时间”），11px micro |
| **B-17** | `ChatToolCallBlock.module.css:981` | `.grepMatchLoc` | `var(--font-size-micro, 11px)` | grep 行号位置列（如 `L45:`），11px micro |
| **B-18** | `ChatToolCallBlock.module.css:1019` | `.codeMetaNotice` | `var(--font-size-micro, 11px)` | 剥除信封后的元信息提示，11px micro |
| **B-19** | `ChatToolCallBlock.module.css:1058` | `.outputTruncatedBar`, `.openInspectorBtn` | `var(--font-size-micro, 11px)` | 输出截断提示与外链检查按钮，11px micro |
| **B-20** | `ToolCallDiffPreview.module.css:107` | `.diffBadge`, `.diffPreviewTag` | `var(--font-size-micro, 11px)` | Diff 差异统计微徽标与标签，11px micro |
| **B-21** | `ToolCallDiffPreview.module.css:233` | `.diffGutterCol` | `var(--font-size-micro, 11px)` | Diff 行号列槽位，11px micro |
| **B-22** | `ToolCallDiffPreview.module.css:287` | `.diffMoreIndicator`, `.diffMoreBtn` | `var(--font-size-micro, 11px)` | Diff 折叠更多指示文案与按钮，11px micro |
| **B-23** | `ChatMessageRow.module.css:408` | `.time` | `var(--font-size-xs)` (12px) | 消息底部时间戳，12px 辅助时间 |
| **B-24** | `ChatMessageRow.module.css:417` | `.cacheMetricsInline` | `var(--font-size-xs)` (12px) | 缓存与 Token 指标浮层，12px 技术指标 |

---

## 三、行高（line-height）、高度契约与图标对齐物理相容性深度论证

在排版系统重构中，调整字号往往可能引发**容器高度溢出、基线不对齐、文字垂直偏心、虚拟列表高度抖动**等一系列连锁反应。以下针对核心疑问展开物理级严谨论证：

### 1. 单行高度 24px 契约与 14px 字号的物理相容性

在当前的排版架构中，思考行（`ReasoningRow`）、工具行头（`toolRowHead`）、多工具组头（`groupHeader`）严格锁定了以下盒模型尺寸：
```css
height: 24px;
min-height: 24px;
max-height: 24px;
line-height: 24px;
box-sizing: border-box;
contain: size layout;
```

#### (1) 字形度量（Font Metrics）与半行距（Half-Leading）推导
- 当 `font-size: 14px` 时，文字的 Em-Box 绝对高度为 14px。
- 在 `line-height: 24px` 的设定下，行距差额（Line Leading）为：
  $$\Delta H_{\text{leading}} = 24\text{px} - 14\text{px} = 10\text{px}$$
- CSS 内核将行距均分为上下两半（Half-Leading），即字形上方 5px，字形下方 5px：
  $$\text{Leading}_{\text{top}} = 5\text{px}, \quad \text{Leading}_{\text{bottom}} = 5\text{px}$$
- **字形墨水溢出检查**：
  在主流中西文字体（Segoe UI Variable Text, PingFang SC, HarmonyOS Sans SC, Cascadia Mono）中：
  - Cap-Height（大写字高）约为 $0.7 \times 14\text{px} \approx 9.8\text{px}$
  - Ascender 到 Descender（字形笔画最顶至最底）约为 $1.15 \times 14\text{px} \approx 16.1\text{px}$
  - 因为 $16.1\text{px} \le 24\text{px}$，且剩余上下安全缓冲空间达到 $(24 - 16.1) / 2 \approx 3.95\text{px}$，因此**文字绝对不会触碰 24px 盒子的上下边框，绝对不会发生任何垂直方向的像素级裁切或溢出**。

#### (2) 虚拟滚动管理器（VirtualScrollManager）零抖动断言
- 前端会话流虚拟滚动核心（`VirtualScrollManager`）针对未展开的过程行、思考行分配了固定的行高测量常量（`ROW_HEIGHT_COMPACT = 24px`）。
- 由于上述行统一维持 `height: 24px; line-height: 24px; contain: size layout;`，字号从 13px 上调至 14px 时，**外层盒模型的渲染树布局尺寸（Client Height）恒等于 24.000px，高度变化量 $\Delta H \equiv 0$**。
- **结论**：不会引发任何流式测高风暴，不会导致滚动条跳跃，完全符合现有虚拟滚动的物理契约。

---

### 2. 水平文本截断与省略号（text-overflow: ellipsis）表现

- **字宽增长比**：字号由 13px 增至 14px，单个字符的平均字宽增加比例为：
  $$\frac{14 - 13}{13} \approx 7.69\%$$
- **排版安全边界**：
  在 `.summaryLabel`、`.toolParamText`、`.summaryText` 中，均已配置如下硬约束：
  ```css
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  ```
- **推导结论**：字号增大仅会导致极长文本或超长路径在可用宽度不足时，稍微提前 1~2 个字符触发 `...` 省略截断；由于启用了 `white-space: nowrap`，绝不会发生意外换行导致行高突增，横向排版极为稳定。

---

### 3. 图标（12px / 14px）与 14px 文本的垂直对齐与居中机制

当前行头中的视觉元素包含三类：
1. **状态指示灯点**：`.statusDot`（4×4px）、`.toolPulseDot`（4×4px）、`.toolErrorDot`（6×6px）
2. **前置动作图标**：`.toolRowIcoSlot`（12×12px 图标槽，内嵌 12px AppIcon）、`.leadIcon`（FoldableToolGroup 内嵌 14px AppIcon，FoldableProcessSection 内嵌 12px AppIcon）
3. **右侧折叠指示器**：`.toolRowChevron`（12×12px 槽，`font-size: 14px`）、`.chevron`（12×12px 槽，`font-size: 14px`）

#### 垂直居中数学验证：
- 父容器（`.toolRowHead` / `.reasoningRow` / `.groupHeader`）均为：
  ```css
  display: flex;
  align-items: center;
  ```
- 在 Flexbox 交叉轴居中算法下，各子元素的几何中心与容器的 Y 轴中心线严格对齐（$Y_{\text{center}} = 12\text{px}$）：
  - 14px 文本的字心位于 $Y = 12\text{px}$（上下各留白 5px）。
  - 12px 图标的中心位于 $Y = 12\text{px}$（上下各留白 6px）。
  - 14px 图标的中心位于 $Y = 12\text{px}$（上下各留白 5px）。
  - 4px 状态圆点的中心位于 $Y = 12\text{px}$（上下各留白 10px）。
- **结论**：所有前缀图标、中圆点分隔符、折叠指示箭头与 14px 文本完全共享同一条几何水平中心线，无需任何 `margin-top: 1px`、`vertical-align` 或 `transform: translateY()` 补丁数字补偿，天然处于原生绝对居中状态。

---

### 4. FoldableProcessSection 33px 控制栏的垂直节奏

- 顶层分段折叠控制栏 `.controlBar` 维持 `height: 33px`。
- 其摘要文案 `.summaryLabel` 配置为 `line-height: 1.2`。
- 当字号调整为 14px 时：
  - 单行文本实际占用高度为 $14 \times 1.2 = 16.8\text{px}$。
  - 在 33px 的 flex 容器中，上下剩余空白为 $(33 - 16.8) / 2 = 8.1\text{px}$。
  - 相比原 13px 时的 8.7px 空白，8.1px 的留白让控制栏在 33px 高度下显得更饱满、通透，视觉重心稳重，文字清晰易读。

---

## 四、现有测试契约影响与变更清单（CI 防回归）

在当前仓库的自动化门禁中，有数个针对字号的严格契约测试。字号上调至 14px 必须同步更新这些断言，避免阻断 CI 流水线。

### 1. `apps/crish-desktop/src/components/chat-message/processTypographyContract.test.ts`
该测试是过程区排版防回潮的最核心防线。当前固化了 D5 13px 定版的正负向断言，需同步进行如下精确修订：

```diff
-  * 【D5 定版修订 · 2026-11-02 用户裁决】过程区字号由 14px 定版为 13px
-  * （试行后用户验收「还说得过去」转永久生效），覆盖上款 ②④ 的字号部分；
+  * 【统一 14px 修订 · 2026-11-04 用户裁决】过程区字号统一调整为 14px
+  * （推翻 D5 13px 试验，消除文字偏小看不清痛点，工具输出结果保持小号）；

-  it('行容器：24px 行高 / 13px 字号（D5 定版） / 默认浅色（--text-tertiary）', () => {
+  it('行容器：24px 行高 / 14px 字号（2026-11-04 用户裁决） / 默认浅色（--text-tertiary）', () => {
     const b = block(reasoningCss, '.reasoningRow');
     expect(b).not.toBe('');
     expect(b).toMatch(/height:\s*24px/);
     expect(b).toMatch(/line-height:\s*24px/);
-    expect(b).toMatch(/font-size:\s*13px/);
+    expect(b).toMatch(/font-size:\s*14px/);
     expect(b).toMatch(/color:\s*var\(--text-tertiary\)/);
     expect(b).toMatch(/padding:\s*0/);
   });

   it('语义标签「思考」：字重 400 + 颜色继承行状态机，严禁独立硬编码', () => {
     const b = block(reasoningCss, '.reasoningLabel');
     expect(b).not.toBe('');
-    expect(b).toMatch(/font-size:\s*13px/);
+    expect(b).toMatch(/font-size:\s*14px/);
     expect(b).toMatch(/font-weight:\s*var\(--font-weight-normal/);
     expect(b).toMatch(/color:\s*inherit/);
   });

-  it('行头：24px 行高 / 13px 字号（D5 定版） / 字重 400 / 默认浅色，与思考行完全一致', () => {
+  it('行头：24px 行高 / 14px 字号（2026-11-04 用户裁决） / 字重 400 / 默认浅色，与思考行完全一致', () => {
     const b = block(toolCss, '.toolRowHead');
     expect(b).not.toBe('');
     expect(b).toMatch(/height:\s*24px/);
     expect(b).toMatch(/line-height:\s*24px/);
-    expect(b).toMatch(/font-size:\s*13px/);
+    expect(b).toMatch(/font-size:\s*14px/);
     expect(b).toMatch(/font-weight:\s*var\(--font-weight-normal/);
     expect(b).toMatch(/color:\s*var\(--text-tertiary\)/);
     expect(b).toMatch(/padding:\s*0/);
   });

-  it('工具行内所有文本元素字号统一为 13px（D5 定版）', () => {
+  it('工具行内所有文本元素字号统一为 14px（2026-11-04 用户裁决）', () => {
     for (const sel of [
       '.toolRowSummary',
       '.toolActionText',
       '.dotSeparator',
       '.toolParamText',
       '.toolSecondaryMetaInline',
       '.toolSecondaryMeta',
     ]) {
       const b = block(toolCss, sel);
       expect(b, `${sel} 声明块必须存在`).not.toBe('');
-      expect(b, `${sel} 字号必须为 13px`).toMatch(/font-size:\s*13px/);
+      expect(b, `${sel} 字号必须为 14px`).toMatch(/font-size:\s*14px/);
     }
   });

-  it('负向断言：工具行内不得回潮小字号 token（12px / 11px / 10px）', () => {
+  it('负向断言：工具行内不得回潮小字号（13px / 12px / 11px / 10px）', () => {
     for (const sel of [
       '.toolRowSummary',
       '.toolActionText',
       '.dotSeparator',
       '.toolParamText',
       '.toolSecondaryMetaInline',
       '.toolSecondaryMeta',
     ]) {
       const b = block(toolCss, sel);
       expect(b, `${sel} 不得使用小字号`).not.toMatch(
         /font-size:\s*var\(--font-size-(xs|micro|xxs)/
       );
       expect(b, `${sel} 不得使用小字号字面量`).not.toMatch(
-        /font-size:\s*(9|10|11|12)px/
+        /font-size:\s*(9|10|11|12|13)px/
       );
     }
   });

-  it('控制栏默认浅色，文案 13px / 字重 400 / 继承色（D5 定版）', () => {
+  it('控制栏默认浅色，文案 14px / 字重 400 / 继承色（2026-11-04 用户裁决）', () => {
     const bar = block(foldCss, '.controlBar');
     expect(bar).toMatch(/color:\s*var\(--text-tertiary\)/);
     const label = block(foldCss, '.summaryLabel');
-    expect(label).toMatch(/font-size:\s*13px/);
+    expect(label).toMatch(/font-size:\s*14px/);
     expect(label).toMatch(/font-weight:\s*var\(--font-weight-normal/);
     expect(label).toMatch(/color:\s*inherit/);
   });
```

### 2. `apps/crish-desktop/src/components/chat-tool-call/__tests__/hc1.contract.test.ts`
该契约测试断言了工具行与组头文本族的字号：

```diff
- describe('HC1 · 13px 定版与 V2 gap（D5）', () => {
-   it('工具行文本族 13px', () => {
+ describe('HC1 · 14px 统一排版与 V2 gap（2026-11-04 用户裁决）', () => {
+   it('工具行文本族 14px', () => {
      const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
      for (const cls of [
        '.toolRowHead',
        '.toolRowSummary',
        '.toolActionText',
        '.toolParamText',
      ]) {
-       expect(standaloneBody(css, cls)).toContain('font-size: 13px');
+       expect(standaloneBody(css, cls)).toContain('font-size: 14px');
      }
    });

-   it('组头/段头/思考行 13px', () => {
+   it('组头/段头/思考行 14px', () => {
      const group = read(
        'components/chat-tool-call/FoldableToolGroup.module.css'
      );
-     expect(ruleBody(group, /\.groupHeader/)).toContain('font-size: 13px');
+     expect(ruleBody(group, /\.groupHeader/)).toContain('font-size: 14px');
      const section = read(
        'components/chat-message/FoldableProcessSection.module.css'
      );
-     expect(ruleBody(section, /\.summaryLabel/)).toContain('font-size: 13px');
+     expect(ruleBody(section, /\.summaryLabel/)).toContain('font-size: 14px');
      const reasoning = read(
        'components/chat-message-row/ReasoningRow.module.css'
      );
-     expect(ruleBody(reasoning, /\.reasoningRow/)).toContain('font-size: 13px');
-     expect(ruleBody(reasoning, /\.reasoningContent/)).toContain(
-       'font-size: 13px'
-     );
+     expect(ruleBody(reasoning, /\.reasoningRow/)).toContain('font-size: 14px');
+     expect(ruleBody(reasoning, /\.reasoningContent/)).toContain(
+       'font-size: 14px'
+     );
    });
```

### 3. `apps/crish-desktop/src/components/chat-message/FoldableProcessSection.test.tsx`
该组件测试断言了控制栏样式的字号契约：

```diff
-  it('控制栏文案与思考 / 工具行同构：13px、字重 400、继承色、严禁裸 Hex（D5 定版 · 2026-11-02）', () => {
+  it('控制栏文案与思考 / 工具行同构：14px、字重 400、继承色、严禁裸 Hex（2026-11-04 用户裁决）', () => {
     const block = css.match(/\.summaryLabel\s*\{[^}]*\}/)?.[0] ?? '';
     expect(block).not.toBe('');
-    expect(block).toMatch(/font-size:\s*13px/);
+    expect(block).toMatch(/font-size:\s*14px/);
     expect(block).not.toMatch(/font-size:\s*var\(--font-size-(xs|micro|xxs)/);
+    expect(block).not.toMatch(/font-size:\s*13px/);
     expect(block).toMatch(/font-weight:\s*var\(--font-weight-normal/);
     expect(block).not.toMatch(/font-weight:\s*(500|600|700)/);
     expect(block).toMatch(/color:\s*inherit/);
```

---

## 五、具体落地执行方案与 CSS 修改蓝图

为确保实施阶段零返工、精准到位，以下列出各目标核心文件的精确代码变更方案：

### 1. `apps/crish-desktop/src/components/chat-message/FoldableProcessSection.module.css`
- **`.summaryLabel`**（第 84-95 行）：
  ```diff
   .summaryLabel {
     flex: 1;
     min-width: 0;
  -  font-size: 13px;
  +  font-size: 14px;
     font-weight: var(--font-weight-normal, 400);
     line-height: 1.2;
  ```
- **`.chevron`**（第 104 行）：
  ```diff
   .chevron {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     width: 14px;
     height: 14px;
  -  font-size: var(--font-size-sm, 13px);
  +  font-size: 14px;
     line-height: 1;
  ```

### 2. `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`
- **`.toolStack`**（第 25 行）：
  ```diff
  -  font-size: 13px;
  +  font-size: 14px;
  ```
- **`.toolRowHead`**（第 113 行）：
  ```diff
     height: 24px;
     min-height: 24px;
     max-height: 24px;
     line-height: 24px;
     box-sizing: border-box;
  -  font-size: 13px;
  +  font-size: 14px;
     font-weight: var(--font-weight-normal, 400);
  ```
- **`.toolRowSummary`**（第 240 行）：
  ```diff
  -  font-size: 13px;
  +  font-size: 14px;
     line-height: 24px;
  ```
- **`.toolActionText`**（第 249 行）：
  ```diff
  -  font-size: 13px;
  +  font-size: 14px;
     font-weight: var(--font-weight-normal, 400);
  ```
- **`.dotSeparator`**（第 270 行）：
  ```diff
  -  font-size: 13px;
  +  font-size: 14px;
  ```
- **`.toolParamText`**（第 319 行）：
  ```diff
     font-family: var(--font-mono, monospace);
  -  font-size: 13px;
  +  font-size: 14px;
     color: var(--text-tertiary);
  ```
- **`.toolErrorParamText`**（第 337 行）：
  ```diff
     font-family: var(--font-mono, monospace);
  -  font-size: 13px;
  +  font-size: 14px;
     color: var(--color-error);
  ```
- **`.toolSecondaryMetaInline`**（第 348 行）：
  ```diff
  -  font-size: 13px;
  +  font-size: 14px;
     color: var(--text-tertiary);
  ```
- **`.diffStatsInline`, `.diffStatsBtn`**（第 364 行）：
  ```diff
     font-family: var(--font-mono, monospace);
  -  font-size: 13px;
  +  font-size: 14px;
  ```
- **`.toolSecondaryMeta`**（第 420 行）：
  ```diff
  -  font-size: 13px;
  +  font-size: 14px;
     color: var(--text-tertiary);
  ```
- **`.duration`**（第 489 行）：
  ```diff
     font-variant-numeric: tabular-nums;
  -  font-size: 13px;
  +  font-size: 14px;
     color: var(--text-tertiary);
  ```
- **`.fileStatTitle`**（第 907 行）：
  ```diff
  -  font-size: var(--font-size-sm, 13px);
  +  font-size: 14px;
     font-weight: var(--font-weight-medium, 500);
  ```

### 3. `apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.module.css`
- **`.groupHeader`**（第 44 行）：
  ```diff
     box-sizing: border-box;
     font-family: inherit;
  -  font-size: 13px;
  +  font-size: 14px;
     font-weight: var(--font-weight-normal, 400);
  ```
- **`.summaryLabel`**（第 79 行）：
  ```diff
     flex: 1;
     min-width: 0;
  -  font-size: 13px;
  +  font-size: 14px;
     line-height: 24px;
  ```

### 4. `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css`
- **`.reasoningRow`**（第 85 行）：
  ```diff
     font-family: inherit;
  -  font-size: 13px;
  +  font-size: 14px;
     line-height: 24px;
  ```
- **`.reasoningLabel`**（第 145 行）：
  ```diff
     font-weight: var(--font-weight-normal);
  -  font-size: 13px;
  +  font-size: 14px;
     color: inherit;
  ```
- **`.reasoningSummary`**（第 158 行）：
  ```diff
     color: inherit;
  -  font-size: 13px;
  +  font-size: 14px;
     line-height: 24px;
  ```
- **`.summaryText`**（第 168 行）：
  ```diff
     white-space: nowrap;
  -  font-size: 13px;
  +  font-size: 14px;
     color: inherit;
  ```
- **`.durationBadge`**（第 252 行）：
  ```diff
     color: inherit;
  -  font-size: 13px;
  +  font-size: 14px;
     line-height: 24px;
  ```
- **`.reasoningContent`**（第 309 行）：
  ```diff
     color: var(--text-tertiary);
  -  font-size: 13px;
  +  font-size: 14px;
     line-height: 1.65;
  ```

### 5. `apps/crish-desktop/src/components/chat-message-row/InFlowStatusLine.module.css`
- **`.statusLine`**（第 10 行）：
  ```diff
     gap: 6px;
     height: 24px;
     margin: var(--space-1, 4px) 0;
     color: var(--text-tertiary);
  -  font-size: var(--font-size-sm, 12px);
  +  font-size: 14px;
     line-height: 24px;
  ```

---

## 六、实施边界红线与自检门禁建议

在后续由实施 Agent 执行代码修改时，应遵守以下四项刚性红线：

1. **红线一：禁止误伤工具输出视口（严格维持小号 12px mono / 11px micro）**
   - 严禁将 `.toolSectionContent`、`.toolOutputCode`、`.diffLineRow`、`.grepMatchList` 等输出类元素改为 14px。
   - 必须保持代码与输出结果的紧凑度与专业度，严禁破坏用户明确授权的“工具调用的输出结果维持小一点没问题”。

2. **红线二：禁止改动 24px 行高与容器尺寸契约**
   - 严禁因为字号上调至 14px 而去随意调大 `height: 24px; line-height: 24px`。
   - 24px 是与 `VirtualScrollManager`、`ReasoningRow`、`FoldableToolGroup` 深度绑定的单一真理高度，由前述数学论证证明 14px 在 24px 内完全相容。

3. **红线三：测试契约原子化联动更新**
   - 修改 CSS 样式文件的同时，必须同一批次同步更新 `processTypographyContract.test.ts`、`hc1.contract.test.ts` 与 `FoldableProcessSection.test.tsx`。
   - 严禁出现“样式已改但测试仍按 13px 校验”导致的 CI 报错。

4. **红线四：严格立体验证（静态检查 + 单元测试）**
   - 实施后执行：
     ```bash
     npx vitest run apps/crish-desktop/src/components/chat-message/processTypographyContract.test.ts
     npx vitest run apps/crish-desktop/src/components/chat-tool-call/__tests__/hc1.contract.test.ts
     npx vitest run apps/crish-desktop/src/components/chat-message/FoldableProcessSection.test.tsx
     ```
   - 确保相关测试 100% 通过，无回归。

---

## 七、总结与调度建议

子 Agent A5 已完成对全站消息流与工具调用区域字号现状的穷举式排查与论证：
- **方案可行性**：100% 可行。14px 字号在 24px 单行高度下具有完美物理相容性，且与图标在 Flexbox 交叉轴天然绝对居中，无任何溢出或布局抖动风险。
- **边界清晰度**：明确分离“界面控制/摘要/意图/状态/思考（14px）”与“工具输出/代码/日志/网格（12px/11px）”两大阵营。
- **改动范围可控**：涉及 5 个核心 CSS 模块、3 个测试契约文件，代码逻辑清晰，风险收敛。

本调研报告已正式落盘，请主控 Agent 审阅并纳入后续实现波次调度。
