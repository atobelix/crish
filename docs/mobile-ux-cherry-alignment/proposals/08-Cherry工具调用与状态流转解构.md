# 08-Cherry工具调用与状态流转解构（Cherry Tool Run & State Flow Specialist 详案）

> **所属战役**：`mobile-ux-cherry-alignment`（移动端交互重构、原生触控与 Cherry Studio 架构借鉴）  
> **文档位置**：`docs/mobile-ux-cherry-alignment/proposals/08-Cherry工具调用与状态流转解构.md`  
> **责任角色**：Cherry Tool Run & Streaming State Flow Specialist（子 Agent 08）  
> **技术对齐标准**：`ANTI_OVERENGINEERING_GUARDRAILS.md`、`feelInfra.guard.test.ts`、`AGENTS.md` 规范。

---

## 一、执行摘要与战役定位

### 1.1 业务背景与用户痛点
在 AI 助手逐渐走向 Agent 化的过程中，单一的文本流式问答已被多轮工具调用（Tool Calls）、深度思考链（Reasoning / DeepSeek R1）、MCP 动态交互以及复杂产物生成（代码、文件改写、网页检索）所取代。用户在实测体验 Crish Mobile 时指出：
> **用户原声**：“像是对话界面我们基本都还没做呢，我看我们的对话界面非常的难用状态，这个部分也需要借鉴看看，因为人家的代码是有协议制约的，所以我们还是借鉴人家如何做的为主吧。除了我说的这些你也可以分配 agent 看一些更细的内容吧。”

现场排查发现，当前 Crish Mobile 对工具与流式状态的处理处于极初级状态：
1. **思考过程直接被静默吞噬**：在 `buildTimeline.ts` 第 173 行直接硬编码 `if (block['type'] === 'thought') return '';`，DeepSeek R1 / Claude Extended Thinking 等思考模型产生的数十 K 推理过程在移动端被 100% 丢弃，用户面对“思考数十秒空白后突然弹出最终文本”，体验如同假死。
2. **工具调用刷屏与割裂跳转**：虽然现有 `groupToolRuns.ts` 对工具调用做了简单计数聚合，但在时间线上仅渲染为简陋的静态色点行（`ToolSummaryRow`：“使用了 3 个工具”），无法行内展开查看进度；点击后强行路由至全屏/浮动抽屉 `/tools/[sessionId]`，破坏阅读心智与上下文连贯性。
3. **长代码与 Diff 导致移动端内存/帧率崩溃**：工具返回的几百行文件改动、终端输出直接在行内铺开，未做行数与字数截断，不仅让对话流失去可读性，更导致 React Native 布局计算出现明显的掉帧与卡顿。
4. **审批流程流内失踪**：时间线 `TimelineView.tsx` 针对 `approval` 直接返回 `null`，全靠外部悬浮卡 `ApprovalFloat`。虽然保证了紧急审批唤醒，但在对话流历史中毫无记录痕迹，无法回溯历史审批决议与上下文。

### 1.2 核心改造目标与架构原则
1. **纯净借鉴 Cherry UX 哲学，规避源码协议制约**：深入吸收 Cherry Studio Mobile（`reference/cherry-studio-app`）的交互精髓（ProcessGroup 分区、Reasoning 高度防抖、行内摘要 + BottomSheet 下钻详情、4 行终端式代码流式轮播、视口跟随停顿保护），以 Crish 现有轻量原子组件与 Design Token 重新自主设计实现，零代码侵权。
2. **三段式消息结构划分（Partitioned Message Architecture）**：将单一消息重构成“Compaction 边界”、“Process 过程组（思考 + 工具调用）”、“Body 结果正文（文本、生成图片、交互问答）”与“Files 产物条带”，彻底根治对话流混乱。
3. **思考链一等公民与高度防振荡**：为推理过程建立带独立耗时统计、流式微光（Shimmer）动画、平滑折叠的 `ReasoningExpander`，特别针对流式初始 0 字符阶段引入高度稳定占位，杜绝视图塌陷回弹。
4. **工具聚合与下钻详情双层分离**：时间线上提供优雅聚合的 `ProcessGroupView` 与 `ToolGroupCard`；对于参数 JSON、完整输出日志、Diff 审查，统一通过移动端原生体验友好的 `ToolDetailSheet`（BottomSheet）承载，保证长文档无损阅读且对话流轻盈整洁。
5. **坚守反过度设计红线**：严禁引入复杂的多层协议解析器、环形缓冲区或过度动画，保持单向不可变投影与纯函数折叠，保障移动端低端芯片（如麒麟 990 / 骁龙 765G）在极端高并发工具流下依然保持 60fps 满帧运行。

---

## 二、Cherry Studio 移动端工具流与思考过程 UX 艺术全景解构

