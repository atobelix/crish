# 03 · Goal 长程闭环与软件内 AI 测试

**状态**: 方案定稿（待多 Agent 执行）  
**日期**: 2026-07  
**上游**: [`audits/00-master-findings.md`](../audits/00-master-findings.md) · [`README.md`](../README.md)  
**范围**: 桌面 `/goal` ↔ 引擎 `driveGoalRun` 统一；完成门禁；reflection/格式修复；**真实 Tauri 软件内** AI 测试采集层

---

## 0. 硬约束（测试哲学，全文适用）

| 约束                | 含义                                                                   | 反例（禁止当主验收）                                  |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| **软件内测**        | 必须 **WebView2 + Tauri 壳 + 本地 daemon** 一体运行                    | 仅打开 Vite `localhost:5173` 浏览器端口测「系统能力」 |
| **真背压 / 真审批** | 须走 binary frame `STREAM_PAUSE`/`RESUME`、审批闸、工作区写、MCP stdio | 纯前端 mock WS、Jest 假 daemon、无磁盘副作用的冒烟    |
| **AI 长程可信**     | 轨迹事件 + **磁盘 oracle** 判定完成；禁止「模型说 DONE 就算完成」      | 仅看 ribbon 文案或 checklist 全勾                     |
| **computer-use**    | **仅夜间探索层**，不进主 CI 门禁                                       | 把 OS 级 GUI 自动化当 P0 阻塞项                       |

单元/包测可继续跑；**本方案定义的验收与回归必须以软件内 runner 为准。**

---

## 1. 问题陈述：双轨 Goal

### 1.1 现状两条平行路径

| 维度       | 轨 A · 桌面 `/goal`（产品路径）                                                    | 轨 B · 引擎 `driveGoalRun`（编排权威）                                             |
| ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 入口       | `useChatStream` 解析 `/goal` → `createInitialGoalMode`                             | `Orchestrator.startGoalRun` / `StartGoalRunRequest`                                |
| 循环宿主   | 前端 `decideGoalContinuation`（`goalModeController.ts`）                           | `packages/agent-orchestrator` 内 `driveGoalRun`                                    |
| 默认上限   | **5 轮**（`GOAL_DEFAULT_MAX_ITERATIONS = 5`）                                      | 常 **12 轮** 量级 + `maxStalledRounds`（workbench 另有 snapshot 策略）             |
| 完成条件   | 助手正文 `DONE` /「目标已完成」正则 **或** checklist 全勾 → `markAllGoalTasksDone` | 策略 `assessRound` + `progressSignature` + stall；事件 `goal-continuation-decided` |
| 续写注入   | 前端 `buildGoalModePrefix` + 伪 user 续写消息 `user-msg-goal-*`                    | 引擎 round prompt / strategy `buildNextPrompt`                                     |
| 可观测     | ribbon `data-goal-*`、session `goalMode`、`__crishStreamDiag`                      | `goal-round-started` / `goal-round-completed` / `goal-continuation-decided`        |
| 与桌面关系 | **产品用户实际走这里**                                                             | **桌面当前不传 `mode/visibleGoal/maxRounds` → 不进入本轨**                         |

硬证据（审计浓缩）：

- 桌面 `/goal` **不传** `mode: "goal"` / `visibleGoal` / `maxRounds` → 引擎走普通 run，**不进** `driveGoalRun`。
- 完成 = `replyLooksGoalDone`（`/\bDONE\b/i` 或「目标已完成」）或 tasks 全 `done`；`markAllGoalTasksDone` 可在文案 DONE 时**强制勾满**，造成 TasksCard 与真实进度假对齐。
- 桌面无 stalled 签名；Stop 清 `goalMode`；审批 defer 后仍可能续写。
- 引擎 `goal-round-*` 事件在**桌面路径上不可见**（因为根本没进 goal run）。

另：历史上 workbench `runWorkbenchGoal` 与 orchestrator `driveGoalRun` 也曾双实现；策略下沉方向是 **`driveGoalRun` + `GoalLoopStrategy`**（`EventScanGoalStrategy` / snapshot-aware）。本方案的产品对齐目标是：**桌面长程与引擎长程同一语义**，不再维护「前端 5 轮文本环」作为权威。

### 1.2 危害

