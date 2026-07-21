# 02 — MCP 启停对齐 · Tools 并发锁 · 权限中间件 · 审批/Denial · Tool-Output 防护

**日期**: 2026-07  
**维度**: MCP + Tools & Permissions（审计 `audits/00-master-findings.md` §2.2 / §2.3）  
**原则**: 自上而下（契约 → 引擎 API → 调度/中间件 → 回灌语义 → 配置注入 → UI 诚实 → 回归）  
**执行形态**: **多轮并行，每轮 ≥4 个 Agent**；轮内禁止越界改下轮文件  
**开源参考**: 执行轮 clone 到仓库根 `reference/`（勿提交巨型依赖，除非 submodule）

| 目标                              | 候选                                                                                                         | 拉取路径建议                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| MCP 协议 / Sampling / Elicitation | [modelcontextprotocol/specification](https://github.com/modelcontextprotocol/specification) + TypeScript SDK | `reference/mcp-spec`、`reference/mcp-ts-sdk`               |
| 工具调度 / 权限规则               | OpenCode                                                                                                     | `reference/opencode`（若已有则复用）                       |
| 审批 / MCP 生命周期               | Cline                                                                                                        | `reference/cline`（仓库已有 `reference/cline` 时可直接读） |
| 既有分析                          | `reference/analysis-reports/cline-analysis.md`                                                               | 只读对照                                                   |

---

## 0. 目标与边界

### 0.1 本方案 **做**

| #   | 能力                                                         | 优先级      | 成功判据（摘要）                                                                                                       |
| --- | ------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| A   | MCP 启停 API 名与 `McpLifecycleManager` 对齐                 | P0          | `start-mcp-server` / `stop-mcp-server` 不再抛 `DaemonUnsupportedCapabilityError`；探测 `canStartStop=true`（有配置时） |
| B   | MCP 配置注入 daemon                                          | P0          | 用户/文件配置的 `mcpServers` 进入 factory；`list-mcp-servers` 非空且状态可刷新                                         |
| C   | Sampling / Elicitation **后置**                              | P2 明确不做 | 契约与能力位标注 `deferred`；禁止假实现                                                                                |
| D   | Tools 并发锁：`parallel` / `sequential` / `exclusive` 真区分 | P1          | 分区调度单测覆盖三档；写工具互斥、读工具可并                                                                           |
| E   | `PermissionMiddleware` + `PermissionStore` 真挂载            | P1/P2       | 管线 beforeExecute 参与主路径或与现有 `resolvePermission` 合并为单入口                                                 |
| F   | Denial 结构化回灌                                            | P1          | tool-result 含 `code/reason/retryable/softDeny/...`，模型可改路径                                                      |
| G   | 审批超时 **不 abort run**                                    | P0          | 删除 `throw new Error(...Approval expired)`；超时 = softDeny tool-result，run 继续                                     |
| H   | tool-output 注入防护                                         | P1          | 不可信工具输出带边界标记 + 可选剥离伪指令；预算/外化保留                                                               |

### 0.2 本方案 **不做**（禁止范围）

| 禁止                                            | 原因                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- |
| 完整 MCP Sampling / Elicitation 客户端          | 协议能力后置（P2）；本轮只留扩展点与能力位                      |
| 重写 `McpLifecycleManager` 状态机               | 仅补 `startServer`/`stopServer` 别名与配置路径                  |
| 替换 TrustZone / ApprovalQueue 主链             | 主链可用；只修超时与 denial 语义                                |
| 假「添加 MCP 服务成功」toast / 本地冒充引擎配置 | 见产品信任契约 `docs/plans/2026-07-product-trust-topdown.md` §4 |
| 整仓插件沙箱 / 多 provider                      | 属其他 plan                                                     |
| 在未对齐 API 前打开 UI 启停并假装成功           | 必须先 B+A，再 UI                                               |

### 0.3 硬证据（现状断点，执行前复核）

```
# MCP 启停名不匹配
packages/agent-daemon/src/server-runtime-factory.ts
  startMcpServer → (manager as any).startServer   // 库存 manager 无此方法
  stopMcpServer  → (manager as any).stopServer

packages/agent-runtime/src/mcp-lifecycle.ts
  McpLifecycleManager: start() / reconnectServer() / teardown()
  // 无 startServer(name) / stopServer(name)

# 默认不注入配置
packages/agent-daemon/src/server.ts / server-runtime-factory
  mcpServers 仅 options 可选；startDaemon 默认常不传 → list 空

# 审批超时 abort
packages/agent-runtime/src/agent-session-loop.ts ~L922-933
  if (isExpiredApprovalDecision(permission)) {
    throw new Error(permission.reason ?? "Approval expired");
  }
// 与 daemon-approval-handler softDeny: expired 文案冲突

# 中间件未挂主路径
packages/agent-runtime/src/tools/tool-middleware.ts  // PermissionMiddleware 已实现
packages/agent-daemon/src/permission-store.ts       // PermissionStore 已实现
// 主路径仍走 AgentSessionLoop.resolvePermission + DaemonApprovalHandler

# 并发
packages/agent-runtime/src/runtime-components/tool-executor.ts
  partitionBatch: 仅 parallel vs 其他；sequential 与 exclusive 不区分

# tool-output
tool-output-budget.ts / blob-externalization.ts 有长度预算与外化
// 无「不可信输出」边界 / 伪 system 指令剥离
```

### 0.4 Definition of Done（整专题）

- [ ] `startMcpServer`/`stopMcpServer` 调用 lifecycle 真方法；有配置时 UI `canStartStop` 为真
- [ ] daemon 可从配置文件或 `update-config`/专用消息加载 `mcpServers` 并反映到 list
- [ ] 审批超时：run 不因 expired throw 终止；tool-result 带 `softDeny` + 结构化 code
- [ ] 用户 deny 与策略 deny 回灌结构统一（非仅 `"user-denied"` 弱文案）
- [ ] `exclusive` 全局互斥 / `sequential` 同批串行 / `parallel` 可并，单测三档
- [ ] tool-output 进入 provider 上下文前经过防护包装（可配置开关，默认开）
- [ ] Sampling/Elicitation：能力文档与 `capabilities` 中明确 deferred，零半截实现
- [ ] 相关 vitest：`check:runtime` / `check:daemon` 通过；中文无乱码
- [ ] 软件内（Tauri+daemon）冒烟：配置 MCP → list → start/stop → 工具调用 → 超时审批不杀 run

---

## 1. 目标架构（自上而下）

```
┌─────────────────────────────────────────────────────────────┐
│  Desktop / Workbench                                         │
│  mcpApi · McpSettingsTab · 审批卡 · tool-result 渲染         │
└───────────────────────────┬─────────────────────────────────┘
                            │ WS: list/start/stop-mcp-server
                            │     update-config / mcp-config
                            │     approval-resolve
┌───────────────────────────▼─────────────────────────────────┐
│  agent-daemon                                                │
│  mcp-handlers · PermissionStore(挂载) · ApprovalQueue        │
│  server-runtime-factory.startMcpServer/stop/list + 配置注入  │
└───────────────────────────┬─────────────────────────────────┘
                            │ McpLifecycleManager
┌───────────────────────────▼─────────────────────────────────┐
│  agent-runtime                                               │
│  McpServerController.start|teardown|reconnect                │
│  ToolExecutor 分区锁 · MiddlewarePipeline · SessionLoop      │
│  DenialEnvelope · ToolOutputGuard · (Sampling 后置扩展点)    │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 API 契约（目标态）

| 协议消息 / 方法                                   | 现状                            | 目标                                                                        |
| ------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `start-mcp-server` → `factory.startMcpServer(id)` | 找 `startServer` → unsupported  | 调 `manager.startServer(name)` 或 `getServer(name).start()` / `reconnect()` |
| `stop-mcp-server`                                 | 找 `stopServer`                 | 调 `getServer(name).teardown()` 或 `stopServer`                             |
| `list-mcp-servers`                                | 依赖 `lastMcpStatus`，常空      | 有配置即列出；无 run 时也能 snapshot                                        |
| `mcpServers` 注入                                 | 仅构造 options                  | 配置文件 + 热更新通道                                                       |
| Sampling / Elicitation                            | 不存在                          | **后置**：capability `deferred`                                             |
| Denial tool-result                                | 弱文本 / 超时 throw             | `DenialEnvelope` JSON + 人类可读 text                                       |
| 审批超时                                          | daemon softDeny + runtime throw | **全路径 softDeny，不 abort**                                               |

### 1.2 Denial 结构（目标 schema）

```ts
// 建议放 shared-types 或 runtime 内稳定导出
interface ToolDenialEnvelope {
  kind: 'tool-denial';
  code:
    | 'user-denied'
    | 'policy-denied'
    | 'approval-timeout'
    | 'hardline-blocked'
    | 'middleware-blocked'
    | 'tool-disabled'
    | 'mcp-unavailable';
  reason: string; // 人类可读，中英按现有风格
  softDeny: boolean; // true → 模型应改路径，run 继续
  retryable: boolean; // 超时/暂时不可用 true；硬线 false
  trustZone?: string;
  risk?: string;
  intentKey?: string;
  matchedRule?: string;
  toolName: string;
  toolCallId: string;
  suggestions?: string[]; // 可选：给模型的下一步提示
}
```

回灌规则：

1. `ToolOutput.text`：简短可读摘要（含 code + reason）
2. `ToolOutput.json`：完整 `ToolDenialEnvelope`（供 UI / 遥测 / 模型）
3. `isError: true` 但 **不** 触发 run-level abort（除非 `fatalOnError` 且非 softDeny——默认超时/user-deny 永不 fatal）

### 1.3 并发语义（目标）

| concurrency  | 含义                  | 调度                                                                        |
| ------------ | --------------------- | --------------------------------------------------------------------------- |
| `parallel`   | 只读/无副作用优先     | 同批可与其他 parallel 并行                                                  |
| `sequential` | 有序但不必全局互斥    | 同批内串行；可与并行组交错（组间串行）                                      |
| `exclusive`  | 写工作区 / 危险 shell | **全局互斥锁**：任意 exclusive 执行时禁止其他 tool 并发；exclusive 之间串行 |

实现提示：在 `ToolExecutor.partitionBatch` 与 `executeBatchWithEvents` 引入 `exclusiveGate`（Promise 链或 mutex）；`AgentSessionLoop.toBatchCall` 默认 concurrency 与工具定义一致（勿一律 `"exclusive"` 除非工具未声明）。

### 1.4 tool-output 防护（目标）

不可信输出包装（示意，实现可微调）：

```
<tool_output tool="..." untrusted="true">
...raw or budgeted content...
</tool_output>
```

配套：

- 剥离或转义模型常见「注入」模式（可选启发式，可配置，默认保守）
- **禁止**把 tool-output 以 `role: user/system` 注入 transcript（synthesis 污染属 Agent Loop 专题，本方案只约束 tool-result 路径）
- 与现有 `budgetToolOutputForContext` / `blob-externalization` 顺序：  
  **raw 保留 → Guard 包装 → budget → 进 provider 投影**（raw transcript 不被 guard 破坏时可仅投影层包装）

### 1.5 Sampling / Elicitation 后置声明

| 能力                     | MCP Spec                  | 本阶段                                              |
| ------------------------ | ------------------------- | --------------------------------------------------- |
| `sampling/createMessage` | 服务端向客户端要 LLM 补全 | **不做**；`capabilities.sampling = deferred`        |
| `elicitation/*`          | 服务端向用户要输入        | **不做**；与 Ask/BE-16 对齐时再开专题               |
| 扩展点                   | —                         | `McpClientCapabilities` 预留类型字段 + 注释「后置」 |

执行轮允许读官方 spec 决定类型命名，但 **禁止** 落地半截 handler。

---

## 2. 参考拉取与对照（Round 0，阻塞后续实现）

> 执行时 clone；已有 `reference/cline` 则跳过重复 clone。

### Round 0 — 参考与契约冻结（≥4 Agents）

| Agent            | 职责                                                                             | 产出                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **0-A Spec**     | 读 MCP 最新 spec：lifecycle、tools、sampling、elicitation、list_changed          | 对照表：我们已实现 / 缺口 / 后置；路径 `docs/system-completion-plans/plans/` 内可只更新本文件附录或执行笔记（不新建无关 md 除非必要） |
| **0-B OpenCode** | clone/读 OpenCode 权限：规则链、always-allow、tool 并发                          | 可借鉴点列表（模式，不抄大段）                                                                                                        |
| **0-C Cline**    | 读 `reference/cline` + `cline-analysis.md`：MCP 启停、审批、tool result 错误形态 | 与我们 DenialEnvelope / softDeny 对齐建议                                                                                             |
| **0-D 现状探针** | 本地 grep 复核 §0.3 行号；列出将改文件清单与测试入口                             | **File Ownership Map**（见下）供后续轮认领                                                                                            |

#### File Ownership Map（建议锁）

| 区域                 | 主文件                                                                    | 认领轮     |
| -------------------- | ------------------------------------------------------------------------- | ---------- |
| Lifecycle API        | `packages/agent-runtime/src/mcp-lifecycle.ts`                             | R1         |
| Factory 桥           | `packages/agent-daemon/src/server-runtime-factory.ts`                     | R1         |
| MCP handlers / types | `handlers/mcp-handlers.ts`、`types.ts`、protocol validators               | R1         |
| 配置注入             | `server.ts`、config 加载、可选 `mcp-config` handler                       | R2         |
| 超时 / denial        | `agent-session-loop.ts`、`daemon-approval-handler.ts`、shared denial 类型 | R3         |
| 并发锁               | `tool-executor.ts`、`agent-session-loop.toBatchCall`                      | R4         |
| 中间件挂载           | `tool-middleware.ts`、runtime factory 装配                                | R4         |
| tool-output guard    | 新建 `tool-output-guard.ts` + projection                                  | R5         |
| Desktop MCP UI       | `mcpApi.ts`、`McpSettingsTab.tsx`                                         | R6         |
| 后置 Sampling        | 类型/capabilities 注释 only                                               | R5/R6 薄改 |

**Round 0 VERIFY**

```
ALLOWED: reference/* clone；本方案附录更新；ownership 表
FORBIDDEN: 改生产代码
VERIFY: 四份对照笔记齐；ownership 无重叠冲突
```

---

## 3. 多轮执行计划（自上而下）

### Round 1 — MCP 启停 API 对齐（P0，≥4 Agents）

**目标**: 名字与行为对齐，消除 `DaemonUnsupportedCapabilityError` 假阴性。

| Agent                  | 目标                                  | 文件                                                   | 改动要点                                                                                                                                                                                                |
| ---------------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1-A Lifecycle API**  | 在 `McpLifecycleManager` 增加正式方法 | `mcp-lifecycle.ts` (+test)                             | `startServer(name): Promise<McpServerOperationResult>` → 内部 `getServer` + `controller.start()` 或 `reconnect()`；`stopServer(name)` → `teardown()`；未知名返回 ok:false + diagnostic，不 throw 未捕获 |
| **1-B Factory 去 any** | 去掉 `(manager as any).startServer`   | `server-runtime-factory.ts` (+test)                    | 类型收窄到含 startServer/stopServer 的接口；遍历 managers；失败返回结构化错误而非笼统 unsupported（无 manager 时仍可 unsupported）                                                                      |
| **1-C Handlers/协议**  | 确保消息字段与结果一致                | `mcp-handlers.ts`、validators、`capabilities.ts`       | start/stop 结果含 `state`、`diagnostic`；list 在 managers 已注册但无 run 时也可从 snapshot 填                                                                                                           |
| **1-D 单测**           | 假 adapter 启停闭环                   | `server-runtime-factory.test.ts`、`mcp-lifecycle` test | 注册 fake server → start → list state ready → stop → stopped；**禁止**仅 mock 掉 factory 假装通过                                                                                                       |

**契约细节（1-A）**

```ts
// 目标签名（命名以与 daemon 一致为准）
async startServer(name: string): Promise<McpServerOperationResult>
async stopServer(name: string): Promise<McpServerOperationResult>
// 可选别名（若外部已文档化 reconnect）：
// startServer 对 degraded → reconnect；对 stopped → start
```

**VERIFY R1**

```
npm exec vitest -- packages/agent-runtime/src/mcp-lifecycle*.test.ts packages/agent-daemon/src/server-runtime-factory.test.ts packages/agent-daemon/src/handlers/*mcp* --run
# 或项目既有 check:runtime / check:daemon 子集
```

```
ALLOWED: mcp-lifecycle、factory、mcp-handlers、相关 test/types
FORBIDDEN: UI 强行 canStartStop=true；配置注入（R2）；改审批
```

---

### Round 2 — MCP 配置注入（P0，≥4 Agents）

**目标**: 有配置则 list 非空；run 与 UI 共享同一 lifecycle 源。

| Agent                | 目标                      | 文件                                                | 改动要点                                                                                                                                        |
| -------------------- | ------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **2-A 配置模型**     | 定义可序列化 MCP 配置     | `packages/shared-types` 或 daemon types             | `McpServerConfig{ name, command?, args?, env?, transport, url?, ... }`；**adapter 不可序列化** → daemon 侧 stdio/SSE factory 从配置构造 adapter |
| **2-B 加载与热更新** | daemon 启动读配置 + 更新  | `server.ts`、config 路径、可选 `update-config` 分支 | 默认搜索：用户配置目录 `mcp.json` / daemon config 字段；`update-config` 或专用 `set-mcp-servers` 更新后 `rebindSharedMcpManager`                |
| **2-C Factory 绑定** | list 不依赖「曾跑过 run」 | `server-runtime-factory.ts`                         | 启动时若有 `mcpServers` 即创建 `sharedMcpManager` 并可选 lazy start；`listMcpServers` 优先 `manager.snapshot()`，回退 `lastMcpStatus`           |
| **2-D 安全**         | env/密钥不进日志          | env-whitelist、日志脱敏                             | MCP 子进程 env 过滤；错误信息不含完整 secret                                                                                                    |

**配置注入时序**

```
daemon boot
  → load McpServerConfig[]
  → build McpServerDefinition[] (stdio adapter factory)
  → RuntimeFactory.options.mcpServers = ...
  → ensureSharedManager()  // 可未 start，state 可为 stopped/discovering
UI list-mcp-servers
  → snapshot servers（含 stopped）
UI start-mcp-server
  → startServer(name)  // R1
run-task
  → startMcpForRun 复用 shared manager，避免双实例抢同一 stdio（必须单例策略写死）
```

**单例策略（写死）**: **共享一个 `McpLifecycleManager` per daemon**（已有 `sharedMcpManager` 方向）；禁止每个 run 新建导致 stop 误杀其他 run 的连接——若多 run 并发，`stopServer` 需引用计数或明确「全局停」语义并在 UI 文案说明。

**推荐**: stop = 全局 teardown 该 server；start 引用计数 +1；最后 run 结束不自动 stop（与「UI 可管生命周期」一致）。若现有 run teardown 会拆 manager，R2-C 必须改为 **不在 run end 拆 shared**，仅拆 run-local 临时 manager（若有 factory 定制）。

**VERIFY R2**

```
ALLOWED: 配置类型、server 启动路径、factory list/bind、脱敏
FORBIDDEN: Sampling；UI 大改（仅可为后续留 API）；权限超时
VERIFY: 无配置 → 诚实空；有配置 fixture → list≥1；start/stop 状态迁移
```

---

### Round 3 — 审批超时不 abort + Denial 结构化（P0/P1，≥4 Agents）

**目标**: 超时/拒绝均 soft 回灌；与 daemon softDeny 语义一致。

| Agent                  | 目标                 | 文件                                                    | 改动要点                                                                                                                                                 |
| ---------------------- | -------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3-A 杀 throw**       | 超时不再终止 run     | `agent-session-loop.ts`                                 | 删除 `isExpiredApprovalDecision` 分支的 `throw`；改为与普通 deny 相同路径，但 envelope.code=`approval-timeout`，`softDeny=true`                          |
| **3-B DenialEnvelope** | 统一结构             | `shared-types` 或 `agent-runtime` 新文件 + session-loop | 所有 deny 出口（policy / user / timeout / middleware / mcp）走 `toDenialToolResult(...)`                                                                 |
| **3-C Daemon 对齐**    | reason/metadata 完整 | `daemon-approval-handler.ts`、`approval-queue.ts`       | user-denied 保留；timeout 已有 softDeny——确保 metadata 传到 runtime 可被 `isExpiredApprovalDecision` 或新 helper 识别 **仅用于 code 分类，不用于 throw** |
| **3-D 单测**           | 超时 run 继续        | session-loop / approval / daemon tests                  | 用例：审批 expired → 收到 tool-result isError → 后续 turn 仍可继续；**不得** endReason=error 因该 throw                                                  |

**伪代码（3-A 目标态）**

```ts
const permission = yield* this.resolvePermission(...);
if (permission.behavior !== "allow") {
  const envelope = buildDenialEnvelope(permission, tool, toolCallId);
  const result = this.toToolBatchResult(
    call,
    startedAt,
    { text: formatDenialText(envelope), json: envelope as unknown as JsonObject },
    true
  );
  yield* this.emitEvent({ type: "tool-end", ... result });
  return result; // 绝不 throw
}
```

**VERIFY R3**

```
ALLOWED: session-loop 权限分支、denial 类型、approval handler metadata、相关 test
FORBIDDEN: 改 MCP 配置；改 UI 视觉大改；改 ToolExecutor 分区（R4）
VERIFY: 超时 / 用户拒绝 / hardline 三类 envelope code 单测
```

---

### Round 4 — 并发锁 + Middleware 挂载（P1/P2，≥4 Agents）

**目标**: 三档 concurrency 真生效；中间件/PermissionStore 进入可观测路径。

| Agent                        | 目标                          | 文件                                                | 改动要点                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4-A 分区算法**             | exclusive/sequential/parallel | `tool-executor.ts` (+test)                          | 重写 `partitionBatch`：遇 exclusive → 冲刷 parallel 组并单独成组；sequential 不进入 parallel 组；文档注释语义                                                                                                                                                       |
| **4-B 全局 exclusive 锁**    | 跨并行组互斥                  | `tool-executor.ts` / session-loop                   | 执行 exclusive 前 await mutex；parallel 组内仍 Promise.all；sequential 组 for-await                                                                                                                                                                                 |
| **4-C Middleware 装配**      | 真挂载或消歧                  | `runtime` 装配、`tool-middleware.ts`                | **二选一（任务单写死，推荐 M1）**：M1 主路径保持 `resolvePermission`，Middleware 仅作扩展点 + 单测；M2 主路径改走 `MiddlewarePipeline` 并删重复审批。禁止双审批弹两次。PermissionStore：在 `DaemonApprovalHandler` 或 policy 链 **evaluate 前** 查 always/deny 规则 |
| **4-D PermissionStore 接线** | always allow 持久化           | `permission-store.ts`、daemon approval、config 目录 | scope always → `addRule`；启动 load；与现有 `alwaysIntentAllowlist` 内存表合并策略写清（持久规则优先或合并 OR）                                                                                                                                                     |

**OpenCode/Cline 对照（执行时）**

- OpenCode：规则 pattern + saved permission → 映射到 `PermissionStore.targetPattern`
- Cline：auto-approval 分级 → 勿照搬 UI，只借「拒绝后模型可见原因」形态

**VERIFY R4**

```
ALLOWED: tool-executor、middleware 装配、permission-store 接线、test
FORBIDDEN: 再改 denial throw（应已在 R3 完成）；MCP 协议扩展
VERIFY:
  - parallel 两读工具时间重叠（fake delay）
  - exclusive 写与读不重叠
  - sequential 顺序稳定
  - always 规则重启后仍放行（store 文件 fixture）
```

---

### Round 5 — tool-output 防护 + Sampling/Elicitation 后置钉死（P1/P2，≥4 Agents）

| Agent              | 目标                 | 文件                                                           | 改动要点                                                                                                           |
| ------------------ | -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **5-A Guard**      | 输出包装             | 新建 `packages/agent-runtime/src/tool-output-guard.ts` (+test) | `guardToolOutputForProvider(output, meta)`；开关 `toolOutputGuard: "on"\|"off"` 默认 on                            |
| **5-B 投影接入**   | 进上下文路径         | `context-projection.ts` / `context-compression.ts`             | 顺序：guard → budget；**不**破坏 blob externalization 的 raw 存储                                                  |
| **5-C 能力位后置** | Sampling/Elicitation | capabilities / MCP client 类型                                 | 注释 + 类型 `deferred`；**零** handler 实现；审计文档勾选「后置」                                                  |
| **5-D 对抗单测**   | 注入样本             | guard test                                                     | 样本：输出中含 `Ignore previous instructions`、伪造 `System:` 行 → 包装后模型侧可区分；正常代码 fence 不被暴力删除 |

**VERIFY R5**

```
ALLOWED: guard 新文件、projection/compression、capabilities 标注、test
FORBIDDEN: 实现 sampling handler；改 desktop 大样式
VERIFY: unit 全绿；关闭开关行为与现网一致
```

---

### Round 6 — Desktop / Workbench 诚实 UI + 软件内冒烟（P0 收口，≥4 Agents）

| Agent                      | 目标           | 文件                                              | 改动要点                                                                                                    |
| -------------------------- | -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **6-A mcpApi**             | 探测与错误码   | `apps/crish-desktop/src/api/mcpApi.ts`            | start/stop 成功后清除 `rememberedStartStopUnsupported`；真实 unsupported 才记忆；区分「未配置」与「不支持」 |
| **6-B MCP 设置页**         | 启停可用时开放 | `McpSettingsTab.tsx`、必要时 Extensions           | 有配置且 R1 对齐后 `canStartStop=true`；加载中/失败 toast 真实；禁止假成功                                  |
| **6-C 审批 UI**            | 超时展示       | 审批卡 / `useAgentToolApproval` 等                | 超时展示 softDeny 文案；run 仍 running；与 envelope 字段对齐（只读展示）                                    |
| **6-D 软件内冒烟脚本说明** | Tauri+daemon   | 测试清单（可写在本文件附录执行记录，不强制新 md） | 步骤见 §5；必须 **真窗口** 非纯 Vite                                                                        |

**VERIFY R6**

```
ALLOWED: desktop mcp/approval 接线；文案
FORBIDDEN: demo 模式污染正式；clientApi.saveMcpServer 冒充引擎
VERIFY: check:desktop；手动/自动化软件内清单 §5
```

---

### Round 7 — 横切回归与反偷懒审计（≥4 Agents）

| Agent                | 职责                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **7-A Runtime 回归** | 全量相关 vitest；超时/denial/concurrency/guard/mcp-lifecycle                                                                                       |
| **7-B Daemon 回归**  | mcp handlers、factory、approval、permission-store、protocol validators                                                                             |
| **7-C 桌面回归**     | typecheck；mcpApi 探测；中文 UTF-8                                                                                                                 |
| **7-D 反偷懒巡检**   | 扫：是否仍存在 `startServer` any 反射失败路径；是否仍有 Approval expired throw；是否落地了 sampling 半截；是否 `canStartStop` 硬编码 true 而无后端 |

**巡检命令示例**

```bash
# 在仓库根（PowerShell 可用 rg）
rg "Approval expired" packages/agent-runtime/src
rg "\(manager as any\)\.startServer" packages/agent-daemon/src
rg "sampling/createMessage|elicitation" packages --glob "*.ts"
rg "rememberedStartStopUnsupported" apps/crish-desktop/src
```

---

## 4. Agent 通用约束（全轮）

1. **改动精确到行为**：PR/汇报列文件 + 前后行为，禁止「已完成」空话
2. **禁止** `// TODO implement` 占位当完成
3. **禁止** 为过 typecheck 大面积 `as any`（R1 是在 **删除** any 桥）
4. **禁止跨轮改文件**（ownership map）
5. 测试必须覆盖 **失败路径**（超时、未知 server、双 exclusive）
6. 中文 UI/提交信息 UTF-8
7. 参考代码只对照模式，**不**整文件复制进生产树
8. 与 `docs/plans/2026-07-product-trust-topdown.md` §4 冲突时：**先诚实，再增强**

---

## 5. 软件内验收清单（Tauri + daemon）

| #   | 步骤                                                                | 期望                                                            |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | 配置一个本地 stdio MCP fixture（或 echo mock adapter）并重启 daemon | list 显示该 server，state 合理                                  |
| 2   | UI 点启动                                                           | state→ready/starting→ready；工具数≥0；无 unsupported            |
| 3   | UI 点停止                                                           | state→stopped；工具从可用列表消失或标记不可用                   |
| 4   | 对话触发需审批工具，等待超时                                        | 审批卡超时；**会话 run 不死**；模型收到 timeout denial 并可继续 |
| 5   | 用户点拒绝                                                          | tool-result 结构化；run 继续                                    |
| 6   | 同批 parallel 两读 + 一 exclusive 写                                | 日志/trace 显示写不与读并行（若有 trace）                       |
| 7   | 工具返回超大/含伪指令文本                                           | 上下文中有 untrusted 边界；run 正常                             |

浏览器-only Vite **不算** 通过 MCP stdio / 审批闸验收。

---

## 6. 风险与回滚

| 风险                              | 缓解                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| stop 误杀其他 run 的 MCP          | shared manager + 引用计数或文档化全局停                        |
| Middleware 双审批                 | R4 强制 M1 或 M2 二选一                                        |
| Guard 破坏特殊工具 JSON           | 投影层包装；raw transcript 不变；可关开关                      |
| 配置注入命令注入                  | 仅允许配置的 command 列表；禁止 shell 拼接用户字符串           |
| 超时 softDeny 被滥用绕过 hardline | hardline 仍 `softDeny=false` 且不可 always；envelope 区分 code |

回滚：R1/R2 以 feature flag `mcpUiLifecycle=false` 恢复诚实禁用启停；R3 throw 删除不可回滚为 throw（安全语义只许向前）；Guard 可默认关应急。

---

## 7. 与其他专题的接口

| 专题                | 接口                                                  |
| ------------------- | ----------------------------------------------------- |
| Goal 长程 (`03` 等) | 审批 defer/超时不得误标 goal 完成；依赖 R3 softDeny   |
| Agent Loop / 反思   | DenialEnvelope 可供 reflection 消费；本方案只保证结构 |
| UI Stub             | deny 失败 toast 属 UI 维；本方案保证引擎侧结果真实    |
| BE-16 Ask           | Elicitation 后置，未来与 Ask 合并设计，本方案不抢做   |

---

## 8. 轮次总览（调度用）

```
Round 0  参考 clone + 契约冻结 + ownership          ≥4 agents
Round 1  MCP start/stop API 对齐                      ≥4 agents  P0
Round 2  MCP 配置注入 + list 真源                     ≥4 agents  P0
Round 3  审批超时不 abort + Denial 结构化             ≥4 agents  P0/P1
Round 4  并发锁 + Middleware/PermissionStore          ≥4 agents  P1/P2
Round 5  tool-output 防护 + Sampling 后置钉死         ≥4 agents  P1/P2
Round 6  Desktop 诚实 UI + 软件内冒烟                 ≥4 agents  P0 收口
Round 7  全量回归 + 反偷懒巡检                        ≥4 agents
```

**建议并行度**: 每轮 4 agents 同时；轮结束 gate 全绿再开下轮。  
**关键路径**: R1 → R2 → R3 必须串行依赖；R4/R5 可在 R3 后部分并行；R6 依赖 R1+R2+R3。

---

## 9. 附录：关键代码锚点（执行时复核行号）

| 主题                     | 路径                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Lifecycle 无 startServer | `packages/agent-runtime/src/mcp-lifecycle.ts`（`reconnectServer` / `start` / `teardown`）                     |
| Factory any 桥           | `packages/agent-daemon/src/server-runtime-factory.ts` → `startMcpServer` / `stopMcpServer` / `listMcpServers` |
| Handlers                 | `packages/agent-daemon/src/handlers/mcp-handlers.ts`                                                          |
| 超时 throw               | `packages/agent-runtime/src/agent-session-loop.ts`（`isExpiredApprovalDecision` + `throw`）                   |
| Daemon softDeny 超时     | `packages/agent-daemon/src/daemon-approval-handler.ts` → `decisionFromResult`                                 |
| Middleware               | `packages/agent-runtime/src/tools/tool-middleware.ts`                                                         |
| PermissionStore          | `packages/agent-daemon/src/permission-store.ts`                                                               |
| 分批                     | `packages/agent-runtime/src/runtime-components/tool-executor.ts` → `partitionBatch`                           |
| Budget                   | `packages/agent-runtime/src/tool-output-budget.ts`                                                            |
| Desktop 探测             | `apps/crish-desktop/src/api/mcpApi.ts`、`McpSettingsTab.tsx`                                                  |
| 产品契约                 | `docs/plans/2026-07-product-trust-topdown.md` §4                                                              |
| 审计                     | `docs/system-completion-plans/audits/00-master-findings.md` §2.2 / §2.3                                       |

---

## 10. 执行轮参考 clone 命令（示例）

```bash
# 在 C:\Software\conex 根目录；已存在则跳过
git clone --depth 1 https://github.com/modelcontextprotocol/specification.git reference/mcp-spec
git clone --depth 1 https://github.com/modelcontextprotocol/typescript-sdk.git reference/mcp-ts-sdk
# OpenCode：按当时上游 URL 浅克隆到 reference/opencode
# Cline：已有 reference/cline 则复用
```

对照时优先：Cline MCP 生命周期与审批错误回灌、OpenCode permission saved rules、MCP spec 中 tools 与（后置）sampling/elicitation 章节。

---

**文档状态**: 方案就绪，待 Round 0 启动。  
**只含方案**: 本文件不修改生产代码。
