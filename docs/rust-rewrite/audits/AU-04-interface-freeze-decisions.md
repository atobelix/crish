# AU-04 跨 PE 接口冻结表与去重裁决文档

> 日期：2026-08-01 · 性质：裁决文档（只读，不改任何代码）
> 输入：AU-01（21 项契约冲突 / 37 处同文件并行 / 16 组重复）、AU-02（覆盖 74% / 脱管项 / 空白区）、
> AU-03（D1-D6 / C1-C6 / 修订分级）、PE-01 ~ PE-10 十份任务书原文、关键代码实测（2026-08-01 快照）。
> 裁决原则：**每一项只给一个终态**（唯一责任方 + 唯一签名/语义），不存在「两者皆可」；
> 未列出的冲突以本表为准，所有任务书原文与本节冲突处一律按本表修订后再执行。
> 冻结版本：本文所有接口冻结版本号 = **v1**（2026-08-01）。任何后续变更须走 PE-03 T03.9 的
> manifest + changelog 登记机制（C13 裁决）。

---

## 一、接口冻结表

> 引用约定：签名中的 `[]` 表示数组；`?` 表示 Option/可选；`|` 表示枚举或联合。
> 「唯一负责任务书」= 实现该接口的任务书；「协作任务书」= 只读消费/引用、不得单独改签名。

### F1 ProviderCall trait 增量流签名（C1 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `ProviderCall::stream`（`crates/session-loop/src/provider.rs`） |
| 唯一负责 | **PE-09 T09.1.1/T09.1.2**（实现）；契约正文 SoT 归 **PE-02 §3.1**（修订后） |
| 协作任务书 | PE-02（T02.1 契约正文修订、mock 源按本形状）；PE-10（transport/mod.rs 串行前置） |

```rust
// crates/session-loop/src/provider.rs —— 冻结签名（v1）
pub type ProviderStreamItem = Result<ProviderStreamEvent, ClassifiedStreamError>;
pub type ProviderEventStream = Pin<Box<dyn Stream<Item = ProviderStreamItem> + Send>>;

#[async_trait]
pub trait ProviderCall: Send + Sync {
    /// 流前 Err = 传输层/HTTP/首帧错误，尚未产出任何事件（进重试阶梯）；
    /// 流中 Err(item) = 中途错误：已产出内容 → 内容保留收场（不重试）；未产出 → 重试阶梯；
    /// 每流恰好一个 Stop，Stop 后流立即结束；abort 协作按 safe_point 语义；
    /// 流为 'static，不得借用 request（请求体在返回流前完成序列化）。
    async fn stream(&self, request: &ProviderRequest<'_>)
        -> Result<ProviderEventStream, ClassifiedStreamError>;
}
// ProviderRequest<'a> { messages: &'a [AgentMessage], tools: Vec<ToolSchema>, max_tokens: Option<u32> }
```

- **别名取定**：条目别名 = `ProviderStreamItem`（PE-02 名，弃用 PE-09 的 `StreamItem`）；
  流别名 = `ProviderEventStream`（PE-09 名，PE-02 契约正文补入）。两个名字只各保留一个。
- **生命周期**：`ProviderRequest<'a>`（PE-09 T09.3 阶段 1 的借用改造），PE-02 §3.1.1 修订正文补此参数。
- **增量性硬约束**：禁止跨帧/跨块聚合后一次性 emit（P1 修复本质）。
- **实施形态**：允许 PE-09 换 tokio mpsc 形态，但必须保持事件形状/顺序/终止/取消语义，并经锚点测试回归。
- **锚点**：`crates/session-loop/tests/streaming_incremental_contract.rs` 由 PE-02 落壳、PE-09 填实现；
  PE-09 T09.1.3 验收**显式引用**该文件。
- **阈值口径（AU-03 C4 统一）**：Rust 集成测试（mock SSE 慢速分块）首条 delta 到达事件桥 **< 600ms**（硬断言）；
  前端端到端 `requestToFirstChunkMs` **< 500ms**（PE-02 T02.6 总验收）；「流产出后到达事件桥 ≤ 300ms」降为
  T09.7 内部基准记录，不作验收门。三个数字是三个测量点，口径不冲突，任何任务书不得新增第四套数字。

### F2 CoreStatus 字段集（C4/D16 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `core_get_status` 返回体 `CoreStatus`（`core_query_commands.rs:49`，serde camelCase） |
| 唯一负责 | 组装基线 **PE-01 T01.1/T01.2**；字段集契约 SoT **PE-03 T03.9** |
| 协作任务书 | PE-03（activeRuns/pendingApprovals/mcpStatus）、PE-04（诊断段）、PE-08（restore/snapshot）——按序增量并入，**同文件严格串行** |

```jsonc
// 冻结 JSON 形状（v1）——既有 6 字段语义不变，其余按域增量
{
  "initialized": bool,                 // PE-01 T01.2 真实化（setup 成败），不再恒 true
  "version": string,
  "engineReady": bool,
  "searchIndexReady": bool,
  "dbReady": bool,
  "compactionReady": bool,             // PE-01 T01.2 真实化，未接线压缩 = false
  "providerStatus": {                  // PE-01 T01.1 —— 字段名取定 providerStatus（PE-03 名）
    "hasApiKey": bool | null,          // null = store 未初始化/无法判定；false = 明确无 key
    "model": string | null,
    "baseUrl": string | null,
    "credentialMode": string | null
  },
  "activeRuns": number,                // PE-03 T03.5（H2 运行条；替代 workbench_performance_snapshot）
  "pendingApprovals": number,          // PE-03
  "mcpStatus": { "enabled": bool, "configured": bool },   // PE-03 T03.7（list-capabilities 回补）
  "logLevel": string,                  // PE-04 T04.5-1
  "logDir": string,                    // PE-04 T04.5-1
  "diagnostics": [ { "subsystem": string, "ready": bool, "message": string | null, "updatedAt": number } ],
  "lastError": CrishErrorPayload | null,   // PE-04 T04.5-1（AtomicSlot 驱动）
  "restore": { "state": "pending"|"done"|"failed", "mode": string, "snapshotNote": string | null,
               "interruptedCount": number, "lastSequence": number | null },   // PE-08 T08.6
  "snapshot": { "generation": number, "writtenAt": number | null, "lastError": string | null }  // PE-08 T08.6
}
```