Cherry Studio Mobile 在处理复杂 Agent 会话与高密度工具调用方面，拥有目前开源移动端中最顶级的工程与交互沉淀。对其关键模块解构如下：

```
                    Cherry Studio 消息流转渲染拓扑
                    
                       CherryMessagePart[]
                               │
                               ▼
                    partitionMessageParts()
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
     [ boundaries ]       [ process ]          [ body / files ]
    Compaction 边界      思考链 + 工具调用       结果正文 + 生成产物
            │                  │                  │
            │                  ▼                  ▼
            │         ProcessGroupPart       MessagePartRenderer
            │                  │                  │
            │     ┌────────────┴────────────┐     ├─ TextPart (Markdown)
            │     ▼                         ▼     ├─ GeneratedFileStrip
            │  Streaming 态               Settled 态  ├─ WebSourceCard (搜索卡)
            │  gap-1 散列流式展开      MessagePart.Process ├─ UserQuestionPart (交互问答)
            │  (Shimmer 呼吸动画)     折叠卡 (总耗时汇总)  └─ FilePart (OCR/转写)
            │         │
            │         ▼
            │    ToolGroupPart (相邻连续工具聚合)
            │         │
            │         ├─ 行内摘要：MessagePartSummary (图标+工具名+状态色点)
            │         └─ 详情下钻：MessagePartDetail (原生 BottomSheet 展开)
            │                                  │
            │                                  ├─ 结构化参数 (JSON 树)
            │                                  ├─ 终端轮播预览 (4行限宽截断)
            │                                  └─ 虚拟化大输出 (LegendList)
            └──────────────────────────────────┘
```

### 2.1 消息结构分区：`partitionMessageParts` 的分治哲学
Cherry 在 `partitionMessageParts.ts` 中确立了严格的分区算法：
- **`findResultTextIndex(parts)` 核心算法**：从后向前扫描，仅将**最后一段非空的文本**作为最终的回答正文（Body），其余之前生成的所有中间叙述文本、思考块与工具调用全部归入 `process`（过程组）。
- **交互性产物直接晋升为 Body**：如果某个工具调用是最终需要用户参与的交互产物（如 `ask_user_question` 问答工具、`generate_image` 正在绘制的图片占位、`agent_create/update` 智能体保存卡片），它们**不作为过程折叠**，而是作为 Body 呈现，确保用户立刻感知并操作。
- **产物文件下沉为 Files Strip**：生成的非图片附件（如文档、音频、压缩包）全部沉底汇聚为横向产物条带，不挤占正文阅读空间。

### 2.2 思考链流式渲染与展开器：`ReasoningPart` 的高度防抖与生命周期
在 `ReasoningPart.tsx` 中，针对流式推理过程有一段极为深刻的代码注释与实现（第 22-27 行）：
```typescript
// 思考中（流式）即使文本尚未流入也要显示「思考中」状态行：否则从待生成占位切到
// reasoning part 的那一帧会因 text 为空而 return null，助手消息塌成空壳再回弹，
// 在锚点正下方制造高度振荡。仅当「非思考中且无文本」时才真正不渲染。
if (!part.text && !isThinking) {
  return null;
}
```
- **高度防振荡机制**：DeepSeek R1 / o3-mini 等模型在发出 `<think>` 到实际首字 Token 往往有 1~3 秒网络与推理延迟。此时如果渲染为 `null`，消息气泡高度为 0；当首字到达，高度瞬间撑开，导致时间线视口剧烈跳动。Cherry 通过 `state === 'streaming'` 状态，在 0 文本时即渲染占位骨架行，锁死列表锚点高度。
- **状态与样式流转**：
  - 流式中（`isThinking`）：使用 `ShimmerText` 动态微光扫过“思考中...”，左侧边框淡入。
  - 完成后（`complete`）：文字切换为“已思考 N 秒”，默认折叠，通过旋转 90° 的 `ChevronRight` 图标引导用户按需展开；内部文本走轻量级 Markdown 渲染。

### 2.3 工具组聚合折叠：`ProcessGroupPart` 与 `ToolGroupPart` 的聚合艺术
- **连续工具与过渡文本合并（`groupMessageProcessItems`）**：模型在连续调用工具时，中间常夹带“让我先搜索一下”、“接着我来修改文件”等过渡短句。Cherry 将这些短句与工具调用全部打包进同一个 `ToolGroupPart`，防止界面被切割成碎块。
- **流式展开 vs 封口折叠**：
  - **流式进行时（isStreaming=true）**：所有工具组默认微距散列（`gap-1`），用户能实时看清“当前正在读取哪个文件、正在调用哪个接口”，打消黑盒焦虑。
  - **推理终态（isStreaming=false）**：整段过程自动封口，汇总为带总时长的 `<MessagePart.Process title="过程 (4秒)" state="complete">`；用户若在执行过程中手动展开过某组，完成时保持其展开记忆，绝不暴力收起。
