# Conex Agent Loop 系统性多 Agent 协同修复方案

> 本方案综合 `solution-A-architecture-redesign.md`（架构系统性重构视角）与 `solution-B-engineering-incremental.md`（工程化增量修复视角）两份方案，拟定一个系统性的、自上而下的多 Agent 协同修复框架。
>
> 方案仅包含逻辑执行顺序，不涉及时间安排、人员分配或优先级排序——所有列出的问题优先级相同。每个计划步骤与逻辑相关，且方案具备可复用性，能够适用于多轮次迭代修复场景。每轮次最多部署 12 个 Agent，具体数量根据该轮次的实际需求灵活决定，无需强制占满。
>
> 方案覆盖问题识别、任务分解、Agent 分配、并行修复、结果汇总与验证的完整逻辑链路，确保每轮修复的输出可作为下一轮的输入，形成闭环迭代。
>
> 不使用任何 emoji，所有图示采用 SVG 或纯文本 DAG。

---

## 1. 方案概述

### 1.1 方案目标

消除 conex agent loop 的三类核心症状：
1. AI 一句话即断（toolCount=0 单向终止 + steering 预算耗尽即硬失败）
2. intervention 风暴（maxSteeringMessages=1 + 无软失败中间态）
3. 续轮被架空（跨 run 续轮 + 状态污染 + stalledRounds 恒 0）

这三类症状由 8 条架构层根因（R1-R8）相互放大导致，无法通过单点修补解决，必须系统性重构。

### 1.2 方案原则

| 编号 | 原则 | 对应根因 |
|------|------|----------|
| P1 | 编排层永不单方面终止（仅用户显式行为或 fatal 错误可终止） | R1 / R2 |
| P2 | 工具调用必有回执（tool_use 与 tool_result 显式配对） | R3 / R4 |
| P3 | 续轮在循环内完成（消除跨 run 续轮） | R1 |
| P4 | 错误恢复基于错误类型分级（每种错误独立预算） | R2 / R5 |
| P5 | 解析器自适应响应格式（不依赖请求端点） | R3 |
| P6 | 无法识别的输入必须显式上报（不静默丢弃） | R3 / F2 |
| P7 | 状态单点所有权（ConversationStateStore 集中管理） | R7 |
| P8 | 跨 run 状态显式清理（不依赖消息内容做状态推断） | R7 |
| P9 | 配置与凭证分离（daemon 持久化非凭证配置） | R6 |
| P10 | 错误永不终止循环（工具失败编码而非抛出） | R4 |