- **字段名裁决**：输出侧只存在 `providerStatus`；`provider`/`config` 仅作为**前端解析层**的兼容读取路径
  （PE-01 T02.1 保留，方向只读）。
- **build_status 组装**：单一函数单一实现；PE-01 定基线参数（initialized/compactionReady/providerStatus），
  PE-03 → PE-04 → PE-08 各域以**追加参数**并入；严禁并行改同一函数。
- **串行顺序（core_query_commands.rs）**：PE-01 → PE-03 → PE-04 → PE-08。PE-09 只读该命令（T09.5 不动 status）。

### F3 upsert_session_entry 命令签名（C2 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `upsert_session_entry`（`session_commands.rs`，session 族第 12 个命令） |
| 唯一负责 | **PE-08 T08.1** |
| 协作任务书 | PE-01（T06.1 改引用，不重复实现）；PE-03（manifest/契约登记）；PE-09（无） |

```rust
#[tauri::command]
pub async fn upsert_session_entry(entry: SessionIndexEntry) -> Result<(), CoreError>;
// rename_all = "camelCase"；薄包装 conex-db lib.rs:354（upsert_session_entry(&SessionIndexEntry)）
// 语义：ON CONFLICT(id) DO UPDATE，不级联删消息（upsert_does_not_cascade_delete_messages 先例锚定）
```

- **取定对象签名**（PE-08 平铺 vs 对象之争）：`(entry: SessionIndexEntry)`，与底层实现一致；
  PE-01 的平铺参数方案作废。

### F4 cleanup_orphan_sessions 空 keepIds 语义 + 宽限期（C3/C15 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `cleanup_orphan_sessions`（`session_commands.rs:189`） |
| 唯一负责 | **PE-08 T08.2** |
| 协作任务书 | PE-01（T06.2/T06.3 改引用）；PE-03（契约登记）；前端 persist 调用方（PE-08 T08.10/PE-09 T09.4.2） |

```rust
#[tauri::command]
pub async fn cleanup_orphan_sessions(active_ids: Vec<String>, confirm_empty: bool)
    -> Result<usize, CoreError>;
// 语义（v1）：
// - active_ids 非空：删除不在集合内的孤儿行，返回删除行数；
// - active_ids 为空 且 confirm_empty == false：**不执行任何 DELETE**，
//   返回 Err(CoreError { kind: "InvalidInput", detail: "cleanup_orphan_empty_keep" })（前端可见）；
// - active_ids 为空 且 confirm_empty == true：显式清空，返回删除行数（仅测试/显式用户清空入口使用）。
```

- **宽限期（24h vs 5min）取定**：**5 分钟**。阈值常量 `ORPHAN_GRACE_MS = 300_000`，session_meta 可配
  （键 `orphan_grace_ms`）；清理时对 keepIds 之外、`updated_at` 距今 < 5 分钟的会话跳过删除。
  PE-01 的 24h 常量作废，改引用 PE-08 语义。
- 前端守卫联动：persist 前置 `hydrationComplete && list.length > 0`（PE-08 T08.2 动作 2 定稿）；
  `lsSaveSessionIndex([])` 同守卫。`hydrationComplete` 变量由 PE-01 T04.4 产出（PE-03 审计 §3.4 的无主项闭合）。

### F5 配置命令命名终态表（C5/C6/C13/D11/D12/D13 裁决）

| 命令 | 终态名（v1） | 处置 | 唯一负责 | 协作 |
|---|---|---|---|---|
| update_daemon_config | **config_update** | 更名（签名不变）；删 `sentToDaemon` 字段 | PE-01 T03.1（Rust 改名） | PE-03 T03.4 同步、PE-07 T07.4（删明文组装） |
| get_api_config | **config_get** | 更名 + 接线 | PE-03 T03.4/T03.5 | PE-01 T03.2 前端读面 |
| save_api_config | **删除** | 写路径并入 config_update | PE-03 T03.5 | PE-01 修订（不再保留现名） |
| workbench_profile_secret_set | **config_secret_set** | 更名 + 接线 | PE-03 T03.4/T03.5 | PE-01 T03.2、PE-07 T07.4 |
| workbench_profile_secret_get | **config_secret_get** | 更名 + 接线；**默认仅回 {hasKey, apiKeyLast4}**（K-02） | PE-03 改名、PE-07 T07.4-C 定语义 | — |
| workbench_profile_secret_has | **config_secret_has** | 更名 + 接线 | PE-03 T03.4/T03.5 | — |
| workbench_profile_secret_clear | **config_secret_clear** | 更名 + 接线 | PE-03 T03.4/T03.5 | — |
| workbench_profile_apply（PE-07 新） | **config_profile_apply** | 进程内读 DPAPI 直写 ApiConfigStore，返回 { ok, apiKeyLast4, model } | **PE-07 T07.4** | PE-03 登记 manifest/契约 |
| workbench_profile_secret_reveal（PE-07 新） | **config_secret_reveal** | 带一次性 UI 确认参数回明文 | **PE-07 T07.4-C** | PE-03 登记 |
| workbench_dev_mcp_enabled（PE-07 新） | **workbench_dev_mcp_enabled**（GUI 面保留 workbench_ 前缀） | 返回 { enabled, execEnabled } | **PE-07 T07.5** | PE-03 登记 |

