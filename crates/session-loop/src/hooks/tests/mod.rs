use super::*;
use conex_types::events::AgentEvent;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

mod dispatch;
mod matcher_timeout;
mod outcomes;

/// 测试 handler：记录收到的事件并可选返回动作
struct SpyHandler {
    name: String,
    seen: Arc<std::sync::Mutex<Vec<HookEventKind>>>,
    action: Option<HookAction>,
    err: Option<HookError>,
    delay_ms: Option<u64>,
}

impl SpyHandler {
    fn new(name: &str, action: Option<HookAction>) -> Self {
        Self {
            name: name.to_string(),
            seen: Arc::new(std::sync::Mutex::new(Vec::new())),
            action,
            err: None,
            delay_ms: None,
        }
    }

    fn failing(name: &str, message: &str) -> Self {
        Self {
            name: name.to_string(),
            seen: Arc::new(std::sync::Mutex::new(Vec::new())),
            action: None,
            err: Some(HookError::new(message)),
            delay_ms: None,
        }
    }

    fn slow(name: &str, delay_ms: u64) -> Self {
        Self {
            name: name.to_string(),
            seen: Arc::new(std::sync::Mutex::new(Vec::new())),
            action: None,
            err: None,
            delay_ms: Some(delay_ms),
        }
    }

    fn kinds(&self) -> Vec<HookEventKind> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[async_trait::async_trait]
impl HookHandler for SpyHandler {
    fn name(&self) -> &str {
        &self.name
    }

    async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event.kind());
        if let Some(ms) = self.delay_ms {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        if let Some(err) = &self.err {
            return Err(err.clone());
        }
        Ok(self.action.clone().unwrap_or(HookAction::Continue))
    }
}

fn turn_end() -> HookEvent {
    HookEvent::TurnEnd {
        session_id: "s1".into(),
        turn_index: 3,
        tool_call_count: 2,
    }
}

fn tool_pre() -> HookEvent {
    HookEvent::ToolPre {
        session_id: "s1".into(),
        tool_name: "echo".into(),
        input: json!({ "v": 1 }),
    }
}

/// 新变体载荷透传：session.start / tool.error / context.compact.* /
/// error.occurred / model.* / subagent.* 收到事件且载荷可读
fn new_variant_events() -> Vec<HookEvent> {
    vec![
        HookEvent::SessionStart {
            session_id: "s1".into(),
        },
        HookEvent::SessionEnd {
            session_id: "s1".into(),
        },
        HookEvent::TurnStart {
            session_id: "s1".into(),
            turn_index: 1,
        },
        HookEvent::ToolError {
            session_id: "s1".into(),
            tool_name: "x".into(),
            error: "boom".into(),
        },
        HookEvent::ContextCompactStart {
            session_id: "s1".into(),
            trigger: "threshold".into(),
            tokens_before: 100,
        },
        HookEvent::ContextCompactEnd {
            session_id: "s1".into(),
            aborted: false,
            kept_message_count: 5,
            compaction_id: "c1".into(),
        },
        HookEvent::ErrorOccurred {
            session_id: "s1".into(),
            error: "boom".into(),
            retryable: false,
        },
        HookEvent::ModelBeforeRequest {
            session_id: "s1".into(),
            provider_id: Some("deepseek".into()),
            model: Some("v4".into()),
        },
        HookEvent::ModelAfterResponse {
            session_id: "s1".into(),
            provider_id: None,
            model: None,
            ok: true,
        },
        HookEvent::SubagentStart {
            parent_session_id: "p1".into(),
            subagent_session_id: "a1".into(),
            role: Some("researcher".into()),
        },
        HookEvent::SubagentEnd {
            parent_session_id: "p1".into(),
            subagent_session_id: "a1".into(),
            reason: Some("completed".into()),
        },
    ]
}

/// 测试 handler：记录事件名（错误事件化断言用）
struct ErrorSpy {
    seen: Arc<std::sync::Mutex<Vec<String>>>,
    /// 可选延迟：拉长 error.occurred 分派窗口，供并发交叠测试制造竞态
    delay_ms: Option<u64>,
}

impl ErrorSpy {
    fn new(seen: Arc<std::sync::Mutex<Vec<String>>>) -> Self {
        Self {
            seen,
            delay_ms: None,
        }
    }

    fn slow(seen: Arc<std::sync::Mutex<Vec<String>>>, delay_ms: u64) -> Self {
        Self {
            seen,
            delay_ms: Some(delay_ms),
        }
    }
}

#[async_trait::async_trait]
impl HookHandler for ErrorSpy {
    fn name(&self) -> &str {
        "error-spy"
    }

    async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
        if let Some(ms) = self.delay_ms {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        if let HookEvent::ErrorOccurred { error, .. } = event {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(error.clone());
        }
        Ok(HookAction::Continue)
    }
}

/// 测试 handler：记录全部收到的事件种类（新变体透传断言用）
struct PayloadSpy {
    seen: Arc<std::sync::Mutex<Vec<HookEventKind>>>,
}

#[async_trait::async_trait]
impl HookHandler for PayloadSpy {
    fn name(&self) -> &str {
        "payload-spy"
    }

    async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event.kind());
        Ok(HookAction::Continue)
    }
}

// ── D-03 EV-05：hook-outcome 观测镜像（dispatch 单点聚合）──

type CapturedSink = (
    Arc<dyn Fn(AgentEvent) + Send + Sync>,
    Arc<std::sync::Mutex<Vec<AgentEvent>>>,
);

/// 接线观测出口的测试辅助：捕获 hook-outcome 事件列表
fn sink_capture() -> CapturedSink {
    let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: Arc<dyn Fn(AgentEvent) + Send + Sync> = Arc::new({
        let captured = Arc::clone(&captured);
        move |evt| {
            captured.lock().unwrap_or_else(|e| e.into_inner()).push(evt);
        }
    });
    (sink, captured)
}

/// 提取捕获列表中的 hook-outcome 事件（断言辅助）
fn take_hook_outcomes(
    captured: &Arc<std::sync::Mutex<Vec<AgentEvent>>>,
) -> Vec<(String, String, Option<String>, Option<String>)> {
    captured
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter_map(|evt| match evt {
            AgentEvent::HookOutcome {
                hook_type,
                outcome,
                hook_name,
                blocked_reason,
                ..
            } => Some((
                hook_type.clone(),
                outcome.clone(),
                hook_name.clone(),
                blocked_reason.clone(),
            )),
            _ => None,
        })
        .collect()
}
