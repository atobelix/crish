# Task 2：Rust 单元测试与不变量验证执行报告

> **战役工作区**：`docs/context-state-prompt-audit/`  
> **文档位置**：`docs/context-state-prompt-audit/execution/02-Rust单测与不变量验证执行报告.md`  
> **角色**：Task 2：Rust 单元测试与不变量更新专员  
> **工作目录**：`c:\Software\conex`  
> **参考依据**：`docs/context-state-prompt-audit/00-总方案.md` 与 `audits/01-Rust引擎Steering队列与IdleResume异常唤醒审计.md`  
> **基准纪律**：遵循 `AGENTS.md`（严格限定文件域、反退避、零作弊、全门禁验证、不执行 `git commit`）

---

## 一、任务目标与文件域契约

### 1.1 核心目标

针对环境状态切换（`context_state`）被错误塞入 `pending_queue` 导致 `idle-resume` 异常二次唤醒、伪造 `role: AgentMessageRole::User` 消息的问题，在 Rust 内核测试层建立刚性不变量防线与专项回归测试，确保持续集成和日常演进中绝对不发生逻辑回潮。

### 1.2 严格限定文件域

本任务严格限定于测试文件域，严禁触碰其他模块：

- `apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs`（已实施更新与补充）
- `apps/agent-workbench/src-tauri/src/engine_tests.rs`（经审查无需修改）

---

## 二、测试重构与新增专项测试清单

在 `apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs` 中新增 4 项端到端及状态机级单元测试：

### 2.1 审查与新增：`drain_pending_to_inject_messages` 队列绝缘测试

- **测试函数**：`drain_pending_filters_context_state_never_generates_user_message`
- **代码位置**：`core_run_commands_tests.rs:4295-4336`
- **契约断言**：
  1. **纯 context-state 场景**：人为向 `PendingMessageQueue` 放入带有 `group_id = Some(CONTEXT_STATE_GROUP)` 的条目。调用 `drain_pending_to_inject_messages` 后，断言返回消息列表**恒为空**（`messages.is_empty()`），彻底斩断将 `context-state` 转化为 `role: AgentMessageRole::User` 消息的旧通路。
  2. **混合共存场景**：当队列中同时存在遗留的 `context-state` 条目与合法的系统定时器/长任务 `steering` 条目时，断言 `drain_pending_to_inject_messages` 精准过滤丢弃 `context-state`，仅提取合法的 `steering` 消息。断言其元数据 `metadata.kind` 绝不可为 `context-state`。

### 2.2 测试 1：`run_task` 提示词信封融合格式断言

- **测试函数**：`run_task_with_context_state_formats_envelope_prompt`
- **代码位置**：`core_run_commands_tests.rs:4338-4371`
- **契约断言**：
  1. 调用 `run_task_impl` 时传入 `options.context_state = Some("当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。")`，业务指令为 `options.prompt = Some("分析这个报错")`。
  2. 模拟 LLM 真实运行收口后，审查 `TestProvider` 捕获的线网请求。
  3. 断言第一回合用户的 User 消息正文被严格格式化为信封合体格式：
     ```text
     [用户输入]
     分析这个报错

     [系统环境上下文]
     当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。
     ```
  4. 证实模型在当次 Turn 0 直接感知环境切换，0 额外轮次。

### 2.3 测试 2：`run_task` 完成后 `pending_queue` 为空且零 `idle-resume` 唤醒

- **测试函数**：`run_task_with_context_state_leaves_pending_queue_empty_and_no_idle_resume`
- **代码位置**：`core_run_commands_tests.rs:4373-4422`
- **契约断言**：
  1. 发起携带 `context_state` 的 `run_task_impl`。
  2. 待当次 Run 完结（`wait_run_terminal`）后，直接检查内存中的 `state.pending_queue`：
     - 断言 `queue.len() == 0`，证实 `run_launch.rs` 不再将 `context_state` 排入跨 Run 队列。
  3. 执行 `decide_idle_resume(&state, &active, AgentEndReason::Stop, false, &ResumeSignals::default()).await`：
     - 断言返回值必须为 `None`，绝不因状态切换触发二次唤醒。
  4. 检查 `provider.requests().len()` 严格等于 1，断言全生命周期仅发起 1 次 LLM 调用，0 额外 Turn。

### 2.4 测试 3：无 `context_state` 时保持原始 Prompt 与零多余标签

