//! Cron 任务条目与触发核心执行逻辑（T-CF-09 / Phase 2）

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use conex_types::cron::parse_cron;
use tokio::time::Instant;

use super::registry::SchedulerComponents;
use super::types::{now_ms, CronEvent, CronTask, CronTaskStatus, ScheduledExecutionContext};

/// 活跃 cron 条目（tasks 表值）
pub struct CronEntry {
    /// 运行态声明（fired_count / next_fire_at / status 实时刷新）
    pub task: CronTask,
    /// 状态机状态（Active / Paused）
    pub status: CronTaskStatus,
    /// 协程代际编号（仅在物理协程重建或销毁时自增，落实 CRIT-01）
    pub generation: u64,
    /// 触发任务（cancel 经 abort 取消；pause 置 None；fire/resume 重建）
    pub sleep_task: Option<tokio::task::JoinHandle<()>>,
}

/// 触发延迟（next_fire_at_ms 相对当前时刻；测试钩子：注入固定短延迟）
///
/// override 读取无 `cfg(test)` 限定——壳层测试跨 crate 使用
/// [super::registry::SchedulerRegistry::set_fire_override_ms]；生产路径
/// `fire_override` 恒 None，语义等同纯计算。
pub fn fire_delay_ms(components: &SchedulerComponents, next_fire_at_ms: u64) -> u64 {
    if let Some(ms) = *components
        .fire_override
        .lock()
        .unwrap_or_else(|e| e.into_inner())
    {
        return ms;
    }
    next_fire_at_ms.saturating_sub(now_ms())
}

/// spawn 一次触发任务：sleep_until 到期 → fire_cron
pub fn spawn_fire_task(
    components: SchedulerComponents,
    task: CronTask,
    fire_delay_ms: u64,
    generation: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep_until(Instant::now() + Duration::from_millis(fire_delay_ms)).await;
        fire_cron(components, task, false, generation).await;
    })
}

