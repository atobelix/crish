# D2 桌面端服务化改造方案

> 任务书：D2-desktop-serverification。为 crish 桌面端（`apps/agent-workbench/src-tauri`）
> 设计「本地服务端化」改造方案，让桌面端可被移动端 / 其他端连接。
>
> 文档性质：**设计稿（方案文档）**，产出路径 `docs/multi-device/plans/D2-desktop-serverification.md`。
> 本文档只读消费的代码面：`apps/agent-workbench/src-tauri/**`（重点）、`crates/**`、
> `packages/**`；未读取 `reference/**`、`apps/crish-mobile/**`、`docs/**`。
> 文中所有 `文件路径:行号` 均为 2026-08-09 工作区快照的实际位置，可复核。
>
> 文档版本：v1（2026-08-09）
> 读者：多端改造调度方、桌面壳实现方、移动端实现方、安全评审。

---

## 目录

1. 结论摘要（TL;DR）
2. 现状盘点（代码事实，全部可复核）
3. 设计目标与非目标
4. 服务形态与总体架构
5. 服务生命周期管理
6. 技术选型（axum / hyper / ws 库 / 依赖成本）
7. 认证与配对
8. API 面设计（REST + WS）
9. 命令 → 服务 API 映射表（全量 92 条，T1/T2/T3 分级）
10. 事件推送与续传游标
11. 与现有代码的融合（文件:行号清单）
12. 安全边界
13. 测试与验证
14. 风险与缓解
15. 分阶段实施计划
16. 附录（常量表 / 协议示例 / 术语 / 引用索引）

---

## 1. 结论摘要（TL;DR）

- **服务形态**：桌面壳**进程内**内置一个本地 HTTP + WebSocket 服务，跑在 Tauri 自带的
  tokio runtime（`tauri::async_runtime`）上，与主循环共存，不做独立 daemon 进程。
  默认恒以 `127.0.0.1:8765` 监听（loopback-only，随应用启动）；用户显式开启「配对模式」
  时以 `0.0.0.0:8765` 重绑（仅此模式开放局域网连接）。
- **API 面**：REST 路由 `/v1/**` 直接调用既有命令**契约体**（`run_task_impl` /
  `run_control_impl` / `core_read_session_events` 等，全部为「测试直调、不依赖 Tauri
  runtime」的实现函数），不经 Tauri invoke；错误协议复用 `CoreError {kind, detail}`。
   WS 端点 `/v1/events` 推送 AgentEvent 信封 JSON（与 Tauri 事件通道同载荷）。
   95 条命令（注册面 91 + 登记先行 4，M6 §2.3 勘误转正）按 T1 核心 / T2 增强 /
   T3 不暴露三级映射，见 §9。
- **认证方案**：【裁决修正 1/10】配对码规格对齐 D3 §4.1 唯一真源（CXN-XXXX-XXXX-XXXX
   12 字符 base32、10 分钟、5 次失败上限、X25519+HKDF 密码学链）；令牌形态按 M7 §4.2
   四类令牌分治（配对令牌为桌面本地形态），本方案的 Bearer 令牌表述收敛为
   「配对期签发的会话令牌（D3 §5.1 token_key 派生体系）」；令牌哈希落盘
   `config_dir()/pairing.json`（0600），客户端持令牌访问全部 `/v1/**`；
   桌面 UI 可随时撤销；配对期间自动开放 0.0.0.0 绑定。
- **关键融合点**：新增 `FanOutEmitter` 实现既有 `Emitter` trait
  （`core_event_bridge.rs:51-54`），挂在 `EventBridge` 构造点
   （`main.rs:353-356`）之后，事件桥 / 缓冲桥 / delta 实时轨 / timer/cron drain **全部
   零改动**自动进入 WS 广播；REST handler 复用 `core_run_commands.rs` 各 `*_impl`
  契约体；服务状态不进 `app.manage`，由 `ServerState` 自持；退出钩子
  （`main.rs:467-473`）先优雅关服再存快照。

---

## 2. 现状盘点（代码事实，全部可复核）

本章逐层梳理桌面壳与引擎的既有结构，作为后续设计的「不改动面」与「改动点」基线。

### 2.1 进程模型：单进程 IPC 模式，无 daemon

- `main.rs:1-27` 文档明确：当前是「进程内（IPC 模式）的装配层」，不存在独立 daemon
  进程；`cli_bridge.rs:11-12` 的注释残留「daemon sidecar path」是历史遗留（sidecar 已
  不存在），`workbench_dev_cli_*` 命令仅为开发诊断面（`cli_bridge.rs:30-60`）。
- 结论：移动端要连的是**桌面壳自身**，不是另一个后台进程。服务化 = 壳内嵌服务，而非
  拆分出 daemon。

### 2.2 命令注册面（91 条 registered + 4 条登记先行）

- 注册面唯一真源在 `main.rs:79-209` 的 `command_registry!` 宏：
  - `main.rs:81` 同源生成 `COMMAND_REGISTRY_NAMES`（注册面清单）；
  - `main.rs:84-86` 同源生成 `build_invoke_handler()`（Tauri invoke 分发）；
  - `main.rs:90-209` 列出 95 项二元组（命令名, 实现路径）。
- 契约清单唯一真源 `command_manifest.rs:68-191`：`COMMAND_MANIFEST` = 95 条
  （注册面 91 + 登记先行 4：`append_session_messages` / `workbench_open_workspace` /
  `workbench_list_workspaces` / `workbench_dev_mcp_enabled`）。
  - 一致性由测试锁定：`main.rs:500-514`（注册面 == manifest registered=true）、
    `command_manifest.rs:209-210`（条数公式化 95=91+4、唯一性、幽灵命令排除）。
- 命令按 family 分组（`command_manifest.rs:70-186`）：workbench（GUI 专属 24 条）/
  config（10）／core（约 30）／session（13）／workflow（6）。
- 关键点：**实现函数与 Tauri 强绑定的是「薄壳」**（`#[tauri::command]` + `State` 解包），
  命令本体大量已是「契约体」模式（可直调、可单测）：
  - `run_task_impl`（`core_run_commands.rs:3043`）——文档明示「core_run_task 与
    T-CF-11 idle 续 run 共用装配路径；测试可直调，不依赖 Tauri runtime」；
  - `run_control_impl`（`core_run_commands.rs:3605`）——同上；
  - `build_list_response` / `build_output_response` / `build_send_input_response`
    （`background.rs:2579-2644`）——同上。
  - 这一模式是 REST handler 直接复用命令体的**先例与基础**（见 §11-B）。

### 2.3 事件桥（EventBridge / BufferedRunEventBridge / DeltaSink）

三层结构，职责分离清晰（`core_event_bridge.rs:1-18` 模块文档）：

1. **发射抽象** `Emitter` trait（`core_event_bridge.rs:51-54`）：`fn emit(&self,
   channel: &str, payload: &str)`——payload 为**已序列化**的完整事件 JSON 字符串；
   实现方自行兜底发射失败。现有实现 `TauriEmitter`（`core_event_bridge.rs:57-81`）：
   `app.emit("workbench-run-event", payload)`，失败仅 warn。
2. **信封桥** `EventBridge`（`core_event_bridge.rs:88-145`）：`serialize`
   （`core_event_bridge.rs:107-120`）把 `AgentEventEnvelope` 序列化为**扁平顶层 JSON**
   （`{type, runId, sequence, schemaVersion, ...事件字段}`，与 daemon WS 广播同构，
   03 §3.1）；`emit_payload`（`core_event_bridge.rs:137-144`）直发已序列化载荷。
   测试锚定载荷形状：`core_event_bridge.rs:196-220`（`payload_is_flat_top_level_
   envelope_json`）。
3. **run 级缓冲桥** `BufferedRunEventBridge`（`engine.rs:1643-1704`）：
   - `emit`（`engine.rs:1662-1689`）：入队时即序列化（P9，AA-06），按
     `drop_class_of`（`buffer.rs:36-42`：仅 `message-delta` 为 Soft 可丢，其余 Critical
     永不丢）分类入 `EventBuffer`；
   - `flush`（`engine.rs:1692-1703`）：drain 后逐条 `bridge.emit_payload`。
   - 丢帧水位：Soft 64 / Critical 256（`buffer.rs:200-206` Default）。
4. **实时轨** `BridgeDeltaSink`（`engine.rs:1716-1741`）：只承载 `message-delta`，
   信封 `sequence=None`（不落库、无序列号，`engine.rs:1736`），push 即
   emit+flush（`engine.rs:1733-1741`）。

另外三条旁路发射路径（都不经 BufferedRunEventBridge，直接走 `EventBridge`）：
- timer/cron 缓冲 drain（`engine.rs:1574-1628`）：500ms 周期 tick
  （`main.rs:430-441`），`forward_drained_events` 直发（`engine.rs:1614-1628`）；
- 审批 request 实时预览（`core_run_commands.rs:3142-3149`：信封 `sequence=None`）；
- 审批 resolved 落库 + 实时发射（`core_run_commands.rs:3802-3835`）。

**关键结论**：所有发射路径最终都收敛到 `EventBridge::emit_payload`
（`core_event_bridge.rs:137-144`）。只要在此处加一个 fan-out（多发射器分发），
**全事件流（含实时轨与旁路）自动获得 WS 推送能力，桥与引擎零改动**。这是本方案
「融合点 A」的根因（见 §11-A）。

### 2.4 事件契约（AgentEvent 41 变体 + 信封）

- `conex_types::events::AgentEvent`（`crates/conex-types/src/events.rs:290-782`）：
  41 种域事件（tagged enum，顶层 `type` kebab-case，字段 camelCase）。注：任务书描述
  「27 变体」与代码不符——按 `ALL_TYPE_NAMES`（`events.rs:810-852`）实数为 41
  （2026-08-05 T-CF-04 定时器域 +2、T-CF-08 cron 域 +1，`events.rs:295-296`）。
- 信封 `AgentEventEnvelope`（`events.rs:905-992`）：`run_id` / `sequence` /
  `schema_version` 由 emit 层注入；序列化为扁平顶层 JSON（`events.rs:941-964`）。
- 背压分级 `event_backpressure`（`events.rs:867-893`）：Delta（message-delta、
  subagent-event progress、task-output、task-heartbeat）／Soft（subagent-event
  message/tool、task-suspicious、timer-cancelled）／Critical（其余全部，落库不丢）。

### 2.5 存储层（conex-db events 表 + orchestrator Store trait）

- `conex-db/src/schema.rs:17-27`（v1）与 `schema.rs:141-151`（v5 目标形态）：events 表
  **`UNIQUE(session_id, sequence)`** ——sequence 是**会话内**单调连续号；
  `idx_events_session_seq` 索引（schema.rs:27）。
- `conex-db/src/events.rs`：
  - `append_event`（`events.rs:8-27`）：INSERT 受 UNIQUE 约束；
  - `query_events`（`events.rs:33-68`）：`WHERE session_id = ?1 AND sequence > ?2
    ORDER BY sequence ASC LIMIT ?3`——**续传游标的查询原语已经存在**，且带 limit
    参数（`events.rs:52`）；
  - `reserve_sequence`（`events.rs:72-99`）：session_sequence 表原子取号
    （T08.12），首次取号自动按库内 max+1 对齐；
  - `seed_sequence`（`events.rs:103-121`）：MAX 语义预热校准（恢复后）。
- `orchestrator::persist::Store` trait（`crates/orchestrator/src/persist.rs:127-212`）：
  统一连接抽象（insert_run / update_run_status / reserve_sequence / seed_sequence /
  append_event / query_events / query_runs / save_pending_input / load_pending_inputs /
  delete_pending_input / as_local_db / touch_session）。生产实现 `LocalDbStore`
  （`persist.rs:588-757`），全部方法经 `blocking_db_call`（`persist.rs:572-581`）
  包 `spawn_blocking`，不占用 tokio worker——**服务层并发读事件流可直接复用该 trait，
  无新增阻塞风险**。
- 事件分页查询命令已存在：`core_read_session_events`（`core_query_commands.rs:511-539`）、
  `core_read_run_events`（`core_query_commands.rs:546-588`），返回
  `EventPage {events, nextAfterSequence, hasMore}`（`core_query_commands.rs:328-338`），
  游标语义 = 会话内连续 sequence；页大小常量 DEFAULT 200 / MAX 1000
  （`core_query_commands.rs:43-47`）。**这是 WS 续传重放直接复用的分页契约。**

