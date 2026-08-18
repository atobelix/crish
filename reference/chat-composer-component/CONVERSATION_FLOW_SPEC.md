# Conex 对话流组件规格（Conversation Flow Spec）

> **文档性质**：`reference/chat-composer-component` 的权威设计与实现规格。  
> **用途**：在此 reference 上做完 → 迁回 `apps/crish-desktop`。  
> **关系**：综合 `conversation_flow_design.md`（效果意图，偏旧）、当前 reference 实现、desktop 真实后端模型，以及历史产品反馈的收敛版。  
> **原则**：优雅、简洁、高级；组件化；不照抄竞品截图；不半成品交付。

---

## 0. 文档导航

| 章节 | 内容 |
|------|------|
| 1 | 目标与非目标 |
| 2 | 问题总账（为何「总是做一半」） |
| 3 | 设计哲学与质感基准 |
| 4 | 信息架构：叙事层级（核心） |
| 5 | 数据模型（对齐后端 + 前端编排层） |
| 6 | 组件树与职责边界 |
| 7 | 各组件详细规格 |
| 8 | 视觉系统（字号 / 色阶 / 动效 / 禁令） |
| 9 | 交互规格 |
| 10 | Mock 数据与真实性约束 |
| 11 | 与 desktop 代码映射 |
| 12 | 从 reference → desktop 的迁移计划 |
| 13 | 分期交付定义（Definition of Done） |
| 14 | 开放问题与决策记录 |

---

## 1. 目标与非目标

### 1.1 产品目标

把 AI **后端工具调用流**编排成用户能扫读的**叙事界面**，而不是把原始命令/日志直出到对话流。

用户应一眼看到：

1. AI **在想什么**（思考，可折叠）  
2. AI **为什么做这批动作**（调用目的 / Purpose，可折叠）  
3. AI **具体做了什么**（折叠默认；展开才见命令与结果）  
4. AI **对用户说了什么**（正文，主阅读色）  
5. AI **生成了什么产物**（文档 chip + 悬浮记事本）  
6. AI **派了什么子任务**（Subagent 双行根 + 限高展开）  
7. 需要用户决策的事（权限 / 确认）在 **Composer 上方独立条**，不进对话流

### 1.2 体验目标

| 维度 | 目标 |
|------|------|
| 扫读 | 10 个工具调用折叠成 1～3 个 Purpose 摘要行 |
| 理解 | 摘要是人话（「运行单元测试」），不是 `npm run test:unit` |
| 可查 | 展开后能看到真实命令、输出、路径 |
| 不炸高度 | 思考 / 子 agent / 输出均有 max-height + 上下 fade |
| 精致 | 对话流质感 ≥ Composer 输入区（同一套 surface 语言） |
| 可迁移 | 每个 UI 单元对应清晰组件边界与 props |

### 1.3 非目标（明确不做）

- 不在对话流里做完整 IDE 侧栏  
- 不把代码文件预览做成文档记事本（代码路径 → 右侧 Files 面板 hook）  
- 不做 Markdown「预览 / 源码硬切换」双模式编辑器（见 7.6）  
- 不做侧边 border / 左边轨道时间线（严格禁用）  
- 不做 hover 阴影洗版、重卡片阴影墙  
- 不在每个工具行塞绿勾墙  
- 不虚构后端没有的字段而不标注「前端派生」

---

## 2. 问题总账

### 2.1 历史迭代为何「做一半」

| 根因 | 表现 |
|------|------|
| 文档与 reference 脱节 | `conversation_flow_design.md` 写 desktop 改法，reference 却另起炉灶 |
| 缺单一信息架构 | 一会儿 flat tool row，一会儿 intent，一会儿 group，无统一树 |
| 截图驱动 | 被 Grok/TRAE/Notion/Linear 拉扯，缺少「Conex 自己的树」 |
| Mock 失真 | 出现 `All 142 tests passed` 一行摘要、结果过于整齐 |
| 样式分叉 | 工具行 / 组头 / 审批 / 子 agent 各写一套，字体层级爆炸 |
| 交互越权 | 审批进流、文档 popover 误做代码预览、源码硬切换 |
| 交付无 DoD | 没有「本阶段必须闭环」的清单，容易局部打补丁 |

### 2.2 当前 reference 已有的正确方向

- 过去式摘要（已查看 / 已运行）  
- inspect 组合并（N 步）  
- `tool-presentation.js` 对齐 desktop 标签逻辑  
- Composer 区域（目标条 + 附件 + 输入）质感较好  
- 文档用 chip 而非重卡片的方向正确  

### 2.3 当前 reference 仍失败的点

