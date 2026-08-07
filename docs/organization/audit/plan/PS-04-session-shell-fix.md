# PS-04 任务书：会话循环与壳 P1 组修复（L1/L2/W1-W3）

> 任务书编号：PS-04
> 定位：`docs/organization/audit/00-REMEDIATION-PLAN.md` §二「P1 —— 高优修复」的**会话循环组（P1-L1/L2）与壳/引擎组（P1-W1/W2/W3）**，共 5 项。
> 依据：F1-session-loop-audit.md（F1-01/F1-02）、F4-shell-audit.md（F1-01/F5-03 + 维度 1 错误协议 F1-02 项）、R1/R2 复核（对 L/W 组无直接覆盖，复核列为空；本组以 F1/F4 原始证据为准）。
> 模式：只读 + 写任务书文档；修复执行由实现子 Agent 按本任务书完成（红测试先行）。
> 状态：待执行。

---

## 1. 目标与边界

### 1.1 目标

修复 5 项 P1 缺陷，每项以「红测试断言 → 修复 → 绿测试」闭环交付：

| 编号 | 审计项                       | 缺陷一句话                                                            | 主修复文件                                                                   |
| ---- | ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T4.1 | P1-L1（F1-01）               | 无 recovery_hook 时错误被缺省 Skip 静默降级为正常收场                 | `crates/session-loop/src/loop/mod.rs`                                        |
| T4.2 | P1-L2（F1-02）               | 批级审批三个 `request_approval().await` 裸挂起，无超时、无 abort 竞速 | `crates/session-loop/src/tool_exec.rs`                                       |
| T4.3 | P1-W1（F4 F1-01）            | `config_profile_apply` 后 provider 不重载，换 key/模型仍用旧凭据      | `apps/agent-workbench/src-tauri/src/config/provider.rs` + `engine.rs`        |
| T4.4 | P1-W2（F4 F5-03）            | `core_rebuild_search_index(root)` 任意 root 绕开工作区沙箱            | `apps/agent-workbench/src-tauri/src/core_commands.rs`                        |
| T4.5 | P1-W3（F4 F1-02 错误协议项） | 5 个已注册命令返回 `String` 错误，非 CoreError 统一协议               | `git.rs` / `fs_commands/dialog.rs` / `fs_commands/skills.rs` / `commands.rs` |

### 1.2 边界（不做）

- 不修邻域登记项（仅在文档登记，不上修）：F9-02 同 call_id 二次审批、F4 F4-02 `config_profile_apply` 非原子落盘、F4 F7-05 `workbench_apply_update` stub 假成功（T4.5 只统一错误类型，不改 stub 语义）、F1-03/F2-01 u32 溢出、F9-05 死锁 detector 未接线。
- 不改前端 crish-desktop 代码（T4.3/T4.5 若发现前端对 `String` 错误的形态假设，只读确认后上报调度者登记，不在本组改）。
- 不改 `reference/markdown-editor/` 与 `tests/e2e` 下 5 个 markdown-editor 专项 spec（测试资产保护铁律，AGENTS.md）。
- 不引入新依赖；不修改公共 wire 契约形状（`approval-resolved`、`run-terminal` 等事件载荷不变）。

### 1.3 测试资产保护与提交纪律

- 新增/修改测试文件即时 `git add`，不留未跟踪状态（AGENTS.md 铁律）。
- 每任务独立提交，feat/fix + 范围，提交信息含 `PS-04` 编号；红测试提交先行（可在同任务内分两个 commit：红 → 绿，或红测试 commit 后修复 commit）。
- 中文提交信息按 chinese-encoding-guard 流程（git -c i18n.commitEncoding=utf-8 -F msg 文件）。

---

## 2. 任务分解

### T4.1 L1 恢复决策缺省修正（loop/mod.rs）

**目标**：缺省（无 recovery_hook 且未 abort）决策改为 **error 收场**，与模块头注释一致；`Skip`/`Retry` 仅允许 recovery_hook 显式裁决返回；注释与实现对齐。

**现状证据（已核读）**：

