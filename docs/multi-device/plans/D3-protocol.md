# D3 端间协议设计：crish 多端互通核心协议

> 版本：v1.0（草案）
> 作者：子 Agent D3（端间协议设计）
> 日期：2026-08-09
> 状态：设计稿（待评审）
> 依赖：本设计以 `crates/conex-types/src/events.rs`（AgentEvent 41 变体）、
> `crates/conex-db/src/events.rs`（sequence 语义）、
> `crates/orchestrator/src/events.rs`（EventQueue 分流）、
> `apps/agent-workbench/src-tauri/src/`（command_manifest / core_event_bridge /
> core_run_commands / core_query_commands）、`packages/shared-types/**`（前端契约）、
> `scripts/generate-engine-bindings.mjs`（生成器）为代码事实依据。
>
> 目标：为桌面（Tauri 主机，引擎所在端）与移动端（crish-mobile）之间的
> **配对 / 认证 / 消息信封 / 事件 / 命令 / 流 / 版本化**定义可落地的精确协议，
> 所有消息类型给出 JSON schema（draft 2020-12 风格）。

---

## 目录

1. [文档约定与重要修正](#1-文档约定与重要修正)
2. [现状盘点：可直接复用的代码事实](#2-现状盘点可直接复用的代码事实)
3. [总体架构与拓扑](#3-总体架构与拓扑)
4. [配对协议（Pairing）](#4-配对协议pairing)
5. [认证与消息信封（Authentication & Envelope）](#5-认证与消息信封authentication--envelope)
6. [错误码体系](#6-错误码体系)
7. [事件协议（Event Protocol）](#7-事件协议event-protocol)
8. [命令协议（Command Protocol）](#8-命令协议command-protocol)
9. [流协议（Stream Protocol）](#9-流协议stream-protocol)
10. [版本化（Versioning）](#10-版本化versioning)
11. [JSON Schema 定义（完整）](#11-json-schema-定义完整)
12. [与现有代码融合（Fusion）](#12-与现有代码融合fusion)
13. [附录](#13-附录)

---

## 1. 文档约定与重要修正

### 1.1 术语表

| 术语 | 含义 |
|---|---|
| 桌面端（desktop） | Tauri 主机端，运行引擎（session-loop / orchestrator）与事件存储，是协议的**服务端** |
| 移动端（mobile） | crish-mobile，纯客户端，不运行引擎；通过 WS 连接桌面 |
| 中继（relay） | 协议设计中的可选网络中转角色（跨网段时使用）；本期不实现，仅为协议留位 |
| 设备会话（device session） | 一对「桌面-移动」配对建立后的长期安全信道，与 agent 会话（session_id）无关 |
| agent 会话（agent session） | 引擎侧会话，`session_id` 标识，事件按 (session_id, sequence) 组织 |
| 配对码（pairing code） | 一次性、短时有效的邀请码，移动端凭它发起配对 |
| 设备令牌（device token） | 配对成功后派发的长期凭据，随每个请求经 HMAC 签名传递 |
| 事件信封（event envelope） | `AgentEventEnvelope` 的扁平 JSON 形态 `{type, runId, sequence, schemaVersion, ...事件字段}` |
| 跨端信封（device envelope） | 本协议新增的外层信封，承载设备会话级字段（msgId/ts/auth 等） |
| sequence | 会话级单调事件序号，跨 run 不重置（conex-db `session_sequence` 原子取号） |

### 1.2 重要修正：AgentEvent 变体数为 41，不是 27

任务书描述「AgentEvent 27 变体」，但按代码事实（`crates/conex-types/src/events.rs`）：

- 2026-08-05 T-CF-04 定时器域兼容新增 2 变体（timer-fired / timer-cancelled），38 → 40；
- 同日 T-CF-08 cron 域兼容新增 1 变体（cron-fired），40 → 41；
- `AgentEvent::ALL_TYPE_NAMES`（events.rs:810-852）与事件注册表
  `contracts/engine-events.json` 编号 1-41 一一对应（`tests/registry_drift.rs` 锁定）。

**本设计以 41 变体为唯一事实源**，第 7 章逐个给出 wire 形态、跨端包装策略与
背压级别。任务书若引用 27 变体，属历史快照（约 24 基线 + 3 早期增量），不影响
本设计——协议对变体采用**注册表驱动**，变体增删由登记表 + 生成器自动跟进，
不写死在协议层。

### 1.3 设计原则（贯穿全文）

1. **原样透传事件体**：引擎事件跨端**不做二次包装、不新增字段**——移动端收到的
   事件 JSON 与桌面 Tauri 事件通道 `workbench-run-event` 发射的载荷**逐字节同构**
   （扁平顶层 `{type, runId, sequence, schemaVersion, sessionId, ...}`，见
   core_event_bridge.rs:6-9 的既有验收）。跨端专属字段只存在于**外层设备信封**，
   避免事件体双源漂移（registry_drift 护栏只保护事件体，不保护外部包装）。
2. **复用而非新造**：能直接复用 `AgentEventEnvelope` 序列化、conex-db
   `query_events` 分页、`core_read_session_events` 的 EventPage 契约、共享类型
   的既有 wire 形态（camelCase、kebab-case type tag）的地方一律复用。
3. **backpressure 分级沿用到跨端链路**：`BackpressureLevel`（Delta/Soft/Critical，
   events.rs:179-188）即跨端传输优先级；Delta 可丢、Soft 尽力、Critical 必达
   （断线补发/重连游标只对 Critical + Soft 负责）。
4. **序列号以服务端为准**：移动端不产号；游标只做「读侧去重 + 续传锚点」。
5. **协议版本独立于事件 schemaVersion**：跨端协议版本管「信封 + 命令 + 配对」；
   事件体演进继续走 `schemaVersion`（当前恒 1）+ `33-event-schema-changelog.md`
   的 minor/major 规则（见第 10 章）。

---

## 2. 现状盘点：可直接复用的代码事实

### 2.1 AgentEvent 信封形态（events.rs:905-1013）

- `AgentEventEnvelope { event, run_id: Option<String>, sequence: Option<u64>,
  schema_version: u32 }`，序列化为**扁平顶层 JSON**：
  `{ type, runId, sequence, schemaVersion, sessionId, ...事件字段 }`。
- `runId` / `sequence` 是 Option：实时预览帧（审批门广播、审计 sink）以
  `sequence=None` 发射，收口流携带持久化序列（core_run_commands.rs:3142-3149）。
- `schemaVersion` 缺省视为 1（`EVENT_ENVELOPE_SCHEMA_VERSION = 1`，旧帧无该字段
  照常解析）。
- `run-terminal` 事件体自带 `runId` 字段，与信封注入同名——serde flatten 冲突
  经 `serde_json::Value` 手工合并解决（注入值覆盖事件体同名值）。
- 前端放行不过滤 `runId` 缺失，但多 run 并发过滤失效（前端 eventUtils.ts:21）。

### 2.2 事件存储 sequence 语义（conex-db/src/events.rs）

- `events` 表：`(session_id, sequence, event_type, payload, created_at)`，
  `UNIQUE(session_id, sequence)`（schema.rs:17-25）。
- `reserve_sequence`：会话级原子取号（`session_sequence` 表自增；首次按
  `MAX(sequence)+1` 预热，T08.12 Q23：会话内全局单调、跨 run 不重置、
  防并发 run 冲突；events.rs:72-99）。
- `seed_sequence`：MAX 语义幂等校准（events.rs:103-121）。
- `query_events(session_id, after_sequence, limit)`：`sequence > after` 升序分页
  （events.rs:33-68）——**这就是断线续传的原生游标查询**。
- 落库 payload 为**事件体 JSON**（orchestrator events.rs:189-193 存 `event` 本身），
  读侧经 `AgentEventEnvelope` 反序列化补信封（runId/sequence 缺省 None，
  core_query_commands.rs:481-491）——因此跨端续传回放时须**以 DB 行 sequence
  为准重建信封 sequence 字段**（见 7.5）。

### 2.3 orchestrator 事件分流（orchestrator/src/events.rs）

- `EventClass`：Persistent（同步等待落库）/ NonPersistent（delta 不落库不阻塞
  drive loop；event_class:48-58）。
- `run-terminal` 为唯一终态事件（只发一次；失败复用序列号 Q25 不留空洞；
  终态 cursor 落库 T08.4）。
- 非持久化集合 = `message-delta` + `subagent-event`(progress)（与注册表
  backpressure=Delta 一致）；`subagent-event`(message/tool)、`task-suspicious`、
  `timer-cancelled` 为 Soft（落库 + 尽力投递）；其余 Critical。
- 审批：approval-requested **先广播后等待**（防死锁，01 §五.8），120s 超时
  → Expired（`APPROVAL_TIMEOUT`，core_run_commands.rs:88）；`core_approve_tool /
  core_deny_tool` 入口先校验 tool_call_id ∈ 待审批集合（I-02 / T12.3，
  core_run_commands.rs:230-258）。

### 2.4 桌面命令面（command_manifest.rs）

- 92 条命令（注册面 88 + 登记先行 4），`contractVersion = "1.0.0"`；
  family ∈ {core, config, session, md, perf, workbench, workflow}，
  surface ∈ {engine, gui}（engine = 三端共用契约面，**移动端只允许调用
  surface=engine 的命令**，见 8.3）。
- `core_list_commands` 启动即可用、无状态，返回完整清单——移动端握手后拉取
  它就是**跨端命令能力的真源**（不维护第二份清单）。
- 与端间协议直接相关的命令（第 8 章逐条映射）：

| 命令 | 用途 | 移动端映射动作 |
|---|---|---|
| core_run_task | 发起 run（RunTaskOptions → {runId, sessionId}） | 发送消息 / 新建会话任务 |
| core_run_control | L0-L3 run 控制（RunControlIntent） | 暂停/恢复/继续 |
| core_cancel_run | 取消 run（{ok, runId}） | 停止 |
| core_approve_tool / core_deny_tool | 审批通过/拒绝（{ok, toolCallId, decision}） | 审批操作 |
| core_read_session_events | 会话事件分页（EventPage） | 断线续传/历史拉取 |
| core_read_run_events | run 事件分页（EventPage） | run 详情 |
| core_get_run_snapshot | run 快照（{snapshot}） | run 状态 |
| core_get_status | 桌面状态/诊断 | 状态页 |
| core_list_commands | 命令清单 | 握手能力发现 |
| core_check_command | 命令闸门检查（Allowed/RequiresApproval/Blocked） | 审批前置预览 |
| workbench_list_directory / workbench_read_file_content | 文件浏览/读取 | 查看文件 |
| workbench_send_input | 后台任务输入（T-AB-19/20） | 终端输入 |
| workbench_list_background_tasks / workbench_get_background_task_output | 任务列表/输出 | 任务面板 |

### 2.5 事件桥（core_event_bridge.rs）

- Tauri 事件通道名恒为 `workbench-run-event`；emit 载荷为完整事件 JSON 字符串，
  不做二次包装（core_event_bridge.rs:6-9, 194-220）。
- `Emitter` trait（`emit(channel, payload)`）抽象 + `TauriEmitter` 实现；
  `EventBridge::serialize` 失败返回 None 跳过（防御性）。
- `BufferedRunEventBridge`（engine.rs）负责按 runId 的背压缓冲与丢帧
  （Delta 丢、Soft 水位丢 Delta），`EmitReport{emitted, buffered, dropped}`。

### 2.6 共享类型（packages/shared-types）

- `run-control.ts`：`RunControlIntent{level, reason?, runId?, sessionId?, payload?}`，
  level ∈ {continue, soft_inject, cooperative_stop, force_cancel}（L0-L3）。
- `permissions.ts`：`PermissionRequest`（TS 侧与 Rust `PermissionRequest` 字段
  对齐：id/sessionId/cwd/toolCallId/toolName/parameters/summary/toolMetadata/
  metadata?）+ `PermissionDecision{behavior: allow|deny|ask, reason?, metadata?}`。
- `stored-event.ts`：前端 event log 协议 v1（`StoredEvent{protocolVersion, id,
  sequence, type, sessionId, runId?, timestamp, payload}`）——桌面事件流之外的
  前端审计轨迹，与端间事件协议**不混流**（移动端不消费它）。
- 生成产物 `generated/engine/{events,types,parser}.ts`：EngineEvent 41 联合类型 +
  `parseEngineEvent` 解析器（守护深度 256、整数校验 F8-07）。

### 2.7 生成器（scripts/generate-engine-bindings.mjs）

- 输入：`crates/conex-types/contracts/engine-events.json`（注册表：
  `{contract, schemaVersion: 1, eventCount, events: [{id, type, rustVariant,
  fields: [{name, type, required, integer?}], backpressure, kindBackpressure?}],
  types: {struct|tagged}, enums: {values}}`）。
- 输出：`packages/shared-types/src/generated/engine/{events,types,parser,index}.ts`
  （确定性字节；幂等）。
- 校验：事件 id 顺序 1..n、number 字段必须声明 integer、引用类型存在性、
  backpressure ∈ {delta, soft, critical}、subagent-event 的 kindBackpressure
  全覆盖。
- 注册表 ↔ Rust enum 双向锁定由 `tests/registry_drift.rs` 保证。

**结论**：端间协议的所有事件侧能力已具备；协议层需要新增的是**设备域类型**
（配对/认证/信封/命令请求-响应），按同一「注册表 + 生成器」模式扩展
（第 12 章）。

---

## 3. 总体架构与拓扑

### 3.1 拓扑

```
┌──────────────────────────── 桌面（Tauri 主机，协议服务端）────────────────────────────┐
│                                                                                       │
│  engine (session-loop / orchestrator)                                                │
│      │  AgentEvent 41 变体                                                            │
│      ▼                                                                                │
│  workbench-run-event 事件桥 ──┬──> 桌面 WebView（既有 Tauri 事件通道）                  │
│                               └──> Device Relay Service（新增）                        │
│                                        │ WS 加密信道（TLS + 设备令牌 HMAC）            │
│  Device Registry（配对/设备表，新增）──┤                                               │
│  Command Adapter（跨端命令→Tauri 命令，新增）                                          │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                   LAN / 中继
                                        │
┌──────────────────────────── 移动端（crish-mobile，协议客户端）────────────────────────┐
│                                                                                       │
│  Device Client（配对/令牌/重连，新增）   │  Event Subscriber（游标/续传，新增）          │
│  Command Invoker（请求-响应/幂等，新增） │  UI（审批/终端/会话/任务面板）               │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **角色**：桌面是唯一的权威端（引擎、存储、审批状态机全在桌面）；移动端是
  纯控制面 + 展示面。这决定了协议的非对称性：事件/状态单向桌面→移动；命令/
  审批双向但**权威裁决永远在桌面**（approval-resolved 由桌面经
  `core_approve_tool` 落状态机后才广播）。
- **传输**：WebSocket（RFC 6455）+ JSON 文本帧，一帧一消息。与 Tauri 事件通道
  「字符串 JSON 载荷」形态一致，移动端解析器可复用生成器产出的
  `parseEngineEvent`（第 12 章）。
- **监听**：桌面默认监听回环 + 局域网（0.0.0.0，用户可配置仅回环）；TLS 首选
  （自签证书 + 配对期证书指纹交换，见 4.6 证书固定）；无 TLS 的降级模式必须
  显式开启（仅限同一可信局域网，日志告警）。
- **中继**：本协议为未来中继留位（第 4 章配对消息含 `relay` 可选字段），本期
  不实现。桌面绑定本地端口后经 UPnP/手动端口转发可被公网访问（鉴权由令牌保证，
  见第 5 章）。

### 3.2 协议分层

```
┌─────────────────────────────────────────────────────────────┐
│ L5 业务面   events / commands / approval / files / tasks    │  （复用既有 wire 形态）
├─────────────────────────────────────────────────────────────┤
│ L4 会话面   subscribe / resume / ack / heartbeat            │
├─────────────────────────────────────────────────────────────┤
│ L3 信封     DeviceEnvelope（v/kind/msgId/ts/auth/body）      │  ← 本协议新增
├─────────────────────────────────────────────────────────────┤
│ L2 安全     TLS（首选）+ 设备令牌 HMAC-SHA256 消息签名       │
├─────────────────────────────────────────────────────────────┤
│ L1 传输     WebSocket（JSON 文本帧）                         │
└─────────────────────────────────────────────────────────────┘
```

- L3 信封承载**所有**消息（包括握手期消息，握手期 auth 为配对令牌，见 5.2）。
- L5 业务载荷**原样透传**既有契约：事件 = `AgentEventEnvelope` 扁平 JSON；
  命令参数 = 对应 Tauri 命令的入参 JSON（camelCase）；审批 = 既有
  approve/deny 语义。

### 3.3 消息生命周期（一图）

```
移动端                          桌面
  │  hello（能力/版本协商）       │
  │─────────────────────────────>│
  │  hello.ok {protocolVersion}  │
  │<─────────────────────────────│
  │  subscribe {sessions, last}  │
  │─────────────────────────────>│
  │  events.push (每帧一事件)     │
  │<─────────────────────────────│
  │  events.ack {msgId}          │
  │─────────────────────────────>│
  │  cmd.approve {toolCallId...} │
  │─────────────────────────────>│
  │  cmd.result {ok, decision}   │
  │<─────────────────────────────│
  │  （断线）                    │
  │  hello（重连 + 令牌）         │
  │  events.resume {lastSeq...}  │
  │  ... 续传                    │
```

---

## 4. 配对协议（Pairing）

### 4.1 配对码格式

- **格式**：`CXN-XXXX-XXXX-XXXX`（3 组 × 4 字符，大写字母 + 数字，
  去除易混淆字符集 `0/O/1/I/L` 后的 base32 子集 30 字母数字
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`），示例 `CXN-7K4P-Q2MB-9XRT`。
- **熵**：有效字符池 32 字符（2^5），12 字符 → 60 bit 熵（防在线爆破；
  令牌才是长期凭据，码只用于一次性握手）。
- **人读回显**：`CXN-` 前缀用于人类识别「这是 crish 配对码」；分组 `-` 仅
  展示用途（输入时忽略分隔符与空白，大小写不敏感——标准化函数
  `normalize_pair_code()`：去 `CXN-` 前缀 → 去分隔符 → 大写）。
- **QR 码**：内容为统一格式字符串 `conex-pair://<code>?v=1&s=<desktopId短号>`
  （v=协议版本、s=桌面标识前 4 位，便于移动端确认配对目标）；扫码与手动输入
  走同一 `pair.verify` 消息。

### 4.2 配对流程状态机

桌面侧配对会话状态机（每码一个实例）：

```
      [Idle]
        │ 用户点击「添加设备」→ 生成码（码 + 哈希 + 截止时间）
        ▼
   [WaitingInput] ──过期(10min)──> [Expired] ──清理──> [Idle]
        │ 移动端 pair.hello {code, mobilePub}
        │   · 码哈希不匹配 → 失败计数+1（≤5 次/码）
        │   · 码已过期 → error.pair_expired
        ▼
    [KeyVerify] ──签名校验失败──> [Failed]（记录审计）──> [Idle]
        │ 桌面回 pair.challenge（随机挑战 + 桌面公钥）
        │ 移动端回 pair.verify（签名 = HMAC(派生密钥, 挑战)）
        ▼
    [Establishing] ──密钥派生失败──> [Failed]
        │ 双向派生成功 → 写入 Device Registry（deviceId + 公钥 + 令牌材料）
        ▼
     [Established] ──> 双端互发 device.ready → 移动端可正常会话
```

移动端配对流程（客户端状态机）：

```
[EnterCode] ──> [SendingHello] ──> [Verifying] ──> [Saving] ──> [Ready]
                │                     │              │
                └──pair_expired───────┴────pair_failed┴──> [Failed]（可重试）
```

### 4.3 配对码有效期与并发

| 属性 | 值 | 理由 |
|---|---|---|
| 有效期 | 10 分钟（`PAIR_CODE_TTL_MS = 600_000`） | 足够扫码/手动输入；短于入侵窗口 |
| 单码失败上限 | 5 次（`PAIR_MAX_ATTEMPTS = 5`） | 防在线爆破（60bit 熵 + 速率限制双保险） |
| 并发码 | 每桌面同时 ≤ 3 个活跃码（`PAIR_MAX_ACTIVE = 3`） | 防多码堆叠；过期/失败即回收 |
| 一次性 | 配对成功后码立即失效（删除哈希） | 防重放 |
| 码存储 | 桌面只存 `SHA-256(code + salt)`，**不存明文** | 泄漏配置目录也不泄露码 |
| 尝试限速 | 同 IP/同码 5 次/分钟 | 与失败上限叠加 |

配对期间移动端公钥、桌面挑战等中间态**不落库**（内存态），配对完成才写入
Device Registry（落库字段见 4.5）。配对失败的尝试记入安全审计
（复用 `security-audit` 事件形态？——**不**：配对审计属设备域，走桌面日志 +
可选 `device.audit` 消息，不进 agent 事件流，避免污染 41 变体注册表）。

### 4.4 密钥交换与令牌派生（两端各持什么）

采用 **X25519 ECDH + 配对码作共享口令（PAKE 式混合）**：

1. **移动端**：配对时生成一次性 X25519 密钥对 `(mpub, mpriv)`（仅用于本次
   配对）；同时生成**移动长期密钥对** `(Mpub, Mpriv)`（设备身份，撤销后更换）。
2. **桌面端**：每码生成**桌面长期密钥对** `(Dpub, Dpriv)`（桌面设备身份，
   首次启动生成，跨配对复用；重装后更换 = 全设备吊销语义）。
3. 配对码 `C` 经标准化后作为共享口令：
   - `psk = HKDF-SHA256(ikm = "pair" ∥ C, salt = desktopId ∥ mobilePub,
     info = "conex-pair-psk-v1", L = 32)`
   - 双方**独立且可验证地**计算 `psk`（移动端在 `pair.hello` 前已可算；
     桌面收到 hello 后算）。
4. ECDH 混合：
   - `ecdh = X25519(Dpriv, mpub)`（桌面侧）= `X25519(Mpriv, Dpub)`（移动侧）
   - `master = HKDF-SHA256(ikm = ecdh ∥ psk, salt = desktopId ∥ mobilePub ∥
     "v1", info = "conex-pair-master", L = 32)`
   - 配对码的 60bit 熵 + ECDH 的 256bit 前向安全 → 中间人即使同时看到码和
     PDU 也无法派生出 master（需要私钥）。
5. 从 `master` 派生三把子密钥（HKDF-SHA256 一次展开，info 区分）：
   - `token_key`（会话令牌的 HMAC 密钥材料，桌面与移动各持**同一份派生值**）
   - `enc_key`（预留：载荷加密 AES-256-GCM，本期 TLS 承载，密钥预派生留位）
   - `refresh_key`（重连令牌签名密钥）
   - 另派生 `verify_token = HMAC(token_key, "pair-verify" ∥ 挑战)` 用于
     `pair.verify` 消息。
6. **两端各持什么**（落盘）：

| 端 | 落盘内容 | 存储位置 |
|---|---|---|
| 桌面 | `desktopId`、`Dpriv`（长期）、设备表：`deviceId → {Mpub, status, pairedAt, lastSeen}`、`master 的桌面一半`（由码派生，存会话密封材料 `salt` 与派生上下文，不存码） | 桌面配置目录（权限 0600） |
| 移动 | `deviceId`（移动生成 UUID）、`Mpriv`（长期）、`master 派生出的 token_key/refresh_key`（即「会话令牌」，见下） | 移动安全存储（Keychain / Keystore） |

> **令牌派生结论**：桌面侧不落盘完整 `token_key` 明文亦可——桌面每次重连校验
> 令牌时用 `master` 重新派生；但为了校验效率，**桌面落盘 `token_key` 的
> HKDF 派生结果**（而非 master）。撤销 = 删除设备表条目（token_key 随之失效）。

### 4.5 Device Registry（桌面落库）

新增表（conex-db v6 迁移，见 12.4）：

```sql
CREATE TABLE IF NOT EXISTS device_registry (
    device_id   TEXT PRIMARY KEY,            -- 移动端生成的 UUID
    desktop_id  TEXT NOT NULL,               -- 桌面自身标识（防多桌面混淆）
    mobile_pub  TEXT NOT NULL,               -- X25519 公钥（base64）
    status      TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
    paired_at   TEXT NOT NULL,               -- ISO8601
    last_seen   TEXT,                        -- 最近活跃（心跳更新）
    token_key   TEXT NOT NULL,               -- token_key 派生值（base64，撤销即删）
    refresh_key TEXT NOT NULL,               -- refresh_key 派生值
    meta        TEXT NOT NULL DEFAULT '{}'   -- JSON：设备名/平台/版本
);
CREATE INDEX IF NOT EXISTS idx_device_registry_status ON device_registry(status);
```

### 4.6 证书固定（TLS 场景）

- 桌面自签证书（首次启动生成，`CN=conex-desktop:<desktopId>`），指纹
  SHA-256 随配对流程**经配对码信道的验证消息带外传递**（`pair.challenge`
  载荷含 `tlsFingerprint`）。
- 移动端首次连接时校验指纹；此后 TLS 层证书钉扎（只信该指纹），防局域网
  内 DNS 欺骗/MITM（即便攻击者知道配对码，无私钥仍无法派生 master）。

### 4.7 重新配对 / 撤销设备

- **移动端主动解除**：发送 `device.unlink`（携带 deviceId + 签名）；桌面删除
  设备表条目 + 广播 `device.revoked`（本设备令牌立即失效）。
- **桌面端撤销**：桌面 UI「设备管理」列表 → 撤销 = 删除 device_registry 行
  （token_key 删除 → 移动端下次 hello 校验失败 → `auth.device_revoked`）。
- **重新配对**：撤销后移动端仍保留本地凭据但标记 `unlinked`；再次配对走全新
  码流程（生成新 deviceId 或复用——建议**新 deviceId**，语义干净：一设备一
  配对一身份）。
- **桌面重装/更换**：`Dpriv` 丢失 = 全设备吊销；移动端重连收到
  `auth.unknown_desktop` → 提示用户重新配对。`desktopId` 变化时移动端清空
  本地凭据。
- **并发配对**：同一码并发 `pair.hello`（两台移动端用同一码）→ 桌面仅接受
  第一个完成 `pair.verify` 的（码一次性），第二个收到 `pair_already_used`。

### 4.8 配对消息序列（时序图）

```
移动端                               桌面
  │ 1. pair.hello {code, mobilePub,  │
  │    deviceId, deviceName}         │
  │ ───────────────────────────────> │ 校验：码存在/未过期/失败计数
  │                                  │
  │ 2. pair.challenge {challenge,    │ 生成 32B 随机挑战
  │    desktopPub, tlsFingerprint,   │
  │    desktopId}                    │
  │ <─────────────────────────────── │
  │ 3. 移动端计算 psk → ecdh → master│
  │    → token_key；verify = HMAC    │
  │    (token_key, "pair-verify" ∥   │
  │    challenge)                    │
  │ 4. pair.verify {challengeSig,    │ 桌面侧同源派生 → 校验签名
  │    devicePubSig?}                │
  │ ───────────────────────────────> │ 命中 → 写 device_registry
  │                                  │ → 码作废
  │ 5. pair.ok {desktopId, ttl}      │
  │ <─────────────────────────────── │
  │ 6. device.ready {deviceId}       │
  │ <─────────────────────────────── │
  │ 7. 双向 hello（标准会话握手）      │
```

（消息 schema 见 11.3；`pair.verify` 中 `devicePubSig` 为移动长期公钥自签，
用于绑定「本次配对的公钥 = 以后设备凭据公钥」，防配对中公钥替换。）

---

## 5. 认证与消息信封（Authentication & Envelope）

### 5.1 鉴权模型

- **设备令牌（device token）**：配对派生 `token_key` 的唯一作用就是**给每个
  消息算 HMAC 签名**（消息级鉴权 + 完整性 + 防重放）。无 JWT、无长串 token
  明文传输——签名即凭据。
- **每条消息的鉴权字段**（L3 信封 `auth` 对象）：

```json
{
  "auth": {
    "deviceId": "7f0a...",
    "ts": 1754651200000,          // epoch ms，发送方时钟
    "nonce": "随机16字节base64",   // 防重放：桌面滑动窗口 + 最近 nonce 集合
    "sig": "HMAC-SHA256(token_key, canon(header) ∥ bodyJson)"
  }
}
```

- **签名输入规范化** `canon(header)`：`deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v`
  （定长字段拼接，防字段重排攻击）；随后拼接 `body` 的**原始 JSON 字节**
  （接收端对收到字节做序列化前签名校验——要求发送端先算签后发，
  接收端原字节重算）。
- **重放防护**：桌面维护 per-device 时间窗（±5 分钟）+ 已见 nonce LRU
  （每设备 4096 条）；ts 超窗或 nonce 重见 → `auth.stale` 错误。
- **重连令牌（refresh）**：会话断开超过心跳阈值（60s）后重连，用
  `refresh_key` 派生的一次性 refresh token 换取新会话（`auth.refresh` 消息，
  载荷 = `HMAC(refresh_key, desktopId ∥ ts ∥ nonce)`）；refresh token 一次性
  使用、桌面记录最后使用时间（被盗检测）。
- **签名密钥轮换**：长连接下每 24h 桌面广播 `auth.rotate`（新 nonce 种子），
  移动端更新签名上下文（token_key 不变，只换 nonce 基数）——避免长期同
  上下文被流量分析。

### 5.2 握手期 vs 会话期

| 阶段 | auth 字段 | 说明 |
|---|---|---|
| 配对期（pair.*） | 无（或 `pairSig` = HMAC(psk, 载荷)） | 码是唯一秘密；挑战-响应已覆盖 |
| 握手期（hello/hello.ok） | `auth.sig = HMAC(token_key, ...)` | 配对后首个签名消息 |
| 会话期（全部业务消息） | `auth.sig` | 常态 |

`hello` 校验失败分类：`auth.bad_signature`（签名错）、`auth.device_revoked`
（设备表无此 deviceId 或 status=revoked）、`auth.expired`（refresh 过期）、
`auth.unknown_desktop`（desktopId 不匹配）。

### 5.3 消息信封（DeviceEnvelope）

所有消息统一外层（JSON schema 见 11.1）：

```json
{
  "v": 1,
  "kind": "events.push",
  "msgId": "m-01HZ...",        // 发送方唯一（UUID v4 或 计数+随机）
  "ts": 1754651200000,
  "from": "mobile",
  "to": "desktop",
  "auth": { "deviceId": "...", "ts": 1754651200000, "nonce": "...", "sig": "..." },
  "body": { ... }
}
```

- `kind` 命名空间：`pair.*`（配对）、`auth.*`（认证/轮换）、`device.*`（设备
  管理）、`events.*`（订阅/推送/续传）、`cmd.*`（命令请求）、`result.*`
  （命令响应）、`stream.*`（流控制）、`file.*`（文件浏览，可并入 cmd）、
  `heartbeat`（心跳）、`error`（错误通知）。
- `msgId`：请求-响应关联键（`result.*` 与 `error` 必带 `reqMsgId`）；发送方
  保证唯一；响应侧回显。
- `from/to`：`desktop` / `mobile` 字面量 + 信封不依赖它做鉴权（鉴权靠 sig）。

### 5.4 请求-响应与错误

- **响应**：`cmd.result {reqMsgId, ok, result?, error?}`；result 为对应 Tauri
  命令的返回 JSON（camelCase），error 为跨端错误对象（第 6 章）。
- **推送类消息无响应**（events.push / heartbeat / device.* 广播）。
- **命令超时**：移动端默认 30s（可配）；超时后移动端可重发（`idempotencyKey`
  = msgId 不变重发；桌面按 `reqMsgId` 去重，已处理则回显缓存结果）——
  幂等键策略见 8.5。
- **错误上报**：桌面处理失败以 `error {reqMsgId, code, message, retryable}`
  返回；推送路径失败（无 reqMsgId）记日志 + 断链重连兜底。

### 5.5 载荷大小与分帧

- 单帧 ≤ 1 MiB（`MAX_FRAME_BYTES = 1_048_576`）；事件 push 单事件一帧；
  超大载荷（如 message-end 全文 + 历史回放批量）走 `stream.*` 分块（第 9 章）。
- 接收端超限 → `error.code = frame_too_large` + 断链（防内存放大）。

---

## 6. 错误码体系

### 6.1 分层错误码

错误码为**字符串枚举**（人类可读、可映射、可扩展），三段命名：
`<域>.<子类>`，如 `cmd.not_found`。与桌面 `CoreError {kind, detail}`
（InvalidInput/Encoding/Io/NotFound/Cancelled/Internal）的映射见 6.3。

### 6.2 错误码全表

| code | 含义 | retryable | 触发方 |
|---|---|---|---|
| `pair.invalid_code` | 配对码格式非法（标准化失败） | 否 | 桌面 |
| `pair.expired` | 码已过期 | 否（重新生成） | 桌面 |
| `pair.used` | 码已被使用（一次性） | 否 | 桌面 |
| `pair.too_many_attempts` | 失败次数超限 / 限速 | 否（冷却 5min） | 桌面 |
| `pair.challenge_mismatch` | pair.verify 签名不匹配 | 否 | 桌面 |
| `pair.no_challenge` | 无对应挑战（乱序/重放） | 否 | 桌面 |
| `pair.registry_full` | 设备数超上限（默认 8） | 否 | 桌面 |
| `auth.bad_signature` | HMAC 校验失败 | 否 | 桌面 |
| `auth.device_revoked` | 设备已撤销 | 否（重新配对） | 桌面 |
| `auth.unknown_device` | deviceId 不在注册表 | 否（重新配对） | 桌面 |
| `auth.unknown_desktop` | desktopId 不匹配 | 否（重新配对） | 桌面 |
| `auth.expired` | refresh 令牌过期/已用 | 是（重新 refresh） | 桌面 |
| `auth.stale` | ts 出窗 / nonce 重放 | 是（重发） | 桌面 |
| `auth.rotate_conflict` | 轮换 nonce 冲突 | 是（用新 nonce） | 移动端 |
| `cmd.invalid` | 参数非法（→ CoreError::InvalidInput） | 否 | 桌面 |
| `cmd.not_found` | 目标不存在（run/session/工具调用，→ NotFound） | 否 | 桌面 |
| `cmd.engine_not_ready` | 引擎未就绪（→ Internal(engine not ready)） | 是 | 桌面 |
| `cmd.restore_in_progress` | 恢复中拒绝 run（→ Internal(restore)） | 是 | 桌面 |
| `cmd.session_busy` | 会话串行守卫命中（已有活动 run） | 是 | 桌面 |
| `cmd.approval_mismatch` | tool_call_id 不在待审批集合（I-02） | 否 | 桌面 |
| `cmd.denied` | 命令被安全策略拒绝（gatekeeper Blocked） | 否 | 桌面 |
| `cmd.requires_approval` | 命令需先审批（gatekeeper RequiresApproval） | 否 | 桌面 |
| `cmd.unknown` | 命令不在 manifest / 未注册 | 否 | 桌面 |
| `cmd.timeout` | 移动端本地超时 | 是 | 移动端 |
| `cmd.cancelled` | 请求被取消（→ CoreError::Cancelled） | 否 | 双方 |
| `stream.not_subscribed` | 未订阅会话即请求续传 | 否 | 桌面 |
| `stream.cursor_invalid` | 游标非法（负值/超限） | 否 | 桌面 |
| `stream.too_many_subscriptions` | 订阅会话数超限（默认 32） | 否 | 桌面 |
| `file.not_found` | 文件不存在（→ NotFound） | 否 | 桌面 |
| `file.not_granted` | 路径越出授权工作区（→ InvalidInput 含 workspace_not_granted） | 否 | 桌面 |
| `file.too_large` | 读取超上限 | 否 | 桌面 |
| `frame_too_large` | 帧超 1 MiB | 否 | 双方 |
| `transport.closed` | 连接被对方关闭（对端错误后通知） | 是 | 双方 |
| `internal` | 未分类内部错误（→ CoreError::Internal） | 是 | 双方 |

### 6.3 与 CoreError / CrishError 的映射

跨端错误对象统一：

```json
{ "code": "cmd.invalid", "message": "参数校验失败：...", "retryable": false, "detail": {} }
```

- 桌面 Command Adapter 把 Tauri 命令错误（`CoreError {kind, detail}`）映射：
  `InvalidInput → cmd.invalid / file.not_granted`（detail 含
  `workspace_not_granted` 时）、`NotFound → cmd.not_found / file.not_found`、
  `Cancelled → cmd.cancelled`、`Encoding/Io/Internal → cmd.invalid / internal`。
- 77 码 `CrishErrorPayload`（`codes` 常量集）只在桌面日志与
  `core_get_status.lastError` 保留；跨端**不透传**内部码（防协议面泄漏实现
  细节），仅在 `detail.kind` 记录原 kind 供诊断。
- 前端既有 `error.kind` 分类习惯（CoreError tagged enum）在移动端保持：
  跨端 code 与前端 kind 的映射表由生成器产物 `device/errors.ts` 固化（12.5）。

---

## 7. 事件协议（Event Protocol）

### 7.1 总原则：原样透传 + 外层承载

- 跨端事件载荷 = **`AgentEventEnvelope` 的扁平 JSON**（与桌面 Tauri 事件通道
  `workbench-run-event` 发射的载荷逐字节同构，core_event_bridge.rs:6-9）。
- 移动端**不解析事件体**，只做：`type` 分发 → 校验 `sessionId` → 按
  `sequence` 记账去重 → 渲染（复用生成器 `parseEngineEvent`，12.5）。
- 跨端新增语义（订阅关系、游标、ack）全部放 L3 信封与 `events.*` 会话面消息，
  不触碰事件体。

### 7.2 41 变体逐项清单（wire 形态 / 背压 / 跨端策略）

下表为全量登记（编号 = 注册表 id，字段 = events.rs 确认）。`runId`/`sequence`/
`schemaVersion` 为信封注入（events.rs:10-12 语义），不再重复列于事件字段。

| # | type | 事件字段（camelCase） | 背压 | 跨端策略 |
|---|---|---|---|---|
| 1 | agent-start | sessionId, timestamp | Critical | 直推 + 会话状态机锚点 |
| 2 | agent-end | sessionId, timestamp, reason(stop/max-turns/aborted/error/stopped), error? | Critical | 直推；reason 驱动移动端 run 状态 |
| 3 | turn-start | sessionId, turnIndex, timestamp | Critical | 直推 |
| 4 | turn-end | sessionId, turnIndex, timestamp, toolCallCount | Critical | 直推 |
| 5 | message-start | sessionId, message: AgentMessage | Critical | 直推（水合投影以 message-end 为准） |
| 6 | message-delta | sessionId, timestamp, messageId, block: AgentMessageBlock | Delta | 可丢：断线期间不补发（移动端以 message-end 重建） |
| 7 | message-end | sessionId, message, turnIndex? | Critical | 必达；续传窗口必须覆盖 |
| 8 | tool-start | sessionId, batchId, call: ToolBatchCall, timestamp | Critical | 直推 |
| 9 | tool-update | sessionId, batchId, toolCallId, update: ToolProgressUpdate, timestamp | Critical | 直推（预留增量参数流） |
| 10 | tool-end | sessionId, batchId, result: ToolBatchResult, timestamp | Critical | 直推 |
| 11 | tool-batch-start | sessionId, batchId, timestamp, summary, calls[] | Critical | 直推 |
| 12 | tool-batch-end | sessionId, batchId, timestamp, calls[] | Critical | 直推 |
| 13 | tool-input-repaired | sessionId, timestamp, toolCallId, toolName, notes[] | Critical | 直推 |
| 14 | context-compression-start | sessionId, timestamp, reason, tokensBefore | Critical | 直推 |
| 15 | context-compression-end | sessionId, timestamp, result?, aborted, error? | Critical | 直推 |
| 16 | provider-diagnostic | sessionId, timestamp, diagnostic: ProviderDiagnostic | Critical | 直推（移动端仅日志） |
| 17 | runtime-error | sessionId, timestamp, error, retryable? | Critical | 直推 |
| 18 | runtime-steering | sessionId, timestamp, reason, message: AgentMessage | Critical | 直推 |
| 19 | runtime-intervention-required | sessionId, timestamp, reason, choices[], message | Critical | 必达；移动端渲染候选动作 |
| 20 | approval-requested | sessionId, request: PermissionRequest, timestamp | Critical | 必达；移动端审批弹窗输入（见 8.2） |
| 21 | approval-resolved | sessionId, toolCallId, requestId?, decision(approved/denied/expired), timestamp | Critical | 直推（回显决策） |
| 22 | checkpoint-created | sessionId, timestamp, checkpoint: RuntimeCheckpointRecord | Critical | 直推 |
| 23 | checkpoint-restored | sessionId, timestamp, restore: RuntimeCheckpointRestoreRecord | Critical | 直推 |
| 24 | run-terminal | sessionId, runId, timestamp, terminal(completed/cancelled/failed), error? | Critical | 必达；run 终态唯一事件（移动端状态收口） |
| 25 | cache-stats-updated | sessionId, timestamp, stats: RunCacheStats | Critical | 直推（仅展示） |
| 26 | cache-waste-alert | sessionId, timestamp, attribution, missedTokens, idleMs, modelChanged, missedCostUsd? | Critical | 直推（仅展示） |
| 27 | cold-cache-warning | sessionId, timestamp, ttlSeconds, idleMs, resendEstimateTokens | Critical | 直推（仅展示） |
| 28 | security-audit | sessionId, timestamp, operation, targets[], impact, decision, permissionMode?, toolCallId? | Critical | 必达；移动端审计/删除接管弹窗 |
| 29 | subagent-started | sessionId, subagentId, subagentRunId, role, capabilityMode, startedAt, description?, mode?, parentToolCallId? | Critical | 直推 |
| 30 | subagent-event | sessionId, subagentId, subagentRunId, event{kind(progress/message/tool), payload?} | Delta/Soft（按 kind） | progress 可丢；message/tool 尽力（断线窗口内补） |
| 31 | subagent-ended | sessionId, subagentId, subagentRunId, status(completed/failed/cancelled), summary?, endedAt | Critical | 直推 |
| 32 | task-started | sessionId, taskId, command, cwd, ownerRunId, isDaemon | Critical | 必达；移动端任务面板 |
| 33 | task-output | sessionId, taskId, line?, chunk?, lineCount? | Delta | 可丢；断线后经 workbench_get_background_task_output 补取 |
| 34 | task-heartbeat | sessionId, taskId, resource: JsonValue | Delta | 可丢 |
| 35 | task-suspicious | sessionId, taskId, silenceMs, lastOutputAtMs | Soft | 尽力投递 |
| 36 | task-completed | sessionId, taskId, exitCode, durationMs, lineCount | Critical | 必达 |
| 37 | task-failed | sessionId, taskId, exitCode, tail[], durationMs | Critical | 必达 |
| 38 | task-killed | sessionId, taskId, viaForce, diagnostics? | Critical | 必达 |
| 39 | timer-fired | sessionId, timerId, prompt, firedAtMs | Critical | 必达（数据面；唤醒走 steering） |
| 40 | timer-cancelled | sessionId, timerId, reason, cancelledAtMs | Soft | 尽力投递 |
| 41 | cron-fired | sessionId, cronId, prompt, expression, iteration, firedAtMs | Critical | 必达（数据面） |

> 跨端策略的「必达/尽力/可丢」直接继承 `event_backpressure()`（events.rs:867-893）
> 与注册表 backpressure 字段——**跨端链路不做第二套分级**，只做实现差异：
> Delta 断线丢弃、Soft 断线窗口内补发、Critical 断线必补（游标续传天然覆盖）。

### 7.3 订阅模型

- **按会话订阅为主**：`events.subscribe {sessions: [sessionId...], lastSequences:
  {sessionId → sequence}}`。桌面为每个订阅会话维护下行窗口（内存环形缓冲，
  容量 4096 事件/会话，`EVENT_WINDOW = 4096`）。
- **全局轻订阅**：`events.subscribeAll {events: [type 白名单]}`——仅推送
  桌面广播的会话无关/低频事件（security-audit、device.*、timer/cron 数据面、
  新会话通知 `session.updated`），防止移动端盲扫全量。
- 订阅上限：32 会话 / 设备（`MAX_SUBSCRIPTIONS = 32`）；超出 →
  `stream.too_many_subscriptions`。
- **投递模型**：
  - 实时帧：桌面经设备信道逐帧 push（对应 Tauri 事件通道的实时预览语义）；
  - 持久化帧：push 同时携带 `sequence`（收口流已带）；移动端以 sequence
    记账，`events.push` 的 `sequence` 与 `msgId` 双键去重；
  - `events.ack {msgId}`：移动端确认接收（**仅对 Critical 事件可选 ack**；
    默认不 ack——续传游标已覆盖可靠性，ack 仅用于诊断/调试模式，防 ack
    风暴）。协议提供开关：subscribe 时 `ackMode: "none" | "critical"`。
- **无订阅会话的事件**：桌面丢弃（不缓冲不补发）——移动端重新订阅时以
  `events.resume` 拉历史，实时性由窗口保证。

### 7.4 事件 id / 序列号语义

- **事件序列号 = (sessionId, sequence)**：conex-db 会话级单调序列
  （T08.12 Q23：跨 run 不重置、并发 run 唯一），是**去重 + 游标 + 续传锚点
  的唯一依据**（03 §5.1-2/3，events.rs:905-933）。
- 实时预览帧（审批门广播 sequence=None）跨端时**补记占位**：桌面 Device
  Relay 对该会话最近已知 sequence 打 `preview: true` 标记；移动端对 preview
  帧不推进游标（它不落库，续传后由持久化副本覆盖）。
- 游标推进规则：移动端仅以 `sequence` 单调递增且**已持久化**（非 preview）
  的帧推进 `lastSequence`；乱序帧（WebSocket 保序下罕见）缓冲按序应用。

### 7.5 断线续传（last_sequence 游标）

1. 移动端本地持久化 `(deviceId, sessionId, lastSequence)`（移动端 SQLite）。
2. 断线重连 → `hello`（refresh 重认证）→ `events.subscribe`（携带
   `lastSequences`）。
3. 桌面比对窗口：`lastSequence + 1 ≤ 会话当前 max` 且在窗口内 →
   走 `events.resume` 拉历史；拉取实现 = **复用 `core_read_session_events`
   的 EventPage 契约**（`afterSequence` 分页，`{events, nextAfterSequence,
   hasMore}` 逐页，pageSize 缺省 200、上限 1000）——跨端不新造分页协议。
4. 游标落后超过窗口（4096）→ `stream.cursor_stale` 提示移动端走全量
   `core_read_session_events` 逐页回放（仍同契约）。
5. Delta 事件（message-delta / task-output / subagent progress）不在续传
   范围：续传后移动端以 message-end / 任务输出补取命令重建增量态
   （与桌面 Tauri 事件流「delta 不落库」语义一致，orchestrator events.rs:180-187）。
6. 续传完成 → `events.resume.done {sessionId, resumedTo: sequence}` → 桌面
   恢复实时推流。

### 7.6 事件流与既有 Tauri 事件通道的接线

- Device Relay Service 订阅的**不是** Tauri 事件通道字符串，而是引擎 emit 层
  的同一 `Emitter` 抽象（core_event_bridge.rs:51-54）——桌面侧把
  `BufferedRunEventBridge` 的 flush 出口接 `TauriEmitter` 与
  `DeviceEmitter` 两个 sink（扇出 1:2），保证桌面 UI 与移动端看到的是
  **同一份序列化字节**（同 `EventBridge::serialize`）。
- 审计落库 worker（L4，core_run_commands.rs:500-522）与
  `TaskEventConsumer`（后台任务事件消费）的事件同样经扇出点到达移动端，
  无需改造。

---

## 8. 命令协议（Command Protocol）

### 8.1 设计原则

- 移动端命令 = **Tauri 命令面的子集镜像**：只允许 surface=engine 的命令
  （command_manifest.rs:34-35 语义：engine = 三端共用契约面），且移动端 UI
  只映射下述清单。`core_list_commands` 是能力真源：移动端握手后拉取，
  本地缓存，manifest `contractVersion` 变化时提示刷新。
- 请求-响应：`cmd.<name> → result.<name>`；请求带 `reqMsgId` + 幂等键；
  响应携带 Tauri 命令的原始返回 JSON。
- **移动端不经手 run 装配细节**：`core_run_task` 的 runId 由桌面生成
  （桌面 `start_run` 内部），移动端只传会话/消息参数——runId 语义与桌面
  前端完全一致。

### 8.2 移动端动作 → 命令映射（审批 / 终端 / 暂停恢复 / 查看文件）

| 移动端动作 | 命令消息 kind | 对应 Tauri 命令 | 参数（camelCase） | 响应 |
|---|---|---|---|---|
| 审批通过 | `cmd.approve` | core_approve_tool | {toolCallId} | {ok, toolCallId, decision} |
| 审批拒绝 | `cmd.deny` | core_deny_tool | {toolCallId, reason?} | {ok, toolCallId, decision} |
| 终端输入（后台任务） | `cmd.sendInput` | workbench_send_input | {taskId, input, enter?} | {ok} |
| 暂停 run（L2 协作停） | `cmd.runControl` | core_run_control | {level: cooperative_stop, runId, sessionId, reason?} | {ok} |
| 恢复 run（L0 继续） | `cmd.runControl` | core_run_control | {level: continue, runId, sessionId, payload?} | {ok} |
| 软注入消息（L1） | `cmd.runControl` | core_run_control | {level: soft_inject, runId, sessionId, payload: {text}} | {ok} |
| 强制停止（L3） | `cmd.cancelRun` | core_cancel_run | {runId, reason?} | {ok, runId} |
| 发送消息（发起 run） | `cmd.runTask` | core_run_task | {runId?, sessionId, prompt, mode?, cwd?, permissionMode?, history?, clientMessageId?} | {runId, sessionId} |
| 查看文件 | `cmd.readFile` | workbench_read_file_content | {path, maxBytes?, workspaceRoot?} | {content, truncated} |
| 列目录 | `cmd.listDir` | workbench_list_directory | {path, workspaceRoot?} | {entries} |
| 查看 run 状态 | `cmd.getRunSnapshot` | core_get_run_snapshot | {runId, sessionId?} | {snapshot} |
| 拉历史事件 | `cmd.readSessionEvents` | core_read_session_events | {sessionId, afterSequence?, maxEvents?} | {events, nextAfterSequence, hasMore} |
| 任务列表 | `cmd.listTasks` | workbench_list_background_tasks | {} | {tasks} |
| 任务输出 | `cmd.getTaskOutput` | workbench_get_background_task_output | {taskId, maxLines?} | {lines} |

> 说明：
> - 审批入口语义与桌面完全一致（core_run_commands.rs:226-258）：tool_call_id
>   必须 ∈ 待审批集合，否则 `cmd.approval_mismatch`（I-02 伪造审计防护）；
>   决策送达后桌面广播 approval-resolved（第 7 章 21 号事件）。
> - `core_run_control` 的 L0-L3 语义对齐 run-control.ts 的
>   `RunControlIntent`（level/reason/runId/sessionId/payload）——跨端参数
>   直接复用该 TS 类型（12.3 复用清单）。
> - `cmd.runTask` 参数 ⊆ `RunTaskOptions` 的公开子集（runId 可选：移动端
>   省略时桌面生成；`history` 移动端一般省略——桌面 SessionHistoryCache
>   兜底，core_run_commands.rs:564-654）。
> - `permissionMode` 缺省 ask（审批启用）；full-access 由桌面侧用户设置，
>   移动端不可改（安全边界）。

### 8.3 安全边界（移动端可调命令白名单）

- Device Registry 每设备存 `allowedCommands: string[]`（默认 = 8.2 清单）；
  桌面 Command Adapter 对**非白名单命令一律拒绝**（`cmd.denied`），无论移动端
  是否拉过 manifest。
- `core_check_command` 可作为审批前置预览（移动端 UI 展示「此命令需审批」），
  但**不是安全判定**——真实判定永远在引擎（gatekeeper / 审批门）。
- `surface=gui` 命令（workbench_run_shell / workbench_pty_* 等）**禁止移动端
  调用**：终端交互面只允许 workbench_send_input（且仅限任务），防移动端
  绕过桌面 UI 直接执行任意命令。

### 8.4 命令执行路径（桌面侧）

```
cmd.approve ──> Device Relay 鉴权（签名/白名单）──> Command Adapter
   └─> 解析为 Tauri 命令调用（tokio::spawn + async）
        └─> Result 序列化（CoreError → 跨端错误码，6.3）
   └─> result.approve {reqMsgId, ok, ...}
```

- Command Adapter 为**新增 Tauri 壳内模块**（12.4）：把跨端命令参数 JSON 映射
  为对应 Tauri 命令的 Rust 参数（serde 反序列化，字段 camelCase 天然一致）。
- 命令执行结果不做缓存（幂等重发例外，8.5）；大响应走 `stream.*` 分块
  （9.2）。

### 8.5 幂等与重试

| 场景 | 策略 |
|---|---|
| 移动端超时重发 | 同 `reqMsgId` 重发；桌面以 `reqMsgId` 键控（TTL 5min 结果缓存），已处理回显缓存响应 |
| 命令天然幂等 | core_approve_tool/deny：第二次命中 → `cmd.approval_mismatch`（I-02 语义，不改状态机） |
| run 控制幂等 | `cooperative_stop` 重复 = 无副作用（ControlBus 幂等）；L3 重复 abort = 无副作用 |
| 会话串行 | `cmd.runTask` 同会话并发 → `cmd.session_busy`（桌面串行守卫，core_run_commands.rs:3082-3090） |
| 断线重试 | 移动端仅在 `auth.*` 错误后自动重试；业务错误不自动重发（防双执行） |

---

## 9. 流协议（Stream Protocol）

### 9.1 流式传输模型

跨端需要流式的有三类数据：**事件推流**（events.push）、**终端/任务输出**
（task-output 事件 → 移动端终端 UI）、**大响应分块**（文件内容、历史回放）。
统一原则：**流 = 有序分块序列 + 终帧标记 + 心跳保活**，不引入独立帧格式之外
的协议（复用 L3 信封，kind 区分）。

- 事件推流：每帧一个事件（`events.push`），天然有序（WebSocket 保序）；
  无终帧概念（会话终态 = run-terminal 事件）。
- 大响应分块：`stream.chunk {streamId, seq, data: base64?, final, nextOffset}`
  （data 为原始文本块时非 base64，UTF-8；块 ≤ 64 KiB）。
- 终端输出：移动端订阅会话后，task-output 事件即终端流；高频输出由桌面
  转发器**节流 60ms** 合并（对齐既有 task-output 转发器节流语义，
  events.rs:649-665 注释），移动端无需再做聚合。

### 9.2 分块协议

- `stream.open {streamId, kind, totalBytes?, meta}` → `stream.chunk ...`（seq
  从 1 起）→ `stream.close {streamId, ok, error?}`。
- 断点续传：移动端断线重连后按 `lastChunkSeq + 1` 请求
  `stream.resume {streamId, offset}`（服务端按字节 offset 重发；块级幂等：
  移动端以 seq 去重）。
- 上限：单流 ≤ 256 MiB、单连接并发流 ≤ 8（`MAX_STREAMS = 8`）。

### 9.3 心跳与保活

- 应用级心跳 `heartbeat {ts, deviceTimeMs}`：移动端每 30s 发；
  桌面每 60s 回 `heartbeat.ok`。双方 3×间隔未收到 → 判定断线（移动端发起
  重连）。
- WS 层 ping/pong 由客户端库兜底；应用心跳承载**设备活性**（更新
  device_registry.last_seen，4.5）与**时钟偏移校准**（移动端计算
  `clockOffset = serverTime - clientTime`，用于 auth.ts 窗口校验的本地预判）。

### 9.4 背压

- 桌面 → 移动端：下行窗口（`EVENT_WINDOW = 4096`/会话）+ 背压分级：
  - Delta（message-delta、task-output、task-heartbeat、subagent progress）：
    移动端消费慢时**丢弃**（对齐 buffer.rs 丢帧语义，core_event_bridge
    EmitReport.dropped 语义同构）；
  - Soft（subagent message/tool、task-suspicious、timer-cancelled）：尽力；
    窗口溢出时先丢 Delta 再丢 Soft；
  - Critical（其余）：窗口只进不出时暂停推流，反压引擎 emit 链
    （BufferedRunEventBridge 已具背压缓冲，DeviceEmitter 侧加「下游慢」信号
    回传丢帧报告，桌面日志记录 EmitReport）。
- 移动端 → 桌面：命令请求天然低频；`cmd.sendInput` 连续输入节流
  （≥100ms/次），超频返回 `cmd.invalid`。

### 9.5 终端会话映射（pty 与任务的差异）

- 桌面 `workbench_pty_*`（gui 面）**不跨端暴露**；移动端终端 = 后台任务
  （task-* 事件族）+ `cmd.sendInput`（8.2）。任务无活动 pty 时移动端渲染
  task-output 追加视图；有 pty（桌面侧打开的交互进程）时移动端只读。
- `workbench_get_background_task_output` 的 `tail` 语义与 task-failed 的
  `tail`（最后 20 行，events.rs:706-712）对齐，移动端断线补取一致性有保证。

---

## 10. 版本化（Versioning）

### 10.1 版本面划分（三个正交版本）

| 版本面 | 标识 | 当前值 | 演进载体 | 兼容规则 |
|---|---|---|---|---|
| 跨端协议 | `DeviceEnvelope.v` + `hello.protocolVersion` | 1 | 本协议（D3） | 主版本协商；次版本只加可选字段 |
| 事件信封 | `schemaVersion`（信封字段） | 1（EVENT_ENVELOPE_SCHEMA_VERSION） | 33-event-schema-changelog.md | 缺省=1；minor 加可选字段；major 删改字段 |
| 命令清单 | `COMMAND_MANIFEST_CONTRACT_VERSION` | "1.0.0" | command_manifest.rs + 前端镜像 | semver：major=破坏性（删命令/改参数） |

- 三者独立推进：事件 schema 演进不影响协议 v；协议加能力（新 kind）不 bump
  事件 schemaVersion；命令新增条目不 bump 协议版本（移动端按 manifest 发现）。

### 10.2 协议版本协商（hello）

- `hello {protocolVersions: [1], capabilities: {...}, appVersion, platform}`：
  移动端声明支持版本区间；桌面回 `hello.ok {protocolVersion: 1, minProtocolVersion: 1, manifest: {...}, desktopId, serverTime}`。
- 协商规则：
  - 移动端取 `min(客户端最高, 桌面支持最高)`；若交集为空 →
    `error {code: "version_mismatch", detail: {client: [1], server: [1,2]}}`
    + 提示升级；
  - `hello.ok.capabilities`：桌面声明能力位（`streams`, `fileRead`,
    `taskInput`, `cron`, `timer`, `subagent`...），移动端按位裁剪 UI；
  - 会话期禁止换版本（换版本 = 重连）。
- 能力位命名：`device.protocol.capabilities` 注册表（12.5 生成器产物固化
  字面量联合）。

### 10.3 字段演进规则（兼容 / 破坏性变更流程）

兼容变更（仅允许此三类，落 `docs/multi-device/33-device-schema-changelog.md` 登记）：

1. **新增可选字段**：`body` 内加 `?` 字段；旧端忽略未知字段（解析器宽容，
   与 `AgentEventEnvelope` 旧帧容忍一致，events.rs:979-984）。
2. **新增 kind**：新 kind 是新增消息类型，不影响旧 kind；
   但**新 kind 的使用必须先经能力协商**（10.2），旧端收到未知 kind 丢弃 +
   记日志（不报错）。
3. **枚举加值**：只加不改名不改义（与 ApprovalDecision 演进惯例一致）。

破坏性变更（必须 bump 主版本并双版本并存窗口 ≥ 一个发布周期）：

1. 删除/改名 kind 或必填字段；
2. 改字段语义（如 sequence 从 u64 改 i64）；
3. 改鉴权方案（HMAC 算法、canon 输入）；
4. 改配对密码学（X25519 → 其他曲线）。

流程：登记 changelog → 双版本共存（服务端按 hello 协商分支实现）→ 旧版本
支持期过后下线（同 33-event-schema-changelog.md 的 minor/major 登记纪律）。

### 10.4 与事件 schemaVersion 的关系

- 事件字段演进（新增事件体字段）由 `schemaVersion` 承载：缺省 1；旧帧无
  字段照常解析（Option + serde 缺省，见 PermissionRequest 扩展先例
  events.rs:207-217）。跨端协议**不过问**事件体字段——移动端把未知事件体
  字段当扩展点（生成器 parser 对 `parseEngineEvent` 之外的字段宽容）。
- 事件新增变体（如未来第 42 个事件）只 bump 注册表（registry_drift 锁），
  协议不变；移动端旧版本对未知 `type` 的帧：保留渲染为「未知事件」摘要卡，
  不崩溃（parser 默认分支 parseErr → UI 兜底）。

---

## 11. JSON Schema 定义（完整）

约定：draft 2020-12；全部字段 camelCase；`$defs` 复用；UTF-8 无 BOM；
`additionalProperties` 默认 false（协议内），但**事件体容器**为 true
（宽容未知事件字段）。

### 11.1 DeviceEnvelope（外层信封）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.envelope.v1",
  "title": "DeviceEnvelope",
  "description": "跨端协议外层信封：所有消息统一包装（L3 层）",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "kind", "msgId", "ts", "from", "to", "auth", "body"],
  "properties": {
    "v": {
      "type": "integer",
      "const": 1,
      "description": "协议主版本（协商后固定）"
    },
    "kind": {
      "type": "string",
      "pattern": "^(pair|auth|device|events|cmd|result|stream|file|heartbeat|error)\\.[a-z][a-zA-Z0-9]*$",
      "description": "消息类别，命名空间限定"
    },
    "msgId": {
      "type": "string",
      "minLength": 8,
      "maxLength": 64,
      "description": "发送方唯一消息 id（幂等键与请求-响应关联键）"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "发送方时钟 epoch ms"
    },
    "from": { "enum": ["desktop", "mobile"] },
    "to": { "enum": ["desktop", "mobile"] },
    "auth": { "$ref": "#/$defs/AuthHeader" },
    "body": {
      "type": "object",
      "description": "业务载荷；kind 决定结构（见各节）"
    }
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
        "sig": {
          "type": "string",
          "pattern": "^[A-Za-z0-9+/=]{44}$",
          "description": "HMAC-SHA256(token_key, canon(from,to,msgId,kind,v,ts,nonce) ∥ bodyJson) base64"
        }
      }
    },
    "ErrorBody": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable"],
      "properties": {
        "code": { "type": "string", "description": "跨端错误码（第 6 章）" },
        "message": { "type": "string", "maxLength": 512 },
        "retryable": { "type": "boolean" },
        "reqMsgId": { "type": "string", "description": "被拒绝请求的 msgId（响应类错误）" },
        "detail": { "type": "object", "additionalProperties": true }
      }
    }
  }
}
```

### 11.2 错误消息（error）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.error.v1",
  "title": "DeviceError",
  "allOf": [{ "$ref": "conex.device.envelope.v1" }],
  "description": "kind = error 的信封：body 为 ErrorBody",
  "properties": {
    "kind": { "const": "error" },
    "body": { "$ref": "conex.device.envelope.v1/$defs/ErrorBody" }
  }
}
```

### 11.3 配对消息（pair.*）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.pair.v1",
  "title": "PairingMessages",
  "description": "配对协议全部消息体（第 4 章状态机）",
  "$defs": {
    "PairCode": {
      "type": "string",
      "pattern": "^(CXN-)?[A-HJ-KM-NP-Z2-9]{4}(-[A-HJ-KM-NP-Z2-9]{4}){2}$",
      "description": "标准化前可含前缀/分隔符；传输时统一大写无空格"
    },
    "PairHello": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "deviceId", "mobilePub", "deviceName"],
      "properties": {
        "code": { "$ref": "#/$defs/PairCode" },
        "deviceId": { "type": "string", "minLength": 8, "maxLength": 64 },
        "mobilePub": { "type": "string", "pattern": "^[A-Za-z0-9+/=]{44}$", "description": "X25519 一次性公钥 base64" },
        "mobileLongPub": { "type": "string", "pattern": "^[A-Za-z0-9+/=]{44}$", "description": "移动长期公钥 base64（设备身份）" },
        "deviceName": { "type": "string", "maxLength": 64 },
        "platform": { "type": "string", "enum": ["ios", "android", "other"] }
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
        "tlsFingerprint": {
          "type": "string",
          "pattern": "^[A-Fa-f0-9]{64}$",
          "description": "桌面自签证书 SHA-256 指纹（证书固定）"
        }
      }
    },
    "PairVerify": {
      "type": "object",
      "additionalProperties": false,
      "required": ["challengeSig", "devicePubSig"],
      "properties": {
        "challengeSig": {
          "type": "string",
          "description": "HMAC-SHA256(token_key, \"pair-verify\" ∥ challenge) base64"
        },
        "devicePubSig": {
          "type": "string",
          "description": "用 Mpriv 对 (desktopId ∥ mobileLongPub) 的签名 base64，绑定设备身份"
        }
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

### 11.4 认证消息（auth.* / heartbeat）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.auth.v1",
  "title": "AuthAndHeartbeat",
  "$defs": {
    "Hello": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersions", "appVersion", "platform"],
      "properties": {
        "protocolVersions": { "type": "array", "items": { "type": "integer" }, "minItems": 1 },
        "capabilities": {
          "type": "array",
          "items": { "type": "string" },
          "description": "移动端能力位（如 fileRead、taskInput）"
        },
        "appVersion": { "type": "string", "maxLength": 32 },
        "platform": { "enum": ["ios", "android", "other"] },
        "resume": { "$ref": "conex.device.events.v1/$defs/ResumeState", "description": "断线重连时携带的游标状态" }
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
        "capabilities": {
          "type": "object",
          "additionalProperties": { "type": "boolean" },
          "description": "桌面能力位（streams/fileRead/taskInput/...）"
        },
        "manifest": {
          "type": "object",
          "properties": {
            "contractVersion": { "type": "string" },
            "commands": {
              "type": "array",
              "items": { "$ref": "#/$defs/ManifestEntry" }
            }
          },
          "required": ["contractVersion", "commands"]
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
        "refreshToken": { "type": "string", "description": "HMAC(refresh_key, desktopId ∥ ts ∥ nonce) base64，一次性" }
      }
    },
    "Rotate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nonceSeed"],
      "properties": { "nonceSeed": { "type": "string" } }
    }
  }
}
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.heartbeat.v1",
  "title": "Heartbeat",
  "description": "kind = heartbeat：移动端 30s 一发；桌面回 heartbeat.ok",
  "type": "object",
  "properties": {
    "kind": { "const": "heartbeat" },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ts", "deviceTimeMs"],
      "properties": {
        "ts": { "type": "integer" },
        "deviceTimeMs": { "type": "integer" }
      }
    }
  }
}
```

### 11.5 事件消息（events.*）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.events.v1",
  "title": "EventProtocolMessages",
  "description": "订阅 / 推送 / 续传 / 回执（第 7 章）",
  "$defs": {
    "ResumeState": {
      "type": "object",
      "additionalProperties": false,
      "description": "会话 → 最后已确认持久化序列（断线续传游标）",
      "patternProperties": {
        "^[A-Za-z0-9_-]{1,64}$": { "type": "integer", "minimum": 0 }
      }
    },
    "Subscribe": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessions", "lastSequences"],
      "properties": {
        "sessions": { "type": "array", "items": { "type": "string" }, "maxItems": 32 },
        "lastSequences": { "$ref": "#/$defs/ResumeState" },
        "ackMode": { "enum": ["none", "critical"], "default": "none" }
      }
    },
    "SubscribeAll": {
      "type": "object",
      "additionalProperties": false,
      "required": ["events"],
      "properties": {
        "events": { "type": "array", "items": { "type": "string" }, "description": "type 白名单" }
      }
    },
    "SubscribeOk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessions"],
      "properties": {
        "sessions": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["sessionId", "nextSequence", "stale"],
            "properties": {
              "sessionId": { "type": "string" },
              "nextSequence": { "type": "integer", "description": "会话当前最大已持久化序列+1" },
              "stale": { "type": "boolean", "description": "游标落后超窗口，需全量回放" }
            }
          }
        }
      }
    },
    "EventsPush": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId", "event"],
      "properties": {
        "sessionId": { "type": "string" },
        "preview": { "type": "boolean", "default": false, "description": "实时预览帧（sequence 未落库）" },
        "event": {
          "type": "object",
          "additionalProperties": true,
          "description": "AgentEventEnvelope 扁平 JSON（type/runId/sequence/schemaVersion/sessionId + 事件字段）"
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
        "events": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "description": "扁平事件 JSON（信封序列化，sequence 以 DB 行为准回填）"
          }
        },
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
    }
  }
}
```

### 11.6 命令消息（cmd.* / result.*）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.commands.v1",
  "title": "CommandMessages",
  "description": "移动端动作 → Tauri 命令子集（第 8 章）",
  "$defs": {
    "CommandRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["command", "params"],
      "properties": {
        "command": { "type": "string", "description": "命令名（manifest.name，surface=engine 白名单）" },
        "params": { "type": "object", "additionalProperties": true, "description": "Tauri 命令入参 camelCase JSON" },
        "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 120000, "default": 30000 }
      }
    },
    "ApproveParams": {
      "type": "object",
      "additionalProperties": false,
      "required": ["toolCallId"],
      "properties": { "toolCallId": { "type": "string" }, "reason": { "type": "string", "maxLength": 256 } }
    },
    "RunControlParams": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "runId", "sessionId"],
      "properties": {
        "level": { "enum": ["continue", "soft_inject", "cooperative_stop", "force_cancel"] },
        "runId": { "type": "string" },
        "sessionId": { "type": "string" },
        "reason": { "type": "string", "maxLength": 256 },
        "payload": {
          "type": "object",
          "additionalProperties": true,
          "description": "L1 soft_inject 的 {text}；L0 continue 的 {message?}"
        }
      }
    },
    "RunTaskParams": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sessionId", "prompt"],
      "properties": {
        "runId": { "type": "string", "description": "省略时桌面生成" },
        "sessionId": { "type": "string" },
        "prompt": { "type": "string", "minLength": 1, "maxLength": 1_000_000 },
        "mode": { "type": "string" },
        "cwd": { "type": "string" },
        "permissionMode": { "enum": ["ask", "plan", "full-access"] },
        "clientMessageId": { "type": "string" }
      }
    },
    "CommandResult": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reqMsgId", "ok"],
      "properties": {
        "reqMsgId": { "type": "string" },
        "ok": { "type": "boolean" },
        "result": { "type": "object", "additionalProperties": true, "description": "Tauri 命令返回 JSON" },
        "error": { "$ref": "conex.device.envelope.v1/$defs/ErrorBody" }
      }
    }
  }
}
```

### 11.7 流消息（stream.*）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "conex.device.stream.v1",
  "title": "StreamMessages",
  "$defs": {
    "StreamOpen": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "kind"],
      "properties": {
        "streamId": { "type": "string", "maxLength": 64 },
        "kind": { "enum": ["event_replay", "file", "task_output"] },
        "totalBytes": { "type": "integer", "minimum": 0 },
        "meta": { "type": "object", "additionalProperties": true }
      }
    },
    "StreamChunk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "seq", "data", "final"],
      "properties": {
        "streamId": { "type": "string" },
        "seq": { "type": "integer", "minimum": 1 },
        "data": { "type": "string", "maxLength": 65536, "description": "UTF-8 文本块（或 base64，meta.encoding=b64）" },
        "final": { "type": "boolean" },
        "nextOffset": { "type": "integer", "description": "续传锚点（字节偏移，final 时省略）" }
      }
    },
    "StreamResume": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "offset"],
      "properties": {
        "streamId": { "type": "string" },
        "offset": { "type": "integer", "minimum": 0 }
      }
    },
    "StreamClose": {
      "type": "object",
      "additionalProperties": false,
      "required": ["streamId", "ok"],
      "properties": {
        "streamId": { "type": "string" },
        "ok": { "type": "boolean" },
        "error": { "$ref": "conex.device.envelope.v1/$defs/ErrorBody" }
      }
    }
  }
}
```

