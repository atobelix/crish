use std::sync::Arc;

use agent_tools::tools::subagent::{
    check_ancestor_chain, DeadlockCheckInput, SubagentSpawnError, SubagentSpawnRequest,
    SubagentSpawnResult, SubagentState,
};
use conex_types::events::SubagentEndStatus;
use conex_types::SessionAgent;
use orchestrator::persist::LocalDbStore;
use orchestrator::subagent_events::{
    started_info_from_spawn, SubagentEmitContext, SubagentEndedInfo, SubagentEventEmitter,
};

use super::capacity::{CapacityReservation, SpawnIds};
use super::lifecycle::{RunLaunchLifecycle, StartedEventCompletionGuard};
use super::spawner::SubagentSpawnerImpl;
use super::tracking::{FlowRegistration, RunRecord};
use super::types::{now_ms, SubagentRunConfig};
use crate::core_run_commands::RunTaskOptions;
use crate::engine::now_iso_utc;

impl SubagentSpawnerImpl {
    /// 落库 + 记账 + 启动 + 结果（守卫已在调用方完成——单发经 [Self::spawn]
    /// 检查，批量经 [Self::spawn_many] 前瞻统一检查；此处不重复检查，否则
    /// 批量逐条路径会与「前瞻预加」判定产生中间态偏差）
    pub(crate) async fn spawn_unchecked(
        &self,
        req: &SubagentSpawnRequest,
        depth: usize,
        parent_run: Option<String>,
        ids: &SpawnIds,
        reservation: &mut CapacityReservation,
        emit_flow_lifecycle_events: bool,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        // 标识在容量预留之前已生成，便于 launcher await 前注册终态 owner。
        let subagent_id = ids.subagent_id.clone();
        let subagent_run_id = ids.subagent_run_id.clone();
        let session_id = ids.session_id.clone();
        let now = now_ms();

        // 2. session_agents 落库（pending 首写即 running；v6 新列随行）
        //    db 访问收敛在块内（MutexGuard 不跨 await 持有——AA-02 并发模型）
        //    单行 upsert（11-T3）：ON CONFLICT DO UPDATE，不触碰既有行与
        //    messages（全量先删后插在并发写面已废弃）
        let row = self.row_for(req, &subagent_id, &subagent_run_id, &session_id, depth, now);
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let Some(db) = db.as_ref() else {
                return Err(SubagentSpawnError::PersistFailed(
                    "session_agents 存储未注入（LocalDb 未装配）".to_string(),
                ));
            };
            db.upsert_session_agent(&row)
                .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
            // 会话索引条目幂等写入（子代理独立会话；与前端会话列表同表）
            let entry = conex_types::SessionIndexEntry {
                id: session_id.clone(),
                title: format!("子代理 {subagent_id}"),
                folder: String::new(),
                is_pinned: false,
                is_archived: false,
                branch_parent_id: None,
                timestamp: now_iso_utc(),
                updated_at: now,
                message_count: 0,
                pinned_message_ids: None,
                engine_cursor: Some(0),
                engine_last_run_id: Some(subagent_run_id.clone()),
                hydrated_from_engine: Some(true),
            };
            if let Err(error) = db.upsert_session_entry(&entry) {
                // 会话条目写入失败仅告警（run 启动仍可进行；行落库已成功）
                tracing::warn!(
                    target: "subagent_spawner",
                    subagent_id = %subagent_id,
                    error = %error,
                    "子代理会话条目写入失败（仅告警）"
                );
            }
        }