| 问题 | 用户原话 / 现象 |
|------|----------------|
| 对话流不如输入框精致 | 「下面比上面好看」 |
| 层级不够 | 目的 / 动作 / 输出 / 正文混在同一视觉层 |
| 审批在流里 | 应像目标模式一样贴在对话框上方 |
| Subagent 不像独立根 | 缺缩进、无限高、不像思考折叠 |
| 文档面板交互错误 | 预览/源码硬切换不合适 |
| hover 阴影 | 降低质感，禁用 |
| 字体又大又小 | 最多 2～3 档 |
| 组件化不足 | 逻辑挤在 `stream-renderer.js` 巨石里 |
| Mock 失真 | 结果行过于「产品演示假」 |

### 2.4 `conversation_flow_design.md` 哪些仍有效

**仍有效（效果意图）**

- 正文 primary vs interstitial  
- 思考折叠 + 预览  
- 工具摘要密度 + 可展开  
- group 不能 flatten 丢 label  
- 粘性上下文（长消息）  
- a11y：aria-expanded / 键盘  

**需修正或升级**

| 旧方案 | 新规格 |
|--------|--------|
| 侧边 accent 竖线区分 interstitial | **禁用**侧边 border；用透明度层级 |
| flatten 后补 group | 从数据层保留 Purpose 树，UI 永不 flatten 丢语义 |
| 类型 pill 固定宽 | 弱化 pill，优先 Purpose 人话 |
| 审批在 CompactToolRow 内 | 抽到 Composer 上方 PermissionBar |
| 仅 desktop 文件路径改 | reference 先成为可迁移组件库 |

---

## 3. 设计哲学与质感基准

### 3.1 Conex 调性一句话

> **冷静的叙事工具流**：过程淡、结论实、产物可点、确认独立。  
> 不是终端回放，不是看板，不是 Notion 克隆。

### 3.2 竞品抽象（只借结构，不借皮肤）

| 来源 | 借什么 | 不借什么 |
|------|--------|----------|
| Grok / Manus | 过程 muted、步骤折叠 | 左侧时间线轨道 |
| TRAE | 「已读 N 文件」组摘要 | 过重的路径列表 |
| Notion | 产物卡片的内容密度、圆角图标 | 整页 block 编辑感进对话流 |
| Linear | 字重克制、信息层级少 | 项目管理侧栏 |
| Obsidian | 阅读优先 | 源码/预览硬切换做默认交互 |
| Composer（我们自己） | 圆角 surface、柔和 hairline、chip 质感 | — |

### 3.3 质感对齐 Composer 的检查表

对话流任一新组件上线前自检：

1. 圆角是否与 `--radius-card / container` 同族（圆润，不方块）  
2. 图标是否 Lucide 圆角端点（`stroke-linecap: round`）  
3. hover 是否**仅**改变 opacity / 字色（禁止阴影抬升）  
4. 是否出现侧边 1～2px 装饰线（禁止）  
5. 字号是否只使用规格中的 2～3 档  
6. 正文是否足够「实」（主正文接近纯黑，不是处处 tertiary）  

---

## 4. 信息架构：叙事层级（核心）

### 4.1 五层树（从外到内）

```
SessionTurn (一轮用户→助手)
└── AssistantMessage
    ├── ThinkingNode                    // L0 元过程
    ├── TaskRoot?                       // L0.5 计划/目标任务根（可选）
    │   └── PlanStepNode*               // 计划步骤（可切换）
    │       └── PurposeNode*            // L1 调用目的
    │           ├── ActionRow*          // L2 折叠动作摘要
    │           └── ActionDetail?       // L3 展开：命令/输出
    ├── PurposeNode*                    // 无任务时 Purpose 直接挂消息
    ├── SubagentRoot*                   // L0.5 特殊根：子 agent
    │   ├── Line1 状态
    │   ├── Line2 进度老虎机（1～3 列）
    │   └── ExpandPanel (缩进+限高)      // 内部复用同一套节点组件
    ├── TextNode*                        // L0 正文：primary | interstitial
    ├── ArtifactNode*                   // 生成文档 chip
    └── ComposingHint?                  // 流式尾提示
```

**Composer 区（不在消息树内）**

```
ComposerShell
├── PermissionBar?     // 待确认工具（独立，贴输入框上方）
├── PlanProgressBar?   // 目标/计划模式条（已有）
└── InputShell         // 附件 + 输入 + 操作栏
```

### 4.2 节点语义定义

| 节点 | 用户理解 | 默认态 | 展开后 |
|------|----------|--------|--------|
| **Thinking** | AI 在想 | 一行：思考 · 预览 · 时长 | 限高正文 + 上下 fade |
| **TaskRoot** | 当前在执行哪个任务/计划 | 状态芯片 + 标题 | 步骤列表 |
| **PlanStep** | 计划中的第 N 步 | 编号 + 标题 + 状态 | 该步下的 Purpose 流 |
| **Purpose** | 为什么调用这批工具 | 人话目的 + 老虎机当前动作 | 该目的下全部 Action |
| **Action** | 做了哪一下 | 动词 + 对象（路径/短目标） | 真实命令 + 输出 |
| **SubagentRoot** | 外包给子 agent | 两行 | 限高面板内完整子流 |
| **Text primary** | 对用户说的话 | 始终展开 | — |
| **Text interstitial** | 过渡句 | 始终展开，更淡 | — |
| **Artifact** | 生成了文档 | chip | 悬浮记事本 |
| **Permission** | 要你点头 | **不在流内** | PermissionBar |

