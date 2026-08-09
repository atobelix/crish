# Z0 多端互通总方案（Master Plan）

> 文档编号：Z0-master-plan
> 角色：多端互通方案整合子代理 W2（总方案整合）
> 日期：2026-08-09
> 定位：多端互通方案集的**单一入口**——实施者先读本总览，再按章节索引查阅分方案。
> 输入：`docs/multi-device/plans/` 全部 25 份方案（D1-D8 / F1-F6 / M1-M8 / AC / R2A / R2B）
>       + `docs/multi-device/audits/` 三份审计（AU1 交叉一致性 / AU2 代码融合度 / AU3 可执行性）。
> 说明：调度裁决文档（W1）未产出，本总方案中的"已裁决"条目以三份审计原文的裁决建议为基准，
>       标注来源（AU1/AU2/AU3）；凡需用户拍板的跨文档架构裁决已在第 3 章集中标注。
> 编码：UTF-8 无 BOM，中文。

---

## 目录

1. [愿景与定位](#1-愿景与定位)
2. [架构总览](#2-架构总览)
3. [核心决策记录](#3-核心决策记录)
4. [协议摘要](#4-协议摘要)
5. [功能摘要](#5-功能摘要)
6. [安全摘要](#6-安全摘要)
7. [平台与发布摘要](#7-平台与发布摘要)
8. [统一实施路线](#8-统一实施路线)
9. [任务包拆分](#9-任务包拆分)
10. [待裁决登记](#10-待裁决登记)
11. [文档索引](#11-文档索引)
12. [验收门禁](#12-验收门禁)

---

## 1. 愿景与定位

### 1.1 一句话愿景

**crish 多端互通 = 桌面 Hub + 手机 Companion + 云中继 + P2P**：让 crish 桌面端这台"持有 API keys、可执行 Agent、可写文件"的机器，在用户离开电脑时仍可被信任地触达——手机在任何地点**审批、看进度、看输出、看文件、收通知**，而桌面始终是唯一权威（单一真相源）。

一句话愿景：**"电脑在跑，手机在手"——把 crish 桌面引擎的视野与关键控制权，安全地带到用户的第二块屏幕上。**

核心价值锚点（来自 D1 母方案与 D4/D5 的验收红线）：

- 远程审批端到端 < 2s（局域网）/ < 3s（4G 异地）——审批是移动端第一功能；
- 事件流实时 < 500ms（局域网）——"随时看一眼"的体验底线；
- 桌面关机 = 移动端诚实显示"Hub 离线"，绝不假装在线；
- 移动端一切写操作都降级为"对桌面的命令调用"，不绕过桌面（单写者铁律）。

### 1.2 现状与背景

crish 桌面端当前是**单一进程、单一 WebView、零对外服务接口**的 Tauri 应用（D1 §1.1）：

- Rust 引擎 15 个 crate（session-loop / orchestrator / agent-provider / conex-db / conex-types 等），全部能力以 `#[tauri::command]` IPC 暴露；
- 事件经 `app.emit("workbench-run-event", payload)` 广播，**41 种域事件 + 扁平信封 JSON**（`crates/conex-types/src/events.rs`）——天生就是 wire 协议（注释明言"与 daemon WS 广播同构"）；
- 前端经 `Transport` 抽象层直调命令（`apps/crish-desktop/src/api/transport/types.ts:47-83`），无 WebSocket、无网络层；
- 命令面 `command_manifest.rs` 已有 `surface: engine/gui` 字段（engine = "三端共用契约面"）——**设计者早已预见多端**；
- `tauri.conf.json:29` 的 CSP 已预留 `http://127.0.0.1:8765` / `ws://127.0.0.1:8765`——服务端口已预埋。

**AU2 审计结论（代码融合度）**：方案声称的融合点 8/10 完全成立、2/10 成立但需改造注记、0 不成立；核心主张（零协议发明 / 零引擎改动 / 复用现有入口）全部经受住实读核对。

### 1.3 设计原则（四原则）

| 原则 | 含义 | 出处 |
|------|------|------|
| **简洁（零协议发明）** | 凡是现有代码已有的事实（41 事件信封、sequence 游标、命令 manifest、审批门 resolve）一律复用；多端互通只增加"传输"与"身份"两层。跨端事件载荷与桌面事件通道**逐字节一致** | D1 §1.4 原则 1、D3 §1.3 原则 1 |
| **安全默认** | 服务默认关闭、wss 强制 + 自签证书指纹固定、消息级 HMAC 签名、能力分级 + 远程上限 ask、全部远程动作入审计打码。移动端永不见 provider 密钥 | D5 D-01~D-11、M7 全篇 |
| **与现有代码融合** | 引擎/事件桥/存储零改动或近零改动：FanOutEmitter 实现既有 `Emitter` trait 挂汇聚点；REST handler 直调既有 `*_impl` 契约体；续传复用 `query_events` 开区间分页；审批复用 `resolve`（I-02 防伪造不变） | AU2 全篇、D2 §11 |
| **前后端分离** | 移动端五层单向依赖（UI→状态→数据→网络/存储），领域层零 React 依赖（vanilla zustand `createStore`）；表现层可整体换皮（未来鸿蒙 ArkUI / 新 UI 框架），领域层 100% 保留 | D4 §4.1、M4 §2 |

### 1.4 阅读指南（本总方案怎么用）

1. **先读**：第 2 章（架构总览）→ 第 3 章（核心决策记录，开工前必读）→ 第 8 章（统一实施路线）；
2. **做哪个阶段**：查第 8 章该阶段的"对应分方案章节"，再按第 11 章文档索引取分方案精读；
3. **领任务**：查第 9 章任务包（编号/工作量/依赖/文件域），验收标准见第 12 章；
4. **遇分歧**：以本总方案第 3 章决策记录为准（单一裁决真源）；未登记事项按第 10 章待裁决登记走裁决流程。

### 1.5 术语表（跨文档统一口径）

| 术语 | 定义 |
|------|------|
| Hub（中枢端） | 桌面主端；唯一权威（执行/存储/裁决），唯一对外服务端 |
| Companion（伴侣端） | 移动端等附属端；只读投影 + 受控命令 |
| Controller（控制端） | 未来 CLI/脚本端；命令面全量但逐命令鉴权 |
| Link | 链路抽象：LocalLink（局域网 TLS WS）/ RelayLink（云中继 wss）/ P2PLink（UDP 打洞） |
| 配对（Pairing） | 带外信任建立过程（二维码/输码 + 密钥交换），产物 = 双方设备记录 |
| 配对码 | CXN-XXXX-XXXX-XXXX（12 字符、60bit、10min、一次性） |
| DeviceEnvelope | 跨端协议外层信封（v/kind/msgId/ts/from/to/auth/body），所有消息统一包装 |
| 单一真相源（SoT） | 桌面 Hub 是全部业务状态的唯一权威写入者 |
| 实时轨 / 收口轨 | 事件双轨：实时预览帧（sequence=None，即时渲染）与落库帧（携带 sequence，追平依据） |
| 端级背压 | 事件扇出时按端分桶的缓冲水位与丢帧（Delta 可丢、Critical 必达） |
| 能力声明 | 端在握手时声明 role/form/capabilities，网关按"能力 ∩ 白名单"裁剪暴露面 |
| schemaVersion | 信封层协议版本（现值 1）；与事件字段演进无关，端协议不兼容才 bump |
| 幂等键 | 命令帧携带 msgId/业务键，桌面按 (deviceId, key) 去重与响应重放 |
| 游标（cursor） | 会话内单调 sequence；(session_id, sequence) 为去重/续传锚点 |
| outbox | 移动端本地持久化的待发动作队列（审批决策等），重连后按序重放 |
| 追平（catch-up） | 重连后按事件游标补齐断线期间缺失的事件 |
| 相位投影 | 把传输层状态映射为 UI 连接相位的纯函数 |
| 深链 | crish:// 应用内路由：推送点击与页面导航的统一入口 |
| 厂商通道 | 华为 HMS / 小米 / vivo / OPPO / 荣耀等系统级推送（区别于 FCM/APNs） |
| RNOH | React Native OpenHarmony 社区适配，鸿蒙 NEXT 上跑 RN 的方案 |
| 三轨版本 | 应用版本（各端独立 semver）/ 协议版本（注册表派生）/ 兼容窗口（minSupported） |
| 对拍（parity） | TS 侧与 Rust 侧对同一组样例的解析结论一致性测试 |

---

## 2. 架构总览

### 2.1 端模型（文字拓扑图）

多端体系按**角色（role）**与**形态（form factor）**两个正交维度建模（D1 §2.1）：

```
角色维度（权力边界）：
  Hub（中枢端）      —— 唯一权威：执行 Agent、持有存储与密钥、裁决审批
  Companion（伴侣端） —— 附属观测/操作端：只读投影 + 受控命令（审批、控制）
  Controller（控制端）—— 未来：CLI / 脚本 / 自动化（命令面全量但逐命令鉴权）

形态维度（能力与 UX）：
  Desktop / Mobile / Web / CLI / Second-Desktop

裁决：当前与可见未来只实现 Hub + Companion 两种角色；Controller 预留（形态注册表先行）。
```

```
┌─────────────────────────── 桌面 Hub（唯一权威） ───────────────────────────┐
│  Rust 引擎（session-loop/orchestrator）── 事件桥 EventBridge                │
│    └─ FanOutEmitter（新增，实现 Emitter trait）                              │
│         ├─ TauriEmitter（webview 通道不变）                                  │
│         └─ WsBroadcast（新增，WS 扇出到各端）                                │
│  服务网关（新增 server 模块）：REST /v1/** + WS /v1/events（127.0.0.1:8765   │
│    恒监听；配对模式显式开 0.0.0.0）                                          │
│  DeviceRegistry（配对/设备表）+ RelayClient（出站连中继）+ P2P 客户端        │
└──────────────────────────────────┬─────────────────────────────────────────┘
             局域网直连（L1，TLS WS + 指纹固定）│ 中继（L2，wss）│ P2P（L3，UDP 打洞）
┌──────────────────────────────────▼─────────────────────────────────────────┐
│  手机 Companion（crish-mobile，Expo SDK 57 / RN 0.86）                      │
│  五层：UI → 状态（vanilla zustand）→ 数据（repository+outbox）→ 网络（WS）→ 存储 │
│  五 Tab：首页 / 会话 / 审批 / 文件 / 设置                                     │
│  能力：审批（第一功能）/ 事件流 / 终端输出（只读）/ 文件浏览 / 通知推送          │
└────────────────────────────────────────────────────────────────────────────┘
```

**关键裁决**（D1 §2.3）：采用**严格主从（Hub-Spoke）**模型 A + 模型 C 的"断连只读投影 + 命令队列"特性；否决对等（Peer）模型。移动端**不持有**引擎副本、SQLite 存储、工具执行能力、设备主密钥、provider 凭据。

**能力声明**（D1 §2.4）：每端握手时声明 `{deviceId, role, form, appVersion, protocolVersions, capabilities}`，网关按"能力 ∩ 全局白名单"裁剪暴露面；能力协商失败 → 拒绝连接并返回可读原因。

→ 分方案：D1 §2（端模型）、D2 §4（服务形态）、D4 §1-2（移动端定位）。

### 2.2 三层网络

| 层 | 名称 | 场景 | 技术形态 | 服务器带宽 | 实施阶段 |
|----|------|------|----------|-----------|----------|
| L1 | 局域网直连 | 同一 Wi-Fi/网段 | 二维码引导（主）+ mDNS 辅助 + 手动输入（兜底）；TLS WebSocket 直连 + 证书指纹固定 | 0 | R1-R2 |
| L2 | 云中继 | 跨网默认路径 | 双端出站 wss 连中继（Rust 无状态转发），账号中心签发 relay credential | 全量（可压缩） | R4 |
| L3 | P2P 打洞 | 跨网优选路径 | 中继信令协助的自研 UDP 打洞 + 轻量可靠 UDP + AES-256-GCM（密钥派生自配对 master） | 约 0（仅信令） | R4（后半） |

**路径优先级**（M3 §3.2）：同网判定命中 → L1；跨网 → 先试 L3、失败回落 L2；全部不可达 → 离线投影模式。切换采用 **make-before-break + 质量评分 + 滞回**，会话连续性由逐会话游标续传兜底——链路切换对业务层透明。

**中继角色**（D1 §3.3 / M2 §2）：只转发、不解密（业务载荷端到端设备级加密，中继仅见密文）；零业务存储、零队列（离线目标回 delivery-offline）；可选辅助：在线状态（供推送节流）、UDP 反射地址（P4 前不做）。

**带宽结论**（M3 §1.4）：L3 打洞成功时服务器带宽约等于 0（单会话建立 2~10 KB 信令）；L2 兜底时启用 zstd 压缩（JSON 事件流 5~10 倍）+ Delta 帧裁剪 + 每端配额限流。

→ 分方案：M3（网络三层 + P2P 全案）、M2（中继服务）、D1 §3（拓扑权衡）。

### 2.3 四类令牌（令牌分治）

四类令牌**各司其职、不互相代替**（M7 M-04；AU1 重点 1 确认为同源自洽）：

| # | 令牌 | 签发方 | 用途 | 生命周期 | 存储 |
|---|------|--------|------|----------|------|
| T1 | 配对令牌（token_key/refresh_key） | 桌面（D3 配对派生：X25519 ECDH + 配对码 PAKE → master → HKDF 三子钥） | 端间消息级 HMAC 签名（LAN/中继/P2P 全链路） | 长期（撤销即删）；refresh 一次性 | 桌面落盘派生值；移动端 Keychain/Keystore |
| T2 | 账号 token（access/refresh） | 账号中心（flowbit-auth 复用） | 云身份：登录、设备注册、desktop-auth 授权 | access 15min / refresh 30 天轮换 | 桌面 OS 凭据库；移动端 secure-store |
| T3 | 中继凭据（relay credential rc_<32B>） | 账号中心（新增 relay_credentials 模块） | 中继连接握手（verify 一次性 nonce） | TTL 30 天可刷新 | 服务端只存 HMAC |
| T4 | 推送注册（push_tokens） | 账号中心（新增 push_tokens 表） | 厂商通道寻址（APNs/HMS/小米/...） | 随设备解绑/卸载撤销 | vendor_token 加密存储，token_hash 幂等 |

**信任根唯一**（AU1 §2.3）：master 是唯一信任根——D3 配对派生 → M3 P2P 链路密钥（k_link）、M2 中继 AEAD（enc_key）都从它展开，无第二套独立密钥体系。HMAC-only 存储纪律一致（无明文落库设计）。

→ 分方案：D3 §4-5（配对与派生）、M7 §4（令牌全景）、AC §6.3-6.4（账号侧两模块）。

### 2.4 五层移动端分层

移动端（Companion）内部按**五层单向依赖**组织（D4 §4.1），M4 细化为"七层三域"（§2）：

```
┌─ 表现层（可整体替换）─────────────────────────────────────────────┐
│  UI：app/（expo-router 路由=深链命名空间）+ components/            │
│  （M4 细化：L1 路由骨架 / L2 页面 / L3 区块 / L4 原子组件）          │
├─ 适配层（随 UI 框架半替换）────────────────────────────────────────┤
│  view-model（useXxxScreenModel）+ store 订阅绑定 + 平台封装         │
│  （M4 细化：L5 适配层——表现层与领域层的唯一桥梁）                    │
├─ 状态层（领域层，零 React 依赖）───────────────────────────────────┤
│  7-8 个 vanilla zustand store（auth/connection/approval/session/   │
│  event/terminal/settings）+ immer + 纯函数 selectors               │
├─ 数据层──────────────────────────────────────────────────────────┤
│  repository（网络优先 + 缓存回退 + 离线入队）+ outbox（离线决策队列） │
├─ 网络层 / 存储层（互不可见）───────────────────────────────────────┤
│  ReconnectingWsClient / WsGateway / signer（HMAC）                │
│  SQLite（12 张表，WAL + user_version 迁移）+ secure-store（4 密钥位）│
└──────────────────────────────────────────────────────────────────┘
全部层只依赖 @crish/shared-types（类型/解析器/错误码）与生成产物
```

**关键纪律**：

- 领域层（store/数据/网络）**零 React/Expo 依赖**——这是"换 UI 框架 100% 保留"的架构前提（M4 §2.5；AU1 P1-7 已裁决 vanilla `createStore`）；
- 事件到达链：`WsGateway.on → 解析器（parseEngineEvent）→ repository 先落 SQLite → store 动作`——组件不碰原始事件（D4 §4.4.4）；
- 移动端本地任何状态都是**可丢弃投影**：重建唯一手段是从 Hub 拉取；本地状态不反向影响桌面（D1 §5.8 关键不变量）。

→ 分方案：D4 §4（五层架构）、M4（七层三域 + UI 体系）、M5（工程细化：8 store / 12 表 / outbox）。

### 2.5 跨端协议基

**单一应用层协议，双层复用**（D3 §3.2，链路无关）：

```
┌───────────────────────────────────────────────┐
│ L5 业务面  events / commands / approval / ...  │（复用既有 wire 形态）
├───────────────────────────────────────────────┤
│ L4 会话面  subscribe / resume / ack / heartbeat│
├───────────────────────────────────────────────┤
│ L3 信封    DeviceEnvelope（v/kind/msgId/ts/    │  ← 协议新增（唯一新增层）
│            from/to/auth/body）                 │
├───────────────────────────────────────────────┤
│ L2 安全    TLS（首选）+ 设备令牌 HMAC-SHA256    │
├───────────────────────────────────────────────┤
│ L1 传输    WebSocket（JSON 文本帧，一帧一消息）  │
└───────────────────────────────────────────────┘
```

- **事件载荷 = `AgentEventEnvelope` 扁平 JSON 原样透传**（与桌面事件通道逐字节一致），跨端不二次包装、不新增字段（D3 §1.3 原则 1）；
- **命令 = Tauri 命令面的子集镜像**：`cmd.*` 参数/响应沿用现有 serde camelCase 契约，不造第二套 DTO（M6 §2.4 原则 1）；
- **消息级 HMAC**：每条消息带 `auth {deviceId, ts, nonce, sig}`（HMAC-SHA256(token_key, canon(header) ∥ bodyJson)），nonce 防重放（±5min 窗口 + 4096 条 LRU）；
- **103 个 kind**（M6 §1.1）：cmd 37 + result 37 + events 11 + stream 4 + pair 4 + auth 3 + device 4 + heartbeat 2 + error 1；
- **版本化三轨**（D3 §10）：跨端协议 `v`（握手协商）/ 事件信封 `schemaVersion`（缺省=1）/ 命令清单 `contractVersion`（semver）。

→ 分方案：D3（协议全案）、M6（消息级细化 + JSON Schema）。

### 2.6 一致性模型（桌面 SoT）

**桌面 Hub 是唯一真相源（SoT）**，覆盖四类状态（D1 §5.1 / D6 §5）：

| 状态域 | 真相源 | 移动端视角 |
|--------|--------|------------|
| 会话索引/正文 | sessions/session_messages 表 | 只读投影（拉取 + 事件增量） |
| run 状态 | runs 表 + CoreRunState | 只读投影（getRunSnapshot） |
| 审批状态 | ApprovalGateImpl.pending | 裁决入口（命令），状态仍在桌面 |
| 审计 | events 表 security-audit | 只读（过滤后摘要） |

**事件传播双轨**（D1 §5.3）：实时轨（events.push，含 sequence=None 预览帧，按稳定键 upsert）+ 收口轨（events.resume 按逐会话游标追平，落库帧以 DB 行 sequence 为准）。背压分级（Delta 可丢 / Soft 尽力 / Critical 必达）跨端不改变。

**写命令 at-least-once**（D6/M6/F2 四环节一致，AU1 重点 7）：outbox 队列 + 幂等键（msgId / toolCallId / clientMessageId）+ 桌面 sync_commands 去重（30 天保留）。审批两阶段确认：命令响应（accepted）+ approval-resolved 事件收敛，**绝不乐观显示"已批准"**（D6 §8.3）。

**无冲突消解**：单写者 + 会话串行守卫 + pending.remove 单写 → 一致性退化为"传播延迟 + 游标追平"，不引入 CRDT（D1 §5.7）。

→ 分方案：D6（同步一致性全案）、D1 §5（一致性模型）、F2 §11（审批冲突处理）。

### 2.7 桌面侧新组件清单与装配顺序

多端互通新增组件全部在桌面进程内（D1 §6.7），引擎与存储零改动：

| 组件 | 职责 | 落点建议 | 依赖的现有件 |
|------|------|----------|--------------|
| md_gateway（服务网关） | 局域网/中继入站链路终结 + 鉴权 + 命令委托 | 新模块 apps/agent-workbench/src-tauri/src/server/（P2 后抽 crate conex-md） | Store、CoreRunState 访问器、命令实现体 |
| FanoutEmitter（跨端发射） | 事件多路扇出 + 按端缓冲 | core_event_bridge.rs 同风格新模块 | Emitter trait、EventBuffer 语义 |
| DeviceRegistry（设备注册表） | 配对记录/撤销/能力表 | conex-db 新表 device_registry（v6 迁移） | LocalDb |
| Link（链路抽象） | LocalLink / RelayLink / P2PLink 统一接口 | server/link.rs | — |
| RelayClient（中继客户端） | 桌面出站连接中继 | server/relay.rs | Link |
| md_api（服务接口定义） | 协议帧/命令映射/错误映射 | conex-types/src/device/ + server/router.rs | CoreError、serde camelCase |
| push-core（推送策略引擎） | 事件 → PushIntent 判定/去重/静默/节流 | src-tauri/src/push/ | 事件桥扇出 |
| 移动端应用 | Companion UI | apps/crish-mobile/（新增） | Transport/EventRouter/handlers 复用 |

**装配顺序**（进 main.rs setup 链，参照 main.rs:290-456 现有序列）：LocalDb → DeviceRegistry（读配对）→ CoreRunState（现状）→ EventBridge（改造为含扇出）→ md_gateway（依赖前述全部）→ RelayClient（可选，配置开启）。网关启动失败 = 仅关多端服务，core_get_status 的 diagnostics 如实上报（复用 StatusDiagnostics），不阻断应用启动（D1 §3.4 铁律）。

### 2.8 网络不可达场景（离线矩阵，D1 §3.4）

| 场景 | 移动端行为 | 桌面行为 | 恢复机制 |
|------|-----------|----------|----------|
| 局域网内桌面关机/睡眠 | 显示"Hub 离线"；本地快照可查；审批命令挂起 | 无影响（桌面不依赖移动端） | 桌面醒来 mDNS 恢复 → 移动端自动重连 + 游标追赶（R1 起补 Suspend/Resume 恢复，G-1） |
| 移动端断网 | 命令队列化（本地暂存，最多 20 条），事件订阅断开 | 无影响 | 网络恢复 → 重连 → 队列按序发送（幂等键去重） |
| 跨网且未配中继 | 提示"配置中继服务后可在任意网络访问" | 无影响 | 用户配置中继 → 重连（R4） |
| 桌面进程崩溃后重启 | 连接断开 | 重启后 restore（现有 run_restore） | 移动端重连后按 last_sequence 追平 |
| 中继服务故障 | 局域网直连仍可用（若同网） | 不依赖中继（仅出站） | 中继恢复后重连 |

**铁律**：桌面端功能不依赖多端互通——服务网关、中继客户端全部是桌面内的可选组件；网关启动失败只影响"对外服务"，不影响 GUI 与引擎（D1 §3.4，与 open_session_db 失败降级内存库的先例同构）。

### 2.9 移动端连接状态机（D1 §5.9，对齐 TransportStatus 四态扩展）

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
- `sync → live` 过渡必须**先追平后实时**：追平窗口内到达的实时帧按稳定键 upsert，追平完成时按 sequence 单调性裁剪重叠区（复用 sessionEventHydrate 既有消费语义）；
- 状态机在移动端与（未来）Web 端共用实现（纯逻辑可测，与 transport 实现解耦）；
- 移动端相位投影五态（D4 §6.2.5）：disconnected / connecting / ready / recovering / offline，映射为 UI 横幅与审批按钮可用性。

### 2.10 身份与会话模型（D1 §4）

**跨端身份三元组**：`{ 用户（User）, 设备（Device）, 会话（Session）}`：

```
User    — 人。本地身份 uuid（本机生成）；现状无账号体系，User 只在"多设备管理"语境出现；
          预留云账号绑定（中继服务需要账号 → 设备归属，R4）。
Device  — 每端一台设备一个设备身份 {deviceId, role, form, publicKey: Ed25519, fingerprint}；
          密钥对在设备本地生成，私钥永不离开设备；Hub 存桌面 app_dir()/identity/，
          Companion 存移动端安全存储。
Session — 业务会话（现有 sessions 表概念，不变）；"连接"是传输层状态，不混入业务模型。
```

**映射关系**：1 User 可有 N 台 Device（1 Hub + N Companion）；1 Device 同一时刻只与 1 Hub 建立主连接（多 Hub 连接列远期开放问题）；业务 Session 归属 User（不归属 Device）——任意已配对设备可看同一会话流。

**端能力声明示例**（D1 §2.4，握手时声明，网关按"能力 ∩ 白名单"裁剪）：

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

能力协商失败（版本不兼容）→ 拒绝连接并返回可读原因（G-8 引导文案）。

**信任根 = 配对记录**：Hub 侧 devices 表（deviceId → 公钥/指纹/角色/状态/配对时间）；Companion 侧 hubs 表（hubId → 公钥指纹/地址/证书指纹）。配对记录只增改不删除（撤销 = 状态标记）。

**多设备管理（Hub 侧）**：device_list / device_revoke（撤销设备：拒绝新连接，期满踢出）/ device_rename / device_rotate_keys（吊销旧公钥、要求重新配对）。存储：P1 用 session_meta 起步，P2 迁移专用表（与 session_sequence 演进先例一致）。**云账号为可选增强**：中继注册时绑定 hubId，不做业务会话命名空间（D1 §4.5）。

---

## 3. 核心决策记录

> **说明**：本章汇总三份审计（AU1/AU2/AU3）的裁决建议与母方案既定裁决，是全库唯一的裁决索引。
> "状态"列：已裁决 = 审计建议明确且无跨文档反对；R0 评审 = 建议已给出，需在 R0 协议冻结评审会上
> 落 ADR 并由用户拍板确认。W1 调度裁决文档未产出，本表以审计原文为准（任务书授权）。

### 3.1 三大架构冲突裁决（开工前必须裁决，AU3 §5.1）

| # | 冲突 | 冲突方 | 裁决（建议） | 依据 | 状态 |
|---|------|--------|--------------|------|------|
| C-1 | 认证与消息面三选一 | D2（Bearer+axum REST）vs D3/M6/M7/D5（DeviceEnvelope+HMAC）vs D4 §12.5 / M5（WsEnvelope） | **选 B：以 D3 为协议真源**（消息级 HMAC + 103 kind schema 已细化）；D2 的 axum 只承担"监听 + 信封编解码"，弃用 Bearer token 面；D4/M5 的 WsEnvelope 作废统一 DeviceEnvelope | AU3 §5.1 C-1；AU1 P1-5 同向；M5 §0.2 已声明信封并入 D3 体系 | 已裁决（R0 评审确认） |
| C-2 | TLS 范围 | D2 §3.2"v1 免 TLS"vs D1 §8.2 P1 / D3 §3.1 / D5 §10.1（wss 强制 + 自签 pinning） | **wss + 自签证书 + 指纹固定直接进 R1**（D3 §4.6 tlsFingerprint 已设计进配对协议）；D2 的"免 TLS v1"删除/标记为废弃 | AU3 §5.1 C-2；D5 §10.1 ADR | 已裁决（R0 评审确认） |
| C-3 | 移动端审批时机 | M8 §9.3 O2（一期只收通知）vs D1 §8.2 P1 / D4 §11.1 M2 / F2 全篇（端到端审批 <2s） | **R2 开放决策**：移动端远程审批是母方案 P1 验收红线，F2 已设计完整决策链路无技术阻塞；R3 推送只负责通知与深链直达 | AU3 §5.1 C-3 | 已裁决（R2 排期前确认） |

### 3.2 七组参数统一（AU3 §5.2）

| # | 参数 | 冲突值 | 统一值 | 涉及文档修正 |
|---|------|--------|--------|--------------|
| P-1 | 网关端口 | 8765（CSP 预留）vs 7821（D4 §10.2 早期笔误） | **8765** | D4 §10.2 联调矩阵改 8765；F6 §7.1 示例（18461）改 8765 |
| P-2 | 配对码格式 | D2 8 字符 120s / D3 CXN-12 字符 60bit 10min / D5 8 字符 base32 / D7 6 位 5min / F6 6 位 | **D3 的 CXN-XXXX-XXXX-XXXX（12 字符、10 分钟、60bit、5 次/码 + 3 并发码）** | D2 §7.2/§16.1、D5 §3.2/§6.3 打码断言、D7 §4.5a 配对段、D4 §5.1、F6 §6.1/§12.3 全部改引用 D3 §4.1 |
| P-3 | 事件变体策略 | D1 O1 新增 session-index-changed vs D2 §7.4 41 变体冻结 vs M6 会话面消息 | **41 变体冻结不新增**；会话列表增量走 M6 的 `session.updated` 会话面消息（走 D3 信封，避开登记三件套成本） | D1 §5.2/§9.3 O1 降级为远期；D2 §7.4 维持 |
| P-4 | 命令总数 | 92（D2/D3 旧快照）vs 95（M6 勘误 + browser 三条） | **95 = 注册面 91 + 登记先行 4**（command_manifest.rs:63-191） | D1 §6.4.1 / D2 §2.2+§9 / D3 §2.4+§12.1 全部更新；D2 §11-G"92→96"改"95→99" |
| P-5 | 阶段命名 | P/M/L/R 四套前缀 11 份文档混用 | **R0-R5 统一阶段**（见第 8 章）；各文档头加"本方案阶段 ↔ 统一阶段映射"一行 | 全库 11 份文档（AU3 §2.3 迁移动作） |
| P-6 | 服务生命周期 | 进程内嵌随 app 启停（D2）vs 开机自启 + 托盘常驻（D7 §11.4 缓解项） | **推送域启用后必须开机自启 + 托盘常驻**（走既有 watchdog.rs 先例）；D2 补"托盘/自启"接线 | D2 §4.1 生命周期、D7 §11.4 |
| P-7 | 网关聚合端点 | F1 §10 建议 companion_overview 聚合 vs 三查询分拉 | **首页刷新 >500ms 时补聚合端点**（D2/D3 落地时按 F1 §6.4 形状预留） | D2 路由表、F1 首页 |

### 3.3 AU1 冲突清单裁决（P0 四件 + P1 关键件）

| # | 冲突 | 裁决 | 来源 |
|---|------|------|------|
| P0-1 | 配对协议三套规格并存（D2/D5/D3/D7/F6 五套） | 以 **D3 §4.1 的 CXN-12 字符为唯一真源**（同 P-2） | AU1 §10.1 |
| P0-2 | 中继读帧边界与控制帧双轨（M2 帧级透传 vs M3 读 D3 信封 kind） | 以 **M2 §6.1/§6.2 为基线**：中继只解析 RelayFrame 头（to/from），不读 D3 信封；M3 §5.2 与 §9.4 的中继控制面并入 M2 RelayFrame 枚举（新增 peer-offline/backpressure 帧类型）；link.* 打洞信令作为业务层消息经 data.frame 透传 | AU1 §10.1 P0-2 |
| P0-3 | 每设备连接上限语义互斥（D2 单令牌 ≤2 / M2 ≤1 踢旧 / M3 连接族 ≤3） | 以 **M3 §7.5.4 连接族为准**（多链路共存是三层拓扑的机制前提）：同 kind 重复连接踢旧、不同 kind 同设备连接族 ≤3；M2 §4.6 与 §11.3 测试用例同步升级 | AU1 §10.1 P0-3 |
| P0-4 | 推送场景级别三处打架（task-suspicious / approval-resolved(expired) / S10 缺位） | 以 **D7 §3.2/§3.3 为推送域真源**：M6 §5.1 #35 task-suspicious 改 p0；M6 §5.3 补 S10 两行（runtime-error / runtime-intervention-required）、删除 P2-1 行；approval-resolved(expired) 统一为"引擎补发 expired 事件后推送（F2 R1 提案落地后生效），落地前移动端本地置灰" | AU1 §10.1 P0-4 |
| P1-1 | 命令总数 92 vs 95 | 95（同 P-4） | AU1 §10.2 |
| P1-2 | 同步面白名单 20 vs 26 | 以 **M6 §5.1 的 20 类为准**；D6 §7.3 可选表收缩（删 message-start/tool-batch-*/tool-input-repaired/checkpoint-* 可选项）；run-interrupted 实现前复核 restore.rs，不存在则移出白名单 | AU1 §10.2 |
| P1-3 | 命令路由命名两套（cmd.* camelCase vs remote.* snake_case）且无映射表 | M7 §2.9 增加 **remote.* ↔ cmd.* ↔ manifest 三列映射表**（生成器或测试锁定），或规定同名 | AU1 §10.2 |
| P1-4 | Tab 结构 M4 五 Tab vs M5 四 Tab | 以 **M4 §0.2 五 Tab（含文件）为准**，M5 §2.1 的 (tabs)/ 增加 files.tsx；F1 §4.1 / D4 §5.0 / F6 §12.1 加"已被 M4 §0.2 裁决"标注 | AU1 §10.2 |
| P1-5 | 推送 WS 中继游离于 D3 协议体系（独立帧/随机端口/6 位码/wsKey） | **方案甲（推荐）**：在线直推改为协议面 `events.push`（D3/M6 已具备），推送专用 PushMessage 降级为"移动端从 events.push 裁剪通知语义 + 厂商通道载荷"；D7 §4.5a 独立 WS 中继作废 | AU1 §10.2 |
| P1-6 | 中继代发职责冲突（M2 不做推送发送器 vs M8 D1/D2 中继代发演进） | M2 §2.1 加"演进项：中继代发（M8 第 0 章 D1/D2），一期不做"标注；M8 §3.3 注明与 M2 §2.1 的关系 | AU1 §10.2 |
| P1-7 | store 范式冲突（vanilla createStore vs React 绑定 create） | **vanilla `createStore`**（M4 §2.5），React 绑定收敛到适配层 hooks（M5 §3.1 改） | AU1 §10.2 |
| P1-8 | 共享基线目录未定稿（M4 三层 vs M5 扁平 vs M1 引用 D4 旧结构） | **共享基线 = M4 七层三域目录**；M1 §4.5 目录映射表按裁决后结构重写并标注版本基线 | AU1 §10.2 |
| P1-9 | appState 枚举两套（inactive vs foreground） | 统一为 **D7 的 active / background / inactive**；M2 §4.3-2 同步 | AU1 §10.2 |
| P1-10 | 配对令牌形态双轨（D3 HKDF 派生 vs D5 256bit 随机） | 以 **D3 §4.4 派生形态为准**（消息级 HMAC 已依赖派生值）；D5 §3.3 加注"由 D3 §4.4 派生形态取代" | AU1 §10.2 |
| P1-11 | 端口 8765 vs 18461 | 8765（同 P-1）；F6 §7.1 示例修正 | AU1 §10.2 |

**P2 精选**（轻微不一致，实现前顺手统一）：P2-1 enc_key"预留"状态更新为正式用途（M2 §5.6 / M3 §10.1 已启用）；P2-2 令牌 TTL 30 天 / 会话密钥 8h 由 D3 常量表补登记；P2-3 静默时段统一 D7 的 22:30-07:30；P2-4 M8 全篇"M3 中继"改名"M2 中继"；P2-5 配对全流程时长统一 <60s；P2-7 重试语义统一为"持续退避 + TTL 上限 + 5 次失败人工提示"；P2-9 危险度 1 允许的默认授权改 verify（L1）。（完整清单见 AU1 §10.3）

### 3.4 AU2 融合点修正与缺口处置（F 系列 + G 系列）

| # | 修正项 | 处置 |
|---|--------|------|
| F-1 | 命令条数 92 旧口径（D1/D2/D3） | 统一 95 = 91 + 4（M6 勘误转正） |
| F-2 | D1 §6.7 引用"apps/crish-mobile（现有目录）"不存在 | 改"新增 apps/crish-mobile/"（legacy 原型 R2A/R2B 已裁定整体删除，参考物在 reference/mobile-companion*） |
| F-3/F-4 | 文件读写暴露矛盾（D2 T3/T4 vs M6 白名单特批）与 core_search_files/core_check_command 矛盾 | **白名单单一真源**：v1 文件面按 M6 白名单特批 5 条（list_directory/read_file_content 只读 + write_file_content 受控写需显式开启），D2 的 T3/T4 分级表废弃，统一收敛到 remote_manifest |
| F-5 | F3 §3.4.2 引用 truncateToolOutput 不存在 | 改引用本地 helper 语义（ln(output, maxLines=16, maxChars=1600)）或现有导出 |
| F-6 | FanOutEmitter 挂法两文档不一致（D1 倾向第二桥 vs D2 替换构造点） | **采用 D2 形态**：main.rs 构造点替换为 FanOutEmitter（内部保留 TauriEmitter 分支）；明确 WS 侧 channel 语义（WS 侧按订阅过滤，不区分 channel） |
| F-7 | "41 变体冻结 vs 新增事件变体"张力 | 冻结（同 P-3）；F5 会话列表增量刷新用 M6 session.updated |
| F-8 | 行号漂移 4 处（EventBridge::new / 退出钩子 / 串行守卫 / BufferedRunEventBridge） | 以 2026-08-09 快照刷新；后续以符号名双索引复核 |
| X-5 | D1 不变量"网关暴露 ≤ 现有注册面"vs M6 14 条 [新增] mobile_* 命令 | **新增命令登记路径对齐**：任何新增移动端命令先注册进 command_registry! + manifest（保持注册面唯一真源），再决定暴露 |
| X-8 | PTY 输入 P2 归属（F3 只读 vs D5 operate 含终端输入） | 手机端终端只读（F3 §4.5）；PTY 输入通道 P2 评估（D5 O-02 同向） |

**落地缺口 10 项**（AU3 §5.3 G-1~G-10，均已给出补强建议，归入对应阶段任务包）：

| # | 缺口 | 处置（归入阶段） |
|---|------|------------------|
| G-1 | 桌面睡眠/唤醒的服务恢复 | R1：监听 Suspend/Resume → 重绑端口 + mDNS 重广播 + 已有 WS 踢重连 |
| G-2 | 桌面多实例端口竞争 | R1：单实例锁（Tauri 单实例插件/named mutex）+ 第二实例提示；配对模式仅首实例可开 |
| G-3 | mock 契约交付时机 | R0 后立即交付 mock daemon v0（按 device-protocol.json 生成的夹具服务器），与真实网关并行开发 |
| G-4 | Windows 防火墙/AP 隔离用户引导 | R1：配对页展示网络配置文件检测 + 公用网络提示切换 + AP 隔离时引导手动输 IP |
| G-5 | 桌面端常驻（开机自启 + 托盘） | R3 前：Windows Run 键 + 托盘图标 + 最小化到托盘（同 P-6） |
| G-6 | 移动端商店更新与协议兼容联动 SOP | R3 前：发布检查清单（协议变更时先桌面 → 移动端灰度 → 商店窗口预留 1-3 日审核期）落进 D8 阶段 4 验收 |
| G-7 | 中继/账号中心线上监控与容量 | R4 前：连接数/带宽/队列水位阈值 + 告警；容量按 8 端/账号 × 预计设备数 |
| G-8 | 旧桌面端（无网关版本）与新移动端升级路径 | R2/R3：协议版本不匹配时移动端引导文案（"请升级桌面端"）+ 兼容矩阵加反向用例 |
| G-9 | 审批超时权威语义（桌面无 expired 转移事件） | R1/R2：确认 APPROVAL_TIMEOUT→Expired 落库路径；若未落库按 F2 §8.3 补引擎增强（协议不变） |
| G-10 | 扫码 P2 vs 配对 P1 依赖 | R2 排期：二维码渲染（桌面侧）P1 必做；移动端扫码库评估（expo-camera）R2 末做 |

### 3.5 已裁决决策总表（快速索引）

| 决策 | 内容 | 来源 | 状态 |
|------|------|------|------|
| 端间主从 | 桌面 Hub 唯一权威，移动端 Companion 严格主从 | D1 §2.3（AU3 无分歧） | 已裁决 |
| 拓扑 | 局域网直连优先 + 云中继兜底 + P2P 远期增强（M3 细化为可执行 L3） | D1 §3.3 / M3 §1.1 | 已裁决 |
| 身份模型 | 用户 × 设备 × 会话三元；配对 = 一次性码 + 密钥交换 + 可撤销 | D1 §4 | 已裁决 |
| 一致性 | 桌面 SoT + 单写者 + sequence 游标追平；无 CRDT | D1 §5 / D6 §5 | 已裁决 |
| 跨端事件基 | AgentEventEnvelope 扁平 JSON 直接复用，零协议发明 | D1 §6.1 / D3 §7 / AU2 审计点 1 | 已裁决 |
| 事件扇出 | FanOutEmitter 实现 Emitter trait，挂 EventBridge 构造点（D2 形态） | D2 §11-A / AU2 F-6 | 已裁决 |
| 命令复用 | REST/WS handler 直调既有 *_impl 契约体，不建第二套运行语义 | D2 §11-B / AU2 审计点 3 | 已裁决 |
| 审批复用 | 远程审批 = 给 resolve 加鉴权过的服务入口；I-02 防伪造不变 | D5 §4.3 / AU2 审计点 4 | 已裁决 |
| 游标续传 | (session_id, sequence) 开区间分页复用 query_events / EventPage | D3 §7.5 / D6 §2.2 / AU2 审计点 5 | 已裁决 |
| 移动端技术栈 | Expo SDK 57 / RN 0.86 / TS strict / zustand+immer / expo-router / expo-sqlite / expo-secure-store / RN 内建 WS / expo-notifications | D4 §3 / M5 §0.3 | 已裁决 |
| 移动端分层 | 五层单向依赖；领域层 vanilla createStore 零 UI 依赖 | M4 §2 / AU1 P1-7 | 已裁决 |
| 导航 | 5 Tab（首页/会话/审批/文件/设置）+ Stack 深链 | M4 §0.2 / AU1 P1-4 | 已裁决 |
| 鸿蒙路线 | RNOH 0.82 独立 bare RN 工程（不追 Expo）+ 三层共享 + compat wrapper；P1 先 iOS/Android 上线 | M1 §3.3.4 | 已裁决（立项见第 10 章 O5） |
| 推送架构 | 在线 WS 直推优先 + 离线厂商通道兜底；发送器留桌面 push-core 直连厂商 API | D7 §4 / M8 D1 | 已裁决 |
| iOS 推送 | APNs 直连（HTTP/2 + .p8），不依赖 Expo Push Service（国内版） | M8 D3 / §2.2 | 已裁决 |
| 推送注册表 | 账号中心 push_tokens 为云真源；桌面 device registry 为本地配对真源；双真源同步 | M8 D7 / AC §6.3 | 已裁决 |
| 账号中心 | flowbit-auth 复用（需调整非重做）：+push_tokens +relay_credentials +白名单 env 化 +安全强化 | AC §5 / §6 | 已裁决 |
| 中继服务 | 独立新写 Rust（axum + tokio-tungstenite），只转发不解密零队列；verify 走账号中心（缓存 ≤5min） | M2 §1 / AC §6.4 | 已裁决 |
| P2P 技术 | 自研 UDP 打洞（uu 风格）+ 轻量可靠 UDP + AES-256-GCM；WebRTC 为 B 方案 | M3 §1.2 | 已裁决（达标率决策点见第 10 章） |
| 协议包 | packages/protocol-core（从 shared-types 派生）；生成器泛化多注册表分发 | D8 §3.4 / M6 §12 | 已裁决 |
| 版本策略 | 三轨：应用版本（各端独立 semver）/ 协议版本（注册表派生）/ 兼容窗口（minSupported） | D8 §7.3 / D3 §10 | 已裁决 |
| 旧移动端 | apps/crish-mobile 旧原型整体删除（零连带损失），仅保留目录位 M0 重建 | R2A / R2B | 已裁决 |
| 门禁基线 | 快层 + 移动端静态检查；中层 + jest 全量 + 协议对拍；覆盖率对齐严格度（60/75/70/60 关键面） | D8 §5 / §9 | 已裁决 |

### 3.6 A 组：开工前裁决（R0 评审会关闭，AU3 §8.1）

| # | 待裁决项 | 选项 | 建议 | 影响范围 | 状态 |
|---|----------|------|------|----------|------|
| A-1 | 认证与消息面三选一（C-1） | A Bearer / B DeviceEnvelope+HMAC / C WsEnvelope | **B（D3/M6 体系）** | 桌面 server、移动端连接层、中继、推送全部实现 | 已裁决（R0 落 ADR） |
| A-2 | TLS 范围（C-2） | v1 免 TLS / wss+pinning | **wss+pinning 进 R1** | 证书生成、移动端固定、配对载荷、D1 P1 验收 ⑤ | 已裁决（R0 落 ADR） |
| A-3 | 移动端审批时机（C-3） | 一期只通知 / R2 开放决策 | **R2 开放决策**（D1 验收红线） | R2 审批中心范围、R3 推送联动 | 已裁决（R2 排期前确认） |
| A-4 | 统一阶段命名（P-5） | 维持现状 / R0-R5 | **R0-R5 + 对照表** | 全部任务书引用 | 已裁决（本文档即载体） |
| A-5 | 网关端口（P-1） | 8765 / 7821 | **8765** | CSP、联调文档、配对二维码 | 已裁决 |
| A-6 | 配对码参数（P-2） | D2 8 字符 120s / D3 12 字符 10min | **D3（CXN-12 字符 10min）** | 配对 UI、二维码、移动端输入 | 已裁决 |
| A-7 | 事件变体策略（P-3） | 新增变体 / 冻结 / 会话面消息 | **M6 会话面消息（session.updated）** | 41 变体注册表、D2 桥、移动端解析 | 已裁决 |

---

## 4. 协议摘要

> 协议真源：`plans/D3-protocol.md`（框架）+ `plans/M6-protocol-messages.md`（消息级细化）。
> 实施者：R0 阶段以本节 + 两份分方案为唯一契约；一切 wire 形状以注册表
> `crates/conex-types/contracts/device-protocol.json` 与生成产物为准。

### 4.1 配对流程（CXN-12 字符）

**配对码格式**（D3 §4.1；AU1 P0-1 已裁决为唯一真源）：

- 格式 `CXN-XXXX-XXXX-XXXX`（3 组 × 4 字符，大写字母 + 数字，去 0/O/1/I/L 的 base32 子集，示例 `CXN-7K4P-Q2MB-9XRT`）；
- 熵 60 bit（12 有效字符 × 2^5）；人读回显 `CXN-` 前缀，分组 `-` 仅展示用（输入忽略分隔符、大小写不敏感，`normalize_pair_code()` 标准化）；
- QR 内容 `conex-pair://<code>?v=1&s=<desktopId短号>`——扫码与手动输入走同一 `pair.verify` 消息；
- 有效期 10 分钟（PAIR_CODE_TTL_MS=600_000）；单码失败上限 5 次；并发码 ≤3；一次性（成功后立即作废）；桌面只存 `SHA-256(code+salt)` 不存明文。

**配对状态机**（D3 §4.2）：`Idle → WaitingInput → KeyVerify → Establishing → Established`；移动端 `EnterCode → SendingHello → Verifying → Saving → Ready`。

**密钥交换**（D3 §4.4）：**X25519 ECDH + 配对码作共享口令（PAKE 式混合）**：

```
psk    = HKDF-SHA256(ikm="pair"∥C, salt=desktopId∥mobilePub, info="conex-pair-psk-v1", L=32)
ecdh   = X25519(Dpriv, mpub) = X25519(Mpriv, Dpub)
master = HKDF-SHA256(ikm=ecdh∥psk, salt=desktopId∥mobilePub∥"v1", info="conex-pair-master", L=32)
三子钥  = HKDF 一次展开：token_key（消息签名）/ enc_key（中继 AEAD + P2P 链路密钥）/ refresh_key（重连）
```

**配对消息序列**（D3 §4.8）：`pair.hello {code, mobilePub, mobileLongPub, deviceId, deviceName}` → `pair.challenge {challenge, desktopPub, tlsFingerprint, desktopId}` → `pair.verify {challengeSig, devicePubSig}` → `pair.ok {desktopId, ttl}` → `device.ready` → 双向 `hello`。证书指纹（tlsFingerprint）经配对码信道带外传递，移动端 TLS 钉扎只信该指纹。

### 4.2 DeviceEnvelope 帧

所有消息统一外层信封（D3 §5.3，JSON Schema 见 D3 §11.1）：

```json
{
  "v": 1,                    // 协议主版本（协商后固定）
  "kind": "events.push",     // 消息类别（103 种 kind 之一）
  "msgId": "m-01HZ...",      // 发送方唯一（幂等键 + 请求-响应关联键）
  "ts": 1754651200000,
  "from": "mobile",
  "to": "desktop",
  "auth": { "deviceId": "...", "ts": ..., "nonce": "...", "sig": "HMAC-SHA256(token_key, canon(header)∥bodyJson)" },
  "body": { ... }
}
```

关键语义：

- **签名输入规范化** `canon(header)` = `deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v`（防字段重排攻击）；接收端对收到字节做序列化前签名校验；
- **重放防护**：per-device 时间窗 ±5min + 已见 nonce LRU（4096 条/设备）；超窗/重见 → `auth.stale`；
- **重连**：`auth.refresh`（HMAC(refresh_key, desktopId∥ts∥nonce)，一次性）；24h 广播 `auth.rotate` 换 nonce 基数（token_key 不变）；
- 帧上限 1 MiB（MAX_FRAME_BYTES）；事件 push 单事件 ≤64 KiB（超限先摘要化）；命令请求默认 ≤64 KiB；
- `from/to` 为字面量 desktop/mobile，鉴权不依赖它（鉴权靠 sig）。

### 4.3 103 kind 概览（37 命令 / 11 事件 / 流 / 配对 / 认证 / 设备 / 心跳 / 错误）

M6 §1.1 内部账目（AU1 重点 2 确认自洽）：

| 消息族 | 数量 | 说明 |
|--------|------|------|
| `cmd.*` | 37 | 六域 + 设备域命令请求（响应为同名录 result.*）；F1 10 + F2 5 + F4 8 + F5 4 + F6 5 + 设备域 5 |
| `result.*` | 37 | 命令响应（reqMsgId 关联） |
| `events.*` | 11 | subscribe / subscribeAll / subscribe.ok / push / ack / resume / resume.page / resume.done / session.updated / session.removed / session.updatedAll |
| `stream.*` | 4 | open / chunk / resume / close（大载荷分块，块 ≤64 KiB，断点按字节 offset 续传） |
| `pair.*` | 4 | hello / challenge / verify / ok |
| `auth.*` | 3 | hello / hello.ok / refresh（rotate 为可选扩展） |
| `device.*` | 4 | ready / unlink / revoked / audit |
| `heartbeat` / `heartbeat.ok` | 2 | 30s 保活 + 时钟校准 |
| `error` | 1 | 统一错误通知（带 reqMsgId 可关联请求） |
| **合计** | **103** | 事件载荷复用 41 变体（events.push.body.event） |

**命令面三重约束**（M6 §2.3）：移动端白名单 = `core_list_commands` 拉取（95 条真源）∩ surface=engine 过滤 ∩ M6 命令映射表；设备级 allowedCommands 白名单由桌面强制（D3 §8.3）。

**命令分组（AU3 §4.2 A 拆分按域）**：F1 监控 10（C01-C10）/ F2 审批 5（C11-C15）/ F4 文件 8（C16-C23）/ F5 会话 4（C24-C27，另复用 C03/C05）/ F6 设置 5（C28-C32）/ 设备域 5（C33-C37）。

### 4.4 41 事件双面策略

41 变体按"**实时面（events.push）与同步面（events.resume）双面策略**"登记（M6 §5；AU1 重点 2 确认 41/41 同名同序）：

- **跨端策略三类**：透明透传 T=13（含审批、终态、审计）/ 摘要化 R=18（消息正文首 200 字符、thinking 只传 hasThinking、工具输出首 200 字符、审批参数只传键名列表+summary）/ 元组下发 U=10（fail-closed：未登记裁剪规则的事件只下发 {type, sequence, sessionId, schemaVersion} 元组）；
- **同步面 20 类**（M6 §5.0；AU1 P1-2 已裁决）：会话索引 / run 状态 / 审批 / 审计 / 任务终态 / 子代理 / 轮次 / 工具 / 消息开始结束 / 压缩 / 检查点参与同步；message-delta / task-output / 定时器 / 诊断类不同步；
- **背压三级 → 客户端处理策略固化**：Delta 丢弃（以 message-end 全文兜底）/ Soft 尽力（断线窗口内补发）/ Critical 必达（游标续传覆盖）；
- **preview 帧**：实时预览帧（sequence=None）打 `preview: true` 标记，不推进游标；持久化副本到来时**原地覆盖**（同 sequence 幂等，不闪跳）。

**订阅模型**（D3 §7.3）：按会话订阅 `events.subscribe {sessions, lastSequences, ackMode}` + 全局轻订阅 `events.subscribeAll {events: [type 白名单]}`（security-audit、device.*、timer/cron 数据面、session.updated）；订阅上限 32 会话/设备；下行窗口 4096 事件/会话（EVENT_WINDOW）。

### 4.5 游标续传

- **游标定义**：`(session_id, sequence)`——与 events 表复合主键（schema.rs:141-149）与 `core_read_session_events` 的 afterSequence 同一语义（D2 §10.3 / D6 §4.4）；
- **续传实现** = 复用 `core_read_session_events` 的 EventPage 契约（{events, nextAfterSequence, hasMore}，pageSize 默认 200 / 上限 1000）逐页拉取（D3 §7.5 / M6 C03）——跨端不新造分页协议；
- **逐会话游标**（必须，D6 §4.5）：全局 max 作会话级 base 会永久跳过落后会话（restore.rs P1-1 教训）；
- **游标推进规则**（D6 §4.6）：先应用后推进（同事务）、幂等应用（(session_id, sequence) 去重键）、空洞容忍（delta 占号不补拉）、回退禁止（只升不降）、落后超限（默认 5000 事件）→ 快照重建；
- **Delta 类事件不在续传范围**：断线后以 message-end / 任务输出补取命令重建增量态（与桌面"delta 不落库"语义一致）；
- 重连流程：`auth.refresh` → `events.subscribe`（带 lastSequences）→ `events.resume*` 分页 → `resume.done` → 恢复实时推流。

### 4.6 错误码体系

三段命名 `<域>.<子类>`（D3 §6）：pair.*（8 码）/ auth.*（7 码）/ cmd.*（12 码）/ stream.*（3 码）/ file.*（3 码）+ `frame_too_large` / `transport.closed` / `internal`。与 CoreError {kind, detail} 的映射：InvalidInput → cmd.invalid / file.not_granted；NotFound → cmd.not_found；Cancelled → cmd.cancelled；77 码 CrishErrorPayload 只留桌面日志，跨端不透传内部码（防泄漏实现细节）。

### 4.7 版本化三轨

| 版本面 | 标识 | 当前值 | 演进载体 | 兼容规则 |
|--------|------|--------|----------|----------|
| 跨端协议 | DeviceEnvelope.v + hello.protocolVersion | 1 | 33-device-schema-changelog.md | 主版本协商；次版本只加可选字段 |
| 事件信封 | schemaVersion | 1 | 33-event-schema-changelog.md | 缺省=1；minor 加可选字段；major 删改字段 |
| 命令清单 | COMMAND_MANIFEST_CONTRACT_VERSION | "1.0.0" | command_manifest.rs + 前端镜像 | semver：major=破坏性 |

兼容变更仅三类（新增可选字段 / 新增 kind 须能力协商 / 枚举加值）；破坏性变更必须 bump 主版本 + 双版本并存 ≥ 一个发布周期（D3 §10.3）。

### 4.8 帧示例（hello / event / command / error）

**hello（移动端 → 桌面，连接建立第一帧，能力协商）：**

```json
{ "v": 1, "msgId": "m-001", "kind": "auth.hello",
  "from": "mobile", "to": "desktop",
  "auth": { "deviceId": "dev-mobile-0f3a", "ts": 1754651200000, "nonce": "N2Jh...", "sig": "..." },
  "body": { "protocolVersions": [1], "appVersion": "0.1.0", "platform": "android",
            "capabilities": ["approval", "eventView", "fileRead"] } }
```

**event（桌面 → 移动端，payload 与 EventBridge::serialize 产物逐字节一致）：**

```json
{ "v": 1, "msgId": "s-88231", "kind": "events.push",
  "from": "desktop", "to": "mobile",
  "auth": { "deviceId": "dev-mobile-0f3a", "ts": 1754651200000, "nonce": "...", "sig": "..." },
  "body": { "sessionId": "sess-01", "preview": false,
            "event": { "type": "approval-requested", "runId": "run-42", "sequence": 58,
                       "schemaVersion": 1, "sessionId": "sess-01",
                       "timestamp": "2026-08-09T10:00:00.000Z",
                       "request": { "id": "approval-tc-42", "toolCallId": "tc-42",
                                    "toolName": "write_file", "summary": "call write_file",
                                    "cwd": "C:/work", "parameters": { "path": "src/main.rs" } } } } }
```

**command / result（移动端 → 桌面审批裁决；幂等键 = msgId 不变重发）：**

```json
{ "v": 1, "msgId": "m-017", "kind": "cmd.approve",
  "from": "mobile", "to": "desktop",
  "auth": { "deviceId": "dev-mobile-0f3a", "ts": 1754651200000, "nonce": "...", "sig": "..." },
  "body": { "command": "core_approve_tool", "params": { "toolCallId": "tc-42" }, "timeoutMs": 30000 } }

{ "v": 1, "msgId": "m-017", "kind": "result.approve",
  "from": "desktop", "to": "mobile",
  "auth": { "deviceId": "dev-mobile-0f3a", "ts": 1754651200000, "nonce": "...", "sig": "..." },
  "body": { "reqMsgId": "m-017", "ok": true,
            "result": { "ok": true, "toolCallId": "tc-42", "decision": "approved" } } }
```

**error（任意方向，链路级错误）：**

```json
{ "v": 1, "msgId": "s-90001", "kind": "error",
  "from": "desktop", "to": "mobile",
  "auth": { "deviceId": "dev-mobile-0f3a", "ts": 1754651200000, "nonce": "...", "sig": "..." },
  "body": { "code": "auth.device_revoked", "message": "设备已撤销（dev-mobile-0f3a）",
            "retryable": false, "reqMsgId": "m-017" } }
```

### 4.9 41 事件全量表（wire 形态 / 背压 / 跨端策略）

编号 = 事件注册表 id；runId/sequence/schemaVersion 为信封注入；跨端策略继承背压分级（Delta 可丢 / Soft 尽力 / Critical 必达）（D3 §7.2）：

| # | type | 背压 | 跨端策略 |
|---|------|------|----------|
| 1 | agent-start | Critical | 直推 + 会话状态机锚点 |
| 2 | agent-end | Critical | 直推；reason 驱动移动端 run 状态 |
| 3 | turn-start | Critical | 直推 |
| 4 | turn-end | Critical | 直推 |
| 5 | message-start | Critical | 直推（水合投影以 message-end 为准） |
| 6 | message-delta | Delta | 可丢：断线期间不补发（message-end 重建） |
| 7 | message-end | Critical | 必达；续传窗口必须覆盖（终态权威全文） |
| 8 | tool-start | Critical | 直推（卡片创建） |
| 9 | tool-update | Critical | 直推（S1 流式，预留增量参数流） |
| 10 | tool-end | Critical | 直推（卡片收口，终值） |
| 11 | tool-batch-start | Critical | 直推 |
| 12 | tool-batch-end | Critical | 直推 |
| 13 | tool-input-repaired | Critical | 直推 |
| 14 | context-compression-start | Critical | 直推 |
| 15 | context-compression-end | Critical | 直推 |
| 16 | provider-diagnostic | Critical | 直推（移动端仅日志） |
| 17 | runtime-error | Critical | 直推（推送 P0，S10） |
| 18 | runtime-steering | Critical | 直推 |
| 19 | runtime-intervention-required | Critical | 必达；移动端渲染候选动作（推送 P0） |
| 20 | approval-requested | Critical | 必达；移动端审批弹窗输入（推送 P0 最高） |
| 21 | approval-resolved | Critical | 直推（回显决策；expired 时推送，F2 R1 落地后生效） |
| 22 | checkpoint-created | Critical | 直推 |
| 23 | checkpoint-restored | Critical | 直推 |
| 24 | run-terminal | Critical | 必达；run 终态唯一事件（failed→P0 推送 / completed→P1） |
| 25 | cache-stats-updated | Critical | 直推（仅展示） |
| 26 | cache-waste-alert | Critical | 直推（P2 推送，可折叠） |
| 27 | cold-cache-warning | Critical | 直推（仅展示） |
| 28 | security-audit | Critical | 必达；移动端审计/删除接管弹窗（blocked/purged→P0 推送） |
| 29 | subagent-started | Critical | 直推 |
| 30 | subagent-event | Delta/Soft（按 kind） | progress 可丢；message/tool 尽力 |
| 31 | subagent-ended | Critical | 直推（failed→P0 / completed→P1 推送） |
| 32 | task-started | Critical | 必达；移动端任务面板（P2 推送） |
| 33 | task-output | Delta | 可丢；断线后经 getTaskOutput 补取 |
| 34 | task-heartbeat | Delta | 可丢 |
| 35 | task-suspicious | Soft | 尽力投递（推送 P0，D7 S8c 真源） |
| 36 | task-completed | Critical | 必达（P1 推送） |
| 37 | task-failed | Critical | 必达（P0 推送） |
| 38 | task-killed | Critical | 必达（P1 推送，需与 kill 来源联动） |
| 39 | timer-fired | Critical | 必达（P1 推送，带 prompt） |
| 40 | timer-cancelled | Soft | 尽力投递 |
| 41 | cron-fired | Critical | 必达（P1 推送，带 prompt） |

**同步面 20 类**（参与 events.resume 续传）：1/2/3/4/7/8/9/10/14/15/20/21/24/28/29/31/32/36/37/38（M6 §5.0）。

### 4.10 37 命令明细表（kind → Tauri 命令 → manifest 锚点）

| # | 命令 kind | 对应 Tauri 命令 | 域 | 说明 |
|---|-----------|-----------------|-----|------|
| C01 | cmd.getStatus | core_get_status | F1 | 核心状态裁剪子集 |
| C02 | cmd.getRunSnapshot | core_get_run_snapshot | F1 | run 快照 |
| C03 | cmd.readSessionEvents | core_read_session_events | F1 | EventPage 分页（续传同源） |
| C04 | cmd.readRunEvents | core_read_run_events | F1 | run 事件分页 |
| C05 | cmd.listSessions | list_sessions | F1 | 会话列表 |
| C06 | cmd.listBackgroundTasks | workbench_list_background_tasks | F1 | gui 面特批 |
| C07 | cmd.getTaskOutput | workbench_get_background_task_output | F1 | gui 面特批 |
| C08 | cmd.getFlowSnapshot | get_flow_snapshot | F1 | DAG 只读快照 |
| C09 | cmd.listCommands | core_list_commands | F1 | 能力协商真源 |
| C10 | cmd.getSearchIndex | core_search_files | F1 | 仅索引就绪状态（P2-12 已注明） |
| C11 | cmd.approve | core_approve_tool | F2 | decision 仅 approved |
| C12 | cmd.deny | core_deny_tool | F2 | reason 缺省 user denied |
| C13 | cmd.listPendingApprovals | [新增] mobile_list_pending_approvals | F2 | 待审批集合对账 |
| C14 | cmd.approvalHistory | [新增] mobile_approval_sync_state | F2 | 历史水位 |
| C15 | cmd.checkCommand | core_check_command | F2 | 审批前置预览（非安全判定） |
| C16 | cmd.listDir | workbench_list_directory | F4 | gui 面特批只读 |
| C17 | cmd.readFile | workbench_read_file_content | F4 | gui 面特批只读，分块续读 |
| C18 | cmd.writeFile | workbench_write_file_content | F4 | 受控写，编辑模式闸门 |
| C19 | cmd.listWorkspaces | workbench_list_workspaces | F4 | 登记先行，需接线 |
| C20 | cmd.switchWorkspace | workbench_open_workspace | F4 | 登记先行，需接线 |
| C21 | cmd.searchFiles | [新增] mobile_search_files | F4 | 文件名搜索 |
| C22 | cmd.assetUrl | [新增] mobile_asset_url | F4 | 资源代理（O 待裁决） |
| C23 | cmd.fileStat | file_stat 工具代理（薄壳） | F4 | 元信息 |
| C24 | cmd.runTask | core_run_task | F5 | clientMessageId 幂等（P2 默认关） |
| C25 | cmd.runControl | core_run_control | F5 | L0-L3 |
| C26 | cmd.cancelRun | core_cancel_run | F5 | 取消 |
| C27 | cmd.searchSessions | [新增] mobile_search_sessions | F5 | P2 预留（v1 不实现） |
| C28 | cmd.getSettings | config_get | F6 | 脱敏快照 |
| C29 | cmd.setSettings | config_update | F6 | 非敏感字段 |
| C30 | cmd.settingsConfirm | [新增] mobile_settings_confirm | F6 | 桌面确认通道（60s） |
| C31 | cmd.pauseAutomation | [新增] mobile_pause_automation | F6 | 暂停自动化 |
| C32 | cmd.queryPresence | [新增] device_presence_query | 设备 | 桌面在场判定 |
| C33-C37 | 设备域 5 条 | Device Registry / Pairing Service（新增面） | 设备 | 配对/设备管理 |

> 注：C13/C14/C21/C22/C23/C27/C30/C31/C32 + C33-C37 为 [新增] 移动端命令（14 条），按 X-5 登记路径先注册 command_registry! + manifest 再暴露；manifest 条数断言 95 → 99（R1-07 同步）。

### 4.11 错误码全表（D3 §6.2）

| code | 含义 | retryable | 触发方 |
|------|------|-----------|--------|
| pair.invalid_code / pair.expired / pair.used / pair.too_many_attempts / pair.challenge_mismatch / pair.no_challenge / pair.registry_full | 配对握手各失败态 | 否（重生成/冷却 5min） | 桌面 |
| auth.bad_signature / auth.device_revoked / auth.unknown_device / auth.unknown_desktop / auth.expired / auth.stale / auth.rotate_conflict | 认证各失败态 | 部分（expired/stale 可重发） | 桌面/移动端 |
| cmd.invalid / cmd.not_found / cmd.engine_not_ready / cmd.restore_in_progress / cmd.session_busy / cmd.approval_mismatch / cmd.denied / cmd.requires_approval / cmd.unknown / cmd.timeout / cmd.cancelled | 命令面各失败态 | 部分（engine_not_ready/restore/busy/session/timeout 可重试） | 双方 |
| stream.not_subscribed / stream.cursor_invalid / stream.too_many_subscriptions | 流面 | 否 | 桌面 |
| file.not_found / file.not_granted / file.too_large | 文件面 | 否 | 桌面 |
| frame_too_large / transport.closed / internal | 通用 | 部分 | 双方 |

### 4.12 推送场景明细（13 场景，D7 §3.3 浓缩）

| 场景 | 触发事件 | 级别 | 去重键 | 静默时段 |
|------|----------|------|--------|----------|
| S1 审批请求 | approval-requested | P0 最高 | approval-requested:{toolCallId} | 仍发（可静音） |
| S2 审批过期 | approval-resolved(expired) | P0 | approval-resolved:{toolCallId}:expired | 仍发 |
| S3 run 完成 | run-terminal(completed) | P1 | run-terminal:{runId} | 折叠夜间摘要 |
| S4 run 失败 | run-terminal(failed) | P0 | run-terminal:{runId}:failed | 仍发（可静音） |
| S5 run 取消 | run-terminal(cancelled) | P1 | run-terminal:{runId}:cancelled | 折叠 |
| S6 子代理完成 | subagent-ended(completed) | P1 | subagent-ended:{subagentId} | 折叠 |
| S7 子代理失败 | subagent-ended(failed) | P0 | subagent-ended:{subagentId}:failed | 仍发 |
| S8a 任务启动 | task-started | P2 | task-started:{taskId} | 不推 |
| S8b 任务完成 | task-completed | P1 | task-completed:{taskId} | 折叠 |
| S8c 任务疑似卡死 | task-suspicious | P0 | task-suspicious:{taskId} | 仍发 |
| S8d 任务失败 | task-failed | P0 | task-failed:{taskId} | 仍发 |
| S8e 任务被终止 | task-killed | P1 | task-killed:{taskId} | 折叠 |
| S9a 定时器到期 | timer-fired | P1 | timer-fired:{timerId} | 折叠 |
| S9b cron 触发 | cron-fired | P1 | cron-fired:{cronId}:{iteration} | 折叠 |
| S10 运行错误/需介入 | runtime-error / runtime-intervention-required | P0 | runtime-error:{runId} | 仍发 |
| S11 安全拦截 | security-audit(blocked/purged) | P0 | security-audit:{sequence} | 仍发 |
| S12 缓存浪费 | cache-waste-alert | P2 | cache-waste:{runId} | 不推 |

**统计口径**（P0-4 裁决后）：P0 7 类（S1/S2/S4/S7/S8c/S8d/S10/S11 按子集）+ P1 6 类 + P2 2 类 = 13 类推送场景；审批重推阶梯：15min 未获已读 → +15min/+60min/每小时，最多 5 次，expired 到达即停。

### 4.13 心跳与保活参数表（多层层级，P2-6 已统一口径）

| 层 | 间隔 | 判死阈值 | 说明 |
|----|------|----------|------|
| 协议心跳（移动端→桌面） | 30s（heartbeat 消息） | 3× 间隔（90s） | 承载设备活性（device_registry.last_seen 更新）+ 时钟偏移校准（D3 §9.3） |
| 桌面 WS 服务（推送面在线判定） | 服务端 30s ping | 90s 无任何帧关断 | 半开检测（D2 §10.2；D7 §4.5 心跳 10s/30s 判离线为推送面早期草案，统一到协议心跳口径） |
| 中继连接（M2） | 中继 30s ping | 3 次未 pong（90s） | WS 层 ping/pong 由客户端库兜底；TCP keepalive 15s/5 次；单连接寿命上限 24h 强制重连 |
| P2P 链路（M3） | 25s/4 次 | 连续 2 次丢包超阈 | NAT 映射失效检测 + 回落 L2 热备 |
| 推送在线判定（移动端 appState） | 前台/后台切换即上报 | — | appState 枚举统一为 active/background/inactive（P1-9 已裁决） |

**统一口径**：协议心跳 30s 为唯一业务层心跳源（P2-6 裁决）；推送面、中继面、P2P 面各自的保活参数仅在各自链路层生效，不重复发明业务心跳。

---

## 5. 功能摘要

### 5.1 五 Tab 导航

**5 Tab + Stack 深链**（M4 §0.2 裁决；AU1 P1-4 确认）：

```
底部 Tab：首页(dashboard) | 会话(sessions) | 审批(approvals) | 文件(files) | 设置(settings)
Stack push：session/[sessionId]（会话详情，分段控件「消息 / 事件流」）
           run/[runId]（run 详情）→ terminal/[runId]（终端流回放，只读）
            approval/[toolCallId]（审批卡详情，推送深链直达）
路由守卫：AuthGuard 按 pairState 重定向（未配对 → /pair/manual）
```

- 事件流归置：F3 feed 并入会话详情（会话级时间线），run 详情与终端走 Stack（M4 §2.3；AU1 §5.2 确认 M4/M5 一致）；
- 审批中心占 Tab 位并承载角标 + 推送深链——审批是移动端第一功能（M4 §0.2 裁决理由）。

### 5.2 各功能域一句话

| 域 | 文档 | 一句话 |
|----|------|--------|
| 监控与状态面板 | F1 | 移动端第一个落地域，**纯只读**（observe + L0/L1 验证）：连接状态卡 / 核心状态卡 / 活动任务 / run 详情钻取 / 会话列表 / 用量缓存指标 / 后台任务 / 诊断；数据源全部复用桌面既有查询命令（Q1-Q12）与 41 事件，不新增引擎能力；操作按钮一律不渲染（收口到 F2） |
| 审批中心 | F2 | 移动端**最高价值场景**：待办列表（实时 + 与桌面一致）、允许/拒绝（含理由）、可选"记住此命令"（白名单）、审批历史、离线 outbox、120s 超时展示；3 秒决策路径（推送→生物解锁→决策，点按 ≤3 次）；决策语义与桌面完全一致（同一 resolve 入口，先到者胜）；两阶段确认绝不乐观显示 |
| 事件流与终端 | F3 | 只读展示面：实时 feed（消息增量 / 工具调用 / run 状态 / 审批 / 任务 / 缓存指标）+ 终端输出流（只读，S1 流式协议 tool-update 手机端领先桌面端消费）；事件契约零改动，只加消费面与渲染面；ANSI 剥离（SGR/光标/清屏三类，30 行内） |
| 文件与资产 | F4 | 只读目录树 + 文本预览（≤1MB 分块续读）+ 元信息；写操作（编辑/新建）默认关闭、显式开启；删除/重命名/批量写 V1 不开放；搜索 = 文件名搜索（全文搜索 V2）；手机端不直接触碰桌面文件系统（命令桥 + WorkspaceRegistry 沙箱） |
| 会话与消息 | F5 | 会话列表（session.updated 增量刷新 + 对账）、会话详情（消息流只读 + 事件流分段）、消息正文摘要化同步（首 200 字符）、会话搜索纯函数复用；P2 委托执行（runTask 发起）预留 |
| 设置与账户 | F6 | 三域结构（账户与设备 / 连接与通知 / 外观与隐私）；账户非硬门槛（访客模式可直连已配对桌面）；**权限模式/白名单只读镜像**（设置变更一律在桌面端）；配对引导向导（首次使用流程）；通知偏好三级开关 + 静默时段；移除本机（吊销 + 清凭据 + 保留缓存） |

### 5.3 功能 × 阶段矩阵

| 功能域 | R1 | R2 | R3 | R4 |
|--------|----|----|----|----|
| 配对（手动输入） | 桌面配对 UI + 二维码渲染 | 移动端配对流程 | — | — |
| 扫码配对 | — | R2 末评估（expo-camera） | — | — |
| 审批中心（决策） | 桌面网关 approve/deny | **移动端审批全链路 + outbox** | 推送直达审批卡 | 异地 4G 审批 |
| 事件流 / 终端 | 桌面 WS 事件流 | 移动端 feed + 终端只读 | — | — |
| 文件浏览 | — | 只读目录树 + 预览 | — | — |
| 推送通知 | — | 应用内通知（前台） | **厂商通道全矩阵** | 中继代发（演进） |
| run 控制（L2/L3） | — | 移动端停止/取消 | — | — |
| 远程发消息（runTask） | — | — | — | P3 远期（D1 P3） |
| 云中继 / P2P | — | — | — | L2 中继 + L3 打洞 |

### 5.4 各功能域深化要点

**F2 审批流状态机（移动版，参照桌面 approvalFlowMachine 裁剪）**（F2 §8 / D4 §5.4）：

```
absent ──approval_requested──► pending
pending ──user_allow/deny──► submitting
submitting ──send_ok──► resolved（本地移除）
submitting ──send_failed──► queued（入 outbox，标「待发送」）
queued ──connection_restored──► replaying ──send_ok──► resolved
queued ──user_cancel──► cancelled（标记拒绝）
pending ──approval_resolved──► resolved（桌面已处理，本地同步移除）
pending ──approval_timeout──► expired（只读态）
```

关键语义：toolCallId 为唯一幂等键；重复 approval-requested 覆盖；决策已送达后卡片消失；离线决策入 outbox（入队即写库、FIFO 单飞重放、每单超时 10s 最多 5 次、桌面先处理 → approval-resolved 到达置 superseded）。

**F3 事件三分类（41 事件 → 手机端消费形态）**（F3 §2）：

| 分类 | 含义 | 示例 |
|------|------|------|
| S（实时流展示型） | 携带增量内容/状态变化，进 feed 增量渲染 | message-delta、tool-update（S1 流式）、tool-start/end、agent-start/end、turn-* |
| N（通知型） | 有价值但不产生连续画面；前台合并进 feed 高亮、后台触发本地通知 | run-terminal、task-completed/failed、security-audit、approval-requested |
| I（忽略型） | 无 UI 价值或桌面已显式空实现 | tool-batch-*、tool-input-repaired、message-start、provider-diagnostic |

S1 时序契约（tool_events.rs:1-9）：`tool-batch-start → (tool-start → approval-requested → tool-update* → tool-end)* → tool-batch-end`——tool-update 恒位于 tool-start 与 tool-end 之间，卡片生命周期 = created → (streaming)* → finalized。

**F4 文件命令面与边界**（F4 §2/§4）：list_directory（过滤 node_modules/.git/target/dist/build；排序目录优先字母序；每次一层）+ read_file_content（1MB 上限 / 2000 行默认 / truncated 分块续读 / 二进制与编码嗅探）+ write_file_content（默认拒绝覆盖，受控写四闸门：白名单特批 + 编辑模式开关 + L2 验证 + 审计）。**V1 不开放**：删除、重命名、移动、批量写、全文内容搜索（V2 接 grep_search 代理）。

**F6 设置归属矩阵**（F6 §3）：影响引擎行为与安全的 → 仅桌面端修改（权限模式、白名单、密钥、扩展、外观皮肤体系、快捷键、规则编辑）；纯展示与通知渠道 → 手机端管理（通知偏好、静默时段、本机缓存）；跨设备一致才有价值的 → 同步镜像只读（模型状态、用量、状态诊断、权限模式只读展示）。账户非硬门槛：未登录可"访客模式"直连已配对桌面（F6 §1）。

**F5 会话消息摘要化**（F5 §2 / M6 §5）：移动端只同步摘要（首 200 字符 + truncated=true）；thinking 只传 hasThinking；message-end 是终态权威（mergeAssistantTextPiece 语义复用）；断线重连后以 (session_id, sequence) 去重追平，无重复渲染。

### 5.5 移动端屏幕清单（22 屏，M4 §4 整合）

| 层级 | 屏幕 | 路由 | 说明 |
|------|------|------|------|
| 根 | 根布局（SQLiteProvider/SecureStore/AuthGuard） | app/_layout.tsx | 基础设施 + 路由守卫 |
| 配对 | 扫码（P2 评估）/ 手动输入 | /pair/scan、/pair/manual | 手动输入 v1 必做 |
| Tab 1 | 仪表盘 | (tabs)/dashboard | 连接状态 + 活跃 run + 待批概览 + 会话摘要 |
| Tab 2 | 会话列表 | (tabs)/sessions | 会话索引（session.updated 增量） |
| Tab 3 | 审批中心 | (tabs)/approvals | 待办列表 + 角标 |
| Tab 4 | 文件浏览 | (tabs)/files | 目录树 + 预览 |
| Tab 5 | 设置 | (tabs)/settings | 三域结构 |
| Stack | 会话详情 | session/[sessionId] | 分段控件「消息 / 事件流」 |
| Stack | run 详情 | run/[runId] | run 状态 + 时间线 |
| Stack | 终端回放 | terminal/[runId] | 只读输出流 |
| Stack | 审批卡详情 | approval/[toolCallId] | 推送深链直达 |
| 深链 | 推送跳转目标 | crish:// 白名单路由 | 仅应用内路由，二次校验参数 |

配套原子组件约 20 个（Button/Input/Card/Badge/ListRow/Switch/EmptyState/LoadingRow 等，自研不引 gluestack/tamagui，M4 §0.2）+ 图标统一经自研 Icon 组件隔离（lucide-react-native + react-native-svg 配套安装，R2B 教训防漏装）。

### 5.6 功能域 × 命令 × 事件矩阵（F1-F6 与 M6 命令/事件的对应）

| 功能域 | 消费命令（M6） | 消费事件（41 变体） | 推送场景（D7） |
|--------|----------------|---------------------|----------------|
| F1 监控 | C01-C10 | agent-*/turn-*/run-terminal/message-*/tool-*/task-*/cache-*/runtime-* | S3/S4/S5/S8a-d/S12 |
| F2 审批 | C11-C15 | approval-requested/approval-resolved | S1/S2 |
| F3 事件流/终端 | C03/C04/C07 | message-delta/tool-update（S1 流式）/tool-start/end/task-output | 不推（前台 feed） |
| F4 文件 | C16-C23 | （无独立事件，走命令响应） | 不推 |
| F5 会话 | C05/C03/C24-C27 | session.updated/session.removed/agent-*/run-terminal | S3/S4/S5 |
| F6 设置 | C28-C32 | （配置快照走命令） | 不推 |
| 设备域 | C32-C37 | device.* 消息族（L3 信封层） | 不推 |

---

## 6. 安全摘要

> 安全真源：`plans/D5-security.md`（威胁模型 + 分层防护母方案）+ `plans/M7-security-authorization.md`（功能级授权矩阵）。
> 安全红线（D5 §10.3）在 R1 验收前必须全绿，见第 12 章。

### 6.1 防护纵深总览（D5 §0.2 九层）

```
第 1 层  服务开关     multi_device.enabled=false 默认关闭（对齐 dev_mcp.rs 先例）
第 2 层  传输         wss 强制 + 自签 CA pinning（TLS 1.3/1.2，仅 AEAD 套件，ECDHE）
第 3 层  配对         一次性码（CXN-12 60bit）+ 限 5 次 + 10 分钟过期 + 锁定
第 4 层  令牌         token_key HMAC 消息签名（非 JWT 明文）+ 撤销即时生效
第 5 层  授权         能力分级 observe/approve/operate（无 admin）+ 远程上限 ask + 红线拒绝
第 6 层  密钥         Provider key 永不出桌面 + config_secret_* 远程 100% Forbidden（双层）
第 7 层  审计         全部远程动作入账（remote-* 七变体）+ 日志恒打码
第 8 层  抗滥用       连接数（每设备 2 / 总量 8 / 队列 16）+ 速率限制 + 失败锁定（指数退避）
第 9 层  隔离         远程白名单注册表（remote_manifest）独立于 Tauri IPC
```

### 6.2 L0-L3 验证分层（M7 §3）

| 等级 | 名称 | 验证要求 | 典型操作 |
|------|------|----------|----------|
| L0 | 普通 | 直接执行 | 只读观察类（连接状态、核心状态、待批计数） |
| L1 | 敏感 | 应用锁解锁一次（会话内有效） | run 详情、会话列表、审计明细、敏感文件读取 |
| L2 | 危险 | 生物识别 + 滑动二次确认（≥70%）+ 冷却 5s | 审批允许（危险度 2）、文件覆盖写、发起 run、设置变更、撤销配对 |
| L3 | 极危 | 生物识别 + 双端在场确认（双轨）+ 冷却 30s | 双轨危险审批（配置开启时）、删除类、全部设备重置 |

- **能力等价 + 验证分级**（M7 §0.1）：移动端与桌面端"同权"的语义 = 能力面相同（六条等价原则 E1-E6：命令面/权限判定/审批裁决/白名单/文件面/状态面），差异只在验证路径——验证分层是**引擎上层的门**，引擎判定链零改动；
- 移动端本地门（防误触）+ 远程网关门（verification_token 有效性，安全真值）双层校验；验证证据随命令提交并落审计（verification: "biometric+slide"）；
- 危险度 1 允许的默认授权 = verify（L1），危险度 2 = confirm（L2，可升级 L3）（AU1 P2-9 已裁决）。

### 6.3 授权矩阵要点（M7 §2）

- **矩阵结构**：功能 × 操作 × 能力级 × 默认授权 × 危险度 × 双因素 × 可配置 七列；矩阵封闭（矩阵外命令 = Forbidden + remote-source-attempt 审计）；
- **监控域（F1）**：observe + L0/L1 两级，操作面零开放（domain_readonly）；
- **审批域（F2）**：approve 能力级，待办列表 L1 可读、裁决 L2/L3；
- **写操作默认关闭逐项开启**（M-06）：文件写（F4 编辑模式开关）、设置变更（F6 桌面确认通道 60s 超时 + nonce 防重放）；
- **远程不存在 full-access**：apply_remote_mode = min(requested, Ask)，降级记 remote-mode-downgrade 审计（TH-12 直接缓解）；
- 红线命令（decide_with_redline）远程一律 Deny，无审批路径、不可豁免。

### 6.4 令牌分治（四类）

见 2.3 节表格（配对令牌 / 账号 token / 中继凭据 / 推送注册）。要点：**账号 token 不需要两端一致**（M7 M-05，各自登录各自持有会话，令牌共享反而扩大泄露面）；凭据存储：桌面 OS 凭据库（DPAPI/Keychain），移动端 Keychain/Keystore（kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly），无系统密钥库时**拒绝明文存储宁可每次配对**（D5 §5.2）。

### 6.5 审计

- **复用 security-audit + operation 扩展（最小面）**（D5 §8.5 推荐方案）：不新增 AgentEvent 变体，SecurityAuditOperation 新增七变体（remote-pair / remote-auth / remote-command / remote-session / remote-device / remote-mode-downgrade / remote-source-attempt）+ remote_device_id 可选字段（serde 缺省向后兼容）；
- **审计铁律**：不可丢（Critical 分支落库）、不可伪造（移动端只可请求动作不可投递事件，device_id 权威注入）、不可抹除（撤销 ≠ 删除记录）；actor = remote:{deviceId}:{seq} 与命令 request_id 对账（TH-20 检测）；
- **打码（M-REDACT）**：令牌只允许 sha256 前缀 12 hex；配对码只允许哈希前缀；Provider key 维持 last4；实现落点 crates/conex-telemetry/src/redact.rs（现状无此模块，新增）；T-06 日志扫描测试零明文命中。

### 6.6 威胁模型摘要（D5 §1.3，20 条 STRIDE）

| 威胁 | STRIDE | 描述 | 主要缓解 |
|------|--------|------|----------|
| TH-01 | Spoofing | 伪造端冒充已配对设备 | M-PAIR / M-TOKEN / M-CERT / M-REG |
| TH-02 | Spoofing | 重放截获的配对码/令牌 | M-PAIR / M-TOKEN / M-RATE / M-SESSION |
| TH-03 | Spoofing | 中间人伪造桌面证书（ARP+伪造 CA） | M-CERT（自签 pinning，系统 CA 不参与） |
| TH-04 | Tampering | 中间人改写/注入 ws 帧 | M-CERT（wss 强制，禁 ws 降级） |
| TH-05 | Tampering | 恶意移动端篡改审批载荷 | M-AUTH / M-GATE / M-AUDIT |
| TH-06 | Tampering | 持机者修改移动端本地令牌/配置 | M-TOKEN（系统密钥库）/ M-AUTH（服务端权威校验） |
| TH-07 | Repudiation | 远程危险操作后无痕 | M-AUDIT（actor=deviceId） |
| TH-08 | Disclosure | 窃听局域网流量 | M-CERT（wss 全帧加密） |
| TH-09 | Disclosure | 日志泄露令牌/配对码明文 | M-REDACT（打码铁律） |
| TH-10 | Disclosure | 移动端读到 Provider API key 明文 | M-KEY / M-REG |
| TH-11 | Elevation | 移动端调 config_secret_reveal 等敏感命令 | M-REG / M-KEY（命令级拒绝，双层） |
| TH-12 | Elevation | 远程指定 full-access 绕过审批 | M-MODE（远程上限 ask） |
| TH-13 | Elevation | 伪造 approval-resolved 事件 | M-GATE（resolve 的 NotFound 校验） |
| TH-14 | DoS | 连接洪水打满连接数 | M-LIMIT（连接/速率限制） |
| TH-15 | DoS | 配对码暴力穷举 | M-PAIR（限 5 次 + 锁定）/ M-RATE |
| TH-16 | DoS | 超长帧/慢速攻击 | M-LIMIT（帧大小/读超时） |
| TH-17 | Elevation | 已撤销设备用旧令牌重连 | M-REVOKE（即时生效 + 强制断开） |
| TH-18 | Elevation | 本地进程读令牌文件/CA 私钥 | M-TOKEN（DPAPI 加密）/ M-KEY（权限位） |
| TH-19 | Spoofing | 二维码携带恶意服务器地址（QR 钓鱼） | M-PAIR（QR 含 CA 指纹，离线信道校验） |
| TH-20 | Repudiation | 移动端静默不响应审批拖到 Expired | M-AUDIT（全落库）/ M-SESSION（心跳可见性） |

**最薄弱环节**（AU1 §1.3 / D5 §1.3）：TH-02 重放——令牌非一次性设计下缓解依赖"会话密钥 8h 短时 + 心跳 + 多端并发告警"三件齐备。另 M7 新增威胁 TH-21~TH-31（移动功能增量：深链劫持、推送载荷敏感字段、outbox 重放、verification_token 伪造等），全部收敛到既有控制面 + M-VERIF/M-BATCH/M-CONFIRM/M-RELAY/M-PUSH 五个新控制措施（M7 §7）。

### 6.7 授权矩阵域摘要（M7 §2 全表要点）

| 功能域 | 能力级 | 默认验证等级 | 双因素 | 备注 |
|--------|--------|--------------|--------|------|
| F1 监控/状态（全部只读） | observe | L0（连接状态/核心状态/待批计数/缓存指标）；L1（run 详情/会话列表/用量/诊断/后台任务） | 否 | 操作命令一律拒绝（domain_readonly） |
| F2 审批待办列表 | approve | L1 | 否 | 系统通知只带摘要 |
| F2 审批裁决（危险度 1 允许） | approve | verify（L1） | 否 | 单点决策 + 300ms 防抖 |
| F2 审批裁决（危险度 2） | approve | confirm（L2，可升级 L3） | 可配 | 滑动 ≥70% + 生物 + 冷却 5s |
| F2 双轨危险审批（配置开启） | approve | dual（L3） | 是 | 移动端 + 桌面端在场确认，任一方拒绝即拒绝 |
| F4 文件浏览/预览 | observe | L1（敏感文件读取升 L2） | 否 | 只读白名单 |
| F4 文件写（编辑模式开启后） | operate | L2 | 可配 | 与 F4 编辑模式开关联动 |
| F5 会话/消息阅读 | observe | L1 | 否 | 摘要化展示 |
| F6 设置只读镜像 | observe | L1 | 否 | 权限模式只读 |
| F6 设置变更（通知偏好等本机项） | operate | L1 | 否 | 本机偏好不经桌面 |
| F6 服务器地址修改 | operate | L2（建议勾选升 L3） | 可配 | M7 O-03 |
| 设备管理/服务开关（admin 面） | admin | — | — | **仅桌面端，移动端不可获取** |

### 6.8 连接与限速参数表（D5 §7）

| 指标 | 上限 | 超额行为 |
|------|------|----------|
| 每设备并发连接 | 2（连接族语义下：同 kind 踢旧、异 kind 族 ≤3，M3 §7.5.4） | 拒绝 + 审计 |
| 总并发连接 | 8 | 拒绝 + 审计 |
| 连接队列 | 16 | 队列满立即拒绝 |
| 握手超时 / 空闲读超时 | 10s | 关闭 + 释放槽位 |
| 握手限速（每源 IP） | 5 次/分钟 | 拒绝 + remote-auth blocked 审计 |
| 令牌认证失败（每设备） | 5 次累计 | 设备标记"需重新配对" |
| 令牌认证失败（每源 IP） | 10 次/分钟 | IP 锁定 15 分钟（指数退避 15/30/60 封顶） |
| 配对尝试（每 pairId / 每源 IP） | 5 次 / 10 次累计 | 会话销毁 / IP 锁定 |
| 命令请求（每连接） | 60 次/分钟 | 限流错误 + remote-command blocked |
| 事件订阅 | 每连接 1 个订阅 | 重复订阅拒绝 |
| 帧大小 | ≤1 MiB | 断连 + 审计 |
| 坏连接计数 | 每设备 10 次/小时 | 暂停该设备 1 小时 |
### 6.9 密钥管理边界（M-KEY，D5 §5）

Provider API keys **永不出桌面**，五层隔离（D5 §5.1）：

1. **数据面隔离**：密钥存桌面 DPAPI 槽（config/credentials.rs:31 CredentialStore + dpapi_protect），provider 请求由桌面 agent-provider 直连远端模型服务；移动端不经过任何 provider 协议面；
2. **命令面隔离**：远程白名单排除 config_secret_* 五命令（remote_manifest）；
3. **命令级拒绝**：config_secret_* 各命令增加来源参数校验（source: CommandSource）——非本地 webview 来源一律 CoreError::Forbidden（第二层纵深）；
4. **展示面隔离**：config_secret_reveal 的 ui_confirm 明文返回仅限本地 UI；
5. **测试断言**：T-09"密钥不出桌面"场景自动化（远程事件流快照扫描 sk- 前缀等密钥形态）。

移动端不落盘的敏感物：令牌、配对码、CA 指纹（指纹可落盘，属非机密但防篡改）；无系统密钥库时**拒绝明文存储宁可每次配对**（D5 §5.2）。桌面侧设备令牌哈希 + 盐落独立 DPAPI 槽（secrets/{deviceId}.devtoken.dpapi），设备注册表 multi-device.json 只存哈希与元数据。

### 6.10 审计完整性与对账（D5 §6.4）

- **不可丢**：远程审计事件走 event_backpressure 的 Critical 分支落库，与既有审计同轨；spawn_audit_persistence 排空机制对远程会话同样生效；
- **不可伪造**：审计事件由桌面端生成，移动端只可请求动作不可投递事件；远程网关把 device_id 作为权威字段注入（移动端自称不可信）；
- **不可抹除**：远程事件与本地事件同库同游标；撤销设备的审计保留（撤销 ≠ 删除记录）；移动端审计面板只读（F15，禁止"一键清空"类入口——R2A 反面教材）；
- **对账**：approval-resolved.request_id（remote:{deviceId}:{seq}）与 remote-command 审计可按序对账，检测"裁决记录缺失"异常（TH-20）；
- **验证证据随审计**：L2/L3 操作的 verification_token 类型（biometric+slide / dual-presence）写入 remote-command 审计记录（M7 M-03：验证分层必须能被审计证明，否则分层只是 UI 装饰）。

### 6.11 安全分期建议（D5 §10.4）

| 阶段 | 范围 | 出口条件 |
|------|------|----------|
| M0（R1 内） | 安全模型落地：§8.6 融合清单 1-14 + §9 自动化测试 | 验收红线 1-7 全绿 |
| M1（R2 内） | 配对 + 令牌 + observe/approve 能力 + 双轨确认 | T-01/T-05/T-07/T-10/T-11/T-14 手工演练通过 |
| M2（R2-R3） | operate 增强：run 发起 + 事件推送范围扩展 | 移动端端到端 run+审批闭环 |
| P2（远期） | 设备公钥双重认证（D5 O-03）、生物识别门禁（O-04）、中继面端到端加密（O-01） | 按主 Agent 排期 |

安全红线 1-7（D5 §10.3）：① enabled=false 时无端口监听（netstat 断言）；② 远程 run 无 full-access（装配断言）；③ 红线命令远程一律 Deny；④ 日志扫描零明文命中；⑤ config_secret_* 远程 100% Forbidden（双层）；⑥ 撤销 ≤1s 断开全部连接；⑦ 全部远程动作有 remote-* 审计且打码。

---

## 7. 平台与发布摘要

> 平台真源：`plans/M1-multi-platform.md`（三平台路线）+ `plans/M8-push-release.md`（推送矩阵 + 商店发布）。

### 7.1 iOS / Android / 鸿蒙（RNOH）路线

```
iOS ── Expo SDK 57 原生工程（一等公民，无分叉）
        EAS Build → ipa；App Store 中国区；APNs 直连推送
Android ── 同一 Expo SDK 57 工程（与 iOS 同仓同代码）
        EAS Build → AAB/APK；国内五市场（华为/小米/OPPO/vivo/应用宝）；
        厂商推送逐家直连（无 GMS、FCM 不可用）
HarmonyOS ── RNOH（React Native OpenHarmony）独立 bare RN 工程（独立工程）
        RN 版本线锁 0.82（Expo 57 的 0.86 超出 RNOH 支持线，结构不可调）；
        三层共享（协议/状态/UI）+ compat wrapper（expo-* API → 鸿蒙实现）+ 自研 TurboModule；
        Push Kit 自研原生模块桥；HAP 上架华为应用市场 NEXT 专区
```

**分阶段**（M1 §1.2）：P1 先 iOS+Android 上线（HarmonyOS 4.x 存量设备由 Android APK 兼容覆盖）→ P2 鸿蒙 NEXT 原生 MVP（审批+事件流+推送）→ P3 鸿蒙功能完备。鸿蒙立项与否 = 待裁决 O5（第 10 章），RNOH 预研（Gate A/B）R0 起并行启动不浪费。

**工作量相对值**（M1 §10.3）：iOS = 1.0 基准；Android ≈ 1.2；鸿蒙 NEXT（RNOH）≈ 0.6（相对 iOS 增量，共享三层后只写原生壳+适配层）。

### 7.2 推送矩阵

**架构裁决**（M8 D1/D2）：桌面端策略引擎 push-core + 双轨发送（在线 WS 直推优先、离线厂商通道兜底）；**一期发送器留在桌面端直连厂商 API**（凭据只存桌面），中继代发为演进项。

| 平台 | 通道 | 形态 |
|------|------|------|
| iOS（国内版） | **APNs 直连**（HTTP/2 + .p8 AuthKey，token-based JWT 每连接 1h） | 自建发送器；exp.host 仅海外版可选备胎 |
| Android 海外 | FCM（Expo Push Service） | 可选（M2 后） |
| Android 国内 | **逐厂商直连**：华为 HMS（官方 RN 插件）/ 小米 / vivo / OPPO / 荣耀（验证项） | prebuild + 自研 config plugin + Expo Module API 自研原生模块；expo-notifications 只承担本地渲染/前台/点击 |
| HarmonyOS NEXT | 华为推送服务 Push Kit | RNOH 自研原生模块桥接 |

**场景分级**（D7 §3）：13 个推送场景（P0 必达 6 类：审批请求/审批过期/run 失败/子代理失败/任务失败/安全拦截 + runtime-error/intervention + task-suspicious；P1 重要 4 类；P2 可折叠 3 类；其余 28 类不推）；推送载荷 ≤4 KiB（厂商限制）；静默时段默认 22:30-07:30（P0 仍发、P1 折叠夜间摘要）；审批重推阶梯（15min 未获已读 → +15min/+60min/每小时，最多 5 次，expired 到达即停）。

**注册表**：账号中心 push_tokens（云真源）与桌面 device registry（本地配对真源）双真源同步；桌面关机 = 推送断源是架构属性（一期接受，中继代发 M3 解决），配套桌面常驻（P-6）与诚实呈现。

### 7.3 商店与备案

| 渠道 | 形态 | 硬前置 |
|------|------|--------|
| App Store 中国区 | ipa | ICP 备案 + Apple Developer（$99/年）+ 隐私政策 + App Privacy 声明 |
| 华为应用市场 | Android APK + HarmonyOS NEXT HAP 双形态 | 备案 + 软著 + 对接检查（集成 HMS Push 才能过审） |
| 小米 / OPPO / vivo / 应用宝 | APK/AAB | 备案 + 软著 + 推送 SDK 对接（小米/OPPO/vivo 对 IM/消息类有推送强制） |
| Google Play | AAB | 海外版可选（M8 O7 倾向否：M1-M2 仅国内） |

- **工信部 APP 备案是全部国内上架硬前置**（2024-04 起未备案不可上架；1-3 周，进 R0 最早关键路径）——与开发者账号申请并行启动；
- 包体预算：国内 AAB ≤80MB、国际 ≤60MB；全渠道同一 keystore（换签 = 老用户无法覆盖更新）；P1 不接第三方加固（收益 < 兼容风险）；
- 版本三轨（D8 §7.3 / M8 D13）：应用版本（各端独立 semver）/ 协议版本（注册表派生单调递增）/ 兼容窗口（minProtocolVersion 握手协商）；EAS 三 profile（development/preview/production）+ TestFlight + 厂商分阶段发布；
- **升级兼容矩阵**（D8 §7.4 / M8 5.4，协议变更时的三端行为）：

| 场景 | 行为 |
|------|------|
| 新桌面 + 旧移动端 | 握手协商 minProtocolVersion；未知 kind 丢弃 + 记日志（不报错）；能力位裁剪 UI |
| 旧桌面（无网关）+ 新移动端 | 无法连接 → 引导文案"请升级桌面端"+ 下载指引（G-8 反向用例） |
| 协议 minor 升级 | 注册表递增 → 生成物更新 → 旧客户端兼容（样例集证明） |
| 协议 major 升级 | bump 主版本 + 双版本并存 ≥ 一个发布周期；移动端提示升级 |
| 事件新增变体（未来） | 只 bump 注册表（registry_drift 锁），协议不变；旧端未知 type 渲染"未知事件"摘要卡不崩溃 |

**发布检查清单**（协议变更时，G-6 落点）：先桌面发布 → 移动端灰度（EAS Update 通道）→ 商店窗口预留 1-3 日审核期 → 全端回归（快/中层全绿）。

### 7.4 平台能力差异矩阵（9 域 × 三平台，M1 §5）

| 能力域 | iOS | Android（国内） | HarmonyOS NEXT | 统一抽象 |
|--------|-----|-----------------|----------------|----------|
| 推送 | APNs（系统级） | 厂商通道（HMS/小米/vivo/OPPO/荣耀） | 华为 Push Kit | PushAdapter（R2A J1 骨架） |
| 后台任务 | 后台 30s 挂起，靠推送 | Doze/厂商省电策略杀进程，推送兜底 | NEXT 后台任务策略 | 推送兜底为唯一依赖（不申请后台特权） |
| 文件 | 系统文件仅沙箱 | 沙箱 | 沙箱 | 不做端侧文件系统，走命令桥 |
| 生物认证 | Face ID（LocalAuthentication） | 指纹/面容（BiometricPrompt） | 生物识别（API 24+） | BiometricAuth 接口（M1 §4.4 六接口之一） |
| 深链 | crish:// + Universal Links | crish:// intent-filter | App Linking/深链 linkTag（onNewWant） | DeepLinkHandler 接口 |
| 权限 | 通知/本地网络权限弹窗 | 通知 13+ 动态权限 + 厂商白名单引导 | 通知权限 | 权限最小化清单（仅通知/网络） |
| 通知渠道 | UNNotificationCategory | Android Channel 四类 | 通知渠道 | 统一 channelId（approval/run/security/general） |
| 安全存储 | Keychain | Keystore + EncryptedSharedPreferences | KeyStore 桥 | SecureStore 接口（compat wrapper） |
| 网络 | RN 内建 WS/fetch | 同左 + 厂商保活差异 | 同左（RNOH 同 API） | ReconnectingWsClient 共享 |

**后台策略铁律**（M1 §5.2）：三平台都不依赖任何"后台长连接特权"；后台一切以推送兜底 + 前台恢复即时重连追平。

### 7.5 商店申请与备案清单（M8 §5-6 / M1 §3.1-3.2）

**公共硬前置（国内全渠道）**：

| 项 | 内容 | 时机 |
|----|------|------|
| 工信部 APP 备案 | 开发者主体备案 + APP 备案号（iOS/Android 可同号） | P-0.1 立即启动（1-3 周） |
| 隐私政策 | 声明推送令牌/设备信息采集用途，App 内可查 | 提交前备齐 |
| 软著 | 多数渠道工具类需软件著作权证书（或受理证明） | 与开发并行申请 |
| 权限清单 | 仅通知/网络；与代码一致（自动化隐私检测各渠道会跑） | 提交前核对 |

**分渠道材料**（M8 §5.1-5.3）：App Store 中国区 = Apple Developer（$99/年 + D-U-N-S）+ App Privacy 声明 + 截图元数据（6.7"/6.5" 两套）+ TestFlight 内测；华为 = 开发者联盟 + Push Kit 开通 + agconnect-services.json + 对接检查；小米/OPPO/vivo = 各自开放平台 + 推送 SDK 对接检查（IM/消息类强制）+ 签名一致（全渠道同一 keystore）。

**审核风险面**（M8 D12）：App Review 对远程控制类重点审查（用途声明、权限最小化、不做保活、隐私清单）；国内商店对设备状态/通知权限声明要求。**推送开通与上架解耦**（B6 缓解）：尽早申请推送服务，避免上架等待推送审核。

---

## 8. 统一实施路线

> 阶段真源：AU3 §2.3（R0-R5 总纲，已裁决替换全部 P/M/L/R 前缀）+ D8 第 11 章（工程五阶段并入）。
> 里程碑判定铁律（D1 §8.5 / AU3 §9.3）：每阶段验收全绿才进入下一阶段；任一阶段发现
> "单写者假设被破坏"即回退评审；R0 未完成前任何端不得开始设备域协议相关实现（mock daemon 除外）。

### 8.1 阶段总表

| 统一阶段 | 名称 | 内容摘要 | 对应既有阶段 | 验收锚点 |
|----------|------|----------|--------------|----------|
| **R0** | 协议冻结 | 设备域类型落 conex-types + device-protocol.json 注册表 + 生成器泛化 + TS↔Rust 对拍闭环 + 协议三选一裁决（C-1/C-2/C-3 在此关闭） | D8 阶段 0-1、D3 §12、M6 §12 | T-D3-01~10、T-M6-01~14、对拍门禁绿 |
| **R1** | 桌面服务端 | D2 全量（FanOutEmitter → 网关 → 配对 → WS 续传 → 配对模式）+ 桌面配对 UI + 设备管理 | D1 P0+P1（桌面侧）、D2 P1-P5、D5 M0 | D2 L4 清单 1-9、D5 红线 1-7、D1 P1 验收 1/3/4 |
| **R2** | 移动端基础 | crish-mobile 重建 + 连接层 + 审批中心 + 观测面 | D4 M0-M4、M4 M0-M4、F1 M2、F2 全量、F5 P1 | D4 §11.1 M0-M4 出口 + F2 验收 1-7 |
| **R3** | 推送 | 在线 WS 直推 + APNs/HMS 离线 + 厂商全矩阵 + 商店首发 | D7 M0-M2、M8 M1-M2、D4 M5-M6、AC M0-M5、F1 M3 | M8 §8.1-8.2 验收、D7 §12 验收 |
| **R4** | 中继 + P2P | 账号中心 relay_credentials + Rust 中继 + L2/L3 链路 | D1 P2、M2 R1-R6、M3 L1-L3、AC M6 集成、M8 M3（中继部分） | D1 P2 验收 1-5、M2 §11.5 验收 1-6、M3 §11.5 |
| **R5** | 鸿蒙 | RNOH 工程 MVP + Push Kit + NEXT 上架（O5 裁决立项后） | M1 P2、M8 M3（鸿蒙部分） | M1 §9.3 Gate B、M8 §8.3 验收 |
| （远期） | 多端扩展 | Web 面板 / CLI / 第二桌面 / 多 Hub | D1 P3、D1 P4+ | D1 P3 验收 1-5 |

### 8.2 R0 协议冻结

- **目标**：全链唯一"一切之前"的前置——协议不冻结，R1 网关路由表、R2 连接层、M2 中继契约、M8 push schema 全部悬空（AU3 §3.4：R0 是单点瓶颈，须专职 1-2 人，排期占比 8-10%，不允许被并行任务稀释）；
- **交付物**：
  - T0.1 `.gitignore` 白名单修正（D8 §10.5——不修则 app.json/注册表不入库，阶段 0 假绿，**进 R0 验收首条**）；
  - T0.2 `crates/conex-types/src/device/` 模块族 + `contracts/device-protocol.json`（D3 §12.2 / M6 §12.2，不新建 crate）；
  - T0.3 生成器泛化（generate-engine-bindings.mjs 多注册表分发 → generated/device/{messages,types,parser,index,errors,capabilities}.ts；AU2 审计点 8）；
  - T0.4 TS↔Rust 对拍闭环（样例集 + protocol-parity job）+ registry_drift 扩展（device 域护栏）；
  - T0.5 协议三选一裁决落 ADR（C-1/C-2/C-3 + A-1~A-7 全部在 R0 评审会关闭，AU3 §8.4）；
  - T0.6 mock daemon v0（按 device-protocol.json 生成的夹具服务器，G-3——R2 前端开发不空转的关键）；
- **验收**：C-1~7 裁决落 ADR；对拍门禁绿；mock daemon v0 可连；`git check-ignore -v` 逐文件验证入库；R0 出口 = "内部"阶段（无用户可见物，D1 P0 验收并入本阶段：事件信封与 core_event_bridge.rs serialize 逐字节一致、远程 approve 恢复 run、关网关 GUI 事件照常）；
- **依赖**：无（并行 P-0 组见 8.8）；
- **对应分方案**：D3 §4-5/§12、M6 §12-13、D8 阶段 0-1。

### 8.3 R1 桌面服务端

- **目标**：移动端/任意 WS 客户端在同一 Wi-Fi 扫码配对成功后：看到桌面状态、收到事件流、远程批一个审批 → 桌面 run 恢复执行；拔网线重连后事件从断点续传；
- **交付物**（D2 全量 P1-P5 按 R0 产物重排）：
  - FanOutEmitter（替换构造点，F-6 已裁决）+ WsBroadcast（订阅过滤 + 丢帧分级）；
  - 服务骨架：server 模块 + axum（ws/json/http1/tokio 最小 feature）+ loopback 8765 恒监听 + /v1/info + 令牌存储（auth/pair 纯状态机）；
  - REST T1 全量（状态/会话/run 闭环/审批/配置只读/任务查询/工作流触发查询）+ WS 订阅/广播/心跳；
  - WS 续传（replay/catchup/resume 游标/断线重连）+ 踢出 + 连接管理上限 + 配对 GUI 命令四件套；
  - 配对模式（0.0.0.0 重绑 + 二维码 + 防火墙提示 + 撤销全链）+ TLS/自签证书/指纹固定（C-2 已裁决进 R1）；
  - 桌面配对 UI + 设备管理（列表/改名/撤销）；
  - 落地缺口补强：G-1 睡眠唤醒恢复、G-2 单实例锁、G-4 防火墙/AP 隔离引导、G-9 审批超时权威复核；
- **验收**：D2 §13.1 L4 清单 1-9 + D5 §10.3 红线 1-7 全绿 + **Windows 真实局域网（非虚拟网卡）真机联调**（AU3 §6.4 缺口 2 追加：家用路由器扫码配对 + 审批闭环 + AP 隔离手动输 IP 路径）+ D1 P1 验收 1/3/4；
- **依赖**：R0；
- **对应分方案**：D2 全篇、D5 §8-10、D1 §8.2 P0-P1。

### 8.4 R2 移动端基础

- **目标**：手机安装 App：审批卡秒级到达（前台 <2s）、断网也能本地决策（outbox）、重连自动送达；会话/事件流/run 状态只读可见；
- **交付物**：
  - crish-mobile 重建（D4 M0：SDK 57 工程 + monorepo 接入 + jest-expo + CI job + 路由骨架）——**注意 .gitignore 白名单已在 R0 修正**；
  - 连接层（M1 连接配对：ReconnectingWsClient + 配对流程 + 令牌生命周期 + 相位投影 + 重连/追平）；
  - 审批中心（M2：审批卡 UI + 状态机 + 决策发送 + outbox + 应用内通知）——**移动端远程审批 = 本阶段核心价值**（C-3 已裁决）；
  - 观测面（M3：仪表盘 + 事件流 + 终端只读 + run 控制 L2/L3）；
  - 文件与设置（M4：文件浏览 + 设置 + 移除本机 + 通知偏好）；
  - M6 37 命令双端实现（按第 9 章 6 批拆分，与功能域对齐）；
  - 桌面 mock daemon 驱动开发（T0.6），R1 完成后真机集中联调 1-2 周；
- **验收**：D4 §11.1 M0-M4 出口 + F2 验收 1-7 + 离线 outbox 送达 P95 达标 + 100 条/秒不掉帧 + 目录树 1 万项 + 双端同会话并发用例（AU3 §6.4 缺口 5 追加：桌面与手机同时发消息 → 后者收到明确错误提示）；
- **依赖**：R0 + mock daemon（真机联调依赖 R1）；与 R1 **并行开发**（mock 驱动面约占 60% 工作量，AU3 §3.3）；
- **对应分方案**：D4 全篇、M4、M5、F1-F6、D6 §6-8（outbox/对账）、D8 阶段 2。

### 8.5 R3 推送

- **目标**：手机息屏/杀进程后：审批请求仍 10s 内收到系统通知，点击直达审批卡；桌面关机时 App 明确显示"Hub 离线"；
- **交付物**：
  - push-core 决策引擎（筛选/去重/合并/静默/节流纯函数，D7 §6.1）；
  - WS 直推通道（复用 R1 WS 面 + 在线判定）+ 移动端通知层（权限/深链/双通道去重/Android 通道四类）；
  - APNs 直连发送器 + HMS 直连发送器（vendor trait，M8 §2.2/§2.3）；
  - 厂商全矩阵（小米/vivo/OPPO/荣耀）+ 商店首发（备案号齐备、隐私政策、权限声明）；
  - 桌面常驻（开机自启 + 托盘，P-6/G-5）+ 商店更新 SOP（G-6）+ 旧桌面兼容引导（G-8）；
  - AC M0-M5（账号中心侧：白名单 env 化 → 限流/refresh → push_tokens → relay_credentials → 联动撤销）；
- **验收**：M8 §8.1-8.2（息屏/清杀审批 10s 内到达华为通知中心、iPhone force quit 5s 内 APNs、在线 1s 应用内通知、桌面重启未决审批 15min 重推、静默时段只收夜间摘要、各渠道到达率 ≥90% P0）+ 商店首发成功 + D7 §12；
- **依赖**：R1 事件流 + R2 连接层 + AC M2（push_tokens）；R3 前半程（APNs/HMS 直连）与 AC 并行（AU3 §3.3 建议 3）；
- **对应分方案**：D7 全篇、M8 §0-7、D4 M5-M6、AC §6、D8 阶段 3-4。

### 8.6 R4 中继 + P2P

- **目标**：手机在 4G 异地：审批 <3s 且桌面日志无业务明文；中继挂了局域网照常；P2P 场景（家庭 WiFi）直连带宽 0 过服务器；
- **交付物**：
  - AC M6 集成 + relay_credentials 全链（R-2 nonce 加固，M7 O-08 倾向启用）；
  - Rust 中继服务（M2 R1-R6：骨架 → 认证 → 转发 → 控制面 → 联调 → 运维；env 配置 22 项 + Dockerfile + /metrics + 告警）；
  - L2 RelayLink 双端（M3 §5）+ 桌面 RelayLink 出站；
  - L3-a 信令/探测 → L3-b 可靠 UDP → L3-c 打洞 + LinkManager 三链路收口（M3 §6）；
  - 中继/账号中心监控与容量水位（G-7）；
- **验收**：D1 P2 验收 1-5（4G 异地审批 <3s、双链路回退、端到端加密验证、8 端 p95<1s、Hub 离线呈现）+ M2 §11.5 验收 1-6 + M3 §11.5（NAT 矩阵 12 场景、打洞成功率 ≥70% 家庭 / ≥50% 4G/5G、全量回归）；
- **依赖**：AC M3（relay_credentials）+ R1 桌面 RelayLink 面；L3 依赖 L2 信令；
- **对应分方案**：M2 全篇、M3 全篇、AC §6.4/§6.10、D1 §8.2 P2。

### 8.7 R5 鸿蒙

- **目标**：鸿蒙 NEXT 手机完成配对 + 审批 + 事件流 + 推送全链路（功能子集）；
- **交付物**：RNOH 工程 MVP（审批/事件流/推送/配对，M1 §10.3）+ Push Kit 自研原生模块 + NEXT 上架（华为市场 NEXT 专区）；
- **验收**：M1 §9.3 Gate B + M8 §8.3（NEXT 真机全链路、审批+推送闭环、NEXT 专区上架、桌面关机后 P0 事件 ≤60s 代发——代发部分以中继落地为前提）；
- **依赖**：R0 共享层冻结 + 预研报告（Gate A/B）+ **O5 立项裁决**；与 R3/R4 部分并行；
- **对应分方案**：M1 全篇、M8 §2.4/§5.3。

### 8.8 前置并行组（P-0，不等任何裁决立即启动）

| 包 | 内容 | 外部等待 | 出处 |
|----|------|----------|------|
| P-0.1 | 工信部 APP 备案提交 | 1-3 周（进最早关键路径） | M8 §6.1.3、AU3 W1 |
| P-0.2 | 开发者账号申请（Apple/华为/各厂商） | 1-5 个工作日 | M8 §8.4 |
| P-0.3 | AC 账号中心 M0（白名单 env 化 + CORS 收敛） | 1 人日，低风险高价值 | AC §8 |
| P-0.4 | 鸿蒙 RNOH 技术预研（5 桥冒烟 + Gate A/B 输入） | 2-4 人周，无论是否立项都不浪费 | M1 §10.3 |

### 8.9 排期主视图（2 人并行假设，AU3 §9.1）

| 周次 | R0 | R1 | R2 | R3 | R4 | R5 | 外部并行 |
|------|----|----|----|----|----|----|----------|
| W1-2 | 协议冻结（C-1~7 裁决 + device 类型 + 生成器 + 对拍） | | | | | | 备案、账号申请、鸿蒙预研启动 |
| W3-5 | 对拍收口 + mock daemon v0 | 网关骨架（FanOutEmitter+监听+信封） | 移动端骨架 + 连接层 | | | | 鸿蒙预研（5 桥冒烟） |
| W6-9 | | 网关 T1 全量 + WS 续传 + 配对 | 审批中心 + outbox | | | | AC M0-M2 |
| W10-12 | | 配对模式 UI + 设备管理 | 观测面 + 文件/设置 | | | | AC M3 |
| W13-14 | | **R1 验收**（L4 清单 + 真实局域网） | **R2 验收**（真机审批闭环） | | | | |
| W15-18 | | | | push-core + WS 直推 + APNs/HMS | | | AC M4-M5；真机矩阵 |
| W19-22 | | | | 通知层 + 厂商矩阵 + 首发 | | | TestFlight/华为市场 |
| W23-26 | | | | **R3 验收** | 中继服务 + L2 | | AC M6 |
| W27-31 | | | | | L3-a/b/c + LinkManager | | 中继部署 + 域名/证书 |
| W32-33 | | | | | **R4 验收**（NAT 矩阵） | | |
| W34-40 | | | | | | RNOH MVP + Push Kit + NEXT 上架 | |
| W41+ | | | | | | **R5 验收**（Gate B） | |

**工作量总盘**：全链单人约 54-73 人周（12-18 个月），2 人并行 6-9 个月；真正的时间瓶颈是 R0（单点）与外部等待（备案/账号/审核/鸿蒙设备），不是任何开发包（AU3 §4.3）。

### 8.10 每阶段"能用了"的演示定义（用户视角，AU3 §6.3）

| 统一阶段 | "能用了" = |
|----------|-------------|
| R0 | （内部）CI 对拍门禁绿 + 生成物入库；无用户可见物 |
| R1 | 手机/任意 WS 客户端在同一 Wi-Fi 扫码配对成功后：看到桌面状态、收到事件流、远程批一个审批 → 桌面 run 恢复执行；拔网线重连后事件从断点续传 |
| R2 | 手机安装 App：审批卡秒级到达（前台 <2s）、断网也能本地决策（outbox）、重连自动送达；会话/事件流/run 状态只读可见 |
| R3 | 手机息屏/杀进程后：审批请求仍 10s 内收到系统通知，点击直达审批卡；桌面关机时 App 明确显示"Hub 离线"（诚实呈现） |
| R4 | 手机在 4G 异地：审批 <3s 且桌面日志无业务明文；中继挂了局域网照常；P2P 场景（家庭 WiFi）直连带宽 0 过服务器 |
| R5 | 鸿蒙 NEXT 手机：完成配对 + 审批 + 事件流 + 推送全链路（功能子集） |

### 8.11 里程碑闸门（每阶段出口判定，AU3 §9.2）

```
R0 出口：C-1~7 裁决落 ADR；对拍门禁绿；mock daemon v0 可连
R1 出口：D2 L4 清单 1-9 全过 + D5 红线 1-7 全绿 + Windows 真实局域网真机联调过
R2 出口：D4 M0-M4 出口标准 + F2 验收 1-7 + 离线 outbox 送达 P95 达标
R3 出口：M8 M1/M2 验收全绿 + 商店首发成功（备案号齐备）
R4 出口：D1 P2 验收 1-5 + M2 §11.5 验收 1-6 + M3 NAT 矩阵 + 真机达标率（家庭 ≥70%/4G ≥50%）
R5 出口：M1 Gate B 通过 + NEXT 真机全链路 + 华为市场 NEXT 专区上架
```

**里程碑判定规则**（沿用 D1 §8.5 铁律）：每阶段验收全绿才进入下一阶段；任一阶段发现"单写者假设被破坏"（移动端出现绕过桌面的写路径）即回退评审；R0 未完成前，任何端不得开始设备域协议相关实现（mock daemon 除外——它恰好是 R0 产物的测试载体）；每阶段结束提交纪律：测试与调试脚本立即 git add 入库（AGENTS.md 铁律）。

### 8.12 依赖链拓扑判定（AU3 §3.2，逐条）

| # | 依赖判定 | 结论 | 证据 |
|---|----------|------|------|
| D-1 | 协议类型（device 域）是否先于一切？ | **是**。移动端连接层/桌面网关/中继/推送全部消费 DeviceEnvelope 与 kind 注册表；先写实现后补协议，双端必然漂移 | D3 §12.2、M6 §12.1、D8 §5.3 对拍门禁设计前提 |
| D-2 | 桌面服务端是否先于移动端联调？ | **部分**。移动端 UI/状态机可用 mock daemon 先行，但"真机审批链路"必须等 R1 完成；建议 R1 与 R2 并行开发、R1 完成后集中联调 1-2 周 | D4 §10.2 S1-S4、M4 §10.4 |
| D-3 | 账号中心模块是否先于中继？ | **是**。中继握手 verify 依赖 relay_credentials 端点；但中继 R2（认证）可用 mock verify 先行 | AC §8 M3、M2 §12.1 |
| D-4 | 账号中心是否先于云推送注册？ | **是**。push_tokens 表是云注册表真源；但 M1-M2 期"桌面直连厂商"不依赖账号中心，故 R3 前半程可与 AC 并行 | M8 §0.2 D1/D2、§3.1 |
| D-5 | 中继是否先于 P2P？ | **是**。L3 信令复用中继 WS；中继未落地时 L3-a 只能用测试桩 | M3 §2.3、§12.1 |
| D-6 | 鸿蒙是否最后？ | **是**。共享层（协议/状态/UI）必须先冻结（R0/R2 产物），且 RNOH 预研结论（Gate A/B）决定立项与否 | M1 §9.3、§10.3 |
| D-7 | 推送是否依赖事件流网关？ | **部分**。桌面侧 push-core 筛选依赖事件桥扇出；但厂商通道发送器可与 WS 直推解耦 | D7 §4.2、M8 §3.3 |
| D-8 | 事件信封契约是否先于一切事件面实现？ | **是**（41 变体已冻结，属既有资产）；新增变体需走登记三件套 | D1 §6.1.1、events.rs:789-852 |

**三条并行建议（压缩总工期，AU3 §3.3）**：① R0 与 P-0 组并行（备案/账号/AC M0/鸿蒙预研都是零依赖外部启动项）；② R1 与 R2 并行（mock 驱动面约占 R2 工作量 60%）；③ R3 前半程与 AC M2 并行（APNs/HMS 直连不依赖账号中心）。

**依赖链风险**：R0 是单点瓶颈（专职 1-2 人 + 排期占比 8-10%）；AC 是外部依赖（关键路径按延迟 2 周做缓冲 + mock verify 先行）；T0.1（.gitignore 白名单）若漏修，阶段 0 就是假绿（进 R0 验收首条）。

### 8.13 移动端联调矩阵（D4 §10.2 S1-S4）

| 场景 | 形态 | 验证面 |
|------|------|--------|
| S1 本机联调 | 桌面起网关（8765）→ 手机连同一 Wi-Fi → 手动输入 IP + 配对码 | 配对/审批/事件流/终端流全链路；开发期自签 CA 导入，指纹固定开关 dev 放宽、production 强制 |
| S2 远程联调 | 桌面经 Tailscale 组网（或端口转发）→ 手机填 Tailscale IP | 同 S1 流程；多覆盖网络延迟/丢包面的重连与追平用例 |
| S3 推送联调 | EAS dev client 安装 → 桌面发测试推送（mock 或真网关） | 前台横幅 / 后台系统通知 / 杀进程冷启动深链三种形态 |
| S4 回归联动 | 每次 shared-types 或命令清单变更 | 双端 CI 同步跑契约测试；桌面 commandManifest.test.ts 条数断言 + 移动端镜像断言双保险 |

### 8.14 阶段命名迁移动作（P-5 落地，低成本）

不必重写 25 份文档（AU3 §2.3 迁移动作）：D1 文档头加"阶段对照表"一张 + 各方案文档头加一行"本方案阶段 ↔ 统一阶段映射"，任务书引用一律用统一阶段号：

| 文档 | 其内部阶段 | ↔ 统一阶段 |
|------|-----------|-----------|
| D1 | P0/P1/P2/P3/P4+ | R0（P0 并入）/ R1（P1 桌面侧）/ R2（P1 移动侧）/ R4（P2 中继面）/ 远期（P3） |
| D2 | P0 评审 ~ P5 加固 | R1（P1-P5 全量）+ R3（T2 子集收尾） |
| D4 | M0-M7 | R2（M0-M4）+ R3（M5-M6）+ R4（M7 发布并入 R3 首发） |
| D5 | M0/M1/M2/P2 | R1（M0）+ R2（M1）+ 远期（P2 增强） |
| D7 | M0-M3 | R3（M0-M2）+ R4（M3 中继） |
| D8 | 阶段 0-4 | R0（0-1）+ R2（2）+ R3（3-4） |
| M1 | P1/P2/P3 | R3（P1 双端上线）/ R5（P2 鸿蒙 MVP）/ 远期（P3 追平） |
| M2 | R1-R6（中继里程碑） | R4（R1-R6 全量） |
| M3 | L1/L2/L3 | R4（L1 深化并入 R1 面；L2/L3 在 R4） |
| M8 | M1/M2/M3 | R3（M1-M2）+ R4/R5（M3 按 O5） |
| AC | M0-M6 | P-0（M0）+ R3（M1-M5）+ R4（M6 集成） |
| F1/F5 | 域内 P0/P1/P2 | R2（P0/P1）+ 远期（P2） |

---

## 9. 任务包拆分

> 原则（AU3 §4）：工作量均衡（L=≥15 人日 / M=5-14 人日 / S=<5 人日），无单点独大包；
> 最大单体包内建里程碑闸门；外部等待类（备案/账号/审核）与开发并行不占人力。
> 拆分依据：AU3 §4.2（M6 命令 6 批 / M8 M1 拆 5 包 / M5 8 store 拆 3 波 / D2 P2 拆只读写面 / 鸿蒙 5 步）。

### 9.0 拆分原则与工作量总盘

**拆分前后对比**（防"单包拖慢整体"）：

| 原大包 | 原工作量 | 拆分方式 | 拆分后 |
|--------|----------|----------|--------|
| M6 37 命令实现 | 15-25 人日 | 按 F 系列域拆 6 批（B1-B6，见 R2-07~R2-12） | 批间串行依赖仅 B2/B4（审批校验链），其余可并行 |
| M8 M1 推送+首发 | 32-44 人日 | 拆 5 包（M1-a~e：决策引擎 / WS 直推 / APNs+HMS / 通知层 / 发布准备） | 发布准备 3-5 人日与开发并行 |
| M5 8 store | 并入 D4 | 拆 3 波（auth+connection → approval+event+session → terminal+settings+notification） | 依赖序由"连接层→业务→外围"决定 |
| D2 P2 REST T1 | 22 条命令单体 | 拆只读面（约 14 条）与写面（8 条） | 只读面先行支撑 R2 mock 联调；写面与审批链对齐 |
| M8 M3 鸿蒙+中继 | 47-72 人日 | 依赖 O5 裁决；立项后按"账号→中继→鸿蒙"串行 | 鸿蒙内部再按 5 步（5 桥冒烟→骨架→审批 MVP→Push Kit→追平） |
| D4 移动端工程 | 21 周（最大单体） | 内部已有 M0-M7 里程碑闸门 | 60% 可与 R1 并行 |

**全链工作量总盘**（AU3 §4.3）：R0(10-15) + R1(20-30) + R2(85-105) + R3(61-86) + R4(55-70) + R5(40-60，O5 裁决后) ≈ **270-365 人日 ≈ 54-73 人周**。与"串行叠加口径 41-53 周"互相印证：1 人全力约 12-18 个月，2 人并行 6-9 个月。最大单体包占比 <30%，无失衡。

**依赖拓扑序**（AU3 §3.1）：协议类型落 conex-types 是全局第一前置（R0）→ 桌面服务端（R1）与移动端工程（R2，mock 驱动）并行 → R3 推送（依赖 R1 事件流 + R2 连接层 + AC M2）→ R4 中继+P2P（依赖 AC M3 + R1 RelayLink 面）→ R5 鸿蒙（依赖 R0/R2 共享层冻结 + O5 裁决）。账号中心（AC M0-M5）独立于双端，可全程并行。

### 9.1 P-0 组（外部并行，可立即启动）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| P0-01 | APP 备案 + 隐私政策材料 | S（外部等待为主） | 无 | 运营面 |
| P0-02 | Apple/华为/各厂商开发者账号 + 推送服务开通 | S（外部等待） | 无 | 运营面 |
| P0-03 | AC M0：白名单 env 化（A1/A2/A10）+ CORS 收敛（A7） | S（1 人日） | 无 | account-center zennav-server |
| P0-04 | 鸿蒙 RNOH 技术预研（5 桥冒烟 + 版本线验证 + Gate A/B 报告） | M（2-4 人周） | 无 | docs（预研报告） |

### 9.2 R0 任务包（协议冻结）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| R0-01 | .gitignore 白名单修正 + check-ignore 逐文件验证 | S | 无 | 根 .gitignore |
| R0-02 | conex-types device/ 模块族（envelope/pair/token/events/commands/stream/error/version）+ device-protocol.json 注册表 | L（5-8 人日） | R0-01 | crates/conex-types |
| R0-03 | 生成器泛化（多注册表分发 + device parser + errors/capabilities 输出）+ 幂等验证 | M | R0-02 | scripts/、packages/shared-types |
| R0-04 | 协议三选一裁决落 ADR（C-1/C-2/C-3 + A-1~A-7）+ 文档头阶段映射表 | S | 无 | docs/multi-device |
| R0-05 | TS↔Rust 对拍闭环（样例集 + protocol-parity job）+ registry_drift 扩展（device 护栏） | M | R0-02/R0-03 | tests/、ci-mid.yml |
| R0-06 | mock daemon v0（按 device-protocol.json 生成的 WS 夹具服务器 + 夹具事件集） | M | R0-03 | apps/agent-workbench（测试侧）/ 独立 mock 工程 |
| R0-07 | D1 P0 验收三件套（事件信封逐字节断言 / 远程 approve 恢复 run / 关网关 GUI 照常） | S | R0-05 | 测试面 |

**R0 出口闸**：C-1~7 落 ADR；对拍门禁绿；mock daemon v0 可连；入库完整性验证过。

### 9.3 R1 任务包（桌面服务端，与 R2 并行）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| R1-01 | FanOutEmitter + WsBroadcast（订阅过滤/丢帧分级/连接注册表） | M（3-5 人日） | R0 | core_event_bridge.rs、server/fanout.rs |
| R1-02 | 服务骨架：server 模块（config/auth/pair/backend/router/ws/error）+ axum 依赖登记 + /v1/info + 令牌哈希存储 | M（4-6 人日） | R0、壳 Cargo.toml | apps/agent-workbench/src-tauri/src/server/ |
| R1-03 | REST T1 全量：**只读面先行**（状态/会话/事件分页/run 快照/任务查询，约 14 条） | M（4-6 人日） | R1-02 | server/router.rs、core_backend.rs |
| R1-04 | REST T1 写面（run 发起/控制/取消/审批/配置非敏感更新，8 条）——与审批链对齐 | M（3-5 人日） | R1-03 | 同上 |
| R1-05 | WS 续传（subscribe/replay/catchup/resume/心跳/踢出/连接上限） | M（4-6 人日） | R1-02 | server/ws.rs |
| R1-06 | TLS + 自签证书 + 指纹固定（rustls 装配 + 证书生命周期） | M（3-5 人日） | R1-02 | multi_device/tls.rs |
| R1-07 | 配对模式（0.0.0.0 重绑 + 二维码 + 防火墙提示 + 撤销全链）+ 配对 GUI 命令四件套（manifest 95→99） | M（4-6 人日） | R1-02/R1-05 | server/auth.rs、main.rs、command_manifest.rs |
| R1-08 | 桌面配对 UI + 设备管理页（列表/改名/撤销/轮换） | M（3-5 人日） | R1-07 | apps/crish-desktop |
| R1-09 | 缺口补强：G-1 睡眠唤醒恢复 + G-2 单实例锁 + G-4 防火墙/AP 隔离引导 + G-9 审批超时权威复核 | M（3-5 人日） | R1-03/R1-05 | main.rs、server/mod.rs |
| R1-10 | 安全测试面（pairing/auth/session/limiter/gateway/tls/redact 七模块单测 + T-01~T-14 场景） | L（5-8 人日） | R1-02~R1-07 | 测试面（快层） |
| R1-11 | R1 验收（L4 清单 1-9 + D5 红线 1-7 + Windows 真实局域网真机联调） | M | R1-01~R1-10 | 验收记录 |

### 9.4 R2 任务包（移动端基础）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| R2-01 | crish-mobile 重建（SDK 57 工程 + monorepo 接入 + jest-expo + CI job + 路由骨架 + AuthGuard） | M（2 周） | R0（白名单） | apps/crish-mobile |
| R2-02 | 连接层：ReconnectingWsClient（心跳/退避/相位投影）+ WsGateway（D3 帧编解码 + HMAC signer）+ EndpointResolver | L（3 周） | R0-03（generated/device）、mock daemon | src/network/、src/domain/services/ |
| R2-03 | 配对流程（pairMachine 状态机 + 手动输入 + 令牌生命周期 + 证书固定） | M（2 周） | R2-02 | src/pairing/、src/domain/store/authStore |
| R2-04 | 审批中心（审批卡 + 状态机 + 决策发送 + outbox + 双阶段确认 + 应用内通知） | L（3 周） | R2-02/R2-03 | src/domain/store/approvalStore、data/outbox.ts |
| R2-05 | 观测面（仪表盘 + 事件流 feed + 终端只读 + run 控制 L2/L3 + 会话列表） | L（3 周） | R2-02 | src/domain/store/{event,session,terminal}Store |
| R2-06 | 文件浏览 + 设置 + 移除本机 + 通知偏好（M4 里程碑） | M（2 周） | R2-02 | src/domain/repositories/fileRepository、settingsStore |
| R2-07 | M6 命令批 B1：F1 监控 10 条（getStatus/getRunSnapshot/readSessionEvents/readRunEvents/listSessions/listBackgroundTasks/getTaskOutput/getFlowSnapshot/listCommands/getSearchIndex）双端实现 + T-M6 锚点 | M | R0 | conex-types/device、server、移动端 |
| R2-08 | M6 命令批 B2：F2 审批 5 条（approve/deny/listPendingApprovals/approvalHistory/checkCommand） | M | R2-07（审批门禁校验链） | 同上 |
| R2-09 | M6 命令批 B3：F4 文件 8 条（listDir/readFile/writeFile/listWorkspaces/switchWorkspace/searchFiles/assetUrl/fileStat） | M | R2-07 | 同上 |
| R2-10 | M6 命令批 B4：F5 会话 4 条（runTask/runControl/cancelRun/searchSessions） | M | R2-07+R2-08 | 同上 |
| R2-11 | M6 命令批 B5：F6 设置 5 条（getSettings/setSettings/settingsConfirm/pauseAutomation） | M | R2-07 | 同上 |
| R2-12 | M6 命令批 B6：设备域 + mobile_* 新增（queryPresence/listDevices/renameDevice/revokeDevice/getPairState/unlink + 8 条新增，含 manifest 登记） | L | R2-07 + X-5 登记路径 | 同上 + command_manifest.rs |
| R2-13 | 本地存储 8 表 schema/迁移/DAO + secure-store 4 密钥位 + 缓存清理策略 | M | R2-02 | src/db/ |
| R2-14 | 数据层：8 store 三波落地（auth+connection 第一波 → approval+event+session 第二波 → terminal+settings+notification 第三波） | L（并入各域包） | R2-03~R2-06 | src/domain/store/ |
| R2-15 | 移动端测试面（状态机/outbox/深链/相位投影单测 + 组件测试 + 覆盖率 60/75/70/60 关键面） | L | R2-01~R2-13 | __tests__/ |
| R2-16 | R2 验收（D4 M0-M4 出口 + F2 验收 1-7 + 真机审批闭环 + 双端并发用例） | M | R2-01~R2-15（真机联调依赖 R1） | 验收记录 |

### 9.5 R3 任务包（推送，M8 M1 拆 5 包 + 矩阵）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| R3-01 | push-core 决策引擎（push_intent/去重/合并/静默/节流纯函数 + 13 场景登记） | M（8-10 人日） | R0（事件表）+ R1 事件流 | apps/agent-workbench/src-tauri/src/push/ |
| R3-02 | WS 直推通道（复用 R1 WS 面 + 在线判定 + PushAwareEmitter 挂点） | M（6-8 人日） | R1/R2 | push/、server/ws.rs |
| R3-03 | APNs 直连发送器 + HMS 直连发送器（VendorPushChannel trait + .p8/AGC 凭据 + 重推阶梯） | M（6-8 人日） | R3-01（并行） | push/vendor/ |
| R3-04 | 移动端通知层（权限/Android 通道四类/深链白名单/双通道去重/前台 handler） | M（5-7 人日） | R2 连接层 | apps/crish-mobile/src/notifications/ |
| R3-05 | 发布准备（账号/备案材料/TestFlight/首发 dry-run）——与开发并行 | S（3-5 人日） | P0-01/P0-02 | 运营面 |
| R3-06 | 厂商全矩阵（小米/vivo/OPPO/荣耀 config plugin + 原生模块 + 真机矩阵） | L（29-42 人日） | R3-03 | apps/crish-mobile/plugins/ + 原生模块 |
| R3-07 | 桌面常驻（开机自启 + 托盘 + watchdog.rs 接线）+ 商店更新 SOP + 旧桌面兼容引导 | M | R1 | main.rs |
| R3-08 | AC M1-M5（限流/refresh 检测 → push_tokens → relay_credentials → 设备联动撤销） | L（15-20 人日，账号中心侧） | P0-03 | account-center zennav-server |
| R3-09 | R3 验收（M8 §8.1-8.2 + 商店首发成功 + D7 §12） | M | R3-01~R3-08 | 验收记录 |

### 9.6 R4 任务包（中继 + P2P）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| R4-01 | Rust 中继服务（M2 R1-R6：config/state/auth 缓存熔断/relay 转发/limits/metrics/audit + Dockerfile + env 22 项） | L（10 人日 + 联调） | AC M3（relay_credentials） | crates/relay/ |
| R4-02 | L2 RelayLink 双端（桌面出站 + 移动端出站 + 中继凭据握手 + delivery-offline 语义） | L（15-20 人日） | R4-01 | 双端连接层 |
| R4-03 | L3-a 信令/探测（link.* 业务层消息 + NAT 类型探测 + punch-ticket） | M（2 周） | R4-02 | 双端连接层 |
| R4-04 | L3-b 可靠 UDP（自研轻量可靠传输 + AES-256-GCM + 断点重传） | M（2 周） | R4-03 | 双端 + 移动端 UDP TurboModule |
| R4-05 | L3-c 打洞 + LinkManager 三链路收口（make-before-break + 质量评分 + 滞回 + 连接族语义） | L（3-4 周） | R4-03/R4-04 | 双端 LinkManager |
| R4-06 | 中继/账号中心监控与容量（/metrics 水位 + 告警 + 容量规划文档） | S | R4-01 | 运维面 |
| R4-07 | R4 验收（D1 P2 1-5 + M2 §11.5 1-6 + M3 NAT 矩阵 12 场景 + 真机达标率） | M | R4-01~R4-06 | 验收记录 |

### 9.7 R5 任务包（鸿蒙，O5 裁决后）

| 包 | 内容 | 工作量 | 依赖 | 文件域 |
|----|------|--------|------|--------|
| R5-01 | RNOH 工程骨架（独立 npm 工程 + harmony/ 宿主 + 共享包 dist 引用 + compat wrapper 10 项映射） | L（20-30 人日） | R0/R2 共享层冻结 | apps/crish-mobile-harmony/ |
| R5-02 | 审批链路 MVP（配对 + 审批卡 + 决策发送 + outbox） | M | R5-01 | 同上 |
| R5-03 | Push Kit 自研原生模块 + 推送链路 + 深链 | M | R5-01 | harmony/ 原生模块 |
| R5-04 | 事件流/终端只读 + 功能追平（P3） | M | R5-02 | 同上 |
| R5-05 | NEXT 上架（华为市场 NEXT 专区 + 材料 + Gate B 验收） | M | R5-01~R5-04 | 运营面 |

### 9.8 任务包总表（编号/内容/工作量/依赖/文件域汇总）

| 阶段 | 包数 | S | M | L | 关键链 |
|------|------|---|---|---|--------|
| P-0 | 4 | 3 | 1 | 0 | 备案/账号/AC M0/鸿蒙预研（零依赖并行） |
| R0 | 7 | 3 | 3 | 1 | R0-01 → R0-02 → R0-03 → R0-05/06 |
| R1 | 11 | 0 | 8 | 3 | R1-02 → R1-03 → R1-04/05 → R1-07 → R1-08 |
| R2 | 16 | 0 | 10 | 6 | R2-02 → R2-04（核心链）；R2-07→08→10（命令链） |
| R3 | 9 | 1 | 5 | 3 | R3-01 → R3-02/03 → R3-04 → R3-06 |
| R4 | 7 | 1 | 3 | 3 | R4-01 → R4-02 → R4-03 → R4-04 → R4-05 |
| R5 | 5 | 0 | 3 | 2 | R5-01 → R5-02/03 → R5-05 |
| **合计** | **59** | **8** | **33** | **18** | 无超大包；最大单体 R2-02/R2-04/R2-05（各约 3 周）内部已有 D4 里程碑闸门 |

**人力配置建议**（AU3 §4.3）：R0 专职 1-2 人；R1/R2 期桌面 1 人 + 移动端 1-2 人；R3 期 +1 人（推送/发布）；R4 期桌面侧复用 R1 人力；R5 期按 O5 裁决增配 ArkTS 工程师 1 人。

### 9.9 任务包验收锚点表（每包出口判定）

| 包 | 出口判定（验收锚点） |
|----|----------------------|
| P0-01/P0-02 | 备案受理回执；各平台账号可登录控制台、推送服务开通 |
| P0-03 | AC 白名单 env 化 + CORS 收敛落地；smoke:auth 全绿；chat-website SSO 回归 |
| P0-04 | Gate A/B 预研报告产出（RNOH 版本线验证、5 桥冒烟结果、可行性结论） |
| R0-01 | `git check-ignore -v` 逐文件验证 app.json/eas.json/注册表/生成器全入库 |
| R0-02 | device 模块族编译通过；注册表与 Rust enum 双向护栏测试绿（registry_drift 扩展） |
| R0-03 | 生成器两次运行字节一致；generated/device 五件套输出齐备 |
| R0-04 | C-1~7 裁决全部落 ADR 并在 D1 文档头登记 |
| R0-05 | protocol-parity：故意改注册表不重跑生成器 → 红；重跑 → 绿 |
| R0-06 | mock daemon v0 可连（hello/subscribe/事件推送/命令回执夹具） |
| R0-07 | 事件信封逐字节断言、远程 approve 恢复 run、关网关 GUI 照常三项全过 |
| R1-01 | FanOutEmitter 单测（双发射器收同一 payload；单发射器失败不影响其余） |
| R1-02 | /v1/info 可达；无令牌 401；配对状态机全路径单测绿 |
| R1-03/04 | server_integration 全绿（L2 集成：路由/鉴权/游标/踢出契约类不 ignore） |
| R1-05 | WS 集成测试：重放先实时后、断线续传从 lastSeq+1、Delta 丢帧 message-end 必达 |
| R1-06 | TLS 检查清单 TLS-01~10 逐项过（仅 AEAD 套件、禁 ws 降级、指纹校验） |
| R1-07 | manifest 95→99 同步；配对码/撤销/重放攻击单测绿 |
| R1-08 | 桌面 UI：配对模式开关 → 二维码出现 → 设备列表/撤销操作闭环 |
| R1-09 | 睡眠唤醒重绑端口测试；第二实例提示；公用网络引导文案 |
| R1-10 | 安全测试面 T-01~T-14 场景自动化部分全绿；红线与降级语义进快层 |
| R1-11 | L4 清单 1-9 手测全过 + D5 红线 1-7 + Windows 真实局域网真机联调记录 |
| R2-01 | 真机 dev client 冷启动达标；typecheck/lint/单测绿；CI job 上线 |
| R2-02 | 配对 → 断网 → 重连 → 追平全链路真机通过；相位投影全映射表单测 |
| R2-03 | 配对状态机单测 + 令牌生命周期（刷新/吊销）真机验证 |
| R2-04 | 离线决策送达 P95 达标；重复事件幂等测试绿；双阶段确认 UI 语义测试 |
| R2-05 | 100 条/秒追加不掉帧；L2/L3 run 控制真机验证 |
| R2-06 | 目录树 1 万项级性能达标；移除本机全流程（吊销+清凭据+保留缓存） |
| R2-07~R2-12 | 每批对应 T-M6 锚点绿（白名单三重约束 / 参数校验 / 幂等重发 / outbox 三态） |
| R2-13 | 迁移幂等测试（v0 逐级升最新）；secure-store 密钥位验证 |
| R2-14 | 8 store 三波落地 + selector 契约无拉扯；数据层先落库再推 store 纪律测试 |
| R2-15 | jest 全量 ≥100；覆盖率 60/75/70/60 关键面达标 |
| R2-16 | D4 M0-M4 出口 + F2 验收 1-7 + 双端同会话并发用例全过 |
| R3-01 | push_intent 纯函数 13 场景矩阵单测绿（含 P0-4 裁决后的级别） |
| R3-02 | 在线直推应用内通知 1s 内；双通道去重正确 |
| R3-03 | APNs/HMS 发送器集成测试（mock 厂商网关）；重推阶梯逻辑单测 |
| R3-04 | 三形态（前台/后台/冷启动深链）真机全通过 |
| R3-05 | TestFlight/内部 track 分发可用；首发材料齐备 |
| R3-06 | 华为/小米真机推送送达验证；厂商消息分类/配额验证（M8 7.2） |
| R3-07 | 开机自启 + 托盘常驻真机验证；商店更新 SOP 成文 |
| R3-08 | AC 新增模块按门禁表全绿（注册幂等/跨账号隔离/HMAC 校验/联动撤销/refresh 重用检测） |
| R3-09 | M8 §8.1-8.2 验收 + 商店首发成功 |
| R4-01 | 中继单测 + 双端转发集成 + 压测（8 端 p95<1s 无丢 Critical） |
| R4-02 | 跨网审批 <3s；delivery-offline 语义正确；双链路自动回退 |
| R4-03/04 | NAT 类型探测正确；可靠 UDP 断点重传测试；AEAD 加密验证 |
| R4-05 | NAT 矩阵 12 场景；打洞成功率 ≥70%（家庭）/≥50%（4G/5G）；make-before-break 切换测试 |
| R4-06 | /metrics 水位 + 告警接线；容量规划文档 |
| R4-07 | D1 P2 验收 1-5 + M2 §11.5 1-6 + 全量回归绿 |
| R5-01 | RNOH 工程编译通过；共享包 dist 引用 + 契约漂移检查（git diff --exit-code） |
| R5-02 | NEXT 真机配对 + 审批闭环 |
| R5-03 | Push Kit 送达验证 + 深链直达 |
| R5-04 | 事件流/终端只读真机验证 |
| R5-05 | Gate B 通过 + NEXT 专区上架 |

### 9.10 任务包与分方案章节映射（领包后精读路径）

| 任务包 | 精读分方案章节 |
|--------|----------------|
| P0-01/P0-02 | M8 §6.1（备案）/ §8.4（账号申请清单） |
| P0-03 | AC §6.2（A1/A2/A7/A10） |
| P0-04 | M1 §3.3/§9.3（RNOH 深挖 + Gate A/B）、M8 §2.4 |
| R0-01 | D8 §10.5（.gitignore 白名单） |
| R0-02 | D3 §12.2、M6 §12.1-12.2（device 模块族 + 注册表） |
| R0-03 | D3 §12.4、M6 §12.3、AU2 审计点 8（生成器泛化） |
| R0-05 | D8 §5.3（对拍门禁）、AU3 §3.1 T0.4 |
| R0-06 | D4 §9.2、M4 §10.4（mock daemon） |
| R1-01 | D2 §10.4/§11-A（FanOutEmitter + WsBroadcast） |
| R1-02 | D2 §4-7（服务形态/生命周期/选型/认证配对） |
| R1-03/04 | D2 §8-9（REST 路由 + 92→95 映射表） |
| R1-05 | D2 §10（WS 续传/广播/多连接/踢出） |
| R1-06 | D5 §2（TLS 检查清单 TLS-01~10） |
| R1-07 | D2 §5.4/§7/§11-G（配对模式 + GUI 命令四件套） |
| R1-09 | AU3 §5.3 G-1/G-2/G-4/G-9 |
| R1-10 | D5 §9（T-01~T-14 + 函数级用例清单） |
| R2-02 | D3 §5（DeviceEnvelope + 签名）、M5 §4（网络层） |
| R2-03 | D3 §4（配对全案）、D4 §5.1-5.2 |
| R2-04 | F2 全篇、D6 §6-8（离线/对账/两阶段确认）、D4 §6.5 |
| R2-05 | F1/F3 全篇、D4 §5.3-5.6 |
| R2-07~R2-12 | M6 §4（各域命令细则）、AU3 §4.2 A 拆分 |
| R2-13 | D4 §7（存储）、M5 §5-6 |
| R3-01 | D7 §3/§6（场景 + push-core） |
| R3-03 | M8 §2.2-2.3（APNs/HMS 发送器） |
| R3-06 | M8 §2.3.3（config plugin 设计） |
| R3-08 | AC §6.3-6.5（两模块 + 安全强化） |
| R4-01 | M2 §3-9/§12-13（中继全案） |
| R4-02~R4-05 | M3 §5-7/§10-12（L2/L3/LinkManager/安全/阶段） |
| R5-01 | M1 §4（共享边界与 compat wrapper） |

---

## 10. 待裁决登记

> 口径：AU3 §8 合并去重后共 **52 项待裁决**（8 份文档开放问题 + AU3 新发现 3 冲突 + 7 参数不一致）。
> 其中 7 项为**开工阻塞**（A-1~A-7，已在第 3 章给出建议、R0 协议冻结评审会关闭并落 ADR，不在下表重复登记）；
> 本表登记**其余 45 项（非开工阻塞）**：B 组 12 项（R1/R2 排期内裁决）+ C 组 33 项（可延后）。
> 裁决管理：每项裁决落一条 ADR（对齐 D5 §10.1 格式）并在 D1 文档头登记；B 组不阻塞 R0 开工；
> C 组随对应阶段推进时再裁决，避免过早决策返工（AU3 §8.4）。

### 10.1 B 组：R1/R2 排期内裁决（12 项）

| # | 待裁决项 | 建议 | 触发时机 |
|---|----------|------|----------|
| B-1 | 命令总数口径（92 vs 95） | 95（M6 勘误，已是代码事实） | R1 白名单冻结时 |
| B-2 | 桌面常驻策略（随 app 启停 vs 开机自启+托盘） | 推送启用后必须常驻（watchdog.rs 先例） | R1 生命周期接线时 |
| B-3 | 网关聚合端点（三查询分拉 vs companion_overview） | 首页 >500ms 时补聚合 | R1 路由表定稿时 |
| B-4 | Expo SDK 线（最新稳定 vs 上一 LTS） | 最新稳定（D4 已锁 57）+ 降级通道 | R2 工程创建时 |
| B-5 | 协议包命名（protocol-core / protocol / mobile-protocol） | protocol-core（未来服务端复用） | R0 协议包创建时 |
| B-6 | zod 作协议包运行时依赖（接受 vs 零依赖手写 parser） | 接受（桌面已用） | R0 生成器定稿时 |
| B-7 | 网关协议面归属 | C-1 裁决后由 D3/M6 冻结（已定） | R0 评审会 |
| B-8 | 审批过期事件（桌面补发 expired vs 仅移动端展示） | 桌面补发（F2 §8.3 提案；协议不变） | R1/R2 审批链定稿时 |
| B-9 | 静默时段默认值（22:30-07:30 vs 22:00-08:00） | 保持 22:30-07:30（D7 真源） | R3 推送策略落地时 |
| B-10 | 夜间摘要默认开关 | 默认开（P1 折叠） | R3 推送策略落地时 |
| B-11 | 聚合商 vs 逐厂商（HMS 自建先行 vs 聚合商提速） | HMS 自建先行 | R3 排期（W15 前） |
| B-12 | 移动端 UI 覆盖率豁免收口（阶段 3 vs 阶段 4） | 阶段 3 评估、阶段 4 前定案 | R3 门禁收口时 |

### 10.2 C 组：可延后裁决（33 项）

| 归口 | 待裁决项 | 建议 | 触发时机 |
|------|----------|------|----------|
| D1 O1 | session-index-changed 事件变体 | 随 A-7 采用会话面消息（已定，此项关闭） | R0 |
| D1 O2 | 审批决策帧专用 vs 通用 command | 通用 command（md.approval.decide） | R1 帧面定稿 |
| D1 O3 | 移动端事件渲染复用桌面 handler | 复用 handler 模块化抽共享包 | R2 |
| D1 O4 | 端级缓冲复用 EventBuffer 分桶 | 复用（同构换 key） | R1 扇出实现 |
| D1 O5 | Web 端凭据模型 | 短时效会话 token（远期） | P3 Web 面板启动 |
| D1 O6 | 多 Hub 连接 | P1 不支持，P3+ 设计 | P3 |
| D1 O7 | 中继账号体系 | 只绑定 hubId | R4 中继落地 |
| D1 O8 | 第二桌面升级 Hub | 远期 | P3+ |
| D1 O9 | 网关抽独立 crate（conex-md） | P2 后抽 crate | R3 后 |
| D3 §13.4-1 | 中继公网暴露失败锁定 | 10 次失败锁定 15min | R4 中继安全评审 |
| D3 §13.4-2 | 推送与 WS 常驻关系 | 通知触发重连，不引入第三信道 | R3 |
| D3 §13.4-3 | 多桌面配对 | 已按 desktopId 隔离设计 | 远期 |
| D3 §13.4-4 | events.resume vs cmd.readSessionEvents | 不合并，语义清晰 | R1/R2 |
| D3 §13.4-5 | preview 帧渲染策略 | 直接渲染 + 持久副本原地覆盖 | R2 |
| M6 §14.4-1 | backward 分页接线 | 保留（query_events_backward 新增查询面） | R2 会话首屏 |
| M6 §14.4-2 | 批量审批协议形态 | v1 并发单命令，批处理预留 | 远期 |
| M6 §14.4-3 | 五条 gui 面命令 surface 迁移 | 列排期项 | R3 白名单收口 |
| M6 §14.4-4 | 资源代理 cmd.assetUrl | 需网络域联合评审 | R2 图片预览 |
| M6 §14.4-5 | 推送厂商密钥与 token 注册 | 独立排期 | R3 |
| M6 §14.4-6 | 审批过期事件（引擎增强） | 见 B-8 | R1/R2 |
| M8 O5 | **M3 中继代发立项**（影响 R4/R5 范围） | 用户决定（可选项） | R4 排期前 |
| M8 O6 | 中继审批重推升级 | 中继只发一轮 | R4 中继落地 |
| M8 O7 | Google Play 海外版 | 否（M1-M2 仅国内） | R3 首发前 |
| M8 O8 | 鸿蒙功能对齐要求 | 功能子集先行（审批+通知） | R5 |
| M8 O9 | 营销通知类别 | 全部服务/功能通知 | R3 合规 |
| M7 Q1 | 5 Tab vs 4 Tab | 5 Tab（M4 裁决基准，已定） | R2（已关闭） |
| M7 Q2 | 会话详情双视图默认 | 默认消息 + 记忆上次 | R2 |
| M7 Q3 | 视觉回归自动对比 | 快照先行 P1 评估 | R2 后 |
| M7 Q4 | 组件库自研 vs 引入 | 自研（约 20 原子组件） | R2 |
| M7 Q5 | 审批主按钮颜色 | 语义绿 | R2 设计系统 |
| AC 风险 8 | 推送发送器代理 vs 直连 | 一期桌面直连，二期评估代理 | R3 |
| AC 风险 9 | 账号用户池共享 vs 独立 | 倾向独立用户池 | R3 账号接入 |
| M2 §12.3-1~4 | 在线状态广播 / 短窗缓冲 / UDP 端点时机 / 中继域名 | 查询制；retain 不做；P4；跟随 flowbit 惯例 | R4 |

### 10.3 裁决管理建议与已关闭项核对（AU3 §8.4）

**裁决流程**：

1. **A-1~A-7 在 R0 协议冻结评审会上一并关闭**（其中 A-1/A-2 涉及跨文档架构改动，需用户拍板）——已在第 3.6 节给出建议裁决；
2. 每项裁决落一条 ADR（对齐 D5 §10.1 的 ADR 摘要格式），并在 D1 文档头登记；
3. B 组裁决不阻塞 R0 开工（仅影响 R1/R2 排期细节），按第 10.1 表触发时机裁决；
4. C 组随对应阶段推进时再裁决，避免过早决策导致返工。

**已关闭核对**（随 R0 评审一并确认）：A-4（R0-R5 阶段命名，本总方案即载体）、A-5（8765）、A-6（CXN-12）、A-7（会话面消息）四项建议无跨文档反对，仅需评审会签确认；A-1/A-2 需用户拍板；A-3 需 R2 排期前最终确认。

---

## 11. 文档索引

### 11.1 分方案索引表

| 文档 | 主题 | 实施者何时读 |
|------|------|--------------|
| `docs/multi-device/Z0-master-plan.md` | 总方案（本文件） | 一切工作开始前 |
| `plans/D1-overall-architecture.md` | 总体架构母方案：端模型/拓扑/身份/一致性/融合点/阶段验收 | R0 评审；任何阶段验收标准以 §8.2 为基线 |
| `plans/D2-desktop-serverification.md` | 桌面服务化：server 模块/REST+WS API/令牌/续传/测试 | R1 全程 |
| `plans/D3-protocol.md` | 端间协议：配对/信封/认证/错误码/事件/命令/流/版本化/JSON Schema | R0 全程（协议真源）；R2 移动端连接层 |
| `plans/D4-mobile-tech.md` | 移动端技术：Expo 57 选型/五层架构/屏幕/网络/存储/推送/里程碑 | R2 全程 |
| `plans/D5-security.md` | 安全模型：威胁/传输/配对/令牌/授权/密钥/审计/限速/测试 | R1 安全面；R2 移动端安全契约 |
| `plans/D6-sync-consistency.md` | 同步一致性：两级混合模型/游标/命令/对账/裁剪/一致性级别 | R2 同步面；R1 网关查询面 |
| `plans/D7-push-notifications.md` | 推送通知：13 场景/push-core/厂商矩阵/防打扰/测试 | R3 全程 |
| `plans/D8-engineering-release.md` | 工程整合发布：workspace/协议包/门禁/本地开发/构建发布/落地五阶段 | R0 工程骨架；R2 门禁；R3 发布 |
| `plans/F1-monitor-panels.md` | 监控与状态面板域（只读） | R2 观测面 |
| `plans/F2-approval-center.md` | 审批中心域（决策/离线/冲突/双因素） | R2 审批中心 |
| `plans/F3-event-stream-terminal.md` | 事件流与终端域（S1 流式/tool-update） | R2 观测面 |
| `plans/F4-files-assets.md` | 文件与资产域（只读/受控写） | R2 文件面 |
| `plans/F5-session-messages.md` | 会话与消息域 | R2 会话面 |
| `plans/F6-settings-account.md` | 设置/账户/多设备管理域 | R2 设置面 |
| `plans/M1-multi-platform.md` | 三平台路线：iOS/Android 确认 + 鸿蒙 RNOH 深挖/共享边界/矩阵 | R5 全程；R0 预研输入 |
| `plans/M2-relay-service.md` | 云中继服务：定位/连接模型/凭据/转发/部署/运维 | R4 全程 |
| `plans/M3-network-p2p.md` | 网络分层与 P2P：L1-L3/打洞/LinkManager/带宽量化/测试 | R4 全程；R1 L1 深化 |
| `plans/M4-mobile-ui-architecture.md` | 移动端 UI 架构：七层三域/设计系统/导航/交互规范 | R2 全程（架构权威） |
| `plans/M5-mobile-engineering.md` | 移动端工程细化：8 store/12 表/ReconnectingWsClient/CI | R2 全程（实现蓝本） |
| `plans/M6-protocol-messages.md` | 协议消息细化：37 命令/41 事件双面/103 kind/Schema/落点 | R0 全程（消息级真源）；R2 命令实现 |
| `plans/M7-security-authorization.md` | 授权矩阵：L0-L3 验证分层/功能矩阵/令牌全景/审计整合 | R2 安全面；R1 网关授权 |
| `plans/M8-push-release.md` | 推送发布整合：三平台通道/发送器裁决/商店/备案/工作量 | R3 全程 |
| `plans/AC-account-center-evaluation.md` | 账号中心评估：复用面/两新模块/安全强化/里程碑 | R3 AC 侧；R4 relay_credentials |
| `plans/R2A-legacy-mobile-reuse.md` | 旧移动端去留评估（删除裁定 + 11 条借鉴） | R2 前速读（借鉴条目） |
| `plans/R2B-legacy-mobile-tech.md` | 旧移动端技术审查（依赖/质量/警示 8 条） | R2 前速读（警示清单） |

### 11.2 审计文档索引

| 文档 | 主题 | 何时复核 |
|------|------|----------|
| `audits/AU1-cross-consistency.md` | 交叉一致性：P0 四冲突/P1 十一不一致/P2 十二澄清 | R0 评审会逐项过 |
| `audits/AU2-code-fit.md` | 代码融合度：10 融合点实读核对/F 修正 8 处/G 缺口 10 项 | R0 评审会；实现时对照融合点 |
| `audits/AU3-executability.md` | 可执行性：阶段统一/依赖拓扑/工作量均衡/52 项待裁决/排期 | 调度与排期；每阶段开工前 |

### 11.3 推荐阅读顺序

1. **调度者/评审**：Z0 → AU3 → AU1 → AU2 → D1 → D3 → D5；
2. **桌面端实施**：Z0 §3/§8 → D2 → D3 → D5 → M6（命令面）→ F2（审批）；
3. **移动端实施**：Z0 §3/§8 → D4 → M4 → M5 → F1-F6 → M6（消费面）→ D6（同步）；
4. **推送/发布**：Z0 §7 → D7 → M8 → AC §6 → D8 §7/§11；
5. **鸿蒙**：Z0 §7 → M1 → M8 §2.4 → R2A/R2B（借鉴与警示）。

### 11.4 与仓库既有文档的衔接

| 既有文档 | 衔接关系 |
|----------|----------|
| `docs/rust-rewrite/`（架构重构系列） | 多端互通是重构后的新增能力面；rust-rewrite 的文档仍为引擎架构权威，多端方案不改变引擎内部 |
| `docs/feature-gap-analysis/`（功能缺口系列） | MOBILE-01/02/03 三份审计是旧移动端删除决定的依据存档（R2B §5.3），与 R2A/R2B 结论同向 |
| `docs/multi-device/`（本系列） | 本总方案为单一入口；各分方案文档头建议补一行"本方案阶段 ↔ 统一阶段映射"（P-5 迁移动作） |
| `docs/guides/`、`docs/organization/` | 治理与指南不涉及；多端互通实施遵循既有评审与提交纪律 |
| `reference/markdown-editor/` | 测试资产铁律不触碰（R2A §6 已声明无交集）；引擎门禁 `npm test` 在多端改造后继续全绿 |

### 11.5 阶段映射表（R0-04 追加，2026-08-10）

> 依据：§8.14 阶段迁移动作（P-5/A-4 已裁决）+ §11.1 阅读时机 + 各阶段"对应分方案"行。
> 用法：领任务前查第 9 章任务包，再按本表确认对应分方案的**首读 / 实施时读 / 验收时读**时机；
> 阶段列含义：R0=协议冻结 / R1=桌面服务端 / R2=移动端基础 / R3=推送 / R4=中继+P2P / R5=鸿蒙。

**主表：25 份分方案**

| 文档 | 对应 R 阶段（R0-R5） | 首读 | 实施时读 | 验收时读 |
|------|----------------------|------|----------|----------|
| D1-overall-architecture | R0（P0 并入）/ R1（P1 桌面侧）/ R2（P1 移动侧）/ R4（P2 中继面）/ 远期（P3） | R0 评审（验收基线 §8.2） | 对应阶段开工前（端模型/一致性/验收口径） | 每阶段（D1 §8.2 验收 1-5 按阶段取用） |
| D2-desktop-serverification | R1（P1-P5 全量）+ R3（T2 子集收尾） | R0 评审（服务形态摘要） | R1 全程 | R1（D2 §13.1 L4 清单 1-9） |
| D3-protocol | R0 全程（协议真源）；R1 网关/配对落地；R2 移动端连接层；R4 中继帧面 | R0 首读（配对/信封/认证/版本化） | R0 全程；R1/R2 对应实现；R4 中继帧契约 | R0（T-D3-01~10） |
| D4-mobile-tech | R2（M0-M4）/ R3（M5-M7 推送完备与发布） | R0 评审（技术栈与里程碑） | R2 全程；R3 推送面 | R2（D4 §11.1 M0-M4 出口） |
| D5-security | R1（M0）+ R2（M1）+ 远期（P2 增强） | R0 评审（安全模型与红线） | R1 安全面；R2 移动端安全契约 | R1（红线 1-7）；R2（T-01~T-14） |
| D6-sync-consistency | R1（网关查询面）/ R2（同步面与 outbox） | R0 评审（一致性模型） | R1 查询面；R2 同步/outbox/对账 | R2（两阶段确认、对账用例） |
| D7-push-notifications | R3（M0-M2）+ R4（M3 中继代发演进） | R0 评审（推送架构裁决 P0-4/P1-5） | R3 全程 | R3（D7 §12 验收） |
| D8-engineering-release | R0（阶段 0-1）+ R2（阶段 2）+ R3（阶段 3-4） | R0 工程骨架（白名单/协议包/门禁） | R0 生成器与对拍；R2 移动端门禁；R3 发布 | 每阶段门禁绿（快/中层基线不回归） |
| F1-monitor-panels | R2（P0/P1）+ 远期（P2） | R2 开工前 | R2 观测面（仪表盘/状态卡） | R2（100 条/秒不掉帧） |
| F2-approval-center | R2 全量（ADR-03：审批中心 P0） | R2 开工前 | R2 审批中心全程（决策/outbox/双因素） | R2（F2 验收 1-7 + 离线送达 P95） |
| F3-event-stream-terminal | R2（只读事件流与终端） | R2 开工前 | R2 观测面（feed/终端只读） | R2（S1 流式时序契约） |
| F4-files-assets | R2（只读文件面）；远期 V2 | R2 开工前 | R2 文件面（目录树/预览） | R2（目录树 1 万项） |
| F5-session-messages | R2（P0/P1）+ 远期（P2 委托执行） | R2 开工前 | R2 会话面（列表增量/详情） | R2（摘要化/去重用例） |
| F6-settings-account | R2（设置面）+ R3（通知偏好联动推送） | R2 开工前 | R2 设置面；R3 通知偏好 | R2（移除本机全流程） |
| M1-multi-platform | R3（P1 双端上线）/ R5（P2 鸿蒙 MVP）/ 远期（P3 追平） | R0 预研输入（Gate A/B） | R3 平台面；R5 全程 | R5（M1 §9.3 Gate B） |
| M2-relay-service | R4（R1-R6 全量） | R4 排期前 | R4 全程（中继服务/凭据握手） | R4（M2 §11.5 验收 1-6） |
| M3-network-p2p | R4（L1 深化并入 R1 面；L2/L3 在 R4） | R4 排期前 | R1 L1 深化；R4 全程（L2/L3/LinkManager） | R4（M3 §11.5 NAT 矩阵 12 场景） |
| M4-mobile-ui-architecture | R2 全程（架构权威） | R2 开工前 | R2 UI 架构落地（七层三域/22 屏） | R2（导航与设计系统） |
| M5-mobile-engineering | R2 全程（实现蓝本） | R2 开工前 | R2 工程实现（8 store/12 表/连接层） | R2（迁移幂等/覆盖率关键面） |
| M6-protocol-messages | R0 全程（消息级真源）；R2 命令实现 | R0 首读（103 kind/命令/事件双面） | R0 注册表与 schema；R2 命令批 B1-B6 | R0（T-M6-01~14）；R2 每批锚点 |
| M7-security-authorization | R1（网关授权）+ R2（移动端安全面） | R0 评审（四类令牌/授权矩阵） | R1 网关授权；R2 验证分层落地 | R1/R2（矩阵闭环测试） |
| M8-push-release | R3（M1-M2）+ R4/R5（M3 按 O5） | R0 评审（发送器裁决/备案路径） | R3 全程；R4/R5 中继代发/鸿蒙 | R3（M8 §8.1-8.2）；R5（§8.3） |
| AC-account-center-evaluation | P-0（M0）+ R3（M1-M5）+ R4（M6 集成） | R0 起并行（P-0.3 白名单 env 化） | P-0 AC M0；R3 AC 侧；R4 relay_credentials | R3/R4（AC 门禁表） |
| R2A-legacy-mobile-reuse | R2 前（已裁定删除，借鉴 11 条） | R2 前速读（借鉴条目） | 不实施（删除裁定，参考物在 reference/） | — |
| R2B-legacy-mobile-tech | R2 前（已裁定删除，警示 8 条） | R2 前速读（警示清单） | 不实施（警示纪律对照） | — |

**附注组：总方案 / 审计 / ADR**

| 文档 | 对应 R 阶段 | 首读 | 实施时读 | 验收时读 |
|------|-------------|------|----------|----------|
| Z0-master-plan | R0-R5 全链 | 一切工作开始前 | 每阶段开工前（§8 对应阶段 + §9 任务包） | 每阶段出口（§12 门禁与验收基线） |
| ADR-01-protocol-decisions | R0（协议三选一裁决载体） | R0 首读（与 Z0 §3 并列） | 各阶段实现前核对对应 ADR 条款 | R0 出口（C-1~7 落 ADR 登记） |
| audits/AU1-cross-consistency | R0（P0/P1/P2 冲突清单） | R0 评审会逐项过 | 实现时对照冲突裁决与修改建议 | 每阶段回归对照 |
| audits/AU2-code-fit | R0（融合点/F 修正/G 缺口） | R0 评审会 | 实现时对照 10 融合点与落点 | 每阶段回归对照 |
| audits/AU3-executability | R0（阶段/依赖/工作量/裁决） | 调度与排期 | 每阶段开工前（依赖拓扑/任务包拆分） | 每阶段出口闸 |

---

## 12. 验收门禁

### 12.1 仓库现有门禁基线（不可破坏）

| 层 | 现有门禁 | 强度 |
|----|----------|------|
| 快层（ci.yml，每次提交/PR ≤15min） | typecheck（7 段 tsc）/ lint / vitest-fast（覆盖率 45/70/65/45 强制）/ audit / engine-bindings-drift / cargo-deny / secret-scan / rust-check / rust-unit-fast | 提交即跑 |
| 中层（ci-mid.yml，合并前 ≤20min） | rust-test（`cargo test --workspace --locked`，73 套件基线）/ clippy / vitest 全量 / F3 四目录集成 / machete / e2e 冒烟（5 个保护名单 spec）/ knip / governance-baselines | 合并前全量 |
| 慢层（ci-slow.yml，nightly） | 压力 / 全量 e2e / 基准 | 每日 |

**铁律**（AGENTS.md）：多端改造不得使既有门禁变红（AU3 §11.4 同口径："既有 73 套件基线不得回归"）；任何测试/调试脚本立即 git add 入库。

### 12.2 每阶段测试/门禁清单

| 阶段 | 测试与门禁 | 出处 |
|------|-----------|------|
| R0 | T-D3-01~10 全绿（配对全流程/HKDF 已知向量/撤销拒绝/事件逐字节同构/断线续传/审批恢复/版本协商/白名单拒绝/生成器幂等/配对审计不进 41 变体）；T-M6-01~14 全绿；生成器两次运行字节一致；protocol-parity job（故意改注册表不重跑生成器 → 红）；`git check-ignore -v` 逐文件验证；mock daemon v0 可连 | D3 §12.6、M6 §13、D8 阶段 0-1 |
| R1 | D2 §13.1 L4 清单 1-9（curl /v1/info / 401 / 配对拿令牌 / 事件流订阅 / 手机 approve / 断线续传 / 桌面重启续传 / 关闭配对踢出 / 端口冲突落 8766）；D5 §10.3 红线 1-7（无端口监听 netstat / 远程无 full-access / 红线一律 Deny / 日志零明文 / config_secret 远程 100% Forbidden / 撤销 ≤1s 断连 / 全部远程动作 remote-* 审计打码）；Windows 真实局域网真机联调（追加验收）；安全测试面 T-01~T-14 | D2 §13、D5 §9-10、AU3 §6.4 |
| R2 | D4 §11.1 M0-M4 出口（真机 dev client 冷启动 / 配对→断网→重连→追平 / 离线决策送达 P95 / 100 条每秒不掉帧 / 目录树 1 万项 / 审批全链路 ≤3s）；F2 验收 1-7；双端同会话并发用例（追加）；jest 全量 ≥100（D8 阶段 2）；覆盖率 60/75/70/60 关键面 | D4 §11、F2 §15、D8 §9 |
| R3 | M8 §8.1-8.2（息屏/清杀审批 10s 内华为通知中心 / iPhone force quit 5s 内 APNs / 在线 1s 应用内通知 / 桌面重启未决审批 15min 重推 / 静默时段只收夜间摘要 / 各渠道到达率 ≥90% P0）+ 商店首发成功（备案号可见、隐私政策可达、权限声明与代码一致）；厂商消息分类/配额验证（M8 7.2 mock 厂商网关集成测试） | M8 §8.1-8.2、AU3 §6.4 |
| R4 | D1 P2 验收 1-5（4G 异地审批 <3s / 中继宕机自动回退局域网 / 端到端加密验证中继日志无明文 / 8 端 p95<1s 无丢 Critical / Hub 离线呈现 + 命令挂起）；M2 §11.5 验收 1-6；M3 NAT 矩阵 12 场景 + 打洞成功率 ≥70%（家庭）/≥50%（4G/5G）；全量回归 | D1 §8.2、M2 §11.5、M3 §11.5 |
| R5 | M1 §9.3 Gate B（NEXT 真机全链路）+ M8 §8.3（审批+推送闭环 / NEXT 专区上架 / 桌面关机后 P0 事件 ≤60s 代发） | M1 §9.3、M8 §8.3 |

### 12.3 移动端新增门禁（D8 §5 落地形态）

| 层 | 新增 job | 内容 |
|----|----------|------|
| 快层 | mobile-lint / mobile-typecheck / mobile-test-fast / protocol-drift | 移动端静态检查 + 关键套件 + 生成物漂移（重跑生成器 git diff --exit-code） |
| 中层 | mobile-test（jest 全量 + 覆盖率）/ protocol-parity / workspace-single-instance / mobile-build-smoke（expo export） | 全量测试 + TS↔Rust 对拍 + 双 react 单实例门禁 + 构建冒烟 |
| 慢层 | mobile-e2e（Maestro 冒烟）/ compat-nightly（最新桌面 × 上一移动发布兼容冒烟） | 每晚 |

**协议一致性三重防线**（D8 §5.3）：① 生成物 diff（快层）；② 跨语言对拍（同一注册表 JSON 分别生成 TS 与 Rust 测试夹具，双端跑同一组样例，中层）；③ 跨版本样例（v1/v2 兼容矩阵进 protocol-parity）。

**人为破坏实验**（D8 阶段 3 验收）：改生成物 / 改注册表不动生成器 / 双 react 引入 → 各有对应 job 红（门禁有效性证明）。

### 12.4 与现有仓库 CI 的衔接要点

1. **Rust 面**：新增 server/device/relay 代码的测试默认进 `cargo test --workspace`（不 ignore）；buffer stress 类压测沿用 `--ignored` 显式跑（D1 §8.4 先例）；壳级 `server_integration.rs` 若 >60s 才降级中层手动门禁，契约类断言（鉴权/游标/踢出）不得 ignore（D2 §13.2）；
2. **前端面**：桌面端快层 vitest 45/70/65/45 与 typecheck 不得回归；新增配对 GUI 命令四件套同步 `commandManifest.ts` 镜像（条数测试 95→99）；
3. **移动端面**：jest-expo 独立轨（不进根 vitest，避免 jsdom/RN 双环境互相污染，D8 §5.2）；protocol-core 测试只写纯 TS（会进桌面门禁 unit include 面，D8 §10.6 纪律）；
4. **外部面**：账号中心沿用其自身门禁（tsc + tsx --test + smoke:auth），新增模块按同模式补测；中继 crate 测试进 `cargo test --workspace`；
5. **每阶段结束提交纪律**：测试与调试脚本立即 `git add` 入库（AGENTS.md 铁律；AU3 §9.3 里程碑判定规则 4）。

### 12.5 总验收基线明细（D1 §8.2 P0-P3，全库最完整验收体系）

| 阶段 | 验收标准（原文浓缩） | 对应统一阶段 |
|------|----------------------|--------------|
| P0 原型（约 1 周） | ① 事件信封 JSON 与 core_event_bridge.rs:107-120 serialize 产物逐字节一致；② 远程 approve 后 run 从 awaiting-approval 恢复 running；③ 关掉网关 GUI 事件照常 | 并入 R0 验收（对拍门禁） |
| P1 局域网（约 3-4 周） | ① 扫码配对 <60s；审批端到端 <2s；事件流 <500ms；② 桌面重启后自动重连 + lastSeq 追平无重复无丢终态；③ 撤销设备立即失去连接；④ 断网/关桌面按离线矩阵表现正确；⑤ 抓包验证 TLS + 指纹；伪造裁决被 I-02 拒绝 | R1+R2 验收（⑤ 与 C-2 冲突已裁决：wss+pinning 进 R1） |
| P2 云中继（约 3-4 周） | ① 4G/5G 异地审批 <3s；② 中继宕机不影响局域网直连（双链路自动回退）；③ 端到端加密验证（中继日志无业务明文）；④ 8 端并发 p95 <1s 无丢 Critical；⑤ 桌面离线展示"Hub 离线"+ 命令挂起 | R4 验收 |
| P3 多端扩展（约 4-6 周） | ① 手机发消息 → 桌面 run 启动 → 全端同步 <2s 首帧；② Web 面板未配对浏览器无法访问；③ CLI 逐命令鉴权；④ 旧移动端与新桌面共存无回归；⑤ 全量回归（快/中层全绿） | 远期（R4 末顺延） |

### 12.6 协议验收锚点明细（R0 使用）

**T-D3-01~10**（D3 §12.6）：

| # | 验收点 | 证据 |
|---|--------|------|
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

**T-M6-01~14**（M6 §13，要点）：37 命令白名单三重约束 / 41 事件可路由 / fail-closed 元组 / 敏感字段不出网 / 幂等重发 / outbox 三态 / 断线续传 / 背压丢帧 / 流续传 / 生成器幂等 / 能力位裁剪 / 会话索引广播（session.updated）/ backward 分页 / 设置确认通道（settingsConfirm）。

### 12.7 验收缺口与冲突处置（AU3 §6.4）

1. **D1 P1 验收 ⑤（抓包验 TLS）与 D2"v1 免 TLS"冲突**——已裁决（C-2）：wss+pinning 进 R1，验收按 D1/D5 执行；
2. **R1 缺 Windows 真实局域网验收**——已追加：Windows 真机 + 手机同一家用路由器（非虚拟网卡）扫码配对 + 审批闭环；覆盖 AP 隔离不可发现时手动输 IP 路径；
3. **D4 M6（国内通道）出口标准缺厂商消息分类/配额验证**——以 M8 7.2 mock 厂商网关集成测试补；
4. **R3 验收缺商店侧**——并入 R3 验收清单（备案号可见、隐私政策可达、权限声明与代码一致）；
5. **跨端并发验收缺双端同会话并发用例**——R2 验收追加：桌面与手机同时向同一会话发消息 → 后者收到明确错误提示（会话串行守卫 cmd.session_busy）。

### 12.8 风险登记摘要（24 项，AU3 §7 全表要点）

**技术风险（13 项，最高关注 5 项）**：

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| T1 | RNOH 生态小且三方库碎片化（无推送类适配包） | 高 | 依赖收窄纪律 + 5 桥自研 + Gate A/B 决策门 |
| T2 | Expo SDK 57 新版本稳定性（Fabric/Nitro 边角） | 高 | 锁 57.0.0 + 前两周冒烟清单 + SDK 56 降级通道 |
| T4 | 自研 UDP 打洞在运营商 CGNAT 下成功率低（移动网 <50%） | 高 | M3a/M3b 与成功率解耦 + 达标率不达标切 WebRTC 方案 B（决策点：M3c 家庭 <50% 且 N-02~05 <80%） |
| T6 | 厂商推送碎片化（分类管控/配额/ROM 差异） | 高 | vendor trait 隔离 + 真机矩阵 + 节流/降级摘要 |
| T7 | 桌面关机=推送断源（架构属性） | 高 | 诚实呈现 + 审批待发持久化 + 开机自启托盘常驻 + M3 中继代发 |
| T9/T10/T11 | 事件扇出拖慢引擎 / 网关成为攻击面 / 双端协议漂移 | 中/高/中 | 全异步化 + 广播非阻塞 / 消息签名 + 指纹固定 + 审计 / 共享生成类型 + 对拍门禁 |

**业务风险（6 项）**：B1 账号中心是 flowbit 商业系统（高）——crish 全功能无账号可用铁律 + 可部署独立副本；B2 白名单扩展影响现有 chat_sync_desktop 用户（中）——env 化 + 分 app 隔离 + 回归联调；B3 App Review 远程控制类审查（中）；B4 移动端信任模型（手机丢失/越狱）（中）——L0-L3 验证 + 生物识别（P2）+ 可撤销；B5 隐私合规（中）；B6 厂商审核周期（中）。

**时间风险（5 项）**：W1 工信部 APP 备案 1-3 周（进最早关键路径，与账号申请并行启动）；W2 厂商账号 1-5 个工作日；W3 鸿蒙 ArkTS 技能零积累（P1 期培训 1 人）；W4 R0 单点瓶颈（专职 1-2 人 + 占比 8-10%）；W5 AC 外部交付延迟（按 2 周缓冲 + mock verify 先行）。

### 12.9 桌面端验收 L4 清单明细（D2 §13.1，手测九项）

1. `npm run tauri dev` 启动 → 本机 `curl http://127.0.0.1:8765/v1/info` 有响应；
2. 未带令牌访问 /v1/status → 401；
3. 开启配对 → 二维码出现 → 用任意 WS 客户端（wscat/websocat）完成 pair 握手 → 拿令牌；
4. 令牌连 /v1/events 订阅 → 桌面发起 run → 手机端看到完整事件流；
5. 审批场景：run 触发工具审批 → 手机端 approve → 桌面端即时收到 approval-resolved；
6. 手机断 Wi-Fi → 重连 → 事件从断点续传；
7. 桌面退出 → 重开 → 手机 token 仍有效，续传无缝；
8. 关闭配对 → 手机全部连接被踢、令牌失效；
9. 8765 被占用（netstat 占位）→ 启动后服务落在 8766，/v1/info 反映实际端口。

> 其中 5/6/7 为本阶段与 R2 联合验收的关键交叉点；9 验证端口探测兜底（8765-8775）。

### 12.10 移动端性能预算（D4 §9.5，R2 验收量化口径）

| 指标 | 预算 |
|------|------|
| 冷启动到可用（已配对） | ≤2.5s（中端 Android） |
| 事件流追加渲染 | 100 条/秒不掉帧（列表虚拟化 + useShallow selector） |
| WS 内存常驻 | ≤60MB（事件窗口 5000 条/session，超限落库卸载） |
| 包体 | 国内渠道 AAB ≤80MB（国际版 ≤60MB，Hermes + 资源裁剪） |
| 审批决策送达 P95 | ≤3s（在线路径）；离线路径 ≤ 重连恢复 + 2s |
| 目录树浏览 | 1 万项级性能达标（懒加载 + 缓存 60s TTL） |

桌面侧性能基线：扇出端级缓冲压测（复用 buffer.rs stress 模式，Delta 丢帧只丢 delta、Critical 必达）；8 端并发事件延迟 p95 <1s（R4 验收）；网关 + 引擎同进程的吞吐上限需压测数据支撑（AU2 G-7 缺口注记）。

### 12.11 测试资产保护与本系列门禁红线

1. **测试是资产不是杂物**（AGENTS.md 铁律）：新增调试/测试脚本（mock daemon、联调脚本、安全演练脚本）立即 `git add` 提交，不留在未跟踪状态；
2. **reference/markdown-editor 门禁**：`npm test`（vitest run tests/unit，含 grapheme/undo/parser-redos/chunk）在多端改造后必须继续全绿；该目录任何测试禁止删除；
3. **tests/e2e 五个 markdown-editor 专项 spec**（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）：禁止删除，回归时保留；
4. **注册面唯一真源**：COMMAND_REGISTRY_NAMES 与 manifest registered=true 的逐项一致性测试（main.rs:500-514）不得破坏；新增命令必须先注册再暴露（X-5）；
5. **registry_drift 双护栏**：engine-events 既有护栏 + device-protocol 新增护栏（R0-02/R0-05），事件注册表任何变更必须同步生成产物；
6. **人工威胁演练留痕**（D5 §9.5）：T-03/T-07/T-14 等网络依赖用例不设自动门禁，但必须在评审报告记录结果（结果也是资产）。

---

## 附录 A：与本总方案配套的交付边界

- 本总方案是**整合文档**：不新增任何协议/架构决策，只汇总与裁决索引化（裁决内容全部可回溯到 25 份分方案或 3 份审计原文）；
- 分方案与总方案不一致时，以总方案第 3 章决策记录为准；分方案内部细节以分方案为准；
- 后续实现任务书（PE 系列）引用阶段号一律使用 R0-R5 统一阶段号（P-5 已裁决）。

## 附录 B：分方案裁决/验收锚点速查（按阶段）

| 统一阶段 | 裁决来源章节 | 验收锚点来源 | 任务包 |
|----------|--------------|--------------|--------|
| R0 | 本总方案 §3.1-3.6（C-1~C-3 + A-1~A-7 + P-1~P-7） | D3 §12.6、M6 §13、D8 阶段 0-1 | P0-01~P0-04、R0-01~R0-07 |
| R1 | 本总方案 §3.2（P-1/P-2/P-7）+ §3.4（F-6/G-1/G-2/G-4/G-9） | D2 §13.1、D5 §9-10 | R1-01~R1-11 |
| R2 | 本总方案 §3.3（P1-4/P1-7/P1-8）+ §3.4（F-3/F-5/X-5/G-10） | D4 §11、F2 §15、D8 §9 | R2-01~R2-16 |
| R3 | 本总方案 §3.3（P0-4/P1-5/P1-9/P2-3）+ §3.4（G-5/G-6/G-8） | M8 §8.1-8.2、D7 §12 | R3-01~R3-09 |
| R4 | 本总方案 §3.3（P0-2/P0-3）+ §3.4（G-7）+ §10（O5/M8 O6） | D1 §8.2 P2、M2 §11.5、M3 §11.5 | R4-01~R4-07 |
| R5 | 本总方案 §7.1 + §10（M8 O5/O8） | M1 §9.3、M8 §8.3 | R5-01~R5-05 |

## 附录 C：变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-08-09 | 初稿：12 章总方案（愿景/架构/决策/协议/功能/安全/平台/路线/任务包/待裁决/索引/门禁）+ 3 附录；整合 25 份分方案 + 3 份审计；W1 未产出，裁决以审计原文为准 |
| v1.1 | 2026-08-10 | R0-04 追加：§11.5 阶段映射表（25 份分方案 + 总方案/审计/ADR 附注组）；C-1~C-3 + A-1~A-7 正式裁决落 `adr/ADR-01-protocol-decisions.md`（本文件第 3 章登记项以 ADR-01 为正式载体） |

---

*文档结束。Z0 总方案由 W2（总方案整合）产出，2026-08-09；全库裁决索引、实施路线、任务包、待裁决登记、文档索引、验收门禁六件套齐备。*
