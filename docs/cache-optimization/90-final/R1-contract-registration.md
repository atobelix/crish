# R1 契约登记：ProviderRequest / SessionLoopOptions 透传字段（T-05 发起，C5）

- 登记 Agent：A5（T-05，R1 轮第二波）
- 日期：2026-08-03
- 登记性质：**接口契约扩展登记**（C5 发起，合并一次登记）

## 一、登记原则

- **流程对齐**：本登记走 AU-04 冻结变更流程（AU-04 F1 注记："任何后续变更须走
  PE-03 T03.9 的 manifest + changelog 登记机制"；PE-02 §3.1 尾注："本文件 §3.1
  与代码一致，后续变更须走 AU-04 冻结变更流程"）。`ProviderRequest` 冻结于
  PE-02 §3.1 v1 契约（AU-04 F1，SoT = `docs/rust-rewrite/plans/PE-02-streaming-markdown-plan.md`
  §3.1.1），本次新增字段属**全 Option 契约扩展**，既有调用方构造不破坏
  （`Option` 缺省即 None 语义）。
- **合并一次登记（C5）**：P1 步骤 2.2（`system_prompt`）与 P2 步骤 4
  （`session_id`）对同一 `ProviderRequest` struct 的扩展**合并走本登记**，
  避免两次变更互相覆盖；P1 先行（本轮 R1），P2 的 `session_id` 扩展届时由
  T-16 补记（见第三节占位说明）。
- **登记落点**：轮级登记文件 `docs/cache-optimization/90-final/R1-contract-registration.md`
  （本文件）；`docs/rust-rewrite/contracts/` 的契约测试覆盖矩阵为既有契约
  基线的正式落点，合并时主 Agent 评估是否需要同步补记（A3 P2-7 口径）。
- **SoT 同步**：PE-02 §3.1.1 契约正文的载荷形态注释（`ProviderRequest<'a> {
messages: ..., tools: ..., max_tokens: ... }`）需在合并登记时同步更新为含
  `system_prompt` 的最终形态（归 T-16 补记或主 Agent 合并时执行，本登记不
  修改 PE-02 文档）。

## 二、本次登记表（R1，T-05）

| 变更项                                  | 文件:行号                                                      | 类型/签名                                                                                                                    | 涉及任务单元                                          | 轮次 | 状态       |
| --------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---- | ---------- |
| `ProviderRequest.system_prompt`         | `crates/session-loop/src/provider.rs:86`                       | `Option<&'a str>`（新增 pub 字段，全 Option 扩展）                                                                           | T-05（发起）、T-16（session_id 补记合并）             | R1   | **已登记** |
| `ProviderRequest.session_id`            | `crates/session-loop/src/provider.rs:94`                       | `Option<String>`（新增 pub 字段，全 Option 扩展；P2 步骤 4a，prompt_cache_key 键来源，C4 键推导真源输入）                    | T-16（补记，C5 合并一次登记）                         | R2   | **已登记** |
| `SessionLoopOptions.system_prompt`      | `crates/session-loop/src/loop/mod.rs:170`                      | `Option<String>`（新增 pub 字段，`Default` 补 `None`，mod.rs:188）                                                           | T-05（发起）、T-33（R4 扩展同 struct）                | R1   | **已登记** |
| `core_run_task.system_prompt`           | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:931`  | `Option<String>`（Tauri 命令签名加参，前端 `startRunTask.systemPrompt` 按名反序列化；入站 `build_system_prompt` 规范化一次） | T-07（追加登记，A3 P2-8 合并）、T-29（R4 同签名串行） | R1   | **已登记** |
| `SessionLoopOptions 装配 system_prompt` | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1026` | `system_prompt: build_system_prompt(system_prompt)`（trim + 空值 → None，全链透传原始）                                      | T-07（追加登记）                                      | R1   | **已登记** |

> 行号以 R1 落地后实读为准（2026-08-03 快照）；跨轮后续扩展（T-33 对
> `SessionLoopOptions` 追加预算/压缩字段）不属本契约面，按既有串行纪律执行。
>
> 配套测试：`default_options_match_documented_defaults`（loop/mod.rs 测试模块）
> 已补 `system_prompt` 默认 None 断言（mod.rs:582-585）。
>
> **T-16 补记（R2，2026-08-03，A7）**：`ProviderRequest.session_id` 已落地
> （provider.rs:94，全 Option 扩展，与 `system_prompt` 同 struct 合并一次登记，C5）。
> 配套实现：stream.rs 的 `ConsumeBuilder.usage_accounting`（默认 Included，
> anthropic/gemini 由适配层显式传 Excluded，T-17 接线）与
> metadata `cacheBreakdown` 派生块（C9 口径，camelCase）；会话内既有构造点已补
> `session_id: None`（streaming.rs build_request / tests / benches，默认兼容，
> 不破坏既有调用）。PE-02 §3.1.1 契约正文的载荷注释建议同步更新为含
> `system_prompt`/`session_id` 的最终形态（PE-02 文档本登记不修改，归主 Agent
> 合并时执行）。

## 三、预留后续行占位说明（本轮不登记，届时补记）

| 变更项                       | 类型/签名                                                 | 涉及任务单元 | 轮次 | 补记方式                                                  |
| ---------------------------- | --------------------------------------------------------- | ------------ | ---- | --------------------------------------------------------- |
| `ProviderRequest.session_id` | `Option<String>` 或等价形态（P2 步骤 4a，会话亲和键输入） | T-16（R2）   | R2   | T-16 补记本文件第二节表格（同一 struct 合并一次登记，C5） |

> 注：`core_run_task.system_prompt` 占位行已于 2026-08-03 由主 Agent 合并转正（见第二节）。
> 占位行仅声明归属与补记时机，不构成已登记状态；T-16 补记时需连同
> PE-02 §3.1.1 契约正文的载荷注释一并更新。
>
> 注（T-16 转正，2026-08-03）：`ProviderRequest.session_id` 占位行已由 T-16 补记
> 转正（见第二节）；占位行保留作历史占位说明，PE-02 载荷注释同步建议见第二节注。