### 2.6 Tauri 状态管理与异步 runtime 用法

- `app.manage` 注入的全部状态（`main.rs` setup 序列 ④-⑨）：WorkspaceRegistry
  （main.rs:308-321）、TrashRootConfig（main.rs:326）、OutputsRootConfig
  （main.rs:331）、SharedGatekeeper / SharedSearchState / SharedCompactionState
  （main.rs:334-339）、StatusDiagnostics（main.rs:342）、CoreRunState（main.rs:364-371
  构造，main.rs:388 manage）、EventBridge（main.rs:389）、SharedDb（main.rs:390）、
  BackgroundTaskRegistry（main.rs:391）、WorkflowCommandState（main.rs:406-418）、
  ModelCatalog（main.rs:422-424）。
- 异步 runtime：Tauri 2 自带 tokio runtime，全壳经 `tauri::async_runtime::spawn`
  派发任务（先例：restore `main.rs:381`、timer/cron drain `main.rs:434`、
  快照循环 `core_run_commands.rs:2235`、run driver `core_run_commands.rs:3562`、
  退出钩子 block_on `core_run_commands.rs:2260`）。
- 同步上下文探测异步 runtime 的既有模式：`tokio::runtime::Handle::try_current()`
  （`engine.rs:1114`、`engine.rs:1157`、`engine.rs:1574`）——服务装配与测试需要遵循。
- 壳级 Cargo.toml 已带 `tokio = { version = "1", features = ["full"] }`
  （`src-tauri/Cargo.toml:26`）；workspace 级 tokio 声明含 `net` feature
  （`Cargo.toml:66`）——**TCP 监听与 WS 需要的 net 能力已在依赖图中**。

### 2.7 既有「本机 socket 服务」先例

- `dev_mcp.rs:21-71`：`tauri-plugin-mcp` 调试 socket（**仅 debug**、`CRISH_MCP_SOCKET=1`
  精确开启、loopback 固定端口 4000（`dev_mcp.rs:30-31`）、插件自生成随机 token 写入
  `%TEMP%\tauri-mcp-4000.token` 边车文件）。这是「壳内嵌 TCP 服务 + token 鉴权 +
  env 门控」的**最小先行先例**，本方案的服务是该模式的正式化与强化（用户可见开关、
  配对握手、0.0.0.0 模式、多连接管理）。
- `wait_channel.rs:201-272` `EventStreamBroadcast`：进程内 mpsc 广播 + 订阅者修剪 +
  满通道丢帧记日志——**进程内 fan-out 的既有参考实现**（§10 广播设计对齐其语义）。

### 2.8 前端 / 移动端可连性现状

- `tauri.conf.json:29` CSP `connect-src` 已包含 `http://127.0.0.1:8765` 与
  `ws://127.0.0.1:8765`——**8765 端口在 CSP 中已被预留给本地服务**（现前端无消费者，
  属预留）。本方案将 8765 作为服务默认端口，与 CSP 对齐，桌面 webview 可直接连，
  无需改 CSP。

---

## 3. 设计目标与非目标

### 3.1 目标（本方案必须满足）

1. **移动端核心闭环**：移动端可（a）查询桌面状态与会话列表、（b）发起 / 控制 / 取消
   run、（c）裁决工具审批、（d）实时接收事件流、（e）断线后按会话游标续传。
2. **最小侵入**：引擎（session-loop / orchestrator）、事件桥、事件缓冲、存储层
   **零改动或近零改动**；全部新代码收敛在壳新增的 `server` 模块内。
3. **可测试**：服务核心（路由 / 后端抽象 / fan-out / 配对状态机）可在无 Tauri
   runtime 下编译与单测；提供「模拟连接端连服务断言事件流」的本地集成测试。
4. **安全默认**：默认 loopback-only；配对模式显式开启；令牌鉴权全覆盖；高危写面
   （文件写、shell、pty）**不暴露**。
5. **与 Tauri 主循环共存**：不新建独立进程 / 不新建 tokio runtime（复用
   `tauri::async_runtime`），退出钩子优雅关服，restore 门禁语义不变。

### 3.2 非目标（明确不做，防范围蔓延）

- 不做云端 / 中继转发（多设备在不同网络下的远程访问）——只做局域网 / 本机；
- 不做移动端 UI / 移动端 SDK（属 D4/D3 其他任务书）；
- 不做桌面端与移动端的双向文件同步；
- 不暴露 T3 级命令（GUI 专属 / 本地 shell / 文件写面 / pty，见 §9）；
- 不做 TLS 加密（v1 假设局域网可信模型，威胁模型与演进见 §12.8）；【裁决修正 11】
  本项已被主控裁决作废：传输协议 = **wss 强制 + 自签 CA pinning（配对时建立信任）**
  （D1 §8.2 P1 验收 5 / D3 §3.1 / D5 §10.1 ADR），R1 即生效；「免 TLS」最多作为
  中继路径加密前的过渡选项，且必须显式开启；
- 不修改引擎侧事件语义（不新增事件变体，不改变 sequence 语义）；
- 不迁移 `reference/markdown-editor` 与主仓库任何测试资产。

---

## 4. 服务形态与总体架构

### 4.1 形态决策：进程内嵌服务（in-process），不做独立 daemon

对比三个候选：

| 候选 | 优点 | 缺点 | 裁决 |
|---|---|---|---|
| **进程内嵌服务**（本方案） | 直接调用命令契约体（零 IPC 序列化往返）、共享 CoreRunState / LocalDb / tokio runtime、单二进制无 sidecar 管理、退出钩子天然同步 | panic 会拖垮整个应用（需任务隔离）；DB 单连接需遵守 spawn_blocking 纪律 | **采用** |
| 独立 daemon 进程 | 崩溃隔离 | 需要进程间协议（重复造一遍事件流/命令面）、快照/DB 双开竞态、sidecar 生命周期与防火墙管理、与现状单进程模型冲突 | 否 |
| Tauri 插件（tauri-plugin） | 官方扩展面 | 插件是面向「可分发能力」，本项目内聚场景用普通模块更简单；插件生命周期与 setup 绑定反而绕 | 否 |

进程内方案的关键前提已被代码验证：命令契约体（§2.2）、Store trait（§2.5）、
tokio runtime（§2.6）都支持「无 Tauri 包装直接调用」。

### 4.2 总体架构图（进程内）

```
┌────────────────────────────── crish 桌面壳进程 ──────────────────────────────┐
│                                                                              │
│  ┌─────────────────── tauri::async_runtime（tokio 多线程） ───────────────┐  │
│  │                                                                        │  │
│  │  session-loop 引擎 ──► BufferedRunEventBridge ─┐                       │  │
│  │  timer/cron drain ─────────────────────────────┤                       │  │
│  │  审批实时轨 / resolved ────────────────────────┼─► EventBridge         │  │
│  │  task 事件消费器 ──────────────────────────────┘   (emit_payload)      │  │
│  │                                                      │                 │  │
│  │                                            FanOutEmitter（新增）       │  │
│  │                                             ├─► TauriEmitter（webview）│  │
│  │                                             └─► WsBroadcast（新增）    │  │
│  │                                                  │  broadcast channel │  │
│  │                                                  ▼                    │  │
│  │  ┌─── server 模块（新增，bin 目标）──────────────────────────────┐    │  │
│  │  │  axum Router /v1/**                                          │    │  │
│  │  │  ├─ REST handlers ──► ApiBackend trait ──► CoreStateBackend  │    │  │
│  │  │  │                       │                    │ (直接调用    │    │  │
│  │  │  │                       └──► MemoryBackend(测试)  契约体)    │    │  │
│  │  │  ├─ WS /v1/events：认证→订阅→DB 重放→实时尾随                   │    │  │
│  │  │  ├─ auth：配对状态机 + 令牌哈希表                                │    │  │
│  │  │  └─ state：ServerState（端口/绑定/连接注册表/广播句柄）          │    │  │
│  │  └──────────────────────────────────────────────────────────────┘    │  │
│  │                                                                        │  │
│  │  CoreRunState（app.manage 注入）◄── 读写复用（store() / *_impl）        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  移动端 ──HTTP/WS──► 127.0.0.1:8765（默认）｜ 0.0.0.0:8765（配对模式）        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 模块布局（新增代码收敛点）

按现有 bin 模块约定（`main.rs:28-65` 的 `mod` 列表）新增 `mod server;` 子模块树：

```
apps/agent-workbench/src-tauri/src/server/
├── mod.rs        # ServerManager：装配 / start / shutdown / ServerState
├── config.rs     # 服务配置：端口 / 绑定模式 / 开关（persisted server.json）
├── auth.rs       # 配对状态机 + 令牌签发/校验/撤销（哈希存储）
├── pair.rs       # 配对码生成 / TTL / 失败锁定（可单测的纯状态机）
├── backend.rs    # ApiBackend trait（纯 trait，不依赖 crate:: 内部）★测试隔离关键
├── core_backend.rs # CoreStateBackend：实现 ApiBackend，引用 crate:: 内部（bin 专属）
├── router.rs     # axum Router 与全部 handler（只依赖 ApiBackend + conex-types）★可 #[path] 独立编译测试
├── ws.rs         # WS handler：认证 / 订阅 / 重放 / 实时尾随 / 心跳
├── fanout.rs     # FanOutEmitter（实现 core_event_bridge::Emitter）+ WsBroadcast
└── error.rs      # 服务错误 → HTTP 状态 + CoreError {kind, detail} 映射
```

**可测试性架构决策（重要）**：`backend.rs`（trait）+ `router.rs` + `ws.rs` + `fanout.rs`
只依赖 `conex-types` / `serde` / axum / tokio，**不引用任何 `crate::` 内部模块**；
`core_backend.rs` 是唯一引用 `crate::core_run_commands` 等 bin 内部实现的文件。
测试侧经 `#[path]` 独立编译（先例 `tests/event_bridge_contract.rs:30`）挂
`MemoryBackend` 即可在无 Tauri 环境下全量驱动 REST/WS 逻辑（§13）。

---

## 5. 服务生命周期管理

### 5.1 端口与绑定

| 项 | 值 | 依据 / 说明 |
|---|---|---|
| 默认端口 | **8765** | CSP 已预留（`tauri.conf.json:29`）；与前端 webview 直连面一致 |
| 端口范围 | 8765-8775（11 个） | 8765 占用时顺序探测，首个可用端口生效 |
| 默认绑定 | `127.0.0.1`（loopback-only） | 随应用启动，恒监听（开销极小） |
| 配对绑定 | `0.0.0.0`（局域网） | 仅「配对模式」开启时；关闭后回退 loopback 重绑 |
| 实际生效值持久化 | `config_dir()/server.json` | 含 {port, bindMode, pairingEnabled}；供 UI 与发现 |
| 局域网地址发现 | `GET /v1/info`（loopback-only 免鉴权） | 返回 {port, bindMode, pairingActive, version}；UI 据此拼二维码 |

**端口冲突处理**：`tokio::net::TcpListener::bind` 失败（端口被占用）→ 顺序尝试
8766..8775 → 全部失败则服务不启动，`StatusDiagnostics.record("server", false, ...)`
（复用 `status_diagnostics.rs:97-155` 的环形缓冲，`core_get_status.diagnostics`
如实呈现，`core_query_commands.rs:303-311` 消费）→ 不阻断应用启动（诚实降级，对齐
`main.rs:236-253` 的 DB 降级先例）。绑定成功后把实际端口写入 server.json。

**生命周期决策：随应用启动 vs 仅配对时启动**——采用**双态折中**：
- loopback 监听**恒启动**（setup 完成即 bind）：本机能力（后续 webview 直连、本机
  自动化、移动端通过 USB 转发等）始终可用，且 loopback 无暴露面；
- 局域网监听（0.0.0.0）**仅配对模式显式开启**：安全敏感面默认关闭。

### 5.2 启动序列（接入 setup 的位置）

在 `main.rs` setup 闭包（`main.rs:290-456`）内追加一步（放在 `mark_initialized`
之前或之后均可，建议在 `main.rs:448` 之后）：

```
setup 序列 ⑪（新增）：server 装配
  1. ServerState::new(app_handle.clone(), core_state.clone(), shared_db.clone(),
     diagnostics.clone())
  2. config::load()（读 server.json，决定端口 / 绑定模式）
  3. tauri::async_runtime::spawn(async { server.start().await })   // bind loopback
  4. 绑定成功 → diagnostics.record("server", true, Some(addr))；失败 → 记诊断不阻断
```

