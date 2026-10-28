//! 宿主端口（开发者替换点）。
//!
//! S1 只定义与 I/O 无关的最小端口；运行时的 Store/Launcher/Transport/Model
//! 端口在 `conex-agent-runtime` 抽取时补齐（见 01-分维 §3.2）。

use crate::policy::AgentPolicy;

/// 时钟端口（测试/回放可替换）
pub trait Clock: Send + Sync {
    /// 当前 Unix 毫秒
    fn now_ms(&self) -> i64;
}

/// 策略存储端口（session_meta / 配置中心均可实现）
pub trait PolicyStore: Send + Sync {
    /// 读取会话策略（None = 未配置）
    fn load(&self, session_id: &str) -> Result<Option<AgentPolicy>, String>;
    /// 写入会话策略
    fn save(&self, session_id: &str, policy: &AgentPolicy) -> Result<(), String>;
}
