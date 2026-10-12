# 定时任务全流程修复与能力升级战役（Scheduled Tasks Revamp）

# 系统底层与引擎架构首席审查报告（System & Engine Architecture Review）

> **文档标识**：`review-system-engine.md`  
> **审查对象**：
>
> 1. 战役总方案：[`docs/scheduled-tasks-revamp/00-总方案-定时任务全链路重构与功能完善实施规划.md`](../00-总方案-定时任务全链路重构与功能完善实施规划.md)
> 2. 阶段 1 最终方案：[`docs/scheduled-tasks-revamp/plans/01-阶段一-底层调度器核心治理与单任务生命周期最终方案.md`](../plans/01-阶段一-底层调度器核心治理与单任务生命周期最终方案.md)
> 3. 阶段 2 最终方案：[`docs/scheduled-tasks-revamp/plans/02-阶段二-真实Agent执行驱动与无人值守唤醒闭环最终方案.md`](../plans/02-阶段二-真实Agent执行驱动与无人值守唤醒闭环最终方案.md)
> 4. 阶段 4 最终方案：[`docs/scheduled-tasks-revamp/plans/04-阶段四-Tauri-IPC命令面与元数据双向一致性最终方案.md`](../plans/04-阶段四-Tauri-IPC命令面与元数据双向一致性最终方案.md)
>
> **审查基准代码**：`apps/agent-workbench/src-tauri/src/sched.rs`, `apps/agent-workbench/src-tauri/src/main.rs`, `apps/agent-workbench/src-tauri/src/workflow_commands.rs`, `apps/agent-workbench/src-tauri/src/run/run_launch.rs`  
> **审查者角色**：系统底层与引擎架构首席审查官（System & Engine Architecture Reviewer）  
> **架构纪律基线**：`AGENTS.md`（§1 逻辑规划与反退避、§3 Git 提交纪律、§7 严禁补丁与作弊、§7.1 立体验证、§8 反过度设计硬性红线）、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`。

---

## 一、审查概览与执行摘要（Executive Summary）

本审查以 Red Team 级严苛工程视角，对 Conex / Crish「定时任务全流程修复与能力升级战役」的顶层总纲及 Phase 1、Phase 2、Phase 4 实施方案进行了穿透式代码级和时序级审查。

### 1.1 总体审查裁决：条件性通过（Conditional Pass with Critical Blockers）

方案整体对现有系统的核心痛点（包括开机 restore 缺失、0ms 虚假完成、双写抹杀、ID 突变等）把脉精准，总体解题思路与系统目标符合现代桌面 Agent 架构的发展方向。但在涉及**异步并发代际流转**、**跨层执行排队状态机追踪**、**启动时序依赖装配**以及**持久化原子合并**四大核心领域，存在 **3 个 P0 级致命逻辑漏洞** 与 **2 个 P1 级架构盲区**。若直接照搬实施，将引发定时任务无故永久停摆、运行记录永久挂死排队态以及开机过期任务降级失效等严重工程灾难。

必须在 Wave 1 代码实施前，将本报告提出的架构补丁和防御逻辑并入实施方案。

### 1.2 核心红线问题汇总（Top Critical Findings）

| 缺陷编号    | 严重度      | 涉及模块 / 方案                     | 缺陷性质                                            | 破坏性后果                                                                                                                                 |
| :---------- | :---------- | :---------------------------------- | :-------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| **CRIT-01** | **P0 致命** | `plans/01` §3.2 `update_task`       | **代际自增未绑协程重启，导致调度永久停摆**          | 用户仅修改提示词时，代际自增但未重启协程，正在收尾的触发协程段 3 误判代际不匹配并中止新协程，导致任务**永久停止调度**。                    |
| **CRIT-02** | **P0 致命** | `plans/02` §4.3 & `run_idle.rs`     | **串行排队 `queued` 运行记录成孤儿僵尸**            | 会话忙碌时标记 `queued`，随后 `WakeWatcher` 经 `idle-resume` 续 run，但新 run 的 ID 与类型无法对齐，排队记录**永远无法收口为 completed**。 |
| **CRIT-03** | **P0 致命** | `plans/01` §4.2 vs `plans/02` §3.4  | **启动恢复与 Launcher 装配时序倒挂**                | `main.rs:969` 在 `setup` 期间异步恢复触发离线任务，但真实 Launcher 在第 1018 行后才装配，导致**离线过期补发任务 100% 降级为旧 steering**。 |
| **CRIT-04** | **P1 严重** | `plans/02` §4.4 & `run_launch.rs`   | **终态收口单点依赖 `run_idle`，旁路失败漏网**       | 定时任务若在启动期崩溃、或被 `finalize_failed` / `finalize_orphan_run` 旁路收割，收口钩子被完全跳过，记录**永久停留在 running 态**。       |
| **CRIT-05** | **P1 严重** | `plans/04` §5.1 `LocalDbSchedStore` | **Safe Merge 字段遗漏与并发丢失更新 (Lost Update)** | 合并逻辑遗漏 `status` 等新增字段，且 SQLite 缺乏行级事务/锁保护，IPC 保存与调度触发并发时存在覆盖丢失更新风险。                            |

---

## 二、方案逻辑顺序与实施依赖组织审查（Dependency & Sequencing Review）

### 2.1 推进波次划分的接口倒挂与编译断裂

总方案规划的实施波次为：

- **Wave 1**：底座与生命周期治理（Phase 1 调度核心 + Phase 4 存储层）
- **Wave 2**：真实执行管道与会话上下文（Phase 2 执行驱动 + Phase 3 工具层）
- **Wave 3**：命令面全链路一致性与双模绑定（Phase 4 命令面 + Phase 3 路由）
- **Wave 4**：前端交互、表单升级与体验打磨（Phase 5 UI）

#### 审查发现：Wave 1 与 Wave 2 之间存在不可调和的契约倒挂

1. **执行器接口演进撕裂**：
   - Phase 1 方案中，`SchedulerComponents` 依然保留原有旧定义：`launcher: Option<Arc<dyn DaemonRunLauncher>>`；
   - 但 Phase 2 方案中，`SchedulerComponents` 被重构为：`launcher: Arc<tokio::sync::RwLock<Option<Arc<dyn ScheduledTaskLauncher>>>>`，且 `fire_cron` 的触发签名和执行流完全推翻重写。
   - 如果 Wave 1 仅按 Phase 1 实施，`sched.rs` 刚刚完成一次重构，到了 Wave 2 又必须推倒重来，造成严重返工。
2. **运行记录初始化状态倒挂**：
   - Phase 1 的 `fire_once` 伪代码依然保留着向 store 写入 `status: "completed", duration_ms: Some(0)` 的旧病灶；
   - 而 Phase 4 的存储层合并（同样被划入 Wave 1）却要求支持 `WorkflowRunRecord` 完备的 `running`、`queued` 状态。
   - 这导致 Wave 1 的单元测试面临两难：若按 Phase 1 断言 0ms 完成，则强化了错误行为；若按 Phase 2 断言 running，则 Wave 1 缺少执行器支撑。

#### 治理裁决（Reordered Wave Contract）

- **在 Wave 1 一次性确立执行器终态契约**：
  在 Wave 1 实现 `sched.rs` 时，坚决禁止使用过渡性的 `DaemonRunLauncher`，直接一步到位引入 `ScheduledTaskLauncher` trait 与 `ScheduledExecutionContext` 契约结构体。
- **Wave 1 提供默认降级适配器**：
  在 Wave 1 中提供一个内置的 `DefaultSteeringScheduledLauncher`（实现 `ScheduledTaskLauncher`，仅做纯 steering 注入并标记初始状态为 `running`，在本地模拟收口），使 Wave 1 的数据结构和并发状态机在底层 100% 固化；Wave 2 仅需替换为 `ProductionScheduledLauncher`，无需对 `sched.rs` 结构体进行破坏性二次修改。

---

### 2.2 开机 Restore 与执行器装配的时序倒挂漏洞（CRIT-03）

#### 物理链路穿透分析

在 `apps/agent-workbench/src-tauri/src/main.rs` 中：

```rust
// 968-972 行：异步恢复区
{
    let restore_state = Arc::clone(&core_state);
    tauri::async_runtime::spawn(async move {
        let _ = restore_state.run_restore().await;
        // Phase 1 计划在此处追加：core_state.scheduler_registry().restore().await;
    });
}
...
// 1014-1025 行：workflow_state 与 launcher 构造区
let workflow_state = workflow_commands::WorkflowCommandState::new(...);
// Phase 2 计划在此处调用：core_state.finalize_scheduled_launcher();
```

- **时序断层**：
  `tauri::async_runtime::spawn` 是在一个独立的 Tokio 线程池协程中立刻并发启动的。
  当 `registry.restore().await` 执行时，主线程往往还在执行第 980-1010 行的组件注册与通道绑定。
  此时，`core_state` 内部的 `launcher` 读写锁内**依然是 `None`**！
- **破坏性后果**：
  如果应用在离线期间有任务到期，`restore()` 扫描到该任务并触发 `fire_cron(..., true, 1)`。
  `fire_cron` 读取 `launcher` 得到 `None`，立刻触发安全降级分支：
  ```rust
  if !launched {
      components.pending.enqueue_steering(&target_sid, fire_text, outcome.fired_at_ms);
  }
  ```
  **宣称的“开机 100% 真实执行”在启动第一秒便彻底破产！离线到期的任务全部被降级回幽灵 steering 注入！**

#### 治理裁决

必须强制约束启动生命周期顺序（Lifecycle Ordering Guarantee）：

1. 真实执行器装配 `finalize_scheduled_launcher` 必须前置在 `core_state` 初始化末尾（即 `finalize_subagent_spawner` 同级位置，在第 960 行前执行完毕）；
2. 调度器恢复 `scheduler_registry.restore().await` 必须在 `core_state.run_restore().await` 成功 resolve 之后串行执行，确保系统底座的 run 快照已就绪且执行器已具备完整拉起能力。

---

## 三、并发安全、锁治理与代际防复活深度穿透（Concurrency & Lock Governance）

### 3.1 【P0 级致命漏洞】`update_task` 非调度字段修改导致调度永久停摆（CRIT-01）

这是本次审查挖出的**最具隐蔽性、破坏力极强的核心逻辑死穴**。

#### 现场代码还原（`plans/01` §3.2 第 440-470 行）：

```rust
impl SchedulerRegistry {
    pub(crate) async fn update_task(&self, cron_id: &str, patch: CronTaskPatch) -> Result<CronTask, SchedulerError> {
        ...
        {
            let mut tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let entry = tasks.get_mut(cron_id).ok_or(SchedulerError::IdNotFound)?;

            // 1. 表达式变更
            if let Some(new_expr) = patch.expression { ... schedule_changed = true; }
            // 2. 提示词变更
            if let Some(new_prompt) = patch.prompt { entry.task.prompt = trimmed; }
            // 3. 最大迭代/守护/会话绑定变更
            ...
            entry.task.updated_at_ms = now;
            entry.generation += 1; // <--- 【致命点 1】：无条件递增代际

            // 5. 若表达式改变且当前任务处于 Active 态，热重启倒计时协程
            if schedule_changed && entry.task.status == CronTaskStatus::Active {
                if let Some(old_h) = entry.sleep_task.take() { old_h.abort(); }
                let delay = fire_delay_ms(&self.components, entry.task.next_fire_at_ms);
                let new_h = spawn_fire_task(self.components.clone(), entry.task.clone(), delay, entry.generation);
                entry.sleep_task = Some(new_h);
            }
            // 【致命点 2】：若 schedule_changed 为 false（例如仅修改了 prompt），
            // entry.sleep_task 完全不重建！依然运行着持有旧 generation 的旧协程！
        }
    }
}
```

#### 灾难推演链路：

1. 任务 `cron-1` 正常运行，`generation = 1`，后台 Tokio 协程正挂载在 `sleep_until` 倒计时中（持有的入参为 `expected_gen = 1`）；
2. 用户在 UI 上修改了提示词 `prompt`（例如修改自动化分析的要求），后端调用 `update_task`；
3. `update_task` 判定 `schedule_changed == false`，于是执行了 `entry.generation += 1`（变为 `2`），**但没有重启 `sleep_task`**；
4. 倒计时到期，后台协程唤醒，进入 `fire_cron(..., expected_gen = 1)`；
5. 进入段 0 后的预检：
   ```rust
   let map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
   if let Some(entry) = map.get(&task.cron_id) {
       if entry.generation != expected_gen || entry.task.status != CronTaskStatus::Active {
           tracing::info!(target: "sched", cron_id = %task.cron_id, "任务代际已变更或已处于非活跃态，放弃触发");
           return; // <--- 命中！由于 2 != 1，直接退出！
       }
   }
   ```
6. **后果**：
   本次触发被直接丢弃！更致命的是：**因为协程退出了，且 `update_task` 根本没有给它生成新的协程，该任务从此在内存中彻底丧失了任何 Tokio 计时协程！**
   它再也不会倒计时，再也不会触发！任务如同被“脑死亡”，进入永久停摆状态！

#### 根治方案（Generation-Coroutine Binding Invariant）

**代际与协程生命周期强绑定铁律**：
`generation` 的递增**必须且仅能伴随协程的物理重建**。

- 若只修改不影响调度时机的静态元数据（如 `prompt`、`is_daemon`、`target_session_id`），**严禁递增 `generation`**，仅就地原地更新 `entry.task` 字段即可；
- 仅当发生以下三种行为时才允许递增 `generation`：
  1. `pause_task`：abort 协程，代际递增，置为 None；
  2. `resume_task`：代际递增，重算时间，重建协程；
  3. `update_task` 且 `schedule_changed == true`：abort 旧协程，代际递增，重建协程；
  4. 正常触发收口（段 3）：自然过渡到 `next_gen = expected_gen + 1` 并重建协程。

---

### 3.2 【P0 级数据竞态】触发中暂停导致的持久化反向冲刷与复活漏洞

#### 竞态场景推演

1. 倒计时到期，`fire_cron` 进入段 1 同步触发核心 `fire_once`；
2. 为遵循 AA-02 锁治理规约，`fire_once` 在锁外调用 `store.save(&updated)`（包含 `status: Active, fired_count: N+1`）；
3. 恰在此瞬间（微秒级窗口），用户在前端点击了“暂停”，调用了 `pause_task`；
4. `pause_task` 获取互斥锁，将内存状态置为 `Paused`，代际递增，abort 协程，并在锁外调用 `store.save(&paused_task)`（落库 `status: Paused`）；
5. 紧接着，正在运行的 `fire_once` 的 `store.save(&updated)` 刚刚完成网络或磁盘写操作；
6. 结果：**`fire_once` 的 `Active` 状态将 `pause_task` 刚刚写进去的 `Paused` 状态给彻底覆盖抹杀！**
7. 随后 `fire_cron` 进入段 3，虽然段 3 的内存代际检查发现代际不匹配，成功中止了新协程的拉起；
8. **但数据库底账已中毒**：session_meta 中的状态成了 `Active`。一旦用户关闭应用或应用崩溃重启，`restore()` 扫描数据库，会将该任务作为 `Active` 重新挂载启动！用户明明暂停了任务，重启后任务神秘复活！

#### 根治方案（Atomic State Save Guard）

在 `store.save` 写入时，必须加入逻辑防护：

1. `store.save` 必须确保具有 CAS（Compare-And-Swap）语义，或 `save_task_conditional`：仅当数据库中的 `updated_at_ms` 小于等于本次写入的更新时间时才允许写回；
2. 调度器内部在 `fire_once` 准备写库前，必须在原子锁内校验该任务是否仍处于 `Active` 态；若在计算期间已被外部置为 `Paused`，立即放弃更新调度状态的持久化，坚决禁止将 `Active` 冲刷回 DB。

---

### 3.3 AA-02 锁规约与锁粒度深度审查

全面审查 Phase 1、Phase 2 方案中所有代码块的锁使用情况：

- **`tasks: Arc<Mutex<HashMap<String, CronEntry>>>`**：
  在 `pause_task`、`resume_task`、`update_task` 中，互斥锁均通过显式作用域 `{ let mut tasks = ...; }` 进行局限，并在代码块末尾自动 drop，其后才执行 `store.save()`。**严格符合 AA-02 锁绝不跨 await 铁律**。
- **`launcher: Arc<tokio::sync::RwLock<...>>`**：
  采用 Tokio 异步读写锁，在 `fire_cron` 中读锁被 clone 出后立即释放；在 `set_launcher` 中写锁跨 await 写入，无死锁风险。
- **`restored: Arc<AtomicBool>`**：
  使用 `compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)` 保证全局单次幂等，彻底杜绝多协程并发调用导致协程翻倍。
- **`seq: AtomicU64`**：
  使用 `fetch_max(seq + 1, Ordering::SeqCst)`，避免重启扫描与新注册撞号，算法严密正确。

---

## 四、真实执行驱动、串行守卫与无人值守闭环审查（Execution Engine & Wake Loop）

### 4.1 【P0 级架构硬伤】串行排队 `queued` 运行记录孤儿化（CRIT-02）

#### 问题深层剖析

方案 2 在 §4.3 中设计了优雅的“串行冲突排队”：

```rust
// 当命中串行守卫被拒绝时：
core_state.pending_queue().lock().unwrap().replace_or_enqueue(steering_entry);
self.store.update_run_finish(&ctx.workflow_id, &ctx.run_id, "queued", now, 0, Some("会话正忙..."), None);
```

方案设想：前序 Run 结束后，`WakeWatcher` 检测到 steering，会自动接力拉起后续任务。

#### 致命的断裂点在于：

1. 前序 Run 结束，`WakeWatcher` 发现会话中有 pending steering，调用 `spawn_idle_resume_run(session_id)`；
2. `spawn_idle_resume_run` 拉起的任务是一个全新的 Run，其配置为：
   - `run_id`: 新生成的 `run-idle-resume-<uuid>`；
   - `mode`: `"idle-resume"`；
3. 这个新 Run 真实调用了模型，执行了工具，耗时 15 秒，产出了助手总结，并在 `run_idle.rs` 终态收口；
4. 但是看 Phase 2 方案在 `run_idle.rs:788` 规定的定时任务终态拦截条件：
   ```rust
   if active.mode.as_deref() == Some("scheduled") {
       let workflow_id = extract_workflow_id_from_run_id(&active.run_id);
       ...
       core_state.on_scheduled_run_terminal(...).await;
   }
   ```
   - **断裂 1**：新 Run 的 `mode` 是 `"idle-resume"`，**完全不等于 `"scheduled"`**！拦截条件根本不匹配！
   - **断裂 2**：即使放宽条件，新 Run 的 `run_id` 是 `run-idle-resume-...`，而当初被标记为 `queued` 的记录是 `cron-1-fire-1`！系统根本不知道这两个 Run 之间存在任何血缘继承关系！
5. **破坏性后果**：
   那条当初被置为 `queued` 的运行记录（`cron-1-fire-1`），**将永远停留在 `status: "queued"`, `duration: 0` 状态**！
   在前端的历史记录面板中，它是一条死信记录，用户永远看不到它何时真正完成，也看不到它的执行产出！定时任务的核心审计线彻底断裂！

#### 根治架构补丁（Queued Anchor Context）

必须建立跨 Run 的定时任务血缘溯源机制：

1. **注入挂载元数据**：当任务降级为排队 steering 时，在 `SteeringInputEntry` 的附加元数据（`group_id` 或新建字段 `scheduled_anchor`）中注入上下文：
   ```rust
   scheduled_anchor: Some(ScheduledAnchor {
       workflow_id: ctx.workflow_id.clone(),
       origin_run_id: ctx.run_id.clone(),
       queued_at_ms: now,
   })
   ```
2. **续 Run 继承锚点**：当 `WakeWatcher` 或 `decide_idle_resume` 消费该 steering 条目拉起续 run 时，将该 `scheduled_anchor` 传递给新 `ActiveRun`；
3. **收口双向对齐**：在 `run_idle.rs` 收口时，若检测到 `active.scheduled_anchor` 存在：
   调用 `on_scheduled_run_terminal` 时传入 `anchor.origin_run_id`，将原先挂起的 `queued` 记录就地翻转为 `completed`，并计算从排队到真正完成的全流程耗时，填写真实摘要！彻底消灭僵尸排队记录！

---

### 4.2 【P1 级收口漏网】终态生命周期单点依赖 `run_idle.rs` 的盲区（CRIT-04）

#### 代码逻辑穿透

在现有架构 `apps/agent-workbench/src-tauri/src/run/` 中，一个 Run 走向终态共有 **3 条物理路径**：

1. **正常循环收口**：在 `run_idle.rs:1530`，`drive_run_loop` 正常结束；
2. **初始化异常与快速失败**：在 `run_launch.rs:10` `finalize_failed`，当模型客户端握手失败、存储写入失败或系统严重错误时调用；
3. **孤儿收割周期任务**：在 `run_launch.rs:114` `finalize_orphan_run`，当协程崩溃 panic 或外部强制取消时调用。

#### 缺陷现状

Phase 2 方案仅仅在路径 1（`run_idle.rs`）中植入了 `on_scheduled_run_terminal`。
一旦定时任务触发了路径 2（如 API Key 失效、模型未响应）或路径 3（系统资源耗尽导致的孤儿收割）：

- `run_idle.rs` 根本不会被执行；
- `finalize_failed` 仅通知了 `subagent`（见 `run_launch.rs:85-89`），对 `scheduled` 任务只字未提；
- **后果**：运行记录在数据库中将永远保留为初始的 `status: "running"`，永不收口！

#### 治理方案

在 `run_launch.rs:finalize_failed` 中对齐子代理规范，补全收口拦截：

```rust
// run_launch.rs: finalize_failed 内追加：
if active.mode.as_deref() == Some("scheduled") {
    let workflow_id = extract_workflow_id_from_run_id(&active.run_id);
    state.on_scheduled_run_terminal(
        &workflow_id,
        &active.run_id,
        active.started_at_ms,
        conex_db::RunStatus::Failed,
        &[],
        Some(message.to_string()),
    ).await;
}
```

---

### 4.3 `ProductionScheduledLauncher` 弱引用两阶段装配审查

Phase 2 方案引入了：

```rust
pub(crate) struct ProductionScheduledLauncher {
    state: Weak<CoreRunState>,
    store: Arc<dyn WorkflowStore>,
}
```

- **引用环审查**：
  链路为：`CoreRunState` -> `SchedulerRegistry` -> `SchedulerComponents` -> `RwLock<Option<Arc<dyn ScheduledTaskLauncher>>>` -> `ProductionScheduledLauncher` -> `Weak<CoreRunState>`。
  由于采用了 `Weak<CoreRunState>`，强引用环被彻底截断，**内存无泄漏风险**；
- **生命周期存活性**：
  在 `launch_scheduled_task` 时，通过 `self.state.upgrade()` 获取强引用。若应用正在关闭，`upgrade()` 返回 `None` 并优雅报错，不引发 panic，设计严谨优秀。

---

## 五、存储一致性与 Safe Field Merge 细节穿透（Storage Consistency & Safe Merge）

### 5.1 【P1 严重】`LocalDbSchedStore` 合并字段遗漏与丢失更新（CRIT-05）

#### 遗漏字段排查

查看 Phase 4 方案 §5.1 的合并代码：

```rust
map.insert("cronId".to_string(), serde_json::json!(task.cron_id));
map.insert("expression".to_string(), serde_json::json!(task.expression));
map.insert("prompt".to_string(), serde_json::json!(task.prompt));
map.insert("maxIterations".to_string(), serde_json::json!(task.max_iterations));
map.insert("isDaemon".to_string(), serde_json::json!(task.is_daemon));
map.insert("nextFireAtMs".to_string(), serde_json::json!(task.next_fire_at_ms));
map.insert("firedCount".to_string(), serde_json::json!(task.fired_count));
map.insert("enabled".to_string(), serde_json::json!(task.enabled));
```

**严重漏项**：
Phase 1 与 Phase 3 对 `CronTask` 扩展的核心字段：

- `status` (`CronTaskStatus`)
- `targetSessionId` (`Option<String>`)
- `updatedAtMs` (`u64`)
- `createdAtMs` (`u64`)
  在此处全被遗漏！
  如果底层更新了任务状态（例如从 Active 迁移至 Completed），写库时竟然没有写入 `status` 字段！重启后只能靠 `#[serde(default)]` 猜回 Active，直接导致状态降级失效！

