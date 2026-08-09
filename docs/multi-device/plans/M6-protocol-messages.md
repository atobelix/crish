# M6 跨端协议消息细化设计：命令 / 事件 / 响应 / 流 / 裁剪 / 版本化 / 实现落点

> 文档编号：M6
> 角色：多端互通架构设计子代理 M6（协议细化与消息设计）
> 状态：设计稿（供评审）
> 日期：2026-08-09
> 产出路径：`docs/multi-device/plans/M6-protocol-messages.md`
> 上游输入：`D3-protocol.md`（端间协议框架）、`D6-sync-consistency.md`（同步一致性）、
> `D7-push-notifications.md`（推送体系）、`F1-F6`（六域功能设计，每域的数据需求）、
> `crates/conex-types/src/events.rs`（AgentEvent 41 变体事实源）、
> `crates/conex-db/src/events.rs`（游标语义）、
> `apps/agent-workbench/src-tauri/src/command_manifest.rs`（命令面真源）、
> `scripts/generate-engine-bindings.mjs`（生成器结构）
>
> 职责：在 D3 协议框架之上，把跨端协议细化为**每个功能的具体消息类型**
> （命令 / 事件 / 响应 / 错误），输出完整消息清单与 JSON schema。
> 本设计不重复 D3 的配对密码学与信封设计（直接引用），聚焦消息级契约。

---

## 目录

