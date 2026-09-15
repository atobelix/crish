//! run/run_resume.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;
/// D2 §3.2 + E1 §3.3：续 run 判定输入（drive_run_loop 在 outcome 移动消费
/// 前提取的数据面；decide_idle_resume 消费）。
///
/// provider_error 为壳层自有镜像结构（session-loop 的 ProviderErrorSummary
/// 所在 `mod end` 为私有模块，壳层无法命名该类型——字段访问无需类型名，
/// 提取时逐字段映射；D2 §3.2 的 `Option<&ProviderErrorSummary>` 签名在本
/// 壳层落地为等价字段镜像）。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ResumeSignals {
    /// D2 §3.3：任务文本（会话首条非 steering user 消息；指纹输入）
    pub task_text: String,
    /// D1 数据面：fatal 收场的 provider 错误摘要（正常 stop 收场 None）
    pub provider_error: Option<ProviderErrorFields>,
    /// E1 §2.1：最后一条 assistant 消息的流中断标注信号（D7 标注）
    pub last_assistant: Option<LastAssistantSignal>,
}

/// D1 数据面摘要的壳层镜像（ProviderErrorSummary 字段子集：kind /
/// retryable / retries）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProviderErrorFields {
    /// 分类 13 类（kebab-case）
    pub kind: ProviderErrorKind,
    /// 是否可重试
    pub retryable: bool,
    /// run 内实际重试次数
    pub retries: u32,
}

/// E1 §2.1：最后一条 assistant 消息的流中断标注（D7 §3.7；与 D1 熔断
/// S2 计数同数据源）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LastAssistantSignal {
    /// metadata.providerErrorKind（无标注 None）
    pub kind: Option<ProviderErrorKind>,
    /// metadata.providerErrorRetryable（无标注 None；!= false 语义）
    pub retryable: Option<bool>,
    /// 纯文本消息（无 tool_calls 且文本非空——工具调用已提交不续写）
    pub is_plain_text: bool,
}

/// D5 §3.3：goal 收口评估输入（RoundInput 三要素 + 事件载荷计数的
/// 预提取形态）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GoalRoundSignals {
    /// 本轮助手终稿文本（消息尾）
    pub assistant_text: String,
    /// 本轮工具批（tool_name + 参数顶层 key 集）
    pub tool_calls: Vec<ToolCallStamp>,
    /// 本轮成功工具结果计数（L2 退化证据）
    pub tool_success_count: u32,
    /// 本轮工具调用次数（goal-round-completed 载荷）
    pub tool_call_count: u32,
    /// 本轮消息数（goal-round-completed 载荷）
    pub message_count: u32,
}

/// E1 §3.2：续写注入模板的 kind 人读化（锁定模板测试断言绑定；
/// 瞬态四类取变体名风格，非瞬态回退 kebab-case——模板仅瞬态类可达）
pub(crate) fn resume_kind_label(kind: ProviderErrorKind) -> &'static str {
    match kind {
        ProviderErrorKind::RateLimit => "RateLimit",
        ProviderErrorKind::ServerError => "ServerError",
        ProviderErrorKind::Timeout => "Timeout",
        ProviderErrorKind::Network => "Network",
        ProviderErrorKind::Aborted => "aborted",
        ProviderErrorKind::PayloadTooLarge => "payload-too-large",
        ProviderErrorKind::GatewayChallenge => "gateway-challenge",
        ProviderErrorKind::Auth => "auth",
        ProviderErrorKind::Quota => "quota",
        ProviderErrorKind::EndpointUnavailable => "endpoint-unavailable",
        ProviderErrorKind::ContextLengthExceeded => "context-length-exceeded",
        ProviderErrorKind::InvalidRequest => "invalid-request",
        ProviderErrorKind::Unknown => "unknown",
    }
}

/// D2 §3.3：会话首条非 steering user 消息（任务文本提取）。steering
/// 注入消息带 kind=steering（AgentMessageMetadataKind 枚举 canonical）——
/// error 续 run 的注入文本「继续任务」即 steering 形态，直取会让指纹从
/// 第二次起漂移到注入模板上（selection-03 评审护栏 5 同款混淆）。
pub(crate) fn main_task_text(messages: &[Arc<AgentMessage>]) -> String {
    messages
        .iter()
        .find(|m| m.role == AgentMessageRole::User && !is_steering_message(m))
        .map(|m| m.text().trim().to_string())
        .unwrap_or_default()
}

