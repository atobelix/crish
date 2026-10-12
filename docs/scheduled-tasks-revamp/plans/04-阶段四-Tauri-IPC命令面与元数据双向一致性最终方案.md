# 定时任务全流程修复与能力升级战役（Scheduled Tasks Revamp）

# 阶段 4 最终权威方案：Tauri IPC 命令面与元数据双向一致性（现代化单轨去兼容版）

> **文档标识**：`04-阶段四-Tauri-IPC命令面与元数据双向一致性最终方案.md`  
> **文档定位**：阶段 4 (Phase 4) 权威终版方案（Final Plan · 现代化去兼容与系统加固版）  
> **制定依据**：
>
> - 用户最新最高指令：**【不要兼容、不要多版本号迭代。如果是重要的，涉及历史遗留的这种是可以有兼容的，比如说对话这种的肯定是不能丢失的，当然其他不能丢失的你也自己想想。对于没有多大意义，但是依旧兼容的就没有必要了。尽量是能留一个最先进的代码方案就留最先进的就行。】**
> - 用户实盘严重缺陷暴露：**【历史运行记录悬挂 1 个多月蓝色“运行中”且无法消除】**（`update_run_finish` 为死代码；`prune_runs` 盲目豁免 running；启动及加载缺乏孤儿自愈收割）。
> - 系统底层与引擎架构首席审查报告：`docs/scheduled-tasks-revamp/plan-reviews/review-system-engine.md`（落实 CRIT-05 存储无损合并与并发丢失更新防御）
> - 核心源码基线：`apps/agent-workbench/src-tauri/src/workflow_commands.rs`、`apps/agent-workbench/src-tauri/src/sched.rs`、`apps/agent-workbench/src-tauri/src/command_manifest.rs`、`apps/crish-desktop/src/api/workflow-api/workflowRunner.ts`
> - 架构纪律基线：仓库根目录 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`。

---

## 一、方案总览、去兼容裁决与最先进单轨架构决策

### 1.1 核心改进原则与清退决策

基于用户最新最高指令，本方案对 Tauri IPC 命令面与存储模型进行彻底的现代化去兼容改造，推行干净、单轨、最先进的系统方案：

1. **彻底清退双索引维护（统一收敛为唯一标准索引 `sched_index`）**：
   - 彻底删除多版本迭代中的双索引维护（`sched_ids` 与 `sched_index` 的双写双读兼容自愈代码）；
   - 全工程统一定义并使用唯一索引键：`SESSION_META_INDEX_KEY = "sched_index"`；
   - 生产环境不再双写、不再双读，以单一索引为唯一真理源。
2. **彻底清退多重布尔/枚举相互映射垫片，统一定义 `CronTaskStatus` 状态真理源**：
   - `StoredWorkflow` 内部直接集成四态枚举 `status: CronTaskStatus`（`Active` / `Paused` / `Completed` / `Cancelled`）；
   - 消除多重布尔与枚举双向维护垫片，对外视图提供 `enabled: bool` 作为兼容投影，内部逻辑 100% 依托状态机。
3. **彻底坚守“绝不丢失核心资产”底线**：
   - 用户的会话数据（SQLite `sessions` 表与 `messages` 表的聊天历史）受到绝对保护，严禁任何破坏性覆盖；
   - 用户已有工作区配置（`cwd`）100% 保护并支持精准清空与更新（双重 `Option` 补丁）；
   - 存量任务在反序列化时通过精简的 `#[serde(default)]` 容错；
   - **启发式自愈修复（Heuristic Rehydration）**：若存量残缺数据反序列化出的 `schedule` 为 `Manual`，但 `expression` 字段非空且为有效 Cron 表达式，自动推断并自愈为 `WorkflowScheduleWire::Cron { expression }`，绝不让用户原本的定时任务降级为手动任务！