- 不依赖 restore 完成：监听可先行；`/v1/runs` 类接口在 restore 门禁未放行前返回
  「restore in progress」（直接复用 `core_run_commands.rs:3071` 的既有检查，REST
  层映射为 HTTP 409）。
- 复用 `tauri::async_runtime::spawn`（先例 `main.rs:381`、`main.rs:434`），不新建
  runtime；axum 的 `serve` 未来就绪后由该 task 持有（§6.3）。

### 5.3 关闭序列（退出钩子）

`main.rs:467-473` 的 `RunEvent::Exit` 钩子内，在 PTY 清理与快照保存**之前**追加：

```
if let Some(server) = app_handle.try_state ... // 或 ServerState 静态句柄
    server.shutdown().await   // 触发 axum with_graceful_shutdown（watch channel 置位）
```

- 语义：停止接受新连接 → 广播 `{"type":"server-closing"}` 并关闭已有 WS（客户端
  拿到「服务端主动关闭」信号，避免误判断线重试风暴）→ 等待优雅退出（上限 2s）→
  返回，继续走既有 `save_snapshot_blocking`（`main.rs:471`）。
- 客户端重连策略：进程重启后 token 仍在（persist 在 config_dir），客户端带
  `token + 每会话游标` 重连即无缝续传（§10.5）。

### 5.4 配对模式开关

- 配置项：`config_dir()/server.json` 的 `pairingEnabled`（默认 false）；经桌面
  UI 开关（走新增 GUI 命令 `workbench_set_pairing`，登记 manifest 的
  `registered=true` 需同步前端清单，见 §11-G 的登记策略）。
- 开启动作：置位 → 重启监听（0.0.0.0）→ 进入配对状态机（§7）→ 桌面 UI 显示
  配对码 + 二维码（`ws://<局域网IP>:<port>` 拼装）。
- 关闭动作：清空全部已签发令牌（安全：关闭即失效）→ 回退 loopback 重绑。
- 崩溃 / 异常退出：配对码状态在内存（重启即失），令牌表持久化（不随关闭清空，
  除非显式撤销或关闭配对）。

---

## 6. 技术选型（axum / hyper / ws 库 / 依赖成本）

### 6.1 现状依赖事实

- 壳已带：`tokio full`（`src-tauri/Cargo.toml:26`）、`reqwest`（`src-tauri/
  Cargo.toml:29`，workspace 0.13 + rustls，`Cargo.toml:58`）、`futures-util`、
  `url`；workspace tokio 声明含 `net`（`Cargo.toml:66`）。
- `Cargo.lock`（2026-08-09 快照）：`hyper`（`Cargo.lock:2607`，reqwest 0.13 依赖链
  已带）、**`tokio-tungstenite` 已在依赖图**（`conex-browser` crate 的 CDP 传输依赖，
  `Cargo.lock:937` 与 `Cargo.lock:6331`）——即 **WS 客户端/服务端库在 workspace 中
  已被消费、版本已锁定**，新增服务复用不引入新版本。
- 现存「HTTP 服务」候选在仓库中无先例（无 axum/warp/actix 依赖），属**新增依赖**，
  需按 PE-10（依赖最小 feature 集纪律，`Cargo.toml:63-66` 注释）登记理由。

### 6.2 选型对比

| 候选 | 新增依赖成本 | 优点 | 缺点 | 裁决 |
|---|---|---|---|---|
| **axum 0.8**（features: ws/json/http1/tokio） | 约 10-15 个 crate（tower、http、mime 等，多数与 hyper 共享，锁文件净增有限） | 路由/提取器/中间件齐全、官方 WS 支持（内层 tokio-tungstenite）、graceful shutdown 一等公民、与 tower 中间件做鉴权干净 | 依赖面偏大 | **采用（主推）** |
| hyper 1.x 手写 + tokio-tungstenite | 最小（tokio-tungstenite 已在图；hyper 已在图） | 依赖增量最小、控制面最细 | 路由/错误处理/中间件全手写，开发与评审成本高 | 备选（若依赖预算否决 axum） |
| warp | 独立 tower 栈、宏习惯与现状不符 | — | — | 否 |
| actix-web | 独立 runtime/生态，与 tokio 双栈 | — | — | 否 |

**结论：axum 0.8（default-features=false，显式开 ws/json/http1）**。若实现轮发现
锁文件净增超预算，回退 hyper + tokio-tungstenite 直写（接口面不变，仅 router.rs 内部
实现差异，由 backend trait 隔离，不影响其余设计）。

### 6.3 runtime 共存要点（与 Tauri 主循环）

- **单一 runtime**：axum server 在 `tauri::async_runtime::spawn` 的 task 内运行，
  与 restore / drain / snapshot 等既有 task 同池。tokio 多线程 runtime 可容纳。
- `axum::serve(listener, router).with_graceful_shutdown(shutdown_signal)`：shutdown
  watch 通道由 `ServerState` 持有，退出钩子（§5.3）置位。
- **禁止 block_on**：服务 handler 内不得 `block_on`（会与 tokio worker 冲突），
  需要同步 DB 的一律走 `Store::query_events` 等 async 方法（内部已
  spawn_blocking，`persist.rs:572-581`）。
- `try_current` 模式（`engine.rs:1114` 先例）：服务装配若在无 runtime 上下文
  （测试）被调用，用 `tokio::runtime::Handle::try_current()` 守卫，避免 panic。
- 内存/线程开销：监听 socket + 每连接一个 drain task；空闲零事件时广播通道
  无唤醒开销（`tokio::sync::broadcast` 空发不唤醒）。

### 6.4 Cargo.toml 改动清单（§11-E 详述）

壳 `src-tauri/Cargo.toml:17-58` 追加：

```toml
# 本地服务化（D2）：axum 0.8 默认关 feature，显式开 ws/json/http1（PE-10 登记）
axum = { version = "0.8", default-features = false, features = ["ws", "json", "http1", "tokio"] }
# 若 axum ws 不满足需求再直加；当前 conex-browser 已带 tokio-tungstenite（锁文件已锁定）
```

dev-dependencies 追加（集成测试用 WS 客户端，版本与锁文件既有 tokio-tungstenite
一致，不新增锁文件条目）：

```toml
[dev-dependencies]
tokio-tungstenite.workspace = true   # 或直接 = "0.26"（与 conex-browser 同版本）
```

`tests/server_integration.rs` 复用既有 `#[path]` 测试模式（`tests/event_bridge_
contract.rs:30`）。

---

## 7. 认证与配对

### 7.1 威胁模型（简述，详见 §12）

服务监听 socket 后，任何能路由到该端口的进程/设备都可以尝试连接：本机恶意进程
（loopback 模式）、局域网内其他设备（0.0.0.0 模式）。默认零信任：**除 `/v1/pair`
与 `/v1/info`（仅 loopback）外，所有接口必须携带有效令牌**。

### 7.2 配对流程（Pairing Flow）

```
移动端                          桌面端（ServerState 配对状态机）
  │  1. 用户开启「配对模式」         → pair_enable()：生成 code + 二维码
  │                                 【裁决修正 1】code = D3 §4.1 CXN-XXXX-XXXX-XXXX
  │                                 （12 字符 base32、10 分钟 TTL、60bit、单码 5 次
  │                                 失败上限；字符集与密码学链全部以 D3 §4.1 为准，
  │                                 原 8 字符/31 字符集/120s 规格作废）
  │  2. 用户扫码/手工输入 code
  │ ── POST /v1/pair {code} ─────────► pair_verify(code)
  │                                     ├─ 状态非 awaiting → 403 pair.idle
  │                                     ├─ TTL 过期 → 403 pair.expired（重新开启）
  │                                     ├─ 连续失败 ≥5 → 403 pair.locked（锁定 60s）
  │                                     └─ 校验通过：
  │                                         签发 token（32 字节 CSPRNG，hex 64 字符）
  │                                         哈希（SHA-256）入令牌表，返回 {token}
  │ ◄── 200 {token, serverVersion, protocolVersion} ─
  │  3. 移动端保存 token；后续全部请求带 Authorization: Bearer <token>
  │  4. 配对状态机回 idle；同一次配对窗口只签一枚 token（防并行窃取）
```

> 【裁决修正 1】配对全流程的密码学链（X25519 ECDH + HKDF 派生 master/token_key/
> enc_key/refresh_key）以 D3 §4.4 为唯一真源；本节的「码换 Bearer 令牌」仅为
> 桌面服务网关的接入形态，与 D3 配对协议并存不冲突（裁决 10：M7 四类令牌分治，
> 配对令牌为本地形态）。

### 7.3 令牌生命周期与存储（桌面侧）

- **生成**：`tokio::io` 无 CSPRNG，用 `rand` 或 `getrandom`（壳已带 `sha2`、
  `base64`，`src-tauri/Cargo.toml:31-32`；rand 属新增 dev/prod 依赖或直接读
  OS CSPRNG——实现建议 `rand` 加壳级依赖或经 `windows-sys` BCryptGenRandom，
  登记时二选一，本设计不锁死）。
- **落盘**：`config_dir()/pairing.json`（config_dir 解析逻辑复用
  `config/persistence.rs:39-51`，生产路径 = `%APPDATA%\Crish\AgentWorkbench`）。
  内容只存 **SHA-256 哈希**，不存明文：

```json
{
  "version": 1,
  "tokens": [
    { "hash": "sha256hex…", "label": "Pixel-9", "issuedAtMs": 1754000000000,
      "lastSeenAtMs": 1754000001000, "revoked": false }
  ],
  "pairingEnabled": true
}
```

- **权限**：Windows 上显式收紧 ACL（0600 语义；实现经 windows-sys 或
  std 权限位，Unix 直接 0600）。备选：复用现有 DPAPI 密钥槽（`config/
  persistence.rs:15-18` 的 `secrets/*.dpapi`）加密明文——但服务器在无用户交互
  下需要自解密，DPAPI 属当前用户作用域，同进程可用；**v1 采用哈希 + ACL，
  DPAPI 列为演进项**（哈希已可满足「泄露文件 ≠ 泄露可用令牌」）。
- **校验**：`Authorization: Bearer` → SHA-256 → 常量时间比较（比哈希串 + 检查
  revoked）→ 更新 lastSeenAt。
- **撤销**：桌面 UI 一键撤销（删除表项 / 置 revoked）；「关闭配对」清空全部令牌
  （§5.4）。撤销后已连接 WS 由服务端主动 `{"type":"kicked"}` 关闭（§10.6）。
- **重启持久**：token 表跨进程重启存活（文件持久化），移动端无需重新配对；
  配对码状态不持久（内存态，重启后需重新开启配对）。

### 7.4 与 Tauri 壳的交互

- 配对状态与「是否显示二维码」由桌面前端经新增 GUI 命令查询/驱动：
  - `workbench_pairing_status`（只读）：{pairingEnabled, activeConnections,
    tokensCount, code, codeExpiresAtMs}；
  - `workbench_pairing_enable` / `workbench_pairing_disable`（含撤销全部令牌）；
  - `workbench_pairing_revoke_token`（按 label 撤销单设备）。
- 三条命令登记进 `command_registry!`（`main.rs:90-209`）与 `COMMAND_MANIFEST`
  （`command_manifest.rs:68-186`），同步前端 `commandManifest.ts` 内置镜像
  （`command_manifest.rs:3-8` 文档描述的镜像机制）。
- 事件面：服务状态变化（配对开启/关闭、连接建立/断开、令牌撤销）发射
  **既有事件通道**（复用 `EventBridge`）或经 `StatusDiagnostics.record("pairing", …)`
  ——设计选前者（桌面前端实时刷新二维码区），载荷为新增服务侧事件
   `server-status-changed`？——**不新增事件变体**（41 变体冻结为基线，`events.rs:290-782`；
   新增需走事件注册表 + 前端生成产物，成本高）。【裁决修正 5】主控裁决确认：
   **41 变体为当前基线，新增事件变体一律走注册表登记**（events.rs:789-808 三件套：
   Rust enum arm + contracts/engine-events.json + registry_drift.rs；会话索引变更类
   走 M6 `events.session.updated` 会话面消息，不新增变体）。v1 决策：配对状态变化经
  `StatusDiagnostics.record`（core_get_status 可见）+ 桌面前端轮询配对状态命令
  （3s 轻量轮询），**不碰事件契约**。