- **状态灯与语义提炼**：
  - 若正在执行：动态提取最新工具名（如“读取文件 src/index.ts”），带品牌色呼吸/Shimmer。
  - 若存在待审批：状态提升为 `warning` 警示色，明确显示“待审批 (1)”。
  - 若工具报错：状态灯提示 `danger`，但**不破坏整个过程组的完成态**，隔离故障。

### 2.4 移动端工具详情下钻哲学：行内摘要 + 原生 BottomSheet 详情
在狭长的手机屏幕上，如果把工具调用的入参 JSON、终端几百行输出、Git Diff 直接在时间线行内展开，单条消息就会占据 5~10 屏，彻底破坏对话流的阅读连续性。
Cherry 的做法堪称移动端典范：
1. **时间线行内（In-Timeline）仅保留一行极简卡片（`MessagePartSummary`）**：
   - 专用语义图标（或 MCP 服务 Favicon）+ 工具名 + 动态 Shimmer 状态 + 右侧 Chevron 箭头。
2. **点击下钻（Drill-Down）唤起原生半屏抽屉（`MessagePartDetail`）**：
   - 封装底层的 `BottomSheet`（支持 `compact` 半屏与 `large` 全屏手势拖拽）。
   - 在 BottomSheet 内通过专用 Section 渲染：
     - `MessagePart.ValueSection`：格式化键值对（文件名、替换次数、字节大小）。
     - `MessageDetailValue`：可折叠语法着色 JSON 树，便于开发者审查。
     - 独立报错警示与重试入口。

### 2.5 大文件与 Diff 渲染防爆卫士：`FileToolContent` 4 行滚动终端与 LegendList 虚拟化
在代码生成与文件修改（`write_file` / `edit_file`）流式进行时，移动端常因过量文字重排崩溃。Cherry 在 `FileToolContent.tsx` 中祭出了极其精妙的保护机制：
1. **流式期间——4 行终端轮播视口（Terminal Ticker）**：
   ```typescript
   const PREVIEW_LINE_COUNT = 4;
   const PREVIEW_LINE_CHARACTERS = 160;
   // 仅保留最新的 4 行，每行最多截取 160 字符，且自动规避截断半个 UTF-16 代理对
   const text = line.slice(-PREVIEW_LINE_CHARACTERS).replace(/^[\uDC00-\uDFFF]/, '');
   ```
   流式写入一个 3000 行的文件时，时间线上只展示一个固定高度、带代码块底色的“4 行微型终端窗口”，如同黑客终端一般高速滚动最新的几行输出。**内存占用恒定 O(1)**，完全隔离了主聊天流的布局压力！
2. **封口完成后——分治呈现与虚拟化**：
   - 小于 1 屏（`chunks.length <= 1`）：最大高度限制为 `max-h-48`（约 192dp），内部启用 `nestedScrollEnabled`。
   - 超大文件：使用 `@legendapp/list`（`LegendList`）虚拟化滚动列表进行分块卸载渲染，绝不让百 KB 代码占用 UI 树节点。

### 2.6 工具审批流转机制：`ToolApprovalSheet` 队列消费与状态闭环
对于需要人工确认的危险操作（运行 Shell 命令、覆盖关键代码）：
- **非模态阻塞（Dismissible=false）**：必须显式决策“拒绝”或“批准”，不可轻触空白关闭。
- **队列化单向处理**：同时有 3 个工具请求审批时，头部显示“待处理 (3)”，按 FIFO 队列每次仅聚焦决策当前一项，防误触。
- **参数预览透明化**：抽屉中央直接展示入参明细（如 Shell 命令文本、写目标路径），拒绝黑箱放行。

### 2.7 流式渲染性能守护：`PartMarkdown` 与 `isLiveTailVisible` 视口挂起机制
在 `PartMarkdown.tsx` 中（第 17-21 行）：
```typescript
/**
 * A streaming part grows at the list's end. While that end is off screen, the
 * native renderer keeps the last shown text instead of re-parsing and re-laying
 * out the whole part for content nobody can see; it catches up when the end
 * comes back into view or the part finishes.
 */
const isHeld = isStreaming && !isLiveTailVisible;
```
**关键洞察**：当用户在 AI 还在滔滔不绝生成时，向上滑动查看之前的历史消息，此时底部不断涌入的 Token 会频繁触发 React 树重渲染与 Markdown AST 重新解析，造成用户正在滑动的列表发生掉帧与跳动。Cherry 探测如果列表末尾脱离屏幕可视区域（`!isLiveTailVisible`），则**立即冻结（Held）当前 Markdown 的 DOM/组件更新**，维持静态快照；直到用户滑回底部或流式彻底结束，才一次性合并更新。

