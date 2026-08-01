# AU-01 交叉计划冲突审计（10 份执行任务书）

> 审计日期：2026-08-01 · 审计性质：只读（不改任何代码）
> 审计对象：`docs/rust-rewrite/plans/PE-01 ~ PE-10`（10 份执行任务书）
> 对照基线：`23-architecture-hardening-plan.md`（总纲 E1-E7）、`00-master-plan.md`（主方案，Phase A-D 已完成）
> 方法：逐份通读 + 代码行号实测抽查（rg/Select-String 复核 30+ 处引用）
> 结论性质：交叉矛盾清单（冲突 → 裁决建议），供任务书修订与执行调度使用

---

## 一、接口契约冲突清单

| # | 涉及任务书 | 冲突描述 | 裁决建议 |
|---|---|---|---|
| C1 | PE-02 × PE-09 | **ProviderCall::stream 契约不一致**。PE-02 §3.1.1（契约 SoT）：`ProviderStreamItem` 别名 + `request: &ProviderRequest`（无生命周期）；PE-09 T09.1.1：`StreamItem`/`ProviderEventStream` 别名 + `&ProviderRequest<'_>`（与 T09.3 阶段 1 借用改造联动）。① 类型别名命名不同；② ProviderRequest 生命周期参数 PE-02 契约未含；③ **契约 SoT 归属互相声明**（PE-02：本文件即契约 SoT、PE-09 必须按此实现；PE-09 §0.3：接口契约点"本任务产出、PE-02 消费"）。测试锚点 `streaming_incremental_contract.rs` 仅 PE-02 提及（PE-09 验收未点名该文件） | 契约 SoT 归 **PE-02 §3.1**（PE-02 修订正文：补 `ProviderRequest<'a>` 生命周期、别名统一为单一名）；PE-09 落实现时同步回写契约文档；PE-09 T09.1.3 验收显式引用锚点文件。DeltaSink/前端消费语义（sequence=None、message-delta 逐事件）两书一致，无冲突 |
| C2 | PE-01 × PE-08 | **upsert_session_entry 命令签名互斥**。PE-01 T06.1：平铺参数 `(session_id, title, ...)`；PE-08 T08.1：`(entry: SessionIndexEntry)`。实测 conex-db lib.rs:354 底层实现为 `upsert_session_entry(&self, entry: &SessionIndexEntry)` —— PE-08 与底层一致（薄包装），PE-01 需转换层 | 统一为 **SessionIndexEntry 对象签名**（PE-08 T08.1 方案）；PE-01 T06.1 修订；执行由 PE-08 单一负责 |
| C3 | PE-01 × PE-08 | **cleanup_orphan_sessions 空集语义互斥**。PE-01 T06.2：空数组返回 `Ok(0)` 不删 + 可选 `confirm: Option<bool>`；PE-08 T08.2：返回 `Err(DbFailure{kind:"cleanup_orphan_empty_keep"})`（命令层 CoreError）+ 显式 `confirm_empty: bool`。同一命令（session_commands.rs:189，现状无 confirm 参数）两种终态 | 统一为 PE-08 方案（Err 可见 + `confirm_empty: bool`，符合 PE-01 自身"错误协议 CoreError"红线）；PE-01 修订 |
| C4 | PE-01 × PE-03 × PE-04 × PE-08 | **core_get_status 字段四方扩展不一致**。PE-01 T01.1：`provider: ProviderStatus{hasApiKey,model,baseUrl,credentialMode}`（camelCase）；PE-03 §2.2-A：`providerStatus?, activeRuns, pendingApprovals, mcpStatus?`（未给内部形状）；PE-04 T04.5-1：`log_level, log_dir, diagnostics[], last_error`；PE-08 T08.6：`restore{...}, snapshot{...}`。**字段名 provider vs providerStatus 冲突**；字段集互不包含；build_status 四方各加参数（实测 build_status 已在 core_query_commands.rs:167-179，已带 compaction_ready 参数） | PE-03 T03.9 契约文档为**唯一字段集 SoT**：字段名择一（建议 `providerStatus`，与契约面命名一致）；PE-01/PE-04/PE-08 按其扩展；build_status 组装由 PE-01 先定基线，其余域增量加参数 |
| C5 | PE-01 × PE-03 × PE-07 | **配置命令三种命名终态并存**。PE-01 T03.1/T03.2：`config_update` + **get_api_config/save_api_config 保留现名**（实测二者存在：provider.rs:386/404）；PE-03 T03.4/T03.5：`config_get`（改名）+ **save_api_config 删除** + `workbench_profile_secret_*`→`config_secret_*`；PE-07 T07.4：沿用 `workbench_profile_secret_*` 原名 + 新增 `workbench_profile_apply`/`workbench_profile_secret_reveal`。同一批命令三个终态 | 以 **PE-03 契约面为准**（config_update/config_get/config_secret_*，save_api_config 删除——写路径与 config_update 重叠属实）；PE-01 的 rustProfileStore 命令名按此修订；PE-07 新增命令须登记进 PE-03 manifest/契约（见 C13） |
| C6 | PE-01 × PE-07 | **syncActiveProfileToEngine 存废互斥**。PE-01 T03.4：删除函数 + 启动调用（grep 零命中验收；实测调用点 AppBootstrap.ts:301-302、useEngineBootstrap.ts:38-39、profileStore.ts:565、providerProfiles.ts:76）；PE-07 T07.4-A：**保留函数**，改为调 `workbench_profile_apply`（不携带明文） | 采纳 **PE-01 删除**（进程内引擎无"同步"概念）；密钥生效改走 PE-07 的 apply 命令但仅限用户主动路径 `activateProfileModel`（两方案合并后执行） |
| C7 | PE-01 × PE-07 | **明文迁移双实现**。PE-01 T03.3：`migrateLegacyProfiles.ts` + 标记 `crish_profiles_secrets_migrated_v1` + 失败整体中止重试；PE-07 T07.4-B：`migrateLegacyPlaintextKeys()`（bootstrap 前置）+ 全 LS 键扫描断言 + 失败重试一次 | 合并为**单一实现**（PE-01 的文件/幂等标记 + PE-07 的全键扫描断言加固）；唯一负责方 |
| C8 | PE-04 × PE-07 | **脱敏工具双实现**。PE-04 T04.4-4：`conex-telemetry/format.rs::redact_secrets` + 前端 `utils/redact.ts`；PE-07 T07.4-D：新建 `conex-telemetry/redact.rs::redact_secret`。同仓两个脱敏函数 | 合并：conex-telemetry 内**单实现**（择一位置），前端 redact.ts 单实现，共享同一正则；唯一负责方 |
| C9 | PE-03 × PE-04 | **error_bridge.rs 存废互斥**。PE-03 T03.3：**删除整个模块**（map_* 全移除）；PE-04 T04.1-4：**保留并接线**（safe_invoke_sync 应用到 fs/config 命令、map_* 保留兜底）。两书都引 AA-02 S-5/03 §5.3-5 结论相反 | 以 **PE-03 删除为准**（AA-02 S-5 原文）；PE-04 修订 T04.1-4 与风险 R7（其 catch_unwind 防爆能力在删除前移交命令层）；执行上 PE-04 先接线 PE-03 后删 |
| C10 | PE-04 × PE-06 | **RecoveryHook::decide 签名互斥**。PE-04 T04.3-3：签名不变（`&str`），调用点传 `err.code().to_string()`；PE-06 T06.5.3：签名改 `decide(&self, error: &CrishError, state)` | 采纳 **PE-06 类型化签名**（PE-06 管错误类型本身，PE-04 消费）；PE-04 修订 |
| C11 | PE-03 × PE-04 × PE-06 | **Q29/Q30/Q31 错误类型升级三重重复 + 互斥签名**。同一文件 conex-types/src/error.rs:982-1012「删 From<CoreError> + 显式工厂」三本都做（PE-03 T03.3-1 / PE-04 T04.3-6 / PE-06 T06.5.4）；LoopError 结构化（PE-04 T04.3-3 ≈ PE-06 T06.5.1）；EndDecision.error/RunOutcome.error 升级（PE-04 T04.3-3 ≈ PE-06 T06.5.2）；Q31 文案（PE-04 T04.3-5 ≈ PE-06 T06.5.5） | 按 PE-06 §5.1 边界表切割：**错误类型本体归 PE-06**，PE-04 只做日志/传播并引用 PE-06 类型（PE-04 的 T04.3 组删减）；`core_error_code` 77 码映射归 PE-03（IPC 契约面） |
| C12 | PE-06 × PE-07 | **锁中毒归属 + 计数互斥**。两书都把 agent-tools 三文件（idempotency.rs / mcp/bridge.rs / middleware.rs）全部锁 expect 修复列为本域。实测（rg）：idempotency 10 处（138-273 与两书清单完全吻合）、bridge.rs 全部 `expect(` 25 处（含 3 处 result expect：279/334/538；541 行不存在）、middleware 2 处 → 合计 37。PE-06 摘要称"36 处"、表内 bridge 仅列 22 位置声称"25 锁"；PE-07 称"26 锁 + 2 结果"（清单 26 行含已不存在的 541） | 唯一负责方 **PE-07**（安全 DoS 面论证充分，PE-06 移除 T06.6）；计数以 rg 实测为准（bridge 全部 expect 25 处）；PE-07 清单删除 541、标注 279/334/538 为 result expect |
| C13 | PE-03 × PE-07 × PE-08 × PE-09 | **命令总数 64 与新增命令冲突**。PE-03 冻结 64 清单 + "core_list_commands 返回 64 条"验收；执行期 PE-07 新增 6-7 个（workbench_git_run / workbench_fs_delete_file / workbench_open_workspace / workbench_list_workspaces / workbench_dev_mcp_enabled / workbench_profile_apply ± reveal）、PE-08/PE-01 新增 upsert_session_entry（session 第 12）、PE-09 新增 append_session_messages（session 第 13）→ 预计 64+8+ | PE-03 修订"64"为**公式化表述 + 变更登记机制**（新增命令走 changelog，T03.9 契约冻结排在其他域命令面稳定后）；PE-07 新命令全部登记进 manifest 与契约文档 |
| C14 | PE-08 × PE-09 | **save_session_body 写模型矛盾**。PE-08 D4/T08.10：前端唯一拥有 + **全量替换保留**（先删后插，产品语义=可删除历史消息）；PE-09 T09.4.1：改 ON CONFLICT upsert（保留旧行）+ 日常 commit 改 append 增量。R6 已自登记"删除/编辑历史消息后全量保存不再清除旧行" | 产品裁决后统一：**推荐 PE-09 只新增 append_session_messages 增量命令、不改 save_session_body 语义**；若改则 PE-08 D4 同步修订。PE-09 T09.4 与 PE-08 T08.10 同文件必须串行 |
| C15 | PE-01 × PE-08 | **清理宽限期 24h vs 5min**。PE-01 T06.3：`ORPHAN_GRACE_MS` = 24h；PE-08 D6/T08.2/T08.10：排除 `updated_at` < 5 分钟 | 统一（建议 PE-08 的 5 分钟 + session_meta 可配）；PE-01 修订阈值常量并交叉引用 |
| C16 | PE-01 × PE-08 | **persistAllSessionsRust 最终形态双书定稿**。PE-01 T06.1：先 upsert（含空 body）再 body/agents；PE-08 T08.2：单事务序列「upsert 全部索引 → body/agents → meta → 清理孤儿 → LS 索引（非空）」。兼容但同函数两终态 | 以 **PE-08 顺序定稿**为准（PE-08 主责 sessionRustDb.ts），PE-01 引用不重复实现 |
| C17 | PE-01 × PE-05 × PE-06 | **useDaemonState/ConnectionManager 三方动同一标识符**。PE-01 T04.3：useDaemonState 改消费 ConnectionManager.onStateChange；PE-06 T06.8 组 2：保留实现直接写"useEngineState"名（预设 PE-05 重命名已完成）；PE-05 T05.7.2：useDaemonState.ts→useEngineState.ts + 事件名 'daemon:connection:change'→'engine:connection:change' | 重命名归 **PE-05**（自声明排最后执行）：PE-01/PE-06 用旧名开发，PE-05 末轮统一改名；事件名发布/订阅一致性单测由 PE-05 负责 |
| C18 | PE-01 × PE-05 | **ChatStatusRibbons.tsx 同文件互改重叠区**。PE-01 T02.2：删 sync-engine 分支（实测 149-155/287-292/310-311 区域 ✓）；PE-05 T05.4.1：大拆分 + 前 290 行文案纯函数入 lib（正含 287-292 删除区）。文件实测 913 行（PE-05 称 864，漂移） | PE-01 删除先行（提示面消失 → PE-05 拆分少一个分支），或合并为同一执行者；PE-05 修订行数 |
| C19 | PE-01 × PE-03 | **commandMap.ts 两方案**。PE-01 T03.1：'update-config'→config_update 单行改；PE-03 T03.1：manifest 驱动整体重构 + 删 9 幽灵（实测幽灵 9 条在 31-40 行 ✓） | PE-03 重构先行，PE-01 的映射变更并入（PE-03 §7.1 重命名总表已含该行） |
| C20 | PE-01 × PE-03 | **tauriTransport.ts 两改**。PE-01 T02.3：isCoreReady 单判据（实测 OR 语义在 36-49 行，引用 46-62 漂移）；PE-03 T03.2：transport.call 唯一入口 + waitUntilConnected 复用 call | 兼容，同文件串行（PE-01 先行或合并） |
| C21 | PE-07 × PE-10 | **MCP 插件处置分叉**。PE-07 T07.5：默认关闭 + token + 命令集收缩，无 token 支持则**移除插件依赖**→仓内实现 dev_mcp/；PE-10 T10.10e：锁 rev（c7d271a）+ 可选 feature 化 dev-mcp（后续优化项）。实测 main.rs:126-134 为 debug_assertions 注册 ✓ | 先锁 rev（PE-10 批次 B）；PE-07 批 5 决策后若移除插件，PE-10 的 rev 锁定与 feature 化二选一失效——两书需同步执行 |