- `loop/mod.rs:713-723`：`recovery_decision` 在 `!is_aborted()` 且无 hook 时返回 `RecoveryDecision::Skip`（:722），与 :16-17 模块头注释「abort 类 → aborted，否则 error 收场」相反。
- `loop/mod.rs:770-778`：Skip 分支在 `S::Streaming` 态派发 `E::NoToolCalls` → turn-complete → **stop 正常收场，错误被吞**。
- catch 兜底唯一生产来源 = `dispatch` 转移失败（`handlers/mod.rs:444-453`，`RUNTIME_TRANSITION_FAILED`）+ Idle/Done 防御分支（`loop/mod.rs:704`）——路径罕见但一旦触发即静默降级，这是 F1 判定 P1 的原因。
- 合法转移序列（构造 Streaming 态用，证据 `conex-types/src/transition.rs:271-307`）：`Idle --Initialized--> AwaitingInput --InputReady--> PreparingTurn --TurnPrepared--> Streaming`。

**修复要求**：

1. `RecoveryDecision` 增加 `Fatal` 变体（或等价「缺省收场」语义）；`recovery_decision` 缺省分支（无 hook、未 abort）返回 `Fatal`。
2. `apply_recovery` 增加 `Fatal` 分支：不经状态分派，直接 `Some(EndDecision::error(&self.state, err.message()))`（恒 error 收场）。
3. `Retry`/`Skip` 分支保留（hook 显式返回时行为不变）；`:721-722` 注释改为与实现一致的缺省说明。
4. 端到端契约：streaming 态内部错误（非 abort）→ run 以 `AgentEndReason::Error` 收场、`outcome.error` 携带错误消息；**不再**派发 `NoToolCalls`。

**验收标准（红 → 绿）**：

| 测试                      | 断言                                                                                                                                                                                                                                | 修复前                   | 修复后           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------- |
| T4.1-R1（单元红）         | `recovery_decision(&LoopError::internal(...))` 在无 hook、abort 未置位时**不是** `Skip`                                                                                                                                             | 红（返回 Skip）          | 绿（返回 Fatal） |
| T4.1-R2（单元红）         | 同条件断言缺省为 `Fatal`（`matches!(decision, RecoveryDecision::Fatal)`）                                                                                                                                                           | 红                       | 绿               |
| T4.1-R3（单元，契约锁定） | Streaming 态 + `Skip`（hook 显式）→ `apply_recovery` 返回 None（继续循环，Skip 语义不回归）；Streaming 态 + `Fatal` → 返回 `Some(EndDecision)` 且 `reason == Error`                                                                 | 绿（现状 Skip 行为锁定） | 绿               |
| T4.1-R4（端到端语义红）   | 构造 Streaming 态 machine（按 transition.rs 合法序列推进）+ 模拟 catch 路径（handler 抛 `LoopError::internal` → `recovery_decision` + `apply_recovery`）→ 收场为 error；修复前走 Skip → 继续循环 → turn-complete 以 stop 收场（红） | 红                       | 绿               |
| 回归                      | `cargo test -p session-loop` 全绿（含 tests/run_loop.rs 29 个用例，F10 基线）                                                                                                                                                       | —                        | —                |

实现提示：R1/R2/R3 放 `loop/mod.rs` 的 `#[cfg(test)] mod tests`（同文件可访问私有方法）；R4 的「模拟 catch 路径」在单元层直接调用 `recovery_decision`+`apply_recovery` 组合即可（run() 的 catch 逻辑即此两调用的顺序，见 `loop/mod.rs:655-661`），不必真实驱动 `run()`——若实现者能找到真实 `run()` 级触发路径（如经 state.rs cfg(test) 注入面），优先用真实路径并在报告中说明。

**输入**：F1-session-loop-audit.md F1-01；`crates/session-loop/src/loop/mod.rs`。
**产出**：`loop/mod.rs` 修改 + `loop/mod.rs` tests 内新增 3-4 个测试。
**依赖**：无（可与 T4.2 并行，但同 crate 编译串行更省时）。

---

### T4.2 L2 审批挂起加超时/abort 竞速（tool_exec.rs）

**目标**：批级审批三个 await 点统一加「abort 竞速 + 审批超时」，run 不再悬挂；对齐工具内 ask 通道既有模式（`approval.rs:131-160`）。

**现状证据（已核读）**：