/// steering 注入判定（消息 metadata.kind == AgentMessageMetadataKind::Steering
/// canonical wire——I1-α④ 枚举化）
pub(crate) fn is_steering_message(message: &AgentMessage) -> bool {
    message
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("kind"))
        .and_then(|kind| kind.as_str())
        == Some(
            session_loop::steering::metadata_kind_wire(AgentMessageMetadataKind::Steering).as_str(),
        )
}

/// E1 §2.1：最后一条 assistant 消息的信号提取（D7 流中断标注）
pub(crate) fn last_assistant_provider_signal(
    messages: &[Arc<AgentMessage>],
) -> Option<LastAssistantSignal> {
    let last = messages
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)?;
    let is_plain_text = last.tool_calls().next().is_none() && !last.text().is_empty();
    let (kind, retryable) = provider_signal_metadata(last.metadata.as_ref());
    Some(LastAssistantSignal {
        kind,
        retryable,
        is_plain_text,
    })
}

/// 从消息 metadata 提取 providerErrorKind / providerErrorRetryable
/// （D7 §3.7 标注；kebab-case 字符串解析，坏值 None）
pub(crate) fn provider_signal_metadata(
    metadata: Option<&serde_json::Value>,
) -> (Option<ProviderErrorKind>, Option<bool>) {
    let Some(meta) = metadata else {
        return (None, None);
    };
    let kind = meta
        .get("providerErrorKind")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<ProviderErrorKind>(&format!("\"{s}\"")).ok());
    let retryable = meta.get("providerErrorRetryable").and_then(|v| v.as_bool());
    (kind, retryable)
}

/// D5 §3.3：goal 收口评估输入预提取（消息面三要素 + 事件载荷计数）
pub(crate) fn extract_goal_round_signals(messages: &[Arc<AgentMessage>]) -> GoalRoundSignals {
    let mut assistant_text = String::new();
    let mut tool_calls: Vec<ToolCallStamp> = Vec::new();
    let mut tool_success_count: u32 = 0;
    let mut tool_call_count: u32 = 0;
    for message in messages {
        if message.role == AgentMessageRole::Assistant {
            let text = message.text();
            if !text.is_empty() {
                assistant_text = text;
            }
            for call in message.tool_calls() {
                tool_call_count += 1;
                let keys = call
                    .input
                    .as_object()
                    .map(|object| object.keys().cloned().collect())
                    .unwrap_or_default();
                tool_calls.push(ToolCallStamp {
                    tool_name: call.tool_name.clone(),
                    param_keys: keys,
                });
            }
        }
        if message.role == AgentMessageRole::Tool {
            for block in &message.blocks {
                if let AgentMessageBlock::ToolResult { is_error, .. } = block {
                    if !is_error {
                        tool_success_count += 1;
                    }
                }
            }
        }
    }
    GoalRoundSignals {
        assistant_text,
        tool_calls,
        tool_success_count,
        tool_call_count,
        message_count: messages.len() as u32,
    }
}

/// D5 §3.7：续轮注入文本构造（主源 = goal 前缀，增强 = nextSteps；
/// 模板对齐 buildGoalModePrefix，goalModeController.ts:74-95）
pub(crate) fn build_goal_continuation_prompt(
    goal_state: &GoalState,
    next_steps: &[String],
) -> String {
    let round = goal_state.current_round + 1;
    let mut text = format!(
        "[目标模式 · 系统指令]\n\
         你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。\n\
         目标：{}\n\
         当前第 {}/{} 轮（自动续写上限 {} 轮）。\n\
         请工作直至目标实质完成；不要半途停下或只列计划而不执行。\n\
         请在回复中维护 markdown 任务清单（`- [ ]` / `- [x]`），便于进度同步。\n\
         若目标已完成，请在回复末尾明确写出 DONE 或「目标已完成」。",
        goal_state.goal, round, goal_state.max_rounds, goal_state.max_rounds
    );
    if !next_steps.is_empty() {
        text.push_str("\n上轮进度小结（供续接）：\n");
        for step in next_steps {
            text.push_str(&format!("- 下一步：{step}\n"));
        }
    }
    text.push_str("---");
    text
}