---

## 二、同文件并行冲突矩阵（同文件多任务书修改且未声明串行/归属）

| 文件 | 涉及任务书 | 建议 |
|---|---|---|
| apps/agent-workbench/src-tauri/src/main.rs | PE-01（T05.1/T01.2/T03.1/T06.1）、PE-03（T03.1/T03.6）、PE-04（T04.1-2/T04.2-4）、PE-08（T08.1/T08.6）、PE-09（T09.4.1）、PE-07（T07.5） | **全串行**（唯一 setup 装配点）；建议顺序 PE-01 → PE-03 → PE-04 → PE-08 → PE-09 → PE-07；每轮仅一个任务书动 main.rs |
| session_commands.rs | PE-01（T06.1/T06.2）、PE-08（T08.1/T08.2）、PE-09（T09.4.1） | PE-08 主责（T08.1/T08.2，含签名/语义裁决 C2/C3）；PE-01 T06 组并入；PE-09 的 append_session_messages 命令在其后 |
| core_query_commands.rs | PE-01（T01.x）、PE-04（T04.5-1）、PE-08（T08.4）、PE-09（T09.5） | 串行：PE-01 先定字段基线（C4）→ PE-04 diagnostics → PE-08/PE-09 增量 |
| sessionRustDb.ts | PE-01（T06.1/6.2/6.3）、PE-08（T08.1/8.2/8.10）、PE-09（T09.4.2） | PE-08 主责（写模型定稿 C14/C16）；PE-09 T09.4.2 其后 |
| AppBootstrap.ts | PE-01（T04.1-T04.4）、PE-06（T06.10/T06.11） | **内容重叠**（引擎归一、E12 merge 门闩、E13 删除）：合并为单一执行者或 PE-01 T04.x → PE-06 T06.10/6.11 严格串行 |
| useDaemonState.ts / ConnectionManager.ts | PE-01（T04.3）、PE-05（T05.7.2）、PE-06（T06.8 组 2） | 见 C17：功能改 PE-01/PE-06 先行（旧名），重命名 PE-05 末轮统一 |
| ChatStatusRibbons.tsx | PE-01（T02.2）、PE-05（T05.4.1/T05.8） | 见 C18 |
| engineConfig.ts | PE-01（T02.1/T03.1）、PE-03（T03.4）、PE-07（T07.4） | PE-01 解析逻辑 → PE-03 命令名 → PE-07 明文剥离，串行 |
| config/provider.rs | PE-01（T03.1）、PE-03（T03.4/T03.5）、PE-07（T07.4） | 命名统一按 PE-03（C5）；明文组装删除 PE-07 与改名合并执行 |
| profileStore.ts | PE-01（T03.2/3.3/3.4）、PE-07（T07.4） | 见 C5/C6/C7：以 PE-03 命名 + PE-01 删除 sync + PE-07 apply 命令合并 |
| streaming.rs（session-loop） | PE-06（T06.2.1 Empty 短路 103-107）、PE-09（T09.1 整文件重构） | 串行：PE-09 重构先行（PE-06 的短路点在重构后落点变化） |
| provider.rs（session-loop） | PE-02（契约冻结 §3.1.1）、PE-09（T09.1.1 落地 + T09.3 阶段 1） | PE-02 冻结正文 → PE-09 落地（见 C1） |
| tool_exec.rs | PE-06（T06.1 Q01 修复 444-478）、PE-09（T09.6 审批并行 122-184） | **同一段区域**（并行分支）：串行，PE-06 T06.1 先行（Q01 阻塞级） |
| loop/mod.rs | PE-06（T06.2/T06.4/T06.5）、PE-09（T09.1 步骤 4/T09.3.3/T09.6） | 串行或合并（错误类型 PE-06 先行，增量通道 PE-09 后） |
| loop/handlers/mod.rs | PE-06（Q02 等）、PE-09（T09.3.2 record_message Arc） | 串行（record_message 是高频冲突点） |
| crates/conex-db/src/lib.rs | PE-08（T08.1-8.4/8.7）、PE-09（T09.4.1）、PE-01（T06.1/6.2 引用） | PE-08 先行（v4 迁移定稿 + 命令层裁决），PE-09 的 save_session_body 改 upsert 待 C14 裁决 |
| crates/orchestrator/src/persist.rs | PE-01（T06.4）、PE-08（T08.5）、PE-09（T09.5） | **PE-01 T06.4 与 PE-08 T08.5 完全重复**：PE-08 主责；PE-09 的 query_events 加 limit 签名在其后（restore 传 None 语义已声明） |
| crates/orchestrator/src/events.rs | PE-09（T09.2 by value）、PE-04（T04.2-3/T04.3-5）、PE-08（T08.9 测试） | 串行：PE-06 错误类型（C11）→ PE-09 零克隆 → PE-04 日志 |
| crates/orchestrator/src/restore.rs | PE-08（T08.4/8.6/8.8）、PE-09（T09.5） | PE-08 主责，PE-09 的 limit=None 调用点适配 |
| core_run_commands.rs | PE-09（T09.1 步骤 4/T09.2）、PE-08（T08.6/T08.8）、PE-04（T04.2-3） | 串行：PE-08 restore 门禁先行 → PE-09 → PE-04 日志 |
| conex-types/src/error.rs | PE-03（T03.3）、PE-04（T04.3-6）、PE-06（T06.5.4） | **三重重复**：PE-06 类型 + PE-03 的 core_error_code，PE-04 不落此文件（C11） |
| conex-types/src/events.rs | PE-09（T09.2/T09.3.2）、PE-04（T04.3-3）、PE-06（T06.5.2） | 串行：错误字段（PE-06）→ Arc 化（PE-09），roundtrip 测试守门 |
| error_bridge.rs | PE-03（删除）vs PE-04（接线） | **互斥操作**：裁决后单方执行（C9） |
| agent-tools 三文件（idempotency/bridge/middleware） | PE-06（T06.6）vs PE-07（T07.6） | **PE-07 唯一负责**（C12） |
| crates/conex-telemetry | PE-04（subscriber/panic_hook/format）、PE-07（T07.4-D 脱敏） | 脱敏合并为单实现（C8）；tracing-appender 依赖 PE-04 与 PE-10 的 Cargo.toml 变更合并 |
| migrateFromLocalStorage.ts | PE-01（T06.3）、PE-08（T08.1-4/T08.2/T08.10） | PE-08 主责（C15/C16） |
| bootstrap-full.ts | PE-01（T04.1/T04.4）、PE-06（T06.8 组 2）、PE-05（T05.7） | 合并或串行；PE-05 自声明 owner（R1 冻结清单） |
| commandMap.ts | PE-01（T03.1）、PE-03（T03.1） | PE-03 主责（C19） |
| transport/mod.rs（agent-provider） | PE-09（T09.1.2 步骤 1）、PE-10（T10.2 reqwest 0.13） | 串行：PE-10 依赖升级先行（reqwest 0.13 后 stream_frames 无 API 差异） |
| 根 Cargo.toml | PE-04（tracing-appender 0.2）、PE-10（reqwest 0.13/tokio 最小集/regex 等）、PE-09（criterion 0.5） | 依赖声明统一由 PE-10 管理（合并增量），PE-04/PE-09 只提需求 |
| TerminalCard.xterm.tsx | PE-05（T05.5.1 tokens）、PE-10（T10.7b React.lazy） | 串行（互不依赖，任序） |
| normalize.rs（orchestrator） | PE-08（T08.9 终态映射）、PE-09（T09.3.2 Arc 构造） | 串行（PE-08 先行，改动小） |
| AsyncMarkdownBlock.tsx | PE-02（T02.2/T02.4 重写）、PE-03（T03.4 md_render→core_md_render 调用点） | PE-02 重写先行（组件 73 行），PE-03 改名调用点并入 |
| main.tsx | PE-07（T07.5 setupPluginListeners）、PE-04（T04.4-1 LoggerService 接线） | 串行 |
| package.json / vite.config.ts（前端） | PE-10（删包/optimizeDeps）、PE-05（新增 check 脚本） | 串行，PE-10 批次 C 与 PE-05 不并行 |

