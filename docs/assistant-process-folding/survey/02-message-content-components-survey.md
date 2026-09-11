# MessageContent 与组件树深度调研报告

> **调研代号**：02-message-content-components-survey  
> **所属战役**：正文交错过程折叠战役（`docs/assistant-process-folding/`）  
> **调查对象**：`apps/crish-desktop/src/components/chat-message/` 核心组件树  
> **输出纪律**：探索类子代理配额红线（单一文档）、UTF-8 无 BOM、严谨行号证据引用  

---

## Executive Summary（调研核心结论与诊断总览）

经过对 Conex/Crish 前端消息渲染中枢 `MessageContent.tsx`、过程折叠控制栏 `TurnProcessNodeView.tsx`、7 布尔量状态机 `turnProcessState.ts` 以及子项渲染器 `ProcessItemRenderer.tsx` 的全链路深度代码审查，我们发现当前组件树存在三大核心架构断层：

1. **顶层全局单体架构倒置**：`TurnProcessNodeView` 原本作为包含折叠栏与 `hidden="until-found"` 槽位的容器组件，在 `MessageContent.tsx:333-343` 中被误置为顶层唯一 Header，且其 `renderChildren` 被硬编码为 `() => null`。真正的过程内容被裸露平铺在外层，使折叠容器沦为“空壳占位符”。
2. **`return null` 暴力剔除破坏浏览器原生穿透**：当折叠收起时（`isProcessExpanded === false`），`MessageContent.tsx:352-354` 采用 `if (item.kind === 'tools' || item.kind === 'thought') return null;` 将 DOM 节点彻底卸载。这导致原本在 `TurnProcessNodeView.tsx:76-81` 精心构建的 HTML5 `hidden="until-found"` 与 `beforematch` 浏览器原生页面内搜索（Ctrl+F）穿透基建彻底失效，并引发高昂的重新挂载开销与虚拟滚动高度抖动。
3. **全轮次单体状态机无法支持交错分段折叠**：`turnProcessState.ts` 的 7 布尔量折叠状态机基于“单一整体过程 + 单一最终定局答案”的宏观假设，未引入 `TimelineSegment`（时间线分段）概念；其推导逻辑甚至将中间过渡正文误判为 `processMember`。这使得一旦存在 `思考1 -> 工具1 -> 中间解释 -> 思考2 -> 工具2 -> 最终总结` 的交错时序时，状态机无法对不同阶段的过程执行独立折叠，且会将中间解释文本一并隐藏。

---

## 一、MessageContent.tsx 深度审查与代码解剖

### 1.1 `linearItems` 数据管线与双重消费机制

#### 数据源构建与缓存
在 `apps/crish-desktop/src/components/chat-message/MessageContent.tsx:144-171` 中，组件通过 `timelineCacheRef` 维持签名缓存，调用微内核门面函数 `buildAssistantTimelineCached` 解析底层消息块：

```tsx
// MessageContent.tsx:156-167
const r = buildAssistantTimelineCached(
  displayMsg,
  cached.sig,
  cached.timeline
);
timelineCacheRef.current = {
  msgId: msg.id,
  sig: r.sig,
  timeline: r.timeline,
};
timeline = r.timeline;
```

随后在 `MessageContent.tsx:187-206` 中计算单轨交错线性时间线 `linearItems`：
- **去重保护**：仅对连续的上下文状态注入（`context_state` 类型的 `injection`）做去重；
- **类型集合**：`linearItems` 严格遵循 `AssistantTimelineItem` 契约（`toolPresentationTypes.ts:55-59`），包含四种原子块：
  1. `thought`（思维链块，包含耗时、实时态、轮次等元数据）；
  2. `tools`（工具调用栈，包含单工具与工具组）；
  3. `text`（正文段落，可能为中间说明或最终结论）；
  4. `injection`（可见上下文注入，如系统状态提醒）。

