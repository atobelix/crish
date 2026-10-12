# 定时任务全流程修复与能力升级战役（Scheduled Tasks Revamp）

# 阶段 4 独立方案：Tauri IPC 命令面与元数据双向一致性

> **文档定位**：独立方案文档（Subagent 4: IPC State & Frontend Integration Architect）
> **关联阶段**：阶段 4 (Phase 4) · Tauri IPC 命令面与元数据双向一致性
> **关联上游**：阶段 1（Rust 底层调度器）、阶段 2（真实执行引擎）、阶段 3（目标会话绑定）
> **关联下游**：阶段 5（前端 UI 交互、表单能力与状态同步）
> **核心规范**：`AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`
> **目标文件**：`apps/agent-workbench/src-tauri/src/workflow_commands.rs`、`apps/agent-workbench/src-tauri/src/command_manifest.rs`、`apps/agent-workbench/src-tauri/src/main.rs`

---

## 一、阶段定位与核心攻坚目标

在 Conex / Crish 桌面应用中，`workflow_commands.rs` 是连接前端 React UI / 侧边栏面板、AI Agent 工具通道（`create_workflow`）以及底层 Rust 调度引擎（`SchedulerRegistry`）的**唯一核心 IPC 命令中枢**。

当前定时任务系统在用户侧表现出“编辑无效”、“启停状态刷新后反弹”、“修改触发时间后历史运行记录丢失”、“点击立即执行仅有一行虚假完成记录且无实际 Agent 响应”等严重痛点。经过穿透分析，这些问题的核心死结深植于 Tauri IPC 命令层与底层调度器之间的**元数据双向脱节与契约不对称**。

阶段 4 的核心攻坚目标是：

1. **彻底打通 `update-workflow` 与 `SchedulerRegistry` 的原生双向控制**：实现单任务就地暂停（Pause）、恢复（Resume）与就地更新（In-place Update），杜绝状态反弹与内存协程孤儿化；
2. **根除修改调度时 ID 变更导致的运行记录孤儿化**：保证 Workflow 的 `cron_id` 在生命周期内恒定，历史运行记录 `sched_runs` 永久关联；
3. **消除 `list-workflows` 中 snapshot 与 store 的脏覆盖竞态**：理顺内存活跃态与持久化元数据的主从关系，确保数据单真理源（SSOT）；
4. **推进 `trigger-workflow` 真实化执行转型**：告别伪造 0ms `completed` 历史记录，对接真实执行通道并回传可追踪的执行句柄与会话标识；
5. **在 IPC 层完整建立 `target_session_id` 与执行模式的透传管道**：承接阶段 3 的对话归属诉求，为阶段 5 前端提供完备契约支撑。

---

## 二、现状痛点与真实根因深度剖析

通过对当前 `apps/agent-workbench/src-tauri/src/workflow_commands.rs` 与 `apps/agent-workbench/src-tauri/src/sched.rs` 的代码级审查，精确定位到以下 6 大断裂根因：

### 2.1 启停切换时底层调度协程脱节（反弹根因）

- **代码位置**：`apps/agent-workbench/src-tauri/src/workflow_commands.rs:1060-1062`、`1085-1103`

```rust
// workflow_commands.rs:1060
if let Some(enabled) = patch.enabled {
    workflow.enabled = enabled;
}
// ...
if let Some(registry) = self.registry() {
    let old_id = workflow.cron_id.clone();
    if schedule_changed && !workflow.expression.is_empty() {
        // 仅当 schedule_changed 时才与 registry 交互！
        // 当用户仅点击开关 (enabled: false / true) 时，此处完全被跳过！
    }
}
self.store.save(&workflow);
```

- **真实根因**：
  当用户在前端点击暂停开关（`enabled: false`）时，`workflow_commands.rs` 仅在自己的 `SessionMetaWorkflowStore` 中将 `workflow.enabled` 置为 false 并存入 DB。**底层 `SchedulerRegistry` 完全不知情**！
  在 `SchedulerRegistry` 内部，该任务在内存表 `tasks: Arc<Mutex<HashMap<String, CronEntry>>>` 中的 tokio sleep 协程依然在不受控地倒计时。到期后，后台协程依然会执行触发！