### 4.3 「调用目的」模型（Purpose）— 最重要

后端工具调用是「直来直去」的；前端必须按 **Purpose** 重组。

#### 4.3.1 Purpose 的两个字段

```ts
type Purpose = {
  /** 主目的：相对稳定的人话目标 */
  primary: string;
  // 例：「验证各模块单元测试是否通过」

  /** 子目的：同一主目的下的小修正（可选，老虎机滚动） */
  secondary?: string[];
  // 例：['定位失败用例', '重跑单测文件 core-handler.test.ts']
};
```

#### 4.3.2 与工具调用的匹配规则

| 场景 | 行为 |
|------|------|
| 连续多次工具服务**同一**主目的 | 合成 **一个** Purpose 折叠行；内部多 Action；摘要行可用老虎机滚 secondary 或当前 action |
| AI 换目的 | **新开** Purpose 节点 |
| 目的变了但工具没变 / 工具变了目的没变 | 视为编排错误；前端仍按 explanation/purpose 字段展示，并在 dev 警告 |
| 同一命令重试 | 仍归同一 Purpose；Action 可并列「第 2 次」 |

#### 4.3.3 摘要文案规则（禁止技术黑话默认露脸）

| 层级 | 显示 | 不显示（默认） |
|------|------|----------------|
| Purpose 折叠行 | 「运行项目单元测试，验证模块逻辑」 | `npm run test:unit -- --run` |
| Action 折叠行 | 「已运行 · 单元测试」或 secondary | 完整 shell |
| Action 展开 | **真实命令 + 输出** | — |

Shell 人话化优先用 desktop 已有 `humanizeShellCommand` / `toolHumanLabel`。  
`explanation` 若是 spam 模板（「正在运行命令」）→ 丢弃，回退 humanize。

#### 4.3.4 Skill / MCP 前缀

| 类型 | 折叠行前缀 | 点击 |
|------|------------|------|
| 普通工具 | 无 | 展开 Action |
| Skill | `Skill` chip 超链接 | 打开 Skill 说明浮层 |
| MCP | `MCP` chip 超链接 | 打开 MCP 工具说明浮层 |

### 4.4 计划模式三层（用户描述的「三个」）

进入 Plan / Goal 计划模式后，**折叠摘要结构**变为：

```
[PlanStep 切换条]     // ① 标记计划状态 + 切换当前步骤（可吸顶/与 ProgressBar 联动）
  [Purpose 主目的]    // ② 调用目的
    [Action 可选细节] // ③ 更细的动作/子目的（可省略）
```

- ① 由计划清单驱动（AI 生成步骤列表）；步骤编号 **可以** 由 AI 提供，前端也可本地 1..n 生成，以「稳定 stepId」为准。  
- ② ③ 仍按 Purpose 规则。  
- Goal 命令默认带计划模式；计划步骤允许运行中动态增删改。

### 4.5 任务根 vs 自由流

| 模式 | Purpose 挂载点 |
|------|----------------|
| 自由对话 | 直接挂在 AssistantMessage 下 |
| 已启动 Task / PlanStep | Purpose、Thinking、Text 都挂在 **当前 Task/Step** 下 |
| Subagent | 始终是特殊根；若在 Task 内启动，则缩进挂在该 Task 下 |

「启动任务」比「调用目的」更深一层根节点，有独立启动样式（见 7.3）。

### 4.6 折叠不是删除

所有工具调用、命令、输出 **必须可恢复**：

- 默认：只露 Purpose / 组摘要  
- 展开 Purpose：见 Action 列表  
- 展开 Action：见命令与输出  
- 用户永远不应感到「调用消失了」

---

## 5. 数据模型

### 5.1 后端真实源（desktop 已有）

```ts
// 与 layoutStore / 流式协议对齐
type MessageToolCall = {
  id: string;
  name: string;
  arguments: string;          // 多为 JSON 字符串
  status: 'running' | 'success' | 'error' | 'pending_approval';
  output?: string;
  explanation?: string;       // AI 意图；可能 spam
  diffs?: FileDiff[];
  startedAt?: number;
  completedAt?: number;
  turnId?: string;            // 并行组
  // 期望演进（可新增，见 5.3）：
  purposeId?: string;
  purposePrimary?: string;
  purposeSecondary?: string;
};

type SessionMessage = {
  id: string;
  sender: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  toolCalls?: MessageToolCall[];
  blocks?: Array<
    | { type: 'text'; content: string }
    | { type: 'tool_call'; id: string }
    // 演进：purpose / task / subagent 可由前端投影，不必先改协议
  >;
  status?: 'processing' | 'error' | ...;
};
```

### 5.2 前端投影模型（Reference + Desktop 共用概念）