- 三个裸挂点：`tool_exec.rs:357-359`（并行组审批循环）、`:598-600`（顺序路径）、`:1140-1142`（requires_approval 重试）。
- 参考模式：`approval.rs:93-100` `wait_aborted()`（50ms 轮询批级 AbortSignal + abort_token）+ `:131-160` `tokio::select!{ biased; () = cancelled => Err(取消), decision = wait => 裁决（含竞速兜底 is_aborted 复查 :139-141）}`。
- 批级三个点位均有 `abort: Option<&AbortSignal>` 在参数面（并行组 :349-353 已用它做前置检查；顺序路径 :554 同）。
- `ApprovalGate` trait：`tool_events.rs:89-103`；`ApprovalDecision` 三值（Approved/Denied/Expired）：`tool_events.rs:61-68`。
- 现有测试基座：`tool_exec.rs` cfg(test) 内 `BlockingApproval`（:2041-2058）、`MockApproval`（:1999-2017）、`SequenceApproval`（:2083-2109）；`requires_approval_approved_then_retries_execution`（:2497）。

**修复要求**：

1. 新增辅助函数（如 `async fn approval_wait(gate: &dyn ApprovalGate, call_id, tool_name, input, requester, abort: Option<&AbortSignal>, timeout: Option<Duration>) -> ApprovalWaitOutcome`）：`tokio::select!{ biased; () = wait_aborted(abort) => Cancelled, decision = tokio::time::timeout(t, gate.request_approval(...)) => 超时 → Expired（并带 abort 竞速复查）}`。
2. 超时常量可配置：`ToolBatchOptions` 增加 `approval_timeout: Option<Duration>`（None = 缺省 120s，与编排层 approval_router.rs:24-33 的超时兜底对齐）；`with_options` 透传或由装配层设置。
3. 三个 await 点统一替换：abort 竞速命中 → **不伪造审批事件**，按取消收场（对齐 `approval.rs:135` 语义：`ToolErrorKind::Cancelled` / 批执行按取消跳过，复用现有取消路径，如 :379-406 的「无决策（abort 中断）→ 按取消收场」）；超时 → `ApprovalDecision::Expired` 既有分支（顺序路径 :615-620、并行组 :415-419、重试路径 :1159-1165 已存在 Expired 处理，直接复用）。
4. 保留 T-D-14 请求方身份透传（requester 参数不变）。

**验收标准（红 → 绿）**：

| 测试                                      | 场景                                                          | 断言                                                                                                                                        | 修复前                        | 修复后 |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ |
| T4.2-R1（红，顺序路径）                   | 审批门挂起不返回 + 测试注入短超时（如 50ms）                  | 批执行在超时内收敛，产出 Expired 结果（`ToolErrorKind::ApprovalExpired`），测试外层 tokio timeout 不触发                                    | 红（裸挂，外层 timeout 失败） | 绿     |
| T4.2-R2（红，并行组）                     | 同 R1 走并行组审批循环（group 内 ≥2 项需审批）                | 超时收敛、全组无悬挂、事件顺序契约保持（approval-requested 全组先发）                                                                       | 红                            | 绿     |
| T4.2-R3（红，abort 竞速）                 | 审批门挂起不返回 + abort 置位                                 | **立即**收敛为取消（不等待 gate），结果 Cancelled/取消收场；耗时 < gate 不响应窗口                                                          | 红（abort 无法打断）          | 绿     |
| T4.2-R4（红，requires_approval 重试路径） | :1140 点位：工具返回 ApprovalRequired → 审批挂起 + abort/超时 | 同 R1/R3 语义                                                                                                                               | 红                            | 绿     |
| T4.2-R5（契约锁定）                       | 审批正常返回（Approved/Denied/Expired）且无超时               | 现有审批测试全部保持绿（approval_approved_executes / approval_denied_is_not_fatal / approval_expired_not_fatal 等，tool_exec.rs:2237-2282） | 绿                            | 绿     |
| 回归                                      | `cargo test -p session-loop` 全绿                             | —                                                                                                                                           | —                             | —      |

实现提示：`BlockingApproval`（:2041）若为「固定 sleep 后返回」需新增 `PendingApproval`（挂起直到测试显式释放或无限挂起），供 R1-R4 使用；R3 需断言「abort 后返回耗时显著小于 gate 不响应时长」（如 < 200ms），用 `std::time::Instant` 记录。