#### 数据消费路径审查
当前 `linearItems` 在渲染生命周期中被**多处分散消费**：
1. **统计度量消费**（`MessageContent.tsx:311-314`）：
   调用 `countProcessMetrics(linearItems)`，提取出 `toolCount`, `subagentCount`, `thoughtCount`, `durationMs`，用于判定是否存在过程指标（`hasProcessMetrics`）。
2. **顶层 Header 消费**（`MessageContent.tsx:335`）：
   将整个数组透传给 `TurnProcessNodeView`。
3. **主视口平铺映射消费**（`MessageContent.tsx:351-386`）：
   通过扁平的 `.map((item, idx) => ...)` 逐项交由 `ProcessItemRenderer` 渲染。

---

### 1.2 `TurnProcessNodeView` 顶层单体架构根因分析

在 `MessageContent.tsx:324-344` 中，顶层 Header 的放置逻辑如下：

```tsx
// MessageContent.tsx:324-344
{/* 顶层唯一常驻态与全轮次唯一分割线 */}
{isLiveTurn ? (
  <div className={styles.topProcessHeader} data-testid="top-live-header">
    <WorkingStatusIndicator
      startTime={msg.timestamp}
      mode="initial"
    />
  </div>
) : hasProcessMetrics ? (
  <div className={styles.topProcessHeader} data-testid="top-summary-header">
    <TurnProcessNodeView
      msgId={msg.id}
      items={linearItems}
      isTurnLive={false}
      hasFinalAnswer={Boolean(displayMsg.text?.trim() || streamText?.trim())}
      turnStatus={msg.status}
      isExpanded={isProcessExpanded}
      onToggleExpand={() => setIsProcessExpanded((prev) => !prev)}
      renderChildren={() => null}
    />
  </div>
) : null}
```

#### 为什么会演变为顶层全局单体？
1. **历史妥协与结构断层**：
   `TurnProcessNodeView.tsx` 原本设计为一个自洽的受控/非受控卡片容器，拥有自己的 33px 发丝底线控制栏和包裹子节点的 `processHiddenSlot`（`TurnProcessNodeView.tsx:157-163`）。但在实际业务落地中，历史开发者遇到了多段交错文本的排版难题——如果用单一容器包裹全部内容，中间的正文会被迫包在折叠槽内部；如果不包裹，正文又无法与前置过程解耦。
2. **控制权倒置（Control Inversion）与空壳化**：
   开发者最终采取了“只用其表，弃用其实”的粗暴方案：将 `TurnProcessNodeView` 搬到最顶层充当“全局汇总指示器”，并硬编码传入 `renderChildren` 为 `() => null`（`line 341`）。
3. **架构副作用**：
   - `TurnProcessNodeView` 内部为实现 HTML5 `hidden="until-found"` 所封装的 DOM 容器变成了没有任何子节点的空 `<div>`；
   - 整个轮次无论是包含 1 个工具还是 10 个工具、无论是 1 轮思考还是多轮交错，全被顶部这一道单体折叠栏一刀切管控。

---

### 1.3 `isProcessExpanded` 折叠导致所有工具与思考 `return null` 的灾难性后果

审查 `MessageContent.tsx:351-356`：

```tsx
// MessageContent.tsx:351-356
{linearItems.map((item, idx) => {
  if (!isProcessExpanded && (item.kind === 'tools' || item.kind === 'thought')) {
    return null;
  }
  return (
    <React.Fragment key={item.key}>
      <ProcessItemRenderer ... />
```

这是导致整个消息流无法达到高质量生产标准的重大隐患：

```
                    【当前 MessageContent 缺陷拓扑】
┌────────────────────────────────────────────────────────────────┐
│ <div className="topProcessHeader">                            │
│   <TurnProcessNodeView renderChildren={() => null} />          │
│   └── processHiddenSlot [hidden="until-found"] (内容为空!)     │
└────────────────────────────────────────────────────────────────┘
                               │ (isProcessExpanded = false)
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ linearItems.map(...)                                           │
│   ├── thought ──────> [return null] ──> DOM 彻底销毁!          │
│   ├── tools ────────> [return null] ──> DOM 彻底销毁!          │
│   └── text ─────────> <ProcessItemRenderer /> ──> 裸露留在视口 │
└────────────────────────────────────────────────────────────────┘
```

