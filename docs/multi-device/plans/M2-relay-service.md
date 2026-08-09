# M2-云中继服务方案：crish 多端互通的云中继服务完整设计

> 文档状态：设计方案（子代理产出，待主控评审）
> 产出路径：`C:\Software\conex\docs\multi-device\plans\M2-relay-service.md`
> 子代理：M2（云中继服务方案）
> 日期：2026-08-09
> 上游依据：`D1-overall-architecture.md`（多端互通总体架构）、`D2-desktop-serverification.md`（桌面服务化）、`D3-protocol.md`（跨端协议）、`D7-push-notifications.md`（推送通知）、`AC-account-center-evaluation.md`（账号中心评估，本方案的账号侧基准）
> 任务书：crish 多端互通的**自建云中继服务**完整方案；P2P 细节归 M3（本方案只定中继职责边界），UDP 面仅设计中继侧职责。
> 定位：本方案回答"中继服务做什么、怎么做、如何与账号中心/桌面端/手机端配合"九个问题（服务定位 / 技术栈 / 连接模型 / 认证授权 / 转发语义 / 数据模型 / API 面 / 运维 / 集成 / 测试）。

---

## 目录

1. [结论摘要（TL;DR）](#1-结论摘要tldr)
2. [服务定位与职责边界](#2-服务定位与职责边界)
3. [技术栈与选型确认](#3-技术栈与选型确认)
4. [连接模型](#4-连接模型)
5. [认证与授权](#5-认证与授权)
6. [转发语义](#6-转发语义)
7. [数据模型](#7-数据模型)
8. [API 面](#8-api-面)
9. [运维](#9-运维)
10. [与桌面端/手机端集成](#10-与桌面端手机端集成)
11. [测试](#11-测试)
12. [里程碑、工作量与风险](#12-里程碑工作量与风险)
13. [附录](#13-附录)

---

## 1. 结论摘要（TL;DR）

### 1.1 一句话结论

**中继服务 = 一个独立新写的轻量 Rust 进程（axum + tokio-tungstenite），只做"凭据校验 + 定向转发 + 在线状态"，零业务存储、零业务解析、零消息落盘；身份与凭据签发全部委托账号中心（复用 flowbit-auth 生产实例），P2P 打洞细节归 M3，本方案只锁定中继侧的 UDP 职责边界。**

### 1.2 核心裁决速览

| 维度 | 裁决 | 依据 |
|------|------|------|
| 服务边界 | 中继管"连接与转发"，账号中心管"身份与凭据"，桌面管"事件与推送意图"，三者解耦 | D1 §3.3、AC §6.1 |
| 独立 vs 扩展 | **独立 Rust 服务**，不在 zennav-server（Fastify）内扩展 | AC §5.3、§6.4 选型对比表 |
| 连接模型 | 桌面**常驻出站**连接 + 手机**按需出站**连接；中继按 (accountId, deviceId) 定向转发 | D1 §2.2.1、§3.3 |
| 认证 | 账号中心签发**短时中继凭据**（relay credential，HMAC 存储），中继经 `/api/relay/verify` 校验，本地缓存 ≤ 5 分钟 | AC §6.4 |
| 转发授权 | 同账号内 hub↔companion 互通；跨账号、companion↔companion、hub↔hub 一律拒绝 | D1 §2.5 主从模型 |
| 转发语义 | **协议感知最少量化**：中继只解析自身控制帧（含目标设备），D3 业务载荷原样透传、不解析不解密 | D1 §3.3"中继只转发" |
| 带宽控制 | 每连接令牌桶限速 + 帧大小上限 1 MiB + permessage-deflate 压缩（默认开） | 对齐 D3 §5.5 |
| 队列策略 | **中继零队列**：离线目标直接回 delivery-offline，缓冲/重试归两端（手机命令队列 / 桌面 push-core） | D1 §3.4、D7 §4.2 |
| 数据模型 | 中继侧零业务表，仅运维审计表（relay_sessions 元数据，7 天 TTL）；relay_credentials / push_tokens 在账号中心侧 | AC §6.3/6.4 |
| UDP 面 | 本期不实现；职责预留 = STUN 式打洞协助（反射地址）+ 远期 TURN 式中转；P2P 协商细节归 M3 | D1 §3.1.3、§8.3-4 |
| 部署 | 单二进制容器（scratch/distroless），无状态，多副本需"推荐副本哈希路由"（远期） | AC §6.10 |
| 隐私 | 日志只记连接事件与字节统计，**绝不落消息内容**；业务载荷端到端加密（D3 设备级 AEAD） | D1 §4.2、D5 §2 |
| 阶段 | P2 云中继（D1 §8.2 P2 验收：4G 异地审批 < 3s、8 端压测 p95 < 1s） | D1 §8.2 |

### 1.3 与上游方案的承接关系

```
D1 §3.3 云中继兜底（只转发不解密）
  └─ D2 §4.5a WS 中继协议草案 + D3 协议（L3 信封 / 设备级签名）
      └─ AC §6.4 中继凭据模块（账号中心侧）+ 独立 Rust 中继裁决
          └─ 本方案 M2：完整服务设计（连接/认证/转发/API/运维/测试）
              ├─ 输入：AC §6.4 的 relay_credentials 契约（表 + 4 端点）
              ├─ 输出：D3 的 RelayLink 服务端（wss 端点 + 帧协议）
              └─ 交接：M3（P2P/UDP 打洞细化）只消费本方案 §2.4 的 UDP 边界
```

### 1.4 设计原则（对齐 D1 §1.4）

1. **只转发不解密**：业务载荷（D3 DeviceEnvelope）在中继上以密文/原文原样存在，中继不落盘、不解析、不参与端间信任（对齐 D1 §3.3、D5 §2.4）。
2. **无业务状态**：中继不做会话快照、事件存储、离线缓冲（对齐 D1 §8.3 非目标 5）。
3. **账号可选、降级可用**：云账号/中继是 crish 的可选增强；桌面 GUI 与引擎在任何情况下不依赖中继（对齐 D1 §3.4 铁律、AC §5.4 边界声明）。
4. **两端出站**：中继场景桌面与手机都只做出站连接，中继不需要桌面开放任何入站端口（D1 §3.1.2 优点）。
5. **单层协议复用**：中继是 D2/D3 协议的传输换层，不发明新业务协议；中继自身的控制帧（hello/路由/心跳）是唯一新增帧面（对齐 D1 §3.7"同一应用层协议双层复用"）。
6. **安全默认**：TLS（标准 CA）+ 应用层设备级 AEAD + 凭据 HMAC 校验 + 全链路限流（对齐 D1 §1.4 原则 5）。

---

## 2. 服务定位与职责边界

### 2.1 中继做什么（职责清单）

中继服务的全部职责收敛为**三件事**：

| # | 职责 | 说明 | 对应章节 |
|---|------|------|----------|
| 1 | 连接转发 | 接收桌面/手机出站 wss 连接，按 (accountId, deviceId) 路由转发数据帧 | §4、§6 |
| 2 | 在线状态 | 维护在线设备表（内存态），供推送节流与状态查询 | §4.5、§8 |
| 3 | 凭据校验 | 握手时校验账号中心签发的 relay credential（可缓存） | §5 |

可选辅助职责（本方案明确**不做**，留给后续演进评估）：

| 职责 | 裁决 | 理由 |
|------|------|------|
| 推送发送器（厂商通道代理） | **不做** | D7 §4.2 裁决：发送器留在桌面 push-core；账号中心只做 push_tokens 注册表（AC §6.3）；中继只提供"在线状态"输入给节流决策 |
| 打洞协助（STUN 反射） | **预留，不做** | M3 细化 P2P；本方案只定 UDP 面职责边界（§2.4） |
| TURN 式中转 | **远期预留** | P4+（D1 §8.3 非目标 4） |
| 消息队列/离线存储 | **不做** | §6.4 零队列裁决 |
| 业务鉴权（端间信任） | **不做** | 端间消息鉴权走 D3 设备级 HMAC（AC §4.3.5 分工） |

### 2.2 与账号中心的关系：独立服务，接口级协作

**裁决（深化 AC §6.4）：中继服务与账号中心是两台独立部署的服务，仅通过一个服务间接口（`GET /api/relay/verify`）协作。**

```
┌───────────────────────┐   wss（RelayLink + 中继凭据）   ┌────────────────────────┐
│  crish 桌面（Hub）      │ ────────────────────────────> │                        │
│  · 事件/存储/审批/推送   │                              │    中继服务（Rust）       │
│  · 出站 RelayLink       │ <──────────────────────────── │  · 凭据校验（缓存 ≤5min）│
└───────────┬───────────┘   wss（RelayLink + 中继凭据）   │  · 定向转发              │
            │                                            │  · 在线状态              │
┌───────────┴───────────┐                              │  · 无业务存储            │
│  crish 手机（Companion）│ ────────────────────────────> │                        │
└───────────────────────┘                                └───────────┬────────────┘
                                                                      │ HTTPS 服务间
                                                                      │ x-auth-service-token
                                                                      ▼
                                                    ┌──────────────────────────────┐
                                                    │ 账号中心（flowbit-auth 复用）    │
                                                    │  · 身份：注册/登录/令牌/会话/审计  │
                                                    │  · 新增：relay_credentials 签发  │
                                                    │  · 新增：push_tokens 注册表      │
                                                    └──────────────────────────────┘
```

**职责分工一句话（对齐 AC §6.1）**：账号中心管"人、设备、令牌、推送注册、中继凭据"；中继服务管"转发与在线状态"；crish 桌面管"事件、推送意图、本地配对"。三者解耦，任一可独立演进。

**为什么独立部署（三个硬理由，深化 AC §5.3/§6.4）**：

1. **技术栈隔离**：账号中心是 Node/Fastify + better-sqlite3 单体（`AC §3.2`），中继是长连接转发面——长连接场景（万级并发、内存控制、背压）是 Rust 的主场，Node GC 内存开销大（AC §6.4 选型对比表）。语言不统一只影响"进程内组件"，两者本就是独立进程，没有共驻理由。
2. **故障域隔离**：账号中心是 flowbit 商业生产系统（AC §3.1），中继服务若长在账号中心进程内，账号中心的任何故障/发布/回滚都会连带踢掉全部在线连接；独立部署使"账号中心短时不可用 ≠ 中继不可用"（已有连接不受影响，见 §5.4）。
3. **转发面无状态，独立演进**：中继转发逻辑简单（约 500 行核心，AC §6.4），独立容器可自由水平扩展、独立灰度、独立安全加固，不与账号中心 22 个模块的发布节奏耦合（AC §3.3）。

**协作契约（唯一的服务间接口）**：

```
中继 ──HTTPS GET /api/relay/verify──> 账号中心
  请求：{ "credential": "rc_xxx...", "nonce": "..." }
  Headers: x-auth-service-token: <AUTH_SERVICE_TOKEN>
  响应 200：{ "accountId": "acct_...", "deviceId": "dev_...",
              "app": "crish_desktop", "status": "active",
              "expiresAt": 1785000000000 }
  响应 401/403：{ "error": "invalid_credential" | "revoked" | "expired" }
```

- 该接口语义与账号中心 `AUTH_SERVICE_TOKEN` 校验机制对齐（AC §4.2 证据：`auth.service.ts:2171-2183`）。
- 中继**必须**缓存校验结果（≤ 5 分钟），账号中心不可用时缓存未过期的连接不受影响（AC §9 风险 4 的缓解措施，本方案 §5.4 细化）。

### 2.3 与桌面服务网关的关系（D2 的 RelayLink 定位）

桌面端有两条对外链路（D1 §3.7 通道层 `Link` 抽象）：

| 链路 | 方向 | 承载 | 角色 |
|------|------|------|------|
| LocalLink（局域网 TLS WS） | 桌面入站（服务网关，D2 §10 WS /v1/events） | 局域网内手机直连 | 主通道（延迟/隐私最优） |
| **RelayLink（wss 出站）** | 桌面出站连中继 | 跨网手机经中继转发 | 兜底通道（跨网可达） |

中继服务的定位是 **RelayLink 的服务端**（AC §7.4 衔接点）。桌面服务网关（D2）保持局域网入站服务不动；RelayLink 是桌面进程内新增的**出站客户端组件**，其与网关的衔接（事件扇出分支、连接选择策略）归 D2，本方案只定义中继侧接受连接的协议面（§4.4、§8.1）。

### 2.4 UDP 面职责边界（交接 M3 的接口）

P2P/WebRTC 细化归 M3，但中继侧的 UDP 职责边界必须在本方案锁定，M3 只在这个边界内设计：

| UDP 面功能 | 中继侧职责（本方案） | 归属 |
|------------|----------------------|------|
| STUN 式打洞协助（反射地址查询） | 中继可暴露一个 UDP 端口响应 binding 请求（返回观测到的公网 IP:port），**不做** NAT 穿透算法、不做会话映射 | 中继可选增强（P4 前不实现） |
| 端口预测/协商辅助 | 不做 | M3（P2P 协商细节） |
| TURN 式中继（UDP 数据中转） | 远期（P4+）可复用本方案的连接鉴权与带宽控制框架，增加 TURN 协议面 | 远期预留 |
| UDP 数据通道 | 本期不做（纯 WS/TCP 转发） | 远期 |

**边界声明（重要）**：中继的 UDP 面与 WS 面**共享同一套身份与凭据体系**（relay credential + verify），但**不共享连接会话**（UDP 无连接语义）。M3 若做打洞，中继侧只需要一个无状态 UDP echo/反射端点，不感知 P2P 协商内容（打洞尝试的密钥/地址交换仍走应用层协议）。

### 2.5 非目标与边界（明确不做）

1. **不做业务状态**：无会话快照、无事件存储、无离线队列（D1 §8.3 非目标 5）；
2. **不做端间业务鉴权**：端间消息签名/防重放由 D3 设备级 HMAC 承担（D3 §5.1），中继不参与；
3. **不做账号/注册/登录**：全部在账号中心（AC §6.6 复用端点）；
4. **不做推送发送**：厂商通道发送器在桌面 push-core（D7 §4.2），中继只提供在线状态输入；
5. **不做多 Hub 同步**：同一用户两台桌面是两个独立 Hub，互不互通（D1 §2.5），中继默认禁止 hub↔hub 转发（§5.5）；
6. **不做协议转换**：中继透传 D3 信封，不做 MD-1 帧与 DeviceEnvelope 的双向转换（那是 D2 网关的职责）；
7. **不做 WebRTC 信令汇聚**：P2P 信令若未来经中继走，也是"转发"不是"汇聚解析"（M3 裁决）。

---

## 3. 技术栈与选型确认

### 3.1 选型结论

| 层 | 选型 | 版本依据 | 备注 |
|----|------|----------|------|
| 运行时 | Rust（edition 2021，tokio 1.x 全特性） | 与 crish 桌面栈一致（`apps/agent-workbench/src-tauri/Cargo.toml` 已依赖 tokio 1） | 单一二进制 |
| HTTP/路由框架 | **axum 0.8.x** | docs.rs 确认 axum 0.8.9（2026-07 发布）内置 `extract::ws`，依赖 tokio-tungstenite 0.29 | 生态成熟、与 tower 中间件体系兼容 |
| WS 库 | **tokio-tungstenite 0.29.x**（经 axum `extract::ws` 使用） | axum 0.8 的 WS 面即构建于 tokio-tungstenite 0.29 | 支持 permessage-deflate（经 with_config） |
| 序列化 | serde / serde_json | 仓库既有惯例 | 控制帧 JSON，业务载荷透传不解析 |
| 配置 | 环境变量 + `figment` 或手写 env 解析 | 仓库无现成配置 crate，最小化依赖 | 对齐账号中心 env 配置惯例（AC §3.2） |
| 日志 | `tracing` + `tracing-subscriber`（JSON 输出可选） | Tauri 壳已用 tracing（`target: "md"` 先例，D1 §8.1 R11） | 隐私红线见 §9.2 |
| 指标 | `metrics` crate + `/metrics` 文本导出（Prometheus 格式） | 无现成，手工实现轻量导出 | §9.1 |
| 存储 | SQLite（`rusqlite`）仅存连接审计元数据（可选编译） | 对齐账号中心 SQLite 惯例（AC §3.2） | 可关闭（纯内存模式） |
| TLS 终止 | 前置反向代理（Caddy/Cloudflare）或 axum `axum-server`（rustls） | 跟随 flowbit 生态 Cloudflare + Let's Encrypt 惯例（AC §3.7/§6.10） | §3.4 |
| 客户端校验（verify 调用） | `reqwest` 或 `hyper`（rustls） | 服务间 HTTPS 调用 | 带超时 + 熔断（§5.4） |

### 3.2 为什么是 axum + tokio-tungstenite（选型确认理由）

| 候选 | 裁决 | 理由 |
|------|------|------|
| **axum 0.8 + tokio-tungstenite** | **采用** | ① 与 crish 桌面栈同生态（D1 §3.1.1 已引用 axum/tokio-tungstenite 先例：Tauri 2 后端可自由内嵌）；② axum 0.8 原生 WS 提取器，无胶水层；③ tower 中间件体系直接复用（限流/超时/追踪）；④ docs.rs 已确认 axum 0.8.9 的 WS 面基于 tokio-tungstenite 0.29，异步生态一致 |
| 纯 tokio-tungstenite 裸服务 | 否决 | 需手写 HTTP 升级、路由、中间件；axum 已内建 |
| warp（hyper 1.x） | 否决 | 生态停滞，与 tokio-tungstenite 0.29 的集成面不如 axum |
| actix-web | 否决 | 与 crish 桌面栈（tokio 单运行时）不一致，引入第二运行时 |
| Node/Fastify 扩展账号中心 | 否决 | AC §6.4 选型对比表已裁决（长连接内存、栈一致性、耦合风险） |

**版本锁定建议**（写进 Cargo.toml 注释与 CI 缓存）：

```toml
[package]
name = "crish-relay"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = { version = "0.8", features = ["ws", "http1", "tokio", "json"] }
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = { version = "0.29", features = ["handshake"] }  # axum ws 内部使用，feature 对齐
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
metrics = "0.24"
rusqlite = { version = "0.32", features = ["bundled"], optional = true }
reqwest = { version = "0.12", features = ["rustls-tls", "json"], optional = true }  # verify 客户端（或 hyper）
```

### 3.3 部署形态

**单二进制容器，无状态转发面，SQLite 审计可选挂载**：

```
部署形态（P2 期）：
  单实例：relay.crish.example（或接入 flowbit 域名惯例，AC §3.7）
    ├─ Caddy / Cloudflare → TLS 终止（wss:// 标准 CA）
    ├─ 容器：ghcr.io/crish/relay:0.1.x（scratch/distroless，二进制 + 无外部运行时）
    └─ 数据卷（可选）：/data/relay-audit.sqlite（连接审计，7 天 TTL，可关）
```

- **镜像**：`FROM scratch`（或 `gcr.io/distroless/static`），静态链接 musl；仅含二进制 + 时区数据。
- **端口**：`8080`（HTTP/WS 统一入口，反代后暴露）；`9090`（/metrics，仅内网可达，不对外）。
- **健康检查**：`GET /healthz`（进程存活）+ `GET /readyz`（含账号中心 verify 连通性探测）。
- **资源基线**：P2 期个人/小团队规模——512MB 内存 / 1 vCPU 即可承载 2000+ 长连接（转发面无状态，内存大头是 per-连接 channel 缓冲，估 100-200KB/连接）。

**与账号中心部署的关系**（AC §6.10 对齐）：

| 项 | 账号中心 | 中继服务 |
|----|----------|----------|
| 运行形态 | 现有 Docker 单容器（node:22-bookworm-slim） | 新 Rust 单二进制容器 |
| 数据 | SQLite 单文件（/app/data） | 可选审计 SQLite（/data），核心无存储 |
| 域名 | auth.flowbit.me | relay.crish.example（新登记） |
| 可扩展性 | 单实例为主 | 无状态，可多副本（§9.6 哈希路由，远期） |
| 依赖方向 | 不依赖中继 | **依赖账号中心 verify 接口**（有缓存降级） |

### 3.4 TLS 与证书

- **推荐形态**：反向代理终止 TLS（Caddy 自动 Let's Encrypt，或 Cloudflare 边缘，跟随 flowbit 惯例 `AC §3.7`：Cloudflare DNS + Let's Encrypt SANs）。反代 → 中继为内网明文 http://relay:8080（内网信任域）。
- **可选形态**：中继直接终止 TLS（axum-server + rustls），适合独立裸机部署；证书轮换由 certbot 或 Caddy 承担。
- **安全性**：TLS 1.2/1.3；标准 CA 证书（手机端无需指纹固定，与局域网自签场景不同，D1 §3.6）。
- **注意**：TLS 保护只覆盖"端 → 中继"段；端到端机密性由 D3 设备级 AEAD 提供（§5.6），TLS 的职责是"防第三方窃听转发路径"。

### 3.5 代码组织结构（仓库落位）

```
crates/relay/                      # 新 crate（工作区成员，对齐 crates/ 惯例）
  Cargo.toml
  src/
    main.rs                        # 启动、配置、信号处理、模块装配
    config.rs                      # env 解析（RELAY_*、ACCOUNT_CENTER_*）
    state.rs                       # AppState：在线表 / 连接表 / 限流器 / 配置
    auth.rs                        # 凭据校验：verify 调用 + 缓存 + 熔断
    relay/
      mod.rs                       # WS 处理器装配
      handshake.rs                 # 握手状态机（hello / 凭据校验 / 路由注册）
      session.rs                   # 连接会话（读写 split、心跳、背压 channel）
      router.rs                    # 定向转发 + 广播 + 授权判定
      control.rs                   # 控制帧编解码（中继帧协议）
    limits/
      mod.rs                       # 令牌桶 + 连接速率限制 + 全局水位
    metrics.rs                     # 指标注册与 /metrics 导出
    audit.rs                       # 连接审计（可选 SQLite / 内存环形）
  tests/
    auth_tests.rs                  # 单测：凭据校验/缓存/熔断
    router_tests.rs                # 单测：路由矩阵/授权/广播
    integration.rs                 # 集成：真实 WS 客户端双端转发
    load_tests.rs                  # 压测（#[ignore] 显式跑，对齐 D1 §8.4 惯例）
  Dockerfile                       # scratch/distroless 多阶段构建
  .dockerignore
```

**对齐仓库铁律**：
- 中文注释、UTF-8 无 BOM（AGENTS.md 代码约定）；
- 纯逻辑与 IO 解耦（对齐 `run_task_impl` 先例，D1 §8.4），便于 `#[cfg(test)]` 无网络单测；
- 新增 crate 进 `crates/`，作为 workspace 成员，`cargo test --workspace` 门禁覆盖。

---

## 4. 连接模型

### 4.1 拓扑与连接方向

```
            ┌─────────────── 中继服务 ───────────────┐
            │  连接表：accountId → deviceId → Session │
            │                                        │
  wss 出站   │   在线表：deviceId → {online, since,   │   wss 出站
  ──────────►│              lastSeen, ip, appState}  │◄───────────────
  crish 桌面  │                                        │   crish 手机
  （Hub，常驻）│        定向转发（同账号内）               │  （Companion，按需）
            └────────────────────────────────────────┘
```

- **桌面（Hub）**：**常驻出站**连接（配置了云账号 + 中继时）。理由：桌面是事件源与权威端，必须随时可被手机触达（远程审批/事件查看）；开机启动即建立，整个会话期间保持（D1 §2.2.1："除中继场景的桌面→中继出站长连接"）。
- **手机（Companion）**：**按需出站**连接——打开 App 时建立（前台期间保持）；后台/杀进程即断开（厂商推送兜底，D7 §7.3）。
- **连接方向**：两端都是客户端，中继无入站穿透需求；桌面不需要开放任何公网端口（D1 §3.1.2 优点 2）。

### 4.2 连接会话生命周期（中继侧状态机）

每个连接在**握手前 → 已认证 → 活跃 → 断开**四态间迁移：

```
                    TCP+TLS 建立（反代终止 TLS 时为 TCP）
                            │
                            ▼
                   ┌─ [PendingAuth]  ─┐   握手超时（10s）/ 帧超限
                   │  等待 hello 帧    │ ──► [Closed: handshake_timeout]
                   └───────┬──────────┘
                           │ hello 帧（含 credential）
                           │ 凭据校验（本地缓存 → 账号中心 verify）
                           ▼
                     ┌─ 失败 ──► [Closed: unauthorized（403 语义）]
                     ▼
              ┌─ [Authenticated] ──┐   注册连接表 + 在线表
              │  可收发数据帧       │ ──► 广播在线状态变化（可选）
              └───────┬────────────┘
                      │ 心跳超时（3 次未 pong）/ 帧协议错误 / 背压满
                      ▼
              [Closed: timeout | protocol_error | overload]
                      │  注销连接表 + 在线表，写审计
                      ▼
              清理（内存回收）
```

**状态与超时参数（v1 定稿）**：

| 参数 | 值 | 说明 |
|------|-----|------|
| 握手超时 | 10 秒（`HANDSHAKE_TIMEOUT_MS = 10_000`） | 连接建立后必须在期限内完成 hello + 凭据校验 |
| 心跳间隔 | 30 秒（`HEARTBEAT_INTERVAL_MS = 30_000`） | 中继主动 ping；对端 pong 超时计数 |
| 心跳容错 | 3 次未响应（`HEARTBEAT_MAX_MISSED = 3`） | 90 秒无响应判死 |
| 空闲保活 | TCP keepalive 开启（15s/5 次） | 防半开连接（手机切网场景） |
| 单连接寿命上限 | 24 小时强制重连（`SESSION_MAX_AGE_MS = 86_400_000`） | 防凭据长占、连接泄漏；客户端静默重连无感 |

### 4.3 心跳与在线判定

**两层心跳**：

1. **传输层（WebSocket ping/pong）**：中继每 30s 发 WS ping，客户端协议栈自动回 pong——判定"链路活着"，不感知业务；
2. **应用层（D3 协议既有 heartbeat 消息）**：端侧（尤其手机）上报 `appState: foreground | background | active`（D7 §4.3-2 裁决：在线判定由桌面做，中继只是搬运在线状态的载体）。中继把 `appState` 存进在线表，供查询方（桌面 push-core 经账号中心 A9 或直接查询）做节流决策。

**在线判定规则**：

| 判定 | 依据 | 动作 |
|------|------|------|
| 在线 | 连接已认证且未超时 | 在线表 lastSeen 更新 |
| 半在线（移动端后台） | appState=background | 在线但标 background（推送节流输入） |
| 离线 | 心跳超时 / 主动断开 / 被踢 | 在线表删除 + 广播离线事件（可选） |

**在线状态的消费者**（中继只提供数据，不做决策）：

- 桌面 push-core：手机在线 → 直推；离线 → 厂商通道（D7 §4.3-2）；
- 账号中心会话列表 API（AC §6.2 A9）：响应附加设备在线状态，供设备管理 UI 一屏管理；
- 手机端：显示"桌面在线/离线"（远程审批按钮可点性）。

### 4.4 连接路由：如何把消息送到目标设备

**核心路由原语**：中继维护一张内存连接表 `(accountId, deviceId) → Session`。转发 = 收到数据帧 → 解析目标 deviceId → 查表 → 投递到该连接的写队列。

```
路由判定（收到数据帧时）：
  1. 帧头解析出 { to: deviceId }（中继帧协议 §6.2）；
  2. 查连接表：目标 (accountId, to) 是否有活跃连接？
     ├─ 无 → 回 control 帧 delivery-offline（§6.4 零队列）；
     └─ 有 → 授权检查（§5.5）→ 通过 → 入目标连接写队列；
  （广播：to = "*" → 同账号全部在线 Companion 各投一份，§4.6）
```

**桌面常驻 + 手机按需的连接组合**（本方案核心场景推演）：

```
场景 A：手机在前台，同网 → LocalLink（不经中继）
场景 B：手机在前台，跨网 → 手机连中继（RelayLink），桌面常驻中继连接
        手机 → 中继 → 桌面：命令帧（审批/取消）
        桌面 → 中继 → 手机：事件帧（approval-requested 等）
场景 C：手机在后台/被杀 → 中继无手机连接 → 桌面 push-core 走厂商通道（D7）
        中继在此场景的角色：在线表显示手机离线 → 节流决策输入
场景 D：桌面离线（关机/睡眠）→ 中继连接表无桌面 → 手机侧显示"Hub 离线"
        手机命令帧 → 中继回 delivery-offline → 手机入本地命令队列（D1 §3.4）
```

### 4.5 多设备广播（fan-out）

- **触发**：桌面产生的全局事件（如 approval-requested、message-end）需要投递给该账号下全部在线 Companion（D1 §2.5：P2 支持 ≤ 8 端）。
- **语义**：桌面发 `to: "*"`（广播）或 `to: ["dev-mobile-1", "dev-mobile-2"]`（组播列表）→ 中继复制投递。
- **实现**：逐接收连接独立入队（各连接有自己的写 channel），**互不阻塞**——慢消费者只影响自己的队列，不影响其他接收方与发送方（对齐 D1 §6.2 事件扇出"按端独立背压"）。
- **背压**：接收连接写队列满（512 帧）→ 对该接收者触发"丢 delta 式降级"：中继不感知业务，不能区分 delta/critical，所以降级策略为——**队列满 → 发 error 帧 overload → 断开该连接**，客户端重连后靠协议层游标追平（D3 事件游标机制兜底，D1 §5.3）。这是"中继诚实"的边界：宁断链，不静默丢帧。
- **上限**：单次广播接收方 ≤ 16（对齐 P2 规模上限 8 端 + 余量）；超限拒绝广播帧。

### 4.6 连接并发上限（防滥用基线）

| 上限 | 值 | 依据 |
|------|-----|------|
| 每账号并发连接 | ≤ 8（`MAX_CONNECTIONS_PER_ACCOUNT = 8`） | D1 §2.5：P2 ≤ 8 端；同账号 8 台设备 + 余量 |
| 每设备并发连接 | ≤ 1（`MAX_CONNECTIONS_PER_DEVICE = 1`） | 一设备一连接；重复连接踢旧（对齐 D2 §10.1 并发限制语义） |
| 每 IP 并发连接 | ≤ 16（`MAX_CONNECTIONS_PER_IP = 16`） | 防单 IP 拖垮（DDoS 基线，§9.4） |
| 全局并发 | 可配（`MAX_GLOBAL_CONNECTIONS`，默认 8192） | 单实例资源保护 |

**重复连接语义**：同一 (accountId, deviceId) 新连接握手成功后，旧连接收到 `kicked`（reason: duplicate-connection）并关闭——保证"一设备一连接"的在线状态唯一性（对齐 D2 §10.1 的 kicked 语义）。

### 4.7 核心场景完整时序：手机跨网远程审批（P2 验收场景）

这是中继存在的**首要场景**（D1 P2 验收 1：手机 4G/5G 异地完成审批 < 3s），全链路时序如下：

```
手机（4G，异地）                 中继服务                      桌面（家，常驻在线）          引擎/审批门
    │                              │                              │                              │
    │ 1. App 打开 → 连 RelayLink    │                              │                              │
    ├─────────────────────────────>│                              │                              │
    │ 2. hello + credential         │ 3. verify（缓存或账号中心）    │                              │
    │<─────────────────────────────┤──────────────────────────────│                              │
    │ 4. hello-ok（会话建立）        │                              │                              │
    │                              │                              │ 5. run 发起 → 需要审批         │
    │                              │                              │<─────────────────────────────┤
    │                              │                              │ 6. approval-requested 事件    │
    │                              │<─────────────────────────────┤  → push-core 判定手机在线      │
    │                              │ 7. data 帧（事件广播）          │  → 直推（不走厂商通道）        │
    │<─────────────────────────────┤                              │                              │
    │ 8. 渲染审批卡片（全量载荷）     │                              │                              │
    │ 9. 用户点「批准」              │                              │                              │
    ├─────────────────────────────>│ 10. data 帧（命令：approve）  │                              │
    │                              │─────────────────────────────>│ 11. 鉴权 → 审批门 resolve     │
    │                              │                              │ 12. approval-resolved 落库    │
    │<─────────────────────────────┤<─────────────────────────────┤ 13. 事件广播（含本次裁决）     │
    │ 14. UI 显示已批准              │                              │                              │
```

**延迟预算（目标 < 3s）**：

| 段 | 预算 |
|----|------|
| 手机→中继（公网 RTT） | ≤ 150ms × 2（上/下） |
| 中继转发（含写队列） | ≤ 10ms（本地进程） |
| 桌面→中继（公网 RTT） | ≤ 150ms × 2 |
| 桌面命令处理（审批门） | ≤ 100ms |
| 事件广播回程 | 与上行对称 |
| 合计 | ≤ 1s 量级（远低于 3s 验收线，余量充足） |

**旁路说明**：
- 步骤 6 中 push-core 的"手机在线"判定来自中继在线状态（§4.3 路径 A：桌面查 /v1/status/online，缓存 ≤ 5s）——所以手机刚连上但缓存未刷新时可能短暂走厂商通道（双发，D7 §4.3-2 的"直推 + 厂商双发"决策覆盖）；
- 步骤 10 的命令帧在 D3 协议层带设备级 HMAC 签名 + 幂等键（D3 §5.4），中继只搬运；
- 桌面离线（睡眠）时步骤 6 无法发生：push-core 不直推，手机展示"Hub 离线"（D1 §3.4 矩阵），审批命令本地挂起。

### 4.8 中继连接的内存与资源模型（支撑容量判断）

```
每连接资源：
  · 读写 channel：2 × 512 帧 × 最大帧 1 MiB 的指针引用（不预分配缓冲）
  · 实际缓冲：平均帧 4-16 KB → 单连接典型内存 200-500 KB（含 tokio task 栈）
  · 令牌桶记账：O(1) 结构
  · 连接表条目：< 200 字节
全局资源：
  · 8192 连接上限 × 350 KB ≈ 3 GB 峰值（理论）；实际个人规模（≤ 32 连接）< 50 MB
  · 转发任务：每连接 2 个 task（读/写 split）+ 全局路由 task 池
```

**结论**：单实例 512 MB 内存预算可支撑数千连接（§3.3 资源基线），个人/小团队规模（账号 ≤ 8 设备）仅占用 5% 以下——多地域/多副本是远期扩展项而非规模必需项（§9.6）。

---

## 5. 认证与授权

### 5.1 认证体系总览：三层信任，各司其职

crish 多端体系有**三层独立信任**（对齐 AC §4.3.5 分工，必须明确不混用）：

| 层 | 信任内容 | 凭据 | 归属 |
|----|----------|------|------|
| L1 账号层 | "这个连接属于哪个用户账号" | relay credential（账号中心签发） | 本方案 §5.2-5.4 |
| L2 设备层 | "这条消息确实是这台设备发的" | D3 设备级 HMAC（配对派生 token_key） | D3 §5.1（中继不参与） |
| L3 业务层 | "这个命令有权限执行" | 桌面命令白名单 + 审批门 | D2 §8.3 / D5 |

**中继只持有 L1**：凭据校验通过 = 知道 (accountId, deviceId, role)；消息内容是否可信由 L2（端间 HMAC）保证，中继**不解密不验签**（D3 §5.1 明确签名校验在端侧做）。

### 5.2 中继凭据（relay credential）设计

**为什么不能用现有令牌**（AC §4.3.5 已论证，此处定稿）：

| 现有机制 | 问题 | 结论 |
|----------|------|------|
| access token（15 分钟 TTL） | 太短，长连接常驻需频繁刷新；轮换语义与长连接不匹配 | 不用 |
| refresh token（30 天，轮换） | 轮换语义（单次使用、刷新即换）会让常驻连接每 30 天断一次 | 不用（凭据自身可刷新，见下） |
| AUTH_SERVICE_TOKEN | 静态共享密钥，无 per-设备语义，泄漏即全盘 | 仅限服务间（中继 → 账号中心 verify 调用） |
| D3 设备令牌（配对派生） | 局域网配对体系，**没有云端身份**（accountId 概念） | 与 L1 互补，不替代 |

**relay credential 的形态（新模块，AC §6.4 契约定稿）**：

| 属性 | 值 | 说明 |
|------|-----|------|
| 明文形态 | `rc_<32 字节随机>`（base64url） | 签发时一次性返回明文，服务端只存 HMAC |
| TTL | 30 天（`RELAY_CRED_TTL_DAYS = 30`） | 与 refresh token 同量级，可刷新轮换 |
| 绑定 | account_id + device_id + app | 一设备一凭据（同设备重复签发 = 轮换） |
| 撤销 | 设备撤销联动（AC §6.2 A3）/ 显式撤销端点 | 撤销即时生效（verify 拒绝） |
| 存储 | 账号中心 SQLite，仅 HMAC（对齐 AC §6.4 表定义） | 明文泄漏库也无法伪造 |
| 用途 | 仅限"连接中继"握手，不做任何消息签名 | 消息签名走 L2 |

### 5.3 凭证流（完整时序）

```
桌面/手机端                                账号中心                                  中继服务
   │  1. 登录（email/password，AC 复用）       │                                          │
   ├────────────────────────────────────────>│                                          │
   │  ← access token（15min）                 │                                          │
   │                                          │                                          │
   │  2. 首次连接前：POST /api/relay/credentials（Bearer）                                │
   ├────────────────────────────────────────>│                                          │
   │  ← 200 { credential: "rc_xxx",          │  服务端存 HMAC(credential)，明文不落库      │
   │         expiresAt, credentialId }       │                                          │
   │  端侧存 OS 凭据库（§10.1）               │                                          │
   │                                          │                                          │
   │  3. 连接中继：wss://relay/v1/ws?token=rc_xxx                                        │
   ├─────────────────────────────────────────────────────────────────────────────────────>│
   │                                          │                                          │
   │                                          │  4. 中继校验：GET /api/relay/verify        │
   │                                          │     { credential, nonce }                 │
   │                                          │<──────────────────────────────────────────│
   │                                          │  ← 200 { accountId, deviceId, app, ... } │
   │  ← hello-ok { sessionId }               │     （中继缓存 ≤5min）                     │
   │<─────────────────────────────────────────────────────────────────────────────────────┤
   │  5. 凭据过期（30 天）→ 握手 403：                                                 │
   │     端侧 POST /api/relay/credentials/refresh（Bearer + 旧凭据）→ 新凭据，旧立即失效   │
   │     重连中继（步骤 3）                                                              │
   │  6. 设备被撤销（AC A3 联动）→ verify 拒绝 → 中继 403 → 端侧清凭据 + 提示重新登录/配对 │
```

**关键安全点**：
- 明文凭据**只出现两次**：账号中心签发响应（TLS）与端侧本地存储（OS 凭据库）；
- 中继与账号中心之间传输的是明文凭据 + nonce，受服务间 TLS 与 service token 保护；
- verify 是**一次性语义**（防重放）：nonce 由中继生成，账号中心记录已用 nonce（短窗 60s），重放拒绝。

### 5.4 中继侧校验与降级（缓存 + 熔断）

**校验路径**（`auth.rs`）：

```
握手 hello 帧 → 提取 credential：
  1. 查本地缓存（HashMap: credential_hash → verify 结果，TTL ≤ 5min）：
     ├─ 命中且未过期 → 直接用（幂等，同一凭据并发握手只发一次 verify）
     └─ 未命中 → 调账号中心 /api/relay/verify（超时 2s，重试 1 次）
  2. 账号中心不可达（超时/5xx）：
     ├─ 本地有未过期缓存 → 放行（降级）
     └─ 无缓存 → 拒绝（403 service-unavailable；客户端稍后重试）
  3. verify 返回 revoked/expired/invalid → 拒绝 + 缓存负面结果（TTL 60s，防连打）
```

**缓存为什么安全**：
- 凭据 TTL 30 天，verify 结果缓存 5 分钟——最坏情况下"撤销后最多 5 分钟才踢出"（对齐 AC §9 风险 4 的缓解："中继本地缓存校验结果（≤5 分钟）"）；
- 被撤销设备的新连接在缓存失效后立即被拒；
- 已建立连接的活跃连接**不受**账号中心短时故障影响（连接级降级，不校验每帧）。

**熔断**：连续 N（默认 10）次 verify 失败 → 熔断 30s（不再打账号中心，直接走缓存/拒绝路径），防止故障风暴打垮账号中心。

### 5.5 转发授权（连接之间的可达矩阵）

中继在转发时强制执行**账号内主从授权**（对齐 D1 §2.1 Hub/Companion 角色模型）：

| 发送方 \ 接收方 | Hub（桌面） | Companion（手机） | 另一账号任何设备 |
|-----------------|-------------|-------------------|------------------|
| Hub（桌面） | ✗ 拒绝（同账号多 Hub 不互通，D1 §2.5） | ✅ 允许（事件/推送） | ✗ 拒绝 |
| Companion（手机） | ✅ 允许（命令/审批） | ✗ 拒绝（Companion 不互通） | ✗ 拒绝 |
| 另一账号任何设备 | ✗ 拒绝 | ✗ 拒绝 | 无（连接表隔离） |

**授权实现**：
- 连接会话记录 `role`（握手时由 verify 返回的 deviceId 关联账号中心设备表 platform/role 得出：platform=desktop → hub，platform=mobile → companion；**中继不信任端侧自报 role**，只信账号中心数据）；
- 路由时按上表判定，拒绝则回 `error` 帧（code: relay.forbidden）+ 审计（§9.2）；
- **身份隔离是数据面的**：连接表本身按 accountId 分桶（HashMap<accountId, HashMap<deviceId, Session>>），跨账号查询在数据结构上不可达（不是"查了再拒绝"，而是"查不到"）。

### 5.6 端到端机密性（中继不可读业务载荷）

- 中继链路上的业务帧（data 帧 payload）= D3 DeviceEnvelope 密文（设备级 AEAD，AES-256-GCM，D1 §4.2 裁决：**中继链路必须应用层设备级加密**）；
- 加密密钥来自配对期派生的 `enc_key`（D3 §4.4 步骤 5 已预留派生），端到端持有，中继/账号中心均无；
- 因此中继可见的最多只有：控制帧头（to/from/type）与密文长度——**这决定了 §6.2 帧协议的最小化原则**：路由所需字段必须放控制帧头（中继要读），业务内容全进 payload（中继不读）。

### 5.7 认证威胁模型（威胁 → 防护措施对照）

| # | 威胁 | 攻击路径 | 防护措施 | 覆盖层 |
|---|------|----------|----------|--------|
| 1 | 凭据窃取（抓包） | 明文凭据在"端→账号中心签发"或"端→中继握手"链路上被截获 | 全程 TLS；凭据只出现在握手一次 + 本地存储；中继侧 query 与 hello 帧双重携带（防 query 日志截获后单点复用，§8.1） | L1 |
| 2 | 凭据重放 | 截获凭据后建立第二连接 | 凭据与 deviceId 绑定 + 一设备一连接（重复连接踢旧，§4.6）；verify 的 nonce 一次性（§5.3） | L1 |
| 3 | 凭据库拖库 | 账号中心 SQLite 泄漏 | 服务端只存 HMAC（明文不在库，AC §6.4）；HMAC 密钥独立（AUTH_TOKEN_SECRET） | L1 |
| 4 | 中间人（MITM） | DNS 劫持/证书伪造指向假中继 | 标准 CA + TLS 1.2+；即便假中继接入，业务载荷为 AEAD 密文 + 设备级 HMAC 签名（L2 不受 L1 失守影响）——**纵深防御的关键设计** | L1+L2 |
| 5 | 越权转发（跨账号） | 伪造 to 目标设备 | 连接表按 accountId 分桶（数据面隔离，§5.5）；授权矩阵在路由层强制 | L1 |
| 6 | 角色伪造 | 手机自报 hub 角色 | 中继不信任自报 role，只信账号中心 verify 返回的设备信息（§5.5） | L1 |
| 7 | 消息伪造/篡改 | 劫持连接注入伪造命令 | D3 设备级 HMAC 签名（每消息），密钥在端侧，中继无（D3 §5.1） | L2 |
| 8 | 消息重放 | 截获密文重放 | D3 nonce 窗口 + ts 窗（±5 分钟）+ 幂等键（D3 §5.1/§5.4） | L2 |
| 9 | 业务嗅探 | 在转发路径上观察流量 | 端到端 AEAD（§5.6）；中继只见密文与路由头 | L2 |
| 10 | 资源耗尽（连接洪泛） | 大量假连接拖垮中继 | 三层限流 + 水位保护 + 反代层（§9.3/§9.4） | L1+运维 |
| 11 | 账号中心打挂（间接攻击） | 大量握手触发 verify 风暴 | 中继缓存 + 熔断（§5.4）；verify 仅在握手时发生 | L1+运维 |
| 12 | 隐私合规（日志泄漏业务内容） | 日志/审计被读取 | 零内容日志红线（§9.2）+ 审计表仅元数据（§7.2） | 运维 |

**关键结论**：即使 L1（中继认证）被完全攻破，L2（端间 HMAC + AEAD）依然保护消息真实性、完整性与机密性——中继成为"可失守但无收益"的目标，这是"中继不持密钥"架构的最大安全收益。

---

## 6. 转发语义

### 6.1 转发模式裁决：透传字节流（帧内不解析业务）

**裁决：中继是"帧级透传"，不是"字节流透传"，更不是"协议感知"。**

| 模式 | 说明 | 裁决 |
|------|------|------|
| 字节流透传（TCP 式盲转发） | 中继不感知任何结构，按流转发 | 否决：无法路由（不知道目标设备）、无法限流帧粒度 |
| **帧级透传（本方案）** | 中继解析**自身控制帧头**（含 to/from/type/长度），业务 payload 原样透传不解析 | **采用**：路由所需字段最少量化可见，业务零解析 |
| 协议感知（解析 D3 信封做智能处理） | 中继读懂业务（如识别 delta 事件） | 否决：违反"中继只转发"铁律（D1 §3.3），且业务演进（41 事件变体新增）会变成中继的兼容负担 |

**帧级透传的两个"解耦"**：
1. **与业务协议解耦**：中继不认识 D3 的 `kind`/`msgId`/`auth` 字段，payload 对中继是不透明字节；
2. **与客户端实现解耦**：中继控制帧只依赖"设备标识 + 账号标识"（由账号中心体系定义），任何端（桌面/手机/未来 Web/CLI）用同一控制帧协议接入。

### 6.2 中继帧协议（RelayFrame，v1）

中继是 RelayLink 的服务端，沿用 D1 §3.7 "MD-1 帧"形态（JSON，camelCase），但**只定义控制面**，业务面透传：

```json
// 控制帧（中继解析）
{ "t": "hello",   "v": 1, "credential": "rc_xxx", "deviceId": "dev_...",
  "protocolVersions": [1], "appVersion": "0.1.0" }
{ "t": "hello-ok", "sessionId": "rel_...", "serverTimeMs": 1754000000000 }
{ "t": "hello-err", "code": "relay.unauthorized", "message": "..." }
{ "t": "data",    "to": "dev-mobile-xxx", "from": "dev-desktop-yyy", "frame": "<base64 或原始字节>" }
{ "t": "broadcast", "to": "*", "from": "dev-desktop-yyy", "frame": "..." }   // 或 to: [设备列表]
{ "t": "delivery", "msgId": "m-001", "status": "offline" }   // 投递反馈（离线/失败）
{ "t": "ping", "ts": 1754000000000 }
{ "t": "pong", "ts": 1754000000000 }
{ "t": "error", "code": "relay.forbidden", "message": "..." }
{ "t": "kicked", "reason": "duplicate-connection" }
{ "t": "bye", "reason": "client-logout" }
```

**帧编码规则（v1 定稿）**：

| 规则 | 值 | 说明 |
|------|-----|------|
| 帧类型 | 文本帧（JSON）/ 二进制帧（大载荷，data.frame 为原始字节） | 对齐 D1 §3.6：大载荷用 Binary 避免 JSON 转义膨胀 |
| 单帧上限 | 1 MiB（`MAX_FRAME_BYTES = 1_048_576`） | 对齐 D3 §5.5 同值；超限 → error + 断链（防内存放大） |
| data.frame 编码 | 文本帧：内嵌字符串；二进制帧：裸字节（to/from 在帧头 metadata，二进制帧携带二元 WebSocket 消息 + 前置 8 字节头（to 长度+to+from 长度+from）） | 二进制帧路由头用定长前缀，O(1) 解析 |
| 消息投递反馈 | `delivery` 帧可选（发送方显式请求时回） | 默认不回（减少流量）；命令类帧端侧要求回显 |
| msgId | 客户端生成、透传回显 | 中继不校验唯一性（L2 层管） |

### 6.3 带宽控制

**三层限速（由内到外）**：

```
L1 帧大小上限：1 MiB（防单帧放大）
L2 每连接令牌桶：读写各 512 KB/s（可配），突发 1 MB
L3 每账号聚合带宽：5 MB/s（可配，防单账号拖垮全局）
```

| 层 | 机制 | 行为 | 说明 |
|----|------|------|------|
| 帧大小 | 读帧长度检查 | 超限 → error(frame_too_large) + 断链 | 对齐 D3 §5.5 语义 |
| 每连接速率 | 令牌桶（tokio 定时补充） | 写路径限速；超限 → 帧排队（有界 512 帧）→ 满 → error(overload) + 断链 | 事件突发被自然削峰；命令低频不受影响 |
| 账号聚合 | 全局记账（滑动窗口） | 超出 → 新数据帧拒绝（error: rate-limit）→ 客户端退避 | 防"一账号广播风暴拖垮多端" |

**限速与协议的关系**：中继限速**只看字节数不看业务**（不区分事件/命令/审批）——这是"不感知业务"原则的直接推论；命令类帧的可靠性由端侧超时重发兜底（D3 §5.4 命令超时 30s + 幂等重发），所以中继按字节限速不会造成业务层不可恢复丢失。

**压缩（兜底场景关键）**：

| 项 | 裁决 | 依据 |
|----|------|------|
| 方案 | WebSocket permessage-deflate（RFC 7692），握手时协商，**默认开启** | tungstenite 0.29 支持（with_config）；JSON 文本帧压缩比 3-5x |
| 适用 | 文本帧（JSON）全量；二进制帧（已压缩载荷，如事件密文/文件内容）**跳过** | 密文/已压缩数据再 deflate 收益为负 |
| 场景 | 中继是"P2P 省带宽"的兜底（用户点题）：手机蜂窝网络下压缩显著降流量成本；局域网直连不经中继，不受影响 | 用户需求："P2P 省带宽——中继作为兜底时的限流/压缩" |

### 6.4 队列与离线缓冲：**中继零队列**裁决

**裁决：中继不做任何业务队列、不做离线缓冲。**

```
发送方 → 中继 ──目标在线──> 直接投递
              └─目标离线──> 回 delivery-offline → 发送方自行处理（不排队）
```

**理由（三条铁律 + 两端已有机制）**：

1. **D1 §8.3 非目标 5**："不做中继的业务状态（无事件存储）"——队列本质是状态，违反；
2. **隐私红线**：中继缓冲 = 业务数据落点（哪怕内存），与"只转发不落盘"矛盾（§9.2）；
3. **两端已各有队列机制**，中继重复实现必然与两端策略漂移：

| 方向 | 发送方已有机制 | 中继需要做的 |
|------|----------------|--------------|
| 手机 → 桌面（命令） | 手机本地命令队列（D1 §3.4：断连时命令队列化，最多 N 条，重连后按序发送 + 幂等键去重） | 只回 delivery-offline |
| 桌面 → 手机（事件/通知） | 桌面 push-core（D7：在线直推 + 离线厂商通道兜底） | 只回 delivery-offline（push-core 据此切换通道） |

**唯一的"缓冲"例外（列为二期可选增强，v1 不做）**：目标设备**刚刚**掉线（≤ 30s）且发送方请求 `retain: true` 时，中继可做**内存短窗缓冲**（每连接 ≤ 1 MB、无持久化、TTL 30s），目标重连后补投。理由：手机切网瞬间（WLAN→蜂窝）重连通常在 30s 内，短窗缓冲可避免命令重发延迟；但 v1 不实现（复杂度/内存/行为测试成本），端侧重连 + 游标/幂等已能覆盖该场景（D3 §5.4、D1 §5.3）。

### 6.5 投递反馈与可靠性边界

| 投递结果 | 中继动作 | 发送方语义 |
|----------|----------|------------|
| 成功（目标在线，入写队列） | 可选回 `delivery: delivered`（请求时） | 已交到目标连接（不保证应用层处理——那是 L2/L3 的事） |
| 目标离线 | 回 `delivery: offline` | 手机：入本地命令队列；桌面：切厂商通道 |
| 授权拒绝 | 回 error(relay.forbidden) | 端侧应视为配置错误（不应发生） |
| 目标连接背压满 | 回 `delivery: overload` + 断开目标（§4.5） | 端侧重连 + 游标追平 |

**诚实边界（重要）**：中继的"delivered"只承诺"已进入接收方连接的写队列"，不承诺"接收方应用已处理"。业务级确认（如审批落库、命令执行完毕）由 D3 协议层 command-ack/事件回执承担（D3 §5.4）——中继不越权做业务确认。

### 6.6 帧协议 JSON Schema 定义（v1 定稿，供双端与中继共用）

控制帧的 JSON Schema（D1 §3.7 帧协议风格的定稿；与 D3 信封的关系：`data.frame` 字段承载 D3 DeviceEnvelope 原文，两层互不侵入）：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "RelayFrame v1",
  "type": "object",
  "required": ["t", "v"],
  "properties": {
    "t": { "enum": ["hello", "hello-ok", "hello-err", "data", "broadcast",
                    "delivery", "ping", "pong", "error", "kicked", "bye"] },
    "v": { "const": 1 },
    "credential": { "type": "string", "pattern": "^rc_[A-Za-z0-9_-]{40,}$" },
    "deviceId": { "type": "string" },
    "sessionId": { "type": "string" },
    "protocolVersions": { "type": "array", "items": { "type": "integer" } },
    "appVersion": { "type": "string" },
    "to": { "type": ["string", "array"] },
    "from": { "type": "string" },
    "frame": { "type": "string" },
    "msgId": { "type": "string" },
    "status": { "enum": ["delivered", "offline", "overload"] },
    "code": { "type": "string" },
    "message": { "type": "string" },
    "reason": { "type": "string" },
    "serverTimeMs": { "type": "integer" },
    "ts": { "type": "integer" }
  }
}
```

**帧合法性校验（中继读帧时的处理管线）**：

```
读帧 → 长度检查（>1MiB → frame_too_large + 断链）
     → JSON 解析（失败 → protocol_error + 断链）
     → 字段白名单校验（未知 t / 缺必填 → protocol_error + 断链）
     → 状态机检查（握手期只允许 hello；活跃期禁止 hello；断开后忽略）
     → 语义检查（data 帧必须含 to；broadcast 帧 to 必须是 "*" 或数组）
```

**与 D3 信封的边界声明**：`data.frame` 对中继是**不透明字符串**——中继不解析其 JSON、不校验签名、不检查 schemaVersion。若未来 D3 协议演进（信封加字段/改版本），中继零改动；中继帧协议自身的演进（新增控制帧类型）走 `v` 版本协商（hello.protocolVersions）。

**二进制帧（大载荷）**：

```
二进制 WS 消息 = [2 字节 to 长度][to 字节][2 字节 from 长度][from 字节][payload 原始字节]
                └──── 8+ 字节定长路由头（中继解析）────┘└── 业务载荷（中继透传）──┘
约束：to/from 为 UTF-8 设备 id；payload ≤ 1 MiB - 头长
用途：文件浏览内容 / 终端输出批量 / 事件历史回放（对齐 D1 §3.6"大载荷用 Binary 帧"）
```

---

## 7. 数据模型

### 7.1 数据分布总览：**三处存储，各管各的**

| 存储 | 位置 | 内容 | 归属 |
|------|------|------|------|
| 账号域库 | 账号中心 SQLite（zennav.sqlite） | accounts / sessions / devices / **relay_credentials（新）** / **push_tokens（新）** / audit_logs | AC §6.3/6.4 |
| 中继运行时态 | 中继进程内存 | 连接表 / 在线表 / 限流记账 / verify 缓存 | 本方案 §4、§5.4 |
| 中继审计态 | 中继可选 SQLite（relay-audit.sqlite） | 连接事件元数据（无内容） | 本方案 §7.2 |

**关键决策：中继服务独立库（不共享账号中心 SQLite）。** 理由：

1. **依赖方向**：账号中心是唯一身份真相源；中继若写同一库，等于中继依赖账号中心的 DB 连接与 schema 版本，失去故障域隔离（§2.2 理由 2 的延伸）；
2. **读写模式**：账号中心是业务库（状态化、长查询），中继审计是纯追加写（append-only，高吞吐）——混库互相拖累；
3. **凭据校验**：中继**不需要**直接读 relay_credentials 表——经 verify API（§5.3），连表结构都不依赖，schema 演进零耦合。

### 7.2 中继侧表（仅运维审计，可选编译）

```sql
-- relay-audit.sqlite（中继侧可选；纯追加；TTL 7 天自动清理）
CREATE TABLE IF NOT EXISTS relay_sessions (
  session_id      TEXT PRIMARY KEY,             -- rel_<uuid>
  account_id      TEXT NOT NULL,                -- 冗余存储，仅元数据
  device_id       TEXT NOT NULL,
  app             TEXT NOT NULL DEFAULT 'crish',
  remote_ip       TEXT NOT NULL,                -- 对端公网 IP（仅握手时记录）
  connected_at    INTEGER NOT NULL,             -- epoch ms
  disconnected_at INTEGER,                      -- NULL = 仍在连接
  disconnect_reason TEXT,                       -- normal | timeout | kicked | protocol_error | overload | unauthorized
  bytes_up        INTEGER NOT NULL DEFAULT 0,   -- 该连接上行字节（不含控制帧？含，统计口径文档化）
  bytes_down      INTEGER NOT NULL DEFAULT 0,
  frames_up       INTEGER NOT NULL DEFAULT 0,
  frames_down     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_relay_sessions_account ON relay_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_relay_sessions_time ON relay_sessions(connected_at);
```

**隐私红线（表设计内置）**：本表**只存元数据**——无凭据、无消息内容、无 D3 信封片段。业务帧仅累计字节/帧计数，内容经协议层就丢弃。

**运行模式**：
- `RELAY_AUDIT_ENABLED=true`（默认 true）+ `RELAY_AUDIT_PATH=/data/relay-audit.sqlite`；
- 内存模式（`RELAY_AUDIT_ENABLED=false`）：审计进内存环形缓冲（保留最近 10000 条），便于无盘部署；
- 清理：每 24h 删除 `connected_at < now - 7 天` 的行。

### 7.3 账号中心侧表（引用 AC 设计，本方案只对齐契约）

**relay_credentials**（AC §6.4 表定义，本方案使用契约对齐）：

```sql
-- 账号中心 schema.ts 追加（AC §6.4，本方案引用）
CREATE TABLE IF NOT EXISTS relay_credentials (
  id              TEXT PRIMARY KEY,               -- rc_<uuid>
  account_id      TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  app            TEXT NOT NULL DEFAULT 'crish',
  credential_hash TEXT NOT NULL UNIQUE,           -- HMAC(credential, AUTH_TOKEN_SECRET)，明文不落库
  status          TEXT NOT NULL DEFAULT 'active', -- active | revoked | expired
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_creds_account ON relay_credentials(account_id, status);
```

**push_tokens**（AC §6.3 表定义，供 §8 引用）：

```sql
-- 账号中心 schema.ts 追加（AC §6.3，本方案引用）
CREATE TABLE IF NOT EXISTS push_tokens (
  id                  TEXT PRIMARY KEY,               -- pt_<uuid>
  account_id          TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  platform            TEXT NOT NULL,                  -- apns | hms | xiaomi | vivo | oppo | honor | fcm
  vendor_token        TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,           -- HMAC(vendor_token) 幂等/反查
  bundle_id           TEXT NOT NULL DEFAULT '',
  app                TEXT NOT NULL DEFAULT 'crish',
  status              TEXT NOT NULL DEFAULT 'active', -- active | unregistered | expired
  last_registered_at  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(account_id, device_id, platform, bundle_id)
);
```

**联动的撤销语义（AC §6.2 A3 定稿，中继侧的配合）**：
- `removeDevice`（账号中心）→ 撤销该设备全部会话 + push token 置 unregistered + **relay credential 置 revoked**；
- 中继侧：被撤销设备的新连接握手 → verify 拒绝（403）；已建立连接在缓存失效（≤5 分钟）后**不会主动断开**（连接级不轮询），但设备侧收到 403 后清凭据；**补充机制**：账号中心撤销时可经 service token 调用中继 `POST /v1/admin/revoke`（中继管理端点，§8.1），**立即踢出**该设备全部连接（可选增强，v1 建议实现——撤销即时性是安全需求，对齐 D1 §4.4"撤销后旧设备立即失去连接"）。

### 7.4 数据模型与其他子方案的关系

| 子方案 | 数据面 | 本方案的关系 |
|--------|--------|--------------|
| D2 桌面网关 | 桌面设备表（D3 §4.5 device_registry） | 两套设备概念并行：D3 设备表管"局域网配对"，账号中心设备表管"云身份"（AC §7.4 双轨说明），中继只认账号中心体系 |
| D7 推送 | push_tokens 表 + push-core | 中继不读 push_tokens；只提供在线状态（§4.3） |
| D5 安全 | 审计/威胁模型 | relay_sessions 审计与 D5 审计基线对齐；日志隐私红线 §9.2 |

---

## 8. API 面

### 8.1 中继服务端点清单

| 方法 | 路径 | 鉴权 | 语义 |
|------|------|------|------|
| WS | `/v1/ws` | relay credential（query `?token=` 或 hello 帧内） | 中继主连接（RelayLink）；帧协议见 §6.2 |
| GET | `/healthz` | 无 | 存活探针（进程级） |
| GET | `/readyz` | 无 | 就绪探针（含账号中心 verify 连通性 + 全局连接水位） |
| GET | `/metrics` | 内网/反代白名单 | Prometheus 文本格式指标（§9.1） |
| GET | `/v1/status/online` | x-auth-service-token | 在线状态查询：`?accountId=xxx` → 在线设备清单（含 appState）；供账号中心 A9 与会话列表合并、桌面 push-core 查询 |
| POST | `/v1/admin/revoke` | x-auth-service-token | 立即踢出指定设备连接（`{accountId, deviceId}`）；账号中心设备撤销时调用（§7.3 联动） |
| GET | `/v1/routing` | x-auth-service-token | 多地域：返回推荐副本 ID（`?accountId=` 哈希分片，§9.6）；单实例时固定返回自身 |

**WS 连接细节**：
- 路径：`wss://relay.crish.example/v1/ws?token=<credential>`；
- Origin 校验：拒绝浏览器跨站 WS（对齐 D2 §10.1 双保险惯例）；
- 握手后 10s 内必须发 hello 帧（含 credential 二次确认，防 query 参数被日志截获后的中间人复用——hello 帧内凭据与 query 凭据必须一致）；
- 连接协议版本：`v=1`（hello.protocolVersions 协商，不匹配 → hello-err）。

### 8.2 账号中心端点清单（新增模块，AC §6.4/6.3 契约，供集成方使用）

| 方法 | 路径 | 鉴权 | 语义 | 消费方 |
|------|------|------|------|--------|
| POST | `/api/relay/credentials` | Bearer | 签发中继凭据（一次返回明文） | 桌面/手机 |
| POST | `/api/relay/credentials/refresh` | Bearer | 凭据轮换（旧立即失效） | 桌面/手机（30 天临近时） |
| DELETE | `/api/relay/credentials/:id` | Bearer | 撤销本设备凭据 | 桌面/手机（登出） |
| GET | `/api/relay/verify` | x-auth-service-token | 凭据校验（中继调用，§5.3） | 中继服务 |
| POST | `/api/push/tokens` | Bearer | 推送令牌注册/更新（幂等） | 手机 |
| DELETE | `/api/push/tokens/:id` | Bearer | 推送解绑 | 手机（登出/卸载） |
| GET | `/api/push/tokens` | Bearer | 列本账号推送注册 | 桌面设备管理 UI |
| POST | `/api/devices/:id/trust` | Bearer | 设备信任审批（AC A4） | 桌面设置页 |

### 8.3 在线状态查询的两种消费路径

```
路径 A（桌面 push-core，推送节流）：
  桌面 push-core → GET /v1/status/online?accountId=xxx（service token，缓存 ≤ 5s）
  → 手机在线 → 直推（走中继）；离线 → 厂商通道（D7）

路径 B（账号中心设备管理 UI）：
  账号中心 GET /api/auth/sessions（AC A9 增强）→ 附加设备在线状态
  → 账号中心服务端调用中继 /v1/status/online（service token）合并返回
```

**为什么在线状态在中继而不在账号中心**：在线是连接级事实，中继是连接唯一真相源；账号中心不持有连接。账号中心把"设备是否在线"当作派生数据（查询时合并），不落库——避免双写漂移。

### 8.4 API 契约示例（关键三组）

**① 签发凭据（桌面/手机）**：

```http
POST /api/relay/credentials
Authorization: Bearer <access_token>
Content-Type: application/json

{ "deviceId": "dev-desktop-7b21", "app": "crish_desktop" }
```
```json
200 OK
{
  "credential": "rc_9f2k3j4h5g6f7d8s9a0z...",
  "credentialId": "rc_uuid",
  "expiresAt": 1785000000000,
  "ttlDays": 30
}
```

**② 中继握手（hello）**：

```json
{ "t": "hello", "v": 1, "credential": "rc_9f2k3j4h5g6f7d8s9a0z...",
  "deviceId": "dev-desktop-7b21", "protocolVersions": [1], "appVersion": "0.1.0" }
```
```json
{ "t": "hello-ok", "sessionId": "rel_01HZ...", "serverTimeMs": 1754000000000 }
```

**③ 转发（手机 → 桌面命令帧，payload 为 D3 信封原文）**：

```json
{ "t": "data", "to": "dev-desktop-7b21", "from": "dev-mobile-0f3a",
  "frame": "eyJ2IjoxLCJraW5kIjoiY21kLmFwcHJvdmUiLCJhdXRoIjp7fSwibm9uY2UiOiIxMjMifQ" }
```

---

## 9. 运维

### 9.1 监控

**指标面（/metrics，Prometheus 文本格式）**：

| 指标 | 类型 | 语义 |
|------|------|------|
| `relay_connections_active` | Gauge | 当前在线连接数（总/按账号/按设备角色） |
| `relay_connections_total` | Counter | 累计连接数（标签：result=success/unauthorized/timeout/...） |
| `relay_frames_up_total` / `relay_frames_down_total` | Counter | 帧计数（按会话汇总口径） |
| `relay_bytes_up_total` / `relay_bytes_down_total` | Counter | 字节计数（区分压缩前后，评估 deflate 收益） |
| `relay_bandwidth_limit_hits_total` | Counter | 令牌桶/聚合限速触发次数 |
| `relay_delivery_offline_total` | Counter | 离线投递失败次数（目标离线） |
| `relay_verify_requests_total` / `relay_verify_errors_total` | Counter | 账号中心 verify 调用与失败 |
| `relay_verify_cache_hits_total` | Counter | 缓存命中率（健康度：账号中心故障时命中率上升） |
| `relay_forward_latency_ms` | Histogram | 转发延迟（收到数据帧 → 入目标写队列，p50/p95/p99） |
| `relay_heartbeat_timeouts_total` | Counter | 心跳超时踢出数 |
| `relay_revoked_connections_total` | Counter | 凭据撤销踢出数 |

**告警规则（建议阈值，对齐 D1 P2 验收：p95 转发 < 1s）**：

| 告警 | 条件 | 等级 |
|------|------|------|
| 转发延迟劣化 | forward_latency p95 > 1s 持续 5 分钟 | warning |
| 凭据校验失败风暴 | verify_errors 5 分钟速率 > 100 | warning（可能账号中心故障或扫描） |
| 连接水位 | active > 80% 上限 | warning |
| 心跳超时异常 | 5 分钟 > 连接数的 10% | warning（客户端版本问题或网络抖动） |
| 带宽限速命中 | limit_hits 5 分钟 > 1000 | info（可能正常突发或滥用） |

### 9.2 日志与隐私红线

**铁律：中继日志绝不落消息内容。**

| 日志类别 | 记录内容 | 明确不记录 |
|----------|----------|------------|
| 连接事件 | 连接建立/断开、sessionId、deviceId、remote_ip、原因 | credential 明文、凭据哈希、设备公钥 |
| 鉴权事件 | verify 结果（通过/拒绝/过期/撤销）、缓存命中 | 业务载荷、D3 信封 |
| 转发统计 | 帧数/字节数（聚合口径） | 单帧内容、帧头 to/from 之外的可识别字段（to/from 属路由元数据，允许记录） |
| 错误 | 错误码、超时、限速触发 | 堆栈中的 payload 片段 |

**技术保障**：
- 业务帧在代码路径上**不经过任何日志宏**——转发热路径只累加计数器；
- data 帧的 payload 进入日志的唯一入口是显式的 debug 级开关 `RELAY_DEBUG_DUMP_FRAMES=false`（默认 false，生产禁止打开；打开时也只 dump 帧头）；
- 日志格式：结构化 JSON（tracing-subscriber json），字段白名单化，新增字段需 review；
- 审计表（§7.2）同理，只存元数据。

**为什么"IP 与设备标识可记"不算隐私问题**：这些是运维必需且不与业务内容关联；业务内容（消息正文）在中继侧以密文存在（§5.6），即使日志泄漏，泄漏的是密文与路由元数据，不是明文业务。

### 9.3 限流（滥用防护）

| 限流点 | 阈值（默认） | 行为 |
|--------|--------------|------|
| 每 IP 连接速率 | 10 次/分钟（`RELAY_CONNECT_RATE_IP`） | 超出 → 429 + 连接关闭 |
| 每 IP 并发连接 | 16 | 超出 → 拒绝（新连接） |
| 每账号并发连接 | 8（§4.6） | 超出 → 拒绝 + error(too_many_connections) |
| 每账号连接速率 | 1 次/秒（防重连风暴） | 超出 → 429 + 退避提示 |
| verify 失败计数 | 5 次/分钟/账号 → 封禁 15 分钟（临时） | 凭据暴力尝试防护（凭据 256bit 随机，实际防的是滥用） |
| 每连接帧速率 | 60 帧/秒（`RELAY_FRAME_RATE_PER_CONN`） | 超出 → error + 断开（慢速 DDoS） |
| 全局连接水位 | 上限 80% → 新连接排队（最长 5s） | 优雅过载，不拒绝风暴 |

**限流状态**：全部内存态（无 Redis）；单实例规模足够（个人/小团队 + 单账号 ≤ 8 端）。

### 9.4 DDoS 防护

| 攻击面 | 缓解 | 归属 |
|--------|------|------|
| TCP SYN/连接洪泛 | 反代层（Cloudflare 边缘过滤 / Caddy 防 SYN）+ 系统级（nofile/backlog 调优） | 反代 + 主机 |
| TLS 握手洪泛 | 反代层（证书预检、客户端认证可选）；中继层限速：握手期每 IP 并发 ≤ 32、握手超时 10s 快速释放 | 反代 + 中继 |
| WS 慢速消息（slowloris） | 帧间超时：读帧间隔 > 60s → 断开（`RELAY_READ_IDLE_MS`） | 中继 |
| 大帧洪泛 | 单帧 1 MiB 上限 + 令牌桶削峰（§6.3） | 中继 |
| 凭据爆破 | 256bit 随机凭据本身抗爆破 + verify 失败限流（§9.3） | 中继 + 账号中心 |
| 业务放大（广播风暴） | 账号聚合带宽限速（§6.3 L3）+ 广播接收方 ≤ 16（§4.5） | 中继 |
| 内存耗尽 | per-连接写队列有界（512 帧）+ 全局连接水位（8192）+ 审计表 TTL | 中继 |
| 账号中心打挂（verify 风暴） | 中继缓存（≤5min）+ 熔断（§5.4）——verify 只在握手时发生，正常握手率极低 | 中继 |

### 9.5 可观测性闭环与故障演练

- **账号中心不可用演练**：停账号中心 → 新连接拒绝（无缓存）/放行（有缓存）；已有连接不受影响；熔断生效；恢复后缓存自然过期。**P2 验收含此演练**。
- **中继重启演练**：所有连接断开 → 客户端指数退避重连（5s/15s/60s 封顶，D1 §3.7.2）→ 5 分钟内全量恢复；桌面 push-core 期间走厂商通道兜底。
- **背压演练**：单端断网（模拟）→ 目标离线 → delivery-offline → 发送方切换路径；恢复 → 游标追平。
- **备份**：中继无业务数据，审计 SQLite 定时备份（可选）；账号中心备份惯例沿用（AC §6.10）。

### 9.6 多地域（可选扩展，非 P2 必须）

**关键约束（转发面的物理事实）**：两端必须连到**同一实例**才能转发（无状态转发 + 无跨实例隧道）。多副本方案：

| 方案 | 说明 | 裁决 |
|------|------|------|
| 单实例 | P2 期默认；个人/小团队规模足够（对齐 AC §6.10"SQLite 单库即可支撑"同量级判断） | **采用（P2）** |
| 副本间隧道（mesh） | 实例间长连接互连，转发跨区可达 | 否决（P2）：复杂度高，收益低（个人场景） |
| **推荐副本哈希路由** | 客户端先 `GET /v1/routing?accountId=` → 返回副本 ID（按 accountId 哈希 + 负载）→ 连该副本；两端哈希一致自然落到同副本 | **远期采用（P3+ 若需多地域）** |
| 区域级 DNS 分流 | 按区域解析到就近副本；同一账号两端同区则同副本 | 远期辅助 |

**多地域的域内原则**：转发只发生在副本内部（不跨区）；跨区场景（桌面在家、手机在另一国家）由客户端"一起选同副本"解决——哈希路由天然保证同账号同副本。

### 9.7 容量规划与成本基线

| 规模 | 假设 | 资源 | 成本量级 |
|------|------|------|----------|
| 个人（1 账号，≤ 8 设备） | 桌面常驻 1 连接 + 手机 ≤ 3 连接；事件流量 < 10 MB/天 | 256 MB 内存 / 0.5 vCPU / 1GB 带宽 | 最低档 VPS（约 ¥20-50/月） |
| 小团队（≤ 50 账号） | 并发连接 ≤ 200；峰值带宽 2 MB/s | 512 MB / 1 vCPU / 100GB 流量 | 中档 VPS |
| 远期（多地域） | 按账号哈希分片到副本 | 每副本 512 MB / 1 vCPU | 线性扩展 |

**带宽成本估算（P2 典型使用）**：
- 事件流（文本 JSON + deflate 压缩 3-5x）：审批/状态事件平均 1-4 KB 压缩后——月流量 < 1 GB/账号（重度使用）；
- 命令面：低频，< 100 MB/月；
- 结论：个人场景月带宽成本可忽略（对齐 D1 §3.1.2"事件载荷多为文本 JSON，带宽可接受"）。

---

## 10. 与桌面端/手机端集成

### 10.1 桌面端（Hub）接入设计

**接入触发（何时连中继）**：

```
条件：① 用户配置了云账号且已登录；② 用户在设置中启用了"云中继"（默认开，随登录开启）
行为：桌面启动 → 登录态恢复 → 签发/取回 relay credential → 建立出站 RelayLink（常驻）
     局域网服务网关（D2）并行存在，互不干扰
```

**桌面连接生命周期**：

| 阶段 | 动作 |
|------|------|
| 启动 | 读 OS 凭据库 → 无凭据 → 调 /api/relay/credentials 签发（需 access token；token 过期 → refresh 轮换）→ 连中继 |
| 运行 | 常驻连接；事件扇出分支（D2 网关）把事件发往 RelayLink（与局域网扇出并行）；从 RelayLink 收手机命令帧 → 走桌面命令面（D2） |
| 掉线 | 指数退避重连（5s/15s/60s 封顶）；重连后按 D3 游标/订阅恢复；期间不丢业务（事件继续在本地，重连后追平） |
| 凭据过期 | 握手 403 → 静默刷新（/api/relay/credentials/refresh）→ 重连；刷新失败（如账号中心不可用）→ 保持离线重试，不打扰用户 |
| 登出 | DELETE /api/relay/credentials/:id + 断开 RelayLink + 撤销会话（AC §7.2 登出清单） |
| 设备撤销（他端操作） | 连接被踢（/v1/admin/revoke 或缓存失效）→ 提示用户设备状态变化 |

**桌面侧组件落位**（D2 范畴，本方案只定接口）：

```
apps/agent-workbench/src-tauri/src/
  md/relay/relay_link.rs      # RelayLink 客户端（出站 wss，与 LocalLink 同实现 Link trait，D1 §3.7）
  md/relay/credential.rs      # 凭据签发/刷新/存储（OS 凭据库）
  md/relay/reconnect.rs       # 指数退避重连状态机
```

### 10.2 手机端（Companion）接入设计

**接入触发（何时连中继）**：

```
条件：App 打开且已登录云账号；或用户显式配置了中继
行为：App 前台 → 先试 LocalLink（同局域网，D1 §3.7.2 决策表）→ 失败 → RelayLink 按需连接
     后台/被杀 → 断开（推送由厂商通道兜底，D7 §7.3）
```

**手机连接生命周期**：

| 阶段 | 动作 |
|------|------|
| 启动 | 读安全存储凭据 → 签发/取回 credential → 尝试 LocalLink（3s 超时）→ 失败 → 连中继 |
| 前台 | 保持 RelayLink；上报 appState=foreground；事件订阅/命令面经中继（D3 协议不变，换传输） |
| 切后台 | 发 appState=background → 保持心跳（省电节流：心跳 60s）→ 系统允许则保持 |
| 被杀/断网 | 连接断开；命令入本地队列（D1 §3.4）；重连按指数退避 + 网络变化事件触发 |
| 恢复前台 | 网络恢复 → 重连 → 订阅恢复（lastSequence 游标追平，D3 §7.5）→ 队列按序重发（幂等键去重） |
| 凭据过期/撤销 | 403 → 静默刷新；失败 → 提示重新登录 |

**手机端特别注意（与桌面的差异）**：
- 手机连接是**会话级**的（打开 App 才有），不是常驻——因此中继在线状态对手机的意义是"推送节流输入"（D7 §4.3-2），而不是"永在线"；
- 后台保活不做系统级长连接（国内 ROM 清杀现实，D7 §4.1 路线 A 缺点）——离线兜底职责交给厂商推送，中继不做保活承诺。

### 10.3 断线重连与恢复矩阵（两端共用策略）

| 断线原因 | 检测（端侧） | 重连策略 | 恢复语义 |
|----------|--------------|----------|----------|
| 网络瞬断 | WS close / 心跳超时 | 指数退避 5s/15s/60s 封顶 | 游标追平（D3 events.resume） |
| 中继重启 | 连接重置 | 同上 + 重试上限 10 次后提示 | 同上 |
| 账号中心短暂不可用 | 凭据刷新失败 | 保持退避重试，不打扰 | 恢复后自动重签 |
| 凭据被撤销 | 403（握手） | 停止自动重连 → 提示用户 | 用户重新登录/重新配对 |
| 连接被踢（重复登录/设备撤销） | kicked 帧 | 停止自动重连 → 提示 | 用户处理冲突设备 |
| 24h 强制重连 | server-closing 帧 | 静默立即重连 | 无感（新会话 + 游标） |

### 10.4 端到端加密在 RelayLink 的落地（与 D3 的关系）

- RelayLink 上的每帧 = D3 DeviceEnvelope（含 auth HMAC 签名 + 可选 AEAD 密文）；
- **机密性**：中继链路必须应用层加密（D1 §4.2 裁决）——desktop↔mobile 的 enc_key 来自配对期派生（D3 §4.4），此密钥**与中继无关**；
- **完整性/防重放**：D3 §5.1 的设备令牌 HMAC + nonce 窗口——中继看不到、不校验（L2 层）；
- **配对期交换的密钥只走局域网**（D3 配对协议在 LocalLink 完成）——中继**永远不参与配对**；跨网新手机首次配对走"桌面二维码 → 手机浏览器（经账号中心/HTTPS）"带外流（AC §7.3 扫码登录），不走中继业务面。

### 10.5 推送与中继的协作边界（D7 对齐）

```
事件产生（桌面引擎）
   → push-core 策略引擎（D7：去重/合并/静默/节流）
       ├─ 手机在线（中继在线表，§4.3）→ 直推 RelayLink（全量结构化载荷）
       ├─ 手机离线 → 厂商通道（HMS/APNs/小米…，摘要级载荷，D7 §6.2 schema）
       └─ 审批类 → 重推阶梯（D7 §3.3 S1）
中继的角色：① 在线直推的传输通道；② 在线状态来源（节流输入）
中继不做的：厂商通道调用、推送决策、token 管理（账号中心 push_tokens）
```

### 10.6 与 AC §7 集成表的映射（账号侧流程逐项落地）

AC §7.2/§7.3 定义了桌面端/手机端接入账号中心的流程表，本方案的落地映射：

| AC 流程 | 账号中心机制 | 中继侧配合（本方案） |
|---------|--------------|----------------------|
| 首次云登录（桌面） | desktop-auth request + exchange | 无（登录不经过中继） |
| 中继注册（桌面） | POST /api/relay/credentials | 拿到凭据 → 连 /v1/ws（§10.1 启动流程） |
| 推送发送（桌面） | push_tokens 查询接口 | 在线判定查询 /v1/status/online（§8.3 路径 A） |
| 设备管理（桌面） | GET /api/devices + /api/auth/sessions（A9 增强） | 在线状态合并（§8.3 路径 B） |
| 登出（桌面/手机） | DELETE relay credential + push 解绑 + logout | 断开 RelayLink + 本地清凭据 |
| 手机云登录 | App 内邮箱登录 | 无（登录不经过中继） |
| 手机中继连接 | relay credential（与桌面同账号不同设备） | /v1/ws 按需连接（§10.2） |
| 手机接收推送 | push_tokens | 在线时直推；离线时厂商通道（§10.5） |

**凭据存储决策表（AC §7.5 对齐）**：

| 凭据 | 桌面端 | 手机端 | 中继服务 |
|------|--------|--------|----------|
| 账号 access token | 内存 + OS 凭据库 | Keychain/Keystore | 无 |
| 账号 refresh token | OS 凭据库（不落盘明文） | Keychain/Keystore | 无 |
| **中继凭据** | OS 凭据库（签发后即存，明文只在内存） | Keychain/Keystore | 只存 HMAC 校验态（经账号中心 verify） |
| 设备 Ed25519 私钥（D3 配对） | app_dir()/identity | 安全存储 | 无 |
| 厂商推送凭据 | 桌面发送器持（OS 凭据库） | 不持 | 无 |

---

## 11. 测试

### 11.1 测试分层与门禁

| 层 | 形态 | 门禁 |
|----|------|------|
| 单元测试 | `cargo test`（crates/relay 内，纯逻辑与 IO 解耦，对齐 D1 §8.4 纪律） | 快层，`cargo test --workspace` |
| 集成测试 | `cargo test --test integration`（真实 tokio-tungstenite 客户端 + 账号中心 mock） | 中层 |
| 端到端 | Python/Rust 脚本：账号中心测试实例 + 中继 + 双端模拟（对齐 AC §6.7 联调脚本） | 验收门禁 |
| 压测 | `cargo test --release --test load_tests -- --ignored`（对齐 D1 §8.4 release + --ignored 惯例） | P2 验收 |

### 11.2 单元测试清单（认证）

| 用例 | 断言 |
|------|------|
| 凭据缺失（无 query 无 hello 凭据） | 握手拒绝（hello-err unauthorized） |
| 凭据无效（格式错误/非 rc_ 前缀） | 拒绝 + 不触发账号中心调用 |
| 凭据未注册（账号中心 verify 返回 invalid） | 拒绝 + 缓存负面结果（60s） |
| 凭据已撤销（verify 返回 revoked） | 拒绝 + 审计记 revoked |
| 凭据已过期（expiresAt < now） | 拒绝（relay.credential_expired，客户端应刷新重试） |
| 凭据有效（verify 200） | 握手成功 + 连接表注册 + verify 只调一次（缓存） |
| 缓存命中（同一凭据二次握手 5 分钟内） | 不调账号中心 |
| 缓存过期（>5min） | 重新调 verify |
| 账号中心不可达（超时）且有缓存 | 放行（降级） |
| 账号中心不可达且无缓存 | 拒绝（service-unavailable，客户端可重试） |
| 熔断（连续 10 次失败） | 30s 内不再发起 verify 调用 |
| 重放（verify 请求 nonce 重用） | 账号中心拒绝（AC 侧测试，中继侧断言不传固定 nonce） |

### 11.3 单元测试清单（路由与授权）

| 用例 | 断言 |
|------|------|
| 同账号 hub → companion 转发 | 目标连接收到帧（字节一致） |
| 同账号 companion → hub 转发 | 目标连接收到帧 |
| 跨账号转发 | 拒绝（relay.forbidden）+ 目标不收到 |
| companion → companion | 拒绝 |
| hub → hub（同账号两台桌面） | 拒绝 |
| 广播（to="*"）| 同账号全部在线 companion 各收到一份；hub 不收到 |
| 广播上限（>16 接收方） | 拒绝广播帧 |
| 目标离线 | 回 delivery-offline；发送方无队列滞留 |
| 目标背压满 | 回 delivery: overload + 目标连接被断开 |
| 重复连接（同设备二次握手） | 旧连接 kicked(duplicate-connection)，新连接存活 |
| 每账号并发 >8 | 拒绝 + error(too_many_connections) |
| 帧大小 >1 MiB | error(frame_too_large) + 断链 |
| 控制帧协议版本不匹配 | hello-err + 断链 |

### 11.4 集成测试清单（真实 WS 双端）

```
集成测试拓扑：中继实例（临时端口）+ 账号中心 mock（或测试实例）+ 两个模拟端
  sim-hub（模拟桌面）：登录 → 签发凭据 → 连中继（常驻）
  sim-mobile（模拟手机）：登录 → 签发凭据 → 连中继
```

| 场景 | 步骤 | 断言 |
|------|------|------|
| 双端转发回环 | mobile 发 data → hub 收 → hub 回 data → mobile 收 | 双向字节一致；往返 < 100ms（本机） |
| 认证拒绝 | 伪造凭据连接 | 403 语义；审计记 unauthorized |
| 撤销即时性 | 账号中心撤销设备 → 调 /v1/admin/revoke | 该设备连接 ≤ 1s 内被踢（kicked(revoked)） |
| 断线重连 | hub 断开 → 按退避重连 | 重连后广播补投（若启 retain 缓冲）或游标追平（协议层） |
| 带宽限制 | 配置 64 KB/s → hub 发 1 MB | 传输耗时 > 15s；无丢帧 |
| 心跳超时 | 客户端停止 pong | 90s 内被踢（timeout） |
| 账号中心宕机 | 停 mock → 新连接（有缓存）放行 /（无缓存）拒绝 | 已有连接不断 |
| 在线状态 | mobile 连/断 | /v1/status/online 反映在线/离线；appState 透传 |
| 压缩 | 发 1 MB 重复 JSON 文本 | 传输字节 < 30%（deflate 生效） |

### 11.5 端到端验收（对齐 D1 §8.2 P2 验收标准）

| # | 验收项 | 标准 |
|---|--------|------|
| 1 | 跨网审批延迟 | 手机 4G/5G（异地）完成审批 < 3s |
| 2 | 双链路回退 | 中继宕机 → 局域网直连可用；局域网断 → 中继兜底（自动切换 + 游标追平） |
| 3 | 端到端加密验证 | 中继日志/抓包无业务明文（§9.2 红线 + §5.6 密文验证） |
| 4 | 并发压测 | 8 端并发连接：事件延迟 p95 < 1s，无丢 Critical 事件（对齐 D1 P2 验收 4） |
| 5 | 离线矩阵 | 桌面离线 → 手机"Hub 离线"展示正确 + 命令挂起（D1 §3.4 矩阵） |
| 6 | 隐私审计 | 中继审计表/日志不含任何 payload 片段（自动化断言：grep 业务样例串） |

### 11.6 测试基建与依赖

- 账号中心 mock：`axum` 起的假 /api/relay/verify（可控状态：valid/invalid/revoked/timeout/5xx），用于集成测试确定性；
- 联调脚本：对齐 AC §6.7（起账号中心测试实例 → 签发凭据 → 中继握手 → 双端转发回环）；
- 回归保障：crates/relay 加入 workspace，`cargo test --workspace` 全绿才可提交（AGENTS.md 铁律）；不引入 npm 门禁变化。

---

## 12. 里程碑、工作量与风险

### 12.1 里程碑（对齐 AC §8 M4 并细化）

| 阶段 | 内容 | 工作量（人日） | 验收 |
|------|------|----------------|------|
| R1 骨架 | crate 初始化 + 配置 + axum 装配 + /healthz + WS 空壳 | 1 | cargo test 绿；可 docker 起 |
| R2 认证 | 握手状态机 + verify 客户端 + 缓存 + 熔断（§5.4） | 2 | §11.2 认证单测全绿 |
| R3 转发 | 连接表 + 路由 + 授权矩阵 + 广播 + 背压（§4、§6） | 2 | §11.3 路由单测全绿 |
| R4 控制面 | 心跳/超时/限流/带宽/压缩/审计（§6.3、§9） | 2 | §11.4 集成全绿 |
| R5 联调 | 账号中心 relay_credentials 模块联调 + E2E 脚本（AC M3/M4 依赖） | 2 | §11.5 验收 1-6 |
| R6 运维面 | /metrics + 告警规则 + Dockerfile + 部署文档 | 1 | 演练通过（§9.5） |

合计 **约 10 人日**（不含账号中心侧 M2/M3 模块约 8 人日，AC §8 已计）。依赖：账号中心 `relay_credentials` 模块（AC §8 M3）先行或并行（R2 可用 mock 先行）。

### 12.2 风险清单

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | 账号中心可用性耦合（verify 依赖） | 中 | 缓存 ≤5min + 熔断 + 已有连接不受影响（§5.4）；铁律：中继是可选组件（D1 §3.4） |
| 2 | 带宽滥用（单账号广播风暴） | 中 | 三层限速（§6.3）+ 广播上限（§4.5）+ 审计告警（§9.1） |
| 3 | 隐私合规（事件内容过云） | 中 | 端到端 AEAD（§5.6）+ 日志零内容红线（§9.2）+ D1 §8.3 非目标 5 |
| 4 | 国内部署合规（域名备案，D7 §4.1 路线 C 缺点） | 中 | 跟随 flowbit 既有域名体系（AC §3.7）；中继域名独立备案或复用已备案域名子域 |
| 5 | 转发面与账号中心版本漂移（AC 侧 22 模块迭代） | 低 | 以 API 契约为边界（§8.2 端点清单）+ 中继连表结构都不依赖（§7.1） |
| 6 | 多副本时跨区转发不可达 | 低（远期） | 哈希路由（§9.6）保证同账号同副本；单实例 P2 无此问题 |
| 7 | 慢客户端拖垮发送方 | 中 | per-接收连接独立队列 + 有界 + 超限断开（§4.5 背压） |
| 8 | 客户端重连风暴（中继重启后） | 中 | 指数退避（§10.3）+ 全局连接水位排队（§9.3） |

### 12.3 开放问题

| # | 问题 | 倾向裁决 | 待定 |
|---|------|----------|------|
| 1 | 在线状态是否广播给端侧（在线变化事件） | 不做主动广播，靠查询（§8.3 路径 A/B）；广播列为增强 | 若端侧 UI 需要实时在线指示，改为订阅制（二期） |
| 2 | 短窗缓冲（retain）是否实现 | v1 不做（§6.4） | 视手机切网重连体验反馈定 |
| 3 | UDP 打洞端点是否在 P2 后立即做 | P4（§2.4） | M3 出 P2P 细节后评审 |
| 4 | 中继域名归属（crish 自购 vs flowbit 子域） | 跟随 AC §6.8（优先复用生产实例与域名惯例） | 用户决策 |

---

## 13. 附录

### 13.1 术语表

| 术语 | 含义 |
|------|------|
| Hub / Companion | 桌面主端（权威）/ 手机伴侣端（只读投影 + 受控命令），D1 §2.1 |
| RelayLink | 经云中继的出站 wss 链路（桌面/手机均出站），D1 §3.7 |
| LocalLink | 局域网 TLS WS 直连链路，D1 §3.7 |
| relay credential | 账号中心签发的短时中继连接凭据（rc_ 前缀），AC §6.4 |
| DeviceEnvelope | D3 协议消息信封（v/kind/msgId/ts/auth/body），D3 §5.3 |
| verify | 账号中心凭据校验接口（/api/relay/verify），AC §6.4 |
| delivery-offline | 中继投递反馈：目标离线，中继零队列（§6.4） |
| permessage-deflate | WebSocket 压缩扩展（RFC 7692），§6.3 |

### 13.2 参考与上游锚点索引

| 事实/裁决 | 来源 |
|-----------|------|
| 中继角色定义（只转发不解密、无业务状态、可选在线状态/推送适配） | `D1-overall-architecture.md` §3.3 |
| 双链路回退策略（LocalLink ↔ RelayLink） | `D1-overall-architecture.md` §3.7.2 |
| 中继链路必须应用层设备级加密 | `D1-overall-architecture.md` §4.2 |
| P2 云中继阶段验收（4G 审批 <3s、8 端 p95 <1s、日志无明文） | `D1-overall-architecture.md` §8.2 |
| 桌面出站 RelayLink（唯一主动出站场景） | `D1-overall-architecture.md` §2.2.1 |
| WS 帧协议草案与事件推送面 | `D2-desktop-serverification.md` §4.5a、§10 |
| D3 信封 / 设备级 HMAC / 重放防护 / 帧大小 1 MiB | `D3-protocol.md` §5、§6.2 |
| 中继凭据模块（表 + 4 端点）与独立 Rust 中继裁决 | `AC-account-center-evaluation.md` §6.4 |
| 推送注册表 push_tokens（表 + 端点） | `AC-account-center-evaluation.md` §6.3 |
| 设备↔会话↔推送↔中继联动撤销 | `AC-account-center-evaluation.md` §6.2 A3 |
| 推送路线 C 定位（M3 可选演进；注册表在账号中心、发送器在桌面） | `D7-push-notifications.md` §4.1/§4.2 |
| 在线判定与节流决策（appState 上报） | `D7-push-notifications.md` §4.3 |
| axum 0.8 WS 面基于 tokio-tungstenite 0.29（选型事实） | docs.rs axum 0.8.9 `extract::ws` |
| flowbit 部署/域名/TLS 惯例 | `AC-account-center-evaluation.md` §3.7、§6.10 |

### 13.3 中继配置项汇总（env，草案）

| 配置 | 默认 | 说明 |
|------|------|------|
| `RELAY_BIND` | `0.0.0.0:8080` | HTTP/WS 监听 |
| `RELAY_METRICS_BIND` | `127.0.0.1:9090` | 指标监听（内网） |
| `ACCOUNT_CENTER_BASE` | `https://auth.flowbit.me/api` | 账号中心 base（verify 调用） |
| `ACCOUNT_CENTER_SERVICE_TOKEN` | — | 服务间令牌（x-auth-service-token） |
| `RELAY_VERIFY_CACHE_TTL` | 300s | verify 结果缓存 |
| `RELAY_VERIFY_CIRCUIT_BREAK` | 10 次/30s | 熔断阈值 |
| `RELAY_HEARTBEAT_INTERVAL` / `RELAY_HEARTBEAT_MAX_MISSED` | 30s / 3 | 心跳 |
| `RELAY_HANDSHAKE_TIMEOUT` | 10s | 握手超时 |
| `RELAY_MAX_FRAME_BYTES` | 1048576 | 帧上限（对齐 D3） |
| `RELAY_TOKEN_BUCKET_RATE` | 524288 | 每连接字节/秒 |
| `RELAY_TOKEN_BUCKET_BURST` | 1048576 | 突发容量 |
| `RELAY_ACCOUNT_BANDWIDTH_LIMIT` | 5242880 | 每账号聚合字节/秒 |
| `RELAY_MAX_CONN_PER_ACCOUNT` / `_DEVICE` / `_IP` | 8 / 1 / 16 | 并发上限 |
| `RELAY_COMPRESSION` | on | permessage-deflate |
| `RELAY_AUDIT_ENABLED` / `RELAY_AUDIT_PATH` | true / `/data/relay-audit.sqlite` | 审计 |
| `RELAY_AUDIT_TTL_DAYS` | 7 | 审计清理 |
| `RELAY_SESSION_MAX_AGE` | 86400s | 单连接寿命上限 |
| `RELAY_LOG_LEVEL` | info | 日志级别 |
| `RELAY_DEBUG_DUMP_FRAMES` | false | 调试开关（生产禁止） |

### 13.4 一句话总结

**中继服务边界 = 只转发不解密（凭据校验 + 定向转发 + 在线状态，零业务存储）；凭证流 = 账号中心签发短时 relay credential（HMAC 存储、verify 校验、中继缓存降级）；转发语义 = 帧级透传（控制帧最少量解析，业务载荷原样透传、端到端 AEAD，零队列 + 令牌桶限速 + deflate 压缩）。**