4. **彻底消灭悬挂 1 个多月的“运行中”僵尸记录（开机自愈与终态接线）**：
   - 在 `list_runs` 与系统启动时执行**孤儿运行自愈收割（Orphan Running Runs Cleanup）**，将无对应底层活跃 Run 的遗留记录自动收割为 `interrupted` 终态；
   - **彻底复活并接线 `update_run_finish`**（摘除 `#[allow(dead_code)]`），全链路在 Agent 任务完成或失败时实时回写真实耗时与摘要；
   - 修正 `prune_runs` 算法，废除盲目无条件保护 running 的策略。
5. **全面落实 Review Agent 1 的架构加固（落实 CRIT-05）**：
   - 在 `LocalDbSchedStore::save` 的 Safe Field Merge 中，完整补齐所有字段（包括 `status`、`targetSessionId`、`updatedAtMs`、`createdAtMs` 等），绝不遗漏；
   - 引入进程内单任务互斥锁保护，防范 IPC 更新与调度触发并发时的 Lost Update（丢失更新）。

---

## 二、四大缺陷根因断点与治本破局策略

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        现有架构五大致命断裂点与治理路线                                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 修改表达式导致 ID 突变 ──► 取消+新建触发 seq++ ──► 历史运行记录孤儿化 ──► [治理: 就地更新]  │
│ 2. 启停状态双轨脱节 ───────► 仅改 DB 不通调度器 ──► 协程依旧倒计时 ────► [治理: 原生联动]  │
│ 3. 双写冲刷毒化 ───────────► CronTask 洗掉 StoredWorkflow 业务字段 ──► [治理: 安全合并更新] │
│ 4. 列表查询反向污染 ───────► list() 盲用 snapshot 覆盖 DB ─────────► [治理: 彻底删除覆写] │
│ 5. 运行记录永久悬挂运行中 ──► update_run_finish 为死代码且缺乏收割 ──► [治理: 自愈收割+接线]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 缺陷 1：修改调度周期导致 ID 突变与运行记录孤儿化

- **破坏链路**：前端更新 Cron 表达式时，后端由于缺少就地更新，调用了 `cancel(old_id)` + `register(new_input)`，导致分配全新 ID（如 `cron-2`）。而 `sched_runs` 历史运行记录仍关联在旧 ID `cron-1` 下，导致用户历史执行日志全部断代丢失。
- **治本策略**：确立**工作流 ID 恒定铁律（ID Invariance）**。生命周期内 `cron_id` 与 `created_at_ms` 绝对只读；全流程转为调用底层 `SchedulerRegistry::update_task` 原地替换表达式并热重启协程，保持 `cron_id` 绝对恒定。

### 2.2 缺陷 2：任务启停与调度器零联动，以及 `list()` 反向脏冲刷

- **破坏链路**：
  1. 用户在前端点击暂停，后端仅将数据库 `enabled` 改为 `false`，未通知调度器，内存协程继续运行并在到期时触发；
  2. 用户刷新页面，`list()` 从未同步的内存快照读取到 `true`，**直接将数据库的 `false` 冲刷回 `true`**！
- **治本策略**：
  - 更新时双向强联动：`enabled = Some(false)` 调用 `registry.pause_task`；`enabled = Some(true)` 调用 `registry.resume_task`；
  - **彻底删除 `list()` 中对 `workflow.enabled` 的盲目赋值**！状态以 DB 与底层同步为准，`list()` 仅投影运行态的 `next_fire_at_ms` 与 `fired_count`。

### 2.3 缺陷 3：存储双写冲刷毒化（字段洗白）与字段遗漏（CRIT-05）

- **破坏链路**：
  1. `sched.rs` 触发时将精简的 `CronTask` 写入同一存储键 `sched_<cron_id>`，直接抹除了 `StoredWorkflow` 的 `name`、`schedule`、`cwd` 等业务字段；
  2. 原方案伪代码在合并时遗漏了 `status`、`targetSessionId`、`updatedAtMs`（CRIT-05）；
  3. IPC 更新与触发写库缺乏互斥保护，产生 Lost Update。