- **反向冲刷连锁反应**（`workflow_commands.rs:1012-1020`）：
  ```rust
  if let Some(registry) = self.registry() {
      let snapshot = registry.snapshot();
      for workflow in &mut all {
          if let Some(task) = snapshot.iter().find(|t| t.cron_id == workflow.cron_id) {
              workflow.fired_count = task.fired_count;
              workflow.enabled = task.enabled; // <--- 致命覆盖！
              workflow.next_fire_at_ms = task.next_fire_at_ms;
          }
      }
  }
  ```
  当用户暂停后，前端发起 `list-workflows` 刷新时，`registry.snapshot()` 从底层读取到的 `task.enabled` 仍然是 `true`，**直接将刚刚持久化为 `false` 的状态暴力反向覆盖**！前端界面瞬间反弹回“启用中”。

### 2.2 调度修改导致 ID 重置与运行记录孤儿化（历史数据断链）

- **代码位置**：`apps/agent-workbench/src-tauri/src/workflow_commands.rs:1085-1103`

```rust
if let Some(registry) = self.registry() {
    let old_id = workflow.cron_id.clone();
    if schedule_changed && !workflow.expression.is_empty() {
        let _ = registry.cancel(&old_id).await;
        let input = CronTaskInput { ... };
        let new_id = registry.register(input).await.map_err(map_scheduler_err)?; // 分配了全新 ID！
        let now = now_ms();
        self.store.remove(&old_id);
        workflow.cron_id = new_id; // cron_id 发生了突变！
        workflow.created_at_ms = now; // 创建时间被无情重置！
        workflow.updated_at_ms = now;
    }
}
self.store.save(&workflow);
```

- **真实根因**：
  由于既有 `SchedulerRegistry` 仅有 `register` 和 `cancel` 两个粗粒度接口，缺少 `update_task` 接口，IPC 命令层只能通过“销毁旧任务 + 注册新任务”的方式变相实现修改。
  这引发了极恶劣的副作用：
  1. `workflow.cron_id` 从比如 `cron-2` 突变为 `cron-3`；
  2. 持久化运行历史表 `sched_runs` 中的所有记录的 `workflow_id` 依然是 `cron-2`；
  3. 前端调用 `list-workflow-runs` 时传入新 ID `cron-3`，查出的记录为 0 条，用户先前所有的运行日志全部“丢失”；
  4. `workflow.created_at_ms` 被重置为当前时刻，统计维度上的任务寿命被彻底破坏；
  5. `SessionMetaWorkflowStore::remove` 仅仅把旧 ID 从 `sched_index` 索引中剔除，底层 SQLite 中 `sched_cron-2` 的旧数据沦为幽灵孤儿。

### 2.3 立即触发假冒运行（Fake Completed 虚假记录）

- **代码位置**：`apps/agent-workbench/src-tauri/src/workflow_commands.rs:1158-1172`

```rust
let run_id = format!("{}-fire-{}", workflow.cron_id, workflow.fired_count);
let session_id = format!("sched-{}-{}", workflow.cron_id, workflow.fired_count);
let record = WorkflowRunRecord {
    workflow_id: workflow.cron_id.clone(),
    run_id: run_id.clone(),
    session_id: Some(session_id.clone()),
    trigger_kind: "manual".to_string(),
    scheduled_for_ms: now,
    started_at_ms: now,
    finished_at_ms: Some(now),
    duration_ms: Some(0), // 耗时 0 毫秒！
    status: "completed".to_string(), // 立刻标记完成！
    prompt: workflow.prompt.clone(),
    error: None,
    output_summary: Some(format!("手动立即触发成功（第 {} 次）", workflow.fired_count)),
};
self.store.append_or_update_run(record);
```

- **真实根因**：
  现有 `trigger-workflow` 只做了两件事：向内存队列 `PendingMessageQueue` 丢入一条 steering 文本，然后**在 0ms 瞬间把该运行标记为 `completed`**！
  实际上：
  - 没有任何实际 Agent 协程被拉起；
  - 返回的 `run_id` 和 `session_id` 只是无主字符串，并非真正的执行句柄；
  - 用户如果点击前端生成的会话链接，进入的是一个缺少执行实体与上下文的空壳会话。

