use async_trait::async_trait;

use crate::core_error::CoreError;
use crate::run::{RunTaskOptions, RunTaskResponse};

/// 当前 UTC 毫秒时间戳（epoch ms；与全仓 epoch ms 惯例一致；时钟异常 0）
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 子代理 run 装配配置（run_task_impl 消费；IPC 命令面不携带——
/// serde 缺省 None，仅引擎内部 spawner 构造）
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunConfig {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 子代理 run id（session_agents.subagent_run_id；终态定位行）
    pub subagent_run_id: String,
    /// 父会话 id（subagent-started/ended 事件归属会话 + steering 通知目标）
    pub parent_session_id: String,
    /// 任务类型（wire 名；驱动默认权限集装配；None = 缺省 analysis）
    pub task_type: Option<String>,
    /// 显式写路径白名单（硬沙箱输入；None = 按默认集装配）
    pub allowed_write_paths: Option<Vec<String>>,
    /// 主控已定产出目录（Some = 注入 output_dir_section 提示词段）
    pub output_dir: Option<String>,
    /// 创建时刻（epoch ms；C2 started_at 注入与落库同源）
    pub started_at_ms: i64,
    /// 显式请求的权限上限（None = 完全跟随父链；只可收窄）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// 能力档（None = 按 task_type 默认；spawn 时只能收窄）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_mode: Option<String>,
    /// 模型覆盖（None = 跟随引擎当前配置）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
}

/// 子代理 run 启动器（trait object 切断 CoreRunState 类型递归——spawner
/// 在 CoreRunState 内，run 启动需回调 CoreRunState 上的 run_task_impl；
/// 生产实现 [CoreRunStateLauncher] 持 Weak 引用，无循环强引用）
#[async_trait]
pub trait SubagentRunLauncher: Send + Sync + std::fmt::Debug {
    /// 启动一次子代理 run（core_run_task 同通道）
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError>;

    /// 查询活动 run 的生效权限模式（供子代理无损继承父级权限）
    fn get_active_run_permission_mode(&self, _run_id: &str) -> Option<conex_types::PermissionMode> {
        None
    }
}