/// 触发一次 cron（spawn 任务 / 重启补发共用）
pub async fn fire_cron(
    components: SchedulerComponents,
    task: CronTask,
    allow_rebuild_without_entry: bool,
    expected_gen: u64,
) {
    // 段 0（R2-12c C31 暂停门控）：暂停期内到点不触发
    if let Some(paused_until) = *components.pause.lock().unwrap_or_else(|e| e.into_inner()) {
        let now = now_ms();
        if now < paused_until {
            let delay = paused_until - now;
            tracing::info!(
                target: "sched",
                cron_id = %task.cron_id,
                delay_ms = delay,
                "cron 暂停期内到点：延后到暂停结束时刻重试（C31）"
            );
            let handle = spawn_fire_task(components.clone(), task.clone(), delay, expected_gen);
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&task.cron_id) {
                Some(entry)
                    if entry.status == CronTaskStatus::Active
                        && entry.generation == expected_gen =>
                {
                    entry.sleep_task = Some(handle);
                }
                None if allow_rebuild_without_entry => {
                    map.insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task,
                            status: CronTaskStatus::Active,
                            generation: expected_gen,
                            sleep_task: Some(handle),
                        },
                    );
                }
                _ => handle.abort(),
            }
            return;
        }
    }

    // 代际防线：校验 if expected_gen != entry.generation { return; }
    let task_to_fire = {
        let map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&task.cron_id) {
            if entry.generation != expected_gen || entry.status != CronTaskStatus::Active {
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    expected_gen,
                    current_gen = entry.generation,
                    status = ?entry.status,
                    "代际已变更或处于非活跃态，放弃触发"
                );
                return;
            }
            entry.task.clone()
        } else if allow_rebuild_without_entry {
            task.clone()
        } else {
            return;
        }
    };

    // 段 1：同步触发核心（幂等守卫 / 事件 / 计数 / 落库）
    let outcome = match std::panic::catch_unwind(AssertUnwindSafe(|| {
        fire_once(&components, &task_to_fire)
    })) {
        Ok(Some(outcome)) => outcome,
        Ok(None) => return,
        Err(panic) => {
            tracing::error!(
                target: "sched",
                cron_id = %task.cron_id,
                panic = %panic_message(panic.as_ref()),
                "cron 触发核心 panic（已兜底，不炸引擎）"
            );
            return;
        }
    };

    // 段 2：唤醒面 / 真实 Agent 启动面（事件与数据面已落库；唤醒摘要按 §4.8 Cron 模板拼接）
    let fire_text = format!(
        "{}（cron {} 第 {} 次触发）",
        outcome.task.prompt, outcome.task.cron_id, outcome.iteration
    );
    let scheduled_launcher = components
        .scheduled_launcher
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(sched_launcher) = scheduled_launcher {
        let ctx = ScheduledExecutionContext {
            cron_id: outcome.task.cron_id.clone(),
            run_id: outcome.run_id.clone(),
            prompt: outcome.task.prompt.clone(),
            expression: outcome.task.expression.clone(),
            iteration: outcome.iteration,
            fired_at_ms: outcome.fired_at_ms,
            scheduled_for_ms: outcome.scheduled_for_ms,
            trigger_kind: "cron".to_string(),
            is_daemon: outcome.task.is_daemon,
            target_session_id: outcome.effective_target_session_id.clone(),
            cwd: outcome.cwd.clone(),
        };
        match sched_launcher.launch_scheduled_task(ctx).await {
            Ok(handle) => {
                if !handle.async_terminal_managed {
                    let finish_now = now_ms();
                    let duration_ms = finish_now.saturating_sub(outcome.fired_at_ms);
                    components.store.finish_run(
                        &outcome.task.cron_id,
                        &outcome.run_id,
                        "completed",
                        finish_now,
                        duration_ms,
                        None,
                        handle.immediate_output_summary,
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    target: "sched",
                    cron_id = %outcome.task.cron_id,
                    run_id = %outcome.run_id,
                    error = %err,
                    "ScheduledTaskLauncher 拉起失败，回写 failed 状态并降级 steering 唤醒"
                );
                let finish_now = now_ms();
                let duration_ms = finish_now.saturating_sub(outcome.fired_at_ms);
                components.store.finish_run(
                    &outcome.task.cron_id,
                    &outcome.run_id,
                    "failed",
                    finish_now,
                    duration_ms,
                    Some(err.to_string()),
                    None,
                );
                components.pending.enqueue_steering(
                    &outcome.task.cron_id,
                    fire_text,
                    outcome.fired_at_ms,
                    outcome
                        .effective_target_session_id
                        .as_deref()
                        .or(outcome.task.target_session_id.as_deref()),
                );
            }
        }
    } else {
        let target_sid = outcome
            .effective_target_session_id
            .as_deref()
            .or(outcome.task.target_session_id.as_deref());
        let launcher = components.launcher.clone();
        if outcome.task.is_daemon {
            let launched = match launcher {
                Some(launcher) => {
                    let prompt = outcome.task.prompt.clone();
                    tokio::task::spawn(async move { launcher.launch(prompt).await })
                        .await
                        .unwrap_or(false)
                }
                None => false,
            };
            if !launched {
                components.pending.enqueue_steering(
                    &outcome.task.cron_id,
                    fire_text,
                    outcome.fired_at_ms,
                    target_sid,
                );
            }
        } else {
            components.pending.enqueue_steering(
                &outcome.task.cron_id,
                fire_text,
                outcome.fired_at_ms,
                target_sid,
            );
        }
    }

    // 段 3：停止判定 / 重建下一次 sleep（同步，catch_unwind 兜底）
    let close = std::panic::catch_unwind(AssertUnwindSafe(|| {
        if outcome.reached_max || outcome.no_next {
            // 终态代际防线：在 reached_max 或 no_next 分支，从 tasks 移除前必须校验 entry.generation == expected_gen
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = map.get(&outcome.task.cron_id) {
                if entry.generation == expected_gen {
                    map.remove(&outcome.task.cron_id);
                    if outcome.reached_max {
                        if let Some(max) = outcome.task.max_iterations {
                            components.pending.enqueue_steering(
                                &outcome.task.cron_id,
                                format!(
                                    "cron {} 已达最大触发次数 {}，已停止",
                                    outcome.task.cron_id, max
                                ),
                                now_ms(),
                                outcome
                                    .effective_target_session_id
                                    .as_deref()
                                    .or(outcome.task.target_session_id.as_deref()),
                            );
                        }
                    } else {
                        tracing::warn!(
                            target: "sched",
                            cron_id = %outcome.task.cron_id,
                            "cron 无后续触发时刻，已停止（status=Completed 已落库）"
                        );
                    }
                } else {
                    tracing::info!(
                        target: "sched",
                        cron_id = %outcome.task.cron_id,
                        current_gen = entry.generation,
                        expected_gen,
                        "代际已变更，豁免终态清理"
                    );
                }
            }
        } else {
            // 提示词防冲刷：在段 3，严禁粗暴 entry.task = outcome.task！
            // 更新统计字段（fired_count, next_fire_at_ms, updated_at_ms），
            // 使用 entry 当前内存最新的 prompt 与配置派生下一次计时协程
            let delay = fire_delay_ms(&components, outcome.task.next_fire_at_ms);
            let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            match map.get_mut(&outcome.task.cron_id) {
                Some(entry)
                    if entry.status == CronTaskStatus::Active
                        && entry.generation == expected_gen =>
                {
                    entry.task.fired_count = outcome.task.fired_count;
                    entry.task.next_fire_at_ms = outcome.task.next_fire_at_ms;
                    entry.task.updated_at_ms = outcome.task.updated_at_ms;

                    let next_task = entry.task.clone();
                    let handle =
                        spawn_fire_task(components.clone(), next_task, delay, expected_gen);
                    if let Some(old_h) = entry.sleep_task.replace(handle) {
                        old_h.abort();
                    }
                }
                None if allow_rebuild_without_entry => {
                    let handle = spawn_fire_task(
                        components.clone(),
                        outcome.task.clone(),
                        delay,
                        expected_gen,
                    );
                    map.insert(
                        outcome.task.cron_id.clone(),
                        CronEntry {
                            task: outcome.task,
                            status: CronTaskStatus::Active,
                            generation: expected_gen,
                            sleep_task: Some(handle),
                        },
                    );
                }
                _ => {
                    tracing::info!(
                        target: "sched",
                        cron_id = %outcome.task.cron_id,
                        "触发收口时检测到任务非 Active 或代际已变更，中止重建，防复活守卫生效"
                    );
                }
            }
        }
    }));
    if let Err(panic) = close {
        tracing::error!(
            target: "sched",
            cron_id = %task.cron_id,
            panic = %panic_message(panic.as_ref()),
            "cron 触发收口 panic（已兜底，不炸引擎）"
        );
    }
}