- **命名体系裁决**：配置与密钥族一律 `config_*`（PE-03 契约面）；PE-07 新增的两条密钥命令**改名为
  `config_profile_apply` / `config_secret_reveal`**（不得保留 workbench_profile_ 原名，否则违反单终态）；
  `workbench_dev_mcp_enabled` 属 GUI 面（workbench_*），不改名。
- **syncActiveProfileToEngine（C6）**：**删除**（函数 + 启动调用，grep 零命中验收，PE-01 T03.4 执行）。
  PE-07 T07.4-A 的「保留函数改为调 apply」**作废**；密钥生效仅限用户主动路径
  （`activateProfileModel`/`saveProfileKey`/`saveProfileBaseUrl`）改走 `config_profile_apply`。
- **明文迁移（C7/D12）**：**单一实现** = PE-01 的 `migrateLegacyProfiles.ts`（文件与幂等标记
  `crish_profiles_secrets_migrated_v1`）+ PE-07 的全 LS 键扫描断言 + 失败重试一次。
  **唯一负责方 = PE-07 T07.4-B**；PE-01 T03.3 删除（其验收并入 PE-07 用例 1-2）。
- **前端读写面**：`rustProfileStore.ts`（PE-01 T03.2）保留为唯一薄封装，方法名对应终态表；
  `setProfileKey` 写 `config_secret_set` + `config_update`，localStorage 只写 hasKey 元数据不写明文。

### F6 RecoveryHook::decide 签名（C10 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `RecoveryHook::decide`（`crates/session-loop/src/loop/mod.rs:100`） |
| 唯一负责 | **PE-06 T06.5.3** |
| 协作任务书 | PE-04（仅消费：调用点传 `&err.code()`，不改签名）；PE-03（core_error_code 映射） |

```rust
pub trait RecoveryHook: Send + Sync {
    fn decide(&self, error: &CrishError, state: AgentSessionState) -> RecoveryDecision;
}
// 现状 `error: &str` 改为 `error: &CrishError`（state 参数既有，保持）
// 缺省实现保留；恢复钩子基于码分类裁决而非文本匹配
```

### F7 save_session_body 写模型（C14/C3.2 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `save_session_body`（`conex-db lib.rs:490`，DELETE+INSERT 单事务） |
| 唯一负责 | **PE-08 T08.10（D4 定稿）** |
| 协作任务书 | PE-09（T09.4 修订）；PE-03（契约登记）；前端 hydrate/首次落地（PE-08） |

- **裁决：全量替换保留**（`save_session_body` 语义冻结不变：事务内 DELETE 全表 + 逐条 INSERT；
  产品语义 = 可删除/编辑历史消息）。**PE-09 T09.4.1 第 2 条（改 ON CONFLICT upsert）删除**；
  其行为变化面 R6（「删除/编辑历史消息后全量保存不再清除旧行」）**撤销**。
- **写放大消除路径取定**：新增命令 `append_session_messages(session_id: String, messages: Vec<SessionMessage>)
  -> Result<(), CoreError>`（session 族第 13 个，唯一负责 **PE-09 T09.4.1 第 1 条**，PE-08 提供底层
  lib.rs:544 增量 API 并登记 manifest）；日常 commit 走增量 append（前端 id 幂等去重），
  hydrate/首次落地/显式修复走全量 save_session_body。
- **写者所有权**：session_messages/agents 前端唯一拥有（PE-08 D4）；引擎只写 events/runs/pending。

### F8 error_bridge 去留（C9/D15 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `apps/agent-workbench/src-tauri/src/error_bridge.rs`（整个模块） |
| 唯一负责 | **PE-03 T03.3 动作 3（删除）** |
| 协作任务书 | PE-04（T04.1-4 修订：先迁移能力，不接线保留） |

- **裁决：删除**（以 AA-02 S-5 / 03 §5.3-5 为准）。PE-04 T04.1-4 修订为「把 `safe_invoke_sync` 的
  catch_unwind 防爆语义迁入 `core_error.rs`（命令层包装）」；迁移完成后 error_bridge.rs 由 PE-03 整体删除。
- 执行时序：PE-04 迁移能力 → PE-03 删除模块（同一提交链，禁止并行）。

### F9 ApprovalGate 传递形态（C35/P8 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | `execute_batch` / handler 签名（`tool_exec.rs:80`、`executing_tools.rs:42`、`loop/mod.rs:333`） |
| 唯一负责 | **PE-09 T09.6** |
| 协作任务书 | PE-06（T06.1 改 mark_rest_cancelled 签名时不得动 approval 参数形态）；PE-02（选项 B 前端批量审批，另行任务书） |

```rust
// 冻结（v1）：跨 async 边界一律 Arc 传递
execute_batch(..., approval: Option<Arc<dyn ApprovalGate>>, ...)
handler(... approval: Option<Arc<dyn ApprovalGate>> ...)     // loop/mod.rs:333 self.approval.clone()
execute_one(...) 内部保持 &dyn（approval.as_deref()）          // 仅单点消费
// 执行模型取定 A：审批逐个 await（事件顺序不变）→ 通过后执行阶段 join_all 并行
```