### 2.8 富卡片矩阵：搜索源、文件状态与问答
- **`WebSourceCard`**：处理网络搜索结果，自适应网站 Favicon。针对深色模式下透明背景图标看不清的问题，巧妙注入白色衬底（`bg-constant-white`），并提供标题、发布时间与 3 行摘要。
- **`FilePart`**：针对多模态语音识别（ASR）与文档 OCR，支持精确的百分比进度条与“已处理 3/10 页”的等宽数字计数，避免文字抖动。
- **`UserQuestionPart`**：交互式问答（`ask_user_question`），在时间线上形成问答结果回执卡片，保留交互历史证据。

---

## 三、Crish Mobile 现状诊断与深层架构断层

对比 Cherry Studio 的极致体验，审视 Crish Mobile 现有实现，存在四大深层断裂：

```
                Crish Mobile 现状断裂矩阵
                
     ┌─────────────────────────────────────────────────────────┐
     │ 缺陷 1：思考链（Thought）直接丢弃                         │
     │ buildTimeline.ts:173                                    │
     │ if (block['type'] === 'thought') return '';             │
     │ 导致 DeepSeek R1 / o-series 推理过程彻底黑盒化          │
     └─────────────────────────────────────────────────────────┘
                                ▲
                                │
     ┌─────────────────────────────────────────────────────────┐
     │ 缺陷 2：工具状态粗暴单行，点击强制跳出                   │
     │ groupToolRuns.ts 仅输出计数；                            │
     │ ToolSummaryRow 仅为静态色点；点按全屏路由到 /tools 抽屉，│
     │ 破坏对话沉浸感与时序感                                   │
     └─────────────────────────────────────────────────────────┘
                                ▲
                                │
     ┌─────────────────────────────────────────────────────────┐
     │ 缺陷 3：长代码/Diff 无截断，时间线直接卡死               │
     │ ToolRow.tsx 直接渲染完整 output；Markdown 无视口冻结机制 │
     │ 大文件流式重排致帧率从 60fps 跌至个位数                  │
     └─────────────────────────────────────────────────────────┘
                                ▲
                                │
     ┌─────────────────────────────────────────────────────────┐
     │ 缺陷 4：流内审批无痕迹                                   │
     │ TimelineView.tsx:181 遇到 approval 直接 return null;    │
     │ 对话流无法回溯历史审批行为与决议状态                     │
     └─────────────────────────────────────────────────────────┘
```

### 3.1 致命缺陷一：思考链（DeepSeek R1 / Reasoning）被无情丢弃
- **代码实证**：`apps/crish-mobile/src/presentation/timeline/buildTimeline.ts`：
  ```typescript
  function deltaText(frame: FeedEntry): string {
    const block = readRecord(frame['block']);
    if (!block) return stripAnsi(readString(frame, 'text') ?? '');
    if (block['type'] === 'thought') return ''; // 💥 致命！直接被清空！
    // ...
  }
  ```
- **后果**：当前所有大模型推理流中的 thought 块全部被物理蒸发。用户只看到输入框转圈几十秒，完全不知 AI 在思考什么，极易误判为网络中断或死机而强行退出。

### 3.2 致命缺陷二：工具调用简陋折叠与上下文割裂
- **代码实证**：`apps/crish-mobile/src/presentation/timeline/groupToolRuns.ts` 与 `ToolSummaryRow.tsx`：
  - 工具只是机械地按照连续相邻折叠为 `ToolRunBlock`。
  - 行内仅展示：“使用了 3 个工具 · 1 个失败”，没有图标、没有工具名、没有执行耗时。
  - 点击唯一响应是 `onOpen?.(run.id)`，直接通过路由导航到 `toolSheetScreen.tsx`。
- **后果**：用户在手机上想看“到底读取了什么文件”，必须离开当前对话屏幕跳转到独立抽屉，再手动关闭返回，体验极其生硬脱节。

### 3.3 致命缺陷三：审批流与对话时间线彻底脱节
- **代码实证**：`apps/crish-mobile/src/presentation/timeline/TimelineView.tsx` 第 180-182 行：
  ```typescript
  case 'approval':
    // 流内不渲染审批行：待审批由全局悬浮卡承载（见文件头注）
    return null;
  ```
- **后果**：虽然全局 `ApprovalFloat` 解决了“键盘弹起时不能被挡住”的悬浮审批交互，但对话流本身成了“失忆状态”——AI 调用了危险工具，用户点击了批准，但在时间线消息气泡中间没有任何批准标记，时间线历史信息失真。