1. [结论摘要（TL;DR）](#1-结论摘要tldr)
2. [范围、依据与重要勘误](#2-范围依据与重要勘误)
3. [协议消息总览（kind 全表）](#3-协议消息总览kind-全表)
4. [命令消息清单（按功能域）](#4-命令消息清单按功能域)
5. [事件消息清单（41 变体映射与裁剪）](#5-事件消息清单41-变体映射与裁剪)
6. [响应与错误体系](#6-响应与错误体系)
7. [流式协议细化](#7-流式协议细化)
8. [消息大小与裁剪](#8-消息大小与裁剪)
9. [离线与重连语义](#9-离线与重连语义)
10. [JSON Schema 完整定义](#10-json-schema-完整定义)
11. [版本化](#11-版本化)
12. [实现落点](#12-实现落点)
13. [端到端验收锚点](#13-端到端验收锚点)
14. [附录](#14-附录)

---

## 1. 结论摘要（TL;DR）

本设计在 D3（信封 / 配对 / 认证 / 流框架）之上完成消息级细化，核心结论：

### 1.1 消息数量总览

| 消息族 | 数量 | 说明 |
|---|---|---|
| `cmd.*` 命令请求 | **37** | 覆盖 F1-F6 六域 + 设备域；响应为同名录 `result.*` |
| `result.*` 命令响应 | 37 | 与命令一一对应（请求-响应关联键 `reqMsgId`） |
| `events.*` 会话面 | **11** | subscribe / subscribeAll / subscribe.ok / push / ack / resume / resume.page / resume.done / session.updated / session.removed / session.updatedAll |
| `stream.*` 流控制 | 4 | open / chunk / resume / close |
| `pair.*` 配对 | 4 | hello / challenge / verify / ok |
| `auth.*` 认证 | 3 | hello / hello.ok / refresh（rotate 为可选扩展） |
| `device.*` 设备生命周期 | 4 | ready / unlink / revoked / audit |
| `heartbeat` / `heartbeat.ok` | 2 | 保活 + 时钟校准 |
| `error` | 1 | 统一错误通知（携带 `reqMsgId` 可关联请求） |
| **合计 kind 数** | **103** | 事件载荷复用 41 变体（`events.push.body.event`） |

### 1.2 事件裁剪结论

- 41 变体按「**实时面（events.push）与同步面（events.resume）双面策略**」登记，
  每事件给出：跨端策略 ∈ {透明透传 / 摘要化 / 元组下发（fail-closed） / 不同步}。
- **fail-closed 铁律**：未登记裁剪规则的事件类型 → 只下发
  `{type, sequence, sessionId, schemaVersion}` 元组，正文不出网（宁可少数据，不可泄数据）。
- 摘要化对象（敏感字段盘点）：message 全文（text/thought/tool-call/tool-result）、
  approval 的 `parameters` 全量、task-failed 的 `tail` 全量、security-audit 的
  `targets` 全量、tool 的 input/output 全量。
- 默认全链路摘要化：消息正文首 200 字符 + `truncated=true`；thinking 只传
  `hasThinking` 布尔；工具输出首 200 字符；审批参数只传键名列表 + summary。

### 1.3 幂等结论

- **读命令全部天然幂等**（游标分页语义天然去重）。
- **写命令五条走 outbox + at-least-once**：`cmd.approve` / `cmd.deny` /
  `cmd.writeFile` / `cmd.setSettings` / `cmd.pauseAutomation`。
- 幂等键 = 请求 `msgId`（即 `reqMsgId`）或业务幂等键（`toolCallId` /
  `clientMessageId` / 设置键 / 请求 id）；桌面按幂等键记录「已处理命令」，
  重发回显首次结果、不重复执行（TTL 30 天防重放窗口 > 离线 TTL 上限）。
- 审批天然幂等（I-02 校验：重复决策命中 `cmd.approval_mismatch`，不改状态机）；
  run 控制（L2/L3）重复无副作用；`cmd.runTask` 以 `clientMessageId` 幂等。

### 1.4 流与背压结论

- 流 = `stream.open → chunk* → close`，块 ≤ 64 KiB；断线按字节 offset 续传，
  客户端以 seq 去重（块级幂等）。
- 背压三级 → 客户端处理策略固化：**Delta 丢弃（以终态全文兜底）**、
  **Soft 尽力（断线窗口内补发）**、**Critical 必达（游标续传覆盖）**；
  Delta 事件（message-delta / task-output / task-heartbeat / subagent progress）
  在断线续传范围外，断线后以 message-end / 任务输出补取命令重建增量态。
- 下行窗口 4096 事件/会话（`EVENT_WINDOW`），游标落后超窗口 → `stream.cursor_stale`
  触发全量回放（复用 EventPage 契约）。

### 1.5 尺寸预算结论

- 单帧 ≤ 1 MiB（`MAX_FRAME_BYTES`）；事件 push 单事件 ≤ 64 KiB（超限先摘要化）；
  命令请求默认 ≤ 64 KiB（`cmd.runTask.prompt` 跨端上限 256 KiB，超限走流上传）；
  推送通知 payload ≤ 4 KiB（厂商通道限制，只含摘要级字段）。
- 分页协议：游标 + limit + 方向（forward 默认 / backward 供会话首屏尾部倒序拉取）；
  pageSize 默认 200、上限 1000；`hasMore` 续拉。

### 1.6 实现落点结论

- 新类型全部落 `crates/conex-types/src/device/` 模块族（envelope / pair / token /
  events / commands / stream / error / version），**不新建 crate**。
- 新增注册表 `crates/conex-types/contracts/device-protocol.json`，把
  `scripts/generate-engine-bindings.mjs` **泛化为多注册表分发**（`contract` 字段
  区分 engine-events / device-protocol），输出
  `packages/shared-types/src/generated/device/{messages,types,parser,index,errors,capabilities}.ts`；
  事件体不重新生成（移动端直接复用既有 `parseEngineEvent`）。

---

## 2. 范围、依据与重要勘误

### 2.1 本设计与 D3 / D6 / D7 的分工

| 文档 | 覆盖 | M6 的增量 |
|---|---|---|
| D3 | 协议分层、信封、配对密码学、认证、错误码框架、流框架、版本化框架 | 不重复；M6 引用其第 4-10 章 |
| D6 | 同步模型（投影 + 增量 + 命令 + 通知）、游标语义、裁剪原则、对账 | M6 把裁剪原则落到**逐事件字段级**规则表，并把「通道 B 事件」与 D3 的 resume 会话面合并为同步面 |
| D7 | 推送场景（13 个）、厂商通道、防打扰 | M6 在事件表给每事件标注 **pushLevel**（p0/p1/p2/none），与 D7 §3 场景清单一一对应 |
| F1-F6 | 六域功能与数据需求 | M6 把每域的功能需求**翻译为具体命令消息**（名称 / 方向 / 参数 / 响应 / 错误码 / 幂等性） |

### 2.2 代码事实基线（本设计依赖，均以仓库当前主干为准）

| 事实 | 位置 | 对本设计的意义 |
|---|---|---|
| AgentEvent 41 变体（字段级） | `crates/conex-types/src/events.rs:306-782` | 事件载荷唯一事实源，第 5 章逐事件映射 |
| 事件类型名清单 | `events.rs:810-852`（ALL_TYPE_NAMES） | type 字面量校验 |
| 背压分级 | `events.rs:867-903`（event_backpressure / subagent_event_kind_backpressure） | 第 7 章背压策略的直接依据 |
| 事件信封扁平 JSON | `events.rs:905-1013`（AgentEventEnvelope） | 跨端事件载荷形态（透传不二次包装） |
| 事件存储游标 | `crates/conex-db/src/events.rs:33-121`（query_events / reserve_sequence / seed_sequence） | 同步面游标语义（开区间 `sequence > ?`） |
| 命令面真源 | `apps/agent-workbench/src-tauri/src/command_manifest.rs:68-191` | 第 4 章桌面命令映射（95 条） |
| 事件分页契约 EventPage | `apps/agent-workbench/src-tauri/src/core_query_commands.rs:326-338` | 同步面分页形状 `{events, nextAfterSequence, hasMore}` |
| 生成器 | `scripts/generate-engine-bindings.mjs`（注册表驱动 + 确定性字节 + PARSER_PREAMBLE） | 第 12 章生成器泛化基础 |

### 2.3 重要勘误：命令面为 95 条（不是 D3 引用的 92 条）

D3 第 2.4 节引用「92 条命令（注册面 88 + 登记先行 4）」；按当前代码事实
（`command_manifest.rs:63-191` 与测试 `manifest_count_matches_registered_surface`）：

- **当前总数 95 条 = 注册面 91 + 登记先行 4**；
- 增量：27 方案 S6 浏览器面板新增 `browser_start` / `browser_stop` /
  `browser_status` 三条（`command_manifest.rs:182-184`），均已 registered=true；
- 登记先行 4 条仍为 `registered=false`：`append_session_messages`、
  `workbench_open_workspace`、`workbench_list_workspaces`、
  `workbench_dev_mcp_enabled`（`command_manifest.rs:186-189`）。

**对 M6 的影响**：移动端白名单清单以「manifest 拉取 + surface=engine 过滤 +
M6 命令映射表」三重约束为准，不写死命令总数（版本演进自动跟随 manifest）。

### 2.4 设计原则（贯穿全文）

1. **命令 = Tauri 命令面的子集镜像**：移动端命令参数/响应 = 对应 Tauri 命令的
   入参/返回 JSON（camelCase 天然一致），跨端不新造第二套参数形状；
2. **事件 = 原样透传 + 出网处裁剪**：事件体不二次包装（D3 §1.3 原则 1）；
   敏感字段裁剪在桌面出网处（Device Relay 事件扇出 + 同步面查询管线）完成，
   移动端本地不存全量（防本地库被读取即泄露）；
3. **移动端不产号**：sequence 以服务端为准，游标只做读侧去重与续传锚点；
4. **fail-closed**：任何未登记裁剪规则的事件只下发元组；
5. **单帧预算硬上限**：1 MiB 帧 + 分块流 + 摘要化三级防线。

---

## 3. 协议消息总览（kind 全表）

### 3.1 kind 命名空间与分发表

所有消息经 L3 信封（`DeviceEnvelope`，D3 §5.3）承载，`kind` 决定 `body` 结构。
下表为完整分发表（kind → 方向 → 关联 schema → 说明），是第 10 章 JSON Schema
与桌面 Relay 路由表的索引。

| kind | 方向 | body schema（见 §10） | 说明 |
|---|---|---|---|
| `pair.hello` | M→D | `PairHello` | 配对请求（码 + 移动公钥 + 设备标识） |
| `pair.challenge` | D→M | `PairChallenge` | 挑战 + 桌面公钥 + 证书指纹 |
| `pair.verify` | M→D | `PairVerify` | 挑战签名 + 设备公钥自签 |
| `pair.ok` | D→M | `PairOk` | 配对成功（desktopId + ttl） |
| `auth.hello` | M→D | `Hello` | 会话握手（版本协商 + 能力 + 断线游标） |
| `auth.hello.ok` | D→M | `HelloOk` | 握手成功（协议版本 + manifest + serverTime） |
| `auth.refresh` | M→D | `Refresh` | 重连刷新（一次性 refresh token） |
| `auth.rotate` | D→M | `Rotate` | 签名上下文轮换（可选扩展） |
| `device.ready` | D→M | `DeviceReady` | 配对完成后桌面通知移动端可正常会话 |
| `device.unlink` | M→D | `DeviceUnlink` | 移动端主动解除配对 |
| `device.revoked` | D→M | `DeviceUnlink` | 桌面撤销设备广播（本设备令牌立即失效） |
| `device.audit` | D→M | `PairAudit` | 设备域审计（paired/unlinked/revoked/failed） |
| `events.subscribe` | M→D | `Subscribe` | 按会话订阅（含断线游标 lastSequences） |
| `events.subscribeAll` | M→D | `SubscribeAll` | 全局轻订阅（type 白名单） |
| `events.subscribe.ok` | D→M | `SubscribeOk` | 订阅确认（逐会话 nextSequence / stale） |
| `events.push` | D→M | `EventsPush` | 事件实时推送（一帧一事件） |
| `events.ack` | M→D | `EventAck` | 事件确认（仅 ackMode=critical 诊断模式） |
| `events.resume` | M→D | `Resume` | 断线续传请求（afterSequence 分页） |
| `events.resume.page` | D→M | `ResumePage` | 续传分页（复用 EventPage 契约） |
| `events.resume.done` | D→M | `ResumeDone` | 续传完成（resumedTo，桌面恢复实时推流） |
| `session.updated` | D→M | `SessionUpdated` | 会话索引变更广播（F5 列表增量刷新） |
| `session.removed` | D→M | `SessionRemoved` | 会话删除广播（本地清理投影与游标） |
| `session.updatedAll` | D→M | `SessionUpdatedAll` | 会话索引全量刷新信号（对账兜底） |
| `cmd.<name>` | M→D | 见 §4 各命令 | 命令请求（37 条，参数 = Tauri 命令入参） |
| `result.<name>` | D→M | `CommandResult` | 命令响应（ok / result / error） |
| `stream.open` | D→M | `StreamOpen` | 大载荷流开启（服务端发起） |
| `stream.chunk` | D→M | `StreamChunk` | 流数据块（≤ 64 KiB） |
| `stream.resume` | M→D | `StreamResume` | 断线续传（字节 offset） |
| `stream.close` | D→M | `StreamClose` | 流结束（ok / error） |
| `heartbeat` | M→D | `Heartbeat` | 保活（30s）+ 时钟校准 |
| `heartbeat.ok` | D→M | `HeartbeatOk` | 心跳回执（60s）+ serverTime |
| `error` | 双向 | `ErrorBody` | 错误通知（可带 reqMsgId 关联请求） |

> 说明 1：`cmd.runTask` 等大载荷上行（prompt）与 `stream.open`（服务端发起下行）
> 方向相反——上行大载荷走「分块提交」专用流（第 7.4 节），上行流方向
> `M→D`，`stream.*` 的 kind 不变、方向由 `from/to` 信封字段区分。
> 说明 2：`session.updated*` 三消息为 M6 新增（D3 仅在 7.3 提及「新会话通知
> session.updated」），支撑 F5 会话列表的增量刷新，替代「列表 4s 轮询」。

### 3.2 消息流向图（L3 视角）

```
移动端                                     桌面
  │  ① 配对期 pair.hello/challenge/verify/ok
  │  ② 握手期 auth.hello → auth.hello.ok（协议协商 + manifest）
  │  ③ 会话期：
  │     - 上行 cmd.*（请求-响应 result.*）
  │     - 下行 events.push / events.resume.page / session.* / stream.chunk
  │     - 双向 heartbeat / error
  │  ④ 断线：auth.refresh → events.subscribe(带 lastSequences) → events.resume*
  │  ⑤ 拆除：device.unlink / 连接关闭
```

### 3.3 消息编号规范（msgId）

- `msgId` = 发送方唯一（`m-<设备短号>-<自增序号>-<随机后缀>`，长度 8-64）；
- 请求-响应关联：`result.*` / `error` 必带 `reqMsgId` = 请求的 `msgId`；
- 幂等键：重发请求**保持 msgId 不变**（D3 §5.4）；业务幂等键见 §9.2。

---

## 4. 命令消息清单（按功能域）

### 4.0 读前须知

- 每域小节先给「域总表」（命令 / 方向 / 对应 Tauri 命令 / 参数要点 / 响应要点 /
  幂等性），随后对关键命令逐条展开（参数 schema 摘要 + 错误码 + 幂等语义）。
- 方向列：`M→D` = 移动端→桌面（命令发起方）；响应均为 `D→M`（`result.<name>`）。
- 错误码列只列该命令特有的错误码；通用错误码（`cmd.invalid` / `cmd.unknown` /
  `internal` / `frame_too_large` / `cmd.timeout` / `cmd.cancelled`）适用于全部命令，
  见 §6.2 全表。
- 桌面命令面 mapping：`command_manifest.rs:68-191` 登记；`[新增]` 标记表示
  F 系列文档建议的移动端专用命令（需桌面壳侧新增接线，见 §12.4）。

### 4.1 功能域 F1：状态查询域（monitor，全只读）

> 数据需求来源：F1 §2.1（Q1-Q12 只读命令）、F1 §6.4（网关请求形状）、
> F1 §3.5（功能 × 命令 × 事件矩阵）。本域命令全部只读，**不注册任何操作命令**
> （F1 §6.3 白名单强制）。

#### 4.1.0 F1 域命令总表（10 条）

| # | 命令 kind | 方向 | 对应 Tauri 命令 | 参数要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|---|
| C01 | `cmd.getStatus` | M→D | `core_get_status` | `{include?}` | 核心状态裁剪子集 | 天然 |
| C02 | `cmd.getRunSnapshot` | M→D | `core_get_run_snapshot` | `{runId, sessionId?}` | `{snapshot}` | 天然 |
| C03 | `cmd.readSessionEvents` | M→D | `core_read_session_events` | `{sessionId, afterSequence?, maxEvents?, direction?}` | EventPage + latestSequence | 天然 |
| C04 | `cmd.readRunEvents` | M→D | `core_read_run_events` | `{runId, sessionId?, afterSequence?, maxEvents?}` | EventPage | 天然 |
| C05 | `cmd.listSessions` | M→D | `list_sessions` | `{}` | `{sessions}` | 天然 |
| C06 | `cmd.listBackgroundTasks` | M→D | `workbench_list_background_tasks` | `{}` | `{tasks}` | 天然 |
| C07 | `cmd.getTaskOutput` | M→D | `workbench_get_background_task_output` | `{taskId, maxLines?, afterLine?}` | `{lines, truncated, lineCount}` | 天然 |
| C08 | `cmd.getFlowSnapshot` | M→D | `get_flow_snapshot` | `{sessionId}` | `{flow}` | 天然 |
| C09 | `cmd.listCommands` | M→D | `core_list_commands` | `{}` | `{contractVersion, commands}` | 天然 |
| C10 | `cmd.getSearchIndex` | M→D | `core_search_files` | `{}` | `{ready, state?}` | 天然 |

#### 4.1.1 C01 `cmd.getStatus`（连接与核心状态卡，F1 F01/F02）

- **方向**：M→D；响应 `result.getStatus`。
- **参数 schema**（`StatusQuery`，全可选）：

```jsonc
{ "include": ["coreStatus", "activeRuns", "pendingApprovals", "bgTaskSummary"] }
```

- **响应 schema**（`StatusResult`，字段裁剪自 `CoreStatus`，F1 §6.4 形状）：

```jsonc
{
  "initialized": true,
  "version": "1.4.2",
  "engineReady": true, "dbReady": true,
  "searchIndexReady": true, "compactionReady": false,
  "providerStatus": { "hasApiKey": true, "model": "deepseek-v4", "credentialMode": "direct" },
  "logLevel": "info",
  "diagnostics": [ { "level": "error", "message": "...", "at": 1754651200000 } ],   // 环形 20
  "lastError": { "kind": "Io", "detail": "..." },
  "restore": { "state": "done", "mode": "snapshot-incremental", "interruptedCount": 0 },
  "backgroundTasks": { "activeCount": 1, "daemonCount": 1 },
  "activeRuns": [ { "runId": "r-1", "sessionId": "s-1", "status": "running",
                    "startedAt": 1754700000000, "prompt": "检查 package.json" } ],
  "pendingApprovals": [ { "toolCallId": "tc-9", "toolName": "shell:write",
                          "runId": "r-1", "summary": "npm test 需要执行权限" } ]
}
```

- **裁剪要点**：`logDir` 默认不下发（路径敏感，诊断页需要时经扩展命令取）；
  `lastError` 只透传 kind + detail（不透传 77 码内部码，D3 §6.3）；
  `diagnostics` 上限 20 条（服务端已保证环形 20）。
- **错误码**：`cmd.engine_not_ready`（引擎未初始化）、`internal`。
- **幂等性**：天然幂等；无副作用；可用作连通性探测（F1 §5.4 在线判定）。
- **桌面 mapping**：`core_get_status`（command_manifest.rs:119，registered）。

#### 4.1.2 C02 `cmd.getRunSnapshot`（run 详情状态条 + 用量卡，F1 F04/F07）

- **方向**：M→D。
- **参数**：`{ "runId": "r-01JQ...", "sessionId": "s-abc" }`（sessionId 可选，供校验）。
- **响应**：

```jsonc
{ "snapshot": {
    "runId": "r-01JQ...", "sessionId": "s-abc",
    "status": "awaiting-approval", "cursor": 127,
    "createdAt": 1754700000000, "updatedAt": 1754700030000,
    "endReason": null, "error": null,
    "usage": { "promptTokens": 2100, "completionTokens": 1400, "totalTokens": 3500,
               "sampleCount": 3, "cacheReadTokens": 1800, "cacheWriteTokens": 120,
               "cacheMissTokens": 300, "hitRatio": 0.81 } } }
```

- **裁剪要点**：`usage.sampleCount == 0` 时 `usage` 置 null（不显 0%，F1 §6.4 口径）；
  状态字面量透传保真（`unknown` 不静默改写，D6 §9.2）。
- **错误码**：`cmd.not_found`（run 不存在）、`cmd.invalid`（runId 缺失/非法）。
- **幂等性**：天然幂等。
- **桌面 mapping**：`core_get_run_snapshot`（command_manifest.rs:120）。

#### 4.1.3 C03 `cmd.readSessionEvents`（事件游标分页 = 同步面主查询）

> 本命令是 D6 通道 B 与 D3 `events.resume` 的**共用底层契约**
> （D3 §13.4 开放问题 4：resume 走专用消息、cmd 版留给 UI 手动刷新，两者同契约）。
> 断线续传 `events.resume` 的 `body` 即本命令参数的子集。

- **方向**：M→D。
- **参数**：

```jsonc
{
  "sessionId": "s-abc",
  "afterSequence": 128,          // 开区间游标（≥0，缺省 0 = 从会话头拉取）
  "maxEvents": 200,              // 默认 200，上限 1000
  "direction": "forward"         // forward（默认）| backward（F5 首屏尾部倒序，见 4.1.3.1）
}
```

- **响应**（EventPage 契约，D3 §7.5）：

```jsonc
{
  "sessionId": "s-abc",
  "events": [ { "type": "approval-requested", "runId": "r-01", "sequence": 130,
                "schemaVersion": 1, "sessionId": "s-abc",
                "request": { "id": "req-01", "toolCallId": "tc-9", "toolName": "shell:write",
                             "summary": "npm test 需要执行权限" } } ],   // ← 裁剪后
  "nextAfterSequence": 130,
  "hasMore": true,
  "latestSequence": 135           // 服务端该会话当前 max（游标推进判断）
}
```

- **裁剪要点**：本命令经同步面裁剪管线（§5.2 规则表），返回的 events 已是
  裁剪后形态（白名单过滤 + 摘要化 + fail-closed 元组）；`sequence` 以 DB 行为准
  回填（D3 §2.2）。
- **错误码**：`cmd.not_found`（会话不存在）、`cmd.invalid`（afterSequence < 0 /
  maxEvents > 1000 / direction 非法）。
- **幂等性**：天然幂等（纯读 + 游标语义）；重复请求返回相同事件集；
  移动端按 `(sessionId, sequence)` 应用去重。
- **桌面 mapping**：`core_read_session_events`（command_manifest.rs:122）。

##### 4.1.3.1 backward 方向（新增面，支撑 F5 会话详情首屏）

F5 §2.4 结论：会话详情首屏「从尾部向前拉」最近 1-2 页，再向上滚动加载更早。
现有 `core_read_session_events` 仅 forward。**M6 决策**：扩展本命令 `direction`：

- `backward` 语义：`afterSequence` 解释为「从该序列向下（不含）倒序取 maxEvents 条」，
  返回 `events` 仍按 **sequence 升序**（客户端顺序追加渲染），
  响应 `nextAfterSequence` = 已取到的最小序列 - 1（继续向前的游标），
  `hasMore` = 是否还有更早事件；
- 未传 `direction` 时行为不变（兼容既有调用方）；
- 桌面实现：查询层新增 `ORDER BY sequence DESC LIMIT ?` 反向查询面
  （conex-db 新增 `query_events_backward(session_id, before_sequence, limit)`，
  零改动既有 forward 面）；
- 同步面 resume 恒 forward（游标单调推进，backward 仅 UI 历史浏览使用）。

#### 4.1.4 C04 `cmd.readRunEvents`（run 详情时间线，F1 F04）

- **方向**：M→D。
- **参数**：`{ "runId": "r-01", "afterSequence": 0, "maxEvents": 200 }`。
- **响应**：EventPage 同构（`{events, nextAfterSequence, hasMore}`）。
- **裁剪要点**：与 C03 同管线（run 事件是会话事件的子集，按 runId 过滤）；
  message/tool 全文字段按 §5.2 摘要化。
- **错误码**：`cmd.not_found`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`core_read_run_events`（command_manifest.rs:121）。

#### 4.1.5 C05 `cmd.listSessions`（会话列表，F1 F05 / F5 2.1）

- **方向**：M→D。
- **参数**：`{}`（可选 `includeLastMessage: true` 时列表携带 ≤80 字符最后消息预览）。
- **响应**：

```jsonc
{ "sessions": [ { "id": "s-abc", "title": "修复登录页 bug", "folder": "常规会话",
                  "isPinned": false, "isArchived": false,
                  "timestamp": "2026-08-09T08:00:00Z", "updatedAt": 1754700000000,
                  "messageCount": 42, "engineCursor": 128, "engineLastRunId": "r-01",
                  "hydratedFromEngine": true } ] }
```

- **裁剪要点**：索引条目即 `SessionIndexEntry` 原样（体积小、无敏感字段）；
  `includeLastMessage` 预览截断 80 字符（F5 §5.3 层 L1）。
- **错误码**：`internal`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`list_sessions`（command_manifest.rs:129，session 族 engine 面）。

#### 4.1.6 C06 `cmd.listBackgroundTasks`（任务列表，F1 F09）

- **方向**：M→D。
- **参数**：`{}`。
- **响应**：`{ "tasks": [ { "taskId": "t-7", "command": "npm run build",
  "cwd": "C:\\Software\\conex", "status": "running", "isDaemon": false,
  "startedAt": 1754700000000, "exitCode": null, "lineCount": 42 } ] }`
  （字段裁剪自 `workbench_list_background_tasks` 返回，含已结束任务，归档惰性）。
- **裁剪要点**：不携带输出内容（输出经 C07 按需取）；`cwd` 保留（任务上下文）。
- **错误码**：`internal`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`workbench_list_background_tasks`（command_manifest.rs:85，gui 面）。

> **surface 说明**：`workbench_list_background_tasks` 在 manifest 中 surface=gui，
> 但 F1 §2.1 Q7 明确其为移动端任务页数据源。M6 决策：该命令列入移动端
> **白名单特批**（读命令，无副作用；D3 §8.3 的「仅 surface=engine」规则为本命令
> 开例外，白名单表显式登记，见 §4.8）。

#### 4.1.7 C07 `cmd.getTaskOutput`（任务输出补取，F1 F16 / F3 §4 断线兜底）

- **方向**：M→D。
- **参数**：`{ "taskId": "t-7", "maxLines": 200, "afterLine": 0 }`
  （`afterLine` 可选：从第 N 行继续取，与任务输出补取语义对齐）。
- **响应**：

```jsonc
{ "lines": [ "building...", "✓ compiled in 1.2s" ],
  "truncated": false, "lineCount": 42, "nextAfterLine": 42, "hasMore": false }
```

- **裁剪要点**：行缓冲按 maxLines 截断；单行超 5000 字符截断（F3 §4.0）；
  服务端对超长输出分页（与 `read_file_content` 的 maxLines 阶梯同构）。
- **错误码**：`cmd.not_found`（任务不存在）、`cmd.invalid`（afterLine 负值）。
- **幂等性**：天然幂等（offset 分页）。
- **桌面 mapping**：`workbench_get_background_task_output`（command_manifest.rs:86，白名单特批）。

#### 4.1.8 C08 `cmd.getFlowSnapshot`（子代理 DAG 概览，F1 F13 P2）

- **方向**：M→D。
- **参数**：`{ "sessionId": "s-abc" }`。
- **响应**：`{ "flow": { "flowDeclaration": {...}, "flowState": {...},
  "agents": [ { "agentId": "sub-3", "status": "running", "description": "调研",
                "summary": null, "depth": 1 } ] } }`（字段裁剪自 `get_flow_snapshot`）。
- **裁剪要点**：session_agents 的**完整消息树不下发**（D6 §3.3 N8），只下发
  行投影（status/description/summary/depth）。
- **错误码**：`cmd.not_found`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`get_flow_snapshot`（command_manifest.rs:143）。

#### 4.1.9 C09 `cmd.listCommands`（能力发现，D3 §8.1）

- **方向**：M→D。
- **参数**：`{}`。
- **响应**：`{ "contractVersion": "1.0.0", "commands": [ { "name": "core_get_status",
  "family": "core", "surface": "engine", "registered": true } ] }`。
- **裁剪要点**：原样透传（manifest 本身无敏感字段）；移动端缓存，
  `contractVersion` 变化时提示刷新（D3 §8.1）。
- **错误码**：`internal`。
- **幂等性**：天然幂等；启动即可用、无状态（command_manifest.rs:196-199）。
- **桌面 mapping**：`core_list_commands`（command_manifest.rs:164）。

#### 4.1.10 C10 `cmd.getSearchIndex`（搜索索引就绪状态，F1 F02 诊断）

- **方向**：M→D。
- **参数**：`{}`。
- **响应**：`{ "ready": true, "state": { "totalFiles": 1200, "lastBuiltAt": 1754600000000 } }`
  （字段裁剪自 `core_search_files` 返回）。
- **裁剪要点**：只读状态；`core_rebuild_search_index`（写）不在白名单
  （F1 §6.3 拒绝清单）。
- **错误码**：`cmd.engine_not_ready`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`core_search_files`（command_manifest.rs:113）。

### 4.2 功能域 F2：审批域（approval，唯一跨端写域）

> 数据需求来源：F2 §3.3（PendingApproval 信息模型）、F2 §12（接口契约）、
> F2 §11（状态同步与冲突）。本域是移动端唯一写域，全部决策命令走
> outbox + 幂等键（§9.2），冲突收敛以 `approval-resolved` 事件为唯一裁决。

#### 4.2.0 F2 域命令总表（5 条）

| # | 命令 kind | 方向 | 对应 Tauri 命令 | 参数要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|---|
| C11 | `cmd.approve` | M→D | `core_approve_tool` | `{toolCallId, runId?}` | `{ok, toolCallId, decision}` | 天然（I-02）+ msgId |
| C12 | `cmd.deny` | M→D | `core_deny_tool` | `{toolCallId, runId?, reason?}` | `{ok, toolCallId, decision}` | 天然（I-02）+ msgId |
| C13 | `cmd.listPendingApprovals` | M→D | `[新增] mobile_list_pending_approvals` | `{afterSequence?}` | `{approvals, latestSequence}` | 天然 |
| C14 | `cmd.approvalHistory` | M→D | `[新增] mobile_approval_sync_state` | `{sessionId?, afterSequence?, limit?}` | `{items}` | 天然 |
| C15 | `cmd.checkCommand` | M→D | `core_check_command` | `{command, params?}` | `{decision, reason?}` | 天然 |

#### 4.2.1 C11 `cmd.approve` / C12 `cmd.deny`（决策命令，F2 §5.2）

- **方向**：M→D；响应 `result.approve` / `result.deny`。
- **参数**：

```jsonc
// cmd.approve
{ "toolCallId": "tc-9", "runId": "r-01" }                    // decision 恒 approved
// cmd.deny
{ "toolCallId": "tc-9", "runId": "r-01", "reason": "风险过高" }   // reason ≤ 256 字符，缺省 "user denied"
```

> F2 §2.3 事实：`core_approve_tool` 的 decision 参数只接受 approved，其余
> InvalidInput 拒绝——跨端参数**不提供 decision 字段**（协议面消灭「传错决策」
> 的可能性，对齐 F2 §12.3 错误映射）。
> `runId` 为校验辅助（桌面侧以 toolCallId 为真键，runId 缺失时按待审批集合
> 反查，缺失容错）。

- **响应**（对齐 `core_run_commands.rs:122-129` 返回形状）：

```jsonc
{ "ok": true, "toolCallId": "tc-9", "decision": "approved" }
```

- **错误码**：
  - `cmd.approval_mismatch`：tool_call_id 不在待审批集合（I-02 语义，
    core_run_commands.rs:230-258）——即「已被其他设备处理 / 已过期」的标准信号，
    移动端据此收敛（F2 §11.2 冲突表）；
  - `cmd.denied`：命令不在设备白名单；
  - `cmd.timeout`（移动端本地）：网络超时 → 重发同 msgId（幂等键不变）。
- **幂等性**：**天然幂等（状态机级）**——第二次命中同一 toolCallId →
  `cmd.approval_mismatch`，不改状态机（D3 §8.5）；叠加请求级幂等：
  同 msgId 重发回显缓存结果（TTL 5min，D3 §5.4）。
- **桌面 mapping**：`core_approve_tool` / `core_deny_tool`
  （command_manifest.rs:126-127）。

#### 4.2.2 C13 `cmd.listPendingApprovals`（启动对账，F2 §4.1）

> F2 §12.2 建议的新增命令；对账是待办列表真值的兜底通道
> （实时事件可能错过 / 推送可能不到，F2 §6.4）。

- **方向**：M→D。
- **参数**：`{}`（可选 `afterSequence`：只返回该水位之后新出现的待办，增量对账）。
- **响应**：

```jsonc
{ "approvals": [ { "requestId": "req-01", "toolCallId": "tc-9",
    "toolName": "shell:write", "summary": "npm test 需要执行权限",
    "cwd": "C:\\Software\\conex", "sessionId": "s-abc", "runId": "r-01",
    "requesterRunId": null, "reason": null, "arbiter": "user",
    "requestedAt": 1754700000000, "expiresAt": 1754700120000,
    "dangerLevel": 1 } ],
  "latestSequence": 135 }
```

- **语义**：桌面派生 = events 表 `approval-requested` 且无配对
  `approval-resolved` 且 run 未终态（D6 §3.4 派生视图，不新建业务表）。
- **裁剪要点**：`parameters` 全量**不下发**（隐私红线，D6 §7.2）；
  危险级别 `dangerLevel` 由桌面按 F2 §2.2 表推导（删除影响面 / C3 回退面积 /
  命令越界），移动端不重算。
- **错误码**：`internal`。
- **幂等性**：天然幂等（纯读对账）。
- **桌面 mapping**：`[新增] mobile_list_pending_approvals`
  （引擎侧从 events 表派生，见 §12.4 落点）。

#### 4.2.3 C14 `cmd.approvalHistory`（审批历史补拉，F2 §7）

- **方向**：M→D。
- **参数**：`{ "sessionId": "s-abc", "afterSequence": 100, "limit": 100 }`。
- **响应**：

```jsonc
{ "items": [ { "sequence": 132, "toolCallId": "tc-9", "toolName": "shell:write",
    "decision": "approved", "reason": "远程批准", "channel": "mobile",
    "resolvedAt": 1754700050000, "sessionId": "s-abc", "runId": "r-01" } ],
  "nextAfterSequence": 132, "hasMore": false }
```

- **语义**：历史 = `approval-resolved` 事件白名单投影（按 sequence 水位）；
  移动端本地过期条目（本地倒计时到期的 expired，F2 §7.1）与桌面历史合并展示。
- **裁剪要点**：不携带参数全量（与 C13 同红线）。
- **错误码**：`cmd.not_found`（会话不存在）。
- **幂等性**：天然幂等。
- **桌面 mapping**：`[新增] mobile_approval_sync_state`（可并入 C13 实现，见 §12.4）。

#### 4.2.4 C15 `cmd.checkCommand`（审批前置预览，D3 §8.3）

- **方向**：M→D。
- **参数**：`{ "command": "shell:write", "params": { "script": "npm test" } }`。
- **响应**：`{ "decision": "requires-approval", "reason": "shell:write 需要审批" }`
  （`decision` ∈ allowed / requires-approval / blocked）。
- **语义**：只读判定预览，**不是安全判定**（真实判定永远在引擎 gatekeeper /
  审批门，D3 §8.3）；移动端 UI 据此展示「此命令需审批」预提示。
- **错误码**：`cmd.unknown`（命令未注册）。
- **幂等性**：天然幂等。
- **桌面 mapping**：`core_check_command`（command_manifest.rs:112）。

### 4.3 功能域 F4：文件与资产域（files）

> 数据需求来源：F4 §2.1（fs_commands 盘点）、F4 §3.6（新增命令建议 M4-1..M4-5）、
> F4 §4（读写策略）、F4 附录 A（命令映射总表）。
> 铁律：移动端只传相对路径（relPath）或空串（=工作区根）；绝对路径在 SDK 层
> 本地拒绝（F4 §7.2）；桌面 `resolve_guard` 沙箱兜底。

#### 4.3.0 F4 域命令总表（8 条）

| # | 命令 kind | 方向 | 对应 Tauri 命令 | 参数要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|---|
| C16 | `cmd.listDir` | M→D | `workbench_list_directory` | `{path?, workspaceRoot?}` | `{entries}` | 天然 |
| C17 | `cmd.readFile` | M→D | `workbench_read_file_content` | `{path, workspaceRoot?, maxLines?, startLine?}` | `{content, lineCount, truncated}` | 天然 |
| C18 | `cmd.writeFile` | M→D | `workbench_write_file_content` | `{path, content, overwrite?}` | `{ok, path}` | **msgId 幂等键** |
| C19 | `cmd.listWorkspaces` | M→D | `workbench_list_workspaces` + `[新增] mobile_get_workspace_state` | `{}` | `{workspaces}` | 天然 |
| C20 | `cmd.switchWorkspace` | M→D | `workbench_open_workspace`（M4-1 接线） | `{path}` | `{ok, activeRoot}` | 天然 |
| C21 | `cmd.searchFiles` | M→D | `[新增] mobile_search_files`（→ fuzzy_find） | `{query, root?, maxResults?}` | `{results}` | 天然 |
| C22 | `cmd.assetUrl` | M→D | `[新增] mobile_asset_url`（→ convertFileSrc） | `{path, kind}` | `{url, expiresAt}` | 天然（每次新令牌） |
| C23 | `cmd.fileStat` | M→D | `file_stat` 代理 | `{path, workspaceRoot?}` | `{size, modified, readonly, kind}` | 天然 |

#### 4.3.1 C16 `cmd.listDir`（目录列表，F4 F4-F10）

- **方向**：M→D。
- **参数**：`{ "path": "src/components", "workspaceRoot": null }`
  （path 缺省/空串 = 工作区根；workspaceRoot 缺省 = 当前活动根）。
- **响应**：

```jsonc
{ "entries": [ { "name": "hooks", "isDir": true },
               { "name": "FilesCard.tsx", "isDir": false, "size": 15360,
                 "modified": "1754700000000" } ] }
```

- **裁剪要点**：原样透传 `DirectoryItem`（排序由桌面保证：目录优先 + 字母序，
  F4 §2.2）；node_modules/.git/target/dist/build 已被桌面过滤。
- **错误码**：`file.not_found`（路径不存在）、`file.not_granted`（越出授权根）、
  `cmd.invalid`（路径格式非法——SDK 层已本地拦截大部分）。
- **幂等性**：天然幂等。
- **桌面 mapping**：`workbench_list_directory`（command_manifest.rs:92，gui 面，白名单特批）。

#### 4.3.2 C17 `cmd.readFile`（分块读文件，F4 §4.1）

- **方向**：M→D。
- **参数**：`{ "path": "src/FilesCard.tsx", "maxLines": 400, "startLine": 0 }`
  （maxLines 默认 400、硬顶 5000，与 `FILE_PREVIEW_CHUNK_LINES` 对齐，F4 §5.3）。
- **响应**：

```jsonc
{ "content": "import React from 'react';\n...", "lineCount": 3000, "truncated": true }
```

- **裁剪要点**：1MB / 5000 行硬顶由桌面端强制（F4 §2.3）；敏感文件标记
  `sensitive: true`——**M6 决策：敏感判定在桌面端做**（规则表下沉共享常量包，
  F4 §10 R4-4），响应带 `sensitive` 布尔，移动端 UI 依标记渲染横幅且不缓存。
- **错误码**：`file.not_found`、`file.too_large`（>1MB）、`file.not_granted`、
  `cmd.invalid`（detail: `binary_file` / `unsupported_encoding`——F4 附录 B 映射）。
- **幂等性**：天然幂等（offset 分页）。
- **桌面 mapping**：`workbench_read_file_content`（command_manifest.rs:93，白名单特批）。

#### 4.3.3 C18 `cmd.writeFile`（受控写文件，F4 §4.3）

- **方向**：M→D；**本域唯一写命令**。
- **参数**：

```jsonc
{ "path": "src/notes.md", "content": "更新内容...", "overwrite": true, "workspaceRoot": null }
```

- **响应**：`{ "ok": true, "path": "src/notes.md" }`。
- **错误码**：
  - `file.not_granted`（越界 / 未授权）；
  - `cmd.invalid`（detail: `file_exists`——overwrite=false 且文件已存在，
    F4 §2.4 语义；移动端据此弹「覆盖确认」后带 overwrite=true 重发）；
  - `file.too_large`（>1MB）；
  - `cmd.denied`（敏感文件禁写，F4 §7.1 规则在桌面端同样判定）。
- **幂等性**：**非天然幂等（写操作）**——走 outbox + 幂等键：
  重发同 `msgId` 时桌面回显首次结果（成功/失败），不重复写入；
  移动端本地草稿保留（断线不静默重发，F4 §5.3）。
- **桌面 mapping**：`workbench_write_file_content`（command_manifest.rs:94，白名单特批）。

#### 4.3.4 C19 `cmd.listWorkspaces`（工作区列表，F4 F4-F01）

- **方向**：M→D。
- **参数**：`{}`。
- **响应**：

```jsonc
{ "workspaces": [ { "root": "C:\\Software\\conex", "name": "conex",
                    "active": true, "reachable": true } ] }
```

- **语义**：一次调用替代多次 list 拼接（M4-2 `mobile_get_workspace_state`）；
  `reachable` = canonicalize 探测（盘符移除等不可达标记，F4 F4-F03）。
- **错误码**：`internal`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`workbench_list_workspaces`（command_manifest.rs:188，登记先行）+
  `[新增] mobile_get_workspace_state`。

#### 4.3.5 C20 `cmd.switchWorkspace`（切换活动根，F4 F4-F02）

- **方向**：M→D。
- **参数**：`{ "path": "C:\\Software\\conex" }`。
- **响应**：`{ "ok": true, "activeRoot": "C:\\Software\\conex" }`。
- **语义**：桌面端复授权校验（recent 列表内才放行，F4 §2.1）；
  切换成功后移动端清空目录/内容缓存（F4 附录 A）。
- **错误码**：`file.not_granted`（不在 recent 授权列表）、`cmd.not_found`。
- **幂等性**：天然幂等（切到同一根重复执行无害）。
- **桌面 mapping**：`workbench_open_workspace`（command_manifest.rs:187，登记先行；
  M4-1 接线后 registered=true，见 §12.4）。

#### 4.3.6 C21 `cmd.searchFiles`（递归文件名搜索，F4 F4-F41）

- **方向**：M→D。
- **参数**：`{ "query": "FileTree", "root": "src", "maxResults": 100 }`
  （maxResults ≤ 100，桌面端钳制）。
- **响应**：

```jsonc
{ "results": [ { "relPath": "src/components/files/FileTreeView.tsx",
                 "kind": "text", "size": 12288 } ] }
```

- **裁剪要点**：只返回 relPath + kind + size（F4 §5.5）；敏感文件路径命中时
  桌面端过滤（内容搜索默认排除敏感文件，F4 §10 R4-2）。
- **错误码**：`cmd.invalid`（query 空/超长）、`file.not_granted`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`[新增] mobile_search_files`（薄壳封装 `fuzzy_find`，见 §12.4）。

#### 4.3.7 C22 `cmd.assetUrl`（图片/PDF 资源 URL，F4 §5.4）

- **方向**：M→D。
- **参数**：`{ "path": "docs/logo.png", "kind": "image" }`
  （kind ∈ image / pdf / thumbnail）。
- **响应**：`{ "url": "https://192.168.1.10:18461/assets/<enc>?token=<短期令牌>",
  "expiresAt": 1754700600000 }`。
- **语义**：桌面端计算资源协议 URL 的 HTTP 代理形态；令牌 10 分钟有效、
  仅接受已授权根内相对路径（F4 §5.4 安全）；URL 只在移动端内存态，不持久化。
- **错误码**：`file.not_granted`、`file.not_found`。
- **幂等性**：读语义幂等；每次调用返回新令牌 URL（旧 URL 过期即失效）。
- **桌面 mapping**：`[新增] mobile_asset_url`（convertFileSrc 代理，见 §12.4）。

#### 4.3.8 C23 `cmd.fileStat`（文件元数据，F4 F4-F29）

- **方向**：M→D。
- **参数**：`{ "path": "src/a.ts", "workspaceRoot": null }`。
- **响应**：`{ "size": 4096, "modified": "1754700000000", "readonly": false,
  "kind": "text" }`。
- **错误码**：`file.not_found`、`file.not_granted`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`file_stat` 工具代理（薄壳，见 §12.4）。

### 4.4 功能域 F5：会话与消息域（sessions）

> 数据需求来源：F5 §2.1-2.6（会话列表 / 详情 / 实时 / 历史 / 发起 / 搜索）、
> F5 §5（分层同步模型）。**P1 冻结只读**：`cmd.runTask` 等写命令按 P2 预留
> （F5 §2.5 结论），本期白名单默认关闭、能力位 `runTask` 控制（§11.2）。

#### 4.4.0 F5 域命令总表（4 条 + 2 条复用）

| # | 命令 kind | 方向 | 对应 Tauri 命令 | 参数要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|---|
| C24 | `cmd.runTask` | M→D | `core_run_task` | `{sessionId?, prompt, mode?, cwd?, permissionMode?, history?, clientMessageId?}` | `{runId, sessionId}` | clientMessageId |
| C25 | `cmd.runControl` | M→D | `core_run_control` | `{level, runId, sessionId, reason?, payload?}` | `{ok}` | 天然（幂等控制） |
| C26 | `cmd.cancelRun` | M→D | `core_cancel_run` | `{runId, reason?}` | `{ok, runId}` | 天然 |
| C27 | `cmd.searchSessions` | M→D | `[新增] mobile_search_sessions` | `{query, limit?}` | `{results}` | 天然 |
| （复用）C05 | `cmd.listSessions` | M→D | `list_sessions` | 见 4.1.5 | 会话列表 | 天然 |
| （复用）C03 | `cmd.readSessionEvents` | M→D | `core_read_session_events` | 见 4.1.3 | 历史分页 | 天然 |

#### 4.4.1 C24 `cmd.runTask`（发起 run，P2 委托执行，F5 §2.5）

- **方向**：M→D；**P2 能力位 `runTask` 默认关闭**，本命令为协议预留。
- **参数**：

```jsonc
{ "sessionId": "s-abc",            // 缺省 = 桌面新建会话（commitDraftIfNeeded 语义）
  "prompt": "帮我修登录页 bug",      // 跨端上限 256 KiB（见 §8.1），超限走流上传
  "mode": null, "cwd": null,
  "permissionMode": "ask",          // 缺省 ask；full-access 移动端不可改（D3 §8.2）
  "history": null,                  // 移动端一般省略（桌面 SessionHistoryCache 兜底）
  "clientMessageId": "msg-01HZ..." } // 用户消息本地乐观 id（幂等键）
```

- **响应**：`{ "runId": "r-01JQ...", "sessionId": "s-abc" }`
  （runId 由桌面生成，D3 §8.1）。
- **错误码**：`cmd.engine_not_ready`、`cmd.restore_in_progress`（恢复中拒绝 run）、
  `cmd.session_busy`（会话串行守卫，core_run_commands.rs:3082-3090）、
  `cmd.denied`（白名单 / 能力位未开）、`cmd.invalid`（prompt 超限等）。
- **幂等性**：**clientMessageId 幂等**——同 clientMessageId 重发 →
  返回首次创建的 runId，不重复开 run（F5 §1.8：clientMessageId 为稳定幂等键）。
- **桌面 mapping**：`core_run_task`（command_manifest.rs:123）。

#### 4.4.2 C25 `cmd.runControl`（L0-L3 run 控制，D3 §8.2）

- **方向**：M→D。
- **参数**：

```jsonc
{ "level": "cooperative_stop",      // continue | soft_inject | cooperative_stop | force_cancel
  "runId": "r-01", "sessionId": "s-abc",
  "reason": "用户远程暂停",          // ≤ 256
  "payload": null }                  // L1 soft_inject: {text}; L0 continue: {message?}
```

- **响应**：`{ "ok": true }`。
- **错误码**：`cmd.not_found`（run 不存在）、`cmd.invalid`（level 非法 /
  payload 缺失）、`cmd.denied`。
- **幂等性**：`cooperative_stop` / `force_cancel` 重复 = 无副作用（ControlBus 幂等，
  D3 §8.5）；`continue` 重复无害；`soft_inject` 以 payload 内消息 id 幂等。
- **桌面 mapping**：`core_run_control`（command_manifest.rs:124）。
- **归属说明**：F2 §6.2 建议 run 控制归审批域「run 控制子页」承载——协议层
  命令归属不变（`cmd.runControl`），UI 归属由功能域定。

#### 4.4.3 C26 `cmd.cancelRun`（取消 run，D3 §8.2）

- **方向**：M→D。
- **参数**：`{ "runId": "r-01", "reason": "用户远程取消" }`。
- **响应**：`{ "ok": true, "runId": "r-01" }`。
- **错误码**：`cmd.not_found`、`cmd.invalid`。
- **幂等性**：重复 cancel 无副作用（终态拒绝，TerminalImmutable，run.rs:345-347）。
- **桌面 mapping**：`core_cancel_run`（command_manifest.rs:125）。

#### 4.4.4 C27 `cmd.searchSessions`（服务端会话搜索，P2 预留，F5 §2.6）

- **方向**：M→D。
- **参数**：`{ "query": "markdown", "limit": 50 }`。
- **响应**：

```jsonc
{ "results": [ { "sessionId": "s-abc", "title": "调研 markdown 渲染",
                 "hitCount": 3, "snippet": "…轻量 markdown…" } ] }
```

- **语义**：P2 新增能力（桌面无服务端索引，需新增——v1 不实现，
  移动端用本地标题过滤 + 已加载消息内搜索兜底，F5 §2.6）。
- **错误码**：`cmd.unknown`（v1 未注册时返回）、`cmd.invalid`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`[新增] mobile_search_sessions`（v2，见 §12.4 预留）。

### 4.5 功能域 F6：设置与账户域（settings）

> 数据需求来源：F6 §3（设置归属决策矩阵）、F6 §8.3-8.4（桌面确认通道）、
> F6 §4.2（mobileSettingsStore 镜像分片）。
> 红线：权限模式只读展示、手机端不改（F6 §8.1）；设置变更经**桌面确认通道**
> 最终确认权在桌面（F6 §8.3）。

#### 4.5.0 F6 域命令总表（5 条）

| # | 命令 kind | 方向 | 对应 Tauri 命令 | 参数要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|---|
| C28 | `cmd.getSettings` | M→D | `config_get`（脱敏快照） | `{keys?}` | `{settings}` | 天然 |
| C29 | `cmd.setSettings` | M→D | `config_update` | `{key, value}` | `{ok}` 或 `{pending, confirmRequestId}` | 设置键幂等 |
| C30 | `cmd.settingsConfirm` | M→D | `[新增] mobile_settings_confirm` | `{confirmRequestId, action}` | `{status}` | confirmRequestId |
| C31 | `cmd.pauseAutomation` | M→D | `[新增] mobile_pause_automation` | `{durationSec?}` | `{ok, pausedUntil}` | 天然 |
| C32 | `cmd.queryPresence` | M→D | `[新增] device_presence_query` | `{}` | `{desktopOnline, lastInteractionAt}` | 天然 |

#### 4.5.1 C28 `cmd.getSettings`（设置镜像拉取，F6 §4.2 mirror 分片）

- **方向**：M→D。
- **参数**：`{}`（可选 `keys` 白名单子集：responseStyle / enableAnalytics /
  enableCrashTelemetry / permissionMode / trustedCommandCount / activeProfileId /
  defaultModel / usageSummary）。
- **响应**：

```jsonc
{ "settings": { "responseStyle": "balanced", "enableAnalytics": true,
    "enableCrashTelemetry": false, "permissionMode": "ask",
    "trustedCommandCount": 12, "activeProfileId": "p-main",
    "defaultModel": "deepseek-v4",
    "usageSummary": { "totalPromptTokens": 123400, "totalCompletionTokens": 88200,
                      "totalCostUsd": 1.23 } } }
```

- **裁剪要点**：apiKey 恒空串 + last4 脱敏（F6 §2.3）；`mirror` 分片移动端
  **不持久化**（F6 §4.2 关键约束，冷启动重拉）。
- **错误码**：`cmd.denied`（请求 keys 越出白名单——恒拒绝）、`internal`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`config_get`（command_manifest.rs:100）。

#### 4.5.2 C29 `cmd.setSettings`（非安全设置变更，F6 §8.3 桌面确认通道）

- **方向**：M→D。
- **参数**：`{ "key": "responseStyle", "value": "high" }`
  （key 白名单恒为：responseStyle / enableAnalytics / enableCrashTelemetry；
  其余一律 `cmd.denied`）。
- **响应**（两态）：

```jsonc
// 直接生效（无确认要求的键，或桌面已配置「记住选择」）
{ "ok": true, "applied": true }
// 需桌面确认：进入待确认队列，60s 超时未响应视为拒绝
{ "ok": true, "applied": false, "pending": true, "confirmRequestId": "cf-01HZ..." }
```

- **错误码**：`cmd.denied`（非白名单键）、`cmd.invalid`（值非法）、
  `cmd.timeout`（移动端本地 60s 超时 → 提示「桌面端未确认，变更未生效」，F6 §8.3）。
- **幂等性**：设置键幂等（同 key 同 value 重发无害）；`confirmRequestId`
  去重（同请求不重复弹桌面确认条）。
- **桌面 mapping**：`config_update`（command_manifest.rs:101）+ `[新增]` 确认回调面。

#### 4.5.3 C30 `cmd.settingsConfirm`（桌面确认请求管理）

- **方向**：M→D。桌面确认条的裁决由桌面 UI 完成（F6 §8.3「接受/忽略」）；
  本命令用于移动端**撤回**待确认请求与查询状态。
- **参数**：`{ "confirmRequestId": "cf-01HZ...", "action": "withdraw" }`。
- **响应**：`{ "status": "withdrawn" }`。
- **错误码**：`cmd.not_found`（请求已处理/已过期）。
- **幂等性**：天然（撤回已撤回 = 成功）。
- **桌面 mapping**：`[新增] mobile_settings_confirm`。

#### 4.5.4 C31 `cmd.pauseAutomation`（临时暂停自动执行，F6 §8.2 受限触发）

- **方向**：M→D。
- **参数**：`{ "durationSec": 3600 }`（默认 3600，上限 86400）。
- **响应**：`{ "ok": true, "pausedUntil": 1754703600000 }`。
- **语义**：一次性指令，不改变持久化配置（F6 §8.2「受限触发」）；
  桌面端确认后生效（可并入桌面确认通道）。
- **错误码**：`cmd.denied`。
- **幂等性**：天然幂等（重复暂停刷新 pausedUntil）。
- **桌面 mapping**：`[新增] mobile_pause_automation`。

#### 4.5.5 C32 `cmd.queryPresence`（桌面在场查询，F2 §9.2 双因素衔接）

- **方向**：M→D。
- **参数**：`{}`。
- **响应**：`{ "desktopOnline": true, "lastInteractionAt": 1754700000000,
  "engineVersion": "1.4.2" }`。
- **语义**：双因素「桌面在场」的校验信号源（F2 §9.2）；`lastInteractionAt` =
  桌面端最近用户交互时间（安全域心跳上报）。
- **错误码**：`internal`。
- **幂等性**：天然幂等。
- **桌面 mapping**：`[新增] device_presence_query`（见 §12.4）。

### 4.6 设备域命令（devices）

> 数据需求来源：F6 §6（设备列表 / 撤销 / 重命名）、D3 §4（配对协议）。
> 配对期消息（pair.*）为握手期消息（§10.3），本域命令为**会话期设备管理**。

#### 4.6.0 设备域命令总表（5 条）

| # | 命令 kind | 方向 | 对应实现 | 参数要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|---|
| C33 | `cmd.listDevices` | M→D | Device Registry 查询 | `{}` | `{devices}` | 天然 |
| C34 | `cmd.renameDevice` | M→D | Device Registry 更新 | `{deviceId, name}` | `{ok}` | 天然 |
| C35 | `cmd.revokeDevice` | M→D | Device Registry 删除 + 广播 | `{deviceId}` | `{ok}` | 天然 |
| C36 | `cmd.getPairState` | M→D | Pairing Service 状态 | `{}` | `{state, desktopId?}` | 天然 |
| C37 | `cmd.unlink` | M→D | 设备解除 | `{}` | `{ok}` | 天然 |

#### 4.6.1 C33 `cmd.listDevices`（设备列表，F6 §6.2）

- **方向**：M→D。
- **参数**：`{}`。
- **响应**：

```jsonc
{ "devices": [ { "deviceId": "7f0a...c2", "name": "我的 iPhone", "type": "phone",
    "role": "this", "channel": "lan", "online": true,
    "lastActiveAt": 1754700000000, "pairedAt": "2026-08-01T08:00:00Z",
    "needsReauth": false } ] }
```

- **裁剪要点**：deviceId 前端短显（前 4 + 后 2，F6 §6.5）；
  `needsReauth` = 桌面重装后配对失效标记（F6 §6.6）。
- **错误码**：`internal`。
- **幂等性**：天然幂等。
- **桌面 mapping**：Device Registry 查询（§12.4 新增面）。

#### 4.6.2 C34 `cmd.renameDevice` / C35 `cmd.revokeDevice` / C37 `cmd.unlink`

- **C34 参数**：`{ "deviceId": "7f0a...", "name": "备用机" }`（name ≤ 64）；
  响应 `{ok}`；幂等天然；错误码 `cmd.not_found`（设备不存在）。
- **C35 参数**：`{ "deviceId": "7f0a..." }`；响应 `{ok}` + 桌面广播
  `device.revoked`（被撤销设备令牌立即失效，D3 §4.7）；幂等天然
  （撤销已撤销 → 成功）；错误码 `cmd.not_found`。
- **C37 参数**：`{}`（解除本设备配对）；响应 `{ok}`；桌面删除本设备表条目 +
  广播；幂等天然；错误码 `cmd.not_found`。
- **桌面 mapping**：Pairing Service / Device Registry（§12.4）。

#### 4.6.3 C36 `cmd.getPairState`（配对状态查询）

- **方向**：M→D（本地状态为主，此命令用于配对页多端一致性核对）。
- **参数**：`{}`。
- **响应**：`{ "state": "done", "desktopId": "d-01HZ..." }`
  （state ∈ none/scanning/inputting/handshaking/done/failed，F6 §6.4）。
- **幂等性**：天然幂等。

### 4.7 桌面端命令面 mapping（95 条全览）

下表把 manifest 的 95 条命令按「移动端关系」归类，是白名单的实现依据：

| 归类 | 命令（manifest 名） | 移动端处理 |
|---|---|---|
| **A 移动端命令映射（37 条 → §4.1-4.6）** | core_get_status / core_get_run_snapshot / core_read_session_events / core_read_run_events / list_sessions / get_flow_snapshot / core_list_commands / core_search_files / core_approve_tool / core_deny_tool / core_check_command / core_run_task / core_run_control / core_cancel_run / workbench_list_background_tasks / workbench_get_background_task_output / workbench_list_directory / workbench_read_file_content / workbench_write_file_content / workbench_list_workspaces / workbench_open_workspace / config_get / config_update（+ 新增 mobile_* 6 条：mobile_list_pending_approvals / mobile_approval_sync_state / mobile_get_workspace_state / mobile_search_files / mobile_asset_url / mobile_settings_confirm / mobile_pause_automation / device_presence_query / mobile_search_sessions(P2)） | 白名单（含新增面） |
| **B 只读可开放但 v1 不接** | catalog_get / trash_list / core_compute_diff / core_count_tokens / core_md_render / core_md_render_batch / core_highlight_code / core_hash_compute / core_base64_encode / core_base64_decode / core_detect_encoding / core_decode_text / core_parse_diff / core_messages_to_jsonl / core_jsonl_to_messages / core_text_encode / core_jsonl_append / browser_status / list-workflows / list-workflow-runs | 能力位预留（按需开放） |
| **C 写操作 / 安全敏感默认拒绝** | core_rebuild_search_index / core_compact_messages / config_update（非白名单键）/ config_secret_* / config_profile_apply / config_get_outputs_root / config_set_outputs_root / core_md_clear_cache / save_session_body / save_session_agents / set_session_meta / set_session_output_root / delete_session / cleanup_orphan_sessions / import_from_localstorage / upsert_session_entry / touch_session / append_session_messages / trash_restore / trash_purge / create-workflow / update-workflow / delete-workflow / trigger-workflow / browser_start / browser_stop / catalog_refresh / workbench_cancel_background_task / workbench_send_input / workbench_fs_delete_file / workbench_http_request / workbench_apply_update / workbench_discover_skills / workbench_run_shell / workbench_git_run / workbench_pty_* / workbench_select_folder / workbench_list_host_openers / workbench_open_host_target / workbench_open_path_default / workbench_list_file_openers / workbench_dev_mcp_enabled | 一律 `cmd.denied` |
| **D 既有 IPC 内部面** | load_session_body / load_session_agents / get_session_meta | 桌面前端专用；移动端经事件流/投影获取，不直调 |

> **白名单三重约束**（D3 §8.3 细化）：① manifest 拉取 `surface=engine` 且
> `registered=true`；② M6 命令映射表（§4.1-4.6）列名；③ 设备级
> `allowedCommands` 配置（Device Registry 每设备存，默认 = M6 映射表 + 白名单
> 特批读命令）。三者取交集；缺任一即 `cmd.denied`。

### 4.8 白名单特批说明（surface=gui 例外）

`workbench_list_background_tasks` / `workbench_get_background_task_output` /
`workbench_list_directory` / `workbench_read_file_content` /
`workbench_write_file_content` 五条在 manifest 中 surface=gui，但为 F1/F4
既定数据源。**M6 决策：列入白名单特批**（只读 + writeFile 受控），实现上
建议后续把五条迁移为 surface=engine（命令面登记变更，需双端 manifest 同步）；
迁移前由 Device Registry 的 `allowedCommands` 显式放行（特批常量表）。

---

## 5. 事件消息清单（41 变体映射与裁剪）

### 5.0 双面模型：实时面 vs 同步面

同一事件在两条下行路径上形态不同，必须分开登记：

| 面 | 载体 | 用途 | 可靠性 | 裁剪强度 |
|---|---|---|---|---|
| **实时面** | `events.push`（WS 在线推流） | F1/F3/F5 的实时观察（流式正文、终端输出、状态变化） | Delta 可丢 / Soft 尽力 / Critical 必达（背压分级） | 中等（移动端不落盘，但仍不出网敏感全量） |
| **同步面** | `events.resume.page` / `cmd.readSessionEvents` | 断线续传、历史回放、D6 通道 B 增量 | 只含已落库事件（Critical + Soft） | 严格（D6 白名单 + 摘要化） |

规则：

1. **实时面推送白名单**：F1 §2.5 矩阵的「实」类事件全部实时推（含 Delta）；
2. **同步面白名单**：D6 §7.3 的必须 + 可选清单（41 事件中 20 个参与同步，
   21 个不同步：message-delta / message-start / subagent-event / task-output /
   task-heartbeat / task-suspicious / timer-fired / timer-cancelled / cron-fired /
   provider-diagnostic / runtime-error / runtime-steering /
   runtime-intervention-required / cache-stats-updated / cache-waste-alert /
   cold-cache-warning / tool-batch-start / tool-batch-end / tool-input-repaired /
   checkpoint-created / checkpoint-restored）；
3. **裁剪强度**：同步面执行 §5.2 全规则；实时面对 message-delta / tool-update /
   task-output 的**增量片段**放行（本身是增量文本），但终态事件（message-end /
   tool-end）与审批、审计执行全规则。

### 5.1 41 变体映射总表

列定义：

- **策略**（跨端）：`T`=透明透传 / `R`=摘要化 / `U`=元组下发（fail-closed）；
- **实时面**：推/不推（`✓`/`–`）+ 可丢性（继承背压：D=Delta 可丢、S=Soft 尽力、C=Critical 必达）；
- **同步面**：`✓`=参与白名单 / `–`=不参与；
- **推送级别**（与 D7 §3 场景清单衔接）：p0=必达推送 / p1=重要推送 / p2=可选推送 / `–`=不推送；
- **消费功能**：F1/F2/F3 各域编号（F3 的 S/N/I 分类 + F1 矩阵动作）。

| # | type | 策略 | 实时面 | 同步面 | 推送级别 | 消费功能 |
|---|---|---|---|---|---|---|
| 1 | agent-start | T | ✓ C | ✓ | – | F3 S（run 分组头）、F1 F03 |
| 2 | agent-end | T | ✓ C | ✓ | p0（failed 时） | F3 S（收尾）、F1 F12 错误横幅 |
| 3 | turn-start | T | ✓ C | ✓ | – | F3 S（轮次分隔线）、F1 F04 |
| 4 | turn-end | T | ✓ C | ✓ | – | F3 S（轮次小结） |
| 5 | message-start | U | ✓ C | – | – | F1/F3 已判 I 类（message-end 收口）；仅元组 |
| 6 | message-delta | R | ✓ D（可丢） | – | – | F3 S（流式正文，实时面增量放行） |
| 7 | message-end | R | ✓ C | ✓ | – | F3 S（终态权威）、F5 消息流 |
| 8 | tool-start | R | ✓ C | ✓ | – | F3 S（工具卡创建） |
| 9 | tool-update | R | ✓ C（实时面增量放行） | ✓（裁剪后） | – | F3 S（终端流式输出） |
| 10 | tool-end | R | ✓ C | ✓ | p2（isError 时） | F3 S（卡片收口） |
| 11 | tool-batch-start | U | ✓ C | – | – | F3 已判 I 类；元组（桌面显式 ignore） |
| 12 | tool-batch-end | U | ✓ C | – | – | 同上 |
| 13 | tool-input-repaired | U | ✓ C | – | – | F3 已判 I 类；元组 |
| 14 | context-compression-start | T | ✓ C | ✓ | – | F3 S（进度条目）、F1 F04 |
| 15 | context-compression-end | T | ✓ C | ✓ | – | F3 S（收口） |
| 16 | provider-diagnostic | U | ✓ C | – | – | F3 已判 I 类；元组（仅 error 级日志可加白名单） |
| 17 | runtime-error | R | ✓ C | – | p0 | F3 N（错误条目 + 通知）、F1 F12 |
| 18 | runtime-steering | U | ✓ C | – | – | F3 已判 I 类；元组 |
| 19 | runtime-intervention-required | R | ✓ C | – | p0 | F3 N（干预横幅） |
| 20 | approval-requested | R | ✓ C | ✓ | **p0（必达）** | F2 待办 +1、F3 S+N、F1 F10 |
| 21 | approval-resolved | R | ✓ C | ✓ | – | F2 待办 −1/收敛、F3 S |
| 22 | checkpoint-created | U | ✓ C | – | – | F3 已判 I 类；元组 |
| 23 | checkpoint-restored | U | ✓ C | – | – | 同上 |
| 24 | run-terminal | T | ✓ C | ✓ | **p0（failed）** / p1（completed） | F1 F03/F07、F3 收口、F2 待办失效 |
| 25 | cache-stats-updated | R | ✓ C | – | – | F1 F08 缓存卡、F3 徽标 |
| 26 | cache-waste-alert | R | ✓ C | – | p2 | F1 F08 浪费预警 |
| 27 | cold-cache-warning | R | ✓ C | – | p2 | F1 F08 冷缓存提示 |
| 28 | security-audit | R | ✓ C | ✓ | p0（blocked 时） | F3 S+N 审计卡、F1 F15 |
| 29 | subagent-started | T | ✓ C | ✓ | – | F3 S（子容器创建）、F1 F13 |
| 30 | subagent-event | R | ✓ D/S（按 kind） | – | – | F3 S（折叠子条目） |
| 31 | subagent-ended | T | ✓ C | ✓ | p0（failed） | F3 S+N、F1 F13 |
| 32 | task-started | T | ✓ C | ✓ | – | F3 S（任务卡）、F1 F09 |
| 33 | task-output | R | ✓ D（可丢） | – | – | F3 S（输出流，实时面增量放行） |
| 34 | task-heartbeat | U | ✓ D | – | – | F3 已判 I 类；元组（不渲染） |
| 35 | task-suspicious | T | ✓ S | – | p1 | F1 F09 疑似卡死 |
| 36 | task-completed | T | ✓ C | ✓ | p1 | F1 F09、F3 S |
| 37 | task-failed | R | ✓ C | ✓ | **p0** | F1 F09 失败 + tail 摘要、F3 S |
| 38 | task-killed | T | ✓ C | ✓ | p1 | F1 F09、F3 S |
| 39 | timer-fired | R | ✓ C | – | p1 | F1 F14、F3 N |
| 40 | timer-cancelled | U | ✓ S | – | – | F3 已判 I 类；元组 |
| 41 | cron-fired | R | ✓ C | – | p1 | F1 F14、F3 N |

> **统计**：透明透传 T = 13（1,2,3,4,14,15,24,29,31,32,35,36,38）；
> 摘要化 R = 18（6,7,8,9,10,17,19,20,21,25,26,27,28,30,33,37,39,41）；
> 元组下发 U = 10（5,11,12,13,16,18,22,23,34,40；未来未登记变体走同规则兜底）；
> 同步面参与 = 20（1,2,3,4,7,8,9,10,14,15,20,21,24,28,29,31,32,36,37,38）；
> 推送场景 = D7 的 13 个（p0 6 + p1 4 + p2 3，逐事件标注如上表）。

### 5.2 字段级裁剪规则（RedactSpec 草案）

> 实现形态：桌面出网处（Device Relay 事件扇出 + 同步面查询管线）执行
> 「type → RedactSpec」规则表（D6 §7.4）；规则表与事件注册表同源演进，
> **新增事件类型必须登记裁剪规则，否则默认「全删」（fail-closed 元组）**。

#### 5.2.1 敏感字段盘点（裁剪对象）

| 事件 | 字段 | 敏感度 | 裁剪规则（R=摘要化动作） |
|---|---|---|---|
| message-start / message-end | `message.blocks[].text` | 🔴 | 正文首 200 字符 + `truncated=true`（完整档 2000） |
| message-start / message-end | `message.blocks[].thought.text` | 🔴 | 只传 `hasThinking: bool`；thought 全文永不出网（隐私红线，D6 §7.5） |
| message-start / message-end | `message.blocks[].tool-call.input` | 🔴 | 工具参数首 200 字符摘要 + 键名列表 |
| message-start / message-end | `message.blocks[].tool-result.output` | 🔴 | 只传 `isError` + 输出首 200 字符 |
| approval-requested | `request.parameters` | 🔴 | 全量删除，保留参数**键名列表**（keys[]）+ summary（决策不依赖参数全量，D6 §7.4） |
| approval-requested | `request.cwd` / `toolName` / `summary` / `toolCallId` / `requesterRunId` / `reason` | 🟡 | 保留（详情页展示必需） |
| security-audit | `targets` | 🟡 | 每路径截 120 字符、条目 ≤ 20；`impact` 保留（计数型） |
| task-failed | `tail` | 🔴 | 只传前 5 行 + 总行数（**M6 决策：tail 全量永不同步**；完整输出经 C07 按需拉取） |
| tool-start / tool-end | `call.input` / `result.output` | 🔴 | 参数/输出首 200 字符摘要 + `isError` + 耗时 |
| tool-update | `update.text` / `update.json` | 🟡 | 实时面增量放行；同步面裁剪为「行数 + 末段 200 字符」 |
| runtime-error | `error` | 🟡 | 保留（错误文案，≤512 字符截断） |
| runtime-intervention-required | `choices[]` / `message` / `reason` | 🟡 | 保留（候选动作展示必需） |
| timer-fired / cron-fired | `prompt` | 🟡 | 保留（通知正文）；超 200 字符截断 |
| provider-diagnostic | `diagnostic` | 🟡 | 元组（不展示） |
| message-delta | `block.text` / `block.thought` | 🔴 | 实时面：text 增量放行、thought 增量**丢弃**（只更新 hasThinking）；同步面：不参与 |
| task-output | `line` / `chunk` | 🟡 | 实时面放行；同步面：不参与（C07 补取） |
| subagent-event | `event.payload` | 🟡 | 实时面按 kind 放行（message/tool 摘要 200 字符）；同步面：不参与 |

#### 5.2.2 摘要参数（随同步配置三档，D6 §7.5）

| 参数 | 轻量档 | 标准档（默认） | 完整档 |
|---|---|---|---|
| 消息正文摘要长度 | 无（不传正文摘要） | 200 字符 | 2000 字符 |
| 工具参数/输出摘要长度 | 无 | 200 字符 | 500 字符 |
| thinking | 永不 | `hasThinking` 布尔 | `hasThinking` 布尔 |
| 审计路径截断 | 100 字符/条，≤10 条 | 120 字符/条，≤20 条 | 全量路径 |
| task tail | 不传 | 前 5 行 | 前 5 行（红线固定） |
| 档位载体 | `events.subscribe` 的 `granularity` 参数 / bootstrap 的 `config.granularity` | 同左 | 同左 |

#### 5.2.3 fail-closed 元组格式

未登记裁剪规则的事件（含未来新增变体）在同步面只下发：

```jsonc
{ "type": "unknown-event-42", "sequence": 140, "schemaVersion": 1,
  "sessionId": "s-abc", "redacted": true }
```

- `redacted: true` 标记明确告知移动端「本事件正文已按策略抑制」；
- 移动端渲染为「未知/已抑制事件」摘要卡（不崩溃、不猜测，D6 §9.2 保真原则）；
- 实时面同规则（出网处统一裁剪，实时面元组同样只发信封 + redacted 标记）。

### 5.3 事件推送级别（与 D7 §3 衔接）

D7 场景清单 13 个（p0 6 / p1 4 / p2 3）在本协议中的落地：

| D7 场景 | 触发事件 | 跨端推送消息 | 推送 payload（≤4 KiB） |
|---|---|---|---|
| P0-1 审批请求 | approval-requested | push（D7 组合消息） | 标题「需要你确认：{toolName}」+ 正文摘要 ≤2 行 + 深链 `conex://approval?toolCallId=...` + dangerLevel + expiresAt |
| P0-2 审批过期 | （本地倒计时 / 对账） | 应用内状态页 | 无推送（F2 §8.3：引擎不广播 expired，移动端本地置灰） |
| P0-3 run 失败 | run-terminal(failed) + agent-end(error) | push | 标题「运行失败」+ error 摘要 + 深链 run 详情 |
| P0-4 子代理失败 | subagent-ended(failed) | push | 标题「子任务失败」+ summary + 深链 |
| P0-5 任务失败 | task-failed | push | 标题「任务异常退出（exit N）」+ tail 前 3 行摘要 |
| P0-6 安全拦截 | security-audit(blocked) | push | 标题「安全拦截」+ operation + targets 前 2 条 |
| P1-1 run 完成 | run-terminal(completed) | push（低优先级） | 「任务完成」+ 时长摘要 |
| P1-2 子代理完成 | subagent-ended(completed) | push（低优先级） | 摘要 |
| P1-3 任务完成 | task-completed | push（低优先级） | 摘要 |
| P1-4 定时器/cron 到期 | timer-fired / cron-fired | push（低优先级） | prompt 摘要 |
| P2-1 任务疑似卡死 | task-suspicious | push（可折） | 「任务疑似卡死（N 秒无输出）」 |
| P2-2 缓存浪费告警 | cache-waste-alert | push（可折） | 归因 + 金额 |
| P2-3 冷缓存提示 | cold-cache-warning | push（可折） | 重发预估 token |

**推送红线**（D7 §7.2 / F2 §6.2）：通知正文只含「工具名 + 会话标题」级摘要；
敏感参数/输出绝不进推送负载（系统推送通道不可控）；`expiresAt` 已过期的
推送到达后应用内展示「已过期」状态页而非决策入口。

---

## 6. 响应与错误体系

### 6.1 统一响应信封（success / error / partial）

所有命令的响应统一为 `result.<name>`，body 为三态信封（§10.6 `CommandResult`）：

```jsonc
// 成功
{ "reqMsgId": "m-iph-001-12", "ok": true, "result": { ...命令返回 JSON... } }

// 失败
{ "reqMsgId": "m-iph-001-12", "ok": false,
  "error": { "code": "cmd.approval_mismatch", "message": "该请求已被其他设备处理或已过期",
             "retryable": false, "detail": { "existingDecision": "approved" } } }

// 部分成功（仅批量类命令使用；本协议 v1 仅「批量审批」场景）
{ "reqMsgId": "m-iph-001-12", "ok": true, "partial": true,
  "result": { "accepted": 2, "failed": [
      { "toolCallId": "tc-3", "error": { "code": "cmd.approval_mismatch", "retryable": false } },
      { "toolCallId": "tc-5", "error": { "code": "cmd.timeout", "retryable": true } } ] } }
```

语义约定：

| 形态 | ok | 触发条件 | 移动端处理 |
|---|---|---|---|
| success | true | 命令完整执行成功 | 正常应用 result |
| error | false | 命令整体失败 | 按错误码表分派（§6.2）；`retryable=true` 且请求幂等 → 自动退避重发；否则转人工 |
| partial | true | 批量命令部分成功部分失败 | 逐条收敛：成功项正常处理，失败项按单项 error 分派（F2 §5.4 批量策略） |

**部分失败的通用语义**（跨命令）：

1. **分页/流中断**：游标型查询的响应若被流中断（见 §7），移动端以「已取到的
   `nextAfterSequence` + hasMore=true」继续拉取，不视为失败（游标语义天然续传）；
2. **流中断（stream.close error）**：`retryable=true` 的流可按
   `lastChunkSeq + 1`（或字节 offset）续传（§7.3）；
3. **批量审批**：部分成功不重试成功项；失败项按 `cmd.approval_mismatch`
   （收敛）与 `cmd.timeout`（重试）分派（F2 §5.4）。

### 6.2 错误码全表（协议级 + 业务级）

错误码为字符串枚举 `<域>.<子类>`；`retryable=true` 才允许自动重试。
下表为**协议级**（D3 §6.2 的完整复述 + M6 补充项标记）：

#### 6.2.1 协议级错误码

| code | 含义 | retryable | 触发方 | 备注 |
|---|---|---|---|---|
| `pair.invalid_code` | 配对码格式非法 | 否 | 桌面 | D3 §4.1 标准化失败 |
| `pair.expired` | 码已过期（10min） | 否（重新生成） | 桌面 | `PAIR_CODE_TTL_MS` |
| `pair.used` | 码已被使用（一次性） | 否 | 桌面 | 并发配对第二个失败 |
| `pair.too_many_attempts` | 失败次数超限 / 限速 | 否（冷却 5min） | 桌面 | 单码 ≤5 次 + 限速 |
| `pair.challenge_mismatch` | pair.verify 签名不匹配 | 否 | 桌面 | |
| `pair.no_challenge` | 无对应挑战 | 否 | 桌面 | 乱序/重放 |
| `pair.registry_full` | 设备数超上限（8） | 否 | 桌面 | `PAIR_MAX_DEVICES` |
| `auth.bad_signature` | HMAC 校验失败 | 否 | 桌面 | |
| `auth.device_revoked` | 设备已撤销 | 否（重新配对） | 桌面 | |
| `auth.unknown_device` | deviceId 不在注册表 | 否（重新配对） | 桌面 | |
| `auth.unknown_desktop` | desktopId 不匹配 | 否（重新配对） | 桌面 | 桌面重装后 |
| `auth.expired` | refresh 令牌过期/已用 | 是（重新 refresh） | 桌面 | |
| `auth.stale` | ts 出窗 / nonce 重放 | 是（重发） | 桌面 | ±5min 窗口 |
| `auth.rotate_conflict` | 轮换 nonce 冲突 | 是（用新 nonce） | 移动端 | |
| `version_mismatch` | 协议版本交集为空 | 否（升级） | 桌面 | D3 §10.2 |
| `frame_too_large` | 帧超 1 MiB | 否 | 双方 | 断链防内存放大 |
| `transport.closed` | 连接被对方关闭 | 是 | 双方 | 重连兜底 |

#### 6.2.2 命令级错误码（业务级）

| code | 含义 | retryable | 触发场景 | 移动端 UI 处理 |
|---|---|---|---|---|
| `cmd.invalid` | 参数非法（CoreError::InvalidInput） | 否 | 全部命令 | 修复参数 / 更新应用（F2 §12.3） |
| `cmd.not_found` | 目标不存在（run/session/任务/设备/审批） | 否 | C02/C04/C05/C13/C14/C18/C20/C22/C23/C25/C26/C30/C34/C35/C37 | 触发对账/失效清理（D6 §4.9.5 404 语义） |
| `cmd.unknown` | 命令未注册/不在 manifest | 否 | C09 校验 / C15 / C27 | 提示更新应用 |
| `cmd.engine_not_ready` | 引擎未就绪 | 是 | C01/C10/C24 | 指数退避重试（1/5/15/30s） |
| `cmd.restore_in_progress` | 恢复中拒绝 run | 是 | C24 | 等待恢复完成重试 |
| `cmd.session_busy` | 会话串行守卫命中 | 是 | C24 | 提示「桌面正在处理该会话」 |
| `cmd.approval_mismatch` | tool_call_id 不在待审批集合（I-02） | 否 | C11/C12 | **冲突收敛信号**：展示「已在其他设备处理/已过期」（F2 §11.2） |
| `cmd.denied` | 命令被安全策略拒绝（白名单/门禁） | 否 | 全部命令（越权） | 展示「无权限执行」 |
| `cmd.requires_approval` | 命令需先审批（gatekeeper） | 否 | C15 前置判定 | 引导进入审批中心 |
| `cmd.timeout` | 移动端本地超时（30s/60s） | 是 | 全部命令 | 幂等重发（msgId 不变） |
| `cmd.cancelled` | 请求被取消 | 否 | 全部命令 | 静默/用户提示 |
| `cmd.too_many_requests` | 命令限流（如 sendInput 节流） | 是（退避） | 高频命令 | 退避重试 |
| `stream.not_subscribed` | 未订阅会话即请求续传 | 否 | events.resume | 先 subscribe |
| `stream.cursor_invalid` | 游标非法（负值/超限） | 否 | events.resume / C03 | 修复游标 |
| `stream.cursor_stale` | 游标落后超窗口（4096） | 否（走全量回放） | events.resume | 全量 `core_read_session_events` 逐页回放（D3 §7.5） |
| `stream.too_many_subscriptions` | 订阅会话数超限（32） | 否 | events.subscribe | 裁剪订阅集合 |
| `stream.too_many_streams` | 并发流超限（8） | 是（等流关闭） | stream.open | 排队等待 |
| `file.not_found` | 文件/目录不存在 | 否 | C16/C17/C22/C23 | 「文件或目录不存在（可能已被移动）」 |
| `file.not_granted` | 路径越出授权工作区 | 否 | C16-C23 | 「路径不在已授权工作区内」+ 引导桌面重新授权 |
| `file.too_large` | 读取/写入超 1MB 上限 | 否 | C17/C18 | 「文件过大，无法预览（上限 1MB）」 |
| `file.binary` | 二进制文件无法预览 | 否 | C17 | 「二进制文件，无法预览」 |
| `file.encoding` | 编码不受支持 | 否 | C17 | 「文件编码不受支持」 |
| `file.exists` | 文件已存在且 overwrite=false | 否 | C18 | 弹覆盖确认后带 overwrite=true 重发 |
| `approval.expired` | 审批已过期（映射自 NotFound） | 否 | C11/C12 | 「已过期，决策未生效」（F2 §8.3） |
| `approval.rejected` | 审批已被拒绝（映射自 NotFound） | 否 | C11/C12 | 「该请求已被其他设备处理」 |
| `settings.key_denied` | 设置键不在白名单 | 否 | C29 | 「该设置在手机端不可修改」 |
| `settings.confirm_timeout` | 桌面确认超时（60s） | 否 | C29 | 「桌面端未确认，变更未生效」（F6 §8.3） |
| `internal` | 未分类内部错误 | 是 | 全部命令 | 通用错误态 + 桌面日志留痕 |

#### 6.2.3 CoreError 映射（桌面 Command Adapter 侧）

| CoreError kind | 跨端码 | 说明 |
|---|---|---|
| InvalidInput | `cmd.invalid` / `file.not_granted` / `cmd.denied` | detail 含 `workspace_not_granted` → file.not_granted；`file_exists`/`binary_file`/`unsupported_encoding` → 对应 file.* 码 |
| NotFound | `cmd.not_found` / `file.not_found` / `cmd.approval_mismatch` | 审批域的 NotFound 语义升级为 approval_mismatch（携带冲突信号，F2 §11.2） |
| Cancelled | `cmd.cancelled` | |
| Encoding | `file.encoding` / `cmd.invalid` | |
| Io | `internal`（detail.kind = Io） | 不透传内部 77 码（D3 §6.3） |
| Internal | `internal` / `cmd.engine_not_ready` | |

### 6.3 部分失败的细化场景

| 场景 | 消息面 | 处理契约 |
|---|---|---|
| 分页拉取中断（网络） | C03/C04/C07/events.resume | 游标型幂等：记录已应用最大 sequence，重连后从 `afterSequence = 已应用` 续拉；**不重复应用**（(session_id, sequence) 去重键，D6 §4.6） |
| 流中断（stream.close error） | stream.* | 按 `stream.resume {streamId, offset}` 续传；块级幂等（seq 去重）；`retryable=false` 的流错误（如 file.too_large）丢弃流并展示错误 |
| 批量审批部分失败 | C11/C12 批量形态 | 成功项不回滚；失败项逐条分派；`cmd.approval_mismatch` 项收敛为既有决策（不重试），`cmd.timeout` 项入重试队列（F2 §5.4） |
| 多会话同步部分失败 | events.resume 多会话 | 逐会话游标独立推进：失败会话游标不动，成功会话继续；`events.subscribe.ok` 逐会话返回 `stale` 标志（D3 §7.3） |
| 推送不可达 | 通知面（D7） | 不阻塞引擎；移动端对账兜底（F2 §6.4：通知缺失不导致待办丢失） |

---

## 7. 流式协议细化

### 7.1 流模型总述

跨端需要流式的有三类：**事件推流**（events.push）、**终端/任务输出**
（task-output 实时帧）、**大响应/大请求分块**（文件内容、历史回放、上行 prompt）。
统一原则（D3 §9.1 细化）：

- 事件推流：一帧一事件（`events.push`），WebSocket 保序；无终帧概念
  （run 终态 = run-terminal 事件）；
- 大载荷分块：`stream.open → stream.chunk* → stream.close`，块 ≤ 64 KiB；
- 终端输出：task-output 实时帧（桌面转发器节流 60ms 合并），移动端不做聚合。

### 7.2 流消息格式（chunk / 心跳 / 结束标志 / 续传游标）

```jsonc
// stream.open（桌面 → 移动端，服务端发起下行流）
{ "streamId": "st-01HZ...", "kind": "file",          // event_replay | file | task_output | prompt(上行)
  "totalBytes": 102400,                              // 已知则填，未知省略
  "meta": { "sessionId": "s-abc", "path": "src/a.ts", "mime": "text/plain",
            "encoding": "utf8" } }

// stream.chunk（桌面 → 移动端）
{ "streamId": "st-01HZ...", "seq": 1, "data": "...", // UTF-8 文本块（≤ 65536 字符）
  "final": false, "nextOffset": 65536 }              // 字节偏移锚点（续传用）；final=true 时省略

// stream.resume（移动端 → 桌面，断线续传）
{ "streamId": "st-01HZ...", "offset": 65536 }        // 从字节 offset 重发；服务端按块边界对齐

// stream.close（桌面 → 移动端，终帧）
{ "streamId": "st-01HZ...", "ok": true,
  "error": null,                                     // ok=false 时为 ErrorBody
  "totalDelivered": 102400 }
```

**心跳与保活**（D3 §9.3 细化）：

| 消息 | 方向 | 周期 | 载荷 | 作用 |
|---|---|---|---|---|
| `heartbeat` | M→D | 30s | `{ts, deviceTimeMs}` | 设备活性（更新 device_registry.last_seen）+ 时钟偏移校准 |
| `heartbeat.ok` | D→M | 60s | `{ts, serverTime}` | 时钟校准回执 |
| WS ping/pong | 双向 | 客户端库兜底 | — | 传输层保活 |

断线判定：3 × 心跳间隔（90s）未收到对端消息 → 判定断线；移动端发起重连
（指数退避 1/5/15/30s，F1 §3.1 F01 口径）。

**结束标志与续传游标**：

- 流结束标志 = `stream.close`（`final` 语义的流级收口；chunk 的 `final` 是
  块级终帧标记，二者分层）；
- 续传游标 = `nextOffset`（字节）/ `seq`（块号）双锚：断线重连后
  `stream.resume {streamId, offset = 已收到的 nextOffset}`，服务端从该字节
  重发（块级幂等：移动端以 `seq` 去重，重复块直接丢弃）；
- 服务端流缓存：断线 5 分钟内流上下文保留（重连续传），超时清理 →
  `stream.close {ok:false, error: stream.cursor_stale}`。

### 7.3 背压分级 → 客户端处理策略（与 D7 衔接）

背压分级源：`event_backpressure()`（events.rs:867-893）。跨端链路**不做第二套
分级**（D3 §7.2），但客户端处理策略必须固化：

| 级别 | 事件集合 | 桌面侧行为 | 移动端处理策略（接收面） |
|---|---|---|---|
| **Delta**（可丢） | message-delta、task-output、task-heartbeat、subagent-event(progress) | 下行窗口满时**丢弃**（对齐 buffer.rs 丢帧语义，EmitReport.dropped） | 收到即渲染（流式增量），**不落库、不记游标**；丢失无害——由终态兜底：message-end 全文重建正文、C07 补取任务输出、tool-end 终值覆盖 |
| **Soft**（尽力） | subagent-event(message/tool)、task-suspicious、timer-cancelled | 尽力投递；窗口溢出时先丢 Delta 再丢 Soft | 尽力渲染；断线窗口内（4096）由 resume 补发；补不到则降级展示（如「子任务消息不可用」） |
| **Critical**（必达） | 其余全部（终态/审批/审计/任务终态/timer-fired/cron-fired） | 窗口只进不出时**暂停推流**，反压引擎 emit 链 | 游标续传覆盖（resume 必达）；push 帧按 `(sessionId, sequence)` 记账，断线后以游标补齐；**推送通知触发**（D7：p0/p1 场景） |

**移动端下行窗口与本地缓冲**（对齐 buffer.rs 水位思想）：

| 缓冲 | 上限 | 溢出策略 |
|---|---|---|
| 内存暂存区（reconnecting 期） | 500 条 | 先丢 Delta，再丢 Soft（继承分级） |
| feed 渲染环形 | 500 条 | 淘汰最早条目 + 顶部「已收起 N 条」标记（F3 §3.4.2） |
| 终端行缓冲 | 200 行 | 淘汰最早行 + 「已截断 N 行」（F3 §4.0） |
| 文本批合并窗口 | 48ms / 8000 字符 | 覆盖式合并（StreamTextBatcher 语义，F3 §3.4.1） |

**客户端拥塞控制**：移动端处理慢时，Delta 帧由桌面直接丢弃（不需要移动端
ack）；Critical 帧不丢——桌面侧窗口反压是唯一节流阀（D3 §9.4），移动端
**不发送**背压信号（协议保持简单，客户端唯一动作是「读快点」）。

### 7.4 上行大载荷流（cmd.runTask.prompt 超限场景）

上行大载荷（prompt > 256 KiB）走「分块提交」专用流：

```
移动端                                   桌面
  │  cmd.runTask { promptRef: "up-01HZ", promptSize: 500000 }   // 先登记元数据
  │ ────────────────────────────────────────>
  │  stream.open { streamId: "up-01HZ", kind: "prompt", totalBytes: 500000 }
  │ <────────────────────────────────────────
  │  stream.chunk { streamId: "up-01HZ", seq: 1, data: "..." } × N（M→D）
  │ ────────────────────────────────────────>
  │  stream.close { streamId: "up-01HZ", ok: true }（M→D，发送方收口）
  │ ────────────────────────────────────────>
  │  result.runTask { runId, sessionId }
  │ <────────────────────────────────────────
```

- 上行流超时：60s 无新块 → 桌面关闭流（`stream.cursor_stale`），移动端重开；
- 上行流与下行流共用 `stream.*` kind（方向由 `from/to` 区分）；`stream.open`
  在上行场景由**桌面**发起（先登记后开流，避免未授权上传）；
- 断线续传同上行语义（`stream.resume` 双向可用）。

---

## 8. 消息大小与裁剪

### 8.1 每消息类型最大尺寸预算

| 消息 | 方向 | 最大尺寸 | 超限处理 |
|---|---|---|---|
| DeviceEnvelope 帧（全部消息） | 双向 | **1 MiB**（MAX_FRAME_BYTES） | 接收端 `frame_too_large` + 断链（防内存放大） |
| events.push（单事件帧） | D→M | **64 KiB** | 先摘要化（§5.2）；仍超 → 降级元组 + 移动端走 C03 拉取 |
| cmd.* 请求（默认） | M→D | **64 KiB** | 超限 → cmd.invalid 或走流上传（7.4） |
| cmd.runTask.prompt | M→D | **256 KiB** | 超限 → 流上传（7.4） |
| result.* 响应（默认） | D→M | **1 MiB** | 大响应（readFile 全文等）→ stream 分块 |
| stream.chunk | D→M | **64 KiB**（STREAM_CHUNK_MAX） | 固定块大小，无超限概念 |
| 推送通知 payload | 通知面 | **4 KiB**（FCM 上限） | 摘要化 + 截断（D7 §6） |
| heartbeat | 双向 | 1 KiB | 无 |
| 单流总量 | D→M | **256 MiB** | stream.open 拒绝 + stream.too_many_streams |
| 并发流 | 双向 | **8**（MAX_STREAMS） | 排队等待 |
| 批量响应条目 | D→M | 200 条/批 | 分页续拉 |

### 8.2 裁剪策略：摘要 vs 全文（分三层）

| 层 | 内容 | 默认策略 | 完整档 | 补充机制 |
|---|---|---|---|---|
| L1 列表/索引 | 会话列表、任务列表、run 摘要 | 摘要（≤80 字符预览） | 同 | 详情按需拉取 |
| L2 事件流 | message/tool/审计事件正文 | 摘要（正文 200 字符、工具输出 200、审计路径 120×20） | 正文 2000、工具 500、审计路径全量 | `truncated=true` 标记 + 按需补拉（P2） |
| L3 文件内容 | readFile 全文 | 400 行/次分块 | 5000 行硬顶 | maxLines 阶梯续读（F4 §4.1） |
| L4 文件传输 | 图片/PDF | 缩略图 ≤128px；PDF 仅元数据 | 原图按需 | assetUrl 令牌 URL（F4 §5.4） |

**摘要 vs 全文的判定规则**（服务端出网处执行）：

1. 文本内容 > 摘要阈值 → 摘要 + `truncated=true`，移动端展示「查看全文」占位
   （P2 按需补拉接口预留）；
2. 二进制/编码不支持 → 元数据 + 错误提示（不传内容）；
3. 敏感文件 → 内容标记 `sensitive=true` 且**不缓存**（F4 §7.1）；
4. thinking 全文 → **永不出网**（任何档位，D6 §7.5 红线）；
5. task tail → 前 5 行（红线固定，完整输出经 C07 按需取）。

### 8.3 分页协议（游标 + limit + 方向）

统一分页形状（C03/C04/C07/C14/events.resume 共用）：

| 元素 | 约定 | 说明 |
|---|---|---|
| 游标 | `afterSequence`（开区间）/ `afterLine`（行号）/ `afterSequence`（历史） | 语义与 conex-db `query_events` 开区间一致（D6 §2.2） |
| limit | `maxEvents` 默认 200、上限 1000；`maxLines` 默认 200、上限 1000 | 服务端强制钳制 |
| 方向 | `forward`（默认）/ `backward`（4.1.3.1） | backward 仅 UI 历史浏览 |
| 响应续拉标志 | `nextAfterSequence` + `hasMore` | `hasMore=true` 时同参续拉 |
| 聚合 | 多会话增量（`sessions=s1,s2&after={...}`） | 单请求多会话（D6 §10.3），v1 可选实现 |
| 空洞容忍 | 开区间游标 | delta 占号不落库的 gap 天然容忍（D6 §2.3） |

**移动端游标推进规则**（D6 §4.6 复述，协议锚点）：

1. 先应用后推进：事件写本地库成功（事务提交）后才更新 `last_applied_sequence`；
2. 幂等应用：(session_id, sequence) 为去重键，重复投递跳过；
3. 空洞容忍：收到 100、102 缺 101 → 游标直接到 102，不补拉；
4. 回退禁止：游标只升不降（与 seed_sequence MAX 语义同构）；
5. 重建语义：快照重建时游标 = 快照 max_sequence。

---

## 9. 离线与重连语义

### 9.1 消息投递语义总表

| 消息类别 | 投递语义 | 可靠性机制 |
|---|---|---|
| 读命令（C01-C10/C13-C17/C19-C23/C27/C28/C32/C33/C36） | 请求-响应（幂等查询） | 无特殊机制；重发天然安全 |
| 写命令（C11/C12/C18/C29/C31） | **at-least-once（outbox）** | 本地持久化队列 + 幂等键 + 桌面去重 |
| 控制命令（C24/C25/C26） | 请求-响应（业务幂等） | clientMessageId / 控制面天然幂等 |
| events.push（Critical） | 至少一次（游标覆盖） | 断线续传（resume） |
| events.push（Delta） | **至多一次（可丢）** | 终态兜底，不补发 |
| events.push（Soft） | 尽力（窗口内补发） | resume 窗口 4096 |
| 推送通知（D7） | 尽力（厂商通道） | 对账兜底（通知缺失不导致待办丢失） |

### 9.2 outbox 投递语义（at-least-once + 幂等键）

**outbox 队列**（移动端本地持久化，F2 §8.2 / D6 §6.2 细化，统一形态）：

```jsonc
{
  "commandId": "m-iph-001-12",          // = 请求 msgId（幂等键）
  "kind": "cmd.approve",                // 写命令 kind
  "params": { "toolCallId": "tc-9" },   // 命令参数
  "businessKey": "tc-9",                // 业务幂等键（toolCallId / clientMessageId / key / ...）
  "queuedAt": 1754700000000,
  "ttlMs": 86400000,                    // 队列元素 TTL（审批 ≤ 120s 时效由 expiresAt 单独管）
  "state": "pending",                   // pending | sending | sent | permanent-failed | expired
  "lastError": null
}
```

**幂等键分层**：

| 命令 | 主幂等键 | 次幂等键 | 桌面去重实现 |
|---|---|---|---|
| cmd.approve / cmd.deny | `toolCallId`（业务级，I-02 天然） | `msgId`（请求级） | 待审批集合移除原子性 + reqMsgId 缓存（TTL 5min） |
| cmd.writeFile | `msgId` | （path+content 哈希可作审计） | sync_commands 表（command_id 主键，保留 30 天） |
| cmd.setSettings | `key` + `value` | `confirmRequestId` | 设置键幂等写 + 确认请求去重 |
| cmd.pauseAutomation | `msgId` | — | 幂等写（刷新 pausedUntil） |
| cmd.runTask | `clientMessageId` | `msgId` | 同 clientMessageId 返回同一 runId |

**桌面端去重存储**（D6 §9.6 决策：专用表）：

```sql
CREATE TABLE IF NOT EXISTS sync_commands (
    command_id   TEXT PRIMARY KEY,       -- msgId / clientMessageId
    kind         TEXT NOT NULL,
    business_key TEXT,
    result_json  TEXT NOT NULL,          -- 首次处理结果（回显用）
    created_at   TEXT NOT NULL
);
-- 保留策略：30 天（防重放窗口 > 离线 TTL 上限，D6 §10 O6）
```

**at-least-once 流程**：

1. 移动端写命令先入 outbox（本地事务提交）→ 置 sending → 发送；
2. 收到 `result.*`（ok 或业务错误）→ 回显结果、按结果分派（成功清除 /
   permanent-failed 展示原因 / 业务拒绝转对账）；
3. 网络失败/超时 → 回 pending，指数退避重试（1s/4s/16s/60s 封顶，
   前台 + 网络恢复事件驱动，D6 §6.3）；
4. 重发**保持 msgId 不变** → 桌面按幂等键回显首次结果，不重复执行；
5. 队列上限 200 条，FIFO 剔除已完成；未完成元素永不剔除（数据安全 > 空间）；
6. 审批命令的 TTL 特殊：`expiresAt` 到期后仍可发送（桌面以权威状态裁决，
   F2 §6.4 偏差容忍），但 UI 置灰「可能已过期」。

### 9.3 重连后的对账（本地状态 vs 服务端游标）

对账流程（重连/上线的统一入口，D6 §6.5 协议化）：

```
重连成功（auth.refresh → events.subscribe）
   ├─ ① 订阅对账：subscribe 携带 lastSequences →
   │     subscribe.ok 逐会话返回 {nextSequence, stale}
   │     · stale=false → events.resume 增量补齐（afterSequence 分页）
   │     · stale=true  → 全量回放（C03 逐页）或快照重建（bootstrap，P2）
   ├─ ② 投影对账：bootstrap 投影（会话索引/run 摘要/待办/审计）与本地 diff
   │     · 本地有、权威无 → 会话已删除 → 清理本地投影 + 游标 + 队列
   │     · 权威有、本地无 → 写入投影 + 初始化游标
   │     · 字段不同 → 以权威为准覆盖
   ├─ ③ 游标对账：逐会话 cursor vs max_sequence
   │     · 落后超重建阈值（5000 事件）→ 该会话快照重建
   ├─ ④ 队列对账：outbox 逐条提交（9.2 流程）
   └─ ⑤ 留痕：所有分歧（删除会话/命令被拒/重建）写本地日志，不静默
```

**对账幂等**：对账可重复执行，每次都是「以权威为准的收敛」，无副作用累积
（D6 §6.5）。

**订阅窗口与游标关系**（D3 §7.5 复述）：

- 移动端本地持久化 `(deviceId, sessionId, lastSequence)`；
- 桌面下行窗口 `EVENT_WINDOW = 4096`/会话：游标落后 ≤ 窗口 → resume 补发
  （Soft + Critical）；落后 > 窗口 → `stream.cursor_stale` 全量回放；
- resume 完成后 → `events.resume.done {sessionId, resumedTo}` → 桌面恢复实时推流；
- Delta 事件不在续传范围（断线后以 message-end / C07 重建增量态）。

---

## 10. JSON Schema 完整定义

约定：draft 2020-12；全部字段 camelCase；`$defs` 复用；UTF-8 无 BOM；
`additionalProperties` 默认 false（协议内消息），事件体容器为 true（宽容未知事件字段）；
所有 schema 将登记入 `crates/conex-types/contracts/device-protocol.json`（§12.2）。

### 10.1 DeviceEnvelope（L3 外层信封，全部消息统一包装）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.envelope.v1",
  "title": "DeviceEnvelope",
  "description": "跨端协议外层信封（D3 §5.3 完整版；v=1 由握手协商固定）",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "kind", "msgId", "ts", "from", "to", "auth", "body"],
  "properties": {
    "v": { "type": "integer", "const": 1, "description": "协议主版本（hello 协商后固定）" },
    "kind": {
      "type": "string",
      "pattern": "^(pair|auth|device|events|session|cmd|result|stream|heartbeat|error)\\.[a-z][a-zA-Z0-9]*$|^heartbeat$",
      "description": "消息类别（§3.1 分发表）"
    },
    "msgId": { "type": "string", "minLength": 8, "maxLength": 64,
      "description": "发送方唯一消息 id（幂等键 + 请求-响应关联键）" },
    "ts": { "type": "integer", "minimum": 0, "description": "发送方时钟 epoch ms" },
    "from": { "enum": ["desktop", "mobile"] },
    "to": { "enum": ["desktop", "mobile"] },
    "auth": { "$ref": "#/$defs/AuthHeader" },
    "body": { "type": "object", "description": "业务载荷；kind 决定结构（见各节）" }
  },
  "$defs": {
    "AuthHeader": {
      "type": "object",
      "additionalProperties": false,
      "required": ["deviceId", "ts", "nonce", "sig"],
      "properties": {
        "deviceId": { "type": "string", "minLength": 8, "maxLength": 64 },
        "ts": { "type": "integer", "minimum": 0, "description": "签名时戳（窗口 ±5min）" },
        "nonce": { "type": "string", "minLength": 16, "maxLength": 64, "description": "随机字节 base64，防重放" },
        "sig": { "type": "string", "pattern": "^[A-Za-z0-9+/=]{44}$",
          "description": "HMAC-SHA256(token_key, canon(from,to,msgId,kind,v,ts,nonce) ∥ bodyJson) base64" }
      }
    },
    "ErrorBody": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable"],
      "properties": {
        "code": { "type": "string", "description": "跨端错误码（§6.2）" },
        "message": { "type": "string", "maxLength": 512 },
        "retryable": { "type": "boolean" },
        "reqMsgId": { "type": "string", "description": "被拒绝请求的 msgId（响应类错误）" },
        "detail": { "type": "object", "additionalProperties": true }
      }
    }
  }
}
```

### 10.2 错误消息（kind = error）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.error.v1",
  "title": "DeviceError",
  "allOf": [{ "$ref": "conex.device.envelope.v1" }],
  "description": "kind = error 的信封：body 为 ErrorBody；推送路径错误（无 reqMsgId）记日志 + 断链兜底",
  "properties": {
    "kind": { "const": "error" },
    "body": { "$ref": "conex.device.envelope.v1/$defs/ErrorBody" }
  }
}
```

### 10.3 配对消息（pair.*，D3 §4 完整版）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.pair.v1",
  "title": "PairingMessages",
  "description": "配对状态机全部消息体（D3 §4.8 时序）",
  "$defs": {
    "PairCode": {
      "type": "string",
      "pattern": "^(CXN-)?[A-HJ-KM-NP-Z2-9]{4}(-[A-HJ-KM-NP-Z2-9]{4}){2}$",
      "description": "CXN-XXXX-XXXX-XXXX；传输时统一大写无空格（normalize_pair_code）"
    },
    "PairHello": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "deviceId", "mobilePub", "mobileLongPub", "deviceName"],
      "properties": {
        "code": { "$ref": "#/$defs/PairCode" },
        "deviceId": { "type": "string", "minLength": 8, "maxLength": 64 },
        "mobilePub": { "type": "string", "pattern": "^[A-Za-z0-9+/=]{44}$", "description": "X25519 一次性公钥 base64" },
        "mobileLongPub": { "type": "string", "pattern": "^[A-Za-z0-9+/=]{44}$", "description": "移动长期公钥 base64（设备身份）" },
        "deviceName": { "type": "string", "maxLength": 64 },
        "platform": { "enum": ["ios", "android", "other"] }
      }
    },
    "PairChallenge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["challenge", "desktopPub", "desktopId", "tlsFingerprint"],
      "properties": {
        "challenge": { "type": "string", "minLength": 43, "description": "32B 随机挑战 base64" },
        "desktopPub": { "type": "string", "pattern": "^[A-Za-z0-9+/=]{44}$" },
        "desktopId": { "type": "string", "minLength": 8, "maxLength": 64 },
        "tlsFingerprint": { "type": "string", "pattern": "^[A-Fa-f0-9]{64}$",
          "description": "桌面自签证书 SHA-256 指纹（证书固定）" }
      }
    },
    "PairVerify": {
      "type": "object",
      "additionalProperties": false,
      "required": ["challengeSig", "devicePubSig"],
      "properties": {
        "challengeSig": { "type": "string", "description": "HMAC-SHA256(token_key, \"pair-verify\" ∥ challenge) base64" },
        "devicePubSig": { "type": "string", "description": "用 Mpriv 对 (desktopId ∥ mobileLongPub) 的签名 base64" }
      }
    },
    "PairOk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["desktopId", "ttl"],
      "properties": {
        "desktopId": { "type": "string" },
        "ttl": { "type": "integer", "description": "会话令牌建议轮换周期（秒，默认 86400）" }
      }
    },
    "DeviceReady": {
      "type": "object",
      "additionalProperties": false,
      "required": ["deviceId"],
      "properties": { "deviceId": { "type": "string" } }
    },
    "DeviceUnlink": {
      "type": "object",
      "additionalProperties": false,
      "required": ["deviceId"],
      "properties": { "deviceId": { "type": "string" } }
    },
    "PairAudit": {
      "type": "object",
      "additionalProperties": false,
      "required": ["event", "ts"],
      "properties": {
        "event": { "type": "string", "enum": ["paired", "unlinked", "revoked", "failed"] },
        "ts": { "type": "integer" },
        "deviceId": { "type": "string" },
        "reason": { "type": "string" }
      }
    }
  }
}
```

### 10.4 认证与心跳（auth.* / heartbeat）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.auth.v1",
  "title": "AuthAndHeartbeat",
  "description": "握手 / 重连刷新 / 轮换 / 保活（D3 §5 完整版）",
  "$defs": {
    "Hello": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersions", "appVersion", "platform"],
      "properties": {
        "protocolVersions": { "type": "array", "items": { "type": "integer" }, "minItems": 1 },
        "capabilities": { "type": "array", "items": { "type": "string" },
          "description": "移动端能力位（fileRead/taskInput/runTask/...，§11.2）" },
        "appVersion": { "type": "string", "maxLength": 32 },
        "platform": { "enum": ["ios", "android", "other"] },
        "resume": { "$ref": "conex.device.events.v1/$defs/ResumeState",
          "description": "断线重连时携带的逐会话游标状态" }
      }
    },
    "HelloOk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "minProtocolVersion", "desktopId", "serverTime", "manifest"],
      "properties": {
        "protocolVersion": { "type": "integer" },
        "minProtocolVersion": { "type": "integer" },
        "desktopId": { "type": "string" },
        "serverTime": { "type": "integer", "description": "epoch ms（时钟校准）" },
        "capabilities": { "type": "object", "additionalProperties": { "type": "boolean" },
          "description": "桌面能力位（streams/fileRead/taskInput/cron/timer/subagent/...）" },
        "manifest": {
          "type": "object",
          "required": ["contractVersion", "commands"],
          "properties": {
            "contractVersion": { "type": "string" },
            "commands": { "type": "array", "items": { "$ref": "#/$defs/ManifestEntry" } }
          }
        }
      }
    },
    "ManifestEntry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "family", "surface", "registered"],
      "properties": {
        "name": { "type": "string" },
        "family": { "type": "string" },
        "surface": { "enum": ["engine", "gui"] },
        "registered": { "type": "boolean" }
      }
    },
    "Refresh": {
      "type": "object",
      "additionalProperties": false,
      "required": ["refreshToken"],
      "properties": {
        "refreshToken": { "type": "string",
          "description": "HMAC(refresh_key, desktopId ∥ ts ∥ nonce) base64，一次性" }
      }
    },
    "Rotate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nonceSeed"],
      "properties": { "nonceSeed": { "type": "string" } }
    },
    "Heartbeat": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ts", "deviceTimeMs"],
      "properties": {
        "ts": { "type": "integer" },
        "deviceTimeMs": { "type": "integer", "description": "移动端本地时钟（校准用）" }
      }
    },
    "HeartbeatOk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ts", "serverTime"],
      "properties": { "ts": { "type": "integer" }, "serverTime": { "type": "integer" } }
    }
  }
}
```

### 10.5 会话面消息（events.* + session.*）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.events.v1",
  "title": "EventProtocolMessages",
  "description": "订阅 / 推送 / 续传 / 回执 / 会话索引广播（M6 完整版）",
  "$defs": {
    "ResumeState": {
      "type": "object",
      "additionalProperties": false,
      "description": "会话 → 最后已确认持久化序列（断线续传游标）",
      "patternProperties": { "^[A-Za-z0-9_-]{1,64}$": { "type": "integer", "minimum": 0 } }
    },
    "Subscribe": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessions", "lastSequences"],
      "properties": {
        "sessions": { "type": "array", "items": { "type": "string" }, "maxItems": 32 },
        "lastSequences": { "$ref": "#/$defs/ResumeState" },
        "ackMode": { "enum": ["none", "critical"], "default": "none" },
        "granularity": { "enum": ["light", "standard", "full"], "default": "standard",
          "description": "摘要档位（§5.2.2，与 D6 §7.5 对齐）" }
      }
    },
    "SubscribeAll": {
      "type": "object",
      "additionalProperties": false,
      "required": ["events"],
      "properties": { "events": { "type": "array", "items": { "type": "string" },
        "description": "type 白名单（security-audit / device.* / timer-fired / cron-fired / session.*）" } }
    },
    "SubscribeOk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessions"],
      "properties": {
        "sessions": { "type": "array", "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["sessionId", "nextSequence", "stale"],
          "properties": {
            "sessionId": { "type": "string" },
            "nextSequence": { "type": "integer", "description": "会话当前最大已持久化序列+1" },
            "stale": { "type": "boolean", "description": "游标落后超窗口，需全量回放" }
          } } }
      }
    },
    "EventsPush": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId", "event"],
      "properties": {
        "sessionId": { "type": "string" },
        "preview": { "type": "boolean", "default": false,
          "description": "实时预览帧（sequence 未落库；移动端不推进游标）" },
        "event": {
          "type": "object",
          "additionalProperties": true,
          "description": "AgentEventEnvelope 扁平 JSON（裁剪后；type/runId/sequence/schemaVersion/sessionId + 事件字段）"
        }
      }
    },
    "EventAck": {
      "type": "object",
      "additionalProperties": false,
      "required": ["msgId"],
      "properties": { "msgId": { "type": "string" } }
    },
    "Resume": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId", "afterSequence"],
      "properties": {
        "sessionId": { "type": "string" },
        "afterSequence": { "type": "integer", "minimum": 0 },
        "maxEvents": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 }
      }
    },
    "ResumePage": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId", "events", "nextAfterSequence", "hasMore"],
      "properties": {
        "sessionId": { "type": "string" },
        "events": { "type": "array", "items": {
          "type": "object", "additionalProperties": true,
          "description": "扁平事件 JSON（裁剪后；sequence 以 DB 行为准回填）" } },
        "nextAfterSequence": { "type": "integer" },
        "hasMore": { "type": "boolean" }
      }
    },
    "ResumeDone": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId", "resumedTo"],
      "properties": {
        "sessionId": { "type": "string" },
        "resumedTo": { "type": "integer" }
      }
    },
    "SessionUpdated": {
      "type": "object",
      "additionalProperties": false,
      "required": ["session"],
      "properties": {
        "session": { "type": "object", "additionalProperties": false,
          "required": ["id", "updatedAt"],
          "properties": {
            "id": { "type": "string" },
            "title": { "type": "string" },
            "folder": { "type": "string" },
            "isPinned": { "type": "boolean" },
            "isArchived": { "type": "boolean" },
            "updatedAt": { "type": "integer" },
            "messageCount": { "type": "integer" },
            "engineCursor": { "type": "integer" },
            "engineLastRunId": { "type": "string" }
          } }
      }
    },
    "SessionRemoved": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId"],
      "properties": { "sessionId": { "type": "string" } }
    },
    "SessionUpdatedAll": {
      "type": "object",
      "additionalProperties": false,
      "required": ["version"],
      "properties": { "version": { "type": "integer", "description": "索引代数（对账兜底）" } }
    }
  }
}
```

### 10.6 命令消息（cmd.* / result.*）

#### 10.6.1 通用命令信封

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.commands.v1",
  "title": "CommandMessages",
  "description": "命令请求（body = CommandRequest 信封，params 见各命令 $defs）与统一响应",
  "$defs": {
    "CommandRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["command", "params"],
      "properties": {
        "command": { "type": "string",
          "description": "命令名（§4 的 kind 后缀，如 approve/getStatus/readFile）" },
        "params": { "type": "object", "additionalProperties": true,
          "description": "命令参数（§10.6.2 各命令 schema）" },
        "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 120000, "default": 30000 }
      }
    },
    "CommandResult": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reqMsgId", "ok"],
      "properties": {
        "reqMsgId": { "type": "string" },
        "ok": { "type": "boolean" },
        "partial": { "type": "boolean", "default": false, "description": "部分成功（批量命令）" },
        "result": { "type": "object", "additionalProperties": true,
          "description": "命令返回 JSON（§10.6.2 各命令响应 schema）" },
        "error": { "$ref": "conex.device.envelope.v1/$defs/ErrorBody" }
      }
    }
  }
}
```