---

## 8. API 面设计（REST + WS）

### 8.1 设计原则

1. **命令体直调**：REST handler 直接调用既有 `*_impl` 契约体
   （§2.2 / §11-B），**不经过 Tauri invoke**——移动端获得的语义与桌面端完全一致
   （校验、串行守卫、审批门禁、落库全在契约体内）。
2. **错误协议复用**：错误体沿用 `CoreError {kind, detail}`（`core_error.rs`），
   REST 映射 HTTP 状态码：InvalidInput→400、NotFound→404、RestorePending→409、
   auth 失败→401、配对失败→403（带细分 kind，见 §7.2 的 pair.* 码）。
   前端移动端按 kind 分类处理（与桌面 `coreError` 消费面同构）。
3. **无状态 REST / 有状态 WS**：查询与动作走 REST（幂等友好、便于 curl 验证）；
   实时事件流走 WS（§10）。run 的流式输出**不**用 SSE/REST 长轮询——WS 已覆盖。
4. **版本面**：路径前缀 `/v1`；协议版本号随 `protocolVersion` 返回
   （`/v1/info` 与配对响应），移动端据此做能力协商；信封 schemaVersion 已有
   （`events.rs:935-939`）。
5. **参数命名与桌面 IPC 一致**（camelCase，`sessionId` / `runId` /
   `afterSequence` / `maxEvents`），移动端可直接复用既有 TS 契约类型
   （packages/shared-types 生成产物，`events.rs:6-8` 描述的生成链）。
6. **发现面**：`GET /v1/commands` 透传 `core_list_commands` 的 manifest JSON
   （`command_manifest.rs:188-194`），移动端动态发现能力面（与桌面前端启动拉取
   真源同构，`command_manifest.rs:190-191` 注释）。

### 8.2 路由总表（REST）

统一前缀 `/v1`；除 `/v1/pair` 与 `/v1/info`（loopback-only）外全部要求
`Authorization: Bearer <token>`。

```
# 服务面（发现/健康）
GET  /v1/info                # 免鉴权（仅 loopback 路由可达）；{port,bindMode,pairingActive,version,protocolVersion}
POST /v1/pair                # 免鉴权（配对握手）；{code} → {token,...}
GET  /v1/hello               # 鉴权握手；{serverVersion,protocolVersion,serverTimeMs}
GET  /v1/commands            # 命令清单（core_list_commands 直透）

# 状态与会话（T1）
GET  /v1/status              # core_get_status 直透（含 providerStatus/restore/snapshot/backgroundTasks）
GET  /v1/sessions            # list_sessions
GET  /v1/sessions/{id}/body  # load_session_body
PUT  /v1/sessions/{id}/body  # save_session_body（自愈补建会话行语义保留，session_commands.rs:106-113）
DELETE /v1/sessions/{id}     # delete_session（含产出目录清理/回收站通知，session_commands.rs:191-221）
GET  /v1/sessions/{id}/agents# load_session_agents
PUT  /v1/sessions/{id}/agents# save_session_agents
GET  /v1/sessions/{id}/meta?key=…   # get_session_meta（key 参数化）
PUT  /v1/sessions/{id}/meta  # set_session_meta {key,value}
GET  /v1/sessions/{id}/events?afterSequence=&maxEvents=   # core_read_session_events（游标分页）

# 运行控制（T1）
POST /v1/runs                # core_run_task（body = RunTaskOptions 全字段，core_run_commands.rs:3010-3030）
GET  /v1/runs/{id}/snapshot  # core_get_run_snapshot
GET  /v1/runs/{id}/events?sessionId=&afterSequence=&maxEvents=  # core_read_run_events
POST /v1/runs/{id}/control   # core_run_control {level,message,reason,payload}
POST /v1/runs/{id}/cancel    # core_cancel_run {mode:"cooperative"|"force"}
POST /v1/runs/{id}/approve   # core_approve_tool {toolCallId}
POST /v1/runs/{id}/deny      # core_deny_tool {toolCallId,reason}

# 配置（T1 只读 + 非敏感更新）
GET  /v1/config              # config_get（脱敏快照，provider.rs:431-435）
PATCH /v1/config             # config_update 非敏感字段（baseUrl/model/credentialMode/endpoint/stream，
                             #   写后 reload_provider 语义保留，provider.rs:444-518）
                             # 密钥类变更（config_secret_* / config_profile_apply）→ T2 不默认开放

# 后台任务（T1 查询 / T2 操作）
GET  /v1/tasks               # workbench_list_background_tasks
GET  /v1/tasks/{id}/output   # workbench_get_background_task_output
POST /v1/tasks/{id}/cancel   # T2（两阶段终止语义，background.rs:2624-2629）
POST /v1/tasks/{id}/input    # T2（stdin 注入，background.rs:2651-2659）

# 工作流（T1 触发/查询，T2 管理）
GET  /v1/workflows           # list-workflows
POST /v1/workflows           # T2 create-workflow
PATCH /v1/workflows/{id}     # T2 update-workflow
DELETE /v1/workflows/{id}    # T2 delete-workflow
POST /v1/workflows/{id}/trigger  # trigger-workflow
GET  /v1/workflows/{id}/runs     # list-workflow-runs

# 模型目录（T2）
GET  /v1/catalog             # catalog_get（catalog_commands.rs:43-56）
POST /v1/catalog/refresh     # catalog_refresh（catalog_commands.rs:58-76）

# 回收站（T2）
GET  /v1/trash               # trash_list（core_run_commands.rs:3897-3912）
POST /v1/trash/restore       # trash_restore {entryId}（core_run_commands.rs:3922-3949）
POST /v1/trash/purge         # trash_purge {entryId}（core_run_commands.rs:3975-4003）

# Markdown 服务端渲染（T2，移动端瘦客户端复用桌面渲染栈）
POST /v1/md/render           # core_md_render（markdown_commands.rs:23-34）
POST /v1/md/render-batch     # core_md_render_batch（markdown_commands.rs:36-50）
POST /v1/md/highlight        # core_highlight_code（markdown_commands.rs:68-80）
POST /v1/md/clear-cache      # core_md_clear_cache（markdown_commands.rs:82-90）

# 会话杂项（T2）
POST /v1/sessions/{id}/touch     # touch_session
POST /v1/sessions/{id}/cleanup   # cleanup_orphan_sessions（body 带 activeIds/confirmEmpty 守卫，
                                 #   空 keep 拒绝语义保留，session_commands.rs:92-101）
POST /v1/sessions/{id}/flow      # get_flow_snapshot（DAG 只读快照，session_commands.rs:366-…）
GET  /v1/import/from-localstorage# T3 不暴露（仅桌面迁移入口）

# WS（事件流，§10）
WS   /v1/events?token=…
```

### 8.3 暴露分级（T1/T2/T3）判定依据

- **T1（移动端核心闭环，默认暴露）**：状态、会话读写、run 全生命周期（发起/控制/
  取消/审批）、事件分页、配置只读、任务查询、工作流触发与查询。覆盖「移动端接管
  run 会话」的完整闭环。
- **T2（增强，可配置开关，默认暴露）**：工作流管理、回收站、模型目录、Markdown
  渲染、任务操作、会话杂项。按迭代推进（P5）。
- **T3（不暴露，硬性排除）**：全部 GUI 专属面 + 本地能力面。理由：
  - 文件系统写面（`workbench_write_file_content` / `workbench_fs_delete_file` /
    `workbench_select_folder`）——移动端远程写桌面文件 = 高危（逃逸监视/写路径
    声明体系是引擎侧语义，服务面无法获得同等护栏；`workbench_run_shell` / pty 同理）；
  - `workbench_http_request`（壳代理请求语义）、`workbench_apply_update`（桌面更新）、
    `workbench_git_run`（git 操作需终端交互）；
  - `host_openers` 族（桌面关联应用，无移动端语义）；
  - 工具 Worker 组（`core_hash_compute` / `core_base64_*` / `core_detect_encoding` /
    `core_decode_text` / `core_parse_diff` / `core_messages_to_jsonl` /
    `core_jsonl_to_messages` / `core_text_encode` / `core_jsonl_append` /
    `core_count_tokens` / `core_compute_diff` / `core_check_command` /
    `core_search_files` / `core_rebuild_search_index` / `core_compact_messages`）——
    纯桌面工具面，移动端无消费场景；
  - `workbench_list_directory` / `workbench_read_file_content`：**列为 T4 演进**
    （显式授权 + 只读），v1 不暴露；【裁决修正 2】文件面暴露口径以 M6 §4.7/§4.8
    白名单特批清单为 v1 冻结真源（C16 listDir / C17 readFile / C18 writeFile 已按
    surface=gui 特批开放，受 F4 四闸门防护；AU2 F-3 冲突以 M6 为准）；
  - `import_from_localstorage`：桌面迁移专用。

### 8.4 请求/响应示例（run 发起 + 审批裁决）

```http
POST /v1/runs
Authorization: Bearer <token>
Content-Type: application/json

{
  "runId": "r-1723000000000-abc",
  "sessionId": "s-1723000000000-xyz",
  "prompt": "检查当前工作区 git 状态并总结",
  "permissionMode": "ask"
}
```
```json
200 OK
{ "runId": "r-1723000000000-abc", "sessionId": "s-…", "ok": true }
```

```http
POST /v1/runs/r-1723000000000-abc/approve
Authorization: Bearer <token>
Content-Type: application/json

{ "toolCallId": "tc-42" }
```
```json
200 OK
{ "ok": true, "toolCallId": "tc-42", "decision": "approved" }
```
（载荷形状与 `ApproveResponse`（`core_run_commands.rs:117-123`）逐字段一致；
审批落库 + 实时发射由 `emit_approval_resolved`（`core_run_commands.rs:3802-3835`）
保证——移动端裁决后桌面端/其他端即时收到 `approval-resolved` 事件。）

---

## 9. 命令 → 服务 API 映射表（全量 95 条）

映射表以 `COMMAND_MANIFEST`（`command_manifest.rs:68-186`）为准逐条登记；
`registered=false` 的登记先行命令标注「待接线」。T3 条目给出**不暴露理由**，
不登路由（防幽灵路由，对齐幽灵命令排除纪律 `command_manifest.rs:273-295`）。

### 9.1 workbench 族（GUI 专属面，24 条）

| manifest 命令 | 实现位置 | 服务 API | 分级 | 说明 |
|---|---|---|---|---|
| workbench_run_shell | process.rs:57 | — | T3 | shell 执行，拒绝暴露 |
| workbench_list_background_tasks | background.rs:2605 | GET /v1/tasks | T1 | — |
| workbench_get_background_task_output | background.rs:2614 | GET /v1/tasks/{id}/output | T1 | — |
| workbench_cancel_background_task | background.rs:2624 | POST /v1/tasks/{id}/cancel | T2 | — |
| workbench_send_input | background.rs:2651 | POST /v1/tasks/{id}/input | T2 | — |
| workbench_git_run | git.rs:187 | — | T3 | git 操作需终端交互语义 |
| workbench_fs_delete_file | fs_commands/mod.rs:61 | — | T3 | 文件写面高危 |
| workbench_pty_create/write/resize/kill | pty/mod.rs:45 等 | — | T3 | 终端交互，移动端无承载 |
| workbench_list_host_openers | host_openers/mod.rs:18 | — | T3 | 桌面关联应用语义 |
| workbench_open_host_target | host_openers/mod.rs:23 | — | T3 | 同上 |
| workbench_open_path_default | host_openers/mod.rs:31 | — | T3 | 同上 |
| workbench_list_file_openers | host_openers/mod.rs:36 | — | T3 | 同上 |
| workbench_select_folder | fs_commands/mod.rs:19 | — | T3 | 文件对话框（AppHandle 依赖） |
| workbench_list_directory | fs_commands/mod.rs:27 | — | T4 预留 | 只读，需显式授权 |
| workbench_read_file_content | fs_commands/mod.rs:36 | — | T4 预留 | 只读，需显式授权 |
| workbench_write_file_content | fs_commands/mod.rs:50 | — | T3 | 文件写面高危 |
| workbench_discover_skills | fs_commands/mod.rs:74 | — | T3 | 桌面技能发现语义 |
| workbench_http_request | commands.rs:20 | — | T3 | 壳代理请求，移动端自持网络 |
| workbench_apply_update | commands.rs:11 | — | T3 | 桌面更新动作 |
| workbench_open_workspace | workspace.rs:378（待接线） | — | T3 | GUI 专属 |
| workbench_list_workspaces | workspace.rs:393（待接线） | — | T3 | GUI 专属 |
| workbench_dev_mcp_enabled | dev_mcp.rs:89（待接线） | — | T3 | 调试面 |