### F10 锁中毒归属与清单（C12/D1 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | agent-tools 三文件全部运行时锁 expect 修复（idempotency.rs / mcp/bridge.rs / middleware.rs） |
| 唯一负责 | **PE-07 T07.6**（安全 DoS 面论证充分） |
| 协作任务书 | PE-06（T06.6 **删除**，改引用 PE-07；Q19 合理 expect 保留归 PE-06 标注） |

- **归属边界按「安全相关 vs 通用」重新划分**：三文件的锁 expect 全部划归 PE-07（安全面：外部
  回调/MCP server 可触发持锁 panic = DoS）；PE-06 只保留 Q19（from_utf8 已前置校验的合理 expect，标注保留）
  与 Q20（测试替身）等非锁项。
- **清单复核方法（以 rg 实测为准，2026-08-01）**：

```
rg -n "\.expect\(" crates/agent-tools/src/idempotency.rs crates/agent-tools/src/mcp/bridge.rs crates/agent-tools/src/middleware.rs
```

| 文件 | 实测 `.expect(` 总数 | 构成 |
|---|---|---|
| idempotency.rs | 12 | 生产 10（138,154,166,189,215,233,241,251,265,273）+ 测试 2（556,565） |
| mcp/bridge.rs | 25 | 锁 expect 22 处 + 结果 expect 3 处（**279/334/538**）；`541` 行为 `expect_err`（与 538 同一 match 样板对，不作为独立行号） |
| middleware.rs | 2 | 139,157 |

- **修正两书数字**：PE-06 摘要「36 处」→ 实为 37（含 middleware 2）；表内 bridge 行号补 279/334/538。
  PE-07 清单「26 锁 + 2 结果」→ 25 处 `.expect(`（22 锁 + 3 结果），删除已不存在的 541 行号条目。
- **验收口径**：`rg "\.expect\(" crates/agent-tools/src` 仅剩测试与 Q19 保留项；
  中毒单测 A/B/C 三级（PE-07 T07.6 用例 1-3）通过。

### F11 事件 schema 版本化归属（AU-02 §五-5 裁决）

| 项 | 冻结内容（v1） |
|---|---|
| 接口名 | AgentEvent wire 形状 / SQLite payload 的版本化机制 |
| 唯一负责 | **PE-03 新增任务 T03.10**（事件载荷版本化：changelog 覆盖 AgentEvent 形状演进 + 旧事件 JSON 兼容解析测试 + 前端/持久化双端 golden） |
| 协作任务书 | PE-08（提供 v3 旧事件 fixture 样本）、PE-09（T09.2/T09.3.2 roundtrip 测试作 wire 不变守门） |

- 说明：IPC 命令契约版本化已有（PE-03 T03.9 manifest + changelog）；事件载荷版本化补 T03.10，
  与 T03.9 同一契约文档扩展，**不新建第二套机制**。

### F12 其余 AU-01 冲突项逐项裁决（C13/C17-C21）

| # | 冲突 | 终态裁决（v1） |
|---|---|---|
| C13 | 命令总数 64 vs 新增命令 | PE-03 修订：验收改「**core_list_commands 返回条数 == 当前注册面**」（公式化表述，删除硬编码 64）；新增命令全部登记 manifest + 契约 changelog。**新增命令登记表（9 条）**：upsert_session_entry（PE-08）、append_session_messages（PE-09）、config_profile_apply、config_secret_reveal、workbench_git_run、workbench_fs_delete_file、workbench_open_workspace、workbench_list_workspaces、workbench_dev_mcp_enabled（PE-07）。T03.9 契约冻结排在上述命令面稳定之后 |
| C17 | useDaemonState/ConnectionManager 三方 | 重命名归 **PE-05 T05.7.2**（末轮统一）：useDaemonState.ts → useEngineState.ts、事件名 → 'engine:connection:change'；PE-01 T04.3 / PE-06 T06.8 组 2 用旧名开发；发布/订阅一致性单测由 PE-05 负责 |
| C18 | ChatStatusRibbons.tsx | **PE-01 T02.2 删除 sync-engine 分支先行** → PE-05 T05.4.1 拆分在后（SetupHintBanner 无 sync-engine 分支；文件按实测 913 行复核） |
| C19 | commandMap.ts | **PE-03 T03.1 重构先行**（manifest 驱动 + 删 9 幽灵）；PE-01 T03.1 的 'update-config'→config_update 并入 PE-03，PE-01 改引用 |
| C20 | tauriTransport.ts | **PE-01 T02.3 先行**（isCoreReady 仅判 engineReady）→ PE-03 T03.2（transport.call 唯一入口）随后；同文件串行 |
| C21 | MCP 插件处置 | **PE-10 批次 B 项 15 先行锁定 rev=c7d271a**（无论后续是否移除插件，rev 锁定均必须且无害）；PE-07 T07.5 决策树唯一化：默认目标 = 路径 2「仓内最小实现 dev_mcp/」（AUTH token 握手 + 命令集注册表），插件支持 token（路径 1）仅在实现期核实后作为替代，路径 3「默认关闭」为兜底；若插件被移除，PE-10 的 feature 化优化项（dev-mcp）随之激活。两书批 5/批次 B 同步执行并会签 |

---

## 二、重复任务去重表（16 组，AU-01 §三 D1-D16 逐项裁决）

> 保留项 = 唯一执行者；删除/合并项 = 任务书修订时必须改为「引用/移交」声明，不得保留任务体。

