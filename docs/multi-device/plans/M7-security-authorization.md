# M7 安全整合与功能级授权矩阵设计（安全模型细化 + 账号体系整合）

- **文档编号**：M7
- **状态**：设计稿（供主控评审）
- **日期**：2026-08-09
- **作者**：子代理 M7（安全整合与授权矩阵）
- **定位**：把安全模型（D5）细化为**功能级授权矩阵**（F1-F6 每个功能在移动端的权限级别）与
  **账号体系整合**（账号中心 token 与设备/中继凭证的关系），并补全验证分层、审计整合、
  威胁复查、安全测试清单与合规提示。
- **上游输入**：
  - `docs/multi-device/plans/D5-security.md`（安全模型母方案，本方案的一切控制措施编号
    M-xx 均继承其编号体系，新增控制措施编号从 M-VERIF 起）；
  - `docs/multi-device/plans/AC-account-center-evaluation.md`（账号中心评估结论：需调整，
    新增 push_tokens 与 relay_credentials 模块）；
  - `docs/multi-device/plans/F1-monitor-panels.md`、`F2-approval-center.md`、
    `F3-event-stream-terminal.md`、`F4-files-assets.md`、`F5-session-messages.md`、
    `F6-settings-account.md`（六个功能域设计）；
  - `docs/multi-device/plans/D3-protocol.md`（配对与消息级鉴权：X25519 + 配对码派生）、
    `D1-overall-architecture.md`（总体架构与中继角色）、`D7-push-notifications.md`（推送）。
- **代码证据**：
  - `C:\Software\conex\crates\agent-tools\src\permission.rs`（权限三态 + 红线先行 +
    C3 回退护栏）；
  - `C:\Software\conex\apps\agent-workbench\src-tauri\src\core_run_commands.rs`（审批门
    ApprovalGateImpl / resolve / APPROVAL_TIMEOUT）；
  - `C:\Software\conex\apps\agent-workbench\src-tauri\src\config\credentials.rs`（DPAPI
    密钥槽 / K-02 last4 / config_secret_* 命令面）。
- **查证记录**：本方案 §9 合规内容经 webfetch 查证（Expo 官方文档 expo-notifications /
  expo-network，2026-08-09 抓取）；Apple/Android 官方文档页无法直接抓取（要求
  JavaScript），相关事实以既有惯例与公开资料为准并标注「待实现期复核」项。

---

## 目录

