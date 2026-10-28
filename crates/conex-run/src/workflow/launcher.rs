//! ScheduledTaskLauncher 生产实现：定时触发 → steering 注入 / 真实 run 装配。

use std::sync::Arc;

use async_trait::async_trait;
use orchestrator::steering_queue::SteeringInputEntry;

use crate::core_error::CoreError;
use crate::workflow::sinks::WorkflowEventSink;
use crate::workflow::{WorkflowBackend, CRON_ID_PREFIX};

/// 全局默认安全沙箱目录兜底（INT-02）：
/// - 若 `configured_cwd` 非空且在磁盘上存在，直接返回该路径；
/// - 若 `configured_cwd` 为 `None`、空字符串或目录不存在，自动解析并创建
///   `<app_data_dir>/scheduled-tasks-sandbox`（无 `app_data_dir` 时退化到系统临时目录下的同名子目录），
///   确保 `ReadFile` / `WriteFile` / `Bash` 等内置工具拥有合法工作目录，杜绝因空 `cwd` 报 `InvalidConfig`。
pub fn resolve_effective_workflow_cwd(
    configured_cwd: Option<&str>,
    app_data_dir: Option<&std::path::Path>,
) -> Option<String> {
    if let Some(raw) = configured_cwd {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).exists() {
            return Some(trimmed.to_string());
        }
    }
    let base = app_data_dir
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);
    let sandbox = base.join("scheduled-tasks-sandbox");
    if let Err(e) = std::fs::create_dir_all(&sandbox) {
        tracing::warn!(
            target: "workflow",
            path = %sandbox.display(),
            "创建定时任务默认沙箱目录失败: {e}"
        );
    }
    Some(sandbox.to_string_lossy().to_string())
}

/// 生产环境定时任务真实 Agent 执行派发器（连接 `SchedulerRegistry` /
/// `WorkflowBackend` 与 `run_task_impl`；事件广播经 [WorkflowEventSink]
/// 注入——本 crate 不感知 Tauri）
pub struct ProductionScheduledLauncher {
    event_sink: Arc<dyn WorkflowEventSink>,
    core_state: Arc<crate::run::CoreRunState>,
    workflow_backend: Arc<WorkflowBackend>,
    app_data_dir: std::path::PathBuf,
}

impl ProductionScheduledLauncher {
    pub fn new(
        event_sink: Arc<dyn WorkflowEventSink>,
        core_state: Arc<crate::run::CoreRunState>,
        workflow_backend: Arc<WorkflowBackend>,
        app_data_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            event_sink,
            core_state,
            workflow_backend,
            app_data_dir,
        }
    }
}

#[async_trait]
impl crate::sched::ScheduledTaskLauncher for ProductionScheduledLauncher {
    async fn launch_scheduled_task(
        &self,
        ctx: crate::sched::ScheduledExecutionContext,
    ) -> Result<crate::sched::ScheduledRunHandle, CoreError> {
        let started_at_ms = ctx.fired_at_ms;
        // 1. INT-02：空 cwd 或目录不存在时回退到 <app_data_dir>/scheduled-tasks-sandbox
        let effective_cwd =
            resolve_effective_workflow_cwd(ctx.cwd.as_deref(), Some(&self.app_data_dir));

        // 2. INT-04：判定 target_session_id 是否存在，若原会话已被删除则自愈降级并抹除脏绑定
        let effective_session_id = match ctx
            .target_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(sid) => {
                if self.workflow_backend.store().session_exists(sid) {
                    sid.to_string()
                } else {
                    tracing::warn!(
                        target: "workflow",
                        workflow_id = %ctx.cron_id,
                        deleted_session_id = %sid,
                        "绑定的目标会话已不存在，自动抹除 target_session_id 并自愈降级为独立后台会话"
                    );
                    self.workflow_backend
                        .clear_invalid_target_session(&ctx.cron_id);
                    format!("sched-run-{}-{}", ctx.cron_id, started_at_ms)
                }
            }
            None => format!("sched-run-{}-{}", ctx.cron_id, started_at_ms),
        };