**输入**：F1-session-loop-audit.md F1-02；`crates/session-loop/src/tool_exec.rs`、`tool_events.rs`、`approval.rs`。
**产出**：`tool_exec.rs` 修改（+`tool_events.rs` 若 ToolBatchOptions 字段变更）+ 新增测试 4-5 个。
**依赖**：无。

---

### T4.3 W1 config_profile_apply 后 provider 重载（config/provider.rs + engine.rs）

**目标**：`config_profile_apply` 成功后重建 provider 适配层并原子交换，下一次 run 用新凭据（key/baseUrl/model 热更新）；注释「进程内直写引擎」兑现。

**现状证据（已核读）**：

- `config/provider.rs:479-533`：`config_profile_apply` 只写 `ApiConfigStore`（:499-508 步骤 2），不碰 `EngineHandle`。
- `engine.rs:927-945`：provider 仅在构造时 `load_provider_endpoint()`（:181-200 从 `effective_*` 读三件套）建立一次；`HttpProviderCall` 持有构造时 `EngineProviderConfig` 快照（:282-291）。
- 原子交换面已存在：`EngineHandle.provider` 是 `Mutex<Option<Arc<dyn ProviderCall>>>`（:708-710）；`inject_provider_for_test`（:971-981）演示了短临界区替换 + provider_config + ready/ready_reason 同步。
- 取用点：`core_run_commands.rs:997-1002` 附近 `state.engine.provider()`；`EngineHandle` 实例由 `CoreRunState.engine` 持有（core_run_commands.rs:1209），`CoreRunState` 经 `app.manage(Arc::new(CoreRunState::new(...)))` 托管（core_run_commands.rs:25、:4227）。

**修复要求**：

1. `engine.rs` 新增 `pub(crate) fn reload_provider(&self)`：`load_provider_endpoint()` → 重建 `HttpProviderCall` → Mutex 短临界区原子交换 `provider` + 同步 `provider_config` + `ready`/`ready_reason`（无 await，模式对齐 `inject_provider_for_test`）；重建失败（三件套缺失）→ `provider=None` + ready=false + ready_reason 文案。
2. `config_profile_apply` 步骤 2 写 store 成功后调用重载：需访问 EngineHandle——给 `config_profile_apply` 增加 `state: tauri::State<'_, Arc<CoreRunState>>` 参数（CoreRunState 提供 `reload_provider` 转发或直接暴露 engine 访问器；main.rs:133 注册点同步）；`config_update`（config/mod.rs）若也写 baseUrl/model/apiKey，同轮接线（F4 F1-01 修复建议覆盖两个入口）。
3. 更新 `config_profile_apply` 头注（:472-477「再进程内直写引擎 ApiConfigStore」→ 补「并重载 EngineHandle provider」）。
4. 密钥清除（api_key=空串）语义：apply 后 `load_provider_endpoint` 返回 None → 引擎降级未就绪（ready=false），与构造时行为一致（现状语义保持）。

**验收标准（红 → 绿）**：

| 测试                            | 场景                                                                                                                                                                                                                         | 断言                   | 修复前     | 修复后 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------- | ------ |
| T4.3-R1（红，engine 层）        | 注入旧配置 A（model=a/keyA）→ `reload_provider()` → 断言 `provider_config()` 的 model/key/baseUrl 变为新值                                                                                                                   | provider_config 仍旧值 | 红         | 绿     |
| T4.3-R2（红，**真实请求载荷**） | `RecordingProvider`（真实实现 `ProviderCall::stream`，记录每次请求的 model/base_url 到共享 Vec）+ 注入 → 模拟 apply（写 store + reload）→ 调用 `provider().unwrap().stream(&request)` → 断言**新请求载荷**用新 model/baseUrl | 载荷仍旧值             | 红         | 绿     |
| T4.3-R3（红，命令级）           | `config_profile_apply(...)`（mock tauri 环境 + manage CoreRunState）成功返回后，`engine.provider_config()` 与新 store 值一致；`hasApiKey`/`model`/`baseUrl` 返回字段与 store 一致（现状返回形状不变）                        | provider_config 仍旧值 | 红         | 绿     |
| T4.3-R4（契约）                 | 三件套清空（api_key=空串）apply 后 ready()=false 且 provider()=None；重填后恢复                                                                                                                                              | —                      | 绿（新增） | 绿     |
| 回归                            | 壳测试：`cargo test -p crish-agent-workbench`（或该 crate 现有测试命令）+ 既有 engine.rs cfg(test)（:2077 起）全绿                                                                                                           | —                      | —          | —      |