后端协议可以暂时不改；**投影层**把 toolCalls + blocks 编成叙事树：

```ts
type FlowNode =
  | { kind: 'thinking'; id: string; preview: string; content: string; elapsedMs?: number; live?: boolean }
  | { kind: 'text'; id: string; content: string; tone: 'primary' | 'interstitial' }
  | { kind: 'task'; id: string; title: string; status: TaskStatus; steps?: PlanStep[]; children: FlowNode[] }
  | { kind: 'purpose'; id: string; primary: string; secondary?: string[]; status: PurposeStatus; actions: ActionNode[] }
  | { kind: 'subagent'; id: string; name: string; status: SubagentStatus; elapsedMs?: number;
      traces: TraceColumn[]; // 1～3 列老虎机
      children: FlowNode[];  // 与主流同构
    }
  | { kind: 'artifact'; id: string; title: string; mime: 'markdown' | 'text'; content: string }
  | { kind: 'composing'; id: string; text: string };

type ActionNode = {
  id: string;                 // = toolCallId
  toolName: string;
  verb: string;               // 已查看 / 正在运行
  objectLabel: string;        // 人话对象
  path?: string;
  command?: string;           // 仅展开显示
  status: MessageToolCall['status'];
  output?: string;
  diffStat?: { add: number; del: number };
  kind: 'file' | 'shell' | 'search' | 'edit' | 'skill' | 'mcp' | 'other';
  skillId?: string;
  mcpServer?: string;
  startedAt?: number;
  completedAt?: number;
};

type TraceColumn = string[];  // 该列历史帧，老虎机取末帧或滚动
```

### 5.3 Purpose 投影算法（规范）

输入：`MessageToolCall[]`（按时间序）  
输出：`PurposeNode[]`

```
for each tool in order:
  purposeKey = tool.purposeId
            ?? hash(normalizePurpose(tool.purposePrimary || tool.explanation || humanize(tool)))
  if purposeKey != current.purposeKey:
    flush current purpose
    start new purpose with primary = resolvePrimary(tool)
  append ActionNode(tool) to current
  if tool.purposeSecondary: push to secondary roller
flush last
```

`normalizePurpose`：去「正在」、去 spam、截断到 80 字、同义合并。

**并行**：`turnId` + 时间窗内并行的 Action 在 Purpose 内标记 `parallelGroupId`，UI 用轻量「并行 N」而不是粗左边框。

### 5.4 pending_approval 抽取

```
所有 status === 'pending_approval' 的 tool
  → 不进入对话流 Purpose 树（或仅占位「等待确认」极弱一行，默认推荐：完全不进流）
  → 注入 PermissionBar 队列
```

### 5.5 生成文档 vs 源码路径

| 来源 | UI |
|------|-----|
| 系统「生成文档」类工具 / artifact 块（md/txt 报告） | Artifact chip → **Notebook 浮层** |
| read/write/edit 的源码路径 | 路径 chip → `onOpenPath` → **右侧文件面板**（reference 可 toast 模拟） |
| 禁止 | 用 Notebook 预览 `.ts/.rs` 源码当「文档」 |

---

## 6. 组件树与职责边界

### 6.1 Reference 目标目录（组件化）

现状巨石：`js/stream-renderer.js` + 若干 css。  
目标结构（仍可为 vanilla 或逐步 TSX，但**逻辑边界必须拆清**）：

```
reference/chat-composer-component/
├── CONVERSATION_FLOW_SPEC.md          ← 本文档
├── css/
│   ├── design-tokens.css              # 全局 token
│   ├── conversation-tokens.css        # 对话流专用 token
│   ├── composer.css                   # Composer + 页面壳
│   ├── flow/
│   │   ├── flow-base.css              # 消息列、间距、字阶
│   │   ├── thinking.css
│   │   ├── purpose.css
│   │   ├── action.css
│   │   ├── subagent.css
│   │   ├── artifact-notebook.css
│   │   ├── permission-bar.css
│   │   └── motion.css                 # 运行态动效
│   └── ...
├── js/
│   ├── tool-presentation.js           # 纯函数：标签/分组/人话
│   ├── flow-projector.js              # toolCalls → FlowNode[]
│   ├── components/
│   │   ├── ThinkingBlock.js
│   │   ├── PurposeBlock.js
│   │   ├── ActionRow.js
│   │   ├── SubagentRoot.js
│   │   ├── TextBlock.js
│   │   ├── ArtifactChip.js
│   │   ├── NotebookPanel.js
│   │   ├── PermissionBar.js
│   │   ├── TaskRoot.js
│   │   └── FlowMount.js               # 组装
│   ├── demo-data.js                   # 真实感 mock
│   └── markdown-lite.js
└── src/components/ChatComposer/       # 输入区 TSX（已有）
```

### 6.2 Desktop 映射（迁移时）