        // 3. 若目标会话当前已有活跃 run 在执行（busy），通过 steering 队列注入唤醒，避免并发冲突报错
        let session_busy = {
            let active = self
                .core_state
                .active_runs()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            active
                .values()
                .any(|r| r.session_id == effective_session_id)
        };
        if session_busy {
            let entry = SteeringInputEntry {
                session_id: effective_session_id.clone(),
                id: format!("{}-{started_at_ms}", ctx.cron_id),
                text: ctx.prompt.clone(),
                attachments: Vec::new(),
                enqueued_at: started_at_ms,
                group_id: Some(format!("{CRON_ID_PREFIX}{}", ctx.cron_id)),
                is_steering: true,
            };
            let mut queue = self
                .core_state
                .pending_queue
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            queue.replace_or_enqueue(entry);
            tracing::info!(
                target: "workflow",
                cron_id = %ctx.cron_id,
                session_id = %effective_session_id,
                "目标会话忙碌：workflow 触发降级为 steering 队列注入"
            );
            return Ok(crate::sched::ScheduledRunHandle {
                run_id: ctx.run_id,
                session_id: effective_session_id.clone(),
                async_terminal_managed: false,
                immediate_output_summary: Some(format!(
                    "目标会话 {} 忙碌中，已通过 steering 队列注入唤醒",
                    effective_session_id
                )),
            });
        }

        // 4. 在调用 run_task_impl 前预注册终态回写钩子（零竞态）：
        //    当 Agent Loop 在后台真正结束（Completed / Failed / Cancelled）时，
        //    回写 WorkflowRunRecord 终态并广播 workflow:run-Completed 与 workflow:updated 事件
        let backend = Arc::clone(&self.workflow_backend);
        let event_sink = Arc::clone(&self.event_sink);
        crate::run::register_scheduled_run_hook(
            ctx.run_id.clone(),
            ctx.cron_id.clone(),
            started_at_ms,
            Arc::new(move |outcome| {
                backend.finish_run(
                    &outcome.workflow_id,
                    &outcome.run_id,
                    &outcome.status,
                    outcome.finished_at_ms,
                    outcome.duration_ms,
                    outcome.error.clone(),
                    outcome.output_summary.clone(),
                );
                event_sink.emit(
                    "workflow:run-Completed",
                    serde_json::json!({
                        "workflowId": outcome.workflow_id,
                        "runId": outcome.run_id,
                        "sessionId": outcome.session_id,
                        "status": outcome.status,
                        "startedAtMs": outcome.started_at_ms,
                        "finishedAtMs": outcome.finished_at_ms,
                        "durationMs": outcome.duration_ms,
                        "error": outcome.error,
                        "outputSummary": outcome.output_summary,
                    }),
                );
                event_sink.emit(
                    "workflow:updated",
                    serde_json::json!({
                        "workflowId": outcome.workflow_id,
                    }),
                );
            }),
        );

        // 5. 确定权限模式（无人值守定时工作流）：
        // 优先从 workflow 定义中读取配置的 permissionMode；未显式配置时默认
        // "smart"（无人值守不得默认最高权限：Full 会跳过一切审批）。
        // 历史别名（plan/deep 等只读语义）统一经 run 域解析器回落 Ask。
        let configured_mode = self
            .workflow_backend
            .get_workflow_permission_mode(&ctx.cron_id);
        let workflow_permission = crate::run::parse_permission_mode(configured_mode.as_deref())
            .as_str()
            .to_string();

        // 6. 调用真实 Agent 执行入口 `run_task_impl`
        let options = crate::run::RunTaskOptions {
            run_id: ctx.run_id.clone(),
            session_id: effective_session_id.clone(),
            prompt: Some(ctx.prompt.clone()),
            mode: Some("scheduled".to_string()),
            cwd: effective_cwd,
            permission_mode: Some(workflow_permission),
            client_message_id: None,
            assistant_client_message_id: None,
            system_prompt: None,
            history: None,
            context_window: None,
            max_turns: Some(0), // 无人值守定时工作流默认 0 代表无上限循环预算
            parent_run_id: None,
            subagent_config: None,
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
            reasoning_effort: None,
            context_state: None,
            content: None,
            has_images: None,
        };

        match crate::run::run_task_impl(Arc::clone(&self.core_state), options).await {
            Ok(response) => Ok(crate::sched::ScheduledRunHandle {
                run_id: response.run_id,
                session_id: response.session_id,
                async_terminal_managed: true,
                immediate_output_summary: None,
            }),
            Err(err) => {
                // 若在启动门禁阶段失败（尚未触发 finalize_failed），注销预注册钩子并交由调用方标记 failed
                let _ = crate::run::take_scheduled_run_hook(&ctx.run_id);
                Err(err)
            }
        }
    }
}