### 11.8 事件容器（跨端事件载荷形态，非独立消息）

事件 `body.event` 容器 = `AgentEventEnvelope` 扁平 JSON。为其补一份
**结构性 schema 轮廓**（完整 41 事件字段树随注册表生成，见 12.5）：

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
    "sessionId": { "type": "string" }
  },
  "additionalProperties": true
}
```

> 注：`runId` 缺失时前端放行不过滤（eventUtils.ts:21 语义）；移动端以
> `sessionId` 分组 + `sequence` 排序，不依赖 runId 过滤（跨端不实现多 run
> 并发过滤的桌面等价物）。

---

## 12. 与现有代码融合（Fusion）

### 12.1 可直接复用的既有类型（清单）

| 现有类型 | 位置 | 端间协议用途 |
|---|---|---|
| `AgentEvent`（41 变体） | conex-types/src/events.rs | 事件载荷唯一事实源（原样透传） |
| `AgentEventEnvelope` | 同上（events.rs:921-1013） | 事件跨端序列化格式（复用其 Serialize） |
| `EVENT_ENVELOPE_SCHEMA_VERSION` | events.rs:939 | 信封 schemaVersion 常量 |
| `event_backpressure()` / `BackpressureLevel` | events.rs:867-893 | 跨端投递优先级 |
| `PermissionRequest` / `ApprovalDecision` | events.rs | 审批请求/决策载荷 |
| `RunTerminalStatus` / `AgentEndReason` | events.rs / session.rs | 终态判定 |
| `CoreError`（tagged kind） | conex-types/src/lib.rs:278-293 | 跨端错误映射基底 |
| `IpcEnvelope` / `IpcResponse`（Round 2） | lib.rs:124-141 | 端间请求-响应形态先例（本协议弃用，改用 DeviceEnvelope，避免与 Tauri IPC 混淆） |
| `EventPage` 契约 | core_query_commands.rs:326-338 | 续传分页（`{events, nextAfterSequence, hasMore}`） |
| `CommandManifest` / 92 命令 | command_manifest.rs | 能力真源 |
| `RunTaskOptions` / `RunTaskResponse` | core_run_commands.rs | runTask 参数/响应 |
| `CancelRunResponse` / `ApproveResponse` | core_run_commands.rs:107-129 | 取消/审批响应 |
| `RunSnapshot` | core_query_commands.rs:422-442 | run 状态 |
| `RunControlIntent` / `RUN_CONTROL_LEVELS` | shared-types run-control.ts | L0-L3 控制载荷 |
| `PermissionRequest` / `PermissionDecision` | shared-types permissions.ts | 审批 UI 载荷 |
| 生成器 parser（`parseEngineEvent`） | shared-types generated/engine/parser.ts | 移动端事件解析 |

**明确不复用**：`stored-event.ts`（前端 event log 协议 v1，桌面前端内部审计
轨迹，非跨端协议）；`IpcEnvelope`（Tauri IPC 专用，字段形态与设备信道需求
不符——DeviceEnvelope 承担）。

### 12.2 新增类型放哪：conex-types 新模块（不建新 crate）

**决策：新增 `crates/conex-types/src/device/` 模块族 + 注册表
`crates/conex-types/contracts/device-protocol.json`，不新建 crate。**

理由：

1. **复用事件同构序列化纪律**：conex-types 是「双端契约唯一事实源」的既有
   归属（events.rs:1-8 模块文档），设备域类型同样需要 Rust/TS 双端一致，
   放同 crate 可共享 registry_drift 式护栏惯例。
2. **避免新 crate 的依赖矩阵开销**：Device Relay Service 与 Command Adapter
   都在 Tauri 壳内，conex-types 已是壳依赖（core_run_commands 大量引用）；
   新 crate 只会增加 Cargo 解析面。
3. **生成器单一输入面**：注册表目录集中（contracts/ 下并列
   engine-events.json / device-protocol.json），生成脚本按注册表名分发。

新增模块建议：

```
crates/conex-types/src/
  device/mod.rs          -- 模块头 + 重导出（DeviceEnvelope/消息体/错误码/常量）
  device/envelope.rs     -- DeviceEnvelope + AuthHeader + 签名构造/校验（HMAC）
  device/pair.rs         -- PairHello/Challenge/Verify/Ok/Ready/Unlink + 配对码生成/标准化
  device/token.rs        -- HKDF 派生（token_key/enc_key/refresh_key）+ refresh token
  device/events.rs       -- Subscribe/Resume/ResumePage/EventsPush（事件会话面）
  device/commands.rs     -- CommandRequest/Result（白名单常量表）
  device/stream.rs       -- StreamOpen/Chunk/Resume/Close
  device/error.rs        -- DeviceErrorCode 枚举 + 与 CoreError 映射（6.3）
  device/version.rs      -- PROTOCOL_VERSION / MIN_PROTOCOL_VERSION / 能力位常量