---

## 三、重复任务清单

| # | 功能 | 重复位置 | 处置 |
|---|---|---|---|
| D1 | 锁中毒修复（agent-tools 三文件全清单） | PE-06 T06.6 = PE-07 T07.6 | 保留 PE-07（C12） |
| D2 | P01 新会话落库链路 | PE-01 T06.1 ≈ PE-08 T08.1 | 保留 PE-08（C2） |
| D3 | P02 空 keepIds 拒绝全删 | PE-01 T06.2 ≈ PE-08 T08.2 | 保留 PE-08（C3） |
| D4 | P05 LocalDbStore spawn_blocking | PE-01 T06.4 = PE-08 T08.5（逐方法清单一致） | 保留 PE-08 |
| D5 | P09/P10 清理核对 + 近期会话保护 | PE-01 T06.3 ≈ PE-08 T08.2/T08.10 | 保留 PE-08（C15/C16） |
| D6 | 启动就绪归一 + gateTimer 删除 + useEngineBootstrap 删除 | PE-01 T04.1/T04.2 ≈ PE-06 T06.11（Q01） | 合并：PE-01 T04 组主责，PE-06 T06.11 仅保留其特有部分（E13/遥测订阅） |
| D7 | sessionIndexLoader 删除 + E3/E12 串行 + waitForHydration 接线 | PE-01 T04.4 ≈ PE-06 T06.11（Q02/Q03） | 同上合并 |
| D8 | Q30 删 From<CoreError> + 显式工厂 | PE-03 T03.3 × PE-04 T04.3-6 × PE-06 T06.5.4（三重） | PE-06 类型 + PE-03 映射（C11） |
| D9 | LoopError / EndDecision.error / RunOutcome.error 升级 | PE-04 T04.3-3 ≈ PE-06 T06.5.1/5.2 | 保留 PE-06（C11） |
| D10 | Q31 兜底文案升级 | PE-04 T04.3-5 ≈ PE-06 T06.5.5 | 保留 PE-06 |
| D11 | 配置命令接线（前端接入 Rust 真源） | PE-01 T03.2 ≈ PE-03 T03.5 ≈ PE-07 T07.4（三命名方案） | 命名归 PE-03，接线按合并后终态执行（C5） |
| D12 | 明文 key 迁移流程 | PE-01 T03.3 ≈ PE-07 T07.4-B | 合并单实现（C7） |
| D13 | syncActiveProfileToEngine 处理 | PE-01 T03.4（删）vs PE-07 T07.4（保留改造） | 采纳删除（C6） |
| D14 | 日志/事件脱敏 | PE-04 T04.4-4 ≈ PE-07 T07.4-D | 合并（C8） |
| D15 | error_bridge 治理 | PE-03（删）vs PE-04（接线） | 采纳删除（C9） |
| D16 | core_get_status 诚实化/扩展 | PE-01 T01.1/T01.2 × PE-04 T04.5-1 × PE-08 T08.6（×PE-03 契约） | 四方合并字段集（C4） |

