//! 命令面聚合：create / list / update / delete / trigger / runs。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::core_error::CoreError;
use crate::sched::{CronTaskInput, CronTaskStatus, CronTaskUpdatePatch, SchedulerRegistry};
use crate::workflow::launcher::resolve_effective_workflow_cwd;
use crate::workflow::model::{StoredWorkflow, WorkflowRunRecord, WorkflowRunView, WorkflowView};
use crate::workflow::schedule::{
    next_fire_after_ms, schedule_to_expression, validate_cron_expression, WorkflowScheduleWire,
};
use crate::workflow::sinks::{SteeringSink, WorkflowEventSink};
use crate::workflow::{now_ms, CRON_ID_PREFIX};

/// workflow 命令后端（store 即元数据真源：每次操作以 sched_* 键读写，
/// 重启无损；seq 自数据推导，重启不撞号；调度真源 = 委托注册表）
pub struct WorkflowBackend {
    store: Arc<dyn crate::workflow::WorkflowStore>,
    sink: Arc<dyn SteeringSink>,
    /// SchedulerRegistry 委托槽（A3 装配收口注入；None = 命令层独立
    /// 承载调度语义——注册/取消/列表退化为元数据操作）
    registry: Mutex<Option<Arc<SchedulerRegistry>>>,
    /// 真实 Agent 执行驱动槽（注入后 trigger 走真实 Agent Loop 并异步回写终态）
    launcher: Mutex<Option<Arc<dyn crate::sched::ScheduledTaskLauncher>>>,
    /// 应用数据目录（供 INT-02 空 cwd 默认沙箱路径解析）
    app_data_dir: Mutex<Option<std::path::PathBuf>>,
    /// 全域事件广播（供终态事件广播；Tauri 实现留壳层注入）
    event_sink: Mutex<Option<Arc<dyn WorkflowEventSink>>>,
    seq: AtomicU64,
}

impl WorkflowBackend {
    /// 新建后端（适配器由装配方注入；seq 初始为数据内最大序号 +1；启动即收割在途孤儿记录）
    pub fn new(
        store: Arc<dyn crate::workflow::WorkflowStore>,
        sink: Arc<dyn SteeringSink>,
    ) -> Self {
        let seq = store
            .load_all()
            .iter()
            .filter_map(|w| cron_seq(&w.cron_id))
            .max()
            .map(|n| n + 1)
            .unwrap_or(0);
        let backend = Self {
            store,
            sink,
            registry: Mutex::new(None),
            launcher: Mutex::new(None),
            app_data_dir: Mutex::new(None),
            event_sink: Mutex::new(None),
            seq: AtomicU64::new(seq),
        };
        backend.reap_orphan_running_runs();
        backend
    }

    /// 存储句柄（launcher 等兄弟模块读取会话存在性 / 运行记录用）
    pub(crate) fn store(&self) -> &Arc<dyn crate::workflow::WorkflowStore> {
        &self.store
    }

    /// 获取指定 workflow 配置的权限模式（未显式配置时返回 None）
    pub fn get_workflow_permission_mode(&self, cron_id: &str) -> Option<String> {
        self.store
            .load_all()
            .into_iter()
            .find(|w| w.cron_id == cron_id)
            .and_then(|w| w.permission_mode)
    }

    /// 孤儿运行收割（主进程冷启动与测试点直接代理）
    pub fn reap_orphan_running_runs(&self) -> usize {
        self.store.reap_orphan_running_runs()
    }

    /// 注入 SchedulerRegistry 委托（装配收口唯一入口；重复注入覆盖）。
    /// 生产装配点 = 壳层装配轮（P6）：core_state.scheduler_registry()
    /// 经本方法注入共享注册表——create 即真实注册调度，不再命令层退化。
    pub fn set_registry(&self, registry: Arc<SchedulerRegistry>) {
        *self.registry.lock().unwrap_or_else(|e| e.into_inner()) = Some(registry);
    }

