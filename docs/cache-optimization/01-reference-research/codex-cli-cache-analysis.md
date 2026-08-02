# OpenAI Codex CLI 缓存优化机制调研（参考实现核实版）

- 调研对象：`reference/codex-cli`（Rust 项目，Bazel 构建，代码位于 `codex-rs/`）
- 基准提交：`9c5c075a`（docs: R6 report）
- 文档性质：对已有调研结论的逐条核实与整理；所有行号均以实际源码为准，结论与原始调研不一致处已明确标注「修正」
- 适用范围：作为 crish 会话缓存优化（`docs/cache-optimization/`）的参考依据

---

## 1. 总体架构

### 1.1 版本前提（结论 1：核实通过）

该 reference 版本为 2026 年内部版，特征如下：

- **无 async-openai / anthropic 依赖**：`codex-rs/Cargo.toml`、`codex-rs/core/Cargo.toml` 均无这两个依赖（全文检索无匹配），模型层只使用 OpenAI Responses API 协议族。
- **全请求统一走 Responses API，HTTP + WebSocket 双传输**：
  - 请求构造统一入口 `build_responses_request`（`core/src/client.rs:743-799`），产出 `ResponsesApiRequest`（含 `prompt_cache_key`、`parallel_tool_calls`、`reasoning` 等字段）。
  - WebSocket 传输由 provider 能力开关控制：`responses_websocket_enabled`（`core/src/client.rs:804-812`），HTTP 兜底 `force_http_fallback`（`core/src/client.rs:428-447`，含 `codex.transport.fallback_to_http` 计数遥测）。
  - WebSocket 会话按 turn 复用：`new_session` 取回缓存的 `WebsocketSession`（`core/src/client.rs:381-387`），窗口换代时 `set_window_generation`/`advance_window_generation` 重置（`core/src/client.rs:393-403`）。

### 1.2 缓存机制的总体闭环

```
固定前缀（instructions + 工具 schema + 上下文 diff 注入，保持字节级稳定）
  └─→ prompt_cache_key（thread_id 或 override）
        └─→ 每次请求携带（HTTP / WebSocket 增量）
              └─→ 服务端 prefix cache 命中
                    └─→ cached_input_tokens → OTel gen_ai.usage.cache_read.input_tokens
```

三根支柱：**前缀稳定**（上下文 diff 注入、工具/指令确定性）、**键稳定**（prompt_cache_key 绑定 thread）、**量可控**（压缩与窗口度量）。

---

## 2. 缓存适配清单（含文件:行号）

| # | 机制 | 位置 | 核实状态 |
|---|------|------|---------|
| 1 | prompt_cache_key 默认 = thread_id，可 override | `core/src/client.rs:371-375` | ✅ 通过 |
| 2 | 每次请求携带 prompt_cache_key | `core/src/client.rs:777`（`build_responses_request` 内） | ✅ 通过 |
| 3 | guardian 审查子代理用 `guard:{parent_thread_id}` | `core/src/guardian/review_session.rs:188-200` | ✅ 通过 |
| 4 | 压缩请求复用同一缓存键 | `core/src/client.rs:496-508`（`compact_conversation_history` 内 `ApiCompactionInput.prompt_cache_key`） | ✅ 通过 |
| 5 | 缓存命中度量 cached_input_tokens → OTel | `otel/src/events/session_telemetry.rs:422-425` | ✅ 通过 |
| 6 | 本地压缩 compact.rs | `core/src/compact.rs`（详见 §3.1） | ✅ 通过 |
| 7 | 远端压缩 compact_remote.rs | `core/src/compact_remote.rs`（详见 §3.2） | ✅ 通过 |
| 8 | 远端压缩 v2 compact_remote_v2.rs | `core/src/compact_remote_v2.rs`（详见 §3.3） | ✅ 通过 |
| 9 | 压缩触发 auto_compact_token_status | `core/src/session/turn.rs:732-782` | ✅ 通过 |
| 10 | 模型降级预压缩 | `core/src/session/turn.rs:810-859` | ✅ 通过 |
| 11 | 上下文 diff 注入（缓存保持核心） | `core/src/session/mod.rs:2996-3026` + `core/src/context_manager/updates.rs:209-243` | ✅ 通过 |
| 12 | 工具 schema 稳定性 | `tools/src/tool_spec.rs:78-89` + `core/src/tools/spec_plan.rs:161-228` | ✅ 通过 |
| 13 | instructions 确定性 | `core/src/session/mod.rs:552-568` + `protocol/src/openai_models.rs:449-468` | ✅ 通过 |
| 14 | WebSocket 增量请求 | `core/src/client.rs:1010-1047`（`get_incremental_items`）、`1059-1089`（`prepare_websocket_request`） | ✅ 通过（行号有漂移，见 §7） |
| 15 | 模型列表本地缓存 | `models-manager/src/manager.rs`、`models-manager/src/cache.rs` | ✅ 通过 |
| 16 | AGENTS.md 硬规则 | `reference/codex-cli/AGENTS.md`（Code Review Rules 一节） | ✅ 通过 |
| 17 | GPT-5.x 特殊处理 | `core/src/client.rs:719-741, 785`；`state/auto_compact_window.rs` | ✅ 通过（部分修正，见 §8） |