### 1.3 闭环迭代框架总览

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 520" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .phase { fill: #e8f4ff; stroke: #1e6091; stroke-width: 1.5; }
      .agent { fill: #eaffea; stroke: #2e7d32; stroke-width: 1.5; }
      .verify { fill: #fff8e0; stroke: #b8860b; stroke-width: 1.5; }
      .io { fill: #f0e8ff; stroke: #6a1b9a; stroke-width: 1.5; }
      .lbl { font-weight: bold; font-size: 12px; }
      .sub { font-size: 10px; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl" font-size="13">单轮迭代闭环（每轮最多 12 Agent）</text>

  <!-- 输入 -->
  <rect x="360" y="40" width="240" height="40" rx="6" class="io"/>
  <text x="480" y="64" text-anchor="middle" class="lbl">[输入] 上一轮代码库 + 验收报告 + 问题清单</text>

  <!-- 阶段 1: 问题识别 -->
  <rect x="40" y="110" width="200" height="60" rx="6" class="phase"/>
  <text x="140" y="132" text-anchor="middle" class="lbl">阶段 1: 问题识别</text>
  <text x="140" y="148" text-anchor="middle" class="sub">Agent: 分析师 (1-2)</text>
  <text x="140" y="162" text-anchor="middle" class="sub">读取上轮残留问题 + 新发现</text>

  <!-- 阶段 2: 任务分解 -->
  <rect x="280" y="110" width="200" height="60" rx="6" class="phase"/>
  <text x="380" y="132" text-anchor="middle" class="lbl">阶段 2: 任务分解</text>
  <text x="380" y="148" text-anchor="middle" class="sub">Agent: 架构师 (1)</text>
  <text x="380" y="162" text-anchor="middle" class="sub">分解为修复单元 + DAG</text>

  <!-- 阶段 3: Agent 分配 -->
  <rect x="520" y="110" width="200" height="60" rx="6" class="phase"/>
  <text x="620" y="132" text-anchor="middle" class="lbl">阶段 3: Agent 分配</text>
  <text x="620" y="148" text-anchor="middle" class="sub">Agent: 调度器 (1)</text>
  <text x="620" y="162" text-anchor="middle" class="sub">按 DAG 分配并行组</text>

  <!-- 阶段 4: 并行修复 -->
  <rect x="760" y="110" width="180" height="60" rx="6" class="phase"/>
  <text x="850" y="132" text-anchor="middle" class="lbl">阶段 4: 并行修复</text>
  <text x="850" y="148" text-anchor="middle" class="sub">Agent: 修复工 (≤8)</text>
  <text x="850" y="162" text-anchor="middle" class="sub">每组并行执行</text>

  <!-- 阶段 5: 结果汇总 -->
  <rect x="280" y="220" width="200" height="60" rx="6" class="phase"/>
  <text x="380" y="242" text-anchor="middle" class="lbl">阶段 5: 结果汇总</text>
  <text x="380" y="258" text-anchor="middle" class="sub">Agent: 合并器 (1)</text>
  <text x="380" y="272" text-anchor="middle" class="sub">合并 PR + 冲突解决</text>

  <!-- 阶段 6: 验证 -->
  <rect x="520" y="220" width="200" height="60" rx="6" class="verify"/>
  <text x="620" y="242" text-anchor="middle" class="lbl">阶段 6: 验证</text>
  <text x="620" y="258" text-anchor="middle" class="sub">Agent: 验证器 (1)</text>
  <text x="620" y="272" text-anchor="middle" class="sub">CI + 契约测试 + 验收</text>

  <!-- 输出 -->
  <rect x="360" y="330" width="240" height="40" rx="6" class="io"/>
  <text x="480" y="354" text-anchor="middle" class="lbl">[输出] 本轮代码库 + 验收报告 + 残留问题</text>

  <!-- 下一轮 -->
  <rect x="360" y="400" width="240" height="40" rx="6" class="io"/>
  <text x="480" y="424" text-anchor="middle" class="lbl">[下一轮输入] 闭环迭代</text>

  <!-- 箭头 -->
  <line x1="480" y1="80" x2="140" y2="110" stroke="#333" marker-end="url(#arr)"/>
  <line x1="240" y1="140" x2="280" y2="140" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="140" x2="520" y2="140" stroke="#333" marker-end="url(#arr)"/>
  <line x1="720" y1="140" x2="760" y2="140" stroke="#333" marker-end="url(#arr)"/>
  <line x1="850" y1="170" x2="380" y2="220" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="250" x2="520" y2="250" stroke="#333" marker-end="url(#arr)"/>
  <line x1="620" y1="280" x2="480" y2="330" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="370" x2="480" y2="400" stroke="#333" marker-end="url(#arr)"/>
  <line x1="480" y1="440" x2="480" y2="470" stroke="#6a1b9a" marker-end="url(#arr)" stroke-dasharray="4,2"/>
  <text x="500" y="465" font-size="10" fill="#6a1b9a">反馈到下一轮阶段 1</text>
</svg>
```

### 1.4 Agent 角色定义

| 角色 | 职责 | 每轮数量 | 产出 |
|------|------|----------|------|
| 分析师 | 读取上轮残留问题 + 扫描代码库识别新问题 | 1-2 | 问题清单（含根因归类） |
| 架构师 | 把问题分解为修复单元，绘制 DAG | 1 | 修复单元清单 + DAG |
| 调度器 | 按 DAG 把修复单元分组为可并行批次 | 1 | Agent 分配方案 |
| 修复工 | 执行具体修复单元（写代码 + 单测） | ≤8 | PR + 单测 |
| 合并器 | 合并 PR，解决冲突，保证语义一致 | 1 | 合并后代码库 |
| 验证器 | 运行 CI + 契约测试 + 手动验收 | 1 | 验收报告 + 残留问题 |

**每轮 Agent 总数上限：12**（1 架构师 + 1 调度器 + ≤8 修复工 + 1 合并器 + 1 验证器）。实际数量根据该轮修复单元数灵活决定。

---

## 2. 输入规范

每轮迭代的输入由三部分组成：

### 2.1 代码库快照

上一轮合并后的代码库状态，作为本轮修复的基线。

### 2.2 上轮验收报告

包含：
- 已通过的验收项清单
- 未通过的验收项清单（含失败原因）
- 新发现的回归问题

### 2.3 问题清单

来源于：
- 5 份初始分析文档（`01` 至 `05`）中尚未修复的问题
- 上轮验收报告中新增的问题
- 代码库扫描发现的新问题

问题清单格式：

```typescript
interface ProblemEntry {
  id: string;                    // 如 "P-01"
  category: 'Provider' | 'Steering' | 'Recovery' | 'Config' | 'Observability' | 'Test';
  description: string;           // 问题描述
  rootCause: string;             // 根因归类（R1-R8）
  sourceFiles: string[];         // 涉及文件绝对路径
  sourceAnalysisDoc?: string;    // 来源分析文档
  status: 'pending' | 'in-progress' | 'fixed' | 'verified';
  dependentOn?: string[];        // 依赖的其他问题 id
}
```

---

## 3. 闭环迭代框架

### 3.1 阶段 1：问题识别

**输入**：上轮代码库 + 上轮验收报告 + 历史问题清单

**执行**：
1. 分析师 Agent 读取上轮验收报告，标记已修复/已验证的问题。
2. 分析师 Agent 扫描代码库，识别新问题（回归或遗漏）。
3. 分析师 Agent 对每个新问题做根因归类（R1-R8）。

**输出**：更新后的完整问题清单（含状态标记）

**Agent 数量**：1-2（视问题复杂度）

### 3.2 阶段 2：任务分解

**输入**：完整问题清单

**执行**：
1. 架构师 Agent 把每个 `pending` 问题分解为一个或多个修复单元（Repair Unit, RU）。
2. 每个 RU 必须是最小可信修复（可独立合并、独立验证、独立回滚）。
3. 架构师 Agent 绘制 DAG，标注 RU 之间的依赖关系。
4. 架构师 Agent 为每个 RU 指定涉及文件、改动点、验证方法。

**输出**：修复单元清单 + DAG

**修复单元格式**：

```typescript
interface RepairUnit {
  id: string;                    // 如 "RU-01"
  problemIds: string[];          // 对应的问题 id
  description: string;           // 问题描述
  rootCause: string;             // 根因（R1-R8）
  files: string[];               // 涉及文件绝对路径
  changePoints: string[];        // 改动点（函数名/行号）
  codeBefore: string;            // 修改前代码
  codeAfter: string;             // 修改后代码
  verification: string;          // 验证方法（测试命令）
  dependencies: string[];        // 依赖的其他 RU id
  riskLevel: 'high' | 'medium' | 'low';
  rollbackPlan: string;          // 回滚方法
}
```

**Agent 数量**：1

### 3.3 阶段 3：Agent 分配

**输入**：修复单元清单 + DAG

**执行**：
1. 调度器 Agent 按 DAG 拓扑排序，把 RU 分组为可并行批次。
2. 同一批次内的 RU 之间无依赖关系，可并行执行。
3. 每个批次分配给一个修复工 Agent。
4. 批次数 ≤ 8（修复工上限）。

**分组算法**：

```
1. 对 DAG 做拓扑排序
2. 按层级分组：第 0 层（无依赖）为第一批，第 1 层为第二批...
3. 若某层 RU 数 > 8，拆分为多个子批（按文件冲突域拆分）
4. 若某层 RU 数 < 8，与下一层无冲突的 RU 合并到同批
5. 输出批次列表
```

**输出**：批次列表（每批含 RU id 列表 + 分配的修复工 Agent id）

**Agent 数量**：1

### 3.4 阶段 4：并行修复

**输入**：批次列表

**执行**：
1. 每个修复工 Agent 读取分配到的 RU 详情。
2. 修复工 Agent 在独立分支上执行修复：
   - 读取涉及文件
   - 按 `codeBefore` / `codeAfter` 执行 Edit
   - 编写单元测试
   - 运行 `pnpm tsc --noEmit` 确保类型正确
3. 修复工 Agent 提交 PR（含代码改动 + 单测 + 回滚 commit 预案）。

**并行约束**：
- 同一批次内的修复工 Agent 并行执行，互不阻塞。
- 不同批次之间串行执行（批次内所有 PR 合并后才开始下一批）。

**输出**：每个修复工 Agent 产出 1 个 PR

**Agent 数量**：≤8（视批次内 RU 数）

### 3.5 阶段 5：结果汇总

**输入**：所有修复工 Agent 的 PR

**执行**：
1. 合并器 Agent 按 DAG 顺序逐个合并 PR。
2. 解决合并冲突（优先保留语义正确的改动）。
3. 若冲突无法自动解决，回退到阶段 2 重新分解冲突的 RU。
4. 合并后运行 `pnpm tsc --noEmit` 确保整体类型正确。

**输出**：合并后的代码库

**Agent 数量**：1

### 3.6 阶段 6：验证

**输入**：合并后的代码库

**执行**：
1. 验证器 Agent 运行全量测试：`pnpm test`。
2. 验证器 Agent 运行类型检查：`pnpm tsc --noEmit`。
3. 验证器 Agent 运行 lint：`pnpm lint`。
4. 验证器 Agent 逐项检查验收清单（Must 项 + Should 项）。
5. 验证器 Agent 记录通过的验收项、未通过的验收项（含失败原因）、新发现的回归。
6. 验证器 Agent 生成验收报告。

**输出**：验收报告 + 残留问题清单

**Agent 数量**：1

### 3.7 轮次交接

**输出 → 下一轮输入**：
- 本轮合并后的代码库 → 下一轮代码库快照
- 本轮验收报告 → 下一轮上轮验收报告
- 本轮残留问题清单 → 下一轮问题清单（与历史未修复问题合并）

**迭代终止判据**：
1. 所有 Must 验收项通过。
2. 所有 Should 验收项通过或显式声明延后。
3. 契约测试套件全部通过。
4. 一轮观察期内无新回归。

---

## 4. 问题清单（合并去重）

从 solution-A 的 7 类 38 个问题与 solution-B 的 6 类 40+ 问题合并去重，得到 8 类根因（R1-R8）下的完整问题清单。

### 4.1 根因 R1：续轮跨 run，状态边界割裂

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R1-01 | 续轮必须跨 run（turn-complete → SHOULD_STOP → run() 退出 → 新 run），状态天然割裂 | `session-loop/index.ts:154-192,538-600` |
| R1-02 | `handlePrepareTurn` steering 扫描整个 conversation，上一 run 错误消息误判 | `session-loop/index.ts:235` |
| R1-03 | `TaskContinuationStrategy.stalledRounds` 恒 0，AI 自然停止一律 continue | `task-continuation-strategy.ts:61-106,108-122` |
| R1-04 | `DEFAULT_TASK_MAX_STALLED_ROUNDS=1000`，task 模式无 stall 检测 | `task-executor.ts:50-57` |

### 4.2 根因 R2：steering 预算与 run 终态耦合，无软失败中间态

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R2-01 | `maxSteeringMessages=1` 默认过严，二次空响应即终止 | `runtime-defaults.ts:61-66` |
| R2-02 | 三处 `maxSteeringMessages` 默认值不一致（1/1/3），无单一权威源 | `recovery-steering-strategy.ts:43`、`steering-coordinator.ts`、`index.ts:493-506` |
| R2-03 | `intervention-required` 被映射为 run 终态失败，无 awaiting-intervention 中间态 | `agent-session.ts:124-127`、`task-assessment.ts:333-340` |
| R2-04 | 全局共享 steering 预算，无错误类型分级 | `recovery-steering-strategy.ts:40-44` |
| R2-05 | `handleSteeringEvaluation` 本地 maxSteering 检查是死代码 | `index.ts:493-506` |

### 4.3 根因 R3：Provider 解析器静默丢弃 + 端点选择与响应格式脱节

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R3-01 | `resolvedEndpoints()` auto 优先 Responses，opencode-go 等代理仅支持 Chat Completions | `provider-openai-class.ts:202-208` |
| R3-02 | `OpenAICompatibleEngine` 有 tools 时强制 Responses 无回退 | `openai-compatible-engine.ts:116-120` |
| R3-03 | 解析器选择依赖"请求端点"而非"响应实际格式" | `provider-openai-class.ts:147-180` |
| R3-04 | `parseChatCompletionsStreamingResponse` function.name 缺失时静默丢弃，无 diagnostic | `provider-openai-chat.ts:109-113` |
| R3-05 | `mergeToolCallDelta` 不兼容 `function_name`/`name` 直接挂 call 的变体 | `provider-openai-chat.ts:116-126` |
| R3-06 | 桌面端 `ProviderProfile` 无 `endpointType` 字段 | `profileCatalog.ts:29-42` |
| R3-07 | `isResponsesEndpointUnavailable` 回退启发式过窄（仅 404/405/415） | `provider-openai-helpers.ts:43-47` |
| R3-08 | 无 `finish_reason` 兜底，模型漏设 tool_calls 时误判停止 | `provider-openai-chat.ts:78-114` |
| R3-09 | `empty-response` 判定过严，无诊断通道说明"为何 blocks 为空" | `provider-response-consumer.ts:125-133` |

### 4.4 根因 R4：工具失败与 run 失败耦合，黑名单式终止

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R4-01 | `findFatalToolError` 黑名单判定，命中即 endReason=error 终止 run | `session-loop/index.ts:522-523` |
| R4-02 | 无 malformed tool result 防御层，MCP 工具污染 session | `runtime-components/tool-executor.ts` |
| R4-03 | `length` 截断 toolCall 残留违反 tool_use/tool_result 配对契约 | `session-loop/index.ts:471-491` |

### 4.5 根因 R5：错误分类粗粒度，恢复决策分散

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R5-01 | 错误分类分散在 3 处（handleStreamError / handleErrorWithHook / detectRecoveryNeedFromMessages） | `index.ts:425-469`、`recovery.ts:27-40`、`recovery-steering-strategy.ts:96-102` |
| R5-02 | 无 `RetryDecision` 分类驱动，无 `retry_only_before_output` | `provider-call.ts` |
| R5-03 | `empty-response` 走 steering 而非重试，污染对话历史 | `session-loop/index.ts:362-373` |
| R5-04 | 无 step 级重复调用检测 | `recovery-steering-strategy.ts` |
| R5-05 | `detectRecoveryNeedFromMessages` 无法识别"AI 文本声称调工具但无 tool_call block" | `runtime-helpers.ts:49-67,98-116` |

### 4.6 根因 R6：Daemon 配置生命周期与 Run 生命周期未解耦

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R6-01 | Daemon 不持久化 Provider 配置，重启即丢失 | `daemon-provider-gateway/index.ts:54-93` |
| R6-02 | `runtimeConfigFromDaemonConfig` 故意返回 {}，非凭证字段也丢失 | `config-assembly.ts:47-51` |
| R6-03 | `runtimeConfigFromRunMetadata` 不读 recovery 参数 | `config-assembly.ts:91-114` |
| R6-04 | `syncActiveProfileToEngine` 异步期间 startRun 拿到空配置 | `profileStore.ts:565-602` |
| R6-05 | Provider 配置分散在多字段，per-request 覆盖需重建实例 | `provider-call-gateway.ts` |

### 4.7 根因 R7：跨 run/turn 状态不清理，依赖消息内容做状态推断

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R7-01 | `detectRecoveryNeedFromMessages` 扫描整个 conversation，跨 run 污染 | `recovery-steering-strategy.ts:96-102` |
| R7-02 | 状态所有权分散（ConversationEngine + ContextManager + ledger + recorder） | `session-loop/index.ts` |
| R7-03 | prune / compaction / request build 分散在多文件 | 多文件 |
| R7-04 | 无显式 repair history 步骤 | `session-loop/index.ts` |
| R7-05 | `handlePrepareTurn` 内 after-tools 与 before-turn 评估重叠 | `session-loop/index.ts:232-242` |

### 4.8 根因 R8：桌面端事件 schema 与 daemon 事件类型无契约校验

| 问题 id | 描述 | 涉及文件 |
|---------|------|----------|
| R8-01 | 桌面端不识别 `runtime-intervention-required` 事件 | `apps/crish-desktop/src/api/**` |
| R8-02 | `provider-diagnostic` 通道未覆盖语义级解析失败 | `provider-response-consumer.ts:75-78` |
| R8-03 | 桌面端事件 schema 与 daemon 事件类型无一致性校验 | `daemonEventZod.ts` |

---

## 5. 修复单元清单（合并两个方案）

将 solution-A 的 11 个迁移阶段与 solution-B 的 25 个修复单元合并，按根因去重对齐，得到统一的修复单元清单。

### 5.1 修复单元总表

| RU id | 根因 | 描述 | solution-A 阶段 | solution-B RU | 风险 |
|-------|------|------|-----------------|---------------|------|
| RU-01 | R3 | 旧路径端点优先级反转（Chat Completions 优先） | 阶段 1 | RU-01 | 高 |
| RU-02 | R3 | 新引擎移除"有 tools 强制 Responses" | 阶段 1 | RU-02 | 高 |
| RU-03 | R3 | 解析器自适应响应格式 | 阶段 1 | RU-03 | 高 |
| RU-04 | R3 | 桌面端 ProviderProfile 增加 endpointType 字段 | 阶段 2 | RU-04 | 低 |
| RU-05 | R3 | daemon 透传 endpointType 字段 | 阶段 2 | RU-05 | 低 |
| RU-06 | R3 | parser 静默丢弃改为 provider-diagnostic | 阶段 1/9 | RU-06 | 中 |
| RU-07 | R3 | mergeToolCallDelta 兼容非标准字段 | 阶段 1 | RU-07 | 低 |
| RU-08 | R3 | finish_reason 兜底为 ToolCalls | 阶段 5 | RU-08 | 低 |
| RU-09 | R2 | 统一 steering 预算单一权威源 | 阶段 4 | RU-09 | 高 |
| RU-10 | R2 | maxSteeringMessages 默认值提升 + 恢复预算 | 阶段 4 | RU-10 | 中 |
| RU-11 | R2 | runtimeConfigFromRunMetadata 支持 recovery 参数 | 阶段 2 | RU-11 | 低 |
| RU-12 | R3 | ProviderResponseConsumer 消费 invalid-tool-call diagnostic | 阶段 9 | RU-12 | 低 |
| RU-13 | R3 | empty-response 分支差异化处理 | 阶段 4 | RU-13 | 中 |
| RU-14 | R2 | intervention-required 重定义为软失败状态 | 阶段 1 | RU-14 | 高 |
| RU-15 | R2 | orchestrator 映射 awaiting-approval | 阶段 1 | RU-15 | 高 |
| RU-16 | R8 | 桌面端识别 runtime-intervention-required 事件 | 阶段 10 | RU-16 | 中 |
| RU-17 | R7 | handlePrepareTurn 拆分 after-tools 与 before-turn | 阶段 3 | RU-17 | 中 |
| RU-18 | R7 | 跨 run 状态清理（仅扫描本轮 run 消息） | 阶段 3 | RU-18 | 中 |
| RU-19 | R6 | daemon 持久化非凭证 Provider 配置 | 阶段 2 | RU-19 | 中 |
| RU-20 | R6 | 桌面端 syncActiveProfileToEngine 等待 gateway ready | 阶段 2 | RU-20 | 低 |
| RU-21 | R1 | TaskContinuationStrategy 引入 stall 检测 | 阶段 3/6 | RU-21 | 中 |
| RU-22 | R4 | 工具失败编码而非终止（移除 findFatalToolError 黑名单） | 阶段 5 | RU-22 | 高 |
| RU-23 | R4 | malformed tool result 防御层（coerceToolResult） | 阶段 5 | RU-23 | 低 |
| RU-24 | R4 | length 截断 toolCall placeholder | 阶段 5 | RU-24 | 中 |
| RU-25 | 全部 | 契约测试覆盖所有故障路径 | 阶段 11 | RU-25 | 低 |
| RU-26 | R1 | 循环内续轮（StopGate + ContinuationGate） | 阶段 3/6 | 延后项 | 高 |
| RU-27 | R5 | ErrorRecoveryClassifier 单一真理源 | 阶段 4/8 | 延后项 | 高 |
| RU-28 | R5 | RetryDecision 分类驱动 + retry_only_before_output | 阶段 8 | 延后项 | 中 |
| RU-29 | R7 | ConversationStateStore 状态单点所有权 | 阶段 7 | 延后项 | 高 |
| RU-30 | R5 | SamplerConfig 单一配置对象 + per-request override | 阶段 8 | 延后项 | 中 |

**说明**：RU-01 至 RU-25 为首轮必须完成的修复单元（来自 solution-B 的 P0-P3）。RU-26 至 RU-30 为 solution-A 架构层重构的延后项，在首轮完成后评估是否纳入后续轮次。

### 5.2 修复单元 DAG

```
阶段 0（可并行，无依赖）：
    RU-01, RU-02, RU-03, RU-06, RU-07, RU-08, RU-19

阶段 1（可并行，无依赖）：
    RU-09, RU-14, RU-18

阶段 2（依赖阶段 0/1）：
    RU-04 --> RU-05
    RU-12（依赖 RU-06）
    RU-13（依赖 RU-06, RU-09, RU-12）
    RU-10（依赖 RU-09）
    RU-11（依赖 RU-09）
    RU-17（依赖 RU-09）
    RU-20（依赖 RU-19）
    RU-23
    RU-24

阶段 3（依赖阶段 1）：
    RU-15（依赖 RU-14）
    RU-16（依赖 RU-14, RU-15）

阶段 4（依赖阶段 1/2）：
    RU-21
    RU-22

阶段 5（依赖所有）：
    RU-25
```

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 620" font-family="sans-serif" font-size="10">
  <defs>
    <marker id="arr2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .s0 { fill: #ffe0e0; stroke: #b22222; }
      .s1 { fill: #fff8e0; stroke: #b8860b; }
      .s2 { fill: #e8f4ff; stroke: #1e6091; }
      .s3 { fill: #eaffea; stroke: #2e7d32; }
      .s4 { fill: #f0e8ff; stroke: #6a1b9a; }
      .s5 { fill: #f5f5f5; stroke: #666; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <text x="480" y="18" text-anchor="middle" class="lbl" font-size="12">修复单元 DAG（6 阶段）</text>

  <!-- 阶段 0 -->
  <rect x="20" y="40" width="120" height="30" rx="4" class="s0"/>
  <text x="80" y="58" text-anchor="middle">RU-01</text>
  <rect x="150" y="40" width="120" height="30" rx="4" class="s0"/>
  <text x="210" y="58" text-anchor="middle">RU-02</text>
  <rect x="280" y="40" width="120" height="30" rx="4" class="s0"/>
  <text x="340" y="58" text-anchor="middle">RU-03</text>
  <rect x="410" y="40" width="120" height="30" rx="4" class="s0"/>
  <text x="470" y="58" text-anchor="middle">RU-06</text>
  <rect x="540" y="40" width="120" height="30" rx="4" class="s0"/>
  <text x="600" y="58" text-anchor="middle">RU-07</text>
  <rect x="670" y="40" width="120" height="30" rx="4" class="s0"/>
  <text x="730" y="58" text-anchor="middle">RU-08</text>
  <rect x="800" y="40" width="140" height="30" rx="4" class="s0"/>
  <text x="870" y="58" text-anchor="middle">RU-19</text>
  <text x="480" y="88" text-anchor="middle" class="lbl" font-size="11">阶段 0: Provider 解析 + daemon 持久化（7 RU, 7 Agent）</text>

  <!-- 阶段 1 -->
  <rect x="200" y="110" width="120" height="30" rx="4" class="s1"/>
  <text x="260" y="128" text-anchor="middle">RU-09</text>
  <rect x="420" y="110" width="120" height="30" rx="4" class="s1"/>
  <text x="480" y="128" text-anchor="middle">RU-14</text>
  <rect x="640" y="110" width="120" height="30" rx="4" class="s1"/>
  <text x="700" y="128" text-anchor="middle">RU-18</text>
  <text x="480" y="158" text-anchor="middle" class="lbl" font-size="11">阶段 1: steering 统一 + intervention 软失败 + 跨 run 清理（3 RU, 3 Agent）</text>

  <!-- 阶段 2 -->
  <rect x="20" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="70" y="198" text-anchor="middle">RU-04</text>
  <rect x="130" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="180" y="198" text-anchor="middle">RU-05</text>
  <rect x="240" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="290" y="198" text-anchor="middle">RU-12</text>
  <rect x="350" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="400" y="198" text-anchor="middle">RU-13</text>
  <rect x="460" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="510" y="198" text-anchor="middle">RU-10</text>
  <rect x="570" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="620" y="198" text-anchor="middle">RU-11</text>
  <rect x="680" y="180" width="100" height="30" rx="4" class="s2"/>
  <text x="730" y="198" text-anchor="middle">RU-17</text>
  <rect x="20" y="220" width="100" height="30" rx="4" class="s2"/>
  <text x="70" y="238" text-anchor="middle">RU-20</text>
  <rect x="130" y="220" width="100" height="30" rx="4" class="s2"/>
  <text x="180" y="238" text-anchor="middle">RU-23</text>
  <rect x="240" y="220" width="100" height="30" rx="4" class="s2"/>
  <text x="290" y="238" text-anchor="middle">RU-24</text>
  <text x="480" y="268" text-anchor="middle" class="lbl" font-size="11">阶段 2: 链路完善 + 配置传递 + 工具防御（10 RU, 8 Agent 分 2 批）</text>

  <!-- 阶段 3 -->
  <rect x="320" y="290" width="120" height="30" rx="4" class="s3"/>
  <text x="380" y="308" text-anchor="middle">RU-15</text>
  <rect x="520" y="290" width="120" height="30" rx="4" class="s3"/>
  <text x="580" y="308" text-anchor="middle">RU-16</text>
  <text x="480" y="338" text-anchor="middle" class="lbl" font-size="11">阶段 3: orchestrator + 桌面端联动（2 RU, 2 Agent）</text>

  <!-- 阶段 4 -->
  <rect x="320" y="360" width="120" height="30" rx="4" class="s4"/>
  <text x="380" y="378" text-anchor="middle">RU-21</text>
  <rect x="520" y="360" width="120" height="30" rx="4" class="s4"/>
  <text x="580" y="378" text-anchor="middle">RU-22</text>
  <text x="480" y="408" text-anchor="middle" class="lbl" font-size="11">阶段 4: 续轮 + 工具失败编码（2 RU, 2 Agent）</text>

  <!-- 阶段 5 -->
  <rect x="380" y="430" width="200" height="30" rx="4" class="s5"/>
  <text x="480" y="448" text-anchor="middle">RU-25</text>
  <text x="480" y="478" text-anchor="middle" class="lbl" font-size="11">阶段 5: 契约测试全覆盖（1 RU, 1 Agent）</text>

  <!-- 关键依赖箭头 -->
  <line x1="470" y1="70" x2="290" y2="180" stroke="#333" marker-end="url(#arr2)" stroke-dasharray="3,2"/>
  <line x1="260" y1="140" x2="510" y2="180" stroke="#333" marker-end="url(#arr2)" stroke-dasharray="3,2"/>
  <line x1="480" y1="140" x2="380" y2="290" stroke="#333" marker-end="url(#arr2)" stroke-dasharray="3,2"/>
  <line x1="380" y1="320" x2="580" y2="290" stroke="#333" marker-end="url(#arr2)" stroke-dasharray="3,2"/>

  <text x="480" y="560" text-anchor="middle" font-size="10" fill="#666">虚线表示关键依赖路径；同阶段内 RU 可并行</text>
</svg>
```

---

## 6. 多轮迭代规划

### 6.1 第 1 轮：根因解耦（阶段 0 + 阶段 1）

**目标**：解决 provider 工具调用丢失（阶段 0）与 steering/intervention 系统性缺陷（阶段 1）。

**输入**：
- 代码库快照（当前 main 分支）
- 5 份分析文档的问题清单
- 无上轮验收报告（首轮）

**Agent 部署**：

| 阶段 | Agent 角色 | 数量 | 执行的 RU |
|------|-----------|------|-----------|
| 1 问题识别 | 分析师 | 1 | 读取 5 份分析文档，标记 R1-R8 根因下的问题 |
| 2 任务分解 | 架构师 | 1 | 确认 RU-01~RU-03, RU-06~RU-08, RU-09, RU-14, RU-18, RU-19 的分解 |
| 3 Agent 分配 | 调度器 | 1 | 分两个并行批次：批次 A（阶段 0 的 7 RU）+ 批次 B（阶段 1 的 3 RU） |
| 4 并行修复 | 修复工 | 8 | 批次 A：7 个修复工各执 1 RU；批次 B：1 个修复工串行 3 RU（因阶段 1 有依赖） |
| 5 结果汇总 | 合并器 | 1 | 合并 10 个 PR |
| 6 验证 | 验证器 | 1 | CI + 契约测试 M-01~M-03, M-05~M-07 |

**总 Agent 数**：1+1+1+8+1+1 = 13 → 需优化为 ≤12

**优化策略**：批次 A 与批次 B 串行执行（阶段 1 依赖阶段 0 的 RU-06），因此修复工峰值 = 7（批次 A）→ 合并 → 3（批次 B），修复工总数 ≤8 满足。

**实际部署**：1 架构师 + 1 调度器 + 8 修复工 + 1 合并器 + 1 验证器 = 12

**验收标准**：
- M-01: opencode-go profile 工具调用正常解析
- M-02: parser 不再静默丢弃 tool_call
- M-03: intervention 不再立即终止 run
- M-05: daemon 重启后 provider 立即可用
- M-06: 跨 run 状态不污染
- M-07: steering 预算单一权威源

**输出**：合并后代码库 + 验收报告 + 残留问题（阶段 2-5 的 RU）

### 6.2 第 2 轮：链路完善与联动（阶段 2 + 阶段 3）

**目标**：完善 parser 消费链路、配置传递、steering 评估拆分、桌面端联动、工具结果防御。

**输入**：
- 第 1 轮合并后代码库
- 第 1 轮验收报告
- 残留问题清单（阶段 2-5 的 RU）

**Agent 部署**：

| 阶段 | Agent 角色 | 数量 | 执行的 RU |
|------|-----------|------|-----------|
| 1 问题识别 | 分析师 | 1 | 读取第 1 轮验收报告，确认无新回归 |
| 2 任务分解 | 架构师 | 1 | 确认 RU-04, RU-05, RU-10~RU-13, RU-15~RU-17, RU-20, RU-23, RU-24 的分解 |
| 3 Agent 分配 | 调度器 | 1 | 分两个并行批次：批次 A（阶段 2 的 10 RU）+ 批次 B（阶段 3 的 2 RU，依赖批次 A） |
| 4 并行修复 | 修复工 | 8 | 批次 A：8 个修复工分 2 轮执行 10 RU；批次 B：2 个修复工执行 2 RU |
| 5 结果汇总 | 合并器 | 1 | 合并 12 个 PR |
| 6 验证 | 验证器 | 1 | CI + 契约测试 M-04, M-08, S-01, S-03, S-05 |

**总 Agent 数**：1+1+1+8+1+1 = 12

**验收标准**：
- M-04: 用户可选择 intervention 响应
- M-08: run-metadata 可覆盖 recovery 配置
- S-01: length 截断 toolCall placeholder
- S-03: malformed tool result 防御
- S-05: 非标准 tool_call 字段兼容

**输出**：合并后代码库 + 验收报告 + 残留问题（阶段 4-5 的 RU）

### 6.3 第 3 轮：续轮与恢复机制完善（阶段 4）

**目标**：task stall 检测、工具失败编码而非终止。

**输入**：
- 第 2 轮合并后代码库
- 第 2 轮验收报告
- 残留问题清单（阶段 4-5 的 RU）

**Agent 部署**：

| 阶段 | Agent 角色 | 数量 | 执行的 RU |
|------|-----------|------|-----------|
| 1 问题识别 | 分析师 | 1 | 读取第 2 轮验收报告 |
| 2 任务分解 | 架构师 | 1 | 确认 RU-21, RU-22 的分解 |
| 3 Agent 分配 | 调度器 | 1 | 单批次 2 RU 并行 |
| 4 并行修复 | 修复工 | 2 | 各执 1 RU |
| 5 结果汇总 | 合并器 | 1 | 合并 2 个 PR |
| 6 验证 | 验证器 | 1 | CI + 契约测试 M-09, S-02 |

**总 Agent 数**：1+1+1+2+1+1 = 7（未占满 12，按需部署）

**验收标准**：
- M-09: 工具失败不立即终止 run
- S-02: task 模式 stall 检测

**输出**：合并后代码库 + 验收报告 + 残留问题（阶段 5 的 RU）

### 6.4 第 4 轮：契约测试全覆盖（阶段 5）

**目标**：补齐所有故障路径的契约测试。

**输入**：
- 第 3 轮合并后代码库
- 第 3 轮验收报告
- 残留问题清单（阶段 5 的 RU-25）

**Agent 部署**：

| 阶段 | Agent 角色 | 数量 | 执行的 RU |
|------|-----------|------|-----------|
| 1 问题识别 | 分析师 | 1 | 读取第 3 轮验收报告 |
| 2 任务分解 | 架构师 | 1 | 确认 RU-25 的 14 类契约测试用例 |
| 3 Agent 分配 | 调度器 | 1 | 按 4 个测试文件分组：state-machine / stream-parser / orchestrator / server |
| 4 并行修复 | 修复工 | 4 | 各执 1 个测试文件的用例编写 |
| 5 结果汇总 | 合并器 | 1 | 合并 4 个测试 PR |
| 6 验证 | 验证器 | 1 | `pnpm test` 全量通过 |

**总 Agent 数**：1+1+1+4+1+1 = 9（未占满 12，按需部署）

**验收标准**：
- M-10: 契约测试全部通过

**输出**：合并后代码库 + 完整验收报告

### 6.5 第 5 轮（可选）：架构层重构延后项

**目标**：评估并执行 RU-26 至 RU-30（循环内续轮 / ErrorRecoveryClassifier / ConversationStateStore 等）。

**前置条件**：第 4 轮验收全部通过，且实际测试中发现 RU-26~RU-30 对应的架构缺陷仍然存在。

**Agent 部署**：根据实际需要灵活决定，上限 12。

---

## 7. 验收矩阵

### 7.1 Must 验收项

| 编号 | 验收项 | 对应 RU | 验证轮次 |
|------|--------|---------|----------|
| M-01 | opencode-go profile 工具调用正常解析 | RU-01~RU-03 | 第 1 轮 |
| M-02 | parser 不再静默丢弃 tool_call | RU-06 | 第 1 轮 |
| M-03 | intervention 不再立即终止 run | RU-14 | 第 1 轮 |
| M-04 | 用户可选择 intervention 响应 | RU-16 | 第 2 轮 |
| M-05 | daemon 重启后 provider 立即可用 | RU-19 | 第 1 轮 |
| M-06 | 跨 run 状态不污染 | RU-18 | 第 1 轮 |
| M-07 | steering 预算单一权威源 | RU-09 | 第 1 轮 |
| M-08 | run-metadata 可覆盖 recovery 配置 | RU-11 | 第 2 轮 |
| M-09 | 工具失败不立即终止 run | RU-22 | 第 3 轮 |
| M-10 | 契约测试全部通过 | RU-25 | 第 4 轮 |

### 7.2 Should 验收项

| 编号 | 验收项 | 对应 RU | 验证轮次 |
|------|--------|---------|----------|
| S-01 | length 截断 toolCall placeholder | RU-24 | 第 2 轮 |
| S-02 | task 模式 stall 检测 | RU-21 | 第 3 轮 |
| S-03 | malformed tool result 防御 | RU-23 | 第 2 轮 |
| S-04 | finish_reason 兜底 | RU-08 | 第 1 轮 |
| S-05 | 非标准 tool_call 字段兼容 | RU-07 | 第 1 轮 |

### 7.3 量化指标

| 指标 | 当前 | 目标 |
|------|------|------|
| 单轮即断发生率 | 高（默认行为） | < 1% |
| runtime-intervention-required 频率 | 频繁（二次空响应即触发） | 罕见（三次 steering 耗尽才触发） |
| daemon 重启后 run 启动成功率 | 低（依赖桌面端推送时序） | 100% |
| 工具调用丢失率（opencode-go） | 100%（端点选择错误） | 0% |
| 跨 run 状态污染误触发率 | 高 | 0% |
| 工具失败导致 run 终态失败率 | 高 | 0% |
| 桌面端 intervention 事件识别率 | 0% | 100% |

---

## 8. 轮次间交接契约

### 8.1 交接物格式

每轮结束时，验证器 Agent 必须产出以下交接物：

```typescript
interface RoundHandoff {
  roundNumber: number;
  codebaseCommit: string;           // 合并后的 commit hash
  verificationReport: {
    mustPassed: string[];            // 通过的 Must 验收项 id
    mustFailed: string[];            // 未通过的 Must 验收项 id（含失败原因）
    shouldPassed: string[];
    shouldFailed: string[];
    newRegressions: string[];        // 新发现的回归问题
  };
  residualProblems: ProblemEntry[];  // 残留问题清单
  residualRepairUnits: RepairUnit[]; // 残留修复单元清单
  nextRoundSuggestion: {
    recommendedRUs: string[];        // 建议下一轮执行的 RU id
    estimatedAgents: number;         // 预估下一轮所需 Agent 数
  };
}
```

### 8.2 反馈机制

若某轮迭代中验收失败：
1. 立即停止后续 RU 的合并。
2. 对失败的 RU 进行根因分析，更新本方案文档（新增 RU 或修订现有 RU）。
3. 重新进入"修复 → 验证"循环，直至验收通过。
4. 验收通过后再进入下一轮迭代。

若某轮迭代中发现新的故障路径（未在问题清单中列出）：
1. 在"问题清单"中新增条目。
2. 设计对应的 RU（编号续接，如 RU-31、RU-32...）。
3. 评估新 RU 的依赖关系，插入到 DAG 的合适位置。
4. 重新评估关键路径与验收标准。

---

## 9. 方案可复用性说明

本方案设计为可复用的多轮迭代修复框架，适用于：

1. **conex agent loop 后续迭代**：第 5 轮及以后若发现新问题，可直接套用"阶段 1-6"闭环。
2. **其他系统的系统性修复**：把"问题清单"和"修复单元清单"替换为目标系统的问题与修复单元，框架不变。
3. **架构演进**：RU-26~RU-30 的架构层重构可在首轮完成后，按本框架逐步推进。

每轮迭代的 Agent 数量上限为 12，实际数量根据该轮修复单元数灵活决定，无需强制占满。这保证了：
- 简单轮次（如第 3 轮仅 2 RU）不浪费 Agent 资源。
- 复杂轮次（如第 1 轮 10 RU）可充分利用并行能力。

---

## 10. 附录

### 10.1 三条核心根因的解耦映射

| 核心根因 | 解耦 RU | 验收项 |
|----------|---------|--------|
| 根因 A：steering 预算与 run 终态耦合 | RU-09（统一预算源）+ RU-14（awaiting-intervention 软失败） | M-03, M-07 |
| 根因 B：Provider parser 静默丢弃工具调用 | RU-01（端点优先级反转）+ RU-02（移除 tools 强制 Responses）+ RU-03（自适应解析器）+ RU-06（diagnostic 上报） | M-01, M-02 |
| 根因 C：Daemon 配置生命周期与 Run 生命周期未解耦 | RU-19（持久化非凭证配置） | M-05 |

### 10.2 关键文件索引

| 修复单元 | 文件绝对路径 |
|----------|--------------|
| RU-01 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-class.ts` |
| RU-02 | `c:\Software\conex\packages\agent-runtime\src\provider\engines\openai-compatible-engine.ts` |
| RU-03 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-class.ts`（新增 `provider-openai-adaptive-stream.ts`） |
| RU-04 | `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileCatalog.ts` |
| RU-05 | `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileStore.ts` |
| RU-06~RU-08 | `c:\Software\conex\packages\agent-runtime\src\provider-openai-chat.ts` |
| RU-09~RU-10 | `c:\Software\conex\packages\agent-runtime\src\steering\recovery-steering-strategy.ts`、`steering-coordinator.ts` |
| RU-11 | `c:\Software\conex\packages\agent-daemon\src\server-runtime-factory\config-assembly.ts` |
| RU-12 | `c:\Software\conex\packages\agent-runtime\src\runtime-components\provider-response-consumer.ts` |
| RU-13, RU-17, RU-18, RU-22, RU-24 | `c:\Software\conex\packages\agent-runtime\src\session-loop\index.ts` |
| RU-14 | `c:\Software\conex\packages\agent-runtime\src\state-machine\agent-session.ts` |
| RU-15 | `c:\Software\conex\packages\agent-orchestrator\src\orchestrator\dispatcher\task-executor.ts`、`task-assessment.ts` |
| RU-16 | `c:\Software\conex\apps\crish-desktop\src\api\daemonEventZod.ts`、`runControlClient.ts` |
| RU-19 | `c:\Software\conex\packages\agent-daemon\src\daemon-provider-gateway\index.ts` |
| RU-20 | `c:\Software\conex\apps\crish-desktop\src\api\provider-profiles\profileStore.ts` |
| RU-21 | `c:\Software\conex\packages\agent-orchestrator\src\task-continuation-strategy.ts` |
| RU-23 | `c:\Software\conex\packages\agent-runtime\src\runtime-components\tool-executor.ts` |
| RU-25 | 4 个测试文件 |

### 10.3 参考文档

- `c:\Software\conex\docs\analysis\agent-loop\01-conex-current-issues.md`
- `c:\Software\conex\docs\analysis\agent-loop\02-pi-agent-loop-analysis.md`
- `c:\Software\conex\docs\analysis\agent-loop\03-grok-build-agent-loop-analysis.md`
- `c:\Software\conex\docs\analysis\agent-loop\04-tool-call-chain-analysis.md`
- `c:\Software\conex\docs\analysis\agent-loop\05-recovery-continuation-analysis.md`
- `c:\Software\conex\docs\analysis\agent-loop\solution-A-architecture-redesign.md`
- `c:\Software\conex\docs\analysis\agent-loop\solution-B-engineering-incremental.md`

---

## 11. 结论

本方案综合架构系统性重构（solution-A）与工程化增量修复（solution-B）两个视角，拟定了一个系统性的、自上而下的多 Agent 协同修复框架。

框架的核心设计：
1. **闭环迭代**：每轮覆盖"问题识别 → 任务分解 → Agent 分配 → 并行修复 → 结果汇总 → 验证"完整逻辑链路，输出作为下一轮输入。
2. **Agent 上限 12**：1 架构师 + 1 调度器 + ≤8 修复工 + 1 合并器 + 1 验证器，按需灵活部署。
3. **DAG 驱动**：修复单元按依赖关系分组并行，禁止跳跃依赖。
4. **可复用**：框架本身与具体问题解耦，适用于多轮迭代修复场景。
5. **优先级相同**：所有列出的问题优先级相同，按 DAG 逻辑顺序推进，不做优先级排序。

4 轮迭代覆盖 25 个修复单元（RU-01~RU-25），解耦 8 条架构层根因（R1-R8），达成 10 项 Must 验收 + 5 项 Should 验收。完成后 conex agent loop 将具备：单轮即断发生率 < 1%、intervention 触发率罕见且可恢复、daemon 重启后 100% 可用、工具调用 0 丢失、跨 run 状态 0 污染。