1. **盲目乐观完成（P0）**：模型输出 `DONE` 即可停机，无磁盘/验收证据。
2. **能力分叉**：引擎 stall、maxRounds、continuation 决策、provider 退避对真实用户无效。
3. **测试不可信**：在浏览器测 UI checklist 通过 ≠ 软件内长程可信。
4. **观测盲区**：无法用统一 `goal-round` 事件做轨迹回放与回归对比。

---

## 2. 目标

### 2.1 产品目标

| 目标           | 验收口径（软件内）                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **统一长程**   | `/goal` 下发引擎 goal run（`mode: goal` + `visibleGoal` + `maxRounds` + stall 配置）；前端 `goalMode` 仅为 **投影/UI**，不自建权威循环 |
| **反盲目乐观** | 完成门禁：**文案 DONE 不足**；须策略判定 +（可配置）**磁盘 oracle** / 验收证据；禁止 `markAllGoalTasksDone` 在无证据时假勾满           |
| **可观测**     | 每轮有 `goal-round-*` + 前端 ribbon/`toolCalls`/stream diag 同源；失败可定位到 round、tool、审批、背压                                 |
| **可续跑**     | max_iter / stalled / 用户暂停后可从同一 goal 状态安全续跑，不丢 checklist 与证据指针                                                   |

### 2.2 非目标（本方案不展开）

- 重写全部 multi-provider 原生协议（见其他 plan）。
- 把 computer-use 做成默认 E2E。
- 用浏览器 Playwright 替代 Tauri 内测作为主门禁。

---

## 3. 架构目标态

```
用户 /goal <目标>
        │
        ▼
  crish-desktop（Tauri）
  · 解析 slash → 展示 ribbon / TasksCard（投影）
  · WS/IPC startRun: { mode: "goal", visibleGoal, maxRounds, maxStalledRounds, … }
        │
        ▼
  daemon / agent-orchestrator
  · startGoalRun → driveGoalRun
  · GoalLoopStrategy.assessRound / progressSignature / stall
  · emit: goal-round-started | goal-round-completed | goal-continuation-decided
  · 工具链：TrustZone + Approval + STREAM_PAUSE 背压
        │
        ▼
  完成门禁
  · 非仅 DONE 文案
  · 可选 DiskOracle（工作区文件/命令输出哈希/约定路径）
  · reflection 预算耗尽或 stalled → blocked（非 success）
        │
        ▼
  In-app Test Runner（软件内）
  · 假/真 provider 轨迹 · 事件采集 · 与 oracle 对齐 · 报告落盘
```

### 3.1 权威与投影

| 数据                               | 权威位置                                                   | 桌面职责                           |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| 是否 goal run、round 计数、stalled | 引擎 run.goal                                              | 订阅事件投影到 `session.goalMode`  |
| checklist UI                       | 可仍解析助手 markdown，但 **done 判定不单独决定 run 成功** | 展示 + 与引擎 decision 对齐        |
| 用户取消                           | 引擎 cancel + 前端 clear                                   | 禁止仅清本地 `goalMode` 而引擎仍跑 |

### 3.2 与 workbench 策略关系

- 产品对话路径：默认 `EventScanGoalStrategy`（或后续统一策略名）。
- workbench CLI / 审计型长任务：可插 `SnapshotAwareGoalStrategy`。
- **禁止** 再新增第三条「前端文本环」权威实现；旧 `decideGoalContinuation` 仅过渡期兼容，R2 后降级为投影辅助或删除自动续写权威。

---

## 4. 完成门禁 · 格式修复 · Reflection · 续跑

### 4.1 完成门禁（反盲目乐观）

**分级判定（建议默认）**：

| 级别           | 条件                                                  | 结果                                 |
| -------------- | ----------------------------------------------------- | ------------------------------------ |
| L0 文案信号    | `DONE` /「目标已完成」                                | **仅候选**，不足 success             |
| L1 结构化      | checklist 全勾 **且** 引擎 decision.action = complete | 可 complete（弱任务）                |
| L2 证据        | 策略要求的 tool 成功证据 / snapshot 验收项            | 默认产品路径应达 L2 才 success       |
| L3 磁盘 oracle | 约定路径存在、内容匹配、命令退出码等                  | **软件内 AI 测试强制**；长程回归强制 |

规则：

1. `replyLooksGoalDone` **不得**单独触发 `reason: 'done'` 终态 success。
2. `markAllGoalTasksDone` 仅在 L2/L3 通过后同步 UI；禁止「文案 DONE → 强制全勾」。
3. stalled（`progressSignature` 连续相同 ≥ `maxStalledRounds`）→ **blocked**，文案可提示「无进展」，**不是**完成。
4. 达 `maxRounds` → blocked/`max-rounds`，保留 tasks 缺口，允许用户「续跑」。

