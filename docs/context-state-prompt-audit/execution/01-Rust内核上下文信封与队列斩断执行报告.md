# 01 - Rust 内核上下文信封与队列斩断执行报告

> **执行角色**：Task 1：Rust 内核上下文信封融合与后台队列斩断专员  
> **执行日期**：2026-10-12  
> **依据规范**：`AGENTS.md`（反退避、零作弊、行数预算、立体验证、提交权集中于主 Agent）、`docs/context-state-prompt-audit/00-总方案.md` 与 `docs/context-state-prompt-audit/audits/01-Rust引擎Steering队列与IdleResume异常唤醒审计.md`  
> **受控文件域**（严格限定）：
>
> - `apps/agent-workbench/src-tauri/src/run/run_launch.rs`
> - `apps/agent-workbench/src-tauri/src/run/run_idle.rs`
> - `crates/orchestrator/src/steering_queue.rs`

---

## 一、任务背景与缺陷根因剖析

### 1.1 用户现场问题再现

用户在多模型切换与日常对话操作中反馈：

> “当前已切换到模型 ornith:latest（服务商 ollama）。权限模式：full。思考档位：Max。 这个不是系统提示吗，是随到用户发送的消息后面，不是一个单独用户输入内容的。 你看看这是什么情况吧”

在原实现中存在三重架构断层：

1. **错位入队**：`run_launch.rs` 将前端随附的 `options.context_state` 包装成 `SteeringInputEntry` 并压入 `state.pending_queue`。
2. **时序断裂**：当次由用户发起的真实 Run 在装配系统提示词与用户消息时完全没有融入 `context_state`，大模型当次毫无环境感知。
3. **角色伪造与异常二轮唤醒**：当次 Run 结束后会话进入 Idle，`run_idle.rs` 扫描到 `pending_queue` 中残留的 `context-state` 条目，误判为“有外部 Steering 消息需要唤醒”，并在 `drain_pending_to_inject_messages` 中将其赋予 `role: AgentMessageRole::User`，以此作为 `prompt` 启动了全新的 `idle-resume` Run，导致模型向用户自言自语并凭空多耗费 1 个 Turn。

### 1.2 改造核心目标

1. **彻底斩断队列**：物理拔除 `run_launch.rs` 向 `pending_queue` 塞入 `context_state` 的逻辑；状态切换不是异步跨 Run 唤醒事件，严禁入队！
2. **当次信封融合**：在 `run_launch.rs` 中，将 `options.context_state` 与用户 `prompt` 按照规范融合成单一合体内容（高内聚信封结构），当次生效，0 额外 Turn；
3. **收口防线兜底**：在 `run_idle.rs` 的 `drain_pending_to_inject_messages` 中彻底移除将 `context-state` 伪造为 `User` 消息的分区逻辑，对任何残留条目做硬过滤丢弃；并在 `compute_resume_decision` 中增加空注入保护；
4. **契约语义纠偏**：在 `crates/orchestrator/src/steering_queue.rs` 中修正文档与方法说明，确保 `has_pending` 与 `has_pending_for` 不将 `context-state` 视作唤醒信号，保持遗留测试兼容。

---

## 二、逐文件改造详述

### 2.1 `apps/agent-workbench/src-tauri/src/run/run_launch.rs`

- **修改点 1：删除入队逻辑（原第 801-819 行）**  
  彻底移除了将 `context_state` 构造为 `SteeringInputEntry::context_state(...)` 并调用 `state.pending_queue.lock().unwrap().replace_or_enqueue(entry)` 的整段逻辑。
- **修改点 2：用户消息生成改造（第 783-807 行）**  
  采用合体信封规范，当 `options.context_state` 存在且非空时，与用户 `prompt` 融合成单一内容：
  ```rust
  let effective_prompt = match (
      prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()),
      context_state.as_deref().map(str::trim).filter(|s| !s.is_empty()),
  ) {
      (Some(p), Some(cs)) => {
          if p.contains("[用户输入]") && p.contains("[系统环境上下文]") {
              p.to_string()
          } else {
              format!("[用户输入]\n{}\n\n[系统环境上下文]\n{}", p, cs)
          }
      }
      (Some(p), None) => p.to_string(),
      (None, Some(cs)) => format!("[系统环境上下文]\n{}", cs),
      (None, None) => String::new(),
  };
  let message = crate::engine::user_message_with_content(
      &effective_prompt,
      client_message_id.as_deref(),
      content_parts,
  );
  ```
  如果前端已完成信封预封装（包含 `[用户输入]` 与 `[系统环境上下文]` 标记），保持幂等直接复用，避免双重前缀。
