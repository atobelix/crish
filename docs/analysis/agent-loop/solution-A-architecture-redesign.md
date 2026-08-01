# Conex Agent Loop 架构系统性重构方案

> 本方案基于以下 5 份分析文档提炼而成：
> - `01-conex-current-issues.md`（conex 当前 10 个具体问题点）
> - `02-pi-agent-loop-analysis.md`（pi / oh-my-pi 双层循环设计借鉴）
> - `03-grok-build-agent-loop-analysis.md`（grok-build 三层 Actor + Stop Gate 设计借鉴）
> - `04-tool-call-chain-analysis.md`（端点选择与解析器不匹配根因）
> - `05-recovery-continuation-analysis.md`（续轮跨 run 与错误恢复分层根因）
>
> 本方案不做补丁式或兼容式改进，而是从架构层重新划分编排层（Orchestrator）与运行时（Runtime）的职责边界，重建工具调用链路的端到端可信契约，统一恢复与续写的抽象，重构状态机完整性，并设计跨供应商能力映射的系统性方案。
>
> 文中不使用 emoji，所有图示采用 SVG。

---

## 1. 问题总结

将 5 份分析文档中的所有问题点去重、归类后，得到 7 类核心问题。每类问题均跨多个文件、跨多个层级耦合，无法通过单点修补解决。

### 1.1 问题清单（按架构层归类）

| 类别 | 编号 | 问题 | 来源 |
|------|------|------|------|
| **A. 状态机与终止语义** | A1 | `toolCalls.length === 0` 单向终止，无外部否决机制 | 01-§3.6 / 02-§4.2 / 03-§4.1 |
| | A2 | `intervention-required` 被映射为 run 终态失败，无 awaiting-intervention 中间态 | 01-§3.1 / §4.1 |
| | A3 | `SHOULd_STOP` 不可被 hook 否决（只能建议停，不能建议继续） | 03-§4.1 |
| | A4 | `length` 截断后 `MAX_LENGTH_CONTINUE_NUDGES=1` 即停止，未处理 toolCall 参数被截断 | 02-§5.1.C / 05-§3.6 |
| **B. Steering 与恢复策略** | B1 | `maxSteeringMessages=1` 默认过严，二次空响应即终止 | 01-§3.1 |
| | B2 | 三处 `maxSteeringMessages` 默认值不一致（1/1/3），无单一权威源 | 01-§3.2 |
| | B3 | 全局共享 steering 预算，无错误类型分级 | 05-§7.2 |
| | B4 | `intervention` 与续轮策略语义冲突，无优先级仲裁 | 05-§7.3 |
| | B5 | `handlePrepareTurn` 内 `after-tools` 与 `before-turn` 评估重叠 | 01-§3.10 |
| | B6 | `preparing-turn` 阶段 steering 扫描整个 conversation，状态污染跨 run 传播 | 05-§3.3 / §7.1 |
| | B7 | 续轮跨 run，状态边界割裂 | 05-§7.1 |
| | B8 | `TaskContinuationStrategy` 的 `stalledRounds` 恒 0，AI 自然停止一律 continue | 01-§3.6 |
| | B9 | `detectRecoveryNeedFromMessages` 无法识别"AI 文本声称调工具但无 tool_call block" | 01-§3.4 |
| **C. 工具调用链路** | C1 | Provider parser 静默丢弃 `function.name` 缺失的 tool_call，无 diagnostic | 01-§3.3 |
| | C2 | `endpoint="auto"` 优先 Responses，但 OpenAI 兼容代理多只支持 Chat Completions | 04-§2.2-§2.5 |
| | C3 | 解析器选择依赖"请求端点"而非"响应格式"，不自适应 | 04-§6.2 |
| | C4 | 桌面端 `ProviderProfile` 缺失 `endpointType` 字段 | 04-§6.2 |
| | C5 | `isResponsesEndpointUnavailable` 回退启发式过窄（仅 404/405/415） | 04-§6.2 |
| | C6 | 新引擎 `OpenAICompatibleEngine` 在有 tools 时强制 Responses 无回退 | 04-§2.6 |
| | C7 | `empty-response` 判定过严，无诊断通道说明"为何 blocks 为空" | 01-§3.5 |
| | C8 | `length` 截断 toolCall 残留违反 tool_use/tool_result 配对契约 | 02-§5.1.C |
| | C9 | `findFatalToolError` 黑名单式终止，工具失败与 run 失败耦合 | 02-§5.1.A / 03-§4.2 |
| | C10 | 无 malformed tool result 防御层（MCP 工具污染 session） | 02-§5.1.B |
| | C11 | 工具调用 delta 非增量广播，UI 无法实时渲染入参生成 | 04-§7.7 |
| | C12 | 无 `finish_reason` 兜底（模型漏设 `tool_calls` 时 agent loop 误判停止） | 04-§7.8 |
| **D. 配置生命周期** | D1 | Daemon 不持久化 Provider 配置，重启即丢失 | 01-§3.7 |
| | D2 | `runtimeConfigFromDaemonConfig` 故意返回 `{}`，非凭证字段也丢失 | 01-§3.7 |
| | D3 | `runtimeConfigFromRunMetadata` 不读 `maxSteeringMessages` 等恢复参数 | 01-§3.8 |
| | D4 | Provider 配置分散在多字段，per-request 覆盖需重建实例 | 03-§4.4 |
| **E. 错误恢复与重试** | E1 | 错误分类粗粒度，恢复决策分散在 3 处（handleStreamError / handleErrorWithHook / detectRecoveryNeedFromMessages） | 05-§7.4 |
| | E2 | 无 `RetryDecision` 分类驱动，无 `retry_only_before_output` | 03-§4.5 |
| | E3 | `empty-response` 走 steering 而非重试，污染对话历史 | 03-§5.2.G |
| | E4 | 无 Action Stationarity step 级重复调用检测 | 03-§4.2 / §5.1.D |
| **F. 可观测性与 UI** | F1 | 桌面端不识别 `runtime-intervention-required` 事件 | 01-§3.9 |
| | F2 | `provider-diagnostic` 通道未覆盖语义级解析失败 | 01-§3.3 |
| | F3 | 桌面端事件 schema 与 daemon 事件类型无一致性校验 | 01-§3.9 |
| **G. 状态管理** | G1 | 状态所有权分散（ConversationEngine + ContextManager + ledger + recorder） | 03-§4.6 |
| | G2 | prune / compaction / request build 分散在多文件 | 03-§4.6 |
| | G3 | 无显式 repair history 步骤 | 03-§4.6 |