- [0 执行摘要](#0-执行摘要)
- [1 授权模型总纲：能力等价 + 验证分层](#1-授权模型总纲能力等价--验证分层)
- [2 功能级授权矩阵（核心章节）](#2-功能级授权矩阵核心章节)
- [3 验证分层设计（四级）](#3-验证分层设计四级)
- [4 账号体系整合](#4-账号体系整合)
- [5 密钥边界重申](#5-密钥边界重申)
- [6 审计整合](#6-审计整合)
- [7 威胁复查（D5 增量）](#7-威胁复查d5-增量)
- [8 安全测试清单](#8-安全测试清单)
- [9 合规提示](#9-合规提示)
- [10 开放问题与决策记录](#10-开放问题与决策记录)
- [附录 A 术语表](#附录-a-术语表)
- [附录 B 代码位置索引](#附录-b-代码位置索引)
- [附录 C 查证记录与参考](#附录-c-查证记录与参考)

---

> 【裁决修正 9】阶段映射：本方案无独立阶段（随 D5 落地）——授权矩阵/四类令牌
> 冻结于 **R0 协议冻结**（认证方案裁决 10 在此关闭）；验证分层实现随 R1 桌面
> 服务端（D2 网关）+ R2 移动端基础；合规面随 R3 推送。

## 0 执行摘要

### 0.1 结论先行

**「移动端与桌面同权」的正确语义是：能力面相同 + 验证面分级。**

- **能力面相同（等价）**：同一台桌面端上，移动端与桌面端可以触达**同一集合的引擎能力**
  ——同样的命令面、同样的白名单、同样的审批裁决入口、同样的文件读写范围。不是「移动端
  只能看」的阉割版，也不是「移动端多出一套特权」的增强版。
- **验证面分级（差异只出现在验证路径上）**：差异不在「能不能做」，而在「做到之前要
  经过几道确认」。四道验证等级（普通 / 敏感 / 危险 / 极危，§3）把「执行成本」按风险
  抬高，但**不改变「可以执行」这一事实本身**。
- 桌面端本地操作**永远快**（已持有解锁态的 webview 会话 + 本地用户在场判定）；
  移动端操作在相同能力上增加**验证分层**：普通操作直接、敏感操作一次解锁、危险操作
  生物识别 + 二次确认 + 冷却、极危操作双端在场。这是 D-05/D-07（远程上限 ask + 双轨
  裁决）的功能级细化。

一句话：**同权回答「能不能」，验证分层回答「怎么才让做」。**

### 0.2 关键决策清单（结论先行）

| 编号 | 决策 | 一句话理由 | 章节 |
|------|------|-----------|------|
| M-01 | 授权矩阵按「能力 × 操作 × 等级」三维展开，功能域为行、验证等级为列 | 单一维度矩阵无法表达「同一功能内读与写风险不同」 | §2 |
| M-02 | 四级验证（L0 普通 / L1 敏感 / L2 危险 / L3 极危）替换 D5 的两级（确认/双轨） | 覆盖 D5 未细化的「生物识别」「冷却时间」「解锁时机」 | §3 |
| M-03 | 移动端所有**写类**操作都必须能在审计中回溯到「设备 + 验证证据」 | 验证分层必须能被审计证明，否则分层只是 UI 装饰 | §6 |
| M-04 | 四类令牌（配对令牌 / 账号 token / 中继凭证 / 推送注册）各司其职，**不互相代替** | 局域网信任、云端身份、长连接身份、推送寻址是四个不同问题 | §4 |
| M-05 | 账号 token 不需要两端一致：两端各自登录同一账号、各自持有会话 | 同身份多设备会话是账号中心的既有语义，令牌共享反而扩大泄露面 | §4.9 |
| M-06 | 远程写操作（文件写、设置变更）默认关闭，逐项显式开启 | 与 F4 编辑模式开关、F6 桌面确认通道对齐；「同权」≠「默认开写」 | §2.4/§2.6 |
| M-07 | 审计权威始终在桌面端本地库，移动端只读展示 | 移动端可丢可被攻破，不可成为审计的写入方 | §6.4 |
| M-08 | 新增威胁全部收敛到既有控制面 + 五个新控制措施（M-VERIF/M-BATCH/M-CONFIRM/M-RELAY/M-PUSH） | 不新增与 D5 平行的第二套安全体系 | §7 |

### 0.3 本方案的定位与边界

| 项 | 说明 |
|----|------|
| 细化对象 | D5 的 §4 授权模型（能力分级 / 双轨确认）与 §3.6 协议面之外的「功能级落点」 |
| 冻结对象 | D5 的传输层（wss + pinning）、配对协议（D3）、限速/锁定（M-LIMIT/M-RATE）、
  打码（M-REDACT）**一律不改**，本方案只引用 |
| 新增对象 | 四级验证模型、功能授权矩阵、令牌全景、账号中心扩展接线、审计扩展、威胁增量、测试清单、合规清单 |
| 不做对象 | 不做移动端代码审计（D5 §0.4 声明继续成立）；不做中继服务实现（引用
  `AC-account-center-evaluation.md` §6.4 的 Rust 中继选型结论） |
| 与 F 系列关系 | F1-F6 定义「做什么」，本方案定义「做之前要过什么门」；F 系列的安全引用
  （如 F2 §9.2 双因素、F4 §7 安全边界）以本方案为权威接口 |

### 0.4 与 D5 的继承关系（编号对齐承诺）

本方案全部控制措施编号沿用 D5 的 M-xx 体系：

| D5 已有（继承） | 本方案新增 |
|----------------|-----------|
| M-PAIR 配对码 / M-TOKEN 设备令牌 / M-CERT 证书 pinning / M-AUTH 通道认证 /
  M-GATE 审批门 / M-MODE 权限模式上限 / M-REG 远程白名单 / M-KEY 密钥边界 /
  M-AUDIT 审计 / M-REDACT 打码 / M-LIMIT 限流 / M-REVOKE 撤销 / M-SESSION 会话 | M-VERIF 验证分层 / M-BATCH 批量防护 /
  M-CONFIRM 桌面确认通道 / M-RELAY 中继凭据 / M-PUSH 推送注册安全 / M-ACCT 账号中心强化 / M-OUTBOX 离线队列防重放 |
| 威胁编号 TH-01 ~ TH-20（D5 §1.3） | 威胁编号 TH-21 ~ TH-31（§7，移动功能增量） |

### 0.5 阅读指南

- 只想确认「某功能在手机上要过什么门」→ 直接看 §2 矩阵（含汇总表）。
- 想理解「四级验证怎么实现」→ §3。
- 想理解「四类令牌谁签发谁验证」→ §4.1-§4.7；「账号中心要改什么」→ §4.8。
- 想评审安全面完整性 → §5（密钥边界）、§6（审计）、§7（威胁复查）。
- 想落地测试 → §8；想上线合规 → §9。

---

## 1 授权模型总纲：能力等价 + 验证分层

### 1.1 用户「移动端与桌面同权」的语义解析

用户诉求原文（多端互通需求）：「移动端与桌面同权」。这句诉求有三个可能的解读，
必须钉死语义，否则授权矩阵会建错地基：

| 解读 | 内容 | 采用？ |
|------|------|--------|
| A. 能力平权 | 移动端能触达的能力集合 == 桌面端能触达的能力集合（同一台桌面机上） | **采用（主解读）** |
| B. 无差别执行 | 移动端与桌面端执行同一操作时，经过完全相同的确认路径 | **不采用**：移动端是低信任终端（可丢、可被他人持有，D5 T-01），验证路径必然不同；「相同路径」会让桌面端的安全水位被移动端拉低 |
| C. 特权对等 | 移动端在桌面端无人时也拥有桌面端的一切权限（含 full-access / 配置面） | **不采用**：与 D-05（远程上限 ask、无 admin）结构性冲突；该解读等于把移动端变成无人值守终端的万能钥匙 |

本方案的承诺（对应解读 A）：

1. 同一引擎能力，移动端可触达的命令面与桌面端**完全同源**（远程白名单是桌面命令面的
   对偶子集，D5 D-11）；
2. 审批裁决（允许/拒绝/记住）与桌面端**同一入口、同一语义**（F2 §10.1 已冻结）；
3. 文件读写范围与桌面端**同一工作区沙箱**（F4 §5.1 已冻结）；
4. 差异只出现在验证路径：解锁、二次确认、双端在场、冷却（§3）。

### 1.2 能力面相同（等价）：六条等价原则

| # | 等价原则 | 证据/落点 |
|---|----------|-----------|
| E1 | **命令面等价**：远程白名单（`remote_manifest.rs`，D5 §4.5）是桌面命令面
  （`command_manifest.rs`）的登记子集，任何命令的远程形态与本地形态执行同一实现路径 | D5 §4.5 表格 + §4.6.3 dispatch_remote_command |
| E2 | **权限判定等价**：远程 run 与本地 run 共用 `decide_with_redline` /
  `decide_command_with_revert` 判定链，红线不可豁免语义两端一致 | `crates/agent-tools/src/permission.rs:96/135` |
| E3 | **审批裁决等价**：移动端允许/拒绝调用与桌面相同的 `core_approve_tool` /
  `core_deny_tool` → 同一 `resolve`（`core_run_commands.rs:230`），先到者胜 | F2 §10.1；`core_run_commands.rs:3750/3777` |
| E4 | **白名单等价**：移动端「记住此命令」写入桌面端同源白名单（`addCommandPermission`
  语义），且继承 `shouldAutoApproveCommand` 的极危硬拒绝门禁 | F2 §10.1/§10.2；approvalHandlers.ts:66-97 |
| E5 | **文件面等价**：移动端读写走桌面端既有 `fs_commands`（list/read/write），
  WorkspaceRegistry 沙箱（`workspace.rs:185-244`）两端同一份 | F4 §2.1/§5.1 |
| E6 | **状态面等价**：移动端看到的状态是桌面端事件的投影，不发明第二套状态机
  （F1 §5「手机端不持有状态机，只消费事件做展示投影」） | F1 §5.6；D3 §7 原样透传 |

六条等价原则的推论：**验证分层绝不能改变等价原则**。任何「移动端做不了 X」的例外，
都必须先回到 §2 矩阵确认 X 的等级；矩阵之外的例外一律不允许（即矩阵是封闭的，D5
§4.5「显式不进白名单」清单是矩阵的封闭边界）。

### 1.3 验证面分级（差异只出现在验证路径上）

验证分层在**不改变能力集合**的前提下，把「执行成本」按风险抬升：

```text
能力集合（两端相同，§1.2 E1-E6）
   │
   ▼
验证路径（按操作等级分四档）
   L0 普通  → 直接执行（观察类）
   L1 敏感  → 应用锁解锁一次（会话内有效）
   L2 危险  → 生物识别 + 滑动二次确认 + 冷却 5s
   L3 极危  → 生物识别 + 双端在场确认（双轨）+ 冷却 30s
   │
   ▼
引擎判定（两端相同，permission.rs 三态 + 红线先行）
   Allow → 执行并审计（含验证证据）
   NeedsApproval → 回审批门（等待裁决）
   Deny（红线/plan）→ 拒绝并审计
```

关键点：**验证分层是引擎上层的门，不是引擎内的分支**。引擎侧没有「远程验证级别」
这个概念——移动端网关在发起命令前完成验证并生成 `verification_token`（短期、一次性、
随命令载荷提交），引擎/网关只校验 token 有效性 + 落审计。这样：

1. 引擎判定链零改动（`permission.rs` 三态不变，D5 §8.2 声明继续成立）；
2. 验证证据可审计（§6 的 `remote-command` 审计记录携带 `verification: "biometric+slide"`）；
3. 未来升级验证手段（如 FIDO2）只改移动端门 + token 格式，引擎无感。

### 1.4 验证门判定函数（伪代码级契约）

```rust
/// 验证分层判定（纯函数，可单测；部署在移动端网关层与桌面端远程网关双层）
///
/// 输入：
///   - level: VerificationLevel   // L0/L1/L2/L3（由 §2 矩阵给出）
///   - unlock: AppUnlockState     // app 是否已解锁、解锁方式（biometric/pin）、解锁时刻
///   - op_context: OpContext      // 操作上下文（命令名/参数摘要/危险度/是否写类）
///   - cooldown: CooldownState    // 上次验证时刻（防疲劳）
/// 输出：VerificationGate（Pass { evidence } / RequireUnlock / RequireBiometric /
///       RequireSecondConfirm / Deny { reason }）
fn verify(level, unlock, op_context, cooldown) -> VerificationGate {
    // 1. 等级映射（§3 的四级表；等级由授权矩阵查表，禁止调用方自报）
    // 2. L0：直接 Pass（无需验证证据，审计记 level=L0）
    // 3. L1：要求 app 已解锁（解锁 = PIN/生物任一，会话内有效，见 §3.6）
    // 4. L2：要求本次操作前 60s 内完成过生物识别 + 提供二次确认手势证据
    //       （滑动阈值 ≥ 70%）；且距上次 L2+ 操作 ≥ 5s（冷却）
    // 5. L3：L2 全部要求 + 桌面端在场（dual_presence，见 §3.5）+ 距上次 ≥ 30s
    // 6. 任何失败路径都返回可解释的原因（给 UI 文案，不静默失败）
}
```

双层校验：**移动端本地门**（防误触、提供 UI 反馈，可被绕过但不提供能力）+ **远程网关
门**（验证 `verification_token` 有效性 + 等级与命令匹配，是安全真值）。移动端本地门
被绕过（改包）时，远程网关门因 token 缺失/等级不匹配而拒绝——对齐 D5 §4.6.3
「能力是服务端裁决的」原则。

### 1.5 与既有权限引擎的关系（映射表）

| 引擎概念（permission.rs） | 本方案概念 | 关系 |
|---------------------------|-----------|------|
| `PermissionMode`（Ask/FullAccess/Plan，`:19`） | 远程 run 的上限（D5 M-MODE） | 远程不存在 full-access；验证分层不改模式，只加执行门 |
| `PermissionVerdict`（Allow/Deny/NeedsApproval，`:57`） | 引擎判定结果 | 验证分层在「请求进入引擎之前」执行；引擎结果不变 |
| `decide_with_redline`（`:96`） | 红线不可豁免 | 红线命令在矩阵中标「不可审批不可豁免」（§2.1 封闭规则 2），验证分层根本不触达 |
| `decide_command_with_revert`（`:135`） | C3 大面积回退 | 回退类审批请求在移动端按危险度 2 呈现（F2 危险级别 2 的第三个来源） |
| `ApprovalGateImpl.resolve`（`core_run_commands.rs:230`） | 审批裁决唯一入口 | 移动端决策经网关转 resolve；验证证据随请求提交，`resolve` 不感知 |

### 1.6 授权判定总流程（决策流图）

```text
移动端用户操作
   │
   ▼
① 查授权矩阵（§2）→ 得到 { 所需能力级, 验证等级, 是否可配置 }
   │（矩阵是编译期注册表 + 配置面双层：remote_manifest 登记能力级，
   │  验证等级由命令的 risk_class 声明）
   ▼
② 能力级检查（服务端权威，D5 §4.6.3 require_capability）
   │  未达标 → Forbidden + 审计（remote-source-attempt / capability-denied）
   ▼
③ 验证门（§1.4 verify()）
   │  L0 → 通过；L1-L3 → 解锁/生物/滑动/双端在场 + 冷却
   │  任一失败 → 可解释拒绝；L2+ 失败记 remote-verification-failed 审计
   ▼
④ 生成 verification_token（短期一次性，绑定命令名 + requestId + 设备）
   ▼
⑤ 网关白名单 + 幂等（D5 §4.6.3：whitelist → capability → rate-limit → idempotency）
   ▼
⑥ 引擎执行（permission.rs 判定链，红线先行）
   │  Allow → 执行 → 审计（actor=deviceId, verification=证据）
   │  NeedsApproval → 审批门（F2 闭环，双轨规则 D5 §4.4）
   │  Deny → 拒绝 + 审计
   ▼
⑦ 审计落库（桌面本地权威，§6）
```

**流程闭环断言**：任何远程命令必须经过 ②③⑤⑥ 四道门才能执行；任何一道门的失败
都必须能在审计中找到对应记录（⑦）。这是 §8 测试清单中「门禁全覆盖」断言的依据。

---

## 2 功能级授权矩阵（核心章节）

### 2.1 矩阵阅读说明

**列定义**：

| 列 | 含义 |
|----|------|
| 功能（编号） | F 系列功能编号，对应 F1-F6 文档 |
| 操作 | 该功能在移动端的具体操作（读/写/决策/配置） |
| 能力级 | 需要的最小移动端能力：`observe`（只读观察）/ `approve`（审批裁决）/ `operate`（发起与操作）/ `admin`（仅桌面端，移动端不可获取，D5 §4.1） |
| 默认授权 | 未配置时的默认等级：`allow`（直接放行）/ `verify`（L1 解锁即可）/ `confirm`（L2 二次确认）/ `dual`（L3 双端在场） |
| 危险度 | `普通` / `敏感` / `危险` / `极危` 四档（对应 §3 的 L0-L3；危险度是矩阵的输入，等级是验证的输出，二者按 §3.1 表映射） |
| 双因素 | 是否需要双端在场 / 双因素验证：`否` / `可配`（默认关）/ `是`（强制） |
| 可配置 | 该操作是否允许用户配置（降级或升级）：`固定`（不可改）/ `可降`（可放宽，需桌面端确认）/ `可升`（可加强，配置开关在桌面端） |

**危险度定义（与 F2 §2.2 的危险级别对齐并扩展）**：

| 危险度 | 定义 | 典型信号 |
|--------|------|----------|
| 普通 | 只读、无副作用、无敏感信息 | 查询类命令、状态投影 |
| 敏感 | 只读但涉及敏感信息（密钥形态/敏感文件路径/会话全文） | 敏感文件读取、诊断明细、审计明细、会话历史 |
| 危险 | 写类或破坏性，可被回滚或影响面可控 | 审批允许、文件覆盖写、发起 run、批量操作、设置变更、撤销配对 |
| 极危 | 不可逆或双端利益冲突面最大 | 双轨危险审批（配置开启时）、删除类（若未来开放）、全部设备重置 |

**矩阵封闭规则**（D5 §4.5 的封闭边界）：

1. 矩阵外命令 = 不在远程白名单 = `Forbidden` + `remote-source-attempt` 审计；
2. 红线命令在矩阵中标 `redline`，任何等级不可执行（D5 §4.2/§10.3 第 3 条）；
3. `admin` 能力（设备管理/服务开关/配置修改）只出现在桌面端，矩阵中对应列恒为「—」；
4. 能力级是**服务端裁决**（D5 §4.1 铁律 2），矩阵中「能力级」列是服务端注册表的值，
   不是移动端自报值。

### 2.2 F1 监控与状态面板授权矩阵

数据源：`F1-monitor-panels.md` §2.1（Q1-Q12 查询面）/§6（只读边界）。本域全部功能
只读（F1 §6.1 结论），能力级恒 `observe`，验证等级大部分 L0，涉及敏感字段的为 L1。

| 功能 | 操作 | 能力级 | 默认授权 | 危险度 | 双因素 | 可配置 | 备注 |
|------|------|--------|----------|--------|--------|--------|------|
| F01 连接状态条 | 查询连通性（core_get_status 子集） | observe | allow | 普通 | 否 | 固定 | 首页常驻，锁屏可见（§3.6 例外项 D） |
| F02 核心状态卡 | 查询 engineReady/dbReady/搜索索引/模型名 | observe | allow | 普通 | 否 | 固定 | providerStatus 只取 model 名与 credentialMode，不含密钥形态（D5 §5.1） |
| F03 活动任务列表 | 查询 activeRuns + pendingApprovals | observe | allow | 普通 | 否 | 固定 | 待审批**计数**可 L0 展示；**裁决动作**归 F2（L2/L3） |
| F04 run 详情页 | 查询 run snapshot + 事件时间线 | observe | verify | 敏感 | 否 | 固定 | 事件时间线含工具入参（可能含命令行/路径），L1 解锁后可见（F3 §5.2 工具详情同） |
| F05 会话列表 | 查询会话元数据（标题/时间/计数） | observe | verify | 敏感 | 否 | 固定 | 会话标题可能泄露业务内容，F6 §11.2 提供「标题混淆」本机开关 |
| F06 三态规范 | 空态/加载态/离线态 | observe | allow | 普通 | 否 | 固定 | 无数据面，无门 |
| F07 用量与成本摘要 | 查询 tokens/费用（run 级 + 累计） | observe | verify | 敏感 | 否 | 固定 | 费用数据无密钥形态，但属账户私有数据 |
| F08 缓存指标卡 | 查询命中率/浪费预警 | observe | allow | 普通 | 否 | 固定 | cache-waste-alert 推送含金额（低敏感，可 L0） |
| F09 后台任务列表 | 查询任务列表/终态 | observe | verify | 敏感 | 否 | 固定 | task 输出尾部可能含日志敏感行，F3 同规则 |
| F10 待审批徽标 | 查询 pendingApprovals 计数 | observe | allow | 普通 | 否 | 固定 | 角标只显数字，不显载荷（推送载荷由 F2 的门保护） |
| F11 诊断页 | 查询 diagnostics/lastError/logDir | observe | verify | 敏感 | 否 | 固定 | logDir 路径 + 最近错误可能含路径/参数形态 |
| F12 错误横幅 | 查询 snapshot.error / runtime 事件 | observe | verify | 敏感 | 否 | 固定 | error 全文可能含敏感参数（打码后展示，M-REDACT 复用） |
| F13-F18（P2） | 流程概览/定时/审计列表/任务输出/缓存徽标/快照健康 | observe | 按各功能最严项取 L1 | 敏感 | 否 | 固定 | F15 审计列表取 L1（见 §6.3） |
| 监控域全部操作命令 | core_run_control / core_cancel_run / core_approve_tool / core_deny_tool /
  workbench_cancel_background_task / workbench_send_input / core_rebuild_search_index | — | **拒绝** | — | — | — | F1 §6.3 网关强制：监控域白名单只含只读清单，操作命令默认拒绝（结构化错误 `domain_readonly`） |

F1 矩阵结论：**监控域 = observe + L0/L1 两级**；操作面零开放。这是「同权」在监控域
的正确形态：桌面 Overview 面板能看的，手机上都能看；桌面 Overview 面板的按钮（允许/
拒绝/取消），手机上不在本域渲染（F1 §6.2 第 5 条 UI 铁律），统一收口到 F2。

### 2.3 F2 审批中心授权矩阵

数据源：`F2-approval-center.md`。本域是移动端唯一的裁决面（写操作入口），验证分层
最重。危险级别沿用 F2 §2.2 的 L1/L2（注意：F2 的「L1/L2」是危险级别，本方案的
「L0-L3」是验证等级，两者命名不同——本文档 F2 行内用「危险度」列表达，避免混淆）。

| 功能 | 操作 | 能力级 | 默认授权 | 危险度 | 双因素 | 可配置 | 备注 |
|------|------|--------|----------|--------|--------|--------|------|
| F2-01 待办列表 | 查询待审批集合（mobile_list_pending_approvals 对账） | approve | verify | 敏感 | 否 | 固定 | 列表含工具名/参数摘要，L1 解锁后可读；系统通知只带摘要（F2 §6.2） |
| F2-02 审批详情 | 查询单条请求全量参数 | approve | verify | 敏感 | 否 | 固定 | 参数含命令行/路径，L1 门（推送 data 只带摘要，全量参数对账后拉取，F2 R3） |
| F2-03 决策：允许（危险度 1） | 发送 core_approve_tool | approve | verify | 危险 | 否 | 固定 | 【裁决修正】AU1 P2-9：默认授权改标 verify（L1）——「单点决策 + 300ms 防抖」是 L1 强度（解锁态），滑动仅用于危险度 2（F2 §5.3）；原标 confirm（L2）与备注矛盾 |
| F2-03 决策：允许（危险度 2） | 发送 core_approve_tool | approve | confirm | 危险 | 可配（默认关） | 可升 | 滑动 ≥70% 触发（F2 §5.3）；双因素「桌面在场」开启后升级为 L3（F2 §9.2） |
| F2-03 决策：拒绝 | 发送 core_deny_tool（可带理由） | approve | confirm | 危险 | 否 | 固定 | 拒绝是安全方向，不设双因素（F2 §9.2：拒绝不应被拦截） |
| F2-03 决策：记住此命令 | 写桌面白名单 addCommandPermission | approve | confirm | 危险 | 否 | 固定 | 继承极危硬拒绝门禁（F2 §10.2）；批量模式不提供记住（F2 §5.4） |
| F2-04 危险操作二次确认 | L2 滑动（UI 门） | approve | confirm | — | — | — | 提交前 UI 校验，不改引擎语义（F2 §10.2） |
| F2-05 推送触发 + 深链 | 接收通知 → 深链详情 | approve | allow | 普通 | 否 | 固定 | 通知即摘要；深链落地页再走 L1/L2 门 |
| F2-06 历史记录 | 查询已处理/已过期 | approve | verify | 敏感 | 否 | 固定 | 含拒绝理由/参数摘要，L1 |
| F2-07 离线决策队列 | 本地排队 + 断网补发 | approve | confirm | 危险 | 否 | 固定 | 补发必须携带原验证证据（新验证 token 需重验，防离线伪造，§7 TH-30） |
| F2-08 批量处理（允许） | 批量 core_approve_tool | approve | confirm | 危险 | 否 | 固定 | **仅危险度 1 且剩余 >30s**（F2 §5.4）；批量允许前确认层；逐条发送 |
| F2-08 批量处理（拒绝） | 批量 core_deny_tool | approve | confirm | 危险 | 否 | 固定 | 允许全量拒绝（安全方向） |
| F2-09 双因素桌面在场 | 查询 device_presence_query | approve | allow | 普通 | 否 | 固定 | 状态条展示；开启后危险度 2 允许升级 L3（§3.5） |
| F2-10 主 agent 裁决只读卡片 | 查看子代理请求详情 | observe | verify | 敏感 | 否 | 固定 | 无决策按钮（F2 §4.4），仅展示 |

F2 矩阵结论：

1. **读**（列表/详情/历史）全部 L1：锁屏后必须解锁一次才能看到审批内容——系统通知
   摘要之外的细节不对锁屏态暴露；
2. **写**（允许/拒绝/记住）全部危险度：允许分两档（危险度 1 单击、危险度 2 滑动 +
   可选双因素），拒绝单点；
3. **批量允许被结构性约束**：只允许危险度 1 且非临期条目（F2 §5.4），这是 M-BATCH
   控制措施的功能级落点；
4. **双端并发**：先到者胜 + NotFound 冲突收敛（F2 §11.2），验证分层不改变该语义——
   后到者的验证证据再充分，也改变不了「已处理」的事实（引擎真值优先）。

### 2.4 F3 事件流与终端授权矩阵

数据源：`F3-event-stream-terminal.md`。本域全部只读（F3 §4.5 终端能力对照：手机端
PTY stdin 输入 ✗），能力级 `observe`。

| 功能 | 操作 | 能力级 | 默认授权 | 危险度 | 双因素 | 可配置 | 备注 |
|------|------|--------|----------|--------|--------|--------|------|
| 事件流 feed | 订阅/渲染 run 事件时间线 | observe | verify | 敏感 | 否 | 固定 | 含消息正文/工具卡，L1 |
| feed 过滤 | 只看错误/只看当前 run/只看工具 | observe | verify | 敏感 | 否 | 固定 | 过滤是本地渲染动作，随 feed 等级 |
| 终端流卡片 | 渲染 shell 流式输出（只读） | observe | verify | 敏感 | 否 | 固定 | 输出含命令/路径形态；F3 §4.4 截断策略不变 |
| 工具详情页 | 查看完整入参 JSON + 输出全文 | observe | verify | 敏感 | 否 | 固定 | 入参可能含密钥形态参数 → 展示层打码（M-REDACT）后仍属 L1 |
| 错误详情页 | 查看错误全文 + FAQ | observe | verify | 敏感 | 否 | 固定 | 「回桌面处理」深链 = 触发桌面端打开对应 run（写类，见下行） |
| 「回桌面处理」动作 | 发深链让桌面端定位 run | observe | confirm | 危险 | 否 | 固定 | 本域唯一的写类动作（桌面 UI 跳转），L2 单击确认即可 |
| 点击跳转（深链） | 事件 → 详情/审批/会话路由 | observe | allow | 普通 | 否 | 固定 | 路由跳转本身无数据面；目标页的门由目标域执行 |
| audit-card 展开 | 查看安全审计条目明细 | observe | verify | 敏感 | 否 | 固定 | 含 targets 路径列表，L1（§6.3 与 F15 同口径） |
| 通知触发点 | 13 类事件 → 本地通知 | observe | allow | 普通 | 否 | 固定 | F3 §7.4 清单；审批类通知摘要受 F2 门保护 |
| PTY 输入（stdin） | 交互式终端输入 | — | **拒绝** | — | — | — | F3 §4.5：手机端只读，交互归后续版本评估（D5 O-02 一致） |

### 2.5 F4 文件与资产授权矩阵

数据源：`F4-files-assets.md`。本域是「同权」争议最大的域（读写都涉及工作区文件），
矩阵按 F4 §4 的读写策略逐项钉死。

| 功能 | 操作 | 能力级 | 默认授权 | 危险度 | 双因素 | 可配置 | 备注 |
|------|------|--------|----------|--------|--------|--------|------|
| F4-F01 工作区列表 | 查询已授权根（workbench_list_workspaces） | observe | verify | 敏感 | 否 | 固定 | 根路径可能含用户名等敏感成分 |
| F4-F02 工作区切换 | 切换活动根（mobile_switch_active_workspace / workbench_open_workspace） | observe | confirm | 危险 | 否 | 固定 | 改变桌面活动根是写桌面状态；切换前展示目标根 + 确认 |
| F4-F03 工作区状态 | 查询可达性/未授权态 | observe | allow | 普通 | 否 | 固定 | 错误态展示，无数据泄露 |
| F4-F10 目录列表 | list_directory 代理 | observe | verify | 敏感 | 否 | 固定 | 目录名即路径信息；锁屏后需解锁 |
| F4-F11 树形浏览 | 懒展开子目录 | observe | verify | 敏感 | 否 | 固定 | 同上 |
| F4-F20 文本/代码查看 | read_file_content 分块读取 | observe | verify | 敏感 | 否 | 固定 | 普通文件 L1；敏感文件（.env 等）额外规则见下行 |
| F4-F28 敏感文件读取 | 读 .env/密钥/凭证类 | observe | confirm | 危险 | 否 | 可升 | 横幅警示 + 不缓存（F4 §7.1）；本方案升级为 **L2 确认**（敏感规则命中即二次确认，防锁屏下被持机者逐字浏览） |
| F4-F21/F22/F23/F24/F26/F27 | 渲染类（高亮/md/表格/图片/二进制/截断提示） | observe | verify | 敏感 | 否 | 固定 | 纯本地渲染，随数据等级 |
| F4-F25 PDF 摘要 | 元数据 + 系统打开 | observe | verify | 敏感 | 否 | 固定 | 不传内容（F4 §5.3） |
| F4-F30 复制路径 | 复制相对/绝对路径 | observe | verify | 敏感 | 否 | 固定 | 路径可粘贴到外部；敏感文件路径本身允许复制（F4 §7.1），但敏感文件内容不分享 |
| F4-F31 分享/导出 | 系统分享文本 / 导出链接 | observe | confirm | 危险 | 否 | 可升 | 分享是「出域」动作（内容离开 app），L2；敏感文件分享被拒（F4 §7.1） |
| F4-F32 编辑文本文件 | write_file_content 覆盖写 | operate | confirm | 危险 | 否 | **可降/可升** | 编辑模式开关默认关（F4 §4.3 闸门 1）；覆盖写前二次确认（闸门 2）；敏感文件禁写（闸门 3）；仅文本（闸门 4） |
| F4-F33 新建文件 | write_file_content（新建） | operate | confirm | 危险 | 否 | 可降 | 新建无需覆盖确认，但需编辑模式开启 + 目标目录展示 |
| F4-F34 删除/重命名/移动 | workbench_fs_delete_file 等 | operate | **默认不开放** | 极危 | — | 固定 | F4 §4.3：V1 明确不开放；如需开放必须走写权限矩阵审批（本方案：按 L3 双端在场 + 桌面确认通道，P2 再议） |
| F4-F40 本地文件名过滤 | 本地纯函数过滤 | observe | allow | 普通 | 否 | 固定 | 无网络面 |
| F4-F41 递归文件名搜索 | mobile_search_files → fuzzy_find | observe | verify | 敏感 | 否 | 固定 | 结果限 100 条（F4 §5.5） |
| F4-F42 内容搜索 | mobile_grep_search → grep_search | observe | confirm | 危险 | 否 | 可升 | P2；内容搜索默认排除敏感文件（F4 R4-2）；文件级模式 + 行级显式拉取；本方案定 L2（搜索结果本身就是内容外传面） |
| F4-F43 搜索结果定位 | 定位到浏览树 | observe | verify | 敏感 | 否 | 固定 | 随浏览等级 |
| M4-4 资源代理 URL（图片/PDF） | mobile_asset_url → 短期令牌 URL | observe | verify | 敏感 | 否 | 固定 | URL 10 分钟有效 + 仅授权根内相对路径（F4 §5.4）；令牌过期即失效 |
| M4-6 缩略图 | mobile_file_thumbnail | observe | verify | 敏感 | 否 | 固定 | 缩略图缓存 24h；敏感文件不生成缩略图（F4 §7.3 口径） |
| 路径校验 | SDK 层拒绝绝对路径/NUL/bidi | observe | allow | 普通 | 否 | 固定 | 本地校验（F4 §7.2），桌面沙箱兜底 |

F4 矩阵结论：

1. **读全开**（与桌面同权）：所有已授权工作区文件可浏览、可读（F4 §4.1）；
2. **敏感文件读要过 L2**：这是本方案在 F4 之上的安全增量——F4 原设计「可读 + 横幅 +
   不缓存」，本方案加「解锁之外再确认一次」，理由是敏感文件内容是持机攻击（D5 T-01）
   的直接目标，且内容出域窗口的后果不可逆；
3. **写受控开放**：编辑模式（默认关）+ 覆盖确认 + 敏感禁写 + 仅文本，四闸门与 F4 §4.3
   完全对齐；「可降」仅指用户可在设置中开启编辑模式（开启动作本身经桌面确认通道，
   §2.7 的 M-CONFIRM）；
4. **删除类 V1 不做**：矩阵标「默认不开放」，未来开放时须同时满足「桌面确认通道 +
   L3 双端在场 + 审计」，避免移动端单向删除。

### 2.6 F5 会话与消息授权矩阵

数据源：`F5-session-messages.md`。P1 只读，P2 委托执行（发起 run）。

| 功能 | 操作 | 能力级 | 默认授权 | 危险度 | 双因素 | 可配置 | 备注 |
|------|------|--------|----------|--------|--------|--------|------|
| 会话列表 | 查询标题/时间/未读（list_sessions 投影） | observe | verify | 敏感 | 否 | 固定 | F6 §11.2 标题混淆开关联动 |
| 会话详情（消息流） | 分页拉取消息 + 渲染 | observe | verify | 敏感 | 否 | 固定 | 消息正文含会话内容，L1 |
| 实时会话 | 订阅消息增量 | observe | verify | 敏感 | 否 | 固定 | 打开会话时解锁一次即可 |
| 历史会话查看 | 游标分页拉取 | observe | verify | 敏感 | 否 | 固定 | F5 §2.4 |
| 消息操作：复制/转发/引用 | 本地文本操作 | observe | verify | 敏感 | 否 | 固定 | 复制是出域动作，随消息等级；敏感会话可关（F6 §11.4） |
| 发起会话/任务（P2） | mobile 委托执行 core_run_task | operate | confirm | 危险 | 否 | 固定 | F5 §2.5：委托执行模式；run 载荷带 `requestOrigin: 'mobile'`（审计溯源）；权限模式由网关强制 min(mode, ask) |
| 消息搜索（会话内） | 本地已加载消息匹配 | observe | verify | 敏感 | 否 | 固定 | F5 §2.6 |
| 服务端全文搜索（P2） | search_sessions 网关新增 | observe | confirm | 危险 | 否 | 固定 | 返回标题/摘要/命中计数；P2 立项时按 L2 定级（搜索请求 = 内容外传面，同 F4-F42 口径） |
| 消息撤回/删除（P2，若做） | 远程改会话数据 | operate | **默认不开放** | 极危 | — | 固定 | 会话是桌面本地权威数据（D1 §5.1 单真相源），远程改写需桌面确认通道 + 双端在场 |

F5 矩阵结论：P1 全部只读（L1），P2 委托执行按 L2；会话数据是桌面权威（D1 §5.1），
移动端**永不直接改写**会话库，与 F4 的「写经命令面」同构。

### 2.7 F6 设置与账户授权矩阵

数据源：`F6-settings-account.md`。本域是「配置面」的唯一入口，也是 D5「admin 不进
移动端」边界（D5 §4.1）的直接压力点。F6 §8.1 结论：手机端不改权限模式，只读展示 +
受限触发；本矩阵把「受限触发」量化为验证等级。

| 功能 | 操作 | 能力级 | 默认授权 | 危险度 | 双因素 | 可配置 | 备注 |
|------|------|--------|----------|--------|--------|--------|------|
| 账户登录/登出/多账号 | 账号中心会话管理 | observe | verify | 敏感 | 否 | 固定 | 登录输入面由账号中心保护（A5 限流）；令牌入钥匙串（§4.9） |
| 会话保持（refresh 静默续期） | 后台自动刷新 | observe | allow | 普通 | 否 | 固定 | 系统级后台任务，无 UI |
| 配对新设备（扫码/输码） | 发起配对流程 | observe | confirm | 危险 | 否 | 固定 | 配对是信任建立（D5 TH-19 QR 钓鱼），本方案定 L2：输入/扫描前确认 + 配对面板目标地址展示 |
| 设备列表（查看） | 查询已配对设备 | observe | verify | 敏感 | 否 | 固定 | 设备名/IP 短显 |
| 设备重命名 | 写设备注册表元数据 | operate | confirm | 危险 | 否 | 固定 | 元数据变更，L2 |
| 设备撤销（本机/远端） | 删除设备注册 + 断连 | operate | confirm | 危险 | 可配（默认关） | 可升 | 二次确认（F6 §6.2）；本方案建议可配置「撤销需双端在场」升级项 |
| 强制断开连接 | 断当前通道（急救） | operate | confirm | 危险 | 否 | 固定 | F6 Q5：急救场景立即生效，不设双因素（桌面确认会卡住急救）；但需 L2 单击确认 |
| 连接方式切换（lan/relay/auto） | 改连接通道 | operate | confirm | 危险 | 否 | 固定 | 3 秒确认窗（F6 §7.1）已内置；本方案定 L2 与确认窗叠加 |
| 服务器地址修改（手动/高级） | 改连接目标 | operate | confirm | 危险 | 可配（默认关） | 可升 | **定点攻击面**（恶意地址 = 中间人第一步，D5 TH-03 变体）；本方案建议默认可配 L3（首次设置需双端在场） |
| 通知设置（本机） | 本机偏好读写 | observe | allow | 普通 | 否 | 固定 | 本机分片，不进桌面 |
| 数据与隐私：缓存清理 | 清本机缓存 | observe | allow | 普通 | 否 | 固定 | 本机数据 |
| 数据与隐私：清空本机数据 | 退出登录流程内 | observe | confirm | 危险 | 否 | 固定 | 二次确认 + 说明（F6 §11.2） |
| 同步范围开关 | 本机同步偏好 | observe | allow | 普通 | 否 | 固定 | 聊天记录漫游开关默认关 + 开启确认（F6 §11.2） |
| 敏感信息显示开关 | 本机隐私偏好 | observe | allow | 普通 | 否 | 固定 | 通知预览/锁屏隐藏等 |
| 应用锁（PIN/生物） | 本机 app 锁设置 | observe | confirm | 危险 | 否 | 固定 | 关闭需输入当前 PIN/生物（防误关安全功能）；开启需二次确认 |
| 权限模式展示 | 只读镜像（config_get 快照） | observe | allow | 普通 | 否 | 固定 | F6 §8.2：手机端不改权限模式 |
| 「在桌面端更改设置」引导 | 深链/二维码跳桌面安全页 | observe | allow | 普通 | 否 | 固定 | 只导航，不写 |
| 暂停自动执行（临时开关） | 发一次性指令锁定桌面工具执行 | operate | confirm | 危险 | 否 | 固定 | F6 §8.2「受限触发」：一次性指令 + 桌面端确认后生效，不改变持久化配置 |
| 回答风格修改 | mobile_settings_apply 桌面确认通道 | operate | confirm | 危险 | 否 | 固定 | F6 §8.3：60s 桌面确认条，nonce 防重放，单队列 |
| 遥测开关（enableAnalytics 等） | 同上通道 | operate | confirm | 危险 | 否 | 固定 | 同上 |
| 权限模式修改 | — | — | **拒绝** | — | — | — | F6 §8.1 红线：移动端禁止改权限模式；入口不存在（F6 T18 断言） |
| 信任命令白名单编辑 | — | — | **拒绝** | — | — | — | F6 §3.3：安全敏感，仅桌面端 |

F6 矩阵结论：

1. **配置面封闭**：权限模式、白名单编辑永久拒绝（admin 边界，D5 §4.1）；
2. **可改的非安全设置走桌面确认通道**（M-CONFIRM）：任何影响桌面引擎状态的变更，
   最终确认权在桌面端（F6 §8.3）；
3. **连接目标（服务器地址）是本域最危险的输入**：升级为可配 L3 的定点攻击防护；
4. 撤销配对/强制断开等设备面操作在 L2，其中撤销可配置升级双端在场。

### 2.8 跨功能横切汇总矩阵（全部远程命令面一览）

> 【裁决修正 5】路由命名统一 `remote.*` 前缀（跨端命令唯一前缀，`cmd.*` 仅桌面
> 内部）；本节 snake_case 路由名（remote.get_status）与 M6 §4 的 camelCase kind
> 名（remote.getStatus）经 §2.9 映射表对齐（AU1 P1-3 关闭），由 remote_manifest
> 注册表 + 生成器锁定，实现时以 M6 kind 名为 wire 真源。

把 §2.2-§2.7 的命令面汇总为一张「网关路由表」，供 `remote_manifest.rs` 注册与
§8 测试直接引用（对齐 D5 §4.5 的远程白名单表格并扩展「验证等级」列）：

| 远程命令（网关路由名） | 能力级 | 验证等级 | 危险度 | 对应引擎实现 | 来源域 |
|------------------------|--------|----------|--------|--------------|--------|
| remote.list_sessions / list_runs / run_snapshot | observe | L0/L1 | 普通/敏感 | core_query 会话面 | F1/F5 |
| remote.subscribe_events | observe | L0 | 普通 | 事件流订阅 | F1/F3 |
| remote.get_status | observe | L0 | 普通 | core_get_status | F1 |
| remote.read_session_events / read_run_events | observe | L1 | 敏感 | core_read_*_events | F1/F3 |
| remote.list_workspaces | observe | L1 | 敏感 | workbench_list_workspaces | F4 |
| remote.switch_workspace | observe | L2 | 危险 | mobile_switch_active_workspace | F4 |
| remote.list_directory | observe | L1 | 敏感 | list_directory | F4 |
| remote.read_file | observe | L1（敏感文件 L2） | 敏感/危险 | read_file_content | F4 |
| remote.write_file | operate | L2 | 危险 | write_file_content | F4 |
| remote.search_files | observe | L1 | 敏感 | mobile_search_files → fuzzy_find | F4 |
| remote.asset_url / thumbnail | observe | L1 | 敏感 | mobile_asset_url / mobile_file_thumbnail | F4 |
| remote.request_approval_list | approve | L1 | 敏感 | 待审批集合快照 | F2 |
| remote.approve / remote.deny | approve | L2（危险度 2 可 L3） | 危险 | resolve 入口（core_run_commands.rs:230） | F2 |
| remote.remember_command | approve | L2 | 危险 | addCommandPermission 桥 | F2 |
| remote.run_task | operate | L2 | 危险 | run 装配面（min(mode, ask)） | F5/F3 |
| remote.cancel_run | operate | L2 | 危险 | cancel 三路径 | F1 操作面（经 F2 审批域） |
| remote.run_control（协作停止/强停） | operate | L2 | 危险 | core_run_control L2/L3 语义 | F1 §6.2 建议 |
| remote.device_rotate_token | operate | L2 | 危险 | 令牌轮换 | F6 |
| remote.device_rename / device_revoke | operate | L2（撤销可 L3） | 危险 | 设备注册表 | F6 |
| remote.force_disconnect | operate | L2 | 危险 | 会话管理 | F6 |
| remote.pair_start / pair_cancel | observe | L2 | 危险 | 配对会话 | F6 |
| remote.settings_apply | operate | L2 | 危险 | mobile_settings_apply（桌面确认通道） | F6 |
| remote.pause_auto_execute | operate | L2 | 危险 | 一次性锁定指令 | F6 |
| remote.list_pending_approvals（对账） | approve | L1 | 敏感 | mobile_list_pending_approvals | F2 |
| remote.presence_query | observe | L0 | 普通 | device_presence_query | F2 |
| remote.heartbeat / remote.close | 全部 | L0 | 普通 | 会话管理 | 公共 |
| config_secret_* 五命令 | — | **拒绝** | 极危 | 白名单排除 + remote_source 拒绝（D5 M-KEY 双层） | 密钥边界 |
| workbench_fs_delete_file / pty_* / run_shell / git_run / host_openers | — | **拒绝** | 极危 | 直接文件/终端/执行面（D5 §4.5 显式不进白名单） | 执行边界 |
| admin 面（设备/服务/配置） | — | **拒绝** | 极危 | 仅桌面端（D5 §4.1） | 配置边界 |

### 2.9 矩阵的机器可读形态（remote_manifest 扩展）

授权矩阵不只是文档，必须落为可测试的注册表（对齐 D5 §8.2 的 `remote_command_registry!`）：

```rust
/// 远程命令注册表条目（remote_manifest.rs 扩展；risk_class 为新增列）
struct RemoteCommandEntry {
    route: &'static str,            // remote.* 路由名
    min_capability: Capability,     // observe / approve / operate（D5 三级）
    risk_class: RiskClass,          // 普通 / 敏感 / 危险 / 极危（§2.1 定义）
    default_gate: VerificationLevel, // L0-L3（§3）
    configurable: GateConfig,       // 固定 / 可降 / 可升（含默认值）
    read_only: bool,                // 只读标记（网关只读域强制，F1 §6.3）
    redline_exempt: bool,           // 恒 false——红线不可豁免（D5 §4.2）
}
```

**注册纪律**（与 D5 §8.5 事件注册表纪律同构）：

1. 新增远程命令必须登记 `risk_class` + `default_gate`，缺省安全默认 L2（新命令默认
   危险级，评审后才可降级）；
2. `remote_command_names` 常量与 `risk_class` 表进测试锁定（`tests/remote_manifest.rs`），
   任何降级必须改代码 + 改测试，禁止只改配置面静默放权；
3. 矩阵与文档的一致性用生成器断言（脚本扫文档表格 ↔ 注册表，漂移即 CI 失败）——
   对齐 `scripts/generate-engine-bindings.mjs` 的生成纪律（D3 §2.7）。

**【裁决修正 5】三列映射表（wire kind ↔ 网关路由 ↔ manifest 命令名，部分示例）**：

| M6 wire kind（真源，camelCase） | 网关路由名（本表 snake_case） | manifest 命令名 |
|---|---|---|
| remote.getStatus | remote.get_status | core_get_status |
| remote.readSessionEvents | remote.read_session_events | core_read_session_events |
| remote.approve / remote.deny | remote.approve / remote.deny | core_approve_tool / core_deny_tool |
| remote.runTask | remote.run_task | core_run_task |
| remote.writeFile | remote.write_file | workbench_write_file_content |
| remote.getPairState | remote.pair_start / pair_cancel | workbench_pairing_status |

> 实现要求：路由名与 kind 名在 `remote_manifest.rs` 同源登记（生成器产出），
> 不允许两套名单漂移；移动端网关做 kind → route → risk_class 三层映射时
> 以 wire kind 为键。

---

## 3 验证分层设计（四级）

### 3.1 四级验证模型总览

| 等级 | 名称 | 触发场景（危险度） | 验证要求 | 证据形态（入审计） | 冷却时间 | 典型操作 |
|------|------|--------------------|----------|--------------------|----------|----------|
| L0 | 普通 | 普通 | 无（直接执行） | `level=L0` | 无 | 状态查询、连接条、事件订阅 |
| L1 | 敏感 | 敏感 | App 解锁态（PIN/生物任一，会话内有效） | `level=L1, unlock=biometric\|pin, unlockedAt` | 无 | 会话列表、文件浏览、审批详情、诊断页 |
| L2 | 危险 | 危险 | 生物识别（60s 窗口）+ 二次确认手势（滑动 ≥70%）+ 冷却 5s | `level=L2, biometric=pass, gesture=slide(70%)` | 5s | 审批允许、文件覆盖写、发起 run、撤销配对 |
| L3 | 极危 | 极危 | L2 全部 + 双端在场（桌面在场 + 桌面确认）+ 冷却 30s | `level=L3, dual=desktop-confirmed, desktopPresence=...` | 30s | 双轨危险审批（配置开启时）、未来删除类、连接地址首次设置（可配） |

映射关系：危险度（§2.1 定义）→ 验证等级：普通→L0、敏感→L1、危险→L2、极危→L3。
映射是固定的，但**矩阵「可配置」列允许用户显式升级**（如敏感文件读取从 L1 升 L2、
撤销配对升 L3），**不允许降级**（L2 之上的固定项不可放宽）。

### 3.2 L0 普通（直接执行）

- 范围：§2 矩阵中标 `allow` + 普通危险度的操作（F1 状态面、事件订阅、心跳、通知展示）。
- 设计原则：**零打扰**。锁屏状态下也能看到「桌面端在跑什么」的连接级信息（连接条/
  状态卡），这是 Companion 的价值底座（F1 §1.1「随时看一眼」）。
- 安全边界（L0 的兜底）：
  1. L0 只覆盖**聚合/计数/元数据**，不覆盖内容：pendingApprovals 计数可 L0，
     审批参数不可（L1）；run 列表可 L0（元数据），run 事件时间线不可（L1）；
  2. L0 数据中不得出现密钥形态/敏感路径（M-REDACT 兜底，D5 §6.3）；
  3. 通知横幅在锁屏的展示由系统级隐私设置控制（iOS 通知预览 / Android 锁屏通知），
     app 侧提供「通知栏内容隐藏」开关（F6 §11.4）——L0 的门在系统层不在 app 层。

### 3.3 L1 敏感（PIN/生物一次）

- 范围：§2 矩阵中标 `verify` + 敏感危险度的操作（数据浏览类全量）。
- 解锁语义：**会话内解锁一次**。App 打开时解锁（§3.6 时机 A），解锁态在**本会话内**
  对全部 L1 操作有效；退后台超过阈值（默认 5 分钟，F6 §11.2 应用锁「退出后台 5 分钟
  即锁」档位）后回到「未解锁」，再进需重新解锁。
- 解锁方式优先级：生物识别（Face ID / 指纹）优先；无生物或生物失败 3 次后降级 PIN；
  无 PIN 配置时强制引导设置 PIN（禁止「无锁使用」——对齐 D4 §7.4 与 R2B §7.1
  「固定 PIN / 假装加密」教训：**宁可要 PIN 也不做假解锁**）。
- 失败路径：连续 5 次解锁失败 → 该会话锁定 30s（退避）；app 被系统终止后锁定态
  重置（系统密钥库兜底，令牌本身不受影响——解锁失败只锁 UI 层，不销毁令牌）。

### 3.4 L2 危险（生物 + 二次确认 + 冷却）

- 范围：§2 矩阵中标 `confirm` + 危险危险度的操作（决策写类、文件写、run 发起、
  设备面操作）。
- 三步验证（顺序固定，缺一不可）：
  1. **生物识别**：本次操作前 60s 内完成过生物识别（会话解锁不够——L2 要求
     「刚证明过是本人」）；60s 窗口过期必须重新生物识别；
  2. **二次确认手势**：按操作形态分两种——`滑动 ≥70%`（允许类，F2 §5.3）或
     `长按 1.5s + 颜色渐满`（拒绝/断开类，防滑错方向）；拒绝类操作可简化为单击
     （F2 §9.2「拒绝不受限」原则扩展到本域所有「安全方向」操作）；
  3. **冷却 5s**：距上一次 L2/L3 操作 ≥ 5 秒；冷却内的 L2 请求直接弹「操作过于频繁，
     请稍候」文案（防疲劳攻击 + 防批量误触，见 §3.8）。
- 与 120s 审批窗口的协同：审批决策的 120s 窗口（`core_run_commands.rs:88`）与 L2
  验证是串行关系——先验证（生物+滑动）再发决策；验证耗时计入用户侧体验（F2 §9.1
  的 3 秒路径以已解锁为前提）；若验证完成时 120s 已过，决策返回 NotFound（F2 §8.3
  冲突态），验证 token 一并作废。
- 验证证据随命令提交：网关在 `verification_token` 中固化 `level/gesture/biometric/
  requestId`，一次使用；命令执行后审计落证据（§6.2）。

### 3.5 L3 极危（双端在场 / 双轨）

- 范围：§2 矩阵中标 `dual` 的操作 + 可配置升级项。
- 双端在场定义（复用 D5 §4.4 的判定，扩展到设置面）：
  1. 桌面端 app 运行中 + 最近交互时间戳在 N 分钟内（默认 10 分钟，F2 §9.2 与 D5
     §4.4 一致）；
  2. 判定信号源 = 桌面端心跳上报（`device_presence_query`，F2 §12.2 契约）；
  3. 缺省 false（保守模式：桌面无人值守按单端处理，D5 §4.4）。
- 双轨执行流（危险审批的 L3 形态）：

  ```text
  移动端：生物识别 → 滑动确认 → 发送 remote.approve（带 verification_token）
    ▼
  远程网关：等级 L3 → 查桌面在场（local_user_present）
    ├─ 在场 → 挂起等待桌面端本地弹窗确认（复用 ApprovalGateImpl 广播路径，
    │          D5 §4.3/§4.4）→ 桌面确认 + 移动端确认 双绿 → resolve 落地
    └─ 不在场 → 按 L2 单端处理（审计标记 remote-only，D5 §4.4）
  ```

- 双轨规则的不对称性：**拒绝永远单端即可**（任一方拒绝即拒绝，但「谁拒绝」都被
  审计）；只有「允许」需要双端在场。这与 F2 §9.2「拒绝不应被双因素拦截」一致。
- 可配升级项（矩阵「可升」列）：
  - F2-03 危险度 2 审批允许 → 升级 L3（默认关，F2 §9.2）；
  - F6 设备撤销 → 升级 L3（默认关，本方案建议）；
  - F6 服务器地址修改 → 升级 L3（默认关，本方案建议，理由见 §2.7）。
  升级项在桌面端安全中心配置（移动端不提供降级入口——「可升」开关在桌面端）。

### 3.6 移动端解锁时机设计

| 时机 | 设计 | 理由 |
|------|------|------|
| A. App 打开时（冷启动/回前台） | 若配置应用锁（默认开，F6 §11.2），打开即验证（生物/PIN）；验证通过进入「已解锁」会话态 | 防「拿起手机直接看」——持机攻击第一步是打开 app |
| B. L2/L3 操作时 | 操作前 60s 生物窗口检查，过期即时重验 | 会话解锁不能覆盖写操作（§3.4） |
| C. 通知深链冷启动 | 点通知 → 系统解锁 → app 冷启动验证 → 直达详情页（F2 §9.1 的 3 秒路径） | 深链直达不跳首页，验证不中断路径 |
| D. 锁屏态例外（L0 可见项） | 连接条/状态卡/审批计数角标在锁屏通知层可见 | F1 价值底座；内容细节不出现（§3.2） |
| E. 退后台 5 分钟 | 回前台需重新验证（L1 会话态失效） | F6 §11.2 应用锁档位；防后台常驻绕过 |
| F. app 被系统终止 | 无内存会话态，冷启动全量重新验证 | 系统级兜底 |

解锁状态机：

```text
未解锁 ──生物/PIN 成功──▶ 已解锁（L1 会话态，5 分钟滑动有效）
  ▲                          │
  │ 生物失败×5 / 5 分钟超时   │ L2/L3 操作时 60s 生物窗口过期
  └──────────────────────────┴──▶ 操作时重验（B）→ 仍失败 → 回未解锁
```

### 3.7 误触防护清单

| # | 防护 | 层级 | 依据 |
|---|------|------|------|
| F-01 | 允许/拒绝按钮布局固定 + 间距 ≥48dp，拒绝远离拇指默认落点 | UI | F2 §9.3 第 1 条 |
| F-02 | L2 允许必须滑动 ≥70%，禁止点按触发 | UI | F2 §5.3 |
| F-03 | 拒绝类可用单击（安全方向），但按钮不置顶 | UI | F2 §9.2 |
| F-04 | 决策发送期间按钮置忙 + 300ms 防抖 | UI | F2 §9.3 第 3 条 |
| F-05 | 批量允许排除危险度 2 + 临期（≤30s）条目 | 逻辑 | F2 §5.4 |
| F-06 | L2/L3 冷却 5s/30s（§3.8） | 逻辑 | 本方案 |
| F-07 | 决策已发送（deciding）时返回列表显示「处理中」 | UI | F2 §9.3 第 6 条 |
| F-08 | 长按 1.5s + 渐满动画用于断开/撤销类 | UI | 本方案（§3.4） |
| F-09 | 流式事件卡禁止导航（防滚动误触） | UI | F3 §5.3 |
| F-10 | 配对/连接地址输入后 3s 确认窗 | UI | F6 §7.1 |
| F-11 | 撤销配对二次确认弹窗（说明后果） | UI | F6 §6.2 |
| F-12 | 清空本机数据二次确认 + 说明不影响桌面 | UI | F6 §11.2 |
| F-13 | 生物失败 3 次降级 PIN、5 次锁定 30s | 逻辑 | 本方案（§3.3） |
| F-14 | 滑动阈值不可配置（固定 70%），防用户自降门槛 | 配置 | F2 §5.3 + 本方案 |

### 3.8 冷却时间与疲劳防攻击

| 面 | 设计 | 依据 |
|----|------|------|
| L2 冷却 | 距上次 L2/L3 操作 ≥ 5s；命中弹「操作过于频繁，请稍候」 | 防连点疲劳（批量允许除外——批量自身限制危险度 1 且逐条发送） |
| L3 冷却 | ≥ 30s | 双端确认场景高频触发会疲劳桌面用户（TH-29） |
| 冷却窗口计算 | 以验证完成时刻（而非命令回执时刻）为基准 | 命令往返时延不应惩罚用户 |
| 冷却的例外 | 拒绝类操作不受冷却限制（安全方向永远可用） | F2 §9.2 原则扩展 |
| 服务端兜底 | 远程网关侧也执行冷却检查（`verification_token` 携带验证时刻，网关校验 ≥5s） | 移动端本地冷却可被改包绕过，服务端是真值（§1.4 双层） |
| 疲劳攻击（L3） | 桌面端确认条单队列 + 60s 超时（F6 §8.3 的 M-CONFIRM 队列语义扩展到 L3 双轨）；同一 run 的 L3 请求 1 分钟内最多 3 次，超出降级为「等待 60s 冷却」 | TH-29 |

### 3.9 验证状态的会话内存（app lock 与令牌的关系）

| 项 | 设计 |
|----|------|
| 验证态 ≠ 令牌态 | 解锁/验证状态只存在于 app 内存（会话态），**不落盘**；令牌（配对令牌/账号 token）在系统密钥库，与验证态解耦——应用锁失效不会销毁令牌（F6 §5.7：会话过期不触发配对失效） |
| app 锁开关 | F6 §11.2：PIN/生物可选，「打开即锁 / 后台 5 分钟即锁」两档；默认开启（本方案建议默认 `on`，理由：移动端是低信任终端） |
| 锁与 L1 的关系 | 应用锁开启时，打开验证 = L1 会话态建立；应用锁关闭时，L1 操作不强制解锁（用户显式放弃）——但 L2/L3 的生物识别**不受应用锁开关影响**（写类永远要求生物） |
| 锁与推送 | 推送通知展示受系统隐私设置 + F6 §11.4 开关控制；点通知深链的验证在落地页执行（§3.6 C） |

---

## 4 账号体系整合

### 4.1 令牌体系全景（四类令牌）

| # | 令牌 | 用途 | 谁签发 | 谁验证 | 载体 | 有效周期 |
|---|------|------|--------|--------|------|----------|
| T-1 | 配对令牌（device token / token_key 派生） | 局域网直连信道的设备身份与消息签名（D3 §5.1：HMAC 签名即凭据；D5 §3.3：256bit 随机令牌形态） | 桌面端（配对协议，D3 §4.4 派生 / D5 §3.1 流程 ⑦） | 桌面端（device_registry 表 token_key 校验，D3 §4.5 / D5 §3.3） | 桌面：DPAPI 槽存哈希+盐；移动：Keychain/Keystore | 默认 30 天（D5 §3.3，可配 10~365 天）；会话密钥 8h（D5 §3.5） |
| T-2 | 账号 token（access + refresh） | 云端身份（账号中心会话），登录/鉴权/签发下游凭据 | 账号中心（access 15min 状态化 zn1 token + refresh 30 天轮换，AC §4.3.1） | 账号中心（sessions 表回查，AC §4.3.1） | 桌面：OS 凭据库；移动：Keychain/Keystore（F6 §5.2） | access 15min / refresh 30d 单次轮换 |
| T-3 | 中继凭证（relay credential） | 长连接中继信道的设备身份（连 wss 中继） | 账号中心（POST /api/relay/credentials，明文只返回一次，AC §6.4） | 中继服务（调 /api/relay/verify，HMAC 校验，可缓存 ≤5min） | 桌面/移动：OS 凭据库 / 安全存储 | 30 天可刷新（AC §6.4） |
| T-4 | 推送注册（push token） | 厂商通道寻址（FCM/APNs/HMS/厂商推送），消息送达地址 | 厂商 SDK（移动端系统生成）→ 移动端注册到账号中心 push_tokens | 厂商通道（发送时校验）+ 账号中心（注册表管理） | 移动端本地（厂商 SDK 管理）+ 账号中心注册表 | 厂商生命周期（token 轮换/失效）；注册记录随设备撤销 |

### 4.2 令牌关系与职责边界（为什么四个而不是一个）

> 【裁决修正 10】**本节四类令牌分治为认证方案唯一真源**（配对令牌本地 /
> 账号 token 云端不共享 / 中继凭据 HMAC / 推送注册加密）；AU3 C-1 的「认证
> 三选一」已按此裁决：Bearer 面与 WsEnvelope 第三套帧作废，统一
> DeviceEnvelope + 消息级 HMAC（M6 §10）；配对码规格以 D3 §4.1 为准（裁决 1）。

| 问题 | 单一令牌方案的失败方式 | 四类分治的答案 |
|------|----------------------|----------------|
| 局域网直连 | 依赖云端 → 断网不能配对/控制 | 配对令牌完全本地（D3 派生，云端无关），离线可用 |
| 云端身份 | 用配对令牌当账号 → 账号中心无法验证、无法多设备 | 账号 token 由账号中心签发验证，是云端信任根 |
| 中继长连接 | 用账号 access token（15min）→ 长连接频繁过期；用 refresh（轮换语义不符） | 中继凭证独立签发、短 TTL、可撤销、可刷新（AC §4.3.5） |
| 推送寻址 | 用账号 token 推消息 → 无法到达厂商通道 | push token 是「厂商侧地址」，与身份令牌解耦（D7 §4 路线 C） |

**信任链**：配对令牌 ⊥ 账号 token（两套信任根，互不依赖——访客模式只有 T-1；
D5 §0.4「中继面由移动端侧另行设计」+ AC §5.4「本地配对体系不依赖云」）；中继凭证
依赖账号 token（Bearer 签发）但生命周期独立；推送注册依赖账号 token + 设备注册
（account_id + device_id 关联）。

### 4.3 配对令牌（本地直连）

- 签发：桌面端配对流程（D3 §4.4：X25519 ECDH + 配对码 PAKE 派生 master →
  token_key/refresh_key；【裁决修正 1/10】AU1 P1-10 已裁决：以 D3 §4.4 派生形态
  为准，D5 §3.3 的 256bit 随机令牌形态由派生形态取代，本节 O-01 关闭）。
- 验证：桌面端 device_registry（D3 §4.5）或 multi-device.json 注册表（D5 §3.4）——
  哈希/派生值校验，常数时间比较。
- 过期：30 天默认；到期认证失败 → 重新配对（D5 §3.3）。
- 刷新/轮换：rotate_token（D5 §3.3）；refresh_key 一次性重连（D3 §5.1）。
- 撤销：桌面端设备管理页删除注册表条目 + 强制断开 + 审计（D5 M-REVOKE）。
- 与本方案的关系：配对令牌承载 §1.2 的「能力等价」——能力（observe/approve/operate）
  记录在配对注册表，令牌与能力同生命周期（D5 §4.1 铁律 3）。

### 4.4 账号 token（账号中心）

- 形态（AC 冻结）：access token `zn1.{payload}.HMAC-SHA256`，状态化（校验 sessions
  行），15 分钟 TTL；refresh token 30 天、单次轮换、旧 token 失效（AC §4.3.1）。
- 两端关系（M-05 决策）：**账号 token 不需要两端一致**。桌面端与手机端各自登录同一
  账号、各自持有自己的会话与令牌（账号中心「一设备一会话」语义，`auth.service.ts:
  1601-1624` 同设备新会话吊销旧会话）；两端通过「同一 accountId 下的设备注册表」
  建立互认（F6 §5.2）。令牌共享只会扩大泄露面（一端泄露 = 两端同时失守）且无收益。
- 会话保持：refresh 静默续期；失效 → 降级访客能力（F6 §5.2/§5.7），**不自动登出
  清数据**。
- 撤销：账号中心会话列表/设备级撤销（AC 现有机制）；A3 联动（§4.8）扩展为撤销设备
  时一并撤销推送注册与中继凭据。

### 4.5 中继凭证 relay_credentials

- 签发：移动端/桌面端登录后向账号中心 POST /api/relay/credentials 申请；明文凭据
  （随机 32B）**只返回一次**，服务端只存 HMAC（AC §6.4）。
- 验证：中继服务握手时调 /api/relay/verify（`{credential, nonce}` →
  `{accountId, deviceId, app, status}`）；中继本地缓存校验结果 ≤5 分钟（AC §9 风险 4
  的缓解）。
- 生命周期：TTL 30 天；`POST /api/relay/credentials/refresh` 轮换（旧凭据立即失效）；
  设备撤销联动吊销（A3）；凭据过期 → 403 → 端侧刷新（AC §6.4 连接生命周期）。
- 与本方案关系：中继凭证是「连中继」的身份，端间消息鉴权仍走 D3 设备级 HMAC
  （AC §7.4：两层不混）。中继只转发不解密（D1 §3.3），端到端加密由 D3 帧层承担。

### 4.6 推送注册 push_tokens

- 注册：移动端登录后向账号中心 POST /api/push/tokens（deviceId/platform/vendorToken/
  bundleId）；token_hash 幂等（AC §6.3 表结构）。
- 验证：厂商通道（发送时校验 device token 有效性）；账号中心注册表用于发送方查询
  （发送方 = 桌面 push-core，D7 裁决，AC §6.3）。
- 生命周期：注册/更新（厂商 token 轮换，expo-notifications `addPushTokenListener`）/
  解绑（登出/卸载 DELETE）/unregister（厂商回报 DeviceNotRegistered 时标记）；
  设备撤销联动 A3。
- 与本方案关系：推送注册是「通知可达性」的寻址表；通知载荷的敏感度由 §2 矩阵控制
  （审批通知只带摘要，F2 §6.2）；推送 token 属个人信息（§9.1 合规处理）。

### 4.7 四类令牌生命周期对照总表

| 阶段 | T-1 配对令牌 | T-2 账号 token | T-3 中继凭证 | T-4 推送注册 |
|------|--------------|----------------|--------------|--------------|
| 签发方 | 桌面端（配对） | 账号中心（登录/刷新） | 账号中心（Bearer 申请） | 厂商 SDK + 移动端注册 |
| 签发前置 | 配对码校验通过 | 邮箱+密码/验证码/desktop-auth | 账号登录态（Bearer） | 账号登录态 + 设备注册 |
| 验证方 | 桌面端 | 账号中心 | 中继（经 verify） | 厂商 + 注册表 |
| 默认 TTL | 30 天（可配） | access 15min / refresh 30d | 30 天 | 厂商生命周期 |
| 刷新 | rotate_token / refresh_key 重连 | refresh 单次轮换 | refresh 端点轮换 | 厂商 token 轮换 → 重新注册 |
| 撤销 | 注册表删除 + 强断 + 审计 | 会话撤销（账号中心） | DELETE /api/relay/credentials/:id | DELETE /api/push/tokens/:id |
| 撤销联动 | 桌面安全中心 | A3 联动（§4.8） | A3 联动 | A3 联动 |
| 存储 | 桌面哈希/移动安全存储 | OS 凭据库/安全存储 | OS 凭据库/安全存储 | 账号中心注册表（加密）+ 厂商 SDK |
| 丢失后果 | 持机者获局域网控制（30 天内） | 云会话被接管（refresh 轮换可检测） | 中继身份被冒用（可撤销） | 定向推送滥用（可解绑） |
| 审计 | remote-auth / remote-device | 账号中心 audit_logs | relay_credentials 变更 | push_tokens 变更 |

### 4.8 账号中心扩展设计（AC 结论落地：push_tokens + relay_credentials）

AC 裁决：「需调整（非重做）」——新增 push_tokens 与 relay_credentials 两个模块 +
白名单扩展 + 安全强化（AC §5/§6）。本方案把它钉为 M7 的集成契约（面向 crish 侧
实现，账号中心侧改动清单以 AC §6.2-§6.4 为准，此处只做安全面加固与接线）：

#### 4.8.1 push_tokens 模块（表结构，AC §6.3 原文引用）

```sql
CREATE TABLE IF NOT EXISTS push_tokens (
  id                  TEXT PRIMARY KEY,               -- pt_<uuid>
  account_id          TEXT NOT NULL,
  device_id           TEXT NOT NULL,                  -- 与 sessions.device_id 同一体系
  platform            TEXT NOT NULL,                  -- apns | hms | xiaomi | vivo | oppo | honor | fcm
  vendor_token        TEXT NOT NULL,                  -- 厂商侧 device token（原样存储/加密可选）
  token_hash          TEXT NOT NULL UNIQUE,           -- HMAC(vendor_token) 用于幂等与反查
  bundle_id           TEXT NOT NULL DEFAULT '',       -- 移动端应用标识（多 app 隔离）
  app                TEXT NOT NULL DEFAULT 'crish',   -- 绑定到哪个应用
  status              TEXT NOT NULL DEFAULT 'active', -- active | unregistered | expired
  last_registered_at  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(account_id, device_id, platform, bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id, status);
CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(device_id, status);
```

**M7 安全加固项（在 AC 之上的增量）**：

| # | 加固 | 理由 |
|---|------|------|
| P-1 | vendor_token 列加密存储（复用 AC AI_CREDENTIAL_SECRET 同款机制或独立 secret） | vendor_token 是「定向推送」寻址物，泄露可被用于骚扰/钓鱼推送（TH-25） |
| P-2 | 注册接口校验 deviceId 属于该账号（与 sessions/device 记录一致） | 防跨账号注册（AC §6.7 必测用例） |
| P-3 | 查询一律按 account_id 过滤；发送方服务间调用（AUTH_SERVICE_TOKEN）只允许 accountId 精确查询 | 防横向越权 |
| P-4 | 注册频率限制：每设备每小时 ≤ 10 次注册/更新（复用 A5 限流框架） | 防 token 刷库 |
| P-5 | 推送载荷服务端不落库（通知是瞬态） | 减少个人信息存储面（§9.1） |

#### 4.8.2 relay_credentials 模块（表结构，AC §6.4 原文引用）

```sql
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

**M7 安全加固项**：

| # | 加固 | 理由 |
|---|------|------|
| R-1 | 签发接口明文凭据只在响应中出现一次；任何日志（含请求体日志）对 credential 字段打码 | AC 已有 HMAC-only，补充日志面打码（对齐 D5 M-REDACT） |
| R-2 | verify 接口带一次性 nonce（`{credential, nonce}` 双参校验） | 防中继侧重放校验请求 |
| R-3 | 凭据签发频率限制：每设备每天 ≤ 5 次主动签发 | 防凭据刷取（轮换应走 refresh 而非重复签发） |
| R-4 | 吊销联动（A3）：removeDevice → relay credential 批量 revoked | AC §6.2 A3；本方案要求**中继侧即时断开**（凭据校验失败即断，天然即时） |
| R-5 | 凭据 TTL 过期后 refresh 必须重新验证 refresh token 有效性 | 防「过期凭据换新凭据」的链条利用 |

#### 4.8.3 端点清单与安全面汇总（crish 侧集成契约）

| 端点 | 鉴权 | crish 侧消费方 | 安全面 |
|------|------|----------------|--------|
| POST /api/push/tokens | Bearer | 移动端登录后/启动时 | P-1~P-5 |
| DELETE /api/push/tokens/:id | Bearer | 移动端登出/卸载 | 归属校验（只能删自己的） |
| GET /api/push/tokens | Bearer | 移动端设备管理 UI | account 过滤 |
| POST /api/relay/credentials | Bearer | 桌面/移动端登录后 | R-1/R-3 |
| DELETE /api/relay/credentials/:id | Bearer | 登出/设备管理 | 归属校验 |
| GET /api/relay/verify | AUTH_SERVICE_TOKEN | 中继服务 | R-2；中继本地缓存 ≤5min |
| POST /api/relay/credentials/refresh | Bearer | 桌面/移动端 | R-5 |
| POST /api/devices/:id/trust | Bearer | 桌面/移动端设备管理 | A4 设备信任流程（AC §6.2） |

#### 4.8.4 账号中心安全强化清单（AC §6.5 引用 + 验收口径）

| # | 强化 | AC 编号 | M7 验收口径 |
|---|------|---------|-------------|
| A5 | 登录/注册/验证码限流 | A5 | 连续失败第 N 次 429；限流文案统一（不泄露账号存在性） |
| A6 | refresh 重用检测 | A6 | 旧 refresh 二次使用 → 会话全部令牌吊销 + security_logs |
| A7 | CORS 收敛 | A7 | 生产 Origin 白名单（chat.flowbit.me / crish 域名） |
| A8 | scrypt 参数上调 | A8 | 新注册新参数；旧格式仍可验证（向后兼容） |
| A4 | 设备信任流程 | A4 | trusted 默认值可配；新设备 pending 标记 |
| A3 | 设备↔会话↔推送↔中继联动 | A3 | removeDevice → 会话 revoked + push unregistered + relay revoked |

### 4.9 桌面端与手机端凭证存储与同步策略

#### 4.9.1 存储矩阵

| 凭据 | 桌面端 | 手机端 | 中继服务 | 账号中心 |
|------|--------|--------|----------|----------|
| 配对令牌（T-1） | DPAPI 槽存 `sha256(salt‖token)` + multi-device.json 注册表（D5 §5.3） | Keychain（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）/ Android Keystore + EncryptedSharedPreferences / expo-secure-store | 无 | 无 |
| 账号 access/refresh（T-2） | OS 凭据库（Windows Credential Manager / keyring crate；不落盘明文，AC §7.1） | Keychain/Keystore（F6 §5.2，绝不落本地明文） | 无 | sessions 表（状态化） |
| 中继凭证（T-3） | OS 凭据库 | Keychain/Keystore | 只存 HMAC 校验态（调账号中心） | credential_hash（HMAC-only） |
| 厂商推送凭据（T-4） | 桌面发送器持厂商 AppId/密钥（OS 凭据库） | 不持（token 由系统 SDK 管理） | 可选代理时持有 | vendor_token 加密存储 |
| 设备 Ed25519 私钥（D3 本地配对） | app_dir()/identity（权限 0600） | 安全存储 | 无 | 无 |

#### 4.9.2 同步策略（账号 token 需要两端一致吗——不需要）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 账号 token 两端一致？ | **不需要、也不应该** | ① 账号中心「一设备一会话」语义天然支持多设备各自会话（AC §4.3.1）；② 令牌共享 = 泄露面翻倍；③ 一端撤销不影响另一端（设备级撤销语义） |
| 两端需要一致的是什么 | ① 同一账号身份（accountId）；② 设备注册表（谁属于这个账号）；③ 安全偏好（如「危险操作需桌面在场」的配置） | ①②由账号中心统一；③经桌面确认通道同步（M-CONFIRM）或本机镜像（F6 §4.2 mirror 分片不持久化） |
| 中继凭证两端一致？ | 不需要（各持各的，同账号不同设备） | 中继按 (accountId, deviceId) 路由（AC §6.4） |
| 配对令牌两端一致？ | 不存在「两端」——配对令牌是「移动端 ↔ 桌面端」的一对一关系；桌面端是多设备注册表 | D5 §3.4 deviceId 每设备独立 |
| 同步的载体 | 账号中心（云）负责跨端身份事实；本地配对（D3）负责局域网信任事实；两者**不混** | AC §7.4 分工；D1 §4.5 云账号可选 |

#### 4.9.3 桌面端 OS 凭据库选型注意

- 现状桌面端 CredentialStore 用 DPAPI 直写 `config_dir()/secrets/`（`credentials.rs:31`
  注释：Windows DPAPI 加密后 hex 落盘；非 Windows 纯内存降级）。
- 账号 token/中继凭证的存放**不复用该路径**（那是 provider 密钥槽，D5 §5.1 隔离面），
  而是走 Tauri 侧 OS 凭据库（Windows Credential Manager / macOS Keychain，keyring
  crate）或独立 DPAPI 槽 `{deviceId}.devtoken.dpapi`（D5 §5.3 已冻结的形态）。
- 降级策略：OS 凭据库不可用时（Linux 无 keyring 等），允许内存态 + 提示「重启后需
  重新登录」，**禁止明文落盘**（对齐 D5 §5.2 降级原则：宁可每次配对，不做明文落盘）。

---

## 5 密钥边界重申

### 5.1 Provider API keys 永不出桌面（D-08 的 M7 重申与接线）

D5 §5.1 已冻结五条隔离（数据面/命令面/命令级/展示面/测试断言），M7 在此基础上
补充**验证分层不削弱密钥边界**的显式声明：

1. 本方案 §1-§3 的验证分层**不作用于** provider 密钥面——密钥命令不在远程白名单
   （D5 §4.5），`risk_class` 表中根本不存在它们的条目，验证等级无从谈起；
2. `config_secret_*` 五命令（`credentials.rs:237-341`）在 `CommandSource` 校验上
   增加 `remote` 来源拒绝分支（D5 §8.2 融合点 8）——即使验证 token 伪造通过，
   命令自身的来源校验仍是第二层拒绝；
3. 移动端 UI 上**不存在任何**「查看密钥」入口（F6 §3.3 模型页只读镜像只展示
   `credentialMode` 与 last4——`provider.rs:299-325` 的 config_get 脱敏快照口径）；
4. 事件流/推送载荷中不得出现 `sk-` 前缀等密钥形态（D5 T-09 的自动化断言扩展到
   M7 的推送链路：推送桥适配器对载荷做形态扫描，命中即丢弃 + 审计）。

### 5.2 文件读写远程代理（移动端不直连文件系统）

F4 §5.1 已冻结「桌面端是文件系统唯一访问者」，M7 补强三点：

| # | 补强 | 落点 |
|---|------|------|
| FS-1 | 移动端请求只携带相对路径（relPath）或空串；绝对路径在移动端 SDK 层拒绝（F4 §7.2） | 移动端校验 + 桌面 `resolve_guard`（`workspace.rs:185-244`）双保险 |
| FS-2 | 写操作（write_file_content）在桌面端执行，覆盖语义/沙箱/编码检查全部走既有命令面（F4 §2.4） | 远程通道只是传输层，不新增桌面端信任面 |
| FS-3 | 资源代理 URL（图片/PDF）带短期令牌（10 分钟）+ 仅授权根内相对路径（F4 §5.4） | 桌面端二次校验 + 令牌过期天然失效 |
| FS-4 | 文件内容缓存仅限非敏感文件、仅 app 沙箱（F4 §7.3） | 手机端存储面与桌面文件系统无任何共享 |

### 5.3 展示面/事件面/审计面的密钥隔离（三面齐查）

| 面 | 检查项 | 依据 |
|----|--------|------|
| 展示面 | config_get 脱敏快照（apiKey 恒空串 + last4 + credentialMode）；移动端任何页面不渲染密钥明文 | `provider.rs:299-325`；F6 §3.3 |
| 事件面 | 事件载荷中含参数形态的字段（PermissionRequest.parameters / tool 入参）在推送到移动端前打码（M-REDACT 关键词打码：password/token/secret/api_key 键值 → `***`） | D5 §6.3；F2 R3（推送载荷只带摘要） |
| 审计面 | 审计记录中密钥形态恒打码（K-05 last4 / token hash 前缀）；`remote-command` 审计的 targets 承载命令摘要而非全文 | D5 §6.2/§6.3 |
| 移动端本机 | 敏感文件内容不缓存（F4 §7.3）；聊天记录漫游默认关（F6 §11.2）；推送 data 载荷 60s TTL（F2 §6.4） | 持机攻击面收敛 |

### 5.4 密钥边界验证（测试锚点）

| 锚点 | 断言 | 对应 |
|------|------|------|
| KB-1 | 远程白名单注册表扫描：无任何 config_secret_* / fs_delete / pty / shell 直连命令 | D5 T-07 |
| KB-2 | 事件流 + 推送载荷快照扫描：零 `sk-` 前缀 / 零 43 字符 base64url 令牌形态 / 零 CXN 12 字符 base32 配对码形态【裁决修正 1：原「8 字符 base32 码形态」随 D3 §4.1 更新】 | D5 T-06/T-09 扩展（推送链路） |
| KB-3 | config_get 远程响应中 apiKey 恒空串 | 脱敏快照契约 |
| KB-4 | 写文件越权（../ 或绝对路径）在桌面端返回 outside_workspace | F4 T4-10 |
| KB-5 | 资源代理 URL 令牌过期 → 401/403 + 前端兜底图 | F4 T4-23 |

---

## 6 审计整合

### 6.1 SecurityAuditOperation 扩展设计

D5 §6.2 冻结七变体（remote-pair / remote-auth / remote-command / remote-session /
remote-device / remote-mode-downgrade / remote-source-attempt）。M7 按功能域补充
文件面与设置面的审计变体（仍走 `SecurityAuditOperation` 枚举扩展，不新增 AgentEvent
变体，对齐 D5 §8.5 最小方案）：

| 变体（wire） | 语义 | targets 承载 | decision 取值 | 来源域 |
|--------------|------|--------------|----------------|--------|
| `remote-pair` | 配对尝试 | pairId 哈希, 来源 IP | approved / denied / blocked | F6 |
| `remote-auth` | 令牌认证 | deviceId | approved / denied / blocked | 公共 |
| `remote-command` | 远程命令执行 | 命令名 + 摘要 + **verification 证据** | approved / denied / blocked | 公共 |
| `remote-session` | 会话生命周期 | sessionId, deviceId | approved / blocked | 公共 |
| `remote-device` | 设备管理（注册/撤销/轮换/重命名/强断） | deviceId | approved / denied | F6 |
| `remote-mode-downgrade` | full-access 降级 | runId | blocked | 公共 |
| `remote-source-attempt` | 被禁命令面触达 | 命令名 | blocked | 公共 |
| `remote-file-read` | **新增**：远程文件读取 | 相对路径 + 文件类型 + 是否敏感命中 | approved / blocked | F4 |
| `remote-file-write` | **新增**：远程文件写（编辑/新建） | 相对路径 + 字节摘要（sha256 前 16 hex）+ 覆盖标志 | approved / denied / blocked | F4 |
| `remote-file-search` | **新增**：远程搜索（文件名/内容） | 查询词摘要 + 结果数 | approved / blocked | F4 |
| `remote-settings-apply` | **新增**：远程设置变更（桌面确认通道） | 设置键 + 值摘要 | approved / denied / rejected / timed-out | F6 |
| `remote-presence` | **新增**：桌面在场状态查询/变更 | deviceId | approved | F2 |
| `remote-verification-failed` | **新增**：验证门失败（生物/滑动/冷却/双端） | 命令名 + 失败原因（unlock / biometric / gesture / cooldown / dual） | blocked | 公共 |
| `remote-approval-decision` | **新增**：远程审批裁决（与 approval-resolved 对账用） | toolCallId + 裁决渠道（remote-only / dual） | approved / denied / expired | F2 |

### 6.2 远程审计记录字段契约

所有 `remote-*` 审计事件携带以下字段（对齐 D5 §6.2 的字段约定并扩展）：

| 字段 | 语义 | 注入方 |
|------|------|--------|
| `remote_device_id` | 来源设备（权威注入，移动端自称不可信，D5 §6.4） | 远程网关 |
| `remote_device_name` | 设备展示名（注册表查询，审计展示用） | 远程网关 |
| `verification` | 验证证据：`level=L2, biometric=pass, gesture=slide(70%), cooldown=ok`（或 verification-failed 事件的原因） | 远程网关（自 verification_token 解析） |
| `permission_mode` | 远程 run 的生效模式（恒 ask/plan，D5 §6.2） | 引擎 |
| `request_id` | `remote:{deviceId}:{seq}`（对账键，D5 §6.4） | 远程网关 |
| `channel` | `lan` / `relay`（来源信道，中继面接入后生效） | 远程网关 |
| `source_app` | `crish-mobile`（含版本号） | 移动端上报 + 网关校样 |
| `result` | 执行结果摘要（ok / error code / 冲突 NotFound） | 引擎回执 |

**验证证据的落库纪律**：验证证据由网关从 `verification_token` 解析（token 本身
一次使用、60s 有效、绑定 requestId），审计只落**结论**（level + gesture 类型），
不落生物模板等生物特征数据（个人信息最小化，§9.1）。

### 6.3 审计在移动端的展示（F1 诊断面板与 F2 历史联动）

| 展示位 | 内容 | 等级 | 来源 |
|--------|------|------|------|
| F1 F15 审计列表（P2） | 最近 20 条 security-audit 事件（含 remote-*），按时间倒序；过滤：deviceId/决策/操作类别 | L1（verify） | `security-audit` 事件订阅 + 网关缓存（F1 §2.5 事件映射） |
| F2 审批历史 | 审批条目附带「裁决渠道」（本机/桌面端/自动过期/双轨）+ 关联回执 | L1 | approval-resolved + remote-approval-decision 对账 |
| F6 设备详情 | 该设备的最近活跃审计摘要（配对时间/撤销记录/认证失败次数） | L1 | remote-device / remote-auth 事件 |
| 安全中心（桌面端，不进远程白名单） | 全量远程审计查询（deviceId/时间/决策过滤） | 桌面本地 | D5 §7.7 既有设计 |

移动端展示的边界：

1. 移动端只展示**桌面端推送/网关下发的审计投影**，不做本地审计库（审计真值在桌面）；
2. 审计列表在移动端不可筛选导出（防批量外传），只提供单条展开；
3. 展示前打码（M-REDACT）：路径/参数/命令摘要形态在移动端 UI 层二次打码。

### 6.4 审计权威性与不可篡改（桌面端本地审计是权威）

| 原则 | 设计 | 依据 |
|------|------|------|
| 不可丢 | 远程审计事件走 `event_backpressure` Critical 分支 + `spawn_audit_persistence` 排空（`core_run_commands.rs:388-390/500`） | D5 §6.4 |
| 不可伪造 | 审计事件只由桌面端生成；移动端只能请求动作，不能投递事件（D5 §6.4） | 本方案 §6.1 所有 remote-* 均由网关构造 |
| 不可抹除 | 远程事件与本地事件同库同游标；撤销设备的审计保留；移动端没有任何「删除审计」命令（不在白名单） | D5 §6.4 + §2.8 矩阵 |
| 不可绕过 | 验证证据落库（§6.2）使「绕过验证执行」与「验证通过执行」在审计上可区分——`remote-verification-failed` 事件与 `remote-command` 事件成对出现才是正常执行轨迹 | 本方案新增 |
| 权威位置 | 桌面端本地 events 表是唯一权威；账号中心 audit_logs 是云端侧补充（登录/签发类），两侧以 deviceId/accountId 关联，互不为替代 | AC §3.3 + 本方案 |

### 6.5 审计对账与异常检测

| 检测 | 规则 | 出口 |
|------|------|------|
| 裁决缺失 | approval-resolved 有记录但 remote-approval-decision 缺失（或反之） | 安全中心告警（D5 TH-20 对账） |
| 验证缺失 | remote-command(approved) 无对应验证前置事件，且 verification 字段缺 level（即未验证就执行） | 实现缺陷信号，告警 + 快层测试 |
| 同设备双会话 | 同一 deviceId 出现第二活动会话 | 安全中心告警（D5 T-02 缓解） |
| 敏感文件高频读 | 1 分钟 > 100 次敏感文件读 | 告警（F4 §7.5 P2） |
| 批量操作风暴 | 同一设备 1 分钟 > 20 条 remote-file-write 或 remote-approval-decision | 告警 + 限速（M-LIMIT 命令级 60/min 之上再加风暴检测） |
| 设置变更风暴 | 同一设备 1 小时 > 5 次 remote-settings-apply | 告警（M-CONFIRM 单队列之外的安全网） |

---

## 7 威胁复查（D5 增量）

### 7.1 新增威胁清单（移动功能带来的增量）

D5 §1.3 的 TH-01~TH-20 覆盖「配对/令牌/传输/授权/密钥/审计/DoS」基线。F1-F6 功能
落地后出现的新攻击面（功能 = 新的可调用面，验证分层 = 新的绕过目标）：

| 威胁编号 | STRIDE | 威胁描述 | 受影响资产 | 主要缓解 |
|----------|--------|----------|------------|----------|
| TH-21 | Tampering | 移动端批量允许（F2 批量处理）被用于批量放行危险操作 | A-03 | M-BATCH（仅危险度 1 + 非临期 + 逐条发送 + 确认层）+ M-AUDIT |
| TH-22 | Tampering | 移动端写文件注入恶意内容（F4 编辑/新建） | A-05 | M-VERIF（L2）+ 覆盖确认 + 敏感禁写 + 桌面沙箱兜底（F4 §4.3 四闸门） |
| TH-23 | Spoofing | 移动端伪造「桌面确认」响应（F6 设置变更/双轨） | A-09/A-03 | M-CONFIRM（桌面确认条 + nonce + 60s + 单队列）；双轨的桌面端确认在桌面 UI 弹窗，不可远程伪造 |
| TH-24 | Information Disclosure | 手机丢失后 app 内缓存（会话/文件/审批参数）被读 | A-06 | M-TOKEN（Keychain 保护）+ 应用锁 + 敏感文件不缓存 + 锁屏隐藏（F6 §11.4） |
| TH-25 | Spoofing | 推送 token 泄露 → 定向钓鱼/骚扰推送 | A-06 | M-PUSH（加密存储 + token_hash + 解绑 + 厂商失效） |
| TH-26 | Elevation of Privilege | 中继凭据泄露 → 冒充设备连中继 | A-02 | M-RELAY（HMAC-only + 一次明文 + TTL + 轮换 + 撤销联动） |
| TH-27 | Repudiation | 账号 token 重放（refresh 重用）后否认操作 | A-07 | M-ACCT（A6 refresh 重用检测）+ 账号中心审计 |
| TH-28 | Spoofing | UI 覆盖攻击（Android overlay / iOS 弹窗仿冒）诱导用户批准 | A-03 | 系统层防护 + 关键决策使用系统生物识别对话框（LocalAuthentication/Keystore 签名）+ 决策确认页展示完整请求上下文 |
| TH-29 | Denial of Service | 双轨确认疲劳轰炸（移动端高频发 L3 请求拖垮桌面用户注意力） | A-09 | L3 冷却 30s + 桌面确认条单队列 + 风暴检测（§6.5） |
| TH-30 | Tampering | 离线决策队列重放（断网期间排队，恢复后补发被篡改） | A-03 | M-OUTBOX：队列条目带原 verification_token + requestId；补发前重新校验 token（60s 过期则要求重新验证）；服务端幂等去重 |
| TH-31 | Elevation of Privilege | 移动端通过「暂停自动执行」等受限触发指令扩大自身影响面（把桌面拖入不安全状态） | A-09 | 一次性指令 + 桌面确认 + 审计 + 不改变持久化配置（F6 §8.2） |

### 7.2 威胁 → 控制措施增量矩阵

| 威胁 | M-VERIF | M-BATCH | M-CONFIRM | M-RELAY | M-PUSH | M-ACCT | M-OUTBOX | M-LIMIT/M-RATE（继承） | M-AUDIT（继承） |
|------|:-------:|:-------:|:---------:|:-------:|:------:|:------:|:--------:|:----------------------:|:---------------:|
| TH-21 批量放行 | ✓ | ✓ | | | | | | ✓ | ✓ |
| TH-22 文件注入 | ✓ | | | | | | | | ✓ |
| TH-23 伪造桌面确认 | | | ✓ | | | | | | ✓ |
| TH-24 丢机读缓存 | ✓ | | | | | | | | |
| TH-25 推送 token 泄露 | | | | | ✓ | | | ✓ | ✓ |
| TH-26 中继凭据泄露 | | | | ✓ | | | | | ✓ |
| TH-27 账号 token 重放 | | | | | | ✓ | | | ✓ |
| TH-28 UI 覆盖攻击 | ✓ | | | | | | | | ✓ |
| TH-29 双轨疲劳 | ✓ | | ✓ | | | | | ✓ | |
| TH-30 离线队列重放 | ✓ | | | | | | ✓ | ✓ | ✓ |
| TH-31 受限触发滥用 | | | ✓ | | | | | | ✓ |

结论：11 条新增威胁全部有覆盖；覆盖来源中 M-VERIF（验证分层）命中最多（6/11），
符合「验证面分级」作为同权安全主杠杆的设计定位。

### 7.3 与 D5 覆盖对照（哪些已覆盖、哪些新增）

| 类别 | D5 已覆盖 | M7 新增覆盖 | 未被任何控制覆盖的残留 |
|------|-----------|-------------|------------------------|
| 传输/配对/令牌 | TH-01~TH-06、TH-09、TH-17、TH-18、TH-19 | 无（继承） | 无 |
| 授权/提权 | TH-11、TH-12、TH-13 | TH-21、TH-23、TH-28、TH-30、TH-31 | 无 |
| 密钥边界 | TH-10 | 无（继承 + §5 重申） | 无 |
| 审计/否认 | TH-07、TH-20 | TH-27 | 无 |
| 窃听/泄露 | TH-08 | TH-24、TH-25 | 无 |
| DoS/滥用 | TH-14、TH-15、TH-16 | TH-29 | 无 |
| 文件面（新增） | TH-10 间接（密钥不出桌面） | TH-22、TH-24（文件缓存） | 无（文件面全部经远程代理 + 沙箱） |

### 7.4 剩余风险声明（诚实边界）

| 风险 | 等级 | 说明与接受理由 |
|------|------|----------------|
| 移动端 app 自身被逆向/修改（D5 T-08 恶意移动端） | 中 | 验证分层是 UI/网关双层；被修改的 app 无法伪造 `verification_token`（密钥在安全存储 + 网关校验），但可发起「无证据」请求被拒——**能力上限 = 白名单内合法操作**；接受 |
| 桌面端本地用户误批准（D5 T-07） | 中 | 双轨确认只降低误批准概率，不消除；审计留痕可追责；接受（与桌面现状同级） |
| 中继服务被攻破（T-05 恶意中继） | 低（一期无中继） | 中继只转发不解密 + 凭据 HMAC-only；端到端加密复用 D3 帧层；接受 |
| 账号中心（flowbit 生产系统）被攻破 | 低 | 依赖外部系统（AC §9 风险 1）；crish 全功能无账号可用（铁律）；接受 |
| 生物识别被绕过（3D 面具等） | 低 | L2/L3 还有滑动/双端在场兜底；PIN 降级路径存在；接受 |

---

## 8 安全测试清单

### 8.1 测试分层

| 层 | 载体 | 覆盖 |
|----|------|------|
| Rust 单测 | `cargo test --workspace`（快层） | 验证分层纯函数、矩阵注册表、令牌生命周期、审计构造、打码 |
| 壳集成 | workbench 测试面（`core_run_commands.rs` 同构） | 远程网关门禁闭环、审批双轨、设置确认通道 |
| 前端门禁 | `npm run typecheck` + `npm run test:coverage -- --project=unit` | 事件契约（registry_drift 等）在 operation 扩展后全绿 |
| 手工演练 | 真机双端联调 | 生物识别、双轨弹窗、UI 覆盖防护、误触手感 |
| 压力/模糊 | 脚本 + 限速器压力（D5 §7.6 下限验证） | 风暴检测、冷却、批量限制 |

命名空间建议：`multi_device::{matrix, verify, batch, confirm, relay, push_reg,
outbox, audit}`（在 D5 §9.4 的 `pairing/auth/session/limiter/gateway/tls/redact`
基础上追加）。

### 8.2 按授权级别分组用例（每个级别一组）

**L0 普通级**：

| 用例 | 断言 |
|------|------|
| `verify_l0_no_gate` | L0 操作直接 Pass，无解锁要求，审计记 level=L0 |
| `verify_l0_content_sanitize` | L0 数据面（状态卡/计数/连接条）无敏感形态（密钥/路径/正文摘要） |
| `verify_l0_lock_screen_visible` | 锁屏态下 L0 展示项可用（连接条/状态卡），内容细节不可见 |

**L1 敏感级**：

| 用例 | 断言 |
|------|------|
| `verify_l1_requires_unlock` | 未解锁时 L1 请求 → RequireUnlock 错误 + 可解释文案 |
| `verify_l1_session_valid` | 解锁后 5 分钟窗口内 L1 操作全部放行 |
| `verify_l1_session_expiry` | 退后台 5 分钟后回前台 → 需重新解锁 |
| `verify_l1_pin_fallback` | 生物失败 3 次降级 PIN；PIN 错误 5 次 → 会话锁 30s |
| `verify_l1_sensitive_file_read` | `.env` 读取 → 要求解锁 + 横幅 + 不缓存（F4 T4-20 扩展） |

**L2 危险级**：

| 用例 | 断言 |
|------|------|
| `verify_l2_requires_biometric_60s` | 生物识别 60s 窗口过期后 L2 请求被拒，需重新生物验证 |
| `verify_l2_gesture_slide_70` | 滑动 50% 松手回弹不提交；75% 触发（F2 E2E-3 对齐） |
| `verify_l2_longpress_confirm` | 长按 1.5s 渐满动画未完成不触发（断开/撤销类） |
| `verify_l2_cooldown_5s` | 5s 冷却内重复 L2 请求 → 「操作过于频繁」+ 网关侧同样拒绝 |
| `verify_l2_token_single_use` | verification_token 一次使用；重放 → 拒绝 + 审计 |
| `verify_l2_token_binding` | token 绑定的命令名/requestId 与请求不符 → 拒绝 |
| `verify_l2_reject_no_cooldown` | 拒绝类操作不受冷却限制（安全方向） |

**L3 极危级**：

| 用例 | 断言 |
|------|------|
| `verify_l3_dual_presence` | 桌面在场 + 移动端确认 + 桌面端确认 → 双绿落地（D5 T-14 扩展） |
| `verify_l3_dual_absent` | 桌面不在场 → 降级 L2 单端 + 审计 remote-only 标记 |
| `verify_l3_either_reject` | 任一方拒绝 → 拒绝 + 审计（记录拒绝方） |
| `verify_l3_cooldown_30s` | 30s 冷却生效；拒绝不受限 |
| `verify_l3_desktop_confirm_timeout` | 桌面确认条 60s 超时 → 请求过期 + 移动端提示 |
| `verify_l3_upgrade_config` | 可升项（审批允许/设备撤销/服务器地址）升级后必须双端在场；配置在桌面端生效 |

### 8.3 按功能域分组用例

**F1/F3 监控与事件流**：

| 用例 | 断言 |
|------|------|
| `monitor_domain_readonly` | 监控域白名单只含只读命令；core_run_control 等被网关拒绝（domain_readonly，F1 §6.3） |
| `monitor_operation_absent` | 监控域 UI 无任何操作按钮（组件断言） |
| `monitor_run_detail_l1` | run 详情/工具入参要求解锁；锁屏态打开直接 L1 门 |
| `terminal_readonly_no_stdin` | 终端流卡片无输入通道；PTY 命令不在白名单 |

**F2 审批中心**：

| 用例 | 断言 |
|------|------|
| `approval_decision_parity` | 同一请求移动端/桌面端决策集合、引擎产物（approval-resolved 载荷）完全一致（F2 §15 验收 2） |
| `approval_dual_configured` | 双因素开启后：桌面不在场 → 危险度 2 允许置灰、拒绝可用（F2 E2E-8） |
| `approval_batch_l1_only` | 10 条危险度 1 + 2 条危险度 2 批量选择：批量允许仅覆盖危险度 1（F2 E2E-7） |
| `approval_outbox_replay` | 离线决策队列补发：token 过期 → 拒绝并要求重新验证（TH-30） |
| `approval_remember_gate` | 「记住」后极危命令仍弹审批（F2 E2E-9，shouldAutoApproveCommand 硬拒绝门禁） |

**F4 文件与资产**：

| 用例 | 断言 |
|------|------|
| `file_write_edit_mode_gate` | 编辑模式关闭时无任何写入口（UI 断言 + 网关层拒绝） |
| `file_write_overwrite_confirm` | 覆盖写前二次确认；取消 → 0 个写请求（F4 T4-09） |
| `file_sensitive_write_denied` | .env 编辑入口置灰；伪造请求被桌面端拒绝（F4 T4-21） |
| `file_read_sensitive_l2` | 敏感文件读取要求 L2 确认（本方案 §2.5 增量） |
| `file_path_escape_rejected` | `../outside` / 绝对路径 / NUL / bidi → SDK 本地拒绝 + 桌面沙箱拒绝（F4 T4-10） |
| `file_asset_url_expiry` | 资源代理 URL 令牌过期 → 401/403（F4 T4-23） |

**F5 会话与消息**：

| 用例 | 断言 |
|------|------|
| `session_readonly_p1` | P1 无任何写命令在会话域白名单；消息撤回/删除路由不存在 |
| `session_delegate_run_p2` | 委托执行 run 载荷带 `requestOrigin=mobile`；审计可溯源（F5 §2.5） |
| `session_history_replay` | 游标分页续拉幂等（F5 §7.2 对齐） |

**F6 设置与账户**：

| 用例 | 断言 |
|------|------|
| `settings_permission_mode_readonly` | 权限模式修改入口不存在（F6 T18） |
| `settings_apply_desktop_confirm` | 手机改回答风格 → 桌面确认条；接受/拒绝/超时三态收敛（F6 T32-T34） |
| `settings_apply_nonce_replay` | 确认通道载荷 nonce 重放 → 拒绝（F6 §8.4） |
| `settings_apply_single_queue` | 同一桌面端同时只接受 1 个待确认变更，新请求排队（F6 §8.4） |
| `settings_server_address_l3_upgrade` | 升级配置后服务器地址修改要求双端在场 |
| `pairing_qr_fingerprint` | QR 载荷含 CA 指纹字段（D5 T-05 扩展，pair_qr_contains_fingerprint） |
| `device_revoke_disconnects` | 撤销设备 ≤1s 断开全部活动连接（D5 §10.3 第 6 条） |

### 8.4 令牌体系测试

| 用例 | 断言 |
|------|------|
| `token_pairing_lifecycle` | 配对令牌：签发 → 使用 → 轮换 → 撤销全链路（D5 §9.4 auth 模块复用） |
| `token_account_access_short_ttl` | 账号 access token 15 分钟后过期；refresh 单次轮换（AC §4.3.1 对齐） |
| `token_account_refresh_reuse` | 旧 refresh 二次使用 → 会话吊销 + security_logs（A6 验收） |
| `token_relay_issue_once` | 中继凭据明文只在签发响应出现一次；服务端无明文可查（AC §6.7） |
| `token_relay_verify_nonce` | verify 带 nonce；重放拒绝（R-2） |
| `token_relay_revoke_cascade` | removeDevice → 中继凭据吊销 + 推送解绑 + 会话撤销（A3 联动验收） |
| `token_push_register_idempotent` | 同 vendor token 二次注册返回同一记录（AC §6.7） |
| `token_push_cross_account` | A 账号 token 不能被 B 账号查询/删除（AC §6.7 跨账号隔离） |
| `token_push_unregister_flow` | 登出 → push unregister → 发送方查询不再命中 |
| `token_storage_no_plaintext` | 桌面注册表/账号中心 DB 扫描：无令牌明文（D5 auth_hash_storage_no_plaintext 扩展） |

### 8.5 审计测试

| 用例 | 断言 |
|------|------|
| `audit_remote_operation_all` | 每个远程动作产生对应 remote-* 审计且打码（D5 §10.3 第 7 条） |
| `audit_verification_evidence` | remote-command 审计含 verification 证据字段（§6.2） |
| `audit_verification_failed_pair` | 验证失败产生 remote-verification-failed；无对应 remote-command(approved) |
| `audit_approval_reconcile` | approval-resolved 与 remote-approval-decision 可对账（§6.5） |
| `audit_immutable_revoked_device` | 撤销设备后其审计记录保留（D5 §6.4） |
| `audit_mobile_no_write` | 移动端无任何审计写入命令（白名单断言） |
| `audit_redact_scan` | 跑典型远程会话 → 日志扫描零明文命中（D5 T-06 复用） |

### 8.6 验收红线（M7 增补，叠加 D5 §10.3）

1. §2.8 汇总矩阵的每一行都在 `remote_manifest.rs` 注册表有对应条目，且验证等级
   与文档一致（生成器断言）；
2. 验证分层的四档在 `verify()` 纯函数上有全矩阵单测（§8.2 四组）；
3. 「能力等价」六原则各有一项正向测试（同一命令桌面/移动端执行路径同源断言）；
4. 批量允许在引擎侧无法触达危险度 2 条目（网关断言，不依赖 UI）；
5. 账号 token 两端独立：一端撤销不影响另一端会话（集成测试）；
6. 中继/推送的 A3 联动撤销在账号中心侧全绿（AC §6.7 门禁）；
7. 审计对账（裁决缺失/验证缺失/风暴检测）各有一个告警出口测试（§6.5）。

---

## 9 合规提示

### 9.1 国内个人信息保护（PIPL 视角）

**适用范围**：crish 移动端与账号中心处理中国境内用户个人信息，受《个人信息保护法》
（PIPL，2021-11-01 施行）约束。本方案涉及的个人信息类别：

| 信息类别 | 本方案中的形态 | 处理环节 | 合规要点 |
|----------|----------------|----------|----------|
| 设备标识符 | 推送 token（厂商侧 device token）、设备注册表 deviceId、会话 device_id | 移动端注册到账号中心 push_tokens；桌面端设备注册表 | 属个人信息（可识别设备）；需隐私政策明示 + 处理目的限定（推送送达） |
| 账号信息 | 邮箱、昵称、头像 | 账号中心登录/资料 | 现状已有体系；A5 限流与 A6 重用检测属安全义务（PIPL 第 51 条安全技术措施） |
| 会话内容 | 会话消息/审批载荷/文件路径摘要 | 桌面端本地为主；移动端只读展示 | 移动端**不落盘**会话全文（仅展示缓存，F6 §11.3）；聊天记录漫游默认关（F6 §11.2） |
| 生物特征 | Face ID / 指纹验证结果 | 移动端本机（系统级生物识别 API） | **app 不采集、不上传**生物模板；审计只落「验证通过」结论（§6.2 纪律）——满足最小必要 |
| 位置信息 | 配对时的局域网来源 IP、中继连接 IP | 桌面端审计 + 账号中心/中继日志 | IP 属个人信息；审计目的限定（安全追责），保留期限与隐私政策一致 |

**PIPL 义务映射（本方案已内嵌的）**：

| PIPL 要求 | 本方案落地 |
|-----------|-----------|
| 告知同意（第 13 条） | 登录流程 + 首次配对时明示处理目的（推送/同步/安全审计）；隐私政策链接常驻设置页 |
| 最小必要（第 6 条） | 移动端不落盘会话全文；敏感文件不缓存；生物特征不上传；推送载荷服务端不落库（P-5） |
| 目的限定（第 6 条） | push token 仅用于消息送达；deviceId 仅用于设备管理与审计；禁止挪作他用 |
| 安全义务（第 51 条） | 全链路 TLS、令牌哈希存储、A5 限流、A6 重用检测、审计留痕（本方案全部章节） |
| 个人权利（第 44-49 条） | 账号中心提供会话列表/撤销（= 撤回授权）；设备撤销（= 删除设备标识）；「清空本机数据」（= 删除本地副本） |
| 数据出境（第 38-40 条） | **重点关注**：账号中心生产实例位于韩国服务器（AC §3.7 事实），中国用户数据（账号/设备标识/推送 token）出境需单独同意或通过安全评估（标准合同 / 认证路径）——**上线前必须完成法律评估**；备选：部署境内独立副本（AC §6.10 已给部署形态） |
| 第三方 SDK 披露（《SDK 安全合规指引》） | 移动端接入 expo-notifications（厂商通道）、expo-secure-store 等 SDK 时，隐私政策须列 SDK 清单与数据收集说明；国内安卓厂商推送 SDK（HMS/小米/OPPO/vivo 等）须按各厂商合规要求登记 |
| 未成年人保护（第 31 条） | 账号注册年龄门槛 + 未成年人条款（账号中心侧），移动端提示 |

**合规自查清单（上线前）**：

- [ ] 隐私政策覆盖：设备标识、推送 token、会话摘要、审计日志四类信息的处理说明；
- [ ] 首次启动用户同意流（配对/登录前的隐私告知 + 同意按钮）；
- [ ] 数据出境合规方案裁定（境内副本 vs 单独同意 vs 安全评估，§10 O-06）；
- [ ] 推送 token 的解绑/注销路径（登出、卸载、撤销设备三通道均可触发）；
- [ ] 审计日志保留期限声明（与隐私政策一致）；
- [ ] 第三方 SDK 清单随版本维护（expo 生态 + 厂商推送）。

### 9.2 应用商店安全审查（iOS ATS / Android 权限声明）

#### 9.2.1 iOS：App Transport Security（ATS）与本地网络

| 面 | 要求 | crish 移动端的对应 |
|----|------|--------------------|
| ATS 默认 | 所有 HTTP 连接必须 TLS 1.2+（ATS 默认开启） | 云账号（auth.flowbit.me）、中继（wss）、推送全部走 HTTPS/WSS——**天然合规** |
| 局域网直连例外 | `NSAllowsLocalNetworking = true`（iOS 10+ 允许本地网络明文例外，无需任意加载豁免） | 配对/局域网直连走 `http://192.168.x.x:8456`——必须在 Info.plist 声明 NSAllowsLocalNetworking，**禁止**使用 `NSAllowsArbitraryLoads` 全局豁免 |
| 本地网络隐私弹窗 | iOS 14+：访问本地网络的 app 需 `NSLocalNetworkUsageDescription` 用途文案，系统弹授权窗 | 配对扫码/局域网直连触发；文案说明「用于发现并连接您的桌面端」 |
| WebView 内容 | `NSAllowsArbitraryLoadsInWebContent`（若加载远程 Web 内容） | 本方案无远程 WebView 加载（渲染全本地，F3 §6.2），不适用——保持不开 |
| 推送 | APNs entitlement + `aps-environment`；远程通知后台模式（`UIBackgroundModes: remote-notification`，仅当头less 后台处理需要） | expo-notifications 配置（D4 §8.2 已冻结）；`enableBackgroundRemoteNotifications` 按需开启 |
| App 隐私营养标签 | App Store Connect 需申报数据收集（联系信息/设备标识符/诊断） | 按 §9.1 信息类别申报；若不做 IDFA 追踪则**无需 ATT 弹窗**（ATT 只针对跨 app 追踪） |
| 密钥库 | Keychain 访问组隔离 + `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | D5 §5.2 已冻结；注意该属性下**备份不迁移**（用户换机需重配对——这是特性不是缺陷，隐私优先） |

#### 9.2.2 Android：权限声明与国内商店

| 权限 | 用途 | 声明与合规 |
|------|------|-----------|
| `INTERNET` / `ACCESS_NETWORK_STATE` | 网络连接与状态探测 | 基础权限，自动声明（expo-network 自动加 `ACCESS_NETWORK_STATE` + `ACCESS_WIFI_STATE`，webfetch 已查证 expo-network 文档） |
| `POST_NOTIFICATIONS` | Android 13+ 通知运行时授权 | **运行时申请**（系统弹窗，Android 13 起不自动授予）；expo-notifications 要求先建通知通道再取 token（webfetch 已查证 expo-notifications 文档）；拒绝授权时功能降级（F6 §10.3 置灰引导） |
| `RECEIVE_BOOT_COMPLETED` / `SCHEDULE_EXACT_ALARM` | 定时通知/精确闹钟 | expo-notifications 自动声明；`SCHEDULE_EXACT_ALARM` 属敏感权限（Android 12+ 需用户授权），**本方案不使用精确闹钟，应关闭该声明**（实现期核对 app.json 配置） |
| 相机（扫码配对） | 配对扫码（F6 §6.1） | 运行时申请；拒绝时降级手动输码（F6 §6.1 已设计） |
| 局域网访问 | 直连桌面端（Android 13+ `NEARBY_WIFI_DEVICES`；Android 16 本地网络保护对 targetSdk 36+ 应用的连接有额外限制） | **待实现期复核**：按目标 SDK 与官方权限矩阵核对；国内 ROM（MIUI/EMUI/ColorOS 等）对后台联网/自启动有额外限制，需厂商适配说明 |
| 厂商推送（国内安卓无 GMS） | HMS/小米/OPPO/vivo/荣耀通道（D7 §5 已详评） | 各厂商推送 SDK 需在隐私政策登记；厂商后台需配置应用签名证书与包名；申请各厂商推送权限白名单 |

#### 9.2.3 商店与备案清单

| 面 | 动作 |
|----|------|
| App Store | 隐私营养标签申报；年龄分级；审核备注说明「远程控制本机桌面软件」的用途与授权机制（避免被误判为远程控制恶意软件——需附设备配对/授权流程说明）；iOS 26 SDK 最低构建要求（2026-04-28 起上传需 iOS 26 SDK，webfetch 查证 Apple 新闻 2026-02-03 项） |
| Google Play（若上架） | Data Safety 表单申报（设备标识符/应用行为）；正式版包名签名一致 |
| 国内安卓商店 | 工信部 App 备案（2023 年起强制，涉及服务器所在地与负责人信息）；各商店《隐私政策》+《用户协议》+《权限申请说明》；应用内「注销账号」入口（PIPL 第 47 条删除权） |
| 桌面端 | 不涉及商店分发（Tauri 免安装/安装包直发），但 Windows SmartScreen 签名证书建议（与安全无关，属分发信任） |

### 9.3 合规测试锚点（进测试清单）

| 用例 | 断言 |
|------|------|
| `compliance_no_biometric_collect` | 审计/日志中无生物特征数据（模板/相似度值）形态 |
| `compliance_privacy_flow` | 首次启动隐私同意流存在且未同意前不发起网络请求（配对/登录接口不可达） |
| `compliance_push_unbind_all_channels` | 登出、卸载、撤销设备三通道都能触发 push 解绑（§9.1 清单） |
| `compliance_ats_config` | iOS Info.plist 仅含 NSAllowsLocalNetworking，无 NSAllowsArbitraryLoads |
| `compliance_android_permissions` | AndroidManifest 权限清单与 §9.2.2 表一致（无多余敏感权限） |
| `compliance_cross_border_notice` | 登录/配对流程含数据出境告知文案（若裁定走单独同意路径） |

---

## 10 开放问题与决策记录

### 10.1 开放问题（需主控/评审裁决）

| 编号 | 问题 | 当前倾向 | 决策方 |
|------|------|----------|--------|
| O-01 | D3 的 token_key 派生形态与 D5 的 256bit 随机令牌形态在工程实现上如何对齐 | 以 D3 派生形态为准（消息级 HMAC 已依赖它）；D5 的随机令牌形态作为中继/账号场景的参考 | 主 Agent + 实现评审 |
| O-02 | 敏感文件读取升 L2（§2.5 增量）是否过度 | 保留 L2（持机攻击直接目标）；若评审认为打扰过重，降回 L1+横幅（可配置升级） | 主 Agent |
| O-03 | 服务器地址修改默认可配 L3 还是默认 L2 | 默认 L2 + 建议勾选升级 L3（本方案立场）；若用户量大再考虑默认 L3 | 主 Agent |
| O-04 | 移动端生物识别是否强制（无生物时强制 PIN） | 强制（宁可 PIN 不做假解锁，§3.3）；产品若坚持「游客可无锁浏览」需评审降级路径 | 主 Agent + 产品 |
| O-05 | 双轨确认的「桌面在场」判定阈值（默认 10 分钟）是否可配 | 桌面端安全中心可配（5~30 分钟）；移动端只读展示 | 主 Agent |
| O-06 | 数据出境合规路径（境内副本 vs 单独同意 vs 安全评估） | 待法律评估；技术上境内独立副本已就绪（AC §6.10） | 主 Agent + 法务 |
| O-07 | 批量允许是否需要二次确认层（R6） | 现设计：确认层已有（F2 §5.4）；上线后按批量操作审计评估是否加验证等级 | 主 Agent |
| O-08 | 中继首版是否启用 relay_credentials 全链（R-2 nonce 等加固） | 启用（账号中心侧改动量小）；中继服务一期范围以 D1/AC 排期为准 | 主 Agent |

### 10.2 决策记录（ADR 摘要）

| 决策 | 结论 | 否决选项 |
|------|------|----------|
| 同权语义 | 能力面相同 + 验证面分级（解读 A） | 解读 B（无差别执行：拉低桌面安全水位）；解读 C（特权对等：与 D-05 冲突） |
| 验证层级 | 四级 L0-L3（含冷却与双端在场） | 沿用 D5 两级（缺生物/冷却/解锁时机的细化） |
| 令牌架构 | 四类分治（配对/账号/中继/推送） | 单一令牌（断网不可用/长连接不匹配/推送无法寻址） |
| 账号 token 两端 | 各自会话，不共享 | 共享（泄露面翻倍、无收益） |
| 审计权威 | 桌面本地库唯一权威，移动端只读投影 | 移动端本地审计（可被篡改） |
| 写类默认 | 默认关闭逐项开启（编辑模式/设置通道） | 默认全开（「同权」字面化，与 D-05 冲突） |

### 10.3 实现分期建议（供任务书引用）

| 阶段 | 范围 | 出口条件 |
|------|------|----------|
| M7-A（矩阵落地） | §2.9 remote_manifest 扩展 + verify() 纯函数 + L0/L1 门 + 监控/事件流矩阵接线 | §8.6 红线 1-3 全绿 |
| M7-B（写类闭环） | L2 门 + F2 决策/批量 + F4 受控写 + F6 确认通道 + M-OUTBOX | §8.2 L2 组 + §8.3 对应域用例全绿 |
| M7-C（账号整合） | 账号中心 push_tokens/relay_credentials 对接 + 四类令牌生命周期 + A3 联动 | §8.4 令牌组全绿 + AC §6.7 门禁 |
| M7-D（极危与审计） | L3 双轨 + 审计扩展（§6.1 十四变体）+ 对账/风暴检测 | §8.2 L3 组 + §8.5 审计组全绿 |
| P2（增强） | 设备公钥双因素（D5 O-03）、FIDO2 化验证、中继面端到端加密（D5 O-01） | 按主 Agent 排期 |

---

## 附录 A 术语表

| 术语 | 定义 |
|------|------|
| 能力级（capability） | 移动端 observe / approve / operate 三级授权（D5 §4.1），服务端裁决 |
| 危险度（risk class） | 普通/敏感/危险/极危四档，矩阵输入（§2.1） |
| 验证等级（verification level） | L0-L3 四档，矩阵输出（§3.1） |
| verification_token | 验证分层产物：短期、一次性、绑定命令+requestId 的执行凭证（§1.4/§3.4） |
| 双轨确认 | 危险操作需移动端 + 桌面端本地用户共同确认（D5 §4.4），本方案为 L3 的形态 |
| 桌面在场（local_user_present） | 桌面 UI 前台 + 最近交互时间在窗口内的判定（D5 §4.4） |
| 冷却时间 | L2/L3 验证之间的最小间隔（5s/30s，§3.8），防疲劳 |
| 配对令牌 | 局域网直连的设备身份令牌（D3 派生 / D5 随机形态，§4.3） |
| 账号 token | 账号中心签发的 access/refresh（AC §4.3.1，§4.4） |
| 中继凭证 | 账号中心签发的中继连接凭据（AC §6.4，§4.5） |
| 推送注册 | 厂商通道 token 在账号中心的注册记录（AC §6.3，§4.6） |
| 桌面确认通道 | 移动端设置变更经桌面端确认条的机制（F6 §8.3，M-CONFIRM） |
| M-OUTBOX | 移动端离线决策队列的防重放设计（§7 TH-30） |

## 附录 B 代码位置索引

| 符号 | 位置 |
|------|------|
| `PermissionMode` / `PermissionVerdict` | `C:\Software\conex\crates\agent-tools\src\permission.rs:19/57` |
| `decide` / `decide_with_redline` / `decide_command` / `decide_command_with_revert` | `permission.rs:78/96/113/135` |
| `ApprovalGateImpl` / `resolve` / `request_approval` / `APPROVAL_TIMEOUT` | `C:\Software\conex\apps\agent-workbench\src-tauri\src\core_run_commands.rs:161/230/263/88` |
| `core_approve_tool` / `core_deny_tool` / `emit_approval_resolved` | `core_run_commands.rs:3750/3777/3802` |
| `spawn_audit_persistence` / `audit_persist` | `core_run_commands.rs:500/390` |
| `CredentialStore`（DPAPI） / `config_secret_*` 命令面 | `C:\Software\conex\apps\agent-workbench\src-tauri\src\config\credentials.rs:31/237-341` |
| K-02 last4 / K-05 日志 | `credentials.rs:9-11/256` |
| config_get 脱敏快照 | `C:\Software\conex\apps\agent-workbench\src-tauri\src\config\provider.rs:299-325` |
| `resolve_guard`（工作区沙箱） | `C:\Software\conex\apps\agent-workbench\src-tauri\src\fs_commands\workspace.rs:185-244` |
| 远程白名单注册表（计划新增） | `apps/agent-workbench/src-tauri/src/multi_device/remote_manifest.rs`（D5 §8.6 #10） |
| `SecurityAuditOperation` | `C:\Software\conex\crates\conex-types\src\events.rs:66` |
| `event_backpressure` | `events.rs:867` |
| `Arbiter` / `route_approval` | `C:\Software\conex\crates\session-loop\src\approval_router.rs:74/100` |
| 账号中心 auth 模块 | `C:\Software\account-center\navigation-site\zennav-server\src\modules\auth\auth.service.ts`（access 构造 2115-2147 / refresh 轮换 356-393 / 同设备会话吊销 1601-1624 / desktop-auth 1138-1292） |
| 账号中心设备注册表 | `...\zennav-server\src\modules\devices\device.service.ts` |
| push_tokens / relay_credentials（计划新增） | `...\zennav-server\src\db\schema.ts` + `src\modules\push\` + `src\modules\relay\`（AC §6.3/§6.4） |

## 附录 C 查证记录与参考

### C.1 webfetch 查证（2026-08-09）

| 主题 | 来源 | 结论 | 影响 |
|------|------|------|------|
| Android 13+ 通知权限 | docs.expo.dev/versions/latest/sdk/notifications/ | Android 13 起通知需运行时授权弹窗；先建 channel 再取 token；RECEIVE_BOOT_COMPLETED 自动声明；SCHEDULE_EXACT_ALARM 需显式声明 | §9.2.2 权限清单 |
| iOS 通知权限细粒度 | 同上 | ios.status 分 NOT_DETERMINED/DENIED/AUTHORIZED/PROVISIONAL/EPHEMERAL；APNs entitlement 开发态自动切换生产 | §9.2.1 推送配置 |
| 网络状态权限 | docs.expo.dev/versions/latest/sdk/network/ | expo-network 自动声明 ACCESS_NETWORK_STATE + ACCESS_WIFI_STATE | §9.2.2 |
| iOS 26 SDK 最低构建要求 | Apple 开发者新闻（2026-02-03 发布） | 2026-04-28 起上传 App Store 需 iOS 26 SDK | §9.2.3 |
| Apple 本地网络隐私 / ATS 细节 | Apple 官方文档页无法抓取（要求 JavaScript） | 以既有惯例（NSAllowsLocalNetworking / NSLocalNetworkUsageDescription）为准，**实现期在 Xcode 工程复核** | §9.2.1 标注待复核 |

### C.2 参考文档索引（仓库内）

| 文档 | 引用章节 |
|------|----------|
| `docs/multi-device/plans/D5-security.md` | §3.3 令牌 / §4 授权 / §5 密钥 / §6 审计 / §9 测试（全文） |
| `docs/multi-device/plans/AC-account-center-evaluation.md` | §4.3 令牌体系 / §6.2-§6.5 调整方案 / §7 集成面 |
| `docs/multi-device/plans/D3-protocol.md` | §4.4 密钥派生 / §4.5 设备注册表 / §5 消息鉴权 |
| `docs/multi-device/plans/D1-overall-architecture.md` | §3.3 中继角色 / §4.5 云账号可选 |
| `docs/multi-device/plans/D7-push-notifications.md` | §4 路线 C（推送注册表） |
| `docs/multi-device/plans/F1-monitor-panels.md` | §6 权限边界 / §2.5 事件映射 |
| `docs/multi-device/plans/F2-approval-center.md` | §9 交互 / §10 权限对等 / §11 冲突 / §12 契约 |
| `docs/multi-device/plans/F3-event-stream-terminal.md` | §4.5 终端边界 / §7.4 通知触发点 |
| `docs/multi-device/plans/F4-files-assets.md` | §4 读写策略 / §7 安全边界 / §9 测试 |
| `docs/multi-device/plans/F5-session-messages.md` | §2.5 委托执行 / §5 同步模型 |
| `docs/multi-device/plans/F6-settings-account.md` | §5 账户 / §8 权限边界 / §11 隐私 / §13 错误文案 |

---

*文档结束。本方案为 M7 子代理产出，供主 Agent 汇总与评审；实现前需按 §8.6 验收红线逐条走查，并与 D5 §10.3 红线合并为多端安全验收总清单。*