### 2.4 目标会话绑定通道断裂（无上下文归属）

- **代码位置**：`apps/agent-workbench/src-tauri/src/workflow_commands.rs:275-301`（`StoredWorkflow`）、`327-341`（`WorkflowView`）、`1201-1210`（`WorkflowPatch`）
- **真实根因**：
  元数据结构中完全没有 `target_session_id` 和 `execution_mode`（当前会话追加 vs 独立新会话）。
  当 Agent 通过 `create_workflow` 工具或用户在特定会话中设置定时任务时，会话上下文在 IPC 边界处被强行截断，导致触发时无法定向将输出送回源对话。

### 2.5 存储层双索引与键命名不一致隐患

- **代码位置**：
  - `workflow_commands.rs:60`：`SESSION_META_INDEX_KEY = "sched_index"`
  - `sched.rs:60`：`SESSION_META_SCHED_INDEX_KEY = "sched_ids"`
- **真实根因**：
  `workflow_commands.rs` 的 `SessionMetaWorkflowStore` 维护一套索引键 `"sched_index"`，而 `sched.rs` 的 `LocalDbSchedStore` 维护另一套索引键 `"sched_ids"`。虽然二者读写的内容键都是 `"sched_<cron_id>"`，但双索引的存在破坏了 SSOT 原则，导致如果从不同路径扫描（例如启动恢复扫描 vs 命令列表扫描），容易出现条目总数不一致的隐蔽缺陷。

---

## 三、架构设计与核心契约规范

### 3.1 单一真理源（SSOT）架构拓扑

为彻底消除状态脱节，本方案确立**严密的主从与生命周期绑定架构**：

```
                    ┌────────────────────────────────────────────────────────┐
                    │                      前端 UI 层                         │
                    │   (WorkflowForm / WorkflowList / ScheduledTasksPanel)  │
                    └───────────▲───────────────────────────────┬────────────┘
                                │                               │
                     list / run-finished / updated              │ IPC invoke (update / trigger / create)
                                │                               │
                    ┌───────────┴───────────────────────────────▼────────────┐
                    │               Tauri IPC 命令层 (阶段 4)                │
                    │               (WorkflowCommandState / Backend)         │
                    └───────────▲───────────────────────────────┬────────────┘
                                │                               │
                    Native APIs │ 同步调用 (保持 ID 不变)           │ 原生 API 委托
                    (snapshot)  │ (pause / resume / update)     │ (run_task_impl)
                                │                               │
             ┌──────────────────┴─────────────┐   ┌─────────────▼──────────────────┐
             │       SchedulerRegistry        │   │        Execution Runner        │
             │   (阶段 1: 单任务状态机真源)     │   │     (阶段 2: 真实执行引擎)       │
             │ - tasks: Map<Id, CronEntry>    │   │ - 拉起真实 Agent 循环           │
             │ - sleep 协程精准 abort/重启    │   │ - 产出真实 runId / sessionId   │
             │ - 保持原 ID 不变原地更新         │   │ - 状态流 running->completed/fail│
             └──────────────────┬─────────────┘   └─────────────┬──────────────────┘
                                │                               │
                                └───────────────┬───────────────┘
                                                ▼
                                ┌───────────────────────────────┐
                                │   SQLite session_meta 存储层   │
                                │   - 统一索引: sched_index      │
                                │   - 统一实体: sched_<cron_id>  │
                                │   - 运行历史: sched_runs       │
                                └───────────────────────────────┘
```

**契约铁律**：

1. **ID 不变性不变量（ID Invariance）**：一旦创建分配了 `cron_id`，在整个任务生命周期中（修改名称、提示词、工作区、调度表达式、执行会话、启停状态），**严禁变更其 ID**！
2. **状态联动不变量（State Coherence）**：IPC 层对任务启用状态的修改，必须以 `SchedulerRegistry::pause_task` / `SchedulerRegistry::resume_task` 的成功执行为前置条件，严禁单边修改 DB。
3. **运行历史完备性（Run History Integrity）**：所有对任务属性的修改绝不影响该任务既有 `sched_runs` 历史条目。