#### 读-改-写（Read-Modify-Write）并发竞态

`get_session_meta` 与随后的 `set_session_meta` 是两条独立的 SQL 语句，中间没有任何行级互斥锁。
若 IPC 命令线程（如用户编辑任务配置）与调度触发线程（如触发推进 fired_count）在同一毫秒并发操作：

- 线程 A 读取到版本 V0；
- 线程 B 读取到版本 V0；
- 线程 A 将 name 改为 "新任务" 并写入 V1；
- 线程 B 将 fired_count 改为 5，并把手里的旧 name 写回；
- **线程 A 的更名被完全冲刷覆盖（Lost Update 丢失更新）**！

#### 治理方案

1. 补齐 `LocalDbSchedStore::save` 中待合并字段的完整清单，将 `status`、`targetSessionId`、`updatedAtMs` 纳入无损合并范围；
2. 在存储层为 `sched_<cron_id>` 引入进程内单键互斥锁（如 `KeyedLock` 或直接复用 `tasks` 互斥保护），确保同一任务的读-改-写过程串行化。

---

### 5.2 统一双索引自愈与向后兼容防陷阱审查

Phase 4 方案提出将 `sched_ids` 统一迁移至 `sched_index`。

#### 潜在隐患：历史被毒化任务反序列化回退为 Manual