**防作弊约束**：R2 禁止「把 provider 重载 mock 成恒通过」——RecordingProvider 必须真实实现 `ProviderCall::stream` 并让请求载荷可断言（model/base_url 取自 `ProviderRequest`/适配层选项），重载生效必须由「新实例的请求载荷」证明。

**输入**：F4-shell-audit.md F1-01（+F8-03 测试盲区建议）；`config/provider.rs`、`engine.rs`、`core_run_commands.rs`。
**产出**：`engine.rs` reload_provider + `config/provider.rs` 接线 + 测试 3-4 个。
**依赖**：无（需先确认 EngineHandle 访问渠道——CoreRunState 结构，见现状证据第 4 条）。

---

### T4.4 W2 core_rebuild_search_index 沙箱化（core_commands.rs）

**目标**：`root` 经 WorkspaceRegistry 校验（canonicalize 后必须 ∈ 已授权根子树），越界拒绝；不再可对任意目录建索引。

**现状证据（已核读）**：

- `core_commands.rs:162-187`：仅 trim/空/长度校验（SEARCH_ROOT_MAX_LEN），root 任意 → `build_directory_index(&root)` 全盘遍历（信息泄漏 + spawn_blocking 长时间占线程）。
- 参考模式：`git.rs:247-274` `resolve_git_cwd`（canonicalize + is_dir + `registry(app).roots()` + `is_same_or_child`）；`workspace.rs:350-360` `registry(app)`、`:363-368` `resolve_guard`；`WorkspaceRegistry::init_with_config_dir`（:81）是测试注入点。
- 现有测试基座：`core_commands.rs:590-607`（mock_builder + manage(SharedSearchState)）。

**修复要求**：

1. `core_rebuild_search_index` 增加 `app: tauri::AppHandle` 参数（main.rs:141 注册点同步）。
2. root 校验（二选一，推荐 A）：
   - A. 复用 git.rs 模式：canonicalize + is_dir + `workspace::registry(app)?.roots()` 前缀包含（`is_same_or_child`）；校验失败 → `CoreError::InvalidInput`（detail 含 workspace_not_granted 文案，对齐 fs_commands 错误文案惯例）。
   - B. 走 `workspace::resolve_guard(app, &root)`（fs_commands/types.rs:95、:136）后取其 canonical 路径。
3. 校验通过后用 canonical 路径调 `build_directory_index`；其余行为不变（原子交换 Arc、file_count 返回形状）。
4. 明确语义：**仅允许活动工作区根或其子树**（与 `list_directory` 沙箱一致，F4 F5-03 修复建议）。

**验收标准（红 → 绿）**：

| 测试                    | 场景                                                                                                                                                                   | 断言                                                                   | 修复前               | 修复后 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------- | ------ |
| T4.4-R1（红，越界拒绝） | mock app：manage(SharedSearchState) + manage(WorkspaceRegistry::init_with_config_dir(临时目录))；root = 授权根之外的真实路径（如系统 TEMP 外部目录或 `C:\Windows` 类） | `Err(CoreError::InvalidInput)`（detail 含 workspace 文案），索引不重建 | 红（返回 Ok 建索引） | 绿     |
| T4.4-R2（放行）         | root = 授权根（临时目录）或其子目录（目录内放 1-2 个文件）                                                                                                             | `Ok` + `file_count` ≥ 1                                                | 绿                   | 绿     |
| T4.4-R3（回归）         | 空串/超长 root                                                                                                                                                         | `InvalidInput`（现有 :167-176 校验保持）                               | 绿                   | 绿     |
| 回归                    | `core_commands.rs` cfg(test) 全绿 + 壳 crate 测试                                                                                                                      | —                                                                      | —                    | —      |

实现提示：R1 用 `tauri::test::mock_builder().manage(...).build(tauri::test::mock_context(tauri::test::noop_assets()))`（core_commands.rs:594-597 既有模式）；注意 `registry()` 用 `try_state`，mock app 必须 manage WorkspaceRegistry，否则走「未托管」错误分支——该分支也应是 InvalidInput/Internal 明确错误，可作 R1 补充断言。