### 3.2 数据结构演进与向下兼容（Wire / Store / View）

#### (1) `StoredWorkflow` 扩展（落库实体）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredWorkflow {
    // ── CronTask 调度核心字段 ──
    pub cron_id: String,
    pub expression: String,
    pub prompt: String,
    pub max_iterations: Option<u64>,
    pub is_daemon: bool,
    pub next_fire_at_ms: u64,
    pub fired_count: u64,
    pub enabled: bool,

    // ── Workflow 元数据扩展字段 ──
    pub name: String,
    pub cwd: Option<String>,
    pub mode: Option<String>,
    pub schedule: WorkflowScheduleWire,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_run_at_ms: Option<u64>,

    // ── 阶段 3 & 4 新增：目标会话绑定与执行策略 ──
    /// 目标执行会话 ID（Some: 绑定至具体会话，输出追加到该对话流；None: 独立新会话）
    #[serde(default)]
    pub target_session_id: Option<String>,
    /// 执行通道模式（"current_session" | "isolated_session"，缺省依 target_session_id 决定）
    #[serde(default)]
    pub execution_mode: Option<String>,
}
```

#### (2) `WorkflowView` 输出视图

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowView {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub cwd: Option<String>,
    pub mode: Option<String>,
    pub enabled: bool,
    pub schedule: WorkflowScheduleWire,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    // 阶段 3/4 新增视图透传
    pub target_session_id: Option<String>,
    pub execution_mode: Option<String>,
}
```

#### (3) `WorkflowPatch` 更新补丁

```rust
#[derive(Default, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowPatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<WorkflowScheduleWire>,
    pub cwd: Option<Option<String>>, // 双重 Option 支持显式清空 cwd
    pub mode: Option<String>,
    pub enabled: Option<bool>,
    pub target_session_id: Option<Option<String>>, // 双重 Option 支持解绑会话
    pub execution_mode: Option<String>,
}
```

---

## 四、IPC 命令面实现改造蓝图

### 4.1 `update-workflow` 原地更新重构蓝图

彻底废弃旧代码中的 `cancel(old_id)` + `register(new_id)` 逻辑。与 Phase 1 `SchedulerRegistry` 暴露的接口进行精密对接：