/// D5 §3.9：GoalDecision → wire 值（Continue/Completed/NoProgress/
/// Blocked/NoGoal，events.rs 载荷注释约定）
pub(crate) fn goal_decision_wire(decision: GoalDecision) -> String {
    match decision {
        GoalDecision::Continue => "Continue",
        GoalDecision::Completed => "Completed",
        GoalDecision::NoProgress => "NoProgress",
        GoalDecision::Blocked => "Blocked",
        GoalDecision::NoGoal => "NoGoal",
    }
    .to_string()
}

impl CoreRunState {
    /// D5 §3.2：读 `goal_state` 键（宽容解析 fail-open：缺键 / 坏 JSON →
    /// None = 无 goal；字段级容忍由 [GoalState::from_json] 保证）
    pub(crate) async fn load_goal_state(&self, _session_id: &str) -> Option<GoalState> {
        let db = self.local_db()?;
        tokio::task::spawn_blocking(move || {
            let raw = db
                .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
                .ok()
                .flatten();
            GoalState::from_json(raw.as_deref())
        })
        .await
        .ok()
        .flatten()
    }

    /// D5 §3.2：写 `goal_state` 键（唯一写方 = run 收口 RoundAssessment +
    /// run_task_impl 装配覆盖；spawn_blocking 落键）。
    ///
    /// 表锁竞速防护：收口写回与 events 终态落库同时段争用 SQLite（实测
    /// `database table is locked`），旧实现 `let _` 静默吞失败导致 goal
    /// 轮次推进无声丢失。现对锁类失败做有限重试（50ms ×3），仍失败
    /// tracing::error 显式留痕（不阻断收口——goal 推进丢失属可观测降级，
    /// 下轮续轮判定会重新读到未推进值并重新评估）。
    pub(crate) async fn save_goal_state(&self, _session_id: &str, state: &GoalState) {
        let Some(db) = self.local_db() else {
            return;
        };
        let json = state.to_json();
        let result = tokio::task::spawn_blocking(move || {
            let mut last = None;
            for attempt in 0..3 {
                match db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &json) {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        let locked = error.to_string().contains("table is locked");
                        last = Some(error);
                        if !locked {
                            break;
                        }
                        if attempt + 1 < 3 {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                    }
                }
            }
            Err(last.unwrap_or_else(|| conex_db::DbFailure {
                message: "goal_state 写回未执行".into(),
                kind: conex_db::DbFailureKind::Lock,
            }))
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::error!(
                    error = %error,
                    "goal_state 写回失败（含表锁重试耗尽）：goal 轮次推进未持久化"
                );
            }
            Err(error) => {
                tracing::error!(error = %error, "goal_state 写回任务 join 失败");
            }
        }
    }

    /// D5 §3.7：最新 compression_block.summary_json 的 nextSteps 读取
    /// （fail-open：无块 / 坏 JSON → None，不阻断注入——注入主源是 goal
    /// 前缀；Schema V1 字段 nextSteps = 字符串数组）
    pub(crate) async fn read_summary_next_steps(&self, session_id: &str) -> Vec<String> {
        let Some(db) = self.local_db() else {
            return Vec::new();
        };
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            db.list_blocks(&session_id, Some(1))
                .ok()
                .and_then(|blocks| blocks.into_iter().next())
                .and_then(|block| block.summary_json)
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .and_then(|value| {
                    value
                        .get("nextSteps")
                        .and_then(|steps| steps.as_array())
                        .map(|steps| {
                            steps
                                .iter()
                                .filter_map(|step| step.as_str().map(String::from))
                                .collect()
                        })
                })
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default()
    }
}