| Flow 组件 | desktop 落点（建议） |
|-----------|---------------------|
| FlowMount | `MessageContent` + timeline |
| flow-projector | `timelineNormalizer` 升级或旁路 `flowProjector.ts` |
| PurposeBlock | 新 `chat-flow/PurposeBlock.tsx` |
| ActionRow | 重构 `CompactToolRow` / `ToolCallHeader` |
| ThinkingBlock | `MessageThinkingSection` |
| SubagentRoot | 重构 `InlineAgentPanel` 外壳 |
| PermissionBar | 从 row 内 `ApprovalAskCard` 提升到 `ChatCard` / Composer 上方 |
| ArtifactChip + Notebook | 新组件；与 Files 面板分流 |
| tool-presentation | 已有 `toolCardPresenter.ts` |

### 6.3 组件 API 公约

每个展示组件：

- **纯 props 输入** + 少量回调（`onToggle`, `onOpenPath`, `onApprove`）  
- **禁止**组件内直接读全局 DemoData  
- 样式 **只** 用 conversation tokens  
- 可独立 Story/Demo 挂载  

---

## 7. 各组件详细规格

### 7.1 ThinkingBlock

**结构**

```
[chevron] 思考[中] · 2.4s · 预览文本…
└─ (expand) 限高区域 + 上下白底 fade + 可滚动全文
```

**规则**

| 项 | 规格 |
|----|------|
| 默认 | 折叠；live 时可默认展开或保持折（推荐 live 展开预览行 suffices） |
| 预览 | 首行 48～64 字 |
| max-height | 约 160～200px |
| fade | 顶部/底部 `linear-gradient` 遮罩（白底透明度），**不是**边框 |
| 字色 | 辅助层（见 8.2 的 L2） |
| 点击全文 | 可再次点击收起 |

### 7.2 PurposeBlock（调用目的）

**折叠行（默认）**

```
[运行态点|空]  主目的人话文案    [老虎机：当前 secondary 或当前 action]  [›]
```

**展开**

```
主目的（可保持一行）
  ActionRow
  ActionRow
  ...
```

**运行态**

- 左侧 5～6px 圆点 pulse（圆润，非方块）  
- 老虎机列垂直滚动 `cubic-bezier(0.16,1,0.3,1)`  
- 禁止整行 background hover 洗色  

**失败**

- Action 失败：浅色红字/浅标记，**不**用高饱和错误块  
- Purpose 仍可整体 success-with-warnings  

### 7.3 TaskRoot / PlanStep

**启动样式（示意）**

```
◎ 任务已启动 · 重构连接池异步化
```

比 Purpose 更「根」：字重略强、与后续 Purpose 有 8～12px 间距。

**计划步骤条**

- 与现有 `plan-progress-bar` 联动：ProgressBar 管全局；消息内 PlanStep 管「当前焦点步骤」  
- 步骤状态：pending / active / completed / failed(浅)  
- 编号：AI `index` 或本地生成；`stepId` 稳定  

### 7.4 ActionRow

**折叠**

```
[淡标记] 已查看  middleware.ts          [+12 −3?] [›?]
```

- 路径：圆角 chip（对齐 Composer inline tag）  
- 可展开 iff `toolHasExpandableBody`  
- chevron **常显**于可展开行（opacity 0.28 → hover 0.55）  
- 不可展开：无 chevron  

**展开**

```
  圆角浅底块（无侧边线）
  $ 真实命令（若 shell）
  pre 输出（限高 + 上下 fade）
```

**运行态**

- 标记点 pulse  
- 可选右侧 duration 递增（tabular-nums）  

### 7.5 SubagentRoot

**默认仅两行（硬约束）**

```
行1: [›] 子任务 · {name}              [dot] 8s
行2: [列1老虎机] · [列2] · [列3?]     // 全部痕迹可滚，不是只留 2 条静态
```

**展开面板（硬约束）**

- 相对主流 **缩进**（建议 `padding-left: 12～16px` 或整体 `margin-left`）  
- **单面板**包裹所有子内容（思考/Purpose/正文…）  
- **max-height**（建议 240～320px）+ 内部滚动 + 上下 fade  
- 子树 **复用** 与主流完全相同的 Thinking/Purpose/Action/Text 组件  
- 禁止 Subagent 专用「另一套卡片皮肤」  

**痕迹列**

- 1～3 列；第三列可空  
- 每列是该子 agent 工作流的投影帧（工具摘要 / 短状态）  
- 滚动老虎机；最新帧对齐可视窗口  

### 7.6 ArtifactChip + NotebookPanel

**Chip（对话流内）**

```
已生成  [ 重构变更摘要 ]   // 圆角 pill，对齐 Composer 附件 chip 精致度
```

**Notebook（悬浮记事本）**