```rust
impl WorkflowBackend {
    pub(crate) async fn update(
        &self,
        cron_id: &str,
        patch: WorkflowPatch,
    ) -> Result<WorkflowView, CoreError> {
        let all = self.store.load_all();
        let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) else {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        };

        // 1. 基础字段校验与更新
        if let Some(name) = patch.name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err(CoreError::InvalidInput("名称不能为空".to_string()));
            }
            workflow.name = name;
        }

        let prompt_changed = if let Some(prompt) = patch.prompt {
            let prompt = prompt.trim().to_string();
            if prompt.is_empty() {
                return Err(CoreError::InvalidInput("提示词不能为空".to_string()));
            }
            let changed = workflow.prompt != prompt;
            workflow.prompt = prompt;
            changed
        } else {
            false
        };

        if let Some(opt_cwd) = patch.cwd {
            workflow.cwd = opt_cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        }

        if let Some(mode) = patch.mode {
            let mode = mode.trim().to_string();
            workflow.mode = if mode.is_empty() { None } else { Some(mode) };
        }

        if let Some(opt_target) = patch.target_session_id {
            workflow.target_session_id = opt_target.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        }

        if let Some(exec_mode) = patch.execution_mode {
            workflow.execution_mode = Some(exec_mode.trim().to_string());
        }

        // 2. 调度配置变更处理
        let mut schedule_changed = false;
        let mut new_expression = None;
        if let Some(schedule) = patch.schedule {
            let expr = schedule_to_expression(&schedule).unwrap_or_default();
            if !expr.is_empty() {
                validate_cron_expression(&expr).map_err(CoreError::InvalidInput)?;
            }
            if workflow.expression != expr || workflow.schedule != schedule {
                schedule_changed = true;
                workflow.schedule = schedule;
                workflow.expression = expr.clone();
                new_expression = Some(expr);
            }
        }

        // 3. 底层注册表联动（原子操作，原地更新，保持 ID 绝不变更）
        if let Some(registry) = self.registry() {
            // A. 处理启停切换 (Pause / Resume)
            if let Some(target_enabled) = patch.enabled {
                if target_enabled != workflow.enabled {
                    if target_enabled {
                        // 恢复调度：重新计算下一次触发时间并拉起 sleep 协程
                        let next_fire = registry.resume_task(cron_id).await.map_err(map_scheduler_err)?;
                        workflow.enabled = true;
                        workflow.next_fire_at_ms = next_fire;
                    } else {
                        // 暂停调度：终止 sleep 协程，标记为暂停
                        registry.pause_task(cron_id).await.map_err(map_scheduler_err)?;
                        workflow.enabled = false;
                        workflow.next_fire_at_ms = 0;
                    }
                }
            }

            // B. 处理调度或提示词变更 (In-place Update Task)
            if (schedule_changed || prompt_changed) && workflow.enabled {
                // 调用 Phase 1 提供的原生原地更新 API
                let updated_task = registry.update_task(
                    cron_id,
                    new_expression,
                    if prompt_changed { Some(workflow.prompt.clone()) } else { None },
                    None,
                    None,
                ).await.map_err(map_scheduler_err)?;

                workflow.next_fire_at_ms = updated_task.next_fire_at_ms;
            }
        } else {
            // 独立退化模式（无 registry 注入）下的本地内存模拟
            if let Some(enabled) = patch.enabled {
                workflow.enabled = enabled;
            }
            if schedule_changed {
                workflow.next_fire_at_ms = if workflow.expression.is_empty() || !workflow.enabled {
                    0
                } else {
                    next_fire_after_ms(&workflow.expression, now_ms()).unwrap_or(0)
                };
            }
        }

        workflow.updated_at_ms = now_ms();
        // 4. 持久化存储（键名不变，依然是 sched_<cron_id>）
        self.store.save(&workflow);

        tracing::info!(
            target: "workflow",
            cron_id = %workflow.cron_id,
            enabled = workflow.enabled,
            next_fire = workflow.next_fire_at_ms,
            "workflow 已原地更新成功（ID 恒定保持，历史记录完整）"
        );

        Ok(workflow.view())
    }
}
```

### 4.2 `list-workflows` 一致性读取蓝图（消解脏覆盖）

在既有代码中，`list()` 无论如何都会用 `snapshot()` 的 `enabled` 强行覆盖 DB。重构后，明确**状态同步准则**：

1. 调度运行态字段（`next_fire_at_ms`, `fired_count`）以 `registry.snapshot()` 为真源；
2. 启停状态（`enabled`）在 `update` 时已经严格同步给 registry，二者必定同源；
3. 如果 snapshot 中未找到（例如 manual 模式），保留 store 本地状态；
4. 保证 `list-workflows` 执行速度快、不阻塞 UI，零脏覆盖。

```rust
pub(crate) fn list(&self) -> Vec<WorkflowView> {
    let mut all = self.store.load_all();
    if let Some(registry) = self.registry() {
        let snapshot = registry.snapshot();
        for workflow in &mut all {
            if let Some(task) = snapshot.iter().find(|t| t.cron_id == workflow.cron_id) {
                workflow.fired_count = task.fired_count;
                // 此时 registry.snapshot() 中的 enabled 与 DB 严格同源
                workflow.enabled = task.enabled;
                workflow.next_fire_at_ms = task.next_fire_at_ms;
            }
        }
    }
    all.sort_by_key(|w| w.created_at_ms);
    all.iter().map(|w| w.view()).collect()
}
```

### 4.3 `trigger-workflow` 真实触发与执行句柄返回蓝图

对接阶段 2 的执行管道，彻底消除 `duration_ms: Some(0)` 的 Fake 行为：