---

## 四、数字 / 引用抽查结果（任务书引用 vs 代码实测）

> 抽查方法：对任务书引用行号在代码仓库 rg/Select-String 实测（2026-08-01 现状）。

| 任务书 | 引用 | 实测 | 结论 |
|---|---|---|---|
| PE-01 | core_query_commands.rs:49-62（CoreStatus 形状缺口） | `pub struct CoreStatus` 在 49 行 ✓；build_status 在 167-179 且**已带 compaction_ready 参数** | 49-62 ✓；「330-342 compaction_ready=true」**漂移**（该区域现为 core_read_session_events/测试），且"硬编码"描述与现状（参数注入）部分过时 |
| PE-01 | AppBootstrap.ts:300-304（syncActiveProfileToEngine）、316-321（gateTimer） | sync 调用 301-302 ✓；gateTimer 314-321 ✓ | ✓ 准确 |
| PE-01 | config/provider.rs 483、496（sentToDaemon） | 483/496 均命中 ✓（PE-03 引 488-498 略偏） | ✓ 准确 |
| PE-01 | profileStore.ts:310-318（明文 apiKey） | `p.apiKey = apiKey` 实际在 ~302-306 | 事实成立，行号**漂移约 8 行** |
| PE-01 | tauriTransport.ts:46-62（OR 语义） | OR 循环在 36-49 | 语义 ✓，行号**漂移约 10 行** |
| PE-01 | engineConfig.ts:424-429（缺省 false） | 424-427 已是三态 boolean 判断 | 区域 ✓，但"缺省 false"描述与现状（部分三态化）**不一致** |
| PE-02 | AsyncMarkdownBlock.tsx:34/51-59；streaming.rs:234-245；stream.rs:240-316；engine.rs:293-324；StreamRenderBuffer.ts:225-234 | 34/51-59 ✓（纯文本 div）；emit_message_deltas 定义 234 ✓；consume 240 ✓；engine.rs 293 为 read_stream ✓；frame.html/chunkUpdates 在 225-234 ✓ | 全部 ✓ 准确 |
| PE-03 | commandMap.ts:31-39（9 幽灵） | 幽灵条目 31-40 ✓（git-status 31、list-mcp-servers 33、rewind 36 等） | ✓ 准确 |
| PE-03 | main.rs make_handlers 计数 78 | 宏从 26 行起（未逐条数完） | 未完全复核（低风险，P0 轮可核） |
| PE-04 | LoggerService 109 行；telemetryStore 128 行 | 实测 109 / 128 ✓ | ✓ 准确 |
| PE-04 | core_query_commands.rs:49-62 | ✓（同 PE-01） | ✓ |
| PE-05 | ChatStatusRibbons 864 行 | 实测 **913 行** | **漂移 49 行**（拆分清单需按现状复核） |
| PE-05 | useStreamRenderThrottle 64 行 | 实测 59 行 | 小漂移 |
| PE-06 | tool_exec.rs:444-478（mark_rest_cancelled + from_idx） | 445-470 ✓，签名含 from_idx、跳过条件 `i <= from_idx \|\| results[i].is_some()` ✓ | ✓ 完全准确 |
| PE-06 | idempotency.rs 10 处（138-273） | 10 处全部命中 ✓（+ 测试 556/565） | ✓ 准确 |
| PE-06 | bridge.rs "25 锁 + 2 样板"，表列 22 位置 | 全部 `expect(` 25 处（锁 22 + result expect 279/334/538）；表内行号缺 279/334/538 | 表列与声称数**不一致** |
| PE-06 | telemetryStore 128 行 / StreamRenderBuffer 314 行 | 128 / 314 ✓ | ✓ |
| PE-07 | conex-sandbox lib.rs:20-51（两组合成正则） | gatekeeper 模块自 1 行起，blocked 12 条/approval 8 条在 ~25-55 ✓ | ✓ 准确 |
| PE-07 | gitApi.ts:306-329（runLocalGit 拼串） | 306 ✓；`git -C ${q(cwd)} ...` 拼串 317 ✓ | ✓ 准确 |
| PE-07 | config/mod.rs:69-144（secret 命令） | workbench_profile_secret_set 在 69 ✓ | ✓ |
| PE-07 | main.rs:126-134（MCP 插件） | debug_assertions + start_socket_server(true) + tcp_localhost(4000) 在 124-133 ✓ | ✓ |
| PE-07 | bridge.rs 26 锁 + 2 结果（清单含 541） | 541 行**不存在**（538 为 result expect） | 清单需修正 |
| PE-08 | conex-db lib.rs:834-836（空 keepIds 全删） | `if active_ids.is_empty() { tx.execute("DELETE FROM sessions", []) }` 在 833-836 ✓ | ✓ 完全准确 |
| PE-08 | session_commands.rs:73-238（11 命令无 upsert） | list_sessions 自 74 起 ✓；无 upsert 命令 ✓ | ✓ |
| PE-08 | sessionRustDb.ts:780-845 / 807-844 | persistAllSessionsRust 780 ✓、keepIds 818-822、cleanup 844 ✓ | ✓ |
| PE-08 | persist.rs:384-472（LocalDbStore 8 方法） | 方法在 380-471 ✓ | ✓ |
| PE-08 | restore.rs:512-622；SnapshotFileStore:389 | restore 512 ✓、SnapshotFileStore 389 ✓ | ✓ |
| PE-09 | session-loop provider.rs:20/57-67（StreamResult） | `StreamResult = Result<Vec<...>>` 20 ✓、`stream(&self, request: &ProviderRequest)` 66 ✓ | ✓ |
| PE-09 | events.rs:56-58（克隆 2）/276-277（克隆 1） | event_type_name 克隆信封 56-57 ✓；`queue.push(&run.session_id, event.clone())` 277 ✓ | ✓ |
| PE-09 | engine.rs:242-247（RequestBuildContext 克隆） | 未逐行验证（区域合理） | 待实现期复核 |
| PE-09 | sessionRustDb.ts:511-532（commit 全量保存） | 未逐行验证（511 区域为 saveSessionBody 提交路径） | 待实现期复核 |
| PE-10 | Cargo.lock 188KB / reqwest 双版本 / tauri-plugin-mcp rev c7d271a | 任务书自述为执行前再核查（2026-08-01 0:10 生成），属事实声明非行号引用 | 执行时以 T10.1 步骤复核 |