#### 10.6.2 各命令参数 / 响应 schema（37 条全量）

> 说明：字段与既有 Tauri 命令入参/返回逐字节同构（camelCase）；仅列出跨端
> 裁剪后的子集。`required` 列出必填字段；其余可选。

```json
{
  "$id": "conex.device.commands.params.v1",
  "title": "CommandParamsAndResults",
  "description": "37 条命令的参数（...Params）与响应（...Result）schema；kind = cmd.<suffix>，result 为 CommandResult 包装",
  "$defs": {
    "StatusQuery": { "type": "object", "additionalProperties": false,
      "properties": { "include": { "type": "array", "items": { "enum": ["coreStatus", "activeRuns", "pendingApprovals", "bgTaskSummary"] } } } },
    "StatusResult": { "type": "object", "additionalProperties": false,
      "required": ["initialized", "engineReady"],
      "properties": {
        "initialized": { "type": "boolean" }, "version": { "type": "string" },
        "engineReady": { "type": "boolean" }, "dbReady": { "type": "boolean" },
        "searchIndexReady": { "type": "boolean" }, "compactionReady": { "type": "boolean" },
        "providerStatus": { "type": "object", "additionalProperties": true },
        "logLevel": { "type": "string" },
        "diagnostics": { "type": "array", "maxItems": 20, "items": { "type": "object", "additionalProperties": true } },
        "lastError": { "type": ["object", "null"], "additionalProperties": true },
        "restore": { "type": "object", "additionalProperties": true },
        "backgroundTasks": { "type": "object", "additionalProperties": true },
        "activeRuns": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
        "pendingApprovals": { "type": "array", "items": { "type": "object", "additionalProperties": true } }
      } },
    "RunSnapshotParams": { "type": "object", "additionalProperties": false,
      "required": ["runId"],
      "properties": { "runId": { "type": "string" }, "sessionId": { "type": "string" } } },
    "RunSnapshotResult": { "type": "object", "additionalProperties": false,
      "required": ["snapshot"],
      "properties": { "snapshot": { "type": "object", "additionalProperties": true,
        "description": "RunSnapshot 裁剪子集（status/cursor/usage 等）" } } },
    "EventPageParams": { "type": "object", "additionalProperties": false,
      "required": ["sessionId"],
      "properties": {
        "sessionId": { "type": "string" },
        "afterSequence": { "type": "integer", "minimum": 0, "default": 0 },
        "maxEvents": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 },
        "direction": { "enum": ["forward", "backward"], "default": "forward" }
      } },
    "RunEventsParams": { "type": "object", "additionalProperties": false,
      "required": ["runId"],
      "properties": {
        "runId": { "type": "string" }, "sessionId": { "type": "string" },
        "afterSequence": { "type": "integer", "minimum": 0 },
        "maxEvents": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 }
      } },
    "EventPageResult": { "type": "object", "additionalProperties": false,
      "required": ["events", "nextAfterSequence", "hasMore"],
      "properties": {
        "events": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
        "nextAfterSequence": { "type": "integer" },
        "hasMore": { "type": "boolean" },
        "latestSequence": { "type": "integer", "description": "服务端该会话当前 max（游标推进判断）" }
      } },
    "ListSessionsParams": { "type": "object", "additionalProperties": false,
      "properties": { "includeLastMessage": { "type": "boolean", "default": false } } },
    "ListSessionsResult": { "type": "object", "additionalProperties": false,
      "required": ["sessions"],
      "properties": { "sessions": { "type": "array", "maxItems": 1000, "items": { "type": "object", "additionalProperties": true } } } },
    "ListTasksParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "ListTasksResult": { "type": "object", "additionalProperties": false,
      "required": ["tasks"],
      "properties": { "tasks": { "type": "array", "items": { "type": "object", "additionalProperties": true } } } },
    "TaskOutputParams": { "type": "object", "additionalProperties": false,
      "required": ["taskId"],
      "properties": {
        "taskId": { "type": "string" },
        "maxLines": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 200 },
        "afterLine": { "type": "integer", "minimum": 0, "default": 0 }
      } },
    "TaskOutputResult": { "type": "object", "additionalProperties": false,
      "required": ["lines", "truncated", "lineCount"],
      "properties": {
        "lines": { "type": "array", "items": { "type": "string", "maxLength": 5000 } },
        "truncated": { "type": "boolean" },
        "lineCount": { "type": "integer" },
        "nextAfterLine": { "type": "integer" },
        "hasMore": { "type": "boolean" }
      } },
    "FlowSnapshotParams": { "type": "object", "additionalProperties": false,
      "required": ["sessionId"],
      "properties": { "sessionId": { "type": "string" } } },
    "FlowSnapshotResult": { "type": "object", "additionalProperties": false,
      "required": ["flow"],
      "properties": { "flow": { "type": "object", "additionalProperties": true } } },
    "ListCommandsParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "ListCommandsResult": { "type": "object", "additionalProperties": false,
      "required": ["contractVersion", "commands"],
      "properties": {
        "contractVersion": { "type": "string" },
        "commands": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["name", "family", "surface", "registered"],
          "properties": {
            "name": { "type": "string" }, "family": { "type": "string" },
            "surface": { "enum": ["engine", "gui"] }, "registered": { "type": "boolean" }
          } } }
      } },
    "SearchIndexParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "SearchIndexResult": { "type": "object", "additionalProperties": false,
      "required": ["ready"],
      "properties": { "ready": { "type": "boolean" }, "state": { "type": "object", "additionalProperties": true } } },

    "ApproveParams": { "type": "object", "additionalProperties": false,
      "required": ["toolCallId"],
      "properties": { "toolCallId": { "type": "string" }, "runId": { "type": "string" } } },
    "DenyParams": { "type": "object", "additionalProperties": false,
      "required": ["toolCallId"],
      "properties": {
        "toolCallId": { "type": "string" }, "runId": { "type": "string" },
        "reason": { "type": "string", "maxLength": 256 }
      } },
    "ApproveResult": { "type": "object", "additionalProperties": false,
      "required": ["ok", "toolCallId", "decision"],
      "properties": {
        "ok": { "type": "boolean" }, "toolCallId": { "type": "string" },
        "decision": { "enum": ["approved", "denied", "expired"] }
      } },
    "ListPendingApprovalsParams": { "type": "object", "additionalProperties": false,
      "properties": { "afterSequence": { "type": "integer", "minimum": 0 } } },
    "ListPendingApprovalsResult": { "type": "object", "additionalProperties": false,
      "required": ["approvals"],
      "properties": {
        "approvals": { "type": "array", "items": { "$ref": "#/$defs/PendingApproval" } },
        "latestSequence": { "type": "integer" }
      } },
    "PendingApproval": { "type": "object", "additionalProperties": false,
      "required": ["requestId", "toolCallId", "toolName", "arbiter", "requestedAt", "expiresAt", "dangerLevel"],
      "properties": {
        "requestId": { "type": "string" }, "toolCallId": { "type": "string" },
        "toolName": { "type": "string" }, "summary": { "type": "string" },
        "cwd": { "type": "string" }, "sessionId": { "type": "string" },
        "runId": { "type": "string" }, "requesterRunId": { "type": ["string", "null"] },
        "reason": { "type": ["string", "null"] },
        "arbiter": { "enum": ["user", "main-agent"] },
        "requestedAt": { "type": "integer" }, "expiresAt": { "type": "integer" },
        "dangerLevel": { "enum": [1, 2] },
        "paramKeys": { "type": "array", "items": { "type": "string" },
          "description": "参数键名列表（parameters 全量不下发）" }
      } },
    "ApprovalHistoryParams": { "type": "object", "additionalProperties": false,
      "properties": {
        "sessionId": { "type": "string" },
        "afterSequence": { "type": "integer", "minimum": 0 },
        "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }
      } },
    "ApprovalHistoryResult": { "type": "object", "additionalProperties": false,
      "required": ["items"],
      "properties": {
        "items": { "type": "array", "items": { "type": "object", "additionalProperties": false,
          "required": ["sequence", "toolCallId", "decision"],
          "properties": {
            "sequence": { "type": "integer" }, "toolCallId": { "type": "string" },
            "toolName": { "type": "string" }, "decision": { "enum": ["approved", "denied", "expired"] },
            "reason": { "type": "string" }, "channel": { "enum": ["desktop", "mobile", "auto"] },
            "resolvedAt": { "type": "integer" }, "sessionId": { "type": "string" },
            "runId": { "type": "string" }
          } } },
        "nextAfterSequence": { "type": "integer" }, "hasMore": { "type": "boolean" }
      } },
    "CheckCommandParams": { "type": "object", "additionalProperties": false,
      "required": ["command"],
      "properties": { "command": { "type": "string" }, "params": { "type": "object", "additionalProperties": true } } },
    "CheckCommandResult": { "type": "object", "additionalProperties": false,
      "required": ["decision"],
      "properties": {
        "decision": { "enum": ["allowed", "requires-approval", "blocked"] },
        "reason": { "type": "string" }
      } },

    "ListDirParams": { "type": "object", "additionalProperties": false,
      "properties": {
        "path": { "type": "string", "maxLength": 4096, "description": "相对路径或空串（工作区根）" },
        "workspaceRoot": { "type": ["string", "null"] }
      } },
    "ListDirResult": { "type": "object", "additionalProperties": false,
      "required": ["entries"],
      "properties": { "entries": { "type": "array", "items": { "type": "object", "additionalProperties": false,
        "required": ["name", "isDir"],
        "properties": {
          "name": { "type": "string" }, "isDir": { "type": "boolean" },
          "size": { "type": "integer", "minimum": 0 }, "modified": { "type": "string" }
        } } } } },
    "ReadFileParams": { "type": "object", "additionalProperties": false,
      "required": ["path"],
      "properties": {
        "path": { "type": "string", "maxLength": 4096 },
        "workspaceRoot": { "type": ["string", "null"] },
        "maxLines": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 400 },
        "startLine": { "type": "integer", "minimum": 0, "default": 0 }
      } },
    "ReadFileResult": { "type": "object", "additionalProperties": false,
      "required": ["content", "lineCount", "truncated"],
      "properties": {
        "content": { "type": "string", "maxLength": 1048576 },
        "lineCount": { "type": "integer" }, "truncated": { "type": "boolean" },
        "sensitive": { "type": "boolean", "default": false }
      } },
    "WriteFileParams": { "type": "object", "additionalProperties": false,
      "required": ["path", "content"],
      "properties": {
        "path": { "type": "string", "maxLength": 4096 },
        "content": { "type": "string", "maxLength": 1048576 },
        "overwrite": { "type": "boolean", "default": false },
        "workspaceRoot": { "type": ["string", "null"] }
      } },
    "WriteFileResult": { "type": "object", "additionalProperties": false,
      "required": ["ok", "path"],
      "properties": { "ok": { "type": "boolean" }, "path": { "type": "string" } } },
    "ListWorkspacesParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "ListWorkspacesResult": { "type": "object", "additionalProperties": false,
      "required": ["workspaces"],
      "properties": { "workspaces": { "type": "array", "items": { "type": "object", "additionalProperties": false,
        "required": ["root", "active"],
        "properties": {
          "root": { "type": "string" }, "name": { "type": "string" },
          "active": { "type": "boolean" }, "reachable": { "type": "boolean" }
        } } } } },
    "SwitchWorkspaceParams": { "type": "object", "additionalProperties": false,
      "required": ["path"],
      "properties": { "path": { "type": "string" } } },
    "SwitchWorkspaceResult": { "type": "object", "additionalProperties": false,
      "required": ["ok", "activeRoot"],
      "properties": { "ok": { "type": "boolean" }, "activeRoot": { "type": "string" } } },
    "SearchFilesParams": { "type": "object", "additionalProperties": false,
      "required": ["query"],
      "properties": {
        "query": { "type": "string", "minLength": 1, "maxLength": 256 },
        "root": { "type": "string" },
        "maxResults": { "type": "integer", "minimum": 1, "maximum": 100, "default": 100 }
      } },
    "SearchFilesResult": { "type": "object", "additionalProperties": false,
      "required": ["results"],
      "properties": { "results": { "type": "array", "items": { "type": "object", "additionalProperties": false,
        "required": ["relPath"],
        "properties": {
          "relPath": { "type": "string" }, "kind": { "type": "string" },
          "size": { "type": "integer" }
        } } } } },
    "AssetUrlParams": { "type": "object", "additionalProperties": false,
      "required": ["path", "kind"],
      "properties": {
        "path": { "type": "string", "maxLength": 4096 },
        "kind": { "enum": ["image", "pdf", "thumbnail"] }
      } },
    "AssetUrlResult": { "type": "object", "additionalProperties": false,
      "required": ["url", "expiresAt"],
      "properties": { "url": { "type": "string", "format": "uri" }, "expiresAt": { "type": "integer" } } },
    "FileStatParams": { "type": "object", "additionalProperties": false,
      "required": ["path"],
      "properties": { "path": { "type": "string", "maxLength": 4096 }, "workspaceRoot": { "type": ["string", "null"] } } },
    "FileStatResult": { "type": "object", "additionalProperties": false,
      "required": ["size", "modified", "readonly", "kind"],
      "properties": {
        "size": { "type": "integer" }, "modified": { "type": "string" },
        "readonly": { "type": "boolean" }, "kind": { "type": "string" }
      } },

    "RunTaskParams": { "type": "object", "additionalProperties": false,
      "required": ["prompt"],
      "properties": {
        "sessionId": { "type": "string" },
        "prompt": { "type": "string", "minLength": 1, "maxLength": 262144 },
        "promptRef": { "type": "string", "description": "prompt 超限时经流上传的引用（§7.4）" },
        "mode": { "type": "string" }, "cwd": { "type": "string" },
        "permissionMode": { "enum": ["ask", "plan", "full-access"], "default": "ask" },
        "history": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
        "clientMessageId": { "type": "string" }
      } },
    "RunTaskResult": { "type": "object", "additionalProperties": false,
      "required": ["runId", "sessionId"],
      "properties": { "runId": { "type": "string" }, "sessionId": { "type": "string" } } },
    "RunControlParams": { "type": "object", "additionalProperties": false,
      "required": ["level", "runId", "sessionId"],
      "properties": {
        "level": { "enum": ["continue", "soft_inject", "cooperative_stop", "force_cancel"] },
        "runId": { "type": "string" }, "sessionId": { "type": "string" },
        "reason": { "type": "string", "maxLength": 256 },
        "payload": { "type": "object", "additionalProperties": true }
      } },
    "RunControlResult": { "type": "object", "additionalProperties": false,
      "required": ["ok"], "properties": { "ok": { "type": "boolean" } } },
    "CancelRunParams": { "type": "object", "additionalProperties": false,
      "required": ["runId"],
      "properties": { "runId": { "type": "string" }, "reason": { "type": "string", "maxLength": 256 } } },
    "CancelRunResult": { "type": "object", "additionalProperties": false,
      "required": ["ok", "runId"],
      "properties": { "ok": { "type": "boolean" }, "runId": { "type": "string" } } },
    "SearchSessionsParams": { "type": "object", "additionalProperties": false,
      "required": ["query"],
      "properties": {
        "query": { "type": "string", "minLength": 1, "maxLength": 128 },
        "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 50 }
      } },
    "SearchSessionsResult": { "type": "object", "additionalProperties": false,
      "required": ["results"],
      "properties": { "results": { "type": "array", "items": { "type": "object", "additionalProperties": false,
        "required": ["sessionId", "title"],
        "properties": {
          "sessionId": { "type": "string" }, "title": { "type": "string" },
          "hitCount": { "type": "integer" }, "snippet": { "type": "string" }
        } } } } },

    "GetSettingsParams": { "type": "object", "additionalProperties": false,
      "properties": { "keys": { "type": "array", "items": { "type": "string" } } } },
    "GetSettingsResult": { "type": "object", "additionalProperties": false,
      "required": ["settings"],
      "properties": { "settings": { "type": "object", "additionalProperties": true,
        "description": "脱敏设置快照（apiKey 恒空串 + last4）" } } },
    "SetSettingsParams": { "type": "object", "additionalProperties": false,
      "required": ["key", "value"],
      "properties": {
        "key": { "enum": ["responseStyle", "enableAnalytics", "enableCrashTelemetry"] },
        "value": { "type": ["string", "boolean"] }
      } },
    "SetSettingsResult": { "type": "object", "additionalProperties": false,
      "required": ["ok"],
      "properties": {
        "ok": { "type": "boolean" }, "applied": { "type": "boolean" },
        "pending": { "type": "boolean" }, "confirmRequestId": { "type": "string" }
      } },
    "SettingsConfirmParams": { "type": "object", "additionalProperties": false,
      "required": ["confirmRequestId", "action"],
      "properties": {
        "confirmRequestId": { "type": "string" },
        "action": { "enum": ["withdraw", "query"] }
      } },
    "SettingsConfirmResult": { "type": "object", "additionalProperties": false,
      "required": ["status"],
      "properties": { "status": { "enum": ["pending", "withdrawn", "accepted", "rejected", "expired"] },
        "reason": { "type": "string" } } },
    "PauseAutomationParams": { "type": "object", "additionalProperties": false,
      "properties": { "durationSec": { "type": "integer", "minimum": 60, "maximum": 86400, "default": 3600 } } },
    "PauseAutomationResult": { "type": "object", "additionalProperties": false,
      "required": ["ok", "pausedUntil"],
      "properties": { "ok": { "type": "boolean" }, "pausedUntil": { "type": "integer" } } },
    "PresenceParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "PresenceResult": { "type": "object", "additionalProperties": false,
      "required": ["desktopOnline"],
      "properties": {
        "desktopOnline": { "type": "boolean" },
        "lastInteractionAt": { "type": "integer" },
        "engineVersion": { "type": "string" }
      } },

    "ListDevicesParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "ListDevicesResult": { "type": "object", "additionalProperties": false,
      "required": ["devices"],
      "properties": { "devices": { "type": "array", "items": { "type": "object", "additionalProperties": false,
        "required": ["deviceId", "name", "type", "role"],
        "properties": {
          "deviceId": { "type": "string" }, "name": { "type": "string" },
          "type": { "enum": ["desktop", "phone", "tablet"] },
          "role": { "enum": ["this", "peer"] },
          "channel": { "enum": ["lan", "relay"] }, "online": { "type": "boolean" },
          "lastActiveAt": { "type": "integer" }, "pairedAt": { "type": "string" },
          "needsReauth": { "type": "boolean" }
        } } } } },
    "RenameDeviceParams": { "type": "object", "additionalProperties": false,
      "required": ["deviceId", "name"],
      "properties": { "deviceId": { "type": "string" }, "name": { "type": "string", "maxLength": 64 } } },
    "RevokeDeviceParams": { "type": "object", "additionalProperties": false,
      "required": ["deviceId"],
      "properties": { "deviceId": { "type": "string" } } },
    "PairStateParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "PairStateResult": { "type": "object", "additionalProperties": false,
      "required": ["state"],
      "properties": {
        "state": { "enum": ["none", "scanning", "inputting", "handshaking", "done", "failed"] },
        "desktopId": { "type": "string" }
      } },
    "UnlinkParams": { "type": "object", "additionalProperties": false, "properties": {} },
    "UnlinkResult": { "type": "object", "additionalProperties": false,
      "required": ["ok"], "properties": { "ok": { "type": "boolean" } } }
  }
}
```

