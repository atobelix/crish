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
//! ## 工具族（13 个，06 文档 §2 命名裁决）
//! - 注入 8（全 dangerous=true，Ask 审批）：click/type/key/hold_key/move/button/
//!   drag/scroll；
//! - 感知 4（全 dangerous=true，默认审批；可配会话内免审）：wait/screenshot/
//!   cursor_position/snapshot(UIA)；
//! - 急停 1（dangerous=true）：estop（AI 主动急停，并入全局急停链）。
//!
//! ## 挂载判据（04 §4.1 / security.rs `tool_mount_allowed`）
//! 会话级显式开启才挂载：未开启（或未注入 `SessionEnablement`）时本函数零注册
//! 并返回 Ok——`computer_*` 工具不存在，模型侧 tool schema 亦不含（安全默认）。
//!
//! ## 命名空间隔离（18 §2.1 / 06 文档 §3.4）
//! 自研工具统一 `computer_*` 前缀，与浏览器线 `browser_*` / MCP 桥 `mcp_<server>__*`
//! 天然互斥：注册表内无键冲突，同名返回 `tool.version_conflict` 的保护同样生效；
//! 两族工具同注册表共存、模型同时可见、名称无歧义。
//!
//! ## 骨架范围（本任务）
//! 本文件为可编译空实现骨架：码表常量（[codes]）、会话注入抽象（[session]）、
//! 13 个工具定义（input schema/dangerous 定稿，06 文档 §2 全表）、注册函数与
//! 挂载判据；工具执行统一返回 `tool.computer.unwired`（未接线契约）。守卫链
//! （互斥/开启复查/审批/急停）与真实执行路径为实施轮接线项（06 文档 §9 遗留）。

/// computer_* 工具错误码（06 文档 §5 码表）。
///
/// 码表权威：06 文档 §5（`tool.computer.*` 域 + 跨线共享码 `tool.session.exclusive`）。
/// 本 crate 常量先行，**conex-types 码表登记为遗留接线项**（由主控登记进
/// `crates/conex-types/src/error.rs` 的 codes 模块与错误注册表，本 crate 不触碰
/// 其他文件）；未接线面（`unwired`）为骨架阶段专用语义，实施轮接线后消除。
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
    /// 急停/取消（全局急停或会话级中止令牌触发，04 §4.3）
    pub const TOOL_COMPUTER_CANCELLED: &str = "tool.computer.cancelled";
    /// 能力缺失（UIA+视觉双通道皆无 → 拒绝启用，18 §3.4 降级矩阵第 4 格）
    pub const TOOL_COMPUTER_CAPABILITY_UNAVAILABLE: &str = "tool.computer.capability_unavailable";
    /// 未接线（骨架阶段占位；实施轮接线后消除，对齐 browser 的 unwired 先例）
    pub const TOOL_COMPUTER_UNWIRED: &str = "tool.computer.unwired";
    /// 会话互斥（S3 ActivationGate 守卫；browser_* 与 computer_* 共用同一码，
    /// 18 §6.3 / 04 §4.6，守卫检查点在审批之前）
    pub const TOOL_SESSION_EXCLUSIVE: &str = "tool.session.exclusive";
}

/// 会话访问抽象（对齐浏览器线 `SessionOps` 范式，04 §3 项 4）。
///
/// 工具经构造注入消费会话（[super::ComputerToolsConfig::session]），真实实现
/// （实施轮 `RealComputerSession`）仅使用 conex-computer 的 pub 接口（Action
/// 派发 / 截屏感知 / UIA 快照 / 感知版本号），测试注入 mock 替身。
pub mod session {
    use async_trait::async_trait;
    use conex_computer::perception::{PerceptionError, PerceptionSnapshot};
    use conex_computer::{Action, ActionResult, CapturedFrame, SessionError};