**抽查小结**：任务书行号引用整体可信度高（约 7 成完全准确），漂移集中在 4 处（core_query_commands.rs:330-342、profileStore.ts:310-318、tauriTransport.ts:46-62、ChatStatusRibbons 864→913），另有 2 处"数量"性声明互斥（PE-06 vs PE-07 锁计数、PE-06 bridge 表内行号）。建议执行前对涉及漂移位置 grep 复核。

---

## 五、审计结论

### 5.1 必须修订的任务书（文档级冲突，不可仅靠调度规避）

| 任务书 | 修订项 |
|---|---|
| **PE-01** | ① T06 组（T06.1/6.2/6.3/6.4）与 PE-08 T08 组重复——改引用 PE-08 或删除，保留 T05 路径域；② T01.1 字段名 provider 与 PE-03 的 providerStatus 对齐（C4）；③ T03.2/T03.3/T03.4 命名与 PE-03/PE-07 终态对齐、sync 删除与 PE-07 apply 合并（C5/C6/C7）；④ 行号漂移修正（core_query_commands 330-342、profileStore 310-318、tauriTransport 46-62）；⑤ 宽限期 24h 改 5 分钟（C15） |
| **PE-02** | 契约正文补 `ProviderRequest<'a>` 生命周期、别名统一、明确契约 SoT 与 PE-09 的同步机制（C1） |
| **PE-03** | ① 命令总数"64"改公式化 + 新增命令登记机制（C13）；② core_get_status 字段集与 PE-01 统一命名（C4）；③ error_bridge 删除与 PE-04 的接线冲突——先声明时序（C9）；④ 与 PE-07 新命令（git/fs/workspace/apply）合并入契约清单 |
| **PE-04** | ① T04.3 组（错误类型升级）整体移交 PE-06，自身降为"消费 + 日志传播"（C10/C11）；② T04.1-4 error_bridge 按删除裁决修订（C9）；③ 脱敏与 PE-07 合并（C8） |
| **PE-06** | ① T06.6 锁中毒移交 PE-07（C12）；② 与 PE-04 的边界声明已正确但需同步修订 PE-04 实际内容（C10/C11）；③ bridge.rs 表内行号修正 |
| **PE-07** | ① 新增 7 命令登记进 PE-03 manifest/契约（C13）；② T07.6 清单行号 541 删除、锁计数按实测；③ T07.4 与 PE-01 的迁移/sync 方案合并（C6/C7）；④ 脱敏并入 PE-04 单实现（C8） |
| **PE-08** | ① 宽限期与 PE-01 统一（C15）；② 与 PE-09 的 save_session_body 写模型裁决（C14）；③ 声明为 sessionRustDb.ts/migrateFromLocalStorage.ts 唯一 owner |
| **PE-09** | ① 契约落点引用 PE-02 SoT 并回写契约文档（C1）；② save_session_body upsert 改造待 C14 裁决；③ 与 PE-08 的 T09.4 串行声明；④ 同文件区（streaming.rs/handlers/mod.rs）与 PE-06 的串行声明 |
| **PE-10** | 无契约级冲突；仅调度项（与 PE-04/PE-09 的 Cargo.toml 合并、transport/mod.rs 与 PE-09 串行、MCP rev 与 PE-07 同步） |