- **修改点 3：更新结构体文档契约（第 263-268 行）**  
  明确 `RunTaskOptions.context_state` 的字段契约：“与 prompt 融合成合体信封当次生效，0 额外 Turn，绝不入跨 run 队列”。

### 2.2 `apps/agent-workbench/src-tauri/src/run/run_idle.rs`

- **修改点 1：`drain_pending_to_inject_messages` 彻底清洗（原第 551-633 行）**
  1. 移除了 `let (context_states, others)` 分区逻辑中将 `context_states` 遍历组装成 `role: AgentMessageRole::User` 且 `kind: ContextState` 的生成逻辑；
  2. 增加过滤防线：
     ```rust
     let valid_entries: Vec<_> = entries
         .into_iter()
         .filter(|e| e.group_id.as_deref() != Some(CONTEXT_STATE_GROUP))
         .collect();
     if valid_entries.is_empty() {
         return Vec::new();
     }
     ```
     彻底过滤丢弃任何残留的 `CONTEXT_STATE_GROUP` 条目，绝不为 context_state 生成注入消息，绝不返回包含状态提示的用户消息。
- **修改点 2：`compute_resume_decision` 决策兜底防线（第 240-247 行）**  
  在排空队列后增加判断：若 `inject.is_empty()` 且未激活定时器、Cron、Goal 等后台任务（`!timer_active && !cron_enabled && !goal_pending`），直接返回 `None`。确保在极端并发或历史脏数据下，绝不会拉起空的 `idle-resume` Run。

### 2.3 `crates/orchestrator/src/steering_queue.rs`

- **修改点 1：方法与契约标记（第 95-130 行）**  
  为 `SteeringInputEntry::context_state` 与 `into_user_message` 增加明确警示注释：标注该方法为遗留测试/纯状态标记兼容路径，生产环境中 `context_state` 直接在 `run_launch.rs` 融合，严禁作为唤醒源进入 `pending_queue`。
- **修改点 2：唤醒检测刚性绝缘（第 268-285 行）**  
  修改 `has_pending` 与 `has_pending_for` 方法，过滤 `CONTEXT_STATE_GROUP`：
  ```rust
  pub fn has_pending(&self) -> bool {
      self.entries
          .iter()
          .any(|e| e.group_id.as_deref() != Some(CONTEXT_STATE_GROUP))
  }

  pub fn has_pending_for(&self, session_id: &str) -> bool {
      self.entries.iter().any(|e| {
          e.session_id == session_id && e.group_id.as_deref() != Some(CONTEXT_STATE_GROUP)
      })
  }
  ```
  保证调度器在检查唤醒源时，绝不会因为队列中存在残留的 `context-state` 而误判为 `queue_pending == true`。
- **修改点 3：单元测试断言升级（第 680-692 行）**  
  在 `context_state_entry_dedups_and_marks_kind` 单元测试中，新增 `assert!(!queue.has_pending())` 断言，验证即使队列中存在 `context-state` 条目，队列也不会向外报告待唤醒信号。

---

## 三、代码质量与门禁验证

根据 `AGENTS.md` 规范，所有改动均执行立体化验证：

1. **Rust 编译与类型检查（零警告）**：
   - 执行命令：`cargo check -p crish-agent-workbench`
   - 结果：通过（Finished `dev` profile [unoptimized + debuginfo] target(s) in 43.05s，零错误零警告）。
2. **Orchestrator 单元测试**：
   - 执行命令：`cargo test -p orchestrator --lib`
   - 结果：`ok. 220 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.90s` 全量通过。
3. **crish-agent-workbench 单元与集成测试**：
   - 执行命令：`cargo test -p crish-agent-workbench --lib`
   - 结果：`ok. 504 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.12s` 全量通过。
4. **Git 纪律**：
   - 严格遵循子 Agent 提交权限纪律：**未执行任何 `git commit`**，改动完整保留在工作区等待主 Agent 验收收口。
   - 严格遵循文件域隔离：仅触及被分配的 3 个核心后端文件，未跨域改动任何其他模块。