在 `StoredWorkflow` 补齐 `#[serde(default)]` 时：

```rust
#[serde(default = "default_manual_schedule")]
pub schedule: WorkflowScheduleWire,
```

**缺陷场景**：对于已经在历史版本中被毒化（抹除业务字段）的遗留数据，其 `schedule` 字段已丢失，但其 `expression` 字段（如 `"0 9 * * *"`）仍然健在！
如果简单默认回退为 `Manual`，这批历史任务将彻底失去定时触发能力！
**启发式自愈修复（Heuristic Rehydration）**：
在反序列化或加载时植入自愈启发逻辑：
若反序列化出的 `schedule` 为 `Manual`，但 `expression` 字段非空且为合法的 5 字段 Cron 表达式，自动将其自愈纠正为 `WorkflowScheduleWire::Cron { expression: expression.clone() }`！实现存量历史资产的 100% 自动抢救。

---

## 六、工作量评估、边缘异常与重要遗漏核查（Workload & Edge Cases）

### 6.1 存量测试套件迁移工作量严重低估

方案中对原有测试资产的评估过于乐观。现存代码包含：

1. `apps/agent-workbench/src-tauri/src/sched.rs` 内部包含 **14 个大型集成与单元测试**（行 1070-1951，近 900 行测试代码），深度依赖旧的 `DaemonRunLauncher`、`MemorySchedStore` 伪造方法以及旧的 `CronTask` 8 字段结构体；
2. `workflow_commands.rs` 包含 **12 个针对 `list()`、`update()` 的测试用例**。
   一旦接口类型变动，这些测试将全量报错。
   **必须在工时规划中显式列出“存量测试迁移与断言对齐”专项**，预留充足的测试重构工时，严禁注释掉或删除存量测试（遵守测试资产保护铁律）。