| 项 | 规格 |
|----|------|
| 触发 | hover chip 显示；点击固定（pin） |
| 位置 | 锚定 chip 附近；拖拽顶栏改位置 |
| 顶栏 | 文档图标 + 标题 + **少按钮**：固定、关闭（不要分享/侧栏/一堆 icon） |
| 顶栏遮罩 | **白色透明度渐变**盖住下方滚动内容，保证图标可读 |
| 内容默认 | **渲染后的阅读态**（表格/标题/列表） |
| 编辑 | **就地可编辑**（contenteditable 或等价），**自动保存**到 docStore |
| 明确不做 | 预览 ↔ 源码 **硬切换** 双模式（用户已否定） |
| 自动保存 | debounce 300～500ms；关面板前 flush |
| 阴影 | 面板本身可用极轻 shadow（实体浮层）；**禁止 hover 阴影动效** |

**精致度**：表格、圆角、图标圆润参考用户 Illustrator 标注图；但是 Conex 色与 Composer 一致，不抄 Notion 全套。

### 7.7 PermissionBar（独立）

**位置**：`composer-wrapper` 内、`plan-progress-bar` 同级或紧贴其下，**输入框上方**。

**形态**：与目标模式条同一设计语言（横条、圆角、轻 border、无粉底警报卡）。

```
[需确认]  扫描下游消费者类型兼容  ·  pnpm exec …    [拒绝] [批准] [始终允许]
```

- 多条 pending：可堆叠高度上限或「还有 N 条」  
- **禁止**再在对话流 Action 里渲染完整审批卡  
- 流内若需暗示：最多一行极淡「等待确认…」可点聚焦到 PermissionBar（可选）

### 7.8 TextBlock

| tone | 用途 | 视觉 |
|------|------|------|
| primary | 对用户结论 | L0 字色，14px，行高 1.65～1.7 |
| interstitial | 工具间过渡 | L1/L2，同 14px 或 13px 二选一（全局只保留一档辅助） |

正文 **整段可用接近纯黑**，不是只有 bold 才黑。

### 7.9 ComposingHint

一行：圆点 pulse + 「正在整理结果…」  
辅助色；不占大卡片。

---

## 8. 视觉系统

### 8.1 字号（最多三档）

| Token | 大小 | 用途 |
|-------|------|------|
| `--flow-font-body` | **14px** | 正文、Purpose 主文案、用户气泡 |
| `--flow-font-meta` | **13px** | 思考/工具/子 agent/审批条 |
| `--flow-font-micro` | **12px** | duration、diff、footer hint |

禁止再出现 11/15/17 混用在对话流里（Notebook 内部可读性可例外 +1 档标题）。

### 8.2 文字色阶（三层，推荐 opacity on near-black）

在浅色背景上用 **同一 `#0a0a0a` + opacity**，比多灰 hex 更稳：

| 层级 | Opacity | 用途 |
|------|---------|------|
| **L0 正文** | 0.92～1.00 | primary 正文、用户气泡 |
| **L1 叙事** | 0.55～0.68 | Purpose 文案、组摘要、路径 |
| **L2 过程** | 0.36～0.48 | 思考、Action、subagent 行2、duration、hint |

Hover：L1→略升到 0.75；L2→0.62。  
**失败**：`color: accent-red` 但 opacity 0.55～0.65（浅，不抢戏）。

### 8.3 间距节奏（消除割裂）

| 区域 | 规格 |
|------|------|
| 消息与消息 | 20～24px |
| Assistant 内部节点 | **统一 8px** gap（禁止 2/4/10/14 乱跳） |
| Purpose 展开后 Action | 2～4px |
| 用户气泡 | 与 Composer 同 border + 轻 shadow 静态值 |

### 8.4 表面

| 元素 | 规格 |
|------|------|
| 页面 | `--bg-page` |
| Composer / 用户气泡 / Notebook | 白 + hairline border + **静态**轻 shadow |
| 展开输出块 | `rgba(0,0,0,0.02)` 圆角 8～10，**无边框线也可** |
| Subagent 展开面板 | 同输出块语言 + 缩进 |

### 8.5 图标

- 统一 **Lucide** 风格圆角 stroke  
- 尺寸：12 / 14  
- 状态：运行用圆点 pulse，成功默认**无图标**或极淡，失败浅 ×  

### 8.6 动效

| 场景 | 动效 |
|------|------|
| 折叠展开 | `grid-template-rows: 0fr → 1fr` 220～280ms spring |
| 运行点 | opacity+scale pulse 1.4s |
| 老虎机 | transform translateY 320ms spring |
| 流式入场 | 仅新节点一次 translateY(3px)+fade，错开 ≤75ms |
| Hover | **仅** opacity/color，**禁止** box-shadow 变化 |

### 8.7 严格禁令清单

1. 侧边 border / 竖轨时间线  
2. Hover 阴影、hover 背景大洗色  
3. 绿勾墙  
4. 对话流内重审批卡  
5. 预览/源码硬切换作为文档默认交互  
6. 字号超过三档  
7. 方块 spinner、方块 status  
8. 英文 `Parallel` 硬编码（用「并行」）  

---

## 9. 交互规格

### 9.1 键盘

| 控件 | 键 |
|------|----|
| 折叠头 | Enter / Space 切换 |
| 展开中 Esc | 收起（可选） |
| Notebook | Esc 关闭（未 pin 或强制） |