impl CoreRunState {
    /// E1 §3.4（T7）：续写开关键（`content_resume_enabled` 键，缺省 true
    /// = 默认开启——与用户诉求「断网自动接续最好」一致）
    pub(crate) async fn content_resume_enabled(&self, _session_id: &str) -> bool {
        let Some(db) = self.local_db() else {
            return true;
        };
        tokio::task::spawn_blocking(move || {
            db.get_session_meta(CONTENT_RESUME_ENABLED_KEY)
                .ok()
                .flatten()
                .and_then(|raw| raw.parse::<bool>().ok())
                .unwrap_or(true)
        })
        .await
        .unwrap_or(true)
    }
}

impl CoreRunState {
    /// D5 §3.3：收口 goal 轮次评估（唯一写方；子代理 run 不调用——守卫
    /// 在调用点 `active.subagent.is_none()`，02-定夺 S10）。
    ///
    /// 流程：load goal_state（无 goal → 不评估不写）→ assess_round 纯函数
    /// → advance 写回（spawn_blocking）→ goal-round-completed 事件发射
    /// （envelope 通道，02-定夺 B2 统一字段集）。
    pub(crate) async fn assess_goal_round(
        &self,
        active: &ActiveRun,
        reason: AgentEndReason,
        signals: &GoalRoundSignals,
        runtime_error: Option<&str>,
    ) {
        let Some(current) = self.load_goal_state(&active.session_id).await else {
            return;
        };
        let input = RoundInput {
            end_reason: reason,
            assistant_text: signals.assistant_text.clone(),
            tool_calls: signals.tool_calls.clone(),
            tool_success_count: signals.tool_success_count,
            runtime_error: runtime_error.map(String::from),
            current: current.clone(),
        };
        let assessment = assess_round(&input);
        if assessment.decision == GoalDecision::NoGoal {
            return;
        }
        let advanced = current.advance(&input, &assessment);
        self.save_goal_state(&active.session_id, &advanced).await;
        // goal-round-completed（round = 本轮序号 = 评估前 current_round + 1；
        // error 轮不递增 current_round，但 round 序号仍按本轮计）
        let event = AgentEvent::GoalRoundCompleted {
            round: current.current_round + 1,
            tool_call_count: signals.tool_call_count,
            tool_success_count: signals.tool_success_count,
            message_count: signals.message_count,
            decision: goal_decision_wire(assessment.decision),
            reason_detail: assessment.reason_detail.clone(),
            stalled_delta: assessment.stalled_delta,
            evidence: signals.tool_success_count.to_string(),
        };
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            &active.session_id,
            event,
        )
        .await;
        // EV-07：收口决策补发 goal-continuation-decided（Completed →
        // action=complete、Blocked → action=blocked、NoProgress →
        // action=stop；reason = reason_detail 区分；Continue 由 idle 续轮
        // 判定发射，防同轮双发；NoGoal 早退不补发）。与
        // goal-round-completed.decision 语义边界：轮次账本事件（每轮必发）
        // vs 决策观测事件（决策全集镜像，action 值域对齐 TS
        // GoalContinuationDecision continue/complete/blocked/stop）。
        let continuation_action = match assessment.decision {
            GoalDecision::Completed => Some("complete"),
            GoalDecision::Blocked => Some("blocked"),
            GoalDecision::NoProgress => Some("stop"),
            GoalDecision::Continue | GoalDecision::NoGoal => None,
        };
        if let Some(action) = continuation_action {
            emit_goal_continuation_decided(
                active,
                Some(&advanced),
                action,
                &assessment.reason_detail,
                current.current_round + 1,
                None,
            )
            .await;
        }
    }
}

