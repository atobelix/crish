use std::sync::Arc;

use agent_tools::tools::subagent::SubagentState;
use orchestrator::persist::LocalDbStore;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::subagent_events::{
    build_subagent_ended, SubagentEmitContext, SubagentEndedInfo, SubagentEventEmitter,
};

use super::spawner::SubagentSpawnerImpl;
use super::types::{now_ms, SubagentRunConfig};

impl SubagentSpawnerImpl {
    /// 终态统一处理（子代理 run 收口后由 CoreRunState 调用）：
    /// 记账释放 → 行终态更新 → subagent-ended 发射（非 flow 路径）→
    /// wait 通道 feed → steering 通知（主 agent 下一 run 唤醒）。
    pub async fn on_subagent_terminal(&self, cfg: &SubagentRunConfig, state: SubagentState) {
        let run_id = cfg.subagent_run_id.clone();
        // 终态可能抢在 launcher 返回或 started 事件落库前到达。首个终态先
        // 占用闩锁并等待启动结果及 started 发射尝试，重复终态不重复消费。
        if let Some(lifecycle) = self.launch_lifecycle(&run_id) {
            if !lifecycle.stage_terminal(state) {
                tracing::debug!(
                    target: "subagent_spawner",
                    subagent_run_id = %run_id,
                    "忽略重复或已关闭 run 的子代理终态"
                );
                return;
            }
            if lifecycle.wait_until_terminal_ready().await != Some(state) {
                return;
            }
        }
        // reservation 是该 run 唯一释放 token；unknown/重复终态不会减计数，
        // 也不会重复发射事件。None parent 仍有可精确消费的 token。
        let Some(ownership) = self.tracking.release_run_ownership(&run_id) else {
            tracing::debug!(
                target: "subagent_spawner",
                subagent_run_id = %run_id,
                "忽略未登记或已处理的子代理终态"
            );
            return;
        };
        let parent_run = ownership.parent_run_id;
        let flow_registration = ownership.flow_registration;
        let flow_node_id = flow_registration
            .as_ref()
            .map(|registration| registration.node_id.clone());
        let emit_ended_event = flow_registration
            .as_ref()
            .map(|registration| registration.emit_lifecycle_events)
            .unwrap_or(true);
        // D-02 LK-04：runs 注册表反查子会话 id（run 记录携带子代理会话；
        // remove 取出即释放，供 subagent-ended 反向导航键装配）
        let sub_session_id = ownership.run_record.map(|record| record.session_id);

        // 子代理终态：冲刷摘要（最后一批评审/进展）+ 注销路由
        if let Some(registrar) = self.child_registrar() {
            if let Some(child_session) = sub_session_id.as_deref() {
                registrar.flush_child(child_session).await;
                registrar.unregister_child(child_session);
            }
        }

        // 2. 行终态更新（status/ended_at；产出保留——summary/messages 原样）
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(db) = db {
                let now = now_ms();
                let loaded = db.load_session_agents(&cfg.parent_session_id);
                match loaded {
                    Ok(mut agents) => {
                        if let Some(row) = agents
                            .iter_mut()
                            .find(|a| a.subagent_run_id == cfg.subagent_run_id)
                        {
                            row.status = state.to_db_status().to_string();
                            if row.ended_at.is_none() {
                                row.ended_at = Some(now);
                            }
                            // 正常收口：可恢复标记关闭（中断对账才置 true）；
                            // 心跳停在终态时刻，便于展示最后活跃时间
                            row.resumable = false;
                            row.last_heartbeat_ms = Some(now);
                            row.summary = Some(match state {
                                SubagentState::Completed => "子代理已完成".to_string(),
                                _ => "子代理已结束（失败）".to_string(),
                            });
                        }
                        if let Err(error) = db.save_session_agents(&cfg.parent_session_id, &agents)
                        {
                            tracing::warn!(
                                target: "subagent_spawner",
                                subagent_run_id = %run_id,
                                error = %error,
                                "子代理行终态落库失败（仅告警）"
                            );
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "subagent_spawner",
                            subagent_run_id = %run_id,
                            error = %error,
                            "子代理行终态读取失败（仅告警）"
                        );
                    }
                }
            }
        }