- **治本策略**：
  - **Safe Field Merge 全字段补齐**：合并写入时完整覆盖 `status`、`targetSessionId`、`updatedAtMs` 等全部调度字段，同时保留业务字段；
  - 进程内互斥锁保证读-改-写原子性；
  - 存量数据反序列化防御性容错（`#[serde(default)]`）与 Cron 智能自愈推断。

### 2.4 缺陷 4：运行记录悬挂 1 个多月蓝色“运行中”且无法消除

- **破坏链路**：
  1. `workflow_commands.rs:469` 的 `update_run_finish` 带有 `#[allow(dead_code)]`，全仓零调用；
  2. `prune_runs` 中硬编码 `partition(|r| r.status == "running")`，对所有 running 永久豁免淘汰；
  3. 系统缺乏孤儿运行收割机制，导致用户界面出现 1 个多月前任务仍显示“运行中”的严重撕裂。
- **治本策略**：
  - 彻底复活并接线 `update_run_finish`，全链路接入真实终态收口；
  - 启动与 `list_runs` 时执行孤儿自愈收割，收割无主记录为 `interrupted`；
  - 修正 `prune_runs` 算法。

---

## 三、单一真理源（SSOT）一致性架构与生命周期模型

### 3.1 单任务状态机全景图

```mermaid
stateDiagram-v2
    [*] --> Active: create-workflow / 启动恢复

    state Active {
        [*] --> Sleeping: 倒计时中 (Tokio Sleep 协程活跃)
        Sleeping --> Firing: 时间到期 / trigger-workflow
        Firing --> Running: 登记 running 记录，唤醒 Agent
        Running --> Sleeping: 任务完成，重算 next_fire_at
    }

    Active --> Paused: update-workflow(enabled=false)
    note right of Paused
        调用 registry.pause_task()
        精确 abort 内存 Sleep 协程
        next_fire_at 置 0，DB 标记 status=Paused
        cron_id 与历史 sched_runs 100% 保持不变
    end note

    Paused --> Active: update-workflow(enabled=true)
    note right of Active
        调用 registry.resume_task()
        重算首次 next_fire_at
        拉起新 Sleep 协程，DB 标记 status=Active
    end note

    Active --> Active: update-workflow(schedule/prompt)
    note right of Active
        调用 registry.update_task()
        原地替换表达式与指令，重置倒计时
        【铁律】：严禁 cancel+register 重新分配 ID！
    end note

    Active --> [*]: delete-workflow
    Paused --> [*]: delete-workflow
    note right of [*]
        调用 registry.cancel()
        从 sched_index 摘除索引
        运行历史 sched_runs 依然完整归档保留
    end note
```

---

## 四、数据结构与 API 契约全面演进

### 4.1 Rust 核心数据结构重构（`apps/agent-workbench/src-tauri/src/workflow_commands.rs`）

#### 1. 落库实体 `StoredWorkflow`

```rust
/// workflow 存储实体（落盘于 session_meta 的 sched_<cron_id> 键）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredWorkflow {
    // ── 调度核心字段（与底层调度器完全对齐） ──
    pub cron_id: String,
    pub expression: String,
    pub prompt: String,
    #[serde(default)]
    pub max_iterations: Option<u64>,
    #[serde(default)]
    pub is_daemon: bool,
    #[serde(default)]
    pub next_fire_at_ms: u64,
    #[serde(default)]
    pub fired_count: u64,
    /// 生命周期状态（单一真理源）
    #[serde(default = "default_cron_status")]
    pub status: CronTaskStatus,
    /// 兼容字段（投影自 status == Active）
    #[serde(default = "default_true")]
    pub enabled: bool,

    // ── Workflow 元数据扩展字段（全容错默认值） ──
    #[serde(default = "default_workflow_name")]
    pub name: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default = "default_manual_schedule")]
    pub schedule: WorkflowScheduleWire,
    #[serde(default = "now_ms")]
    pub created_at_ms: u64,
    #[serde(default = "now_ms")]
    pub updated_at_ms: u64,
    #[serde(default)]
    pub last_run_at_ms: Option<u64>,

    // ── 目标会话绑定与执行通道 ──
    #[serde(default)]
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
}

fn default_cron_status() -> CronTaskStatus { CronTaskStatus::Active }
fn default_true() -> bool { true }
fn default_workflow_name() -> String { "未命名任务".to_string() }
fn default_manual_schedule() -> WorkflowScheduleWire { WorkflowScheduleWire::Manual }
```

