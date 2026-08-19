// SR-06d · 拆分 · ≠ EL：recovery.rs 逻辑域拆模 1/3 —— 阶梯 1 重试策略与
// Episode 预算制（原 recovery.rs 122-336 区间原样迁入，公开面经 recovery.rs
// `pub use` 重导出，语义零改动）。

use std::collections::HashMap;
use std::time::Duration;

use conex_types::error::ProviderErrorKind;

use super::{RECOVERY_BASE_DELAY_MS, RECOVERY_MAX_DELAY_MS, RECOVERY_TOTAL_BUDGET_MS};
use crate::recovery::RecoveryError;

/// 重试策略（镜像 `agent-provider::retry::RetryPolicy` 的默认值；
/// orchestrator 不依赖 agent-provider，退避公式与分类语义逐条镜像，
/// 测试锁定与 retry.rs 同期望值防漂移）
///
/// 手动镜像标注：镜像源 = `agent-provider/src/retry.rs`。orchestrator 不依赖
/// agent-provider（避免拉重依赖），变更 `retry.rs` 时须手动同步
/// `recovery_policy.rs` 的默认值与分类语义。CI 对账：`crates/orchestrator/tests/recovery_policy_parity.rs`
/// 锁定默认值与分类语义防漂移（与 retry.rs 同期望值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryRetryPolicy {
    /// 最大重试次数（0 = 不重试，与 retry.rs 同语义：显式开启才重试）
    pub max_retries: u32,
    /// 首次退避基数（默认 750ms）
    pub base_delay_ms: u64,
    /// 单次等待上限（默认 8s）
    pub max_delay_ms: u64,
    /// 总重试预算（默认 60s，超出即停止）
    pub total_budget_ms: u64,
}

impl Default for RecoveryRetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 0,
            base_delay_ms: RECOVERY_BASE_DELAY_MS,
            max_delay_ms: RECOVERY_MAX_DELAY_MS,
            total_budget_ms: RECOVERY_TOTAL_BUDGET_MS,
        }
    }
}

/// 瞬态类错误分类（镜像 retry.rs `should_retry` 的可重试集：rate-limit /
/// 5xx / 网络 / 超时；auth、quota、context_length 等不可重试——
/// context_length 由上层压缩处理，00 D5：分类与收口分离）
pub fn is_transient_kind(kind: ProviderErrorKind) -> bool {
    matches!(
        kind,
        ProviderErrorKind::RateLimit
            | ProviderErrorKind::ServerError
            | ProviderErrorKind::Timeout
            | ProviderErrorKind::Network
    )
}

/// 指数退避（镜像 retry.rs `retry_delay_ms`：`min(max_delay, base *
/// 2^(attempt-1))`，指数上限 62 防溢出）
pub fn backoff_delay_ms(policy: &RecoveryRetryPolicy, attempt: u32) -> Duration {
    let base_delay_ms = policy.base_delay_ms.max(1);
    let max_delay_ms = policy.max_delay_ms.max(base_delay_ms);
    let exponent = (attempt.max(1) - 1).min(62);
    let backoff = base_delay_ms.saturating_mul(1u64 << exponent);
    Duration::from_millis(backoff.min(max_delay_ms))
}

/// 阶梯 1 决策
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ladder1Decision {
    /// 预算内自动重试（重试不计入 run 失败；attempt 从 1 起）
    Retry {
        /// 本次重试序号
        attempt: u32,
        /// 重试前等待时长（已钳到单次上限与剩余预算）
        delay: Duration,
        /// 本次等待后的剩余总预算（毫秒）
        remaining_budget_ms: u64,
    },
    /// 超预算 / 不可重试：上行阶梯 2
    Escalate {
        /// 上行原因
        reason: EscalateReason,
    },
}

/// 阶梯 1 上行原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscalateReason {
    /// 非瞬态类错误（auth/quota/context_length 等，不走本阶梯）
    NonTransient,
    /// 流已产出内容后的中途错误（对齐 retry.rs：重试会重复已流出的内容）
    ContentProduced,
    /// 总预算耗尽（elapsed >= total_budget_ms）
    BudgetExhausted,
    /// 达到最大重试次数
    RetriesExhausted,
}