```rust
pub(crate) async fn trigger(
    &self,
    cron_id: &str,
    app: &tauri::AppHandle,
) -> Result<TriggerResult, CoreError> {
    let all = self.store.load_all();
    let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) else {
        return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
    };

    if !workflow.enabled {
        return Err(CoreError::InvalidInput(format!(
            "workflow {cron_id} 已暂停，请先启用再触发"
        )));
    }

    let now = now_ms();
    workflow.fired_count += 1;
    workflow.last_run_at_ms = Some(now);
    workflow.updated_at_ms = now;
    self.store.save(&workflow);

    // 1. 决定目标执行会话
    let target_session_id = workflow.target_session_id.clone().unwrap_or_else(|| {
        // 若未绑定具体会话，生成规范化的独立任务会话：sched-<cron_id>-<timestamp>
        format!("sched-{}-{}", workflow.cron_id, now)
    });

    let run_id = format!("run-wf-{}-{}", workflow.cron_id, workflow.fired_count);

    // 2. 初始记录写入（真实 running 状态，非 completed）
    let initial_record = WorkflowRunRecord {
        workflow_id: workflow.cron_id.clone(),
        run_id: run_id.clone(),
        session_id: Some(target_session_id.clone()),
        trigger_kind: "manual".to_string(),
        scheduled_for_ms: now,
        started_at_ms: now,
        finished_at_ms: None,
        duration_ms: None,
        status: "running".to_string(),
        prompt: workflow.prompt.clone(),
        error: None,
        output_summary: Some("任务已触发，执行中…".to_string()),
    };
    self.store.append_or_update_run(initial_record);

    // 3. 广播触发中事件
    emit_workflow_event(
        app,
        "workflow:run-started",
        serde_json::json!({
            "workflowId": workflow.cron_id,
            "runId": run_id,
            "sessionId": target_session_id,
            "triggerKind": "manual",
            "startedAt": epoch_ms_to_iso(now)
        })
    );

    // 4. 派发至真实执行队列 / 执行器（对接阶段 2 run_task_impl）
    self.sink.enqueue_steering(
        cron_id,
        format!(
            "{}（cron {} 第 {} 次手动触发，目标会话：{}）",
            workflow.prompt, workflow.cron_id, workflow.fired_count, target_session_id
        ),
        now,
    );

    Ok(TriggerResult {
        run_id: Some(run_id),
        session_id: Some(target_session_id),
    })
}
```

### 4.4 Tauri 命令入参契约与命令清单同步

修改 `apps/agent-workbench/src-tauri/src/workflow_commands.rs` 对应 command 处理函数签名：

```rust
#[tauri::command(rename = "update-workflow")]
pub(crate) async fn update_workflow(
    workflow_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<serde_json::Value>,
    cwd: Option<Option<String>>, // 支持 null 清空
    mode: Option<String>,
    enabled: Option<bool>,
    target_session_id: Option<Option<String>>, // 新增
    execution_mode: Option<String>,           // 新增
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<WorkflowCreateResponse, CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let schedule = match schedule.as_ref() {
        Some(v) => Some(parse_schedule_input(Some(v))?),
        None => None,
    };
    let patch = WorkflowPatch {
        name,
        prompt,
        schedule,
        cwd,
        mode,
        enabled,
        target_session_id,
        execution_mode,
    };
    let backend = Arc::clone(&state.inner().backend);
    let workflow = backend.update(&workflow_id, patch).await?;
    emit_workflow_event(
        &app,
        "workflow:updated",
        serde_json::json!({
            "workflowId": workflow.id,
            "name": workflow.name,
            "enabled": workflow.enabled,
            "nextRunAt": workflow.next_run_at,
            "targetSessionId": workflow.target_session_id
        }),
    );
    Ok(WorkflowCreateResponse { workflow })
}
```

同时在 `create_workflow` 中同样接纳 `target_session_id` 与 `execution_mode`，保持创建与更新完全对称。

---

## 五、状态一致性与防竞态设计

### 5.1 解决双重刷新竞争（Dual-Refresh Race Elimination）