### 9.2 config 族（10 条）

| manifest 命令 | 实现位置 | 服务 API | 分级 | 说明 |
|---|---|---|---|---|
| config_get | provider.rs:433 | GET /v1/config | T1 | 脱敏快照 |
| config_update | provider.rs:444 | PATCH /v1/config | T1 | 非敏感字段；reload_provider 语义保留 |
| config_secret_set | provider.rs（config_secret_set） | — | T3 | 密钥写入移动端不应持有（桌面用户会话语义） |
| config_secret_get | 同上 | — | T3 | 不返回明文密钥 |
| config_secret_has | 同上 | — | T2 可选 | 布尔探测；v1 不暴露 |
| config_secret_clear | 同上 | — | T3 | — |
| config_profile_apply | provider.rs:532 | — | T3 | 含 apiKey 明文入参，桌面专属 |
| config_secret_reveal | 同上 | — | T3 | 明文揭示，桌面专属 |
| config_get_outputs_root | outputs_config.rs | GET /v1/config（并入） | T2 | 只读合并进 /v1/config 或独立 GET |
| config_set_outputs_root | outputs_config.rs | — | T3 | 产出根变更桌面专属 |

### 9.3 core 族——查询与运行（A/B 面，9 条）

| manifest 命令 | 实现位置 | 服务 API | 分级 | 说明 |
|---|---|---|---|---|
| core_get_status | core_query_commands.rs:277 | GET /v1/status | T1 | — |
| core_get_run_snapshot | core_query_commands.rs:595 | GET /v1/runs/{id}/snapshot | T1 | — |
| core_read_run_events | core_query_commands.rs:546 | GET /v1/runs/{id}/events | T1 | 分页 + 游标 |
| core_read_session_events | core_query_commands.rs:511 | GET /v1/sessions/{id}/events | T1 | 分页 + 游标（WS 重放同源） |
| core_run_task | core_run_commands.rs:3033 | POST /v1/runs | T1 | 契约体 run_task_impl:3043 |
| core_run_control | core_run_commands.rs:3592 | POST /v1/runs/{id}/control | T1 | L0-L3；契约体 :3605 |
| core_cancel_run | core_run_commands.rs:3706 | POST /v1/runs/{id}/cancel | T1 | — |
| core_approve_tool | core_run_commands.rs:3750 | POST /v1/runs/{id}/approve | T1 | — |
| core_deny_tool | core_run_commands.rs:3777 | POST /v1/runs/{id}/deny | T1 | — |

### 9.4 core 族——工具旧组 / Worker 组 / 杂项（21 条）

| manifest 命令 | 服务 API | 分级 | 说明 |
|---|---|---|---|
| core_check_command | — | T3（M6 C15 可用） | 【裁决修正 2】AU2 F-4 冲突以 M6 白名单为准：C15 checkCommand 映射 core_check_command 为 v1 可用（审批前置预览），D2 的 T3 表述降为「默认分级」 |
| core_search_files | — | T3（M6 C10 状态查询） | 【裁决修正 2】同 F-4：M6 C10 getSearchIndex 仅开放索引就绪状态查询（core_search_files 的 ready/state 子集），**全文搜索仍按 T3 不暴露**（AU1 P2-12） |
| core_rebuild_search_index | — | T3 | 索引维护桌面专属 |
| core_compact_messages | — | T3 | 压缩操作桌面专属 |
| core_count_tokens | — | T3 | 桌面工具 |
| core_compute_diff | — | T3 | 桌面工具 |
| core_md_render | POST /v1/md/render | T2 | markdown_commands.rs:23 |
| core_md_render_batch | POST /v1/md/render-batch | T2 | markdown_commands.rs:36 |
| core_md_render_stream | — | T3 | 流式渲染桌面专属（WS 无承载价值） |
| core_highlight_code | POST /v1/md/highlight | T2 | markdown_commands.rs:68 |
| core_md_clear_cache | POST /v1/md/clear-cache | T2 | markdown_commands.rs:82 |
| core_hash_compute | — | T3 | 桌面工具 |
| core_base64_encode / core_base64_decode | — | T3 | 桌面工具 |
| core_detect_encoding | — | T3 | 桌面工具 |
| core_decode_text | — | T3 | 桌面工具 |
| core_parse_diff | — | T3 | 桌面工具 |
| core_messages_to_jsonl / core_jsonl_to_messages | — | T3 | 桌面工具 |
| core_text_encode | — | T3 | 桌面工具 |
| core_jsonl_append | — | T3 | 桌面工具 |
| core_list_commands | GET /v1/commands | T1 | 服务面透传 |

### 9.5 session 族（13 条 + 1 登记先行）

| manifest 命令 | 服务 API | 分级 | 说明 |
|---|---|---|---|
| list_sessions | GET /v1/sessions | T1 | session_commands.rs:116 |
| load_session_body | GET /v1/sessions/{id}/body | T1 | :126 |
| save_session_body | PUT /v1/sessions/{id}/body | T1 | :140（自愈语义 :106-113） |
| delete_session | DELETE /v1/sessions/{id} | T1 | :192（产出目录清理 + 回收站通知） |
| load_session_agents | GET /v1/sessions/{id}/agents | T1 | :224 |
| save_session_agents | PUT /v1/sessions/{id}/agents | T1 | :238 |
| get_session_meta | GET /v1/sessions/{id}/meta | T1 | :253 |
| set_session_meta | PUT /v1/sessions/{id}/meta | T1 | :269 |
| cleanup_orphan_sessions | POST /v1/sessions/{id}/cleanup | T2 | :295（keep 守卫 :94-101） |
| import_from_localstorage | — | T3 | 桌面迁移专用 |
| touch_session | POST /v1/sessions/{id}/touch | T2 | :335 |
| upsert_session_entry | — | T3 | 索引写入由桌面前端驱动；移动端经 body 写 |
| get_flow_snapshot | GET /v1/sessions/{id}/flow | T2 | :366 起 |
| append_session_messages | — | T3 | 登记先行（未接线），不建路由 |
| set_session_output_root | — | T3 | 产出根会话覆盖桌面专属 |

### 9.6 workflow 族（6 条）

| manifest 命令 | 服务 API | 分级 | 说明 |
|---|---|---|---|
| create-workflow | POST /v1/workflows | T2 | workflow_commands.rs:1023 |
| list-workflows | GET /v1/workflows | T1 | :1042 |
| update-workflow | PATCH /v1/workflows/{id} | T2 | :1053 |
| delete-workflow | DELETE /v1/workflows/{id} | T2 | :1085 |
| trigger-workflow | POST /v1/workflows/{id}/trigger | T1 | :1098（steering 注入语义保留） |
| list-workflow-runs | GET /v1/workflows/{id}/runs | T1 | :1113 |

### 9.7 映射表汇总

- T1 = 22 条（run 闭环 9 + 会话读写 7 + 状态/配置/任务/工作流查询 6）；T2 = 16 条；
  T3 = 57 条（含 T4 预留 2，browser 三条已注册计入 T3）；合计 **95 = 注册面 91 +
  登记先行 4**（后 4 条全部 T3）。【裁决修正 2】95 条为当前代码事实
  （`command_manifest.rs:68-191` + 测试锁定 95=91+4），本表以 M6 §2.3 勘误口径为准。
- 路由总表与 manifest 的一致性测试：`server/router.rs` 维护
  `ROUTE_COMMAND_INDEX: &[(method, path, manifest_name)]` 常量表，测试断言
  每条已登记路由的 manifest 名 ∈ 允许暴露集（T1∪T2），**T3 集合逐条反向断言
  无路由**——幽灵路由守门，对齐 `command_manifest.rs:273-295` 纪律。

---

## 10. 事件推送与续传游标

### 10.1 WS 端点与连接参数

```
WS /v1/events?token=<token>
```

- 连接即鉴权：token 无效/撤销 → 101 前拒绝（HTTP 401）或握手后立即
  `{"type":"error","code":"auth.failed"}` + 关闭。
- Origin 校验：服务端检查 `Origin`/`Sec-WebSocket-Protocol`（如存在），
  非预期 Origin（浏览器跨站发起）拒绝——**双保险**（token 才是主防线，§12.3）。
- 每令牌最多 2 条并发连接（多设备同一令牌场景受限；超过关闭最旧连接并
  `{"type":"kicked","reason":"concurrency-limit"}`）；全局上限 8 条
  （§12.6 多连接管理）。

### 10.2 帧协议（文本帧，JSON Lines 语义——一帧一 JSON）

**客户端 → 服务端**

```json
{ "type": "subscribe",
  "sessions": ["s-1", "s-2"],        // 空/缺省 = 全会话；显式列表 = 过滤
  "resume": { "s-1": 42, "s-2": 0 }  // 每会话续传游标（会话内 sequence）
}
{ "type": "unsubscribe", "sessions": ["s-1"] }
{ "type": "ping" }
```

**服务端 → 客户端**

```json
{ "type": "welcome", "protocolVersion": 1, "serverTimeMs": 1754000000000 }
{ "type": "subscribed", "sessions": ["s-1","s-2"] }
{ "type": "replay", "sessionId": "s-1", "events": [ <信封 JSON>, ... ] }
{ "type": "catchup", "sessionId": "s-1", "lastSequence": 57 }   // 该会话重放完成锚点
{ "type": "event", "payload": { "type":"message-end", "runId":"r-…", "sequence":58,
                                "schemaVersion":1, "sessionId":"s-1", "message":{…} } }
{ "type": "pong" }
{ "type": "kicked", "reason": "token-revoked" }
{ "type": "server-closing", "reason": "shutdown" }
{ "type": "error", "code": "subscribe.invalid", "message": "…" }
```

- `event` 帧的 payload = **与桌面事件通道逐字节相同的信封 JSON**（
  `EventBridge::serialize` 产物，`core_event_bridge.rs:107-120`）——移动端可复用
  桌面端全部事件解析栈（packages/shared-types 生成产物）。
- 顺序保证：**先重放后实时**（每会话）；重放批次内按 sequence 升序
  （store `query_events` 语义，`events.rs:44-50`）；实时帧按到达序。
- 心跳：服务端 30s 发 `{"type":"ping"}`，客户端应答 `{"type":"pong"}`；
  90s 无任何帧 → 服务端关闭连接（半开检测）。

### 10.3 续传游标：复用 events 表 sequence 语义

- **游标定义**：`(sessionId, sequence)`——与 `UNIQUE(session_id, sequence)`
  （`schema.rs:24`、`schema.rs:141-151`）与分页命令的
  `afterSequence`（`core_query_commands.rs:511-539`）**同一语义**。
- **重放实现**（服务端，subscribe 处理）：
  1. 对每个 `resume` 中的会话，调 `store.query_events(session_id, after)`
     （`persist.rs:697-713`，底层 `events.rs:33-68`，按需加 limit 分批）；
  2. 逐批组 `replay` 帧（复用 `core_query_commands.rs:483-491` 的
     `parse_envelopes` 解析逻辑：损坏载荷跳过，防御性）；
  3. 本会话最后一帧后发 `catchup {lastSequence}`，随后切入实时尾随。
- **重放批次上限**：单会话单次重放上限 = `MAX_PAGE_SIZE`（1000，
  `core_query_commands.rs:45`）* 分批循环；超大重放（如 10 万事件会话）分批推送，
  期间实时事件先入队（每会话一个小 pending buffer，上限 256，超限丢 Delta 保
  Critical——复用 `EventBuffer` 水位语义，`buffer.rs:200-206`）。
- **Delta 类事件不落库**（`message-delta`、`task-output`、`task-heartbeat`、
  subagent progress——`events.rs:867-893`）：断线重连后**不会**从 DB 重放；
  由 `message-end` 全文兜底（既有契约 03 §5.3-6，`buffer.rs:9-11` 注释）——
  移动端与桌面端**同一恢复语义**（桌面 `StreamRecovery` 亦如此）。
- **断线续传客户端流程**：断线 → 指数退避重连（1s/2s/4s…上限 30s）→
  重新 `subscribe` 携带上次收到的最大 sequence 每会话游标 → 重放补齐 → catchup 后
  继续实时。**令牌 + 游标双持久**（token 在配置目录，游标在移动端本地），
  桌面重启后移动端无需重新配对即可无缝续传（§5.3）。