| # | 功能 | 保留 | 删除 / 合并 | 理由 |
|---|---|---|---|---|
| D1 | 锁中毒修复 | **PE-07 T07.6** | PE-06 T06.6 删除 | 安全 DoS 面归属（F10）；两书清单数字均修正为实测 |
| D2 | P01 新会话落库 | **PE-08 T08.1** | PE-01 T06.1 改引用 | F3 对象签名与底层一致；PE-01 平铺参数作废 |
| D3 | P02 空 keepIds 拒绝 | **PE-08 T08.2** | PE-01 T06.2 改引用 | F4 Err+confirm_empty 定稿 |
| D4 | P05 LocalDbStore spawn_blocking | **PE-08 T08.5** | PE-01 T06.4 改引用 | 逐方法清单一致，单执行者防重复 |
| D5 | P09/P10 清理核对 + 近期保护 | **PE-08 T08.2/T08.10** | PE-01 T06.3 改引用 | F4 宽限期 5 分钟 + SQLite 真相源 |
| D6 | 启动就绪归一 + gateTimer + useEngineBootstrap 删除 | **PE-01 T04.1/T04.2 主责** | PE-06 T06.11 仅保留特有部分（E13 删除、遥测订阅收敛） | 同文件重叠；PE-06 引用 PE-01 为主 |
| D7 | sessionIndexLoader 删除 + E3/E12 串行 + waitForHydration 接线 | **PE-01 T04.4 主责** | PE-06 T06.11 组 8 移交 | 同上；hydrationComplete 变量归 PE-01 T04.4 产出 |
| D8 | Q30 删 From\<CoreError\> | **PE-06 T06.5.4**（类型）+ **PE-03 T03.3 动作 1**（core_error_code 映射） | PE-04 T04.3-6 删除 | 类型/映射双边界，PE-04 不落 conex-types/error.rs |
| D9 | LoopError/EndDecision.error/RunOutcome.error 升级 | **PE-06 T06.5.1/T06.5.2** | PE-04 T04.3-3 仅保留日志消费部分 | F6/C11 |
| D10 | Q31 兜底文案 | **PE-06 T06.5.5** | PE-04 T04.3-5 删除 | C11 |
| D11 | 配置命令接线 | 命名 **PE-03**；前端读写面 **PE-01 T03.2**；Rust 密钥语义 **PE-07 T07.4** | 三书各自方案收敛为 F5 终态表 | 单终态命名 + 三方分工 |
| D12 | 明文 key 迁移 | **PE-07 T07.4-B**（单实现 = PE-01 文件结构 + PE-07 扫描断言） | PE-01 T03.3 删除 | F5/C7 |
| D13 | syncActiveProfileToEngine | **PE-01 T03.4 删除**（用户主动路径走 config_profile_apply） | PE-07 T07.4-A「保留改造」作废 | F5/C6 |
| D14 | 日志/事件脱敏 | Rust 单实现 **PE-07 T07.4-D**（conex-telemetry/src/redact.rs::redact_secret + last4）；前端单实现 **PE-04 T04.4-4**（utils/redact.ts，共享同一正则规范） | PE-04 的 format.rs::redact_secrets 不新建 | C8；PE-04 在 panic_hook/文件层调用 PE-07 实现 |
| D15 | error_bridge 治理 | **PE-03 T03.3 删除** | PE-04 T04.1-4/T04.3-4 修订为「迁移能力后移交」 | F8/C9 |
| D16 | core_get_status 诚实化/扩展 | 字段集 **F2 冻结**；组装基线 **PE-01 T01.1/T01.2**；契约 SoT **PE-03 T03.9** | PE-04 T04.5-1 / PE-08 T08.6 按 F2 增量并入，不定义第二形状 | C4 |

---

## 三、脱管与空白区认领表（AU-02 §五 + §二 未覆盖项逐项裁决）