    /// 注入真实 Agent 执行驱动器（生产装配点 = 壳层 setup）
    pub fn set_launcher(&self, launcher: Arc<dyn crate::sched::ScheduledTaskLauncher>) {
        *self.launcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(launcher);
    }

    /// 当前真实 Agent 执行驱动器句柄
    fn launcher(&self) -> Option<Arc<dyn crate::sched::ScheduledTaskLauncher>> {
        self.launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 注入应用上下文（app_data_dir 与全域事件广播 sink）
    pub fn set_app_context(
        &self,
        app_data_dir: std::path::PathBuf,
        event_sink: Option<Arc<dyn WorkflowEventSink>>,
    ) {
        *self.app_data_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(app_data_dir);
        if let Some(sink) = event_sink {
            *self.event_sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
        }
    }

    fn app_data_dir(&self) -> Option<std::path::PathBuf> {
        self.app_data_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn event_sink(&self) -> Option<Arc<dyn WorkflowEventSink>> {
        self.event_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 回写运行记录终态（供 ProductionScheduledLauncher 终态钩子与测试直接调用）
    #[allow(clippy::too_many_arguments)]
    pub fn finish_run(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        self.store.update_run_finish(
            workflow_id,
            run_id,
            status,
            finished_at_ms,
            duration_ms,
            error,
            output_summary,
        );
    }

    /// INT-04 僵尸会话自愈：抹除已删除的 `target_session_id` 并同步更新注册表与持久化层
    pub fn clear_invalid_target_session(&self, cron_id: &str) {
        let all = self.store.load_all();
        if let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) {
            if workflow.target_session_id.is_some() {
                workflow.target_session_id = None;
                workflow.execution_mode = Some("isolated".to_string());
                workflow.updated_at_ms = now_ms();
                self.store.save(&workflow);
            }
        }
        if let Some(registry) = self.registry() {
            registry.clear_target_session_id(cron_id);
        }
    }

    /// 委托注册表当前句柄
    fn registry(&self) -> Option<Arc<SchedulerRegistry>> {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 创建 workflow（名称/提示词/调度三校验 → 表达式转换 → 落库；
    /// 委托激活时经注册表 register 校验并接入真实调度——注册表 API 为
    /// async，本方法及 update/delete 一并 async（命令体直调，不包
    /// spawn_blocking：store 为轻量 KV 写，少量语句可接受））
    pub async fn create(
        &self,
        name: String,
        prompt: String,
        schedule: WorkflowScheduleWire,
        cwd: Option<String>,
        mode: Option<String>,
        enabled: bool,
    ) -> Result<WorkflowView, CoreError> {
        let name = name.trim().to_string();
        let prompt = prompt.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::InvalidInput("名称不能为空".to_string()));
        }
        if prompt.is_empty() {
            return Err(CoreError::InvalidInput("提示词不能为空".to_string()));
        }
        let expression = schedule_to_expression(&schedule).unwrap_or_default();
        // 委托激活：注册表 register 承担解析校验 + next_fire 计算（真实
        // parse_cron 文案；无未来命中时刻同样拒绝——T-CF-09 语义）
        if let Some(registry) = self.registry() {
            if !expression.is_empty() {
                let input = CronTaskInput {
                    expression: expression.clone(),
                    prompt: prompt.clone(),
                    max_iterations: None,
                    is_daemon: false,
                };
                let cron_id = registry.register(input).await.map_err(map_scheduler_err)?;
                if !enabled {
                    if let Err(e) = registry.pause_task(&cron_id).await {
                        tracing::warn!(target: "workflow", %cron_id, "创建未启用任务时初始暂停失败: {e:?}");
                    }
                }
                // manual（无表达式）不经注册表：命令层独立 id 分配
                let now = now_ms();
                let next_fire_at_ms = next_fire_after_ms(&expression, now).unwrap_or(0);
                let workflow = StoredWorkflow {
                    cron_id,
                    expression,
                    prompt,
                    max_iterations: None,
                    is_daemon: false,
                    next_fire_at_ms,
                    fired_count: 0,
                    status: if enabled {
                        CronTaskStatus::Active
                    } else {
                        CronTaskStatus::Paused
                    },
                    enabled,
                    name,
                    cwd: cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
                    mode: mode.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
                    schedule,
                    target_session_id: None,
                    execution_mode: None,
                    permission_mode: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    last_run_at_ms: None,
                };
                self.store.save(&workflow);
                tracing::info!(
                    target: "workflow",
                    cron_id = %workflow.cron_id,
                    expression = %workflow.expression,
                    "workflow 已创建（委托注册表）"
                );
                return Ok(workflow.view());
            }
        }
        // 独立路径（委托未激活 或 manual）：本地校验 + 本地 next_fire 估算；
        // 无未来命中时刻（2 月 30 日类）→ 拒绝注册（对齐注册表 NoNextFire 语义）
        if !expression.is_empty() {
            validate_cron_expression(&expression).map_err(CoreError::InvalidInput)?;
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let cron_id = format!("{CRON_ID_PREFIX}{seq}");
        let now = now_ms();
        let next_fire_at_ms = if expression.is_empty() {
            0
        } else {
            next_fire_after_ms(&expression, now).ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "cron 表达式 {expression} 无未来触发时刻（如 2 月 30 日），拒绝注册"
                ))
            })?
        };
        let workflow = StoredWorkflow {
            cron_id,
            expression,
            prompt,
            max_iterations: None,
            is_daemon: false,
            next_fire_at_ms,
            fired_count: 0,
            status: if enabled {
                CronTaskStatus::Active
            } else {
                CronTaskStatus::Paused
            },
            enabled,
            name,
            cwd: cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            mode: mode.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
            schedule,
            target_session_id: None,
            execution_mode: None,
            permission_mode: None,
            created_at_ms: now,
            updated_at_ms: now,
            last_run_at_ms: None,
        };
        self.store.save(&workflow);
        tracing::info!(
            target: "workflow",
            cron_id = %workflow.cron_id,
            expression = %workflow.expression,
            "workflow 已创建"
        );
        Ok(workflow.view())
    }

    /// 列出全部 workflow（按创建时间升序，稳定展示；委托激活时以
    /// 注册表 snapshot 为准刷新运行态字段，彻底杜绝冲刷覆盖 DB 启用状态）
    pub fn list(&self) -> Vec<WorkflowView> {
        let mut all = self.store.load_all();
        // 委托激活：snapshot（CronTask）刷新 fired_count / next_fire_at（注册表为调度真源）
        // 彻底删除 workflow.enabled = task.enabled 脏冲刷！仅在 workflow.enabled 为 true 时同步 task.next_fire_at_ms
        if let Some(registry) = self.registry() {
            let snapshot = registry.snapshot();
            for workflow in &mut all {
                if let Some(task) = snapshot.iter().find(|t| t.cron_id == workflow.cron_id) {
                    workflow.fired_count = task.fired_count;
                    if workflow.enabled {
                        workflow.next_fire_at_ms = task.next_fire_at_ms;
                    }
                }
            }
        }
        all.sort_by_key(|w| w.created_at_ms);
        all.iter().map(|w| w.view()).collect()
    }

    /// 更新 workflow（部分字段补丁；调度变化 → 重算表达式与 next_fire；
    /// 原地热更新保持 cron_id 与 created_at_ms 恒定不变；启停联动底座 pause/resume）
    pub async fn update(
        &self,
        cron_id: &str,
        patch: WorkflowPatch,
    ) -> Result<WorkflowView, CoreError> {
        let all = self.store.load_all();
        let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) else {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        };
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
            let changed = prompt != workflow.prompt;
            workflow.prompt = prompt;
            changed
        } else {
            false
        };
        if let Some(cwd) = patch.cwd {
            let cwd = cwd.trim().to_string();
            workflow.cwd = if cwd.is_empty() { None } else { Some(cwd) };
        }
        if let Some(mode) = patch.mode {
            let mode = mode.trim().to_string();
            workflow.mode = if mode.is_empty() { None } else { Some(mode) };
        }
        if let Some(target_sid) = patch.target_session_id.as_ref() {
            let target_sid = target_sid.trim().to_string();
            workflow.target_session_id = if target_sid.is_empty() {
                None
            } else {
                Some(target_sid)
            };
        }
        if let Some(exec_mode) = patch.execution_mode.as_ref() {
            let exec_mode = exec_mode.trim().to_string();
            workflow.execution_mode = if exec_mode.is_empty() {
                None
            } else {
                Some(exec_mode)
            };
        }
        if let Some(perm) = patch.permission_mode.as_ref() {
            let perm = perm.trim().to_string();
            workflow.permission_mode = if perm.is_empty() {
                None
            } else {
                Some(perm)
            };
        }

        let enabled_changed = patch.enabled.is_some() && patch.enabled != Some(workflow.enabled);
        let target_enabled = patch.enabled.unwrap_or(workflow.enabled);

        let schedule_changed = patch.schedule.is_some();
        if let Some(schedule) = patch.schedule {
            let expression = schedule_to_expression(&schedule).unwrap_or_default();
            if !expression.is_empty() {
                validate_cron_expression(&expression).map_err(CoreError::InvalidInput)?;
            }
            workflow.schedule = schedule;
            workflow.expression = expression;
            workflow.next_fire_at_ms = if workflow.expression.is_empty() {
                0
            } else {
                next_fire_after_ms(&workflow.expression, now_ms()).ok_or_else(|| {
                    CoreError::InvalidInput(format!(
                        "cron 表达式 {} 无未来触发时刻（如 2 月 30 日），拒绝更新",
                        workflow.expression
                    ))
                })?
            };
        }

        // 委托注册表热更新与启停联动（保持 cron_id 与 created_at_ms 恒定不变）
        if let Some(registry) = self.registry() {
            let in_registry = registry.snapshot().iter().any(|t| t.cron_id == cron_id);
            if in_registry {
                // 1. 若要暂停且发生状态变化，先调用 pause_task
                if enabled_changed && !target_enabled {
                    registry.pause_task(cron_id).await?;
                }

                // 2. 调度表达式或提示词等原地热更新
                if (schedule_changed || prompt_changed || patch.target_session_id.is_some())
                    && !workflow.expression.is_empty()
                {
                    let task_patch = CronTaskUpdatePatch {
                        expression: if schedule_changed {
                            Some(workflow.expression.clone())
                        } else {
                            None
                        },
                        prompt: if prompt_changed {
                            Some(workflow.prompt.clone())
                        } else {
                            None
                        },
                        max_iterations: None,
                        is_daemon: None,
                        target_session_id: patch
                            .target_session_id
                            .as_ref()
                            .map(|_| workflow.target_session_id.clone()),
                    };
                    registry.update_task(cron_id, task_patch).await?;
                } else if schedule_changed && workflow.expression.is_empty() {
                    // 转为 manual：从注册表中取消调度协程
                    let _ = registry.cancel(cron_id).await;
                }

                // 3. 若要启用且发生状态变化，执行恢复
                if enabled_changed && target_enabled {
                    registry.resume_task(cron_id).await?;
                }

                // 同步注册表运行态中的 next_fire_at_ms
                if let Some(task) = registry.snapshot().iter().find(|t| t.cron_id == cron_id) {
                    if target_enabled {
                        workflow.next_fire_at_ms = task.next_fire_at_ms;
                    }
                }
            }
        }

        workflow.enabled = target_enabled;
        workflow.status = if target_enabled {
            CronTaskStatus::Active
        } else {
            CronTaskStatus::Paused
        };
        workflow.updated_at_ms = now_ms();
        self.store.save(&workflow);
        Ok(workflow.view())
    }

    /// 删除 workflow（委托激活时经注册表 cancel 停调度；清单移除，
    /// 运行历史保留）
    pub async fn delete(&self, cron_id: &str) -> Result<(), CoreError> {
        let exists = self.store.load_all().iter().any(|w| w.cron_id == cron_id);
        if !exists {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        }
        if let Some(registry) = self.registry() {
            if let Err(e) = registry.cancel(cron_id).await {
                // IdNotFound 视为幂等成功：manual 任务（创建时表达式为空，
                // 从未注册进 registry）、已达 max_iterations 的任务（终态
                // 清理时已 map.remove）、cron 转 manual 的任务（update 时
                // 已 cancel）都不在 registry 内存表中，此时仍需继续走
                // store.remove 完成删除；其他错误照常返回。
                if !matches!(e, crate::sched::SchedulerError::IdNotFound) {
                    return Err(map_scheduler_err(e));
                }
            }
        }
        self.store.remove(cron_id);
        tracing::info!(target: "workflow", cron_id, "workflow 已删除");
        Ok(())
    }

    /// 立即触发一次（复用触发路径：fired_count 计入 + steering 条目注入 + 真实 Agent 执行驱动）。
    ///
    /// - 当 `launcher` 已注入时：先写入 `status: "running"` 运行记录（`duration_ms: None`），
    ///   随后异步派发 `ScheduledTaskLauncher::launch_scheduled_task` 驱动真实 Agent 执行，
    ///   在 Agent 执行完毕后回写 `completed` / `failed` 终态、真实耗时与摘要；
    /// - 当 `launcher` 未注入时（轻量单测环境）：退化为同步落盘 `completed` 记录，保持向后兼容。
    pub fn trigger(&self, cron_id: &str) -> Result<TriggerResult, CoreError> {
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

        // INT-04：检查绑定的 target_session_id 是否依然存在，若已被删除则自愈抹除并降级为独立会话
        let resolved_target_session_id = match workflow
            .target_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(sid) => {
                if self.store.session_exists(sid) {
                    Some(sid.to_string())
                } else {
                    tracing::warn!(
                        target: "workflow",
                        cron_id = %workflow.cron_id,
                        deleted_session_id = %sid,
                        "手动触发时发现绑定的目标会话已删除，自动抹除 target_session_id 并自愈降级为独立后台会话"
                    );
                    workflow.target_session_id = None;
                    workflow.execution_mode = Some("isolated".to_string());
                    if let Some(registry) = self.registry() {
                        registry.clear_target_session_id(&workflow.cron_id);
                    }
                    None
                }
            }
            None => None,
        };

        // INT-02：空 cwd 或不存在路径兜底至 <app_data_dir>/scheduled-tasks-sandbox
        let effective_cwd =
            resolve_effective_workflow_cwd(workflow.cwd.as_deref(), self.app_data_dir().as_deref());

        workflow.fired_count += 1;
        workflow.last_run_at_ms = Some(now);
        if !workflow.expression.is_empty() {
            workflow.next_fire_at_ms = next_fire_after_ms(&workflow.expression, now).unwrap_or(0);
        }
        workflow.updated_at_ms = now;
        self.store.save(&workflow);

        // steering 条目（§4.8 冻结模板：prompt + 第 N 次触发；§4.3 绑定目标会话动态路由）
        let formatted_prompt = format!(
            "{}（cron {} 第 {} 次触发）",
            workflow.prompt, workflow.cron_id, workflow.fired_count
        );
        self.sink.enqueue_steering(
            cron_id,
            formatted_prompt.clone(),
            now,
            resolved_target_session_id.as_deref(),
        );
        tracing::info!(
            target: "workflow",
            cron_id = %workflow.cron_id,
            fired_count = workflow.fired_count,
            target_session_id = resolved_target_session_id.as_deref().unwrap_or("<none>"),
            "workflow 手动触发：steering 条目已入队"
        );

        // 前缀用 manual-fire- 与 cron 路径的 fire-（sched.rs 触发协程
        // `<cron_id>-fire-<iteration>`）隔离：两套计数器（fired_count vs
        // iteration）同起点，若共用 fire- 格式，"手动触发后紧跟 cron 触发"
        // 会产出相同 run_id，register_scheduled_run_hook（HashMap::insert
        // 按 run_id 覆盖）会顶掉在途钩子，终态回写永久丢失。
        let run_id = format!("{}-manual-fire-{}", workflow.cron_id, workflow.fired_count);
        let launcher_opt = self.launcher();
        let session_id = resolved_target_session_id.clone().unwrap_or_else(|| {
            if launcher_opt.is_some() {
                format!("sched-run-{}-{}", workflow.cron_id, now)
            } else {
                format!("sched-{}-{}", workflow.cron_id, workflow.fired_count)
            }
        });

        if let Some(launcher) = launcher_opt {
            // 真实 Agent 执行链路：初始落盘 running（duration_ms = None, finished_at_ms = None）
            let running_record = WorkflowRunRecord {
                workflow_id: workflow.cron_id.clone(),
                run_id: run_id.clone(),
                session_id: Some(session_id.clone()),
                trigger_kind: "manual".to_string(),
                scheduled_for_ms: now,
                started_at_ms: now,
                finished_at_ms: None,
                duration_ms: None,
                status: "running".to_string(),
                prompt: workflow.prompt.clone(),
                error: None,
                output_summary: None,
            };
            self.store.append_or_update_run(running_record);

            let ctx = crate::sched::ScheduledExecutionContext {
                cron_id: workflow.cron_id.clone(),
                run_id: run_id.clone(),
                prompt: formatted_prompt,
                expression: workflow.expression.clone(),
                iteration: workflow.fired_count,
                fired_at_ms: now,
                scheduled_for_ms: now,
                trigger_kind: "manual".to_string(),
                is_daemon: workflow.is_daemon,
                target_session_id: resolved_target_session_id,
                cwd: effective_cwd,
            };
            let store = Arc::clone(&self.store);
            let sink_opt = self.event_sink();
            let wf_id_for_task = workflow.cron_id.clone();
            let run_id_for_task = run_id.clone();

            let drive_fut = async move {
                match launcher.launch_scheduled_task(ctx).await {
                    Ok(handle) => {
                        if !handle.async_terminal_managed {
                            let finished_at = now_ms().max(now);
                            let duration = finished_at.saturating_sub(now);
                            let summary = handle.immediate_output_summary.unwrap_or_else(|| {
                                format!(
                                    "手动触发完成（会话 {}，第 {} 次）",
                                    handle.session_id, workflow.fired_count
                                )
                            });
                            store.update_run_finish(
                                &wf_id_for_task,
                                &run_id_for_task,
                                "completed",
                                finished_at,
                                duration,
                                None,
                                Some(summary.clone()),
                            );
                            if let Some(sink) = sink_opt.as_ref() {
                                sink.emit(
                                    "workflow:run-Completed",
                                    serde_json::json!({
                                        "workflowId": wf_id_for_task,
                                        "runId": run_id_for_task,
                                        "sessionId": handle.session_id,
                                        "status": "completed",
                                        "startedAtMs": now,
                                        "finishedAtMs": finished_at,
                                        "durationMs": duration,
                                        "outputSummary": summary,
                                    }),
                                );
                                sink.emit(
                                    "workflow:updated",
                                    serde_json::json!({ "workflowId": wf_id_for_task }),
                                );
                            }
                        }
                    }
                    Err(err) => {
                        let finished_at = now_ms().max(now);
                        let duration = finished_at.saturating_sub(now);
                        let err_msg = err.to_string();
                        store.update_run_finish(
                            &wf_id_for_task,
                            &run_id_for_task,
                            "failed",
                            finished_at,
                            duration,
                            Some(err_msg.clone()),
                            None,
                        );
                        if let Some(sink) = sink_opt.as_ref() {
                            sink.emit(
                                "workflow:run-Completed",
                                serde_json::json!({
                                    "workflowId": wf_id_for_task,
                                    "runId": run_id_for_task,
                                    "status": "failed",
                                    "startedAtMs": now,
                                    "finishedAtMs": finished_at,
                                    "durationMs": duration,
                                    "error": err_msg,
                                }),
                            );
                            sink.emit(
                                "workflow:updated",
                                serde_json::json!({ "workflowId": wf_id_for_task }),
                            );
                        }
                    }
                }
            };

            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(drive_fut);
            } else {
                std::thread::spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        rt.block_on(drive_fut);
                    }
                });
            }
        } else {
            // 未注入 launcher 时（单元/集成测试环境）：兼容存量同步落盘语义
            let record = WorkflowRunRecord {
                workflow_id: workflow.cron_id.clone(),
                run_id: run_id.clone(),
                session_id: Some(session_id.clone()),
                trigger_kind: "manual".to_string(),
                scheduled_for_ms: now,
                started_at_ms: now,
                finished_at_ms: Some(now),
                duration_ms: Some(0),
                status: "completed".to_string(),
                prompt: workflow.prompt.clone(),
                error: None,
                output_summary: Some(format!(
                    "手动立即触发成功（第 {} 次）",
                    workflow.fired_count
                )),
            };
            self.store.append_or_update_run(record);
        }

        tracing::info!(
            target: "workflow",
            cron_id,
            fired_count = workflow.fired_count,
            "workflow 已立即触发"
        );
        Ok(TriggerResult {
            run_id: Some(run_id),
            session_id: Some(session_id),
        })
    }

    /// 运行历史（可按 workflowId 过滤；按开始时间倒序；支持上限数量限制）
    ///
    /// 注意：此处严禁调用 reap_orphan_running_runs()。reaper 只能在冷启动
    /// （WorkflowBackend::new）执行：真实 Agent 执行链路先落 `status:"running"`
    /// 记录再异步执行（可达数分钟），在途 run 的 running 记录是合法状态；
    /// 若在 list_runs 热路径收割，前端任何一次历史查询都会把执行中的任务
    /// 误标为 interrupted 并写入错误文案。
    pub fn list_runs(
        &self,
        workflow_id: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<WorkflowRunView> {
        let mut runs = self.store.load_runs();
        if let Some(id) = workflow_id {
            runs.retain(|r| r.workflow_id == id);
        }
        runs.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        let cap = limit.unwrap_or(50).clamp(1, 200);
        runs.into_iter().take(cap).map(|r| r.view()).collect()
    }
}