> 命令 kind 与 schema 对照表（C01-C37）：getStatus→StatusQuery/StatusResult；
> getRunSnapshot→RunSnapshotParams/Result；readSessionEvents→EventPageParams/Result；
> readRunEvents→RunEventsParams/EventPageResult；listSessions→ListSessionsParams/Result；
> listBackgroundTasks→ListTasksParams/Result；getTaskOutput→TaskOutputParams/Result；
> getFlowSnapshot→FlowSnapshotParams/Result；listCommands→ListCommandsParams/Result；
> getSearchIndex→SearchIndexParams/Result；approve→ApproveParams/ApproveResult；
> deny→DenyParams/ApproveResult；listPendingApprovals→ListPendingApprovalsParams/Result；
> approvalHistory→ApprovalHistoryParams/Result；checkCommand→CheckCommandParams/Result；
> listDir→ListDirParams/Result；readFile→ReadFileParams/Result；
> writeFile→WriteFileParams/Result；listWorkspaces→ListWorkspacesParams/Result；
> switchWorkspace→SwitchWorkspaceParams/Result；searchFiles→SearchFilesParams/Result；
> assetUrl→AssetUrlParams/Result；fileStat→FileStatParams/Result；
> runTask→RunTaskParams/Result；runControl→RunControlParams/Result；
> cancelRun→CancelRunParams/Result；searchSessions→SearchSessionsParams/Result；
> getSettings→GetSettingsParams/Result；setSettings→SetSettingsParams/Result；
> settingsConfirm→SettingsConfirmParams/Result；pauseAutomation→PauseAutomationParams/Result；
> queryPresence→PresenceParams/Result；listDevices→ListDevicesParams/Result；
> renameDevice→RenameDeviceParams/通用 ok；revokeDevice→RevokeDeviceParams/通用 ok；
> getPairState→PairStateParams/Result；unlink→UnlinkParams/Result。