        // 3. subagent-ended 事件：启用 flow 生命周期事件时由 spawner 负责，
        //    FlowScheduler 按 owner 契约跳过重复发射；未启用时仅供 wait 通道
        //    feed 与 steering 摘要使用，不落库事件。
        let mut info =
            SubagentEndedInfo::from_subagent_state(cfg.subagent_id.clone(), run_id.clone(), state);
        // D-02 LK-04：后置赋值子会话 id（runs 注册表反查；None = 注册表
        // 无记录/未接线，前端回退行级反查）
        info.subagent_session_id = sub_session_id;
        let emit_ctx = SubagentEmitContext {
            session_id: cfg.parent_session_id.clone(),
            parent_run_id: parent_run.clone().unwrap_or_default(),
        };
        // LK-07 R-14：双发幂等——kill 命令面已直发 ended(cancelled)（lifecycle
        // kill_all/kill_subagent）时，本收口兜底不再重复发射（同一父 run 归
        // 属性查询 events 表；query_events_by_run 走 idx_events_run 索引，
        // 终态低频可接受）。flow 路径不查（事件由 FlowScheduler 发射）。
        let already_ended = if emit_ended_event {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
            match db {
                Some(db) => {
                    let parent = parent_run.clone().unwrap_or_default();
                    if parent.is_empty() {
                        false
                    } else {
                        db.query_events_by_run(&cfg.parent_session_id, &parent, 0, Some(200))
                            .map(|rows| {
                                rows.iter().any(|e| {
                                    if e.event_type != "subagent-ended" {
                                        return false;
                                    }
                                    if let Ok(val) =
                                        serde_json::from_str::<serde_json::Value>(&e.payload)
                                    {
                                        let sub_id = val.get("subagentId").and_then(|v| v.as_str());
                                        let sub_run_id =
                                            val.get("subagentRunId").and_then(|v| v.as_str());
                                        if sub_id == Some(&cfg.subagent_id)
                                            || sub_run_id == Some(&run_id)
                                        {
                                            return true;
                                        }
                                    }
                                    false
                                })
                            })
                            .unwrap_or(false)
                    }
                }
                None => false,
            }
        } else {
            false
        };
        let event = if emit_ended_event {
            if already_ended {
                // kill 已直发 ended：跳过落库发射（wait 通道仍以本地副本
                // feed 兜底，订阅者收口不丢）
                build_subagent_ended(&emit_ctx, &info)
            } else {
                let emitted = {
                    let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    match db {
                        Some(db) => {
                            let emitter =
                                SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db)));
                            match emitter.emit_ended(&emit_ctx, &info).await {
                                Ok(sequenced) => Some(sequenced.event),
                                Err(error) => {
                                    tracing::warn!(
                                        target: "subagent_spawner",
                                        event = "emit_ended_failed",
                                        subagent_run_id = %run_id,
                                        error = %error,
                                        "subagent-ended 发射失败（wait 通道仍 feed 兜底）"
                                    );
                                    None
                                }
                            }
                        }
                        None => None,
                    }
                };
                emitted.unwrap_or_else(|| build_subagent_ended(&emit_ctx, &info))
            }
        } else {
            // 纯编排 flow 路径不发生命周期事件；本处仅构造副本供 wait
            // 通道 feed 与 steering 摘要。
            build_subagent_ended(&emit_ctx, &info)
        };

        // 4. wait 通道 feed（wait_subagents 订阅者实时唤醒）
        if let Some(stream) = self
            .terminal_stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            stream.feed(&event);
        }

        // 5. steering 通知（主 agent 下一 run 经 decide_idle_resume 唤醒；
        // 摘要模板对齐 wakeup_summary.rs 子代理完成段——role 取展示标签）
        if let Some(queue) = self
            .steering_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            let summary_text = crate::wakeup_summary::wakeup_summary(
                &event,
                &crate::wakeup_summary::SummaryCtx {
                    subagent_role: cfg
                        .task_type
                        .as_deref()
                        .and_then(agent_tools::tools::subagent::TaskType::parse)
                        .map(|t| t.boundary_summary().to_string()),
                    ..crate::wakeup_summary::SummaryCtx::default()
                },
            );
            queue.lock().unwrap_or_else(|e| e.into_inner()).enqueue(
                SteeringInputEntry::steering(
                    format!("subagent-terminal-{run_id}"),
                    summary_text,
                    now_ms() as u64,
                )
                .with_session(&cfg.parent_session_id),
            );
        }

        tracing::info!(
            target: "subagent_spawner",
            subagent_run_id = %run_id,
            status = state.as_str(),
            flow_node_id = ?flow_node_id,
            "子代理终态处理完成（记账释放 + 行更新 + 事件/通知面）"
        );
    }
}
