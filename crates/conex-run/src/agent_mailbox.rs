//! 子代理 → 父 agent 邮箱：即时/摘要双通道 + 令牌桶限速。
//!
//! 路由：spawn 时登记 `child_session → parent_session`；子代理工具只带自身
//! 会话 id，邮箱反查父会话投递。
//! - instant：Question/Result（普通桶）、Fault（必达）；
//! - digest：Progress/Notice（按时间/条数/字节合并）；
//! - 超限消息合并进摘要并附计数标记，不静默丢弃。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_tools::tools::send_message::{MainAgentMessageChannel, MainMessageRing};
use agent_tools::tools::subagent_report::{ChildAgentRegistrar, SubagentReportChannel};
use async_trait::async_trait;
use conex_agents::comm::{AgentMessage, AgentMessageKind, DigestBuffer, TokenBucket};
use conex_agents::policy::CommPolicy;

use crate::agent_policy::AgentPolicyService;

/// 子代理路由
#[derive(Debug, Clone)]
struct Route {
    parent_session: String,
    #[allow(dead_code)]
    agent_id: String,
}

#[derive(Debug, Default)]
struct ChildState {
    digest: DigestBuffer,
    instant: Option<TokenBucket>,
    critical: Option<TokenBucket>,
    cooldown_until: i64,
    suppressed: usize,
}

enum MailboxAction {
    Instant { text: String, ring: MainMessageRing },
    Digest(Option<AgentMessage>),
    None,
}

impl ChildState {
    fn ensure_buckets(&mut self, policy: &CommPolicy, now_ms: i64) {
        if self.instant.is_none() {
            self.instant = Some(TokenBucket::new(
                policy.instant_capacity,
                policy.instant_refill_per_min,
                60_000,
                now_ms,
            ));
            self.critical = Some(TokenBucket::new(
                policy.critical_capacity,
                policy.critical_refill_per_hour,
                3_600_000,
                now_ms,
            ));
        }
    }
}

/// 邮箱服务（引擎单例；路由由 spawner 登记）
pub struct AgentMailbox {
    routes: Mutex<HashMap<String, Route>>,
    states: Mutex<HashMap<String, ChildState>>,
    deliverer: Arc<dyn MainAgentMessageChannel>,
    policy: Option<Arc<AgentPolicyService>>,
}

impl std::fmt::Debug for AgentMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentMailbox")
            .field(
                "routes",
                &self.routes.lock().map(|r| r.len()).unwrap_or(0),
            )
            .finish()
    }
}

impl AgentMailbox {
    pub fn new(
        deliverer: Arc<dyn MainAgentMessageChannel>,
        policy: Option<Arc<AgentPolicyService>>,
    ) -> Self {
        Self {
            routes: Mutex::new(HashMap::new()),
            states: Mutex::new(HashMap::new()),
            deliverer,
            policy,
        }
    }

    fn now_ms() -> i64 {
        conex_shared::time::unix_millis() as i64
    }

    fn comm_policy(&self, parent_session: &str) -> CommPolicy {
        self.policy
            .as_ref()
            .map(|service| service.load(parent_session).communication)
            .unwrap_or_default()
    }

    async fn deliver(
        &self,
        parent_session: &str,
        text: &str,
        ring: MainMessageRing,
    ) -> Result<(), String> {
        self.deliverer
            .deliver_self(parent_session, text, ring)
            .await
            .map(|_| ())
    }

    /// 冲刷指定子代理摘要（终态 / 显式 flush）
    async fn flush_child_digest(&self, child_session: &str) -> Result<(), String> {
        let (parent, message) = {
            let routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
            let Some(route) = routes.get(child_session) else {
                return Ok(());
            };
            let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
            let Some(state) = states.get_mut(child_session) else {
                return Ok(());
            };
            let policy = self.comm_policy(&route.parent_session);
            let Some(mut digest) =
                state
                    .digest
                    .drain_into_digest(child_session, &route.parent_session, Self::now_ms(), policy.suppress_marker)
            else {
                return Ok(());
            };
            if state.suppressed > 0 {
                digest.text = format!(
                    "{}\n（另有 {} 条即时消息因节流合并）",
                    digest.text, state.suppressed
                );
                state.suppressed = 0;
            }
            (route.parent_session.clone(), digest)
        };
        self.deliver(&parent, &message.text, MainMessageRing::FollowUp)
            .await
    }
}

#[async_trait]
impl ChildAgentRegistrar for AgentMailbox {
    fn register_child(&self, child_session: &str, parent_session: &str, agent_id: &str) {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                child_session.to_string(),
                Route {
                    parent_session: parent_session.to_string(),
                    agent_id: agent_id.to_string(),
                },
            );
    }

    fn unregister_child(&self, child_session: &str) {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(child_session);
        self.states
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(child_session);
    }

    async fn flush_child(&self, child_session: &str) {
        let _ = self.flush_child_digest(child_session).await;
    }
}