### 6.2 边缘系统异常清单审查

方案对以下物理环境极端异常缺乏应对策略：

1. **系统休眠与时钟跳跃（Clock Drift / OS Sleep Resume）**：
   笔记本电脑合盖休眠 8 小时后唤醒，Tokio 的 `sleep_until` 会如何表现？
   - 现有时钟基于 `SystemTime` 与 `Instant`。若系统唤醒，到期时间早已越过，Tokio 会立即唤醒协程；
   - 但若离线期间跨越了多个周期，当前逻辑仅会补发一次。方案需明确界定“休眠唤醒补发单次还是多次”的语义（推荐保持当前单次补发，防轰炸）。
2. **极端短周期（如 `* * * * *` 每分钟）与超长任务堆叠**：
   若任务执行需 3 分钟，但调度周期为 1 分钟：
   - 此时每分钟都会触发一次，并全部进入 `queued` 队列；
   - 方案缺乏**单任务排队上限控制（Max Queued Limit）**，容易导致 steering 队列膨胀。
   - **改进建议**：同一个 `workflow_id` 在同一会话的排队中最多保留 1 个最新 steering 条目（现有 `replace_or_enqueue` 配合 `group_id = cron-<id>` 具备天然去重能力，需在方案中予以正式锁定声明）。

---