#### 四大灾难性后果详细剖析：

| 维度 | 现实问题与代码断裂证据 | 严重级别 |
| :--- | :--- | :--- |
| **1. 原生搜索穿透彻底死亡** | 浏览器的 Ctrl+F 页面内搜索依赖 DOM 树中实际存在的节点。由于 `thought` 和 `tools` 直接 `return null`，DOM 节点未被挂载，Chromium 内核根本搜不到已折叠的命令输出或思考文本，`TurnProcessNodeView.tsx:87-97` 挂载的原生 `beforematch` 监听器形同虚设。 | **致命 (P0)** |
| **2. 重新挂载性能震荡 (Remount Thrashing)** | 用户每次点击展开/收起，所有的 `MessageToolCallsSection`、`TimelineThoughtSection`、代码差异高亮组件与 Markdown 解析器全量经历卸载（Unmount）与重新挂载（Mount），造成严重的 JS 主线程卡顿和垃圾回收（GC）压力。 | **高危 (P1)** |
| **3. 组件内部瞬态丢失** | 工具调用行内部的交互状态（如单条工具调用的独立展开/收起、Tab 切换状态、复制状态）在整轮折叠又展开后全部被重置为初始状态。 | **高危 (P1)** |
| **4. 虚拟滚动测高剧烈抖动** | 节点的瞬间物理销毁使得宿主容器尺寸断崖式下跌，虽然调用了 `virtualScrollManager.invalidateActual`，但在重新展开时，异步渲染的各子块导致尺寸自愈过程伴随明显的视口跳跃。 | **严重 (P1)** |

---

### 1.4 状态指示器与正文锚定逻辑审查

在流式生成中，`MessageContent.tsx` 依赖一系列一维扫描逻辑来决定各个动态指示器的插槽位置：

#### 倒序扫描索引计算
```tsx
// MessageContent.tsx:209-236
// 定位最后工具块索引
const lastToolIndex = useMemo(() => {
  for (let i = linearItems.length - 1; i >= 0; i--) {
    if (linearItems[i]!.kind === 'tools') return i;
  }
  return -1;
}, [linearItems]);

// 定位最后思考块索引
const lastThoughtIndex = useMemo(() => {
  for (let i = linearItems.length - 1; i >= 0; i--) {
    if (linearItems[i]!.kind === 'thought') return i;
  }
  return -1;
}, [linearItems]);

// 定位可承接流式打字的正文块索引（必须在工具之后）
const streamingTextIndex = useMemo(() => {
  for (let i = linearItems.length - 1; i >= 0; i--) {
    if (linearItems[i]!.kind === 'text') {
      if (lastToolIndex === -1 || i > lastToolIndex) {
        return i;
      }
      break;
    }
  }
  return -1;
}, [linearItems, lastToolIndex]);
```

#### 运行态判定状态机
- `isLiveTurn` (`line 64`): `Boolean(msg.status === 'processing' || isThinkingMsg)`；
- `isInitialWaiting` (`line 80-85`): 流式初建，无思考、无正文、无工具；
- `isThinkingLive` (`line 87-91`): 纯思考进行中，尚无正文；
- `isWorkingAfterThought` (`line 93-97`): `isLiveTurn && !isInitialWaiting && !isThinkingLive`，即思考完毕或工具执行中的“工作中”状态。

#### 物理插槽与漂移脆弱性诊断
1. **顶层 Header 锚定**（`line 324-330`）：
   `isLiveTurn` 时在整个列表最上方渲染 `<WorkingStatusIndicator startTime={msg.timestamp} mode="initial" />`（`正在处理 · 2.4秒`）。