| # | 脱管/空白项 | 严重度 | 认领（唯一） | 任务落点 |
|---|---|---|---|---|
| 1 | Q21 取消长工具等 timeout、Q33 aborted 标注、Q40 重试间隙查 abort | 重要/建议 | **PE-09 新增任务 T09.9「abort 时序三修复」** | 与 T09.1 同文件区（streaming.rs / stream_error.rs / tool_exec.rs），T09.1 之后执行；PE-06 §7「移交 PE-05 运行行为域」表述**作废** |
| 2 | Q23 同会话并发 run sequence 冲突 | 重要 | **PE-08 新增任务 T08.12「会话级 sequence 原子分配」** | conex-db 提供 `reserve_sequence(session_id)`（单行原子自增）或 orchestrator 每会话 AtomicU64 + store 校验，替代「两 run 并发 base=max+1」；依赖 T08.7；验收：同会话双 run 并发 append 无 UNIQUE 冲突 |
| 3 | 前端测试策略（e2e/visual 回归门禁） | — | **PE-05 新增任务 T05.9「迁移期视觉回归门禁」** | playwright 快照基线入 CI（test:visual）；PE-05/PE-06 每迁移批跑快照 diff；hooks 合并后 vitest 全量强制回归 |
| 4 | 首 token 总验收 owner 互等（PE-02 ↔ PE-09） | — | **PE-09 T09.8 唯一 owner** | PE-02 T02.6 只提供基线数据与前端埋点；验收权在 PE-09；基线存档合并为单一文档 `docs/rust-rewrite/audits/PE-perf-baseline.md`（PE-09 T09.7 维护，PE-02 写入） |
| 5 | AA-05 范围外 10 项（I-02/I-03/I-05/M-01/M-02/M-03/K-03/K-04/X-02/X-03） | 中/低 | **PE-07 新增任务 T07.8「范围外项登记表」** | 逐项决议 + 轮次，登记进 30-verification-checklist；PE-07 §0.3「归后续批次」改为指向 T07.8 |
| 6 | 事件 schema 版本化 | 部分空白 | **PE-03 新增任务 T03.10** | 见 F11 |
| 7 | 事件 payload 上限（AA-05 D-02） | 低 | **PE-08 T08.3 新增子项** | 事件 payload 256KB 上限 + 截断标记（同 events 表治理） |
| 8 | fs 命令同步阻塞/分页上限（AA-02 S-9） | 建议 | **PE-03 T03.3 新增动作** | workbench_list_directory 分页上限；read/write_file_content spawn_blocking |
| 9 | P-02 drive-relative/UNC 变体测试 | 低 | **PE-07 T07.2 新增用例** | from_optional_root 删除后补 drive-relative（`C:foo`）与 UNC 变体 + 根不可达退化测试 |
| 10 | Q25 失败路径序列空洞 | 建议 | **PE-08 T08.8 子项升级为必做** | 从「可选」升「必做」，与 Q24 同文件 |
| 11 | Q08 folder rebind immer 直写任务体 | 重要 | **PE-06 T06.11 补任务体** | 收敛为经命名 action，含验收断言 |
| 12 | Q17/Q18 消除点任务体 | 建议 | **PE-06 T06.8 补任务体** | buildPatchAsst/finalizeInFlight 改 streamingStore 缓冲；`as any` 三处消除 |
| 13 | Q19 useSidebarSessions 范式 | 建议 | **PE-06 T06.8 补任务体** | 改 useSyncExternalStore 模板，随组 1 迁移 |
| 14 | Q22/Q28 agent-tools 生命周期 | 建议 | **登记 30-verification-checklist**（低危，无新建任务） | Q22 有 30s 超时兜底、Q28 任务泄漏不可观测，登记观察 |
| 15 | Q39/Q41、S-7 reqwest 复用、S-11 审批半成品、S-17/S-18、Q14 restore 双实现、F5/M1、P9/P10/F6 | 低 | **登记 30-verification-checklist**（有决议、无任务） | 不新建任务；S-11 的 deny 状态机恢复部分随 PE-09 T09.6 落地后复评 |
| 16 | P11 对话压缩（AA-06 建议 vs PE-06 删除） | 中 | **终态：PE-06 T06.2.3 删除成立** | PE-09 0.4 的 P11「后续域」改为「登记不做（需真实压缩实现 + 滚动窗口，未来另立任务）」 |
| 17 | PE-08 T08.7 真实 v3 库样本来源 | — | **PE-08 指定** | 样本来源：执行者从用户机器收集 ≥1 个真实 v3 库 + fixture 构造 v1/v2/v3 等价样本（§三.3.1 已列构造法）；无真实样本时以 fixture 为准并登记 |
| 18 | PE-03 T03.1 验收前置矛盾 | — | **PE-03 修订** | 「core_list_commands 返回 64 条」→「返回条数 == 当前注册面，且与 make_handlers! 一致」 |
| 19 | PE-06 T06.11 验收不可测（不合格） | — | **PE-06 修订** | 补具体断言：订阅数、merge 串行、门闩时序（对齐 PE-01 T04.x 风格） |
| 20 | PE-02 失效引用 markdownCache.ts | — | **PE-02 修订** | 该行资产引用删除（文件不存在） |
| 21 | PE-05 行号系统性过时（+10~68 行） | — | **PE-05 修订** | 大组件行号按现状复核（ChatStatusRibbons 913 等）；css 路径补全（styles/shell/、styles/settings/） |

---

## 四、修订指令摘要（供修订 agent 逐书执行）

> 执行前置（任何 PE 开工前）：跑一次「断言自检」（行号/文件存在性复核，AU-03 P10）。

### PE-01（大修）
1. T01.1：字段名 `provider` → `providerStatus`（F2）；ProviderStatus 字段与 hasApiKey 三态语义按 F2。
2. T03.1：保留改名动作，命令名按 F5 终态表；删 `sentToDaemon` 照旧。
3. T03.2：rustProfileStore 五方法名对照 F5 终态表（config_get/config_update/config_secret_*）；验收 mock 断言改终态名。
4. T03.3：**删除任务**（迁移单实现归 PE-07 T07.4-B，本任务改引用）。
5. T03.4：保留删除 syncActiveProfileToEngine；用户主动路径改走 `config_profile_apply`（引用 PE-07 命令，不自行实现）。
6. T06 组（T06.1/6.2/6.3）：**改引用 PE-08 T08.1/T08.2**，删除任务体；T06.4 改引用 PE-08 T08.5。
   `ORPHAN_GRACE_MS` 改 300_000（F4）。
7. T04 组保留（主责）；T04.3 用旧名 useDaemonState（PE-05 末轮改名）；T04.4 产出 hydrationComplete 变量（声明为公共门闩供 PE-08 消费）。
8. T01.2/T02.3/T02.1 照旧（字段名按 F2）；T02.1 解析器兼容读含 `providerStatus`/`provider` 双路径（只读兼容）。
9. 行号漂移修正：core_query_commands.rs:330-342（compaction_ready 已参数注入）、profileStore.ts:310-318（明文写点在 ~302-306）、tauriTransport.ts:46-62（OR 循环在 36-49）。
10. 主执行顺序：main.rs 排 PE-01 首个；core_query_commands.rs 字段基线 PE-01 先行（F2 串行序）。