### 9.2 文档 Notebook

1. Hover chip → 打开并锚定  
2. 移入面板保持；移出 delay 关闭（未 pin）  
3. Click chip → pin  
4. 拖顶栏 → 改位置，pin 后保持用户坐标  
5. 编辑内容 → autosave  
6. 顶栏渐变保证按钮可读  

### 9.3 路径

- 源码路径 click → `onOpenPath(path)`  
- reference demo 可 `console` / toast：「将在右侧文件面板打开」  

### 9.4 权限

- 批准 / 拒绝 / 始终允许 → 回调；条消失或显示「已批准」短时态  
- 与 desktop `onApprovalAllow/Deny` 对齐  

---

## 10. Mock 数据与真实性约束

### 10.1 禁止的假数据

- `All 142 tests passed` 作为折叠行唯一摘要  
- 每个工具都完美 success、耗时整齐  
- 大段假 artifact 却无失败/重试/pending  

### 10.2 推荐真实感

- 输出截断、中间态 running、一次 grep 无结果再换路径  
- Purpose secondary：「首次路径错误 → 更正后重读」  
- Shell 输出带噪声与耗时不整齐  
- pending_approval 一条进 PermissionBar  

### 10.3 demo-data 结构应表达树

```js
// 推荐 mock 直接给投影后树，或给 toolCalls + purpose 字段
blocks: [
  { type: 'thinking', ... },
  { type: 'purpose', primary: '摸清项目依赖与入口', actions: [ tool, tool ] },
  { type: 'text', tone: 'interstitial', text: '...' },
  { type: 'purpose', primary: '定位连接池阻塞点', actions: [...] },
  { type: 'subagent', name: '...', traces: [[...],[...]], children: [...] },
  { type: 'artifact', title: '重构变更摘要', content: '...' },
  { type: 'text', tone: 'primary', text: '...' },
]
```

Permission 单独：

```js
DemoData.pendingApprovals = [ { id, summary, command, risk } ]
```

---

## 11. 与 desktop 代码映射

### 11.1 现有关键文件

| 能力 | 路径 |
|------|------|
| 时间线 | `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` |
| 人话标签 | `.../toolCardPresenter.ts` |
| 工具行 UI | `components/chat-tool-call/*` + `ChatToolCallBlock.tsx` |
| 思考 | `chat-message-row/MessageThinkingSection.tsx` |
| 正文 | `chat-message/MessageContent.tsx` |
| 审批 | `ApprovalAskCard.tsx`（需上提） |
| 子 agent | `InlineAgentPanel.tsx` |

### 11.2 协议兼容策略

**Phase A（仅前端投影）**  
不改 SSE；用 `explanation` + 相邻工具启发式合成 Purpose。

**Phase B（可选协议增强）**  
工具事件增加 `purpose_id` / `purpose_primary` / `purpose_secondary`，投影更稳。

### 11.3 性能约束（继承 conversation_flow_design）

- 流式热路径不进 immer  
- 展开体按需挂载  
- 输出 DOM 预算与现有 `TOOL_OUTPUT_PIXEL_CAP` 对齐  
- 虚拟列表：节点高度变化要通知 Virtualizer  

---

## 12. Reference → Desktop 迁移计划

### 12.1 Reference 完成标准

1. 组件按 §6.1 拆分，无巨石 renderer  
2. 视觉通过 §8.7 禁令清单  
3. Purpose / Subagent / Permission / Notebook 行为与 §7 一致  
4. Mock 符合 §10  
5. 单一入口 `index.html` 可完整体验一轮真实感对话  

### 12.2 迁入 Desktop 顺序

1. `flowProjector` 纯函数 + 单测（对齐 toolPresentation 测试风格）  
2. PurposeBlock + ActionRow 替换 flatten 工具栈  
3. Thinking 预览与 fade  
4. PermissionBar 上提  
5. SubagentRoot 壳替换 InlineAgent 外框  
6. Artifact + Notebook  
7. Plan/Task 根与 ProgressBar 联动  
8. 删除死代码与旧 group flatten  

### 12.3 回归

- 工具标签单测  
- 时间线交错 blocks  
- 审批回调  
- 流式 running → success 不抖高  
- a11y 抽样  

---

## 13. 分期交付（Definition of Done）

> 每一期必须 **可演示闭环**，禁止只改 CSS 或只改一半交互。

### Phase 0 — 文档与骨架（本文档）

- [x] 规格文档落地  
- [x] 目录骨架 `js/components/*` + `css/flow/*`  
- [x] `flow-projector.js` 接口与实现（`projectPurposes` / `projectMessage` / `projectConversation`）  

### Phase 1 — 叙事树最小闭环

**DoD**

- [x] toolCalls → Purpose[] 投影可用  
- [x] Purpose 折叠/展开 + Action 展开  
- [x] Thinking 预览 + 限高 fade  
- [x] Text primary/interstitial  
- [x] 字号三档、色阶三层、禁侧边线、禁 hover 阴影  
- [x] 对话流间距统一 8px  
- [x] Mock 去掉假「142 passed」摘要行  