### 2.1 prompt_cache_key 与 guardian 键（结论 2：核实通过）

- 定义：`prompt_cache_key()` 优先取 `prompt_cache_key_override`，否则用 `state.thread_id`（`core/src/client.rs:371-375`）；override 通过 `with_prompt_cache_key_override` 注入（`core/src/client.rs:363-369`）。
- 每次流式请求都带键：`build_responses_request` 中 `let prompt_cache_key = Some(self.prompt_cache_key())`（`core/src/client.rs:777`），落入 `ResponsesApiRequest.prompt_cache_key`（`core/src/client.rs:791`）。
- guardian 审查子代理：`prompt_cache_key_override_for_review_session` 仅对 `GUARDIAN_REVIEWER_NAME` 子代理生效，返回 `Some(format!("guardian:{parent_thread_id}"))`（`core/src/guardian/review_session.rs:188-200`）；接线点在 `core/src/session/session.rs:1045-1046`。
- guardian 后续审查复用键：集成测试 `guardian_reuses_prompt_cache_key_and_appends_prior_reviews` 断言两次请求 `prompt_cache_key` 相等（`core/src/guardian/tests.rs:1579, 1787-1788, 1858`）。
- 压缩复用键：`compact_conversation_history` 将 `ResponsesApiRequest` 拆包后把 `prompt_cache_key` 透传给 `/responses/compact` 请求体（`core/src/client.rs:488-510`，端点为 `RESPONSES_COMPACT_ENDPOINT`，`core/src/client.rs:148`）。
- 集成测试佐证：`core/tests/suite/compact_remote.rs:720-735` 断言压缩请求与普通 `/responses` 请求的 `prompt_cache_key` 一致；测试用例 `remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key`（`core/tests/suite/compact_remote.rs:753-768`）与 `remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key`（`core/tests/suite/compact_remote.rs:771-780`）。

### 2.2 缓存命中度量（结论 3：核实通过）

- `ResponseEvent::Completed` 时把 `token_usage.cached_input()` 记为 OTel span 属性 `gen_ai.usage.cache_read.input_tokens`（`otel/src/events/session_telemetry.rs:422-425`）。
- 同处还记录 `gen_ai.usage.input_tokens`（421）、`gen_ai.usage.output_tokens`（427）、`codex.usage.reasoning_output_tokens`（429）、`codex.usage.total_tokens`（432）。

---

## 3. 压缩机制详解（结论 4：核实通过）

三套压缩实现并存，按 provider 能力选择：`should_use_remote_compact_task`（`core/src/compact.rs:66-68`）。

### 3.1 compact.rs —— 本地 summarize（模型现场压缩）