2. **工作中指示器（Working Slot）锚定**：
   - 分支 A（`line 346-350`）：`isWorkingAfterThought && lastThoughtIndex === -1`，在循环体最上方插入指示器；
   - 分支 B（`line 379-383`）：`isWorkingAfterThought && item.kind === 'thought' && idx === lastThoughtIndex`，插入在最后一个思考块的下方。
   - **脆弱性**：当发生“多轮交错”时（例如：思考1 -> 工具1 -> 中间文本 -> 思考2 -> 工具2），若当前正在执行工具2，由于 `lastThoughtIndex` 固定指向思考2，指示器会被错误地插入到思考2下方，而工具2此时正排在更靠后的位置，造成**视觉进行态指示器在工具上方倒流**的严重时序反常！
3. **流式正文渲染双轨漂移**（`line 387-402`）：
   - 当 `streamingTextIndex === -1` 时，在数组末尾兜底挂载一个 `StreamingMarkdownView`；
   - 一旦底层推送了 `text` 类型的 block，`streamingTextIndex !== -1`，流式渲染立刻跳切至 `ProcessItemRenderer` 内部的 `StreamingMarkdownView`（`ProcessItemRenderer.tsx:102-107`），并通过 `msg.streamTextOffset` 复杂的手工切片（`line 370-377`）来规避重复文字；
   - 这种跨层双轨渲染导致首帧流式正文接入时必须依赖 `streamPhaseRef`（`line 179-184`）进行重排补偿，架构极其脆弱。

---

## 二、TurnProcessNodeView 与 7 布尔量折叠状态机缺陷分析

### 2.1 7 布尔量折叠状态机推导逻辑剖析

在 `apps/crish-desktop/src/components/chat-message/turnProcessState.ts:133-194` 中定义的纯逻辑数学状态机，其推导公式如下：

```ts
// turnProcessState.ts:154-184
// 1. 终态判定（非 live，且状态处于完成/停止/错误）
const isTerminal = msgStatus === 'completed' || msgStatus === 'stopped' || msgStatus === 'error';
const processWindowReady = !isTurnLive && isTerminal;

// 2. 过程成员判定（思考、工具、或非定局正文的中间过渡文本）
const processMember =
  processWindowReady &&
  (itemKind === 'thought' || itemKind === 'tools' || (itemKind === 'text' && !isFinalAnswer));

// 3. 最终答案判定
const processAnswer = processWindowReady && itemKind === 'text' && isFinalAnswer;

// 4. 折叠控制所有权
const ownsDisclosure = processWindowReady && (hasToolsOrThinking || toolCount >= 2);

// 5. 纯工具轮次分支
const isToolOnlyTerminal = processWindowReady && !isFinalAnswer && toolCount >= 2;

// 6. 可折叠资格
const foldable =
  processWindowReady &&
  (processMember || ownsDisclosure) &&
  (hasToolsOrThinking || isToolOnlyTerminal);

// 7. 紧凑间距节拍
const compactAnswer = processAnswer && foldable && compactPreference && !userExpanded;

// 8. 节点最终隐藏裁决
const processHidden = foldable && processMember && !userExpanded;
```

### 2.2 无法支持正文交错分段折叠的根本缺陷

#### 缺陷 1：全轮次全称量词（Turn-Level Scope）导致分段盲区
该状态机的所有参数（`isTurnLive`, `msgStatus`, `isFinalAnswer`, `toolCount`）均以整条消息（Message Turn）为作用域，完全没有“段落（Segment）”的概念。它假定一个轮次只有“过程”与“结果”两部分，无法表达：
$$\text{Turn} = \text{Segment}_1(\text{Process}_1 + \text{Text}_1) + \text{Segment}_2(\text{Process}_2 + \text{Text}_2) + \dots$$

