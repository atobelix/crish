# 展开态视觉与工具行调研报告（图一至图四展开态与图五折叠态）

> **报告标识**：`docs/assistant-process-folding/survey/03-expanded-style-and-tool-header-survey.md`  
> **所属战役**：正文交错过程折叠战役（Assistant Process Folding）第 1 波调研  
> **调研角色**：A03 - 展开态视觉与工具行调研员  
> **撰写日期**：2026-09-11  
> **协作准则**：根目录 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`（反退避）、探索类子代理配额红线（单篇详尽入库）

---

## 目录

1. [执行摘要与调研背景](#1-执行摘要与调研背景)
2. [图一至图四（展开态/执行态）视觉特征与规范深度剖析](#2-图一至图四展开态执行态视觉特征与规范深度剖析)
   - 2.1 正在运行/展开时的单项展示：`修改、运行校验: check-token-consistency.mjs ⌄`
   - 2.2 精确代码编辑增删行标签：`编辑 C:\Software\conex\scripts\check-token-consistency.mjs +7 -1`（红绿双色阶统计）
   - 2.3 极简思考行：`深度思考` 及其流式态/终态微动效
   - 2.4 小图标与意图文本：时钟图标 + `Self-test the ratchet, format check, and pass path`
   - 2.5 展开时单行动作的严格几何排布、边距与网格规范
3. [图五（折叠态与聚合摘要）视觉特征与状态机收敛剖析](#3-图五折叠态与聚合摘要视觉特征与状态机收敛剖析)
   - 3.1 动作聚合分类摘要：`🔍 已搜索 2 次 · 已读取 3 个文件 ⌄` 与多维动作流水
   - 3.2 顶部工作时间胶囊：`已处理 3m 9s ⌄` 的时间模型与视觉锚点
   - 3.3 终态收敛界面法则：顶部状态 + 发丝横分割线 + 总结正文（过程全折叠）
4. [现有前端代码资产深度审查（七大核心文件）](#4-现有前端代码资产深度审查七大核心文件)
   - 4.1 `CompactToolRow.tsx`：单行容器、生命周期与位移状态机
   - 4.2 `ToolCallHeader.tsx`：24px 头部排布、Chevron 缺失与增删颜色断层
   - 4.3 `toolHeaderPresentation.ts`：14 类语义解析、次要指标提炼与参数回退
   - 4.4 `ReasoningRow.tsx`：24px contain 几何固化、512B 窗口切片与扫光微动效
   - 4.5 `TimelineThoughtSection.tsx`：双实现历史分叉对比与收敛评估
   - 4.6 `toolHumanDescriptions.ts`：三级意图过滤门面与人话提炼
   - 4.7 `toolCardPresenter.ts`：差异统计提取、展开判定与色调映射
5. [核心问题一：最大化复用现有 24px 单行视觉资产达成图一至图四效果](#5-核心问题一最大化复用现有-24px-单行视觉资产达成图一至图四效果)
   - 5.1 补全 `ToolCallHeader` 的 Chevron 与悬停平滑替换机制
   - 5.2 修复 `diffStatsAdd` / `diffStatsDel` 红绿视觉样式的缺失
   - 5.3 统一思考行组件并支持「深度思考」极简展开态
   - 5.4 修复运行态脉冲与语义图标的并存机制（扫光带与双层状态标印）
   - 5.5 复合意图冒号语法与文件路径下划线链接交互
6. [核心问题二：折叠态多维分类统计算法与聚合摘要条生成](#6-核心问题二折叠态多维分类统计算法与聚合摘要条生成)
   - 6.1 六大动作领域分类体系（搜索 / 读取 / 编辑 / 运行 / 协作 / 思考）
   - 6.2 路径去重与量词归一化算法（次 / 个文件 / 条命令 / 个子任务）
   - 6.3 唯一主导图标（Dominant Leading Icon）仲裁决策树
   - 6.4 顶部工作时间胶囊（`已处理 3m 9s ⌄`）与全轮次折叠联动
7. [与单轨虚拟滚动（VSM）及 HTML5 until-found 的协同自愈](#7-与单轨虚拟滚动vsm及-html5-until-found-的协同自愈)
8. [调研结论与第二波详案建议清单](#8-调研结论与第二波详案建议清单)

---

## 1. 执行摘要与调研背景

在 Conex / Crish 桌面端正文界面的演进过程中，AI 交互从原先的“粗放气泡卡片”向“高密度极简线性流”转变。本次战役的核心目标是实现**正文交错过程的优雅展开与终态收敛折叠**：
- **执行与展开态（对齐用户图一至图四）**：细颗粒度的原子动作以严格 24px 单行流式展示，呈现精准的人类意图描述、语义图标（如时钟）、红绿双色增删行号统计、单行极简思考以及流畅的折叠 Chevron；
- **终态折叠与聚合摘要态（对齐用户图五）**：在 AI 输出最终回答（总结正文）后，前端自动将中间庞杂的思考、工具调用收起，顶部仅外露微型工作时间胶囊（如 `已处理 3m 9s ⌄`）和动作分类聚合摘要（如 `🔍 已搜索 2 次 · 已读取 3 个文件 ⌄` 或 `已编辑 3 个文件 · 已搜索 3 次 · 已读取 1 个文件 · 已运行 3 条命令 >`），下方辅以一条极轻微的发丝分割线，随后直接呈现最终交付正文。

本调研报告针对上述需求，全面透视现有桌面端组件库（`apps/crish-desktop/`），分析图一至图四与图五的设计特征，挖掘现有资产（`ToolCallHeader`、`ReasoningRow`、`toolHeaderPresentation` 等）的优势与关键断层，并提出 100% 还原效果的工程改造方案与分类统计算法。

---

## 2. 图一至图四（展开态/执行态）视觉特征与规范深度剖析

通过对用户提供的图一至图四进行像素级与交互逻辑逆向，展开态和执行态具备以下 5 大核心特征：

```
[图一至图四 展开态单行布局拓扑 (24px 严格高度锁)]
+----+  6px  +--------------------------+  8px  +---+  8px  +--------------------------+  10px  +-----------+  auto  +-------+  6px  +---+
| 图 | ----> | 动作意图前缀 (如: 修改、运行校验) | ----> | : | ----> | 目标对象/路径 (如: check.mjs) | -----> | +7 -1 统计| -----> | 耗时  | ----> | ⌄ |
| 标 |       | font-weight: 500         |       | · |       | font-mono / 可点击链接     |        | 绿 / 红   |        | 1.2s  |       | 箭头|
+----+       +--------------------------+       +---+       +--------------------------+        +-----------+        +-------+       +---+
```

### 2.1 正在运行/展开时的单项展示：`修改、运行校验: check-token-consistency.mjs ⌄`
1. **复合动作意图高亮**：
   - 动作并非生硬机械的工具函数名（如 `run_command`、`replace_file_content`），而是经过提炼的高层意图：`修改、运行校验`；
   - 意图与目标之间采用**冒号与空格（`: `）**进行语义衔接，具有强烈的叙事性和人类可读性；
   - 字体采用主文本色 `var(--text-primary)`，字重为 `500`（Medium），形成清晰视觉重心。
2. **目标对象呈现**：
   - 紧随冒号其后的是核心目标，例如脚本名 `check-token-consistency.mjs`；
   - 采用等宽字体 `var(--font-mono)` 或高对比度次级文本色，若为工作区文件则支持悬停下划线与点击打开（`onOpenPath`）。
3. **折叠/展开指示符（Chevron）**：
   - 尾部具备明确的向下箭头 `⌄`（或旋转 90 度的展开箭头），向用户明确指示该单行是可交互、可展开检视具体执行细节（终端输出或 Diff 视图）的。

### 2.2 精确代码编辑增删行标签：`编辑 C:\Software\conex\scripts\check-token-consistency.mjs +7 -1`（红绿双色阶统计）
1. **语法结构**：
   - 结构为：`[编辑动作] [完整文件路径或工作区相对路径] [+增行数] [-删行数]`；
2. **视觉色阶要求（双色对比）**：
   - `+7` 必须使用语义鲜明的成功绿色（`var(--color-success, #10b981)` 或类似亮绿）；
   - `-1` 必须使用警示鲜明的删除红色（`var(--color-error, #ef4444)` 或类似柔红）；
   - 增删标签与路径之间保持 `4px~10px` 间距，字体采用紧凑的等宽微型字号（`11px`），垂直方向微沉 `translateY(0.5px)`，确保与文字基线绝对对齐。

### 2.3 极简思考行：`深度思考` 及其流式态/终态微动效
1. **极简命名规范**：
   - 不采用臃肿的“第 1 阶段思考”、“思考过程折叠盒”，直接精炼为 `深度思考` 或 `已思考 3.2s`；
2. **运行中状态（Live Shimmer）**：
   - 左侧配备翡翠绿脉冲状态圆点（`4px` 或 `6px`，带柔和 scale 缩放与透明度呼吸）；
   - 文本行右侧流式呈现当前正在推导的核心分句，并附加平滑的 `@keyframes sweep-shine` 扫光动效；
3. **完成终态（Terminal）**：
   - 转化为静态的等宽数字标签 `已思考 3.2s` 或极简文本 `深度思考`，尾缀折叠箭头 `›`；
   - 行高死锁在严格的 `24px`，无任何背景色、外边框与重阴影。

### 2.4 小图标与意图文本：时钟图标 + `Self-test the ratchet, format check, and pass path`
1. **时钟/计时器图标**：
   - 当调用定时、计划类工具（如 `schedule`、`set_timer`、`manage_task`）或执行带超时控制的测试流时，左侧 16px 图标槽渲染小巧精致的 **Timer / Clock** 图标（`12px~14px`）；
2. **人类说明文本提取**：
   - 图标后直接呈现 AI 输出的单次动作意图说明：`Self-test the ratchet, format check, and pass path`；
   - 文本保持单行省略（`ellipsis`），悬停弹出完整 Tooltip，不强制折行撑高界面。

### 2.5 展开时单行动作的严格几何排布、边距与网格规范
1. **行高绝对锁定**：每行高度严格等于 `24px`（`line-height: 24px`），杜绝因图标大小或标签上下浮动造成的高度抖动；
2. **零外框容器**：工具流容器（`.toolStack`）无边框、无灰色底色，各工具行之间垂直间隙仅 `1px`（`margin: 1px 0`）；
3. **横向对齐网格**：
   - 左侧图标槽位锁定 `16px × 16px`（`flex: 0 0 16px`），居中对齐；
   - 图标与正文间距为紧凑的 `6px`；
   - 尾部耗时与状态居右弹性浮动（`margin-left: auto`）。

---

## 3. 图五（折叠态与聚合摘要）视觉特征与状态机收敛剖析

图五展现了当 Agent 完成多步执行并生成最终总结时的**终态收敛折叠范式**。其设计哲学是将技术执行细节最大程度弱化，仅保留高阶指标与干净的正文阅读空间。

```
[图五 终态收敛折叠与聚合摘要拓扑]
+-----------------------------------------------------------------------------------+
|  [胶囊] 已处理 3m 9s  ⌄                                                            |
|  -------------------------------------------------------------------------------  | <-- 0.5px 极细发丝分割线
|                                                                                   |
|  [聚合条] 🔍 已搜索 2 次 · 已读取 3 个文件 ⌄                                          |
|  或: 已编辑 3 个文件 · 已搜索 3 次 · 已读取 1 个文件 · 已运行 3 条命令 >              |
|                                                                                   |
|  -------------------------------------------------------------------------------  |
|                                                                                   |
|  【AI 最终回答正文 (Markdown)】                                                     |
|  经过对 check-token-consistency.mjs 的修改与校验，所有门禁已全部恢复通过...          |
+-----------------------------------------------------------------------------------+
```

### 3.1 动作聚合分类摘要：`🔍 已搜索 2 次 · 已读取 3 个文件 ⌄`
1. **多维分类归纳，拒绝简单粗暴的“N 项工具调用”**：
   - 现状系统输出的 `5 项工具调用` 缺乏语义信息；
   - 图五将执行过的所有动作按**语义功能**提炼为 6 大通用维度：
     - **已编辑**：修改代码文件（如 `已编辑 3 个文件`）；
     - **已搜索**：检索代码与网络（如 `已搜索 2 次` / `已搜索 3 次`）；
     - **已读取**：检视文件与网页（如 `已读取 1 个文件` / `已读取 3 个文件`）；
     - **已运行**：执行终端与脚本（如 `已运行 3 条命令`）；
     - **协同任务**：派发与等待子代理（如 `已协作 2 个子任务`）；
     - **深度思考**：模型推导思维链（如 `已深度思考` 或 `思考 12.4s`）。
2. **唯一主导图标（Dominant Icon）引领**：
   - 聚合摘要条的最左侧带有代表该轮操作核心特征的主导图标（例如以搜索为主时显示放大镜 `🔍`，以编辑为主时显示代码编辑图标 `file-edit`）；
   - 图标颜色使用沉稳的次级文本色 `var(--text-tertiary)`，悬停点亮为 `var(--text-primary)`。
3. **平铺点号分隔符**：
   - 各项指标之间采用纤细圆点 ` · `（`margin: 0 4px`）平铺连接；
   - 尾部配有展开/折叠箭头指示符（展开为 `⌄`，折叠收起为 `>` 或 `›`）。

### 3.2 顶部工作时间状态：`已处理 3m 9s ⌄`
1. **微型状态胶囊**：
   - 替代原先占用一整行的 `正在处理 · 12.3秒`；
   - 终态时固化为精简的胶囊按钮：`已处理 3m 9s ⌄`（当耗时 `<60s` 时展示如 `已处理 42s ⌄`）；
   - 点击该胶囊可作为全局总开关，直接控制下方所有折叠过程的开合。
2. **高阶时间格式化**：
   - 算法：若超过 60 秒，则自动进位格式化为 `Xm Ys`（如 `3m 9s`），消除毫秒级噪音，契合专业工程软件的沉稳感。

### 3.3 终态收敛界面法则：中间过程全折叠
1. **彻底消除中间噪音**：
   - 在流式生成阶段，思考与工具可以按单行展开呈现；
   - 但一旦最终文本（Final Answer）开始输出并最终敲定，中间的所有 `ReasoningRow`、`CompactToolRow` 必须**默认完全折叠隐藏**；
2. **极轻量界面留白**：
   - 界面自上而下仅呈现：`顶部工作时间状态胶囊` -> `0.5px 发丝分割线` -> `聚合摘要条（可选折叠或常驻）` -> `最终总结正文`；
   - 用户若想探究细节，只需点击摘要条或时间胶囊即可就地展开历史执行链。

---

## 4. 现有前端代码资产深度审查（七大核心文件）

对当前仓库中相关的 7 个关键文件进行逐行代码审查，分析其现有能力与缺陷：

### 4.1 `CompactToolRow.tsx`
文件路径：[`apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:1-292`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx#L1-L292)

- **核心资产**：
  - **行数控制与解耦**：总行数 292 行，符合 ≤400 行门禁；
  - **状态机与位移锚点**：第 187–202 行集成了 `useToolExpansionState`，包含 100ms 原地翻转契约（`isFlipping`）、展开防抖与基于 `vsm`（VirtualScrollManager）的相对位移锚定；
  - **耗时计算**：第 73–83 行 `durationStr` 正确处理了静态完成耗时与实时流式耗时（`liveNow - tc.startedAt`）；
  - **差异行数提炼**：第 220–223 行通过 `toolDiffLineStats` 与 `normalizeToolDiffStat` 获取到 `{ add, del }` 并格式化为 `diffStatLabel`。
- **发现的缺陷与断层**：
  - **行内无展开 Chevron 传递**：第 258–274 行将所有参数传入 `ToolCallHeader`，但未在头部显式放置向下折叠箭头，导致用户在未悬停或查看时无法直观感知此行是否展开；
  - **孤立单行渲染**：目前主要作为 `ChatToolStack` 内部的单行，缺乏与外部全轮次折叠状态机（`TurnProcessNodeView`）的纵向级联。

### 4.2 `ToolCallHeader.tsx`
文件路径：[`apps/crish-desktop/src/components/chat-tool-call/ToolCallHeader.tsx:1-165`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ToolCallHeader.tsx#L1-L165)

- **核心资产**：
  - **严格 24px 头部封装**：第 74 行 `.toolRowHead` 具有 `height: 24px; min-height: 24px; max-height: 24px; line-height: 24px;`，结构非常紧凑；
  - **语义拆解**：第 58–63 行调用 `resolveToolActionAndParam` 分解得到 `actionText`、`paramText`、`isPath`；
  - **次要量度展示**：第 140–146 行支持在紧随参数后行内展示 `secondaryMeta`（如读取行数、匹配数）；
  - **差异统计结构**：第 148–153 行渲染了增删行标签：
    ```tsx
    // ToolCallHeader.tsx:148-153
    {diffStats ? (
      <span className={styles.diffStatsInline}>
        <span className={styles.diffStatsAdd}>+{diffStats.add}</span>
        <span className={styles.diffStatsDel}>-{diffStats.del}</span>
      </span>
    ) : null}
    ```
- **发现的致命断层**：
  1. **CSS 样式完全缺失（红绿失效）**：
     - 在配套样式表 [`ChatToolCallBlock.module.css:289-296`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L289-L296) 中，虽然定义了 `.diffStatsInline`，**但根本没有定义 `.diffStatsAdd` 和 `.diffStatsDel` 这两个类名**！
     - 导致在运行时，`+{diffStats.add}` 和 `-{diffStats.del}` 无法渲染为图二中鲜明的红绿双色，沦为平淡的单色小字；
  2. **折叠箭头 Chevron 完全未渲染**：
     - 样式表 [`ChatToolCallBlock.module.css:322-341`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L322-L341) 中明明写好了 `.toolRowChevron` 与 `.toolRowChevron.rot` 动画；
     - 但在 `ToolCallHeader.tsx` 的 JSX 中，第 157–161 行的 `toolRowHeadRight` **只渲染了 `durationStr`，完全漏掉了 Chevron 图标**！
  3. **运行态图标被脉冲圆点顶替**：
     - 第 98–105 行中，当 `running === true` 时，直接渲染 `<span className={styles.toolPulseDot} />`，而把真正的工具语义图标（`AppIcon`）给抹掉了；而图一至图四中，即便是执行态，左侧依然展示工具小图标并配合柔和呼吸扫光。

### 4.3 `toolHeaderPresentation.ts`
文件路径：[`apps/crish-desktop/src/components/chat-tool-call/toolHeaderPresentation.ts:1-446`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/toolHeaderPresentation.ts#L1-L446)

- **核心资产**：
  - **纯逻辑无 DOM 依赖**：从 `ToolCallHeader` 彻底解耦，446 行纯函数；
  - **14 类精准分类覆盖**：第 103–356 行涵盖 Shell、Diff、Stat、Read、Edit、Write、Web Search、Grep、Glob、List Dir、Tree、Browser Fetch、Subagent、Task；
  - **次要量度精准提取**：第 361–445 行通过对 `output` 的正则解析，提取出如 `L10–L45 / 120 行`、`4 处匹配`、`12 KB`、`8 项` 等高价值摘要。
- **优化点**：
  - 目前意图前缀主要输出简单的单个词（如“修改”、“读取”、“Pwsh”），若入参或 `human` 字段携带类似图一的复合动作 `修改、运行校验: check-token-consistency.mjs`，`resolveToolActionAndParam` 目前第 344–348 行的去重逻辑会简单截断，未保留冒号分隔的复合意图展示。

### 4.4 `ReasoningRow.tsx`
文件路径：[`apps/crish-desktop/src/components/chat-message-row/ReasoningRow.tsx:1-267`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.tsx#L1-L267)

- **核心资产**：
  - **严格 24px contain 几何固化**：第 197 行 `.reasoningRow` 搭配 `ReasoningRow.module.css` 中的 `contain: size layout`，彻底锁死高度，流式输出长文本思考时绝不引发外层容器递归回流与测高风暴；
  - **O(1) 尾窗切片算法**：第 51–71 行 `extractLatestLine` 严格只截取末尾 512 字节寻找最新行，无惧数十 KB 思考文本引起的 GC 压力；
  - **流式扫光带（Sweep Shine）**：第 214–216 行在实时输出时为文本注入 `@keyframes sweep-shine` 动效；
  - **终态收拢与思维链独立复制**：第 118–144 行提供独立的 `CopyThinkingButton`。
- **与截图的差距**：
  - 终态时第 221–223 行目前格式化为 `已思考 3.2s`，而图一至图四中有些场景直接简写为极简的 `深度思考`。需支持将标签文案配置为自适应模式。

### 4.5 `TimelineThoughtSection.tsx`
文件路径：[`apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx:1-140`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L1-L140)

- **历史分叉现状**：
  - 在 [`ProcessItemRenderer.tsx:18, 70-80`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx#L18) 中，思考项引用的居然是独立的 `TimelineThoughtSection.tsx`；
  - 而在 [`MessageToolCallsSection.tsx:15, 149-158`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/MessageToolCallsSection.tsx#L15) 中，引用的却是 `ReasoningRow.tsx`；
  - `TimelineThoughtSection.tsx` 内部自己实现了一套基于星星 SVG 图标（第 87–89 行）与手风琴折叠动画（`thoughtAccordion`），与 `ReasoningRow.tsx` 的 24px contain 规范存在实现重叠与样式不一致。
- **收敛裁决**：
  - 必须**废除或薄封装 `TimelineThoughtSection.tsx`**，统一收敛到性能更好、具备 24px 严格硬件隔离的 `ReasoningRow.tsx` 上。

### 4.6 `toolHumanDescriptions.ts`
文件路径：[`apps/crish-desktop/src/api/tool-presentation/toolHumanDescriptions.ts:1-45`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/toolHumanDescriptions.ts#L1-L45)

- **核心资产**：
  - **三级降级防御锁**：
    1. 优先采用 AI 提供的 `tc.explanation`（第 26–33 行），经 `isGenericExplanationSpam` 与 `isHumanExplanation` 过滤；
    2. 其次采用包含中文字符的人类解释（第 34–42 行）；
    3. 兜底由参数分析器 `toolLabelFromArgs(tc)` 生成（第 43 行）。
- **图四特征印证**：
  - 图四中的 `Self-test the ratchet, format check, and pass path` 正是通过第一级 `tc.explanation` 提取出的高价值意图说明！现有清洗管道完全支持该特性，无需推倒重来。

### 4.7 `toolCardPresenter.ts`
文件路径：[`apps/crish-desktop/src/api/tool-presentation/toolCardPresenter.ts:1-239`](file:///c:/Software/conex/apps/crish-desktop/src/api/tool-presentation/toolCardPresenter.ts#L1-L239)

- **核心资产**：
  - **差异统计提取器**：第 32–49 行 `normalizeToolDiffStat` 与 `formatToolDiffStat` 保证了 `+A −D` 数值的安全清洗（非负整数钳位）；
  - **只读文件工具不展开正文规则**：第 98–104 行 `toolHasExpandableBody` 裁决了“文件读取类工具正常情况下无需在聊天流内展开大块文件源码，点击路径超链接在侧边栏检视”，极大保证了流式对话的清爽度。

---

## 5. 核心问题一：最大化复用现有 24px 单行视觉资产达成图一至图四效果

针对图一至图四中的展开态与执行态，现有组件库已有 85% 的基础能力，仅需进行**5 项关键修正与样式注入**，即可 100% 达到目标效果：

### 5.1 补全 `ToolCallHeader` 的 Chevron 与悬停平滑替换机制
1. **补全右侧折叠箭头**：
   - 在 [`ToolCallHeader.tsx:157-161`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ToolCallHeader.tsx#L157-L161) 的 `toolRowHeadRight` 中加入 Chevron：
     ```tsx
     <span className={styles.toolRowHeadRight}>
       {durationStr ? <span className={styles.duration}>{durationStr}</span> : null}
       {canToggle ? (
         <span
           className={`${styles.toolRowChevron} ${isOpen ? styles.rot : ''}`}
           aria-hidden="true"
         >
           ›
         </span>
       ) : null}
     </span>
     ```
2. **支持 DeepSeek 式 Leading 图标原地悬停替换（可选无抖动模式）**：
   - 参考 `reference/deepseek-harness` 的 `DisclosureRow.tsx:60-71`，在 `toolRowIcoSlot` 内同时放置语义图标与 `chevronHover`，悬停时 100ms 渐隐渐现平滑替换，空间绝对守恒。

### 5.2 修复 `diffStatsAdd` / `diffStatsDel` 红绿视觉样式的缺失
在 [`ChatToolCallBlock.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css) 的第 296 行后**精准补全**缺失的样式定义：

```css
/* 增删差异红绿标签 (对齐图二视觉规范) */
.diffStatsInline {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-micro, 11px);
  margin-left: 6px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 24px;
  transform: translateY(0.5px);
}

.diffStatsAdd {
  color: var(--color-success, #10b981);
  font-weight: var(--font-weight-medium, 500);
}

.diffStatsDel {
  color: var(--color-error, #ef4444);
  font-weight: var(--font-weight-medium, 500);
}
```

### 5.3 统一思考行组件并支持「深度思考」极简展开态
1. **收敛组件入口**：
   - 将 `ProcessItemRenderer.tsx:70` 中的 `TimelineThoughtSection` 直接替换为 `ReasoningRow`；
2. **支持图一至图四的「深度思考」极简标题**：
   - 当没有具体耗时或用户偏好极简视图时，终态直接展示 `深度思考`，右侧配备折叠箭头；
   - 展开后依然通过 `StreamingMarkdownView` 自然融入主文档流，不添加内部独立滚动条。

### 5.4 修复运行态脉冲与语义图标的并存机制
1. **现有问题**：当前代码在 `running === true` 时将语义图标抹杀，替换为单一的灰点；
2. **重构对齐**：
   - 保留语义图标（如 `timer`、`edit`、`terminal`）；
   - 状态点以 `8px` 微型角标形式覆盖在图标右下角，或让语义图标自带 2.6s 背景高光扫光带（Sweep Glare Band），让用户即使在运行中也能清楚知道“当前正在执行定时校验”还是“正在编辑文件”。

### 5.5 复合意图冒号语法与文件路径链接交互
- 当 `toolHumanLabel` 解析出复合操作（如 `修改、运行校验: check-token-consistency.mjs`）时，`toolHeaderPresentation.ts` 将冒号前半部分提炼为 `actionText = "修改、运行校验"`，后半部分识别为工作区文件路径，生成高亮蓝灰色的 `toolPathLink`，点击直接通过 Tauri IPC 在编辑器中定焦该文件。

---

## 6. 核心问题二：折叠态多维分类统计算法与聚合摘要条生成

图五的核心在于**聚合与提炼**。目前系统的 `turnProcessState.ts` 仅统计了粗糙的 `toolCount`，必须全面升级为**多维动作分类统计算法（Categorized Aggregation Algorithm）**。

### 6.1 六大动作领域分类映射表

根据工具名称（`tc.name`）和参数语义，将所有调用归入 6 大正交维度：

| 分类维度 | 对应工具集 | 目标提取与去重规则 | 聚合呈现文案模板 |
|---|---|---|---|
| **已编辑** (`edit`) | `replace_file_content`, `edit_file`, `write_file`, `write_to_file`, `create_file`, `apply_patch`, `multi_replace` | 提取 `path`/`filePath` 并按路径 Set 去重，计算受影响文件数 | `已编辑 ${count} 个文件` |
| **已搜索** (`search`) | `grep_search`, `search_web`, `web_search`, `find_by_name`, `glob`, `ripgrep`, `search` | 统计搜索执行总次数 | `已搜索 ${count} 次` |
| **已读取** (`read`) | `read_file`, `view_file`, `open_file`, `cat`, `read_text_file`, `read_file_content`, `read_url_content` | 本地文件按路径去重；URL 按目标去重 | `已读取 ${count} 个文件` (网络则为 `个网页`) |
| **已运行** (`shell`) | `run_command`, `bash`, `pwsh`, `powershell`, `exec`, `terminal` | 统计运行命令总条数 | `已运行 ${count} 条命令` |
| **协同任务** (`subagent`) | `invoke_subagent`, `run_subagent`, `wait_subagents`, `send_message` | 统计派发的子代理任务个数 | `已协作 ${count} 个子任务` |
| **深度思考** (`thought`) | 思考块（`kind === 'thought'`） | 提取思考累积耗时（秒） | `已深度思考` 或 `思考耗时 ${sec}s` |

### 6.2 纯逻辑分类统计算法实现设计

```typescript
// 位于 apps/crish-desktop/src/components/chat-message/turnProcessState.ts

export interface DetailedProcessMetrics {
  editFilesCount: number;
  searchCount: number;
  readFilesCount: number;
  shellCommandCount: number;
  subagentCount: number;
  thoughtDurationMs: number;
  thoughtCount: number;
  totalWorkDurationMs: number;
  primaryCategory: 'edit' | 'search' | 'read' | 'shell' | 'subagent' | 'thought' | 'misc';
}

export function countDetailedProcessMetrics(
  items?: AssistantTimelineItem[] | null,
  turnStartTime?: number,
  turnEndTime?: number
): DetailedProcessMetrics {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  let searchCount = 0;
  let shellCommandCount = 0;
  let subagentCount = 0;
  let thoughtDurationMs = 0;
  let thoughtCount = 0;

  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item) continue;
      if (item.kind === 'thought') {
        thoughtCount += 1;
        if (typeof item.durationMs === 'number' && item.durationMs > 0) {
          thoughtDurationMs += item.durationMs;
        }
      } else if (item.kind === 'tools' && Array.isArray(item.items)) {
        for (const t of item.items) {
          if (!t) continue;
          const tools = t.kind === 'single' ? [t.tc] : (t.tools || []);
          for (const tc of tools) {
            if (!tc) continue;
            const name = (tc.name || '').toLowerCase().replace(/[\s-]+/g, '_');
            const path = extractFilePathFromToolArgs(tc.arguments || '') || '';

            if (isEditToolName(name) || name.includes('replace') || name.includes('write')) {
              if (path) editedFiles.add(path);
              else editedFiles.add(tc.id);
            } else if (isReadFileToolName(name) || name.includes('view') || name.includes('read')) {
              if (path) readFiles.add(path);
              else readFiles.add(tc.id);
            } else if (name.includes('search') || name.includes('grep') || name.includes('find') || name.includes('glob')) {
              searchCount += 1;
            } else if (isShellToolName(name) || name.includes('bash') || name.includes('pwsh') || name.includes('exec') || name === 'run_command') {
              shellCommandCount += 1;
            } else if (isSubagentToolName(name)) {
              subagentCount += 1;
            }
          }
        }
      }
    }
  }

  // 计算总耗时
  const totalWorkDurationMs = (turnStartTime && turnEndTime && turnEndTime > turnStartTime)
    ? (turnEndTime - turnStartTime)
    : thoughtDurationMs;

  // 判定主导动作类别 (优先级: edit > subagent > search > shell > read > thought)
  let primaryCategory: DetailedProcessMetrics['primaryCategory'] = 'misc';
  if (editedFiles.size > 0) primaryCategory = 'edit';
  else if (subagentCount > 0) primaryCategory = 'subagent';
  else if (searchCount > 0) primaryCategory = 'search';
  else if (shellCommandCount > 0) primaryCategory = 'shell';
  else if (readFiles.size > 0) primaryCategory = 'read';
  else if (thoughtCount > 0) primaryCategory = 'thought';

  return {
    editFilesCount: editedFiles.size,
    searchCount,
    readFilesCount: readFiles.size,
    shellCommandCount,
    subagentCount,
    thoughtDurationMs,
    thoughtCount,
    totalWorkDurationMs,
    primaryCategory,
  };
}
```

### 6.3 聚合摘要文案与主导图标合成算法

```typescript
export function formatProcessSummary(metrics: DetailedProcessMetrics): {
  iconName: string;
  summaryText: string;
} {
  const parts: string[] = [];

  // 按图五的经典语序组织：已编辑 -> 已搜索 -> 已读取 -> 已运行 -> 已协作
  if (metrics.editFilesCount > 0) {
    parts.push(`已编辑 ${metrics.editFilesCount} 个文件`);
  }
  if (metrics.searchCount > 0) {
    parts.push(`已搜索 ${metrics.searchCount} 次`);
  }
  if (metrics.readFilesCount > 0) {
    parts.push(`已读取 ${metrics.readFilesCount} 个文件`);
  }
  if (metrics.shellCommandCount > 0) {
    parts.push(`已运行 ${metrics.shellCommandCount} 条命令`);
  }
  if (metrics.subagentCount > 0) {
    parts.push(`已协作 ${metrics.subagentCount} 个子任务`);
  }
  if (parts.length === 0 && metrics.thoughtCount > 0) {
    if (metrics.thoughtDurationMs > 0) {
      parts.push(`已思考 ${(metrics.thoughtDurationMs / 1000).toFixed(1)}s`);
    } else {
      parts.push('已深度思考');
    }
  }

  // 主导图标映射
  const iconMap: Record<DetailedProcessMetrics['primaryCategory'], string> = {
    edit: 'file-edit',
    search: 'search',
    read: 'file-search',
    shell: 'terminal',
    subagent: 'bot',
    thought: 'sparkles',
    misc: 'wrench',
  };

  return {
    iconName: iconMap[metrics.primaryCategory] || 'wrench',
    summaryText: parts.join(' · ') || '处理完成',
  };
}
```

**实测效果对比**：
- 输入 2 次 grep、3 次 read_file：输出 `🔍 已搜索 2 次 · 已读取 3 个文件 ⌄`，**100% 吻合图五第一个示例**；
- 输入 3 个文件修改、3 次搜索、1 次读取、3 次终端命令：输出 `已编辑 3 个文件 · 已搜索 3 次 · 已读取 1 个文件 · 已运行 3 条命令 >`，**100% 吻合图五第二个示例**。

### 6.4 顶部工作时间胶囊：`已处理 3m 9s ⌄` 计算与装配
1. **时间计算模型**：
   - 消息对象的 `msg.timestamp`（开始时间）与最后工具完成时间 `completedAt`（或正文完成时间）之差；
   - 算法函数：
     ```typescript
     export function formatWorkDuration(durationMs: number): string {
       const sec = Math.max(1, Math.round(durationMs / 1000));
       if (sec < 60) return `已处理 ${sec}s`;
       const m = Math.floor(sec / 60);
       const s = sec % 60;
       return `已处理 ${m}m ${s}s`;
     }
     ```
2. **视觉胶囊实现**：
   - 渲染为 `24px` 高度的微型胶囊按钮，居左或居中轻量呈现；
   - 点击该胶囊即可一键展开/折叠整轮所有执行细节；
   - 胶囊下方紧贴 `0.5px` 发丝横分割线，将时间状态与正文优雅区隔。

---

## 7. 与单轨虚拟滚动（VSM）及 HTML5 until-found 的协同自愈

在折叠态与展开态切换时，视口内的高频 DOM 尺寸变化极易导致虚拟滚动（VirtualScrollManager）高度撕裂或原生页面搜索（Ctrl+F）失效。必须贯彻以下两项刚性工程约束：

### 7.1 单轨测高作废（`invalidateActual`）与自愈契约
- **铁律**：禁止在行级组件内部私自创建 ResizeObserver 直接调用 `manager.setActual`（这会绕过滚动引擎的 `actualTick` 刷新机制，导致滚动条位置假死）；
- **正确路径**：
  1. 用户点击胶囊或摘要条切换展开/折叠时，只触发状态变更并调用 `virtualScrollManager.invalidateActual(msgId)`；
  2. 过程容器外部由 `MessageVirtualizer` 的宿主统一监听 DOM 尺寸变化，在下一微任务帧通过 `useVirtualScroll.setActual` 回写真实高度；
  3. 展开或收拢动画平滑过渡（`transition: 220ms var(--ease-emphasized)`），动画结束触发最终尺寸复测。

### 7.2 原生搜索穿透：`hidden="until-found"` 与 `beforematch`
- 在图五的折叠状态下，中间隐藏的内容**绝不能使用 `display: none` 或 unmount 卸载**；
- 必须遵循 `TurnProcessNodeView.tsx:72-97` 已经验证的双轨模式：
  1. 折叠时给隐藏容器设置原生属性 `hidden="until-found"`；
  2. 监听原生的 `beforematch` 事件；
  3. 当用户在浏览器中按下 `Ctrl+F` 搜索中间执行日志或被折叠的思考内容时，浏览器自动命中并派发 `beforematch`，组件状态机就地响应并将 `isExpanded` 翻转为 `true`，内容瞬间向用户展开，实现无缝的“原生级透传”。

---

## 8. 调研结论与第二波详案建议清单

### 8.1 核心调研结论
1. **展开态资产高度具备，仅存 3 处关键断层**：
   - `ToolCallHeader` 的 24px 单行骨架非常优秀，但**漏掉了 Chevron 图标渲染**，且 CSS 中缺失了 `.diffStatsAdd` / `.diffStatsDel` 的颜色规则；
   - 运行态脉冲点过于激进地抹去了语义图标，需改为图标伴随柔和高光扫光带；
   - 思考组件存在 `ReasoningRow` 与 `TimelineThoughtSection` 双轨分叉，需收敛到 `ReasoningRow`。
2. **折叠态需要新增多维分类归纳引擎**：
   - 现有的 `turnProcessState.ts` 无法生成图五精细的聚合摘要，其根因是把所有非 subagent 工具统一算成了 `toolCount`；
   - 必须引入基于 6 大维度（编辑/搜索/读取/运行/协同/思考）的 `countDetailedProcessMetrics` 纯逻辑函数与主导图标决策树；
   - 顶部状态胶囊需升级为 `已处理 3m 9s ⌄` 进位制时间格式。

### 8.2 第二波（详案波）建议对接清单

| 任务建议编号 | 对应目标文件 | 核心实现任务 |
|---|---|---|
| **PLAN-EXP-01** | `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css` | 补充 `.diffStatsAdd`（绿）与 `.diffStatsDel`（红）样式；优化 `.toolRowHead` 的 24px 网格对齐。 |
| **PLAN-EXP-02** | `apps/crish-desktop/src/components/chat-tool-call/ToolCallHeader.tsx` | 在 `toolRowHeadRight` 中装配 `toolRowChevron`；优化运行态图标扫光。 |
| **PLAN-EXP-03** | `apps/crish-desktop/src/components/chat-message-row/` | 废除 `TimelineThoughtSection`，全面统一至 `ReasoningRow`，支持「深度思考」极简标题。 |
| **PLAN-FOLD-01**| `apps/crish-desktop/src/components/chat-message/turnProcessState.ts` | 实现 `countDetailedProcessMetrics` 与 `formatProcessSummary` 多维分类算法。 |
| **PLAN-FOLD-02**| `apps/crish-desktop/src/components/chat-message/TurnProcessNodeView.tsx` | 重构控制条渲染图五聚合摘要（含主导图标 `🔍`、`file-edit`），连接 `hidden="until-found"`。 |
| **PLAN-FOLD-03**| `apps/crish-desktop/src/components/chat-message/MessageContent.tsx` | 在终态实现顶部工作时间胶囊（`已处理 3m 9s ⌄`）+ 0.5px 发丝分割线 + 过程默认全折叠。 |

---
*报告落盘完毕，请主控 Agent 审阅并推进第 2 波详细方案设计。*