### PE-02（小修）
1. §3.1.1 契约正文：补 `ProviderRequest<'a>` 生命周期；别名统一为 `ProviderStreamItem` + `ProviderEventStream`（弃 `StreamItem`）；明确「本文件即契约 SoT，PE-09 落地时同步回写」。
2. 删除失效资产引用 markdownCache.ts（文件不存在）。
3. T02.6 阈值按 F1 口径（500ms 端到端 / 600ms 集成 / 300ms 内部基准，只留两处验收）；基线文档合并到 PE-perf-baseline.md（PE-09 维护）。
4. T02.2/T02.4 视觉验收补自动化断言或明确人工检查清单（AU-03 §四）。
5. 契约锚点文件注明「PE-09 T09.1.3 验收显式引用」。

### PE-03（大修）
1. T03.1 验收改「返回条数 == 当前注册面」；「64」全文档改公式化表述 + 变更登记机制（F12-C13）。
2. §2.2 core_get_status 字段集与 F2 冻结表一致（providerStatus 名；activeRuns/pendingApprovals/mcpStatus 形状按 F2）。
3. §2.2-C 配置族命令终态表 = F5（新增 config_profile_apply / config_secret_reveal 两行，删除行号引用处补登记）。
4. T03.3：新增 fs 命令分页上限动作（认领表 #8）；error_bridge 删除动作保留（与 PE-04 迁移时序声明）。
5. 新增 T03.10 事件载荷版本化（F11）；T03.9 契约冻结排在各域命令面稳定后。
6. main.rs 执行顺序声明（六方串行）：PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07。
7. commandMap 重构先行（C19），吸收 PE-01 的 'update-config'→config_update。

### PE-04（大修）
1. T04.3 组删减：T04.3-1（DbFailure From）与 T04.3-2（StoreError From）**移交 PE-06**；T04.3-3 仅保留「日志/传播消费」部分并引用 PE-06 类型；T04.3-5（Q31）与 T04.3-6（Q30 工厂）**移交 PE-06**；T04.3-4 删除（error_bridge 收口职责随 F8 删除，由 PE-03 承接）。
2. T04.1-4 修订：迁移 catch_unwind 语义到 core_error.rs 后配合 PE-03 删除 error_bridge（F8）。
3. T04.4-4：Rust 侧不新建 format.rs::redact_secrets，调用 PE-07 的 redact.rs::redact_secret（C8）；前端 redact.ts 保留为本域实现。
4. T04.5-1 字段名按 F2（logLevel/logDir/diagnostics/lastError，camelCase），与 PE-01/PE-03 串行合入 core_query_commands.rs。
5. 执行顺序：错误类型（PE-06）先行 → 本域日志消费随后；main.rs 接线排 PE-04 位次（第三）。

### PE-05（小修）
1. 全文行号复核（AU-03 偏差表：ChatStatusRibbons 913、SettingsPanel 753、FirstRunWizard 834、Workspace 665、RuntimePanel 692、SettingsRulesTab 680、PreviewCard 664、ScheduledTasksPanel 656、useTopBarDrag 786、UnifiedSelectPopover 262、SettingsSelect 180、AgentCard 420）；css 路径补全（styles/shell/、styles/settings/）。
2. T05.4.1：ChatStatusRibbons 拆分声明「在 PE-01 T02.2 之后执行」（SetupHintBanner 无 sync-engine 分支）；864 改 913。
3. T05.7 末轮执行不变；声明与 PE-01 T04.3 / PE-06 T06.8 组 2 的重命名时序（C17）。
4. 新增 T05.9 视觉回归门禁（认领表 #3）。
5. T05.8 中 LoggerService 行删除（PE-04 T04.4-1 接线，本域不回收）。

### PE-06（大修）
1. T06.6 **删除**（改引用 PE-07 T07.6，F10）。
2. T06.5 扩为错误类型本体全责：接收 PE-04 移交的 T04.3-1/T04.3-2（DbFailure/StoreError → CrishError From 映射）、Q31 文案、Q30 显式工厂；RecoveryHook 签名按 F6。
3. T06.11：补验收断言（订阅数/merge 串行/门闩时序）+ 补 Q08 任务体（认领表 #11）；启动归一部分以 PE-01 T04 为主（D6/D7）。
4. T06.8 补 Q17/Q18/Q19 消除点任务体（认领表 #12/#13）。
5. T06.7 中 useStreamRenderThrottle 行删除（PE-02 T02.3 已接线，去留自然闭合）。
6. §7 边界表：Q21/Q33/Q40 移交表述作废，改指 PE-09 T09.9；Q35「记录不改」作废，按 PE-09 T09.6 修复。
7. 同文件串行声明：tool_exec.rs（PE-06 T06.1 先行，PE-09 T09.6 后）；streaming.rs（PE-09 T09.1 重构先行，T06.2.1 短路点随后落点调整）；loop/mod.rs、handlers/mod.rs 与 PE-09 串行。