## 七、建设性重构意见与工程落地补丁规范（Constructive Engineering Proposals）

为了确保战役方案真正具备 Red Team 级的工程健壮性，本首席审查官给出以下 4 项核心落盘补丁规范：

### 补丁 1：代际防御与协程生命周期一致性规约（针对 CRIT-01）

修改 `plans/01` §3.2 中 `update_task` 的伪代码实现逻辑：

```rust
// 规约：仅当 schedule 发生实质变更，且任务处于 Active 状态时，才推进 generation 并重建协程
if schedule_changed {
    entry.generation += 1;
    if entry.task.status == CronTaskStatus::Active {
        if let Some(old_h) = entry.sleep_task.take() {
            old_h.abort();
        }
        let delay = fire_delay_ms(&self.components, entry.task.next_fire_at_ms);
        let new_h = spawn_fire_task(self.components.clone(), entry.task.clone(), delay, entry.generation);
        entry.sleep_task = Some(new_h);
    }
}
// 若仅仅是 prompt、is_daemon、target_session_id 发生变更：
// 保持 entry.generation 绝对不变！就地更新 entry.task 内部字段即可！
```

### 补丁 2：排队上下文锚点与续 Run 收口追踪器（针对 CRIT-02）

在 `plans/02` §4.3 与 `orchestrator::steering_queue` 中明确串行排队锚点：