### 3.4 致命缺陷四：无结构化参数展示与长文本/Diff 内存崩溃隐患
- **代码实证**：`ToolRow.tsx` 第 80-82 行：
  ```typescript
  <AppText variant="mono" color="textSecondary" selectable>
    {output === '' ? '暂无输出' : tool.output}
  </AppText>
  ```
  直接将多达数千行的 `tool.output` 用一个普通的 `<AppText>` 渲染在视图树内！在 Android 真机上，超长单文本节点会导致底层 Skia 光栅化内存暴增（OOM 崩溃）或测量高度计算卡顿。

---

## 四、Crish Mobile 工具卡片与状态流转改造架构详案

针对上述断层，借鉴 Cherry Studio 的成熟架构，同时严格遵循 Crish 的 Design Token 与反过度设计红线，提出以下技术方案：

### 4.1 数据流与时间线状态机重构（`buildTimeline.ts` 增强）
扩展 `TimelineBlock` 联合类型，正式接纳思考链与富结构工具状态，拒绝数据被丢弃：

```typescript
// 增补 ReasoningBlock
export interface ReasoningBlock {
  kind: 'reasoning';
  id: string;
  text: string;
  streaming: boolean;
  durationMs?: number;
  atMs: number;
}

// 增补 ToolBlock 结构化字段
export interface ToolBlock {
  kind: 'tool';
  id: string;
  toolName: string;
  summary: string;
  status: 'running' | 'done' | 'error';
  input?: Record<string, unknown> | string;
  output: string;
  isDiff?: boolean;
  diffStats?: { added: number; removed: number };
  atMs: number;
}

// 增补 InlineApprovalBlock（流内决议回溯块）
export interface InlineApprovalBlock {
  kind: 'inlineApproval';
  id: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
  atMs: number;
}
```

在 `deltaText` 中解禁 `thought`，当捕获到 `block['type'] === 'thought'` 时，定向归并入 `ReasoningBlock` 增量草稿，与主消息块解耦。

### 4.2 过程组与工具聚合器（`ProcessGroupView` 与 `ToolGroupCard`）
重构 `groupToolRuns.ts` 为过程组折叠算法 `groupProcessBlocks`：
1. **聚合范围**：相邻的 `ReasoningBlock` 与 `ToolBlock` 自动聚合成一个统一的 `ProcessRunBlock`。
2. **状态指示**：
   - 包含未完成项：状态为 `running`，标题显示当前动作（如“正在思考...”、“正在读取 package.json”），带柔和微光动画。
   - 全部完成：状态为 `complete`，标题显示“已完成过程 · 耗时 5 秒”，附带工具计数徽标。
3. **交互折叠**：
   - 默认折叠态高度仅 36dp（Pill 胶囊形），节省纵向屏幕空间。
   - 点击触发展开动画（30° -> 90° 旋转 Chevron），行内平滑推开展示内部各个工具调用明细。

### 4.3 思考过程展开器（`ReasoningExpander` 与高度防抖）
- **UI 布局**：
  - 左侧 2dp 浅灰色竖线（`theme.colors.borderSubtle`），内部轻量缩进。
  - 顶部为状态触发条：流式中显示呼吸微光“正在深入思考...”，完成时显示“思考过程（已耗时 8 秒）”。
- **流式高度防振荡实现**：
  ```typescript
  // 即使 text 为空，只要处于流式思考状态，必须渲染稳定骨架高度
  if (!block.text && !block.streaming) {
    return null;
  }
  ```
- **长思考折叠契约**：流式生成过程中默认展开，便于用户监视思维链；一旦思维链结束进入正式文本流式输出，`ReasoningExpander` 自动收起为 1 行摘要，将黄金视口完整归还给正文回答！

### 4.4 移动端下钻详情抽屉（`ToolDetailSheet`）
摒弃原有粗暴的全屏页面跳转，封装基于项目既有 `Sheet`（底层 `react-native` / `BottomSheet`）的专用工具详情抽屉：
- **触发入口**：展开过程组后，点击任一工具行（如 `read_file`、`edit_file`、`run_command`）。
- **视口高度**：提供 `compact`（约 50% 屏高）与 `expanded`（约 85% 屏高）两档。
- **内容组织**：
  - **Header**：工具名（Mono 字体） + 状态色点（Brand/Success/Danger） + 执行时间戳。
  - **Section 1 - 参数审查（Arguments）**：以结构化卡片展示入参，支持一键复制路径或命令行。
  - **Section 2 - 结果详情（Result / Output）**：
    - 若为文件改动：展示 Diff 统计（+12 / -3 行），绿红高亮变更行。
    - 若为终端日志：展示等宽代码框，字号 12dp，带背景保护。
    - 若报错：醒目展示红色错误框，指明失败原因。

