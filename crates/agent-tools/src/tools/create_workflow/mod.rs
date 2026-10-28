//! create_workflow 工具与 WorkflowCreationChannel 契约（维度五：定时任务编排助手）
//!
//! 定位（docs/prompt-injection-pipeline/00-总方案-统一提示词与上下文注入通道架构规划.md
//! §二 维度五 / §六 现实基线注记 3；detailed-plans/05-定时任务编排助手落地实践详案.md
//! §2.4 双模落盘 · 路径 A）：
//! - AI 侧经 create_workflow 工具向引擎注册定时任务（Grill-Me 四要素对齐后
//!   自动调用），引擎复用既有 `create-workflow` IPC 命令的校验 / parse_cron /
//!   注册逻辑落盘（工作区路径、时区偏移语义等全部同源，禁止平行实现第二套
//!   注册链路——接线注记见 05 详案 §2.4）；
//! - 本模块只定义**契约与工具本体**：agent-tools 是叶子 crate，不依赖引擎
//!   （对齐 set_timer.rs TimerChannel 先例）；引擎侧实现
//!   [WorkflowCreationChannel]（Tauri `workflow_ipc.rs` 后端适配）后经
//!   BuiltinToolConfig 注入，通道未接线时工具返回 common.unsupported
//!   结构化错误；
//! - 入参形状对齐 05 详案 §2.4 `CreateWorkflowInput` 冻结契约
//!   （schedule_type 四态：manual | daily | intervalMinutes | cron，其余字段
//!   为各态的补充载荷；enabled 缺省 true）。

use conex_types::error::codes;
// 子模块（binding.rs / tool.rs）沿用原文件的 `super::<helper>` 调用路径：
// 原文件位于 tools/ 下，拆为目录后 `super` 指向本模块，故在此引入 tools 层共享入参解析 helper。
use super::{optional_bool, optional_string, optional_u64, require_string};

mod binding;
mod input;
mod tool;

pub use input::{
    CreateWorkflowArgs, WorkflowCreateInput, WorkflowCreateOutput, WorkflowCreationChannel,
};
pub(crate) use tool::CreateWorkflowTool;

// ── 调度类型字面量（05 详案 §2.4 / 前端 WorkflowScheduleWire 同源）────────

/// 手动触发（仅手动执行，不自动调度）
pub const SCHEDULE_TYPE_MANUAL: &str = "manual";
/// 每日固定时刻（HH:mm，本机时区语义由引擎 parse_cron 固定偏移承载）
pub const SCHEDULE_TYPE_DAILY: &str = "daily";
/// 间隔分钟轮询（1–10080 分钟）
pub const SCHEDULE_TYPE_INTERVAL_MINUTES: &str = "intervalMinutes";
/// 5 字段标准 cron 表达式
pub const SCHEDULE_TYPE_CRON: &str = "cron";

/// 执行会话模式：绑定当前会话（在当前对话内自动定时执行）
pub const EXECUTION_MODE_CURRENT_SESSION: &str = "current_session";
/// 目标模式简写：绑定当前会话（对齐阶段三方案 target_mode 契约）
pub const EXECUTION_MODE_CURRENT: &str = "current";
/// 执行会话模式：独立后台会话（在后台独立新建会话执行）
pub const EXECUTION_MODE_ISOLATED: &str = "isolated";
/// 单轨定时任务索引键（与阶段一、阶段四收敛后的单轨索引键严格同源，废除旧 `sched_ids`）
pub const SESSION_META_INDEX_KEY: &str = "sched_index";

// ── 工作流创建通道契约（引擎侧接线面）──────────────────────────────

/// 定时任务创建错误（结构化，映射为 ToolError 出站；对齐 TimerError 风格
/// set_timer.rs:49-97）
///
/// 语义校验（名称/提示词非空、cron 合法性、每日时刻、间隔范围）**全部
/// 收敛在引擎侧** `create-workflow` 既有校验链（05 详案 §2.4 接线注记）——
/// 本枚举只承载结构化错误外壳，detail 为引擎侧校验文案，不在 agent-tools
/// 内做第二套语义校验。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowCreateError {
    /// 入参语义校验失败（名称空 / cron 非法 / 时刻非法 / 间隔越界；
    /// 附引擎侧既有校验的真实中文文案）
    InvalidInput(String),
    /// 通道未接线（对齐 common.unsupported 语义）
    Unsupported,
}

impl WorkflowCreateError {
    /// 错误码
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => codes::TOOL_INVALID_INPUT,
            Self::Unsupported => codes::COMMON_UNSUPPORTED,
        }
    }

    /// 错误文案
    pub fn message(&self) -> String {
        match self {
            Self::InvalidInput(detail) => format!("创建定时任务失败：{detail}"),
            Self::Unsupported => "create_workflow 通道未接线（引擎集成后可用）".to_string(),
        }
    }
}

#[cfg(test)]
mod tests;