        // 所有 run 归属和生命周期闩锁必须在 launcher await 前登记；快速终态
        // 先暂存，只有 launcher 确认成功后才允许完成终态副作用。
        let lifecycle = Arc::new(RunLaunchLifecycle::new());
        self.tracking
            .launch_lifecycles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(subagent_run_id.clone(), Arc::clone(&lifecycle));
        self.tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(subagent_run_id.clone(), depth);
        self.tracking
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                subagent_run_id.clone(),
                RunRecord {
                    session_id: session_id.clone(),
                    parent_run_id: parent_run.clone(),
                },
            );
        if let Some(node_id) = &req.flow_node_id {
            self.tracking
                .flow_nodes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    subagent_run_id.clone(),
                    FlowRegistration {
                        node_id: node_id.clone(),
                        emit_lifecycle_events: emit_flow_lifecycle_events,
                    },
                );
        }

        // 3. 独立 run 启动（core_run_task 同通道）。启动过程及其成功/失败
        //    收口放在独立任务中；调用方取消只放弃等待，不会取消已交给 launcher
        //    的启动操作，也不会丢掉 owner token 或 started 事件。
        let config = SubagentRunConfig {
            subagent_id: subagent_id.clone(),
            subagent_run_id: subagent_run_id.clone(),
            parent_session_id: req.parent_session_id.clone(),
            task_type: req.task_type.map(|t| t.as_str().to_string()),
            allowed_write_paths: req.allowed_write_paths.as_ref().map(|paths| {
                paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect()
            }),
            output_dir: None,
            started_at_ms: now,
        };
        let launch_options = RunTaskOptions {
            run_id: subagent_run_id.clone(),
            session_id: session_id.clone(),
            prompt: Some(req.prompt.clone()),
            mode: req.mode.clone().or_else(|| Some("research".to_string())),
            cwd: None,
            permission_mode: None,
            client_message_id: None,
            assistant_client_message_id: None,
            system_prompt: None,
            history: None,
            context_window: None,
            parent_run_id: parent_run.clone(),
            subagent_config: Some(config),
            // D5 §3.1：子代理 run 非 goal 模式，goal 三字段恒 None。
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
            reasoning_effort: None,
            context_state: None,
            content: None,
            has_images: None,
        };
        let started_context = SubagentEmitContext {
            session_id: req.parent_session_id.clone(),
            parent_run_id: parent_run.clone().unwrap_or_default(),
        };
        let started_request = req.clone();
        let started_result = SubagentSpawnResult {
            subagent_id: subagent_id.clone(),
            subagent_run_id: subagent_run_id.clone(),
            session_id: session_id.clone(),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        };
        let started_info = started_info_from_spawn(&started_request, &started_result);
        let emit_started_event = req.flow_node_id.is_none() || emit_flow_lifecycle_events;
        let failed_context = SubagentEmitContext {
            session_id: req.parent_session_id.clone(),
            parent_run_id: parent_run.clone().unwrap_or_default(),
        };
        let failed_info = SubagentEndedInfo {
            subagent_id: subagent_id.clone(),
            subagent_run_id: subagent_run_id.clone(),
            status: SubagentEndStatus::Failed,
            summary: Some("子代理启动失败".to_string()),
            subagent_session_id: Some(session_id.clone()),
        };
        let launcher = self
            .launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let tracking = Arc::clone(&self.tracking);
        let lifecycle_for_launch = Arc::clone(&lifecycle);
        let run_id_for_launch = subagent_run_id.clone();
        let parent_session_id = req.parent_session_id.clone();
        let emit_failure_event = emit_started_event;
        let (launch_tx, launch_rx) = tokio::sync::oneshot::channel();

        // 从此处开始，独立任务持有启动操作与所有完成责任。reservation Drop
        // 不再释放它；失败由任务释放，成功由真实终态释放。
        reservation.begin_launch();
        reservation.transfer_to_background();
        let launcher_task = tokio::spawn(async move {
            match launcher {
                Some(launcher) => launcher
                    .launch(launch_options)
                    .await
                    .map_err(|error| error.to_string()),
                None => Err("子代理 run 启动器未注入（SubagentRunLauncher 未装配）".to_string()),
            }
        });
        tokio::spawn(async move {
            let launch_result = match launcher_task.await {
                Ok(result) => result,
                Err(error) => Err(format!("子代理启动器任务异常终止：{error}")),
            };
            match launch_result {
                Ok(response) => {
                    lifecycle_for_launch.mark_launch_succeeded(false);
                    if emit_started_event {
                        if let Some(db) = db {
                            let lifecycle_for_event = Arc::clone(&lifecycle_for_launch);
                            tokio::spawn(async move {
                                let _completion = StartedEventCompletionGuard(lifecycle_for_event);
                                let emitter =
                                    SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db)));
                                if let Err(error) =
                                    emitter.emit_started(&started_context, &started_info).await
                                {
                                    tracing::warn!(
                                        target: "subagent_spawner",
                                        event = "emit_started_failed",
                                        subagent_run_id = %run_id_for_launch,
                                        error = %error,
                                        "subagent-started 发射失败（终态处理仍等待该事件尝试完成）"
                                    );
                                }
                            });
                        } else {
                            lifecycle_for_launch.mark_started_event_complete();
                        }
                    } else {
                        lifecycle_for_launch.mark_started_event_complete();
                    }
                    let _ = launch_tx.send(Ok(response));
                }
                Err(error) => {
                    lifecycle_for_launch.mark_launch_failed();
                    let _ = tracking.release_run_ownership(&run_id_for_launch);
                    if let Some(db) = db {
                        if let Err(status_error) = db.update_session_agent_status(
                            &parent_session_id,
                            &run_id_for_launch,
                            SubagentState::Failed.to_db_status(),
                            Some(now_ms()),
                        ) {
                            tracing::warn!(
                                target: "subagent_spawner",
                                subagent_run_id = %run_id_for_launch,
                                error = %status_error,
                                "启动失败的子代理行未能归一 failed"
                            );
                        }
                        if emit_failure_event {
                            let emitter =
                                SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db)));
                            if let Err(emit_error) =
                                emitter.emit_ended(&failed_context, &failed_info).await
                            {
                                tracing::warn!(
                                    target: "subagent_spawner",
                                    event = "emit_launch_failed_ended_failed",
                                    subagent_run_id = %run_id_for_launch,
                                    error = %emit_error,
                                    "spawn 失败补发 subagent-ended 落库失败（仅告警）"
                                );
                            }
                        }
                    }
                    let _ = launch_tx.send(Err(error));
                }
            }
        });

        let launch_result = launch_rx
            .await
            .map_err(|_| SubagentSpawnError::SpawnFailed("启动任务提前退出".to_string()))?;
        let _response = launch_result.map_err(SubagentSpawnError::SpawnFailed)?;
        lifecycle.wait_until_started_event_complete().await;

        Ok(SubagentSpawnResult {
            subagent_id,
            subagent_run_id,
            session_id,
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }

    /// 落库行构造（pending 首写即 running；depth 沿 parent_run_id 链；
    /// v6 新列 task_type / display_label / allowed_write_paths_json 随行）
    pub(crate) fn row_for(
        &self,
        req: &SubagentSpawnRequest,
        subagent_id: &str,
        subagent_run_id: &str,
        session_id: &str,
        depth: usize,
        now: i64,
    ) -> SessionAgent {
        SessionAgent {
            id: subagent_id.to_string(),
            subagent_run_id: subagent_run_id.to_string(),
            parent_session_id: req.parent_session_id.clone(),
            parent_run_id: req
                .parent_run_id
                .clone()
                .unwrap_or_else(|| self.resolve_parent_run(req).unwrap_or_default()),
            parent_tool_call_id: req.parent_tool_call_id.clone(),
            // F-013 接线（双防线②数据源）：flow 调度请求 description 恒
            // None（flow_graph.rs:1028 唯一构造点），description 字段在
            // flow 路径下本就空闲——load() 反向校验（flow_graph.rs:1417
            // -1442）以 row.description 为 flow_node_id 载体定位「有 run
            // 行、flow_state 无映射」的节点，生产 spawner 必须把
            // flow_node_id 落库，否则崩溃窗口兜底在生产域退化为不命中
            // （description 空串）。flow_node_id 优先（机器可定位 id）；
            // 非 flow 路径无 flow_node_id → 普通描述文本原样承载，语义
            // 不变。
            description: req
                .flow_node_id
                .clone()
                .or_else(|| req.description.clone())
                .unwrap_or_default(),
            mode: req.mode.clone().unwrap_or_default(),
            status: SubagentState::Pending.to_db_status().to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: now,
            ended_at: None,
            depth: Some(depth as i64),
            subagent_path_json: None,
            // T-D-07 落库面：task_type / display_label / 写路径白名单
            // 随 spawn 请求落库（model_override 扩展点预留不落库）
            task_type: req.task_type.map(|t| t.as_str().to_string()),
            display_label: req.display_label.clone(),
            allowed_write_paths_json: req
                .allowed_write_paths
                .as_ref()
                .map(|paths| serde_json::to_string(paths).expect("路径白名单序列化不应失败")),
            // D-02 LK-04：子会话 id 随行落库（v9 新列；反向导航键——子会话
            // 事件流 → session_agents 行反查，`sub-sess-{depth}-{n}`）
            sub_session_id: Some(session_id.to_string()),
        }
    }

    pub(crate) async fn spawn_with_flow_event_policy(
        &self,
        req: &SubagentSpawnRequest,
        emit_flow_lifecycle_events: bool,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        let parent_run = self.resolve_parent_run(req);
        let depth = self
            .tracking
            .run_depths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(parent_run.as_deref().unwrap_or_default())
            .copied()
            .unwrap_or(0)
            + 1;
        let ids = self.next_spawn_ids(depth);
        check_ancestor_chain(&DeadlockCheckInput {
            target_session_id: ids.session_id.clone(),
            ancestor_session_ids: self.ancestor_sessions(parent_run.as_deref()),
        })
        .map_err(SubagentSpawnError::GuardRejected)?;
        self.reserve_capacity(
            std::slice::from_ref(&ids.subagent_run_id),
            parent_run.as_deref(),
            depth,
        )?;
        let mut reservation =
            CapacityReservation::new(Arc::clone(&self.tracking), &ids.subagent_run_id);
        let result = self
            .spawn_unchecked(
                req,
                depth,
                parent_run,
                &ids,
                &mut reservation,
                emit_flow_lifecycle_events,
            )
            .await;
        if result.is_err() {
            reservation.release_now();
        }
        result
    }
}