### 10.4 广播架构（FanOutEmitter + broadcast channel）

- **发射侧**（零改动复用）：所有事件已由引擎层序列化为字符串 payload
  （`engine.rs:1667` 入队即序列化），`EventBridge::emit_payload`
  （`core_event_bridge.rs:137-144`）是唯一汇聚点。
- **新增 `FanOutEmitter`**（实现 `Emitter` trait，`core_event_bridge.rs:51-54`）：
  `emit` 同步遍历内部发射器列表（TauriEmitter + WsBroadcast::publish）；
  任一发射器失败不影响其他（TauriEmitter 现有兜底语义 `core_event_bridge.rs:72-80`
  同款）。**发射路径为同步函数，fan-out 不做异步**（对齐 Emitter 契约），
  WS 侧 publish 为 `broadcast::send`（非阻塞）。
- **WsBroadcast**：`tokio::sync::broadcast::Sender<String>`（容量 1024）；
  每 WS 连接一个 drain task：`rx.recv()` → 按订阅过滤（会话过滤在**订阅侧**
  做：连接仅接收订阅会话集合的帧——见下）→ 序列化文本帧 → `SinkExt::send`。
- **订阅过滤位置**：为节省局域网带宽，广播通道发**全量**事件（携带 sessionId），
  每连接 drain task 按订阅集合过滤；连接级缓冲为 `mpsc::channel(512)`，
  满则丢 Delta（`drop_class_of`，`buffer.rs:36-42`）保 Critical——
  **复用既有丢帧哲学，跨端语义一致**。
- **进程内参考**：订阅者管理（修剪 / 满通道丢帧记日志）对齐
  `EventStreamBroadcast`（`wait_channel.rs:201-272`）。

### 10.5 多连接管理

- 连接注册表：`ServerState.connections: Mutex<HashMap<conn_id, ConnInfo>>`
  （conn_id、token hash、label、subscribed sessions、connectedAt、lastFrameAt）。
- 上限：全局 8（`MAX_WS_CONNECTIONS`）；【裁决修正 3】连接模型 = **每设备一主连接 +
  会话级多流**（M3 §7.5.4 连接族语义）：同 kind 重复连接踢旧（`kicked:
  duplicate-connection`），不同 kind 同设备连接族 ≤3（旧链+新链+缓冲），族外
  （不同设备）总数仍 8；原「单令牌 2」表述更新为兼容该语义；超限拒绝新连接
  （`{"type":"error","code":"conn.limit"}`）。
- 惰性清理：连接关闭即移除（drop 守卫）；drain task 退出即广播 `Closed`。
- 桌面 UI 可见：`workbench_pairing_status.connections`（label + 最近活动时间）。

### 10.6 服务端主动踢出（kick）

- 令牌撤销（§7.3）：服务端遍历连接注册表，命中该令牌的连接发
  `{"type":"kicked","reason":"token-revoked"}` 后关闭——撤销即时生效。
- 配对关闭 / 服务关闭：`server-closing` 帧（§5.3）。

### 10.7 性能边界（事件量大时的行为）

- 序列化零重复：payload 字符串在引擎层已序列化（`engine.rs:1667`），广播只
  clone `String`（广播通道内部 Arc 式共享 + 每订阅者 clone），WS 帧无二次序列化。
- 洪峰实测参考：缓冲桥压力测试 20 万条 delta 入队（`buffer.rs:359-444`，
  stress 用例）证明「丢帧只丢 Delta、Critical 必达」——WS 面继承该语义，
  连接级缓冲 512 满时丢 Delta 类帧，`message-end` / `run-terminal` / 审批 /
  审计必达（重放兜底）。
- 慢消费者：单连接网络慢（WiFi 弱）→ 连接级缓冲满 → 丢 Delta → 客户端下次
  重放补缺口（若有落库）或靠 message-end 兜底（未落库）——**不会阻塞引擎
  发射路径**（publish 非阻塞 + drain 独立 task）。
- 服务端 CPU：每连接 drain task 仅在收到帧时唤醒；广播空转无唤醒开销。

---

## 11. 与现有代码的融合（文件:行号清单）

本章逐点给出**改动位置 / 改动内容 / 影响面**。全部改动收敛在：壳新增 `server`
模块 + `main.rs` setup 两处接线 + 壳 Cargo.toml 依赖；**引擎与存储零改动**。

### 11-A 事件桥（核心融合点，引擎侧零改动）

| 位置 | 现状 | 改动 |
|---|---|---|
| `core_event_bridge.rs:51-54`（Emitter trait） | 唯一发射抽象 | **不改**（FanOutEmitter 实现它） |
| `core_event_bridge.rs:57-81`（TauriEmitter） | webview 通道 | 不改 |
| `core_event_bridge.rs:88-145`（EventBridge） | 信封序列化 + 发射 | 不改；`emit_payload`（:137-144）是汇聚点 |
| `engine.rs:1643-1704`（BufferedRunEventBridge） | run 级缓冲桥 | **不改**（flush 走桥） |
| `engine.rs:1716-1741`（BridgeDeltaSink） | 实时轨 | 不改 |
| `engine.rs:1574-1628`（timer/cron drain） | 旁路直发 | 不改 |
| `core_run_commands.rs:3142-3149`（审批实时预览） | 旁路直发 | 不改 |
| `main.rs:345-348`（EventBridge 构造） | `EventBridge::new("workbench-run-event", Arc::new(TauriEmitter::new(app_handle)))` | **改动**：改为先构造 `WsBroadcast`，再包 `FanOutEmitter::new(vec![tauri_emitter, ws_broadcast])` 传入 `EventBridge::new` |
| `main.rs:388-391`（bridge manage） | 原值入管 | 不改（bridge 为 clone 语义） |

改动后数据流：引擎任意发射 → `EventBridge::emit_payload` → `FanOutEmitter::emit`
→ `TauriEmitter.emit`（webview）+ `WsBroadcast.publish`（WS 全部订阅者）。
**一次改动，全事件流（41 变体、实时轨、旁路）自动双通道。**

### 11-B 命令 handler 结构（REST 直调契约体）

| 位置 | 现状 | 服务侧用法 |
|---|---|---|
| `core_run_commands.rs:3043`（run_task_impl） | 契约体，`Arc<CoreRunState>` 入参 | POST /v1/runs 直调；State 解包在 `core_backend.rs` 完成 |
| `core_run_commands.rs:3605`（run_control_impl） | 契约体 | POST /v1/runs/{id}/control 直调 |
| `core_run_commands.rs:3706`（core_cancel_run） | `#[tauri::command]` | 直调（先解包 `active_run` 所需状态——见下注） |
| `core_run_commands.rs:3750`（core_approve_tool） | `#[tauri::command]` | 直调 |
| `core_run_commands.rs:3777`（core_deny_tool） | `#[tauri::command]` | 直调 |
| `core_query_commands.rs:277`（core_get_status） | `#[tauri::command]`，多 State 入参 | 后端实现里以 `State` 之外的参数构造（服务侧有全部依赖实例的 Arc 引用：core/diagnostics/gatekeeper/compaction/search/db） |
| `core_query_commands.rs:511/546/595`（分页三命令） | `#[tauri::command]`，`State<Arc<CoreRunState>>` | 直调（解包后） |
| `session_commands.rs:116-364`（会话族） | `#[tauri::command]` + `State<SharedDb>` | 直调；SharedDb 由服务端持有 clone |
| `background.rs:2579-2659`（任务族） | 契约体 + `#[tauri::command]` | 直调契约体 |
| `workflow_commands.rs:1023-1132` | `#[tauri::command]` + State | 直调（服务端持有 WorkflowCommandState 引用） |
| `catalog_commands.rs:43-76` | `#[tauri::command]` | 直调（ModelCatalog RwLock 引用） |
| `command_manifest.rs:188-194`（core_list_commands） | 无状态 | GET /v1/commands 直调 |

> 注：`core_cancel_run` / `core_approve_tool` / `core_deny_tool` 当前签名直接以
> `tauri::State` 解包（`core_run_commands.rs:3706-3711`），服务侧可经
> `active_run(state.inner(), …)` 等价调用；若实现轮发现签名阻碍，按
> `run_control_impl` 先例拆出 `*_impl` 契约体（函数体不变，仅加薄包装）——
> 属壳内重构，不动引擎。

### 11-C state 管理（服务状态不进 app.manage）

- 服务自身状态（端口/绑定模式/配对码/令牌表/连接注册表/广播句柄）由
  `ServerState`（`server/mod.rs`）自持，**不混入 `app.manage`**——现有 11 个托管
  状态（§2.6）职责单一（CoreRunState 等），服务状态生命周期与监听 socket 绑定，
  自持更内聚。
- 服务需要的外部依赖以构造参数注入（setup 时克隆）：
  `Arc<CoreRunState>`（main.rs:388 已 manage，服务侧另持 Arc 引用）、
  `SharedDb`（main.rs:390）、`Arc<BackgroundTaskRegistry>`（main.rs:391）、
  `WorkflowCommandState`（main.rs:418）、`Arc<RwLock<ModelCatalog>>`（main.rs:422）、
  `tauri::AppHandle`（`app.handle().clone()`，先例 main.rs:291）。
- 只读消费（status/诊断）的 `StatusDiagnostics`（main.rs:342）同样注入，服务
  启动失败可 `record("server", false, …)`。

### 11-D restore / 生命周期（门禁语义不变）

- `run_restore`（`core_run_commands.rs:2082-2141`）在 setup 内经
  `tauri::async_runtime::spawn` 异步执行（main.rs:379-384）——服务监听不等待它；
  run 类 API 的「restore 完成前拒绝」由 `run_task_impl` 内既有检查
  （`core_run_commands.rs:3071`）天然保证，REST 层映射为 409，**不重复实现**。
- WS 重放依赖 events 表数据：restore 完成与否只影响重放完整性（增量重放以锚点
  补足，`core_run_commands.rs:2193-2221` 的会话级锚点语义），不影响配对与令牌。
- 退出钩子（main.rs:467-473）：新增 server shutdown 步骤（§5.3），顺序为
  服务关闭 → `pty::kill_all_sessions()`（main.rs:468）→ 快照保存（main.rs:471）。

### 11-E Cargo.toml 依赖（壳 + dev）

`apps/agent-workbench/src-tauri/Cargo.toml`：

```toml
[dependencies]
# D2 本地服务化：axum 0.8 最小 feature 集（PE-10 纪律，选型论证见 §6.2）
axum = { version = "0.8", default-features = false, features = ["ws", "json", "http1", "tokio"] }
# CSPRNG（配对码 / 令牌生成）：rand = "0.9"（或经 windows-sys BCryptGenRandom，实现轮二选一）

[dev-dependencies]
# WS 集成测试客户端（与 conex-browser 锁文件同版本，零新增锁条目）
tokio-tungstenite = "0.26"
```

workspace `Cargo.toml`（`Cargo.toml:51-88`）如走 workspace.dependencies 登记需按
PE-10 在注释登记理由；建议先壳级直引（本壳是唯一消费者）。

### 11-F CSP 与端口（零改动）

`tauri.conf.json:29` 的 CSP 已含 `http://127.0.0.1:8765` / `ws://127.0.0.1:8765`——
服务默认端口与 CSP 对齐，桌面 webview 直连**无需改 CSP**。
（配对模式为 0.0.0.0 时 webview 仍走 loopback 同端口，无影响。）

### 11-G 命令登记（新增 GUI 命令面）

- 新增 `workbench_pairing_status` / `workbench_pairing_enable` /
  `workbench_pairing_disable` / `workbench_pairing_revoke_token` 四条 GUI 命令：
  - 注册进 `command_registry!`（main.rs:90-209 追加条目）；
  - 登记进 `COMMAND_MANIFEST`（command_manifest.rs:68-186）；
  - 同步前端 `commandManifest.ts` 内置镜像（command_manifest.rs:3-8 的双端同步
     机制；条数测试 `command_manifest.rs:209-210` 的公式化断言需同步更新 95 → 99）；
  - 镜像测试链：`main.rs:485-499`（注册面一致性）自动覆盖注册正确性。
- 服务暴露面（REST 路由）**不进 manifest**：路由表是 `server/router.rs` 的真源
  （§9.7 的 ROUTE_COMMAND_INDEX + 幽灵路由测试），避免双端清单同步成本蔓延。