### Phase 2 — 独立壳层

**DoD**

- [x] PermissionBar 在 Composer 上，流内无审批卡  
- [x] Subagent 两行 + 缩进限高面板 + 内部复用 Flow 组件  
- [x] 运行态 pulse + 老虎机 traces  
- [x] 失败浅色  

### Phase 3 — 产物与精致度

**DoD**

- [x] Artifact chip 精致（非素链）  
- [x] Notebook：锚定、拖拽、pin、顶栏白渐变、渲染阅读态、就地编辑 autosave  
- [x] **无** 源码硬切换  
- [ ] 对话流视觉与 Composer 对齐评审通过（待产品目视评审）  

### Phase 4 — 计划/任务根

**DoD**

- [ ] TaskRoot 启动样式  
- [ ] PlanStep 与 purpose 三层  
- [ ] 与 plan-progress-bar 状态联动  
- [ ] Skill/MCP 前缀 chip  

### Phase 5 — 迁 desktop

**DoD**

- [ ] 投影层单测  
- [ ] 主路径替换旧 tool stack  
- [ ] 无功能回退；审批/流式/虚拟列表验证  

---

## 14. 开放问题与决策记录

### 14.1 已决

| 议题 | 决策 |
|------|------|
| 侧边轨道 | 禁用 |
| Hover 阴影 | 禁用 |
| 审批位置 | Composer 上方独立条 |
| Subagent | 两行 + 缩进限高面板 + 同构子流 |
| 文档交互 | 阅读态默认 + 就地编辑 autosave；不做源码硬切换 |
| 代码文件 | 右侧面板，不进 Notebook |
| 字号 | 14 / 13 / 12 |
| 目的文案 | 人话优先，命令仅展开 |

### 14.2 待决（实现前拍板）

| 议题 | 选项 | 建议 |
|------|------|------|
| 无 purpose 字段时合并启发式窗口 | 仅 explanation 相同 / 相同 verb+时间窗 | explanation 归一化 + 30s 窗 |
| live thinking 默认展 | 开 / 关 | 关，仅预览行 |
| Purpose 老虎机内容 | secondary / action 标签 | 优先 secondary，无则 action |
| 并行 UI | 文案「并行 N」/ 轻背景 | 文案，无左边框 |
| Notebook 是否允许多实例 | 单例 / 多 | 单例 |

### 14.3 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-08-01 | 首版：综合 conversation_flow_design、reference 现状、历史反馈、desktop 映射与分期 DoD |
| 1.1 | 2026-08-02 | 工具摘要行改为左簇（文案+chevron）；Markdown 块编辑器设计库见 `docs/markdown-editor/`（约 8k 行，CROSSCUTTING 冻结决策） |

---

## 附录 A — 典型一轮 UI 线框（纯文本）

```
用户: 请重构连接池…

助手:
  思考 · 2.4s · 先检查依赖与入口…
  依赖结构清晰，先定位阻塞点。                    ← interstitial

  ▸ 摸清项目依赖与入口                    浏览 src · 查看 2 文件
  ▸ 定位连接池同步阻塞点                  检索 connectionPool · …
  ▸ 将同步 acquire 改为异步队列           修改 core-handler.ts  +87 −34
  ▸ 运行单元测试验证改动                  正在运行 · 3.2s

  已生成  [重构变更摘要]

  重构已完成。P99 约降 38%。结论如下…            ← primary

用户: 检查下游影响

助手:
  思考 · 需要检查所有调用方…
  ▸ 子任务 · 分析下游消费者               8s
     检索调用点 · 读取 batch-worker · 查看 retry…   ← 行2 老虎机
     ┌─ 缩进限高面板（展开后）─────────────┐
     │ 思考 … / Purpose … / 正文 …        │
     └────────────────────────────────────┘

[PermissionBar 贴在输入框上方]
  需确认  扫描下游类型兼容 · pnpm exec …   拒绝  批准  始终允许

[PlanProgressBar]
  目标模式 | 运行单元测试验证 4/5 | 01:02

[Composer 输入区]
```

## 附录 B — 自检清单（每次 PR）

- [ ] 有没有新的字号档？  
- [ ] 有没有侧边 border？  
- [ ] 有没有 hover 阴影？  
- [ ] 审批是否只在 PermissionBar？  
- [ ] Subagent 是否只有两行默认高度 + 展开限高？  
- [ ] 折叠行是否人话、命令是否仅在展开？  
- [ ] Mock 是否像真的 AI 流？  
- [ ] 组件是否可单独引用？  
- [ ] 是否更新了本文档决策表？  

---

**下一步建议**：按 Phase 0→1 开工——先拆组件骨架 + `flow-projector` + Purpose/Action/Thinking 最小闭环，再进入 Permission/Subagent。未完成本期 DoD 前，不开始下一期。