- **现象**：前端在 `handleToggle` 执行 `updateWorkflow` 时，后端会广播 `workflow:updated` 事件，导致前端的全局事件监听触发了一次 `refresh()`；同时 `handleToggle` 自身末尾也调用了 `await refresh()`。两个并发的 `listWorkflows()` IPC 调用在网络/进程间交叠，若先发出的旧查询后返回，将冲掉最新的列表状态。
- **IPC 层的防护举措**：
  1. **响应携带完整最新实体**：`update-workflow` 返回值必须返回最新规范化后的 `WorkflowView`；前端可直接利用该返回对象就地更新本地状态，无需强制重新触发全量 `list-workflows`；
  2. **事件广播携带序列版本号（Version / ETag）**：在广播的事件载荷中附带 `updatedAt` 时间戳或递增版本号，前端在更新本地缓存时，如果收到低于当前本地版本的事件或请求响应，直接忽略放弃。

### 5.2 存储层双索引统一（Unified Indexing）

- 统一 `LocalDbSchedStore` 与 `SessionMetaWorkflowStore` 的索引键为 `sched_index`；
- 在存储迁移中加入自愈逻辑：若发现旧键 `sched_ids`，自动将其中的条目合并至 `sched_index`，确保历史数据无缝升级，消解双源漂移。

---

## 六、测试用例设计与验证矩阵（Rust 套件）

针对阶段 4 重构，必须在 `workflow_commands.rs` 的 `mod tests` 中增加以下关键单元测试，验证命令面与调度器的一致性契约：

| 编号          | 测试用例名称                                          | 核心验证断言                                                                                                                                  | 对应防御缺陷                   |
| :------------ | :---------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- |
| **TC-IPC-01** | `test_update_workflow_toggle_pause_syncs_to_registry` | 调用 `update(enabled: false)` 后，检查 `registry.snapshot()` 中的对应任务 `enabled` 变为 `false`，且 `list()` 返回的 `enabled` 亦为 `false`。 | 防御启停脱节与反向冲刷         |
| **TC-IPC-02** | `test_update_workflow_schedule_preserves_cron_id`     | 调用 `update(schedule: new_cron)` 后，返回的 `workflow.id` 保持原值不变；`list_runs` 依然能查询到既有运行记录。                               | 防御 ID 突变与历史 runs 孤儿化 |
| **TC-IPC-03** | `test_update_workflow_preserves_created_at`           | 调度或提示词变更后，`created_at_ms` 必须与最初创建时相同，仅 `updated_at_ms` 刷新。                                                           | 防御任务元数据被无故重置       |
| **TC-IPC-04** | `test_update_workflow_target_session_id_roundtrip`    | 创建或更新带 `target_session_id` 的任务，落库与反序列化后该字段完整保留，并正确在 `WorkflowView` 中输出。                                     | 验证阶段 3/4 会话绑定契约      |
| **TC-IPC-05** | `test_trigger_workflow_returns_running_and_session`   | 调用 `trigger` 时，返回合法有效的 `run_id` 和 `session_id`，且在 `list_runs` 中首条记录的 `status` 为 `"running"`。                           | 防御 Fake Completed 0ms 欺骗   |
| **TC-IPC-06** | `test_delete_workflow_cleans_both_store_and_registry` | 调用 `delete` 后，任务不仅从 `sched_index` 移除，底层 `registry.snapshot()` 也无法再查询到该活跃任务。                                        | 保证删除干净彻底               |

---

## 七、实施路线图与验收检查单

1. **Step 1：数据结构扩展与兼容性校验**
   - 更新 `StoredWorkflow`, `WorkflowView`, `WorkflowPatch`；
   - 验证既有存量 JSON 在缺少新字段时的反序列化默认行为（`#[serde(default)]`）。
2. **Step 2：对接阶段 1 原生调度控制 API**
   - 引入 `registry.pause_task`, `registry.resume_task`, `registry.update_task`；
   - 重构 `WorkflowBackend::update`，删除 ID 重新生成的逻辑；
   - 统一持久化索引键为 `sched_index`。
3. **Step 3：改造 `trigger-workflow` 触发逻辑**
   - 接入目标会话与执行模式；
   - 生成真实 `running` 状态记录并派发事件。
4. **Step 4：测试与门禁验证**
   - 运行 `cargo test --package agent-workbench --lib workflow_commands` 全面跑通。