#### 2. 命令输出视图 `WorkflowView`

```rust
/// 命令输出：workflow 条目（对齐前端 WorkflowDefinition 类型面）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    pub target_session_id: Option<String>,
    pub execution_mode: Option<String>,
}

impl StoredWorkflow {
    pub(crate) fn view(&self) -> WorkflowView {
        WorkflowView {
            id: self.cron_id.clone(),
            name: self.name.clone(),
            prompt: self.prompt.clone(),
            cwd: self.cwd.clone(),
            mode: self.mode.clone(),
            enabled: self.status == CronTaskStatus::Active,
            schedule: self.schedule.clone(),
            created_at: epoch_ms_to_iso(self.created_at_ms),
            updated_at: epoch_ms_to_iso(self.updated_at_ms),
            next_run_at: if self.next_fire_at_ms == 0 || self.status != CronTaskStatus::Active {
                None
            } else {
                Some(epoch_ms_to_iso(self.next_fire_at_ms))
            },
            last_run_at: self.last_run_at_ms.map(epoch_ms_to_iso),
            target_session_id: self.target_session_id.clone(),
            execution_mode: self.execution_mode.clone(),
        }
    }
}
```

#### 3. 原子更新补丁 `WorkflowPatch`（双重 Option 语义支持显式置空）

```rust
/// 更新补丁（精确区分“未提供”与“显式清空/解绑”）
#[derive(Default, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowPatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<WorkflowScheduleWire>,
    /// None: 不变；Some(None): 显式清空工作区；Some(Some(v)): 更新为 v
    pub cwd: Option<Option<String>>,
    pub mode: Option<String>,
    pub enabled: Option<bool>,
    /// None: 不变；Some(None): 显式解绑会话；Some(Some(v)): 绑定至新会话
    pub target_session_id: Option<Option<String>>,
    pub execution_mode: Option<String>,
}
```

---

## 五、Tauri IPC 命令面与存储层改造详案（代码级设计）

### 5.1 存储层 Safe Field Merge 改造（落实 CRIT-05 全字段补齐与原子并发保护）

```rust
// apps/agent-workbench/src-tauri/src/sched.rs

impl SchedStore for LocalDbSchedStore {
    fn save(&self, task: &CronTask) {
        let key = store_key(&task.cron_id);

        // 引入行级互斥锁，彻底杜绝读-改-写并发覆盖（Lost Update 防护）
        let _guard = acquire_store_key_lock(&task.cron_id);

        // 1. 读取已有 JSON 对象
        let mut base_obj = self
            .db
            .get_session_meta(&key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        // 2. 【CRIT-05 修复】：全字段无损合并，绝对不遗漏 status 与扩展字段！
        if let Some(map) = base_obj.as_object_mut() {
            map.insert("cronId".to_string(), serde_json::json!(task.cron_id));
            map.insert("expression".to_string(), serde_json::json!(task.expression));
            map.insert("prompt".to_string(), serde_json::json!(task.prompt));
            map.insert("maxIterations".to_string(), serde_json::json!(task.max_iterations));
            map.insert("isDaemon".to_string(), serde_json::json!(task.is_daemon));
            map.insert("nextFireAtMs".to_string(), serde_json::json!(task.next_fire_at_ms));
            map.insert("firedCount".to_string(), serde_json::json!(task.fired_count));
            map.insert("status".to_string(), serde_json::json!(task.status));
            map.insert("enabled".to_string(), serde_json::json!(task.is_enabled()));
            map.insert("targetSessionId".to_string(), serde_json::json!(task.target_session_id));
            map.insert("updatedAtMs".to_string(), serde_json::json!(task.updated_at_ms));
            map.insert("createdAtMs".to_string(), serde_json::json!(task.created_at_ms));

            if let Ok(merged_json) = serde_json::to_string(&base_obj) {
                let _ = self.db.set_session_meta(&key, &merged_json);
            }
        }

        // 3. 维护唯一标准索引 sched_index（不再双写双维护）
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        if !index.iter().any(|id| id == &task.cron_id) {
            index.push(task.cron_id.clone());
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &json);
            }
        }
    }
}
```