### 5.2 可在执行调度时规避的冲突（不需改文档，需排期）

1. 所有"同文件但改动不重叠"的项（见矩阵中标注"串行/合并"者）：main.rs 六方、session_commands.rs 三方、core_query_commands.rs 四方、sessionRustDb.ts 三方、loop/mod.rs 两方、conex-db lib.rs 两方——按依赖图串行即可。
2. PE-05 T05.7（命名清理）自声明排最后——与 PE-01 T04.3/PE-06 组 2 的重命名时序冲突已由其 owner 声明消化（C17）。
3. PE-09 内部约束已声明：T09.1 与 T09.3 阶段 2 不得并行（同文件区）；P1/P3 阶段 2 串行——跨书对应 streaming.rs/handlers/mod.rs 的 PE-06 冲突需补充进调度表。
4. PE-10 批次 A（清理）与任何业务任务无冲突，可任意并行；批次 B（Cargo 收敛）与 PE-04 的 tracing-appender、PE-09 的 criterion 需合并依赖声明。

### 5.3 最高风险点（建议优先裁决）

1. **C5/C6/C7（配置命令命名三方案 + sync 存废 + 迁移双实现）**：PE-01/PE-03/PE-07 三书必须先行对齐，否则任一先落地即造成另两书返工。
2. **C12（锁中毒双书全量重复）**：同文件同清单，两执行者同时开工必冲突——先定 owner（建议 PE-07）。
3. **C11（错误类型三重重复 + RecoveryHook 签名互斥）**：影响 conex-types/session-loop/orchestrator 三 crate，PE-04/PE-06 须先定边界再动工。
4. **C13（命令总数 vs 新增命令）**：PE-03 的契约冻结（T03.9）不能早于 PE-07/PE-08/PE-09 的命令面稳定。
5. **C14（写模型裁决）**：PE-08 与 PE-09 对 save_session_body 语义相左，涉及产品行为（删除历史消息），需产品/调度者裁决。