    /// 电脑操作会话操作抽象（computer_* 工具与 ComputerSession 的唯一交互面）。
    ///
    /// 方法契约（06 文档 §4.1）：
    /// - [`readiness`](Self::readiness)：Err(原因) = 工具层应返回
    ///   `tool.computer.not_ready`（会话未初始化/恢复期 gating）；
    /// - [`dispatch`](Self::dispatch)：动作派发闭环（参数校验 → 坐标换算 →
    ///   注入，04 §2.1 流程第 1-2 步；急停批次自查在会话内）；
    /// - [`screenshot`](Self::screenshot)：缩放后全桌面合成帧（zoom region
    ///   裁剪为工具层纯后处理，不占会话面）；
    /// - [`snapshot`](Self::snapshot)：UIA 结构化快照（数据面抑制已内置：
    ///   密码框占位 `<password>` / 键名脱敏，18 §3.3）；
    /// - [`perception_version`](Self::perception_version)：感知版本号（截屏/
    ///   布局重建/UIA 树变化/输入动作后推进，18 §5 项 7 替换面）。
    #[async_trait]
    pub trait ComputerOps: Send + Sync {
        /// 就绪检查：Err(原因) = 工具层应返回 `tool.computer.not_ready`
        fn readiness(&self) -> Result<(), String>;
        /// 动作派发（参数校验 → 坐标换算 → 注入）
        async fn dispatch(&self, action: &Action) -> Result<ActionResult, SessionError>;
        /// 截屏感知（缩放后合成帧）
        async fn screenshot(&self) -> Result<CapturedFrame, SessionError>;
        /// UIA 结构化快照（数据面抑制后产物）
        async fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError>;
        /// 感知版本号（校验路径复用；动作后推进）
        fn perception_version(&self) -> u64;
    }
}

/// 工具层错误构造（06 文档 §5 码表消费面；骨架阶段仅未接线错误面）。
mod error {
    use crate::codes;
    use agent_tools::definition::ToolError;

    /// 未接线错误（`tool.computer.unwired`，骨架占位；实施轮接线后替换为真实路径）
    pub(crate) fn unwired(what: impl Into<String>) -> ToolError {
        ToolError::new(
            codes::TOOL_COMPUTER_UNWIRED,
            format!("{}未接线（S5 骨架占位，实施轮接线）", what.into()),
        )
    }
}

/// 工具定义与注册清单（13 个 computer_* 工具，06 文档 §2 全表）。
mod tools {
    use crate::error;
    use agent_tools::context::ToolContext;
    use agent_tools::definition::{Tool, ToolDefinition, ToolError};
    use agent_tools::registry::ToolRegistry;
    use async_trait::async_trait;
    use serde_json::{json, Value};

    /// 空实现工具：定义齐全（名称/描述/schema/dangerous 定稿），执行统一返回
    /// 未接线错误（`tool.computer.unwired`）——注册面与工具面契约先行落地，
    /// 实施轮以真实工具替换同名字符串（[super::ALL_TOOL_NAMES] 不变量保持）。
    pub(crate) struct UnwiredComputerTool {
        def: ToolDefinition,
    }

    impl UnwiredComputerTool {
        /// 构造空实现工具（全量 dangerous=true，06 文档 §2 裁决）
        pub(crate) fn new(
            name: &'static str,
            description: &'static str,
            input_schema: Value,
        ) -> Self {
            Self {
                def: ToolDefinition {
                    name: name.to_string(),
                    description: description.to_string(),
                    input_schema,
                    dangerous: true,
                    fatal_on_error: false,
                },
            }
        }
    }