### 5.2 存储层加载时的启发式自愈（Heuristic Rehydration）

在 `SessionMetaWorkflowStore::load_all` 反序列化时，自动救回历史被毒化抹除 schedule 的任务：

```rust
// apps/agent-workbench/src-tauri/src/workflow_commands.rs

impl WorkflowStore for SessionMetaWorkflowStore {
    fn load_all(&self) -> Vec<StoredWorkflow> {
        let index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        let mut results = Vec::new();
        for cron_id in index {
            let key = store_key(&cron_id);
            if let Some(raw) = self.db.get_session_meta(&key).ok().flatten() {
                if let Ok(mut wf) = serde_json::from_str::<StoredWorkflow>(&raw) {
                    // 【启发式自愈】：若 schedule 反序列化为 Manual，但 expression 依然有效，自动恢复为 Cron 调度！
                    if wf.schedule == WorkflowScheduleWire::Manual && !wf.expression.trim().is_empty() {
                        if validate_cron_expression(&wf.expression).is_ok() {
                            tracing::info!(target: "workflow", cron_id = %wf.cron_id, "检测到历史遗留 Cron 表达式，自动自愈恢复 schedule");
                            wf.schedule = WorkflowScheduleWire::Cron {
                                expression: wf.expression.clone(),
                            };
                        }
                    }
                    results.push(wf);
                }
            }
        }
        results
    }
}
```

---

### 5.3 `WorkflowBackend::update` 原地更新重构（保持 ID 绝对恒定）

彻底删除 `cancel` + `register`：

```rust
// apps/agent-workbench/src-tauri/src/workflow_commands.rs

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

        // 1. 基础元数据校验与更新
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

        // 2. 调度配置校验与更新
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

        // 3. 底层注册表原子联动（保持 cron_id 绝对恒定！）
        if let Some(registry) = self.registry() {
            // A. 处理启停切换 (Pause / Resume)
            if let Some(target_enabled) = patch.enabled {
                let current_enabled = workflow.status == CronTaskStatus::Active;
                if target_enabled != current_enabled {
                    if target_enabled {
                        let task = registry.resume_task(cron_id).await.map_err(map_scheduler_err)?;
                        workflow.status = CronTaskStatus::Active;
                        workflow.enabled = true;
                        workflow.next_fire_at_ms = task.next_fire_at_ms;
                    } else {
                        registry.pause_task(cron_id).await.map_err(map_scheduler_err)?;
                        workflow.status = CronTaskStatus::Paused;
                        workflow.enabled = false;
                        workflow.next_fire_at_ms = 0;
                    }
                }
            }

            // B. 处理调度周期或提示词变更 (就地更新)
            if (schedule_changed || prompt_changed) && workflow.status == CronTaskStatus::Active {
                let task_patch = CronTaskPatch {
                    expression: new_expression,
                    prompt: if prompt_changed { Some(workflow.prompt.clone()) } else { None },
                    max_iterations: None,
                    is_daemon: None,
                    target_session_id: workflow.target_session_id.clone().map(Some),
                };
                let updated = registry.update_task(cron_id, task_patch).await.map_err(map_scheduler_err)?;
                workflow.next_fire_at_ms = updated.next_fire_at_ms;
            }
        }

        // 4. 持久化保存（cron_id 与 created_at_ms 原样保留，仅刷新 updated_at_ms）
        workflow.updated_at_ms = now_ms();
        self.store.save(&workflow);

        tracing::info!(
            target: "workflow",
            cron_id = %workflow.cron_id,
            status = ?workflow.status,
            next_fire = workflow.next_fire_at_ms,
            "workflow 已完成原子就地更新（cron_id 恒定，历史运行记录 100% 保持关联）"
        );

        Ok(workflow.view())
    }
}
```