/// 阶梯 1 判定（镜像 retry.rs `should_retry` + `provider_stream` 语义：
/// 已产出内容不重试 → 瞬态分类 → 次数上限 → 总预算 → 退避钳制）
pub fn ladder1_decision(
    kind: ProviderErrorKind,
    retries: u32,
    elapsed_ms: u64,
    produced_content: bool,
    policy: &RecoveryRetryPolicy,
) -> Ladder1Decision {
    // 流已产出内容：中途错误不重试，直接上行阶梯 2（02 §六.7）
    if produced_content {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::ContentProduced,
        };
    }
    // 仅瞬态类可重试
    if !is_transient_kind(kind) {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::NonTransient,
        };
    }
    if retries >= policy.max_retries {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::RetriesExhausted,
        };
    }
    // 预算：elapsed < total_budget 才继续（对齐 withinRetryBudget 的严格小于）
    if elapsed_ms >= policy.total_budget_ms {
        return Ladder1Decision::Escalate {
            reason: EscalateReason::BudgetExhausted,
        };
    }
    let attempt = retries + 1;
    let remaining_budget_ms = policy.total_budget_ms - elapsed_ms;
    let delay = backoff_delay_ms(policy, attempt).min(Duration::from_millis(remaining_budget_ms));
    Ladder1Decision::Retry {
        attempt,
        delay,
        remaining_budget_ms,
    }
}

/// 操作指纹：subagent_id + 任务文本的 FNV-1a 64 位哈希（十六进制）。
///
/// 语义（对齐 Reasonix Auto Guard）：同一操作（同子代理定义 + 同任务）
/// 共享一个 Episode 预算，重启不重放授权；不同任务不互相消耗。
pub fn fingerprint(subagent_id: &str, task: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in subagent_id.as_bytes().iter().chain(&[0u8]) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    for byte in task.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 恢复预算（Episode 预算制：每会话每操作指纹最多恢复 N 次，
/// 默认 3，可配 `recover_max_episodes`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryBudget {
    /// 每指纹恢复上限（阶梯 3 fork 次数）
    limit: u32,
    /// 操作指纹 → 已消费恢复次数
    counts: HashMap<String, u32>,
}

impl RecoveryBudget {
    /// 新建预算（默认上限 [Self::default_limit] = 3）
    pub fn new(limit: u32) -> Self {
        Self {
            limit: limit.max(1),
            counts: HashMap::new(),
        }
    }

    /// 默认 Episode 预算上限
    pub fn default_limit() -> u32 {
        3
    }

    /// 预算上限
    pub fn limit(&self) -> u32 {
        self.limit
    }

    /// 某指纹已消费的恢复次数
    pub fn count(&self, fingerprint: &str) -> u32 {
        self.counts.get(fingerprint).copied().unwrap_or(0)
    }

    /// 该指纹是否仍有自动恢复额度（超预算禁止自动恢复，直接阶梯 4）
    pub fn can_recover(&self, fingerprint: &str) -> bool {
        self.count(fingerprint) < self.limit
    }

    /// 消费一次恢复额度（阶梯 3 fork 前调用）。
    ///
    /// 超预算返回 [RecoveryError::BudgetExceeded]（调用方转阶梯 4）；
    /// 幂等由调用方保证（同指纹同源 run 已 fork 过则不再计数）。
    pub fn record_fork(&mut self, fingerprint: &str) -> Result<u32, RecoveryError> {
        if !self.can_recover(fingerprint) {
            let count = self.count(fingerprint);
            return Err(RecoveryError::BudgetExceeded {
                fingerprint: fingerprint.to_string(),
                count,
                max: self.limit,
            });
        }
        let entry = self.counts.entry(fingerprint.to_string()).or_insert(0);
        *entry += 1;
        Ok(*entry)
    }

    /// 序列化（`recover_episodes` 键落库形态）
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.counts).unwrap_or_else(|_| "{}".to_string())
    }

    /// 从持久化恢复（宽容解析：缺失 / 坏 JSON → 空预算，fail-open 不 panic）
    pub fn from_json(raw: Option<&str>, limit: u32) -> Self {
        let counts = raw
            .and_then(|raw| serde_json::from_str::<HashMap<String, u32>>(raw).ok())
            .unwrap_or_default();
        Self {
            limit: limit.max(1),
            counts,
        }
    }
}