impl CoreRunState {
    pub(crate) async fn consume_resume_episode(
        &self,
        _session_id: &str,
        fp: &str,
        limit_key: &'static str,
        default_limit: u32,
    ) -> EpisodeConsume {
        let Some(db) = self.local_db() else {
            return EpisodeConsume::Denied {
                count: 0,
                max: default_limit,
            };
        };
        let fp = fp.to_string();
        let limit_key = limit_key.to_string();
        tokio::task::spawn_blocking(move || {
            let raw = db.get_session_meta(RECOVER_EPISODES_KEY).ok().flatten();
            let limit = db
                .get_session_meta(&limit_key)
                .ok()
                .flatten()
                .and_then(|raw| raw.parse::<u32>().ok())
                .unwrap_or(default_limit);
            let mut budget = RecoveryBudget::from_json(raw.as_deref(), limit);
            if !budget.can_recover(&fp) {
                return EpisodeConsume::Denied {
                    count: budget.count(&fp),
                    max: limit,
                };
            }
            let count = match budget.record_fork(&fp) {
                Ok(count) => count,
                Err(_) => {
                    return EpisodeConsume::Denied {
                        count: budget.count(&fp),
                        max: limit,
                    };
                }
            };
            if db
                .set_session_meta(RECOVER_EPISODES_KEY, &budget.to_json())
                .is_err()
            {
                return EpisodeConsume::Denied { count, max: limit };
            }
            EpisodeConsume::Consumed(count)
        })
        .await
        .unwrap_or(EpisodeConsume::Denied {
            count: 0,
            max: default_limit,
        })
    }
}

impl CoreRunState {
    /// D3 §3.2.1/§3.2.4：任务文本还原（首条 user 消息文本；与
    /// lifecycle.rs derive_task 同源——子代理 run 首条 user 消息即任务
    /// prompt 的对话形态）。无 user 消息 → 空串（指纹退化但可运行）。
    pub(crate) fn first_user_text(messages: &[Arc<AgentMessage>]) -> String {
        messages
            .iter()
            .find(|m| m.role == AgentMessageRole::User)
            .map(|m| m.text().trim().to_string())
            .unwrap_or_default()
    }

    /// D3 §3.2.2：阶梯 1 收口后重派请求（裁决 #5：原 run failed
    /// reason=recovery-retry + 预算内重派新 run mode=recovery-retry；
    /// 不消费 Episode、无 steering 通知）。subagent_id 由 spawner 生成
    /// （agent_id: None，与 fork 请求同构 recovery.rs:1115-1135）——预算
    /// 指纹用原 subagent_id（D3 §8 决策 8），不受新 run id 影响。
    pub(crate) fn retry_spawn_request(
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        ctx: &RunFailureContext,
    ) -> agent_tools::tools::subagent::SubagentSpawnRequest {
        agent_tools::tools::subagent::SubagentSpawnRequest {
            agent_id: None,
            prompt: ctx.task.clone(),
            role: None,
            capability_mode: None,
            allowed_tools: None,
            description: Some("恢复阶梯 1 重派（C7，承接同一目标）".to_string()),
            mode: Some("recovery-retry".to_string()),
            parent_session_id: cfg.parent_session_id.clone(),
            parent_run_id: None,
            parent_tool_call_id: None,
            flow_node_id: None,
            is_composite: false,
            task_type: None,
            allowed_write_paths: None,
            display_label: None,
            model_override: None,
        }
    }

    /// D3 §3.2.4：RunFailureContext 还原（11 字段装配表；retries = 跨 run
    /// 阶梯 1 已重派次数——D3 §8 决策 1，**非** run 内 provider_error.retries；
    /// retry_elapsed_ms = 0（决策 3：次数判定已覆盖预算语义）；from_leaf_id
    /// = None（初始 run 无 subagent_path_json 落库，阶梯 3 结构化拒绝，
    /// subagent_spawner.rs:703）；history 字段由 D7 维度在 recovery.rs 落地
    /// 后接入（轮 2 A9 派单，数据源 = session_history.get(子代理会话)））。
    ///
    /// error_kind 取自 RunOutcome.provider_error.kind（D1 数据面；
    /// ProviderErrorSummary 为 session-loop 私有模块类型，壳层只消费
    /// 其 public 字段 kind，不命名类型）。
    pub(crate) fn build_run_failure_context(
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        error_kind: ProviderErrorKind,
        first_user_text: &str,
        has_assistant_output: bool,
        ladder1_retries: u32,
        inject_bytes: u64,
        window_bytes: u64,
    ) -> RunFailureContext {
        RunFailureContext {
            subagent_id: cfg.subagent_id.clone(),
            subagent_run_id: cfg.subagent_run_id.clone(),
            task: first_user_text.to_string(),
            error_kind,
            retries: ladder1_retries,
            retry_elapsed_ms: 0,
            produced_content: has_assistant_output,
            from_leaf_id: None,
            started_at_ms: cfg.started_at_ms,
            inject_bytes,
            window_bytes,
        }
    }
}