### 1.2 问题间耦合关系

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 480" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#b22222"/>
    </marker>
    <style>
      .layer-a { fill: #ffe8e8; stroke: #b22222; }
      .layer-b { fill: #fff4e0; stroke: #b8860b; }
      .layer-c { fill: #fff8e0; stroke: #b8860b; }
      .layer-d { fill: #e8f0ff; stroke: #1e6091; }
      .layer-e { fill: #f0e8ff; stroke: #6a1b9a; }
      .lbl { font-weight: bold; font-size: 12px; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl">问题耦合关系图（箭头表示"加剧"或"触发"）</text>

  <rect x="40" y="50" width="160" height="50" rx="6" class="layer-d"/>
  <text x="120" y="72" text-anchor="middle" class="lbl">D1-D4 配置丢失</text>
  <text x="120" y="88" text-anchor="middle" font-size="10">daemon 重启即失配</text>

  <rect x="240" y="50" width="200" height="50" rx="6" class="layer-c"/>
  <text x="340" y="72" text-anchor="middle" class="lbl">C2-C6 端点选择错误</text>
  <text x="340" y="88" text-anchor="middle" font-size="10">auto 优先 Responses</text>

  <rect x="480" y="50" width="200" height="50" rx="6" class="layer-c"/>
  <text x="580" y="72" text-anchor="middle" class="lbl">C1 parser 静默丢弃</text>
  <text x="580" y="88" text-anchor="middle" font-size="10">无 diagnostic</text>

  <rect x="720" y="50" width="200" height="50" rx="6" class="layer-c"/>
  <text x="820" y="72" text-anchor="middle" class="lbl">C7 empty-response 过严</text>
  <text x="820" y="88" text-anchor="middle" font-size="10">无"为何空"诊断</text>

  <rect x="40" y="160" width="160" height="50" rx="6" class="layer-b"/>
  <text x="120" y="182" text-anchor="middle" class="lbl">B1-B3 预算过严</text>
  <text x="120" y="198" text-anchor="middle" font-size="10">maxSteeringMessages=1</text>

  <rect x="240" y="160" width="200" height="50" rx="6" class="layer-b"/>
  <text x="340" y="182" text-anchor="middle" class="lbl">B6-B7 状态污染跨 run</text>
  <text x="340" y="198" text-anchor="middle" font-size="10">conversation 残留误判</text>

  <rect x="480" y="160" width="200" height="50" rx="6" class="layer-b"/>
  <text x="580" y="182" text-anchor="middle" class="lbl">B4 intervention 与续轮冲突</text>
  <text x="580" y="198" text-anchor="middle" font-size="10">无仲裁</text>

  <rect x="720" y="160" width="200" height="50" rx="6" class="layer-b"/>
  <text x="820" y="182" text-anchor="middle" class="lbl">B8-B9 续轮策略失真</text>
  <text x="820" y="198" text-anchor="middle" font-size="10">stalledRounds 恒 0</text>

  <rect x="160" y="270" width="200" height="50" rx="6" class="layer-a"/>
  <text x="260" y="292" text-anchor="middle" class="lbl">A2 intervention 硬失败</text>
  <text x="260" y="308" text-anchor="middle" font-size="10">无 awaiting-intervention</text>

  <rect x="400" y="270" width="200" height="50" rx="6" class="layer-a"/>
  <text x="500" y="292" text-anchor="middle" class="lbl">A1 单轮即断</text>
  <text x="500" y="308" text-anchor="middle" font-size="10">toolCalls=0 单向终止</text>

  <rect x="640" y="270" width="200" height="50" rx="6" class="layer-e"/>
  <text x="740" y="292" text-anchor="middle" class="lbl">E1 错误分类分散</text>
  <text x="740" y="308" text-anchor="middle" font-size="10">3 处独立分类器</text>

  <rect x="320" y="380" width="320" height="50" rx="6" class="layer-a"/>
  <text x="480" y="402" text-anchor="middle" class="lbl">最终症状：AI 一句话即断 / intervention 风暴 / 续轮被架空</text>

  <line x1="120" y1="100" x2="340" y2="160" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="340" y1="100" x2="580" y2="160" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="580" y1="100" x2="820" y2="160" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="120" y1="210" x2="260" y2="270" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="340" y1="210" x2="500" y2="270" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="580" y1="210" x2="500" y2="270" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="820" y1="210" x2="740" y2="270" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="260" y1="320" x2="420" y2="380" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="500" y1="320" x2="480" y2="380" stroke="#b22222" marker-end="url(#arr)"/>
  <line x1="740" y1="320" x2="540" y2="380" stroke="#b22222" marker-end="url(#arr)"/>
</svg>
```

---

## 2. 根因分析

将 §1 的问题清单按因果链向上追溯，得到 8 条架构层根因。每条根因都不是单点 bug，而是设计决策层面的结构性缺陷。

### 2.1 根因 R1：续轮边界跨 run，编排层与运行时状态视图割裂

**涉及问题**：A1 / B6 / B7 / B8

**根因描述**：
conex 的"继续"必须经过 `turn-complete → SHOULD_STOP → run() 退出 → orchestrator assessRound → 新 run` 这条链路，跨越两个独立的执行上下文（runtime / orchestrator）。两者没有共享的状态视图：

- runtime 的 `steeringCount` 在新 run 会被 reset，但 `conversation` 中的历史错误消息不会清理。
- orchestrator 的 `assessGoalRound` 只看 events，看不到 runtime 的 `steeringCount` 或 intervention reason。
- 新 run 的 `preparing-turn` 会 scan `conversation.getMessages()`，把上一 run 的错误残留当作本轮的"工具错误循环"。

对比 pi（外层 while `getFollowUpMessages`）与 grok-build（`ToolLoop::FollowupMessage` + `continue`），两者的续轮都在同一循环内完成，状态天然连续。conex 的跨 run 续轮是架构性的状态割裂。

### 2.2 根因 R2：steering 预算与 run 终态失败耦合，无软失败中间态

**涉及问题**：A2 / B1 / B3

**根因描述**：
`intervention-required` 在状态机层被映射为 `turn-complete(endReason=error)`，在 orchestrator 层被映射为 `run.status=failed`。两层都把"runtime 无法自救"等同于"run 终态失败"，没有任何"暂停等待用户介入"的中间态。

`maxSteeringMessages=1` 同时充当：
- `RecoverySteeringStrategy` 的单策略预算
- `SteeringCoordinator` 的全局预算

任何一次 steering（empty-response / tool-error-loop / repeated-tool-call）都消耗同一预算。对比 grok-build 的 8 类错误分级 + 独立预算（传输 15 / 限流 2 / doom 独立），conex 是"一刀切"的 1 次预算。

正确的语义应当是：`intervention-required` 是一种"软失败"信号，应当让 run 进入 `awaiting-intervention` 状态，把 `choices: ["rollback", "pause", "user-instruction"]` 暴露给用户。

### 2.3 根因 R3：Provider 解析器静默丢弃 + 端点选择与响应格式脱节

**涉及问题**：C1 / C2 / C3 / C4 / C5 / C6 / C7 / F2

**根因描述**：
两层缺陷叠加：

**第一层（端点选择）**：`resolvedEndpoints()` 在 `endpoint === "auto"` 时返回 `["responses", "chat-completions"]`，优先尝试 Responses API。但"OpenAI 兼容"是一个模糊的协议标签，绝大多数第三方实现（DeepSeek、Qwen、LiteLLM、opencode-go）只实现了 Chat Completions 子集。conex 没有任何能力探测机制，仅靠硬编码的优先级和极其苛刻的回退正则。

**第二层（解析器选择）**：解析器选择依赖"请求端点"而非"响应格式"。`provider-openai-class.ts:153-155` 根据 `endpoint` 变量选择解析器，而非根据响应实际内容自适应。一旦端点选择与代理实际返回格式不一致，`parseResponsesStreamingResponse` 无法识别 Chat Completions 帧的 `choices[].delta.tool_calls`，所有工具调用 delta 被静默丢弃，且不产生任何 `provider-diagnostic` 事件。

这违反"无法识别的输入必须显式上报"的契约，导致下游 `ProviderResponseConsumer` 收到空事件流却无法区分"AI 真的没动作"与"parser 丢了 AI 的动作"。

### 2.4 根因 R4：工具失败与 run 失败耦合，黑名单式终止

**涉及问题**：C9 / C10

**根因描述**：
conex 的 `findFatalToolError` 用黑名单判定"致命工具错误"，命中即 `endReason='error'` 终止整个 run。这把"工具失败"与"run 失败"耦合，对长任务不友好。

对比 pi 的三道防线（prepare / execute / finalize）全部把异常编码为 `isError=true` 的 toolResult，循环继续，让模型看到错误后自行决策。grok-build 的 `ToolLoop` 枚举显式区分终态（`PermissionReject`/`Cancelled`/`FollowupMessage`）与非终态（`Continue`/`NonExistingTool`/`ToolParsingError`/`HookDenied`），只有用户主动行为能终止工具环。

黑名单需要手动维护，且工具错误本应由模型自决策，而非由 loop 侧黑名单判定。

### 2.5 根因 R5：错误分类粗粒度，恢复决策分散无单一真理源

**涉及问题**：E1 / E2 / E3 / E4 / B9

**根因描述**：
conex 的错误处理分散在三处，没有统一的错误分类器：

1. `handleStreamError`（`index.ts:425-469`）：处理 payload-too-large / transient，有细分类但只覆盖 streaming 阶段。
2. `RecoveryCoordinator.handleErrorWithHook`（`recovery.ts:27-40`）：通用错误，默认 abort。
3. `RecoverySteeringStrategy.detectRecoveryNeedFromMessages`（`recovery-steering-strategy.ts:96-102`）：基于消息扫描的 loop 检测。

三者没有共享的"是否允许继续"决策，分类逻辑分散且语义重叠。grok-build 的 `classify_error` 是单一真理源（`retry.rs:144-251`），所有错误走同一纯函数，可单测、无副作用。

此外，conex 无 `retry_only_before_output` 机制，流式输出后仍可能重试，导致内容重复。

### 2.6 根因 R6：Daemon 配置生命周期与 Run 生命周期未解耦

**涉及问题**：D1 / D2 / D3 / D4

**根因描述**：
`DaemonProviderGatewayController.config` 仅存在于内存，daemon 重启即清零。桌面端 `useEngineBootstrap` 在 WebSocket `connected` 事件时才推送 `syncActiveProfileToEngine`，存在"daemon 重启 → 用户立即发消息 → run 启动时 provider 还未到位"的窗口。

`runtimeConfigFromDaemonConfig` 故意返回 `{}` 把 provider 凭证完全排除在 daemon 配置文件之外（安全考虑），但没有任何替代的"非凭证字段（model/baseUrl/credentialMode）从磁盘恢复"的路径——daemon 重启后即使 model/baseUrl 也丢失，这超出了安全要求（安全只要求不落盘 apiKey）。

`runtimeConfigFromRunMetadata` 不读 `maxSteeringMessages` 等恢复参数，使得 run 启动时无法按需放宽 steering 预算。

### 2.7 根因 R7：跨 run/turn 状态不清理，依赖消息内容做状态推断

**涉及问题**：B6 / G1 / G2 / G3

**根因描述**：
conex 的 `detectRecoveryNeedFromMessages` 通过扫描 `conversation.getMessages()` 检测工具错误循环。但 `conversation` 中的消息是跨 run 持久化的，新 run 会读到上一 run 的错误残留，触发误判。

对比 grok-build 的 `std::mem::take(&mut *self.doom_loop_turn_tally.lock())`（`turn.rs:1114`）：每个 turn 结束时显式清理 tally，下一个 turn 从零计数，状态不跨 turn 污染。

conex 的 `steeringCount` 虽有 `resetSteeringCount`，但 reset 时机分散（`index.ts:481, 488, 516`），且 `preparing-turn` 阶段的扫描会读取当前 conversation 中残留的历史错误消息，等价于跨 run 状态污染。

此外，conex 的状态所有权分散在 `ConversationEngine` + `ContextManager` + `ledger` + `recorder`，prune / compaction / request build 分散在多个文件，无显式 repair history 步骤。

### 2.8 根因 R8：桌面端事件 schema 与 daemon 事件类型无契约校验

**涉及问题**：F1 / F3

**根因描述**：
桌面端没有针对 `runtime-intervention-required` 的专门 UI 处理，用户只能看到 run 失败，看不到 daemon 给出的 `choices: ["rollback", "pause", "user-instruction"]`。

daemon 新增事件类型时，桌面端没有对应的 lint / 契约校验强制实现处理路径。这导致即使 daemon 内部已经识别出"需要用户介入"，桌面端也无法把"介入请求"暴露给用户做选择，只能让用户重新发消息。

### 2.9 根因总览图

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 420" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .root { fill: #ffe0e0; stroke: #b22222; stroke-width: 1.5; }
      .arch { fill: #e8f4ff; stroke: #1e6091; stroke-width: 1.5; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl" font-size="13">8 条架构层根因</text>

  <rect x="40" y="50" width="200" height="56" rx="6" class="root"/>
  <text x="140" y="74" text-anchor="middle" class="lbl">R1 续轮跨 run</text>
  <text x="140" y="92" text-anchor="middle" font-size="10">状态边界割裂</text>

  <rect x="260" y="50" width="200" height="56" rx="6" class="root"/>
  <text x="360" y="74" text-anchor="middle" class="lbl">R2 预算耦合终态</text>
  <text x="360" y="92" text-anchor="middle" font-size="10">无软失败中间态</text>

  <rect x="480" y="50" width="200" height="56" rx="6" class="root"/>
  <text x="580" y="74" text-anchor="middle" class="lbl">R3 解析器静默丢弃</text>
  <text x="580" y="92" text-anchor="middle" font-size="10">端点与格式脱节</text>

  <rect x="700" y="50" width="220" height="56" rx="6" class="root"/>
  <text x="810" y="74" text-anchor="middle" class="lbl">R4 工具失败耦合 run</text>
  <text x="810" y="92" text-anchor="middle" font-size="10">黑名单式终止</text>

  <rect x="40" y="160" width="200" height="56" rx="6" class="root"/>
  <text x="140" y="184" text-anchor="middle" class="lbl">R5 错误分类分散</text>
  <text x="140" y="202" text-anchor="middle" font-size="10">无单一真理源</text>

  <rect x="260" y="160" width="200" height="56" rx="6" class="root"/>
  <text x="360" y="184" text-anchor="middle" class="lbl">R6 配置未解耦</text>
  <text x="360" y="202" text-anchor="middle" font-size="10">daemon 重启即失</text>

  <rect x="480" y="160" width="200" height="56" rx="6" class="root"/>
  <text x="580" y="184" text-anchor="middle" class="lbl">R7 状态不清理</text>
  <text x="580" y="202" text-anchor="middle" font-size="10">依赖消息推断</text>

  <rect x="700" y="160" width="220" height="56" rx="6" class="root"/>
  <text x="810" y="184" text-anchor="middle" class="lbl">R8 事件 schema 无校验</text>
  <text x="810" y="202" text-anchor="middle" font-size="10">UI 不识别 intervention</text>

  <rect x="240" y="280" width="480" height="60" rx="8" class="arch"/>
  <text x="480" y="306" text-anchor="middle" class="lbl" font-size="13">架构层重构目标</text>
  <text x="480" y="324" text-anchor="middle" font-size="11">重新划分编排层/运行时/传输层职责边界</text>

  <line x1="140" y1="106" x2="320" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="360" y1="106" x2="380" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="580" y1="106" x2="440" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="810" y1="106" x2="500" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="140" y1="216" x2="360" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="360" y1="216" x2="420" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="580" y1="216" x2="460" y2="280" stroke="#333" marker-end="url(#arr2)"/>
  <line x1="810" y1="216" x2="500" y2="280" stroke="#333" marker-end="url(#arr2)"/>
</svg>
```

---

## 3. 重构原则

指导重构的 10 条系统性原则。每条原则都对应一条或多条根因，且不可被补丁式改进绕过。

### 3.1 编排层永不单方面终止（对应 R1 / R2）

编排层（Orchestrator）只负责目标分解与续轮决策，不负责运行时错误判定。`intervention-required` 是软失败信号，run 必须进入 `awaiting-intervention` 等待用户决策，而非直接 `failed`。只有以下三种情况允许 run 终态失败：

1. 用户显式选择 `rollback` 或 `pause`。
2. `maxRounds` 达到上限（且续轮策略不再 `continue`）。
3. 不可恢复的 fatal 错误（如 `context-length-exceeded`）。

### 3.2 工具调用必有回执（对应 R3 / R4）

`tool_use` 与 `tool_result` 必须显式配对。任何路径下产生的 `tool_use`（包括 `length` 截断的残留 toolCall）都必须有对应的 `tool_result`：

- 工具执行成功 → 正常 toolResult。
- 工具执行失败 → `isError=true` 的 toolResult（编码而非抛出）。
- 工具参数被截断 → placeholder toolResult + 可操作提示（"拆分 payload"）。
- 工具不存在 / parse 失败 → error toolResult，loop 继续。

### 3.3 续轮在循环内完成（对应 R1）

消除跨 run 续轮，回归循环内 `continue`。当 AI 自然停止（`toolCalls.length === 0`）时，先咨询续轮策略；返回 `continue` 时注入续轮 prompt 并 dispatch `INPUT_AVAILABLE`，让循环回到 `preparing-turn`，在同一 `run()` 内继续。仅当续轮策略返回 `stop` 或达到 `maxRounds` 时才 `SHOULd_STOP`。

### 3.4 错误恢复基于错误类型分级（对应 R2 / R5）

每种错误类型有独立预算与恢复路径，避免互相耗尽。引入 grok-build 式的纯函数 `classifyRecoveryNeed(error, context): RecoveryDecision` 作为单一真理源。`maxSteeringBudget` 仅作为所有 steering 的总兜底，而非每种错误的共享预算。

### 3.5 解析器自适应响应格式（对应 R3）

解析器选择不再依赖"请求端点"，而是根据响应实际内容自适应。读首帧判断格式：

- 帧有顶层 `type` 字段且以 `response.` 开头 → Responses API 格式。
- 帧有 `choices` 数组 → Chat Completions 格式。

无论端点选择如何，解析器都能正确匹配响应格式，从根上消除"格式不匹配导致 tool_calls 丢失"。

### 3.6 无法识别的输入必须显式上报（对应 R3 / F2）

parser 任何"识别失败"都必须 emit `provider-diagnostic` 事件，绝不静默丢弃。包括：

- `function.name` 缺失的 tool_call。
- 非标准字段（`function_name`、`name` 直接挂在 call 上）。
- 流提前结束（`sawTerminal=false`）。

下游 `ProviderResponseConsumer` 必须把 diagnostic 收集到 `ConsumeResult`，并暴露 `sawInvalidToolCall: boolean`，让 steering 给出针对性提示。

### 3.7 状态单点所有权（对应 R7）

所有对话状态（conversation / token usage / sampling config / credentials / steering counts）由单一组件 `ConversationStateStore` 管理。prune / compaction / request build 集中在该组件内，外部通过命令接口操作。状态操作天然序列化，compaction 与 turn 执行不会 race。

### 3.8 跨 run 状态显式清理（对应 R7）

每个 run 开始时显式重置所有计数器（`steeringCount` / `lengthContinueNudgeCount` / `payloadRecoveryRetries` / `stationarityCount`），且不依赖 `conversation` 内容做 loop 检测。`detectRecoveryNeedFromMessages` 改为基于本轮 run 的结构化事件计数，而非扫描消息文本。消息文本是给模型的，不是给状态机的。

### 3.9 配置与凭证分离（对应 R6）

Daemon 持久化非凭证配置（model / baseUrl / credentialMode / endpoint），apiKey 通过凭证解析器拉取。daemon 重启后非凭证配置立即就绪，桌面端只需补推 apiKey（或通过 `credentialMode='account-center'` 走凭证解析器）。

### 3.10 错误永不终止循环（除非用户主动行为）（对应 R4）

工具自身的 `is_error`、parse 失败、hook deny 一律编码为 `tool_result` 喂回模型，由模型决定下一步。仅当工具主动声明 `terminate` 或用户主动行为（拒绝 / 取消）时才终止工具环。移除 `findFatalToolError` 的黑名单语义。

---

## 4. 目标架构

### 4.1 三层架构总览

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr3" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .orch { fill: #e8f4ff; stroke: #1e6091; stroke-width: 1.5; }
      .rt { fill: #eaffea; stroke: #2e7d32; stroke-width: 1.5; }
      .prov { fill: #fff8e0; stroke: #b8860b; stroke-width: 1.5; }
      .state { fill: #f0e8ff; stroke: #6a1b9a; stroke-width: 1.5; }
      .ui { fill: #ffe8e8; stroke: #b22222; stroke-width: 1.5; }
      .lbl { font-weight: bold; font-size: 12px; }
      .sub { font-size: 10px; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl" font-size="13">Conex Agent Loop 目标架构（三层 + 状态单点）</text>

  <!-- UI 层 -->
  <rect x="40" y="40" width="880" height="56" rx="8" class="ui"/>
  <text x="480" y="62" text-anchor="middle" class="lbl">桌面端 / UI 层</text>
  <text x="480" y="80" text-anchor="middle" class="sub">事件 schema 契约校验 | InterventionApprovalPipeline | ProviderProfile (含 endpointType)</text>

  <!-- Orchestrator 层 -->
  <rect x="40" y="120" width="880" height="80" rx="8" class="orch"/>
  <text x="480" y="142" text-anchor="middle" class="lbl">Orchestrator 编排层（永不单方面终止）</text>
  <rect x="80" y="156" width="180" height="36" rx="4" class="orch"/>
  <text x="170" y="178" text-anchor="middle" class="sub">GoalExecutor</text>
  <rect x="280" y="156" width="180" height="36" rx="4" class="orch"/>
  <text x="370" y="178" text-anchor="middle" class="sub">ContinuationGate</text>
  <rect x="480" y="156" width="180" height="36" rx="4" class="orch"/>
  <text x="570" y="178" text-anchor="middle" class="sub">TaskAssessment</text>
  <rect x="680" y="156" width="200" height="36" rx="4" class="orch"/>
  <text x="780" y="178" text-anchor="middle" class="sub">StallDetector (per-mode)</text>

  <!-- Runtime 层 -->
  <rect x="40" y="220" width="880" height="160" rx="8" class="rt"/>
  <text x="480" y="242" text-anchor="middle" class="lbl">Runtime 运行时（状态机驱动，循环内续轮）</text>
  <rect x="60" y="256" width="160" height="56" rx="4" class="rt"/>
  <text x="140" y="278" text-anchor="middle" class="sub" font-weight="bold">AgentSessionLoop</text>
  <text x="140" y="294" text-anchor="middle" class="sub">状态机 + 循环内 continue</text>

  <rect x="240" y="256" width="160" height="56" rx="4" class="rt"/>
  <text x="320" y="278" text-anchor="middle" class="sub" font-weight="bold">StopGate</text>
  <text x="320" y="294" text-anchor="middle" class="sub">外部 hook 可否决停止</text>

  <rect x="420" y="256" width="200" height="56" rx="4" class="rt"/>
  <text x="520" y="278" text-anchor="middle" class="sub" font-weight="bold">ErrorRecoveryClassifier</text>
  <text x="520" y="294" text-anchor="middle" class="sub">单一真理源 (纯函数)</text>

  <rect x="640" y="256" width="200" height="56" rx="4" class="rt"/>
  <text x="740" y="278" text-anchor="middle" class="sub" font-weight="bold">ToolExecutionCoordinator</text>
  <text x="740" y="294" text-anchor="middle" class="sub">编码而非抛出 + coerceToolResult</text>

  <rect x="60" y="324" width="160" height="44" rx="4" class="rt"/>
  <text x="140" y="346" text-anchor="middle" class="sub" font-weight="bold">SteeringCoordinator</text>
  <text x="140" y="360" text-anchor="middle" class="sub">单一预算权威源</text>

  <rect x="240" y="324" width="160" height="44" rx="4" class="rt"/>
  <text x="320" y="346" text-anchor="middle" class="sub" font-weight="bold">StationarityDetector</text>
  <text x="320" y="360" text-anchor="middle" class="sub">step 级 nudge@8 / 硬停@16</text>

  <rect x="420" y="324" width="200" height="44" rx="4" class="rt"/>
  <text x="520" y="346" text-anchor="middle" class="sub" font-weight="bold">InterventionPipeline</text>
  <text x="520" y="360" text-anchor="middle" class="sub">软失败 → awaiting-intervention</text>

  <rect x="640" y="324" width="200" height="44" rx="4" class="rt"/>
  <text x="740" y="346" text-anchor="middle" class="sub" font-weight="bold">CompletionRequirement</text>
  <text x="740" y="360" text-anchor="middle" class="sub">显式任务完成契约</text>

  <!-- 状态层 -->
  <rect x="40" y="400" width="880" height="56" rx="8" class="state"/>
  <text x="480" y="422" text-anchor="middle" class="lbl">ConversationStateStore（状态单点所有权）</text>
  <text x="480" y="440" text-anchor="middle" class="sub">conversation | token usage | steering counts | run-scoped message slice | prune / compaction / request build</text>

  <!-- Provider 层 -->
  <rect x="40" y="476" width="880" height="56" rx="8" class="prov"/>
  <text x="480" y="498" text-anchor="middle" class="lbl">Provider 传输层（自适应 + 单一配置）</text>
  <text x="480" y="516" text-anchor="middle" class="sub">AdaptiveStreamParser | SamplerConfig (per-request override) | RetryDecision (classify_error) | provider-diagnostic 通道</text>

  <line x1="480" y1="96" x2="480" y2="120" stroke="#333" marker-end="url(#arr3)"/>
  <line x1="480" y1="200" x2="480" y2="220" stroke="#333" marker-end="url(#arr3)"/>
  <line x1="480" y1="380" x2="480" y2="400" stroke="#333" marker-end="url(#arr3)"/>
  <line x1="480" y1="456" x2="480" y2="476" stroke="#333" marker-end="url(#arr3)"/>
</svg>
```

### 4.2 模块划分

#### 4.2.1 编排层（Orchestrator）

| 模块 | 职责 | 关键约束 |
|------|------|----------|
| `GoalExecutor` | 目标分解、续轮调度 | 永不直接终止 run，只发 `continue`/`stop` 决策 |
| `ContinuationGate` | 续轮策略评估（循环内调用） | 替代跨 run 续轮；返回 `ContinueDirective` 或 `Stop` |
| `TaskAssessment` | 轮次评估 | 不再把 `intervention-required` 视为 `failed` 终态 |
| `StallDetector` | 无进展检测（per-mode） | task 模式也跟踪 stall，`stalledRounds >= 3` 时 `block` |

#### 4.2.2 运行时（Runtime）

| 模块 | 职责 | 关键约束 |
|------|------|----------|
| `AgentSessionLoop` | 状态机驱动循环 | 循环内 `continue` 续轮，不跨 run |
| `StopGate` | 停止否决门 | hook 可返回 `KeepWorking{feedback}` 强制继续 |
| `ErrorRecoveryClassifier` | 错误分类纯函数 | 单一真理源，按错误类型分级 |
| `ToolExecutionCoordinator` | 工具执行 | 编码而非抛出 + `coerceToolResult` 防御层 |
| `SteeringCoordinator` | steering 注入 | 单一预算权威源，按错误类型分预算 |
| `StationarityDetector` | 重复调用检测 | step 级 nudge@8 / 硬停@16 / true-noop@4 |
| `InterventionPipeline` | 软失败处理 | 进入 `awaiting-intervention` 等待用户 |
| `CompletionRequirement` | 任务完成契约 | 检查必备工具是否调用，未满足则指数退避重试 |

#### 4.2.3 状态层（State）

| 模块 | 职责 | 关键约束 |
|------|------|----------|
| `ConversationStateStore` | 状态单点所有权 | 所有状态操作序列化，prune / compaction / request build 集中 |
| `RunScopedMessageSlice` | 本轮消息切片 | steering 扫描只看本轮消息，不跨 run |
| `StateRepairCommands` | 显式 repair | `RepairHistory` / `RepairDanglingAfterHarnessHalt` |

#### 4.2.4 传输层（Provider）

| 模块 | 职责 | 关键约束 |
|------|------|----------|
| `AdaptiveStreamParser` | 自适应流解析 | 根据响应首帧格式分派解析器 |
| `SamplerConfig` | 单一配置对象 | per-request override，不重建实例 |
| `RetryDecision` | 分类驱动重试 | `retry_only_before_output` + 按错误类型分类 |
| `ProviderDiagnosticChannel` | 诊断上报 | 覆盖语义级解析失败 |

### 4.3 数据流

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 420" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr4" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .data { fill: #e8f4ff; stroke: #1e6091; }
      .control { fill: #eaffea; stroke: #2e7d32; }
      .diag { fill: #fff8e0; stroke: #b8860b; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl" font-size="13">数据流（实线 = 消息流，虚线 = 控制流，点线 = 诊断流）</text>

  <rect x="40" y="50" width="140" height="40" rx="6" class="data"/>
  <text x="110" y="74" text-anchor="middle">User Input</text>

  <rect x="220" y="50" width="160" height="40" rx="6" class="data"/>
  <text x="300" y="74" text-anchor="middle">ConversationStateStore</text>

  <rect x="420" y="50" width="160" height="40" rx="6" class="control"/>
  <text x="500" y="74" text-anchor="middle">AgentSessionLoop</text>

  <rect x="620" y="50" width="160" height="40" rx="6" class="data"/>
  <text x="700" y="74" text-anchor="middle">AdaptiveStreamParser</text>

  <rect x="820" y="50" width="120" height="40" rx="6" class="data"/>
  <text x="880" y="74" text-anchor="middle">Provider SSE</text>

  <rect x="40" y="140" width="140" height="40" rx="6" class="control"/>
  <text x="110" y="164" text-anchor="middle">StopGate</text>

  <rect x="220" y="140" width="160" height="40" rx="6" class="control"/>
  <text x="300" y="164" text-anchor="middle">ContinuationGate</text>

  <rect x="420" y="140" width="160" height="40" rx="6" class="control"/>
  <text x="500" y="164" text-anchor="middle">ErrorRecoveryClassifier</text>

  <rect x="620" y="140" width="160" height="40" rx="6" class="control"/>
  <text x="700" y="164" text-anchor="middle">ToolExecutionCoordinator</text>

  <rect x="820" y="140" width="120" height="40" rx="6" class="control"/>
  <text x="880" y="164" text-anchor="middle">RetryDecision</text>

  <rect x="40" y="230" width="140" height="40" rx="6" class="diag"/>
  <text x="110" y="254" text-anchor="middle">InterventionPipeline</text>

  <rect x="220" y="230" width="160" height="40" rx="6" class="diag"/>
  <text x="300" y="254" text-anchor="middle">ProviderDiagnosticChannel</text>

  <rect x="420" y="230" width="160" height="40" rx="6" class="diag"/>
  <text x="500" y="254" text-anchor="middle">StationarityDetector</text>

  <rect x="620" y="230" width="160" height="40" rx="6" class="diag"/>
  <text x="700" y="254" text-anchor="middle">CompletionRequirement</text>

  <rect x="820" y="230" width="120" height="40" rx="6" class="data"/>
  <text x="880" y="254" text-anchor="middle">UI Events</text>

  <line x1="180" y1="70" x2="220" y2="70" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="380" y1="70" x2="420" y2="70" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="580" y1="70" x2="620" y2="70" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="780" y1="70" x2="820" y2="70" stroke="#333" marker-end="url(#arr4)"/>
  <line x1="880" y1="90" x2="880" y2="140" stroke="#333" marker-end="url(#arr4)" stroke-dasharray="4,2"/>
  <line x1="500" y1="90" x2="500" y2="140" stroke="#333" marker-end="url(#arr4)" stroke-dasharray="4,2"/>
  <line x1="700" y1="90" x2="700" y2="140" stroke="#333" marker-end="url(#arr4)" stroke-dasharray="4,2"/>

  <line x1="500" y1="180" x2="300" y2="140" stroke="#333" marker-end="url(#arr4)" stroke-dasharray="4,2"/>
  <line x1="500" y1="180" x2="110" y2="140" stroke="#333" marker-end="url(#arr4)" stroke-dasharray="4,2"/>
  <line x1="700" y1="180" x2="500" y2="140" stroke="#333" marker-end="url(#arr4)" stroke-dasharray="4,2"/>

  <line x1="110" y1="180" x2="110" y2="230" stroke="#b8860b" marker-end="url(#arr4)" stroke-dasharray="2,2"/>
  <line x1="700" y1="180" x2="500" y2="230" stroke="#b8860b" marker-end="url(#arr4)" stroke-dasharray="2,2"/>
  <line x1="880" y1="90" x2="300" y2="230" stroke="#b8860b" marker-end="url(#arr4)" stroke-dasharray="2,2"/>

  <line x1="110" y1="270" x2="880" y2="270" stroke="#b22222" marker-end="url(#arr4)" stroke-dasharray="2,2"/>
  <text x="500" y="290" text-anchor="middle" font-size="10" fill="#b22222">诊断与 intervention 事件上抛 UI</text>
</svg>
```

### 4.4 控制流（重构后状态机）

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 580" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr5" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .state { fill: #e8f4ff; stroke: #1e6091; stroke-width: 1.5; }
      .recover { fill: #eaffea; stroke: #2e7d32; stroke-width: 1.5; }
      .intervene { fill: #fff8e0; stroke: #b8860b; stroke-width: 1.5; }
      .stop { fill: #ffe0e0; stroke: #b22222; stroke-width: 1.5; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl" font-size="13">重构后状态机（含 awaiting-intervention 与循环内续轮）</text>

  <rect x="400" y="50" width="160" height="40" rx="6" class="state"/>
  <text x="480" y="74" text-anchor="middle">awaiting-input</text>

  <rect x="400" y="120" width="160" height="40" rx="6" class="state"/>
  <text x="480" y="144" text-anchor="middle">preparing-turn</text>

  <rect x="400" y="190" width="160" height="40" rx="6" class="state"/>
  <text x="480" y="214" text-anchor="middle">streaming</text>

  <rect x="200" y="260" width="160" height="40" rx="6" class="recover"/>
  <text x="280" y="284" text-anchor="middle">steering-evaluation</text>

  <rect x="600" y="260" width="160" height="40" rx="6" class="state"/>
  <text x="680" y="284" text-anchor="middle">executing-tools</text>

  <rect x="400" y="330" width="160" height="40" rx="6" class="state"/>
  <text x="480" y="354" text-anchor="middle">turn-complete</text>

  <rect x="200" y="400" width="160" height="40" rx="6" class="intervene"/>
  <text x="280" y="424" text-anchor="middle">awaiting-intervention</text>

  <rect x="600" y="400" width="160" height="40" rx="6" class="state"/>
  <text x="680" y="424" text-anchor="middle">stop-gate-evaluation</text>

  <rect x="400" y="500" width="160" height="40" rx="6" class="stop"/>
  <text x="480" y="524" text-anchor="middle">done</text>

  <line x1="480" y1="90" x2="480" y2="120" stroke="#333" marker-end="url(#arr5)"/>
  <line x1="480" y1="160" x2="480" y2="190" stroke="#333" marker-end="url(#arr5)"/>

  <line x1="450" y1="230" x2="350" y2="260" stroke="#333" marker-end="url(#arr5)"/>
  <text x="380" y="240" font-size="10">STEERING_NEEDED</text>

  <line x1="510" y1="230" x2="610" y2="260" stroke="#333" marker-end="url(#arr5)"/>
  <text x="540" y="240" font-size="10">HAS_TOOL_CALLS</text>

  <line x1="680" y1="300" x2="510" y2="330" stroke="#333" marker-end="url(#arr5)"/>
  <text x="540" y="320" font-size="10">TOOLS_COMPLETE</text>

  <line x1="280" y1="300" x2="450" y2="330" stroke="#2e7d32" marker-end="url(#arr5)"/>
  <text x="320" y="320" font-size="10" fill="#2e7d32">STEERING_COMPLETE</text>

  <line x1="280" y1="300" x2="280" y2="400" stroke="#b8860b" marker-end="url(#arr5)"/>
  <text x="180" y="360" font-size="10" fill="#b8860b">INTERVENTION_REQUIRED</text>

  <line x1="450" y1="370" x2="350" y2="400" stroke="#b8860b" marker-end="url(#arr5)"/>
  <text x="320" y="395" font-size="10" fill="#b8860b">INTERVENTION_REQUIRED</text>

  <line x1="510" y1="370" x2="610" y2="400" stroke="#333" marker-end="url(#arr5)"/>
  <text x="540" y="395" font-size="10">SHOULD_STOP?</text>

  <line x1="680" y1="440" x2="510" y2="500" stroke="#b22222" marker-end="url(#arr5)"/>
  <text x="540" y="480" font-size="10" fill="#b22222">STOP_GATE: AllowStop</text>

  <line x1="600" y1="420" x2="480" y2="160" stroke="#2e7d32" marker-end="url(#arr5)"/>
  <text x="490" y="200" font-size="10" fill="#2e7d32">KeepWorking → NEXT_TURN</text>

  <line x1="200" y1="420" x2="400" y2="500" stroke="#b22222" marker-end="url(#arr5)"/>
  <text x="240" y="475" font-size="10" fill="#b22222">USER_ROLLBACK</text>

  <line x1="280" y1="440" x2="280" y2="500" stroke="#b22222" marker-end="url(#arr5)"/>
  <text x="180" y="475" font-size="10" fill="#b22222">USER_PAUSE</text>

  <line x1="350" y1="420" x2="450" y2="120" stroke="#2e7d32" marker-end="url(#arr5)"/>
  <text x="370" y="100" font-size="10" fill="#2e7d32">USER_INSTRUCTION (reset steeringCount)</text>
</svg>
```

**关键变化**：

1. 新增 `awaiting-intervention` 状态，`INTERVENTION_REQUIRED` 不再直接到 `turn-complete(error)`。
2. 新增 `stop-gate-evaluation` 状态，`SHOULD_STOP` 可被 hook 否决为 `KeepWorking`。
3. `awaiting-intervention` 接受 `USER_INSTRUCTION`（重置 steeringCount 后继续）、`USER_ROLLBACK`（终止）、`USER_PAUSE`（终止）。
4. `stop-gate-evaluation` 的 `KeepWorking` 直接 dispatch `NEXT_TURN` 回到 `preparing-turn`，循环内续轮。

---

## 5. 关键接口定义

以下为核心抽象的接口契约，使用 TypeScript 伪代码。

### 5.1 AgentSessionLoop（重构后主循环）

```typescript
interface AgentSessionLoopOptions {
  stateStore: ConversationStateStore;
  provider: ProviderTransport;
  toolCoordinator: ToolExecutionCoordinator;
  steering: SteeringCoordinator;
  errorClassifier: ErrorRecoveryClassifier;
  stopGate: StopGate;
  interventionPipeline: InterventionPipeline;
  completionRequirement?: CompletionRequirement;
  stationarityDetector: StationarityDetector;
  continuationGate: ContinuationGate;
  recovery: RecoveryBudgetConfig;
  maxRounds: number;
}

interface AgentSessionLoop {
  run(input: AgentInput): AsyncGenerator<AgentEvent, RunResult, void>;
  enqueueSteerInput(message: SteerMessage): void;
  respondIntervention(response: InterventionResponse): void;
  requestCooperativeStop(reason: string): Promise<void>;
}
```

### 5.2 StopGate（停止否决门）

```typescript
interface StopGateContext {
  turnIndex: number;
  toolCallCount: number;
  lastStopReason: StopReason;
  messages: AgentMessage[];
  completionRequirementStatus?: CompletionRequirementStatus;
}

interface StopGateDecision {
  kind: 'AllowStop' | 'KeepWorking';
  feedback?: string;
  maxContinuationsPerTurn: number;
}

interface StopGate {
  evaluate(ctx: StopGateContext, continuationsThisTurn: number): StopGateDecision;
}
```

### 5.3 ErrorRecoveryClassifier（错误分类单一真理源）

```typescript
type ErrorKind =
  | 'empty-response'
  | 'tool-error-loop'
  | 'repeated-tool-call'
  | 'transient-provider'
  | 'payload-too-large'
  | 'context-length'
  | 'auth-expired'
  | 'doom-loop'
  | 'invalid-tool-call'
  | 'fatal';

interface RecoveryDecision {
  kind: 'retry' | 'steer' | 'nudge' | 'intervene' | 'fatal';
  errorKind: ErrorKind;
  budget: PerTypeBudget;
  backoffMs?: number;
  directive?: string;
}

interface PerTypeBudget {
  maxAttempts: number;
  currentAttempts: number;
  /** 该错误类型专属预算，不与其他类型共享 */
  isolated: true;
}

interface ErrorRecoveryContext {
  error: AgentError | null;
  state: LoopStateSnapshot;
  runMessages: AgentMessage[];
  steeringCount: PerTypeBudgetMap;
  observedOutputTokens: boolean;
}

interface ErrorRecoveryClassifier {
  classify(ctx: ErrorRecoveryContext): RecoveryDecision;
}
```

### 5.4 SteeringCoordinator（单一预算权威源）

```typescript
interface SteeringPhaseContext {
  phase: 'empty-response' | 'after-tools' | 'before-turn';
  messages: AgentMessage[];
  runStartMessageIndex: number;
  turnIndex: number;
  toolCallCount: number;
  steeringCount: PerTypeBudgetMap;
  hasPendingInput: boolean;
}

interface SteeringAction {
  type: 'inject-message' | 'intervention-required';
  reason: string;
  message?: string;
  errorKind?: ErrorKind;
}

interface SteeringEvaluation {
  actions: SteeringAction[];
  interventionRequired: boolean;
}

interface SteeringCoordinator {
  evaluate(phase: SteeringPhaseContext): SteeringEvaluation;
  apply(actions: SteeringAction[], sessionId: string): AppliedSteering;
  resetSteeringCount(errorKind?: ErrorKind): void;
  /** 单一权威源：所有预算查询走这里 */
  getBudget(errorKind: ErrorKind): PerTypeBudget;
}
```

### 5.5 AdaptiveStreamParser（自适应流解析）

```typescript
type StreamFormat = 'chat-completions' | 'responses' | 'unknown';

interface AdaptiveStreamParser {
  parse(
    response: Response,
    diagnostics: ProviderDiagnostics,
    signal: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent, void, void>;
}

interface ProviderStreamEvent {
  type:
    | 'text-delta' | 'thought-delta'
    | 'tool-call' | 'tool-call-delta'
    | 'reasoning-delta'
    | 'stop'
    | 'usage'
    | 'provider-diagnostic';
  phase?: 'start' | 'delta' | 'end';
  payload: ProviderStreamPayload;
}

interface ProviderDiagnostic {
  phase: 'invalid-tool-call' | 'invalid-stream' | 'unknown-event' | 'transport-error';
  reason: string;
  partial?: unknown;
}
```

### 5.6 SamplerConfig（单一配置对象 + per-request override）

```typescript
interface SamplerConfig {
  model: string;
  baseUrl: string;
  apiKey: string | ((provider: string) => Promise<string>);
  endpointType: 'chat-completions' | 'responses' | 'auto';
  apiBackend: 'chat-completions' | 'responses' | 'messages';
  authScheme: AuthScheme;
  extraHeaders?: Record<string, string>;
  maxTokens?: number;
  thinkingIntensity?: ThinkingIntensity;
  contextWindow?: number;
  stream: boolean;
  doomLoopRecovery?: DoomLoopPolicy;
}

interface ProviderTransport {
  call(request: AgentProviderRequest, override?: Partial<SamplerConfig>): AsyncGenerator<ProviderStreamEvent, void, void>;
  /** 能力探测：探测 endpoint 是否被支持 */
  probeCapability(endpoint: 'chat-completions' | 'responses'): Promise<boolean>;
}
```

### 5.7 RetryDecision（分类驱动重试）

```typescript
type RetryDecisionKind =
  | 'Retry'
  | 'RetryWithBackoff'
  | 'RetryWithImageStrip'
  | 'RetryWithClientRebuild'
  | 'RetryWithAuthRefresh'
  | 'EmitToSession'
  | 'Fatal';

interface RetryDecision {
  kind: RetryDecisionKind;
  backoffMs?: number;
  /** 一旦观察到 output token，瞬时错误不再重试 */
  retryOnlyBeforeOutput: boolean;
  reason: string;
}

interface RetryClassifier {
  classify(error: ProviderError, retryCount: number, maxRetries: number, observedOutput: boolean): RetryDecision;
}
```

### 5.8 ConversationStateStore（状态单点所有权）

```typescript
interface ConversationStateStore {
  // 写入
  pushUserMessage(msg: UserMessage): void;
  pushAssistantResponse(msg: AssistantMessage): void;
  pushToolResult(result: ToolResult): void;
  pushSteerMessage(msg: SteerMessage): void;

  // 读取
  getMessages(): AgentMessage[];
  /** 本轮 run 的消息切片（不跨 run） */
  getRunScopedMessages(runId: string): AgentMessage[];
  getTotalTokens(): number;

  // 构建（集中 prune / compaction / request build）
  buildProviderRequest(opts: BuildRequestOptions): AgentProviderRequest;

  // 状态修复
  repairHistory(): void;
  repairDanglingAfterHalt(): void;

  // 快照
  snapshot(): ConversationSnapshot;
  restoreSnapshot(snap: ConversationSnapshot): void;
  truncateToPromptIndex(index: number): void;

  // 跨 run 状态清理
  resetRunScopedCounters(): void;
}
```

### 5.9 InterventionPipeline（软失败处理）

```typescript
interface InterventionRequest {
  requestId: string;
  runId: string;
  message: string;
  choices: InterventionChoice[];
  errorKind: ErrorKind;
  diagnostics?: ProviderDiagnostic[];
}

type InterventionChoice = 'rollback' | 'pause' | 'user-instruction';

interface InterventionResponse {
  requestId: string;
  choice: InterventionChoice;
  userInstruction?: string;
}

interface InterventionPipeline {
  request(req: InterventionRequest): Promise<InterventionResponse>;
  /** 注册 pending approval 等待队列 */
  registerPending(req: InterventionRequest): void;
  resolve(response: InterventionResponse): void;
}
```

### 5.10 CompletionRequirement（任务完成契约）

```typescript
interface CompletionRequirementConfig {
  tool: string;
  reminder: string;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface CompletionRequirementStatus {
  satisfied: boolean;
  attempts: number;
  requiredTool: string;
}

interface CompletionRequirement {
  evaluate(toolsCalled: string[]): CompletionRequirementStatus;
  /** 不满足时按指数退避注入 recovery_prompt */
  injectRecoveryPrompt(stateStore: ConversationStateStore, status: CompletionRequirementStatus): Promise<void>;
}
```

### 5.11 ContinuationGate（循环内续轮）

```typescript
interface ContinuationContext {
  turnIndex: number;
  toolCallCount: number;
  completedRounds: number;
  maxRounds: number;
  stalledRounds: number;
  lastProgressSignature: string;
  events: AgentEvent[];
}

interface ContinuationDecision {
  action: 'continue' | 'stop';
  reason: string;
  directive?: string;
  /** 续轮是否伴随 steeringCount 重置 */
  resetSteeringCount?: boolean;
}

interface ContinuationGate {
  evaluate(ctx: ContinuationContext): ContinuationDecision;
}
```

### 5.12 ToolExecutionCoordinator（编码而非抛出）

```typescript
interface ToolExecutionResult {
  toolCallId: string;
  result: ToolResult;
  /** 工具主动声明终止（替代 findFatalToolError 黑名单） */
  terminate?: boolean;
}

interface ToolLoop {
  kind: 'Continue' | 'NonExistingTool' | 'ToolParsingError' | 'HookDenied' | 'PermissionReject' | 'Cancelled' | 'FollowupMessage';
  results: ToolExecutionResult[];
  followupMessage?: string;
}

interface ToolExecutionCoordinator {
  executeBatch(toolCalls: ToolCall[], signal: AbortSignal): Promise<ToolLoop>;
  /** 防御层：强制规范化 malformed result */
  coerceToolResult(raw: unknown): ToolResult;
}
```

---

## 6. 迁移路径

从当前架构到目标架构的迁移按"先解耦根因，再消除耦合，最后补可观测性"的顺序推进。每一步都是结构化重构，不是补丁。

### 6.1 迁移阶段总览

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 360" font-family="sans-serif" font-size="11">
  <defs>
    <marker id="arr6" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#333"/>
    </marker>
    <style>
      .p0 { fill: #ffe0e0; stroke: #b22222; }
      .p1 { fill: #fff8e0; stroke: #b8860b; }
      .p2 { fill: #e8f4ff; stroke: #1e6091; }
      .p3 { fill: #eaffea; stroke: #2e7d32; }
      .lbl { font-weight: bold; }
    </style>
  </defs>

  <text x="480" y="22" text-anchor="middle" class="lbl" font-size="13">迁移路径（逻辑顺序，非时间安排）</text>

  <rect x="20" y="50" width="220" height="60" rx="6" class="p0"/>
  <text x="130" y="72" text-anchor="middle" class="lbl">阶段 1 (P0): 解耦根因</text>
  <text x="130" y="90" text-anchor="middle" font-size="10">软失败状态机</text>
  <text x="130" y="104" text-anchor="middle" font-size="10">自适应解析器</text>

  <rect x="260" y="50" width="220" height="60" rx="6" class="p0"/>
  <text x="370" y="72" text-anchor="middle" class="lbl">阶段 2 (P0): 配置解耦</text>
  <text x="370" y="90" text-anchor="middle" font-size="10">daemon 持久化非凭证</text>
  <text x="370" y="104" text-anchor="middle" font-size="10">endpointType 字段</text>

  <rect x="500" y="50" width="220" height="60" rx="6" class="p0"/>
  <text x="610" y="72" text-anchor="middle" class="lbl">阶段 3 (P0): 循环内续轮</text>
  <text x="610" y="90" text-anchor="middle" font-size="10">消除跨 run 续轮</text>
  <text x="610" y="104" text-anchor="middle" font-size="10">跨 run 状态清理</text>

  <rect x="740" y="50" width="200" height="60" rx="6" class="p1"/>
  <text x="840" y="72" text-anchor="middle" class="lbl">阶段 4 (P1): 错误分级</text>
  <text x="840" y="90" text-anchor="middle" font-size="10">ErrorRecoveryClassifier</text>
  <text x="840" y="104" text-anchor="middle" font-size="10">intervention 降级</text>

  <rect x="20" y="150" width="220" height="60" rx="6" class="p1"/>
  <text x="130" y="172" text-anchor="middle" class="lbl">阶段 5 (P1): 工具契约</text>
  <text x="130" y="190" text-anchor="middle" font-size="10">编码而非抛出</text>
  <text x="130" y="204" text-anchor="middle" font-size="10">tool_use/result 配对</text>

  <rect x="260" y="150" width="220" height="60" rx="6" class="p1"/>
  <text x="370" y="172" text-anchor="middle" class="lbl">阶段 6 (P1): StopGate</text>
  <text x="370" y="190" text-anchor="middle" font-size="10">外部 hook 否决停止</text>
  <text x="370" y="204" text-anchor="middle" font-size="10">CompletionRequirement</text>

  <rect x="500" y="150" width="220" height="60" rx="6" class="p2"/>
  <text x="610" y="172" text-anchor="middle" class="lbl">阶段 7 (P2): 状态单点</text>
  <text x="610" y="190" text-anchor="middle" font-size="10">ConversationStateStore</text>
  <text x="610" y="204" text-anchor="middle" font-size="10">prune 集中</text>

  <rect x="740" y="150" width="200" height="60" rx="6" class="p2"/>
  <text x="840" y="172" text-anchor="middle" class="lbl">阶段 8 (P2): 能力映射</text>
  <text x="840" y="190" text-anchor="middle" font-size="10">SamplerConfig 单一</text>
  <text x="840" y="204" text-anchor="middle" font-size="10">RetryDecision 分类</text>

  <rect x="20" y="250" width="220" height="60" rx="6" class="p3"/>
  <text x="130" y="272" text-anchor="middle" class="lbl">阶段 9 (P2): 可观测性</text>
  <text x="130" y="290" text-anchor="middle" font-size="10">provider-diagnostic</text>
  <text x="130" y="304" text-anchor="middle" font-size="10">事件 schema 契约</text>

  <rect x="260" y="250" width="220" height="60" rx="6" class="p3"/>
  <text x="370" y="272" text-anchor="middle" class="lbl">阶段 10 (P2): UI 介入</text>
  <text x="370" y="290" text-anchor="middle" font-size="10">InterventionApprovalPipeline</text>
  <text x="370" y="304" text-anchor="middle" font-size="10">桌面端识别事件</text>

  <rect x="500" y="250" width="440" height="60" rx="6" class="p3"/>
  <text x="720" y="272" text-anchor="middle" class="lbl">阶段 11 (P3): 防回归</text>
  <text x="720" y="290" text-anchor="middle" font-size="10">端到端契约测试覆盖所有故障路径</text>
  <text x="720" y="304" text-anchor="middle" font-size="10">故障注入测试（parser 丢 tool_call / daemon 重启 / 503 / doom-loop）</text>

  <line x1="240" y1="80" x2="260" y2="80" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="480" y1="80" x2="500" y2="80" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="720" y1="80" x2="740" y2="80" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="840" y1="110" x2="840" y2="150" stroke="#333" marker-end="url(#arr6)" stroke-dasharray="4,2"/>
  <line x1="740" y1="180" x2="720" y2="180" stroke="#333" marker-end="url(#arr6)" stroke-dasharray="4,2"/>
  <line x1="240" y1="180" x2="260" y2="180" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="480" y1="180" x2="500" y2="180" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="720" y1="180" x2="740" y2="180" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="840" y1="210" x2="840" y2="250" stroke="#333" marker-end="url(#arr6)" stroke-dasharray="4,2"/>
  <line x1="740" y1="280" x2="720" y2="280" stroke="#333" marker-end="url(#arr6)" stroke-dasharray="4,2"/>
  <line x1="240" y1="280" x2="260" y2="280" stroke="#333" marker-end="url(#arr6)"/>
  <line x1="480" y1="280" x2="500" y2="280" stroke="#333" marker-end="url(#arr6)"/>
</svg>
```

### 6.2 阶段 1（P0）：解耦根因 A / B / C —— 软失败状态机 + 自适应解析器

**目标**：把 `intervention-required` 从硬失败改为软失败；解析器自适应响应格式，对无法识别的 tool_call 上报 diagnostic。

**改动**：

1. `packages/agent-runtime/src/state-machine/agent-session.ts` 新增状态 `awaiting-intervention`：
   - `streaming` / `steering-evaluation` --`INTERVENTION_REQUIRED`--> `awaiting-intervention`
   - `awaiting-intervention` --`USER_ROLLBACK`--> `done (endReason=aborted)`
   - `awaiting-intervention` --`USER_PAUSE`--> `done (endReason=stop)`
   - `awaiting-intervention` --`USER_INSTRUCTION`--> `preparing-turn`（重置 steeringCount）

2. `packages/agent-runtime/src/session-loop/index.ts:240, 503` 不再返回 `endReason: 'error'`，emit `runtime-intervention-required` 事件后让状态机停在 `awaiting-intervention`。

3. `packages/agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts:225-263` 把 `runtime-intervention-required` 映射为 `run.status="awaiting-approval"`，而非 `failed`。

4. 新增 `packages/agent-runtime/src/provider/adaptive-stream-parser.ts`，读首帧判断格式后分派到对应解析器。

5. `packages/agent-runtime/src/provider-openai-chat.ts:109-113` 在 `for (const call of pending.values())` 循环中，对 `!call.name` 的 pending 调用 emit `provider-diagnostic`。

6. `packages/agent-runtime/src/provider-openai-class.ts:204-208` `resolvedEndpoints()` 在 `auto` 时返回 `["chat-completions", "responses"]`（优先 Chat Completions）。

7. `packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts:116-120` 移除"有 tools 强制 Responses"逻辑，`auto` 默认 `chat-completions`。

**收益**：根因 R2、R3 解耦。即使 parser 修复后任何二次空响应也不再触发 intervention 终态失败；解析器对任何代理都健壮。

### 6.3 阶段 2（P0）：解耦根因 C —— Daemon 持久化非凭证 + endpointType 字段

**目标**：daemon 重启后非凭证配置立即就绪；用户可显式声明 profile 的端点能力。

**改动**：

1. `packages/agent-daemon/src/daemon-provider-gateway/types.ts` 新增 `DaemonProviderPersistentConfig` 类型，仅含 `providerId` / `routeId` / `model` / `upstreamModel` / `baseUrl` / `endpoint` / `stream` / `credentialMode` / `systemPromptWireMode`，不包含 `apiKey` / `accountId`。

2. `packages/agent-daemon/src/daemon-provider-gateway/index.ts` `DaemonProviderGatewayController` 增加 `loadPersistent(path)` / `savePersistent(path)` 方法，在 `update()` 时同步写盘。

3. `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:47-51` `runtimeConfigFromDaemonConfig` 改为从 `DaemonConfig` 读 model / baseUrl 等非凭证字段。

4. `apps/crish-desktop/src/api/provider-profiles/profileCatalog.ts:29-42` `ProviderProfile` 增加 `endpointType?: 'chat-completions' | 'responses' | 'auto'` 字段。预置 opencode-go / deepseek / qwen 等声明 `chat-completions`。

5. `packages/agent-daemon/src/server-runtime-factory/config-assembly.ts:91-114` `runtimeConfigFromRunMetadata` 增加 `maxSteeringMessages` / `maxConsecutiveToolErrors` / `maxRepeatedToolCalls` 读取。

**收益**：根因 R6 解耦。daemon 重启后非凭证配置立即就绪；run 启动时可按需调整 steering 预算。

### 6.4 阶段 3（P0）：解耦根因 A —— 消除跨 run 续轮 + 跨 run 状态清理

**目标**：续轮在循环内 `continue` 完成；新 run 不被上一 run 的错误消息误判。

**改动**：

1. `packages/agent-runtime/src/session-loop/index.ts:538-600` `handleTurnComplete` 在 `SHOULd_STOP` 之前新增 `stopGate.evaluate()`：
   - 返回 `AllowStop` → dispatch `SHOULd_STOP`。
   - 返回 `KeepWorking{feedback}` → 注入合成 user message 并 dispatch `NEXT_TURN`，循环内续轮。

2. `packages/agent-runtime/src/session-loop/index.ts:232-242` `handlePrepareTurn` 删除 `for (const phase of ['after-tools', 'before-turn'])` 循环，只保留 `before-turn` 评估；`after-tools` 评估移到 `handleExecutingTools` 的 `TOOLS_COMPLETE` 派发前。

3. `packages/agent-runtime/src/session-loop/index.ts` 在 `run()` 开始时记录 `runStartMessageIndex`，steering 扫描时切片 `[runStartMessageIndex:]`，不扫整个 `conversation`。

4. `packages/agent-runtime/src/steering/recovery-steering-strategy.ts:96-102` `detectRecoveryNeedFromMessages` 改为基于本轮 run 的结构化事件计数（如 `tool-error` 事件计数），而非扫描消息文本。

5. `packages/agent-runtime/src/session-loop/index.ts` 在 `run()` 开始时显式重置所有计数器：`steeringCount` / `lengthContinueNudgeCount` / `payloadRecoveryRetries` / `stationarityCount`。

6. `packages/agent-orchestrator/src/task-continuation-strategy.ts:108-122` `computeProgressSignature` 改为：若 progressSignature 与上一轮相同，`stalledRounds++`，否则重置为 0。

7. `packages/agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts:50-57` `DEFAULT_TASK_MAX_STALLED_ROUNDS` 从 1000 改为 3。

**收益**：根因 R1、R7 解耦。续轮状态天然连续；新 run 不被历史错误消息污染。

### 6.5 阶段 4（P1）：解耦根因 B / E —— ErrorRecoveryClassifier + intervention 降级

**目标**：每种错误类型有独立预算与恢复路径；intervention 仅在所有恢复手段耗尽后才触发。

**改动**：

1. 新增 `packages/agent-runtime/src/recovery/error-recovery-classifier.ts`，纯函数 `classifyRecoveryNeed(error, context): RecoveryDecision`，按错误类型分级：
   - `empty-response`：3 次 steering
   - `tool-error-loop`：2 次 steering + 1 次 nudge
   - `repeated-tool-call`：nudge@3 / 硬停@6
   - `transient-provider`：3 次重试 + backoff
   - `context-length`：致命，不重试
   - `payload-too-large`：剥图重试 1 次
   - `auth-expired`：刷新 token 重试
   - `doom-loop`：独立预算 + mid-stream abort
   - `invalid-tool-call`：注入 steering 提示，重置 steeringCount（因为不是 AI 的错）

2. `packages/agent-runtime/src/steering/recovery-steering-strategy.ts` 删除 `maxSteeringMessages` 字段，策略不再持有预算；改为只判定"是否需要纠偏"，由 `SteeringCoordinator` 在 `apply()` 时检查预算。

3. `packages/agent-runtime/src/steering/steering-coordinator.ts` 把 `evaluate()` 改为返回 `actions` 后由 `apply()` 统一检查预算：超预算时把 `inject-message` 转换为 `intervention-required`。

4. `packages/agent-runtime/src/runtime-defaults.ts:65` `maxSteeringMessages` 从 1 提升到 3（与 `SteeringCoordinatorOptions.maxSteeringBudget` 默认值对齐）。

5. `packages/agent-runtime/src/session-loop/index.ts:495` 的 `handleSteeringEvaluation` 删除本地 `maxSteering` 检查（已成为死代码），完全委托给 `SteeringCoordinator`。

6. `packages/agent-runtime/src/session-loop/index.ts:362-373` 在 `ar.type === 'empty-response'` 分支前优先检查 `consumeResult.diagnostics` 中是否有 `invalid-tool-call`，若有则走专门路径。

**收益**：根因 R2、R5 解耦。普通工具错误不再耗尽全局预算；intervention 仅在专属预算耗尽后触发。

### 6.6 阶段 5（P1）：解耦根因 D —— 工具失败编码而非抛出 + tool_use/result 配对

**目标**：工具失败不再终止循环；length 截断的 toolCall 残留有 placeholder toolResult 配对。

**改动**：

1. `packages/agent-runtime/src/session-loop/index.ts:522-523` 移除 `findFatalToolError` 的黑名单语义：
   - 工具 `execute` 抛异常 → 编码为 `isError=true` 的 toolResult，`TOOLS_COMPLETE` 继续下一轮。
   - 仅当工具主动声明 `terminate` 时才终止 run。
   - 保留 `PermissionReject` / 用户 cancel 的终态语义。

2. 新增 `packages/agent-runtime/src/runtime-components/coerce-tool-result.ts`，在 `ToolExecutionCoordinator` 的 execute 返回点统一加防御层：缺 content → error result；非法 block → 过滤；保留工具自带 `isError`。

3. `packages/agent-runtime/src/session-loop/index.ts:471-491` `handleNoToolCalls` 的 `stopReason=length` 分支：除了现有的 maxTokens 升级，额外检查 assistant message 是否含 toolCall block；若有，为每个生成 placeholder toolResult 并入 conversation，文案采用 oh-my-pi 的"拆分 payload"提示。

4. `packages/agent-runtime/src/provider-openai-chat.ts:109-113` 流结束时若有 `pending` 中工具调用但 `finishReason` 不是 `tool-call`，强制覆盖为 `tool-call`（对齐 grok-build 的 `finish_reason` 兜底）。

5. `packages/agent-runtime/src/provider-openai-chat.ts:78-114` 在每收到一段 `function.arguments` delta 时立即 yield 一个 `tool-call` + `phase: "delta"` 事件（增量广播，对齐 pi / grok-build）。

**收益**：根因 R4 解耦。工具失败由模型自决策；tool_use/tool_result 配对契约显式维护；UI 实时渲染入参生成。

### 6.7 阶段 6（P1）：StopGate + CompletionRequirement

**目标**：把"何时停止"从单一判断点扩展为可扩展的 gate 链；显式任务完成契约。

**改动**：

1. 新增 `packages/agent-runtime/src/session-loop/stop-gate.ts`，实现 §5.2 接口。`MAX_STOP_GATE_CONTINUATIONS_PER_TURN = 8`。

2. 新增 `packages/agent-runtime/src/completion-requirement/index.ts`，实现 §5.10 接口。在 `AgentRuntimeOptions` 里加 `completionRequirement?: CompletionRequirementConfig`。

3. `packages/agent-runtime/src/session-loop/index.ts` `handleTurnComplete` 的 stop gate 之前评估 `CompletionRequirement.evaluate(toolsCalled)`，不满足则 `injectRecoveryPrompt`。

4. `packages/agent-orchestrator/src/task-continuation-strategy.ts:97-105` 在 `return { action: "continue", ... }` 前检查 `stalledRounds >= 2`，若是则改为 `block`。

**收益**：外部 hook 可强制继续；agent 必须调用必备工具才算完成；task 模式 3 轮无进展后 blocked。

### 6.8 阶段 7（P2）：状态单点所有权

**目标**：所有对话状态由单一组件管理，prune / compaction / request build 集中。

**改动**：

1. 新增 `packages/agent-runtime/src/state/conversation-state-store.ts`，实现 §5.8 接口。把 `ConversationEngine` + `ContextManager` + `ledger` + `recorder` 的状态所有权收敛到该组件。

2. 把 `provider-call.ts` 的 `buildProviderCall` prune 逻辑移到 `ConversationStateStore.buildProviderRequest`，对齐 grok-build 的 `should_prune`（在 `total_tokens > context_window / 2` 时触发）。

3. 新增 `repairHistory()` / `repairDanglingAfterHalt()` 显式 repair 命令。

**收益**：根因 R7 完全解耦。状态操作天然序列化，compaction 与 turn 执行不会 race。

### 6.9 阶段 8（P2）：跨供应商能力映射

**目标**：SamplerConfig 单一配置对象 + per-request override；RetryDecision 分类驱动。

**改动**：

1. 新增 `packages/agent-runtime/src/provider/sampler-config.ts`，实现 §5.6 接口。把 `provider` / `systemPrompt` / `maxTokens` / `thinkingIntensity` 合并为单一对象。

2. `packages/agent-runtime/src/provider/provider-call-gateway.ts` 的 `providerCall` 支持 per-call override。

3. 新增 `packages/agent-runtime/src/provider/retry-classifier.ts`，实现 §5.7 接口。按错误类型分类：image strip / HTTP/1.1 rebuild / standard backoff / fatal。`retry_only_before_output` 标志在观察到 output token 后禁用重试。

4. `packages/agent-runtime/src/session-loop/provider-call.ts` 引入 `RetryDecision` 等价物，把 `providerConsumer` 的"已观察到 output"信号反馈给重试决策。

5. `packages/agent-runtime/src/provider-openai-chat.ts` 把 `parseChatCompletionsStreamingResponse` 的空响应视为瞬时错误，重试而非 steering（避免污染对话历史）。

**收益**：根因 R5 完全解耦。配置单一来源；流式重试不重复内容。

### 6.10 阶段 9（P2）：可观测性

**目标**：所有"识别失败"显式上报；事件 schema 契约校验。

**改动**：

1. `packages/agent-runtime/src/provider-stream-contract/types.ts` 扩展 `ProviderStreamContractEvent` 支持 `phase: "delta"` 与 `provider-diagnostic`。

2. `packages/agent-runtime/src/runtime-components/provider-response-consumer.ts:75-78` 把 `invalid-tool-call` 类 diagnostic 收集到 `diagnostics` 数组，并在 `ConsumeResult` 中暴露 `sawInvalidToolCall: boolean`。

3. 新增 `packages/agent-runtime/src/event-architecture/event-schema-contract.ts`，定义 daemon 事件类型与桌面端处理路径的契约校验（lint 级别）。

4. `packages/agent-runtime/src/event-architecture/canonical-event.ts` 把 `runtime-intervention-required` 事件的 `choices` 字段改为 `requestId`，由桌面端 ApprovalPipeline 走与 `approval-requested` 同构的 UI 路径。

**收益**：根因 R3、R8 解耦。任何识别失败可观测；事件 schema 强制校验。

### 6.11 阶段 10（P2）：UI 介入

**目标**：用户能看到 daemon 提供的 `choices`，并主动选择 `rollback` / `pause` / `user-instruction`。

**改动**：

1. `apps/crish-desktop/src/api/daemonEventZod.ts` 增加 `runtime-intervention-required` 事件 schema。

2. `apps/crish-desktop/src/api/daemonChatBridge/handlers/eventType.ts` 把 `runtime-intervention-required` 路由到与 `approval-requested` 同构的处理路径。

3. `apps/crish-desktop/src/api/runControlClient.ts` 增加 `respondIntervention(runId, choice, userInstruction?)` 方法。

4. `packages/agent-daemon/src/handlers/run-handlers/lifecycle/run-handler.ts` 增加 `respond-intervention` handler，根据 choice 派发到 `ControlBus.requestCooperativeStop`（pause）、`abort`（rollback）或 `AgentRuntime.enqueueSteerInput`（user-instruction）。

5. `packages/agent-runtime/src/session-loop/index.ts` 的 `applySafePointControl` 增加 `intervention-response` 控制类型。

**收益**：用户从"看到失败"升级为"看到介入请求并可选择"。

### 6.12 阶段 11（P3）：防回归

**目标**：把所有故障路径固化为契约测试。

**改动**：

1. `packages/agent-runtime/src/__tests__/integrations/state-machine.test.ts` 增加：
   - `maxSteeringMessages=3 + 三次 empty-response → 进入 awaiting-intervention（而非 done）`
   - `intervention-required + user-instruction → 重置 steeringCount 后继续 run`
   - `stop-gate KeepWorking → 循环内 continue（不跨 run）`

2. `packages/agent-runtime/src/provider/__tests__/e2e/stream-parser.test.ts` 增加：
   - `streaming tool_call 缺失 function.name → emit provider-diagnostic{phase:'invalid-tool-call'}`
   - `非标准 function_name 字段 → 兼容识别成功`
   - `opencode-go profile + /responses 返回 Chat Completions 格式流 → 自适应解析器识别 → 工具调用正确解析`
   - `模型漏设 finish_reason: "tool_calls" 但有 tool_calls delta → 兜底为 tool-call 停止原因`

3. `packages/agent-orchestrator/src/orchestrator.test.ts` 增加：
   - `task 模式连续 3 轮相同 progressSignature → blocked（goal-stalled）`
   - `runtime-intervention-required 事件 → run.status=awaiting-approval（而非 failed）`

4. `packages/agent-daemon/src/server.test.ts` 增加：
   - `daemon 重启后从持久化文件恢复 model/baseUrl（无 apiKey）`
   - `runtimeConfigFromRunMetadata 读取 maxSteeringMessages 覆盖默认值`

5. 故障注入测试：模拟 parser 丢 tool_call、daemon 重启、provider 503、doom-loop。

**收益**：把系统化改进的语义固化为可执行断言，避免后续重构回归。

---

## 7. 验证策略

### 7.1 验证维度

| 维度 | 验证目标 | 验证手段 |
|------|----------|----------|
| **状态机完整性** | `awaiting-intervention` 软失败路径可达且可恢复 | 单元测试 + 状态机模型检查 |
| **续轮闭环** | 续轮在循环内 `continue` 完成，不跨 run | 集成测试 + run 上下文一致性断言 |
| **工具调用链路** | 任何 provider 响应格式都能正确解析 tool_call | 端到端测试 + 故障注入 |
| **错误恢复分级** | 每种错误类型有独立预算，不互相耗尽 | 单元测试（纯函数）+ 预算耗尽场景测试 |
| **配置生命周期** | daemon 重启后非凭证配置立即就绪 | 集成测试 + 重启模拟 |
| **事件 schema 一致性** | 桌面端识别所有 daemon 事件类型 | 契约测试 + lint 校验 |
| **可观测性** | parser 识别失败有 diagnostic | 单元测试 + diagnostic 事件断言 |
| **跨 run 状态隔离** | 新 run 不被上一 run 错误消息误判 | 集成测试 + run-scoped message slice 断言 |

### 7.2 关键场景验证

#### 7.2.1 场景 1：opencode-go + deepseek-v4-flash + 工具调用

**预期**：
- `endpointType` 未设置 → 走 Chat Completions（默认）。
- 工具调用正确解析，`toolCount > 0`。
- AI 连续调用工具完成多步任务，不单轮即断。

**验证点**：
- `parseChatCompletionsStreamingResponse` 产出 `tool-call` 事件。
- `toolCallCount > 0` → `executing-tools` → `turn-complete` → `stop-gate-evaluation` → `KeepWorking` 或 `AllowStop`。
- 无 `runtime-intervention-required` 事件。

#### 7.2.2 场景 2：parser 静默丢弃场景

**预期**：
- `function.name` 缺失 → emit `provider-diagnostic{phase:'invalid-tool-call'}`。
- `ProviderResponseConsumer.sawInvalidToolCall === true`。
- steering 注入针对性提示："上游解析器未识别上一轮 tool_call 结构，请用标准 OpenAI tool_calls 字段重新发起调用"。
- 重置 steeringCount（因为不是 AI 的错）。
- AI 重新发起工具调用，成功执行。

**验证点**：
- diagnostic 事件被收集。
- steering 消息内容包含"标准 OpenAI tool_calls 字段"。
- 第二轮 `toolCallCount > 0`。

#### 7.2.3 场景 3：daemon 重启后立即发消息

**预期**：
- daemon 从持久化文件恢复 model / baseUrl / endpoint。
- `providerStatus.gateway.ready === true`。
- run 启动时 provider 已就绪，无 `provider_factory_missing`。
- apiKey 通过 `credentialMode='account-center'` 凭证解析器拉取。

**验证点**：
- daemon 重启后 1 秒内 `gateway.ready === true`。
- run 启动无 `Runtime config validation warnings`。

#### 7.2.4 场景 4：连续空响应 + intervention 软失败

**预期**：
- 三次 `empty-response`（`maxSteeringMessages=3`）→ steering 预算耗尽。
- `intervention-required` 事件上抛。
- run 进入 `awaiting-intervention` 状态，不 `failed`。
- 桌面端弹出介入对话框，显示 `choices`。
- 用户选择 `user-instruction` → 注入用户输入 → 重置 steeringCount → 继续 run。

**验证点**：
- `run.status === 'awaiting-approval'`（而非 `failed`）。
- 桌面端 `runtime-intervention-required` 事件被识别。
- 用户选择后 run 继续，`steeringCount === 0`。

#### 7.2.5 场景 5：工具失败不终止循环

**预期**：
- 工具 `execute` 抛异常 → 编码为 `isError=true` 的 toolResult。
- `TOOLS_COMPLETE` 继续下一轮，不 `endReason='error'`。
- AI 看到 isError toolResult，自行决定重试或换路。

**验证点**：
- `endReason !== 'error'`。
- conversation 中有 `isError=true` 的 toolResult。
- 下一轮 AI 响应包含重试或换路行为。

#### 7.2.6 场景 6：跨 run 状态隔离

**预期**：
- 第一轮 run 以错误收尾，错误消息残留在 conversation。
- 第二轮 run 启动时 `runStartMessageIndex` 记录当前位置。
- steering 扫描只看 `[runStartMessageIndex:]`，不触发误判。
- 所有计数器重置：`steeringCount === 0` / `lengthContinueNudgeCount === 0`。

**验证点**：
- `detectRecoveryNeedFromMessages` 不返回上一 run 的错误循环。
- 第二轮 run 的 `preparing-turn` 不触发 `INTERVENTION_REQUIRED`。

### 7.3 验证指标

| 指标 | 当前 | 目标 |
|------|------|------|
| 单轮即断发生率 | 高（默认行为） | < 1%（仅在 fatal 错误时） |
| `runtime-intervention-required` 频率 | 频繁（二次空响应即触发） | 罕见（三次 steering 耗尽才触发） |
| daemon 重启后 run 启动成功率 | 低（依赖桌面端推送时序） | 100%（非凭证配置立即就绪） |
| 工具调用丢失率（opencode-go） | 100%（端点选择错误） | 0%（自适应解析器） |
| 跨 run 状态污染误触发率 | 高（扫描整个 conversation） | 0%（run-scoped slice） |
| 工具失败导致 run 终态失败率 | 高（黑名单式终止） | 0%（编码而非抛出） |
| 桌面端 intervention 事件识别率 | 0%（未实现） | 100%（schema 契约校验） |

### 7.4 持续验证机制

1. **CI 契约测试**：所有 §6.12 的测试在 CI 强制运行，任何回归阻断合并。
2. **事件 schema lint**：daemon 新增事件类型时，桌面端必须有对应处理路径，否则 lint 失败。
3. **故障注入混沌测试**：每周自动注入 parser 丢 tool_call、daemon 重启、provider 503、doom-loop 等故障，验证系统行为符合预期。
4. **可观测性仪表盘**：监控 `provider-diagnostic` 事件率、`intervention-required` 触发率、`awaiting-intervention` 状态停留时长、续轮成功率。

---

## 8. 附录：根因与重构阶段映射

| 根因 | 对应阶段 | 验证场景 |
|------|----------|----------|
| R1 续轮跨 run | 阶段 3 | 场景 6 |
| R2 预算耦合终态 | 阶段 1 / 阶段 4 | 场景 4 |
| R3 解析器静默丢弃 | 阶段 1 / 阶段 9 | 场景 1 / 场景 2 |
| R4 工具失败耦合 run | 阶段 5 | 场景 5 |
| R5 错误分类分散 | 阶段 4 / 阶段 8 | 场景 4 |
| R6 配置未解耦 | 阶段 2 | 场景 3 |
| R7 状态不清理 | 阶段 3 / 阶段 7 | 场景 6 |
| R8 事件 schema 无校验 | 阶段 9 / 阶段 10 | 场景 4 |

---

## 9. 结论

conex agent loop 的"AI 一句话就断 / intervention 风暴 / 续轮被架空"问题不是单点 bug，而是 8 条架构层根因（R1-R8）相互放大导致的系统性故障。

本方案不做补丁式或兼容式改进，而是从架构层重新划分：

1. **编排层永不单方面终止**：`intervention-required` 降级为软失败，run 进入 `awaiting-intervention` 等待用户决策。
2. **续轮在循环内完成**：消除跨 run 续轮，引入 `StopGate` 让 hook 可否决停止。
3. **工具调用链路端到端可信**：解析器自适应响应格式 + diagnostic 上报 + 工具失败编码而非抛出 + tool_use/result 配对契约。
4. **错误恢复基于错误类型分级**：`ErrorRecoveryClassifier` 单一真理源，每种错误类型独立预算。
5. **状态单点所有权**：`ConversationStateStore` 集中管理所有状态，跨 run 显式清理。
6. **配置与凭证分离**：daemon 持久化非凭证配置，apiKey 通过凭证解析器拉取。
7. **跨供应商能力映射**：`SamplerConfig` 单一配置对象 + `RetryDecision` 分类驱动 + 自适应解析器。
8. **事件 schema 契约校验**：daemon 与桌面端事件类型强制一致。

11 个迁移阶段按"先解耦根因（P0），再消除耦合（P1），最后补可观测性（P2/P3）"的顺序推进，每一步都是结构化重构。所有故障路径固化为契约测试，确保不回归。

完成本方案后，conex agent loop 将具备：单轮即断发生率 < 1%、intervention 触发率罕见且可恢复、daemon 重启后 100% 可用、工具调用 0 丢失、跨 run 状态 0 污染。