- **入口**：`run_inline_auto_compact_task`（`core/src/compact.rs:70-95`，自动触发）/ `run_compact_task`（`core/src/compact.rs:97-121`，手动）。
- **过程**：把压缩提示词作为普通 user 输入，走 `drain_to_completed` 流式请求模型总结（`core/src/compact.rs:564-613`）；成功后：
  - 取最后一轮 assistant 文本作摘要后缀：`get_last_assistant_message_from_turn` + `SUMMARY_PREFIX`（`core/src/compact.rs:289-292`，函数定义在 `core/src/session/turn.rs:2242`）。
  - 收集真实 user 消息：`collect_user_messages`（`core/src/compact.rs:421`，过滤 session prefix / 旧告警等，见 `compact_tests.rs:69-135`）。
  - **倒序挑选**：`build_compacted_history` → `build_compacted_history_with_limit` 从 `user_messages.iter().rev()` 逐个挑选，累计不超过 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`core/src/compact.rs:49, 498-535`）；溢出消息按剩余预算截断（`truncate_text`，529-532），挑完再 reverse 恢复顺序（534），最后附加 summary 作为最后一个 user 消息（554-559）。
- **超窗处理**：`ContextWindowExceeded` 时 `history.remove_first_item()` 从头删除（`core/src/compact.rs:251-260`），注释明确"Trim from the beginning to preserve cache (prefix-based)"——**从开头删是为了保住前缀缓存**。
- **initial context 注入**：mid-turn 压缩用 `InitialContextInjection::BeforeLastUserMessage`，把 `build_initial_context` 的结果插到最后一个真实 user 消息之前（`core/src/compact.rs:297-308, 451-481`）；手动/standalone 压缩用 `DoNotInject`，`reference_context_item` 置空使下一轮普通 turn 重新全量注入（`core/src/compact.rs:53-59, 305-308`）。
- **收尾**：`replace_compacted_history` + `recompute_token_usage`（`core/src/compact.rs:313-315`）。

### 3.2 compact_remote.rs —— `/responses/compact` v1（一元调用）

- **入口**：`run_inline_remote_auto_compact_task`（`core/src/compact_remote.rs:45`）；请求走一元（非流式）`compact_conversation_history`（`core/src/client.rs:456-464`）。
- **压缩前裁剪**：`trim_function_call_history_to_fit_context_window`（`core/src/compact_remote.rs:408-448`）在请求前把历史压进 `model_context_window()`：**从末尾（`(0..item_count).rev()`）逐条重写旧函数调用输出**（`rewritten_output_for_context_window`），直到估算 token ≤ 窗口，返回重写数与估算删减 token（`194-205` 调用点）。
- **产出过滤**：`should_keep_compacted_history_item`（`core/src/compact_remote.rs:340-365`）：
  - 丢弃：`developer` 消息（可能含过期/重复指令，330-331）、非真实 user 内容（session prefix 等包装，332-333）、全部工具调用与输出（FunctionCall/FunctionCallOutput/CustomToolCall/WebSearchCall 等，353-363）、`CompactionTrigger`。
  - 保留：真实 user 消息（`TurnItem::UserMessage` / `HookPrompt`，343-348）、assistant 消息（336）、`Compaction`/`ContextCompaction` 标记（351）。
- 过滤后 `insert_initial_context_before_last_real_user_or_summary` 注入 initial context（`core/src/compact_remote.rs:321`）。
- **键复用**：请求经 `ApiCompactionInput` 携带与普通请求相同的 `prompt_cache_key`（见 §2.1）。

### 3.3 compact_remote_v2.rs —— `/responses/compact` v2（流式）

