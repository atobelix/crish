# D5 多端互通安全模型设计（威胁分析 + 分层防护）

- **文档编号**：D5
- **状态**：草案（待评审）
- **日期**：2026-08-09
- **作者**：子代理 D5（多端安全模型设计）
- **范围**：crish 多端互通（桌面端被移动端远程控制）的完整安全模型
- **约束**：本会话未读 `reference/**`、`apps/crish-mobile/**`、`docs/**`；移动端侧实现细节
  假定与本文档对偶（移动端是本设计的第一类对手方，实现时须以本模型为契约）
- **代码证据**：全部引用为当前分支（refactor/architecture）实测行号；行号随代码演进可能漂移，
  以符号名 + 行号为双索引复核

---

## 目录

- [0 执行摘要](#0-执行摘要)
- [1 威胁模型](#1-威胁模型)
- [2 传输安全](#2-传输安全)
- [3 认证与会话](#3-认证与会话)
- [4 授权模型](#4-授权模型)
- [5 密钥管理](#5-密钥管理)
- [6 审计](#6-审计)
- [7 拒绝服务与滥用](#7-拒绝服务与滥用)
- [8 与现有代码融合](#8-与现有代码融合)
- [9 安全测试](#9-安全测试)
- [10 设计决策记录与开放问题](#10-设计决策记录与开放问题)
- [附录 A 术语表](#附录-a-术语表)
- [附录 B 代码位置索引](#附录-b-代码位置索引)

---

## 0 执行摘要

### 0.1 结论先行

多端互通的安全本质是：**把桌面端这台「持有 API keys、可执行命令、可写文件」的机器，
以最小权限原则暴露给移动端**。最大威胁不是传输窃听，而是**持机攻击**（拿到配对令牌的
手机 = 拿到一台无人值守终端的部分控制权）与**伪造端**（局域网内冒充受信任设备）。

核心设计决策（详细论证见各章）：

| 编号 | 决策 | 一句话理由 |
|------|------|-----------|
| D-01 | 服务默认关闭，`multi_device.enabled` 显式开启 | 对齐 `dev_mcp.rs:22` 的 `CRISH_MCP_SOCKET=1` 先例，零默认暴露面 |
| D-02 | 传输强制 wss（TLS），禁 ws 明文；自签 CA + 首次配对固定 CA 指纹（pinning） | 局域网 ARP/伪造端无法冒充；pinning 使系统 CA 体系完全不参与 |
| D-03 | 配对码 = **D3 §4.1 CXN-XXXX-XXXX-XXXX（12 字符 base32、60 bit）+ 限 5 次 + 10 分钟过期 + 一次性**【裁决修正 1：原 8 字符 base32 规格作废，对齐 D3 唯一真源】 | 暴力破解代价 2^60，配失败锁定后实际不可穷举 |
| D-04 | 设备令牌 256 bit 随机；桌面端只存 `sha256(salt‖token)`；默认 30 天过期 + 可撤销【裁决修正 10：令牌形态以 M7 §4.2 四类令牌分治为准——本节描述的是「配对令牌本地形态」的哈希存储纪律；跨云令牌（账号 token/中继凭据/推送注册）不在此列，见 M7 §4】 | 令牌数据库泄露不泄露可用令牌；撤销是持机攻击的第一响应 |
| D-05 | 移动端能力分级 observe / approve / operate，**无 admin**；权限模式远程上限 = ask | 远程场景禁止 full-access 与配置面，从结构上消灭提权目标 |
| D-06 | 移动端通过「发起 run + 审批裁决」间接操作文件，不暴露文件/终端/密钥命令面 | 复用既有引擎权限面（`permission.rs` 三态 + 红线不可豁免），最小权限自然成立 |
| D-07 | 危险操作双轨裁决：移动端确认 + 桌面端在场时二次确认；红线一律拒绝 | 桌面端本地用户是最后的可信裁决者 |
| D-08 | Provider API keys **永不出桌面**；远程命令白名单显式排除 `config_secret_*`，且命令级再加 `remote_source` 拒绝分支 | 纵深防御：即使白名单被绕过，密钥命令自身也拒绝远程来源 |
| D-09 | 远程操作全部入审计：复用 `security-audit` 事件面 + 新增 `Remote*` 操作类别；令牌/配对码日志恒打码 | 审计是「谁用什么设备在何时做了什么」的唯一账本 |
| D-10 | 连接数/速率/失败锁定齐备：**每设备一主连接 + 会话级多流（连接族 ≤3）**、总 ≤8；握手 5 次/分/IP；配对失败锁定【裁决修正 3：原「每设备 ≤2 连接」更新为 M3 §7.5.4 连接族语义——同 kind 重复连接踢旧，不同 kind 同设备共存 ≤3】 | 局域网内洪水与暴力破解在会话层被截断 |
| D-11 | 远程命令面走**独立白名单注册表**（对偶 `command_manifest.rs` 机制），不经 Tauri IPC | 远程通道与 webview 通道物理隔离，各自独立授权 |

### 0.2 防护纵深总览

```text
第 1 层  服务开关     multi_device.enabled=false 默认关闭（D-01）
第 2 层  传输         wss 强制 + 自签 CA pinning（D-02）
第 3 层  配对         一次性码 + 限次 + 过期（D-03）
第 4 层  令牌         256bit 随机 + 哈希存储 + 过期 + 撤销（D-04）
第 5 层  授权         能力分级 + 权限模式上限 ask + 红线拒绝（D-05/D-06/D-07）
第 6 层  密钥         Provider key 不出桌面 + 远程来源拒绝（D-08）
第 7 层  审计         全部远程动作入账 + 打码（D-09）
第 8 层  抗滥用       连接/速率/失败锁定（D-10）
第 9 层  隔离         远程白名单命令面，独立于 IPC（D-11）
```

### 0.3 与现有代码的三大融合点（详见第 8 章）

1. **审批状态机**：`Arbiter` 枚举（`session-loop/src/approval_router.rs:74`）扩展 `Remote` 变体；
   `ApprovalGateImpl`（`apps/agent-workbench/src-tauri/src/core_run_commands.rs:161`）的
   `request_approval` 广播路径复用，裁决入口复用 `resolve`（`:230`）与 pending 集合校验。
2. **权限引擎**：`PermissionMode`（`crates/agent-tools/src/permission.rs:19`）保持三态不变，
   远程通道在 run 装配点强制 `min(requested, Ask)`；红线语义（`:96` `decide_with_redline`）
   原样作用于远程 run，远程来源不得豁免。
3. **审计与打码**：`SecurityAuditOperation`（`crates/conex-types/src/events.rs:66`）新增
   `remote-*` 变体；`security_audit_event` 构造器（`crates/agent-tools/src/audit.rs:109`）
   复用；打码沿 K-05（`config/credentials.rs:256` 只记 last4）与
   `redact_url_query`（`crates/conex-browser-tools/src/helpers.rs:204`）先例，新增
   `conex-telemetry/src/redact.rs` 承载令牌/配对码打码工具。

### 0.4 本方案不做的事（显式非目标）

- 不做公网中继服务器（relay/push 由移动端侧另行设计，本模型只约束局域网直连面；
  中继面的 TLS 终止与端到端加密留待 relay 方案，但令牌/授权/审计契约本模型先行冻结）。
- 不做移动端代码审计（`apps/crish-mobile` 目录当前不存在——已按 R2A 裁决删除，
  为**待新建**工程；本模型是移动端的安全契约）。
- 不做生物识别门禁的强制实现（列为 P2 增强，见 §10.4）。

---

## 1 威胁模型

### 1.1 资产清单

按「越难恢复、越不可替代 = 越重要」排序。资产是攻击者最终想要的东西，防护设计围绕
资产完整性展开。

| 资产编号 | 资产 | 位置（现状代码） | 敏感性 | 泄密后果 |
|----------|------|------------------|--------|----------|
| A-01 | Provider API keys（DeepSeek 等） | `config_dir()/secrets/{id}.dpapi`（`config/credentials.rs:31` CredentialStore + DPAPI 加密，`:405`） | 极高 | 密钥被滥用产生账单/数据外流；不可召回（只能轮换） |
| A-02 | 多端设备令牌（本设计新增） | 桌面端 DPAPI 槽（复用 CredentialStore 形态）；移动端 Keychain/Keystore | 高 | 持机者获得远程控制通道 |
| A-03 | 审批权（ApprovalGate） | `core_run_commands.rs:161` pending 集合 + `core_approve_tool/deny_tool`（`:3750/:3777`） | 高 | 攻击者批准自己发起的危险操作 |
| A-04 | 终端执行面（shell 工具/PTY/后台任务） | `crates/conex-sandbox` gatekeeper + `pty/` + `background.rs` | 高 | 任意命令执行 |
| A-05 | 文件读写面（工作区文件） | `fs_commands/`、agent-tools `write_paths.rs` 写路径策略 | 高 | 数据泄露/被删 |
| A-06 | 会话数据（对话历史/快照/事件库） | `app_dir()/sessions.db`（`main.rs:13` LocalDb） | 中高 | 隐私泄露（提示词、代码、密钥可能出现在对话文本） |
| A-07 | 审计账本（security-audit 事件） | events 表 + 结构化日志（`audit.rs:23` sink 链） | 中 | 攻击者抹除痕迹后无法追责 |
| A-08 | 认证物料：配对码、CA 私钥、设备指纹 | 配对会话内存态 / 桌面端配置目录 | 高 | 伪造设备入网 |
| A-09 | 桌面端本地 UI 会话（webview 已登录态） | 进程内存 | 中高 | 本地攻击者可借壳执行任意 tauri 命令 |

### 1.2 攻击者画像

| 画像编号 | 攻击者 | 能力假设 | 动机 | 攻击面 |
|----------|--------|----------|------|--------|
| T-01 持机者（失窃/失联手机持有者） | 拿到已配对移动设备或其中令牌 | 好奇心/恶意 | 滥用移动端已授权通道；盗取桌面数据 |
| T-02 网络窃听者 | 局域网内被动嗅探（同一 Wi-Fi） | 被动监听 | 抓取明文/弱加密流量 |
| T-03 网络中间人 | 局域网内 ARP 欺骗/伪造 Wi-Fi AP/恶意路由器 | 主动劫持 | 窃取认证物料、注入命令 |
| T-04 伪造端 | 能写代码/能装 app 的开发者或自动化脚本，联网 | 冒充受信任设备 | 绕过授权执行远程命令 |
| T-05 恶意服务器/恶意中继 | 控制域名、公网服务器 | 窃取流量与凭证 | 未来中继面（现约束为不可信域） |
| T-06 本地进程攻击者 | 与桌面端同机运行的恶意进程/恶意脚本 | 读配置目录、读日志、调本地服务 | 窃取令牌/CA 私钥/密钥 |
| T-07 桌面端离席用户 | 同事/家人在桌面解锁状态下 | 无恶意但会误操作 | 误批准远程请求、泄露审批内容 |
| T-08 恶意移动端 App（被篡改的 crish 移动端） | 持有合法令牌但运行恶意逻辑 | 数据外传 | 把桌面事件流/审批载荷回传 |

**威胁排序结论**：最高优先级是 T-04（伪造端）+ T-01（持机者）的组合——它们直接威胁
A-03/A-04/A-05；其次是 T-03（中间人）威胁 A-08/A-01 的传输面；T-06（本地进程）是
新增的多端面特有风险（令牌落盘必须加密）。

### 1.3 威胁列表（STRIDE 映射）

对资产 A-01~A-09 与画像 T-01~T-08 交叉，得到威胁清单。每条威胁都给出**缓解机制编号**
（对应第 2~7 章的防护节，M-xx）。

| 威胁编号 | STRIDE 类别 | 威胁描述 | 受影响资产 | 主要缓解 |
|----------|-------------|----------|------------|----------|
| TH-01 | Spoofing | 伪造端冒充已配对设备发起命令 | A-03/A-04/A-05 | M-PAIR（配对码）、M-TOKEN（令牌）、M-CERT（证书 pinning） |
| TH-02 | Spoofing | 攻击者重放截获的配对码/令牌 | A-08 | M-PAIR（一次性+过期）、M-TOKEN（哈希存储+会话绑定）、M-RATE（失败锁定） |
| TH-03 | Spoofing | 中间人伪造桌面端证书（ARP + 伪造 CA） | A-01/A-08 | M-CERT（自签 CA pinning，系统 CA 不参与） |
| TH-04 | Tampering | 中间人改写/注入 ws 帧（若允许明文 ws） | A-02/A-03/A-06 | M-CERT（wss 强制，禁 ws 降级） |
| TH-05 | Tampering | 恶意移动端篡改审批载荷（把 Denied 改成 Approved） | A-03 | M-AUTH（通道认证+完整帧）、M-GATE（pending 集合校验 + 审计 actor） |
| TH-06 | Tampering | 持机者修改移动端本地存储的令牌/权限配置 | A-02 | M-TOKEN（移动端系统密钥库）、M-AUTH（服务端权威校验） |
| TH-07 | Repudiation | 远程危险操作后无痕（否认自己批准过） | A-07 | M-AUDIT（全部远程动作入账，含 actor=deviceId） |
| TH-08 | Information Disclosure | 窃听局域网流量获取会话内容/审批参数 | A-06 | M-CERT（wss 全帧加密） |
| TH-09 | Information Disclosure | 日志中泄露令牌/配对码明文 | A-08/A-02 | M-REDACT（打码铁律，K-05 先例） |
| TH-10 | Information Disclosure | 移动端读到 Provider API key 明文 | A-01 | M-KEY（永不出桌面 + remote_source 拒绝 + 白名单排除） |
| TH-11 | Elevation of Privilege | 移动端调用桌面端 config_secret_reveal 等敏感命令 | A-01/A-09 | M-REG（远程白名单）、M-KEY（命令级拒绝） |
| TH-12 | Elevation of Privilege | 移动端远程指定 full-access 权限模式绕过审批 | A-03/A-04 | M-MODE（远程上限 ask） |
| TH-13 | Elevation of Privilege | 移动端伪造 approval-resolved 事件（绕过 pending 校验直接批准） | A-03 | M-GATE（resolve 的 NotFound 校验，`core_run_commands.rs:230-245`） |
| TH-14 | Denial of Service | 局域网内连接洪水打满连接数/占住握手队列 | A-09（服务可用性） | M-LIMIT（连接数/速率限制） |
| TH-15 | Denial of Service | 配对码暴力穷举 | A-08 | M-PAIR（限 5 次 + 锁定）、M-RATE |
| TH-16 | Denial of Service | 超长帧/慢速攻击拖垮解析循环 | A-09 | M-LIMIT（帧大小/读超时） |
| TH-17 | Elevation of Privilege | 已撤销设备用旧令牌重连（撤销不及时） | A-02 | M-REVOKE（撤销即时生效 + 强制断开） |
| TH-18 | Elevation of Privilege | 桌面端本地进程读取令牌文件/CA 私钥 | A-08/A-02 | M-TOKEN（DPAPI 加密）、M-KEY（权限位） |
| TH-19 | Spoofing | 二维码中携带恶意服务器地址（QR 钓鱼） | A-08 | M-PAIR（QR 含 CA 指纹，离线信道校验）+ 桌面端配对页醒目提示 |
| TH-20 | Repudiation | 移动端对桌面端审批请求静默不响应，拖到 Expired 后重发（操作者假装无响应） | A-07 | M-AUDIT（approval-requested/resolved 全落库）+ M-SESSION（心跳可见性） |

### 1.3.1 威胁 → 控制措施可追踪矩阵

每条威胁必须至少命中一个控制措施（编号 M-xx，定义于第 2~7 章）。矩阵也是
§9 安全测试清单的覆盖审计依据——无测试覆盖的威胁在 §9.1 标为「缺口」。

| 威胁 | M-PAIR | M-TOKEN | M-CERT | M-AUTH | M-GATE | M-MODE | M-REG | M-KEY | M-AUDIT | M-REDACT | M-LIMIT | M-REVOKE | M-SESSION | 测试 |
|------|:------:|:-------:|:------:|:------:|:------:|:------:|:-----:|:-----:|:-------:|:--------:|:-------:|:--------:|:---------:|------|
| TH-01 伪造端 | ✓ | ✓ | ✓ | ✓ | | | ✓ | | ✓ | | | | | T-01/T-02 |
| TH-02 重放 | ✓ | ✓ | | ✓ | | | | | ✓ | | ✓ | | ✓ | T-02/T-05 |
| TH-03 伪造证书 | | | ✓ | | | | | | | | | | | T-03 |
| TH-04 帧篡改 | | | ✓ | ✓ | | | | | | | | | | T-04 |
| TH-05 审批载荷篡改 | | ✓ | | ✓ | ✓ | | | | ✓ | | | | | T-10 |
| TH-06 本地配置篡改 | | ✓ | | ✓ | | | | | | | | | | T-01 |
| TH-07 否认 | | | | | ✓ | | | | ✓ | | | | | T-10/T-14 |
| TH-08 窃听 | | | ✓ | | | | | | | | | | | T-03/T-04 |
| TH-09 日志泄露 | | | | | | | | | | ✓ | | | | T-06 |
| TH-10 密钥泄露移动端 | | | | | | | ✓ | ✓ | | | | | | T-07/T-09 |
| TH-11 远程调密钥命令 | | | | | | | ✓ | ✓ | ✓ | | | | | T-07 |
| TH-12 远程 full-access | | | | | | ✓ | | | ✓ | | | | | T-08 |
| TH-13 伪造审批落地 | | | | | ✓ | | | | ✓ | | | | | T-10 |
| TH-14 连接洪水 | | | | | | | | | ✓ | | ✓ | | | T-12 |
| TH-15 配对码穷举 | ✓ | | | | | | | | ✓ | | ✓ | | | T-05 |
| TH-16 超长帧/慢速 | | | | | | | | | ✓ | | ✓ | | | T-13 |
| TH-17 撤销不及时 | | | | | | | | | ✓ | | | ✓ | ✓ | T-11 |
| TH-18 本地进程读令牌 | | ✓ | | | | | | | | | | | | T-06 |
| TH-19 QR 钓鱼 | ✓ | | | | | | | | ✓ | | | | | T-05 扩展 |
| TH-20 静默不响应 | | | | | | | | | ✓ | | | | ✓ | T-14 |

结论：20 条威胁全部有覆盖，无未缓解威胁；**最薄弱环节是 TH-02 重放**——令牌非
一次性设计下，缓解依赖「会话密钥短时 + 心跳 + 多端并发告警」的组合（M-SESSION +
M-AUDIT），实现时必须三件齐备（§3.5 + §6.2 + §7.5 中「同一 deviceId 双会话告警」）。

### 1.4 信任边界图

```text
┌─────────────────────────── 信任域 1：桌面端进程 ───────────────────────────┐
│  API keys（DPAPI 槽）→ agent-provider 直连远端模型服务（TLS）               │
│  工作区文件 / shell / PTY / 后台任务                                          │
│  审批门（ApprovalGateImpl.pending 集合）                                     │
│  webview IPC（command_registry! 全部命令，仅本地）                           │
└───────────────▲─────────────────────────────────────────────┬──────────────┘
                │ 审计事件流（EventQueue / security-audit）     │ wss（TLS 1.3）
                │                                              │
┌───────────────┴─────────────────────────────┐   ┌───────────▼──────────────┐
│ 信任域 2：远程网关（桌面端内新增服务进程面）  │   │ 信任域 3：移动端          │
│ 仅白名单命令 / 令牌认证 / 速率限制 / 审计打码  │◄──┤ Keychain/Keystore 存令牌 │
│ 不触达 DPAPI 密钥槽（白名单排除 + 命令级拒绝） │   │ 无 admin / 上限 ask     │
└──────────────────────────────────────────────┘   └──────────────────────────┘
```

信任边界要点：

1. **边界 B1（webview IPC ↔ 引擎）**：现状唯一信任面，`main.rs:79` `command_registry!`
   全量注册。多端面不得把远程流量注入此边界。
2. **边界 B2（远程网关 ↔ 引擎）**：新增面。远程网关是独立白名单通道（D-11），
   只允许承载远程能力分级内的操作。
3. **边界 B3（移动端 ↔ 远程网关）**：wss + pinning（M-CERT）。
4. **边界 B4（桌面端进程 ↔ 局域网）**：默认不监听（D-01）；开启后由 M-LIMIT 保护。

---

## 2 传输安全

### 2.1 传输形态决策：ws vs wss

**决策 D-02a：远程网关只提供 wss（TLS），协议层强制，不存在 ws 明文端点。**

论证：

- 局域网不等于可信网：同一 Wi-Fi 下的 ARP 欺骗、恶意 AP、路由器后门都是现实威胁
  （威胁 TH-03/TH-04/TH-08）。
- 移动端会话内容含审批载荷（命令参数、文件路径摘要、对话事件流），明文暴露面不可接受。
- 「局域网内 wss 性能开销」不是理由：TLS 1.3 + 现代硬件下握手 ~1 RTT，会话加密吞吐
  远高于移动端宽带需求；且会话帧以 JSON 事件为主，体积小。

实现约束（远程网关 TLS 层）：

- 握手协议：TLS 1.3 优先，允许 1.2 但不允许 1.1/1.0 及任何 SSL 版本。
- 密码套件：仅 AEAD 类（AES-256-GCM / ChaCha20-Poly1305）；禁用 CBC/RC4/3DES；
  ECDHE 密钥交换；禁用 RSA 密钥交换（仅 ECDHE 前向保密）。
- 帧层：每帧 JSON，序列化后发送；**禁止**把明文日志字节直接拼入帧。
- 降级保护：服务端不回应「ws://」握手请求（返回 403 并记审计）；客户端（移动端）
  在代码层只接受 `wss://` scheme，`ws://` 直接拒绝并给出结构化错误。

### 2.2 证书策略：自签 CA vs 公网证书 vs pinning

三种方案的对比：

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 公网证书（Let's Encrypt 等） | 无需客户端信任配置 | ① 需要域名/公网可达性，局域网直连场景不成立；② 移动端仍走系统信任链，会引入中间 CA/欺诈 CA 风险；③ 证书泄漏后任何在系统信任链内的代理都能签发 | 不采用（局域网直连场景不适用） |
| 自签 CA（系统信任链导入） | 部署简单 | ① 要求用户手动安装 CA 到移动端系统信任库——iOS/Android 均要求用户明确操作，体验差且容易误装恶意 CA；② 信任范围过大（该 CA 信任后可用于签名其他东西） | 不采用（信任扩散面过大） |
| **自签 CA + 应用内 pinning** | ① CA 只在应用内信任，不污染系统信任链；② pinning 精确到指纹，即使 CA 私钥泄露，指纹不匹配也无效；③ 首配 QR 离线信道传递指纹，天然抗首次连接 MITM | 证书轮换需重新配对（可接受，频率极低） | **采用（D-02b）** |

设计（pinning 细节）：

1. **CA 生成**：桌面端首次开启多端服务时生成自签 CA（ECDSA P-256，比 RSA-2048 更小
   握手数据 + 同等级安全）+ 服务叶子证书（`CN=crish-remote`，有效期 1 年，
   `keyUsage = digitalSignature, keyEncipherment`，`extendedKeyUsage = serverAuth`）。
2. **指纹计算**：CA 公钥的 SHA-256 指纹（`sha256(SubjectPublicKeyInfo)`，标准 pin 格式）。
   指纹在桌面端「配对面板」以文本 + QR 呈现。
3. **移动端信任模型**：移动端 app 内置空信任锚；首次配对时把指纹写入应用级信任锚
   （不写入系统信任库）。此后每次 TLS 握手：
   - 校验叶子证书链到 CA；
   - 校验 CA 公钥指纹 == 已存储指纹；
   - 校验证书未过期、主机名匹配（主机名取配对 URL 的 host）。
4. **主机名校验**：不依赖公网 DNS；主机名就是配对 URL 中声明的 IP/主机名，
   且该校验发生在 pinned CA 已通过之后——攻击者伪造 IP 的 MITM 依然无法通过指纹校验。
5. **证书轮换**：轮换 = 重新生成 CA + 所有设备重新配对（指纹变更）。提供「一键
   轮换」命令并强制要求重新配对（旧指纹全部失效）。

### 2.3 局域网内攻击面：ARP / 伪造端

| 攻击 | 为什么失效 | 剩余风险 |
|------|-----------|----------|
| ARP 欺骗窃听 | 流量被 wss 加密；即便重定向到攻击者机器，TLS 握手在 CA 指纹校验处失败（TH-03） | 无 |
| 伪造 Wi-Fi AP | 同上；移动端只连用户指定地址 + pin 指纹 | 无 |
| 伪造端（未配对设备） | 无令牌，握手后第一步 token 认证失败即断开（TH-01） | 需防「在配对窗口内抢先配对」——配对码限次+过期+配对窗口广播提示 |
| 端口扫描发现服务 | 服务默认关闭；开启时端口可配；扫描本身只暴露握手层，无指纹即失败 | 低（扫描噪音可审计记录） |
| 同一局域网恶意主机直接连接 | 无令牌/无指纹 → 握手失败；有指纹无令牌 → 认证失败 | 无 |

补充防线（防「配对窗口抢注」）：

- 配对会话与具体配对码绑定，且仅允许**一次**成功（一次性，D-03）。
- 配对请求必须携带**设备指纹**（公钥）——配对成功后，该公钥成为设备的「身份密钥」，
  后续令牌认证可绑定身份密钥签名（P2：令牌 + 设备公钥双重认证）。
- 桌面端配对面板实时显示「配对请求来源 IP + 设备名 + 时间」，用户可点「拒绝」中止。

### 2.4 公网/中继路径（未来面约束）

现状 crish 无中继服务器；移动端「远程唤醒/公网访问」若未来引入中继，本模型先行冻结
约束：

- 中继只承载**加密隧道**（端到端加密在应用层，桌面端与移动端直接派生会话密钥），
  中继不可见明文帧——复用同一帧加密原语（AEAD + 序列号防重放）。
- 中继不可见令牌/配对码；认证材料只出现在端到端信道内。
- 中继侧只承担「打洞/转发」职责，任何解密能力 = 安全违规。
- 中继接入时必须复用本模型的授权/审计契约（actor=deviceId 语义不因信道改变）。

### 2.5 TLS 实现检查清单（工程落点）

远程网关的 TLS 层是 D-02 的物理载体，逐项核对：

| # | 检查项 | 要求 | 违例后果 |
|---|--------|------|----------|
| TLS-01 | 服务端证书密钥类型 | 仅 ECDSA P-256 或 RSA-2048+；私钥 0600 权限存配置目录 | 密钥可被本地进程读取（TH-18） |
| TLS-02 | TLS 版本 | 仅 1.3/1.2；`min_version = 1.2` 显式设置 | 降级到 1.1/SSLv3 可被破解 |
| TLS-03 | 密码套件 | 仅 `TLS_AES_256_GCM_SHA384`（1.3）/ ECDHE+AES-256-GCM（1.2）；禁 CBC/RC4/3DES/DES | 弱套件可被离线破解（TH-08） |
| TLS-04 | 前向保密 | 必须 ECDHE；禁 RSA key exchange | 会话密钥泄露即全部历史解密 |
| TLS-05 | 客户端校验 | 移动端必须校验证书链 + CA 指纹 pin + 主机名 | pinning 缺失 = MITM 可成功（TH-03） |
| TLS-06 | 证书轮换 | CA/叶子证书轮换命令 + 全部设备重配对流程 | 泄露私钥无法收回 |
| TLS-07 | 会话复用 | 禁 TLS session resumption 的票据复用跨重启（服务重启清空票据密钥） | 重启后旧会话可被重放 |
| TLS-08 | 握手日志 | 握手失败记审计（含客户端 IP/指纹状态），不记握手敏感参数 | 不可诊断 MITM 尝试 |
| TLS-09 | 客户端身份 | TLS 层不做客户端证书认证（首版）；客户端身份由应用层令牌承担 | —— |
| TLS-10 | 依赖 | 用 `rustls`（内存安全、无 OpenSSL 历史 CVE 面）而非 native-tls 默认链 | 系统信任链引入（与 pinning 冲突） |

实现落点：新增 `multi_device/tls.rs` 负责 CA 生成/叶子证书/指纹导出/`rustls`
ServerConfig 装配；移动端对偶实现由移动端侧按本文档契约完成。

---

## 3 认证与会话

### 3.1 配对协议总体流程

```text
桌面端                             移动端
  │  ①开启多端服务（配置项）          │
  │  ②生成配对会话：                  │
  │     pairId=32B随机               │
  │     code=8字符base32             │
  │     过期=10min / 限试=5次         │
  │  ③配对面板展示 QR(含指纹+地址+码)  │
  │                                  │ ④扫码/手动输入
  │◄──────── ⑤wss 连接 + pair-request ─│
  │     {pairId, code, deviceKey,     │
  │      deviceName}                  │
  │  ⑥校验：pairId存在/未过期/次数/     │
  │     常数时间比较 code/一次性标记     │
  │  ⑦生成 deviceToken(256bit随机)     │
  │     返回 {deviceId, token}         │
  │──────────────────────────────────►│ ⑧存储令牌（系统密钥库）
  │  ⑨落库：hash(salt‖token)+deviceId │  完成
```

### 3.2 一次性配对码设计（M-PAIR）

| 属性 | 设计值 | 理由 |
|------|--------|------|
| 字符集 | base32 字母表去 `0/O/1/I/L`（32 字符） | 人输错率最低 |
| 格式 | **CXN-XXXX-XXXX-XXXX（12 字符，3 组 × 4）**【裁决修正 1：对齐 D3 §4.1 唯一真源，原 8 字符规格作废】 | 带前缀可识别 + 扫码/手动同构 |
| 长度 | 12 字符 | 60 bit 熵；`32^12 = 2^60` |
| 熵来源 | `getrandom()` 系统 CSPRNG | Rust 侧用 `rand_core::OsRng` 等价物，禁止时间/进程 id 种子 |
| 尝试次数 | 每码 ≤5 次失败 | 2^40 中猜 5 次 ≈ 4.5e-12 成功率 |
| 过期 | 10 分钟 | 足够用户拿起手机扫码 |
| 一次性 | 成功配对后立即销毁 | 防重放（TH-02） |
| 比较方式 | 常数时间比较（`subtle::ConstantTimeEq`） | 防时序侧信道 |
| 存储 | 仅内存（配对会话表），不落盘；服务重启即失效 | 防 T-06 本地进程读取 |
| 展示 | 仅桌面配对面板 + QR；日志只记哈希 | 防 TH-09 |

配对失败锁定（配合 M-RATE）：

- 同一 pairId 第 5 次失败 → 该配对会话立即销毁并记审计 `remote-pair` decision=blocked；
- 同一源 IP 累计 10 次配对失败 → 该 IP 锁定 15 分钟（拒绝握手层）。
- 锁定与过期均记录审计事件（含来源 IP，打码不适用——IP 是审计字段非敏感字段）。

### 3.3 设备令牌设计（M-TOKEN）

| 属性 | 设计值 | 理由 |
|------|--------|------|
| 生成 | `getrandom()` 32 字节（256 bit） | 不可预测 |
| 编码 | base64url 无填充，43 字符 | 移动端可手输/复制 |

> 【裁决修正 10】本节「设备令牌」对应 M7 §4.2 四类令牌中的**配对令牌（本地形态）**：
> 认证方案唯一真源 = M7 四类令牌分治（配对令牌本地 / 账号 token 云端不共享 /
> 中继凭据 HMAC / 推送注册加密）。本节描述的 256bit 随机形态已按 AU1 P1-10 /
> M7 O-01 裁决收敛为 **D3 §4.4 的 token_key 派生形态**（消息级 HMAC 已依赖派生值）；
> 哈希落盘纪律（sha256(salt‖token)）不变。
| 传输 | 仅配对成功响应一次（wss 信道内） | 此后不重传明文 |
| 桌面端存储 | `sha256(deviceSalt ‖ token)`，deviceSalt 每设备 16B 随机，走 DPAPI 槽 | 数据库/文件泄露不可反推令牌（TH-18/TH-06） |
| 移动端存储 | iOS Keychain（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）/ Android Keystore 派生加密 | 系统级密钥库，越狱/root 后仍尽力保护 |
| 有效期 | 默认 30 天，可配（10~365 天） | 持机者攻击窗口收敛 |
| 撤销 | 桌面端设备管理页一键撤销（立即删除 + 强制断开活动连接） | TH-17 |
| 轮换 | `rotate_token` 产生新令牌、旧令牌立即失效；触发条件：接近过期/疑似泄露 | 降低长期令牌风险 |

**令牌校验时序（每次连接）**：

```text
1. TLS 握手（pinned CA）通过
2. 移动端发送 auth 帧 {deviceId, token, clientNonce}
3. 服务端：
   a. deviceId 存在？不在撤销清单？
   b. 常数时间比较 sha256(salt‖token)
   c. 令牌未过期？
   d. 该设备已连接数 < 上限（M-LIMIT）
4. 通过 → 建立会话：派生 sessionId + 会话密钥（8h 有效）
5. 失败 → 记审计 + 计数；设备累计 5 次认证失败 → 设备标记「需重新配对」
```

会话密钥派生（P2 可选简化）：会话建立时用 HKDF-SHA256 从设备令牌派生 32B 会话密钥，
此后应用层帧用 AES-256-GCM + 64 位序列号加密（端到端，未来中继面直接复用）。

### 3.4 设备管理（M-REVOKE）

设备注册表（桌面端配置目录 `multi-device.json`，原子写 `tmp + rename` 对齐
`config/persistence.rs:64-81` 先例）：

| 字段 | 说明 |
|------|------|
| deviceId | 桌面端生成的 16B 随机 id（base32，人读友好） |
| deviceName | 用户命名（配对时提供，展示用） |
| deviceKey | 配对时提交的设备公钥（P2 双重认证用；本版登记不强制使用） |
| tokenHash | `sha256(salt‖token)` |
| salt | 每设备随机盐 |
| createdAt / lastSeenAt | 展示与审计 |
| status | active / revoked |
| revokedAt | 撤销时间 |

设备面操作（桌面端本地 UI，**不进远程白名单**）：

- 列出设备（id/名称/最后连接/创建时间）
- 撤销设备（一键；撤销后：注册表删除 + 活动连接强制断开 + 审计 `remote-device-revoked`）
- 重命名设备
- 「撤销全部设备」：清空注册表 + 关闭服务（可选）

### 3.5 会话生命周期与超时

| 会话阶段 | 超时/规则 | 行为 |
|----------|-----------|------|
| 连接空闲 | 读超时 10s | 断开 + 释放连接槽 |
| 心跳 | 30s 心跳，60s 容差 | 超时 → 会话标记 suspended（可恢复）；5 分钟无心跳 → 会话销毁 |
| 会话有效期 | 8h（派生会话密钥有效期内） | 过期后需重新认证（令牌仍在有效期内则免配对重连） |
| 令牌有效期 | 30 天（可配） | 过期令牌认证失败 → 提示重新配对 |
| 审批等待 | 复用 `APPROVAL_TIMEOUT=120s`（`core_run_commands.rs:88`） | 超时 Expired，与桌面端本地语义一致 |

会话状态机：

```text
PENDING(握手) → AUTHENTICATED(令牌校验通过) → ACTIVE(会话建立)
     → SUSPENDED(心跳丢失，5min 内可恢复)
     → CLOSED(正常断开/撤销/超时/服务关闭)
```

所有状态迁移写审计（`remote-session` 事件族，见第 6 章）。

### 3.6 协议报文 Schema（wire 冻结契约）

> 所有帧为 UTF-8 JSON，帧头 4 字节大端长度前缀。帧级错误用统一错误帧
> `{ "type": "error", "code": "...", "detail": "..." }`。本契约是移动端实现的
> 对偶接口，未经主 Agent 评审不得私自变更（变更走事件注册表同款纪律）。

**3.6.1 配对面**

```jsonc
// 移动端 → 桌面端（pair-request）
{
  "type": "pair-request",
  "pairId": "c9xk3m2q1v",              // 桌面端配对面板展示的会话 id（base32）
  "code": "K7M3N9PQ",                  // 8 字符配对码（明文仅此一帧）
  "deviceName": "我的 iPhone",
  "deviceKey": "base64url(SPKI)",      // 设备公钥（P2 双重认证用，本版可为空）
  "clientNonce": "16B-base64url"       // 防重放：桌面端在 auth 响应中原样返回
}

// 桌面端 → 移动端（pair-ok：仅此一帧携带令牌明文）
{
  "type": "pair-ok",
  "deviceId": "m2xk8v3q",
  "token": "base64url(32B)",           // 43 字符，移动端立即存入系统密钥库
  "serverNonce": "16B-base64url",      // 与 clientNonce 组成挑战响应
  "capabilities": ["observe", "approve"],
  "sessionKey": "base64url(32B)",      // HKDF 派生会话密钥（此后应用帧加密）
  "sessionTtlSeconds": 28800
}

// 桌面端 → 移动端（pair-denied：失败/过期/锁定统一出口）
{
  "type": "pair-denied",
  "reason": "code-wrong | code-expired | locked-out | pair-not-found"
}
```

**3.6.2 认证面**

```jsonc
// 移动端 → 桌面端（auth-request：每次连接的第一步应用帧）
{
  "type": "auth-request",
  "deviceId": "m2xk8v3q",
  "token": "base64url(32B)",
  "clientNonce": "16B-base64url",
  "requestedCapabilities": ["observe", "approve", "operate"]  // 服务端以注册表为准
}

// 桌面端 → 移动端（auth-ok）
{
  "type": "auth-ok",
  "sessionId": "sess-7x2k9",
  "grantedCapabilities": ["observe", "approve"],   // 申报与授予可能不一致（截断）
  "sessionKey": "base64url(32B)",                  // 会话密钥（8h）
  "serverTime": 1780000000000,                     // 时钟对齐（审计时间源）
  "revoked": false
}

// 桌面端 → 移动端（auth-denied：失败原因区分，便于移动端引导用户）
{
  "type": "auth-denied",
  "reason": "token-invalid | token-expired | device-revoked | too-many-attempts | locked-out"
}
```

**3.6.3 会话面**

```jsonc
// 双向心跳（心跳携带会话续期信号）
{ "type": "heartbeat", "sessionId": "sess-7x2k9", "seq": 1 }

// 桌面端 → 移动端（事件推送：只推授权事件，见 §7.5 背压裁剪）
{
  "type": "event",
  "sessionId": "sess-7x2k9",
  "event": { "type": "approval-requested", "sessionId": "s1",
             "request": { "toolCallId": "tc-1", "toolName": "shell", ... },
             "timestamp": "2026-08-09T08:00:00.000Z" }
}

// 桌面端 → 移动端（服务端主动断开）
{
  "type": "server-close",
  "reason": "device-revoked | service-stopped | session-expired | admin"
}
```

**3.6.4 命令面（§4.5 白名单）**

```jsonc
// 移动端 → 桌面端（remote.approve）
{
  "type": "command",
  "sessionId": "sess-7x2k9",
  "requestId": "c-1",                    // 幂等键（重放去重：同 requestId 只执行一次）
  "command": "remote.approve",
  "args": { "runId": "run-1", "toolCallId": "tc-1" }
}

// 桌面端 → 移动端（命令回执；审批类命令回执 = approval-resolved 事件）
{
  "type": "command-ok",
  "requestId": "c-1",
  "result": { "ok": true, "toolCallId": "tc-1", "decision": "approved" }
}

// 桌面端 → 移动端（命令失败：统一错误帧）
{
  "type": "error",
  "code": "not-found | forbidden | mode-downgraded | rate-limited | locked-out",
  "detail": "tool_call_id 不在待审批集合"
}
```

**3.6.5 重放与幂等约束**

| 机制 | 设计 | 目的 |
|------|------|------|
| clientNonce | 每次连接随机 16B，服务端记录最近 64 个 nonce 并拒绝重复 | 认证帧防重放（TH-02） |
| requestId | 每命令随机 64 位 id，服务端按会话维护最近 1024 个已执行 requestId | 命令幂等（网络重发不双执行） |
| 会话密钥 | 每连接 HKDF 派生，8h 有效 | 会话级重放窗口收敛 |
| 序列号 | 应用帧内 64 位递增 seq，服务端拒绝乱序/重复帧 | 帧层防重放（未来端到端加密直接复用） |

### 3.7 配对码生成与展示细节

- 生成：`pairId = base32(16B 随机)`（26 字符）；`code = base32 字母表采样 8 字符`。
- 展示：桌面端配对面板大字展示 + QR（URL 形态
  `crish://pair?host=192.168.1.5&port=8456&pairId=...&code=...&fingerprint=sha256hex`）；
  QR 中**必含 CA 指纹**（TH-19 缓解：扫描端用指纹校验 TLS 信任锚，QR 是离线信道，
  不存在 QR 被网络中间人篡改的问题——唯一篡改点是人肉核对，故面板同时大字显示
  指纹前 8 位便于目视核对）。
- 一次性码生命周期状态机：

```text
CREATED(生成时起 10min) ──正确匹配──→ CONSUMED(立即销毁，成功配对)
      │
      ├─ 第 5 次错误 → DESTROYED(locked, 审计 blocked)
      ├─ 10min 超时  → EXPIRED(销毁, 审计 denied)
      └─ 服务重启    → DESTROYED(进程内存即生命周期)
```

---

## 4 授权模型

### 4.1 移动端能力分级

| 能力级别 | 代号 | 允许操作 | 说明 |
|----------|------|----------|------|
| 观察 | `observe` | 会话列表、run 状态、事件流（只读）、后台任务状态 | 默认级别；等价 plan 权限模式的只读语义 |
| 审批 | `approve` | 观察 + 裁决审批请求（approve/deny）、查看审批历史 | 裁决受 §4.4 双轨规则约束 |
| 操作 | `operate` | 审批 + 发起 run（含指定任务/提示词）、取消 run、终端输入转发（PTY 输入通道，P2） | 通过 run 间接操作文件/命令，不暴露直接命令面 |
| admin | —— | 设备管理/服务开关/配置修改 | **移动端不可获取**（D-05）；仅桌面端本地 |

分级铁律：

1. 移动端默认申请 `approve`；`operate` 需配对时用户明确勾选（默认不勾）。
2. 能力是**服务端裁决**的：移动端在 auth 帧中申报能力，服务端以注册表记录为准
   （移动端本地配置不可自提权，TH-06）。
3. 能力与令牌同生命周期：撤销令牌 = 撤销能力。

### 4.2 权限模式映射与上限（M-MODE）

现状权限引擎（`crates/agent-tools/src/permission.rs`）：

- `PermissionMode`（`:19`）：Ask / FullAccess / Plan 三态；
- `PermissionVerdict`（`:57`）：Allow / Deny / NeedsApproval 三态；
- `decide_with_redline`（`:96`）：红线 → 一律 Deny，**任何模式下不可豁免**；
- `decide_command`（`:113`）：命令面便捷入口（红线先行 + 三态矩阵）。

远程映射规则（run 装配点强制）：

| 移动端能力 | 可指定 run 权限模式 | 服务端强制结果 |
|------------|---------------------|----------------|
| observe | plan（只读） | `plan` |
| approve | plan / ask | 申请 full-access → 降级 `ask`（记录审计 `mode-downgraded`） |
| operate | plan / ask | 申请 full-access → 降级 `ask`（同上） |

**远程不存在 full-access**（TH-12 的直接缓解）。实现点：远程网关在装配
`SessionLoopProducer` 时对 `permissionMode` 参数执行 `min(requested, Ask)`；
红线语义原样继承（远程 run 的红线命令在 `decide_with_redline` 处 Deny，与本地一致）。

### 4.3 审批裁决者扩展（M-GATE）

现状裁决者路由（`crates/session-loop/src/approval_router.rs`）：

- `ApprovalSource`（`:60`）：MainAgent / Subagent；
- `Arbiter`（`:74`）：User / MainAgent；
- `route_approval`（`:100`）：MainAgent → User；Subagent → MainAgent；
- `route_approval_guarded`（`:112`）：死锁防护转 User；
- `arbiter_metadata`（`:174`）：广播载荷 `metadata.arbiter`。

扩展设计：

```text
Arbiter 新增变体：
  Remote { device_id: String }        // 移动端裁决（能力 >= approve）
  RemoteAndLocal                      // 双轨裁决（§4.4）
```

路由扩展（纯函数，保持 approval_router 的可单测风格）：

- 远程 run（run 由远程网关发起，携带 `source=deviceId`）产生的
  `PermissionVerdict::NeedsApproval` → `Arbiter::Remote`；
- 若该 run 的会话同时有桌面端本地用户在场（桌面 UI 打开且未锁屏）→ 升级为
  `RemoteAndLocal`（双轨确认，§4.4）；
- 子代理链路不变：远程 run 内的子代理申请仍按 T-D-14 路由（`route_approval`），
  最终裁决者仍回到远程用户或本地用户兜底。

审批门复用（`core_run_commands.rs:161` ApprovalGateImpl）：

- `request_approval`（`:263`）的广播路径不动——`approval-requested` 事件照常进
  EventQueue（`events.rs:480`），远程网关订阅事件流转发给移动端；
- 裁决入口复用 `resolve`（`:230`）：远程网关把移动端的裁决帧转换为
  `core_approve_tool` / `core_deny_tool` 同构调用（`run_id` + `tool_call_id` +
  decision）；
- **伪造防护**（TH-13）：`resolve` 的 pending 集合校验（`:235-245`，NotFound 语义）
  原样生效——远程通道无法对不存在的 tool_call_id 落地 approval-resolved；
- `emit_approval_resolved`（`:3802`）落库 + 广播路径复用，事件带 `request_id` 由
  远程网关填充 `remote:{deviceId}:{seq}` 便于审计对账。

### 4.4 危险操作的二次确认（双轨裁决）

规则（D-07）：

| 操作类别 | 移动端裁决 | 桌面端本地用户 | 通过条件 |
|----------|-----------|----------------|----------|
| 红线（redline） | —— | —— | **一律拒绝**（`decide_with_redline`，不可豁免） |
| 普通操作（Allow） | 不需要 | 不需要 | 直接放行 |
| dangerous / requires_approval（NeedsApproval） | 需要 | 不在场 | 移动端单一确认（审计标记 `remote-only`） |
| 同上 | 需要 | 在场 | **双轨确认**：移动端确认 + 桌面端弹窗确认（任一方拒绝即拒绝） |

「桌面端本地用户在场」判定：

- 桌面 UI 前台激活且无锁屏（webview 可见）；
- 桌面端最近 10 分钟内有用户交互（键盘/鼠标事件）；
- 判定在引擎侧装配（可注入，缺省 false = 保守模式：无人值守按 remote-only 处理）。

说明：

- 移动端确认本身即「用户在场」的一种形式（手机持有人），但桌面端用户存在时，
  双轨确认防止「手机离身/被他人持有时桌面端无人察觉地批准」；
- `remote-only` 审计标记使事后追责可区分「手机端单方批准」与「双轨批准」；
- 此规则不改变本地 run 语义：本地 run 的审批仍只走桌面端 UI（现状不变）。

### 4.5 远程命令面白名单（M-REG）

远程网关**不暴露 Tauri IPC**（D-11）。远程可调用的引擎能力收敛为一个独立白名单
注册表（对偶 `command_manifest.rs` 的 registered=true 机制）：

| 远程命令（网关内部路由名） | 所需能力 | 对应引擎实现 | 备注 |
|----------------------------|----------|--------------|------|
| `remote.list_sessions` | observe | core_query 会话面 | 只回元数据（id/时间/状态），不回消息全文（P1 可放开） |
| `remote.list_runs` / `remote.run_snapshot` | observe | `core_query_commands.rs` 快照面 | |
| `remote.subscribe_events` | observe | 事件流订阅（过滤 runId） | 移动端只收授权会话的事件 |
| `remote.request_approval_list` | approve | 待审批集合快照 | |
| `remote.approve` / `remote.deny` | approve | `resolve` 入口（`:230`） | 双轨规则在网关层执行 |
| `remote.run_task` | operate | run 装配面（强制 `min(mode, ask)`） | |
| `remote.cancel_run` | operate | cancel 三路径 | |
| `remote.device_rotate_token` | operate | 令牌轮换 | 轮换后该设备需用新令牌重连 |
| `remote.heartbeat` / `remote.close` | 全部 | 会话管理 | |

> 【裁决修正 5】路由命名统一 `remote.*`（跨端命令唯一前缀；`cmd.*` 仅保留桌面
> 内部）。本节路由名与 M6 §4 的命令 kind（`remote.getStatus` 等 camelCase 后缀）
> 需经 §2.9 三列映射表对齐（网关路由名 ↔ M6 kind 名 ↔ manifest 命令名），
> 由 `remote_manifest.rs` 注册表 + 生成器锁定，防止两套命名漂移（AU1 P1-3）。

**显式不进白名单**（无论何级能力）：

- `config_secret_get / set / clear / reveal / has`（`config/credentials.rs:237-341`）——
  密钥命令面（TH-10/TH-11）；
- `workbench_fs_delete_file`、`workbench_git_run`、`workbench_pty_*`、
  `workbench_run_shell`、`host_openers` 族——直接文件/终端/执行面；
- 设备管理与服务配置命令（admin 面，仅桌面端）；
- 任何以明文返回密钥/令牌/配对码的命令。

纵深防御（即使白名单被绕过）：

1. 远程网关对**所有**请求做命令名白名单校验（第一层）；
2. 敏感命令实现内部加 `remote_source` 拒绝分支（第二层，见 §8.2）；
3. 密钥命令的审计事件在远程来源时恒记 `remote-source-attempt`（第三层，TH-11 可见性）。

### 4.6 远程授权决策流（伪代码级契约）

**4.6.1 远程 run 装配（M-MODE 落点）**

```rust
/// 远程网关 run 装配函数（签名示意；实现落点 core_run_commands.rs 装配面）
fn assemble_remote_run(
    device: &DeviceRecord,              // 注册表记录（能力为准，设备自报不可信）
    requested_mode: PermissionMode,     // 移动端申报
) -> AssembleOutcome {
    // 1. 能力 → 模式上限（§4.2 矩阵）
    let mode_cap = match device.capabilities {
        Capability::Observe => PermissionMode::Plan,           // 只能 plan
        Capability::Approve | Capability::Operate => PermissionMode::Ask,
    };
    // 2. 截断：min(requested, 能力上限)；plan 恒 plan
    let effective = match (mode_cap, requested_mode) {
        (PermissionMode::Plan, _) => PermissionMode::Plan,
        (PermissionMode::Ask, PermissionMode::Plan) => PermissionMode::Plan,
        (PermissionMode::Ask, _) => PermissionMode::Ask,       // full-access 降级
    };
    if effective != requested_mode {
        emit_audit(RemoteModeDowngraded { run: _, from: requested_mode, to: effective });
    }
    // 3. 红线不可豁免：判定链复用 decide_with_redline / decide_command_with_revert，
    //    与本地 run 同一代码路径（permission.rs:96/135），远程不产生例外分支
    AssembleOutcome { effective_mode: effective }
}
```

**4.6.2 审批双轨裁决（M-GATE + M-MODE 落点）**

```rust
/// 裁决者路由（approval_router.rs 扩展，纯函数可单测）
fn route_remote_approval(source: ApprovalSource, remote: &RemoteCtx) -> Arbiter {
    // 子代理链路保持既有路由（主 agent 或用户兜底），最后落到远程裁决者
    let base = route_approval_guarded(&source, remote.main_agent_waiting);
    match base {
        Arbiter::User => {
            // 远程 run：用户裁决面 = 移动端（Remote）
            if remote.local_user_present {
                Arbiter::RemoteAndLocal   // 双轨：移动端 + 桌面端弹窗
            } else {
                Arbiter::Remote { device_id: remote.device_id.clone() }
            }
        }
        other => other,                   // MainAgent 等现状语义不变
    }
}
```

**4.6.3 远程命令执行（M-REG 落点）**

```rust
async fn dispatch_remote_command(session: &RemoteSession, frame: CommandFrame) -> Result<Value> {
    // 1. 会话有效性（令牌会话未过期、未撤销、心跳正常）
    session.assert_active()?;
    // 2. 白名单注册表查找（remote_manifest.rs，编译期注册 + 测试锁定）
    let route = remote_command_registry::lookup(&frame.command)
        .ok_or(Forbidden("command not in remote whitelist"))?;
    // 3. 能力门槛（注册表声明所需能力级）
    require_capability(&session.device, route.min_capability)?;
    // 4. 速率限制（命令级 60/min，§7.3）
    session.rate_limiter().check(&frame.command)?;
    // 5. 幂等（requestId 去重，§3.6.5）
    if session.seen_request(frame.request_id)? { return Ok(Value::Null); }
    // 6. 执行 + 审计（actor = deviceId 权威注入，§6.4）
    let result = route.execute(&session, frame.args).await?;
    emit_remote_command_audit(&session, &frame, &result);
    Ok(result)
}
```

**4.6.4 授权决策矩阵（完整版）**

| 条件 | 裁决 |
|------|------|
| 未认证/令牌无效 | 拒绝（连接层，不进入命令面） |
| 命令不在白名单 | `Forbidden` + `remote-source-attempt` 审计 |
| 能力不足（如 observe 调 remote.approve） | `Forbidden` + 审计 |
| run 权限模式申报 full-access | 降级 ask + `remote-mode-downgrade` 审计 |
| 红线命令（远程 run 内工具调用） | 一律 Deny（`decide_with_redline`），无审批路径 |
| dangerous / requires_approval（远程 run） | NeedsApproval → Remote 或 RemoteAndLocal 裁决（§4.4） |
| 审批裁决（remote.approve/deny） | 双轨在网关层执行：桌面在场且配置要求 → 先挂起等待桌面端本地确认 |
| 密钥命令面（config_secret_*） | 白名单拒绝 + 命令级 `remote_source` Forbidden（双层） |
| admin 面（设备管理/配置） | 白名单拒绝（无任何远程路由） |

---

## 5 密钥管理

### 5.1 密钥边界：Provider API keys 永不出桌面（M-KEY）

**边界确认（D-08）**：移动端不接触 provider 密钥，且不存在任何合法路径让其接触：

1. **数据面隔离**：密钥存在于桌面端 DPAPI 槽（`config/credentials.rs:31` CredentialStore、
   `dpapi_protect` `:405`），provider 请求由桌面端 `agent-provider` 直连远端模型服务
   （传输在桌面端进程内）；移动端不经过任何 provider 协议面。
2. **命令面隔离**：远程白名单排除 `config_secret_*`（§4.5 表格）。
3. **命令级拒绝**：`config_secret_*` 各命令增加来源参数校验——非本地 webview 来源
   一律 `CoreError::Forbidden`（`core_error.rs` 扩展，见 §8.2）。
4. **展示面隔离**：`config_secret_reveal`（`credentials.rs:319`）的 `ui_confirm=true`
   明文返回仅限本地 UI；远程通道无此命令。
5. **测试断言**：第 9 章 T-09「密钥不出桌面」场景做成自动化测试。

### 5.2 移动端令牌的本地安全存储

| 平台 | 存储方案 | 要点 |
|------|----------|------|
| iOS | Keychain（`kSecClassGenericPassword`） | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`：锁屏后首次解锁才可读，且不随备份迁移 |
| Android | Android Keystore 生成 AES-256 密钥 + EncryptedSharedPreferences | Keystore 密钥不可导出（硬件级防护可用时）；加密后的令牌密文存偏好 |
| 降级 | 无系统密钥库（极少见） | **拒绝明文存储**：宁可每次配对，不做明文落盘 |

移动端不落盘的敏感物：令牌、配对码、CA 指纹（指纹可落盘，属非机密但防篡改）。

P2 增强（见 §10.4）：生物识别门禁（Face ID / 指纹）在「发起 operate 级操作」前二次
解锁；令牌读取前校验 app 完整性（iOS `kSecAttrAccessGroup` 隔离）。

### 5.3 桌面端令牌存储（对齐 CredentialStore 形态）

设备令牌哈希 + 盐落在**独立 DPAPI 槽**：`config_dir()/secrets/{deviceId}.devtoken.dpapi`
（复用 `CredentialStore` 的 DPAPI 读写与内存缓存，`credentials.rs:97-158`）。设备注册
表 `multi-device.json` 只存哈希与元数据（§3.4）。存储分层：

```text
明文令牌        → 仅存在于：配对响应构造点（内存）→ 移动端
桌面端          → DPAPI 加密的盐（secrets 槽）+ multi-device.json 哈希
日志/审计       → 只允许 hash 前缀 / last8（M-REDACT）
```

### 5.4 密钥生命周期与轮换

| 阶段 | 动作 | 触发 |
|------|------|------|
| 生成 | 配对成功 → 生成令牌（256 bit CSPRNG） | 配对完成 |
| 使用 | 每次连接认证 | 连接握手 |
| 旋转 | 新令牌生成，旧令牌立即失效（移动端需重存） | 用户主动 / 距离过期 < 7 天 / 疑似泄露 |
| 撤销 | 注册表删除 + 强制断开 + 审计 | 设备管理页 / 安全事件 |
| 过期 | 认证失败（`token-expired`） | 30 天 |

Provider key 的轮换维持现状（`config_secret_set` 覆盖写入，`credentials.rs:237`）。

---

## 6 审计

### 6.1 现状审计面盘点

| 面 | 位置 | 承载 |
|----|------|------|
| 事件面 | `AgentEvent::SecurityAudit`（`crates/conex-types/src/events.rs:560`） | operation（delete/trash-restore/trash-purge/git-revert/command-exec/undeclared-write）、targets、impact、decision、permission_mode、tool_call_id |
| 构造器 | `security_audit_event`（`crates/agent-tools/src/audit.rs:109`） | 时间戳 UTC ISO8601 毫秒精度 |
| sink 链 | `SecurityAuditSink` trait（`audit.rs:23`）→ `RoutingAuditSink`（`engine.rs:698`）按 session 路由 → `BridgeAuditSink`（`core_run_commands.rs:448`）→ `spawn_audit_persistence`（`:500`）落 events 表 | 工具级 + 引擎命令级审计 |
| 任务域 | `TaskAuditRecord`（`crates/orchestrator/src/task_events.rs:258`）→ `build_task_audit_event`（`:293`） | taskId/command 摘要/operator/时间戳/result |
| 审批 | approval-requested / approval-resolved（`events.rs:480/488`）Critical 必达落库 | 审批全生命周期 |
| 背压 | `event_backpressure`（`events.rs:867`） | 审计类 = Critical |
| 打码先例 | K-05（`config/credentials.rs:256` last4）、`redact_url_query`（`conex-browser-tools/src/helpers.rs:204`）、`redact_attributes`（`conex-browser/src/snapshot/redact.rs:79`） | 密钥/URL 参数 |

### 6.2 远程操作审计扩展

新增 `SecurityAuditOperation` 变体（`events.rs:66` 枚举扩展；同步事件注册表与
生成产物——见 §8.5）：

| 变体（wire） | 语义 | targets 承载 | decision 取值 |
|--------------|------|--------------|----------------|
| `remote-pair` | 配对尝试（成功/失败/锁定/过期） | `pairId`, 来源 IP | approved / denied / blocked |
| `remote-auth` | 令牌认证（成功/失败/过期/撤销） | deviceId | approved / denied / blocked |
| `remote-command` | 远程命令执行（run/approve/deny/cancel） | 命令名 + 摘要 | approved / denied / blocked |
| `remote-session` | 会话建立/挂起/关闭/超时 | sessionId, deviceId | approved（正常）/ blocked（异常断开） |
| `remote-device` | 设备管理（注册/撤销/轮换） | deviceId | approved / denied |
| `remote-mode-downgrade` | full-access 申请被降级为 ask | runId | blocked（记录降级） |
| `remote-source-attempt` | 远程来源试图触达被禁命令面 | 命令名 | blocked |

**审计记录字段约定**：

- 所有远程事件携带 `device_id`（从认证会话注入，事件体加 `remote_device_id` 可选字段，
  serde 缺省向后兼容，对齐 `PermissionRequest` 扩展先例 `events.rs:207-217`）；
- actor 语义：`tool_call_id` 位被远程网关复用为 `remote:{deviceId}:{seq}`（与
  §4.3 的 request_id 对账）；
- `permission_mode` 如实记录（远程 run 恒为 ask/plan，记录降级前申请值）。

### 6.3 令牌日志打码（M-REDACT）

铁律（与 K-05/K-02 同源）：

| 敏感物 | 日志规则 | 例外 |
|--------|----------|------|
| 设备令牌 | 仅允许 `sha256(token)` 前 12 hex；禁止明文/last8 | 无 |
| 配对码 | 仅允许 `sha256(code)` 前 12 hex；禁止明文 | 桌面配对面板展示一次（非日志） |
| Provider key | 现状 K-05（last4），不变 | 无 |
| 设备盐 | 永不输出 | 无 |
| CA 私钥 | 永不输出；仅输出指纹 | 无 |
| 审批参数中的敏感串 | 复用 `redact_url_query` / `redact_attributes` 形态的关键词打码（password/token/secret/api_key 键值 → `***`） | 无 |

实现落点：新增 `crates/conex-telemetry/src/redact.rs`（现状该 crate 无 redact 模块，
实际打码先例在 browser 侧）——职责为「敏感物 → 展示安全摘要」纯函数库，与
`agent-tools/audit.rs` 的构造器配合（构造器接收「已打码」字符串，审计面不接触明文）。

**验证**：第 9 章 T-08「日志无明文」做成 grep 式测试：跑典型场景后扫描日志文件，
断言无 43 字符 base64url 令牌形态 / CXN 12 字符 base32 配对码形态（【裁决修正 1】
原「8 字符 base32 码形态」扫描断言同步改为 CXN 格式）/ `sk-` 前缀密钥形态。

### 6.4 审计完整性

- **不可丢**：远程审计事件走 `event_backpressure` 的 Critical 分支（`events.rs:891`），
  与既有审计同轨落库；`spawn_audit_persistence` 排空机制（`core_run_commands.rs:388-390`
  audit_persist 收口 await）对远程会话同样生效。
- **不可伪造**：审计事件由桌面端生成，移动端不可直接投递事件（只可请求动作）；
  远程网关把 `device_id` 作为权威字段注入（移动端自称不可信）。
- **不可抹除**：远程事件与本地事件同库同游标；撤销设备的审计保留（撤销 ≠ 删除记录）。
- **对账**：`approval-resolved.request_id`（`remote:{deviceId}:{seq}`）与
  `remote-command` 审计可按序对账，检测「裁决记录缺失」异常（TH-20）。

---

## 7 拒绝服务与滥用

### 7.1 端口暴露面（M-LIMIT-1）

| 项 | 设计 | 依据 |
|----|------|------|
| 默认状态 | **服务关闭**（不监听任何端口） | D-01，对齐 `dev_mcp.rs:22` |
| 开启方式 | `multi_device.enabled = true`（配置面 §8.4） | 显式动作 |
| 默认端口 | 8456（可配 1024~65535，冲突则拒绝启动并报错） | 高位非常用端口 |
| 绑定地址 | `lan` 模式绑 `0.0.0.0`；调试模式绑 `127.0.0.1`；**禁止**无配置直接绑定 0.0.0.0 | 暴露面最小化 |
| 防火墙 | 首次开启时提示用户配置系统防火墙规则（仅允许必要来源网段，可选） | 纵深防御 |
| 关闭 | 服务关闭立即 close 监听 + 断开全部会话 | 即刻收敛 |

### 7.2 连接数限制（M-LIMIT-2）

| 指标 | 上限 | 超额行为 |
|------|------|----------|
| 每设备并发连接 | 2 | 新连接拒绝（`too-many-connections` 结构化错误 + 审计） |
| 总并发连接 | 8 | 同上 |
| 连接队列 | 16 | 队列满 → 立即拒绝（不排队等待） |
| 握手超时 | 10s | 超时关闭 |
| 空闲读超时 | 10s | 关闭 + 释放槽位 |

### 7.3 速率限制（M-RATE）

| 面 | 限速 | 超额行为 |
|----|------|----------|
| 握手（每源 IP） | 5 次/分钟 | 拒绝 + 审计 `remote-auth` blocked |
| 令牌认证失败（每设备） | 5 次累计 | 设备标记「需重新配对」+ 审计 |
| 令牌认证失败（每源 IP） | 10 次/分钟 | IP 锁定 15 分钟 + 审计 |
| 配对尝试（每 pairId） | 5 次（§3.2） | 配对会话销毁 + 审计 |
| 配对尝试（每源 IP） | 10 次累计 | IP 锁定 15 分钟 |
| 命令请求（每连接） | 60 次/分钟 | 限流错误 + 审计 `remote-command` blocked |
| 事件订阅 | 每连接 1 个订阅 | 重复订阅拒绝 |

### 7.4 失败锁定与退避

- 锁定记录在内存（`Mutex<HashMap<IpAddr, LockoutInfo>>`），服务重启清零（可接受：
  攻击者要重启服务需本地访问，此时威胁等级已不同）；
- 退避策略：指数退避（15 分钟 → 30 分钟 → 60 分钟，按 IP 累计）；
- 锁定状态对合法用户可恢复：桌面端「安全中心」面板可手动解除（解除本身入审计）。

### 7.5 滥用防护补充

- **帧大小**：JSON 帧 ≤ 1 MB；超限直接断连 + 审计；
- **慢速攻击**：读超时 10s 覆盖半帧传输；
- **广播风暴**：移动端订阅的事件流按 run 过滤 + 按会话背压（复用
  `event_backpressure` 分级，Delta 级事件不推远程——远程推送只承载
  Critical/Soft 级，避免低频带宽被刷）；
- **连接计费**：异常断连（非 close 帧）计一次「坏连接」，每设备 10 次/小时 →
  暂停该设备 1 小时。

### 7.6 限速器实现设计（令牌桶 + 锁定状态机）

**数据结构**（`multi_device/limiter.rs`）：

```rust
/// 滑动窗口计数 + 锁定状态（按键：源 IP / deviceId / pairId）
struct LimitBucket {
    window_start_ms: u64,
    count: u32,
    locked_until_ms: Option<u64>,   // 锁定到期时间（指数退避）
    lock_strikes: u32,              // 连续锁定次数（退避基数）
}

/// 限速规则表（§7.3 表格的机器可读形态）
struct RateRule {
    key: KeyKind,        // SourceIp | DeviceId | PairId | Session
    window: Duration,    // 1min / 1h
    limit: u32,          // 5 / 10 / 60
    lock_on_exceed: Option<Duration>,   // None = 只计数不锁定
}
```

**算法要点**：

1. 滑动窗口：`window_start_ms` + `count` 实现（窗口内计数清零即可，无需环形缓冲）；
   高精度场景可用时间分桶（P2）。
2. 锁定状态机：命中锁定 → `locked_until_ms = now + base * 2^strikes`
   （15min → 30min → 60min 封顶）；锁定期间对应键的所有请求直接拒绝（快速失败，
   不做计数，防拒绝路径自身被刷）。
3. 内存清理：bucket 表按 last_used 惰性淘汰（窗口滑动自然过期），上限 4096 键，
   满则先淘汰最久未用——防攻击者用随机 IP 打爆内存（配合总连接上限，攻击面收敛）。
4. 并发安全：`tokio::sync::Mutex<HashMap<K, LimitBucket>>`；每个 bucket 的检查
   与推进在单锁内完成（毫秒级操作，不跨 await）。
5. 审计：锁定的**首次**触发记审计（decision=blocked），后续同键拒绝不再刷审计
   （防审计面自身被 DoS 刷爆）；解锁动作（手动/到期）记审计。

**压力下限验证**（§9 T-12/T-13 的断言依据）：

- 100 并发连接：连接层拒绝（总连接 8），握手成功数 ≤ 8；
- 单 IP 1000 次配对尝试：配对成功数 ≤ 5，第 6 次起锁定；
- 单设备 100 次命令：成功 ≤ 60/min，其余 rate-limited；
- 慢速帧：10s 内未收到完整帧 → 断开，占用的连接槽释放。

### 7.7 安全中心（桌面端本地管理面）

「安全中心」是桌面端本地 UI 面板（不进远程白名单），聚合展示与干预：

| 功能 | 内容 |
|------|------|
| 服务开关 | 启用/停用多端服务（停用 = 断开全部 + 停止监听） |
| 设备列表 | §3.4 注册表全字段 + 在线状态 + 撤销入口 |
| 配对面板 | 生成配对码/QR + 当前配对请求实时列表（IP/设备名/时间）+ 拒绝按钮 |
| 限速与锁定 | 当前锁定键列表 + 手动解除 + 解除审计 |
| 审计查询 | 远程事件流过滤（deviceId/时间/决策） |
| 证书管理 | 查看指纹 + 一键轮换（轮换 = 全部设备重配对提示） |

---

## 8 与现有代码融合

> 本章给出「改哪里、怎么改、不改什么」的落点清单。行号为当前分支实测。

### 8.1 approval 状态机扩展点

| 融合点 | 现状 | 改动 |
|--------|------|------|
| 裁决者枚举 | `Arbiter`（`crates/session-loop/src/approval_router.rs:74`）：User / MainAgent | 新增 `Remote { device_id: String }`、`RemoteAndLocal`；`route_approval`（`:100`）/`route_approval_guarded`（`:112`）增加远程来源分支（纯函数，保持可单测） |
| 来源分类 | `classify_source`（`:88`）以 parent_run_id 判定 | 新增 `classify_remote(run_id, device_id)`——远程 run 在装配点携带 `source` 元数据 |
| 请求载荷 | `PermissionRequest`（`crates/conex-types/src/events.rs:196`）已有 `metadata` 字段 | 复用 `metadata.arbiter=remote:{deviceId}`（沿用 `arbiter_metadata` 先例 `approval_router.rs:174`） |
| 审批门 | `ApprovalGateImpl`（`apps/agent-workbench/src-tauri/src/core_run_commands.rs:161`） | **不改核心逻辑**：`request_approval`（`:263`）广播路径复用；新增一个 `RemoteApprovalBridge` 订阅 `approval-requested` 并转发远程 + 把移动端裁决帧转 `resolve`（`:230`） |
| 裁决命令 | `core_approve_tool`（`:3750`）/ `core_deny_tool`（`:3777`） | 不动（本地面）；远程网关内部复用同一 `ApprovalGateImpl.resolve` + `emit_approval_resolved`（`:3802`） |
| 超时 | `APPROVAL_TIMEOUT=120s`（`:88`） | 不变；远程展示层提示「桌面端可能无人值守」 |
| 伪造防护 | pending 集合 NotFound 校验（`:235-245`） | 原样继承（TH-13 缓解） |

### 8.2 permission 分级扩展

| 融合点 | 现状 | 改动 |
|--------|------|------|
| 权限模式 | `PermissionMode`（`crates/agent-tools/src/permission.rs:19`） | 不变（三态足够；远程上限由装配层强制，不污染引擎语义） |
| 模式解析 | `from_engine_str`（`:32`） | 不变（安全默认 ask） |
| 判定入口 | `decide`（`:78`）、`decide_with_redline`（`:96`）、`decide_command`（`:113`）、`decide_command_with_revert`（`:135`） | 不变——远程 run 与本地 run 共用同一判定链，红线不可豁免语义天然成立 |
| 远程上限 | —— | 新增装配函数 `apply_remote_mode(requested: PermissionMode) -> PermissionMode`（`min(requested, Ask)`，Plan 不变），在远程网关 run 装配点调用；降级动作发 `remote-mode-downgrade` 审计 |
| 命令面 | `conex-sandbox/src/lib.rs` gatekeeper（blocked `:24` / approval `:51` / `check_command` `:76` / `check_command_with_context` `:121`） | 不变——远程 run 的 shell 工具同样过 gatekeeper |
| 远程白名单 | `command_manifest.rs` 注册表机制 | 新增对偶 `remote_command_registry!`（`remote_manifest.rs`）：(路由名, 实现路径, 所需能力级)；`remote_command_names` 常量供测试锁定 |
| 命令级拒绝 | `config/credentials.rs:237-341` 五命令 | 每个命令签名增加来源校验（`source: CommandSource`，本地 webview / 远程网关）；非本地来源 → `CoreError::Forbidden`（`core_error.rs` 新增 code） |

### 8.3 redact 复用

| 复用面 | 现状 | 用法 |
|--------|------|------|
| `crates/conex-telemetry/src/redact.rs` | **不存在**（本会话确认：conex-telemetry 无 redact 模块；实际打码先例在 browser 侧） | 新增：`mask_token(hash 前缀)`、`mask_pairing_code`、`mask_secret_keywords`（复用 `redact_url_query` 的键值打码形态） |
| `config/credentials.rs` K-05（`:256`） | provider key 日志 last4 | 作为打码先例引用，token 打码强度高于 last4（hash 前缀） |
| `crates/conex-browser-tools/src/helpers.rs:204` `redact_url_query` | URL 查询参数打码 | 远程帧日志的 URL 字段直接复用 |
| `crates/conex-browser/src/snapshot/redact.rs:79` `redact_attributes` | 属性打码 | 远程事件载荷序列化前的兜底过滤参考 |

打码装配点（远程网关日志层）：

```text
远程网关所有 tracing 宏 → 统一经 redact 适配层（sensitive 字段先打码再记录）
审计事件构造 → security_audit_event 输入已打码字符串（构造器不接触明文）
```

### 8.4 配置面（服务开关/端口/白名单）

| 项 | 现状 | 设计 |
|----|------|------|
| provider 配置 | `PersistedProviderConfig`（`config/persistence.rs:20-29`） | 不混入；**新增独立** `multi-device-config.json`（复用原子写 `tmp + rename` `:64-81`） |
| 配置字段 | —— | `{ enabled: bool, port: u16, bind: "lan"\|"loopback", tokenTtlDays: u32, maxDevices: u32, requireLocalConfirm: bool }` |
| 校验 | `sanitize_profile_secret_id`（`:93`）白名单先例 | 端口范围校验（1024~65535）、枚举值校验；非法值拒绝启动 |
| 环境变量 | `dev_mcp.rs:22` `CRISH_MCP_SOCKET=1` 精确匹配先例 | 可选 `CRISH_MULTI_DEVICE=1`（仅调试捷径，配置面仍以配置文件为准） |
| 服务装配 | `main.rs` setup 序列（`:11-25`） | 新增 `multi_device::register_if_enabled(builder, state)`（对齐 `dev_mcp::register_if_enabled` `:58` 模式）；**release 构建双保险**：注册点 `#[cfg(debug_assertions)]` 隔离 + 服务自身 `enabled` 校验 |

### 8.5 事件面新增（注册表纪律）

事件变更纪律（`crates/conex-types/src/events.rs:1-12` 头注 + `tests/registry_drift.rs` 锁定）：

1. `AgentEvent` 新增变体须同步：
   - `contracts/engine-events.json`（事件注册表）；
   - `scripts/generate-engine-bindings.mjs` 生成产物
     `packages/shared-types/src/generated/engine/**`；
   - `engine_event_type_names!`（`events.rs:810`）与 `event_backpressure`（`:867`）；
   - `tests/registry_drift.rs`、`tests/events_roundtrip.rs`、`tests/events_schema_version.rs`。
2. 新增变体清单（本设计冻结）：

| 事件 | 用途 |
|------|------|
| `remote-pair-requested` | 配对会话创建（含 pairId 哈希、过期时间） |
| `remote-pair-resolved` | 配对结果（success/denied/expired/locked） |
| `remote-session-event` | 会话建立/挂起/关闭（复用 security-audit 亦可，二选一——本设计**优先复用 SecurityAudit + operation 扩展**，仅当审计面板需要独立检索时才新增事件） |
| `remote-mode-downgraded` | 权限模式降级通知（数据面，可经 security-audit `remote-mode-downgrade` 承载） |

**推荐最小方案**：不新增 AgentEvent 变体，全部远程动作走
`SecurityAuditOperation` 扩展（§6.2 七变体）+ `remote_device_id` 可选字段
（serde 缺省兼容，对齐 `PermissionRequest` 的 `requester_run_id` 扩展先例
`events.rs:207-217`）——注册表/生成产物/前端类型只需增补 operation 枚举与一个
可选字段，改动面最小且不破坏既有 41 事件。

### 8.6 融合清单汇总

| # | 文件 | 改动类型 | 内容 |
|---|------|----------|------|
| 1 | `crates/conex-types/src/events.rs` | 增 | `SecurityAuditOperation` 七变体；`SecurityAudit` 加 `remote_device_id` 可选字段 |
| 2 | `contracts/engine-events.json` + 生成产物 | 同步 | 注册表/绑定（纪律 §8.5） |
| 3 | `crates/conex-types/tests/registry_drift.rs` 等 | 增 | 新 operation 往返/兼容测试 |
| 4 | `crates/conex-telemetry/src/redact.rs` | 新增 | 令牌/配对码/敏感键打码纯函数 |
| 5 | `crates/agent-tools/src/audit.rs` | 增 | `remote_audit_event` 便捷构造器（带 device_id） |
| 6 | `crates/session-loop/src/approval_router.rs` | 增 | `Arbiter::Remote/RemoteAndLocal`；远程路由纯函数 |
| 7 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | 增 | `RemoteApprovalBridge`（订阅转发 + 裁决转 resolve）；`apply_remote_mode` |
| 8 | `apps/agent-workbench/src-tauri/src/config/credentials.rs` | 增 | 五命令 `source` 校验（remote → Forbidden） |
| 9 | `apps/agent-workbench/src-tauri/src/multi_device/mod.rs` | 新增 | 服务装配/监听/连接管理/限速/审计打码层（大模块，按 §2/§3/§7 拆分） |
| 10 | `apps/agent-workbench/src-tauri/src/multi_device/remote_manifest.rs` | 新增 | 远程白名单注册表（§4.5） |
| 11 | `apps/agent-workbench/src-tauri/src/main.rs` | 增 | `register_if_enabled` 装配 + release 双保险 |
| 12 | `apps/agent-workbench/src-tauri/src/config/persistence.rs` | 增 | `multi-device-config.json` 读写 + 校验 |
| 13 | `crates/conex-types/src/error.rs`（CoreError） | 增 | `Forbidden`/`TooManyRequests`/`LockedOut` code |
| 14 | `apps/agent-workbench/src-tauri/src/core_error.rs` | 增 | 远程网关错误映射 |

---

## 9 安全测试

### 9.1 威胁场景测试清单（手动 + 自动化双轨）

> 编号 T-01~T-14。自动化列：Rust 单测（`cargo test`）、壳集成（workbench 测试面）、
> 手工脚本（`scripts/` 下新增，纳入仓库——AGENTS.md 铁律：测试是资产）。

| 编号 | 场景 | 攻击面 | 预期行为 | 验证方式 |
|------|------|--------|----------|----------|
| T-01 | 伪造端：无令牌直连 | 握手后认证 | TLS 可通（证书有效），token 认证失败 → 断开 + `remote-auth` denied 审计 + 失败计数 | Rust 集成（起测试服务，伪造 auth 帧） |
| T-02 | 伪造端：窃听获得令牌后重放 | 认证 | 令牌非一次性设计下**可重放**——缓解：会话密钥 8h 过期 + 心跳 + 审计发现异常多端同令牌并发（同一 deviceId 双会话告警） | Rust 集成（同令牌并发连接 → 超限拒绝） |
| T-03 | 中间人：ARP 欺骗 + 伪造证书 | TLS | pinning 校验失败 → 握手失败；无降级到 ws 的路径 | 手工（Wi-Fi 热点 + 伪造 CA）；自动化（测试客户端注入错误指纹断言拒绝） |
| T-04 | 中间人：强制降级 ws:// | 传输 | 服务端不提供 ws 端点（403）；客户端拒绝 ws scheme | 自动化（ws 握手请求 → 断言拒绝 + 审计） |
| T-05 | 配对码暴力 | 配对 | 5 次失败销毁会话 + IP 锁定 15 分钟 + 审计 | Rust 单测（限次/锁定状态机） |
| T-06 | 令牌窃取：日志泄露 | 日志 | 全链路无明文（§6.3 打码铁律） | 自动化 grep 测试（日志扫描令牌/配对码形态） |
| T-07 | 权限提升：远程调 `config_secret_reveal` | 白名单 + 命令级 | 白名单拒绝 + `remote-source-attempt` 审计 + Forbidden 错误 | Rust 集成 + 手工抓包 |
| T-08 | 权限提升：远程指定 full-access | run 装配 | 降级 ask + `remote-mode-downgrade` 审计；run 内危险工具仍 NeedsApproval | Rust 集成（装配断言） |
| T-09 | 密钥不出桌面 | 数据面 | 移动端任何响应/事件流中不存在 provider key 形态（`sk-` 前缀等） | 自动化（远程事件流快照扫描）+ 代码评审（白名单复核） |
| T-10 | 审批伪造：对不存在 tool_call_id 发批准 | 审批门 | `resolve` NotFound（`core_run_commands.rs:235-245`）→ 错误 + 无 approval-resolved 落地 | Rust 单测（复用既有 I-02 测试扩展） |
| T-11 | 撤销即时性：撤销后旧令牌重连 | 设备管理 | 撤销立即生效：注册表删除 + 活动会话强断 + 重连被拒 + 审计 | Rust 集成 |
| T-12 | DoS：连接洪水 | 连接管理 | 超限拒绝（每设备 2/总量 8）+ 队列拒绝 + 审计 | Rust 集成（并发连接压力） |
| T-13 | DoS：慢速/超长帧 | 帧层 | 读超时 10s / 帧 ≤1MB 断连 | Rust 集成 |
| T-14 | 双轨确认：桌面在场 + 移动端批准危险操作 | 审批路由 | 双轨确认：桌面端弹窗 → 任一方拒绝即拒绝；无人值守 → remote-only 审计标记 | Rust 单测（路由纯函数）+ 手工（双端联调） |

### 9.2 测试矩阵（能力 × 模式）

| 移动端能力 | 请求模式 | 生效模式 | 危险工具行为 | 红线工具行为 |
|------------|----------|----------|--------------|--------------|
| observe | plan | plan | Deny（不弹窗） | Deny |
| observe | ask（越权申报） | plan（能力截断） | Deny | Deny |
| approve | plan | plan | Deny | Deny |
| approve | ask | ask | NeedsApproval → Remote 裁决（无人值守 single / 在场双轨） | Deny |
| approve | full-access | ask（降级 + 审计） | NeedsApproval | Deny |
| operate | ask | ask | NeedsApproval | Deny |
| operate | full-access | ask（降级 + 审计） | NeedsApproval | Deny |

### 9.3 门禁与回归

- 新增远程相关测试进**快层**（`npm run test:coverage -- --project=unit` 与
  `cargo test --workspace`），红线上限语义（TH-12/红线）必须有对应单测；
- 事件契约测试（registry_drift / events_roundtrip / events_schema_version）在
  operation 扩展后必须全绿——这是「新增审计类别不破坏既有事件」的回归锚；
- 手工威胁演练（T-03/T-07/T-14）记录到本目录评审报告，不设自动化门禁
  （需真实网络环境）。

### 9.4 测试用例目录（函数级清单）

> 命名空间建议：`multi_device::{pairing,auth,session,limiter,gateway,tls,redact}`。
> 下列用例为 §9.1 场景的展开，实现时按此清单落 `#[test]` 并在合并前全绿。

**pairing 模块（配对协议）**

| 用例 | 断言 |
|------|------|
| `pair_code_entropy_40bits` | code 长度为 8、字符集 32（base32 去歧义字符） |
| `pair_success_is_single_use` | 成功配对后同一 code 再次提交 → pair-not-found |
| `pair_five_failures_destroys` | 第 5 次错误提交 → 会话销毁 + 审计 blocked |
| `pair_expiry_ten_minutes` | 伪造时间（注入时钟）超 10min → expired |
| `pair_constant_time_compare` | code 比较路径无长度/时序分支（审计代码或依赖 subtle 库断言） |
| `pair_qr_contains_fingerprint` | QR 载荷含 CA 指纹字段 |
| `pair_ip_lockout_ten_strikes` | 同 IP 10 次失败 → 锁定 15min（退避起算） |
| `pair_session_not_persisted` | 配对会话不落盘：重启后旧 pairId 无效 |

**auth 模块（令牌认证）**

| 用例 | 断言 |
|------|------|
| `auth_success_derives_session_key` | 认证成功返回 8h 会话密钥（HKDF 派生，与令牌不同） |
| `auth_rejects_wrong_token` | 错误令牌 → auth-denied token-invalid + 失败计数 |
| `auth_five_failures_requires_repair` | 设备累计 5 次 → 标记需重配对 |
| `auth_expired_token_rejected` | 过期令牌 → token-expired |
| `auth_revoked_device_rejected` | 已撤销 deviceId → device-revoked |
| `auth_hash_storage_no_plaintext` | 注册表文件不含令牌明文（序列化后扫描） |
| `auth_salt_per_device_random` | 两设备盐不同（注册表断言） |
| `auth_nonce_replay_rejected` | 重复 clientNonce → 拒绝 |

**session 模块（会话生命周期）**

| 用例 | 断言 |
|------|------|
| `session_heartbeat_timeout_suspend` | 60s 无心跳 → suspended；5min → 销毁 |
| `session_ttl_eight_hours` | 会话密钥到期后命令 → 需要重新认证 |
| `session_revoked_disconnects_active` | 撤销 → 活动连接 ≤1s 断开（事件断言） |
| `session_command_idempotency` | 同 requestId 重复命令只执行一次 |
| `session_frame_ordering` | 乱序/重复 seq 帧被拒绝 |
| `session_connection_limits` | 每设备 2 / 总量 8 / 队列 16 全部拒绝路径 |

**limiter 模块（限速与锁定）**

| 用例 | 断言 |
|------|------|
| `limiter_window_slides` | 窗口滑动后计数归零 |
| `limiter_exponential_backoff` | 锁定时长 15/30/60 递增，封顶 60min |
| `limiter_first_lock_audits_once` | 首次锁定审计一次，后续不刷 |
| `limiter_bucket_cap_4096` | 超 4096 键淘汰最久未用 |
| `limiter_manual_unlock_audited` | 安全中心解锁 → 审计 |

**gateway 模块（远程命令面）**

| 用例 | 断言 |
|------|------|
| `gateway_whitelist_deny_unknown` | 未知命令 → Forbidden + remote-source-attempt |
| `gateway_capability_gate` | observe 调 remote.approve → Forbidden |
| `gateway_secret_commands_denied` | config_secret_reveal 远程路由 → Forbidden（白名单层） |
| `gateway_approve_wrong_tool_call` | 不存在的 tool_call_id → NotFound（resolve 校验继承） |
| `gateway_mode_downgrade_audit` | full-access 申报 → ask + 审计降级 |
| `gateway_remote_actor_in_audit` | 远程命令审计含 device_id（权威注入，非自报） |

**tls 模块（传输面）**

| 用例 | 断言 |
|------|------|
| `tls_ws_rejected` | ws:// 握手 → 403 + 审计 |
| `tls_wrong_fingerprint_rejected` | 指纹不匹配的 CA → 握手失败（移动端对偶测试） |
| `tls_weak_cipher_absent` | ServerConfig 密码套件清单不含弱套件 |
| `tls_cert_rotation_invalidates_old` | 轮换后旧指纹连接失败 |

**redact 模块（打码）**

| 用例 | 断言 |
|------|------|
| `redact_token_masks_full` | 43 字符令牌 → 输出 12 hex 前缀，无原文子串 |
| `redact_pairing_code_masks` | 8 字符码 → 哈希前缀 |
| `redact_keyword_values` | password/token/api_key 键值 → `***`（复用 redact_url_query 形态） |
| `redact_log_scan_e2e` | 跑典型远程会话 → 日志扫描零命中（T-06） |

### 9.5 回归门禁接线

- `cargo test --workspace`：新增模块（pairing/auth/session/limiter/gateway/tls/redact）
  随 workspace 跑；**红线与降级语义用例进快层**（不放慢层，防回归窗口）。
- `npm run test:coverage -- --project=unit`：事件契约测试（registry_drift 等）在
  operation 扩展后必须全绿（§8.5 纪律）。
- 壳集成（`core_run_commands.rs` 测试面同构）：`RemoteApprovalBridge` 的
  「广播 → 远程裁决 → resolve → approval-resolved 落库」闭环测试，断言事件序列与
  落库字节（对齐现有 `emit_approval_resolved` 测试风格 `core_run_commands.rs:9367`）。
- 手工演练（T-03/T-07/T-14 的网络依赖项）不设自动门禁，但**必须**在评审报告记录
  结果（AGENTS.md：测试是资产，结果也是）。

---

## 10 设计决策记录与开放问题

### 10.1 决策记录（ADR 摘要）

| 决策 | 结论 | 否决选项 |
|------|------|----------|
| 传输协议 | wss 强制 + 自签 CA pinning（D-02） | ① ws 明文（TH-04/TH-08 不可接受）；② 公网证书（局域网不可用 + 系统信任链风险） |
| 配对码 | **D3 §4.1 CXN-12 字符 base32（2^60）** + 5 次 + 10 分钟 + 一次性【裁决修正 1：原 8 字符 base32 作废】 | ① 4 位数字码（2^13，暴力可行）；② 长密码（体验差，收益边际） |
| 令牌存储 | 桌面端 sha256(salt‖token) 走 DPAPI 槽；移动端系统密钥库 | ① 明文落盘（TH-18）；② 仅内存（重启丢配对） |
| 授权模型 | 能力分级 + 远程上限 ask + 双轨确认 | ① 远程 full-access（TH-12 结构性问题）；② 纯白名单命令面（对文件/终端间接性不足——实际上本设计是白名单 + 引擎权限面双层） |
| 审计方案 | 复用 security-audit + operation 扩展（最小面） | 新增 5+ 独立事件（注册表/前端生成物改动面大） |
| 服务默认态 | 关闭（D-01） | 默认开启（默认暴露面 = 默认攻击面） |

### 10.2 开放问题

| 编号 | 问题 | 当前倾向 | 决策方 |
|------|------|----------|--------|
| O-01 | 中继/公网路径的端到端加密原语是否本模型冻结 | 冻结帧加密（AEAD+序列号），中继不可见 | 主 Agent + relay 方案 |
| O-02 | PTY 输入通道（operate 级终端输入转发）是否进首版 | 首版不做（P2），先跑通 run+审批闭环 | 主 Agent |
| O-03 | 设备公钥双重认证（配对时提交 deviceKey） | P2：令牌 + 设备签名双因子 | 主 Agent |
| O-04 | 移动端生物识别门禁 | P2 增强（§5.2） | 主 Agent |
| O-05 | 事件流推送到移动端的范围（observe 是否含消息全文） | 首版只推元数据 + 审批/终态事件 | 主 Agent（隐私权衡） |
| O-06 | 多桌面端（一台手机控多台电脑） | 单桌面端单机模型先行；注册表天然支持多机（设备表按桌面实例隔离） | 主 Agent |

### 10.3 安全验收红线（实现完成前必须全绿）

1. `multi_device.enabled=false` 时无任何端口监听（netstat 断言）。
2. 远程 run 无法获得 full-access（装配断言 + 审计断言）。
3. 红线命令经远程通道一律 Deny（复用现有红线单测矩阵跑远程变体）。
4. 日志扫描测试（T-06）零明文命中。
5. `config_secret_*` 远程来源 100% Forbidden（白名单 + 命令级双层）。
6. 撤销设备 ≤1s 内断开全部活动连接（集成测试断言）。
7. 全部远程动作产生 `remote-*` 审计且打码（审计完整性抽查）。

### 10.4 分期建议

| 阶段 | 范围 | 出口条件 |
|------|------|----------|
| M0（本模型落地） | §8.6 融合清单 1-14 + §9 自动化测试 | 验收红线 1-7 全绿 |
| M1（首版联调） | 配对 + 令牌 + observe/approve 能力 + 双轨确认 | T-01/T-05/T-07/T-10/T-11/T-14 手工演练通过 |
| M2（operate 增强） | run 发起 + 事件推送范围扩展 + O-02 | 移动端端到端 run+审批闭环 |
| P2（可选增强） | O-03 设备公钥、O-04 生物识别、中继面端到端加密 | 按主 Agent 排期 |

> 【裁决修正 9】阶段映射：M0 → R1（桌面服务端，随 D2 交付）；M1 → R1 收尾 +
> R2 前端（移动端基础）；M2 → R2（operate 能力）；P2 可选增强 → R2/R4 随排期。

---

## 附录 A 术语表

| 术语 | 定义 |
|------|------|
| 配对（pairing） | 移动端首次接入桌面端的信任建立流程（§3.1-3.2） |
| 设备令牌（device token） | 配对成功后签发给移动端的长期凭证（§3.3） |
| 远程网关 | 桌面端内承载 wss 监听/认证/白名单/限速/审计的新增模块（§8.6 #9） |
| 远程命令白名单 | 远程通道唯一可调用的引擎能力清单（§4.5） |
| 双轨确认 | 危险操作需要移动端 + 桌面端本地用户共同确认的机制（§4.4） |
| 打码（redact） | 敏感物在日志/审计中的确定性脱敏（§6.3） |
| pinning | 客户端固定校验服务端 CA 公钥指纹的 TLS 信任模式（§2.2） |
| 能力分级 | 移动端 observe/approve/operate 三级授权（§4.1） |

## 附录 B 代码位置索引

| 符号 | 位置 |
|------|------|
| `PermissionMode` / `PermissionVerdict` | `crates/agent-tools/src/permission.rs:19/57` |
| `decide` / `decide_with_redline` / `decide_command` / `decide_command_with_revert` | `permission.rs:78/96/113/135` |
| `SecurityAuditSink` / `security_audit_event` | `crates/agent-tools/src/audit.rs:23/109` |
| `AgentEvent`（41 变体） | `crates/conex-types/src/events.rs:306` |
| `PermissionRequest` | `events.rs:196` |
| `ApprovalDecision` | `events.rs:225` |
| `ApprovalRequested` / `ApprovalResolved` | `events.rs:480/488` |
| `SecurityAudit` 事件 | `events.rs:560` |
| `SecurityAuditOperation` | `events.rs:66` |
| `event_backpressure` | `events.rs:867` |
| `AgentEventEnvelope` | `events.rs:922` |
| `ApprovalGate` trait / `ApprovalRequester` | `crates/session-loop/src/tool_events.rs:101/88` |
| `ApprovalSource` / `Arbiter` / `route_approval` | `crates/session-loop/src/approval_router.rs:60/74/100` |
| `ApprovalGateImpl` / `resolve` / `request_approval` | `core_run_commands.rs:161/230/263` |
| `core_approve_tool` / `core_deny_tool` / `emit_approval_resolved` | `core_run_commands.rs:3750/3777/3802` |
| `APPROVAL_TIMEOUT` | `core_run_commands.rs:88` |
| `spawn_audit_persistence` / `audit_persist` | `core_run_commands.rs:500/390` |
| `RoutingAuditSink` | `apps/agent-workbench/src-tauri/src/engine.rs:698` |
| `CredentialStore`（DPAPI） | `apps/agent-workbench/src-tauri/src/config/credentials.rs:31` |
| `config_secret_reveal`（ui_confirm） | `credentials.rs:319` |
| K-05 last4 日志 | `credentials.rs:256` |
| `sanitize_profile_secret_id` | `apps/agent-workbench/src-tauri/src/config/persistence.rs:93` |
| gatekeeper blocked/approval 正则 | `crates/conex-sandbox/src/lib.rs:24/51` |
| `CommandGatekeeper::check_command` | `conex-sandbox/src/lib.rs:76` |
| `TaskAuditRecord` / `build_task_audit_event` | `crates/orchestrator/src/task_events.rs:258/293` |
| MCP socket 加固先例（loopback + env 门） | `apps/agent-workbench/src-tauri/src/dev_mcp.rs:22/58/65` |
| `command_registry!` | `apps/agent-workbench/src-tauri/src/main.rs:79` |
| 事件注册表纪律（头注） | `crates/conex-types/src/events.rs:1-12` |
| 配置原子写先例 | `apps/agent-workbench/src-tauri/src/config/persistence.rs:64-81` |
| URL 打码先例 | `crates/conex-browser-tools/src/helpers.rs:204` |
| 属性打码先例 | `crates/conex-browser/src/snapshot/redact.rs:79` |

## 附录 C 参考规范与最佳实践

| 主题 | 参考 | 本设计对应 |
|------|------|-----------|
| TLS 配置 | RFC 8446（TLS 1.3）、OWASP Transport Layer Protection Cheat Sheet | §2.5 检查清单 |
| 证书 pinning | OWASP Certificate and Public Key Pinning；Mozilla「pinning 建议仅用于自有服务」 | §2.2（自建 CA + SPKI 指纹） |
| 密钥派生 | HKDF（RFC 5869）、AES-256-GCM（RFC 5116） | §3.3 会话密钥派生、§3.6.5 帧加密 |
| 配对码 | 一次性密码（HOTP/TOTP 的对抗原则：限次 + 过期 + 一次性） | §3.2 |
| 令牌存储 | OWASP Secrets Management；Apple/Google 平台密钥库指南 | §5.2 |
| 哈希存储 | 带随机盐的 SHA-256（令牌无低熵问题，无需慢哈希） | §3.3 |
| 审计 | NIST SP 800-92 日志管理（完整性/不可篡改） | §6.4 |
| 限速 | RFC 6585（429 语义）、滑动窗口算法 | §7.3/§7.6 |
| 移动端对偶 | iOS Keychain 指南 / Android Keystore 指南（实现侧） | §5.2（契约由本文档冻结） |

## 附录 D 端到端场景走查（验收演练脚本）

### D-1 正常闭环：移动端发起 run + 审批 + 完成

```text
1. 桌面端开启多端服务 → 配对面板生成 QR（含指纹）
2. 移动端扫码 → wss 连接（TLS 指纹校验通过）→ pair-request → pair-ok（存令牌）
3. 移动端断线重连 → auth-request → auth-ok（能力=observe+approve）
4. 用户升级操作能力（桌面端安全中心勾选 operate）→ 移动端重新认证
5. 移动端 remote.run_task（mode=ask）→ 桌面端装配 run（模式 ask）
6. run 内 shell 工具触发 NeedsApproval → approval-requested 推移动端
7. 桌面端本地用户在场 → 双轨：移动端确认 + 桌面端弹窗确认
8. 双方确认 → remote.approve → resolve(tc-1) → run 继续 → run-terminal
9. 全程审计：remote-auth / remote-session / remote-command / 审批事件 全落库、打码合规
```

### D-2 攻击场景：伪造端企图批准不存在的审批

```text
1. 攻击者伪造移动端（无令牌）→ 连接层拒绝（auth-denied）+ 审计
2. 攻击者获得合法令牌（窃取）→ 认证通过 → 尝试 remote.approve(run-9, tc-fake)
3. 网关白名单通过（命令合法）→ resolve(tc-fake) → NotFound（pending 集合校验）
4. 审计：remote-command denied（not-found）
5. 并发告警：同 deviceId 出现第二会话 → 安全中心告警 → 用户撤销该设备
```

### D-3 攻击场景：中间人试图解密会话

```text
1. 攻击者 ARP 欺骗，把移动端流量导向伪造服务端
2. 伪造服务端出示自签证书 → 移动端指纹校验失败 → 握手失败（无降级路径）
3. 攻击者尝试 ws:// 明文 → 服务端 403 + 审计 remote-auth blocked
4. 攻击者抓包 → 全帧密文（TLS 1.3），无会话密钥 → 不可读
5. 结论：即使攻击者完全掌控局域网，也无法建立会话（指纹）+ 无法读流量（TLS）
```

### D-4 应急响应：手机丢失

```text
1. 桌面端安全中心 → 设备列表 → 撤销「我的 iPhone」（1s 内断开活动会话）
2. 令牌条目删除（注册表）+ DPAPI 槽清除 + 审计 remote-device revoked
3. 移动端 Keychain 数据无法远程擦除（iOS 限制）——缓解：令牌 30 天过期 +
   双轨确认规则保证「仅持机者」无法单独批准危险操作（桌面在场时）
4. 若怀疑桌面端也被接触：轮换 CA + 撤销全部设备 + 重置服务
```

### D-5 无人值守场景：桌面离席、移动端操作

```text
1. 桌面端锁屏 15 分钟 → local_user_present = false
2. 移动端 run 内 dangerous 工具 → NeedsApproval → 单一远程裁决（remote-only 审计标记）
3. 红线工具 → 一律 Deny（与桌面是否在场无关）
4. full-access 申报 → 降级 ask + 审计
5. 事后审计可完整回放：谁（deviceId）在什么时间批准了什么
```

---

*文档结束。本模型为 D5 子代理产出，供主 Agent 汇总与评审；实现前需按 §10.3
验收红线逐条走查。*