1. `SteeringInputEntry` 增加 `cron_run_anchor: Option<String>`（格式：`"{workflow_id}:{run_id}:{started_at_ms}"`）；
2. `drive_run_loop` 启动时，若检测到本次由 steering 唤醒，提取该 anchor 绑定至 `ActiveRun`；
3. `run_idle.rs` 收口时，若存在 anchor，反向解析并触发对原始 `run_id` 的状态翻转（从 `queued` 翻转为 `completed`），彻底闭合运行记录状态链。

### 补丁 3：全链路终态收口拦截网（针对 CRIT-04）

在 `plans/02` §4.4 中明确将终态收口扩大至全部终态路径：

- `run_idle.rs`（正常完成与业务失败）
- `run_launch.rs:finalize_failed`（异常崩溃快速失败）
- `run_launch.rs:finalize_orphan_run`（孤儿收割终态收口）
  三处统一定点调用 `CoreRunState::on_scheduled_run_terminal`。

### 补丁 4：Safe Field Merge 全字段补齐与自愈反序列化（针对 CRIT-05）

在 `plans/04` §5.1 中完善合并字段，并在反序列化中植入 Cron 智能推断：

```rust
// 存储层合并补齐：
map.insert("status".to_string(), serde_json::json!(task.status));
map.insert("targetSessionId".to_string(), serde_json::json!(task.target_session_id));
map.insert("updatedAtMs".to_string(), serde_json::json!(task.updated_at_ms));

// 反序列化智能推断：
if workflow.schedule == WorkflowScheduleWire::Manual && !workflow.expression.trim().is_empty() {
    if parse_cron(&workflow.expression).is_ok() {
        workflow.schedule = WorkflowScheduleWire::Cron {
            expression: workflow.expression.clone(),
        };
    }
}
```