- **入口**：`run_inline_remote_auto_compact_task`（`core/src/compact_remote_v2.rs:55-73`，自动）/ `run_remote_compact_task`（75-98，手动）；实现标识 `CompactionImplementation::ResponsesCompactionV2`（109-114）。
- **流式**：通过 `client_session.stream(...)` 调用（`core/src/compact_remote_v2.rs:337-352`），重试上限 `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES`（330-335）。
- **截留策略**：`build_v2_compacted_history`（`core/src/compact_remote_v2.rs:447-461`）先过滤出可保留消息（`is_retained_for_remote_compaction_v2`：仅 `user | developer | system` 角色，463-469），再过一遍 `should_keep_compacted_history_item` 去工具输出；随后 `truncate_retained_messages_for_remote_compaction`（471-495）**倒序截留**：从 `items.into_iter().rev()` 开始保留，累计不超过 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`（`core/src/compact_remote_v2.rs:50`），超限消息按剩余预算截断文本（513-529），再 reverse 恢复顺序。
- 压缩输出（`compaction_output`）作为历史最后一项（458-459）；`reference_context_item` 按注入模式设置（297-300），收尾 `recompute_token_usage`（311）。

---

## 4. 压缩触发（结论 5：核实通过，一处修正）

### 4.1 自动压缩状态判定（`core/src/session/turn.rs:732-782`）

`auto_compact_token_status` 返回 `AutoCompactTokenStatus`（720-730 字段定义），按 `model_auto_compact_token_limit_scope` 分两种 scope：

- **Total**（**默认**，修正见下）：`auto_compact_scope_tokens = active_context_tokens`，阈值取模型 `auto_compact_token_limit()`，无窗口上限（`turn.rs:741-748`）。
- **BodyAfterPrefix**：`auto_compact_scope_tokens = active_context_tokens - prefill_baseline`，其中 baseline 来自 `auto_compact_window_snapshot().prefill_input_tokens`，未观测到则退化为 `active_context_tokens`（`turn.rs:749-763`）。
- 任一条件满足即触发：`auto_compact_scope_tokens >= auto_compact_scope_limit || active_context_tokens >= full_context_window_limit`（`turn.rs:765-770`）。
- 触发点：`run_pre_sampling_compact`（`turn.rs:784-804`）在每次采样前检查，达到即 `run_auto_compact(... InitialContextInjection::DoNotInject, CompactionReason::ContextLimit, CompactionPhase::PreTurn)`。

**修正说明**：原始调研称"GPT-5 系默认 BodyAfterPrefix"，但代码中 `AutoCompactTokenLimitScope` 的 `#[default]` 是 **Total**（`protocol/src/config_types.rs:31-37`），客户端无按模型族切换默认 scope 的逻辑；BodyAfterPrefix 是显式配置项。Guardian 审查会话的复用键会纳入 scope（`core/src/guardian/review_session.rs:144, 169`），测试场景中改 scope 会失效缓存的会话（`review_session.rs:1219-1239`）。

### 4.2 prefill baseline 的观测（修正为更精确表述）

- **服务端观测优先**：`AutoCompactWindow::ensure_server_observed_prefill_from_usage` 在首个服务端 usage 样本到达时记录 `ServerObserved(input_tokens)`，之后不再覆盖（`core/src/state/auto_compact_window.rs:43-57`）。
- **本地估算兜底**：resume/rollout 重建时 `set_auto_compact_window_estimated_prefill_for_scope` 用历史估算值设 `Estimated`（`core/src/session/mod.rs:1302-1315, 1321-1335`）；只在 scope=BodyAfterPrefix 时启用（`mod.rs:3048-3053`）。
- 窗口换代：`start_next` 递增 ordinal 并清空 prefill（`auto_compact_window.rs:38-41`）。

### 4.3 模型降级预压缩（`core/src/session/turn.rs:810-859`，核实通过）

`maybe_run_previous_model_inline_compact`：切到更小窗口模型时，若 `active_context_tokens >= new_context_window`（BodyAfterPrefix scope 下）或超出新模型 auto-compact 限额（Total scope），且旧模型 slug ≠ 新模型、旧窗口 > 新窗口，则**用旧模型窗口构造 `previous_model_turn_context` 提前压缩**（`CompactionReason::ModelDownshift`，`turn.rs:848-858`）。

---

## 5. 上下文 diff 机制（结论 6：核实通过，缓存保持核心）

### 5.1 引用基线（reference_context_item）

- 每个真实 user turn 持久化一个 `TurnContextItem`（含 model/effort/personality 等快照），`record_context_updates_and_set_reference_context_item`（`core/src/session/mod.rs:2996-3026`）：
  - **首次（基线缺失）**：`build_initial_context` 全量注入（`mod.rs:3004-3006`）。
  - **稳态**：`build_settings_update_items` 只注入 diff（`mod.rs:3007-3011`）；**diff 为空则不注入任何模型可见项**（`mod.rs:3013-3016`），但基线仍推进（`mod.rs:3024-3025`），使后续 diff 与当前状态对齐。
  - 模型切换且全量注入时，前缀附加 `<model_switch>` developer 消息避免指令丢失（`mod.rs:2989-2990` 注释）。