#### 缺陷 2：中间过渡文本被粗暴归入 `processMember` 遭误杀
审查 `turnProcessState.ts:161`：
```ts
processMember = processWindowReady && (... || (itemKind === 'text' && !isFinalAnswer));
```
这一逻辑极其危险：它把所有不是最终答案的文本全部当成“过程副产物”！如果完全遵照状态机的 `processHidden` 判定，用户在阅读历史消息时，**AI 在执行各工具步骤之间输出的阶段性解释、确认与过渡文字将全部被折叠消失**。正是因为这一缺陷，`MessageContent.tsx` 才被迫在渲染层打了补丁（仅隐藏 thought 和 tools），导致业务代码与领域状态机彻底背离。

#### 缺陷 3：单一布尔量 `userExpanded` 导致全轮次联动雪崩
当前设计只有一个全轮次的 `isProcessExpanded`。如果用户只想展开某一个具体的长文件读取操作查看详情，点击之后整个轮次之前的所有思考、所有历史工具调用将无差别全部展开，信息瞬间过载。

#### 缺陷 4：缺乏分段进行态与终态迁移能力
当第 1 段（如：代码检索）执行完毕并已输出阶段性分析，AI 正在进行第 2 段（如：代码修改）时，第 1 段在物理上已经完结，本应呈现为收拢的折叠栏。但由于整个 Turn 处于 `isTurnLive = true`，导致全轮次 `processWindowReady = false`，使得已完成的第 1 段也必须一直完全敞开，严重占据屏幕垂直空间。

---

## 三、ProcessItemRenderer.tsx 独立渲染逻辑审查

`apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx` 作为底层单项渲染器，表现出了良好的单一职责性：

```tsx
// ProcessItemRenderer.tsx 核心分支骨架
if (item.kind === 'thought') {
  // 1. 思考渲染（优先使用叙事插槽 renderThought，兜底使用 TimelineThoughtSection）
  return renderThought ? renderThought(...) : <TimelineThoughtSection ... />;
}
if (item.kind === 'text') {
  // 2. 正文渲染（剔除思考占位符、提取 WorkflowConfirm、提取 inlineImages，使用 StreamingMarkdownView）
  return <div className={styles.contentText} data-kind="text">...</div>;
}
if (item.kind === 'tools') {
  // 3. 工具渲染（优先使用叙事插槽 renderTools，兜底使用 MessageToolCallsSection）
  return <div className={styles.toolsTimelineItem} data-kind="tools">...</div>;
}
if (item.kind === 'injection') {
  // 4. 状态注入渲染（ContextStateNotice）
  return <ContextStateNotice injection={item.injection} />;
}
```

### 架构评价与解耦边界
1. **优势**：`ProcessItemRenderer` 的内部渲染干净、内聚，且已对工作流确认（`WorkflowConfirmCard`）、内联图片（`mdImg`）、流式打字优先级（`Priority.Normal` vs `Priority.High`）做好了无缝适配。
2. **问题不在其内部，而在外部调用方式**：
   `MessageContent` 把 `ProcessItemRenderer` 当做一维平铺循环的唯一出口，让本应具有层级包裹关系（Section -> Items）的结构退化为扁平兄弟节点。
3. **重构定位**：
   在后续重构中，**完全保留 `ProcessItemRenderer` 的单项渲染能力**，仅调整其调用宿主——独立正文直接由 `MessageContent` 调用它渲染；而过程项（`thought`, `tools`, `injection`）则放入分段折叠容器 `FoldableProcessSection` 内部调用它渲染。

---

## 四、核心重构蓝图与架构解法

针对战役目标，必须对 `MessageContent` 执行根本性的解耦重构，彻底废除顶层单体 `TurnProcessNodeView`，建立分层清晰的双轨机制：