### 4.2 格式修复（tool / 参数）

现状：工具 error 会回灌 tool-result，但缺统一「格式修复状态机」。

目标行为：

- 参数 schema 失败 → 结构化 `repair` 提示（非裸 throw 杀整 run，除非 `fatalOnError` 明确生效）。
- 同一 tool 连续 repair 超预算 → reflection 或 escalate（见 4.3）。
- 记录 `toolCalls` 与 repair 次数到轨迹，供 in-app runner 断言。

### 4.3 Reflection（结构化，非散文自嗨）

引入轻量状态（概念，实现可挂 run 元数据）：

```
normal → format_repair → reflect → (continue | blocked | needs_approval)
```

| 字段                | 说明                                                 |
| ------------------- | ---------------------------------------------------- |
| `reflectionBudget`  | 每 goal 或每 round 可配置次数                        |
| `lastFailureClass`  | schema / permission / no-progress / provider         |
| `denialFeedback`    | 审批拒绝的**结构化**文案回灌（禁止仅 `user-denied`） |
| `progressSignature` | 与 stall 共用                                        |

要点：

- Synthesis / 反思注入 **禁止污染** 为普通 user 角色 transcript（审计已点名）；用 system/内部 role 或独立 event。
- denial 后：UI 必须可见失败（toast/ribbon），且 LLM 收到可行动反馈（缺什么权限、改用何策略）。
- reflection 耗尽 + 仍无进展 → 与 stalled 合流为 blocked。

### 4.4 续跑（continuation / resume）

| 场景                  | 期望                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| max_iter / max-rounds | 用户确认或 `/goal continue`：沿用 `visibleGoal`、tasks、证据指针，**新 round 计数策略明确**（续跑配额 vs 累计） |
| stalled blocked       | 允许改 prompt / 放宽策略后 resume；signature 重置规则写清                                                       |
| 审批 defer            | **暂停** goal 续写，批准后再 `goal-round`；禁止 defer 期间前端偷偷 continue                                     |
| 用户 Stop             | 引擎 cancel + 投影清理一致；磁盘 oracle 保留供复盘                                                              |
| 断线 / STREAM_PAUSE   | 背压恢复后同一 run 续流；测试须采集 pause 帧                                                                    |

---

## 5. In-app AI 测试采集层

### 5.1 原则

- Runner **驻留或附着于 Tauri 应用进程**（或受控 sidecar 连同一 daemon），驱动真实 UI/IPC。
- **禁止**把「仅浏览器打开 dev server」记为系统能力通过。
- 假 provider：可注入确定性轨迹；真 provider：可选夜间加长任务。
- 每 case 落盘：`events.jsonl` + `oracle-report.json` + 可选截图（非 computer-use 主链）。

### 5.2 必采信号清单

| 通道       | 采集项                                                                                        | 用途                         |
| ---------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| 会话/投影  | `goalMode`：`active/goal/iteration/maxIterations/tasks`                                       | UI 与引擎 round 对齐         |
| Ribbon DOM | `data-goal-iteration`、`data-goal-tasks-done`、`data-goal-tasks-total`（`ChatStatusRibbons`） | 软件内 UI 断言               |
| 续写消息   | `user-msg-goal-*` id 模式（过渡期）；统一后改为引擎驱动的可见续写标记                         | 防双发、计轮                 |
| 流诊断     | `window.__crishStreamDiag()` / stream diag 环形缓冲                                           | 帧序、断流、错误             |
| 工具       | `toolCalls`（名、参数摘要、结果、repair 次数、permission）                                    | 格式修复 / denial            |
| 磁盘       | **oracle**：约定文件/目录/退出码/内容哈希                                                     | 反盲目乐观                   |
| 传输       | binary `STREAM_PAUSE` `0x21` / `STREAM_RESUME` `0x22` 及 meta `runId`                         | 真背压                       |
| 审批       | approval machine 状态：pending / approved / denied / timeout                                  | 不得 throw 杀 run（P0 对齐） |
| 引擎事件   | `goal-round-started`、`goal-round-completed`、`goal-continuation-decided`、run terminal       | **桌面接通后必有**           |

### 5.3 假 Provider 轨迹