impl CoreRunState {
    /// D3 §3.2.2：C7 恢复决策（子代理收口处、on_subagent_run_terminal
    /// **之前**调用；决策先行——escalate 的 steering 条目先入队，与
    /// subagent-terminal-<run_id> 终态通知共存，02 D2 裁定保留双条目）。
    ///
    /// 触发条件：active.subagent 为 Some 且终态 Failed 且
    /// RunOutcome.provider_error 有数据（D1 面）且协调器可用（local_db
    /// 装配）。返回 AutoRetry 计划（含退避 delay 与重入协调器引用）；
    /// SteeringQueued / NeedsUser 由协调器内部完成（通知入队/标记），
    /// 无需额外动作。
    pub(crate) async fn decide_subagent_recovery(
        &self,
        session_id: &str,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        terminal_status: &conex_db::RunStatus,
        error_kind: Option<ProviderErrorKind>,
        first_user_text: &str,
        has_assistant_output: bool,
        run_message_bytes: u64,
    ) -> Option<RecoveryPlan> {
        if terminal_status != &conex_db::RunStatus::Failed {
            return None;
        }
        let Some(error_kind) = error_kind else {
            return None;
        };
        let Some(coord) = self.coordinator_for(session_id) else {
            return None;
        };
        let fp = fingerprint(&cfg.subagent_id, first_user_text);
        let ctx = Self::build_run_failure_context(
            cfg,
            error_kind,
            first_user_text,
            has_assistant_output,
            self.ladder1_retry_count(session_id, &fp),
            // inject_bytes：重派 run 无注入内容（新 run 以任务 prompt 起头，
            // 与 fork 的「注入内容字节」语义不同源——fork 三态判定归
            // resume 命令面（D4）装配，本触发点 only 决策不消费）
            0,
            // window_bytes：本 run 消息字节合计（content_bytes 语义同源，
            // lifecycle.rs:451-458；会话窗口近似）
            run_message_bytes,
        );
        // 决策通过全异步 L2 业务互斥锁直接执行
        let ctx_for_decision = ctx.clone();
        let decision = {
            let mut c = coord.lock().await;
            c.on_subagent_run_failure(&ctx_for_decision).await
        };
        match decision {
            Ok(RecoveryOutcome {
                action: RecoveryAction::AutoRetry { delay, .. },
                ..
            }) => Some(RecoveryPlan::AutoRetry { delay, ctx, coord }),
            Ok(_) => None,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    subagent_run_id = %cfg.subagent_run_id,
                    error = %error,
                    "恢复决策失败（协调器不可用，收口走接线前行为）"
                );
                None
            }
        }
    }
}

