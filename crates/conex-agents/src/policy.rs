//! 会话级子代理策略（主 agent 可调）与通信节奏默认值。
//!
//! 配置分层：App 默认 → Session 策略（本结构，落 `session_meta.agent_policy`）
//! → Spawn 覆盖（只能收窄）。所有默认值集中在此，禁止散落硬编码。

use serde::{Deserialize, Serialize};

use crate::guard::SpawnPolicy;

/// 能力策略
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CapabilityPolicy {
    /// 只读 → 可写升级是否需要父 agent/用户批准（默认 true）
    pub upgrade_requires_approval: bool,
}

impl Default for CapabilityPolicy {
    fn default() -> Self {
        Self {
            upgrade_requires_approval: true,
        }
    }
}

/// 通信节奏策略（即时 / 摘要双通道）。
///
/// 所有值都是**默认参数**，不是硬限制：主 agent 可按任务性质调整。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CommPolicy {
    /// 摘要聚合触发：时间间隔（ms）
    pub digest_interval_ms: u64,
    /// 摘要聚合触发：最大条数
    pub digest_max_items: usize,
    /// 摘要聚合触发：最大字节数
    pub digest_max_bytes: usize,
    /// 父 run 空闲时是否立即冲刷摘要
    pub digest_flush_on_parent_idle: bool,
    /// 普通即时消息令牌桶容量
    pub instant_capacity: u32,
    /// 普通即时消息每分钟补充数
    pub instant_refill_per_min: u32,
    /// 紧急消息令牌桶容量（Fault/Question/Result 等）
    pub critical_capacity: u32,
    /// 紧急消息每小时补充数
    pub critical_refill_per_hour: u32,
    /// 紧急配额耗尽后的长窗口抑制（ms）
    pub critical_cooldown_ms: u64,
    /// 相同 dedupeKey 的合并窗口（ms）
    pub coalesce_window_ms: u64,
    /// 被抑制时是否附计数标记（`[N 条已合并/抑制]`）
    pub suppress_marker: bool,
}

impl Default for CommPolicy {
    fn default() -> Self {
        CommunicationPreset::Normal.policy()
    }
}

/// 通信档位预设（用户可直接选档，也可逐字段覆盖）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommunicationPreset {
    /// 安静：长任务、少打扰
    Quiet,
    /// 常规（默认）
    Normal,
    /// 详细：短任务、需要细粒度进展
    Verbose,
}

impl CommunicationPreset {
    /// 档位对应策略
    pub fn policy(self) -> CommPolicy {
        match self {
            Self::Quiet => CommPolicy {
                digest_interval_ms: 300_000,
                digest_max_items: 50,
                digest_max_bytes: 16_384,
                digest_flush_on_parent_idle: true,
                instant_capacity: 2,
                instant_refill_per_min: 1,
                critical_capacity: 5,
                critical_refill_per_hour: 12,
                critical_cooldown_ms: 900_000,
                coalesce_window_ms: 10_000,
                suppress_marker: true,
            },
            Self::Normal => CommPolicy {
                digest_interval_ms: 90_000,
                digest_max_items: 20,
                digest_max_bytes: 8_192,
                digest_flush_on_parent_idle: true,
                instant_capacity: 3,
                instant_refill_per_min: 3,
                critical_capacity: 5,
                critical_refill_per_hour: 12,
                critical_cooldown_ms: 600_000,
                coalesce_window_ms: 5_000,
                suppress_marker: true,
            },
            Self::Verbose => CommPolicy {
                digest_interval_ms: 30_000,
                digest_max_items: 10,
                digest_max_bytes: 6_144,
                digest_flush_on_parent_idle: true,
                instant_capacity: 6,
                instant_refill_per_min: 6,
                critical_capacity: 8,
                critical_refill_per_hour: 24,
                critical_cooldown_ms: 300_000,
                coalesce_window_ms: 2_000,
                suppress_marker: true,
            },
        }
    }
}

/// 长程恢复策略（心跳 / 中断对账 / 恢复建议）。
///
/// 所有值都是**默认参数**：主 agent 可按任务时长与可靠性需求调整。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecoveryPolicy {
    /// 子代理心跳落库周期（ms）；越小越灵敏、写入越多。
    pub heartbeat_interval_ms: u64,
    /// 判定「长时间无心跳」的阈值（ms）：用于恢复建议与失联展示。
    pub stale_after_ms: u64,
    /// 重启对账后是否向父会话投递一条汇总摘要（digest 语义，不逐条轰炸）。
    pub notify_on_interrupt: bool,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            heartbeat_interval_ms: 20_000,
            stale_after_ms: 300_000,
            notify_on_interrupt: true,
        }
    }
}