contracts/device-protocol.json   -- 设备域注册表（生成器输入）
```

### 12.3 Tauri 壳侧新增（apps/agent-workbench/src-tauri/src/）

```
device_relay.rs        -- WS 监听 + 连接管理 + DeviceEnvelope 解包/验签/路由（扇出 1:2）
command_adapter.rs     -- 跨端命令 → Tauri 命令调用（白名单 + CoreError 映射）
pairing_service.rs     -- 配对状态机（码生成/哈希/有效期/并发限制）+ Device Registry 读写
device_emitter.rs      -- Emitter 实现（core_event_bridge.rs:51-54 trait），下游慢信号回传
```

- `device_emitter` 实现既有 `Emitter` trait：事件桥扇出点不改动
  （`BufferedRunEventBridge::flush` 同时调 TauriEmitter 与 DeviceEmitter）。
- `pairing_service` 的 Device Registry 表走 conex-db v6 迁移（新增
  device_registry 表，4.5 DDL）。
- 命令白名单 = 常量表（8.2 清单）∩ 运行时 `core_list_commands` 拉取的
  registered=true 且 surface=engine。

### 12.4 生成器扩展（scripts/）

**决策：把 `generate-engine-bindings.mjs` 泛化为多注册表分发，不复制脚本。**

- 注册表按 `contract` 字段区分：`engine-events`（既有 41 事件）与
  `device-protocol`（新增设备域）。
- `device-protocol.json` 结构（与 engine-events 同形风格）：
  `{contract: "device-protocol", schemaVersion: 1, messageCount, messages: [
  {id, kind, rustVariant, fields: [{name, type, required, integer?}]}],
  types: {...}, enums: {...}, capabilities: [...], errorCodes: [...]}`。
- 输出落点：`packages/shared-types/src/generated/device/{messages,types,
  parser,index}.ts`（生成 parser 复用既有 `ParseResult`/深度守卫/整数校验
  骨架——`PARSER_PREAMBLE` 提为共享常量）。
- 生成 `device/errors.ts`（错误码枚举 + CoreError kind 映射表，6.3）与
  `device/capabilities.ts`（能力位字面量联合，10.2）。
- 幂等性、ASCII-only、确定性字节等既有纪律不变；`registry_drift.rs` 增加
  device-protocol ↔ `crates/conex-types/src/device/**` 的对应护栏测试。
- **事件体不重新生成**：移动端事件解析直接复用
  `generated/engine/parser.ts` 的 `parseEngineEvent`（跨端零成本）。

### 12.5 移动端消费面（crish-mobile，本期只定协议，不实现）

- 连接层：WS 客户端 + 证书固定（4.6）+ DeviceEnvelope 编解码
  （generated/device/parser.ts）。
- 状态层：`(sessionId → lastSequence)` 游标持久化；事件按 sequence 有序应用；
  preview 帧不推进游标。
- 渲染层：41 事件 → 移动端 UI 组件映射表（7.2 跨端策略列）——本期文档
  化，落地时按 UI 需求裁剪。

### 12.6 端到端验收锚点（建议后续任务书引用）

| # | 验收点 | 证据 |
|---|---|---|
| T-D3-01 | 配对全流程（码生成→hello→challenge→verify→ready） | 状态机测试（pairing_service） |
| T-D3-02 | 令牌派生一致性（双端 master/token_key 相同） | HKDF 已知向量测试 |
| T-D3-03 | 撤销设备后 hello 拒绝（auth.device_revoked） | device_registry 删除 → 重连测试 |
| T-D3-04 | 事件跨端逐字节同构（桌面事件通道 vs 设备信道） | 扇出点字节断言（同 serialize） |
| T-D3-05 | 断线续传：游标后事件完整补发（含 Soft/Critical） | resume 分页 + 有序性测试 |
| T-D3-06 | 移动端审批 → 桌面状态机恢复（awaiting-approval → running） | 全链路集成测试 |
| T-D3-07 | 协议版本协商：v 不匹配 → version_mismatch | hello 协商测试 |
| T-D3-08 | 命令白名单：非白名单拒绝（cmd.denied） | adapter 测试 |
| T-D3-09 | 生成器幂等：两次运行字节一致（device 域） | 生成脚本 CI 校验 |
| T-D3-10 | 配对审计不进 agent 事件流（41 变体不变） | registry_drift 回归 |

---

## 13. 附录

### 13.1 消息 kind 一览（L3 分发表）

| kind | 方向 | 关联 schema | 说明 |
|---|---|---|---|
| pair.hello / pair.challenge / pair.verify / pair.ok | 双向 | 11.3 | 配对状态机 |
| device.ready / device.unlink / device.revoked / device.audit | 双向 | 11.3 | 设备生命周期 |
| auth.hello / auth.hello.ok / auth.refresh / auth.rotate | 双向 | 11.4 | 握手/轮换 |
| heartbeat / heartbeat.ok | M→D / D→M | 11.4 | 保活 + 时钟校准 |
| events.subscribe / events.subscribe.ok / events.subscribeAll | M→D / D→M | 11.5 | 订阅 |
| events.push / events.ack | D→M / M→D | 11.5 | 推流 |
| events.resume / events.resume.page / events.resume.done | M→D / D→M | 11.5 | 续传 |
| cmd.approve / cmd.deny / cmd.runControl / cmd.cancelRun / cmd.runTask / cmd.readFile / cmd.listDir / cmd.getRunSnapshot / cmd.readSessionEvents / cmd.listTasks / cmd.getTaskOutput / cmd.sendInput | M→D | 11.6 | 命令请求 |
| result.<名> | D→M | 11.6 | 命令响应 |
| stream.open / stream.chunk / stream.resume / stream.close | 双向 | 11.7 | 大载荷分块 |
| error | 双向 | 11.2 | 错误通知 |

### 13.2 常量表（crates/conex-types/src/device/version.rs 落位）

| 常量 | 值 | 说明 |
|---|---|---|
| PROTOCOL_VERSION | 1 | 当前协议主版本 |
| MIN_PROTOCOL_VERSION | 1 | 兼容下限 |
| MAX_FRAME_BYTES | 1_048_576 | 单帧上限 |
| EVENT_WINDOW | 4096 | 每会话下行窗口 |
| MAX_SUBSCRIPTIONS | 32 | 订阅会话上限 |
| MAX_STREAMS | 8 | 并发流上限 |
| STREAM_CHUNK_MAX | 65_536 | 块上限 |
| PAIR_CODE_TTL_MS | 600_000 | 配对码有效期 |
| PAIR_MAX_ATTEMPTS | 5 | 单码失败上限 |
| PAIR_MAX_ACTIVE | 3 | 并发码上限 |
| PAIR_MAX_DEVICES | 8 | 设备数上限 |
| AUTH_TS_WINDOW_MS | 300_000 | 签名时戳窗口 |
| HEARTBEAT_INTERVAL_MS | 30_000 | 移动端心跳间隔 |
| HEARTBEAT_TIMEOUT_FACTOR | 3 | 断线判定倍数 |
| IDEMPOTENCY_TTL_MS | 300_000 | 幂等结果缓存 |

### 13.3 与「33-event-schema-changelog」的衔接

- 事件体字段演进（未来 minor/major）只改 `engine-events.json` 注册表 +
  events.rs，跨端协议无感（7.1 透传原则）。
- 本协议自己的演进登记文档建议：
  `docs/multi-device/plans/33-device-schema-changelog.md`（10.3 纪律）——
  首次发布登记 v1 全量。

### 13.4 开放问题（评审关注）

1. 中继（公网穿透）的认证边界：本期令牌方案在公网暴露后需加失败锁定
   （连续鉴权失败 10 次 → 桌面告警 + 设备暂停 15min）。
2. 移动端推送（APNs/FCM）与 WS 常驻的关系：通知触发重连即可，不引入
   第三信道。
3. 多桌面配对（一台移动端连多台桌面）：Device Registry 支持多 desktop_id
   行；本期协议已按 `desktopId` 隔离设计，UI 切换桌面 = 换连接 + 换令牌
   上下文，无需协议变更。
4. `events.resume` 与 `cmd.readSessionEvents` 的关系：两者同契约；建议
   resume 走专用消息（带会话上下文），cmd 版留给 UI 手动刷新——不合并，
   语义清晰。
5. 事件 `preview` 帧的客户端渲染策略：建议直接渲染（实时性优先），
   持久化副本到来时**原地覆盖**（同 sequence 幂等），保证不闪跳。

### 13.5 参考代码索引（本设计依据，均为允许读取范围）

| 事实 | 位置 |
|---|---|
| AgentEvent 41 变体定义 | crates/conex-types/src/events.rs:306-782 |
| 事件类型名宏 / ALL_TYPE_NAMES | crates/conex-types/src/events.rs:789-852 |
| 背压分级函数 | crates/conex-types/src/events.rs:867-903 |
| AgentEventEnvelope 扁平序列化 | crates/conex-types/src/events.rs:905-1013 |
| 事件存储 sequence 语义 | crates/conex-db/src/events.rs:6-131 |
| events 表 DDL | crates/conex-db/src/schema.rs:17-27, 184-188 |
| EventQueue 分流/终态 | crates/orchestrator/src/events.rs:101-261, 323-496 |
| 事件桥 / Emitter | apps/agent-workbench/src-tauri/src/core_event_bridge.rs:47-145 |
| 命令清单 92 条 | apps/agent-workbench/src-tauri/src/command_manifest.rs:63-186 |
| 事件分页契约 EventPage | apps/agent-workbench/src-tauri/src/core_query_commands.rs:326-338, 507-588 |
| run 命令面（runTask/control/cancel/approve/deny） | apps/agent-workbench/src-tauri/src/core_run_commands.rs:3033-3780 |
| 审批门（先发后等/待审批集合） | apps/agent-workbench/src-tauri/src/core_run_commands.rs:151-344 |
| L0-L3 控制契约 | packages/shared-types/src/run-control.ts:17-96 |
| 审批载荷 TS 契约 | packages/shared-types/src/permissions.ts:13-29 |
| 前端事件协议 v1（不复用） | packages/shared-types/src/stored-event.ts:3-32 |
| 生成器 | scripts/generate-engine-bindings.mjs:87-611 |
| AgentEndReason | crates/conex-types/src/session.rs:95-108 |

---

（文档完）