impl CoreRunState {
    /// D3 §3.2.2/§3.2.3：阶梯 1 收口后重派（裁决 #5 方案 Y）。在
    /// on_subagent_run_terminal（旧 run 记账释放）**之后**执行——spawn
    /// 守卫快照不含旧 run，无「被自己挡住」误拒（subagent_spawner.rs:
    /// 506-526、743-764 时序保证）。
    ///
    /// 顺序：退避 sleep（async 不阻塞 worker）→ 原 run end_reason 覆写
    /// recovery-retry（spawn_blocking）→ 预算内重派（mode=recovery-retry，
    /// 不消费 Episode、无 steering）→ 计数 +1；spawn 失败（含 16/16/1
    /// 守卫拒绝）→ 计数推满 + retries 推满重入 escalate（阶梯 2 通知，
    /// 不静默、无假重试）。
    ///
    /// EV-08（G-20）：重派成功处发射 `recovery-retry-attempted`——每次
    /// 阶梯 1 重试有事件，且 from_run_id → new_run_id 结构化关联（重试
    /// 无事件 + 无结构化关联缺陷闭合）。
    pub(crate) async fn execute_subagent_recovery(
        &self,
        session_id: &str,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        plan: RecoveryPlan,
        active: &ActiveRun,
    ) {
        let RecoveryPlan::AutoRetry { delay, ctx, coord } = plan;
        // 退避（async sleep 不阻塞 tokio worker）
        tokio::time::sleep(delay).await;
        // 原 run failed reason 覆写（RecoveryStore::update_run_status 同步
        // → spawn_blocking 直连 LocalDb，F2-27 覆盖表新增点）
        if let Some(db) = self.local_db() {
            let run_id = ctx.subagent_run_id.clone();
            match tokio::task::spawn_blocking(move || {
                db.update_run_status(
                    &run_id,
                    conex_db::RunStatus::Failed,
                    Some("recovery-retry"),
                    None,
                )
            })
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(
                        target: "run",
                        session_id,
                        subagent_run_id = %ctx.subagent_run_id,
                        error = %error,
                        "原 run end_reason 覆写 recovery-retry 失败（仅观测面）"
                    );
                }
                Err(join_error) => {
                    tracing::warn!(
                        target: "run",
                        session_id,
                        error = %join_error,
                        "原 run end_reason 覆写 spawn_blocking join 失败"
                    );
                }
            }
        }
        // 预算内重派新 run（mode=recovery-retry；不消费 Episode、无 steering）
        let request = Self::retry_spawn_request(cfg, &ctx);
        let fp = fingerprint(&ctx.subagent_id, &ctx.task);
        match self.subagent_spawner.spawn(&request).await {
            Ok(spawned) => {
                let retries = self.bump_ladder1_retry(session_id, &fp);
                // EV-08（G-20）：阶梯 1 重派留痕——每次重试有事件，且
                // from_run_id → new_run_id 结构化关联（修复「重试无事件 +
                // 无结构化关联」；attempt = 本次重派序号；budget_remaining
                // = 剩余重试预算）
                let retry_event = AgentEvent::RecoveryRetryAttempted {
                    session_id: session_id.to_string(),
                    timestamp: crate::engine::now_iso_utc(),
                    attempt: retries,
                    delay_ms: delay.as_millis() as u64,
                    budget_remaining: self.ladder1_max_retries_config().saturating_sub(retries),
                    from_run_id: ctx.subagent_run_id.clone(),
                    new_run_id: spawned.subagent_run_id.clone(),
                };
                emit_envelope_event(
                    &active.queue,
                    &active.bridge,
                    &spawned.subagent_run_id,
                    session_id,
                    retry_event,
                )
                .await;
                tracing::info!(
                    target: "run",
                    session_id,
                    from_run_id = %ctx.subagent_run_id,
                    new_subagent_run_id = %spawned.subagent_run_id,
                    retries,
                    "恢复阶梯 1 收口后重派成功（mode=recovery-retry，不消费 Episode）"
                );
            }
            Err(error) => {
                // spawn 失败（含 16/16/1 守卫拒绝）：计数推满 + retries
                // 推满 → 重入 on_subagent_run_failure 必 Escalate（阶梯 2
                // 通知主 agent，不静默、无假重试）
                self.force_ladder1_retry_max(session_id, &fp);
                let mut escalate_ctx = ctx;
                escalate_ctx.retries = self.ladder1_retry_count(session_id, &fp);
                let run_id_for_log = escalate_ctx.subagent_run_id.clone();
                let outcome = {
                    let mut c = coord.lock().await;
                    c.on_subagent_run_failure(&escalate_ctx).await
                };
                tracing::warn!(
                    target: "run",
                    session_id,
                    subagent_run_id = %run_id_for_log,
                    error = ?error,
                    reentry = ?outcome.as_ref().map(|o| o.ladder.as_str()).ok(),
                    "恢复阶梯 1 重派失败：计数推满重入 escalate（阶梯 2 通知主 agent）"
                );
            }
        }
    }
}