为可重复软件内测，定义轨迹 DSL（示例语义，非强制语法）：

```text
round0: assistant text + tool_call(write_file)
round1: tool_result ok + assistant checklist partial
round2: assistant claims DONE without oracle   → expect NOT success
round3: tool_call satisfies oracle + complete  → expect success
```

并行轨迹：

- **schema_fail_then_repair**：参数错误 → repair → 成功。
- **denial_then_replan**：审批 deny → 结构化反馈 → 换工具或停止。
- **stall_flat**：多轮相同 signature → blocked。
- **pause_under_load**：大 delta 触发前端水位 → `STREAM_PAUSE` → 恢复。

### 5.4 Oracle 约定

- 每 case 声明 `oracle: { path, expect: exists|content|jsonpath|sha256 }`。
- Runner 在 run terminal 后读盘；**仅 UI DONE 而 oracle 失败 = case fail**。
- 工作区隔离：临时 workspace per case，测完可保留失败产物。

### 5.5 报告与门槛

- 主 CI（软件内冒烟）：假 provider 子集 + oracle + 至少一轮真实 `STREAM_PAUSE` 路径（可用加压假流）。
- 夜间：真 provider 长程 +（可选）computer-use 探索，**失败不阻断日间门禁**，仅告警。

---

## 6. 多轮多 Agent 执行计划

**编排约定**：每轮 **≥ 4 个 Agent 并行**；每 Agent 有明确 I/O 与「软件内验收」勾选。  
**全局禁止**：用浏览器端口结果顶替 Tauri 验收。

---

### R1 · 产品契约与 API 打通 `mode: goal`

**目标**：桌面 `/goal` 真正进入 `driveGoalRun`；投影与事件贯通。

| Agent               | 职责                                                                                                                                                              | 交付                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **R1-A 契约**       | 定义 `StartRun`/`StartGoalRun` 桌面字段：`mode: "goal"`、`visibleGoal`、`maxRounds`、`maxStalledRounds`、可选 `reflectionBudget`；与 `shared-types` / daemon 对齐 | OpenAPI 或 TS 类型 + 变更说明 |
| **R1-B 桌面发送**   | `useChatStream` / stream API：`/goal` 不再只靠本地 `createInitialGoalMode` 权威循环；下发引擎字段；本地 `goalMode` 初始化为投影                                   | 代码 + 单测                   |
| **R1-C 引擎接线**   | 确认 daemon 路由 `kind===goal` → `driveGoalRun`；事件下发到桌面可订阅通道                                                                                         | 集成说明 + 事件映射表         |
| **R1-D 软件内冒烟** | Tauri 起真应用：`/goal` 简单目标 + 假 provider；断言出现 `goal-round-started/completed`，ribbon `data-goal-*` 随 round 变                                         | **软件内** 报告路径           |

**R1 完成门禁**：

- [ ] 抓包/日志证明请求含 `mode: goal`（或等价枚举）。
- [ ] 软件内可见 ≥1 次 `goal-round-completed`。
- [ ] 未进 goal 的旧路径有特性开关或明确废弃日志。

---

### R2 · 完成门禁与 stalled

**目标**：消灭 DONE 假完成；stall 可观测、可测。

| Agent               | 职责                                                                                             | 交付          |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------- |
| **R2-A 门禁逻辑**   | 引擎侧 complete 条件与 L0–L3；移除/改造「仅 DONE → success」；限制 `markAllGoalTasksDone`        | 纯函数 + 单测 |
| **R2-B Stall**      | 桌面投影 `stalledRounds` / blockedReason；ribbon 或 Tasks 展示「无进展」；stop reason 与引擎一致 | UI + 投影     |
| **R2-C 假轨迹**     | 轨迹：提前 DONE 无 oracle → fail；平台 signature → blocked                                       | fixture       |
| **R2-D 软件内断言** | Tauri runner：两 case 必过（假完成拒绝、stalled blocked）                                        | 软件内报告    |

**R2 完成门禁**：

- [ ] 无 oracle 的 DONE **不能**标 run success。
- [ ] stalled 达阈值 → blocked，非 completed。
- [ ] 软件内报告附带事件时间线。

---

### R3 · Reflection + denial feedback

**目标**：格式修复与审批拒绝可行动、可计量。