```
                    【重构后 MessageContent 目标组件树拓扑】
┌─────────────────────────────────────────────────────────────────────────┐
│ <div className="assistantTimelineStream">                              │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ 顶层轻量状态胶囊：TurnStatusCapsule                             │   │
│   │  - 运行态：🟢 正在处理 · 2.4秒                                  │   │
│   │  - 终态：  已处理 3m 9s ⌄ (仅作为耗时展示/全局控制)             │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│   ────────────────────────── 0.5px 发丝横分割线 ───────────────────────   │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ 【分段 1】FoldableProcessSection (按 TimelineSegment 分割)      │   │
│   │   ├── 控制栏：[🔍 已搜索 3 次 · 已读取 5 个文件              ⌄] │   │
│   │   └── processHiddenSlot [hidden="until-found" / 原生穿透]       │   │
│   │         ├── <ProcessItemRenderer item={thought_1} />            │   │
│   │         └── <ProcessItemRenderer item={tools_1} />              │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ 【阶段 1 正文】ProcessItemRenderer (item={text_intermediate})   │   │
│   │   └── <StreamingMarkdownView text="已定位到相关模块，开始修改..." />│   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ 【分段 2】FoldableProcessSection (按 TimelineSegment 分割)      │   │
│   │   ├── 控制栏：[⚡ 已编辑 2 个文件 · 已运行 1 条命令           ⌄] │   │
│   │   └── processHiddenSlot [hidden="until-found" / 原生穿透]       │   │
│   │         ├── <ProcessItemRenderer item={thought_2} />            │   │
│   │         └── <ProcessItemRenderer item={tools_2} />              │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ 【终结论正文】ProcessItemRenderer (item={text_final_summary})   │   │
│   │   └── <StreamingMarkdownView text="所有重构工作已完成，总结如下..." />│   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 4.1 方案 A：顶层轻量状态胶囊（`TurnStatusCapsule`）

#### 职能定义
- 彻底替代原 `MessageContent.tsx:324-344` 中笨重的 `topProcessHeader`；
- 不再作为所有工具折叠的宿主，纯粹承载轮次的**全局状态、生命周期与总耗时度量**。

#### 运行态与终态规范
1. **运行态（Live Processing）**：
   - 展现：翡翠绿脉冲高亮圆点 + 计时器（复用并升级 `WorkingStatusIndicator` 极简视觉）；
   - 文案：`正在处理 · 2.4秒` 或 `深度思考中 · 1.8秒`；
   - 高度：`24px`，无厚重外框，背景透明或极浅胶囊底色。
2. **终态（Completed / Stopped）**：
   - 展现：极简微胶囊与灰色下三角图标；
   - 文案：`已处理 3m 9s ⌄`（或当耗时较短时显示 `已处理 14.2s ⌄`）；
   - 交互：点击可弹出该轮次的全局统计浮层（总 Token 数、总工具调用数、子 Agent 耗时），或作为一键展开全部段落的快捷控制。

---

### 4.2 方案 B：时间线分段状态机（Timeline Segmentation Engine）

#### 数据模型契约
在进入渲染前，将原有的扁平 `linearItems` 切割为结构化的段落数组 `TimelineSegment[]`：

```ts
export type ProcessSectionMetrics = {
  toolCount: number;
  readCount: number;
  searchCount: number;
  editCount: number;
  commandCount: number;
  thoughtCount: number;
  durationMs: number;
};

export type TimelineSegment =
  | {
      kind: 'process_section';
      id: string; // 稳定唯一段落 key，如 `${msgId}-proc-seg-${index}`
      items: AssistantTimelineItem[]; // 仅包含 thought, tools, injection
      metrics: ProcessSectionMetrics;
      isLive: boolean;
    }
  | {
      kind: 'text_narrative';
      id: string;
      item: TimelineTextItem;
      isStreaming: boolean;
      isFinalAnswer: boolean; // 是否是全轮次收官正文
    };