#[async_trait]
impl SubagentReportChannel for AgentMailbox {
    async fn report(
        &self,
        child_session: &str,
        kind: AgentMessageKind,
        text: String,
        dedupe_key: Option<String>,
    ) -> Result<(), String> {
        let now = Self::now_ms();
        let (parent, action) = {
            let routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
            let route = routes
                .get(child_session)
                .ok_or_else(|| format!("未登记的子代理会话：{child_session}"))?;
            let policy = self.comm_policy(&route.parent_session);
            let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
            let state = states.entry(child_session.to_string()).or_default();
            state.ensure_buckets(&policy, now);

            let action = match kind {
                // Fault 必达：不受限速约束
                AgentMessageKind::Fault => MailboxAction::Instant {
                    text: text.clone(),
                    ring: MainMessageRing::Steer,
                },
                AgentMessageKind::Progress | AgentMessageKind::Notice => {
                    let mut message =
                        AgentMessage::new(child_session, &route.parent_session, kind, text, now);
                    if let Some(key) = dedupe_key {
                        message = message.with_dedupe(key);
                    }
                    state.digest.push(message);
                    if state.digest.should_flush(&policy, now) {
                        MailboxAction::Digest(state.digest.drain_into_digest(
                            child_session,
                            &route.parent_session,
                            now,
                            policy.suppress_marker,
                        ))
                    } else {
                        MailboxAction::None
                    }
                }
                _ => {
                    let critical = kind == AgentMessageKind::Question;
                    let throttled = critical && now < state.cooldown_until;
                    let allowed = !throttled
                        && if critical {
                            state
                                .critical
                                .as_mut()
                                .is_some_and(|bucket| bucket.try_take(now))
                        } else {
                            state
                                .instant
                                .as_mut()
                                .is_some_and(|bucket| bucket.try_take(now))
                        };
                    if allowed {
                        MailboxAction::Instant {
                            text: text.clone(),
                            ring: if critical {
                                MainMessageRing::Steer
                            } else {
                                MainMessageRing::FollowUp
                            },
                        }
                    } else {
                        if critical {
                            state.cooldown_until = now + policy.critical_cooldown_ms as i64;
                        }
                        state.suppressed += 1;
                        let mut message = AgentMessage::new(
                            child_session,
                            &route.parent_session,
                            kind,
                            format!("[节流合并] {text}"),
                            now,
                        );
                        if let Some(key) = dedupe_key {
                            message = message.with_dedupe(key);
                        }
                        state.digest.push(message);
                        if state.digest.should_flush(&policy, now) {
                            MailboxAction::Digest(state.digest.drain_into_digest(
                                child_session,
                                &route.parent_session,
                                now,
                                policy.suppress_marker,
                            ))
                        } else {
                            MailboxAction::None
                        }
                    }
                }
            };
            (route.parent_session.clone(), action)
        };
        match action {
            MailboxAction::Instant { text, ring } => self.deliver(&parent, &text, ring).await,
            MailboxAction::Digest(Some(digest)) => {
                self.deliver(&parent, &digest.text, MainMessageRing::FollowUp)
                    .await
            }
            MailboxAction::Digest(None) | MailboxAction::None => Ok(()),
        }
    }

    async fn flush(&self, child_session: &str) {
        let _ = self.flush_child_digest(child_session).await;
    }
}

/// 终态统一冲洗（spawner 调用；失败仅告警）
pub async fn flush_child_best_effort(mailbox: &AgentMailbox, child_session: &str) {
    if let Err(error) = mailbox.flush_child_digest(child_session).await {
        tracing::warn!(
            target: "agent_mailbox",
            child_session,
            error = %error,
            "子代理摘要冲洗失败（终态通知仍会送达）"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct RecordingDelivery {
        calls: Mutex<Vec<(String, String, MainMessageRing)>>,
    }

    #[async_trait]
    impl MainAgentMessageChannel for RecordingDelivery {
        async fn deliver_self(
            &self,
            session_id: &str,
            message: &str,
            ring: MainMessageRing,
        ) -> Result<String, String> {
            self.calls.lock().unwrap().push((
                session_id.to_string(),
                message.to_string(),
                ring,
            ));
            Ok("msg-1".to_string())
        }
    }

    fn mailbox() -> (Arc<AgentMailbox>, Arc<RecordingDelivery>) {
        let delivery = Arc::new(RecordingDelivery::default());
        let mailbox = Arc::new(AgentMailbox::new(
            Arc::clone(&delivery) as Arc<dyn MainAgentMessageChannel>,
            None,
        ));
        mailbox.register_child("sub-sess-1", "s1", "sub-1");
        (mailbox, delivery)
    }

    #[tokio::test]
    async fn instant_question_delivers_immediately() {
        let (mailbox, delivery) = mailbox();
        mailbox
            .report(
                "sub-sess-1",
                AgentMessageKind::Question,
                "选 A 还是 B？".to_string(),
                None,
            )
            .await
            .expect("投递应成功");
        let calls = delivery.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].2, MainMessageRing::Steer);
        assert!(calls[0].1.contains("选 A 还是 B"));
    }

    #[tokio::test]
    async fn progress_is_buffered_until_flush() {
        let (mailbox, delivery) = mailbox();
        mailbox
            .report(
                "sub-sess-1",
                AgentMessageKind::Progress,
                "第一步完成".to_string(),
                None,
            )
            .await
            .expect("投递应成功");
        assert!(
            delivery.calls.lock().unwrap().is_empty(),
            "摘要通道不应立即唤醒父 agent"
        );
        mailbox.flush("sub-sess-1").await;
        let calls = delivery.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1.contains("第一步完成"));
    }

    #[tokio::test]
    async fn fault_bypasses_throttle() {
        let (mailbox, delivery) = mailbox();
        for index in 0..6 {
            mailbox
                .report(
                    "sub-sess-1",
                    AgentMessageKind::Fault,
                    format!("错误 {index}"),
                    None,
                )
                .await
                .expect("Fault 必达");
        }
        assert_eq!(delivery.calls.lock().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn unregistered_child_is_rejected() {
        let (mailbox, _delivery) = mailbox();
        let error = mailbox
            .report(
                "unknown",
                AgentMessageKind::Progress,
                "x".to_string(),
                None,
            )
            .await
            .expect_err("未登记必须报错");
        assert!(error.contains("未登记"));
    }
}
