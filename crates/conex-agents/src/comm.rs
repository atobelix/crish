//! Agent 间通信的领域模型：消息、优先级、令牌桶与摘要聚合。
//!
//! 通道语义（00 §7）：
//! - instant：需要父 agent 立刻决策（Question / Fault / Result / 指令）；
//! - digest：过程信息（Progress），按时间/条数/字节合并后批量投递；
//! - 紧急消息可绕过普通桶，但受独立配额与长窗口冷却约束。

use serde::{Deserialize, Serialize};

use crate::policy::CommPolicy;

/// 消息类别
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentMessageKind {
    /// 父→子指令
    Instruction,
    /// 子→父过程信息（摘要通道）
    Progress,
    /// 子→父提问（即时）
    Question,
    /// 子→父/系统错误（即时、必达）
    Fault,
    /// 子→父结果（即时）
    Result,
    /// 系统通知（摘要）
    Notice,
}

impl AgentMessageKind {
    /// 是否走即时通道
    pub fn is_instant(self) -> bool {
        !matches!(self, Self::Progress | Self::Notice)
    }
}

/// 消息优先级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentMessagePriority {
    /// 普通
    Normal,
    /// 紧急（独立配额；Fault 恒为 Critical）
    Critical,
}

/// 统一消息信封
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    /// 消息 id（幂等）
    pub id: String,
    /// 发送方（subagent_id / "main"）
    pub from: String,
    /// 接收方（父会话 id / subagent_id）
    pub to: String,
    /// 类别
    pub kind: AgentMessageKind,
    /// 优先级
    pub priority: AgentMessagePriority,
    /// 去重键（同键在合并窗口内只保留最新）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
    /// 创建时间（epoch ms）
    pub created_at: i64,
    /// 过期时间（epoch ms；过期不投递）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// 文本载荷（摘要/问题/错误文案）
    pub text: String,
}

impl AgentMessage {
    /// 构造消息（Fault 自动升级为 Critical）
    pub fn new(
        from: impl Into<String>,
        to: impl Into<String>,
        kind: AgentMessageKind,
        text: impl Into<String>,
        now_ms: i64,
    ) -> Self {
        let from = from.into();
        Self {
            id: format!("agent-msg-{now_ms}-{}", uuid_like(now_ms, &from)),
            from,
            to: to.into(),
            kind,
            priority: if kind == AgentMessageKind::Fault {
                AgentMessagePriority::Critical
            } else {
                AgentMessagePriority::Normal
            },
            dedupe_key: None,
            created_at: now_ms,
            expires_at: None,
            text: text.into(),
        }
    }

    /// 设置去重键
    pub fn with_dedupe(mut self, key: impl Into<String>) -> Self {
        self.dedupe_key = Some(key.into());
        self
    }

    /// 设置过期时间
    pub fn with_expiry(mut self, expires_at: i64) -> Self {
        self.expires_at = Some(expires_at);
        self
    }

    /// 是否已过期
    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at.is_some_and(|deadline| now_ms >= deadline)
    }
}

fn uuid_like(now_ms: i64, from: &str) -> String {
    // 轻量唯一后缀：时间戳 + 发送方哈希（无 uuid 依赖；冲突由调用方 id 覆盖）
    let hash = from
        .bytes()
        .fold(0u64, |acc, byte| acc.wrapping_mul(31).wrapping_add(byte as u64));
    format!("{now_ms:x}{hash:x}")
}

/// 令牌桶（纯逻辑；用于即时/紧急通道限速）
#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_ms: f64,
    last_refill_ms: i64,
}

impl TokenBucket {
    /// 构造（refill_per_period：每个周期补充数；period_ms：周期长度）
    pub fn new(capacity: u32, refill_per_period: u32, period_ms: u64, now_ms: i64) -> Self {
        let capacity = capacity.max(1) as f64;
        Self {
            capacity,
            tokens: capacity,
            refill_per_ms: refill_per_period as f64 / period_ms.max(1) as f64,
            last_refill_ms: now_ms,
        }
    }