---

### 附录：抽查依据（本次审计实测命令）

- `rg -n "pub struct CoreStatus|compaction_ready|fn build_status" core_query_commands.rs` → 49/167-179
- `Get-Content lib.rs | Select -Skip 820` → 833-836 空 keepIds 全删确认
- `rg -n "emit_message_deltas|fn handle|consume" streaming.rs` → 定义 234
- `rg -n "lock\(\)\.expect\(|expect\(" idempotency.rs / bridge.rs / middleware.rs` → 10/25/2
- `Get-Content engine.rs | Select -Skip 290` → 293 read_stream、223 stream 签名
- `Get-Content profileStore.ts | Select -Skip 305`、`AppBootstrap.ts | Select -Skip 296` → 明文写入 ~302-306、sync 301-302、gateTimer 314-321
- `rg -n "upsert_session_entry" conex-db/src/lib.rs` → 354（&SessionIndexEntry）
- `Get-Content ChatStatusRibbons.tsx | Select -Skip 144/285` → 149-155 三条件、287-292 文案、310-311 action
- `rg -n "persistAllSessionsRust|keepIds" sessionRustDb.ts` → 780/818-822/844
- `Get-Content commandMap.ts | Select -First 32` → 幽灵 31-40
- `(Get-Content xxx).Count` → LoggerService 109、ChatStatusRibbons 913、telemetryStore 128、StreamRenderBuffer 314、AsyncMarkdownBlock 73