**输入**：F4-shell-audit.md F5-03；`core_commands.rs`、`workspace.rs`、`git.rs`（模式参考）。
**产出**：`core_commands.rs` 修改 + 测试 2-3 个。
**依赖**：无。

---

### T4.5 W3 5 个非 CoreError 命令收敛

**目标**：5 个已注册命令统一返回 `CoreError`（`{kind, detail}` 协议），前端可按 `error.kind` 分类。

**现状证据（已核读）**：

| #   | 命令                        | 位置                            | 现状返回                             | 错误来源                                             |
| --- | --------------------------- | ------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| 1   | `workbench_git_run`         | `git.rs:175-180`                | `Result<GitRunResult, String>`       | resolve_git_cwd / validate_git_args / spawn / 超时等 |
| 2   | `select_folder`             | `fs_commands/dialog.rs:10`      | `Result<SelectFolderResult, String>` | 路径解析 / registry（取消保持 `Ok(None)`）           |
| 3   | `workbench_discover_skills` | `fs_commands/skills.rs:242-246` | `Result<Vec<RustSkill>, String>`     | registry / canonicalize_within_roots                 |
| 4   | `workbench_http_request`    | `commands.rs:13-18`             | `Result<Value, String>`              | method/url 校验、网络                                |
| 5   | `workbench_apply_update`    | `commands.rs:7-9`               | `Result<Value, String>`              | stub 无错误面（Ok 恒成功）                           |

协议定义：`core_error.rs:26` 重导出 `conex_types::CoreError`（serde `{kind, detail}`，kind ∈ InvalidInput/Encoding/Io/NotFound/Cancelled/Internal，映射表 core_error.rs:13-20）；`FileCommandError`（workspace 族）经 `format!("{}: {}", e.code, e.message)` 现用文案可映射。

**修复要求**：

1. 5 个命令签名改 `Result<_, CoreError>`（统一从 `crate::core_error::CoreError` import，遵守 core_error.rs:6 的「唯一 import 点」约定）。
2. 映射规则：
   - 参数校验类（空参、非法 method/url、NUL、越界）→ `InvalidInput`；
   - 路径/注册表类（workspace_not_granted、路径不可解析、not a directory）→ `InvalidInput`（detail 保留现文案）；
   - IO/spawn/网络类 → `Io`（detail 保留操作名 + 底层消息）或 `Internal`（无 IO 语义时）；
   - `workbench_apply_update` stub：返回类型统一为 `Result<Value, CoreError>`，Ok 形状 `{ok:true}` 保持不变（stub 语义属 P2 F7-05，本轮不动）。
3. `select_folder` 取消语义保持：用户取消 → `Ok(SelectFolderResult { path: None })`（F4 F1-02 明确）。
4. 前端兼容只读确认：检查 crish-desktop 对这 5 个命令 invoke 的错误处理是否存在「String 错误」形态假设（如 `err?.message` vs `err.kind`）；只读确认，不改前端；发现假设上报调度者（若前端已按三态结构化错误处理则可直接收口，F5-frontend-core-audit 显示前端 invoke 面已统一结构化错误）。

**验收标准（红 → 绿）**：

| 测试                | 场景                                                                                           | 断言                                                                                                                    | 修复前            | 修复后 |
| ------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ |
| T4.5-R1（红）       | `workbench_git_run`：空 cwd / 越界 cwd                                                         | 返回 `CoreError` 且 serde 形状 `{kind: "InvalidInput", detail: ...}`（协议断言对齐 core_error.rs:109-114 既有测试风格） | 红（返回 String） | 绿     |
| T4.5-R2（红）       | `select_folder`：registry 未托管（mock app 不 manage）                                         | `CoreError`（Internal）且形状正确                                                                                       | 红                | 绿     |
| T4.5-R3（红）       | `workbench_discover_skills`：workspace_path 越界                                               | `CoreError::InvalidInput`                                                                                               | 红                | 绿     |
| T4.5-R4（红）       | `workbench_http_request`：非法 method / 非 http(s) url                                         | `CoreError::InvalidInput`                                                                                               | 红                | 绿     |
| T4.5-R5（红）       | `workbench_apply_update`：返回类型 serde 形状                                                  | 成功路径形状不变（`{ok:true}`），函数签名返回 `Result<Value, CoreError>`（编译期断言）                                  | 红（签名 String） | 绿     |
| T4.5-R6（契约锁定） | 5 命令成功路径                                                                                 | Ok 形状与修复前逐字段一致（git 结果 / select_folder 取消 Ok(None) / skills 列表 / http 响应 / update ok）               | 绿                | 绿     |
| 回归                | 壳 crate 测试全绿（含 git.rs:517-614 白名单测试、fs_commands/mod.rs 测试、双端 manifest 测试） | —                                                                                                                       | —                 | —      |