### 10.7 流消息（stream.*）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.stream.v1",
  "title": "StreamMessages",
  "description": "大载荷分块流（§7）：open → chunk* → close；resume 断线续传",
  "$defs": {
    "StreamOpen": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "kind"],
      "properties": {
        "streamId": { "type": "string", "maxLength": 64 },
        "kind": { "enum": ["event_replay", "file", "task_output", "prompt"] },
        "totalBytes": { "type": "integer", "minimum": 0 },
        "meta": { "type": "object", "additionalProperties": true }
      }
    },
    "StreamChunk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "seq", "data"],
      "properties": {
        "streamId": { "type": "string" },
        "seq": { "type": "integer", "minimum": 1 },
        "data": { "type": "string", "maxLength": 65536, "description": "UTF-8 文本块（或 base64，meta.encoding=b64）" },
        "final": { "type": "boolean", "default": false },
        "nextOffset": { "type": "integer", "minimum": 0, "description": "字节偏移锚点（final 时省略）" }
      }
    },
    "StreamResume": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "offset"],
      "properties": { "streamId": { "type": "string" }, "offset": { "type": "integer", "minimum": 0 } }
    },
    "StreamClose": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "ok"],
      "properties": {
        "streamId": { "type": "string" },
        "ok": { "type": "boolean" },
        "error": { "$ref": "conex.device.envelope.v1/$defs/ErrorBody" },
        "totalDelivered": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

### 10.8 事件容器（events.push.body.event 的轮廓 schema）

事件载荷 = AgentEventEnvelope 扁平 JSON（41 变体字段树以注册表
`engine-events.json` 为准；完整 41 事件 schema 由生成器产出，跨端不手写）。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.event-payload.v1",
  "title": "CrossDeviceEventPayload",
  "description": "事件载荷 = AgentEventEnvelope 扁平 JSON；type 为 41 变体注册表；字段以 engine-events.json 为准",
  "type": "object",
  "required": ["type", "schemaVersion", "sessionId"],
  "properties": {
    "type": { "type": "string", "description": "41 变体 kebab-case type（注册表 id 1-41）" },
    "runId": { "type": "string" },
    "sequence": { "type": "integer", "minimum": 0 },
    "schemaVersion": { "type": "integer", "const": 1 },
    "sessionId": { "type": "string" },
    "redacted": { "type": "boolean",
      "description": "true = 按裁剪策略抑制正文（fail-closed 元组，§5.2.3）" }
  },
  "additionalProperties": true
}
```

---

## 11. 版本化

### 11.1 版本面划分（四个正交版本）

| 版本面 | 标识 | 当前值 | 演进载体 | 兼容规则 |
|---|---|---|---|---|
| 跨端协议 | `DeviceEnvelope.v` + `hello.protocolVersion` | 1 | 本协议（D3 §10） | 主版本协商；次版本只加可选字段 |
| 事件信封 | `schemaVersion`（信封字段） | 1（EVENT_ENVELOPE_SCHEMA_VERSION，events.rs:939） | 33-event-schema-changelog.md | 缺省=1；minor 加可选字段；major 删改字段 |
| 命令清单 | `COMMAND_MANIFEST_CONTRACT_VERSION` | "1.0.0" | command_manifest.rs + 前端镜像 | semver：major=破坏性（删命令/改参数） |
| **设备域注册表**（M6 新增） | `device-protocol.json.schemaVersion` | 1 | device-protocol.json + 生成器 | 与 engine-events.json 同纪律（新增必填字段 = major） |

四者独立推进：事件 schema 演进不影响协议 v；协议加能力（新 kind）不 bump
事件 schemaVersion；命令新增条目不 bump 协议版本（移动端按 manifest 发现）；
设备域注册表只管理**新增消息 kind 与消息字段**，与协议主版本解耦。

### 11.2 能力协商（hello 能力位全表）

能力位 = `hello.capabilities`（移动端声明）/ `hello.ok.capabilities`（桌面声明），
生成器产物 `generated/device/capabilities.ts` 固化字面量联合：

| 能力位 | 归属 | 语义 | 关联命令/消息 |
|---|---|---|---|
| `fileRead` | 双方 | 文件读取/浏览 | C16/C17/C19/C20/C22/C23 |
| `fileWrite` | 桌面 | 受控写文件 | C18 |
| `taskList` | 桌面 | 后台任务查询 | C06/C07 |
| `taskInput` | 桌面 | 终端输入（本期不开） | workbench_send_input（白名单外） |
| `runTask` | 桌面 | 发起 run（P2 默认关） | C24 |
| `runControl` | 桌面 | run 控制 | C25/C26 |
| `streams` | 桌面 | 分块流支持 | stream.* |
| `eventReplay` | 桌面 | 断线续传/历史回放 | events.resume / C03 |
| `approval` | 桌面 | 审批中心 | C11-C14 |
| `settings` | 桌面 | 设置镜像 + 确认通道 | C28-C31 |
| `devices` | 桌面 | 设备管理 | C33-C37 |
| `search` | 桌面 | 文件名搜索 | C21 |
| `sessionSearch` | 桌面 | 服务端会话搜索（P2） | C27 |
| `cron` / `timer` / `subagent` | 桌面 | 事件能力位（D3 §10.2） | 事件面 |
| `presence` | 桌面 | 桌面在场查询 | C32 |

移动端按能力位裁剪 UI；能力位缺省 = false（fail-closed）。会话期禁止换版本
（换版本 = 重连，D3 §10.2）。

### 11.3 字段演进规则（兼容 / 破坏性变更流程）

**兼容变更**（仅允许以下三类，落 `docs/multi-device/plans/33-device-schema-changelog.md` 登记）：

1. **新增可选字段**：`body` 内加 `?` 字段；旧端忽略未知字段（解析器宽容，
   与 `AgentEventEnvelope` 旧帧容忍一致，events.rs:979-984）；
2. **新增 kind**：新 kind 不影响旧 kind；**新 kind 的使用必须先经能力协商**；
   旧端收到未知 kind 丢弃 + 记日志（不报错）；
3. **枚举加值**：只加不改名不改义（与 ApprovalDecision 演进惯例一致）。

**破坏性变更**（必须 bump 主版本并双版本并存窗口 ≥ 一个发布周期）：

1. 删除/改名 kind 或必填字段；
2. 改字段语义（如 sequence 从 u64 改 i64）；
3. 改鉴权方案（HMAC 算法、canon 输入）；
4. 改配对密码学（X25519 → 其他曲线）；
5. 裁剪策略降级（某字段从「摘要」改「全量下发」——放宽隐私边界视为破坏性，
   必须走用户显式配置 + changelog 登记）。

**废弃流程（三阶段）**：

```
阶段一（deprecated）：消息/字段标记 deprecated（生成器产物加注释 + capabilities
                      报表），仍全量支持；