- **测试函数**：`run_task_without_context_state_keeps_original_prompt`
- **代码位置**：`core_run_commands_tests.rs:4424-4464`
- **契约断言**：
  1. 发起不带 `context_state`（`None`）的常规任务。
  2. 审查 `provider.requests()` 中的 User 消息：
     - 断言正文严格等于原始用户输入 `"无状态上下文的常规指令"`；
     - 断言正文绝不包含 `"[用户输入]"` 标签；
     - 断言正文绝不包含 `"[系统环境上下文]"` 标签。
  3. 证实非状态变更场景 100% 保持原有行为，零视觉与提示词副作用。

---

## 三、测试运行与立体门禁验证结果

因为当前宿主环境正在运行 `npm run dev:workbench`（Tauri 桌面应用前台实例占用了 `target/debug/crish-agent-workbench.exe`），依照调度指引使用独立测试目录 `--target-dir target-test` 进行验证：

### 3.1 静态检查与警告清零（`cargo check --tests`）

```bash
cargo check --target-dir target-test --tests -p crish-agent-workbench
```

**运行结果**：

```text
    Checking crish-agent-workbench v0.1.0 (C:\Software\conex\apps\agent-workbench\src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 6.90s
```

- **编译状态**：✅ PASS（100% 通过）
- **编译器告警**：✅ 0 警告（已剔除冗余导入）

### 3.2 专项单元测试执行（4/4 全绿）

```bash
cargo test --target-dir target-test -p crish-agent-workbench --bin crish-agent-workbench -- \
  drain_pending_filters_context_state_never_generates_user_message \
  run_task_with_context_state_formats_envelope_prompt \
  run_task_with_context_state_leaves_pending_queue_empty_and_no_idle_resume \
  run_task_without_context_state_keeps_original_prompt
```

**运行结果**：

```text
running 4 tests
test core_run_commands::tests::drain_pending_filters_context_state_never_generates_user_message ... ok
test core_run_commands::tests::run_task_without_context_state_keeps_original_prompt ... ok
test core_run_commands::tests::run_task_with_context_state_formats_envelope_prompt ... ok
test core_run_commands::tests::run_task_with_context_state_leaves_pending_queue_empty_and_no_idle_resume ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 1176 filtered out; finished in 0.72s
```

### 3.3 回归影响面验证（既有 Drain 测试集回归）

```bash
cargo test --target-dir target-test -p crish-agent-workbench --bin crish-agent-workbench -- core_run_commands::tests::drain_
```

**运行结果**：

```text
running 4 tests
test core_run_commands::tests::drain_merge_caps_at_16 ... ok
test core_run_commands::tests::drain_pending_filters_context_state_never_generates_user_message ... ok
test core_run_commands::tests::drain_merge_under_cap_unchanged ... ok
test core_run_commands::tests::drain_timer_steering_carries_trigger_source ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 1176 filtered out; finished in 0.00s
```

---

## 四、不变量防御网与审计守卫自检

| 检查项                                 | 验证状态 | 现场证据与设计实现                                                                                                              |
| :------------------------------------- | :------: | :------------------------------------------------------------------------------------------------------------------------------ |
| **不变量 1：Zero Fake User Message**   | ✅ 闭环  | `drain_pending_filters_context_state_never_generates_user_message` 确凿断言 `context_state` 绝不产出 `role: User` 消息。        |
| **不变量 2：Zero Extra Turn**          | ✅ 闭环  | `run_task_with_context_state_leaves_pending_queue_empty_and_no_idle_resume` 断言 `provider.requests().len() == 1`，0 额外轮次。 |
| **不变量 3：Physical Queue Isolation** | ✅ 闭环  | 断言 `state.pending_queue.len() == 0`，`context_state` 绝不入队。                                                               |
| **不变量 4：Prompt 信封当次生效**      | ✅ 闭环  | 断言第一轮 User 消息直接包含 `[用户输入]` 与 `[系统环境上下文]`。                                                               |
| **不变量 5：无状态时零副作用**         | ✅ 闭环  | `run_task_without_context_state_keeps_original_prompt` 断言不产生任何多余标记。                                                 |
| **协作纪律：Git 提交隔离**             | ✅ 遵循  | 未执行 `git commit`，将工作区完整状态留交主 Agent 统一核验。                                                                    |

---

## 五、结论

Task 2「Rust 单元测试与不变量更新专员」已完满完成核心任务：在限定文件域 `apps/agent-workbench/src-tauri/src/core_run_commands_tests.rs` 中补全了针对 `context_state` 队列绝缘、提示词信封融合、以及 `idle-resume` 零异常唤醒的 4 项刚性自动化测试。所有测试全部 PASS，编译零警告，满足方案要求，收工交付。