### PE-07（小修）
1. T07.4：新增命令终态名 `config_profile_apply` / `config_secret_reveal`（F5）；迁移 = 单实现（migrateLegacyProfiles.ts + 幂等标记 + 全键扫描 + 重试一次，唯一负责方）；删「保留 syncActiveProfileToEngine」方案（C6）。
2. T07.6：清单按 F10 实测修正（bridge 25 处 `.expect(` = 22 锁 + 279/334/538 结果 expect；541 行号删除，标注为 expect_err 与 538 同对；总数 37）。
3. 新增 7 命令（git_run/fs_delete_file/open_workspace/list_workspaces/dev_mcp_enabled/config_profile_apply/config_secret_reveal）全部登记进 PE-03 manifest/契约（C13 登记表）。
4. T07.2 补 drive-relative/UNC 单测（认领表 #9）。
5. T07.5 与 PE-10 批次 B 项 15 会签（C21：默认仓内实现路径，rev 锁定先行）。
6. 新增 T07.8 范围外项登记表（认领表 #5）；§0.3 表述改指 T07.8。
7. 执行批次不变（批 0 含 T07.6；批 5 与 PE-10 会签）。

### PE-08（大修）
1. 声明为 sessionRustDb.ts / migrateFromLocalStorage.ts / 会话持久化域**唯一 owner**（PE-01 T06 组引用本域）。
2. T08.1：upsert_session_entry 签名 = F3（entry: SessionIndexEntry）；自愈 INSERT OR IGNORE 保留。
3. T08.2：cleanup 签名 = F4（confirm_empty: bool + 空集 Err + 5 分钟宽限期）；hydrationComplete 门闩依赖 PE-01 T04.4（声明前置依赖，PE-01 先行或门闩变量先落地）。
4. T08.8：Q25 子项升必做；新增 T08.12（Q23 原子分配，认领表 #2）。
5. T08.3：新增 payload 上限子项（认领表 #7）。
6. T08.7：样本来源指定（认领表 #17）。
7. T08.10：与 PE-09 T09.4 串行声明（写模型 = 全量替换，F7）；confirm 语义按 F4。
8. persistAllSessionsRust 终态顺序定稿（C16）：upsert 全部索引 → body/agents → meta → 清理孤儿 → LS 索引（非空）。
9. core_query_commands.rs 字段扩展（restore/snapshot）排在 PE-01/PE-03/PE-04 之后（F2 串行序）。

### PE-09（大修）
1. T09.1.1：契约引用 PE-02 §3.1 SoT；别名/生命周期按 F1；T09.1.3 验收显式引用锚点文件。
2. T09.4.1：**删除 save_session_body 改 upsert**（F7，R6 撤销）；保留 append_session_messages 命令 + 前端增量（id 幂等）；hydrate 保留全量。
3. T09.5：query_events 加 limit 签名冻结（restore 传 None）不变；与 PE-08 T08.x 串行。
4. 新增 T09.9（Q21/Q33/Q40，认领表 #1）。
5. 首 token 口径按 F1（600/500/300 三测量点）；G3 总验收 owner = T09.8；基线文档合并到 PE-perf-baseline.md。
6. 同文件串行声明：streaming.rs/handlers/mod.rs 与 PE-06（T06.2.1 短路点落点、T06.1 先行）；transport/mod.rs 与 PE-10（依赖升级先行）；tool_exec.rs 与 PE-06 T06.1（PE-06 先行）。
7. P11 压缩「后续域」改「登记不做」（认领表 #16）。
8. T09.6 ApprovalGate 形态按 F9（Arc）；与 PE-06 无冲突声明。

### PE-10（可直接执行 + 2 处会签）
1. 无契约级修订；批次 A 与业务任务任意并行。
2. 批次 B 项 15（tauri-plugin-mcp 锁 rev）与 PE-07 批 5 会签（C21）；Cargo.toml 依赖增量统一由 PE-10 管理（PE-04 tracing-appender 0.2、PE-09 criterion 0.5 只提需求）。
3. transport/mod.rs 与 PE-09 T09.1.2 串行（PE-10 先行，reqwest 0.13 后 stream_frames 无 API 差异）。
4. 前端 package.json / vite.config.ts 与 PE-05 新增 check 脚本不并行（批次 C 与 PE-05 错开）。

---

## 附录：关键执行串行表（同文件多书）

| 文件 | 串行顺序 |
|---|---|
| main.rs | PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07 |
| core_query_commands.rs | PE-01（字段基线）→ PE-03（activeRuns/pendingApprovals/mcpStatus）→ PE-04（logLevel/logDir/diagnostics/lastError）→ PE-08（restore/snapshot） |
| session_commands.rs | PE-08（upsert/cleanup 终态）→ PE-09（append_session_messages） |
| sessionRustDb.ts | PE-08（写模型定稿）→ PE-09（T09.4.2 增量） |
| streaming.rs | PE-09 T09.1 重构先行 → PE-06 T06.2.1 短路点落点调整 |
| tool_exec.rs | PE-06 T06.1 先行 → PE-09 T09.6（Arc 化） |
| conex-db/src/lib.rs | PE-08 先行（v4 迁移 + 命令层）→ PE-09（append 接线） |
| config/provider.rs | PE-01（改名）→ PE-03（终态名/删除 save_api_config）→ PE-07（删明文组装） |
| AppBootstrap.ts | PE-01 T04.x 先行 → PE-06 T06.10/T06.11 后 |
| ChatStatusRibbons.tsx | PE-01 T02.2 先行 → PE-05 T05.4.1 |
| commandMap.ts | PE-03 T03.1 重构（含 PE-01 映射变更） |
| tauriTransport.ts | PE-01 T02.3 先行 → PE-03 T03.2 |
| error_bridge.rs | PE-04 迁移 catch_unwind → PE-03 删除（互斥操作单方落地） |
| agent-tools 三文件 | 仅 PE-07 T07.6（PE-06 移除） |

*本裁决基于 2026-08-01 仓库快照与十份任务书原文；代码行号引用均已 rg 实测。*