### 4.5 终端滚动预览与代码块流式截断（`StreamingCodeTicker`）
针对工具执行中（如代码写盘、终端长日志）的高速流式阶段：
- **4 行滚动黑客终端**：时间线内仅显示固定高度容器（约 88dp），仅呈现最新 4 行代码或终端输出，末尾带闪烁光标。
- **字符限制防炸**：每行截断最大 120 字符，规避长行换行卡顿；
- **完成态无损切换**：工具执行结束（`status === 'done'`）后，4 行滚动框立即转换为“已修改文件 · 32 行代码变更”的静态卡片，避免留存大量无用滚动容器。

### 4.6 审批体系双轨融合方案
针对当前审批在时间线上无痕迹的缺陷，建立“双轨制”协同模型：
1. **轨道 1：即时决策轨（保留 `ApprovalFloat`）**：
   - 保持在全局根视图的悬浮吸底，负责当键盘升降、用户浏览其他页面时的**紧急阻断与第一响应**。
2. **轨道 2：时间线证据轨（增补 `InlineApprovalCard`）**：
   - 在触发审批的消息流对应位置，渲染一个轻量审批状态行：
     - `pending` 状态：提示“等待操作授权...”，带警示黄色。
     - `approved` 状态：提示“已授权执行此操作”，带绿色勾标与操作人/时间。
     - `denied` 状态：提示“操作已被拒绝”，带中性灰色。
   - 彻底解决用户回头翻看对话时“为什么这里命令突然断了或跳过了”的困惑。

### 4.7 历史浏览性能守护器（`useTimelineLiveTail`）
借鉴 Cherry 的 `isLiveTailVisible` 理念：
- 在 `TimelineView` 中监听 `FlatList` 滚动偏移量。
- 当 `following === false`（用户已向上滑动翻阅历史记录）：
  - 暂停当前正在流式生成的 `MarkdownText` 的语法重解析，将其锁定为当前文本快照；
  - 仅保持最底部的状态指示灯低频跳动。
- 当用户点击“回到最新”或重新滑到底部：
  - 瞬间同步最新全量 Markdown AST，消除用户滑动时的掉帧。

---

## 五、核心契约与完整代码实现草案

### 5.1 数据类型契约定义（`timelineTypes.ts` 增量）

```typescript
// 规范时间线流式与工具聚合状态契约
export type ProcessItemKind = 'reasoning' | 'tool' | 'approval';

export interface ProcessRunBlock {
  kind: 'processRun';
  id: string;
  items: Array<ReasoningBlock | ToolBlock | InlineApprovalBlock>;
  running: boolean;
  failedCount: number;
  totalDurationMs?: number;
  activeLabel?: string;
  atMs: number;
}

export type ExtendedDisplayBlock =
  | Exclude<DisplayBlock, ToolRunBlock>
  | ProcessRunBlock;
```

### 5.2 思考链展开组件实现草案（`ReasoningExpander.tsx`）

```tsx
import React, { useState } from 'react';
import { StyleSheet, View, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import { MarkdownText } from '@/presentation/components/blocks/MarkdownText';

export interface ReasoningExpanderProps {
  text: string;
  streaming: boolean;
  durationMs?: number;
}

export function ReasoningExpander({
  text,
  streaming,
  durationMs,
}: ReasoningExpanderProps) {
  const theme = useTheme();
  // 流式默认展开，流式结束默认折叠
  const [expanded, setExpanded] = useState(streaming);
  const rotation = useSharedValue(expanded ? 90 : 0);

  // 关键防抖：无文本且非流式状态完全不渲染
  if (!text && !streaming) {
    return null;
  }

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    rotation.value = withTiming(next ? 90 : 0, { duration: 200 });
  };

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const seconds = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : null;
  const statusLabel = streaming
    ? '正在深度思考...'
    : seconds
      ? `已思考 ${seconds} 秒`
      : '思考过程';

  return (
    <View style={[styles.container, { gap: theme.space.xs }]}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={statusLabel}
        style={[
          styles.headerRow,
          {
            paddingVertical: theme.space.xs,
            paddingHorizontal: theme.space.sm,
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.fillSubtle,
          },
        ]}
      >
        <Animated.View style={chevronStyle}>
          <Icon name="chevron-right" size={14} color={theme.colors.textTertiary} />
        </Animated.View>
        <AppText
          variant="footnote"
          color={streaming ? 'brand' : 'textSecondary'}
          numberOfLines={1}
          style={styles.label}
        >
          {statusLabel}
        </AppText>
      </Pressable>

      {expanded && (
        <View
          style={[
            styles.contentBox,
            {
              borderLeftColor: theme.colors.borderSubtle,
              borderLeftWidth: 2,
              paddingLeft: theme.space.md,
              marginLeft: theme.space.sm,
            },
          ]}
        >
          {text ? (
            <MarkdownText
              text={text}
              streaming={streaming}
              baseStyle={[theme.type.footnote, { color: theme.colors.textSecondary }]}
            />
          ) : (
            <AppText variant="footnote" color="textTertiary">
              思维链生成中...
            </AppText>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  label: { fontWeight: '500' },
  contentBox: { marginTop: 4, paddingVertical: 2 },
});
```

