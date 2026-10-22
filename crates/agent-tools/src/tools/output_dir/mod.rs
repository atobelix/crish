//! 文档产出目录解析（T-EG-08 / REQ-G01：resolve_output_dir 工具与
//! OutputWorkspace 服务）
//!
//! 定位（方案 04 §4.4 + 调研-可视化与扩展点.md §4）：
//! - 工具：`resolve_output_dir`（注册面 16→17）——显式 folder 优先（直接
//!   使用，不创建目录）；无 folder 生成
//!   `<workspace_root>/.agent-outputs/<YYYY-MM-DD>-<会话标识>/`
//!   （**本地时区、零填充日期前缀**；会话标识经净化：剥离 `\/:*?"<>|`
//!   与控制字符，对齐 applyFileDiff.ts:55-61 净化思路）；**惰性**——仅写
//!   session_meta `"{session_id}:output_dir"` 不建目录，返回
//!   `dirCreated: false` 与「首次写入时自动创建」说明；
//! - 幂等：读 session_meta 命中即返回同一路径（目录名会话**首次** resolve
//!   冻结，同会话不因跨日再调用而漂移）；
//! - 用户显式 folder 同时写入 session_meta（用户指定优先，后续默认沿用）；
//! - 只读子代理不允许自选输出目录：folder 参数忽略，仅返回主 agent 规划
//!   的产出目录（只读信号 = ctx.explore_docs_quota 装配——探索类子代理
//!   = capabilityMode read-only，见 explore_quota.rs 模块头契约；本层为
//!   工具面兜底，注册表级裁剪由 readonly.rs 白名单另行承担）。
//!
//! 接线契约（对齐 explore_quota / revert_guard 模式）：agent-tools 是叶子
//! crate，生产代码不依赖 conex-db——session_meta 读写由引擎侧实现
//! [OutputDirStore]（get/set_session_meta 后端）注入服务；本模块只定义
//! 契约、纯逻辑与工具本身。测试域以 conex-db（dev-dependency）验证
//! session_meta 往返与键编码。
//!
//! 本地时区约束：项目无 chrono 依赖（Cargo.toml 冻结），std 无本地时区
//! 换算面——Windows 上以 kernel32 极小 FFI（GetLocalTime / GetSystemTime）
//! 同刻采集本地/UTC 时钟，差值即本地时区偏移（含夏令时，OS 语义保证；
//! 采集抖动经 15 分钟取整消除——真实时区偏移均为 15 分钟整数倍）；其余
//! 平台回退 UTC（偏移 0），文档明示。日期段为纯函数
//! （[format_date_prefix]：固定时间 + 固定偏移可确定性单测）。

// 工具实现沿用 tools 层共享 helper（原文件内以 `super::` 调用，搬入 tool.rs 后经此处导入保持调用点逐字不变）
use super::{display_path, optional_string, resolve_workspace_path};

mod date;
mod resolver;
#[cfg(test)]
mod tests;
mod tool;

pub use date::{format_date_prefix, local_utc_offset_minutes, sanitize_session_id};
pub use resolver::{
    output_dir_meta_value, parse_output_dir_meta, AgentOutputDir, InMemoryOutputDirStore,
    OutputDirResolver, OutputDirStore, OutputWorkspace, ResolveOutputDirResult,
};
pub(crate) use tool::ResolveOutputDirTool;

/// 产出目录持久化键（session_meta `"{session_id}:output_dir"`，键编码复用
/// explore_quota.rs 的 [crate::explore_quota::session_meta_key_of]）
pub const SESSION_META_KEY_OUTPUT_DIR: &str = "output_dir";
/// 默认产出根目录名（G03 路径隔离：`<workspace_root>/.agent-outputs`）
pub const DEFAULT_OUTPUTS_ROOT_NAME: &str = ".agent-outputs";