### 11-H 现有测试资产的影响

- `tests/event_bridge_contract.rs`（590 行）与 `tests/config_command_names_contract.rs`：
  不触碰；FanOutEmitter 新增不改变既有契约断言（RecordingEmitter 先例可复用于
  fan-out 单测）。
- 主仓库 tests/e2e 五个 markdown-editor 专项 spec：无关，不动。
- 快层门禁（typecheck + vitest）与 Rust `cargo test --workspace`：新增代码
  必须全绿；`server/router.rs` 等经 `#[path]` 独立编译的测试默认进常规
  `cargo test`（不 `#[ignore]`，区别于 `buffer.rs:359-444` 的 stress 用例）。

---

## 12. 安全边界

### 12.1 绑定面（127.0.0.1 vs 0.0.0.0）

| 模式 | 绑定 | 可达面 | 启用条件 |
|---|---|---|---|
| 默认 | `127.0.0.1:8765` | 仅本机进程（含 webview） | 应用启动恒启 |
| 配对 | `0.0.0.0:8765` | 局域网全部设备 | 用户显式开启配对（§5.4） |

- loopback 模式不监听外部接口：不触碰系统防火墙（Windows 默认放行 loopback）。
- 配对模式首次 0.0.0.0 监听会触发 Windows 防火墙弹窗（私网/公网选择）——桌面 UI
  在开启配对前提示用户；**v1 不自动申请防火墙豁免**（诚实边界，避免静默开洞）。
- 绑定地址变更（loopback ↔ 0.0.0.0）经优雅重启监听实现（§5.4），期间已有 WS
  连接断开并收到 `server-closing`，客户端按重连流程恢复。

### 12.2 令牌鉴权（主防线）

- 全量 `/v1/**`（除 `/v1/pair` 与 loopback-only 的 `/v1/info`）要求
  `Authorization: Bearer`；校验 = SHA-256 比对令牌表哈希 + revoked 检查 + 常量
  时间比较（§7.3）。
- 失败统一 401 + `{"error":{"kind":"Auth","detail":"…"}}`；**不区分**「令牌不存在」
  与「令牌已撤销」（防枚举）。
- WS 连接同样鉴权（query token），且握手后不可变（连接生命周期内绑定令牌身份）。

### 12.3 Origin 校验（防浏览器侧跨站滥用）

- loopback 模式：恶意网页（`https://evil.example`）可发请求到
  `http://127.0.0.1:8765`——浏览器 SOP 会挡住**读响应**，但 POST 请求（如
  `POST /v1/runs`）仍会发出（CSRF 类）。防线：
  1. **非简单请求**（JSON Content-Type + Authorization 头）触发预检 OPTIONS——
     CORS 未放行 → 预检失败 → 真实请求不发；移动端原生客户端无此限制；
  2. WS 无法携带自定义头（浏览器 API 限制），但服务端校验 Origin 头
     （非 `null` / 非白名单 Origin 拒绝握手）——双保险；
  3. token 在 Authorization 头，恶意网页**无法读取本地令牌**（SOP），无法携带；
  4. 深度防线：`GET /v1/info` 免鉴权仅暴露最小信息，不返回令牌/配对码。
- 结论：浏览器发起的所有请求均缺少 token → 401；预检 + Origin 双保险已覆盖
  CSRF 向量。文档化威胁模型（§12.8 条目 1）。

### 12.4 配对握手防护

- 配对码规格【裁决修正 1】：以 D3 §4.1 为准——CXN-XXXX-XXXX-XXXX 12 字符 base32、
  10 分钟 TTL、60bit、单码 5 次失败上限（锁定 60s）；原「8 字符 / 31 字符集 / 120s」
  作废；`/v1/pair` 按连接源 IP 限速（10 次/分钟）。
- 配对窗口只签发**一枚**令牌（并发配对请求互斥：状态机 awaiting 期间拒绝
  重复 pair_verify，§7.2）。
- 配对码**永不落盘**（内存态，进程退出即失效）；二维码内容不含令牌。

### 12.5 令牌存储（桌面侧）

- 只存哈希（§7.3 `pairing.json`）；文件 ACL 收紧（0600）；`config_dir()`
  与既有配置文件同目录（`config/persistence.rs:39-51`），不新增目录面。
- 撤销即时生效（§10.6 kick）；关闭配对 = 全令牌失效（§5.4）。
- 演进项：DPAPI 加密落盘（Windows）、keychain（macOS）——v1 不阻塞。

### 12.6 多连接管理

- 全局上限 8 连接、单令牌 2 连接（§10.5）；超限拒绝并记录诊断。
- 每连接独立缓冲（512）+ 丢帧策略（Delta 可丢 / Critical 必达，§10.4）；
  慢消费者不拖累发射路径。
- 连接注册表含 token 哈希与 label——撤销/审计可定位设备。

### 12.7 审计与可观测

- 服务事件（配对成功/失败、令牌签发/撤销、连接建立/断开、鉴权失败）经
  `tracing`（target: "server"，与既有 target 风格一致，如 `main.rs:232`、
  `core_event_bridge.rs:73`）留痕；
- 鉴权失败连续 5 次（同 IP 5 分钟窗口）→ 记录 `StatusDiagnostics.record`
  （status_diagnostics.rs:97-155）并临时拉黑该 IP 10 分钟（仅配对模式生效；
  loopback 模式 IP 恒为本机，不拉黑）。

### 12.8 威胁模型与演进

| # | 威胁 | v1 对策 | 演进 |
|---|---|---|---|
| 1 | 浏览器 CSRF（loopback） | 预检 + Origin 校验 + token 不可读（§12.3） | CORS 严格白名单 |
| 2 | 局域网窃听（配对模式） | 信任模型声明：配对视作同可信网络 | 【裁决修正 11】**wss 强制 + 自签 CA pinning（配对时建立信任，D3 §4.6 tlsFingerprint）**，R1 即生效；「免 TLS 信任模型」不再作为 v1 基线 |
| 3 | 令牌文件泄露 | 哈希存储 + ACL | DPAPI / keychain |
| 4 | 暴力猜测配对码 | 40bit 熵 + TTL + 锁定 + 限速 | 增加二次确认码 |
| 5 | 恶意本地进程 | token 鉴权（进程无法读取令牌文件时不可用；可读则与用户同等权限——声明为威胁面） | 按会话最小令牌作用域 |
| 6 | 拒绝服务（洪峰连接） | 连接上限 + 缓冲上限 + 丢帧 | 每令牌带宽配额 |
| 7 | 服务端信息泄露 | `/v1/info` 最小化；错误不带内部路径 | — |

---

## 13. 测试与验证

### 13.1 测试层次

**L1 纯单元（无 Tauri、无网络）**
- `fanout.rs`：多发射器分发（RecordingEmitter 先例 `tests/event_bridge_contract.rs:48-66`
  ——断言 TauriEmitter 与 WsBroadcast 都收到同一 payload 字符串；单发射器失败不影响
  其余）。
- `auth.rs` / `pair.rs`：配对状态机全路径（生成→等待→成功 / TTL 过期 / 失败锁定 /
  重复 pair 拒绝）；令牌哈希 roundtrip、撤销、常量时间比较路径。
- `ws.rs` 订阅过滤：事件 → 订阅集合过滤矩阵；游标计算（resume 缺失会话 / 空游标）。
- `router.rs` 参数校验：非法 sessionId（`ID_MAX_LEN` 512，`core_query_commands.rs:47`）、
  越界 maxEvents 夹紧（`core_query_commands.rs:475-479`）——**与既有纯函数测试同构**
  （`core_query_commands.rs:823-854` 先例）。

**L2 路由集成（无 Tauri，经 `#[path]` 独立编译，MemoryBackend）**
- `tests/server_integration.rs` 新文件，模式对齐 `tests/event_bridge_contract.rs:28-40`：
  - 装配：`Router::new(Arc<MemoryBackend>, Arc<ServerState>)` →
    `axum::serve(listener(127.0.0.1:0))` → reqwest 客户端（壳已有依赖）。
  - 用例：/v1/status、会话读写 roundtrip、run 发起（MemoryBackend 假 producer）、
    control/cancel/approve/deny 各路径、401（无令牌/坏令牌/撤销令牌）、
    pair 握手成功/失败/锁定、/v1/commands 透传、分页游标。
- **模拟连接端断言事件流（任务书点名要求）**：WS 集成测试——
  tokio-tungstenite 客户端（dev-dependency）连 `ws://127.0.0.1:0/v1/events?token=…`；
  用例：
  1. 订阅后 MemoryBackend 经 FanOutEmitter 灌事件 → 客户端收到 `event` 帧，
     载荷与 `EventBridge::serialize` 输出逐字节一致；
  2. 预置 store 事件（seed）→ 订阅带 resume 游标 → 收到 `replay` +
     `catchup{lastSequence}`，再灌实时事件 → 顺序为重放先实时后；
  3. 断线重连续传：客户端记录 lastSequence → 断开 → 重连订阅 → 断言重放
     恰好从 lastSequence+1 起；
  4. Delta 丢帧：灌 600 条 message-delta + 1 条 message-end，连接级缓冲
     512 → 断言 message-end 必达、delta 不全达（丢帧可观测）；
  5. 踢出：撤销令牌 → 客户端收到 `kicked` 且连接关闭；
  6. 心跳：pong 响应。
- 测试内建超时（tokio time::timeout）防悬挂；默认进 `cargo test`（不 ignore）。

**L3 壳级（Tauri 环境）**
- `tauri::test`（feature 已开，`src-tauri/Cargo.toml:22`）：`config_command_names_
  contract.rs` 同款 mock runtime——验证 setup 装配（ServerState 构造、EventBridge
  换 FanOutEmitter 后 webview 通道仍工作）与退出钩子顺序（服务关闭先于快照）。
- 注册面一致性：`main.rs:485-499` 自动覆盖新增命令的注册正确性；
  `command_manifest.rs:203-215` 条数断言同步更新。

**L4 手动端到端（验收清单）**
1. `npm run tauri dev` 启动 → 本机 `curl http://127.0.0.1:8765/v1/info` 有响应；
2. 未带令牌访问 `/v1/status` → 401；
3. 开启配对 → 二维码出现 → 用任意 WS 客户端（wscat/websocat）完成 pair 握手 →
   拿令牌；
4. 令牌连 `/v1/events` 订阅 → 桌面发起 run → 手机端看到完整事件流；
5. 审批场景：run 触发工具审批 → 手机端 approve → 桌面端即时收到
   approval-resolved；
6. 手机断 Wi-Fi → 重连 → 事件从断点续传；
7. 桌面退出 → 重开 → 手机 token 仍有效，续传无缝；
8. 关闭配对 → 手机全部连接被踢、令牌失效；
9. 8765 被占用（`netstat` 占位）→ 启动后服务落在 8766，/v1/info 反映实际端口。

### 13.2 测试门禁与 CI

- 新增测试全默认执行（快层 `cargo test -p crish-agent-workbench`）；
- `server_integration.rs` 若耗时超预算（>60s），标记 `--ignored` 并入中层手动
  门禁——但**契约类断言（鉴权/游标/踢出）不得 ignore**（资产铁律）；
- 回归红线：`cargo test --workspace`（73 套件基线）不得因本改造变红；
  前端门禁（typecheck / vitest）不受影响（前端仅新增 4 条配对命令清单同步）。

---

## 14. 风险与缓解

### 14.1 与并行开发中 conex-browser 的冲突面

| 冲突面 | 分析 | 缓解 |
|---|---|---|
| `Cargo.lock` 共同改动 | conex-browser 已入 lock（浏览器 CDP 栈），服务化新增 axum/tokio-tungstenite 也会动 lock | tokio-tungstenite 复用既有锁定版本（§6.1）；axum 属独立子树，冲突面小；提交时按仓库节奏合并，避免 lock 半途状态 |
| 壳 `Cargo.toml` 改动 | 服务化必改壳依赖 | 改动集中在壳级 dependencies 追加段（§11-E），不与 browser 的 crates 级改动同文件冲突；若 browser 轮也改壳（如接工具注册），约定串行提交 |
| 端口面 | browser CDP 用 ephemeral 端口（CDP 动态分配），不与 8765 冲突 | 服务端口 8765-8775 探测机制兜底（§5.1） |
| 工具注册表 | browser-tools 注册 `browse_*` 工具进 agent-tools registry（并行开发中） | 服务化不触碰工具注册面；审批/写路径语义由引擎既有链保证 |
| 事件契约 | 双方都消费 AgentEvent 41 变体 | 服务化**不新增事件变体**（§3.2）；browser 若新增事件走既有注册表流程，WS 推送自动兼容（信封 schemaVersion 机制） |