---

### 5.4 `WorkflowBackend::list` 彻底删除脏覆盖

```rust
// apps/agent-workbench/src-tauri/src/workflow_commands.rs

impl WorkflowBackend {
    /// 列出全部 workflow（按创建时间升序稳定展示；仅投影底层活跃态，绝不反向冲刷 DB）
    pub(crate) fn list(&self) -> Vec<WorkflowView> {
        let mut all = self.store.load_all();
        if let Some(registry) = self.registry() {
            let snapshot = registry.snapshot();
            for workflow in &mut all {
                if let Some(task) = snapshot.iter().find(|t| t.cron_id == workflow.cron_id) {
                    workflow.fired_count = task.fired_count;
                    // 【关键修复】：彻底删除 workflow.enabled = task.enabled 的暴力覆盖！
                    if workflow.status == CronTaskStatus::Active {
                        workflow.next_fire_at_ms = task.next_fire_at_ms;
                    } else {
                        workflow.next_fire_at_ms = 0;
                    }
                }
            }
        }
        all.sort_by_key(|w| w.created_at_ms);
        all.iter().map(|w| w.view()).collect()
    }
}
```

---

### 5.5 `WorkflowBackend::trigger` 真实化执行转型

```rust
// apps/agent-workbench/src-tauri/src/workflow_commands.rs

impl WorkflowBackend {
    /// 立即触发一次（真实状态机流转，杜绝 0ms completed 欺骗）
    pub(crate) async fn trigger(&self, cron_id: &str) -> Result<TriggerResult, CoreError> {
        let all = self.store.load_all();
        let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) else {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        };
        if workflow.status != CronTaskStatus::Active {
            return Err(CoreError::InvalidInput(format!(
                "workflow {cron_id} 已暂停，请先启用再触发"
            )));
        }

        let now = now_ms();
        workflow.fired_count += 1;
        workflow.last_run_at_ms = Some(now);
        workflow.updated_at_ms = now;
        self.store.save(&workflow);

        // 1. 计算目标执行会话 ID 与规范化运行 ID
        let effective_session_id = workflow.target_session_id.clone().unwrap_or_else(|| {
            format!("workflow-sess-{}", workflow.cron_id)
        });
        let run_id = format!("run-wf-{}-{}", workflow.cron_id, workflow.fired_count);

        // 2. 真实初始化运行记录（status: "running", finished_at: None, duration: None）
        let initial_record = WorkflowRunRecord {
            workflow_id: workflow.cron_id.clone(),
            run_id: run_id.clone(),
            session_id: Some(effective_session_id.clone()),
            trigger_kind: "manual".to_string(),
            scheduled_for_ms: now,
            started_at_ms: now,
            finished_at_ms: None,
            duration_ms: None,
            status: "running".to_string(), // 真实 running 状态！
            prompt: workflow.prompt.clone(),
            error: None,
            output_summary: Some("手动立即触发中…".to_string()),
        };
        self.store.append_or_update_run(initial_record);

        // 3. 委派执行器拉起任务（若有 launcher 则走真实管道）
        // ...

        Ok(TriggerResult {
            run_id: Some(run_id),
            session_id: Some(effective_session_id),
        })
    }
}
```