- 压缩重建基线：mid-turn 压缩全量重注入时同步重建 `reference_context_item`（`compact.rs:305-308`），其他非常规任务不更新基线（`mod.rs:2993-2995` 注释）。

### 5.2 diff 内容（`core/src/context_manager/updates.rs:209-243`）

`build_settings_update_items` 逐项对比前后 `TurnContextItem` 与 `PreviousTurnSettings`，有变化才产出：

- developer 侧（合并进一个 developer 消息，222-238）：模型切换指令（`build_model_instructions_update_item`，166-181，**放最前**保证先读）、权限策略（`build_permissions_update_item`）、协作模式（`build_collaboration_mode_update_item`）、实时模式（`build_realtime_update_item`）、人格（`build_personality_update_item`，131-153，模型不一致时不发）。
- user 侧：环境上下文更新（`build_environment_update_item`，221）。
- 空集合 → 无注入：`build_text_message` 对空段返回 `None`（`updates.rs:191-207`）。

### 5.3 测试证据（结论 13 部分）

- `core/tests/suite/prompt_caching.rs:396-403`：断言第二请求 `input` 前段与第一请求 `input` 完全相等（"expected cached prefix to be reused"）。
- `core/tests/suite/prompt_caching.rs:409-509`（`overrides_turn_context_but_keeps_cached_prefix_and_key_constant`）：turn 间修改 approval/sandbox/effort/summary 后，`prompt_cache_key` 不变（498-501）、前缀完全复用（503-509）——effort/summary 是请求级 `reasoning` 字段（`client.rs:719-741`）而非上下文项，变化不重写历史。

---

## 6. 工具与指令稳定性（结论 7、8：核实通过）

### 6.1 工具 schema（结论 7）

- 序列化**不排序**：`create_tools_json_for_responses_api`（`tools/src/tool_spec.rs:78-89`）按传入顺序逐个 `serde_json::to_value`，无任何排序。
- **构建顺序确定性**：`build_tool_specs_and_registry`（`core/src/tools/spec_plan.rs:161-189`）按固定流水线组装——`add_tool_sources` → `append_tool_search_executor` → `prepend_code_mode_executors`；`build_model_visible_specs_and_registry` 先遍历 runtimes（去重、过滤 code-mode-only），再追加 hosted specs（`spec_plan.rs:191-228`）。
- 集成测试 `prompt_tools_are_consistent_across_requests`（`core/tests/suite/prompt_caching.rs:103-222`）：两轮请求的 `tools` 数组按名字逐一比对完全一致（`assert_tool_names`，212-219；断言辅助 80-96）。

### 6.2 instructions（结论 8）

- 优先级：config `base_instructions` override > 会话历史 `session_meta.base_instructions` > 当前模型默认指令（`core/src/session/mod.rs:552-568`）。
- 确定性构造：`ModelInfo::get_model_instructions`（`protocol/src/openai_models.rs:449-468`）优先用 `instructions_template` 模板替换 personality 占位符，无模板回退 `base_instructions`。
- 测试断言：同一测试内两请求 `body["instructions"]` 逐字节相等（`prompt_caching.rs:208-218`），指令随工具集变化只在固定白名单场景追加（202-206）。

---

## 7. WebSocket 增量请求（结论 9：核实通过，行号修正）

- 原调研行号 1010-1090，实际分两段：
  - `get_incremental_items`（`core/src/client.rs:1010-1047`）：判定当前请求是否为上一请求的**严格前缀扩展**——非 input 字段必须逐字段相等（1022-1031），baseline = 上一请求 input + 服务端已返回的 items（1033-1036），`request.input.starts_with(&baseline)` 且增量非空（1039-1041）时才返回增量段；否则回退整包。
  - `prepare_websocket_request`（`core/src/client.rs:1059-1089`）：增量可行时发送 `ResponsesWsRequest::ResponseCreate { previous_response_id: Some(last_response.response_id), input: incremental_items, .. }`（1082-1089），**不重发全量历史**；`previous_response_id` 缺失时回退整包（1077-1080）。