阶段二（双版本共存）：服务端按 hello 协商分支实现（新协议走新路径），旧路径
                      保留 ≥ 一个发布周期；changelog 登记下线日期；
阶段三（移除）：旧版本支持期过后移除；移动端低于 minProtocolVersion 的版本
                收到 version_mismatch 提示升级。
```

### 11.4 事件 schemaVersion 与协议的关系

- 事件字段演进（新增事件体字段）由 `schemaVersion` 承载：缺省 1；旧帧无字段
  照常解析（Option + serde 缺省，PermissionRequest 扩展先例 events.rs:207-217）；
- 跨端协议**不过问**事件体字段——移动端把未知事件体字段当扩展点（生成器
  parser 对 `parseEngineEvent` 之外的字段宽容）；
- 事件新增变体（第 42 个）只 bump 注册表（registry_drift 锁），协议不变；
  移动端旧版本对未知 `type` 帧：保留渲染为「未知事件」摘要卡，不崩溃
  （parser 默认分支 parseErr → UI 兜底）；
- **新增变体必须同步登记裁剪规则**（§5.2），否则默认 fail-closed 元组
  （安全设计：新事件宁可看不见，不可泄露）。

---

## 12. 实现落点

### 12.1 conex-types 新模块：`device/`（不新建 crate）

**决策**：新增 `crates/conex-types/src/device/` 模块族 + 注册表
`crates/conex-types/contracts/device-protocol.json`（D3 §12.2 细化）：

```
crates/conex-types/src/
  device/mod.rs          -- 模块头 + 重导出（DeviceEnvelope/消息体/错误码/常量/能力位）
  device/envelope.rs     -- DeviceEnvelope + AuthHeader + 签名构造/校验（HMAC-SHA256）
  device/pair.rs         -- PairHello/Challenge/Verify/Ok/Ready/Unlink + 配对码生成/标准化
  device/token.rs        -- HKDF 派生（token_key/enc_key/refresh_key）+ refresh token
  device/events.rs       -- Subscribe/Resume/ResumePage/EventsPush + session.* 广播
  device/commands.rs     -- CommandRequest/Result + 37 命令参数/响应类型 + 白名单常量表
  device/stream.rs       -- StreamOpen/Chunk/Resume/Close
  device/error.rs        -- DeviceErrorCode 枚举 + 与 CoreError 映射（§6.2.3）
  device/version.rs      -- PROTOCOL_VERSION / MIN_PROTOCOL_VERSION / 能力位常量表（§11.2）