/// 更新补丁（命令入参部分字段）
#[derive(Default)]
pub struct WorkflowPatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<WorkflowScheduleWire>,
    pub cwd: Option<String>,
    pub mode: Option<String>,
    pub enabled: Option<bool>,
    pub target_session_id: Option<String>,
    pub execution_mode: Option<String>,
    pub permission_mode: Option<String>,
}

/// 立即触发结果（runId / sessionId 由引擎触发路径产出，当前为空）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerResult {
    pub run_id: Option<String>,
    pub session_id: Option<String>,
}

/// SchedulerError → CoreError（结构化映射：非法表达式/无命中 → InvalidInput，
/// 未知 id → NotFound）
fn map_scheduler_err(err: crate::sched::SchedulerError) -> CoreError {
    match err {
        crate::sched::SchedulerError::InvalidExpression(detail) => {
            CoreError::InvalidInput(format!("cron 表达式非法：{detail}"))
        }
        crate::sched::SchedulerError::NoNextFire(expression) => CoreError::InvalidInput(format!(
            "cron 表达式 {expression} 无未来触发时刻（如 2 月 30 日），拒绝注册"
        )),
        crate::sched::SchedulerError::IdNotFound => {
            CoreError::NotFound("cron 任务不存在或已停止".to_string())
        }
    }
}

/// 从 cron id 解析序号（`cron-<seq>` → seq）
fn cron_seq(cron_id: &str) -> Option<u64> {
    cron_id
        .strip_prefix(CRON_ID_PREFIX)
        .and_then(|seq| seq.parse::<u64>().ok())
}

/// 把调度入参 Value 解析为 wire 枚举（命令入参容错层）
pub fn parse_schedule_input(
    value: Option<&serde_json::Value>,
) -> Result<WorkflowScheduleWire, CoreError> {
    match value {
        None => Ok(WorkflowScheduleWire::Manual),
        Some(v) => WorkflowScheduleWire::parse(v).map_err(CoreError::InvalidInput),
    }
}