impl CoreRunState {
    /// E3-2（D3 §3.2.6）：子代理运行中汇报接线——收口处把本轮新增消息
    /// （assistant 文本截断 + 工具调用摘要）经 SubagentEventEmitter::emit_event
    /// （subagent-event 通道，kind=progress）发射。
    ///
    /// 职责分离：**汇报 = 观测面，唤醒 = 终态面**——运行中汇报不写
    /// steering 队列（防 16 并发唤醒风暴）；wait_for_terminal 只认
    /// subagent-ended（名单外忽略，wait_subagents.rs:378-459），语义零
    /// 改变。progress 为 Delta 背压（不落库不阻塞 drive loop，events.rs:
    /// 51-55）——事件同时经本 run 事件桥广播（信封 runId = 本 run），
    /// 前端全局消费者按信封 sessionId（父会话）路由（subagentHandlers.ts
    /// :131-144）。失败仅告警（观测面不阻断收口）。
    ///
    /// 说明：引擎单次 produce 覆盖整个 run（轮级钩子需 session-loop 侧
    /// 扩展，超出本轮文件域），逐条 assistant 消息按消息序发射近似
    /// 「轮次递进」语义。
    pub(crate) async fn emit_subagent_progress(
        &self,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        bridge: &Arc<BufferedRunEventBridge>,
        messages: &[Arc<AgentMessage>],
    ) {
        if messages.is_empty() {
            return;
        }
        let Some(db) = self.local_db() else {
            return;
        };
        let emitter =
            SubagentEventEmitter::new(Arc::new(orchestrator::persist::LocalDbStore::new(db)));
        let emit_ctx = SubagentEmitContext {
            session_id: cfg.parent_session_id.clone(),
            parent_run_id: String::new(),
        };
        let mut turn = 0u32;
        for message in messages
            .iter()
            .filter(|m| m.role == AgentMessageRole::Assistant)
        {
            turn += 1;
            let truncated: String = message
                .text()
                .chars()
                .take(SUBAGENT_PROGRESS_TRUNCATE_CHARS)
                .collect();
            let tool_calls: Vec<&str> = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    AgentMessageBlock::ToolCall(call) => Some(call.tool_name.as_str()),
                    _ => None,
                })
                .collect();
            let info = SubagentEventInfo {
                subagent_id: cfg.subagent_id.clone(),
                subagent_run_id: cfg.subagent_run_id.clone(),
                kind: SubagentEventKind::Progress,
                payload: Some(serde_json::json!({
                    // 载荷形状兼容前端 applySubagentEventToMessages 投影面
                    // （message-delta + text 块），最小形态 = 透传文本块
                    "type": "message-delta",
                    "block": { "type": "text", "text": truncated },
                    "turn": turn,
                    "toolCalls": tool_calls,
                })),
            };
            match emitter.emit_event(&emit_ctx, &info).await {
                Ok(sequenced) => {
                    let envelope = AgentEventEnvelope::new(
                        sequenced.event,
                        Some(cfg.subagent_run_id.clone()),
                        Some(sequenced.sequence),
                    );
                    bridge.emit(&envelope);
                }
                Err(error) => {
                    tracing::warn!(
                        target: "subagent_spawner",
                        event = "emit_progress_failed",
                        subagent_run_id = %cfg.subagent_run_id,
                        error = %error,
                        "子代理运行中汇报发射失败（观测面，不阻断收口）"
                    );
                }
            }
        }
        bridge.flush();
    }
}

/// T-CF-11：生产续 run 拉起器构造（CoreRunState::new 预装配；测试经
/// set_resume_launcher 覆盖替身）。
///
/// 实现经 [ResumeLauncher] trait object（`Pin<Box<dyn Future + Send>>`
/// 叶子类型）间接引用 [run_task_impl]：drive_run_loop 与 run_task_impl
/// 相互包含 opaque future 会让 auto-trait（Send）检查无法终止（Rust
/// 限制："fetching the hidden types of an opaque inside of the defining
/// scope is not supported"）——trait object 断链后检查可终止。
pub(crate) fn production_resume_launcher() -> ResumeLauncher {
    let launcher: ResumeLauncher = Arc::new(|state, session_id, mode, messages| {
        let state = Arc::clone(state);
        let session_id = session_id.to_string();
        let mode = mode.to_string();
        Box::pin(async move {
            idle_resume::spawn_idle_resume_run(state, session_id, &mode, messages).await;
        })
    });
    launcher
}