contracts/device-protocol.json   -- 设备域注册表（生成器输入，§12.2）
```

理由（D3 §12.2 复述）：conex-types 是双端契约唯一事实源的既有归属；避免新
crate 依赖矩阵开销；生成器单一输入面。

### 12.2 device-protocol.json 注册表结构

与 engine-events.json 同形风格（生成器泛化依赖结构兼容）：

```jsonc
{
  "contract": "device-protocol",
  "schemaVersion": 1,
  "protocolVersion": 1,
  "messageCount": 103,
  "messages": [
    // 每消息一条：id 从 1 顺序编号
    { "id": 1, "kind": "pair.hello", "rustVariant": "PairHello", "direction": "mobile-to-desktop",
      "authPhase": "pairing",                       // pairing | handshake | session
      "fields": [
        { "name": "code", "type": "string", "required": true },
        { "name": "deviceId", "type": "string", "required": true },
        { "name": "mobilePub", "type": "string", "required": true },
        { "name": "mobileLongPub", "type": "string", "required": true },
        { "name": "deviceName", "type": "string", "required": true },
        { "name": "platform", "type": "string", "required": false }
      ] }
    // ... 其余 102 条同构（cmd.* 的 params/result 分开登记为两消息或引用命令表）
  ],
  "commands": [                                     // 命令元数据（生成白名单）
    { "name": "getStatus", "tauriCommand": "core_get_status", "surface": "engine",
      "domain": "monitor", "write": false, "paramsType": "StatusQuery", "resultType": "StatusResult" }
    // ... 37 条
  ],
  "capabilities": [ "fileRead", "fileWrite", "taskList", "taskInput", "runTask",
    "runControl", "streams", "eventReplay", "approval", "settings", "devices",
    "search", "sessionSearch", "cron", "timer", "subagent", "presence" ],
  "errorCodes": [
    { "code": "cmd.approval_mismatch", "retryable": false, "coreErrorKinds": ["NotFound"] }
    // ... 全量错误码（§6.2）
  ],
  "types": { /* 消息体 struct（与 engine-events 的 types 同构） */ },
  "enums": { /* 枚举字面量（level/decision/state 等） */ }
}
```

校验规则（生成器复用 engine-events 的纪律）：

- message id 顺序 1..n；kind 唯一；
- `authPhase` ∈ {pairing, handshake, session}（路由表生成输入）；
- `direction` ∈ {mobile-to-desktop, desktop-to-mobile, both}；
- number 字段必须声明 integer（F8-07 纪律沿用）；
- commands 的 tauriCommand 必须命中 manifest（运行时以 core_list_commands 为准，
  注册表只做生成期校验）。

### 12.3 生成器扩展（scripts/generate-engine-bindings.mjs 泛化）

**决策**：把生成器**泛化为多注册表分发，不复制脚本**（D3 §12.4 细化）：

1. **入口改造**：脚本按 `contract` 字段分发——`engine-events`（既有 41 事件）
   与 `device-protocol`（新增设备域）；注册表路径改为扫描
   `crates/conex-types/contracts/*.json`（或显式双路径）；
2. **共享骨架提取**：`PARSER_PREAMBLE` / 深度守卫（256）/ 整数校验 / 确定性
   字节 / ASCII-only 纪律提为共享常量（`gen-core.mjs` 或脚本内共享函数）；
3. **输出落点**：
   - 既有：`packages/shared-types/src/generated/engine/{events,types,parser,index}.ts`（不变）；
   - 新增：`packages/shared-types/src/generated/device/{messages,types,parser,index,errors,capabilities}.ts`；
4. **附加产物**：
   - `device/errors.ts`：DeviceErrorCode 枚举 + CoreError kind 映射表（§6.2.3）；
   - `device/capabilities.ts`：能力位字面量联合（§11.2）；
   - `device/manifest.ts`：命令白名单常量（§4.7 三重约束的 B/C 面）；
5. **事件体不重新生成**：移动端事件解析直接复用
   `generated/engine/parser.ts` 的 `parseEngineEvent`（跨端零成本，D3 §12.4）；
6. **护栏**：`tests/registry_drift.rs` 增加 device-protocol ↔
   `crates/conex-types/src/device/**` 的对应护栏测试（kind 全量、字段名、
   错误码全量、能力位全量）；生成器幂等测试（两次运行字节一致）扩展 device 域；
7. 生成命令：`node scripts/generate-engine-bindings.mjs`（单入口，全注册表）。

### 12.4 桌面壳侧新增（apps/agent-workbench/src-tauri/src/）

| 模块 | 职责 | 对应协议面 |
|---|---|---|
| `device_relay.rs` | WS 监听 + 连接管理 + DeviceEnvelope 解包/验签/路由（扇出 1:2） | 全部 |
| `command_adapter.rs` | 跨端命令 → Tauri 命令调用（白名单 + CoreError 映射 §6.2.3） | cmd.* |
| `pairing_service.rs` | 配对状态机（码生成/哈希/有效期/并发限制）+ Device Registry 读写 | pair.* / device.* |
| `device_emitter.rs` | `Emitter` trait 实现（core_event_bridge.rs:51-54），下游慢信号回传 | events.push |
| `redact.rs` | 事件裁剪规则表（§5.2 RedactSpec）+ 白名单 + 三档摘要 | events.push / resume |
| `sync_projection.rs` | 投影查询（会话索引/run 摘要/待办/审计）+ backward 分页 | C03/C05/C13/C14 |
| `settings_bridge.rs` | 设置镜像 + 桌面确认通道 | C28-C31 |
| `presence.rs` | 桌面在场状态（心跳上报 + 最近交互时间） | C32 |

**新增 mobile_* 命令接线清单**（对应 F 系列建议，注册后 registered=true）：

| 命令 | 实现位置 | 依赖 |
|---|---|---|
| `mobile_list_pending_approvals` | sync_projection.rs（events 表派生） | 无新增表 |
| `mobile_approval_sync_state` | sync_projection.rs（approval-resolved 投影） | 无 |
| `mobile_get_workspace_state` | workspace.rs 薄壳（M4-2） | workbench_list_workspaces 接线 |
| `mobile_search_files` | fuzzy_find 薄壳（M4-3） | agent-tools search.rs |
| `mobile_asset_url` | convertFileSrc 代理（M4-4） | HTTP 资源代理（F4 §5.4，需网络域评审） |
| `mobile_settings_confirm` | settings_bridge.rs | 桌面确认条 UI |
| `mobile_pause_automation` | settings_bridge.rs | 一次性指令 |
| `device_presence_query` | presence.rs | 心跳上报 |
| `mobile_search_sessions` | P2 预留（v2） | 服务端索引 |

**Device Registry 落库**（conex-db v6 迁移，D3 §4.5 DDL）：`device_registry` 表 +
`sync_commands` 表（§9.2）+ `pair_codes`（码哈希，可选）。

### 12.5 移动端消费面（crish-mobile，本期只定协议不实现）

- 连接层：WS 客户端 + 证书固定（D3 §4.6）+ DeviceEnvelope 编解码
  （generated/device/parser.ts）；
- 命令层：CommandInvoker（请求-响应关联 + 超时 + 幂等重发）+ outbox 队列
  （§9.2 状态机）；
- 状态层：`(sessionId → lastSequence)` 游标持久化 + 投影表
  （D6 §10.6 表结构草案）+ 对账引擎（§9.3）；
- 渲染层：41 事件 → 移动端 UI 组件映射表（§5.1 消费功能列）；未知事件保真兜底。

---

## 13. 端到端验收锚点

| # | 验收点 | 证据 |
|---|---|---|
| T-M6-01 | 37 命令白名单与 manifest 三重约束一致（新增 mobile_* 全部 registered） | command_adapter 白名单测试 |
| T-M6-02 | 事件 41 变体逐条可路由（双面策略表 → 路由表） | relay 路由测试（41 用例） |
| T-M6-03 | fail-closed：未登记裁剪规则的事件只出元组（redacted=true） | redact.rs 测试（E3 语义，D6 §11.5） |
| T-M6-04 | 敏感字段不出网：message thought / approval parameters / task tail 全量在任何档位不可见 | redact 断言测试（T13 语义，D6 §11.2） |
| T-M6-05 | 幂等：同 msgId 重发 writeFile/approve → 回显首次结果、无重复执行 | sync_commands 去重测试 |
| T-M6-06 | outbox：离线 3 条审批决策 → 上线逐条提交（accepted/stale/conflict 分派） | 队列状态机测试（T9 语义） |
| T-M6-07 | 断线续传：游标后事件完整补发（Soft+Critical）、Delta 不补 | resume 分页 + 有序性测试（T-D3-05） |
| T-M6-08 | 背压：下行窗口溢出先丢 Delta 再丢 Soft、Critical 反压 | device_emitter EmitReport 测试 |
| T-M6-09 | 流续传：stream 中断后按 offset 续传、块级 seq 去重 | stream 集成测试 |
| T-M6-10 | 生成器幂等：device 域两次运行字节一致 + registry_drift 护栏全绿 | CI 生成校验（T-D3-09） |
| T-M6-11 | 协议协商：v 不匹配 → version_mismatch；能力位裁剪 UI | hello 协商测试 |
| T-M6-12 | 会话索引广播：session.updated/removed 驱动列表增量刷新（替代 4s 轮询） | 会话面集成测试 |
| T-M6-13 | backward 分页：F5 首屏尾部倒序拉取与 forward 拼接无重无漏 | query_events_backward 测试 |
| T-M6-14 | 设置确认通道：60s 超时 → 拒绝语义；withdraw 幂等 | settings_bridge 测试 |

---

## 14. 附录

### 14.1 常量表（落位 crates/conex-types/src/device/version.rs）

| 常量 | 值 | 说明 |
|---|---|---|
| PROTOCOL_VERSION | 1 | 当前协议主版本 |
| MIN_PROTOCOL_VERSION | 1 | 兼容下限 |
| MAX_FRAME_BYTES | 1_048_576 | 单帧上限（信封层） |
| EVENT_PUSH_MAX_BYTES | 65_536 | 单事件 push 帧上限 |
| EVENT_WINDOW | 4096 | 每会话下行窗口 |
| MAX_SUBSCRIPTIONS | 32 | 订阅会话上限 |
| MAX_STREAMS | 8 | 并发流上限 |
| STREAM_CHUNK_MAX | 65_536 | 块上限 |
| STREAM_MAX_BYTES | 268_435_456 | 单流总量上限（256 MiB） |
| STREAM_TTL_MS | 300_000 | 断线流上下文保留（5min） |
| PROMPT_MAX_BYTES | 262_144 | cmd.runTask.prompt 跨端上限（256 KiB） |
| PAGE_SIZE_DEFAULT | 200 | 分页默认页大小 |
| PAGE_SIZE_MAX | 1000 | 分页上限 |
| PAIR_CODE_TTL_MS | 600_000 | 配对码有效期 |
| PAIR_MAX_ATTEMPTS | 5 | 单码失败上限 |
| PAIR_MAX_ACTIVE | 3 | 并发码上限 |
| PAIR_MAX_DEVICES | 8 | 设备数上限 |
| AUTH_TS_WINDOW_MS | 300_000 | 签名时戳窗口 |
| HEARTBEAT_INTERVAL_MS | 30_000 | 移动端心跳间隔 |
| HEARTBEAT_TIMEOUT_FACTOR | 3 | 断线判定倍数 |
| IDEMPOTENCY_TTL_MS | 300_000 | 命令幂等结果缓存（D3） |
| IDEMPOTENCY_TABLE_TTL_DAYS | 30 | sync_commands 保留期 |
| OUTBOX_MAX_ITEMS | 200 | outbox 队列上限 |
| OUTBOX_RETRY_BACKOFF | 1s/4s/16s/60s | 退避序列 |
| RECONCILE_REBUILD_THRESHOLD | 5000 | 落后重建阈值（事件数） |
| ASSET_TOKEN_TTL_MS | 600_000 | 资源 URL 令牌有效期 |

### 14.2 参考代码索引

| 事实 | 位置 |
|---|---|
| AgentEvent 41 变体定义 | crates/conex-types/src/events.rs:306-782 |
| 事件类型名宏 / ALL_TYPE_NAMES | crates/conex-types/src/events.rs:789-852 |
| 背压分级函数 | crates/conex-types/src/events.rs:867-903 |
| AgentEventEnvelope 扁平序列化 | crates/conex-types/src/events.rs:905-1013 |
| 事件存储游标（query_events / reserve_sequence / seed_sequence） | crates/conex-db/src/events.rs:6-131 |
| 命令清单 95 条 | apps/agent-workbench/src-tauri/src/command_manifest.rs:63-191 |
| core_list_commands | apps/agent-workbench/src-tauri/src/command_manifest.rs:196-199 |
| 事件分页契约 EventPage | apps/agent-workbench/src-tauri/src/core_query_commands.rs:326-338 |
| 审批门 / I-02 校验 | apps/agent-workbench/src-tauri/src/core_run_commands.rs:151-344 |
| run 状态机转移表 / TerminalImmutable | crates/orchestrator/src/run.rs:146-156, 340-364 |
| 生成器 | scripts/generate-engine-bindings.mjs（注册表驱动 + PARSER_PREAMBLE） |
| 前端审批载荷 TS 契约 | packages/shared-types/src/permissions.ts:13-29 |
| L0-L3 控制契约 | packages/shared-types/src/run-control.ts:17-96 |

### 14.3 与既有文档的衔接关系

| 文档 | 衔接点 |
|---|---|
| `docs/multi-device/plans/33-device-schema-changelog.md` | 本协议的演进登记文档（§11.3 纪律），首次发布登记 v1 全量 |
| D3 §13.2 常量表 | 本附录 14.1 为其扩展（新增 M6 常量） |
| D6 §11 测试清单 | 本协议验收锚点 T-M6-03/04/05/06 对应 D6 T12/T13/T10/T9 |
| D7 §3 场景清单 | §5.3 推送级别表逐场景对应 |
| F1 §6.4 网关请求形状 | C01/C02 响应 schema 直接采用 |

### 14.4 开放问题（评审关注）

1. **backward 分页的接线**：`query_events_backward` 需要 conex-db 新增查询面；
   若评审否决，F5 首屏降级为「forward 拉最新 N 页再内存倒序」（游标大时低效，
   建议保留 backward）。
2. **批量审批协议形态**：v1 批量 = 移动端并发多个 cmd.approve（F2 §5.4 串行 +
   小并发 2），`partial` 响应形态仅为协议预留；若后续需要服务端批量原子性，
   再新增 `cmd.approveBatch`（新 kind，能力协商引入）。
3. **五条 gui 面命令的 surface 迁移**（§4.8）：迁移为 engine 面需双端 manifest
   同步 + 前端 BUILTIN_COMMAND_MANIFEST 镜像更新，列实现排期项。
4. **资源代理（cmd.assetUrl）**：依赖桌面 HTTP 通道（F4 §10 R4-1），需网络域
   联合评审；否决则图片预览降级为「仅元数据 + 桌面端打开」。
5. **推送的厂商通道密钥**与移动端 token 注册（D7 §8）为独立排期；本协议
   push 面只定义载荷语义（§5.3），不承载通道实现。
6. **审批过期事件**（F2 §8.3 引擎增强提案）：若引擎补发
   `approval-resolved(expired)`，移动端本地倒计时降级为展示辅助；协议无需
   变更（事件已存在），仅白名单与推送级别不变。

---

（文档完）