```

#### 分段算法（Pure Segmenter Algorithm）
```ts
export function partitionTimelineSegments(
  items: AssistantTimelineItem[],
  isTurnLive: boolean,
  streamingTextContent?: string
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let currentProcessBuf: AssistantTimelineItem[] = [];
  let segIndex = 0;

  const flushProcessBuf = () => {
    if (currentProcessBuf.length === 0) return;
    const metrics = aggregateSectionMetrics(currentProcessBuf);
    segments.push({
      kind: 'process_section',
      id: `proc-seg-${segIndex++}`,
      items: [...currentProcessBuf],
      metrics,
      isLive: isTurnLive, // 若整轮 live 且为尾部段落，标记为 live
    });
    currentProcessBuf = [];
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'thought' || item.kind === 'tools' || item.kind === 'injection') {
      currentProcessBuf.push(item);
    } else if (item.kind === 'text') {
      flushProcessBuf();
      const isLastText = !items.slice(i + 1).some((it) => it.kind === 'text');
      segments.push({
        kind: 'text_narrative',
        id: item.key || `text-seg-${segIndex++}`,
        item,
        isStreaming: false,
        isFinalAnswer: isLastText && !isTurnLive,
      });
    }
  }
  flushProcessBuf();
  return segments;
}
```

---

### 4.3 方案 C：独立折叠过程容器（`FoldableProcessSection.tsx`）与图五样式对齐

#### 结构与 DOM 真实保留（彻底废除 `return null`）
`FoldableProcessSection` 取代单体 `TurnProcessNodeView`。其内部必须永久挂载子节点，利用原生的 `hidden="until-found"` 保证内容可被全文检索：

```tsx
export const FoldableProcessSection: React.FC<FoldableProcessSectionProps> = ({
  segment,
  msgId,
  isExpanded,
  onToggle,
  renderItem,
}) => {
  const slotRef = useRef<HTMLDivElement>(null);

  // 原生属性与事件绑定，零 React 属性告警
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    if (!isExpanded) {
      el.setAttribute('hidden', 'until-found');
    } else {
      el.removeAttribute('hidden');
    }
  }, [isExpanded]);

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const handleBeforeMatch = () => onToggle(segment.id, true);
    el.addEventListener('beforematch', handleBeforeMatch);
    return () => el.removeEventListener('beforematch', handleBeforeMatch);
  }, [segment.id, onToggle]);

  return (
    <div className={styles.foldableSection} data-segment-id={segment.id}>
      {/* 33px 发丝底线控制栏（图五折叠态样式） */}
      <button
        type="button"
        className={styles.sectionControlBar}
        onClick={() => onToggle(segment.id, !isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={`slot-${segment.id}`}
      >
        <span className={styles.sectionIcon}>
          {/* 主导动作图标：搜索/编辑/运行 */}
          <SectionLeadIcon metrics={segment.metrics} />
        </span>
        <span className={styles.sectionSummaryLabel}>
          {formatSectionSummaryText(segment.metrics)}
        </span>
        <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`} aria-hidden>
          ›
        </span>
      </button>

      {/* 真实 DOM 槽位：折叠时使用 until-found 隐藏，绝不 return null */}
      <div
        ref={slotRef}
        id={`slot-${segment.id}`}
        className={styles.sectionContentSlot}
      >
        {segment.items.map((it) => renderItem(it))}
      </div>
    </div>
  );
};
```

#### 折叠后文案与图标公式（图五标准）
根据段落内部具体的执行操作，生成具有语义感知的细颗粒度统计：
- 若包含搜索：`已搜索 3 次 · 已读取 5 个文件`；
- 若包含文件写入与命令：`已编辑 2 个文件 · 已运行 1 条命令`；
- 若仅有深度思考：`已深度思考 (3.4s)`。

---

### 4.4 终态收敛规则：AI 输出总结后的极致收起与视觉对齐

当 AI 输出最终结论正文（Final Answer / Summary Text）且整轮生命周期走向终态（`status === 'completed'`）时，组件树的收敛保证逻辑如下：

1. **默认折叠矩阵计算（Automatic Convergence Rule）**：
   - 在进入终态瞬间，`MessageContent` 检查各 Segment；
   - 若存在终结论正文（`isFinalAnswer === true`），则**此前所有的 `process_section` 的默认展开状态自动初始化为 `false`**（用户显式手动展开过的除外，记录在 `userOverrideMap` 中）；
   - 所有前置过程段落自动收缩为一条高度 `33px` 的发丝控制栏，内部内容挂载 `hidden="until-found"`；
2. **纯文本问答平滑降级（Zero Process Overhead）**：
   - 若整个轮次无任何思考与工具调用（纯聊天），`segments` 仅包含单一 `text_narrative`；
   - `TurnStatusCapsule` 与发丝分割线不予渲染，直接平铺展示 Markdown 正文，零多余边距与占位；
3. **视觉布局严丝合缝（图五视觉规范）**：
   - 页面从上到下仅呈现：
     1. 顶部：`TurnStatusCapsule`（`已处理 3m 9s ⌄`）；
     2. 发丝横分割线（`0.5px solid var(--border-subtle)`）；
     3. 前置各阶段折叠栏（如用户需要复盘，随时点击展开或搜索唤醒）；
     4. 最终总结结论正文；
4. **虚拟滚动测高自愈（VSM Integration）**：
   - 当从流式进行态切入终态、各过程段落执行折叠时，`FoldableProcessSection` 的 `ResizeObserver` 捕获高度收缩，向宿主发出 `virtualScrollManager.invalidateActual(msgId)`；
   - 虚拟列表的高度树状数组立即收敛为极简高度，滚动条平滑贴合，底部输入框与正文严丝合缝，零视口回弹与跳闪。

---

## 五、受影响文件清单与改动点评估

| 文件相对路径 | 现有职责 | 拟重构改动点 |
| :--- | :--- | :--- |
| `apps/crish-desktop/src/components/chat-message/MessageContent.tsx` | 消息中枢渲染骨架 | 彻底切除顶层 `TurnProcessNodeView`；引入 `TurnStatusCapsule`；引入 `partitionTimelineSegments` 分段引擎；替换平铺 `.map` 为段落渲染；删除 `return null` 逻辑。 |
| `apps/crish-desktop/src/components/chat-message/TurnProcessNodeView.tsx` | 现存顶层单体折叠栏 | 废弃单体模式，解耦/重构为可复用的分段折叠组件 `FoldableProcessSection.tsx`，专门负责单个 Segment 的包裹与 `until-found` 穿透。 |
| `apps/crish-desktop/src/components/chat-message/turnProcessState.ts` | 7 布尔量单体状态机 | 重构为 `sectionFoldingState.ts`，以 Segment 为最小推导单元；修复中间文本被当做 `processMember` 的重大缺陷；支持分段独立受控状态。 |
| `apps/crish-desktop/src/components/chat-message/ProcessItemRenderer.tsx` | 原子级单项渲染器 | 保持其单项渲染职责，作为 `FoldableProcessSection` 内部与根视口的纯净渲染出口，移除无用的 `hasFinalAnswer` 等死参数。 |
| `apps/crish-desktop/src/components/chat-message/MessageContent.module.css` | 样式表 | 增加 `TurnStatusCapsule` 样式、`FoldableProcessSection` 33px 发丝样式与图五细颗粒度统计标签排版。 |

---

## 六、调研结论与建议方案

1. **彻底废除 `return null`** 是保障 HTML5 搜索穿透与虚拟列表稳定的第一要务。必须全面推行 `hidden="until-found"` 原生 DOM 挂载。
2. **顶底职责彻底分离**：顶层只保留全局状态/耗时胶囊（`TurnStatusCapsule`），而过程折叠全面下沉为正文之间的分段容器（`FoldableProcessSection`）。
3. **分段状态机数据驱动**：采用纯函数 `partitionTimelineSegments` 将时间线规范化为明确的“过程段”与“正文段”，根治进行态指示器错位、流式正文跨轨跳动的历史顽疾。
4. 本调研结论与架构方案已全面就绪，为第 2 波方案设计团队（`01-分段状态机与折叠判定详案.md`、`02-图一至图四展开态与图五折叠态UI组件详案.md`）提供了确凿的代码证据与清晰的重构路径。
