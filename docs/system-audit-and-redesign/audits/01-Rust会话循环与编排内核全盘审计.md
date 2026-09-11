# 01-Rust 会话循环与编排内核全盘审计报告

> **审计范围**：`crates/session-loop/` 与 `crates/orchestrator/`（含全部 `src/`, `tests/`, `benches/`）
> **审计职责**：全盘代码与测试审计师 01（只找问题、零废话、清理无用冗余、严禁修改业务代码与 Git 操作）
> **执行标准**：`docs/system-audit-and-redesign/00-战役通则与协同执行规范.md` 及反退避铁律

---

## 目录

1. [一、双轨事件流与自愈状态机缺陷](#一双轨事件流与自愈状态机缺陷)
   - 1.1 `LiveEventSink` 广播事件漏发与不对称性
   - 1.2 `ToolStart` 双发与中间态事件未实时流出
   - 1.3 `ToolPromiseDetector` 多字节 UTF-8 切片 Panic 隐患
   - 1.4 `ToolPromiseDetector` 粗暴子串黑名单与英文完全盲区
   - 1.5 `ApprovalChannel` 采用 50ms 轮询休眠而非反应式通知
2. [二、进程管理与资源泄漏隐患](#二进程管理与资源泄漏隐患)
   - 2.1 运行中崩溃导致内存事件流全量永久丢失
   - 2.2 伪进程泄漏断言与 Windows 进程树真实孤儿风险
   - 2.3 `TaskAuditAccumulator` 无界内存膨胀与命令映射泄漏
3. [三、死代码与冗余兼容器排查](#三死代码与冗余兼容器排查)
   - 3.1 `#[allow(dead_code)]` 挂起未引用的方法与结构体
   - 3.2 源码级文件全局 `#![allow(unused_imports)]` 掩盖依赖污染
   - 3.3 跨 crate 类型定义重复与同义包装层冗余
4. [四、测试有效性与虚假/弱化断言清单](#四测试有效性与虚假弱化断言清单)
   - 4.1 自比同义反复测试（Tautological Assertion）
   - 4.2 无意义字段自赋值假测试（No-op Struct Field Test）
   - 4.3 压测中基于 Mock 的假“无孤儿/PTY 句柄释放”断言
   - 4.4 工具执行测试中普遍弱化的 `.is_ok()` 断言
5. [五、综合整改与重构行动建议清单](#五综合整改与重构行动建议清单)

---

## 一、双轨事件流与自愈状态机缺陷

### 1.1 `LiveEventSink` 广播事件漏发与不对称性

- **缺陷位置**：
  - `crates/session-loop/src/loop/handlers/executing_tools.rs:133`
  - `crates/session-loop/src/loop/handlers/stream_error_fatal.rs:50`
  - `crates/session-loop/src/loop/handlers/turn_complete.rs:132`
  - `crates/session-loop/src/loop/handlers/mod.rs:501, 627, 827, 937, 942, 1173, 1184`
  - `crates/session-loop/src/loop/handlers/streaming.rs:397, 410`
  - `crates/session-loop/src/loop/handlers/stream_error_retry.rs:193, 227`
  - `crates/session-loop/src/steering/nudge.rs:224`
- **问题机理**：
  内核引入了 `LiveEventSink`（Live Track）用于前端实时 IPC 推送（`sequence=None`），以及 `state.events`（Store Track）用于 run 结束后批量落库。
  然而在 `session-loop` 中，**只有少数选定事件**（`AgentStart`, `TurnStart`, `ToolStart`, `MessageDelta`, `MessageStart/End(Assistant)`, `TurnEnd`, `AgentEnd`）被推送到了 `live_sink.push_live`。
  以下关键事件被直接遗漏：
  1. `AgentEvent::RuntimeError`（工具致命错误、流致命错误、收尾错误）：仅 `state.events.push`，**从未推送给 `live_sink`**。前端在实时通道上完全感知不到运行期错误，直接处于无响应等待状态，直到超时；
  2. `AgentEvent::RuntimeInterventionRequired` / `AgentEvent::SteeringEvaluated`：未进入 `live_sink`，导致用户界面无法在发生干预或转向时即时感知状态变化；
  3. `AgentEvent::ContextCompressionStart` / `ContextCompressionEnd`：长会话压缩发生时，实时轨道无任何提示，导致前端界面在压缩期间卡顿且用户不知情；
  4. `AgentEvent::ProviderRequestAnchored` / `AgentEvent::ProviderDiagnostic`：首 Token 延迟与请求诊断事件无法被实时监控消费；
  5. 用户消息的 `AgentEvent::MessageStart` / `MessageEnd`：在 `handlers/mod.rs:937, 942` 中仅追加至 `state.events`，不走 `live_sink`。
- **架构危害**：
  双轨事件流在语义上发生严重割裂，Live Track 是一个被随意裁剪的残缺子集，前端如果依赖 Live Track 显示实时状态，在异常、压缩和转向时会出现白屏、悬挂与假死。

---

### 1.2 `ToolStart` 双发与中间态事件未实时流出

- **缺陷位置**：
  - `crates/session-loop/src/loop/handlers/executing_tools.rs:83-93`
  - `crates/session-loop/src/loop/handlers/executing_tools.rs:104, 439-443`
  - `crates/session-loop/src/exec_batch.rs:198-243`
- **问题机理**：
  1. 在 `executing_tools.rs:85` 中，为了所谓“消除长任务中间停滞”，在调用 `executor.execute_batch` 之前，强行遍历 `calls` 并调用了：
     ```rust
     sink.push_live(AgentEvent::ToolStart {
         session_id: state.machine.context().session_id.clone(),
         batch_id: String::new(), // 此时 batch_id 为空串
         call: call.clone(),
         timestamp: crate::steering::now_iso_utc(),
         turn_index: Some(state.machine.context().turn_index),
     });
     ```
  2. 随后进入 `execute_batch`，此时所有的批处理事件（真正的 `ToolStart`、`ApprovalRequested`、`ApprovalResolved`、`ToolEnd`、`BatchEnd`）被收集在 `outcome.events: Vec<ToolEvent>` 内存缓冲中；
  3. `execute_batch` 执行完毕返回后，在 `executing_tools.rs:104` 调用 `emit_tool_events`，其中 `ToolEvent::ToolStart` 又被转换为带有合法 `batch_id` 的 `AgentEvent::ToolStart` 并**再次调用 `sink.push_live`**（第 441 行）；
  4. 此外，在 `execute_batch` 执行过程中（可能耗时数十秒执行长耗时命令或等待审批），`ApprovalRequested`、`ApprovalResolved`、单工具 `ToolEnd` 等事件均被锁在 `outcome.events` 里，**直到整个批次全部结束才一次性全部 flush**。
- **架构危害**：
  1. 前端在 Live Track 上会收到两次 `ToolStart`（一次 `batch_id` 为空，一次带有真实 `batch_id`），破坏了事件幂等性与前端状态机；
  2. 审批请求与工具执行过程中的中间状态事件在批次执行期间被完全阻塞，实时事件流形同虚设。

---

### 1.3 `ToolPromiseDetector` 多字节 UTF-8 切片 Panic 隐患

- **缺陷位置**：
  - `crates/session-loop/src/steering/strategy.rs:325-329`
- **代码片段**：
  ```rust
  // ── 正向行动意图匹配（重点关注文本尾部 300 字符） ──
  let tail = if trimmed.len() > 300 {
      &trimmed[trimmed.len() - 300..]
  } else {
      trimmed
  };
  ```
- **严重性**：**CRITICAL 运行时崩溃隐患**
- **问题机理**：
  - `trimmed.len()` 返回的是字符串的 **字节数（Byte length）**，而不是 UTF-8 字符数（Char count）；
  - 当 `trimmed.len() > 300` 时，`trimmed.len() - 300` 计算出的字节偏移量极有可能落在多字节 UTF-8 字符（如 3 字节的中文字符、4 字节的 Emoji）的**中间字节**上；
  - 在 Rust 中，对 `&str` 使用非字符边界的切片索引（即 `!trimmed.is_char_boundary(trimmed.len() - 300)`）会**立即触发 Panic**：
    `byte index 298 is not a char boundary; it is inside '...'`
  - 只要模型输出的文本长度超过 300 字节且包含中文，就有高达 **~66% 的概率触发进程 Panic 崩溃**！
- **修复方案**：
  严禁使用字节减法切片，必须使用 `trimmed.char_indices()` 或 `trimmed.chars().rev().take(300)` 提取尾部安全切片。

---

### 1.4 `ToolPromiseDetector` 粗暴子串黑名单与英文完全盲区

- **缺陷位置**：
  - `crates/session-loop/src/steering/strategy.rs:277-358`
- **问题机理**：
  1. **第一层过滤过度扼杀**：
     `strategy.rs:285-297` 中只要文本包含 ` ``` `（哪怕只是引用了一段配置代码或说明），立刻返回 `None`。如果模型在回复中给出代码示例并在末尾说“接下来开始执行编译”，该自愈侦测器直接被完全屏蔽；
  2. **第二/三层过滤全局包含误伤**：
     只要文本任意位置包含“在上一轮中”或“是否需要”，整段文本哪怕长达数千字且尾部有明确工具承诺，也会被一票否决；
  3. **100% 硬编码中文匹配（英文完全盲区）**：
     `action_patterns` 硬编码了 14 个中文短语（`"尝试单独调用"`, `"现在开始执行"`, `"我将执行"`, `"准备运行"` 等）。在英文提示词或模型用英文回复（如 `"I will now run shell_command to test the project."`、`"Let me call the build script now."`）时，**匹配成功率为 0%**，英文自愈完全失效。

---

### 1.5 `ApprovalChannel` 采用 50ms 轮询休眠而非反应式通知

- **缺陷位置**：
  - `crates/session-loop/src/approval.rs:25, 93-100`
- **代码片段**：
  ```rust
  const ABORT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

  async fn wait_aborted(&self) {
      loop {
          if self.is_aborted() {
              return;
          }
          tokio::time::sleep(ABORT_POLL_INTERVAL).await;
      }
  }
  ```
- **问题机理**：
  在等待用户或上级审批裁决时，`ApprovalChannel` 通过一个 `tokio::time::sleep(50ms)` 的死循环轮询 `self.is_aborted()`。
  这不仅造成无谓的 CPU 唤醒与定时器开销，而且直接违背了协作规范中“严禁轮询，采用反应式推送通知（Reactive Wakeup）”的核心原则。`AbortSignal` 和 `AbortToken` 本身应提供可 `await` 的异步事件通知通道。

---

## 二、进程管理与资源泄漏隐患

### 2.1 运行中崩溃导致内存事件流全量永久丢失

- **缺陷位置**：
  - `crates/session-loop/src/loop/loop_exec.rs:170-198`
  - `crates/orchestrator/src/events.rs:372-458`
  - `crates/orchestrator/src/restore.rs:1-32`
- **问题机理**：
  - 在 `session-loop` 的整个生命周期中，所有的事件（`AgentStart`, `TurnStart`, `ToolStart`, `ToolEnd`, `MessageStart/Delta/End`）全部暂存在 `LoopState.events: Vec<AgentEvent>` 这一内存 `Vec` 中；
  - 只有当整个 `session_loop.run()` 顺利执行完毕并返回 `RunOutcome` 时，`orchestrator::drive_outcome` 才会逐个遍历事件并同步落库到 SQLite；
  - **严重故障窗口**：如果一个工具执行需要 10 分钟（如大型编译构建、数据库迁移），期间若进程被强制终止、断电、OOM 崩溃或后台重启，`drive_outcome` **从未被执行**；
  - 在下次系统启动时，`RestoreManager` 扫描数据库发现未完成的 Run 并将其标记为 `interrupted`，但因为中间的任何事件从未落盘，**整个 Run 执行过程中产生的所有日志、工具输出、思考过程全部永久丢失，且无法追溯**。
- **架构危害**：
  事务持久化边界过于滞后（Run 级延迟持久化），无法保证长程任务的 Crash-Consistency。

---

### 2.2 伪进程泄漏断言与 Windows 进程树真实孤儿风险

- **缺陷位置**：
  - `crates/orchestrator/tests/stress_concurrent_runs.rs:668-720, 860-873`
- **问题机理**：
  - 在测试用例 `stress_kill_all_cascade_no_orphans` 中，测试文档宣称：
    > “在 16 个子 Agent 密集执行期间触发 `kill_all`，验证所有子进程、PTY 句柄与内存会话 100% 安全释放，无孤儿泄漏。”
  - 但深入查看测试实现发现：测试使用的是一个纯内存的 `MockCanceller`，其 `request_force_cancel` 仅仅执行了：
    ```rust
    handle.cancelled.store(true, Ordering::SeqCst);
    handle.pty_handle_freed.store(true, Ordering::SeqCst);
    ```
  - **测试断言欺骗性**：测试中没有任何真实的 OS 子进程（如 `powershell.exe`、`cargo.exe`、`node.exe`），也没有任何真实的 PTY / ConPTY 句柄。测试断言 `pty_flag.load() == true` 仅仅是在验证 Mock 对象内存里的布尔变量被置成了 `true`；
  - **Windows 真实运行风险**：在 Windows 平台上，如果 `powershell.exe` 派生了 `cargo build -> rustc.exe -> link.exe` 等深层子进程树，普通的 PID Kill 根本无法清理孙子进程（除非使用 Win32 Job Object 并配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，或执行 `taskkill /F /T`）。内核层在此处缺乏真正的 OS 级沙箱/进程树清理绑定，存在严重的孤儿进程残留与文件锁死隐患。

---

### 2.3 `TaskAuditAccumulator` 无界内存膨胀与命令映射泄漏

- **缺陷位置**：
  - `crates/orchestrator/src/task_events.rs:323-328, 343-362`
- **问题机理**：
  `TaskAuditAccumulator` 维护了 `commands: BTreeMap<String, String>` 与 `records: Vec<TaskAuditRecord>`。
  当收到 `TaskStarted` 事件时，它会将 `task_id -> command` 插入 `commands` 映射表中。虽然 `records` 针对同一 `(task_id, result)` 进行了原位替换，但是：
  1. `commands` 表中的条目**没有任何淘汰机制**，随着会话中运行的任务数增加，`commands` 表无限增长；
  2. 如果任务执行失败或未正常完成，相关条目永久滞留在内存中，形成典型内存泄漏。

---

## 三、死代码与冗余兼容器排查

### 3.1 `#[allow(dead_code)]` 挂起未引用的方法与结构体

- **排查清单**：
  1. `crates/session-loop/src/cache_tracker.rs:160-163`：
     ```rust
     #[allow(dead_code)]
     pub fn set_ttl(&mut self, ttl_seconds: u64) {
         self.ttl_seconds = ttl_seconds;
     }
     ```
     注释声称是“运行期调整 TTL 的预留接口”，但全仓库零引用，属于挂起的死代码。
  2. `crates/session-loop/src/exec_batch.rs:486-489`：
     ```rust
     #[allow(dead_code)]
     pub(crate) fn concurrency_obs(&self) -> &Arc<ParallelExecObs> {
         &self.concurrency_obs
     }
     ```
     未被任何生产链路调用，仅挂起。
  3. `crates/session-loop/src/tool_exec.rs:161-164, 170-174`：
     ```rust
     #[allow(dead_code)]
     pub(crate) fn active(&self) -> usize { ... }

     #[allow(dead_code)]
     pub(crate) fn peak(&self) -> usize { ... }
     ```
     `ParallelExecObs` 中的 `active()` 与 `peak()` 方法未被任何生产逻辑消费。
  4. `crates/orchestrator/tests/common/mod.rs:13`：
     `#![allow(dead_code)]` 整个测试通用模块全局压制未使用的辅助函数。

---

### 3.2 源码级文件全局 `#![allow(unused_imports)]` 掩盖依赖污染

- **缺陷位置**：
  - `crates/session-loop/src/tool_exec.rs:49`
- **代码片段**：
  ```rust
  #![allow(unused_imports)]
  ```
- **问题机理**：
  在生产源码文件顶部声明全局 `#![allow(unused_imports)]`，直接掩盖了重构和模块拆分后遗留的无用依赖导入（如未使用到的 trait、宏和数据结构），违背了 Rust 严谨的编译检查纪律。

---

### 3.3 跨 crate 类型定义重复与同义包装层冗余

- **排查清单**：
  1. **思考档位枚举双重定义**：
     - `crates/session-loop/src/provider.rs:16-77` 定义了 `ReasoningEffort`；
     - `crates/agent-provider/src/request/vendor.rs` 中同样定义了 `ReasoningEffort`；
     - 在 `session-loop/src/provider.rs:207-229` 还专门写了单测来比对两边的字面量是否一致，属于不必要的跨模块重复定义。
  2. **`ToolSchema` 冗余中间投影**：
     - `crates/session-loop/src/provider.rs:159-178` 定义了 `ToolSchema`，其本质只是从 `agent_tools::definition::ToolDefinition` 提取 `name`, `description`, `input_schema`。两处结构极其重叠，增加了多次内存分配与克隆。
  3. **静态字符串包装模块**：
     - `crates/session-loop/src/checkpoint.rs` 仅导出一个返回固定提示词字符串的函数 `checkpoint_prompt_section()`，没有承载任何真正的状态机或解析逻辑，单独占据一个模块文件属于过度拆分。

---

## 四、测试有效性与虚假/弱化断言清单

### 4.1 自比同义反复测试（Tautological Assertion）

- **缺陷位置**：
  - `crates/session-loop/src/checkpoint.rs:52-55`
- **代码片段**：
  ```rust
  /// 内容稳定：两次调用字节一致（快照断言面）
  #[test]
  fn prompt_section_is_stable() {
      assert_eq!(checkpoint_prompt_section(), checkpoint_prompt_section());
  }
  ```
- **批判**：
  `checkpoint_prompt_section()` 返回的是一个字符串字面量 `&'static str`。将一个无副作用的纯函数返回值与自身进行比较（`f() == f()`），在逻辑上是**绝对真命题（Tautology）**。此测试永远不可能失败，属于毫无测试价值的虚假测试。

---

### 4.2 无意义字段自赋值假测试（No-op Struct Field Test）

- **缺陷位置**：
  - `crates/session-loop/tests/live_sink_and_self_healing.rs:315-329`
- **代码片段**：
  ```rust
  #[test]
  fn test_ut_d01_09_toolexecctx_background_and_log_root_fields() {
      use session_loop::ToolExecCtx;

      let log_root = PathBuf::from("/tmp/conex-logs");
      let ctx = ToolExecCtx {
          run_id: "r1".into(),
          session_id: "s1".into(),
          log_root: Some(log_root.clone()),
          ..Default::default()
      };

      assert_eq!(ctx.log_root, Some(log_root));
      assert!(ctx.background.is_none());
  }
  ```
- **批判**：
  该测试手动构建了一个 `ToolExecCtx` 结构体，并断言自己刚刚赋的值等于自己刚刚赋的值。它没有测试任何将 `ToolExecCtx` 传递给 `ToolExecutor`、进而透传给底层工具或验证 `log_root` 是否真实生效的逻辑，属于纯粹凑测试数量的无效用例。

---

### 4.3 压测中基于 Mock 的假“无孤儿/PTY 句柄释放”断言

- **缺陷位置**：
  - `crates/orchestrator/tests/stress_concurrent_runs.rs:722-915` (`stress_kill_all_cascade_no_orphans`)
- **批判**：
  - 测试用例名称为 `stress_kill_all_cascade_no_orphans`，并在日志中输出：
    `"活跃 PTY / 孤儿句柄泄漏: 0 (100% 干净释放)"`；
  - 但整个测试底层使用的是 `MockCanceller`，其释放逻辑只是把内存中的 `AtomicBool` 设为 `true`；
  - 这种测试无法验证在真实的 Windows 环境下当 `kill_all` 被调用时，由子 Agent 启动的 ConPTY 终端、`pwsh.exe` 进程树或后台守护进程是否真正收到了终止信号，形成了**虚假的安全感**。

---

### 4.4 工具执行测试中普遍弱化的 `.is_ok()` 断言

- **缺陷位置**：
  - `crates/session-loop/src/tool_exec_tests.rs:248, 279, 339, 434, 461, 520, 567, 749, 787, 818, 845, 968, 1331, 1380, 1468, 1987, 2050, 2083, 2276, 2745, 2871, 2916, 2988, 3322`
- **批判**：
  在 `tool_exec_tests.rs` 中，超过 20 处测试断言仅使用 `assert!(out.results[i].is_ok())` 或 `assert!(out.results.iter().all(|r| r.is_ok()))`。
  它们完全没有对返回的具体输出内容、生成的产物（Artifact）、工具的 JSON 结构体格式以及状态变更进行深度匹配。当工具内部返回了空的、错误的甚至截断的数据结构时，只要外层封装是 `Ok`，测试就会一路绿灯放行。

---

## 五、综合整改与重构行动建议清单

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   内核全盘审计发现缺陷与建议重构矩阵                        │
├──────┬────────────────────────────────┬──────────┬──────────────────────────┤
│ 编号 │ 核心问题定位                   │ 风险等级 │ 架构整改建议             │
├──────┼────────────────────────────────┼──────────┼──────────────────────────┤
│ 1    │ ToolPromiseDetector UTF-8 切片 │ CRITICAL │ 改用 .char_indices() 安全│
│      │ 索引可能落在多字节字符中间导致 │ (高危崩溃│ 截断；补充英文与代码块   │
│      │ 运行时 Panic                   │ 隐患)    │ 场景的多语言正向匹配     │
├──────┼────────────────────────────────┼──────────┼──────────────────────────┤
│ 2    │ LiveEventSink 广播严重不对称， │ HIGH     │ 统一事件发射出口，将     │
│      │ 运行时错误/压缩/干预事件漏发； │ (状态机  │ RuntimeError/压缩等完整  │
│      │ ToolStart 双发与中间事件阻塞   │ 观测缺陷)│ 接入 LiveTrack；修复双发 │
├──────┼────────────────────────────────┼──────────┼──────────────────────────┤
│ 3    │ Run 级延迟持久化导致执行中途崩 │ HIGH     │ 引入增量事件持久化流，关 │
│      │ 溃时所有内存事件流全部永久丢失 │ (持久化  │ 键中间态事件即时落盘，防 │
│      │                                │ 恢复缺陷)│ 止崩溃丢失上下文         │
├──────┼────────────────────────────────┼──────────┼──────────────────────────┤
│ 4    │ ApprovalChannel 使用 50ms 轮询 │ MEDIUM   │ 彻底拔除 sleep 轮询，改  │
│      │ 休眠等待中止信号               │ (性能与  │ 为基于 Notify/Channel 的 │
│      │                                │ 架构违规)│ 纯异步反应式等待         │
├──────┼────────────────────────────────┼──────────┼──────────────────────────┤
│ 5    │ 存在挂起未调用的 dead_code、   │ LOW      │ 彻底清理无用代码与       │
│      │ 全局 allow(unused_imports) 与  │ (代码    │ 冗余类型，收敛跨 crate   │
│      │ 跨 crate 重复枚举定义          │ 冗余)    │ 重复定义                 │
├──────┼────────────────────────────────┼──────────┼──────────────────────────┤
│ 6    │ 存在自比测试、无意义自赋值测试 │ MEDIUM   │ 废除无效虚假测试，强化   │
│      │ 与基于 Mock 的假进程泄漏断言   │ (测试    │ 工具执行返回值断言与真实 │
│      │                                │ 资产缺陷)│ 进程树终止验证           │
└──────┴────────────────────────────────┴──────────┴──────────────────────────┘
```