    fn refill(&mut self, now_ms: i64) {
        let elapsed = (now_ms - self.last_refill_ms).max(0) as f64;
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.refill_per_ms).min(self.capacity);
            self.last_refill_ms = now_ms;
        }
    }

    /// 尝试取一个令牌
    pub fn try_take(&mut self, now_ms: i64) -> bool {
        self.refill(now_ms);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// 当前可用令牌（调试/诊断）
    pub fn available(&mut self, now_ms: i64) -> f64 {
        self.refill(now_ms);
        self.tokens
    }
}

/// 摘要缓冲（按时间/条数/字节触发 flush）
#[derive(Debug, Default)]
pub struct DigestBuffer {
    items: Vec<AgentMessage>,
    bytes: usize,
    first_at_ms: Option<i64>,
}

impl DigestBuffer {
    /// 入队（同 dedupe_key 在窗口内替换为最新）
    pub fn push(&mut self, message: AgentMessage) {
        if let Some(key) = message.dedupe_key.as_deref() {
            if let Some(existing) = self
                .items
                .iter_mut()
                .find(|item| item.dedupe_key.as_deref() == Some(key))
            {
                self.bytes = self
                    .bytes
                    .saturating_sub(existing.text.len())
                    .saturating_add(message.text.len());
                *existing = message;
                return;
            }
        }
        self.bytes = self.bytes.saturating_add(message.text.len());
        if self.first_at_ms.is_none() {
            self.first_at_ms = Some(message.created_at);
        }
        self.items.push(message);
    }

    /// 是否达到 flush 条件
    pub fn should_flush(&self, policy: &CommPolicy, now_ms: i64) -> bool {
        if self.items.is_empty() {
            return false;
        }
        if self.items.len() >= policy.digest_max_items
            || self.bytes >= policy.digest_max_bytes
        {
            return true;
        }
        self.first_at_ms
            .is_some_and(|first| now_ms - first >= policy.digest_interval_ms as i64)
    }

    /// 取出全部条目（保持入队顺序）
    pub fn drain(&mut self) -> Vec<AgentMessage> {
        self.bytes = 0;
        self.first_at_ms = None;
        std::mem::take(&mut self.items)
    }