### 14.2 性能风险

| 风险 | 分析 | 缓解 |
|---|---|---|
| delta 洪峰拖垮 WS | 缓冲桥压力实测 20 万 delta 场景（`buffer.rs:359-444`） | 连接级缓冲 512 + Delta 丢帧（§10.7）；publish 非阻塞；每连接独立 drain task |
| 重放风暴（大会话） | 单会话 10 万事件重放占带宽 | 分批推送（1000/批）+ 每会话 pending 缓冲；移动端按需订阅（§10.2 sessions 过滤） |
| 发射路径延迟 | FanOutEmitter 同步遍历 + broadcast send | broadcast send 是 O(订阅者) 的原子操作（锁短临界区），订阅者 ≤8，开销可忽略；序列化已前置（§10.7） |
| DB 并发读 | 重放查询与引擎 append 同库 | LocalDb 单连接 Mutex + spawn_blocking（§2.5）；查询带 limit（`events.rs:52`）；重放为低频操作 |

### 14.3 移动端消费风险

- **带宽**：message-delta 全量推给手机（WiFi 场景一般够用）——演进项：服务端
  delta 合并（30Hz 节流），v1 不做（保持与桌面事件流逐字节一致）；
- **弱网断连**：靠 token + 游标重连自愈（§10.3）；断线期间审批超时（120s，
  `core_run_commands.rs:3153` 注释）→ 移动端 UX 需提示「审批可能已过期」；
- **双端同会话并发**：会话串行守卫（`core_run_commands.rs:3083-3090`）保证同一
  会话单 run；双端审批裁决竞态由 approval-resolved 幂等落库兜底
  （`core_run_commands.rs:3802-3835`）。

### 14.4 依赖与维护风险

- axum 版本演进（0.8 → 0.9 断代）：router.rs 是唯一 axum 接触面（backend trait
  隔离），升级成本局部化；
- 命令面双真源（manifest + ROUTE_COMMAND_INDEX）：幽灵路由测试（§9.7）防止
  漂移；manifest 只登记 GUI 配对命令（4 条），服务路由不进 manifest（§11-G）——
  双端同步成本可控；
- server.json / pairing.json 的 schema 演进：加 `version` 字段（§7.3），解析
  未知字段宽容（对齐 `PersistedProviderConfig` 的 serde 缺省风格，
  `config/persistence.rs:20-29`）。

---

## 15. 分阶段实施计划

> 【裁决修正 9】阶段命名统一为 AU3 R0-R5：本方案的 P0-P5 与 R 阶段映射如下——
> P0 评审 → R0（协议冻结期评审）；P1 服务骨架 → **R1 桌面服务端**；
> P2 REST T1 全量 → R1；P3 WS 续传 + 配对 UI → R1；P4 配对模式 → R1；
> P5 加固演进 → R1 收尾 / R3 前（推送依赖常驻接线）。任务书引用一律使用 R 阶段号。

| 阶段 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| P0 | 本文档评审定稿 | 评审通过；文件:行号全部复核 | 无 |
| P1 | 服务骨架：server 模块 + FanOutEmitter + loopback 监听 + /v1/info + /v1/hello + 令牌存储（auth.rs/pair.rs 基础）+ L1/L2 测试基建 | loopback 服务随应用启停；/v1/info 可达；401 正确；单测全绿 | 壳 Cargo.toml（axum/tokio-tungstenite dev） |
| P2 | REST T1 全量（§9.3/9.5/9.6 核心）+ core_backend + router 全 handler + WS 基础（订阅/广播/心跳） | 移动端可完成「查状态 → 列表会话 → 发起 run → 收事件 → 审批」闭环；server_integration 全绿 | P1 |
| P3 | WS 续传（replay/catchup/resume 游标/断线重连）+ 踢出 + 连接管理上限 + 配对 UI 命令四件套（§11-G） | §13.1 L4 清单 1-9 手测通过；manifest 条数同步 95→99 | P2 |
| P4 | 配对模式（0.0.0.0 重绑 + 二维码 + 防火墙提示 + 撤销全链）+ T2 子集（任务操作/工作流管理/trash/catalog/md） | 局域网手机实测完整闭环；安全评审（§12 核对表） | P3 |
| P5 | 加固与演进：限速/拉黑、CORS 白名单、DPAPI 密钥槽、delta 节流、T4 只读文件面（显式授权）、性能压测（复刻 buffer stress 规模） | 压测报告 + 安全评审结论 | P4 |

里程碑红线：P2 完成 = 「移动端可跑」第一里程碑；P4 完成 = 「局域网可配」。

---

## 16. 附录

### 16.1 常量表

| 常量 | 值 | 出处/理由 |
|---|---|---|
| 默认端口 | 8765 | CSP 预留（`tauri.conf.json:29`） |
| 端口探测范围 | 8765-8775 | §5.1 |
| 配对码长度/字符集 | CXN-XXXX-XXXX-XXXX 12 字符 base32（D3 §4.1） | §7.2；【裁决修正 1】原 8 位/31 字符作废 |
| 配对码 TTL | 10 分钟（D3 §4.1） | §7.2；原 120s 作废 |
| 配对失败锁定 | 单码连续 5 次 / 锁定 60s（D3 §4.1） | §7.2 |
| 令牌 | 32 字节 CSPRNG → hex 64；会话令牌语义收敛为 D3 §5.1 token_key 派生体系 | §7.3 |
| 广播容量 | 1024 | §10.4 |
| 连接级缓冲 | 512（丢 Delta 保 Critical） | §10.4 |
| WS 连接上限 | 全局 8 / 单令牌 2 | §10.5 |
| 心跳 | 30s ping / 90s 无帧关断 | §10.2 |
| 重放批次 | 1000（MAX_PAGE_SIZE） | `core_query_commands.rs:45` |
| 重连退避 | 1s/2s/4s…上限 30s | §10.3 |
| 优雅关闭超时 | 2s | §5.3 |

### 16.2 协议示例（WS 断线续传时序）

```
移动端                     桌面服务
  │── WS connect ?token= ────► 200 101
  │◄─ {"type":"welcome","protocolVersion":1,…}
  │── {"type":"subscribe","sessions":["s-1"],"resume":{"s-1":42}} ─►
  │◄─ {"type":"subscribed","sessions":["s-1"]}
  │◄─ {"type":"replay","sessionId":"s-1","events":[seq43,…,seq100]}
  │◄─ {"type":"catchup","sessionId":"s-1","lastSequence":100}
  │◄─ {"type":"event","payload":{…sequence:101…}}   ← 实时尾随
  …（断线 30s）…
  │── WS connect ?token= ────►（令牌仍在 → 放行）
  │── {"type":"subscribe",…,"resume":{"s-1":101}} ─►
  │◄─ replay seq102… → catchup{…} → 实时恢复
```

### 16.3 术语

| 术语 | 含义 |
|---|---|
| 契约体（*_impl） | 与 Tauri 解耦的命令实现函数（可直调/单测），先例 run_task_impl |
| FanOutEmitter | 实现 Emitter trait 的多发射器分发器（webview + WS） |
| 配对模式 | 服务以 0.0.0.0 绑定并开放配对握手的模式（默认关闭） |
| 游标 | (sessionId, sequence) 对，与 events 表 UNIQUE 约束同语义 |
| Delta/Critical | 事件背压分级（buffer.rs:24-30），WS 面沿用 |

### 16.4 引用索引（本设计引用的关键代码位）

| 文件:行号 | 用途 |
|---|---|
| `apps/agent-workbench/src-tauri/src/main.rs:90-209` | 命令注册面真源 |
| `apps/agent-workbench/src-tauri/src/main.rs:353-356` | EventBridge 构造点（fan-out 接入点） |
| `apps/agent-workbench/src-tauri/src/main.rs:381` | restore 异步 spawn 先例 |
| `apps/agent-workbench/src-tauri/src/main.rs:388-391` | app.manage 状态注入 |
| `apps/agent-workbench/src-tauri/src/main.rs:430-441` | timer/cron drain 任务（tauri runtime 内循环先例） |
| `apps/agent-workbench/src-tauri/src/main.rs:467-473` | 退出钩子（服务关闭接入点） |
| `apps/agent-workbench/src-tauri/src/core_event_bridge.rs:51-54` | Emitter trait（FanOutEmitter 实现面） |
| `apps/agent-workbench/src-tauri/src/core_event_bridge.rs:107-144` | 信封序列化 + emit_payload 汇聚点 |
| `apps/agent-workbench/src-tauri/src/engine.rs:1643-1704` | BufferedRunEventBridge（零改动） |
| `apps/agent-workbench/src-tauri/src/engine.rs:1716-1741` | BridgeDeltaSink 实时轨（零改动） |
| `apps/agent-workbench/src-tauri/src/engine.rs:1114/1157/1574` | try_current runtime 探测模式 |
| `apps/agent-workbench/src-tauri/src/buffer.rs:36-42` | drop_class_of（WS 丢帧分级复用） |
| `apps/agent-workbench/src-tauri/src/buffer.rs:200-206` | 默认水位 |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1373-1480` | CoreRunState 字段面 |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:2082-2141` | run_restore |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3043` | run_task_impl 契约体 |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3071` | restore 门禁（REST 409 映射） |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3083-3090` | 会话串行守卫 |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3142-3149` | 审批实时预览旁路 |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3605/3706/3750/3777` | run_control/cancel/approve/deny |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3802-3835` | approval-resolved 落库+发射 |
| `apps/agent-workbench/src-tauri/src/core_query_commands.rs:43-47` | 分页常量 |
| `apps/agent-workbench/src-tauri/src/core_query_commands.rs:277-322/511-539/546-588/595-631` | 查询命令面 |
| `apps/agent-workbench/src-tauri/src/session_commands.rs:41-75/116-364` | SharedDb 与会话族命令 |
| `apps/agent-workbench/src-tauri/src/background.rs:2579-2659` | 后台任务契约体 |
| `apps/agent-workbench/src-tauri/src/workflow_commands.rs:1023-1132` | workflow 命令面 |
| `apps/agent-workbench/src-tauri/src/catalog_commands.rs:43-76` | 模型目录命令面 |
| `apps/agent-workbench/src-tauri/src/command_manifest.rs:68-186` | 命令清单真源 |
| `apps/agent-workbench/src-tauri/src/dev_mcp.rs:21-71` | env 门控 + loopback + token 边车先例 |
| `apps/agent-workbench/src-tauri/src/wait_channel.rs:201-272` | EventStreamBroadcast（进程内广播先例） |
| `apps/agent-workbench/src-tauri/src/config/persistence.rs:39-51` | config_dir 解析 |
| `apps/agent-workbench/src-tauri/tests/event_bridge_contract.rs:28-74` | #[path] 独立编译 + RecordingEmitter 先例 |
| `apps/agent-workbench/src-tauri/tauri.conf.json:29` | CSP 预留 8765 |
| `apps/agent-workbench/src-tauri/Cargo.toml:17-58` | 壳依赖（axum/tokio-tungstenite 追加点） |
| `crates/conex-types/src/events.rs:290-782/905-992/867-893` | AgentEvent 41 变体 / 信封 / 背压 |
| `crates/conex-db/src/schema.rs:17-27/141-151` | events 表 UNIQUE(session_id, sequence) |
| `crates/conex-db/src/events.rs:33-68/72-99` | query_events（游标原语）/ reserve_sequence |
| `crates/orchestrator/src/persist.rs:127-212/572-581/588-757` | Store trait / spawn_blocking / LocalDbStore |
| `Cargo.toml:58-66` | workspace reqwest/tokio 声明 |
| `Cargo.lock`（2026-08-09 快照） | hyper / tokio-tungstenite 已在依赖图 |

---

*文档结束。设计决策复核要点：① 引擎零改动（事件桥汇聚点 fan-out）；② 命令体直调
（不建第二套运行语义）；③ 游标 = 会话内 sequence（复用既有查询原语）；④ 默认
loopback-only + 配对显式开启；⑤ 服务核心经 backend trait 隔离可无 Tauri 测试。*