/// 会话级完整策略（`session_meta.agent_policy` 的 JSON 形状）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentPolicy {
    /// 派遣策略（深度/嵌套/数量）
    pub spawn: SpawnPolicy,
    /// 通信节奏
    pub communication: CommPolicy,
    /// 能力升级策略
    pub capability: CapabilityPolicy,
    /// 长程恢复策略（心跳/对账）
    pub recovery: RecoveryPolicy,
}

impl AgentPolicy {
    /// 序列化为 session_meta 值（紧凑 JSON）
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// 从 session_meta 值解析；缺失/损坏回退默认（不阻断会话）。
    pub fn from_json(raw: Option<&str>) -> Self {
        raw.and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default()
    }

    /// 应用字段级补丁（深度合并；未知字段被 serde 忽略，非法值报错）。
    ///
    /// 主 agent 的 `configure_agents` 与用户配置层共用本实现，避免两套合并逻辑。
    pub fn apply_patch(&self, patch: &serde_json::Value) -> Result<Self, String> {
        let mut value =
            serde_json::to_value(self).map_err(|error| format!("agent_policy 序列化失败：{error}"))?;
        merge_json(&mut value, patch);
        serde_json::from_value(value).map_err(|error| format!("agent_policy 补丁非法：{error}"))
    }
}

/// 递归合并 JSON 对象；非对象值直接覆盖。
fn merge_json(base: &mut serde_json::Value, patch: &serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                match base_map.get_mut(key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        base_map.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_is_flat_and_unlimited() {
        let policy = AgentPolicy::default();
        assert_eq!(policy.spawn.max_depth, Some(1));
        assert!(!policy.spawn.allow_child_spawn);
        assert_eq!(policy.spawn.max_active_per_parent, None);
        assert_eq!(policy.spawn.max_active_per_session, None);
    }

    #[test]
    fn presets_are_ordered_by_noise_level() {
        let quiet = CommunicationPreset::Quiet.policy();
        let normal = CommunicationPreset::Normal.policy();
        let verbose = CommunicationPreset::Verbose.policy();
        assert!(quiet.digest_interval_ms > normal.digest_interval_ms);
        assert!(normal.digest_interval_ms > verbose.digest_interval_ms);
        assert!(quiet.instant_refill_per_min <= normal.instant_refill_per_min);
        assert!(verbose.instant_refill_per_min >= normal.instant_refill_per_min);
    }

    #[test]
    fn patch_merges_nested_fields_and_keeps_others() {
        let policy = AgentPolicy::default();
        let patched = policy
            .apply_patch(&serde_json::json!({
                "spawn": { "maxActivePerSession": 8, "allowChildSpawn": true },
                "communication": { "digestIntervalMs": 15000 }
            }))
            .expect("补丁应合法");
        assert_eq!(patched.spawn.max_active_per_session, Some(8));
        assert!(patched.spawn.allow_child_spawn);
        assert_eq!(patched.spawn.max_depth, Some(1), "未涉及字段保持原值");
        assert_eq!(patched.communication.digest_interval_ms, 15_000);
        assert_eq!(
            patched.communication.digest_max_items,
            CommPolicy::default().digest_max_items
        );
    }

    #[test]
    fn invalid_patch_type_is_rejected() {
        let policy = AgentPolicy::default();
        assert!(policy
            .apply_patch(&serde_json::json!({ "spawn": { "maxDepth": "many" } }))
            .is_err());
    }

    #[test]
    fn partial_json_keeps_defaults_for_missing_fields() {
        let policy = AgentPolicy::from_json(Some(r#"{"spawn":{"maxDepth":3}}"#));
        assert_eq!(policy.spawn.max_depth, Some(3));
        assert!(!policy.spawn.allow_child_spawn);
        assert_eq!(
            policy.communication.digest_interval_ms,
            CommPolicy::default().digest_interval_ms
        );
    }

    #[test]
    fn recovery_policy_is_patchable_and_defaults_sane() {
        let policy = AgentPolicy::default();
        assert_eq!(
            policy.recovery.heartbeat_interval_ms,
            RecoveryPolicy::default().heartbeat_interval_ms
        );
        let patched = policy
            .apply_patch(&serde_json::json!({
                "recovery": { "heartbeatIntervalMs": 5000, "notifyOnInterrupt": false }
            }))
            .expect("恢复策略补丁应合法");
        assert_eq!(patched.recovery.heartbeat_interval_ms, 5_000);
        assert!(!patched.recovery.notify_on_interrupt);
        assert_eq!(
            patched.recovery.stale_after_ms,
            RecoveryPolicy::default().stale_after_ms,
            "未涉及字段保持默认"
        );
        assert_eq!(patched.spawn, policy.spawn, "其他分组不受影响");
    }
}
