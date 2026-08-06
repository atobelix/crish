//! 后台任务管理器契约（T-AB-02：冻结契约层，跨 Agent 只读）
//!
//! 定位（docs/feature-gap-analysis/plans/01-AB命令执行与后台任务方案.md §4）：
//! - 本模块只定义 trait 与数据结构（§4.1 / §4.2 / §4.4 全文），是跨轮冻结的
//!   契约本体；字段形状与 serde 属性（camelCase / kebab-case）必须与方案
//!   §4 逐字一致——A3（壳层注册表 T-AB-07）与 R-AB2/R-AB3 全部按此消费；
//! - 注入范式与 `BuiltinToolConfig.subagent_spawner`（tools/mod.rs:53-57）
//!   同一模式：壳层实现，agent-tools 只持 trait 引用；None = 未接线，
//!   shell 超时保持「树杀」现状（零回归）；
//! - `ResourceSample`（§4.3）被 §4.2 `BackgroundTaskInfo.resource` 引用，
//!   一并落地；`ProcessHealth` / `ResourceMonitorConfig` 属 R-AB3
//!   （T-AB-15/16），本轮不落地。
//!
//! 语义要点（供壳层实现对齐）：
//! - adopt：Child 所有权转移（kill_on_drop 已关闭），stdout/stderr 管道仍在；
//! - task_id 命名风格 `task-<seq>`（对齐 pty id），命名空间独立；
//! - 日志路径约定：`<app_dir>/logs/tasks/<task_id>.log`（§4.6）。

use crate::definition::ToolError;
use async_trait::async_trait;
use serde::Serialize;
use std::path::PathBuf;

/// 后台任务管理器契约（AI 侧工具与壳层实现的解耦边界）
///
/// 注：与 `BuiltinToolConfig.subagent_spawner`（mod.rs:53-57）同一注入范式；
/// 壳层实现，agent-tools 只持 trait 引用；None = 未接线，保持现状（超时即杀）。
#[async_trait]
pub trait BackgroundTaskManager: Send + Sync + std::fmt::Debug {
    /// 把已 spawn 的 child 转交后台托管（模式 2 / 3 共用入口）
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError>;
    /// 查询任务列表（REQ-B01；include_finished=false 只返回活跃）
    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError>;
    /// 查询单任务状态与尾部日志（REQ-B02）
    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError>;
    /// 按行范围读取日志（REQ-A05；start_line=None 读尾部 max_lines 行）
    async fn read_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<LogSlice, ToolError>;
    /// 向任务 stdin 写入（REQ-B03；末尾自动追加 \n，除非 append_newline=false）
    async fn send_input(
        &self,
        task_id: &str,
        text: &str,
        append_newline: bool,
    ) -> Result<(), ToolError>;
    /// 两阶段终止（REQ-B04：优雅 → 5s → 强制）
    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError>;
}

/// adopt 请求（模式 2 / 3 共用；所有权转移，kill_on_drop 已关闭）
pub struct BackgroundAdoptRequest {
    /// kill_on_drop=false，stdout/stderr 管道仍在
    pub child: tokio::process::Child,
    /// 命令摘要（前 64 字符）
    pub command: String,
    pub cwd: PathBuf,
    /// 模式 3：run 结束不回收
    pub is_daemon: bool,
    /// REQ-A04
    pub resource_monitor: bool,
    /// run 关联（审计与过滤用，不级联杀）
    pub owner_run_id: Option<String>,
}

/// adopt 结果
pub struct BackgroundTaskRef {
    /// task-<seq>，命名风格对齐 pty id（pty/mod.rs:104-111），命名空间独立
    pub task_id: String,
    /// <app_dir>/logs/tasks/<task_id>.log
    pub log_path: PathBuf,
}

/// 任务状态机（四态；前端归一函数 normalizeBackgroundTaskState
/// 可容忍的别名映射不改变本枚举——前端解析层原样保留）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    /// 运行中
    Running,
    /// 自然退出且 exit_code == 0
    Completed,
    /// 自然退出且 exit_code != 0
    Failed,
    /// 被显式终止（两阶段终止成功后）
    Killed,
}

/// 任务快照（registry 内存条目；list 返回形状）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskInfo {
    pub task_id: String,
    /// 摘要（前 64 字符）
    pub command: String,
    pub cwd: String,
    pub status: TaskState,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    /// 终态时间（归档计时起点）
    pub finished_at_ms: Option<u64>,
    /// 终态可用
    pub exit_code: Option<i32>,
    pub log_path: String,
    /// 已累积行数（转发器维护）
    pub line_count: u64,
    /// 最近输出时间（= 启动时间若无输出）
    pub last_output_at_ms: u64,
    pub is_daemon: bool,
    /// 最新采样（A04；未启用则为 None）
    pub resource: Option<ResourceSample>,
    /// 检测到的交互提示（B03）
    pub prompt: Option<String>,
    /// run 关联（继承旧 runIndex 语义，不自动级联杀）
    pub owner_run_id: Option<String>,
    /// 疑似卡死标记（14-T2a wire：健康判定转 Suspicious 时置位，Healthy 复位；
    /// 保持期/Crashed 不写，终态保留最后一次写值——前端轮询经此字段渲染
    /// 「疑似卡死」标记，见 34 方案 §2.3）
    pub suspicious: bool,
}

/// status 返回（REQ-B02：状态 + 退出码 + 日志位置 + 时长 + 资源快照 + 尾部）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskStatus {
    pub task_id: String,
    pub status: TaskState,
    pub exit_code: Option<i32>,
    pub log_path: String,
    pub duration_ms: u64,
    pub line_count: u64,
    pub last_output_at_ms: u64,
    pub resource: Option<ResourceSample>,
    /// 最近 20 行 stdout 尾部（运行中同样可读）
    pub tail: String,
    pub prompt: Option<String>,
    /// 两阶段终止留痕（对齐旧快照字段语义）
    pub termination_diagnostics: Vec<String>,
}

/// 单次采样快照（REQ-A04 4.1 四指标；写入 <task_id>.samples.jsonl，
/// 复用 perf/jsonl.rs:49-72）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    pub sampled_at_ms: u64,
    /// 进程树 CPU 使用率（周期差值 / 墙钟差值；首采样丢弃基线）
    pub cpu_percent: f64,
    /// RSS / 工作集内存
    pub rss_bytes: u64,
    /// 事件驱动刷新（转发器读到字节即更新），非采样轮询
    pub last_output_at_ms: u64,
    /// 首版可恒为 0（诚实边界：Windows 进程树聚合繁琐，列为可选）
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
}

/// kill 结果三态（对齐旧 daemon 错误码三态语义；NotFound 风格对齐 ToolError::NotFound）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KillResult {
    /// 成功终止（via_force=两阶段升级）
    Killed { task_id: String, via_force: bool },
    /// 进程已不存在（自然退出）
    AlreadyExited { task_id: String, exit_code: Option<i32> },
    /// 终止失败附原因
    Failed { task_id: String, reason: String },
}

/// read_log 返回（行号范围读取；尾部读取 = start_line=None）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSlice {
    pub task_id: String,
    /// 实际返回的首行（1-indexed）
    pub start_line: u64,
    /// 实际返回的末行
    pub end_line: u64,
    /// 当前文件总行数
    pub total_lines: u64,
    /// 每行末尾不含换行
    pub lines: Vec<String>,
    /// 日志文件超过单次读取上限时置位
    pub truncated: bool,
}