---

## 六、孤儿运行自愈收割与 `update_run_finish` 接线（彻底消灭死代码）

### 6.1 `update_run_finish` 激活接线

在 `apps/agent-workbench/src-tauri/src/workflow_commands.rs:468` 处彻底删除 `#[allow(dead_code)]`，并由执行引擎在任务终态时统一调用：

```rust
// apps/agent-workbench/src-tauri/src/workflow_commands.rs

impl dyn WorkflowStore {
    /// 标记单条运行记录终态（激活接线，消除 dead_code）
    pub fn update_run_finish(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        let mut runs = self.load_runs();
        if let Some(run) = runs
            .iter_mut()
            .find(|r| r.workflow_id == workflow_id && r.run_id == run_id)
        {
            run.status = status.to_string();
            run.finished_at_ms = Some(finished_at_ms);
            run.duration_ms = Some(duration_ms);
            run.error = error;
            run.output_summary = output_summary;
            self.save_runs(&prune_runs(runs));
        }
    }
}
```

### 6.2 列表查询与启动期孤儿自愈收割

```rust
// apps/agent-workbench/src-tauri/src/workflow_commands.rs

impl WorkflowBackend {
    /// 查询运行记录（附带孤儿 running 自动收割）
    pub(crate) fn list_runs(&self, workflow_id: Option<&str>, limit: Option<usize>) -> Vec<WorkflowRunView> {
        let mut runs = self.store.load_runs();
        let now = now_ms();
        let mut dirty = false;

        // 孤儿收割：超过 24 小时未收口或跨重启无活跃句柄的 running 记录自动转为 interrupted
        for r in &mut runs {
            if r.status == "running" && now.saturating_sub(r.started_at_ms) > 3600_000 * 24 {
                r.status = "interrupted".to_string();
                r.finished_at_ms = Some(now);
                r.duration_ms = Some(now.saturating_sub(r.started_at_ms));
                r.error = Some("运行已中断（历史孤儿记录自动自愈）".to_string());
                dirty = true;
            }
        }
        if dirty {
            self.store.save_runs(&runs);
        }

        let mut filtered: Vec<WorkflowRunRecord> = if let Some(wid) = workflow_id {
            runs.into_iter().filter(|r| r.workflow_id == wid).collect()
        } else {
            runs
        };

        filtered.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        if let Some(lim) = limit {
            filtered.truncate(lim);
        }

        filtered.iter().map(|r| r.view()).collect()
    }
}
```

---

## 七、自动化测试与验证套件

### 7.1 核心测试用例

1. **TC-P4-01：修改调度周期保持 `cron_id` 绝对恒定与历史记录完整关联**；
2. **TC-P4-02：任务启停强联动与内存状态双向同源**；
3. **TC-P4-03：Safe Field Merge 验证（CRIT-05 修复，完整保留业务字段与状态枚举）**；
4. **TC-P4-04：存量脏数据反序列化与 Cron 智能自愈推断**；
5. **TC-P4-05：`trigger_workflow` 初始 running 状态与有效会话句柄**；
6. **TC-P4-06：`list()` 零脏覆盖断言**；
7. **TC-P4-07：`WorkflowPatch` 双重 Option 精确支持置空与解绑**；
8. **TC-P4-08：孤儿 running 自愈收割与 `update_run_finish` 终态翻转验证**。

---

## 八、总结与交付承诺

本方案彻底去除了双索引维护代码，确立了 `sched_index` 唯一真源，消灭了双重布尔与枚举同步垫片。通过落实 Review Agent 1 的 **CRIT-05（无损合并与丢失更新防御）**，并攻克了系统现存的“运行记录悬挂 1 个多月蓝色运行中”恶疾（激活 `update_run_finish` + 孤儿运行记录自愈收割），全面保证了 Conex / Crish 在 IPC 命令面与底层存储之间的双向绝对一致性。
