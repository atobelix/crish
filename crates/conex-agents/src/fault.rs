//! 统一错误信封与可执行建议动作。
//!
//! 原则：错误必须带上下文（负载快照）与机器可执行建议，主 agent 才能
//! 自主调整（降并发、换模型、授权能力、重派等），而不是靠猜。

use serde::{Deserialize, Serialize};

/// 错误域
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentFaultScope {
    /// 准入/派发
    Spawn,
    /// 运行期
    Run,
    /// 工具执行
    Tool,
    /// 能力/只读升级
    Capability,
    /// 通信/节流
    Communication,
    /// 模型/provider
    Provider,
    /// 策略/配置
    Config,
}

/// 负载快照（容量/压力反馈）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoad {
    /// 当前活跃子代理数
    pub active_agents: usize,
    /// 同父活跃子代理数
    pub active_siblings: usize,
    /// 最近 1 分钟 provider 限流/5xx 次数（压力信号）
    pub provider_pressure_1m: u64,
    /// 待投递队列深度（通信积压）
    pub queue_depth: usize,
}

/// 建议动作（主 agent / 宿主可直接执行）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "params")]
pub enum AgentAction {
    /// 调整会话策略（字段级补丁，例如 `{"spawn":{"maxActivePerSession":8}}`）
    ConfigureAgents(serde_json::Value),
    /// 等待后重试
    Wait { ms: u64 },
    /// 切换模型（下一次调用生效）
    SwitchModel { model: String },
    /// 授予能力
    GrantCapability {
        agent_id: String,
        capability: String,
    },
    /// 恢复/重派子代理
    ResumeSubagent { agent_id: String },
    /// 缩小任务范围（改派只读调研等）
    ReduceScope,
    /// 上报用户
    AskUser,
}

/// 统一错误信封
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFault {
    /// 错误码（`agent.*` / 既有 `subagent.*`）
    pub code: String,
    /// 错误域
    pub scope: AgentFaultScope,
    /// 是否可重试
    pub retryable: bool,
    /// 建议重试延迟
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// 关联子代理
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// 关联 run
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 负载快照
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<AgentLoad>,
    /// 结构化详情（字段路径/原始错误等）
    #[serde(default)]
    pub detail: serde_json::Value,
    /// 可执行建议
    #[serde(default)]
    pub suggested_actions: Vec<AgentAction>,
}

impl AgentFault {
    /// 构造最小错误信封
    pub fn new(code: impl Into<String>, scope: AgentFaultScope) -> Self {
        Self {
            code: code.into(),
            scope,
            retryable: false,
            retry_after_ms: None,
            agent_id: None,
            run_id: None,
            load: None,
            detail: serde_json::Value::Null,
            suggested_actions: Vec::new(),
        }
    }

    /// 附加负载快照
    pub fn with_load(mut self, load: AgentLoad) -> Self {
        self.load = Some(load);
        self
    }

    /// 附加建议动作
    pub fn with_action(mut self, action: AgentAction) -> Self {
        self.suggested_actions.push(action);
        self
    }

    /// 标记可重试与延迟
    pub fn retryable_after(mut self, ms: u64) -> Self {
        self.retryable = true;
        self.retry_after_ms = Some(ms);
        self
    }
}

/// 错误码（`agent.*` 命名空间；既有 `subagent.*` 继续用于守卫/死锁）
pub mod codes {
    /// 容量/限流压力（数量或 provider 压力导致）
    pub const CAPACITY_PRESSURE: &str = "agent.capacity_pressure";
    /// 能力不足（只读子代理尝试写/执行）
    pub const CAPABILITY_DENIED: &str = "agent.capability_denied";
    /// 模型不可用/未配置
    pub const MODEL_UNAVAILABLE: &str = "agent.model_unavailable";
    /// 通信被节流/合并
    pub const COMM_THROTTLED: &str = "agent.comm_throttled";
    /// 策略配置非法
    pub const CONFIG_INVALID: &str = "agent.config_invalid";
    /// 代理被中断（进程重启/宿主断开）
    pub const INTERRUPTED: &str = "agent.interrupted";
    /// 派发失败（非策略原因）
    pub const SPAWN_FAILED: &str = "agent.spawn_failed";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fault_round_trips_with_actions() {
        let fault = AgentFault::new(codes::CAPACITY_PRESSURE, AgentFaultScope::Spawn)
            .with_load(AgentLoad {
                active_agents: 20,
                active_siblings: 20,
                provider_pressure_1m: 7,
                queue_depth: 3,
            })
            .with_action(AgentAction::ConfigureAgents(serde_json::json!({
                "spawn": { "maxActivePerSession": 8 }
            })))
            .retryable_after(30_000);
        let json = serde_json::to_string(&fault).expect("serialize");
        let back: AgentFault = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.code, "agent.capacity_pressure");
        assert_eq!(back.load.unwrap().provider_pressure_1m, 7);
        assert!(back.retryable);
        assert_eq!(back.suggested_actions.len(), 1);
    }
}
