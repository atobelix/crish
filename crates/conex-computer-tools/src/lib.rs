//! conex-computer-tools —— 软件内 AI 协同浏览器的 computer_* 工具族（S5 工具面，06 文档）
//!
//! ## 定位与依赖方向
//! 本 crate 是电脑操作工具族的注册与执行面，依赖方向与浏览器线同构（agent-tools 是
//! 叶子：crates/agent-tools/src/tools/mod.rs 头注释）：消费 `agent-tools` 的
//! `Tool`/`ToolDefinition`/`ToolContext`/`ToolRegistry` pub 接口、`conex-computer`
//! 的 `Action`/`ComputerSession`/`PerceptionSnapshot`/`SessionEnablement` 等 pub
//! 导出与 `conex-shared` 的共享抽象（FrameSource/InputBackend/ActionTargetGate），
//! **不反向进入** agent-tools 的 `register_builtin_tools`（该函数有注册数断言，
//! tools/mod.rs:718-756，不可扰动）——本 crate 提供**后置注册函数**
//! [register_computer_tools]，经 `ToolRegistry::register_runtime`（&self 共享面，
//! registry.rs:49）并入运行集，对齐浏览器线 `register_browser_tools` 先例
//! （conex-browser-tools/src/lib.rs:132）。
//!
//! ## 工具族（12 个，维度 1 收敛）
//! - 注入 8（全 dangerous=true）：click/type/key/hold_key/move/button/
//!   drag/scroll；
//! - 感知 4（全 dangerous=true）：wait/screenshot/
//!   cursor_position/snapshot(UIA)。
//!
//! ## 挂载判据
//! 会话级显式开启才挂载：未开启（或未注入 `SessionEnablement`）时本函数零注册
//! 并返回 Ok——`computer_*` 工具不存在，模型侧 tool schema 亦不含。
//!
//! ## 命名空间隔离（18 §2.1 / 06 文档 §3.4）
//! 自研工具统一 `computer_*` 前缀，与浏览器线 `browser_*` / MCP 桥 `mcp_<server>__*`
//! 天然互斥：注册表内无键冲突，同名返回 `tool.version_conflict` 的保护同样生效；
//! 两族工具同注册表共存、模型同时可见、名称无歧义。
//!
//! ## 实施轮范围（06 文档 §8 遗留接线 2-6）
//! 本文件为工具族注册与装配面：码表常量（[codes]）、会话注入抽象与真实会话
//! （[session]：`ComputerOps` trait + `RealComputerSession` Windows 实装 / 非
//! Windows 降级）、工具层错误构造与映射（[error]）、守卫链接线（[tools]：
//! 12 工具真实执行路径，三段守卫：会话注入/开启复查 → 互斥 → 中止自查 →
//! 执行，06 文档 §4.2）。骨架阶段占位的 `tool.computer.unwired` 已随接线消除。

/// computer_* 工具错误码（06 文档 §5 码表）。
///
/// 码表权威：06 文档 §5（`tool.computer.*` 域 + 跨线共享码 `tool.session.exclusive`）。
/// 本 crate 常量先行；**conex-types 码表登记已完成**（主控登记：codes 模块
/// `TOOL_COMPUTER_*` 7 码 + `TOOL_SESSION_EXCLUSIVE`，见
/// crates/conex-types/src/error.rs:134-148），两处取值一致。
pub mod codes {
    /// 参数非法（04 §2.1 / 18 §2.1：枚举/取值/组合合法性校验失败）
    pub const TOOL_COMPUTER_INVALID_PARAMS: &str = "tool.computer.invalid_params";
    /// 坐标越界（18 §4.4 API 空间边界校验失败；含 zoom region 越界）
    pub const TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS: &str = "tool.computer.coords_out_of_bounds";
    /// 提权窗口拒绝（18 §9 R3 / 05 文档 gate：UI-PIA 会话隔离，注入受限，不静默失败）
    pub const TOOL_COMPUTER_ELEVATED_WINDOW: &str = "tool.computer.elevated_window";
    /// 会话未开启/已挂起（运行期动作准入拒绝，零副作用；挂载后禁用兜底）
    pub const TOOL_COMPUTER_NOT_ENABLED: &str = "tool.computer.not_enabled";
    /// 电脑操作会话未注入/恢复期（工具面 gating，对齐 browser 的 not_ready 语义）
    pub const TOOL_COMPUTER_NOT_READY: &str = "tool.computer.not_ready";
    /// 中止/取消（会话级中止令牌触发，04 §4.3）
    pub const TOOL_COMPUTER_CANCELLED: &str = "tool.computer.cancelled";
    /// 能力缺失（UIA+视觉双通道皆无 → 拒绝启用，18 §3.4 降级矩阵第 4 格）
    pub const TOOL_COMPUTER_CAPABILITY_UNAVAILABLE: &str = "tool.computer.capability_unavailable";
    /// 会话互斥（S3 ActivationGate 守卫；browser_* 与 computer_* 共用同一码，
    /// 18 §6.3 / 04 §4.6，守卫检查点在审批之前）
    pub const TOOL_SESSION_EXCLUSIVE: &str = "tool.session.exclusive";
}