| Agent                    | 职责                                                      | 交付            |
| ------------------------ | --------------------------------------------------------- | --------------- |
| **R3-A Reflection 状态** | 预算、failure class、与 stall 合流；事件或 run 元数据可采 | 设计 + 实现骨架 |
| **R3-B Denial 结构化**   | 拒绝原因枚举 + 回灌模板；UI 失败反馈（禁假成功）          | 工具链 + UI     |
| **R3-C 格式修复**        | schema 失败 repair 环；超预算进入 reflect                 | 单测 + 轨迹     |
| **R3-D 软件内**          | deny 轨迹 + repair 轨迹在 Tauri 内跑通并采集 `toolCalls`  | 软件内报告      |

**R3 完成门禁**：

- [ ] denial 后 LLM 输入含结构化原因（抽检轨迹）。
- [ ] UI 对 deny 有可见失败，非静默。
- [ ] repair 次数进入采集字段。

---

### R4 · In-app 测试 runner + 假 provider 轨迹

**目标**：可重复的软件内 AI 测试 harness。

| Agent                  | 职责                                                                                              | 交付          |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------- |
| **R4-A Runner 壳**     | Tauri 内触发（devtools 命令 / 测试插件 / 受控 IPC）：选 case、起 session、跑 goal、收事件、写报告 | runner 模块   |
| **R4-B 采集器**        | 订阅 §5.2 全通道；统一 `TraceBundle` schema                                                       | schema + 实现 |
| **R4-C 假 Provider**   | 进程内或 daemon 可插拔 fake；轨迹 DSL 库（含 §5.3）                                               | fixture 包    |
| **R4-D Oracle 执行器** | 磁盘检查 + 与 terminal status 联合判定；CI 脚本调 **软件内** 入口而非浏览器                       | oracle + 文档 |

**R4 完成门禁**：

- [ ] 一键（或 CI job）拉起 **真实软件** 跑通 ≥3 条假轨迹。
- [ ] 每条产出 `events.jsonl` + `oracle-report.json`。
- [ ] README 写明「禁止仅用 Vite 端口代替」。

---

### R5 · 性能 / 资源探针挂接

**目标**：长程 run 下可观测延迟、内存、背压，不靠主观「感觉卡」。

| Agent                 | 职责                                                                           | 交付            |
| --------------------- | ------------------------------------------------------------------------------ | --------------- |
| **R5-A 探针 API**     | round 时长、TTFT、tool 耗时、事件积压深度；挂到 TraceBundle                    | 指标定义 + 埋点 |
| **R5-B STREAM_PAUSE** | 水位触发次数、pause 持续时间、是否丢帧；与 `streaming-transport-contract` 对齐 | 软件内加压 case |
| **R5-C 资源**         | 桌面/daemon RSS 或进程采样（Windows 可用性能计数器）；goal 12 轮级假轨迹采样   | 报告字段        |
| **R5-D 门槛建议**     | 给出「告警阈值」草案（非武断 fail）；夜间报告趋势                              | 文档段落        |

**R5 完成门禁**：

- [ ] 假长程 run 报告含 pause 计数与 round 耗时直方图。
- [ ] 至少一条加压 case 在 **Tauri 内** 触发并记录 `STREAM_PAUSE`。
- [ ] 无探针则 R5 不计完成。

---

## 7. Computer-use：仅夜间探索层