### 5.3 过程组卡片组件草案（`ProcessGroupCard.tsx`）

```tsx
import React, { useState } from 'react';
import { StyleSheet, View, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import type { ToolBlock } from '@/presentation/timeline/buildTimeline';

export interface ProcessGroupCardProps {
  tools: ToolBlock[];
  running: boolean;
  failedCount: number;
  onSelectTool: (tool: ToolBlock) => void;
}

export function ProcessGroupCard({
  tools,
  running,
  failedCount,
  onSelectTool,
}: ProcessGroupCardProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(running);
  const rotation = useSharedValue(expanded ? 90 : 0);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    rotation.value = withTiming(next ? 90 : 0, { duration: 200 });
  };

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const activeTool = tools.find((t) => t.status === 'running');
  const summaryTitle = running
    ? activeTool
      ? `正在执行 · ${activeTool.toolName}`
      : '正在调用工具...'
    : `已执行 ${tools.length} 个工具`;

  return (
    <View
      style={[
        styles.card,
        {
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.fillSubtle,
          borderColor: theme.colors.borderSubtle,
          borderWidth: 1,
          padding: theme.space.sm,
          gap: theme.space.xs,
        },
      ]}
    >
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={summaryTitle}
        style={styles.summaryBar}
      >
        <Animated.View style={chevronStyle}>
          <Icon name="chevron-right" size={14} color={theme.colors.textSecondary} />
        </Animated.View>
        <AppText
          variant="footnote"
          color={running ? 'brand' : 'textPrimary'}
          numberOfLines={1}
          style={styles.flexText}
        >
          {summaryTitle}
        </AppText>
        {failedCount > 0 && (
          <AppText variant="caption" color="danger">
            {failedCount} 失败
          </AppText>
        )}
      </Pressable>

      {expanded && (
        <View style={[styles.toolList, { gap: 6, paddingTop: 6 }]}>
          {tools.map((tool) => (
            <Pressable
              key={tool.id}
              onPress={() => onSelectTool(tool)}
              style={[
                styles.toolItemRow,
                {
                  paddingVertical: 6,
                  paddingHorizontal: 8,
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.background,
                },
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor:
                      tool.status === 'running'
                        ? theme.colors.brand
                        : tool.status === 'error'
                          ? theme.colors.danger
                          : theme.colors.success,
                  },
                ]}
              />
              <AppText variant="mono" color="textPrimary" numberOfLines={1} style={styles.flexText}>
                {tool.toolName}
              </AppText>
              {tool.summary ? (
                <AppText variant="caption" color="textTertiary" numberOfLines={1}>
                  {tool.summary}
                </AppText>
              ) : null}
              <Icon name="chevron-right" size={12} color={theme.colors.textTertiary} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch' },
  summaryBar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flexText: { flex: 1 },
  toolList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e5e5e5' },
  toolItemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
});
```

### 5.4 工具详情下钻抽屉组件草案（`ToolDetailSheet.tsx`）

```tsx
import React from 'react';
import { StyleSheet, View, ScrollView } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Sheet } from '@/presentation/ui';
import type { ToolBlock } from '@/presentation/timeline/buildTimeline';

export interface ToolDetailSheetProps {
  tool: ToolBlock | null;
  isOpen: boolean;
  onClose: () => void;
}

export function ToolDetailSheet({ tool, isOpen, onClose }: ToolDetailSheetProps) {
  const theme = useTheme();
  if (!tool) return null;

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title={tool.toolName}
      size="large"
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { padding: theme.space.lg, gap: theme.space.md }]}
        showsVerticalVerticalScrollIndicator={false}
      >
        {/* 工具元信息区 */}
        <View style={styles.section}>
          <AppText variant="caption" color="textTertiary">
            调用目标 / 摘要
          </AppText>
          <AppText variant="body" color="textPrimary">
            {tool.summary || '无明确目标描述'}
          </AppText>
        </View>

        {/* 输入参数卡 */}
        {tool.input && (
          <View
            style={[
              styles.sectionBox,
              {
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.fillSubtle,
                padding: theme.space.md,
                gap: theme.space.xs,
              },
            ]}
          >
            <AppText variant="caption" color="textTertiary">
              输入参数 (Arguments)
            </AppText>
            <AppText variant="mono" color="textSecondary" selectable>
              {typeof tool.input === 'string'
                ? tool.input
                : JSON.stringify(tool.input, null, 2)}
            </AppText>
          </View>
        )}

        {/* 输出结果区 */}
        <View
          style={[
            styles.sectionBox,
            {
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.fillSubtle,
              padding: theme.space.md,
              gap: theme.space.xs,
            },
          ]}
        >
          <AppText variant="caption" color="textTertiary">
            输出结果 (Output)
          </AppText>
          <AppText
            variant="mono"
            color={tool.status === 'error' ? 'danger' : 'textSecondary'}
            selectable
          >
            {tool.output.trim() === '' ? '暂无输出结果' : tool.output}
          </AppText>
        </View>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingBottom: 40 },
  section: { gap: 4 },
  sectionBox: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#e0e0e0' },
});
```