实现提示：测试放各命令所在模块 cfg(test)（git.rs 已有测试区 :500+；fs_commands/mod.rs；commands.rs 需新建）；serde 形状断言用 `serde_json::to_value(&err)` 检查 `["kind"]`/`["detail"]`（core_error.rs:109-114 模式）。

**输入**：F4-shell-audit.md F1-02；`git.rs`、`fs_commands/dialog.rs`、`fs_commands/skills.rs`、`commands.rs`、`core_error.rs`。
**产出**：4 个文件签名与映射修改 + 测试 5-6 个。
**依赖**：无。

---

## 3. 防作弊条款

1. **红测试先行**：每个任务先写断言测试并**实跑确认失败**，留存失败输出（断言信息/测试名）；修复后同一测试转绿。提交时红/绿输出一并写入 commit message 或报告。
2. **禁止 mock 被验证行为**：
   - T4.3：`RecordingProvider` 必须真实实现 `ProviderCall::stream` 并让请求载荷可断言；**禁止**把「重载」实现为测试注入的恒通过桩。provider 重载的证明 = 新请求载荷携带新 model/baseUrl。
   - T4.2：`PendingApproval` 只模拟「审批不响应」；超时/abort 收敛必须由内核 `tokio::select!`/timeout 真实完成，禁止在 mock gate 内自行返回 Expired。
   - T4.1：缺省决策必须由 `recovery_decision` 真实返回 `Fatal` 证明，禁止在测试中直接构造 Fatal 绕过被验证路径。
3. **报告实跑输出**：每任务报告真实命令输出片段（红：`assertion failed`/`FAILED` 行；绿：`test result: ok` 行），不得摘抄编造；Tauri 壳测试命令若不可在 CI 外运行（需窗口/DPAPI），以 `cargo test -p crish-agent-workbench` 实际可跑子集为准并说明环境限制。
4. **不扩大修复面**：严格按 §1.2 边界；发现的新问题写入报告「邻域登记」小节，不上修。
5. **门禁**：每任务收口前跑 `cargo test -p session-loop`（T4.1/T4.2）或 `cargo test -p crish-agent-workbench`（T4.3-T4.5）对应 crate 全绿；组收口时跑 `cargo test --workspace`（73 套件基线，AGENTS.md）。

---

## 4. 执行顺序

| 序  | 任务 | 说明                                                                           |
| --- | ---- | ------------------------------------------------------------------------------ |
| 1   | T4.1 | session-loop 优先（F1 结论：F1-01 是行为面最值得先修项）                       |
| 2   | T4.2 | 与 T4.1 同 crate（共享编译），串行紧接                                         |
| 3   | T4.5 | 壳侧独立文件，可并行                                                           |
| 4   | T4.4 | 壳侧独立文件，可并行                                                           |
| 5   | T4.3 | 涉及 EngineHandle 访问渠道确认（CoreRunState 接线），放最后；与 T4.4/T4.5 并行 |

并行建议：T4.3/T4.4/T4.5 三任务文件互不重叠（config/provider.rs+engine.rs / core_commands.rs / git.rs+dialog.rs+skills.rs+commands.rs），可并行派发；T4.1/T4.2 同 crate 串行。

组收口验证链：

1. `cargo test -p session-loop`（T4.1/T4.2 全绿）；
2. `cargo test -p crish-agent-workbench`（T4.3/T4.4/T4.5 全绿）；
3. `cargo test --workspace`（73 套件基线无回归）；
4. 前端只读确认结论（T4.3/T4.5 的前端消费面）写入收口报告。