| 项                    | 规定                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 定位                  | 探索「真实键鼠/截图」能否发现 UI 死角；**不是** Goal 正确性主证据                                                               |
| 调度                  | 夜间 job / 手工；失败 → issue 标签 `explore/computer-use`，**不**红日间 CI                                                      |
| 参考                  | 审计所列 [trycua/cua](https://github.com/trycua/cua)、OSWorld 等；clone 至仓库根 `reference/`（执行轮拉取，勿默认提交巨型依赖） |
| 与 in-app runner 关系 | 可复用同一 oracle 与 TraceBundle **对照**，但 computer-use 步骤缺失不得否定 R1–R5 主链                                          |
| 安全                  | 隔离工作区；禁触生产密钥；限窗口白名单                                                                                          |

---

## 8. 迁移与兼容

### 8.1 过渡期（R1–R2）

1. 特性开关 `goal.engineDriven`（默认 true 于 dev/nightly；稳定后默认 true 全量）。
2. 开关 false：保留旧前端 5 轮环（仅应急），并 **打 warning** 视为 deprecated。
3. 旧 `decideGoalContinuation` 单测保留至投影逻辑抽出后删除权威分支。

### 8.2 破坏性变更说明（需产品知悉）

- 「模型说 DONE 即任务完成」行为消失 → 改为需证据/策略。
- 默认 maxRounds 可能从 5 对齐引擎（如 12）→ UI 文案同步。
- 续写气泡可能从本地 `user-msg-goal-*` 变为引擎事件驱动展示。

### 8.3 回滚

- 开关回 false + 引擎 goal 请求降级为 normal run。
- 保留 oracle 与采集器（采集器对 normal run 仍有价值）。

---

## 9. 风险与依赖

| 风险                                     | 缓解                                       |
| ---------------------------------------- | ------------------------------------------ |
| 桌面事件通道未暴露 `goal-round-*`        | R1-C 优先；无事件则 R1 失败不得进 R2       |
| 假 provider 与真 daemon 工具链不一致     | fake 只替 LLM，工具仍走真 TrustZone        |
| 审批超时 throw 杀 run                    | 与 Tools plan P0 对齐；R3 依赖或并行修     |
| 仅在 dev 浏览器「测过」                  | Review 清单强制附件：**Tauri 报告路径**    |
| 双策略（event-scan vs snapshot）语义漂移 | 共享 stall/maxRounds 内核；策略只换 assess |

依赖其他维度（不阻塞本方案启动，但影响满分）：

- 审批超时 soft 化、deny UI（Tools & Permissions）。
- Provider 诚实化（避免假 Anthropic 壳干扰长程）。
- MCP start API 名对齐（goal 若依赖 MCP 工具）。

---

## 10. 验收总表（方案级 Definition of Done）

| #   | 条件                                                                                             | 验证环境         |
| --- | ------------------------------------------------------------------------------------------------ | ---------------- |
| 1   | `/goal` → 引擎 `driveGoalRun`，有 `goal-round-*`                                                 | **Tauri 软件内** |
| 2   | 无证据 DONE ≠ success                                                                            | 软件内 + oracle  |
| 3   | stalled → blocked，可观测                                                                        | 软件内           |
| 4   | denial 结构化 + UI 失败可见                                                                      | 软件内           |
| 5   | 格式修复/reflection 预算可测                                                                     | 假轨迹 + 软件内  |
| 6   | TraceBundle：goalMode、ribbon data-*、toolCalls、磁盘 oracle、STREAM_PAUSE、approval、goal-round | 软件内 runner    |
| 7   | R1–R5 每轮 ≥4 Agent 交付物齐                                                                     | 过程文档         |
| 8   | computer-use 仅夜间，非主 CI                                                                     | CI 配置审查      |

---

## 11. 关键代码与文档锚点（执行时查阅）

| 区域                 | 路径                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| 桌面 goal 控制       | `apps/crish-desktop/src/api/goalModeController.ts`                                               |
| 桌面流式 /goal       | `apps/crish-desktop/src/hooks/useChatStream.ts`                                                  |
| Ribbon data-*        | `apps/crish-desktop/src/components/ChatStatusRibbons.tsx`                                        |
| Stream diag          | `apps/crish-desktop/src/api/streamDiag.ts`                                                       |
| 引擎 goal 环         | `packages/agent-orchestrator/src/orchestrator.ts`（`driveGoalRun`）                              |
| Stall / continuation | `packages/agent-orchestrator/src/goal-continuation.ts`                                           |
| 策略                 | `packages/agent-orchestrator/src/event-scan-goal-strategy.ts`                                    |
| Workbench 对照       | `apps/agent-workbench/src/cli/goal-runner.ts`、`snapshot-aware-goal-strategy.ts`                 |
| Binary 背压          | `apps/crish-desktop/src/api/binaryFrame.ts`、`docs/architecture/streaming-transport-contract.md` |
| 审计结论             | `docs/system-completion-plans/audits/00-master-findings.md`                                      |

---

## 12. 执行顺序建议

```
R1 契约打通 ──► R2 门禁/stall ──► R3 reflection/denial
                      │                    │
                      └────────► R4 in-app runner ◄── 假轨迹
                                      │
                                      ▼
                               R5 探针 / STREAM_PAUSE
                                      │
                         夜间 ──► computer-use 探索（可选）
```

**立即开始**：R1 四 Agent；并行起草 R4 的 `TraceBundle` schema（可先文档后实现），避免 R2/R3 埋点返工。

---

_本文件为系统补全分册 03。实现以软件内证据为准；浏览器端口结果不得单独宣告 Goal 长程闭环完成。_