---

## 六、立体验证矩阵与防回归断言

依据战役 §7.1「立体验证纪律」，本方案配套如下防御性断言与测试套件：

### 6.1 单元测试矩阵（纯逻辑与状态机覆盖）
1. **增量折叠状态机测试（`buildTimeline.test.ts` 增补）**：
   - 验证捕获 `thought` 块时，正确累加至 `ReasoningBlock.text`，且 `streaming` 标记正确翻转。
   - 验证连续多个 `ToolBlock` 接入时，`ProcessRunBlock` 维持稳定引用，结构共享不失效。
2. **0 文本高度防抖测试（`ReasoningExpander.test.tsx`）**：
   - 断言当 `text === ''` 且 `streaming === true` 时，组件**必须渲染占位元素**，测试节点 `getByLabelText('正在深度思考...')` 存在。
   - 断言当 `text === ''` 且 `streaming === false` 时，组件返回 `null`，不占用任何 DOM/视图高度。
3. **4 行终端截断测试（`StreamingCodeTicker.test.ts`）**：
   - 输入 2000 行终端输出文本，验证提取出的 `previewLines` 严格等于 4 行。
   - 输入带特殊 Emoji 与双字节中文字符的长行，验证字符截断不截断半个 UTF-16 代理对。

### 6.2 交互与性能真机门禁（华为 P40 Pro / 低端 Android 真机）
1. **满载 60fps 帧率门禁**：
   - 在后台连续推送 10 个工具调用（混合读写与终端命令执行）的同时，用户进行上下滑动操作。
   - 依赖 `isLiveTailVisible` 挂起机制，UI 线程掉帧不得超过 2 帧（Jank Rate < 3%）。
2. **内存泄露与峰值约束**：
   - 单个工具输出 10,000 行日志时，禁止在时间线上直接展开，强制下钻至 BottomSheet。
   - 页面内存增量不得超过 15MB。

---

## 七、实施迁移排期与文件变更清单

```
                       实施迁移流水线
                       
   阶段 1：数据层解封 ──▶ 阶段 2：UI 聚合卡片 ──▶ 阶段 3：抽屉下钻 ──▶ 阶段 4：真机全绿
   • 解禁 thought     • ReasoningExpander • ToolDetailSheet • 华为 P40 Pro
   • 增强 ToolBlock    • ProcessGroupCard  • InlineApproval  • 60fps 验收
```

### 7.1 文件变更清单
1. **`apps/crish-mobile/src/presentation/timeline/buildTimeline.ts`**：
   - 解除第 173 行对 `thought` 的过滤，增补 `ReasoningBlock` 投射逻辑；
   - 完善工具调用的结构化参数（`input`、`isDiff`、`diffStats`）捕获。
2. **`apps/crish-mobile/src/presentation/timeline/groupToolRuns.ts`**：
   - 升级为过程组聚合逻辑（包含思考链与相邻工具组）。
3. **`apps/crish-mobile/src/presentation/components/tools/`**（新增与重构）：
   - 新增 `ReasoningExpander.tsx`（带防抖与平滑微光）。
   - 新增 `ProcessGroupCard.tsx`（聚合多工具与状态指示）。
   - 新增 `ToolDetailSheet.tsx`（下钻详情原生 BottomSheet）。
   - 改造 `ToolRow.tsx` 为紧凑型条目。
4. **`apps/crish-mobile/src/presentation/timeline/TimelineView.tsx`**：
   - 挂载 `ReasoningExpander` 与 `ProcessGroupCard`。
   - 接入 `useTimelineLiveTail` 视口挂起保护。
   - 恢复 `inlineApproval` 的历史标记渲染。

---

> **结语**：本方案以 Cherry Studio Mobile 顶级的交互分区与流式性能控制为镜像，彻底攻克 Crish Mobile 对话界面中“思考被吃、工具刷屏、点击跳出、大文本卡死”的体验绝症，用极度优雅、轻量的架构为移动端会话注入原生质感与工业级稳定性。