    /// 当前条数
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// 合并为单条摘要消息（父 agent 一次看到全部过程信息）
    pub fn drain_into_digest(
        &mut self,
        from: &str,
        to: &str,
        now_ms: i64,
        suppress_marker: bool,
    ) -> Option<AgentMessage> {
        let items = self.drain();
        if items.is_empty() {
            return None;
        }
        let mut text = items
            .iter()
            .map(|item| format!("- {}", item.text))
            .collect::<Vec<_>>()
            .join("\n");
        if suppress_marker && items.len() > 1 {
            text = format!("[{} 条进展]\n{text}", items.len());
        }
        Some(AgentMessage::new(
            from,
            to,
            AgentMessageKind::Progress,
            text,
            now_ms,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::CommunicationPreset;

    #[test]
    fn token_bucket_refills_and_caps() {
        let mut bucket = TokenBucket::new(2, 2, 1_000, 0);
        assert!(bucket.try_take(0));
        assert!(bucket.try_take(0));
        assert!(!bucket.try_take(0), "容量耗尽");
        assert!(bucket.try_take(500), "500ms 补充 1 个");
        assert!(bucket.try_take(1_000), "1s 补满至 2");
        assert!((bucket.available(10_000) - 2.0).abs() < 1e-9, "不得超过容量");
    }

    #[test]
    fn digest_flushes_on_items_bytes_or_interval() {
        let policy = CommunicationPreset::Normal.policy();
        let mut buffer = DigestBuffer::default();
        buffer.push(AgentMessage::new("s", "p", AgentMessageKind::Progress, "a", 0));
        assert!(!buffer.should_flush(&policy, 0));
        assert!(buffer.should_flush(&policy, policy.digest_interval_ms as i64));

        let mut many = DigestBuffer::default();
        for index in 0..policy.digest_max_items {
            many.push(AgentMessage::new(
                "s",
                "p",
                AgentMessageKind::Progress,
                format!("p{index}"),
                0,
            ));
        }
        assert!(many.should_flush(&policy, 0), "达到条数上限即 flush");
    }

    #[test]
    fn dedupe_key_replaces_latest() {
        let mut buffer = DigestBuffer::default();
        buffer.push(
            AgentMessage::new("s", "p", AgentMessageKind::Progress, "old", 0)
                .with_dedupe("step-1"),
        );
        buffer.push(
            AgentMessage::new("s", "p", AgentMessageKind::Progress, "new", 1)
                .with_dedupe("step-1"),
        );
        assert_eq!(buffer.len(), 1);
        let digest = buffer
            .drain_into_digest("s", "p", 2, true)
            .expect("应产出摘要");
        assert!(digest.text.contains("new"));
        assert!(!digest.text.contains("old"));
    }

    #[test]
    fn expired_messages_are_detected() {
        let message = AgentMessage::new("s", "p", AgentMessageKind::Progress, "x", 0)
            .with_expiry(100);
        assert!(!message.is_expired(99));
        assert!(message.is_expired(100));
    }

    /// 24h 通信浸泡（虚拟时间）：每分钟一条进展 + 持续尝试紧急消息，
    /// 摘要缓冲不得无界增长、紧急配额遵守容量+补充速率、桶不越界
    #[test]
    fn twenty_four_hour_communication_soak_remains_bounded() {
        let policy = CommunicationPreset::Normal.policy();
        let mut digest = DigestBuffer::default();
        let mut critical = TokenBucket::new(
            policy.critical_capacity,
            policy.critical_refill_per_hour,
            3_600_000,
            0,
        );
        let minute_ms = 60_000i64;
        let mut flushes = 0usize;
        let mut critical_grants = 0usize;
        let mut max_digest_items = 0usize;
        let mut max_digest_bytes = 0usize;
        for minute in 0..(24 * 60i64) {
            let now = minute * minute_ms;
            digest.push(
                AgentMessage::new(
                    "sub-1",
                    "main",
                    AgentMessageKind::Progress,
                    format!("第 {minute} 分钟进展：扫描与处理持续进行"),
                    now,
                )
                .with_dedupe("heartbeat-progress"),
            );
            max_digest_items = max_digest_items.max(digest.len());
            if digest.should_flush(&policy, now) {
                let summary = digest
                    .drain_into_digest("sub-1", "main", now, policy.suppress_marker)
                    .expect("非空缓冲必须产出摘要");
                assert!(
                    summary.text.len() <= policy.digest_max_bytes + 128,
                    "摘要文本不得超过字节上限（含标记余量）"
                );
                flushes += 1;
            }
            max_digest_bytes = max_digest_bytes.max(digest.bytes);
            if critical.try_take(now) {
                critical_grants += 1;
            }
            let available = critical.available(now);
            assert!(
                available <= policy.critical_capacity as f64 + 1e-9,
                "token bucket 不得超过容量"
            );
        }
        // 24h 至少按时间窗口冲刷一次；本次 dedupe 使其保持单条，
        // 每 90s 到期即冲刷 → 上限约 960 次，远小于分钟数
        assert!(flushes > 0, "24h 内必须发生摘要冲刷");
        assert!(
            max_digest_items <= policy.digest_max_items,
            "摘要缓冲条数不得超过上限：{max_digest_items}"
        );
        assert!(
            max_digest_bytes <= policy.digest_max_bytes.max(64),
            "摘要缓冲字节不得超过上限：{max_digest_bytes}"
        );
        // 紧急配额 = 初始容量 + 24h 补充（每小时 refill 条）
        let cap = policy.critical_capacity as usize
            + (24 * policy.critical_refill_per_hour as usize)
            + 1;
        assert!(
            critical_grants <= cap,
            "24h 紧急消息授权不得超过容量+补充速率：{critical_grants} > {cap}"
        );
    }
}