- 意图：增量输入使服务端按 previous_response_id 延续，避免重放完整前缀、最大化 prefix cache 收益。

---

## 8. GPT-5.x 特殊处理（结论 12：核实通过，两处细化）

- **use_responses_lite**（`protocol/src/openai_models.rs:408` 字段）：开启时
  - `reasoning.context = ReasoningContext::AllTurns`（`core/src/client.rs:732-737`），否则省略用默认 `current_turn`；
  - `parallel_tool_calls` 强制 false：`prompt.parallel_tool_calls && !model_info.use_responses_lite`（`core/src/client.rs:785`）。
- **effort/summary 变化走请求字段而非重写历史**：effort/summary 经 `build_reasoning` 放入请求 `reasoning.effort / reasoning.summary`（`core/src/client.rs:719-741`），与上下文无关；测试证明 override 后前缀与缓存键不变（`prompt_caching.rs:409-509`）。上下文 diff 面（§5.2）也不含 effort/summary。
- **BodyAfterPrefix 压缩 scope**：见 §4.1 修正——默认是 Total，BodyAfterPrefix 为显式配置。
- **模型切换 recompute_token_usage**：`recompute_token_usage`（`core/src/session/mod.rs:3071-3085`，基于历史 + base_instructions 重新估算）在压缩后必调（`compact.rs:315`、`compact_remote.rs:295`、`compact_remote_v2.rs:311`），thread 回滚重建后也调（`core/src/session/handlers.rs:571`）；模型切换另有按旧窗口预压缩（§4.3）与 diff 注入 `<model_switch>` 消息（§5.1）。

---

## 9. 本地缓存（结论 10：核实通过）

`models-manager` crate（`codex-rs/models-manager/`）：

- **缓存文件**：`models_cache.json`（`src/manager.rs:24`），持久化模型目录 + ETag（`manager.rs:305-309`、`cache.rs`）。
- **ETag 增量刷新**：`refresh_if_new_etag`（`manager.rs:171-174, 254-256`），ETag 相同则跳过网络刷新；provider 变更会使缓存失效避免串用（`manager.rs:362-371`）。
- **TTL**：`DEFAULT_MODEL_CACHE_TTL = 300s`（`manager.rs:25`），`cache.rs:172-181` 判新鲜度；命中时 `renew_cache_ttl` 续期（`manager.rs:257-258`，`cache.rs:94-95`）。
- **RefreshStrategy**（`manager.rs:49-55`）：`Online` / `Offline` / `OnlineIfUncached`；非根 agent 用 `Offline`，根会话用 `OnlineIfUncached`（`core/src/session/mod.rs:535-546`）。

---

## 10. AGENTS.md 硬规则（结论 11：核实通过）

`reference/codex-cli/AGENTS.md` "Code Review Rules → Model visible context" 一节（硬性约定）：

1. **No history rewrite**——上下文必须增量构建。
2. **避免频繁改动 context 导致 cache miss**。
3. **注入项必须有界**——所有模型可见注入项都有大小上限。
4. **单项 ≤ 10K tokens**。
5. 能跨 **>1K tokens** 的新增单项标 P0，需人工评审。
6. 注入片段必须定义为 `core/context` 下的 struct 并实现 `ContextualUserFragment` trait。

---

## 11. 相关测试清单（结论 13：核实通过，行号修正）

