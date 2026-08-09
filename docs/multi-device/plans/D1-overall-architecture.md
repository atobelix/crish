# D1 多端互通总体架构方案（母方案）

> 文档状态：草案 v0.1（2026-08-09）
> 产出路径：`docs/multi-device/plans/D1-overall-architecture.md`
> 定位：多端互通维度的**母方案**——其他维度方案（端上客户端、服务网关、配对协议、事件扇出、远程审批、中继服务等）均以本方案为纲展开。本方案只做总体裁决与融合点锚定，不替代子方案细节。
> 代码事实源：全部融合点结论均来自对本仓库代码的实读（`crates/**`、`apps/agent-workbench/src-tauri/**`、`apps/crish-desktop/src/**`、`packages/**`），引用格式统一为「仓库相对路径:行号」，可逐条复核。

---

## 目录

1. [概述](#1-概述)
2. [端模型](#2-端模型)
3. [通信拓扑](#3-通信拓扑)
4. [身份与会话模型](#4-身份与会话模型)
5. [端间一致性模型](#5-端间一致性模型)
6. [与现有架构的融合点（文件:行号证据）](#6-与现有架构的融合点文件行号证据)
7. [可扩展性](#7-可扩展性)
8. [风险与演进路线](#8-风险与演进路线)
9. [附录](#9-附录)

---

## 1. 概述

### 1.1 背景与现状

crish 桌面端（本仓库）当前是一个**单一进程、单一 WebView、零对外服务接口**的 Tauri 应用：

- **Rust 引擎**（`crates/`）：`session-loop`（Agent 会话循环）、`orchestrator`（run 生命周期/事件队列/persist）、`agent-provider`（provider 适配）、`conex-db`（SQLite 会话存储）、`conex-types`（域事件契约，双端唯一事实源）等 15 个 crate；
- **Tauri 壳**（`apps/agent-workbench/src-tauri/`）：全部能力以 `#[tauri::command]` IPC 命令面暴露给前端（`main.rs` 注册面，见 `apps/agent-workbench/src-tauri/src/main.rs:90-209`），事件经 `app.emit("workbench-run-event", payload)` 广播（`apps/agent-workbench/src-tauri/src/core_event_bridge.rs:68-81`）；
- **React 前端**（`apps/crish-desktop/src/`）：经 `Transport` 抽象层（`apps/crish-desktop/src/api/transport/types.ts:47-83`）直调命令 + 订阅事件通道，无 WebSocket、无网络层（`apps/crish-desktop/src/api/transport/tauriTransport.ts:17` 明言"不依赖 WebSocket：无心跳、无重连（进程内核心，断连即应用退出）"）。

**目标**：多端互通——桌面主端 + 移动伴侣端 + 未来更多端（Web 面板 / CLI / 第二桌面）。移动端可远程审批、查看事件流、终端输出、文件浏览、消息通知等。本方案回答"多端如何组织、如何通信、如何互信、如何一致、如何融入现有架构"五个总体问题。

### 1.2 核心决策摘要（TL;DR）

| 维度 | 裁决 | 理由（详见章节） |
|------|------|------------------|
| 端间主从 | **桌面主端 = 权威中枢（Hub），移动端 = 伴侣（Companion），严格主从** | 执行/存储/审批全在桌面；移动端无本地引擎副本（§2） |
| 通信拓扑 | **局域网直连优先（桌面内置 TLS WebSocket 服务）+ 云中继兜底（WebSocket 长连接）**；P2P/WebRTC 列为远期增强 | 低延迟、零云成本、隐私；中继保异地可达（§3） |
| 身份 | **用户（本地 user，预留云账号绑定）× 设备（Ed25519 密钥对） × 会话 三元模型**；配对 = 短期 PIN/二维码 + 密钥交换 + 设备记录 | 无账号体系下实现设备互信与撤销（§4） |
| 一致性 | **桌面为单一真相源（SoT）**；事件流 = 会话内单调 `sequence` + 游标追赶；命令 = 请求-响应 + 幂等键；审批 = 已鉴权命令复用现有 resolve 入口 | 现有架构已内建 SoT 与 sequence 机制（§5、§6.5） |
| 跨端事件基 | **直接复用 `AgentEvent` 41 变体 + `AgentEventEnvelope`（扁平 JSON）**，零协议发明 | 信封已是 wire 层扁平 JSON，且注释明确"与 daemon WS 广播同构"（§6.1） |
| 服务暴露 | **命令面按 `surface` 字段（engine/gui）分层暴露**；`surface=engine` 命令天然是服务 API 候选（§6.4） | `command_manifest.rs:33-38` 已内建三端共用语义 |
| 演进 | P0 本机原型 → P1 局域网直连 → P2 云中继 → P3 多端/Web/CLI | 每阶段独立验收、风险递进（§8） |

### 1.3 方案定位与阅读指南

- 本方案是**母方案**：只定总体裁决、边界、融合点与顺序；配对协议细节、网关实现、移动端 UI、中继服务部署等留给子方案（D2 服务网关 / D3 配对与设备管理 / D4 事件扇出 / D5 远程审批 / D6 中继服务…）。
- 第 2-5 章是纯设计（不依赖代码事实）；第 6 章是**与现有代码的融合点**，全部结论可复核；第 7-8 章是可扩展性与路线；第 9 章是术语与代码索引。
- 阅读顺序建议：先 1.2 摘要，再 2-5 定架构，6 锚定代码，7-8 定边界。

### 1.4 设计原则

1. **零协议发明**：凡是现有代码里已有的事实（事件信封、sequence 游标、命令 manifest、审批门），一律复用；多端互通只增加"传输"与"身份"两层。
2. **桌面权威不稀释**：任何端都不允许绕过桌面写入会话/运行状态；移动端的一切写操作都降级为"对桌面的命令调用"。
3. **渐进暴露**：服务面按需暴露（`surface=engine` 优先），拒绝一次性全量映射；高风险命令（shell/PTY/git 写操作）默认不暴露，需显式白名单。
4. **断连可存活**：网络不可达时移动端降级为"最后快照 + 挂起命令"，桌面端完全不受影响（桌面不依赖任何网络服务）。
5. **安全默认**：所有跨端流量走 TLS 等价强度（局域网自签证书 + 指纹固定，中继走 TLS），配对一次性完成、可撤销。
6. **兼容演进**：协议版本化从第一天就存在（复用 `schemaVersion` 信封机制），旧端新端共存不破坏。

---

## 2. 端模型

### 2.1 端类型体系

多端体系按**角色（role）**与**形态（form factor）**两个正交维度建模：

```
角色维度（决定权力边界）：
  Hub（中枢端）     —— 唯一权威：执行 Agent、持有存储与密钥、裁决审批
  Companion（伴侣端）—— 附属观测/操作端：只读投影 + 受控命令（审批、发消息、取消）
  Controller（控制端）—— 未来：CLI / 脚本 / 自动化（无 UI，命令面全量但须鉴权）

形态维度（决定能力与 UX）：
  Desktop / Mobile / Web / CLI / Second-Desktop
```

**裁决：当前与可见未来只实现 Hub + Companion 两种角色**。Controller（CLI 等）作为角色预留，形态注册表先行，实现后置（§7）。

### 2.2 各端职责边界

#### 2.2.1 桌面主端（Hub，角色：Hub）

职责（全部保留现状，多端互通**不改变**桌面内部架构）：

| 职责域 | 现状锚点（代码） | 多端下的定位 |
|--------|------------------|--------------|
| Agent 执行 | `core_run_task`（`apps/agent-workbench/src-tauri/src/core_run_commands.rs:3032-3038`）→ `run_task_impl`（同文件 3043 起）| **唯一执行端**；移动端"发消息"= 对桌面发起 run |
| 会话/事件存储 | `conex-db`（`crates/conex-db/src/schema.rs:141-266`）| **唯一存储端**；移动端只读投影 + 游标追赶 |
| 事件发射 | `EventBridge` + `TauriEmitter`（`apps/agent-workbench/src-tauri/src/core_event_bridge.rs:57-145`）| 广播源；新增 WebSocket 扇出分支（§6.2） |
| 审批裁决 | `ApprovalGateImpl`（`apps/agent-workbench/src-tauri/src/core_run_commands.rs:161-344`）| 裁决入口不变；移动端只是**新的裁决 UI 通道** |
| 密钥/身份 | （新组件）| **设备身份私钥只存在桌面**；移动端私钥只存在移动端（§4） |
| 对外服务 | （新组件：服务网关）| 唯一服务端；其他端都是客户端 |

桌面端**绝不主动连接**任何端（除中继场景的"桌面→中继"出站长连接，§3.3）；所有入站连接经服务网关鉴权。

#### 2.2.2 移动伴侣端（Companion，角色：Companion）

职责（按 P1-P3 分阶段，P1 只做最小集）：

| 能力 | 阶段 | 说明 |
|------|------|------|
| 远程审批（approval-requested → approve/deny）| P1 | 最高价值场景；复用现有审批门 resolve 路径 |
| 事件流查看（run 进展/消息/工具调用）| P1 | 只读；复用 `core_read_session_events` 分页 + 实时订阅 |
| 会话列表/状态 | P1 | 只读；复用 `list_sessions` / `core_get_status` |
| 终端输出/后台任务 | P2 | 只读；复用 `workbench_get_background_task_output` 等 |
| 文件浏览（受限）| P2 | 只读白名单；复用 `workbench_list_directory` / `read_file_content` |
| 消息通知（推送）| P2 | 中继转发或本地通知 |
| 发起新 run（发消息）| P3 | 复用 `core_run_task`（须鉴权 + 用户确认）|
| 取消 run | P3 | 复用 `core_cancel_run` / `core_run_control` |

**移动端不持有**：引擎副本、SQLite 存储、工具执行能力、设备主密钥、provider 凭据。移动端的一切"写"都是对桌面的命令调用（§5.5）。

#### 2.2.3 未来端

| 端 | 角色 | 接入方式 | 阶段 |
|----|------|----------|------|
| Web 面板（浏览器）| Companion | 同局域网直连或中继；复用 Transport 抽象 | P3 |
| CLI / 脚本 | Controller | 命令面直调（`surface=engine` 全量但逐命令鉴权）| P3+ |
| 第二桌面（另一台 PC）| Companion（远期可升级 Hub）| 中继为主（跨网）；能力协商 | P3+ |
| IoT / 自动化（如快捷指令）| Controller | 命令面子集 + 推送 | 远期 |

### 2.3 主从关系裁决：为什么不是对等（Peer）

候选三种主从模型：

| 模型 | 描述 | 优点 | 缺点 | 裁决 |
|------|------|------|------|------|
| A. 严格主从（Hub-Spoke）| 桌面唯一权威，其他端全为客户端 | 一致性简单（单一真相源）；安全面小（只有一台可信机）；实现量小（只加服务端，不改引擎）| 桌面离线则全部不可用 | **采用** |
| B. 对等（Peer）| 每端可执行、可存储，同步仲裁 | 离线可用性高 | 引擎分发/存储同步/冲突仲裁/安全面全部翻倍；与现有"单机 SQLite + 单进程"架构根本冲突；工程量不可接受 | 否决 |
| C. 主从 + 影子执行（Hub 离线时移动端可受限操作）| 移动端在断网时基于快照做只读查询/队列化命令 | 离线体验稍好 | 影子状态与真相源漂移风险；成本高 | 部分采纳：移动端**只读快照 + 命令队列化**（§3.5），不做影子执行 |

**结论**：采用模型 A（严格主从），叠加模型 C 的"断连只读投影 + 命令队列"特性。理由：一致性是架构根问题，主从模型让一致性退化为"单写者"（§5.1），与现有代码的 SoT 架构（`conex-db` 单写 + `sequence` 单调）天然吻合。

### 2.4 端能力声明（Capabilities）

每端（尤其是 Companion）在握手时声明能力集，桌面据此裁剪暴露面：

```json
{
  "deviceId": "dev-mobile-0f3a...",
  "role": "companion",
  "form": "mobile",
  "appVersion": "0.1.0",
  "protocolVersions": [1],
  "capabilities": {
    "approval": ["approve", "deny"],
    "eventView": { "pageSize": 200 },
    "runStart": false,
    "fileBrowse": { "readOnly": true, "maxDepth": 3 }
  }
}
```

能力声明是**服务网关的授权输入**（§6.4）：网关只把"该端能力 ∩ 全局白名单"暴露给该连接。能力协商失败（版本不兼容）→ 拒绝连接并返回可读原因。

### 2.5 端数量与拓扑形态

- **同一时刻活跃 Companion 数量**：P1 支持 1 个；P2 支持 ≤8 个（事件扇出为广播+按端背压，§6.2）；不做上限设计的极端规模（>32 端）不在本方案范围。
- **多 Hub 场景**：同一用户两台桌面 = 两个独立 Hub（各自的设备身份、各自的会话库），**不互相同步**；P3+ 可选"远程 Hub 代理"（Companion 连接 Hub-A，把 run 委托给 Hub-B），列为远期开放问题（§9.3）。

---

## 3. 通信拓扑

### 3.1 三种候选拓扑详评

#### 3.1.1 候选 ①：桌面端本地服务（移动端局域网直连）

**形态**：桌面进程内起一个本机服务（127.0.0.1 + 局域网 IP），监听 WebSocket（TLS）；移动端在**同一局域网**内经 `https://<桌面IP>:<port>` 直连；服务发现用 mDNS 广播或扫码引导。

**优点**：
- 延迟最低（局域网 RTT 1-10ms，审批/事件流近实时）；
- 数据不出局域网，隐私最好；
- 零云成本、零外部依赖（无中继服务可用性 SLA 问题）；
- 复用现有"进程内核心"架构——服务网关就是进程内的又一个消费者，不需要把核心拆出来。

**缺点**：
- 跨网（移动网络 / 办公网隔离）不可达；
- 局域网 IP 与端口发现、NAT/AP 隔离（如 AP 隔离开启时设备互不可见）需要处理；
- 自签名证书在移动端的信任问题（iOS/Android 对自签 TLS 默认拒绝，需指纹固定或安装描述文件）；
- 桌面睡眠/退出则不可达（移动端无"关屏推送"）。

**技术可行性（查证）**：Tauri 2 的 Rust 后端是普通 tokio 运行时，可自由内嵌 `axum`/`tokio-tungstenite` 起服务（与 `dev_mcp.rs` 在 debug 下开 socket 的先例一致，`apps/agent-workbench/src-tauri/src/dev_mcp.rs`）；移动端 WebRTC/WebSocket 支持成熟。证书指纹固定（certificate pinning）是移动端标准做法。

#### 3.1.2 候选 ②：云中继 / 信令

**形态**：一个轻量云服务（信令 + 中继）。桌面作为客户端**出站**连接中继（`wss://relay`），移动端同样出站连接同一中继；两端经中继转发消息。出站连接规避了"桌面无公网 IP / NAT"问题，且移动网络可达。

**优点**：
- 跨网可达（手机在 4G/5G/公网都能连）；
- 桌面只需出站连接，不需要开放端口；
- 天然支持推送（中继可接 APNs/FCM）；
- 部署简单（单服务、无状态或 Redis 状态）。

**缺点**：
- 引入云依赖（可用性/成本/隐私边界）；
- 事件流全部过中继，带宽与隐私权衡（本方案事件载荷多为文本 JSON，带宽可接受）；
- 需要账号/设备注册体系来防止他人连入（身份模型 §4 提供）。

**技术可行性（查证）**：WebSocket 中继是成熟模式（各类远程控制/协作工具均如此）；`tauri-plugin-websocket` 已提供移动端 WebSocket 客户端能力（见 plugins-workspace v2 仓库 README，支持 Android/iOS）。

#### 3.1.3 候选 ③：P2P（WebRTC）

**形态**：信令（经云或 mDNS）后建立 WebRTC 直连（ICE/STUN/TURN 穿透 NAT），`RTCDataChannel` 承载数据。

**优点**：
- 跨网直连（NAT 穿透成功时）不绕云，带宽/延迟优于中继；
- 数据通道成熟（MDN 文档确认 RTCDataChannel 支持任意二进制/文本数据交换）。

**缺点**：
- 复杂度最高：ICE 协商、STUN/TURN 部署、移动端 WebRTC 栈、与 Rust 引擎的事件桥接（移动端是原生应用时需额外 WebRTC 栈；Tauri 移动端 WebView 可用，但桌面侧 Rust 需 `webrtc` crate 或经 WebView 桥）；
- 对称 NAT / 无 TURN 时退化为中继，收益不确定；
- 与"局域网直连"重叠度高——局域网内 WebRTC 并不比直连 WebSocket 更优。

### 3.2 拓扑权衡矩阵

| 判据 | ① 局域网直连 | ② 云中继 | ③ P2P(WebRTC) |
|------|--------------|----------|----------------|
| 延迟（同局域网）| ★★★（1-10ms）| ★★（+公网跳数）| ★★（协商后直连，同 ★★~★★★）|
| 跨网可达 | ✗ | ★★★ | ★★（依赖 STUN/TURN 成功率）|
| 实现复杂度 | ★★（一次服务端开发）| ★★（一次中继开发）| ★★★★（ICE/TURN/移动端栈）|
| 云依赖 | 无 | 有（可用性/成本/隐私）| 信令云 + 可选 TURN |
| 推送能力 | ✗（桌面不可达时无法推）| ★★★（中继可接推送）| ✗ |
| 隐私 | ★★★（不出局域网）| ★★（过中继，可加密但流量可见）| ★★★（端到端）|
| 证书信任 | 自签 + 指纹固定 | 标准 CA（Let's Encrypt）| DTLS 内建（无证书问题）|

### 3.3 推荐组合：局域网直连优先 + 云中继兜底

**裁决**：

```
连接选择策略（两阶段）：
  1. 服务发现（§3.5）：Companion 与 Hub 在同一局域网（mDNS / 二维码引导发现）
     → 尝试 ① 局域网直连（TLS WebSocket，指纹固定）；
  2. 直连失败 / 超时（跨网、AP 隔离、桌面不响应）且用户配置了中继
     → 走 ② 云中继（两端口都出站连中继，消息经中继转发）；
  3. 中继不可用 → ③ P2P/WebRTC 列为远期增强，**不在 P0-P2 实现**。
```

**为什么不是"中继为主"**：局域网场景（家庭/办公，手机与电脑同网）是最高频且体验最敏感的场景（审批延迟直接决定 run 等待时长），直连体验与隐私都显著更优；中继只解决跨网可达。两条链路共用**同一套应用层协议**（§3.7），只是传输换通道——连接层抽象（`Link`）屏蔽差异。

**中继的角色定义**：
- 中继**只转发**，不解密（应用层 TLS 端到端：中继上只有设备公钥与消息密文，见 §4）；
- 中继不做业务状态（无会话快照、无事件存储）；
- 中继可选的辅助职责：设备在线状态（在线/离线，供推送节流）、APNs/FCM 推送适配。

### 3.4 网络不可达场景（离线矩阵）

| 场景 | 移动端行为 | 桌面行为 | 恢复机制 |
|------|-----------|----------|----------|
| 局域网内桌面关机/睡眠 | 显示"Hub 离线"；本地快照可查（最后拉取的会话索引/事件游标）；审批命令挂起 | 无影响（桌面不依赖移动端）| 桌面醒来 mDNS 恢复 → 移动端自动重连 + 游标追赶（§5.3）|
| 移动端断网 | 命令队列化（本地暂存，最多 N 条），事件订阅断开 | 无影响 | 网络恢复 → 重连 → 队列按序发送（幂等键去重）|
| 跨网且未配中继 | 提示"配置中继服务后可在任意网络访问" | 无影响 | 用户配置中继 → 重连 |
| 桌面进程崩溃后重启 | 连接断开 | 重启后 restore（现有 `run_restore`，`main.rs:376-384`）| 移动端重连后按 `last_sequence` 追平 |
| 中继服务故障 | 局域网直连仍可用（若同网）| 不依赖中继（仅出站）| 中继恢复后重连 |

**铁律**：**桌面端功能不依赖多端互通**——服务网关、中继客户端全部是桌面内的可选组件；网关启动失败只影响"对外服务"，不影响 GUI 与引擎（与 `open_session_db` 失败降级内存库的先例同构，`apps/agent-workbench/src-tauri/src/main.rs:224-254`）。

### 3.5 服务发现与引导（局域网直连）

采用**"mDNS 辅助 + 二维码/手动输入兜底"**双通道：

1. **mDNS 广播**（桌面）：桌面启动网关时以 `_crish-hub._tcp.local.` 广播实例（含端口、设备指纹摘要、协议版本）。Windows 侧 mDNS 广播不可靠（需 Bonjour 服务或自实现 DNS-SD），故为辅助通道；
2. **二维码引导**（主通道，P1 就实现）：桌面"多端互通"设置页显示二维码，内容 = 一次性的**配对邀请载荷**（§4.3）：
   ```
   crish://pair?inv=eyJhbGciOiJFZERTQSIs...   （JWT 式签名载荷）
   ```
   移动端扫码 → 解析出桌面局域网地址（可从邀请内的 IP:port 或经 mDNS 反查）→ 直连；
3. **手动输入**（兜底）：桌面显示 `IP:port + 6 位配对码`，移动端手输。

### 3.6 安全传输层

- **局域网直连**：TLS 1.3（1.2 兼容），自签名证书（首次生成后持久化在 `app_dir()`），移动端**指纹固定**（配对时记录证书 SHA-256 指纹，后续连接校验指纹，防中间人）。证书轮换 = 重新配对（§4.4）。
- **云中继**：标准 CA 证书的 TLS（wss://），应用层再做一层设备级加密（§4.2 设备公钥信封加密 + AEAD），中继不可读业务载荷。
- **帧格式**：Text 帧承载 JSON（事件流为扁平信封 JSON，与现状逐字节一致）；大载荷（文件浏览内容）用 Binary 帧 + 长度前缀，避免 JSON 转义膨胀。
- **背压**：桌面 → 移动端的消息队列按端独立背压（复用 `EventBuffer` 水位语义，§6.2）；移动端 → 桌面的命令天然低频率，无背压问题。

### 3.7 应用层协议栈（链路无关）

**裁决：单一应用层协议，双层复用。**

```
┌─────────────────────────────────────────────────┐
│ 应用层：MD-1 帧协议（JSON，camelCase）            │
│   { v: 1, msgId, type, payload, ack? }          │
│   type ∈ { hello, hello-ack, device-list,       │
│            event, command, command-ack,         │
│            approval-request, approval-decision,  │
│            ping, pong, error, bye }             │
├─────────────────────────────────────────────────┤
│ 通道层：Link 抽象                                │
│   LocalLink（局域网 TLS WS） / RelayLink（wss）  │
│   —— 同一语义，不同实现                            │
├─────────────────────────────────────────────────┤
│ 传输：WebSocket（TLS）                           │
└─────────────────────────────────────────────────┘
```

关键帧语义（子方案 D2 细化）：
- `hello`：设备身份 + 能力声明 + 协议版本（§2.4）；
- `event`：透传 `AgentEventEnvelope` 的扁平 JSON（**不做二次包装**，`payload` 即信封序列化结果，与 `core_event_bridge.rs:107-120` 的 `serialize` 产物一致）；
- `command` / `command-ack`：请求-响应，`msgId` 关联；幂等键（§5.5）；
- `approval-request` / `approval-decision`：审批专用帧（可并入 event/command 语义，子方案 D5 定夺——倾向复用 command，保持帧面最小）；
- `ping/pong`：链路健康（仅中继链路需要；局域网直连可省略，WebSocket 自身有心跳）。

#### 3.7.1 帧协议示例（v1 草案，供子方案 D2 定稿）

以下帧示例是**契约草案**，字段命名遵循仓库 serde camelCase 惯例（对齐 `RunTaskOptions`，`core_run_commands.rs:3008-3030`）；最终以 D2 的 frozen 版为准。

**hello（移动端 → 桌面，连接建立第一帧）：**

```json
{
  "v": 1,
  "msgId": "m-001",
  "type": "hello",
  "payload": {
    "deviceId": "dev-mobile-0f3a9c2e",
    "hubId": "hub-desktop-7b21",
    "devicePubKeyFingerprint": "sha256:3f4a...",
    "role": "companion",
    "form": "mobile",
    "appVersion": "0.1.0",
    "protocolVersions": [1],
    "capabilities": {
      "approval": ["approve", "deny"],
      "eventView": { "pageSize": 200 },
      "runStart": false
    },
    "signature": "ed25519:..."
  }
}
```

**event（桌面 → 移动端，透传信封 JSON，`payload` 与 `EventBridge::serialize` 产物逐字节一致，`core_event_bridge.rs:107-120`）：**

```json
{
  "v": 1,
  "msgId": "s-88231",
  "type": "event",
  "payload": {
    "type": "approval-requested",
    "runId": "run-...",
    "sessionId": "sess-...",
    "schemaVersion": 1,
    "timestamp": "2026-08-09T10:00:00.000Z",
    "request": {
      "id": "approval-tc-42",
      "toolCallId": "tc-42",
      "toolName": "write_file",
      "summary": "call write_file",
      "cwd": "C:/work",
      "parameters": { "path": "src/main.rs", "content": "..." }
    }
  }
}
```

**command / command-ack（移动端 → 桌面，请求-响应；幂等键防重放重试）：**

```json
// 请求（移动端 → 桌面）
{ "v": 1, "msgId": "m-017", "type": "command",
  "payload": {
    "cmd": "md.approval.decide",
    "idempotencyKey": "uk-20260809-0001",
    "args": { "toolCallId": "tc-42", "decision": "deny", "reason": "路径越界" }
  } }
// 响应（桌面 → 移动端；成功时 data 为命令返回体，失败时 error 为 CoreError 77 码）
{ "v": 1, "msgId": "m-017", "type": "command-ack",
  "payload": { "ok": true, "data": { "ok": true, "toolCallId": "tc-42", "decision": "denied" } } }
```

**error（任意方向，链路级错误）：**

```json
{ "v": 1, "msgId": "s-90001", "type": "error",
  "payload": { "code": "md.unauthorized", "message": "设备已撤销（dev-mobile-0f3a9c2e）" } }
```

**帧序号与流控**：`msgId` 发送方单调递增（同方向）；`command-ack` 必须回显请求 `msgId`；`event` 帧无需 ack（可靠性由收口轨游标兜底，§5.3）。

#### 3.7.2 链路选择与回退判定（决策表）

连接管理器（移动端侧，桌面侧对应）按如下判定选择链路：

| 条件 | 动作 |
|------|------|
| 同局域网（mDNS 或邀请地址可达）| 尝试 LocalLink（TLS + 指纹固定）；超时 3s 或 TLS 指纹不匹配 | → 判失败 |
| LocalLink 失败且配置了中继 | 尝试 RelayLink（wss）；失败则周期性重试（指数退避 5s/15s/60s 封顶）|
| 两条都不可达 | 进入"离线投影"模式（§3.4）：只读快照 + 命令队列；监听网络变化触发重连 |
| 链路从 LocalLink 掉线且中继可用 | 自动切换到 RelayLink（不打断会话订阅——游标追平兜底，§5.3）|
| RelayLink 掉线但局域网恢复 | 优先回 LocalLink（延迟更优）；重连后游标追平 |

判定逻辑在**链路抽象之上**（`Link` 接口只提供 `connect/disconnect/send/onMessage/onStatus`），移动端与桌面共用同一套策略（桌面侧是"服务端"，一般不主动切链路——只有中继场景桌面维护出站 RelayLink，桌面内网直连端口常开）。

---

## 4. 身份与会话模型

### 4.1 跨端身份三元组

**裁决：跨端身份 = { 用户（User）, 设备（Device）, 会话（Session）} 三元。**

```
User    — 人。本地身份：uuid（本机生成，存 session_meta 或专用表）。
          现状无账号体系：User 只在"多设备管理"语境出现（多台设备归同一 User）。
          预留：云账号绑定（中继服务需要账号 → 设备归属，§4.5）。
Device  — 每端一台设备一个设备身份：
          { deviceId: uuid, role, form, publicKey: Ed25519, fingerprint: SHA-256(publicKey) }
          密钥对在设备本地生成；私钥永不离开设备。
          Hub 的设备身份存桌面（app_dir()/identity/），Companion 的存移动端安全存储。
Session — 业务会话（现有 sessions 表概念）或"跨端连接会话"（每对设备连接一个
          ConnectionSession）。本方案默认"会话"指业务会话（sessionId，现有
          概念不变），"连接"是传输层状态，不混入业务模型。
```

**映射关系**：
- 1 个 User 可有 N 台 Device（1 台 Hub + N 台 Companion）；
- 1 台 Device 同一时刻只与 1 个 Hub 建立主连接（多 Hub 连接列远期开放问题，§9.3）；
- 业务 Session 归属 User（不归属 Device）：任意已配对设备可看同一会话流（符合"移动端远程查看桌面会话"的诉求）。

### 4.2 设备密钥与信任根

- **签名**：Ed25519（Rust `ed25519-dalek` 生态成熟）。设备间所有鉴权消息（hello、命令）由发送方私钥签名；
- **机密性**：AES-256-GCM（AEAD）。局域网直连时 TLS 已提供机密性，应用层加密可选（防"局域网嗅探 TLS 重放"价值低，P1 可不开）；中继链路**必须**应用层设备级加密（TLS 只保护到中继，端到端机密性由设备公钥信封提供）；
- **信任根 = 配对记录**：Hub 侧 `devices` 表（deviceId → 公钥/指纹/角色/状态/配对时间）；Companion 侧 `hubs` 表（hubId → 公钥指纹/地址/证书指纹）。配对记录只增改不删除（撤销 = 状态标记，§4.4）。

### 4.3 配对机制高层设计（子方案 D3 细化）

配对目标：**完成一次带外（out-of-band）信任建立**——Hub 证明"我是这台桌面"，Companion 证明"我是这台手机"，之后一切自动。

```
配对流程（P1 版，二维码通道）：
  1. 桌面（Hub）生成配对邀请：
     - 一次性 secret（随机 128-bit）+ 有效期（5 分钟）+ 版本 + 局域网地址；
     - 载荷 = { secret, nonce, exp, hubPubKey, addrs, protocolVersion }
     - 以 Hub 私钥签名 → 二维码；
  2. 移动端扫码 → 验签（Hub 公钥随邀请自证；首次信任由"物理接触"完成：
     用户在自己两台设备间扫码 = 带外信任）→ 记录 hub 公钥/指纹；
  3. 移动端生成自己的设备密钥对（若没有）→ 以 secret 为证据向 Hub 发起配对：
     POST /md/v1/pair { deviceInfo, devicePubKey, proof: HMAC(secret, devicePubKey) }；
  4. Hub 校验 secret（一次性、未过期）→ 登记设备（状态 pending）→ 回执
     { deviceId, hubCertFingerprint, grantedCapabilities }；
  5. 双向 hello 建立连接（§3.7 hello 帧），完成配对。
```

安全属性：
- **物理接触 = 信任锚**（扫码/面对面输码），无中间人；
- secret 一次性 + 短时有效，泄漏窗口极小；
- 配对后设备密钥才是长期信任；secret 用完即焚；
- 撤销 = Hub 侧删/禁设备记录（§4.4），移动端删除 hub 记录即"解绑"。

### 4.4 多设备管理（Hub 侧）

Hub 提供设备管理命令（服务面 + 桌面设置 UI 双入口）：

| 操作 | 语义 |
|------|------|
| `device_list` | 列出已配对设备（deviceId/名称/角色/最后在线/能力）|
| `device_revoke` | 撤销设备（状态 → revoked；拒绝该设备新连接；不断现有连接，期满踢出）|
| `device_rename` | 改显示名 |
| `device_rotate_keys` | 吊销设备旧公钥、要求重新配对（密钥轮换）|

存储：新表 `devices`（或 `session_meta` 键值，P1 用 session_meta 起步，P2 迁移专用表——与 `session_sequence` 演进先例一致，`crates/conex-db/src/migrate.rs` 有迁移链）。

### 4.5 用户身份与云账号（预留）

- P1-P2 **不需要**云账号：配对是"设备对设备"，User 是本地隐式概念（Hub 的所有者 = User）；
- 中继服务若要区分用户（配额/设备归属/防滥用），需可选账号：中继注册时绑定 `hubId`（= Hub 设备 id），Companion 以 `hubId + 设备签名` 连中继；
- 账号体系只作为**中继的可选增强**，不做业务会话的命名空间（业务会话继续本地 uuid）。

---

## 5. 端间一致性模型

### 5.1 单一真相源（SoT）裁决

**裁决：桌面 Hub 是唯一真相源**，覆盖四类状态：

| 状态域 | 真相源（现有代码）| 移动端视角 |
|--------|-------------------|------------|
| 会话索引/正文 | `sessions`/`session_messages`（`crates/conex-db/src/schema.rs:123-139,189-208`）| 只读投影（拉取 + 事件增量）|
| run 状态 | `runs` 表 + `CoreRunState.active_runs`（`crates/conex-db/src/runs.rs:21-53`；`apps/agent-workbench/src-tauri/src/core_run_commands.rs:352-391`）| 只读投影（`core_get_run_snapshot`）|
| 审批状态 | `ApprovalGateImpl.pending`（`core_run_commands.rs:180-187,230-258`）| 裁决入口（命令），状态仍在桌面 |
| 审计 | `events` 表审计底账（`BridgeAuditSink`，`core_run_commands.rs:448-490`）| 只读（`core_read_session_events` 过滤 security-audit）|

推论：
1. **单写者原则**：任何时刻，一个会话只有一个写者（桌面引擎 + 桌面用户 UI）；移动端命令到达桌面后进入同一写路径（`run_task_impl` / `core_approve_tool` 等），因此**不存在写写冲突**——一致性从"冲突解决"退化为"传播延迟"问题；
2. **移动端无本地业务写**：移动端本地缓存（会话索引、最后事件游标）是**可丢弃的投影**，重建唯一手段是从 Hub 拉取；
3. **时钟**：事件时间戳以桌面（`now_iso_utc`，`apps/agent-workbench/src-tauri/src/engine.rs:103-112`）为准；移动端展示时间本地化但排序一律以 `sequence` 为准（§5.3）。

### 5.2 会话状态权威

- 会话索引变更（新建/改名/归档/pin）由桌面产生（现有 `upsert_session_entry`，`crates/conex-db/src/sessions.rs:37-83`）；
- 移动端如何知道"会话列表变了"？——**事件面**：现有事件流里没有"会话索引变更"事件；**新增一个轻量机制**：会话索引的 `updated_at` 由 `touch_session` 维护（`crates/conex-db/src/sessions.rs:322-335`），服务网关可提供 `session_index_snapshot(version)` 带版本号拉取；或复用 `session_meta` 写一个 `index_version` 键。【裁决修正 5】**41 变体冻结为基线，不新增 `session-index-changed` 事件变体**：会话索引变更走 M6 `events.session.updated` 会话面消息（D3 信封，不动 41 变体注册表）；F5 会话列表增量刷新 = `events.session.updated` 事件 + `session_index_snapshot` 版本对账兜底（D2 §7.4 / M6 §13 T-M6-12 对齐）。

### 5.3 事件流跨端传播（核心机制）

**现状基础（关键事实）**：事件已具备"会话内单调序列号 + 游标"：

- `events` 表以 `(session_id, sequence)` 为主键，`sequence` 单调递增（`crates/conex-db/src/schema.rs:141-149`）；
- `reserve_sequence` 原子取号（`crates/conex-db/src/events.rs:72-99`），`seed_sequence` 幂等校准（同文件 103-121）；
- 查询面已支持 `after_sequence` 游标分页：`core_read_session_events`（`apps/agent-workbench/src-tauri/src/core_query_commands.rs:510-539`，返回 `{events, nextAfterSequence, hasMore}`）；
- 实时面：`AgentEventEnvelope` 的 `sequence` 由 emit 层注入（`crates/conex-types/src/events.rs:905-933`），实时预览帧 `sequence=None`（`BridgeDeltaSink`，`engine.rs:1733-1741`），落库帧携带序列号（收口流）。

**跨端传播协议（裁决）**：

```
桌面 → 移动端事件传播 = 双轨（实时轨 + 收口轨）的跨端延伸：
  实时轨（增量）：网关把收到的实时事件（含 sequence=None 的预览帧）转发给
    已订阅连接的端；移动端按 messageId/事件语义就地增量渲染（与现有前端
    EventRouter 同构，见 §6.6）；
  收口轨（追平）：移动端维护每会话游标 lastSeq；断线重连/迟到订阅时，
    调 service API（等价 core_read_session_events，afterSequence=lastSeq）
    追平；已落库事件以落库 sequence 为准。
  去重：事件携带 messageId（消息域）/toolCallId（工具域）等稳定键，移动端
    按 key 幂等 upsert；sequence 用于单调性判定（收到 sequence ≤ lastSeq 的
    落库帧直接跳过）。
```

**背压跨端延伸**：桌面缓冲已有"Delta 可丢、Critical 必达"三级语义（`crates/conex-types/src/events.rs:867-893` 的 `event_backpressure` + `apps/agent-workbench/src-tauri/src/buffer.rs:24-42` 的 `DropClass`）。跨端转发**不得改变该语义**：网关对每条事件按 `backpressure` 分级，Delta 类在端级缓冲水位满时可丢（与现有前端行为一致——message-delta 丢了由 message-end 全文兜底，`buffer.rs:7-11`），Critical 类必达（转发失败则端断开，重连后经收口轨追平）。

### 5.4 审批权威与远程审批一致性

审批状态机的**唯一权威是桌面的 `ApprovalGateImpl`**：

- `request_approval`：广播 `approval-requested`（实时预览）→ 注册 oneshot 等待 → 超时 `Expired`（`core_run_commands.rs:263-343`）；
- `resolve`：`core_approve_tool` / `core_deny_tool` 入口，**先校验 tool_call_id 在待审批集合**（I-02，`core_run_commands.rs:230-258`）→ 送决策 → 状态机恢复（awaiting-approval → running）。

**远程审批 = 给现有 `resolve` 增加一个鉴权过的服务入口**，一致性天然成立：

1. 移动端收到 `approval-requested` 事件（实时轨，天然携带完整 `PermissionRequest`：toolCallId/toolName/parameters/summary，`crates/conex-types/src/events.rs:196-218`）；
2. 用户点批准/拒绝 → 移动端发 `approval-decision` 命令（含 requestId/toolCallId/decision/reason）；
3. 桌面网关校验设备身份 + 该设备能力（approval 能力位）→ 调 `core_approve_tool`/`core_deny_tool`（或等价内部入口）→ 复用全部既有校验（I-02 防伪造）与事件发射（`approval-resolved` 落库 + 实时，`core_run_commands.rs:3801-3831`）；
4. `approval-resolved` 事件自然广播回所有端（含移动端自己），UI 状态收敛。

**并发裁决（多端同时批同一 toolCallId）**：`resolve` 的 `pending.remove` 是单写者（桌面内 Mutex），第二个裁决得到 NotFound（`core_run_commands.rs:235-245`）→ 返回"已处理"，移动端展示"该审批已被处理"。无需分布式锁。

**审批超时与通知**：`APPROVAL_TIMEOUT` 120s 语义不变（`core_run_commands.rs:87`）；移动端展示剩余时间（可选），不做桌面侧改动。

### 5.5 命令通道（控制面）与事件通道（数据面）分离

**裁决：保持与桌面现有架构一致的双面分离**——命令（request/response，`core_*`）与事件（广播，`workbench-run-event`）在跨端协议里也是两条独立语义：

| 面 | 传输语义 | 幂等 | 失败处理 |
|----|----------|------|----------|
| 命令面（移动端→桌面）| 请求-响应（`command`/`command-ack`）| 每个命令携带幂等键（idempotencyKey，客户端生成；桌面按 `(deviceId, idempotencyKey)` 去重，响应缓存重放）| 超时重试（幂等键保护下安全）；`CoreError` 结构化错误原样回传（77 码体系，`crates/conex-types/src/error.rs` 的 `CrishErrorPayload`）|
| 事件面（桌面→移动端）| 广播（实时轨 + 收口轨追平，§5.3）| 按稳定键 upsert | 断连重连追平 |

**命令面映射**：移动端调用的命令 = `surface=engine` 命令子集的**服务化包装**（§6.4），参数/返回沿用现有 serde camelCase 契约（如 `RunTaskOptions`，`core_run_commands.rs:3008-3030`），**不做第二套 DTO**。

### 5.6 排序与时钟

- 事件顺序：会话内以 `sequence` 为唯一偏序；跨会话无全局序（不需要）；
- 命令顺序：同设备命令按发送序（msgId 递增），桌面按接收序处理（单连接串行）；不同设备命令之间无顺序约束（业务上无此需求——审批/取消等命令天然独立）；
- 展示时间：移动端用设备本地时区渲染，但排序用 sequence，时间戳仅展示（桌面 `now_iso_utc` 为 UTC，`engine.rs:103-112`）。

### 5.7 冲突消解（不需要分布式算法的论证）

因为**单写者**（§5.1），冲突仅剩两种，均已在桌面内解决：
1. **双端同时写同一会话**（移动端发消息 vs 桌面用户发消息）：二者都走 `core_run_task`，会话内串行守卫拒绝第二个活动 run（`core_run_commands.rs:3082-3090`"会话内串行守卫"）→ 移动端收到 `invalid_input` 错误，提示"该会话正在运行中"；
2. **审批并发**：§5.4 已论证（`pending.remove` 单写）。

故端间一致性 = 传播延迟 + 游标追平，不引入 CRDT/多主复制/版本向量。

### 5.8 移动端本地投影的一致性契约（可丢弃缓存）

移动端本地状态（会话索引、事件游标、最后快照）是**可丢弃投影**，必须遵守以下契约：

| 本地数据 | 生命周期 | 失效与重建 |
|----------|----------|------------|
| 会话索引列表 | 会话级缓存（LRU ≤ 200 会话）| 收到 `events.session.updated`（【裁决修正 5】原 `session-index-changed` 更名/不新增变体）或 `events.session.updatedAll` → 全量重拉；离线期间只读 |
| 每会话事件游标 `lastSeq` | 断连期间持久保留（本地存储）| 重连后 `afterSequence=lastSeq` 追平；追平结果覆盖本地增量渲染区 |
| 消息正文（已水合）| 缓存正文 | 追平窗口内以落库事件为准（message-end 全文覆盖增量区，`events.rs:342-367` 兜底语义）；不做双向 merge |
| 挂起命令队列 | 断连期间暂存（≤ 20 条，逐条幂等键）| 重连后按序发送；成功/失败逐条清理；应用退出即丢弃（不承诺送达——命令语义以桌面确认为准）|
| 审批卡片状态 | 实时（不落本地）| 断连即挂起（等待重连后的 `approval-resolved` 或超时 Expired）；不本地臆断决策 |

**关键不变量**：移动端本地任何状态都**不反向影响桌面**；桌面状态只由桌面 + 移动端命令（经桌面执行）改变。这样"缓存是否新鲜"只有体验差异，没有正确性风险。

### 5.9 移动端连接状态机

移动端连接生命周期（对齐现有 `TransportStatus` 四态，`apps/crish-desktop/src/api/transport/types.ts:29`，扩展两态）：

```
disconnected ──配对成功──▶ idle（已配对未连接）
     ▲                        │ 发现 Hub（mDNS/扫码/中继）
     │                        ▼
     │                    connecting
     │                        │ hello/hello-ack（鉴权 + 能力协商）
     │                        ▼
     │                    connected ──▶ sync（游标追平中，只读本地快照渲染）
     │                        │                │ 追平完成
     │                        │                ▼
     │                        │            live（实时双轨订阅）
     │                        │
     └───────── 断开（重试）◀──┴── 鉴权失败 → unauthorized（需要重新配对/撤销提示）
```

- `unauthorized` 是终止态（需用户重新扫码配对或检查桌面设备列表），不自动重试；
- `sync → live` 的过渡必须**先追平后实时**：追平窗口内到达的实时帧按稳定键 upsert（§5.3 去重），追平完成时按 `sequence` 单调性裁剪重叠区——复用前端 `sessionEventHydrate` 的既有消费语义（`apps/crish-desktop/src/api/sessionEventHydrate.ts`，其 `{events, nextAfterSequence, hasMore}` 分页面与 `core_read_session_events` 同构，`core_query_commands.rs:326-338`）；
- 状态机在移动端与（未来）Web 端共用实现（纯逻辑可测，与 `transport` 实现解耦）。

---

## 6. 与现有架构的融合点（文件:行号证据）

本章是多端互通落地的**工程锚点**：每个融合点给出"现状代码 → 多端改造 → 不变量（不得破坏的语义）"。全部引用可复核。

### 6.1 AgentEvent 41 变体事件面 → 跨端事件基

#### 6.1.1 现状（关键事实）

- `AgentEvent` 是 serde tagged enum，顶层 `type`（kebab-case），全部字段 camelCase（`crates/conex-types/src/events.rs:304-306`）；
- 当前 41 个变体，覆盖：Agent 域（agent-start/agent-end）、Turn 域、Message 域（message-start/delta/end）、Tool 域（tool-start/update/end/batch-*）、压缩域、诊断/审批/检查点域（approval-requested/approval-resolved、run-terminal、security-audit 等）、子代理域（subagent-*）、任务域（task-*）、定时器/cron 域（timer-fired/cron-fired）（`events.rs:306-782`）；
- `AgentEventEnvelope`：信封扁平 JSON `{type, runId, sequence, schemaVersion, ...事件字段}`，`runId/sequence/schemaVersion` 由 emit 层注入（`events.rs:905-933,941-992`）；
- 模块头注明言："跨进程序列化是主用途"（`events.rs:298`），且"与 daemon WS 广播同构（03 §3.1）"（`events.rs:908`）——**事件契约天生就是 wire 协议**，历史上曾是 daemon 进程间协议；
- 事件注册表机制：新增变体须同步 `contracts/engine-events.json`，由 `tests/registry_drift.rs` 锁定（`events.rs:6-8`）；类型名清单由宏双生成（`events.rs:789-852`）→ **扩展事件面有现成的、受护栏保护的流程**；
- 前端 TS 类型由 `scripts/generate-engine-bindings.mjs` 生成，落点 `packages/shared-types/src/generated/engine/**`（`events.rs:6-8`）→ **移动端可复用同一生成管线**。

#### 6.1.2 多端改造

1. **跨端事件基 = `AgentEventEnvelope` 序列化 JSON**，不做任何二次包装（`payload` 与 `core_event_bridge.rs:107-120` 的 `serialize` 产物逐字节一致）。移动端解析 = 复用生成的 TS 类型 + 解析器（`packages/shared-types/src/generated/engine/parser.ts`），不再发明事件 schema；
2. **新增事件变体走既有登记流程**：【裁决修正 5】41 变体冻结为基线，新增变体
   必须走三件套登记（`events.rs:789-808` 宏登记 + `contracts/engine-events.json`
   注册表 + 生成脚本）；§5.2 的 `session-index-changed` 已按裁决改为
   M6 `events.session.updated` 会话面消息，不再登记新变体；
3. **事件语义不变量（不得破坏）**：
   - `message-end` 必达、携带全文（message-delta 可丢的兜底，`events.rs:342-367`、`buffer.rs:7-11`）——跨端转发同样遵守；
   - `run-terminal` 事件体内 runId 与信封注入一致（`events.rs:918-920` serde flatten 合并逻辑）——跨端解析器直接用现成的反序列化实现；
   - `approval-requested.request.toolCallId/toolName` 必填（`events.rs:191-193`）——远程审批依赖；
   - 背压分级（`event_backpressure`，`events.rs:867-893`）是转发丢帧的决策依据。

#### 6.1.3 融合建议

| 项 | 决策 |
|----|------|
| 跨端载荷 | 信封扁平 JSON（string 或对象承载，协议帧 `event` 透传）|
| 类型消费 | 移动端/Web 端从 `packages/shared-types/src/generated/engine/` 消费生成类型 |
| 事件演进 | 全部经既有登记流程（宏+注册表+生成），协议版本经 `schemaVersion`（§6.8/§7.3）|
| 不需要 | 不新增"跨端事件"枚举、不做字段映射/翻译层 |

### 6.2 事件桥（EventBridge / BufferedRunEventBridge）→ 多端发射扇出

#### 6.2.1 现状（关键事实）

发射链三层（自底向上）：

```
TauriEmitter（app.emit("workbench-run-event", payload)）
  core_event_bridge.rs:57-81
      ↑
EventBridge（信封 → serialize → emitter.emit）
  core_event_bridge.rs:88-145（serialize 107-120；emit_payload 137-144）
      ↑
BufferedRunEventBridge（每 run 一个：入队即序列化 + 背压缓冲 + flush）
  engine.rs:1643-1704（emit 1666-1689；flush 1692-1703）
      ↑
消费方：BridgeDeltaSink（实时轨，engine.rs:1716-1741）、审批广播
  （core_run_commands.rs:3142-3149）、BridgeAuditSink（core_run_commands.rs:448-490）、
  timer/cron drain（engine.rs:1606-1628）、任务事件（background → set_event_bridge，main.rs:398-399）
```

关键设计点：
- `Emitter` trait 是**唯一的发射抽象**（`core_event_bridge.rs:51-54`：`fn emit(&self, channel: &str, payload: &str)`）——Tauri 通道与测试替身已共存（`core_event_bridge.rs:156-174` RecordingEmitter）→ **新增"跨端扇出发射器"只需实现该 trait**；
- 事件缓冲 `EventBuffer` 按 runId 隔离 + 双水位丢帧（`buffer.rs:65-206`），`Default` 水位 Soft 64 / Critical 256（`buffer.rs:200-206`）；
- 模块刻意"零 crate:: 内部引用，可独立编译测试"（`core_event_bridge.rs:2-4`）——新增扇出实现也可保持同风格。

#### 6.2.2 多端改造（核心设计）

**方案 A（推荐）：`Emitter` trait 多路化 —— 扇出（fanout）发射器。**

```
新组件 FanoutEmitter（实现 Emitter trait）：
  emit(channel, payload) →
    1. 原 TauriEmitter 照发（GUI 不变）；
    2. 对每个已连接的端 Link：按端级背压缓冲入队 → 异步 flush 到 WebSocket；
       若链路断开 → 事件进该端的"离线追赶队列"（只保留 lastSeq 游标，
       断连事件不缓存正文——重连后经收口轨追平，§5.3）。

实现落点：
- core_event_bridge.rs 新增 FanoutEmitter（保持"零 crate:: 内部引用"风格）；
- main.rs:353-356 的 EventBridge::new 处，把 TauriEmitter 换为 FanoutEmitter
  （内部仍含 TauriEmitter）；或保持原桥不动，新增第二个 EventBridge
  （channel 语义不同），由网关消费——**【裁决修正】**AU2 F-6 统一为 D2 方案：
  **构造点替换 emitter（FanoutEmitter 内部分路 Tauri + WS）**，不再采用
  「新增第二个 EventBridge 物理解耦」倾向；channel 语义：WS 侧按订阅过滤，
  不区分 channel（D2 §4.2 架构图）。
```

**为什么不动 BufferedRunEventBridge 内部**：run 级缓冲的丢帧语义（Delta 可丢、Critical 必达）是桌面与现有前端契约的一部分，改它会波及 03 §5.3-6 契约；跨端转发在**桥之外**再做一层"按端"的缓冲（借用 `EventBuffer` 语义但按 deviceId 分桶，或独立轻量实现）。`EventBuffer` 本身可按 deviceId 复用（`runs: HashMap<String, RunQueue>` 换成 `devices: HashMap<String, RunQueue>` 的同构结构）。

**方案 B（备选）：网关侧订阅重放**。网关不去劫持 Emitter，而是：
1. 订阅 GUI 事件（等价前端 listen 'workbench-run-event'，但发生在 Rust 侧——Tauri 无 Rust 侧 listen 订阅 API，需自行注入）；不可行/不优雅。
2. 轮询 `core_read_session_events` 增量（afterSequence 游标）——只覆盖落库帧，实时预览帧（sequence=None，如审批广播/实时 delta）丢失，审批体验受损。

**结论：采用方案 A**（FanoutEmitter 或独立跨端桥）。实时轨（sequence=None 帧）对审批与流式体验至关重要，方案 B 无法覆盖。

#### 6.2.3 融合不变量

- GUI 通道 `workbench-run-event` 载荷与语义**逐字节不变**；
- Critical 事件跨端必达：转发失败 = 该端断开（移动端可见"连接中断"），重连追平；不得静默丢弃后假装已投递；
- Delta 事件跨端可丢，但"丢"必须在端级缓冲水位语义内发生（可观测：端级 EmitReport 汇总，参照 `core_event_bridge.rs:23-45` 的 `EmitReport`）；
- 跨端通道不参与 run 生命周期（网关故障不得影响 run：所有转发失败只记日志 + 断该端，不反向影响 `BufferedRunEventBridge` 的 flush 路径）。

### 6.3 conex-db 会话/run/事件存储 → 服务 API 只读投影

#### 6.3.1 现状（关键事实）

- `LocalDb`：SQLite 单连接 + `Arc<Mutex>` 串行化（`crates/conex-db/src/lib.rs`，方法均 `self.conn.lock()`）；**所有读写天然串行，无并发写问题**——这是服务网关安全并发的天然基础；
- `events` 表：`(session_id, sequence)` 主键 + FK 级联，`UNIQUE(session_id, sequence)`（`crates/conex-db/src/schema.rs:141-149`）；
- `sessions` 表：索引 + 元数据 + 孤儿清理宽限期 + 引擎子代理会话豁免（`crates/conex-db/src/sessions.rs:238-319`）；
- `runs` 表：run 状态 + usage/cache 列（`crates/conex-db/src/schema.rs:151-169`）；
- `pending_inputs`：待处理输入（服务网关"远程发消息"可复用——run 等待输入时经 pending_inputs 注入，`crates/conex-db/src/runs.rs:310-371`）；
- 访问抽象已存在：`orchestrator::persist::Store` trait（`crates/orchestrator/src/persist.rs:127+`），`LocalDbStore` 是生产实现（`persist.rs` 内）；命令层经 `SharedDb`（`session_commands.rs:41-75`）与 `core.store()`（`core_query_commands.rs:521-524`）访问。

#### 6.3.2 多端改造

1. **服务网关（新组件，D2 子方案）**：一个 axum/tokio 层，把"移动端命令"映射为"内部调用"，**复用现有函数体而不是复制实现**。映射方式：
   - 直接调现有 `#[tauri::command]` 函数体（多数命令实现体已与 Tauri 解耦，如 `run_task_impl` 可直调，`core_run_commands.rs:3043` 注释明言"测试可直调，不依赖 Tauri runtime"——这是**服务化可行性的事实证据**）；
   - 或调 `Store`/`LocalDb` 方法（只读投影路径：`query_events`、`list_sessions`、`load_session_body`、`get_run` 等）；
2. **只读投影接口清单（P1 最小集）**：`md.session.index`（会话列表）、`md.session.events`（afterSequence 分页）、`md.session.body`（消息正文）、`md.run.snapshot`、`md.status`（= `core_get_status` 等价物）；
3. **写接口清单（P1）**：`md.approval.decide`（§6.5）；P3：`md.run.start`（= `core_run_task`）、`md.run.cancel`；
4. **并发模型**：SQLite 单连接互斥已被 `LocalDb` 内部保证；网关线程池打进来的并发调用在 `conn.lock()` 处自然串行——**无新增锁**。注意命令层 `spawn_blocking` 惯例（`session_commands.rs:116-123`）需延续，避免阻塞 tokio 主线程。

#### 6.3.3 融合不变量

- 网关不新增第二条 DB 连接（复用 `LocalDb` 单连接语义，防锁竞争与写序混乱）；若读负载需并发，只读路径可用 `query_events` 同款连接串行化（读同样受 `conn.lock()` 串行，量级足够：P2 前 ≤8 端，事件查询是分页小批）；
- 会话清理（`cleanup_orphan_sessions`）只由现有调用方触发，网关不得触发删除；
- `session_sequence` 取号只发生在引擎 emit 路径（`reserve_sequence`，`crates/conex-db/src/events.rs:72-99`），网关只读。

### 6.4 catalog_commands / 命令面 → 服务 API 暴露

#### 6.4.1 现状（关键事实）

- 命令面真源：`main.rs:90-209` 的 `command_registry!`（**95 条注册，含登记先行 4 条**——【裁决修正 2】原「92 条」为过期快照，以 M6 §2.3 勘误 + `command_manifest.rs:68-191` 为准）+ `command_manifest.rs:68+` 的 `COMMAND_MANIFEST`（带 `family`/`surface`/`registered` 字段，`command_manifest.rs:29-38`）；
- **`surface` 字段已区分 `engine`（"引擎契约面（三端共用）"）与 `gui`（"GUI 专属面"）**（`command_manifest.rs:33-38`）——"三端共用"的表述说明设计者早已预见多端；`core_run_task`/`config_get` 等是 `engine`，`workbench_*`（shell/pty/git/fs 操作）是 `gui`；
- 前端有 manifest 快照镜像与一致性检查（`apps/crish-desktop/src/api/transport/commandManifest.ts`，`main.rs:482-499` 的测试锁定双端一致）；
- 服务化可行性证据：`run_task_impl` 与 Tauri 解耦可直调（`core_run_commands.rs:3040-3043`）；`catalog_get`/`catalog_refresh` 是纯函数式命令（`catalog_commands.rs:42-71`）；`core_get_status` 数据源全部来自 State/静态存储（`core_query_commands.rs:265-275`）。

#### 6.4.2 多端改造

1. **暴露边界裁决**：跨端服务 API = `surface=engine` 子集 × 设备能力 × 全局白名单，三层过滤：

   ```
   service-api = engine 面命令 ∪ 明确列入白名单的 gui 面命令
               ∩ 设备能力（§2.4 capabilities）
               ∩ 每命令写操作级别（read / approve / control / exec）
   ```

   - 默认白名单（P1）：状态/查询（status、session index/body/events、run snapshot）+ 审批（approve/deny）；
   - 明确**不暴露**（P1-P2）：`workbench_run_shell`、`workbench_pty_*`、`workbench_git_run`、`workbench_fs_delete_file`、`config_secret_reveal`、`trash_purge` 等高风险命令；
   - P3 按需逐命令评审加入；
2. **服务化包装（D2）**：新 `md.*` 服务接口的实现在网关内**委托现有命令实现体**（`run_task_impl`、`resolve` 等），签名沿用 serde camelCase，错误沿用 `CoreError`（77 码，`crates/conex-types/src/error.rs`）；manifest 增加 `surface: "service"` 标注（向后兼容，现有双端镜像测试只断言 registered 子集，加 surface 值不影响）；
3. **`core_list_commands` 已有清单返回（`command_manifest.rs:17-18`）**：服务网关可复用其为"端能力协商时的命令面版本协商"基础（移动端按 manifest 决定可用命令集）。

#### 6.4.3 融合不变量

- `COMMAND_REGISTRY_NAMES` 与 manifest `registered=true` 的逐项一致性测试（`main.rs:482-499`）不得破坏；
- 网关暴露的命令数 ≤ 现有注册面，**不做"仅服务端可调"的新命令**（需要新语义时先加 `#[tauri::command]` 注册，再决定是否暴露——保持"注册面唯一真源"）；
- 参数校验（S-15：`require_session_id`/`require_run_id`，`core_query_commands.rs:444-472`；`guard_cleanup_keep`，`session_commands.rs:94-101`）在服务入口同样执行——复用同一校验函数。

### 6.5 权限/审批面 → 远程审批（移动端核心场景）

#### 6.5.1 现状（关键事实）

审批全链路（已在前文 §5.4 引过，此处补齐文件证据）：

| 环节 | 代码 |
|------|------|
| 事件契约 | `PermissionRequest`（`crates/conex-types/src/events.rs:196-218`，含 requester_run_id/reason 权限传递层字段）、`PermissionDecision`（53-59）、`ApprovalDecision`（223-232）、`approval-requested`/`approval-resolved` 变体（479-495）|
| 状态机 | `ApprovalGateImpl`（`apps/agent-workbench/src-tauri/src/core_run_commands.rs:161-344`）；`request_approval` 先发后等防死锁（263-343）；`resolve` 带 I-02 待审批集合校验（230-258）|
| run 状态联动 | awaiting-approval 中间态落库（`crates/conex-db/src/runs.rs:21-53` 的 `RunStatus::AwaitingApproval`；`core_run_commands.rs:314-325`）|
| 命令入口 | `core_approve_tool`/`core_deny_tool`（`core_run_commands.rs:3746-3800` 附近），`approval-resolved` 落库 + 实时发射（3801-3831）|
| 裁决路由 | `approval_router.rs`（`crates/session-loop/src/approval_router.rs:88-118`：classify_source / route_approval / route_approval_guarded），Arbiter（用户/主 agent）73-81 |
| 超时 | `APPROVAL_TIMEOUT` 120s → Expired（`core_run_commands.rs:87,339-342`）|

#### 6.5.2 多端改造

1. **事件面**：移动端经实时轨收到 `approval-requested`（天然含完整 `PermissionRequest`）→ 渲染审批卡片（工具名/参数摘要/cwd/来源，`events.rs:196-218` 字段全可用）；**无需桌面侧任何改动**；
2. **命令面**：移动端 `md.approval.decide { requestId, toolCallId, decision, reason? }` → 网关鉴权（设备能力 approval 位）→ 委托 `core_approve_tool`/`core_deny_tool` 既有实现（I-02 校验、状态机恢复、approval-resolved 发射全复用）；
3. **权限传递层联动（现有语义自动延伸）**：`approval-requested` 载荷带 `requester_run_id`（子代理来源）时，移动端 UI 可展示"子代理请求"并提示裁决主体（metadata.arbiter，`events.rs:205-213`；`arbiter_metadata` 在 `core_run_commands.rs:299-307`）——远程审批天然支持子代理审批场景；
4. **审计一致性**：`approval-resolved` 事件落库（审计底账）→ 移动端只读看到最终决策；"谁裁决的"由设备身份注入：网关在命令载荷附 `deviceId`，桌面端在 `approval-resolved` 的 metadata 或审计上下文记录裁决设备（新增字段走 `PermissionDecision.metadata`，向后兼容）；
5. **安全注意**：审批是**最高价值攻击面**——远程审批必须满足：
   - 设备已配对且未撤销；
   - 命令经设备私钥签名（防伪造裁决）；
   - 可配置"远程审批仅在桌面锁定/后台时可用"（桌面设置项，P2）；
   - 审计中记录 deviceId + 时间（P1 就做）。

#### 6.5.3 融合不变量

- `resolve` 的 I-02 校验（tool_call_id 必须在待审批集合）是防伪造底线，**不可绕过**（`core_run_commands.rs:235-245`）；
- 审批超时/Expired 语义不变；移动端裁决送达晚于超时 → NotFound 错误回传即可；
- 审批状态机联动（awaiting-approval 落库与恢复）不因服务化而改变。

### 6.6 Transport 抽象层 → 移动端/Web 复用

#### 6.6.1 现状（关键事实）

- 前端 `Transport` 接口：`call/request/send/onMessage/onStatus/waitUntilConnected/stop/getStatus/isReady`（`apps/crish-desktop/src/api/transport/types.ts:47-83`）；
- `TauriTransport` 实现：request→invoke、onMessage→listen('workbench-run-event')（`tauriTransport.ts:158-210`），注释明言"上层（EventRouter/ConnectionLifecycle）只依赖本接口"（`types.ts:20`）；
- 事件载荷"逐字透传，不做归一化"（`tauriTransport.ts:13-15`），`EventRouter.onMsg` 直进 handler（`apps/crish-desktop/src/api/chat-bridge/EventRouter.ts`）；
- 事件 handler 体系按事件域分文件（approvalHandlers / messageHandlers / toolHandlers / taskEventHandlers / subagentHandlers / securityAuditHandlers…，`apps/crish-desktop/src/api/chat-bridge/handlers/`）——**这套 handler 就是移动端事件渲染的逻辑内核**。

#### 6.6.2 多端改造

1. **新实现 `RemoteTransport`**（Web 端/移动端 WebView 复用）：实现同一 `Transport` 接口——`request/send` → `command`/`command-ack` 帧（§3.7），`onMessage` → `event` 帧，`waitUntilConnected` → hello/hello-ack；
2. **可共享代码路径（跨包复用建议）**：`Transport` 接口类型、`EventRouter`、`handlers/*`、`StreamRenderBuffer`、`sessionStreamManager` 等**纯 TS/无 Tauri 依赖**的模块可移入共享包（`packages/`）或由移动端直接引用（子方案 D7 定夺打包策略）；
3. **不可共享**：`TauriTransport`、`tauriInvoke`、workspace fs 命令的本地实现（移动端无本地引擎）。

#### 6.6.3 融合不变量

- `Transport` 接口语义（三态 `TransportCallResult`，`types.ts:34-35`）不因新实现改变；
- 事件载荷仍"逐字透传"——移动端复用 `parser.ts` 解析，不做端差异字段。

### 6.7 新组件清单（多端互通新增，全部在桌面进程内）

| 组件 | 职责 | 落点建议 | 依赖的现有件 |
|------|------|----------|--------------|
| `md_gateway`（服务网关）| 局域网/中继入站链路终结 + 鉴权 + 命令委托 | 新模块 `apps/agent-workbench/src-tauri/src/md/`（或新 crate `crates/conex-md/`，P2 后抽 crate）| `Store`、`CoreRunState` 访问器、命令实现体 |
| `FanoutEmitter`（跨端发射）| 事件多路扇出 + 按端缓冲 | `core_event_bridge.rs` 同风格新模块 | `Emitter` trait、`EventBuffer` 语义 |
| `DeviceRegistry`（设备注册表）| 配对记录/撤销/能力表 | `crates/conex-db` 新表或 `session_meta` 起步 | `LocalDb` |
| `Link`（链路抽象）| LocalLink / RelayLink 统一接口 | `md/link.rs` | — |
| `RelayClient`（中继客户端）| 桌面出站连接中继 | `md/relay.rs` | `Link` |
| `md_api`（服务接口定义）| 协议帧/命令映射/错误映射 | `md/api.rs`（或 `conex-types` 扩展）| `CoreError`、serde camelCase |
| 移动端应用 | Companion UI | `apps/crish-mobile/`（【修正动作 4 / AU2 F-2】**待新建目录**——原 `apps/crish-mobile` 已按 R2A 裁决删除，legacy 原型在 `reference/mobile-companion*`）| `Transport`/`EventRouter`/handlers 复用 |

**装配顺序（进 `main.rs` setup 链，参照 `main.rs:290-456` 现有 setup 序列）**：LocalDb → DeviceRegistry（读配对）→ CoreRunState（现状）→ EventBridge（改造为含扇出）→ md_gateway（依赖前述全部）→ RelayClient（可选，配置开启）。网关启动失败 = 仅关多端服务，`core_get_status` 的 diagnostics 如实上报（复用 `StatusDiagnostics`，`apps/agent-workbench/src-tauri/src/status_diagnostics.rs`）。

### 6.8 融合点落地顺序（依赖序）

```
F1  事件契约盘点（不改代码，只写测试锁定 wire 形状）    —— 依赖：无
F2  Emitter 扇出（FanoutEmitter + 端级缓冲）            —— 依赖：F1
F3  本机服务网关 v0（仅 127.0.0.1 + token，curl 可测）  —— 依赖：F1
F4  配对 v0（一次性 token + 设备登记）                  —— 依赖：F3
F5  远程审批 v0（局域网直连 + 指纹固定）                —— 依赖：F3,F4
F6  事件流只读投影（游标追平）                          —— 依赖：F3
F7  mDNS/二维码引导                                     —— 依赖：F4
F8  中继链路（RelayLink + 端到端加密）                  —— 依赖：F4
F9  移动端 Companion 应用（审批 + 事件流 UI）           —— 依赖：F5,F6（并行开发）
F10 多端能力协商 / 设备管理 UI                          —— 依赖：F4
F11 远程发消息/取消（写命令面）                         —— 依赖：F5,F6
F12 文件浏览只读 / 终端输出                             —— 依赖：F6
```

---

## 7. 可扩展性

### 7.1 未来端接入协议（协议版本化）

**核心裁决：协议版本化从第一天存在，且分两层：**

| 层 | 版本载体 | 机制 | 现有基础 |
|----|----------|------|----------|
| 事件信封层 | `schemaVersion`（信封顶层字段，`crates/conex-types/src/events.rs:931-932,935-939`，`EVENT_ENVELOPE_SCHEMA_VERSION=1`）| 反序列化时缺省补 1（旧帧兼容，`events.rs:978-984`）| **已有，直接复用**：跨端事件就是信封 JSON，schemaVersion 随帧到达 |
| 命令/帧协议层 | 握手 `hello.protocolVersions`（客户端支持列表）+ 服务端选定 | 不兼容 → 拒绝连接并返回可读原因（能力协商失败，§2.4）| 新增（md 协议）|

**事件字段演进规则（沿用现有登记制，`events.rs:2-12`）**：
- 新增事件变体：`events.rs:789-852` 宏登记 + `contracts/engine-events.json` 注册表 + 生成脚本三件套 + `registry_drift` 护栏——多端场景下该流程**必须全量遵守**（移动端类型从生成产物来，漂移会直接暴露）；
- 事件字段演进：serde `default` + `skip_serializing_if` 的向后兼容模式（`events.rs:54-58` 的 `PermissionDecision` 先例）——新增可选字段不破坏旧端解析；
- 信封 `schemaVersion` 语义：字段级演进不 bump（`events.rs:913-916` 明言"与事件字段演进无关"）；**端间协议**（帧层）不兼容变更才 bump——这定义了"什么算破坏性变更"：改了帧结构/命令语义才算，加事件字段不算。

### 7.2 端类型注册与能力协商（扩展点）

- **新端接入流程（固定步骤）**：
  1. 实现 `Link`（局域网直连或中继）；
  2. 声明 `role/form/capabilities`（§2.4）;
  3. 经配对流程登记设备；
  4. 服务网关按"能力 ∩ 白名单"自动暴露对应命令（**网关是插件点，不是改点**：新增命令面映射只需在 `md_api` 的表里加一行）。
- **Controller 角色**（CLI/脚本）：能力声明不含 UI 依赖，命令面全量但逐命令鉴权（CLI 场景鉴权 = 设备签名 + 用户显式授权时长）；
- **Web 面板**：浏览器没有"安全存储设备私钥"的强保证——Web 端凭据策略列为 P3 待定（可选：短时效会话 token 代替长期设备密钥，token 由已配对移动端/桌面生成）。

### 7.3 跨端协议演进示例（三个典型变更的路径）

| 变更 | 路径 | 旧端行为 |
|------|------|----------|
| 新增命令 `md.session.export` | manifest 增加 + 网关映射表加行 | 不感知（命令面按 manifest 协商，旧端不调用）|
| 新增事件变体 `session-index-changed`（示例；【裁决修正 5】实际已改走 `events.session.updated` 会话面消息，不新增变体）| 事件三件套登记 | 旧端按未知 type 跳过（前端 parser 对未知 type 的处理，`packages/shared-types/src/generated/engine/parser.ts`）|
| 帧协议不兼容变更（如帧结构改动）| `protocolVersions` bump（1 → 2），服务端同时支持 1 和 2 | 握手时协商到旧版本，行为不变 |

### 7.4 插件/扩展面（远期）

- 中继服务的选型（自建 vs 托管）不对应用协议产生分支（RelayLink 是唯一接口）；
- 推送适配（APNs/FCM）经中继的推送通道，与 `Link` 无关；
- 命令面开放给第三方脚本（Controller 角色）时，鉴权模型复用设备签名，不另设 API key 体系（除非 Web 面板引入，§7.2）。

---

## 8. 风险与演进路线

### 8.1 风险清单与缓解

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| R1 | 局域网证书信任（自签 TLS 在 iOS/Android 的安装/固定复杂度）| 高 | P1 起实现指纹固定；配对时记录证书指纹；文档化 iOS 描述文件流程；中继场景（标准 CA）可完全绕过 |
| R2 | 桌面入睡/退出导致"移动端看不到通知"| 中 | 诚实呈现"Hub 离线"；P2 中继 + 推送（桌面关屏前经中继通知移动端）；不假装在线 |
| R3 | mDNS 在 Windows 上不可靠 | 低 | 二维码/手动输入为主通道；mDNS 仅辅助（§3.5）|
| R4 | 网关成为攻击面（远程审批被劫持）| 高 | 设备签名 + 指纹固定 + 审批专用审计 + 可撤销 + "远程审批仅在后台可用"选项（§6.5.2）|
| R5 | 事件扇出拖慢引擎 emit 路径 | 中 | 扇出全部异步化（入队即返回）；转发失败不断链路反向影响；基准测试锁水位（复用 `buffer.rs` 压力测试模式，`buffer.rs:355-445`）|
| R6 | 移动端事件解析与桌面漂移（双端 handler 语义分歧）| 中 | 共享生成类型（`packages/shared-types`）+ 共享 handler 模块化（§6.6.2）；回归测试覆盖 wire 形状 |
| R7 | 中继服务引入外部依赖与运维负担 | 中 | P2 前不引入；P2 中继服务最小化（无状态转发）；可选"自建/官方托管"双路径 |
| R8 | 多端并发写会话（移动端发消息 vs 桌面）| 低 | 已有会话内串行守卫（`core_run_commands.rs:3082-3090`）；移动端收到明确错误提示 |
| R9 | 协议演进失控（旧端长期挂着）| 中 | 双版本共存期（§7.3）；设备可远程撤销（§4.4）|
| R10 | 端间时钟/排序混乱 | 低 | sequence 为唯一偏序（§5.6）；时间戳仅展示 |
| R11 | 网关 + 引擎同进程导致网关故障影响引擎 | 高 | 网关全部组件化、可独立关闭；setup 失败降级（§3.4 铁律）；tracing 目标隔离（`target: "md"`）|

### 8.2 阶段划分与验收

> 【裁决修正 9】阶段命名统一为 AU3 R0-R5，本方案 P0-P4 映射如下：P0 原型 →
> R0（协议冻结）收尾/R1 前；P1 局域网直连 → **R1 桌面服务端**（桌面侧）+ **R2
> 移动端基础**（移动侧）；P2 云中继 + 通知 → **R3 推送** + **R4 中继+P2P**；
> P3 多端扩展 → R4 末/远期；P4+ 远期不变。任务书引用一律使用 R 阶段号。

#### P0 原型（本机验证，约 1 周）

目标：证明"事件信封 + 命令面"可被外部进程复用，跑通最小闭环。

- 交付物：
  - `FanoutEmitter` 原型（127.0.0.1 单端，token 鉴权）；
  - 本机 HTTP/WS 服务网关 v0（只读命令 + 审批）；
  - 一个最小测试客户端（Node 脚本或测试页）订阅事件流 + 发起审批裁决；
  - 测试：事件 wire 形状与桌面 GUI 通道逐字节一致；`approval-requested → approve → approval-resolved` 全链路跑通。
- **验收标准**：
  1. 事件信封 JSON 与 `core_event_bridge.rs:107-120` serialize 产物逐字节一致（自动化断言）；
  2. 远程 approve 后 run 从 awaiting-approval 恢复 running（`core_run_commands.rs:247-257` 路径）；
  3. GUI 通道与网关通道互不干扰（关掉网关，GUI 事件照常）。
- 阶段内不做：加密、证书、移动端。

#### P1 局域网直连（约 3-4 周）

目标：真实移动端在局域网内可用，核心场景 = 远程审批 + 事件流查看。

- 交付物：
  - 配对 v0（一次性 token + 设备登记 + 撤销）；
  - TLS + 自签证书 + 指纹固定；
  - mDNS 辅助 + 二维码/手动引导；
  - 移动端 Companion v0（审批卡片 + 会话列表 + 事件流）；
  - 只读投影（会话索引/正文/run 快照，游标追平）。
- **验收标准**：
  1. 手机（iOS/Android 之一）在同一 Wi-Fi 下：扫码配对 < 60s；审批端到端 < 2s；事件流实时（< 500ms 延迟）；
  2. 桌面重启后移动端自动重连并按 lastSeq 追平，无重复渲染、无丢终态；
  3. 撤销设备后旧设备立即失去连接；
  4. 断网/关桌面场景按 §3.4 矩阵表现正确；
  5. 安全：抓包验证 TLS + 指纹校验生效；伪造裁决被 I-02 拒绝。
- 阶段内不做：中继、推送、远程发消息。

#### P2 云中继 + 通知（约 3-4 周）

目标：跨网可达 + 移动网络可用。

- 交付物：
  - 中继服务 v0（无状态转发 + 设备在线状态 + 可选推送适配）；
  - `RelayLink`（桌面出站 + 移动端出站，端到端设备级加密）；
  - 设备管理 UI（桌面设置页：列表/改名/撤销）；
  - 终端输出 / 后台任务只读查看（复用 `workbench_get_background_task_output` 白名单）。
- **验收标准**：
  1. 手机在 4G/5G 下（与桌面异地）完成审批 < 3s；
  2. 中继宕机不影响局域网直连路径（双链路自动回退）；
  3. 端到端加密验证：中继服务日志无业务明文；
  4. 8 端并发连接压测：事件延迟 p95 < 1s，无丢 Critical；
  5. 桌面离线时移动端展示"Hub 离线"并正确挂起命令（§3.4 矩阵）。
- 阶段内不做：P2P/WebRTC、远程发消息。

#### P3 多端扩展（约 4-6 周）

目标：Web 面板 / CLI / 第二桌面接入 + 写命令面开放。

- 交付物：
  - 远程发消息（`md.run.start` → `core_run_task`）与取消（`md.run.cancel`）；
  - Web 面板（浏览器直连或经中继）；
  - CLI（Controller 角色，命令面子集）；
  - 文件浏览只读（白名单目录树）；
  - 能力协商完善 + 协议版本双共存。
- **验收标准**：
  1. 手机发消息 → 桌面 run 启动 → 全端事件同步，全程 < 2s 首帧；
  2. Web 面板在未配对浏览器上无法访问（会话 token 机制）；
  3. CLI 逐命令鉴权正确（只读命令免确认、写命令需授权）；
  4. 旧版本移动端与新桌面共存（协议版本协商）无功能回归；
  5. 全量回归：桌面 GUI 现有功能零变化（快层/中层测试全绿）。
- 阶段内不做：多 Hub 同步、影子执行、WebRTC P2P（列入远期）。

#### 远期（P4+）

- WebRTC P2P（跨网直连免中继）；
- 第二桌面作为 Companion 观察 Hub；
- 多 Hub 远程代理（§2.5 开放问题）；
- IoT/快捷指令接入（Controller）。

### 8.3 非目标与边界（明确不做）

1. 移动端不携带引擎副本（无离线执行）；"Hub 离线 = 移动端只读"是产品预期，不是缺陷；
2. 不做多主复制/离线编辑/冲突合并（§5.7 论证）；
3. 不做端间文件同步（文件只在桌面；移动端只读浏览白名单）；
4. 不做 WebRTC 信令与 TURN 的自建（P4 前）；
5. 不做中继的业务状态（无事件存储/无账号体系——账号体系仅作中继可选增强，§4.5）；
6. 不做"另一台桌面接管 Hub"（故障转移）；桌面数据备份由现有快照机制承担（`main.rs:350-353` 快照存储 + `spawn_snapshot_loop`，`main.rs:445`）。

### 8.4 门禁与测试策略（对齐仓库铁律）

- 事件 wire 形状锁定测试（P0 起）：跨端载荷与 GUI 通道逐字节一致，入快层；
- `buffer.rs` 同款压力测试（扇出端级缓冲）：Delta 丢帧只丢 delta、Critical 必达（对齐 `buffer.rs:355-445` 先例，release + `--ignored` 显式跑）；
- 审批链测试：服务入口 → `resolve` → 状态机恢复 → `approval-resolved` 落库，入快层（复用 `core_run_commands.rs:4193+` 测试基建）；
- 配对/撤销测试：设备登记、撤销、过期、重放攻击（一次性 secret 复用拒绝）；
- 多端回归不破坏现有门禁：`npm run typecheck`、快层 vitest、Rust `cargo test --workspace` 全绿才可提交（AGENTS.md 铁律）；
- 网关代码遵循现有测试风格：纯逻辑与 Tauri 解耦（`run_task_impl` 先例），`#[path]` 独立编译测试（`core_event_bridge.rs:2-4` 先例）。

### 8.5 阶段依赖与里程碑图

```
P0 原型（本机闭环）
 │  F1 事件契约锁定 → F2 Emitter 扇出 → F3 本机网关 → F5 远程审批闭环
 ▼
P1 局域网（真实移动端）
 │  F4 配对 v0 → F6 事件流只读投影 → F7 mDNS/扫码引导 → F9 Companion v0
 │  验收：扫码配对 <60s、审批 <2s、重连追平、撤销生效、抓包验 TLS
 ▼
P2 云中继（跨网）
 │  F8 RelayLink + 端到端加密 → 中继服务 v0 → 设备管理 UI → 终端/任务只读
 │  验收：4G 异地审批 <3s、中继宕机自动回退局域网、压测 8 端 p95<1s
 ▼
P3 多端扩展（Web/CLI/写命令面）
 │  F11 远程发消息/取消 → Web 面板 → CLI（Controller）→ 文件浏览只读
 │  验收：手机发消息全端同步 <2s 首帧、Web token 机制、协议双版本共存
 ▼
P4+ 远期：WebRTC P2P / 多 Hub 代理 / 第二桌面观察端
```

里程碑判定规则：**每阶段验收标准（§8.2）全绿才进入下一阶段**；任一阶段发现"单写者假设被破坏"（移动端出现绕过桌面的写路径）即回退评审（该假设是本方案一致性根基，§5.1）。

---

## 9. 附录

### 9.1 术语表

| 术语 | 定义 |
|------|------|
| Hub（中枢端）| 桌面主端；唯一权威（执行/存储/裁决），唯一对外服务端 |
| Companion（伴侣端）| 移动端等附属端；只读投影 + 受控命令 |
| Controller（控制端）| 未来 CLI/脚本/自动化端；命令面全量但逐命令鉴权 |
| Link | 链路抽象：LocalLink（局域网 TLS WS）/ RelayLink（云中继 wss）统一接口 |
| 配对（Pairing）| 带外信任建立过程（二维码/输码 + 密钥交换），产物 = 双方设备记录 |
| 设备身份 | { deviceId, role, form, Ed25519 公钥, 指纹 }；私钥不离开设备 |
| 单一真相源（SoT）| 桌面 Hub 是全部业务状态的唯一权威写入者 |
| 实时轨 / 收口轨 | 事件双轨：实时预览帧（sequence=None，即时渲染）与落库帧（携带 sequence，追平依据）|
| 端级背压 | 事件扇出时按端（deviceId）分桶的缓冲水位与丢帧（Delta 可丢、Critical 必达）|
| 能力声明 | 端在握手时声明 role/form/capabilities，网关按"能力 ∩ 白名单"裁剪暴露面 |
| schemaVersion | 信封层协议版本（现值 1）；与事件字段演进无关，端协议不兼容才 bump |
| 幂等键 | 命令帧携带 idempotencyKey，桌面按 (deviceId, key) 去重与响应重放 |
| 游标（cursor）| 会话内单调 sequence；断线重连后移动端按 afterSequence 追平 |

### 9.2 参考代码索引（本方案引用的全部锚点）

| 主题 | 位置 |
|------|------|
| 事件契约（41 变体）| `crates/conex-types/src/events.rs:304-782` |
| 事件信封（扁平 JSON + schemaVersion）| `crates/conex-types/src/events.rs:905-1013` |
| 事件类型名登记宏 | `crates/conex-types/src/events.rs:789-852` |
| 事件背压分级 | `crates/conex-types/src/events.rs:867-893` |
| PermissionRequest / ApprovalDecision | `crates/conex-types/src/events.rs:196-232` |
| Emitter trait / TauriEmitter / EventBridge | `apps/agent-workbench/src-tauri/src/core_event_bridge.rs:51-145` |
| 事件缓冲（水位丢帧）| `apps/agent-workbench/src-tauri/src/buffer.rs:24-206` |
| 缓冲压力测试先例 | `apps/agent-workbench/src-tauri/src/buffer.rs:355-445` |
| BufferedRunEventBridge / BridgeDeltaSink | `apps/agent-workbench/src-tauri/src/engine.rs:1643-1741` |
| 审批门（ApprovalGateImpl）| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:161-344` |
| 审批命令入口与落库 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3746-3831` |
| run 装配（串行守卫/权限模式）| `apps/agent-workbench/src-tauri/src/core_run_commands.rs:3043-3172` |
| 裁决路由（approval_router）| `crates/session-loop/src/approval_router.rs:73-118` |
| 查询面（status/事件分页/快照）| `apps/agent-workbench/src-tauri/src/core_query_commands.rs:276-559` |
| 会话命令面 | `apps/agent-workbench/src-tauri/src/session_commands.rs:41-180` |
| 模型目录命令（纯函数式命令先例）| `apps/agent-workbench/src-tauri/src/catalog_commands.rs:42-71` |
| 命令 manifest（surface=engine/gui）| `apps/agent-workbench/src-tauri/src/command_manifest.rs:26-68` |
| 命令注册面（setup 装配）| `apps/agent-workbench/src-tauri/src/main.rs:90-209,290-456` |
| DB schema（v5）| `crates/conex-db/src/schema.rs:121-266` |
| 事件存储（append/query/sequence）| `crates/conex-db/src/events.rs:8-121` |
| run 存储（状态机/usage/pending）| `crates/conex-db/src/runs.rs:21-371` |
| 会话存储（索引/孤儿清理/元数据）| `crates/conex-db/src/sessions.rs:15-335` |
| Store trait / PersistedEvent | `crates/orchestrator/src/persist.rs:110-150` |
| Transport 接口 / TauriTransport | `apps/crish-desktop/src/api/transport/types.ts:47-83`、`apps/crish-desktop/src/api/transport/tauriTransport.ts:123-364` |
| 事件 handler 体系（复用候选）| `apps/crish-desktop/src/api/chat-bridge/handlers/` |
| 生成的事件 TS 类型 | `packages/shared-types/src/generated/engine/` |

### 9.3 开放问题（子方案裁决项）

| # | 问题 | 裁决建议（本方案倾向）| 归口 |
|---|------|----------------------|------|
| O1 | `session-index-changed` 是否新增事件变体（vs index 版本号拉取）| 【裁决修正 5】**不新增变体（41 变体冻结）**：走 M6 `events.session.updated` 会话面消息 + `session_index_snapshot` 版本对账兜底；本项关闭 | D2/D4/M6 |
| O2 | 审批决策帧走专用帧还是通用 command | 通用 command（`md.approval.decide`），帧面最小 | D2 |
| O3 | 移动端事件渲染是复用桌面 handler 还是独立实现 | 复用 handler 模块化（§6.6.2），抽共享包 | D7 |
| O4 | 端级缓冲是复用 `EventBuffer` 按 deviceId 分桶还是新实现 | 复用 `EventBuffer` 数据结构（同构换 key）| D4 |
| O5 | Web 端凭据模型（无安全私钥存储）| 短时效会话 token（§7.2）| D3 |
| O6 | 多 Hub 连接（一台手机连两台桌面）| P1 不支持；P3+ 设计连接切换 | D3 |
| O7 | 中继的账号体系（可选）| 只绑定 hubId，不做业务命名空间（§4.5）| D6 |
| O8 | 第二桌面是否可升级为 Hub | 远期；需多 Hub 同步方案先行 | 远期 |
| O9 | 网关是否抽独立 crate（`conex-md`）| P2 后抽 crate（复用 `conex-db` 演进先例）| D2 |

### 9.4 一句话总结

端模型：**桌面 Hub 唯一权威 + 移动端 Companion 只读投影与受控命令（严格主从）**；拓扑：**局域网 TLS 直连优先 + 云中继兜底（同一应用层协议，链路抽象屏蔽差异）**；身份：**用户×设备×会话三元 + 一次性配对（二维码/输码）+ 可撤销设备**；一致性：**桌面单一真相源（单写者）+ 事件 sequence 游标追平 + 审批复用现有 resolve 入口**；关键融合点：**`AgentEventEnvelope` 直接作跨端事件基（零协议发明）、`Emitter` trait 增加扇出实现、`surface=engine` 命令面作服务暴露边界、`ApprovalGateImpl.resolve` 作远程审批唯一入口、前端 `Transport` 接口作移动端复用契约**。

<!-- D1-PART3-ANCHOR -->