---

## 八、审查结论与准入签字（Sign-off & Recommendations）

| 审查维度               | 评分 (1-10) | 审查结论                                                                                               |
| :--------------------- | :---------: | :----------------------------------------------------------------------------------------------------- |
| **逻辑依赖与推进顺序** |     8.5     | 基本合理，需在 Wave 1 一步到位定义 `ScheduledTaskLauncher` 契约，避免二次颠覆重构。                    |
| **并发安全与锁治理**   |     7.0     | 锁粒度规范优良（符合 AA-02），但存在 `update_task` 代际杀死协程与触发中暂停写库竞争 2 个致命逻辑漏洞。 |
| **执行驱动与无人值守** |     7.5     | 弱引用解耦思路正确，但 `queued` 记录无法被续 run 收口的架构断层必须修复，失败收口路径须补全。          |
| **存储一致性与防冲刷** |     8.0     | Safe Field Merge 方向精准，但伪代码字段遗漏严重，且缺乏历史数据 Cron 智能回填自愈。                    |

**首席审查官签署意见**：  
方案整体架构设计具备极高的技术深度与攻坚价值。在将本审查报告揭示的 **CRIT-01 ~ CRIT-05 缺陷与 4 项架构补丁**吸收合入相关方案后，**批准进入 Wave 1 代码实施阶段**！