/// 触发核心（同步段；spawn 任务 / 重启补发共用）：
/// 幂等守卫 → 发射 CronFired（Critical）→ fired_count += 1 落库 →
/// 计算下一次触发。返回 None = 守卫命中（应跳过）。
pub struct FireOutcome {
    pub task: CronTask,
    pub run_id: String,
    pub iteration: u64,
    pub fired_at_ms: u64,
    pub scheduled_for_ms: u64,
    pub reached_max: bool,
    pub no_next: bool,
    pub effective_target_session_id: Option<String>,
    pub cwd: Option<String>,
}

pub fn fire_once(components: &SchedulerComponents, task: &CronTask) -> Option<FireOutcome> {
    if !task.status.is_active() {
        return None;
    }
    {
        let map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&task.cron_id) {
            if entry.status != CronTaskStatus::Active {
                return None;
            }
        }
    }
    let now = now_ms();
    let iteration = task.fired_count + 1;
    let scheduled_for_ms = task.next_fire_at_ms;

    // 1. 事件（Critical 数据面落库）
    components.events.emit(CronEvent::Fired {
        cron_id: task.cron_id.clone(),
        prompt: task.prompt.clone(),
        expression: task.expression.clone(),
        iteration,
        fired_at_ms: now,
    });

    // 2. fired_count += 1 + 计算下一次触发时刻
    let mut updated = task.clone();
    updated.fired_count = iteration;
    updated.updated_at_ms = now;
    let mut no_next = false;
    match parse_cron(&task.expression) {
        Ok(schedule) => match schedule.next_fire_after(now) {
            Some(next) => updated.next_fire_at_ms = next,
            None => no_next = true,
        },
        Err(error) => {
            tracing::error!(
                target: "sched",
                cron_id = %task.cron_id,
                error = %format!("{error:?}"),
                "cron 表达式重解析失败（防御路径），停止任务"
            );
            no_next = true;
        }
    }

    // 3. MaxIterations 判定
    let reached_max = updated
        .max_iterations
        .is_some_and(|max| updated.fired_count >= max);
    if reached_max || no_next {
        updated.set_status(CronTaskStatus::Completed);
    }

    // 3b. INT-04 僵尸会话自愈检测：若绑定了 target_session_id 但该会话已被删除，自动降级为独立会话并清除失效绑定
    let (ext_cwd, ext_target_sid) = components.store.load_task_ext_meta(&task.cron_id);
    let candidate_target_sid = updated
        .target_session_id
        .clone()
        .or(ext_target_sid)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut target_sid_self_healed = false;
    let effective_target_session_id = match candidate_target_sid {
        Some(sid) => {
            if components.store.session_exists(&sid) {
                Some(sid)
            } else {
                tracing::warn!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    invalid_session_id = %sid,
                    "到期触发检测：绑定的目标会话已不存在，自动自愈降级为独立后台会话并清除失效绑定（INT-04）"
                );
                updated.target_session_id = None;
                target_sid_self_healed = true;
                None
            }
        }
        None => None,
    };

    // 4. 防冲刷原子校验：在准备写库前，校验该任务在内存中是否仍处于 Active 态；若在计算期间已被外部置为 Paused/Cancelled，跳过保存
    {
        let mut map = components.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&task.cron_id) {
            if entry.status != CronTaskStatus::Active {
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    status = ?entry.status,
                    "任务在触发计算期间已被置为非 Active 态，跳过保存防冲刷"
                );
                return None;
            }
            if target_sid_self_healed {
                entry.task.target_session_id = None;
            }
        }
    }

    // 5. 落库
    if target_sid_self_healed {
        components.store.clear_target_session_id(&task.cron_id);
    }
    components.store.save(&updated);

    // 6. 运行历史（绑定了生产 ScheduledTaskLauncher 时先写 running 初始态，待终态钩子回写；未绑定时保持单测同步闭环）
    let has_scheduled_launcher = components
        .scheduled_launcher
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let run_id = format!("{}-fire-{}", task.cron_id, iteration);
    let run_record = if has_scheduled_launcher {
        let session_id = effective_target_session_id
            .clone()
            .unwrap_or_else(|| format!("sched-run-{}-{}", task.cron_id, now));
        crate::workflow::WorkflowRunRecord {
            workflow_id: task.cron_id.clone(),
            run_id: run_id.clone(),
            session_id: Some(session_id),
            trigger_kind: "cron".to_string(),
            scheduled_for_ms,
            started_at_ms: now,
            finished_at_ms: None,
            duration_ms: None,
            status: "running".to_string(),
            prompt: task.prompt.clone(),
            error: None,
            output_summary: None,
        }
    } else {
        let session_id = effective_target_session_id
            .clone()
            .unwrap_or_else(|| format!("sched-{}-{}", task.cron_id, iteration));
        crate::workflow::WorkflowRunRecord {
            workflow_id: task.cron_id.clone(),
            run_id: run_id.clone(),
            session_id: Some(session_id),
            trigger_kind: "cron".to_string(),
            scheduled_for_ms,
            started_at_ms: now,
            finished_at_ms: Some(now),
            duration_ms: Some(0),
            status: "completed".to_string(),
            prompt: task.prompt.clone(),
            error: None,
            output_summary: Some(format!("定时调度自动触发（第 {} 次）", iteration)),
        }
    };
    components.store.append_run(&run_record);

    Some(FireOutcome {
        task: updated,
        run_id,
        iteration,
        fired_at_ms: now,
        scheduled_for_ms,
        reached_max,
        no_next,
        effective_target_session_id,
        cwd: ext_cwd,
    })
}

/// panic 载荷 → 人读文本（日志兜底用）
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "非字符串 panic 载荷".to_string()
}