| 测试 | 位置 | 断言要点 |
|------|------|---------|
| `prompt_tools_are_consistent_across_requests` | `core/tests/suite/prompt_caching.rs:103-222` | 两轮请求 tools 数组一致（212-219）、instructions 一致（208-218） |
| `prefixes_context_and_instructions_once_and_consistently_across_requests` | `core/tests/suite/prompt_caching.rs:308-406` | body2 input 前缀 = body1 全量（396-403） |
| `overrides_turn_context_but_keeps_cached_prefix_and_key_constant` | `core/tests/suite/prompt_caching.rs:409-509` | override 后 prompt_cache_key 不变（498-501）、前缀复用（503-509） |
| `per_turn_overrides_keep_cached_prefix_and_key_constant` | `core/tests/suite/prompt_caching.rs:703-795` | 同上，per-turn override 场景 |
| 压缩请求键复用断言 | `core/tests/suite/compact_remote.rs:720-735` | compact 请求 `prompt_cache_key` 与普通请求一致 |
| 键复用测试用例（API key / ChatGPT 两种鉴权） | `core/tests/suite/compact_remote.rs:753-768, 771-780` | 复用 key 且省略 responses-only 字段 |
| guardian 键复用 | `core/src/guardian/tests.rs:1579, 1787-1788` | 两次审查请求 `prompt_cache_key` 相等 |

---

## 12. 对 crish 的可借鉴点

1. **前缀稳定优先于一切**：以「首次全量注入 + 稳态纯 diff」为基线模型（`session/mod.rs:2996-3026` + `updates.rs:209-243`），无变化零注入；crish 的 session-loop 应保留「参考上下文快照」概念，而不是每轮重建。
2. **压缩即缓存管理**：压缩后必须重注入完整上下文基线并重建 reference item（`compact.rs:297-308`），否则后续 diff 会基于错误基线导致前缀漂移；crish 压缩实现应把「压缩后缓存键/基线重建」作为一等设计约束。
3. **prompt_cache_key 的命名空间化**：主线程用 thread_id、子代理用 `guard:{parent}` 式前缀（`review_session.rs:188-200`），可让同父线程的审查子代理共享同一缓存前缀；crish 的 orchestrator/子代理调度可套用。
4. **压缩预算反向挑选**：从最新消息倒序挑选至预算（`compact.rs:517-535`、`compact_remote_v2.rs:471-495`），超窗时删头保缓存（`compact.rs:251-260`）；这是「保缓存 + 保最近上下文」的通用解。
5. **度量先行**：把 `cache_read.input_tokens` 落为结构化指标（`session_telemetry.rs:422-425`），crish 可在 OTel 侧建立「缓存命中率」看板评估优化效果。
6. **WebSocket 增量输入**：严格前缀扩展时只发 `previous_response_id + 增量`（`client.rs:1010-1089`），适合 crish 的双传输架构评估。
7. **确定性纪律**：工具 schema 不排序 + 固定注册顺序（`tool_spec.rs:78-89`、`spec_plan.rs:161-228`）+ instructions 模板化（`openai_models.rs:449-468`），全部写进 AGENTS.md 硬规则（10K tokens 上限、>1K 人工评审、No history rewrite），把缓存友好变成工程红线。
8. **模型列表本地缓存**：`models_cache.json + ETag + TTL + RefreshStrategy`（`models-manager/`）是低风险高收益的缓存位点，crish 的模型目录可照搬。

---

## 13. 核实结论汇总

| 原结论 | 核实结果 |
|--------|---------|
| 1 版本前提（Responses API 双传输、无 async-openai/anthropic） | ✅ 通过 |
| 2 prompt_cache_key（默认 thread_id、guardian 键、压缩复用） | ✅ 通过 |
| 3 OTel 度量 | ✅ 通过 |
| 4 三套压缩 | ✅ 通过 |
| 5 压缩触发 + 模型降级预压缩 | ✅ 通过（BodyAfterPrefix 默认值一处修正，见 §4.1） |
| 6 上下文 diff 注入 | ✅ 通过 |
| 7 工具 schema 稳定性 | ✅ 通过 |
| 8 instructions 确定性 | ✅ 通过 |
| 9 WebSocket 增量 | ✅ 通过（行号修正为 1010-1047 / 1059-1089） |
| 10 模型列表缓存 | ✅ 通过 |
| 11 AGENTS.md 硬规则 | ✅ 通过 |
| 12 GPT-5.x 处理 | ✅ 通过（use_responses_lite 细节补全；scope 默认值修正） |
| 13 测试 | ✅ 通过（测试函数起始行与断言行号修正） |