/// 会话访问抽象与真实会话适配（06 文档 §4.1 / 遗留③）。
pub mod session;

/// 工具层错误构造与映射（06 文档 §5 码表消费面；对齐浏览器线 error.rs 先例）。
mod error;

/// 工具族实现（12 个 computer_* 工具 + 守卫链接线 + 注册清单）。
mod tools;

use agent_tools::definition::ToolError;
use agent_tools::registry::ToolRegistry;
use std::sync::Arc;

/// 工具注册清单常量数组（12 个；注册序 = 注入 8 → 感知 4）。
///
/// 与 [tools::definitions] 逐一对应——注册数断言测试
/// 以本清单为唯一权威，防清单与实现漂移。
pub const ALL_TOOL_NAMES: &[&str] = &[
    // 注入 8
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_hold_key",
    "computer_move",
    "computer_button",
    "computer_drag",
    "computer_scroll",
    // 感知 4
    "computer_wait",
    "computer_screenshot",
    "computer_cursor_position",
    "computer_snapshot",
];

/// 电脑操作工具注册配置（引擎侧会话装配时注入，06 文档 §3.1）。
///
/// - `enablement`：会话级显式开启判据（[SessionEnablement::tool_mount_allowed]）。
///   **挂载判据：未开启（或未注入）→ 本函数零注册返回 Ok**——`computer_*`
///   工具不存在，模型侧 tool schema 亦不含（安全默认）；
/// - `session`：会话注入面（[ComputerOps] trait；测试 mock 替身 / 引擎
///   RealComputerSession）；
/// - `activation`：会话互斥守卫（[ActivationGate]，S3；工具执行前检查
///   `current().is_desktop()`，非桌面态返回 `tool.session.exclusive`）。
#[derive(Clone, Default)]
pub struct ComputerToolsConfig {
    /// 会话注入面（缺省 None = 不注入；工具执行返回 not_ready 语义）
    pub session: Option<Arc<dyn session::ComputerOps>>,
    /// 会话级显式开启判据（缺省 None = 视为未开启，零注册安全默认）
    pub enablement: Option<Arc<conex_computer::security::SessionEnablement>>,
    /// 会话互斥守卫（S3；守卫②）
    pub activation: Option<Arc<conex_computer::activation::ActivationGate>>,
}

/// 注册全部 12 个 computer_* 工具（后置注册函数，**不进入** agent-tools 的
/// `register_builtin_tools`）。
///
/// ## 挂载判据
/// `config.enablement.tool_mount_allowed()` 为真才注册；未开启 / 未注入 →
/// **零注册返回 Ok**（未开启时工具不存在，模型侧 tool schema 亦不含；安全默认，
/// 注册数断言测试守护）。运行期禁用（停止回 Idle）由工具执行守卫链
/// `tool.computer.not_enabled` 兜底。
///
/// ## 幂等语义（06 文档 §3.2）
/// 同名工具已注册（MCP/引擎预注册/重复调用）时跳过，不报冲突；注册失败
/// 返回结构化错误。
pub fn register_computer_tools(
    registry: &mut ToolRegistry,
    config: ComputerToolsConfig,
) -> Result<(), ToolError> {
    // 挂载判据（security.rs:226 tool_mount_allowed 注释登记：S5 注册函数判据）
    let mounted = config
        .enablement
        .as_ref()
        .is_some_and(|e| e.tool_mount_allowed());
    if !mounted {
        return Ok(());
    }
    let ctx = Arc::new(tools::GuardCtx {
        session: config.session,
        activation: config.activation,
        enablement: config.enablement,
    });
    tools::register_all(registry, ctx)
}

/// 测试资产（守卫链顺序 / 参数校验 / 返回形状 /
/// 注册挂载与共存；骨架测试保留并演进，AGENTS.md 铁律）。
#[cfg(test)]
mod tests;