    #[async_trait]
    impl Tool for UnwiredComputerTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
            Err(error::unwired(self.def.name.as_str()))
        }
    }

    /// 13 个工具定义清单（注册序 = 注入 → 感知 → 急停；与
    /// [super::ALL_TOOL_NAMES] 逐一对应，注册数断言测试守护）。
    pub(crate) fn definitions() -> Vec<UnwiredComputerTool> {
        vec![
            // ── 注入 8（全 dangerous=true）──
            UnwiredComputerTool::new(
                "computer_click",
                "鼠标点击（危险操作，需审批）。button=left/right/middle，count=single/double/triple；带 coordinate 先移动再点击；带 modifiers 按住修饰键点击（如 ctrl+click）。",
                json!({
                    "type": "object",
                    "properties": {
                        "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "鼠标按键（缺省 left）" },
                        "count": { "type": "string", "enum": ["single", "double", "triple"], "description": "点击次数语义（缺省 single；双击/三击间隔由后端生成）" },
                        "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "目标坐标 [x,y]（API 空间，缺省 = 当前光标位置）" },
                        "modifiers": { "type": "array", "items": { "type": "string" }, "description": "按住修饰键（ctrl/alt/shift/win）" }
                    },
                    "required": [],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_type",
                "向当前焦点输入文本（危险操作，需审批）。50 字符/块 + 12ms 节流不丢字；中文/emoji 走 Unicode 直送；审批弹窗明文展示 text。",
                json!({
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "待输入文本（非空，≤100000 字符）" }
                    },
                    "required": ["text"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_key",
                "发送组合键（危险操作，需审批）。keys 数组语义（如 [\"ctrl\",\"c\"]），至多一个非修饰键；不做字符串解析。",
                json!({
                    "type": "object",
                    "properties": {
                        "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 16, "description": "组合键数组（归一化键名，如 [\"ctrl\",\"c\"]）" }
                    },
                    "required": ["keys"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_hold_key",
                "按住指定键 duration 秒后松开（危险操作，需审批）。duration 上限 100s。",
                json!({
                    "type": "object",
                    "properties": {
                        "key": { "type": "string", "description": "归一化键名（如 a/enter/f1）" },
                        "duration": { "type": "number", "minimum": 0, "exclusiveMinimum": true, "maximum": 100, "description": "按住时长（秒，0 < d ≤ 100）" }
                    },
                    "required": ["key", "duration"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_move",
                "移动光标到指定坐标（危险操作，需审批）。coordinate 为 API 空间 [x,y]，经缩放校验后注入；等待完成再返回（_sync 语义）。",
                json!({
                    "type": "object",
                    "properties": {
                        "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "目标坐标 [x,y]（API 空间）" }
                    },
                    "required": ["coordinate"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_button",
                "按下/抬起分离原语（危险操作，需审批）。作用于当前光标位置；down=true 按下 / false 抬起；供拖拽/选区/画板场景由模型编排。",
                json!({
                    "type": "object",
                    "properties": {
                        "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "鼠标按键（缺省 left）" },
                        "down": { "type": "boolean", "description": "true = 按下，false = 抬起" }
                    },
                    "required": ["down"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_drag",
                "拖拽（危险操作，需审批）。按下起点 → 分步移动终点 → 抬起；两端点均走缩放校验。",
                json!({
                    "type": "object",
                    "properties": {
                        "start_coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "拖拽起点 [x,y]（API 空间）" },
                        "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "拖拽终点 [x,y]（API 空间）" }
                    },
                    "required": ["start_coordinate", "coordinate"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_scroll",
                "滚动（危险操作，需审批；大 amount 默认拒绝型）。direction=up/down/left/right，amount 非负整数；可先移动再滚动、可带修饰键（如 shift+wheel 横向语义由 OS 决定）。",
                json!({
                    "type": "object",
                    "properties": {
                        "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "滚动方向" },
                        "amount": { "type": "integer", "minimum": 0, "description": "滚动量（非负整数）" },
                        "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "可选，先移动到该坐标再滚动" },
                        "modifiers": { "type": "array", "items": { "type": "string" }, "description": "可选，按住修饰键滚动" }
                    },
                    "required": ["direction", "amount"],
                    "additionalProperties": false
                }),
            ),
            // ── 感知 4（全 dangerous=true，默认审批）──
            UnwiredComputerTool::new(
                "computer_wait",
                "等待并返回（感知类，不注入任何输入）。duration 秒后完成；screenshot=true 时顺带返回截屏。",
                json!({
                    "type": "object",
                    "properties": {
                        "duration": { "type": "number", "minimum": 0, "exclusiveMinimum": true, "maximum": 100, "description": "等待时长（秒，0 < d ≤ 100）" },
                        "screenshot": { "type": "boolean", "description": "可选，等待后返回截屏（缺省 false）" }
                    },
                    "required": ["duration"],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_screenshot",
                "返回缩放后全桌面截屏（感知类，默认审批）。format=png/jpeg，quality 质量档；region 裁剪局部区域（zoom 语义，越界报错）。",
                json!({
                    "type": "object",
                    "properties": {
                        "format": { "type": "string", "enum": ["png", "jpeg"], "description": "图像格式（缺省 png；jpeg 为低质量档）" },
                        "quality": { "type": "integer", "minimum": 1, "maximum": 100, "description": "可选，jpeg 质量档（50-75 有效面）" },
                        "region": { "type": "array", "items": { "type": "integer" }, "minItems": 4, "maxItems": 4, "description": "可选，裁剪区域 [x0,y0,x1,y1]（API 空间，zoom 语义）" }
                    },
                    "required": [],
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_cursor_position",
                "返回当前光标位置（感知类，默认审批；API 空间坐标，经物理→API 换算）。",
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            ),
            UnwiredComputerTool::new(
                "computer_snapshot",
                "返回 UIA 结构化快照（感知类，默认审批）。元素/角色/名称/边界矩形/索引紧凑序列化；密码框文本抑制（<password>）与键名脱敏已内置。",
                json!({
                    "type": "object",
                    "properties": {
                        "max_depth": { "type": "integer", "minimum": 1, "description": "可选，UIA 树深度上限" },
                        "max_elements": { "type": "integer", "minimum": 1, "description": "可选，UIA 树节点数上限" }
                    },
                    "required": [],
                    "additionalProperties": false
                }),
            ),
            // ── 急停 1（dangerous=true）──
            UnwiredComputerTool::new(
                "computer_estop",
                "AI 主动急停（危险操作，需审批）。触发全局急停链：中止在途注入 → 感知源停止 → 会话回 Idle；恢复需用户重新显式开启。",
                json!({
                    "type": "object",
                    "properties": {
                        "reason": { "type": "string", "description": "可选，急停原因（审计记录）" }
                    },
                    "required": [],
                    "additionalProperties": false
                }),
            ),
        ]
    }

    /// 注册全部 13 个 computer_* 工具（幂等：同名已注册跳过，不报冲突；
    /// 06 文档 §3.2 幂等语义对齐浏览器线 17 §1.4）。
    pub(crate) fn register_all(registry: &ToolRegistry) -> Result<(), ToolError> {
        for tool in definitions() {
            if !registry.has(tool.name()) {
                registry.register_runtime(std::sync::Arc::new(tool))?;
            }
        }
        Ok(())
    }
}

use agent_tools::definition::ToolError;
use agent_tools::registry::ToolRegistry;
use conex_computer::activation::ActivationGate;
use conex_computer::security::{ApprovalGate, EmergencyStop, SessionEnablement};
use session::ComputerOps;
use std::sync::Arc;

/// 工具注册清单常量数组（13 个；注册序 = 注入 8 → 感知 4 → 急停 1）。
///
/// 与 [tools::definitions] 逐一对应——注册数断言测试（`registration_enabled_mounts_all_13_tools`）
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
    // 急停 1
    "computer_estop",
];

/// 电脑操作工具注册配置（引擎侧会话装配时注入，06 文档 §3.1）。
///
/// - `enablement`：会话级显式开启判据（[SessionEnablement::tool_mount_allowed]）。
///   **挂载判据：未开启（或未注入）→ 本函数零注册返回 Ok**——`computer_*`
///   工具不存在，模型侧 tool schema 亦不含（04 §4.1 第 3 点；安全默认）；
/// - `session`：会话注入面（[ComputerOps] trait；测试 mock 替身 / 引擎
///   RealComputerSession），实施轮接线；
/// - `activation`：会话互斥守卫（[ActivationGate]，S3；工具执行前检查
///   `current().is_desktop()`，非桌面态返回 `tool.session.exclusive`，
///   检查点在审批之前），实施轮接线；
/// - `approval`：全动作审批门（[ApprovalGate]，04 §4.2 逐次审批语义），
///   实施轮接线；
/// - `stop`：三级急停旗（[EmergencyStop]，04 §4.3；执行前自查 + 在途批次
///   自查），实施轮接线。
#[derive(Clone, Default)]
pub struct ComputerToolsConfig {
    /// 会话注入面（缺省 None = 不注入；工具执行返回 not_ready 语义，接线在实施轮）
    pub session: Option<Arc<dyn ComputerOps>>,
    /// 会话级显式开启判据（缺省 None = 视为未开启，零注册安全默认）
    pub enablement: Option<Arc<SessionEnablement>>,
    /// 会话互斥守卫（S3；实施轮接线）
    pub activation: Option<Arc<ActivationGate>>,
    /// 全动作审批门（04 §4.2；实施轮接线）
    pub approval: Option<Arc<ApprovalGate>>,
    /// 三级急停旗（04 §4.3；实施轮接线）
    pub stop: Option<Arc<EmergencyStop>>,
}

/// 注册全部 13 个 computer_* 工具（后置注册函数，**不进入** agent-tools 的
/// `register_builtin_tools`）。
///
/// ## 挂载判据（04 §4.1 第 3 点）
/// `config.enablement.tool_mount_allowed()` 为真才注册；未开启 / 未注入 →
/// **零注册返回 Ok**（未开启时工具不存在，模型侧 tool schema 亦不含；安全默认，
/// 注册数断言测试守护）。运行期禁用（挂起/急停回 Idle）由工具执行守卫链
/// `tool.computer.not_enabled` 兜底（06 文档 §4.2，实施轮接线）。
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
    tools::register_all(registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::context::create_mock_tool_context;
    use conex_computer::security::EnableSource;
    use serde_json::json;

    /// 开启态配置：用户显式开启（04 §4.1：开启仅能由用户显式操作触发）
    fn enabled_config() -> ComputerToolsConfig {
        let enablement = Arc::new(SessionEnablement::new());
        enablement.enable(EnableSource::User).expect("用户开启应成功");
        ComputerToolsConfig {
            enablement: Some(enablement),
            ..Default::default()
        }
    }

    /// 注册辅助：按配置注册并返回注册表
    fn registry_with(config: ComputerToolsConfig) -> ToolRegistry {
        let mut registry = ToolRegistry::new();
        register_computer_tools(&mut registry, config).expect("注册应成功");
        registry
    }

    /// 注册数精确断言 + 名称清单一致（06 文档 §7 验收项 1：开启态挂载全部 13 个）。
    #[test]
    fn registration_enabled_mounts_all_13_tools() {
        let registry = registry_with(enabled_config());
        assert_eq!(registry.len(), 13, "工具族应恰好注册 13 个");
        let mut names: Vec<String> = registry
            .list()
            .iter()
            .map(|t| t.name().to_string())
            .collect();
        names.sort();
        let mut expected: Vec<String> = ALL_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
        expected.sort();
        assert_eq!(names, expected, "注册清单必须与 ALL_TOOL_NAMES 逐项一致");
    }

    /// 安全默认：未注入开启判据 → 零注册（模型侧 tool schema 不含）。
    #[test]
    fn registration_default_config_mounts_zero() {
        let registry = registry_with(ComputerToolsConfig::default());
        assert_eq!(registry.len(), 0, "未开启/未注入必须零注册（安全默认）");
    }

    /// 挂载判据：显式未开启（新会话默认关闭态）→ 零注册。
    #[test]
    fn registration_disabled_enablement_mounts_zero() {
        let enablement = Arc::new(SessionEnablement::new());
        assert!(!enablement.tool_mount_allowed(), "新会话默认关闭");
        let registry = registry_with(ComputerToolsConfig {
            enablement: Some(enablement),
            ..Default::default()
        });
        assert_eq!(registry.len(), 0, "未开启必须零注册（04 §4.1 第 3 点）");
    }

    /// 重复注册幂等跳过（06 文档 §3.2）：第二次注册不报冲突、注册数不变。
    #[test]
    fn registration_twice_is_idempotent() {
        let mut registry = registry_with(enabled_config());
        register_computer_tools(&mut registry, enabled_config()).expect("重复注册应幂等跳过");
        assert_eq!(registry.len(), 13);
    }

    /// 全工具 dangerous=true（04 §4.2 全动作审批：17 动作全 dangerous；工具面 13 个全量）。
    #[test]
    fn all_tools_dangerous_true() {
        let registry = registry_with(enabled_config());
        for name in ALL_TOOL_NAMES {
            let tool = registry.get(name).expect("工具应注册");
            assert!(
                tool.definition().dangerous,
                "{name} 必须标记 dangerous=true"
            );
        }
    }

    /// 名称唯一性 + 全部工具名以 computer_ 前缀开头（命名空间隔离纪律，18 §2.1）。
    #[test]
    fn all_names_unique_and_computer_prefixed() {
        let registry = registry_with(enabled_config());
        let names: Vec<String> = registry
            .list()
            .iter()
            .map(|t| t.name().to_string())
            .collect();
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "名称必须唯一");
        for name in &names {
            assert!(name.starts_with("computer_"), "命名空间隔离：{name}");
        }
    }

    /// 未接线错误契约（骨架验收）：13 个工具执行统一返回 `tool.computer.unwired`。
    #[tokio::test]
    async fn unwired_error_contract_all_tools() {
        let registry = registry_with(enabled_config());
        let ctx = create_mock_tool_context();
        for name in ALL_TOOL_NAMES {
            let tool = registry.get(name).expect("工具应注册");
            let err = tool
                .execute(&ctx, json!({}))
                .await
                .expect_err("骨架工具应返回未接线错误");
            assert_eq!(
                err.code(),
                codes::TOOL_COMPUTER_UNWIRED,
                "{name} 应返回 tool.computer.unwired"
            );
        }
    }

    /// 命名空间共存（18 §2.1 / 06 文档 §3.4）：computer_* 与 browser_* 同注册表
    /// 无键冲突、模型同时可见（24 + 13 = 37）。
    #[test]
    fn coexists_with_browser_tools_in_same_registry() {
        let mut registry = ToolRegistry::new();
        conex_browser_tools::register_browser_tools(
            &mut registry,
            conex_browser_tools::BrowserToolsConfig::default(),
        )
        .expect("浏览器工具注册成功");
        register_computer_tools(&mut registry, enabled_config()).expect("电脑操作工具注册成功");
        assert_eq!(registry.len(), 37, "两族共存（24 browser + 13 computer）");
        let defs = registry.list_definitions();
        assert!(
            defs.iter().any(|d| d.name == "browser_navigate"),
            "browser_* 工具可见"
        );
        assert!(
            defs.iter().any(|d| d.name == "computer_click"),
            "computer_* 工具可见"
        );
        assert!(
            defs.iter().all(|d| d.name.starts_with("browser_") || d.name.starts_with("computer_")),
            "两族名称无歧义"
        );
    }
}
